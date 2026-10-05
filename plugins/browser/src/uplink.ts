/**
 * What the Browser tab sends up the `watch` stream's uplink, checked item by item.
 *
 * In source mode the uplink has no codec, so items arrive as whatever JSON the tab sent. Each is checked here before the
 * stream acts on it: a known kind, finite numbers (points clamped to the viewport, wheel turns to ±10,000), a key the host
 * replays (`keys.ts`), a `code` of at most 32 characters, text of 1–10,000. Only the known fields are kept, in a new object.
 *
 * A refusal's `why` names the field and the rule, never what the item held: it goes into a log line, and what the user
 * types must not.
 *
 * @module dish-browser/uplink
 */

import { replayAs } from './keys.ts'
import { TEXT_MAX, URL_MAX } from './protocol.ts'
import type { MouseButton, Up, Viewport } from './protocol.ts'

/** The most pixels one `wheel` item scrolls either way. */
export const WHEEL_MAX = 10_000
/** The most characters of a key item's `code`: a real one is far shorter. */
const CODE_MAX = 32
/** The `modifiers` bits all set: ALT | CONTROL | META | SHIFT. */
const MODIFIERS_MAX = 15

const MOUSE_ACTIONS: ReadonlySet<unknown> = new Set(['down', 'up', 'move'])
const KEY_ACTIONS: ReadonlySet<unknown> = new Set(['down', 'up'])
const BUTTONS: ReadonlySet<unknown> = new Set<MouseButton>(['left', 'middle', 'right'])

export type Parsed = { ok: true, up: Up } | { ok: false, why: string }

function refuse(why: string): Parsed {
  return { ok: false, why }
}

function accept(up: Up): Parsed {
  return { ok: true, up }
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function wholeIn(value: unknown, low: number, high: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= low && value <= high
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high)
}

/** `n` with its thousands marked: 10,000. */
function fmt(n: number): string {
  return n.toLocaleString('en-US')
}

/** The item's point, clamped to the viewport's pixels, or why it isn't one. */
function pointOf(item: Record<string, unknown>, viewport: Viewport): { x: number, y: number } | string {
  const { x, y } = item
  if (!finite(x)) return 'x isn\'t a number'
  if (!finite(y)) return 'y isn\'t a number'
  return { x: clamp(x, 0, Math.max(0, viewport.width - 1)), y: clamp(y, 0, Math.max(0, viewport.height - 1)) }
}

/**
 * One item from the tab, checked: a known kind, finite numbers (points clamped to the viewport), a key `replayAs` knows,
 * text of 1–10,000 characters.
 * @param item - the uplink item, as the gateway gave it.
 * @param viewport - the page's size: a point is clamped to its last pixel.
 */
export function parseUp(item: unknown, viewport: Viewport): Parsed {
  try {
    return parse(item, viewport)
  } catch {
    return refuse('not readable')
  }
}

function parse(item: unknown, viewport: Viewport): Parsed {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) return refuse('not an object')
  const fields = item as Record<string, unknown>
  const kind = fields.kind
  switch (kind) {
    case 'frames':
      return typeof fields.on === 'boolean' ? accept({ kind, on: fields.on }) : refuse('on isn\'t true or false')
    case 'ack':
      return wholeIn(fields.seq, 0, Number.MAX_SAFE_INTEGER) ? accept({ kind, seq: fields.seq }) : refuse('seq isn\'t a whole number of 0 or more')
    case 'navigate': {
      const url = fields.url
      if (typeof url !== 'string') return refuse('url isn\'t a string')
      if (url.length > URL_MAX) return refuse(`url is longer than ${fmt(URL_MAX)} characters`)
      return accept({ kind, url })
    }
    case 'back':
    case 'forward':
    case 'reload':
    case 'close':
      return accept({ kind })
    case 'mouse': {
      const { action, button, clickCount } = fields
      if (!MOUSE_ACTIONS.has(action)) return refuse('action isn\'t down, up or move')
      if (!BUTTONS.has(button)) return refuse('button isn\'t left, middle or right')
      if (!wholeIn(clickCount, 1, 3)) return refuse('clickCount isn\'t 1, 2 or 3')
      const point = pointOf(fields, viewport)
      if (typeof point === 'string') return refuse(point)
      return accept({
        kind, action: action as 'down' | 'up' | 'move', x: point.x, y: point.y, button: button as MouseButton, clickCount,
      })
    }
    case 'wheel': {
      const point = pointOf(fields, viewport)
      if (typeof point === 'string') return refuse(point)
      const { dx, dy } = fields
      if (!finite(dx)) return refuse('dx isn\'t a number')
      if (!finite(dy)) return refuse('dy isn\'t a number')
      return accept({ kind, x: point.x, y: point.y, dx: clamp(dx, -WHEEL_MAX, WHEEL_MAX), dy: clamp(dy, -WHEEL_MAX, WHEEL_MAX) })
    }
    case 'key': {
      const { action, key, code, modifiers } = fields
      if (!KEY_ACTIONS.has(action)) return refuse('action isn\'t down or up')
      if (typeof key !== 'string' || replayAs(key) === undefined) return refuse('key isn\'t one dish replays')
      if (typeof code !== 'string') return refuse('code isn\'t a string')
      if (code.length > CODE_MAX) return refuse(`code is longer than ${CODE_MAX} characters`)
      if (!wholeIn(modifiers, 0, MODIFIERS_MAX)) return refuse(`modifiers isn't a whole number from 0 to ${MODIFIERS_MAX}`)
      return accept({ kind, action: action as 'down' | 'up', key, code, modifiers })
    }
    case 'text': {
      const text = fields.text
      if (typeof text !== 'string') return refuse('text isn\'t a string')
      if (text.length === 0) return refuse('text is empty')
      if (text.length > TEXT_MAX) return refuse(`text is longer than ${fmt(TEXT_MAX)} characters`)
      return accept({ kind, text })
    }
    default:
      return refuse('unknown kind')
  }
}
