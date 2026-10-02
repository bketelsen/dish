import { execFile } from 'node:child_process'
import { access, chmod, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promisify } from 'node:util'
import { Git } from '../src/store/git.ts'
import { PushQueue, checkRemote, firstLine, redact } from '../src/store/push.ts'
import type { RemoteStatus } from '../src/store/push.ts'
import { NamespaceRegistry } from '../src/store/namespaces.ts'
import { ConfigStore } from '../src/store/store.ts'
import { USER, USERA, isPlainError, isStoreError, ns, openAt, openStore, ownEnv, repoPath, tempDir } from './helpers.ts'

const MAIN = 'refs/heads/main'
const TOKEN = `ghp_${'a'.repeat(36)}`
const run = promisify(execFile)

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

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** The status once everything is pushed and nothing is wrong: the test helper `pushed()` of the plan. */
function pushed(store: ConfigStore, timeoutMs?: number): Promise<RemoteStatus> {
  return waitFor('everything to be pushed', async () => {
    const status = await store.remoteStatus()
    return status.pending === 0 && status.lastError === undefined && status
  }, timeoutMs)
}

/** A bare repository to push to; `hook` becomes its `pre-receive` hook. */
async function bareRemote(hook?: string): Promise<{ path: string, git: Git }> {
  const path = join(await tempDir(), 'remote.git')
  const git = new Git(path)
  await git.initBare('main')
  if (hook !== undefined) {
    await writeFile(join(path, 'hooks', 'pre-receive'), `#!/bin/sh\n${hook}\n`)
    await chmod(join(path, 'hooks', 'pre-receive'), 0o755)
  }
  return { path, git }
}

/** A remote whose pre-receive hook writes its pid to `pidFile` and then waits for ten minutes, so a push to it hangs. */
async function hangingRemote(): Promise<{ path: string, git: Git, pidFile: string }> {
  const pidFile = join(await tempDir(), 'hook.pid')
  return { ...await bareRemote(`echo $$ > '${pidFile}'\nexec sleep 600`), pidFile }
}

/** A remote whose hook appends a line to a file for every push that reaches it (and takes `seconds` over it). */
async function countingRemote(seconds: string): Promise<{ path: string, git: Git, count: () => Promise<number> }> {
  const file = join(await tempDir(), 'pushes')
  const remote = await bareRemote(`echo x >> '${file}'\nsleep ${seconds}`)
  return { ...remote, count: async () => (await readFile(file, 'utf8').catch(() => '')).split('\n').filter(line => line !== '').length }
}

/** A remote whose hook counts the pushes that reach it and then waits until `release()` is called. */
async function gatedRemote(): Promise<{ path: string, git: Git, count: () => Promise<number>, release: () => Promise<void> }> {
  const dir = await tempDir()
  const file = join(dir, 'pushes')
  const gate = join(dir, 'gate')
  const remote = await bareRemote(`echo x >> '${file}'\nwhile [ ! -e '${gate}' ]; do sleep 0.05; done`)
  return {
    ...remote,
    count: async () => (await readFile(file, 'utf8').catch(() => '')).split('\n').filter(line => line !== '').length,
    release: () => writeFile(gate, ''),
  }
}

/** The start of each attempt `onRemoteStatus` has reported, once each, in order. */
function attemptLog(): { starts: number[], onRemoteStatus: (status: RemoteStatus) => void } {
  const starts: number[] = []
  return {
    starts,
    onRemoteStatus: status => {
      if (status.lastAttempt !== undefined && starts.at(-1) !== status.lastAttempt) starts.push(status.lastAttempt)
    },
  }
}

/** Whether `pid` is a running process (a zombie is not). */
async function alive(pid: number): Promise<boolean> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
    return !stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z')
  } catch {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
}

async function pidOf(pidFile: string): Promise<number> {
  return waitFor('the hook to start', async () => {
    const pid = Number((await readFile(pidFile, 'utf8').catch(() => '')).trim())
    return pid > 0 && pid
  })
}

/** Run `body` with an environment variable set (and put back after). */
async function withEnv<T>(name: string, value: string, body: () => Promise<T>): Promise<T> {
  const previous = process.env[name]
  process.env[name] = value
  try {
    return await body()
  } finally {
    if (previous === undefined) delete process.env[name]
    else process.env[name] = previous
  }
}

async function remoteHead(git: Git): Promise<string | undefined> {
  return git.resolve(MAIN)
}

/** Commit to the remote's `main` from "another machine". */
async function pushFromElsewhere(git: Git, path: string): Promise<string> {
  const head = await git.resolve(MAIN)
  assert.ok(head)
  const id = await git.commitTree(await git.buildTree(head, [{ path, text: 'from elsewhere' }]), [head], 'elsewhere', USER)
  assert.equal(await git.casRef(MAIN, id, head), true)
  return id
}

