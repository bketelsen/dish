/**
 * The page's wording for authors, times, commit ids and the remote line. Plain TypeScript with no DOM or React in it,
 * so `node --test` can load it.
 * @module dish-config/client/format
 */

import type { Author, CommitInfo, ProposalInfo, RemoteStatus } from '../protocol.ts'

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
 * 30 days it is the (UTC) date, since "41 days ago" says less than the day. A time ahead of `now` (a clock that runs
 * fast) is "just now".
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
export function commitText(commit: Pick<CommitInfo, 'note' | 'message'>): string {
  return commit.note !== undefined && commit.note !== '' ? commit.note : subjectOf(commit.message)
}

/**
 * The remote line at the top of the page: `Pushed <short id> · <n> pending · <last error>`. Without a pushed commit
 * (none yet from this process) it starts `Not pushed yet`, and without an error that part is left out.
 */
export function remoteLine(status: RemoteStatus): string {
  if (status.remote === undefined) return 'No remote configured'
  const parts = [
    status.pushed === undefined ? 'Not pushed yet' : `Pushed ${shortId(status.pushed)}`,
    `${status.pending} pending`,
  ]
  if (status.lastError !== undefined && status.lastError !== '') parts.push(status.lastError)
  return parts.join(' · ')
}

/**
 * The proposals as the page lists them: those that wait on a decision (open, then stale ones where they fall) first,
 * then the rejected ones, each group in the order given (the store's is newest first).
 */
export function orderProposals(proposals: readonly ProposalInfo[]): ProposalInfo[] {
  return [
    ...proposals.filter(proposal => proposal.status !== 'rejected'),
    ...proposals.filter(proposal => proposal.status === 'rejected'),
  ]
}
