/**
 * The Default tab (a shipped skill only): what is saved, compared with the default dish ships, and **Reset to default**
 * behind a confirm step. A skill you added has no such tab (the page hides it).
 */

import { useMemo } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { DiffView } from 'dish-kit/ui'
import { defaultView, type PageState, type SkillsActions } from './controller.ts'
import { SAME_AS_DEFAULT } from './outcome.ts'

type Actions = Omit<SkillsActions, 'hooks'>

export function DefaultTab({ state, actions }: { state: PageState, actions: Actions }) {
  const { defaultText, saved, selected, skills, shipped } = state
  const view = useMemo(() => defaultView({ shipped, defaultText, saved, selected, skills }), [shipped, defaultText, saved, selected, skills])
  if (view.kind === 'none') return <p className="dish-skills-muted">dish ships no default for this skill.</p>
  if (view.kind === 'same') return <p className="dish-skills-text">{SAME_AS_DEFAULT}</p>
  return (
    <div className="dish-skills-stack">
      <p className="dish-skills-muted">
        What is saved, compared with the default dish ships: lines removed from the default in red, lines you added in green.
      </p>
      <DiffView diffs={[view.diff]} />
      <ResetControl key={selected} name={selected ?? ''} state={state} actions={actions} />
    </div>
  )
}

/** The button, and when it is pressed a question first: a reset is a commit, and it replaces an unsaved edit too. */
function ResetControl({ name, state, actions }: { name: string, state: PageState, actions: Actions }) {
  const { confirm, busy, dirty, hasHistory } = state
  const working = busy === 'reset'
  if (confirm !== 'reset' && !working) {
    return (
      <div className="dish-skills-actions">
        <Button variant="outline" size="sm" disabled={busy !== undefined} onClick={actions.askReset}>Reset to default</Button>
      </div>
    )
  }
  return (
    <div className="dish-skills-confirm" role="group" aria-label="Confirm the reset">
      <p className="dish-skills-text">
        Reset {name} to the default? This saves the default as a new commit
        {hasHistory ? ', so the text you have now stays in the history and can be reverted' : ''}.
        {dirty ? ' Your unsaved edit in the editor is replaced too.' : ''}
      </p>
      <div className="dish-skills-actions">
        <Button variant="primary" size="sm" disabled={busy !== undefined} onClick={() => { void actions.reset() }}>
          {working ? 'Resetting…' : 'Reset'}
        </Button>
        <Button variant="ghost" size="sm" disabled={working} onClick={actions.cancelConfirm}>Cancel</Button>
      </div>
    </div>
  )
}
