/**
 * The History tab: the scope's commits in the vault, newest first, 20 at a time with **More**. Each says what it was for, who
 * made it, when, and which memories it changed; one opens to its diff and **Revert**, which asks first.
 */

import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { DiffView } from 'dish-kit/ui'
import type { CommitInfo } from '../protocol.ts'
import type { HistoryState, MemoryActions, PageState } from './controller.ts'
import { authorLabel, commitText, relativeTime, shortId } from './format.ts'
import { Confirm, LoadError } from './parts.tsx'

type Actions = Omit<MemoryActions, 'hooks'>

/** The memory files a commit changed: every commit also rewrites its scope's index, which says nothing of its own. */
function memoryPaths(paths: readonly string[]): string[] {
  return paths.filter(path => !path.endsWith('/MEMORY.md'))
}

export function HistoryTab({ state, now, actions }: { state: PageState, now: number, actions: Actions }) {
  const { history, errors } = state
  if (history === undefined) {
    return errors.history !== undefined
      ? <LoadError notice={errors.history} retry={() => { void actions.loadHistory() }} />
      : <p className="dish-memory-muted">Loading…</p>
  }
  return (
    <div className="dish-memory-stack">
      <p className="dish-memory-muted">Every change to this scope's memories, newest first. Reverting one adds a commit that undoes it.</p>
      {errors.history !== undefined && <LoadError notice={errors.history} retry={() => { void actions.loadHistory() }} />}
      {history.commits.length === 0 && <p className="dish-memory-muted">No changes yet.</p>}
      {history.commits.length > 0 && (
        <ul className="dish-memory-list">
          {history.commits.map(commit => (
            <CommitCard key={commit.id} commit={commit} history={history} state={state} now={now} actions={actions} />
          ))}
        </ul>
      )}
      {history.more && (
        <div className="dish-memory-actions">
          <Button variant="outline" size="sm" disabled={history.loadingMore === true} onClick={() => { void actions.loadHistory(true) }}>
            {history.loadingMore === true ? 'Loading…' : 'More'}
          </Button>
        </div>
      )}
    </div>
  )
}

function CommitCard({ commit, history, state, now, actions }: {
  commit: CommitInfo
  history: HistoryState
  state: PageState
  now: number
  actions: Actions
}) {
  const { busy, asking, errors } = state
  const detail = history.detail?.info.id === commit.id ? history.detail : undefined
  const opening = history.opening === commit.id
  const panel = `dish-memory-commit-${commit.id}`
  const paths = memoryPaths(commit.paths)
  const confirming = asking?.kind === 'revert' && asking.id === commit.id
  const working = busy === `revert:${commit.id}`
  return (
    <li className="dish-memory-card">
      <p className="dish-memory-text dish-memory-card-title">{commitText(commit)}</p>
      <p className="dish-memory-meta-line">
        <span className="dish-memory-author">{authorLabel(commit.author)}</span>
        <span className="dish-memory-muted" title={new Date(commit.time).toLocaleString()}>{relativeTime(commit.time, now)}</span>
        <code className="dish-memory-sha" title={commit.id}>{shortId(commit.id)}</code>
      </p>
      {paths.length > 0 && <p className="dish-memory-muted">{paths.join(', ')}</p>}
      <div className="dish-memory-actions">
        <Button variant="ghost" size="sm" aria-expanded={detail !== undefined} aria-controls={panel} onClick={() => { void actions.loadCommit(commit.id) }}>
          {detail !== undefined ? 'Hide changes' : 'Show changes'}
        </Button>
      </div>
      {opening && (errors.commit !== undefined
        ? <LoadError notice={errors.commit} retry={() => { void actions.loadCommit(commit.id) }} />
        : <p className="dish-memory-muted">Loading…</p>)}
      {detail !== undefined && (
        <div id={panel} className="dish-memory-stack">
          <DiffView diffs={detail.diffs} />
          {confirming || working
            ? (
                <Confirm
                  label="Confirm the revert"
                  text={`Revert ${shortId(commit.id)}? This adds a new commit that undoes it. Nothing is deleted from the history.`}
                  action={['Revert', 'Reverting…']}
                  working={working}
                  disabled={busy !== undefined}
                  confirm={() => { void actions.confirm() }}
                  cancel={actions.cancel}
                />
              )
            : (
                <div className="dish-memory-actions">
                  <Button variant="outline" size="sm" disabled={busy !== undefined} onClick={() => { actions.revert(commit.id) }}>Revert</Button>
                </div>
              )}
        </div>
      )}
    </li>
  )
}
