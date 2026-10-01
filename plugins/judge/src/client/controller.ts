/**
 * The Settings → Judge page's state and what it does: it calls the remotes, keeps what it learns in one snapshot store, and
 * reacts to what dish-config's `watch` says. No React here, and nothing that only a browser or only dsh can load, so
 * `node --test` runs it against fake remotes (`test/controller.test.ts`). The components read the store through the `usePage`
 * hook the slot gives them and act through `JudgeActions`.
 *
 * The page has four parts, each with its own corner of the state:
 *
 * - **The key.** The browser sets, removes and describes it through dsh's own `credentials` remote (`CredentialsCalls`), and
 *   the judge's remote is never part of it: no call of this page's own takes or returns a key. The input holds what the person
 *   typed; it is **emptied the moment a save is sent** (not when it is answered), so it is in no snapshot that outlives the
 *   click, and whatever a failure says has the key taken out of it before it is shown. The card knows only "set" or "not set",
 *   where the value comes from, and whether dsh can change it.
 * - **The status.** What `status` says, and the result of the Test button. The credential's name comes from here.
 * - **The thresholds.** A form over `judge.yaml`, as text fields (`thresholds.ts`). `saved` is what the store had when the page
 *   read it, with the commit it read it at (what a save passes as `base`). The form is clean when what it would send is what is
 *   saved. A **conflict** is the store telling the form it is out of date: a save was refused as `CONFLICT`, or a live event
 *   says the document changed while the form had edits. The form stays; `conflict` holds what is there now. A clean form just
 *   reads the new values. What is valid is the server's to say: a save it refuses is shown with its message, and the form stays.
 *   The History tab and live updates come from dish-config's remote, which may not be there (`setConfig`).
 * - **The decisions.** A filter (a purpose, and any decision text), a page of lines newest first, and `next` to go on from.
 *   A line with withheld content opens it on request, one call for each id. Everything the log gives is data to show as text.
 *
 * Answers that arrive after the person has moved on are dropped, by a counter per kind of answer.
 */

import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { FileDiff } from 'dish-kit/ui/diff'
import type { CommitInfo, ErrorCode, LogLine, Outcome, PurposeName, SettingsValues, StatusInfo, TestResult, ThresholdsRead } from '../protocol.ts'
import { shortId, sourceLabel } from './format.ts'
import { NOTHING_TO_REVERT, NOTHING_TO_SAVE, failureNotice, unexpectedNotice } from './outcome.ts'
import type { Action, Notice } from './outcome.ts'
import type { ConfigCalls, ConfigEvent, CredentialsCalls, JudgeApi } from './remote.ts'
import { formOf, formWarnings, sameSettings, settingsOf } from './thresholds.ts'
import type { FieldName, ThresholdForm } from './thresholds.ts'

/** How many commits the History tab asks for. */
export const HISTORY_PAGE = 20

/** How many log lines a page of the table asks for. */
export const LOG_PAGE = 100

/** The most lines the table keeps: past it the person narrows the filter, and nothing is held that a person will not scroll to. */
export const LOG_MAX = 1_000

/** The document the thresholds are in. */
export const DOCUMENT = 'judge.yaml'

/** What the page calls its remotes when a call fails before the server is reached. */
const JUDGE = 'dish-judge'
const CONFIG = 'dish-config'
const DSH = 'dsh'

export type Load = 'idle' | 'loading' | 'ready' | 'error'

/** The outcome of the last thing the person did, shown until they move on. */
export interface PageNotice extends Notice {
  tone: 'info' | 'success' | 'error'
}

// --- the state -----------------------------------------------------------------------------------------

export interface StatusState {
  load: Load
  /** The last status that arrived: kept while the next loads. */
  value?: StatusInfo
  error?: Notice
}

export type TestState =
  | { phase: 'idle' }
  | { phase: 'running' }
  | { phase: 'done', result: TestResult }
  | { phase: 'failed', notice: Notice }

export interface KeyState {
  /** `unavailable` when dsh's credentials remote isn't there; `idle` until the first look. */
  load: 'idle' | 'loading' | 'ready' | 'error' | 'unavailable'
  /** The credential's name, from the status. */
  keyName?: string
  /** dsh says a value is supplied for it. Never the value. */
  configured: boolean
  /** Where it comes from, in dsh's words (`environment`, a file); not there while there is none. */
  source?: string
  /** dsh can write it. `false` for a key the launch environment supplies. */
  writable: boolean
  /** What the person has typed. Emptied when a save is sent. */
  input: string
  busy?: 'save' | 'remove'
  notice?: PageNotice
  /** Why the card couldn't be read. */
  error?: Notice
}

