/**
 * The Browser tab's stream (`watchStream`, and `BrowserRemote.watch` through dsh's real gateway), over the core with the fake
 * driver, stub services and manual clocks. The uplink is an async queue the test feeds, as the tab does.
 *
 * - the opening (hello, the state, the children) and each status;
 * - refusals: an archived chat and an id that isn't one, each kept open and idle until the signal;
 * - frames: the newest frame or a capture when frames turn on, then paced by acks; two watchers on one screencast;
 * - input: a click reaches the page; navigate starts a browser only for a live agent; a refused URL is a notice; the uplink
 *   is read on while a navigation loads, in order;
 * - the children from crew's record; the state coalesced; bad items dropped and logged once;
 * - the end: the signal (or the remote's scope going) ends the stream and lets go of the watcher, the timers and the uplink.
 */

import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { TypertGatewayService } from '@deepseek-ai/dsh-api-gateway'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { Browsers } from '../src/browsers.ts'
import type { UserAction } from '../src/browsers.ts'
import { replayAs } from '../src/keys.ts'
import { NAMESPACE } from '../src/protocol.ts'
import type { ChildrenDown, Down, FrameDown, HelloDown, NoticeDown, StateDown, Up } from '../src/protocol.ts'
import { ARCHIVED, BrowserRemote, NOT_A_CHAT, SERVICE, browserRemote, watchStream } from '../src/remote.ts'
import type { RemoteOptions } from '../src/remote.ts'
import type { AgentHandle, Services } from '../src/services.ts'
import type { Limits } from '../src/types.ts'
import { closedText } from '../src/words.ts'
import { FakeDriver, FakePage, ManualClock, simpleRules } from './fake-driver.ts'

const VIEWPORT = { width: 1280, height: 800 }
const LIMITS: Limits = { maxBrowsers: 6, idleMinutes: 15 }
const never = new AbortController().signal
const TOKEN = `ghp_${'A1b2C3d4E5'.repeat(4)}`
const DOWN: Up = { kind: 'mouse', action: 'down', x: 10, y: 20, button: 'left', clickCount: 1 }
const UP: Up = { kind: 'mouse', action: 'up', x: 10, y: 20, button: 'left', clickCount: 1 }

// --- the world ----------------------------------------------------------------------------------------------------------

interface Child { id: string, role: string, title: string }

interface World {
  core: Browsers
  driver: FakeDriver
  /** The core's clock. */
  clock: ManualClock
  /** The stream's clock: its state and children timers, and its pacers. */
  streamClock: ManualClock
  agents: Map<string, AgentHandle>
  archived: string[]
  crew: Map<string, Child[]>
  crewFails: boolean
  logs: string[]
  options: RemoteOptions
}

const worlds: World[] = []
const dirs: string[] = []
let workspaceDir: string | undefined

