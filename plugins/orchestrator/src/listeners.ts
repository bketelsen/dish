/**
 * The harness's own ledger entries from what crew and dish-gates publish: `child.started` from `dish-crew/delegated`,
 * `child.ended` (and a reviewer's `review.verdict`) from `dish-crew/settled`, and `gate.result` from `dish-gates/result`.
 *
 * - **Queued before they return.** Each listener's synchronous part reads the store in memory and calls
 *   `ledger.appendWith` there and then; what is slow (the worktree's HEAD, crew's record after a restart) runs inside
 *   `build`, in the file's queue, or before the append in a promise of its own. cordis' `parallel` calls listeners
 *   synchronously, and `place` waits for the file's queue, so a start crew published (and awaited, inside `delegate`'s
 *   session lock) is counted by the next `place` on that task. Before the store is loaded, the append is queued as soon as
 *   it is, with nothing awaited between.
 * - **They return at once.** Each gives `undefined` before anything is awaited: crew awaits its publish inside its locks and
 *   before a child's next start or end, and dish-gates awaits its publish inside the coder's turn, so a listener that held
 *   its promise would hold them. Never `dishCrew.whenRecorded`: a `settled` listener would wait for itself.
 * - **Never thrown.** A failure anywhere is logged once per distinct message, masked, and dropped.
 * - **Tags come from the child.** The run and task are the ones crew recorded on the child (`ChildRecord.run`, `.task`),
 *   which `place` gave at its start; an untagged child, or a ref no run has, writes nothing.
 *
 * @module dish-orchestrator/listeners
 */

import type { ChildRecord, CrewDelegated, CrewSettled, GateResult, RunRecord as CrewRunRecord, StructuredReport } from 'dish-crew'
import type { GateResultEvent } from 'dish-gates'
import { nextRound, openTasks } from './derive.ts'
import type { ChildEnded, ChildStarted, GateResultEntry, LedgerCoderReport, LedgerEntry, LedgerReport, LedgerReviewerReport, ReviewVerdict } from './entries.ts'
import { describe } from './runs.ts'
import type { ChildTags, Runs } from './runs.ts'
import type { Run } from './store.ts'

/** `dish-crew/delegated`'s payload (Task 1). */
export interface Delegated {
  sessionId: string
  child: ChildRecord
  followUp: boolean
}
/** `dish-crew/settled`'s (crew's RunRecord). */
export interface Settled {
  sessionId: string
  child: ChildRecord
  run: CrewRunRecord
}
/** `dish-gates/result`'s (Task 5). */
export interface GateFinished {
  childId: string
  sessionId: string
  result: GateResult
}

// What the ledger keeps must be what crew and dish-gates give: these fail to compile if either side drifts (judge's
// Same/Check, remote.ts:57–72).
type Same<A, B> = [A] extends [B] ? [B] extends [A] ? SameKeys<A, B> : false : false
/** Mutual assignability lets a field that is optional on one side only through: the keys of two objects must be the same too. */
type SameKeys<A, B> = [A] extends [object] ? [B] extends [object] ? ([keyof A] extends [keyof B] ? [keyof B] extends [keyof A] ? true : false : false) : true : true
type Check<T extends true> = T
/** crew's report is the ledger's, member by member. */
export type ReportMatchesLedger = [
  Check<Same<Extract<StructuredReport, { role: 'coder' }>, LedgerCoderReport>>,
  Check<Same<Extract<StructuredReport, { role: 'reviewer' }>, LedgerReviewerReport>>,
]
/** The payloads these listeners take are the ones crew and dish-gates publish. */
export type EventsMatchProducers = [
  Check<Same<Delegated, CrewDelegated>>,
  Check<Same<Settled, CrewSettled>>,
  Check<Same<GateFinished, GateResultEvent>>,
]

