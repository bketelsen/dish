/**
 * The Memory page's state and what it does: it calls the remote, keeps what it learns in one snapshot store, and reacts to
 * what `watch` says. No React here, and nothing that only a browser or only dsh can load, so `node --test` runs it against
 * a fake remote (`test/controller.test.ts`). The components read the store through the `usePage` hook the slot gives them
 * and act through `MemoryActions`.
 *
 * The page shows one scope at a time (You, or a family), and in it one memory and the family's direction at most:
 *
 * - **A draft** is what the editor holds. `open.memory` is the memory as the page read it, with the commit it was read at (what
 *   a save passes as `base`); `undefined` for a new one, saved with `base` `''`. The draft is clean when its type, description
 *   and body are the memory's. The direction's draft works the same way against `direction.info`.
 * - **A conflict** is the vault (or the config store) telling the draft it is out of date: a save was refused as `CONFLICT`,
 *   or a live event says the memory changed while the draft had edits. The draft stays; `conflict` holds what is there now
 *   (nothing, when it was deleted), and the diff from what the page loaded to it. A clean page just reads the new text.
 * - **Asking** is the one question the page has open: delete a memory, revert a commit, or leave a draft with edits.
 *   Nothing is deleted, reverted or thrown away until the person confirms.
 *
 * **What is read when.** `scopes()` reads every memory in the vault, so it is called only when the page opens and when the
 * stream (re)opens, and for a `changed` event that touched a scope other than the one shown. Those reads are never two at
 * once: one asked for while one is under way waits for it, and the scopes are read once more after it, so a burst of events
 * costs two reads at most. The scope shown gets its count from its own list, which every `changed` event for it reads again,
 * with the open memory.
 *
 * Answers that arrive after the person has moved on are dropped, by a counter per kind of answer.
 */

import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { unifiedDiff } from 'dish-kit/ui/diff'
import { DIRECTION_TEMPLATE, TYPES } from '../protocol.ts'
import type {
  CommitInfo, DirectionInfo, ErrorCode, FileDiff, Memory, MemoryEvent, MemoryInfo, MemoryType, Outcome, RemoteStatus, ScopeInfo,
  ScopeKey,
} from '../protocol.ts'
import { directionPath } from '../format.ts'
import { familyOf, idOf, memoryPathOf, memoryText, shortId } from './format.ts'
import { NOTHING_TO_REVERT, failureNotice, unexpectedNotice } from './outcome.ts'
import type { Action, Notice } from './outcome.ts'
import type { MemoryApi } from './remote.ts'

/** How many commits the History tab shows at a time: the remote's page. */
export const HISTORY_PAGE = 20

/** The page's tabs. `direction` is there only for a family. */
export type Tab = 'memories' | 'direction' | 'history' | 'preview'

/** What the editor holds: a memory's fields as the person is writing them. */
export interface Draft {
  name: string
  type: MemoryType
  description: string
  body: string
}

/** What the vault has now, when it isn't what the editor loaded and the draft has edits. */
export interface MemoryConflict {
  /** `undefined`: the memory was deleted. */
  theirs: Memory | undefined
  /** From what the page loaded (nothing, for a new memory) to `theirs`. */
  diff: FileDiff
}

export interface OpenMemory {
  /** As the page read it; `undefined` for a new one. */
  memory: Memory | undefined
  draft: Draft
  conflict?: MemoryConflict
}

export interface DirectionConflict {
  theirs: string
  commit: string
  /** From what the page loaded to `theirs`. */
  diff: FileDiff
}

export interface DirectionState {
  info: DirectionInfo
  draft: string
  /** The optional note a save will carry. */
  note: string
  conflict?: DirectionConflict
}

export interface HistoryState {
  /** Newest first. */
  commits: CommitInfo[]
  /** The last page was full: there may be older ones. */
  more: boolean
  /** The one commit shown open, with what it changed. */
  detail?: { info: CommitInfo, diffs: FileDiff[] }
  /** The commit being fetched to be shown open. */
  opening?: string
  /** An older page is being fetched. */
  loadingMore?: boolean
}

/** What is being done now, so a second click can't start it again. */
export type Busy = 'save' | 'forget' | 'release' | 'direction' | `revert:${string}`

/** Where the person asked to go while a draft had edits. */
export type Leave = { to: 'close' } | { to: 'new' } | { to: 'memory', name: string } | { to: 'scope', key: ScopeKey }

/** The question the page has open, answered by `confirm` or `cancel`. */
export type Asking = { kind: 'forget', name: string } | { kind: 'revert', id: string } | { kind: 'discard', then: Leave }

/** What a load is of, for the error it left. */
export type LoadKind = 'scopes' | 'memories' | 'direction' | 'history' | 'commit' | 'preview'

/** The outcome of the last thing the person did, shown above the page until they move on. */
export interface PageNotice extends Notice {
  tone: 'info' | 'success' | 'error'
}

