/**
 * The Prompts page's controller, driven through fake remotes: what it loads, how it tracks a draft, what a save, a reset
 * and a revert do with each answer the store can give, and what a live event does to a page that is clean or has an
 * unsaved edit. The controller has no React in it, so this runs under `node --test`; the JSX around it is checked in a
 * browser.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { createPrompts, defaultView, visibleTabs } from '../src/client/controller.ts'
import type { PageState, PromptsController } from '../src/client/controller.ts'
import type { ConfigCalls, ConfigEvent, PromptsApi } from '../src/client/remote.ts'
import type { CommitInfo, ErrorCode, Outcome, PreviewResult, ReadResult, RoleInfo, VariablesResult } from '../src/protocol.ts'

// --- fakes ---------------------------------------------------------------------------------------

const ok = <T>(value: T): RemoteResult<Outcome<T>> => ({ ok: true, value: { ok: true, value } })
const refused = (code: ErrorCode, message: string): RemoteResult<Outcome<never>> => ({ ok: true, value: { ok: false, code, message } })

/** The id of the n-th commit of the fake store: 40 characters, and the first seven tell it from the others. */
const id = (n: number): string => `c${n}`.padEnd(40, 'e')
const number = (commit: string): number => Number(/^c(\d+)/.exec(commit)![1])

interface Gate { release: () => void, opened: Promise<void> }

function gate(): Gate {
  let release!: () => void
  const opened = new Promise<void>((resolve) => { release = resolve })
  return { release, opened }
}

const PATHS: Record<string, string> = {
  common: 'prompts/common.md',
  main: 'prompts/main.md',
  coder: 'prompts/crew/coder.md',
  analyst: 'prompts/crew/analyst.md',
}

const DEFAULTS: Record<string, string> = {
  common: 'COMMON in {{cwd}}.\n',
  main: 'You are main, on {{model}}.\n',
  coder: 'You are the coder.\n',
}

const VARIABLES: VariablesResult = {
  variables: [{ name: 'cwd', value: '' }, { name: 'model', value: '' }, { name: 'today', value: '2026-10-01' }],
  fallback: false,
}

/**
 * A store of four roles that behaves as the real one does where the page cares: a read says which commit it was made at, a
 * save with a `base` older than the document's last change is a `CONFLICT`, an empty text is `INVALID`, and writing what is
 * there is `null`. `analyst` is a crew role found only in the store, so it has no shipped default.
 */
class FakePrompts {
  head = 0
  up = true
  docs = new Map<string, { text: string, changedAt: number }>()
  pending: Record<string, number> = {}
  calls: string[] = []
  gates = new Map<string, Gate>()
  variablesResult: RemoteResult<Outcome<VariablesResult>> = ok(VARIABLES)
  previewResult: RemoteResult<Outcome<PreviewResult>> = ok({ text: 'PREVIEW', approximate: true, fallback: false, unknownVariables: [] })
  readDown = false
  /** The next write answers `null`, as the store does for a text the document already has. */
  forceNull = false

  constructor() {
    for (const role of Object.keys(PATHS)) this.docs.set(role, { text: DEFAULTS[role] ?? 'ANALYST\n', changedAt: 0 })
  }

  /** Somebody else changes a document: the head moves, and so does what a reader would see. */
  external(role: string, text: string): string {
    this.head++
    this.docs.set(role, { text, changedAt: this.head })
    return id(this.head)
  }

  private async wait(name: string): Promise<void> {
    await this.gates.get(name)?.opened
  }

  private commitInfo(role: string, note: string): CommitInfo {
    return { id: id(this.head), time: 1_000, author: { kind: 'user' }, message: 'msg', ...(note === '' ? {} : { note }), paths: [PATHS[role]!] }
  }

  private write(role: string, text: string, base: string, note: string): RemoteResult<Outcome<CommitInfo | null>> {
    if (!this.up) return refused('UNAVAILABLE', 'the config store isn\'t running, so prompts can\'t be saved')
    if (this.forceNull) {
      this.forceNull = false
      return ok(null)
    }
    if (text.trim() === '') return refused('INVALID', 'prompts/main.md: a prompt can\'t be empty; use Reset to go back to the default')
    const doc = this.docs.get(role)!
    if (base !== '' && doc.changedAt > number(base)) return refused('CONFLICT', `${PATHS[role]} changed since ${base.slice(0, 7)}`)
    if (doc.text === text) return ok(null)
    this.head++
    this.docs.set(role, { text, changedAt: this.head })
    return ok(this.commitInfo(role, note))
  }

