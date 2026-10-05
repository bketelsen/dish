/**
 * The Memory page's controller, driven through a fake remote: what it loads, how it tracks a draft, what a save, a delete,
 * a release and a revert do with each answer the service can give, what a live event does to a page that is clean or has
 * an unsaved edit, and that answers arriving after the person moved on are dropped. The controller has no React in it, so
 * this runs under `node --test`; the views are rendered in `client-rendering.test.ts`.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { HISTORY_PAGE, createMemoryPage, directionDirty, memoryDirty, visibleTabs } from '../src/client/controller.ts'
import type { MemoryActions, PageState } from '../src/client/controller.ts'
import type { MemoryApi } from '../src/client/remote.ts'
import { DIRECTION_TEMPLATE } from '../src/protocol.ts'
import type {
  CommitInfo, DirectionInfo, ErrorCode, Memory, MemoryEvent, MemoryInfo, MemoryType, Outcome, RemoteStatus, ScopeInfo,
} from '../src/protocol.ts'

// --- fakes ---------------------------------------------------------------------------------------

const ok = <T>(value: T): RemoteResult<Outcome<T>> => ({ ok: true, value: { ok: true, value } })
const refused = (code: ErrorCode, message: string): RemoteResult<Outcome<never>> => ({ ok: true, value: { ok: false, code, message } })
const carrierDown = (): RemoteResult<never> => ({ ok: false, error: { message: 'gateway offline' } }) as unknown as RemoteResult<never>

/** The id of the n-th commit of the fake vault: 40 characters, and the first seven tell it from the others. */
const id = (n: number): string => `c${n}`.padEnd(40, 'e')
const number = (commit: string): number => Number(/^c(\d+)/.exec(commit)![1])

interface Gate { release: () => void, opened: Promise<void> }

function gate(): Gate {
  let release!: () => void
  const opened = new Promise<void>((resolve) => { release = resolve })
  return { release, opened }
}

interface Stored { type: MemoryType, description: string, body: string, modified: string, held?: string, changedAt: number }

const memoryIdOf = (scope: string, name: string): string => `${scope === 'user' ? 'user' : 'family'}/${name}`

/**
 * A vault of three scopes (You, the family `dish`, and `old`, a family with no project any more) that behaves as the service
 * does where the page cares: a read says which commit it was made at, a save with a `base` older than the memory's last
 * change is a `CONFLICT`, as is a new one (`base` `''`) whose name exists, and an empty body is `INVALID`. Every write moves
 * the head. A family's direction lives in the same counter, standing in for the config store's head.
 */
class FakeMemory {
  head = 0
  scopes = new Map<string, Map<string, Stored>>([['user', new Map()], ['family:dish', new Map()], ['family:old', new Map()]])
  directions = new Map<string, { text: string, changedAt: number }>()
  log: CommitInfo[] = []
  reverts: Array<CommitInfo | null | 'conflict'> = []
  previews = new Map<string, string>()
  pendingProposals = 0
  calls: string[] = []
  gates = new Map<string, Gate>()
  /** Every read of these names fails at the carrier. */
  down = new Set<string>()

  constructor() {
    this.put('user', 'style', { type: 'feedback', description: 'Terse answers', body: 'Keep answers short.\n' })
    this.put('user', 'quoted', { type: 'user', description: 'Writes in British English', body: 'Colour, not color.\n', held: 'Jev scored it 0.93 as instructions aimed at an agent' })
    this.put('family:dish', 'deploy-gate', { type: 'project', description: 'Deploys wait for the user', body: 'Never run deploy/ scripts unasked.\n' })
    this.put('family:old', 'gone', { type: 'reference', description: 'An old note', body: 'Old.\n' })
  }

  /** A memory written by someone else: the head moves. */
  put(scope: string, name: string, fields: Omit<Stored, 'changedAt' | 'modified'>): string {
    this.head++
    this.scopes.get(scope)!.set(name, { ...fields, modified: `2026-10-05T10:00:${String(this.head).padStart(2, '0')}Z`, changedAt: this.head })
    this.log.unshift(this.commitInfo(scope, `${memoryIdOf(scope, name)}: ${fields.description}`, [this.pathOf(scope, name)]))
    return id(this.head)
  }

  /** Someone else changes a direction. */
  putDirection(family: string, text: string): string {
    this.head++
    this.directions.set(family, { text, changedAt: this.head })
    return id(this.head)
  }

  pathOf(scope: string, name: string): string {
    return scope === 'user' ? `user/${name}.md` : `families/${scope.slice('family:'.length)}/${name}.md`
  }

  private commitInfo(scope: string, note: string, paths: string[]): CommitInfo {
    return { id: id(this.head), time: 1_000 + this.head, author: { kind: 'user' }, message: `vault: ${scope}`, note, paths }
  }

  /** Hold the call that reaches `name` until its gate opens. A gate holds one call. */
  private async wait(name: string): Promise<void> {
    const held = this.gates.get(name)
    if (held === undefined) return
    this.gates.delete(name)
    await held.opened
  }

  private infoOf(scope: string, name: string, stored: Stored): MemoryInfo {
    const info: MemoryInfo = { scope, name, type: stored.type, description: stored.description, modified: stored.modified }
    if (stored.held !== undefined) info.held = stored.held
    return info
  }

  private baseConflict(scope: string, name: string, base: string): RemoteResult<Outcome<never>> | undefined {
    const stored = this.scopes.get(scope)!.get(name)
    const memoryId = memoryIdOf(scope, name)
    if (base === '' && stored !== undefined) return refused('CONFLICT', `${memoryId} already exists`)
    if (base !== '' && stored !== undefined && stored.changedAt > number(base)) return refused('CONFLICT', `${memoryId} changed since you loaded it`)
    return undefined
  }

