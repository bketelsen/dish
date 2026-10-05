/**
 * The editor: a memory's name (fixed once saved), its type, its description (one line, counted to 150 characters) and its
 * body (monospace, counted in bytes); **Save**, **Delete** (which asks first) and the way back to the list. A held memory
 * says why, with **Release**. After a conflict it shows what changed underneath, with the two ways out of it.
 */

import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { BODY_MAX, DESCRIPTION_MAX, TYPES } from '../protocol.ts'
import type { MemoryType } from '../protocol.ts'
import { memoryDirty } from './controller.ts'
import type { MemoryActions, OpenMemory, PageState } from './controller.ts'
import { byteLength, characters, idOf, memoryPathOf, memoryText } from './format.ts'
import { forgetQuestion } from './MemoriesTab.tsx'
import { Confirm, ConflictBox, Note } from './parts.tsx'

type Actions = Omit<MemoryActions, 'hooks'>

/** What each type is for, under the select: `remember`'s own words, shortened. */
const TYPE_HELP: Record<MemoryType, string> = {
  feedback: 'What you corrected or confirmed about how to work, with Why: and How to apply: lines.',
  user: 'Who you are and how you like to work.',
  project: 'A decision and its why, a deadline, a pitfall in this family\'s work.',
  reference: 'Where something lives outside the repos.',
}

export function MemoryEditor({ state, open, actions }: { state: PageState, open: OpenMemory, actions: Actions }) {
  const { busy, asking } = state
  const scope = state.scope ?? 'user'
  const { memory, draft, conflict } = open
  const id = memory === undefined ? undefined : idOf(scope, memory.name)
  const dirty = memoryDirty(open)
  // After a conflict the way on is Reload or Keep mine: a save would be refused again.
  const cannotSave = !dirty || busy !== undefined || conflict !== undefined
  const confirming = memory !== undefined && asking?.kind === 'forget' && asking.name === memory.name
  return (
    <div className="dish-memory-stack">
      <div className="dish-memory-heading">
        <h3 className="dish-memory-subtitle">{id ?? 'New memory'}</h3>
        {memory !== undefined && <code className="dish-memory-path">{memoryPathOf(scope, memory.name)}</code>}
      </div>
      {memory?.held !== undefined && (
        <div className="dish-memory-note dish-memory-note-warn" role="note">
          <p className="dish-memory-text">Held: {memory.held}</p>
          <p className="dish-memory-muted">
            No agent sees it until you release it. Saving it with its text unchanged keeps it held; changing the text releases it.
          </p>
          <div className="dish-memory-actions">
            <Button variant="outline" size="sm" disabled={busy !== undefined} onClick={() => { void actions.release(memory.name) }}>Release</Button>
          </div>
        </div>
      )}
      {conflict !== undefined && (
        <ConflictBox
          title={conflict.theirs === undefined ? 'It was deleted while you were editing it.' : 'This memory changed while you were editing it.'}
          diff={conflict.diff}
          reload={() => { void actions.reload() }}
          keepMine={() => { actions.keepMine() }}
        >
          {conflict.theirs === undefined
            ? <p className="dish-memory-muted">Keep mine saves your text as a new memory.</p>
            : <pre className="dish-memory-theirs" tabIndex={0} aria-label="What it says now">{memoryText(conflict.theirs)}</pre>}
        </ConflictBox>
      )}
      <label className="dish-memory-field">
        <span className="dish-memory-label">Name</span>
        <Input
          className="dish-memory-input"
          value={draft.name}
          readOnly={memory !== undefined}
          maxLength={64}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => { actions.edit('name', event.target.value) }}
        />
        {memory === undefined && (
          <span className="dish-memory-muted">Lowercase letters, digits and hyphens, starting with a letter or digit. It can't change once saved.</span>
        )}
      </label>
      <label className="dish-memory-field">
        <span className="dish-memory-label">Type</span>
        <select className="dish-memory-select" value={draft.type} onChange={(event) => { actions.edit('type', event.target.value) }}>
          {TYPES.map(type => <option key={type} value={type}>{type}</option>)}
        </select>
        <span className="dish-memory-muted">{TYPE_HELP[draft.type]}</span>
      </label>
      <label className="dish-memory-field">
        <span className="dish-memory-label">Description</span>
        <Input
          className="dish-memory-input"
          value={draft.description}
          placeholder="One line: what an agent reads in its list of memories."
          onChange={(event) => { actions.edit('description', event.target.value) }}
        />
        <span className={characters(draft.description) > DESCRIPTION_MAX ? 'dish-memory-count dish-memory-count-over' : 'dish-memory-count'}>
          {characters(draft.description)}/{DESCRIPTION_MAX}
        </span>
      </label>
      <label className="dish-memory-field">
        <span className="dish-memory-label">Body</span>
        <textarea
          className="dish-memory-textarea"
          value={draft.body}
          rows={12}
          spellCheck={false}
          onChange={(event) => { actions.edit('body', event.target.value) }}
        />
        <span className={byteLength(draft.body) > BODY_MAX ? 'dish-memory-count dish-memory-count-over' : 'dish-memory-count'}>
          {byteLength(draft.body)}/{BODY_MAX} bytes
        </span>
      </label>
      {memory === undefined && <Note>Saved as you, and not screened: your own memories reach agents as you write them.</Note>}
      <div className="dish-memory-actions">
        <Button variant="primary" size="sm" disabled={cannotSave} onClick={() => { void actions.save() }}>
          {busy === 'save' ? 'Saving…' : 'Save'}
        </Button>
        {memory !== undefined && (
          <Button variant="outline" size="sm" disabled={busy !== undefined || confirming} onClick={() => { actions.forget() }}>Delete</Button>
        )}
        <Button variant="ghost" size="sm" onClick={() => { void actions.closeMemory() }}>Back to the list</Button>
        {dirty && <span className="dish-memory-muted">Unsaved changes</span>}
      </div>
      {confirming && id !== undefined && (
        <Confirm
          label="Confirm the delete"
          text={forgetQuestion(id)}
          action={['Delete', 'Deleting…']}
          working={busy === 'forget'}
          disabled={busy !== undefined}
          confirm={() => { void actions.confirm() }}
          cancel={actions.cancel}
        />
      )}
    </div>
  )
}