/** A repository path whose parent holds a repository made without any remote: for tests that open it with one. */
async function existingRepository(): Promise<string> {
  const { store, repository } = await openAt({ claims: [ns('prompts/')] })
  await store.close()
  return repository
}

const put = (store: ConfigStore, name: string, text = name): ReturnType<ConfigStore['write']> =>
  store.write([{ path: `prompts/${name}`, text }], { author: USERA })

// --- pushing --------------------------------------------------------------------------------------

test('every commit is pushed: the remote\'s main follows the head, and the store keeps no trace of the remote', async () => {
  const remote = await bareRemote()
  const { store, git } = await openAt({ claims: [ns('prompts/')], remote: remote.path })
  // The root commit is pushed too, though nothing wrote it through onCommit.
  const root = await store.head()
  await pushed(store)
  assert.equal(await remoteHead(remote.git), root)

  await put(store, 'a.md')
  await put(store, 'b.md')
  const head = await store.head()
  const status = await pushed(store)
  assert.equal(await remoteHead(remote.git), head)
  assert.equal(status.pushed, head)
  assert.equal(status.pending, 0)
  assert.equal(status.remote, remote.path)
  assert.equal(typeof status.lastAttempt, 'number')

  // Pushed to the URL itself: no remote in the config, no tracking refs, nothing but main.
  assert.equal((await git.run(['config', '--get-regexp', '^remote\\.'], { allowFail: true })).stdout, '')
  assert.deepEqual((await git.run(['for-each-ref', '--format=%(refname)'])).stdout.trim().split('\n'), [MAIN])
})

test('accepts and reverts are pushed like writes, and proposal branches stay local', async () => {
  const remote = await bareRemote()
  const { store, git } = await openAt({ claims: [ns('prompts/')], remote: remote.path })
  const proposal = await store.propose([{ path: 'prompts/p.md', text: 'P' }], { author: USERA, title: 'A proposal', rationale: 'why' })
  await pushed(store)
  assert.equal(await remoteHead(remote.git), await store.head(), 'a proposal moves main nowhere')
  assert.deepEqual((await remote.git.run(['for-each-ref', '--format=%(refname)'])).stdout.trim().split('\n'), [MAIN])

  const accepted = await store.accept(proposal.id, { author: USERA })
  assert.ok(accepted)
  await pushed(store)
  assert.equal(await remoteHead(remote.git), accepted.id)

  const reverted = await store.revert(accepted.id, { author: USERA })
  assert.ok(reverted)
  await pushed(store)
  assert.equal(await remoteHead(remote.git), reverted.id)
  assert.equal((await git.run(['rev-list', '--count', MAIN])).stdout.trim(), '3')
  assert.equal((await remote.git.run(['rev-list', '--count', MAIN])).stdout.trim(), '3')
})

test('without a remote, remoteStatus says nothing is pending and names no remote', async () => {
  const { store } = await openAt({ claims: [ns('prompts/')] })
  await put(store, 'a.md')
  assert.deepEqual(await store.remoteStatus(), { pending: 0 })
})

test('a burst of writes made while a push is in flight is covered by exactly one more push', async () => {
  const remote = await gatedRemote()
  try {
    const { store } = await openAt({ claims: [ns('prompts/')], remote: remote.path })
    // The root commit's push is held in the remote's hook; ten commits land meanwhile.
    await waitFor('the first push to reach the hook', async () => (await remote.count()) === 1)
    for (let i = 0; i < 10; i++) await put(store, `doc${i}.md`)
    assert.equal((await store.remoteStatus()).pending, 11)
    await remote.release()
    const head = await store.head()
    await pushed(store)
    assert.equal(await remoteHead(remote.git), head)
    await sleep(200)
    assert.equal(await remote.count(), 2, 'the root commit, then the ten writes in one push')
  } finally {
    await remote.release()
  }
})

test('an idle queue is pushed once per schedule burst, and a closed queue never pushes again', async () => {
  const remote = await countingRemote('0')
  const { store, git } = await openAt({ claims: [ns('prompts/')] })
  await put(store, 'a.md')
  const queue = new PushQueue(git, remote.path, { delays: [10] })
  queue.schedule()
  queue.schedule()
  queue.schedule()
  await waitFor('the push', async () => (await queue.status()).pending === 0)
  assert.equal(await remoteHead(remote.git), await store.head())
  const before = await remote.count()
  await queue.close()
  await queue.close()
  await put(store, 'b.md')
  queue.schedule()
  await sleep(300)
  assert.equal(await remote.count(), before)
  assert.equal(await remote.git.resolve(MAIN), (await git.resolve(`${await store.head()}^`)), 'the second write was not pushed')
  assert.equal((await queue.status()).pending, 1)
})

