/**
 * Per-agent snapshot files: the one thing dish-prompts keeps on disk.
 *
 * A snapshot pins an agent to the store commit its prompt was read at, so the prompt doesn't change for the
 * agent's life, across a dsh restart. The record is small and is only ever replaced whole:
 *
 * - `<directory>/<sha256 hex of the agent id>.json` holds one agent's record. An agent id is outside input
 *   and can hold anything, so it is hashed and never used as a path; the hash is also a fixed length;
 * - `put` writes `.<hash>.<random>.tmp` in the same directory and renames it over the record, so a reader
 *   sees the old record or the new one and never half of one, and a crash leaves at worst a temp file;
 * - `get` touches the record's mtime, so that a snapshot that is still being used is not pruned;
 * - `prune` removes the records not touched for a while, and the temp files a crash left behind.
 *
 * Another dsh process can be using the same directory (`dsh plugin add` and `--dump-config` start plugins, and a
 * restart can overlap its predecessor), and the service prunes at startup, so `prune` has to be safe beside a
 * `put` in another process. It is, because it takes a temp file for a crash's only once it has been there for
 * `TEMP_GRACE_MS`, and a put's temp file lives for milliseconds. One race is accepted: `prune` can `stat` a
 * record that is over `maxAgeMs` old just as another process touches it (a `get`) or replaces it (a `put`), and
 * then delete it. That agent takes a fresh snapshot, so its prompt can change once. The window is the time
 * between a `stat` and an `unlink`, for an agent that went unread for months.
 *
 * Nothing here logs. A file that isn't a record reads as `undefined` and `onInvalid` is told, so the caller can
 * say so. An I/O error is thrown, not reported.
 *
 * @module dish-prompts/snapshots
 */
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, open, readdir, readFile, rename, stat, unlink, utimes } from 'node:fs/promises'
import { join } from 'node:path'

/** What is kept for an agent. */
export interface SnapshotRecord {
  /** The role the agent's prompt was taken for. */
  role: string
  /** The store commit its texts are read at, or `null` if the store wasn't there and the defaults were used. */
  commit: string | null
  /** When the snapshot was taken, in ms since the epoch. */
  takenAt: number
}

/** A record's file name: 64 hex digits and `.json`. */
const RECORD_FILE = /^[0-9a-f]{64}\.json$/
/** A temp file `put` writes: a dot, the record's hash, 16 random hex digits, and `.tmp`. */
const TEMP_FILE = /^\.[0-9a-f]{64}\.[0-9a-f]{16}\.tmp$/
/**
 * How long a temp file must have been there before `prune` takes it for a crashed put's. A put's temp file lives
 * for milliseconds, so this is far longer than it needs, and a crash's leftovers go at the next prune after it.
 */
export const TEMP_GRACE_MS = 60 * 60 * 1000
/** A git commit id, as the store writes it. */
const COMMIT = /^[0-9a-f]{40}$/

/** `error`'s errno code, if it has one. */
function errorCode(error: unknown): unknown {
  return (error as { code?: unknown } | null)?.code
}

/**
 * Whether `value` is shaped like a record: an object whose `role` is a non-empty string, whose `commit` is `null`
 * or 40 lowercase hex digits, and whose `takenAt` is a finite number. Other fields are allowed.
 */
function isRecord(value: unknown): value is SnapshotRecord {
  if (typeof value !== 'object' || value === null) return false
  const { role, commit, takenAt } = value as Record<string, unknown>
  if (typeof role !== 'string' || role === '') return false
  if (commit !== null && (typeof commit !== 'string' || !COMMIT.test(commit))) return false
  return typeof takenAt === 'number' && Number.isFinite(takenAt)
}

/** The record in `text`, or `undefined` if it isn't JSON or isn't shaped like one. Extra fields are dropped. */
function parseRecord(text: string): SnapshotRecord | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(value)) return undefined
  const { role, commit, takenAt } = value
  return { role, commit, takenAt }
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
    // Best effort: the record is written and in place; this only narrows what a power cut can undo.
  }
}

/** The snapshot records in one directory. It needn't exist yet: `put` creates it. */
export class SnapshotFiles {
  readonly #directory: string
  readonly #onInvalid: (agentId: string) => void

