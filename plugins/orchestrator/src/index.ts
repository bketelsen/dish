/**
 * dish-orchestrator: runs (a change on its way to a pull request, owned by its project, driven by one chat at a time,
 * resumable, and reopened for review feedback on its pull request), a ledger per run that the harness writes, the main
 * agent's `run`, `open_pr` and `pr_feedback` tools, the `dishRuns` service, and the read-only Settings → Runs page.
 *
 * A host plugin, like dish-gates: its listeners hear crew's `dish-crew/delegated` and `dish-crew/settled` and dish-gates'
 * `dish-gates/result`, published with `ctx.parallel`, and turn them into the harness's ledger entries (`listeners.ts`). It
 * reads `dishWorkspaces`, `dishCrew`, `dishGates`, `dishProjects` and dsh's `agents` with `ctx.get` on each use
 * (`services.ts`), so there is no load order to keep, and injects only `tools` (for its tools) and, through its remote,
 * `remote`. `start` is synchronous: the listeners and the service are there before anything is awaited; the store is read
 * in the background, and every method waits for it.
 *
 * Records and ledgers live where `paths.ts` puts them, under dish's state and data directories (dish-kit's `xdgPaths('dish')`,
 * so under `DSH_DISH_HOME` when it is set). Nothing prunes either: ledgers are kept for good. When the plugin goes, the
 * appends and writes already queued are finished.
 *
 * @module dish-orchestrator
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { printOwnLogs, xdgPaths } from 'dish-kit'
import { Ledger } from './ledger.ts'
import { createListeners } from './listeners.ts'
import { openPrTool } from './open-pr.ts'
import { prFeedbackTool } from './pr-feedback.ts'
import { runsRemote } from './remote.ts'
import { describe, Runs } from './runs.ts'
import type { ToolDeps } from './runs.ts'
import { runTool } from './run-tool.ts'
import { dishRunsOf } from './service.ts'
import { contextServices } from './services.ts'
import { RunStore } from './store.ts'

export type { CreatedForRun, DishRuns, JoinedRun, LadderEntry, Placement, PlaceTarget, RunInfo } from './service.ts'
export type { Run, RunState } from './store.ts'
export type { Kind, LedgerEntry } from './entries.ts'

export const name = 'dish-orchestrator'

export interface Config {
  terminal: boolean
}

export const Config: Schema<Config> = Schema.object({
  terminal: Schema.boolean().default(true).description('Print this plugin\'s messages to the terminal.'),
})

/** For tests only; never config. */
export interface OrchestratorInternals {
  /** dish's state directory, for the records (paths.ts). Default: `xdgPaths('dish').state`. */
  state?: string
  /** dish's data directory, for the ledgers (paths.ts). Default: `xdgPaths('dish').data`. */
  data?: string
  now?: () => number
}

export function apply(ctx: Context, config: Config): void {
  start(ctx, config, {})
}

/** `apply`, with `internals`. Gives the core, which tests drive; the plugin's own handle on it is `ctx.dishRuns`. */
export function start(ctx: Context, config: Config, internals: OrchestratorInternals): Runs {
  const logger = ctx.logger(name)
  if (config.terminal) printOwnLogs(ctx, name)
  const paths = internals.state === undefined || internals.data === undefined ? xdgPaths('dish') : undefined
  const state = internals.state ?? paths!.state
  const data = internals.data ?? paths!.data
  const now = internals.now ?? Date.now

  const say = (level: 'info' | 'warn', format: string, args: unknown[]): void => {
    try {
      logger[level](format, ...args)
    } catch {
      // A logger that throws is not worth a failed delegation.
    }
  }
  const store = new RunStore(state, {
    now,
    onCorrupt: (file, aside, problem) => {
      say('warn', aside === ''
        ? 'skipped run record %s and left it where it is: it couldn\'t be read or set aside (%s)'
        : 'run record %s is not valid (%s); it was moved to %s, and the run is no longer listed', aside === '' ? [file, problem ?? 'unknown'] : [file, problem ?? 'unknown', aside])
    },
  })
  const ledger = new Ledger(data)
  const services = contextServices(ctx)
  const runs = new Runs({
    store, ledger, services, now,
    logger: { info: (format, ...args) => { say('info', format, args) }, warn: (format, ...args) => { say('warn', format, args) } },
  })
  void runs.ready().catch(() => {
    // Logged by `ready`; every method tries again.
  })

  // The listeners return at once; their writes are queued before they do (see listeners.ts).
  const listeners = createListeners(runs)
  ctx.on('dish-crew/delegated', (e) => { listeners.delegated(e) })
  ctx.on('dish-crew/settled', (e) => { listeners.settled(e) })
  ctx.on('dish-gates/result', (e) => { listeners.gateResult(e) })

  ctx.provide('dishRuns', dishRunsOf(runs))

  // Global tools, registered through the child context, so they go when `tools` does, or this plugin.
  const deps: ToolDeps = { runs, services }
  ctx.inject(['tools'], (inner) => {
    for (const tool of [runTool(deps), openPrTool(deps), prFeedbackTool(deps)]) {
      if (tool === undefined) continue
      try {
        inner.tools.register(tool)
      } catch (error) {
        say('warn', 'could not register the %s tool: %s', [tool.name, describe(error)])
      }
    }
  })

  runsRemote(ctx, { store, ledger, live: run => runs.live(run) })

  // What is queued when the plugin goes is written before it is gone.
  ctx.effect(() => async () => {
    await ledger.flush()
    await store.flush()
  })
  return runs
}
