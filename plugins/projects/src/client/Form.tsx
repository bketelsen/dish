/**
 * The form for a new project or an edit: the six settings as text, the gate's environment as rows of a name and a value, the
 * optional note that becomes the commit's note, what the registry's check says underneath (a problem stops a save), **Save**
 * (Ctrl/Cmd+S) and **Cancel**, and, after a conflict, what changed underneath with the two ways out of it. The name is typed
 * for a new project and fixed for an edit.
 */

import type { KeyboardEvent, ReactNode } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { EnvRow, FieldKey, FormState, PageState, ProjectsActions } from './controller.ts'
import { changedFields } from './format.ts'
import { ChangeList, Note } from './parts.tsx'

type Actions = Omit<ProjectsActions, 'hooks'>

/** One labelled text field. */
function TextField(props: {
  id: string
  label: string
  hint?: ReactNode
  value: string
  placeholder?: string
  mono?: boolean
  wide?: boolean
  readOnly: boolean
  autoFocus?: boolean
  onChange: (value: string) => void
}) {
  const { id, label, hint, value, placeholder, mono = false, wide = false, readOnly, autoFocus = false, onChange } = props
  return (
    <div className={`dish-projects-field${wide ? ' dish-projects-wide' : ''}`}>
      <label className="dish-projects-label" htmlFor={id}>{label}</label>
      <Input
        id={id}
        className={`dish-projects-input${mono ? ' dish-projects-mono' : ''}`}
        value={value}
        readOnly={readOnly}
        spellCheck={false}
        autoComplete="off"
        autoFocus={autoFocus}
        placeholder={placeholder}
        aria-describedby={hint === undefined ? undefined : `${id}-hint`}
        onChange={(event) => { onChange(event.target.value) }}
      />
      {hint !== undefined && <span id={`${id}-hint`} className="dish-projects-muted">{hint}</span>}
    </div>
  )
}

export function Form({ state, form, actions }: { state: PageState, form: FormState, actions: Actions }) {
  const { busy, readOnly, conflict } = state
  const adding = form.mode === 'add'
  const saving = busy === 'save'
  const frozen = readOnly || busy !== undefined
  // After a conflict the way on is Reload or Keep mine: a save would be refused again. A problem would be refused by the registry too.
  const cannotSave = frozen || conflict !== undefined || form.problem !== null || (!adding && !form.dirty)
  const text = (key: FieldKey) => (value: string): void => { actions.editField(key, value) }
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    // The save shortcut an editor has; the browser's own (save the page) is no use here.
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault()
      if (!cannotSave) void actions.save()
    }
  }
  return (
    <form
      className="dish-projects-form"
      aria-label={adding ? 'New project' : `Edit ${form.name}`}
      onKeyDown={onKeyDown}
      onSubmit={(event) => { event.preventDefault(); if (!cannotSave) void actions.save() }}
    >
      <h3 className="dish-projects-form-title">{adding ? 'Add a project' : `Edit ${form.name}`}</h3>
      {readOnly && <Note tone="warn">The config store isn't running, so projects can't be changed. Start dish-config to save.</Note>}
      {conflict !== undefined && <ConflictPanel form={form} theirs={conflict.theirs} actions={actions} />}
      <div className="dish-projects-grid">
        <TextField
          id="dish-projects-name"
          label="Project"
          hint={adding ? 'The GitHub repository, as owner/repo.' : undefined}
          value={form.name}
          placeholder="owner/repo"
          wide
          mono
          readOnly={frozen || !adding}
          autoFocus={adding}
          onChange={text('name')}
        />
        <TextField id="dish-projects-family" label="Family" hint="Free text, as bketelsen or frostyard." value={form.fields.family} readOnly={frozen} onChange={text('family')} />
        <TextField id="dish-projects-role" label="Role" hint="What the project is, in a few words." value={form.fields.role} readOnly={frozen} onChange={text('role')} />
        <TextField
          id="dish-projects-gate"
          label="Gate"
          hint="The command that checks the project's work. It has to finish within the timeout beside it."
          value={form.fields.gate}
          mono
          wide
          readOnly={frozen}
          onChange={text('gate')}
        />
        <TextField
          id="dish-projects-gate-timeout"
          label="Gate timeout"
          hint="10s to 10m, as 90s or 10m."
          value={form.fields.gateTimeout}
          mono
          readOnly={frozen}
          onChange={text('gateTimeout')}
        />
        <TextField
          id="dish-projects-setup-timeout"
          label="Setup timeout (optional)"
          hint="10s to 1h. Left empty it is 15m."
          value={form.fields.setupTimeout}
          mono
          readOnly={frozen}
          onChange={text('setupTimeout')}
        />
        <TextField
          id="dish-projects-setup"
          label="Setup (optional)"
          hint="Run in a fresh clone when the project is onboarded, outside the sandbox. Skipped in a clone that is already there."
          value={form.fields.setup}
          placeholder="pnpm install --frozen-lockfile"
          mono
          wide
          readOnly={frozen}
          onChange={text('setup')}
        />
      </div>
      <EnvEditor rows={form.env} readOnly={frozen} edit={actions.editEnv} />
      <CheckPanel form={form} />
      <div className="dish-projects-field">
        <label className="dish-projects-label" htmlFor="dish-projects-note">Note (optional)</label>
        <Input
          id="dish-projects-note"
          className="dish-projects-input"
          value={form.note}
          maxLength={200}
          placeholder="Why you're changing it. It goes in the history."
          readOnly={frozen}
          onChange={(event) => { actions.setNote(event.target.value) }}
        />
      </div>
      <div className="dish-projects-actions">
        <Button type="submit" variant="primary" size="sm" disabled={cannotSave}>{saving ? 'Saving…' : 'Save'}</Button>
        <Button type="button" variant="outline" size="sm" disabled={busy !== undefined} onClick={actions.cancel}>Cancel</Button>
        {form.dirty && <span className="dish-projects-muted">Unsaved changes</span>}
      </div>
    </form>
  )
}

