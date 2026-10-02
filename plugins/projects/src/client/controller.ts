/**
 * The Projects page's state and what it does: it calls the remote, keeps what it learns in one snapshot store, and reacts to
 * what dish-config's `watch` says. No React here, and nothing that only a browser or only dsh can load, so `node --test`
 * runs it against a fake remote (`test/controller.test.ts`). The components read the store through the `usePage` hook the
 * slot gives them and act through `ProjectsActions`. It is built like the Skills page's controller, and differs where
 * `projects.yaml` differs from a folder of documents:
 *
 * - **One document, many entries.** The registry is one file; a project is an entry in it. The list (with the store commit it
 *   was read at, which a save passes as `base`) is the page, and a save or a removal changes one entry and nothing else, which
 *   the server does on the file as it is at `base`.
 * - **A form, not an editor.** Adding and editing share one form (`form`) of the six text settings, the environment as rows
 *   and a note. It records the settings it was opened over (`saved`) and the commit it was read at (`base`), so it knows
 *   whether it has edits (`dirty`) and what a change elsewhere means for it.
 * - **The check** asks the server what saving the form would run into, 300 ms after the last edit and once whenever the form
 *   opens. A problem it finds stops a save here (the server refuses it too); a check that is still due is made first, so a
 *   Ctrl+S straight after typing works. The environment's rows are checked here first: a variable named twice, or a value with
 *   no variable, can't be written as a mapping, so those never reach the server.
 * - **A conflict** is the registry telling the form it is out of date: a save was refused as `CONFLICT`, or a live read finds
 *   the project's settings changed under an edit. The form stays; `conflict` holds the settings that are there now, and the
 *   person picks Reload (take them, drop the edit) or Keep mine (the edit over them). A change that is only another project's
 *   is not one: the form moves onto the new commit and nothing is asked. A project removed under an edit makes the form a
 *   new project, which Save adds again.
 * - **Removal and moving away ask first** (`confirm`): a removal says the clone and workspace stay, and leaving a form with
 *   edits asks whether to drop them.
 * - **Status arrives by polling.** Onboarding runs in the background and there is no stream for it, so while any project is
 *   pending, cloning or in setup the list is read again every 5 seconds; it stops when none is, and when the stream is lost.
 * - **Live updates** come from dish-config's remote, which may not be there: a change to `projects.yaml` or a proposal reads
 *   the list again, and without the remote nothing arrives that way.
 *
 * Answers that arrive after the person has moved on are dropped, by a counter per kind of answer.
 */

import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { ErrorCode, Fields, Outcome, ProjectInfo, ProjectState } from '../protocol.ts'
import { shortId } from './format.ts'
import { failureNotice, unexpectedNotice } from './outcome.ts'
import type { Action, Notice } from './outcome.ts'
import type { ConfigCalls, ConfigEvent, ProjectsApi } from './remote.ts'

/** How long typing pauses before the form is checked, in milliseconds. */
export const CHECK_DELAY = 300

/** How often the list is read while a project is being onboarded, in milliseconds. */
export const POLL_INTERVAL = 5_000

/**
 * The file the registry lives in, which `dish-config`'s events name. (`registry.ts` has the same constant; the browser can't
 * import that, which reads YAML, and `test/client-remote.test.ts` keeps the two equal.)
 */
export const PROJECTS_FILE = 'projects.yaml'

/**
 * What a new project's form starts with: everything empty but the gate's timeout, which is required and is 10 minutes in
 * the spec's examples (`test/client-remote.test.ts` checks that the registry takes it).
 */
export const NEW_FIELDS: Fields = Object.freeze({
  family: '',
  role: '',
  gate: '',
  gateTimeout: '10m',
  setup: '',
  setupTimeout: '',
  gateEnv: Object.freeze({}) as Record<string, string>,
})

/** The settings that are one line of text each, in the order the form shows them. */
const TEXT_KEYS = ['family', 'role', 'gate', 'gateTimeout', 'setup', 'setupTimeout'] as const

/** A field the form edits by key. The name is a field of a new project only. */
export type FieldKey = 'name' | typeof TEXT_KEYS[number]

/** One row of the environment as the person is typing it: a row of nothing is the one being added, and is not written. */
export interface EnvRow {
  name: string
  value: string
}

