import { execFile, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../src/index.ts'
import type { DishConfigService } from '../src/index.ts'
import { Git } from '../src/store/git.ts'
import type { RemoteStatus } from '../src/store/push.ts'
import { AGENTA, USERA, isStoreError, ns, repoPath, tempDir } from './helpers.ts'

const run = promisify(execFile)
const SHORT = /^[0-9a-f]{7}$/

// --- helpers ------------------------------------------------------------------------------------

/** Poll `check` until it returns something other than `undefined` or `false`. */
async function waitFor<T>(what: string, check: () => Promise<T | undefined | false> | T | undefined | false, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = await check()
    if (found !== undefined && found !== false) return found
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 15))
  }
}

/** Load the plugin into `ctx` with terminal output off unless `config` asks for it. */
function load(config: Partial<plugin.Config>, ctx: Context) {
  return ctx.plugin(plugin, { terminal: false, ...config } as plugin.Config)
}

/**
 * Run `body` with the plugin loaded into `ctx` (a fresh one unless given: listeners that must hear the
 * start-up are put on `ctx` first), and unload it however `body` ends.
 */
async function withPlugin<T>(
  config: Partial<plugin.Config>,
  body: (ctx: Context, service: DishConfigService) => Promise<T>,
  ctx = new Context(),
): Promise<T> {
  const handle = load(config, ctx)
  try {
    await handle
    return await body(ctx, ctx.dishConfig)
  } finally {
    await handle.dispose()
  }
}

/** A bare repository to push to. */
async function bareRemote(): Promise<{ path: string, git: Git }> {
  const path = join(await tempDir(), 'remote.git')
  const git = new Git(path)
  await git.initBare('main')
  return { path, git }
}

/** What stderr was written while it was captured, a line at a time. */
function captureStderr(): { lines: () => string[], restore: () => void } {
  const original = process.stderr.write
  const chunks: string[] = []
  process.stderr.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk))
    return true
  }) as typeof process.stderr.write
  return {
    lines: () => chunks.join('').split('\n').filter(line => line !== ''),
    restore: () => { process.stderr.write = original },
  }
}

/** Run `body` with `env` set in this process, and put the variables back as they were. */
async function withEnv<T>(env: Record<string, string>, body: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]))
  Object.assign(process.env, env)
  try {
    return await body()
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

/** Who git recorded as the author of `rev`'s commit: `name <email>`. */
async function authorOf(repository: string, rev = 'main'): Promise<string> {
  return (await run('git', [`--git-dir=${repository}`, 'log', '-1', '--format=%an <%ae>', rev])).stdout.trim()
}

const LOCK_MODULE = pathToFileURL(join(import.meta.dirname, '../src/store/lock.ts')).href
const HOLDER = `
const { acquireLock } = await import(process.env.LOCK_MODULE)
await acquireLock(process.env.LOCK_DIR)
process.stdout.write('acquired\\n')
setInterval(() => {}, 1000)
`

/** A live process that holds the store's lock in `dir` until it is killed. */
async function holdLock(dir: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['--input-type=module', '-e', HOLDER], {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, LOCK_DIR: dir, LOCK_MODULE },
  })
  await new Promise<void>((resolve, reject) => {
    child.stdout!.setEncoding('utf8').on('data', (chunk: string) => { if (chunk.includes('acquired')) resolve() })
    child.once('exit', code => reject(new Error(`the lock holder exited early (${String(code)})`)))
  })
  return child
}

async function kill(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise(resolve => child.once('exit', resolve))
  child.kill('SIGKILL')
  await exited
}

// --- the service --------------------------------------------------------------------------------

test('dishConfig is provided only once the store is open, and it is exactly the store\'s methods plus claim', async () => {
  const repository = await repoPath()
  const ctx = new Context()
  const handle = load({ repository }, ctx)
  // Nothing is provided while the store is still opening.
  assert.equal(ctx.get('dishConfig'), undefined)
  await handle
  const service = ctx.dishConfig
  assert.ok(service)
  assert.match(await service.head(), /^[0-9a-f]{40}$/)
  assert.deepEqual(Object.keys(service).sort(), [
    'accept', 'claim', 'commit', 'diff', 'head', 'history', 'list', 'proposals', 'propose', 'read',
    'reject', 'remoteStatus', 'revert', 'seed', 'write',
  ])
  // The plugin owns the store's lifetime.
  assert.equal('close' in service, false)
  await handle.dispose()
  assert.equal(ctx.get('dishConfig'), undefined)
  // A service somebody kept can no longer reach the store.
  await assert.rejects(service.head(), /closed/)
})

