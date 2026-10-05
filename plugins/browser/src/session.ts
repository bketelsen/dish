/**
 * One session's browser: a Playwright context and its one page, as the core (`browsers.ts`) keeps them.
 *
 * - **The agent's calls** run one at a time, in a queue (`call`). A call that is queued when its signal aborts never runs.
 *   A close, or the page's crash, rejects the call in flight at once, without waiting for its run, so no call hangs on a
 *   browser that is gone.
 * - **The user's input** from the Browser tab runs on a chain of its own (`input`), in order, never behind the agent's
 *   queue.
 * - **The page's events** become notes for the agent's next result, and notices for the tab: dialogs are answered at once,
 *   popups followed in this page or closed, downloads and file choosers refused, navigations checked against the URL
 *   rules. A crashed page is replaced at once in the same context.
 * - **What it remembers:** the workspace, the last snapshot the agent got, the user's activity since the agent's last
 *   call, the console errors and failed requests, when it was last used, and the page's URL, title and history for the
 *   tab.
 *
 * Page text (URLs, titles, dialog messages, console lines) goes into notes, notices and the view only: never into an
 * error's message or a log line.
 *
 * @module dish-browser/session
 */

import type { Clock } from './clock.ts'
import type { DriverContext, DriverDialog, DriverPage, DriverPopup, FailedRequest, RouteRequest, ScreencastFrame } from './driver.ts'
import { ALT, CONTROL, META, SHIFT } from './protocol.ts'
import type { Up, Viewport } from './protocol.ts'
import { JPEG_QUALITY, LOAD_MS, LOG_RING, NAV_MS, POPUP_URL_MS } from './types.ts'
import type { BrowserErrorCode, CloseReason, Note, OwnAddress, TabNotice, UrlCheck, UrlPlaces, UrlRules, UserActivity } from './types.ts'

/** The core's own failure of a browser call; `detail` is a path, a close reason, or Chromium's first line, never page text. */
export class BrowserError extends Error {
  code: BrowserErrorCode
  detail: string
  constructor(code: BrowserErrorCode, detail = '') {
    super(detail === '' ? `browser ${code}` : `browser ${code}: ${detail}`)
    this.name = 'BrowserError'
    this.code = code
    this.detail = detail
  }
}

/** Console errors and failed requests since the last take, newest last; `more…` counts those the ring no longer holds. */
export interface Logs { console: string[], requests: string[], moreConsole: number, moreRequests: number }

/** The user's input from the tab that replays on the page. */
export type InputAction = Extract<Up, { kind: 'mouse' | 'wheel' | 'key' | 'text' }>

/** What the tab shows of the page. */
export interface PageView { url: string, title: string, loading: boolean, canGoBack: boolean, canGoForward: boolean }

/** What a browser needs of the core. */
export interface SessionHost {
  readonly clock: Clock
  readonly rules: UrlRules
  readonly sharedTmp: boolean
  readonly viewport: Viewport
  own(): OwnAddress
  /** How a key from the tab replays (`keys.ts`'s `replayAs`). */
  replayAs(key: string): 'key' | 'text' | undefined
  log: { info(message: string): void, warn(message: string): void }
  /** Something the tab's view shows changed. */
  changed(): void
  /** A notice for the Browser tab. */
  notice(notice: TabNotice): void
  /** A screencast frame of the current page. */
  frame(frame: ScreencastFrame): void
  /** A call ended or left the queue: the cap's waiters may find room. */
  callEnded(): void
  /** The page crashed and no new one could be made: the browser is no use. */
  broken(): void
}

export interface SessionBrowserOptions {
  sessionId: string
  context: DriverContext
  page: DriverPage
  workspace: string | undefined
  /** Notes waiting for this session, such as a reopened browser's; they come first. */
  notes?: readonly Note[]
  /** The user started this browser from the address bar. */
  started?: boolean
  host: SessionHost
}

/** The lines kept of one dialog message, console line or failed request. */
const KEPT = 1000
/** The most notes kept between two of the agent's calls; past it, the oldest page-caused note goes. */
const NOTES_KEPT = LOG_RING
/** The wait, after a navigation commits, before the title is read again. */
const TITLE_DELAY_MS = 200

