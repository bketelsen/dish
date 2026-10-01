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
 * **`prune` must not run at the same time as `put`**, in this process or another one on the same directory:
 * it would take a put's temp file for a crash's and remove it before the rename. The service calls it once at
 * startup, before it takes any snapshot, and that is the only place it is safe to.
 *
 * Nothing here logs. An unreadable record reads as `undefined` and the caller says so.
 *
 * @module dish-prompts/snapshots
 */
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, rename, stat, unlink, utimes, writeFile } from 'node:fs/promises'
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
/** A git commit id, as the store writes it. */
const COMMIT = /^[0-9a-f]{40}$/

/** `error`'s errno code, if it has one. */
function errorCode(error: unknown): unknown {
  return (error as { code?: unknown } | null)?.code
}

/** The record in `text`, or `undefined` if it isn't JSON or isn't shaped like one. Extra fields are dropped. */
function parseRecord(text: string): SnapshotRecord | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const { role, commit, takenAt } = value as Record<string, unknown>
  if (typeof role !== 'string' || role === '') return undefined
  if (commit !== null && (typeof commit !== 'string' || !COMMIT.test(commit))) return undefined
  if (typeof takenAt !== 'number' || !Number.isFinite(takenAt)) return undefined
  return { role, commit, takenAt }
}

/** The snapshot records in one directory. It needn't exist yet: `put` creates it. */
export class SnapshotFiles {
  readonly #directory: string

  /** @param directory - where the records are kept. Absolute. */
  constructor(directory: string) {
    this.#directory = directory
  }

  /** The hash that names `agentId`'s files. */
  static #hash(agentId: string): string {
    return createHash('sha256').update(agentId).digest('hex')
  }

  /**
   * `agentId`'s record, or `undefined` if it has none, or its file doesn't parse or isn't shaped like one
   * (the next `put` replaces it). A record that is read has its mtime set to now; failing to do that does not
   * fail the read. An I/O error other than a missing file (no permission, say) is thrown.
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
    if (record === undefined) return undefined
    const now = new Date()
    await utimes(file, now, now).catch(() => {})
    return record
  }

  /**
   * Keep `record` as `agentId`'s, replacing any it had. The write is atomic: a temp file in the same directory,
   * then a rename. The directory is created (mode 0o700) if it isn't there; the file is mode 0o600.
   */
  async put(agentId: string, record: SnapshotRecord): Promise<void> {
    const hash = SnapshotFiles.#hash(agentId)
    const file = join(this.#directory, `${hash}.json`)
    const temp = join(this.#directory, `.${hash}.${randomBytes(8).toString('hex')}.tmp`)
    const { role, commit, takenAt } = record
    await mkdir(this.#directory, { recursive: true, mode: 0o700 })
    try {
      await writeFile(temp, JSON.stringify({ role, commit, takenAt }), { flag: 'wx', mode: 0o600 })
      await rename(temp, file)
    } catch (error) {
      await unlink(temp).catch(() => {})
      throw error
    }
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
   * Remove the records whose mtime is more than `maxAgeMs` ago, and every temp file `put` left behind, of any
   * age. Returns how many files went. Only a regular file named like a record or a temp file is touched; the
   * rest of the directory is left alone. A directory that doesn't exist has nothing to prune.
   *
   * Don't call it while a `put` may be running: see the module comment.
   */
  async prune(maxAgeMs: number): Promise<number> {
    let entries
    try {
      entries = await readdir(this.#directory, { withFileTypes: true })
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return 0
      throw error
    }
    const cutoff = Date.now() - maxAgeMs
    let removed = 0
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const stray = TEMP_FILE.test(entry.name)
      if (!stray && !RECORD_FILE.test(entry.name)) continue
      const file = join(this.#directory, entry.name)
      try {
        if (!stray && (await stat(file)).mtimeMs >= cutoff) continue
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
