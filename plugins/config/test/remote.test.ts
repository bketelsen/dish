import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import * as plugin from '../src/index.ts'
import type { DishConfigService } from '../src/index.ts'
import type { ConfigEvent, ErrorCode, Outcome } from '../src/protocol.ts'
import { ConfigRemote } from '../src/remote.ts'
import { Git } from '../src/store/git.ts'
import { AGENTA, USERA, ns, repoPath, tempDir } from './helpers.ts'

const run = promisify(execFile)

// --- helpers ------------------------------------------------------------------------------------

/** Run `body` with the plugin (and so the remote) loaded into `ctx`, and unload it however `body` ends. */
async function withRemote<T>(
  config: Partial<plugin.Config>,
  body: (remote: ConfigRemote, service: DishConfigService, ctx: Context) => Promise<T>,
  ctx = new Context(),
): Promise<T> {
  const handle = ctx.plugin(plugin, { terminal: false, repository: await repoPath(), ...config } as plugin.Config)
  try {
    await handle
    return await body(ctx.get('dishConfigRemote') as ConfigRemote, ctx.dishConfig, ctx)
  } finally {
    await handle.dispose()
  }
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

/** The pending listeners for each of the three events, by looking into the event bus (the only way to see a listener leak). */
function listeners(ctx: Context): Record<string, number> {
  const hooks = (ctx as unknown as { events: { _hooks: Record<string, unknown[] | undefined> } }).events._hooks
  return Object.fromEntries(['dish-config/changed', 'dish-config/proposal', 'dish-config/remote']
    .map(name => [name, hooks[name]?.length ?? 0]))
}

type Watching = { next(): Promise<IteratorResult<ConfigEvent>>, abort(): void, it: AsyncIterator<ConfigEvent> }

function watching(remote: ConfigRemote): Watching {
  const controller = new AbortController()
  const it = remote.watch(controller.signal)[Symbol.asyncIterator]()
  return { it, abort: () => { controller.abort() }, next: () => it.next() }
}

const TIMEOUT = Symbol('timeout')

/** The next result of `it`, or `TIMEOUT` if it takes longer than `ms`. */
async function within(it: AsyncIterator<ConfigEvent>, ms: number): Promise<IteratorResult<ConfigEvent> | typeof TIMEOUT> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<typeof TIMEOUT>((resolve) => { timer = setTimeout(() => { resolve(TIMEOUT) }, ms) })
  try {
    return await Promise.race([it.next(), timeout])
  } finally {
    clearTimeout(timer)
  }
}

/** The next event, which must come soon. */
async function event(it: AsyncIterator<ConfigEvent>): Promise<ConfigEvent> {
  const result = await within(it, 10_000)
  assert.notEqual(result, TIMEOUT, 'timed out waiting for an event')
  assert.ok(result !== TIMEOUT && !result.done, 'the stream ended')
  return result.value
}

/** Events until `want` matches one, which is returned; those before it are skipped. */
async function until(it: AsyncIterator<ConfigEvent>, want: (event: ConfigEvent) => boolean): Promise<ConfigEvent> {
  for (;;) {
    const next = await event(it)
    if (want(next)) return next
  }
}

/** Exactly `count` events, which must all be there; then the stream must have nothing more to say for a moment. */
async function take(it: AsyncIterator<ConfigEvent>, count: number): Promise<ConfigEvent[]> {
  const seen: ConfigEvent[] = []
  while (seen.length < count) seen.push(await event(it))
  assert.equal(await within(it, 60), TIMEOUT, 'no more events than expected')
  return seen
}

// --- the wire contract ---------------------------------------------------------------------------

const METHODS = ['namespaces', 'history', 'commit', 'revert', 'proposals', 'proposal', 'accept', 'reject', 'remoteStatus', 'watch']

