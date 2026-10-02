/**
 * The History tab: this skill's commits, newest first, each with its diff on request and **Revert** behind a confirm step,
 * and **Load more** below the oldest while there may be older ones. It is dish-config's History, for one document.
 * Proposals are decided on that page, not here.
 */

import { useEffect, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { DiffView } from 'dish-kit/ui'
import type { CommitInfo } from '../protocol.ts'
import type { DetailState, PageState, SkillsActions } from './controller.ts'
import { authorLabel, commitText, relativeTime, shortId } from './format.ts'
import { LoadError } from './parts.tsx'

type Actions = Omit<SkillsActions, 'hooks'>

/** How often the page re-words "5 min ago". */
const TICK_MS = 30_000

function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => { setNow(Date.now()) }, TICK_MS)
    return () => { clearInterval(timer) }
  }, [])
  return now
}

export function HistoryTab({ state, path, actions }: { state: PageState, path: string, actions: Actions }) {
  const { history, busy } = state
  const now = useNow()
  if (history === undefined || (history.status === 'loading' && history.commits.length === 0)) {
    return <p className="dish-skills-muted">Loading…</p>
  }
  // A failed first read or refresh retries that; a failed "Load more" retries the page it was after.
  const retry = (): void => { void (history.status === 'error' ? actions.loadHistory() : actions.loadMoreHistory()) }
  return (
    <div className="dish-skills-stack">
      <p className="dish-skills-muted">
        Every change to <code className="dish-skills-code">{path}</code>, newest first. Reverting one adds a commit that undoes it.
      </p>
      {history.error !== undefined && <LoadError notice={history.error} retry={retry} />}
      {history.status === 'ready' && history.commits.length === 0 && <p className="dish-skills-muted">No commits yet for this skill.</p>}
      {history.commits.length > 0 && (
        <ul className="dish-skills-list">
          {history.commits.map(commit => (
            <CommitCard key={commit.id} commit={commit} path={path} detail={history.details[commit.id]} busy={busy} now={now} actions={actions} />
          ))}
        </ul>
      )}
      {history.more && history.error === undefined && (
        <div className="dish-skills-actions">
          <Button variant="outline" size="sm" disabled={history.loadingMore || history.status === 'loading'} onClick={() => { void actions.loadMoreHistory() }}>
            {history.loadingMore ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )}
    </div>
  )
}

function CommitCard({ commit, path, detail, busy, now, actions }: {
  commit: CommitInfo
  path: string
  detail: DetailState | undefined
  busy: PageState['busy']
  now: number
  actions: Actions
}) {
  const [expanded, setExpanded] = useState(false)
  const { loadCommit } = actions
  useEffect(() => {
    if (expanded) void loadCommit(commit.id)
  }, [expanded, commit.id, loadCommit])
  const others = commit.paths.filter(other => other !== path)
  const panel = `dish-skills-commit-${commit.id}`
  return (
    <li className="dish-skills-card">
      <p className="dish-skills-text dish-skills-card-title">{commitText(commit)}</p>
      <p className="dish-skills-meta-line">
        <span className="dish-skills-author">{authorLabel(commit.author)}</span>
        <span className="dish-skills-muted" title={new Date(commit.time).toLocaleString()}>{relativeTime(commit.time, now)}</span>
        <code className="dish-skills-sha" title={commit.id}>{shortId(commit.id)}</code>
      </p>
      <div className="dish-skills-actions">
        <Button variant="ghost" size="sm" aria-expanded={expanded} aria-controls={panel} onClick={() => { setExpanded(!expanded) }}>
          {expanded ? 'Hide changes' : 'Show changes'}
        </Button>
      </div>
      {expanded && (
        <div id={panel}>
          {(detail === undefined || detail.status === 'loading') && <p className="dish-skills-muted">Loading…</p>}
          {detail?.status === 'error' && <LoadError notice={detail.error} retry={() => { void loadCommit(commit.id) }} />}
          {detail?.status === 'ready' && <DiffView diffs={detail.diffs} />}
        </div>
      )}
      <RevertControl key={commit.id} id={commit.id} others={others} busy={busy} revert={actions.revert} />
    </li>
  )
}

/** The button, and when it is pressed a question first: reverting adds a commit, and may undo more than this skill. */
function RevertControl({ id, others, busy, revert }: { id: string, others: string[], busy: PageState['busy'], revert: (id: string) => Promise<void> }) {
  const [confirming, setConfirming] = useState(false)
  const working = busy === `revert:${id}`
  if (!confirming && !working) {
    return (
      <div className="dish-skills-actions">
        <Button variant="outline" size="sm" disabled={busy !== undefined} onClick={() => { setConfirming(true) }}>Revert</Button>
      </div>
    )
  }
  return (
    <div className="dish-skills-confirm" role="group" aria-label="Confirm the revert">
      <p className="dish-skills-text">
        Revert {shortId(id)}? This adds a new commit that undoes it. Nothing is deleted from the history.
        {others.length > 0 ? ` That commit also changed ${others.join(', ')}, and reverting it undoes those changes too.` : ''}
      </p>
      <div className="dish-skills-actions">
        <Button
          variant="primary"
          size="sm"
          disabled={busy !== undefined}
          onClick={() => { void revert(id).then(() => { setConfirming(false) }) }}
        >
          {working ? 'Reverting…' : 'Revert'}
        </Button>
        <Button variant="ghost" size="sm" disabled={working} onClick={() => { setConfirming(false) }}>Cancel</Button>
      </div>
    </div>
  )
}