/** What the person is adding or editing. */
export interface FormState {
  /** `add` for a new project, whose `name` is typed; `edit` for one in the list, whose `name` is fixed. */
  mode: 'add' | 'edit'
  /** `owner/repo`, as typed: what is checked and saved is this trimmed. */
  name: string
  /** The settings, with `gateEnv` the mapping the rows make. */
  fields: Fields
  /** The environment as the rows the person sees. */
  env: EnvRow[]
  /** The optional note a save will carry. */
  note: string
  /** What the check found that would stop a save (or the rows, which are checked here), or `null`. */
  problem: string | null
  /** A check is due or under way: `problem` may be about older settings. */
  checking: boolean
  /** The last check couldn't be made. */
  checkError?: Notice
  /** The settings differ from `saved` (an edit), or anything has been entered (a new project). */
  dirty: boolean
  /** The store commit the form is over: what a save passes as `base`. `''` when there was no store. */
  base: string
  /** The settings as stored when the form was opened (or last taken over); `null` for a new project. */
  saved: Fields | null
}

/** What the registry has now for the project under a form with edits, and the commit it was read at. */
export interface Conflict {
  theirs: Fields
  commit: string
}

/** Where the person asked to go while the form had edits: what `confirmDiscard` does once they agree. */
export type Then =
  | { to: 'select', name: string }
  | { to: 'edit', name: string }
  | { to: 'add' }

/** The question the page is asking before it does something the person can't take back with a click. */
export type Confirm =
  | { kind: 'remove', name: string }
  | { kind: 'discard', then: Then }

/** The outcome of the last thing the person did, shown above the page until they move on. */
export interface PageNotice extends Notice {
  tone: 'info' | 'success' | 'error'
}

/** What is being done now, so a second click can't start it again: a save, a removal, or `retry:<project>`. */
export type Busy = 'save' | 'remove' | `retry:${string}`

export interface PageState {
  /** The projects, as the server lists them: sorted by name. Empty while `problem` is set. */
  projects: ProjectInfo[]
  /** The store commit the list was read at; `''` when there is no store. */
  commit: string
  /** Why the stored `projects.yaml` doesn't parse, or `null`. */
  problem: string | null
  /** The open and stale proposals for `projects.yaml`: they are accepted on History. */
  pendingProposals: number
  /** The list has been asked for. */
  listLoaded: boolean
  listError?: Notice
  /** There is no store to save to: the page shows nothing to change. */
  readOnly: boolean
  /** The project shown in the detail pane, one of the list. */
  selected?: string
  /** The form for adding or editing, or `null`. */
  form: FormState | null
  /** The question being asked. */
  confirm: Confirm | null
  /** What the registry has now, when it is not what the form was opened over and the form has edits. */
  conflict?: Conflict
  notice?: PageNotice
  busy?: Busy
  /** Whether dish-config's `watch` is delivering: `off` without its remote, `down` between a lost carrier and the next item. */
  stream: 'off' | 'connecting' | 'live' | 'down'
}

/** What a component can ask of the page, beside the `usePage` hook the `hooks` entry becomes. */
export interface ProjectsActions {
  hooks: { page: ObservableSnapshot<PageState> }
  /** The page was shown: load what it needs, or read again what it has. */
  open(): Promise<void>
  /** Show a project. With a form that has edits it only asks (`confirm`); `confirmDiscard` or `cancelConfirm` answers. */
  select(name: string): void
  /** Open the form on a new project. With a form that has edits it asks first. Refused, with the reason, without a store. */
  startAdd(): Promise<void>
  /** Open the form on a project of the list. With a form that has edits it asks first. */
  startEdit(name: string): Promise<void>
  /** Change one field. `name` only takes effect for a new project. */
  editField(key: FieldKey, value: string): void
  /** Replace the environment's rows. */
  editEnv(rows: EnvRow[]): void
  setNote(note: string): void
  save(): Promise<void>
  /** Close the form and drop its edits. Not while a save is out. */
  cancel(): void
  /** Ask whether to remove a project (`confirm`). */
  askRemove(name: string): void
  /** After `askRemove`: remove the project from `projects.yaml`. */
  remove(): Promise<void>
  cancelConfirm(): void
  /** After a question about leaving the form: drop its edits and go where the person asked. */
  confirmDiscard(): Promise<void>
  /** Onboard a project again. */
  retry(name: string): Promise<void>
  /** Read the list again; after a conflict, first take the registry's settings and drop the edit. */
  reload(): Promise<void>
  /** After a conflict: keep the edit, with the registry's settings as what it is saved over. */
  keepMine(): void
  dismiss(): void
}

