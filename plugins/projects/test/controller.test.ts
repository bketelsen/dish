/**
 * The Projects page's controller, driven through a fake remote: what it loads, how it tracks a form and checks it, what a
 * save, a removal and a retry do with each answer the registry can give, what a live event does to a page that is clean or
 * has an unsaved edit, and when it polls for onboarding. The controller has no React in it, so this runs under
 * `node --test`; the JSX around it is checked in a browser.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { CHECK_DELAY, NEW_FIELDS, POLL_INTERVAL, createProjects, sameFields } from '../src/client/controller.ts'
import type { PageState, ProjectsController } from '../src/client/controller.ts'
import type { ConfigCalls, ConfigEvent, ProjectsApi } from '../src/client/remote.ts'
import type { CheckResult, CommitInfo, ErrorCode, Fields, Outcome, ProjectInfo, ProjectState, ProjectsResult } from '../src/protocol.ts'

// --- fakes ---------------------------------------------------------------------------------------

const ok = <T>(value: T): RemoteResult<Outcome<T>> => ({ ok: true, value: { ok: true, value } })
const refused = (code: ErrorCode, message: string): RemoteResult<Outcome<never>> => ({ ok: true, value: { ok: false, code, message } })
const carrierDown = (): RemoteResult<never> => ({ ok: false, error: { message: 'gateway offline' } }) as unknown as RemoteResult<never>

/** The id of the n-th commit of the fake store: 40 characters, and the first seven tell it from the others. */
const id = (n: number): string => `c${n}`.padEnd(40, 'e')
const number = (commit: string): number => Number(/^c(\d+)/.exec(commit)![1])

interface Gate { release: () => void, opened: Promise<void> }

function gate(): Gate {
  let release!: () => void
  const opened = new Promise<void>((resolve) => { release = resolve })
  return { release, opened }
}

/** A project's settings, with what the registry needs filled in. */
function fields(overrides: Partial<Fields> = {}): Fields {
  return { family: 'acme', role: 'the widget', gate: 'pnpm test', gateTimeout: '10m', setup: '', setupTimeout: '', gateEnv: {}, ...overrides }
}

const GRAMMAR = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/
const FAMILY = /^[a-z0-9][a-z0-9-]{0,63}$/

/**
 * A registry that behaves as the real one does where the page cares: a list read at the head, a write whose `base` is older
 * than the file's last change is a `CONFLICT` (the file, not the project: a change to another project conflicts too), adding
 * a name that is there or editing one that isn't is `INVALID`, writing what is there is `null`, and `retry` is refused for a
 * project that is being onboarded. Seeded: `acme/gadget` (failed) and `acme/widget` (ready). A family that isn't a lowercase
 * name, and a gate with `BAD` in it, fail `check`.
 */
class FakeProjects {
  head = 0
  /** The commit that last changed `projects.yaml`. */
  fileChangedAt = 0
  up = true
  entries = new Map<string, Fields>()
  states = new Map<string, ProjectState>()
  proposals = 0
  problem: string | null = null
  calls: string[] = []
  /** What `check` was asked, in order. */
  checked: Array<{ name: string, fields: Fields, adding: boolean }> = []
  /** What `save` was given, in order. */
  saved: Array<{ name: string, fields: Fields, base: string, note: string, adding: boolean }> = []
  removed: Array<{ name: string, base: string, note: string }> = []
  gates = new Map<string, Gate>()
  projectsDown = false
  checkDown = false
  saveDown = false

  constructor() {
    this.entries.set('acme/gadget', fields({ role: 'the gadget' }))
    this.entries.set('acme/widget', fields())
    this.states.set('acme/gadget', 'failed')
    this.states.set('acme/widget', 'ready')
  }

  /** Somebody else changes `projects.yaml`: the head moves, and so does what a reader sees. */
  external(change: (entries: Map<string, Fields>) => void): string {
    this.head++
    this.fileChangedAt = this.head
    change(this.entries)
    return id(this.head)
  }

  /** Hold the call that reaches `key` until its gate opens. A gate holds one call: the next to reach the key goes straight through. */
  private async wait(key: string): Promise<void> {
    const held = this.gates.get(key)
    if (held === undefined) return
    this.gates.delete(key)
    await held.opened
  }

  private commitInfo(name: string, note: string): CommitInfo {
    return { id: id(this.head), time: 1_000, author: { kind: 'user' }, message: 'msg', ...(note === '' ? {} : { note }), paths: ['projects.yaml'] }
  }

  private info(name: string): ProjectInfo {
    const state = this.states.get(name) ?? 'pending'
    return {
      name,
      fields: structuredClone(this.entries.get(name)!),
      status: { state, message: state === 'failed' ? 'clone failed' : null, at: 1_000, setupSkipped: null },
      clone: state === 'ready' ? `/work/${name}` : null,
      workspace: state === 'ready' ? name : null,
      lastFetch: null,
    }
  }

  private problemOf(name: string, entry: Fields, adding: boolean): string | null {
    if (!GRAMMAR.test(name)) return `projects.yaml: ${JSON.stringify(name)} isn't owner/repo`
    const spelled = [...this.entries.keys()].find(key => key.toLowerCase() === name.toLowerCase())
    if (adding && spelled !== undefined) return `projects.yaml: ${name} is already in projects.yaml`
    if (!adding && spelled !== name) return `projects.yaml: ${name} isn't in projects.yaml`
    for (const key of ['family', 'role', 'gate', 'gateTimeout'] as const) {
      if (entry[key].trim() === '') return `projects.yaml: ${name}: ${key} is blank`
    }
    if (!FAMILY.test(entry.family.trim())) {
      return `projects.yaml: ${name}: family must be a lowercase name: letters, digits and hyphens, starting with a letter or digit, at most 64 characters`
    }
    if (entry.gate.includes('BAD')) return `projects.yaml: ${name}: gate is BAD`
    return null
  }

  readonly api: ProjectsApi = {
    projects: async () => {
      this.calls.push('projects')
      // The answer is what the registry says when the call is made, not when the gate lets it through.
      let answer: RemoteResult<Outcome<ProjectsResult>>
      if (this.projectsDown) {
        answer = carrierDown()
      } else if (!this.up) {
        answer = ok<ProjectsResult>({ commit: '', projects: [], problem: null, pendingProposals: 0 })
      } else {
        const names = [...this.entries.keys()].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
        answer = ok<ProjectsResult>({
          commit: id(this.head),
          projects: this.problem === null ? names.map(name => this.info(name)) : [],
          problem: this.problem,
          pendingProposals: this.proposals,
        })
      }
      await this.wait('projects')
      return answer
    },
    check: async (name, entry, adding) => {
      this.calls.push(`check ${name}`)
      this.checked.push({ name, fields: structuredClone(entry), adding })
      // The answer is what the registry says when the call is made, not when the gate lets it through.
      const answer: CheckResult = { problem: this.problemOf(name, entry, adding) }
      await this.wait('check')
      if (this.checkDown) return carrierDown()
      return ok(answer)
    },
    save: async (name, entry, base, note, adding) => {
      this.calls.push(`save ${name} ${base === '' ? '-' : base.slice(0, 7)} ${adding ? 'add' : 'edit'}`)
      this.saved.push({ name, fields: structuredClone(entry), base, note, adding })
      await this.wait('save')
      if (this.saveDown) return carrierDown()
      if (!this.up) return refused('UNAVAILABLE', 'the config store isn\'t running, so projects can\'t be changed')
      const problem = this.problemOf(name, entry, adding)
      if (base !== '' && this.fileChangedAt > number(base)) return refused('CONFLICT', `projects.yaml changed since ${base.slice(0, 7)}`)
      if (problem !== null) return refused('INVALID', problem)
      if (!adding && sameFields(this.entries.get(name)!, entry)) return ok(null)
      this.head++
      this.fileChangedAt = this.head
      this.entries.set(name, structuredClone(entry))
      if (adding) this.states.set(name, 'pending')
      const answer = ok(this.commitInfo(name, note))
      await this.wait('save answer')
      return answer
    },
    removeProject: async (name, base, note) => {
      this.calls.push(`remove ${name} ${base === '' ? '-' : base.slice(0, 7)}`)
      this.removed.push({ name, base, note })
      await this.wait('remove')
      if (!this.up) return refused('UNAVAILABLE', 'the config store isn\'t running, so projects can\'t be changed')
      if (base !== '' && this.fileChangedAt > number(base)) return refused('CONFLICT', `projects.yaml changed since ${base.slice(0, 7)}`)
      if (!this.entries.has(name)) return refused('NOT_FOUND', `there is no project ${JSON.stringify(name)} in projects.yaml`)
      this.head++
      this.fileChangedAt = this.head
      this.entries.delete(name)
      this.states.delete(name)
      return ok(this.commitInfo(name, note === '' ? `Removed ${name}; its clone and workspace stay` : note))
    },
    retry: async (name) => {
      this.calls.push(`retry ${name}`)
      await this.wait('retry')
      if (!this.entries.has(name)) return refused('INVALID', `no project ${name} in projects.yaml`)
      const state = this.states.get(name)
      if (state === 'pending') return refused('INVALID', `${name} is queued for onboarding already`)
      if (state === 'cloning' || state === 'setup') return refused('INVALID', `${name} is being onboarded`)
      this.states.set(name, 'pending')
      return ok(null)
    },
  }
}

