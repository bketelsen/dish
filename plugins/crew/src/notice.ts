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
 *   can be read after later rounds were recorded, so "the child's latest run" can be another round's. The step's notices
 *   are matched from the last, and a run one of them took is not another's (`runOf`):
 *   - **By the notice's id,** first. The host plugin notes the id of each finish notice it sees enter the parent's inbox,
 *     and files it on the run whose `subagent/end` follows in the same synchronous run (`RunRecord.notice`). A notice whose
 *     id is on a run is that run's, whatever its shape; if a notice of the step took that run already, it has none. No file
 *     is read.
 *   - **Otherwise by what it says,** over the runs that have no notice id: a run another notice was filed for is never
 *     taken by text (two runs a `report` call ended both say "(no closing message)", and would match each other). This is
 *     what is left for a run crew filed without seeing its notice (crew loaded late) and for records from before step 7.
 *     The run's report file must hold the notice's closing text (`closingOf` its blocks, and `reportContent` of that, the
 *     rules `record.ts` records a run by and this reads one back by), and the run's stop reason must be the one dsh's
 *     opening line says (see `IMPLIED`). A report that can't be read is not the run, and is told of once. Of the runs that
 *     match, the newest not claimed by another notice of the step is the one: if two rounds said the same and ended the
 *     same way, the last notice gets the newest run and the one before it the next. A notice in a shape that isn't known
 *     has no closing text to compare. A report is compared by its size and its first `COMPARE_BYTES`, never read whole.
 *   - A notice that matches no run is rewritten without a report path: dsh's own account of how the child ended, with the
 *     child named.
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
 * error, or no result. A notice with no run matched to it says nothing of a gate, as it names no report. The gate line
 * doesn't change the collapsed row's sentence (`noticeSummary`).
 *
 * **Structured reports** (step 7). A coder or a reviewer (`reportRole`) finishes with crew's `report` tool, and dsh's notice of
 * a turn that call ended says only "It left no closing message.": dsh keeps the text blocks of the last message, and the
 * report is a tool call. The record has it (`RunRecord.structured`, and its `.json` as `structuredFile`), so a run with one
 * is told as the report:
 *
 * > coder «add login» (claude-sonnet-5.5) finished: done. Report: `/…/3-coder-1.json`. Its report:
 * >
 * > Status: done
 * > Summary: …
 *
 * The first block is that sentence (with the gate line before `Its report:`), the second the report (`reportBlock`), every
 * string of it masked again; dsh's "It left no closing message." is dropped, and a closing message the child did write
 * follows the report, after `Its closing message:`, as dsh's own blocks. The collapsed row's sentence says what was
 * reported: `finished: done.`, `blocked`, `needs context`, `approved` or `changes requested`. A coder's or a reviewer's run
 * without one says so (`NO_STRUCTURED_REPORT`), before dsh's label; other roles' notices are as they were.
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
import { maskSecrets } from 'dish-kit'
import type { DishCrew } from './index.ts'
import { SEVERITIES, closingOf, reportContent, reportRole } from './record.ts'
import { BLOCK_END } from './text.ts'
import type { ChildRecord, RunRecord, StructuredReport } from './record.ts'

/** The longest a notice waits for a run that is being recorded, in ms. */
export const WAIT_MS = 2000

/** What a coder's or reviewer's notice says when its run has no structured report (`noticeText`). */
export const NO_STRUCTURED_REPORT = 'It ended without a successful `report`, so there is no structured report.'

/** What leads the report in the notice of a run that has one. */
const REPORT_LABEL = 'Its report:'

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

/** What a notice says of a child. `reviews` is for `reportRole`. */
type Child = Pick<ChildRecord, 'id' | 'role' | 'title' | 'model' | 'worktree' | 'reviews'>

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

// --- the report -----------------------------------------------------------------------------------------------------

/** A word of the report's own (a status, a verdict, a severity) as it is said: masked, like every string, `_` a space. */
function said(word: string): string {
  return maskSecrets(word).replaceAll('_', ' ')
}

/** `text` masked and trimmed, its own line breaks kept: a summary. */
function kept(text: string): string {
  return maskSecrets(text).trim()
}

/** `text` masked, on one line: a field of a list item. */
function folded(text: string): string {
  return maskSecrets(text).replace(/\s+/g, ' ').trim()
}

/** `text` masked, as an inline code span (`codeSpan`). */
function code(text: string): string {
  return codeSpan(maskSecrets(text))
}

/** What a report says of how the work ended, for the notice's first sentence: `done`, …, `changes requested`. */
function outcomeOf(report: StructuredReport): string {
  return said(report.role === 'coder' ? report.status : report.verdict)
}

