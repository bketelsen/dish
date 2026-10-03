/**
 * dish-crew/notice: the finish notice of a crew child, in the crew's words.
 *
 * When a child settles, dsh sends its parent a user message of its own, source `subagent-settled`: "Background subagent
 * `<uuid>` finished…", then the child's closing message. The parent, and the user reading the chat, would rather read
 * who it was and where its report went. The `dish-crew/delegate` row listens on `agent/pre-step` and rewrites each such
 * message from one of this agent's crew children:
 *
 * > coder «add login» (claude-sonnet-5.5) finished. Report: `/…/3-coder-1.md`. Its closing message:
 *
 * On a run that didn't finish, the verb is `failed`, `was stopped`, `ran out of room` or `declined`, followed by `: ` and
 * the error the child reported, if it reported one, and then the same report and closing message.
 *
 * dsh builds the message (`createSettlementMessage`, in `@deepseek-ai/dsh-subagent`'s `continuation-messages`) as
 * `[the opening line, 'Its closing message:', …the child's text blocks]`, or `[the opening line, 'It left no closing
 * message.']` when the child left none, with the source `{ kind, form, summary, senderSessionId }`. The rewrite:
 *
 * - replaces the opening line and the label after it with one block, and keeps the closing blocks as the very same
 *   objects. Where the message has another shape (dsh can change it), the opening line is replaced and what follows is
 *   kept as it is;
 * - replaces the source's `summary` with the first sentence of the new text, without the report, bounded the way dsh
 *   bounds its own. A notice that is steered into a parent that is running is shown as a collapsed row with the summary,
 *   and the uuid line is not what to show there. The message's `id` and the source's other fields stay.
 *
 * - **Whose.** A message is rewritten only if its `source.senderSessionId` is a child in crew's record, and the session the
 *   record names for it is this agent's. The row hears every agent under its preset, children included, and a message
 *   from a child crew didn't start, or from one of another session, goes through untouched, as the same object.
 * - **Which round.** A child that is sent a follow-up settles again, and dsh steers a notice into the parent's next step
 *   for each settlement, which that step claims all at once. A step can hold the notices of several rounds, and a notice
 *   can be read after later rounds were recorded, so "the child's latest run" can be another round's. A notice is matched
 *   to a run by what it says: the run's report file must hold the notice's closing text (`closingOf` its blocks, and
 *   `reportContent` of that, the rules `record.ts` records a run by and this reads one back by), and the run's stop
 *   reason must be the one dsh's opening line says (see `IMPLIED`). A report that can't be read is not the run, and is
 *   told of once. Of the runs that match, the newest not claimed by another notice of the
 *   step is the one, taking the step's notices from the last: if two rounds said the same and ended the same way, the
 *   last notice gets the newest run and the one before it the next. A notice that matches no run is rewritten without a
 *   report path (dsh's own account of how the child ended, with the child named), and so is a notice in a shape that
 *   isn't known, which has no closing text to compare. A report is compared by its size and its first `COMPARE_BYTES`,
 *   never read whole.
 * - **The wait.** dsh queues the notice and publishes `subagent/end` in the same synchronous run, so by the time a step
 *   claims the notice the host plugin has heard the end. What may still be going on is writing it down: the report file
 *   and the record. `dishCrew.whenRecorded(child)` is that, if it is; it is awaited, up to `WAIT_MS` and no longer than
 *   the turn lives, and then the record is read.
 * - **Never a failed step.** Each message is rewritten on its own, and one that can't be is left as it was and logged
 *   once, under `dish-crew`.
 *
 * A child bound to a worktree (`ChildRecord.worktree`) has its gate's ending said after the report, from the last gate result
 * of the run the notice is of (`gateLine`; the results are dish-gates', recorded by `addGate`, and filed on the run by
 * `endRun`): a pass, a failure that used the last round, a failure that didn't (the run ended some other way), a skip, an
 * error, or no result. A notice with no run matched to it says nothing of a gate, as it names no report. The collapsed
 * row's sentence (`noticeSummary`) doesn't change.
 *
 * Messages are deep-frozen, so what is replaced is a new message with the same id (`agent/pre-step` replaces the messages
 * that enter the step by returning them; see `@deepseek-ai/dsh-tmux-context`, which does the same to add one).
 *
 * @module dish-crew/notice
 */