test('a claim, then a write, emits dish-config/changed with the path, the commit and the author', async () => {
  await withPlugin({ repository: await repoPath() }, async (ctx, service) => {
    const heard: Array<{ paths: string[], commit: string, author: unknown }> = []
    ctx.on('dish-config/changed', (paths, commit, author) => { heard.push({ paths, commit, author }) })
    // A caller owns its claim; releasing it leaves the files.
    const release = ctx.effect(() => service.claim(ns('t/')))
    const info = await service.write([{ path: 't/a.md', text: 'hello' }], { author: USERA })
    assert.ok(info)
    assert.deepEqual(heard, [{ paths: ['t/a.md'], commit: info.id, author: { kind: 'user' } }])
    assert.equal(await service.read('t/a.md'), 'hello')

    const agent = await service.write([{ path: 't/b.md', text: 'x' }], { author: AGENTA, note: 'why' })
    assert.ok(agent)
    assert.equal(heard.length, 2)
    assert.deepEqual(heard[1], { paths: ['t/b.md'], commit: agent.id, author: AGENTA })

    // Nothing is emitted for a write that changes nothing.
    assert.equal(await service.write([{ path: 't/a.md', text: 'hello' }], { author: USERA }), undefined)
    assert.equal(heard.length, 2)

    await release()
    await assert.rejects(service.write([{ path: 't/c.md', text: 'x' }], { author: USERA }), isStoreError('UNOWNED'))
    assert.equal(await service.read('t/a.md'), 'hello')
  })
})

test('a listener that throws, or rejects, breaks neither the store nor the listeners after it', async () => {
  await withPlugin({ repository: await repoPath() }, async (ctx, service) => {
    const heard: string[][] = []
    ctx.on('dish-config/changed', () => { throw new Error('sync boom') })
    ctx.on('dish-config/changed', async () => { throw new Error('async boom') })
    ctx.on('dish-config/changed', paths => { heard.push(paths) })
    service.claim(ns('t/'))
    assert.ok(await service.write([{ path: 't/a.md', text: '1' }], { author: USERA }))
    assert.ok(await service.write([{ path: 't/a.md', text: '2' }], { author: USERA }))
    // Let a stray rejection, if there were one, surface.
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(heard, [['t/a.md'], ['t/a.md']])
    assert.equal(await service.read('t/a.md'), '2')
  })
})

test('dish-config/proposal fires for a proposal that is opened, accepted and rejected', async () => {
  const ctx = new Context()
  const events: Array<[string, string]> = []
  const changed: string[][] = []
  ctx.on('dish-config/proposal', (id, status) => { events.push([id, status]) })
  ctx.on('dish-config/changed', paths => { changed.push(paths) })
  await withPlugin({ repository: await repoPath() }, async (_ctx, service) => {
    service.claim(ns('p/', 'propose'))
    const first = await service.propose([{ path: 'p/x.md', text: 'one' }], { author: AGENTA, title: 'first', rationale: 'because' })
    const second = await service.propose([{ path: 'p/y.md', text: 'two' }], { author: AGENTA, title: 'second', rationale: '' })
    assert.deepEqual(events, [[first.id, 'open'], [second.id, 'open']])
    // Only the README's seed so far: a proposal changes nothing on main.
    assert.deepEqual(changed, [['README.md']])

    assert.ok(await service.accept(first.id, { author: USERA }))
    await service.reject(second.id, 'no thanks', { author: USERA })
    assert.deepEqual(events.slice(2), [[first.id, 'accepted'], [second.id, 'rejected']])
    assert.deepEqual(changed, [['README.md'], ['p/x.md']])
    assert.equal(await service.read('p/x.md'), 'one')
  }, ctx)
})

// --- the README ---------------------------------------------------------------------------------

test('README.md is claimed for people only, must not be empty, and is seeded exactly once across plugin lifetimes', async () => {
  const repository = await repoPath()
  const seeded = await withPlugin({ repository }, async (_ctx, service) => {
    const commits = await service.history({ path: 'README.md' })
    assert.equal(commits.length, 1)
    assert.deepEqual(commits[0]!.author, { kind: 'system' })
    const text = await service.read('README.md')
    assert.ok(text !== undefined && text.includes('dish-config'))
    assert.match(text, /web UI/)

    await assert.rejects(service.write([{ path: 'README.md', text: 'by agent' }], { author: AGENTA }), isStoreError('FORBIDDEN'))
    await assert.rejects(service.write([{ path: 'README.md', text: '  \n' }], { author: USERA }), isStoreError('INVALID', 'README.md'))
    return { commit: commits[0]!.id, head: await service.head() }
  })

  await withPlugin({ repository }, async (_ctx, service) => {
    // A second lifetime adds nothing: the head is where the first left it.
    assert.equal(await service.head(), seeded.head)
    assert.deepEqual((await service.history({ path: 'README.md' })).map(commit => commit.id), [seeded.commit])
  })
})

