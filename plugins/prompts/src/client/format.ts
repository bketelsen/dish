/**
 * The page's wording for roles, authors, times and commit ids. Plain TypeScript with no DOM or React in it, so
 * `node --test` can load it. The author, time and id helpers are the History page's own (`dish-config/src/client/format.ts`),
 * kept in step by hand: dish-config's client has no source export to import them from.
 * @module dish-prompts/client/format
 */

import type { Author } from '../protocol.ts'

/** A role as the page's list says it: `Common`, `Main`, and a crew role by its name with a capital (`Front-end`). */
export function roleLabel(role: string): string {
  return role === '' ? '' : role[0]!.toUpperCase() + role.slice(1)
}

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
