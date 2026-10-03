/**
 * Small helpers the store, the ledger, the listeners and the tools share: type checks, wording, and masking. Plain functions
 * of their arguments, with no I/O. Only `line` and `masked` mask (dish-kit's `maskSecrets`); the rest leave text as it is.
 * @module dish-orchestrator/text
 */

import { maskSecrets } from 'dish-kit'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** Where a cut text ends. */
const CUT_MARK = '…'

/** A plain object: not null, not a list. */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A string with something in it. */
export function isText(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}

/** A Node error's `code` (`ENOENT`, `EEXIST`, …), or undefined. */
export function errorCode(error: unknown): unknown {
  return (error as { code?: unknown } | null)?.code
}

/** `text` ending a sentence: a period added unless it ends with one (or `!` or `?`) already. */
export function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`
}

/** `undefined` for `''` or blanks, else trimmed: models fill every optional parameter (dish-workspaces' `given`, in its `worktree` tool). */
export function given(value: string | undefined): string | undefined {
  const trimmed = typeof value === 'string' ? value.trim() : undefined
  return trimmed === undefined || trimmed === '' ? undefined : trimmed
}

/** Runs of whitespace, line breaks among them, folded into one space (crew's `oneLine`, in `delegate`). */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** `text`'s first `units` UTF-16 units, one fewer when the last would be the first half of a surrogate pair. */
export function headOf(text: string, units: number): string {
  const head = text.slice(0, Math.max(0, units))
  return /[\ud800-\udbff]$/.test(head) ? head.slice(0, -1) : head
}

/** At most `max` UTF-16 units, never ending in half a surrogate pair, with '…' when cut (the '…' counts in `max`). */
export function cut(text: string, max: number): string {
  if (text.length <= max) return text
  if (max < 1) return ''
  return headOf(text, max - CUT_MARK.length) + CUT_MARK
}

/** Folded to one line, masked, and cut to `max` (1000 when not given): a field a refusal, the ledger or the record keeps. */
export function line(text: string, max = 1000): string {
  return cut(oneLine(maskSecrets(oneLine(text))), max)
}

/** `value` with every string in it, and every key, masked, at any depth: for what came from outside the code. */
export function masked<T>(value: T): T {
  if (typeof value === 'string') return maskSecrets(value) as T
  if (Array.isArray(value)) return value.map(masked) as T
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [maskSecrets(key), masked(inner)])) as T
  }
  return value
}

/** How a ruling is written, as the refusals and the parameters say it. */
export const RULING_FORM = 'Ruling: what — why — cost if wrong'
/** What a ruling says, without `Ruling:`. */
const RULING_BODY = 'what — why — cost if wrong'
/** The placeholder, with or without `Ruling:`, compared without case: a model that copies it back has given no ruling. */
const PLACEHOLDERS: readonly string[] = [RULING_FORM.toLowerCase(), RULING_BODY.toLowerCase()]
/** A leading `Ruling:`, with the Markdown marks a model puts around it (`**Ruling:**`, `> _Ruling_:`). */
const RULING_LEAD = /^[\s#>*_`]*ruling[*_`]*\s*:[*_`]*/iu

/** Something with a letter or digit past a leading `Ruling:`, that isn't the placeholder (crew's `hasRuling` and `PLACEHOLDERS`, in `delegate`, copied). */
export function hasRuling(text: string): boolean {
  if (PLACEHOLDERS.includes(oneLine(text).toLowerCase())) return false
  return /[\p{L}\p{N}]/u.test(text.replace(RULING_LEAD, ''))
}

/** The ruling on one line, with a leading `Ruling:` (and Markdown marks around it) taken off. */
export function rulingBody(text: string): string {
  return oneLine(oneLine(text).replace(RULING_LEAD, ''))
}

/** The first 7 characters. */
export function shortSha(sha: string): string {
  return sha.slice(0, 7)
}

/** The first 8, and '…' when longer. */
export function shortSession(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id
}

/**
 * 'just now', '12 min ago', '5 h ago', '3 days ago', then the UTC date: the rule of dish-workspaces' client `relativeTime`.
 * Rounds down; under 48 hours is hours, under 30 days is days. A time ahead of `now` is 'just now', and one
 * that names no date 'at an unknown time'.
 */
export function age(time: number, now: number): string {
  if (Number.isNaN(new Date(time).getTime()) || !Number.isFinite(now)) return 'at an unknown time'
  const elapsed = now - time
  if (elapsed < MINUTE) return 'just now'
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} min ago`
  if (elapsed < 48 * HOUR) return `${Math.floor(elapsed / HOUR)} h ago`
  if (elapsed < 30 * DAY) return `${Math.floor(elapsed / DAY)} days ago`
  return new Date(time).toISOString().slice(0, 10)
}
