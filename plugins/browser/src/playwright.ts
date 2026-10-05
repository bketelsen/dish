/**
 * The real driver: `Driver` (`src/driver.ts`) over playwright-core 1.63.0 and one headless Chromium. This is the only
 * file that imports `playwright-core`; everything else talks to `Driver`, and the tests to a fake of it.
 *
 * Line numbers cite playwright-core 1.63.0's `types/types.d.ts` (`types/protocol.d.ts` for CDP).
 *
 * - **Launch** (`BrowserType.launch`, `LaunchOptions` :25376): Chromium's own sandbox as asked (`chromiumSandbox`,
 *   :25405), headless (:25453), and Playwright's signal handlers off (`handleSIGINT`, `handleSIGTERM`, `handleSIGHUP`,
 *   :25436-25446): its SIGINT handler ends in `process.exit(130)`, which would take dsh down without its own shutdown.
 *   No `env`: Chromium gets dsh's environment, `TMPDIR` with it, and its temporary profile goes to `os.tmpdir()`.
 * - **A context** (`BrowserContextOptions` :25728): the viewport, `deviceScaleFactor` 1, `acceptDownloads` false (:25732)
 *   and `serviceWorkers: 'block'` (:26065), since a service worker's own requests would bypass the route. Every request
 *   goes through `route` (`BrowserContext.route`, :10399); WebSockets, which the route doesn't see, through
 *   `routeWebSocket` (:10482).
 * - **A page** reports its events in dish's terms (`PageEvents`), and keeps one CDP session (`newCDPSession`, :10325)
 *   for its history and the screencast.
 * - **Errors.** An action maps Playwright's errors to the driver's: a timeout (`errors.TimeoutError`, :18779) is a
 *   `DriverTimeout`; a closed or crashed target is `DriverClosed`; an unknown key, a `selectOption` on what isn't a
 *   `<select>` and a `fill` on what isn't fillable are `DriverBadArgument`; anything else is thrown as it is. A mapped
 *   error keeps only the first line of Playwright's message: the call log under it can name the page's elements and
 *   addresses. An action whose signal aborted rejects with the signal's reason. Launch errors are never mapped: dish
 *   reads Chromium's own words in them (its sandbox fallback).
 *
 * @module dish-browser/playwright
 */

import { chromium, errors } from 'playwright-core'
import type {
  Browser, BrowserContext, CDPSession, Dialog, Frame, Locator, Page, Request as PlaywrightRequest, Route, WebSocketRoute,
} from 'playwright-core'
import type { MouseButton, Viewport } from './protocol.ts'
import { DriverBadArgument, DriverClosed, DriverTimeout } from './driver.ts'
import type {
  Act, ClickTarget, DialogKind, Driver, DriverBrowser, DriverContext, DriverDialog, DriverPage, DriverPopup, FailedRequest,
  PageEvents, RouteDecider, RouteRequest, ScreencastFrame,
} from './driver.ts'
import { LOAD_MS, REF_MS, SHOT_MS } from './types.ts'

/** Chromium's start: Playwright's own default. */
const LAUNCH_MS = 30_000
/** `settle`'s first wait, for a navigation an action started to show up as a request. */
const SETTLE_FIRST_MS = 100
/** How often a popup's address is looked at. */
const POPUP_POLL_MS = 100
/** `isPassword`'s time: the element is there (its ref came from the snapshot), so this is only for a page gone stale. */
const PASSWORD_MS = 1_000
/** The most characters of Playwright's message a mapped error keeps. */
const MESSAGE_MAX = 300
/** After a navigation failed, the most it waits for Chromium's error page to commit. */
const ERROR_PAGE_MS = 1_000
/** A failed navigation that Chromium follows with its error page: any network error but these two, which show none. */
const SHOWS_ERROR_PAGE = /net::ERR_(?!ABORTED\b|INVALID_URL\b)[A-Z_]+/

/** A ref's form (`REF` in `snapshot.ts`, the form Playwright's MCP checks). The driver never builds a selector from anything else. */
const REF = /^(?:f\d+)?e\d+$/
const DIALOG_KINDS: ReadonlySet<string> = new Set<DialogKind>(['alert', 'confirm', 'prompt', 'beforeunload'])
/** Playwright's words for a page, context or browser that's gone: closed, or crashed. */
const CLOSED = ['Target page, context or browser has been closed', 'Target closed', 'Page crashed', 'Target crashed']

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The first line of Playwright's message, cut: no call log, so no element names or addresses from the page. */
function firstLine(error: unknown): string {
  return (messageOf(error).split('\n', 1)[0] ?? '').slice(0, MESSAGE_MAX)
}

