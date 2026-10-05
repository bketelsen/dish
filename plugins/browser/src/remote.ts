/**
 * The Browser tab's stream: one Typert remote method, `watch(sessionId, signal)`, that the tab (and the header button)
 * follows with `ctx.remote.$stream`.
 *
 * - **Down:** `hello` first, then the session's browser's `state`, then the crew children's browsers (`children`); after
 *   that a new `state` when the browser changes (at most one per 100 ms, the newest), the `children` again when any
 *   browser opens or closes (200 ms after), the tab's `notice`s, and `frame`s while the tab has frames on.
 * - **Up**, on the same stream's uplink: whether the tab wants frames, acks, and the user's navigation and input. The uplink
 *   is read as it arrives, by a task of its own that never waits for what an item does (a navigation takes up to ~33 s),
 *   so dsh's uplink buffer (256 KiB a stream) never fills. Each item is checked (`uplink.ts`); a bad one is dropped.
 * - **Frames** are paced per watcher (`screencast.ts`): one in flight until its ack, the newest kept, at most 15 a second.
 *   Several watchers share the core's one screencast. Only a frames-on watcher counts as watching (the core's `watch`).
 * - **A refusal** (an archived chat, an id that isn't one) is a `state` of `refused`, and the stream stays open and idle
 *   until its signal: a thrown refusal would end it, and `$stream` would reopen it at once, in a loop.
 * - **The end** is the signal's (the tab went, the carrier dropped) or the service's scope going: the stream lets go of the
 *   watcher, the pacer, its timers, the core's events and the uplink. It never ends by itself, since `$stream` reopens a
 *   generation that ends.
 *
 * Page text in the state (the URL, the title), a notice and a child's label is masked and cut; the tab renders it as text.
 *
 * @module dish-browser/remote
 */

import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { markRemote, maskSecrets } from 'dish-kit'
import type { Browsers, CoreEvent, UserAction, Watcher } from './browsers.ts'
import type { Clock } from './clock.ts'
import { NAMESPACE, URL_MAX } from './protocol.ts'
import type { ChildBrowser, Down, FrameDown, StateDown, Viewport } from './protocol.ts'
import { FramePacer } from './screencast.ts'
import { isLive, workspaceOf } from './services.ts'
import type { Services } from './services.ts'
import type { Limits } from './types.ts'
import { parseUp } from './uplink.ts'
import { closedText, errorText, quoted, tabNoticeText } from './words.ts'

/** The Cordis service key. (The wire namespace is `NAMESPACE`.) */
export const SERVICE = 'dishBrowserRemote'

declare module '@deepseek-ai/cordis' {
  interface Context {
    dishBrowserRemote: BrowserRemote
  }
}

/** The refusal of an id that isn't a chat's. */
export const NOT_A_CHAT = 'That isn\'t a chat.'
/** The refusal of an archived chat. */
export const ARCHIVED = 'This chat is archived.'

/** The least time between two `state` items. */
const STATE_MS = 100
/** The wait after a browser opens or closes before the children are read again. */
const CHILDREN_MS = 200
/** The notices kept for a reader that is behind: the newest. */
const NOTICES_KEPT = 20
/** The most characters of a child's label. */
const LABEL_MAX = 80
/** The most characters of the page's title in a state. */
const TITLE_MAX = 200
/** The longest session id a watch takes. */
const SESSION_ID_MAX = 256

export interface RemoteOptions {
  core: Browsers
  services: Services
  clock: Clock
  limits: Limits
  viewport: Viewport
  log: { warn(message: string): void }
}

/** The uplink of a call that has none (`watch` called in process, not through the gateway): it ends at once. */
const EMPTY: AsyncIterable<unknown> = {
  [Symbol.asyncIterator]: () => ({ next: async () => ({ value: undefined, done: true }) }),
}

/** The watches opened in this process: each one's `hello` carries its number. */
let watches = 0

