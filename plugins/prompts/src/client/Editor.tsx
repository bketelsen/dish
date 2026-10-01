/**
 * The Edit tab: the prompt's text in a monospace area, the optional note that becomes the commit's note, **Save** and
 * **Discard**, a warning for `{{names}}` that have no variable, and, after a conflict, what changed underneath with the
 * two ways out of it.
 */

import { useMemo, type KeyboardEvent } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { DiffView, unifiedDiff } from 'dish-kit/ui'
import type { PageState, PromptsActions } from './controller.ts'
import { Note, VariableName, VariableNames } from './parts.tsx'
import { roleLabel } from './format.ts'

type Actions = Omit<PromptsActions, 'hooks'>

export function Editor({ state, path, actions }: { state: PageState, path: string, actions: Actions }) {
  const { selected, saved, draft, note, dirty, busy, readOnly, missing, conflict, unknownVariables, variables } = state
  const role = selected ?? ''
  const saving = busy === 'save'
  const frozen = readOnly || busy !== undefined
  // After a conflict the way on is Reload or Keep mine: a save would be refused again.
  const cannotSave = !dirty || frozen || conflict !== undefined
  const underneath = useMemo(
    () => (conflict === undefined || saved === undefined ? undefined : unifiedDiff(path, saved.text, conflict.theirs)),
    [conflict, saved, path],
  )
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // The save shortcut an editor has; the browser's own (save the page) is no use here.
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault()
      if (!cannotSave) void actions.save()
    }
  }
  return (
    <div className="dish-prompts-stack">
      {readOnly && (
        <Note tone="warn">
          The config store isn't running, so this is the shipped default and can't be changed. Start dish-config to edit prompts.
        </Note>
      )}
      {missing && !readOnly && <Note>This prompt isn't in the store, so the default is in use. Saving adds it.</Note>}
      {conflict !== undefined && (
        <div className="dish-prompts-conflict" role="alert">
          <p className="dish-prompts-text">
            <strong>This prompt changed while you were editing it.</strong> Your text is still below. Saving now would replace the
            change shown here.
          </p>
          {underneath !== undefined && <DiffView diffs={[underneath]} />}
          <div className="dish-prompts-actions">
            <Button variant="primary" size="sm" onClick={() => { void actions.reload() }}>Reload (drop my edit)</Button>
            <Button variant="outline" size="sm" onClick={actions.keepMine}>Keep mine</Button>
          </div>
        </div>
      )}
      <textarea
        className="dish-prompts-textarea"
        value={draft}
        readOnly={readOnly}
        spellCheck={false}
        rows={16}
        aria-label={`Prompt text for ${roleLabel(role)}`}
        aria-describedby="dish-prompts-edit-help"
        onChange={(event) => { actions.edit(event.target.value) }}
        onKeyDown={onKeyDown}
      />
      <div id="dish-prompts-edit-help" className="dish-prompts-stack">
        {unknownVariables.length > 0 && (
          <Note tone="warn">
            Unknown {unknownVariables.length === 1 ? 'variable' : 'variables'}: <VariableNames names={unknownVariables} />.
            {' '}{unknownVariables.length === 1 ? 'It has' : 'They have'} no value, so {unknownVariables.length === 1 ? 'it stays' : 'they stay'} as
            written in the prompt. You can still save.
          </Note>
        )}
        <details className="dish-prompts-details">
          <summary>Variables you can use</summary>
          {variables.status === 'loading' && <p className="dish-prompts-muted">Loading…</p>}
          {variables.status === 'error' && <p className="dish-prompts-muted">The variables couldn't be read, so names aren't checked.</p>}
          {variables.status === 'ready' && variables.fallback && (
            <p className="dish-prompts-muted">dsh's own system prompt couldn't be read, so the variables aren't known and names aren't checked.</p>
          )}
          {variables.status === 'ready' && !variables.fallback && (
            <ul className="dish-prompts-variables">
              {variables.list.map(variable => (
                <li key={variable.name}>
                  <VariableName name={variable.name} />
                  <span className="dish-prompts-muted">{variable.value === '' ? 'filled in for each agent' : variable.value}</span>
                </li>
              ))}
            </ul>
          )}
        </details>
      </div>
      <label className="dish-prompts-field">
        <span className="dish-prompts-label">Note (optional)</span>
        <Input
          className="dish-prompts-note-input"
          value={note}
          maxLength={200}
          placeholder="Why you're changing it. It goes in the history."
          readOnly={frozen}
          onChange={(event) => { actions.setNote(event.target.value) }}
        />
      </label>
      <div className="dish-prompts-actions">
        <Button variant="primary" size="sm" disabled={cannotSave} onClick={() => { void actions.save() }}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
        <Button variant="outline" size="sm" disabled={!dirty || busy !== undefined} onClick={actions.discard}>Discard</Button>
        {dirty && <span className="dish-prompts-muted">Unsaved changes</span>}
      </div>
    </div>
  )
}
