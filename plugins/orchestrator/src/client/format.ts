/**
 * The page's wording for times, commits, sessions, durations and pull requests. Plain TypeScript with no DOM or React in it, so
 * `node --test` can load it.
 * @module dish-orchestrator/client/format
 */

import type { DriverInfo } from '../protocol.ts'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * How long before `now` a time was, in a few words (dish-workspaces' client `relativeTime`). Rounds down, so
 * "59 min ago" never becomes "60 min ago"; after 30 days it is the (UTC) date. A time ahead of `now` (a clock that runs fast)
 * is "just now", and one that names no date (a ledger line can say anything) is "at an unknown time".
 * @param time - milliseconds since the epoch.
 * @param now - the same, for the present.
 */
export function relativeTime(time: number, now: number): string {
  if (typeof time !== 'number' || Number.isNaN(new Date(time).getTime()) || !Number.isFinite(now)) return 'at an unknown time'
  const age = now - time
  if (age < MINUTE) return 'just now'
  if (age < HOUR) return `${Math.floor(age / MINUTE)} min ago`
  if (age < 48 * HOUR) return `${Math.floor(age / HOUR)} h ago`
  if (age < 30 * DAY) return `${Math.floor(age / DAY)} days ago`
  return new Date(time).toISOString().slice(0, 10)
}

/** The time in full, for a tooltip; `''` for one that names no date. */
export function fullTime(time: number): string {
  const date = new Date(time)
  return typeof time !== 'number' || Number.isNaN(date.getTime()) ? '' : date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC')
}

/** The short form of a commit id: its first 7 characters. */
export function shortSha(sha: string): string {
  return String(sha).slice(0, 7)
}

/** A session id's first 8 characters, and '…' when it is longer. */
export function shortSession(id: string): string {
  const text = String(id)
  return text.length > 8 ? `${text.slice(0, 8)}…` : text
}

/** Who drives a run, in words: "driven by session 01234567… (live)", "… (not live)", or "no driver". */
export function driverText(driver: DriverInfo | null): string {
  if (driver === null) return 'no driver'
  return `driven by session ${shortSession(driver.session)} (${driver.live ? 'live' : 'not live'})`
}

/** How long something took: "900 ms", "1.2 s", "5 min 3 s". */
export function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'an unknown time'
  if (ms < 1_000) return `${Math.round(ms)} ms`
  if (ms < MINUTE) return `${(Math.round(ms / 100) / 10).toFixed(1)} s`
  const minutes = Math.floor(ms / MINUTE)
  const seconds = Math.round((ms % MINUTE) / 1_000)
  return seconds === 0 ? `${minutes} min` : `${minutes} min ${seconds} s`
}

/** A run's state, as its tag says it. */
export function stateLabel(state: string): string {
  switch (state) {
    case 'open': return 'open'
    case 'pr': return 'PR'
    case 'abandoned': return 'abandoned'
    default: return String(state)
  }
}

/** A verdict in words. */
export function verdictLabel(verdict: string): string {
  return verdict === 'changes_requested' ? 'changes requested' : String(verdict)
}

/** One owner or repository name: letters, digits, `.`, `_` and `-`, and not `.` or `..` (orchestrator's `SEGMENT`). */
const SEGMENT = /^(?!\.{1,2}$)[A-Za-z0-9._-]+$/
const PULL = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/([1-9][0-9]{0,9})$/

/**
 * `url` when it is exactly `https://github.com/<owner>/<repo>/pull/<n>`; else undefined, and the page shows it as text. The
 * only way a string from a record or a ledger becomes a link: nothing with another scheme, host, user, path, query or
 * fragment passes.
 */
export function prHref(url: string): string | undefined {
  if (typeof url !== 'string') return undefined
  const match = PULL.exec(url)
  if (match === null || !SEGMENT.test(match[1]!) || !SEGMENT.test(match[2]!)) return undefined
  return url
}
