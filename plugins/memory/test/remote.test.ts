/**
 * `MemoryRemote`, Settings → Memory's server half, over a real service: a vault in a temporary directory (`memoryWorld`),
 * provided as `dishMemory` by a stub plugin, with dish's other services faked and the config store a real one of its own.
 * The plugin's own wiring, and the stream's events from real commits, run with dish-config's and dish-memory's real plugins.
 */

import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import * as configPlugin from 'dish-config'
import { StoreError } from 'dish-kit/store'
import * as plugin from '../src/index.ts'
import { DIRECTION_TEMPLATE } from '../src/protocol.ts'
import type { ErrorCode, MemoryEvent, Outcome, RemoteStatus } from '../src/protocol.ts'
import { MemoryRemote } from '../src/remote.ts'
import { MemoryError } from '../src/service.ts'
import type { DishMemory } from '../src/service.ts'
import { ACME, AS_AGENT, COMMIT, MODIFIED, bareRemote, fakeJudge, input, memoryWorld, tempDir, waitFor } from './helpers.ts'

const WARN = { verdict: 'warn', probability: 0.734 } as const
const HELD_WARN = 'Jev scored it 0.73 as instructions aimed at an agent'
/** Text that must never reach an error's message. */
const MARKER = 'UNTRUSTED-MARKER'
const USER_AUTHOR = { kind: 'user' } as const

// --- helpers ------------------------------------------------------------------------------------

/** Provide `value` as the service `name` from a sibling plugin, the way dsh's plugins provide theirs. */
function provideStub(ctx: Context, name: string, value: unknown) {
  return ctx.plugin({
    name: `stub-${name}`,
    apply(own: Context) { (own as unknown as { provide(name: string, value: unknown): void }).provide(name, value) },
  } as never, undefined as never)
}

/** Run `body` with `MemoryRemote` mounted over `service` as `dishMemory`, and unload both however `body` ends. */
async function withRemote<T>(service: DishMemory, body: (remote: MemoryRemote, ctx: Context) => Promise<T>): Promise<T> {
  const ctx = new Context()
  const stub = provideStub(ctx, 'dishMemory', service)
  const handle = ctx.plugin(MemoryRemote)
  try {
    await Promise.all([stub, handle])
    const remote = await waitFor('the remote', () => ctx.get('dishMemoryRemote') as MemoryRemote | undefined)
    return await body(remote, ctx)
  } finally {
    await handle.dispose()
    await stub.dispose()
  }
}

function mountMemory(ctx: Context, config: Partial<plugin.Config>) {
  return ctx.plugin(plugin, { terminal: false, userName: 'Test User', userEmail: 'user@test', ...config } as plugin.Config)
}

function mountConfig(ctx: Context, repository: string) {
  return ctx.plugin(configPlugin, { terminal: false, repository, userName: 'Test User', userEmail: 'user@test' } as configPlugin.Config)
}

/** The value of a call that succeeded. */
function ok<T>(outcome: Outcome<T>): T {
  assert.ok(outcome.ok, JSON.stringify(outcome))
  return outcome.value
}

/** Assert that a call failed with `code`, as a result and not a throw; the message is returned. */
function failed(outcome: Outcome<unknown>, code: ErrorCode): string {
  assert.ok(!outcome.ok, `expected ${code}, got ${JSON.stringify(outcome)}`)
  assert.equal(outcome.code, code, outcome.message)
  assert.equal(typeof outcome.message, 'string')
  return outcome.message
}

/** What the wire sees of `value`: JSON, with nothing `undefined` in it. Anything else would be mangled by the encoding. */
function plain(value: unknown): void {
  assert.deepStrictEqual(value, JSON.parse(JSON.stringify(value)))
}

const EVENTS = ['dish-memory/changed', 'dish-config/changed', 'dish-memory/remote']

/** The listeners for each of the stream's three events, by looking into the event bus (the only way to see a listener leak). */
function listeners(ctx: Context): Record<string, number> {
  const hooks = (ctx as unknown as { events: { _hooks: Record<string, unknown[] | undefined> } }).events._hooks
  return Object.fromEntries(EVENTS.map(name => [name, hooks[name]?.length ?? 0]))
}

