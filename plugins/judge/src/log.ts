/**
 * The judge's decision log: one JSON line for every call to Jev, in a file for each UTC day, and the content the result
 * screen withheld, one file each. Runtime data, not config: it lives in the judge's state directory.
 *
 * ```
 * <directory>/<yyyy-mm-dd>.jsonl       the day's lines, oldest first, one JSON object and a newline each
 * <directory>/withheld/<id>.txt        one withheld result, masked and capped; <id> is 16 random hex characters
 * ```
 *
 * - **No secrets.** `write` masks the subject and the error (`maskSecrets` from dish-kit, the same patterns dish-config
 *   refuses to store), and `withhold` masks the content. Masking comes before any cut, so a cut can't leave the start of a
 *   secret that no pattern would now match. Only the fields of a `JudgeLogLine` are written, so a caller can't put
 *   anything else in the log by passing more than the type says.
 * - **Bounded.** A line is at most `MAX_LINE_BYTES` (the subject is cut first), withheld content at most
 *   `MAX_WITHHELD_BYTES`, and `read` holds a page of lines and one buffer at a time, however long the files are.
 * - **Private.** Directories are `0o700`, files `0o600`.
 * - **Whole lines.** Appends to a day's file go through that file's queue, one `appendFile` for each line. A line that
 *   can't be read back (torn by a crash, or not ours) is skipped on read and counted in `skipped`.
 *
 * `write` rejects when the disk does. A caller on the way to a decision must catch that and decide anyway: a log that
 * can't be written is no reason to fail a gate.
 *
 * @module dish-judge/log
 */

