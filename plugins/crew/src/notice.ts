/**
 * dish-crew/notice: the finish notice of a crew child, in the crew's words.
 *
 * When a child settles, dsh sends its parent a user message of its own, source `subagent-settled`: "Background subagent
 * `<uuid>` finished…", then the child's closing message. The parent, and the user reading the chat, would rather read
 * who it was and where its report went. The `dish-crew/delegate` row listens on `agent/pre-step` and rewrites the text
 * that leads each such message from one of this agent's crew children:
 *
 * > coder «add login» (claude-sonnet-5.5) finished. Report: /…/3-coder-1.md. Its closing message:
 *
 * On a run that didn't finish, the verb is `failed`, `was stopped`, `ran out of room` or `declined`, followed by the
 * error the child reported (or the stop reason) and the same report and closing message.
 *
 * dsh builds the message (`createSettlementMessage`, in `@deepseek-ai/dsh-subagent`'s `continuation-messages`) as
 * `[the opening line, 'Its closing message:', …the child's text blocks]`, or `[the opening line, 'It left no closing
 * message.']` when the child left none. The rewrite replaces the opening line and the label after it with one block, and
 * keeps the rest as the very same objects, the message's `id` and its `source` included. Where the message has another
 * shape (dsh can change it), the opening line is replaced and what follows is kept as it is.
 *
 * - **Whose.** A message is rewritten only if its `source.senderSessionId` is a child in crew's record, and the session the
 *   record names for it is this agent's. The row hears every agent under its preset, children included, and a message
 *   from a child crew didn't start, or from one of another session, goes through untouched, as the same object.
 * - **The report.** `subagent/end` is published right after dsh queues the notice, so the notice can reach the parent while
 *   the run is still being recorded. The host plugin's `dishCrew.whenRecorded(child)` is that recording, if there is one:
 *   it is awaited, up to `WAIT_MS`. A run is the child's newest, unless the child is `running` again (a follow-up or a
 *   wake that started a run whose end isn't recorded): then the notice is of a run that isn't in the record, and the
 *   newest one there is an earlier round's. With no run to report, the notice is dsh's own account of how the child
 *   ended with the child named as the crew names it, and no report path.
 * - **Never a failed step.** Every message is rewritten on its own, and one that can't be is left as it was and logged
 *   once, under `dish-crew`.
 *
 * Messages are deep-frozen, so what is replaced is a new message with the same id (`agent/pre-step` replaces the messages
 * that enter the step by returning them; see `@deepseek-ai/dsh-tmux-context`, which does the same to add one).
 *
 * @module dish-crew/notice
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import type { DishCrew } from './index.ts'
import type { ChildRecord, RunRecord } from './record.ts'

/** The longest a notice waits for a run that is being recorded, in ms. */
export const WAIT_MS = 2000

/** dsh's two ways to introduce what follows the opening line of a settlement notice. */
const CLOSING_LABEL = 'Its closing message:'
const NO_CLOSING = 'It left no closing message.'

/** How each of dsh's stop reasons that isn't `completed` is said. Another reason is `stopped (<reason>)`. */
const VERBS: Readonly<Record<string, string>> = {
  error: 'failed',
  aborted: 'was stopped',
  'max-tokens': 'ran out of room',
  refusal: 'declined',
}

/** A log line that can't throw: what the row logs through. */
type Warn = (format: string, ...args: unknown[]) => void

/** What a notice says of a child. */
type Child = Pick<ChildRecord, 'id' | 'role' | 'title' | 'model'>

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** `text` as one line, without the full stop it ends in: the notice puts its own. */
function oneLine(text: string | undefined): string | undefined {
  const line = text?.replace(/\s+/g, ' ').replace(/[.\s]+$/, '').trim()
  return line === undefined || line === '' ? undefined : line
}

/**
 * The text that leads a notice.
 * @param child - the child the notice is of.
 * @param run - the run that ended, or `undefined` if the record has none for this notice.
 * @param lead - dsh's own opening line, which says how the child ended when `run` doesn't.
 * @param label - what dsh put after its opening line: `Its closing message:` or `It left no closing message.`. Left out if
 * the message has no such block.
 */
