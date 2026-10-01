/** Small pieces the page's views share. */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PageNotice } from './controller.ts'
import type { Notice } from './outcome.ts'

/** The result of the last thing the person did, with what the server itself said beneath it. */
export function NoticeBar({ notice, dismiss }: { notice: PageNotice, dismiss: () => void }) {
  return (
    <div className={`dish-judge-notice dish-judge-notice-${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>
      <div className="dish-judge-notice-body">
        <span>{notice.text}</span>
        {notice.detail !== undefined && notice.detail !== '' && <span className="dish-judge-muted">{notice.detail}</span>}
      </div>
      <Button variant="ghost" size="sm" onClick={dismiss}>Dismiss</Button>
    </div>
  )
}

/** A failure to load a view, with a way to try again. */
export function LoadError({ notice, retry }: { notice: Notice, retry: () => void }) {
  return (
    <div className="dish-judge-notice dish-judge-notice-error" role="alert">
      <div className="dish-judge-notice-body">
        <span>{notice.text}</span>
        {notice.detail !== undefined && notice.detail !== '' && <span className="dish-judge-muted">{notice.detail}</span>}
      </div>
      <Button variant="outline" size="sm" onClick={retry}>Try again</Button>
    </div>
  )
}

/** A line of explanation the person should notice but need not act on. */
export function Note({ tone = 'info', children }: { tone?: 'info' | 'warn', children: ReactNode }) {
  return <p className={`dish-judge-note dish-judge-note-${tone}`} role="note">{children}</p>
}

/** How often the page re-words "5 min ago". */
const TICK_MS = 30_000

/** The time now, as of the last tick: the cards that say "5 min ago" use it, so they stay right while the page is open. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => { setNow(Date.now()) }, TICK_MS)
    return () => { clearInterval(timer) }
  }, [])
  return now
}
