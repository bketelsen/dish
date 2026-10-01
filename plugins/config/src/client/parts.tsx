/** Small pieces the page's views share. */

import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PageNotice } from './controller.ts'
import type { Notice } from './outcome.ts'

/** The result of the last thing the person did, with what the store itself said beneath it. */
export function NoticeBar({ notice, dismiss }: { notice: PageNotice, dismiss: () => void }) {
  return (
    <div className={`dish-history-notice dish-history-notice-${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>
      <div className="dish-history-notice-body">
        <span>{notice.text}</span>
        {notice.detail !== undefined && notice.detail !== '' && <span className="dish-history-muted">{notice.detail}</span>}
      </div>
      <Button variant="ghost" size="sm" onClick={dismiss}>Dismiss</Button>
    </div>
  )
}

/** A failure to load a view, with a way to try again. */
export function LoadError({ notice, retry }: { notice: Notice, retry: () => void }) {
  return (
    <div className="dish-history-notice dish-history-notice-error" role="alert">
      <div className="dish-history-notice-body">
        <span>{notice.text}</span>
        {notice.detail !== undefined && notice.detail !== '' && <span className="dish-history-muted">{notice.detail}</span>}
      </div>
      <Button variant="outline" size="sm" onClick={retry}>Try again</Button>
    </div>
  )
}

const SHOWN_PATHS = 4

/** The paths a commit or a proposal changes: the first few, then how many more. */
export function Paths({ paths }: { paths: readonly string[] }) {
  if (paths.length === 0) return null
  const rest = paths.length - SHOWN_PATHS
  return (
    <span className="dish-history-paths">
      {paths.slice(0, SHOWN_PATHS).map(path => <code key={path} className="dish-history-path">{path}</code>)}
      {rest > 0 && <span className="dish-history-muted">and {rest} more</span>}
    </span>
  )
}

/** A titled group of the page. */
export function Group({ title, children }: { title: string, children: ReactNode }) {
  return (
    <section className="dish-history-group">
      <h3 className="dish-history-group-title">{title}</h3>
      {children}
    </section>
  )
}