  readonly api: MemoryApi = {
    scopes: async () => {
      this.calls.push('scopes')
      await this.wait('scopes')
      if (this.down.has('scopes')) return carrierDown()
      return ok([...this.scopes].map(([key, memories]): ScopeInfo => ({
        key,
        label: key === 'user' ? 'You' : key.slice('family:'.length),
        count: memories.size,
        held: [...memories.values()].filter(memory => memory.held !== undefined).length,
        orphan: key === 'family:old',
      })))
    },
    list: async (scope) => {
      this.calls.push(`list ${scope}`)
      const answer = [...this.scopes.get(scope)!].map(([name, stored]) => this.infoOf(scope, name, stored))
      await this.wait(`list ${scope}`)
      if (this.down.has('list')) return carrierDown()
      return ok(answer)
    },
    read: async (scope, name) => {
      this.calls.push(`read ${scope} ${name}`)
      // The answer is what the vault says when the read is made, not when the gate lets it through.
      const stored = this.scopes.get(scope)!.get(name)
      const answer: Memory | null = stored === undefined ? null : { ...this.infoOf(scope, name, stored), body: stored.body, commit: id(this.head) }
      await this.wait(`read ${name}`)
      if (this.down.has('read')) return carrierDown()
      return ok(answer)
    },
    save: async (scope, name, type, description, body, base) => {
      this.calls.push(`save ${scope} ${name} ${base === '' ? '-' : base.slice(0, 7)}`)
      await this.wait('save')
      if (body.trim() === '') return refused('INVALID', 'body must not be empty')
      const conflict = this.baseConflict(scope, name, base)
      if (conflict !== undefined) return conflict
      const existing = this.scopes.get(scope)!.get(name)
      const unchanged = existing !== undefined && existing.type === type && existing.description === description && existing.body === body
      const held = unchanged ? existing.held : undefined
      this.put(scope, name, { type: type as MemoryType, description, body, ...(held === undefined ? {} : { held }) })
      const answer = this.log[0]!
      await this.wait('save answer')
      return ok(answer)
    },
    forget: async (scope, name, base) => {
      this.calls.push(`forget ${scope} ${name} ${base === '' ? '-' : base.slice(0, 7)}`)
      const memories = this.scopes.get(scope)!
      if (!memories.has(name)) return refused('NOT_FOUND', `no memory ${memoryIdOf(scope, name)}`)
      const conflict = base === '' ? undefined : this.baseConflict(scope, name, base)
      if (conflict !== undefined) return conflict
      memories.delete(name)
      this.head++
      const info = this.commitInfo(scope, `forget ${name}`, [this.pathOf(scope, name)])
      this.log.unshift(info)
      return ok(info)
    },
    release: async (scope, name) => {
      this.calls.push(`release ${scope} ${name}`)
      const stored = this.scopes.get(scope)!.get(name)
      if (stored === undefined) return refused('NOT_FOUND', `no memory ${memoryIdOf(scope, name)}`)
      if (stored.held === undefined) return refused('INVALID', `${memoryIdOf(scope, name)} isn't held`)
      this.head++
      const { held: _held, ...rest } = stored
      this.scopes.get(scope)!.set(name, { ...rest, changedAt: this.head })
      const info = this.commitInfo(scope, `release ${name}`, [this.pathOf(scope, name)])
      this.log.unshift(info)
      return ok(info)
    },
    direction: async (family) => {
      this.calls.push(`direction ${family}`)
      const stored = this.directions.get(family)
      const answer: DirectionInfo = stored === undefined
        ? { family, text: DIRECTION_TEMPLATE, commit: id(this.head), missing: true, pendingProposals: this.pendingProposals }
        : { family, text: stored.text, commit: id(this.head), missing: false, pendingProposals: this.pendingProposals }
      await this.wait(`direction ${family}`)
      if (this.down.has('direction')) return carrierDown()
      return ok(answer)
    },
    saveDirection: async (family, text, base, note) => {
      this.calls.push(`saveDirection ${family} ${base === '' ? '-' : base.slice(0, 7)} ${note === '' ? '-' : note}`)
      await this.wait('saveDirection')
      const stored = this.directions.get(family)
      if (stored !== undefined && base !== '' && stored.changedAt > number(base)) return refused('CONFLICT', `families/${family}/direction.md changed since ${base.slice(0, 7)}`)
      if (stored?.text === text) return ok(null)
      this.putDirection(family, text)
      const answer: CommitInfo = { id: id(this.head), time: 1_000, author: { kind: 'user' }, message: 'direction', paths: [`families/${family}/direction.md`] }
      await this.wait('saveDirection answer')
      return ok(answer)
    },
    history: async (scope, before) => {
      this.calls.push(`history ${scope} ${before === '' ? '-' : before.slice(0, 7)}`)
      const prefix = scope === 'user' ? 'user/' : `families/${scope.slice('family:'.length)}/`
      const commits = this.log.filter(commit => commit.paths.some(path => path.startsWith(prefix)))
      const start = before === '' ? 0 : commits.findIndex(commit => commit.id === before) + 1
      await this.wait('history')
      return ok(commits.slice(start, start + 20))
    },
    commit: async (commit) => {
      this.calls.push(`commit ${commit.slice(0, 7)}`)
      const info = this.log.find(candidate => candidate.id === commit)
      if (info === undefined) return refused('NOT_FOUND', `there is no commit ${commit}`)
      return ok({ info, diffs: [{ path: info.paths[0]!, status: 'modified' as const, patch: '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n' }] })
    },
    revert: async (commit) => {
      this.calls.push(`revert ${commit.slice(0, 7)}`)
      const next = this.reverts.shift() ?? null
      if (next === 'conflict') return refused('CONFLICT', `user/style changed since`)
      return ok(next)
    },
    preview: async (scope) => {
      this.calls.push(`preview ${scope}`)
      await this.wait('preview')
      return ok({ text: this.previews.get(scope) ?? '' })
    },
    remoteStatus: async () => {
      this.calls.push('remoteStatus')
      return ok<RemoteStatus>({ pending: 0 })
    },
    watch: () => { throw new Error('the controller never opens the stream itself') },
  }

