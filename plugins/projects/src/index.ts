/**
 * dish-projects — the projects dish works on, as a Cordis plugin.
 *
 * The registry is `projects.yaml` in the config store, and this plugin offers it to the rest of dish as the
 * `dishProjects` service (see `service.ts`):
 *
 * - `dishConfig` is optional. When the store is there, the plugin claims `projects.yaml` (an agent may only propose
 *   changes) and seeds it empty. Without it there are no projects.
 * - Each project is onboarded by `dish-workspaces` (read with `ctx.get('dishWorkspaces')`), one at a time, in the
 *   background (see `onboarding.ts`), when it appears in the registry, at start for each project not yet ready, and
 *   on `retry`; a ready project is only prepared at start. Removing a project aborts its onboarding. Each project's
 *   status is kept in `<state>/projects/status.json` (`<state>` is dish-kit's `xdgPaths('dish').state`).
 * - It emits `dish-projects/changed` (the registry changed) and `dish-projects/status` (a project's status changed).
 * - The Projects page's server half is the `dishProjectsRemote` Typert remote (see `remote.ts`), served by the
 *   gateway when there is one and idle otherwise.
 * - Nothing in `apply` waits for the store or dish-workspaces, and dsh's start never waits on onboarding. Only the
 *   small status file is read at once, so that a ready project reads ready from the first moment.
 *
 * @module dish-projects
 */
import { join } from 'node:path'
import type { Context, Events } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { printOwnLogs, xdgPaths } from 'dish-kit'
import { statusMessage } from './onboarding.ts'
import type { WorkspacesDriver } from './onboarding.ts'
import { PROJECTS_PATH, SEED_TEXT, namespaceSpec } from './registry.ts'
import { ProjectsRemote } from './remote.ts'
import { createDishProjects } from './service.ts'
import type { DishProjects } from './service.ts'
import { StatusStore } from './status.ts'

export type { DishProjects } from './service.ts'
export type { ProjectState, ProjectStatus } from './status.ts'
export type { Project, ProjectFields } from './registry.ts'
export type { WorkspacesDriver } from './onboarding.ts'

export const name = 'dish-projects'

export interface Config {
  terminal: boolean
}

export const Config: Schema<Config> = Schema.object({
  terminal: Schema.boolean().default(true)
    .description('Print this plugin\'s messages to the terminal.'),
})

/** Where each project's onboarding status is kept. */
function statusFile(): string {
  return join(xdgPaths('dish').state, 'projects', 'status.json')
}

/** Whether `error` is cordis refusing an effect because the plugin has been unloaded: a plugin that is going away didn't fail. */
function unloaded(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'INACTIVE_EFFECT'
}

/** An error's text as a log line may carry it: masked and cut short. */
function describe(error: unknown): string {
  return statusMessage(error instanceof Error ? error.message : String(error))
}

/**
 * Provide `dishProjects` at once; claim and seed `projects.yaml` whenever the store is there; drive onboarding when
 * the store or `projects.yaml` changes, and again (as at start) whenever `dishWorkspaces` appears.
 */
export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger(name)
  if (config.terminal) printOwnLogs(ctx, name)

  // `ctx.parallel` calls every listener and settles them all, so a failing listener is only logged. Nothing is told
  // once the plugin is going away.
  let live = true
  const publish = <K extends keyof Events>(event: K, ...args: Parameters<Events[K]>): void => {
    if (!live) return
    try {
      ctx.parallel(event, ...args).catch((error: unknown) => {
        for (const cause of error instanceof AggregateError ? error.errors : [error]) logger.warn('a %s listener failed: %s', event, describe(cause))
      })
    } catch (error) {
      if (!unloaded(error)) logger.warn('could not emit %s: %s', event, describe(error))
    }
  }

  // `ctx.get` is read on every use, by name: the store and dish-workspaces are optional siblings of this plugin (never
  // ancestors, so a property read would throw), and may come, go and come back.
  const lookup = ctx as unknown as { get(name: string): unknown }
  const service = createDishProjects({
    store: () => ctx.get('dishConfig'),
    status: new StatusStore(statusFile()),
    workspaces: () => lookup.get('dishWorkspaces') as WorkspacesDriver | undefined,
    changed: names => publish('dish-projects/changed', names),
    emitStatus: (project, status) => publish('dish-projects/status', project, status),
    logger,
  })
  ctx.effect(() => () => {
    live = false
    service.close()
  })

  // Only the documented methods: the driving is the plugin's own.
  const dishProjects: DishProjects = {
    list: () => service.list(),
    get: project => service.get(project),
    status: project => service.status(project),
    retry: project => service.retry(project),
    problem: () => service.problem(),
  }
  ctx.provide('dishProjects', dishProjects)
  // Settings → Projects' server half: a child plugin that needs `dishProjects`, so it goes when the service does.
  ctx.plugin(ProjectsRemote)

  ctx.on('dish-config/changed', (paths) => {
    if (paths.includes(PROJECTS_PATH)) void service.drive()
  })

  // dish-workspaces starting (or coming back) is a start for its clones: what isn't ready is onboarded, what is is
  // prepared. When it goes, the onboarding it was doing can't finish.
  ctx.inject(['dishWorkspaces'], (inner) => {
    inner.effect(() => () => service.workspacesGone())
    void service.drive({ restart: true })
  })

  // Whenever the store is there: claim projects.yaml and seed it, as effects of the store's presence, so that a later
  // store gets them again. A claim that is refused (someone else owns the path) or a seed that fails is logged; the
  // registry is read all the same.
  ctx.inject(['dishConfig'], async (child) => {
    const store = child.dishConfig
    let present = true
    child.effect(() => () => { present = false })
    let claimed = true
    try {
      child.effect(() => child.dishConfig.claim(namespaceSpec(name)))
    } catch (error) {
      claimed = false
      // Unless the store is going away, which took the effect with it.
      if (!unloaded(error)) logger.warn('could not claim %s: %s', PROJECTS_PATH, describe(error))
    }
    if (claimed) {
      try {
        await store.seed({ [PROJECTS_PATH]: SEED_TEXT }, name)
      } catch (error) {
        // Unless the store is going away, which closed it under the seed.
        if (present) logger.warn('could not seed %s: %s', PROJECTS_PATH, describe(error))
      }
    }
    if (present) void service.drive()
  })
}
