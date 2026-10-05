/**
 * The Browser tab's input, as plain functions: how the picture is sized, where a point lands in the page, which button and
 * modifiers an event carries, what a key becomes, what a paste becomes, and what the address bar accepts. No DOM here: the
 * picture's handlers (`Picture.tsx`) call these with the events' fields.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { addressInput } from '../src/client/address.ts'
import {
  MOVE_INTERVAL_MS, buttonOf, clickCountOf, fit, isPaste, keyMessage, modifiersOf, pasteText, toViewport, wheelPixels,
} from '../src/client/input.ts'
import type { KeyLike } from '../src/client/input.ts'
import { ALT, CONTROL, META, SHIFT, TEXT_MAX, URL_MAX } from '../src/protocol.ts'

const VIEWPORT = { width: 1280, height: 800 }

function key(overrides: Partial<KeyLike> = {}): KeyLike {
  return { key: 'a', code: 'KeyA', isComposing: false, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...overrides }
}

test('fit keeps the frame\'s shape in a wide, a tall and an exact room', () => {
  // Wide: the height decides.
  assert.deepEqual(fit({ width: 1000, height: 400 }, VIEWPORT), { width: 640, height: 400 })
  // Tall: the width decides.
  assert.deepEqual(fit({ width: 320, height: 900 }, VIEWPORT), { width: 320, height: 200 })
  // Exact.
  assert.deepEqual(fit({ width: 1280, height: 800 }, VIEWPORT), { width: 1280, height: 800 })
  // Bigger than the frame: it grows to fill the room.
  assert.deepEqual(fit({ width: 2560, height: 1600 }, VIEWPORT), { width: 2560, height: 1600 })
  // Whole pixels, never wider or taller than the room.
  const odd = fit({ width: 333, height: 777 }, VIEWPORT)
  assert.ok(Number.isInteger(odd.width) && Number.isInteger(odd.height))
  assert.ok(odd.width <= 333 && odd.height <= 777)
  // No room, or no frame: nothing to draw.
  assert.deepEqual(fit({ width: 0, height: 400 }, VIEWPORT), { width: 0, height: 0 })
  assert.deepEqual(fit({ width: 400, height: 400 }, { width: 0, height: 800 }), { width: 0, height: 0 })
  assert.deepEqual(fit({ width: Number.NaN, height: 400 }, VIEWPORT), { width: 0, height: 0 })
})

test('toViewport maps a point in the drawn image to the page, scaled', () => {
  const drawn = { left: 100, top: 50, width: 640, height: 400 }
  // Inside: the image is drawn at half size.
  assert.deepEqual(toViewport(100 + 320, 50 + 200, drawn, VIEWPORT), { x: 640, y: 400 })
  assert.deepEqual(toViewport(101, 51, drawn, VIEWPORT), { x: 2, y: 2 })
  // An edge is inside; the far edges land on the last pixel.
  assert.deepEqual(toViewport(100, 50, drawn, VIEWPORT), { x: 0, y: 0 })
  assert.deepEqual(toViewport(100 + 640, 50 + 400, drawn, VIEWPORT), { x: 1279, y: 799 })
  // Outside: ignored.
  assert.equal(toViewport(99, 60, drawn, VIEWPORT), undefined)
  assert.equal(toViewport(200, 49, drawn, VIEWPORT), undefined)
  assert.equal(toViewport(741, 60, drawn, VIEWPORT), undefined)
  assert.equal(toViewport(200, 451, drawn, VIEWPORT), undefined)
  // Nothing drawn, or a point that isn't one.
  assert.equal(toViewport(100, 50, { left: 100, top: 50, width: 0, height: 400 }, VIEWPORT), undefined)
  assert.equal(toViewport(Number.NaN, 60, drawn, VIEWPORT), undefined)
})

test('buttonOf: the three buttons a page knows, and nothing else', () => {
  assert.equal(buttonOf(0), 'left')
  assert.equal(buttonOf(1), 'middle')
  assert.equal(buttonOf(2), 'right')
  assert.equal(buttonOf(3), undefined)
  assert.equal(buttonOf(4), undefined)
  assert.equal(buttonOf(-1), undefined)
})

test('clickCountOf: the event\'s count, from 1 to 3', () => {
  assert.equal(clickCountOf(0), 1)
  assert.equal(clickCountOf(1), 1)
  assert.equal(clickCountOf(2), 2)
  assert.equal(clickCountOf(3), 3)
  assert.equal(clickCountOf(7), 3)
  assert.equal(clickCountOf(Number.NaN), 1)
})

test('modifiersOf: CDP\'s bits', () => {
  const none = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false }
  assert.equal(modifiersOf(none), 0)
  assert.equal(modifiersOf({ ...none, altKey: true }), ALT)
  assert.equal(modifiersOf({ ...none, ctrlKey: true }), CONTROL)
  assert.equal(modifiersOf({ ...none, metaKey: true }), META)
  assert.equal(modifiersOf({ ...none, shiftKey: true }), SHIFT)
  assert.equal(modifiersOf({ altKey: true, ctrlKey: true, metaKey: true, shiftKey: true }), 15)
})

test('keyMessage: a printable key, a named key, and the ones that are not keys yet', () => {
  assert.deepEqual(keyMessage(key(), 'down'), { kind: 'key', action: 'down', key: 'a', code: 'KeyA', modifiers: 0 })
  assert.deepEqual(keyMessage(key({ key: 'A', shiftKey: true }), 'up'), { kind: 'key', action: 'up', key: 'A', code: 'KeyA', modifiers: SHIFT })
  assert.deepEqual(keyMessage(key({ key: 'Enter', code: 'Enter' }), 'down'), { kind: 'key', action: 'down', key: 'Enter', code: 'Enter', modifiers: 0 })
  assert.deepEqual(keyMessage(key({ key: 'Control', code: 'ControlLeft', ctrlKey: true }), 'down'),
    { kind: 'key', action: 'down', key: 'Control', code: 'ControlLeft', modifiers: CONTROL })
  // A character outside the US layout goes as it is: the host types it.
  assert.deepEqual(keyMessage(key({ key: 'é', code: 'Digit2' }), 'down'), { kind: 'key', action: 'down', key: 'é', code: 'Digit2', modifiers: 0 })
  // Composing, a dead key, and keys with no name yet: nothing.
  assert.equal(keyMessage(key({ isComposing: true }), 'down'), undefined)
  assert.equal(keyMessage(key({ key: 'Dead', code: 'Quote' }), 'down'), undefined)
  assert.equal(keyMessage(key({ key: 'Unidentified', code: '' }), 'down'), undefined)
  assert.equal(keyMessage(key({ key: 'Process', code: 'KeyA' }), 'down'), undefined)
  assert.equal(keyMessage(key({ key: '' }), 'down'), undefined)
  // A code longer than any real one is cut.
  const long = keyMessage(key({ code: 'C'.repeat(100) }), 'down')
  assert.equal(long?.kind === 'key' ? long.code.length : -1, 32)
})

test('isPaste: Ctrl or Cmd with V, on any layout', () => {
  assert.equal(isPaste(key({ key: 'v', code: 'KeyV', ctrlKey: true })), true)
  assert.equal(isPaste(key({ key: 'V', code: 'KeyV', ctrlKey: true, shiftKey: true })), true)
  assert.equal(isPaste(key({ key: 'v', code: 'KeyV', metaKey: true })), true)
  // A layout whose V key types another letter: the physical key counts.
  assert.equal(isPaste(key({ key: 'м', code: 'KeyV', ctrlKey: true })), true)
  // Dvorak's V is on another key.
  assert.equal(isPaste(key({ key: 'v', code: 'Period', ctrlKey: true })), true)
  assert.equal(isPaste(key({ key: 'k', code: 'KeyV', ctrlKey: true })), false)
  assert.equal(isPaste(key({ key: 'v', code: 'KeyV' })), false)
  assert.equal(isPaste(key({ key: 'c', code: 'KeyC', ctrlKey: true })), false)
  assert.equal(isPaste(key({ key: 'v', code: 'KeyV', ctrlKey: true, altKey: true })), false)
})

test('pasteText: the text, cut at the most one item holds, never between a pair\'s halves', () => {
  assert.equal(pasteText(''), undefined)
  assert.equal(pasteText('hello'), 'hello')
  assert.equal(pasteText('naïve 東京 "q" \\ \n'), 'naïve 東京 "q" \\ \n')
  const long = 'x'.repeat(TEXT_MAX + 5)
  assert.equal(pasteText(long)?.length, TEXT_MAX)
  assert.equal(TEXT_MAX, 10_000)
  const split = `${'x'.repeat(TEXT_MAX - 1)}😀`
  const cut = pasteText(split)
  assert.equal(cut, 'x'.repeat(TEXT_MAX - 1))
  assert.ok(cut !== undefined && !/[\uD800-\uDBFF]$/.test(cut))
})

test('wheelPixels: lines and pages become pixels', () => {
  assert.deepEqual(wheelPixels({ deltaX: 3, deltaY: -120, deltaMode: 0 }, VIEWPORT), { dx: 3, dy: -120 })
  assert.deepEqual(wheelPixels({ deltaX: 0, deltaY: 3, deltaMode: 1 }, VIEWPORT), { dx: 0, dy: 120 })
  assert.deepEqual(wheelPixels({ deltaX: 1, deltaY: 1, deltaMode: 2 }, VIEWPORT), { dx: 1280, dy: 800 })
  assert.deepEqual(wheelPixels({ deltaX: Number.NaN, deltaY: 5, deltaMode: 0 }, VIEWPORT), { dx: 0, dy: 5 })
})

test('the picture sends a move at most every 33 ms: 30 a second', () => {
  assert.equal(MOVE_INTERVAL_MS, 33)
})

test('addressInput: trimmed, and nothing for an empty or an over-long address', () => {
  assert.equal(addressInput('  http://127.0.0.1:5173/  '), 'http://127.0.0.1:5173/')
  assert.equal(addressInput('localhost:3000'), 'localhost:3000')
  assert.equal(addressInput(''), undefined)
  assert.equal(addressInput(' \t\n '), undefined)
  assert.equal(addressInput(`http://a/${'x'.repeat(URL_MAX)}`), undefined)
  const longest = `http://a/${'x'.repeat(URL_MAX - 9)}`
  assert.equal(longest.length, URL_MAX)
  assert.equal(addressInput(longest), longest)
})
