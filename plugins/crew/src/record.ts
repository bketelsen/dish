/**
 * The crew's own record: what was delegated in each session, and every run's closing message as a file.
 *
 * The session log can't hold custom events (see the spec), so crew keeps this itself, under one directory:
 *
 * - `sessions/<sha256 of the parent session id>/children.json` lists the session's children (see `ChildRecord`). It is
 *   the source for the limits, the reviewer rule and the finish notices;
 * - `sessions/<hash>/<n>-<role>-<run>.md` is the closing message of one run of one child, where `n` is the child's
 *   order in the session;
 * - `by-child/<sha256 of the child id>` holds the hash of the session its child belongs to. `subagent/end` and
 *   `agent/error` know only the child, and after a restart nothing in memory says whose it is, so this is how a run
 *   is filed.
 *
 * Ids and roles are outside input and can hold anything, so no id is ever a path: a session or a child is named by
 * the hash of its id, and a role in a report's name is cut down to letters, digits, `_` and `-`.
 *
 * Writing (the rules `dish-prompts` keeps for its snapshots, in `snapshots.ts`, apply here):
 *
 * - every file is written atomically and durably: a temp file in the same directory, synced, renamed over the
 *   target, and then the directory synced (that last step best effort). A reader sees the old file or the new one,
 *   and a crash leaves at worst a temp file. Directories are mode 0o700 and files 0o600;
 * - everything that touches one session's `children.json` (a read as well, because a read can set a corrupt file
 *   aside) goes through that session's queue, so two writes can't read the same file and each drop the other's
 *   change. Sessions don't wait for each other;
 * - a report is written before the run that names it, and a child's pointer before the child, so what a crash
 *   leaves is an orphan file and never a record of something that isn't there. A report never replaces another
 *   file: if its name is taken (the numbering started again after a corrupt `children.json`), it gets a suffix.
 *
 * Another dsh process can use the same directory (`dsh plugin add` and `--dump-config` start plugins, and a restart can
 * overlap the process before it), and the queue is in memory. Each file is still replaced whole, so none is ever torn;
 * what two processes writing the same session at once can do is lose one's change. The crew's children run in one
 * process, so that doesn't happen in use.
 *
 * What is read back is checked. A `children.json` that doesn't parse, or has an entry that isn't shaped like a child,
 * is corrupt: it is renamed to `children.json.corrupt-<time>` (so nothing is lost and nothing is read twice), the
 * caller is told through `onCorrupt`, and the session starts a new record, so its count starts again. Nothing here logs;
 * an I/O error other than a missing file is thrown.
 *
 * `startRun`, `endRun` and the lookups take what events give them, so they never throw because of what they were given: a child
 * nobody recorded is `undefined`, and a stop reason or a closing message of the wrong type is made into text.
 *
 * Gate results (`GateResult`, 6c). dish-gates gates a coder bound to a worktree when its turn is about to end, and records
 * each result with `addGate`. A run has no entry in `runs` until it ends, so the results of the run in progress sit on the
 * child (`ChildRecord.gates`), and `endRun` moves them onto the run it files (`RunRecord.gates`): the next run starts with
 * none. That they land on the right run rests on an order dsh keeps, not on anything here. dish-gates awaits `addGate` inside
 * `agent/turn-stopping`, which dsh-agent-loop awaits (`dispatch.serial`) before the turn can close; the run's
 * `subagent/end`, whose listener calls `endRun`, comes only after the turn has closed. So a run's last result is written,
 * through the session's queue, before `endRun` for that run is even called, and a result recorded after a run ended is the
 * next run's. A reviewer's ruling to review work whose gate hadn't passed is kept on the reviewer as `gateOverride`.
 *
 * `prune` removes sessions nothing has written to for a while, with their pointers; see there for the rules.
 *
 * @module dish-crew/record
 */
