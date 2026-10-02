import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ConfigStoreError } from '../src/store/errors.ts'
import { Git } from '../src/store/git.ts'
import type { Change } from '../src/store/git.ts'
import { secretKind } from '../src/store/guard.ts'
import { ConfigStore } from '../src/store/store.ts'
import type { WriteMeta } from '../src/store/store.ts'
import { AGENT, AGENTA, USER, USERA, isPlainError, isStoreError, ns, openAt, openStore, recorder, repoPath } from './helpers.ts'

const MAIN = 'refs/heads/main'
const TOKEN = `ghp_${'a'.repeat(36)}`
const SK_KEY = `sk-${'a'.repeat(40)}`
const AWS_KEY = `AKIA${'A'.repeat(16)}`

/** The loose-object summary: it changes when anything at all is written to the object database. */
async function objects(git: Git): Promise<string> {
  return (await git.run(['count-objects', '-v'])).stdout
}

/** The raw commit object's message, exactly as stored. */
async function storedMessage(git: Git, id: string): Promise<string> {
  const raw = (await git.run(['cat-file', 'commit', id])).stdout
  return raw.slice(raw.indexOf('\n\n') + 2)
}

/** `%an|%ae|%cn|%ce` of a commit. */
async function identities(git: Git, id: string): Promise<string> {
  return (await git.run(['log', '-1', '--format=%an|%ae|%cn|%ce', id])).stdout.trim()
}

async function mainOf(git: Git): Promise<string | undefined> {
  return git.resolve(MAIN)
}

/** Commit `text` to `path` on `main` behind the store's back, as an outside writer would. */
async function externalCommit(git: Git, path: string, text: string): Promise<string> {
  const head = await mainOf(git)
  assert.ok(head)
  const id = await git.commitTree(await git.buildTree(head, [{ path, text }]), [head], 'external', USER)
  assert.equal(await git.casRef(MAIN, id, head), true)
  return id
}

/** A pid that certainly isn't running: a child that was started and has already exited. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  const pid = child.pid
  assert.ok(pid !== undefined)
  await once(child, 'exit')
  return pid
}

/** Set a file's modification time to `ageMs` ago. */
async function age(path: string, ageMs: number): Promise<void> {
  const then = new Date(Date.now() - ageMs)
  await utimes(path, then, then)
}

/** The store's private git runner, for tests that interfere with it on purpose. */
function gitOf(store: ConfigStore): Git {
  return (store as unknown as { git: Git }).git
}

// --- the plan's key cases ----------------------------------------------------------------------

test('write commits atomically and read sees it', async () => {
  const s = await openStore({ claims: [ns('prompts/')] })
  const c = await s.write([{ path: 'prompts/a.md', text: 'A' }, { path: 'prompts/b.md', text: 'B' }], { author: USERA })
  assert.ok(c)
  assert.deepEqual(c.paths.sort(), ['prompts/a.md', 'prompts/b.md'])
  assert.equal(await s.read('prompts/b.md'), 'B')
})

test('base: same path changed since base -> CONFLICT; other path -> ok', async () => {
  const s = await openStore({ claims: [ns('prompts/')] })
  const base = (await s.write([{ path: 'prompts/a.md', text: '1' }], { author: USERA }))!.id
  await s.write([{ path: 'prompts/a.md', text: '2' }], { author: USERA })
  await assert.rejects(s.write([{ path: 'prompts/a.md', text: '3' }], { author: USERA, base }), { code: 'CONFLICT' })
  await s.write([{ path: 'prompts/b.md', text: 'x' }], { author: USERA, base })   // different path: allowed
  assert.equal(await s.read('prompts/a.md'), '2')
})

test('concurrent writes to the same path with the same base: exactly one wins', async () => {
  const s = await openStore({ claims: [ns('prompts/')] }); const base = await s.head()
  const results = await Promise.allSettled([1, 2].map(n =>
    s.write([{ path: 'prompts/a.md', text: String(n) }], { author: USERA, base })))
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal(results.filter(r => r.status === 'rejected' && (r.reason as any).code === 'CONFLICT').length, 1)
})

test('writes queue in order: many concurrent writes to different paths all land, in one line of history', async () => {
  const { store, git } = await openAt({ claims: [ns('prompts/')] })
  const results = await Promise.all(Array.from({ length: 10 }, (_, n) =>
    store.write([{ path: `prompts/${n}.md`, text: String(n) }], { author: USERA })))
  assert.ok(results.every(info => info !== undefined))
  assert.equal((await git.run(['rev-list', '--count', MAIN])).stdout.trim(), '11')
  assert.equal((await git.run(['rev-list', '--merges', '--count', MAIN])).stdout.trim(), '0')
  assert.equal((await store.list('prompts/')).length, 10)
})

test('a write to an unowned path is UNOWNED, and nothing is written', async () => {
  const { store, git } = await openAt({ claims: [ns('prompts/')] })
  const before = await objects(git)
  await assert.rejects(store.write([{ path: 'other/a.md', text: 'x' }], { author: USERA }), isStoreError('UNOWNED', 'other/a.md'))
  await assert.rejects(store.write([{ path: 'prompts', text: 'x' }], { author: USERA }), isStoreError('UNOWNED'))
  await assert.rejects(
    store.write([{ path: 'prompts/a.md', text: 'x' }, { path: 'other/a.md', text: 'x' }], { author: USERA }),
    isStoreError('UNOWNED'))
  assert.equal(await objects(git), before)
  assert.equal(await store.read('prompts/a.md'), undefined)
})

test('validate returning a message is INVALID and carries it, prefixed with the path', async () => {
  const validate = (path: string, text: string) => (text === 'bad' ? `${text} is not allowed` : undefined)
  const { store, git } = await openAt({ claims: [ns('prompts/', 'write', 'test', validate)] })
  const before = await objects(git)
  await assert.rejects(
    store.write([{ path: 'prompts/ok.md', text: 'fine' }, { path: 'prompts/a.md', text: 'bad' }], { author: USERA }),
    isStoreError('INVALID', 'prompts/a.md: bad is not allowed'))
  assert.equal(await objects(git), before)
  assert.equal(await store.read('prompts/ok.md'), undefined, 'one bad document keeps the whole write out')
})

test('validate is called with the path and the text, once per changed document, never for a delete', async () => {
  const calls: Array<[string, string]> = []
  const store = await openStore({ claims: [ns('prompts/', 'write', 'test', (path, text) => { calls.push([path, text]); return undefined })] })
  await store.write([{ path: 'prompts/a.md', text: 'A' }], { author: USERA })
  calls.length = 0
  await store.write([{ path: 'prompts/a.md', delete: true }, { path: 'prompts/b.md', text: 'B' }], { author: USERA })
  assert.deepEqual(calls, [['prompts/b.md', 'B']])
})

test('a validator that does not return a string or undefined is a plain Error, not a pass', async () => {
  const store = await openStore({ claims: [
    ns('async/', 'write', 'test', (() => Promise.resolve('never read')) as never),
    ns('null/', 'write', 'test', (() => null) as never),
  ] })
  await assert.rejects(store.write([{ path: 'async/a.md', text: 'x' }], { author: USERA }), isPlainError(/validate/))
  await assert.rejects(store.write([{ path: 'null/a.md', text: 'x' }], { author: USERA }), isPlainError(/validate/))
  assert.equal(await store.read('async/a.md'), undefined)
})

test('an agent writing a namespace whose policy is propose or none is FORBIDDEN; a user may', async () => {
  const { store, git } = await openAt({ claims: [ns('prompts/', 'write'), ns('families/', 'propose'), ns('README.md', 'none')] })
  const before = await objects(git)
  await assert.rejects(store.write([{ path: 'families/a.md', text: 'x' }], { author: AGENTA }), isStoreError('FORBIDDEN', 'families/a.md'))
  await assert.rejects(store.write([{ path: 'README.md', text: 'x' }], { author: AGENTA }), isStoreError('FORBIDDEN', 'README.md'))
  await assert.rejects(
    store.write([{ path: 'prompts/a.md', text: 'x' }, { path: 'families/a.md', text: 'x' }], { author: AGENTA }),
    isStoreError('FORBIDDEN'))
  assert.equal(await objects(git), before)
  assert.ok(await store.write([{ path: 'prompts/a.md', text: 'x' }], { author: AGENTA }))
  assert.ok(await store.write([{ path: 'families/a.md', text: 'x' }], { author: USERA }))
  assert.ok(await store.write([{ path: 'README.md', text: 'x' }], { author: USERA }))
})

test('a secret is SECRET, and no object is written (not even a blob)', async () => {
  const { store, git } = await openAt({ claims: [ns('prompts/')] })
  const head = await store.head()
  const before = await objects(git)
  await assert.rejects(
    store.write([{ path: 'prompts/ok.md', text: 'fine' }, { path: 'prompts/a.md', text: `token ${TOKEN}` }], { author: USERA }),
    (error: unknown) => {
      assert.ok(error instanceof ConfigStoreError)
      assert.equal(error.code, 'SECRET')
      assert.ok(!error.message.includes(TOKEN), 'the message never carries the secret')
      return true
    })
  assert.equal(await objects(git), before)
  assert.equal(await store.head(), head)
})