import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { appendFile, lstat, mkdir, open, readdir, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { maskSecrets } from 'dish-kit'

/** What a Jev call was for. */
export const JUDGE_PURPOSES = ['command', 'approval', 'screen', 'ask'] as const
export type JudgePurpose = typeof JUDGE_PURPOSES[number]

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/**
 * One line of the log, as the spec shows it. Plain JSON.
 *
 * `withheld` is the one addition: the id `withhold` gave the content a screen kept, so that the page can open it from the
 * line. Lines without it are as the spec has them.
 */
export interface JudgeLogLine {
  /** When, in milliseconds since the epoch. The line goes in the file for this moment's UTC day. */
  at: number
  purpose: JudgePurpose
  /** The session id of the agent the call was for. */
  agent?: string
  /** Whether that agent is a crew child. */
  child?: boolean
  tool?: string
  callId?: string
  /** The command, or the tool and size of a result, or `ask_judge`. Masked on write, and cut to fit the line. */
  subject: string
  /** What Jev answered, by question id. `{}` when it didn't. */
  answers: { [question: string]: JsonValue }
  /** What the judge decided: `allow`, `ask`, `deny`, `withhold`, `warn`, `pass`, and so on. */
  decision: string
  latencyMs: number
  /** Why the call failed, or `null`. Masked on write, and cut to fit the line. */
  error: string | null
  withheld?: string
}

export interface ReadQuery {
  /** Only the lines for this purpose. `''` is as if it were not given. */
  purpose?: JudgePurpose
  /** Only the lines with this decision. `''` is as if it were not given. */
  decision?: string
  /** How many lines at most: a whole number from 1 to 500. Default 200. */
  limit?: number
  /** The `next` of the page before: read the lines older than the last one of that page. */
  before?: string
}

export interface ReadResult {
  /** Newest first. */
  lines: JudgeLogLine[]
  /** What to pass as `before` for the page after this one. Not there when there are no older lines (that match). */
  next?: string
  /** How many lines were skipped for being unreadable, among the ones this page went through. */
  skipped: number
}

/** The most a line takes in its file, its newline included. */
export const MAX_LINE_BYTES = 16 * 1024
/** The most a withheld file holds. */
export const MAX_WITHHELD_BYTES = 64 * 1024
export const DEFAULT_LIMIT = 200
export const MAX_LIMIT = 500

/** How much of a file `read` takes at a time. */
const READ_CHUNK = 64 * 1024
/** Longer than this is never a line of ours. It is skipped without being kept in memory. */
const MAX_READ_LINE_BYTES = 1024 * 1024
const DAY_MS = 24 * 60 * 60 * 1000

const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/
const DAY = /^\d{4}-\d{2}-\d{2}$/
const ID = /^[0-9a-f]{16}$/
const WITHHELD_FILE = /^([0-9a-f]{16})\.txt$/
const CURSOR = /^(\d{4}-\d{2}-\d{2}):(\d{1,15})$/
const WITHHELD = 'withheld'

/** Where a cut subject or error ends. */
const CUT_MARK = '…'
/** Where cut withheld content ends. */
const WITHHELD_CUT_MARK = '\n[truncated]'

/** Files are opened without following a link in the last place of the path: a link there isn't one of ours. */
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0

function errorCode(error: unknown): unknown {
  return (error as { code?: unknown } | null)?.code
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** What is wrong with `value` as a log line, or `undefined` if nothing is. */
function lineProblem(value: unknown): string | undefined {
  if (!isObject(value)) return 'it is not an object'
  if (!isFiniteNumber(value.at)) return 'at must be a finite number'
  if (typeof value.purpose !== 'string' || !(JUDGE_PURPOSES as readonly string[]).includes(value.purpose)) {
    return `purpose must be one of ${JUDGE_PURPOSES.join(', ')}`
  }
  if (typeof value.subject !== 'string') return 'subject must be a string'
  if (!isObject(value.answers)) return 'answers must be an object'
  if (typeof value.decision !== 'string') return 'decision must be a string'
  if (!isFiniteNumber(value.latencyMs)) return 'latencyMs must be a finite number'
  if (value.error !== null && typeof value.error !== 'string') return 'error must be a string or null'
  for (const field of ['agent', 'tool', 'callId', 'withheld'] as const) {
    if (value[field] !== undefined && typeof value[field] !== 'string') return `${field} must be a string`
  }
  if (value.child !== undefined && typeof value.child !== 'boolean') return 'child must be a boolean'
  return undefined
}

/** The UTC day of `at` as `yyyy-mm-dd`. @throws RangeError if `at` isn't a moment a four-digit year can name. */
function dayOf(at: number): string {
  const date = new Date(at)
  const day = Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10)
  if (!DAY.test(day)) throw new RangeError(`at is not a date the log can name a file for: ${String(at)}`)
  return day
}

/** When `day` starts, in milliseconds, or `undefined` if it isn't a real UTC day. */
function dayStart(day: string): number | undefined {
  const start = Date.parse(`${day}T00:00:00.000Z`)
  // V8 reads `2026-02-30` as March 2nd: a day that does not round-trip is not one.
  return Number.isNaN(start) || new Date(start).toISOString().slice(0, 10) !== day ? undefined : start
}

/** How many bytes `line` takes in a file: its JSON and a newline. */
function lineBytes(line: JudgeLogLine): number {
  return Buffer.byteLength(JSON.stringify(line), 'utf8') + 1
}

/**
 * `line` with `field` cut to as many whole characters as leave the line within `MAX_LINE_BYTES`, then `…`, or `undefined`
 * if it can't be made to fit by cutting `field` (when the line with that field empty is still too long). A line that
 * fits as it is comes back as it is.
 */
function shrink(line: JudgeLogLine, field: 'subject' | 'error'): JudgeLogLine | undefined {
  if (lineBytes(line) <= MAX_LINE_BYTES) return line
  const value = line[field]
  if (typeof value !== 'string') return undefined
  const withText = (text: string): JudgeLogLine => ({ ...line, [field]: text })
  if (lineBytes(withText('')) > MAX_LINE_BYTES) return undefined
  // A character takes at least a byte of the line, so more than this many code units can't be kept. And a cut can't leave half of a surrogate pair.
  let head = value.length > MAX_LINE_BYTES ? value.slice(0, MAX_LINE_BYTES) : value
  if (/[\ud800-\udbff]$/.test(head)) head = head.slice(0, -1)
  const characters = Array.from(head)
  const fits = (count: number): boolean => lineBytes(withText(characters.slice(0, count).join('') + CUT_MARK)) <= MAX_LINE_BYTES
  if (!fits(0)) return withText('')
  let low = 0
  let high = characters.length
  while (low < high) {
    const middle = (low + high + 1) >> 1
    if (fits(middle)) low = middle
    else high = middle - 1
  }
  return withText(characters.slice(0, low).join('') + CUT_MARK)
}

/**
 * `line` as JSON, within `MAX_LINE_BYTES` with its newline. The subject is cut first. If the line is too long even with
 * no subject, the error is what is long, and it is cut instead and the subject kept; if it is long in both, the error
 * goes to its mark and the subject takes what is left.
 * @throws RangeError if no cut of the subject and the error makes it fit: it is the other fields that are long.
 */
function fitLine(line: JudgeLogLine): string {
  const fitted = shrink(line, 'subject')
    ?? shrink(line, 'error')
    ?? (typeof line.error === 'string' ? shrink({ ...line, error: CUT_MARK }, 'subject') : undefined)
  if (fitted === undefined) throw new RangeError(`a log line is over ${MAX_LINE_BYTES} bytes even with its subject and error cut`)
  return JSON.stringify(fitted)
}

/** `text` as withheld content: at most `MAX_WITHHELD_BYTES` of UTF-8, cut between characters, and marked if it was cut. */
function capWithheld(text: string): string {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= MAX_WITHHELD_BYTES) return text
  let end = MAX_WITHHELD_BYTES - Buffer.byteLength(WITHHELD_CUT_MARK, 'utf8')
  // A continuation byte (10xxxxxx) at the cut means the cut is inside a character: back up to the character's first byte.
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--
  return bytes.subarray(0, end).toString('utf8') + WITHHELD_CUT_MARK
}