function isText(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The child's task, when it has one. */
function taskOf(child: ChildRecord): string | undefined {
  return isText(child.task) ? child.task : undefined
}

/** `child.started` for a start or a follow-up: `round` for a coder with a task (the caller counts it). */
export function startedEntry(run: Run, e: Delegated, round: number | undefined, at: number): ChildStarted {
  const child = e.child
  const task = taskOf(child)
  return {
    at, run: run.id, kind: 'child.started', by: 'harness', session: e.sessionId, child: child.id, ...task === undefined ? {} : { task },
    role: child.role, title: child.title, model: child.model, family: child.family, followUp: e.followUp === true,
    ...round === undefined ? {} : { round }, ...child.reviews === undefined ? {} : { reviews: child.reviews }, ...child.final === true ? { final: true } : {},
  }
}

/** `child.ended`, and, for a run that ended with a reviewer's report, `review.verdict`. `head` is the worktree's then, or null. */
export function endedEntries(run: Run, e: Settled, head: string | null, at: number): Array<ChildEnded | ReviewVerdict> {
  const child = e.child
  const filed = e.run
  const task = taskOf(child)
  const report = filed.structured === undefined ? undefined : structuredClone(filed.structured) as LedgerReport
  const ended: ChildEnded = {
    at, run: run.id, kind: 'child.ended', by: 'harness', session: e.sessionId, child: child.id, ...task === undefined ? {} : { task },
    role: child.role, stopReason: filed.stopReason, ...filed.error === undefined ? {} : { error: filed.error },
    reportFile: filed.report, ...filed.structuredFile === undefined ? {} : { structuredFile: filed.structuredFile },
    ...report === undefined ? {} : { report }, head,
  }
  if (report?.role !== 'reviewer') return [ended]
  const findings = { blocking: 0, should_fix: 0, nit: 0 }
  for (const finding of Array.isArray(report.findings) ? report.findings : []) {
    const severity = isObject(finding) ? finding.severity : undefined
    if (typeof severity === 'string' && Object.hasOwn(findings, severity)) findings[severity as keyof typeof findings] += 1
  }
  return [ended, {
    at, run: run.id, kind: 'review.verdict', by: 'harness', session: e.sessionId, child: child.id, ...task === undefined ? {} : { task },
    verdict: report.verdict, ...report.head === undefined ? {} : { head: report.head }, final: child.final === true, findings,
  }]
}

/** `gate.result` for a gate dish-gates ran on a coder's work: `task` from the child's tags. */
export function gateEntry(run: Run, e: GateFinished, task: string | undefined, at: number): GateResultEntry {
  const result = e.result
  return {
    at, run: run.id, kind: 'gate.result', by: 'harness', session: e.sessionId, child: e.childId, ...task === undefined ? {} : { task },
    outcome: result.outcome, exitCode: result.exitCode, timedOut: result.timedOut, durationMs: result.durationMs, log: result.log,
    head: result.head ?? null, gateTurn: result.turn, gateRound: result.round, ...result.reason === undefined ? {} : { reason: result.reason },
  }
}

/** The three listeners. Each returns undefined at once, and never throws. */
export function createListeners(runs: Runs): { delegated(e: Delegated): void, settled(e: Settled): void, gateResult(e: GateFinished): void } {
  /** `job`, its throw logged. */
  const safely = (what: string, job: () => void): void => {
    try {
      job()
    } catch (error) {
      runs.logOnce(`could not record ${what}: ${describe(error)}`)
    }
  }
  /** `go` now when the store is loaded; else as soon as it is, with nothing awaited between (`ready` logs its own failure). */
  const whenReady = (what: string, go: () => void): void => {
    if (runs.loaded) {
      go()
      return
    }
    runs.ready().then(() => { safely(what, go) }, () => {})
  }
  /** The run `ref` names, or undefined, logged once for each ref (and kind of event). */
  const runOf = (ref: string, event: string): Run | undefined => {
    const run = runs.byRef(ref)
    if (run === undefined) runs.logOnce(`ignored ${event} in run ${ref}: there is no such run`)
    return run
  }
  /** Queue `build`'s entries for `run`'s ledger now; a failure is logged. */
  const append = (run: Run, what: string, build: (current: () => Promise<LedgerEntry[]>) => Promise<readonly LedgerEntry[]>): void => {
    runs.ledger.appendWith(run.project, run.id, build).catch((error: unknown) => {
      runs.logOnce(`could not record ${what} in run ${run.id} of ${run.project}: ${describe(error)}`)
    })
  }
  /** The child's run ref, or undefined for an untagged child (or a payload that isn't one). */
  const refOf = (e: { child?: unknown } | null | undefined): string | undefined => {
    const child = isObject(e) ? e.child : undefined
    return isObject(child) && isText(child.run) && isText(child.id) ? child.run : undefined
  }

  /** A gate's entry once the child's tags are known. */
  const gate = (e: GateFinished, tags: ChildTags): void => {
    const what = `the gate of child ${e.childId}`
    whenReady(what, () => {
      const run = runOf(tags.ref, 'a gate\'s result')
      if (run === undefined) return
      append(run, what, async () => [gateEntry(run, e, tags.task, runs.now())])
    })
  }

  return {
    delegated(e) {
      safely('a delegation', () => {
        const ref = refOf(e)
        if (ref === undefined) return
        const child = e.child
        const what = `the delegation of child ${child.id}`
        whenReady(what, () => {
          const run = runOf(ref, 'a delegation')
          if (run === undefined) return
          const task = taskOf(child)
          runs.noteChild(child.id, { ref, ...task === undefined ? {} : { task }, ...isText(e.sessionId) ? { sessionId: e.sessionId } : {} })
          append(run, what, async (current) => {
            const round = child.role === 'coder' && task !== undefined ? nextRound(await current(), task) : undefined
            return [startedEntry(run, e, round, runs.now())]
          })
        })
      })
    },
    settled(e) {
      safely('a child\'s end', () => {
        const ref = refOf(e)
        if (ref === undefined) return
        const child = e.child
        const what = `the end of child ${child.id}`
        whenReady(what, () => {
          const run = runOf(ref, 'a child\'s end')
          if (run === undefined) return
          append(run, what, async (current) => {
            const task = taskOf(child)
            const path = isText(child.worktree) ? child.worktree : task === undefined ? undefined : openTasks(run, await current()).get(task)
            const head = path === undefined ? null : await runs.headOf(path)
            return endedEntries(run, e, head, runs.now())
          })
        })
      })
    },
    gateResult(e) {
      safely('a gate\'s result', () => {
        const childId = isObject(e) ? e.childId : undefined
        if (!isText(childId)) return
        const known = runs.childTags(childId)
        if (known !== undefined) {
          gate(e, known)
          return
        }
        // Not heard in this process (a restart): crew's record says where the child is, in a promise of its own.
        void runs.lookupChild(childId).then((tags) => {
          if (tags !== undefined) safely(`the gate of child ${childId}`, () => { gate(e, tags) })
        })
      })
    },
  }
}