type Watching = { next(): Promise<IteratorResult<MemoryEvent>>, abort(): void, it: AsyncIterator<MemoryEvent> }

function watching(remote: MemoryRemote): Watching {
  const controller = new AbortController()
  const it = remote.watch(controller.signal)[Symbol.asyncIterator]()
  return { it, abort: () => { controller.abort() }, next: () => it.next() }
}

const TIMEOUT = Symbol('timeout')

/** The next result of `it`, or `TIMEOUT` if it takes longer than `ms`. */
async function within(it: AsyncIterator<MemoryEvent>, ms: number): Promise<IteratorResult<MemoryEvent> | typeof TIMEOUT> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<typeof TIMEOUT>((resolve) => { timer = setTimeout(() => { resolve(TIMEOUT) }, ms) })
  try {
    return await Promise.race([it.next(), timeout])
  } finally {
    clearTimeout(timer)
  }
}

/** The next event, which must come soon. */
async function event(it: AsyncIterator<MemoryEvent>): Promise<MemoryEvent> {
  const result = await within(it, 10_000)
  assert.notEqual(result, TIMEOUT, 'timed out waiting for an event')
  assert.ok(result !== TIMEOUT && !result.done, 'the stream ended')
  return result.value
}

/** Events until `want` matches one, which is returned; those before it are skipped. */
async function until(it: AsyncIterator<MemoryEvent>, want: (event: MemoryEvent) => boolean): Promise<MemoryEvent> {
  for (;;) {
    const next = await event(it)
    if (want(next)) return next
  }
}

/** Exactly `count` events, which must all be there; then the stream must have nothing more to say for a moment. */
async function take(it: AsyncIterator<MemoryEvent>, count: number): Promise<MemoryEvent[]> {
  const seen: MemoryEvent[] = []
  while (seen.length < count) seen.push(await event(it))
  assert.equal(await within(it, 60), TIMEOUT, 'no more events than expected')
  return seen
}

// --- the wire contract ---------------------------------------------------------------------------

const METHODS = [
  'scopes', 'list', 'read', 'save', 'forget', 'release', 'direction', 'saveDirection', 'history', 'commit', 'revert', 'preview',
  'remoteStatus', 'watch',
]

test('the plugin mounts MemoryRemote as dishMemoryRemote under the dishMemory namespace, marking every method (watch as a stream)', async () => {
  const dir = await tempDir()
  const ctx = new Context()
  const handle = mountMemory(ctx, { vault: join(dir, 'vault.git') })
  try {
    await handle
    const remote = await waitFor('the remote', () => ctx.get('dishMemoryRemote') as MemoryRemote | undefined)
    assert.equal(remote.typertRemote.serviceKey, 'dishMemoryRemote')
    assert.equal(remote.typertRemote.namespace, 'dishMemory')
    assert.ok(remote.typertRemote.service instanceof MemoryRemote)

    const marks = remoteMethods(remote)
    assert.deepEqual(marks.map(mark => mark.method).sort(), [...METHODS].sort())
    for (const mark of marks) {
      assert.deepEqual(mark.invocation, { kind: 'direct' }, mark.method)
      assert.equal(mark.mode, mark.method === 'watch' ? 'stream' : undefined, mark.method)
      assert.equal(mark.exportName, undefined, mark.method)
    }
    // Nothing public is left unmarked: what the page can't call it must not look like it can.
    const own = Object.getOwnPropertyNames(MemoryRemote.prototype)
      .filter(key => key !== 'constructor' && typeof (MemoryRemote.prototype as unknown as Record<string, unknown>)[key] === 'function')
    assert.deepEqual(own.sort(), [...METHODS].sort())

    // It goes with the service.
    await handle.dispose()
    assert.equal(ctx.get('dishMemoryRemote'), undefined)
  } finally {
    await handle.dispose()
  }
})

/** The gateway's source-mode reading of a method's parameter names: the text between its first parentheses, split on commas. */
function parameterNames(method: (...args: never[]) => unknown): string[] {
  const source = Function.prototype.toString.call(method)
  const open = source.indexOf('(')
  const body = source.slice(open + 1, source.indexOf(')', open + 1)).trim()
  return body === '' ? [] : body.split(',').map(part => part.trim())
}

