/**
 * A fake browser engine for every test but the two real-Chromium files (Tasks 3–6), and a manual clock.
 *
 * - `FakeDriver` launches `FakeBrowser`s, or fails as `failLaunches` says; `holdLaunch` keeps a launch in flight.
 * - A `FakeBrowser`'s `close()` and `disconnect()` both fire `onDisconnected`, as Playwright's `disconnected` does whoever
 *   caused it.
 * - A `FakePage` records every call in `calls`. `goto` sets `currentUrl` and emits `navigated` then `load`, unless
 *   `failNext` says otherwise. `hold(method)` pauses the next call of `method` until `release()`: that is how a test makes a
 *   call "in flight". A held call rejects with `DriverClosed` when its page closes, as Playwright's do.
 * - `ManualClock` runs timers only when a test advances it.
 *
 * @module dish-browser/test/fake-driver
 */

import type { Clock } from '../src/clock.ts'
import { DriverClosed } from '../src/driver.ts'
import type {
  Act, ClickTarget, DialogKind, Driver, DriverBrowser, DriverContext, DriverDialog, DriverPage, DriverPopup, PageEvents, RouteDecider,
  RouteRequest, ScreencastFrame,
} from '../src/driver.ts'
import type { MouseButton, Viewport } from '../src/protocol.ts'
import type { UrlRules } from '../src/types.ts'

/** A promise and its resolvers. */
export interface Deferred<T> { promise: Promise<T>, resolve(value: T): void, reject(error: unknown): void }

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/** Let every pending promise callback and I/O callback run. */
export async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise<void>(resolve => setImmediate(resolve))
}

/** A hold on one call: `reached` resolves when the call arrives, and `release()` lets it go on. */
export interface Hold { reached: Promise<void>, release(): void }

interface PendingHold { reached: Deferred<void>, released: Deferred<void>, taken: boolean }

function makeHold(): { hold: Hold, pending: PendingHold } {
  const pending: PendingHold = { reached: deferred(), released: deferred(), taken: false }
  return { hold: { reached: pending.reached.promise, release: () => { pending.released.resolve() } }, pending }
}

// --- the driver ---------------------------------------------------------------------------------------------------------

export class FakeDriver implements Driver {
  launches: Array<{ executablePath: string, sandbox: boolean }> = []
  /** The next launches reject with these messages, in order. */
  failLaunches: string[] = []
  browsers: FakeBrowser[] = []
  /** Called with each new page of every browser this launches, before the core gets it (to hold its first `goto`, say). */
  onPage: ((page: FakePage) => void) | undefined
  private launchHolds: PendingHold[] = []

  /** Hold the next launch until `release()`. */
  holdLaunch(): Hold {
    const { hold, pending } = makeHold()
    this.launchHolds.push(pending)
    return hold
  }

  async launch(options: { executablePath: string, sandbox: boolean }): Promise<FakeBrowser> {
    this.launches.push({ executablePath: options.executablePath, sandbox: options.sandbox })
    const held = this.launchHolds.shift()
    if (held !== undefined) {
      held.reached.resolve()
      await held.released.promise
    }
    const failure = this.failLaunches.shift()
    if (failure !== undefined) throw new Error(failure)
    const browser = new FakeBrowser()
    browser.onPage = page => { this.onPage?.(page) }
    this.browsers.push(browser)
    return browser
  }

  /** The newest browser launched. */
  get browser(): FakeBrowser {
    const browser = this.browsers.at(-1)
    if (browser === undefined) throw new Error('no browser launched')
    return browser
  }

  /** Every page of every context of every browser, oldest first. */
  get pages(): FakePage[] {
    return this.browsers.flatMap(browser => browser.contexts.flatMap(context => context.pages))
  }
}

export class FakeBrowser implements DriverBrowser {
  contexts: FakeContext[] = []
  closed = false
  /** How many times `close()` was called. */
  closeCalls = 0
  /** The next `newContext` rejects with this. */
  failNewContext: Error | undefined
  /** Called with each new page of its contexts. */
  onPage: ((page: FakePage) => void) | undefined
  private listeners: Array<() => void> = []
  private disconnected = false

  async newContext(options: { viewport: Viewport, route: RouteDecider, refuseWebSocket: (url: string) => boolean }): Promise<FakeContext> {
    if (this.closed) throw new DriverClosed('Target page, context or browser has been closed')
    const failure = this.failNewContext
    if (failure !== undefined) {
      this.failNewContext = undefined
      throw failure
    }
    const context = new FakeContext(this, options)
    this.contexts.push(context)
    return context
  }

