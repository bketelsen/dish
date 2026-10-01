/**
 * What the Decisions table makes of log lines: the reading of each (what Jev answered, in words), how a decision is toned, and
 * how the lines of one tool call are grouped. Plain TypeScript with no DOM or React in it, so `node --test` can load it.
 *
 * Every function gives plain strings, and none of them looks inside a string. What a line says (the subject, the answers'
 * names, a choice's option) is written by agents and by web pages, so the components show it as text and as nothing else; see
 * `LogLines.tsx`. The log's own shapes are trusted no further than this: an answer is any JSON, and reads as something.
 *
 * @module dish-judge/client/decisions
 */

import type { JsonValue, LogLine, PurposeName } from '../protocol.ts'
import type { WithheldView } from './controller.ts'
import { probability } from './format.ts'

/** What a Jev call was for, in the order the filter offers them. */
export const PURPOSES: readonly PurposeName[] = ['command', 'approval', 'screen', 'ask']

/**
 * The decisions the judge writes, for the filter to offer: the command gate's, the approval answerer's, the result screen's and
 * `ask_judge`'s, and the test button's. The set is open (a later version may write more, and the log holds older ones), so the
 * filter takes any text and these are only its suggestions.
 */
export const KNOWN_DECISIONS: readonly string[] = [
  'allow', 'ask', 'deny', 'cancel',
  'pass', 'allowed-once', 'rejected',
  'withhold', 'warn', 'not-screened', 'split',
  'answered', 'refused', 'unavailable', 'too-big',
  'test',
]

export type Tone = 'success' | 'warning' | 'danger' | 'neutral'

/**
 * How a decision looks: what ran or passed is green, what asks the person or kept a doubt is amber, what stopped something is
 * red, and what is none of those (a cancel, a test, a decision this page has not heard of, none recorded) is plain. `pass` is
 * two things: on a screen it found nothing; on an approval it is the judge passing the question on to the person.
 */
export function decisionTone(decision: string | null, purpose: PurposeName): Tone {
  switch (decision) {
    case 'allow': case 'allowed-once': case 'answered': return 'success'
    case 'pass': return purpose === 'screen' ? 'success' : 'neutral'
    case 'ask': case 'warn': case 'not-screened': case 'split': return 'warning'
    case 'deny': case 'withhold': case 'rejected': case 'refused': case 'unavailable': case 'too-big': return 'danger'
    default: return 'neutral'
  }
}

/** One answer of a line, as a label and the text to put after it, and the probabilities behind it when the line kept them. */
export interface ReadingPart {
  label: string
  text: string
  detail?: string
}

/** What the gate's two questions are called on the page; any other question is called by its own id. */
const LABELS: Readonly<Record<string, string>> = { effect: 'effect', serves_task: 'serves the task' }

const MAX_LABEL = 80
const MAX_TEXT = 120
const MAX_DETAIL = 1_000

/** `text` cut to `length` characters, with `…` where it was cut. */
function clip(text: string, length: number): string {
  return text.length > length ? `${text.slice(0, length - 1)}…` : text
}

function isRecord(value: unknown): value is { [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `value` as one short text: a string as it is, a number as a probability, anything else as JSON. */
function plainText(value: JsonValue | undefined): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'string') return clip(value, MAX_TEXT)
  if (typeof value === 'number') return probability(value)
  if (typeof value === 'boolean') return String(value)
  return clip(JSON.stringify(value), MAX_TEXT)
}

/** The probabilities of an answer, highest first (ties in the order Jev gave them), as `option 0.90` pieces; those that are not numbers are left out. */
function probabilitiesOf(answer: { [key: string]: JsonValue }): string[] {
  const given = answer.probabilities
  if (!isRecord(given)) return []
  return Object.entries(given)
    .flatMap(([option, value]) => typeof value === 'number' ? [[option, value] as const] : [])
    .sort((a, b) => b[1] - a[1])
    .map(([option, value]) => `${option} ${probability(value)}`)
}

/** The detail of a choice or a score: its probabilities, and how sure Jev was. */
function detailOf(answer: { [key: string]: JsonValue }): string | undefined {
  const pieces = probabilitiesOf(answer)
  if (typeof answer.confidence === 'number') pieces.push(`confidence ${probability(answer.confidence)}`)
  return pieces.length === 0 ? undefined : clip(pieces.join(', '), MAX_DETAIL)
}

function partOf(id: string, answer: JsonValue): ReadingPart {
  const label = clip(LABELS[id] ?? id, MAX_LABEL)
  if (isRecord(answer)) {
    const detail = detailOf(answer)
    if (answer.type === 'choice' && typeof answer.choice === 'string') {
      const chosen = isRecord(answer.probabilities) ? answer.probabilities[answer.choice] : undefined
      const text = typeof chosen === 'number' ? `${answer.choice} (${probability(chosen)})` : answer.choice
      return detail === undefined ? { label, text: clip(text, MAX_TEXT) } : { label, text: clip(text, MAX_TEXT), detail }
    }
    if (answer.type === 'noul' && typeof answer.noul === 'number') return { label, text: `p ${probability(answer.noul)}` }
    if (answer.type === 'score' && typeof answer.score === 'number') {
      const text = `score ${answer.score.toFixed(2)}`
      return detail === undefined ? { label, text } : { label, text, detail }
    }
  }
  return { label, text: plainText(answer) }
}

/**
 * What Jev answered on `line`, one part for each question, in the order the line has them: for a command, the effect it chose
 * (with its probability, and the others behind it) and whether the command serves the task. A line whose answers were cut to fit
 * has bare values, and reads as them; one with no answers (Jev wasn't asked, or didn't answer) has none.
 */
export function readingOf(line: Pick<LogLine, 'answers'>): ReadingPart[] {
  return Object.entries(line.answers).map(([id, answer]) => partOf(id, answer))
}

/** The lines of one tool call, as the table shows them together. */
export interface LineGroup {
  /** Unique among the groups of one list, and the same for a group as lines older than it are added at the end of the list. */
  key: string
  /** The call id the lines share; none for a line that has none. */
  callId?: string
  /** Newest first, as they came. */
  lines: LogLine[]
}

/**
 * Group `lines` (newest first) by the tool call they are for: a command and its approval share a call id, and so do the
 * several Jev calls of one screen (a result split into chunks). A group stands where its newest line is. A call id belongs
 * to one agent, so the same id from two is two groups. A line without a call id is a group of its own.
 */
export function groupLines(lines: readonly LogLine[]): LineGroup[] {
  const groups: LineGroup[] = []
  const byCall = new Map<string, LineGroup>()
  lines.forEach((line, index) => {
    const call = line.callId
    if (call === undefined || call === '') {
      groups.push({ key: `line-${index}`, lines: [line] })
      return
    }
    const id = `${line.agent ?? ''}\u0000${call}`
    const found = byCall.get(id)
    if (found !== undefined) {
      found.lines.push(line)
      return
    }
    const group: LineGroup = { key: `call-${index}`, callId: call, lines: [line] }
    byCall.set(id, group)
    groups.push(group)
  })
  return groups
}

/** What the table is given: the lines, what is open of their withheld content, the time for "5 min ago", and what opens or folds one. */
export interface LogListProps {
  lines: readonly LogLine[]
  /** What is open, and what has been read, by withheld id. */
  withheld: Readonly<Record<string, WithheldView>>
  /** Now, in milliseconds since the epoch: for "5 min ago". */
  now: number
  toggleWithheld: (id: string) => void
}
