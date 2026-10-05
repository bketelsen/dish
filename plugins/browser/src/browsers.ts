/**
 * The core: one Chromium, every session's browser, the limits, and the watchers.
 *
 * - **Chromium** starts on first need (an agent's first browser call, or the tab's address bar), with its own sandbox, or
 *   without it when it won't start for want of one. One launch at a time: callers share it. It closes 60 s after the last
 *   browser closes, and at `stop()`. When it goes away by itself, every browser goes with it, and the next need relaunches.
 * - **A session's browser** (`SessionBrowser`) is made on first use and closes for the reasons of `CloseReason`. At the
 *   cap (`maxBrowsers`), opening one closes the least recently used browser that no call is using; when every one is in a
 *   call, an agent's call waits up to 30 s for one to finish, honouring its signal.
 * - **Watchers** count the tab's interest: a frames-on watcher runs the screencast, keeps the browser from idling, and
 *   holds a disposed agent's browser open until the last one leaves.
 * - **The user's actions** from the tab (`user`) never wait in the agent's queue.
 *
 * The core keeps structured notes and notices (`types.ts`); `words.ts` words them, at the edge. A log line names a session
 * and a reason, never a URL.
 *
 * @module dish-browser/browsers
 */

import { maskSecrets } from 'dish-kit'
import type { Clock } from './clock.ts'
import { DriverClosed, DriverTimeout } from './driver.ts'
import type { Driver, DriverBrowser, DriverContext, DriverPage, RouteDecider, ScreencastFrame } from './driver.ts'
import type { Up, Viewport } from './protocol.ts'
import { BrowserError, SessionBrowser } from './session.ts'
import type { SessionHost } from './session.ts'
import { CAP_WAIT_MS, JPEG_QUALITY, LINGER_MS, LOAD_MS, NAV_MS, STOP_MS } from './types.ts'
import type { CloseReason, Frame, Limits, Note, OwnAddress, TabNotice, UrlPlaces, UrlRules } from './types.ts'

export { BrowserError } from './session.ts'

export interface BrowsersOptions {
  driver: Driver
  clock: Clock
  executablePath: string
  viewport: Viewport
  limits: Limits
  rules: UrlRules
  sharedTmp: boolean
  own(): OwnAddress
  /** Set when there's no Chromium: the executable path it looked for. */
  unavailable?: string
  /** Task 1's `replayAs`, given by `index.ts`. */
  keys: { replayAs(key: string): 'key' | 'text' | undefined }
  log: { info(message: string): void, warn(message: string): void }
}

export interface BrowserView {
  status: 'none' | 'open' | 'closed' | 'unavailable'
  /** Why it closed, for `closed`. */
  reason?: CloseReason
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  acting: boolean
  sandboxOff: boolean
}

export type CoreEvent =
  | { kind: 'changed', sessionId: string }
  | { kind: 'opened', sessionId: string }
  | { kind: 'closed', sessionId: string, reason: CloseReason }
  | { kind: 'frame', sessionId: string, frame: Frame }
  | { kind: 'notice', sessionId: string, notice: TabNotice }

export interface Watcher { setFrames(on: boolean): void, close(): void }

export type UserAction = Exclude<Up, { kind: 'frames' } | { kind: 'ack' }>

/** How often a call waiting at the cap looks again for room, besides at each call's end. */
const CAP_POLL_MS = 250
/** The closes remembered for the tab: the newest sessions'. */
const CLOSES_KEPT = 50
/** The sessions whose "this browser is new" note is kept for their next browser. */
const PENDING_KEPT = 200
/** The characters kept of Chromium's first line, in an error or a warning. */
const LINE_KEPT = 200
/** The closes whose next browser tells the agent its cookies are gone. */
const NOTED: ReadonlySet<CloseReason> = new Set<CloseReason>(['evicted', 'idle', 'tab', 'chromium'])
/** A signal that never aborts: the tab's openings. */
const NEVER = new AbortController().signal

