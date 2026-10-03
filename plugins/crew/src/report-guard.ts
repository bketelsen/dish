/**
 * The report guard: a host-level `tools/pre-execute` listener that refuses a crew child's `send_message` when the message is long
 * enough to be its report, and then keeps `send_message` closed to that child until its run ends, so that a child reports once, in
 * its closing message.
 *
 * ### Why crew has it
 *
 * `dsh web` shows a turn's last message and folds everything before it. When a child sends its findings with `send_message` and
 * then finishes, the main agent gets two deliveries: the message, and crew's finish notice, which carries the child's closing
 * message. It answers in two steps, and the step that has the fuller answer is the one that is folded.
 *
 * The crew prompts already say "Never send your findings or report that way: report once, in your closing message". Some models
 * do it anyway. dsh used to pull the same way, with a note on a continuable child's task telling it to send its result to its
 * parent with `send_message`; on the dish preset that note is gone (`control.ts`), and comes back only on a preset saved in
 * Settings that still loads dsh's `send_message` (`delegate`'s note then says it is wrong). A prompt can't be relied on alone,
 * so the call is refused where it is made. The refusal is a tool error the child reads on its next
 * step.
 *
 * ### What it does
 *
 * The checks, cheapest first, so that nearly every tool call is `next()` before anything is read from disk:
 *
 * 1. **Not `send_message`**: `next()`.
 * 2. **The agent is top-level** (`isTopLevelAgent`): `next()`. The main agent briefs and nudges its children as long as it likes.
 * 3. **The agent is one this guard refused in this run**: `{ kind: 'deny' }` with the second text, whatever the message is.
 * 4. **The `message` argument is not a string, or is at most `messageLimit` characters** (a JS string's `length`): `next()`.
 *    `exec.arguments` is dsh's parsed arguments (an object), never JSON text; tools check their own schema, so what is not a string
 *    is left to the tool to refuse.
 * 5. **The agent has no id**: `next()`.
 * 6. **Then, and only then, the record is asked** (`isCrewChild`, within `GUARD_LOOKUP_BUDGET_MS`): a child crew did not start is
 *    `next()`; a crew child is refused with the first text, and held (see below). `next()` is not called for a refusal, so no later
 *    `tools/pre-execute` listener hears of a call that will not run (the `tools/result` listeners and the like still see its error).
 *
 * A limit of 0 (or below) turns the guard off.
 *
 * ### What the child reads, and why it names no length
 *
 * The first refusal says that the message is the child's result and the closing message is its report, which reaches the main
 * agent in full when the child finishes, whatever its task says about `send_message`, and that resending it shorter or in parts is
 * pointless because `send_message` is closed until it finishes. It says nothing of a length or a limit: a budget invites the child
 * to shorten the message or split it and send it again, which does what dsh's note asks, and brings back the two deliveries.
 *
 * Every later `send_message` of that child in the same run is refused with the second text, short or not. That is the point of
 * holding it: the guard cannot tell a report in pieces from a question, so a child that has been refused once does not get another
 * send. A question it is blocked on goes in its closing message, and the main agent follows up with `delegate` and `to`.
 *
 * ### The hold
 *
 * The ids of refused crew children are kept in a bounded set (`MAX_REFUSED`, oldest out), so the check in 3 is a lookup in memory:
 * only children the record has vouched for are in it. `runEnded(id)` takes a child out, and crew's `subagent/end` listener calls
 * it, so that a follow-up run can use `send_message` again. A child that is let go because the set is full, or whose end is never
 * heard, is refused again the next time it sends a report, and a process restart clears the set. What is lost then is the hold and
 * not the refusal: the child's next long message is refused as before.
 *
 * ### It fails open
 *
 * A record that can't be read, or that takes longer than the budget, is `next()` with one warning for each distinct problem. The
 * approval guard fails closed because its other outcome is a child hung on a prompt nobody sees. Here the other outcome is a message
 * that was delivered, which is no harm: the cost of the guard being wrong is a report sent twice. And the record is read for any
 * long message from any non-top-level agent, so failing closed would refuse other plugins' children whenever crew's disk is
 * broken, and a real question refused for a slow disk leaves a child unable to ask for what it is blocked on.
 *
 * It only ever denies `send_message`, so where it stands among the other `tools/pre-execute` listeners only matters for who hears
 * a refused call (see `index.ts`).
 *
 * @module dish-crew/report-guard
 */