test('the gateway can read every method\'s parameter names from source; signal is last, and only on the stream', () => {
  for (const method of METHODS) {
    const names = parameterNames((MemoryRemote.prototype as unknown as Record<string, (...args: never[]) => unknown>)[method]!)
    for (const name of names) assert.match(name, /^[$A-Z_a-z][$\w]*$/u, `${method}: ${name}`)
    // dsh resolves a parameter named `session` or `agent` to an object: none of these may be one.
    for (const name of names) assert.ok(!['session', 'agent', 'workspaceFileScope'].includes(name), `${method}: ${name}`)
    assert.equal(names.indexOf('signal'), method === 'watch' ? names.length - 1 : -1, method)
  }
})

// --- the calls -----------------------------------------------------------------------------------

test('each method over a real service: the happy path', async () => {
  const world = await memoryWorld({
    projects: [{ name: 'acme/widget', family: 'acme', role: 'the widget' }],
    clones: {},
    config: true,
    judge: fakeJudge([WARN]),
  })
  await withRemote(world.memory, async (remote) => {
    const status = ok(await remote.remoteStatus())
    assert.deepEqual(status, { pending: 0 })

    // A new memory, as the user.
    const created = ok(await remote.save('user', 'tabs', 'feedback', 'Tabs, not spaces', 'Why: the user said so.', ''))
    assert.match(created.id, COMMIT)
    assert.deepEqual(created.author, USER_AUTHOR)
    assert.deepEqual(created.paths, ['user/MEMORY.md', 'user/tabs.md'])
    assert.equal(created.note, 'user/tabs: Tabs, not spaces')
    plain(created)

    const tabs = { scope: 'user', name: 'tabs', type: 'feedback', description: 'Tabs, not spaces', modified: MODIFIED }
    const listed = ok(await remote.list('user'))
    assert.deepEqual(listed, [tabs])
    plain(listed)
    const read = ok(await remote.read('user', 'tabs'))
    assert.deepEqual(read, { ...tabs, body: 'Why: the user said so.', commit: created.id })
    plain(read)
    assert.equal(ok(await remote.read('user', 'nothing')), null)

    // An agent's memory, held by the screen, and released by the user.
    await world.memory.write(ACME, input('steer'), AS_AGENT)
    const scopes = ok(await remote.scopes())
    assert.deepEqual(scopes, [
      { key: 'user', label: 'You', count: 1, held: 0, orphan: false },
      { key: 'family:acme', label: 'acme', count: 1, held: 1, orphan: false },
    ])
    plain(scopes)
    assert.deepEqual(ok(await remote.list('family:acme')).map(memory => memory.held), [HELD_WARN])
    assert.ok(!ok(await remote.preview('family:acme')).text.includes('family/steer'), 'a held memory is out of the message')
    const released = ok(await remote.release('family:acme', 'steer'))
    assert.deepEqual(released.author, USER_AUTHOR)
    assert.deepEqual(released.paths, ['families/acme/MEMORY.md', 'families/acme/steer.md'])
    assert.deepEqual(ok(await remote.list('family:acme')).map(memory => memory.held), [undefined])

    // The preview: a main agent in this scope, so the user's memory comes with a family's.
    const userPreview = ok(await remote.preview('user'))
    assert.ok(userPreview.text.startsWith('<dish-memory>'), userPreview.text)
    assert.ok(userPreview.text.includes('- user/tabs — Tabs, not spaces (feedback)'), userPreview.text)
    assert.ok(!userPreview.text.includes('family/steer'), userPreview.text)
    const familyPreview = ok(await remote.preview('family:acme')).text
    for (const line of ['- user/tabs — Tabs, not spaces (feedback)', '- family/steer — About steer (feedback)', '- acme/widget — the widget']) {
      assert.ok(familyPreview.includes(line), `${line} in ${familyPreview}`)
    }

    // The direction: the template while there's none, then the user's.
    const missing = ok(await remote.direction('acme'))
    assert.deepEqual(missing, { family: 'acme', text: DIRECTION_TEMPLATE, commit: missing.commit, missing: true, pendingProposals: 0 })
    assert.match(missing.commit, COMMIT)
    const steered = ok(await remote.saveDirection('acme', '# Direction\n\nShip it.\n', missing.commit, 'first'))
    assert.ok(steered !== null)
    assert.deepEqual(steered.author, USER_AUTHOR)
    assert.deepEqual(steered.paths, ['families/acme/direction.md'])
    assert.equal(steered.note, 'first')
    plain(steered)
    // The same text again changes nothing.
    assert.equal(ok(await remote.saveDirection('acme', '# Direction\n\nShip it.\n', '', '')), null)
    const direction = ok(await remote.direction('acme'))
    assert.deepEqual(direction, { family: 'acme', text: '# Direction\n\nShip it.\n', commit: steered.id, missing: false, pendingProposals: 0 })
    assert.ok(ok(await remote.preview('family:acme')).text.includes('Ship it.'))

    // Forget, then the history of the scope, a commit's diff, and a revert.
    const forgotten = ok(await remote.forget('user', 'tabs', read!.commit))
    assert.deepEqual(forgotten.author, USER_AUTHOR)
    assert.deepEqual(forgotten.paths, ['user/MEMORY.md', 'user/tabs.md'])
    assert.deepEqual(ok(await remote.list('user')), [])
    assert.deepEqual(ok(await remote.preview('user')), { text: '' })

    const history = ok(await remote.history('user', ''))
    assert.deepEqual(history.map(commit => commit.id), [forgotten.id, created.id])
    plain(history)
    assert.deepEqual(ok(await remote.history('user', forgotten.id)).map(commit => commit.id), [created.id])
    const detail = ok(await remote.commit(forgotten.id))
    assert.equal(detail.info.id, forgotten.id)
    assert.deepEqual(detail.diffs.map(diff => [diff.path, diff.status]), [['user/MEMORY.md', 'deleted'], ['user/tabs.md', 'deleted']])
    plain(detail)
    const reverted = ok(await remote.revert(forgotten.id))
    assert.ok(reverted !== null)
    assert.deepEqual(reverted.author, USER_AUTHOR)
    assert.equal(ok(await remote.read('user', 'tabs'))?.body, 'Why: the user said so.')
    // Undone already: nothing left to do.
    assert.equal(ok(await remote.revert(forgotten.id)), null)
    assert.equal(failed(await remote.commit('nope'), 'NOT_FOUND'), 'no such ref "nope": use "main" or a full commit id')
  })
})