interface Chromium { browser: DriverBrowser, closing: boolean }
interface CloseRecord { reason: CloseReason, at: number, frame: Frame | undefined }
interface Opening { sessionId: string, promise: Promise<SessionBrowser>, controller: AbortController, sharers: number }
interface Waiter { wake(): void, fail(error: unknown): void }

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The first line of `text`, trimmed, masked and cut. */
function firstLine(text: string): string {
  const line = (text.split('\n')[0] ?? '').trim()
  return maskSecrets(line).slice(0, LINE_KEPT)
}

/** A log line holds no address: Chromium's own messages can carry one. */
function forLog(text: string): string {
  return text.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S*/gi, '<address>')
}

export class Browsers {
  readonly unavailable: string | undefined
  private readonly options: BrowsersOptions
  private readonly open = new Map<string, SessionBrowser>()
  private readonly openings = new Map<string, Opening>()
  /** Browsers being opened: they count against the cap. */
  private reserved = 0
  private chromium: Chromium | undefined
  private launching: Promise<Chromium> | undefined
  private sandboxOff = false
  private sandboxWarned = false
  private readonly listeners = new Set<{ listener: (event: CoreEvent) => void }>()
  private readonly closes = new Map<string, CloseRecord>()
  private readonly pending = new Map<string, Note[]>()
  private readonly framesOn = new Map<string, number>()
  /** Disposed agents' browsers held open while a frames-on watcher watches them. */
  private readonly held = new Set<string>()
  private readonly latest = new Map<string, Frame>()
  private seq = 0
  private readonly waiters = new Set<Waiter>()
  private cancelPoll: (() => void) | undefined
  private cancelLinger: (() => void) | undefined
  private readonly timers = new Set<() => void>()
  private stopping = false
  private stopped: Promise<void> | undefined

  constructor(options: BrowsersOptions) {
    this.options = options
    this.unavailable = options.unavailable
  }

  // --- reading ----------------------------------------------------------------------------------------------------------

  subscribe(listener: (event: CoreEvent) => void): () => void {
    const entry = { listener }
    this.listeners.add(entry)
    return () => { this.listeners.delete(entry) }
  }

  view(sessionId: string): BrowserView {
    const browser = this.open.get(sessionId)
    if (browser !== undefined) {
      const page = browser.view
      return {
        status: 'open', url: page.url, title: page.title, loading: page.loading, canGoBack: page.canGoBack, canGoForward: page.canGoForward,
        acting: browser.acting, sandboxOff: this.sandboxOff,
      }
    }
    const blank = { url: '', title: '', loading: false, canGoBack: false, canGoForward: false, acting: false, sandboxOff: this.sandboxOff }
    const record = this.closes.get(sessionId)
    if (record !== undefined) return { status: 'closed', reason: record.reason, ...blank }
    return { status: this.unavailable !== undefined ? 'unavailable' : 'none', ...blank }
  }

  isOpen(sessionId: string): boolean {
    return this.open.has(sessionId)
  }

  /** The session's open browser, if it has one. */
  browserOf(sessionId: string): SessionBrowser | undefined {
    return this.open.get(sessionId)
  }

  // --- the agent's browser ----------------------------------------------------------------------------------------------

  /** The calling agent's browser, made on first use. @throws BrowserError */
  async forAgent(sessionId: string, workspace: string | undefined, signal: AbortSignal): Promise<SessionBrowser> {
    if (signal.aborted) throw signal.reason
    let browser = this.open.get(sessionId)
    browser ??= await this.openFor(sessionId, workspace, signal, { started: false, wait: true })
    if (workspace !== undefined) browser.workspace = workspace
    // A live agent owns it again: a watcher leaving no longer closes it.
    this.held.delete(sessionId)
    return browser
  }

  // --- watchers and frames ----------------------------------------------------------------------------------------------

  watch(sessionId: string): Watcher {
    let on = false
    let done = false
    return {
      setFrames: value => {
        if (done || value === on) return
        on = value
        if (value) this.framesUp(sessionId)
        else this.framesDown(sessionId)
      },
      close: () => {
        if (done) return
        done = true
        if (!on) return
        on = false
        this.framesDown(sessionId)
      },
    }
  }

  /** The newest frame of the session's browser, or of the browser that closed last. */
  latestFrame(sessionId: string): Frame | undefined {
    return this.open.has(sessionId) ? this.latest.get(sessionId) : this.closes.get(sessionId)?.frame
  }