test('ConfigRemote is bound as dishConfigRemote under the dishConfig namespace, and marks every method (watch as a stream)', async () => {
  await withRemote({}, async (remote, _service, ctx) => {
    // (`ctx.get` hands out a proxy per caller, so the service is not compared by identity: the binding names the instance itself.)
    assert.ok(ctx.get('dishConfigRemote') !== undefined)
    assert.equal(remote.typertRemote.serviceKey, 'dishConfigRemote')
    assert.equal(remote.typertRemote.namespace, 'dishConfig')
    assert.ok(remote.typertRemote.service instanceof ConfigRemote)

    const marks = remoteMethods(remote)
    assert.deepEqual(marks.map(mark => mark.method).sort(), [...METHODS].sort())
    for (const mark of marks) {
      assert.deepEqual(mark.invocation, { kind: 'direct' }, mark.method)
      assert.equal(mark.mode, mark.method === 'watch' ? 'stream' : undefined, mark.method)
      assert.equal(mark.exportName, undefined, mark.method)
    }
    // Nothing public is left unmarked: what the page can't call it must not look like it can.
    const own = Object.getOwnPropertyNames(ConfigRemote.prototype)
      .filter(key => key !== 'constructor' && typeof (ConfigRemote.prototype as unknown as Record<string, unknown>)[key] === 'function')
    assert.deepEqual(own.sort(), [...METHODS].sort())
  })
})

/** The gateway's source-mode reading of a method's parameter names: the text between its first parentheses, split on commas. */
function parameterNames(method: (...args: never[]) => unknown): string[] {
  const source = Function.prototype.toString.call(method)
  const open = source.indexOf('(')
  const body = source.slice(open + 1, source.indexOf(')', open + 1)).trim()
  return body === '' ? [] : body.split(',').map(part => part.trim())
}

test('the gateway can read every method\'s parameter names from source, and they are the ones the client sends', () => {
  const expected: Record<string, string[]> = {
    namespaces: [],
    history: ['prefix', 'limit', 'before'],
    commit: ['id'],
    revert: ['id'],
    proposals: ['status'],
    proposal: ['id'],
    accept: ['id'],
    reject: ['id', 'reason'],
    remoteStatus: [],
    watch: ['signal'],
  }
  for (const method of METHODS) {
    const names = parameterNames((ConfigRemote.prototype as unknown as Record<string, (...args: never[]) => unknown>)[method]!)
    assert.deepEqual(names, expected[method], method)
    for (const name of names) assert.match(name, /^[$A-Z_a-z][$\w]*$/u, `${method}: ${name}`)
  }
})

// --- namespaces ----------------------------------------------------------------------------------

test('namespaces lists every claim with its owner and agent policy, and nothing else', async () => {
  await withRemote({}, async (remote, service) => {
    const release = service.claim(ns('prompts/', 'write', 'dish-prompts'))
    service.claim(ns('crew.yaml', 'propose', 'dish-crew'))
    const listed = remote.namespaces()
    plain(listed)
    assert.deepEqual(listed, [
      { prefix: 'README.md', owner: 'dish-config', agent: 'none' },
      { prefix: 'prompts/', owner: 'dish-prompts', agent: 'write' },
      { prefix: 'crew.yaml', owner: 'dish-crew', agent: 'propose' },
    ])
    release()
    assert.deepEqual(remote.namespaces().map(info => info.prefix), ['README.md', 'crew.yaml'])
  })
})

// --- history and commit --------------------------------------------------------------------------

test('history returns the README seed commit, as plain JSON', async () => {
  await withRemote({}, async (remote) => {
    const result = await remote.history('', 0, '')
    plain(result)
    const log = ok(result)
    // The seed, then the empty root commit under it.
    assert.equal(log.length, 2)
    assert.deepEqual(log[0]!.author, { kind: 'system' })
    assert.deepEqual(log[0]!.paths, ['README.md'])
    assert.match(log[0]!.id, /^[0-9a-f]{40}$/)
    assert.deepEqual(log[1]!.paths, [])
  })
})

