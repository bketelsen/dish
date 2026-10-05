import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { AGENT_IDENTITY, Git, NamespaceRegistry, StoreError, VersionedStore, personIdentity } from '../src/store/index.ts'
import type { ErrorCode, GitIdentity, RemoteStatus, StoreNaming, StoreOptions } from '../src/store/index.ts'

const MAIN = 'refs/heads/main'
const USER: GitIdentity = { name: 'Test User', email: 'user@test' }
const AGENT: GitIdentity = { name: 'Test Agent', email: 'agent@test' }
const USERA = { kind: 'user' } as const
/** The words dish-config gives its store, so the second store has a first one to differ from. */
const CONFIG: StoreNaming = { label: 'config store', kind: 'config', logName: 'dish-config', warningCode: 'DISH_CONFIG' }
const TEST: StoreNaming = { label: 'test store', kind: 'test', logName: 'dish-test', warningCode: 'DISH_TEST' }

const made: string[] = []
const opened: VersionedStore[] = []

after(async () => {
  await Promise.all(opened.splice(0).map(store => store.close().catch(() => {})))
  await Promise.all(made.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/** A fresh empty directory under the OS temp dir, removed when the test file finishes. */
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dish-kit-store-'))
  made.push(dir)
  return dir
}

type Options = Omit<StoreOptions, 'repository' | 'namespaces' | 'user' | 'agent' | 'naming'> & { repository?: string }

/** What `open` takes for a store at `repository` under `naming`, with `notes/` claimed and open to agents. */
function optionsFor(repository: string, naming: StoreNaming, options: Options = {}): StoreOptions {
  const namespaces = new NamespaceRegistry()
  namespaces.claim({ prefix: 'notes/', owner: 'test', agent: 'write', validate: () => undefined })
  return { ...options, repository, namespaces, user: USER, agent: AGENT, naming }
}

/** Open a store under `naming` on a fresh repository (or `options.repository`); it is closed when the test file finishes. */
async function openStore(naming: StoreNaming, options: Options = {}): Promise<{ store: VersionedStore, repository: string }> {
  const repository = options.repository ?? join(await tempDir(), 'store.git')
  const store = await VersionedStore.open(optionsFor(repository, naming, options))
  opened.push(store)
  return { store, repository }
}

const note = (path: string, text = path) => [{ path: `notes/${path}`, text }]

/** The next process warning with `code`. */
function warningWith(code: string): Promise<Error> {
  return new Promise(resolve => {
    const listener = (warning: Error & { code?: string }): void => {
      if (warning.code !== code) return
      process.off('warning', listener)
      resolve(warning)
    }
    process.on('warning', listener)
  })
}

/** For `assert.rejects`: a `StoreError` with this `code`, whose message starts with `start`. */
function isStoreError(code: ErrorCode, start = ''): (error: unknown) => boolean {
  return error => {
    assert.ok(error instanceof StoreError, `expected a StoreError, got ${String(error)}`)
    assert.equal(error.code, code, error.message)
    assert.ok(error.message.startsWith(start), `message starts with ${start}: ${error.message}`)
    return true
  }
}

/** Poll `check` until it returns something other than `undefined` or `false`. */
async function waitFor<T>(what: string, check: () => Promise<T | undefined | false>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = await check()
    if (found !== undefined && found !== false) return found
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 15))
  }
}

/** The status once everything is pushed and nothing is wrong. */
function pushed(store: VersionedStore): Promise<RemoteStatus> {
  return waitFor('everything to be pushed', async () => {
    const status = await store.remoteStatus()
    return status.pending === 0 && status.lastError === undefined && status
  })
}

/** The subject of the commit `main` points at, in the bare repository at `repository`. */
async function headSubject(repository: string): Promise<string> {
  return (await new Git(repository).run(['log', '-1', '--format=%s', MAIN, '--'])).stdout.trim()
}

/**
 * Run `body` with `env` set in this process (`undefined` unsets a variable), and put the variables back as they were.
 * The preload has already given this process a scratch HOME; this only moves it to another scratch directory.
 */
async function withEnv<T>(env: Record<string, string | undefined>, body: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]))
  const apply = (values: Record<string, string | undefined>): void => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  apply(env)
  try {
    return await body()
  } finally {
    apply(saved)
  }
}

