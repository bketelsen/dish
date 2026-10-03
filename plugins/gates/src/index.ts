/**
 * dish-gates: the gate that runs when a crew coder bound to a worktree finishes.
 *
 * A host plugin, like dish-crew's host, so its listeners hear every agent, children included: dsh dispatches an agent's
 * events through a carrier that admits every listener whose context has no scope, and a session's `session/event` through
 * the session store's (see `test/plugin.test.ts`, which runs a real child through dsh's agent loop). The plugin:
 *
 * - keeps the head of each session's newest closing message, from `session/event` (`closing.ts`), for the opt-out, and
 *   whether its newest message calls tools: a coder that does hasn't finished, and isn't gated;
 * - gates a bound coder's end of turn, from `agent/turn-stopping` (`listener.ts`): it runs the project's gate in the
 *   coder's worktree through dsh's sandboxed shell, records the result in crew's record, and steers a failure back to
 *   the coder, up to `maxRounds` gate runs per turn;
 * - provides `dishGates`, whose `gateFor(project)` is the gate it runs for a project's bound coders (projects.yaml's, as
 *   it is now). Crew reads it structurally: the service being there says gates run, which turns crew's review check and
 *   the finish notice's gate line on, and `gateFor` gives the gate sentence in a bound coder's brief. It is there only
 *   while the plugin runs;
 * - prunes its logs (`<state>/gates`, `.log` files older than 30 days and the directories they leave empty) in the
 *   background at start, and again every day while it runs;
 * - logs as `dish-gates`, and prints its own lines when `terminal` is on.
 *
 * It injects nothing and waits for nothing: `dishCrew`, `dishWorkspaces`, `dishProjects` and dsh's `shell` are read with
 * `ctx.get` each time they are used, so there is no load order to keep, and a service that comes and goes is followed.
 * `apply` is synchronous: the listeners are there before anything could be awaited. When the plugin goes, one abort
 * cancels every gate that is running: nothing more is recorded or steered for it.
 *
 * @module dish-gates
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { maskSecrets, printOwnLogs, xdgPaths } from 'dish-kit'
import { ClosingHeads } from './closing.ts'
import type { BaseEnvironment } from './env.ts'
import { DEFAULT_MAX_ROUNDS, gateListener } from './listener.ts'
import { pruneLogs } from './logs.ts'
import type { runGate } from './run.ts'
import { DEFAULT_TAIL_LINES } from './text.ts'

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
}

// Here, with the type, so that whoever imports it also gets `ctx.get('dishGates')` typed.
declare module '@deepseek-ai/cordis' {
  interface Context {
    dishGates: DishGates
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

/** How many distinct pruning failures are remembered as logged. */
const TOLD_MAX = 100

function describe(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error)
  } catch {
    return 'an error that can\'t be printed'
  }
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
  // is neither recorded nor steered.
  const stopped = new AbortController()
  ctx.effect(() => () => { stopped.abort(new Error('dish-gates stopped')) })

  // The closing message comes from `session/event`, which a session calls inside its append: the step's message is seen
  // before `agent/turn-stopping`. Every session's, children's included.
  const heads = new ClosingHeads()
  ctx.on('session/event', (session, event) => { heads.observe(session, event) })

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
    ...internals.now === undefined ? {} : { now: internals.now },
    ...internals.run === undefined ? {} : { run: internals.run },
    ...internals.environment === undefined ? {} : { environment: internals.environment },
  }))

  // Pruning: at start, in the background, and every day while the plugin runs. A failure is logged once per distinct
  // message, and the gates run all the same: old logs that stay are only disk.
  const told = new Set<string>()
  const prune = async (): Promise<void> => {
    try {
      const removed = await pruneLogs(state, now())
      if (removed > 0) logger.info('removed %d gate log(s) older than 30 days', removed)
    } catch (error) {
      const message = maskSecrets(`could not prune old gate logs in ${state}: ${describe(error)}`)
      if (told.has(message) || told.size >= TOLD_MAX) return
      told.add(message)
      try {
        logger.warn('%s', message)
      } catch {
        // A logger that throws is not worth an unhandled rejection.
      }
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
  ctx.provide('dishGates', { gateFor } satisfies DishGates)
}