test('history: a prefix with a slash is a prefix, one without is a document, limit and before page through, junk is INVALID', async () => {
  await withRemote({}, async (remote, service) => {
    service.claim(ns('prompts/'))
    service.claim(ns('crew.yaml'))
    const a = (await service.write([{ path: 'prompts/a.md', text: '1' }], { author: USERA }))!
    const b = (await service.write([{ path: 'crew.yaml', text: '2' }], { author: AGENTA, note: 'why' }))!
    const c = (await service.write([{ path: 'prompts/a.md', text: '3' }], { author: USERA }))!

    const ids = async (prefix: string, limit = 0, before = ''): Promise<string[]> => ok(await remote.history(prefix, limit, before)).map(info => info.id)
    assert.deepEqual((await ids('')).slice(0, 3), [c.id, b.id, a.id])
    assert.deepEqual(await ids('prompts/'), [c.id, a.id])
    // Without the slash it is passed as a path: git matches that document, or what is under that directory, and not `prom`.
    assert.deepEqual(await ids('prompts'), [c.id, a.id])
    assert.deepEqual(await ids('prom'), [])
    assert.deepEqual(await ids('prompts/a.md'), [c.id, a.id])
    assert.deepEqual(await ids('crew.yaml'), [b.id])
    assert.equal(ok(await remote.history('crew.yaml', 0, ''))[0]!.note, 'why')

    // limit <= 0 is the default (50), anything else is the store's own clamp.
    assert.equal((await ids('', -5)).length, 5)
    assert.deepEqual(await ids('', 1), [c.id])
    assert.deepEqual(await ids('', 1, c.id), [b.id])
    assert.deepEqual((await ids('', 10, b.id))[0], a.id)

    failed(await remote.history('', 0, '0'.repeat(40)), 'NOT_FOUND')
    failed(await remote.history('../x', 0, ''), 'INVALID')
    failed(await remote.history(5 as unknown as string, 0, ''), 'INVALID')
    failed(await remote.history('', 'ten' as unknown as number, ''), 'INVALID')
    failed(await remote.history('', 0, 7 as unknown as string), 'INVALID')
  })
})

test('a missing argument is an absent one: the gateway passes undefined for what the client leaves out', async () => {
  await withRemote({}, async (remote, service) => {
    service.claim(ns('p/', 'propose'))
    const proposed = await service.propose([{ path: 'p/x.md', text: 'one\n' }], { author: AGENTA, title: 'Add x', rationale: '' })
    const missing = undefined as unknown as string
    const noNumber = undefined as unknown as number

    const log = ok(await remote.history('', 0, ''))
    assert.equal(log.length, 2)
    assert.deepEqual(ok(await remote.history('', 0, missing)), log)
    assert.deepEqual(ok(await remote.history(missing, 0, '')), log)
    assert.deepEqual(ok(await remote.history('', noNumber, '')), log)
    assert.deepEqual(ok(await remote.history(missing, noNumber, missing)), log)
    assert.deepEqual(ok(await remote.history('', noNumber, log[0]!.id)).map(info => info.id), [log[1]!.id])
    assert.equal(ok(await remote.history('', noNumber, '')).length, 2, 'the default limit, not none')

    assert.deepEqual(ok(await remote.proposals(missing)).map(info => info.id), [proposed.id])
    // An absent id is an id nothing has, and an absent reason is an empty one.
    failed(await remote.commit(missing), 'NOT_FOUND')
    failed(await remote.revert(missing), 'NOT_FOUND')
    failed(await remote.proposal(missing), 'NOT_FOUND')
    failed(await remote.accept(missing), 'NOT_FOUND')
    failed(await remote.reject(proposed.id, missing), 'INVALID')
    failed(await remote.reject(missing, 'no'), 'NOT_FOUND')
    assert.deepEqual(ok(await remote.proposals('open')).map(info => info.id), [proposed.id], 'nothing was rejected')

    // Anything else that is not the right type is still refused.
    failed(await remote.history('', 0, null as unknown as string), 'INVALID')
    failed(await remote.history(null as unknown as string, 0, ''), 'INVALID')
    failed(await remote.history('', null as unknown as number, ''), 'INVALID')
    failed(await remote.proposals(null as unknown as string), 'INVALID')
    failed(await remote.commit(null as unknown as string), 'INVALID')
  })
})

test('commit returns the commit and its diffs; an unknown id is NOT_FOUND', async () => {
  await withRemote({}, async (remote, service) => {
    service.claim(ns('t/'))
    const a = (await service.write([{ path: 't/a.md', text: 'hello\n' }], { author: USERA, note: 'first' }))!
    const result = await remote.commit(a.id)
    plain(result)
    const { info, diffs } = ok(result)
    assert.deepEqual(info, a)
    assert.deepEqual(diffs.map(diff => [diff.path, diff.status]), [['t/a.md', 'added']])
    assert.match(diffs[0]!.patch, /\+hello/)

    failed(await remote.commit('f'.repeat(40)), 'NOT_FOUND')
    failed(await remote.commit(1 as unknown as string), 'INVALID')
  })
})

// --- revert --------------------------------------------------------------------------------------