import { createHash, randomBytes } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { lstat, mkdir, open, readdir, readFile, rename, rm, stat, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import type { SubagentStopReason } from '@deepseek-ai/dsh-subagent'

/** Where a child is in its work, as of its latest run. */
export type ChildStatus = 'running' | 'finished' | 'failed' | 'stopped'

/**
 * How a gate ended: the gate `passed` (exit 0) or `failed`; it was `skipped` (the coder opted out, or there was nothing to
 * gate: the worktree is gone, or its project isn't registered); or it couldn't run (`error`).
 */
export type GateOutcome = 'passed' | 'failed' | 'skipped' | 'error'

/** Every `GateOutcome`, in that order. */
export const GATE_OUTCOMES: readonly GateOutcome[] = Object.freeze(['passed', 'failed', 'skipped', 'error'] as const)

/** One gate run for a bound coder, or why none ran, as dish-gates records it. */
export interface GateResult {
  /** The dsh turn of the child's session whose end it gated: rounds are counted per turn. */
  turn: number
  /** 1 + the failures already recorded for this turn. */
  round: number
  /** dish-gates' `maxRounds` when it was recorded. */
  maxRounds: number
  outcome: GateOutcome
  /** The gate as it ran; `''` when none ran. */
  command: string
  exitCode: number | null
  timedOut: boolean
  durationMs: number
  /** The log's absolute path, or `null` when there is none. */
  log: string | null
  /** The output's last lines (at most 10 lines and 1000 characters), masked; `''` when there is none. */
  excerpt: string
  /** For `skipped` and `error`: why, on one line. */
  reason?: string
  /** When it was recorded, in ms since the epoch. */
  at: number
}

/** One run of a child: from a delegation or a follow-up to the child's next stop. */
export interface RunRecord {
  /** When the run ended, in ms since the epoch. */
  endedAt: number
  /** The raw stop reason dsh gave: `completed`, `error`, and so on. */
  stopReason: string
  /** The last error the child's agent reported during the run, if any. */
  error?: string
  /** The absolute path of the report: the run's closing message. */
  report: string
  /** The gate results recorded during the run, oldest first. Absent when there were none. */
  gates?: GateResult[]
}

/** What is kept for a child. */
export interface ChildRecord {
  /** The child's agent (session) id. */
  id: string
  /** The child's order in its session, from 1. */
  n: number
  role: string
  title: string
  model: string
  /** The model's family, as it was when the child started. */
  family: string
  /** For a reviewer: the id of the crew child it reviews, or `"main"` for the main agent's own work. */
  reviews?: string
  /**
   * For a child bound to a worktree (`delegate`'s `worktree`): the worktree's absolute, canonical path. Absent for an unbound
   * child. A follow-up keeps it, and dish-gates (6c) reads it here, through `lookup`.
   */
  worktree?: string
  /**
   * For a reviewer: the main agent's ruling to review work whose gate hadn't passed (`delegate`'s `gateOverride`). A
   * follow-up's ruling replaces it.
   */
  gateOverride?: string
  /** When the child was recorded, in ms since the epoch. */
  startedAt: number
  /** How many follow-ups it has been sent. */
  followUps: number
  runs: RunRecord[]
  /** The gate results of the run in progress, oldest first; `endRun` moves them onto the run. Absent when there are none. */
  gates?: GateResult[]
  /** The status after the latest run: `running` from the start, from a follow-up or from a wake, until the run ends. */
  last: ChildStatus
}

/** What `addChild` is given; the rest of a `ChildRecord` is the record's to set. */
export interface NewChild {
  id: string
  role: string
  title: string
  model: string
  family: string
  reviews?: string
  /** The worktree the child is bound to: an absolute path, canonical (the caller's `realpath`). */
  worktree?: string
  /** For a reviewer: the main agent's ruling to review work whose gate hadn't passed. */
  gateOverride?: string
  /** Defaults to now. */
  startedAt?: number
}

/** What a run's end is: dsh's stop reason, the error the child reported, and its closing message. */
export interface RunEnd {
  stopReason: string
  error?: string
  /** The text of the child's final message, or `''` if it left none. */
  closing: string
}

/** What `endRun` gives: where the run's report was written. */
export interface EndedRun {
  report: string
}

/**
 * The status a run's stop reason gives its child. Every reason dsh 0.2.0-rc.2 has is here: the object is checked
 * against `SubagentStopReason`, so a build that gains one doesn't compile until it is placed.
 *
 * - `completed` is a turn that ended normally: finished;
 * - `aborted` is a run that was cancelled or disposed: stopped;
 * - `error` is a model or transport failure, and `refusal` is a child that declined the task: failed;
 * - `max-tokens` is a child that hit its token ceiling with the work unfinished: stopped. It can be continued with a
 *   follow-up, which a failure usually can't.
 */
export const STOP_REASON_STATUS = {
  completed: 'finished',
  aborted: 'stopped',
  error: 'failed',
  'max-tokens': 'stopped',
  refusal: 'failed',
} as const satisfies Record<SubagentStopReason, Exclude<ChildStatus, 'running'>>

/**
 * The status a stop reason gives. A reason that isn't one of dsh's (the type is merge-extensible, so a backend can add
 * one, and an event can be malformed) is stopped: the child isn't running, and nothing says it succeeded. The run keeps the
 * raw reason, so the notice can still say what it was.
 */
export function statusFor(stopReason: string): Exclude<ChildStatus, 'running'> {
  return Object.hasOwn(STOP_REASON_STATUS, stopReason) ? STOP_REASON_STATUS[stopReason as SubagentStopReason] : 'stopped'
}

/** What the running rule needs of dsh's agent registry (`ctx.agents`): the live agent of an id, if there is one. */
export interface LiveAgents {
  get(id: string): { status?: unknown } | undefined
}

/**
 * Whether a recorded child is running: its agent is stepping, or the record says running and the agent exists (accepted,
 * not stepping yet). A record that says running with no agent is a crash's, and isn't running. With no registry to ask,
 * the record's own word. `delegate`'s limits and `dishCrew.worktreeBindings` both count by this.
 */
export function isRunning(record: ChildRecord, agents: LiveAgents | undefined): boolean {
  if (agents === undefined) return record.last === 'running'
  const live = agents.get(record.id)
  return live?.status === 'running' || (record.last === 'running' && live !== undefined)
}

/**
 * How long a temp file must have been there before `prune` takes it for a crashed write's. A write's temp file lives for
 * milliseconds, so this is far longer than it needs, and it is how long a session with one is kept whatever its age.
 */
export const TEMP_GRACE_MS = 60 * 60 * 1000

/** The text of a report for a run that left no closing message. */
const NO_CLOSING = '(no closing message)'

/**
 * The closing message of a run as text: the text blocks of the child's final message that have something in them (a block
 * of blanks is dropped, and the others are kept whole), joined by a blank line. `''` if there are none or `blocks` isn't a
 * list. What `subagent/end` is recorded from, and what a finish notice is matched to a report by (`notice.ts`): one rule,
 * here, so that the two can't drift.
 */
export function closingOf(blocks: unknown): string {
  if (!Array.isArray(blocks)) return ''
  const texts: string[] = []
  for (const block of blocks) {
    if (isObject(block) && block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') texts.push(block.text)
  }
  return texts.join('\n\n')
}

/**
 * What a report file holds for a run whose closing message is `closing`: the text, or a line that says there is none if it
 * is blank, and a newline at the end if it has none. `endRun` writes it, and `notice.ts` compares a report to it.
 */
export function reportContent(closing: string): string {
  const text = closing.trim() === '' ? NO_CLOSING : closing
  return text.endsWith('\n') ? text : `${text}\n`
}

/** A session's directory name, and the content of a pointer: 64 hex digits. */
const HASH = /^[0-9a-f]{64}$/
/** A temp file the writes here leave: a dot, the target's name, 16 random hex digits, and `.tmp`. */
const TEMP_FILE = /^\..+\.[0-9a-f]{16}\.tmp$/
const SESSIONS = 'sessions'
const BY_CHILD = 'by-child'
const CHILDREN_FILE = 'children.json'

/** `error`'s errno code, if it has one. */
function errorCode(error: unknown): unknown {
  return (error as { code?: unknown } | null)?.code
}

function hashOf(id: string): string {
  return createHash('sha256').update(id).digest('hex')
}

function isText(value: unknown): value is string {
  return typeof value === 'string'
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A role as part of a file name: nothing but letters, digits, `_` and `-`. */
function fileSafe(role: string): string {
  return role.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64)
}

/** A whole number, 1 or more. */
function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1
}

/** What is wrong with `value` as a `GateResult`, or `undefined` if nothing is. Fields it doesn't know are not its concern. */
export function gateProblem(value: unknown): string | undefined {
  if (!isObject(value)) return 'it is not an object'
  for (const field of ['turn', 'round', 'maxRounds'] as const) {
    if (!isCount(value[field])) return `${field} must be a whole number, 1 or more`
  }
  if (!isText(value.outcome) || !GATE_OUTCOMES.includes(value.outcome as GateOutcome)) return `outcome must be one of ${GATE_OUTCOMES.join(', ')}`
  if (!isText(value.command)) return 'command must be a string'
  if (value.exitCode !== null && !Number.isInteger(value.exitCode)) return 'exitCode must be a whole number or null'
  if (typeof value.timedOut !== 'boolean') return 'timedOut must be true or false'
  if (!isNumber(value.durationMs)) return 'durationMs must be a finite number'
  if (value.log !== null && !isText(value.log)) return 'log must be a string or null'
  if (!isText(value.excerpt)) return 'excerpt must be a string'
  if (value.reason !== undefined && !isText(value.reason)) return 'reason must be a string when it is given'
  if (!isNumber(value.at)) return 'at must be a finite number'
  return undefined
}

/** The gate result in `value` as a new object of its own fields, or `undefined` if `gateProblem` refuses it. */
function parseGate(value: unknown): GateResult | undefined {
  if (gateProblem(value) !== undefined) return undefined
  const { turn, round, maxRounds, outcome, command, exitCode, timedOut, durationMs, log, excerpt, reason, at } = value as GateResult
  return { turn, round, maxRounds, outcome, command, exitCode, timedOut, durationMs, log, excerpt, ...reason === undefined ? {} : { reason }, at }
}

/** The gate results in `value`, each as `parseGate` makes it, or `undefined` if it isn't a list or one of them isn't a result. */
function parseGates(value: unknown): GateResult[] | undefined {
  if (!Array.isArray(value)) return undefined
  const parsed: GateResult[] = []
  for (const item of value) {
    const one = parseGate(item)
    if (one === undefined) return undefined
    parsed.push(one)
  }
  return parsed
}

/**
 * The newest gate result of `record`: the run in progress's last, else its latest run's last; `undefined` if neither has
 * one. An older run's result is never the latest run's.
 */
export function latestGate(record: ChildRecord): GateResult | undefined {
  return record.gates?.at(-1) ?? record.runs.at(-1)?.gates?.at(-1)
}

/** The run in `value`, or `undefined` if it isn't shaped like one. Other fields are dropped. */
function parseRun(value: unknown): RunRecord | undefined {
  if (!isObject(value)) return undefined
  const { endedAt, stopReason, error, report, gates } = value
  if (!isNumber(endedAt) || !isText(stopReason) || !isText(report)) return undefined
  if (error !== undefined && !isText(error)) return undefined
  const parsedGates = gates === undefined ? undefined : parseGates(gates)
  if (gates !== undefined && parsedGates === undefined) return undefined
  return { endedAt, stopReason, ...error === undefined ? {} : { error }, report, ...parsedGates === undefined ? {} : { gates: parsedGates } }
}

/** The child in `value`, or `undefined` if it isn't shaped like one. Other fields are dropped. */
function parseChild(value: unknown): ChildRecord | undefined {
  if (!isObject(value)) return undefined
  const { id, n, role, title, model, family, reviews, worktree, gateOverride, startedAt, followUps, runs, gates, last } = value
  if (!isText(id) || id === '' || !isNumber(n) || !isText(role) || !isText(title) || !isText(model) || !isText(family)) return undefined
  if (reviews !== undefined && !isText(reviews)) return undefined
  if (worktree !== undefined && !isText(worktree)) return undefined
  if (gateOverride !== undefined && !isText(gateOverride)) return undefined
  if (!isNumber(startedAt) || !isNumber(followUps) || !Array.isArray(runs)) return undefined
  if (!isText(last) || !['running', 'finished', 'failed', 'stopped'].includes(last)) return undefined
  const parsed: RunRecord[] = []
  for (const run of runs) {
    const one = parseRun(run)
    if (one === undefined) return undefined
    parsed.push(one)
  }
  const parsedGates = gates === undefined ? undefined : parseGates(gates)
  if (gates !== undefined && parsedGates === undefined) return undefined
  return {
    id, n, role, title, model, family, ...reviews === undefined ? {} : { reviews }, ...worktree === undefined ? {} : { worktree },
    ...gateOverride === undefined ? {} : { gateOverride },
    startedAt, followUps, runs: parsed, ...parsedGates === undefined ? {} : { gates: parsedGates }, last: last as ChildStatus,
  }
}

/** A session's `children.json`, once it is read. */
interface Loaded {
  sessionId: string
  children: ChildRecord[]
}

/** The file in `text`, or `undefined` if it isn't JSON, isn't shaped like one, or isn't the file of the session `hash` names. */
function parseFile(text: string, hash: string): Loaded | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isObject(value)) return undefined
  const { sessionId, children } = value
  if (!isText(sessionId) || hashOf(sessionId) !== hash || !Array.isArray(children)) return undefined
  const parsed: ChildRecord[] = []
  for (const child of children) {
    const one = parseChild(child)
    if (one === undefined) return undefined
    parsed.push(one)
  }
  return { sessionId, children: parsed }
}

