/**
 * The report guard: a host-level `tools/pre-execute` listener that refuses a crew child's `send_message` when the message is long
 * enough to be its report, so that a child reports once, in its closing message.
 *
 * ### Why crew has it
 *
 * `dsh web` shows a turn's last message and folds everything before it. When a child sends its findings with `send_message` and
 * then finishes, the main agent gets two deliveries: the message, and crew's finish notice, which carries the child's closing
 * message. It answers in two steps, and the step that has the fuller answer is the one that is folded.
 *
 * The crew prompts already say "Never send your findings or report that way: report once, in your closing message". Some models
 * do it anyway, and dsh pulls the same way: the guidance dsh appends to a continuable child's task tells it to send its result to
 * its parent with `send_message` before it finishes. A prompt can't win against that, so the call is refused where it is made.
 * The refusal is a tool error the child reads on its next step, and it says what to do instead.
 *
 * ### What it does
 *
 * Cheap checks first, so that nearly every tool call is `next()` before anything is read from disk:
 *
 * 1. **Not `send_message`**: `next()`.
 * 2. **The agent is top-level** (`isTopLevelAgent`): `next()`. The main agent briefs and nudges its children as long as it likes.
 * 3. **The `message` argument is not a string, or is at most `messageLimit` characters** (a JS string's `length`): `next()`.
 *    `exec.arguments` is dsh's parsed arguments (an object), never JSON text; tools check their own schema, so what is not a string
 *    is left to the tool to refuse.
 * 4. **Then, and only then, the record is asked** (`isCrewChild`, within `GUARD_LOOKUP_BUDGET_MS`): a child crew did not start is
 *    `next()`; a crew child gets `{ kind: 'deny', reason }`, and `next()` is not called, so no hook or recorder after it hears of
 *    a call that will not run.
 *
 * A limit of 0 (or below) turns the guard off.
 *
 * ### It fails open
 *
 * A record that can't be read, or that takes longer than the budget, is `next()` with one warning for each distinct problem. The
 * approval guard fails closed because its other outcome is a child hung on a prompt nobody sees. Here the other outcome is a message
 * that was delivered, which is no harm: the cost of the guard being wrong is a report sent twice, and the cost of refusing a real
 * question because the record was slow is a child that can't ask for what it is blocked on.
 *
 * It only ever denies `send_message`, so where it stands among the other `tools/pre-execute` listeners makes no difference (see
 * `index.ts`).
 *
 * @module dish-crew/report-guard
 */

import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { isTopLevelAgent } from 'dish-kit'
import { describe, GUARD_LOOKUP_BUDGET_MS, idOf, within } from './guard.ts'

/** The longest `send_message` a crew child may send unless the setting says otherwise: 1200 characters, a question and not a report. */
export const DEFAULT_MESSAGE_LIMIT = 1200

/** The tool the guard watches: dsh's, named in `dsh-tool-subagent-control`. */
const SEND_MESSAGE = 'send_message'

/** How many distinct problems are told. A lookup that fails with a new message each time can't fill the log or the memory. */
const MAX_TOLD = 100

export interface ReportGuardDeps {
  /** The most characters a crew child's `send_message` may have. 0 turns the guard off. */
  messageLimit: number
  /** Whether crew's record knows this child id: `records.lookup` found it. May reject. */
  isCrewChild(childId: string): Promise<boolean>
  /** Says a problem. The guard calls it once for each distinct problem, and survives its throwing. */
  tell?: (message: string) => void
  /** How long a lookup may take. */
  budgetMs?: number
}

export type ReportGuard = (exec: ToolExecution, next: () => Promise<PreToolDecision>) => Promise<PreToolDecision>

/** What the child reads in the tool error. */
function refusal(length: number, limit: number): string {
  return `That message reads like a report (${length} characters; a crew child's send_message is limited to ${limit} characters). `
    + 'Don\'t send findings with send_message: finish the work and put your report in your closing message, which the main agent gets when you finish. '
    + 'Use send_message only for a short question while you work.'
}

/** The call's `message`, if it is a string; `undefined` for anything else, and for arguments that can't be read. */
function messageOf(args: unknown): string | undefined {
  try {
    const message = typeof args === 'object' && args !== null ? (args as { message?: unknown }).message : undefined
    return typeof message === 'string' ? message : undefined
  } catch {
    return undefined
  }
}

/** The `tools/pre-execute` listener: see the header. It never throws, and never calls `next()` for a call it has refused. */
export function reportGuard(deps: ReportGuardDeps): ReportGuard {
  const limit = deps.messageLimit
  const budgetMs = deps.budgetMs ?? GUARD_LOOKUP_BUDGET_MS
  const told = new Set<string>()
  /** Say `message` once. A `tell` that throws is not worth a failed call. */
  const tell = (message: string): void => {
    if (told.has(message) || told.size >= MAX_TOLD) return
    told.add(message)
    try {
      deps.tell?.(message)
    } catch {
      // Nothing to do about it.
    }
  }
  return async (exec, next) => {
    if (!(limit > 0)) return next()
    if (exec?.name !== SEND_MESSAGE) return next()

    const agent = exec.agent
    let topLevel = false
    try {
      topLevel = isTopLevelAgent(agent as Parameters<typeof isTopLevelAgent>[0])
    } catch {
      // An agent that can't be read is not vouched for: it is looked up like any child.
    }
    if (topLevel) return next()

    const message = messageOf(exec.arguments)
    if (message === undefined || message.length <= limit) return next()

    let id: string | undefined
    try {
      id = idOf(agent)
    } catch {
      id = undefined
    }
    if (id === undefined) return next()

    let known: boolean
    try {
      known = await within(Promise.resolve().then(() => deps.isCrewChild(id)), budgetMs)
    } catch (error) {
      tell(`could not tell whether a child agent sending a long message is one of the crew's (${describe(error)}); the message is let through`)
      return next()
    }
    return known ? { kind: 'deny', reason: refusal(message.length, limit) } : next()
  }
}