/** The thresholds' document as the page loaded it: its text, the settings in it, and the store commit that was read (`null` when there is no store). */
export interface Saved {
  text: string
  settings: SettingsValues
  commit: string | null
}

export type ThresholdTab = 'edit' | 'history'

/** One commit's diff, fetched when its row opens. */
export type DetailState =
  | { status: 'loading' }
  | { status: 'ready', info: CommitInfo, diffs: FileDiff[] }
  | { status: 'error', error: Notice }

export interface HistoryState {
  status: 'loading' | 'ready' | 'error'
  commits: CommitInfo[]
  error?: Notice
  /** By commit id. A commit's diff never changes, so these outlive a reload of the log. */
  details: Record<string, DetailState>
}

/** What is being done now, so a second click can't start it again: a save, or `revert:<commit id>`. */
export type ThresholdsBusy = 'save' | `revert:${string}`

export interface ThresholdsState {
  load: Load
  loadError?: Notice
  saved?: Saved
  /** The document isn't in the store, and `saved` is the shipped default. Saving adds it. */
  missing: boolean
  /** There is no store to save to: the page shows the shipped default. */
  readOnly: boolean
  /** Why the stored text isn't in use, when it doesn't pass the check: the judge uses the shipped default until it is replaced. */
  problem?: string
  form: ThresholdForm
  /** The optional note a save will carry. */
  note: string
  /** What the form would send isn't what is saved. */
  dirty: boolean
  /** Advice that doesn't block a save (see `formWarnings`). */
  warnings: string[]
  /** What the store has now, when it is not what the page loaded and the form has edits. */
  conflict?: Saved
  busy?: ThresholdsBusy
  notice?: PageNotice
  tab: ThresholdTab
  /** The history, once its tab has been opened. */
  history?: HistoryState
}

export interface LogFilter {
  /** `''` for all. */
  purpose: PurposeName | ''
  /** `''` for all; else any text: the set of decisions is open. */
  decision: string
}

/** What a line's withheld content is, once asked for: shown or folded away, and loading, in hand or not readable. */
export type WithheldView = { open: boolean } & (
  | { status: 'loading' }
  | { status: 'ready', tool: string, content: string }
  | { status: 'error', notice: Notice }
)

export interface DecisionsState {
  filter: LogFilter
  load: Load
  error?: Notice
  /** Newest first. */
  lines: LogLine[]
  /** What to ask for the page after these lines; not there when there are no older ones. */
  next?: string
  /** How many lines of the log the pages so far could not read. */
  skipped: number
  more: 'idle' | 'loading' | 'error'
  moreError?: Notice
  /** `LOG_MAX` lines are in hand, and there are older ones the filter would have to be narrowed to reach. */
  capped: boolean
  /** By withheld id. */
  withheld: Record<string, WithheldView>
}

export interface PageState {
  status: StatusState
  test: TestState
  key: KeyState
  thresholds: ThresholdsState
  decisions: DecisionsState
  /** dish-config's remote is there: the History tab shows, and live updates can arrive. */
  hasHistory: boolean
  /** Whether dish-config's `watch` is delivering: `off` without its remote, `down` between a lost carrier and the next item. */
  stream: 'off' | 'connecting' | 'live' | 'down'
}

/** What a component can ask of the page, beside the `usePage` hook the `hooks` entry becomes. */
export interface JudgeActions {
  hooks: { page: ObservableSnapshot<PageState> }
  /** The page was shown: load what it needs, or read again what it has. */
  open(): Promise<void>

  /** Ask dsh again whether the key is set. */
  refreshKey(): Promise<void>
  /** What the person typed in the key field. */
  setKeyInput(text: string): void
  saveKey(): Promise<void>
  removeKey(): Promise<void>
  dismissKeyNotice(): void

  refreshStatus(): Promise<void>
  runTest(): Promise<void>

  editField(field: FieldName, text: string): void
  setNote(note: string): void
  save(): Promise<void>
  /** Back to the saved values. */
  discard(): void
  /** After a conflict: read the store's values again and drop the form's edits. */
  reload(): Promise<void>
  /** After a conflict: keep the form, with the store's values as what it is saved over. */
  keepMine(): void
  setTab(tab: ThresholdTab): Promise<void>
  loadHistory(): Promise<void>
  loadCommit(id: string): Promise<void>
  revert(id: string): Promise<void>
  dismissThresholdsNotice(): void

