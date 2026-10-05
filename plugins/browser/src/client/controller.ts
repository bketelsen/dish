/**
 * The Browser tab's state and what it does, and the header button's presence. No React here, and nothing that only a browser
 * or only dsh can load, so `node --test` runs it against a fake remote and a fake `$stream` (`test/client-controller.test.ts`).
 * The components read the stores through the `use…` hooks the slots make of `hooks`, and act through the faces.
 *
 * **One controller per chat** (the slot's session), as dsh's own Browser body keeps one per session. The tab's body attaches
 * it to the session it shows: its own, or the one the tab was opened for (`sessionId` in the tab's parameters, from the
 * switcher or a screenshot). Two bodies on one target share one stream; the last one to go stops it. What was shown stays
 * when the body goes (the chip keeps its title), and a body that comes back to the same target resumes from it.
 *
 * **What goes up.** Every new generation is told whether the tab wants frames (it does while it is visible), and told again
 * when that changes. The address bar's `navigate` goes up when `addressInput` takes it; the picture's input and acks go as
 * they are. A frame the picture won't draw (the source it already shows, or one the model refuses) is acked here, at once.
 * Nothing up waits for anything: an item for a generation that has ended is dropped.
 *
 * A body detaches the target it attached: when two bodies show two targets (two panes), the later attach takes the one
 * stream over, and the earlier body's detach, for a target no longer followed, changes nothing.
 *
 * **The presence** is the header button's: it watches the chat with frames off, so a chat left open keeps nothing alive,
 * and shows the button while the chat has an open browser or one of its crew children does.
 */

import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { Down, Up } from '../protocol.ts'
import { addressInput } from './address.ts'
import { follow } from './follow.ts'
import type { Follower, Stream, StreamOptions } from './follow.ts'
import { INITIAL, reduce } from './model.ts'
import type { TabState } from './model.ts'
import type { BrowserApi } from './remote.ts'

/** The most child labels the tab remembers for its switcher. */
const LABELS_MAX = 100

/** What the tab's components can ask, beside the `useTab` hook the `hooks` entry becomes. */
export interface TabActions {
  hooks: { tab: ObservableSnapshot<TabState> }
  /** The body mounted, showing session `target`. */
  attach(target: string): void
  /** The body showing session `target` unmounted, or moved to another target. */
  detach(target: string): void
  /** Whether the tab can be seen: frames are wanted only then. */
  setVisible(visible: boolean): void
  /** The address bar's Enter. */
  navigate(text: string): void
  back(): void
  forward(): void
  reload(): void
  close(): void
  /** The picture's input. */
  send(up: Up): void
  /** The picture drew frame `seq`. */
  ack(seq: number): void
  dismissNotice(): void
  /** A crew child's label, as the last children list that held it said; for the switcher while the tab shows that child. */
  labelOf(sessionId: string): string | undefined
}

export interface TabController {
  face: TabActions
  /** The scope that made it is ending: stop the stream, and start nothing after. */
  dispose(): void
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
      if (Object.is(next, current)) return
      current = next
      for (const listener of [...listeners]) listener()
    },
  }
}

/** One follower of one target, counted by the bodies attached to it. */
interface Following {
  target: string
  follower: Follower
  attached: number
}

/**
 * @param api - the `dishBrowser` remote, while it is there.
 * @param stream - `ctx.remote.$stream`.
 */
