/**
 * The text dish-gates writes: the cuts of a gate's output (the tail the coder is shown, the excerpt the record keeps), a few
 * small formatters, and the message steered to a coder whose gate failed.
 *
 * Nothing here reads a file or a service, and nothing screens the output: it is the coder's own, from its own code, and its
 * secrets were masked where it was captured (`run.ts`).
 *
 * @module dish-gates/text
 */

/** The most bytes of a gate's output shown to the coder. */
export const TAIL_MAX_BYTES = 16_384
/** The lines of a gate's output shown to the coder, when the settings don't say. */
export const DEFAULT_TAIL_LINES = 200
/** The lines of output crew's record keeps. */
export const EXCERPT_LINES = 10
/** The most characters of output crew's record keeps. */
export const EXCERPT_MAX_CHARS = 1000
/** The longest a steer's one-line summary may be: dsh's own bound for a notice. */
export const SUMMARY_MAX_CHARS = 120
/** Why a gate was skipped when the coder's closing message opted out. */
export const BLOCKED_REASON = 'the coder reported BLOCKED / NEEDS CONTEXT'

/** The longest a gate command is shown in the first line of a message. */
const COMMAND_SHOWN = 200
/** The longest a log problem is shown. */
const PROBLEM_SHOWN = 300

/**
 * The last `lines` lines of `output` (a final newline isn't a line), then at most its last `maxBytes` bytes of UTF-8, cut at
 * a character: UTF-8 never puts a surrogate pair's halves in separate characters, so the cut can't fall inside one. The cut
 * may leave the first line partial. No lines, or no bytes, is `''`.
 */
export function tailOf(output: string, lines: number, maxBytes: number = TAIL_MAX_BYTES): string {
  if (!(lines >= 1) || !(maxBytes >= 1)) return ''
  const parts = output.split('\n')
  if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop()
  const kept = parts.slice(-Math.floor(lines)).join('\n')
  if (Buffer.byteLength(kept) <= maxBytes) return kept
  const bytes = Buffer.from(kept, 'utf8')
  let start = bytes.length - Math.floor(maxBytes)
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1 // a continuation byte: inside a character
  return bytes.subarray(start).toString('utf8')
}

/** The record's excerpt: `tailOf(output, EXCERPT_LINES)`, then at most its last `EXCERPT_MAX_CHARS` characters (never half a pair). */
export function excerptOf(output: string): string {
  const tail = tailOf(output, EXCERPT_LINES)
  if (tail.length <= EXCERPT_MAX_CHARS) return tail
  let start = tail.length - EXCERPT_MAX_CHARS
  if (isLowSurrogate(tail.charCodeAt(start))) start += 1 // the cut fell inside a pair: drop its second half
  return tail.slice(start)
}

function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff
}

