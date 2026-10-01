import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ConfigStoreError } from '../src/store/errors.ts'
import { SerialQueue, acquireLock } from '../src/store/lock.ts'
import { tempDir } from './helpers.ts'

const BOOT_ID_PATH = '/proc/sys/kernel/random/boot_id'

async function currentBootId(): Promise<string | undefined> {
  try {
    return (await readFile(BOOT_ID_PATH, 'utf8')).trim()
  } catch {
    return undefined
  }
}

/** A pid that certainly isn't running: a child that was started and has already exited. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  const pid = child.pid
  assert.ok(pid !== undefined)
  await once(child, 'exit')
  return pid
}

const livePids: ChildProcess[] = []

after(() => {
  for (const child of livePids.splice(0)) child.kill('SIGKILL')
})

/** The pid of a process that stays running for the whole test file, and is not this one. */
function livePid(): number {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' })
  child.unref()
  livePids.push(child)
  assert.ok(child.pid !== undefined)
  return child.pid
}

async function lockPath(): Promise<{ dir: string, file: string }> {
  const dir = await tempDir()
  return { dir, file: join(dir, 'dish.lock') }
}

async function writeLock(file: string, content: unknown): Promise<void> {
  await writeFile(file, typeof content === 'string' ? content : JSON.stringify(content))
}

async function readLock(file: string): Promise<{ pid?: unknown, nonce?: unknown, bootId?: unknown, host?: unknown }> {
  return JSON.parse(await readFile(file, 'utf8'))
}

function isLocked(pid?: number): (error: unknown) => boolean {
  return error => {
    assert.ok(error instanceof ConfigStoreError)
    assert.equal(error.code, 'LOCKED')
    if (pid !== undefined) assert.ok(error.message.includes(String(pid)), `message names pid ${pid}: ${error.message}`)
    return true
  }
}

test('acquireLock writes our pid, a nonce, the boot id (where readable) and the host', async () => {
  const { dir, file } = await lockPath()
  const release = await acquireLock(dir)
  const held = await readLock(file)
  assert.equal(held.pid, process.pid)
  assert.match(String(held.nonce), /^[0-9a-f]{16}$/)
  assert.equal(held.host, hostname())
  assert.equal(held.bootId, await currentBootId())
  await release()
})

test('each acquire gets its own nonce', async () => {
  const { dir, file } = await lockPath()
  const first = await acquireLock(dir)
  const nonce = (await readLock(file)).nonce
  await first()
  const second = await acquireLock(dir)
  assert.notEqual((await readLock(file)).nonce, nonce)
  await second()
})

test('creating and releasing the lock leaves no temporary files behind', async () => {
  const { dir } = await lockPath()
  const release = await acquireLock(dir)
  assert.deepEqual(await readdir(dir), ['dish.lock'])
  await assert.rejects(acquireLock(dir), isLocked())
  assert.deepEqual(await readdir(dir), ['dish.lock'])
  await release()
  assert.deepEqual(await readdir(dir), [])
})

test('a second acquire while the holder is alive throws LOCKED, naming the pid', async () => {
  const { dir } = await lockPath()
  const release = await acquireLock(dir)
  await assert.rejects(acquireLock(dir), isLocked(process.pid))
  await release()
})

test('after release the lock can be acquired again, and release removes the file', async () => {
  const { dir, file } = await lockPath()
  await (await acquireLock(dir))()
  await assert.rejects(readFile(file), { code: 'ENOENT' })
  const again = await acquireLock(dir)
  await again()
})

test('when several acquire at once, exactly one wins and the rest get LOCKED', async () => {
  const { dir } = await lockPath()
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => acquireLock(dir)))
  const won = results.filter(r => r.status === 'fulfilled')
  const lost = results.filter(r => r.status === 'rejected')
  assert.equal(won.length, 1)
  for (const r of lost) assert.ok(r.reason instanceof ConfigStoreError && r.reason.code === 'LOCKED')
  await won[0].value()
})

test('a lock held by a dead pid is taken over', async () => {
  const { dir, file } = await lockPath()
  const dead = await deadPid()
  await writeLock(file, { pid: dead, bootId: await currentBootId(), host: hostname() })
  const release = await acquireLock(dir)
  assert.equal((await readLock(file)).pid, process.pid)
  await release()
})

test('a lock without a boot id (non-Linux) held by a dead pid is taken over; by a live pid it is not', async () => {
  const { dir, file } = await lockPath()
  await writeLock(file, { pid: await deadPid(), host: hostname() })
  await (await acquireLock(dir))()
  const live = livePid()
  await writeLock(file, { pid: live, host: hostname() })
  await assert.rejects(acquireLock(dir), isLocked(live))
})