  readonly api: PromptsApi = {
    roles: async () => {
      this.calls.push('roles')
      await this.wait('roles')
      return ok([...this.docs].map(([role, doc]): RoleInfo => ({
        role,
        path: PATHS[role]!,
        agent: role === 'common' || role === 'main' ? 'propose' : 'write',
        differsFromDefault: DEFAULTS[role] !== undefined && doc.text !== DEFAULTS[role],
        missing: false,
        pendingProposals: this.pending[role] ?? 0,
      })))
    },
    read: async (role) => {
      this.calls.push(`read ${role}`)
      if (this.readDown) return { ok: false, error: { message: 'gateway offline' } } as unknown as RemoteResult<never>
      // The answer is what the document says when the read is made, not when the gate lets it through.
      const doc = this.docs.get(role)!
      const answer: ReadResult = { text: doc.text, commit: this.up ? id(this.head) : null, defaultText: DEFAULTS[role] ?? null, missing: false }
      await this.wait(`read ${role}`)
      return ok(answer)
    },
    save: async (role, text, base, note) => {
      this.calls.push(`save ${role} ${base === '' ? '-' : base.slice(0, 7)} ${note === '' ? '-' : note}`)
      await this.wait('save')
      const answer = this.write(role, text, base, note)
      await this.wait('save answer')
      return answer
    },
    reset: async (role, base, note) => {
      this.calls.push(`reset ${role} ${base === '' ? '-' : base.slice(0, 7)}`)
      const shipped = DEFAULTS[role]
      if (shipped === undefined) return refused('INVALID', `"${role}" has no shipped default to go back to`)
      return this.write(role, shipped, base, note)
    },
    preview: async (role) => {
      this.calls.push(`preview ${role}`)
      await this.wait('preview')
      return this.previewResult
    },
    variables: async () => {
      this.calls.push('variables')
      return this.variablesResult
    },
  }
}

/** The part of dish-config's remote the page uses, over a log it is given. */
class FakeConfig {
  calls: string[] = []
  log: CommitInfo[] = []
  reverts: Array<CommitInfo | null | 'conflict'> = []

  readonly api: ConfigCalls = {
    history: async (prefix, limit, before) => {
      this.calls.push(`history ${prefix} ${limit} ${before === '' ? '-' : before}`)
      return ok(this.log)
    },
    commit: async (commit) => {
      this.calls.push(`commit ${commit}`)
      const info = this.log.find(candidate => candidate.id === commit)
      if (info === undefined) return refused('NOT_FOUND', `there is no commit ${commit}`)
      return ok({ info, diffs: [{ path: info.paths[0]!, status: 'modified' as const, patch: '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n' }] })
    },
    revert: async (commit) => {
      this.calls.push(`revert ${commit}`)
      const next = this.reverts.shift() ?? null
      if (next === 'conflict') return refused('CONFLICT', 'a later change touched the same files')
      return ok(next)
    },
  }
}

function commitOf(n: number, paths: string[], note?: string): CommitInfo {
  return { id: id(n), time: 1_000 + n, author: { kind: 'user' }, message: `prompts: change ${n}`, ...(note === undefined ? {} : { note }), paths }
}

interface Setup {
  fake: FakePrompts
  config: FakeConfig | undefined
  page: PromptsController
  state: () => PageState
}

function setup(options: { config?: boolean } = {}): Setup {
  const fake = new FakePrompts()
  const config = options.config === false ? undefined : new FakeConfig()
  const page = createPrompts(fake.api, config?.api)
  return { fake, config, page, state: () => page.getState() }
}

/** An opened page, with `main` selected. */
async function opened(options: { config?: boolean } = {}): Promise<Setup> {
  const made = setup(options)
  await made.page.open()
  return made
}

// --- loading ---------------------------------------------------------------------------------------

test('open loads the roles and the variables, and selects main', async () => {
  const { fake, state } = await opened()
  assert.deepEqual(state().roles.map(role => role.role), ['common', 'main', 'coder', 'analyst'])
  assert.equal(state().selected, 'main')
  assert.equal(state().document, 'ready')
  assert.deepEqual(state().saved, { text: DEFAULTS.main, commit: id(0) })
  assert.equal(state().draft, DEFAULTS.main)
  assert.equal(state().defaultText, DEFAULTS.main)
  assert.equal(state().dirty, false)
  assert.equal(state().tab, 'edit')
  assert.equal(state().readOnly, false)
  assert.equal(state().variables.status, 'ready')
  assert.deepEqual(state().variables.list.map(variable => variable.name), ['cwd', 'model', 'today'])
  assert.ok(fake.calls.includes('roles') && fake.calls.includes('read main') && fake.calls.includes('variables'), fake.calls.join(', '))
})

