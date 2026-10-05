/**
 * The Direction tab, for a family: its direction in a monospace editor (the template when there is none yet), the note a save
 * carries, **Save** and **Discard**, how many agents' proposals wait on the History page, and after a conflict what changed
 * underneath, with the two ways out of it.
 */

import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { DIRECTION_MAX } from '../protocol.ts'
import { directionDirty } from './controller.ts'
import type { MemoryActions, PageState } from './controller.ts'
import { characters, familyOf } from './format.ts'
import { ConflictBox, LoadError, Note } from './parts.tsx'

type Actions = Omit<MemoryActions, 'hooks'>

export function DirectionTab({ state, actions }: { state: PageState, actions: Actions }) {
  const { direction, errors, busy } = state
  const family = familyOf(state.scope) ?? ''
  if (direction === undefined) {
    return errors.direction !== undefined
      ? <LoadError notice={errors.direction} retry={() => { void actions.reloadDirection() }} />
      : <p className="dish-memory-muted">Loading…</p>
  }
  const { info, draft, note, conflict } = direction
  const dirty = directionDirty(direction)
  const cannotSave = !dirty || busy !== undefined || conflict !== undefined
  const waiting = info.pendingProposals
  return (
    <div className="dish-memory-stack">
      <p className="dish-memory-muted">
        What agents working in {family}'s repos aim for: each gets it at the top of its memory message, written by you. Agents can only
        propose changes to it.
      </p>
      {info.missing && <Note>No direction yet: this is the template. Saving adds it.</Note>}
      {waiting > 0 && (
        <Note tone="warn">
          {waiting === 1 ? '1 proposal' : `${waiting} proposals`} waiting on the History page: accept or reject {waiting === 1 ? 'it' : 'them'} in
          Settings → History → Proposals.
        </Note>
      )}
      {errors.direction !== undefined && <LoadError notice={errors.direction} retry={() => { void actions.reloadDirection() }} />}
      {conflict !== undefined && (
        <ConflictBox
          title="The direction changed while you were editing it."
          diff={conflict.diff}
          reload={() => { void actions.reloadDirection() }}
          keepMine={() => { actions.keepMine('direction') }}
        >
          <pre className="dish-memory-theirs" tabIndex={0} aria-label="What it says now">{conflict.theirs}</pre>
        </ConflictBox>
      )}
      <textarea
        className="dish-memory-textarea dish-memory-textarea-tall"
        value={draft}
        rows={18}
        spellCheck={false}
        aria-label={`The direction for ${family}`}
        onChange={(event) => { actions.editDirection(event.target.value) }}
      />
      <span className={characters(draft) > DIRECTION_MAX ? 'dish-memory-count dish-memory-count-over' : 'dish-memory-count'}>
        {characters(draft)}/{DIRECTION_MAX}
      </span>
      <label className="dish-memory-field">
        <span className="dish-memory-label">Note (optional)</span>
        <Input
          className="dish-memory-input"
          value={note}
          maxLength={200}
          placeholder="Why you're changing it. It goes in the history."
          onChange={(event) => { actions.setDirectionNote(event.target.value) }}
        />
      </label>
      <div className="dish-memory-actions">
        <Button variant="primary" size="sm" disabled={cannotSave} onClick={() => { void actions.saveDirection() }}>
          {busy === 'direction' ? 'Saving…' : 'Save'}
        </Button>
        <Button variant="outline" size="sm" disabled={!dirty || busy !== undefined} onClick={() => { void actions.reloadDirection() }}>Discard</Button>
        {dirty && <span className="dish-memory-muted">Unsaved changes</span>}
      </div>
    </div>
  )
}