export interface ProjectsController {
  /** What the component gets: the observable and the actions, and nothing that feeds the controller. */
  face: ProjectsActions
  getState(): PageState
  /**
   * One item of dish-config's `watch`. `opening` is whether it is the first of a stream the page has (re)opened: events
   * may have been missed, so everything the page has is read again.
   */
  onConfigEvent(event: ConfigEvent, opening?: boolean): Promise<void>
  /** Onboarding may have moved: read the list now. (The poll calls this.) */
  onStatus(): Promise<void>
  /** `watch` lost its carrier; the page keeps what it has, says so, and stops polling until it reads the list again. */
  streamDown(): void
  /** dish-config's remote arrived, or went; `undefined` for gone. */
  setConfig(calls: ConfigCalls | undefined): void
}

/** The timer the check's pause and the poll run on: the browser's, unless a test gives its own. */
export interface Timer {
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface ProjectsOptions {
  /** Where the pauses are timed. Default: the global `setTimeout` and `clearTimeout`. */
  timer?: Timer
  /** The pause after the last edit before the form is checked, in milliseconds. Default `CHECK_DELAY`. */
  delay?: number
  /** How often the list is read while a project is being onboarded, in milliseconds. Default `POLL_INTERVAL`. */
  pollEvery?: number
}

const globalTimer: Timer = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => { globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>) },
}

// --- settings ------------------------------------------------------------------------------------

/** Set `key` on `target` as an own property, even when it is `__proto__`, which plain assignment would turn into a prototype change. */
function put<T>(target: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true })
}

function cloneFields(fields: Fields): Fields {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(fields.gateEnv)) put(env, name, value)
  return { ...fields, gateEnv: env }
}

/** Whether two sets of settings are the same: every text, and the environment's variables and values without regard to order. */
export function sameFields(a: Fields, b: Fields): boolean {
  for (const key of TEXT_KEYS) if (a[key] !== b[key]) return false
  const left = Object.entries(a.gateEnv)
  if (left.length !== Object.keys(b.gateEnv).length) return false
  return left.every(([name, value]) => Object.hasOwn(b.gateEnv, name) && b.gateEnv[name] === value)
}

/** The rows an environment is edited as. */
function rowsOf(env: Record<string, string>): EnvRow[] {
  return Object.entries(env).map(([name, value]) => ({ name, value }))
}

/**
 * The mapping the rows write: a row of nothing is the one being added and is left out, and so is a row with no variable
 * (`envProblem` says so); of a variable named twice the first counts (`envProblem` says that too).
 */
function envOf(rows: readonly EnvRow[]): Record<string, string> {
  const env: Record<string, string> = {}
  for (const { name, value } of rows) {
    if (name === '' || Object.hasOwn(env, name)) continue
    put(env, name, value)
  }
  return env
}

/** A variable name for a message: cut short, so that a pasted line doesn't fill the page. */
function shown(name: string): string {
  return JSON.stringify(name.length > 64 ? `${name.slice(0, 64)}…` : name)
}

/** What is wrong with the rows as rows, or `null`. These never reach the server: they can't be written as a mapping. */
function envProblem(rows: readonly EnvRow[]): string | null {
  const seen = new Set<string>()
  for (const { name, value } of rows) {
    if (name === '') {
      if (value !== '') return `${PROJECTS_FILE}: a gateEnv value needs a variable name`
      continue
    }
    if (seen.has(name)) return `${PROJECTS_FILE}: gateEnv names ${shown(name)} twice`
    seen.add(name)
  }
  return null
}

/**
 * Whether `form` has anything the person would lose. A row the mapping can't hold (a value with no variable) is typed text
 * too, though the settings don't show it.
 */
function dirtyOf(form: Pick<FormState, 'mode' | 'name' | 'fields' | 'env' | 'saved'>): boolean {
  if (envProblem(form.env) !== null) return true
  if (form.saved !== null) return !sameFields(form.fields, form.saved)
  return form.name.trim() !== '' || !sameFields(form.fields, NEW_FIELDS)
}

/** The project states in which onboarding is queued or running: the list is polled while any project is in one. */
export const ONBOARDING_STATES: readonly ProjectState[] = ['pending', 'cloning', 'setup']

/** Whether the page offers Retry for a project: any that isn't queued or being onboarded. The service has the last word. */
export function canRetry(project: Pick<ProjectInfo, 'status'>): boolean {
  return !ONBOARDING_STATES.includes(project.status.state)
}