import { open } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import type { DishCrew } from './index.ts'
import { closingOf, reportContent } from './record.ts'
import type { ChildRecord, RunRecord } from './record.ts'

/** The longest a notice waits for a run that is being recorded, in ms. */
export const WAIT_MS = 2000

/** The most of a report that is read to compare it with a notice, in bytes. */
export const COMPARE_BYTES = 1024 * 1024

/** The longest a source's `summary` is, in characters: dsh's `CONTEXT_SUMMARY_MAX_CHARS`. */
const SUMMARY_MAX_CHARS = 120

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

/**
 * The stop reason that each way dsh ends its opening line says (`settlementSummary`, in `continuation-messages`), after
 * `Background subagent <id>`. `ended abnormally (<reason>) before it finished.` is any other reason, and says which.
 */
const IMPLIED: ReadonlyArray<readonly [string, string]> = [
  [' finished and will do no further work unless you send it more.', 'completed'],
  [' was stopped before it finished.', 'aborted'],
  [' ran out of room before it finished.', 'max-tokens'],
  [' declined the task.', 'refusal'],
  [' failed before it finished.', 'error'],
]
const ABNORMAL = /^ ended abnormally \((.*)\) before it finished\.$/s

/** A log line that can't throw: what the row logs through. */
type Warn = (format: string, ...args: unknown[]) => void

/** What a notice says of a child. */
type Child = Pick<ChildRecord, 'id' | 'role' | 'title' | 'model' | 'worktree'>

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

/** `summary` bounded to `SUMMARY_MAX_CHARS` as dsh's `boundContextSummary` does it. */
function bounded(summary: string): string {
  return summary.length <= SUMMARY_MAX_CHARS ? summary : `${summary.slice(0, SUMMARY_MAX_CHARS - 1)}…`
}

/** The longest run of backticks in `text`, 0 if it has none. */
function longestBackticks(text: string): number {
  let longest = 0
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length)
  return longest
}

/** `text` as an inline code span on one line, with marks longer than any run of backticks in it. */
function codeSpan(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  const longest = longestBackticks(line)
  if (longest === 0) return `\`${line}\``
  const mark = '`'.repeat(longest + 1)
  return `${mark} ${line} ${mark}`
}

/** `text` in a code fence longer than any run of backticks in it, and at least three. */
function fenced(text: string): string {
  const fence = '`'.repeat(Math.max(3, longestBackticks(text) + 1))
  return `${fence}\n${text}\n${fence}`
}

/**
 * The notice's line on how a bound child's gate ended in `run`, from the run's last gate result, in the words of the gates
 * spec's "The finish notice":
 *
 * - passed: `Gate passed (round N).`
 * - failed with `round >= maxRounds`: `Gate FAILED after N rounds (<command>, exit <code>); last lines:`, the excerpt in a
 *   code fence, and `Full log: <log>. Start a fix round with `to` or a fresh coder (escalation ladder).` A gate that hit
 *   its time limit says `stopped at its time limit` in place of the exit code;
 * - failed with a round to spare (the run ended some other way): `Gate failed in round N of M (<command>, exit <code>), and
 *   the run ended before the coder finished again. Full log: <log>.`
 * - skipped: `Gate skipped: <reason>.`; error: `Gate not run: <reason>.`; a run with no result: `Gate not run.`
 *
 * The fence is written here, and is longer than any run of backticks in the excerpt: crew doesn't import dish-gates.
 * @param child - the child the notice is of.
 * @param run - the run the notice is of.
 * @param gatesOn - whether dish-gates is running. Off, a run with no result says nothing: no gate was going to run.
 * @returns `undefined` for a child that isn't bound to a worktree, which no gate ran for.
 */
