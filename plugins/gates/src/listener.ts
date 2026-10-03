/**
 * The gate: dsh's `agent/turn-stopping`, heard for every agent, acts for a crew coder bound to a worktree that is about to
 * end its turn. It runs the project's gate in the coder's worktree, records the result in crew's record, and steers a
 * failure back to the coder, so its turn goes on.
 *
 * For each stop, in order (the gates spec as revised 2026-10-03):
 * 1. **Not gated:** the turn's (or the plugin's) signal is aborted, the agent is top-level, crew isn't running, or crew's
 *    record has no worktree for the agent. Nothing is recorded, nothing is asked of dish-workspaces.
 * 2. **One gate per worktree.** The rest runs in a lock keyed by the record's worktree: a second stop for it waits for the
 *    first. A stop whose signal aborts while it waits returns at once, recording nothing; the lock still passes in order.
 * 3. **The round:** the record is read again, and the round is 1 + the `failed` results it holds for this turn. Rounds are
 *    counted per dsh turn: a steer continues the turn, and a follow-up starts a new one. `maxRounds` is read on each stop.
 * 4. **The worktree** comes from `dishWorkspaces.resolve`, which checks it. One that doesn't resolve is recorded, never
 *    skipped in silence: an `error` with `resolveProblem`'s reason (a coder can't skip its gate by breaking its clone's
 *    config), else `skipped` (the worktree or its project is gone). No dish-workspaces, no dish-projects or no shell is an
 *    `error`.
 * 5. **The opt-out:** a closing message that starts with `BLOCKED:` or `NEEDS CONTEXT:` is `skipped`.
 * 6. **Rounds used up:** with `maxRounds` failures in this turn already, nothing runs and nothing is recorded. Only another
 *    listener's steer can bring a turn here.
 * 7. **The run** (`runGate`): projects.yaml's gate as it is now, never the coder's; the turn's signal joined with the
 *    plugin's.
 * 8. **The outcome:** `cancelled` records nothing; `error`, `passed` and `failed` are recorded.
 * 9. **The steer**, only for a recorded `failed` with `round < maxRounds`. The failure in the last round is recorded and not
 *    steered: the turn ends with it (the user's decision A, 2026-10-03). So a turn has at most `maxRounds` gate runs and
 *    `maxRounds - 1` fix attempts. A failure that couldn't be recorded isn't steered either, so every steer adds a failure
 *    to the record and the rounds always run out.
 *
 * **What goes where.** Only the payload's agent is used: its id for the record and the log, that agent for the steer, and
 * the payload's turn for the rounds. Every result is recorded with `addGate`, awaited inside `agent/turn-stopping`, which
 * dsh awaits before the turn can close: so it reaches crew's record before that run's `subagent/end` files the run.
 *
 * **Cancelled.** Once the signal is aborted nothing more is recorded or steered, whatever came back.
 *
 * **Errors.** The listener never throws: a thrown listener fails the turn in dsh-agent-loop. A throw of dish's own code (or
 * of a service it calls) is logged once per distinct message, and, when crew and the child are known, recorded as an
 * `error`, "dish-gates failed: <message>". Every text that goes to the log or the record is masked and on one line.
 *
 * Nothing here runs a process or git: the run is `run.ts`'s, over dsh's sandboxed shell.
 *
 * @module dish-gates/listener
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, UserMessage } from '@deepseek-ai/dsh-llm'
import type { ChildRecord, CrewRecords, GateOutcome, GateResult } from 'dish-crew'
import { isTopLevelAgent, maskSecrets } from 'dish-kit'
import type { DishProjects } from 'dish-projects'
import type { DishWorkspaces } from 'dish-workspaces'
import { optsOut } from './closing.ts'
import { gateEnvironment } from './env.ts'
import { gateLogFile } from './logs.ts'
import { runGate } from './run.ts'
import type { GateRunResult, ShellLike } from './run.ts'
import { BLOCKED_REASON, DEFAULT_TAIL_LINES, duration, excerptOf, failureMessage, failureSummary } from './text.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** The message steered to a crew coder whose gate failed, with rounds left in its turn. */
    'dish-gates': { kind: 'dish-gates' } & ContextFormed
  }
}