import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { isTopLevelAgent } from 'dish-kit'
import { describe, GUARD_LOOKUP_BUDGET_MS, idOf, within } from './guard.ts'

/** The longest `send_message` a crew child may send unless the setting says otherwise: 1200 characters, a question and not a report. */
export const DEFAULT_MESSAGE_LIMIT = 1200

/** The tool the guard watches, by name: `dish-crew/control`'s on the dish preset, or dsh's (`dsh-tool-subagent-control`) on another. */
const SEND_MESSAGE = 'send_message'

/**
 * How many refused children are held. A child is held until its run ends, and the crew runs a few at a time, so this is many
 * times what is in use; it is there so that a run whose end is never heard can't grow the set.
 */
export const MAX_REFUSED = 256

/** How many distinct problems are told. A lookup that fails with a new message each time can't fill the log or the memory. */
const MAX_TOLD = 100

export interface ReportGuardDeps {
  /** The most characters a crew child's `send_message` may have before it is taken for a report. 0 turns the guard off. */
  messageLimit: number
  /** Whether crew's record knows this child id: `records.lookup` found it. May reject. */
  isCrewChild(childId: string): Promise<boolean>
  /** Says a problem. The guard calls it once for each distinct problem, and survives its throwing. */
  tell?: (message: string) => void
  /** How long a lookup may take. */
  budgetMs?: number
}

/** The `tools/pre-execute` listener, and the way to tell it that a child's run has ended. */
export interface ReportGuard {
  (exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision>
  /** The run of child `childId` has ended: it may use `send_message` again. Never throws, and does nothing for a child that was not held. */
  runEnded(childId: string): void
}

/**
 * What the child reads the first time. It frames the message as the result, which the closing message is for, and names no length
 * or limit (see the header). Said by `report-guard.test.ts` word for word.
 */
const REFUSED = 'Not sent: this is your result, and in this crew your closing message is your report. '
  + 'It reaches the main agent in full, automatically, when you finish, whatever your task says about sending your result with send_message. '
  + 'Don\'t resend it shorter or in parts: send_message is closed to you until you finish. '
  + 'Finish the work and write the report as your closing message. '
  + 'If this was a question you\'re blocked on, put it in your closing message instead; the main agent will follow up.'

/** What it reads for every later `send_message` in the same run. */
const CLOSED = 'Not sent: send_message is closed to you until you finish, because your report was refused here once already. '
  + 'Put everything for the main agent in your closing message, and finish.'

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
  /** The crew children refused in their current run, oldest first. */
  const refused = new Set<string>()
  const hold = (id: string): void => {
    refused.delete(id)
    refused.add(id)
    while (refused.size > MAX_REFUSED) refused.delete(refused.values().next().value!)
  }

  const guard = async (exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> => {
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

    let id: string | undefined
    try {
      id = idOf(agent)
    } catch {
      id = undefined
    }
    if (id !== undefined && refused.has(id)) return { kind: 'deny', reason: CLOSED }

    const message = messageOf(exec.arguments)
    if (message === undefined || message.length <= limit) return next()
    if (id === undefined) return next()

    let known: boolean
    try {
      known = await within(Promise.resolve().then(() => deps.isCrewChild(id)), budgetMs)
    } catch (error) {
      tell(`could not tell whether a child agent sending a long message is one of the crew's (${describe(error)}); the message is let through`)
      return next()
    }
    if (!known) return next()
    hold(id)
    return { kind: 'deny', reason: REFUSED }
  }

  return Object.assign(guard, {
    runEnded(childId: string): void {
      try {
        refused.delete(childId)
      } catch {
        // Nothing to do about it.
      }
    },
  })
}
