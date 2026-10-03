/**
 * The main agent's `open_pr` tool. A stub for now: Task 10 replaces this file whole, keeping the signature.
 * @module dish-orchestrator/open-pr
 */

import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ToolDeps } from './runs.ts'

/** The `open_pr` tool over `deps`, or `undefined` while it isn't built: then nothing is registered. */
export function openPrTool(_deps: ToolDeps): ToolDefinition | undefined {
  return undefined
}
