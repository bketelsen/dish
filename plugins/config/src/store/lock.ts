import { open, readFile, unlink } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { ConfigStoreError } from './errors.ts'

const LOCK_FILE = 'dish.lock'
const BOOT_ID_PATH = '/proc/sys/kernel/random/boot_id'
// Another process that has just created the lock may not have written it yet; see `readHolder`.
const PARTIAL_WRITE_GRACE_MS = 25

/** What a lock file says about its holder. */
interface Holder {
  pid: number
  /** Linux boot id, when the holder could read one. */
  bootId?: string
  host: string
}

function errorCode(error: unknown): unknown {
  return (error as { code?: unknown }).code
}

/** This machine's boot id (`/proc/sys/kernel/random/boot_id`), or `undefined` where there is none (not Linux). */
async function currentBootId(): Promise<string | undefined> {
  try {
    const id = (await readFile(BOOT_ID_PATH, 'utf8')).trim()
    return id === '' ? undefined : id
  } catch {
    return undefined
  }
}

function parseHolder(text: string): Holder | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const { pid, bootId, host } = value as Record<string, unknown>
  // pid <= 0 is never a process: kill(0) and kill(-n) would signal whole process groups.
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return undefined
  if (typeof host !== 'string') return undefined
  if (bootId !== undefined && typeof bootId !== 'string') return undefined
  return bootId === undefined ? { pid, host } : { pid, bootId, host }
}

/**
 * Read the lock file. Resolves `undefined` when it is gone, `null` when it is there but isn't a valid lock.
 * `open(path, 'wx')` and the write that follows are two steps, so a file that reads back empty or
 * unparseable may belong to a process caught between them. It gets one more look after a short wait before
 * being called garbage.
 */
async function readHolder(path: string): Promise<Holder | null | undefined> {
  for (let attempt = 0; ; attempt++) {
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return undefined
      throw error
    }
    const holder = parseHolder(text)
    if (holder !== undefined) return holder
    if (attempt > 0) return null
    await sleep(PARTIAL_WRITE_GRACE_MS)
  }
}

/** Whether a process with `pid` exists. `EPERM` means it exists under another user; any other surprise is treated as alive, the safe answer. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return errorCode(error) !== 'ESRCH'
  }
}

/**
 * Whether the holder is gone, so its lock can be taken over.
 * - A lock from another host is live: the store sits on a shared filesystem and that pid can't be probed from here.
 * - A different boot id means the machine rebooted since, so the pid (which may have been reused) says nothing.
 * - Otherwise the lock is stale exactly when its pid is not alive.
 */
function isStale(holder: Holder, host: string, bootId: string | undefined): boolean {
  if (holder.host !== host) return false
  if (holder.bootId !== undefined && bootId !== undefined && holder.bootId !== bootId) return true
  return !isAlive(holder.pid)
}

/** Create the lock file exclusively and write `content` to it. Resolves `false` if it already exists. */
async function createLock(path: string, content: string): Promise<boolean> {
  let handle
  try {
    handle = await open(path, 'wx')
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return false
    throw error
  }
  try {
    await handle.writeFile(content)
  } catch (error) {
    await handle.close().catch(() => {})
    await unlink(path).catch(() => {})
    throw error
  }
  await handle.close()
  return true
}

function locked(holder: Holder | null | undefined): ConfigStoreError {
  if (holder === null || holder === undefined) {
    return new ConfigStoreError('LOCKED', `the config store is locked by another process (${LOCK_FILE})`)
  }
  return new ConfigStoreError('LOCKED', `the config store is locked by process ${holder.pid} on ${holder.host}`)
}

/**
 * Take the store's process lock, `<gitDir>/dish.lock`, created exclusively (`open(..., 'wx')`).
 * It holds JSON `{ pid, bootId?, host }`.
 *
 * - A lock whose holder is alive, or lives on another host, throws `ConfigStoreError('LOCKED')` naming the pid.
 * - A stale lock (unparseable; its pid dead; or from an earlier boot) is taken over: removed, then created anew.
 *   If another process creates it first, the lock is theirs and this throws `LOCKED`. Two processes taking over
 *   the *same* stale lock at the same instant can still both end up believing they hold it (one deletes the
 *   other's fresh lock). That race is tolerated: dish is a single-user tool, and it needs a crashed holder and
 *   two new processes starting within the same few milliseconds.
 *
 * @param gitDir - the repository directory the lock lives in; it must exist.
 * @param pid - recorded as the holder; defaults to this process.
 * @returns a function that releases the lock. It removes the file only if it still names `pid` (a lock someone
 *   else has taken over is left alone), and calling it again does nothing.
 */
export async function acquireLock(gitDir: string, pid: number = process.pid): Promise<() => Promise<void>> {
  const path = join(gitDir, LOCK_FILE)
  const host = hostname()
  const bootId = await currentBootId()
  const content = JSON.stringify(bootId === undefined ? { pid, host } : { pid, bootId, host })

  for (let attempt = 0; attempt < 2; attempt++) {
    if (await createLock(path, content)) return releaser(path, pid)
    const holder = await readHolder(path)
    // Gone already (released between our create and read): try the create again.
    if (holder === undefined) continue
    if (holder !== null && !isStale(holder, host, bootId)) throw locked(holder)
    // Stale. Second time round we already took over once and still lost the create: someone else owns it now.
    if (attempt > 0) throw locked(holder)
    await unlink(path).catch(error => {
      if (errorCode(error) !== 'ENOENT') throw error
    })
  }
  throw locked(await readHolder(path))
}

function releaser(path: string, pid: number): () => Promise<void> {
  let released = false
  return async () => {
    if (released) return
    const holder = await readHolder(path)
    if (holder !== undefined && holder !== null && holder.pid === pid) {
      await unlink(path).catch(error => {
        if (errorCode(error) !== 'ENOENT') throw error
      })
    }
    // Only once it has worked, so a failed release can be retried.
    released = true
  }
}

/**
 * Runs async tasks strictly one at a time, in the order they were submitted. A task that rejects
 * rejects only its own `run` promise; the tasks queued after it still run.
 */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve()

  /** Queue `task`; resolves or rejects exactly as `task` does, once it has run. */
  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task)
    this.tail = result.catch(() => {})
    return result
  }
}