  /** One frame of the page, now; `undefined` with no browser, or when it fails. */
  async capture(sessionId: string): Promise<Frame | undefined> {
    const browser = this.open.get(sessionId)
    if (browser === undefined) return undefined
    try {
      const shot = await browser.whileOpen(browser.page.capture(JPEG_QUALITY))
      if (this.open.get(sessionId) !== browser) return undefined
      const frame: Frame = { seq: ++this.seq, data: shot.data, width: shot.width, height: shot.height }
      this.latest.set(sessionId, frame)
      return frame
    } catch {
      return undefined
    }
  }

  private framesUp(sessionId: string): void {
    const count = (this.framesOn.get(sessionId) ?? 0) + 1
    this.framesOn.set(sessionId, count)
    if (count === 1) this.open.get(sessionId)?.setWatched(true)
  }

  private framesDown(sessionId: string): void {
    const count = (this.framesOn.get(sessionId) ?? 1) - 1
    if (count > 0) {
      this.framesOn.set(sessionId, count)
      return
    }
    this.framesOn.delete(sessionId)
    this.open.get(sessionId)?.setWatched(false)
    if (this.held.delete(sessionId)) void this.close(sessionId, 'agent')
  }

  private watched(sessionId: string): boolean {
    return (this.framesOn.get(sessionId) ?? 0) > 0
  }

  private frameOf(sessionId: string, shot: ScreencastFrame): void {
    const frame: Frame = { seq: ++this.seq, data: shot.data, width: shot.width, height: shot.height }
    this.latest.set(sessionId, frame)
    this.emit({ kind: 'frame', sessionId, frame })
  }

  // --- the tab's actions ------------------------------------------------------------------------------------------------

  /**
   * The tab's actions. `start` is given when the session's agent is live: a browser may be started for it. A navigation
   * resolves when the page has loaded (or failed); the user's input resolves at once, and replays on the session's input
   * chain, in order. Nothing here waits in the agent's queue.
   */
  async user(sessionId: string, action: UserAction, start: { workspace: string | undefined } | undefined): Promise<void> {
    try {
      switch (action.kind) {
        case 'navigate':
          await this.userNavigate(sessionId, action.url, start)
          return
        case 'back':
        case 'forward':
        case 'reload':
          await this.userHistory(sessionId, action.kind)
          return
        case 'close':
          await this.close(sessionId, 'tab')
          return
        default:
          this.open.get(sessionId)?.input(action)
      }
    } catch (error) {
      if (error instanceof BrowserError) this.notice(sessionId, { kind: 'error', code: error.code, detail: error.detail })
    }
  }

  private async userNavigate(sessionId: string, input: string, start: { workspace: string | undefined } | undefined): Promise<void> {
    const open = this.open.get(sessionId)
    const places: UrlPlaces = open?.places() ?? { workspace: start?.workspace, sharedTmp: this.options.sharedTmp, own: this.options.own() }
    const check = await this.options.rules.resolve(input, places)
    if (!check.ok) {
      this.notice(sessionId, { kind: 'refused', reason: check.reason })
      return
    }
    let browser = this.open.get(sessionId)
    if (browser === undefined) {
      if (start === undefined) {
        this.notice(sessionId, { kind: 'cannot-start' })
        return
      }
      browser = await this.openFor(sessionId, start.workspace, NEVER, { started: true, wait: false })
    }
    await this.go(browser, check.url, page => page.goto(check.url, { timeoutMs: NAV_MS, loadMs: LOAD_MS }))
  }

  private async userHistory(sessionId: string, kind: 'back' | 'forward' | 'reload'): Promise<void> {
    const browser = this.open.get(sessionId)
    if (browser === undefined) return
    await this.go(browser, undefined, page => {
      const options = { timeoutMs: NAV_MS }
      return kind === 'back' ? page.back(options) : kind === 'forward' ? page.forward(options) : page.reload(options)
    })
  }