export interface PageState {
  /** You, each family in projects.yaml, then the orphans; `undefined` until read. */
  scopes: ScopeInfo[] | undefined
  /** The scope shown. */
  scope: ScopeKey | undefined
  tab: Tab
  /** The scope's memories, held ones included and marked, in the index's order; `undefined` until read. */
  memories: MemoryInfo[] | undefined
  /** The memory in the editor; `undefined` shows the list. */
  open: OpenMemory | undefined
  /** The family's direction, once its tab has been opened. */
  direction: DirectionState | undefined
  /** The scope's log, once its tab has been opened. */
  history: HistoryState | undefined
  /** The message a main agent in this scope gets now (`''`: none), once its tab has been opened. */
  preview: string | undefined
  remote: RemoteStatus | undefined
  /** Whether `watch` is delivering: `down` between a lost carrier and the next item. */
  stream: 'off' | 'connecting' | 'live' | 'down'
  busy: Busy | undefined
  notice: PageNotice | undefined
  asking: Asking | undefined
  /** What failed to load, by kind, each shown with a way to try again. */
  errors: Partial<Record<LoadKind, Notice>>
}

/** What a component can ask of the page, beside the `usePage` hook the `hooks` entry becomes. */
export interface MemoryActions {
  hooks: { page: ObservableSnapshot<PageState> }
  /** The page was shown: load what it needs, or read again what it has. */
  open(): Promise<void>
  /** Show another scope. With unsaved edits it only asks first (`asking`). */
  selectScope(key: ScopeKey): Promise<void>
  setTab(tab: Tab): Promise<void>
  /** Open a memory of the scope shown in the editor. With unsaved edits it only asks first. */
  openMemory(name: string): Promise<void>
  /** Open an empty editor. With unsaved edits it only asks first. */
  newMemory(): Promise<void>
  /** Change a field of the draft. A saved memory's name can't change, and a type must be one of `TYPES`. */
  edit(field: 'name' | 'type' | 'description' | 'body', value: string): void
  save(): Promise<void>
  /** Ask to delete a memory: `name`, or the one in the editor. `confirm` deletes it. */
  forget(name?: string): void
  /** Let a held memory reach agents. */
  release(name: string): Promise<void>
  /** After a conflict: take what the vault has now and drop the draft. */
  reload(): Promise<void>
  /** After a conflict: keep the draft, saved over what the vault has now. */
  keepMine(what?: 'memory' | 'direction'): void
  /**
   * Back to the list. With unsaved edits it only asks first. (Not `close`: a settings section gets a `close` of its own from
   * the shell, which closes Settings.)
   */
  closeMemory(): Promise<void>
  editDirection(text: string): void
  setDirectionNote(note: string): void
  saveDirection(): Promise<void>
  /** Read the direction again and drop the draft: after a conflict, or to discard an edit. */
  reloadDirection(): Promise<void>
  /** The newest page of the scope's log, or with `more` the page after the one shown. */
  loadHistory(more?: boolean): Promise<void>
  /** Show a commit open, with what it changed; for the one shown open, close it. */
  loadCommit(id: string): Promise<void>
  /** Ask to revert a commit. `confirm` reverts it. */
  revert(id: string): void
  loadPreview(): Promise<void>
  /** Do what `asking` asks. */
  confirm(): Promise<void>
  cancel(): void
  dismiss(): void
}

export interface MemoryPage {
  /** What the component gets: the observable and the actions, and nothing that feeds the controller. */
  face: MemoryActions
  getState(): PageState
  /**
   * One item of `watch`. `opening` is whether it is the first of a stream the page has (re)opened: events may have been
   * missed, so everything the page has is read again.
   */
  onEvent(event: MemoryEvent, opening: boolean): Promise<void>
  /** `watch` lost its carrier; the page keeps what it has and says so. */
  streamDown(): void
}

/** The tabs a scope has, in order. */
export function visibleTabs(scope: ScopeKey | undefined): Tab[] {
  return familyOf(scope) === undefined ? ['memories', 'history', 'preview'] : ['memories', 'direction', 'history', 'preview']
}

/** Whether `a` and `b` say the same: their type, description and body. When, and whether held, aside. */
function sameText(a: Pick<Memory, 'type' | 'description' | 'body'>, b: Pick<Memory, 'type' | 'description' | 'body'>): boolean {
  return a.type === b.type && a.description === b.description && a.body === b.body
}

/** Whether the editor holds edits: for a new memory any field filled in, for a saved one a field that isn't the memory's. */
export function memoryDirty(open: OpenMemory): boolean {
  const { memory, draft } = open
  if (memory === undefined) return draft.name !== '' || draft.description !== '' || draft.body !== ''
  return !sameText(memory, draft)
}

/** What the direction's editor starts from: its text, or for a missing one the template. */
function directionBase(info: DirectionInfo): string {
  return info.missing && info.text.trim() === '' ? DIRECTION_TEMPLATE : info.text
}

export function directionDirty(direction: DirectionState): boolean {
  return direction.draft !== directionBase(direction.info)
}

function draftOf(memory: Memory): Draft {
  return { name: memory.name, type: memory.type, description: memory.description, body: memory.body }
}

/** A new memory's type: You's are mostly about the user, a family's about its work. */
function defaultType(scope: ScopeKey): MemoryType {
  return familyOf(scope) === undefined ? 'user' : 'project'
}

function isType(value: string): value is MemoryType {
  return (TYPES as readonly string[]).includes(value)
}

/** The scopes, with `key`'s counts taken from its list. */
function withCounts(scopes: ScopeInfo[] | undefined, key: ScopeKey, memories: readonly MemoryInfo[]): ScopeInfo[] | undefined {
  return scopes?.map(scope => scope.key !== key ? scope : {
    ...scope, count: memories.length, held: memories.filter(memory => memory.held !== undefined).length,
  })
}