/** Playwright's error as the driver's (see the module's comment). */
function driverError(error: unknown, signal?: AbortSignal): unknown {
  if (error instanceof DriverTimeout || error instanceof DriverClosed || error instanceof DriverBadArgument) return error
  if (signal?.aborted) return signal.reason
  if (error instanceof errors.TimeoutError) return new DriverTimeout(firstLine(error))
  const message = messageOf(error)
  if (CLOSED.some(words => message.includes(words))) return new DriverClosed(firstLine(error))
  if (message.includes('Unknown key')) return new DriverBadArgument('key', firstLine(error))
  if (message.includes('not a <select>')) return new DriverBadArgument('select', firstLine(error))
  if (message.includes('Element is not an <input>')) return new DriverBadArgument('fill', firstLine(error))
  return error
}

/** Runs one action: not at all when `signal` has aborted, and its errors mapped. */
async function act<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
  signal?.throwIfAborted()
  try {
    return await work()
  } catch (error) {
    throw driverError(error, signal)
  }
}

/** Swallows the error of a close on what is already closed; maps anything else. */
async function closing(work: () => Promise<unknown>): Promise<void> {
  try {
    await work()
  } catch (error) {
    const mapped = driverError(error)
    if (!(mapped instanceof DriverClosed)) throw mapped
  }
}

/**
 * `work`, or a `DriverTimeout` after `timeoutMs`, or the signal's reason when it aborts: for Playwright's mouse and
 * keyboard, which take neither. What was sent may still reach the page after the rejection.
 */
function bounded<T>(work: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      finish()
      reject(signal?.reason)
    }
    const timer = setTimeout(() => {
      finish()
      reject(new DriverTimeout(`not done within ${timeoutMs} ms`))
    }, Math.max(1, timeoutMs))
    function finish(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    work.then(value => { finish(); resolve(value) }, (error: unknown) => { finish(); reject(error) })
  })
}

