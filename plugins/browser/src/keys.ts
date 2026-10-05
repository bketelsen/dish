/**
 * The keys the Browser tab sends, and how the host replays each: a key Playwright's keyboard knows goes down and up; one
 * character it doesn't know (`é`, `🙂`) is typed with `insertText`.
 *
 * Pure: it imports nothing.
 *
 * @module dish-browser/keys
 */

/**
 * The codes of playwright-core 1.63.0's `USKeyboardLayout` (`lib/coreBundle.js:21140-21270`), in its order. Playwright's
 * keyboard takes each of them, and the four modifiers, which are its aliases for the left-hand keys. Every printable ASCII
 * character is a key or a shifted key of this layout, so `replayAs` takes those as keys too.
 */
const LAYOUT_CODES = [
  // The functions row.
  'Escape', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
  // The numbers row.
  'Backquote', 'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0',
  'Minus', 'Equal', 'Backslash', 'Backspace',
  // The first row.
  'Tab', 'KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY', 'KeyU', 'KeyI', 'KeyO', 'KeyP', 'BracketLeft', 'BracketRight',
  // The second row.
  'CapsLock', 'KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK', 'KeyL', 'Semicolon', 'Quote', 'Enter',
  // The third row.
  'ShiftLeft', 'KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyN', 'KeyM', 'Comma', 'Period', 'Slash', 'ShiftRight',
  // The last row.
  'ControlLeft', 'MetaLeft', 'AltLeft', 'Space', 'AltRight', 'AltGraph', 'MetaRight', 'ContextMenu', 'ControlRight',
  // The centre block.
  'PrintScreen', 'ScrollLock', 'Pause', 'PageUp', 'PageDown', 'Insert', 'Delete', 'Home', 'End',
  'ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown',
  // The media keys.
  'AudioVolumeMute', 'AudioVolumeDown', 'AudioVolumeUp', 'MediaTrackNext', 'MediaTrackPrevious', 'MediaPlayPause',
  // The numeric keypad.
  'NumLock', 'NumpadDivide', 'NumpadMultiply', 'NumpadSubtract',
  'Numpad7', 'Numpad8', 'Numpad9', 'Numpad4', 'Numpad5', 'Numpad6', 'NumpadAdd',
  'Numpad1', 'Numpad2', 'Numpad3', 'Numpad0', 'NumpadDecimal', 'NumpadEnter',
] as const

/** Every key name the host replays as a key: the four modifiers and the US layout's codes. */
export const KEY_NAMES: ReadonlySet<string> = new Set<string>(['Shift', 'Control', 'Alt', 'Meta', ...LAYOUT_CODES])

const PRINTABLE_ASCII = /^[\x20-\x7e]$/

/** How the host replays a key from the tab: 'key' (keyDown/keyUp), 'text' (insertText on down), or undefined (not a key). */
export function replayAs(key: string): 'key' | 'text' | undefined {
  if (typeof key !== 'string') return undefined
  if (KEY_NAMES.has(key)) return 'key'
  // One code point: `🙂` is two UTF-16 units and one character.
  if (Array.from(key).length !== 1) return undefined
  return PRINTABLE_ASCII.test(key) ? 'key' : 'text'
}
