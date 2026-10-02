/**
 * The Edit tab: the skill's document in a monospace area with what the server's check says of it underneath (problems,
 * which stop a save, warnings, and a summary line), the optional note that becomes the commit's note, **Save** and
 * **Discard**, **Delete** for a skill you added, and, after a conflict, what changed underneath with the two ways out of it.
 */

import { useMemo, type KeyboardEvent } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { DiffView, unifiedDiff } from 'dish-kit/ui'
import type { PageState, SkillsActions } from './controller.ts'
import { summaryText } from './format.ts'
import { Note } from './parts.tsx'

type Actions = Omit<SkillsActions, 'hooks'>

export function Editor({ state, path, actions }: { state: PageState, path: string, actions: Actions }) {
  const { selected, saved, draft, note, dirty, busy, readOnly, missing, conflict, creating, shipped, check } = state
  const name = selected ?? ''
  const saving = busy === 'save'
  const frozen = readOnly || busy !== undefined
  const problems = check?.problems ?? []
  // After a conflict the way on is Reload or Keep mine: a save would be refused again. Problems would be refused by the store too.
  const cannotSave = !dirty || frozen || conflict !== undefined || problems.length > 0
  const underneath = useMemo(
    () => (conflict === undefined || saved === undefined ? undefined : unifiedDiff(path, saved.text, conflict.theirs)),
    [conflict, saved, path],
  )
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    // The save shortcut an editor has; the browser's own (save the page) is no use here.
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault()
      if (!cannotSave) void actions.save()
    }
  }
  return (
    <div className="dish-skills-stack" onKeyDown={onKeyDown}>
      {readOnly && (
        <Note tone="warn">
          The config store isn't running, so this is the shipped default and can't be changed. Start dish-config to edit skills.
        </Note>
      )}
      {creating && !readOnly && (
        <Note>A new skill. Nothing is stored until you save: replace the placeholders in the description and the body first.</Note>
      )}
      {missing && !readOnly && <Note>This skill isn't in the store, so the default is in use. Saving adds it.</Note>}
      {conflict !== undefined && (
        <div className="dish-skills-conflict" role="alert">
          <p className="dish-skills-text">
            <strong>This skill changed while you were editing it.</strong> Your text is still below. Saving now would replace the
            change shown here.
          </p>
          {underneath !== undefined && <DiffView diffs={[underneath]} />}
          <div className="dish-skills-actions">
            <Button variant="primary" size="sm" onClick={() => { void actions.reload() }}>Reload (drop my edit)</Button>
            <Button variant="outline" size="sm" onClick={actions.keepMine}>Keep mine</Button>
          </div>
        </div>
      )}
      <textarea
        className="dish-skills-textarea"
        value={draft}
        readOnly={readOnly}
        spellCheck={false}
        rows={20}
        aria-label={`Document for ${name}`}
        aria-describedby="dish-skills-check"
        onChange={(event) => { actions.edit(event.target.value) }}
      />
      <CheckPanel state={state} />
      <label className="dish-skills-field">
        <span className="dish-skills-label">Note (optional)</span>
        <Input
          className="dish-skills-note-input"
          value={note}
          maxLength={200}
          placeholder="Why you're changing it. It goes in the history."
          readOnly={frozen}
          onChange={(event) => { actions.setNote(event.target.value) }}
        />
      </label>
      <div className="dish-skills-actions">
        <Button variant="primary" size="sm" disabled={cannotSave} onClick={() => { void actions.save() }}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
        <Button variant="outline" size="sm" disabled={!dirty || busy !== undefined} onClick={actions.discard}>Discard</Button>
        {dirty && <span className="dish-skills-muted">Unsaved changes</span>}
      </div>
      {!creating && saved !== undefined && !shipped && <DeleteControl name={name} state={state} actions={actions} />}
      {shipped && !creating && (
        <p className="dish-skills-muted">
          A shipped skill can't be deleted: it comes back at the next start. To turn it off, set <code className="dish-skills-code">roles: []</code> in
          its frontmatter.
        </p>
      )}
    </div>
  )
}

/** What the server's check says of the draft, under the text: problems, warnings, and a summary of a valid document. */
function CheckPanel({ state }: { state: PageState }) {
  const { check, checking, checkError } = state
  const problems = check?.problems ?? []
  const warnings = check?.warnings ?? []
  return (
    <div
      id="dish-skills-check"
      className={`dish-skills-check${checking && check !== null ? ' dish-skills-check-stale' : ''}`}
      aria-live="polite"
      aria-busy={checking}
    >
      {problems.length > 0 && (
        <ul className="dish-skills-check-list dish-skills-problems">
          {problems.map(problem => <li key={problem}><span className="dish-skills-sr">Problem: </span>{problem}</li>)}
        </ul>
      )}
      {warnings.length > 0 && (
        <ul className="dish-skills-check-list dish-skills-warnings">
          {warnings.map(warning => <li key={warning}><span className="dish-skills-sr">Warning: </span>{warning}</li>)}
        </ul>
      )}
      {check?.summary != null && <p className="dish-skills-muted">{summaryText(check.summary)}</p>}
      {check === null && checkError === undefined && checking && <p className="dish-skills-muted">Checking…</p>}
      {check === null && checkError !== undefined && (
        <p className="dish-skills-muted">
          {checkError.text}{checkError.detail !== undefined && checkError.detail !== '' ? `: ${checkError.detail}` : ''}. The store checks the
          document again when you save.
        </p>
      )}
    </div>
  )
}

/** The button, and when it is pressed a question first: a delete is a commit, and the skill closes after it. */
function DeleteControl({ name, state, actions }: { name: string, state: PageState, actions: Actions }) {
  const { confirm, busy, dirty, hasHistory, readOnly } = state
  const working = busy === 'delete'
  if (confirm !== 'delete' && !working) {
    return (
      <div className="dish-skills-actions">
        <Button className="dish-skills-danger" variant="outline" size="sm" disabled={readOnly || busy !== undefined} onClick={actions.askDelete}>
          Delete
        </Button>
      </div>
    )
  }
  return (
    <div className="dish-skills-confirm" role="group" aria-label="Confirm the delete">
      <p className="dish-skills-text">
        Delete {name}? This adds a commit that removes it, so agents lose the skill at once. The text stays in the history
        {hasHistory ? ', and reverting that commit under Settings → History brings it back' : ''}.
        {dirty ? ' Your unsaved edit is dropped too.' : ''}
      </p>
      <div className="dish-skills-actions">
        <Button variant="primary" size="sm" disabled={readOnly || busy !== undefined} onClick={() => { void actions.remove() }}>
          {working ? 'Deleting…' : 'Delete'}
        </Button>
        <Button variant="ghost" size="sm" disabled={working} onClick={actions.cancelConfirm}>Cancel</Button>
      </div>
    </div>
  )
}