/** A Playwright timeout: never 0, which Playwright reads as "no timeout". */
function ms(timeoutMs: number): number {
  return Math.max(1, Math.round(timeoutMs))
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

/** Calls a listener; one that throws mustn't break Playwright's emitter or the other listeners. */
function safely(listener: () => void): void {
  try {
    listener()
  } catch {
    // The listener's fault, not the browser's.
  }
}

/** The request's frame, or `undefined` when Playwright has none for it (`Request.frame`, :22307: a popup's first navigation, a service worker's request). */
function frameOf(request: PlaywrightRequest): Frame | undefined {
  try {
    return request.frame()
  } catch {
    return undefined
  }
}

/** Runs in the page: animation frames until the scroll position holds still for two (two at least, 30 or 1 s at most). */
function scrollSettles(): Promise<void> {
  return new Promise<void>(resolve => {
    let last = `${scrollX},${scrollY}`
    let frames = 0
    let still = 0
    const timer = setTimeout(resolve, 1_000)
    const tick = () => {
      const now = `${scrollX},${scrollY}`
      frames++
      still = now === last ? still + 1 : 0
      last = now
      if ((frames >= 2 && still >= 2) || frames >= 30) {
        clearTimeout(timer)
        resolve()
      } else {
        requestAnimationFrame(tick)
      }
    }
    requestAnimationFrame(tick)
  })
}

/** Runs in the page: whether the element is an `<input type=password>`. */
function isPasswordInput(element: { tagName: string }): boolean {
  return element.tagName === 'INPUT' && String((element as { type?: unknown }).type ?? '').toLowerCase() === 'password'
}

export const playwrightDriver: Driver = {
  async launch({ executablePath, sandbox }) {
    const browser = await chromium.launch({
      executablePath,
      chromiumSandbox: sandbox,
      headless: true,
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
      timeout: LAUNCH_MS,
    })
    return new PlaywrightBrowser(browser)
  },
}

class PlaywrightBrowser implements DriverBrowser {
  private readonly browser: Browser
  private gone = false
  private readonly listeners: Array<() => void> = []

  constructor(browser: Browser) {
    this.browser = browser
    // `disconnected` (:11052) fires once, when Chromium exits or the pipe drops, whoever caused it.
    browser.on('disconnected', () => {
      this.gone = true
      for (const listener of this.listeners.splice(0)) safely(listener)
    })
  }

  async newContext(options: { viewport: Viewport, route: RouteDecider, refuseWebSocket: (url: string) => boolean }): Promise<DriverContext> {
    const context = await act(undefined, () => this.browser.newContext({
      viewport: options.viewport,
      deviceScaleFactor: 1,
      acceptDownloads: false,
      serviceWorkers: 'block',
    }))
    const own = new PlaywrightContext(context, options.viewport)
    try {
      await context.route('**/*', (route, request) => own.decide(route, request, options.route))
      await context.routeWebSocket(url => {
        try {
          return options.refuseWebSocket(url.href)
        } catch {
          return true
        }
      }, refuseSocket)
    } catch (error) {
      await own.close().catch(() => {})
      throw driverError(error)
    }
    return own
  }

  onDisconnected(listener: () => void): void {
    if (this.gone || !this.browser.isConnected()) {
      this.gone = true
      queueMicrotask(() => safely(listener))
      return
    }
    this.listeners.push(listener)
  }

  async close(): Promise<void> {
    await closing(() => this.browser.close())
  }
}

/** A refused WebSocket: closed on the page's side before it opens (`WebSocketRoute.close`, :18549). It never reaches the server. */
async function refuseSocket(socket: WebSocketRoute): Promise<void> {
  // Awaited, so Playwright's own "open it" after the handler finds it closed already.
  await socket.close({ code: 1008, reason: 'dish' }).catch(() => {})
}

class PlaywrightContext implements DriverContext {
  private readonly context: BrowserContext
  private readonly viewport: Viewport
  /** The newest page `newPage` gave: `ownPage` in a route request. */
  private newest: Page | undefined

  constructor(context: BrowserContext, viewport: Viewport) {
    this.context = context
    this.viewport = viewport
  }

  /** The route's handler: dish decides, Playwright aborts (`Route.abort`, :22727) or lets it go on (`Route.fallback`, :22863). */
  async decide(route: Route, request: PlaywrightRequest, decider: RouteDecider): Promise<void> {
    const frame = frameOf(request)
    let mainFrame = false
    let ownPage = false
    if (frame !== undefined) {
      try {
        mainFrame = frame.parentFrame() === null
        ownPage = this.newest !== undefined && frame.page() === this.newest
      } catch {
        mainFrame = false
        ownPage = false
      }
    }
    const asked: RouteRequest = { url: request.url(), navigation: request.isNavigationRequest(), mainFrame, ownPage }
    let verdict: 'continue' | 'abort'
    try {
      verdict = await decider(asked)
    } catch {
      // A request dish couldn't check doesn't go out.
      verdict = 'abort'
    }
    try {
      if (verdict === 'abort') await route.abort('blockedbyclient')
      else await route.fallback()
    } catch {
      // The page or the context went away meanwhile.
    }
  }

  async newPage(): Promise<DriverPage> {
    const page = await act(undefined, () => this.context.newPage())
    this.newest = page
    return new PlaywrightPage(page, this.viewport)
  }

  async close(): Promise<void> {
    await closing(() => this.context.close())
  }
}

class PlaywrightPopup implements DriverPopup {
  private readonly page: Page

  constructor(page: Page) {
    this.page = page
  }

  /**
   * Polls `url()` until it isn't about:blank. A popup whose first navigation failed, or was aborted by the route, shows
   * Chromium's error page: then the address it tried to open is its history's entry (`Page.getNavigationHistory`), so
   * dish checks that, not `chrome-error://chromewebdata/`.
   */
  async waitForUrl(timeoutMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const url = this.page.url()
      if (url.startsWith('chrome-error:')) return await this.attempted() ?? url
      if (url !== '' && url !== 'about:blank') return url
      const left = deadline - Date.now()
      if (left <= 0 || this.page.isClosed()) return 'about:blank'
      await sleep(Math.min(POPUP_POLL_MS, left))
    }
  }

  /** The address of the popup's current history entry, through a CDP session of its own; `undefined` when it can't tell. */
  private async attempted(): Promise<string | undefined> {
    try {
      const session = await this.page.context().newCDPSession(this.page)
      try {
        const { currentIndex, entries } = await session.send('Page.getNavigationHistory')
        const url = entries[currentIndex]?.url ?? ''
        return url === '' || url.startsWith('chrome-error:') ? undefined : url
      } finally {
        await session.detach().catch(() => {})
      }
    } catch {
      return undefined
    }
  }

  async close(): Promise<void> {
    await closing(() => this.page.close())
  }
}