test('history: 20 at a time, and before pages on', async () => {
  const world = await memoryWorld()
  for (let i = 0; i < 21; i++) await world.memory.write(ACME, input(`m${i}`), { author: { kind: 'user' } })
  await world.memory.write({ kind: 'user' }, input('elsewhere'), { author: { kind: 'user' } })
  await withRemote(world.memory, async (remote) => {
    const first = ok(await remote.history('family:acme', ''))
    assert.equal(first.length, 20)
    assert.ok(first.every(commit => commit.paths.every(path => path.startsWith('families/acme/'))))
    const rest = ok(await remote.history('family:acme', first.at(-1)!.id))
    assert.equal(rest.length, 1)
    assert.equal(rest[0]?.note, 'family/m0: About m0')
    // A missing argument is an absent one: the newest page.
    assert.deepEqual(ok(await remote.history('family:acme', undefined as never)), first)
  })
})

test('save: create, replace, CONFLICT on a stale base and on an existing name', async () => {
  const world = await memoryWorld()
  await withRemote(world.memory, async (remote) => {
    ok(await remote.save('user', 'a', 'feedback', 'First', 'One.', ''))
    // `base` '' is a new memory: the name is taken.
    assert.equal(failed(await remote.save('user', 'a', 'feedback', 'Again', 'Two.', ''), 'CONFLICT'), 'user/a already exists')
    const loaded = ok(await remote.read('user', 'a'))!

    // Another memory's change is no conflict.
    ok(await remote.save('user', 'b', 'project', 'Other', 'Else.', ''))
    const replaced = ok(await remote.save('user', 'a', 'reference', 'Second', 'Two.', loaded.commit))
    assert.deepEqual(replaced.paths, ['user/MEMORY.md', 'user/a.md'])
    const now = ok(await remote.read('user', 'a'))!
    assert.deepEqual([now.type, now.description, now.body, now.commit], ['reference', 'Second', 'Two.', replaced.id])

    // The first load is stale now, for a save and for a forget.
    assert.equal(failed(await remote.save('user', 'a', 'feedback', 'Third', 'Three.', loaded.commit), 'CONFLICT'), 'user/a changed since you loaded it')
    assert.equal(failed(await remote.forget('user', 'a', loaded.commit), 'CONFLICT'), 'user/a changed since you loaded it')
    assert.equal(ok(await remote.read('user', 'a'))?.description, 'Second')

    // A forget without a base (`''`, or the argument left out) takes it as it is.
    ok(await remote.forget('user', 'a', ''))
    ok(await remote.forget('user', 'b', undefined as never))
    assert.equal(failed(await remote.forget('user', 'a', ''), 'NOT_FOUND'), 'no memory user/a')
    // Saving over a memory forgotten since its load is a conflict too.
    assert.equal(failed(await remote.save('user', 'a', 'feedback', 'Back', 'Again.', now.commit), 'CONFLICT'), 'user/a changed since you loaded it')

    // The input's rules and the secret check: the message names the rule, never the text.
    for (const [code, call] of [
      ['INVALID', remote.save('user', 'c', 'feedback', `${MARKER} one\nand two`, 'Body.', '')],
      ['INVALID', remote.save('user', 'c', 'opinion', 'One line', `${MARKER}.`, '')],
      ['INVALID', remote.save('user', 'Not A Name', 'feedback', 'One line', `${MARKER}.`, '')],
      ['INVALID', remote.save('user', 'c', 'feedback', 'One line', '', '')],
      ['SECRET', remote.save('user', 'c', 'reference', 'The token', `${MARKER} ghp_${'a1B2'.repeat(9)}`, '')],
    ] as const) {
      const message = failed(await call, code)
      assert.ok(!message.includes(MARKER), message)
    }
    // A parameter that isn't a string is INVALID, not a TypeError.
    assert.equal(failed(await remote.save('user', 'c', 'feedback', 'One line', 42 as never, ''), 'INVALID'), 'body must be a string')
    assert.equal(failed(await remote.read('user', ['a'] as never), 'INVALID'), 'name must be a string')
    assert.deepEqual(ok(await remote.list('user')), [])
  })
})