after(async () => {
  for (const w of worlds) await w.core.stop()
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

/** A real directory for the live agents' workspace: `workspaceOf` takes its real path. */
async function workspace(): Promise<string> {
  if (workspaceDir === undefined) {
    const dir = await mkdtemp(join(tmpdir(), 'dish-browser-remote-'))
    dirs.push(dir)
    workspaceDir = await realpath(dir)
  }
  return workspaceDir
}

function world(options: { unavailable?: string } = {}): World {
  const driver = new FakeDriver()
  const clock = new ManualClock()
  const streamClock = new ManualClock()
  const agents = new Map<string, AgentHandle>()
  const archived: string[] = []
  const crew = new Map<string, Child[]>()
  const logs: string[] = []
  const core = new Browsers({
    driver,
    clock,
    executablePath: '/usr/bin/chromium',
    viewport: VIEWPORT,
    limits: LIMITS,
    rules: simpleRules,
    sharedTmp: false,
    own: () => ({ port: 4319, trustedHost: undefined }),
    keys: { replayAs },
    log: { info() {}, warn() {} },
    ...options.unavailable === undefined ? {} : { unavailable: options.unavailable },
  })
  const made = { core, driver, clock, streamClock, agents, archived, crew, crewFails: false, logs } as World
  const services: Services = {
    agents: () => ({ get: id => agents.get(id) }),
    sandboxPolicy: () => undefined,
    attachments: () => undefined,
    llm: () => undefined,
    workspaceRegistry: () => ({ archivedSessionIds: archived }),
    crew: () => ({
      records: {
        children: async (sessionId: string) => {
          if (made.crewFails) throw new Error('the record is unreadable')
          return crew.get(sessionId) ?? []
        },
      },
    }),
    webServer: () => undefined,
  }
  made.options = { core, services, clock: streamClock, limits: LIMITS, viewport: VIEWPORT, log: { warn: message => { logs.push(message) } } }
  worlds.push(made)
  return made
}

/** Make the session's agent live, as dsh would have it loaded, with its session's working directory. */
async function live(w: World, sessionId: string): Promise<void> {
  w.agents.set(sessionId, { id: sessionId, session: { header: { cwd: await workspace() } } })
}

/** Let promise callbacks and I/O run until `predicate` holds; real time, at most 5 s. */
async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`)
    await new Promise<void>(resolve => setImmediate(resolve))
  }
}

/** Let what is pending run, without moving either clock. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise<void>(resolve => setImmediate(resolve))
}

/** Move both clocks on by `ms`, in steps of 10 ms, letting what is pending run between them. */
async function tick(w: World, ms: number): Promise<void> {
  await settle()
  for (let left = ms; left > 0; left -= 10) {
    const step = Math.min(10, left)
    w.clock.advance(step)
    w.streamClock.advance(step)
    await settle()
  }
}

/** `waitFor`, moving both clocks on 10 ms a round. */
async function eventually(w: World, predicate: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return
    await tick(w, 10)
  }
  assert.fail(`never: ${what}`)
}

/** An uplink the test feeds while the stream runs: items pushed one by one, ended when the test says. */
class Channel<T> implements AsyncIterable<T> {
  private readonly items: T[] = []
  private ended = false
  /** Whether the reader let go (`return()`). */
  returned = false
  private wake: (() => void) | undefined

  push(...items: T[]): void {
    this.items.push(...items)
    this.signal()
  }

  end(): void {
    this.ended = true
    this.signal()
  }

  /** The items not read yet. */
  get unread(): number {
    return this.items.length
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        for (;;) {
          if (this.returned) return { value: undefined, done: true }
          const item = this.items.shift()
          if (item !== undefined) return { value: item, done: false }
          if (this.ended) return { value: undefined, done: true }
          await new Promise<void>((resolve) => { this.wake = resolve })
        }
      },
      return: async () => {
        this.returned = true
        this.signal()
        return { value: undefined, done: true }
      },
    }
  }

  private signal(): void {
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }
}

/** One `watchStream`, read as fast as it yields, as the gateway reads it. */
class Watching {
  readonly items: Down[] = []
  readonly uplink = new Channel<unknown>()
  readonly controller = new AbortController()
  done = false
  error: unknown

  constructor(options: RemoteOptions, sessionId: unknown) {
    void this.run(watchStream(options, sessionId, this.uplink, this.controller.signal))
  }

  private async run(stream: AsyncGenerator<Down>): Promise<void> {
    try {
      for await (const item of stream) {
        // What the wire carries: plain JSON, nothing undefined.
        assert.deepStrictEqual(item, JSON.parse(JSON.stringify(item)))
        this.items.push(item)
      }
    } catch (error) {
      this.error = error
    } finally {
      this.done = true
    }
  }

  send(...items: unknown[]): void {
    this.uplink.push(...items)
  }

  of<K extends Down['kind']>(kind: K): Array<Extract<Down, { kind: K }>> {
    return this.items.filter((item): item is Extract<Down, { kind: K }> => item.kind === kind)
  }

  get states(): StateDown[] { return this.of('state') }
  get frames(): FrameDown[] { return this.of('frame') }
  get notices(): string[] { return this.of('notice').map(notice => notice.text) }
  get children(): ChildrenDown[] { return this.of('children') }

  get state(): StateDown {
    const state = this.states.at(-1)
    assert.ok(state !== undefined, 'no state yet')
    return state
  }

  /** Hello, the state and the children have come. */
  async opened(): Promise<void> {
    await waitFor(() => this.items.length >= 3, 'the opening')
  }

  async end(): Promise<void> {
    this.controller.abort()
    await waitFor(() => this.done, 'the stream to end')
    assert.equal(this.error, undefined, 'the stream ended without an error')
  }
}

function watching(w: World, sessionId: unknown): Watching {
  return new Watching(w.options, sessionId)
}

function pageOf(w: World, sessionId: string): FakePage {
  const browser = w.core.browserOf(sessionId)
  assert.ok(browser !== undefined, `${sessionId} has no browser`)
  return browser.page as FakePage
}

/** The core's listeners, by looking inside (the only way to see one leak). */
function listenerCount(core: Browsers): number {
  return (core as unknown as { listeners: Set<unknown> }).listeners.size
}

/** Record each action the core gets from the tab, in order, and still do it. */
function spyOnUser(core: Browsers): string[] {
  const kinds: string[] = []
  const user = core.user.bind(core)
  core.user = (sessionId: string, action: UserAction, start: { workspace: string | undefined } | undefined) => {
    kinds.push(action.kind)
    return user(sessionId, action, start)
  }
  return kinds
}

const BLANK_STATE = {
  kind: 'state', status: 'none', reason: '', url: '', title: '', loading: false, canGoBack: false, canGoForward: false, acting: false,
  canStart: false, sandboxOff: false, viewport: VIEWPORT,
} satisfies StateDown

// --- the opening and the state ------------------------------------------------------------------------------------------

test('the opening: hello, then the state, then the children; nothing more comes by itself', async () => {
  const w = world()
  await live(w, 's1')
  w.crew.set('s1', [{ id: 'c1', role: 'coder', title: 'Fix the button' }, { id: 'c2', role: 'writer', title: 'Docs' }])
  await w.core.forAgent('c1', undefined, never)
  const a = watching(w, 's1')
  await a.opened()
  assert.deepEqual(a.items.map(item => item.kind), ['hello', 'state', 'children'])
  const hello = a.items[0] as HelloDown
  assert.equal(typeof hello.watchId, 'string')
  assert.notEqual(hello.watchId, '')
  assert.deepEqual(a.items[1], { ...BLANK_STATE, canStart: true })
  assert.deepEqual(a.items[2], { kind: 'children', children: [{ sessionId: 'c1', label: 'coder: Fix the button' }] })
  const b = watching(w, 's1')
  await b.opened()
  assert.notEqual((b.items[0] as HelloDown).watchId, hello.watchId, 'each watch has its own id')
  await tick(w, 1000)
  assert.equal(a.items.length, 3)
  assert.equal(a.done, false)
  await a.end()
  await b.end()
})

test('each status: none, open (masked), closed with its reason, unavailable', async () => {
  const w = world()
  const a = watching(w, 's1')
  await a.opened()
  assert.deepEqual(a.state, BLANK_STATE, 'none, and no live agent: the address bar can\'t start one')

  const browser = await w.core.forAgent('s1', undefined, never)
  const page = browser.page as FakePage
  page.currentTitle = `Docs ${TOKEN}`
  await page.goto(`https://ok.test/docs?token=${TOKEN}`, { timeoutMs: 1000, loadMs: 1000 })
  await eventually(w, () => a.state.status === 'open' && a.state.title !== '', 'the open state with its title')
  const open = a.state
  assert.match(open.url, /^https:\/\/ok\.test\/docs\?token=/)
  assert.ok(!open.url.includes(TOKEN), 'the URL is masked')
  assert.match(open.title, /^Docs /)
  assert.ok(!open.title.includes(TOKEN), 'the title is masked')
  assert.deepEqual({ ...open, url: '', title: '' }, { ...BLANK_STATE, status: 'open', canGoBack: true })

  await w.core.close('s1', 'idle')
  await eventually(w, () => a.state.status === 'closed', 'the closed state')
  assert.deepEqual(a.state, { ...BLANK_STATE, status: 'closed', reason: closedText('idle', LIMITS) })
  assert.equal(a.state.reason, 'unused for 15 minutes')

  await live(w, 's1')
  w.core.touch('s1')
  await eventually(w, () => a.state.canStart, 'canStart once the agent is live')
  assert.deepEqual(a.state, { ...BLANK_STATE, status: 'closed', reason: 'unused for 15 minutes', canStart: true })
  await a.end()

  const none = world({ unavailable: '/usr/bin/chromium' })
  await live(none, 's1')
  const u = watching(none, 's1')
  await u.opened()
  assert.deepEqual(u.state, {
    ...BLANK_STATE, status: 'unavailable', reason: 'No browser on this host: dish-browser found no Chromium at /usr/bin/chromium.',
  })
  await u.end()
})

