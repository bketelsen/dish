/**
 * The Skills page's controller, driven through fake remotes: what it loads, how it tracks a draft and checks it, what a
 * save, a new skill, a reset, a delete and a revert do with each answer the store can give, and what a live event does to a
 * page that is clean or has an unsaved edit. The controller has no React in it, so this runs under `node --test`; the JSX
 * around it is checked in a browser.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { createSkills, defaultView, visibleTabs } from '../src/client/controller.ts'
import type { PageState, SkillsController } from '../src/client/controller.ts'
import type { ConfigCalls, ConfigEvent, SkillsApi } from '../src/client/remote.ts'
import { NEW_SKILL_TEMPLATE, RESET_NOTE } from '../src/protocol.ts'
import type { CheckResult, CommitInfo, ErrorCode, Outcome, ReadResult, SkillInfo, SkillsResult } from '../src/protocol.ts'

// --- fakes ---------------------------------------------------------------------------------------

const ok = <T>(value: T): RemoteResult<Outcome<T>> => ({ ok: true, value: { ok: true, value } })
const refused = (code: ErrorCode, message: string): RemoteResult<Outcome<never>> => ({ ok: true, value: { ok: false, code, message } })
const carrierDown = (): RemoteResult<never> => ({ ok: false, error: { message: 'gateway offline' } }) as unknown as RemoteResult<never>

/** The id of the n-th commit of the fake store: 40 characters, and the first seven tell it from the others. */
const id = (n: number): string => `c${n}`.padEnd(40, 'e')
const number = (commit: string): number => Number(/^c(\d+)/.exec(commit)![1])

const pathOf = (name: string): string => `skills/${name}/SKILL.md`

interface Gate { release: () => void, opened: Promise<void> }

function gate(): Gate {
  let release!: () => void
  const opened = new Promise<void>((resolve) => { release = resolve })
  return { release, opened }
}

/** What dish ships, by name. `mine` is not here: it is a skill the person added. */
const DEFAULTS: Record<string, string> = {
  'brainstorming': 'BRAIN default\n',
  'writing-plans': 'PLANS default\n',
}
const MINE = 'MINE v1\n'
const ROLES = ['main', 'architect', 'coder']

/**
 * A store of three skills that behaves as the real one does where the page cares: a read says which commit it was made at, a
 * save with a `base` older than the document's last change is a `CONFLICT`, an empty text is `INVALID`, and writing what is
 * there is `null`. `mine` is one the person added, so it has no shipped default and can be removed; the other two are
 * shipped. A text with `BAD` in it fails `check`; one with `WARN` in it warns.
 */
class FakeSkills {
  head = 0
  up = true
  docs = new Map<string, { text: string, changedAt: number }>()
  pending: Record<string, number> = {}
  calls: string[] = []
  /** The text of every `check`, in order. */
  checked: string[] = []
  gates = new Map<string, Gate>()
  /** The commit at which each deleted document was deleted. A write over a base older than that is a `CONFLICT`, as in the store. */
  tombstones = new Map<string, number>()
  /** Names the list leaves out, as a list read before they existed would. */
  hidden = new Set<string>()
  readDown = false
  checkDown = false
  skillsDown = false
  /** The next read fails at the carrier, once. */
  failNextRead = false
  /** The next write answers `null`, as the store does for a text the document already has. */
  forceNull = false

  constructor() {
    for (const name of Object.keys(DEFAULTS)) this.docs.set(name, { text: DEFAULTS[name]!, changedAt: 0 })
    this.docs.set('mine', { text: MINE, changedAt: 0 })
  }

  /** Somebody else writes a document: the head moves, and so does what a reader would see. */
  external(name: string, text: string): string {
    this.head++
    this.docs.set(name, { text, changedAt: this.head })
    return id(this.head)
  }

  /** Somebody else deletes a document. */
  externalDelete(name: string): string {
    this.head++
    this.docs.delete(name)
    this.tombstones.set(name, this.head)
    return id(this.head)
  }

  /** Hold the call that reaches `name` until its gate opens. A gate holds one call: the next to reach the name goes straight through. */
  private async wait(name: string): Promise<void> {
    const held = this.gates.get(name)
    if (held === undefined) return
    this.gates.delete(name)
    await held.opened
  }

  private commitInfo(name: string, note: string): CommitInfo {
    return { id: id(this.head), time: 1_000, author: { kind: 'user' }, message: 'msg', ...(note === '' ? {} : { note }), paths: [pathOf(name)] }
  }

  private info(name: string): SkillInfo {
    const doc = this.docs.get(name)
    const shipped = DEFAULTS[name] !== undefined
    return {
      name,
      path: pathOf(name),
      description: `About ${name}`,
      roles: ['main'],
      modelInvocable: true,
      userInvocable: true,
      shipped,
      differsFromDefault: this.up && doc !== undefined && shipped && doc.text !== DEFAULTS[name],
      missing: this.up && doc === undefined,
      problem: '',
      pendingProposals: this.pending[name] ?? 0,
    }
  }

  private write(name: string, text: string, base: string, note: string): RemoteResult<Outcome<CommitInfo | null>> {
    if (!this.up) return refused('UNAVAILABLE', 'the config store isn\'t running, so skills can\'t be saved')
    if (this.forceNull) {
      this.forceNull = false
      return ok(null)
    }
    if (text.trim() === '') return refused('INVALID', `${pathOf(name)}: a skill can't be empty`)
    const doc = this.docs.get(name)
    // The store counts a deletion as a change of the path, as it counts a write.
    const changedAt = doc?.changedAt ?? this.tombstones.get(name) ?? 0
    if (base !== '' && changedAt > number(base)) return refused('CONFLICT', `${pathOf(name)} changed since ${base.slice(0, 7)}`)
    if (doc?.text === text) return ok(null)
    this.head++
    this.docs.set(name, { text, changedAt: this.head })
    return ok(this.commitInfo(name, note))
  }

  readonly api: SkillsApi = {
    skills: async () => {
      this.calls.push('skills')
      await this.wait('skills')
      if (this.skillsDown) return carrierDown()
      const names = this.up ? new Set([...this.docs.keys(), ...Object.keys(DEFAULTS)]) : new Set(Object.keys(DEFAULTS))
      const skills = [...names].filter(name => !this.hidden.has(name)).sort().map(name => this.info(name))
      const result: SkillsResult = { commit: this.up ? id(this.head) : '', skills, roles: ROLES }
      return ok(result)
    },
    read: async (name) => {
      this.calls.push(`read ${name}`)
      if (this.readDown || this.failNextRead) {
        this.failNextRead = false
        return carrierDown()
      }
      const shipped = DEFAULTS[name]
      const doc = this.up ? this.docs.get(name) : undefined
      let answer: ReadResult | undefined
      if (doc !== undefined) answer = { text: doc.text, commit: id(this.head), defaultText: shipped ?? '', missing: false }
      else if (shipped !== undefined) answer = { text: shipped, commit: this.up ? id(this.head) : '', defaultText: shipped, missing: this.up }
      // The answer is what the document says when the read is made, not when the gate lets it through.
      await this.wait(`read ${name}`)
      if (answer === undefined) return refused('NOT_FOUND', `there is no skill ${JSON.stringify(name)}`)
      return ok(answer)
    },
    check: async (name, text) => {
      this.calls.push(`check ${name}`)
      this.checked.push(text)
      const answer: CheckResult = text.includes('BAD')
        ? { problems: ['frontmatter: BAD'], warnings: [], summary: null }
        : {
            problems: [],
            warnings: text.includes('WARN') ? ['a warning'] : [],
            summary: { description: `About ${name}`, roles: ['main'], modelInvocable: true, userInvocable: true, chars: text.length },
          }
      await this.wait('check')
      if (this.checkDown) return carrierDown()
      return ok(answer)
    },
    save: async (name, text, base, note) => {
      this.calls.push(`save ${name} ${base === '' ? '-' : base.slice(0, 7)} ${note === '' ? '-' : note}`)
      await this.wait('save')
      const answer = this.write(name, text, base, note)
      await this.wait('save answer')
      return answer
    },
    reset: async (name, base, note) => {
      this.calls.push(`reset ${name} ${base === '' ? '-' : base.slice(0, 7)} ${note === '' ? '-' : note}`)
      await this.wait('reset')
      const shipped = DEFAULTS[name]
      if (shipped === undefined) return refused('INVALID', `"${name}" has no shipped default to go back to`)
      return this.write(name, shipped, base, note)
    },
    deleteSkill: async (name, base, note) => {
      this.calls.push(`remove ${name} ${base === '' ? '-' : base.slice(0, 7)} ${note === '' ? '-' : note}`)
      await this.wait('remove')
      if (!this.up) return refused('UNAVAILABLE', 'the config store isn\'t running, so skills can\'t be saved')
      if (DEFAULTS[name] !== undefined) return refused('INVALID', 'a shipped skill comes back at the next start; turn it off with `roles: []` instead')
      const doc = this.docs.get(name)
      if (doc === undefined) return refused('NOT_FOUND', `there is no skill ${JSON.stringify(name)} in the store`)
      if (base !== '' && doc.changedAt > number(base)) return refused('CONFLICT', `${pathOf(name)} changed since ${base.slice(0, 7)}`)
      this.head++
      this.docs.delete(name)
      this.tombstones.set(name, this.head)
      const answer = ok(this.commitInfo(name, note))
      await this.wait('remove answer')
      return answer
    },
  }
}

/** The part of dish-config's remote the page uses, over a log it is given. */
class FakeConfig {
  calls: string[] = []
  log: CommitInfo[] = []
  reverts: Array<CommitInfo | null | 'conflict'> = []
  /** The carrier is down: every call fails before the store is reached. */
  down = false

  readonly api: ConfigCalls = {
    history: async (prefix, limit, before) => {
      this.calls.push(`history ${prefix} ${limit} ${before === '' ? '-' : before.slice(0, 7)}`)
      if (this.down) return carrierDown()
      // Like the store: the commits that touched the path, newest first, from just below `before`.
      const touched = this.log.filter(commit => commit.paths.includes(prefix))
      const start = before === '' ? 0 : touched.findIndex(commit => commit.id === before) + 1
      return ok(touched.slice(start, start + limit))
    },
    commit: async (commit) => {
      this.calls.push(`commit ${commit}`)
      if (this.down) return carrierDown()
      const info = this.log.find(candidate => candidate.id === commit)
      if (info === undefined) return refused('NOT_FOUND', `there is no commit ${commit}`)
      return ok({ info, diffs: [{ path: info.paths[0]!, status: 'modified' as const, patch: '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n' }] })
    },
    revert: async (commit) => {
      this.calls.push(`revert ${commit}`)
      if (this.down) return carrierDown()
      const next = this.reverts.shift() ?? null
      if (next === 'conflict') return refused('CONFLICT', 'a later change touched the same files')
      return ok(next)
    },
  }
}

/** A timer the test turns by hand: nothing fires until `fire`. */
class FakeTimer {
  next = 1
  pending = new Map<number, () => void>()
  /** The delay of every timer ever set. */
  delays: number[] = []

  readonly api = {
    setTimeout: (callback: () => void, ms: number): number => {
      const handle = this.next++
      this.pending.set(handle, callback)
      this.delays.push(ms)
      return handle
    },
    clearTimeout: (handle: unknown): void => { this.pending.delete(handle as number) },
  }

  get armed(): number {
    return this.pending.size
  }

  /** Let every timer set so far go off. */
  fire(): void {
    const callbacks = [...this.pending.values()]
    this.pending.clear()
    for (const callback of callbacks) callback()
  }
}

function commitOf(n: number, paths: string[], note?: string): CommitInfo {
  return { id: id(n), time: 1_000 + n, author: { kind: 'user' }, message: `skills: change ${n}`, ...(note === undefined ? {} : { note }), paths }
}

