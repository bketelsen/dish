/**
 * Who an agent is, for plugins that treat the main agent differently from its children.
 *
 * @module dish-kit/agent
 */

/**
 * The parts of a dsh agent that say whether it is a child. Every field is `unknown` or an `object`, so any agent dsh
 * builds fits (dsh's own `Agent` types, a tool's `exec.agent`), and so does a plain object in a test.
 *
 * `options` is only an `object`, because `subagentDepth` is not in dsh's `AgentOptions` until the subagent package
 * adds it, and a program that doesn't load that package would not accept an agent whose options lack the property.
 */
export interface AgentLike {
  session?: { header?: { delegationDepth?: unknown, origin?: unknown } }
  options?: object
}

/**
 * Whether `agent` is a top-level agent: the main agent of its session, and no one's child.
 *
 * dsh marks a child twice, and its own depth rule takes the larger of the two: the session header's `delegationDepth`,
 * and the runtime `options.subagentDepth` (which a resumed child can have where its header says otherwise). A session
 * also records `origin: 'subagent'`. Any of them, or a value that is none of the shapes dsh writes (a depth that is
 * not `0` or absent), makes the agent not top-level.
 *
 * An agent with no session header is not top-level either: nothing says it is the main agent, so it is not trusted as
 * one. `undefined` (a call with no agent at all) is the same.
 */
export function isTopLevelAgent(agent: AgentLike | undefined): boolean {
  const header = agent?.session?.header
  if (header === undefined) return false
  const topLevel = (depth: unknown): boolean => depth === undefined || depth === 0
  const options = agent?.options as { subagentDepth?: unknown } | undefined
  return topLevel(header.delegationDepth) && topLevel(options?.subagentDepth) && header.origin !== 'subagent'
}

/**
 * How the note about reporting that follows a crew child's brief begins: dsh's own return guidance for a continuable child
 * ("Your parent agent id is …. Before you finish, send your result …", `withContinuableReturnGuidance` in `dsh-subagent`), and
 * crew's closing note, which takes its place on the dish preset (`closingNote` in dish-crew). dish-judge reads a child's brief
 * as the blocks of its first prompt before the first block that begins so: the task, a bound coder's worktree block, a
 * reviewer's ruling, and not how to report.
 */
export const RETURN_NOTE_LEAD = 'Your parent agent id is '