test('an unparseable or malformed lock is taken over', async () => {
  for (const content of ['not json', '[]', 'null', '{}', '{"pid":"12"}', '{"pid":0,"host":"x"}', '{"pid":-1,"host":"x"}', '{"pid":2147483648,"host":"x"}', '{"pid":1.5,"host":"x"}', '{"pid":12,"host":"x","nonce":7}', `{"pid":${process.pid}}`]) {
    const { dir, file } = await lockPath()
    await writeLock(file, content)
    const release = await acquireLock(dir)
    assert.equal((await readLock(file)).pid, process.pid, content)
    await release()
  }
})

test('an empty lock file is taken over', async () => {
  const { dir, file } = await lockPath()
  await writeLock(file, '')
  await (await acquireLock(dir))()
})

test('a lock from another machine is live even if its pid is dead: the filesystem is shared and cannot be probed', async () => {
  const { dir, file } = await lockPath()
  const dead = await deadPid()
  for (const bootId of [undefined, 'another-machine']) {
    await writeLock(file, { pid: dead, bootId, host: `not-${hostname()}` })
    await assert.rejects(acquireLock(dir), isLocked(dead))
    assert.equal((await readLock(file)).host, `not-${hostname()}`)
  }
})

test('the same boot id with a different hostname is this machine: a dead pid is taken over, a live one is not', async t => {
  const bootId = await currentBootId()
  if (bootId === undefined) return t.skip(`${BOOT_ID_PATH} is not readable`)
  const { dir, file } = await lockPath()
  await writeLock(file, { pid: await deadPid(), bootId, host: `renamed-${hostname()}` })
  await (await acquireLock(dir))()
  const live = livePid()
  await writeLock(file, { pid: live, bootId, host: `renamed-${hostname()}` })
  await assert.rejects(acquireLock(dir), isLocked(live))
})

test('a lock from another boot is stale even if its pid is alive (pid reuse after reboot)', async t => {
  if (await currentBootId() === undefined) return t.skip(`${BOOT_ID_PATH} is not readable`)
  const { dir, file } = await lockPath()
  await writeLock(file, { pid: livePid(), bootId: 'not-this-boot', host: hostname() })
  const release = await acquireLock(dir)
  assert.equal((await readLock(file)).bootId, await currentBootId())
  await release()
})

test('a lock naming our own pid that this process did not take (another pid namespace) is stale', async () => {
  const { dir, file } = await lockPath()
  const bootId = await currentBootId()
  for (const nonce of ['0123456789abcdef', undefined]) {
    await writeLock(file, { pid: process.pid, nonce, bootId, host: hostname() })
    const release = await acquireLock(dir)
    assert.notEqual((await readLock(file)).nonce, nonce)
    await release()
  }
})

test('a pid that exists but belongs to someone else (EPERM) counts as alive', async t => {
  if (process.getuid?.() === 0) return t.skip('root can signal pid 1')
  // pid 1 always exists; as a regular user, signalling it fails with EPERM.
  const { dir, file } = await lockPath()
  await writeLock(file, { pid: 1, bootId: await currentBootId(), host: hostname() })
  await assert.rejects(acquireLock(dir), isLocked(1))
})

test('release leaves a lock that someone else has taken over', async () => {
  const { dir, file } = await lockPath()
  const release = await acquireLock(dir)
  const other = { pid: await deadPid(), bootId: await currentBootId(), host: hostname() }
  await writeLock(file, other)
  await release()
  assert.deepEqual(await readLock(file), JSON.parse(JSON.stringify(other)))
})

test('release leaves a lock that was re-created by a process with the same pid', async () => {
  const { dir, file } = await lockPath()
  const first = await acquireLock(dir)
  await rm(file)
  const second = await acquireLock(dir)
  await first()
  assert.equal((await readLock(file)).pid, process.pid)
  await assert.rejects(acquireLock(dir), isLocked())
  await second()
  await assert.rejects(readFile(file), { code: 'ENOENT' })
})

test('release is idempotent and does not remove a lock acquired after it', async () => {
  const { dir } = await lockPath()
  const first = await acquireLock(dir)
  await first()
  const second = await acquireLock(dir)
  await first()
  await assert.rejects(acquireLock(dir), isLocked())
  await second()
  await second()
  await (await acquireLock(dir))()
})

test('release when the lock file is already gone does not throw', async () => {
  const { dir, file } = await lockPath()
  const release = await acquireLock(dir)
  await rm(file)
  await release()
})

test('acquireLock records an explicit pid', async () => {
  const { dir, file } = await lockPath()
  const release = await acquireLock(dir, process.pid)
  assert.equal((await readLock(file)).pid, process.pid)
  await release()
})

test('acquireLock fails with the underlying error when the directory is missing', async () => {
  const dir = join(await tempDir(), 'missing')
  await assert.rejects(acquireLock(dir), { code: 'ENOENT' })
})