test('the state while an agent\'s call runs says acting', async () => {
  const w = world()
  const browser = await w.core.forAgent('s1', undefined, never)
  const a = watching(w, 's1')
  await a.opened()
  const hold = (browser.page as FakePage).hold('click')
  const call = browser.call(never, page => page.click({ ref: 'e1' }, { timeoutMs: 5000, double: false }))
  await hold.reached
  await eventually(w, () => a.state.acting, 'acting')
  hold.release()
  await call
  await eventually(w, () => !a.state.acting, 'acting no more')
  await a.end()
})

test('the state is coalesced: at most one per 100 ms, and the newest wins', async () => {
  const w = world()
  const a = watching(w, 's1')
  await a.opened()
  assert.equal(a.states.length, 1)
  for (let i = 0; i < 10; i++) w.core.touch('s1')
  await live(w, 's1')
  w.core.touch('s1')
  await settle()
  assert.equal(a.states.length, 1, 'within 100 ms of the opening state: none yet')
  await tick(w, 100)
  assert.equal(a.states.length, 2)
  assert.equal(a.state.canStart, true, 'the newest')
  await tick(w, 500)
  assert.equal(a.states.length, 2, 'nothing changed since')
  // After a quiet spell a change goes at once; the next within 100 ms waits.
  w.core.touch('s1')
  await settle()
  assert.equal(a.states.length, 3)
  w.core.touch('s1')
  w.core.touch('s1')
  await settle()
  assert.equal(a.states.length, 3)
  await tick(w, 100)
  assert.equal(a.states.length, 4)
  await a.end()
})

// --- refusals -----------------------------------------------------------------------------------------------------------