test('onRemoteStatus hears each change in order and ends on the pushed head; a throwing callback is only a warning', async () => {
  const remote = await bareRemote()
  const seen: RemoteStatus[] = []
  const warnings: string[] = []
  const onWarning = (warning: Error & { code?: string }): void => {
    if (warning.code === 'DISH_CONFIG_PUSH') warnings.push(warning.message)
  }
  process.on('warning', onWarning)
  try {
    let first = true
    const { store } = await openAt({
      claims: [ns('prompts/')],
      remote: remote.path,
      onRemoteStatus: status => {
        seen.push(status)
        if (first) {
          first = false
          throw new Error('listener bug')
        }
      },
    })
    await put(store, 'a.md')
    const head = await store.head()
    await pushed(store)
    await waitFor('the last status', () => seen.at(-1)?.pushed === head)
    assert.equal(seen.at(-1)?.pending, 0)
    assert.ok(seen.some(status => status.pending > 0), 'a status with commits waiting was reported')
    assert.ok(seen.every(status => status.remote === remote.path))
    await waitFor('the warning', () => warnings.length > 0)
    assert.match(warnings[0]!, /listener bug/)
  } finally {
    process.off('warning', onWarning)
  }
})

// --- failing, backing off, recovering ---------------------------------------------------------------

test('an unreachable remote never fails a save; status shows the error and what is pending, and a remote that comes back is drained', async () => {
  const remote = await bareRemote()
  const away = `${remote.path}.away`
  const { store } = await openAt({ claims: [ns('prompts/')], remote: remote.path, pushDelays: [20, 20] })
  await pushed(store)
  await rename(remote.path, away)

  await put(store, 'a.md')
  await put(store, 'b.md')
  const failing = await waitFor('the push to fail', async () => {
    const status = await store.remoteStatus()
    return status.lastError !== undefined && status.pending === 2 && status
  })
  assert.match(failing.lastError!, /does not appear to be a git repository/)
  assert.ok(!failing.lastError!.includes('\n'))
  // It keeps trying.
  await waitFor('another attempt', async () => (await store.remoteStatus()).lastAttempt! > failing.lastAttempt!)

  await rename(away, remote.path)
  const status = await pushed(store)
  assert.equal(await remoteHead(remote.git), await store.head())
  assert.equal(status.pending, 0)
  assert.equal(status.lastError, undefined)
})

test('retries wait the configured delays, the last one repeating', async () => {
  const repository = await existingRepository()
  const log = attemptLog()
  const store = await openStore({
    repository, claims: [ns('prompts/')], remote: join(await tempDir(), 'missing.git'), pushDelays: [150, 500],
    onRemoteStatus: log.onRemoteStatus,
  })
  try {
    await waitFor('four attempts', () => log.starts.length >= 4)
    const { starts } = log
    // Lower bounds only (an attempt takes time too); timers may fire a millisecond early.
    assert.ok(starts[1]! - starts[0]! >= 140, `first wait ${starts[1]! - starts[0]!} ms`)
    assert.ok(starts[2]! - starts[1]! >= 490, `second wait ${starts[2]! - starts[1]!} ms`)
    assert.ok(starts[3]! - starts[2]! >= 490, `the last delay repeats: ${starts[3]! - starts[2]!} ms`)
  } finally {
    await store.close()
  }
})

test('a commit shortens a long wait to the first delay, a wait with no commit is not cut short, and the failures are still counted', async () => {
  const repository = await existingRepository()
  const log = attemptLog()
  const store = await openStore({
    repository, claims: [ns('prompts/')], remote: join(await tempDir(), 'missing.git'), pushDelays: [50, 60_000],
    onRemoteStatus: log.onRemoteStatus,
  })
  try {
    // Two failures, and the wait is now a minute.
    await waitFor('two attempts', () => log.starts.length >= 2, 5_000)
    await sleep(300)
    assert.equal(log.starts.length, 2, 'nothing but a commit ends the wait')

    const before = Date.now()
    assert.ok(await put(store, 'a.md'))
    await waitFor('the commit to be tried', () => log.starts.length >= 3, 5_000)
    // Not at once, but after the first delay, not the minute.
    assert.ok(log.starts[2]! - before >= 40, `${log.starts[2]! - before} ms after the commit`)

    // It failed again: the failures were not forgotten, so the wait is the minute again.
    await sleep(300)
    assert.equal(log.starts.length, 3, 'the wait after the commit\'s attempt is the long one')
  } finally {
    await store.close()
  }
})