export function gateLine(child: Pick<ChildRecord, 'worktree'>, run: RunRecord, gatesOn = true): string | undefined {
  if (child.worktree === undefined) return undefined
  const result = run.gates?.at(-1)
  if (result === undefined) return gatesOn ? 'Gate not run.' : undefined
  const reason = oneLine(result.reason)
  const because = reason === undefined ? '' : `: ${reason}`
  switch (result.outcome) {
    case 'passed':
      return `Gate passed (round ${result.round}).`
    case 'skipped':
      return `Gate skipped${because}.`
    case 'error':
      return `Gate not run${because}.`
    case 'failed': {
      const ended = result.timedOut ? 'stopped at its time limit' : result.exitCode === null ? 'no exit code' : `exit ${result.exitCode}`
      const what = `${result.command === '' ? '' : `${codeSpan(result.command)}, `}${ended}`
      const log = result.log === null ? undefined : `Full log: ${codeSpan(result.log)}.`
      if (result.round < result.maxRounds) {
        return `Gate failed in round ${result.round} of ${result.maxRounds} (${what}), and the run ended before the coder finished again.${log === undefined ? '' : ` ${log}`}`
      }
      const lines = result.excerpt.replace(/\n+$/, '')
      const next = 'Start a fix round with `to` or a fresh coder (escalation ladder).'
      const head = `Gate FAILED after ${result.round} ${result.round === 1 ? 'round' : 'rounds'} (${what});`
      return lines.trim() === ''
        ? [`${head} it printed no output.`, log, next].filter(part => part !== undefined).join(' ')
        : `${head} last lines:\n${fenced(lines)}\n${[log, next].filter(part => part !== undefined).join(' ')}`
    }
  }
}

/**
 * The first sentence of a notice: who, and how it ended, without the report.
 * @param child - the child the notice is of.
 * @param run - the run that ended, or `undefined` if the record has none for this notice.
 * @param lead - dsh's own opening line, which says how the child ended when `run` doesn't.
 */
export function noticeSummary(child: Child, run: RunRecord | undefined, lead: string): string {
  const who = `${child.role} «${child.title}» (${child.model})`
  if (run === undefined) {
    // "Background subagent <id> failed before it finished." is already the right sentence, said of the wrong name.
    const subject = `Background subagent ${child.id}`
    return lead.startsWith(subject) ? `${who}${lead.slice(subject.length)}` : `${who}: ${lead}`
  }
  if (run.stopReason === 'completed') return `${who} finished.`
  const verb = Object.hasOwn(VERBS, run.stopReason) ? VERBS[run.stopReason]! : `stopped (${run.stopReason})`
  const error = oneLine(run.error)
  return `${who} ${verb}${error === undefined ? '' : `: ${error}`}.`
}

/**
 * The text that leads a notice: its first sentence, the report, the gate line of a bound child (`gateLine`), and what dsh put
 * before the closing message.
 * @param child - the child the notice is of.
 * @param run - the run that ended, or `undefined` if the record has none for this notice (no report is named then).
 * @param lead - dsh's own opening line.
 * @param label - what dsh put after its opening line: `Its closing message:` or `It left no closing message.`. Left out if
 * the message has no such block.
 * @param gatesOn - whether dish-gates is running (`gateLine`).
 */
export function noticeText(child: Child, run: RunRecord | undefined, lead: string, label?: string, gatesOn = true): string {
  const head = noticeSummary(child, run, lead)
  const gate = run === undefined ? undefined : gateLine(child, run, gatesOn)
  const reported = run === undefined ? head : `${head} Report: \`${run.report}\`.${gate === undefined ? '' : ` ${gate}`}`
  return label === undefined ? reported : `${reported} ${label}`
}

/** The id of the child `message` is dsh's account of, if it is one. */
function settledChild(message: UserMessage): string | undefined {
  if (message.role !== 'user') return undefined
  const source: unknown = message.source
  if (!isObject(source) || source.kind !== 'subagent-settled') return undefined
  const sender = source.senderSessionId
  return typeof sender === 'string' && sender !== '' ? sender : undefined
}

