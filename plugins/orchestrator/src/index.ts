/**
 * dish-orchestrator: runs, their ledgers, and the main agent's `run`, `open_pr` and `pr_feedback` tools. A stub for now: the
 * plugin is built up task by task (see the plan), and this one only gives the package a name to load.
 * @module dish-orchestrator
 */

import type { Context } from '@deepseek-ai/cordis'

export const name = 'dish-orchestrator'

export function apply(_ctx: Context): void {}