/** The modifier keys the core tracks as held down, and their `modifiers` bits. */
const MODIFIERS: ReadonlyArray<readonly [string, number]> = [['Alt', ALT], ['Control', CONTROL], ['Meta', META], ['Shift', SHIFT]]
const MODIFIER_KEYS = new Set(MODIFIERS.map(([key]) => key))

function cut(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max)
}

interface Entry {
  start(): void
  fail(error: unknown): void
}

export class SessionBrowser {
  readonly sessionId: string
  readonly context: DriverContext
  workspace: string | undefined
  /** The processed full-page snapshot this agent last got; undefined after a new page. */
  lastSnapshot: string | undefined
  /** How a dialog in the current agent call is answered; reset to 'dismiss' after each call. */
  dialogAnswer: 'accept' | 'dismiss' = 'dismiss'

  private readonly host: SessionHost
  private currentPage: DriverPage
  private closed: CloseReason | undefined
  private readonly closeListeners = new Set<(reason: CloseReason) => void>()
  private readonly timers = new Set<() => void>()
  // The agent's queue.
  private queue: Entry[] = []
  private current: Entry | undefined
  private replacing: Promise<void> | undefined
  private usedAt: number
  // The tab's view.
  private pageView: PageView
  // What the agent's next result says.
  private events: Note[]
  private activity: UserActivity | undefined
  private consoleRing: string[] = []
  private requestRing: string[] = []
  private consoleDropped = 0
  private requestDropped = 0
  private consoleNew = 0
  private requestNew = 0
  // The screencast.
  private watched = false
  private screencastChain: Promise<void> = Promise.resolve()
  // The user's input.
  private inputs: InputAction[] = []
  private inputRunning = false
  private inputFailureLogged = false
  private readonly heldModifiers = new Set<string>()

  constructor(options: SessionBrowserOptions) {
    this.sessionId = options.sessionId
    this.context = options.context
    this.workspace = options.workspace
    this.host = options.host
    this.usedAt = this.host.clock.now()
    this.events = [...options.notes ?? []]
    if (options.started === true) this.activity = this.freshActivity(true)
    this.currentPage = options.page
    this.pageView = { url: options.page.url(), title: '', loading: false, canGoBack: false, canGoForward: false }
    this.attach(options.page)
  }

  // --- what the core and the tools read -------------------------------------------------------------------------------

  get page(): DriverPage {
    return this.currentPage
  }

  /** An agent's call is running. */
  get acting(): boolean {
    return this.current !== undefined
  }

  /** An agent's call is running or queued: the cap never evicts such a browser. */
  get inCall(): boolean {
    return this.current !== undefined || this.queue.length > 0
  }

  /** When an agent's call, or the user's input, last used it; now while a frames-on watcher watches it. */
  get lastUsed(): number {
    return this.watched ? this.host.clock.now() : this.usedAt
  }

  /** Why it closed, once it has. */
  get closedReason(): CloseReason | undefined {
    return this.closed
  }

  /** The page's URL, title, loading and history, as the tab shows them (raw: the stream masks them). */
  get view(): PageView {
    return { ...this.pageView }
  }

  places(): UrlPlaces {
    return { workspace: this.workspace, sharedTmp: this.host.sharedTmp, own: this.host.own() }
  }

  // --- the agent's queue ----------------------------------------------------------------------------------------------

  /** One agent call, in this browser's queue. */
  call<T>(signal: AbortSignal, run: (page: DriverPage) => Promise<T>): Promise<T> {
    if (this.closed !== undefined) return Promise.reject(new BrowserError('closed', this.closed))
    if (signal.aborted) return Promise.reject(signal.reason)
    return new Promise<T>((resolve, reject) => {
      let state: 'queued' | 'running' | 'done' = 'queued'
      const settle = (ok: boolean, value: unknown): void => {
        if (state === 'done') return
        const wasRunning = state === 'running'
        state = 'done'
        signal.removeEventListener('abort', onAbort)
        if (wasRunning) {
          if (this.current === entry) this.current = undefined
          this.usedAt = this.host.clock.now()
          this.dialogAnswer = 'dismiss'
        } else {
          const at = this.queue.indexOf(entry)
          if (at >= 0) this.queue.splice(at, 1)
        }
        if (ok) resolve(value as T)
        else reject(value)
        if (wasRunning) {
          this.host.changed()
          this.pump()
        }
        this.host.callEnded()
      }
      const onAbort = (): void => {
        if (state === 'queued') settle(false, signal.reason)
      }
      const entry: Entry = {
        start: () => {
          state = 'running'
          this.current = entry
          this.host.changed()
          let work: Promise<T>
          try {
            work = Promise.resolve(run(this.currentPage))
          } catch (error) {
            work = Promise.reject(error)
          }
          work.then(value => { settle(true, value) }, (error: unknown) => { settle(false, error) })
        },
        fail: error => { settle(false, error) },
      }
      signal.addEventListener('abort', onAbort, { once: true })
      this.queue.push(entry)
      this.pump()
    })
  }