  onDisconnected(listener: () => void): void {
    this.listeners.push(listener)
  }

  async close(): Promise<void> {
    this.closeCalls++
    this.gone()
  }

  /** As if Chromium died. */
  disconnect(): void {
    this.gone()
  }

  private gone(): void {
    if (this.closed) return
    this.closed = true
    for (const context of this.contexts) context.closeNow()
    if (this.disconnected) return
    this.disconnected = true
    for (const listener of this.listeners) listener()
  }
}

export class FakeContext implements DriverContext {
  readonly browser: FakeBrowser
  route: RouteDecider
  refuseWebSocket: (url: string) => boolean
  viewport: Viewport
  pages: FakePage[] = []
  closed = false
  /** How many times `close()` was called. */
  closeCalls = 0
  /** The next `newPage` rejects with this. */
  failNewPage: Error | undefined

  constructor(browser: FakeBrowser, options: { viewport: Viewport, route: RouteDecider, refuseWebSocket: (url: string) => boolean }) {
    this.browser = browser
    this.route = options.route
    this.refuseWebSocket = options.refuseWebSocket
    this.viewport = options.viewport
  }

  async newPage(): Promise<FakePage> {
    if (this.closed) throw new DriverClosed('Target page, context or browser has been closed')
    const failure = this.failNewPage
    if (failure !== undefined) {
      this.failNewPage = undefined
      throw failure
    }
    const page = new FakePage(this.viewport)
    this.pages.push(page)
    this.browser.onPage?.(page)
    return page
  }

  async close(): Promise<void> {
    this.closeCalls++
    this.closeNow()
  }

  closeNow(): void {
    if (this.closed) return
    this.closed = true
    for (const page of this.pages) page.closeNow()
  }

  /** The newest page. */
  get page(): FakePage {
    const page = this.pages.at(-1)
    if (page === undefined) throw new Error('no page')
    return page
  }

  /** A request of the newest page, put to the route as Playwright's handler would put it. */
  request(url: string, options: Partial<Omit<RouteRequest, 'url'>> = {}): Promise<'continue' | 'abort'> {
    return this.route({ url, navigation: options.navigation ?? false, mainFrame: options.mainFrame ?? false, ownPage: options.ownPage ?? true })
  }
}

// --- the page's events' objects -----------------------------------------------------------------------------------------

export class FakeDialog implements DriverDialog {
  kind: DialogKind
  message: string
  /** How dish answered it. */
  answer: 'accept' | 'dismiss' | undefined
  readonly answered: Deferred<'accept' | 'dismiss'> = deferred()

  constructor(kind: DialogKind, message: string) {
    this.kind = kind
    this.message = message
  }

  async accept(): Promise<void> { this.answer = 'accept'; this.answered.resolve('accept') }
  async dismiss(): Promise<void> { this.answer = 'dismiss'; this.answered.resolve('dismiss') }
}

export class FakePopup implements DriverPopup {
  /** What `waitForUrl` gives. */
  url: string
  closed = false
  readonly closedNow: Deferred<void> = deferred()
  waitedMs: number | undefined

  constructor(url: string) {
    this.url = url
  }

  async waitForUrl(timeoutMs: number): Promise<string> {
    this.waitedMs = timeoutMs
    return this.url
  }

  async close(): Promise<void> {
    this.closed = true
    this.closedNow.resolve()
  }
}

// --- the page -----------------------------------------------------------------------------------------------------------

type Listeners = { [E in keyof PageEvents]: Array<PageEvents[E]> }

/** A PNG's eight-byte signature, and a little more: what the fake's `screenshot` gives. */
export const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])