test('a document over the size cap is TOO_LARGE; the default cap is 262144 bytes', async () => {
  const store = await openStore({ claims: [ns('prompts/')] })
  assert.ok(await store.write([{ path: 'prompts/a.md', text: 'x'.repeat(262144) }], { author: USERA }))
  await assert.rejects(store.write([{ path: 'prompts/b.md', text: 'x'.repeat(262145) }], { author: USERA }), isStoreError('TOO_LARGE'))
  const small = await openStore({ claims: [ns('prompts/')], maxBytes: 10 })
  await assert.rejects(small.write([{ path: 'prompts/a.md', text: 'x'.repeat(11) }], { author: USERA }), isStoreError('TOO_LARGE'))
  assert.ok(await small.write([{ path: 'prompts/a.md', text: 'x'.repeat(10) }], { author: USERA }))
})

test('onCommit fires once per commit, with what write returns, and not for refused or no-op writes', async () => {
  const { seen, onCommit } = recorder()
  const store = await openStore({ claims: [ns('prompts/')], onCommit })
  assert.deepEqual(seen, [], 'opening a store (the root commit) is not announced')
  const first = await store.write([{ path: 'prompts/a.md', text: '1' }], { author: USERA })
  assert.deepEqual(seen, [first])
  await assert.rejects(store.write([{ path: 'other/a.md', text: '1' }], { author: USERA }))
  assert.equal(await store.write([{ path: 'prompts/a.md', text: '1' }], { author: USERA }), undefined)
  const second = await store.write([{ path: 'prompts/a.md', text: '2' }], { author: USERA })
  assert.deepEqual(seen, [first, second])
})

test('an onCommit callback that throws does not fail the write that already landed', async () => {
  const store = await openStore({ claims: [ns('prompts/')], onCommit: () => { throw new Error('listener bug') } })
  const warned = once(process, 'warning')
  const info = await store.write([{ path: 'prompts/a.md', text: '1' }], { author: USERA })
  assert.ok(info)
  const [warning] = await warned
  assert.match(String((warning as Error).message), /onCommit.*listener bug/)
  assert.equal(await store.read('prompts/a.md'), '1')
})

test('a second open on the same repository is LOCKED, and does not disturb the first', async () => {
  const { store, repository } = await openAt({ claims: [ns('prompts/')] })
  await assert.rejects(openStore({ repository }), isStoreError('LOCKED'))
  assert.ok(await store.write([{ path: 'prompts/a.md', text: 'x' }], { author: USERA }))
  await store.close()
  const again = await openStore({ repository, claims: [ns('prompts/')] })
  assert.equal(await again.read('prompts/a.md'), 'x')
})

// --- seed ---------------------------------------------------------------------------------------

test('seed writes only missing documents and is a no-op the second time', async () => {
  const { store, git } = await openAt({ claims: [ns('prompts/')] })
  const first = await store.seed({ 'prompts/a.md': 'A', 'prompts/b.md': 'B' }, 'test')
  assert.ok(first)
  assert.deepEqual(first.paths, ['prompts/a.md', 'prompts/b.md'])
  assert.deepEqual(first.author, { kind: 'system' })
  assert.equal(await store.seed({ 'prompts/a.md': 'A', 'prompts/b.md': 'B' }, 'test'), undefined)

  await store.write([{ path: 'prompts/a.md', text: 'edited by the user' }], { author: USERA })
  const third = await store.seed({ 'prompts/a.md': 'A', 'prompts/c.md': 'C' }, 'test')
  assert.ok(third)
  assert.deepEqual(third.paths, ['prompts/c.md'])
  assert.equal(await store.read('prompts/a.md'), 'edited by the user', 'an existing document is never overwritten')
  assert.equal(await store.read('prompts/c.md'), 'C')
  assert.equal(await store.seed({}, 'test'), undefined)
  assert.equal((await git.run(['rev-list', '--count', MAIN])).stdout.trim(), '4')
})

test('seed commits as the system author: subject "<owner> defaults", system trailer, the agent git identity', async () => {
  const { seen, onCommit } = recorder()
  const { store, git } = await openAt({ claims: [ns('prompts/', 'write', 'prompts')], onCommit })
  const info = await store.seed({ 'prompts/a.md': 'A' }, 'prompts')
  assert.ok(info)
  assert.equal(info.message, 'prompts/a.md: prompts defaults\n\nDish-Author-Kind: system\n')
  assert.equal(await storedMessage(git, info.id), info.message)
  assert.equal(await identities(git, info.id), `${AGENT.name}|${AGENT.email}|${AGENT.name}|${AGENT.email}`)
  assert.deepEqual(seen, [info])
})

test('seed refuses paths the owner does not own, and writes nothing at all', async () => {
  const { store, git } = await openAt({ claims: [ns('prompts/', 'write', 'prompts'), ns('crew.yaml', 'write', 'crew')] })
  const before = await objects(git)
  const head = await store.head()
  await assert.rejects(store.seed({ 'prompts/a.md': 'A', 'nowhere/x.md': 'X' }, 'prompts'), isStoreError('UNOWNED', 'nowhere/x.md'))
  await assert.rejects(store.seed({ 'prompts/a.md': 'A', 'crew.yaml': 'c' }, 'prompts'), isStoreError('UNOWNED', 'crew'))
  await assert.rejects(store.seed({ 'prompts/a.md': 'A' }, 'someone-else'), isStoreError('UNOWNED'))
  await assert.rejects(store.seed({ '../x': 'A' }, 'prompts'), isStoreError('INVALID'))
  assert.equal(await objects(git), before)
  assert.equal(await store.head(), head)
})

test('seed scans every path for secrets before it hands any of them to git', async () => {
  const { store, git } = await openAt({ claims: [ns('prompts/', 'write', 'prompts')] })
  const before = await objects(git)
  const runner = gitOf(store)
  const original = runner.run.bind(runner)
  let gitCalls = 0
  runner.run = async (...args) => { gitCalls++; return original(...args) }
  await assert.rejects(store.seed({ 'prompts/fine.md': 'x', [`prompts/${TOKEN}.md`]: 'x' }, 'prompts'), (error: unknown) => {
    assert.ok(error instanceof ConfigStoreError)
    assert.equal(error.code, 'SECRET')
    assert.ok(!error.message.includes(TOKEN), error.message)
    return true
  })
  await assert.rejects(store.seed({ 'prompts/../x': 'x' }, 'prompts'), isStoreError('INVALID'))
  assert.equal(gitCalls, 0, 'no git process was started')
  assert.equal(await objects(git), before)
})

test('seed runs the guard and the validators; the agent policy does not apply to it', async () => {
  const validate = (_path: string, text: string) => (text === 'bad' ? 'bad document' : undefined)
  const { store, git } = await openAt({ claims: [ns('prompts/', 'none', 'prompts', validate)] })
  const before = await objects(git)
  await assert.rejects(store.seed({ 'prompts/a.md': `x ${TOKEN}` }, 'prompts'), isStoreError('SECRET'))
  await assert.rejects(store.seed({ 'prompts/a.md': 'bad' }, 'prompts'), isStoreError('INVALID', 'prompts/a.md: bad document'))
  await assert.rejects(store.seed({ 'prompts/a.md': 5 as unknown as string }, 'prompts'), isStoreError('INVALID'))
  await assert.rejects(store.seed({ 'prompts/a.md': 'ok' }, 'bad\nowner'), isStoreError('INVALID'))
  assert.equal(await objects(git), before)
  assert.ok(await store.seed({ 'prompts/a.md': 'fine' }, 'prompts'), 'agent: none still lets the store seed its own namespace')
})

// --- seed with replace ---------------------------------------------------------------------------

/** Lowercase hex sha256 of `text` as UTF-8 bytes: what `SeedOptions.replace` lists. */
function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

const UPDATED_NOTE = 'updated to the new defaults'