/** Dish-config's remote, as far as this page goes: that it is there. */
const CONFIG: ConfigCalls = {
  history: async () => carrierDown(),
  commit: async () => carrierDown(),
  revert: async () => carrierDown(),
}

/** A timer the test turns by hand: nothing fires until `fire`. */
class FakeTimer {
  next = 1
  pending = new Map<number, { callback: () => void, ms: number }>()
  /** The delay of every timer ever set. */
  delays: number[] = []

  readonly api = {
    setTimeout: (callback: () => void, ms: number): number => {
      const handle = this.next++
      this.pending.set(handle, { callback, ms })
      this.delays.push(ms)
      return handle
    },
    clearTimeout: (handle: unknown): void => { this.pending.delete(handle as number) },
  }

  /** How many timers wait, of the delay `ms` when it is given. */
  armed(ms?: number): number {
    return [...this.pending.values()].filter(timer => ms === undefined || timer.ms === ms).length
  }

  /** Let the timers set so far go off: those of the delay `ms`, or all. */
  fire(ms?: number): void {
    const due = [...this.pending.entries()].filter(([, timer]) => ms === undefined || timer.ms === ms)
    for (const [handle] of due) this.pending.delete(handle)
    for (const [, timer] of due) timer.callback()
  }
}

interface Setup {
  fake: FakeProjects
  timer: FakeTimer
  page: ProjectsController
  state: () => PageState
}

function setup(): Setup {
  const fake = new FakeProjects()
  const timer = new FakeTimer()
  const page = createProjects(fake.api, { timer: timer.api })
  return { fake, timer, page, state: () => page.getState() }
}

/** Wait until `check` holds: the fakes answer on later ticks, and a test needs to act once a call has reached them. */
async function until(what: string, check: () => boolean): Promise<void> {
  for (let tries = 0; !check(); tries++) {
    if (tries > 2_000) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 1))
  }
}

/** An opened page, with the first project (`acme/gadget`) selected. */
async function opened(): Promise<Setup> {
  const made = setup()
  await made.page.face.open()
  return made
}

/** Let the debounce go off and the check it starts come back. */
async function checked(made: Pick<Setup, 'timer' | 'state'>): Promise<void> {
  made.timer.fire(CHECK_DELAY)
  await until('the check', () => made.state().form?.checking === false)
}

/** Fill a new project's form with a valid name and settings, and let it be checked. */
async function fillAdd(made: Setup, name = 'acme/new'): Promise<void> {
  const { face } = made.page
  face.editField('name', name)
  face.editField('family', 'acme')
  face.editField('role', 'something new')
  face.editField('gate', 'pnpm test')
  await checked(made)
}

const names = (state: PageState): string[] => state.projects.map(project => project.name)
const count = (calls: string[], prefix: string): number => calls.filter(call => call.startsWith(prefix)).length
const changed = (paths: string[], commit = 1): ConfigEvent => ({ kind: 'changed', commit: id(commit), paths })

// --- loading ---------------------------------------------------------------------------------------

test('open loads the list and selects the first project', async () => {
  const { fake, state } = await opened()
  assert.deepEqual(names(state()), ['acme/gadget', 'acme/widget'])
  assert.equal(state().commit, id(0))
  assert.equal(state().listLoaded, true)
  assert.equal(state().listError, undefined)
  assert.equal(state().selected, 'acme/gadget')
  assert.equal(state().problem, null)
  assert.equal(state().pendingProposals, 0)
  assert.equal(state().readOnly, false)
  assert.equal(state().form, null)
  assert.equal(state().confirm, null)
  assert.equal(state().conflict, undefined)
  assert.equal(state().busy, undefined)
  assert.equal(state().stream, 'off', 'without dish-config there is nothing live')
  assert.deepEqual(fake.calls, ['projects'])
})

test('open again reads the list again and keeps the selection', async () => {
  const { fake, page, state } = await opened()
  page.face.select('acme/widget')
  await page.face.open()
  assert.equal(state().selected, 'acme/widget')
  assert.equal(count(fake.calls, 'projects'), 2)
})

test('the list says when the registry does not parse, and how many proposals wait', async () => {
  const made = setup()
  made.fake.problem = 'projects.yaml: line 3 is not valid'
  made.fake.proposals = 2
  await made.page.face.open()
  assert.equal(made.state().problem, 'projects.yaml: line 3 is not valid')
  assert.deepEqual(made.state().projects, [])
  assert.equal(made.state().pendingProposals, 2)
  assert.equal(made.state().selected, undefined)
})