/** Gate runs per turn when the settings don't give a whole number from 1. */
export const DEFAULT_MAX_ROUNDS = 3
/** Why a gate didn't run, at most. */
const REASON_MAX_CHARS = 300
/** How many distinct messages are remembered as logged; the oldest goes first. */
const TOLD_MAX = 100

const NO_WORKSPACES = 'dish-workspaces isn\'t running'
const NO_PROJECTS = 'dish-projects isn\'t running'
const NO_SHELL = 'dsh\'s shell service isn\'t running, so dish won\'t run the gate'
/** Read after crew's "Gate skipped: ". */
const GONE = 'its worktree is gone, or its project is no longer registered'

/** What the listener uses of dsh's Agent. */
export interface StoppingAgent {
  id: unknown
  session: object
  options?: object
  steer(message: UserMessage): void
}

/** `agent/turn-stopping`'s payload. */
export interface StoppingPayload {
  agent: StoppingAgent
  turn: number
  signal: AbortSignal
}

/** What the listener uses of crew's record. `dishCrew.records` is one. */
export type GateRecords = Pick<CrewRecords, 'lookup' | 'addGate'>

export interface GateDeps {
  /** `ctx.get('dishCrew')`. */
  crew(): { records: GateRecords } | undefined
  /** `ctx.get('dishWorkspaces')`. */
  workspaces(): Pick<DishWorkspaces, 'resolve' | 'resolveProblem'> | undefined
  /** `ctx.get('dishProjects')`. */
  projects(): Pick<DishProjects, 'get'> | undefined
  /** `ctx.get('shell')`. */
  shell(): ShellLike | undefined
  /** `ClosingHeads.headOf(agent.session)`. */
  headOf(agent: StoppingAgent): string
  /** The config's rows, read on each stop. */
  settings(): { maxRounds: number, tailLines: number }
  /** dish's state directory: the logs go under `<state>/gates`. */
  state: string
  /** The plugin's: aborted when dish-gates stops. */
  signal: AbortSignal
  logger: { warn(format: string, ...args: unknown[]): void, info(format: string, ...args: unknown[]): void }
  now?: () => number
  /** Tests. */
  run?: typeof runGate
}

function messageOf(error: unknown): string {
  try {
    if (error instanceof Error) return error.message.trim() === '' ? error.name : error.message
    return String(error)
  } catch {
    return 'an error that can\'t be printed'
  }
}

/** `text` masked, on one line, at most `REASON_MAX_CHARS` (an ellipsis where it was cut, never half a surrogate pair). */
function oneLine(text: string): string {
  // Masked first, then cut: a cut can leave the start of a secret that no pattern would match any more.
  const line = maskSecrets(text).replace(/\s+/g, ' ').trim()
  if (line.length <= REASON_MAX_CHARS) return line
  let end = REASON_MAX_CHARS - 1
  const last = line.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end--
  return `${line.slice(0, end)}…`
}

/** A whole number from 1, or `fallback`. */
function count(value: unknown, fallback: number): number {
  return Number.isSafeInteger(value) && (value as number) >= 1 ? value as number : fallback
}

/**
 * One job at a time per key (a worktree's canonical path), in the order they came; other keys don't wait. A job whose
 * signal aborts while it waits doesn't run, and its caller gets `undefined` at once, while the jobs after it still wait
 * for the ones before it.
 */
class WorktreeLocks {
  /** Per key, a promise that settles (never rejects) once the last job queued for it is done or gave up. */
  readonly #tails = new Map<string, Promise<void>>()

