/**
 * The Browser tab's input, as plain functions: how the picture is sized, where a point lands in the page, which button and
 * modifiers an event carries, what a key becomes, what a paste becomes, and what the address bar accepts. No DOM here: the
 * picture's handlers (`Picture.tsx`) call these with the events' fields.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { addressInput } from '../src/client/address.ts'
import {
  MOVE_INTERVAL_MS, buttonOf, clickCountOf, createInputPacer, fit, isPaste, keyMessage, modifiersOf, pasteText, toViewport, wheelPixels,
} from '../src/client/input.ts'
import type { KeyItem, KeyLike, PaceClock } from '../src/client/input.ts'
import { ALT, CONTROL, META, SHIFT, TEXT_MAX, URL_MAX } from '../src/protocol.ts'
import type { MouseButton, Up } from '../src/protocol.ts'

const VIEWPORT = { width: 1280, height: 800 }

/** A clock the test moves by hand: its timers run when `advance` passes them, in order. */
class ManualClock implements PaceClock {
  time = 1_000
  private readonly timers: Array<{ at: number, run: () => void, live: boolean }> = []

  now(): number {
    return this.time
  }

  later(run: () => void, ms: number): () => void {
    const timer = { at: this.time + ms, run, live: true }
    this.timers.push(timer)
    return () => { timer.live = false }
  }

  advance(ms: number): void {
    const end = this.time + ms
    for (;;) {
      const due = this.timers.filter(timer => timer.live && timer.at <= end).sort((a, b) => a.at - b.at)[0]
      if (due === undefined) break
      this.time = due.at
      due.live = false
      due.run()
    }
    this.time = end
  }

  pending(): number {
    return this.timers.filter(timer => timer.live).length
  }
}

function pacing(): { sent: Up[], clock: ManualClock, pacer: ReturnType<typeof createInputPacer> } {
  const sent: Up[] = []
  const clock = new ManualClock()
  return { sent, clock, pacer: createInputPacer((up) => { sent.push(up) }, clock) }
}

const mouse = (action: 'down' | 'up' | 'move', x: number, y: number, button: MouseButton = 'left', clickCount = 1): Up =>
  ({ kind: 'mouse', action, x, y, button, clickCount })

const keyItem = (action: 'down' | 'up', key: string, code: string, modifiers = 0): KeyItem => ({ kind: 'key', action, key, code, modifiers })

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

test('the picture sits at the top of its area, as a browser shows a page under its address bar; a point maps from the image\'s own box', () => {
  // `styles.ts` adds its sheet to the document when loaded, so its text is read here. The picture's box is a flex row: the
  // image is drawn at the box's top (it was centred, with blank room above it in a tall pane), centred across.
  const styles = readFileSync(new URL('../src/client/styles.ts', import.meta.url), 'utf8')
  const rule = /\n\.dish-browser-picture \{\n([^}]*)\}/.exec(styles)
  assert.ok(rule, 'the .dish-browser-picture rule')
  assert.match(rule[1]!, /^ {2}align-items: flex-start;$/m)
  assert.match(rule[1]!, /^ {2}justify-content: center;$/m)
  // `Picture` maps a point through the image's own client box (`getBoundingClientRect`), wherever the box puts it: a tall
  // pane's image at the box's top, a wide pane's centred across, half size.
  const room = { left: 10, top: 120, width: 1000, height: 900 }
  const size = fit(room, VIEWPORT)
  assert.deepEqual(size, { width: 1000, height: 625 })
  const tall = { left: room.left, top: room.top, ...size }
  assert.deepEqual(toViewport(room.left, room.top, tall, VIEWPORT), { x: 0, y: 0 })
  assert.deepEqual(toViewport(room.left + 500, room.top + 312.5, tall, VIEWPORT), { x: 640, y: 400 })
  // Below the image, in the box's empty room: ignored.
  assert.equal(toViewport(room.left + 500, room.top + 626, tall, VIEWPORT), undefined)
  const wide = { left: 10 + (1000 - 640) / 2, top: 120, width: 640, height: 400 }
  assert.deepEqual(fit({ width: 1000, height: 400 }, VIEWPORT), { width: 640, height: 400 })
  assert.deepEqual(toViewport(wide.left + 320, 120 + 200, wide, VIEWPORT), { x: 640, y: 400 })
  assert.equal(toViewport(wide.left - 1, 130, wide, VIEWPORT), undefined)
})

