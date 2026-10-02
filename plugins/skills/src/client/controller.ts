/**
 * The Skills page's state and what it does: it calls the remotes, keeps what it learns in one snapshot store, and reacts to
 * what dish-config's `watch` says. No React here, and nothing that only a browser or only dsh can load, so `node --test`
 * runs it against fake remotes (`test/controller.test.ts`). The components read the store through the `usePage` hook the
 * slot gives them and act through `SkillsActions`. It is built like the Prompts page's controller, and differs where a
 * skill differs from a prompt:
 *
 * - **The list is part of the page.** There is no fixed set of skills: the list (with the store commit it was read at)
 *   is read, kept fresh by the live events, and is what a new skill's name is checked against.
 * - **A new skill** is a draft that isn't stored (`creating`). Its `saved` is nothing, over the list's commit, so the first
 *   save is the creation; until then there is nothing to read, reset, delete or show a history of.
 * - **The check** asks the server what saving the draft would run into, 300 ms after the last edit and once whenever a
 *   document is loaded. Its problems stop a save here (the server refuses them too); a check that is still due is made
 *   first, so a Ctrl+S straight after typing works.
 * - **Reset and delete ask first** (`confirm`): a shipped skill can be reset, never deleted, and a skill you added the
 *   other way round.
 *
 * The page edits one skill at a time:
 *
 * - **A draft** is the text in the editor. `saved` is what the store had when the page read it, with the commit it read it
 *   at (what a save passes as `base`). The draft is clean when it is the saved text.
 * - **A conflict** is the store telling the draft it is out of date: a save was refused as `CONFLICT`, or a live event says
 *   the document changed while the draft had edits. The draft stays; `conflict` holds the text that is there now. A clean
 *   page just reads the new text.
 * - **The History tab and live updates** come from dish-config's remote, which may not be there: `setConfig` gives the
 *   controller its calls (or takes them away), and without them the History tab is hidden and nothing arrives live.
 *
 * Answers that arrive after the person has moved on are dropped, by a counter per kind of answer.
 */

import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { unifiedDiff } from 'dish-kit/ui/diff'
import type { FileDiff } from 'dish-kit/ui/diff'
import { NEW_SKILL_TEMPLATE, RESET_NOTE } from '../protocol.ts'
import type { CheckResult, CommitInfo, ErrorCode, Outcome, ReadResult, SkillInfo } from '../protocol.ts'
import { shortId } from './format.ts'
import { nameProblem } from './names.ts'
import { ALREADY_DEFAULT, NOTHING_TO_REVERT, SHIPPED_NOT_DELETABLE, failureNotice, unexpectedNotice } from './outcome.ts'
import type { Action, Notice } from './outcome.ts'
import type { ConfigCalls, ConfigEvent, SkillsApi } from './remote.ts'

/** How many commits the History tab asks for at a time. */
export const HISTORY_PAGE = 20

/** How long typing pauses before the draft is checked, in milliseconds. */
export const CHECK_DELAY = 300

/** What the page calls its two remotes when a call fails before the store is reached. */
const SKILLS = 'dish-skills'
const CONFIG = 'dish-config'

/** The page's tabs. `default` is there only for a shipped skill, `history` only with dish-config's remote, and neither for a new skill. */
export type Tab = 'edit' | 'default' | 'history'

/** The question the page is asking before it does something it can't take back with a click. */
export type Confirm = 'reset' | 'delete'

/** A skill's document as the page loaded it: its text, and the store commit that was read (`''` when there is no store). */
export interface Saved {
  text: string
  commit: string
}

/** What the store has now, when it is not what the page loaded and the draft has edits. */
export interface Conflict {
  theirs: string
  commit: string
}

/** Where the person asked to go while the draft had edits: asked about before the draft is thrown away. */
export interface Switching {
  /** The skill to open, or the name of the new one. */
  name: string
  /** `true` for a new skill (`startNew`), `false` for one in the list (`select`). */
  create: boolean
}

/** The outcome of the last thing the person did, shown above the page until they move on. */
export interface PageNotice extends Notice {
  tone: 'info' | 'success' | 'error'
}

export type Status = 'loading' | 'ready' | 'error'

/** One commit's diff, fetched when its row opens. */
export type DetailState =
  | { status: 'loading' }
  | { status: 'ready', info: CommitInfo, diffs: FileDiff[] }
  | { status: 'error', error: Notice }

export interface HistoryState {
  status: Status
  commits: CommitInfo[]
  /** The last page was full, so there may be older commits to ask for. */
  more: boolean
  loadingMore: boolean
  error?: Notice
  /** By commit id. A commit's diff never changes, so these outlive a reload of the log. */
  details: Record<string, DetailState>
}

