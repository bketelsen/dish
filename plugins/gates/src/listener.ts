/**
 * The gate: dsh's `agent/turn-stopping`, heard for every agent, acts for a crew coder bound to a worktree that is about to
 * end its turn. It runs the project's gate in the coder's worktree, records the result in crew's record, and steers a
 * failure back to the coder, so its turn goes on.
 *
 * For each stop, in order (the gates spec as revised 2026-10-03, and step 7's gating with `report`):
 * 1. **Not gated:** the turn's (or the plugin's) signal is aborted, the agent is top-level, crew isn't running, or crew's
 *    record has no worktree for the agent. Nothing is recorded, nothing is asked of dish-workspaces.
 * 2. **One gate per worktree.** The rest runs in a lock keyed by the record's worktree: a second stop for it waits for the
 *    first, and so does open_pr's gate (`runAt`, which shares the lock). A stop whose signal aborts while it waits returns
 *    at once, recording nothing; the lock still passes in order.
 * 3. **The round:** the record is read again, and the round is 1 + the `failed` results it holds for this turn. Rounds are
 *    counted per dsh turn: a steer continues the turn, and a follow-up starts a new one. `maxRounds` is read on each stop.
 *    Then **whether the coder has finished** (nothing is recorded when it hasn't):
 *    - (a) a successful `report` concluded the stop (`Closing.report`): it has, whatever its message holds;
 *    - (b) otherwise, a stop whose newest message holds tool calls hasn't finished. dsh fires `agent/turn-stopping` after
 *      such a step only when an earlier step of the turn was cut at `max-tokens`, which dsh keeps as the turn's end; the
 *      cut message itself holds no tool calls, so that stop is gated (`closing.ts`). Nor has a stop crew sent back to call
 *      `report` (`dishCrew.reportSteered`): crew's `agent/turn-stopping` listener is prepended, and dsh runs the listeners
 *      in order, so its steer is made before this one runs. A report steer and a gate steer never both happen at one
 *      stop. Any other stop has finished: with crew's `reportSteers: 0`, (b) is the rule from before step 7.
 * 4. **The worktree** comes from `dishWorkspaces.resolve`, which checks it. One that doesn't resolve is recorded, never
 *    skipped in silence: an `error` with `resolveProblem`'s reason (a coder can't skip its gate by breaking its clone's
 *    config), else `skipped` (the worktree or its project is gone). No dish-workspaces, no dish-projects or no shell is an
 *    `error`. Once it resolves, its HEAD is read (`dishWorkspaces.headOf`): every result recorded from there on carries it
 *    as `head`, and every result before it, or when it can't be read, `head: null`.
 * 5. **The opt-out:** after a `report`, its `status`: `done` goes on, `blocked` and `needs_context` are `skipped`, and the
 *    text isn't read (the message that called `report` can have none, so the head can be an older message's). Without a
 *    `report`, a closing message that starts with `BLOCKED:` or `NEEDS CONTEXT:` is `skipped`.
 * 6. **Rounds used up:** with `maxRounds` failures in this turn already, nothing runs and nothing is recorded. Only another
 *    listener's steer can bring a turn here.
 * 7. **The run** (`runGate`): projects.yaml's gate as it is now, never the coder's; the turn's signal joined with the
 *    plugin's; the project's `gateEnv`, and, unless it sets `PATH`, dsh's `PATH` with mise's shims after it (`env.ts`).
 * 8. **The outcome:** `cancelled` records nothing; `error`, `passed` and `failed` are recorded.
 * 9. **The steer**, only for a recorded `failed` with `round < maxRounds`. The failure in the last round is recorded and not
 *    steered: the turn ends with it (the user's decision A, 2026-10-03). So a turn has at most `maxRounds` gate runs and
 *    `maxRounds - 1` fix attempts, however its stops come, by `report` or by text. A failure that couldn't be recorded isn't
 *    steered either, so every steer adds a failure to the record and the rounds always run out. After a `report`, the steer
 *    asks for `report` again (`failureMessage`'s `reported`).
 * 10. **The event:** each result `addGate` kept is published once, right after it, on `dish-gates/result`, with the child's
 *    session (`deps.publish`, awaited; index.ts waits for the listeners at most `EVENT_BUDGET_MS`, so one that returns in
 *    time runs before the turn can close, and none can hold it). A result crew didn't keep, and a cancelled stop, publish
 *    nothing.
 *
 * **What goes where.** Only the payload's agent is used: its id for the record and the log, that agent for the steer, and
 * the payload's turn for the rounds. Every result is recorded with `addGate`, awaited inside `agent/turn-stopping`, which
 * dsh awaits before the turn can close: so it reaches crew's record before that run's `subagent/end` files the run.
 *
 * **Cancelled.** Once the signal is aborted nothing more is recorded or steered, whatever came back.
 *
 * **Errors.** The listener never throws: a thrown listener fails the turn in dsh-agent-loop. A throw of dish's own code (or
 * of a service it calls) is logged once per distinct message, and, when crew and the child are known, recorded as an
 * `error`, "dish-gates failed: <message>". Every text that goes to the log or the record is masked and on one line. The
 * gate's command is masked wherever it is shown (the record, the steer); only the run gets it as it is.
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
import type { Closing } from './closing.ts'
import { gateEnvironment, withMiseShims } from './env.ts'
import type { BaseEnvironment } from './env.ts'
import { WorktreeLocks } from './locks.ts'
import { gateLogFile } from './logs.ts'
import { runGate } from './run.ts'
import type { GateRunResult, ShellLike } from './run.ts'
import { BLOCKED_REASON, DEFAULT_TAIL_LINES, REPORTED_REASON, duration, excerptOf, failureMessage, failureSummary } from './text.ts'

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

export const NO_WORKSPACES = 'dish-workspaces isn\'t running'
export const NO_PROJECTS = 'dish-projects isn\'t running'
export const NO_SHELL = 'dsh\'s shell service isn\'t running, so dish won\'t run the gate'
/** A commit id as git gives it in full: what `GateResult.head` holds (crew's record refuses anything else). */
export const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
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

