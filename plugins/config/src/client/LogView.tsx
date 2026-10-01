/** The log: the commits on `main`, newest first, filtered by namespace or path, with "Load more". */

import { useEffect, useRef, useState } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { NamespaceInfo } from '../protocol.ts'
import type { HistoryActions, LogState } from './controller.ts'
import { authorLabel, commitText, noCommitsText, normalizeFilter, relativeTime, shortId } from './format.ts'
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
      <FilterInput prefix={prefix} namespaces={namespaces} setPrefix={actions.setPrefix} />
      {log.error !== undefined && <LoadError notice={log.error} retry={actions.reload} />}
      {!log.loaded && log.error === undefined && <p className="dish-history-muted">Loading…</p>}
      {log.loaded && log.commits.length === 0 && (
        <p className="dish-history-muted">{noCommitsText(prefix)}</p>
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

/** How long typing pauses before the log is read again for what was typed. */
const FILTER_DELAY_MS = 300

/**
 * The log's filter: free text, with the claimed namespaces offered as suggestions. Empty is all; text ending in `/` is a
 * prefix and anything else a path (the server tells them apart). Typing is applied after a pause, and at once on Enter,
 * on leaving the field, and on leaving the log.
 */
function FilterInput({ prefix, namespaces, setPrefix }: {
  prefix: string
  namespaces: readonly NamespaceInfo[]
  setPrefix: (prefix: string) => void
}) {
  const [text, setText] = useState(prefix)
  const typed = useRef(prefix)
  const applied = useRef(prefix)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  /** Apply what is typed now, if it is not what the log already shows. */
  const apply = (): void => {
    clearTimeout(timer.current)
    timer.current = undefined
    const next = normalizeFilter(typed.current)
    if (next === applied.current) return
    applied.current = next
    setPrefix(next)
  }
  // Leaving the log (a click on a commit) within the pause must not lose what was typed.
  const flush = useRef(apply)
  flush.current = apply
  useEffect(() => () => { if (timer.current !== undefined) flush.current() }, [])

  return (
    <label className="dish-history-filter">
      <span className="dish-history-muted">Filter</span>
      <Input
        className="dish-history-filter-input"
        value={text}
        list="dish-history-namespaces"
        placeholder="All (or a path, or a prefix ending in /)"
        aria-label="Filter the log by namespace or path"
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        onChange={(event) => {
          typed.current = event.target.value
          setText(event.target.value)
          clearTimeout(timer.current)
          timer.current = setTimeout(apply, FILTER_DELAY_MS)
        }}
        onBlur={apply}
        onKeyDown={(event) => { if (event.key === 'Enter') apply() }}
      />
      <datalist id="dish-history-namespaces">
        {namespaces.map(({ prefix: value, owner }) => <option key={value} value={value} label={owner} />)}
      </datalist>
    </label>
  )
}