  /** Start the next queued call, when none runs and the page isn't being replaced. */
  private pump(): void {
    if (this.current !== undefined || this.replacing !== undefined || this.closed !== undefined) return
    // Out of the queue, it runs: an abort from now on doesn't end it early (its run honours the signal).
    const next = this.queue.shift()
    next?.start()
  }

  /**
   * `work`, or `BrowserError('closed')` as soon as this browser closes, so that nothing waits on a driver promise that
   * never settles. A value that comes after the close is given to `late` (to close what it made).
   */
  whileOpen<T>(work: Promise<T>, late?: (value: T) => void): Promise<T> {
    let settled = this.closed !== undefined
    work.then(value => { if (settled) late?.(value) }, () => {})
    if (this.closed !== undefined) return Promise.reject(new BrowserError('closed', this.closed))
    return new Promise<T>((resolve, reject) => {
      const onClosed = (reason: CloseReason): void => {
        settled = true
        reject(new BrowserError('closed', reason))
      }
      this.closeListeners.add(onClosed)
      work.then(
        value => {
          if (settled) return
          settled = true
          this.closeListeners.delete(onClosed)
          resolve(value)
        },
        (error: unknown) => {
          if (settled) return
          settled = true
          this.closeListeners.delete(onClosed)
          reject(error)
        },
      )
    })
  }

  /** Resolves once a crashed page has been replaced (at once when none is). */
  ready(): Promise<void> {
    return this.replacing ?? Promise.resolve()
  }

  // --- the notes ------------------------------------------------------------------------------------------------------

  /** The user's activity (when there was any) and the events, since the agent's last take; clears both. */
  takeNotes(): { user?: UserActivity, events: Note[] } {
    const activity = this.activity
    const events = this.events
    this.activity = undefined
    this.events = []
    return { user: activity !== undefined && substantial(activity) ? activity : undefined, events }
  }

  /** Console errors and failed requests since the last take, newest last; clears them. */
  takeLogs(): Logs {
    const logs: Logs = { console: this.consoleRing, requests: this.requestRing, moreConsole: this.consoleDropped, moreRequests: this.requestDropped }
    this.consoleRing = []
    this.requestRing = []
    this.consoleDropped = 0
    this.requestDropped = 0
    return logs
  }

  /** How many console errors and failed requests came since the last call of this; resets. */
  newLogCounts(): { console: number, requests: number } {
    const counts = { console: this.consoleNew, requests: this.requestNew }
    this.consoleNew = 0
    this.requestNew = 0
    return counts
  }

  /** When the page's URL breaks the rules: send it to about:blank and note it. */
  async ensureAllowed(): Promise<void> {
    const page = this.currentPage
    const check = await this.check(page.url())
    if (check.ok) return
    try {
      await this.whileOpen(page.goto('about:blank', { timeoutMs: NAV_MS, loadMs: LOAD_MS }))
    } catch {
      // Whatever the page does now, the next result shows it.
    }
    this.addNote({ kind: 'blocked', what: check.what })
  }

  // --- the route ------------------------------------------------------------------------------------------------------

  /**
   * The context's route for this browser's requests. A refused main-frame navigation of its own page is noted, and the
   * page goes to about:blank once the abort is through; anything else refused is aborted silently.
   */
  async route(request: RouteRequest): Promise<'continue' | 'abort'> {
    const check = await this.check(request.url)
    if (check.ok) return 'continue'
    if (request.navigation && request.mainFrame && request.ownPage && this.closed === undefined) {
      this.block(check.what)
      const page = this.currentPage
      this.later(0, () => { this.toBlank(page) })
    }
    return 'abort'
  }

  // --- the user's input -----------------------------------------------------------------------------------------------