describe('seed replace', () => {
  test('a missing path is written and a stored path with a listed hash replaced, in one commit carrying the note', async () => {
    const { seen, onCommit } = recorder()
    const { store, git } = await openAt({ claims: [ns('prompts/', 'write', 'prompts')], onCommit })
    await store.seed({ 'prompts/a.md': 'A v1' }, 'prompts')
    seen.length = 0
    const before = (await git.run(['rev-list', '--count', MAIN])).stdout.trim()

    const info = await store.seed(
      { 'prompts/a.md': 'A v2', 'prompts/b.md': 'B v1' },
      'prompts',
      { replace: { 'prompts/a.md': [sha256('A v0'), sha256('A v1')] } },
    )
    assert.ok(info)
    assert.deepEqual(info.paths, ['prompts/a.md', 'prompts/b.md'])
    assert.deepEqual(info.author, { kind: 'system' })
    assert.equal(info.note, UPDATED_NOTE)
    assert.equal(info.message, `prompts/a.md, prompts/b.md: prompts defaults\n\nDish-Author-Kind: system\nDish-Note: ${UPDATED_NOTE}\n`)
    assert.equal(await storedMessage(git, info.id), info.message)
    assert.equal(await store.read('prompts/a.md'), 'A v2')
    assert.equal(await store.read('prompts/b.md'), 'B v1')
    assert.equal((await git.run(['rev-list', '--count', MAIN])).stdout.trim(), String(Number(before) + 1), 'one commit')
    assert.deepEqual(seen, [info], 'announced once')
  })

  test('history shows the note, and the subject keeps its "<paths>: <owner> defaults" shape', async () => {
    const store = await openStore({ claims: [ns('prompts/', 'write', 'prompts')] })
    await store.seed({ 'prompts/a.md': 'A v1' }, 'prompts')
    const info = await store.seed({ 'prompts/a.md': 'A v2' }, 'prompts', { replace: { 'prompts/a.md': [sha256('A v1')] } })
    assert.ok(info)
    const log = await store.history({ path: 'prompts/a.md' })
    assert.deepEqual(log.map(commit => commit.id), [info.id, log[1]!.id])
    assert.equal(log[0]!.note, UPDATED_NOTE)
    assert.deepEqual(log[0]!.author, { kind: 'system' })
    assert.match(log[0]!.message, /^prompts\/a\.md: prompts defaults\n/)
    assert.equal(log[1]!.note, undefined, 'the first seed had nothing replaced, so no note')
  })

  test('a document whose hash is not listed is edited, and left alone, even when others are replaced', async () => {
    const store = await openStore({ claims: [ns('prompts/', 'write', 'prompts')] })
    await store.seed({ 'prompts/a.md': 'A v1', 'prompts/b.md': 'B v1' }, 'prompts')
    await store.write([{ path: 'prompts/a.md', text: 'A edited by the user' }], { author: USERA })

    const info = await store.seed(
      { 'prompts/a.md': 'A v2', 'prompts/b.md': 'B v2' },
      'prompts',
      { replace: { 'prompts/a.md': [sha256('A v1')], 'prompts/b.md': [sha256('B v1')] } },
    )
    assert.ok(info)
    assert.deepEqual(info.paths, ['prompts/b.md'])
    assert.equal(await store.read('prompts/a.md'), 'A edited by the user')
    assert.equal(await store.read('prompts/b.md'), 'B v2')
  })

  test('nothing to do returns undefined and makes no commit: edited, current, or no hash listed', async () => {
    const { store, git } = await openAt({ claims: [ns('prompts/', 'write', 'prompts')] })
    await store.seed({ 'prompts/a.md': 'A v1', 'prompts/b.md': 'B v1' }, 'prompts')
    await store.write([{ path: 'prompts/a.md', text: 'edited' }], { author: USERA })
    const head = await store.head()
    const before = await objects(git)

    assert.equal(await store.seed(
      { 'prompts/a.md': 'A v2', 'prompts/b.md': 'B v1' },
      'prompts',
      { replace: { 'prompts/a.md': [sha256('A v1')], 'prompts/b.md': [sha256('B v0')] } },
    ), undefined)
    assert.equal(await store.seed({ 'prompts/a.md': 'A v2' }, 'prompts', { replace: {} }), undefined)
    assert.equal(await store.seed({ 'prompts/a.md': 'A v2' }, 'prompts', { replace: { 'prompts/a.md': [] } }), undefined)
    assert.equal(await store.seed({ 'prompts/a.md': 'A v2' }, 'prompts', {}), undefined)
    assert.equal(await store.seed({}, 'prompts', { replace: {} }), undefined)
    assert.equal(await store.head(), head)
    assert.equal(await objects(git), before)
  })

  test('running the same upgrade twice replaces once: the second run finds the new text and is a no-op', async () => {
    const store = await openStore({ claims: [ns('prompts/', 'write', 'prompts')] })
    await store.seed({ 'prompts/a.md': 'A v1' }, 'prompts')
    const options = { replace: { 'prompts/a.md': [sha256('A v1')] } }
    assert.ok(await store.seed({ 'prompts/a.md': 'A v2' }, 'prompts', options))
    assert.equal(await store.seed({ 'prompts/a.md': 'A v2' }, 'prompts', options), undefined)
  })

  test('without a replacement there is no note, as before (a seed of missing paths only)', async () => {
    const store = await openStore({ claims: [ns('prompts/', 'write', 'prompts')] })
    const info = await store.seed({ 'prompts/a.md': 'A' }, 'prompts', { replace: { 'prompts/a.md': [sha256('old')] } })
    assert.ok(info)
    assert.equal(info.message, 'prompts/a.md: prompts defaults\n\nDish-Author-Kind: system\n')
    assert.equal('note' in info, false)
  })

  test('a stored text already equal to the new default is not a replacement: no change to it, and no note', async () => {
    const store = await openStore({ claims: [ns('prompts/', 'write', 'prompts')] })
    await store.seed({ 'prompts/a.md': 'A v2' }, 'prompts')
    const info = await store.seed(
      { 'prompts/a.md': 'A v2', 'prompts/b.md': 'B' },
      'prompts',
      { replace: { 'prompts/a.md': [sha256('A v2')] } },
    )
    assert.ok(info)
    assert.deepEqual(info.paths, ['prompts/b.md'])
    assert.equal(info.note, undefined)
    assert.equal(info.message, 'prompts/b.md: prompts defaults\n\nDish-Author-Kind: system\n')
    assert.equal(await store.read('prompts/a.md'), 'A v2')
  })

  test('a hash replaces only its own path, and the stored text is hashed as UTF-8, byte for byte', async () => {
    const store = await openStore({ claims: [ns('prompts/', 'write', 'prompts')] })
    const odd = 'caf\u00e9 \u{1F600}\r\n  trailing space \n\n'
    await store.seed({ 'prompts/a.md': 'same', 'prompts/b.md': 'same', 'prompts/c.md': odd }, 'prompts')
    const info = await store.seed(
      { 'prompts/a.md': 'new a', 'prompts/b.md': 'new b', 'prompts/c.md': 'new c' },
      'prompts',
      { replace: { 'prompts/a.md': [sha256('same')], 'prompts/c.md': [sha256(odd)] } },
    )
    assert.ok(info)
    assert.deepEqual(info.paths, ['prompts/a.md', 'prompts/c.md'])
    assert.equal(await store.read('prompts/a.md'), 'new a')
    assert.equal(await store.read('prompts/b.md'), 'same', 'b has no listed hash, though its text equals a hash listed for a')
    assert.equal(await store.read('prompts/c.md'), 'new c')

    // One byte off is an edit: the trimmed text does not match the stored one.
    const again = await store.seed({ 'prompts/d.md': 'x' }, 'prompts')
    assert.ok(again)
    assert.equal(await store.seed({ 'prompts/d.md': 'y' }, 'prompts', { replace: { 'prompts/d.md': [sha256('x\n')] } }), undefined)
    assert.equal(await store.read('prompts/d.md'), 'x')
  })

  test('a replace key that is not in defaults, or a malformed value, is INVALID and writes nothing at all', async () => {
    const { store, git } = await openAt({ claims: [ns('prompts/', 'write', 'prompts')] })
    await store.seed({ 'prompts/a.md': 'A v1' }, 'prompts')
    const head = await store.head()
    const before = await objects(git)
    const runner = gitOf(store)
    const original = runner.run.bind(runner)
    let gitCalls = 0
    runner.run = async (...args) => { gitCalls++; return original(...args) }
    const good = sha256('A v1')
    const defaults = { 'prompts/a.md': 'A v2', 'prompts/b.md': 'B' }
    const refuse = (replace: unknown, ...mentions: string[]) =>
      assert.rejects(store.seed(defaults, 'prompts', { replace } as never), isStoreError('INVALID', ...mentions))

    // A key that is no path of the defaults (even a real document of the store, or a made-up one).
    await refuse({ 'prompts/other.md': [good] }, 'prompts/other.md')
    await refuse({ 'prompts/a.md': [good], 'prompts/zzz.md': [good] }, 'prompts/zzz.md')
    await refuse({ 'nowhere/x.md': [good] })
    await refuse(JSON.parse('{"__proto__": []}'), '__proto__')
    await refuse({ constructor: [good] }, 'constructor')
    // A malformed hash: wrong length, uppercase, non-hex, non-string, not an array.
    await refuse({ 'prompts/a.md': [good.slice(1)] }, 'prompts/a.md')
    await refuse({ 'prompts/a.md': [good + '0'] }, 'prompts/a.md')
    await refuse({ 'prompts/a.md': [good.toUpperCase()] }, 'prompts/a.md')
    await refuse({ 'prompts/a.md': ['g'.repeat(64)] }, 'prompts/a.md')
    await refuse({ 'prompts/a.md': [good, 5] }, 'prompts/a.md')
    await refuse({ 'prompts/a.md': [` ${good.slice(1)}`] }, 'prompts/a.md')
    await refuse({ 'prompts/a.md': [`${good}\n`] }, 'prompts/a.md')
    await refuse({ 'prompts/a.md': good }, 'prompts/a.md')
    await refuse({ 'prompts/a.md': null }, 'prompts/a.md')
    await refuse({ 'prompts/a.md': { 0: good } }, 'prompts/a.md')
    // The whole `replace` is not an object.
    await refuse([good])
    await refuse(null)
    await refuse('prompts/a.md')
    await refuse(5)
    // `options` itself is not an object.
    for (const options of [null, 'replace', 5, [], () => undefined]) {
      await assert.rejects(store.seed(defaults, 'prompts', options as never), isStoreError('INVALID'))
    }
    // An invalid `replace` is refused even when there is nothing else to do.
    await assert.rejects(store.seed({}, 'prompts', { replace: { 'prompts/a.md': [good] } }), isStoreError('INVALID'))

    assert.equal(gitCalls, 0, 'refused before git was asked anything')
    assert.equal(await objects(git), before)
    assert.equal(await store.head(), head)
    assert.equal(await store.read('prompts/a.md'), 'A v1')
    assert.equal(await store.read('prompts/b.md'), undefined)
  })

  test('the owner, the paths, the guard and the validators apply to a replaced document as to a new one', async () => {
    const validate = (_path: string, text: string) => (text === 'bad' ? 'bad document' : undefined)
    const { store, git } = await openAt({ claims: [ns('prompts/', 'none', 'prompts', validate), ns('crew.yaml', 'write', 'crew')] })
    await store.seed({ 'prompts/a.md': 'A v1' }, 'prompts')
    const head = await store.head()
    const before = await objects(git)
    const replace = { 'prompts/a.md': [sha256('A v1')] }

    await assert.rejects(store.seed({ 'prompts/a.md': 'bad' }, 'prompts', { replace }), isStoreError('INVALID', 'prompts/a.md: bad document'))
    await assert.rejects(store.seed({ 'prompts/a.md': `x ${TOKEN}` }, 'prompts', { replace }), (error: unknown) => {
      assert.ok(error instanceof ConfigStoreError)
      assert.equal(error.code, 'SECRET')
      assert.ok(!error.message.includes(TOKEN), error.message)
      return true
    })
    await assert.rejects(store.seed({ 'prompts/a.md': 'A v2' }, 'someone-else', { replace }), isStoreError('UNOWNED'))
    await assert.rejects(store.seed({ 'prompts/a.md': 'A v2', 'crew.yaml': 'c' }, 'prompts', { replace }), isStoreError('UNOWNED', 'crew'))
    await assert.rejects(store.seed({ 'prompts/a.md': 5 as unknown as string }, 'prompts', { replace }), isStoreError('INVALID'))
    assert.equal(await objects(git), before)
    assert.equal(await store.head(), head)
    assert.equal(await store.read('prompts/a.md'), 'A v1')

    assert.ok(await store.seed({ 'prompts/a.md': 'A v2' }, 'prompts', { replace }), 'agent: none still lets the store replace its own defaults')
    assert.equal(await store.read('prompts/a.md'), 'A v2')
  })

  test('a document an outside writer changed in the meantime is CONFLICT, never overwritten', async () => {
    const { store, git } = await openAt({ claims: [ns('prompts/', 'write', 'prompts')] })
    await store.seed({ 'prompts/a.md': 'A v1' }, 'prompts')
    const { externalIds } = interfere(store, git, 1, 'prompts/a.md')
    await assert.rejects(
      store.seed({ 'prompts/a.md': 'A v2' }, 'prompts', { replace: { 'prompts/a.md': [sha256('A v1')] } }),
      isStoreError('CONFLICT', 'prompts/a.md'),
    )
    assert.equal(await mainOf(git), externalIds[0])
    assert.equal(await store.read('prompts/a.md'), 'external 0', 'the outside edit stands')
  })

  test('an outside change to another path only makes the replacement retry on the new head', async () => {
    const { store, git } = await openAt({ claims: [ns('prompts/', 'write', 'prompts')] })
    await store.seed({ 'prompts/a.md': 'A v1' }, 'prompts')
    const { externalIds } = interfere(store, git, 1, 'prompts/ext.md')
    const info = await store.seed({ 'prompts/a.md': 'A v2' }, 'prompts', { replace: { 'prompts/a.md': [sha256('A v1')] } })
    assert.ok(info)
    assert.equal((await git.run(['rev-parse', `${info.id}^`])).stdout.trim(), externalIds[0], 'built on top of the outside commit')
    assert.deepEqual(info.paths, ['prompts/a.md'])
    assert.equal(await store.read('prompts/a.md'), 'A v2')
    assert.equal(await store.read('prompts/ext.md'), 'external 0')
  })
})

