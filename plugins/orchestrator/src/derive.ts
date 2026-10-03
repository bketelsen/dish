/**
 * What a run's ledger says: its tasks and their rounds, the latest gate and verdict of each, the final review, the rulings,
 * the deferred findings, the notes, and its pull request. Everything here is a pure function of a run and its entries.
 *
 * - **Read with a type check.** The ledger checks only an entry's base fields when it reads it back (`lineProblem`), so
 *   every field past those is checked here, where it is read. An entry whose fields don't fit is passed over by the
 *   derivation that reads them, and nothing here throws on what a file holds.
 * - **Each kind from its own writer.** A harness kind counts only with `by: 'harness'`, and the main agent's kinds only
 *   with `by: 'main'`. The ledger never writes it otherwise (`entryProblem`), so a line that says so wasn't written by it.
 *
 * @module dish-orchestrator/derive
 */

import { HARNESS_KINDS, MAIN_KINDS } from './entries.ts'
import type { LedgerEntry } from './entries.ts'
import type { Run } from './store.ts'

export interface GateView { child: string, outcome: string, exitCode: number | null, head: string | null, at: number, log: string | null }
export interface VerdictView {
  /** `head`: absent when the reviewer gave none (a review of work outside git); `sameHead` then matches nothing. */
  child: string, verdict: 'approved' | 'changes_requested', head?: string, final: boolean, at: number
  findings: { blocking: number, should_fix: number, nit: number }
}
export interface TaskView {
  /** Its slug. */
  task: string
  /** The run's own worktree. */
  own: boolean
  path?: string
  removed: boolean
  /** Coder starts and follow-ups on it so far: the index the next one gets. */
  rounds: number
  coder?: { child: string, at: number, ended: boolean, stopReason?: string, status?: 'done' | 'blocked' | 'needs_context', summary?: string }
  /** Its latest. */
  gate?: GateView
  /** Its latest. */
  verdict?: VerdictView
}
export interface RulingView { at: number, by: 'harness' | 'main', source: 'ruling' | 'ladder' | 'pr', text: string, task?: string }
export interface RunSummary {
  /** The run's own first, then by task.opened. */
  tasks: TaskView[]
  /** The latest review.verdict with final. */
  finalReview?: VerdictView
  /** Oldest first. */
  rulings: RulingView[]
  deferred: Array<{ at: number, what: string, where: string, why: string }>
  notes: Array<{ at: number, text: string }>
  /** Each the newest of its kind. */
  pr?: {
    checked?: { at: number, head: string, result: 'pass' | 'refused' }
    opened?: { at: number, url: string, number: number, head: string }
    updated?: { at: number, url: string, number: number, head: string }
    feedback?: { at: number, number: number, reviews: number, comments: number, failedChecks: number | null }
  }
}

/** An entry as read back: its fields are unknown until checked. */
type Fields = Record<string, unknown>

const HARNESS: readonly string[] = HARNESS_KINDS
const MAIN: readonly string[] = MAIN_KINDS
const STATUSES: readonly string[] = ['done', 'blocked', 'needs_context']
const VERDICTS: readonly string[] = ['approved', 'changes_requested']
/** A full commit id: sha-1's 40 hex digits, or sha-256's 64. */
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i