  /** A navigation the user made from the tab landed on `url`. */
  recordNavigation(url: string): void {
    const activity = this.used()
    if (activity.navigations.length < 5) activity.navigations.push(url)
    else activity.moreNavigations++
  }

  /** The user's mouse, wheel, key or text: noted at once, replayed on the input chain, in order. */
  input(action: InputAction): void {
    if (this.closed !== undefined) return
    this.noteInput(action)
    this.inputs.push(action)
    if (!this.inputRunning) void this.drainInputs()
  }

  private noteInput(action: InputAction): void {
    const activity = this.used()
    switch (action.kind) {
      case 'mouse':
        if (action.action === 'down' && action.button === 'left') activity.clicks++
        break
      case 'wheel':
        activity.scrolled = true
        break
      case 'text':
        activity.typed = true
        break
      case 'key': {
        if (action.action !== 'down' || MODIFIER_KEYS.has(action.key) || this.host.replayAs(action.key) === undefined) break
        const shortcut = (action.modifiers & (CONTROL | ALT | META)) !== 0
        if ([...action.key].length === 1 && !shortcut) activity.typed = true
        else activity.keys = true
        break
      }
    }
  }

  private async drainInputs(): Promise<void> {
    this.inputRunning = true
    try {
      while (this.inputs.length > 0 && this.closed === undefined) {
        // Input to a crashed page waits for the new one.
        if (this.replacing !== undefined) await this.replacing
        const action = this.inputs.shift()
        if (action === undefined || this.closed !== undefined) break
        if (isMove(action) && this.inputs[0] !== undefined && isMove(this.inputs[0])) continue
        try {
          await this.whileOpen(this.replay(action))
        } catch {
          if (this.closed !== undefined) break
          if (!this.inputFailureLogged) {
            this.inputFailureLogged = true
            this.host.log.warn(`input from the Browser tab failed on the page of ${this.sessionId}; later failures there aren't logged`)
          }
        }
      }
    } finally {
      this.inputRunning = false
    }
  }

  private async replay(action: InputAction): Promise<void> {
    const page = this.currentPage
    switch (action.kind) {
      case 'mouse':
        await page.mouse(action.action, action.x, action.y, action.button, action.clickCount)
        return
      case 'wheel':
        await page.wheel(action.x, action.y, action.dx, action.dy)
        return
      case 'text':
        await page.insertText(action.text)
        return
      case 'key': {
        const how = this.host.replayAs(action.key)
        if (how === undefined) return
        if (action.action === 'up') {
          if (how === 'key') {
            this.heldModifiers.delete(action.key)
            await page.keyUp(action.key)
          }
          return
        }
        for (const [key, bit] of MODIFIERS) {
          if (!this.heldModifiers.has(key) || (action.modifiers & bit) !== 0) continue
          this.heldModifiers.delete(key)
          await page.keyUp(key)
        }
        if (how === 'text') {
          await page.insertText(action.key)
          return
        }
        await page.keyDown(action.key)
        if (MODIFIER_KEYS.has(action.key)) this.heldModifiers.add(action.key)
        return
      }
    }
  }

  /** The user's activity, made now when there is none, with `last` and the browser's use set to now. */
  private used(): UserActivity {
    const now = this.host.clock.now()
    this.usedAt = now
    this.activity ??= this.freshActivity(false)
    this.activity.last = now
    return this.activity
  }

  private freshActivity(started: boolean): UserActivity {
    return { started, navigations: [], moreNavigations: 0, clicks: 0, typed: false, keys: false, scrolled: false, last: this.host.clock.now() }
  }

  // --- the screencast -------------------------------------------------------------------------------------------------

  /** A frames-on watcher watches this browser (or the last one left): the screencast runs while it does. */
  setWatched(on: boolean): void {
    if (on === this.watched || this.closed !== undefined) return
    this.watched = on
    if (!on) this.usedAt = this.host.clock.now()
    this.screencast(on)
  }

  private screencast(on: boolean): void {
    const page = this.currentPage
    this.screencastChain = this.screencastChain.then(async () => {
      if (this.closed !== undefined || page !== this.currentPage) return
      try {
        if (on) {
          const { width, height } = this.host.viewport
          await page.startScreencast({ quality: JPEG_QUALITY, maxWidth: width, maxHeight: height }, frame => {
            if (page === this.currentPage && this.closed === undefined && this.watched) this.host.frame(frame)
          })
        } else {
          await page.stopScreencast()
        }
      } catch {
        // The page went away: a new page starts its own screencast.
      }
    })
  }