test('revert makes a user-authored commit; reverting it again has nothing to do (null)', async () => {
  await withRemote({}, async (remote, service, ctx) => {
    service.claim(ns('t/'))
    const a = (await service.write([{ path: 't/a.md', text: 'one' }], { author: AGENTA }))!
    const heard: string[][] = []
    ctx.on('dish-config/changed', paths => { heard.push(paths) })

    const reverted = ok(await remote.revert(a.id))
    assert.ok(reverted)
    plain(reverted)
    assert.deepEqual(reverted.author, { kind: 'user' })
    assert.deepEqual(reverted.paths, ['t/a.md'])
    assert.match(reverted.message, /^Revert [0-9a-f]{7}: t\/a\.md/)
    assert.equal(await service.read('t/a.md'), undefined)
    assert.equal(await service.head(), reverted.id)
    assert.deepEqual(heard, [['t/a.md']])

    // Already reverted: not an error, and no new commit.
    assert.equal(ok(await remote.revert(a.id)), null)
    assert.equal(await service.head(), reverted.id)
  })
})

test('a revert the store refuses comes back as { ok: false, code }: CONFLICT, UNOWNED, NOT_FOUND, INVALID', async () => {
  await withRemote({}, async (remote, service) => {
    const release = service.claim(ns('t/'))
    const a = (await service.write([{ path: 't/a.md', text: 'one' }], { author: USERA }))!
    await service.write([{ path: 't/a.md', text: 'two' }], { author: USERA })
    const head = await service.head()

    // The path changed since: its revert would undo a later edit.
    const conflict = failed(await remote.revert(a.id), 'CONFLICT')
    assert.match(conflict, /t\/a\.md/)

    failed(await remote.revert('e'.repeat(40)), 'NOT_FOUND')
    // The first commit has nothing to go back to.
    const first = ok(await remote.history('', 0, '')).at(-1)!
    failed(await remote.revert(first.id), 'INVALID')

    // A namespace nobody claims any more can't be written, so it can't be reverted either.
    const b = (await service.write([{ path: 't/b.md', text: 'x' }], { author: USERA }))!
    release()
    failed(await remote.revert(b.id), 'UNOWNED')
    assert.notEqual(await service.head(), head, 'the head only moved by b')
    assert.equal(await service.read('t/b.md'), 'x')
  })
})

// --- proposals -----------------------------------------------------------------------------------

test('proposals lists by status (empty is all), as plain JSON; a status that is not one is INVALID', async () => {
  await withRemote({}, async (remote, service) => {
    service.claim(ns('p/', 'propose'))
    const first = await service.propose([{ path: 'p/x.md', text: 'one' }], { author: AGENTA, title: 'first', rationale: 'because' })
    const second = await service.propose([{ path: 'p/y.md', text: 'two' }], { author: AGENTA, title: 'second', rationale: '' })

    const all = await remote.proposals('')
    plain(all)
    assert.deepEqual(ok(all).map(info => info.id).sort(), [first.id, second.id].sort())
    assert.deepEqual(ok(await remote.proposals('open')).map(info => info.status), ['open', 'open'])
    assert.deepEqual(ok(await remote.proposals('stale')), [])
    assert.deepEqual(ok(await remote.proposals('rejected')), [])
    failed(await remote.proposals('pending'), 'INVALID')
    failed(await remote.proposals(3 as unknown as string), 'INVALID')
  })
})

test('proposal(id) diffs what was proposed (base to tip), even after main changed another path', async () => {
  await withRemote({}, async (remote, service) => {
    service.claim(ns('p/', 'propose'))
    service.claim(ns('q/'))
    const proposed = await service.propose([{ path: 'p/x.md', text: 'one\n' }], { author: AGENTA, title: 'Add x', rationale: 'it helps' })
    await service.write([{ path: 'q/y.md', text: 'newer\n' }], { author: USERA })

    const result = await remote.proposal(proposed.id)
    plain(result)
    const { info, diffs } = ok(result)
    assert.equal(info.id, proposed.id)
    assert.equal(info.status, 'open')
    assert.equal(info.title, 'Add x')
    assert.equal(info.rationale, 'it helps')
    assert.deepEqual(diffs.map(diff => [diff.path, diff.status]), [['p/x.md', 'added']])
    assert.match(diffs[0]!.patch, /\+one/)

    // Against main it would look as though it deleted what the user wrote since: that is not what was proposed.
    const againstMain = await service.diff('main', proposed.tip)
    assert.deepEqual(againstMain.map(diff => [diff.path, diff.status]), [['p/x.md', 'added'], ['q/y.md', 'deleted']])

    failed(await remote.proposal('0'.repeat(8)), 'NOT_FOUND')
    failed(await remote.proposal(9 as unknown as string), 'INVALID')
  })
})