// A child process that takes the lock for real, with its event loop stalled for STALL_MS at one point
// (GC, a sync module load, a busy start-up). It prints what it did and then stays alive until killed.
const CHILD_SOURCE = `
import fsp from 'node:fs/promises'
import { writeSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
const say = line => writeSync(1, line + '\\n')
const stall = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const [name, said] = process.env.STALL_AT === 'after-link' ? ['link', 'linked'] : ['writeFile', 'written']
const original = fsp[name]
fsp[name] = async (...args) => {
  const result = await original(...args)
  say(said)
  stall(Number(process.env.STALL_MS))
  return result
}
syncBuiltinESMExports()
const { acquireLock } = await import(process.env.LOCK_MODULE)
try { await acquireLock(process.env.LOCK_DIR); say('acquired') } catch (error) { say(error.code) }
setInterval(() => {}, 1000)
`

function startLockingChild(dir: string, stallAt: 'after-write' | 'after-link'): { child: ChildProcess, waitFor: (line: string) => Promise<void> } {
  const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD_SOURCE], {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, LOCK_DIR: dir, STALL_AT: stallAt, STALL_MS: '300', LOCK_MODULE: pathToFileURL(join(import.meta.dirname, '../src/store/lock.ts')).href },
  })
  livePids.push(child)
  let output = ''
  child.stdout!.setEncoding('utf8').on('data', chunk => { output += chunk })
  const waitFor = async (line: string): Promise<void> => {
    for (let waited = 0; !output.split('\n').includes(line); waited += 10) {
      assert.ok(waited < 10_000, `timed out waiting for the child to say ${line}; it said ${JSON.stringify(output)}`)
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
  return { child, waitFor }
}

test('a live holder that has just taken the lock is not robbed while its event loop stalls', async () => {
  const { dir, file } = await lockPath()
  const { child, waitFor } = startLockingChild(dir, 'after-link')
  await waitFor('linked')
  // The child holds a complete lock but hasn't yet noticed. It must read as live, not as half-written garbage.
  assert.equal((await readLock(file)).pid, child.pid)
  await assert.rejects(acquireLock(dir), isLocked(child.pid))
  await waitFor('acquired')
  assert.equal((await readLock(file)).pid, child.pid)
  // Once it dies the lock is stale, and ours.
  child.kill('SIGKILL')
  await once(child, 'exit')
  const release = await acquireLock(dir)
  assert.equal((await readLock(file)).pid, process.pid)
  await release()
})

test('when another process stalls before its lock is in place, one of the two wins and the other gets LOCKED', async () => {
  const { dir, file } = await lockPath()
  const { child, waitFor } = startLockingChild(dir, 'after-write')
  await waitFor('written')
  // The child has written its lock to a temporary file but hasn't linked it. There is no lock yet, and no
  // empty or partial one to mistake for a stale holder: we take it.
  await assert.rejects(readFile(file), { code: 'ENOENT' })
  const release = await acquireLock(dir)
  await waitFor('LOCKED')
  assert.equal((await readLock(file)).pid, process.pid)
  await release()
  child.kill('SIGKILL')
  await once(child, 'exit')
  assert.deepEqual((await readdir(dir)).filter(name => name.endsWith('.tmp')), [])
})

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

test('SerialQueue runs tasks in submission order: a slow task finishes before a fast one starts', async () => {
  const queue = new SerialQueue()
  const events: string[] = []
  const slow = queue.run(async () => { events.push('slow start'); await sleep(30); events.push('slow end') })
  const fast = queue.run(async () => { events.push('fast start'); events.push('fast end') })
  await Promise.all([slow, fast])
  assert.deepEqual(events, ['slow start', 'slow end', 'fast start', 'fast end'])
})

test('SerialQueue never overlaps tasks', async () => {
  const queue = new SerialQueue()
  let running = 0
  let peak = 0
  const task = async () => {
    peak = Math.max(peak, ++running)
    await sleep(2)
    running--
  }
  await Promise.all(Array.from({ length: 10 }, () => queue.run(task)))
  assert.equal(peak, 1)
})

test('SerialQueue.run resolves with the task result', async () => {
  const queue = new SerialQueue()
  assert.equal(await queue.run(async () => 42), 42)
})

test('a rejecting task rejects with its own error and does not block later tasks', async () => {
  const queue = new SerialQueue()
  const boom = new Error('boom')
  const failing = queue.run(async () => { throw boom })
  const next = queue.run(async () => 'next')
  await assert.rejects(failing, error => error === boom)
  assert.equal(await next, 'next')
  assert.equal(await queue.run(async () => 'later'), 'later')
})

test('a task that throws synchronously rejects the returned promise and does not block later tasks', async () => {
  const queue = new SerialQueue()
  const boom = new Error('sync boom')
  const failing = queue.run((() => { throw boom }) as () => Promise<never>)
  const next = queue.run(async () => 'next')
  await assert.rejects(failing, error => error === boom)
  assert.equal(await next, 'next')
})