export class BrowserRemote extends TypertRemoteService {
  private readonly options: RemoteOptions
  /** Aborted when the service's scope goes, which ends the streams still open. */
  private readonly closing = new AbortController()

  constructor(ctx: Context, options: RemoteOptions) {
    super(ctx, SERVICE, { namespace: NAMESPACE })
    this.options = options
    ctx.effect(() => () => { this.closing.abort() })
  }

  /**
   * Watch session `sessionId`'s browser, and take the tab's input from the uplink. Ends only when `signal` aborts, or when
   * the service goes.
   * @param sessionId - the chat's session id. Named so the gateway reads it as plain JSON: dsh resolves a parameter named
   *   `session` to an object.
   * @param signal - the call's cancellation; with an uplink, the gateway joins it with the uplink's own failure.
   */
  async *watch(sessionId: string, signal: AbortSignal): AsyncIterable<Down> {
    // Taken once, first: the gateway gives each call's uplink once.
    let uplink: AsyncIterable<unknown> = EMPTY
    try {
      uplink = this.ctx.invocation?.uplink() ?? EMPTY
    } catch {
      uplink = EMPTY
    }
    const signals = signal instanceof AbortSignal ? [signal, this.closing.signal] : [this.closing.signal]
    yield* watchStream(this.options, sessionId, uplink, AbortSignal.any(signals))
  }
}

markRemote(BrowserRemote, 'watch', { mode: 'stream' })

/** Mount the remote on `ctx`. It goes when `ctx` does, and its open streams end with it. */
export function browserRemote(ctx: Context, options: RemoteOptions): void {
  ctx.plugin(BrowserRemote, options)
}

/**
 * `watch`'s body, for tests: the uplink as given.
 * @param sessionId - unchecked, as it came off the wire.
 * @param uplink - the tab's items, unchecked.
 * @param signal - the end of the stream.
 */
export async function* watchStream(options: RemoteOptions, sessionId: unknown, uplink: AsyncIterable<unknown>, signal: AbortSignal): AsyncGenerator<Down> {
  if (signal.aborted) return
  yield { kind: 'hello', watchId: String(++watches) }
  const refusal = refusalOf(options.services, sessionId)
  if (refusal !== undefined) {
    // The tab's items mean nothing here, but they are read, so the uplink never fills.
    const reader = new UplinkReader(uplink, () => {}, () => {})
    try {
      yield refusedState(refusal, options.viewport)
      await untilAborted(signal)
    } finally {
      reader.stop()
    }
    return
  }
  const watch = new Watch(options, sessionId as string, uplink, signal)
  try {
    yield watch.openingState()
    const children = await watch.openingChildren()
    if (signal.aborted) return
    yield { kind: 'children', children }
    for (;;) {
      const item = await watch.next()
      if (item === undefined) return
      yield item
    }
  } finally {
    watch.end()
  }
}

// --- one watch ------------------------------------------------------------------------------------------------------------

/**
 * One stream's watch of one session: the core's watcher, the pacer, the core's events, the uplink's reader, and what waits
 * for the generator. Of `state` and `children` only the newest waits; of notices the newest 20; a frame comes only through
 * the pacer, so at most one waits.
 */
class Watch {
  private readonly options: RemoteOptions
  private readonly sessionId: string
  private readonly signal: AbortSignal
  private readonly watcher: Watcher
  private readonly pacer: FramePacer
  private readonly unsubscribe: () => void
  private readonly reader: UplinkReader
  private ended = false
  // What waits for the generator.
  private state: StateDown | undefined
  private children: ChildBrowser[] | undefined
  private readonly notices: string[] = []
  private frame: FrameDown | undefined
  private wake: (() => void) | undefined
  // The state's pace.
  private stateAt = Number.NEGATIVE_INFINITY
  private cancelState: (() => void) | undefined
  // The children's.
  private cancelChildren: (() => void) | undefined
  private childrenRound = 0
  // The tab's actions, dispatched to the core in order; nothing here waits for what they do.
  private acting: Promise<void> = Promise.resolve()
  private dropped = 0

