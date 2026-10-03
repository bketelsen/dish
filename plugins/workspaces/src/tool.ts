/**
 * The `worktree` tool: the main agent makes, lists and removes task worktrees in a registered project's clone.
 *
 * - **The main agent only,** like dish-config's tools: every call checks `isTopLevelAgent` before anything else, and
 *   crew never gives the tool to a child (it is on crew's never-list).
 * - **create** passes the calling chat's workspace (`exec.agent.session.header.cwd`) and the call's signal to
 *   `dishWorkspaces.createWorktree`, which refuses a project that isn't ready, a chat with no workspace, and a worktree
 *   outside it (a coder of that chat works in its sandbox, which is its workspace). Its answer is the path, the branch,
 *   the base commit and what setup did: in 6b setup doesn't run outside the sandbox in a worktree (the user's A, 2026-10-02), so
 *   the answer tells the main agent to run the command in it, in the sandbox, before the work starts (itself, or by telling the
 *   coder to run it first), and again escalated only if that fails with "Read-only file system" (the judge allows it or asks the user).
 * - **list** shows each worktree with the crew children bound to it (`dishCrew.worktreeBindings`); **remove** refuses
 *   one a running coder is bound to, even with `force`.
 * - **dish-orchestrator's hooks** (`dishRuns`, read on each call; without it, nothing changes): after `create`,
 *   `worktreeCreated` with the main agent's session (`String(exec.agent.id)`, as crew's `delegate` takes it) and the new
 *   worktree, and the answer says the run it opened or joined; after `remove`, `worktreeRemoved`. Both run after the
 *   service's call returned, so never under the project's lock. A hook that throws, or answers what isn't a run, is
 *   logged once and leaves the worktree as it is: `create` says why it has no run, `remove` stands.
 * - The service's refusals reach the model as plain `Error`s with its message (masked already). Models fill every
 *   optional parameter, often with `''`, so an empty string is taken as absent.
 *
 * @module dish-workspaces/tool
 */

import type {} from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { isTopLevelAgent } from 'dish-kit'
import { shown } from './git.ts'
import type { DishWorkspaces, RunsHooks } from './service.ts'
import type { WorktreeInfo } from './worktrees.ts'

export const MAIN_ONLY = 'the worktree tool is for the main agent only'

const STRING = { type: 'string', required: true } as const
const INTEGER = { type: 'integer', required: true } as const
const BOOLEAN = { type: 'boolean', required: true } as const

const BINDING = {
  type: 'object',
  additionalProperties: false,
  properties: { child: STRING, role: STRING, title: STRING, running: BOOLEAN },
} as const

const LISTED = {
  type: 'object',
  additionalProperties: false,
  properties: {
    project: STRING, slug: STRING, branch: STRING, path: STRING, base: STRING,
    ahead: INTEGER, behind: INTEGER, dirty: BOOLEAN, merged: BOOLEAN, managed: BOOLEAN,
    bound: { type: 'array', items: BINDING, required: true },
  },
} as const

const SETUP = {
  oneOf: [
    { type: 'object', additionalProperties: false, properties: { ran: { type: 'boolean', const: false, required: true }, reason: STRING } },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        ran: { type: 'boolean', const: true, required: true },
        exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }], required: true },
        timedOut: BOOLEAN,
        log: STRING,
      },
    },
  ],
} as const

/** A run id as dish-orchestrator makes them (`<yyyymmdd>-<slug>`, `-2`, …): one path segment. */
const RUN_ID = /^[A-Za-z0-9._-]{1,100}$/
/** The longest reason a `runProblem` gives. */
const RUN_PROBLEM_CHARS = 300

const OUTPUT = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', const: 'create', required: true },
        project: STRING, slug: STRING, path: STRING, branch: STRING, base: STRING,
        setup: { ...SETUP, required: true },
        run: { type: 'object', additionalProperties: false, properties: { id: STRING, opened: BOOLEAN } },
        runProblem: { type: 'string' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', const: 'list', required: true },
        worktrees: { type: 'array', items: LISTED, required: true },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', const: 'remove', required: true },
        project: STRING, slug: STRING, branch: STRING, forced: BOOLEAN,
      },
    },
  ],
} as const