test('INVALID for a bad scope key', async () => {
  const world = await memoryWorld()
  await withRemote(world.memory, async (remote) => {
    for (const key of ['', 'users', 'User', ' user', 'family', 'family:', 'family:Acme', 'family:a/b', 'family:-a', 'families/acme']) {
      const results = await Promise.all([
        remote.list(key), remote.read(key, 'a'), remote.save(key, 'a', 'feedback', 'One line', 'Body.', ''), remote.forget(key, 'a', ''),
        remote.release(key, 'a'), remote.history(key, ''), remote.preview(key),
      ])
      for (const result of results) assert.equal(failed(result, 'INVALID'), `no scope ${JSON.stringify(key)}`)
    }
    // Left out, it's `''`; not a string, it's said so.
    assert.equal(failed(await remote.list(undefined as never), 'INVALID'), 'no scope ""')
    assert.equal(failed(await remote.list(42 as never), 'INVALID'), 'scope must be a string')
    // A family that can't be one, for the direction.
    assert.match(failed(await remote.direction('Acme'), 'INVALID'), /^family must be a lowercase name/)
    // Nothing was written.
    assert.deepEqual(world.events, [])
  })
})

test('UNAVAILABLE without dishConfig for direction', async () => {
  const world = await memoryWorld()
  await withRemote(world.memory, async (remote) => {
    assert.equal(failed(await remote.direction('acme'), 'UNAVAILABLE'), 'the config store isn\'t running')
    assert.equal(failed(await remote.saveDirection('acme', '# Direction\n\nShip it.\n', '', 'why'), 'UNAVAILABLE'), 'the config store isn\'t running')
    // Memories work all the same, and the preview leaves the direction out.
    ok(await remote.save('family:acme', 'a', 'project', 'About a', 'What a says.', ''))
    assert.ok(ok(await remote.preview('family:acme')).text.includes('- family/a — About a (project)'))
  })
})

