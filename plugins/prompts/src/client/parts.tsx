/** Small pieces the page's views share. */

import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PageNotice } from './controller.ts'
import type { Notice } from './outcome.ts'

/** The result of the last thing the person did, with what the store itself said beneath it. */
export function NoticeBar({ notice, dismiss }: { notice: PageNotice, dismiss: () => void }) {
  return (
    <div className={`dish-prompts-notice dish-prompts-notice-${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>
      <div className="dish-prompts-notice-body">
        <span>{notice.text}</span>
        {notice.detail !== undefined && notice.detail !== '' && <span className="dish-prompts-muted">{notice.detail}</span>}
      </div>
      <Button variant="ghost" size="sm" onClick={dismiss}>Dismiss</Button>
    </div>
  )
}

/** A failure to load a view, with a way to try again. */
export function LoadError({ notice, retry }: { notice: Notice, retry: () => void }) {
  return (
    <div className="dish-prompts-notice dish-prompts-notice-error" role="alert">
      <div className="dish-prompts-notice-body">
        <span>{notice.text}</span>
        {notice.detail !== undefined && notice.detail !== '' && <span className="dish-prompts-muted">{notice.detail}</span>}
      </div>
      <Button variant="outline" size="sm" onClick={retry}>Try again</Button>
    </div>
  )
}

/** A line of explanation the person should notice but need not act on. */
export function Note({ tone = 'info', children }: { tone?: 'info' | 'warn', children: ReactNode }) {
  return <p className={`dish-prompts-note dish-prompts-note-${tone}`} role="note">{children}</p>
}

/** `{{name}}`, as a prompt writes a variable. */
export function VariableName({ name }: { name: string }) {
  return <code className="dish-prompts-code">{`{{${name}}}`}</code>
}

/** A comma-separated run of variable names. */
export function VariableNames({ names }: { names: readonly string[] }) {
  return (
    <>
      {names.map((name, index) => (
        <span key={name}>{index > 0 && ', '}<VariableName name={name} /></span>
      ))}
    </>
  )
}
