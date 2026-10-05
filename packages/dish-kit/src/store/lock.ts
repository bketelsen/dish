import { randomBytes } from 'node:crypto'
import { link, readFile, readlink, unlink, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join, resolve } from 'node:path'
import { StoreError } from './errors.ts'

const LOCK_FILE = 'dish.lock'
const BOOT_ID_PATH = '/proc/sys/kernel/random/boot_id'
// The largest pid `process.kill` accepts; anything above throws ERR_INVALID_ARG_TYPE.
const MAX_PID = 0x7fffffff
const PID_NAMESPACE_PATH = '/proc/self/ns/pid'

/** What a lock file says about its holder. */
interface Holder {
  pid: number
  /** Random per `acquireLock` call: tells two holders with the same pid apart. */
  nonce?: string
  /** Linux boot id, when the holder could read one. */
  bootId?: string
  /** The holder's pid namespace, e.g. `pid:[4026531836]`, when it could read one: a pid means something only inside its namespace. */
  pidNs?: string
  host: string
}

/** This process's pid namespace (`/proc/self/ns/pid`), or `undefined` where there is none (not Linux). */
async function currentPidNamespace(): Promise<string | undefined> {
  try {
    return await readlink(PID_NAMESPACE_PATH)
  } catch {
    return undefined
  }
}

/** What `isStale` makes of a lock. `unverifiable` means the holder can't be probed from here. */
type Verdict = 'stale' | 'live' | 'unverifiable'

/**
 * The nonces of the locks this process holds, or is in the middle of creating. A lock that names this
 * process's own pid but carries none of them was written by someone else who had the same pid: a
 * container with its own pid namespace on a shared `boot_id`, say. That holder is not us, and can't be
 * probed with `kill`, so the lock is stale.
 */
const ownNonces = new Set<string>()

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
  const { pid, nonce, bootId, pidNs, host } = value as Record<string, unknown>
  // pid <= 0 is rejected because kill(0, 0) and kill(-n, 0) probe a whole process group, not one process;
  // pid > MAX_PID because process.kill throws on it, which `isAlive` would read as "alive" and lock the store for good.
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0 || pid > MAX_PID) return undefined
  if (typeof host !== 'string') return undefined
  if (nonce !== undefined && typeof nonce !== 'string') return undefined
  if (bootId !== undefined && typeof bootId !== 'string') return undefined
  if (pidNs !== undefined && typeof pidNs !== 'string') return undefined
  const holder: Holder = { pid, host }
  if (nonce !== undefined) holder.nonce = nonce
  if (bootId !== undefined) holder.bootId = bootId
  if (pidNs !== undefined) holder.pidNs = pidNs
  return holder
}

/**
 * Read the lock file. Resolves `undefined` when it is gone, `null` when it is there but isn't a valid lock.
 * A lock is only ever created complete (see `createLock`), so an unreadable one is garbage, not a holder mid-write.
 */
async function readHolder(path: string): Promise<Holder | null | undefined> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined
    throw error
  }
  return parseHolder(text) ?? null
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
 * Whether the holder is gone, so its lock can be taken over, or can't be judged from here.
 * - Which machine: a boot id equal to this machine's means the holder is here, whatever its hostname says
 *   (DHCP or NetworkManager can rename a host mid-boot). Without one to compare, or with a different one, a
 *   lock from another host is unverifiable: the store may sit on a shared filesystem.
 * - A different boot id on this host means the machine rebooted since, so the pid (which may have been
 *   reused) says nothing: stale.
 * - Which pid namespace: containers on one machine share the boot id, but a pid only exists inside its own
 *   namespace, so a holder in another one can't be probed with `kill`: unverifiable, just like another host.
 * - On this machine and in this namespace, a lock that names our own pid but none of our nonces was written
 *   by someone else who had the same pid: stale.
 * - Otherwise the lock is stale exactly when its pid is not alive.
 */
function judge(holder: Holder, host: string, bootId: string | undefined, pidNs: string | undefined): Verdict {
  const comparable = holder.bootId !== undefined && bootId !== undefined
  if (comparable && holder.bootId !== bootId) return holder.host === host ? 'stale' : 'unverifiable'
  if (!comparable && holder.host !== host) return 'unverifiable'
  if (holder.pidNs !== undefined && pidNs !== undefined && holder.pidNs !== pidNs) return 'unverifiable'
  if (holder.pid === process.pid && !(holder.nonce !== undefined && ownNonces.has(holder.nonce))) return 'stale'
  return isAlive(holder.pid) ? 'live' : 'stale'
}