  // --- closing --------------------------------------------------------------------------------------------------------

  /** The core closed this browser: every call in flight or queued, and every `whileOpen`, rejects closed now. */
  markClosed(reason: CloseReason): void {
    if (this.closed !== undefined) return
    this.closed = reason
    const current = this.current
    const queued = this.queue
    this.queue = []
    this.inputs = []
    current?.fail(new BrowserError('closed', reason))
    for (const entry of queued) entry.fail(new BrowserError('closed', reason))
    for (const listener of [...this.closeListeners]) listener(reason)
    this.closeListeners.clear()
    for (const cancel of this.timers) cancel()
    this.timers.clear()
  }

  // --- the page's events ----------------------------------------------------------------------------------------------

  private attach(page: DriverPage): void {
    const guard = <A extends unknown[]>(handler: (...args: A) => void) => (...args: A): void => {
      try {
        handler(...args)
      } catch {
        // A handler of ours that throws mustn't reach Playwright's emitter.
      }
    }
    page.on('crash', guard(() => { this.crashed(page) }))
    page.on('dialog', guard((dialog: DriverDialog) => { this.dialog(page, dialog) }))
    page.on('download', guard((name: string) => { if (this.isCurrent(page)) this.noteAndNotice({ kind: 'download', name: cut(name, KEPT) }) }))
    page.on('filechooser', guard(() => { if (this.isCurrent(page)) this.noteAndNotice({ kind: 'filechooser' }) }))
    page.on('navigated', guard((url: string) => { this.navigated(page, url) }))
    page.on('load', guard(() => { this.loaded(page) }))
    page.on('popup', guard((popup: DriverPopup) => { void this.popup(page, popup) }))
    page.on('consoleError', guard((text: string) => { if (this.isCurrent(page)) this.consoleError(text) }))
    page.on('requestFailed', guard((request: FailedRequest) => { if (this.isCurrent(page)) this.requestFailed(request) }))
  }

  private isCurrent(page: DriverPage): boolean {
    return page === this.currentPage && this.closed === undefined
  }

  private dialog(page: DriverPage, dialog: DriverDialog): void {
    const current = this.isCurrent(page)
    const accept = current && (dialog.kind === 'beforeunload' || (this.current !== undefined && this.dialogAnswer === 'accept'))
    void (accept ? dialog.accept() : dialog.dismiss()).catch(() => {})
    if (current) this.noteAndNotice({ kind: 'dialog', dialog: dialog.kind, message: cut(dialog.message, KEPT), accepted: accept })
  }

  private async popup(page: DriverPage, popup: DriverPopup): Promise<void> {
    let url = 'about:blank'
    try {
      url = await popup.waitForUrl(POPUP_URL_MS)
    } catch {
      // A popup that went away has no address of its own.
    }
    void popup.close().catch(() => {})
    if (!this.isCurrent(page)) return
    if (url === 'about:blank' || url === '') {
      this.noteAndNotice({ kind: 'popup', url: 'about:blank', outcome: 'blank' })
      return
    }
    const check = await this.check(url)
    if (!this.isCurrent(page)) return
    if (!check.ok) {
      this.noteAndNotice({ kind: 'popup', url, outcome: 'refused', what: check.what })
      return
    }
    void page.goto(check.url, { timeoutMs: NAV_MS, loadMs: LOAD_MS }).catch(() => {})
    this.noteAndNotice({ kind: 'popup', url: check.url, outcome: 'followed' })
  }

  private navigated(page: DriverPage, url: string): void {
    if (!this.isCurrent(page)) return
    this.pageView.url = url
    this.pageView.loading = true
    this.host.changed()
    this.later(TITLE_DELAY_MS, () => { void this.readTitle(page) })
    void this.readHistory(page)
    void this.checkCommitted(page, url)
  }

  private async checkCommitted(page: DriverPage, url: string): Promise<void> {
    const check = await this.check(url)
    if (check.ok || !this.isCurrent(page)) return
    this.block(check.what)
    if (this.pageView.url === url) this.toBlank(page)
  }

  private loaded(page: DriverPage): void {
    if (!this.isCurrent(page)) return
    this.pageView.loading = false
    this.host.changed()
    void this.readTitle(page)
    void this.readHistory(page)
  }