  /** The calls made since the last look, and forget them. */
  take(): string[] {
    const calls = this.calls
    this.calls = []
    return calls
  }
}

interface Setup {
  fake: FakeMemory
  page: ReturnType<typeof createMemoryPage>
  face: MemoryActions
  state: () => PageState
}

function setup(): Setup {
  const fake = new FakeMemory()
  const page = createMemoryPage(fake.api)
  return { fake, page, face: page.face, state: () => page.getState() }
}

/** An opened page, on You. */
async function opened(): Promise<Setup> {
  const made = setup()
  await made.face.open()
  return made
}

/** Wait until `check` holds: the fakes answer on later ticks, and a test needs to act once a call has reached them. */
async function until(what: string, check: () => boolean): Promise<void> {
  for (let tries = 0; !check(); tries++) {
    if (tries > 2_000) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 1))
  }
}

const changed = (scopes: string[], commit = 'x'): MemoryEvent => ({ kind: 'changed', commit, scopes })

// --- loading -------------------------------------------------------------------------------------

test('open loads the scopes and the first scope\'s memories', async () => {
  const { fake, state } = await opened()
  assert.deepEqual(state().scopes?.map(scope => [scope.key, scope.count, scope.held, scope.orphan]), [
    ['user', 2, 1, false], ['family:dish', 1, 0, false], ['family:old', 1, 0, true],
  ])
  assert.equal(state().scope, 'user')
  assert.equal(state().tab, 'memories')
  assert.deepEqual(state().memories?.map(memory => memory.name), ['style', 'quoted'])
  assert.equal(state().open, undefined)
  assert.deepEqual(state().remote, { pending: 0 }, 'the remote line has something before the stream says')
  assert.deepEqual(fake.take().sort(), ['list user', 'remoteStatus', 'scopes'])
})

test('selecting a family offers its Direction tab; You has none, and a page on Direction goes back to Memories', async () => {
  const { face, state } = await opened()
  assert.deepEqual(visibleTabs('user'), ['memories', 'history', 'preview'])
  assert.deepEqual(visibleTabs('family:dish'), ['memories', 'direction', 'history', 'preview'])
  await face.setTab('direction')
  assert.equal(state().tab, 'memories', 'You has no direction')
  await face.selectScope('family:dish')
  assert.deepEqual(state().memories?.map(memory => memory.name), ['deploy-gate'])
  await face.setTab('direction')
  assert.equal(state().tab, 'direction')
  await face.selectScope('user')
  assert.equal(state().tab, 'memories')
})

test('a list the carrier failed is an error with a way to try again', async () => {
  const { fake, face, state } = setup()
  fake.down.add('list')
  await face.open()
  assert.equal(state().memories, undefined)
  assert.equal(state().errors.memories?.text, 'Something went wrong talking to dish-memory')
  fake.down.delete('list')
  await face.open()
  assert.equal(state().errors.memories, undefined)
  assert.equal(state().memories?.length, 2)
})

// --- the editor ----------------------------------------------------------------------------------

test('a new memory saves with base \'\'', async () => {
  const { fake, face, state } = await opened()
  await face.newMemory()
  assert.deepEqual(state().open, { memory: undefined, draft: { name: '', type: 'user', description: '', body: '' } }, 'You\'s memories default to type user')
  assert.equal(memoryDirty(state().open!), false)
  face.edit('name', 'tabs')
  face.edit('type', 'feedback')
  face.edit('type', 'nonsense')
  face.edit('description', 'Tabs, not spaces')
  face.edit('body', 'Indent with tabs.\n')
  assert.equal(state().open?.draft.type, 'feedback', 'a type that is not one of TYPES is ignored')
  assert.equal(memoryDirty(state().open!), true)
  fake.take()
  await face.save()
  assert.deepEqual(fake.take().slice(0, 2), ['save user tabs -', 'read user tabs'])
  assert.equal(state().notice?.tone, 'success')
  assert.equal(state().notice?.text, `Saved user/tabs as ${id(fake.head).slice(0, 7)}`)
  assert.equal(state().open?.memory?.name, 'tabs')
  assert.equal(state().open?.memory?.commit, id(fake.head))
  assert.equal(memoryDirty(state().open!), false)
  assert.deepEqual(state().memories?.map(memory => memory.name), ['style', 'quoted', 'tabs'])
  assert.equal(state().scopes?.[0]?.count, 3, 'the open scope\'s count comes from its list')
  face.edit('name', 'renamed')
  assert.equal(state().open?.draft.name, 'tabs', 'a saved memory\'s name is read-only')
})

test('an edit saves with the commit it was read at', async () => {
  const { fake, face, state } = await opened()
  await face.openMemory('style')
  const loaded = state().open?.memory?.commit
  assert.equal(loaded, id(fake.head))
  assert.equal(state().open?.draft.body, 'Keep answers short.\n')
  await face.save()
  assert.ok(!fake.calls.some(call => call.startsWith('save')), 'nothing to save without an edit')
  // Another memory changes meanwhile: no conflict, since the service checks this memory's file.
  fake.put('user', 'other', { type: 'user', description: 'Other', body: 'Other.\n' })
  face.edit('body', 'Keep answers very short.\n')
  fake.take()
  await face.save()
  assert.equal(fake.take()[0], `save user style ${loaded!.slice(0, 7)}`)
  assert.equal(state().notice?.tone, 'success')
  assert.equal(state().open?.memory?.body, 'Keep answers very short.\n')
  assert.equal(state().open?.memory?.commit, id(fake.head))
})

