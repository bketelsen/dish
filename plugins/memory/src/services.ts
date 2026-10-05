/**
 * The other plugins' services, as dish-memory reads them: each with `ctx.get` on each use (a service may come, go and come
 * back), and none needed at load. Each is typed by what the service uses of it, structurally, so a test's fake is a few
 * lines; the checks at the end make sure the real services still fit, so a method a sibling changes is a compile error
 * here, not a surprise at run time. Their types come in with `import type` only: dish-memory doesn't load those plugins.
 *
 * @module dish-memory/services
 */

import type { Context } from '@deepseek-ai/cordis'
import type { DishConfigService } from 'dish-config'
import type { DishJudge, TextScreen, TextScreenRequest } from 'dish-judge'
import type { DishProjects } from 'dish-projects'
import type { DishWorkspaces } from 'dish-workspaces'

/** What the service uses of the config store: a family's direction, read and written, and the proposals waiting on it. */
export type DishConfigLike = Pick<DishConfigService, 'read' | 'head' | 'write' | 'proposals'>

/** What it uses of dish-projects: each project's family and role. */
export interface ProjectsReader {
  list(): Promise<{ name: string, family: string, role: string }[]>
}

/** What it uses of dish-workspaces: where a project's clone is. */
export interface WorkspacesReader {
  describe(name: string): { clone: string } | undefined
}

/** What it uses of dish-judge: the screen of a text. */
export interface JudgeReader {
  screenText(request: TextScreenRequest): Promise<TextScreen>
}

/** Each sibling's service as it is now, or `undefined` when its plugin isn't running. */
export interface Services {
  config(): DishConfigLike | undefined
  projects(): ProjectsReader | undefined
  workspaces(): WorkspacesReader | undefined
  judge(): JudgeReader | undefined
}

/** The services of `ctx`, each read with `ctx.get` on each call. */
export function contextServices(ctx: Context): Services {
  const lookup = ctx as unknown as { get(name: string): unknown }
  return {
    config: () => lookup.get('dishConfig') as DishConfigLike | undefined,
    projects: () => lookup.get('dishProjects') as ProjectsReader | undefined,
    workspaces: () => lookup.get('dishWorkspaces') as WorkspacesReader | undefined,
    judge: () => lookup.get('dishJudge') as JudgeReader | undefined,
  }
}

// These fail to compile if a sibling's service stops fitting what is read of it.
type Fits<Real, Reader> = [Real] extends [Reader] ? true : false
type Check<T extends true> = T
/** The real services are what the readers say. */
export type ServicesFit = [
  Check<Fits<DishProjects, ProjectsReader>>,
  Check<Fits<DishWorkspaces, WorkspacesReader>>,
  Check<Fits<DishJudge, JudgeReader>>,
]