test('a stale proposal says so, still shows what it proposed, and accept is STALE; rejecting it keeps the diff and the reason', async () => {
  await withRemote({}, async (remote, service) => {
    service.claim(ns('p/', 'propose'))
    const proposed = await service.propose([{ path: 'p/x.md', text: 'agent\n' }], { author: AGENTA, title: 'Add x', rationale: '' })
    await service.write([{ path: 'p/x.md', text: 'user\n' }], { author: USERA })
    const head = await service.head()

    const { info, diffs } = ok(await remote.proposal(proposed.id))
    assert.equal(info.status, 'stale')
    assert.deepEqual(diffs.map(diff => [diff.path, diff.status]), [['p/x.md', 'added']])
    assert.match(diffs[0]!.patch, /\+agent/)
    assert.deepEqual(ok(await remote.proposals('stale')).map(item => item.id), [proposed.id])

    const message = failed(await remote.accept(proposed.id), 'STALE')
    assert.match(message, new RegExp(proposed.id))
    assert.equal(await service.head(), head, 'nothing was merged')
    assert.equal(await service.read('p/x.md'), 'user\n')

    assert.equal(ok(await remote.reject(proposed.id, 'superseded by my edit')), null)
    const rejected = ok(await remote.proposal(proposed.id))
    plain(rejected)
    assert.equal(rejected.info.status, 'rejected')
    assert.equal(rejected.info.reason, 'superseded by my edit')
    assert.deepEqual(rejected.diffs, diffs, 'the same diff as before it was rejected')
    assert.deepEqual(ok(await remote.proposals('rejected')).map(item => item.reason), ['superseded by my edit'])
    assert.deepEqual(ok(await remote.proposals('stale')), [])
  })
})

test('accept merges as the user; one main already has gives null; an unknown one is NOT_FOUND', async () => {
  await withRemote({}, async (remote, service) => {
    service.claim(ns('p/', 'propose'))
    const first = await service.propose([{ path: 'p/x.md', text: 'one\n' }], { author: AGENTA, title: 'Add x', rationale: '' })
    const second = await service.propose([{ path: 'p/z.md', text: 'same\n' }], { author: AGENTA, title: 'Add z', rationale: '' })

    const accepted = ok(await remote.accept(first.id))
    assert.ok(accepted)
    plain(accepted)
    assert.deepEqual(accepted.author, { kind: 'user' })
    assert.deepEqual(accepted.paths, ['p/x.md'])
    assert.equal(await service.read('p/x.md'), 'one\n')
    assert.deepEqual(ok(await remote.proposals('open')).map(info => info.id), [second.id])

    // The user wrote the very same text meanwhile: not stale, and nothing is left to apply.
    await service.write([{ path: 'p/z.md', text: 'same\n' }], { author: USERA })
    const head = await service.head()
    assert.equal(ok(await remote.accept(second.id)), null)
    assert.equal(await service.head(), head)
    assert.deepEqual(ok(await remote.proposals('open')), [])

    failed(await remote.accept(first.id), 'NOT_FOUND')
    failed(await remote.accept('abcdef12'), 'NOT_FOUND')
  })
})

test('reject records the reason; an empty reason is INVALID, an unknown proposal NOT_FOUND', async () => {
  await withRemote({}, async (remote, service) => {
    service.claim(ns('p/', 'propose'))
    const proposed = await service.propose([{ path: 'p/x.md', text: 'one\n' }], { author: AGENTA, title: 'Add x', rationale: '' })

    failed(await remote.reject(proposed.id, '  '), 'INVALID')
    failed(await remote.reject(proposed.id, 4 as unknown as string), 'INVALID')
    failed(await remote.reject('abcdef12', 'no'), 'NOT_FOUND')
    assert.deepEqual(ok(await remote.proposals('open')).map(info => info.id), [proposed.id], 'still there')

    assert.equal(ok(await remote.reject(proposed.id, 'not now')), null)
    assert.deepEqual(ok(await remote.proposals('open')), [])
    failed(await remote.reject(proposed.id, 'again'), 'NOT_FOUND')
  })
})

// --- remote status -------------------------------------------------------------------------------