test('CONFLICT shows theirs; Reload drops the edit; Keep mine keeps it', async () => {
  const { fake, face, state } = await opened()
  await face.openMemory('style')
  face.edit('body', 'Mine.\n')
  fake.put('user', 'style', { type: 'feedback', description: 'Terse answers', body: 'Theirs.\n' })
  await face.save()
  assert.equal(state().notice?.text, 'This memory changed since you loaded it. Your text is still in the editor.')
  assert.equal(state().open?.draft.body, 'Mine.\n', 'the draft stays')
  assert.equal(state().open?.conflict?.theirs?.body, 'Theirs.\n')
  assert.match(state().open!.conflict!.diff.patch, /-Keep answers short\.\n\+Theirs\./)
  assert.equal(state().open?.conflict?.diff.path, 'user/style.md')
  fake.take()
  await face.save()
  assert.deepEqual(fake.take(), [], 'while a conflict is open save does nothing')

  // Reload: theirs, and the edit is gone.
  await face.reload()
  assert.equal(state().open?.conflict, undefined)
  assert.equal(state().open?.draft.body, 'Theirs.\n')
  assert.equal(memoryDirty(state().open!), false)

  // Keep mine: the draft stays, saved over theirs.
  face.edit('body', 'Mine again.\n')
  fake.put('user', 'style', { type: 'feedback', description: 'Terse answers', body: 'Theirs again.\n' })
  await face.save()
  assert.equal(state().open?.conflict?.theirs?.body, 'Theirs again.\n')
  face.keepMine()
  assert.equal(state().open?.conflict, undefined)
  assert.equal(state().open?.draft.body, 'Mine again.\n')
  assert.equal(state().open?.memory?.body, 'Theirs again.\n')
  fake.take()
  await face.save()
  assert.equal(fake.take()[0], `save user style ${id(fake.head - 1).slice(0, 7)}`)
  assert.equal(state().notice?.tone, 'success')
  assert.equal(fake.scopes.get('user')!.get('style')!.body, 'Mine again.\n')
})

test('a new memory whose name exists is a CONFLICT that shows the one there; Keep mine replaces it', async () => {
  const { fake, face, state } = await opened()
  await face.newMemory()
  face.edit('name', 'style')
  face.edit('description', 'Mine')
  face.edit('body', 'Mine.\n')
  await face.save()
  assert.equal(state().open?.conflict?.theirs?.body, 'Keep answers short.\n')
  assert.equal(state().open?.conflict?.diff.status, 'added')
  face.keepMine()
  const theirs = id(fake.head)
  fake.take()
  await face.save()
  assert.equal(fake.take()[0], `save user style ${theirs.slice(0, 7)}`)
  assert.equal(fake.scopes.get('user')!.get('style')!.body, 'Mine.\n')
})

test('INVALID keeps the draft and says what the service said', async () => {
  const { face, state } = await opened()
  await face.openMemory('style')
  face.edit('body', '   ')
  await face.save()
  assert.equal(state().notice?.text, 'Can\'t save: body must not be empty')
  assert.equal(state().open?.draft.body, '   ')
  assert.equal(state().open?.conflict, undefined)
})

test('a live change to the open memory under a dirty draft is a conflict; a clean page takes it', async () => {
  const { fake, face, page, state } = await opened()
  await face.openMemory('style')
  fake.put('user', 'style', { type: 'feedback', description: 'Terse answers', body: 'Changed once.\n' })
  await page.onEvent(changed(['user']), false)
  assert.equal(state().open?.draft.body, 'Changed once.\n', 'clean: the new text is taken')
  assert.equal(state().open?.conflict, undefined)

  face.edit('body', 'My edit.\n')
  fake.put('user', 'style', { type: 'feedback', description: 'Terse answers', body: 'Changed twice.\n' })
  await page.onEvent(changed(['user']), false)
  assert.equal(state().open?.draft.body, 'My edit.\n')
  assert.equal(state().open?.conflict?.theirs?.body, 'Changed twice.\n')

  // Deleted underneath, with the edit: the conflict says so, and Keep mine makes it a new memory again.
  face.keepMine()
  fake.scopes.get('user')!.delete('style')
  await page.onEvent(changed(['user']), false)
  assert.ok(state().open?.conflict !== undefined)
  assert.equal(state().open?.conflict?.theirs, undefined)
  assert.equal(state().open?.conflict?.diff.status, 'deleted')
  face.keepMine()
  assert.equal(state().open?.memory, undefined)
  assert.equal(state().open?.draft.name, 'style')
  fake.take()
  await face.save()
  assert.equal(fake.take()[0], 'save user style -')
})

test('a memory deleted elsewhere closes a clean editor, and says so', async () => {
  const { fake, face, page, state } = await opened()
  await face.openMemory('style')
  fake.scopes.get('user')!.delete('style')
  await page.onEvent(changed(['user']), false)
  assert.equal(state().open, undefined)
  assert.equal(state().notice?.text, 'user/style was deleted elsewhere.')
  assert.deepEqual(state().memories?.map(memory => memory.name), ['quoted'])
})