/** What is being done now, so a second click can't start it again: a save, a reset, a delete, or `revert:<commit id>`. */
export type Busy = 'save' | 'reset' | 'delete' | `revert:${string}`

export interface PageState {
  /** The skills, as the server lists them: sorted by name. */
  skills: SkillInfo[]
  /** The store commit the list was read at; `''` when there is no store. */
  commit: string
  /** The role names dish knows, for the chips. */
  roles: string[]
  /** The list has been asked for. */
  listLoaded: boolean
  listError?: Notice
  /** The skill in the editor: one in the list, or a new one (`creating`). */
  selected?: string
  /** The selected skill's document: not asked for yet, being read, in hand, or not readable. A new skill's is `ready`. */
  document: 'idle' | 'loading' | 'ready' | 'error'
  documentError?: Notice
  saved?: Saved
  /** The shipped default; `''` for a skill you added, and until the document is read. */
  defaultText: string
  /** The document isn't in the store, and `saved` is the default. */
  missing: boolean
  /** dish ships a default for the selected skill (from the list): it has a Default tab, and it can't be deleted. */
  shipped: boolean
  /** There is no store to save to: the page shows the shipped defaults. */
  readOnly: boolean
  draft: string
  /** The optional note a save will carry. */
  note: string
  /** `draft` isn't `saved.text`. */
  dirty: boolean
  /** The selected skill is new: a draft from the template that nothing has stored yet. */
  creating: boolean
  /** What the server said of the draft, once it has: its problems stop a save. `null` before the first answer or when it failed. */
  check: CheckResult | null
  /** A check is due or under way: `check` may be about an older text. */
  checking: boolean
  /** The last check couldn't be made. */
  checkError?: Notice
  tab: Tab
  conflict?: Conflict
  /** Where the person asked to go while the draft had edits. */
  switching?: Switching
  notice?: PageNotice
  busy?: Busy
  /** The question being asked before a reset or a delete. */
  confirm: Confirm | null
  /** The selected skill's log, once its tab has been opened. */
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
export interface SkillsActions {
  hooks: { page: ObservableSnapshot<PageState> }
  /** The page was shown: load what it needs, or read again what it has. */
  open(): Promise<void>
  /** Open a skill. With unsaved edits it only asks (`switching`); `confirmSwitch` or `cancelSwitch` answers. */
  select(name: string): Promise<void>
  confirmSwitch(): Promise<void>
  cancelSwitch(): void
  /**
   * Open the editor on a new skill called `name` (trimmed), from the template. Nothing is written until `save`.
   * @returns whether the name was accepted: `false` when the grammar or the list refuses it (the notice says why). With
   *   unsaved edits it asks first (`switching`) and is `true`.
   */
  startNew(name: string): Promise<boolean>
  edit(text: string): void
  setNote(note: string): void
  save(): Promise<void>
  /** Back to the saved text (for a new skill, the template). */
  discard(): void
  /** Ask whether to write the shipped default over the document (`confirm: 'reset'`). Refused for a skill with no default. */
  askReset(): void
  /** After `askReset`: write the shipped default over the document. */
  reset(): Promise<void>
  /** Ask whether to delete the skill (`confirm: 'delete'`). Refused for a shipped skill. */
  askDelete(): void
  /** After `askDelete`: delete the skill, and select nothing. */
  remove(): Promise<void>
  cancelConfirm(): void
  /** After a conflict: read the store's text again and drop the draft. */
  reload(): Promise<void>
  /** After a conflict: keep the draft, with the store's text as what it is saved over. */
  keepMine(): void
  setTab(tab: Tab): Promise<void>
  loadHistory(): Promise<void>
  /** The next page of the log, below the last commit shown. */
  loadMoreHistory(): Promise<void>
  loadCommit(id: string): Promise<void>
  revert(id: string): Promise<void>
  dismiss(): void
}

export interface SkillsController {
  /** What the component gets: the observable and the actions, and nothing that feeds the controller. */
  face: SkillsActions
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

/** The timer the check's pause runs on: the browser's, unless a test gives its own. */
export interface Timer {
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface SkillsOptions {
  /** Where the check's pause is timed. Default: the global `setTimeout` and `clearTimeout`. */
  timer?: Timer
  /** The pause after the last edit before the draft is checked, in milliseconds. Default `CHECK_DELAY`. */
  delay?: number
}

const globalTimer: Timer = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => { globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>) },
}

/** The tabs the page offers now, in order. */
export function visibleTabs(state: Pick<PageState, 'shipped' | 'hasHistory' | 'creating'>): Tab[] {
  const tabs: Tab[] = ['edit']
  if (state.shipped && !state.creating) tabs.push('default')
  if (state.hasHistory && !state.creating) tabs.push('history')
  return tabs
}

/** The store path of the skill called `name`, from the list when it has it. */
function pathFor(skills: readonly SkillInfo[], name: string): string {
  return skills.find(skill => skill.name === name)?.path ?? `skills/${name}/SKILL.md`
}

/**
 * What the Default tab shows for the selected skill: no default to compare with, what is saved being the default, or the
 * diff from the default to what is saved (not to the draft: the tab is about the stored skill).
 */
export function defaultView(state: Pick<PageState, 'shipped' | 'defaultText' | 'saved' | 'selected' | 'skills'>): DefaultView {
  if (!state.shipped || state.defaultText === '' || state.saved === undefined || state.selected === undefined) return { kind: 'none' }
  const diff = unifiedDiff(pathFor(state.skills, state.selected), state.defaultText, state.saved.text)
  return diff.patch === '' ? { kind: 'same' } : { kind: 'diff', diff }
}

/** What a call that did not succeed is, for the page: its notice, and for a refusal by the store its code and its own words. */
type Failed = { ok: false, notice: Notice, code?: ErrorCode, message?: string }

type Settled<T> = { ok: true, value: T } | Failed

/**
 * Wait for a call and fold both kinds of failure (the carrier's and the store's) into a `Notice`. Never throws.
 * @param action - what the person was doing, for the refusals whose wording depends on it.
 * @param remote - which remote the call is to, for the failures that name it.
 */
async function settle<T>(task: () => Promise<RemoteResult<Outcome<T>>>, action?: Action, remote = SKILLS): Promise<Settled<T>> {
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
 * @param api - the `dishSkills` remote.
 * @param config - dish-config's remote, when it is there. Give it later with `setConfig`.
 * @param options - the check's timer and pause, for tests.
 */
export function createSkills(api: SkillsApi, config?: ConfigCalls, options: SkillsOptions = {}): SkillsController {
  let configCalls = config
  const timer = options.timer ?? globalTimer
  const delay = options.delay ?? CHECK_DELAY
  const store = createStore<PageState>({
    skills: [],
    commit: '',
    roles: [],
    listLoaded: false,
    document: 'idle',
    defaultText: '',
    missing: false,
    shipped: false,
    readOnly: false,
    draft: '',
    note: '',
    dirty: false,
    creating: false,
    check: null,
    checking: false,
    tab: 'edit',
    confirm: null,
    hasHistory: config !== undefined,
    stream: config !== undefined ? 'connecting' : 'off',
  })
  const get = (): PageState => store.getSnapshot()
  const patch = (next: Partial<PageState>): void => { store.set({ ...get(), ...next }) }

  /** Bumped when an answer in flight stops being wanted: a newer read of the document or a write that is newer than it, another skill. */
  let documentGeneration = 0
  let historyGeneration = 0
  /** Bumped when another skill is opened (or the same one from nothing): a write's answer for an earlier one is not for this page. */
  let selection = 0
  /** A live event came while a write was under way: its read would see the page's own commit as someone else's, so it waits for the write to end. */
  let eventWhileWriting = false

  /** A save, a reset or a delete is under way. */
  const writing = (): boolean => get().busy === 'save' || get().busy === 'reset' || get().busy === 'delete'

  /** After a write: the live event that came meanwhile is read now, when the page knows its own commit. */
  const settleEvents = async (): Promise<void> => {
    if (!eventWhileWriting) return
    eventWhileWriting = false
    await refreshSelected()
  }

  const pathOf = (name: string): string => pathFor(get().skills, name)

  /** Go back to Edit when the tab shown isn't one the page has any more. */
  const ensureTab = (): void => {
    const state = get()
    if (!visibleTabs(state).includes(state.tab)) patch({ tab: 'edit' })
  }

  // --- the check ----------------------------------------------------------------------------------

  /** The pause is running: the handle of its timer is `pause`. */
  let pausing = false
  let pause: unknown
  /** Bumped when an answer in flight stops being wanted: a newer edit, another skill, a newer check. */
  let checkGeneration = 0
  /** The check under way, while there is one. */
  let checkRunning: Promise<void> | undefined
  /** The skill and text the `check` in the state is the answer for, so that reading the same text again doesn't ask again. */
  let checkedFor: { name: string, text: string } | undefined

  const disarm = (): void => {
    if (!pausing) return
    pausing = false
    timer.clearTimeout(pause)
  }

  /** Ask the server about the draft as it is now, at once. A check that is due is made by this. Never throws. */
  const runCheck = (): Promise<void> => {
    disarm()
    const { selected: name, document, draft } = get()
    if (name === undefined || document !== 'ready') {
      checkGeneration++
      patch({ checking: false })
      return Promise.resolve()
    }
    const generation = ++checkGeneration
    patch({ checking: true })
    const running = (async (): Promise<void> => {
      const result = await settle(() => api.check(name, draft))
      if (generation !== checkGeneration) return
      if (result.ok) {
        checkedFor = { name, text: draft }
        patch({ check: result.value, checking: false, checkError: undefined })
      } else {
        checkedFor = undefined
        patch({ check: null, checking: false, checkError: result.notice })
      }
    })()
    checkRunning = running
    void running.then(() => { if (checkRunning === running) checkRunning = undefined })
    return running
  }

  /** The draft changed: check it once the person pauses. */
  const scheduleCheck = (): void => {
    disarm()
    checkGeneration++
    patch({ checking: true })
    pausing = true
    pause = timer.setTimeout(() => {
      pausing = false
      void runCheck()
    }, delay)
  }

  /** Leave what was checked behind: another skill is opening, or none is. */
  const dropCheck = (): void => {
    disarm()
    checkGeneration++
    checkedFor = undefined
  }

  /** Wait until `check` is about the draft as it is now: a check that is due is made, one under way is waited for. */
  const ensureChecked = async (): Promise<void> => {
    if (pausing) await runCheck()
    else if (checkRunning !== undefined) await checkRunning
  }

  // --- the document -------------------------------------------------------------------------------

  /** Whether the list says dish ships a default for `name`, else whether `read` found one. */
  const shippedOf = (name: string | undefined, read: ReadResult): boolean =>
    get().skills.find(skill => skill.name === name)?.shipped ?? read.defaultText !== ''

  /**
   * Take `read` as the document, and the draft with it.
   * @returns the check of that text, which is made unless the `check` in hand is already about it.
   */
  const adopt = (read: ReadResult): Promise<void> => {
    const { selected, checking, check } = get()
    patch({
      document: 'ready',
      documentError: undefined,
      saved: { text: read.text, commit: read.commit },
      defaultText: read.defaultText,
      missing: read.missing,
      shipped: shippedOf(selected, read),
      readOnly: read.commit === '',
      creating: false,
      draft: read.text,
      note: '',
      dirty: false,
      conflict: undefined,
    })
    ensureTab()
    const known = selected !== undefined && checkedFor?.name === selected && checkedFor.text === read.text && check !== null && !checking
    return known ? Promise.resolve() : runCheck()
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
      shipped: shippedOf(state.selected, read),
      readOnly: read.commit === '',
      creating: false,
      dirty: state.draft !== read.text,
      conflict: undefined,
    })
    ensureTab()
  }