test('a README that cannot be seeded (a tiny size cap) is a warning, not a failed plugin', async () => {
  const out = captureStderr()
  try {
    await withPlugin({ repository: await repoPath(), maxBytes: 16, terminal: true }, async (_ctx, service) => {
      assert.equal(await service.read('README.md'), undefined)
      assert.match(await service.head(), /^[0-9a-f]{40}$/)
    })
  } finally {
    out.restore()
  }
  assert.ok(out.lines().some(line => /^\[dish-config\] warn: .*README\.md/.test(line)), out.lines().join('\n'))
})

// --- lifetime -----------------------------------------------------------------------------------

test('disposing the plugin releases the lock: while it lives a second instance is LOCKED, afterwards it loads', async () => {
  const repository = await repoPath()
  const first = new Context()
  const handle = load({ repository }, first)
  await handle
  const head = await first.dishConfig.head()

  const second = new Context()
  const refused = load({ repository }, second)
  await assert.rejects(Promise.resolve(refused), isStoreError('LOCKED'))
  assert.equal(second.get('dishConfig'), undefined)
  await refused.dispose()

  await handle.dispose()
  await access(join(repository, 'HEAD'))
  await assert.rejects(access(join(repository, 'dish.lock')), { code: 'ENOENT' })

  await withPlugin({ repository }, async (_ctx, service) => {
    assert.equal(await service.head(), head)
  }, second)
})

test('unloading the plugin while the store is still opening leaves no lock behind and provides nothing', async () => {
  for (const delay of [0, 2, 5, 10, 20, 40, 60, 90]) {
    const repository = await repoPath()
    const ctx = new Context()
    const handle = load({ repository }, ctx)
    await new Promise(resolve => setTimeout(resolve, delay))
    await handle.dispose()
    assert.equal(ctx.get('dishConfig'), undefined, `delay ${delay}`)
    await assert.rejects(access(join(repository, 'dish.lock')), { code: 'ENOENT' }, `delay ${delay}`)
    // And the repository is free for the next start.
    await withPlugin({ repository }, async (_ctx, service) => {
      assert.match(await service.head(), /^[0-9a-f]{40}$/)
    })
  }
})

test('a store a live process holds fails the load, logs why, and never provides dishConfig; the repository is usable once it lets go', async () => {
  const repository = await repoPath()
  await mkdir(repository, { recursive: true })
  const holder = await holdLock(repository)
  const out = captureStderr()
  try {
    const ctx = new Context()
    const provided: unknown[] = []
    ctx.on('internal/service', (name) => { if (name === 'dishConfig') provided.push(name) }, { global: true })
    const handle = load({ repository, terminal: true }, ctx)
    await assert.rejects(Promise.resolve(handle), isStoreError('LOCKED'))
    assert.equal(ctx.get('dishConfig'), undefined)
    assert.deepEqual(provided, [])
    // The holder's lock was left alone.
    assert.equal((JSON.parse(await readFile(join(repository, 'dish.lock'), 'utf8')) as { pid: number }).pid, holder.pid)
    await handle.dispose()

    const logged = out.lines().filter(line => line.includes('cannot open the config store'))
    assert.ok(logged.some(line => line.startsWith('[dish-config] error: ') && line.includes(repository) && /locked/i.test(line)), out.lines().join('\n'))

    await kill(holder)
    await withPlugin({ repository }, async (_ctx, service) => {
      assert.match(await service.head(), /^[0-9a-f]{40}$/)
    }, new Context())
  } finally {
    out.restore()
    await kill(holder)
  }
})

test('a remote that cannot be reached at a first start fails the load and leaves nothing provided', async () => {
  const repository = await repoPath()
  const remote = join(await tempDir(), 'missing.git')
  const ctx = new Context()
  const out = captureStderr()
  try {
    const handle = load({ repository, remote, terminal: true }, ctx)
    await assert.rejects(Promise.resolve(handle), /./)
    await handle.dispose()
  } finally {
    out.restore()
  }
  assert.equal(ctx.get('dishConfig'), undefined)
  assert.ok(out.lines().some(line => line.includes('cannot open the config store')), out.lines().join('\n'))
  // The lock is gone with the failed start, so the same repository opens without a remote.
  await withPlugin({ repository }, async (_ctx, service) => {
    assert.match(await service.head(), /^[0-9a-f]{40}$/)
  })
})