test('the echo of the page\'s own save, arriving before the save\'s answer, is no conflict', async () => {
  const { fake, face, page, state } = await opened()
  await face.openMemory('style')
  face.edit('body', 'Mine.\n')
  const answer = gate()
  fake.gates.set('save answer', answer)
  const saving = face.save()
  await until('the save to be written', () => fake.scopes.get('user')!.get('style')!.body === 'Mine.\n')
  await page.onEvent(changed(['user']), false)
  assert.equal(state().open?.conflict, undefined)
  answer.release()
  await saving
  assert.equal(state().open?.conflict, undefined)
  assert.equal(memoryDirty(state().open!), false)
  assert.equal(state().notice?.tone, 'success')
})

test('a live change that came while a save was under way is read after a refusal too', async () => {
  const { fake, face, page, state } = await opened()
  await face.openMemory('style')
  face.edit('body', '   ')
  const held = gate()
  fake.gates.set('save', held)
  const saving = face.save()
  await until('the save to be asked for', () => fake.calls.some(call => call.startsWith('save')))
  fake.put('user', 'style', { type: 'feedback', description: 'Terse answers', body: 'Theirs.\n' })
  await page.onEvent(changed(['user']), false)
  assert.equal(state().open?.conflict, undefined, 'not while the save is out')
  held.release()
  await saving
  assert.equal(state().notice?.text, 'Can\'t save: body must not be empty')
  assert.equal(state().open?.conflict?.theirs?.body, 'Theirs.\n')
})

test('the echo of the page\'s own save, handled while the read after it is out, is no conflict; what was typed meanwhile stays unsaved', async () => {
  const { fake, face, page, state } = await opened()
  await face.openMemory('style')
  face.edit('body', 'Saved.\n')
  const answer = gate()
  fake.gates.set('save answer', answer)
  const saving = face.save()
  await until('the save to be written', () => fake.scopes.get('user')!.get('style')!.body === 'Saved.\n')
  face.edit('body', 'Saved.\nAnd more.\n')
  const after = gate()
  fake.gates.set('read style', after)
  answer.release()
  await until('the read after the save', () => fake.calls.filter(call => call === 'read user style').length === 2)
  assert.equal(state().open?.memory?.commit, id(fake.head), 'the base is the save\'s commit before any read')
  await page.onEvent(changed(['user'], id(fake.head)), false)
  assert.equal(state().open?.conflict, undefined)
  assert.equal(state().open?.draft.body, 'Saved.\nAnd more.\n')
  assert.equal(memoryDirty(state().open!), true)
  after.release()
  await saving
  assert.equal(state().open?.conflict, undefined)
  assert.equal(state().open?.draft.body, 'Saved.\nAnd more.\n')
  assert.equal(state().open?.memory?.body, 'Saved.\n')
  assert.equal(memoryDirty(state().open!), true)
  assert.equal(state().notice?.tone, 'success')
})

test('a read after a save that fails leaves the base at the save\'s commit, and the next save goes through', async () => {
  const { fake, face, state } = await opened()
  await face.openMemory('style')
  face.edit('body', 'First.\n')
  fake.down.add('read')
  await face.save()
  const first = id(fake.head)
  assert.equal(state().open?.memory?.commit, first)
  assert.equal(memoryDirty(state().open!), false)
  face.edit('body', 'Second.\n')
  fake.take()
  await face.save()
  assert.equal(fake.take()[0], `save user style ${first.slice(0, 7)}`)
  assert.equal(state().notice?.text, `Saved user/style as ${id(fake.head).slice(0, 7)}`)
  assert.equal(fake.scopes.get('user')!.get('style')!.body, 'Second.\n')
})

test('the same for the direction: its echo is no conflict, and a failed read keeps the base at the save\'s commit', async () => {
  const { fake, face, page, state } = await opened()
  await face.selectScope('family:dish')
  await face.setTab('direction')
  face.editDirection('# Direction\n\nSaved.\n')
  face.setDirectionNote('why')
  const answer = gate()
  fake.gates.set('saveDirection answer', answer)
  const saving = face.saveDirection()
  await until('the direction to be written', () => fake.directions.get('dish')?.text === '# Direction\n\nSaved.\n')
  face.editDirection('# Direction\n\nSaved.\nAnd more.\n')
  const after = gate()
  fake.gates.set('direction dish', after)
  answer.release()
  await until('the read after the save', () => fake.calls.filter(call => call === 'direction dish').length === 2)
  assert.equal(state().direction?.info.commit, id(fake.head))
  assert.equal(state().direction?.info.missing, false)
  await page.onEvent({ kind: 'direction', family: 'dish' }, false)
  assert.equal(state().direction?.conflict, undefined)
  assert.equal(state().direction?.draft, '# Direction\n\nSaved.\nAnd more.\n')
  assert.equal(state().direction?.note, 'why', 'the note stays with the unsaved text')
  assert.equal(directionDirty(state().direction!), true)
  after.release()
  await saving
  assert.equal(state().direction?.conflict, undefined)
  assert.equal(directionDirty(state().direction!), true)

  // The read after the next save fails: the base is that save's commit, and the one after goes through.
  fake.down.add('direction')
  await face.saveDirection()
  const second = id(fake.head)
  assert.equal(state().direction?.info.commit, second)
  assert.equal(state().direction?.note, '')
  assert.equal(directionDirty(state().direction!), false)
  face.editDirection('# Direction\n\nThird.\n')
  fake.take()
  await face.saveDirection()
  assert.equal(fake.take()[0], `saveDirection dish ${second.slice(0, 7)} -`)
  assert.equal(fake.directions.get('dish')!.text, '# Direction\n\nThird.\n')
})

test('a delete question goes with the editor it was asked in', async () => {
  const { face, state } = await opened()
  await face.openMemory('style')
  face.forget()
  assert.deepEqual(state().asking, { kind: 'forget', name: 'style' })
  await face.closeMemory()
  assert.equal(state().asking, undefined)
})