/** What is wrong with `value` as a `NewChild`, or `undefined` if nothing is. */
function newChildProblem(value: unknown): string | undefined {
  if (!isObject(value)) return 'it is not an object'
  for (const field of ['id', 'role', 'model', 'family'] as const) {
    if (!isText(value[field]) || value[field] === '') return `${field} must be a non-empty string`
  }
  if (!isText(value.title)) return 'title must be a string'
  if (value.reviews !== undefined && !isText(value.reviews)) return 'reviews must be a string'
  if (value.worktree !== undefined && !(isText(value.worktree) && isAbsolute(value.worktree))) return 'worktree must be an absolute path'
  if (value.gateOverride !== undefined && !isText(value.gateOverride)) return 'gateOverride must be a string'
  if (value.startedAt !== undefined && !isNumber(value.startedAt)) return 'startedAt must be a finite number'
  return undefined
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

/**
 * Write `text` as `file`, replacing any: a temp file in the same directory, synced, then renamed over it, then the
 * directory synced. The directory is created (mode 0o700) if it isn't there; the file is mode 0o600.
 */
async function writeAtomic(file: string, text: string): Promise<void> {
  const directory = dirname(file)
  const temp = join(directory, `.${basename(file)}.${randomBytes(8).toString('hex')}.tmp`)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  // Outside the try: if `open` fails nothing of ours was created (on EEXIST the file isn't ours to remove).
  const handle = await open(temp, 'wx', 0o600)
  try {
    try {
      await handle.writeFile(text)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temp, file)
  } catch (error) {
    await unlink(temp).catch(() => {})
    throw error
  }
  await syncDirectory(directory)
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false
    throw error
  }
}

