/**
 * The History page's state and what it does: it calls the remote, keeps what it learns in one snapshot store, and
 * refreshes the views the page has open when `watch` says the store changed. No React here; the components read
 * the store through the `usePage` hook the slot gives them and act through `HistoryActions`.
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { CommitInfo, ConfigEvent, FileDiff, NamespaceInfo, Outcome, ProposalInfo, RemoteStatus } from '../protocol.ts'
import { orderProposals, shortId } from './format.ts'
import { NOTHING_TO_ACCEPT, NOTHING_TO_REVERT, failureNotice, unexpectedNotice, type Action, type Notice } from './outcome.ts'
import type { ConfigApi } from './remote.ts'

/** How many commits the log asks for at a time (the server's own default, said out loud). */
export const PAGE = 50

/** What the page shows: the log, one commit, or the proposals. */
export type View =
  | { kind: 'log' }
  | { kind: 'commit', id: string }
  | { kind: 'proposals' }

export interface LogState {
  commits: CommitInfo[]
  /** Whether a page of the log has arrived (an error before that leaves it `false`). */
  loaded: boolean
  loading: boolean
  loadingMore: boolean
  /** Whether the last page was full, so there may be more below it. */
  more: boolean
  error?: Notice
}

export interface DetailState {
  id: string
  status: 'loading' | 'ready' | 'error'
  info?: CommitInfo
  diffs?: FileDiff[]
  error?: Notice
}

export interface ProposalsState {
  items: ProposalInfo[]
  loaded: boolean
  loading: boolean
  error?: Notice
}

/** One proposal's diff, fetched when its card opens. */
export type DiffState =
  | { status: 'loading' }
  | { status: 'ready', diffs: FileDiff[] }
  | { status: 'error', error: Notice }

/** The outcome of the last thing the person did, shown above the view until they move on. */
export interface PageNotice extends Notice {
  tone: 'info' | 'success' | 'error'
}

export interface PageState {
  view: View
  /** Whether `watch` is delivering: `down` between a lost carrier and the next item. */
  stream: 'connecting' | 'live' | 'down'
  remote?: RemoteStatus
  namespaces: NamespaceInfo[]
  /** The log's filter: `''` for all. */
  prefix: string
  log: LogState
  detail?: DetailState
  proposals: ProposalsState
  proposalDiffs: Record<string, DiffState>
  notice?: PageNotice
  /** What is being done now, as `<action>:<id>`, so a second click can't start it again. */
  busy?: string
}

/** What a component can ask of the page, beside the `usePage` hook the `hooks` entry becomes. */
export interface HistoryActions {
  hooks: { page: SnapshotStore<PageState> }
  /** The page was shown: load what it needs, or read again what it has. */
  open(): void
  show(view: View): void
  setPrefix(prefix: string): void
  loadMore(): void
  /** Read the open view again. */
  reload(): void
  revert(id: string): void
  accept(id: string): void
  /** Resolves `true` once the store has rejected it; `false` when it refused (the page has said why) or another action was running. */
  reject(id: string, reason: string): Promise<boolean>
  loadProposal(id: string): void
  dismiss(): void
}

export interface HistoryController {
  face: HistoryActions
  /**
   * One item of `watch`. `opening` is whether it is the first of a stream the page has (re)opened (or of a new
   * generation of one, after the carrier was lost and found again): events may have been missed, so every loaded view is read again.
   */
  receive(event: ConfigEvent, opening: boolean): void
  /** `watch` lost its carrier; the page keeps what it has and says so. */
  streamDown(): void
}

type Settled<T> = { ok: true, value: T } | { ok: false, notice: Notice }

/**
 * Wait for a call and fold both kinds of failure (the carrier's and the store's) into a `Notice`. Never throws.
 * @param action - what the person was doing, for the refusals whose wording depends on it.
 */
async function settle<T>(task: () => Promise<RemoteResult<Outcome<T>>>, action?: Action): Promise<Settled<T>> {
  try {
    const result = await task()
    if (!result.ok) return { ok: false, notice: unexpectedNotice(result.error) }
    const outcome = result.value
    if (!outcome.ok) return { ok: false, notice: failureNotice(outcome.code, outcome.message, action) }
    return { ok: true, value: outcome.value }
  } catch (error) {
    return { ok: false, notice: unexpectedNotice(error) }
  }
}