/** A settlement notice taken apart. */
interface Parts {
  lead: string
  /** The label after the opening line, if the message has one. */
  label: string | undefined
  /** What a report of the run holds, if the label says what follows it. `undefined` for a shape that isn't known. */
  report: Buffer | undefined
  /** The stop reason the opening line says, if it is one of dsh's sentences for it. */
  implied: string | undefined
}

function partsOf(message: UserMessage, childId: string): Parts | undefined {
  const [lead, next] = message.content
  if (lead?.type !== 'text') return undefined
  const label = next?.type === 'text' && (next.text === CLOSING_LABEL || next.text === NO_CLOSING) ? next.text : undefined
  // What the host files as the closing message of the run is `closingOf` its output, and `endRun` writes `reportContent` of
  // that: the notice carries the output's text blocks, and is matched by the same two rules.
  const report = label === undefined ? undefined : Buffer.from(reportContent(label === NO_CLOSING ? '' : closingOf(message.content.slice(2))))
  const subject = `Background subagent ${childId}`
  let implied: string | undefined
  if (lead.text.startsWith(subject)) {
    const rest = lead.text.slice(subject.length)
    implied = IMPLIED.find(([ending]) => ending === rest)?.[1] ?? ABNORMAL.exec(rest)?.[1]
  }
  return { lead: lead.text, label, report, implied }
}

/** Whether the file at `path` is what `expected` is: of the same size, and the same in its first `COMPARE_BYTES`. A file that isn't there isn't. */
async function reportIs(path: string, expected: Buffer): Promise<boolean> {
  let handle
  try {
    handle = await open(path, 'r')
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 'ENOENT') return false
    throw error
  }
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size !== expected.length) return false
    const length = Math.min(info.size, COMPARE_BYTES)
    const read = Buffer.alloc(length)
    const { bytesRead } = await handle.read(read, 0, length, 0)
    return bytesRead === length && read.equals(expected.subarray(0, length))
  } finally {
    await handle.close()
  }
}

/**
 * The newest run of `runs` that `parts` is the notice of and that isn't in `claimed`, which it is added to. A report that
 * can't be read isn't the run: `unreadable` is told, and the search goes on with the runs before it.
 */
async function runOf(parts: Parts, runs: readonly RunRecord[], claimed: Set<RunRecord>, unreadable: (run: RunRecord, error: unknown) => void): Promise<RunRecord | undefined> {
  if (parts.report === undefined) return undefined
  for (let index = runs.length - 1; index >= 0; index--) {
    const run = runs[index]!
    if (claimed.has(run) || (parts.implied !== undefined && run.stopReason !== parts.implied)) continue
    let same: boolean
    try {
      same = await reportIs(run.report, parts.report)
    } catch (error) {
      unreadable(run, error)
      continue
    }
    if (same) {
      claimed.add(run)
      return run
    }
  }
  return undefined
}

/** `message` with the text that leads it and its source's summary replaced. */
function rewritten(message: UserMessage, child: ChildRecord, parts: Parts, run: RunRecord | undefined, gatesOn: boolean): UserMessage {
  const text: ContentBlock = Object.freeze({ type: 'text', text: noticeText(child, run, parts.lead, parts.label, gatesOn) })
  // The blocks that stay are dsh's own, frozen already.
  const content = Object.freeze([text, ...message.content.slice(parts.label === undefined ? 1 : 2)])
  const source = Object.freeze({ ...message.source, summary: bounded(noticeSummary(child, run, parts.lead)) })
  return Object.freeze({ ...message, content, source })
}