test('a commit made while a retry is failing also gets the short wait', async () => {
  // An ssh that takes 0.4 s to fail, and counts its calls: the second attempt is then still running when the commit lands.
  const dir = await tempDir()
  const calls = join(dir, 'calls')
  const script = join(dir, 'slow-failing-ssh')
  await writeFile(script, `#!/bin/sh\necho x >> '${calls}'\nsleep 0.4\necho "slow ssh: no route" >&2\nexit 1\n`)
  await chmod(script, 0o755)
  const called = async (): Promise<number> => (await readFile(calls, 'utf8').catch(() => '')).split('\n').filter(line => line !== '').length
  // With the variant given, git doesn't run the command once more to find out which ssh it is.
  await withEnv('GIT_SSH_VARIANT', 'ssh', () => withEnv('GIT_SSH_COMMAND', `'${script}'`, async () => {
    const repository = await existingRepository()
    const store = await openStore({ repository, claims: [ns('prompts/')], remote: 'ssh://localhost/x.git', pushDelays: [50, 60_000] })
    try {
      // The first failure's wait is the short one anyway; the second's would be a minute.
      await waitFor('the second attempt to be running', async () => (await called()) >= 2)
      assert.ok(await put(store, 'a.md'))
      await waitFor('a third attempt', async () => (await called()) >= 3, 5_000)
    } finally {
      await store.close()
    }
  }))
})

test('a commit never lengthens a wait that is already shorter than the first delay', async () => {
  const repository = await existingRepository()
  const log = attemptLog()
  // Waits: 1.5 s after the first failure, then 0.4 s: the commit lands inside the second.
  const store = await openStore({
    repository, claims: [ns('prompts/')], remote: join(await tempDir(), 'missing.git'), pushDelays: [1_500, 400],
    onRemoteStatus: log.onRemoteStatus,
  })
  try {
    await waitFor('the second attempt', () => log.starts.length >= 2)
    const before = Date.now()
    assert.ok(await put(store, 'a.md'))
    await waitFor('the third attempt', () => log.starts.length >= 3)
    // 0.4 s after the second attempt; had the commit set the wait to the first delay it would be 1.5 s after the commit.
    assert.ok(log.starts[2]! - before < 1_000, `${log.starts[2]! - before} ms after the commit`)
  } finally {
    await store.close()
  }
})

test('a success starts the backoff over', async () => {
  const repository = await existingRepository()
  const remote = join(await tempDir(), 'late.git')
  const store = await openStore({ repository, claims: [ns('prompts/')], remote, pushDelays: [30, 2_500] })
  try {
    // Two failures: the next wait would be the long one.
    const first = await waitFor('the first failure', async () => {
      const status = await store.remoteStatus()
      return status.lastError !== undefined && status
    })
    await waitFor('the second failure', async () => (await store.remoteStatus()).lastAttempt! > first.lastAttempt!)
    const git = new Git(remote)
    await git.initBare('main')
    await pushed(store)
    assert.equal(await remoteHead(git), await store.head())

    // Break it again: if the delay had not been reset the second attempt would be 2.5 s after the first.
    await rename(remote, `${remote}.away`)
    await put(store, 'a.md')
    const failed = await waitFor('the first failure', async () => {
      const status = await store.remoteStatus()
      return status.lastError !== undefined && status
    })
    await waitFor('the second failure soon', async () => (await store.remoteStatus()).lastAttempt! > failed.lastAttempt!, 1_500)
  } finally {
    await store.close()
  }
})

test('a diverged remote is reported, retried, and never forced', async () => {
  const remote = await bareRemote()
  const { store } = await openAt({ claims: [ns('prompts/')], remote: remote.path, pushDelays: [30] })
  await pushed(store)
  const theirs = await pushFromElsewhere(remote.git, 'other.txt')

  await put(store, 'a.md')
  const status = await waitFor('the divergence', async () => {
    const found = await store.remoteStatus()
    return found.lastError !== undefined && found
  })
  assert.equal(status.lastError, "remote main has commits this store doesn't have; resolve manually")
  assert.equal(status.pending, 1)
  await waitFor('a retry', async () => (await store.remoteStatus()).lastAttempt! > status.lastAttempt!)
  assert.equal(await remoteHead(remote.git), theirs, 'the remote was left as the other machine made it')
  assert.equal((await store.remoteStatus()).lastError, status.lastError)
  assert.equal(await store.read('prompts/a.md'), 'a.md', 'the save itself went through')
  await store.close()
})

test('a remote that declines the push is not "diverged": git\'s first line is the error', async () => {
  const remote = await bareRemote('echo "branch is protected" >&2\nexit 1')
  const { store } = await openAt({ claims: [ns('prompts/')], remote: remote.path, pushDelays: [60_000] })
  const status = await waitFor('the failure', async () => {
    const found = await store.remoteStatus()
    return found.lastError !== undefined && found
  })
  assert.equal(status.lastError, 'remote: branch is protected')
  await store.close()
})