function isObject(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isCount(value: unknown): value is number {
  return isNumber(value) && value >= 0
}

/** `entry` as fields, when it is of `kind` and was written by that kind's writer. */
function as(entry: unknown, kind: string): Fields | undefined {
  if (!isObject(entry) || entry.kind !== kind || !isNumber(entry.at)) return undefined
  const writer = HARNESS.includes(kind) ? 'harness' : MAIN.includes(kind) ? 'main' : undefined
  return entry.by === writer ? entry : undefined
}

/** The entries of `kind`, oldest first. */
function ofKind(entries: readonly LedgerEntry[], kind: string): Fields[] {
  const found: Fields[] = []
  for (const entry of entries) {
    const fields = as(entry, kind)
    if (fields !== undefined) found.push(fields)
  }
  return found
}

/** The newest of `list` that `view` makes something of. */
function newest<T>(list: readonly Fields[], view: (fields: Fields) => T | undefined): T | undefined {
  for (let index = list.length - 1; index >= 0; index--) {
    const made = view(list[index]!)
    if (made !== undefined) return made
  }
  return undefined
}

function isCoderStart(fields: Fields, task: string): boolean {
  return fields.task === task && fields.role === 'coder' && isString(fields.child)
}

/** The index the next coder start or follow-up on `task` gets: how many `child.started` with role coder and that task there are. */
export function nextRound(entries: readonly LedgerEntry[], task: string): number {
  return ofKind(entries, 'child.started').filter(fields => isCoderStart(fields, task)).length
}

/** The task of `child` in this ledger: its newest child.started's. */
export function taskOfChild(entries: readonly LedgerEntry[], child: string): string | undefined {
  const start = newest(ofKind(entries, 'child.started'), fields => fields.child === child ? fields : undefined)
  return start !== undefined && isString(start.task) ? start.task : undefined
}

/** The tasks not removed, slug → path: the run's own worktree (run.slug → run.worktree), then each task.opened without a later task.removed. */
export function openTasks(run: Run, entries: readonly LedgerEntry[]): Map<string, string> {
  const open = new Map<string, string>([[run.slug, run.worktree]])
  for (const entry of entries) {
    const opened = as(entry, 'task.opened')
    if (opened !== undefined && isString(opened.task) && isString(opened.path)) {
      open.set(opened.task, opened.path)
      continue
    }
    const removed = as(entry, 'task.removed')
    if (removed !== undefined && isString(removed.task)) open.delete(removed.task)
  }
  return open
}

function verdictView(fields: Fields): VerdictView | undefined {
  const findings = fields.findings
  if (!isString(fields.child) || !isString(fields.verdict) || !VERDICTS.includes(fields.verdict)) return undefined
  if (fields.head !== undefined && !isString(fields.head)) return undefined
  if (typeof fields.final !== 'boolean' || !isObject(findings)) return undefined
  if (!isCount(findings.blocking) || !isCount(findings.should_fix) || !isCount(findings.nit)) return undefined
  return {
    child: fields.child, verdict: fields.verdict as VerdictView['verdict'], ...fields.head === undefined ? {} : { head: fields.head },
    final: fields.final, at: fields.at as number, findings: { blocking: findings.blocking, should_fix: findings.should_fix, nit: findings.nit },
  }
}

function gateView(fields: Fields): GateView | undefined {
  if (!isString(fields.child) || !isString(fields.outcome)) return undefined
  if (fields.exitCode !== null && !isNumber(fields.exitCode)) return undefined
  if (fields.head !== null && !isString(fields.head)) return undefined
  if (fields.log !== null && !isString(fields.log)) return undefined
  return { child: fields.child, outcome: fields.outcome, exitCode: fields.exitCode, head: fields.head, at: fields.at as number, log: fields.log }
}

/**
 * The newest final verdict, with a head or without one: a final review without a head is the latest all the same, so an
 * older approval doesn't count past it, and it approves no head (`sameHead` never matches a missing one).
 */
export function latestFinal(entries: readonly LedgerEntry[]): VerdictView | undefined {
  return newest(ofKind(entries, 'review.verdict'), fields => {
    const view = verdictView(fields)
    return view?.final === true ? view : undefined
  })
}

/** The newest gate.result whose head is `head` (sameHead). */
export function gateAt(entries: readonly LedgerEntry[], head: string): GateView | undefined {
  return newest(ofKind(entries, 'gate.result'), fields => {
    const view = gateView(fields)
    return view !== undefined && sameHead(view.head, head) ? view : undefined
  })
}

/**
 * Both full shas (40 or 64 hex digits), equal without case. Never a prefix (correction 6): an abbreviated sha could match
 * another commit. A missing head (a review of work outside git) matches nothing.
 */
export function sameHead(a: unknown, b: unknown): boolean {
  if (!isString(a) || !isString(b) || !FULL_SHA.test(a) || !FULL_SHA.test(b)) return false
  return a.toLowerCase() === b.toLowerCase()
}

/** The coder of `task`: its newest coder start, and the end of that child that came after it, if any. */
function coderOf(entries: readonly LedgerEntry[], task: string): TaskView['coder'] {
  let start = -1
  for (let index = entries.length - 1; index >= 0; index--) {
    const fields = as(entries[index], 'child.started')
    if (fields !== undefined && isCoderStart(fields, task)) {
      start = index
      break
    }
  }
  if (start === -1) return undefined
  const started = entries[start] as unknown as Fields
  const child = started.child as string
  const coder: NonNullable<TaskView['coder']> = { child, at: started.at as number, ended: false }
  for (let index = entries.length - 1; index > start; index--) {
    const ended = as(entries[index], 'child.ended')
    if (ended === undefined || ended.child !== child || !isString(ended.stopReason)) continue
    coder.ended = true
    coder.stopReason = ended.stopReason
    const report = ended.report
    if (isObject(report) && report.role === 'coder' && isString(report.status) && STATUSES.includes(report.status) && isString(report.summary)) {
      coder.status = report.status as NonNullable<TaskView['coder']>['status']
      coder.summary = report.summary
    }
    break
  }
  return coder
}

/** Every task the run has had: its own, then each slug a task.opened named, in the order first opened; and the path last given. */
function everyTask(run: Run, entries: readonly LedgerEntry[]): Map<string, string> {
  const tasks = new Map<string, string>([[run.slug, run.worktree]])
  for (const entry of entries) {
    const opened = as(entry, 'task.opened')
    if (opened !== undefined && isString(opened.task) && isString(opened.path)) tasks.set(opened.task, opened.path)
  }
  return tasks
}

function rulingsOf(entries: readonly LedgerEntry[]): RulingView[] {
  const rulings: RulingView[] = []
  const withTask = (view: RulingView, task: unknown): RulingView => isString(task) ? { ...view, task } : view
  for (const entry of entries) {
    const main = as(entry, 'ruling')
    if (main !== undefined) {
      if (isString(main.what) && isString(main.why) && isString(main.costIfWrong)) {
        rulings.push(withTask({ at: main.at as number, by: 'main', source: 'ruling', text: `${main.what} — ${main.why} — ${main.costIfWrong}` }, main.task))
      }
      continue
    }
    const ladder = as(entry, 'ladder.ruled')
    if (ladder !== undefined) {
      if (isString(ladder.ruling)) rulings.push(withTask({ at: ladder.at as number, by: 'harness', source: 'ladder', text: ladder.ruling }, ladder.task))
      continue
    }
    const checked = as(entry, 'pr.checked')
    if (checked !== undefined && isObject(checked.overrides)) {
      for (const which of ['gate', 'review'] as const) {
        const ruling = checked.overrides[which]
        if (isString(ruling)) rulings.push({ at: checked.at as number, by: 'harness', source: 'pr', text: `${which}: ${ruling}` })
      }
    }
  }
  return rulings
}

function prOf(entries: readonly LedgerEntry[]): RunSummary['pr'] {
  const pr: NonNullable<RunSummary['pr']> = {}
  const checked = newest(ofKind(entries, 'pr.checked'), fields =>
    isString(fields.head) && (fields.result === 'pass' || fields.result === 'refused')
      ? { at: fields.at as number, head: fields.head, result: fields.result as 'pass' | 'refused' }
      : undefined)
  const pull = (fields: Fields): { at: number, url: string, number: number, head: string } | undefined =>
    isString(fields.url) && isNumber(fields.number) && isString(fields.head)
      ? { at: fields.at as number, url: fields.url, number: fields.number, head: fields.head }
      : undefined
  const opened = newest(ofKind(entries, 'pr.opened'), pull)
  const updated = newest(ofKind(entries, 'pr.updated'), pull)
  const feedback = newest(ofKind(entries, 'pr.feedback'), fields => {
    const reviews = fields.reviews
    const checks = fields.checks
    if (!isNumber(fields.number) || !isObject(reviews) || !isCount(fields.reviewComments) || !isCount(fields.issueComments)) return undefined
    const counts = [reviews.approved, reviews.changesRequested, reviews.commented, reviews.other]
    if (!counts.every(isCount)) return undefined
    if (checks !== null && !(isObject(checks) && isCount(checks.failed))) return undefined
    return {
      at: fields.at as number,
      number: fields.number,
      reviews: (counts as number[]).reduce((sum, count) => sum + count, 0),
      comments: fields.reviewComments + fields.issueComments,
      failedChecks: checks === null ? null : checks.failed as number,
    }
  })
  if (checked !== undefined) pr.checked = checked
  if (opened !== undefined) pr.opened = opened
  if (updated !== undefined) pr.updated = updated
  if (feedback !== undefined) pr.feedback = feedback
  return Object.keys(pr).length === 0 ? undefined : pr
}

export function summarize(run: Run, entries: readonly LedgerEntry[]): RunSummary {
  const open = openTasks(run, entries)
  const gates = ofKind(entries, 'gate.result')
  const verdicts = ofKind(entries, 'review.verdict')
  const tasks: TaskView[] = []
  for (const [task, path] of everyTask(run, entries)) {
    const view: TaskView = { task, own: task === run.slug, path: open.get(task) ?? path, removed: !open.has(task), rounds: nextRound(entries, task) }
    const coder = coderOf(entries, task)
    if (coder !== undefined) view.coder = coder
    const gate = newest(gates, fields => fields.task === task ? gateView(fields) : undefined)
    if (gate !== undefined) view.gate = gate
    const verdict = newest(verdicts, fields => fields.task === task ? verdictView(fields) : undefined)
    if (verdict !== undefined) view.verdict = verdict
    tasks.push(view)
  }
  const summary: RunSummary = {
    tasks,
    rulings: rulingsOf(entries),
    deferred: ofKind(entries, 'deferred').flatMap(fields =>
      isString(fields.what) && isString(fields.where) && isString(fields.why)
        ? [{ at: fields.at as number, what: fields.what, where: fields.where, why: fields.why }]
        : []),
    notes: ofKind(entries, 'note').flatMap(fields => isString(fields.text) ? [{ at: fields.at as number, text: fields.text }] : []),
  }
  const finalReview = latestFinal(entries)
  if (finalReview !== undefined) summary.finalReview = finalReview
  const pr = prOf(entries)
  if (pr !== undefined) summary.pr = pr
  return summary
}
