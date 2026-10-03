/**
 * A run's ledger: one JSON entry a line, in the file `ledgerFile` names (paths.ts), written the way dish-judge writes its log
 * (`JudgeLog.write`, judge log.ts:441–487) for one file.
 *
 * - **Append-only.** This module opens a ledger only to append to it or to read it. It never takes a file away, moves
 *   one, shortens one or writes one over, and nothing here ages a ledger out: every ledger is kept for good.
 * - **Checked, masked, fitted.** Every entry passes `entryProblem` (a known kind, by its own writer), then every string in
 *   it, at any depth, goes through `maskSecrets` (keys are left alone), then its line is fitted to `MAX_LINE_BYTES` (see
 *   `fitEntry`). Masking comes before any cut, so a cut can't leave the start of a secret that no pattern would now match.
 *   A call whose entries don't all pass writes none of them.
 * - **Whole lines, in order.** Each file has one promise queue; the lines of one call go in one `appendFile`, opened
 *   `O_APPEND | O_CREAT | O_WRONLY | O_NOFOLLOW`, 0600, in directories made 0700. The first append to a file in this
 *   process, and the first after an append to it failed, starts a new line if the file's last line has no newline (the
 *   torn-line guard, judge's `endsMidLine`), so a torn line doesn't take the next one with it.
 * - **Read back whole lines only.** A line that isn't JSON, isn't shaped like an entry (`lineProblem`), or is over a
 *   megabyte is skipped and counted. A link in the place of a ledger isn't followed, for reading or appending.
 *
 * @module dish-orchestrator/ledger
 */

import { constants } from 'node:fs'
import { appendFile, mkdir, open } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { maskSecrets } from 'dish-kit'
import { BASE_FIELDS, entryProblem, lineProblem } from './entries.ts'
import type { LedgerEntry } from './entries.ts'
import { ledgerFile } from './paths.ts'
import { headOf } from './text.ts'

/** The most a line takes in its file, its newline included. */
export const MAX_LINE_BYTES = 16 * 1024
export const DEFAULT_LIMIT = 200
export const MAX_LIMIT = 500

/** A page of a ledger, newest first. */
export interface LedgerPage {
  entries: LedgerEntry[]
  /** What to pass as `before` for the page after this one: there only when an older line exists. */
  next?: string
  /** How many unreadable lines the page went through. */
  skipped: number
}

type FileHandle = Awaited<ReturnType<typeof open>>
type Json = string | number | boolean | null | Json[] | { [key: string]: Json }
type JsonObject = { [key: string]: Json }

/** How much of a file a read takes at a time. */
const READ_CHUNK = 64 * 1024
/** Longer than this is never a line of ours. It is skipped without being kept in memory. */
const MAX_READ_LINE_BYTES = 1024 * 1024
/** A string the fit cuts is cut to no fewer characters than this (then `…`). */
const KEEP_CHARS = 64
const CUT_MARK = '…'
/** Files are opened without following a link in the last place of the path: a link there isn't one of ours. */
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0
const APPEND_FLAGS = constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | NO_FOLLOW

function errorCode(error: unknown): unknown {
  return (error as { code?: unknown } | null)?.code
}

function isJsonObject(value: Json): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** How many bytes `value` takes as JSON. */
function jsonBytes(value: Json): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

/** `value` with every string in it masked, at any depth. Keys are left alone. */
function masked(value: Json): Json {
  if (typeof value === 'string') return maskSecrets(value)
  if (Array.isArray(value)) return value.map(masked)
  if (isJsonObject(value)) {
    const result: JsonObject = {}
    for (const [key, item] of Object.entries(value)) result[key] = masked(item)
    return result
  }
  return value
}

/** A binary heap: `before(a, b)` is true when `a` comes out first. */
class Heap<T> {
  readonly #items: T[] = []
  readonly #before: (a: T, b: T) => boolean

  constructor(before: (a: T, b: T) => boolean) {
    this.#before = before
  }

  get size(): number {
    return this.#items.length
  }

