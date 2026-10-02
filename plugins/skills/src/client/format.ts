/**
 * The page's wording for roles, what a skill is offered to, authors, times and commit ids. Plain TypeScript with no DOM or
 * React in it, so `node --test` can load it. The author, time and id helpers are the History page's own
 * (`dish-config/src/client/format.ts`), kept in step by hand: dish-config's client has no source export to import them from.
 * @module dish-skills/client/format
 */

import type { Author, CheckSummary, SkillInfo } from '../protocol.ts'

/** A role as the page's chips say it: the name with a capital (`Main`, `Front-end`). */
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

/** What a row of the list says a skill is offered to. */
export type Offer =
  | { kind: 'problem', problem: string }
  | { kind: 'all' }
  | { kind: 'off' }
  | { kind: 'roles', roles: string[] }

/**
 * What the list shows beside a skill's name, in place of nothing: the problem when its document doesn't parse (it is
 * offered to nobody then); "off" when it names no role, or when neither a model nor the `/` menu can use it; "all roles"
 * when it names none; else its roles.
 */
export function offerOf(skill: Pick<SkillInfo, 'problem' | 'roles' | 'modelInvocable' | 'userInvocable'>): Offer {
  if (skill.problem !== '') return { kind: 'problem', problem: skill.problem }
  if (skill.roles !== null && skill.roles.length === 0) return { kind: 'off' }
  if (!skill.modelInvocable && !skill.userInvocable) return { kind: 'off' }
  return skill.roles === null ? { kind: 'all' } : { kind: 'roles', roles: skill.roles }
}

/** The roles a skill is offered, as a phrase: `all roles`, `no roles` or the names. */
export function rolesText(roles: readonly string[] | null): string {
  if (roles === null) return 'all roles'
  return roles.length === 0 ? 'no roles' : roles.join(', ')
}

/** Who may load a skill, in the words of the frontmatter's keys. */
export function invocableText(modelInvocable: boolean, userInvocable: boolean): string {
  if (modelInvocable && userInvocable) return 'model- and user-invocable'
  if (modelInvocable) return 'model-invocable only'
  if (userInvocable) return 'user-invocable only'
  return 'not invocable'
}

/** `1234567` as `1,234,567`, whatever the locale: the page's numbers read the same everywhere. */
export function groupDigits(count: number): string {
  return String(count).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

const characters = (count: number): string => `${groupDigits(count)} ${count === 1 ? 'character' : 'characters'}`

/** The line under the editor for a document that is valid: description length, roles, invocation and size. */
export function summaryText(summary: CheckSummary): string {
  return [
    `description ${characters(summary.description.length)}`,
    `roles: ${rolesText(summary.roles)}`,
    invocableText(summary.modelInvocable, summary.userInvocable),
    characters(summary.chars),
  ].join(' · ')
}

/** A skill as the narrow page's `<select>` says it: its name, then the marks the list would show beside it. */
export function optionText(skill: SkillInfo): string {
  const offer = offerOf(skill)
  const marks: string[] = []
  switch (offer.kind) {
    case 'problem': marks.push('problem'); break
    case 'all': marks.push('all roles'); break
    case 'off': marks.push('off'); break
    case 'roles': marks.push(offer.roles.join(', ')); break
  }
  if (!skill.shipped) marks.push('yours')
  if (skill.differsFromDefault) marks.push('edited')
  if (skill.missing) marks.push('not in the store')
  if (skill.pendingProposals > 0) marks.push(`${skill.pendingProposals} waiting`)
  return `${skill.name} (${marks.join(', ')})`
}
