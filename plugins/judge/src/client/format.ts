/**
 * The page's wording for authors, times, commit ids, probabilities and latencies. Plain TypeScript with no DOM or React in
 * it, so `node --test` can load it. The author, time and id helpers are the History page's own
 * (`dish-config/src/client/format.ts`), kept in step by hand: dish-config's client has no source export to import them from.
 * @module dish-judge/client/format
 */

import type { Author } from '../protocol.ts'

/** Who made a change, as the page says it: `You`, `<role> agent`, or `dish-config` for the store's own commits. */
export function authorLabel(author: Author): string {
  switch (author.kind) {
    case 'user': return 'You'
    case 'agent': return author.role === undefined || author.role === '' ? 'Agent' : `${author.role} agent`
    case 'system': return 'dish-config'
  }
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * How long before `now` a time was, in a few words. Rounds down, so "59 min ago" never becomes "60 min ago"; after
 * 30 days it is the (UTC) date. A time ahead of `now` (a clock that runs fast) is "just now".
 * @param time - milliseconds since the epoch.
 * @param now - the same, for the present.
 */
export function relativeTime(time: number, now: number): string {
  const age = now - time
  if (age < MINUTE) return 'just now'
  if (age < HOUR) return `${Math.floor(age / MINUTE)} min ago`
  if (age < 48 * HOUR) return `${Math.floor(age / HOUR)} h ago`
  if (age < 30 * DAY) return `${Math.floor(age / DAY)} days ago`
  return new Date(time).toISOString().slice(0, 10)
}

/** The short form of a commit id: its first 7 characters. */
export function shortId(id: string): string {
  return id.slice(0, 7)
}

/** The first line of a commit message: what git calls its subject. */
export function subjectOf(message: string): string {
  const end = message.indexOf('\n')
  return end === -1 ? message : message.slice(0, end)
}

/** What a commit says it is for: the note its author gave, or else its subject. */
export function commitText(commit: { note?: string, message: string }): string {
  return commit.note !== undefined && commit.note !== '' ? commit.note : subjectOf(commit.message)
}

/** A probability the way the judge's table says it: two decimals. Anything that isn't a finite number is shown as it is. */
export function probability(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(2) : String(value)
}

/** A latency in milliseconds: `—` when there is none (`null`: Jev wasn't called, or nothing has answered yet). */
export function milliseconds(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value) ? '—' : `${Math.round(value)} ms`
}

/** An agent's session id, shortened to what tells it from the others: its first 8 characters. */
export function shortAgent(agent: string): string {
  return agent.length > 8 ? agent.slice(0, 8) : agent
}

/** Where dsh says a credential comes from, in words: `env` is the environment dsh was started in, `file` its credential file; any other source as dsh names it. */
export function sourceLabel(source: string | undefined): string {
  switch (source) {
    case undefined: return 'somewhere dsh can\'t change'
    case 'env': return 'the environment dsh was started in'
    case 'file': return 'dsh\'s credential file'
    default: return `the "${source}" source`
  }
}