  constructor(options: RemoteOptions, sessionId: string, uplink: AsyncIterable<unknown>, signal: AbortSignal) {
    this.options = options
    this.sessionId = sessionId
    this.signal = signal
    // A watch starts with frames off: only the tab's `frames` turns them on.
    this.watcher = options.core.watch(sessionId)
    this.pacer = new FramePacer(options.clock, frame => {
      this.frame = frame
      this.poke()
    })
    this.unsubscribe = options.core.subscribe(event => { this.onEvent(event) })
    signal.addEventListener('abort', this.poke)
    this.reader = new UplinkReader(uplink, item => { this.take(item) }, () => {
      // On the stream's abort the gateway fails a pending read (`gateway/cancelled`) before the stream ends: that is no fault.
      if (this.signal.aborted || this.ended) return
      this.say(`stopped reading the Browser tab's input for ${this.sessionId}: its uplink failed`)
    })
  }

  /** The first state, now; anything waiting is older. */
  openingState(): StateDown {
    this.cancelState?.()
    this.cancelState = undefined
    this.state = undefined
    this.stateAt = this.options.clock.now()
    return stateOf(this.options, this.sessionId)
  }

  /** The first children, or none when the signal comes first. A list read again meanwhile is newer, and follows. */
  async openingChildren(): Promise<ChildBrowser[]> {
    return Promise.race([childrenOf(this.options, this.sessionId), untilAborted(this.signal).then(() => [])])
  }

  /** The next item for the generator: waits for one, or for the signal (then `undefined`). */
  async next(): Promise<Down | undefined> {
    for (;;) {
      if (this.signal.aborted || this.ended) return undefined
      const item = this.shift()
      if (item !== undefined) return item
      await new Promise<void>(resolve => { this.wake = resolve })
    }
  }

  end(): void {
    if (this.ended) return
    this.ended = true
    this.signal.removeEventListener('abort', this.poke)
    this.unsubscribe()
    this.watcher.close()
    this.pacer.dispose()
    this.cancelState?.()
    this.cancelChildren?.()
    this.cancelState = undefined
    this.cancelChildren = undefined
    this.reader.stop()
    this.poke()
    if (this.dropped > 1) {
      const more = this.dropped - 1
      this.say(`dropped ${more} more item${more === 1 ? '' : 's'} from the Browser tab`)
    }
  }

  private readonly poke = (): void => {
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }

  private shift(): Down | undefined {
    if (this.state !== undefined) {
      const state = this.state
      this.state = undefined
      return state
    }
    if (this.children !== undefined) {
      const children = this.children
      this.children = undefined
      return { kind: 'children', children }
    }
    const notice = this.notices.shift()
    if (notice !== undefined) return { kind: 'notice', text: notice }
    if (this.frame !== undefined) {
      const frame = this.frame
      this.frame = undefined
      return frame
    }
    return undefined
  }

  // --- the core's events ------------------------------------------------------------------------------------------------

  private onEvent(event: CoreEvent): void {
    if (this.ended) return
    if (event.kind === 'opened' || event.kind === 'closed') this.childrenSoon()
    if (event.sessionId !== this.sessionId) return
    switch (event.kind) {
      case 'changed':
        this.stateSoon()
        return
      case 'frame':
        this.pacer.offer(event.frame)
        return
      case 'notice':
        this.notice(maskSecrets(tabNoticeText(event.notice, this.options.limits)))
        return
    }
  }

  /** A new state now, or when 100 ms have passed since the last; built then, so the newest wins. */
  private stateSoon(): void {
    if (this.cancelState !== undefined) return
    const wait = this.stateAt + STATE_MS - this.options.clock.now()
    if (wait <= 0) {
      this.queueState()
      return
    }
    this.cancelState = this.options.clock.after(wait, () => {
      this.cancelState = undefined
      this.queueState()
    })
  }