test('a refusal is a result, whoever made it; anything else is thrown', async () => {
  let failure: unknown
  const service = { scopes: async () => { throw failure } } as unknown as DishMemory
  await withRemote(service, async (remote) => {
    failure = new MemoryError('NOT_FOUND', 'no memory user/a')
    assert.deepEqual(await remote.scopes(), { ok: false, code: 'NOT_FOUND', message: 'no memory user/a' })
    failure = new StoreError('LOCKED', 'the vault is locked')
    assert.deepEqual(await remote.scopes(), { ok: false, code: 'LOCKED', message: 'the vault is locked' })
    // A store's refusal from another copy of dish-kit is known by its code.
    failure = Object.assign(new Error('changed since'), { code: 'CONFLICT' })
    assert.deepEqual(await remote.scopes(), { ok: false, code: 'CONFLICT', message: 'changed since' })
    for (const other of [new Error('boom'), Object.assign(new Error('gone'), { code: 'ENOENT' }), 'a string']) {
      failure = other
      await assert.rejects(remote.scopes(), (error: unknown) => error === other)
    }
  })
})

// --- watch ---------------------------------------------------------------------------------------

test('watch: remote first, changed after a save, direction after a config change, ends on abort', async () => {
  const dir = await tempDir()
  const ctx = new Context()
  const config = mountConfig(ctx, join(dir, 'config.git'))
  await config
  const memory = mountMemory(ctx, { vault: join(dir, 'vault.git') })
  try {
    await memory
    const remote = await waitFor('the remote', () => ctx.get('dishMemoryRemote') as MemoryRemote | undefined)
    const before = listeners(ctx)
    const watch = watching(remote)
    assert.deepEqual(await event(watch.it), { kind: 'remote', status: { pending: 0 } })
    const during = listeners(ctx)
    for (const name of EVENTS) assert.equal(during[name], before[name]! + 1, name)

    const saved = ok(await remote.save('user', 'a', 'feedback', 'About a', 'What a says.', ''))
    assert.deepEqual(await event(watch.it), { kind: 'changed', commit: saved.id, scopes: ['user'] })

    // The families/ claim is made once dishConfig is there; a save it refuses commits nothing, so tells nothing.
    await waitFor('the families/ claim', async () => {
      const result = await remote.saveDirection('acme', '# Direction\n\nShip it.\n', '', '')
      return result.ok && result.value !== null
    })
    assert.deepEqual(await event(watch.it), { kind: 'direction', family: 'acme' })

    const family = ok(await remote.save('family:acme', 'b', 'project', 'About b', 'What b says.', ''))
    assert.deepEqual(await event(watch.it), { kind: 'changed', commit: family.id, scopes: ['family:acme'] })
    const reverted = ok(await remote.revert(family.id))
    assert.deepEqual(await event(watch.it), { kind: 'changed', commit: reverted?.id, scopes: ['family:acme'] })

    // Parked waiting for an event, the stream ends as soon as the signal aborts, and its listeners go with it.
    const parked = watch.next()
    watch.abort()
    assert.deepEqual(await parked, { done: true, value: undefined })
    assert.deepEqual(listeners(ctx), before)
    ok(await remote.save('user', 'c', 'feedback', 'About c', 'What c says.', ''))
    assert.deepEqual(await watch.next(), { done: true, value: undefined })

    // A stream whose signal is aborted already never listens at all.
    const late = new AbortController()
    late.abort()
    const lateEvents: MemoryEvent[] = []
    for await (const item of remote.watch(late.signal)) lateEvents.push(item)
    assert.deepEqual(lateEvents, [])
    // Closing the iterator early (the gateway does that when the page goes) removes the listeners too.
    const closed = watching(remote)
    await event(closed.it)
    assert.deepEqual(await closed.it.return!(), { done: true, value: undefined })
    assert.deepEqual(listeners(ctx), before)
  } finally {
    await memory.dispose()
    await config.dispose()
  }
})