test('credentials in git\'s output are not kept: a token hides the line, a URL password is masked', async () => {
  const remote = await bareRemote(`echo "denied for ${TOKEN}" >&2\nexit 1`)
  const { store } = await openAt({ claims: [ns('prompts/')], remote: remote.path, pushDelays: [60_000] })
  const status = await waitFor('the failure', async () => {
    const found = await store.remoteStatus()
    return found.lastError !== undefined && found
  })
  assert.ok(!status.lastError!.includes(TOKEN))
  assert.match(status.lastError!, /hidden: it looks like a GitHub token/)
  await store.close()

  assert.equal(redact('fatal: unable to access https://user:hunter2@example.com/x.git/: refused'), 'fatal: unable to access https://user:***@example.com/x.git/: refused')
  assert.equal(redact('ssh://git@github.com:22/x.git'), 'ssh://git@github.com:22/x.git')
  assert.equal(redact('plain words'), 'plain words')
  assert.ok(!redact(`x ${TOKEN} y`).includes(TOKEN))
  assert.equal(firstLine('\n  \n  first line \r\nsecond'), 'first line')
  assert.equal(firstLine('a\u001b[31mb\u0000c'), 'a [31mb c')
  assert.equal(firstLine(''), '')
  assert.equal(Array.from(firstLine('x'.repeat(1_000))).length, 300)
  // A token is hidden whole even when it sits where the cut falls.
  assert.ok(!firstLine(`${'x'.repeat(279)} ${TOKEN}`).includes('ghp_'))
})

test('the remote shown in status has any URL password masked', async () => {
  const repository = await existingRepository()
  const store = await openStore({
    repository, claims: [ns('prompts/')], remote: 'https://deploy:hunter2@127.0.0.1:9/dish-config.git', pushDelays: [60_000],
  })
  try {
    const status = await store.remoteStatus()
    assert.equal(status.remote, 'https://deploy:***@127.0.0.1:9/dish-config.git')
    await waitFor('the failure', async () => (await store.remoteStatus()).lastError !== undefined)
    assert.ok(!JSON.stringify(await store.remoteStatus()).includes('hunter2'))
  } finally {
    await store.close()
  }
})

test('pending counts the commits after the last push, or all of them before the first', async () => {
  const repository = await existingRepository()
  const store = await openStore({ repository, claims: [ns('prompts/')], remote: join(await tempDir(), 'missing.git'), pushDelays: [60_000] })
  try {
    await put(store, 'a.md')
    await put(store, 'b.md')
    // The root commit and two writes: all of them, as nothing has been pushed in this process.
    const status = await waitFor('the failure', async () => {
      const found = await store.remoteStatus()
      return found.lastError !== undefined && found
    })
    assert.equal(status.pushed, undefined)
    assert.equal(status.pending, 3)
  } finally {
    await store.close()
  }
})

// --- push never waits for a person ------------------------------------------------------------------

test('a pre-push hook from the user\'s git config is not run: it could hold the push up or refuse it', async () => {
  const hooks = await tempDir()
  await writeFile(join(hooks, 'pre-push'), '#!/bin/sh\necho "pre-push ran" >&2\nexit 1\n')
  await chmod(join(hooks, 'pre-push'), 0o755)
  const config = join(await tempDir(), 'gitconfig')
  await writeFile(config, `[core]\n\thooksPath = ${hooks}\n`)
  await withEnv('GIT_CONFIG_GLOBAL', config, async () => {
    const remote = await bareRemote()
    const { store } = await openAt({ claims: [ns('prompts/')], remote: remote.path, pushDelays: [60_000] })
    await put(store, 'a.md')
    const status = await pushed(store)
    assert.equal(status.lastError, undefined)
    assert.equal(await remoteHead(remote.git), await store.head())
  })
})

test('a push that hangs never holds up a write, and close() kills it and what it started', async () => {
  const remote = await hangingRemote()
  const { store, repository } = await openAt({ claims: [ns('prompts/')], remote: remote.path })
  const hook = await pidOf(remote.pidFile)
  assert.ok(await alive(hook), 'the push is stuck in the remote\'s hook')

  const started = Date.now()
  const commit = await put(store, 'a.md')
  assert.ok(commit)
  assert.equal(await store.read('prompts/a.md'), 'a.md')
  assert.ok(Date.now() - started < 5_000, `the write took ${Date.now() - started} ms`)
  assert.ok(await alive(hook), 'and the push is still stuck')
  const status = await store.remoteStatus()
  assert.equal(status.pending, 2)
  assert.equal(status.lastError, undefined)

  await store.close()
  await waitFor('the hook to die', async () => !(await alive(hook)))
  await store.close()
  await assert.rejects(store.remoteStatus(), isPlainError(/closed/))
  // The lock is free again, and nothing of the push was left in the repository.
  const again = await openStore({ repository, claims: [ns('prompts/')] })
  assert.equal(await again.read('prompts/a.md'), 'a.md')
  assert.deepEqual((await readdir(repository)).filter(name => name.endsWith('.lock') && name !== 'dish.lock'), [])
})