  private async readTitle(page: DriverPage): Promise<void> {
    try {
      const title = await page.title()
      if (!this.isCurrent(page) || title === this.pageView.title) return
      this.pageView.title = title
      this.host.changed()
    } catch {
      // The page is going; the next load reads it again.
    }
  }

  private async readHistory(page: DriverPage): Promise<void> {
    try {
      const history = await page.history()
      if (!this.isCurrent(page)) return
      if (history.canGoBack === this.pageView.canGoBack && history.canGoForward === this.pageView.canGoForward) return
      this.pageView.canGoBack = history.canGoBack
      this.pageView.canGoForward = history.canGoForward
      this.host.changed()
    } catch {
      // As for the title.
    }
  }

  private consoleError(text: string): void {
    this.consoleNew++
    this.consoleRing.push(cut(text, KEPT))
    if (this.consoleRing.length > LOG_RING) {
      this.consoleRing.shift()
      this.consoleDropped++
    }
  }

  private requestFailed(request: FailedRequest): void {
    this.requestNew++
    const what = request.status !== undefined ? String(request.status) : request.error ?? 'failed'
    this.requestRing.push(cut(`${what} ${request.url}`, KEPT))
    if (this.requestRing.length > LOG_RING) {
      this.requestRing.shift()
      this.requestDropped++
    }
  }

  private crashed(page: DriverPage): void {
    if (!this.isCurrent(page)) return
    this.noteAndNotice({ kind: 'crashed' })
    this.host.log.warn(`the page of ${this.sessionId} crashed`)
    this.lastSnapshot = undefined
    this.replacing = this.replace(page)
    this.current?.fail(new BrowserError('crashed'))
  }

  /** A new page in the same context, in place of the crashed one: wired again, and screencasting when watched. */
  private async replace(old: DriverPage): Promise<void> {
    void old.close().catch(() => {})
    try {
      // Bounded by the close: a new page that never comes doesn't hold the queue, the input or the tab forever.
      const page = await this.whileOpen(this.context.newPage(), made => { void made.close().catch(() => {}) })
      this.currentPage = page
      this.pageView = { url: page.url(), title: '', loading: false, canGoBack: false, canGoForward: false }
      this.heldModifiers.clear()
      this.attach(page)
      if (this.watched) this.screencast(true)
      this.host.changed()
    } catch {
      if (this.closed === undefined) this.host.broken()
    } finally {
      this.replacing = undefined
      this.pump()
    }
  }

  // --- inside ---------------------------------------------------------------------------------------------------------

  /** The rules' check of a URL from the page; a check that throws refuses. */
  private async check(url: string): Promise<UrlCheck> {
    try {
      return await this.host.rules.check(url, this.places(), 'page')
    } catch {
      return { ok: false, what: 'an address dish couldn\'t check', reason: '' }
    }
  }

  private block(what: string): void {
    this.noteAndNotice({ kind: 'blocked', what })
  }

  /** Send the page to about:blank: not queued, not awaited, errors ignored. */
  private toBlank(page: DriverPage): void {
    if (!this.isCurrent(page)) return
    void page.goto('about:blank', { timeoutMs: NAV_MS, loadMs: LOAD_MS }).catch(() => {})
  }

  private noteAndNotice(note: Note): void {
    this.addNote(note)
    this.host.notice(note)
  }

  private addNote(note: Note): void {
    this.events.push(note)
    if (this.events.length <= NOTES_KEPT) return
    const oldest = this.events.findIndex(event => event.kind !== 'reopened' && event.kind !== 'crashed')
    this.events.splice(oldest >= 0 ? oldest : 0, 1)
  }

  /** A timer of this browser's, cancelled when it closes. */
  private later(ms: number, run: () => void): void {
    const cancel = this.host.clock.after(ms, () => {
      this.timers.delete(cancel)
      if (this.closed === undefined) run()
    })
    this.timers.add(cancel)
  }
}

function isMove(action: InputAction): boolean {
  return action.kind === 'mouse' && action.action === 'move'
}

/** Activity worth a note: a navigation, a click, typing, keys, a scroll, or the start. Mouse moves alone aren't. */
function substantial(activity: UserActivity): boolean {
  return activity.started || activity.navigations.length > 0 || activity.moreNavigations > 0 || activity.clicks > 0
    || activity.typed || activity.keys || activity.scrolled
}
