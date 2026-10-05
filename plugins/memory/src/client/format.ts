/**
 * The page's wording for scopes, ids, authors, times, commit ids and the remote line, and the counts its fields show. Plain
 * TypeScript with no DOM or React in it, so `node --test` can load it. The author, time, id and remote-line helpers are the
 * History page's own (`dish-config/src/client/format.ts`), kept in step by hand: dish-config's client has no source export to
 * import them from. Ids and paths come from the memory format itself (`../format.ts`, pure), so the page names a memory as
 * agents and the vault do.
 * @module dish-memory/client/format
 */

import { memoryId, memoryPath } from '../format.ts'
import type { Author, CommitInfo, RemoteStatus, ScopeInfo, ScopeKey } from '../protocol.ts'

/** How a family's scope key starts. */
const FAMILY = 'family:'

/** A memory's id, as agents name it: `user/<name>`, or `family/<name>` in a family's scope. */
export function idOf(scope: ScopeKey, name: string): string {
  return memoryId(scope === 'user' ? 'user' : 'family', name)
}

/** The family a scope key names (`family:<family>`), or `undefined` for You (or no scope). */
export function familyOf(scope: ScopeKey | undefined): string | undefined {
  return scope !== undefined && scope.startsWith(FAMILY) ? scope.slice(FAMILY.length) : undefined
}

/** A memory's file in the vault: `user/<name>.md`, or `families/<family>/<name>.md`. */
export function memoryPathOf(scope: ScopeKey, name: string): string {
  const family = familyOf(scope)
  return memoryPath(family === undefined ? { kind: 'user' } : { kind: 'family', family }, name)
}

/** The fields a person edits, as one text: what a conflict's diff compares. */
export function memoryText(memory: { type: string, description: string, body: string }): string {
  return `type: ${memory.type}\ndescription: ${memory.description}\n\n${memory.body}`
}

/** The length of `text` in characters (code points), as the service counts a description and a direction. */
export function characters(text: string): number {
  let count = 0
  for (const _ of text) count++
  return count
}

const encoder = new TextEncoder()

/** The length of `text` in bytes of UTF-8, as the service counts a body. */
export function byteLength(text: string): number {
  return encoder.encode(text).length
}

/** A scope as the narrow page's select names it: its label, its count, how many are held, and an orphan's mark. */
export function scopeOptionText(scope: ScopeInfo): string {
  const marks = [`${scope.count}`]
  if (scope.held > 0) marks.push(`${scope.held} held`)
  if (scope.orphan) marks.push('no projects')
  return `${scope.label} (${marks.join(', ')})`
}

/** Who made a change, as the page says it: `You`, `<role> agent`, or `dish-memory` for the vault's own commits. */
export function authorLabel(author: Author): string {
  switch (author.kind) {
    case 'user': return 'You'
    case 'agent': return author.role === undefined || author.role === '' ? 'Agent' : `${author.role} agent`
    case 'system': return 'dish-memory'
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

/** When a memory was modified, as the list says it: `relativeTime` of its `modified`, or the value as it is when it isn't a time. */
export function modifiedText(modified: string, now: number): string {
  const time = Date.parse(modified)
  return Number.isNaN(time) ? modified : relativeTime(time, now)
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
 * The remote line at the top of the page, as Settings → History words it: `Pushed <short id> · <n> pending · <last error>`.
 * Without a pushed commit (none yet from this process) it starts `Not pushed yet`, and without an error that part is left out.
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
