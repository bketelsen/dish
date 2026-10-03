/**
 * dish-gates: the gate that runs when a crew coder bound to a worktree finishes.
 *
 * A host plugin, like dish-crew's host, so its listeners hear every agent, children included: dsh dispatches an agent's
 * events through a carrier that admits every listener whose context has no scope, and a session's `session/event` through
 * the session store's (see `test/plugin.test.ts`, which runs a real child through dsh's agent loop). The plugin:
 *
 * - keeps the head of each session's newest closing message, from `session/event` (`closing.ts`), for the opt-out, and
 *   whether its newest message calls tools: a coder that does hasn't finished, and isn't gated;
 * - hears dsh-tools' `tools/result` for a coder's `report` (crew's tool, step 7): a successful `report` that concluded the
 *   turn is kept with its `status` (`closing.ts`), so that stop is gated (`done`) or skipped (`blocked`, `needs_context`);
 * - gates a bound coder's end of turn, from `agent/turn-stopping` (`listener.ts`): it runs the project's gate in the
 *   coder's worktree through dsh's sandboxed shell, records the result in crew's record with the worktree's HEAD
 *   (`dishWorkspaces.headOf`), publishes it on `dish-gates/result`, and steers a failure back to the coder, up to
 *   `maxRounds` gate runs per turn. A stop crew sent back to call `report` (`dishCrew.reportSteered`) isn't gated;
 * - provides `dishGates`, whose `gateFor(project)` is the gate it runs for a project's bound coders (projects.yaml's, as
 *   it is now). Crew reads it structurally: the service being there says gates run, which turns crew's review check and
 *   the finish notice's gate line on, and `gateFor` gives the gate sentence in a bound coder's brief. `runAt` runs that
 *   gate in a worktree dish made, at its HEAD, for open_pr (`check.ts`), in the same per-worktree lock as a coder's gate.
 *   It is there only while the plugin runs;
 * - prunes its logs (`<state>/gates`, `.log` files older than 30 days and the directories they leave empty) in the
 *   background at start, and again every day while it runs;
 * - logs as `dish-gates`, and prints its own lines when `terminal` is on.
 *
 * It injects nothing and waits for nothing: `dishCrew`, `dishWorkspaces`, `dishProjects` and dsh's `shell` are read with
 * `ctx.get` each time they are used, so there is no load order to keep, and a service that comes and goes is followed.
 * `apply` is synchronous: the listeners are there before anything could be awaited. When the plugin goes, one abort
 * cancels every gate that is running: nothing more is recorded, steered or published for it, and a `runAt` that was running
 * gives an `error`.
 *
 * **`dish-gates/result`** is published with `ctx.parallel` and awaited, inside `agent/turn-stopping`: its listeners run
 * before the coder's turn can close, and before that run's `subagent/end`. A listener's failure is logged once per distinct
 * message, and changes nothing; nothing is published once the plugin is going away.
 *
 * @module dish-gates
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { maskSecrets, printOwnLogs, xdgPaths } from 'dish-kit'
import { gateCheck } from './check.ts'
import type { GateCheck, RunAtOptions } from './check.ts'
import { ClosingHeads } from './closing.ts'
import type { BaseEnvironment } from './env.ts'
import { DEFAULT_MAX_ROUNDS, gateListener } from './listener.ts'
import type { GateResultEvent } from './listener.ts'
import { WorktreeLocks } from './locks.ts'
import { pruneLogs } from './logs.ts'
import type { runGate } from './run.ts'
import { DEFAULT_TAIL_LINES } from './text.ts'

export type { GateCheck, GateResultEvent, RunAtOptions }

export const name = 'dish-gates'

export interface Config {
  maxRounds: number
  tailLines: number
  terminal: boolean
}

export const Config: Schema<Config> = Schema.object({
  maxRounds: Schema.natural().min(1).default(DEFAULT_MAX_ROUNDS)
    .description('The most gate runs in one turn of a coder. A failure with rounds left goes back to the coder to fix; the failure in the last round ends its turn, and the main agent decides what is next.'),
  tailLines: Schema.natural().min(10).default(DEFAULT_TAIL_LINES)
    .description('How many of a failed gate\'s last lines of output the coder is sent (at most 16 KiB). The whole output is in the gate\'s log.'),
  terminal: Schema.boolean().default(true)
    .description('Print this plugin\'s messages to the terminal.'),
})

/** The `dishGates` service. */
export interface DishGates {
  /**
   * The gate dish-gates runs for a coder bound to a worktree of `project`, to show it: projects.yaml's `gate` as it is now,
   * with anything that looks like a credential masked (crew puts it in the coder's brief); `undefined` for a project that
   * isn't registered, or without dish-projects.
   */
  gateFor(project: string): Promise<string | undefined>
  /**
   * The project's gate in a worktree dish made, at its HEAD, as a coder's gate runs (sandbox, timeout, gateEnv), for
   * `options.sessionId`: open_pr's. With `options.head`, a worktree whose HEAD isn't that commit is an `error`, and nothing
   * runs. Recorded nowhere. Rejects only without a `sessionId` (a TypeError) and when `options.signal` aborts (its reason).
   */
  runAt(project: string, worktreePath: string, options: RunAtOptions): Promise<GateCheck>
}

