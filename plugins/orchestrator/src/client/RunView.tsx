/**
 * One run: its record, what its ledger says (its tasks, the final review, its pull request, the rulings, the deferred findings
 * and the notes), and its timeline.
 *
 * **Everything here is text.** A goal, a summary, a ruling, a note, a path and a URL were written by an agent or by GitHub.
 * Each is put in as a text child of an element, or as an attribute's value, and in no place as HTML; the one kind of link is
 * `PrLink`'s, through `prHref`. `test/client-rendering.test.ts` renders hostile runs through this file and scans it.
 *
 * A coder the ledger has no end for is said to have "started, no end recorded", never to be running: the ledger can hold a
 * child's end before its follow-up's start, or no end at all after a restart, and this page reads no agent's state.
 *
 * There is no hook here and nothing from dsh: the components are plain functions of their props.
 */

import type { PageState } from './controller.ts'
import type { RulingView, RunDetail, RunSummary, TaskView, VerdictView } from '../protocol.ts'
import { driverText, fullTime, relativeTime, shortSha, verdictLabel } from './format.ts'
import { PrLink, StateTag } from './RunList.tsx'
import { Timeline } from './Timeline.tsx'

export interface RunViewProps {
  detail: RunDetail
  timeline: PageState['timeline']
  now: number
  back(): void
  loadOlder(): void
}

/** "1 thing" or "n things". */
function count(value: number, one: string, many = `${one}s`): string {
  return `${value} ${value === 1 ? one : many}`
}

export function RunView({ detail, timeline, now, back, loadOlder }: RunViewProps) {
  const { summary } = detail
  return (
    <div className="dish-runs-view">
      <div className="dish-runs-actions">
        <button type="button" className="dish-runs-button" onClick={() => { back() }}>Back to the runs</button>
      </div>
      <h3 className="dish-runs-view-title">{detail.goal}</h3>
      <dl className="dish-runs-facts">
        <dt>Project</dt>
        <dd>{detail.project}</dd>
        <dt>Run</dt>
        <dd><code className="dish-runs-code">{detail.id}</code></dd>
        <dt>Goal</dt>
        <dd>{detail.goal}</dd>
        <dt>State</dt>
        <dd><StateTag state={detail.state} /></dd>
        <dt>Pull request</dt>
        <dd>{detail.pr === undefined ? <span className="dish-runs-muted">none</span> : <PrLink pr={detail.pr} showUrl />}</dd>
        {detail.reason !== undefined && (
          <>
            <dt>Reason</dt>
            <dd>{detail.reason}</dd>
          </>
        )}
        <dt>Branch</dt>
        <dd><code className="dish-runs-code">{detail.branch}</code></dd>
        <dt>Worktree</dt>
        <dd><code className="dish-runs-code">{detail.worktree}</code></dd>
        <dt>Base</dt>
        <dd>
          <code className="dish-runs-code">{detail.base}</code> at <code className="dish-runs-code" title={detail.baseCommit}>{shortSha(detail.baseCommit)}</code>
        </dd>
        <dt>Plan</dt>
        <dd>
          {detail.plan === undefined
            ? <span className="dish-runs-muted">none</span>
            : <><code className="dish-runs-code">{detail.plan.path}</code> at <code className="dish-runs-code" title={detail.plan.commit}>{shortSha(detail.plan.commit)}</code></>}
        </dd>
        <dt>Driver</dt>
        <dd title={detail.driver?.session}>{driverText(detail.driver)}</dd>
        <dt>Opened</dt>
        <dd title={fullTime(detail.openedAt)}>{relativeTime(detail.openedAt, now)}</dd>
        {detail.closedAt !== undefined && (
          <>
            <dt>Closed</dt>
            <dd title={fullTime(detail.closedAt)}>{relativeTime(detail.closedAt, now)}</dd>
          </>
        )}
      </dl>

      <h3 className="dish-runs-section-title">Tasks</h3>
      <Tasks tasks={summary.tasks} now={now} />

      <h3 className="dish-runs-section-title">Final review</h3>
      {summary.finalReview === undefined
        ? <p className="dish-runs-muted">None yet.</p>
        : <Verdict verdict={summary.finalReview} now={now} />}

      <h3 className="dish-runs-section-title">Pull request</h3>
      <PullRequest pr={summary.pr} now={now} />

      <h3 className="dish-runs-section-title">Rulings</h3>
      <Rulings rulings={summary.rulings} now={now} />

      <h3 className="dish-runs-section-title">Deferred</h3>
      {summary.deferred.length === 0
        ? <p className="dish-runs-muted">None.</p>
        : (
          <ul className="dish-runs-plain-list">
            {summary.deferred.map((item, index) => (
              <li key={index}>
                <p className="dish-runs-text">{item.what}</p>
                <p className="dish-runs-muted">where: <code className="dish-runs-code">{item.where}</code>; why: {item.why}</p>
              </li>
            ))}
          </ul>
        )}

      <h3 className="dish-runs-section-title">Notes</h3>
      {summary.notes.length === 0
        ? <p className="dish-runs-muted">None.</p>
        : (
          <ul className="dish-runs-plain-list">
            {summary.notes.map((note, index) => (
              <li key={index}>
                <p className="dish-runs-text">{note.text}</p>
                <p className="dish-runs-muted" title={fullTime(note.at)}>{relativeTime(note.at, now)}</p>
              </li>
            ))}
          </ul>
        )}

      <h3 className="dish-runs-section-title">Timeline</h3>
      <Timeline timeline={timeline} now={now} loadOlder={loadOlder} />
    </div>
  )
}