test('without a store the page is read-only, and a new project is refused with the reason', async () => {
  const made = setup()
  made.fake.up = false
  await made.page.face.open()
  assert.equal(made.state().commit, '')
  assert.equal(made.state().readOnly, true)
  await made.page.face.startAdd()
  assert.equal(made.state().form, null)
  assert.match(made.state().notice?.text ?? '', /config store isn't running/)
  assert.equal(made.state().notice?.tone, 'error')
})

test('a list the carrier failed is an error, not an empty page, and reload tries again', async () => {
  const { fake, page, state } = setup()
  fake.projectsDown = true
  await page.face.open()
  assert.equal(state().listLoaded, true)
  assert.equal(state().listError?.text, 'Something went wrong talking to dish-projects')
  assert.equal(state().listError?.detail, 'gateway offline')
  fake.projectsDown = false
  await page.face.reload()
  assert.equal(state().listError, undefined)
  assert.deepEqual(names(state()), ['acme/gadget', 'acme/widget'])
})

test('select moves the selection, and ignores a name the list does not have', async () => {
  const { page, state } = await opened()
  page.face.select('acme/widget')
  assert.equal(state().selected, 'acme/widget')
  page.face.select('acme/missing')
  assert.equal(state().selected, 'acme/widget')
})

// --- adding ----------------------------------------------------------------------------------------

test('a new project\'s form starts with the defaults and is checked at once', async () => {
  const { fake, page, state, timer } = await opened()
  await page.face.startAdd()
  const form = state().form!
  assert.equal(form.mode, 'add')
  assert.equal(form.name, '')
  assert.deepEqual(form.fields, NEW_FIELDS)
  assert.deepEqual(form.env, [])
  assert.equal(form.dirty, false)
  assert.equal(form.base, id(0))
  assert.equal(form.saved, null)
  assert.equal(form.checking, false)
  assert.match(form.problem ?? '', /isn't owner\/repo/)
  assert.equal(fake.checked.length, 1)
  assert.deepEqual(fake.checked[0], { name: '', fields: NEW_FIELDS, adding: true })
  assert.equal(timer.armed(), 0, 'the first check does not wait for the pause')
})

test('typing is checked once the person pauses: the check waits for the last edit', async () => {
  const { fake, page, state, timer } = await opened()
  await page.face.startAdd()
  const before = fake.checked.length
  page.face.editField('name', 'acme/new')
  page.face.editField('family', 'acme')
  page.face.editField('role', 'something')
  assert.equal(state().form?.checking, true, 'a check is due')
  assert.equal(state().form?.dirty, true)
  assert.deepEqual(timer.delays.slice(-3), [CHECK_DELAY, CHECK_DELAY, CHECK_DELAY])
  assert.equal(timer.armed(CHECK_DELAY), 1, 'each edit moves the one pause')
  assert.equal(fake.checked.length, before)
  await checked({ timer, state })
  assert.equal(fake.checked.length, before + 1)
  assert.deepEqual(fake.checked.at(-1)?.name, 'acme/new')
  assert.equal(fake.checked.at(-1)?.fields.role, 'something')
  assert.match(state().form?.problem ?? '', /gate is blank/)
})

test('an answer for a form that has been edited since is dropped', async () => {
  const { fake, page, state, timer } = await opened()
  await page.face.startAdd()
  const opening = state().form?.problem
  assert.ok(opening)
  const slow = gate()
  fake.gates.set('check', slow)
  page.face.editField('name', 'acme/new')
  timer.fire(CHECK_DELAY)
  await until('the slow check', () => fake.checked.length === 2)
  // Typed while the check is out: its answer (family is blank) is about a form that is gone.
  page.face.editField('family', 'acme')
  page.face.editField('role', 'something')
  page.face.editField('gate', 'pnpm test')
  slow.release()
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(state().form?.problem, opening, 'the late answer was not taken')
  assert.equal(state().form?.checking, true)
  await checked({ timer, state })
  assert.equal(state().form?.problem, null)
  assert.equal(fake.checked.length, 3)
})

test('save is refused here, with no call, while the form has a problem', async () => {
  const { fake, page, state } = await opened()
  await page.face.startAdd()
  page.face.editField('name', 'acme/new')
  await page.face.save()
  assert.equal(count(fake.calls, 'save'), 0)
  assert.equal(state().notice?.tone, 'error')
  assert.match(state().notice?.text ?? '', /^Can't save: .*family is blank/)
  assert.equal(state().busy, undefined)
  assert.notEqual(state().form, null)
})

test('a family that isn\'t a lowercase name stops a save here, with the registry\'s words', async () => {
  const made = await opened()
  const { fake, page, state } = made
  await page.face.startAdd()
  await fillAdd(made)
  page.face.editField('family', 'Frostyard')
  await checked(made)
  await page.face.save()
  assert.equal(count(fake.calls, 'save'), 0)
  assert.equal(state().notice?.tone, 'error')
  assert.match(state().notice?.text ?? '', /^Can't save: .*family must be a lowercase name/)
  assert.notEqual(state().form, null)
})

test('a valid new project is saved as the registry will have it, and the form closes on it', async () => {
  const made = await opened()
  const { fake, page, state } = made
  await page.face.startAdd()
  await fillAdd(made)
  page.face.setNote('adds the new one')
  assert.equal(state().form?.problem, null)
  await page.face.save()
  assert.deepEqual(fake.saved, [{
    name: 'acme/new',
    fields: fields({ role: 'something new' }),
    base: id(0),
    note: 'adds the new one',
    adding: true,
  }])
  assert.equal(state().form, null)
  assert.equal(state().selected, 'acme/new')
  assert.equal(state().busy, undefined)
  assert.equal(state().notice?.tone, 'success')
  assert.equal(state().notice?.text, `Added acme/new as ${id(1).slice(0, 7)}`)
  assert.deepEqual(names(state()), ['acme/gadget', 'acme/new', 'acme/widget'], 'the list was read again')
  assert.equal(state().commit, id(1))
  assert.equal(state().projects.find(project => project.name === 'acme/new')?.status.state, 'pending')
})

test('the name is trimmed in what is checked and saved', async () => {
  const made = await opened()
  await made.page.face.startAdd()
  await fillAdd(made, '  acme/new  ')
  assert.equal(made.fake.checked.at(-1)?.name, 'acme/new')
  assert.equal(made.state().form?.problem, null)
  assert.equal(made.state().form?.name, '  acme/new  ', 'what the person typed stays in the field')
  await made.page.face.save()
  assert.equal(made.fake.saved[0]?.name, 'acme/new')
})

test('a save straight after typing waits for the check that is due, and is refused by it', async () => {
  const { fake, page, state } = await opened()
  await page.face.startAdd()
  const checks = fake.checked.length
  page.face.editField('name', 'acme/new')
  page.face.editField('family', 'acme')
  page.face.editField('role', 'something')
  page.face.editField('gate', 'BAD gate')
  await page.face.save()
  assert.equal(fake.checked.length, checks + 1, 'the pause did not have to run out')
  assert.equal(count(fake.calls, 'save'), 0)
  assert.match(state().notice?.text ?? '', /^Can't save: .*gate is BAD/)
})

test('a check the carrier failed says so, and does not stop a save: the registry has the last word', async () => {
  const made = await opened()
  const { fake, page, state } = made
  await page.face.startAdd()
  fake.checkDown = true
  await fillAdd(made)
  assert.equal(state().form?.problem, null)
  assert.equal(state().form?.checkError?.text, 'Something went wrong talking to dish-projects')
  await page.face.save()
  assert.equal(count(fake.calls, 'save'), 1)
  assert.equal(state().form, null)
})

test('a save the registry refused keeps the form and says why', async () => {
  const made = await opened()
  const { fake, page, state } = made
  await page.face.startAdd()
  await fillAdd(made, 'acme/new')
  // The registry changed its mind after the check: a name that was free is taken now, without a commit the page saw.
  fake.entries.set('acme/new', fields())
  await page.face.save()
  assert.equal(state().notice?.tone, 'error')
  assert.match(state().notice?.text ?? '', /^Can't save: projects\.yaml: acme\/new is already in projects\.yaml/)
  assert.notEqual(state().form, null)
  assert.equal(state().busy, undefined)
})

test('a save the carrier failed keeps the form and says so', async () => {
  const made = await opened()
  await made.page.face.startAdd()
  await fillAdd(made)
  made.fake.saveDown = true
  await made.page.face.save()
  assert.equal(made.state().notice?.text, 'Something went wrong talking to dish-projects')
  assert.equal(made.state().notice?.detail, 'gateway offline')
  assert.notEqual(made.state().form, null)
  assert.equal(made.state().busy, undefined)
})

test('a second save while one is out does nothing, and the form can\'t be changed until it ends', async () => {
  const made = await opened()
  const { fake, page, state } = made
  await page.face.startAdd()
  await fillAdd(made)
  const slow = gate()
  fake.gates.set('save', slow)
  const first = page.face.save()
  await until('the save to be out', () => fake.saved.length === 1)
  assert.equal(state().busy, 'save')
  await page.face.save()
  page.face.editField('role', 'typed during the save')
  page.face.cancel()
  assert.equal(fake.saved.length, 1)
  assert.equal(state().form?.fields.role, 'something new', 'an edit during a save is not taken')
  assert.notEqual(state().form, null, 'cancel does not drop a form that is being saved')
  slow.release()
  await first
  assert.equal(state().form, null)
})

// --- editing ---------------------------------------------------------------------------------------

test('edit opens the form on the stored settings, clean, and tracks whether it differs from them', async () => {
  const { fake, page, state } = await opened()
  await page.face.startEdit('acme/widget')
  const form = state().form!
  assert.equal(form.mode, 'edit')
  assert.equal(form.name, 'acme/widget')
  assert.deepEqual(form.fields, fields())
  assert.deepEqual(form.saved, fields())
  assert.equal(form.base, id(0))
  assert.equal(form.dirty, false)
  assert.equal(form.problem, null)
  assert.equal(state().selected, 'acme/widget')
  assert.equal(fake.checked.at(-1)?.adding, false)

  page.face.editField('role', 'changed')
  assert.equal(state().form?.dirty, true)
  page.face.editField('role', fields().role)
  assert.equal(state().form?.dirty, false, 'edited back to what is stored')
  page.face.editField('name', 'acme/other')
  assert.equal(state().form?.name, 'acme/widget', 'the name is fixed when editing')
})

test('an edit is saved against the commit the form was opened on, as an edit', async () => {
  const made = await opened()
  const { fake, page, state } = made
  await page.face.startEdit('acme/widget')
  page.face.editField('gate', 'pnpm test && pnpm lint')
  page.face.editField('setup', 'pnpm install')
  page.face.editField('setupTimeout', '20m')
  await checked(made)
  await page.face.save()
  assert.deepEqual(fake.saved, [{
    name: 'acme/widget',
    fields: fields({ gate: 'pnpm test && pnpm lint', setup: 'pnpm install', setupTimeout: '20m' }),
    base: id(0),
    note: '',
    adding: false,
  }])
  assert.equal(state().notice?.text, `Saved acme/widget as ${id(1).slice(0, 7)}`)
  assert.equal(state().form, null)
  assert.equal(state().selected, 'acme/widget')
  assert.equal(state().projects.find(project => project.name === 'acme/widget')?.fields.setup, 'pnpm install')
})

test('a setup of several lines is kept as it is: through an edit of another field, and through an edit of the setup itself', async () => {
  const made = await opened()
  const { fake, page, state } = made
  const setup = 'pnpm install\npnpm build\n'
  fake.entries.set('acme/widget', fields({ setup }))
  await page.onStatus()
  await page.face.startEdit('acme/widget')
  assert.equal(state().form?.fields.setup, setup)
  assert.equal(state().form?.dirty, false)
  // Another field: the setup is not touched, and the form is dirty for that field only.
  page.face.editField('role', 'the widget, edited')
  assert.equal(state().form?.fields.setup, setup)
  await checked(made)
  await page.face.save()
  assert.equal(fake.saved.at(-1)?.fields.setup, setup, 'the newlines are saved')
  // The setup itself: what is typed, newlines included, is what is saved.
  await page.face.startEdit('acme/widget')
  const edited = 'pnpm install\npnpm build\npnpm test\n'
  page.face.editField('setup', edited)
  assert.equal(state().form?.fields.setup, edited)
  assert.equal(state().form?.dirty, true)
  await checked(made)
  assert.equal(fake.checked.at(-1)?.fields.setup, edited, 'the check sees the newlines')
  await page.face.save()
  assert.equal(fake.saved.at(-1)?.fields.setup, edited)
})

test('saving what is stored says there was nothing to save, and a clean edit form has nothing to save at all', async () => {
  const made = await opened()
  const { fake, page, state } = made
  await page.face.startEdit('acme/widget')
  await page.face.save()
  assert.equal(count(fake.calls, 'save'), 0, 'a form that is clean is not saved')
  page.face.editField('role', 'changed')
  // Somebody else made the very same change first, to the document the form is over.
  fake.entries.set('acme/widget', fields({ role: 'changed' }))
  await checked(made)
  await page.face.save()
  assert.equal(state().notice?.tone, 'info')
  assert.match(state().notice?.text ?? '', /^Nothing to save for acme\/widget/)
  assert.equal(state().form, null)
})

// --- the environment ---------------------------------------------------------------------------------

test('the environment is edited as rows, and the registry gets them as a mapping, without the empty row being added', async () => {
  const made = await opened()
  const { fake, page, state } = made
  await page.face.startEdit('acme/widget')
  page.face.editEnv([{ name: 'CI', value: '1' }, { name: 'FLAVOUR', value: 'vanilla' }, { name: '', value: '' }])
  assert.equal(state().form?.dirty, true)
  assert.deepEqual(state().form?.env, [{ name: 'CI', value: '1' }, { name: 'FLAVOUR', value: 'vanilla' }, { name: '', value: '' }], 'the empty row stays on the page')
  assert.deepEqual(state().form?.fields.gateEnv, { CI: '1', FLAVOUR: 'vanilla' })
  await checked(made)
  assert.deepEqual(fake.checked.at(-1)?.fields.gateEnv, { CI: '1', FLAVOUR: 'vanilla' })
  await page.face.save()
  assert.deepEqual(fake.saved[0]?.fields.gateEnv, { CI: '1', FLAVOUR: 'vanilla' })
})

test('the rows of a stored environment are there when the form opens, and taking them all out is a change', async () => {
  const made = setup()
  made.fake.entries.set('acme/widget', fields({ gateEnv: { CI: '1' } }))
  await made.page.face.open()
  await made.page.face.startEdit('acme/widget')
  assert.deepEqual(made.state().form?.env, [{ name: 'CI', value: '1' }])
  made.page.face.editEnv([])
  assert.equal(made.state().form?.dirty, true)
  assert.deepEqual(made.state().form?.fields.gateEnv, {})
})

test('a variable named twice, and a value with no variable, are problems here, and are not sent to be checked', async () => {
  const made = await opened()
  const { fake, page, state } = made
  await page.face.startEdit('acme/widget')
  const checks = fake.checked.length
  page.face.editEnv([{ name: 'CI', value: '1' }, { name: 'CI', value: '2' }])
  await checked(made)
  assert.match(state().form?.problem ?? '', /CI.*twice/)
  page.face.editEnv([{ name: '', value: 'orphan' }])
  await checked(made)
  assert.match(state().form?.problem ?? '', /needs a variable name/)
  assert.equal(state().form?.dirty, true, 'a row that is typed is an edit, though the settings are as stored')
  assert.equal(fake.checked.length, checks, 'the registry was not asked about a form that is not one')
  await page.face.save()
  assert.equal(count(fake.calls, 'save'), 0)
  assert.match(state().notice?.text ?? '', /^Can't save: .*needs a variable name/)
  page.face.editEnv([{ name: 'CI', value: '1' }])
  await checked(made)
  assert.equal(state().form?.problem, null)
})

// --- conflicts -------------------------------------------------------------------------------------

test('a save over a registry that has changed shows what is there now, and keeps the form', async () => {
  const made = await opened()
  const { fake, page, state } = made
  await page.face.startEdit('acme/widget')
  page.face.editField('role', 'mine')
  await checked(made)
  const theirCommit = fake.external(entries => entries.set('acme/widget', fields({ role: 'theirs' })))
  await page.face.save()
  assert.equal(state().notice?.tone, 'error')
  assert.match(state().notice?.text ?? '', /projects\.yaml changed since you loaded it/)
  assert.deepEqual(state().conflict, { theirs: fields({ role: 'theirs' }), commit: theirCommit })
  assert.equal(state().form?.fields.role, 'mine', 'the form is as the person left it')
  assert.equal(state().form?.dirty, true)
  assert.equal(state().busy, undefined)
  // With a conflict open another save would be refused again.
  await page.face.save()
  assert.equal(count(fake.calls, 'save'), 1)
})

test('after a conflict, Reload takes the registry\'s settings and drops the edit', async () => {
  const made = await opened()
  const { fake, page, state } = made
  await page.face.startEdit('acme/widget')
  page.face.editField('role', 'mine')
  page.face.setNote('why')
  await checked(made)
  const theirCommit = fake.external(entries => entries.set('acme/widget', fields({ role: 'theirs' })))
  await page.face.save()
  await page.face.reload()
  assert.equal(state().conflict, undefined)
  assert.deepEqual(state().form?.fields, fields({ role: 'theirs' }))
  assert.deepEqual(state().form?.saved, fields({ role: 'theirs' }))
  assert.equal(state().form?.base, theirCommit)
  assert.equal(state().form?.dirty, false)
  assert.equal(state().form?.note, '')
  assert.equal(state().form?.checking, false)
})

test('after a conflict, Keep mine puts the edit over what is there now, and the save goes through', async () => {
  const made = await opened()
  const { fake, page, state } = made
  await page.face.startEdit('acme/widget')
  page.face.editField('role', 'mine')
  await checked(made)
  const theirCommit = fake.external(entries => entries.set('acme/widget', fields({ role: 'theirs' })))
  await page.face.save()
  page.face.keepMine()
  assert.equal(state().conflict, undefined)
  assert.equal(state().form?.fields.role, 'mine')
  assert.deepEqual(state().form?.saved, fields({ role: 'theirs' }))
  assert.equal(state().form?.base, theirCommit)
  assert.equal(state().form?.dirty, true)
  await page.face.save()
  assert.equal(fake.saved.at(-1)?.base, theirCommit)
  assert.equal(state().notice?.tone, 'success')
  assert.equal(fake.entries.get('acme/widget')?.role, 'mine')
})

test('a conflict that is only another project\'s change is not one: the form moves onto the new commit and a save goes through', async () => {
  const made = await opened()
  const { fake, page, state } = made
  await page.face.startEdit('acme/widget')
  page.face.editField('role', 'mine')
  await checked(made)
  const theirCommit = fake.external(entries => entries.set('acme/gadget', fields({ role: 'another project' })))
  await page.face.save()
  assert.equal(state().conflict, undefined, 'nothing of this project changed')
  assert.equal(state().form?.base, theirCommit)
  assert.equal(state().form?.fields.role, 'mine')
  assert.equal(state().notice?.tone, 'info')
  assert.match(state().notice?.text ?? '', /not acme\/widget.*Save again/)
  await page.face.save()
  assert.equal(state().notice?.tone, 'success')
  assert.equal(fake.entries.get('acme/widget')?.role, 'mine')
  assert.equal(fake.entries.get('acme/gadget')?.role, 'another project')
})

test('a new project that somebody else added first is a conflict with theirs; Keep mine turns the form into an edit of it', async () => {
  const made = await opened()
  const { fake, page, state } = made
  await page.face.startAdd()
  await fillAdd(made, 'acme/new')
  const theirCommit = fake.external(entries => entries.set('acme/new', fields({ role: 'theirs' })))
  await page.face.save()
  assert.deepEqual(state().conflict, { theirs: fields({ role: 'theirs' }), commit: theirCommit })
  assert.equal(state().form?.mode, 'add')
  page.face.keepMine()
  assert.equal(state().form?.mode, 'edit')
  assert.deepEqual(state().form?.saved, fields({ role: 'theirs' }))
  assert.equal(state().form?.base, theirCommit)
  assert.equal(state().form?.fields.role, 'something new')
  assert.equal(state().form?.dirty, true)
  await until('the check as an edit', () => state().form?.checking === false && fake.checked.at(-1)?.adding === false)
  await page.face.save()
  assert.equal(fake.saved.at(-1)?.adding, false)
  assert.equal(fake.entries.get('acme/new')?.role, 'something new')
})

test('a new project that somebody else added first: Reload opens theirs as an edit', async () => {
  const made = await opened()
  const { fake, page, state } = made
  await page.face.startAdd()
  await fillAdd(made, 'acme/new')
  const theirCommit = fake.external(entries => entries.set('acme/new', fields({ role: 'theirs' })))
  await page.face.save()
  await page.face.reload()
  assert.equal(state().conflict, undefined)
  assert.equal(state().form?.mode, 'edit')
  assert.deepEqual(state().form?.fields, fields({ role: 'theirs' }))
  assert.equal(state().form?.base, theirCommit)
  assert.equal(state().form?.dirty, false)
})

// --- live ------------------------------------------------------------------------------------------

test('a change to projects.yaml reads the list again; a change to another file does not', async () => {
  const { fake, page, state } = await opened()
  const reads = count(fake.calls, 'projects')
  await page.onConfigEvent(changed(['prompts/main.md']))
  assert.equal(count(fake.calls, 'projects'), reads)
  fake.external(entries => entries.set('zed/lib', fields()))
  fake.states.set('zed/lib', 'ready')
  await page.onConfigEvent(changed(['prompts/main.md', 'projects.yaml']))
  assert.equal(count(fake.calls, 'projects'), reads + 1)
  assert.deepEqual(names(state()), ['acme/gadget', 'acme/widget', 'zed/lib'])
})

test('a proposal event reads the list again, for the count', async () => {
  const { fake, page, state } = await opened()
  fake.proposals = 1
  await page.onConfigEvent({ kind: 'proposal', id: 'p1', status: 'open' })
  assert.equal(state().pendingProposals, 1)
  fake.proposals = 0
  await page.onConfigEvent({ kind: 'proposal', id: 'p1', status: 'accepted' })
  assert.equal(state().pendingProposals, 0)
})

test('a remote event is not the page\'s business', async () => {
  const { fake, page } = await opened()
  const reads = count(fake.calls, 'projects')
  await page.onConfigEvent({ kind: 'remote', status: { pending: 0 } })
  assert.equal(count(fake.calls, 'projects'), reads)
})

test('a change to the registry takes over a form that has no edits', async () => {
  const made = await opened()
  const { fake, page, state } = made
  await page.face.startEdit('acme/widget')
  const theirCommit = fake.external(entries => entries.set('acme/widget', fields({ role: 'theirs' })))
  await page.onConfigEvent(changed(['projects.yaml'], 1))
  await until('the check', () => state().form?.checking === false)
  assert.deepEqual(state().form?.fields, fields({ role: 'theirs' }))
  assert.deepEqual(state().form?.saved, fields({ role: 'theirs' }))
  assert.equal(state().form?.base, theirCommit)
  assert.equal(state().form?.dirty, false)
  assert.equal(state().conflict, undefined)
})

test('a change to the project under an edit is a conflict, with its settings; the edit stays', async () => {
  const made = await opened()
  const { fake, page, state } = made
  await page.face.startEdit('acme/widget')
  page.face.editField('role', 'mine')
  const theirCommit = fake.external(entries => entries.set('acme/widget', fields({ role: 'theirs' })))
  await page.onConfigEvent(changed(['projects.yaml']))
  assert.deepEqual(state().conflict, { theirs: fields({ role: 'theirs' }), commit: theirCommit })
  assert.equal(state().form?.fields.role, 'mine')
  assert.equal(state().form?.dirty, true)
  // Settled by the person: Reload takes theirs.
  await page.face.reload()
  assert.equal(state().form?.fields.role, 'theirs')
  assert.equal(state().conflict, undefined)
})

test('a conflict that goes away by itself (the other change is undone) is no longer one', async () => {
  const made = await opened()
  const { fake, page, state } = made
  await page.face.startEdit('acme/widget')
  page.face.editField('role', 'mine')
  fake.external(entries => entries.set('acme/widget', fields({ role: 'theirs' })))
  await page.onConfigEvent(changed(['projects.yaml']))
  assert.notEqual(state().conflict, undefined)
  const back = fake.external(entries => entries.set('acme/widget', fields()))
  await page.onConfigEvent(changed(['projects.yaml']))
  assert.equal(state().conflict, undefined)
  assert.equal(state().form?.base, back)
  assert.equal(state().form?.fields.role, 'mine')
})

test('a change to another project moves a form with edits onto the new commit, with no conflict', async () => {
  const made = await opened()
  const { fake, page, state } = made
  await page.face.startEdit('acme/widget')
  page.face.editField('role', 'mine')
  const theirCommit = fake.external(entries => entries.set('acme/gadget', fields({ role: 'another project' })))
  await page.onConfigEvent(changed(['projects.yaml']))
  assert.equal(state().conflict, undefined)
  assert.equal(state().form?.base, theirCommit)
  assert.equal(state().form?.dirty, true)
  await made.page.face.save()
  assert.equal(fake.saved.at(-1)?.base, theirCommit)
})

test('somebody else making the very edit that is in the form leaves nothing to save', async () => {
  const made = await opened()
  const { fake, page, state } = made
  await page.face.startEdit('acme/widget')
  page.face.editField('role', 'same')
  const theirCommit = fake.external(entries => entries.set('acme/widget', fields({ role: 'same' })))
  await page.onConfigEvent(changed(['projects.yaml']))
  assert.equal(state().conflict, undefined)
  assert.equal(state().form?.dirty, false)
  assert.equal(state().form?.base, theirCommit)
})

test('a project removed elsewhere closes a form with no edits, and says so', async () => {
  const made = await opened()
  const { fake, page, state } = made
  await page.face.startEdit('acme/widget')
  fake.external(entries => entries.delete('acme/widget'))
  await page.onConfigEvent(changed(['projects.yaml']))
  assert.equal(state().form, null)
  assert.equal(state().notice?.text, 'acme/widget was removed elsewhere.')
  assert.equal(state().selected, undefined, 'a project that is not there is not selected')
})

test('a project removed elsewhere turns a form with edits into a new project, which Save adds again', async () => {
  const made = await opened()
  const { fake, page, state } = made
  await page.face.startEdit('acme/widget')
  page.face.editField('role', 'mine')
  const theirCommit = fake.external(entries => entries.delete('acme/widget'))
  await page.onConfigEvent(changed(['projects.yaml']))
  assert.equal(state().form?.mode, 'add')
  assert.equal(state().form?.saved, null)
  assert.equal(state().form?.base, theirCommit)
  assert.equal(state().form?.fields.role, 'mine')
  assert.equal(state().conflict, undefined)
  assert.match(state().notice?.text ?? '', /removed elsewhere; Save adds it again/)
  await until('the check as a new project', () => state().form?.checking === false && fake.checked.at(-1)?.adding === true)
  await page.face.save()
  assert.equal(fake.saved.at(-1)?.adding, true)
  assert.equal(fake.entries.get('acme/widget')?.role, 'mine')
})

test('a change that comes while a save is out is read after it, so the save is not its own conflict', async () => {
  const made = await opened()
  const { fake, page, state } = made
  await page.face.startEdit('acme/widget')
  page.face.editField('role', 'mine')
  await checked(made)
  const answer = gate()
  fake.gates.set('save answer', answer)
  const saving = page.face.save()
  await until('the write', () => fake.entries.get('acme/widget')?.role === 'mine')
  const reads = count(fake.calls, 'projects')
  // The echo of the very commit being saved.
  await page.onConfigEvent(changed(['projects.yaml'], 1))
  assert.equal(count(fake.calls, 'projects'), reads, 'not read while the write is out')
  assert.equal(state().conflict, undefined)
  answer.release()
  await saving
  assert.equal(state().conflict, undefined)
  assert.equal(state().form, null)
  assert.equal(state().notice?.tone, 'success')
  assert.equal(state().projects.find(project => project.name === 'acme/widget')?.fields.role, 'mine')
})

test('the first item of a stream reads everything again and says the page is live; a lost carrier says it is not', async () => {
  const { fake, page, state } = await opened()
  page.setConfig(CONFIG)
  assert.equal(state().stream, 'connecting')
  fake.external(entries => entries.set('zed/lib', fields()))
  fake.states.set('zed/lib', 'ready')
  await page.onConfigEvent({ kind: 'remote', status: { pending: 0 } }, true)
  assert.equal(state().stream, 'live')
  assert.deepEqual(names(state()), ['acme/gadget', 'acme/widget', 'zed/lib'])
  page.streamDown()
  assert.equal(state().stream, 'down')
  page.setConfig(undefined)
  assert.equal(state().stream, 'off')
  page.streamDown()
  assert.equal(state().stream, 'off', 'a page with no stream has none to lose')
})

// --- removing --------------------------------------------------------------------------------------

test('remove asks first, and cancelling asks nothing of the registry', async () => {
  const { fake, page, state } = await opened()
  page.face.askRemove('acme/widget')
  assert.deepEqual(state().confirm, { kind: 'remove', name: 'acme/widget' })
  page.face.cancelConfirm()
  assert.equal(state().confirm, null)
  await page.face.remove()
  assert.equal(fake.removed.length, 0, 'nothing is removed without the question')
  page.face.askRemove('acme/missing')
  assert.equal(state().confirm, null)
  assert.match(state().notice?.text ?? '', /acme\/missing/)
})

test('a confirmed removal is made against the commit the list was read at, and the project leaves the page', async () => {
  const { fake, page, state } = await opened()
  page.face.select('acme/widget')
  page.face.askRemove('acme/widget')
  await page.face.remove()
  assert.deepEqual(fake.removed, [{ name: 'acme/widget', base: id(0), note: '' }])
  assert.equal(state().confirm, null)
  assert.equal(state().busy, undefined)
  assert.equal(state().notice?.tone, 'success')
  assert.equal(state().notice?.text, `Removed acme/widget as ${id(1).slice(0, 7)}. Its clone and workspace stay.`)
  assert.deepEqual(names(state()), ['acme/gadget'])
  assert.equal(state().selected, undefined)
})

test('removing the project that is open in the form closes the form', async () => {
  const made = await opened()
  const { page, state } = made
  await page.face.startEdit('acme/widget')
  page.face.editField('role', 'unsaved')
  page.face.askRemove('acme/widget')
  await page.face.remove()
  assert.equal(state().form, null)
})

test('a removal over a registry that has changed is refused, the list is read again, and the question is asked again', async () => {
  const { fake, page, state } = await opened()
  page.face.askRemove('acme/widget')
  fake.external(entries => entries.set('zed/lib', fields()))
  fake.states.set('zed/lib', 'ready')
  await page.face.remove()
  assert.equal(state().notice?.tone, 'error')
  assert.match(state().notice?.text ?? '', /nothing was removed/)
  assert.equal(state().confirm, null)
  assert.deepEqual(names(state()), ['acme/gadget', 'acme/widget', 'zed/lib'])
  assert.equal(state().commit, id(1))
  page.face.askRemove('acme/widget')
  await page.face.remove()
  assert.equal(state().notice?.tone, 'success')
})

test('removing a project that is not there any more reads the list again', async () => {
  const { fake, page, state } = await opened()
  page.face.askRemove('acme/widget')
  fake.entries.delete('acme/widget')
  await page.face.remove()
  assert.match(state().notice?.text ?? '', /Not found/)
  assert.deepEqual(names(state()), ['acme/gadget'])
})

test('a removal the store refuses, or the carrier fails, says so and leaves the list alone', async () => {
  const { fake, page, state } = await opened()
  fake.up = false
  page.face.askRemove('acme/widget')
  await page.face.remove()
  assert.match(state().notice?.text ?? '', /config store isn't running/)
  assert.equal(state().busy, undefined)
})

// --- retry -----------------------------------------------------------------------------------------

test('retry asks the service, then reads the list: the project is queued again', async () => {
  const { fake, page, state } = await opened()
  await page.face.retry('acme/gadget')
  assert.equal(fake.calls.includes('retry acme/gadget'), true)
  assert.equal(state().notice?.tone, 'success')
  assert.equal(state().notice?.text, 'Queued acme/gadget for onboarding')
  assert.equal(state().projects.find(project => project.name === 'acme/gadget')?.status.state, 'pending')
  assert.equal(state().busy, undefined)
})

test('retry works on a ready project too: the service decides', async () => {
  const { fake, page, state } = await opened()
  await page.face.retry('acme/widget')
  assert.equal(state().notice?.tone, 'success')
  assert.equal(fake.states.get('acme/widget'), 'pending')
})

test('a retry the service refuses says why, with its own words', async () => {
  const { fake, page, state } = await opened()
  fake.states.set('acme/gadget', 'cloning')
  await page.face.retry('acme/gadget')
  assert.equal(state().notice?.tone, 'error')
  assert.equal(state().notice?.text, 'Can\'t retry: acme/gadget is being onboarded')
  assert.equal(state().projects.find(project => project.name === 'acme/gadget')?.status.state, 'cloning', 'the list was read again')
})

test('one thing is done at a time: a retry while another is out does nothing', async () => {
  const { fake, page, state } = await opened()
  const slow = gate()
  fake.gates.set('retry', slow)
  const first = page.face.retry('acme/gadget')
  await until('the retry to be out', () => state().busy === 'retry:acme/gadget')
  await page.face.retry('acme/widget')
  assert.equal(count(fake.calls, 'retry'), 1)
  slow.release()
  await first
  assert.equal(state().busy, undefined)
})

// --- moving away from a form with edits ------------------------------------------------------------

test('moving to another project, or another form, with edits asks first; confirming goes there and drops them', async () => {
  const { page, state } = await opened()
  await page.face.startEdit('acme/widget')
  page.face.editField('role', 'unsaved')

  page.face.select('acme/gadget')
  assert.deepEqual(state().confirm, { kind: 'discard', then: { to: 'select', name: 'acme/gadget' } })
  assert.equal(state().selected, 'acme/widget')
  assert.notEqual(state().form, null)
  page.face.cancelConfirm()
  assert.equal(state().confirm, null)
  assert.equal(state().form?.fields.role, 'unsaved', 'cancelling keeps the edit')

  await page.face.startEdit('acme/gadget')
  assert.deepEqual(state().confirm, { kind: 'discard', then: { to: 'edit', name: 'acme/gadget' } })
  await page.face.confirmDiscard()
  assert.equal(state().form?.name, 'acme/gadget')
  assert.equal(state().form?.dirty, false)
  assert.equal(state().confirm, null)

  page.face.editField('role', 'unsaved too')
  await page.face.startAdd()
  assert.deepEqual(state().confirm, { kind: 'discard', then: { to: 'add' } })
  await page.face.confirmDiscard()
  assert.equal(state().form?.mode, 'add')
  assert.equal(state().form?.name, '')

  page.face.editField('name', 'acme/new')
  page.face.select('acme/widget')
  assert.deepEqual(state().confirm, { kind: 'discard', then: { to: 'select', name: 'acme/widget' } })
  await page.face.confirmDiscard()
  assert.equal(state().form, null)
  assert.equal(state().selected, 'acme/widget')
})

test('moving with a form that has no edits just goes', async () => {
  const { page, state } = await opened()
  await page.face.startEdit('acme/widget')
  page.face.select('acme/gadget')
  assert.equal(state().confirm, null)
  assert.equal(state().form, null)
  assert.equal(state().selected, 'acme/gadget')
  await page.face.startAdd()
  await page.face.startEdit('acme/widget')
  assert.equal(state().form?.name, 'acme/widget')
  assert.equal(state().confirm, null)
})

test('cancel drops the form and what was said of it', async () => {
  const made = await opened()
  const { page, state, timer } = made
  await page.face.startEdit('acme/widget')
  page.face.editField('role', 'unsaved')
  page.face.cancel()
  assert.equal(state().form, null)
  assert.equal(timer.armed(CHECK_DELAY), 0, 'no check is left due for a form that is gone')
  assert.equal(state().conflict, undefined)
})

test('editing the same project again does not open the form anew', async () => {
  const { fake, page, state } = await opened()
  await page.face.startEdit('acme/widget')
  page.face.editField('role', 'unsaved')
  const checks = fake.checked.length
  await page.face.startEdit('acme/widget')
  assert.equal(state().form?.fields.role, 'unsaved')
  assert.equal(state().confirm, null)
  assert.equal(fake.checked.length, checks)
})

test('edit of a project the list does not have says so', async () => {
  const { page, state } = await opened()
  await page.face.startEdit('acme/missing')
  assert.equal(state().form, null)
  assert.equal(state().notice?.tone, 'error')
  assert.match(state().notice?.text ?? '', /acme\/missing/)
})

// --- focus ---------------------------------------------------------------------------------------

/** Where the page was last asked to move focus, and whether that is a new request since `before`. */
function focusedTo(state: PageState, before: PageState['focus']): string | undefined {
  const focus = state.focus
  return focus === undefined || focus.seq === before?.seq ? undefined : focus.to
}

test('focus: after an action that takes away the control that had it, the page is asked to move focus where the eye goes', async () => {
  const made = await opened()
  const { fake, page, state } = made
  // Edit opens the form in the project's place: its heading.
  let before = state().focus
  await page.face.startEdit('acme/widget')
  assert.equal(focusedTo(state(), before), 'form')
  // Cancel goes back to the project.
  before = state().focus
  page.face.cancel()
  assert.equal(focusedTo(state(), before), 'project')
  // A saved edit: the project's heading.
  await page.face.startEdit('acme/widget')
  page.face.editField('role', 'changed')
  await checked(made)
  before = state().focus
  await page.face.save()
  assert.equal(state().form, null)
  assert.equal(focusedTo(state(), before), 'project')
  // A save the registry refuses: the notice that says why.
  await page.face.startAdd()
  await fillAdd(made, 'acme/new')
  fake.entries.set('acme/new', fields())
  before = state().focus
  await page.face.save()
  assert.notEqual(state().form, null)
  assert.equal(focusedTo(state(), before), 'notice')
  // Leaving that form for a project, once the edits are dropped (the question's buttons go): the project.
  page.face.select('acme/widget')
  before = state().focus
  await page.face.confirmDiscard()
  assert.equal(state().form, null)
  assert.equal(focusedTo(state(), before), 'project')
  // Cancel of a new project goes back to the project that is open.
  await page.face.startAdd()
  before = state().focus
  page.face.cancel()
  assert.equal(state().selected, 'acme/widget')
  assert.equal(focusedTo(state(), before), 'project')
  // Retry (its button may go with the state it leaves): the notice.
  before = state().focus
  await page.face.retry('acme/widget')
  assert.equal(focusedTo(state(), before), 'notice')
  // A removal takes the project away: the notice.
  page.face.askRemove('acme/widget')
  before = state().focus
  await page.face.remove()
  assert.equal(state().selected, undefined)
  assert.equal(focusedTo(state(), before), 'notice')
  // Nothing open after a cancel: the page's title.
  await page.face.startAdd()
  before = state().focus
  page.face.cancel()
  assert.equal(focusedTo(state(), before), 'page')
})

test('focus: after Add, the request comes once the new project is in the list, so its heading is there to take it', async () => {
  const made = await opened()
  const { page, state } = made
  await page.face.startAdd()
  await fillAdd(made, 'acme/new')
  // What the page holds at the moment it is asked to move focus.
  const asked: Array<{ to: string, listed: boolean, selected: string | undefined, form: boolean }> = []
  let seq = state().focus?.seq
  const stop = page.face.hooks.page.subscribe(() => {
    const now = page.getState()
    if (now.focus === undefined || now.focus.seq === seq) return
    seq = now.focus.seq
    asked.push({ to: now.focus.to, listed: names(now).includes('acme/new'), selected: now.selected, form: now.form !== null })
  })
  try {
    await page.face.save()
  } finally {
    stop()
  }
  assert.deepEqual(asked, [{ to: 'project', listed: true, selected: 'acme/new', form: false }])
})

test('dismiss clears the notice', async () => {
  const { page, state } = await opened()
  await page.face.retry('acme/gadget')
  assert.notEqual(state().notice, undefined)
  page.face.dismiss()
  assert.equal(state().notice, undefined)
})

// --- polling ---------------------------------------------------------------------------------------

test('while a project is being onboarded the list is read every few seconds, and it stops when none is', async () => {
  const made = setup()
  const { fake, page, state, timer } = made
  fake.states.set('acme/gadget', 'cloning')
  await page.face.open()
  assert.equal(timer.armed(POLL_INTERVAL), 1)
  assert.equal(POLL_INTERVAL, 5_000)
  const reads = count(fake.calls, 'projects')

  timer.fire(POLL_INTERVAL)
  await until('the poll', () => count(fake.calls, 'projects') === reads + 1)
  await until('the next poll to be set', () => timer.armed(POLL_INTERVAL) === 1)
  assert.equal(state().projects.find(project => project.name === 'acme/gadget')?.status.state, 'cloning')

  fake.states.set('acme/gadget', 'setup')
  timer.fire(POLL_INTERVAL)
  await until('the poll', () => count(fake.calls, 'projects') === reads + 2)
  await until('the next poll to be set', () => timer.armed(POLL_INTERVAL) === 1)
  assert.equal(state().projects.find(project => project.name === 'acme/gadget')?.status.state, 'setup')

  fake.states.set('acme/gadget', 'ready')
  timer.fire(POLL_INTERVAL)
  await until('the poll', () => count(fake.calls, 'projects') === reads + 3)
  await until('the status to arrive', () => state().projects.find(project => project.name === 'acme/gadget')?.status.state === 'ready')
  assert.equal(timer.armed(POLL_INTERVAL), 0, 'nothing is being onboarded any more')
})

test('a pending project is polled too, and a failed or ready one is not', async () => {
  const made = setup()
  made.fake.states.set('acme/gadget', 'pending')
  await made.page.face.open()
  assert.equal(made.timer.armed(POLL_INTERVAL), 1)
  const quiet = await opened()
  assert.equal(quiet.timer.armed(POLL_INTERVAL), 0, 'one failed, one ready')
})

test('onStatus reads the list now, and the poll goes on from its answer', async () => {
  const made = setup()
  const { fake, page, state, timer } = made
  await page.face.open()
  fake.states.set('acme/widget', 'setup')
  await page.onStatus()
  assert.equal(state().projects.find(project => project.name === 'acme/widget')?.status.state, 'setup')
  assert.equal(timer.armed(POLL_INTERVAL), 1)
})

test('a lost stream stops the polling, and the next list that finds a project being onboarded starts it again', async () => {
  const made = setup()
  const { fake, page, timer } = made
  fake.states.set('acme/gadget', 'cloning')
  await page.face.open()
  assert.equal(timer.armed(POLL_INTERVAL), 1)
  page.setConfig(CONFIG)
  page.streamDown()
  assert.equal(timer.armed(POLL_INTERVAL), 0)
  await page.onConfigEvent({ kind: 'remote', status: { pending: 0 } }, true)
  assert.equal(timer.armed(POLL_INTERVAL), 1)
})

test('a poll the carrier failed does not go on: the page says so', async () => {
  const made = setup()
  const { fake, page, state, timer } = made
  fake.states.set('acme/gadget', 'cloning')
  await page.face.open()
  fake.projectsDown = true
  timer.fire(POLL_INTERVAL)
  await until('the failure', () => state().listError !== undefined)
  assert.equal(timer.armed(POLL_INTERVAL), 0)
  assert.deepEqual(names(state()), ['acme/gadget', 'acme/widget'], 'what was shown stays')
  fake.projectsDown = false
  await page.face.reload()
  assert.equal(timer.armed(POLL_INTERVAL), 1)
})

test('there is only ever one poll waiting, however often the list is read', async () => {
  const made = setup()
  const { fake, page, timer } = made
  fake.states.set('acme/gadget', 'cloning')
  await page.face.open()
  await page.face.open()
  await page.onStatus()
  await page.onConfigEvent(changed(['projects.yaml']))
  assert.equal(timer.armed(POLL_INTERVAL), 1)
})

test('reads of the list do not overlap: one made while another is out waits, and gets the last answer', async () => {
  const made = setup()
  const { fake, page, state } = made
  const slow = gate()
  fake.gates.set('projects', slow)
  const first = page.face.open()
  await until('the read to be out', () => fake.calls.length === 1)
  const second = page.onStatus()
  fake.external(entries => entries.set('zed/lib', fields()))
  fake.states.set('zed/lib', 'ready')
  slow.release()
  await Promise.all([first, second])
  assert.deepEqual(names(state()), ['acme/gadget', 'acme/widget', 'zed/lib'], 'read again after the change')
  assert.equal(count(fake.calls, 'projects'), 2)
})

// --- the page going away ---------------------------------------------------------------------------

test('dispose clears the poll that is waiting, and nothing arms it again', async () => {
  const made = setup()
  const { fake, page, timer } = made
  fake.states.set('acme/gadget', 'cloning')
  await page.face.open()
  assert.equal(timer.armed(POLL_INTERVAL), 1)
  page.dispose()
  assert.equal(timer.armed(POLL_INTERVAL), 0)
  await page.onStatus()
  await page.onConfigEvent(changed(['projects.yaml']))
  assert.equal(timer.armed(POLL_INTERVAL), 0, 'a read after dispose does not poll')
})

test('dispose clears the pause of a check that is due, and no check is due after it', async () => {
  const made = await opened()
  const { fake, page, timer } = made
  await page.face.startAdd()
  page.face.editField('name', 'acme/new')
  assert.equal(timer.armed(CHECK_DELAY), 1)
  const checks = fake.checked.length
  page.dispose()
  assert.equal(timer.armed(CHECK_DELAY), 0)
  page.face.editField('family', 'acme')
  assert.equal(timer.armed(CHECK_DELAY), 0, 'an edit after dispose sets no pause')
  assert.equal(fake.checked.length, checks)
})

test('a read that lands after dispose neither arms the poll nor changes the page', async () => {
  const made = setup()
  const { fake, page, state, timer } = made
  fake.states.set('acme/gadget', 'cloning')
  await page.face.open()
  const slow = gate()
  fake.gates.set('projects', slow)
  timer.fire(POLL_INTERVAL)
  await until('the read to be out', () => count(fake.calls, 'projects') === 2)
  fake.external(entries => entries.set('zed/lib', fields()))
  page.dispose()
  const before = state()
  slow.release()
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(state(), before, 'nothing was patched')
  assert.equal(timer.armed(), 0)
})

test('a read in flight when the stream is lost does not bring the poll back, and the next stream does', async () => {
  const made = setup()
  const { fake, page, timer } = made
  fake.states.set('acme/gadget', 'cloning')
  await page.face.open()
  page.setConfig(CONFIG)
  const slow = gate()
  fake.gates.set('projects', slow)
  timer.fire(POLL_INTERVAL)
  await until('the read to be out', () => count(fake.calls, 'projects') === 2)
  page.streamDown()
  slow.release()
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(timer.armed(POLL_INTERVAL), 0, 'the read landed after the stream was lost')
  await page.onConfigEvent({ kind: 'remote', status: { pending: 0 } }, true)
  assert.equal(timer.armed(POLL_INTERVAL), 1)
})

// --- polling only while the page is shown ---------------------------------------------------------

test('nothing polls before the page has been opened: a read made for another reason leaves no timer', async () => {
  const made = setup()
  const { fake, page, state, timer } = made
  fake.states.set('acme/gadget', 'cloning')
  await page.onConfigEvent({ kind: 'remote', status: { pending: 0 } }, true)
  assert.equal(state().projects.length, 2, 'the list was read')
  assert.equal(timer.armed(), 0)
  await page.onStatus()
  assert.equal(timer.armed(), 0)
})

test('hide stops the polling and nothing starts it until the page is opened again', async () => {
  const made = setup()
  const { fake, page, timer } = made
  fake.states.set('acme/gadget', 'cloning')
  await page.face.open()
  assert.equal(timer.armed(POLL_INTERVAL), 1)
  page.face.hide()
  assert.equal(timer.armed(POLL_INTERVAL), 0)
  await page.onStatus()
  await page.onConfigEvent(changed(['projects.yaml']))
  assert.equal(timer.armed(POLL_INTERVAL), 0, 'a hidden page does not poll')
  await page.face.open()
  assert.equal(timer.armed(POLL_INTERVAL), 1)
})

test('the face has no member the settings shell\'s own props use: the shell\'s wins, and `close` there closes Settings', () => {
  const { page } = setup()
  assert.equal('close' in page.face, false)
  assert.equal(typeof page.face.hide, 'function')
})

test('a read in flight when the page is hidden does not poll on landing', async () => {
  const made = setup()
  const { fake, page, timer } = made
  fake.states.set('acme/gadget', 'cloning')
  await page.face.open()
  const slow = gate()
  fake.gates.set('projects', slow)
  timer.fire(POLL_INTERVAL)
  await until('the read to be out', () => count(fake.calls, 'projects') === 2)
  page.face.hide()
  slow.release()
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(timer.armed(POLL_INTERVAL), 0)
})

// --- a read that a newer one follows -------------------------------------------------------------

test('a read that a newer one follows does not drop what a save just selected', async () => {
  const made = await opened()
  const { fake, page, state } = made
  await page.face.startAdd()
  await fillAdd(made, 'acme/new')
  // A read that began before the save: its answer has no acme/new.
  const stale = gate()
  fake.gates.set('projects', stale)
  const reading = page.onStatus()
  await until('the stale read to be out', () => count(fake.calls, 'projects') === 2)
  const saving = page.face.save()
  await until('the save to be made', () => fake.entries.has('acme/new'))
  await until('the page to select it', () => state().selected === 'acme/new')
  stale.release()
  await Promise.all([reading, saving])
  assert.equal(state().selected, 'acme/new')
  assert.deepEqual(names(state()), ['acme/gadget', 'acme/new', 'acme/widget'])
})

test('a read that a newer one follows passes on that it follows a refused save, so the newer one tells a new project of the conflict', async () => {
  const made = await opened()
  const { fake, page, state } = made
  await page.face.startAdd()
  await fillAdd(made, 'acme/new')
  const theirCommit = fake.external(entries => entries.set('acme/new', fields({ role: 'theirs' })))
  // The read the refused save makes is itself followed by another one.
  const slow = gate()
  fake.gates.set('projects', slow)
  const saving = page.face.save()
  await until('the read after the refused save to be out', () => count(fake.calls, 'projects') === 2)
  const status = page.onStatus()
  slow.release()
  await Promise.all([saving, status])
  assert.deepEqual(state().conflict, { theirs: fields({ role: 'theirs' }), commit: theirCommit })
})

test('a project added while a read was skipped still counts as a change for a new project\'s form: its name is checked again', async () => {
  const made = await opened()
  const { fake, page, state } = made
  await page.face.startAdd()
  await fillAdd(made, 'acme/x')
  assert.equal(state().form?.problem, null)
  // Somebody else adds the very name. Read A sees it and is skipped, because read B follows; B must still find the change.
  fake.external(entries => entries.set('acme/x', fields({ role: 'theirs' })))
  const slow = gate()
  fake.gates.set('projects', slow)
  const first = page.onStatus()
  await until('read A to be out', () => count(fake.calls, 'projects') === 2)
  const second = page.onStatus()
  slow.release()
  await Promise.all([first, second])
  await until('the check', () => state().form?.checking === false)
  assert.equal(count(fake.calls, 'projects'), 3)
  assert.match(state().form?.problem ?? '', /already in projects\.yaml/)
})

// --- the name of a new project while a conflict is open ---------------------------------------

test('renaming a new project while a conflict is open drops the conflict, and Save adds the new name', async () => {
  const made = await opened()
  const { fake, page, state } = made
  await page.face.startAdd()
  await fillAdd(made, 'acme/new')
  const theirCommit = fake.external(entries => entries.set('acme/new', fields({ role: 'theirs' })))
  await page.face.save()
  assert.notEqual(state().conflict, undefined)
  page.face.editField('name', 'acme/other')
  assert.equal(state().conflict, undefined, 'the conflict was about the old name')
  assert.equal(state().form?.mode, 'add')
  assert.equal(state().form?.base, theirCommit)
  await checked(made)
  assert.equal(state().form?.problem, null)
  assert.equal(fake.checked.at(-1)?.name, 'acme/other')
  await page.face.save()
  assert.equal(fake.saved.at(-1)?.name, 'acme/other')
  assert.equal(fake.saved.at(-1)?.adding, true)
  assert.equal(fake.saved.at(-1)?.base, theirCommit)
  assert.equal(state().notice?.tone, 'success')
  assert.equal(fake.entries.get('acme/other')?.role, 'something new')
  assert.equal(fake.entries.get('acme/new')?.role, 'theirs', 'the other project is as it was')
})

test('renaming a new project without a conflict leaves the base alone', async () => {
  const made = await opened()
  const { page, state } = made
  await page.face.startAdd()
  page.face.editField('name', 'acme/new')
  page.face.editField('name', 'acme/other')
  assert.equal(state().form?.base, id(0))
})

// --- a row with no variable is an edit ---------------------------------------------------------

test('Keep mine counts a row with no variable as an edit even when the settings are what is there now', async () => {
  const made = await opened()
  const { fake, page, state } = made
  await page.face.startEdit('acme/widget')
  page.face.editField('role', 'mine')
  fake.external(entries => entries.set('acme/widget', fields({ role: 'theirs' })))
  await page.onConfigEvent(changed(['projects.yaml']))
  assert.notEqual(state().conflict, undefined)
  // After the conflict the person makes the form say what is there now, and leaves a row half typed.
  page.face.editField('role', 'theirs')
  page.face.editEnv([{ name: '', value: 'orphan' }])
  page.face.keepMine()
  assert.equal(state().conflict, undefined)
  assert.equal(state().form?.dirty, true)
})

test('somebody making the very edit that is in the form still leaves a row with no variable as an edit', async () => {
  const made = await opened()
  const { fake, page, state } = made
  await page.face.startEdit('acme/widget')
  page.face.editField('role', 'same')
  page.face.editEnv([{ name: '', value: 'orphan' }])
  fake.external(entries => entries.set('acme/widget', fields({ role: 'same' })))
  await page.onConfigEvent(changed(['projects.yaml']))
  assert.equal(state().conflict, undefined)
  assert.equal(state().form?.dirty, true)
})

// --- the helpers -----------------------------------------------------------------------------------

test('sameFields compares every setting, and the environment without regard to order', () => {
  assert.equal(sameFields(fields(), fields()), true)
  assert.equal(sameFields(fields({ role: 'a' }), fields({ role: 'b' })), false)
  assert.equal(sameFields(fields({ gateEnv: { A: '1', B: '2' } }), fields({ gateEnv: { B: '2', A: '1' } })), true)
  assert.equal(sameFields(fields({ gateEnv: { A: '1' } }), fields({ gateEnv: { A: '2' } })), false)
  assert.equal(sameFields(fields({ gateEnv: { A: '1' } }), fields({ gateEnv: { A: '1', B: '2' } })), false)
  assert.equal(sameFields(fields({ setup: 'x' }), fields()), false)
})