  /** Narrow or widen the table: only what is given changes, and the table is read again from the newest. */
  setFilter(filter: Partial<LogFilter>): Promise<void>
  refreshDecisions(): Promise<void>
  loadMore(): Promise<void>
  /** Open a line's withheld content (reading it the first time), or fold it away. */
  toggleWithheld(id: string): Promise<void>
}

export interface JudgeController {
  /** What the component gets: the observable and the actions, and nothing that feeds the controller. */
  face: JudgeActions
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
  /** dsh's credentials remote arrived, or went; `undefined` for gone. */
  setCredentials(calls: CredentialsCalls | undefined): void
  /** dsh says the credential named `ref` changed (set from another page, say): read it again if it is ours. */
  keyChanged(ref: string): void
}

/** The tabs the thresholds card offers now, in order: History only with dish-config's remote. */
export function thresholdTabs(state: Pick<PageState, 'hasHistory'>): ThresholdTab[] {
  return state.hasHistory ? ['edit', 'history'] : ['edit']
}

/**
 * Whether Save does anything now: there is a store to save to, and either the form differs from what is saved, or the document
 * is missing or broken in the store and saving the form (the default's values, to begin with) is how it comes back.
 */
export function canSave(thresholds: Pick<ThresholdsState, 'dirty' | 'missing' | 'problem' | 'readOnly' | 'busy' | 'conflict' | 'saved'>): boolean {
  return thresholds.saved !== undefined
    && !thresholds.readOnly
    && thresholds.busy === undefined
    && thresholds.conflict === undefined
    && (thresholds.dirty || thresholds.missing || thresholds.problem !== undefined)
}

// --- plumbing ----------------------------------------------------------------------------------------------

/** What a call that did not succeed is, for the page: its notice, and for a refusal its code and its own words. */
type Failed = { ok: false, notice: Notice, code?: ErrorCode, message?: string }

type Settled<T> = { ok: true, value: T } | Failed

/**
 * Wait for a call that answers with an `Outcome` and fold both kinds of failure (the carrier's and the server's) into a
 * `Notice`. Never throws.
 * @param action - what the person was doing, for the refusals whose wording depends on it.
 * @param remote - which remote the call is to, for the failures that name it.
 */
