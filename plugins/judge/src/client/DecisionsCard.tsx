/**
 * The decisions card: the judge's log, newest first, with a filter by purpose and by decision (any text; the known decisions
 * are suggested), a button for older lines, and a line's withheld content on request. The rows are `LogLines.tsx`, which shows
 * everything the log says as text.
 */

import { useEffect, useState } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PurposeName } from '../protocol.ts'
import { LOG_MAX } from './controller.ts'
import type { JudgeActions, PageState } from './controller.ts'
import { KNOWN_DECISIONS, PURPOSES } from './decisions.ts'
import { LogList } from './LogLines.tsx'
import { LoadError, useNow } from './parts.tsx'

type Actions = Omit<JudgeActions, 'hooks'>

/** How long the decision filter waits after the last key before it reads the log: each read goes through a day's file or more. */
const FILTER_DEBOUNCE_MS = 300

/** What the purpose filter offers, in the words the page uses. */
const PURPOSE_LABEL: Record<PurposeName, string> = { command: 'Commands', approval: 'Approvals', screen: 'Screened results', ask: 'ask_judge and tests' }

export function DecisionsCard({ state, actions }: { state: PageState, actions: Actions }) {
  const { decisions } = state
  const now = useNow()
  // The decision text is the person's to type: the table follows it a moment after they stop.
  const [typed, setTyped] = useState(decisions.filter.decision)
  const { setFilter } = actions
  useEffect(() => {
    if (typed === decisions.filter.decision) return
    const timer = setTimeout(() => { void setFilter({ decision: typed }) }, FILTER_DEBOUNCE_MS)
    return () => { clearTimeout(timer) }
  }, [typed, decisions.filter.decision, setFilter])
  const filtered = decisions.filter.purpose !== '' || decisions.filter.decision.trim() !== ''
  return (
    <section className="dish-judge-card" aria-labelledby="dish-judge-decisions-title">
      <div className="dish-judge-card-head">
        <h3 className="dish-judge-card-title" id="dish-judge-decisions-title">Recent decisions</h3>
        <Button variant="ghost" size="sm" disabled={decisions.load === 'loading'} onClick={() => { void actions.refreshDecisions() }}>Refresh</Button>
      </div>
      <p className="dish-judge-muted">
        Every call to the judge, newest first. Commands, results and questions are shown as text, whatever they say.
      </p>
      <div className="dish-judge-filters">
        <label className="dish-judge-field">
          <span className="dish-judge-label">Purpose</span>
          <select
            className="dish-judge-native dish-judge-select"
            value={decisions.filter.purpose}
            onChange={(event) => { void setFilter({ purpose: event.target.value as PurposeName | '' }) }}
          >
            <option value="">All</option>
            {PURPOSES.map(purpose => <option key={purpose} value={purpose}>{PURPOSE_LABEL[purpose]}</option>)}
          </select>
        </label>
        <label className="dish-judge-field">
          <span className="dish-judge-label">Decision</span>
          <Input
            className="dish-judge-input"
            list="dish-judge-decision-list"
            value={typed}
            placeholder="Any, or type one: deny, ask, withhold…"
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => { setTyped(event.target.value) }}
          />
          <datalist id="dish-judge-decision-list">
            {KNOWN_DECISIONS.map(decision => <option key={decision} value={decision} />)}
          </datalist>
        </label>
      </div>
      {decisions.load === 'loading' && decisions.lines.length === 0 && <p className="dish-judge-muted">Loading…</p>}
      {decisions.load === 'error' && decisions.error !== undefined && <LoadError notice={decisions.error} retry={() => { void actions.refreshDecisions() }} />}
      {decisions.load === 'ready' && decisions.lines.length === 0 && (
        <p className="dish-judge-muted">{filtered ? 'No lines match this filter.' : 'Nothing has been decided yet.'}</p>
      )}
      {decisions.lines.length > 0 && (
        <LogList lines={decisions.lines} withheld={decisions.withheld} now={now} toggleWithheld={(id) => { void actions.toggleWithheld(id) }} />
      )}
      {decisions.moreError !== undefined && <LoadError notice={decisions.moreError} retry={() => { void actions.loadMore() }} />}
      {decisions.next !== undefined && decisions.more !== 'error' && (
        <div className="dish-judge-actions">
          <Button variant="outline" size="sm" disabled={decisions.more === 'loading'} onClick={() => { void actions.loadMore() }}>
            {decisions.more === 'loading' ? 'Loading…' : 'Show older'}
          </Button>
        </div>
      )}
      {decisions.capped && (
        <p className="dish-judge-muted">Showing the newest {LOG_MAX} lines. Filter by purpose or decision to reach older ones.</p>
      )}
      {decisions.skipped > 0 && (
        <p className="dish-judge-muted">{decisions.skipped} {decisions.skipped === 1 ? 'line' : 'lines'} of the log couldn't be read and {decisions.skipped === 1 ? 'was' : 'were'} skipped.</p>
      )}
    </section>
  )
}
