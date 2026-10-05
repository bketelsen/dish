/**
 * The host's shared shapes and constants.
 *
 * @module dish-browser/types
 */

import type { DialogKind } from './driver.ts'

// Times are in milliseconds, except WAIT_MAX_S, which is in seconds.
// NAV_MS: a navigation's wait for DOMContentLoaded. LOAD_MS: the wait for load after it. REF_MS: a ref action's time.
// SETTLE_MS: the wait, after a click, type, press or select, for a navigation it started. WAIT_MAX_S: the longest
// `browser_wait`. SHOT_MS: a screenshot's time.
export const NAV_MS = 30_000, LOAD_MS = 3_000, REF_MS = 5_000, SETTLE_MS = 3_000, WAIT_MAX_S = 30, SHOT_MS = 10_000
// JPEG_QUALITY: the picture's frames. LINGER_MS: how long Chromium stays up after the last browser closes. USING_NOW_MS:
// the user's input this recent means they are using the browser now. CAP_WAIT_MS: the longest a call waits at the cap
// while every browser is acting. SWEEP_MS: how often the sweep runs.
export const JPEG_QUALITY = 60, LINGER_MS = 60_000, USING_NOW_MS = 10_000, CAP_WAIT_MS = 30_000, SWEEP_MS = 60_000
// POPUP_URL_MS: the wait for a popup's first address. STOP_MS: the longest the plugin's stop waits. LOG_RING: the console
// errors, and the failed requests, kept per browser. LISTED: the most of either a result lists. LINE_MAX: the characters
// kept of one line a result shows. PASSWORD_CHECKS: the most textboxes on a page checked for a password field.
export const POPUP_URL_MS = 2_000, STOP_MS = 5_000, LOG_RING = 100, LISTED = 10, LINE_MAX = 300, PASSWORD_CHECKS = 200

export interface OwnAddress { port: number | undefined, trustedHost: string | undefined }

export interface UrlPlaces {
  /** The session's workspace root, when dish knows it. */
  workspace: string | undefined
  /** Whether /tmp counts: dsh's TMPDIR is outside /tmp, as on the VM. */
  sharedTmp: boolean
  own: OwnAddress
}

/** `what` is short (a scheme, a path, "dsh's own address"); `reason` is the refusal, in dish's words. */
export type UrlCheck = { ok: true, url: string } | { ok: false, what: string, reason: string }

export interface UrlRules {
  /** What the agent or the address bar typed: made a URL, then checked. */
  resolve(input: string, places: UrlPlaces): Promise<UrlCheck>
  /** A URL the page went to or asked for. `from: 'page'` lets Chromium's error page through. */
  check(url: string, places: UrlPlaces, from: 'typed' | 'page'): Promise<UrlCheck>
  /** Whether `url` is dsh's own address. Sync: for WebSockets. */
  own(url: string, own: OwnAddress): boolean
}

export type CloseReason = 'agent' | 'archived' | 'idle' | 'evicted' | 'tab' | 'chromium' | 'stopped'
export type PopupOutcome = 'followed' | 'refused' | 'blank'

export type Note =
  | { kind: 'dialog', dialog: DialogKind, message: string, accepted: boolean }
  | { kind: 'popup', url: string, outcome: PopupOutcome, what?: string }
  | { kind: 'download', name: string }
  | { kind: 'filechooser' }
  | { kind: 'blocked', what: string }
  | { kind: 'crashed' }
  /** The page stopped answering (a script that never ends), and dish replaced it with a new one in the same context. */
  | { kind: 'frozen' }
  /** This browser is new: the last one closed for `reason`. */
  | { kind: 'reopened', reason: CloseReason }

export interface UserActivity {
  /** Whether the user started this browser from the address bar. */
  started: boolean
  /** The URLs the user's opening, back, forward and reload landed on: the first 5. */
  navigations: string[]
  moreNavigations: number
  clicks: number
  typed: boolean
  keys: boolean
  scrolled: boolean
  /** When the newest input came, in ms. */
  last: number
}

export type BrowserErrorCode = 'unavailable' | 'wont-start' | 'busy' | 'closed' | 'crashed' | 'frozen'

export type TabNotice =
  | Note
  | { kind: 'refused', reason: string }
  | { kind: 'failed', url: string, error: string }
  | { kind: 'error', code: BrowserErrorCode, detail: string }
  | { kind: 'cannot-start' }

export interface Limits { maxBrowsers: number, idleMinutes: number }
export interface Frame { seq: number, data: string, width: number, height: number }