test('a second store at another path has its own root subject, words and warning codes', async () => {
  const first = await openStore(CONFIG)
  const second = await openStore(TEST, {
    onCommit: () => { throw new Error('listener bug') },
    onProposal: () => { throw new Error('proposal listener bug') },
  })
  assert.equal(await headSubject(first.repository), 'Initialize dish config')
  assert.equal(await headSubject(second.repository), 'Initialize dish test')
  assert.equal((await second.store.history())[0]!.message, 'Initialize dish test\n\nDish-Author-Kind: system\n')

  const committed = warningWith('DISH_TEST_ON_COMMIT')
  await second.store.write(note('a.md'), { author: USERA })
  assert.equal((await committed).message, 'dish-test onCommit callback threw: listener bug')
  const proposed = warningWith('DISH_TEST_ON_PROPOSAL')
  await second.store.propose(note('b.md'), { author: USERA, title: 'b', rationale: '' })
  assert.equal((await proposed).message, 'dish-test onProposal callback threw: proposal listener bug')

  await assert.rejects(VersionedStore.open(optionsFor(second.repository, TEST)), isStoreError('LOCKED', 'the test store is locked by'))
  await assert.rejects(VersionedStore.open(optionsFor(first.repository, CONFIG)), isStoreError('LOCKED', 'the config store is locked by'))
  const occupied = await tempDir()
  await writeFile(join(occupied, 'mine.txt'), 'not a repository')
  await assert.rejects(VersionedStore.open(optionsFor(occupied, TEST)), (error: unknown) => {
    // What git adds after it, in parentheses, is git's own wording.
    assert.ok(error instanceof Error && !(error instanceof StoreError))
    assert.ok(error.message.startsWith(`${occupied} is not a dish test repository, refusing to initialize over existing files`), error.message)
    return true
  })

  await second.store.close()
  await assert.rejects(second.store.head(), { message: 'test store is closed' })
  await assert.rejects(second.store.remoteStatus(), { message: 'test store is closed' })
  assert.equal(await first.store.read('notes/a.md'), undefined, 'the first store has none of the second\'s writes')
  await first.store.close()
  await assert.rejects(first.store.head(), { message: 'config store is closed' })
})

test('two stores open in one process have their own locks and queues', async () => {
  const a = await openStore(CONFIG)
  const b = await openStore(TEST)
  // Interleaved, all at once: each queue takes its own writes in the order they came, whatever the other is doing.
  const writes: Array<Promise<unknown>> = []
  for (let i = 0; i < 5; i++) {
    writes.push(a.store.write(note(`a${i}.md`), { author: USERA, note: `a ${i}` }))
    writes.push(b.store.write(note(`b${i}.md`), { author: USERA, note: `b ${i}` }))
  }
  await Promise.all(writes)
  assert.deepEqual((await a.store.history()).map(commit => commit.note), ['a 4', 'a 3', 'a 2', 'a 1', 'a 0', undefined])
  assert.deepEqual((await b.store.history()).map(commit => commit.note), ['b 4', 'b 3', 'b 2', 'b 1', 'b 0', undefined])
  assert.deepEqual(await a.store.list('notes/'), ['notes/a0.md', 'notes/a1.md', 'notes/a2.md', 'notes/a3.md', 'notes/a4.md'])
  assert.deepEqual(await b.store.list('notes/'), ['notes/b0.md', 'notes/b1.md', 'notes/b2.md', 'notes/b3.md', 'notes/b4.md'])

  // Each holds its own repository's lock: closing one frees that one only.
  await a.store.close()
  const again = await openStore(CONFIG, { repository: a.repository })
  assert.equal(await again.store.read('notes/a4.md'), 'a4.md')
  await assert.rejects(VersionedStore.open(optionsFor(b.repository, TEST)), isStoreError('LOCKED', 'the test store is locked by'))
  assert.equal((await b.store.write(note('b5.md'), { author: USERA }))?.paths[0], 'notes/b5.md', 'the second store is still open')
})