test('refusals: an archived chat, and an id that isn\'t one, are refused; the stream stays open and idle until the signal', async () => {
  const w = world()
  w.archived.push('s9')
  await live(w, 's9')
  await w.core.forAgent('s9', undefined, never)
  const opened = pageOf(w, 's9')
  const cases: Array<[unknown, string]> = [
    ['s9', ARCHIVED], [5, NOT_A_CHAT], ['', NOT_A_CHAT], ['x'.repeat(257), NOT_A_CHAT], [undefined, NOT_A_CHAT], [null, NOT_A_CHAT],
    [{ id: 's9' }, NOT_A_CHAT],
  ]
  for (const [id, reason] of cases) {
    const a = watching(w, id)
    await waitFor(() => a.items.length === 2, 'the refusal')
    assert.equal(a.items[0]?.kind, 'hello')
    assert.deepEqual(a.items[1], { ...BLANK_STATE, status: 'refused', reason })
    // What the tab sends is read, so the uplink never fills, and goes nowhere.
    a.send({ kind: 'frames', on: true }, DOWN, UP, { kind: 'navigate', url: 'example.test' }, { kind: 'close' }, { kind: 'bad' })
    await waitFor(() => a.uplink.unread === 0, 'the uplink read')
    await tick(w, 1000)
    assert.equal(a.items.length, 2, `${String(id)}: idle`)
    assert.equal(a.done, false, `${String(id)}: open`)
    await a.end()
    assert.equal(a.uplink.returned, true)
  }
  assert.equal(ARCHIVED, 'This chat is archived.')
  assert.equal(NOT_A_CHAT, 'That isn\'t a chat.')
  assert.equal(opened.screencasting, false)
  assert.deepEqual(opened.callsOf('mouse'), [])
  assert.deepEqual(opened.callsOf('goto'), [])
  assert.equal(w.core.isOpen('s9'), true, 'the tab\'s close went nowhere')
  assert.deepEqual(w.logs, [], 'a refused stream logs nothing')
  assert.equal(listenerCount(w.core), 0)

  const longest = watching(w, 'x'.repeat(256))
  await longest.opened()
  assert.equal(longest.state.status, 'none', '256 characters is an id')
  await longest.end()
})

test('an unreadable registry refuses nothing', async () => {
  const w = world()
  w.options = { ...w.options, services: { ...w.options.services, workspaceRegistry: () => { throw new Error('gone') } } }
  const a = watching(w, 's1')
  await a.opened()
  assert.equal(a.state.status, 'none')
  await a.end()
})

// --- frames -------------------------------------------------------------------------------------------------------------

test('frames on: the newest frame at once, then paced by acks: one in flight, the newest kept, at most 15 a second', async () => {
  const w = world()
  const page = pageOf(w, (await w.core.forAgent('s1', undefined, never)).sessionId)
  // An earlier watcher saw a frame: the core keeps the newest.
  const earlier = w.core.watch('s1')
  earlier.setFrames(true)
  await settle()
  page.frame('one')
  earlier.close()
  await settle()
  assert.equal(page.screencasting, false)

  const a = watching(w, 's1')
  await a.opened()
  await tick(w, 500)
  assert.equal(a.frames.length, 0, 'a watch starts with frames off')
  a.send({ kind: 'frames', on: true })
  await waitFor(() => a.frames.length === 1, 'the newest frame')
  const first = a.frames[0]!
  assert.deepEqual(first, { kind: 'frame', seq: first.seq, data: 'one', width: 1280, height: 800 })
  await settle()
  assert.equal(page.screencasting, true, 'frames on runs the screencast')
  assert.deepEqual(page.callsOf('capture'), [], 'no capture: there was a frame')

  page.frame('two')
  page.frame('three')
  await tick(w, 500)
  assert.equal(a.frames.length, 1, 'one in flight until its ack')
  a.send({ kind: 'ack', seq: first.seq + 1000 })
  await tick(w, 100)
  assert.equal(a.frames.length, 1, 'a stray ack releases nothing')
  a.send({ kind: 'ack', seq: first.seq })
  await waitFor(() => a.frames.length === 2, 'the next frame')
  assert.equal(a.frames[1]!.data, 'three', 'the newest kept')

  // An ack at once still waits out the interval: 15 a second.
  page.frame('four')
  a.send({ kind: 'ack', seq: a.frames[1]!.seq })
  await settle()
  assert.equal(a.frames.length, 2)
  await tick(w, 70)
  assert.equal(a.frames.length, 3)
  assert.equal(a.frames[2]!.data, 'four')
  await a.end()
})

test('frames on with no frame yet: a fresh capture; with a closed browser, its last frame; with none, nothing', async () => {
  const w = world()
  await w.core.forAgent('s1', undefined, never)
  const a = watching(w, 's1')
  await a.opened()
  a.send({ kind: 'frames', on: true })
  await waitFor(() => a.frames.length === 1, 'a capture')
  assert.equal(a.frames[0]!.data, 'capture')
  assert.equal(pageOf(w, 's1').callsOf('capture').length, 1)
  await a.end()

  await w.core.close('s1', 'tab')
  const b = watching(w, 's1')
  await b.opened()
  assert.equal(b.state.status, 'closed')
  b.send({ kind: 'frames', on: true })
  await waitFor(() => b.frames.length === 1, 'the closed browser\'s last frame')
  assert.equal(b.frames[0]!.data, 'capture')
  await b.end()

  const c = watching(w, 's2')
  await c.opened()
  c.send({ kind: 'frames', on: true })
  await tick(w, 500)
  assert.deepEqual(c.frames, [])
  await c.end()
})

