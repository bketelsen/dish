/**
 * The Preview tab: the system prompt a new agent in this role would get now, as far as dish can build it. It is always
 * labelled as an approximation, and says plainly when dsh's own assembly couldn't be used and the text has markers in
 * place of dsh's sections.
 */

import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PageState, PromptsActions } from './controller.ts'
import { LoadError, Note, VariableNames } from './parts.tsx'

type Actions = Omit<PromptsActions, 'hooks'>

export function PreviewTab({ state, actions }: { state: PageState, actions: Actions }) {
  const { preview, selected, dirty } = state
  const result = preview?.value
  return (
    <div className="dish-prompts-stack">
      <Note>
        Approximate. Runtime context (the sandbox and approval policy, AGENTS.md) reaches the model as separate messages and isn't shown,
        and variables that only have a value for each agent appear as <code className="dish-prompts-code">‹name›</code>.
        {selected === 'common' ? ' Common ends every role\'s prompt, so it is shown on Main\'s.' : ''}
        {selected !== undefined && selected !== 'common' && selected !== 'main' ? ' This role\'s own text stands where Main\'s does.' : ''}
      </Note>
      {dirty && <Note>This is the saved text. Your unsaved edit isn't in it.</Note>}
      {preview === undefined || (preview.status === 'loading' && result === undefined) ? <p className="dish-prompts-muted">Loading…</p> : null}
      {preview?.status === 'error' && preview.error !== undefined && <LoadError notice={preview.error} retry={() => { void actions.loadPreview() }} />}
      {result?.fallback === true && (
        <Note tone="warn">
          dsh's own system prompt couldn't be built here, so this shows only the persona texts, with markers like
          {' '}<code className="dish-prompts-code">[dsh: environment]</code> where dsh's sections go. The real prompt has those sections.
        </Note>
      )}
      {result !== undefined && result.unknownVariables.length > 0 && (
        <Note tone="warn">
          No value for <VariableNames names={result.unknownVariables} />. {result.unknownVariables.length === 1 ? 'It is' : 'They are'} left
          as written.
        </Note>
      )}
      {result !== undefined && (
        <pre className="dish-prompts-preview" tabIndex={0} aria-label="The rendered system prompt">{result.text}</pre>
      )}
      <div className="dish-prompts-actions">
        <Button variant="outline" size="sm" disabled={preview?.status === 'loading'} onClick={() => { void actions.loadPreview() }}>
          Refresh
        </Button>
      </div>
    </div>
  )
}
