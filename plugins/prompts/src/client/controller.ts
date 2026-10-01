/**
 * The Prompts page's state and what it does: it calls the remotes, keeps what it learns in one snapshot store, and reacts to
 * what dish-config's `watch` says. No React here, and nothing that only a browser or only dsh can load, so `node --test`
 * runs it against fake remotes (`test/controller.test.ts`). The components read the store through the `usePage` hook the
 * slot gives them and act through `PromptsActions`.
 *
 * The page edits one role at a time:
 *
 * - **A draft** is the text in the editor. `saved` is what the store had when the page read it, with the commit it read it
 *   at (what a save passes as `base`). The draft is clean when it is the saved text.
 * - **A conflict** is the store telling the draft it is out of date: a save was refused as `CONFLICT`, or a live event says
 *   the document changed while the draft had edits. The draft stays; `conflict` holds the text that is there now. A clean
 *   page just reads the new text.
 * - **Unknown variables** are the `{{names}}` in the draft that the dish preset has no variable for. They are a warning that
 *   never blocks a save, and there are none to report while dsh's assembly could not be read (`fallback`): without it
 *   there is no telling which names have a value.
 * - **The History tab and live updates** come from dish-config's remote, which may not be there: `setConfig` gives the
 *   controller its calls (or takes them away), and without them the History tab is hidden and nothing arrives live.
 *
 * Answers that arrive after the person has moved on are dropped, by a counter per kind of answer.
 */

import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { unifiedDiff } from 'dish-kit/ui/diff'
import type { FileDiff } from 'dish-kit/ui/diff'
import { interpolate } from '../interpolate.ts'
import type { CommitInfo, ErrorCode, Outcome, PreviewResult, ReadResult, RoleInfo, VariableInfo } from '../protocol.ts'
import { roleLabel, shortId } from './format.ts'
import { ALREADY_DEFAULT, NOTHING_TO_REVERT, failureNotice, unexpectedNotice } from './outcome.ts'
import type { Action, Notice } from './outcome.ts'
import type { ConfigCalls, ConfigEvent, PromptsApi } from './remote.ts'

/** How many commits the History tab asks for. */
export const HISTORY_PAGE = 20

/** The note a reset carries, so that its commit says what it was in the history. */
export const RESET_NOTE = 'Reset to the default'

/** What the page calls its two remotes when a call fails before the store is reached. */
const PROMPTS = 'dish-prompts'
const CONFIG = 'dish-config'

/** The page's tabs. `default` is there only for a role with a shipped default, `history` only with dish-config's remote. */
export type Tab = 'edit' | 'default' | 'preview' | 'history'

/** A role's document as the page loaded it: its text, and the store commit that was read (`null` when there is no store). */
export interface Saved {
  text: string
  commit: string | null
}

/** What the store has now, when it is not what the page loaded and the draft has edits. */
export interface Conflict {
  theirs: string
  commit: string | null
}

/** The outcome of the last thing the person did, shown above the page until they move on. */
export interface PageNotice extends Notice {
  tone: 'info' | 'success' | 'error'
}

export type Status = 'loading' | 'ready' | 'error'

/** The prompt variables of the dish preset, as the page last read them. */
export interface VariablesState {
  status: Status
  list: VariableInfo[]
  /** dsh's assembly couldn't be read, so `list` is empty and says nothing of what a prompt may use. */
  fallback: boolean
}

export interface PreviewState {
  status: Status
  /** The last preview that arrived: kept while the next loads. */
  value?: PreviewResult
  error?: Notice
}

/** One commit's diff, fetched when its row opens. */
export type DetailState =
  | { status: 'loading' }
  | { status: 'ready', info: CommitInfo, diffs: FileDiff[] }
  | { status: 'error', error: Notice }

export interface HistoryState {
  status: Status
  commits: CommitInfo[]
  error?: Notice
  /** By commit id. A commit's diff never changes, so these outlive a reload of the log. */
  details: Record<string, DetailState>
}

/** What is being done now, so a second click can't start it again: a save, a reset, or `revert:<commit id>`. */
export type Busy = 'save' | 'reset' | `revert:${string}`

