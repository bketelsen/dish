/**
 * The `dishRuns` service: what crew and dish-workspaces ask of orchestrator. Both read it structurally, with `ctx.get` and
 * local copies of these types, and work as before without it; neither package depends on this one.
 *
 * - **`driving`** says which open run a chat drives.
 * - **`place`** says where a child `delegate` is starting or following up belongs: a bound child in the run that owns its
 *   worktree, a reviewer where the child it reviews is, anything else in the run its chat drives; with the task's round,
 *   counted from the ledger. crew calls it inside its session lock, so it takes no lock, and it waits for the run's ledger.
 * - **`worktreeCreated`** and **`worktreeRemoved`** are the `worktree` tool's and the sweep's hooks: a worktree joins the
 *   run its chat drives in that project (or a run is opened around it), and a removed one leaves the runs that had it as a
 *   task. Neither is called under a lock of dish-workspaces, and neither calls one.
 * - **`ladder`** records a round the escalation ladder refused, or let through on a ruling.
 *
 * None rejects: a failure is logged by orchestrator and gives `undefined` (or nothing).
 *
 * @module dish-orchestrator/service
 */

import type { Runs } from './runs.ts'

/** An open run, as `driving` gives it. */
export interface RunInfo {
  /** `<owner>/<repo>/<id>`: what a child is tagged with; run ids are unique only in a project. */
  ref: string
  id: string
  project: string
  slug: string
  goal: string
  branch: string
  worktree: string
  state: 'open' | 'pr' | 'abandoned'
}

/** What `place` is asked. */
export interface PlaceTarget {
  /** A bound child's worktree: its canonical path (as crew records it) or `<owner>/<repo>/<slug>`. */
  worktree?: string
  /** A reviewer's: a child id, or 'main'. */
  reviews?: string
  /** A reviewer started, or followed up, with `final: true`. */
  final?: boolean
}

/** Where a delegation belongs. */
export interface Placement {
  /** The run's ref: crew stores it as ChildRecord.run. */
  run: string
  /** The task's slug: ChildRecord.task. */
  task?: string
  /** Given with `task`: the index a coder start or follow-up on it gets now (the first start is 0). */
  round?: number
  /** A reviewer placed in a run, asked for with `final`: ChildRecord.final. */
  final?: true
}

/** A round the escalation ladder refused, or let through on a ruling. */
export interface LadderEntry {
  sessionId: string
  /** Placement.run. */
  run: string
  task: string
  round: number
  outcome: 'refused' | 'ruled'
  /** For 'ruled': the ruling, as given. */
  ruling?: string
  /** A follow-up's target. */
  child?: string
}

/** What the `worktree` tool gives worktreeCreated: Task 6's `CreatedForRun`, field for field. */
export interface CreatedForRun {
  project: string
  slug: string
  branch: string
  path: string
  clone: string
  /** The commit (CreatedWorktree.base). */
  base: string
  /** The ref it was cut from (CreatedWorktree.baseRef). */
  baseRef: string
}

/** The run a new worktree joined, or was opened around. */
export interface JoinedRun {
  /** The run's id. */
  id: string
  /** true: a run was opened around the worktree; false: it joined the run this chat drives. */
  opened: boolean
  /** With `opened`: the id of the run this chat drove (in another project) and no longer does: released, still open. */
  released?: string
}

export interface DishRuns {
  /** The open run `sessionId` drives, or undefined. Never rejects. */
  driving(sessionId: string): Promise<RunInfo | undefined>
  /** Where a child `delegate` is starting or following up belongs. undefined when it belongs to no open run. Never rejects (a failure is logged, and gives undefined). */
  place(sessionId: string, target: PlaceTarget): Promise<Placement | undefined>
  /** The `worktree` tool made a worktree: it joins the run the session drives in that project, or a run is opened around it. Never rejects. */
  worktreeCreated(sessionId: string, created: CreatedForRun): Promise<JoinedRun | undefined>
  /** dish-workspaces removed a worktree (the tool, or the sweep): `task.removed` in each open or `pr` run of the project that has it as a task. Never rejects, and takes no lock. */
  worktreeRemoved(project: string, slug: string): Promise<void>
  /** `delegate` refused round 5+ on a task, or let it through on a ruling. Never rejects. */
  ladder(entry: LadderEntry): Promise<void>
}

// Here, with the type, so that whoever imports it also gets `ctx.get('dishRuns')` typed.
declare module '@deepseek-ai/cordis' {
  interface Context {
    dishRuns: DishRuns
  }
}

/** The service over `runs`: exactly the five methods, and nothing else of the core. */
export function dishRunsOf(runs: Runs): DishRuns {
  return {
    driving: sessionId => runs.driving(sessionId),
    place: (sessionId, target) => runs.place(sessionId, target),
    worktreeCreated: (sessionId, created) => runs.worktreeCreated(sessionId, created),
    worktreeRemoved: (project, slug) => runs.worktreeRemoved(project, slug),
    ladder: entry => runs.ladder(entry),
  }
}