/** `settle` for a call with no `Outcome` of its own. */
async function settlePlain<T>(task: () => Promise<RemoteResult<T>>): Promise<Settled<T>> {
  try {
    const result = await task()
    return result.ok ? { ok: true, value: result.value } : { ok: false, notice: unexpectedNotice(result.error) }
  } catch (error) {
    return { ok: false, notice: unexpectedNotice(error) }
  }
}

/**
 * Make `task` run one at a time: a call while it is running does not start another, but makes it run once more when it
 * ends, so what happened meanwhile is read. `task` must not throw.
 */
function coalesce(task: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | undefined
  let again = false
  return () => {
    if (running !== undefined) {
      again = true
      return running
    }
    running = (async () => {
      try {
        do {
          again = false
          await task()
        } while (again)
      } finally {
        running = undefined
      }
    })()
    return running
  }
}

export function createHistory(api: ConfigApi): HistoryController {
  const state = createSnapshotStore<PageState>({
    view: { kind: 'log' },
    stream: 'connecting',
    namespaces: [],
    prefix: '',
    log: { commits: [], loaded: false, loading: false, loadingMore: false, more: false },
    proposals: { items: [], loaded: false, loading: false },
    proposalDiffs: {},
  })
  const get = (): PageState => state.getSnapshot()
  const patch = (next: Partial<PageState>): void => { state.set({ ...get(), ...next }) }
  const patchLog = (next: Partial<LogState>): void => { patch({ log: { ...get().log, ...next } }) }
  const patchProposals = (next: Partial<ProposalsState>): void => { patch({ proposals: { ...get().proposals, ...next } }) }

  /** Bumped when the log's filter changes, so an answer for the old filter is dropped. */
  let logGeneration = 0

  const loadNamespaces = async (): Promise<void> => {
    const result = await settlePlain(() => api.namespaces())
    if (result.ok) patch({ namespaces: result.value })
  }

  /**
   * Read the newest page of the log. The first time (or when it shares no commit with what is shown, so there is
   * a gap) it replaces the list; otherwise the commits it has not seen go on top, and the rows below, and any
   * "Load more" that was done, stay.
   */
  const readLog = async (): Promise<void> => {
    const generation = logGeneration
    const { prefix, log: before } = get()
    if (!before.loaded) patchLog({ loading: true, error: undefined })
    const result = await settle(() => api.history(prefix, PAGE, ''))
    if (generation !== logGeneration) return
    if (!result.ok) {
      patchLog({ loading: false, error: result.notice })
      return
    }
    const log = get().log
    const fresh = result.value
    const known = new Set(log.commits.map(commit => commit.id))
    const added = fresh.filter(commit => !known.has(commit.id))
    const joins = log.loaded && added.length < fresh.length
    patchLog(joins
      ? { commits: [...added, ...log.commits], loaded: true, loading: false, error: undefined }
      : { commits: fresh, more: fresh.length >= PAGE, loaded: true, loading: false, error: undefined })
  }
  const refreshLog = coalesce(readLog)

  const readProposals = async (): Promise<void> => {
    if (!get().proposals.loaded) patchProposals({ loading: true, error: undefined })
    const result = await settle(() => api.proposals(''))
    if (!result.ok) {
      patchProposals({ loading: false, error: result.notice })
      return
    }
    patchProposals({ items: orderProposals(result.value), loaded: true, loading: false, error: undefined })
  }
  const refreshProposals = coalesce(readProposals)

  const loadCommit = async (id: string): Promise<void> => {
    patch({ detail: { id, status: 'loading' } })
    const result = await settle(() => api.commit(id))
    if (get().detail?.id !== id) return
    patch({
      detail: result.ok
        ? { id, status: 'ready', info: result.value.info, diffs: result.value.diffs }
        : { id, status: 'error', error: result.notice },
    })
  }

  const loadMore = async (): Promise<void> => {
    const { prefix, log } = get()
    const last = log.commits[log.commits.length - 1]
    if (last === undefined || !log.more || log.loadingMore) return
    const generation = logGeneration
    patchLog({ loadingMore: true, error: undefined })
    const result = await settle(() => api.history(prefix, PAGE, last.id))
    if (generation !== logGeneration) return
    if (!result.ok) {
      patchLog({ loadingMore: false, error: result.notice })
      return
    }
    const current = get().log
    const known = new Set(current.commits.map(commit => commit.id))
    patchLog({
      commits: [...current.commits, ...result.value.filter(commit => !known.has(commit.id))],
      more: result.value.length >= PAGE,
      loadingMore: false,
    })
  }

  const loadProposal = async (id: string): Promise<void> => {
    // Loading or loaded is already in hand; a failed one is asked for again.
    const current = get().proposalDiffs[id]
    if (current !== undefined && current.status !== 'error') return
    patch({ proposalDiffs: { ...get().proposalDiffs, [id]: { status: 'loading' } } })
    const result = await settle(() => api.proposal(id))
    // An event that arrived meanwhile cleared the cache: this answer may be of a proposal that is gone or replaced.
    if (get().proposalDiffs[id]?.status !== 'loading') return
    patch({
      proposalDiffs: {
        ...get().proposalDiffs,
        [id]: result.ok ? { status: 'ready', diffs: result.value.diffs } : { status: 'error', error: result.notice },
      },
    })
  }

  /**
   * Run one of the person's actions: one at a time, and its outcome becomes the page's notice.
   * @returns whether it succeeded; `false` too when another action was running, which this one did not start.
   */
  const act = async <T>(key: string, task: () => Promise<Settled<T>>, done: (value: T) => void, refreshOnFailure = false): Promise<boolean> => {
    if (get().busy !== undefined) return false
    patch({ busy: key, notice: undefined })
    const result = await task()
    patch({ busy: undefined })
    if (result.ok) {
      done(result.value)
      return true
    }
    patch({ notice: { tone: 'error', ...result.notice } })
    if (refreshOnFailure) void refreshProposals()
    return false
  }

  /** Read again what the page has, or is still reading (that read may have started before what changed). Nothing if it has opened nothing. */
  const refreshLoaded = (): void => {
    const { log, proposals } = get()
    if (log.loaded || log.loading) void refreshLog()
    if (proposals.loaded || proposals.loading) void refreshProposals()
  }

  const face: HistoryActions = {
    hooks: { page: state },
    open() {
      void loadNamespaces()
      void refreshLog()
      void refreshProposals()
    },
    show(view) {
      patch({ view, notice: undefined })
      if (view.kind === 'commit') void loadCommit(view.id)
      else if (view.kind === 'proposals') void refreshProposals()
      else void refreshLog()
    },
    setPrefix(prefix) {
      logGeneration++
      patch({ prefix, log: { commits: [], loaded: false, loading: true, loadingMore: false, more: false } })
      void refreshLog()
    },
    loadMore() { void loadMore() },
    reload() {
      const { view } = get()
      if (view.kind === 'commit') void loadCommit(view.id)
      else if (view.kind === 'proposals') void refreshProposals()
      else void refreshLog()
    },
    revert(id) {
      void act(`revert:${id}`, () => settle(() => api.revert(id), 'revert'), (commit) => {
        if (commit === null) {
          patch({ notice: { tone: 'info', text: NOTHING_TO_REVERT } })
          return
        }
        void refreshLog()
        patch({
          view: { kind: 'log' },
          detail: undefined,
          notice: { tone: 'success', text: `Reverted ${shortId(id)} with a new commit, ${shortId(commit.id)}` },
        })
      })
    },
    accept(id) {
      void act(`accept:${id}`, () => settle(() => api.accept(id), 'accept'), (commit) => {
        void refreshProposals()
        void refreshLog()
        patch({
          notice: commit === null
            ? { tone: 'info', text: NOTHING_TO_ACCEPT }
            : { tone: 'success', text: `Accepted: main is now at ${shortId(commit.id)}` },
        })
      }, true)
    },
    reject(id, reason) {
      return act(`reject:${id}`, () => settle(() => api.reject(id, reason), 'reject'), () => {
        void refreshProposals()
        patch({ notice: { tone: 'success', text: 'Rejected' } })
      }, true)
    },
    loadProposal(id) { void loadProposal(id) },
    dismiss() { patch({ notice: undefined }) },
  }

  return {
    face,
    receive(event, opening) {
      if (opening) {
        // The first item of every stream, the very first included: a commit made between the page's own read and the
        // stream's subscription would otherwise be missed. Nothing loaded (or loading) makes this nothing.
        patch({ stream: 'live' })
        refreshLoaded()
      }
      switch (event.kind) {
        case 'remote':
          patch({ remote: event.status })
          break
        case 'changed':
          refreshLoaded()
          break
        case 'proposal':
          // A proposal that was rebuilt or moved on has a different diff.
          patch({ proposalDiffs: {} })
          if (get().proposals.loaded || get().proposals.loading) void refreshProposals()
          break
      }
    },
    streamDown() {
      patch({ stream: 'down' })
    },
  }
}