/** `dish-gates/result`'s payload: a result dish-gates recorded for a crew child. */
export interface GateResultEvent {
  childId: string
  /** The crew session the child belongs to (records.lookup's sessionId). */
  sessionId: string
  /** A copy of what was recorded. */
  result: GateResult
}

export interface GateDeps {
  /** `ctx.get('dishCrew')`. `reportSteered` is crew's (step 7); a crew without it counts as false. */
  crew(): { records: GateRecords, reportSteered?(childId: string): boolean } | undefined
  /** `ctx.get('dishWorkspaces')`. */
  workspaces(): Pick<DishWorkspaces, 'resolve' | 'resolveProblem' | 'headOf'> | undefined
  /** `ctx.get('dishProjects')`. */
  projects(): Pick<DishProjects, 'get'> | undefined
  /** `ctx.get('shell')`. */
  shell(): ShellLike | undefined
  /** `ClosingHeads.closing(agent.session)`. */
  closing(agent: StoppingAgent): Closing
  /** The config's rows, read on each stop. */
  settings(): { maxRounds: number, tailLines: number }
  /** dish's state directory: the logs go under `<state>/gates`. */
  state: string
  /** The plugin's: aborted when dish-gates stops. */
  signal: AbortSignal
  /**
   * dsh's own process environment, read on each stop, for the gate's `PATH` (`withMiseShims`). Default: `process.env`.
   * Tests give their own.
   */
  environment?: () => Readonly<BaseEnvironment>
  logger: { warn(format: string, ...args: unknown[]): void, info(format: string, ...args: unknown[]): void }
  now?: () => number
  /** Tests. */
  run?: typeof runGate
  /**
   * Publish `dish-gates/result`. Never rejects: index.ts logs a listener's failure, and waits for the listeners at most
   * `EVENT_BUDGET_MS`.
   */
  publish(event: GateResultEvent): Promise<void>
  /** Shared with runAt. Default: one of its own. */
  locks?: WorktreeLocks
}

export function messageOf(error: unknown): string {
  try {
    if (error instanceof Error) return error.message.trim() === '' ? error.name : error.message
    return String(error)
  } catch {
    return 'an error that can\'t be printed'
  }
}