// --- open and the repository ---------------------------------------------------------------------

test('open initializes a bare repository: one root commit, empty tree, "Initialize dish config", authored as the agent identity', async () => {
  const { store, git } = await openAt()
  const head = await store.head()
  assert.match(head, /^[0-9a-f]{40}$/)
  assert.equal(await mainOf(git), head)
  assert.equal((await git.run(['rev-list', '--count', head])).stdout.trim(), '1')
  assert.equal((await git.run(['ls-tree', '-r', head])).stdout, '')
  assert.equal(await storedMessage(git, head), 'Initialize dish config\n\nDish-Author-Kind: system\n')
  assert.equal(await identities(git, head), `${AGENT.name}|${AGENT.email}|${AGENT.name}|${AGENT.email}`)
})

test('reopening an existing repository makes no new commit', async () => {
  const { store, repository } = await openAt({ claims: [ns('prompts/')] })
  await store.write([{ path: 'prompts/a.md', text: 'A' }], { author: USERA })
  const head = await store.head()
  await store.close()
  const again = await openStore({ repository, claims: [ns('prompts/')] })
  assert.equal(await again.head(), head)
  assert.equal(await again.read('prompts/a.md'), 'A')
})

test('open creates the repository directory (and its parents) when missing', async () => {
  const repository = join(await repoPath(), 'deeper', 'config.git')
  const store = await openStore({ repository })
  assert.match(await store.head(), /^[0-9a-f]{40}$/)
})

test('open refuses to initialize over a directory with other files, touches none of them, and releases the lock', async () => {
  const repository = await repoPath()
  await mkdir(repository)
  await writeFile(join(repository, 'notes.txt'), 'mine')
  await assert.rejects(openStore({ repository }), isPlainError(/not a dish config repository, refusing to initialize over existing files/))
  assert.deepEqual(await readdir(repository), ['notes.txt'], 'no lock left behind, nothing created')
  assert.equal(await readFile(join(repository, 'notes.txt'), 'utf8'), 'mine')
})

test('open initializes a directory that holds only lock files', async () => {
  const repository = await repoPath()
  await mkdir(repository)
  await writeFile(join(repository, 'dish.lock.999999.0123abcd.tmp'), 'left by a crash')
  const store = await openStore({ repository })
  assert.match(await store.head(), /^[0-9a-f]{40}$/)
})

test('an interrupted first start (an empty bare repo with no refs) is completed', async () => {
  const repository = await repoPath()
  await new Git(repository).initBare('main')
  const store = await openStore({ repository })
  assert.equal(await storedMessage(new Git(repository), await store.head()), 'Initialize dish config\n\nDish-Author-Kind: system\n')
})

test('a repository that has refs but no refs/heads/main is refused and left alone', async () => {
  const repository = await repoPath()
  const git = new Git(repository)
  await git.initBare('main')
  const other = await git.commitTree(await git.emptyTree(), [], 'other', USER)
  assert.equal(await git.casRef('refs/heads/other', other, null), true)
  await assert.rejects(openStore({ repository }), isPlainError(/refs\/heads\/main/))
  assert.equal(await mainOf(git), undefined)

  const stray = await repoPath()
  const strayGit = new Git(stray)
  await strayGit.initBare('main')
  await strayGit.run(['symbolic-ref', 'HEAD', 'refs/heads/master'])
  await assert.rejects(openStore({ repository: stray }), isPlainError(/refs\/heads\/main/))
  assert.equal(await strayGit.resolve('refs/heads/master'), undefined)
})

/** A repository the way a crash in the middle of `git init --bare` leaves it: some of what init makes, removed. */
async function crashedInit(remove: string[]): Promise<string> {
  const repository = await repoPath()
  await new Git(repository).initBare('main')
  for (const name of remove) await rm(join(repository, name), { recursive: true })
  return repository
}

const INIT_CRASHES: Record<string, string[]> = {
  'before HEAD: only config, description and hooks': ['HEAD', 'refs', 'objects', 'info', 'branches'],
  'before HEAD, with info and branches': ['HEAD', 'refs', 'objects'],
  'HEAD written, objects/ not yet': ['objects'],
  'HEAD and objects written, refs/ not yet': ['refs'],
}

for (const [label, remove] of Object.entries(INIT_CRASHES)) {
  test(`a first start that crashed inside git init is completed: ${label}`, async () => {
    const repository = await crashedInit(remove)
    const store = await openStore({ repository })
    const git = new Git(repository)
    const head = await store.head()
    assert.equal(await storedMessage(git, head), 'Initialize dish config\n\nDish-Author-Kind: system\n')
    assert.equal((await git.run(['rev-list', '--count', head])).stdout.trim(), '1')
    assert.equal((await git.run(['rev-parse', '--show-ref-format'])).stdout.trim(), 'files')
    await git.run(['fsck'])
    assert.equal((await git.run(['symbolic-ref', 'HEAD'])).stdout.trim(), MAIN)
  })
}