/** What a call that did not succeed is, for the page: its notice, and for a refusal its code and the service's own words. */
type Failed = { ok: false, notice: Notice, code?: ErrorCode, message?: string }

type Settled<T> = { ok: true, value: T } | Failed

/**
 * Wait for a call and fold both kinds of failure (the carrier's and the service's) into a `Notice`. Never throws.
 * @param action - what the person was doing, for the refusals whose wording depends on it.
 */
async function settle<T>(task: () => Promise<RemoteResult<Outcome<T>>>, action?: Action): Promise<Settled<T>> {
  try {
    const result = await task()
    if (!result.ok) return { ok: false, notice: unexpectedNotice(result.error) }
    const outcome = result.value
    if (!outcome.ok) return { ok: false, notice: failureNotice(outcome.code, outcome.message, action), code: outcome.code, message: outcome.message }
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

/** @param api - the `dishMemory` remote. */
export function createMemoryPage(api: MemoryApi): MemoryPage {
  const store = createStore<PageState>({
    scopes: undefined,
    scope: undefined,
    tab: 'memories',
    memories: undefined,
    open: undefined,
    direction: undefined,
    history: undefined,
    preview: undefined,
    remote: undefined,
    stream: 'connecting',
    busy: undefined,
    notice: undefined,
    asking: undefined,
    errors: {},
  })
  const get = (): PageState => store.getSnapshot()
  const patch = (next: Partial<PageState>): void => { store.set({ ...get(), ...next }) }
  const setError = (kind: LoadKind, notice: Notice | undefined): void => {
    const { [kind]: _dropped, ...rest } = get().errors
    patch({ errors: notice === undefined ? rest : { ...rest, [kind]: notice } })
  }

  /** The page has been shown: until then the stream's events read nothing. */
  let opened = false
  /** Bumped when another scope is shown: a write's answer for an earlier one is not for this page. */
  let selection = 0
  /** Bumped when the editor shows another memory, a new one, or none: a write's answer for an earlier one is not for it. */
  let editor = 0
  /** Bumped when an answer in flight stops being wanted. */
  let listGeneration = 0
  let memoryGeneration = 0
  let directionGeneration = 0
  let historyGeneration = 0
  let olderGeneration = 0
  let detailGeneration = 0
  let previewGeneration = 0
  /** The memory being opened in the editor: a live event while it is read reads it afresh instead. */
  let opening: string | undefined
  /** A live event came while a write was under way: its read would see the page's own commit as someone else's, so it waits. */
  let eventWhileWriting = false
  let directionEventWhileWriting = false

  /** A write that can change the memory in the editor is under way. */
  const writing = (): boolean => { const { busy } = get(); return busy !== undefined && busy !== 'direction' }

  // --- the scopes ---------------------------------------------------------------------------------

  const readScopes = async (): Promise<void> => {
    const result = await settle(() => api.scopes())
    if (!result.ok) {
      setError('scopes', result.notice)
      return
    }
    // The scope shown keeps the counts of its list: every event for it reads that again, so it is never older than this.
    const { scope, memories } = get()
    const scopes = scope === undefined || memories === undefined ? result.value : withCounts(result.value, scope, memories)
    patch({ scopes })
    setError('scopes', undefined)
  }

  let scopesRunning: Promise<void> | undefined
  let scopesAgain = false

  /** Read the scopes, one read at a time: a call while one is under way waits for it, and they are read once more after it. */
  const refreshScopes = (): Promise<void> => {
    if (scopesRunning !== undefined) {
      scopesAgain = true
      return scopesRunning
    }
    scopesRunning = (async () => {
      try {
        do {
          scopesAgain = false
          await readScopes()
        } while (scopesAgain)
      } finally {
        scopesRunning = undefined
      }
    })()
    return scopesRunning
  }

  const loadRemote = async (): Promise<void> => {
    const result = await settle(() => api.remoteStatus())
    // The stream's word is newer than this answer, if it has spoken since.
    if (result.ok && get().remote === undefined) patch({ remote: result.value })
  }

  // --- the list and the editor --------------------------------------------------------------------

  const loadList = async (): Promise<void> => {
    const scope = get().scope
    if (scope === undefined) return
    const generation = ++listGeneration
    const result = await settle(() => api.list(scope))
    if (generation !== listGeneration || get().scope !== scope) return
    if (!result.ok) {
      setError('memories', result.notice)
      return
    }
    patch({ memories: result.value, scopes: withCounts(get().scopes, scope, result.value) })
    setError('memories', undefined)
  }

  /** A delete asked about in the list or the editor is not a question once another memory (or none) is shown. */
  const keptQuestion = (): Asking | undefined => {
    const { asking } = get()
    return asking?.kind === 'forget' ? undefined : asking
  }

  /** Show `open` in the editor, as another memory than the one before (or none). */
  const showEditor = (open: OpenMemory | undefined): void => {
    editor++
    memoryGeneration++
    opening = undefined
    patch({ open, asking: keptQuestion() })
  }

  const conflictOf = (scope: ScopeKey, name: string, loaded: Memory | undefined, theirs: Memory | undefined): MemoryConflict => ({
    theirs,
    diff: unifiedDiff(memoryPathOf(scope, name), loaded === undefined ? '' : memoryText(loaded), theirs === undefined ? '' : memoryText(theirs)),
  })

  /** Read `name` and show it in the editor, whatever it held. */
  const readOpen = async (name: string): Promise<void> => {
    const scope = get().scope
    if (scope === undefined) return
    const generation = ++memoryGeneration
    const chosen = selection
    opening = name
    const result = await settle(() => api.read(scope, name))
    if (generation !== memoryGeneration || chosen !== selection) return
    opening = undefined
    if (!result.ok) {
      patch({ notice: { tone: 'error', ...result.notice } })
      return
    }
    if (result.value === null) {
      patch({ notice: { tone: 'info', text: `${idOf(scope, name)} isn't there any more: it may have been deleted elsewhere.` } })
      await loadList()
      return
    }
    editor++
    patch({ open: { memory: result.value, draft: draftOf(result.value) }, asking: keptQuestion() })
  }

  /**
   * What the vault has now for the memory in the editor, `theirs`, does to it: the same text only freshens what the page
   * holds (the commit, `held`); a clean editor takes a new text; one with edits keeps them, and `theirs` becomes the conflict,
   * unless it is the draft itself (the echo of the page's own save).
   */
  const takeTheirs = (scope: ScopeKey, current: OpenMemory, theirs: Memory | undefined): void => {
    const loaded = current.memory
    if (loaded === undefined) return
    if (theirs === undefined) {
      if (memoryDirty(current)) {
        patch({ open: { ...current, conflict: conflictOf(scope, loaded.name, loaded, undefined) } })
      } else {
        showEditor(undefined)
        patch({ notice: { tone: 'info', text: `${idOf(scope, loaded.name)} was deleted elsewhere.` } })
      }
      return
    }
    if (sameText(theirs, loaded)) {
      // Nothing changed underneath what the editor loaded (a release, another memory's commit, or a change undone).
      patch({ open: { memory: theirs, draft: current.draft } })
    } else if (!memoryDirty(current)) {
      patch({ open: { memory: theirs, draft: draftOf(theirs) } })
    } else if (sameText(theirs, current.draft)) {
      patch({ open: { memory: theirs, draft: current.draft } })
    } else {
      patch({ open: { ...current, conflict: conflictOf(scope, loaded.name, loaded, theirs) } })
    }
  }

  /** Read the memory in the editor again, after a live event or a write that may have changed it. */
  const refreshOpen = async (): Promise<void> => {
    if (opening !== undefined) {
      // The read that is opening it may have been made before the change: it is made again.
      await readOpen(opening)
      return
    }
    const { scope, open } = get()
    if (scope === undefined || open?.memory === undefined) return
    if (writing()) {
      eventWhileWriting = true
      return
    }
    const name = open.memory.name
    const generation = ++memoryGeneration
    const result = await settle(() => api.read(scope, name))
    if (generation !== memoryGeneration) return
    // A refresh that failed leaves what is shown alone.
    if (!result.ok) return
    if (writing()) {
      eventWhileWriting = true
      return
    }
    const current = get().open
    if (current?.memory?.name !== name || get().scope !== scope) return
    takeTheirs(scope, current, result.value ?? undefined)
  }

  /** After a write: the live event that came meanwhile is read now, when the page knows its own commit. */
  const settleEvents = async (): Promise<void> => {
    if (!eventWhileWriting) return
    eventWhileWriting = false
    await refreshOpen()
  }

  // --- the direction ------------------------------------------------------------------------------

  const adoptDirection = (info: DirectionInfo): void => {
    patch({ direction: { info, draft: directionBase(info), note: '' } })
    setError('direction', undefined)
  }

  const loadDirection = async (): Promise<void> => {
    const family = familyOf(get().scope)
    if (family === undefined) return
    const generation = ++directionGeneration
    const result = await settle(() => api.direction(family), 'direction')
    if (generation !== directionGeneration || familyOf(get().scope) !== family) return
    if (!result.ok) {
      setError('direction', result.notice)
      return
    }
    adoptDirection(result.value)
  }

  /** What the config store has now for the family's direction, `theirs`, does to the editor: as `takeTheirs` does for a memory. */
  const takeDirection = (family: string, current: DirectionState, theirs: DirectionInfo): void => {
    const loaded = directionBase(current.info)
    if (directionBase(theirs) === loaded) {
      patch({ direction: { info: theirs, draft: current.draft, note: current.note } })
    } else if (!directionDirty(current)) {
      patch({ direction: { info: theirs, draft: directionBase(theirs), note: current.note } })
    } else if (directionBase(theirs) === current.draft) {
      patch({ direction: { info: theirs, draft: current.draft, note: current.note } })
    } else {
      const diff = unifiedDiff(directionPath(family), loaded, directionBase(theirs))
      patch({ direction: { ...current, conflict: { theirs: directionBase(theirs), commit: theirs.commit, diff } } })
    }
  }

  /** Read the direction again, after a live event: what it has now goes through `takeDirection`. */
  const refreshDirection = async (): Promise<void> => {
    const family = familyOf(get().scope)
    if (family === undefined) return
    if (get().direction === undefined) {
      // Not read yet: the tab shown reads it, and one not shown reads it when it opens.
      if (get().tab === 'direction') await loadDirection()
      return
    }
    if (get().busy === 'direction') {
      directionEventWhileWriting = true
      return
    }
    const generation = ++directionGeneration
    const result = await settle(() => api.direction(family), 'direction')
    if (generation !== directionGeneration || familyOf(get().scope) !== family || !result.ok) return
    if (get().busy === 'direction') {
      directionEventWhileWriting = true
      return
    }
    const current = get().direction
    if (current !== undefined) takeDirection(family, current, result.value)
  }

  const settleDirectionEvents = async (): Promise<void> => {
    if (!directionEventWhileWriting) return
    directionEventWhileWriting = false
    await refreshDirection()
  }

  // --- history and the preview --------------------------------------------------------------------

  /**
   * The scope's log. With `more`, the page below the oldest commit held, added at the end (`loadOlder`). Without, the newest
   * page: the log itself when there is none yet, and otherwise merged into the one held, so that a live change keeps the older
   * pages, the commit shown open and a revert being asked about. The commits newer than the first one held go on top; when
   * the page doesn't reach it (more than a page of new commits), the newest page takes the log's place.
   */
  const loadHistory = async (more = false): Promise<void> => {
    const scope = get().scope
    if (scope === undefined) return
    if (more) {
      await loadOlder(scope)
      return
    }
    const generation = ++historyGeneration
    const result = await settle(() => api.history(scope, ''))
    if (generation !== historyGeneration || get().scope !== scope) return
    if (!result.ok) {
      setError('history', result.notice)
      return
    }
    setError('history', undefined)
    const page = result.value
    const current = get().history
    const first = current?.commits[0]
    const joins = first === undefined ? -1 : page.findIndex(commit => commit.id === first.id)
    if (current !== undefined && joins !== -1) {
      patch({ history: { ...current, commits: [...page.slice(0, joins), ...current.commits] } })
      return
    }
    // A page of older commits under way would be added below a log that is no longer there.
    olderGeneration++
    const history: HistoryState = { commits: page, more: page.length === HISTORY_PAGE }
    const listed = (id: string | undefined): boolean => id !== undefined && page.some(commit => commit.id === id)
    if (current?.detail !== undefined && listed(current.detail.info.id)) history.detail = current.detail
    if (listed(current?.opening)) history.opening = current!.opening
    patch({ history })
  }

  /** The page of the log below the oldest commit held, added at the end. */
  const loadOlder = async (scope: ScopeKey): Promise<void> => {
    const previous = get().history
    if (previous === undefined || !previous.more || previous.loadingMore === true || previous.commits.length === 0) return
    const before = previous.commits[previous.commits.length - 1]!.id
    const generation = ++olderGeneration
    patch({ history: { ...previous, loadingMore: true } })
    const result = await settle(() => api.history(scope, before))
    const current = get().history
    if (generation !== olderGeneration || get().scope !== scope || current === undefined) return
    if (!result.ok) {
      patch({ history: { ...current, loadingMore: false } })
      setError('history', result.notice)
      return
    }
    const held = new Set(current.commits.map(commit => commit.id))
    const older = result.value.filter(commit => !held.has(commit.id))
    patch({ history: { ...current, commits: [...current.commits, ...older], more: result.value.length === HISTORY_PAGE, loadingMore: false } })
    setError('history', undefined)
  }

  const loadCommit = async (id: string): Promise<void> => {
    const history = get().history
    if (history === undefined) return
    const generation = ++detailGeneration
    setError('commit', undefined)
    if (history.detail?.info.id === id) {
      const { detail: _detail, opening: _opening, ...rest } = history
      patch({ history: rest })
      return
    }
    patch({ history: { ...history, opening: id } })
    const result = await settle(() => api.commit(id))
    const current = get().history
    if (generation !== detailGeneration || current === undefined) return
    if (!result.ok) {
      setError('commit', result.notice)
      return
    }
    const { opening: _opening, ...rest } = current
    patch({ history: { ...rest, detail: result.value } })
  }

  const loadPreview = async (): Promise<void> => {
    const scope = get().scope
    if (scope === undefined) return
    const generation = ++previewGeneration
    const result = await settle(() => api.preview(scope))
    if (generation !== previewGeneration || get().scope !== scope) return
    if (!result.ok) {
      setError('preview', result.notice)
      return
    }
    patch({ preview: result.value.text })
    setError('preview', undefined)
  }

  /** After the scope changed: the tab shown reads again, and what is not shown is dropped, to be read when its tab opens. */
  const refreshPreview = async (): Promise<void> => {
    if (get().tab === 'preview') await loadPreview()
    else if (get().preview !== undefined) {
      previewGeneration++
      patch({ preview: undefined })
    }
  }

  const refreshHistory = async (): Promise<void> => {
    if (get().tab === 'history') await loadHistory()
    else if (get().history !== undefined) {
      historyGeneration++
      olderGeneration++
      detailGeneration++
      patch({ history: undefined })
    }
  }

  // --- choosing what is shown ---------------------------------------------------------------------

  /** What the tab shown needs when it has nothing. */
  const loadTab = async (): Promise<void> => {
    const { tab, direction, history } = get()
    if (tab === 'direction' && direction === undefined) await loadDirection()
    else if (tab === 'history' && history === undefined) await loadHistory()
    else if (tab === 'preview') await loadPreview()
  }

  /** Show `key` from nothing: what was shown of the last scope goes. */
  const choose = async (key: ScopeKey): Promise<void> => {
    selection++
    listGeneration++
    directionGeneration++
    historyGeneration++
    olderGeneration++
    detailGeneration++
    previewGeneration++
    showEditor(undefined)
    const tab = visibleTabs(key).includes(get().tab) ? get().tab : 'memories'
    const scopesError = get().errors.scopes
    patch({
      scope: key,
      tab,
      memories: undefined,
      direction: undefined,
      history: undefined,
      preview: undefined,
      asking: undefined,
      notice: undefined,
      errors: scopesError === undefined ? {} : { scopes: scopesError },
    })
    await Promise.all([loadList(), loadTab()])
  }

  /** Read again everything the page shows: when it is shown again, and when the stream (re)opens. */
  const refreshShown = async (): Promise<void> => {
    if (get().scope === undefined) return
    await Promise.all([loadList(), refreshOpen(), refreshDirection(), refreshHistory(), refreshPreview()])
  }

  const startNew = (): void => {
    const scope = get().scope
    if (scope === undefined) return
    showEditor({ memory: undefined, draft: { name: '', type: defaultType(scope), description: '', body: '' } })
  }

  /** Go where the person asked to, the drafts' edits dropped. */
  const leave = async (then: Leave): Promise<void> => {
    switch (then.to) {
      case 'close': showEditor(undefined); return
      case 'new': startNew(); return
      case 'memory': showEditor(undefined); await readOpen(then.name); return
      case 'scope': await choose(then.key); return
    }
  }

  const askToLeave = (then: Leave): void => {
    patch({ asking: { kind: 'discard', then } })
  }

  const editorDirty = (): boolean => {
    const { open } = get()
    return open !== undefined && memoryDirty(open)
  }

  // --- writing ------------------------------------------------------------------------------------

  /** After a write to the scope shown: its list (and with it its counts), and the tabs that show what it changed. */
  const refreshAfterWrite = async (): Promise<void> => {
    await Promise.all([loadList(), refreshPreview(), refreshHistory()])
  }

  const save = async (): Promise<void> => {
    const state = get()
    const { scope, open } = state
    // With a conflict open the save would be refused again: the person picks Reload or Keep mine first.
    if (scope === undefined || open === undefined || state.busy !== undefined || open.conflict !== undefined || !memoryDirty(open)) return
    const sent = open.draft
    const base = open.memory?.commit ?? ''
    const chosen = selection
    const shown = editor
    const id = idOf(scope, sent.name)
    patch({ busy: 'save', notice: undefined })
    const result = await settle(() => api.save(scope, sent.name, sent.type, sent.description, sent.body, base), 'save')
    patch({ busy: undefined })
    const here = chosen === selection && shown === editor
    if (!result.ok) {
      patch({ notice: here ? { tone: 'error', ...result.notice } : { tone: 'error', text: `Couldn't save ${id}`, detail: result.message ?? result.notice.text } })
      if (result.code === 'CONFLICT' && here) {
        const generation = ++memoryGeneration
        const theirs = await settle(() => api.read(scope, sent.name))
        const current = get().open
        if (theirs.ok && generation === memoryGeneration && chosen === selection && shown === editor && current !== undefined) {
          patch({ open: { ...current, conflict: conflictOf(scope, sent.name, current.memory, theirs.value ?? undefined) } })
        }
      }
      await settleEvents()
      return
    }
    const commit = result.value
    patch({ notice: { tone: 'success', text: `Saved ${id} as ${shortId(commit.id)}` } })
    if (!here) {
      await Promise.all([refreshAfterWrite(), settleEvents()])
      return
    }
    // What the editor is saved over is now the page's own save, at once and before any read: the echo of this commit must
    // find it, not the version before, and a read that began before the save is older than it and must not land. What was
    // typed while the save was under way stays, and is still unsaved. The read below fills in what only the vault knows
    // (`modified`, and `held` for a held memory saved unchanged).
    memoryGeneration++
    const before = get().open
    if (before !== undefined) {
      const memory: Memory = {
        scope, name: sent.name, type: sent.type, description: sent.description, body: sent.body,
        modified: new Date(commit.time).toISOString(), commit: commit.id,
      }
      patch({ open: { memory, draft: before.draft !== sent ? before.draft : sent } })
    }
    // A live event that came while the save was out is read after it, unless the read below, newer than it, is made.
    const missed = eventWhileWriting
    eventWhileWriting = false
    const readSaved = async (): Promise<void> => {
      const generation = ++memoryGeneration
      const read = await settle(() => api.read(scope, sent.name))
      const current = get().open
      if (generation !== memoryGeneration || chosen !== selection || shown !== editor || current === undefined) return
      if (!read.ok) {
        if (missed) await refreshOpen()
        return
      }
      takeTheirs(scope, current, read.value ?? undefined)
    }
    await Promise.all([readSaved(), refreshAfterWrite()])
  }

  const doForget = async (name: string): Promise<void> => {
    const { scope, open } = get()
    if (scope === undefined || get().busy !== undefined) return
    const base = open?.memory?.name === name ? open.memory.commit : ''
    const id = idOf(scope, name)
    const chosen = selection
    patch({ busy: 'forget', asking: undefined, notice: undefined })
    const result = await settle(() => api.forget(scope, name, base), 'forget')
    patch({ busy: undefined })
    const here = chosen === selection
    if (!result.ok) {
      patch({ notice: here ? { tone: 'error', ...result.notice } : { tone: 'error', text: `Couldn't delete ${id}`, detail: result.message ?? result.notice.text } })
      if (here && (result.code === 'CONFLICT' || result.code === 'NOT_FOUND')) {
        await Promise.all([loadList(), refreshOpen()])
      }
      await settleEvents()
      return
    }
    patch({ notice: { tone: 'success', text: `Deleted ${id}. Agents stop seeing it at their next compaction or chat.` } })
    if (!here) return
    if (get().open?.memory?.name === name) showEditor(undefined)
    await Promise.all([refreshAfterWrite(), settleEvents()])
  }

  const release = async (name: string): Promise<void> => {
    const { scope } = get()
    if (scope === undefined || get().busy !== undefined) return
    const id = idOf(scope, name)
    const chosen = selection
    patch({ busy: 'release', notice: undefined })
    const result = await settle(() => api.release(scope, name), 'release')
    patch({ busy: undefined })
    if (!result.ok) {
      patch({ notice: chosen === selection ? { tone: 'error', ...result.notice } : { tone: 'error', text: `Couldn't release ${id}`, detail: result.message ?? result.notice.text } })
      await settleEvents()
      return
    }
    patch({ notice: { tone: 'success', text: `Released ${id}. Agents see it from their next compaction or chat.` } })
    if (chosen !== selection) return
    const reread = eventWhileWriting || get().open?.memory?.name === name
    eventWhileWriting = false
    await Promise.all([refreshAfterWrite(), reread ? refreshOpen() : undefined])
  }

  const doRevert = async (id: string): Promise<void> => {
    if (get().busy !== undefined) return
    patch({ busy: `revert:${id}`, asking: undefined, notice: undefined })
    const result = await settle(() => api.revert(id), 'revert')
    patch({ busy: undefined })
    if (!result.ok) {
      patch({ notice: { tone: 'error', ...result.notice } })
      await settleEvents()
      return
    }
    if (result.value === null) {
      patch({ notice: { tone: 'info', text: NOTHING_TO_REVERT } })
      await settleEvents()
      return
    }
    eventWhileWriting = false
    patch({ notice: { tone: 'success', text: `Reverted ${shortId(id)} with a new commit, ${shortId(result.value.id)}` } })
    // The revert changed memories of the scope shown (a commit's memories are one scope's), maybe the one in the editor.
    await Promise.all([loadHistory(), loadList(), refreshOpen(), refreshPreview()])
  }

  const saveDirection = async (): Promise<void> => {
    const state = get()
    const { direction } = state
    const family = familyOf(state.scope)
    if (family === undefined || direction === undefined || state.busy !== undefined || direction.conflict !== undefined || !directionDirty(direction)) return
    const text = direction.draft
    const note = direction.note.trim()
    const chosen = selection
    patch({ busy: 'direction', notice: undefined })
    const result = await settle(() => api.saveDirection(family, text, direction.info.commit, note), 'direction')
    patch({ busy: undefined })
    const here = chosen === selection
    if (!result.ok) {
      patch({ notice: here ? { tone: 'error', ...result.notice } : { tone: 'error', text: `Couldn't save the direction for ${family}`, detail: result.message ?? result.notice.text } })
      if (result.code === 'CONFLICT' && here) {
        const generation = ++directionGeneration
        const theirs = await settle(() => api.direction(family), 'direction')
        const current = get().direction
        if (theirs.ok && generation === directionGeneration && chosen === selection && current !== undefined) {
          const diff = unifiedDiff(directionPath(family), directionBase(current.info), directionBase(theirs.value))
          patch({ direction: { ...current, conflict: { theirs: directionBase(theirs.value), commit: theirs.value.commit, diff } } })
        }
      }
      await settleDirectionEvents()
      return
    }
    const commit = result.value
    patch({ notice: commit === null
      ? { tone: 'info', text: `Nothing to save: the direction for ${family} already says this.` }
      : { tone: 'success', text: `Saved the direction for ${family} as ${shortId(commit.id)}` } })
    if (!here) {
      directionEventWhileWriting = false
      return
    }
    // As for a memory: what the editor is saved over is the page's own save, at once, so that its echo finds it and an older
    // read can't land; what was typed meanwhile stays. With nothing committed (`null`) the text is the one there, at a commit
    // the read below tells.
    directionGeneration++
    const before = get().direction
    if (before !== undefined) {
      const typed = before.draft !== text
      const info = { ...before.info, text, missing: false, ...(commit === null ? {} : { commit: commit.id }) }
      patch({ direction: { info, draft: typed ? before.draft : text, note: typed ? before.note : '' } })
    }
    const missed = directionEventWhileWriting
    directionEventWhileWriting = false
    const generation = ++directionGeneration
    const read = await settle(() => api.direction(family), 'direction')
    if (generation === directionGeneration && chosen === selection) {
      if (read.ok) {
        const current = get().direction
        if (current !== undefined) takeDirection(family, current, read.value)
      } else if (missed) {
        await refreshDirection()
      }
    }
    await refreshPreview()
  }

  // --- the face -----------------------------------------------------------------------------------

  const open = async (): Promise<void> => {
    opened = true
    const remote = get().remote === undefined ? loadRemote() : undefined
    // You comes first in every vault, so its list is read beside the scopes, not after them.
    const shown = get().scope === undefined ? choose('user') : refreshShown()
    await Promise.all([refreshScopes(), shown, remote])
  }

  const face: MemoryActions = {
    // A store to read and subscribe to, not the one the controller writes.
    hooks: { page: { getSnapshot: store.getSnapshot, subscribe: store.subscribe } },
    open,
    async selectScope(key) {
      const state = get()
      if (key === state.scope && state.memories !== undefined && state.errors.memories === undefined) return
      const direction = state.direction
      if (editorDirty() || (direction !== undefined && directionDirty(direction))) {
        askToLeave({ to: 'scope', key })
        return
      }
      await choose(key)
    },
    async setTab(tab) {
      if (!visibleTabs(get().scope).includes(tab)) return
      patch({ tab })
      if (tab === 'direction' && get().direction === undefined) await loadDirection()
      else if (tab === 'history') await loadHistory()
      else if (tab === 'preview') await loadPreview()
    },
    async openMemory(name) {
      const { open } = get()
      if (open?.memory?.name === name) return
      if (editorDirty()) {
        askToLeave({ to: 'memory', name })
        return
      }
      await readOpen(name)
    },
    async newMemory() {
      if (editorDirty()) {
        askToLeave({ to: 'new' })
        return
      }
      startNew()
    },
    edit(field, value) {
      const { open } = get()
      if (open === undefined) return
      if (field === 'name' && open.memory !== undefined) return
      if (field === 'type' && !isType(value)) return
      patch({ open: { ...open, draft: { ...open.draft, [field]: value } } })
    },
    save,
    forget(name) {
      const state = get()
      const target = name ?? state.open?.memory?.name
      if (target === undefined || state.busy !== undefined) return
      patch({ asking: { kind: 'forget', name: target } })
    },
    release,
    async reload() {
      const { open } = get()
      if (open?.conflict === undefined) return
      const theirs = open.conflict.theirs
      if (theirs === undefined) {
        // It was deleted: there is nothing to reload, and the edit goes with it.
        showEditor(undefined)
        return
      }
      // Theirs is shown at once, so a live event that comes while the read is out finds no edit to protect. Then it is read
      // again, for anything newer.
      patch({ open: { memory: theirs, draft: draftOf(theirs) } })
      await refreshOpen()
    },
    keepMine(what = 'memory') {
      if (what === 'direction') {
        const { direction } = get()
        if (direction?.conflict === undefined) return
        const { theirs, commit } = direction.conflict
        patch({ direction: { info: { ...direction.info, text: theirs, commit, missing: false }, draft: direction.draft, note: direction.note } })
        return
      }
      const { open } = get()
      if (open?.conflict === undefined) return
      // Saved over what is there now; over nothing, as a new memory, when it was deleted.
      patch({ open: { memory: open.conflict.theirs, draft: open.draft } })
    },
    async closeMemory() {
      if (editorDirty()) {
        askToLeave({ to: 'close' })
        return
      }
      showEditor(undefined)
    },
    editDirection(text) {
      const { direction } = get()
      if (direction !== undefined) patch({ direction: { ...direction, draft: text } })
    },
    setDirectionNote(note) {
      const { direction } = get()
      if (direction !== undefined) patch({ direction: { ...direction, note } })
    },
    saveDirection,
    async reloadDirection() {
      const { direction } = get()
      if (direction !== undefined) {
        // The edit goes first, as for a memory; a conflict's text is what is there now.
        const theirs = direction.conflict
        const info = theirs === undefined ? direction.info : { ...direction.info, text: theirs.theirs, commit: theirs.commit, missing: false }
        patch({ direction: { info, draft: directionBase(info), note: '' } })
      }
      await loadDirection()
    },
    loadHistory,
    loadCommit,
    revert(id) {
      if (get().busy !== undefined) return
      patch({ asking: { kind: 'revert', id } })
    },
    loadPreview,
    async confirm() {
      const { asking } = get()
      if (asking === undefined) return
      switch (asking.kind) {
        case 'forget': await doForget(asking.name); return
        case 'revert': await doRevert(asking.id); return
        case 'discard':
          patch({ asking: undefined })
          await leave(asking.then)
          return
      }
    },
    cancel() {
      patch({ asking: undefined })
    },
    dismiss() {
      patch({ notice: undefined })
    },
  }

  return {
    face,
    getState: get,

    async onEvent(event, opening) {
      if (event.kind === 'remote') patch({ remote: event.status })
      if (opening) {
        // The first item of every stream, the very first included: what changed between the page's own reads and the
        // stream's subscription, or while the carrier was lost, would otherwise be missed.
        patch({ stream: 'live' })
        if (opened) await Promise.all([refreshScopes(), refreshShown()])
        return
      }
      if (!opened) return
      switch (event.kind) {
        case 'changed': {
          const { scope } = get()
          const tasks: Array<Promise<void>> = []
          const shown = scope !== undefined && event.scopes.includes(scope)
          if (shown) tasks.push(loadList(), refreshOpen(), refreshHistory())
          // A family's message holds the user's memory too.
          if (shown || (scope !== undefined && event.scopes.includes('user'))) tasks.push(refreshPreview())
          if (event.scopes.some(key => key !== scope)) tasks.push(refreshScopes())
          await Promise.all(tasks)
          return
        }
        case 'direction':
          if (familyOf(get().scope) === event.family) await Promise.all([refreshDirection(), refreshPreview()])
          return
        case 'remote':
          return
      }
    },
    streamDown() {
      patch({ stream: 'down' })
    },
  }
}