export class FakePage implements DriverPage {
  /** 'about:blank' at first; `goto` sets it, then emits `navigated` and `load`. */
  currentUrl = 'about:blank'
  currentTitle = ''
  /** What `snapshot()` gives. */
  tree = ''
  /** What `snapshot({ ref })` gives. */
  subtrees = new Map<string, string>()
  refs = new Set<string>()
  passwords = new Set<string>()
  historyState = { canGoBack: false, canGoForward: false }
  scroll = { y: 0, height: 800 }
  screencasting = false
  screencastOptions: { quality: number, maxWidth: number, maxHeight: number } | undefined
  calls: Array<{ method: string, args: unknown[] }> = []
  closed = false
  readonly viewport: Viewport
  /** What `select` gives; by default the values asked for. */
  chosen: string[] | undefined
  /** What `responds` gives: false for a page whose script never ends. */
  responsive = true
  private listeners: Listeners = {
    crash: [], dialog: [], download: [], filechooser: [], navigated: [], load: [], popup: [], consoleError: [], requestFailed: [],
  }
  private failures = new Map<string, Error[]>()
  private holds = new Map<string, PendingHold[]>()
  private live = new Set<PendingHold>()
  private onFrame: ((frame: ScreencastFrame) => void) | undefined
  private entries = ['about:blank']
  private index = 0
  private frames = 0

  constructor(viewport: Viewport = { width: 1280, height: 800 }) {
    this.viewport = viewport
  }

  // --- test controls --------------------------------------------------------------------------------------------------

  /** The next call of `method` rejects with `error`. */
  failNext(method: keyof DriverPage, error: Error): void {
    const list = this.failures.get(method) ?? []
    list.push(error)
    this.failures.set(method, list)
  }

  /** Pause the next call of `method` until `release()`. */
  hold(method: keyof DriverPage): Hold {
    const { hold, pending } = makeHold()
    const list = this.holds.get(method) ?? []
    list.push(pending)
    this.holds.set(method, list)
    return hold
  }

  emit<E extends keyof PageEvents>(event: E, ...args: Parameters<PageEvents[E]>): void {
    for (const listener of [...this.listeners[event]]) (listener as (...a: Parameters<PageEvents[E]>) => void)(...args)
  }

  /** A screencast frame, when screencasting. */
  frame(data?: string): void {
    if (!this.screencasting || this.onFrame === undefined) return
    this.frames++
    this.onFrame({ data: data ?? `frame-${this.frames}`, width: this.viewport.width, height: this.viewport.height })
  }

  /** The calls of `method`, in order. */
  callsOf(method: keyof DriverPage): unknown[][] {
    return this.calls.filter(call => call.method === method).map(call => call.args)
  }

  /** Close the page as its context or Chromium would: every held call rejects with `DriverClosed`. */
  closeNow(): void {
    if (this.closed) return
    this.closed = true
    this.screencasting = false
    for (const pending of this.live) pending.released.reject(new DriverClosed('Target page, context or browser has been closed'))
    this.live.clear()
  }

  // --- the driver's page ----------------------------------------------------------------------------------------------

  on<E extends keyof PageEvents>(event: E, listener: PageEvents[E]): void {
    (this.listeners[event] as Array<PageEvents[E]>).push(listener)
  }

  url(): string {
    return this.currentUrl
  }

  title(): Promise<string> {
    return this.act('title', [], () => this.currentTitle)
  }

  history(): Promise<{ canGoBack: boolean, canGoForward: boolean }> {
    return this.act('history', [], () => ({ ...this.historyState }))
  }

  goto(url: string, options: Act & { loadMs: number }): Promise<void> {
    return this.act('goto', [url, options], () => {
      this.entries = [...this.entries.slice(0, this.index + 1), url]
      this.index = this.entries.length - 1
      this.historyState = { canGoBack: this.index > 0, canGoForward: false }
      this.arrive(url)
    })
  }

  back(options: Act): Promise<boolean> {
    return this.act('back', [options], () => {
      if (this.index === 0) return false
      this.index--
      this.historyState = { canGoBack: this.index > 0, canGoForward: true }
      this.arrive(this.entries[this.index] ?? 'about:blank')
      return true
    })
  }

  forward(options: Act): Promise<boolean> {
    return this.act('forward', [options], () => {
      if (this.index >= this.entries.length - 1) return false
      this.index++
      this.historyState = { canGoBack: true, canGoForward: this.index < this.entries.length - 1 }
      this.arrive(this.entries[this.index] ?? 'about:blank')
      return true
    })
  }

  reload(options: Act): Promise<void> {
    return this.act('reload', [options], () => { this.arrive(this.currentUrl) })
  }

  snapshot(options: Act & { ref?: string }): Promise<string> {
    return this.act('snapshot', [options], () => options.ref === undefined ? this.tree : this.subtrees.get(options.ref) ?? '')
  }

  hasRef(ref: string): Promise<boolean> {
    return this.act('hasRef', [ref], () => this.refs.has(ref))
  }

