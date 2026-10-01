/** The log: the commits on `main`, newest first, filtered by namespace, with "Load more". */

import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { NamespaceInfo } from '../protocol.ts'
import type { HistoryActions, LogState } from './controller.ts'
import { authorLabel, commitText, relativeTime, shortId } from './format.ts'
import { LoadError, Paths } from './parts.tsx'

type Actions = Omit<HistoryActions, 'hooks'>

export function LogView({ log, prefix, namespaces, now, actions }: {
  log: LogState
  prefix: string
  namespaces: readonly NamespaceInfo[]
  now: number
  actions: Actions
}) {
  return (
    <div className="dish-history-stack">
      <label className="dish-history-filter">
        <span className="dish-history-muted">Show</span>
        <select
          className="dish-history-select"
          value={prefix}
          onChange={(event) => { actions.setPrefix(event.target.value) }}
        >
          <option value="">All</option>
          {namespaces.map(({ prefix: value, owner }) => <option key={value} value={value}>{value} ({owner})</option>)}
        </select>
      </label>
      {log.error !== undefined && <LoadError notice={log.error} retry={actions.reload} />}
      {!log.loaded && log.error === undefined && <p className="dish-history-muted">Loading…</p>}
      {log.loaded && log.commits.length === 0 && (
        <p className="dish-history-muted">{prefix === '' ? 'No commits yet.' : `No commits under ${prefix}.`}</p>
      )}
      {log.commits.length > 0 && (
        <ul className="dish-history-list">
          {log.commits.map(commit => (
            <li key={commit.id}>
              <button
                type="button"
                className="dish-history-row"
                onClick={() => { actions.show({ kind: 'commit', id: commit.id }) }}
              >
                <span className="dish-history-row-top">
                  <span className="dish-history-author" title={commit.author.kind === 'agent' ? `Session ${commit.author.sessionId}` : undefined}>
                    {authorLabel(commit.author)}
                  </span>
                  <span className="dish-history-muted" title={new Date(commit.time).toLocaleString()}>{relativeTime(commit.time, now)}</span>
                  <code className="dish-history-sha">{shortId(commit.id)}</code>
                </span>
                <span className="dish-history-row-text">{commitText(commit)}</span>
                <Paths paths={commit.paths} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {log.more && (
        <div>
          <Button variant="outline" size="sm" disabled={log.loadingMore} onClick={actions.loadMore}>
            {log.loadingMore ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )}
    </div>
  )
}