/** `text` masked, on one line, at most `REASON_MAX_CHARS` (an ellipsis where it was cut, never half a surrogate pair). */
export function oneLine(text: string): string {
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

/** The `failed` results `record` holds for `turn`: the rounds that turn has used. */
function failuresIn(record: Pick<ChildRecord, 'gates'>, turn: number): number {
  return record.gates?.filter(result => result.turn === turn && result.outcome === 'failed').length ?? 0
}

/** How a run that ran ended, for the log line: `exit 1`, `timed out at 10 min`, `killed`. */
export function ending(result: Extract<GateRunResult, { kind: 'ran' }>): string {
  if (result.timedOut) return `timed out at ${duration(result.timeoutMs)}`
  return result.exitCode === null ? 'killed' : `exit ${result.exitCode}`
}

/** The `agent/turn-stopping` listener. Never throws. */
export function gateListener(deps: GateDeps): (payload: StoppingPayload) => Promise<void> {
  const locks = deps.locks ?? new WorktreeLocks()
  const told = new Set<string>()
  const now = deps.now ?? Date.now
  const run = deps.run ?? runGate
  const environment = deps.environment ?? ((): Readonly<BaseEnvironment> => process.env)

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

  /** Publish `result`, kept for child `id` of `sessionId`, on `dish-gates/result`: a copy, once. Never throws. */
  const publish = async (id: string, sessionId: string, result: GateResult): Promise<void> => {
    try {
      await deps.publish({ childId: id, sessionId, result: { ...result } })
    } catch (error) {
      // index.ts's publish never rejects; one that does is only logged, and the result stands.
      warnOnce(oneLine(`dish-gates couldn't publish dish-gates/result for child ${id}: ${messageOf(error)}`))
    }
  }

  /** Whether crew sent child `id` back to call `report` at this stop. A crew without `reportSteered`, or one that throws, says no. */
  const reportSteered = (crew: ReturnType<GateDeps['crew']>, id: string): boolean => {
    try {
      return crew?.reportSteered?.(id) === true
    } catch (error) {
      warnOnce(oneLine(`dish-gates couldn't ask crew whether it steered child ${id}: ${messageOf(error)}`))
      return false
    }
  }

  /** The HEAD of the worktree at `path`, or `null` when dish-workspaces gives none, or no commit id, or throws (logged once). */
  const headAt = async (workspaces: Pick<DishWorkspaces, 'headOf'>, path: string): Promise<string | null> => {
    let given: unknown
    try {
      given = await workspaces.headOf(path)
    } catch (error) {
      warnOnce(oneLine(`dish-gates couldn't read the HEAD of ${path}: ${messageOf(error)}`))
      return null
    }
    if (given === undefined) return null
    if (typeof given === 'string' && FULL_SHA.test(given)) return given
    warnOnce(oneLine(`dish-gates couldn't read the HEAD of ${path}: dish-workspaces gave ${JSON.stringify(String(given)).slice(0, 100)}, not a commit id`))
    return null
  }

  /**
   * Everything after the lock: steps 3 to 10. `known` is what the stop knew before it waited: crew's record, the child's
   * session and the failures of this turn it held then, for an error that comes before they are read again.
   */
  const gate = async (
    payload: StoppingPayload, signal: AbortSignal, id: string, worktreePath: string,
    known: { records: GateRecords, sessionId: string, failures: number },
  ): Promise<void> => {
    const { agent, turn } = payload
    // Failed results recorded for this turn (the round is one more), kept current for an error recorded after a failure.
    let { records, sessionId, failures } = known
    let maxRounds = DEFAULT_MAX_ROUNDS
    let tailLines = DEFAULT_TAIL_LINES
    // The worktree's HEAD, once it resolved and was read; null before, and when it couldn't be.
    let head: string | null = null

    /**
     * Record `result` unless the stop was cancelled, log one line for it (`said` after "child <id>, round N, <worktree>: ",
     * at warn for an error), and publish it. Whether it was kept.
     */
    const record = async (result: GateResult, said: string): Promise<boolean> => {
      if (signal.aborted) return false
      if (!await records.addGate(id, result)) {
        warnOnce(oneLine(`a gate result for child ${id} wasn't kept: crew's record no longer has the child`))
        return false
      }
      if (result.outcome === 'failed') failures++
      log(result.outcome === 'error' ? 'warn' : 'info', 'child %s, round %d, %s: %s', id, result.round, worktreePath, said)
      await publish(id, sessionId, result)
      return true
    }
    /** A result for a gate that didn't run: why, masked and on one line. */
    const notRun = (outcome: Extract<GateOutcome, 'skipped' | 'error'>, reason: string, durationMs = 0): GateResult => ({
      turn, round: failures + 1, maxRounds, outcome, command: '', exitCode: null, timedOut: false, durationMs, log: null,
      excerpt: '', reason: oneLine(reason), at: now(), head,
    })
    /** Record a gate that didn't run. */
    const recordNotRun = (outcome: Extract<GateOutcome, 'skipped' | 'error'>, reason: string, durationMs?: number): Promise<boolean> => {
      const result = notRun(outcome, reason, durationMs)
      return record(result, `${outcome === 'error' ? 'not run' : 'skipped'}: ${result.reason}`)
    }

    try {
      ({ maxRounds, tailLines } = settings())
      // Crew as it is now: a crew that was loaded again meanwhile has a record (and a write queue) of its own.
      const crew = deps.crew()
      const current = crew?.records
      if (current === undefined) return
      records = current
      const found = await records.lookup(id)
      if (found?.record.worktree === undefined || signal.aborted) return
      sessionId = found.sessionId
      failures = failuresIn(found.record, turn)
      const round = failures + 1
      // Whether the coder has finished: (a) a report concluded the stop, whatever its message holds; (b) otherwise a stop
      // whose newest message calls tools hasn't, nor has one crew sent back to call report. Neither is gated, and nothing
      // is recorded.
      const closing = deps.closing(agent)
      if (closing.report === undefined && (closing.toolCalls || reportSteered(crew, id))) return

      const workspaces = deps.workspaces()
      if (workspaces === undefined) return void await recordNotRun('error', NO_WORKSPACES)
      const worktree = await workspaces.resolve(worktreePath)
      if (worktree === undefined) {
        const problem = await workspaces.resolveProblem(worktreePath)
        return void await (problem !== undefined && problem.trim() !== '' ? recordNotRun('error', problem) : recordNotRun('skipped', GONE))
      }
      head = await headAt(workspaces, worktree.path)
      const projects = deps.projects()
      if (projects === undefined) return void await recordNotRun('error', NO_PROJECTS)
      const project = await projects.get(worktree.project)
      if (project === undefined) return void await recordNotRun('skipped', `${worktree.project} isn't in projects.yaml`)

      // The opt-out: a report's status when a report concluded the stop (its text isn't read: the message that called
      // report can have none, and the head be an older message's); else the closing message's marker.
      if (closing.report !== undefined) {
        if (closing.report !== 'done') return void await recordNotRun('skipped', REPORTED_REASON[closing.report])
      } else if (optsOut(closing.head)) {
        return void await recordNotRun('skipped', BLOCKED_REASON)
      }
      if (failures >= maxRounds) return

      const shell = deps.shell()
      if (shell === undefined) return void await recordNotRun('error', NO_SHELL)
      if (signal.aborted) return
      const result = await run({
        shell,
        command: project.gate,
        worktree: { path: worktree.path, clone: worktree.clone },
        timeoutMs: project.gateTimeoutMs,
        env: await withMiseShims(gateEnvironment(project.gateEnv, { clone: worktree.clone, worktree: worktree.path }), environment()),
        log: gateLogFile(deps.state, worktree.project, worktree.slug, id, turn, round),
        signal,
        sessionId: id,
        ...deps.now === undefined ? {} : { now: deps.now },
      })
      if (result.kind === 'cancelled') return
      if (result.kind === 'error') return void await recordNotRun('error', result.reason, result.durationMs)

      const passed = result.exitCode === 0 && !result.timedOut
      const took = duration(result.durationMs)
      // The gate as it is shown, never run: the record (and so crew's notice) and the steer carry it masked.
      const shown = maskSecrets(project.gate)
      const kept = await record({
        turn, round, maxRounds, outcome: passed ? 'passed' : 'failed', command: shown, exitCode: result.exitCode,
        timedOut: result.timedOut, durationMs: result.durationMs, log: result.log, excerpt: excerptOf(result.output), at: now(), head,
      }, passed ? `passed in ${took}` : `failed in ${took} (${ending(result)})`)
      // Only a failure that is on the record is sent back: each steer adds one, so the rounds always run out. The last
      // round's failure isn't sent back: the turn ends with it (the user's decision A, 2026-10-03).
      if (!kept || passed || round >= maxRounds || signal.aborted) return
      const failure = {
        command: shown, exitCode: result.exitCode, timedOut: result.timedOut, timeoutMs: result.timeoutMs,
        durationMs: result.durationMs, tail: result.output, tailLines, log: result.log,
        ...result.logProblem === undefined ? {} : { logProblem: result.logProblem }, round, maxRounds, denied: result.denied,
        reported: closing.report !== undefined,
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
        const result = notRun('error', message)
        if (await records.addGate(id, result)) await publish(id, sessionId, result)
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
    await locks.run(worktree, signal, () => gate(payload, signal, id, worktree, { records, sessionId: found.sessionId, failures }))
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