const DESCRIPTION = 'Make, list and remove task worktrees in a registered project\'s clone (main agent only). '
  + 'Use one worktree per task. `create` (`project`, `slug`, optional `base`) makes `<clone>/.worktrees/<slug>` on a new branch `dish/<slug>`, '
  + 'cut from `origin/<default branch>` unless you give `base` (a branch, tag or commit, such as `origin/dish/plan-x`); '
  + 'it works only in a chat whose workspace is that project\'s clone. '
  + 'When dish keeps runs (dish-orchestrator), `create` also adds the worktree to the run this chat drives, or opens one; its answer says which. '
  + 'Its answer gives the path, the branch, the base commit, and whether setup ran: '
  + 'if it didn\'t, run the command it gives in the worktree, sandboxed, before the work starts (or tell the coder to run it first), '
  + 'and escalate only if it fails with "Read-only file system" (a coder can\'t escalate, and reports it). '
  + 'Hand a worktree to a coder with `delegate`\'s `worktree` parameter (`<project>/<slug>`), never only in the task text: the binding is what lets the harness check its work. '
  + '`list` (optional `project`) shows each worktree: ahead and behind the default branch, dirty or clean, merged or not, whether dish made it, and the coder bound to it. '
  + '`remove` (`project`, `slug`, optional `force`) deletes a worktree dish made, and its branch; it refuses one that is unmerged or dirty unless `force`, '
  + 'and one a running coder is bound to even with `force`. Merged worktrees are removed automatically.'

/** A string the model may have left empty: `undefined` for `''` or only whitespace. */
function given(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === '' ? undefined : trimmed
}

function required(value: string | undefined, name: 'project' | 'slug', action: string): string {
  const found = given(value)
  if (found !== undefined) return found
  throw new Error(name === 'project'
    ? `\`project\` is required for ${action}: the project's name as in projects.yaml (owner/repo)`
    : `\`slug\` is required for ${action}: the worktree's name (1 to 40 of a-z, 0-9 and "-")`)
}

function text(value: string): [{ type: 'text', text: string }] {
  return [{ type: 'text', text: value }]
}

/** One line of `list`'s answer. */
function line(item: Pick<WorktreeInfo, 'project' | 'slug' | 'branch' | 'path' | 'ahead' | 'behind' | 'dirty' | 'merged' | 'managed' | 'bound'>): string {
  const parts = [
    `${item.project}/${item.slug}`,
    item.path,
    `branch ${item.branch === '' ? '(detached)' : item.branch}`,
    `ahead ${item.ahead}, behind ${item.behind}`,
    item.dirty ? 'dirty' : 'clean',
    item.merged ? 'merged' : 'not merged',
  ]
  if (!item.managed) parts.push('not made by dish')
  if (item.bound.length > 0) {
    parts.push(`bound to ${item.bound.map(binding => `${binding.child} (${binding.role}, ${binding.running ? 'running' : 'finished'})`).join(', ')}`)
  }
  return parts.join('; ')
}

/** What dish-orchestrator answered `worktreeCreated`: a run, nothing, or why its answer can't be used. */
function runOf(answer: unknown): { run?: { id: string, opened: boolean }, runProblem?: string } {
  if (answer === undefined) return {}
  if (typeof answer === 'object' && answer !== null && typeof (answer as { id?: unknown }).id === 'string' && RUN_ID.test((answer as { id: string }).id)) {
    return { run: { id: (answer as { id: string }).id, opened: (answer as { opened?: unknown }).opened === true } }
  }
  return { runProblem: 'dish-orchestrator gave a malformed run' }
}

/** The line `create`'s answer adds for its run, if any. */
function runLine(slug: string, run: { id: string, opened: boolean } | undefined, problem: string | undefined): string | undefined {
  if (run !== undefined) {
    return run.opened
      ? `Opened run \`${run.id}\` for this worktree; \`run\` with \`action: goal\` names it, and \`open_pr\` ends it.`
      : `It is task \`${slug}\` of run \`${run.id}\`, which this chat drives.`
  }
  return problem === undefined ? undefined : `dish couldn't add it to a run: ${problem.replace(/\.+$/, '')}.`
}

/**
 * The `worktree` tool, over `service` and dish-orchestrator's hooks (`runs`), each read on each call: either may come
 * and go. `warn` logs a hook's failure (the plugin's logger), once per project and message.
 */