test('leaving a dirty draft asks first: cancel keeps it, confirm discards it', async () => {
  const { face, state } = await opened()
  await face.openMemory('style')
  face.edit('description', 'Mine')
  await face.selectScope('family:dish')
  assert.deepEqual(state().asking, { kind: 'discard', then: { to: 'scope', key: 'family:dish' } })
  assert.equal(state().scope, 'user')
  face.cancel()
  assert.equal(state().asking, undefined)
  assert.equal(state().open?.draft.description, 'Mine')
  await face.closeMemory()
  assert.deepEqual(state().asking, { kind: 'discard', then: { to: 'close' } })
  await face.confirm()
  assert.equal(state().open, undefined)
  assert.equal(state().asking, undefined)
  await face.openMemory('style')
  assert.equal(state().open?.draft.description, 'Terse answers', 'the discarded edit is gone')
  await face.closeMemory()
  assert.equal(state().open, undefined, 'a clean editor closes at once')
})

test('release and forget refresh the list', async () => {
  const { fake, face, state } = await opened()
  assert.equal(state().memories?.find(memory => memory.name === 'quoted')?.held, 'Jev scored it 0.93 as instructions aimed at an agent')
  fake.take()
  await face.release('quoted')
  assert.deepEqual(fake.take(), ['release user quoted', 'list user'])
  assert.equal(state().notice?.text, 'Released user/quoted. Agents see it from their next compaction or chat.')
  assert.equal(state().memories?.find(memory => memory.name === 'quoted')?.held, undefined)
  assert.equal(state().scopes?.[0]?.held, 0, 'the open scope\'s held count comes from its list')

  // Delete asks once, then deletes with the commit the memory was read at.
  await face.openMemory('style')
  const loaded = state().open!.memory!.commit
  face.forget()
  assert.deepEqual(state().asking, { kind: 'forget', name: 'style' })
  assert.ok(!fake.calls.some(call => call.startsWith('forget')))
  fake.take()
  await face.confirm()
  assert.deepEqual(fake.take(), [`forget user style ${loaded.slice(0, 7)}`, 'list user'])
  assert.equal(state().asking, undefined)
  assert.equal(state().open, undefined)
  assert.equal(state().notice?.text, 'Deleted user/style. Agents stop seeing it at their next compaction or chat.')
  assert.deepEqual(state().memories?.map(memory => memory.name), ['quoted'])
  assert.equal(state().scopes?.[0]?.count, 1)

  // From the list: no base. Cancel asks nothing more.
  face.forget('quoted')
  face.cancel()
  assert.equal(state().asking, undefined)
  face.forget('quoted')
  await face.confirm()
  assert.equal(fake.calls.find(call => call.startsWith('forget')), 'forget user quoted -')
  assert.deepEqual(state().memories, [])
})

test('release of a memory that isn\'t held says the service\'s words', async () => {
  const { face, state } = await opened()
  await face.release('style')
  assert.equal(state().notice?.text, 'Can\'t release: user/style isn\'t held')
  assert.equal(state().notice?.tone, 'error')
})

// --- the direction -------------------------------------------------------------------------------

test('the direction: the template when missing, save, conflict', async () => {
  const { fake, face, page, state } = await opened()
  await face.selectScope('family:dish')
  fake.pendingProposals = 2
  await face.setTab('direction')
  assert.equal(state().direction?.info.missing, true)
  assert.equal(state().direction?.draft, DIRECTION_TEMPLATE)
  assert.equal(state().direction?.info.pendingProposals, 2)
  assert.equal(directionDirty(state().direction!), false)
  await face.saveDirection()
  assert.ok(!fake.calls.some(call => call.startsWith('saveDirection')), 'the bare template is not saved')

  face.editDirection('# Direction\n\nShip memory.\n')
  face.setDirectionNote('first cut')
  const base = state().direction!.info.commit
  fake.take()
  await face.saveDirection()
  assert.equal(fake.take()[0], `saveDirection dish ${base.slice(0, 7)} first cut`)
  assert.equal(state().notice?.text, `Saved the direction for dish as ${id(fake.head).slice(0, 7)}`)
  assert.equal(state().direction?.info.missing, false)
  assert.equal(state().direction?.info.text, '# Direction\n\nShip memory.\n')
  assert.equal(state().direction?.note, '')
  assert.equal(directionDirty(state().direction!), false)

  // A save that hits a change made elsewhere keeps the draft and shows theirs.
  face.editDirection('# Direction\n\nMine.\n')
  fake.putDirection('dish', '# Direction\n\nTheirs.\n')
  await face.saveDirection()
  assert.equal(state().notice?.text, 'The direction changed since you loaded it. Your text is still in the editor.')
  assert.equal(state().direction?.draft, '# Direction\n\nMine.\n')
  assert.equal(state().direction?.conflict?.theirs, '# Direction\n\nTheirs.\n')
  assert.equal(state().direction?.conflict?.diff.path, 'families/dish/direction.md')
  face.keepMine('direction')
  assert.equal(state().direction?.conflict, undefined)
  assert.equal(state().direction?.info.text, '# Direction\n\nTheirs.\n')
  await face.saveDirection()
  assert.equal(fake.directions.get('dish')!.text, '# Direction\n\nMine.\n')

  // A live change: with an edit, a conflict; reloadDirection drops the edit.
  face.editDirection('# Direction\n\nAn edit.\n')
  fake.putDirection('dish', '# Direction\n\nElsewhere.\n')
  await page.onEvent({ kind: 'direction', family: 'dish' }, false)
  assert.equal(state().direction?.conflict?.theirs, '# Direction\n\nElsewhere.\n')
  await face.reloadDirection()
  assert.equal(state().direction?.conflict, undefined)
  assert.equal(state().direction?.draft, '# Direction\n\nElsewhere.\n')
  // Clean: a live change is taken; one for another family is not this page's.
  fake.putDirection('dish', '# Direction\n\nAgain.\n')
  await page.onEvent({ kind: 'direction', family: 'dish' }, false)
  assert.equal(state().direction?.draft, '# Direction\n\nAgain.\n')
  fake.take()
  await page.onEvent({ kind: 'direction', family: 'other' }, false)
  assert.deepEqual(fake.take(), [])
})

