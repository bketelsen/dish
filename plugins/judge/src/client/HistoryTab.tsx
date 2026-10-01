/**
 * The History tab: this file's commits, newest first, each with its diff on request and **Revert** behind a confirm step. It is
 * dish-config's History, for one document. Proposals are decided on that page, not here.
 */

import { useEffect, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { DiffView } from 'dish-kit/ui'
import type { CommitInfo } from '../protocol.ts'
import { DOCUMENT } from './controller.ts'
import type { DetailState, JudgeActions, PageState } from './controller.ts'
import { authorLabel, commitText, relativeTime, shortId } from './format.ts'
import { LoadError, useNow } from './parts.tsx'

type Actions = Omit<JudgeActions, 'hooks'>

export function HistoryTab({ state, actions }: { state: PageState, actions: Actions }) {
  const { history, busy } = state.thresholds
  const now = useNow()
  if (history === undefined || (history.status === 'loading' && history.commits.length === 0)) {
    return <p className="dish-judge-muted">Loading…</p>
  }
  return (
    <div className="dish-judge-stack">
      <p className="dish-judge-muted">
        Every change to <code className="dish-judge-code">{DOCUMENT}</code>, newest first. Reverting one adds a commit that undoes it.
      </p>
      {history.status === 'error' && history.error !== undefined && <LoadError notice={history.error} retry={() => { void actions.loadHistory() }} />}
      {history.status === 'ready' && history.commits.length === 0 && <p className="dish-judge-muted">No commits yet for this file.</p>}
      {history.commits.length > 0 && (
        <ul className="dish-judge-list">
          {history.commits.map(commit => (
            <CommitCard key={commit.id} commit={commit} detail={history.details[commit.id]} busy={busy} now={now} actions={actions} />
          ))}
        </ul>
      )}
    </div>
  )
}

function CommitCard({ commit, detail, busy, now, actions }: {
  commit: CommitInfo
  detail: DetailState | undefined
  busy: PageState['thresholds']['busy']
  now: number
  actions: Actions
}) {
  const [expanded, setExpanded] = useState(false)
  const { loadCommit } = actions
  useEffect(() => {
    if (expanded) void loadCommit(commit.id)
  }, [expanded, commit.id, loadCommit])
  const others = commit.paths.filter(other => other !== DOCUMENT)
  const panel = `dish-judge-commit-${commit.id}`
  return (
    <li className="dish-judge-commit">
      <p className="dish-judge-text dish-judge-commit-title">{commitText(commit)}</p>
      <p className="dish-judge-meta-line">
        <span className="dish-judge-author">{authorLabel(commit.author)}</span>
        <span className="dish-judge-muted" title={new Date(commit.time).toLocaleString()}>{relativeTime(commit.time, now)}</span>
        <code className="dish-judge-sha" title={commit.id}>{shortId(commit.id)}</code>
      </p>
      <div className="dish-judge-actions">
        <Button variant="ghost" size="sm" type="button" aria-expanded={expanded} aria-controls={panel} onClick={() => { setExpanded(!expanded) }}>
          {expanded ? 'Hide changes' : 'Show changes'}
        </Button>
      </div>
      {expanded && (
        <div id={panel}>
          {(detail === undefined || detail.status === 'loading') && <p className="dish-judge-muted">Loading…</p>}
          {detail?.status === 'error' && <LoadError notice={detail.error} retry={() => { void loadCommit(commit.id) }} />}
          {detail?.status === 'ready' && <DiffView diffs={detail.diffs} />}
        </div>
      )}
      <RevertControl key={commit.id} id={commit.id} others={others} busy={busy} revert={actions.revert} />
    </li>
  )
}

/** The button, and when it is pressed a question first: reverting adds a commit, and may undo more than this file. */
function RevertControl({ id, others, busy, revert }: { id: string, others: string[], busy: PageState['thresholds']['busy'], revert: (id: string) => Promise<void> }) {
  const [confirming, setConfirming] = useState(false)
  const working = busy === `revert:${id}`
  if (!confirming && !working) {
    return (
      <div className="dish-judge-actions">
        <Button variant="outline" size="sm" type="button" disabled={busy !== undefined} onClick={() => { setConfirming(true) }}>Revert</Button>
      </div>
    )
  }
  return (
    <div className="dish-judge-confirm" role="group" aria-label="Confirm the revert">
      <p className="dish-judge-text">
        Revert {shortId(id)}? This adds a new commit that undoes it. Nothing is deleted from the history.
        {others.length > 0 ? ` That commit also changed ${others.join(', ')}, and reverting it undoes those changes too.` : ''}
      </p>
      <div className="dish-judge-actions">
        <Button
          variant="primary"
          size="sm"
          type="button"
          disabled={busy !== undefined}
          onClick={() => { void revert(id).then(() => { setConfirming(false) }) }}
        >
          {working ? 'Reverting…' : 'Revert'}
        </Button>
        <Button variant="ghost" size="sm" type="button" disabled={working} onClick={() => { setConfirming(false) }}>Cancel</Button>
      </div>
    </div>
  )
}
