import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFile, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
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

async function lockPath(): Promise<{ dir: string, file: string }> {
  const dir = await tempDir()
  return { dir, file: join(dir, 'dish.lock') }
}

async function writeLock(file: string, content: unknown): Promise<void> {
  await writeFile(file, typeof content === 'string' ? content : JSON.stringify(content))
}

async function readLock(file: string): Promise<{ pid?: unknown, bootId?: unknown, host?: unknown }> {
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

test('acquireLock writes our pid, boot id (where readable) and host', async () => {
  const { dir, file } = await lockPath()
  const release = await acquireLock(dir)
  const held = await readLock(file)
  assert.equal(held.pid, process.pid)
  assert.equal(held.host, hostname())
  assert.equal(held.bootId, await currentBootId())
  await release()
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
  await writeLock(file, { pid: process.pid, host: hostname() })
  await assert.rejects(acquireLock(dir), isLocked(process.pid))
})

test('an unparseable or malformed lock is taken over', async () => {
  for (const content of ['not json', '[]', 'null', '{}', '{"pid":"12"}', '{"pid":0,"host":"x"}', '{"pid":-1,"host":"x"}', `{"pid":${process.pid}}`]) {
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

test('a lock from another host is live even if its pid is dead: the filesystem is shared and cannot be probed', async () => {
  const { dir, file } = await lockPath()
  await writeLock(file, { pid: await deadPid(), bootId: await currentBootId(), host: `not-${hostname()}` })
  await assert.rejects(acquireLock(dir), isLocked())
  assert.equal((await readLock(file)).host, `not-${hostname()}`)
})

test('a lock from another boot is stale even if its pid is alive (pid reuse after reboot)', async t => {
  if (await currentBootId() === undefined) return t.skip(`${BOOT_ID_PATH} is not readable`)
  const { dir, file } = await lockPath()
  await writeLock(file, { pid: process.pid, bootId: 'not-this-boot', host: hostname() })
  const release = await acquireLock(dir)
  assert.equal((await readLock(file)).bootId, await currentBootId())
  await release()
})

test('a pid that exists but belongs to someone else (EPERM) counts as alive', async () => {
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
  const { rm } = await import('node:fs/promises')
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
