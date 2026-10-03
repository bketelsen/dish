/**
 * The other plugins' services, as orchestrator reads them: each with `ctx.get` on each use (a service may come, go and come
 * back), and each typed by a `Pick` of its own type, imported with `import type` only. A method the readers name that a
 * sibling changes is a compile error here, not a surprise at run time.
 *
 * @module dish-orchestrator/services
 */

import type { Context } from '@deepseek-ai/cordis'
import type { DishCrew } from 'dish-crew'
import type { DishGates } from 'dish-gates'
import type { DishProjects } from 'dish-projects'
import type { DishWorkspaces } from 'dish-workspaces'

/** What orchestrator uses of dish-workspaces: dish's own git (heads, cleanliness, the branch's standing, the push) and GitHub's pull requests. */
export type WorkspacesReader = Pick<DishWorkspaces, 'createWorktree' | 'resolve' | 'resolveProblem' | 'headOf' | 'isClean' | 'compareBranch'
  | 'pushBranch' | 'openPull' | 'updatePull' | 'commentPull' | 'readPull'>
/** What orchestrator uses of crew: its record (a child's tags after a restart), and who is bound to a worktree. */
export type CrewReader = Pick<DishCrew, 'records' | 'worktreeBindings'>
/** open_pr's gate. */
export type GatesReader = Pick<DishGates, 'runAt'>
/** A project's registration. */
export type ProjectsReader = Pick<DishProjects, 'get'>
/** dsh's agent registry (`ctx.agents`): the live agent of an id, if there is one (crew's `LiveAgents`, which its `isRunning` reads). */
export interface AgentsReader {
  get(id: string): unknown
}

/** Each sibling's service as it is now, or `undefined` when its plugin isn't running. */
export interface Services {
  workspaces(): WorkspacesReader | undefined
  crew(): CrewReader | undefined
  gates(): GatesReader | undefined
  projects(): ProjectsReader | undefined
  agents(): AgentsReader | undefined
}

/** The services of `ctx`, each read with `ctx.get` on each call. */
export function contextServices(ctx: Context): Services {
  const lookup = ctx as unknown as { get(name: string): unknown }
  return {
    workspaces: () => lookup.get('dishWorkspaces') as WorkspacesReader | undefined,
    crew: () => lookup.get('dishCrew') as CrewReader | undefined,
    gates: () => lookup.get('dishGates') as GatesReader | undefined,
    projects: () => lookup.get('dishProjects') as ProjectsReader | undefined,
    agents: () => lookup.get('agents') as AgentsReader | undefined,
  }
}