export function createTabController(api: () => BrowserApi | undefined, stream: (options: StreamOptions<Down>) => Stream<Down>): TabController {
  const store = createStore<TabState>(INITIAL)
  const patch = (next: Partial<TabState>): void => { store.set({ ...store.getSnapshot(), ...next }) }
  const labels = new Map<string, string>()
  let following: Following | undefined
  /** The target the state is of, kept when the last body goes. */
  let shown: string | undefined
  let visible = false
  let disposed = false

  const remember = (down: Down): void => {
    if (down.kind !== 'children') return
    for (const child of down.children) {
      labels.delete(child.sessionId)
      labels.set(child.sessionId, child.label)
    }
    while (labels.size > LABELS_MAX) labels.delete(labels.keys().next().value!)
  }

  const start = (target: string): Following => {
    // Another target starts from nothing; the same one again resumes from what was shown.
    store.set(target === shown ? { ...store.getSnapshot(), connection: 'connecting' } : INITIAL)
    shown = target
    const mine: Following = { target, attached: 1, follower: undefined as unknown as Follower }
    const live = (): boolean => following === mine && !disposed
    mine.follower = follow({
      open: (signal) => {
        const remote = api()
        if (remote === undefined) throw new Error('dish-browser: the remote is not mounted')
        return remote.watch(target, signal)
      },
      stream,
      opened: (send) => { send({ kind: 'frames', on: visible }) },
      receive: (down) => {
        if (!live()) return
        remember(down)
        const before = store.getSnapshot()
        const after = reduce(before, down)
        store.set(after)
        // The picture acks a frame when its image has loaded. A frame whose source is the one already shown loads nothing
        // (the host hands a watcher that turns frames on its latest frame again, number and all), and a frame the model
        // won't keep is never drawn: ack those here, or the host would hold its next frame back for good.
        if (down.kind === 'frame' && (after === before || after.frame?.src === before.frame?.src)) {
          mine.follower.send({ kind: 'ack', seq: down.seq })
        }
      },
      down: () => {
        if (live()) patch({ connection: 'down' })
      },
    })
    return mine
  }

  const stop = (): void => {
    const ending = following
    following = undefined
    if (ending !== undefined) void ending.follower.dispose()
  }

  const send = (up: Up): void => { following?.follower.send(up) }

  const face: TabActions = {
    // A store to read and subscribe to, not the one the controller writes.
    hooks: { tab: { getSnapshot: store.getSnapshot, subscribe: store.subscribe } },
    attach(target) {
      if (disposed) return
      if (following !== undefined && following.target === target) {
        following.attached++
        return
      }
      stop()
      following = start(target)
    },
    detach(target) {
      // A body whose target is no longer followed (another body's attach took the stream over) has nothing to let go of.
      if (following === undefined || following.target !== target) return
      following.attached--
      if (following.attached <= 0) stop()
    },
    setVisible(next) {
      if (next === visible) return
      visible = next
      send({ kind: 'frames', on: next })
    },
    navigate(text) {
      const url = addressInput(text)
      if (url !== undefined) send({ kind: 'navigate', url })
    },
    back: () => { send({ kind: 'back' }) },
    forward: () => { send({ kind: 'forward' }) },
    reload: () => { send({ kind: 'reload' }) },
    close: () => { send({ kind: 'close' }) },
    send,
    ack: (seq) => { send({ kind: 'ack', seq }) },
    dismissNotice: () => { patch({ notice: undefined }) },
    labelOf: sessionId => labels.get(sessionId),
  }

  return {
    face,
    dispose() {
      disposed = true
      stop()
    },
  }
}

/** What the header button can ask, beside the `useShown` hook. */
export interface PresenceActions {
  hooks: { shown: ObservableSnapshot<boolean> }
  /** The button mounted in chat `sessionId`'s header. */
  attach(sessionId: string): void
  detach(): void
  /** Open the Browser tab. */
  open(): void
}

/**
 * @param api - the `dishBrowser` remote, while it is there.
 * @param stream - `ctx.remote.$stream`.
 * @param open - open the Browser tab.
 */
export function createPresence(
  api: () => BrowserApi | undefined,
  stream: (options: StreamOptions<Down>) => Stream<Down>,
  open: () => void,
): { face: PresenceActions, dispose(): void } {
  const shown = createStore(false)
  let state: TabState = INITIAL
  let following: Following | undefined
  let disposed = false

  const stop = (): void => {
    const ending = following
    following = undefined
    if (ending !== undefined) void ending.follower.dispose()
  }

  const face: PresenceActions = {
    hooks: { shown: { getSnapshot: shown.getSnapshot, subscribe: shown.subscribe } },
    attach(sessionId) {
      if (disposed) return
      if (following !== undefined && following.target === sessionId) {
        following.attached++
        return
      }
      stop()
      state = INITIAL
      shown.set(false)
      const mine: Following = { target: sessionId, attached: 1, follower: undefined as unknown as Follower }
      // Frames stay off, as the host starts a watch: nothing is sent up.
      mine.follower = follow({
        open: (signal) => {
          const remote = api()
          if (remote === undefined) throw new Error('dish-browser: the remote is not mounted')
          return remote.watch(sessionId, signal)
        },
        stream,
        opened: () => {},
        receive: (down) => {
          if (following !== mine || disposed) return
          state = reduce(state, down)
          shown.set(state.status === 'open' || state.children.length > 0)
        },
        down: () => {},
      })
      following = mine
    },
    detach() {
      if (following === undefined) return
      following.attached--
      if (following.attached <= 0) stop()
    },
    open: () => { open() },
  }

  return {
    face,
    dispose() {
      disposed = true
      stop()
    },
  }
}
