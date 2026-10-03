/**
 * `dishGates.runAt`: the project's gate in a worktree dish made, at its HEAD, for open_pr (step 7). It runs as a coder's gate
 * runs (`run.ts`: dsh's sandboxed shell, the `workspace-write` policy rooted at the clone, the project's timeout capped at 10
 * minutes, `gateEnv` with mise's shims), for the session it is given: open_pr's caller, the main agent.
 *
 * - **One gate per worktree.** It takes the listener's lock (`locks.ts`), so a coder's gate and an open_pr gate never run at
 *   once in a worktree.
 * - **The head.** It reads the worktree's HEAD in the lock (`dishWorkspaces.headOf`), and the result carries it. Given the
 *   head its caller read (`options.head`), a worktree whose HEAD isn't that commit isn't gated: an `error`. So the head that
 *   was checked is the head open_pr pushes (`pushBranch` refuses any other).
 * - **Nothing kept.** It records nothing in crew's record, steers nothing and publishes nothing: open_pr records `pr.checked`
 *   itself. Its log is `<state>/gates/<owner>/<repo>/<slug>/open_pr.log` (`.2`, `.3`, … after the first).
 * - **Errors are results.** A gate that can't run is an `error` result with why (masked, one line), and so is any throw of
 *   dish's own code ("dish-gates failed: …"). It rejects only for a call without a `sessionId` (a `TypeError`, before
 *   anything runs) and when the caller's signal aborts (with its reason). The plugin stopping is an `error`.
 *
 * Nothing here runs a process or git: the run is `run.ts`'s, over dsh's sandboxed shell, and the head is dish-workspaces'.
 *
 * @module dish-gates/check
 */

import type { GateResult } from 'dish-crew'
import { maskSecrets } from 'dish-kit'
import type { DishProjects } from 'dish-projects'
import type { DishWorkspaces } from 'dish-workspaces'
import { gateEnvironment, withMiseShims } from './env.ts'
import type { BaseEnvironment } from './env.ts'
import { FULL_SHA, NO_PROJECTS, NO_SHELL, NO_WORKSPACES, ending, messageOf, oneLine } from './listener.ts'
import type { WorktreeLocks } from './locks.ts'
import { checkLogFile } from './logs.ts'
import { runGate } from './run.ts'
import type { ShellLike } from './run.ts'
import { duration, excerptOf } from './text.ts'

export interface RunAtOptions {
  /**
   * The session the gate runs for. For open_pr, its caller: the main agent, `String(exec.agent.id)`, which is its session's
   * id (dsh's agent registry is keyed by it, and crew uses the same spelling). The sandbox policy's `sessionId`, as the main
   * agent's own shell commands get from dsh-sandbox-policy (`sessionId: session.id`).
   */
  sessionId: string
  /** The commit the caller read with dishWorkspaces.headOf and means to push. When given, a worktree whose HEAD isn't it isn't gated (`error`). */
  head?: string
  /** The caller's. When it aborts, the gate is cancelled and runAt rejects with its reason. */
  signal?: AbortSignal
}

/** A gate run for open_pr: a GateResult without the turn's rounds. Recorded nowhere: the caller records it. */
export type GateCheck = Omit<GateResult, 'turn' | 'round' | 'maxRounds'>

export interface CheckDeps {
  /** `ctx.get('dishWorkspaces')`. */
  workspaces(): Pick<DishWorkspaces, 'resolve' | 'resolveProblem' | 'headOf'> | undefined
  /** `ctx.get('dishProjects')`. */
  projects(): Pick<DishProjects, 'get'> | undefined
  /** `ctx.get('shell')`. */
  shell(): ShellLike | undefined
  /** dish's state directory: the log goes under `<state>/gates`. */
  state: string
  /** The plugin's: aborted when dish-gates stops. */
  signal: AbortSignal
  /** The listener's. */
  locks: WorktreeLocks
  /** dsh's own process environment, for the gate's `PATH` (`withMiseShims`). Default: `process.env`. */
  environment?: () => Readonly<BaseEnvironment>
  logger: { warn(format: string, ...args: unknown[]): void, info(format: string, ...args: unknown[]): void }
  now?: () => number
  /** Tests. */
  run?: typeof runGate
}

/** Why the gate didn't finish when the plugin stopped. */
const STOPPED = 'dish-gates stopped before the gate finished'
/** Why a worktree whose HEAD dish-workspaces can't give wasn't gated. */
const GONE = 'the worktree is gone, or its project is no longer registered'

/** A signal that never aborts: the caller's, when it gives none. */
const NEVER = new AbortController().signal

/** What the job in the lock gives: the result, or that the run was cancelled. */
const CANCELLED = Symbol('cancelled')

/** The reason a call whose signal aborted rejects with: the signal's own, or an `AbortError` when that isn't an Error. */
function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  if (reason instanceof Error) return reason
  const error = new Error(reason === undefined ? 'runAt was cancelled' : `runAt was cancelled: ${String(reason)}`)
  error.name = 'AbortError'
  return error
}