  /**
   * @param directory - where the records are kept. Absolute.
   * @param onInvalid - told the agent's id when `get` finds its file but can't use it (it doesn't parse, or isn't
   * shaped like a record), so the caller can log it. A missing file isn't invalid, and an I/O error is thrown.
   */
  constructor(directory: string, onInvalid: (agentId: string) => void = () => {}) {
    this.#directory = directory
    this.#onInvalid = onInvalid
  }

  /** The hash that names `agentId`'s files. */
  static #hash(agentId: string): string {
    return createHash('sha256').update(agentId).digest('hex')
  }

  /**
   * `agentId`'s record, or `undefined` if it has none. A file that doesn't parse or isn't shaped like a record
   * also reads as `undefined`, after `onInvalid` is told; the next `put` replaces it. A record that is read has
   * its mtime set to now; failing to do that does not fail the read. An I/O error other than a missing file
   * (no permission, say) is thrown, and `onInvalid` is not told.
   */
  async get(agentId: string): Promise<SnapshotRecord | undefined> {
    const file = join(this.#directory, `${SnapshotFiles.#hash(agentId)}.json`)
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return undefined
      throw error
    }
    const record = parseRecord(text)
    if (record === undefined) {
      this.#onInvalid(agentId)
      return undefined
    }
    const now = new Date()
    await utimes(file, now, now).catch(() => {})
    return record
  }

  /**
   * Keep `record` as `agentId`'s, replacing any it had. The write is atomic and durable: a temp file in the same
   * directory, synced, then renamed over the record, then the directory synced (that last step best effort). The
   * directory is created (mode 0o700) if it isn't there; the file is mode 0o600.
   * @throws TypeError if `record` is one `get` would refuse. Nothing is written.
   */
  async put(agentId: string, record: SnapshotRecord): Promise<void> {
    if (!isRecord(record)) {
      throw new TypeError('a snapshot record needs a non-empty role, a commit that is null or 40 lowercase hex digits, and a finite takenAt')
    }
    const hash = SnapshotFiles.#hash(agentId)
    const file = join(this.#directory, `${hash}.json`)
    const temp = join(this.#directory, `.${hash}.${randomBytes(8).toString('hex')}.tmp`)
    const { role, commit, takenAt } = record
    await mkdir(this.#directory, { recursive: true, mode: 0o700 })
    // Outside the try: if `open` fails nothing of ours was created (on EEXIST the file isn't ours to remove).
    const handle = await open(temp, 'wx', 0o600)
    try {
      try {
        await handle.writeFile(JSON.stringify({ role, commit, takenAt }))
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temp, file)
    } catch (error) {
      await unlink(temp).catch(() => {})
      throw error
    }
    await syncDirectory(this.#directory)
  }

  /** Forget `agentId`'s record. It's fine if it has none. */
  async drop(agentId: string): Promise<void> {
    try {
      await unlink(join(this.#directory, `${SnapshotFiles.#hash(agentId)}.json`))
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error
    }
  }

  /**
   * Remove the records whose mtime is more than `maxAgeMs` ago, and the temp files `put` left behind that are
   * more than `TEMP_GRACE_MS` old (whatever `maxAgeMs` is). Returns how many files went. Only a regular file
   * named like a record or a temp file is touched; the rest of the directory is left alone. A directory that
   * doesn't exist has nothing to prune. It is safe beside a `put` in another process; see the module comment
   * for the one race it accepts.
   * @throws RangeError if `maxAgeMs` isn't a number that is 0 or more: `NaN` or a negative age would remove every record.
   */
  async prune(maxAgeMs: number): Promise<number> {
    if (!(maxAgeMs >= 0)) throw new RangeError(`maxAgeMs must be 0 or more, not ${String(maxAgeMs)}`)
    let entries
    try {
      entries = await readdir(this.#directory, { withFileTypes: true })
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return 0
      throw error
    }
    const now = Date.now()
    const recordCutoff = now - maxAgeMs
    const tempCutoff = now - TEMP_GRACE_MS
    let removed = 0
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const stray = TEMP_FILE.test(entry.name)
      if (!stray && !RECORD_FILE.test(entry.name)) continue
      const file = join(this.#directory, entry.name)
      try {
        if ((await stat(file)).mtimeMs >= (stray ? tempCutoff : recordCutoff)) continue
        await unlink(file)
        removed++
      } catch (error) {
        // Gone already (another process dropped it): nothing to do.
        if (errorCode(error) !== 'ENOENT') throw error
      }
    }
    return removed
  }
}