test('two stores push to their own remotes', async () => {
  const remote = async (): Promise<{ path: string, git: Git }> => {
    const path = join(await tempDir(), 'remote.git')
    const git = new Git(path)
    await git.initBare('main')
    return { path, git }
  }
  const remoteA = await remote()
  const remoteB = await remote()
  let failOnce = true
  const a = await openStore(CONFIG, { remote: remoteA.path, pushDelays: [10] })
  const b = await openStore(TEST, {
    remote: remoteB.path,
    pushDelays: [10],
    onRemoteStatus: () => {
      if (!failOnce) return
      failOnce = false
      throw new Error('status listener bug')
    },
  })
  const warned = warningWith('DISH_TEST_PUSH')
  await a.store.write(note('a.md'), { author: USERA })
  await b.store.write(note('b.md'), { author: USERA })
  assert.equal((await warned).message, 'dish-test onRemoteStatus callback threw: status listener bug')

  assert.equal((await pushed(a.store)).pushed, await a.store.head())
  assert.equal((await pushed(b.store)).pushed, await b.store.head())
  assert.equal(await remoteA.git.resolve(MAIN), await a.store.head())
  assert.equal(await remoteB.git.resolve(MAIN), await b.store.head())
  assert.deepEqual(await remoteA.git.listPaths(MAIN, ''), ['notes/a.md'])
  assert.deepEqual(await remoteB.git.listPaths(MAIN, ''), ['notes/b.md'])
  assert.equal((await remoteA.git.run(['log', '--format=%s', MAIN, '--'])).stdout, 'notes/a.md: edited in web UI\nInitialize dish config\n')
  assert.equal((await remoteB.git.run(['log', '--format=%s', MAIN, '--'])).stdout, 'notes/b.md: edited in web UI\nInitialize dish test\n')
})

test('personIdentity takes the config, then git\'s global config, then dish', async () => {
  const home = await tempDir()
  // Only this scratch HOME's .gitconfig is git's global config: nothing set in the runner's environment points elsewhere.
  await withEnv({ HOME: home, XDG_CONFIG_HOME: join(home, '.config'), GIT_CONFIG_GLOBAL: undefined }, async () => {
    assert.deepEqual(await personIdentity({}), { name: 'dish', email: 'dish@localhost' })
    await writeFile(join(home, '.gitconfig'), '[user]\n\tname = Global Name\n\temail = global@example.test\n')
    assert.deepEqual(await personIdentity({}), { name: 'Global Name', email: 'global@example.test' })
    assert.deepEqual(await personIdentity({ userName: ' ', userEmail: '' }), { name: 'Global Name', email: 'global@example.test' }, 'blank is unset')
    assert.deepEqual(await personIdentity({ userName: '  Row Name ' }), { name: 'Row Name', email: 'global@example.test' })
    assert.deepEqual(
      await personIdentity({ userName: 'Row Name', userEmail: 'row@example.test' }),
      { name: 'Row Name', email: 'row@example.test' })
    await writeFile(join(home, '.gitconfig'), '[user]\n\tname = Only Name\n')
    assert.deepEqual(await personIdentity({}), { name: 'Only Name', email: 'dish@localhost' })
  })
  assert.deepEqual(AGENT_IDENTITY, { name: 'dish agent', email: 'agent@dish.local' })
})

test('StoreError has the code and its own name', async () => {
  const error = new StoreError('CONFLICT', 'notes/a.md changed')
  assert.ok(error instanceof Error)
  assert.equal(error.name, 'StoreError')
  assert.equal(error.code, 'CONFLICT')
  assert.equal(error.message, 'notes/a.md changed')
  assert.equal(new StoreError('STALE').message, 'STALE')
  // And it's what a store throws.
  const { store } = await openStore(TEST)
  await assert.rejects(store.write([{ path: 'elsewhere.md', text: 'x' }], { author: USERA }), (thrown: unknown) => {
    assert.ok(thrown instanceof StoreError)
    assert.equal(thrown.name, 'StoreError')
    assert.equal(thrown.code, 'UNOWNED')
    return true
  })
})

test('a naming that is not four one-line strings is a plain Error, before anything is created or locked', async () => {
  const repository = await tempDir()
  const bad: Array<[string, unknown]> = [
    ['a newline in the kind', { ...TEST, kind: 'a\nb' }],
    ['an empty label', { ...TEST, label: '' }],
    ['a blank warning code', { ...TEST, warningCode: '  ' }],
    ['a missing log name', { label: 'test store', kind: 'test', warningCode: 'DISH_TEST' }],
    ['no naming at all', undefined],
  ]
  for (const [what, naming] of bad) {
    await assert.rejects(VersionedStore.open({ ...optionsFor(repository, TEST), naming: naming as StoreNaming }), (error: unknown) => {
      assert.ok(error instanceof Error && !(error instanceof StoreError), `${what}: expected a plain Error, got ${String(error)}`)
      assert.match(error.message, /^naming/, what)
      return true
    })
    assert.deepEqual(await readdir(repository), [], `${what}: no dish.lock, and nothing else, is left in the directory`)
  }
})