  /** One of the tab's navigations: not queued, ended by a close; a failure is a notice; the activity gets where it landed. */
  private async go(browser: SessionBrowser, url: string | undefined, act: (page: DriverPage) => Promise<unknown>): Promise<void> {
    await browser.ready()
    const page = browser.page
    const from = page.url()
    try {
      await browser.whileOpen(act(page))
    } catch (error) {
      if (error instanceof BrowserError) throw error
      this.notice(browser.sessionId, { kind: 'failed', url: url ?? from, error: error instanceof DriverTimeout ? 'timeout' : messageOf(error) })
    }
    if (browser.closedReason === undefined) browser.recordNavigation(page.url())
  }

  // --- lifecycle --------------------------------------------------------------------------------------------------------

  /** The session's agent was created or disposed: its view (canStart) changed. A live agent owns its browser again. */
  touch(sessionId: string): void {
    this.held.delete(sessionId)
    this.emit({ kind: 'changed', sessionId })
  }

  /** With frames-on watchers, the browser is held until the last leaves; without, it closes now. */
  agentDisposed(sessionId: string): void {
    if (!this.open.has(sessionId)) {
      this.emit({ kind: 'changed', sessionId })
      return
    }
    if (this.watched(sessionId)) {
      this.held.add(sessionId)
      this.emit({ kind: 'changed', sessionId })
      return
    }
    void this.close(sessionId, 'agent')
  }

  async close(sessionId: string, reason: CloseReason): Promise<void> {
    const browser = this.open.get(sessionId)
    if (browser === undefined) return
    // Out of the map first, so that new calls make a new browser.
    this.open.delete(sessionId)
    this.held.delete(sessionId)
    this.closes.delete(sessionId)
    this.closes.set(sessionId, { reason, at: this.options.clock.now(), frame: this.latest.get(sessionId) })
    for (const old of this.closes.keys()) {
      if (this.closes.size <= CLOSES_KEPT) break
      this.closes.delete(old)
    }
    this.latest.delete(sessionId)
    if (NOTED.has(reason)) this.setPending(sessionId, { kind: 'reopened', reason })
    browser.markClosed(reason)
    this.emit({ kind: 'closed', sessionId, reason })
    this.emit({ kind: 'changed', sessionId })
    this.say('info', `closed the browser of ${sessionId} (${reason})`)
    this.wakeWaiters()
    this.checkLinger()
    // Chromium gone: its contexts went with it.
    if (reason === 'chromium') return
    try {
      await browser.context.close()
    } catch {
      // Already gone.
    }
  }

  async sweep(archived: ReadonlySet<string>): Promise<void> {
    if (this.stopping) return
    const now = this.options.clock.now()
    const idleMs = this.options.limits.idleMinutes * 60_000
    const closing: Array<Promise<void>> = []
    for (const [sessionId, browser] of [...this.open]) {
      if (archived.has(sessionId)) closing.push(this.close(sessionId, 'archived'))
      else if (!this.watched(sessionId) && !browser.inCall && now - browser.lastUsed >= idleMs) closing.push(this.close(sessionId, 'idle'))
    }
    await Promise.all(closing)
  }

  /** Close every browser (no notes) and Chromium, waiting at most `STOP_MS`; cancel every timer. Idempotent. */
  stop(): Promise<void> {
    this.stopped ??= this.stopNow()
    return this.stopped
  }

  private async stopNow(): Promise<void> {
    this.stopping = true
    for (const waiter of [...this.waiters]) waiter.fail(new BrowserError('closed', 'stopped'))
    const work: Array<Promise<unknown>> = [...this.open.keys()].map(sessionId => this.close(sessionId, 'stopped'))
    work.push(this.closeChromium())
    if (this.launching !== undefined) work.push(this.launching.catch(() => {}))
    let cancelTimeout: () => void = () => {}
    const timeout = new Promise<void>(resolve => { cancelTimeout = this.options.clock.after(STOP_MS, resolve) })
    try {
      await Promise.race([Promise.allSettled(work), timeout])
    } finally {
      cancelTimeout()
      for (const cancel of [...this.timers]) cancel()
      this.cancelPoll = undefined
      this.cancelLinger = undefined
    }
  }

  // --- opening ----------------------------------------------------------------------------------------------------------

