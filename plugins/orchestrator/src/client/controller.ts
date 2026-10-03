/**
 * The Settings → Runs page's state and what it does: it calls the remote, and keeps what it learns in one snapshot store. No
 * React here, and nothing that only a browser or only dsh can load, so `node --test` runs it against a fake remote
 * (`test/controller.test.ts`). The component reads the store through the `usePage` hook the slot gives it and acts through
 * `RunsActions`. It is built like workspaces' `createAppCard` (client/controller.ts).
 *
 * The page has two views: the list of runs, and one run (its record, what its ledger says, and its timeline). Opening a run
 * reads its detail and the first page of its ledger together; "Load older" reads the page before, up to `TIMELINE_MAX` lines,
 * as Settings → Judge's decisions table does (judge's `loadMore`).
 *
 * **Read only.** Nothing here changes a run: the remote has no call that could.
 *
 * Answers that arrive after the person has moved on (another run, the list, a newer read) are dropped, by a counter per kind
 * of answer, and the controller can be thrown away (`dispose`): the scope that made it ends when the remote goes, and a call
 * still out then changes nothing.
 */

import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { LedgerLine, LedgerPage, Outcome, RunDetail, RunRow } from '../protocol.ts'
import { failureNotice, unexpectedNotice } from './outcome.ts'
import type { Notice } from './outcome.ts'
import type { RunsApi } from './remote.ts'

/** How many ledger lines a page reads. */
export const TIMELINE_PAGE = 200
/** The most lines the timeline holds: past it, older lines aren't shown. */
export const TIMELINE_MAX = 2000

export type Load = 'idle' | 'loading' | 'ready' | 'error'

export interface PageState {
  list: { load: Load, rows: RunRow[], error?: Notice }
  /** The run shown, if one is. */
  selected?: { project: string, id: string }
  detail: { load: Load, value?: RunDetail, error?: Notice }
  timeline: {
    load: Load
    /** Oldest first, as shown. */
    lines: LedgerLine[]
    /** The cursor of the page before the oldest shown: there while an older line exists and the cap isn't reached. */
    next?: string
    /** Unreadable lines the pages read so far went through. */
    skipped: number
    more: 'idle' | 'loading'
    /** Why the last older page couldn't be read. */
    moreError?: Notice
    /** `TIMELINE_MAX` lines are shown, and there are older ones. */
    capped: boolean
    error?: Notice
  }
}

/** What a component can ask of the page, beside the `usePage` hook the `hooks` entry becomes. */
export interface RunsActions {
  hooks: { page: ObservableSnapshot<PageState> }
  /**
   * The section was shown: read the list, and the selected run again. (No member may be called `close`: the settings shell
   * hands every section a `close` prop of its own, which wins over a face's.)
   */
  open(): Promise<void>
  /** Read the list again, and the selected run and the newest page of its timeline. */
  refresh(): Promise<void>
  /** Show run `id` of `project`: its detail and the first page of its timeline, read together. */
  select(project: string, id: string): Promise<void>
  /** Back to the list. */
  back(): void
  /** Read the page before the oldest line shown. */
  loadOlder(): Promise<void>
}

export interface RunsController {
  /** What the component gets: the observable and the actions, and nothing that feeds the controller. */
  face: RunsActions
  getState(): PageState
  /** The controller is being thrown away: a call still out changes nothing when it lands, and nothing new is asked. */
  dispose(): void
}

// --- calls ---------------------------------------------------------------------------------------

type Settled<T> = { ok: true, value: T } | { ok: false, notice: Notice }

/** Wait for a call and fold a failure (the carrier's, or a throw) into a `Notice`. Never throws. */
async function settlePlain<T>(task: () => Promise<RemoteResult<T>>): Promise<Settled<T>> {
  try {
    const result = await task()
    return result.ok ? { ok: true, value: result.value } : { ok: false, notice: unexpectedNotice(result.error) }
  } catch (error) {
    return { ok: false, notice: unexpectedNotice(error) }
  }
}