test('frames off: nothing more is sent, and the screencast stops with the last frames-on watcher', async () => {
  const w = world()
  await w.core.forAgent('s1', undefined, never)
  const page = pageOf(w, 's1')
  const a = watching(w, 's1')
  await a.opened()
  a.send({ kind: 'frames', on: true })
  await waitFor(() => a.frames.length === 1, 'a frame')
  await settle()
  assert.equal(page.screencasting, true)
  a.send({ kind: 'ack', seq: a.frames[0]!.seq }, { kind: 'frames', on: false })
  await waitFor(() => !page.screencasting, 'the screencast to stop')
  await tick(w, 500)
  assert.equal(a.frames.length, 1)
  // Off again changes nothing; on again starts over with the newest frame.
  a.send({ kind: 'frames', on: false }, { kind: 'frames', on: true })
  await waitFor(() => a.frames.length === 2, 'the newest frame again')
  assert.equal(a.frames[1]!.seq, a.frames[0]!.seq, 'the same frame, number and all')
  await a.end()
})

test('two watchers on one session: one screencast, each paced on its own', async () => {
  const w = world()
  await w.core.forAgent('s1', undefined, never)
  const page = pageOf(w, 's1')
  const a = watching(w, 's1')
  const b = watching(w, 's1')
  await a.opened()
  await b.opened()
  a.send({ kind: 'frames', on: true })
  b.send({ kind: 'frames', on: true })
  await waitFor(() => a.frames.length === 1 && b.frames.length === 1, 'a frame each')
  await settle()
  assert.equal(page.callsOf('startScreencast').length, 1, 'one screencast')
  await tick(w, 100)
  page.frame('x')
  await settle()
  a.send({ kind: 'ack', seq: a.frames[0]!.seq })
  await waitFor(() => a.frames.length === 2, 'the next frame for the one that acked')
  assert.equal(a.frames[1]!.data, 'x')
  await tick(w, 200)
  assert.equal(b.frames.length, 1, 'the other hasn\'t acked: nothing for it')
  b.send({ kind: 'ack', seq: b.frames[0]!.seq })
  await waitFor(() => b.frames.length === 2, 'its next frame, once it acks')
  assert.equal(b.frames[1]!.data, 'x')
  await a.end()
  await settle()
  assert.equal(page.screencasting, true, 'one watcher still has frames on')
  await b.end()
  await waitFor(() => !page.screencasting, 'the screencast to stop with the last')
})

// --- input --------------------------------------------------------------------------------------------------------------

test('a click from the tab reaches the page, clamped to the viewport; keys and text too', async () => {
  const w = world()
  await w.core.forAgent('s1', undefined, never)
  const page = pageOf(w, 's1')
  const a = watching(w, 's1')
  await a.opened()
  a.send(
    { kind: 'mouse', action: 'move', x: 5000, y: -3, button: 'left', clickCount: 1 },
    DOWN, UP,
    { kind: 'wheel', x: 1, y: 1, dx: 0, dy: 99_999 },
    { kind: 'key', action: 'down', key: 'é', code: 'Digit2', modifiers: 0 },
    { kind: 'key', action: 'down', key: 'Enter', code: 'Enter', modifiers: 0 },
    { kind: 'key', action: 'up', key: 'Enter', code: 'Enter', modifiers: 0 },
    { kind: 'text', text: 'pasted' },
  )
  await waitFor(() => page.callsOf('insertText').length === 2, 'the input replayed')
  const replayed = page.calls.filter(call => ['mouse', 'wheel', 'keyDown', 'keyUp', 'insertText'].includes(call.method))
  assert.deepEqual(replayed, [
    { method: 'mouse', args: ['move', 1279, 0, 'left', 1] },
    { method: 'mouse', args: ['down', 10, 20, 'left', 1] },
    { method: 'mouse', args: ['up', 10, 20, 'left', 1] },
    { method: 'wheel', args: [1, 1, 0, 10_000] },
    { method: 'insertText', args: ['é'] },
    { method: 'keyDown', args: ['Enter'] },
    { method: 'keyUp', args: ['Enter'] },
    { method: 'insertText', args: ['pasted'] },
  ])
  await a.end()
})

test('navigate starts a browser only for a live agent (canStart), in its workspace', async () => {
  const w = world()
  const a = watching(w, 's1')
  await a.opened()
  assert.equal(a.state.canStart, false)
  a.send({ kind: 'navigate', url: 'example.test/a' })
  await waitFor(() => a.notices.length === 1, 'the notice')
  assert.deepEqual(a.notices, ['A page opens here once this chat\'s agent is running.'])
  assert.equal(w.driver.launches.length, 0)

  await live(w, 's1')
  w.core.touch('s1')
  await eventually(w, () => a.state.canStart, 'canStart')
  a.send({ kind: 'navigate', url: 'example.test/a' })
  await eventually(w, () => a.state.status === 'open' && a.state.url === 'https://example.test/a', 'the page open')
  assert.equal(a.state.canStart, false, 'there is a browser now')
  assert.equal(w.core.browserOf('s1')?.workspace, await workspace())
  assert.equal(w.driver.launches.length, 1)
  await a.end()
})

