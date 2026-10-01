/**
 * The thresholds card: a form over `judge.yaml`, saved as you with a base and a conflict check; and, with dish-config's remote,
 * the file's History. What is a valid value is the server's to say: Save sends what is typed and shows its message when it
 * refuses. The warnings are advice that never blocks a save.
 */

import { useMemo } from 'react'
import type { FormEvent, KeyboardEvent, ReactNode } from 'react'
import { Button, Input, SegmentedTabs } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SegmentedTab } from '@deepseek-ai/dsh-client-ui-primitives'
import { DiffView, unifiedDiff } from 'dish-kit/ui'
import { DOCUMENT, canSave, thresholdTabs } from './controller.ts'
import type { JudgeActions, PageState, ThresholdTab } from './controller.ts'
import { HistoryTab } from './HistoryTab.tsx'
import { LoadError, NoticeBar, Note } from './parts.tsx'
import type { FieldName } from './thresholds.ts'

type Actions = Omit<JudgeActions, 'hooks'>

const TAB_LABEL: Record<ThresholdTab, string> = { edit: 'Settings', history: 'History' }

export function ThresholdsCard({ state, actions }: { state: PageState, actions: Actions }) {
  const { thresholds } = state
  const tabs = thresholdTabs(state)
  const tab = tabs.includes(thresholds.tab) ? thresholds.tab : 'edit'
  const items = tabs.map(next => ({
    value: next,
    label: <span className="dish-judge-tab-label">{TAB_LABEL[next]}</span>,
    id: `dish-judge-tab-${next}`,
    panelId: 'dish-judge-panel',
  })) as [SegmentedTab<ThresholdTab>, ...Array<SegmentedTab<ThresholdTab>>]
  return (
    <section className="dish-judge-card" aria-labelledby="dish-judge-thresholds-title">
      <div className="dish-judge-card-head">
        <h3 className="dish-judge-card-title" id="dish-judge-thresholds-title">
          Thresholds
          <code className="dish-judge-code">{DOCUMENT}</code>
        </h3>
      </div>
      <p className="dish-judge-muted">
        When the judge lets a command run, and when it withholds a result. A change applies to the judge's next call. Agents can't
        see or change this file.
      </p>
      {thresholds.notice !== undefined && <NoticeBar notice={thresholds.notice} dismiss={actions.dismissThresholdsNotice} />}
      {thresholds.load === 'loading' && thresholds.saved === undefined && <p className="dish-judge-muted">Loading…</p>}
      {thresholds.load === 'error' && thresholds.loadError !== undefined && thresholds.saved === undefined && (
        <LoadError notice={thresholds.loadError} retry={() => { void actions.reload() }} />
      )}
      {thresholds.saved !== undefined && (
        <>
          {tabs.length > 1 && (
            <SegmentedTabs
              className="dish-judge-tabs"
              label="Thresholds views"
              value={tab}
              onChange={(next) => { void actions.setTab(next) }}
              items={items}
            />
          )}
          <div role="tabpanel" id="dish-judge-panel" aria-labelledby={`dish-judge-tab-${tab}`}>
            {tab === 'edit' && <Form state={state} actions={actions} />}
            {tab === 'history' && <HistoryTab state={state} actions={actions} />}
          </div>
        </>
      )}
    </section>
  )
}

/** A labelled text or number field of the form. */
function Field({ name, label, hint, value, readOnly, actions, numeric }: {
  name: FieldName
  label: string
  hint?: string
  value: string
  readOnly: boolean
  actions: Actions
  numeric?: boolean
}) {
  const id = `dish-judge-field-${name}`
  return (
    <div className="dish-judge-field">
      <label className="dish-judge-label" htmlFor={id}>{label}</label>
      <Input
        id={id}
        className="dish-judge-input"
        type={numeric === true ? 'number' : 'text'}
        {...(numeric === true ? { inputMode: 'decimal' as const, step: 'any' } : { spellCheck: false })}
        autoComplete="off"
        value={value}
        readOnly={readOnly}
        aria-describedby={hint === undefined ? undefined : `${id}-hint`}
        onChange={(event) => { actions.editField(name, event.target.value) }}
      />
      {hint !== undefined && <span className="dish-judge-muted" id={`${id}-hint`}>{hint}</span>}
    </div>
  )
}

/** A list of tool names, one to a line. */
function ToolsField({ name, label, hint, value, readOnly, actions }: { name: FieldName, label: string, hint: ReactNode, value: string, readOnly: boolean, actions: Actions }) {
  const id = `dish-judge-field-${name}`
  return (
    <div className="dish-judge-field">
      <label className="dish-judge-label" htmlFor={id}>{label}</label>
      <textarea
        id={id}
        className="dish-judge-native dish-judge-textarea"
        value={value}
        readOnly={readOnly}
        spellCheck={false}
        rows={Math.max(3, value.split('\n').length + 1)}
        aria-describedby={`${id}-hint`}
        onChange={(event) => { actions.editField(name, event.target.value) }}
      />
      <span className="dish-judge-muted" id={`${id}-hint`}>{hint}</span>
    </div>
  )
}