test('a push that outlives pushTimeoutMs is killed, reported, and retried', async () => {
  const remote = await hangingRemote()
  const { store } = await openAt({ claims: [ns('prompts/')], remote: remote.path, pushTimeoutMs: 400, pushDelays: [60_000] })
  const hook = await pidOf(remote.pidFile)
  const status = await waitFor('the timeout', async () => {
    const found = await store.remoteStatus()
    return found.lastError !== undefined && found
  })
  assert.equal(status.lastError, 'git push timed out after 400 ms')
  await waitFor('the hook to die', async () => !(await alive(hook)))
  await store.close()
})

/** A `GIT_SSH_COMMAND` that records whether it could open `/dev/tty`, then fails like an ssh that couldn't log in. */
async function fakeSsh(): Promise<{ command: string, record: string }> {
  const dir = await tempDir()
  const record = join(dir, 'record')
  const script = join(dir, 'fake-ssh')
  await writeFile(script, `#!/bin/sh\nif (: </dev/tty) 2>/dev/null; then echo tty > '${record}'; else echo "no tty" > '${record}'; fi\necho "fake ssh: Permission denied" >&2\nexit 1\n`)
  await chmod(script, 0o755)
  return { command: `'${script}'`, record }
}

test('git is run without a terminal: ssh cannot prompt on /dev/tty for a push or for the start-up lookup', async () => {
  const ssh = await fakeSsh()
  await withEnv('GIT_SSH_COMMAND', ssh.command, async () => {
    // A push, from a store that already exists.
    const repository = await existingRepository()
    const store = await openStore({ repository, claims: [ns('prompts/')], remote: 'ssh://localhost/dish-config.git', pushDelays: [60_000] })
    try {
      const status = await waitFor('the failure', async () => {
        const found = await store.remoteStatus()
        return found.lastError !== undefined && found
      })
      assert.match(status.lastError!, /fake ssh: Permission denied/)
      assert.equal((await readFile(ssh.record, 'utf8')).trim(), 'no tty')
    } finally {
      await store.close()
    }

    // The lookup of a first start.
    await rm(ssh.record)
    const fresh = await repoPath()
    await assert.rejects(
      openStore({ repository: fresh, remote: 'ssh://localhost/dish-config.git' }),
      isPlainError(/cannot read the remote ssh:\/\/localhost\/dish-config\.git: fake ssh: Permission denied/))
    assert.equal((await readFile(ssh.record, 'utf8')).trim(), 'no tty')
  })
})

// --- the remote option -----------------------------------------------------------------------------

test('a remote git could read as an option or as a command is refused before anything is created', async () => {
  const evil = [
    '', '   ', '-x', '--upload-pack=touch /tmp/pwned', '  --receive-pack=x', 'ext::sh -c "touch /tmp/pwned"', 'EXT::sh -c x', ' ext::x',
    'a\nb', 'a\u0000b', 'https://example.com/x\r\n',
  ]
  for (const remote of evil) {
    const repository = await repoPath()
    await assert.rejects(ConfigStore.open({
      repository, remote, namespaces: new NamespaceRegistry(), user: USER, agent: USER,
    }), (error: unknown) => {
      isPlainError(/remote/)(error)
      assert.ok(!(error as Error).message.includes('pwned'), 'the message does not repeat the remote')
      return true
    }, JSON.stringify(remote))
    await assert.rejects(access(repository), { code: 'ENOENT' }, `${JSON.stringify(remote)} created nothing`)
  }
  for (const remote of ['git@github.com:bketelsen/dish-config.git', 'ssh://git@github.com/x/y.git', 'https://github.com/x/y.git', '/srv/x.git', 'file:///srv/x.git', 'relative/x.git', 'ext:x', './-x']) {
    assert.equal(checkRemote(remote), remote)
  }
  const repository = await repoPath()
  await assert.rejects(ConfigStore.open({
    repository, remote: '/srv/x.git', pushTimeoutMs: 0, namespaces: new NamespaceRegistry(), user: USER, agent: USER,
  }), isPlainError(/time limit/))
  await assert.rejects(ConfigStore.open({
    repository, remote: '/srv/x.git', pushDelays: [], namespaces: new NamespaceRegistry(), user: USER, agent: USER,
  }), isPlainError(/delays/))
  await assert.rejects(access(repository))
})

test('an existing repository opens without contacting the remote, even one that is gone', async () => {
  const repository = await existingRepository()
  const missing = join(await tempDir(), 'gone.git')
  const store = await openStore({ repository, claims: [ns('prompts/')], remote: missing, pushDelays: [60_000] })
  try {
    assert.match(await store.head(), /^[0-9a-f]{40}$/)
    await assert.rejects(access(missing))
    const status = await waitFor('the failure', async () => {
      const found = await store.remoteStatus()
      return found.lastError !== undefined && found
    })
    assert.match(status.lastError!, /does not appear to be a git repository/)
  } finally {
    await store.close()
  }
})

// --- clone on start --------------------------------------------------------------------------------