test('remoteStatus is { pending: 0 } with no remote, and follows a push when there is one', async () => {
  await withRemote({}, async (remote) => {
    const result = await remote.remoteStatus()
    plain(result)
    assert.deepEqual(ok(result), { pending: 0 })
  })

  const bare = join(await tempDir(), 'remote.git')
  await new Git(bare).initBare('main')
  await withRemote({ remote: bare }, async (remote, service) => {
    const written = (await service.write([{ path: 'README.md', text: '# mine\n' }], { author: USERA }))!
    for (let tries = 0; ; tries++) {
      const status = ok(await remote.remoteStatus())
      plain(status)
      if (status.pushed === written.id) {
        assert.equal(status.pending, 0)
        assert.equal(status.remote, bare)
        break
      }
      assert.ok(tries < 400, `never pushed: ${JSON.stringify(status)}`)
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    assert.equal((await run('git', [`--git-dir=${bare}`, 'rev-parse', 'main'])).stdout.trim(), written.id)
  })
})

// --- watch ---------------------------------------------------------------------------------------

test('watch starts with a remote snapshot, then reports changed after a write and proposal after a propose', async () => {
  await withRemote({}, async (remote, service) => {
    service.claim(ns('p/', 'propose'))
    service.claim(ns('t/'))
    const watch = watching(remote)

    assert.deepEqual(await event(watch.it), { kind: 'remote', status: { pending: 0 } })

    const written = (await service.write([{ path: 't/a.md', text: 'one' }], { author: USERA }))!
    assert.deepEqual(await event(watch.it), { kind: 'changed', commit: written.id, paths: ['t/a.md'] })

    const proposed = await service.propose([{ path: 'p/x.md', text: 'x' }], { author: AGENTA, title: 'Add x', rationale: '' })
    assert.deepEqual(await event(watch.it), { kind: 'proposal', id: proposed.id, status: 'open' })

    await remote.reject(proposed.id, 'no')
    assert.deepEqual(await event(watch.it), { kind: 'proposal', id: proposed.id, status: 'rejected' })

    // A write that changes nothing is no event: the next one is the next real one.
    await service.write([{ path: 't/a.md', text: 'one' }], { author: USERA })
    const more = (await service.write([{ path: 't/b.md', text: 'two' }], { author: USERA }))!
    assert.deepEqual(await event(watch.it), { kind: 'changed', commit: more.id, paths: ['t/b.md'] })

    watch.abort()
    assert.deepEqual(await watch.next(), { done: true, value: undefined })
  })
})

test('watch reports the remote status as it changes, and a page that opens mid-error sees the error at once', async () => {
  const bare = join(await tempDir(), 'remote.git')
  await new Git(bare).initBare('main')
  await withRemote({ remote: bare }, async (remote, service) => {
    service.claim(ns('t/'))
    const watch = watching(remote)
    const snapshot = await event(watch.it)
    assert.equal(snapshot.kind, 'remote')
    plain(snapshot)

    const written = (await service.write([{ path: 't/a.md', text: 'one' }], { author: USERA }))!
    const pushed = await until(watch.it, item => item.kind === 'remote' && item.status.pushed === written.id)
    assert.ok(pushed.kind === 'remote' && pushed.status.pending === 0)
    watch.abort()
  })

  // A remote that is gone: the push fails, and the failure is in the snapshot of a stream that starts afterwards.
  const gone = join(await tempDir(), 'gone.git')
  await new Git(gone).initBare('main')
  await withRemote({ remote: gone }, async (remote, service) => {
    service.claim(ns('t/'))
    await run('rm', ['-rf', gone])
    await service.write([{ path: 't/a.md', text: 'one' }], { author: USERA })
    for (let tries = 0; ; tries++) {
      const status = ok(await remote.remoteStatus())
      if (status.lastError !== undefined) break
      assert.ok(tries < 400, `the push never failed: ${JSON.stringify(status)}`)
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    const watch = watching(remote)
    const snapshot = await event(watch.it)
    assert.ok(snapshot.kind === 'remote' && snapshot.status.lastError !== undefined && snapshot.status.pending > 0, JSON.stringify(snapshot))
    watch.abort()
  })
})

test('watch stops when its signal aborts, and its listeners go with it', async () => {
  await withRemote({}, async (remote, service, ctx) => {
    service.claim(ns('t/'))
    const before = listeners(ctx)

    const watch = watching(remote)
    await event(watch.it)
    const during = listeners(ctx)
    for (const name of Object.keys(before)) assert.equal(during[name], before[name]! + 1, name)

    // Parked waiting for an event, the generator ends as soon as the signal aborts.
    const parked = watch.next()
    watch.abort()
    assert.deepEqual(await parked, { done: true, value: undefined })
    assert.deepEqual(listeners(ctx), before)

    // And what happens after is nobody's business: nothing is queued, nothing throws.
    assert.ok(await service.write([{ path: 't/a.md', text: 'one' }], { author: USERA }))
    assert.deepEqual(await watch.next(), { done: true, value: undefined })

    // A stream whose signal is already aborted never listens at all.
    const late = new AbortController()
    late.abort()
    const lateEvents: ConfigEvent[] = []
    for await (const item of remote.watch(late.signal)) lateEvents.push(item)
    assert.deepEqual(lateEvents, [])
    assert.deepEqual(listeners(ctx), before)

    // Closing the iterator early (the gateway does that when the page goes) removes the listeners too.
    const closed = watching(remote)
    await event(closed.it)
    assert.deepEqual(await closed.it.return!(), { done: true, value: undefined })
    assert.deepEqual(listeners(ctx), before)
  })
})

test('watch ends when the plugin is unloaded under it', async () => {
  const ctx = new Context()
  const handle = ctx.plugin(plugin, { terminal: false, repository: await repoPath() } as plugin.Config)
  await handle
  const remote = ctx.get('dishConfigRemote') as ConfigRemote
  const watch = watching(remote)
  await event(watch.it)
  const parked = watch.next()
  await handle.dispose()
  assert.deepEqual(await parked, { done: true, value: undefined })
  assert.deepEqual(listeners(ctx), { 'dish-config/changed': 0, 'dish-config/proposal': 0, 'dish-config/remote': 0 })
})

test('watch keeps at most 100 pending changed/proposal events (the oldest are dropped) and always the latest remote status', async () => {
  await withRemote({}, async (remote, _service, ctx) => {
    const watch = watching(remote)
    await event(watch.it)
    const status = (pending: number) => ({ pending })
    // The consumer is not reading: 150 changes, 10 proposals, and three remote statuses, one in the middle of it all.
    for (let i = 0; i < 60; i++) ctx.emit('dish-config/changed', [`f${i}`], `c${i}`, { kind: 'user' })
    ctx.emit('dish-config/remote', status(1))
    for (let i = 60; i < 150; i++) ctx.emit('dish-config/changed', [`f${i}`], `c${i}`, { kind: 'user' })
    ctx.emit('dish-config/remote', status(2))
    for (let i = 0; i < 10; i++) ctx.emit('dish-config/proposal', `p${i}`, 'open')
    ctx.emit('dish-config/remote', status(3))

    // 100 of the changed/proposal events, and the one remote status: no more, no fewer.
    const seen = await take(watch.it, 101)
    const remotes = seen.filter(item => item.kind === 'remote')
    assert.deepEqual(remotes, [{ kind: 'remote', status: status(3) }], 'only the latest remote status is kept')
    const rest = seen.filter(item => item.kind !== 'remote')
    assert.equal(rest.length, 100)
    // The newest 100 of the 160: changes c60..c149 and then the ten proposals, still in order.
    assert.deepEqual(rest.slice(0, 3), [
      { kind: 'changed', commit: 'c60', paths: ['f60'] },
      { kind: 'changed', commit: 'c61', paths: ['f61'] },
      { kind: 'changed', commit: 'c62', paths: ['f62'] },
    ])
    assert.deepEqual(rest.slice(-11), [
      { kind: 'changed', commit: 'c149', paths: ['f149'] },
      ...Array.from({ length: 10 }, (_, i) => ({ kind: 'proposal', id: `p${i}`, status: 'open' })),
    ])
    watch.abort()
  })
})

// --- failures that are not the store's -----------------------------------------------------------

test('an unexpected failure still throws: with the store gone, a call rejects instead of coming back as an outcome', async () => {
  const ctx = new Context()
  const handle = ctx.plugin(plugin, { terminal: false, repository: await repoPath() } as plugin.Config)
  await handle
  const remote = ctx.get('dishConfigRemote') as ConfigRemote
  await handle.dispose()
  await assert.rejects(remote.history('', 0, ''))
  await assert.rejects(remote.remoteStatus())
})
