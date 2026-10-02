/**
 * Settings → Skills: the skills on the left (a select on a narrow screen) with a name field above them for a new one, and for
 * the one open its editor, how it differs from the default, and its history.
 */

import { useEffect, useState, type FormEvent } from 'react'
import { Button, Input, SegmentedTabs, type SegmentedTab } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { SkillInfo } from '../protocol.ts'
import { DefaultTab } from './DefaultTab.tsx'
import { Editor } from './Editor.tsx'
import { visibleTabs, type PageState, type SkillsActions, type Tab } from './controller.ts'
import { optionText } from './format.ts'
import { HistoryTab } from './HistoryTab.tsx'
import { LoadError, NoticeBar, Note, OfferChips } from './parts.tsx'

type Props = SettingsSectionOwnerProps & InjectFace<SkillsActions>

type Actions = Omit<SkillsActions, 'hooks'>

const TAB_LABEL: Record<Tab, string> = { edit: 'Edit', default: 'Default', history: 'History' }

/** The path the store keeps a skill at, from the list when it has the skill. */
const pathOf = (skill: SkillInfo | undefined, name: string): string => skill?.path ?? `skills/${name}/SKILL.md`

export function Skills(props: Props) {
  const { usePage, open } = props
  const state = usePage(page => page)
  useEffect(() => { void open() }, [open])
  const { skills, selected, notice, switching, creating } = state
  // Without the list there is no telling what a name is up against, so there is nothing to show beside the error.
  const listed = state.listLoaded && (state.listError === undefined || skills.length > 0)
  // The store is not running (and the list did load): skills can be read and not saved, so a new one has no use.
  const storeless = state.listLoaded && state.listError === undefined && state.commit === ''

  return (
    <div className="dish-skills">
      <h2 className="dish-skills-title">Skills</h2>
      <p className="dish-skills-intro">
        What each agent role can load on demand. A change applies right away: agents see a new name or description at their next
        step, and a new body the next time they load the skill.
      </p>
      {state.stream === 'down' && <p className="dish-skills-muted">Live updates paused. Reconnecting…</p>}
      {notice !== undefined && <NoticeBar notice={notice} dismiss={props.dismiss} />}
      {switching !== undefined && (
        <div className="dish-skills-confirm" role="group" aria-label="Unsaved changes">
          <p className="dish-skills-text">
            You have unsaved changes{selected === undefined ? '' : ` to ${selected}`}. Discard them and{' '}
            {switching.create ? `start a new skill called ${switching.name}` : `open ${switching.name}`}?
          </p>
          <div className="dish-skills-actions">
            <Button variant="primary" size="sm" onClick={() => { void props.confirmSwitch() }}>
              Discard and {switching.create ? 'create' : 'open'} {switching.name}
            </Button>
            <Button variant="ghost" size="sm" onClick={props.cancelSwitch}>Keep editing</Button>
          </div>
        </div>
      )}
      {state.listError !== undefined && <LoadError notice={state.listError} retry={() => { void open() }} />}
      {!state.listLoaded && state.listError === undefined && <p className="dish-skills-muted">Loading…</p>}
      {listed && (
        <div className="dish-skills-layout">
          <div className="dish-skills-side">
            <NewSkill disabled={storeless} opened={state.creating ? selected : undefined} startNew={props.startNew} />
            {storeless && <p className="dish-skills-muted">The config store isn't running, so skills are read-only.</p>}
            <SkillList state={state} select={(name) => { void props.select(name) }} />
          </div>
          <div className="dish-skills-main">
            {selected !== undefined
              ? <SkillView state={state} skill={skills.find(candidate => candidate.name === selected)} actions={props} />
              : <p className="dish-skills-muted">
                {skills.length === 0 && !creating ? 'No skills yet. Name one on the left to start.' : 'Choose a skill to read or edit it.'}
              </p>}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * The name of a new skill, and the button that opens the editor on it. Nothing is stored until the editor's Save.
 * @param opened - the new skill the editor is open on, if any. The field is emptied when the editor opens on the name in it, and
 *   not before: a refused name stays to be fixed, and so does one that only asked about unsaved changes first ("Keep editing").
 */
function NewSkill({ disabled, opened, startNew }: { disabled: boolean, opened: string | undefined, startNew: (name: string) => Promise<boolean> }) {
  const [name, setName] = useState('')
  useEffect(() => {
    // Runs when the editor opens on a new skill, with the field as it is now.
    if (opened !== undefined && opened === name.trim()) setName('')
  }, [opened]) // eslint-disable-line react-hooks/exhaustive-deps
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    void startNew(name)
  }
  return (
    <form className="dish-skills-new" onSubmit={submit} aria-label="New skill">
      <Input
        className="dish-skills-new-input"
        value={name}
        disabled={disabled}
        spellCheck={false}
        autoComplete="off"
        placeholder="New skill name"
        aria-label="New skill name"
        onChange={(event) => { setName(event.target.value) }}
      />
      <Button type="submit" variant="outline" size="sm" disabled={disabled || name.trim() === ''}>Create</Button>
    </form>
  )
}

/** Every skill by name: a list on a wide screen, a select on a narrow one. */
function SkillList({ state, select }: { state: PageState, select: (name: string) => void }) {
  const { skills, selected, creating } = state
  const isNew = creating && selected !== undefined && !skills.some(skill => skill.name === selected)
  return (
    <>
      <nav className="dish-skills-items" aria-label="Skills">
        <ul className="dish-skills-item-list">
          {isNew && (
            <li>
              <div className="dish-skills-item" aria-current="true">
                <span className="dish-skills-item-name">{selected}</span>
                <span className="dish-skills-badge">new</span>
              </div>
            </li>
          )}
          {skills.map(skill => (
            <li key={skill.name}>
              <button
                type="button"
                className={`dish-skills-item${skill.missing ? ' dish-skills-item-missing' : ''}`}
                aria-current={skill.name === selected ? 'true' : undefined}
                title={skill.description === '' ? undefined : skill.description}
                onClick={() => { select(skill.name) }}
              >
                <span className="dish-skills-item-head">
                  <span className="dish-skills-item-name">{skill.name}</span>
                  {skill.differsFromDefault && (
                    <span className="dish-skills-dot" title="Differs from the default">
                      <span className="dish-skills-sr">Differs from the default</span>
                    </span>
                  )}
                  {!skill.shipped && <span className="dish-skills-badge">yours</span>}
                  {skill.pendingProposals > 0 && (
                    <span className="dish-skills-count" title={`${skill.pendingProposals} waiting for a decision`}>
                      {skill.pendingProposals}
                      <span className="dish-skills-sr"> waiting for a decision</span>
                    </span>
                  )}
                </span>
                <OfferChips skill={skill} />
                {skill.missing && <span className="dish-skills-muted">not in the store</span>}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <select
        className="dish-skills-select"
        aria-label="Skill"
        value={selected ?? ''}
        onChange={(event) => { select(event.target.value) }}
      >
        {selected === undefined && <option value="" disabled>Choose a skill</option>}
        {isNew && <option value={selected}>{selected} (new)</option>}
        {skills.map(skill => <option key={skill.name} value={skill.name}>{optionText(skill)}</option>)}
      </select>
    </>
  )
}

/** The open skill: its heading, notes, the tabs, and the tab shown. */
function SkillView({ state, skill, actions }: { state: PageState, skill: SkillInfo | undefined, actions: Actions }) {
  const name = state.selected ?? ''
  const tabs = visibleTabs(state)
  const tab = tabs.includes(state.tab) ? state.tab : 'edit'
  const path = pathOf(skill, name)
  const items = tabs.map(next => tabItem(next)) as [SegmentedTab<Tab>, ...Array<SegmentedTab<Tab>>]
  const waiting = skill?.pendingProposals ?? 0
  return (
    <div className="dish-skills-stack">
      <div className="dish-skills-heading">
        <h3 className="dish-skills-skill-title">{name}</h3>
        {state.creating && <span className="dish-skills-badge">new</span>}
        {!state.creating && !state.shipped && <span className="dish-skills-badge">yours</span>}
        <code className="dish-skills-path">{path}</code>
      </div>
      {skill !== undefined && skill.problem !== '' && (
        <Note tone="warn">
          This document doesn't parse, so no agent is offered it: {skill.problem}. Fix it below and save.
        </Note>
      )}
      {!state.creating && (
        <p className="dish-skills-muted">Agents can only propose changes to a skill; you accept or reject them.</p>
      )}
      {waiting > 0 && (
        <Note tone="warn">
          {waiting === 1 ? '1 proposal is' : `${waiting} proposals are`} waiting for a decision. Accept or reject
          {waiting === 1 ? ' it' : ' them'} in Settings → History → Proposals.
        </Note>
      )}
      {state.document === 'loading' && <p className="dish-skills-muted">Loading…</p>}
      {state.document === 'error' && state.documentError !== undefined && (
        <LoadError notice={state.documentError} retry={() => { void actions.reload() }} />
      )}
      {state.document === 'ready' && (
        <>
          {tabs.length > 1 && (
            <SegmentedTabs
              className="dish-skills-tabs"
              label="Skill views"
              value={tab}
              onChange={(next) => { void actions.setTab(next) }}
              items={items}
            />
          )}
          <div role={tabs.length > 1 ? 'tabpanel' : undefined} id="dish-skills-panel" aria-labelledby={tabs.length > 1 ? `dish-skills-tab-${tab}` : undefined}>
            {tab === 'edit' && <Editor state={state} path={path} actions={actions} />}
            {tab === 'default' && <DefaultTab state={state} actions={actions} />}
            {tab === 'history' && <HistoryTab state={state} path={path} actions={actions} />}
          </div>
        </>
      )}
    </div>
  )
}

function tabItem(tab: Tab): SegmentedTab<Tab> {
  return { value: tab, label: <span className="dish-skills-tab-label">{TAB_LABEL[tab]}</span>, id: `dish-skills-tab-${tab}`, panelId: 'dish-skills-panel' }
}