test('select loads another role, with a fresh draft, note and tab-appropriate state', async () => {
  const { page, state } = await opened()
  page.edit('something else\n')
  page.setNote('why')
  assert.equal(state().dirty, true)
  await page.select('common')
  assert.equal(state().switching, 'common', 'a draft is not thrown away silently')
  assert.equal(state().selected, 'main')
  await page.confirmSwitch()
  assert.equal(state().selected, 'common')
  assert.equal(state().switching, undefined)
  assert.deepEqual(state().saved, { text: DEFAULTS.common, commit: id(0) })
  assert.equal(state().draft, DEFAULTS.common)
  assert.equal(state().note, '')
  assert.equal(state().dirty, false)
})

test('selecting while clean switches at once, and cancelling a switch keeps the draft', async () => {
  const { page, state } = await opened()
  await page.select('coder')
  assert.equal(state().selected, 'coder')
  assert.equal(state().switching, undefined)
  page.edit('x')
  await page.select('main')
  assert.equal(state().switching, 'main')
  page.cancelSwitch()
  assert.equal(state().switching, undefined)
  assert.equal(state().selected, 'coder')
  assert.equal(state().draft, 'x')
})

test('an answer for a role that is no longer selected is dropped', async () => {
  const { fake, page, state } = await opened()
  const slow = gate()
  fake.gates.set('read coder', slow)
  const pending = page.select('coder')
  await page.select('common')
  assert.equal(state().selected, 'common')
  slow.release()
  await pending
  assert.equal(state().selected, 'common')
  assert.equal(state().draft, DEFAULTS.common, 'coder\'s late answer did not replace common\'s')
})

test('a read the carrier failed is an error with a way to try again, and reload tries again', async () => {
  const { fake, page, state } = setup()
  fake.readDown = true
  await page.open()
  assert.equal(state().document, 'error')
  assert.equal(state().documentError?.text, 'Something went wrong talking to dish-prompts')
  assert.equal(state().documentError?.detail, 'gateway offline')
  fake.readDown = false
  await page.reload()
  assert.equal(state().document, 'ready')
  assert.equal(state().draft, DEFAULTS.main)
})

