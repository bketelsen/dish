/** Small pieces the page's views share. */

import type { ReactNode } from 'react'
import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ProjectState } from '../protocol.ts'
import type { PageNotice } from './controller.ts'
import { skippedParts, stateLabel, stateTone } from './format.ts'
import type { Notice } from './outcome.ts'

/** The result of the last thing the person did, with what the registry itself said beneath it. */
export function NoticeBar({ notice, dismiss }: { notice: PageNotice, dismiss: () => void }) {
  return (
    <div className={`dish-projects-notice dish-projects-notice-bar dish-projects-notice-${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>
      <div className="dish-projects-notice-body">
        <span>{notice.text}</span>
        {notice.detail !== undefined && notice.detail !== '' && <span className="dish-projects-muted">{notice.detail}</span>}
      </div>
      <Button variant="ghost" size="sm" onClick={dismiss}>Dismiss</Button>
    </div>
  )
}

/** A failure to load a view, with a way to try again. */
export function LoadError({ notice, retry }: { notice: Notice, retry: () => void }) {
  return (
    <div className="dish-projects-notice dish-projects-notice-error" role="alert">
      <div className="dish-projects-notice-body">
        <span>{notice.text}</span>
        {notice.detail !== undefined && notice.detail !== '' && <span className="dish-projects-muted">{notice.detail}</span>}
      </div>
      <Button variant="outline" size="sm" onClick={retry}>Try again</Button>
    </div>
  )
}

/** A line of explanation the person should notice but need not act on. */
export function Note({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'error', children: ReactNode }) {
  return <div className={`dish-projects-note dish-projects-note-${tone}`} role="note">{children}</div>
}

/** Where a project is in onboarding, as a chip. */
export function StatusChip({ state }: { state: ProjectState }) {
  return <Tag tone={stateTone(state)}>{stateLabel(state)}</Tag>
}

/** Setup didn't run: why, and the command to run instead. */
export function SkippedNote({ text }: { text: string }) {
  const { reason, where, command } = skippedParts(text)
  return (
    <Note tone="warn">
      <div className="dish-projects-note-skipped">
        <span><strong>Setup skipped{reason === '' ? '.' : ':'}</strong> {reason}</span>
        {command !== undefined && (
          <>
            <span>Run it yourself in <code className="dish-projects-code">{where}</code>:</span>
            <code className="dish-projects-code">{command}</code>
          </>
        )}
      </div>
    </Note>
  )
}

/** What changed under an edit, setting by setting. */
export function ChangeList({ changes }: { changes: ReadonlyArray<{ label: string, was: string, now: string }> }) {
  return (
    <ul className="dish-projects-changes">
      {changes.map(change => (
        <li key={change.label}>
          <span className="dish-projects-muted">{change.label}</span>
          {change.was !== '' && <span className="dish-projects-was dish-projects-code">{change.was}</span>}
          <span className="dish-projects-code">{change.now}</span>
        </li>
      ))}
    </ul>
  )
}
