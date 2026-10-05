/**
 * The Preview tab: the `dish-memory` message a main agent working in this scope gets now, as text, or a line saying it gets
 * none.
 */

import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MemoryActions, PageState } from './controller.ts'
import { LoadError, Note } from './parts.tsx'

type Actions = Omit<MemoryActions, 'hooks'>

export function PreviewTab({ state, actions }: { state: PageState, actions: Actions }) {
  const { preview, errors } = state
  return (
    <div className="dish-memory-stack">
      <Note>
        What a main agent working here gets: at the start of a chat, and again after a compaction. An agent already running keeps the
        message it has until then.
      </Note>
      {errors.preview !== undefined && <LoadError notice={errors.preview} retry={() => { void actions.loadPreview() }} />}
      {preview === undefined && errors.preview === undefined && <p className="dish-memory-muted">Loading…</p>}
      {preview === '' && <p className="dish-memory-muted">Agents in this scope get no memory message now.</p>}
      {preview !== undefined && preview !== '' && (
        <pre className="dish-memory-preview" tabIndex={0} aria-label="The memory message">{preview}</pre>
      )}
      <div className="dish-memory-actions">
        <Button variant="outline" size="sm" onClick={() => { void actions.loadPreview() }}>Refresh</Button>
      </div>
    </div>
  )
}
