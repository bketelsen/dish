/**
 * The Default tab: what is saved, compared with the default dish ships, and **Reset to default** behind a confirm step.
 * A role with no shipped default has no such tab (the page hides it).
 */

import { useMemo, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { DiffView } from 'dish-kit/ui'
import { defaultView, type PageState, type PromptsActions } from './controller.ts'
import { roleLabel } from './format.ts'
import { SAME_AS_DEFAULT } from './outcome.ts'

type Actions = Omit<PromptsActions, 'hooks'>

export function DefaultTab({ state, actions }: { state: PageState, actions: Actions }) {
  const { defaultText, saved, selected, roles } = state
  const view = useMemo(() => defaultView({ defaultText, saved, selected, roles }), [defaultText, saved, selected, roles])
  if (view.kind === 'none') return <p className="dish-prompts-muted">dish ships no default for this role.</p>
  if (view.kind === 'same') return <p className="dish-prompts-text">{SAME_AS_DEFAULT}</p>
  return (
    <div className="dish-prompts-stack">
      <p className="dish-prompts-muted">
        What is saved, compared with the default dish ships: lines removed from the default in red, lines you added in green.
      </p>
      <DiffView diffs={[view.diff]} />
      <ResetControl key={selected} role={selected ?? ''} dirty={state.dirty} busy={state.busy} reset={actions.reset} />
    </div>
  )
}

/** The button, and when it is pressed a question first: a reset is a commit, and it replaces an unsaved edit too. */
function ResetControl({ role, dirty, busy, reset }: { role: string, dirty: boolean, busy: PageState['busy'], reset: () => Promise<void> }) {
  const [confirming, setConfirming] = useState(false)
  const working = busy === 'reset'
  if (!confirming && !working) {
    return (
      <div className="dish-prompts-actions">
        <Button variant="outline" size="sm" disabled={busy !== undefined} onClick={() => { setConfirming(true) }}>
          Reset to default
        </Button>
      </div>
    )
  }
  return (
    <div className="dish-prompts-confirm" role="group" aria-label="Confirm the reset">
      <p className="dish-prompts-text">
        Reset {roleLabel(role)} to the default? This saves the default as a new commit, so the text you have now stays in the history
        and can be reverted.{dirty ? ' Your unsaved edit in the editor is replaced too.' : ''}
      </p>
      <div className="dish-prompts-actions">
        <Button
          variant="primary"
          size="sm"
          disabled={busy !== undefined}
          onClick={() => { void reset().then(() => { setConfirming(false) }) }}
        >
          {working ? 'Resetting…' : 'Reset'}
        </Button>
        <Button variant="ghost" size="sm" disabled={working} onClick={() => { setConfirming(false) }}>Cancel</Button>
      </div>
    </div>
  )
}