test('watch: a direction is told once per family a config commit touched, and nothing else of the config store is', async () => {
  const world = await memoryWorld()
  await withRemote(world.memory, async (remote, ctx) => {
    const watch = watching(remote)
    await event(watch.it)
    ctx.emit('dish-config/changed', ['crew.yaml', 'families/acme/notes.md', 'families/Acme/direction.md', 'families/a/b/direction.md'], 'c1', USER_AUTHOR)
    ctx.emit('dish-config/changed', ['families/beta/direction.md', 'crew.yaml', 'families/acme/direction.md'], 'c2', USER_AUTHOR)
    assert.deepEqual(await take(watch.it, 2), [{ kind: 'direction', family: 'beta' }, { kind: 'direction', family: 'acme' }])
    watch.abort()
  })
})

test('watch\'s backlog keeps 100 and the newest remote', async () => {
  const world = await memoryWorld()
  await withRemote(world.memory, async (remote, ctx) => {
    const watch = watching(remote)
    await event(watch.it)
    const status = (pending: number): RemoteStatus => ({ pending })
    // The reader is not reading: 150 commits, 10 directions, and three remote statuses, one in the middle of it all.
    for (let i = 0; i < 60; i++) ctx.emit('dish-memory/changed', ['user'], `c${i}`, USER_AUTHOR)
    ctx.emit('dish-memory/remote', status(1))
    for (let i = 60; i < 150; i++) ctx.emit('dish-memory/changed', ['family:acme'], `c${i}`, USER_AUTHOR)
    ctx.emit('dish-memory/remote', status(2))
    for (let i = 0; i < 10; i++) ctx.emit('dish-config/changed', [`families/f${i}/direction.md`], `d${i}`, USER_AUTHOR)
    ctx.emit('dish-memory/remote', status(3))

    // 100 of the others, and the one remote status: no more, no fewer.
    const seen = await take(watch.it, 101)
    assert.deepEqual(seen.filter(item => item.kind === 'remote'), [{ kind: 'remote', status: status(3) }], 'only the newest remote status is kept')
    const rest = seen.filter(item => item.kind !== 'remote')
    assert.equal(rest.length, 100)
    // The newest 100 of the 160: commits c60..c149 and then the ten directions, in order.
    assert.deepEqual(rest.slice(0, 2), [
      { kind: 'changed', commit: 'c60', scopes: ['family:acme'] },
      { kind: 'changed', commit: 'c61', scopes: ['family:acme'] },
    ])
    assert.deepEqual(rest.slice(-11), [
      { kind: 'changed', commit: 'c149', scopes: ['family:acme'] },
      ...Array.from({ length: 10 }, (_, i) => ({ kind: 'direction', family: `f${i}` })),
    ])
    watch.abort()
  })
})

test('watch follows the vault\'s pushes, and ends when the plugin is unloaded under it', async () => {
  const dir = await tempDir()
  const bare = await bareRemote()
  const ctx = new Context()
  const handle = mountMemory(ctx, { vault: join(dir, 'vault.git'), remote: bare.path })
  try {
    await handle
    const remote = await waitFor('the remote', () => ctx.get('dishMemoryRemote') as MemoryRemote | undefined)
    const watch = watching(remote)
    const snapshot = await event(watch.it)
    assert.equal(snapshot.kind, 'remote')
    plain(snapshot)

    const saved = ok(await remote.save('user', 'a', 'feedback', 'About a', 'What a says.', ''))
    const pushed = await until(watch.it, item => item.kind === 'remote' && item.status.pushed === saved.id)
    assert.ok(pushed.kind === 'remote' && pushed.status.pending === 0 && pushed.status.remote === bare.path, JSON.stringify(pushed))
    plain(pushed)

    const parked = until(watch.it, () => false).catch((error: unknown) => error)
    await handle.dispose()
    const ended = await parked
    assert.ok(ended instanceof Error && /the stream ended/.test(ended.message), String(ended))
    assert.deepEqual(listeners(ctx), { 'dish-memory/changed': 0, 'dish-config/changed': 0, 'dish-memory/remote': 0 })
  } finally {
    await handle.dispose()
  }
})