test('a directory that is not a repository, even with a HEAD file, is left exactly as it was', async () => {
  const repository = await repoPath()
  await mkdir(join(repository, 'refs', 'heads'), { recursive: true })
  const files = ['HEAD', 'dish-index-keepme', join('refs', 'heads', 'x.lock'), 'packed-refs.lock']
  for (const name of files) await writeFile(join(repository, name), 'not git')
  await assert.rejects(openStore({ repository }), isPlainError(/not a dish config repository, refusing to initialize over existing files/))
  for (const name of files) assert.equal(await readFile(join(repository, name), 'utf8'), 'not git', `${name} is untouched`)
  assert.deepEqual((await readdir(repository)).sort(), ['HEAD', 'dish-index-keepme', 'packed-refs.lock', 'refs'], 'no lock left behind')
})

test('the refusal to initialize over existing files carries git\'s own reason, so a corrupt real repository is not misreported', async () => {
  // A repository that is really one (packed refs and all), with a HEAD git cannot read.
  const repository = await repoPath()
  await new Git(repository).initBare('main')
  await writeFile(join(repository, 'packed-refs'), '# pack-refs with: peeled fully-peeled sorted\n')
  await writeFile(join(repository, 'HEAD'), 'garbage\n')
  await assert.rejects(openStore({ repository }), isPlainError(
    /not a dish config repository, refusing to initialize over existing files \(git: fatal: not a git repository: .+\)$/))
  assert.equal(await readFile(join(repository, 'HEAD'), 'utf8'), 'garbage\n', 'left as it was')
})

test('a first start that crashed inside git init, leaving config.lock or HEAD.lock, is completed: the locks are removed first', async () => {
  for (const leftovers of [['config.lock'], ['HEAD.lock'], ['config.lock', 'HEAD.lock']]) {
    const repository = await repoPath()
    await mkdir(repository)
    for (const name of leftovers) await writeFile(join(repository, name), 'left by a crash')
    const store = await openStore({ repository })
    assert.equal(await storedMessage(new Git(repository), await store.head()), 'Initialize dish config\n\nDish-Author-Kind: system\n', leftovers.join())
    const names = await readdir(repository)
    for (const name of leftovers) assert.ok(!names.includes(name), `${name} is removed`)
  }
})

test('a half-made repository with a config.lock is completed too, and the lock is removed', async () => {
  const repository = await crashedInit(['HEAD', 'refs', 'objects', 'info', 'branches'])
  await writeFile(join(repository, 'config.lock'), 'left by a crash')
  await writeFile(join(repository, 'HEAD.lock'), 'left by a crash')
  const store = await openStore({ repository })
  assert.match(await store.head(), /^[0-9a-f]{40}$/)
  assert.deepEqual((await readdir(repository)).filter(name => name.endsWith('.lock')), ['dish.lock'], 'only our own lock remains')
})

test('config.lock and HEAD.lock are only taken for leftovers when nothing else is in the way', async () => {
  const repository = await repoPath()
  await mkdir(repository)
  for (const name of ['config.lock', 'HEAD.lock', 'notes.txt']) await writeFile(join(repository, name), 'mine')
  await assert.rejects(openStore({ repository }), isPlainError(/not a dish config repository, refusing to initialize over existing files/))
  assert.deepEqual((await readdir(repository)).sort(), ['HEAD.lock', 'config.lock', 'notes.txt'], 'nothing touched, no lock left behind')

  // A directory by that name is not a lock file.
  const odd = await repoPath()
  await mkdir(join(odd, 'config.lock'), { recursive: true })
  await assert.rejects(openStore({ repository: odd }), isPlainError(/refusing to initialize over existing files/))
  await stat(join(odd, 'config.lock'))
})

test('open validates maxBytes before it takes any lock', async () => {
  const repository = await repoPath()
  await assert.rejects(openStore({ repository, maxBytes: Number.NaN }), isPlainError(/maxBytes/))
  await assert.rejects(stat(repository), { code: 'ENOENT' })
})

// --- startup cleanup ----------------------------------------------------------------------------

test('startup removes what a crashed process left behind, but only once it holds the lock', async () => {
  const { store, repository } = await openAt({ claims: [ns('prompts/')] })
  await store.write([{ path: 'prompts/a.md', text: 'A' }], { author: USERA })
  const staleTemp = `dish.lock.${await deadPid()}.0123abcd.tmp`
  const stale = [
    'dish-index-0a1b2c3d', 'dish-index-0a1b2c3d.lock', staleTemp, 'packed-refs.lock',
    'refs/heads/main.lock', 'refs/heads/nested/branch.lock', 'refs/tags/v1.lock',
  ]
  const mine = `dish.lock.${process.pid}.0123abcd.tmp`
  const unrelated = ['dish.lockx', 'dish-indexed', 'packed-refs.bak', 'notes.lock']
  await mkdir(join(repository, 'refs', 'heads', 'nested'), { recursive: true })
  await mkdir(join(repository, 'refs', 'tags'), { recursive: true })
  for (const name of [...stale, mine, ...unrelated]) await writeFile(join(repository, name), 'x')
  await age(join(repository, staleTemp), 120_000)
  const keep = new Git(repository)
  assert.equal(await keep.casRef('refs/heads/keep', await store.head(), null), true)

  // Another process holds the lock (this store): a second open must not delete anything.
  await assert.rejects(openStore({ repository }), isStoreError('LOCKED'))
  for (const name of [...stale, mine, ...unrelated]) await stat(join(repository, name))

  await store.close()
  const reopened = await openStore({ repository, claims: [ns('prompts/')] })
  for (const name of stale) await assert.rejects(stat(join(repository, name)), { code: 'ENOENT' }, `${name} is removed`)
  for (const name of [mine, ...unrelated, 'HEAD', 'config', 'dish.lock', 'refs/heads/keep']) await stat(join(repository, name))
  assert.equal(await reopened.read('prompts/a.md'), 'A')
  // A stale ref lock would have made every update-ref throw.
  assert.ok(await reopened.write([{ path: 'prompts/b.md', text: 'B' }], { author: USERA }))
})

test('startup leaves a lock temp file alone unless its process is dead and it is more than a minute old', async () => {
  const { store, repository } = await openAt()
  await store.close()
  const dead = await deadPid()
  const named = (pid: number, tag: string) => `dish.lock.${pid}.${tag}.tmp`
  const plan = [
    { name: named(dead, '00000001'), ageMs: 120_000, removed: true },
    { name: named(dead, '00000002'), ageMs: 1_000, removed: false },       // another process may be mid-acquire
    { name: named(process.ppid, '00000003'), ageMs: 120_000, removed: false }, // its process is alive
    { name: named(process.pid, '00000004'), ageMs: 120_000, removed: false }, // ours
  ]
  for (const { name, ageMs } of plan) {
    await writeFile(join(repository, name), 'x')
    await age(join(repository, name), ageMs)
  }
  await openStore({ repository })
  for (const { name, removed } of plan) {
    if (removed) await assert.rejects(stat(join(repository, name)), { code: 'ENOENT' }, name)
    else await stat(join(repository, name))
  }
})

// --- close --------------------------------------------------------------------------------------

test('close waits for queued work, is idempotent, and releases the lock; later operations throw a plain Error', async () => {
  const { store, repository } = await openAt({ claims: [ns('prompts/')] })
  let finished = false
  const pending = store.write([{ path: 'prompts/a.md', text: 'A' }], { author: USERA }).then(info => { finished = true; return info })
  const closing = store.close()
  const again = store.close()
  await Promise.all([closing, again])
  assert.equal(finished, true, 'close resolves only after the work queued before it is done')
  assert.ok(await pending, 'and that work completed')
  await store.close()

  const closed = isPlainError(/^config store is closed$/)
  await assert.rejects(store.head(), closed)
  await assert.rejects(store.read('prompts/a.md'), closed)
  await assert.rejects(store.list('prompts/'), closed)
  await assert.rejects(store.write([{ path: 'prompts/b.md', text: 'B' }], { author: USERA }), closed)
  await assert.rejects(store.seed({ 'prompts/b.md': 'B' }, 'test'), closed)

  const reopened = await openStore({ repository, claims: [ns('prompts/')] })
  assert.equal(await reopened.read('prompts/a.md'), 'A')
})

// --- refs ---------------------------------------------------------------------------------------

test('read and list take "main" (the default) or a full commit id, and nothing else', async () => {
  const { store, git } = await openAt({ claims: [ns('prompts/')] })
  const one = (await store.write([{ path: 'prompts/a.md', text: '1' }], { author: USERA }))!
  const two = (await store.write([{ path: 'prompts/a.md', text: '2' }, { path: 'prompts/b.md', text: 'B' }], { author: USERA }))!
  assert.equal(await store.read('prompts/a.md'), '2')
  assert.equal(await store.read('prompts/a.md', 'main'), '2')
  assert.equal(await store.read('prompts/a.md', one.id), '1')
  assert.equal(await store.read('prompts/b.md', one.id), undefined)
  assert.deepEqual(await store.list('prompts/', one.id), ['prompts/a.md'])
  assert.deepEqual(await store.list('prompts/'), ['prompts/a.md', 'prompts/b.md'])
  assert.deepEqual(await store.list('prompts/', two.id), ['prompts/a.md', 'prompts/b.md'])

  const tree = (await git.run(['rev-parse', `${two.id}^{tree}`])).stdout.trim()
  const bad = [
    'refs/heads/main', 'HEAD', 'main~1', `${two.id}~1`, two.id.slice(0, 12), two.id.toUpperCase(), '--help', '', ' main',
    'refs/dish/rejected/x', 'proposal/abcd1234', '0'.repeat(40), 'a'.repeat(40), tree,
  ]
  for (const ref of bad) {
    await assert.rejects(store.read('prompts/a.md', ref), isStoreError('NOT_FOUND'), `read ref ${JSON.stringify(ref)}`)
    await assert.rejects(store.list('prompts/', ref), isStoreError('NOT_FOUND'), `list ref ${JSON.stringify(ref)}`)
  }
})