// --- config -------------------------------------------------------------------------------------

test('the config schema: every string is empty (use the default) and the numbers and terminal have their defaults', () => {
  const result = plugin.Config['~standard'].validate({})
  assert.ok(!('then' in result))
  assert.equal(result.issues, undefined)
  assert.deepEqual(result.value, {
    repository: '', remote: '', userName: '', userEmail: '', agentName: 'dish agent', agentEmail: 'agent@dish.local',
    maxBytes: 262144, pushTimeoutMs: 60000, terminal: true,
  })
})

test('an empty or blank remote means no remote', async () => {
  for (const remote of ['', '   ', '\t\n']) {
    await withPlugin({ repository: await repoPath(), remote }, async (_ctx, service) => {
      const status = await service.remoteStatus()
      assert.deepEqual(status, { pending: 0 })
      assert.equal('remote' in status, false)
    })
  }
})

test('empty-string fields fall back: the repository to the XDG config directory, the identities to git config and then to dish', async () => {
  const root = await tempDir()
  const gitconfig = join(root, 'gitconfig')
  await writeFile(gitconfig, '[user]\n\tname = Git Global\n\temail = global@example.test\n')
  const blank = { repository: '', remote: '', userName: '', userEmail: '', agentName: '', agentEmail: '', terminal: false }

  await withEnv({ XDG_CONFIG_HOME: join(root, 'xdg'), GIT_CONFIG_GLOBAL: gitconfig }, async () => {
    await withPlugin(blank, async (_ctx, service) => {
      service.claim(ns('t/'))
      await service.write([{ path: 't/u.md', text: 'u' }], { author: USERA })
      const repository = join(root, 'xdg', 'dish', 'config.git')
      await access(join(repository, 'HEAD'))
      assert.equal(await authorOf(repository), 'Git Global <global@example.test>')
      await service.write([{ path: 't/a.md', text: 'a' }], { author: AGENTA })
      assert.equal(await authorOf(repository), 'dish agent <agent@dish.local>')
      assert.equal(await authorOf(repository, 'main~2'), 'dish agent <agent@dish.local>', 'the store\'s own commits are the agent\'s')
    })
  })

  // Only the name is set in git: the email falls back on its own. Blank space counts as empty.
  const nameOnly = join(root, 'name-only')
  await writeFile(nameOnly, '[user]\n\tname = Only Name\n')
  await withEnv({ XDG_CONFIG_HOME: join(root, 'xdg2'), GIT_CONFIG_GLOBAL: nameOnly }, async () => {
    await withPlugin({ ...blank, userName: '  ', userEmail: ' ', repository: ' ' }, async (_ctx, service) => {
      service.claim(ns('t/'))
      await service.write([{ path: 't/u.md', text: 'u' }], { author: USERA })
      const repository = join(root, 'xdg2', 'dish', 'config.git')
      assert.equal(await authorOf(repository), 'Only Name <dish@localhost>')
    })
  })

  // No git identity at all.
  await withEnv({ XDG_CONFIG_HOME: join(root, 'xdg3'), GIT_CONFIG_GLOBAL: '/dev/null' }, async () => {
    await withPlugin(blank, async (_ctx, service) => {
      service.claim(ns('t/'))
      await service.write([{ path: 't/u.md', text: 'u' }], { author: USERA })
      assert.equal(await authorOf(join(root, 'xdg3', 'dish', 'config.git')), 'dish <dish@localhost>')
    })
  })
})

test('configured identities and limits are used as given', async () => {
  const repository = await repoPath()
  await withEnv({ GIT_CONFIG_GLOBAL: '/dev/null' }, async () => {
    await withPlugin({
      repository, userName: 'Ada', userEmail: 'ada@example.test', agentName: 'Bot', agentEmail: 'bot@example.test', maxBytes: 100,
    }, async (_ctx, service) => {
      service.claim(ns('t/'))
      await service.write([{ path: 't/u.md', text: 'u' }], { author: USERA })
      assert.equal(await authorOf(repository), 'Ada <ada@example.test>')
      await service.write([{ path: 't/a.md', text: 'a' }], { author: AGENTA })
      assert.equal(await authorOf(repository), 'Bot <bot@example.test>')
      await assert.rejects(service.write([{ path: 't/big.md', text: 'x'.repeat(101) }], { author: USERA }), isStoreError('TOO_LARGE'))
    })
  })
})

// --- the remote ---------------------------------------------------------------------------------