/** `runAt`: the project's gate in a worktree dish made, at its HEAD, for `options.sessionId`. */
export function gateCheck(deps: CheckDeps): (project: string, worktreePath: string, options: RunAtOptions) => Promise<GateCheck> {
  const now = deps.now ?? Date.now
  const run = deps.run ?? runGate
  const environment = deps.environment ?? ((): Readonly<BaseEnvironment> => process.env)

  const log = (level: 'info' | 'warn', format: string, ...args: unknown[]): void => {
    try {
      deps.logger[level](format, ...args)
    } catch {
      // A logger that throws isn't worth a failed open_pr.
    }
  }

  return async (project, worktreePath, options) => {
    const sessionId: unknown = (options as Partial<RunAtOptions> | null | undefined)?.sessionId
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw new TypeError('runAt needs options.sessionId: the session the gate runs for, a non-empty string')
    }
    const callerSignal = options.signal
    const signal = AbortSignal.any([callerSignal ?? NEVER, deps.signal])
    // What the log says the gate was for: `<project>/<slug>` once the worktree resolved.
    let where = `${String(project)} at ${String(worktreePath)}`
    // The worktree's HEAD, once read; null before.
    let head: string | null = null

    /** An `error` result, logged at warn: nothing ran, or the run couldn't start. */
    const error = (reason: string, durationMs = 0): GateCheck => {
      const result: GateCheck = {
        outcome: 'error', command: '', exitCode: null, timedOut: false, durationMs, log: null, excerpt: '', reason: oneLine(reason), at: now(), head,
      }
      log('warn', 'open_pr\'s gate for %s: not run: %s', oneLine(where), result.reason)
      return result
    }

    /** Steps 5 to 7: in the worktree's lock. */
    const job = async (worktree: { project: string, slug: string, path: string, clone: string }, workspaces: Pick<DishWorkspaces, 'headOf'>): Promise<GateCheck | typeof CANCELLED> => {
      const projects = deps.projects()
      if (projects === undefined) return error(NO_PROJECTS)
      const registered = await projects.get(worktree.project)
      if (registered === undefined) return error(`${worktree.project} isn't in projects.yaml`)
      let given: string | undefined
      try {
        given = await workspaces.headOf(worktree.path)
      } catch (thrown) {
        return error(`dish couldn't read the worktree's HEAD: ${messageOf(thrown)}`)
      }
      if (given === undefined) return error(GONE)
      if (typeof given !== 'string' || !FULL_SHA.test(given)) {
        return error(`dish couldn't read the worktree's HEAD: dish-workspaces gave ${JSON.stringify(String(given)).slice(0, 100)}, not a commit id`)
      }
      const commit: string = given
      head = commit
      if (options.head !== undefined && options.head !== commit) {
        return error(`the worktree's HEAD is ${commit}, not ${String(options.head)}: it moved after the caller read it`)
      }
      const shell = deps.shell()
      if (shell === undefined) return error(NO_SHELL)
      const file = checkLogFile(deps.state, worktree.project, worktree.slug)
      if (signal.aborted) return CANCELLED
      const result = await run({
        shell,
        command: registered.gate,
        worktree: { path: worktree.path, clone: worktree.clone },
        timeoutMs: registered.gateTimeoutMs,
        env: await withMiseShims(gateEnvironment(registered.gateEnv, { clone: worktree.clone, worktree: worktree.path }), environment()),
        log: file,
        signal,
        sessionId,
        ...deps.now === undefined ? {} : { now: deps.now },
      })
      if (result.kind === 'cancelled') return CANCELLED
      if (result.kind === 'error') return error(result.reason, result.durationMs)
      const passed = result.exitCode === 0 && !result.timedOut
      const took = duration(result.durationMs)
      log('info', 'open_pr\'s gate for %s at %s: %s', oneLine(where), commit.slice(0, 12), passed ? `passed in ${took}` : `failed in ${took} (${ending(result)})`)
      return {
        outcome: passed ? 'passed' : 'failed',
        // The gate as it is shown, never run: open_pr records it, and may put it on GitHub.
        command: maskSecrets(registered.gate),
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        log: result.log,
        excerpt: excerptOf(result.output),
        at: now(),
        head: commit,
      }
    }

    let outcome: GateCheck | typeof CANCELLED | undefined
    try {
      const workspaces = deps.workspaces()
      if (workspaces === undefined) return error(NO_WORKSPACES)
      const worktree = await workspaces.resolve(worktreePath)
      if (worktree === undefined) {
        const problem = await workspaces.resolveProblem(worktreePath)
        return error(problem !== undefined && problem.trim() !== '' ? problem : `no worktree dish made at ${String(worktreePath)} in a registered project`)
      }
      if (worktree.project.toLowerCase() !== String(project).toLowerCase()) {
        return error(`the worktree ${String(worktreePath)} is ${worktree.project}'s, not ${String(project)}'s`)
      }
      where = `${worktree.project}/${worktree.slug}`
      outcome = await deps.locks.run(worktree.path, signal, () => job(worktree, workspaces))
    } catch (thrown) {
      if (callerSignal?.aborted === true) throw abortReason(callerSignal)
      return error(`dish-gates failed: ${messageOf(thrown)}`)
    }
    if (outcome !== undefined && outcome !== CANCELLED) return outcome
    // Cancelled: the lock given up, or the run. The caller's abort is its own to hear; the plugin's is an error.
    if (callerSignal?.aborted === true) throw abortReason(callerSignal)
    return error(STOPPED)
  }
}