  push(item: T): void {
    const items = this.#items
    items.push(item)
    let index = items.length - 1
    while (index > 0) {
      const parent = (index - 1) >> 1
      if (!this.#before(items[index]!, items[parent]!)) break
      ;[items[index], items[parent]] = [items[parent]!, items[index]!]
      index = parent
    }
  }

  pop(): T | undefined {
    const items = this.#items
    const top = items[0]
    const last = items.pop()
    if (items.length > 0 && last !== undefined) {
      items[0] = last
      let index = 0
      for (;;) {
        const left = index * 2 + 1
        const right = left + 1
        let first = index
        if (left < items.length && this.#before(items[left]!, items[first]!)) first = left
        if (right < items.length && this.#before(items[right]!, items[first]!)) first = right
        if (first === index) break
        ;[items[index], items[first]] = [items[first]!, items[index]!]
        index = first
      }
    }
    return top
  }
}

/** Where a string or an array sits in an entry: `holder[key]`. `order` is its place in a depth-first walk, for ties. */
interface Slot {
  holder: JsonObject | Json[]
  key: string | number
  order: number
  /** The length it had when it was queued: characters for a string, items for an array. */
  length: number
}

/**
 * Every string and every array inside `holder` (not `holder` itself), depth first, in key order, leaving out `holder`'s own
 * fields named in `skip`.
 */
function walk(holder: JsonObject | Json[], found: { strings: Slot[], arrays: Slot[] }, counter: { next: number }, skip: readonly string[] = []): void {
  const visit = (key: string | number, item: Json): void => {
    if (typeof item === 'string') {
      found.strings.push({ holder, key, order: counter.next++, length: item.length })
    } else if (Array.isArray(item)) {
      found.arrays.push({ holder, key, order: counter.next++, length: item.length })
      walk(item, found, counter)
    } else if (isJsonObject(item)) {
      walk(item, found, counter)
    }
  }
  if (Array.isArray(holder)) {
    holder.forEach((item, index) => { visit(index, item) })
  } else {
    for (const [key, item] of Object.entries(holder)) if (!skip.includes(key)) visit(key, item)
  }
}

function read(slot: Slot): Json | undefined {
  return (slot.holder as Record<string | number, Json | undefined>)[slot.key]
}

function put(slot: Slot, value: Json): void {
  (slot.holder as Record<string | number, Json>)[slot.key] = value
}

/** The longest first; of two as long, the one met first. */
function longestFirst(a: Slot, b: Slot): boolean {
  return a.length > b.length || (a.length === b.length && a.order < b.order)
}

/**
 * `entry`'s line, within `MAX_LINE_BYTES` with its newline, and the entry as the line holds it. Deterministic:
 *
 * 1. If the JSON and its newline fit, it is written as it is.
 * 2. Otherwise the entry gets `cut: true`, and the longest string anywhere outside the base fields is cut to
 *    `max(64, half its length)` characters, plus `…`; again while the line is too long and some such string is longer
 *    than a cut would leave it (65 characters with the mark).
 * 3. Then the longest array outside the base fields loses its last item, again while the line is too long.
 *
 * The base fields (`at`, `run`, `kind`, `by`, `session`, `child`, `task`) are never cut. The size is kept as it goes,
 * from what each cut takes off, so a line with thousands of strings is fitted without writing it out each time.
 * @throws RangeError if it still doesn't fit.
 */
function fitEntry(entry: JsonObject): { line: string, entry: JsonObject } {
  let bytes = jsonBytes(entry) + 1
  if (bytes <= MAX_LINE_BYTES) return { line: JSON.stringify(entry), entry }
  if (entry.cut !== true) {
    entry.cut = true
    bytes = jsonBytes(entry) + 1
  }
  const strings: Slot[] = []
  const arrays: Slot[] = []
  walk(entry, { strings, arrays }, { next: 0 }, BASE_FIELDS)

  const longStrings = new Heap<Slot>(longestFirst)
  for (const slot of strings) longStrings.push(slot)
  while (bytes > MAX_LINE_BYTES && longStrings.size > 0) {
    const slot = longStrings.pop()!
    const text = read(slot) as string
    const keep = Math.max(KEEP_CHARS, Math.floor(text.length / 2))
    // The longest is no longer than a cut leaves: nothing else would get shorter either.
    if (text.length <= keep + CUT_MARK.length) break
    const shorter = headOf(text, keep) + CUT_MARK
    bytes += jsonBytes(shorter) - jsonBytes(text)
    put(slot, shorter)
    longStrings.push({ ...slot, length: shorter.length })
  }

  const longArrays = new Heap<Slot>(longestFirst)
  for (const slot of arrays) longArrays.push(slot)
  /** Arrays that went with an item taken off another: they are no longer in the line. */
  const gone = new Set<Json[]>()
  while (bytes > MAX_LINE_BYTES && longArrays.size > 0) {
    const slot = longArrays.pop()!
    const list = read(slot)
    // An array inside an item taken off before: it went with it.
    if (!Array.isArray(list) || gone.has(list)) continue
    if (list.length === 0) break
    const last = list.pop()!
    bytes -= jsonBytes(last) + (list.length > 0 ? 1 : 0)
    if (Array.isArray(last)) gone.add(last)
    if (Array.isArray(last) || isJsonObject(last)) {
      const inner = { strings: [] as Slot[], arrays: [] as Slot[] }
      walk(last, inner, { next: 0 })
      for (const item of inner.arrays) gone.add(read(item) as Json[])
    }
    if (list.length > 0) longArrays.push({ ...slot, length: list.length })
  }

  const line = JSON.stringify(entry)
  if (Buffer.byteLength(line, 'utf8') + 1 > MAX_LINE_BYTES) {
    throw new RangeError(`a ledger line of kind ${String(entry.kind)} is over ${MAX_LINE_BYTES} bytes even with its text and lists cut: its base fields are too long`)
  }
  return { line, entry }
}

/**
 * The lines to append for `entries` to the ledger of run `id`, and the entries as written: each checked, made plain JSON,
 * masked and fitted.
 * @throws TypeError for an entry `entryProblem` refuses or that names another run; RangeError for one that can't fit.
 */
function prepare(id: string, entries: readonly LedgerEntry[]): { text: string, written: LedgerEntry[] } {
  const lines: string[] = []
  const written: LedgerEntry[] = []
  for (const entry of entries) {
    const problem = entryProblem(entry)
    if (problem !== undefined) throw new TypeError(`not a ledger entry: ${problem}`)
    if (entry.run !== id) throw new TypeError(`an entry of run ${JSON.stringify(entry.run)} doesn't go in the ledger of run ${id}`)
    let plain: Json
    try {
      plain = JSON.parse(JSON.stringify(entry)) as Json
    } catch (error) {
      throw new TypeError(`not a ledger entry: it isn't plain JSON (${error instanceof Error ? error.message : String(error)})`)
    }
    const fitted = fitEntry(masked(plain) as JsonObject)
    lines.push(fitted.line)
    written.push(fitted.entry as unknown as LedgerEntry)
  }
  return { text: lines.map(line => `${line}\n`).join(''), written }
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
 * The non-empty lines of `file` that start before byte `end` (the end of the file if there's none), last first (judge's
 * `linesBackward`, log.ts:325–373, copied). Reads the file backward in `READ_CHUNK`s, so it holds a chunk and the line
 * being put together, and stops reading when its caller stops asking. A file that isn't there, or is a link, has none.
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

/** Whether `file` is there, isn't empty and doesn't end with a newline. Best effort: a file that can't be read is taken to be fine. */
async function endsMidLine(file: string): Promise<boolean> {
  let handle: FileHandle | undefined
  try {
    handle = await open(file, constants.O_RDONLY | NO_FOLLOW)
    const { size } = await handle.stat()
    if (size === 0) return false
    const last = Buffer.alloc(1)
    const { bytesRead } = await handle.read(last, 0, 1, size - 1)
    return bytesRead === 1 && last[0] !== 0x0a
  } catch {
    return false
  } finally {
    await handle?.close().catch(() => {})
  }
}

/** The entry on a line, or `undefined` for a line that isn't one (not JSON, or not shaped like an entry). */
function parseLine(line: Buffer): LedgerEntry | undefined | null {
  const text = line.toString('utf8')
  if (text.trim() === '') return null
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  return lineProblem(value) === undefined ? value as LedgerEntry : undefined
}

function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64url')
}

/** @throws RangeError if `cursor` isn't one `read` gave. */
function decodeCursor(cursor: unknown): number {
  const decoded = typeof cursor === 'string' && /^[A-Za-z0-9_-]+$/.test(cursor) ? Buffer.from(cursor, 'base64url').toString('utf8') : ''
  if (!/^\d{1,15}$/.test(decoded)) throw new RangeError('before must be the next of a page that read gave')
  return Number(decoded)
}

/** Every run's ledger under one data directory. It needn't exist yet: the first append creates what it needs. */
export class Ledger {
  readonly #data: string
  /** The tail of each file's queue, until it's done. */
  readonly #queues = new Map<string, Promise<void>>()
  /**
   * The files this process has appended to, and so has checked for a torn last line. A file leaves the set when an append
   * to it fails, since that append may have written part of its line.
   */
  readonly #tidy = new Set<string>()

  /** @param data - dish's data directory (`xdgPaths('dish').data`). Made absolute. */
  constructor(data: string) {
    this.#data = resolve(data)
  }

  /** `ledgerFile(data, …)`. @throws TypeError for a project or id `ledgerFile` refuses. */
  file(project: string, id: string): string {
    return ledgerFile(this.#data, project, id)
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

  /** Append `text` to `file`. Call it inside the file's queue. */
  async #append(file: string, text: string): Promise<void> {
    if (text === '') return
    // The first append to a file in this process, or the first after one that failed: if the file's last line was torn off
    // (a crash in the middle of an append, or an append that wrote part of its line and then failed), this line would be
    // glued on to it and both would be lost. A newline first leaves the torn one on its own.
    const first = !this.#tidy.has(file)
    const written = first && await endsMidLine(file) ? `\n${text}` : text
    if (first) this.#tidy.add(file)
    // O_NOFOLLOW: a link in the place of a ledger is not ours to write through.
    const options = { mode: 0o600, flag: APPEND_FLAGS }
    try {
      await appendFile(file, written, options).catch(async (error: unknown) => {
        if (errorCode(error) !== 'ENOENT') throw error
        await mkdir(dirname(file), { recursive: true, mode: 0o700 })
        await appendFile(file, written, options)
      })
    } catch (error) {
      // A short write and then ENOSPC, say: what was written of the line is left, so the next append checks again.
      this.#tidy.delete(file)
      throw error
    }
  }

  /** The file's entries now, oldest first, and how many lines were skipped. Reads directly: it doesn't wait for the queue. */
  async #readAll(file: string): Promise<{ entries: LedgerEntry[], skipped: number }> {
    const entries: LedgerEntry[] = []
    let skipped = 0
    for await (const found of linesBackward(file, undefined)) {
      const entry = found.line === undefined ? undefined : parseLine(found.line)
      if (entry === null) continue
      if (entry === undefined) skipped++
      else entries.push(entry)
    }
    return { entries: entries.reverse(), skipped }
  }

  /**
   * Append in order, masked and cut to fit; gives what was written. The call is queued before it returns, so a caller that
   * reads the ledger after it, without awaiting it, still finds it.
   * @throws TypeError (entryProblem, or an entry of another run), RangeError (can't fit); nothing of the call is written then.
   */
  async append(project: string, id: string, entries: LedgerEntry | readonly LedgerEntry[]): Promise<LedgerEntry[]> {
    const file = this.file(project, id)
    const { text, written } = prepare(id, Array.isArray(entries) ? entries as readonly LedgerEntry[] : [entries as LedgerEntry])
    return this.#serial(file, async () => {
      await this.#append(file, text)
      return written
    })
  }

  /**
   * In the file's queue: `build` gets `current()` (the file's entries now, oldest first, read directly) and returns what to
   * append. For a decision that rests on what is in the file (a round). Never call `entries`/`read` inside `build`: they
   * wait for this queue. A `build` that throws, or gives an entry `append` would refuse, writes nothing.
   */
  async appendWith(project: string, id: string, build: (current: () => Promise<LedgerEntry[]>) => Promise<readonly LedgerEntry[]>): Promise<LedgerEntry[]> {
    const file = this.file(project, id)
    return this.#serial(file, async () => {
      const built = await build(async () => (await this.#readAll(file)).entries)
      const { text, written } = prepare(id, built)
      await this.#append(file, text)
      return written
    })
  }

  /** Every entry, oldest first, once what is queued for the file now is written. A missing file has none. */
  async entries(project: string, id: string): Promise<{ entries: LedgerEntry[], skipped: number }> {
    const file = this.file(project, id)
    await this.#queues.get(file)
    return this.#readAll(file)
  }

  /**
   * A page, newest first (judge's `read`, for one file). `before` is the `next` of the page before; `''` is the newest.
   * `next` is there only when an older line exists. `skipped` counts the unreadable lines the page went through, up to its
   * last line.
   * @throws RangeError for a limit outside 1–500 or a `before` that isn't a cursor.
   */
  async read(project: string, id: string, query: { limit?: number, before?: string } = {}): Promise<LedgerPage> {
    const limit = query.limit ?? DEFAULT_LIMIT
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw new RangeError(`limit must be a whole number from 1 to ${MAX_LIMIT}, not ${String(limit)}`)
    }
    const end = query.before === undefined || query.before === '' ? undefined : decodeCursor(query.before)
    const file = this.file(project, id)
    await this.#queues.get(file)
    const entries: LedgerEntry[] = []
    let skipped = 0
    let cut: { offset: number, skipped: number } | undefined
    let more = false
    for await (const found of linesBackward(file, end)) {
      const entry = found.line === undefined ? undefined : parseLine(found.line)
      if (entry === null) continue
      if (entry === undefined) {
        skipped++
        continue
      }
      if (entries.length === limit) {
        more = true
        break
      }
      entries.push(entry)
      if (entries.length === limit) cut = { offset: found.offset, skipped }
    }
    if (more && cut !== undefined) return { entries, next: encodeCursor(cut.offset), skipped: cut.skipped }
    return { entries, skipped }
  }

  /**
   * Resolve once every append that is queued now is done: the tails of the queues are taken once, so appends that come after
   * the call are not waited for. For a shutdown, and for a test. Never rejects.
   */
  async flush(): Promise<void> {
    await Promise.all([...this.#queues.values()])
  }
}