  /**
   * What the tab shown needs when it has nothing: after a skill was opened, or after a read that took the place of the one that
   * would have opened it. A tab that has something is left to the events that refresh it.
   */
  const loadMissingTab = async (): Promise<void> => {
    const { tab, history } = get()
    if (tab === 'history' && history === undefined) await loadHistory()
  }

  /** What the page shows when no skill is open: the state of a page that has just been opened, apart from the list. */
  const nothingOpen: Partial<PageState> = {
    document: 'idle',
    documentError: undefined,
    saved: undefined,
    defaultText: '',
    missing: false,
    shipped: false,
    draft: '',
    note: '',
    dirty: false,
    creating: false,
    conflict: undefined,
    switching: undefined,
    confirm: null,
    check: null,
    checking: false,
    checkError: undefined,
    history: undefined,
  }

  /** Open `name` from nothing: what was shown of the last skill goes. */
  const choose = async (name: string): Promise<void> => {
    const generation = ++documentGeneration
    selection++
    historyGeneration++
    dropCheck()
    patch({
      ...nothingOpen,
      selected: name,
      document: 'loading',
      shipped: get().skills.find(skill => skill.name === name)?.shipped ?? false,
      readOnly: false,
      notice: undefined,
    })
    ensureTab()
    const result = await settle(() => api.read(name))
    if (generation !== documentGeneration) return
    if (!result.ok) {
      patch({ document: 'error', documentError: result.notice })
      return
    }
    await Promise.all([adopt(result.value), loadMissingTab()])
  }

