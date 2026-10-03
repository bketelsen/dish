/**
 * The `worktree` tool: the main agent makes, lists and removes task worktrees in a registered project's clone.
 *
 * - **The main agent only,** like dish-config's tools: every call checks `isTopLevelAgent` before anything else, and
 *   crew never gives the tool to a child (it is on crew's never-list).
 * - **create** passes the calling chat's workspace (`exec.agent.session.header.cwd`) and the call's signal to
 *   `dishWorkspaces.createWorktree`, which refuses a project that isn't ready, a chat with no workspace, and a worktree
 *   outside it (a coder of that chat works in its sandbox, which is its workspace). Its answer is the path, the branch,
 *   the base commit and what setup did: in 6b setup doesn't run in a worktree (the user's A, 2026-10-02), so the answer tells
 *   the main agent to run the command in it itself, escalated (the judge allows it or asks the user), before it delegates.
 * - **list** shows each worktree with the crew children bound to it (`dishCrew.worktreeBindings`); **remove** refuses
 *   one a running coder is bound to, even with `force`.
 * - The service's refusals reach the model as plain `Error`s with its message (masked already). Models fill every
 *   optional parameter, often with `''`, so an empty string is taken as absent.
 *
 * @module dish-workspaces/tool
 */

import type {} from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { isTopLevelAgent } from 'dish-kit'
import type { DishWorkspaces } from './service.ts'
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

const OUTPUT = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', const: 'create', required: true },
        project: STRING, slug: STRING, path: STRING, branch: STRING, base: STRING,
        setup: { ...SETUP, required: true },
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
  + 'it works only in a chat whose workspace is that project\'s clone. Its answer gives the path, the branch, the base commit, and whether setup ran: '
  + 'if it didn\'t, run the command it gives in the worktree yourself, escalated, before you delegate: a coder can\'t. '
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

/** The `worktree` tool, over `service` (read on each call: dish-workspaces may come and go). */
export function worktreeTool(service: () => DishWorkspaces | undefined): ToolDefinition {
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
        return text([
          `Made worktree ${value.project}/${value.slug}: ${value.path}, on branch ${value.branch}, cut from ${value.base}.`,
          setup,
          `Bind a coder to it with delegate's \`worktree\`: ${value.project}/${value.slug}. Work in it with absolute paths.`,
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
        return {
          action: 'create' as const,
          project: created.project, slug: created.slug, path: created.path, branch: created.branch, base: created.base,
          setup: setup.ran
            ? { ran: true as const, exitCode: setup.exitCode, timedOut: setup.timedOut, log: setup.log }
            : { ran: false as const, reason: setup.reason },
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
      return { action: 'remove' as const, project, slug, branch: `dish/${slug}`, forced }
    },
  })
}
