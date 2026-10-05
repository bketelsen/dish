/**
 * The Browser tab's controller and the header button's presence, driven through a fake remote whose `watch` returns scripted
 * handles, and a fake `ctx.remote.$stream` that opens one generation, then another when the first ends, as the real one does
 * when the carrier drops. No React and no DOM: the components around the controller are checked in
 * `client-rendering.test.ts`, and in a browser by Task 9's run.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { RemoteStreamHandle } from '@deepseek-ai/dsh-typert-protocol'
import { createPresence, createTabController } from '../src/client/controller.ts'
import type { TabController } from '../src/client/controller.ts'
import type { Stream, StreamOptions } from '../src/client/follow.ts'
import { INITIAL } from '../src/client/model.ts'
import type { BrowserApi } from '../src/client/remote.ts'
import type { Down, StateDown, Up } from '../src/protocol.ts'

// --- fakes ---------------------------------------------------------------------------------------

/** One generation of `watch`, as the gateway's client hands it out: the items the test pushes, and what the tab sends. */
class FakeHandle implements RemoteStreamHandle<Down, Up> {
  readonly sessionId: string
  readonly signal: AbortSignal
  readonly sent: Up[] = []
  disposed = false
  private readonly items: Down[] = []
  private finished = false
  private wake: (() => void) | undefined

  constructor(sessionId: string, signal: AbortSignal) {
    this.sessionId = sessionId
    this.signal = signal
    signal.addEventListener('abort', () => { this.finish() }, { once: true })
  }

  send(item: Up): void {
    if (this.disposed || this.finished) throw new Error('client api: dishBrowser/watch stream has terminated')
    this.sent.push(item)
  }

  end(): void {}

  dispose(): void {
    this.disposed = true
    this.finish()
  }

  push(...items: Down[]): void {
    this.items.push(...items)
    this.signalWake()
  }

  /** The generation ends: the carrier dropped, or the host ended it. */
  finish(): void {
    this.finished = true
    this.signalWake()
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Down> {
    for (;;) {
      const item = this.items.shift()
      if (item !== undefined) {
        yield item
        continue
      }
      if (this.finished) return
      await new Promise<void>((resolve) => { this.wake = resolve })
    }
  }

  private signalWake(): void {
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }
}

class FakeApi implements BrowserApi {
  readonly handles: FakeHandle[] = []

  watch(sessionId: string, signal?: AbortSignal): RemoteStreamHandle<Down, Up> {
    const handle = new FakeHandle(sessionId, signal ?? new AbortController().signal)
    this.handles.push(handle)
    return handle
  }

  last(): FakeHandle {
    const handle = this.handles.at(-1)
    assert.ok(handle !== undefined, 'no watch was opened')
    return handle
  }
}

/** `ctx.remote.$stream`, reduced to what the tab relies on: a generation opens, and when it ends another one does. */
class FakeStream implements Stream<Down> {
  readonly options: StreamOptions<Down>
  generations = 0
  readonly accepted: number[] = []
  disposed = false
  private readonly lifetime = new AbortController()

  constructor(options: StreamOptions<Down>) {
    this.options = options
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.lifetime.abort()
  }