/**
 * Create the lock file with `content` already in it, or resolve `false` if a lock exists.
 * The content goes into a temporary file first, which is then hard-linked to the lock path: `link` fails with
 * `EEXIST` rather than replace anything, and the lock appears whole. Creating the lock empty with
 * `open(path, 'wx')` and writing afterwards would leave a window in which a live holder's lock reads as empty
 * garbage, and another process would take it over.
 */
async function createLock(path: string, content: string): Promise<boolean> {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    await writeFile(tmp, content, { flag: 'wx' })
  } catch (error) {
    await unlink(tmp).catch(() => {})
    throw error
  }
  try {
    await link(tmp, path)
    return true
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return false
    throw error
  } finally {
    await unlink(tmp).catch(() => {})
  }
}

/** The refusal for a lock that is held, or that can't be shown not to be. `label` names the store: "the <label> is locked". */
function locked(path: string, holder: Holder | null | undefined, verdict: Verdict, label: string): StoreError {
  if (holder === null || holder === undefined) {
    return new StoreError('LOCKED', `the ${label} is locked by another process (${path})`)
  }
  const who = `process ${holder.pid} on ${holder.host}`
  if (verdict === 'unverifiable') {
    return new StoreError(
      'LOCKED',
      `the ${label} is locked by ${who}, which can't be verified from here (another host or pid namespace); if it is known to be dead, delete ${path}`,
    )
  }
  return new StoreError('LOCKED', `the ${label} is locked by ${who} (${path})`)
}

/**
 * Take the store's process lock, `<gitDir>/dish.lock`. It is created whole and exclusively: written to a
 * temporary file, then hard-linked into place (see `createLock`). It holds JSON `{ pid, nonce, bootId?, pidNs?, host }`.
 *
 * - A lock whose holder is alive, or can't be probed from here (another machine or pid namespace), throws
 *   `StoreError('LOCKED')` naming the pid. For a holder that can't be probed the message also names the file to
 *   delete if the holder is known to be dead.
 * - A stale lock (unparseable; its pid dead; from an earlier boot; or naming our pid without our nonce) is taken
 *   over: removed, then created anew. If another process creates it first, the lock is theirs and this throws
 *   `LOCKED`. Two processes taking over the *same* stale lock at the same instant can still both end up believing
 *   they hold it (one deletes the other's fresh lock). That race is tolerated: dish is a single-user tool, and it
 *   needs a crashed holder and two new processes starting within the same few milliseconds.
 *
 * @param gitDir - the repository directory the lock lives in; it must exist.
 * @param pid - recorded as the holder; defaults to this process.
 * @param label - what the refusals call the store: "the <label> is locked by ...". Defaults to `store`.
 * @returns a function that releases the lock. It removes the file only if it still carries `pid` and this call's
 *   nonce (a lock someone else has taken over, or re-created, is left alone), and calling it again does nothing.
 */
export async function acquireLock(gitDir: string, pid: number = process.pid, label = 'store'): Promise<() => Promise<void>> {
  const path = join(resolve(gitDir), LOCK_FILE)
  const host = hostname()
  const bootId = await currentBootId()
  const pidNs = await currentPidNamespace()
  const nonce = randomBytes(8).toString('hex')
  // JSON.stringify leaves out the fields that are undefined.
  const content = JSON.stringify({ pid, nonce, bootId, pidNs, host })

  // Registered before the lock exists, so that no look at the file, however early, takes it for a stranger's.
  ownNonces.add(nonce)
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (await createLock(path, content)) return releaser(path, pid, nonce)
      const holder = await readHolder(path)
      // Gone already (released between our create and read): try the create again.
      if (holder === undefined) continue
      const verdict = holder === null ? 'stale' : judge(holder, host, bootId, pidNs)
      if (verdict !== 'stale') throw locked(path, holder, verdict, label)
      // Stale. Second time round we already took over once and still lost the create: someone else owns it now.
      if (attempt > 0) throw locked(path, holder, verdict, label)
      await unlink(path).catch(error => {
        if (errorCode(error) !== 'ENOENT') throw error
      })
    }
    throw locked(path, await readHolder(path), 'live', label)
  } catch (error) {
    ownNonces.delete(nonce)
    throw error
  }
}

function releaser(path: string, pid: number, nonce: string): () => Promise<void> {
  let released = false
  return async () => {
    if (released) return
    const holder = await readHolder(path)
    if (holder !== undefined && holder !== null && holder.pid === pid && holder.nonce === nonce) {
      await unlink(path).catch(error => {
        if (errorCode(error) !== 'ENOENT') throw error
      })
    }
    // Only once it has worked, so a failed release can be retried.
    released = true
    ownNonces.delete(nonce)
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