test('a refused URL becomes a notice, and starts nothing', async () => {
  const w = world()
  await live(w, 's1')
  const a = watching(w, 's1')
  await a.opened()
  a.send({ kind: 'navigate', url: 'blocked.test' })
  await waitFor(() => a.notices.length === 1, 'the notice')
  assert.deepEqual(a.notices, ['blocked.test is blocked.'])
  assert.equal(w.driver.launches.length, 0)
  await a.end()
})

test('notices keep the newest 20 for a reader that is behind', async () => {
  const w = world()
  // A reader that has stopped: nothing is read past the opening until all 25 notices are in.
  const paused = watchStream(w.options, 's1', new Channel<unknown>(), never)
  const items: Down[] = []
  for (let i = 0; i < 3; i++) items.push((await paused.next()).value as Down)
  assert.deepEqual(items.map(item => item.kind), ['hello', 'state', 'children'])
  for (let i = 1; i <= 25; i++) w.core.user('s1', { kind: 'navigate', url: `blocked.test/${i}` }, undefined).catch(() => {})
  await settle()
  const rest: string[] = []
  for (let i = 0; i < 20; i++) rest.push(((await paused.next()).value as NoticeDown).text)
  assert.equal(rest.length, 20)
  assert.deepEqual(rest, Array.from({ length: 20 }, () => 'blocked.test is blocked.'))
  await paused.return(undefined)
  assert.equal(listenerCount(w.core), 0)
})

test('the uplink is read on while a navigation loads, and the tab\'s actions keep their order', async () => {
  const w = world()
  await live(w, 's1')
  await w.core.forAgent('s1', undefined, never)
  const page = pageOf(w, 's1')
  const kinds = spyOnUser(w.core)
  const a = watching(w, 's1')
  await a.opened()
  const hold = page.hold('goto')
  a.send({ kind: 'navigate', url: 'example.test/slow' }, DOWN, UP, { kind: 'reload' }, DOWN, UP)
  await hold.reached
  await waitFor(() => page.callsOf('mouse').length === 4, 'the clicks, while the navigation is held')
  assert.deepEqual(kinds, ['navigate', 'mouse', 'mouse', 'reload', 'mouse', 'mouse'])
  hold.release()
  await eventually(w, () => a.state.url === 'https://example.test/slow', 'the navigation')
  await a.end()
})

test('back, forward, reload and close from the tab', async () => {
  const w = world()
  await live(w, 's1')
  const a = watching(w, 's1')
  await a.opened()
  a.send({ kind: 'navigate', url: 'example.test/1' })
  await eventually(w, () => a.state.url === 'https://example.test/1', 'the first page')
  a.send({ kind: 'navigate', url: 'example.test/2' })
  await eventually(w, () => a.state.url === 'https://example.test/2', 'the second page')
  a.send({ kind: 'back' })
  await eventually(w, () => a.state.url === 'https://example.test/1', 'back')
  a.send({ kind: 'forward' })
  await eventually(w, () => a.state.url === 'https://example.test/2', 'forward')
  a.send({ kind: 'reload' })
  await waitFor(() => pageOf(w, 's1').callsOf('reload').length === 1, 'the reload')
  a.send({ kind: 'close' })
  await eventually(w, () => a.state.status === 'closed', 'closed')
  assert.equal(a.state.reason, 'closed in the Browser tab')
  await a.end()
})

// --- children -----------------------------------------------------------------------------------------------------------

test('children: crew\'s record, filtered to open browsers, sent again 200 ms after a browser opens or closes', async () => {
  const w = world()
  w.crew.set('s1', [
    { id: 'c1', role: 'coder', title: 'Fix the button' },
    { id: 'c2', role: 'reviewer', title: '' },
    { id: 'c3', role: 'writer', title: `Docs ${TOKEN}\nand a second line ${'x'.repeat(100)}` },
  ])
  const a = watching(w, 's1')
  await a.opened()
  assert.deepEqual(a.children.at(-1)?.children, [])

  await w.core.forAgent('c1', undefined, never)
  await w.core.forAgent('c2', undefined, never)
  await tick(w, 150)
  assert.equal(a.children.length, 1, 'not yet: debounced')
  await tick(w, 60)
  assert.equal(a.children.length, 2, 'one list for both')
  assert.deepEqual(a.children.at(-1)?.children, [{ sessionId: 'c1', label: 'coder: Fix the button' }, { sessionId: 'c2', label: 'reviewer' }])

  await w.core.forAgent('c3', undefined, never)
  await tick(w, 210)
  const c3 = a.children.at(-1)?.children.find(child => child.sessionId === 'c3')
  assert.ok(c3 !== undefined)
  assert.ok(!c3.label.includes(TOKEN), 'masked')
  assert.ok(!c3.label.includes('\n'), 'one line')
  assert.ok(c3.label.length <= 80, 'cut to 80')
  assert.match(c3.label, /^writer: Docs /)

  await w.core.close('c1', 'agent')
  await tick(w, 210)
  assert.deepEqual(a.children.at(-1)?.children.map(child => child.sessionId), ['c2', 'c3'])

  // Another session's browser opening sends the list again; a record that can't be read is no children.
  w.crewFails = true
  await w.core.forAgent('elsewhere', undefined, never)
  await tick(w, 210)
  assert.deepEqual(a.children.at(-1)?.children, [])
  await a.end()
})