type Listener = (...args: never[]) => void

class PlaywrightPage implements DriverPage {
  private readonly page: Page
  private readonly viewport: Viewport
  private readonly listeners = new Map<keyof PageEvents, Set<Listener>>()
  /** The page's one CDP session, made on first need. */
  private cdp: Promise<CDPSession> | undefined
  private screencasting = false
  private onFrame: ((frame: ScreencastFrame) => void) | undefined
  /** For `settle`: the main frame's navigation requests that started and haven't loaded their DOM, failed or been replaced. */
  private readonly navigations = new Set<PlaywrightRequest>()
  /** For `settle`: called when one of `navigations` ends, or the page goes. */
  private readonly waiters = new Set<() => void>()

  constructor(page: Page, viewport: Viewport) {
    this.page = page
    this.viewport = viewport
    // The page's events (:986-1185), in dish's terms.
    page.on('crash', () => {
      this.ended(true)
      this.emit('crash')
    })
    page.on('close', () => this.ended(true))
    page.on('dialog', dialog => this.dialog(dialog))
    page.on('download', download => {
      // A navigation that turned into a download never loads a DOM.
      this.ended(true)
      this.emit('download', download.suggestedFilename())
    })
    // A listener makes Playwright take the chooser over, so no native one opens.
    page.on('filechooser', () => this.emit('filechooser'))
    page.on('framenavigated', frame => {
      if (frame === page.mainFrame()) this.emit('navigated', frame.url())
    })
    page.on('load', () => this.emit('load'))
    page.on('domcontentloaded', () => this.ended(true))
    page.on('popup', popup => this.emit('popup', new PlaywrightPopup(popup)))
    page.on('console', message => {
      if (message.type() === 'error') this.emit('consoleError', message.text())
    })
    page.on('pageerror', error => this.emit('consoleError', `uncaught: ${error.message}`))
    page.on('request', request => this.requested(request))
    page.on('requestfailed', request => {
      if (this.navigations.delete(request)) this.ended(false)
      const failure = request.failure()
      const failed: FailedRequest = failure === null ? { url: request.url() } : { url: request.url(), error: failure.errorText }
      this.emit('requestFailed', failed)
    })
    page.on('response', response => {
      const status = response.status()
      // 204 and 205 never commit a new document.
      if ((status === 204 || status === 205) && this.navigations.delete(response.request())) this.ended(false)
      if (status >= 400) this.emit('requestFailed', { url: response.url(), status })
    })
  }

  on<E extends keyof PageEvents>(event: E, listener: PageEvents[E]): void {
    let set = this.listeners.get(event)
    if (set === undefined) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(listener as Listener)
  }

  private emit<E extends keyof PageEvents>(event: E, ...args: Parameters<PageEvents[E]>): void {
    for (const listener of this.listeners.get(event) ?? []) safely(() => (listener as (...a: Parameters<PageEvents[E]>) => void)(...args))
  }

  /** `Dialog` (:21115) as dish's. With no listener, it is dismissed, as Playwright does with none of its own. */
  private dialog(dialog: Dialog): void {
    if ((this.listeners.get('dialog')?.size ?? 0) === 0) {
      void dialog.dismiss().catch(() => {})
      return
    }
    const type = dialog.type()
    const kind: DialogKind = DIALOG_KINDS.has(type) ? type as DialogKind : 'alert'
    const ours: DriverDialog = {
      kind,
      message: dialog.message(),
      // A dialog already answered, or a page gone, has nothing left to answer.
      accept: () => dialog.accept().catch(() => {}),
      dismiss: () => dialog.dismiss().catch(() => {}),
    }
    this.emit('dialog', ours)
  }

  /** A main-frame navigation request started: `settle` waits for it. A redirect replaces the request it came from. */
  private requested(request: PlaywrightRequest): void {
    if (!request.isNavigationRequest() || frameOf(request) !== this.page.mainFrame()) return
    const from = request.redirectedFrom()
    if (from !== null) this.navigations.delete(from)
    this.navigations.add(request)
  }