  isPassword(ref: string): Promise<boolean> {
    return this.act('isPassword', [ref], () => this.passwords.has(ref))
  }

  responds(timeoutMs: number): Promise<boolean> {
    return this.act('responds', [timeoutMs], () => this.responsive)
  }

  click(target: ClickTarget, options: Act & { double: boolean }): Promise<void> {
    return this.act('click', [target, options], () => {})
  }

  fill(ref: string, text: string, options: Act): Promise<void> {
    return this.act('fill', [ref, text, options], () => {})
  }

  type(text: string, options: Act): Promise<void> {
    return this.act('type', [text, options], () => {})
  }

  press(key: string, options: Act & { ref?: string }): Promise<void> {
    return this.act('press', [key, options], () => {})
  }

  select(ref: string, values: string[], options: Act): Promise<string[]> {
    return this.act('select', [ref, values, options], () => this.chosen ?? [...values])
  }

  scrollIntoView(ref: string, options: Act): Promise<void> {
    return this.act('scrollIntoView', [ref, options], () => {})
  }

  scrollBy(dx: number, dy: number): Promise<void> {
    return this.act('scrollBy', [dx, dy], () => {
      this.scroll = { ...this.scroll, y: Math.max(0, Math.min(this.scroll.height - this.viewport.height, this.scroll.y + dy)) }
    })
  }

  scrollPosition(): Promise<{ y: number, height: number }> {
    return this.act('scrollPosition', [], () => ({ ...this.scroll }))
  }

  waitForText(text: string, options: Act & { gone: boolean }): Promise<void> {
    return this.act('waitForText', [text, options], () => {})
  }

  screenshot(options: Act & { ref?: string }): Promise<Uint8Array> {
    return this.act('screenshot', [options], () => PNG_BYTES)
  }

  settle(ms: number): Promise<void> {
    return this.act('settle', [ms], () => {})
  }

  startScreencast(options: { quality: number, maxWidth: number, maxHeight: number }, onFrame: (frame: ScreencastFrame) => void): Promise<void> {
    return this.act('startScreencast', [options], () => {
      this.screencasting = true
      this.screencastOptions = options
      this.onFrame = onFrame
    })
  }

  stopScreencast(): Promise<void> {
    return this.act('stopScreencast', [], () => {
      this.screencasting = false
      this.onFrame = undefined
    })
  }

  capture(quality: number): Promise<ScreencastFrame> {
    return this.act('capture', [quality], () => ({ data: 'capture', width: this.viewport.width, height: this.viewport.height }))
  }

  mouse(action: 'down' | 'up' | 'move', x: number, y: number, button: MouseButton, clickCount: number): Promise<void> {
    return this.act('mouse', [action, x, y, button, clickCount], () => {})
  }

  wheel(x: number, y: number, dx: number, dy: number): Promise<void> {
    return this.act('wheel', [x, y, dx, dy], () => {})
  }

  keyDown(key: string): Promise<void> {
    return this.act('keyDown', [key], () => {})
  }

  keyUp(key: string): Promise<void> {
    return this.act('keyUp', [key], () => {})
  }

  insertText(text: string): Promise<void> {
    return this.act('insertText', [text], () => {})
  }

  async close(): Promise<void> {
    this.calls.push({ method: 'close', args: [] })
    this.closeNow()
  }

  // --- inside ---------------------------------------------------------------------------------------------------------

  /** Commit `url` in the main frame: `navigated`, then `load`. */
  private arrive(url: string): void {
    this.currentUrl = url
    this.emit('navigated', url)
    this.emit('load')
  }

  /** Record the call, then its failure or hold, then do it. */
  private async act<T>(method: keyof DriverPage, args: unknown[], body: () => T): Promise<T> {
    this.calls.push({ method, args })
    if (this.closed) throw new DriverClosed('Target page, context or browser has been closed')
    const failure = this.failures.get(method)?.shift()
    const held = this.holds.get(method)?.shift()
    if (held !== undefined) {
      this.live.add(held)
      held.reached.resolve()
      try {
        await held.released.promise
      } finally {
        this.live.delete(held)
      }
      if (this.closed) throw new DriverClosed('Target page, context or browser has been closed')
    }
    if (failure !== undefined) throw failure
    return body()
  }
}

// --- URL rules ----------------------------------------------------------------------------------------------------------

function parsed(url: string): URL | undefined {
  try {
    return new URL(url)
  } catch {
    return undefined
  }
}