test('children with no crew running: none', async () => {
  const w = world()
  w.options = { ...w.options, services: { ...w.options.services, crew: () => undefined } }
  const a = watching(w, 's1')
  await a.opened()
  assert.deepEqual(a.children.at(-1), { kind: 'children', children: [] })
  await a.end()
})

// --- bad items ----------------------------------------------------------------------------------------------------------

test('bad items are dropped and logged once, the rest counted; the stream goes on', async () => {
  const w = world()
  await w.core.forAgent('s1', undefined, never)
  const page = pageOf(w, 's1')
  const a = watching(w, 's1')
  await a.opened()
  a.send(
    { kind: 'nope' },
    { kind: 'mouse', action: 'down', x: 'a', y: 1, button: 'left', clickCount: 1 },
    { kind: 'text', text: '' },
    { kind: 'key', action: 'down', key: 'secret-typed-words', code: 'KeyA', modifiers: 0 },
    'junk',
    DOWN,
  )
  await waitFor(() => page.callsOf('mouse').length === 1, 'the good item')
  assert.deepEqual(w.logs, ['dropped an item from the Browser tab (unknown kind)'])
  assert.equal(a.done, false)
  await a.end()
  assert.deepEqual(w.logs, ['dropped an item from the Browser tab (unknown kind)', 'dropped 4 more items from the Browser tab'])
  for (const line of w.logs) assert.doesNotMatch(line, /secret-typed/)
})

// --- the end ------------------------------------------------------------------------------------------------------------

test('the end: the signal ends the stream, closes the watcher (its frames-on count falls) and lets go of everything', async () => {
  const w = world()
  await w.core.forAgent('s1', undefined, never)
  const page = pageOf(w, 's1')
  assert.equal(listenerCount(w.core), 0)
  const a = watching(w, 's1')
  await a.opened()
  assert.equal(listenerCount(w.core), 1)
  a.send({ kind: 'frames', on: true })
  await waitFor(() => a.frames.length === 1, 'a frame')
  await settle()
  assert.equal(page.screencasting, true)
  // A disposed agent's browser is held while a frames-on watcher watches it; its change sets a state timer.
  w.core.agentDisposed('s1')
  // A children timer and a pending frame too, all left behind by the end.
  await w.core.forAgent('other', undefined, never)
  page.frame('pending')
  await settle()
  assert.ok(w.streamClock.pending > 0)
  assert.equal(w.core.isOpen('s1'), true)

  await a.end()
  await settle()
  assert.equal(w.core.isOpen('s1'), false, 'the last frames-on watcher left: the held browser closed')
  assert.equal(w.core.view('s1').reason, 'agent')
  assert.equal(w.streamClock.pending, 0, 'no timer left')
  assert.equal(listenerCount(w.core), 0, 'unsubscribed')
  assert.equal(a.uplink.returned, true, 'the uplink let go')
  const count = a.items.length
  w.core.touch('other')
  await tick(w, 500)
  assert.equal(a.items.length, count)
})

test('a signal aborted before the start: nothing at all', async () => {
  const w = world()
  const controller = new AbortController()
  controller.abort()
  const items: Down[] = []
  for await (const item of watchStream(w.options, 's1', new Channel<unknown>(), controller.signal)) items.push(item)
  assert.deepEqual(items, [])
  assert.equal(listenerCount(w.core), 0)
})

test('an uplink that ends leaves the stream open; one that fails is logged once and the stream stays open', async () => {
  const w = world()
  const a = watching(w, 's1')
  await a.opened()
  a.uplink.end()
  await tick(w, 500)
  assert.equal(a.done, false)
  await a.end()

  const failing: AsyncIterable<unknown> = {
    [Symbol.asyncIterator]: () => ({ next: async () => { throw new Error('the carrier broke at http://secret.test/') } }),
  }
  const controller = new AbortController()
  const items: Down[] = []
  let done = false
  void (async () => {
    for await (const item of watchStream(w.options, 's1', failing, controller.signal)) items.push(item)
    done = true
  })()
  await waitFor(() => items.length === 3, 'the opening')
  await tick(w, 500)
  assert.equal(done, false)
  assert.deepEqual(w.logs, ['stopped reading the Browser tab\'s input for s1: its uplink failed'])
  controller.abort()
  await waitFor(() => done, 'the end')
})

/** An uplink that never sends, and fails its pending read when `signal` aborts, as the gateway's does (`gateway/cancelled`). */
function cancelling(signal: AbortSignal): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: () => new Promise<IteratorResult<unknown>>((_resolve, reject) => {
        const fail = (): void => { reject(Object.assign(new Error('Remote invocation "dishBrowser/watch" was aborted'), { code: 'gateway/cancelled' })) }
        if (signal.aborted) fail()
        else signal.addEventListener('abort', fail, { once: true })
      }),
      return: async () => ({ value: undefined, done: true }),
    }),
  }
}