interface Setup {
  fake: FakeSkills
  config: FakeConfig | undefined
  timer: FakeTimer
  page: SkillsController
  state: () => PageState
}

function setup(options: { config?: boolean } = {}): Setup {
  const fake = new FakeSkills()
  const config = options.config === false ? undefined : new FakeConfig()
  const timer = new FakeTimer()
  const page = createSkills(fake.api, config?.api, { timer: timer.api })
  return { fake, config, timer, page, state: () => page.getState() }
}

/** Wait until `check` holds: the fakes answer on later ticks, and a test needs to act once a call has reached them. */
async function until(what: string, check: () => boolean): Promise<void> {
  for (let tries = 0; !check(); tries++) {
    if (tries > 2_000) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 1))
  }
}

/** An opened page, with the first skill (`brainstorming`) selected. */
async function opened(options: { config?: boolean } = {}): Promise<Setup> {
  const made = setup(options)
  await made.page.face.open()
  return made
}

/** Let the debounce go off and the check it starts come back. */
async function checked(made: Pick<Setup, 'timer' | 'state'>): Promise<void> {
  made.timer.fire()
  await until('the check', () => !made.state().checking)
}

const names = (state: PageState): string[] => state.skills.map(skill => skill.name)
const count = (calls: string[], call: string): number => calls.filter(candidate => candidate === call).length

// --- loading ---------------------------------------------------------------------------------------

test('open loads the list and selects the first skill, then checks it', async () => {
  const { fake, state } = await opened()
  assert.deepEqual(names(state()), ['brainstorming', 'mine', 'writing-plans'])
  assert.equal(state().commit, id(0))
  assert.deepEqual(state().roles, ROLES)
  assert.equal(state().listLoaded, true)
  assert.equal(state().selected, 'brainstorming')
  assert.equal(state().document, 'ready')
  assert.deepEqual(state().saved, { text: DEFAULTS.brainstorming, commit: id(0) })
  assert.equal(state().draft, DEFAULTS.brainstorming)
  assert.equal(state().defaultText, DEFAULTS.brainstorming)
  assert.equal(state().shipped, true)
  assert.equal(state().missing, false)
  assert.equal(state().dirty, false)
  assert.equal(state().creating, false)
  assert.equal(state().tab, 'edit')
  assert.equal(state().readOnly, false)
  assert.deepEqual(fake.calls, ['skills', 'read brainstorming', 'check brainstorming'])
  assert.equal(state().checking, false)
  assert.equal(state().check?.summary?.description, 'About brainstorming')
})

test('a document is checked when it is loaded, so the problems of a stored document show', async () => {
  const made = setup()
  made.fake.docs.set('mine', { text: 'BAD from the start\n', changedAt: 0 })
  await made.page.face.open()
  await made.page.face.select('mine')
  assert.deepEqual(made.state().check?.problems, ['frontmatter: BAD'])
  assert.equal(made.state().check?.summary, null)
  assert.equal(made.timer.armed, 0, 'the first check does not wait for the debounce')
  assert.deepEqual(made.timer.delays, [])
})

test('select loads another skill, with a fresh draft, note and check, and asks first about a draft with edits', async () => {
  const { page, state } = await opened()
  page.face.edit('something else\n')
  page.face.setNote('why')
  assert.equal(state().dirty, true)
  await page.face.select('mine')
  assert.deepEqual(state().switching, { name: 'mine', create: false }, 'a draft is not thrown away silently')
  assert.equal(state().selected, 'brainstorming')
  await page.face.confirmSwitch()
  assert.equal(state().selected, 'mine')
  assert.equal(state().switching, undefined)
  assert.deepEqual(state().saved, { text: MINE, commit: id(0) })
  assert.equal(state().draft, MINE)
  assert.equal(state().note, '')
  assert.equal(state().dirty, false)
  assert.equal(state().shipped, false)
  assert.equal(state().defaultText, '')
})

test('selecting while clean switches at once, and cancelling a switch keeps the draft', async () => {
  const { page, state } = await opened()
  await page.face.select('writing-plans')
  assert.equal(state().selected, 'writing-plans')
  assert.equal(state().switching, undefined)
  page.face.edit('x')
  await page.face.select('mine')
  assert.equal(state().switching?.name, 'mine')
  page.face.cancelSwitch()
  assert.equal(state().switching, undefined)
  assert.equal(state().selected, 'writing-plans')
  assert.equal(state().draft, 'x')
})

test('selecting the skill that is open does nothing', async () => {
  const { fake, page } = await opened()
  const before = fake.calls.length
  await page.face.select('brainstorming')
  assert.equal(fake.calls.length, before)
})

test('an answer for a skill that is no longer selected is dropped', async () => {
  const { fake, page, state } = await opened()
  const slow = gate()
  fake.gates.set('read writing-plans', slow)
  const pending = page.face.select('writing-plans')
  await page.face.select('mine')
  assert.equal(state().selected, 'mine')
  slow.release()
  await pending
  assert.equal(state().selected, 'mine')
  assert.equal(state().draft, MINE, 'the late answer did not replace mine')
})

test('a read the carrier failed is an error with a way to try again, and reload tries again', async () => {
  const { fake, page, state } = setup()
  fake.readDown = true
  await page.face.open()
  assert.equal(state().document, 'error')
  assert.equal(state().documentError?.text, 'Something went wrong talking to dish-skills')
  assert.equal(state().documentError?.detail, 'gateway offline')
  fake.readDown = false
  await page.face.reload()
  assert.equal(state().document, 'ready')
  assert.equal(state().draft, DEFAULTS.brainstorming)
})

test('a list the carrier failed is an error, not an empty page', async () => {
  const { fake, page, state } = setup()
  fake.skillsDown = true
  await page.face.open()
  assert.equal(state().listLoaded, true)
  assert.equal(state().listError?.text, 'Something went wrong talking to dish-skills')
  assert.deepEqual(state().skills, [])
  assert.equal(state().selected, undefined)
  fake.skillsDown = false
  await page.face.open()
  assert.equal(state().listError, undefined)
  assert.equal(state().selected, 'brainstorming')
})

test('a skill that can\'t be found is a document error', async () => {
  const { page, state } = await opened()
  await page.face.select('nope')
  assert.equal(state().document, 'error')
  assert.match(state().documentError?.text ?? '', /Not found/)
})