/** The length of the longest run of backticks in `text`. */
function longestBacktickRun(text: string): number {
  let longest = 0
  for (const run of text.match(/`+/g) ?? []) if (run.length > longest) longest = run.length
  return longest
}

/** `text` in a code fence of backticks longer than any run of backticks in it, at least three. */
export function fenced(text: string): string {
  const fence = '`'.repeat(Math.max(3, longestBacktickRun(text) + 1))
  return `${fence}\n${text}\n${fence}`
}

/** `text` as an inline code span: its delimiter is longer than any run of backticks in it, and padded where it holds one. */
function inlineCode(text: string): string {
  const longest = longestBacktickRun(text)
  if (longest === 0) return `\`${text}\``
  const mark = '`'.repeat(longest + 1)
  return `${mark} ${text} ${mark}`
}

/** `text` as one line: each run of line breaks, with the blanks around it, becomes `separator`. Cut to `max` characters. */
function oneLine(text: string, max: number, separator: string): string {
  const folded = text.split(/[\r\n]+/).map(line => line.trim()).filter(line => line !== '').join(separator)
  return cut(folded, max)
}

/** `text` cut to `max` characters, with `…` where it was cut, and never in the middle of a surrogate pair. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text
  let end = max - 1
  if (end > 0 && isLowSurrogate(text.charCodeAt(end))) end -= 1
  return `${text.slice(0, end)}…`
}

/** '850 ms', '42 s', '3 min 5 s'. Rounded to the unit shown, so 59.6 s is '1 min'. Not a time (negative, not finite): '0 ms'. */
export function duration(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.round(ms) : 0
  if (total < 1000) return `${total} ms`
  const seconds = Math.round(total / 1000)
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`
}

/** What the coder is told about a failed gate run. */
export interface Failure {
  /** The gate's command, as it ran. */
  command: string
  /** `null` when the run was killed and left no code. */
  exitCode: number | null
  timedOut: boolean
  /** The limit that applied: the executor's, which may be below the project's `gateTimeout`. */
  timeoutMs: number
  durationMs: number
  /** The end of the output, masked. The message takes at most its last `tailLines` lines and `TAIL_MAX_BYTES` bytes of it. */
  tail: string
  /** The settings' `tailLines`. Left out, `DEFAULT_TAIL_LINES`. */
  tailLines?: number
  /** Where the full output was written, or `null` when it couldn't be. */
  log: string | null
  /** Why there is no log, when there isn't. */
  logProblem?: string
  /** 1 + the failures already in this turn. */
  round: number
  maxRounds: number
  /** Whether the output has the sandbox's "Read-only file system" refusal in it. */
  denied: boolean
}

/**
 * The message steered to the coder. It is only for a failure the coder can fix and finish again on: rounds 1 to
 * `maxRounds - 1`. The failure that uses the last round ends the turn and is not sent back (the user's decision, 2026-10-03),
 * so a message for it would promise a gate run that won't happen: that throws a `RangeError`.
 */
export function failureMessage(failure: Failure): string {
  const { round, maxRounds } = failure
  if (!(round >= 1 && round < maxRounds)) {
    throw new RangeError(`the gate's failure message is for rounds 1 to maxRounds - 1; got round ${round} of ${maxRounds}`)
  }
  const command = inlineCode(oneLine(failure.command, COMMAND_SHOWN, ' ↵ '))
  const took = duration(failure.durationMs)
  const head = `The gate failed (round ${round} of ${maxRounds}): ${command}`
  const first = failure.timedOut ? `${head} was stopped at its time limit (${duration(failure.timeoutMs)}) after ${took}.`
    : failure.exitCode === null ? `${head} was killed after ${took}, with no exit code.`
      : `${head} exited ${failure.exitCode} after ${took}.`
  const shown = tailOf(failure.tail, failure.tailLines ?? DEFAULT_TAIL_LINES)
  const lines = [first, shown.trim() === '' ? 'It printed nothing.' : `Last lines of its output:\n${fenced(shown)}`]
  if (failure.denied) {
    lines.push('Some of it was refused with "Read-only file system": a gate can write in the clone and `/tmp`, and on dish\'s VM in the home directory, '
      + 'except dish\'s own files, `~/.ssh`, git\'s config and shell startup files. If it needs another directory, say so in your closing message.')
  }
  const problem = oneLine(failure.logProblem ?? '', PROBLEM_SHOWN, ' ').replace(/\.+$/, '')
  const log = failure.log !== null ? `Full log: ${inlineCode(failure.log)}.` : problem === '' ? '(No log.)' : `(No log: ${problem}.)`
  const fix = 'Fix it in your worktree and finish again; the gate runs again when you do.'
  lines.push(round === maxRounds - 1
    ? `${log} ${fix} If it fails once more, your turn ends with the failure, and the main agent decides what's next.`
    : `${log} ${fix}`)
  lines.push('If you\'re blocked, start your closing message with `BLOCKED: <question>` or `NEEDS CONTEXT: <what you need>`, and the gate is skipped.')
  return lines.join('\n')
}

/** The steer's one-line summary, at most `SUMMARY_MAX_CHARS`: "Gate failed (round 1 of 3): exit 1". */
export function failureSummary(failure: Failure): string {
  const why = failure.timedOut ? `timed out after ${duration(failure.timeoutMs)}`
    : failure.exitCode === null ? 'killed'
      : `exit ${failure.exitCode}`
  return cut(`Gate failed (round ${failure.round} of ${failure.maxRounds}): ${why}`, SUMMARY_MAX_CHARS)
}
