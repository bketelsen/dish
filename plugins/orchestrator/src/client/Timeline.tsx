/**
 * A run's timeline: its ledger, oldest first and newest last, each entry with its time, who wrote it (the harness or the main
 * agent), what it says (`describeEntry`), its task and child, and whether the ledger had to cut it to fit.
 *
 * **Everything in an entry is text.** A ledger line holds what agents wrote (summaries, findings, rulings, notes), and an
 * unknown kind is shown as its JSON. Each part is put in as a text child of an element, or as an attribute's value, and in no
 * place as HTML: nothing in this file builds markup from a string, or takes a string as a tag, a link or a handler.
 * `test/client-rendering.test.ts` renders hostile lines through this file and scans it.
 *
 * There is no hook here and nothing from dsh: the components are plain functions of their props.
 */

import type { PageState } from './controller.ts'
import { TIMELINE_MAX } from './controller.ts'
import { describeEntry } from './entries.ts'
import { fullTime, relativeTime } from './format.ts'

export interface TimelineProps {
  timeline: PageState['timeline']
  now: number
  loadOlder(): void
}

export function Timeline({ timeline, now, loadOlder }: TimelineProps) {
  const { lines } = timeline
  return (
    <div className="dish-runs-timeline">
      {timeline.next !== undefined && (
        <div className="dish-runs-actions">
          <button type="button" className="dish-runs-button" onClick={() => { loadOlder() }}>
            {timeline.more === 'loading' ? 'Loading older entries…' : 'Load older'}
          </button>
        </div>
      )}
      {timeline.moreError !== undefined && (
        <p className="dish-runs-error" role="alert">
          {timeline.moreError.text}{timeline.moreError.detail === undefined ? '' : ` ${timeline.moreError.detail}`}
        </p>
      )}
      {timeline.capped && (
        <p className="dish-runs-muted">Older entries aren't shown: the page keeps the newest {TIMELINE_MAX.toLocaleString('en-US')}.</p>
      )}
      {timeline.skipped > 0 && (
        <p className="dish-runs-muted">{timeline.skipped} unreadable {timeline.skipped === 1 ? 'line' : 'lines'} skipped</p>
      )}
      {timeline.load === 'loading' && lines.length === 0 && <p className="dish-runs-muted">Loading…</p>}
      {timeline.load === 'error' && timeline.error !== undefined && (
        <p className="dish-runs-error" role="alert">
          {timeline.error.text}{timeline.error.detail === undefined ? '' : ` ${timeline.error.detail}`}
        </p>
      )}
      {timeline.load === 'ready' && lines.length === 0 && <p className="dish-runs-muted">Nothing in the ledger yet.</p>}
      {lines.length > 0 && (
        <ol className="dish-runs-entries">
          {lines.map((line, index) => {
            const { label, text } = describeEntry(line)
            return (
              // Counted from the newest, so a key stays with its line when older ones are put before.
              <li key={lines.length - index} className="dish-runs-entry">
                <div className="dish-runs-entry-head">
                  <span className="dish-runs-muted" title={fullTime(line.at)}>{relativeTime(line.at, now)}</span>
                  <span className={line.by === 'main' ? 'dish-runs-by dish-runs-by-main' : 'dish-runs-by'}>{line.by === 'main' ? 'main agent' : 'harness'}</span>
                  <span className="dish-runs-label">{label}</span>
                  {line.task !== undefined && <span className="dish-runs-muted">task <code className="dish-runs-code">{line.task}</code></span>}
                  {line.child !== undefined && <span className="dish-runs-muted">child <code className="dish-runs-code">{line.child}</code></span>}
                  {line.cut === true && <span className="dish-runs-muted">(cut to fit)</span>}
                </div>
                {text.map((part, at) => <p key={at} className="dish-runs-entry-text">{part}</p>)}
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}