/**
 * Simple URL rules for the core's tests, so they don't hang on `urls.ts`:
 * - http(s) on any host but `blocked.test` (`what` "blocked.test") and dsh's own address (`what` "dsh's own address");
 * - `file://` whose path is the workspace or under it, by prefix (`what` the path);
 * - `about:blank`; `chrome-error:` from the page;
 * - any other scheme refused, `what` the scheme (`chrome:`).
 * `resolve` gives a bare host `https://` and an absolute path `file://`.
 */
export const simpleRules: UrlRules = {
  async resolve(input, places) {
    const text = input.trim()
    if (text === '') return { ok: false, what: '', reason: 'The address is empty.' }
    const url = text.startsWith('/') ? `file://${text}` : /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`
    return simpleRules.check(url, places, 'typed')
  },
  async check(url, places, from) {
    const parts = parsed(url)
    if (parts === undefined) return { ok: false, what: url, reason: `${url} isn't a URL.` }
    switch (parts.protocol) {
      case 'http:':
      case 'https:':
        if (simpleRules.own(parts.href, places.own)) return { ok: false, what: 'dsh\'s own address', reason: `${parts.href} is dsh's own address.` }
        if (parts.hostname === 'blocked.test') return { ok: false, what: 'blocked.test', reason: 'blocked.test is blocked.' }
        return { ok: true, url: parts.href }
      case 'about:':
        if (parts.href === 'about:blank') return { ok: true, url: parts.href }
        break
      case 'file:': {
        const path = decodeURIComponent(parts.pathname)
        const workspace = places.workspace
        if (workspace !== undefined && (path === workspace || path.startsWith(`${workspace}/`))) return { ok: true, url: parts.href }
        return { ok: false, what: path, reason: `${path} is outside this chat's workspace.` }
      }
      case 'chrome-error:':
        if (from === 'page') return { ok: true, url: parts.href }
        break
    }
    return { ok: false, what: parts.protocol, reason: `${parts.protocol} addresses aren't opened here.` }
  },
  own(url, own) {
    const parts = parsed(url)
    if (parts === undefined || !['http:', 'https:', 'ws:', 'wss:'].includes(parts.protocol)) return false
    if (own.trustedHost !== undefined && parts.hostname.toLowerCase() === own.trustedHost.toLowerCase()) return true
    const host = parts.hostname
    const loopback = host === 'localhost' || host.endsWith('.localhost') || host.startsWith('127.') || host === '[::1]' || host === '0.0.0.0'
    const port = parts.port !== '' ? Number(parts.port) : parts.protocol === 'https:' || parts.protocol === 'wss:' ? 443 : 80
    return loopback && port === own.port
  },
}

// --- the clock ----------------------------------------------------------------------------------------------------------

interface Timer { at: number, order: number, run: () => void, live: boolean }

/** A clock whose time moves only when a test says. */
export class ManualClock implements Clock {
  time: number
  private timers: Timer[] = []
  private order = 0

  constructor(start = 1_000_000) {
    this.time = start
  }

  now(): number {
    return this.time
  }

  after(ms: number, run: () => void): () => void {
    const timer: Timer = { at: this.time + Math.max(0, ms), order: this.order++, run, live: true }
    this.timers.push(timer)
    return () => { timer.live = false }
  }

  /** Move time on by `ms`, running each timer that falls due, in time order (one set by a timer runs too, when it is due). */
  advance(ms: number): void {
    const end = this.time + ms
    for (;;) {
      const next = this.nextDue(end)
      if (next === undefined) break
      this.time = next.at
      next.live = false
      next.run()
    }
    this.time = end
    this.timers = this.timers.filter(timer => timer.live)
  }

  /** `advance`, in steps of `step` ms, letting promise callbacks run between them. */
  async tick(ms: number, step = 50): Promise<void> {
    let left = ms
    await flush()
    while (left > 0) {
      const now = Math.min(step, left)
      this.advance(now)
      left -= now
      await flush()
    }
  }

  /** How many timers are set and not yet run or cancelled. */
  get pending(): number {
    return this.timers.filter(timer => timer.live).length
  }

  private nextDue(end: number): Timer | undefined {
    let next: Timer | undefined
    for (const timer of this.timers) {
      if (!timer.live || timer.at > end) continue
      if (next === undefined || timer.at < next.at || (timer.at === next.at && timer.order < next.order)) next = timer
    }
    return next
  }
}