test('start-up with an empty remote initializes locally, and the root commit is pushed', async () => {
  const remote = await bareRemote()
  assert.equal(await remoteHead(remote.git), undefined)
  const { store, git } = await openAt({ claims: [ns('prompts/')], remote: remote.path })
  await pushed(store)
  const root = await store.head()
  assert.equal(await remoteHead(remote.git), root)
  assert.equal((await git.run(['rev-list', '--count', MAIN])).stdout.trim(), '1')
  assert.equal((await git.run(['log', '-1', '--format=%s', MAIN])).stdout.trim(), 'Initialize dish config')
})

test('a missing repository is restored from the remote: the history, the formats and the lock are right, and nothing is left over', async () => {
  const remote = await bareRemote()
  const a = await openAt({ claims: [ns('prompts/')], remote: remote.path })
  await put(a.store, 'a.md', 'from A')
  await put(a.store, 'b.md', 'also from A')
  const head = await a.store.head()
  const history = await a.store.history()
  await pushed(a.store)
  await a.store.close()
  // Something else on the remote that is not the store's to take.
  await remote.git.casRef('refs/heads/elsewhere', head, null)
  await run('git', ['--git-dir', remote.path, 'tag', 'v1', head], { env: ownEnv() })
  await rm(a.repository, { recursive: true })

  // A user whose own git config asks for the other formats must not get them.
  const config = join(await tempDir(), 'gitconfig')
  await writeFile(config, '[init]\n\tdefaultObjectFormat = sha256\n\tdefaultRefFormat = reftable\n')
  await withEnv('GIT_CONFIG_GLOBAL', config, async () => {
    const b = await openStore({ repository: a.repository, claims: [ns('prompts/')], remote: remote.path })
    assert.equal(await b.head(), head)
    assert.equal(await b.read('prompts/a.md'), 'from A')
    assert.equal(await b.read('prompts/b.md'), 'also from A')
    assert.deepEqual(await b.history(), history)

    const git = new Git(a.repository)
    assert.equal((await git.run(['rev-parse', '--show-object-format'])).stdout.trim(), 'sha1')
    assert.equal((await git.run(['config', '--get', 'extensions.refstorage'], { allowFail: true })).stdout.trim(), '')
    await assert.rejects(access(join(a.repository, 'reftable')))
    assert.equal((await git.run(['rev-parse', '--git-path', 'refs/heads/main'])).stdout.trim().endsWith('refs/heads/main'), true)
    assert.equal((await git.run(['symbolic-ref', 'HEAD'])).stdout.trim(), MAIN)
    // Only `main`: nothing else the remote has, no tags, no remote in the config.
    assert.deepEqual((await git.run(['for-each-ref', '--format=%(refname)'])).stdout.trim().split('\n'), [MAIN])
    assert.equal((await git.run(['config', '--get-regexp', '^remote\\.'], { allowFail: true })).stdout, '')

    // Nothing is left over, in or next to it, and the lock this process holds survived the move.
    assert.deepEqual(await readdir(join(a.repository, '..')), ['config.git'])
    assert.deepEqual((await readdir(a.repository)).filter(name => name.startsWith('dish-restore-')), [])
    await assert.rejects(ConfigStore.open({ repository: a.repository, namespaces: new NamespaceRegistry(), user: USER, agent: USER }), isStoreError('LOCKED'))

    // And it carries on: the next write is pushed on top of the restored history.
    await put(b, 'c.md')
    await pushed(b)
    assert.equal(await remoteHead(remote.git), await b.head())
    assert.equal((await remote.git.run(['rev-list', '--count', MAIN])).stdout.trim(), '4')
    await b.close()
  })
})

test('a remote that cannot be reached at a first start is an error with git\'s first line, and creates no repository', async () => {
  const repository = await repoPath()
  const missing = join(await tempDir(), 'nope.git')
  await assert.rejects(openStore({ repository, remote: missing }), (error: unknown) => {
    isPlainError(/^cannot read the remote .*nope\.git: fatal: .* does not appear to be a git repository$/)(error)
    return true
  })
  assert.deepEqual(await readdir(repository), [], 'no repository, no lock, no temporary directory')
  assert.deepEqual(await readdir(join(repository, '..')), ['config.git'])
})

test('a remote that hangs at a first start is cut off by pushTimeoutMs', async () => {
  const ssh = join(await tempDir(), 'slow-ssh')
  await writeFile(ssh, '#!/bin/sh\nexec sleep 600\n')
  await chmod(ssh, 0o755)
  await withEnv('GIT_SSH_COMMAND', `'${ssh}'`, async () => {
    const repository = await repoPath()
    const started = Date.now()
    await assert.rejects(openStore({ repository, remote: 'ssh://localhost/x.git', pushTimeoutMs: 400 }), isPlainError(/timed out after 400 ms/))
    assert.ok(Date.now() - started < 10_000)
    assert.deepEqual(await readdir(repository), [])
  })
})

