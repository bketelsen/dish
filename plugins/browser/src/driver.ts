/**
 * What dish needs of a browser engine. Only `src/playwright.ts` implements it for real; the tests use a fake.
 *
 * @module dish-browser/driver
 */

import type { MouseButton, Viewport } from './protocol.ts'

/** An action didn't finish in its time. */
export class DriverTimeout extends Error {}

/** The page, the context or the browser is gone. */
export class DriverClosed extends Error {}

/** Playwright refused the argument: an unknown key, an element that isn't a <select>, or one that isn't fillable. */
export class DriverBadArgument extends Error {
  what: 'key' | 'select' | 'fill'
  constructor(what: 'key' | 'select' | 'fill', message: string) { super(message); this.what = what }
}

export interface Driver {
  /** Start Chromium. `sandbox` is Chromium's own sandbox. Rejects with Chromium's error when it won't start. */
  launch(options: { executablePath: string, sandbox: boolean }): Promise<DriverBrowser>
}

export interface DriverBrowser {
  /** A new context with one viewport, downloads off, service workers allowed (their requests go through `route` too), every request decided by `route`, and WebSockets to `refuseWebSocket`'s URLs refused. */
  newContext(options: { viewport: Viewport, route: RouteDecider, refuseWebSocket: (url: string) => boolean }): Promise<DriverContext>
  /** Called once when Chromium exits or the connection drops, whoever caused it. */
  onDisconnected(listener: () => void): void
  close(): Promise<void>
}

export interface RouteRequest { url: string, navigation: boolean, mainFrame: boolean, ownPage: boolean }
export type RouteDecider = (request: RouteRequest) => Promise<'continue' | 'abort'>

export interface DriverContext {
  /** The context's page; `ownPage` in a route request is true for the newest one this gave. */
  newPage(): Promise<DriverPage>
  close(): Promise<void>
}

export type DialogKind = 'alert' | 'confirm' | 'prompt' | 'beforeunload'
export interface DriverDialog { kind: DialogKind, message: string, accept(): Promise<void>, dismiss(): Promise<void> }

export interface DriverPopup {
  /** The popup's first URL other than about:blank, or 'about:blank' after `timeoutMs`. */
  waitForUrl(timeoutMs: number): Promise<string>
  close(): Promise<void>
}

export interface FailedRequest { url: string, error?: string, status?: number }

export interface PageEvents {
  crash: () => void
  dialog: (dialog: DriverDialog) => void
  download: (name: string) => void
  filechooser: () => void
  /** The main frame committed a navigation. */
  navigated: (url: string) => void
  /** The main frame's load event. */
  load: () => void
  popup: (popup: DriverPopup) => void
  /** A `console.error`, or an uncaught exception as 'uncaught: <message>'. */
  consoleError: (text: string) => void
  /** A network error, or a response of 400 and up. */
  requestFailed: (request: FailedRequest) => void
}

export interface ScreencastFrame { data: string, width: number, height: number }
export type ClickTarget = { ref: string } | { x: number, y: number }
export interface Act { timeoutMs: number, signal?: AbortSignal }

export interface DriverPage {
  on<E extends keyof PageEvents>(event: E, listener: PageEvents[E]): void
  url(): string
  title(): Promise<string>
  history(): Promise<{ canGoBack: boolean, canGoForward: boolean }>
  /** Up to `timeoutMs` for DOMContentLoaded, then up to `loadMs` more for load. Rejects with Playwright's message (`net::ERR_…`), or DriverTimeout. */
  goto(url: string, options: Act & { loadMs: number }): Promise<void>
  /** Resolves false when there is no earlier entry. */
  back(options: Act): Promise<boolean>
  /** Resolves false when there is no later entry. */
  forward(options: Act): Promise<boolean>
  reload(options: Act): Promise<void>
  /** The page's aria snapshot in `ai` mode, or one ref's subtree. */
  snapshot(options: Act & { ref?: string }): Promise<string>
  /** Whether `ref` resolves to an element now, without waiting; false for a ref of a frame that's gone. */
  hasRef(ref: string): Promise<boolean>
  /** Whether `ref` is an <input type=password>. Rejects when it can't tell. */
  isPassword(ref: string): Promise<boolean>
  click(target: ClickTarget, options: Act & { double: boolean }): Promise<void>
  fill(ref: string, text: string, options: Act): Promise<void>
  /** Types `text` into the focused element. */
  type(text: string, options: Act): Promise<void>
  press(key: string, options: Act & { ref?: string }): Promise<void>
  /** Resolves with the values chosen. */
  select(ref: string, values: string[], options: Act): Promise<string[]>
  scrollIntoView(ref: string, options: Act): Promise<void>
  scrollBy(dx: number, dy: number): Promise<void>
  scrollPosition(): Promise<{ y: number, height: number }>
  waitForText(text: string, options: Act & { gone: boolean }): Promise<void>
  /** A PNG of the viewport, or of one ref's element. */
  screenshot(options: Act & { ref?: string }): Promise<Uint8Array>
  /** After an action: wait up to `ms` for a main-frame navigation that started to load its DOM. */
  settle(ms: number): Promise<void>
  startScreencast(options: { quality: number, maxWidth: number, maxHeight: number }, onFrame: (frame: ScreencastFrame) => void): Promise<void>
  stopScreencast(): Promise<void>
  /** One JPEG of the viewport, taken now. */
  capture(quality: number): Promise<ScreencastFrame>
  mouse(action: 'down' | 'up' | 'move', x: number, y: number, button: MouseButton, clickCount: number): Promise<void>
  wheel(x: number, y: number, dx: number, dy: number): Promise<void>
  keyDown(key: string): Promise<void>
  keyUp(key: string): Promise<void>
  insertText(text: string): Promise<void>
  close(): Promise<void>
}
