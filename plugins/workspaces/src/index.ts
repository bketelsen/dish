/**
 * dish-workspaces — clones, worktrees and the GitHub App behind dish's projects, as a Cordis plugin.
 *
 * It provides the `dishWorkspaces` service (see `service.ts`), which dish-projects drives (onboarding, and `prepare` at
 * each start) and crew reads (`resolve`, for `delegate`'s binding):
 *
 * - **Needs nothing at load.** It reads `dishProjects`, `dishCrew` and `credentials` with `ctx.get` when it uses them,
 *   and waits for `tools` and `workspaceRegistry` with `ctx.inject`: both start later, and a profile other than `web`
 *   has no workspace registry. It never reads `dishConfig`.
 * - **The App's credentials** are two references in dsh's credential store, named by the rows `appIdName` and
 *   `privateKeyName` (environment-variable names, checked at load), read on every use and never kept.
 * - **The `worktree` tool** registers whenever a `tools` service is there (see `tool.ts`).
 * - **Settings → GitHub App's server half** is the `dishWorkspacesRemote` Typert remote (see `remote.ts`), served by the
 *   gateway for as long as `dishWorkspaces` is. It tells the card what GitHub says of the App (`appStatus`) and takes
 *   nothing from it: the ID and the key go from the browser to dsh's own credential store.
 * - **The workspace registry,** each time one appears: the scratch workspace (once) and every ready project without a
 *   workspace are registered; the service uses it until it goes.
 * - **Nothing in `apply` is awaited:** the clone states are read at once (small files), and the token recompute, the
 *   prune of old token files and the hourly round run in the background. When the plugin goes, every timer is cleared,
 *   the work in flight is aborted and waited for (its child processes killed), and the token files are removed.
 *
 * @module dish-workspaces
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { printOwnLogs } from 'dish-kit'
import { WorkspacesRemote } from './remote.ts'
import { createDishWorkspaces } from './service.ts'
import type { DishWorkspaces, WorkspacesInternals, WorkspacesService } from './service.ts'
import { worktreeTool } from './tool.ts'

export type { AppStatus, InstallationInfo } from './protocol.ts'
export type { CloneInfo, DishWorkspaces, WorkspacesInternals, WorkspacesService } from './service.ts'
export type { CreatedWorktree, Worktree, WorktreeInfo } from './worktrees.ts'
export type { SweepResult } from './sweep.ts'

export const name = 'dish-workspaces'

/** The credential references' default names. */
export const DEFAULT_APP_ID_NAME = 'DISH_GITHUB_APP_ID'
export const DEFAULT_PRIVATE_KEY_NAME = 'DISH_GITHUB_APP_PRIVATE_KEY'

export interface Config {
  appIdName: string
  privateKeyName: string
  terminal: boolean
}

export const Config: Schema<Config> = Schema.object({
  appIdName: Schema.string().default(DEFAULT_APP_ID_NAME)
    .description('The name of the GitHub App\'s ID in dsh\'s credential store (an environment-variable name). Set the value on Settings → GitHub App.'),
  privateKeyName: Schema.string().default(DEFAULT_PRIVATE_KEY_NAME)
    .description('The name of the GitHub App\'s private key in dsh\'s credential store (an environment-variable name). Set the value on Settings → GitHub App.'),
  terminal: Schema.boolean().default(true)
    .description('Print this plugin\'s messages to the terminal.'),
})

/**
 * A credential reference from a row: the setting, or `fallback` when it is blank.
 * @throws a plain `Error` for anything that isn't an environment-variable name (judge's `keyNameOf` rule).
 */
export function referenceName(row: string, setting: string | undefined, fallback: string): string {
  const value = setting?.trim()
  if (value === undefined || value === '') return fallback
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`${row} must be an environment variable name: letters, digits and underscores, not starting with a digit`)
  }
  return value
}

/** Provide `dishWorkspaces`; register the tool and use the workspace registry whenever they are there. */
export function apply(ctx: Context, config: Config): void {
  start(ctx, config, {})
}

/**
 * What `apply` does, with `internals` for tests (the fakes, temp directories). Returns the service, which tests may
 * drive; the plugin's own handle on it is `ctx.dishWorkspaces`.
 * @throws a plain `Error` for an `appIdName` or `privateKeyName` that isn't an environment-variable name, before anything starts.
 */
export function start(ctx: Context, config: Config, internals: WorkspacesInternals): WorkspacesService {
  const appIdName = referenceName('appIdName', config.appIdName, DEFAULT_APP_ID_NAME)
  const privateKeyName = referenceName('privateKeyName', config.privateKeyName, DEFAULT_PRIVATE_KEY_NAME)
  if (config.terminal) printOwnLogs(ctx, name)

  const service = createDishWorkspaces(ctx, { appIdName, privateKeyName }, internals)
  ctx.effect(() => () => service.close())
  // Before anything can call it: the clone states are read now, so `describe` answers from the first moment.
  service.start()

  // Only the documented methods: the rest is the plugin's own.
  const dishWorkspaces: DishWorkspaces = {
    onboard: (project, options) => service.onboard(project, options),
    prepare: project => service.prepare(project),
    describe: project => service.describe(project),
    createWorktree: (project, slug, base, options) => service.createWorktree(project, slug, base, options),
    listWorktrees: project => service.listWorktrees(project),
    removeWorktree: (project, slug, force) => service.removeWorktree(project, slug, force),
    resolve: pathOrRef => service.resolve(pathOrRef),
    sweep: project => service.sweep(project),
    appStatus: test => service.appStatus(test),
  }
  ctx.provide('dishWorkspaces', dishWorkspaces)
  // Settings → GitHub App's server half: a child plugin that needs `dishWorkspaces`, so it goes when the service does.
  ctx.plugin(WorkspacesRemote, { appIdName, privateKeyName })

  // A global tool, registered through the child context, so it goes when `tools` does, or this plugin. The service is
  // read with `ctx.get` on each call.
  ctx.inject(['tools'], (inner) => {
    inner.tools.register(worktreeTool(() => ctx.get('dishWorkspaces')))
  })

  // dsh's registry has an asynchronous start, and only dsh-web-app mounts it: used for as long as it is there.
  ctx.inject(['workspaceRegistry'], (inner) => {
    const release = service.useRegistry(inner.workspaceRegistry)
    inner.effect(() => release)
  })

  ctx.on('dish-projects/changed', (names) => { service.projectsChanged(names) })
  // A registry can appear between onboarding's last step and dish-projects recording the project ready.
  ctx.on('dish-projects/status', (project, status) => { if (status.state === 'ready') service.registerIfMissing(project) })
  ctx.on('credentials/reference-updated', (ref) => { service.credentialsChanged(ref) })
  return service
}