/** `settlePlain` for a call whose value is an `Outcome`: a refusal becomes a `Notice` with the server's message. */
async function settle<T>(task: () => Promise<RemoteResult<Outcome<T>>>): Promise<Settled<T>> {
  const result = await settlePlain(task)
  if (!result.ok) return result
  const outcome = result.value
  return outcome.ok ? { ok: true, value: outcome.value } : { ok: false, notice: failureNotice(outcome.code, outcome.message) }
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

const EMPTY_TIMELINE: PageState['timeline'] = { load: 'idle', lines: [], skipped: 0, more: 'idle', capped: false }

/** A page as the timeline holds it: oldest first. */
function oldestFirst(page: LedgerPage): LedgerLine[] {
  return [...page.lines].reverse()
}

/** @param api - the `dishRuns` remote. */
export function createRunsPage(api: RunsApi): RunsController {
  const store = createStore<PageState>({
    list: { load: 'idle', rows: [] },
    detail: { load: 'idle' },
    timeline: { ...EMPTY_TIMELINE },
  })
  const get = (): PageState => store.getSnapshot()
  const patch = (next: Partial<PageState>): void => { store.set({ ...get(), ...next }) }
  const patchList = (next: Partial<PageState['list']>): void => { patch({ list: { ...get().list, ...next } }) }
  const patchDetail = (next: Partial<PageState['detail']>): void => { patch({ detail: { ...get().detail, ...next } }) }
  const patchTimeline = (next: Partial<PageState['timeline']>): void => { patch({ timeline: { ...get().timeline, ...next } }) }

  /** Bumped by a newer read of the list. */
  let listGeneration = 0
  /** Bumped by a newer read of the selected run, or another selection, or back. */
  let detailGeneration = 0
  /** Bumped by a newer first page, another selection, or back: an older page for the timeline before it is for nothing. */
  let timelineGeneration = 0
  let disposed = false

  const loadList = async (): Promise<void> => {
    if (disposed) return
    const generation = ++listGeneration
    patchList({ load: 'loading', error: undefined })
    const result = await settlePlain(() => api.runs())
    if (disposed || generation !== listGeneration) return
    if (!result.ok) {
      patchList({ load: 'error', error: result.notice })
      return
    }
    patchList({ load: 'ready', rows: result.value, error: undefined })
  }

  /** Read the selected run's detail. What it showed stays until the answer is in hand. */
  const loadDetail = async (project: string, id: string): Promise<void> => {
    const generation = ++detailGeneration
    patchDetail({ load: 'loading', error: undefined })
    const result = await settle(() => api.run(project, id))
    if (disposed || generation !== detailGeneration) return
    if (!result.ok) {
      patchDetail({ load: 'error', value: undefined, error: result.notice })
      return
    }
    patchDetail({ load: 'ready', value: result.value, error: undefined })
  }

  /** Read the newest page of the selected run's ledger. What it showed stays until the answer is in hand. */
  const loadTimeline = async (project: string, id: string): Promise<void> => {
    const generation = ++timelineGeneration
    patchTimeline({ load: 'loading', error: undefined, more: 'idle', moreError: undefined })
    const result = await settle(() => api.ledger(project, id, TIMELINE_PAGE, ''))
    if (disposed || generation !== timelineGeneration) return
    if (!result.ok) {
      patchTimeline({ load: 'error', lines: [], next: undefined, skipped: 0, capped: false, error: result.notice })
      return
    }
    const page = result.value
    patchTimeline({ load: 'ready', lines: oldestFirst(page), next: page.next, skipped: page.skipped, capped: false, error: undefined })
  }

  const loadSelected = async (): Promise<void> => {
    const selected = get().selected
    if (selected === undefined) return
    await Promise.all([loadDetail(selected.project, selected.id), loadTimeline(selected.project, selected.id)])
  }

  const refresh = async (): Promise<void> => {
    if (disposed) return
    await Promise.all([loadList(), loadSelected()])
  }

  const select = async (project: string, id: string): Promise<void> => {
    if (disposed) return
    // Another run's answers, and an older page of its timeline, are for nothing now; so is what it showed.
    patch({ selected: { project, id }, detail: { load: 'idle' }, timeline: { ...EMPTY_TIMELINE } })
    await loadSelected()
  }

  const back = (): void => {
    if (disposed) return
    detailGeneration++
    timelineGeneration++
    patch({ selected: undefined, detail: { load: 'idle' }, timeline: { ...EMPTY_TIMELINE } })
  }

  const loadOlder = async (): Promise<void> => {
    const selected = get().selected
    const timeline = get().timeline
    if (disposed || selected === undefined || timeline.next === undefined || timeline.load !== 'ready' || timeline.more === 'loading') return
    const generation = timelineGeneration
    patchTimeline({ more: 'loading', moreError: undefined })
    const result = await settle(() => api.ledger(selected.project, selected.id, TIMELINE_PAGE, timeline.next ?? ''))
    // The timeline was read again, or another run opened: this page is for another timeline.
    if (disposed || generation !== timelineGeneration) return
    if (!result.ok) {
      patchTimeline({ more: 'idle', moreError: result.notice })
      return
    }
    const page = result.value
    const joined = [...oldestFirst(page), ...get().timeline.lines]
    const skipped = get().timeline.skipped + page.skipped
    if (joined.length >= TIMELINE_MAX) {
      // Past the most the timeline holds there is no `next`: the newest lines stay, and the oldest go.
      patchTimeline({ more: 'idle', lines: joined.slice(joined.length - TIMELINE_MAX), next: undefined, capped: page.next !== undefined || joined.length > TIMELINE_MAX, skipped })
    } else {
      patchTimeline({ more: 'idle', lines: joined, next: page.next, capped: false, skipped })
    }
  }

  const face: RunsActions = {
    // A store to read and subscribe to, not the one the controller writes.
    hooks: { page: { getSnapshot: store.getSnapshot, subscribe: store.subscribe } },
    open: refresh,
    refresh,
    select,
    back,
    loadOlder,
  }

  return {
    face,
    getState: get,
    dispose() {
      disposed = true
    },
  }
}
