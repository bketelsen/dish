/**
 * Settings → Projects: the projects on the left (a select on a narrow screen) with a button above them to add one, and for the
 * one open its status, settings and actions, or the form when one is being added or edited. Questions (remove a project, drop
 * unsaved edits) and the outcome of the last action are above the layout.
 */

import { useEffect, useRef, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { ProjectInfo } from '../protocol.ts'
import { canRetry } from './controller.ts'
import type { PageState, ProjectsActions } from './controller.ts'
import { Form } from './Form.tsx'
import { fetchText, optionText, retryHint, statusLine, thenText } from './format.ts'
import { LoadError, NoticeBar, Note, SkippedNote, StatusChip } from './parts.tsx'
import { STORE_MISSING, brokenFileText, proposalsText, removeQuestion } from './outcome.ts'

type Props = SettingsSectionOwnerProps & InjectFace<ProjectsActions>

type Actions = Omit<ProjectsActions, 'hooks'>

export function Projects(props: Props) {
  const { usePage, open, hide } = props
  const state = usePage(page => page)
  // Shown: read the list and keep its status fresh. Hidden: stop polling. (Not `props.close`: that is the shell's, which closes Settings.)
  useEffect(() => {
    void open()
    return () => { hide() }
  }, [open, hide])
  const { projects, selected, notice, form } = state
  // Without the list there is no telling what a name is up against, so there is nothing to show beside the error.
  const listed = state.listLoaded && (state.listError === undefined || projects.length > 0)
  const storeless = state.listLoaded && state.listError === undefined && state.readOnly
  const broken = state.problem !== null
  const current = projects.find(project => project.name === selected)

  return (
    <div className="dish-projects">
      <h2 className="dish-projects-title">Projects</h2>
      <p className="dish-projects-intro">
        The repositories dish works in. Adding one clones it (or adopts a clone already under the work root), runs its setup, and
        gives it a workspace in the sidebar. The list is projects.yaml in the config store: agents can propose changes to it, and
        you accept them on History.
      </p>
      {state.stream === 'down' && <p className="dish-projects-muted">Live updates paused. Reconnecting…</p>}
      {notice !== undefined && <NoticeBar notice={notice} dismiss={props.dismiss} />}
      <Question state={state} actions={props} />
      {state.problem !== null && <Note tone="error">{brokenFileText(state.problem)}</Note>}
      {state.pendingProposals > 0 && <Note tone="warn">{proposalsText(state.pendingProposals)}</Note>}
      {state.listError !== undefined && <LoadError notice={state.listError} retry={() => { void open() }} />}
      {!state.listLoaded && state.listError === undefined && <p className="dish-projects-muted">Loading…</p>}
      {listed && (
        <div className="dish-projects-layout">
          <div className="dish-projects-side">
            <Button
              className="dish-projects-add"
              variant="outline"
              size="sm"
              disabled={storeless || broken || state.busy !== undefined}
              onClick={() => { void props.startAdd() }}
            >
              Add a project
            </Button>
            {storeless && <p className="dish-projects-muted">{STORE_MISSING}</p>}
            <ProjectList state={state} select={props.select} />
          </div>
          <div className="dish-projects-main">
            {form !== null
              ? <Form state={state} form={form} actions={props} />
              : current !== undefined
                ? <ProjectView state={state} project={current} actions={props} />
                : <p className="dish-projects-muted">
                  {projects.length === 0
                    ? (broken ? 'No project is listed until projects.yaml parses.' : storeless ? 'Nothing to list until the config store runs.' : 'No projects yet. Add one to start.')
                    : 'Choose a project to see how it stands.'}
                </p>}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * The question about leaving a form with edits, if it is being asked. (The question about removing a project is asked where the
 * button was: `RemoveControl`.)
 */
function Question({ state, actions }: { state: PageState, actions: Actions }) {
  const { confirm, busy, form } = state
  if (confirm === null || confirm.kind !== 'discard') return null
  const editing = form === null || form.name.trim() === '' ? 'the new project' : form.name.trim()
  return (
    <div className="dish-projects-confirm" role="group" aria-label="Unsaved changes">
      <p className="dish-projects-text">You have unsaved changes to {editing}. Discard them and {thenText(confirm.then)}?</p>
      <div className="dish-projects-actions">
        <Button variant="primary" size="sm" disabled={busy !== undefined} onClick={() => { void actions.confirmDiscard() }}>Discard</Button>
        <Button variant="ghost" size="sm" onClick={actions.cancelConfirm}>Keep editing</Button>
      </div>
    </div>
  )
}

/** Every project by name: a list on a wide screen, a select on a narrow one. */
function ProjectList({ state, select }: { state: PageState, select: (name: string) => void }) {
  const { projects, selected } = state
  return (
    <>
      <nav className="dish-projects-items" aria-label="Projects">
        <ul className="dish-projects-item-list">
          {projects.map(project => (
            <li key={project.name}>
              <button
                type="button"
                className="dish-projects-item"
                aria-current={project.name === selected ? 'true' : undefined}
                title={project.fields.role}
                onClick={() => { select(project.name) }}
              >
                <span className="dish-projects-item-head">
                  <span className="dish-projects-item-name">{project.name}</span>
                  <StatusChip state={project.status.state} />
                </span>
                <span className="dish-projects-item-meta">
                  <span className="dish-projects-muted">{project.fields.family}</span>
                  {project.status.setupSkipped !== null && <span className="dish-projects-badge">setup skipped</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </nav>
      {projects.length > 0 && (
        <select
          className="dish-projects-select"
          aria-label="Project"
          value={selected ?? ''}
          onChange={(event) => { select(event.target.value) }}
        >
          {selected === undefined && <option value="" disabled>Choose a project</option>}
          {projects.map(project => <option key={project.name} value={project.name}>{optionText(project)}</option>)}
        </select>
      )}
    </>
  )
}

/** The open project: how it stands, what it was given, and what can be done with it. */
function ProjectView({ state, project, actions }: { state: PageState, project: ProjectInfo, actions: Actions }) {
  const now = Date.now()
  const { name, fields, status } = project
  const fetched = fetchText(project.lastFetch, now)
  const retrying = state.busy === `retry:${name}`
  const idle = state.busy === undefined && state.confirm === null
  return (
    <div className="dish-projects-stack">
      <div className="dish-projects-heading">
        <h3 className="dish-projects-project-title">{name}</h3>
        <StatusChip state={status.state} />
      </div>
      {status.state === 'failed' && (
        <Note tone="error">
          <span className="dish-projects-text">Onboarding failed{status.message === null ? '.' : `: ${status.message}`}</span>
        </Note>
      )}
      {status.state !== 'failed' && status.message !== null && status.message !== '' && (
        <p className="dish-projects-muted">{status.message}</p>
      )}
      {status.setupSkipped !== null && <SkippedNote text={status.setupSkipped} />}
      <dl className="dish-projects-facts">
        <dt>Status</dt>
        <dd>{statusLine(status, now)}</dd>
        <dt>Family</dt>
        <dd>{fields.family}</dd>
        <dt>Role</dt>
        <dd>{fields.role}</dd>
        <dt>Clone</dt>
        <dd>{project.clone === null ? 'not cloned yet' : <code className="dish-projects-code">{project.clone}</code>}</dd>
        <dt>Workspace</dt>
        <dd>{project.workspace === null ? 'none' : project.workspace}</dd>
        <dt>Last fetch</dt>
        <dd className={fetched.ok ? undefined : 'dish-projects-bad'}>{fetched.text}</dd>
        <dt>Gate</dt>
        <dd><code className="dish-projects-code">{fields.gate}</code> (timeout {fields.gateTimeout})</dd>
        <dt>Setup</dt>
        <dd>
          {fields.setup === ''
            ? 'none'
            : <><code className="dish-projects-code">{fields.setup}</code> (timeout {fields.setupTimeout === '' ? 'default, 15m' : fields.setupTimeout})</>}
        </dd>
        {Object.keys(fields.gateEnv).length > 0 && (
          <>
            <dt>Gate environment</dt>
            <dd>
              {Object.entries(fields.gateEnv).map(([variable, value]) => (
                <code className="dish-projects-code" key={variable}>{variable}={value}{'\n'}</code>
              ))}
            </dd>
          </>
        )}
      </dl>
      <RemoveControl project={project} state={state} actions={actions}>
        <Button variant="primary" size="sm" disabled={state.readOnly || !idle} onClick={() => { void actions.startEdit(name) }}>Edit</Button>
        {canRetry(project) && (
          <Button variant="outline" size="sm" title={retryHint(status.state)} disabled={!idle} onClick={() => { void actions.retry(name) }}>
            {retrying ? 'Retrying…' : 'Retry'}
          </Button>
        )}
      </RemoveControl>
      {status.state === 'ready' && <p className="dish-projects-muted">{retryHint(status.state)}</p>}
    </div>
  )
}

/**
 * The project's actions, and Remove among them; once Remove is pressed, the question in their place, where the eye is, with focus on
 * Cancel (the button that was pressed goes away, and focus would fall to the page). Cancel, or a refused removal, puts focus back
 * on Remove.
 * @param children - the actions before Remove.
 */
function RemoveControl({ project, state, actions, children }: { project: ProjectInfo, state: PageState, actions: Actions, children: ReactNode }) {
  const { name } = project
  const { confirm, busy } = state
  const asking = confirm !== null && confirm.kind === 'remove' && confirm.name === name
  const remove = useRef<HTMLButtonElement>(null)
  const wasAsking = useRef(false)
  useEffect(() => {
    if (wasAsking.current && !asking) remove.current?.focus()
    wasAsking.current = asking
  }, [asking])
  if (!asking) {
    return (
      <div className="dish-projects-actions">
        {children}
        <Button
          ref={remove}
          className="dish-projects-danger"
          variant="outline"
          size="sm"
          disabled={state.readOnly || busy !== undefined || confirm !== null}
          onClick={() => { actions.askRemove(name) }}
        >
          Remove
        </Button>
      </div>
    )
  }
  const working = busy === 'remove'
  return (
    <div className="dish-projects-confirm" role="group" aria-label="Confirm the removal">
      <p className="dish-projects-text">{removeQuestion(name, project.clone)}</p>
      <div className="dish-projects-actions">
        <Button variant="primary" size="sm" disabled={busy !== undefined} onClick={() => { void actions.remove() }}>
          {working ? 'Removing…' : `Remove ${name}`}
        </Button>
        <Button variant="ghost" size="sm" autoFocus disabled={working} onClick={actions.cancelConfirm}>Cancel</Button>
      </div>
    </div>
  )
}
