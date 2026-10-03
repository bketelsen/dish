/**
 * The list of runs, grouped by project, and the small pieces a run's view shares with it: a run's state tag and its pull
 * request.
 *
 * **Everything in a row is text.** A goal was written by the main agent, a pull request's URL came back from GitHub, and a
 * session id from dsh. Each is put in as a text child of an element, which the DOM never reads as markup, or as an
 * attribute's value, and in no place as HTML: nothing in this file builds markup from a string or takes a string as a tag or a
 * handler, and the one link it makes goes through `prHref`, which takes nothing but a GitHub pull request's own page.
 * `test/client-rendering.test.ts` renders hostile rows through this file and checks it, and scans it for what it must not
 * contain.
 *
 * There is no hook here and nothing from dsh: the components are plain functions of their props, so that a test can render
 * them under Node.
 */

import type { RunRow } from '../protocol.ts'
import { driverText, fullTime, prHref, relativeTime, stateLabel } from './format.ts'

export interface RunListProps {
  /** In the order the remote gives them: by project, open first, newest first. */
  rows: RunRow[]
  now: number
  select(project: string, id: string): void
}

/** The rows of one project, in the order given. */
interface Group {
  project: string
  rows: RunRow[]
}

/** Consecutive rows of one project, together. */
function groupByProject(rows: RunRow[]): Group[] {
  const groups: Group[] = []
  for (const row of rows) {
    const last = groups.at(-1)
    if (last !== undefined && last.project === row.project) last.rows.push(row)
    else groups.push({ project: row.project, rows: [row] })
  }
  return groups
}

/** The runs, by project. Each row is a button that opens the run. */
export function RunList({ rows, now, select }: RunListProps) {
  if (rows.length === 0) {
    return (
      <p className="dish-runs-muted">
        No runs yet. A run starts when the main agent calls <code className="dish-runs-code">run</code> <code className="dish-runs-code">open</code>, or makes a worktree.
      </p>
    )
  }
  return (
    <div className="dish-runs-groups">
      {groupByProject(rows).map((group, index) => (
        <div key={`${index} ${group.project}`} className="dish-runs-group" role="group" aria-label={group.project}>
          <h3 className="dish-runs-group-title">{group.project}</h3>
          <ul className="dish-runs-list">
            {group.rows.map(row => (
              <li key={row.id} className="dish-runs-item">
                <RunRowView row={row} now={now} select={select} />
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}

/** One run: what it is for, its id, its state, who drives it, when, and its pull request beside the button. */
function RunRowView({ row, now, select }: { row: RunRow, now: number, select(project: string, id: string): void }) {
  return (
    <div className="dish-runs-row">
      <button type="button" className="dish-runs-row-button" onClick={() => { select(row.project, row.id) }}>
        <span className="dish-runs-goal">{row.goal}</span>
        <span className="dish-runs-meta">
          <code className="dish-runs-code">{row.id}</code>
          <StateTag state={row.state} />
          <span className="dish-runs-muted" title={row.driver?.session}>{driverText(row.driver)}</span>
          <span className="dish-runs-muted" title={fullTime(row.openedAt)}>opened {relativeTime(row.openedAt, now)}</span>
          {row.closedAt !== undefined && <span className="dish-runs-muted" title={fullTime(row.closedAt)}>closed {relativeTime(row.closedAt, now)}</span>}
        </span>
      </button>
      {row.pr !== undefined && (
        <span className="dish-runs-row-pr">
          <PrLink pr={row.pr} />
        </span>
      )}
    </div>
  )
}

/** A run's state: open, PR or abandoned. The class is chosen from those three, never taken from the string. */
export function StateTag({ state }: { state: string }) {
  const tone = state === 'open' ? 'open' : state === 'pr' ? 'pr' : state === 'abandoned' ? 'abandoned' : 'other'
  return <span className={`dish-runs-tag dish-runs-tag-${tone}`}>{stateLabel(state)}</span>
}

/**
 * A pull request: a link to it when its URL is exactly a GitHub pull request's page (`prHref`), else its number as text. With
 * `showUrl`, a URL that isn't one is shown too, as text, so the person sees what was recorded.
 */
export function PrLink({ pr, showUrl = false }: { pr: { url: string, number: number }, showUrl?: boolean }) {
  const link = prHref(pr.url)
  if (link === undefined) {
    return (
      <span className="dish-runs-pr-text">
        #{pr.number}
        {showUrl && <> <code className="dish-runs-code">{pr.url}</code></>}
      </span>
    )
  }
  return <a className="dish-runs-pr" href={link} rel="noopener noreferrer" target="_blank">#{pr.number}</a>
}