  async run<T>(key: string, signal: AbortSignal, job: () => Promise<T>): Promise<T | undefined> {
    const previous = this.#tails.get(key) ?? Promise.resolve()
    let release!: () => void
    const mine = new Promise<void>((settle) => { release = settle })
    const tail = previous.then(() => mine)
    this.#tails.set(key, tail)
    void tail.then(() => {
      if (this.#tails.get(key) === tail) this.#tails.delete(key)
    })
    try {
      if (!await settledFirst(previous, signal)) return undefined
      return await job()
    } finally {
      release()
    }
  }
}

/** Whether `promise` (which never rejects) settles before `signal` aborts. */
function settledFirst(promise: Promise<void>, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise((settle) => {
    const onAbort = (): void => { settle(false) }
    signal.addEventListener('abort', onAbort, { once: true })
    void promise.then(() => {
      signal.removeEventListener('abort', onAbort)
      settle(!signal.aborted)
    })
  })
}

/** The `failed` results `record` holds for `turn`: the rounds that turn has used. */
function failuresIn(record: Pick<ChildRecord, 'gates'>, turn: number): number {
  return record.gates?.filter(result => result.turn === turn && result.outcome === 'failed').length ?? 0
}

/** How a run that ran ended, for the log line: `exit 1`, `timed out at 10 min`, `killed`. */
function ending(result: Extract<GateRunResult, { kind: 'ran' }>): string {
  if (result.timedOut) return `timed out at ${duration(result.timeoutMs)}`
  return result.exitCode === null ? 'killed' : `exit ${result.exitCode}`
}

/** The `agent/turn-stopping` listener. Never throws. */
export function gateListener(deps: GateDeps): (payload: StoppingPayload) => Promise<void> {
  const locks = new WorktreeLocks()
  const told = new Set<string>()
  const now = deps.now ?? Date.now
  const run = deps.run ?? runGate

  /** Log `message` at warn, once: a broken record or service would otherwise say the same at every stop. */
  const warnOnce = (message: string): void => {
    if (told.has(message)) return
    told.add(message)
    if (told.size > TOLD_MAX) told.delete(told.values().next().value!)
    try {
      deps.logger.warn('%s', message)
    } catch {
      // A logger that throws isn't worth a failed turn.
    }
  }
  const log = (level: 'info' | 'warn', format: string, ...args: unknown[]): void => {
    try {
      deps.logger[level](format, ...args)
    } catch {
      // As above.
    }
  }

  /** The settings, made safe: `addGate` refuses a `maxRounds` that isn't a whole number from 1. */
  const settings = (): { maxRounds: number, tailLines: number } => {
    const given = deps.settings()
    return { maxRounds: count(given?.maxRounds, DEFAULT_MAX_ROUNDS), tailLines: count(given?.tailLines, DEFAULT_TAIL_LINES) }
  }

  /**
   * Everything after the lock: steps 3 to 9. `known` is what the stop knew before it waited: crew's record and the
   * failures of this turn it held then, for an error that comes before they are read again.
   */
  const gate = async (
    payload: StoppingPayload, signal: AbortSignal, id: string, worktreePath: string, known: { records: GateRecords, failures: number },
  ): Promise<void> => {
    const { agent, turn } = payload
    // Failed results recorded for this turn (the round is one more), kept current for an error recorded after a failure.
    let { records, failures } = known
    let maxRounds = DEFAULT_MAX_ROUNDS
    let tailLines = DEFAULT_TAIL_LINES

    /**
     * Record `result` unless the stop was cancelled, and log one line for it: `said` after "child <id>, round N,
     * <worktree>: ", at warn for an error. Whether it was kept.
     */
    const record = async (result: GateResult, said: string): Promise<boolean> => {
      if (signal.aborted) return false
      if (!await records.addGate(id, result)) {
        warnOnce(oneLine(`a gate result for child ${id} wasn't kept: crew's record no longer has the child`))
        return false
      }
      if (result.outcome === 'failed') failures++
      log(result.outcome === 'error' ? 'warn' : 'info', 'child %s, round %d, %s: %s', id, result.round, worktreePath, said)
      return true
    }
    /** A result for a gate that didn't run: why, masked and on one line. */
    const notRun = (outcome: Extract<GateOutcome, 'skipped' | 'error'>, reason: string, durationMs = 0): GateResult => ({
      turn, round: failures + 1, maxRounds, outcome, command: '', exitCode: null, timedOut: false, durationMs, log: null,
      excerpt: '', reason: oneLine(reason), at: now(),
    })
    /** Record a gate that didn't run. */
    const recordNotRun = (outcome: Extract<GateOutcome, 'skipped' | 'error'>, reason: string, durationMs?: number): Promise<boolean> => {
      const result = notRun(outcome, reason, durationMs)
      return record(result, `${outcome === 'error' ? 'not run' : 'skipped'}: ${result.reason}`)
    }

    try {
      ({ maxRounds, tailLines } = settings())
      // Crew as it is now: a crew that was loaded again meanwhile has a record (and a write queue) of its own.
      const current = deps.crew()?.records
      if (current === undefined) return
      records = current
      const found = await records.lookup(id)
      if (found?.record.worktree === undefined || signal.aborted) return
      failures = failuresIn(found.record, turn)
      const round = failures + 1

      const workspaces = deps.workspaces()
      if (workspaces === undefined) return void await recordNotRun('error', NO_WORKSPACES)
      const worktree = await workspaces.resolve(worktreePath)
      if (worktree === undefined) {
        const problem = await workspaces.resolveProblem(worktreePath)
        return void await (problem !== undefined && problem.trim() !== '' ? recordNotRun('error', problem) : recordNotRun('skipped', GONE))
      }
      const projects = deps.projects()
      if (projects === undefined) return void await recordNotRun('error', NO_PROJECTS)
      const project = await projects.get(worktree.project)
      if (project === undefined) return void await recordNotRun('skipped', `${worktree.project} isn't in projects.yaml`)

      if (optsOut(deps.headOf(agent))) return void await recordNotRun('skipped', BLOCKED_REASON)
      if (failures >= maxRounds) return

      const shell = deps.shell()
      if (shell === undefined) return void await recordNotRun('error', NO_SHELL)
      if (signal.aborted) return
      const result = await run({
        shell,
        command: project.gate,
        worktree: { path: worktree.path, clone: worktree.clone },
        timeoutMs: project.gateTimeoutMs,
        env: gateEnvironment(project.gateEnv, { clone: worktree.clone, worktree: worktree.path }),
        log: gateLogFile(deps.state, worktree.project, worktree.slug, id, turn, round),
        signal,
        sessionId: id,
        ...deps.now === undefined ? {} : { now: deps.now },
      })
      if (result.kind === 'cancelled') return
      if (result.kind === 'error') return void await recordNotRun('error', result.reason, result.durationMs)

      const passed = result.exitCode === 0 && !result.timedOut
      const took = duration(result.durationMs)
      const kept = await record({
        turn, round, maxRounds, outcome: passed ? 'passed' : 'failed', command: project.gate, exitCode: result.exitCode,
        timedOut: result.timedOut, durationMs: result.durationMs, log: result.log, excerpt: excerptOf(result.output), at: now(),
      }, passed ? `passed in ${took}` : `failed in ${took} (${ending(result)})`)
      // Only a failure that is on the record is sent back: each steer adds one, so the rounds always run out. The last
      // round's failure isn't sent back: the turn ends with it (the user's decision A, 2026-10-03).
      if (!kept || passed || round >= maxRounds || signal.aborted) return
      const failure = {
        command: project.gate, exitCode: result.exitCode, timedOut: result.timedOut, timeoutMs: result.timeoutMs,
        durationMs: result.durationMs, tail: result.output, tailLines, log: result.log,
        ...result.logProblem === undefined ? {} : { logProblem: result.logProblem }, round, maxRounds, denied: result.denied,
      }
      agent.steer(createUserMessage({
        content: [{ type: 'text', text: failureMessage(failure) }],
        source: { kind: 'dish-gates', form: 'notice', summary: failureSummary(failure) },
      }))
    } catch (error) {
      const message = oneLine(`dish-gates failed: ${messageOf(error)}`)
      warnOnce(message)
      if (signal.aborted) return
      try {
        await records.addGate(id, notRun('error', message))
      } catch (again) {
        warnOnce(oneLine(`dish-gates failed: ${messageOf(again)}`))
      }
    }
  }

  const stop = async (payload: StoppingPayload): Promise<void> => {
    const { agent } = payload
    const signal = AbortSignal.any([payload.signal, deps.signal])
    if (signal.aborted || isTopLevelAgent(agent)) return
    const records = deps.crew()?.records
    if (records === undefined) return
    const id = String(agent.id)
    const found = await records.lookup(id)
    if (found?.record.worktree === undefined) return
    const worktree = found.record.worktree
    const failures = failuresIn(found.record, payload.turn)
    await locks.run(worktree, signal, () => gate(payload, signal, id, worktree, { records, failures }))
  }

  return async (payload) => {
    try {
      await stop(payload)
    } catch (error) {
      // Before the child was known (a malformed payload, a record that can't be read): nothing to record it on.
      warnOnce(oneLine(`dish-gates failed: ${messageOf(error)}`))
    }
  }
}
