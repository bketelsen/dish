/**
 * The main agent's `pr_feedback` tool. A stub for now: Task 10 replaces this file whole, keeping the signature.
 * @module dish-orchestrator/pr-feedback
 */

import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ToolDeps } from './runs.ts'

/** The `pr_feedback` tool over `deps`, or `undefined` while it isn't built: then nothing is registered. */
export function prFeedbackTool(_deps: ToolDeps): ToolDefinition | undefined {
  return undefined
}