// Here, with the type, so that whoever imports it also gets `ctx.get('dishGates')` typed.
declare module '@deepseek-ai/cordis' {
  interface Context {
    dishGates: DishGates
  }
  interface Events {
    /** dish-gates recorded `result` for crew child `childId` of session `sessionId`, after addGate kept it. */
    'dish-gates/result'(e: GateResultEvent): void
  }
}

/** For tests only, never config. */
export interface GatesInternals {
  /** dish's state directory; the logs go under `<state>/gates`. Default: `xdgPaths('dish').state`. */
  state?: string
  now?: () => number
  run?: typeof runGate
  /** dsh's own environment, for the gate's `PATH`. Default: `process.env`. */
  environment?: () => Readonly<BaseEnvironment>
}

/** How often the logs are pruned while the plugin runs, besides at start. */
export const PRUNE_EVERY_MS = 86_400_000

/** How many distinct failures (pruning, a dish-gates/result listener) are remembered as logged. */
const TOLD_MAX = 100

function describe(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error)
  } catch {
    return 'an error that can\'t be printed'
  }
}

/** Whether `error` is cordis refusing an effect because a plugin has been unloaded: a plugin that is going away didn't fail. */
function unloaded(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'INACTIVE_EFFECT'
}

export function apply(ctx: Context, config: Config): void {
  start(ctx, config, {})
}

/** `apply`, with `internals`. */
export function start(ctx: Context, config: Config, internals: GatesInternals): void {
  const logger = ctx.logger(name)
  if (config.terminal) printOwnLogs(ctx, name)
  const state = internals.state ?? xdgPaths('dish').state
  const now = internals.now ?? Date.now

  // One abort for everything the plugin runs: a gate that is running when the plugin goes is cancelled, and its result
  // is neither recorded, steered nor published. Nothing is published once the plugin is going away.
  const stopped = new AbortController()
  let live = true
  ctx.effect(() => () => {
    live = false
    stopped.abort(new Error('dish-gates stopped'))
  })

  // The closing message comes from `session/event`, which a session calls inside its append: the step's message is seen
  // before `agent/turn-stopping`. Every session's, children's included. A coder's `report` comes from dsh-tools'
  // `tools/result`, emitted after the step's message and before `agent/turn-stopping`.
  const heads = new ClosingHeads()
  ctx.on('session/event', (session, event) => { heads.observe(session, event) })
  ctx.on('tools/result', (exec, result) => { heads.toolResult(exec, result) })

  // `dish-gates/result`: every listener is called and settled (`ctx.parallel`), and awaited. A failure is logged once
  // per distinct message, and never thrown.
  const told = new Set<string>()
  const warnOnce = (message: string): void => {
    if (told.has(message) || told.size >= TOLD_MAX) return
    told.add(message)
    try {
      logger.warn('%s', message)
    } catch {
      // A logger that throws is not worth a failed turn.
    }
  }
  const publish = async (event: GateResultEvent): Promise<void> => {
    if (!live) return
    try {
      await ctx.parallel('dish-gates/result', event)
    } catch (error) {
      for (const cause of error instanceof AggregateError ? error.errors : [error]) {
        if (!unloaded(cause)) warnOnce(maskSecrets(`a dish-gates/result listener failed: ${describe(cause)}`))
      }
    }
  }

  // One lock for a coder's gate and open_pr's: they never run at once in a worktree.
  const locks = new WorktreeLocks()
  const environment = internals.environment === undefined ? {} : { environment: internals.environment }

  ctx.on('agent/turn-stopping', gateListener({
    crew: () => ctx.get('dishCrew'),
    workspaces: () => ctx.get('dishWorkspaces'),
    projects: () => ctx.get('dishProjects'),
    shell: () => ctx.get('shell'),
    closing: agent => heads.closing(agent.session),
    settings: () => ({ maxRounds: config.maxRounds, tailLines: config.tailLines }),
    state,
    signal: stopped.signal,
    logger,
    publish,
    locks,
    ...internals.now === undefined ? {} : { now: internals.now },
    ...internals.run === undefined ? {} : { run: internals.run },
    ...environment,
  }))

  const runAt = gateCheck({
    workspaces: () => ctx.get('dishWorkspaces'),
    projects: () => ctx.get('dishProjects'),
    shell: () => ctx.get('shell'),
    state,
    signal: stopped.signal,
    locks,
    logger,
    ...internals.now === undefined ? {} : { now: internals.now },
    ...internals.run === undefined ? {} : { run: internals.run },
    ...environment,
  })

  // Pruning: at start, in the background, and every day while the plugin runs. A failure is logged once per distinct
  // message, and the gates run all the same: old logs that stay are only disk.
  const prune = async (): Promise<void> => {
    try {
      const removed = await pruneLogs(state, now())
      if (removed > 0) logger.info('removed %d gate log(s) older than 30 days', removed)
    } catch (error) {
      warnOnce(maskSecrets(`could not prune old gate logs in ${state}: ${describe(error)}`))
    }
  }
  void prune()
  ctx.effect(() => {
    const timer = setInterval(() => { void prune() }, PRUNE_EVERY_MS)
    timer.unref()
    return () => { clearInterval(timer) }
  })

  const gateFor = async (project: string): Promise<string | undefined> => {
    const projects = ctx.get('dishProjects')
    if (projects === undefined) return undefined
    const gate = (await projects.get(project))?.gate
    return gate === undefined ? undefined : maskSecrets(gate)
  }
  ctx.provide('dishGates', { gateFor, runAt } satisfies DishGates)
}