test('read and list answer for paths that cannot be documents instead of passing them to git', async () => {
  const store = await openStore({ claims: [ns('prompts/')] })
  await store.write([{ path: 'prompts/a.md', text: 'A' }], { author: USERA })
  for (const path of ['../x', '/prompts/a.md', 'prompts/', 'prompts', 'prompts/../prompts/a.md', 'prompts\\a.md', '', 'prompts/a.md\n']) {
    assert.equal(await store.read(path), undefined, JSON.stringify(path))
  }
  assert.deepEqual(await store.list('../prompts/'), [])
  assert.deepEqual(await store.list('/'), [])
  assert.deepEqual(await store.list('prompts//'), [])
  assert.deepEqual(await store.list('prompts'), ['prompts/a.md'])
  assert.deepEqual(await store.list(''), ['prompts/a.md'])
})

// --- messages, authors and notes ----------------------------------------------------------------

test('a user commit: subject "<path>: edited in web UI", a blank line, the author-kind trailer; stored exactly as returned', async () => {
  const { store, git } = await openAt({ claims: [ns('prompts/')] })
  const c = await store.write([{ path: 'prompts/a.md', text: 'A' }], { author: USERA })
  assert.ok(c)
  assert.equal(c.message, 'prompts/a.md: edited in web UI\n\nDish-Author-Kind: user\n')
  assert.equal(await storedMessage(git, c.id), c.message)
  assert.deepEqual(c.author, { kind: 'user' })
  assert.equal(c.note, undefined)
  assert.ok(!('note' in c), 'a commit without a note has no note key')
  assert.equal(await identities(git, c.id), `${USER.name}|${USER.email}|${USER.name}|${USER.email}`)
})

test('an agent commit: role defaults to main; session and role trailers; the agent git identity', async () => {
  const { store, git } = await openAt({ claims: [ns('prompts/')] })
  const c = await store.write([{ path: 'prompts/a.md', text: 'A' }], { author: { kind: 'agent', sessionId: 'sess-1' } })
  assert.ok(c)
  assert.equal(c.message, 'prompts/a.md: edited by main agent\n\nDish-Author-Kind: agent\nDish-Session: sess-1\nDish-Role: main\n')
  assert.equal(await storedMessage(git, c.id), c.message)
  assert.deepEqual(c.author, { kind: 'agent', sessionId: 'sess-1', role: 'main' })
  assert.equal(await identities(git, c.id), `${AGENT.name}|${AGENT.email}|${AGENT.name}|${AGENT.email}`)

  const d = await store.write([{ path: 'prompts/a.md', text: 'B' }], { author: AGENTA, note: 'tighten the intro' })
  assert.ok(d)
  assert.equal(d.message,
    'prompts/a.md: tighten the intro\n\nDish-Author-Kind: agent\nDish-Session: s1\nDish-Role: coder\nDish-Note: tighten the intro\n')
  assert.equal(d.note, 'tighten the intro')
  assert.deepEqual(d.author, { kind: 'agent', sessionId: 's1', role: 'coder' })
})

test('the subject names the first three paths, then "and N more"; paths are sorted', async () => {
  const store = await openStore({ claims: [ns('prompts/')] })
  const names = ['e', 'd', 'c', 'b', 'a']
  const c = await store.write(names.map(n => ({ path: `prompts/${n}.md`, text: n })), { author: USERA })
  assert.ok(c)
  assert.deepEqual(c.paths, ['prompts/a.md', 'prompts/b.md', 'prompts/c.md', 'prompts/d.md', 'prompts/e.md'])
  assert.equal(c.message.split('\n')[0], 'prompts/a.md, prompts/b.md, prompts/c.md and 2 more: edited in web UI')
  const three = await store.write(['x', 'y', 'z'].map(n => ({ path: `prompts/${n}.md`, text: n })), { author: USERA })
  assert.equal(three!.message.split('\n')[0], 'prompts/x.md, prompts/y.md, prompts/z.md: edited in web UI')
})

test('CommitInfo.time is the commit time in milliseconds', async () => {
  const { store, git } = await openAt({ claims: [ns('prompts/')] })
  const c = await store.write([{ path: 'prompts/a.md', text: 'A' }], { author: USERA })
  assert.ok(c)
  const seconds = Number((await git.run(['log', '-1', '--format=%at', c.id])).stdout.trim())
  assert.equal(c.time, seconds * 1000)
  assert.ok(Math.abs(Date.now() - c.time) < 60_000)
  assert.equal(c.id, await store.head())
})

test('a note is whitespace-collapsed, trimmed and capped at 200 characters; it never forges a trailer', async () => {
  const store = await openStore({ claims: [ns('prompts/')] })
  const spaced = await store.write([{ path: 'prompts/a.md', text: '1' }], { author: USERA, note: '  line one\n\n\tline   two\r\nthree four  ' })
  assert.equal(spaced!.note, 'line one line two three four')
  assert.equal(spaced!.message.split('\n')[0], 'prompts/a.md: line one line two three four')

  const long = await store.write([{ path: 'prompts/a.md', text: '2' }], { author: USERA, note: 'x'.repeat(300) })
  assert.equal(long!.note, 'x'.repeat(200))

  const emoji = await store.write([{ path: 'prompts/a.md', text: '3' }], { author: USERA, note: '\u{1F600}'.repeat(150) })
  assert.equal(emoji!.note, '\u{1F600}'.repeat(150), 'under the cap in characters, so untouched')
  const emojiLong = await store.write([{ path: 'prompts/a.md', text: '4' }], { author: USERA, note: '\u{1F600}'.repeat(250) })
  assert.equal(emojiLong!.note, '\u{1F600}'.repeat(200), 'the cap counts characters, never splitting a surrogate pair')

  const trailing = await store.write([{ path: 'prompts/a.md', text: '5' }], { author: USERA, note: `${'x'.repeat(199)} tail` })
  assert.equal(trailing!.note, 'x'.repeat(199), 'no trailing space left by the cap')

  const forged = await store.write([{ path: 'prompts/a.md', text: '6' }], { author: USERA, note: 'ok\nDish-Author-Kind: agent\nDish-Role: root' })
  assert.ok(forged)
  assert.equal(forged.message.split('\n').filter(line => line.startsWith('Dish-')).length, 2)
  assert.equal(forged.note, 'ok Dish-Author-Kind: agent Dish-Role: root')
})

test('a note that is only whitespace counts as no note', async () => {
  const store = await openStore({ claims: [ns('prompts/')] })
  const c = await store.write([{ path: 'prompts/a.md', text: '1' }], { author: USERA, note: ' \n\t ' })
  assert.ok(c)
  assert.ok(!('note' in c))
  assert.equal(c.message, 'prompts/a.md: edited in web UI\n\nDish-Author-Kind: user\n')
})

test('a note with control characters left after normalizing is INVALID; so is a non-string note', async () => {
  const { store, git } = await openAt({ claims: [ns('prompts/')] })
  const before = await objects(git)
  for (const note of ['bad\u0000note', '\u001b[31mred', 'bell\u0007', 'del\u007f', 'c1\u0085x']) {
    await assert.rejects(store.write([{ path: 'prompts/a.md', text: '1' }], { author: USERA, note }), isStoreError('INVALID', 'note'), JSON.stringify(note))
  }
  await assert.rejects(store.write([{ path: 'prompts/a.md', text: '1' }], { author: USERA, note: 5 as unknown as string }), isStoreError('INVALID', 'note'))
  assert.equal(await objects(git), before)
})

test('agent sessionId and role must match [A-Za-z0-9._:-]{1,128}', async () => {
  const { store, git } = await openAt({ claims: [ns('prompts/')] })
  const before = await objects(git)
  const write = (author: unknown) => store.write([{ path: 'prompts/a.md', text: '1' }], { author } as unknown as WriteMeta)
  const bad = ['', 'a b', 'a/b', 'a\nb', 'x'.repeat(129), 'café', 5, null]
  for (const value of bad) {
    await assert.rejects(write({ kind: 'agent', sessionId: value }), isStoreError('INVALID', 'sessionId'), `sessionId ${JSON.stringify(value)}`)
    await assert.rejects(write({ kind: 'agent', sessionId: 's1', role: value }), isStoreError('INVALID', 'role'), `role ${JSON.stringify(value)}`)
  }
  await assert.rejects(write({ kind: 'agent' }), isStoreError('INVALID', 'sessionId'))
  assert.equal(await objects(git), before)
  const ok = await write({ kind: 'agent', sessionId: `${'x'.repeat(100)}._:-9`, role: 'R.0_1:a-b' })
  assert.ok(ok)
  assert.deepEqual(ok.author, { kind: 'agent', sessionId: `${'x'.repeat(100)}._:-9`, role: 'R.0_1:a-b' })
})

