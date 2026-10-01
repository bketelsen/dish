/**
 * Settings → Prompts: the roles on the left (a select on a narrow screen), and for the one open its editor, how it differs
 * from the default, what the model would see, and its history.
 */

import { useEffect } from 'react'
import { Button, SegmentedTabs, type SegmentedTab } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { RoleInfo } from '../protocol.ts'
import { DefaultTab } from './DefaultTab.tsx'
import { Editor } from './Editor.tsx'
import { visibleTabs, type PageState, type PromptsActions, type Tab } from './controller.ts'
import { roleLabel } from './format.ts'
import { HistoryTab } from './HistoryTab.tsx'
import { LoadError, NoticeBar } from './parts.tsx'
import { PreviewTab } from './PreviewTab.tsx'

type Props = SettingsSectionOwnerProps & InjectFace<PromptsActions>

type Actions = Omit<PromptsActions, 'hooks'>

const TAB_LABEL: Record<Tab, string> = { edit: 'Edit', default: 'Default', preview: 'Preview', history: 'History' }

export function Prompts(props: Props) {
  const { usePage, open } = props
  const state = usePage(page => page)
  useEffect(() => { void open() }, [open])
  const { roles, selected, notice, switching } = state

  return (
    <div className="dish-prompts">
      <h2 className="dish-prompts-title">Prompts</h2>
      <p className="dish-prompts-intro">
        What each agent role is told. An edit applies to agents that start after it: an agent already running keeps the prompt it
        began with.
      </p>
      {state.stream === 'down' && <p className="dish-prompts-muted">Live updates paused. Reconnecting…</p>}
      {notice !== undefined && <NoticeBar notice={notice} dismiss={props.dismiss} />}
      {switching !== undefined && (
        <div className="dish-prompts-confirm" role="group" aria-label="Unsaved changes">
          <p className="dish-prompts-text">
            You have unsaved changes{selected === undefined ? '' : ` to ${roleLabel(selected)}`}. Discard them and open {roleLabel(switching)}?
          </p>
          <div className="dish-prompts-actions">
            <Button variant="primary" size="sm" onClick={() => { void props.confirmSwitch() }}>Discard and open {roleLabel(switching)}</Button>
            <Button variant="ghost" size="sm" onClick={props.cancelSwitch}>Keep editing</Button>
          </div>
        </div>
      )}
      {state.rolesError !== undefined && <LoadError notice={state.rolesError} retry={() => { void open() }} />}
      {!state.rolesLoaded && state.rolesError === undefined && <p className="dish-prompts-muted">Loading…</p>}
      {roles.length > 0 && (
        <div className="dish-prompts-layout">
          <RoleList roles={roles} selected={selected} select={(role) => { void props.select(role) }} />
          {selected !== undefined && (
            <div className="dish-prompts-main">
              <RoleView state={state} role={roles.find(candidate => candidate.role === selected)} actions={props} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** Common and Main, then the crew roles under a heading of their own: a list on a wide screen, a select on a narrow one. */
function RoleList({ roles, selected, select }: { roles: RoleInfo[], selected: string | undefined, select: (role: string) => void }) {
  const shared = roles.filter(role => role.role === 'common' || role.role === 'main')
  const crew = roles.filter(role => role.role !== 'common' && role.role !== 'main')
  const item = (role: RoleInfo) => (
    <li key={role.role}>
      <button
        type="button"
        className="dish-prompts-role"
        aria-current={role.role === selected ? 'true' : undefined}
        onClick={() => { select(role.role) }}
      >
        <span className="dish-prompts-role-name">{roleLabel(role.role)}</span>
        {role.differsFromDefault && (
          <span className="dish-prompts-dot" title="Differs from the default">
            <span className="dish-prompts-sr">Differs from the default</span>
          </span>
        )}
        {role.pendingProposals > 0 && (
          <span className="dish-prompts-count" title={`${role.pendingProposals} waiting for a decision`}>
            {role.pendingProposals}
            <span className="dish-prompts-sr"> waiting for a decision</span>
          </span>
        )}
      </button>
    </li>
  )
  const optionText = (role: RoleInfo): string => {
    const marks = [role.differsFromDefault ? 'edited' : '', role.pendingProposals > 0 ? `${role.pendingProposals} waiting` : ''].filter(mark => mark !== '')
    return marks.length === 0 ? roleLabel(role.role) : `${roleLabel(role.role)} (${marks.join(', ')})`
  }
  return (
    <>
      <nav className="dish-prompts-roles" aria-label="Roles">
        <ul className="dish-prompts-role-list">{shared.map(item)}</ul>
        {crew.length > 0 && (
          <>
            <p className="dish-prompts-roles-heading">Crew</p>
            <ul className="dish-prompts-role-list">{crew.map(item)}</ul>
          </>
        )}
      </nav>
      <select
        className="dish-prompts-role-select"
        aria-label="Role"
        value={selected ?? ''}
        onChange={(event) => { select(event.target.value) }}
      >
        {selected === undefined && <option value="" disabled>Choose a role</option>}
        {roles.map(role => <option key={role.role} value={role.role}>{optionText(role)}</option>)}
      </select>
    </>
  )
}

/** The open role: its heading, the tabs, and the tab shown. */
function RoleView({ state, role, actions }: { state: PageState, role: RoleInfo | undefined, actions: Actions }) {
  const name = state.selected ?? ''
  const tabs = visibleTabs(state)
  const tab = tabs.includes(state.tab) ? state.tab : 'edit'
  const path = role?.path ?? name
  const items = tabs.map(next => tabItem(next)) as [SegmentedTab<Tab>, ...Array<SegmentedTab<Tab>>]
  return (
    <div className="dish-prompts-stack">
      <div className="dish-prompts-heading">
        <h3 className="dish-prompts-role-title">{roleLabel(name)}</h3>
        <code className="dish-prompts-path">{path}</code>
      </div>
      {role !== undefined && (
        <p className="dish-prompts-muted">
          {role.agent === 'propose'
            ? 'Agents can only propose changes to this prompt; you accept or reject them.'
            : 'Agents can edit this prompt directly.'}
        </p>
      )}
      {role !== undefined && role.pendingProposals > 0 && (
        <p className="dish-prompts-note dish-prompts-note-warn" role="note">
          {role.pendingProposals === 1 ? '1 proposal is' : `${role.pendingProposals} proposals are`} waiting for a decision. Accept or reject
          {role.pendingProposals === 1 ? ' it' : ' them'} in Settings → History → Proposals.
        </p>
      )}
      {state.document === 'loading' && <p className="dish-prompts-muted">Loading…</p>}
      {state.document === 'error' && state.documentError !== undefined && (
        <LoadError notice={state.documentError} retry={() => { void actions.reload() }} />
      )}
      {state.document === 'ready' && (
        <>
          <SegmentedTabs
            className="dish-prompts-tabs"
            label="Prompt views"
            value={tab}
            onChange={(next) => { void actions.setTab(next) }}
            items={items}
          />
          <div role="tabpanel" id="dish-prompts-panel" aria-labelledby={`dish-prompts-tab-${tab}`}>
            {tab === 'edit' && <Editor state={state} path={path} actions={actions} />}
            {tab === 'default' && <DefaultTab state={state} actions={actions} />}
            {tab === 'preview' && <PreviewTab state={state} actions={actions} />}
            {tab === 'history' && <HistoryTab state={state} path={path} actions={actions} />}
          </div>
        </>
      )}
    </div>
  )
}

function tabItem(tab: Tab): SegmentedTab<Tab> {
  return { value: tab, label: <span className="dish-prompts-tab-label">{TAB_LABEL[tab]}</span>, id: `dish-prompts-tab-${tab}`, panelId: 'dish-prompts-panel' }
}