export function worktreeTool(service: () => DishWorkspaces | undefined, runs?: () => RunsHooks | undefined,
  options: { warn?(format: string, ...args: unknown[]): void } = {}): ToolDefinition {
  /** By topic (`runs <project>`): the last failure logged, so one that repeats is one line. */
  const trouble = new Map<string, string>()
  const warnOnce = (project: string, message: string, format: string, ...args: unknown[]): void => {
    const topic = `runs ${project.toLowerCase()}`
    if (trouble.get(topic) === message) return
    trouble.set(topic, message)
    options.warn?.(format, ...args)
  }
  const clearTrouble = (project: string): void => { trouble.delete(`runs ${project.toLowerCase()}`) }
  return defineTool({
    name: 'worktree',
    description: DESCRIPTION,
    parameters: {
      action: { type: 'string', enum: ['create', 'list', 'remove'], required: true, description: 'create, list or remove.' },
      project: { type: 'string', description: 'The project, as in projects.yaml: `owner/repo`. Required for create and remove; for list, leave empty for every project.' },
      slug: { type: 'string', description: 'The worktree\'s name: 1 to 40 of a-z, 0-9 and "-", starting with a letter or a digit. Its branch is `dish/<slug>`. Required for create and remove.' },
      base: { type: 'string', description: 'create only: what to cut the worktree from (a branch, tag or commit). Leave empty for origin/<default branch>.' },
      force: { type: 'boolean', description: 'remove only: remove it even if it is unmerged or dirty. Never removes one a running coder is bound to.' },
    },
    output: {
      schema: OUTPUT,
      render: (_args, value) => {
        if (value.action === 'list') {
          return text(value.worktrees.length === 0 ? 'No worktrees.' : value.worktrees.map(line).join('\n'))
        }
        if (value.action === 'remove') {
          return text(`Removed worktree ${value.project}/${value.slug} and its branch ${value.branch}${value.forced ? ' (forced)' : ''}.`)
        }
        const setup = value.setup.ran
          ? `Setup ran: ${value.setup.timedOut ? 'it timed out' : `exit ${value.setup.exitCode ?? 'none'}`} (log: ${value.setup.log}).`
          : value.setup.reason === 'no setup' ? 'The project has no setup.' : value.setup.reason
        const run = runLine(value.slug, value.run, value.runProblem)
        return text([
          `Made worktree ${value.project}/${value.slug}: ${value.path}, on branch ${value.branch}, cut from ${value.base}.`,
          setup,
          `Bind a coder to it with delegate's \`worktree\`: ${value.project}/${value.slug}. Work in it with absolute paths.`,
          ...(run === undefined ? [] : [run]),
        ].join('\n'))
      },
    },
    async execute(args, exec) {
      if (!isTopLevelAgent(exec.agent)) throw new Error(MAIN_ONLY)
      const workspaces = service()
      if (workspaces === undefined) throw new Error('dish-workspaces isn\'t running, so there are no worktrees to make')
      if (args.action === 'create') {
        const project = required(args.project, 'project', 'create')
        const slug = required(args.slug, 'slug', 'create')
        const created = await workspaces.createWorktree(project, slug, given(args.base), { cwd: exec.agent?.session?.header?.cwd, signal: exec.signal })
        const { setup } = created
        // After createWorktree returned, so outside the project's lock. The worktree exists whatever the hook does, so
        // the call's signal isn't passed.
        let joined: ReturnType<typeof runOf> = {}
        const hooks = runs?.()
        if (hooks !== undefined) {
          try {
            joined = runOf(await hooks.worktreeCreated(String(exec.agent?.id), {
              project: created.project, slug: created.slug, branch: created.branch, path: created.path, clone: created.clone,
              base: created.base, baseRef: created.baseRef,
            }))
            if (joined.runProblem === undefined) clearTrouble(created.project)
            else warnOnce(created.project, joined.runProblem, 'dish-orchestrator gave a malformed run for worktree %s/%s', created.project, created.slug)
          } catch (error) {
            const problem = shown(error instanceof Error ? error.message : String(error), RUN_PROBLEM_CHARS)
            joined = { runProblem: problem }
            warnOnce(created.project, problem, 'dish-orchestrator could not add worktree %s/%s to a run: %s', created.project, created.slug, problem)
          }
        }
        return {
          action: 'create' as const,
          project: created.project, slug: created.slug, path: created.path, branch: created.branch, base: created.base,
          setup: setup.ran
            ? { ran: true as const, exitCode: setup.exitCode, timedOut: setup.timedOut, log: setup.log }
            : { ran: false as const, reason: setup.reason },
          ...joined,
        }
      }
      if (args.action === 'list') {
        const listed = await workspaces.listWorktrees(given(args.project))
        return {
          action: 'list' as const,
          worktrees: listed.map(item => ({
            project: item.project, slug: item.slug, branch: item.branch, path: item.path, base: item.base,
            ahead: item.ahead, behind: item.behind, dirty: item.dirty, merged: item.merged, managed: item.managed,
            bound: item.bound.map(({ child, role, title, running }) => ({ child, role, title, running })),
          })),
        }
      }
      const project = required(args.project, 'project', 'remove')
      const slug = required(args.slug, 'slug', 'remove')
      const forced = args.force === true
      await workspaces.removeWorktree(project, slug, forced)
      // After the removal, outside the project's lock. A failure is logged; the removal stands.
      const hooks = runs?.()
      if (hooks !== undefined) {
        try {
          await hooks.worktreeRemoved(project, slug)
          clearTrouble(project)
        } catch (error) {
          const problem = shown(error instanceof Error ? error.message : String(error), RUN_PROBLEM_CHARS)
          warnOnce(project, problem, 'dish-orchestrator could not note that worktree %s/%s was removed: %s', project, slug, problem)
        }
      }
      return { action: 'remove' as const, project, slug, branch: `dish/${slug}`, forced }
    },
  })
}
