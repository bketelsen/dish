/**
 * The wire shapes shared by the server remote (`remote.ts`) and the Settings → Runs page (`client/`). Types and one constant,
 * so both halves can import it, and it imports nothing: the browser build must not reach into the store, the ledger or
 * Node's modules. The summary's shapes are `derive.ts`' own, copied field for field; `remote.ts` checks at compile time that
 * the two are the same, so a change to either side is a type error.
 *
 * Everything here is plain JSON, and in the parameters of a call an empty string and `0` stand for "absent" (see
 * `remote.ts`).
 *
 * **The page is read-only.** No call takes anything but a project, a run's id and a page of its ledger: nothing the page
 * sends can change a run.
 * @module dish-orchestrator/protocol
 */

/** The remote's wire namespace: the page calls `ctx.remote.dishRuns`. (Its Cordis service key is `dishRunsRemote`.) */
export const NAMESPACE = 'dishRuns'

/** The failures a call reports as a result: a project or id that isn't one (or a page cursor that isn't), and a run that isn't there. */
export type ErrorCode = 'INVALID' | 'NOT_FOUND'

/** What `run` and `ledger` return. A refusal is a result, not an error: Typert's own failure codes can't carry these. */
export type Outcome<T> =
  | { ok: true, value: T }
  | { ok: false, code: ErrorCode, message: string }

/** One JSON value. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/** Who drives a run, and whether that chat's agent is there now. */
export interface DriverInfo {
  /** The main agent's id: crew's session id. */
  session: string
  /** Since when, in milliseconds since the epoch. */
  since: number
  /** dsh's agent registry has an agent with that id. */
  live: boolean
}

/** A run as the list shows it. */
export interface RunRow {
  /** `owner/repo`. */
  project: string
  id: string
  slug: string
  goal: string
  state: 'open' | 'pr' | 'abandoned'
  /** `null`: released, nobody drives it. */
  driver: DriverInfo | null
  openedAt: number
  /** Absent while open. */
  closedAt?: number
  /** A run reopened for review feedback is open and keeps its PR. */
  pr?: { url: string, number: number }
  /** Why it was abandoned. */
  reason?: string
}

/** A gate's result for a task (derive's `GateView`). */
export interface GateView { child: string, outcome: string, exitCode: number | null, head: string | null, at: number, log: string | null }

/** A reviewer's verdict (derive's `VerdictView`). */
export interface VerdictView {
  /** `head`: absent when the reviewer gave none (a review of work outside git). */
  child: string, verdict: 'approved' | 'changes_requested', head?: string, final: boolean, at: number
  findings: { blocking: number, should_fix: number, nit: number }
}

/** One task of a run: a worktree of it (derive's `TaskView`). */
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

/** A ruling, the main agent's or the harness's (derive's `RulingView`). */
export interface RulingView { at: number, by: 'harness' | 'main', source: 'ruling' | 'ladder' | 'pr', text: string, task?: string }

/** What a run's ledger says (derive's `RunSummary`). */
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

/** A run as its own view shows it: the row, the rest of its record, and what its ledger says. */
export interface RunDetail extends RunRow {
  /** `dish/<slug>`. */
  branch: string
  worktree: string
  /** The ref it was cut from. */
  base: string
  baseCommit: string
  plan?: { path: string, commit: string }
  summary: RunSummary
}

/**
 * One ledger line: its base fields, and everything else in `fields`. Every string in it is text to show, and nothing more: a
 * goal, a summary, a finding or a ruling was written by an agent, and a URL by GitHub.
 */
export interface LedgerLine {
  at: number
  /** The run's id. */
  run: string
  kind: string
  by: 'harness' | 'main'
  session?: string
  child?: string
  task?: string
  /** The ledger cut the line to fit. */
  cut?: boolean
  /** Everything else in the entry. */
  fields: { [key: string]: JsonValue }
}

/** A page of a run's ledger. */
export interface LedgerPage {
  /** Newest first. */
  lines: LedgerLine[]
  /** What to pass as `before` for the next (older) page: there only when an older line exists. */
  next?: string
  /** How many unreadable lines the page went through. */
  skipped: number
}