function Form({ state, actions }: { state: PageState, actions: Actions }) {
  const { thresholds } = state
  const { form, saved, conflict, busy, readOnly, dirty, warnings, missing, problem, note } = thresholds
  const frozen = readOnly || busy !== undefined
  const saving = busy === 'save'
  const savable = canSave(thresholds)
  const underneath = useMemo(
    () => (conflict === undefined || saved === undefined ? undefined : unifiedDiff(DOCUMENT, saved.text, conflict.text)),
    [conflict, saved],
  )
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (savable) void actions.save()
  }
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    // The save shortcut an editor has; the browser's own (save the page) is no use here.
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault()
      if (savable) void actions.save()
    }
  }
  return (
    <form className="dish-judge-stack" onSubmit={submit} onKeyDown={onKeyDown} noValidate autoComplete="off">
      {readOnly && (
        <Note tone="warn">The config store isn't running, so these are the shipped values and can't be changed. Start dish-config to edit them.</Note>
      )}
      {missing && !readOnly && <Note>judge.yaml isn't in the store, so the shipped values are in use. Saving adds it.</Note>}
      {problem !== undefined && (
        <Note tone="warn">
          The judge.yaml in the store doesn't pass the check, so the judge is using the shipped values until it is replaced: {problem}. Saving
          what is below replaces it.
        </Note>
      )}
      {conflict !== undefined && (
        <div className="dish-judge-conflict" role="alert">
          <p className="dish-judge-text">
            <strong>judge.yaml changed while you were editing it.</strong> Your values are still below. Saving now would replace the change
            shown here.
          </p>
          {underneath !== undefined && <DiffView diffs={[underneath]} />}
          <div className="dish-judge-actions">
            <Button variant="primary" size="sm" type="button" onClick={() => { void actions.reload() }}>Reload (drop my edit)</Button>
            <Button variant="outline" size="sm" type="button" onClick={actions.keepMine}>Keep mine</Button>
          </div>
        </div>
      )}
      {warnings.map(warning => <Note key={warning} tone="warn">{warning}</Note>)}

      <fieldset className="dish-judge-group">
        <legend>Commands</legend>
        <div className="dish-judge-columns">
          <Field name="readOnly" label="Read-only at" hint="P(read-only) at or above this runs the command." value={form.readOnly} readOnly={frozen} actions={actions} numeric />
          <Field name="reversible" label="Reversible at" hint="P(read-only) + P(reversible) at or above this runs it." value={form.reversible} readOnly={frozen} actions={actions} numeric />
          <Field name="servesTask" label="Serves the task at" hint="Below this a command never runs on the judge's say-so." value={form.servesTask} readOnly={frozen} actions={actions} numeric />
        </div>
      </fieldset>

      <fieldset className="dish-judge-group">
        <legend>Screening results</legend>
        <div className="dish-judge-columns">
          <Field name="withhold" label="Withhold at" hint="P(injected instructions) at or above this withholds the result." value={form.withhold} readOnly={frozen} actions={actions} numeric />
          <Field name="warn" label="Warn at" hint="From here up to Withhold, the result is kept with a warning." value={form.warn} readOnly={frozen} actions={actions} numeric />
          <Field name="chunkChars" label="Chunk size (characters)" hint="Longer results are screened in chunks." value={form.chunkChars} readOnly={frozen} actions={actions} numeric />
        </div>
      </fieldset>

      <fieldset className="dish-judge-group">
        <legend>The judge</legend>
        <div className="dish-judge-columns dish-judge-columns-2">
          <Field name="model" label="Model" hint="Pinned: the thresholds were set against it." value={form.model} readOnly={frozen} actions={actions} />
          <Field name="timeoutMs" label="Time limit (milliseconds)" hint="A call that takes longer is treated as unavailable." value={form.timeoutMs} readOnly={frozen} actions={actions} numeric />
        </div>
      </fieldset>

      <fieldset className="dish-judge-group">
        <legend>Tools</legend>
        <div className="dish-judge-columns dish-judge-columns-2">
          <ToolsField
            name="gated"
            label="Gated: the judge checks each call"
            hint={<>One name to a line, or a prefix ending in <code className="dish-judge-code">*</code>. Keep <code className="dish-judge-code">bash</code> here.</>}
            value={form.gated}
            readOnly={frozen}
            actions={actions}
          />
          <ToolsField
            name="screened"
            label="Screened: results checked for injected instructions"
            hint={<>One name to a line, or a prefix such as <code className="dish-judge-code">mcp__*</code>.</>}
            value={form.screened}
            readOnly={frozen}
            actions={actions}
          />
        </div>
      </fieldset>

      <label className="dish-judge-field">
        <span className="dish-judge-label">Note (optional)</span>
        <Input
          className="dish-judge-input"
          value={note}
          maxLength={200}
          placeholder="Why you're changing it. It goes in the history."
          readOnly={frozen}
          onChange={(event) => { actions.setNote(event.target.value) }}
        />
      </label>
      <div className="dish-judge-actions">
        <Button variant="primary" size="sm" type="submit" disabled={!savable}>{saving ? 'Saving…' : 'Save'}</Button>
        <Button variant="outline" size="sm" type="button" disabled={!dirty || busy !== undefined} onClick={actions.discard}>Discard</Button>
        {dirty && <span className="dish-judge-muted">Unsaved changes</span>}
      </div>
    </form>
  )
}