async function settle<T>(task: () => Promise<RemoteResult<Outcome<T>>>, action?: Action, remote = JUDGE): Promise<Settled<T>> {
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

/** Wait for a call that answers with a value and no `Outcome` (`status`, and dsh's own calls). Never throws. */
async function settlePlain<T>(task: () => Promise<RemoteResult<T>>, remote: string, scrub: (text: string) => string = text => text): Promise<{ ok: true, value: T } | { ok: false, notice: Notice }> {
  const hide = (notice: Notice): Notice => notice.detail === undefined ? { text: scrub(notice.text) } : { text: scrub(notice.text), detail: scrub(notice.detail) }
  try {
    const result = await task()
    return result.ok ? { ok: true, value: result.value } : { ok: false, notice: hide(unexpectedNotice(result.error, remote)) }
  } catch (error) {
    return { ok: false, notice: hide(unexpectedNotice(error, remote)) }
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
 * `text` with every form `secret` can take in a text (as it is, JSON-escaped, URL-encoded) replaced by `…`: for what a
 * failure says, which must not carry a key back to the screen. A value too short to be a key is left, as it would turn every
 * letter that is the same into noise.
 */
function hiding(secret: string): (text: string) => string {
  if (secret.length < 4) return text => text
  const forms = [...new Set([secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)])]
  return text => forms.reduce((hidden, form) => hidden.split(form).join('…'), text)
}

function toSaved(read: ThresholdsRead): Saved {
  return { text: read.text, settings: read.settings, commit: read.commit }
}

const EMPTY_FORM: ThresholdForm = { model: '', timeoutMs: '', readOnly: '', reversible: '', servesTask: '', withhold: '', warn: '', chunkChars: '', gated: '', screened: '' }

/**
 * @param api - the `dishJudge` remote.
 * @param config - dish-config's remote, when it is there. Give it later with `setConfig`.
 * @param credentials - dsh's credentials remote, when it is there. Give it later with `setCredentials`.
 */
export function createJudgePage(api: JudgeApi, config?: ConfigCalls, credentials?: CredentialsCalls): JudgeController {
  let configCalls = config
  let credentialCalls = credentials
  const store = createStore<PageState>({
    status: { load: 'idle' },
    test: { phase: 'idle' },
    key: { load: credentials === undefined ? 'unavailable' : 'idle', configured: false, writable: true, input: '' },
    thresholds: { load: 'idle', missing: false, readOnly: false, form: EMPTY_FORM, note: '', dirty: false, warnings: [], tab: 'edit' },
    decisions: { filter: { purpose: '', decision: '' }, load: 'idle', lines: [], skipped: 0, more: 'idle', capped: false, withheld: {} },
    hasHistory: config !== undefined,
    stream: config !== undefined ? 'connecting' : 'off',
  })
  const get = (): PageState => store.getSnapshot()
  const patch = (next: Partial<PageState>): void => { store.set({ ...get(), ...next }) }
  const patchStatus = (next: Partial<StatusState>): void => { patch({ status: { ...get().status, ...next } }) }
  const patchKey = (next: Partial<KeyState>): void => { patch({ key: { ...get().key, ...next } }) }
  const patchT = (next: Partial<ThresholdsState>): void => { patch({ thresholds: { ...get().thresholds, ...next } }) }
  const patchD = (next: Partial<DecisionsState>): void => { patch({ decisions: { ...get().decisions, ...next } }) }

  /** Bumped when an answer in flight stops being wanted: a newer read of its kind, or a write that is newer than it. */
  let statusGeneration = 0
  let keyGeneration = 0
  let documentGeneration = 0
  let historyGeneration = 0
  let decisionsGeneration = 0
  /** A live event came while a save was under way: its read would see the page's own commit as someone else's, so it waits for the save to end. */
  let eventWhileWriting = false

  const writing = (): boolean => get().thresholds.busy === 'save'

  // --- the status and the test ----------------------------------------------------------------------

  const refreshStatus = async (): Promise<void> => {
    const generation = ++statusGeneration
    patchStatus({ load: 'loading', error: undefined })
    const result = await settlePlain(() => api.status(), JUDGE)
    if (generation !== statusGeneration) return
    if (!result.ok) {
      patchStatus({ load: 'error', error: result.notice })
      return
    }
    const known = get().key.keyName
    patchStatus({ load: 'ready', value: result.value, error: undefined })
    // The credential's name is the status's; the card reads it again when the name is new.
    if (known !== result.value.keyName) {
      patchKey({ keyName: result.value.keyName })
      await loadKey()
    }
  }

  const runTest = async (): Promise<void> => {
    if (get().test.phase === 'running') return
    patch({ test: { phase: 'running' } })
    const result = await settle(() => api.test())
    patch({ test: result.ok ? { phase: 'done', result: result.value } : { phase: 'failed', notice: result.notice } })
    // The call is in the status's window now, and may have changed whether the judge is reachable.
    await refreshStatus()
  }

  // --- the key --------------------------------------------------------------------------------------

  /** Ask dsh about the credential the status names. */
  async function loadKey(): Promise<void> {
    const calls = credentialCalls
    const keyName = get().key.keyName
    if (calls === undefined) {
      patchKey({ load: 'unavailable' })
      return
    }
    if (keyName === undefined) return
    const generation = ++keyGeneration
    patchKey({ load: get().key.load === 'ready' ? 'ready' : 'loading', error: undefined })
    const result = await settlePlain(() => calls.describe([keyName]), DSH)
    if (generation !== keyGeneration) return
    if (!result.ok) {
      patchKey({ load: 'error', error: result.notice })
      return
    }
    const view = result.value[keyName]
    // An unknown reference is treated as writable: the card stays usable, and dsh is what refuses.
    patchKey({ load: 'ready', error: undefined, configured: view?.configured ?? false, writable: view?.writable ?? true, source: view?.source })
  }

  /** What a key action needs and may do: the calls, the name, and no other action under way. `undefined` says why not, as a notice. */
  const keyReady = (): { calls: CredentialsCalls, keyName: string } | undefined => {
    const { key } = get()
    if (credentialCalls === undefined || key.keyName === undefined || key.busy !== undefined) return undefined
    return { calls: credentialCalls, keyName: key.keyName }
  }

  const saveKey = async (): Promise<void> => {
    const ready = keyReady()
    if (ready === undefined) return
    const value = get().key.input.trim()
    if (value === '') {
      patchKey({ notice: { tone: 'error', text: 'Paste the TypeSafe key first.' } })
      return
    }
    if (!get().key.writable) {
      patchKey({ input: '', notice: { tone: 'error', text: `dsh can't change this key from here: it comes from ${sourceLabel(get().key.source)}. Change it there.` } })
      return
    }
    // The input is emptied now, before anything is sent or answered, so no snapshot after this click holds the key.
    patchKey({ input: '', busy: 'save', notice: undefined })
    const hide = hiding(value)
    const result = await settlePlain(() => ready.calls.set(ready.keyName, value), DSH, hide)
    if (!result.ok) {
      patchKey({ busy: undefined, notice: { tone: 'error', text: 'The key was not saved.', detail: result.notice.detail ?? result.notice.text } })
      return
    }
    patchKey({ busy: undefined })
    await Promise.all([loadKey(), refreshStatus()])
    // dsh is the only authority on whether the key now exists.
    patchKey(get().key.configured
      ? { notice: { tone: 'success', text: 'Key saved. The judge can use it now.' } }
      : { notice: { tone: 'error', text: 'dsh took the key but reports none set for this name. Check where the credential comes from.' } })
  }

  const removeKey = async (): Promise<void> => {
    const ready = keyReady()
    if (ready === undefined) return
    if (!get().key.writable) {
      patchKey({ notice: { tone: 'error', text: `dsh can't remove this key from here: it comes from ${sourceLabel(get().key.source)}. Change it there.` } })
      return
    }
    patchKey({ input: '', busy: 'remove', notice: undefined })
    const result = await settlePlain(() => ready.calls.unset(ready.keyName), DSH)
    patchKey({ busy: undefined })
    if (!result.ok) {
      patchKey({ notice: { tone: 'error', text: 'The key was not removed.', detail: result.notice.detail ?? result.notice.text } })
      return
    }
    await Promise.all([loadKey(), refreshStatus()])
    patchKey({ notice: { tone: 'success', text: 'Key removed. Until one is set, the gate asks you about every command and children are refused.' } })
  }

  // --- the thresholds ---------------------------------------------------------------------------------

  /** The warnings of `form` against `saved`, none without a saved document to compare with. */
  const warningsOf = (form: ThresholdForm, saved: Saved | undefined): string[] => saved === undefined ? [] : formWarnings(form, saved.settings)

  /** Take `read` as the document, and the form with it. */
  const adopt = (read: ThresholdsRead): void => {
    const saved = toSaved(read)
    const form = formOf(read.settings)
    patchT({
      load: 'ready',
      loadError: undefined,
      saved,
      missing: read.missing,
      readOnly: read.commit === null,
      problem: read.problem,
      form,
      note: '',
      dirty: false,
      warnings: warningsOf(form, saved),
      conflict: undefined,
    })
  }

  /** What the form would send, as `Saved` has its settings. */
  const dirtyFor = (form: ThresholdForm, saved: Saved | undefined): boolean => saved !== undefined && !sameSettings(settingsOf(form), saved.settings)

  const loadThresholds = async (): Promise<void> => {
    const generation = ++documentGeneration
    patchT({ load: 'loading', loadError: undefined })
    const result = await settle(() => api.thresholds())
    if (generation !== documentGeneration) return
    if (!result.ok) {
      patchT({ load: 'error', loadError: result.notice })
      return
    }
    adopt(result.value)
  }

  /**
   * What a live event about the document does: a clean form takes the new values; with edits, the page keeps them, and what is
   * there now becomes the `conflict`, unless it is the text the page already has (the echo of its own save).
   */
  const refreshThresholds = async (): Promise<void> => {
    if (get().thresholds.saved === undefined && get().thresholds.load !== 'ready') {
      await loadThresholds()
      return
    }
    if (writing()) {
      eventWhileWriting = true
      return
    }
    const generation = ++documentGeneration
    const result = await settle(() => api.thresholds())
    if (generation !== documentGeneration) return
    if (!result.ok) {
      // A refresh that failed leaves what is shown alone, unless nothing is.
      if (get().thresholds.saved === undefined) patchT({ load: 'error', loadError: result.notice })
      return
    }
    const read = result.value
    const state = get().thresholds
    if (writing()) {
      eventWhileWriting = true
    } else if (!state.dirty) {
      adopt(read)
    } else if (read.text !== state.saved?.text) {
      patchT({ conflict: toSaved(read), readOnly: read.commit === null })
    } else if (state.conflict !== undefined) {
      patchT({ conflict: undefined })
    }
  }

  /** After a save: the live event that came meanwhile is read now, when the page knows its own commit. */
  const settleEvents = async (): Promise<void> => {
    if (!eventWhileWriting) return
    eventWhileWriting = false
    await refreshThresholds()
  }

  const editField = (field: FieldName, text: string): void => {
    const state = get().thresholds
    // The form is the person's, except while a save is going: what is typed then would be neither saved nor kept.
    if (state.saved === undefined || state.busy !== undefined || state.readOnly) return
    const form = { ...state.form, [field]: text }
    patchT({ form, dirty: dirtyFor(form, state.saved), warnings: warningsOf(form, state.saved) })
  }

  /** A refusal of a save: the notice, and after a `CONFLICT` what is there now, so the person can see what changed. */
  const refused = async (failure: Failed): Promise<void> => {
    patchT({ notice: { tone: 'error', ...failure.notice } })
    if (failure.code === 'CONFLICT') {
      // Like any read of the document, this one is dropped if a newer one (an event's, say) has been started since.
      const generation = ++documentGeneration
      const theirs = await settle(() => api.thresholds())
      if (theirs.ok && generation === documentGeneration) patchT({ conflict: toSaved(theirs.value) })
    }
    await settleEvents()
  }

  const save = async (): Promise<void> => {
    const state = get().thresholds
    if (!canSave(state) || state.saved === undefined) return
    const sent = settingsOf(state.form)
    patchT({ busy: 'save', notice: undefined })
    const result = await settle(() => api.saveThresholds(sent, state.saved?.commit ?? '', state.note), 'save')
    if (!result.ok) {
      patchT({ busy: undefined })
      await refused(result)
      return
    }
    const commit = result.value
    patchT({
      notice: commit === null
        ? { tone: 'info', text: NOTHING_TO_SAVE }
        : { tone: 'success', text: `Saved as ${shortId(commit.id)}. The judge uses it from its next call.` },
    })
    // What is in the store now is what the form shows: read at the commit, so the form's base and its text are one moment.
    // Nothing was typed since the save began (editing waits for it), and an edit another writer made right after is shown as it is.
    const generation = ++documentGeneration
    const read = await settle(() => api.thresholds())
    // The save is over only now: until the form has what was saved, an event for this very commit is the page's own, and waits
    // (`refreshThresholds` holds it while `busy` is `save`, and `settleEvents` reads it below).
    patchT({ busy: undefined })
    if (read.ok && generation === documentGeneration) adopt(read.value)
    else if (!read.ok && generation === documentGeneration && commit !== null) {
      // The save is in; the form's own values are what was saved, and the commit is the one to save over from now on.
      patchT({ saved: { text: state.saved.text, settings: sent, commit: commit.id }, dirty: false, missing: false, problem: undefined, note: '', conflict: undefined })
    }
    await Promise.all([refreshHistory(), settleEvents()])
  }

  const discard = (): void => {
    const { saved, conflict } = get().thresholds
    if (saved === undefined) return
    // With a conflict, "what is saved" is what the store has now: the page already holds it.
    const target = conflict ?? saved
    const form = formOf(target.settings)
    patchT({ saved: target, form, note: '', dirty: false, warnings: warningsOf(form, target), conflict: undefined })
  }

  const reload = async (): Promise<void> => {
    const generation = ++documentGeneration
    const before = get().thresholds
    // The edit goes first, before the read: a live event that comes while it is out would otherwise find edits to protect and
    // make a conflict of the very document this is fetching.
    if (before.saved === undefined) {
      patchT({ load: 'loading', loadError: undefined })
    } else {
      const form = formOf(before.saved.settings)
      patchT({ form, note: '', dirty: false, warnings: warningsOf(form, before.saved), conflict: undefined })
    }
    const result = await settle(() => api.thresholds())
    if (generation !== documentGeneration) return
    if (!result.ok) {
      if (before.saved === undefined) patchT({ load: 'error', loadError: result.notice })
      else {
        // The edit comes back, unless the person has typed since.
        patchT(get().thresholds.dirty ? { notice: { tone: 'error', ...result.notice } } : { form: before.form, note: before.note, dirty: before.dirty, conflict: before.conflict, warnings: before.warnings, notice: { tone: 'error', ...result.notice } })
      }
      return
    }
    adopt(result.value)
  }

  const keepMine = (): void => {
    const { conflict, form } = get().thresholds
    if (conflict === undefined) return
    patchT({ saved: conflict, dirty: dirtyFor(form, conflict), warnings: warningsOf(form, conflict), conflict: undefined, readOnly: conflict.commit === null })
  }

  // --- the history ----------------------------------------------------------------------------------

  async function loadHistory(): Promise<void> {
    const calls = configCalls
    if (calls === undefined) return
    const generation = ++historyGeneration
    const previous = get().thresholds.history
    const details = previous?.details ?? {}
    const commits = previous?.commits ?? []
    patchT({ history: { status: 'loading', commits, details } })
    const result = await settle(() => calls.history(DOCUMENT, HISTORY_PAGE, ''), undefined, CONFIG)
    if (generation !== historyGeneration) return
    const current = get().thresholds.history?.details ?? details
    patchT({
      history: result.ok
        ? { status: 'ready', commits: result.value, details: current }
        : { status: 'error', commits, details: current, error: result.notice },
    })
  }

  const loadCommit = async (id: string): Promise<void> => {
    const calls = configCalls
    const history = get().thresholds.history
    if (calls === undefined || history === undefined) return
    // Loading or loaded is already in hand; a failed one is asked for again.
    const known = history.details[id]
    if (known !== undefined && known.status !== 'error') return
    const setDetail = (detail: DetailState): void => {
      const current = get().thresholds.history
      if (current !== undefined) patchT({ history: { ...current, details: { ...current.details, [id]: detail } } })
    }
    setDetail({ status: 'loading' })
    const result = await settle(() => calls.commit(id), undefined, CONFIG)
    // The log was left or the row is gone: this answer is for nothing.
    if (get().thresholds.history?.details[id]?.status !== 'loading') return
    setDetail(result.ok ? { status: 'ready', info: result.value.info, diffs: result.value.diffs } : { status: 'error', error: result.notice })
  }

  /** After the stored text changed: the tab shown reads again, and what is not shown is dropped to be read when its tab opens. */
  async function refreshHistory(): Promise<void> {
    if (get().thresholds.tab === 'history') await loadHistory()
    else if (get().thresholds.history !== undefined) {
      historyGeneration++
      patchT({ history: undefined })
    }
  }

  const revert = async (id: string): Promise<void> => {
    const calls = configCalls
    if (calls === undefined || get().thresholds.busy !== undefined) return
    patchT({ busy: `revert:${id}`, notice: undefined })
    const result = await settle(() => calls.revert(id), 'revert', CONFIG)
    patchT({ busy: undefined })
    if (!result.ok) {
      patchT({ notice: { tone: 'error', ...result.notice } })
      return
    }
    if (result.value === null) {
      patchT({ notice: { tone: 'info', text: NOTHING_TO_REVERT } })
      return
    }
    patchT({ notice: { tone: 'success', text: `Reverted ${shortId(id)} with a new commit, ${shortId(result.value.id)}` } })
    // The revert may have changed this document, and the log has a new commit.
    await Promise.all([loadHistory(), refreshThresholds()])
  }

  const setTab = async (tab: ThresholdTab): Promise<void> => {
    if (!thresholdTabs(get()).includes(tab)) return
    patchT({ tab })
    if (tab === 'history') await loadHistory()
  }

  // --- the decisions --------------------------------------------------------------------------------

  /** The filter as the server takes it: `''` for none. */
  const queryOf = (filter: LogFilter): { purpose: string, decision: string } => ({ purpose: filter.purpose, decision: filter.decision.trim() })

  /** Read the table again from the newest line, with the filter it has. What was shown stays until the new page is in hand, unless `clear`. */
  const loadDecisions = async (clear = false): Promise<void> => {
    const generation = ++decisionsGeneration
    const { filter } = get().decisions
    const { purpose, decision } = queryOf(filter)
    patchD(clear
      ? { load: 'loading', error: undefined, lines: [], next: undefined, skipped: 0, more: 'idle', moreError: undefined, capped: false, withheld: {} }
      : { load: 'loading', error: undefined, more: 'idle', moreError: undefined })
    const result = await settle(() => api.log(purpose, decision, LOG_PAGE, ''))
    if (generation !== decisionsGeneration) return
    if (!result.ok) {
      patchD({ load: 'error', error: result.notice })
      return
    }
    const { lines, next, skipped } = result.value
    patchD({ load: 'ready', error: undefined, lines, next, skipped, capped: false, withheld: {} })
  }

  const loadMore = async (): Promise<void> => {
    const state = get().decisions
    if (state.next === undefined || state.load !== 'ready' || state.more === 'loading') return
    const generation = decisionsGeneration
    const { purpose, decision } = queryOf(state.filter)
    patchD({ more: 'loading', moreError: undefined })
    const result = await settle(() => api.log(purpose, decision, LOG_PAGE, state.next ?? ''))
    // The table was read again, or its filter changed: this page is for another table.
    if (generation !== decisionsGeneration) return
    if (!result.ok) {
      patchD({ more: 'error', moreError: result.notice })
      return
    }
    const joined = [...get().decisions.lines, ...result.value.lines]
    const skipped = get().decisions.skipped + result.value.skipped
    if (joined.length >= LOG_MAX) {
      // Past the most the table holds there is no `next`: the person narrows the filter instead.
      patchD({ more: 'idle', lines: joined.slice(0, LOG_MAX), next: undefined, capped: result.value.next !== undefined || joined.length > LOG_MAX, skipped })
    } else {
      patchD({ more: 'idle', lines: joined, next: result.value.next, capped: false, skipped })
    }
  }

  const setFilter = async (change: Partial<LogFilter>): Promise<void> => {
    const { filter } = get().decisions
    const next: LogFilter = { purpose: change.purpose ?? filter.purpose, decision: change.decision ?? filter.decision }
    if (next.purpose === filter.purpose && next.decision === filter.decision) return
    // The text is kept as typed, and what is sent is its trim: a change that is only space doesn't read the log again.
    const same = next.purpose === filter.purpose && next.decision.trim() === filter.decision.trim()
    patchD({ filter: next })
    if (same) return
    await loadDecisions(true)
  }

  const toggleWithheld = async (id: string): Promise<void> => {
    const setView = (view: WithheldView): void => {
      const { withheld } = get().decisions
      patchD({ withheld: { ...withheld, [id]: view } })
    }
    const known = get().decisions.withheld[id]
    // Loaded or loading: show it or fold it away. A failed one is asked for again.
    if (known !== undefined && known.status !== 'error') {
      setView({ ...known, open: !known.open })
      return
    }
    setView({ open: true, status: 'loading' })
    const result = await settle(() => api.withheld(id))
    // The table was read again meanwhile (its withheld views start over), or the person folded this one: the answer is for nothing.
    if (get().decisions.withheld[id]?.status !== 'loading') return
    const open = get().decisions.withheld[id]?.open ?? true
    setView(result.ok ? { open, status: 'ready', tool: result.value.tool, content: result.value.content } : { open, status: 'error', notice: result.notice })
  }

  // --- the face -----------------------------------------------------------------------------------

  const open = async (): Promise<void> => {
    const tasks: Array<Promise<unknown>> = [refreshStatus(), refreshThresholds(), loadDecisions()]
    await Promise.all(tasks)
  }

  const face: JudgeActions = {
    // A store to read and subscribe to, not the one the controller writes.
    hooks: { page: { getSnapshot: store.getSnapshot, subscribe: store.subscribe } },
    open,
    refreshKey: loadKey,
    setKeyInput(text) {
      if (get().key.busy !== undefined) return
      patchKey({ input: text })
    },
    saveKey,
    removeKey,
    dismissKeyNotice() {
      patchKey({ notice: undefined })
    },
    refreshStatus,
    runTest,
    editField,
    setNote(note) {
      patchT({ note })
    },
    save,
    discard,
    reload,
    keepMine,
    setTab,
    loadHistory,
    loadCommit,
    revert,
    dismissThresholdsNotice() {
      patchT({ notice: undefined })
    },
    setFilter,
    refreshDecisions: () => loadDecisions(false),
    loadMore,
    toggleWithheld,
  }

  return {
    face,
    getState: get,

    async onConfigEvent(event, opening = false) {
      if (opening) {
        // The first item of every stream, the very first included: a commit made between the page's own read and the
        // stream's subscription would otherwise be missed.
        patch({ stream: 'live' })
        await Promise.all([refreshThresholds(), refreshHistory()])
        return
      }
      switch (event.kind) {
        case 'changed':
          if (!event.paths.includes(DOCUMENT)) return
          await Promise.all([refreshThresholds(), refreshHistory()])
          return
        case 'proposal':
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
        ? { hasHistory: false, stream: 'off', thresholds: { ...get().thresholds, history: undefined, tab: 'edit' } }
        : { hasHistory: true, stream: 'connecting' })
    },
    setCredentials(calls) {
      credentialCalls = calls
      keyGeneration++
      if (calls === undefined) {
        patchKey({ load: 'unavailable', configured: false, input: '' })
        return
      }
      patchKey({ load: 'idle' })
      void loadKey()
    },
    keyChanged(ref) {
      if (ref === get().key.keyName) void loadKey()
    },
  }
}
