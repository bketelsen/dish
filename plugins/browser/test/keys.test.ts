/**
 * `keys.ts`: the key names the host replays from the Browser tab, and how it replays each one.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { KEY_NAMES, replayAs } from '../src/keys.ts'

/** playwright-core 1.63.0's `USKeyboardLayout` codes (`lib/coreBundle.js:21140-21270`), written out on their own. */
function layoutCodes(): string[] {
  const range = (prefix: string, from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${from + i}`)
  const letters = Array.from({ length: 26 }, (_, i) => `Key${String.fromCharCode(65 + i)}`)
  return [
    'Escape', ...range('F', 1, 12),
    'Backquote', ...range('Digit', 0, 9), 'Minus', 'Equal', 'Backslash', 'Backspace',
    'Tab', ...letters, 'BracketLeft', 'BracketRight',
    'CapsLock', 'Semicolon', 'Quote', 'Enter',
    'ShiftLeft', 'Comma', 'Period', 'Slash', 'ShiftRight',
    'ControlLeft', 'MetaLeft', 'AltLeft', 'Space', 'AltRight', 'AltGraph', 'MetaRight', 'ContextMenu', 'ControlRight',
    'PrintScreen', 'ScrollLock', 'Pause', 'PageUp', 'PageDown', 'Insert', 'Delete', 'Home', 'End',
    'ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown',
    'AudioVolumeMute', 'AudioVolumeDown', 'AudioVolumeUp', 'MediaTrackNext', 'MediaTrackPrevious', 'MediaPlayPause',
    'NumLock', 'NumpadDivide', 'NumpadMultiply', 'NumpadSubtract', ...range('Numpad', 0, 9), 'NumpadAdd', 'NumpadDecimal', 'NumpadEnter',
  ]
}

test('KEY_NAMES is the four modifiers and every code of the US layout, and nothing else', () => {
  const expected = new Set(['Shift', 'Control', 'Alt', 'Meta', ...layoutCodes()])
  assert.deepEqual(new Set(KEY_NAMES), expected)
  for (const modifier of ['Shift', 'Control', 'Alt', 'Meta']) assert.ok(KEY_NAMES.has(modifier), modifier)
  // The three the plan's list left out are in the layout.
  for (const code of ['Comma', 'Period', 'Slash']) assert.ok(KEY_NAMES.has(code), code)
  assert.equal(KEY_NAMES.has('Ctrl'), false)
  assert.equal(KEY_NAMES.has('Dead'), false)
})

test('replayAs: a key name or printable ASCII is a key; one other character is text; anything else is not a key', () => {
  assert.equal(replayAs('a'), 'key')
  assert.equal(replayAs('A'), 'key')
  assert.equal(replayAs('!'), 'key')
  assert.equal(replayAs(' '), 'key')
  assert.equal(replayAs('~'), 'key')
  assert.equal(replayAs('Enter'), 'key')
  assert.equal(replayAs('ArrowDown'), 'key')
  assert.equal(replayAs('Shift'), 'key')
  assert.equal(replayAs('é'), 'text')
  assert.equal(replayAs('🙂'), 'text', 'one code point, two UTF-16 units')
  assert.equal(replayAs(''), undefined)
  assert.equal(replayAs('Ctrl'), undefined)
  assert.equal(replayAs('ab'), undefined)
  assert.equal(replayAs('éé'), undefined)
  assert.equal(replayAs('Dead'), undefined)
  assert.equal(replayAs(42 as unknown as string), undefined, 'a value that is not a string')
})