/** The gate's environment: a row for each variable, and a button for one more. */
function EnvEditor({ rows, readOnly, edit }: { rows: EnvRow[], readOnly: boolean, edit: (rows: EnvRow[]) => void }) {
  const change = (index: number, next: Partial<EnvRow>): void => {
    edit(rows.map((row, at) => at === index ? { ...row, ...next } : row))
  }
  return (
    <fieldset className="dish-projects-field">
      <legend className="dish-projects-label">Gate environment (optional)</legend>
      <div className="dish-projects-env-rows">
        {rows.map((row, index) => (
          // Rows have no identity but their place: a controlled input keeps what it is given.
          <div className="dish-projects-env-row" key={index}>
            <Input
              className="dish-projects-input dish-projects-mono"
              value={row.name}
              readOnly={readOnly}
              spellCheck={false}
              autoComplete="off"
              placeholder="NAME"
              aria-label={`Variable name, row ${index + 1}`}
              onChange={(event) => { change(index, { name: event.target.value }) }}
            />
            <Input
              className="dish-projects-input dish-projects-mono"
              value={row.value}
              readOnly={readOnly}
              spellCheck={false}
              autoComplete="off"
              placeholder="value"
              aria-label={`Value, row ${index + 1}`}
              onChange={(event) => { change(index, { value: event.target.value }) }}
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={readOnly}
              aria-label={`Remove variable ${row.name === '' ? `row ${index + 1}` : row.name}`}
              onClick={() => { edit(rows.filter((_, at) => at !== index)) }}
            >
              Remove
            </Button>
          </div>
        ))}
      </div>
      <div className="dish-projects-actions">
        <Button type="button" variant="outline" size="sm" disabled={readOnly} onClick={() => { edit([...rows, { name: '', value: '' }]) }}>
          Add variable
        </Button>
      </div>
      <span className="dish-projects-muted">
        Variables the gate runs with. A name starting DSH_ or containing KEY, PASSWORD, SECRET or TOKEN is refused: the registry is
        stored in plain text.
      </span>
    </fieldset>
  )
}

/** What the registry's check says of the form, under the fields: the problem that stops a save, or that it is being checked. */
function CheckPanel({ form }: { form: FormState }) {
  const { problem, checking, checkError } = form
  return (
    <div
      className={`dish-projects-check${checking && problem !== null ? ' dish-projects-check-stale' : ''}`}
      aria-live="polite"
      aria-busy={checking}
    >
      {problem !== null && <p className="dish-projects-problem"><span className="dish-projects-sr">Problem: </span>{problem}</p>}
      {problem === null && checkError === undefined && checking && <p className="dish-projects-muted">Checking…</p>}
      {checkError !== undefined && (
        <p className="dish-projects-muted">
          {checkError.text}{checkError.detail !== undefined && checkError.detail !== '' ? `: ${checkError.detail}` : ''}. The registry
          checks the settings again when you save.
        </p>
      )}
    </div>
  )
}

/** The registry has other settings for this project than the form was opened over: what changed, and the two ways on. */
function ConflictPanel({ form, theirs, actions }: { form: FormState, theirs: FormState['fields'], actions: Actions }) {
  const changes = changedFields(form.saved, theirs)
  return (
    <div className="dish-projects-conflict" role="alert">
      <p className="dish-projects-text">
        <strong>{form.mode === 'add' ? `${form.name.trim()} was added while you were filling this in.` : 'This project changed while you were editing it.'}</strong>{' '}
        Your settings are still below. Saving now would replace the change shown here.
      </p>
      {changes.length > 0 && <ChangeList changes={changes} />}
      <div className="dish-projects-actions">
        <Button type="button" variant="primary" size="sm" onClick={() => { void actions.reload() }}>Reload (drop my edit)</Button>
        <Button type="button" variant="outline" size="sm" onClick={actions.keepMine}>Keep mine</Button>
      </div>
    </div>
  )
}