export function noticeText(child: Child, run: RunRecord | undefined, lead: string, label?: string): string {
  const who = `${child.role} «${child.title}» (${child.model})`
  let head: string
  if (run === undefined) {
    // "Background subagent <id> failed before it finished." is already the right sentence, said of the wrong name.
    const subject = `Background subagent ${child.id}`
    head = lead.startsWith(subject) ? `${who}${lead.slice(subject.length)}` : `${who}: ${lead}`
  } else if (run.stopReason === 'completed') {
    head = `${who} finished. Report: ${run.report}.`
  } else {
    const known = Object.hasOwn(VERBS, run.stopReason)
    const verb = known ? VERBS[run.stopReason]! : `stopped (${run.stopReason})`
    // An unknown reason is in the verb already.
    const detail = oneLine(run.error) ?? (known ? run.stopReason : undefined)
    head = `${who} ${verb}${detail === undefined ? '' : `: ${detail}`}. Report: ${run.report}.`
  }
  return label === undefined ? head : `${head} ${label}`
}

/** The id of the child `message` is dsh's account of, if it is one. */
function settledChild(message: UserMessage): string | undefined {
  if (message.role !== 'user') return undefined
  const source: unknown = message.source
  if (!isObject(source) || source.kind !== 'subagent-settled') return undefined
  const sender = source.senderSessionId
  return typeof sender === 'string' && sender !== '' ? sender : undefined
}

/** `message` with the text that leads it replaced, or `undefined` if it doesn't start with text. */
function rewritten(message: UserMessage, child: ChildRecord, run: RunRecord | undefined): UserMessage | undefined {
  const [lead, next] = message.content
  if (lead?.type !== 'text') return undefined
  const label = next?.type === 'text' && (next.text === CLOSING_LABEL || next.text === NO_CLOSING) ? next.text : undefined
  const text: ContentBlock = Object.freeze({ type: 'text', text: noticeText(child, run, lead.text, label) })
  // The blocks that stay are dsh's own, frozen already.
  const content = Object.freeze([text, ...message.content.slice(label === undefined ? 1 : 2)])
  return Object.freeze({ ...message, content })
}

/** Wait for `recording`, however it ends, but no longer than `ms`. */
async function settled(recording: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      recording.then(() => {}, () => {}),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, ms) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** What rewriting needs of what is around it. */
export interface NoticeContext {
  /** The record, and the runs that are being recorded. */
  crew: Pick<DishCrew, 'records' | 'whenRecorded'>
  /** The session of the agent whose step it is: only its own children's notices are rewritten. */
  sessionId: string
  /** Told of a message that couldn't be rewritten. A logger that throws is ignored. */
  warn: Warn
  /** How long to wait for a run being recorded, in ms. Defaults to `WAIT_MS`. */
  waitMs?: number
}

async function rewriteOne(message: UserMessage, context: NoticeContext): Promise<UserMessage> {
  const id = settledChild(message)
  if (id === undefined) return message
  try {
    const { records } = context.crew
    let found = await records.lookup(id)
    if (found === undefined || found.sessionId !== context.sessionId) return message
    const recording = context.crew.whenRecorded(id)
    if (recording !== undefined) {
      await settled(recording, context.waitMs ?? WAIT_MS)
      found = (await records.lookup(id)) ?? found
    }
    const { record } = found
    return rewritten(message, record, record.last === 'running' ? undefined : record.runs.at(-1)) ?? message
  } catch (error) {
    try {
      context.warn('could not rewrite the finish notice of child %s, which is left as dsh wrote it: %s', id, describe(error))
    } catch {
      // Nothing to do about it.
    }
    return message
  }
}

/**
 * The messages of a step with each crew child's finish notice rewritten. Messages that aren't one are the same objects, in
 * the same places; if none changed, it is the same array. Never rejects.
 */
export async function rewriteNotices(messages: UserMessage[], context: NoticeContext): Promise<UserMessage[]> {
  if (!messages.some(message => settledChild(message) !== undefined)) return messages
  // Together, so that a step with several notices waits at most once for a run that isn't recorded yet.
  const done = await Promise.all(messages.map(message => rewriteOne(message, context)))
  return done.every((message, index) => message === messages[index]) ? messages : done
}

/**
 * The `agent/pre-step` listener of the `dish-crew/delegate` row. It lets the step through as it is, and rewrites the
 * notices of the messages that enter it. `dishCrew` is read on each step, so a plugin that comes and goes is followed.
 */
export function noticeListener(ctx: Context, warn: Warn) {
  return async (payload: { agent: Agent }, next: () => Promise<PreStepDecision>): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    try {
      const crew = ctx.get('dishCrew')
      if (crew === undefined) return decision
      const messages = await rewriteNotices(decision.messages, { crew, sessionId: String(payload.agent.id), warn })
      return messages === decision.messages ? decision : { ...decision, messages }
    } catch (error) {
      try {
        warn('could not rewrite the finish notices of a step: %s', describe(error))
      } catch {
        // Nothing to do about it.
      }
      return decision
    }
  }
}