  private queueState(): void {
    if (this.ended) return
    this.stateAt = this.options.clock.now()
    this.state = stateOf(this.options, this.sessionId)
    this.poke()
  }

  /** The children again, 200 ms after the first open or close of a burst; read then, so the newest wins. */
  private childrenSoon(): void {
    if (this.cancelChildren !== undefined) return
    this.cancelChildren = this.options.clock.after(CHILDREN_MS, () => {
      this.cancelChildren = undefined
      void this.refreshChildren()
    })
  }

  private async refreshChildren(): Promise<void> {
    const round = ++this.childrenRound
    const children = await childrenOf(this.options, this.sessionId)
    // A later read started meanwhile: its list is the newer.
    if (this.ended || round !== this.childrenRound) return
    this.children = children
    this.poke()
  }

  private notice(text: string): void {
    this.notices.push(text)
    while (this.notices.length > NOTICES_KEPT) this.notices.shift()
    this.poke()
  }

  // --- the tab's items --------------------------------------------------------------------------------------------------

  private take(item: unknown): void {
    if (this.ended) return
    const parsed = parseUp(item, this.options.viewport)
    if (!parsed.ok) {
      this.dropped++
      if (this.dropped === 1) this.say(`dropped an item from the Browser tab (${parsed.why})`)
      return
    }
    const up = parsed.up
    switch (up.kind) {
      case 'frames':
        this.setFrames(up.on)
        return
      case 'ack':
        this.pacer.ack(up.seq)
        return
      default:
        this.act(up)
    }
  }

  /** Frames on: the newest frame at once (an open browser's, or a closed one's last), else a fresh capture. */
  private setFrames(on: boolean): void {
    const { core } = this.options
    if (!on) {
      this.watcher.setFrames(false)
      this.pacer.setOn(false)
      this.frame = undefined
      return
    }
    this.pacer.setOn(true)
    this.watcher.setFrames(true)
    const latest = core.latestFrame(this.sessionId)
    if (latest !== undefined) {
      this.pacer.offer(latest)
      return
    }
    // Not awaited: the uplink is read on meanwhile. A capture that comes after a newer frame is dropped by the pacer.
    core.capture(this.sessionId).then(frame => {
      if (frame !== undefined && !this.ended) this.pacer.offer(frame)
    }, () => {})
  }

  /**
   * One of the tab's actions, to the core, after the ones before it. A navigation's `start` (whether a browser may be
   * started, and in which workspace) is worked out first; what the core then does is never waited for.
   */
  private act(action: UserAction): void {
    this.acting = this.acting.then(async () => {
      if (this.ended) return
      const start = action.kind === 'navigate' ? await this.startFor() : undefined
      if (this.ended) return
      this.options.core.user(this.sessionId, action, start).catch(() => {})
    }).catch(() => {})
  }

  /** `{ workspace }` when the session's agent is live, so the address bar may start its browser; else `undefined`. */
  private async startFor(): Promise<{ workspace: string | undefined } | undefined> {
    const { services } = this.options
    let session: unknown
    try {
      const agent = services.agents()?.get(this.sessionId)
      if (agent === undefined) return undefined
      session = agent.session
    } catch {
      return undefined
    }
    return { workspace: await workspaceOf(services, session) }
  }

  private say(message: string): void {
    try {
      this.options.log.warn(message)
    } catch {
      // A logger that throws is ignored.
    }
  }
}

// --- the uplink's reader ----------------------------------------------------------------------------------------------------

/**
 * Reads the uplink as items arrive, handing each to `take` at once. It ends when the uplink ends, fails or is let go of
 * (`stop`). On the stream's abort a read the gateway has pending rejects (`gateway/cancelled`): that is the end, caught here,
 * never an unhandled rejection.
 */
