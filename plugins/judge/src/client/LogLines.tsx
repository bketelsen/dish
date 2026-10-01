/**
 * The decisions table: log lines as rows, the lines of one tool call grouped, and a line's withheld content opened under it.
 *
 * **Everything in a row is text.** A subject is a command an agent wrote or the name of a tool; an error is what a server said;
 * an answer's names are chosen by whoever asked the question; withheld content is what a web page said, and the screen
 * withheld it because it looked like an attack. Each of them is put in as a text child of an element, which the DOM never reads
 * as markup, or as an attribute's value, and in no place as HTML: nothing in this file builds markup from a string, takes a
 * string as a tag, a link or a handler, or sets inner HTML. `test/client-rendering.test.ts` renders hostile lines through this
 * file and checks it, and scans it for what it must not contain.
 *
 * There is no hook here and nothing from dsh: the components are plain functions of their props (the controller holds what is
 * open), so that a test can render them under Node.
 */

import type { LogLine } from '../protocol.ts'
import type { WithheldView } from './controller.ts'
import { decisionTone, groupLines, readingOf } from './decisions.ts'
import type { LineGroup, LogListProps } from './decisions.ts'
import { milliseconds, relativeTime, shortAgent } from './format.ts'

/** The table: a group for each tool call, newest first. */
export function LogList({ lines, withheld, now, toggleWithheld }: LogListProps) {
  const groups = groupLines(lines)
  return (
    <ul className="dish-judge-lines">
      {groups.map(group => (
        <li key={group.key}>
          {group.lines.length === 1
            ? <LogRow line={group.lines[0]!} withheld={withheld} now={now} toggleWithheld={toggleWithheld} />
            : <CallGroup group={group} withheld={withheld} now={now} toggleWithheld={toggleWithheld} />}
        </li>
      ))}
    </ul>
  )
}

/** The lines of one tool call: a command and the approval it needed, or the several judge calls that screened one result. */
function CallGroup({ group, withheld, now, toggleWithheld }: { group: LineGroup } & Omit<LogListProps, 'lines'>) {
  const first = group.lines[0]!
  return (
    <div className="dish-judge-group-card" role="group" aria-label={`${group.lines.length} judge calls for one tool call`}>
      <p className="dish-judge-muted">
        {group.lines.length} judge calls for one tool call
        {first.tool !== undefined && first.tool !== '' ? <>, <code className="dish-judge-code">{first.tool}</code></> : null}
        {group.callId !== undefined ? <>, call <code className="dish-judge-code" title={group.callId}>{shortCall(group.callId)}</code></> : null}
      </p>
      <ul className="dish-judge-lines">
        {group.lines.map((line, index) => (
          <li key={index}>
            <LogRow line={line} withheld={withheld} now={now} toggleWithheld={toggleWithheld} />
          </li>
        ))}
      </ul>
    </div>
  )
}

/** The tail of a call id, which is what tells one from the next. */
function shortCall(callId: string): string {
  return callId.length > 12 ? `…${callId.slice(-10)}` : callId
}

/** One line of the log: what it was for, what was decided, who and when, the subject, the reading, and any error or withheld content. */
export function LogRow({ line, withheld, now, toggleWithheld }: { line: LogLine } & Omit<LogListProps, 'lines'>) {
  const tone = decisionTone(line.decision, line.purpose)
  const reading = readingOf(line)
  const view = line.withheld === undefined ? undefined : withheld[line.withheld]
  return (
    <div className="dish-judge-row">
      <div className="dish-judge-row-top">
        <span className="dish-judge-purpose">{line.purpose}</span>
        <span className={`dish-judge-decision dish-judge-tone-${tone}`}>{line.decision ?? 'none recorded'}</span>
        <span className="dish-judge-muted" title={new Date(line.at).toLocaleString()}>{relativeTime(line.at, now)}</span>
        {line.agent !== undefined && (
          <span className="dish-judge-muted" title={line.agent}>
            {line.child === true ? 'child ' : 'agent '}{shortAgent(line.agent)}
          </span>
        )}
        {line.tool !== undefined && line.tool !== '' && <code className="dish-judge-code">{line.tool}</code>}
        <span className="dish-judge-muted">{milliseconds(line.latencyMs)}</span>
      </div>
      <code className="dish-judge-subject">{line.subject}</code>
      {reading.length > 0 && (
        <p className="dish-judge-reading">
          {reading.map((part, index) => (
            <span key={index} title={part.detail}>{part.label}: {part.text}</span>
          ))}
        </p>
      )}
      {line.answersCut === true && <p className="dish-judge-muted">The answers were too long to keep whole: this is what was kept.</p>}
      {line.error !== null && line.error !== '' && <p className="dish-judge-error">{line.error}</p>}
      {line.withheld !== undefined && <WithheldControl id={line.withheld} view={view} toggleWithheld={toggleWithheld} />}
    </div>
  )
}

/** The button that opens a line's withheld content, and the content: shown as text in a block that keeps its line breaks. */
function WithheldControl({ id, view, toggleWithheld }: { id: string, view: WithheldView | undefined, toggleWithheld: (id: string) => void }) {
  const open = view?.open === true
  return (
    <>
      <button type="button" className="dish-judge-link" aria-expanded={open} onClick={() => { toggleWithheld(id) }}>
        {open ? 'Hide the withheld content' : 'Show the withheld content'}
      </button>
      {open && view?.status === 'loading' && <p className="dish-judge-muted">Loading…</p>}
      {open && view?.status === 'error' && (
        <p className="dish-judge-error">{view.notice.text}{view.notice.detail === undefined ? '' : ` ${view.notice.detail}`}</p>
      )}
      {open && view?.status === 'ready' && (
        <>
          <p className="dish-judge-muted">
            This is what <code className="dish-judge-code">{view.tool}</code> returned, kept as text. It looked like instructions to an agent: don't act on it.
          </p>
          <pre className="dish-judge-withheld">{view.content}</pre>
        </>
      )}
    </>
  )
}