  async *[Symbol.asyncIterator](): AsyncIterator<{ generation: number, value: Down, accept(): void }> {
    while (!this.lifetime.signal.aborted) {
      const generation = ++this.generations
      const ending = new AbortController()
      const handle = this.options.open(AbortSignal.any([this.lifetime.signal, ending.signal]))
      try {
        for await (const value of handle) {
          if (this.lifetime.signal.aborted) return
          yield { generation, value, accept: () => { this.accepted.push(generation) } }
        }
      } finally {
        ending.abort()
      }
      if (this.lifetime.signal.aborted) return
      // The real one throws `ended(accepted)`, a carrier error, and reports it before it opens the next generation.
      this.options.carrierFailed?.(this.options.ended(true))
    }
  }
}

function harness(): { api: FakeApi, streams: FakeStream[], stream: (options: StreamOptions<Down>) => Stream<Down>, available: { on: boolean } } {
  const api = new FakeApi()
  const streams: FakeStream[] = []
  return {
    api,
    streams,
    available: { on: true },
    stream: (options) => {
      const made = new FakeStream(options)
      streams.push(made)
      return made
    },
  }
}

function state(overrides: Partial<StateDown> = {}): StateDown {
  return {
    kind: 'state', status: 'open', reason: '', url: 'http://127.0.0.1:5173/', title: 'Widget', loading: false,
    canGoBack: true, canGoForward: false, acting: false, canStart: false, sandboxOff: false, viewport: { width: 1280, height: 800 },
    ...overrides,
  }
}

/** Let what is queued run on. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve))
}

function make(): ReturnType<typeof harness> & { tab: TabController } {
  const h = harness()
  const tab = createTabController(() => (h.available.on ? h.api : undefined), h.stream)
  return { ...h, tab }
}

// --- the tab ---------------------------------------------------------------------------------------

test('the face is the actions and the observable, and starts where the model does', () => {
  const { tab } = make()
  assert.deepEqual(Object.keys(tab.face).sort(),
    ['ack', 'attach', 'back', 'close', 'detach', 'dismissNotice', 'forward', 'hooks', 'labelOf', 'navigate', 'reload', 'send', 'setVisible'])
  assert.equal(tab.face.hooks.tab.getSnapshot(), INITIAL)
  tab.dispose()
})

test('attach follows the target, accepts its hello, and the state follows what it says', async () => {
  const { api, streams, tab } = make()
  const heard: string[] = []
  const stop = tab.face.hooks.tab.subscribe(() => { heard.push(tab.face.hooks.tab.getSnapshot().connection) })
  tab.face.attach('s1')
  await settle()
  assert.equal(api.handles.length, 1)
  const handle = api.last()
  assert.equal(handle.sessionId, 's1')
  // The first thing a generation is told: whether frames are wanted. Not yet: nothing said the tab is visible.
  assert.deepEqual(handle.sent, [{ kind: 'frames', on: false }])
  handle.push({ kind: 'hello', watchId: '1' }, state(), { kind: 'children', children: [{ sessionId: 'c1', label: 'coder: Fix it' }] })
  await settle()
  const now = tab.face.hooks.tab.getSnapshot()
  assert.equal(now.connection, 'live')
  assert.equal(now.status, 'open')
  assert.equal(now.url, 'http://127.0.0.1:5173/')
  assert.deepEqual(now.children, [{ sessionId: 'c1', label: 'coder: Fix it' }])
  assert.deepEqual(streams[0]!.accepted, [1])
  assert.ok(heard.includes('live'))
  // The labels of the children it has seen are remembered, for the switcher.
  assert.equal(tab.face.labelOf('c1'), 'coder: Fix it')
  assert.equal(tab.face.labelOf('c2'), undefined)
  stop()
  tab.dispose()
  await settle()
})

test('a new target disposes the old stream first, and starts from nothing', async () => {
  const { api, streams, tab } = make()
  tab.face.attach('s1')
  await settle()
  api.last().push({ kind: 'hello', watchId: '1' }, state(), { kind: 'frame', seq: 1, data: 'AAAA', width: 1280, height: 800 })
  await settle()
  assert.equal(tab.face.hooks.tab.getSnapshot().status, 'open')
  tab.face.attach('c1')
  await settle()
  assert.equal(api.handles.length, 2)
  assert.equal(api.handles[0]!.signal.aborted, true, 'the old generation was cancelled')
  assert.equal(streams[0]!.disposed, true)
  assert.equal(api.last().sessionId, 'c1')
  const fresh = tab.face.hooks.tab.getSnapshot()
  assert.equal(fresh.status, 'unknown')
  assert.equal(fresh.frame, undefined)
  assert.equal(fresh.connection, 'connecting')
  // A late item for the old target lands nowhere.
  api.handles[0]!.push(state({ title: 'old' }))
  await settle()
  assert.equal(tab.face.hooks.tab.getSnapshot().title, '')
  tab.dispose()
  await settle()
})

test('frames are asked for again on the next generation, and when the visibility changes', async () => {
  const { api, streams, tab } = make()
  tab.face.attach('s1')
  await settle()
  const first = api.last()
  tab.face.setVisible(true)
  tab.face.setVisible(true)
  assert.deepEqual(first.sent, [{ kind: 'frames', on: false }, { kind: 'frames', on: true }])
  first.push({ kind: 'hello', watchId: '1' }, state())
  await settle()
  // The carrier drops: the tab says so, and the next generation opens with what it must know again.
  first.finish()
  await settle()
  assert.equal(api.handles.length, 2)
  assert.equal(streams.length, 1, 'the same logical stream, reopened')
  const second = api.last()
  assert.deepEqual(second.sent, [{ kind: 'frames', on: true }])
  assert.equal(tab.face.hooks.tab.getSnapshot().connection, 'down')
  second.push({ kind: 'hello', watchId: '2' }, state())
  await settle()
  assert.equal(tab.face.hooks.tab.getSnapshot().connection, 'live')
  assert.deepEqual(streams[0]!.accepted, [1, 2])
  tab.face.setVisible(false)
  assert.deepEqual(second.sent, [{ kind: 'frames', on: true }, { kind: 'frames', on: false }])
  tab.dispose()
  await settle()
})

test('navigate, back, forward, reload and close are sent up; an address the bar refuses is not', async () => {
  const { api, tab } = make()
  tab.face.attach('s1')
  await settle()
  const handle = api.last()
  tab.face.navigate('  http://127.0.0.1:5173/login  ')
  tab.face.navigate('   ')
  tab.face.navigate('x'.repeat(5000))
  tab.face.back()
  tab.face.forward()
  tab.face.reload()
  tab.face.close()
  assert.deepEqual(handle.sent.slice(1), [
    { kind: 'navigate', url: 'http://127.0.0.1:5173/login' },
    { kind: 'back' }, { kind: 'forward' }, { kind: 'reload' }, { kind: 'close' },
  ])
  tab.dispose()
  await settle()
})

test('the picture\'s input and its acks go up as they are', async () => {
  const { api, tab } = make()
  tab.face.attach('s1')
  await settle()
  const handle = api.last()
  const click: Up = { kind: 'mouse', action: 'down', x: 10, y: 20, button: 'left', clickCount: 1 }
  tab.face.send(click)
  tab.face.ack(4)
  tab.face.send({ kind: 'text', text: 'hello' })
  assert.deepEqual(handle.sent.slice(1), [click, { kind: 'ack', seq: 4 }, { kind: 'text', text: 'hello' }])
  tab.dispose()
  await settle()
})

test('a notice is shown until it is dismissed', async () => {
  const { api, tab } = make()
  tab.face.attach('s1')
  await settle()
  api.last().push({ kind: 'hello', watchId: '1' }, { kind: 'notice', text: 'That address was refused.' })
  await settle()
  assert.equal(tab.face.hooks.tab.getSnapshot().notice, 'That address was refused.')
  tab.face.dismissNotice()
  assert.equal(tab.face.hooks.tab.getSnapshot().notice, undefined)
  tab.dispose()
  await settle()
})

test('two bodies on one target share one stream; the last to go stops it, and a later attach resumes from what was shown', async () => {
  const { api, tab } = make()
  tab.face.attach('s1')
  tab.face.attach('s1')
  await settle()
  assert.equal(api.handles.length, 1)
  api.last().push({ kind: 'hello', watchId: '1' }, state({ title: 'Kept' }))
  await settle()
  tab.face.detach()
  await settle()
  assert.equal(api.last().signal.aborted, false, 'one body is still there')
  tab.face.detach()
  await settle()
  assert.equal(api.last().signal.aborted, true, 'the last body went')
  // Nothing goes up with no stream, and nothing throws.
  tab.face.send({ kind: 'back' })
  tab.face.detach()
  // The title stays for the chip; the same target again resumes, connecting.
  assert.equal(tab.face.hooks.tab.getSnapshot().title, 'Kept')
  tab.face.attach('s1')
  await settle()
  assert.equal(api.handles.length, 2)
  assert.equal(tab.face.hooks.tab.getSnapshot().title, 'Kept')
  assert.equal(tab.face.hooks.tab.getSnapshot().connection, 'connecting')
  tab.dispose()
  await settle()
})

test('a send on a generation that has ended is dropped, not thrown', async () => {
  const { api, tab } = make()
  tab.face.attach('s1')
  await settle()
  const handle = api.last()
  handle.disposed = true
  assert.doesNotThrow(() => { tab.face.send({ kind: 'reload' }) })
  tab.dispose()
  await settle()
})

test('with the remote gone, the stream fails and the tab says the connection is down; dispose ends the wait', async () => {
  const { tab, available } = make()
  available.on = false
  tab.face.attach('s1')
  await settle()
  assert.equal(tab.face.hooks.tab.getSnapshot().connection, 'down')
  tab.dispose()
  await settle()
})

test('dispose stops everything, and nothing starts after it', async () => {
  const { api, streams, tab } = make()
  tab.face.attach('s1')
  await settle()
  tab.dispose()
  await settle()
  assert.equal(api.last().signal.aborted, true)
  assert.equal(streams[0]!.disposed, true)
  tab.face.attach('s2')
  await settle()
  assert.equal(api.handles.length, 1)
})

// --- the header button's presence ---------------------------------------------------------------

test('the presence watches with frames off, and shows while there is a browser or a child\'s', async () => {
  const h = harness()
  let opened = 0
  const presence = createPresence(() => h.api, h.stream, () => { opened++ })
  const shown = presence.face.hooks.shown
  assert.equal(shown.getSnapshot(), false)
  presence.face.attach('s1')
  await settle()
  const handle = h.api.last()
  assert.equal(handle.sessionId, 's1')
  handle.push({ kind: 'hello', watchId: '1' }, state({ status: 'none' }))
  await settle()
  assert.equal(shown.getSnapshot(), false)
  handle.push(state({ status: 'open' }))
  await settle()
  assert.equal(shown.getSnapshot(), true)
  handle.push(state({ status: 'closed', reason: 'closed by you' }))
  await settle()
  assert.equal(shown.getSnapshot(), false)
  handle.push({ kind: 'children', children: [{ sessionId: 'c1', label: 'coder: x' }] })
  await settle()
  assert.equal(shown.getSnapshot(), true)
  handle.push({ kind: 'children', children: [] })
  await settle()
  assert.equal(shown.getSnapshot(), false)
  // It never asks for frames: an open chat window keeps nothing alive.
  assert.ok(!handle.sent.some(item => item.kind === 'frames' && item.on), JSON.stringify(handle.sent))
  presence.face.open()
  assert.equal(opened, 1)
  presence.face.detach()
  await settle()
  assert.equal(handle.signal.aborted, true)
  presence.dispose()
  await settle()
})

test('the presence\'s shown changes only when it does, and dispose stops it', async () => {
  const h = harness()
  const presence = createPresence(() => h.api, h.stream, () => {})
  let calls = 0
  presence.face.hooks.shown.subscribe(() => { calls++ })
  presence.face.attach('s1')
  await settle()
  h.api.last().push({ kind: 'hello', watchId: '1' }, state(), state({ url: 'http://127.0.0.1:5173/b' }), state({ title: 'Other' }))
  await settle()
  assert.equal(calls, 1)
  presence.dispose()
  await settle()
  assert.equal(h.api.last().signal.aborted, true)
  presence.face.attach('s2')
  await settle()
  assert.equal(h.api.handles.length, 1)
})
