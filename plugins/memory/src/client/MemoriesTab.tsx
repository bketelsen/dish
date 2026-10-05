/**
 * The Memories tab's list: the held memories first, each with why it is held, **Release** and **Delete**; then the rest, each
 * with its name, type, description and how long ago it was modified, and a button that opens it in the editor; and **New**.
 */

import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MemoryInfo } from '../protocol.ts'
import type { MemoryActions, PageState } from './controller.ts'
import { idOf, modifiedText } from './format.ts'
import { Confirm, LoadError } from './parts.tsx'

type Actions = Omit<MemoryActions, 'hooks'>

/** What the person is asked before a memory is deleted, from the list or the editor. */
export function forgetQuestion(id: string): string {
  return `Delete ${id}? Agents stop seeing it at their next compaction or chat.`
}

export function MemoriesTab({ state, now, actions }: { state: PageState, now: number, actions: Actions }) {
  const { memories, errors } = state
  const held = memories?.filter(memory => memory.held !== undefined) ?? []
  const rest = memories?.filter(memory => memory.held === undefined) ?? []
  return (
    <div className="dish-memory-stack">
      {errors.memories !== undefined && <LoadError notice={errors.memories} retry={() => { void actions.open() }} />}
      <div className="dish-memory-actions">
        <Button variant="primary" size="sm" onClick={() => { void actions.newMemory() }}>New</Button>
      </div>
      {memories === undefined && errors.memories === undefined && <p className="dish-memory-muted">Loading…</p>}
      {held.length > 0 && (
        <section className="dish-memory-stack" aria-label="Held for your review">
          <h3 className="dish-memory-subtitle">Held for your review</h3>
          <p className="dish-memory-muted">
            An agent saved these, and Jev read them as instructions aimed at an agent. No agent sees them until you release them.
          </p>
          <ul className="dish-memory-list">
            {held.map(memory => <HeldRow key={memory.name} memory={memory} state={state} now={now} actions={actions} />)}
          </ul>
        </section>
      )}
      {memories !== undefined && memories.length === 0 && (
        <p className="dish-memory-muted">No memories in this scope yet. Agents save them with remember, or New adds one.</p>
      )}
      {rest.length > 0 && (
        <ul className="dish-memory-list">
          {rest.map(memory => (
            <li key={memory.name} className="dish-memory-card">
              <MemoryButton memory={memory} now={now} open={() => { void actions.openMemory(memory.name) }} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** A memory as the list shows it, as a button that opens it. */
function MemoryButton({ memory, now, open }: { memory: MemoryInfo, now: number, open: () => void }) {
  return (
    <button type="button" className="dish-memory-row" onClick={open}>
      <span className="dish-memory-row-head">
        <span className="dish-memory-name">{memory.name}</span>
        <Tag tone="neutral">{memory.type}</Tag>
        <span className="dish-memory-muted">{modifiedText(memory.modified, now)}</span>
      </span>
      <span className="dish-memory-description">{memory.description}</span>
    </button>
  )
}

/** A held memory: what the list shows of any, why it is held, and Release and Delete (which asks first). */
function HeldRow({ memory, state, now, actions }: { memory: MemoryInfo, state: PageState, now: number, actions: Actions }) {
  const { asking, busy } = state
  const id = idOf(state.scope ?? 'user', memory.name)
  const confirming = asking?.kind === 'forget' && asking.name === memory.name
  return (
    <li className="dish-memory-card dish-memory-card-held">
      <MemoryButton memory={memory} now={now} open={() => { void actions.openMemory(memory.name) }} />
      <p className="dish-memory-reason">{memory.held}</p>
      {confirming
        ? (
            <Confirm
              label="Confirm the delete"
              text={forgetQuestion(id)}
              action={['Delete', 'Deleting…']}
              working={busy === 'forget'}
              disabled={busy !== undefined}
              confirm={() => { void actions.confirm() }}
              cancel={actions.cancel}
            />
          )
        : (
            <div className="dish-memory-actions">
              <Button variant="primary" size="sm" disabled={busy !== undefined} onClick={() => { void actions.release(memory.name) }}>
                {busy === 'release' ? 'Releasing…' : 'Release'}
              </Button>
              <Button variant="outline" size="sm" disabled={busy !== undefined} onClick={() => { actions.forget(memory.name) }}>Delete</Button>
            </div>
          )}
    </li>
  )
}