test('only user and agent authors may write; a store-internal system author is INVALID here', async () => {
  const store = await openStore({ claims: [ns('prompts/')] })
  for (const author of [{ kind: 'system' }, { kind: 'root' }, {}, null, 'user', undefined]) {
    await assert.rejects(
      store.write([{ path: 'prompts/a.md', text: '1' }], { author } as unknown as WriteMeta),
      isStoreError('INVALID', 'author'), JSON.stringify(author))
  }
  await assert.rejects(store.write([{ path: 'prompts/a.md', text: '1' }], undefined as unknown as WriteMeta), isStoreError('INVALID'))
})

test('a secret in the note, role or sessionId is SECRET, names the field, and writes no object', async () => {
  const { store, git } = await openAt({ claims: [ns('prompts/')] })
  const before = await objects(git)
  const refused = (field: string, secret: string) => (error: unknown): boolean => {
    assert.ok(error instanceof ConfigStoreError)
    assert.equal(error.code, 'SECRET')
    assert.ok(error.message.includes(field), `names the field: ${error.message}`)
    assert.ok(!error.message.includes(secret), 'never the value')
    return true
  }
  const change = [{ path: 'prompts/a.md', text: '1' }]
  await assert.rejects(store.write(change, { author: USERA, note: `fixing ${TOKEN} for you` }), refused('note', TOKEN))
  await assert.rejects(store.write(change, { author: AGENTA, note: `${'x'.repeat(250)} ${SK_KEY}` }), refused('note', SK_KEY))
  await assert.rejects(store.write(change, { author: { kind: 'agent', sessionId: 's1', role: SK_KEY } }), refused('role', SK_KEY))
  await assert.rejects(store.write(change, { author: { kind: 'agent', sessionId: AWS_KEY } }), refused('sessionId', AWS_KEY))
  await assert.rejects(store.write(change, { author: { kind: 'agent', sessionId: TOKEN } }), refused('sessionId', TOKEN))
  assert.equal(await objects(git), before)
})

test('a note whose cap leaves a secret behind is SECRET, though the whole note matched nothing', async () => {
  const { store, git } = await openAt({ claims: [ns('prompts/')] })
  const before = await objects(git)
  // 17 characters after AKIA match nothing; cut to 16 at the 200-character cap, they are an access key.
  const note = `${'x'.repeat(179)} AKIA${'A'.repeat(17)}`
  assert.equal(secretKind(note), undefined)
  assert.equal(secretKind(Array.from(note).slice(0, 200).join('')), 'an AWS access key ID')
  await assert.rejects(store.write([{ path: 'prompts/a.md', text: '1' }], { author: USERA, note }), isStoreError('SECRET', 'note'))
  assert.equal(await objects(git), before)
  assert.ok(await store.write([{ path: 'prompts/a.md', text: '1' }], { author: USERA, note: `${'x'.repeat(179)} AKIA${'A'.repeat(15)}` }))
})

// --- write: order of checks ---------------------------------------------------------------------

test('changes must be a non-empty list of well-formed changes with distinct paths', async () => {
  const { store, git } = await openAt({ claims: [ns('prompts/')] })
  const before = await objects(git)
  const write = (changes: unknown) => store.write(changes as Change[], { author: USERA })
  await assert.rejects(write([]), isStoreError('INVALID'))
  await assert.rejects(write(undefined), isStoreError('INVALID'))
  await assert.rejects(write('prompts/a.md'), isStoreError('INVALID'))
  await assert.rejects(write([null]), isStoreError('INVALID'))
  await assert.rejects(write([{ text: 'x' }]), isStoreError('INVALID'))
  await assert.rejects(write([{ path: 5, text: 'x' }]), isStoreError('INVALID'))
  await assert.rejects(write([{ path: 'prompts/a.md' }]), isStoreError('INVALID'))
  await assert.rejects(write([{ path: 'prompts/a.md', text: 5 }]), isStoreError('INVALID'))
  await assert.rejects(write([{ path: 'prompts/a.md', delete: false }]), isStoreError('INVALID'))
  await assert.rejects(write([{ path: 'prompts/a.md', text: 'x', delete: true }]), isStoreError('INVALID'))
  await assert.rejects(
    write([{ path: 'prompts/a.md', text: 'x' }, { path: 'prompts/a.md', text: 'y' }]),
    isStoreError('INVALID', 'prompts/a.md'))
  await assert.rejects(
    write([{ path: 'prompts/a.md', text: 'x' }, { path: 'prompts/a.md', delete: true }]),
    isStoreError('INVALID', 'prompts/a.md'))
  assert.equal(await objects(git), before)
})

test('a path that cannot be a document is INVALID, before ownership is looked at', async () => {
  const { store, git } = await openAt({ claims: [ns('prompts/')] })
  const before = await objects(git)
  for (const path of ['../x.md', 'prompts/../x.md', '/prompts/a.md', 'prompts/', 'prompts//a.md', 'prompts/.git/x', 'prompts\\a.md', 'prompts/a\nb.md', 'prompts/a\u0000b.md', '']) {
    await assert.rejects(store.write([{ path, text: 'x' }], { author: USERA }), isStoreError('INVALID'), JSON.stringify(path))
    await assert.rejects(store.write([{ path, delete: true }], { author: USERA }), isStoreError('INVALID'), `delete ${JSON.stringify(path)}`)
  }
  assert.equal(await objects(git), before)
})

test('a path that holds a secret is never quoted back, whichever check catches it first', async () => {
  const { store, git } = await openAt({ claims: [ns('prompts/')] })
  const before = await objects(git)
  for (const path of [`../${TOKEN}`, `other/${TOKEN}.md`, `prompts/${TOKEN}.md`]) {
    for (const change of [{ path, text: 'x' }, { path, delete: true }] as Change[]) {
      await assert.rejects(store.write([change], { author: USERA }), (error: unknown) => {
        assert.ok(error instanceof ConfigStoreError)
        assert.ok(!error.message.includes(TOKEN), error.message)
        return true
      })
    }
  }
  assert.equal(await objects(git), before)
})

test('checks run in order: shape, path, owner, policy, secret and size, validate, meta', async () => {
  const validated: string[] = []
  const validate = (path: string) => { validated.push(path); return 'validator says no' }
  const { store, git } = await openAt({
    claims: [ns('prompts/', 'write', 'test', validate), ns('families/', 'propose'), ns('crew.yaml', 'write', 'crew')],
    maxBytes: 100,
  })
  const before = await objects(git)
  const secret = `x ${TOKEN}`
  const goodMeta = { author: USERA }

  // path before owner: a "../" path is INVALID, not UNOWNED
  await assert.rejects(store.write([{ path: '../elsewhere.md', text: 'x' }], goodMeta), isStoreError('INVALID'))
  // owner before the guard: an unowned path with a secret is UNOWNED
  await assert.rejects(store.write([{ path: 'unowned/a.md', text: secret }], goodMeta), isStoreError('UNOWNED'))
  // policy before the guard: an agent in a propose namespace with a secret is FORBIDDEN
  await assert.rejects(store.write([{ path: 'families/a.md', text: secret }], { author: AGENTA }), isStoreError('FORBIDDEN'))
  // the guard before the validator: SECRET, not INVALID, and the validator never saw the text
  await assert.rejects(store.write([{ path: 'prompts/a.md', text: secret }], goodMeta), isStoreError('SECRET'))
  await assert.rejects(store.write([{ path: 'prompts/a.md', text: 'x'.repeat(101) }], goodMeta), isStoreError('TOO_LARGE'))
  assert.deepEqual(validated, [])
  // the validator before the meta checks: INVALID from the validator wins over a bad note
  await assert.rejects(store.write([{ path: 'prompts/a.md', text: 'fine' }], { author: USERA, note: TOKEN }), isStoreError('INVALID', 'validator says no'))
  assert.deepEqual(validated, ['prompts/a.md'])
  // and once the validator passes, the meta is checked
  await assert.rejects(store.write([{ path: 'crew.yaml', text: 'fine' }], { author: USERA, note: TOKEN }), isStoreError('SECRET', 'note'))
  assert.equal(await objects(git), before)
})

// --- write: deletes, base, no-ops, retry --------------------------------------------------------

test('a delete removes the file and appears in the commit', async () => {
  const store = await openStore({ claims: [ns('prompts/')] })
  await store.write([{ path: 'prompts/a.md', text: 'A' }, { path: 'prompts/b.md', text: 'B' }], { author: USERA })
  const c = await store.write([{ path: 'prompts/a.md', delete: true }, { path: 'prompts/c.md', text: 'C' }], { author: USERA })
  assert.ok(c)
  assert.deepEqual(c.paths, ['prompts/a.md', 'prompts/c.md'])
  assert.equal(await store.read('prompts/a.md'), undefined)
  assert.deepEqual(await store.list('prompts/'), ['prompts/b.md', 'prompts/c.md'])
})

