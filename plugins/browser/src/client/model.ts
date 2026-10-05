/**
 * What the Browser tab shows, and how each item of the `watch` stream changes it. Plain TypeScript: no React and no DOM, so
 * `node --test` runs it (`test/client-model.test.ts`).
 *
 * Everything here that came from the host (the URL, the title, a reason, a notice, a child's label) is text, and the views
 * render it as text. The one thing that becomes an attribute that loads is the frame, and only as a JPEG data source built
 * here from base64 checked here.
 */

import type { BrowserStatus, ChildBrowser, Down, FrameDown, StateDown, Viewport } from '../protocol.ts'

export interface TabFrame {
  seq: number
  /** `data:image/jpeg;base64,…` */
  src: string
  width: number
  height: number
}

export interface TabState {
  /** `connecting` until the first `hello`; `down` while the carrier is lost, until the next generation's `hello`. */
  connection: 'connecting' | 'live' | 'down'
  /** `unknown` until the first `state`. */
  status: BrowserStatus | 'unknown'
  /** For `closed`, `unavailable` and `refused`, the host's words; otherwise ''. */
  reason: string
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  acting: boolean
  canStart: boolean
  sandboxOff: boolean
  viewport: Viewport
  /** The newest picture. An open browser's, or a closed one's last, shown dimmed. */
  frame?: TabFrame
  children: ChildBrowser[]
  /** The newest notice, until it is dismissed. */
  notice?: string
}

export const INITIAL: TabState = {
  connection: 'connecting',
  status: 'unknown',
  reason: '',
  url: '',
  title: '',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  acting: false,
  canStart: false,
  sandboxOff: false,
  viewport: { width: 1280, height: 800 },
  children: [],
}

/** The most characters of the page's title the tab's chip shows. */
export const TITLE_MAX = 40

/** What base64 is: the frame's data must be nothing else, so its source can only ever be a JPEG's data. */
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

/** Apply one item of the stream. An item of a kind the tab doesn't know, or a frame it can't draw, changes nothing. */
export function reduce(state: TabState, down: Down): TabState {
  switch (down.kind) {
    case 'hello':
      return { ...state, connection: 'live' }
    case 'state':
      return applyState(state, down)
    case 'frame':
      return applyFrame(state, down)
    case 'children':
      return { ...state, children: down.children }
    case 'notice':
      return { ...state, notice: down.text }
    default:
      return state
  }
}

function applyState(state: TabState, down: StateDown): TabState {
  const next: TabState = {
    ...state,
    status: down.status,
    reason: down.reason,
    url: down.url,
    title: down.title,
    loading: down.loading,
    canGoBack: down.canGoBack,
    canGoForward: down.canGoForward,
    acting: down.acting,
    canStart: down.canStart,
    sandboxOff: down.sandboxOff,
    viewport: down.viewport,
  }
  // The picture is the open browser's, and a closed one keeps its last. A browser that is gone (`none`), a host without one,
  // a refusal, and a new browser after a closed one start without it.
  const keep = down.status === 'open' ? state.status !== 'closed' : down.status === 'closed'
  if (!keep) delete next.frame
  return next
}

function applyFrame(state: TabState, down: FrameDown): TabState {
  if (typeof down.data !== 'string' || !BASE64.test(down.data)) return state
  if (!positive(down.width) || !positive(down.height) || !Number.isFinite(down.seq)) return state
  return { ...state, frame: { seq: down.seq, src: 'data:image/jpeg;base64,' + down.data, width: down.width, height: down.height } }
}

function positive(value: number): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/**
 * The tab's chip: "Browser", or "Browser · <the page's title>" with the title cut to `TITLE_MAX` characters.
 * @param title - the page's title, '' for none.
 */
export function titleText(title: string): string {
  const trimmed = title.trim()
  return trimmed === '' ? 'Browser' : `Browser · ${cut(trimmed, TITLE_MAX)}`
}

/**
 * `text`, or its first `max - 1` characters and an ellipsis when it is longer, never splitting a pair of UTF-16 halves.
 * @param text - what to cut.
 * @param max - the most characters the answer has.
 */
export function cut(text: string, max: number): string {
  if (text.length <= max) return text
  let end = max - 1
  if (end > 0 && /[\uD800-\uDBFF]/.test(text.charAt(end - 1))) end--
  return `${text.slice(0, end)}…`
}