test('the abort failing the uplink\'s pending read, as the gateway\'s does, is the end and no fault: nothing is logged', async () => {
  const w = world()
  const controller = new AbortController()
  const stream = watchStream(w.options, 's1', cancelling(controller.signal), controller.signal)
  for (let i = 0; i < 3; i++) await stream.next()
  // Nobody reads the stream now, so the read's failure is handled before the stream sees its end.
  controller.abort()
  await settle()
  assert.deepEqual(w.logs, [])
  assert.deepEqual(await stream.next(), { value: undefined, done: true })
  assert.equal(listenerCount(w.core), 0)
})

// --- the service --------------------------------------------------------------------------------------------------------

/** A context with dsh's Typert registry and gateway, and a `session` lookup as dsh-session registers one. */
async function withGateway(body: (ctx: Context) => Promise<void>): Promise<void> {
  const ctx = new Context()
  const registry = ctx.plugin(TypertRegistry)
  await registry
  const lookup = ctx.typert.lookups.register('session', {
    parameter: 'session',
    wire: 'sessionId',
    hostTypeSymbol: '@deepseek-ai/dsh-session#Session',
    wireTypeSymbol: '@deepseek-ai/dsh-session/types#SessionId',
    resolve: () => undefined,
  })
  const gateway = ctx.plugin(TypertGatewayService, {})
  await gateway
  try {
    await body(ctx)
  } finally {
    await gateway.dispose()
    lookup()
    await registry.dispose()
  }
}

/** `promise`, or a failure naming `what` when it takes longer than `ms`. */
async function within<T>(promise: Promise<T>, what: string, ms = 5000): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { reject(new Error(`timed out waiting for ${what}`)) }, ms)
  })
  try {
    return await Promise.race([promise, late])
  } finally {
    clearTimeout(timer)
  }
}

test('through dsh\'s real gateway: hello and the state arrive, frames and a click from the uplink reach the core, the abort ends it', async () => {
  const w = world()
  await live(w, 's1')
  await w.core.forAgent('s1', undefined, never)
  const page = pageOf(w, 's1')
  await withGateway(async (ctx) => {
    const remote = ctx.plugin(BrowserRemote, w.options)
    await remote
    try {
      const uplink = new Channel<unknown>()
      const controller = new AbortController()
      const stream = await ctx.typertGateway.stream({ namespace: NAMESPACE, method: 'watch', args: { sessionId: 's1' }, uplink, signal: controller.signal })
      const it = stream[Symbol.asyncIterator]()
      const hello = await within(it.next(), 'hello')
      assert.equal((hello.value as Down).kind, 'hello')
      const state = await within(it.next(), 'the state')
      assert.equal((state.value as StateDown).status, 'open')
      assert.equal(((await within(it.next(), 'the children')).value as Down).kind, 'children')

      uplink.push({ kind: 'frames', on: true }, DOWN, UP)
      let frame: FrameDown | undefined
      while (frame === undefined) {
        const next = await within(it.next(), 'a frame')
        if ((next.value as Down).kind === 'frame') frame = next.value as FrameDown
      }
      assert.equal(frame.data, 'capture')
      await waitFor(() => page.callsOf('mouse').length === 2, 'the click on the page')
      assert.deepEqual(page.callsOf('mouse'), [['down', 10, 20, 'left', 1], ['up', 10, 20, 'left', 1]])
      assert.equal(page.screencasting, true)

      const pending = it.next()
      controller.abort()
      await assert.rejects(within(pending, 'the end after the abort'), (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'gateway/cancelled')
        return true
      })
      await waitFor(() => !page.screencasting, 'the watcher to close')
      assert.equal(uplink.returned, true, 'the uplink let go')
      assert.equal(listenerCount(w.core), 0)
      assert.equal((await within(it.next(), 'a read after the end')).done, true)
    } finally {
      await remote.dispose()
    }
  })
  assert.deepEqual(w.logs, [])
})

test('browserRemote mounts the service; called without the gateway it reads no uplink; the scope going ends open watches', async () => {
  const w = world()
  await w.core.forAgent('s1', undefined, never)
  const ctx = new Context()
  const fork = ctx.plugin((inner: Context) => { browserRemote(inner, w.options) })
  await fork
  await waitFor(() => ctx.get(SERVICE) !== undefined, 'the service')
  const remote = ctx.get(SERVICE) as BrowserRemote | undefined
  assert.ok(remote instanceof BrowserRemote)
  const controller = new AbortController()
  const items: Down[] = []
  let done = false
  void (async () => {
    for await (const item of remote.watch('s1', controller.signal)) items.push(item)
    done = true
  })()
  await waitFor(() => items.length === 3, 'the opening')
  assert.equal((items[1] as StateDown).status, 'open')
  assert.equal(listenerCount(w.core), 1)
  await fork.dispose()
  await waitFor(() => done, 'the end with the scope')
  assert.equal(listenerCount(w.core), 0)
  assert.equal(controller.signal.aborted, false, 'its own signal never aborted')
})
