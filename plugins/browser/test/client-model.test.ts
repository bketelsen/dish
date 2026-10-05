/**
 * The Browser tab's model: what each item of the `watch` stream does to what the tab shows (`reduce`), and the tab's title.
 * Plain TypeScript, no DOM: it runs under `node --test`.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { INITIAL, TITLE_MAX, reduce, titleText } from '../src/client/model.ts'
import type { TabState } from '../src/client/model.ts'
import type { Down, FrameDown, StateDown } from '../src/protocol.ts'

function state(overrides: Partial<StateDown> = {}): StateDown {
  return {
    kind: 'state', status: 'open', reason: '', url: 'http://127.0.0.1:5173/', title: 'Widget', loading: false,
    canGoBack: true, canGoForward: false, acting: false, canStart: false, sandboxOff: false, viewport: { width: 1280, height: 800 },
    ...overrides,
  }
}

function frame(seq: number, overrides: Partial<FrameDown> = {}): FrameDown {
  return { kind: 'frame', seq, data: '/9j/4AAQSkZJRg==', width: 1280, height: 800, ...overrides }
}

function apply(...downs: Down[]): TabState {
  return downs.reduce<TabState>((current, down) => reduce(current, down), INITIAL)
}

test('the tab starts connecting, knowing nothing', () => {
  assert.equal(INITIAL.connection, 'connecting')
  assert.equal(INITIAL.status, 'unknown')
  assert.equal(INITIAL.frame, undefined)
  assert.deepEqual(INITIAL.children, [])
  assert.equal(INITIAL.notice, undefined)
  assert.equal(INITIAL.url, '')
  assert.equal(INITIAL.title, '')
})

test('hello makes the connection live, and changes nothing else', () => {
  const next = reduce(INITIAL, { kind: 'hello', watchId: '1' })
  assert.deepEqual(next, { ...INITIAL, connection: 'live' })
  const down = { ...apply(state(), frame(1)), connection: 'down' as const }
  assert.deepEqual(reduce(down, { kind: 'hello', watchId: '2' }), { ...down, connection: 'live' })
})

test('a state replaces the facts', () => {
  const first = apply({ kind: 'hello', watchId: '1' }, state({ acting: true, loading: true, canGoBack: false, canGoForward: true, sandboxOff: true }))
  assert.equal(first.status, 'open')
  assert.equal(first.url, 'http://127.0.0.1:5173/')
  assert.equal(first.title, 'Widget')
  assert.equal(first.acting, true)
  assert.equal(first.loading, true)
  assert.equal(first.canGoBack, false)
  assert.equal(first.canGoForward, true)
  assert.equal(first.sandboxOff, true)
  assert.equal(first.connection, 'live')
  const second = reduce(first, state({ status: 'none', url: '', title: '', canStart: true, viewport: { width: 800, height: 600 } }))
  assert.equal(second.status, 'none')
  assert.equal(second.url, '')
  assert.equal(second.title, '')
  assert.equal(second.acting, false)
  assert.equal(second.canStart, true)
  assert.deepEqual(second.viewport, { width: 800, height: 600 })
  assert.equal(second.connection, 'live')
  // The reason is kept as the host worded it.
  const refused = reduce(second, state({ status: 'refused', reason: 'This chat is archived.' }))
  assert.equal(refused.reason, 'This chat is archived.')
})

test('a frame becomes a JPEG data source, with its number and size', () => {
  const next = apply(state(), frame(7, { width: 640, height: 400 }))
  assert.deepEqual(next.frame, { seq: 7, src: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==', width: 640, height: 400 })
  // The newest replaces it.
  assert.equal(reduce(next, frame(8)).frame?.seq, 8)
})

test('a frame whose data is not base64 is dropped, so a source is only ever a JPEG data URL', () => {
  const before = apply(state(), frame(1))
  for (const data of ['"><img src=x onerror=alert(1)>', 'abc def', 'javascript:alert(1)', '']) {
    assert.equal(reduce(before, frame(2, { data })), before, data)
  }
  for (const [width, height] of [[0, 800], [1280, -1], [Number.NaN, 800], [1280, Number.POSITIVE_INFINITY]]) {
    assert.equal(reduce(before, frame(2, { width: width!, height: height! })), before, `${width}x${height}`)
  }
})

test('a closed browser keeps its last frame; a browser that is gone or refused drops it', () => {
  const open = apply(state(), frame(3))
  const closed = reduce(open, state({ status: 'closed', reason: 'idle for 15 minutes', url: '', title: '' }))
  assert.equal(closed.status, 'closed')
  assert.equal(closed.reason, 'idle for 15 minutes')
  assert.deepEqual(closed.frame, open.frame)
  // A new generation's state for the same closed browser keeps it too.
  assert.deepEqual(reduce(closed, state({ status: 'closed', reason: 'idle for 15 minutes' })).frame, open.frame)
  // A new browser after the closed one starts without the old picture.
  assert.equal(reduce(closed, state({ status: 'open' })).frame, undefined)
  for (const status of ['none', 'unavailable', 'refused'] as const) {
    assert.equal(reduce(open, state({ status })).frame, undefined, status)
  }
  // An open browser's state keeps its picture.
  assert.deepEqual(reduce(open, state({ url: 'http://127.0.0.1:5173/next' })).frame, open.frame)
})

test('children replace the list, and a notice is the newest', () => {
  const one = apply({ kind: 'children', children: [{ sessionId: 'c1', label: '"coder: Fix login"' }] })
  assert.deepEqual(one.children, [{ sessionId: 'c1', label: '"coder: Fix login"' }])
  const none = reduce(one, { kind: 'children', children: [] })
  assert.deepEqual(none.children, [])
  const noticed = apply({ kind: 'notice', text: 'first' }, { kind: 'notice', text: 'second' })
  assert.equal(noticed.notice, 'second')
})

test('an item of a kind the tab does not know changes nothing', () => {
  const before = apply(state())
  assert.equal(reduce(before, { kind: 'surprise' } as unknown as Down), before)
})

test('the title: Browser, or Browser · the page\'s title, cut', () => {
  assert.equal(titleText(''), 'Browser')
  assert.equal(titleText('   '), 'Browser')
  assert.equal(titleText('Widget'), 'Browser · Widget')
  const long = 'x'.repeat(100)
  const cut = titleText(long)
  assert.equal(cut, `Browser · ${'x'.repeat(TITLE_MAX - 1)}…`)
  assert.equal(TITLE_MAX, 40)
  // A pair of UTF-16 halves is never split.
  const emoji = `${'x'.repeat(TITLE_MAX - 2)}😀😀`
  assert.ok(!/[\uD800-\uDBFF]…$/.test(titleText(emoji)), titleText(emoji))
})
