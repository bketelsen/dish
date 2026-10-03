/**
 * What a ledger line holds: one entry, `{ at, run, kind, by, session?, child?, task?, ...fields }`.
 *
 * - **The harness's kinds** (`HARNESS_KINDS`, `by: 'harness'`) come from orchestrator's own listeners and service calls:
 *   crew's and dish-gates' events, dish-workspaces' hooks, and the tools' own records of what they did. Never from a tool's
 *   arguments.
 * - **The main agent's kinds** (`MAIN_KINDS`, `by: 'main'`) come only through the `run` tool: its rulings, deferred
 *   findings and notes.
 *
 * `entryProblem` is the check for writing (a known kind, written by its own writer), and `lineProblem` the one for reading
 * back (the base fields only: what else an entry holds is for `derive.ts` to check, field by field, when it reads it).
 *
 * @module dish-orchestrator/entries
 */

export const HARNESS_KINDS = ['run.opened', 'run.resumed', 'run.takenOver', 'run.plan', 'run.goal', 'task.opened', 'task.removed',
  'child.started', 'child.ended', 'gate.result', 'review.verdict', 'ladder.refused', 'ladder.ruled', 'pr.checked', 'pr.opened',
  'pr.updated', 'pr.feedback', 'run.closed'] as const
export const MAIN_KINDS = ['ruling', 'deferred', 'note'] as const
export type HarnessKind = typeof HARNESS_KINDS[number]
export type MainKind = typeof MAIN_KINDS[number]
export type Kind = HarnessKind | MainKind

/** The fields every entry may have. The ledger never cuts these to make a line fit. */
export const BASE_FIELDS: readonly string[] = ['at', 'run', 'kind', 'by', 'session', 'child', 'task', 'cut']

interface Base<K extends Kind, B extends 'harness' | 'main'> {
  at: number
  /** The run's id (not its ref: the ledger's file already names the project). */
  run: string
  kind: K
  by: B
  session?: string
  child?: string
  task?: string
  /** Set by the ledger on a line it had to cut to fit. */
  cut?: true
}

/** The header's StructuredReport, as the ledger keeps it (Task 8 checks crew's type against it at compile time). */
export interface LedgerCoderReport {
  role: 'coder', turn: number, at: number, status: 'done' | 'blocked' | 'needs_context', summary: string
  commits?: string[], blockedOn?: string, rulings?: { what: string, why: string, costIfWrong: string }[], concerns?: string[]
  notFixed?: { finding: string, why: string }[]
}
export interface LedgerReviewerReport {
  role: 'reviewer', turn: number, at: number, verdict: 'approved' | 'changes_requested', head: string
  summary: string, findings: { severity: 'blocking' | 'should_fix' | 'nit', file: string, line?: number, summary: string, fix: string }[]
  checks?: { command: string, exitCode: number, summary: string }[], addressed?: { finding: string, addressed: boolean, evidence: string }[]
}
export type LedgerReport = LedgerCoderReport | LedgerReviewerReport