export interface PageState {
  /** The roles, as the server lists them: `common`, `main`, then the crew roles. */
  roles: RoleInfo[]
  rolesLoaded: boolean
  rolesError?: Notice
  /** The role in the editor. */
  selected?: string
  /** The selected role's document: not asked for yet, being read, in hand, or not readable. */
  document: 'idle' | 'loading' | 'ready' | 'error'
  documentError?: Notice
  saved?: Saved
  /** The shipped default, or `null` for a role dish ships none for. */
  defaultText: string | null
  /** The document isn't in the store, and `saved` is the default. */
  missing: boolean
  /** There is no store to save to: the page shows the shipped defaults. */
  readOnly: boolean
  draft: string
  /** The optional note a save will carry. */
  note: string
  /** `draft` isn't `saved.text`. */
  dirty: boolean
  tab: Tab
  conflict?: Conflict
  /** A role the person asked for while the draft had edits: asked about before they are thrown away. */
  switching?: string
  notice?: PageNotice
  busy?: Busy
  variables: VariablesState
  /** The `{{names}}` in the draft with no variable to fill them: a warning only. */
  unknownVariables: string[]
  /** The selected role's preview, once its tab has been opened. */
  preview?: PreviewState
  /** The selected role's log, once its tab has been opened. */
  history?: HistoryState
  /** dish-config's remote is there: the History tab shows, and live updates can arrive. */
  hasHistory: boolean
  /** Whether dish-config's `watch` is delivering: `off` without its remote, `down` between a lost carrier and the next item. */
  stream: 'off' | 'connecting' | 'live' | 'down'
}

/** What the Default tab shows. */
export type DefaultView =
  | { kind: 'none' }
  | { kind: 'same' }
  | { kind: 'diff', diff: FileDiff }

/** What a component can ask of the page, beside the `usePage` hook the `hooks` entry becomes. */
export interface PromptsActions {
  hooks: { page: ObservableSnapshot<PageState> }
  /** The page was shown: load what it needs, or read again what it has. */
  open(): Promise<void>
  /** Open a role. With unsaved edits it only asks (`switching`); `confirmSwitch` or `cancelSwitch` answers. */
  select(role: string): Promise<void>
  confirmSwitch(): Promise<void>
  cancelSwitch(): void
  edit(text: string): void
  setNote(note: string): void
  save(): Promise<void>
  /** Back to the saved text. */
  discard(): void
  /** Write the shipped default over the document. */
  reset(): Promise<void>
  /** After a conflict: read the store's text again and drop the draft. */
  reload(): Promise<void>
  /** After a conflict: keep the draft, with the store's text as what it is saved over. */
  keepMine(): void
  setTab(tab: Tab): Promise<void>
  loadPreview(): Promise<void>
  loadVariables(): Promise<void>
  loadHistory(): Promise<void>
  loadCommit(id: string): Promise<void>
  revert(id: string): Promise<void>
  dismiss(): void
}

export interface PromptsController {
  /** What the component gets: the observable and the actions, and nothing that feeds the controller. */
  face: PromptsActions
  getState(): PageState
  /**
   * One item of dish-config's `watch`. `opening` is whether it is the first of a stream the page has (re)opened: events
   * may have been missed, so everything the page has is read again.
   */
  onConfigEvent(event: ConfigEvent, opening?: boolean): Promise<void>
  /** `watch` lost its carrier; the page keeps what it has and says so. */
  streamDown(): void
  /** dish-config's remote arrived, or went; `undefined` for gone. */
  setConfig(calls: ConfigCalls | undefined): void
}

/** The tabs the page offers now, in order. */
export function visibleTabs(state: Pick<PageState, 'defaultText' | 'hasHistory'>): Tab[] {
  const tabs: Tab[] = ['edit']
  if (state.defaultText !== null) tabs.push('default')
  tabs.push('preview')
  if (state.hasHistory) tabs.push('history')
  return tabs
}

/**
 * What the Default tab shows for the selected role: no default to compare with, what is saved being the default, or the
 * diff from the default to what is saved (not to the draft: the tab is about the stored prompt).
 */
export function defaultView(state: Pick<PageState, 'defaultText' | 'saved' | 'selected' | 'roles'>): DefaultView {
  if (state.defaultText === null || state.saved === undefined || state.selected === undefined) return { kind: 'none' }
  const path = state.roles.find(role => role.role === state.selected)?.path ?? state.selected
  const diff = unifiedDiff(path, state.defaultText, state.saved.text)
  return diff.patch === '' ? { kind: 'same' } : { kind: 'diff', diff }
}