/** The records of the crew's children, in one directory. It needn't exist yet: the first write creates it. */
export class CrewRecords {
  readonly #directory: string
  readonly #onCorrupt: (session: string, path: string) => void
  /** The tail of each session's queue, until it's done. */
  readonly #queues = new Map<string, Promise<void>>()

  /**
   * @param directory - where the records are kept. Made absolute.
   * @param onCorrupt - told when a session's `children.json` was found corrupt and set aside, with the parent session's
   * id and where the file went, so the caller can log it. A lookup by child id knows only the session's directory
   * name (its hash), and that is what it passes. A callback that throws is ignored.
   */
  constructor(directory: string, onCorrupt: (session: string, path: string) => void = () => {}) {
    this.#directory = resolve(directory)
    this.#onCorrupt = onCorrupt
  }

  #sessionDirectory(hash: string): string {
    return join(this.#directory, SESSIONS, hash)
  }

  #pointerFile(childId: string): string {
    return join(this.#directory, BY_CHILD, hashOf(childId))
  }

  /** Run `job` after what is queued for session `hash`, whether that worked or not, and give what it gives. */
  #serial<T>(hash: string, job: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(hash) ?? Promise.resolve()
    const run = previous.then(job)
    const tail = run.then(() => {}, () => {})
    this.#queues.set(hash, tail)
    void tail.then(() => {
      if (this.#queues.get(hash) === tail) this.#queues.delete(hash)
    })
    return run
  }

