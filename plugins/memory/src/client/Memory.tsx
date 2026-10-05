/**
 * Settings → Memory: the scopes on the left (a select on a narrow page), and for the one shown its memories and the editor,
 * a family's direction, the scope's history, and the message an agent working there gets now. The vault's remote line sits
 * above them.
 *
 * `Memory` is the section's owner: it reads the page's state through the slot's `usePage` hook, opens the page when it is
 * shown, and keeps the clock that words "5 min ago". Everything it shows is `MemoryPage`, a plain function of the state, and
 * the views under it are too (`MemoriesTab.tsx`, `MemoryEditor.tsx`, `DirectionTab.tsx`, `HistoryTab.tsx`, `PreviewTab.tsx`),
 * so a test renders every one of them under Node from a state fixture.
 */

import { useEffect, useState } from 'react'
import { Button, SegmentedTabs, type SegmentedTab } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { ScopeInfo, ScopeKey } from '../protocol.ts'
import { directionDirty, memoryDirty, visibleTabs } from './controller.ts'
import type { MemoryActions, PageState, Tab } from './controller.ts'
import { DirectionTab } from './DirectionTab.tsx'
import { familyOf, idOf, scopeOptionText } from './format.ts'
import { HistoryTab } from './HistoryTab.tsx'
import { MemoriesTab } from './MemoriesTab.tsx'
import { MemoryEditor } from './MemoryEditor.tsx'
import { LoadError, NoticeBar, RemoteLine } from './parts.tsx'
import { PreviewTab } from './PreviewTab.tsx'

type Props = SettingsSectionOwnerProps & InjectFace<MemoryActions>

type Actions = Omit<MemoryActions, 'hooks'>

const TAB_LABEL: Record<Tab, string> = { memories: 'Memories', direction: 'Direction', history: 'History', preview: 'Preview' }

/** How often the page re-words "5 min ago". */
const TICK_MS = 30_000

