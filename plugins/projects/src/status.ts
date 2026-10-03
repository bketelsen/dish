/**
 * Each project's onboarding status, kept in one file (`<state>/projects/status.json`) so that a ready project stays
 * ready across a restart, and isn't onboarded again.
 *
 * - The store answers from memory: `get` is synchronous, and `set` changes memory at once and then writes the whole
 *   store. Writes are serialized, so sets made at once all land, and each is atomic (a temp file in the same
 *   directory, synced, renamed over the file), so a reader or a crash never sees half a file.
 * - Names compare without regard to case, as GitHub's do: the registry refuses two that differ only in case.
 * - A file that can't be parsed is set aside (renamed `status.json.corrupt-<ms>`) and the store starts empty: the
 *   projects in it are onboarded again, which adopts their clones. One entry that isn't a status is left out alone.
 * - A project that was cloning or in setup when dish stopped isn't any more: it loads as pending.
 *
 * @module dish-projects/status
 */
import { randomBytes } from 'node:crypto'
import { readFileSync, renameSync } from 'node:fs'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

export type ProjectState = 'pending' | 'cloning' | 'setup' | 'ready' | 'failed'

export interface ProjectStatus {
  state: ProjectState
  /** The onboarding step it is at (cloning, setup) or failed at (failed). */
  step?: string
  /** Why it failed, or why it waits (pending). Masked, and never a secret. */
  message?: string
  /** When it changed to this, in ms since the epoch; 0 for a project with no status yet. */
  at: number
  /** When it last became ready. */
  readyAt?: number
  /** Ready, with setup skipped: why, and the command to run instead. */
  setupSkipped?: string
}

const STATES: readonly ProjectState[] = ['pending', 'cloning', 'setup', 'ready', 'failed']
/** States that only exist while an onboarding runs. */
const TRANSIENT: readonly ProjectState[] = ['cloning', 'setup']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const optionalString = (value: unknown): boolean => value === undefined || typeof value === 'string'
const optionalTime = (value: unknown): boolean => value === undefined || (typeof value === 'number' && Number.isFinite(value))

/** `value` as a status, with only the known fields, or `undefined` if it isn't one. */
function parseStatus(value: unknown): ProjectStatus | undefined {
  if (!isRecord(value)) return undefined
  const { state, step, message, at, readyAt, setupSkipped } = value
  if (typeof state !== 'string' || !(STATES as readonly string[]).includes(state)) return undefined
  if (typeof at !== 'number' || !Number.isFinite(at)) return undefined
  if (!optionalString(step) || !optionalString(message) || !optionalString(setupSkipped) || !optionalTime(readyAt)) return undefined
  return copy({ state: state as ProjectState, step, message, at, readyAt, setupSkipped } as ProjectStatus)
}

/** A copy of `status` without the fields that are `undefined`, so that what is stored is what is compared. */
function copy(status: ProjectStatus): ProjectStatus {
  const result: ProjectStatus = { state: status.state, at: status.at }
  if (status.step !== undefined) result.step = status.step
  if (status.message !== undefined) result.message = status.message
  if (status.readyAt !== undefined) result.readyAt = status.readyAt
  if (status.setupSkipped !== undefined) result.setupSkipped = status.setupSkipped
  return result
}

const key = (name: string): string => name.toLowerCase()

function errorCode(error: unknown): unknown {
  return (error as { code?: unknown } | null)?.code
}

/** Flush a directory's entries to disk, if the platform lets us: a rename is only durable once its directory is. */
async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch {
    // Best effort: the file is written and in place; this only narrows what a power cut can undo.
  }
}

export class StatusStore {
  readonly #file: string
  readonly #statuses = new Map<string, ProjectStatus>()
  /** The last write queued: each one waits for the one before, so writes land in order and never interleave. */
  #writing: Promise<void> = Promise.resolve()

  /** @param file - `<state>/projects/status.json`. Its directory needn't exist: the first write makes it (0700). */
  constructor(file: string) {
    this.#file = file
  }

  /**
   * Read the file. A missing file (or directory) is an empty store; one that isn't JSON of the right shape is set
   * aside and the store is empty. Statuses set before the load finishes are kept over the file's.
   * @throws what reading or setting aside the file throws, other than a missing file.
   */
  async load(): Promise<void> {
    let text: string
    try {
      text = await readFile(this.#file, 'utf8')
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return
      throw error
    }
    if (!this.#take(text)) await rename(this.#file, `${this.#file}.corrupt-${Date.now()}`)
  }

  /**
   * `load`, at once: the file is small, and a caller that answers `get` from the moment it starts (the plugin, whose
   * ready projects other plugins check as soon as they start) can't answer from an empty store meanwhile.
   * @throws as `load` does.
   */
  loadSync(): void {
    let text: string
    try {
      text = readFileSync(this.#file, 'utf8')
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return
      throw error
    }
    if (!this.#take(text)) renameSync(this.#file, `${this.#file}.corrupt-${Date.now()}`)
  }

  /** Take the statuses in `text`, the file's content. `false` when it isn't a store's file at all. */
  #take(text: string): boolean {
    let projects: Record<string, unknown> | undefined
    try {
      const parsed: unknown = JSON.parse(text)
      if (isRecord(parsed) && isRecord(parsed.projects)) projects = parsed.projects
    } catch {
      // Not JSON.
    }
    if (projects === undefined) return false
    for (const [name, value] of Object.entries(projects)) {
      const status = parseStatus(value)
      if (status === undefined || this.#statuses.has(key(name))) continue
      // What was running when dish stopped isn't running now.
      this.#statuses.set(key(name), TRANSIENT.includes(status.state) ? { state: 'pending', at: status.at } : status)
    }
    return true
  }

  /** `name`'s status (a copy), or pending at 0 when the store has none. */
  get(name: string): ProjectStatus {
    const status = this.#statuses.get(key(name))
    return status === undefined ? { state: 'pending', at: 0 } : copy(status)
  }

  /** The names the store has a status for, lower-cased, sorted. */
  names(): string[] {
    return [...this.#statuses.keys()].sort()
  }

  /** Set `name`'s status: at once in memory, then on disk. Rejects if the write fails; memory keeps it all the same. */
  set(name: string, status: ProjectStatus): Promise<void> {
    this.#statuses.set(key(name), copy(status))
    return this.#save()
  }

  /** Forget `name`'s status, in memory at once and then on disk. */
  forget(name: string): Promise<void> {
    this.#statuses.delete(key(name))
    return this.#save()
  }

  /** Queue a write of the whole store as it will be when the write runs. */
  #save(): Promise<void> {
    const run = this.#writing.then(() => this.#write())
    // The chain goes on past a failed write: the next one writes everything anyway.
    this.#writing = run.catch(() => {})
    return run
  }

  async #write(): Promise<void> {
    const directory = dirname(this.#file)
    const projects: Record<string, ProjectStatus> = {}
    for (const name of [...this.#statuses.keys()].sort()) {
      Object.defineProperty(projects, name, { value: this.#statuses.get(name), enumerable: true, writable: true, configurable: true })
    }
    const text = `${JSON.stringify({ projects }, null, 2)}\n`
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const temp = join(directory, `.${basename(this.#file)}.${randomBytes(8).toString('hex')}.tmp`)
    // Outside the try: if `open` fails nothing of ours was created.
    const handle = await open(temp, 'wx', 0o600)
    try {
      try {
        await handle.writeFile(text)
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temp, this.#file)
    } catch (error) {
      await unlink(temp).catch(() => {})
      throw error
    }
    await syncDirectory(directory)
  }
}