  /** Open nothing: the skill that was open is gone. */
  const closeSkill = (): void => {
    documentGeneration++
    selection++
    historyGeneration++
    dropCheck()
    patch({ ...nothingOpen, selected: undefined, tab: 'edit' })
  }

  /**
   * Open the editor on a new skill. Nothing is stored: the draft is the template, over the list's commit.
   * @returns `false` when `name` isn't one the list allows now, said in the notice.
   */
  const beginNew = async (name: string): Promise<boolean> => {
    // The name was checked when it was asked for, but the list may have changed since, as it can while the person confirms.
    const problem = nameProblem(name, get().skills.map(skill => skill.name))
    if (problem !== undefined) {
      patch({ switching: undefined, notice: { tone: 'error', text: problem } })
      return false
    }
    documentGeneration++
    selection++
    historyGeneration++
    dropCheck()
    const { commit } = get()
    patch({
      ...nothingOpen,
      selected: name,
      document: 'ready',
      saved: { text: '', commit },
      creating: true,
      readOnly: commit === '',
      draft: NEW_SKILL_TEMPLATE(name),
      dirty: true,
      tab: 'edit',
      notice: undefined,
    })
    await runCheck()
    return true
  }

  /** The selected skill is gone from the store: a page with nothing to lose lets it go; one with edits keeps them. */
  const goneElsewhere = (name: string): void => {
    if (get().dirty) {
      patch({ notice: { tone: 'error', text: `${name} was deleted elsewhere. Your text is still in the editor.` } })
      return
    }
    closeSkill()
    patch({ notice: { tone: 'info', text: `${name} was deleted elsewhere.` } })
  }