test('a read with no commit means no store: the page is read-only', async () => {
  const { fake, page, state } = setup()
  fake.up = false
  await page.open()
  assert.equal(state().readOnly, true)
  assert.equal(state().saved?.commit, null)
  await page.save()
  page.edit('changed')
  await page.save()
  assert.equal(state().notice?.tone, 'error')
  assert.match(state().notice?.text ?? '', /config store isn't running/)
  assert.equal(state().draft, 'changed', 'the draft stays')
  fake.up = true
  await page.reload()
  assert.equal(state().readOnly, false)
})

// --- the draft -------------------------------------------------------------------------------------

test('edit tracks whether the draft differs from what is saved', async () => {
  const { page, state } = await opened()
  assert.equal(state().dirty, false)
  page.edit('You are main, on {{model}}.\nMore.\n')
  assert.equal(state().dirty, true)
  assert.equal(state().draft, 'You are main, on {{model}}.\nMore.\n')
  page.edit(DEFAULTS.main!)
  assert.equal(state().dirty, false, 'typing back to what is saved is clean')
})

test('discard returns the draft to the saved text and drops the note', async () => {
  const { page, state } = await opened()
  page.edit('x')
  page.setNote('because')
  page.discard()
  assert.equal(state().draft, DEFAULTS.main)
  assert.equal(state().note, '')
  assert.equal(state().dirty, false)
})

// --- save ------------------------------------------------------------------------------------------

test('save with nothing changed does nothing', async () => {
  const { fake, page } = await opened()
  const before = fake.calls.length
  await page.save()
  assert.equal(fake.calls.length, before)
})

test('save writes the draft on the commit the page loaded, with the note, and refreshes saved and the roles', async () => {
  const { fake, page, state } = await opened()
  page.edit('You are main, on {{model}}. Be brief.\n')
  page.setNote('shorter')
  const rolesBefore = fake.calls.filter(call => call === 'roles').length
  await page.save()
  assert.ok(fake.calls.includes(`save main ${id(0).slice(0, 7)} shorter`), fake.calls.join(', '))
  assert.deepEqual(state().saved, { text: 'You are main, on {{model}}. Be brief.\n', commit: id(1) })
  assert.equal(state().dirty, false)
  assert.equal(state().notice?.tone, 'success')
  assert.match(state().notice?.text ?? '', /c1eeeee/, 'the short id of the commit')
  assert.equal(state().busy, undefined)
  assert.equal(state().conflict, undefined)
  assert.equal(fake.calls.filter(call => call === 'roles').length, rolesBefore + 1, 'the roles are read again')
  assert.equal(state().roles.find(role => role.role === 'main')?.differsFromDefault, true)
})

test('after a save the next one is made on the new commit', async () => {
  const { fake, page } = await opened()
  page.edit('one\n')
  await page.save()
  page.edit('two\n')
  await page.save()
  assert.ok(fake.calls.includes(`save main ${id(1).slice(0, 7)} -`), fake.calls.join(', '))
})

test('what is typed while a save is under way is kept, and is still unsaved', async () => {
  const { fake, page, state } = await opened()
  const slow = gate()
  fake.gates.set('save', slow)
  page.edit('first\n')
  const saving = page.save()
  assert.equal(state().busy, 'save')
  page.edit('first\nsecond\n')
  slow.release()
  await saving
  assert.equal(state().saved?.text, 'first\n')
  assert.equal(state().draft, 'first\nsecond\n')
  assert.equal(state().dirty, true)
})

test('the live event for this page\'s own save, arriving before the save\'s answer, is not a conflict', async () => {
  const { fake, page, state } = await opened()
  const slow = gate()
  fake.gates.set('save answer', slow)
  page.edit('mine\n')
  const saving = page.save()
  while (fake.head < 1) await new Promise(resolve => setTimeout(resolve, 1))
  // The store has committed and said so, and the answer to the save is still on its way.
  await page.onConfigEvent({ kind: 'changed', commit: id(1), paths: ['prompts/main.md'] })
  assert.equal(state().conflict, undefined)
  slow.release()
  await saving
  assert.equal(state().conflict, undefined)
  assert.deepEqual(state().saved, { text: 'mine\n', commit: id(1) })
  assert.equal(state().draft, 'mine\n')
  assert.equal(state().dirty, false)
})

test('a second save while one is under way is not started', async () => {
  const { fake, page } = await opened()
  const slow = gate()
  fake.gates.set('save', slow)
  page.edit('first\n')
  const saving = page.save()
  await page.save()
  slow.release()
  await saving
  assert.equal(fake.calls.filter(call => call.startsWith('save ')).length, 1)
})

test('save that finds the document already says this has nothing to commit, and the page is clean', async () => {
  const { fake, page, state } = await opened()
  fake.external('main', 'same text\n')
  fake.forceNull = true
  page.edit('same text\n')
  await page.save()
  assert.equal(fake.calls.some(call => call.startsWith('save main')), true)
  assert.equal(state().notice?.tone, 'info')
  assert.equal(state().dirty, false)
  assert.equal(state().saved?.commit, id(1), 'saved moved to what the store has')
})

test('save with an empty draft is refused as INVALID, with the store\'s message, and the draft stays', async () => {
  const { page, state } = await opened()
  page.edit('   \n')
  await page.save()
  assert.equal(state().notice?.tone, 'error')
  assert.match(state().notice?.text ?? '', /can't be empty/)
  assert.equal(state().draft, '   \n')
  assert.equal(state().dirty, true)
})

test('save that hits CONFLICT keeps the draft and puts theirs in conflict', async () => {
  const { fake, page, state } = await opened()
  page.edit('mine\n')
  fake.external('main', 'theirs\n')
  await page.save()
  assert.equal(state().draft, 'mine\n')
  assert.equal(state().dirty, true)
  assert.deepEqual(state().conflict, { theirs: 'theirs\n', commit: id(1) })
  assert.equal(state().notice?.tone, 'error')
  assert.match(state().notice?.text ?? '', /changed since you loaded it/)
  assert.deepEqual(state().saved, { text: DEFAULTS.main, commit: id(0) }, 'saved is still what was loaded')
})

test('while a conflict is open save does nothing: Reload or Keep mine comes first', async () => {
  const { fake, page, state } = await opened()
  page.edit('mine\n')
  fake.external('main', 'theirs\n')
  await page.save()
  assert.ok(state().conflict !== undefined)
  const before = fake.calls.length
  await page.save()
  assert.equal(fake.calls.length, before, 'no second attempt on the old base')
})

test('Reload after a conflict adopts theirs and drops the draft', async () => {
  const { fake, page, state } = await opened()
  page.edit('mine\n')
  fake.external('main', 'theirs\n')
  await page.save()
  await page.reload()
  assert.equal(state().conflict, undefined)
  assert.equal(state().draft, 'theirs\n')
  assert.deepEqual(state().saved, { text: 'theirs\n', commit: id(1) })
  assert.equal(state().dirty, false)
})

test('Keep mine after a conflict makes theirs the base, keeps the draft, and the next save goes through', async () => {
  const { fake, page, state } = await opened()
  page.edit('mine\n')
  fake.external('main', 'theirs\n')
  await page.save()
  page.keepMine()
  assert.equal(state().conflict, undefined)
  assert.equal(state().draft, 'mine\n')
  assert.deepEqual(state().saved, { text: 'theirs\n', commit: id(1) })
  assert.equal(state().dirty, true)
  await page.save()
  assert.equal(state().notice?.tone, 'success')
  assert.deepEqual(state().saved, { text: 'mine\n', commit: id(2) })
})

test('a save while the store is not running says so, and keeps the draft', async () => {
  const { fake, page, state } = await opened()
  fake.up = false
  page.edit('x\n')
  await page.save()
  assert.equal(state().notice?.tone, 'error')
  assert.match(state().notice?.text ?? '', /config store isn't running/)
  assert.equal(state().draft, 'x\n')
  assert.equal(state().conflict, undefined)
})

// --- live events -----------------------------------------------------------------------------------

test('a change to the selected path while clean reloads the document', async () => {
  const { fake, page, state } = await opened()
  const commit = fake.external('main', 'edited elsewhere\n')
  await page.onConfigEvent({ kind: 'changed', commit, paths: ['prompts/main.md'] })
  assert.equal(state().draft, 'edited elsewhere\n')
  assert.deepEqual(state().saved, { text: 'edited elsewhere\n', commit: id(1) })
  assert.equal(state().conflict, undefined)
  assert.equal(state().dirty, false)
})

test('a change to the selected path while dirty sets conflict and keeps the draft', async () => {
  const { fake, page, state } = await opened()
  page.edit('my edit\n')
  const commit = fake.external('main', 'edited elsewhere\n')
  await page.onConfigEvent({ kind: 'changed', commit, paths: ['prompts/main.md'] })
  assert.equal(state().draft, 'my edit\n')
  assert.deepEqual(state().conflict, { theirs: 'edited elsewhere\n', commit: id(1) })
  assert.equal(state().saved?.text, DEFAULTS.main)
})

test('the echo of this page\'s own save is no conflict, even with a new edit under way', async () => {
  const { page, state } = await opened()
  page.edit('one\n')
  await page.save()
  page.edit('one\ntwo\n')
  await page.onConfigEvent({ kind: 'changed', commit: id(1), paths: ['prompts/main.md'] })
  assert.equal(state().conflict, undefined)
  assert.equal(state().draft, 'one\ntwo\n')
  assert.equal(state().dirty, true)
})

test('a change to another path leaves the document alone and refreshes the list; one to no prompt does nothing', async () => {
  const { fake, page, state } = await opened()
  page.edit('my edit\n')
  const commit = fake.external('coder', 'changed coder\n')
  const before = fake.calls.length
  await page.onConfigEvent({ kind: 'changed', commit, paths: ['prompts/crew/coder.md'] })
  assert.equal(state().conflict, undefined)
  assert.equal(state().draft, 'my edit\n')
  assert.equal(state().roles.find(role => role.role === 'coder')?.differsFromDefault, true)
  assert.ok(fake.calls.slice(before).includes('roles'))
  assert.equal(fake.calls.slice(before).some(call => call.startsWith('read ')), false, 'no document was read')

  const after = fake.calls.length
  await page.onConfigEvent({ kind: 'changed', commit: id(9), paths: ['crew.yaml'] })
  assert.equal(fake.calls.length, after, 'not a prompt: nothing was asked')
})

test('a proposal event refreshes the pending counts', async () => {
  const { fake, page, state } = await opened()
  assert.equal(state().roles.find(role => role.role === 'main')?.pendingProposals, 0)
  fake.pending.main = 2
  await page.onConfigEvent({ kind: 'proposal', id: 'abcd1234', status: 'open' })
  assert.equal(state().roles.find(role => role.role === 'main')?.pendingProposals, 2)
})

test('the first event of a stream reads again what the page has, and a remote status event is ignored', async () => {
  const { fake, page, state } = await opened()
  fake.external('main', 'changed while the stream was down\n')
  const before = fake.calls.length
  await page.onConfigEvent({ kind: 'remote', status: { pending: 0 } }, false)
  assert.equal(fake.calls.length, before)
  await page.onConfigEvent({ kind: 'remote', status: { pending: 0 } }, true)
  assert.equal(state().stream, 'live')
  assert.equal(state().draft, 'changed while the stream was down\n')
  page.streamDown()
  assert.equal(state().stream, 'down')
})

// --- reset -----------------------------------------------------------------------------------------

test('reset writes the default on the commit the page loaded, and the editor shows it', async () => {
  const { fake, page, state } = await opened()
  page.edit('custom\n')
  await page.save()
  page.edit('custom\nmore\n')
  await page.reset()
  assert.ok(fake.calls.includes(`reset main ${id(1).slice(0, 7)}`), fake.calls.join(', '))
  assert.equal(state().draft, DEFAULTS.main, 'an unsaved edit is replaced by the default too')
  assert.equal(state().saved?.text, DEFAULTS.main)
  assert.equal(state().saved?.commit, id(2))
  assert.equal(state().dirty, false)
  assert.equal(state().notice?.tone, 'success')
  assert.equal(state().roles.find(role => role.role === 'main')?.differsFromDefault, false)
})

test('reset of a prompt that already is the default says so', async () => {
  const { page, state } = await opened()
  await page.reset()
  assert.equal(state().notice?.tone, 'info')
  assert.match(state().notice?.text ?? '', /Already the default/)
})

test('reset that hits CONFLICT keeps the draft and shows theirs', async () => {
  const { fake, page, state } = await opened()
  page.edit('mine\n')
  fake.external('main', 'theirs\n')
  await page.reset()
  assert.equal(state().draft, 'mine\n')
  assert.deepEqual(state().conflict, { theirs: 'theirs\n', commit: id(1) })
  assert.equal(state().notice?.tone, 'error')
})

test('a role with no shipped default can\'t be reset', async () => {
  const { fake, page, state } = await opened()
  await page.select('analyst')
  const before = fake.calls.length
  await page.reset()
  assert.equal(fake.calls.length, before)
  assert.equal(state().defaultText, null)
})

// --- the Default tab -------------------------------------------------------------------------------

test('defaultView: the same text is "same", a different one is a diff from the default to what is saved, and no default is none', async () => {
  const { page, state } = await opened()
  assert.deepEqual(defaultView(state()), { kind: 'same' })

  page.edit('You are main, on {{model}}.\nAnd more.\n')
  await page.save()
  const view = defaultView(state())
  assert.equal(view.kind, 'diff')
  if (view.kind === 'diff') {
    assert.equal(view.diff.path, 'prompts/main.md')
    assert.equal(view.diff.status, 'modified')
    assert.match(view.diff.patch, /^--- a\/prompts\/main\.md\n\+\+\+ b\/prompts\/main\.md\n@@ /)
    assert.match(view.diff.patch, /\+And more\.\n/)
  }

  await page.select('analyst')
  assert.deepEqual(defaultView(state()), { kind: 'none' })
})

test('the draft does not change the Default view: it compares what is saved', async () => {
  const { page, state } = await opened()
  page.edit('entirely different\n')
  assert.deepEqual(defaultView(state()), { kind: 'same' })
})

test('a role with no default has no Default tab, and selecting one while on that tab goes back to Edit', async () => {
  const { page, state } = await opened()
  assert.deepEqual(visibleTabs(state()), ['edit', 'default', 'preview', 'history'])
  await page.setTab('default')
  assert.equal(state().tab, 'default')
  await page.select('analyst')
  assert.deepEqual(visibleTabs(state()), ['edit', 'preview', 'history'])
  assert.equal(state().tab, 'edit')
  await page.setTab('default')
  assert.equal(state().tab, 'edit', 'a tab that is not there can\'t be opened')
})

// --- unknown variables -----------------------------------------------------------------------------

test('unknown variables: the names in the draft that the preset has no variable for, as a warning that never blocks', async () => {
  const { page, state } = await opened()
  assert.deepEqual(state().unknownVariables, [])
  page.edit('Hi {{model}} in {{cwd}} on {{today}}; {{nope}}, {{ spaced }}, {{Upper}} and {{nope}} again.\n')
  assert.deepEqual(state().unknownVariables, ['nope'], 'once, in order; a malformed group is not a reference')
  page.edit('{{zed}} {{alpha}}')
  assert.deepEqual(state().unknownVariables, ['zed', 'alpha'], 'in order of first appearance')
  await page.save()
  assert.equal(state().notice?.tone, 'success', 'the warning did not stop the save')
  page.edit(DEFAULTS.main!)
  assert.deepEqual(state().unknownVariables, [])
})

test('unknown variables: none while dsh\'s assembly was not usable (fallback), nor when the variables could not be read', async () => {
  const fallback = setup()
  fallback.fake.variablesResult = ok({ variables: [], fallback: true })
  await fallback.page.open()
  fallback.page.edit('{{anything}} {{at_all}}')
  assert.deepEqual(fallback.state().unknownVariables, [])
  assert.equal(fallback.state().variables.fallback, true)

  const failed = setup()
  failed.fake.variablesResult = refused('NOT_FOUND', 'x')
  await failed.page.open()
  failed.page.edit('{{anything}}')
  assert.deepEqual(failed.state().unknownVariables, [])
  assert.equal(failed.state().variables.status, 'error')
})

test('unknown variables are worked out again when the variables arrive after the draft', async () => {
  const made = setup()
  made.fake.variablesResult = ok({ variables: [], fallback: true })
  await made.page.open()
  made.page.edit('{{x}}')
  assert.deepEqual(made.state().unknownVariables, [])
  made.fake.variablesResult = ok(VARIABLES)
  await made.page.loadVariables()
  assert.deepEqual(made.state().unknownVariables, ['x'])
})

// --- the Preview tab -------------------------------------------------------------------------------

test('opening the Preview tab loads the preview of the selected role', async () => {
  const { fake, page, state } = await opened()
  await page.setTab('preview')
  assert.equal(state().tab, 'preview')
  assert.deepEqual(state().preview, { status: 'ready', value: { text: 'PREVIEW', approximate: true, fallback: false, unknownVariables: [] } })
  assert.ok(fake.calls.includes('preview main'))
})

test('a preview that failed is an error with a notice, and a fallback preview is kept as it is', async () => {
  const { fake, page, state } = await opened()
  fake.previewResult = refused('NOT_FOUND', 'there is no role "main"')
  await page.loadPreview()
  assert.equal(state().preview?.status, 'error')
  assert.match(state().preview?.error?.text ?? '', /Not found/)
  fake.previewResult = ok({ text: 'FB', approximate: true, fallback: true, unknownVariables: [] })
  await page.loadPreview()
  assert.equal(state().preview?.value?.fallback, true)
})

test('a save refreshes the open preview, and drops one that is not shown', async () => {
  const { fake, page, state } = await opened()
  await page.setTab('preview')
  page.edit('new\n')
  const before = fake.calls.filter(call => call === 'preview main').length
  await page.save()
  assert.equal(fake.calls.filter(call => call === 'preview main').length, before + 1)

  await page.setTab('edit')
  page.edit('newer\n')
  await page.save()
  assert.equal(state().preview, undefined, 'it will be loaded again when the tab opens')
})

test('selecting another role while on Preview loads that role\'s preview', async () => {
  const { fake, page } = await opened()
  await page.setTab('preview')
  await page.select('coder')
  assert.ok(fake.calls.includes('preview coder'))
})

// --- the History tab -------------------------------------------------------------------------------

test('the History tab loads this document\'s log, 20 at a time, with the newest page first', async () => {
  const { config, page, state } = await opened()
  config!.log = [commitOf(3, ['prompts/main.md'], 'tighter'), commitOf(1, ['prompts/main.md'])]
  await page.setTab('history')
  assert.deepEqual(config!.calls, ['history prompts/main.md 20 -'])
  assert.equal(state().history?.status, 'ready')
  assert.deepEqual(state().history?.commits.map(commit => commit.id), [id(3), id(1)])
})

test('a commit\'s diff is fetched when asked for, once', async () => {
  const { config, page, state } = await opened()
  config!.log = [commitOf(3, ['prompts/main.md'])]
  await page.setTab('history')
  await page.loadCommit(id(3))
  await page.loadCommit(id(3))
  assert.equal(config!.calls.filter(call => call.startsWith('commit ')).length, 1)
  const detail = state().history?.details[id(3)]
  assert.equal(detail?.status, 'ready')
  assert.equal(detail?.status === 'ready' ? detail.diffs[0]?.path : undefined, 'prompts/main.md')
})

test('a commit that can\'t be read has an error of its own', async () => {
  const { page, state } = await opened()
  await page.setTab('history')
  await page.loadCommit(id(7))
  const detail = state().history?.details[id(7)]
  assert.equal(detail?.status, 'error')
})

test('revert undoes a commit with a new one, then reads again the log, the roles and the document', async () => {
  const { fake, config, page, state } = await opened()
  config!.log = [commitOf(1, ['prompts/main.md'])]
  config!.reverts = [commitOf(2, ['prompts/main.md'])]
  await page.setTab('history')
  const rolesBefore = fake.calls.filter(call => call === 'roles').length
  const readsBefore = fake.calls.filter(call => call === 'read main').length
  await page.revert(id(1))
  assert.ok(config!.calls.includes(`revert ${id(1)}`))
  assert.equal(state().notice?.tone, 'success')
  assert.match(state().notice?.text ?? '', /c1eeeee/)
  assert.match(state().notice?.text ?? '', /c2eeeee/)
  assert.equal(config!.calls.filter(call => call.startsWith('history')).length, 2, 'the log was read again')
  assert.equal(fake.calls.filter(call => call === 'roles').length, rolesBefore + 1)
  assert.equal(fake.calls.filter(call => call === 'read main').length, readsBefore + 1)
  assert.equal(state().busy, undefined)
})

test('revert that finds nothing left to undo says "Already reverted"', async () => {
  const { config, page, state } = await opened()
  config!.log = [commitOf(1, ['prompts/main.md'])]
  config!.reverts = [null]
  await page.setTab('history')
  await page.revert(id(1))
  assert.equal(state().notice?.tone, 'info')
  assert.match(state().notice?.text ?? '', /^Already reverted/)
})

test('revert that hits CONFLICT says to revert the later change first', async () => {
  const { config, page, state } = await opened()
  config!.log = [commitOf(1, ['prompts/main.md'])]
  config!.reverts = ['conflict']
  await page.setTab('history')
  await page.revert(id(1))
  assert.equal(state().notice?.tone, 'error')
  assert.match(state().notice?.text ?? '', /later change/)
})

test('an event for the selected path reads the open history again', async () => {
  const { config, page } = await opened()
  config!.log = [commitOf(1, ['prompts/main.md'])]
  await page.setTab('history')
  config!.log = [commitOf(2, ['prompts/main.md']), commitOf(1, ['prompts/main.md'])]
  await page.onConfigEvent({ kind: 'changed', commit: id(2), paths: ['prompts/main.md'] })
  assert.equal(config!.calls.filter(call => call.startsWith('history')).length, 2)
  assert.equal(page.getState().history?.commits.length, 2)
})

// --- no dish-config --------------------------------------------------------------------------------

test('without a config remote the History tab is hidden, opening it does nothing, and live updates are off', async () => {
  const { page, state } = await opened({ config: false })
  assert.equal(state().hasHistory, false)
  assert.equal(state().stream, 'off')
  assert.deepEqual(visibleTabs(state()), ['edit', 'default', 'preview'])
  await page.setTab('history')
  assert.equal(state().tab, 'edit')
  await page.loadHistory()
  assert.equal(state().history, undefined)
  await page.revert(id(1))
  assert.equal(state().notice, undefined)
})

test('a config remote that arrives later turns History and live updates on, and one that goes turns them off', async () => {
  const { page, state } = await opened({ config: false })
  const config = new FakeConfig()
  config.log = [commitOf(1, ['prompts/main.md'])]
  page.setConfig(config.api)
  assert.equal(state().hasHistory, true)
  assert.equal(state().stream, 'connecting')
  assert.deepEqual(visibleTabs(state()), ['edit', 'default', 'preview', 'history'])
  await page.setTab('history')
  assert.equal(state().history?.commits.length, 1)

  page.setConfig(undefined)
  assert.equal(state().hasHistory, false)
  assert.equal(state().stream, 'off')
  assert.equal(state().tab, 'edit', 'the open History tab goes back to Edit')
  assert.equal(state().history, undefined)
})

// --- small things ----------------------------------------------------------------------------------

test('dismiss clears the notice, and the store\'s hooks tell subscribers what changed', async () => {
  const { page, state } = await opened()
  page.edit('x\n')
  await page.save()
  assert.ok(state().notice !== undefined)
  let heard = 0
  const stop = page.hooks.page.subscribe(() => { heard++ })
  page.dismiss()
  assert.equal(state().notice, undefined)
  assert.ok(heard > 0)
  stop()
  const after = heard
  page.edit('y\n')
  assert.equal(heard, after, 'an unsubscribed listener hears nothing')
  assert.equal(page.hooks.page.getSnapshot(), state())
})

test('the config events the page hears have the shape dish-config sends', () => {
  const events: ConfigEvent[] = [
    { kind: 'changed', commit: id(1), paths: ['prompts/main.md'] },
    { kind: 'proposal', id: 'abcd1234', status: 'accepted' },
    { kind: 'remote', status: { pending: 1, lastError: 'no route' } },
  ]
  assert.equal(events.length, 3)
})