test('a sha256 remote is refused at a first start, and leaves nothing behind', async () => {
  const remote = join(await tempDir(), 'sha256.git')
  const work = await tempDir()
  await run('git', ['init', '-q', '--bare', '--object-format=sha256', '-b', 'main', remote], { env: ownEnv() })
  await run('git', ['init', '-q', '--object-format=sha256', '-b', 'main', work], { env: ownEnv() })
  await run('git', ['-C', work, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x'], { env: ownEnv() })
  await run('git', ['-C', work, 'push', '-q', remote, 'main'], { env: ownEnv() })
  const repository = await repoPath()
  await assert.rejects(openStore({ repository, remote }), isPlainError(/sha1|sha256|algorithm|object format|hash/i))
  assert.deepEqual(await readdir(repository), [])
  assert.deepEqual(await readdir(join(repository, '..')), ['config.git'])
})

test('the restore is fetched inside the repository directory, never next to it', async () => {
  const remote = await bareRemote()
  const ssh = join(await tempDir(), 'slow-ssh')
  await writeFile(ssh, '#!/bin/sh\nexec sleep 600\n')
  await chmod(ssh, 0o755)
  await withEnv('GIT_SSH_COMMAND', `'${ssh}'`, async () => {
    const repository = await repoPath()
    const opening = openStore({ repository, remote: 'ssh://localhost/x.git', pushTimeoutMs: 1_500 }).then(() => undefined, (error: unknown) => error)
    const found = await waitFor('the restore directory', async () => (await readdir(repository).catch(() => [])).find(name => /^dish-restore-[0-9a-f]{16}$/.test(name)))
    assert.ok(found)
    assert.deepEqual(await readdir(join(repository, '..')), ['config.git'], 'nothing next to the repository')
    isPlainError(/timed out after 1500 ms/)(await opening)
    assert.deepEqual(await readdir(repository), [], 'and nothing left in it')
  })
  assert.equal(await remoteHead(remote.git), undefined)
})

test('a crashed restore\'s directory is removed, and bare skeleton directories are replaced by the restore', async () => {
  const remote = await bareRemote()
  const a = await openAt({ claims: [ns('prompts/')], remote: remote.path })
  await put(a.store, 'a.md')
  const head = await a.store.head()
  await pushed(a.store)
  await a.store.close()
  await rm(a.repository, { recursive: true })

  // What a crashed restore leaves: its half-fetched directory, and (from a crashed `git init`, or a restore that got
  // only this far) directories without files and a config.
  const leftover = join(a.repository, 'dish-restore-0123456789abcdef')
  await mkdir(join(leftover, 'objects'), { recursive: true })
  await writeFile(join(leftover, 'objects', 'half-fetched'), 'x')
  await mkdir(join(a.repository, 'objects', 'pack'), { recursive: true })
  await mkdir(join(a.repository, 'refs', 'heads'), { recursive: true })
  await writeFile(join(a.repository, 'config'), '[core]\n\tbare = true\n')

  const b = await openStore({ repository: a.repository, claims: [ns('prompts/')], remote: remote.path })
  assert.equal(await b.head(), head)
  await assert.rejects(access(leftover))
})

test('a leftover restore directory in an existing repository is removed on open; what only looks like one is not', async () => {
  const repository = await existingRepository()
  const leftover = join(repository, 'dish-restore-0123456789abcdef')
  await mkdir(join(leftover, 'objects'), { recursive: true })
  await writeFile(join(leftover, 'objects', 'half-fetched'), 'x')
  const notHex = join(repository, 'dish-restore-not-hex')
  await mkdir(notHex)
  const aFile = join(repository, 'dish-restore-fedcba9876543210')
  await writeFile(aFile, 'mine')

  const store = await openStore({ repository, claims: [ns('prompts/')] })
  assert.match(await store.head(), /^[0-9a-f]{40}$/)
  await assert.rejects(access(leftover), { code: 'ENOENT' })
  await access(notHex)
  assert.equal(await readFile(aFile, 'utf8'), 'mine')
})

test('a directory that holds objects or refs but is no repository is not replaced from the remote', async () => {
  const remote = await bareRemote()
  const repository = await repoPath()
  await mkdir(join(repository, 'objects', 'ab'), { recursive: true })
  await writeFile(join(repository, 'objects', 'ab', 'cdef'), 'might be a commit')
  const first = await openStore({ repository, claims: [ns('prompts/')], remote: remote.path }).then(() => undefined, (error: unknown) => error)
  isPlainError(/holds parts of one \(objects\), refusing to replace them/)(first)
  assert.equal(await readFile(join(repository, 'objects', 'ab', 'cdef'), 'utf8'), 'might be a commit')
  assert.deepEqual((await readdir(repository)).sort(), ['objects'], 'the lock is released and nothing else was touched')
})
