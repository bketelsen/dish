/** Small pieces the page's owner uses (judge's `parts.tsx`): a load error with a way to try again, and a clock that ticks. */

import { useEffect, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Notice } from './outcome.ts'

/** A failure to load a view, with a way to try again. */
export function LoadError({ notice, retry }: { notice: Notice, retry: () => void }) {
  return (
    <div className="dish-runs-notice dish-runs-notice-error" role="alert">
      <div className="dish-runs-notice-body">
        <span>{notice.text}</span>
        {notice.detail !== undefined && notice.detail !== '' && <span className="dish-runs-muted">{notice.detail}</span>}
      </div>
      <Button variant="outline" size="sm" onClick={retry}>Try again</Button>
    </div>
  )
}

/** How often the page re-words "5 min ago". */
const TICK_MS = 30_000

/** The time now, as of the last tick: the page says "opened 5 min ago", so it stays right while the page is open. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => { setNow(Date.now()) }, TICK_MS)
    return () => { clearInterval(timer) }
  }, [])
  return now
}