test('a dirty direction is asked about before another scope is opened', async () => {
  const { face, state } = await opened()
  await face.selectScope('family:dish')
  await face.setTab('direction')
  face.editDirection('# Direction\n\nMine.\n')
  await face.selectScope('user')
  assert.deepEqual(state().asking, { kind: 'discard', then: { to: 'scope', key: 'user' } })
  await face.confirm()
  assert.equal(state().scope, 'user')
  assert.equal(state().direction, undefined)
})

// --- history -------------------------------------------------------------------------------------

test('history pages by 20 and opens a commit; revert asks and refreshes', async () => {
  const { fake, face, state } = await opened()
  for (let n = 0; n < 23; n++) fake.put('user', `note-${n}`, { type: 'project', description: `Note ${n}`, body: `${n}\n` })
  // 2 memories of You's from the start, and 23 more: 25 commits.
  fake.take()
  await face.setTab('history')
  assert.equal(HISTORY_PAGE, 20)
  assert.deepEqual(fake.take(), ['history user -'])
  assert.equal(state().history?.commits.length, 20)
  assert.equal(state().history?.more, true)
  const last = state().history!.commits[19]!.id
  await face.loadHistory(true)
  assert.deepEqual(fake.take(), [`history user ${last.slice(0, 7)}`])
  assert.equal(state().history?.commits.length, 25)
  assert.equal(state().history?.more, false)

  const newest = state().history!.commits[0]!
  await face.loadCommit(newest.id)
  assert.equal(state().history?.detail?.info.id, newest.id)
  assert.equal(state().history?.detail?.diffs.length, 1)
  await face.loadCommit(newest.id)
  assert.equal(state().history?.detail, undefined, 'a second time closes it')

  fake.reverts.push({ id: id(99), time: 1, author: { kind: 'user' }, message: 'revert', paths: [newest.paths[0]!] })
  fake.take()
  face.revert(newest.id)
  assert.deepEqual(state().asking, { kind: 'revert', id: newest.id })
  assert.deepEqual(fake.take(), [], 'nothing is reverted before the person says so')
  await face.confirm()
  const calls = fake.take()
  assert.equal(calls[0], `revert ${newest.id.slice(0, 7)}`)
  assert.ok(calls.includes('history user -') && calls.includes('list user'), calls.join(', '))
  assert.equal(state().notice?.text, `Reverted ${newest.id.slice(0, 7)} with a new commit, ${id(99).slice(0, 7)}`)
  assert.equal(state().busy, undefined)

  face.revert(newest.id)
  await face.confirm()
  assert.equal(state().notice?.text, 'Already reverted — nothing to do')
  fake.reverts.push('conflict')
  face.revert(newest.id)
  await face.confirm()
  assert.equal(state().notice?.text, 'A later change touched the same memory — revert that change first, or edit the memory directly.')
})

test('a live change on the History tab adds the new commits on top, and keeps the older pages, the commit open and a revert asked about', async () => {
  const { fake, face, page, state } = await opened()
  for (let n = 0; n < 23; n++) fake.put('user', `note-${n}`, { type: 'project', description: `Note ${n}`, body: `${n}\n` })
  await face.setTab('history')
  await face.loadHistory(true)
  assert.equal(state().history?.commits.length, 25)
  const old = state().history!.commits[22]!
  await face.loadCommit(old.id)
  face.revert(old.id)
  fake.put('user', 'late', { type: 'user', description: 'Late', body: 'Late.\n' })
  fake.take()
  await page.onEvent(changed(['user'], id(fake.head)), false)
  assert.ok(fake.take().includes('history user -'))
  assert.equal(state().history?.commits.length, 26)
  assert.equal(state().history?.commits[0]?.id, id(fake.head))
  assert.equal(state().history?.commits[23]?.id, old.id)
  assert.equal(state().history?.more, false)
  assert.equal(state().history?.detail?.info.id, old.id)
  assert.deepEqual(state().asking, { kind: 'revert', id: old.id })

  // More than a page of new commits: the newest page takes the log's place.
  face.cancel()
  for (let n = 0; n < 21; n++) fake.put('user', `burst-${n}`, { type: 'project', description: `Burst ${n}`, body: `${n}\n` })
  await page.onEvent(changed(['user'], id(fake.head)), false)
  assert.equal(state().history?.commits.length, 20)
  assert.equal(state().history?.commits[0]?.id, id(fake.head))
  assert.equal(state().history?.more, true)
  assert.equal(state().history?.detail, undefined)
})

test('a live change while an older page is out keeps both: the new commit on top, the older page below', async () => {
  const { fake, face, page, state } = await opened()
  for (let n = 0; n < 23; n++) fake.put('user', `note-${n}`, { type: 'project', description: `Note ${n}`, body: `${n}\n` })
  await face.setTab('history')
  const older = gate()
  fake.gates.set('history', older)
  const more = face.loadHistory(true)
  await until('the older page to be asked for', () => fake.calls.some(call => call.startsWith('history user c')))
  assert.equal(state().history?.loadingMore, true)
  fake.put('user', 'late', { type: 'user', description: 'Late', body: 'Late.\n' })
  await page.onEvent(changed(['user'], id(fake.head)), false)
  older.release()
  await more
  assert.equal(state().history?.commits.length, 26)
  assert.equal(state().history?.commits[0]?.id, id(fake.head))
  assert.equal(new Set(state().history!.commits.map(commit => commit.id)).size, 26)
  assert.equal(state().history?.loadingMore, false)
  assert.equal(state().history?.more, false)
})

