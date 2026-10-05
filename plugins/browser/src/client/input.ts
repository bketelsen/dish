/**
 * The picture's input, as plain functions of an event's fields: how the frame is sized to the pane, where a point lands in
 * the page, which button and modifiers it carries, what a key becomes, and what a paste becomes. No DOM types here, so
 * `node --test` runs it (`test/client-input.test.ts`); `Picture.tsx` calls these from its handlers.
 *
 * The uplink is small (dsh buffers at most 256 KiB a stream), so the picture sends a `move` only while a button is down and at
 * most every `MOVE_INTERVAL_MS`, coalesces wheel turns the same way, and cuts a paste to `TEXT_MAX`.
 */

import { ALT, CONTROL, META, SHIFT, TEXT_MAX } from '../protocol.ts'
import type { MouseButton, Up, Viewport } from '../protocol.ts'

/** The least time between two `move` (or `wheel`) items: 30 a second. */
export const MOVE_INTERVAL_MS = 33
/** The longest `code` a key item carries: a real one is far shorter. */
export const CODE_MAX = 32
/** Pixels a wheel "line" scrolls, as Chromium counts one. */
export const LINE_PIXELS = 40

/** Where the image is drawn, in client coordinates. */
export interface Box { left: number, top: number, width: number, height: number }

/**
 * The size to draw a frame at: as large as the room allows, keeping its shape, in whole pixels.
 * @param room - the pane's room for the picture.
 * @param frame - the frame's size.
 */
export function fit(room: { width: number, height: number }, frame: Viewport): { width: number, height: number } {
  if (![room.width, room.height, frame.width, frame.height].every(value => Number.isFinite(value) && value > 0)) return { width: 0, height: 0 }
  const scale = Math.min(room.width / frame.width, room.height / frame.height)
  return {
    width: Math.max(0, Math.min(Math.floor(room.width), Math.round(frame.width * scale))),
    height: Math.max(0, Math.min(Math.floor(room.height), Math.round(frame.height * scale))),
  }
}

/**
 * The page's point for a point in the drawn image: `x × viewportWidth / drawnWidth`, and the same for y, clamped to the page's
 * last pixel. A point outside the image (its edges are inside) is `undefined`.
 * @param clientX - the event's client x.
 * @param clientY - the event's client y.
 * @param drawn - where the image is drawn.
 * @param viewport - the page's size.
 */
export function toViewport(clientX: number, clientY: number, drawn: Box, viewport: Viewport): { x: number, y: number } | undefined {
  if (!Number.isFinite(clientX) || !Number.isFinite(clientY) || !(drawn.width > 0) || !(drawn.height > 0)) return undefined
  const dx = clientX - drawn.left
  const dy = clientY - drawn.top
  if (dx < 0 || dy < 0 || dx > drawn.width || dy > drawn.height) return undefined
  return {
    x: clamp(dx * viewport.width / drawn.width, 0, Math.max(0, viewport.width - 1)),
    y: clamp(dy * viewport.height / drawn.height, 0, Math.max(0, viewport.height - 1)),
  }
}

/** A pointer button's number as the page knows it; `undefined` for the back and forward buttons and anything else. */
export function buttonOf(button: number): MouseButton | undefined {
  return button === 0 ? 'left' : button === 1 ? 'middle' : button === 2 ? 'right' : undefined
}

/** A mouse event's `detail` (its click count) as an item carries it: 1 to 3. */
export function clickCountOf(detail: number): number {
  return Number.isFinite(detail) ? clamp(Math.trunc(detail), 1, 3) : 1
}

/** The modifier keys held, as CDP's bits (`ALT`, `CONTROL`, `META`, `SHIFT`). */
export function modifiersOf(e: { altKey: boolean, ctrlKey: boolean, metaKey: boolean, shiftKey: boolean }): number {
  return (e.altKey ? ALT : 0) | (e.ctrlKey ? CONTROL : 0) | (e.metaKey ? META : 0) | (e.shiftKey ? SHIFT : 0)
}

/** The fields of a key event the tab reads. */
export interface KeyLike { key: string, code: string, isComposing: boolean, altKey: boolean, ctrlKey: boolean, metaKey: boolean, shiftKey: boolean }

/** `key` values that aren't a key yet: an accent waiting for its letter, a key with no name, and an input method at work. */
const NOT_KEYS = new Set(['', 'Dead', 'Unidentified', 'Process'])

/** The `key` item for a key event; undefined while composing, and for `Dead`, `Unidentified` and `Process`. */
export function keyMessage(e: KeyLike, action: 'down' | 'up'): Up | undefined {
  if (e.isComposing || NOT_KEYS.has(e.key)) return undefined
  return { kind: 'key', action, key: e.key, code: e.code.slice(0, CODE_MAX), modifiers: modifiersOf(e) }
}

/**
 * Whether a key event is a paste: Ctrl+V, or Cmd+V (with Shift too, the plain-text paste). The key's own letter decides; on a
 * layout whose V key types a letter outside A–Z, its place does.
 */
export function isPaste(e: KeyLike): boolean {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return false
  const letter = e.key.toLowerCase()
  if (letter === 'v') return true
  return e.code === 'KeyV' && !/^[a-z]$/.test(letter)
}

/** The `text` of a paste or a composition: undefined for none, and cut to `TEXT_MAX` without splitting a pair of UTF-16 halves. */
export function pasteText(text: string): string | undefined {
  if (text === '') return undefined
  if (text.length <= TEXT_MAX) return text
  let end = TEXT_MAX
  if (/[\uD800-\uDBFF]/.test(text.charAt(end - 1))) end--
  return text.slice(0, end)
}

/**
 * A wheel turn in pixels: a line is `LINE_PIXELS`, a page the viewport.
 * @param e - the wheel event's deltas and their unit (`deltaMode`: 0 pixels, 1 lines, 2 pages).
 * @param viewport - the page's size.
 */
export function wheelPixels(e: { deltaX: number, deltaY: number, deltaMode: number }, viewport: Viewport): { dx: number, dy: number } {
  const unitX = e.deltaMode === 1 ? LINE_PIXELS : e.deltaMode === 2 ? viewport.width : 1
  const unitY = e.deltaMode === 1 ? LINE_PIXELS : e.deltaMode === 2 ? viewport.height : 1
  return { dx: finite(e.deltaX) * unitX, dy: finite(e.deltaY) * unitY }
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value))
}