function newForm(base: string): FormState {
  return { mode: 'add', name: '', fields: cloneFields(NEW_FIELDS), env: [], note: '', problem: null, checking: false, dirty: false, base, saved: null }
}

function editForm(project: ProjectInfo, base: string): FormState {
  return {
    mode: 'edit',
    name: project.name,
    fields: cloneFields(project.fields),
    env: rowsOf(project.fields.gateEnv),
    note: '',
    problem: null,
    checking: false,
    dirty: false,
    base,
    saved: cloneFields(project.fields),
  }
}

// --- calls ---------------------------------------------------------------------------------------

/** What a call that did not succeed is, for the page: its notice, and for a refusal by the store its code and its own words. */
type Failed = { ok: false, notice: Notice, code?: ErrorCode, message?: string }

type Settled<T> = { ok: true, value: T } | Failed

/**
 * Wait for a call and fold both kinds of failure (the carrier's and the registry's) into a `Notice`. Never throws.
 * @param action - what the person was doing, for the refusals whose wording depends on it.
 */
async function settle<T>(task: () => Promise<RemoteResult<Outcome<T>>>, action?: Action): Promise<Settled<T>> {
  try {
    const result = await task()
    if (!result.ok) return { ok: false, notice: unexpectedNotice(result.error) }
    const outcome = result.value
    if (!outcome.ok) {
      return { ok: false, notice: failureNotice(outcome.code, outcome.message, action), code: outcome.code, message: outcome.message }
    }
    return { ok: true, value: outcome.value }
  } catch (error) {
    return { ok: false, notice: unexpectedNotice(error) }
  }
}

/** A minimal snapshot store: what `createSnapshotStore` is, without the engine behind it that Node can't load. */
function createStore<T>(initial: T): ObservableSnapshot<T> & { set(next: T): void } {
  let current = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => current,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set(next) {
      current = next
      for (const listener of [...listeners]) listener()
    },
  }
}

/**
 * @param api - the `dishProjects` remote.
 * @param options - the timer and the pauses, for tests.
 */
