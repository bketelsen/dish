/**
 * The Browser tab's wire: what the host's `watch` stream sends down (`Down`) and what the tab sends up its uplink (`Up`).
 *
 * Browser-safe: it imports nothing, so the host and the client both use it.
 *
 * @module dish-browser/protocol
 */

/** The remote's wire namespace. */
export const NAMESPACE = 'dishBrowser'
/** The most frames a second that go to one watcher. */
export const FRAME_RATE = 15
/** The most characters in one `text` item. */
export const TEXT_MAX = 10_000
/** The most characters in an address. */
export const URL_MAX = 4096
// The bits of a `key` item's `modifiers`. They are CDP's values. The core reads them to release any modifier key the tab
// no longer holds; the page's own key presses carry no modifiers.
/** The `modifiers` bit for Alt. */
export const ALT = 1
/** The `modifiers` bit for Control. */
export const CONTROL = 2
/** The `modifiers` bit for Meta (Command on a Mac). */
export const META = 4
/** The `modifiers` bit for Shift. */
export const SHIFT = 8

export interface Viewport { width: number, height: number }
export type MouseButton = 'left' | 'middle' | 'right'
export type BrowserStatus = 'none' | 'open' | 'closed' | 'unavailable' | 'refused'

/** Always the first item of a stream. */
export interface HelloDown { kind: 'hello', watchId: string }

export interface StateDown {
  kind: 'state'
  status: BrowserStatus
  /** For `closed`, `unavailable` and `refused`, the reason in dish's words; otherwise ''. */
  reason: string
  /** The page's address, masked; '' when there is no page. */
  url: string
  /** The page's title, masked; '' when there is none. */
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  /** Whether an agent's call is running on this browser. */
  acting: boolean
  /** Whether the address bar may start a browser here: there is no browser, and the session's agent is live. */
  canStart: boolean
  /** Whether Chromium runs without its own sandbox. */
  sandboxOff: boolean
  viewport: Viewport
}

/** One frame of the picture: `data` is a base64 JPEG. */
export interface FrameDown { kind: 'frame', seq: number, data: string, width: number, height: number }
export interface ChildBrowser { sessionId: string, label: string }
export interface ChildrenDown { kind: 'children', children: ChildBrowser[] }
export interface NoticeDown { kind: 'notice', text: string }
export type Down = HelloDown | StateDown | FrameDown | ChildrenDown | NoticeDown

export type Up =
  | { kind: 'frames', on: boolean }
  | { kind: 'ack', seq: number }
  | { kind: 'navigate', url: string }
  | { kind: 'back' } | { kind: 'forward' } | { kind: 'reload' } | { kind: 'close' }
  | { kind: 'mouse', action: 'down' | 'up' | 'move', x: number, y: number, button: MouseButton, clickCount: number }
  | { kind: 'wheel', x: number, y: number, dx: number, dy: number }
  | { kind: 'key', action: 'down' | 'up', key: string, code: string, modifiers: number }
  | { kind: 'text', text: string }