/** Wait for `recording`, however it ends, but no longer than `ms`, nor than `signal` is aborted. */
async function settled(recording: Promise<unknown>, ms: number, signal: AbortSignal | undefined): Promise<void> {
  // A turn that was cancelled already, in the lookup before this, would never fire the listener below.
  if (signal?.aborted) return
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  try {
    await Promise.race([
      recording.then(() => {}, () => {}),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, ms) }),
      new Promise<void>((resolve) => {
        onAbort = () => resolve()
        signal?.addEventListener('abort', onAbort, { once: true })
      }),
    ])
  } finally {
    clearTimeout(timer)
    if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort)
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
  /** The turn's signal. A step that is cancelled isn't rewritten, and doesn't wait. */
  signal?: AbortSignal
  /** Whether dish-gates is running. Defaults to `true`. Off, a bound child's run with no gate result gets no gate line. */
  gatesOn?: boolean
}

function tell(context: NoticeContext, format: string, ...args: unknown[]): void {
  try {
    context.warn(format, ...args)
  } catch {
    // Nothing to do about it.
  }
}

/** Rewrite the notices at `indexes` of `messages`, which are all of child `id`'s, into `out`. */
async function rewriteChild(id: string, indexes: readonly number[], messages: readonly UserMessage[], out: UserMessage[], context: NoticeContext): Promise<void> {
  try {
    const { records } = context.crew
    let found = await records.lookup(id)
    if (found === undefined || found.sessionId !== context.sessionId) return
    const recording = context.crew.whenRecorded(id)
    if (recording !== undefined) {
      await settled(recording, context.waitMs ?? WAIT_MS, context.signal)
      if (context.signal?.aborted) return
      found = (await records.lookup(id)) ?? found
    }
    const { record } = found
    const claimed = new Set<RunRecord>()
    // Said once for the child, whichever of its notices find a report they can't read.
    let told = false
    const unreadable = (run: RunRecord, error: unknown): void => {
      if (told) return
      told = true
      tell(context, 'could not read the report %s of child %s, so it is not taken for the notice\'s run: %s', run.report, id, describe(error))
    }
    // The last notice of the step is the newest, and takes the newest run it can.
    for (const index of [...indexes].reverse()) {
      const message = messages[index]!
      try {
        const parts = partsOf(message, id)
        if (parts === undefined) continue
        out[index] = rewritten(message, record, parts, await runOf(parts, record.runs, claimed, unreadable), context.gatesOn ?? true)
      } catch (error) {
        tell(context, 'could not rewrite a finish notice of child %s, which is left as dsh wrote it: %s', id, describe(error))
      }
    }
  } catch (error) {
    tell(context, 'could not rewrite the finish notices of child %s, which are left as dsh wrote them: %s', id, describe(error))
  }
}

/**
 * The messages of a step with each crew child's finish notice rewritten. Messages that aren't one are the same objects, in
 * the same places; if none changed, it is the same array. Never rejects.
 */
export async function rewriteNotices(messages: UserMessage[], context: NoticeContext): Promise<UserMessage[]> {
  const byChild = new Map<string, number[]>()
  messages.forEach((message, index) => {
    const id = settledChild(message)
    if (id !== undefined) byChild.set(id, [...byChild.get(id) ?? [], index])
  })
  if (byChild.size === 0 || context.signal?.aborted) return messages
  const out = [...messages]
  // Together, so that a step with several children's notices waits at most once for a run that isn't recorded yet.
  await Promise.all([...byChild].map(([id, indexes]) => rewriteChild(id, indexes, messages, out, context)))
  return out.every((message, index) => message === messages[index]) ? messages : out
}

/**
 * The `agent/pre-step` listener of the `dish-crew/delegate` row. It lets the step through as it is, and rewrites the
 * notices of the messages that enter it. `dishCrew` is read on each step, so a plugin that comes and goes is followed.
 */
export function noticeListener(ctx: Context, warn: Warn) {
  return async (payload: { agent: Agent, signal?: AbortSignal }, next: () => Promise<PreStepDecision>): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    try {
      const crew = ctx.get('dishCrew')
      if (crew === undefined) return decision
      const messages = await rewriteNotices(decision.messages, {
        crew, sessionId: String(payload.agent.id), warn, gatesOn: ctx.get('dishGates' as never) !== undefined,
        ...payload.signal === undefined ? {} : { signal: payload.signal },
      })
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