export function createProjects(api: ProjectsApi, options: ProjectsOptions = {}): ProjectsController {
  const timer = options.timer ?? globalTimer
  const delay = options.delay ?? CHECK_DELAY
  const pollEvery = options.pollEvery ?? POLL_INTERVAL
  const store = createStore<PageState>({
    projects: [],
    commit: '',
    problem: null,
    pendingProposals: 0,
    listLoaded: false,
    readOnly: false,
    form: null,
    confirm: null,
    stream: 'off',
  })
  const get = (): PageState => store.getSnapshot()
  const patch = (next: Partial<PageState>): void => { store.set({ ...get(), ...next }) }
  const patchForm = (next: Partial<FormState>): void => {
    const form = get().form
    if (form !== null) patch({ form: { ...form, ...next } })
  }
  const info = (text: string): PageNotice => ({ tone: 'info', text })

  /** Bumped when the form is opened or closed: a write's answer for an earlier form is not for this page. */
  let formGeneration = 0
  /** A live read came while a write was under way: it would see the page's own commit as someone else's, so it waits for the write to end. */
  let eventWhileWriting = false
  /** The next read of the list follows a write that was refused as a `CONFLICT`: a new project's form is told whether the name is taken now. */
  let conflictRead = false

  /** A save or a removal is under way. */
  const writing = (): boolean => get().busy === 'save' || get().busy === 'remove'

  // --- the check ----------------------------------------------------------------------------------

  /** The pause is running: the handle of its timer is `pause`. */
  let pausing = false
  let pause: unknown
  /** Bumped when an answer in flight stops being wanted: a newer edit, another form, a newer check. */
  let checkGeneration = 0
  /** The check under way, while there is one. */
  let checkRunning: Promise<void> | undefined

  const disarm = (): void => {
    if (!pausing) return
    pausing = false
    timer.clearTimeout(pause)
  }

  /** Leave what was checked behind: another form is opening, or none is. */
  const dropCheck = (): void => {
    disarm()
    checkGeneration++
  }

  /**
   * Check the form as it is now, at once; a check that is due is made by this. The rows are judged here, and the server is asked
   * only about a form that can be written. Never throws.
   */
  const runCheck = (): Promise<void> => {
    disarm()
    const form = get().form
    if (form === null) {
      checkGeneration++
      return Promise.resolve()
    }
    const generation = ++checkGeneration
    const local = envProblem(form.env)
    if (local !== null) {
      patchForm({ problem: local, checking: false, checkError: undefined })
      return Promise.resolve()
    }
    patchForm({ checking: true })
    const name = form.name.trim()
    const adding = form.mode === 'add'
    const running = (async (): Promise<void> => {
      const result = await settle(() => api.check(name, form.fields, adding))
      if (generation !== checkGeneration) return
      if (result.ok) patchForm({ problem: result.value.problem, checking: false, checkError: undefined })
      else patchForm({ problem: null, checking: false, checkError: result.notice })
    })()
    checkRunning = running
    void running.then(() => { if (checkRunning === running) checkRunning = undefined })
    return running
  }

  /** The form changed: check it once the person pauses. */
  const scheduleCheck = (): void => {
    disarm()
    checkGeneration++
    patchForm({ checking: true })
    pausing = true
    pause = timer.setTimeout(() => {
      pausing = false
      void runCheck()
    }, delay)
  }

  /** Wait until `problem` is about the form as it is now: a check that is due is made, one under way is waited for. */
  const ensureChecked = async (): Promise<void> => {
    if (pausing) await runCheck()
    else if (checkRunning !== undefined) await checkRunning
  }

  // --- the form -----------------------------------------------------------------------------------

  /** Open `form` in place of whatever was open, and check it. */
  const openForm = (form: FormState): Promise<void> => {
    formGeneration++
    dropCheck()
    patch({ form, conflict: undefined, confirm: null, notice: undefined })
    return runCheck()
  }

  const closeForm = (): void => {
    formGeneration++
    dropCheck()
    patch({ form: null, conflict: undefined })
  }

  /** Change the form, and check it when the person pauses. Not while a save is out: what is saved is what was checked. */
  const change = (next: (form: FormState) => Partial<FormState> | undefined): void => {
    const form = get().form
    if (form === null || get().busy === 'save') return
    const changes = next(form)
    if (changes === undefined) return
    const merged = { ...form, ...changes }
    patch({ form: { ...merged, dirty: dirtyOf(merged) } })
    scheduleCheck()
  }

  /** Take the registry's settings as what the form is over, and drop the edit: it is a clean form on `theirs` now. */
  const adopt = (theirs: Fields, commit: string, name?: string): void => {
    const form = get().form
    if (form === null) return
    patch({
      conflict: undefined,
      form: {
        ...form,
        mode: 'edit',
        name: name ?? form.name,
        fields: cloneFields(theirs),
        env: rowsOf(theirs.gateEnv),
        note: '',
        problem: null,
        checking: false,
        checkError: undefined,
        dirty: false,
        base: commit,
        saved: cloneFields(theirs),
      },
    })
  }

  /** The project under the form is not in the registry any more. */
  const goneElsewhere = (form: FormState): void => {
    if (!form.dirty) {
      closeForm()
      patch({ notice: info(`${form.name} was removed elsewhere.`) })
      return
    }
    // The edit is kept, as a new project: saving it over the old commit would be a conflict for ever, and a save over the new one adds it.
    patch({
      conflict: undefined,
      notice: info(`${form.name} was removed elsewhere; Save adds it again.`),
      form: { ...form, mode: 'add', saved: null, base: get().commit },
    })
    dropCheck()
    void runCheck()
  }

  /**
   * The list has been read again: the form is over the commit it was opened on, and the registry may have moved.
   * @param namesChanged - the set of projects differs from the one before the read.
   * @param afterConflict - the read follows a save refused as a `CONFLICT`.
   */
  const reconcileForm = (namesChanged: boolean, afterConflict: boolean): void => {
    const state = get()
    const form = state.form
    if (form === null) return
    const commit = state.commit
    if (form.mode === 'edit') {
      const entry = state.projects.find(project => project.name === form.name)
      if (entry === undefined) {
        goneElsewhere(form)
        return
      }
      const theirs = entry.fields
      if (form.saved !== null && sameFields(form.saved, theirs)) {
        // Nothing of this project changed (or a change was undone): the form is over the right settings, and only the commit moves.
        patch({ conflict: undefined, form: { ...form, base: commit } })
      } else if (!form.dirty) {
        adopt(theirs, commit)
        void runCheck()
      } else if (sameFields(form.fields, theirs)) {
        // Somebody made the very edit that is in the form: it is what is stored, and there is nothing left to save.
        patch({ conflict: undefined, form: { ...form, saved: cloneFields(theirs), base: commit, dirty: false } })
      } else {
        patch({ conflict: { theirs: cloneFields(theirs), commit } })
      }
      return
    }
    // A new project: it is a conflict only if the name is taken, and was taken by the change a save just ran into.
    const name = form.name.trim()
    const exact = name === '' ? undefined : state.projects.find(project => project.name === name)
    if (state.conflict !== undefined || afterConflict) {
      if (exact !== undefined) {
        patch({ conflict: { theirs: cloneFields(exact.fields), commit } })
        return
      }
      patch({ conflict: undefined, form: { ...form, base: commit } })
    } else {
      patch({ form: { ...form, base: commit } })
    }
    // Whether the name is free is the check's answer, and a project came or went.
    if (namesChanged) void runCheck()
  }

  // --- the list -----------------------------------------------------------------------------------

  /** The poll is waiting: the handle of its timer is `poll`. */
  let polling = false
  let poll: unknown

  const disarmPoll = (): void => {
    if (!polling) return
    polling = false
    timer.clearTimeout(poll)
  }

  /** Wait `pollEvery` and read the list again, if any project is being onboarded. One poll waits at a time. */
  const armPoll = (): void => {
    disarmPoll()
    if (!get().projects.some(project => ONBOARDING_STATES.includes(project.status.state))) return
    polling = true
    poll = timer.setTimeout(() => {
      polling = false
      void refreshProjects()
    }, pollEvery)
  }

  /** The selection is a project of the list. */
  const reconcileSelection = (): void => {
    const { selected, projects } = get()
    if (selected !== undefined && !projects.some(project => project.name === selected)) patch({ selected: undefined })
  }

  /** Read the list as the server gives it now. A failure leaves what is shown alone and ends the poll: the page says so. */
  const readProjects = async (): Promise<void> => {
    const afterConflict = conflictRead
    conflictRead = false
    const result = await settle(() => api.projects())
    if (!result.ok) {
      patch({ listLoaded: true, listError: result.notice })
      disarmPoll()
      return
    }
    const { projects, commit, problem, pendingProposals } = result.value
    const before = get().projects.map(project => project.name).join('\n')
    patch({ projects, commit, problem, pendingProposals, listLoaded: true, listError: undefined, readOnly: commit === '' })
    // A write is out: its own commit is on its way back, and would be taken for someone else's. The read it makes after does this.
    if (writing()) {
      eventWhileWriting = true
    } else {
      // Without a registry to read (it doesn't parse, or there is no store) there is nothing to hold a form to.
      if (problem === null && commit !== '') {
        reconcileSelection()
        reconcileForm(before !== projects.map(project => project.name).join('\n'), afterConflict)
      }
    }
    armPoll()
  }

  let listRunning: Promise<void> | undefined
  let listAgain = false

  /**
   * Read the list, one read at a time: a call while one is under way waits for it, and the list is read once more after it,
   * for whatever changed meanwhile. A call while a write is out waits for the write to end instead.
   */
  const refreshProjects = (): Promise<void> => {
    if (writing()) {
      eventWhileWriting = true
      return Promise.resolve()
    }
    eventWhileWriting = false
    if (listRunning !== undefined) {
      listAgain = true
      return listRunning
    }
    listRunning = (async () => {
      try {
        do {
          listAgain = false
          await readProjects()
        } while (listAgain)
      } finally {
        listRunning = undefined
      }
    })()
    return listRunning
  }

  /** After a write: the read that was put off while it was out is made now. */
  const settleEvents = async (): Promise<void> => {
    if (!eventWhileWriting) return
    eventWhileWriting = false
    await refreshProjects()
  }

  // --- writing --------------------------------------------------------------------------------------

  /**
   * A refusal of a write: the notice, and after a `CONFLICT` the registry as it is now, so the form can say what changed. A
   * conflict that is nothing of this project's isn't one: the form has moved onto the new commit, and the notice says to save again.
   */
  const refused = async (failure: Failed, name: string): Promise<void> => {
    const notice: PageNotice = { tone: 'error', ...failure.notice }
    patch({ notice })
    if (failure.code === 'CONFLICT') {
      conflictRead = true
      await refreshProjects()
      const state = get()
      if (state.notice === notice && state.form !== null && state.conflict === undefined) {
        patch({ notice: info(`projects.yaml changed since you loaded it, but not ${name}. Save again.`) })
      }
      return
    }
    // The registry has no such project: read it, and the page finds the form's project gone.
    if (failure.code === 'NOT_FOUND') {
      await refreshProjects()
      return
    }
    await settleEvents()
  }

  const save = async (): Promise<void> => {
    const first = get()
    const form = first.form
    // With a conflict open the save would be refused again: the person picks Reload or Keep mine first.
    if (form === null || first.busy !== undefined || first.conflict !== undefined) return
    if (form.mode === 'edit' && !form.dirty) return
    const chosen = formGeneration
    // Busy from the start, so that a second click while the check is made doesn't start a second save.
    patch({ busy: 'save', notice: undefined })
    // The check in hand may be of older settings: a Ctrl+S right after typing gets its own answer first.
    if (pausing || checkRunning !== undefined) await ensureChecked()
    const state = get()
    const current = state.form
    if (current === null || chosen !== formGeneration || state.conflict !== undefined) {
      // The page moved on, or a live read found the project changed, while the check was made: nothing is saved.
      patch({ busy: undefined })
      await settleEvents()
      return
    }
    if (current.checking) {
      patch({ busy: undefined, notice: info('The settings changed while they were being checked — save again.') })
      await settleEvents()
      return
    }
    if (current.problem !== null) {
      patch({ busy: undefined, notice: { tone: 'error', text: `Can't save: ${current.problem}` } })
      await settleEvents()
      return
    }
    const name = current.name.trim()
    const adding = current.mode === 'add'
    const result = await settle(() => api.save(name, current.fields, current.base, current.note, adding), 'save')
    patch({ busy: undefined })
    if (!result.ok) {
      await refused(result, name)
      return
    }
    const commit = result.value
    if (commit === null) {
      // The registry already says this.
      patch({ notice: info(`Nothing to save for ${name}: ${PROJECTS_FILE} already has these settings.`) })
    } else {
      patch({ notice: { tone: 'success', text: `${adding ? 'Added' : 'Saved'} ${name} as ${shortId(commit.id)}` } })
    }
    closeForm()
    patch({ selected: name })
    await refreshProjects()
  }

  const askRemove = (name: string): void => {
    const state = get()
    if (state.busy !== undefined) return
    if (!state.projects.some(project => project.name === name)) {
      patch({ notice: { tone: 'error', text: `${name} isn't in the list.` } })
      return
    }
    patch({ confirm: { kind: 'remove', name }, notice: undefined })
  }

  const remove = async (): Promise<void> => {
    const state = get()
    const confirm = state.confirm
    if (confirm === null || confirm.kind !== 'remove' || state.busy !== undefined) return
    const name = confirm.name
    patch({ busy: 'remove', notice: undefined })
    const result = await settle(() => api.removeProject(name, state.commit, ''), 'remove')
    patch({ busy: undefined, confirm: null })
    if (!result.ok) {
      // A conflict means the list was out of date; it is read now, and the person asks again about what they see.
      if (result.code === 'CONFLICT' || result.code === 'NOT_FOUND') {
        patch({ notice: { tone: 'error', ...result.notice } })
        await refreshProjects()
        return
      }
      await refused(result, name)
      return
    }
    const commit = result.value
    patch({
      notice: commit === null
        ? info(`${name} was removed already — nothing to do`)
        : { tone: 'success', text: `Removed ${name} as ${shortId(commit.id)}. Its clone and workspace stay.` },
    })
    if (get().selected === name) patch({ selected: undefined })
    const form = get().form
    if (form !== null && form.name.trim() === name) closeForm()
    await refreshProjects()
  }

  const retry = async (name: string): Promise<void> => {
    if (get().busy !== undefined) return
    patch({ busy: `retry:${name}`, notice: undefined })
    const result = await settle(() => api.retry(name), 'retry')
    patch({ busy: undefined })
    if (!result.ok) patch({ notice: { tone: 'error', ...result.notice } })
    else patch({ notice: { tone: 'success', text: `Queued ${name} for onboarding` } })
    // Either way the status is what the service says now.
    await refreshProjects()
  }

  // --- the face -----------------------------------------------------------------------------------

  const select = (name: string): void => {
    const state = get()
    const form = state.form
    if (writing() || !state.projects.some(project => project.name === name)) return
    if (form !== null && form.mode === 'edit' && form.name === name) {
      patch({ selected: name })
      return
    }
    if (form !== null && form.dirty) {
      patch({ confirm: { kind: 'discard', then: { to: 'select', name } } })
      return
    }
    if (form !== null) closeForm()
    patch({ selected: name, confirm: null, notice: undefined })
  }

  const startAdd = async (): Promise<void> => {
    const state = get()
    if (writing()) return
    if (state.listLoaded && state.commit === '') {
      patch({ notice: { tone: 'error', ...failureNotice('UNAVAILABLE', '') } })
      return
    }
    if (state.form !== null && state.form.dirty) {
      patch({ confirm: { kind: 'discard', then: { to: 'add' } } })
      return
    }
    await openForm(newForm(state.commit))
  }

  const startEdit = async (name: string): Promise<void> => {
    const state = get()
    const form = state.form
    if (writing()) return
    const project = state.projects.find(candidate => candidate.name === name)
    if (project === undefined) {
      patch({ notice: { tone: 'error', text: `${name} isn't in the list.` } })
      return
    }
    if (form !== null && form.mode === 'edit' && form.name === name) {
      patch({ selected: name })
      return
    }
    if (form !== null && form.dirty) {
      patch({ confirm: { kind: 'discard', then: { to: 'edit', name } } })
      return
    }
    patch({ selected: name })
    await openForm(editForm(project, state.commit))
  }

  const confirmDiscard = async (): Promise<void> => {
    const confirm = get().confirm
    if (confirm === null || confirm.kind !== 'discard' || writing()) return
    closeForm()
    patch({ confirm: null })
    switch (confirm.then.to) {
      case 'select':
        select(confirm.then.name)
        return
      case 'edit':
        await startEdit(confirm.then.name)
        return
      case 'add':
        await startAdd()
        return
    }
  }

  const reload = async (): Promise<void> => {
    const { conflict, form } = get()
    if (conflict !== undefined && form !== null) {
      // The registry's settings are in hand: the edit goes first, and a read that fails can't bring it back to a conflict that is settled.
      adopt(conflict.theirs, conflict.commit, form.name.trim())
      dropCheck()
    }
    await refreshProjects()
  }

  const open = async (): Promise<void> => {
    await refreshProjects()
    const state = get()
    const first = state.projects[0]
    if (state.selected === undefined && first !== undefined) patch({ selected: first.name })
  }

  const face: ProjectsActions = {
    // A store to read and subscribe to, not the one the controller writes.
    hooks: { page: { getSnapshot: store.getSnapshot, subscribe: store.subscribe } },
    open,
    select,
    startAdd,
    startEdit,
    editField(key, value) {
      change((form) => {
        if (key === 'name') return form.mode === 'add' && form.name !== value ? { name: value } : undefined
        return form.fields[key] === value ? undefined : { fields: { ...form.fields, [key]: value } }
      })
    },
    editEnv(rows) {
      change(form => ({ env: rows.map(row => ({ ...row })), fields: { ...form.fields, gateEnv: envOf(rows) } }))
    },
    setNote(note) {
      patchForm({ note })
    },
    save,
    cancel() {
      if (writing()) return
      closeForm()
      if (get().confirm?.kind === 'discard') patch({ confirm: null })
    },
    askRemove,
    remove,
    cancelConfirm() {
      patch({ confirm: null })
    },
    confirmDiscard,
    retry,
    reload,
    keepMine() {
      const { conflict, form } = get()
      if (conflict === undefined || form === null) return
      // The project exists now, if the form was a new one: the edit is over it, and a save of it is an edit.
      const wasNew = form.mode === 'add'
      patch({
        conflict: undefined,
        form: {
          ...form,
          mode: 'edit',
          name: form.name.trim(),
          saved: cloneFields(conflict.theirs),
          base: conflict.commit,
          dirty: !sameFields(form.fields, conflict.theirs),
        },
      })
      if (wasNew) void runCheck()
    },
    dismiss() {
      patch({ notice: undefined })
    },
  }

  return {
    face,
    getState: get,

    async onConfigEvent(event, opening = false) {
      if (opening) {
        // The first item of every stream, the very first included: a commit made between the page's own read and the
        // stream's subscription would otherwise be missed.
        patch({ stream: 'live' })
        await refreshProjects()
        return
      }
      switch (event.kind) {
        case 'changed':
          if (event.paths.includes(PROJECTS_FILE)) await refreshProjects()
          return
        case 'proposal':
          // Which file it is for isn't in the event; the list says how many are for this one.
          await refreshProjects()
          return
        case 'remote':
          return
      }
    },
    onStatus: refreshProjects,
    streamDown() {
      disarmPoll()
      if (get().stream !== 'off') patch({ stream: 'down' })
    },
    setConfig(calls) {
      patch({ stream: calls === undefined ? 'off' : 'connecting' })
    },
  }
}
