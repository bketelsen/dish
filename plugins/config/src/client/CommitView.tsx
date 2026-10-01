/** One commit: who made it, why, and each file's diff, with **Revert this commit** behind a confirm step. */

import { useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { DiffView } from 'dish-kit/ui'
import type { DetailState, HistoryActions } from './controller.ts'
import { authorLabel, relativeTime, shortId, subjectOf } from './format.ts'
import { LoadError, Paths } from './parts.tsx'

type Actions = Omit<HistoryActions, 'hooks'>

export function CommitView({ detail, busy, now, actions }: {
  detail: DetailState
  busy: string | undefined
  now: number
  actions: Actions
}) {
  const { info, diffs } = detail
  return (
    <div className="dish-history-stack">
      <div>
        <Button variant="ghost" size="sm" onClick={() => { actions.show({ kind: 'log' }) }}>← Back to the log</Button>
      </div>
      {detail.status === 'loading' && <p className="dish-history-muted">Loading…</p>}
      {detail.status === 'error' && detail.error !== undefined && <LoadError notice={detail.error} retry={actions.reload} />}
      {detail.status === 'ready' && info !== undefined && diffs !== undefined && (
        <>
          <div className="dish-history-card">
            <h3 className="dish-history-card-title">{subjectOf(info.message)}</h3>
            <p className="dish-history-meta-line">
              <span className="dish-history-author">{authorLabel(info.author)}</span>
              <span className="dish-history-muted" title={new Date(info.time).toLocaleString()}>{relativeTime(info.time, now)}</span>
              <code className="dish-history-sha" title="The full commit id">{info.id}</code>
            </p>
            {info.note !== undefined && info.note !== '' && <p className="dish-history-text">{info.note}</p>}
            <Paths paths={info.paths} />
            <details className="dish-history-details">
              <summary>Full commit message</summary>
              <pre className="dish-history-message">{info.message}</pre>
            </details>
            <RevertControl key={info.id} id={info.id} busy={busy} revert={actions.revert} />
          </div>
          <DiffView diffs={diffs} />
        </>
      )}
    </div>
  )
}

/** The button, and when it is pressed a question first: reverting adds a commit, and the person should know that. */
function RevertControl({ id, busy, revert }: { id: string, busy: string | undefined, revert: (id: string) => void }) {
  const [confirming, setConfirming] = useState(false)
  const working = busy === `revert:${id}`
  if (!confirming && !working) {
    return (
      <div className="dish-history-actions">
        <Button variant="outline" size="sm" disabled={busy !== undefined} onClick={() => { setConfirming(true) }}>
          Revert this commit
        </Button>
      </div>
    )
  }
  return (
    <div className="dish-history-confirm" role="group" aria-label="Confirm the revert">
      <p className="dish-history-text">
        Revert {shortId(id)}? This adds a new commit that undoes it. Nothing is deleted from the history.
      </p>
      <div className="dish-history-actions">
        <Button
          variant="primary"
          size="sm"
          disabled={busy !== undefined}
          onClick={() => { revert(id); setConfirming(false) }}
        >
          {working ? 'Reverting…' : 'Revert'}
        </Button>
        <Button variant="ghost" size="sm" disabled={working} onClick={() => { setConfirming(false) }}>Cancel</Button>
      </div>
    </div>
  )
}