test('a file and a directory can swap places in one write, whichever order the changes are listed in', async () => {
  const store = await openStore({ claims: [ns('x/')] })
  await store.write([{ path: 'x/a', text: 'file' }, { path: 'x/b/c', text: 'nested' }], { author: USERA })
  await store.write([{ path: 'x/a', delete: true }, { path: 'x/a/y', text: 'now a directory' }], { author: USERA })
  assert.deepEqual(await store.list('x/'), ['x/a/y', 'x/b/c'])
  await store.write([{ path: 'x/a', text: 'a file again' }, { path: 'x/a/y', delete: true }], { author: USERA })
  await store.write([{ path: 'x/b', text: 'file' }, { path: 'x/b/c', delete: true }], { author: USERA })
  assert.deepEqual(await store.list('x/'), ['x/a', 'x/b'])
})

test('deleting a path that does not exist at head is NOT_FOUND, and the rest of the write is not applied', async () => {
  const { store, git } = await openAt({ claims: [ns('prompts/'), ns('x/')] })
  await store.write([{ path: 'prompts/a.md', text: 'A' }, { path: 'x/d/f.md', text: 'F' }], { author: USERA })
  const head = await store.head()
  await assert.rejects(store.write([{ path: 'prompts/missing.md', delete: true }], { author: USERA }), isStoreError('NOT_FOUND', 'prompts/missing.md'))
  await assert.rejects(
    store.write([{ path: 'prompts/a.md', delete: true }, { path: 'prompts/missing.md', delete: true }], { author: USERA }),
    isStoreError('NOT_FOUND'))
  await assert.rejects(store.write([{ path: 'x/d', delete: true }], { author: USERA }), isStoreError('NOT_FOUND'), 'a directory is not a document')
  await assert.rejects(store.write([{ path: 'other/a.md', delete: true }], { author: USERA }), isStoreError('UNOWNED'))
  assert.equal(await store.head(), head)
  assert.equal(await store.read('prompts/a.md'), 'A')
  assert.equal(await mainOf(git), head)
})

test('base must be a full commit id that exists: anything else is NOT_FOUND', async () => {
  const { store, git } = await openAt({ claims: [ns('prompts/')] })
  const head = await store.head()
  const tree = (await git.run(['rev-parse', `${head}^{tree}`])).stdout.trim()
  const before = await objects(git)
  for (const base of ['main', 'refs/heads/main', 'HEAD', head.slice(0, 12), head.toUpperCase(), '0'.repeat(40), tree, '', 'proposal/x']) {
    await assert.rejects(
      store.write([{ path: 'prompts/a.md', text: 'x' }], { author: USERA, base }),
      isStoreError('NOT_FOUND'), `base ${JSON.stringify(base)}`)
  }
  assert.equal(await objects(git), before)
  assert.ok(await store.write([{ path: 'prompts/a.md', text: 'x' }], { author: USERA, base: head }))
})

test('base: a CONFLICT names the path; a delete conflicts too; the current head as base is fine', async () => {
  const store = await openStore({ claims: [ns('prompts/')] })
  const base = (await store.write([{ path: 'prompts/a.md', text: '1' }, { path: 'prompts/b.md', text: '1' }], { author: USERA }))!.id
  await store.write([{ path: 'prompts/a.md', text: '2' }], { author: USERA })
  await assert.rejects(
    store.write([{ path: 'prompts/b.md', text: 'x' }, { path: 'prompts/a.md', text: '3' }], { author: USERA, base }),
    isStoreError('CONFLICT', 'prompts/a.md'))
  await assert.rejects(store.write([{ path: 'prompts/a.md', delete: true }], { author: USERA, base }), isStoreError('CONFLICT'))
  assert.equal(await store.read('prompts/b.md'), '1')
  const head = await store.head()
  assert.ok(await store.write([{ path: 'prompts/a.md', text: '4' }], { author: USERA, base: head }))
})

test('a write that changes nothing makes no commit and returns undefined', async () => {
  const { seen, onCommit } = recorder()
  const { store, git } = await openAt({ claims: [ns('prompts/')], onCommit })
  await store.write([{ path: 'prompts/a.md', text: 'A' }, { path: 'prompts/b.md', text: 'B' }], { author: USERA })
  const head = await store.head()
  seen.length = 0
  assert.equal(await store.write([{ path: 'prompts/a.md', text: 'A' }], { author: USERA }), undefined)
  assert.equal(await store.write([{ path: 'prompts/a.md', text: 'A' }, { path: 'prompts/b.md', text: 'B' }], { author: AGENTA, note: 'again' }), undefined)
  assert.equal(await store.head(), head)
  assert.equal(await mainOf(git), head)
  assert.deepEqual(seen, [])

  const partial = await store.write([{ path: 'prompts/a.md', text: 'A' }, { path: 'prompts/b.md', text: 'B2' }], { author: USERA })
  assert.ok(partial)
  assert.deepEqual(partial.paths, ['prompts/b.md'], 'only what actually changed is in the commit')
  assert.equal(partial.message.split('\n')[0], 'prompts/b.md: edited in web UI')
})

test('a no-op write with an old base is still checked against the base', async () => {
  const store = await openStore({ claims: [ns('prompts/')] })
  const base = (await store.write([{ path: 'prompts/a.md', text: '1' }], { author: USERA }))!.id
  await store.write([{ path: 'prompts/a.md', text: '2' }], { author: USERA })
  await assert.rejects(store.write([{ path: 'prompts/a.md', text: '2' }], { author: USERA, base }), isStoreError('CONFLICT'))
})

/** Make the store's next `count` commits be overtaken: an outside writer moves `main` right after each commit object exists. */
function interfere(store: ConfigStore, git: Git, count: number, path: string): { externalIds: string[] } {
  const runner = gitOf(store)
  const original = runner.commitTree.bind(runner)
  const externalIds: string[] = []
  let left = count
  runner.commitTree = async (...args) => {
    const id = await original(...args)
    if (left-- > 0) externalIds.push(await externalCommit(git, path, `external ${externalIds.length}`))
    return id
  }
  return { externalIds }
}

test('when main moves between reading head and the ref update, the write is rebuilt on the new head and retried once', async () => {
  const { store, git } = await openAt({ claims: [ns('prompts/')] })
  const { externalIds } = interfere(store, git, 1, 'prompts/ext.md')
  const c = await store.write([{ path: 'prompts/a.md', text: 'A' }], { author: USERA })
  assert.ok(c)
  assert.equal(externalIds.length, 1)
  assert.equal((await git.run(['rev-parse', `${c.id}^`])).stdout.trim(), externalIds[0], 'built on top of the outside commit')
  assert.deepEqual(c.paths, ['prompts/a.md'])
  assert.equal(await store.read('prompts/ext.md'), 'external 0')
  assert.equal(await store.read('prompts/a.md'), 'A')
  assert.equal(await store.head(), c.id)
})

test('on the retry the base is checked again against the new head: an outside change to the same path is CONFLICT', async () => {
  const { store, git } = await openAt({ claims: [ns('prompts/')] })
  const base = await store.head()
  const { externalIds } = interfere(store, git, 1, 'prompts/a.md')
  await assert.rejects(store.write([{ path: 'prompts/a.md', text: 'mine' }], { author: USERA, base }), isStoreError('CONFLICT', 'prompts/a.md'))
  assert.equal(await mainOf(git), externalIds[0])
  assert.equal(await store.read('prompts/a.md'), 'external 0', 'nothing was overwritten')
})

test('when main is overtaken on the retry too, the write is CONFLICT and nothing of it lands', async () => {
  const { store, git } = await openAt({ claims: [ns('prompts/')] })
  const { externalIds } = interfere(store, git, 2, 'prompts/ext.md')
  await assert.rejects(store.write([{ path: 'prompts/a.md', text: 'A' }], { author: USERA }), isStoreError('CONFLICT'))
  assert.equal(externalIds.length, 2)
  assert.equal(await mainOf(git), externalIds[1])
  assert.equal(await store.read('prompts/a.md'), undefined)
})

test('a write leaves no temporary index behind, even when it fails inside git', async () => {
  const { store, repository } = await openAt({ claims: [ns('x/')] })
  await store.write([{ path: 'x/a', text: 'file' }], { author: USERA })
  await assert.rejects(store.write([{ path: 'x/a/b', text: 'clash' }], { author: USERA }), isStoreError('INVALID'))
  assert.deepEqual((await readdir(repository)).filter(name => name.startsWith('dish-index-')), [])
})

test('CommitInfo has exactly id, time, author, message, note (when given) and paths', async () => {
  const store = await openStore({ claims: [ns('prompts/')] })
  const c = await store.write([{ path: 'prompts/a.md', text: 'A' }], { author: AGENTA, note: 'first' })
  assert.deepEqual(Object.keys(c!).sort(), ['author', 'id', 'message', 'note', 'paths', 'time'])
  assert.match(c!.id, /^[0-9a-f]{40}$/)
  assert.equal(typeof c!.time, 'number')
})