/** The `{{names}}` in `text` that `variables` has no name for, once each, in order of first appearance. */
function unknownIn(text: string, variables: VariablesState): string[] {
  if (variables.status !== 'ready' || variables.fallback) return []
  // `interpolate` is the preset row's own: a name is known when it has a value, so every listed name gets one, empty or not.
  return interpolate(text, Object.fromEntries(variables.list.map(variable => [variable.name, '']))).unknown
}

/** What a call that did not succeed is, for the page: its notice, and for a refusal by the store its code and its own words. */
type Failed = { ok: false, notice: Notice, code?: ErrorCode, message?: string }

type Settled<T> = { ok: true, value: T } | Failed

/**
 * Wait for a call and fold both kinds of failure (the carrier's and the store's) into a `Notice`. Never throws.
 * @param action - what the person was doing, for the refusals whose wording depends on it.
 * @param remote - which remote the call is to, for the failures that name it.
 */
async function settle<T>(task: () => Promise<RemoteResult<Outcome<T>>>, action?: Action, remote = PROMPTS): Promise<Settled<T>> {
  try {
    const result = await task()
    if (!result.ok) return { ok: false, notice: unexpectedNotice(result.error, remote) }
    const outcome = result.value
    if (!outcome.ok) {
      return { ok: false, notice: failureNotice(outcome.code, outcome.message, action), code: outcome.code, message: outcome.message }
    }
    return { ok: true, value: outcome.value }
  } catch (error) {
    return { ok: false, notice: unexpectedNotice(error, remote) }
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
 * @param api - the `dishPrompts` remote.
 * @param config - dish-config's remote, when it is there. Give it later with `setConfig`.
 */
export function createPrompts(api: PromptsApi, config?: ConfigCalls): PromptsController {
  let configCalls = config
  const store = createStore<PageState>({
    roles: [],
    rolesLoaded: false,
    document: 'idle',
    defaultText: null,
    missing: false,
    readOnly: false,
    draft: '',
    note: '',
    dirty: false,
    tab: 'edit',
    variables: { status: 'loading', list: [], fallback: false },
    unknownVariables: [],
    hasHistory: config !== undefined,
    stream: config !== undefined ? 'connecting' : 'off',
  })
  const get = (): PageState => store.getSnapshot()
  const patch = (next: Partial<PageState>): void => { store.set({ ...get(), ...next }) }

  /** Bumped when an answer in flight stops being wanted: a newer read of the document or a write that is newer than it, another role. */
  let documentGeneration = 0
  let previewGeneration = 0
  let historyGeneration = 0
  /** Bumped when another role is opened (or the same one from nothing): a write's answer for an earlier one is not for this page. */
  let selection = 0
  /** A live event came while a write was under way: its read would see the page's own commit as someone else's, so it waits for the write to end. */
  let eventWhileWriting = false

  /** A save or a reset is under way. */
  const writing = (): boolean => get().busy === 'save' || get().busy === 'reset'

  /** After a write: the live event that came meanwhile is read now, when the page knows its own commit. */
  const settleEvents = async (): Promise<void> => {
    if (!eventWhileWriting) return
    eventWhileWriting = false
    await refreshSelected()
  }

  const pathOf = (role: string | undefined): string | undefined => get().roles.find(candidate => candidate.role === role)?.path

  /** Go back to Edit when the tab shown isn't one the page has any more. */
  const ensureTab = (): void => {
    const state = get()
    if (!visibleTabs(state).includes(state.tab)) patch({ tab: 'edit' })
  }

  // --- the document -------------------------------------------------------------------------------

  /** Take `read` as the document, and the draft with it. */
  const adopt = (read: ReadResult): void => {
    patch({
      document: 'ready',
      documentError: undefined,
      saved: { text: read.text, commit: read.commit },
      defaultText: read.defaultText,
      missing: read.missing,
      readOnly: read.commit === null,
      draft: read.text,
      note: '',
      dirty: false,
      conflict: undefined,
      unknownVariables: unknownIn(read.text, get().variables),
    })
    ensureTab()
  }

  /** Take `read` as what the draft is saved over, and keep the draft. */
  const rebase = (read: ReadResult): void => {
    const state = get()
    patch({
      document: 'ready',
      documentError: undefined,
      saved: { text: read.text, commit: read.commit },
      defaultText: read.defaultText,
      missing: read.missing,
      readOnly: read.commit === null,
      dirty: state.draft !== read.text,
      conflict: undefined,
    })
    ensureTab()
  }

  /**
   * What the tab shown needs when it has nothing: after a role was opened, or after a read that took the place of the one that
   * would have opened it. A tab that has something is left to the events that refresh it.
   */
  const loadMissingTab = async (): Promise<void> => {
    const { tab, preview, history } = get()
    if (tab === 'preview' && preview === undefined) await loadPreview()
    else if (tab === 'history' && history === undefined) await loadHistory()
  }

  /** Open `role` from nothing: what was shown of the last one goes. */
  const choose = async (role: string): Promise<void> => {
    const generation = ++documentGeneration
    selection++
    previewGeneration++
    historyGeneration++
    patch({
      selected: role,
      document: 'loading',
      documentError: undefined,
      saved: undefined,
      defaultText: null,
      missing: false,
      readOnly: false,
      draft: '',
      note: '',
      dirty: false,
      conflict: undefined,
      switching: undefined,
      notice: undefined,
      unknownVariables: [],
      preview: undefined,
      history: undefined,
    })
    const result = await settle(() => api.read(role))
    if (generation !== documentGeneration) return
    if (!result.ok) {
      patch({ document: 'error', documentError: result.notice })
      return
    }
    adopt(result.value)
    await loadMissingTab()
  }

  /**
   * What a live event about the selected document does: a clean page takes the new text; with edits, the page keeps them,
   * and the new text becomes the `conflict`, unless it is the text the page already has (the echo of its own save).
   */
  const refreshSelected = async (): Promise<void> => {
    const role = get().selected
    if (role === undefined) return
    if (writing()) {
      eventWhileWriting = true
      return
    }
    const generation = ++documentGeneration
    const result = await settle(() => api.read(role))
    if (generation !== documentGeneration) return
    if (!result.ok) {
      // A refresh that failed leaves what is shown alone, unless nothing is.
      if (get().saved === undefined) patch({ document: 'error', documentError: result.notice })
      return
    }
    const read = result.value
    const state = get()
    if (writing()) {
      eventWhileWriting = true
    } else if (!state.dirty) {
      adopt(read)
      // This read may have taken the place of the one that was to open the role, and with it the tab's load.
      await loadMissingTab()
    } else if (read.text !== state.saved?.text) {
      patch({ conflict: { theirs: read.text, commit: read.commit }, readOnly: read.commit === null })
    } else if (state.conflict !== undefined) {
      patch({ conflict: undefined })
    }
  }

  /**
   * Read the document again and take it, draft included. The draft goes first, before the read: a live event that comes while
   * it is out would otherwise find edits to protect and make a conflict of the very text this is fetching. If the read fails the
   * edit comes back, unless the person has typed since.
   */
  const reload = async (): Promise<void> => {
    const role = get().selected
    if (role === undefined) return
    const generation = ++documentGeneration
    const before = get()
    const { saved } = before
    if (saved === undefined) {
      patch({ document: 'loading', documentError: undefined })
    } else {
      patch({ draft: saved.text, note: '', dirty: false, conflict: undefined, unknownVariables: unknownIn(saved.text, before.variables) })
    }
    const result = await settle(() => api.read(role))
    if (generation !== documentGeneration) return
    if (!result.ok) {
      if (saved === undefined) {
        patch({ document: 'error', documentError: result.notice })
      } else {
        const kept = get().dirty ? {} : { draft: before.draft, note: before.note, dirty: before.dirty, conflict: before.conflict, unknownVariables: before.unknownVariables }
        patch({ ...kept, notice: { tone: 'error', ...result.notice } })
      }
      return
    }
    adopt(result.value)
    await loadMissingTab()
  }

  // --- the roles and the variables ----------------------------------------------------------------

  /** The roles as the server lists them now, `undefined` when it could not say. */
  const readRoles = async (): Promise<RoleInfo[] | undefined> => {
    const result = await settle(() => api.roles())
    if (!result.ok) {
      patch({ rolesLoaded: true, rolesError: result.notice })
      return undefined
    }
    patch({ roles: result.value, rolesLoaded: true, rolesError: undefined })
    return result.value
  }

  let rolesRunning: Promise<RoleInfo[] | undefined> | undefined
  let rolesAgain = false

  /**
   * Read the roles, one read at a time: a call while one is under way waits for it, and the roles are read once more after it, for
   * whatever changed meanwhile. Every caller gets the last answer, so none of them is left waiting on a read that was set aside.
   */
  const refreshRoles = (): Promise<RoleInfo[] | undefined> => {
    if (rolesRunning !== undefined) {
      rolesAgain = true
      return rolesRunning
    }
    rolesRunning = (async () => {
      try {
        let roles: RoleInfo[] | undefined
        do {
          rolesAgain = false
          roles = await readRoles()
        } while (rolesAgain)
        return roles
      } finally {
        rolesRunning = undefined
      }
    })()
    return rolesRunning
  }

  const loadVariables = async (): Promise<void> => {
    const result = await settle(() => api.variables())
    const variables: VariablesState = result.ok
      ? { status: 'ready', list: result.value.variables, fallback: result.value.fallback }
      // Not being able to read them is not worth a warning of its own: the page just has none to give.
      : { status: 'error', list: [], fallback: false }
    patch({ variables, unknownVariables: unknownIn(get().draft, variables) })
  }

  // --- the tabs -----------------------------------------------------------------------------------

  const loadPreview = async (): Promise<void> => {
    const role = get().selected
    if (role === undefined) return
    const generation = ++previewGeneration
    const previous = get().preview?.value
    patch({ preview: previous === undefined ? { status: 'loading' } : { status: 'loading', value: previous } })
    const result = await settle(() => api.preview(role))
    if (generation !== previewGeneration || get().selected !== role) return
    patch({ preview: result.ok ? { status: 'ready', value: result.value } : { status: 'error', error: result.notice } })
  }

  const loadHistory = async (): Promise<void> => {
    const calls = configCalls
    const role = get().selected
    const path = pathOf(role)
    if (calls === undefined || role === undefined) return
    const generation = ++historyGeneration
    const previous = get().history
    const details = previous?.details ?? {}
    const commits = previous?.commits ?? []
    if (path === undefined) {
      patch({ history: { status: 'error', commits, details, error: { text: `There is no prompt for ${role} to show the history of.` } } })
      return
    }
    patch({ history: { status: 'loading', commits, details } })
    const result = await settle(() => calls.history(path, HISTORY_PAGE, ''), undefined, CONFIG)
    if (generation !== historyGeneration) return
    const current = get().history?.details ?? details
    patch({
      history: result.ok
        ? { status: 'ready', commits: result.value, details: current }
        : { status: 'error', commits, details: current, error: result.notice },
    })
  }

  const loadCommit = async (id: string): Promise<void> => {
    const calls = configCalls
    const history = get().history
    if (calls === undefined || history === undefined) return
    // Loading or loaded is already in hand; a failed one is asked for again.
    const known = history.details[id]
    if (known !== undefined && known.status !== 'error') return
    const setDetail = (detail: DetailState): void => {
      const current = get().history
      if (current !== undefined) patch({ history: { ...current, details: { ...current.details, [id]: detail } } })
    }
    setDetail({ status: 'loading' })
    const result = await settle(() => calls.commit(id), undefined, CONFIG)
    // The log was left (another role) or the row is gone: this answer is for nothing.
    if (get().history?.details[id]?.status !== 'loading') return
    setDetail(result.ok ? { status: 'ready', info: result.value.info, diffs: result.value.diffs } : { status: 'error', error: result.notice })
  }

  /** After the stored texts changed: what the tab shown reads again, and what is not shown is dropped to be read when its tab opens. */
  const refreshPreview = async (): Promise<void> => {
    if (get().tab === 'preview') await loadPreview()
    else if (get().preview !== undefined) {
      previewGeneration++
      patch({ preview: undefined })
    }
  }

  const refreshHistory = async (): Promise<void> => {
    // The tab shown loads even when it has nothing yet: a role opened just now may not have got to it.
    if (get().tab === 'history') await loadHistory()
    else if (get().history !== undefined) {
      historyGeneration++
      patch({ history: undefined })
    }
  }

  // --- writing --------------------------------------------------------------------------------------

  /**
   * A refusal of a write: the notice, and after a `CONFLICT` the text that is there now, so the person can see what changed. For a
   * role the page has left, the notice says which one, in the store's own words: what the friendly text says of "the editor" is
   * not true of it any more.
   */
  const refused = async (failure: Failed, role: string, chosen: number, verb: 'save' | 'reset'): Promise<void> => {
    if (chosen === selection) {
      patch({ notice: { tone: 'error', ...failure.notice } })
    } else {
      patch({ notice: { tone: 'error', text: `Couldn't ${verb} ${roleLabel(role)}`, detail: failure.message ?? failure.notice.text } })
    }
    if (failure.code === 'CONFLICT' && chosen === selection) {
      const theirs = await settle(() => api.read(role))
      if (theirs.ok && chosen === selection) patch({ conflict: { theirs: theirs.value.text, commit: theirs.value.commit } })
    }
    await settleEvents()
  }

  /** After a write that changed the stored prompt: the list's dots, the shown tab, and the log. */
  const refreshAfterWrite = async (): Promise<void> => {
    await Promise.all([refreshRoles(), refreshPreview(), refreshHistory()])
  }

  const save = async (): Promise<void> => {
    const state = get()
    const { selected: role, saved } = state
    // With a conflict open the save would be refused again: the person picks Reload or Keep mine first.
    if (!state.dirty || state.busy !== undefined || state.conflict !== undefined || role === undefined || saved === undefined) return
    const text = state.draft
    const chosen = selection
    const label = roleLabel(role)
    patch({ busy: 'save', notice: undefined })
    const result = await settle(() => api.save(role, text, saved.commit ?? '', state.note), 'save')
    patch({ busy: undefined })
    if (!result.ok) {
      await refused(result, role, chosen, 'save')
      return
    }
    const commit = result.value
    if (commit === null) {
      // The document already says this. Its commit is the one to save over from now on.
      patch({ notice: { tone: 'info', text: `Nothing to save for ${label}: the store already has this text.` } })
      if (chosen === selection) {
        const generation = ++documentGeneration
        const read = await settle(() => api.read(role))
        if (read.ok && generation === documentGeneration) rebase(read.value)
      }
      await settleEvents()
      return
    }
    patch({ notice: { tone: 'success', text: `Saved ${label} as ${shortId(commit.id)}` } })
    if (chosen === selection) {
      // A read that began before this save is older than it, and must not put the old text back when it lands.
      documentGeneration++
      // What was typed while the save was under way stays, and is still unsaved.
      patch({
        saved: { text, commit: commit.id },
        missing: false,
        dirty: get().draft !== text,
        note: get().draft === text ? '' : get().note,
        conflict: undefined,
      })
    }
    await Promise.all([refreshAfterWrite(), settleEvents()])
  }

  const reset = async (): Promise<void> => {
    const state = get()
    const { selected: role, saved } = state
    if (state.busy !== undefined || role === undefined || saved === undefined || state.defaultText === null) return
    const chosen = selection
    const label = roleLabel(role)
    patch({ busy: 'reset', notice: undefined })
    const result = await settle(() => api.reset(role, saved.commit ?? '', RESET_NOTE), 'reset')
    patch({ busy: undefined })
    if (!result.ok) {
      await refused(result, role, chosen, 'reset')
      return
    }
    const commit = result.value
    patch({
      notice: commit === null
        ? { tone: 'info', text: `${label}: ${ALREADY_DEFAULT}` }
        : { tone: 'success', text: `Reset ${label} to the default as ${shortId(commit.id)}` },
    })
    if (chosen === selection) {
      // The editor shows the default, an unsaved edit included: that is what the person asked for. A read that began before the
      // reset is older than it, so this one takes the place of any that is out.
      const generation = ++documentGeneration
      const read = await settle(() => api.read(role))
      if (read.ok && generation === documentGeneration && chosen === selection) {
        adopt(read.value)
        // What a held live event would have shown is in what was just read.
        eventWhileWriting = false
      }
    }
    await Promise.all([refreshAfterWrite(), settleEvents()])
  }

  const revert = async (id: string): Promise<void> => {
    const calls = configCalls
    if (calls === undefined || get().busy !== undefined) return
    patch({ busy: `revert:${id}`, notice: undefined })
    const result = await settle(() => calls.revert(id), 'revert', CONFIG)
    patch({ busy: undefined })
    if (!result.ok) {
      patch({ notice: { tone: 'error', ...result.notice } })
      return
    }
    if (result.value === null) {
      patch({ notice: { tone: 'info', text: NOTHING_TO_REVERT } })
      return
    }
    patch({ notice: { tone: 'success', text: `Reverted ${shortId(id)} with a new commit, ${shortId(result.value.id)}` } })
    // The revert may have changed this document, and others, and the log has a new commit.
    await Promise.all([loadHistory(), refreshRoles(), refreshSelected(), refreshPreview()])
  }

  // --- the face -----------------------------------------------------------------------------------

  const select = async (role: string): Promise<void> => {
    const state = get()
    if (role === state.selected && state.document !== 'error') return
    if (state.dirty && state.selected !== undefined) {
      patch({ switching: role })
      return
    }
    await choose(role)
  }

  const setTab = async (tab: Tab): Promise<void> => {
    if (!visibleTabs(get()).includes(tab)) return
    patch({ tab })
    if (tab === 'preview') await loadPreview()
    else if (tab === 'history') await loadHistory()
  }

  const open = async (): Promise<void> => {
    const [roles] = await Promise.all([refreshRoles(), loadVariables()])
    if (get().selected !== undefined) {
      await refreshSelected()
      return
    }
    const list = roles ?? get().roles
    const first = list.find(role => role.role === 'main') ?? list[0]
    if (first !== undefined) await choose(first.role)
  }

  const face: PromptsActions = {
    // A store to read and subscribe to, not the one the controller writes.
    hooks: { page: { getSnapshot: store.getSnapshot, subscribe: store.subscribe } },
    open,
    select,
    async confirmSwitch() {
      const role = get().switching
      if (role !== undefined) await choose(role)
    },
    cancelSwitch() {
      patch({ switching: undefined })
    },
    edit(text) {
      const { saved, variables } = get()
      if (saved === undefined) return
      patch({ draft: text, dirty: text !== saved.text, unknownVariables: unknownIn(text, variables) })
    },
    setNote(note) {
      patch({ note })
    },
    save,
    discard() {
      const { saved, conflict } = get()
      if (saved === undefined) return
      // With a conflict, "what is saved" is what the store has now: the page already holds it.
      const target = conflict === undefined ? saved : { text: conflict.theirs, commit: conflict.commit }
      patch({ saved: target, draft: target.text, note: '', dirty: false, conflict: undefined, unknownVariables: unknownIn(target.text, get().variables) })
    },
    reset,
    reload,
    keepMine() {
      const { conflict, draft, saved } = get()
      if (conflict === undefined || saved === undefined) return
      patch({ saved: { text: conflict.theirs, commit: conflict.commit }, dirty: draft !== conflict.theirs, conflict: undefined })
    },
    setTab,
    loadPreview,
    loadVariables,
    loadHistory,
    loadCommit,
    revert,
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
        await Promise.all([refreshRoles(), refreshSelected(), refreshPreview(), refreshHistory()])
        return
      }
      switch (event.kind) {
        case 'changed': {
          const prompts = event.paths.filter(path => path.startsWith('prompts/'))
          if (prompts.length === 0) return
          const tasks: Array<Promise<unknown>> = [refreshRoles(), refreshPreview()]
          const path = pathOf(get().selected)
          if (path !== undefined && prompts.includes(path)) tasks.push(refreshSelected(), refreshHistory())
          await Promise.all(tasks)
          return
        }
        case 'proposal':
          await refreshRoles()
          return
        case 'remote':
          return
      }
    },
    streamDown() {
      if (get().hasHistory) patch({ stream: 'down' })
    },
    setConfig(calls) {
      configCalls = calls
      historyGeneration++
      patch(calls === undefined
        ? { hasHistory: false, stream: 'off', history: undefined }
        : { hasHistory: true, stream: 'connecting' })
      ensureTab()
    },
  }
}