/** Each task: its worktree, its rounds, and its latest coder, gate and verdict. */
function Tasks({ tasks, now }: { tasks: TaskView[], now: number }) {
  if (tasks.length === 0) return <p className="dish-runs-muted">None.</p>
  return (
    <ul className="dish-runs-plain-list">
      {tasks.map(task => (
        <li key={task.task} className="dish-runs-task">
          <div className="dish-runs-task-head">
            <code className="dish-runs-code">{task.task}</code>
            {task.own && <span className="dish-runs-mark">the run's own worktree</span>}
            {task.removed && <span className="dish-runs-mark">removed</span>}
            <span className="dish-runs-muted">{count(task.rounds, 'coder round')}</span>
          </div>
          {task.path !== undefined && <p className="dish-runs-muted"><code className="dish-runs-code">{task.path}</code></p>}
          {task.coder === undefined
            ? <p className="dish-runs-muted">No coder yet.</p>
            : (
              <p className="dish-runs-text">
                coder <code className="dish-runs-code">{task.coder.child}</code>
                {task.coder.ended
                  ? <>: {task.coder.stopReason ?? 'ended'}{task.coder.status !== undefined && <>; {task.coder.status}</>}{task.coder.summary !== undefined && <>: {task.coder.summary}</>}</>
                  : <>: started, no end recorded</>}
                <span className="dish-runs-muted" title={fullTime(task.coder.at)}> ({relativeTime(task.coder.at, now)})</span>
              </p>
            )}
          {task.gate !== undefined && (
            <p className="dish-runs-text">
              gate: {task.gate.outcome}
              {task.gate.exitCode !== null && <>, exit {task.gate.exitCode}</>}
              {task.gate.head !== null && <> at <code className="dish-runs-code" title={task.gate.head}>{shortSha(task.gate.head)}</code></>}
              <span className="dish-runs-muted" title={fullTime(task.gate.at)}> ({relativeTime(task.gate.at, now)})</span>
              {task.gate.log !== null && <> log <code className="dish-runs-code">{task.gate.log}</code></>}
            </p>
          )}
          {task.verdict !== undefined && <Verdict verdict={task.verdict} now={now} />}
        </li>
      ))}
    </ul>
  )
}

/** A reviewer's verdict: what, of which head, by whom, when, and its findings' counts. */
function Verdict({ verdict, now }: { verdict: VerdictView, now: number }) {
  const { blocking, should_fix: shouldFix, nit } = verdict.findings
  return (
    <p className="dish-runs-text">
      {verdict.final ? 'final review' : 'review'}: {verdictLabel(verdict.verdict)}{verdict.head === undefined
        ? ', no head given,'
        : <> of <code className="dish-runs-code" title={verdict.head}>{shortSha(verdict.head)}</code></>} by <code className="dish-runs-code">{verdict.child}</code>
      ; findings: {blocking} blocking, {shouldFix} should fix, {count(nit, 'nit')}
      <span className="dish-runs-muted" title={fullTime(verdict.at)}> ({relativeTime(verdict.at, now)})</span>
    </p>
  )
}

/** The run's pull request, as the ledger last said: its check, its opening or update, and the counts of its last feedback read. */
function PullRequest({ pr, now }: { pr: RunSummary['pr'], now: number }) {
  if (pr === undefined) return <p className="dish-runs-muted">Not opened yet.</p>
  return (
    <div className="dish-runs-stack">
      {pr.checked !== undefined && (
        <p className="dish-runs-text">
          Checked at <code className="dish-runs-code" title={pr.checked.head}>{shortSha(pr.checked.head)}</code>: {pr.checked.result === 'pass' ? 'passed' : 'refused'}
          <span className="dish-runs-muted" title={fullTime(pr.checked.at)}> ({relativeTime(pr.checked.at, now)})</span>
        </p>
      )}
      {pr.opened !== undefined && (
        <p className="dish-runs-text">
          Opened <PrLink pr={pr.opened} showUrl /> at <code className="dish-runs-code" title={pr.opened.head}>{shortSha(pr.opened.head)}</code>
          <span className="dish-runs-muted" title={fullTime(pr.opened.at)}> ({relativeTime(pr.opened.at, now)})</span>
        </p>
      )}
      {pr.updated !== undefined && (
        <p className="dish-runs-text">
          Updated <PrLink pr={pr.updated} showUrl /> at <code className="dish-runs-code" title={pr.updated.head}>{shortSha(pr.updated.head)}</code>
          <span className="dish-runs-muted" title={fullTime(pr.updated.at)}> ({relativeTime(pr.updated.at, now)})</span>
        </p>
      )}
      {pr.feedback !== undefined && (
        <p className="dish-runs-text">
          Last read with pr_feedback (#{pr.feedback.number}): {count(pr.feedback.reviews, 'review')}, {count(pr.feedback.comments, 'comment')},{' '}
          {pr.feedback.failedChecks === null ? 'the checks couldn\'t be read' : count(pr.feedback.failedChecks, 'failed check')}
          <span className="dish-runs-muted" title={fullTime(pr.feedback.at)}> ({relativeTime(pr.feedback.at, now)})</span>
        </p>
      )}
      {pr.feedback !== undefined && <p className="dish-runs-muted">The ledger keeps only the counts of what GitHub said, never its words.</p>}
    </div>
  )
}

const SOURCE: Record<RulingView['source'], string> = { ruling: 'ruling', ladder: 'past round 4', pr: 'at open_pr' }

/** The rulings, oldest first: whose, where from, about which task. */
function Rulings({ rulings, now }: { rulings: RulingView[], now: number }) {
  if (rulings.length === 0) return <p className="dish-runs-muted">None.</p>
  return (
    <ul className="dish-runs-plain-list">
      {rulings.map((ruling, index) => (
        <li key={index}>
          <p className="dish-runs-text">{ruling.text}</p>
          <p className="dish-runs-muted">
            {ruling.by === 'main' ? 'main agent' : 'harness'}, {SOURCE[ruling.source] ?? 'ruling'}
            {ruling.task !== undefined && <>, task <code className="dish-runs-code">{ruling.task}</code></>}
            <span title={fullTime(ruling.at)}> ({relativeTime(ruling.at, now)})</span>
          </p>
        </li>
      ))}
    </ul>
  )
}
