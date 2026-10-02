/**
 * The page's wording for states, times, fetches, skipped setup, settings and the question about leaving a form. Plain
 * TypeScript with no DOM or React in it, so `node --test` can load it. The time helper is the History page's own
 * (`dish-config/src/client/format.ts`), kept in step by hand: dish-config's client has no source export to import it from.
 * @module dish-projects/client/format
 */

import type { Fields, ProjectInfo, ProjectState } from '../protocol.ts'
import type { Then } from './controller.ts'

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

// --- status --------------------------------------------------------------------------------------

/** The palette a chip is drawn in: a subset of the primitives' `TagTone`s. */
export type ChipTone = 'neutral' | 'info' | 'success' | 'danger'

/** What a state's chip says: the state's own name. */
export function stateLabel(state: ProjectState): string {
  return state
}

/** The colour of a state's chip: a project being worked on is blue, a ready one green, a failed one red, one not started grey. */
export function stateTone(state: ProjectState): ChipTone {
  switch (state) {
    case 'pending': return 'neutral'
    case 'cloning':
    case 'setup': return 'info'
    case 'ready': return 'success'
    case 'failed': return 'danger'
  }
}

/** The state, and when it began, once dish has said something of the project (`at` is 0 until then). */
export function statusLine(status: ProjectInfo['status'], now: number): string {
  return status.at === 0 ? stateLabel(status.state) : `${stateLabel(status.state)}, ${relativeTime(status.at, now)}`
}

/** The last fetch of a project's clone, in a sentence, and whether it worked (a failed one is drawn as a problem). */
export function fetchText(lastFetch: ProjectInfo['lastFetch'], now: number): { text: string, ok: boolean } {
  if (lastFetch === null) return { text: 'not fetched yet', ok: true }
  const when = relativeTime(lastFetch.at, now)
  if (lastFetch.ok) return { text: `fetched ${when}`, ok: true }
  return { text: lastFetch.message === null || lastFetch.message === '' ? `fetch failed ${when}` : `fetch failed ${when}: ${lastFetch.message}`, ok: false }
}

/** What Retry does, for the button's title and the line beside it. */
export function retryHint(state: ProjectState): string {
  return state === 'ready'
    ? 'Retry onboards the project again: it adopts the clone, skips setup (run the command yourself) and brings back a workspace you removed.'
    : 'Try onboarding again.'
}

/** A skipped setup as the page shows it: why, and the command to run instead when the message names one. */
export interface SkippedParts {
  reason: string
  /** The directory to run the command in. */
  where?: string
  command?: string
}

/**
 * Take the message dish-workspaces gives for a skipped setup apart: `<reason> Run it yourself in <directory>: <command>`. Any
 * other text is the reason as it is, shown whole.
 */
export function skippedParts(text: string): SkippedParts {
  const parts = /^(.*?)\s*Run it yourself in (.+?): (.+)$/s.exec(text)
  if (parts === null) return { reason: text }
  return { reason: parts[1]!, where: parts[2]!, command: parts[3]! }
}

/** A project as the narrow page's `<select>` says it: its name, then the marks the list would show beside it. */
export function optionText(project: Pick<ProjectInfo, 'name' | 'status'>): string {
  const marks: string[] = [stateLabel(project.status.state)]
  if (project.status.setupSkipped !== null) marks.push('setup skipped')
  return `${project.name} (${marks.join(', ')})`
}

// --- settings ------------------------------------------------------------------------------------

/** The settings in the order the form shows them, with their labels. */
export const FIELD_LABELS = [
  ['family', 'Family'],
  ['role', 'Role'],
  ['gate', 'Gate'],
  ['gateTimeout', 'Gate timeout'],
  ['setup', 'Setup'],
  ['setupTimeout', 'Setup timeout'],
  ['gateEnv', 'Gate environment'],
] as const

export type SettingKey = typeof FIELD_LABELS[number][0]

/** The default `setupTimeout` when none is given (the registry's). */
const DEFAULT_SETUP_TIMEOUT = '15m'

/** The environment as `NAME=value, NAME=value`, by name; `none` for no variables. */
function envText(env: Readonly<Record<string, string>>): string {
  const names = Object.keys(env).sort()
  return names.length === 0 ? 'none' : names.map(name => `${name}=${env[name]}`).join(', ')
}

/** One setting as a person reads it: what is left out is said in words. */
export function fieldValue(key: SettingKey, fields: Fields): string {
  switch (key) {
    case 'gateEnv': return envText(fields.gateEnv)
    case 'setup': return fields.setup === '' ? 'none' : fields.setup
    case 'setupTimeout': return fields.setupTimeout === '' ? `default (${DEFAULT_SETUP_TIMEOUT})` : fields.setupTimeout
    default: return fields[key]
  }
}

/** One setting that is not the same in two sets of settings. */
export interface FieldChange {
  label: string
  /** As it was; `''` when there was nothing to compare with. */
  was: string
  now: string
}

function sameEnv(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean {
  const names = Object.keys(a)
  return names.length === Object.keys(b).length && names.every(name => Object.hasOwn(b, name) && b[name] === a[name])
}

/**
 * What differs between two sets of settings, in the form's order. Against `null` (a project that wasn't there) it is every
 * setting that is set. The environment is compared without regard to the order of its variables.
 */
export function changedFields(before: Fields | null, after: Fields): FieldChange[] {
  const changes: FieldChange[] = []
  for (const [key, label] of FIELD_LABELS) {
    if (before === null) {
      const set = key === 'gateEnv' ? Object.keys(after.gateEnv).length > 0 : after[key] !== ''
      if (set) changes.push({ label, was: '', now: fieldValue(key, after) })
      continue
    }
    const same = key === 'gateEnv' ? sameEnv(before.gateEnv, after.gateEnv) : before[key] === after[key]
    if (!same) changes.push({ label, was: fieldValue(key, before), now: fieldValue(key, after) })
  }
  return changes
}

// --- questions -----------------------------------------------------------------------------------

/** Where a discard goes, for the question "Discard them and <this>?". */
export function thenText(then: Then): string {
  switch (then.to) {
    case 'select': return `open ${then.name}`
    case 'edit': return `edit ${then.name}`
    case 'add': return 'start a new project'
  }
}