/**
 * The report as the notice shows it: a line for each field there is (an absent field, or an empty list, has none), joined by
 * `\n`, with each list item folded onto a line of its own. Every string goes through `maskSecrets` again: the record masked it
 * (`setReport`), and this is where it is written into a message.
 *
 * - A coder's: `Status: done` (or `blocked`, `needs context`); `Summary: …`, trimmed, its own line breaks kept; `Commits:`
 *   and the shas as code spans, joined by `, `; `Blocked on: …`; `Rulings:` and `- <what> — <why> — <cost if wrong>` for
 *   each; `Concerns:` and `- <concern>`; `Not fixed:` and `- <finding> — <why>`.
 * - A reviewer's: `Verdict: approved` (or `changes requested`) and, when it gave one, `, at ` the head as a code span; `Summary: …`;
 *   `Findings (<n>): <k> blocking, <k> should_fix, <k> nit`, the counts above 0 only, or `Findings: none`; for each finding
 *   `- [<severity>] ` its file (and `:<line>`) as a code span, then `: <summary> Fix: <fix>`; `Checks:` and, for each, the
 *   command as a code span, then ` exit <code>: <summary>`; `Addressed:` and `- <finding>: addressed. <evidence>`, or
 *   `NOT addressed`.
 *
 * Code spans are `codeSpan`'s: one line, with marks longer than any run of backticks inside.
 */
export function reportBlock(report: StructuredReport): string {
  const lines: string[] = []
  const list = <T>(title: string, items: readonly T[] | undefined, line: (item: T) => string): void => {
    if (items !== undefined && items.length > 0) lines.push(title, ...items.map(item => `- ${line(item)}`))
  }
  if (report.role === 'coder') {
    lines.push(`Status: ${outcomeOf(report)}`, `Summary: ${kept(report.summary)}`)
    if (report.commits !== undefined && report.commits.length > 0) lines.push(`Commits: ${report.commits.map(code).join(', ')}`)
    if (report.blockedOn !== undefined && report.blockedOn.trim() !== '') lines.push(`Blocked on: ${kept(report.blockedOn)}`)
    list('Rulings:', report.rulings, ruling => [ruling.what, ruling.why, ruling.costIfWrong].map(folded).join(' — '))
    list('Concerns:', report.concerns, folded)
    list('Not fixed:', report.notFixed, item => `${folded(item.finding)} — ${folded(item.why)}`)
  } else {
    lines.push(`Verdict: ${outcomeOf(report)}${report.head === undefined ? '' : `, at ${code(report.head)}`}`, `Summary: ${kept(report.summary)}`)
    const { findings } = report
    const counts = SEVERITIES.map(severity => [severity, findings.filter(finding => finding.severity === severity).length] as const)
      .filter(([, count]) => count > 0).map(([severity, count]) => `${count} ${severity}`)
    lines.push(findings.length === 0 ? 'Findings: none' : `Findings (${findings.length}): ${counts.join(', ')}`)
    for (const finding of findings) {
      const where = finding.line === undefined ? finding.file : `${finding.file}:${finding.line}`
      lines.push(`- [${maskSecrets(finding.severity)}] ${code(where)}: ${folded(finding.summary)} Fix: ${folded(finding.fix)}`)
    }
    list('Checks:', report.checks, check => `${code(check.command)} exit ${check.exitCode}: ${folded(check.summary)}`)
    list('Addressed:', report.addressed, item => `${folded(item.finding)}: ${item.addressed ? 'addressed' : 'NOT addressed'}. ${folded(item.evidence)}`)
  }
  // A blank field leaves no space at the end of its line.
  return lines.map(line => line.trimEnd()).join('\n')
}

/**
 * The notice's line on how a bound child's gate ended in `run`, from the run's last gate result, in the words of the gates
 * spec's "The finish notice":
 *
 * - passed: `Gate passed (round N).`, in a run that ended `completed`. A run that ended another way after its gate passed (a
 *   follow-up steered into the same turn had the coder go on, and the turn was aborted or failed) says `Gate passed earlier
 *   in this run (round N), but the run ended (<reason>) after it, so any work after the gate wasn't gated.`: the review
 *   check doesn't count that pass either;
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
      if (run.stopReason !== 'completed') {
        return `Gate passed earlier in this run (round ${result.round}), but the run ended (${oneLine(run.stopReason) ?? 'unknown'}) after it, so any work after the gate wasn't gated.`
      }
      return `Gate passed (round ${result.round}).`
    case 'skipped':
      return `Gate skipped${because}.`
    case 'error':
      return `Gate not run${because}.`
    case 'failed': {
      const ended = result.timedOut ? 'stopped at its time limit' : result.exitCode === null ? 'no exit code' : `exit ${result.exitCode}`
      // Masked again: dish-gates records it masked, but a record from before it did holds it as projects.yaml had it.
      const what = `${result.command === '' ? '' : `${codeSpan(maskSecrets(result.command))}, `}${ended}`
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
 * The first sentence of a notice: who, and how it ended, without the report. A run with a structured report that ended
 * `completed` says what it reported: `finished: done.` (or `blocked`, `needs context`, `approved`, `changes requested`).
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
  if (run.stopReason === 'completed') return run.structured === undefined ? `${who} finished.` : `${who} finished: ${outcomeOf(run.structured)}.`
  const verb = Object.hasOwn(VERBS, run.stopReason) ? VERBS[run.stopReason]! : `stopped (${run.stopReason})`
  const error = oneLine(run.error)
  return `${who} ${verb}${error === undefined ? '' : `: ${error}`}.`
}

/**
 * The text that leads a notice: its first sentence, the report, the gate line of a bound child (`gateLine`), and what dsh put
 * before the closing message.
 *
 * - A run with a structured report cites its `.json` (`structuredFile`, else the `.md`), and ends `Its report:`: the report
 *   follows (`reportBlock`), and `label` isn't used.
 * - A coder's or a reviewer's run without one (`reportRole`) says `NO_STRUCTURED_REPORT` before `label`.
 * - Any other run names its report and then `label`; a notice with no run, only `label`.
 * @param child - the child the notice is of.
 * @param run - the run that ended, or `undefined` if the record has none for this notice (no report is named then).
 * @param lead - dsh's own opening line.
 * @param label - what dsh put after its opening line: `Its closing message:` or `It left no closing message.`. Left out if
 * the message has no such block.
 * @param gatesOn - whether dish-gates is running (`gateLine`).
 */