/** The line in `text`, or `undefined` if it isn't JSON or isn't shaped like a log line. */
function parseLine(text: string): JudgeLogLine | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  return lineProblem(value) === undefined ? value as JudgeLogLine : undefined
}

function encodeCursor(day: string, offset: number): string {
  return Buffer.from(`${day}:${offset}`, 'utf8').toString('base64url')
}

/** @throws RangeError if `cursor` isn't one `read` gave. */
function decodeCursor(cursor: unknown): { day: string, offset: number } {
  const match = typeof cursor === 'string' && /^[A-Za-z0-9_-]+$/.test(cursor) ? CURSOR.exec(Buffer.from(cursor, 'base64url').toString('utf8')) : null
  if (match === null || dayStart(match[1]!) === undefined) throw new RangeError('before must be the next of a page that read gave')
  return { day: match[1]!, offset: Number(match[2]) }
}

/** Fill `buffer` from `position`, short only if the file is. Gives how many bytes it got. */
async function readFully(handle: FileHandle, buffer: Buffer, position: number): Promise<number> {
  let total = 0
  while (total < buffer.length) {
    const { bytesRead } = await handle.read(buffer, total, buffer.length - total, position + total)
    if (bytesRead === 0) break
    total += bytesRead
  }
  return total
}

/** One line of a file, as `linesBackward` finds it. */
interface FoundLine {
  /** Where the line starts, in bytes from the start of the file. */
  offset: number
  /** Its bytes, without the newline; `undefined` for a line longer than `MAX_READ_LINE_BYTES`, which is not kept. */
  line: Buffer | undefined
}

/**
 * The non-empty lines of `file` that start before byte `end` (the end of the file if there's none), last first. Reads the
 * file backward in `READ_CHUNK`s, so it holds a chunk and the line being put together, however long the file is, and
 * stops reading when its caller stops asking. A file that isn't there, or is a link, has none.
 */
