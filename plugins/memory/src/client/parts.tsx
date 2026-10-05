/**
 * Small pieces the page's views share: the notice, a load error with a way to try again, a note, the remote line, a question
 * asked before something is deleted, reverted or thrown away, and the conflict box. Like the views, they are plain functions
 * of their props, with no hooks, so a test renders them under Node.
 */

import type { ReactNode } from 'react'
import { Button, StateDot, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import { DiffView } from 'dish-kit/ui'
import type { FileDiff, RemoteStatus } from '../protocol.ts'
import type { PageNotice, PageState } from './controller.ts'
import { remoteLine } from './format.ts'
import type { Notice } from './outcome.ts'

/** The result of the last thing the person did, with what the service itself said beneath it. */
export function NoticeBar({ notice, dismiss }: { notice: PageNotice, dismiss: () => void }) {
  return (
    <div className={`dish-memory-notice dish-memory-notice-${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>
      <div className="dish-memory-notice-body">
        <span>{notice.text}</span>
        {notice.detail !== undefined && notice.detail !== '' && <span className="dish-memory-muted">{notice.detail}</span>}
      </div>
      <Button variant="ghost" size="sm" onClick={dismiss}>Dismiss</Button>
    </div>
  )
}

/** A failure to load a view, with a way to try again. */
export function LoadError({ notice, retry }: { notice: Notice, retry: () => void }) {
  return (
    <div className="dish-memory-notice dish-memory-notice-error" role="alert">
      <div className="dish-memory-notice-body">
        <span>{notice.text}</span>
        {notice.detail !== undefined && notice.detail !== '' && <span className="dish-memory-muted">{notice.detail}</span>}
      </div>
      <Button variant="outline" size="sm" onClick={retry}>Try again</Button>
    </div>
  )
}

/** A line of explanation the person should notice but need not act on. */
export function Note({ tone = 'info', children }: { tone?: 'info' | 'warn', children: ReactNode }) {
  return <p className={`dish-memory-note dish-memory-note-${tone}`} role="note">{children}</p>
}

/** `Pushed <short id> · <n> pending · <error>`, with a dot for how it is going, and a word when updates have stopped arriving. */
export function RemoteLine({ remote, stream }: { remote: RemoteStatus | undefined, stream: PageState['stream'] }) {
  const state: StateDotState = remote === undefined ? 'ongoing'
    : remote.remote === undefined ? 'idle'
      : remote.lastError !== undefined && remote.lastError !== '' ? 'error'
        : remote.pending > 0 ? 'warning' : 'done'
  return (
    <p className="dish-memory-remote" title={remote?.remote}>
      <StateDot state={state} />
      <span>{remote === undefined ? 'Checking the remote…' : remoteLine(remote)}</span>
      {stream === 'down' && <span className="dish-memory-muted">Live updates paused. Reconnecting…</span>}
    </p>
  )
}

/** A question, with the button that does it and one that doesn't. */
export function Confirm({ label, text, action, working, disabled, confirm, cancel }: {
  /** What the group is, for a screen reader. */
  label: string
  text: string
  /** The button that does it, and what it says while it does. */
  action: [idle: string, busy: string]
  working: boolean
  disabled: boolean
  confirm: () => void
  cancel: () => void
}) {
  return (
    <div className="dish-memory-confirm" role="group" aria-label={label}>
      <p className="dish-memory-text">{text}</p>
      <div className="dish-memory-actions">
        <Button variant="primary" size="sm" disabled={disabled} onClick={confirm}>{working ? action[1] : action[0]}</Button>
        <Button variant="ghost" size="sm" disabled={working} onClick={cancel}>Cancel</Button>
      </div>
    </div>
  )
}

/**
 * What changed underneath a draft: a sentence, what is there now, the diff from what the page loaded to it, and the two ways
 * out. Reload takes what is there and drops the edit; Keep mine keeps the edit, to be saved over it.
 */
export function ConflictBox({ title, children, diff, reload, keepMine }: {
  title: string
  children: ReactNode
  diff: FileDiff
  reload: () => void
  keepMine: () => void
}) {
  return (
    <div className="dish-memory-conflict" role="alert">
      <p className="dish-memory-text"><strong>{title}</strong> Your text is still below. Saving now would replace the change shown here.</p>
      {children}
      {diff.patch !== '' && <DiffView diffs={[diff]} />}
      <div className="dish-memory-actions">
        <Button variant="primary" size="sm" onClick={reload}>Reload (drop my edit)</Button>
        <Button variant="outline" size="sm" onClick={keepMine}>Keep mine</Button>
      </div>
    </div>
  )
}
