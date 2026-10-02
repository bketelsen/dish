/**
 * The sweep: removing the task worktrees dish made once their branch is merged, with their local branches and records.
 * The service runs it for a project after each fetch it makes (`create`'s included) and in the hourly round, under the
 * project's lock.
 *
 * - **Which worktrees:** only those dish made (a record in its state directory, which agents can't write), each at
 *   `<clone>/.worktrees/<slug>` on `dish/<slug>`. Anything else under `.worktrees/` (6c's `.cache`, a plan's ledger, a
 *   worktree made by hand) is never looked at.
 * - **Merged** (`isMerged`): the pull request that holds the branch's tip is merged (GitHub's `commits/{tip}/pulls`
 *   lists one with `merged_at` set and `head.sha` the tip: squash merges included, and a branch that gained commits
 *   after its pull request merged excluded), or the branch has commits of its own and its tip is an ancestor of
 *   `origin/<default>`. A new worktree (its tip still the base `create` recorded) is never merged, whatever GitHub says
 *   about that commit.
 * - **Never removed:** a dirty worktree (modified or untracked files, ignored ones aside; a gitlink or a nested
 *   repository; a checkout that isn't its branch), one bound to a running coder, one `resolve`d in the last 5 minutes
 *   (a coder about to start), one whose `.git` isn't what git made, and one dish didn't make. Removal is
 *   `git worktree remove` without `--force` (git checks the tree is clean once more), then the branch is deleted only if
 *   it still is the tip that was found merged.
 * - **Ancestry** reads the clone's own `refs/remotes/origin/<default>`, which the fetch just before the sweep wrote, with
 *   dish's git ignoring replace refs, grafts and the commit-graph file (`SAFE_FLAGS`). A known limit: an agent that
 *   rewrites that ref between the fetch and the sweep can make a clean worktree's branch look merged, and have it
 *   removed with its commits; a worktree with a running coder (bound) or one about to start (recently resolved), and
 *   a dirty one, are kept whatever the ref says. Asking GitHub (`ls-remote`, as setup's check does) would close it.
 *
 * @module dish-workspaces/sweep
 */

import { maskSecrets } from 'dish-kit'
import type { Project } from 'dish-projects/registry'
import { git, maskUrlPasswords } from './git.ts'
import type { PullSummary } from './github.ts'
import type { WorktreeDeps, WorktreeRecord, WorktreeState, Worktrees } from './worktrees.ts'

export type MergedBy = 'pull-request' | 'ancestry'

export interface MergeCheck {
  merged: boolean
  by?: MergedBy
  /** The merged pull request's number, when `by` is `pull-request`. */
  pull?: number
  /** Why not, when it isn't merged. */
  reason?: string
}

export interface SweepResult {
  removed: Array<{ project: string, slug: string, by: MergedBy }>
  kept: Array<{ project: string, slug: string, reason: 'not-merged' | 'dirty' | 'bound' | 'recent' | 'missing' | 'error', detail?: string }>
}

/** For tests only, never set by dish: put on top of the environment of this module's git (a test's `GIT_CONFIG_NOSYSTEM`). */
export const internals: { gitEnv?: Record<string, string> } = {}

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
/**
 * A default branch dish will name in `refs/remotes/origin/<name>`: origin/HEAD is a ref an agent can write, so its
 * branch is checked before it reaches an argument. Plain names only: no leading `-`, no `..`, no space or control.
 */
const BRANCH_NAME = /^(?![-/])(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]{1,200}(?<![/.])$/

/**
 * The spec's rule, for a managed worktree whose branch `dish/<slug>` is at `tip`:
 * - a new worktree (tip is `record.base`) is never merged;
 * - a pull request in `pulls` with `mergedAt` set and `headSha` equal to the tip: merged by pull request;
 * - else the tip an ancestor of `refs/remotes/origin/<defaultBranch>`: merged by ancestry.
 *
 * Throws for a tip that isn't a commit id, a default branch that isn't a plain branch name, and a git failure (a
 * missing origin ref).
 */
export async function isMerged(clone: string, record: WorktreeRecord, tip: string, defaultBranch: string, pulls: PullSummary[]): Promise<MergeCheck> {
  if (!SHA.test(tip)) throw new Error(`${JSON.stringify(shown(tip, 80))} is not a commit id`)
  const branch = checkedBranch(defaultBranch)
  if (tip === record.base) return { merged: false, reason: 'it has no commits of its own' }
  const pull = pulls.find(item => item.mergedAt !== null && item.headSha.toLowerCase() === tip)
  if (pull !== undefined) return { merged: true, by: 'pull-request', pull: pull.number }
  const result = await git(['-C', clone, 'merge-base', '--is-ancestor', tip, `refs/remotes/origin/${branch}`], { env: { ...internals.gitEnv } })
  if (result.code === 0 && !result.timedOut && !result.aborted) return { merged: true, by: 'ancestry' }
  if (result.code === 1) return { merged: false, reason: `no merged pull request has its tip, and it isn't on origin/${branch}` }
  throw new Error(`git merge-base failed${result.timedOut ? ' (timed out)' : ` (exit ${result.code})`}: ${firstLine(result.stderr)}`)
}