  /** The session's browser being opened, shared by every caller; each caller's own signal ends its own wait. */
  private openFor(sessionId: string, workspace: string | undefined, signal: AbortSignal, how: { started: boolean, wait: boolean }): Promise<SessionBrowser> {
    let opening = this.openings.get(sessionId)
    if (opening === undefined) {
      const controller = new AbortController()
      const made: Opening = { sessionId, promise: Promise.resolve(undefined as unknown as SessionBrowser), controller, sharers: 0 }
      made.promise = this.openNew(sessionId, workspace, controller.signal, how)
      made.promise.then(() => { this.forget(made) }, () => { this.forget(made) })
      this.openings.set(sessionId, made)
      opening = made
    }
    return this.join(opening, signal)
  }

  private forget(opening: Opening): void {
    if (this.openings.get(opening.sessionId) === opening) this.openings.delete(opening.sessionId)
  }

  private join(opening: Opening, signal: AbortSignal): Promise<SessionBrowser> {
    if (signal.aborted) return Promise.reject(signal.reason)
    opening.sharers++
    return new Promise<SessionBrowser>((resolve, reject) => {
      let left = false
      const onAbort = (): void => {
        if (left) return
        left = true
        opening.sharers--
        if (opening.sharers === 0) {
          // Nobody wants it now: a new caller starts afresh, and a wait at the cap ends.
          this.forget(opening)
          opening.controller.abort(signal.reason)
        }
        reject(signal.reason)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      opening.promise.then(
        browser => {
          signal.removeEventListener('abort', onAbort)
          if (left) return
          left = true
          resolve(browser)
        },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort)
          if (left) return
          left = true
          reject(error)
        },
      )
    })
  }

  private async openNew(sessionId: string, workspace: string | undefined, signal: AbortSignal, how: { started: boolean, wait: boolean }): Promise<SessionBrowser> {
    if (this.stopping) throw new BrowserError('closed', 'stopped')
    if (this.unavailable !== undefined) throw new BrowserError('unavailable', this.options.executablePath)
    await this.reserve(signal, how.wait)
    let holding = true
    try {
      this.stopLinger()
      const chromium = await this.chromiumNow()
      this.throwIfGone(chromium, signal)
      let made: SessionBrowser | undefined
      const route: RouteDecider = async request => {
        if (made !== undefined) return made.route(request)
        // Before the page exists: the same rules, with the workspace given.
        try {
          const places: UrlPlaces = { workspace, sharedTmp: this.options.sharedTmp, own: this.options.own() }
          return (await this.options.rules.check(request.url, places, 'page')).ok ? 'continue' : 'abort'
        } catch {
          return 'abort'
        }
      }
      let context: DriverContext
      try {
        context = await chromium.browser.newContext({ viewport: this.options.viewport, route, refuseWebSocket: url => this.refusesWebSocket(url) })
      } catch (error) {
        throw this.openFailure(error, chromium)
      }
      let page: DriverPage
      try {
        page = await context.newPage()
        this.throwIfGone(chromium, signal)
      } catch (error) {
        void context.close().catch(() => {})
        throw this.openFailure(error, chromium)
      }
      const existing = this.open.get(sessionId)
      if (existing !== undefined) {
        // Another opening for this session (one whose callers all left) got there first.
        void context.close().catch(() => {})
        return existing
      }
      const notes = this.pending.get(sessionId) ?? []
      this.pending.delete(sessionId)
      made = new SessionBrowser({ sessionId, context, page, workspace, notes, started: how.started, host: this.hostFor(sessionId) })
      // The reservation becomes the open browser: the count against the cap stays, so no waiter is woken.
      holding = false
      this.reserved--
      this.open.set(sessionId, made)
      this.closes.delete(sessionId)
      this.emit({ kind: 'opened', sessionId })
      this.emit({ kind: 'changed', sessionId })
      this.say('info', `opened a browser for ${sessionId} (${this.open.size} open)`)
      if (this.watched(sessionId)) made.setWatched(true)
      return made
    } finally {
      if (holding) {
        this.reserved--
        this.wakeWaiters()
        this.checkLinger()
      }
    }
  }

  private throwIfGone(chromium: Chromium, signal: AbortSignal): void {
    if (this.stopping) throw new BrowserError('closed', 'stopped')
    if (this.chromium !== chromium) throw new BrowserError('closed', 'chromium')
    if (signal.aborted) throw signal.reason
  }

  private openFailure(error: unknown, chromium: Chromium): unknown {
    if (error instanceof BrowserError) return error
    if (this.stopping) return new BrowserError('closed', 'stopped')
    if (this.chromium !== chromium || error instanceof DriverClosed) return new BrowserError('closed', 'chromium')
    return new BrowserError('wont-start', firstLine(messageOf(error)))
  }

  private hostFor(sessionId: string): SessionHost {
    const options = this.options
    return {
      clock: options.clock,
      rules: options.rules,
      sharedTmp: options.sharedTmp,
      viewport: options.viewport,
      own: () => options.own(),
      replayAs: key => options.keys.replayAs(key),
      log: { info: message => { this.say('info', message) }, warn: message => { this.say('warn', message) } },
      changed: () => { this.emit({ kind: 'changed', sessionId }) },
      notice: notice => { this.notice(sessionId, notice) },
      frame: shot => { this.frameOf(sessionId, shot) },
      callEnded: () => { this.wakeWaiters() },
      broken: () => { void this.close(sessionId, 'chromium') },
    }
  }

  private refusesWebSocket(url: string): boolean {
    try {
      return this.options.rules.own(url, this.options.own())
    } catch {
      return true
    }
  }

  private setPending(sessionId: string, note: Note): void {
    this.pending.delete(sessionId)
    this.pending.set(sessionId, [note])
    for (const old of this.pending.keys()) {
      if (this.pending.size <= PENDING_KEPT) break
      this.pending.delete(old)
    }
  }

  // --- the cap ----------------------------------------------------------------------------------------------------------

  /** A place under the cap: free, or made by evicting; else (an agent's call) a wait for one, up to `CAP_WAIT_MS`. */
  private async reserve(signal: AbortSignal, wait: boolean): Promise<void> {
    const deadline = this.options.clock.now() + CAP_WAIT_MS
    for (;;) {
      if (this.stopping) throw new BrowserError('closed', 'stopped')
      if (signal.aborted) throw signal.reason
      if (this.open.size + this.reserved < this.options.limits.maxBrowsers) {
        this.reserved++
        return
      }
      const victim = this.evictable()
      if (victim !== undefined) {
        void this.close(victim, 'evicted')
        continue
      }
      if (!wait) throw new BrowserError('busy')
      await this.waitForRoom(signal, deadline)
    }
  }

  /** The least recently used open browser with no call running or queued, watched or not. */
  private evictable(): string | undefined {
    let best: { sessionId: string, used: number } | undefined
    for (const [sessionId, browser] of this.open) {
      if (browser.inCall) continue
      const used = browser.lastUsed
      if (best === undefined || used < best.used) best = { sessionId, used }
    }
    return best?.sessionId
  }

  private hasRoom(): boolean {
    return this.open.size + this.reserved < this.options.limits.maxBrowsers || this.evictable() !== undefined
  }

  private waitForRoom(signal: AbortSignal, deadline: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let cancelDeadline: () => void = () => {}
      const done = (): void => {
        this.waiters.delete(waiter)
        cancelDeadline()
        signal.removeEventListener('abort', onAbort)
        this.pollWhileWaiting()
      }
      const waiter: Waiter = {
        wake: () => {
          if (!this.hasRoom() && !this.stopping) return
          done()
          resolve()
        },
        fail: error => {
          done()
          reject(error)
        },
      }
      const onAbort = (): void => { waiter.fail(signal.reason) }
      this.waiters.add(waiter)
      cancelDeadline = this.after(Math.max(0, deadline - this.options.clock.now()), () => { waiter.fail(new BrowserError('busy')) })
      signal.addEventListener('abort', onAbort, { once: true })
      this.pollWhileWaiting()
    })
  }

  private wakeWaiters(): void {
    for (const waiter of [...this.waiters]) waiter.wake()
  }

  private pollWhileWaiting(): void {
    if (this.waiters.size === 0) {
      this.cancelPoll?.()
      this.cancelPoll = undefined
      return
    }
    if (this.cancelPoll !== undefined) return
    this.cancelPoll = this.after(CAP_POLL_MS, () => {
      this.cancelPoll = undefined
      this.wakeWaiters()
      this.pollWhileWaiting()
    })
  }

  // --- Chromium ---------------------------------------------------------------------------------------------------------

  private chromiumNow(): Promise<Chromium> {
    if (this.chromium !== undefined) return Promise.resolve(this.chromium)
    if (this.launching === undefined) {
      const launching: Promise<Chromium> = this.launch().finally(() => {
        if (this.launching === launching) this.launching = undefined
      })
      this.launching = launching
    }
    return this.launching
  }

  private async launch(): Promise<Chromium> {
    const { driver, executablePath } = this.options
    let browser: DriverBrowser
    let sandboxOff = false
    try {
      browser = await driver.launch({ executablePath, sandbox: true })
    } catch (first) {
      const text = messageOf(first)
      if (!/sandbox|namespace/i.test(text)) throw new BrowserError('wont-start', firstLine(text))
      try {
        browser = await driver.launch({ executablePath, sandbox: false })
      } catch (second) {
        throw new BrowserError('wont-start', firstLine(messageOf(second)))
      }
      sandboxOff = true
      if (!this.sandboxWarned) {
        this.sandboxWarned = true
        this.say('warn', `Chromium started without its own sandbox: ${forLog(firstLine(text))}`)
      }
    }
    const chromium: Chromium = { browser, closing: false }
    if (this.stopping) {
      chromium.closing = true
      await browser.close().catch(() => {})
      throw new BrowserError('closed', 'stopped')
    }
    this.chromium = chromium
    this.sandboxOff = sandboxOff
    browser.onDisconnected(() => { this.disconnected(chromium) })
    this.say('info', `launched Chromium (sandbox ${sandboxOff ? 'off' : 'on'})`)
    return chromium
  }

  /** Chromium exited or the connection dropped: when the core didn't close it, every browser is gone. No driver call. */
  private disconnected(chromium: Chromium): void {
    if (chromium.closing || this.chromium !== chromium) return
    this.chromium = undefined
    this.stopLinger()
    this.say('warn', 'Chromium stopped unexpectedly')
    for (const sessionId of [...this.open.keys()]) void this.close(sessionId, 'chromium')
  }

  private checkLinger(): void {
    if (this.stopping || this.chromium === undefined || this.open.size > 0 || this.reserved > 0 || this.cancelLinger !== undefined) return
    this.cancelLinger = this.after(LINGER_MS, () => {
      this.cancelLinger = undefined
      if (this.open.size === 0 && this.reserved === 0 && !this.stopping) void this.closeChromium()
    })
  }

  private stopLinger(): void {
    this.cancelLinger?.()
    this.cancelLinger = undefined
  }

  private async closeChromium(): Promise<void> {
    const chromium = this.chromium
    if (chromium === undefined) return
    this.chromium = undefined
    chromium.closing = true
    this.say('info', 'closed Chromium')
    try {
      await chromium.browser.close()
    } catch {
      // Already gone.
    }
  }

  // --- inside -----------------------------------------------------------------------------------------------------------

  private notice(sessionId: string, notice: TabNotice): void {
    this.emit({ kind: 'notice', sessionId, notice })
  }

  private emit(event: CoreEvent): void {
    for (const { listener } of [...this.listeners]) {
      try {
        listener(event)
      } catch {
        // One listener's failure is its own.
      }
    }
  }

  private say(level: 'info' | 'warn', message: string): void {
    try {
      this.options.log[level](message)
    } catch {
      // A logger that throws is ignored.
    }
  }

  /** A timer of the core's: cancelled at `stop()`. */
  private after(ms: number, run: () => void): () => void {
    let cancel: () => void = () => {}
    const stop = this.options.clock.after(ms, () => {
      this.timers.delete(cancel)
      run()
    })
    cancel = () => {
      stop()
      this.timers.delete(cancel)
    }
    this.timers.add(cancel)
    return cancel
  }
}