test('dish-config/remote reports the status as it changes, and the remote ends up with main', async () => {
  const remote = await bareRemote()
  const ctx = new Context()
  const seen: RemoteStatus[] = []
  ctx.on('dish-config/remote', status => { seen.push(status) })
  await withPlugin({ repository: await repoPath(), remote: remote.path }, async (_ctx, service) => {
    service.claim(ns('t/'))
    const info = await service.write([{ path: 't/a.md', text: 'one' }], { author: USERA })
    assert.ok(info)
    await waitFor('the head to be reported as pushed', () => seen.some(status => status.pushed === info.id && status.pending === 0))
    assert.ok(seen.every(status => status.remote === remote.path))
    assert.equal(seen.at(-1)!.lastError, undefined)
    assert.equal((await remote.git.run(['rev-parse', 'refs/heads/main'])).stdout.trim(), info.id)
    const status = await service.remoteStatus()
    assert.equal(status.remote, remote.path)
    assert.equal(status.pushed, info.id)
    assert.equal(status.pending, 0)
  }, ctx)
})

test('terminal output: one line on ready, one on the first push, and nothing else when all goes well', async () => {
  const remote = await bareRemote()
  const repository = await repoPath()
  const out = captureStderr()
  try {
    await withPlugin({ repository, remote: remote.path, terminal: true }, async (_ctx, service) => {
      service.claim(ns('t/'))
      const first = await service.write([{ path: 't/a.md', text: 'one' }], { author: USERA })
      assert.ok(first)
      await waitFor('the push', async () => (await service.remoteStatus()).pushed === first.id)
      const second = await service.write([{ path: 't/a.md', text: 'two' }], { author: USERA })
      assert.ok(second)
      await waitFor('the second push', async () => (await service.remoteStatus()).pushed === second.id)
      // The first success only: the second push says nothing more.
      await new Promise(resolve => setTimeout(resolve, 50))
    })
  } finally {
    out.restore()
  }
  const lines = out.lines().filter(line => line.startsWith('[dish-config]'))
  assert.equal(lines[0], `[dish-config] store ready at ${repository}`)
  const pushed = lines.filter(line => line.startsWith('[dish-config] pushed '))
  assert.equal(pushed.length, 1, lines.join('\n'))
  assert.match(pushed[0]!.slice('[dish-config] pushed '.length), SHORT)
  // Nothing else, and in particular never what a document says.
  assert.equal(lines.length, 2, lines.join('\n'))
})

test('terminal output: a push that fails says so once, and says when it works again', async () => {
  const root = await tempDir()
  const repository = join(root, 'config.git')
  const remotePath = join(root, 'remote.git')
  // An existing repository never contacts its remote while opening, so a missing one is a failing push.
  await withPlugin({ repository }, async () => {})
  const ctx = new Context()
  const seen: RemoteStatus[] = []
  ctx.on('dish-config/remote', status => { seen.push(status) })
  const out = captureStderr()
  try {
    await withPlugin({ repository, remote: remotePath, terminal: true }, async (_ctx, service) => {
      await waitFor('the failure', () => seen.some(status => status.lastError !== undefined))
      // The remote appears; the retry (after the first delay, a second) gets through.
      await new Git(remotePath).initBare('main')
      await waitFor('the push', async () => (await service.remoteStatus()).pending === 0 && seen.at(-1)?.pushed !== undefined)
      await new Promise(resolve => setTimeout(resolve, 50))
    }, ctx)
  } finally {
    out.restore()
  }
  const lines = out.lines().filter(line => line.startsWith('[dish-config]'))
  assert.equal(lines[0], `[dish-config] store ready at ${repository}`)
  assert.equal(lines.length, 4, lines.join('\n'))
  assert.match(lines[1]!, /^\[dish-config\] warn: push failing: .+ \(\d+ unpushed\)$/)
  assert.equal(lines[2], '[dish-config] push working again')
  assert.match(lines[3]!, /^\[dish-config\] pushed [0-9a-f]{7}$/)
})

test('terminal: false prints nothing', async () => {
  const remote = await bareRemote()
  const out = captureStderr()
  try {
    await withPlugin({ repository: await repoPath(), remote: remote.path, terminal: false }, async (_ctx, service) => {
      service.claim(ns('t/'))
      const info = await service.write([{ path: 't/a.md', text: 'x' }], { author: USERA })
      await waitFor('the push', async () => (await service.remoteStatus()).pushed === info!.id)
    })
  } finally {
    out.restore()
  }
  assert.deepEqual(out.lines().filter(line => line.startsWith('[dish-config]')), [])
})
