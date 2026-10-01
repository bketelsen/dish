/**
 * The status card: whether the judge is reachable, the last error, the latencies and counts of its last 100 calls, and a Test
 * button that asks it one fixed question and shows the answer and how long it took.
 */

import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import type { StatusInfo } from '../protocol.ts'
import type { JudgeActions, PageState } from './controller.ts'
import { milliseconds, probability, relativeTime } from './format.ts'
import { LoadError, useNow } from './parts.tsx'

type Actions = Omit<JudgeActions, 'hooks'>

const STATE: Record<StatusInfo['state'], { tone: TagTone, label: string, hint: string }> = {
  ok: { tone: 'success', label: 'Reachable', hint: 'The judge answered its last call, or has not been asked yet.' },
  unavailable: { tone: 'warning', label: 'Unavailable', hint: 'The gate asks you about commands, children are refused, and web results are passed on marked "not screened".' },
  'no-key': { tone: 'neutral', label: 'No key', hint: 'Set a TypeSafe key above. Until then the judge is unavailable.' },
}

export function StatusCard({ state, actions }: { state: PageState, actions: Actions }) {
  const { status, test } = state
  const now = useNow()
  const value = status.value
  const shown = value === undefined ? undefined : STATE[value.state]
  return (
    <section className="dish-judge-card" aria-labelledby="dish-judge-status-title">
      <div className="dish-judge-card-head">
        <h3 className="dish-judge-card-title" id="dish-judge-status-title">
          Status
          {shown !== undefined && <Tag tone={shown.tone}>{shown.label}</Tag>}
        </h3>
        <div className="dish-judge-actions">
          <Button variant="ghost" size="sm" disabled={status.load === 'loading'} onClick={() => { void actions.refreshStatus() }}>Refresh</Button>
          <Button variant="outline" size="sm" disabled={test.phase === 'running'} onClick={() => { void actions.runTest() }}>
            {test.phase === 'running' ? 'Testing…' : 'Test'}
          </Button>
        </div>
      </div>
      {status.load === 'loading' && value === undefined && <p className="dish-judge-muted">Loading…</p>}
      {status.error !== undefined && <LoadError notice={status.error} retry={() => { void actions.refreshStatus() }} />}
      {value !== undefined && shown !== undefined && (
        <>
          <p className="dish-judge-muted">{shown.hint}</p>
          <dl className="dish-judge-facts">
            <dt>Latency</dt>
            <dd>
              {value.p50 === null && value.p95 === null
                ? 'no answers yet'
                : `p50 ${milliseconds(value.p50)}, p95 ${milliseconds(value.p95)}`}
            </dd>
            <dt>Last 100 calls</dt>
            <dd>{value.calls} {value.calls === 1 ? 'call' : 'calls'}, {value.failures} failed</dd>
            <dt>Last answered</dt>
            <dd>{value.lastOkAt === undefined ? 'never, since dsh started' : relativeTime(value.lastOkAt, now)}</dd>
            {value.lastError !== undefined && (
              <>
                <dt>Last error</dt>
                <dd>
                  {value.lastError}
                  {value.lastErrorAt !== undefined && <span className="dish-judge-muted"> ({relativeTime(value.lastErrorAt, now)})</span>}
                </dd>
              </>
            )}
          </dl>
        </>
      )}
      {test.phase === 'done' && (
        <div className="dish-judge-test" role="status">
          <span>
            Is "The sky is blue." a statement about the weather or sky? The judge says{' '}
            <strong>{test.result.answer.noul >= 0.5 ? 'yes' : 'no'}</strong> (P(yes) {probability(test.result.answer.noul)}) in {milliseconds(test.result.latencyMs)}.
          </span>
          <span className="dish-judge-muted">The expected answer is yes.</span>
        </div>
      )}
      {test.phase === 'failed' && (
        <div className="dish-judge-test dish-judge-notice-error" role="alert">
          <span>{test.notice.text}</span>
          {test.notice.detail !== undefined && <span className="dish-judge-muted">{test.notice.detail}</span>}
        </div>
      )}
    </section>
  )
}