/** `name`, if dish will put it in a ref; else throws. */
export function checkedBranch(name: string): string {
  if (typeof name !== 'string' || !BRANCH_NAME.test(name)) throw new Error(`origin's default branch ${JSON.stringify(shown(String(name), 80))} isn't a plain branch name`)
  return name
}

/** The clone's default branch (`deps.defaultBranch`: origin/HEAD's, else `main`), checked. */
export async function defaultBranchOf(deps: Pick<WorktreeDeps, 'defaultBranch'>, clone: string): Promise<string> {
  return checkedBranch(await deps.defaultBranch(clone))
}

/**
 * Whether a managed worktree's branch is merged, as `inspect` found it: a branch that's gone isn't; a new one isn't (and
 * GitHub isn't asked); else `deps.pulls` for the tip (an error is no pull requests), then `isMerged`.
 */
export async function checkMerged(project: Project, state: Pick<WorktreeState, 'clone' | 'record' | 'tip'>, defaultBranch: string, deps: Pick<WorktreeDeps, 'pulls'>): Promise<MergeCheck> {
  const { clone, record, tip } = state
  if (tip === undefined) return { merged: false, reason: `its branch ${record.branch} is gone` }
  if (tip === record.base) return { merged: false, reason: 'it has no commits of its own' }
  let pulls: PullSummary[]
  try {
    pulls = await deps.pulls(project, tip)
  } catch {
    // The caller's `pulls` logs its own errors; without GitHub's word, only ancestry counts.
    pulls = []
  }
  return isMerged(clone, record, tip, defaultBranch, pulls)
}

/**
 * One project: each managed record, in slug order.
 * - Its worktree's directory and its branch both gone (by hand): `git worktree prune`, and the record is dropped
 *   (`missing`).
 * - Else, in this order: a `.git` that isn't what git made (`error`), not merged, dirty, bound to a running coder,
 *   resolved in the last 5 minutes: kept with that reason. Otherwise removed (`git worktree remove`, never `--force`),
 *   with its branch and record. A directory gone by hand with its branch merged has its branch and record removed.
 * - A failure on one worktree is `error` (masked) and the round goes on.
 */
export async function sweepProject(project: Project, worktrees: Worktrees, deps: WorktreeDeps): Promise<SweepResult> {
  const result: SweepResult = { removed: [], kept: [] }
  const records = await worktrees.records(project)
  let defaultBranch: string | undefined
  for (const record of records) {
    const keep = (reason: SweepResult['kept'][number]['reason'], detail?: string): void => {
      result.kept.push({ project: project.name, slug: record.slug, reason, ...(detail === undefined ? {} : { detail: shown(detail, 300) }) })
    }
    try {
      const state = await worktrees.inspect(project, record)
      if (!state.exists && state.tip === undefined) {
        await worktrees.discard(project, state, false)
        keep('missing', 'its worktree and its branch were removed by hand; the record was dropped')
        continue
      }
      if (state.problem !== undefined) {
        keep('error', state.problem)
        continue
      }
      defaultBranch ??= await defaultBranchOf(deps, state.clone)
      const merge = await checkMerged(project, state, defaultBranch, deps)
      if (!merge.merged || merge.by === undefined) {
        keep('not-merged', merge.reason)
        continue
      }
      if (state.exists) {
        const dirty = await worktrees.dirty(state.clone, state.path, record.branch)
        if (dirty !== undefined) {
          keep('dirty', `merged but dirty: ${dirty}`)
          continue
        }
      }
      const running = (await deps.bindings(state.path)).filter(binding => binding.running)
      if (running.length > 0) {
        keep('bound', `bound to a running coder (${running.map(binding => binding.child).join(', ')})`)
        continue
      }
      if (worktrees.recentlyResolved(state.path)) {
        keep('recent', 'resolved for a coder in the last 5 minutes')
        continue
      }
      await worktrees.discard(project, state, false)
      result.removed.push({ project: project.name, slug: record.slug, by: merge.by })
    } catch (error) {
      keep('error', error instanceof Error ? error.message : String(error))
    }
  }
  return result
}

/** The first non-empty line of git's stderr, shown safely. */
function firstLine(stderr: string): string {
  return shown(stderr.split(/[\r\n]+/).map(part => part.trim()).find(part => part !== '') ?? '', 200)
}

/** Text from outside (a path, a ref, git's stderr) as a message shows it: no control characters, masked, cut to `max`. */
function shown(text: string, max: number): string {
  const masked = maskSecrets(maskUrlPasswords(text.slice(0, 64 * 1024).replace(/[\x00-\x1f\x7f]/g, ' ')))
  const chars = Array.from(masked)
  return chars.length > max ? maskSecrets(`${chars.slice(0, max - 1).join('')}…`) : masked
}
