/**
 * The main agent's `run` tool. A stub for now: Task 9 replaces this file whole, keeping the signature.
 * @module dish-orchestrator/run-tool
 */

import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ToolDeps } from './runs.ts'

/** The `run` tool over `deps`, or `undefined` while it isn't built: then nothing is registered. */
export function runTool(_deps: ToolDeps): ToolDefinition | undefined {
  return undefined
}