class UplinkReader {
  private stopped = false
  private readonly iterator: AsyncIterator<unknown> | undefined

  constructor(uplink: AsyncIterable<unknown>, take: (item: unknown) => void, failed: () => void) {
    try {
      this.iterator = uplink[Symbol.asyncIterator]()
    } catch {
      this.iterator = undefined
      return
    }
    void this.run(this.iterator, take, failed)
  }

  /** Let go of the uplink: unread items are dropped, and a read pending in the gateway's uplink ends. */
  stop(): void {
    if (this.stopped) return
    this.stopped = true
    try {
      Promise.resolve(this.iterator?.return?.()).catch(() => {})
    } catch {
      // Already gone.
    }
  }

  private async run(iterator: AsyncIterator<unknown>, take: (item: unknown) => void, failed: () => void): Promise<void> {
    try {
      for (;;) {
        const next = await iterator.next()
        if (next.done === true || this.stopped) return
        take(next.value)
      }
    } catch {
      if (!this.stopped) failed()
    }
  }
}

// --- the words of the state and the children ------------------------------------------------------------------------------

function refusalOf(services: Services, sessionId: unknown): string | undefined {
  if (typeof sessionId !== 'string' || sessionId.length < 1 || sessionId.length > SESSION_ID_MAX) return NOT_A_CHAT
  try {
    if (services.workspaceRegistry()?.archivedSessionIds.includes(sessionId) === true) return ARCHIVED
  } catch {
    // A registry that can't be read refuses nothing.
  }
  return undefined
}

function refusedState(reason: string, viewport: Viewport): StateDown {
  return {
    kind: 'state', status: 'refused', reason, url: '', title: '', loading: false, canGoBack: false, canGoForward: false, acting: false,
    canStart: false, sandboxOff: false, viewport: { width: viewport.width, height: viewport.height },
  }
}

/** The session's browser as the tab shows it, from the core's view: the reason in dish's words, the URL and title masked. */
function stateOf(options: RemoteOptions, sessionId: string): StateDown {
  const { core, limits, viewport } = options
  const view = core.view(sessionId)
  const reason = view.status === 'closed' ? (view.reason === undefined ? '' : closedText(view.reason, limits))
    : view.status === 'unavailable' ? errorText('unavailable', core.unavailable ?? '', limits)
    : ''
  return {
    kind: 'state',
    status: view.status,
    reason,
    url: quoted(view.url, URL_MAX),
    title: quoted(view.title, TITLE_MAX),
    loading: view.loading,
    canGoBack: view.canGoBack,
    canGoForward: view.canGoForward,
    acting: view.acting,
    canStart: view.status !== 'open' && view.status !== 'unavailable' && isLive(options.services, sessionId),
    sandboxOff: view.sandboxOff,
    viewport: { width: viewport.width, height: viewport.height },
  }
}

/** The session's crew children with an open browser, from crew's record; none when crew isn't running or can't say. */
async function childrenOf(options: RemoteOptions, sessionId: string): Promise<ChildBrowser[]> {
  try {
    const records = await options.services.crew()?.records.children(sessionId) ?? []
    const children: ChildBrowser[] = []
    for (const child of records) {
      if (typeof child.id !== 'string' || !options.core.isOpen(child.id)) continue
      const role = String(child.role)
      const title = typeof child.title === 'string' ? child.title.trim() : ''
      children.push({ sessionId: child.id, label: quoted(title === '' ? role : `${role}: ${title}`, LABEL_MAX) })
    }
    return children
  } catch {
    return []
  }
}

/** Resolves when `signal` aborts (at once when it has). */
function untilAborted(signal: AbortSignal): Promise<void> {
  return new Promise<void>(resolve => {
    if (signal.aborted) {
      resolve()
      return
    }
    signal.addEventListener('abort', () => { resolve() }, { once: true })
  })
}