  /** A navigation ended: `all` when the main frame loaded its DOM (every earlier one is done or superseded), or the page went. */
  private ended(all: boolean): void {
    if (all) this.navigations.clear()
    for (const waiter of [...this.waiters]) waiter()
  }

  /** Resolves on the next `ended`, or after `milliseconds`. */
  private nextEnd(milliseconds: number): Promise<void> {
    return new Promise<void>(resolve => {
      const done = () => {
        clearTimeout(timer)
        this.waiters.delete(done)
        resolve()
      }
      const timer = setTimeout(done, milliseconds)
      this.waiters.add(done)
    })
  }

  private locate(ref: string): Locator {
    if (!REF.test(ref)) throw new Error('dish-browser: a ref has the form e5 or f1e5')
    return this.page.locator(`aria-ref=${ref}`)
  }

  /** The page's CDP session, made once; a failure lets the next call try again. */
  private session(): Promise<CDPSession> {
    if (this.cdp === undefined) {
      const made = this.page.context().newCDPSession(this.page)
      this.cdp = made
      made.catch(() => {
        if (this.cdp === made) this.cdp = undefined
      })
    }
    return this.cdp
  }

  /**
   * A navigation, and after one that failed, Chromium's error page. Playwright rejects as soon as the load fails, and
   * Chromium commits `chrome-error://chromewebdata/` just after: a navigation started meanwhile would be "interrupted by
   * another navigation to chrome-error://chromewebdata/", and a snapshot would read a page between documents. So the
   * rejection waits, up to `ERROR_PAGE_MS`, for the error page's DOM. It rejects with the navigation's own error.
   */
  private async navigation<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work()
    } catch (error) {
      if (SHOWS_ERROR_PAGE.test(messageOf(error)) && !this.page.isClosed()) {
        const deadline = Date.now() + ERROR_PAGE_MS
        while (!this.page.url().startsWith('chrome-error:') && Date.now() < deadline && !this.page.isClosed()) await sleep(20)
        const left = deadline - Date.now()
        if (left > 0) await this.page.waitForLoadState('domcontentloaded', { timeout: left }).catch(() => {})
      }
      throw error
    }
  }

  /** After a navigation committed its DOM: up to `loadMs` more for `load` (`waitForLoadState`, :5552), a timeout swallowed. */
  private async loaded(loadMs: number, signal: AbortSignal | undefined): Promise<void> {
    if (loadMs <= 0) return
    try {
      await this.page.waitForLoadState('load', { timeout: ms(loadMs), signal })
    } catch (error) {
      if (!(error instanceof errors.TimeoutError)) throw error
    }
  }

  url(): string {
    return this.page.url()
  }

  title(): Promise<string> {
    return act(undefined, () => this.page.title())
  }

  history(): Promise<{ canGoBack: boolean, canGoForward: boolean }> {
    return act(undefined, async () => {
      const session = await this.session()
      const { currentIndex, entries } = await session.send('Page.getNavigationHistory')
      return { canGoBack: currentIndex > 0, canGoForward: currentIndex < entries.length - 1 }
    })
  }

  goto(url: string, { timeoutMs, loadMs, signal }: Act & { loadMs: number }): Promise<void> {
    return act(signal, async () => {
      await this.navigation(() => this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: ms(timeoutMs), signal }))
      await this.loaded(loadMs, signal)
    })
  }

  back(options: Act): Promise<boolean> {
    return this.traverse('back', options)
  }

  forward(options: Act): Promise<boolean> {
    return this.traverse('forward', options)
  }

  /**
   * `goBack` or `goForward` (:3403, :3451). Playwright answers `null` both when there is no such entry and for a
   * same-document move (a fragment, `pushState`), so `null` means "none" only when the page's address didn't change.
   */
  private traverse(way: 'back' | 'forward', { timeoutMs, signal }: Act): Promise<boolean> {
    return act(signal, async () => {
      const before = this.page.url()
      const options = { waitUntil: 'domcontentloaded' as const, timeout: ms(timeoutMs), signal }
      const response = await this.navigation(() => way === 'back' ? this.page.goBack(options) : this.page.goForward(options))
      if (response === null && this.page.url() === before) return false
      await this.loaded(LOAD_MS, signal)
      return true
    })
  }

  reload({ timeoutMs, signal }: Act): Promise<void> {
    return act(signal, async () => {
      await this.navigation(() => this.page.reload({ waitUntil: 'domcontentloaded', timeout: ms(timeoutMs), signal }))
      await this.loaded(LOAD_MS, signal)
    })
  }

  /** `ariaSnapshot({ mode: 'ai' })` of the page (:2101) or of one ref (:14517). */
  snapshot({ ref, timeoutMs, signal }: Act & { ref?: string }): Promise<string> {
    return act(signal, () => {
      const options = { mode: 'ai' as const, timeout: ms(timeoutMs), signal }
      return ref ? this.locate(ref).ariaSnapshot(options) : this.page.ariaSnapshot(options)
    })
  }

  /** `count()` (:15021) doesn't wait. A ref of a frame that's gone is an invalid selector; a page between documents has no refs. */
  async hasRef(ref: string): Promise<boolean> {
    if (!REF.test(ref)) return false
    try {
      return await this.page.locator(`aria-ref=${ref}`).count() > 0
    } catch (error) {
      const message = messageOf(error)
      if (message.includes('Invalid frame in aria-ref') || message.includes('Execution context was destroyed')) return false
      throw driverError(error)
    }
  }

  isPassword(ref: string): Promise<boolean> {
    return act(undefined, () => this.locate(ref).evaluate(isPasswordInput, undefined, { timeout: PASSWORD_MS }))
  }

  /** A ref: `click` or `dblclick` (:14897, :15046). A point: `mouse.click` (:22094), two clicks for a double. */
  click(target: ClickTarget, { double, timeoutMs, signal }: Act & { double: boolean }): Promise<void> {
    return act(signal, async () => {
      if ('ref' in target) {
        const locator = this.locate(target.ref)
        if (double) await locator.dblclick({ timeout: ms(timeoutMs), signal })
        else await locator.click({ timeout: ms(timeoutMs), signal })
        return
      }
      await bounded(this.page.mouse.click(target.x, target.y, { clickCount: double ? 2 : 1 }), timeoutMs, signal)
    })
  }

  fill(ref: string, text: string, { timeoutMs, signal }: Act): Promise<void> {
    return act(signal, () => this.locate(ref).fill(text, { timeout: ms(timeoutMs), signal }))
  }

  type(text: string, { timeoutMs, signal }: Act): Promise<void> {
    return act(signal, () => bounded(this.page.keyboard.type(text), timeoutMs, signal))
  }

  press(key: string, { ref, timeoutMs, signal }: Act & { ref?: string }): Promise<void> {
    return act(signal, () => ref
      ? this.locate(ref).press(key, { timeout: ms(timeoutMs), signal })
      : bounded(this.page.keyboard.press(key), timeoutMs, signal))
  }

  select(ref: string, values: string[], { timeoutMs, signal }: Act): Promise<string[]> {
    return act(signal, () => this.locate(ref).selectOption(values, { timeout: ms(timeoutMs), signal }))
  }

  scrollIntoView(ref: string, { timeoutMs, signal }: Act): Promise<void> {
    return act(signal, () => this.locate(ref).scrollIntoViewIfNeeded({ timeout: ms(timeoutMs), signal }))
  }

  /** The wheel at the viewport's centre (`mouse.wheel` doesn't wait for the scroll, :22189), then frames until it lands. */
  async scrollBy(dx: number, dy: number): Promise<void> {
    await act(undefined, async () => {
      const size = this.page.viewportSize() ?? this.viewport
      await bounded(this.page.mouse.move(size.width / 2, size.height / 2), REF_MS)
      await bounded(this.page.mouse.wheel(dx, dy), REF_MS)
    })
    // A page that navigated meanwhile has nothing left to wait for.
    await this.page.evaluate(scrollSettles).catch(() => {})
  }

  scrollPosition(): Promise<{ y: number, height: number }> {
    return act(undefined, async () => {
      const { y, height } = await this.page.evaluate(() => ({ y: scrollY, height: document.documentElement?.scrollHeight ?? 0 }))
      return { y: Math.round(y), height: Math.round(height) }
    })
  }

  /** The first element with the text, visible or gone (`getByText` :3353, `waitFor` :17266). Main frame only. */
  waitForText(text: string, { gone, timeoutMs, signal }: Act & { gone: boolean }): Promise<void> {
    return act(signal, () => this.page.getByText(text).first().waitFor({ state: gone ? 'hidden' : 'visible', timeout: ms(timeoutMs), signal }))
  }

  /** A PNG of the viewport (:4563) or of one ref's element (:16617). */
  screenshot({ ref, timeoutMs, signal }: Act & { ref?: string }): Promise<Uint8Array> {
    return act(signal, () => {
      const options = { type: 'png' as const, timeout: ms(timeoutMs), signal }
      return ref ? this.locate(ref).screenshot(options) : this.page.screenshot(options)
    })
  }

  /**
   * Waits `SETTLE_FIRST_MS` for a navigation the action started to show up as a request; then, while one is under way
   * and time is left, for it to load its DOM. A navigation that fails, is aborted, turns into a download, or answers
   * 204 or 205 isn't waited for; one still under way when time runs out is let go, so it never holds up a later
   * settle. It never rejects.
   */
  async settle(milliseconds: number): Promise<void> {
    const deadline = Date.now() + milliseconds
    await sleep(Math.max(0, Math.min(SETTLE_FIRST_MS, milliseconds)))
    while (this.navigations.size > 0 && !this.page.isClosed()) {
      const left = deadline - Date.now()
      if (left <= 0) break
      await this.nextEnd(left)
    }
    this.navigations.clear()
  }

  /** CDP's screencast (`Page.startScreencast`, protocol.d.ts:16209): each frame acked at once, then given to `onFrame`. */
  startScreencast(options: { quality: number, maxWidth: number, maxHeight: number }, onFrame: (frame: ScreencastFrame) => void): Promise<void> {
    return act(undefined, async () => {
      const session = await this.session()
      if (!this.screencasting) {
        this.screencasting = true
        session.on('Page.screencastFrame', event => {
          void session.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {})
          const deliver = this.onFrame
          if (deliver === undefined) return
          // The metadata's size is the viewport's, in CSS pixels (protocol.d.ts:14571).
          const frame = { data: event.data, width: Math.round(event.metadata.deviceWidth), height: Math.round(event.metadata.deviceHeight) }
          safely(() => deliver(frame))
        })
      }
      this.onFrame = onFrame
      try {
        await session.send('Page.startScreencast', {
          format: 'jpeg',
          quality: options.quality,
          maxWidth: options.maxWidth,
          maxHeight: options.maxHeight,
          everyNthFrame: 1,
        })
      } catch (error) {
        if (this.onFrame === onFrame) this.onFrame = undefined
        throw error
      }
    })
  }

  /** No frame reaches the listener once this is called. Stopping a page that's gone is done already. */
  async stopScreencast(): Promise<void> {
    this.onFrame = undefined
    if (this.cdp === undefined) return
    await closing(async () => {
      const session = await this.session()
      await session.send('Page.stopScreencast')
    })
  }

  capture(quality: number): Promise<ScreencastFrame> {
    return act(undefined, async () => {
      const image = await this.page.screenshot({ type: 'jpeg', quality, timeout: SHOT_MS })
      const size = this.page.viewportSize() ?? this.viewport
      return { data: image.toString('base64'), width: size.width, height: size.height }
    })
  }

  /** The user's pointer: a move, then a button down or up (`Mouse`, :22137-22167). */
  mouse(action: 'down' | 'up' | 'move', x: number, y: number, button: MouseButton, clickCount: number): Promise<void> {
    return act(undefined, async () => {
      await bounded(this.page.mouse.move(x, y), REF_MS)
      if (action === 'down') await bounded(this.page.mouse.down({ button, clickCount }), REF_MS)
      else if (action === 'up') await bounded(this.page.mouse.up({ button, clickCount }), REF_MS)
    })
  }

  wheel(x: number, y: number, dx: number, dy: number): Promise<void> {
    return act(undefined, async () => {
      await bounded(this.page.mouse.move(x, y), REF_MS)
      await bounded(this.page.mouse.wheel(dx, dy), REF_MS)
    })
  }

  /** `Keyboard.down` and `up` (:21913, :22019) know Playwright's US layout; a character outside it is `insertText`'s. */
  keyDown(key: string): Promise<void> {
    return act(undefined, () => bounded(this.page.keyboard.down(key), REF_MS))
  }

  keyUp(key: string): Promise<void> {
    return act(undefined, () => bounded(this.page.keyboard.up(key), REF_MS))
  }

  insertText(text: string): Promise<void> {
    return act(undefined, () => bounded(this.page.keyboard.insertText(text), REF_MS))
  }

  async close(): Promise<void> {
    this.onFrame = undefined
    await closing(() => this.page.close())
  }
}