test('the focus ring is drawn on the image, not on the box, which fills the stage below it', () => {
  // The box keeps filling the stage (`Picture` measures it for the room), so a ring on the box ran far below a wide
  // pane's image. The ring is the image's outline, drawn over its border.
  const styles = readFileSync(new URL('../src/client/styles.ts', import.meta.url), 'utf8')
  const box = /\n\.dish-browser-picture \{\n([^}]*)\}/.exec(styles)
  assert.ok(box, 'the .dish-browser-picture rule')
  assert.match(box[1]!, /^ {2}flex: 1 1 0;$/m, 'the box fills the stage')
  assert.match(box[1]!, /^ {2}outline: none;$/m)
  assert.doesNotMatch(styles, /\.dish-browser-picture:focus(?:-visible|-within)? \{/, 'no ring on the box itself')
  assert.doesNotMatch(styles, /box-shadow/)
  const ring = /\n\.dish-browser-picture:focus \.dish-browser-frame \{\n([^}]*)\}/.exec(styles)
  assert.ok(ring, 'the .dish-browser-picture:focus .dish-browser-frame rule')
  assert.match(ring[1]!, /^ {2}outline: 2px solid var\(--dsw-alias-state-business-primary\);$/m)
  assert.match(ring[1]!, /^ {2}outline-offset: -2px;$/m)
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

// --- the uplink's pace ------------------------------------------------------------------------------

test('a move goes only while a button is down, at most every 33 ms, the newest kept', () => {
  const { sent, clock, pacer } = pacing()
  pacer.move({ x: 1, y: 1 })
  clock.advance(100)
  assert.equal(sent.length, 0, 'no button down: no move')
  assert.equal(pacer.holding(), false)
  pacer.press({ x: 10, y: 10 }, 'left', 1)
  assert.deepEqual(sent, [mouse('move', 10, 10), mouse('down', 10, 10)])
  assert.equal(pacer.holding(), true)
  sent.length = 0
  clock.advance(10)
  pacer.move({ x: 11, y: 11 })
  clock.advance(10)
  pacer.move({ x: 12, y: 12 })
  pacer.move(undefined)
  assert.equal(sent.length, 0, 'within 33 ms of the press')
  clock.advance(13)
  assert.deepEqual(sent, [mouse('move', 12, 12)], 'the newest, when the interval allows')
  // A move after a quiet spell goes at once.
  sent.length = 0
  clock.advance(100)
  pacer.move({ x: 13, y: 13 })
  assert.deepEqual(sent, [mouse('move', 13, 13)])
  // A second of moves every 4 ms: about 30 go, never more than 31.
  sent.length = 0
  for (let i = 0; i < 250; i++) {
    clock.advance(4)
    pacer.move({ x: i, y: i })
  }
  assert.ok(sent.length >= 28 && sent.length <= 31, `${sent.length} moves in a second`)
  assert.ok(sent.every(item => item.kind === 'mouse' && item.action === 'move'))
  pacer.dispose()
})

test('a release sends the last point as a move first, then the up with the press\'s click count', () => {
  const { sent, clock, pacer } = pacing()
  pacer.press({ x: 10, y: 10 }, 'left', 2)
  sent.length = 0
  clock.advance(5)
  pacer.move({ x: 20, y: 20 })
  pacer.release('left', { x: 25, y: 25 })
  assert.deepEqual(sent, [mouse('move', 25, 25), mouse('up', 25, 25, 'left', 2)])
  assert.equal(pacer.holding(), false)
  clock.advance(100)
  assert.equal(sent.length, 2, 'the move that was waiting went with the release')
  // Released outside the image: where it last was, the waiting move included.
  sent.length = 0
  pacer.press({ x: 1, y: 1 }, 'right', 1)
  clock.advance(5)
  pacer.move({ x: 30, y: 30 })
  pacer.release('right', undefined)
  assert.deepEqual(sent, [mouse('move', 1, 1, 'right'), mouse('down', 1, 1, 'right'), mouse('move', 30, 30, 'right'), mouse('up', 30, 30, 'right')])
  // Released where it was pressed: no move first.
  sent.length = 0
  clock.advance(100)
  pacer.press({ x: 5, y: 5 }, 'left', 3)
  pacer.release('left', { x: 5, y: 5 })
  assert.deepEqual(sent, [mouse('move', 5, 5), mouse('down', 5, 5, 'left', 3), mouse('up', 5, 5, 'left', 3)])
  // Another button's release, and a second press while one is held, change nothing.
  sent.length = 0
  pacer.press({ x: 7, y: 7 }, 'left', 1)
  pacer.press({ x: 8, y: 8 }, 'middle', 1)
  pacer.release('right', { x: 9, y: 9 })
  assert.deepEqual(sent, [mouse('move', 7, 7), mouse('down', 7, 7)])
  assert.equal(pacer.holding(), true)
  pacer.dispose()
})

test('wheel turns within 33 ms are summed into one, at the newest point; turns that cancel out send nothing', () => {
  const { sent, clock, pacer } = pacing()
  pacer.wheel({ x: 1, y: 1 }, 0, 100)
  assert.deepEqual(sent, [{ kind: 'wheel', x: 1, y: 1, dx: 0, dy: 100 }])
  sent.length = 0
  clock.advance(5)
  pacer.wheel({ x: 2, y: 2 }, 0, 40)
  clock.advance(5)
  pacer.wheel({ x: 3, y: 3 }, 10, 60)
  assert.equal(sent.length, 0)
  clock.advance(23)
  assert.deepEqual(sent, [{ kind: 'wheel', x: 3, y: 3, dx: 10, dy: 100 }])
  sent.length = 0
  clock.advance(5)
  pacer.wheel({ x: 4, y: 4 }, 0, 30)
  clock.advance(5)
  pacer.wheel({ x: 4, y: 4 }, 0, -30)
  clock.advance(100)
  assert.equal(sent.length, 0)
  // A long spin: about 30 a second.
  for (let i = 0; i < 250; i++) {
    clock.advance(4)
    pacer.wheel({ x: 5, y: 5 }, 0, 10)
  }
  clock.advance(100)
  assert.ok(sent.length >= 28 && sent.length <= 32, `${sent.length} wheels in a second`)
  assert.equal(sent.reduce((sum, item) => sum + (item.kind === 'wheel' ? item.dy : 0), 0), 2500, 'no turn is lost')
  pacer.dispose()
})

test('keys are sent and remembered; an up for a key not pressed here sends nothing; leaving releases what is held', () => {
  const { sent, pacer } = pacing()
  pacer.keyDown('ShiftLeft', keyItem('down', 'Shift', 'ShiftLeft', SHIFT))
  pacer.keyDown('KeyA', keyItem('down', 'A', 'KeyA', SHIFT))
  assert.equal(pacer.keyUp('KeyQ', keyItem('up', 'q', 'KeyQ')), false)
  assert.equal(pacer.keyUp('KeyA', keyItem('up', 'a', 'KeyA')), true)
  assert.equal(pacer.keyUp('KeyA', keyItem('up', 'a', 'KeyA')), false, 'already up')
  pacer.press({ x: 4, y: 4 }, 'left', 1)
  assert.deepEqual(sent, [
    keyItem('down', 'Shift', 'ShiftLeft', SHIFT), keyItem('down', 'A', 'KeyA', SHIFT), keyItem('up', 'a', 'KeyA'),
    mouse('move', 4, 4), mouse('down', 4, 4),
  ])
  sent.length = 0
  // Blur (or the picture going): the held button, then each key still down, in the words they went down with.
  pacer.releaseAll()
  assert.deepEqual(sent, [mouse('up', 4, 4), keyItem('up', 'Shift', 'ShiftLeft', SHIFT)])
  assert.equal(pacer.holding(), false)
  sent.length = 0
  pacer.releaseAll()
  assert.equal(sent.length, 0, 'nothing is held any more')
  // An up whose own words are unknown (composing) goes in the words of its down.
  pacer.keyDown('KeyB', keyItem('down', 'b', 'KeyB'))
  assert.equal(pacer.keyUp('KeyB', undefined), true)
  assert.deepEqual(sent.at(-1), keyItem('up', 'b', 'KeyB'))
  pacer.dispose()
})

test('what waits goes first: a wheel turn and a drag\'s move go before a later press, key or text, in the order they came', () => {
  const { sent, clock, pacer } = pacing()
  const wheel = (x: number, y: number, dy: number): Up => ({ kind: 'wheel', x, y, dx: 0, dy })
  // Inertial scroll, then a click within 33 ms: the page gets the last turn, then the click.
  pacer.wheel({ x: 1, y: 1 }, 0, 100)
  clock.advance(5)
  pacer.wheel({ x: 2, y: 2 }, 0, 40)
  pacer.press({ x: 3, y: 3 }, 'left', 1)
  assert.deepEqual(sent, [wheel(1, 1, 100), wheel(2, 2, 40), mouse('move', 3, 3), mouse('down', 3, 3)])
  clock.advance(100)
  assert.equal(sent.length, 4, 'the waiting turn went once, with the press')
  assert.equal(clock.pending(), 0)
  // A drag's move waiting, then a key: the move, then the key.
  sent.length = 0
  pacer.move({ x: 4, y: 4 })
  clock.advance(5)
  pacer.move({ x: 5, y: 5 })
  pacer.keyDown('ShiftLeft', keyItem('down', 'Shift', 'ShiftLeft', SHIFT))
  assert.deepEqual(sent, [mouse('move', 4, 4), mouse('move', 5, 5), keyItem('down', 'Shift', 'ShiftLeft', SHIFT)])
  clock.advance(100)
  assert.equal(sent.length, 3, 'the waiting move went once, with the key')
  // Both waiting, then a paste or a composition's text: the turn, the move, then the text.
  sent.length = 0
  pacer.wheel({ x: 6, y: 6 }, 0, 10)
  pacer.move({ x: 7, y: 7 })
  clock.advance(5)
  pacer.wheel({ x: 8, y: 8 }, 0, 20)
  pacer.move({ x: 9, y: 9 })
  pacer.text('naïve 東京')
  assert.deepEqual(sent, [wheel(6, 6, 10), mouse('move', 7, 7), wheel(8, 8, 20), mouse('move', 9, 9), { kind: 'text', text: 'naïve 東京' }])
  clock.advance(100)
  assert.equal(sent.length, 5)
  // A key going up after a turn (Ctrl with the wheel): the turn first, so the page sees it with the key still down.
  sent.length = 0
  pacer.wheel({ x: 10, y: 10 }, 0, 30)
  clock.advance(5)
  pacer.wheel({ x: 10, y: 10 }, 0, 30)
  assert.equal(pacer.keyUp('ShiftLeft', keyItem('up', 'Shift', 'ShiftLeft')), true)
  assert.deepEqual(sent, [wheel(10, 10, 30), wheel(10, 10, 30), keyItem('up', 'Shift', 'ShiftLeft')])
  // A release after a turn: the turn, then the release's own move and up.
  sent.length = 0
  clock.advance(100)
  pacer.wheel({ x: 11, y: 11 }, 0, 50)
  clock.advance(5)
  pacer.wheel({ x: 12, y: 12 }, 0, 50)
  pacer.move({ x: 12, y: 12 })
  pacer.release('left', { x: 13, y: 13 })
  assert.deepEqual(sent, [wheel(11, 11, 50), mouse('move', 12, 12), wheel(12, 12, 50), mouse('move', 13, 13), mouse('up', 13, 13)])
  // Leaving the picture after a turn: the turn, then the releases.
  sent.length = 0
  clock.advance(100)
  pacer.press({ x: 14, y: 14 }, 'left', 1)
  pacer.wheel({ x: 14, y: 14 }, 0, 60)
  clock.advance(5)
  pacer.wheel({ x: 14, y: 14 }, 0, 60)
  pacer.releaseAll()
  assert.deepEqual(sent, [mouse('move', 14, 14), mouse('down', 14, 14), wheel(14, 14, 60), wheel(14, 14, 60), mouse('up', 14, 14)])
  clock.advance(100)
  assert.equal(sent.length, 5)
  // Empty text sends nothing, and nothing goes after dispose.
  sent.length = 0
  pacer.text('')
  pacer.dispose()
  pacer.text('late')
  assert.equal(sent.length, 0)
})

test('dispose cancels what is waiting, and nothing goes after it', () => {
  const { sent, clock, pacer } = pacing()
  pacer.press({ x: 1, y: 1 }, 'left', 1)
  pacer.wheel({ x: 1, y: 1 }, 0, 10)
  clock.advance(5)
  pacer.move({ x: 2, y: 2 })
  pacer.wheel({ x: 1, y: 1 }, 0, 10)
  assert.ok(clock.pending() > 0)
  const before = sent.length
  pacer.releaseAll()
  pacer.dispose()
  const after = sent.length
  assert.ok(after > before, 'the release went before the dispose')
  clock.advance(1_000)
  assert.equal(clock.pending(), 0)
  pacer.press({ x: 3, y: 3 }, 'left', 1)
  pacer.keyDown('KeyA', keyItem('down', 'a', 'KeyA'))
  pacer.wheel({ x: 3, y: 3 }, 0, 10)
  clock.advance(1_000)
  assert.equal(sent.length, after)
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
