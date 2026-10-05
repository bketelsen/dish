/**
 * `parseUp`: each item the Browser tab sends up the `watch` stream's uplink, checked on its own. A known kind, finite numbers
 * (points clamped to the viewport, wheel turns to ±10,000), a key the host replays, text of 1–10,000 characters; only the
 * known fields are kept. A refusal's `why` names the field and never repeats what the item held.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TEXT_MAX, URL_MAX } from '../src/protocol.ts'
import type { Up } from '../src/protocol.ts'
import { WHEEL_MAX, parseUp } from '../src/uplink.ts'

const VIEWPORT = { width: 1280, height: 800 }

function accepted(item: unknown): Up {
  const parsed = parseUp(item, VIEWPORT)
  assert.ok(parsed.ok, `refused ${JSON.stringify(item)}: ${parsed.ok ? '' : parsed.why}`)
  return parsed.up
}

function refused(item: unknown): string {
  const parsed = parseUp(item, VIEWPORT)
  assert.ok(!parsed.ok, `accepted ${JSON.stringify(item)}`)
  return parsed.why
}

const MOUSE = { kind: 'mouse', action: 'down', x: 10, y: 20, button: 'left', clickCount: 1 } as const
const WHEEL = { kind: 'wheel', x: 10, y: 20, dx: 0, dy: 120 } as const
const KEY = { kind: 'key', action: 'down', key: 'Enter', code: 'Enter', modifiers: 0 } as const

test('every kind is accepted as it came', () => {
  const each: Up[] = [
    { kind: 'frames', on: true },
    { kind: 'frames', on: false },
    { kind: 'ack', seq: 0 },
    { kind: 'ack', seq: 7 },
    { kind: 'navigate', url: 'http://127.0.0.1:5173/?q=a b' },
    { kind: 'navigate', url: '' },
    { kind: 'navigate', url: 'x'.repeat(URL_MAX) },
    { kind: 'back' }, { kind: 'forward' }, { kind: 'reload' }, { kind: 'close' },
    MOUSE,
    { kind: 'mouse', action: 'up', x: 10.5, y: 20.25, button: 'right', clickCount: 3 },
    { kind: 'mouse', action: 'move', x: 0, y: 0, button: 'middle', clickCount: 2 },
    { kind: 'mouse', action: 'move', x: 1279, y: 799, button: 'left', clickCount: 1 },
    { kind: 'wheel', x: 1.5, y: 2.25, dx: 0, dy: -120 },
    { kind: 'wheel', x: 0, y: 0, dx: WHEEL_MAX, dy: -WHEEL_MAX },
    KEY,
    { kind: 'key', action: 'up', key: 'a', code: 'KeyA', modifiers: 15 },
    { kind: 'key', action: 'down', key: 'Control', code: '', modifiers: 2 },
    { kind: 'key', action: 'down', key: 'ArrowLeft', code: 'ArrowLeft', modifiers: 8 },
    { kind: 'key', action: 'down', key: ' ', code: 'Space', modifiers: 0 },
    { kind: 'key', action: 'down', key: 'x', code: 'x'.repeat(32), modifiers: 0 },
    { kind: 'text', text: 'naïve 東京 "quoted" \\ \n' },
    { kind: 'text', text: 'x' },
    { kind: 'text', text: 'x'.repeat(TEXT_MAX) },
  ]
  for (const item of each) assert.deepEqual(accepted(item), item)
})

test('a key that is one character outside the US layout is accepted, to be typed: é, 🙂', () => {
  assert.deepEqual(accepted({ kind: 'key', action: 'down', key: 'é', code: 'Digit2', modifiers: 0 }),
    { kind: 'key', action: 'down', key: 'é', code: 'Digit2', modifiers: 0 })
  assert.equal((accepted({ ...KEY, key: '🙂', code: '' }) as { key: string }).key, '🙂')
})

test('only the known fields are kept, in a new object', () => {
  const item = { ...MOUSE, extra: 'x', __proto__: { polluted: true } }
  const up = accepted(item)
  assert.deepEqual(Object.keys(up).sort(), ['action', 'button', 'clickCount', 'kind', 'x', 'y'])
  assert.notEqual(up, item)
  assert.equal(Object.getPrototypeOf(up), Object.prototype)
  assert.deepEqual(accepted({ kind: 'back', url: 'http://elsewhere.test/' }), { kind: 'back' })
  assert.deepEqual(accepted({ kind: 'frames', on: true, seq: 1 }), { kind: 'frames', on: true })
})

test('points are clamped to the viewport, wheel turns to ±10,000', () => {
  assert.deepEqual(accepted({ ...MOUSE, x: -5, y: 900 }), { ...MOUSE, x: 0, y: 799 })
  assert.deepEqual(accepted({ ...MOUSE, x: 5000, y: -0.5 }), { ...MOUSE, x: 1279, y: 0 })
  assert.deepEqual(accepted({ ...WHEEL, x: -1, y: 1e9, dx: 1e9, dy: -1e9 }), { ...WHEEL, x: 0, y: 799, dx: WHEEL_MAX, dy: -WHEEL_MAX })
  const tiny = parseUp({ ...MOUSE, x: 3, y: 3 }, { width: 1, height: 1 })
  assert.ok(tiny.ok)
  assert.deepEqual(tiny.up, { ...MOUSE, x: 0, y: 0 })
})

test('what isn\'t an object, or of no kind the tab sends, is refused', () => {
  for (const item of [null, undefined, 'frames', 42, true]) assert.equal(refused(item), 'not an object')
  assert.equal(refused([MOUSE]), 'not an object')
  for (const kind of [undefined, '', 'nope', 'toString', 'constructor', 'hello', 'state', 5]) {
    assert.equal(refused({ kind }), 'unknown kind', String(kind))
  }
})

test('each rule refuses with its why', () => {
  const cases: Array<[unknown, string]> = [
    [{ kind: 'frames' }, 'on isn\'t true or false'],
    [{ kind: 'frames', on: 'yes' }, 'on isn\'t true or false'],
    [{ kind: 'frames', on: 1 }, 'on isn\'t true or false'],
    [{ kind: 'ack', seq: -1 }, 'seq isn\'t a whole number of 0 or more'],
    [{ kind: 'ack', seq: 1.5 }, 'seq isn\'t a whole number of 0 or more'],
    [{ kind: 'ack', seq: '3' }, 'seq isn\'t a whole number of 0 or more'],
    [{ kind: 'ack', seq: Number.NaN }, 'seq isn\'t a whole number of 0 or more'],
    [{ kind: 'ack', seq: Number.POSITIVE_INFINITY }, 'seq isn\'t a whole number of 0 or more'],
    [{ kind: 'navigate' }, 'url isn\'t a string'],
    [{ kind: 'navigate', url: 5 }, 'url isn\'t a string'],
    [{ kind: 'navigate', url: 'x'.repeat(URL_MAX + 1) }, 'url is longer than 4,096 characters'],
    [{ ...MOUSE, action: 'click' }, 'action isn\'t down, up or move'],
    [{ ...MOUSE, button: 'back' }, 'button isn\'t left, middle or right'],
    [{ ...MOUSE, button: 0 }, 'button isn\'t left, middle or right'],
    [{ ...MOUSE, clickCount: 0 }, 'clickCount isn\'t 1, 2 or 3'],
    [{ ...MOUSE, clickCount: 4 }, 'clickCount isn\'t 1, 2 or 3'],
    [{ ...MOUSE, clickCount: 1.5 }, 'clickCount isn\'t 1, 2 or 3'],
    [{ ...MOUSE, x: 'a' }, 'x isn\'t a number'],
    [{ ...MOUSE, x: Number.NaN }, 'x isn\'t a number'],
    [{ ...MOUSE, x: Number.POSITIVE_INFINITY }, 'x isn\'t a number'],
    [{ ...MOUSE, y: null }, 'y isn\'t a number'],
    [{ kind: 'mouse', action: 'down', button: 'left', clickCount: 1 }, 'x isn\'t a number'],
    [{ ...WHEEL, x: '1' }, 'x isn\'t a number'],
    [{ ...WHEEL, dx: 'a' }, 'dx isn\'t a number'],
    [{ ...WHEEL, dy: Number.NEGATIVE_INFINITY }, 'dy isn\'t a number'],
    [{ ...KEY, action: 'press' }, 'action isn\'t down or up'],
    [{ ...KEY, key: 'Ctrl' }, 'key isn\'t one dish replays'],
    [{ ...KEY, key: 'ab' }, 'key isn\'t one dish replays'],
    [{ ...KEY, key: '' }, 'key isn\'t one dish replays'],
    [{ ...KEY, key: 'Dead' }, 'key isn\'t one dish replays'],
    [{ ...KEY, key: 5 }, 'key isn\'t one dish replays'],
    [{ ...KEY, code: 5 }, 'code isn\'t a string'],
    [{ ...KEY, code: 'x'.repeat(33) }, 'code is longer than 32 characters'],
    [{ ...KEY, modifiers: 16 }, 'modifiers isn\'t a whole number from 0 to 15'],
    [{ ...KEY, modifiers: -1 }, 'modifiers isn\'t a whole number from 0 to 15'],
    [{ ...KEY, modifiers: 1.5 }, 'modifiers isn\'t a whole number from 0 to 15'],
    [{ ...KEY, modifiers: '0' }, 'modifiers isn\'t a whole number from 0 to 15'],
    [{ kind: 'text' }, 'text isn\'t a string'],
    [{ kind: 'text', text: 5 }, 'text isn\'t a string'],
    [{ kind: 'text', text: '' }, 'text is empty'],
    [{ kind: 'text', text: 'x'.repeat(TEXT_MAX + 1) }, 'text is longer than 10,000 characters'],
  ]
  for (const [item, why] of cases) assert.equal(refused(item), why, JSON.stringify(item)?.slice(0, 80))
})

test('a why never repeats what the item held: what the user types stays out of logs', () => {
  const secret = 'hunter2-typed-by-the-user'
  const whys = [
    refused({ kind: 'text', text: `${secret}${'x'.repeat(TEXT_MAX)}` }),
    refused({ kind: 'navigate', url: `${secret}${'x'.repeat(URL_MAX)}` }),
    refused({ ...KEY, key: secret }),
    refused({ ...KEY, code: `${secret}${'x'.repeat(32)}` }),
    refused({ kind: secret }),
    refused({ ...MOUSE, x: secret }),
  ]
  for (const why of whys) assert.doesNotMatch(why, /hunter2/)
})

test('an item that throws when read is refused, not thrown', () => {
  const item = new Proxy({}, { get() { throw new Error('boom') } })
  assert.deepEqual(parseUp(item, VIEWPORT), { ok: false, why: 'not readable' })
})