test('a list with no commit means no store: the page is read-only, and a save is refused by the server with a notice', async () => {
  const { fake, page, state } = setup()
  fake.up = false
  await page.face.open()
  assert.equal(state().commit, '')
  assert.equal(state().readOnly, true)
  assert.equal(state().saved?.commit, '')
  assert.deepEqual(names(state()), ['brainstorming', 'writing-plans'])
  await page.face.save()
  page.face.edit('changed')
  await page.face.save()
  assert.equal(state().notice?.tone, 'error')
  assert.match(state().notice?.text ?? '', /config store isn't running/)
  assert.equal(state().draft, 'changed', 'the draft stays')
  fake.up = true
  await page.face.reload()
  assert.equal(state().readOnly, false)
})

// --- the draft -------------------------------------------------------------------------------------

test('edit tracks whether the draft differs from what is saved', async () => {
  const { page, state } = await opened()
  assert.equal(state().dirty, false)
  page.face.edit('BRAIN default\nMore.\n')
  assert.equal(state().dirty, true)
  assert.equal(state().draft, 'BRAIN default\nMore.\n')
  page.face.edit(DEFAULTS.brainstorming!)
  assert.equal(state().dirty, false, 'typing back to what is saved is clean')
})

test('discard returns the draft to the saved text, drops the note, and checks that text again', async () => {
  const { fake, page, state, timer } = await opened()
  page.face.edit('BAD x')
  await checked({ timer, state })
  assert.equal(state().check?.problems.length, 1)
  page.face.setNote('because')
  page.face.discard()
  assert.equal(state().draft, DEFAULTS.brainstorming)
  assert.equal(state().note, '')
  assert.equal(state().dirty, false)
  await until('the check', () => !state().checking)
  assert.deepEqual(state().check?.problems, [])
  assert.equal(fake.checked.at(-1), DEFAULTS.brainstorming)
})

// --- the check -------------------------------------------------------------------------------------

test('check runs 300 ms after the last edit: several edits make one call', async () => {
  const { fake, page, state, timer } = await opened()
  const before = count(fake.calls, 'check brainstorming')
  page.face.edit('one')
  page.face.edit('one two')
  page.face.edit('one two three')
  assert.equal(timer.armed, 1, 'each edit replaces the timer')
  assert.deepEqual(timer.delays, [300, 300, 300])
  assert.equal(state().checking, true)
  assert.equal(count(fake.calls, 'check brainstorming'), before, 'nothing is asked while the person is typing')
  await checked({ timer, state })
  assert.equal(count(fake.calls, 'check brainstorming'), before + 1)
  assert.equal(fake.checked.at(-1), 'one two three')
  assert.equal(state().checking, false)
  assert.equal(state().check?.summary?.chars, 'one two three'.length)
})

test('check with the real timers goes off after the pause', async () => {
  const fake = new FakeSkills()
  // The pause is shortened so that the test does not wait the 300 ms out; the default is checked with the fake timer above.
  const page = createSkills(fake.api, undefined, { delay: 1 })
  await page.face.open()
  const before = fake.checked.length
  page.face.edit('typed')
  assert.equal(fake.checked.length, before)
  await until('the check', () => fake.checked.length === before + 1 && !page.getState().checking)
  assert.equal(fake.checked.at(-1), 'typed')
})

test('warnings are kept beside the summary, and never block a save', async () => {
  const { page, state, timer } = await opened()
  page.face.edit('WARN: long\n')
  await checked({ timer, state })
  assert.deepEqual(state().check?.warnings, ['a warning'])
  assert.notEqual(state().check?.summary, null)
  await page.face.save()
  assert.equal(state().notice?.tone, 'success')
})

test('an answer to a check the person has typed past is dropped', async () => {
  const { fake, page, state, timer } = await opened()
  const slow = gate()
  fake.gates.set('check', slow)
  page.face.edit('BAD first')
  timer.fire()
  await until('the check to be asked', () => fake.checked.at(-1) === 'BAD first')
  page.face.edit('good second')
  assert.equal(timer.armed, 1)
  slow.release()
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.deepEqual(state().check?.problems, [], 'the older answer said BAD; it was dropped')
  assert.equal(state().checking, true, 'the newer check is still to come')
  await checked({ timer, state })
  assert.equal(fake.checked.at(-1), 'good second')
  assert.deepEqual(state().check?.problems, [])
  assert.equal(state().checking, false)
})

test('an answer for the skill the page has left is dropped, and so is the timer', async () => {
  const { fake, page, state, timer } = await opened()
  page.face.edit('BAD for brainstorming')
  assert.equal(timer.armed, 1)
  await page.face.select('mine').then(() => page.face.confirmSwitch())
  assert.equal(timer.armed, 0, 'the old skill\'s check will not be made')
  assert.equal(state().selected, 'mine')
  assert.deepEqual(state().check?.problems, [])

  const slow = gate()
  fake.gates.set('check', slow)
  page.face.edit('BAD for mine')
  timer.fire()
  await until('the check to be asked', () => fake.checked.at(-1) === 'BAD for mine')
  await page.face.select('writing-plans').then(() => page.face.confirmSwitch())
  slow.release()
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(state().selected, 'writing-plans')
  assert.deepEqual(state().check?.problems, [], 'mine\'s answer is not writing-plans\'')
  assert.equal(state().checking, false)
})

test('a check the carrier failed is reported beside the editor, and the old answer goes', async () => {
  const { fake, page, state, timer } = await opened()
  fake.checkDown = true
  page.face.edit('x')
  await checked({ timer, state })
  assert.equal(state().check, null)
  assert.equal(state().checkError?.text, 'Something went wrong talking to dish-skills')
  assert.equal(state().checkError?.detail, 'gateway offline')
  fake.checkDown = false
  page.face.edit('xy')
  await checked({ timer, state })
  assert.equal(state().checkError, undefined)
  assert.notEqual(state().check, null)
})

// --- save ------------------------------------------------------------------------------------------

test('save with nothing changed does nothing', async () => {
  const { fake, page } = await opened()
  const before = fake.calls.length
  await page.face.save()
  assert.equal(fake.calls.length, before)
})

test('save writes the draft on the commit the page loaded, with the note, and refreshes saved and the list', async () => {
  const { fake, page, state, timer } = await opened()
  page.face.edit('BRAIN, but shorter\n')
  page.face.setNote('shorter')
  await checked({ timer, state })
  const listsBefore = count(fake.calls, 'skills')
  await page.face.save()
  assert.ok(fake.calls.includes(`save brainstorming ${id(0).slice(0, 7)} shorter`), fake.calls.join(', '))
  assert.deepEqual(state().saved, { text: 'BRAIN, but shorter\n', commit: id(1) })
  assert.equal(state().dirty, false)
  assert.equal(state().note, '')
  assert.equal(state().notice?.tone, 'success')
  assert.match(state().notice?.text ?? '', /^Saved brainstorming as c1eeeee/)
  assert.equal(state().busy, undefined)
  assert.equal(state().conflict, undefined)
  assert.equal(count(fake.calls, 'skills'), listsBefore + 1, 'the list is read again')
  assert.equal(state().commit, id(1))
  assert.equal(state().skills.find(skill => skill.name === 'brainstorming')?.differsFromDefault, true)
})

test('after a save the next one is made on the new commit', async () => {
  const { fake, page, state, timer } = await opened()
  page.face.edit('one\n')
  await checked({ timer, state })
  await page.face.save()
  page.face.edit('two\n')
  await checked({ timer, state })
  await page.face.save()
  assert.ok(fake.calls.includes(`save brainstorming ${id(1).slice(0, 7)} -`), fake.calls.join(', '))
})

test('what is typed while a save is under way is kept, and is still unsaved', async () => {
  const { fake, page, state, timer } = await opened()
  const slow = gate()
  fake.gates.set('save', slow)
  page.face.edit('first\n')
  await checked({ timer, state })
  const saving = page.face.save()
  assert.equal(state().busy, 'save')
  page.face.edit('first\nsecond\n')
  slow.release()
  await saving
  assert.equal(state().saved?.text, 'first\n')
  assert.equal(state().draft, 'first\nsecond\n')
  assert.equal(state().dirty, true)
})

test('the live event for this page\'s own save, arriving before the save\'s answer, is not a conflict', async () => {
  const { fake, page, state, timer } = await opened()
  const slow = gate()
  fake.gates.set('save answer', slow)
  page.face.edit('mine\n')
  await checked({ timer, state })
  const saving = page.face.save()
  while (fake.head < 1) await new Promise(resolve => setTimeout(resolve, 1))
  // The store has committed and said so, and the answer to the save is still on its way.
  await page.onConfigEvent({ kind: 'changed', commit: id(1), paths: [pathOf('brainstorming')] })
  assert.equal(state().conflict, undefined)
  slow.release()
  await saving
  assert.equal(state().conflict, undefined)
  assert.deepEqual(state().saved, { text: 'mine\n', commit: id(1) })
  assert.equal(state().draft, 'mine\n')
  assert.equal(state().dirty, false)
})

test('a second save while one is under way is not started', async () => {
  const { fake, page, state, timer } = await opened()
  const slow = gate()
  fake.gates.set('save', slow)
  page.face.edit('first\n')
  await checked({ timer, state })
  const saving = page.face.save()
  await page.face.save()
  slow.release()
  await saving
  assert.equal(fake.calls.filter(call => call.startsWith('save ')).length, 1)
})

test('save that finds the document already says this has nothing to commit, and the page is clean', async () => {
  const { fake, page, state, timer } = await opened()
  fake.external('brainstorming', 'same text\n')
  fake.forceNull = true
  page.face.edit('same text\n')
  await checked({ timer, state })
  await page.face.save()
  assert.equal(fake.calls.some(call => call.startsWith('save brainstorming')), true)
  assert.equal(state().notice?.tone, 'info')
  assert.equal(state().dirty, false)
  assert.equal(state().saved?.commit, id(1), 'saved moved to what the store has')
})

test('a save the server refuses as INVALID shows the server\'s reason, and the draft stays', async () => {
  const { page, state, timer } = await opened()
  page.face.edit('   \n')
  await checked({ timer, state })
  await page.face.save()
  assert.equal(state().notice?.tone, 'error')
  assert.match(state().notice?.text ?? '', /can't be empty/)
  assert.equal(state().draft, '   \n')
  assert.equal(state().dirty, true)
})

test('save is refused here while the check has problems, and the server is not asked', async () => {
  const { fake, page, state, timer } = await opened()
  page.face.edit('BAD text\n')
  await checked({ timer, state })
  const before = fake.calls.length
  await page.face.save()
  assert.equal(fake.calls.length, before, 'no save was made')
  assert.equal(state().notice?.tone, 'error')
  assert.match(state().notice?.text ?? '', /frontmatter: BAD/)
  assert.equal(state().busy, undefined)
  assert.equal(state().dirty, true)
  // Fix it, and it goes.
  page.face.edit('good text\n')
  await checked({ timer, state })
  await page.face.save()
  assert.equal(state().notice?.tone, 'success')
})

test('save while a check is pending runs the check first, then saves', async () => {
  const { fake, page, state, timer } = await opened()
  page.face.edit('quick\n')
  assert.equal(timer.armed, 1)
  const before = fake.calls.length
  await page.face.save()
  assert.deepEqual(fake.calls.slice(before).filter(call => !call.startsWith('skills')), ['check brainstorming', `save brainstorming ${id(0).slice(0, 7)} -`])
  assert.equal(timer.armed, 0, 'the timer is not left to make a second check')
  assert.equal(state().notice?.tone, 'success')
  assert.equal(state().checking, false)
})

test('save while a check is pending is still refused when that check finds a problem', async () => {
  const { fake, page, state, timer } = await opened()
  page.face.edit('BAD quick\n')
  const before = fake.calls.length
  await page.face.save()
  assert.deepEqual(fake.calls.slice(before), ['check brainstorming'])
  assert.equal(timer.armed, 0)
  assert.equal(state().notice?.tone, 'error')
  assert.match(state().notice?.text ?? '', /frontmatter: BAD/)
})

test('save while a check is in flight waits for it', async () => {
  const { fake, page, state, timer } = await opened()
  const slow = gate()
  fake.gates.set('check', slow)
  page.face.edit('BAD in flight\n')
  timer.fire()
  await until('the check to be asked', () => fake.checked.at(-1) === 'BAD in flight\n')
  const before = fake.calls.length
  const saving = page.face.save()
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(fake.calls.length, before, 'it waits; it does not start a second check or a save')
  slow.release()
  await saving
  assert.equal(fake.calls.length, before, 'the answer found a problem')
  assert.match(state().notice?.text ?? '', /frontmatter: BAD/)
})

test('save goes ahead when the check could not be made: the server judges', async () => {
  const { fake, page, state, timer } = await opened()
  fake.checkDown = true
  page.face.edit('whatever\n')
  await checked({ timer, state })
  assert.equal(state().check, null)
  await page.face.save()
  assert.equal(state().notice?.tone, 'success')
  assert.ok(fake.calls.some(call => call.startsWith('save brainstorming')))
})

test('save that hits CONFLICT keeps the draft and puts theirs in conflict', async () => {
  const { fake, page, state, timer } = await opened()
  page.face.edit('mine\n')
  await checked({ timer, state })
  fake.external('brainstorming', 'theirs\n')
  await page.face.save()
  assert.equal(state().draft, 'mine\n')
  assert.equal(state().dirty, true)
  assert.deepEqual(state().conflict, { theirs: 'theirs\n', commit: id(1) })
  assert.equal(state().notice?.tone, 'error')
  assert.match(state().notice?.text ?? '', /changed since you loaded it/)
  assert.deepEqual(state().saved, { text: DEFAULTS.brainstorming, commit: id(0) }, 'saved is still what was loaded')
})

test('while a conflict is open save does nothing: Reload or Keep mine comes first', async () => {
  const { fake, page, state, timer } = await opened()
  page.face.edit('mine\n')
  await checked({ timer, state })
  fake.external('brainstorming', 'theirs\n')
  await page.face.save()
  assert.ok(state().conflict !== undefined)
  const before = fake.calls.length
  await page.face.save()
  assert.equal(fake.calls.length, before, 'no second attempt on the old base')
})

test('Reload after a conflict adopts theirs and drops the draft', async () => {
  const { fake, page, state, timer } = await opened()
  page.face.edit('mine\n')
  await checked({ timer, state })
  fake.external('brainstorming', 'theirs\n')
  await page.face.save()
  await page.face.reload()
  assert.equal(state().conflict, undefined)
  assert.equal(state().draft, 'theirs\n')
  assert.deepEqual(state().saved, { text: 'theirs\n', commit: id(1) })
  assert.equal(state().dirty, false)
})

test('Keep mine after a conflict makes theirs the base, keeps the draft, and the next save goes through', async () => {
  const { fake, page, state, timer } = await opened()
  page.face.edit('mine\n')
  await checked({ timer, state })
  fake.external('brainstorming', 'theirs\n')
  await page.face.save()
  page.face.keepMine()
  assert.equal(state().conflict, undefined)
  assert.equal(state().draft, 'mine\n')
  assert.deepEqual(state().saved, { text: 'theirs\n', commit: id(1) })
  assert.equal(state().dirty, true)
  await page.face.save()
  assert.equal(state().notice?.tone, 'success')
  assert.deepEqual(state().saved, { text: 'mine\n', commit: id(2) })
})

test('a conflict read that an event\'s newer read has overtaken does not overwrite it', async () => {
  const { fake, page, state, timer } = await opened()
  page.face.edit('mine\n')
  await checked({ timer, state })
  fake.external('brainstorming', 'theirs, first\n')
  // The read that fetches "theirs" after the refusal is held.
  const held = gate()
  fake.gates.set('read brainstorming', held)
  const saving = page.face.save()
  await until('the conflict read to be made', () => count(fake.calls, 'read brainstorming') === 2)
  // Meanwhile the document changes again, and the event for that is read without waiting.
  const commit = fake.external('brainstorming', 'theirs, second\n')
  await page.onConfigEvent({ kind: 'changed', commit, paths: [pathOf('brainstorming')] })
  assert.deepEqual(state().conflict, { theirs: 'theirs, second\n', commit })
  held.release()
  await saving
  assert.deepEqual(state().conflict, { theirs: 'theirs, second\n', commit }, 'the older answer was dropped')
})

test('a save while the store is not running says so, and keeps the draft', async () => {
  const { fake, page, state, timer } = await opened()
  fake.up = false
  page.face.edit('x\n')
  await checked({ timer, state })
  await page.face.save()
  assert.equal(state().notice?.tone, 'error')
  assert.match(state().notice?.text ?? '', /config store isn't running/)
  assert.equal(state().draft, 'x\n')
  assert.equal(state().conflict, undefined)
})

test('a read that began before a save does not put the old text back when it lands after it', async () => {
  const { fake, page, state, timer } = await opened()
  const stale = gate()
  fake.gates.set('read brainstorming', stale)
  const refreshing = page.face.open()
  await until('the refresh to read the document', () => count(fake.calls, 'read brainstorming') === 2)
  page.face.edit('NEW\n')
  await checked({ timer, state })
  await page.face.save()
  assert.deepEqual(state().saved, { text: 'NEW\n', commit: id(1) })
  stale.release()
  await refreshing
  assert.deepEqual(state().saved, { text: 'NEW\n', commit: id(1) }, 'neither the text nor the base went back')
  assert.equal(state().draft, 'NEW\n')
  assert.equal(state().dirty, false)
})

test('a save names its skill in the notice, and still does when the page has moved on to another', async () => {
  const { fake, page, state, timer } = await opened()
  page.face.edit('one\n')
  await checked({ timer, state })
  await page.face.save()
  assert.match(state().notice?.text ?? '', /^Saved brainstorming as c1eeeee/)

  const slow = gate()
  fake.gates.set('save answer', slow)
  page.face.edit('two\n')
  await checked({ timer, state })
  const saving = page.face.save()
  await until('the save to be made', () => fake.head === 2)
  await page.face.select('mine')
  await page.face.confirmSwitch()
  slow.release()
  await saving
  assert.equal(state().selected, 'mine')
  assert.match(state().notice?.text ?? '', /^Saved brainstorming as c2eeeee/, 'not mistaken for mine\'s')
  assert.equal(state().saved?.text, MINE, 'mine\'s own text is what the editor has')
  assert.equal(state().dirty, false)
})

test('a refused save for a skill the page has left is said to be about that skill, and does not claim the editor holds its text', async () => {
  const { fake, page, state, timer } = await opened()
  page.face.edit('mine\n')
  await checked({ timer, state })
  fake.external('brainstorming', 'theirs\n')
  const slow = gate()
  fake.gates.set('save answer', slow)
  const saving = page.face.save()
  await until('the save to be refused', () => fake.calls.some(call => call.startsWith('save brainstorming')))
  await page.face.select('mine')
  await page.face.confirmSwitch()
  slow.release()
  await saving
  assert.equal(state().notice?.tone, 'error')
  assert.equal(state().notice?.text, 'Couldn\'t save brainstorming')
  assert.match(state().notice?.detail ?? '', /skills\/brainstorming\/SKILL\.md changed since c0eeeee/, 'the store\'s own words')
  assert.equal(state().conflict, undefined, 'a conflict is for the skill in the editor')
})

test('the Edit tab\'s note goes with a save, and is cleared by it', async () => {
  const { fake, page, state, timer } = await opened()
  page.face.edit('custom\n')
  page.face.setNote('my reason')
  await checked({ timer, state })
  await page.face.save()
  assert.ok(fake.calls.includes(`save brainstorming ${id(0).slice(0, 7)} my reason`), fake.calls.join(', '))
  assert.equal(state().note, '')
})

// --- a new skill -----------------------------------------------------------------------------------

test('startNew opens the template for a valid name: trimmed, unsaved, over the list\'s commit, and checked', async () => {
  const { fake, page, state } = await opened()
  const reads = fake.calls.filter(call => call.startsWith('read ')).length
  assert.equal(await page.face.startNew('  release-notes \n'), true)
  assert.equal(state().selected, 'release-notes')
  assert.equal(state().creating, true)
  assert.equal(state().document, 'ready')
  assert.equal(state().draft, NEW_SKILL_TEMPLATE('release-notes'))
  assert.equal(state().dirty, true, 'nothing is stored yet')
  assert.deepEqual(state().saved, { text: '', commit: id(0) })
  assert.equal(state().shipped, false)
  assert.equal(state().defaultText, '')
  assert.equal(state().missing, false)
  assert.equal(state().tab, 'edit')
  assert.equal(state().notice, undefined)
  assert.equal(fake.calls.filter(call => call.startsWith('read ')).length, reads, 'there is nothing to read')
  assert.equal(fake.checked.at(-1), NEW_SKILL_TEMPLATE('release-notes'))
  assert.equal(state().checking, false)
  assert.notEqual(state().check, null)
  assert.deepEqual(visibleTabs(state()), ['edit'], 'no default and no history for a skill that isn\'t stored')
})

test('startNew refuses a name the grammar does not allow, says why, and changes nothing', async () => {
  const { fake, page, state } = await opened()
  const before = fake.calls.length
  for (const bad of ['', '   ', 'Release', 'two words', '-lead', 'trail-', 'dou--ble', 'x'.repeat(65)]) {
    page.face.dismiss()
    assert.equal(await page.face.startNew(bad), false, JSON.stringify(bad))
    assert.equal(state().notice?.tone, 'error', JSON.stringify(bad))
    assert.match(state().notice?.text ?? '', bad.trim() === '' ? /Give the skill a name/ : /isn't a valid skill name/, JSON.stringify(bad))
    assert.equal(state().selected, 'brainstorming', JSON.stringify(bad))
    assert.equal(state().creating, false)
  }
  assert.equal(fake.calls.length, before)
})

test('startNew refuses a name that is taken, a shipped one and one the store lost included', async () => {
  const { fake, page, state } = await opened()
  assert.equal(await page.face.startNew('mine'), false)
  assert.match(state().notice?.text ?? '', /already a skill called "mine"/)
  page.face.dismiss()
  assert.equal(await page.face.startNew('writing-plans'), false)
  assert.match(state().notice?.text ?? '', /already a skill called "writing-plans"/)

  fake.externalDelete('brainstorming')
  await page.face.open()
  assert.equal(state().skills.find(skill => skill.name === 'brainstorming')?.missing, true, 'the list still has it')
  page.face.dismiss()
  assert.equal(await page.face.startNew('brainstorming'), false)
  assert.match(state().notice?.text ?? '', /already a skill called "brainstorming"/)
  assert.equal(state().creating, false)
})

test('startNew can\'t tell whether a name is taken until the list has loaded, so it refuses', async () => {
  const { fake, page, state } = setup()
  assert.equal(await page.face.startNew('fresh'), false)
  assert.equal(state().notice?.tone, 'error')
  assert.equal(state().creating, false)

  fake.skillsDown = true
  await page.face.open()
  assert.equal(await page.face.startNew('fresh'), false)
  assert.equal(state().creating, false)

  fake.skillsDown = false
  await page.face.open()
  assert.equal(await page.face.startNew('fresh'), true)
  // A list that fails to refresh later is still a list: the names it had are known.
  fake.skillsDown = true
  await page.onConfigEvent({ kind: 'proposal', id: 'abcd1234', status: 'open' })
  assert.notEqual(state().listError, undefined)
  page.face.dismiss()
  assert.equal(await page.face.startNew('other'), true, 'the person has an unsaved skill open: asked first, not refused')
  assert.equal(state().switching?.name, 'other')
})

test('startNew with unsaved edits asks first: confirming opens the template, cancelling keeps the draft', async () => {
  const { page, state } = await opened()
  page.face.edit('half done\n')
  assert.equal(await page.face.startNew('fresh'), true, 'accepted: it is being asked')
  assert.deepEqual(state().switching, { name: 'fresh', create: true })
  assert.equal(state().creating, false)
  assert.equal(state().selected, 'brainstorming')
  page.face.cancelSwitch()
  assert.equal(state().switching, undefined)
  assert.equal(state().draft, 'half done\n')

  await page.face.startNew('fresh')
  await page.face.confirmSwitch()
  assert.equal(state().creating, true)
  assert.equal(state().selected, 'fresh')
  assert.equal(state().draft, NEW_SKILL_TEMPLATE('fresh'))
  assert.equal(state().switching, undefined)
})

test('a bad name with unsaved edits is refused at once, not asked about', async () => {
  const { page, state } = await opened()
  page.face.edit('half done\n')
  assert.equal(await page.face.startNew('Bad Name'), false)
  assert.equal(state().switching, undefined)
  assert.equal(state().notice?.tone, 'error')
  assert.equal(state().draft, 'half done\n')
})

test('saving a new skill writes it over the commit the list was read at, then it is an ordinary skill in the list', async () => {
  const { fake, page, state, timer } = await opened()
  await page.face.startNew('release-notes')
  page.face.edit(`${NEW_SKILL_TEMPLATE('release-notes')}More.\n`)
  page.face.setNote('first draft')
  await checked({ timer, state })
  await page.face.save()
  assert.ok(fake.calls.includes(`save release-notes ${id(0).slice(0, 7)} first draft`), fake.calls.join(', '))
  assert.equal(state().creating, false)
  assert.equal(state().selected, 'release-notes')
  assert.deepEqual(state().saved, { text: `${NEW_SKILL_TEMPLATE('release-notes')}More.\n`, commit: id(1) })
  assert.equal(state().dirty, false)
  assert.match(state().notice?.text ?? '', /^Created release-notes as c1eeeee/)
  assert.ok(names(state()).includes('release-notes'), 'the list was read again')
  assert.equal(state().skills.find(skill => skill.name === 'release-notes')?.shipped, false)
  assert.equal(state().commit, id(1))
  assert.deepEqual(visibleTabs(state()), ['edit', 'history'], 'it has a history now')
})

test('a new skill\'s template saves as it stands: it is valid', async () => {
  const { page, state } = await opened()
  await page.face.startNew('release-notes')
  await page.face.save()
  assert.equal(state().creating, false)
  assert.equal(state().notice?.tone, 'success')
})

test('a new skill that someone else created first is a conflict, and Keep mine then saves over theirs', async () => {
  const { fake, page, state } = await opened()
  await page.face.startNew('release-notes')
  fake.external('release-notes', 'THEIRS\n')
  await page.face.save()
  assert.equal(state().creating, true)
  assert.deepEqual(state().conflict, { theirs: 'THEIRS\n', commit: id(1) })
  assert.equal(state().draft, NEW_SKILL_TEMPLATE('release-notes'))
  page.face.keepMine()
  assert.equal(state().creating, false, 'it exists now')
  assert.deepEqual(state().saved, { text: 'THEIRS\n', commit: id(1) })
  await page.face.save()
  assert.equal(state().notice?.tone, 'success')
  assert.equal(fake.docs.get('release-notes')?.text, NEW_SKILL_TEMPLATE('release-notes'))
})

test('a new skill with no store has the empty base, and saving it is refused by the server', async () => {
  const { fake, page, state } = setup()
  fake.up = false
  await page.face.open()
  assert.equal(await page.face.startNew('fresh'), true)
  assert.equal(state().readOnly, true)
  assert.deepEqual(state().saved, { text: '', commit: '' })
  await page.face.save()
  assert.ok(fake.calls.includes('save fresh - -'), fake.calls.join(', '))
  assert.match(state().notice?.text ?? '', /config store isn't running/)
  assert.equal(state().creating, true, 'the skill is still only a draft')
  assert.equal(state().draft, NEW_SKILL_TEMPLATE('fresh'))
})

test('discard on a new skill goes back to the template; leaving it asks first', async () => {
  const { page, state } = await opened()
  await page.face.startNew('fresh')
  page.face.edit('rewritten\n')
  page.face.discard()
  assert.equal(state().draft, NEW_SKILL_TEMPLATE('fresh'))
  assert.equal(state().creating, true)
  assert.equal(state().dirty, true)
  await page.face.select('mine')
  assert.equal(state().switching?.name, 'mine', 'a skill that was never saved is not thrown away silently')
  await page.face.confirmSwitch()
  assert.equal(state().creating, false)
  assert.equal(state().selected, 'mine')
  assert.equal(state().draft, MINE)
})

test('a live event does not turn a new skill into an error, but a skill someone created under its name is a conflict', async () => {
  const { fake, page, state } = await opened()
  await page.face.startNew('fresh')
  await page.face.open()
  assert.equal(state().creating, true)
  assert.equal(state().document, 'ready')
  assert.equal(state().notice, undefined)
  const commit = fake.external('fresh', 'SOMEONE ELSE\n')
  await page.onConfigEvent({ kind: 'changed', commit, paths: [pathOf('fresh')] })
  assert.deepEqual(state().conflict, { theirs: 'SOMEONE ELSE\n', commit })
  assert.equal(state().draft, NEW_SKILL_TEMPLATE('fresh'))
})

// --- the Default tab and reset ---------------------------------------------------------------------

test('shipped comes from the list: the Default tab is for shipped skills only, and the page goes back to Edit when it is gone', async () => {
  const { page, state } = await opened()
  assert.deepEqual(visibleTabs(state()), ['edit', 'default', 'history'])
  await page.face.setTab('default')
  assert.equal(state().tab, 'default')
  await page.face.select('mine')
  assert.equal(state().shipped, false)
  assert.deepEqual(visibleTabs(state()), ['edit', 'history'])
  assert.equal(state().tab, 'edit')
  await page.face.setTab('default')
  assert.equal(state().tab, 'edit', 'a tab that is not there can\'t be opened')
})

test('a skill the list has not seen is not shipped when its read has no default', async () => {
  const { fake, page, state } = await opened()
  // The list was read before this one existed, so it does not know the skill.
  fake.docs.set('late', { text: 'LATE\n', changedAt: 0 })
  await page.face.select('late')
  assert.equal(state().shipped, false)
  assert.equal(state().defaultText, '')
  assert.deepEqual(visibleTabs(state()), ['edit', 'history'])
})

test('a shipped skill the list has not seen is shipped when its read has a default, and has the Default tab', async () => {
  const { fake, page, state } = await opened()
  // A list read before dish shipped (or the store listed) this skill: the read still carries its default.
  fake.hidden.add('writing-plans')
  await page.face.open()
  assert.equal(state().skills.some(skill => skill.name === 'writing-plans'), false, 'the list does not have it')
  await page.face.select('writing-plans')
  assert.equal(state().selected, 'writing-plans')
  assert.equal(state().shipped, true)
  assert.equal(state().defaultText, DEFAULTS['writing-plans'])
  assert.deepEqual(visibleTabs(state()), ['edit', 'default', 'history'])
  assert.deepEqual(defaultView(state()), { kind: 'same' })
  assert.equal(state().tab, 'edit')
  await page.face.setTab('default')
  assert.equal(state().tab, 'default')
  // And it can be reset, but not deleted.
  page.face.askDelete()
  assert.equal(state().confirm, null)
  page.face.askReset()
  assert.equal(state().confirm, 'reset')
})

test('defaultView: the same text is "same", a different one is a diff from the default to what is saved, and no default is none', async () => {
  const { page, state, timer } = await opened()
  assert.deepEqual(defaultView(state()), { kind: 'same' })

  page.face.edit('BRAIN default\nAnd more.\n')
  await checked({ timer, state })
  await page.face.save()
  const view = defaultView(state())
  assert.equal(view.kind, 'diff')
  if (view.kind === 'diff') {
    assert.equal(view.diff.path, 'skills/brainstorming/SKILL.md')
    assert.equal(view.diff.status, 'modified')
    assert.match(view.diff.patch, /^--- a\/skills\/brainstorming\/SKILL\.md\n\+\+\+ b\/skills\/brainstorming\/SKILL\.md\n@@ /)
    assert.match(view.diff.patch, /\+And more\.\n/)
  }

  await page.face.select('mine')
  assert.deepEqual(defaultView(state()), { kind: 'none' })
})

test('the draft does not change the Default view: it compares what is saved', async () => {
  const { page, state } = await opened()
  page.face.edit('entirely different\n')
  assert.deepEqual(defaultView(state()), { kind: 'same' })
})

test('reset asks first: askReset opens the question, and reset does nothing without it', async () => {
  const { fake, page, state } = await opened()
  const before = fake.calls.length
  await page.face.reset()
  assert.equal(fake.calls.length, before, 'no question, no reset')
  page.face.askReset()
  assert.equal(state().confirm, 'reset')
  page.face.cancelConfirm()
  assert.equal(state().confirm, null)
  await page.face.reset()
  assert.equal(fake.calls.length, before)
})

test('reset writes the default on the commit the page loaded with the standard note, and the editor shows it', async () => {
  const { fake, page, state, timer } = await opened()
  page.face.edit('custom\n')
  await checked({ timer, state })
  await page.face.save()
  page.face.edit('custom\nmore\n')
  page.face.setNote('a note for a save, not for this')
  page.face.askReset()
  await page.face.reset()
  assert.ok(fake.calls.includes(`reset brainstorming ${id(1).slice(0, 7)} ${RESET_NOTE}`), fake.calls.join(', '))
  assert.equal(state().draft, DEFAULTS.brainstorming, 'an unsaved edit is replaced by the default too')
  assert.deepEqual(state().saved, { text: DEFAULTS.brainstorming, commit: id(2) })
  assert.equal(state().dirty, false)
  assert.equal(state().note, '')
  assert.equal(state().confirm, null)
  assert.equal(state().notice?.tone, 'success')
  assert.match(state().notice?.text ?? '', /^Reset brainstorming to the default as c2eeeee/)
  assert.equal(state().skills.find(skill => skill.name === 'brainstorming')?.differsFromDefault, false)
  assert.equal(fake.checked.at(-1), DEFAULTS.brainstorming, 'the default is what is checked now')
})

test('a reset reads no document: it takes the default and the commit from its own answer', async () => {
  const { fake, page, state, timer } = await opened()
  page.face.edit('custom\n')
  await checked({ timer, state })
  await page.face.save()
  page.face.edit('custom\nunsaved\n')
  const reads = count(fake.calls, 'read brainstorming')
  page.face.askReset()
  await page.face.reset()
  assert.equal(count(fake.calls, 'read brainstorming'), reads)
  assert.deepEqual(state().saved, { text: DEFAULTS.brainstorming, commit: id(2) })
  assert.equal(state().draft, DEFAULTS.brainstorming)
  assert.equal(state().missing, false)
})

test('reset of a skill that already is the default says so', async () => {
  const { page, state } = await opened()
  page.face.askReset()
  await page.face.reset()
  assert.equal(state().notice?.tone, 'info')
  assert.match(state().notice?.text ?? '', /Already the default/)
  assert.equal(state().confirm, null)
})

test('a reset that found the document already the default shows the default over an unsaved edit', async () => {
  const { page, state } = await opened()
  page.face.edit('unsaved\n')
  page.face.askReset()
  await page.face.reset()
  assert.match(state().notice?.text ?? '', /Already the default/)
  assert.equal(state().draft, DEFAULTS.brainstorming)
  assert.equal(state().dirty, false)
  assert.equal(state().conflict, undefined)
})

test('reset of a shipped skill the store lost writes it back', async () => {
  const { fake, page, state } = await opened()
  fake.externalDelete('brainstorming')
  await page.face.reload()
  assert.equal(state().missing, true)
  assert.equal(state().skills.length, 3)
  page.face.askReset()
  await page.face.reset()
  assert.equal(state().notice?.tone, 'success')
  assert.equal(state().missing, false)
  assert.equal(fake.docs.get('brainstorming')?.text, DEFAULTS.brainstorming)
})

test('reset that hits CONFLICT keeps the draft, shows theirs and closes the question', async () => {
  const { fake, page, state, timer } = await opened()
  page.face.edit('mine\n')
  await checked({ timer, state })
  fake.external('brainstorming', 'theirs\n')
  page.face.askReset()
  await page.face.reset()
  assert.equal(state().draft, 'mine\n')
  assert.deepEqual(state().conflict, { theirs: 'theirs\n', commit: id(1) })
  assert.equal(state().notice?.tone, 'error')
  assert.equal(state().confirm, null)
})

test('a skill you added can\'t be reset: the question is not asked, and the page says why', async () => {
  const { fake, page, state } = await opened()
  await page.face.select('mine')
  const before = fake.calls.length
  page.face.askReset()
  assert.equal(state().confirm, null)
  assert.equal(state().notice?.tone, 'error')
  assert.match(state().notice?.text ?? '', /no shipped default/)
  await page.face.reset()
  assert.equal(fake.calls.length, before)
})

test('a new skill can\'t be reset or deleted: it is not stored', async () => {
  const { fake, page, state } = await opened()
  await page.face.startNew('fresh')
  const before = fake.calls.length
  page.face.askReset()
  page.face.askDelete()
  assert.equal(state().confirm, null)
  assert.equal(fake.calls.length, before)
})

// --- delete ----------------------------------------------------------------------------------------

test('delete asks first: askDelete opens the question, and remove does nothing without it', async () => {
  const { fake, page, state } = await opened()
  await page.face.select('mine')
  const before = fake.calls.length
  await page.face.remove()
  assert.equal(fake.calls.length, before)
  page.face.askDelete()
  assert.equal(state().confirm, 'delete')
  page.face.cancelConfirm()
  assert.equal(state().confirm, null)
  await page.face.remove()
  assert.equal(fake.calls.length, before)
})

test('remove deletes the skill on the commit the page loaded, then nothing is selected and the list is read again', async () => {
  const { fake, page, state } = await opened()
  await page.face.select('mine')
  page.face.askDelete()
  const listsBefore = count(fake.calls, 'skills')
  await page.face.remove()
  assert.ok(fake.calls.includes(`remove mine ${id(0).slice(0, 7)} -`), fake.calls.join(', '))
  assert.equal(fake.docs.has('mine'), false)
  assert.equal(state().selected, undefined)
  assert.equal(state().document, 'idle')
  assert.equal(state().saved, undefined)
  assert.equal(state().draft, '')
  assert.equal(state().dirty, false)
  assert.equal(state().confirm, null)
  assert.equal(state().check, null)
  assert.equal(state().tab, 'edit')
  assert.equal(state().notice?.tone, 'success')
  assert.match(state().notice?.text ?? '', /^Deleted mine as c1eeeee/)
  assert.equal(count(fake.calls, 'skills'), listsBefore + 1)
  assert.deepEqual(names(state()), ['brainstorming', 'writing-plans'])
  assert.equal(state().busy, undefined)
})

test('remove replaces an unsaved edit of that skill too: the question was the warning', async () => {
  const { page, state } = await opened()
  await page.face.select('mine')
  page.face.edit('edited, then deleted\n')
  page.face.askDelete()
  await page.face.remove()
  assert.equal(state().selected, undefined)
  assert.equal(state().notice?.tone, 'success')
})

test('delete is refused for a shipped skill: no question, no call, and a notice that says what to do instead', async () => {
  const { fake, page, state } = await opened()
  const before = fake.calls.length
  page.face.askDelete()
  assert.equal(state().confirm, null)
  assert.equal(state().notice?.tone, 'error')
  assert.match(state().notice?.text ?? '', /shipped skill can't be deleted/)
  assert.match(state().notice?.text ?? '', /roles: \[\]/)
  await page.face.remove()
  assert.equal(fake.calls.length, before)
})

test('a delete the server refuses leaves the skill selected, with its draft, and closes the question', async () => {
  const { fake, page, state } = await opened()
  await page.face.select('mine')
  page.face.edit('mine, edited\n')
  fake.external('mine', 'theirs\n')
  page.face.askDelete()
  await page.face.remove()
  assert.equal(state().selected, 'mine')
  assert.equal(state().draft, 'mine, edited\n')
  assert.equal(state().confirm, null)
  assert.equal(state().notice?.tone, 'error')
  assert.match(state().notice?.text ?? '', /changed since you loaded it, so it wasn't deleted/)
  assert.equal(state().busy, undefined)
  assert.equal(fake.docs.has('mine'), true)
})

test('a delete while the store is not running says so', async () => {
  const { fake, page, state } = await opened()
  await page.face.select('mine')
  fake.up = false
  page.face.askDelete()
  await page.face.remove()
  assert.match(state().notice?.text ?? '', /config store isn't running/)
  assert.equal(state().selected, 'mine')
})

test('an event for a skill deleted elsewhere closes a clean page, with the list read again', async () => {
  const { fake, page, state } = await opened()
  await page.face.select('mine')
  const commit = fake.externalDelete('mine')
  await page.onConfigEvent({ kind: 'changed', commit, paths: [pathOf('mine')] })
  assert.equal(state().selected, undefined)
  assert.equal(state().document, 'idle')
  assert.equal(state().notice?.tone, 'info')
  assert.match(state().notice?.text ?? '', /mine was deleted elsewhere/)
  assert.deepEqual(names(state()), ['brainstorming', 'writing-plans'])
})

test('a draft of a skill deleted elsewhere becomes a new skill that Save creates again (live event)', async () => {
  const { fake, page, state, timer } = await opened()
  await page.face.select('mine')
  page.face.edit('my edit\n')
  page.face.setNote('why')
  const commit = fake.externalDelete('mine')
  await page.onConfigEvent({ kind: 'changed', commit, paths: [pathOf('mine')] })
  assert.equal(state().selected, 'mine')
  assert.equal(state().creating, true)
  assert.deepEqual(state().saved, { text: '', commit })
  assert.equal(state().draft, 'my edit\n')
  assert.equal(state().note, 'why')
  assert.equal(state().dirty, true)
  assert.equal(state().shipped, false)
  assert.equal(state().defaultText, '')
  assert.equal(state().missing, false)
  assert.equal(state().conflict, undefined)
  assert.equal(state().notice?.tone, 'info')
  assert.match(state().notice?.text ?? '', /mine was deleted elsewhere; Save creates it again/)
  assert.deepEqual(names(state()), ['brainstorming', 'writing-plans'], 'the list no longer has it')
  assert.deepEqual(visibleTabs(state()), ['edit'])
  assert.equal(state().history, undefined)

  await checked({ timer, state })
  await page.face.save()
  assert.ok(fake.calls.includes(`save mine ${commit.slice(0, 7)} why`), fake.calls.join(', '))
  assert.equal(state().creating, false)
  assert.equal(state().dirty, false)
  assert.match(state().notice?.text ?? '', /^Created mine as /)
  assert.equal(fake.docs.get('mine')?.text, 'my edit\n')
  assert.ok(names(state()).includes('mine'))
})

test('a draft of a skill deleted elsewhere becomes a new skill when its Save is the first to find out (no stream)', async () => {
  const { fake, page, state, timer } = await opened({ config: false })
  await page.face.select('mine')
  page.face.edit('my edit\n')
  await checked({ timer, state })
  fake.externalDelete('mine')
  await page.face.save()
  // The store refused the save on the old commit, as a conflict with the deletion; the read of "theirs" found nothing.
  assert.ok(fake.calls.includes(`save mine ${id(0).slice(0, 7)} -`), fake.calls.join(', '))
  assert.equal(state().selected, 'mine')
  assert.equal(state().creating, true)
  assert.deepEqual(state().saved, { text: '', commit: id(1) })
  assert.equal(state().conflict, undefined, 'there is no "theirs" to show')
  assert.equal(state().draft, 'my edit\n')
  assert.equal(state().notice?.tone, 'info')
  assert.match(state().notice?.text ?? '', /mine was deleted elsewhere; Save creates it again/)
  assert.equal(state().busy, undefined)

  await page.face.save()
  assert.ok(fake.calls.includes(`save mine ${id(1).slice(0, 7)} -`), fake.calls.join(', '))
  assert.equal(state().creating, false)
  assert.match(state().notice?.text ?? '', /^Created mine as /)
  assert.equal(fake.docs.get('mine')?.text, 'my edit\n')
})

test('a clean page finds a skill deleted elsewhere by opening or reloading, and closes it (no stream)', async () => {
  for (const how of ['open', 'reload'] as const) {
    const { fake, page, state } = await opened({ config: false })
    await page.face.select('mine')
    fake.externalDelete('mine')
    await (how === 'open' ? page.face.open() : page.face.reload())
    assert.equal(state().selected, undefined, how)
    assert.match(state().notice?.text ?? '', /mine was deleted elsewhere/, how)
  }
})

test('a Reload that finds the skill deleted turns a draft into a new skill, too', async () => {
  const { fake, page, state } = await opened({ config: false })
  await page.face.select('mine')
  page.face.edit('my edit\n')
  fake.externalDelete('mine')
  await page.face.reload()
  assert.equal(state().creating, true)
  assert.equal(state().draft, 'my edit\n')
  assert.deepEqual(state().saved, { text: '', commit: id(1) })
})

test('a skill that was deleted and has come back is left alone: the next save is a conflict that shows what is there', async () => {
  const { fake, page, state, timer } = await opened()
  await page.face.select('mine')
  page.face.edit('my edit\n')
  await checked({ timer, state })
  const commit = fake.externalDelete('mine')
  // The list is read after the document is found missing, and by then somebody has written the skill again.
  const held = gate()
  fake.gates.set('skills', held)
  const event = page.onConfigEvent({ kind: 'changed', commit, paths: [pathOf('mine')] })
  await until('the document to be found missing', () => count(fake.calls, 'read mine') === 2)
  fake.external('mine', 'WRITTEN AGAIN\n')
  held.release()
  await event
  assert.equal(state().creating, false, 'it exists: it is not turned into a new skill over somebody else\'s')
  assert.equal(state().selected, 'mine')
  assert.equal(state().draft, 'my edit\n')
  await page.face.save()
  assert.deepEqual(state().conflict, { theirs: 'WRITTEN AGAIN\n', commit: id(2) })
  assert.equal(fake.docs.get('mine')?.text, 'WRITTEN AGAIN\n', 'nothing was overwritten')
})

test('a skill you added that can\'t be read while the store is down is not "deleted elsewhere"', async () => {
  for (const edit of [false, true]) {
    const { fake, page, state } = await opened()
    await page.face.select('mine')
    if (edit) page.face.edit('my edit\n')
    fake.up = false
    await page.onConfigEvent({ kind: 'changed', commit: id(1), paths: [pathOf('mine')] })
    assert.equal(state().selected, 'mine', `edit ${edit}`)
    assert.equal(state().creating, false, `edit ${edit}`)
    assert.equal(state().draft, edit ? 'my edit\n' : MINE, `edit ${edit}`)
    assert.equal(state().notice?.tone, 'error', `edit ${edit}`)
    assert.match(state().notice?.text ?? '', /config store isn't running/, `edit ${edit}`)
    assert.doesNotMatch(state().notice?.text ?? '', /deleted/, `edit ${edit}`)
    assert.equal(state().readOnly, true, `edit ${edit}`)
  }
})

test('a page whose list could not be read can\'t tell a deleted skill from one it can\'t reach, and changes nothing', async () => {
  const { fake, page, state } = await opened()
  await page.face.select('mine')
  page.face.edit('my edit\n')
  fake.externalDelete('mine')
  fake.skillsDown = true
  await page.face.open()
  assert.equal(state().creating, false)
  assert.equal(state().draft, 'my edit\n')
  assert.notEqual(state().listError, undefined)
})

// --- a store that appears under a draft ------------------------------------------------------------

test('a store that appears while the draft has edits, with the text the page loaded, gives it a commit to save over', async () => {
  const { fake, page, state, timer } = setup()
  fake.up = false
  await page.face.open()
  assert.equal(state().readOnly, true)
  assert.equal(state().saved?.commit, '')
  page.face.edit('BRAIN, edited\n')
  await checked({ timer, state })
  // The store starts, holding what the page showed (the shipped default), and some commits besides.
  fake.up = true
  fake.head = 3
  await page.onConfigEvent({ kind: 'remote', status: { pending: 0 } }, true)
  assert.equal(state().readOnly, false)
  assert.deepEqual(state().saved, { text: DEFAULTS.brainstorming, commit: id(3) })
  assert.equal(state().draft, 'BRAIN, edited\n')
  assert.equal(state().conflict, undefined)
  await page.face.save()
  assert.ok(fake.calls.includes(`save brainstorming ${id(3).slice(0, 7)} -`), `saved over the new commit, not over nothing: ${fake.calls.join(', ')}`)
  assert.equal(state().notice?.tone, 'success')
})

test('a store that appears while the draft has edits is not taken for savable by the list alone', async () => {
  const { fake, page, state } = setup()
  fake.up = false
  await page.face.open()
  page.face.edit('BRAIN, edited\n')
  fake.up = true
  await page.onConfigEvent({ kind: 'proposal', id: 'abcd1234', status: 'open' })
  assert.equal(state().commit, id(0), 'the list knows the store')
  assert.equal(state().readOnly, true, 'the document does not yet: it has no commit')
  assert.equal(state().saved?.commit, '')
})

test('a new skill started while the store was down follows the store\'s arrival: its base becomes the list\'s commit', async () => {
  const { fake, page, state, timer } = setup()
  fake.up = false
  await page.face.open()
  assert.equal(await page.face.startNew('fresh'), true)
  assert.equal(state().readOnly, true)
  assert.deepEqual(state().saved, { text: '', commit: '' })
  // The store starts. A not-yet-stored skill can't be read, so only the list can tell the page.
  fake.up = true
  fake.head = 2
  await page.onConfigEvent({ kind: 'proposal', id: 'abcd1234', status: 'open' })
  assert.equal(state().commit, id(2))
  assert.equal(state().readOnly, false)
  assert.deepEqual(state().saved, { text: '', commit: id(2) })
  assert.equal(state().creating, true)
  assert.equal(state().draft, NEW_SKILL_TEMPLATE('fresh'))
  assert.equal(state().conflict, undefined)
  await page.face.save()
  assert.ok(fake.calls.includes(`save fresh ${id(2).slice(0, 7)} -`), `saved over the store's commit, not over nothing: ${fake.calls.join(', ')}`)
  assert.equal(state().creating, false)
  assert.match(state().notice?.text ?? '', /^Created fresh as /)
})

test('a new skill whose name the store turns out to hold already is a conflict, not a write over it', async () => {
  const { fake, page, state } = setup()
  fake.up = false
  await page.face.open()
  await page.face.startNew('fresh')
  fake.up = true
  fake.docs.set('fresh', { text: 'THEIRS\n', changedAt: 1 })
  fake.head = 1
  await page.onConfigEvent({ kind: 'proposal', id: 'abcd1234', status: 'open' })
  assert.deepEqual(state().conflict, { theirs: 'THEIRS\n', commit: id(1) })
  assert.equal(state().draft, NEW_SKILL_TEMPLATE('fresh'))
  assert.deepEqual(state().saved, { text: '', commit: '' }, 'not rebased over a skill it has not seen')
  const before = fake.calls.length
  await page.face.save()
  assert.equal(fake.calls.length, before, 'no save while the conflict is open')
  page.face.keepMine()
  assert.equal(state().creating, false)
  await page.face.save()
  assert.ok(fake.calls.includes(`save fresh ${id(1).slice(0, 7)} -`), fake.calls.join(', '))
  assert.equal(fake.docs.get('fresh')?.text, NEW_SKILL_TEMPLATE('fresh'))
})

// --- the History tab -------------------------------------------------------------------------------

test('the History tab loads this document\'s log, 20 at a time, with the newest page first', async () => {
  const { config, page, state } = await opened()
  config!.log = [commitOf(3, [pathOf('brainstorming')], 'tighter'), commitOf(1, [pathOf('brainstorming')])]
  await page.face.setTab('history')
  assert.deepEqual(config!.calls, ['history skills/brainstorming/SKILL.md 20 -'])
  assert.equal(state().history?.status, 'ready')
  assert.deepEqual(state().history?.commits.map(commit => commit.id), [id(3), id(1)])
  assert.equal(state().history?.more, false)
})

test('a full page offers more, and loadMoreHistory asks for the page below the last commit', async () => {
  const { config, page, state } = await opened()
  config!.log = Array.from({ length: 25 }, (_, index) => commitOf(30 - index, [pathOf('brainstorming')]))
  await page.face.setTab('history')
  assert.equal(state().history?.commits.length, 20)
  assert.equal(state().history?.more, true)
  await page.face.loadMoreHistory()
  assert.deepEqual(config!.calls.at(-1), `history skills/brainstorming/SKILL.md 20 ${id(11).slice(0, 7)}`)
  assert.equal(state().history?.commits.length, 25)
  assert.equal(state().history?.more, false, 'the last page was short')
  assert.equal(state().history?.loadingMore, false)
  const asked = config!.calls.length
  await page.face.loadMoreHistory()
  assert.equal(config!.calls.length, asked, 'nothing more to ask for')
})

test('a page of more that fails keeps what is shown, and says so', async () => {
  const { config, page, state } = await opened()
  config!.log = Array.from({ length: 25 }, (_, index) => commitOf(30 - index, [pathOf('brainstorming')]))
  await page.face.setTab('history')
  config!.down = true
  await page.face.loadMoreHistory()
  assert.equal(state().history?.commits.length, 20)
  assert.equal(state().history?.more, true)
  assert.equal(state().history?.loadingMore, false)
  assert.equal(state().history?.error?.text, 'Something went wrong talking to dish-config')
})

test('a page of more that arrives after the page moved to another skill is dropped', async () => {
  const { config, page, state } = await opened()
  config!.log = [
    ...Array.from({ length: 25 }, (_, index) => commitOf(60 - index, [pathOf('brainstorming')])),
    commitOf(1, [pathOf('mine')]),
  ]
  await page.face.setTab('history')
  const held = new Promise<void>((resolve) => { setTimeout(resolve, 20) })
  const api = config!.api
  const original = api.history
  api.history = async (...args) => { await held; return original(...args) }
  const more = page.face.loadMoreHistory()
  await page.face.select('mine')
  await more
  assert.equal(state().selected, 'mine')
  assert.deepEqual(state().history?.commits.map(commit => commit.id), [id(1)], 'brainstorming\'s page is not mine\'s')
  api.history = original
})

test('a commit\'s diff is fetched when asked for, once', async () => {
  const { config, page, state } = await opened()
  config!.log = [commitOf(3, [pathOf('brainstorming')])]
  await page.face.setTab('history')
  await page.face.loadCommit(id(3))
  await page.face.loadCommit(id(3))
  assert.equal(config!.calls.filter(call => call.startsWith('commit ')).length, 1)
  const detail = state().history?.details[id(3)]
  assert.equal(detail?.status, 'ready')
  assert.equal(detail?.status === 'ready' ? detail.diffs[0]?.path : undefined, 'skills/brainstorming/SKILL.md')
})

test('a commit that can\'t be read has an error of its own', async () => {
  const { page, state } = await opened()
  await page.face.setTab('history')
  await page.face.loadCommit(id(7))
  assert.equal(state().history?.details[id(7)]?.status, 'error')
})

test('revert undoes a commit with a new one, then reads again the log, the list and the document', async () => {
  const { fake, config, page, state } = await opened()
  config!.log = [commitOf(1, [pathOf('brainstorming')])]
  config!.reverts = [commitOf(2, [pathOf('brainstorming')])]
  await page.face.setTab('history')
  const listsBefore = count(fake.calls, 'skills')
  const readsBefore = count(fake.calls, 'read brainstorming')
  await page.face.revert(id(1))
  assert.ok(config!.calls.includes(`revert ${id(1)}`))
  assert.equal(state().notice?.tone, 'success')
  assert.match(state().notice?.text ?? '', /c1eeeee/)
  assert.match(state().notice?.text ?? '', /c2eeeee/)
  assert.equal(config!.calls.filter(call => call.startsWith('history')).length, 2, 'the log was read again')
  assert.equal(count(fake.calls, 'skills'), listsBefore + 1)
  assert.equal(count(fake.calls, 'read brainstorming'), readsBefore + 1)
  assert.equal(state().busy, undefined)
})

test('revert that finds nothing left to undo says "Already reverted"', async () => {
  const { config, page, state } = await opened()
  config!.log = [commitOf(1, [pathOf('brainstorming')])]
  config!.reverts = [null]
  await page.face.setTab('history')
  await page.face.revert(id(1))
  assert.equal(state().notice?.tone, 'info')
  assert.match(state().notice?.text ?? '', /^Already reverted/)
})

test('revert that hits CONFLICT says to revert the later change first', async () => {
  const { config, page, state } = await opened()
  config!.log = [commitOf(1, [pathOf('brainstorming')])]
  config!.reverts = ['conflict']
  await page.face.setTab('history')
  await page.face.revert(id(1))
  assert.equal(state().notice?.tone, 'error')
  assert.match(state().notice?.text ?? '', /later change/)
})

test('an event for the selected path reads the open history again', async () => {
  const { config, page } = await opened()
  config!.log = [commitOf(1, [pathOf('brainstorming')])]
  await page.face.setTab('history')
  config!.log = [commitOf(2, [pathOf('brainstorming')]), commitOf(1, [pathOf('brainstorming')])]
  await page.onConfigEvent({ kind: 'changed', commit: id(2), paths: [pathOf('brainstorming')] })
  assert.equal(config!.calls.filter(call => call.startsWith('history')).length, 2)
  assert.equal(page.getState().history?.commits.length, 2)
})

test('the history is dropped when the page moves to another skill, and loaded for the new one when its tab is open', async () => {
  const { config, page, state } = await opened()
  config!.log = [commitOf(1, [pathOf('brainstorming')]), commitOf(2, [pathOf('mine')])]
  await page.face.setTab('history')
  await page.face.select('mine')
  assert.equal(state().tab, 'history')
  assert.deepEqual(state().history?.commits.map(commit => commit.id), [id(2)])
})

// --- no dish-config --------------------------------------------------------------------------------

test('without a config remote the History tab is hidden, opening it does nothing, and live updates are off', async () => {
  const { page, state } = await opened({ config: false })
  assert.equal(state().hasHistory, false)
  assert.equal(state().stream, 'off')
  assert.deepEqual(visibleTabs(state()), ['edit', 'default'])
  await page.face.setTab('history')
  assert.equal(state().tab, 'edit')
  await page.face.loadHistory()
  assert.equal(state().history, undefined)
  await page.face.loadMoreHistory()
  await page.face.revert(id(1))
  assert.equal(state().notice, undefined)
})

test('a config remote that arrives later turns History and live updates on, and one that goes turns them off', async () => {
  const { page, state } = await opened({ config: false })
  const config = new FakeConfig()
  config.log = [commitOf(1, [pathOf('brainstorming')])]
  page.setConfig(config.api)
  assert.equal(state().hasHistory, true)
  assert.equal(state().stream, 'connecting')
  assert.deepEqual(visibleTabs(state()), ['edit', 'default', 'history'])
  await page.face.setTab('history')
  assert.equal(state().history?.commits.length, 1)

  page.setConfig(undefined)
  assert.equal(state().hasHistory, false)
  assert.equal(state().stream, 'off')
  assert.equal(state().tab, 'edit', 'the open History tab goes back to Edit')
  assert.equal(state().history, undefined)
})

// --- live events -----------------------------------------------------------------------------------

test('a change to the selected path while clean reloads the document, and checks it', async () => {
  const { fake, page, state } = await opened()
  const commit = fake.external('brainstorming', 'edited elsewhere\n')
  await page.onConfigEvent({ kind: 'changed', commit, paths: [pathOf('brainstorming')] })
  assert.equal(state().draft, 'edited elsewhere\n')
  assert.deepEqual(state().saved, { text: 'edited elsewhere\n', commit: id(1) })
  assert.equal(state().conflict, undefined)
  assert.equal(state().dirty, false)
  assert.equal(fake.checked.at(-1), 'edited elsewhere\n')
})

test('a change to the selected path while dirty sets conflict and keeps the draft', async () => {
  const { fake, page, state } = await opened()
  page.face.edit('my edit\n')
  const commit = fake.external('brainstorming', 'edited elsewhere\n')
  await page.onConfigEvent({ kind: 'changed', commit, paths: [pathOf('brainstorming')] })
  assert.equal(state().draft, 'my edit\n')
  assert.deepEqual(state().conflict, { theirs: 'edited elsewhere\n', commit: id(1) })
  assert.equal(state().saved?.text, DEFAULTS.brainstorming)
})

test('the echo of this page\'s own save is no conflict, even with a new edit under way', async () => {
  const { page, state, timer } = await opened()
  page.face.edit('one\n')
  await checked({ timer, state })
  await page.face.save()
  page.face.edit('one\ntwo\n')
  await page.onConfigEvent({ kind: 'changed', commit: id(1), paths: [pathOf('brainstorming')] })
  assert.equal(state().conflict, undefined)
  assert.equal(state().draft, 'one\ntwo\n')
  assert.equal(state().dirty, true)
})

test('a change to another skill leaves the document alone and refreshes the list; one to no skill does nothing', async () => {
  const { fake, page, state } = await opened()
  page.face.edit('my edit\n')
  const commit = fake.external('writing-plans', 'changed plans\n')
  const before = fake.calls.length
  await page.onConfigEvent({ kind: 'changed', commit, paths: [pathOf('writing-plans')] })
  assert.equal(state().conflict, undefined)
  assert.equal(state().draft, 'my edit\n')
  assert.equal(state().skills.find(skill => skill.name === 'writing-plans')?.differsFromDefault, true)
  assert.ok(fake.calls.slice(before).includes('skills'))
  assert.equal(fake.calls.slice(before).some(call => call.startsWith('read ')), false, 'no document was read')

  const after = fake.calls.length
  await page.onConfigEvent({ kind: 'changed', commit: id(9), paths: ['prompts/main.md', 'crew.yaml'] })
  assert.equal(fake.calls.length, after, 'not a skill: nothing was asked')
})

test('a new skill someone else adds appears in the list', async () => {
  const { fake, page, state } = await opened()
  const commit = fake.external('from-an-agent', 'AGENT\n')
  await page.onConfigEvent({ kind: 'changed', commit, paths: [pathOf('from-an-agent')] })
  assert.ok(names(state()).includes('from-an-agent'))
  assert.equal(state().selected, 'brainstorming')
})

test('a proposal event refreshes the pending counts', async () => {
  const { fake, page, state } = await opened()
  assert.equal(state().skills.find(skill => skill.name === 'brainstorming')?.pendingProposals, 0)
  fake.pending.brainstorming = 2
  await page.onConfigEvent({ kind: 'proposal', id: 'abcd1234', status: 'open' })
  assert.equal(state().skills.find(skill => skill.name === 'brainstorming')?.pendingProposals, 2)
})

test('the first event of a stream reads again what the page has, and a remote status event is ignored', async () => {
  const { fake, page, state } = await opened()
  fake.external('brainstorming', 'changed while the stream was down\n')
  const before = fake.calls.length
  await page.onConfigEvent({ kind: 'remote', status: { pending: 0 } }, false)
  assert.equal(fake.calls.length, before)
  await page.onConfigEvent({ kind: 'remote', status: { pending: 0 } }, true)
  assert.equal(state().stream, 'live')
  assert.equal(state().draft, 'changed while the stream was down\n')
  page.streamDown()
  assert.equal(state().stream, 'down')
})

test('each kind of config event does what its kind says, and no more', async () => {
  const { fake, page } = await opened()
  const events: Array<[ConfigEvent, string[]]> = [
    // A commit to the selected skill: the list, and the document itself. The text is the one already checked, so it isn't again.
    [{ kind: 'changed', commit: id(1), paths: [pathOf('brainstorming')] }, ['skills', 'read brainstorming']],
    // A commit to another skill: the list only.
    [{ kind: 'changed', commit: id(2), paths: [pathOf('mine')] }, ['skills']],
    // Commits that are no skill's: nothing.
    [{ kind: 'changed', commit: id(3), paths: ['crew.yaml', 'prompts/main.md'] }, []],
    // A proposal: the list, for its counts.
    [{ kind: 'proposal', id: 'abcd1234', status: 'open' }, ['skills']],
    // The remote's own status is the History page's business.
    [{ kind: 'remote', status: { pending: 1, lastError: 'no route' } }, []],
  ]
  for (const [event, expected] of events) {
    const before = fake.calls.length
    await page.onConfigEvent(event)
    assert.deepEqual(fake.calls.slice(before).sort(), [...expected].sort(), JSON.stringify(event))
  }
})

// --- races -----------------------------------------------------------------------------------------

test('the History tab loads when an event beat the skill\'s first read to it', async () => {
  const { fake, config, page, state } = await opened()
  config!.log = [commitOf(1, [pathOf('mine')])]
  await page.face.setTab('history')
  const slow = gate()
  fake.gates.set('read mine', slow)
  const choosing = page.face.select('mine')
  const commit = fake.external('mine', 'edited elsewhere\n')
  await page.onConfigEvent({ kind: 'changed', commit, paths: [pathOf('mine')] })
  slow.release()
  await choosing
  assert.equal(state().selected, 'mine')
  assert.equal(state().draft, 'edited elsewhere\n')
  assert.equal(state().history?.status, 'ready', 'not left on "Loading…"')
  assert.ok(config!.calls.includes('history skills/mine/SKILL.md 20 -'), config!.calls.join(', '))
})

test('the History tab loads when a refresh or a reload took the skill\'s first read over', async () => {
  for (const takeOver of ['open', 'reload'] as const) {
    const { fake, config, page, state } = await opened()
    config!.log = [commitOf(1, [pathOf('mine')])]
    await page.face.setTab('history')
    const slow = gate()
    fake.gates.set('read mine', slow)
    const choosing = page.face.select('mine')
    await until('mine to be read', () => fake.calls.includes('read mine'))
    await (takeOver === 'open' ? page.face.open() : page.face.reload())
    slow.release()
    await choosing
    assert.equal(state().history?.status, 'ready', takeOver)
    assert.deepEqual(state().history?.commits.map(commit => commit.id), [id(1)], takeOver)
  }
})

test('a reset whose answer comes after the page moved to another skill leaves that skill\'s held event to be read', async () => {
  const { fake, page, state, timer } = await opened()
  page.face.edit('brainstorming, edited\n')
  await checked({ timer, state })
  await page.face.save()
  const slow = gate()
  fake.gates.set('reset', slow)
  page.face.askReset()
  const resetting = page.face.reset()
  await until('the reset to be asked for', () => fake.calls.some(call => call.startsWith('reset brainstorming')))
  await page.face.select('mine')
  assert.equal(state().selected, 'mine')
  // An agent edits mine while brainstorming's reset is under way: the event waits for the reset to end.
  const commit = fake.external('mine', 'written by an agent\n')
  await page.onConfigEvent({ kind: 'changed', commit, paths: [pathOf('mine')] })
  assert.equal(state().draft, MINE, 'held, not read yet')
  slow.release()
  await resetting
  assert.equal(state().selected, 'mine')
  assert.equal(state().draft, 'written by an agent\n', 'the held event was read after the reset')
  assert.deepEqual(state().saved, { text: 'written by an agent\n', commit: id(fake.head) })
})

test('the echo of a reset, arriving as soon as its answer has, is no conflict with the edit the reset replaced', async () => {
  const { fake, page, state, timer } = await opened()
  page.face.edit('custom\n')
  await checked({ timer, state })
  await page.face.save()
  page.face.edit('custom\nunsaved\n')
  const held = gate()
  fake.gates.set('read brainstorming', held)
  page.face.askReset()
  const resetting = page.face.reset()
  await until('the reset to have its answer', () => fake.calls.some(call => call.startsWith('reset brainstorming')) && state().busy === undefined)
  const echo = page.onConfigEvent({ kind: 'changed', commit: id(2), paths: [pathOf('brainstorming')] })
  held.release()
  await Promise.all([resetting, echo])
  assert.equal(state().conflict, undefined, 'the person\'s own reset is not "changed while you were editing"')
  assert.equal(state().draft, DEFAULTS.brainstorming)
  assert.equal(state().dirty, false)
  assert.deepEqual(state().saved, { text: DEFAULTS.brainstorming, commit: id(2) })
})

test('the echo of a delete, arriving before its answer, waits for it and does not make an error of the skill that is going', async () => {
  const { fake, page, state } = await opened()
  await page.face.select('mine')
  const slow = gate()
  fake.gates.set('remove answer', slow)
  page.face.askDelete()
  const removing = page.face.remove()
  await until('the store to have deleted it', () => !fake.docs.has('mine'))
  // The store has committed and said so, and the answer to the delete is still on its way.
  const before = fake.calls.length
  await page.onConfigEvent({ kind: 'changed', commit: id(1), paths: [pathOf('mine')] })
  assert.equal(state().busy, 'delete', 'the delete is still under way')
  assert.equal(state().selected, 'mine')
  assert.equal(fake.calls.slice(before).some(call => call === 'read mine'), false, 'the event waits: no read of the document')
  assert.equal(state().notice, undefined)
  slow.release()
  await removing
  assert.equal(state().busy, undefined)
  assert.equal(state().selected, undefined)
  assert.equal(state().notice?.tone, 'success', 'the delete\'s own notice, not "was deleted elsewhere"')
  assert.match(state().notice?.text ?? '', /^Deleted mine/)
  assert.equal(fake.calls.slice(before).some(call => call === 'read mine'), false, 'nothing is selected to read')
})

test('a delete that finds the skill already gone closes it with a notice, whatever the draft says', async () => {
  for (const edit of [false, true]) {
    const { fake, page, state } = await opened()
    await page.face.select('mine')
    if (edit) page.face.edit('my edit\n')
    page.face.askDelete()
    fake.externalDelete('mine')
    await page.face.remove()
    assert.equal(state().selected, undefined, `edit ${edit}`)
    assert.equal(state().creating, false, `edit ${edit}: the person was deleting it, not keeping it`)
    assert.equal(state().notice?.tone, 'info', `edit ${edit}`)
    assert.match(state().notice?.text ?? '', /mine was deleted already/, `edit ${edit}`)
    assert.equal(state().confirm, null, `edit ${edit}`)
    assert.equal(state().busy, undefined, `edit ${edit}`)
    assert.deepEqual(names(state()), ['brainstorming', 'writing-plans'], `edit ${edit}`)
  }
})

test('Reload is not undone by a live event that arrives while it reads', async () => {
  const { fake, page, state } = await opened()
  page.face.edit('mine\n')
  const commit = fake.external('brainstorming', 'theirs\n')
  await page.onConfigEvent({ kind: 'changed', commit, paths: [pathOf('brainstorming')] })
  assert.ok(state().conflict !== undefined)
  const slow = gate()
  fake.gates.set('read brainstorming', slow)
  const reloading = page.face.reload()
  assert.equal(state().conflict, undefined, 'the draft is dropped at once')
  assert.equal(state().dirty, false)
  await page.onConfigEvent({ kind: 'changed', commit, paths: [pathOf('brainstorming')] })
  slow.release()
  await reloading
  assert.equal(state().conflict, undefined)
  assert.equal(state().draft, 'theirs\n')
  assert.deepEqual(state().saved, { text: 'theirs\n', commit: id(1) })
  assert.equal(state().dirty, false)
})

test('a Reload that could not read gives the person\'s edit and the conflict back', async () => {
  const { fake, page, state } = await opened()
  page.face.edit('mine\n')
  page.face.setNote('because')
  const commit = fake.external('brainstorming', 'theirs\n')
  await page.onConfigEvent({ kind: 'changed', commit, paths: [pathOf('brainstorming')] })
  fake.readDown = true
  await page.face.reload()
  assert.equal(state().draft, 'mine\n')
  assert.equal(state().note, 'because')
  assert.equal(state().dirty, true)
  assert.deepEqual(state().conflict, { theirs: 'theirs\n', commit: id(1) })
  assert.equal(state().notice?.tone, 'error')
  assert.equal(state().notice?.detail, 'gateway offline')
})

test('open selects a skill even when the list was asked for again while it waited for it', async () => {
  const { fake, page, state } = setup()
  const first = gate()
  fake.gates.set('skills', first)
  const opening = page.face.open()
  await until('the list to be asked for', () => fake.calls.includes('skills'))
  // The stream's first item asks for the list too, and its answer is the one that arrives last.
  const second = gate()
  fake.gates.set('skills', second)
  const event = page.onConfigEvent({ kind: 'remote', status: { pending: 0 } }, true)
  first.release()
  await until('the list to be read again', () => count(fake.calls, 'skills') === 2)
  second.release()
  await Promise.all([opening, event])
  assert.equal(state().selected, 'brainstorming')
  assert.equal(state().document, 'ready')
  assert.equal(state().skills.length, 3)
})

test('the list is never read twice at once: a call while one is under way waits for that one, and reads once more', async () => {
  const { fake, page } = setup()
  const first = gate()
  fake.gates.set('skills', first)
  const opening = page.face.open()
  await until('the list to be asked for', () => fake.calls.includes('skills'))
  const again = page.onConfigEvent({ kind: 'proposal', id: 'abcd1234', status: 'open' })
  assert.equal(count(fake.calls, 'skills'), 1, 'no second read while the first is out')
  first.release()
  await until('the list to be read again', () => count(fake.calls, 'skills') === 2)
  await Promise.all([opening, again])
  assert.equal(count(fake.calls, 'skills'), 2, 'one more after it, for what changed meanwhile')
})

// --- notices and the remote they name --------------------------------------------------------------

test('a failure to reach dish-config says dish-config, and one to reach dish-skills says dish-skills', async () => {
  const { fake, config, page, state } = await opened()
  config!.log = [commitOf(1, [pathOf('brainstorming')])]
  await page.face.setTab('history')
  config!.down = true
  await page.face.loadHistory()
  assert.equal(state().history?.status, 'error')
  assert.equal(state().history?.error?.text, 'Something went wrong talking to dish-config')
  assert.equal(state().history?.error?.detail, 'gateway offline')

  config!.down = false
  await page.face.loadHistory()
  config!.down = true
  await page.face.loadCommit(id(1))
  const detail = state().history?.details[id(1)]
  assert.equal(detail?.status === 'error' ? detail.error.text : '', 'Something went wrong talking to dish-config')

  await page.face.revert(id(1))
  assert.equal(state().notice?.text, 'Something went wrong talking to dish-config')

  fake.readDown = true
  await page.face.reload()
  assert.equal(state().notice?.text, 'Something went wrong talking to dish-skills')
})

// --- small things ----------------------------------------------------------------------------------

test('dismiss clears the notice, and the store\'s hooks tell subscribers what changed', async () => {
  const { page, state, timer } = await opened()
  page.face.edit('x\n')
  await checked({ timer, state })
  await page.face.save()
  assert.ok(state().notice !== undefined)
  let heard = 0
  const stop = page.face.hooks.page.subscribe(() => { heard++ })
  page.face.dismiss()
  assert.equal(state().notice, undefined)
  assert.ok(heard > 0)
  stop()
  const after = heard
  page.face.edit('y\n')
  assert.equal(heard, after, 'an unsubscribed listener hears nothing')
  assert.equal(page.face.hooks.page.getSnapshot(), state())
})

test('the face the component gets is the actions and the observable, and none of what feeds the controller', () => {
  const { page } = setup()
  assert.deepEqual(Object.keys(page.face).sort(), [
    'askDelete', 'askReset', 'cancelConfirm', 'cancelSwitch', 'confirmSwitch', 'discard', 'dismiss', 'edit', 'hooks', 'keepMine',
    'loadCommit', 'loadHistory', 'loadMoreHistory', 'open', 'reload', 'remove', 'reset', 'revert', 'save', 'select', 'setNote',
    'setTab', 'startNew',
  ])
  assert.deepEqual(Object.keys(page.face.hooks), ['page'])
  assert.deepEqual(Object.keys(page.face.hooks.page).sort(), ['getSnapshot', 'subscribe'], 'a store to read, not one to write')
  for (const internal of ['getState', 'onConfigEvent', 'setConfig', 'streamDown']) {
    assert.equal(internal in page.face, false, internal)
    assert.equal(typeof (page as unknown as Record<string, unknown>)[internal], 'function', `${internal} stays on the controller`)
  }
})