/** The time now, as of the last tick. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => { setNow(Date.now()) }, TICK_MS)
    return () => { clearInterval(timer) }
  }, [])
  return now
}

export function Memory(props: Props) {
  const { usePage, open } = props
  const state = usePage(page => page)
  const now = useNow()
  useEffect(() => { void open() }, [open])
  return <MemoryPage state={state} now={now} actions={props} />
}

export function MemoryPage({ state, now, actions }: { state: PageState, now: number, actions: Actions }) {
  const { scopes, scope, notice, errors } = state
  return (
    <div className="dish-memory">
      <h2 className="dish-memory-title">Memory</h2>
      <p className="dish-memory-intro">
        What dish's agents keep between chats. Your memory reaches every main agent; a family's reaches every agent working in its
        repos. Agents save memories with remember; you can edit, delete, release and revert them here.
      </p>
      <RemoteLine remote={state.remote} stream={state.stream} />
      {notice !== undefined && <NoticeBar notice={notice} dismiss={actions.dismiss} />}
      {state.asking?.kind === 'discard' && <DiscardBox state={state} actions={actions} />}
      {errors.scopes !== undefined && <LoadError notice={errors.scopes} retry={() => { void actions.open() }} />}
      <div className="dish-memory-layout">
        <ScopeList scopes={scopes} scope={scope} select={(key) => { void actions.selectScope(key) }} />
        {scope !== undefined && (
          <div className="dish-memory-main">
            <ScopeView state={state} scope={scope} now={now} actions={actions} />
          </div>
        )}
      </div>
    </div>
  )
}

/** "You", then each family, with its count, a dot when some are held, and an orphan marked: a list on a wide page, a select on a narrow one. */
function ScopeList({ scopes, scope, select }: { scopes: ScopeInfo[] | undefined, scope: ScopeKey | undefined, select: (key: ScopeKey) => void }) {
  if (scopes === undefined) return <p className="dish-memory-muted dish-memory-scopes">Loading…</p>
  return (
    <>
      <nav className="dish-memory-scopes" aria-label="Scopes">
        <ul className="dish-memory-scope-list">
          {scopes.map(item => (
            <li key={item.key}>
              <button
                type="button"
                className="dish-memory-scope"
                aria-current={item.key === scope ? 'true' : undefined}
                onClick={() => { select(item.key) }}
              >
                <span className="dish-memory-scope-name">
                  {item.label}
                  {item.orphan && <span className="dish-memory-muted"> (no projects)</span>}
                </span>
                {item.held > 0 && (
                  <span className="dish-memory-dot" title={`${item.held} held for your review`}>
                    <span className="dish-memory-sr">{item.held} held for your review</span>
                  </span>
                )}
                <span className="dish-memory-count-badge">{item.count}</span>
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <select
        className="dish-memory-scope-select"
        aria-label="Scope"
        value={scope ?? ''}
        onChange={(event) => { select(event.target.value) }}
      >
        {scope === undefined && <option value="" disabled>Choose a scope</option>}
        {scopes.map(item => <option key={item.key} value={item.key}>{scopeOptionText(item)}</option>)}
      </select>
    </>
  )
}

/** The scope shown: its heading, the tabs, and the tab shown. */
function ScopeView({ state, scope, now, actions }: { state: PageState, scope: ScopeKey, now: number, actions: Actions }) {
  const tabs = visibleTabs(scope)
  const tab = tabs.includes(state.tab) ? state.tab : 'memories'
  const family = familyOf(scope)
  const label = state.scopes?.find(item => item.key === scope)?.label ?? (family ?? 'You')
  const items = tabs.map(tabItem) as [SegmentedTab<Tab>, ...Array<SegmentedTab<Tab>>]
  return (
    <div className="dish-memory-stack">
      <div className="dish-memory-heading">
        <h3 className="dish-memory-scope-title">{label}</h3>
        <code className="dish-memory-path">{family === undefined ? 'user/' : `families/${family}/`}</code>
      </div>
      <p className="dish-memory-muted">
        {family === undefined
          ? 'Your memory: what every main agent knows about you and how you like to work.'
          : `The ${family} family's memory: what every agent working in its repos knows about the work.`}
      </p>
      <SegmentedTabs className="dish-memory-tabs" label="Memory views" value={tab} onChange={(next) => { void actions.setTab(next) }} items={items} />
      <div role="tabpanel" id="dish-memory-panel" aria-labelledby={`dish-memory-tab-${tab}`}>
        {tab === 'memories' && (state.open === undefined
          ? <MemoriesTab state={state} now={now} actions={actions} />
          : <MemoryEditor state={state} open={state.open} actions={actions} />)}
        {tab === 'direction' && <DirectionTab state={state} actions={actions} />}
        {tab === 'history' && <HistoryTab state={state} now={now} actions={actions} />}
        {tab === 'preview' && <PreviewTab state={state} actions={actions} />}
      </div>
    </div>
  )
}

function tabItem(tab: Tab): SegmentedTab<Tab> {
  return { value: tab, label: <span className="dish-memory-tab-label">{TAB_LABEL[tab]}</span>, id: `dish-memory-tab-${tab}`, panelId: 'dish-memory-panel' }
}

/** Asked before an edit is thrown away: which edits, and the two answers. */
function DiscardBox({ state, actions }: { state: PageState, actions: Actions }) {
  const { open, direction, scope } = state
  const what: string[] = []
  if (open !== undefined && memoryDirty(open)) what.push(open.memory === undefined ? 'a new memory' : idOf(scope ?? 'user', open.memory.name))
  if (direction !== undefined && directionDirty(direction)) what.push(`the direction for ${direction.info.family}`)
  return (
    <div className="dish-memory-confirm" role="group" aria-label="Unsaved changes">
      <p className="dish-memory-text">You have unsaved changes{what.length === 0 ? '' : ` to ${what.join(' and ')}`}. Discard them?</p>
      <div className="dish-memory-actions">
        <Button variant="primary" size="sm" onClick={() => { void actions.confirm() }}>Discard</Button>
        <Button variant="ghost" size="sm" onClick={actions.cancel}>Keep editing</Button>
      </div>
    </div>
  )
}