  /**
   * The session `hash`'s file, or `undefined` if it has none. A file that is corrupt is set aside, `onCorrupt` is told
   * (under `sessionId` if the caller knows it), and the result is `undefined`, as if it had never been written.
   * Call it inside the session's queue.
   */
  async #load(hash: string, sessionId?: string): Promise<Loaded | undefined> {
    const file = join(this.#sessionDirectory(hash), CHILDREN_FILE)
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return undefined
      throw error
    }
    const loaded = parseFile(text, hash)
    if (loaded !== undefined) return loaded
    const aside = `${file}.corrupt-${Date.now()}`
    await rename(file, aside)
    try {
      this.#onCorrupt(sessionId ?? hash, aside)
    } catch {
      // The record carries on; a caller whose logger broke can't ask it to stop.
    }
    return undefined
  }

  /** Write `loaded` as its session's file. Call it inside the session's queue. */
  async #save(hash: string, loaded: Loaded): Promise<void> {
    await writeAtomic(join(this.#sessionDirectory(hash), CHILDREN_FILE), `${JSON.stringify(loaded, null, 2)}\n`)
  }

  /** The hash of the session `childId` belongs to, or `undefined` if no pointer says. */
  async #sessionOf(childId: unknown): Promise<string | undefined> {
    if (!isText(childId) || childId === '') return undefined
    let text: string
    try {
      text = await readFile(this.#pointerFile(childId), 'utf8')
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return undefined
      throw error
    }
    const hash = text.trim()
    return HASH.test(hash) ? hash : undefined
  }

  /**
   * Run `change` on the child `childId` in its session's file, in the session's queue, and save the file if `change`
   * says (by returning something other than `undefined`) that it changed. Gives what `change` gives, or `undefined`
   * if the child isn't recorded.
   */
  async #update<T>(childId: unknown, change: (child: ChildRecord, hash: string) => Promise<T | undefined>): Promise<T | undefined> {
    const hash = await this.#sessionOf(childId)
    if (hash === undefined) return undefined
    return this.#serial(hash, async () => {
      const loaded = await this.#load(hash)
      const child = loaded?.children.find(candidate => candidate.id === childId)
      if (loaded === undefined || child === undefined) return undefined
      const result = await change(child, hash)
      if (result !== undefined) await this.#save(hash, loaded)
      return result
    })
  }

  /** The children `sessionId` has started, in the order they were started. */
  async children(sessionId: string): Promise<ChildRecord[]> {
    if (!isText(sessionId) || sessionId === '') return []
    const hash = hashOf(sessionId)
    return this.#serial(hash, async () => structuredClone((await this.#load(hash, sessionId))?.children ?? []))
  }

  /**
   * Record a child `sessionId` has started, as running, with `n` one more than the number of children the session has
   * (it starts again after a corrupt file). Recording a child that is already there is not an error: it gives the
   * record it has, unchanged.
   * @throws TypeError if `sessionId` or `record` isn't shaped as they should be. Nothing is written.
   */
  async addChild(sessionId: string, record: NewChild): Promise<ChildRecord> {
    if (!isText(sessionId) || sessionId === '') throw new TypeError('addChild needs a session id that is a non-empty string')
    const problem = newChildProblem(record)
    if (problem !== undefined) throw new TypeError(`addChild needs a child: ${problem}`)
    const hash = hashOf(sessionId)
    // Queued without waiting for anything first, so that children are numbered in the order they were asked for.
    return this.#serial(hash, async () => {
      const loaded = (await this.#load(hash, sessionId)) ?? { sessionId, children: [] }
      const existing = loaded.children.find(candidate => candidate.id === record.id)
      if (existing !== undefined) return structuredClone(existing)
      const child: ChildRecord = {
        id: record.id,
        n: loaded.children.length + 1,
        role: record.role,
        title: record.title,
        model: record.model,
        family: record.family,
        ...record.reviews === undefined ? {} : { reviews: record.reviews },
        ...record.worktree === undefined ? {} : { worktree: record.worktree },
        ...record.gateOverride === undefined ? {} : { gateOverride: record.gateOverride },
        startedAt: record.startedAt ?? Date.now(),
        followUps: 0,
        runs: [],
        last: 'running',
      }
      // The pointer first: a crash between the two leaves a pointer to nothing, never a child nobody can find.
      await writeAtomic(this.#pointerFile(child.id), hash)
      loaded.children.push(child)
      await this.#save(hash, loaded)
      return structuredClone(child)
    })
  }

  /**
   * Count a follow-up sent to `childId`, which is running again until its next run ends, and, with `gateOverride`, record
   * the main agent's ruling on the child (a reviewer), replacing any it had. Without one, a ruling it had stays. A child
   * that isn't recorded is ignored.
   * @throws TypeError if `gateOverride` is given and isn't a string. Nothing is written.
   */
  async addFollowUp(childId: string, extra?: { gateOverride?: string }): Promise<void> {
    const gateOverride = extra?.gateOverride
    if (gateOverride !== undefined && !isText(gateOverride)) throw new TypeError('addFollowUp: gateOverride must be a string')
    await this.#update(childId, async (child) => {
      child.followUps += 1
      child.last = 'running'
      if (gateOverride !== undefined) child.gateOverride = gateOverride
      return true
    })
  }

  /**
   * Append `result` to the gate results of `childId`'s run in progress (`ChildRecord.gates`), through its session's queue,
   * as a copy of its own fields. `endRun` moves them onto the run it files; see the module's header for why a result lands
   * on the run it gated. Gives `false` for a child that isn't recorded.
   * @throws TypeError if `result` isn't a `GateResult` (see `gateProblem`). Nothing is written.
   */
  async addGate(childId: string, result: GateResult): Promise<boolean> {
    const problem = gateProblem(result)
    if (problem !== undefined) throw new TypeError(`addGate needs a gate result: ${problem}`)
    // Copied now, before anything is awaited, so that what the caller does with its object afterwards changes nothing here.
    const copy = parseGate(result)!
    const added = await this.#update(childId, async (child) => {
      child.gates = [...child.gates ?? [], copy]
      return true
    })
    return added === true
  }

  /**
   * Note that a run of `childId` started: it is `running` until the run ends. dsh starts a run each time it brings a child
   * up, for a first start and for a wake or a resume of one that had ended (a message to it, say), and only the first is
   * one `addChild` knows of. A child that is running already isn't written again, and one that isn't recorded is ignored.
   */
  async startRun(childId: string): Promise<void> {
    await this.#update(childId, async (child) => {
      if (child.last === 'running') return undefined
      child.last = 'running'
      return true
    })
  }

  /**
   * File a run that ended: write its closing message as the report `<n>-<role>-<run>.md`, add the run, and set `last`
   * from the stop reason (see `statusFor`). The report is written before the run that names it. The gate results of the
   * run in progress (`ChildRecord.gates`) go onto the run, which has no `gates` when there were none, and off the child,
   * so the next run starts with none.
   * Gives where the report went, or `undefined` for a child that isn't recorded, which is not an error: the events
   * this is called from include agents crew didn't start. Whatever the other fields are, it doesn't throw because of
   * them: a stop reason that isn't text is `unknown`, an error that isn't text is none, and a closing message that isn't
   * text is none.
   */
  async endRun(childId: string, end: RunEnd): Promise<EndedRun | undefined> {
    const stopReason = isText(end?.stopReason) && end.stopReason !== '' ? end.stopReason : 'unknown'
    const error = isText(end?.error) && end.error !== '' ? end.error : undefined
    const content = reportContent(isText(end?.closing) ? end.closing : '')
    return this.#update(childId, async (child, hash) => {
      const report = await this.#writeReport(hash, `${child.n}-${fileSafe(child.role)}-${child.runs.length + 1}`, content)
      const gates = child.gates ?? []
      delete child.gates
      child.runs.push({ endedAt: Date.now(), stopReason, ...error === undefined ? {} : { error }, report, ...gates.length === 0 ? {} : { gates } })
      child.last = statusFor(stopReason)
      return { report }
    })
  }

  /** Write `text` (a `reportContent`) as `<base>.md` in session `hash`'s directory, or `<base>.2.md` and on if that name is taken. */
  async #writeReport(hash: string, base: string, text: string): Promise<string> {
    const directory = this.#sessionDirectory(hash)
    let file = join(directory, `${base}.md`)
    for (let attempt = 2; await exists(file); attempt++) file = join(directory, `${base}.${attempt}.md`)
    await writeAtomic(file, text)
    return file
  }

  /** The child `childId`, with the id of the session it belongs to, or `undefined` if it isn't recorded. */
  async lookup(childId: string): Promise<{ sessionId: string, record: ChildRecord } | undefined> {
    const hash = await this.#sessionOf(childId)
    if (hash === undefined) return undefined
    return this.#serial(hash, async () => {
      const loaded = await this.#load(hash)
      const child = loaded?.children.find(candidate => candidate.id === childId)
      return loaded === undefined || child === undefined ? undefined : { sessionId: loaded.sessionId, record: structuredClone(child) }
    })
  }

  /**
   * Every recorded child bound to `worktree`, compared exactly (the record keeps canonical paths, so the caller passes one),
   * across sessions, with the session each belongs to: oldest first. For `dishCrew.worktreeBindings`, which says which of
   * them are running.
   *
   * It waits for the writes queued when it is called, then reads each session's file through its queue, so a corrupt one is
   * set aside and reported as every read does it (under the session directory's name). What is not named like a session, or
   * is not a directory (a link is not followed), is skipped.
   */
  async boundTo(worktree: string): Promise<Array<{ sessionId: string, record: ChildRecord }>> {
    if (!isText(worktree) || worktree === '') return []
    await Promise.all([...this.#queues.values()])
    let entries: Dirent[]
    try {
      entries = await readdir(join(this.#directory, SESSIONS), { withFileTypes: true })
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return []
      throw error
    }
    const found: Array<{ sessionId: string, record: ChildRecord }> = []
    for (const entry of entries) {
      if (!entry.isDirectory() || !HASH.test(entry.name)) continue
      const loaded = await this.#serial(entry.name, () => this.#load(entry.name))
      if (loaded === undefined) continue
      for (const child of loaded.children) {
        if (child.worktree === worktree) found.push({ sessionId: loaded.sessionId, record: structuredClone(child) })
      }
    }
    return found.sort((a, b) => a.record.startedAt - b.record.startedAt || a.sessionId.localeCompare(b.sessionId) || a.record.n - b.record.n)
  }

  /** Resolve once every write that is queued now is done. For a shutdown to wait on. */
  async flush(): Promise<void> {
    while (this.#queues.size > 0) await Promise.all([...this.#queues.values()])
  }

  /**
   * Remove the sessions nothing has written to for more than `maxAgeMs`, with their pointers. A session's age is its
   * newest file's mtime. Returns how many sessions went.
   *
   * - A temp file under `TEMP_GRACE_MS` old is a write in progress: it keeps its session, whatever the age;
   * - one over it is a crash's: it is removed from a session that stays, and doesn't count toward the session's age;
   * - a pointer goes with its session; one whose session isn't there goes once it is over `TEMP_GRACE_MS` old, because
   *   a pointer is written before its session's file;
   * - only what is named like a session, a pointer or a temp file is touched; links aren't followed.
   *
   * It runs through the session's queue, so it can't take a session apart under this process's own writes. Another
   * process that writes a session between its `stat` and its removal can lose that write: a session that went unwritten
   * for months, and one process, is where this matters least.
   * @throws RangeError if `maxAgeMs` isn't a number that is 0 or more: `NaN` or a negative age would remove everything.
   */
  async prune(maxAgeMs: number): Promise<number> {
    if (typeof maxAgeMs !== 'number' || !(maxAgeMs >= 0)) throw new RangeError(`maxAgeMs must be 0 or more, not ${String(maxAgeMs)}`)
    const now = Date.now()
    const removed = new Set<string>()
    let entries: Dirent[]
    try {
      entries = await readdir(join(this.#directory, SESSIONS), { withFileTypes: true })
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error
      entries = []
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !HASH.test(entry.name)) continue
      if (await this.#serial(entry.name, () => this.#pruneSession(entry.name, now - maxAgeMs, now - TEMP_GRACE_MS))) removed.add(entry.name)
    }
    await this.#prunePointers(removed, now - TEMP_GRACE_MS)
    return removed.size
  }

  /** Remove session `hash` if it's older than `cutoff`, and otherwise its stale temp files. Whether the session went. */
  async #pruneSession(hash: string, cutoff: number, tempCutoff: number): Promise<boolean> {
    const directory = this.#sessionDirectory(hash)
    let entries: Dirent[]
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return false
      throw error
    }
    let newest = -Infinity
    let writing = false
    const stale: string[] = []
    for (const entry of entries) {
      if (!entry.isFile()) continue
      let mtime: number
      try {
        mtime = (await stat(join(directory, entry.name))).mtimeMs
      } catch (error) {
        if (errorCode(error) === 'ENOENT') continue
        throw error
      }
      if (!TEMP_FILE.test(entry.name)) newest = Math.max(newest, mtime)
      else if (mtime >= tempCutoff) writing = true
      else stale.push(entry.name)
    }
    // A session with no file of its own is as old as the directory.
    if (newest === -Infinity && !writing) {
      try {
        newest = (await stat(directory)).mtimeMs
      } catch (error) {
        if (errorCode(error) === 'ENOENT') return false
        throw error
      }
    }
    if (writing || newest >= cutoff) {
      for (const name of stale) await unlink(join(directory, name)).catch((error: unknown) => { if (errorCode(error) !== 'ENOENT') throw error })
      return false
    }
    await rm(directory, { recursive: true, force: true })
    return true
  }

  /** Remove the pointers to the sessions in `removed`, those to sessions that aren't there and are old, and stale temp files. */
  async #prunePointers(removed: ReadonlySet<string>, tempCutoff: number): Promise<void> {
    const directory = join(this.#directory, BY_CHILD)
    let entries: Dirent[]
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const stray = TEMP_FILE.test(entry.name)
      if (!stray && !HASH.test(entry.name)) continue
      const file = join(directory, entry.name)
      try {
        const { mtimeMs } = await stat(file)
        if (stray) {
          if (mtimeMs < tempCutoff) await unlink(file)
          continue
        }
        const target = (await readFile(file, 'utf8')).trim()
        if (!HASH.test(target)) continue
        // A session that is not there: this prune took it, or another did, or its first write never came. Asked inside
        // the session's queue, so a child added to it meanwhile (which writes its pointer first) is not undone.
        if (!removed.has(target) && mtimeMs >= tempCutoff) continue
        await this.#serial(target, async () => {
          if (!await exists(this.#sessionDirectory(target))) await unlink(file).catch((error: unknown) => { if (errorCode(error) !== 'ENOENT') throw error })
        })
      } catch (error) {
        // Gone already (another process took it): nothing to do.
        if (errorCode(error) !== 'ENOENT') throw error
      }
    }
  }
}
