/**
 * The card's wording for times, installations and where a credential comes from. Plain TypeScript with no DOM or React in
 * it, so `node --test` can load it.
 * @module dish-workspaces/client/format
 */

import type { InstallationInfo } from '../protocol.ts'

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

/** Where dsh says a credential comes from, in words: `env` is the environment dsh was started in, `file` its credential file; any other source as dsh names it. */
export function sourceLabel(source: string | undefined): string {
  switch (source) {
    case undefined: return 'somewhere dsh can\'t change'
    case 'env': return 'the environment dsh was started in'
    case 'file': return 'dsh\'s credential file'
    default: return `the "${source}" source`
  }
}

/** What an installation covers: all of the owner's repositories, or the ones the owner chose. */
export function selectionText(selection: InstallationInfo['selection']): string {
  return selection === 'all' ? 'all repositories' : 'selected repositories'
}
