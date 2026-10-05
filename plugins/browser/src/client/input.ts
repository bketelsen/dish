/**
 * The picture's input, as plain functions of an event's fields: how the frame is sized to the pane, where a point lands in
 * the page, which button and modifiers it carries, what a key becomes, and what a paste becomes. No DOM types here, so
 * `node --test` runs it (`test/client-input.test.ts`); `Picture.tsx` calls these from its handlers.
 *
 * The uplink is small (dsh buffers at most 256 KiB a stream), so a paste is cut to `TEXT_MAX`, and the pacer
 * (`createInputPacer`, over a clock a test can move) sends a `move` only while a button is down and at most every
 * `MOVE_INTERVAL_MS`, sums wheel turns the same way, and releases what the picture holds down when it loses focus.
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

// --- the uplink's pace ------------------------------------------------------------------------------

/** What the pacer reads the time from and sets its timers on; a test passes one it moves by hand. */
export interface PaceClock {
  now(): number
  /** Run `run` after `ms`; the answer cancels it. */
  later(run: () => void, ms: number): () => void
}

export const systemClock: PaceClock = {
  now: () => Date.now(),
  later: (run, ms) => {
    const timer = setTimeout(run, ms)
    return () => { clearTimeout(timer) }
  },
}

/** A point in the page. */
export interface Point { x: number, y: number }

export type KeyItem = Extract<Up, { kind: 'key' }>

/**
 * What the picture's handlers feed, and what decides what goes up the uplink and when. Points are the page's (`toViewport`).
 * After `dispose`, nothing goes.
 */
export interface InputPacer {
  /** A button went down: a `move` to the point, then the `down`. Ignored while a button is held. */
  press(point: Point, button: MouseButton, clickCount: number): void
  /** The pointer moved: a `move` only while a button is held, at most every `MOVE_INTERVAL_MS`, the newest kept. `undefined` (outside the image) is ignored. */
  move(point: Point | undefined): void
  /** `button` went up at `point`, or outside the image (`undefined`): a `move` to where it ends when that isn't where the last one went, then the `up` with the press's click count. Another button's release is ignored. */
  release(button: MouseButton, point: Point | undefined): void
  /** Whether a button is held. */
  holding(): boolean
  /** A wheel turn: turns are summed, and go at most every `MOVE_INTERVAL_MS`, at the newest point; turns that cancel out send nothing. */
  wheel(point: Point, dx: number, dy: number): void
  /** A key went down (`id` is its code, or its key when it has no code): sent, and remembered. */
  keyDown(id: string, item: KeyItem): void
  /** A key went up: sent only if it went down here, as `item`, or in the words of its down when `item` is undefined. The answer says whether it went. */
  keyUp(id: string, item: KeyItem | undefined): boolean
  /** Focus left, or the picture is going: release the held button where it was, then every key still down. */
  releaseAll(): void
  /** Cancel what is waiting; nothing goes after. */
  dispose(): void
}

/**
 * The pace of the tab's input, so the uplink (at most 256 KiB buffered a stream) never floods: moves only while a button is
 * down, at most 30 a second; wheel turns summed at the same pace; and what the picture holds down released when it loses focus.
 * @param send - one item up the uplink.
 * @param clock - the time and the timers.
 */
export function createInputPacer(send: (up: Up) => void, clock: PaceClock = systemClock): InputPacer {
  let disposed = false
  let held: { button: MouseButton, clickCount: number, x: number, y: number } | undefined
  let moveAt = Number.NEGATIVE_INFINITY
  let moveWaiting: Point | undefined
  let moveCancel: (() => void) | undefined
  let wheelAt = Number.NEGATIVE_INFINITY
  let wheelWaiting: { x: number, y: number, dx: number, dy: number } | undefined
  let wheelCancel: (() => void) | undefined
  const pressed = new Map<string, KeyItem>()

  const out = (up: Up): void => {
    if (!disposed) send(up)
  }

  const sendMove = (point: Point): void => {
    if (held === undefined) return
    moveAt = clock.now()
    held.x = point.x
    held.y = point.y
    out({ kind: 'mouse', action: 'move', x: point.x, y: point.y, button: held.button, clickCount: 1 })
  }

  const flushMove = (): void => {
    moveCancel = undefined
    const point = moveWaiting
    moveWaiting = undefined
    if (point !== undefined) sendMove(point)
  }

  const cancelMove = (): void => {
    moveCancel?.()
    moveCancel = undefined
  }

  const flushWheel = (): void => {
    wheelCancel = undefined
    const turn = wheelWaiting
    wheelWaiting = undefined
    if (turn === undefined || (turn.dx === 0 && turn.dy === 0)) return
    wheelAt = clock.now()
    out({ kind: 'wheel', x: turn.x, y: turn.y, dx: turn.dx, dy: turn.dy })
  }

  const releaseHeld = (point: Point | undefined): void => {
    const button = held
    if (button === undefined) return
    cancelMove()
    const at = point ?? moveWaiting ?? { x: button.x, y: button.y }
    moveWaiting = undefined
    if (at.x !== button.x || at.y !== button.y) sendMove(at)
    held = undefined
    out({ kind: 'mouse', action: 'up', x: at.x, y: at.y, button: button.button, clickCount: button.clickCount })
  }

  return {
    press(point, button, clickCount) {
      if (disposed || held !== undefined) return
      held = { button, clickCount, x: point.x, y: point.y }
      moveAt = clock.now()
      out({ kind: 'mouse', action: 'move', x: point.x, y: point.y, button, clickCount: 1 })
      out({ kind: 'mouse', action: 'down', x: point.x, y: point.y, button, clickCount })
    },
    move(point) {
      if (disposed || held === undefined || point === undefined) return
      if (moveCancel === undefined && clock.now() - moveAt >= MOVE_INTERVAL_MS) {
        sendMove(point)
        return
      }
      moveWaiting = point
      if (moveCancel === undefined) moveCancel = clock.later(flushMove, Math.max(0, MOVE_INTERVAL_MS - (clock.now() - moveAt)))
    },
    release(button, point) {
      if (held === undefined || held.button !== button) return
      releaseHeld(point)
    },
    holding: () => held !== undefined,
    wheel(point, dx, dy) {
      if (disposed) return
      wheelWaiting = { x: point.x, y: point.y, dx: (wheelWaiting?.dx ?? 0) + finite(dx), dy: (wheelWaiting?.dy ?? 0) + finite(dy) }
      if (wheelCancel !== undefined) return
      const wait = MOVE_INTERVAL_MS - (clock.now() - wheelAt)
      if (wait <= 0) flushWheel()
      else wheelCancel = clock.later(flushWheel, wait)
    },
    keyDown(id, item) {
      if (disposed) return
      pressed.set(id, item)
      out(item)
    },
    keyUp(id, item) {
      const down = pressed.get(id)
      if (disposed || down === undefined) return false
      pressed.delete(id)
      out(item ?? { ...down, action: 'up' })
      return true
    },
    releaseAll() {
      releaseHeld(undefined)
      for (const down of pressed.values()) out({ ...down, action: 'up' })
      pressed.clear()
    },
    dispose() {
      disposed = true
      cancelMove()
      wheelCancel?.()
      wheelCancel = undefined
      moveWaiting = undefined
      wheelWaiting = undefined
      held = undefined
      pressed.clear()
    },
  }
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value))
}