export function noticeText(child: Child, run: RunRecord | undefined, lead: string, label?: string, gatesOn = true): string {
  const head = noticeSummary(child, run, lead)
  if (run === undefined) return label === undefined ? head : `${head} ${label}`
  const gate = gateLine(child, run, gatesOn)
  const gated = gate === undefined ? '' : ` ${gate}`
  if (run.structured !== undefined) return `${head} Report: \`${run.structuredFile ?? run.report}\`.${gated} ${REPORT_LABEL}`
  const parts = [`${head} Report: \`${run.report}\`.${gated}`]
  if (reportRole(child) !== undefined) parts.push(NO_STRUCTURED_REPORT)
  if (label !== undefined) parts.push(label)
  return parts.join(' ')
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
 * The run of `runs` that `message` (taken apart as `parts`) is the notice of, if it isn't in `claimed`, which it is added to:
 *
 * 1. the newest run filed with the message's id as its `notice`. Claimed already (the same message twice in a step), there is
 *    none, and no other is looked for. No file is read, so this holds for a message of any shape;
 * 2. else, of the runs that have no `notice`, the newest that says what the notice says (see the module's header). A report
 *    that can't be read isn't the run: `unreadable` is told, and the search goes on with the runs before it.
 */
async function runOf(message: UserMessage, parts: Parts, runs: readonly RunRecord[], claimed: Set<RunRecord>, unreadable: (run: RunRecord, error: unknown) => void): Promise<RunRecord | undefined> {
  // The host plugin files an id only when it is a non-empty string, so no other is looked for.
  const id: unknown = message.id
  const noticed = typeof id === 'string' && id !== '' ? runs.findLast(run => run.notice === id) : undefined
  if (noticed !== undefined) {
    if (claimed.has(noticed)) return undefined
    claimed.add(noticed)
    return noticed
  }
  if (parts.report === undefined) return undefined
  for (let index = runs.length - 1; index >= 0; index--) {
    const run = runs[index]!
    // A run another notice was filed for is that notice's: two runs a `report` call ended both say "(no closing message)".
    if (run.notice !== undefined || claimed.has(run) || (parts.implied !== undefined && run.stopReason !== parts.implied)) continue
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

/** A text block, frozen as dsh's are. */
function textBlock(text: string): ContentBlock {
  return Object.freeze({ type: 'text', text })
}

/**
 * `message` with the text that leads it and its source's summary replaced. When dsh's blocks follow it (the closing
 * message), crew's text ends with a blank line (`BLOCK_END`): dsh's adapters join text blocks with nothing between them.
 *
 * A run with a structured report has two blocks of crew's: the first sentence, ending `Its report:`, and the report
 * (`reportBlock`), followed by `Its closing message:` when dsh's label was that. dsh's `It left no closing message.` goes:
 * the report is the message.
 */
function rewritten(message: UserMessage, child: ChildRecord, parts: Parts, run: RunRecord | undefined, gatesOn: boolean): UserMessage {
  // The blocks that stay are dsh's own, frozen already.
  const rest = message.content.slice(parts.label === undefined ? 1 : 2)
  const lead = noticeText(child, run, parts.lead, parts.label, gatesOn)
  const after = rest.length === 0 ? '' : BLOCK_END
  const ours = run?.structured === undefined
    ? [textBlock(`${lead}${after}`)]
    : [textBlock(`${lead}${BLOCK_END}`), textBlock(`${reportBlock(run.structured)}${parts.label === CLOSING_LABEL ? `${BLOCK_END}${CLOSING_LABEL}` : ''}${after}`)]
  const content = Object.freeze([...ours, ...rest])
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
        out[index] = rewritten(message, record, parts, await runOf(message, parts, record.runs, claimed, unreadable), context.gatesOn ?? true)
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