  /**
   * What a live event about the selected document does: a clean page takes the new text; with edits, the page keeps them,
   * and the new text becomes the `conflict`, unless it is the text the page already has (the echo of its own save).
   */
  const refreshSelected = async (): Promise<void> => {
    const name = get().selected
    if (name === undefined) return
    if (writing()) {
      eventWhileWriting = true
      return
    }
    const generation = ++documentGeneration
    const result = await settle(() => api.read(name))
    if (generation !== documentGeneration) return
    if (!result.ok) {
      const state = get()
      // A new skill isn't stored yet, so there is nothing to find. Any other that isn't there is gone.
      if (result.code === 'NOT_FOUND') {
        if (!state.creating) goneElsewhere(name)
        return
      }
      // A refresh that failed leaves what is shown alone, unless nothing is.
      if (state.saved === undefined) patch({ document: 'error', documentError: result.notice })
      return
    }
    const read = result.value
    const state = get()
    if (writing()) {
      eventWhileWriting = true
    } else if (!state.dirty) {
      // This read may have taken the place of the one that was to open the skill, and with it the tab's load.
      await Promise.all([adopt(read), loadMissingTab()])
    } else if (read.text !== state.saved?.text) {
      patch({ conflict: { theirs: read.text, commit: read.commit }, readOnly: read.commit === '' })
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
    const name = get().selected
    if (name === undefined) return
    const generation = ++documentGeneration
    const before = get()
    const { saved } = before
    if (saved === undefined) {
      patch({ document: 'loading', documentError: undefined })
    } else {
      patch({ draft: saved.text, note: '', dirty: false, conflict: undefined })
    }
    const result = await settle(() => api.read(name))
    if (generation !== documentGeneration) return
    if (!result.ok) {
      if (saved === undefined) {
        patch({ document: 'error', documentError: result.notice })
      } else {
        const kept = get().dirty ? {} : { draft: before.draft, note: before.note, dirty: before.dirty, conflict: before.conflict }
        patch({ ...kept, notice: { tone: 'error', ...result.notice } })
      }
      return
    }
    await Promise.all([adopt(result.value), loadMissingTab()])
  }

  // --- the list -----------------------------------------------------------------------------------

  /** The list as the server gives it now, `undefined` when it could not say. */
  const readSkills = async (): Promise<SkillInfo[] | undefined> => {
    const result = await settle(() => api.skills())
    if (!result.ok) {
      patch({ listLoaded: true, listError: result.notice })
      return undefined
    }
    const { skills, commit, roles } = result.value
    const state = get()
    const entry = skills.find(skill => skill.name === state.selected)
    patch({
      skills,
      commit,
      roles,
      listLoaded: true,
      listError: undefined,
      readOnly: commit === '',
      // What the list says of the open skill is the word on whether it is shipped.
      ...(entry !== undefined && !state.creating ? { shipped: entry.shipped } : {}),
    })
    return skills
  }

  let listRunning: Promise<SkillInfo[] | undefined> | undefined
  let listAgain = false

  /**
   * Read the list, one read at a time: a call while one is under way waits for it, and the list is read once more after it, for
   * whatever changed meanwhile. Every caller gets the last answer, so none of them is left waiting on a read that was set aside.
   */
  const refreshSkills = (): Promise<SkillInfo[] | undefined> => {
    if (listRunning !== undefined) {
      listAgain = true
      return listRunning
    }
    listRunning = (async () => {
      try {
        let skills: SkillInfo[] | undefined
        do {
          listAgain = false
          skills = await readSkills()
        } while (listAgain)
        return skills
      } finally {
        listRunning = undefined
      }
    })()
    return listRunning
  }

  // --- the History tab ----------------------------------------------------------------------------

  const loadHistory = async (): Promise<void> => {
    const calls = configCalls
    const name = get().selected
    // A new skill has no commits.
    if (calls === undefined || name === undefined || get().creating) return
    const generation = ++historyGeneration
    const previous = get().history
    const details = previous?.details ?? {}
    const commits = previous?.commits ?? []
    const more = previous?.more ?? false
    patch({ history: { status: 'loading', commits, more, loadingMore: false, details } })
    const result = await settle(() => calls.history(pathOf(name), HISTORY_PAGE, ''), undefined, CONFIG)
    if (generation !== historyGeneration) return
    const current = get().history?.details ?? details
    patch({
      history: result.ok
        ? { status: 'ready', commits: result.value, more: result.value.length >= HISTORY_PAGE, loadingMore: false, details: current }
        : { status: 'error', commits, more, loadingMore: false, error: result.notice, details: current },
    })
  }

  const loadMoreHistory = async (): Promise<void> => {
    const calls = configCalls
    const name = get().selected
    const history = get().history
    if (calls === undefined || name === undefined || history === undefined) return
    const last = history.commits[history.commits.length - 1]
    if (last === undefined || !history.more || history.loadingMore || history.status === 'loading') return
    // A refresh of the log or another skill bumps the counter, and this page of the old log is of no use to the new.
    const generation = historyGeneration
    patch({ history: { ...history, loadingMore: true, error: undefined } })
    const result = await settle(() => calls.history(pathOf(name), HISTORY_PAGE, last.id), undefined, CONFIG)
    if (generation !== historyGeneration) return
    const current = get().history
    if (current === undefined) return
    if (!result.ok) {
      patch({ history: { ...current, loadingMore: false, error: result.notice } })
      return
    }
    const known = new Set(current.commits.map(commit => commit.id))
    patch({
      history: {
        ...current,
        commits: [...current.commits, ...result.value.filter(commit => !known.has(commit.id))],
        more: result.value.length >= HISTORY_PAGE,
        loadingMore: false,
        error: undefined,
      },
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
    // The log was left (another skill) or the row is gone: this answer is for nothing.
    if (get().history?.details[id]?.status !== 'loading') return
    setDetail(result.ok ? { status: 'ready', info: result.value.info, diffs: result.value.diffs } : { status: 'error', error: result.notice })
  }

  /** After the stored texts changed: the tab shown reads again, and what is not shown is dropped to be read when its tab opens. */
  const refreshHistory = async (): Promise<void> => {
    // The tab shown loads even when it has nothing yet: a skill opened just now may not have got to it.
    if (get().tab === 'history') await loadHistory()
    else if (get().history !== undefined) {
      historyGeneration++
      patch({ history: undefined })
    }
  }

  // --- writing --------------------------------------------------------------------------------------

  /**
   * A refusal of a write: the notice, and after a `CONFLICT` the text that is there now, so the person can see what changed. For a
   * skill the page has left, the notice says which one, in the store's own words: what the friendly text says of "the editor" is
   * not true of it any more.
   */
  const refused = async (failure: Failed, name: string, chosen: number, verb: 'save' | 'reset' | 'delete'): Promise<void> => {
    if (chosen === selection) {
      patch({ notice: { tone: 'error', ...failure.notice } })
    } else {
      patch({ notice: { tone: 'error', text: `Couldn't ${verb} ${name}`, detail: failure.message ?? failure.notice.text } })
    }
    if (failure.code === 'CONFLICT' && chosen === selection) {
      // Like any read of the document, this one is dropped if a newer one (an event's, say) has been started since.
      const generation = ++documentGeneration
      const theirs = await settle(() => api.read(name))
      if (theirs.ok && generation === documentGeneration && chosen === selection) {
        patch({ conflict: { theirs: theirs.value.text, commit: theirs.value.commit } })
      }
    }
    await settleEvents()
  }

  /** After a write that changed the stored skill: the list's dots and counts, and the log. */
  const refreshAfterWrite = async (): Promise<void> => {
    await Promise.all([refreshSkills(), refreshHistory()])
  }

  const save = async (): Promise<void> => {
    const first = get()
    // With a conflict open the save would be refused again: the person picks Reload or Keep mine first.
    if (!first.dirty || first.busy !== undefined || first.conflict !== undefined || first.selected === undefined || first.saved === undefined) return
    const name = first.selected
    const chosen = selection
    // Busy from the start, so that a second click while the check is made doesn't start a second save.
    patch({ busy: 'save', notice: undefined })
    // The check in hand may be of an older text: a Ctrl+S right after typing gets its own answer first.
    if (pausing || checkRunning !== undefined) await ensureChecked()
    const state = get()
    if (chosen !== selection || state.saved === undefined || state.conflict !== undefined) {
      // The page moved on, or a live event found the document changed, while the check was made: nothing is saved.
      patch({ busy: undefined })
      await settleEvents()
      return
    }
    if (state.checking) {
      patch({ busy: undefined, notice: { tone: 'info', text: 'The text changed while it was being checked — save again.' } })
      await settleEvents()
      return
    }
    const problem = state.check?.problems[0]
    if (problem !== undefined) {
      patch({ busy: undefined, notice: { tone: 'error', text: `Can't save: ${problem}` } })
      await settleEvents()
      return
    }
    const { draft: text, saved, creating } = state
    const result = await settle(() => api.save(name, text, saved.commit, state.note), 'save')
    patch({ busy: undefined })
    if (!result.ok) {
      await refused(result, name, chosen, 'save')
      return
    }
    const commit = result.value
    if (commit === null) {
      // The document already says this. Its commit is the one to save over from now on.
      patch({ notice: { tone: 'info', text: `Nothing to save for ${name}: the store already has this text.` } })
      if (chosen === selection) {
        const generation = ++documentGeneration
        const read = await settle(() => api.read(name))
        if (read.ok && generation === documentGeneration) rebase(read.value)
      }
      await settleEvents()
      return
    }
    patch({ notice: { tone: 'success', text: `${creating ? 'Created' : 'Saved'} ${name} as ${shortId(commit.id)}` } })
    if (chosen === selection) {
      // A read that began before this save is older than it, and must not put the old text back when it lands.
      documentGeneration++
      // What was typed while the save was under way stays, and is still unsaved.
      patch({
        saved: { text, commit: commit.id },
        missing: false,
        creating: false,
        dirty: get().draft !== text,
        note: get().draft === text ? '' : get().note,
        conflict: undefined,
      })
    }
    await Promise.all([refreshAfterWrite(), settleEvents()])
  }

  const askReset = (): void => {
    const state = get()
    if (state.selected === undefined || state.saved === undefined || state.busy !== undefined || state.creating) return
    if (!state.shipped || state.defaultText === '') {
      patch({ notice: { tone: 'error', text: `${state.selected} has no shipped default to go back to.` } })
      return
    }
    patch({ confirm: 'reset', notice: undefined })
  }

  const reset = async (): Promise<void> => {
    const state = get()
    const { selected: name, saved, defaultText } = state
    if (state.confirm !== 'reset' || state.busy !== undefined || state.creating) return
    if (name === undefined || saved === undefined || !state.shipped || defaultText === '') return
    const chosen = selection
    patch({ busy: 'reset', notice: undefined })
    // The note is the standard one: the Edit tab's field is for a save, and is not on this tab.
    const result = await settle(() => api.reset(name, saved.commit, RESET_NOTE), 'reset')
    patch({ busy: undefined, ...(chosen === selection ? { confirm: null } : {}) })
    if (!result.ok) {
      await refused(result, name, chosen, 'reset')
      return
    }
    const commit = result.value
    if (commit === null) {
      patch({ notice: { tone: 'info', text: `${name}: ${ALREADY_DEFAULT}` } })
      if (chosen === selection) {
        // The document already is the default; its commit is not in the answer, so it is read. The editor shows the default, an
        // unsaved edit included: that is what the person asked for. No echo follows a write that changed nothing, and a read
        // that began before this one is older than it, so this one takes the place of any that is out.
        const generation = ++documentGeneration
        const read = await settle(() => api.read(name))
        if (read.ok && generation === documentGeneration) await adopt(read.value)
      }
      await Promise.all([refreshAfterWrite(), settleEvents()])
      return
    }
    patch({ notice: { tone: 'success', text: `Reset ${name} to the default as ${shortId(commit.id)}` } })
    let checking: Promise<void> = Promise.resolve()
    if (chosen === selection) {
      // The store wrote exactly the default the page holds, as the commit in the answer: nothing needs reading, and so nothing
      // can take the place of a read. (A read would let the echo of this very commit take it over, and find the edit it
      // replaces still in the editor.) Anything that came meanwhile is read after, below.
      documentGeneration++
      patch({
        saved: { text: defaultText, commit: commit.id },
        draft: defaultText,
        note: '',
        dirty: false,
        conflict: undefined,
        missing: false,
      })
      // The draft is a different text now, and what was said of the one before is no longer about it.
      checking = runCheck()
    }
    await Promise.all([refreshAfterWrite(), settleEvents(), checking])
  }

  const askDelete = (): void => {
    const state = get()
    if (state.selected === undefined || state.saved === undefined || state.busy !== undefined || state.creating) return
    if (state.shipped) {
      patch({ notice: { tone: 'error', text: SHIPPED_NOT_DELETABLE } })
      return
    }
    patch({ confirm: 'delete', notice: undefined })
  }

  const remove = async (): Promise<void> => {
    const state = get()
    const { selected: name, saved } = state
    if (state.confirm !== 'delete' || state.busy !== undefined || state.creating || state.shipped) return
    if (name === undefined || saved === undefined) return
    const chosen = selection
    patch({ busy: 'delete', notice: undefined })
    const result = await settle(() => api.remove(name, saved.commit, ''), 'delete')
    patch({ busy: undefined, ...(chosen === selection ? { confirm: null } : {}) })
    if (!result.ok) {
      await refused(result, name, chosen, 'delete')
      return
    }
    const commit = result.value
    patch({
      notice: commit === null
        ? { tone: 'info', text: `${name} was deleted already — nothing to do` }
        : { tone: 'success', text: `Deleted ${name} as ${shortId(commit.id)}` },
    })
    // The skill is gone: nothing stays selected. (The first one would be a page the person did not ask for.)
    if (chosen === selection) closeSkill()
    await Promise.all([refreshSkills(), settleEvents()])
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
    await Promise.all([loadHistory(), refreshSkills(), refreshSelected()])
  }

  // --- the face -----------------------------------------------------------------------------------

  const select = async (name: string): Promise<void> => {
    const state = get()
    if (name === state.selected && state.document !== 'error') return
    if (state.dirty && state.selected !== undefined) {
      patch({ switching: { name, create: false } })
      return
    }
    await choose(name)
  }

  const startNew = async (raw: string): Promise<boolean> => {
    const state = get()
    const name = raw.trim()
    const problem = nameProblem(name, state.skills.map(skill => skill.name))
    if (problem !== undefined) {
      patch({ notice: { tone: 'error', text: problem } })
      return false
    }
    // Without the list there is no telling whether the name is taken, and a save over a skill that exists would replace it.
    if (!state.listLoaded || (state.listError !== undefined && state.skills.length === 0)) {
      patch({ notice: { tone: 'error', text: 'The list of skills hasn\'t loaded, so the name can\'t be checked against it. Reload the page and try again.' } })
      return false
    }
    if (state.dirty && state.selected !== undefined) {
      patch({ switching: { name, create: true }, notice: undefined })
      return true
    }
    return beginNew(name)
  }

  const setTab = async (tab: Tab): Promise<void> => {
    if (!visibleTabs(get()).includes(tab)) return
    // A question belongs to the tab it was asked on.
    patch({ tab, confirm: null })
    if (tab === 'history') await loadHistory()
  }

  const open = async (): Promise<void> => {
    const skills = await refreshSkills()
    if (get().selected !== undefined) {
      await refreshSelected()
      return
    }
    const first = (skills ?? get().skills)[0]
    if (first !== undefined) await choose(first.name)
  }

  const face: SkillsActions = {
    // A store to read and subscribe to, not the one the controller writes.
    hooks: { page: { getSnapshot: store.getSnapshot, subscribe: store.subscribe } },
    open,
    select,
    async confirmSwitch() {
      const switching = get().switching
      if (switching === undefined) return
      if (switching.create) await beginNew(switching.name)
      else await choose(switching.name)
    },
    cancelSwitch() {
      patch({ switching: undefined })
    },
    startNew,
    edit(text) {
      const { saved, draft } = get()
      if (saved === undefined || text === draft) return
      patch({ draft: text, dirty: text !== saved.text })
      scheduleCheck()
    },
    setNote(note) {
      patch({ note })
    },
    save,
    discard() {
      const { saved, conflict, creating, selected } = get()
      if (saved === undefined || selected === undefined) return
      if (creating && conflict === undefined) {
        // Nothing is stored to go back to: the template is where the skill started.
        patch({ draft: NEW_SKILL_TEMPLATE(selected), note: '', dirty: true })
      } else {
        // With a conflict, "what is saved" is what the store has now: the page already holds it.
        const target = conflict === undefined ? saved : { text: conflict.theirs, commit: conflict.commit }
        patch({ saved: target, draft: target.text, note: '', dirty: false, conflict: undefined, creating: false })
      }
      void runCheck()
    },
    askReset,
    reset,
    askDelete,
    remove,
    cancelConfirm() {
      patch({ confirm: null })
    },
    reload,
    keepMine() {
      const { conflict, draft, saved } = get()
      if (conflict === undefined || saved === undefined) return
      // The skill exists now, if it was new: the draft is saved over what is there.
      patch({ saved: { text: conflict.theirs, commit: conflict.commit }, dirty: draft !== conflict.theirs, conflict: undefined, creating: false })
      ensureTab()
    },
    setTab,
    loadHistory,
    loadMoreHistory,
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
        await Promise.all([refreshSkills(), refreshSelected(), refreshHistory()])
        return
      }
      switch (event.kind) {
        case 'changed': {
          const changed = event.paths.filter(path => path.startsWith('skills/'))
          if (changed.length === 0) return
          const tasks: Array<Promise<unknown>> = [refreshSkills()]
          const selected = get().selected
          if (selected !== undefined && changed.includes(pathOf(selected))) tasks.push(refreshSelected(), refreshHistory())
          await Promise.all(tasks)
          return
        }
        case 'proposal':
          await refreshSkills()
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