async function* linesBackward(file: string, end: number | undefined): AsyncGenerator<FoundLine> {
  let handle: FileHandle
  try {
    handle = await open(file, constants.O_RDONLY | NO_FOLLOW)
  } catch (error) {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ELOOP' || errorCode(error) === 'ENOTDIR') return
    throw error
  }
  try {
    const info = await handle.stat()
    if (!info.isFile()) return
    let position = Math.min(info.size, end ?? info.size)
    // The end of the line being put together, whose start is further back. Or, for a line that was too long, nothing: `oversized`.
    let tail: Buffer = Buffer.alloc(0)
    let oversized = false
    while (position > 0) {
      const length = Math.min(READ_CHUNK, position)
      position -= length
      const chunk = Buffer.allocUnsafe(length)
      const got = await readFully(handle, chunk, position)
      const data = oversized || tail.length === 0 ? chunk.subarray(0, got) : Buffer.concat([chunk.subarray(0, got), tail])
      let lineEnd = data.length
      for (;;) {
        const newline = lineEnd > 0 ? data.lastIndexOf(0x0a, lineEnd - 1) : -1
        if (newline === -1) break
        const start = newline + 1
        if (oversized) {
          yield { offset: position + start, line: undefined }
          oversized = false
        } else if (start < lineEnd) {
          yield { offset: position + start, line: data.subarray(start, lineEnd) }
        }
        lineEnd = newline
      }
      if (oversized) {
        tail = Buffer.alloc(0)
      } else if (lineEnd > MAX_READ_LINE_BYTES) {
        oversized = true
        tail = Buffer.alloc(0)
      } else {
        tail = data.subarray(0, lineEnd)
      }
    }
    if (oversized) yield { offset: 0, line: undefined }
    else if (tail.length > 0) yield { offset: 0, line: tail }
  } finally {
    await handle.close()
  }
}

/** The judge's decision log in one directory. It needn't exist yet: the first write creates it. */
export class JudgeLog {
  readonly #directory: string
  readonly #now: () => number
  /** The tail of each day file's queue, until it's done. */
  readonly #queues = new Map<string, Promise<void>>()

  /**
   * @param directory - where the log is kept. Made absolute.
   * @param now - the time, in milliseconds. For `prune`.
   */
  constructor(directory: string, now: () => number = Date.now) {
    this.#directory = resolve(directory)
    this.#now = now
  }

  /** Run `job` after what is queued for `file`, whether that worked or not, and give what it gives. */
  #serial<T>(file: string, job: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(file) ?? Promise.resolve()
    const run = previous.then(job)
    const tail = run.then(() => {}, () => {})
    this.#queues.set(file, tail)
    void tail.then(() => {
      if (this.#queues.get(file) === tail) this.#queues.delete(file)
    })
    return run
  }