// --- the preview ---------------------------------------------------------------------------------

test('the preview is the composed text, \'\' when there is none, and a change reads it again', async () => {
  const { fake, face, page, state } = await opened()
  await face.setTab('preview')
  assert.equal(state().preview, '')
  fake.previews.set('user', '<dish-memory>\nYour user:\n- user/style — Terse answers (feedback)\n</dish-memory>')
  await page.onEvent(changed(['user']), false)
  assert.match(state().preview!, /user\/style/)
  // A family's preview has the user's memory in it, so a change to You reads it again.
  await face.selectScope('family:dish')
  fake.take()
  await page.onEvent(changed(['user']), false)
  assert.ok(fake.take().includes('preview family:dish'))
})

// --- late answers and the stream -----------------------------------------------------------------

test('a late answer for another scope is dropped', async () => {
  const { fake, face, state } = await opened()
  const held = gate()
  fake.gates.set('list family:dish', held)
  const first = face.selectScope('family:dish')
  await until('the list to be asked for', () => fake.calls.includes('list family:dish'))
  await face.selectScope('family:old')
  assert.deepEqual(state().memories?.map(memory => memory.name), ['gone'])
  held.release()
  await first
  assert.equal(state().scope, 'family:old')
  assert.deepEqual(state().memories?.map(memory => memory.name), ['gone'], 'dish\'s answer came after old was opened')
})

test('a late read of a memory is dropped when another was opened or the editor was closed', async () => {
  const { fake, face, state } = await opened()
  const held = gate()
  fake.gates.set('read style', held)
  const first = face.openMemory('style')
  await until('the read to be asked for', () => fake.calls.includes('read user style'))
  await face.openMemory('quoted')
  held.release()
  await first
  assert.equal(state().open?.memory?.name, 'quoted')
})

test('a changed event for the open scope reads its list, not every scope; one for another scope reads the scopes', async () => {
  const { fake, page, state } = await opened()
  fake.put('user', 'more', { type: 'user', description: 'More', body: 'More.\n' })
  fake.take()
  await page.onEvent(changed(['user']), false)
  assert.deepEqual(fake.take(), ['list user'])
  assert.equal(state().scopes?.[0]?.count, 3)
  fake.put('family:dish', 'more', { type: 'project', description: 'More', body: 'More.\n' })
  await page.onEvent(changed(['family:dish']), false)
  assert.deepEqual(fake.take(), ['scopes'])
  assert.equal(state().scopes?.[1]?.count, 2)
})

test('scopes are never read twice at once: a burst of events reads them once more after the one under way', async () => {
  const { fake, page } = await opened()
  const held = gate()
  fake.gates.set('scopes', held)
  fake.take()
  const events = [1, 2, 3, 4].map(() => page.onEvent(changed(['family:dish']), false))
  await until('the scopes to be asked for', () => fake.calls.includes('scopes'))
  held.release()
  await Promise.all(events)
  assert.deepEqual(fake.take(), ['scopes', 'scopes'])
})

test('the stream going down and up re-reads everything', async () => {
  const { fake, face, page, state } = await opened()
  await face.openMemory('style')
  await page.onEvent({ kind: 'remote', status: { pending: 1 } }, true)
  assert.equal(state().stream, 'live')
  assert.deepEqual(state().remote, { pending: 1 })
  page.streamDown()
  assert.equal(state().stream, 'down')
  fake.put('user', 'style', { type: 'feedback', description: 'Terse answers', body: 'Changed while down.\n' })
  fake.put('family:dish', 'new', { type: 'project', description: 'New', body: 'New.\n' })
  fake.take()
  await page.onEvent({ kind: 'remote', status: { remote: 'r', pending: 0 } }, true)
  assert.equal(state().stream, 'live')
  assert.deepEqual(state().remote, { remote: 'r', pending: 0 })
  assert.deepEqual(fake.take().sort(), ['list user', 'read user style', 'scopes'])
  assert.equal(state().open?.draft.body, 'Changed while down.\n')
  assert.equal(state().scopes?.[1]?.count, 2)
})

test('before the page is opened, the stream only sets the remote line', async () => {
  const { fake, page, state } = setup()
  assert.equal(state().stream, 'connecting')
  await page.onEvent({ kind: 'remote', status: { pending: 3 } }, true)
  await page.onEvent(changed(['user']), false)
  assert.deepEqual(fake.take(), [])
  assert.deepEqual(state().remote, { pending: 3 })
  assert.equal(state().stream, 'live')
  assert.equal(state().scopes, undefined)
})

test('dismiss clears the notice, and the face is the actions and the observable', async () => {
  const { face, state } = await opened()
  await face.release('style')
  assert.ok(state().notice !== undefined)
  let heard = 0
  const unsubscribe = face.hooks.page.subscribe(() => { heard++ })
  face.dismiss()
  assert.equal(state().notice, undefined)
  assert.equal(face.hooks.page.getSnapshot(), state())
  assert.equal(heard, 1)
  unsubscribe()
  assert.deepEqual(Object.keys(face).sort(), [
    'cancel', 'closeMemory', 'confirm', 'dismiss', 'edit', 'editDirection', 'forget', 'hooks', 'keepMine', 'loadCommit', 'loadHistory',
    'loadPreview', 'newMemory', 'open', 'openMemory', 'release', 'reload', 'reloadDirection', 'revert', 'save', 'saveDirection',
    'selectScope', 'setDirectionNote', 'setTab',
  ])
})
