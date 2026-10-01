/**
 * A child's tool allow list: the tools its role lists in `crew.yaml`, cut down to what the child can have.
 *
 * dsh checks a child's `toolFilter` when the child starts: `tools.restrict` throws on a name the child can't see, and on
 * an empty filter. So the list is made from what the parent can see at that moment, and a role that would end up with
 * nothing is a refusal the model can read, not a throw from inside dsh.
 *
 * `allowList` is plain data over plain data. `visibleTools` is the one place that asks dsh anything.
 *
 * @module dish-crew/allow
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-tools'

/**
 * Tools no child gets, whatever `crew.yaml` says a role lists: delegation (only the main agent delegates, and children
 * never nest), the main agent's own controls, and anything that asks you something. Children can't ask: dsh runs
 * them with approval policy `never`.
 */
export const NEVER: ReadonlySet<string> = new Set([
  'delegate',
  'subagent',
  'subagent_fork',
  'workflow',
  'interrupt_agent',
  'list_agents',
  'ask_user_question',
  'create_goal',
  'update_goal',
  'exit_plan_mode',
  'present',
])

/**
 * dsh's reserved presentation transport (`RUN_CODE_NAME`, from `@deepseek-ai/dsh-tools`). It's in a parent's visible tools
 * when the parent runs a code mode, and `tools.restrict` refuses a filter that names it. A child gets it from its own
 * presentation, not from an allow list.
 */
const TRANSPORT = 'run_code'

/** The most names a problem lists, so a long registry can't make a long message. */
const LISTED = 60

function listed(names: readonly string[]): string {
  if (names.length === 0) return 'none'
  const head = names.slice(0, LISTED).join(', ')
  return names.length > LISTED ? `${head}, …` : head
}

export type AllowResult = { ok: true, allow: string[] } | { ok: false, problem: string }

/**
 * The allow list for a child of a role that lists `roleTools`, given the tools its parent can `visible`ly see.
 *
 * - Names in `NEVER` are dropped, and so is the reserved `run_code`.
 * - Wherever `bash` is listed, `pwsh` is too: on a host where the shell is `pwsh`, that is the one the role gets.
 * - Only names in `visible` stay. A tool missing here (`bash` on Windows, `read_image` with no attachments) is left out,
 *   not an error.
 * - The result has no duplicates and is sorted, so the same inputs always give the same filter.
 *
 * An empty result is a `problem`, because dsh throws on an empty filter. `role` is only for that message.
 */
export function allowList(roleTools: readonly string[], visible: ReadonlySet<string>, role?: string): AllowResult {
  const wanted = new Set(roleTools)
  if (wanted.has('bash')) wanted.add('pwsh')
  const allow = [...wanted]
    .filter(name => !NEVER.has(name) && name !== TRANSPORT && visible.has(name))
    .sort()
  if (allow.length > 0) return { ok: true, allow }
  const named = role === undefined || role === '' ? 'the role' : `role ${role}`
  const where = role === undefined || role === '' ? 'tools' : `roles.${role}.tools`
  return {
    ok: false,
    problem: `${named} would have no tools here (visible: ${listed([...visible].filter(name => name !== TRANSPORT).sort())}); `
      + `crew.yaml lists: ${listed([...new Set(roleTools)])}. Children never get ${[...NEVER].join(', ')}. `
      + `Put tools that are visible here in ${where}.`,
  }
}

/**
 * The names of the tools `agent` can see now: what dsh's registry lists for it, which is what a child it starts is
 * filtered against (`tools.restrict` checks names against the registry the child inherits from the same preset). The
 * reserved `run_code` transport is left out, since a filter can't name it.
 *
 * A snapshot: call it when starting the child, not earlier. A tool registered only on the parent's own scope, and not
 * by its preset or globally, is listed here but isn't the child's to restrict; no role lists one.
 */
export function visibleTools(agent: Agent): ReadonlySet<string> {
  return new Set(agent.ctx.tools.schemas(agent).map(schema => schema.name).filter(name => name !== TRANSPORT))
}