  /** Resolve once every write that is queued now is done. For a shutdown, and for a test, to wait on. */
  async flush(): Promise<void> {
    while (this.#queues.size > 0) await Promise.all([...this.#queues.values()])
  }

  /**
   * Append `line` to the file of its UTC day: masked (the subject, and the error if there is one), cut to `MAX_LINE_BYTES`
   * (the subject first), and with only the fields of a `JudgeLogLine`. Writes to one file are made in the order of the calls.
   * @throws TypeError if `line` isn't a `JudgeLogLine`; RangeError if `at` has no day or the line can't be made to fit.
   *   Nothing is written then. Other errors are the disk's.
   */
  async write(line: JudgeLogLine): Promise<void> {
    const given: unknown = isObject(line) && line.error === undefined ? { ...line, error: null } : line
    const problem = lineProblem(given)
    if (problem !== undefined) throw new TypeError(`not a log line: ${problem}`)
    const source = given as JudgeLogLine
    const day = dayOf(source.at)
    // Field by field, so that nothing but these gets into the file, and in the order the spec shows them.
    const masked: JudgeLogLine = {
      at: source.at,
      purpose: source.purpose,
      ...(source.agent === undefined ? {} : { agent: source.agent }),
      ...(source.child === undefined ? {} : { child: source.child }),
      ...(source.tool === undefined ? {} : { tool: source.tool }),
      ...(source.callId === undefined ? {} : { callId: source.callId }),
      subject: maskSecrets(source.subject),
      answers: source.answers,
      decision: source.decision,
      latencyMs: source.latencyMs,
      error: source.error === null ? null : maskSecrets(source.error),
      ...(source.withheld === undefined ? {} : { withheld: source.withheld }),
    }
    const text = `${fitLine(masked)}\n`
    const file = join(this.#directory, `${day}.jsonl`)
    await this.#serial(file, async () => {
      // O_NOFOLLOW: a link in the place of a day file is not ours to write through.
      const options = { mode: 0o600, flag: constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | NO_FOLLOW }
      try {
        await appendFile(file, text, options)
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error
        await mkdir(this.#directory, { recursive: true, mode: 0o700 })
        await appendFile(file, text, options)
      }
    })
  }

  /**
   * Keep `content` as a withheld result: masked, and cut to `MAX_WITHHELD_BYTES` of UTF-8 between characters, with a mark
   * where it was cut. Gives the id it is kept under, 16 random hex characters.
   */
  async withhold(content: string): Promise<string> {
    if (typeof content !== 'string') throw new TypeError('content must be a string')
    // Masked first, then cut: a cut can leave the start of a secret that no pattern would match any more.
    const stored = capWithheld(maskSecrets(content))
    const directory = join(this.#directory, WITHHELD)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    for (let attempt = 0; ; attempt++) {
      const id = randomBytes(8).toString('hex')
      try {
        await writeFile(join(directory, `${id}.txt`), stored, { flag: 'wx', mode: 0o600 })
        return id
      } catch (error) {
        // An id that is taken (one in 2^64 for each file there): try another.
        if (errorCode(error) !== 'EEXIST' || attempt >= 4) throw error
      }
    }
  }

  /**
   * What `withhold` kept under `id`, or `undefined` if there is nothing there. `id` is checked before the file system is
   * asked anything: anything but 16 lowercase hex characters (a path, a name with an extension, a non-string) is no id, so
   * it is nothing there. A link in the place of the file isn't followed.
   */
  async withheld(id: string): Promise<string | undefined> {
    if (typeof id !== 'string' || !ID.test(id)) return undefined
    let handle: FileHandle
    try {
      handle = await open(join(this.#directory, WITHHELD, `${id}.txt`), constants.O_RDONLY | NO_FOLLOW)
    } catch (error) {
      if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ELOOP' || errorCode(error) === 'ENOTDIR') return undefined
      throw error
    }
    try {
      if (!(await handle.stat()).isFile()) return undefined
      return await handle.readFile('utf8')
    } finally {
      await handle.close()
    }
  }

  /** The days there are files for, as `yyyy-mm-dd`, newest first. A name that isn't a real day, and anything that isn't a plain file, isn't one. */
  async #days(): Promise<string[]> {
    let entries
    try {
      entries = await readdir(this.#directory, { withFileTypes: true })
    } catch (error) {
      if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') return []
      throw error
    }
    const days: string[] = []
    for (const entry of entries) {
      const day = entry.isFile() ? DAY_FILE.exec(entry.name)?.[1] : undefined
      if (day !== undefined && dayStart(day) !== undefined) days.push(day)
    }
    return days.sort().reverse()
  }

  /**
   * A page of the log, newest first, across the days.
   *
   * - **Order.** Within a day, the order the lines were written in, reversed; and the newest day first.
   * - **Paging.** `next` is an opaque cursor for the page after this one, and is there only if there is a matching line
   *   older than the last one returned. A page from it neither repeats a line nor misses one, whatever has been written
   *   since, and goes on with the older files if the one it points into is gone.
   * - **Unreadable lines** (not JSON, torn, not shaped like a line, or longer than a megabyte) are skipped. `skipped` counts
   *   those among the lines the page went through, up to its last line, so that a count is not made twice over two pages.
   * - Memory: one chunk of a file, and the page. A long file isn't read past what the page needs.
   * @throws RangeError for a `limit` that isn't a whole number from 1 to 500, or a `before` that isn't a cursor.
   */
  async read(query: ReadQuery = {}): Promise<ReadResult> {
    const limit = query.limit ?? DEFAULT_LIMIT
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw new RangeError(`limit must be a whole number from 1 to ${MAX_LIMIT}, not ${String(limit)}`)
    }
    const cursor = query.before === undefined ? undefined : decodeCursor(query.before)
    const purpose = query.purpose === undefined || (query.purpose as string) === '' ? undefined : query.purpose
    const decision = query.decision === undefined || query.decision === '' ? undefined : query.decision

    const lines: JudgeLogLine[] = []
    let skipped = 0
    let cut: { day: string, offset: number, skipped: number } | undefined
    let more = false
    const days = (await this.#days()).filter(day => cursor === undefined || day <= cursor.day)
    scan: for (const day of days) {
      const file = join(this.#directory, `${day}.jsonl`)
      // What is queued for this file is in it before it is read.
      await this.#queues.get(file)
      for await (const found of linesBackward(file, cursor?.day === day ? cursor.offset : undefined)) {
        if (found.line === undefined) {
          skipped++
          continue
        }
        const text = found.line.toString('utf8')
        if (text.trim() === '') continue
        const parsed = parseLine(text)
        if (parsed === undefined) {
          skipped++
          continue
        }
        if (purpose !== undefined && parsed.purpose !== purpose) continue
        if (decision !== undefined && parsed.decision !== decision) continue
        if (lines.length === limit) {
          more = true
          break scan
        }
        lines.push(parsed)
        if (lines.length === limit) cut = { day, offset: found.offset, skipped }
      }
    }
    if (more && cut !== undefined) return { lines, next: encodeCursor(cut.day, cut.offset), skipped: cut.skipped }
    return { lines, skipped }
  }

  /**
   * Remove the day files whose whole UTC day is more than `maxAgeMs` ago, and the withheld files last written more than
   * `maxAgeMs` ago. Gives how many of each went.
   *
   * - A day file goes when its day has ended by `now - maxAgeMs`, so one that still holds a line younger than that stays;
   * - only names that are a day file or a withheld file are touched, and only plain files: links aren't followed, and a
   *   `withheld` that is a link is left alone;
   * - a day file goes through its queue, after the writes already made to it.
   * @throws RangeError if `maxAgeMs` isn't a number that is 0 or more: `NaN` or a negative age would remove everything.
   */
  async prune(maxAgeMs: number): Promise<{ days: number, withheld: number }> {
    if (typeof maxAgeMs !== 'number' || !(maxAgeMs >= 0)) throw new RangeError(`maxAgeMs must be 0 or more, not ${String(maxAgeMs)}`)
    const cutoff = this.#now() - maxAgeMs
    const removed = { days: 0, withheld: 0 }
    for (const day of await this.#days()) {
      if (dayStart(day)! + DAY_MS > cutoff) continue
      const file = join(this.#directory, `${day}.jsonl`)
      if (await this.#serial(file, () => unlinkIfThere(file))) removed.days++
    }
    const directory = join(this.#directory, WITHHELD)
    let entries
    try {
      // `lstat`: a link to a directory is not a directory here.
      if (!(await lstat(directory)).isDirectory()) return removed
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') return removed
      throw error
    }
    for (const entry of entries) {
      if (!entry.isFile() || !WITHHELD_FILE.test(entry.name)) continue
      const file = join(directory, entry.name)
      let modified: number
      try {
        modified = (await lstat(file)).mtimeMs
      } catch (error) {
        if (errorCode(error) === 'ENOENT') continue
        throw error
      }
      if (modified < cutoff && await unlinkIfThere(file)) removed.withheld++
    }
    return removed
  }
}

/** Remove `file`. Whether it was there: another process may have taken it. */
async function unlinkIfThere(file: string): Promise<boolean> {
  try {
    await unlink(file)
    return true
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false
    throw error
  }
}