export interface RunOpened extends Base<'run.opened', 'harness'> {
  goal: string, branch: string, worktree: string, base: string, baseCommit: string, plan?: { path: string, commit: string }, how: 'run' | 'auto'
}
export interface RunResumed extends Base<'run.resumed', 'harness'> {
  driver: string
  previous?: string
  /** It was in state `pr`: reopened for review feedback on its pull request. */
  reopened?: true
}
export interface RunTakenOver extends Base<'run.takenOver', 'harness'> { driver: string, previous: string }
export interface RunPlan extends Base<'run.plan', 'harness'> { path: string, commit: string }
export interface RunGoal extends Base<'run.goal', 'harness'> { goal: string }
export interface TaskOpened extends Base<'task.opened', 'harness'> { task: string, path: string, branch: string, base: string, baseCommit: string }
export interface TaskRemoved extends Base<'task.removed', 'harness'> { task: string }
export interface ChildStarted extends Base<'child.started', 'harness'> {
  child: string, role: string, title: string, model: string, family: string, followUp: boolean
  /** Coders with a task. */
  round?: number
  reviews?: string
  final?: true
}
export interface ChildEnded extends Base<'child.ended', 'harness'> {
  child: string, role: string, stopReason: string, error?: string
  /** crew's `RunRecord.report`, the `.md`. */
  reportFile: string
  /** `RunRecord.structuredFile`. */
  structuredFile?: string
  /** `RunRecord.structured`. */
  report?: LedgerReport
  head: string | null
}
export interface GateResultEntry extends Base<'gate.result', 'harness'> {
  child: string, outcome: 'passed' | 'failed' | 'skipped' | 'error', exitCode: number | null, timedOut: boolean, durationMs: number
  log: string | null, head: string | null, gateTurn: number, gateRound: number, reason?: string
}
export interface ReviewVerdict extends Base<'review.verdict', 'harness'> {
  child: string, verdict: 'approved' | 'changes_requested', head: string, final: boolean
  findings: { blocking: number, should_fix: number, nit: number }
}
export interface LadderRefused extends Base<'ladder.refused', 'harness'> { task: string, round: number }
export interface LadderRuled extends Base<'ladder.ruled', 'harness'> { task: string, round: number, ruling: string }
export interface PrGate { outcome: string, exitCode: number | null, timedOut: boolean, durationMs: number, log: string | null, head: string | null, reason?: string }
export interface PrFinal { child: string, verdict: string, head: string, at: number }
export interface PrChecked extends Base<'pr.checked', 'harness'> {
  head: string, gate: PrGate | null, final: PrFinal | null, gateOk: boolean, reviewOk: boolean
  overrides: { gate?: string, review?: string }, result: 'pass' | 'refused', refused?: string[]
}
export interface PrOpened extends Base<'pr.opened', 'harness'> { url: string, number: number, head: string, branch: string }
/** open_pr pushed to a pull request that was already open (openPull's `existing`): its title and body weren't changed. */
export interface PrUpdated extends Base<'pr.updated', 'harness'> {
  url: string, number: number, head: string, branch: string
  titleChanged: boolean, bodyChanged: boolean
  /** open_pr's title or body, through updatePull. */
  updateError?: string
  /** The override lines, posted as a comment (commentPull). */
  comment?: 'posted' | 'failed', commentError?: string
}
/** pr_feedback read a run's pull request. Counts only: never a word of what GitHub said. */
export interface PrFeedback extends Base<'pr.feedback', 'harness'> {
  number: number, state: 'open' | 'closed', merged: boolean, mergeable: boolean | null
  reviews: { approved: number, changesRequested: number, commented: number, other: number }
  reviewComments: number, outdated: number, issueComments: number
  /** null: they couldn't be read. */
  checks: { passed: number, failed: number, pending: number, other: number } | null
}
export interface RunClosed extends Base<'run.closed', 'harness'> { state: 'pr' | 'abandoned', reason?: string, pr?: { url: string, number: number } }
export interface RulingEntry extends Base<'ruling', 'main'> { what: string, why: string, costIfWrong: string }
export interface DeferredEntry extends Base<'deferred', 'main'> { what: string, where: string, why: string }
export interface NoteEntry extends Base<'note', 'main'> { text: string }
export type HarnessEntry = RunOpened | RunResumed | RunTakenOver | RunPlan | RunGoal | TaskOpened | TaskRemoved | ChildStarted | ChildEnded
  | GateResultEntry | ReviewVerdict | LadderRefused | LadderRuled | PrChecked | PrOpened | PrUpdated | PrFeedback | RunClosed
export type MainEntry = RulingEntry | DeferredEntry | NoteEntry
export type LedgerEntry = HarnessEntry | MainEntry

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** What is wrong with `value`'s base fields, or undefined. `kind` is any string here. */
function baseProblem(value: unknown): string | undefined {
  if (!isObject(value)) return 'an entry must be an object'
  if (typeof value.at !== 'number' || !Number.isFinite(value.at)) return 'at must be a finite number'
  if (typeof value.run !== 'string' || value.run === '') return 'run must be a non-empty string (the run\'s id)'
  if (typeof value.kind !== 'string' || value.kind === '') return 'kind must be a non-empty string'
  if (value.by !== 'harness' && value.by !== 'main') return 'by must be harness or main'
  for (const field of ['session', 'child', 'task'] as const) {
    if (value[field] !== undefined && typeof value[field] !== 'string') return `${field} must be a string`
  }
  return undefined
}

/** The fields of a `pr.feedback` past the base ones: a number, a boolean, `null`, `state`, or an object of numbers. Never text. */
function feedbackProblem(value: Record<string, unknown>): string | undefined {
  for (const [field, item] of Object.entries(value)) {
    if (BASE_FIELDS.includes(field)) continue
    if (field === 'state') {
      if (typeof item !== 'string') return 'pr.feedback\'s state must be a string'
      continue
    }
    if (item === null || typeof item === 'number' || typeof item === 'boolean') continue
    if (isObject(item) && Object.values(item).every(count => typeof count === 'number')) continue
    return `pr.feedback holds counts only: ${field} must be a number, a boolean, null, or an object of numbers`
  }
  return undefined
}

/** For writing: base fields, a known kind, and `by` the kind's writer ('harness' for HARNESS_KINDS, 'main' for MAIN_KINDS). */
export function entryProblem(value: unknown): string | undefined {
  const base = baseProblem(value)
  if (base !== undefined) return base
  const entry = value as Record<string, unknown>
  const kind = entry.kind as string
  const writer = (HARNESS_KINDS as readonly string[]).includes(kind) ? 'harness' : (MAIN_KINDS as readonly string[]).includes(kind) ? 'main' : undefined
  if (writer === undefined) return `kind ${JSON.stringify(kind)} is no ledger entry's`
  if (entry.by !== writer) return `by must be ${writer} for ${kind}`
  if (entry.cut !== undefined && entry.cut !== true) return 'cut must be true when given'
  if (kind === 'pr.feedback') return feedbackProblem(entry)
  return undefined
}

/** For reading back: base fields only (any kind string, `by` harness or main); other fields are derive's to check. */
export function lineProblem(value: unknown): string | undefined {
  const base = baseProblem(value)
  if (base !== undefined) return base
  const cut = (value as Record<string, unknown>).cut
  if (cut !== undefined && typeof cut !== 'boolean') return 'cut must be a boolean'
  return undefined
}
