/**
 * The core (`Browsers`), over the fake driver and a manual clock: Chromium's launch, fallback, linger and loss; each
 * session's browser, the cap and eviction, the waits; disposal, the sweep and the stop; the route; the watchers and the
 * screencast; and the user's actions from the Browser tab. No log line holds a URL.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { after, test } from 'node:test'
import { BrowserError, Browsers } from '../src/browsers.ts'
import type { BrowsersOptions, CoreEvent } from '../src/browsers.ts'
import { systemClock } from '../src/clock.ts'
import { DriverTimeout } from '../src/driver.ts'
import { CONTROL } from '../src/protocol.ts'
import { CAP_WAIT_MS, LINGER_MS, STOP_MS } from '../src/types.ts'
import type { TabNotice } from '../src/types.ts'
import { FakeContext, FakeDriver, FakePage, ManualClock, deferred, flush, simpleRules } from './fake-driver.ts'
import type { Hold } from './fake-driver.ts'

const VIEWPORT = { width: 1280, height: 800 }
const never = new AbortController().signal
const URL_IN_LOG = /https?:|file:/

interface World {
  core: Browsers
  driver: FakeDriver
  clock: ManualClock
  events: CoreEvent[]
  logs: Array<{ level: 'info' | 'warn', message: string }>
  /** The notices for a session, in order. */
  notices(sessionId: string): TabNotice[]
}

/** Every world made, so that `after` checks every log line of the file. */
const worlds: World[] = []
after(() => { for (const w of worlds) noUrlsLogged(w) })

function world(options: Partial<BrowsersOptions> = {}): World {
  const driver = new FakeDriver()
  const clock = new ManualClock()
  const logs: World['logs'] = []
  const events: CoreEvent[] = []
  const core = new Browsers({
    driver,
    clock,
    executablePath: '/usr/bin/chromium',
    viewport: VIEWPORT,
    limits: { maxBrowsers: 6, idleMinutes: 15 },
    rules: simpleRules,
    sharedTmp: false,
    own: () => ({ port: 4319, trustedHost: undefined }),
    keys: { replayAs: key => key === 'Nope' ? undefined : [...key].length === 1 && /[^\x20-\x7e]/.test(key) ? 'text' : 'key' },
    log: { info: message => { logs.push({ level: 'info', message }) }, warn: message => { logs.push({ level: 'warn', message }) } },
    ...options,
  })
  core.subscribe(event => { events.push(event) })
  const made: World = {
    core, driver, clock, events, logs,
    notices: sessionId => events.flatMap(event => event.kind === 'notice' && event.sessionId === sessionId ? [event.notice] : []),
  }
  worlds.push(made)
  return made
}

/** The page of the session's open browser. */
function pageOf(w: World, sessionId: string): FakePage {
  const browser = w.core.browserOf(sessionId)
  assert.ok(browser !== undefined, `${sessionId} has no browser open`)
  return browser.page as FakePage
}

function noUrlsLogged(w: World): void {
  for (const { message } of w.logs) assert.doesNotMatch(message, URL_IN_LOG, `a log line holds a URL: ${message}`)
}

const isCode = (code: string, detail?: string) => (error: unknown) =>
  error instanceof BrowserError && error.code === code && (detail === undefined || error.detail === detail)

/** Start a call on the session's browser that stays in flight until the hold is released. */
async function busyCall(w: World, sessionId: string): Promise<{ hold: Hold, done: Promise<unknown> }> {
  const browser = await w.core.forAgent(sessionId, undefined, never)
  const hold = (browser.page as FakePage).hold('click')
  const done = browser.call(never, page => page.click({ ref: 'e1' }, { timeoutMs: 5000, double: false }))
  done.catch(() => {})
  await hold.reached
  return { hold, done }
}

// --- launching --------------------------------------------------------------------------------------------------------

test('first use launches Chromium with its sandbox and opens a browser; a second call reuses it; another session shares Chromium', async () => {
  const w = world()
  const first = await w.core.forAgent('s1', '/work/a', never)
  assert.deepEqual(w.driver.launches, [{ executablePath: '/usr/bin/chromium', sandbox: true }])
  assert.equal(w.driver.browser.contexts.length, 1)
  assert.deepEqual(w.driver.browser.contexts[0]?.viewport, VIEWPORT)
  assert.equal(first.workspace, '/work/a')
  assert.equal(await w.core.forAgent('s1', undefined, never), first)
  assert.equal(first.workspace, '/work/a')
  assert.equal((await w.core.forAgent('s1', '/work/b', never)).workspace, '/work/b')
  await w.core.forAgent('s2', undefined, never)
  assert.equal(w.driver.launches.length, 1)
  assert.equal(w.driver.browser.contexts.length, 2)
  assert.equal(w.core.isOpen('s1'), true)
  assert.equal(w.core.isOpen('s3'), false)
  assert.deepEqual(w.events.filter(event => event.kind === 'opened').map(event => event.sessionId), ['s1', 's2'])
  assert.ok(w.logs.some(log => log.message === 'launched Chromium (sandbox on)'))
  assert.ok(w.logs.some(log => log.message === 'opened a browser for s1 (1 open)'))
  assert.ok(w.logs.some(log => log.message === 'opened a browser for s2 (2 open)'))
  noUrlsLogged(w)
})

test('one launch at a time: callers share it; two first calls of one session share one browser', async () => {
  const w = world()
  const hold = w.driver.holdLaunch()
  const a1 = w.core.forAgent('s1', undefined, never)
  const a2 = w.core.forAgent('s1', undefined, never)
  const b = w.core.forAgent('s2', undefined, never)
  await hold.reached
  hold.release()
  const [x, y] = await Promise.all([a1, a2, b])
  assert.equal(x, y)
  assert.equal(w.driver.launches.length, 1)
  assert.equal(w.driver.browser.contexts.length, 2)
})

test('the sandbox fallback: a sandbox error launches without it, warns once, and the view says so', async () => {
  const w = world()
  w.driver.failLaunches = ['browserType.launch: Target page, context or browser has been closed\n[err] No usable sandbox! see https://example.test/x']
  await w.core.forAgent('s1', undefined, never)
  assert.deepEqual(w.driver.launches.map(launch => launch.sandbox), [true, false])
  assert.equal(w.core.view('s1').sandboxOff, true)
  const warnings = w.logs.filter(log => log.level === 'warn')
  assert.deepEqual(warnings.map(log => log.message), ['Chromium started without its own sandbox: browserType.launch: Target page, context or browser has been closed'])
  assert.ok(w.logs.some(log => log.message === 'launched Chromium (sandbox off)'))
  // A relaunch that needs the fallback again doesn't warn again.
  w.driver.browser.disconnect()
  w.driver.failLaunches = ['Failed to move to new namespace: Operation not permitted']
  await w.core.forAgent('s1', undefined, never)
  assert.equal(w.logs.filter(log => log.message.startsWith('Chromium started without')).length, 1)
  noUrlsLogged(w)
})

test('a launch that fails twice is wont-start with its first line, cut to 200; nothing is kept, so the next call tries again', async () => {
  const w = world()
  w.driver.failLaunches = ['No usable sandbox!', `Chromium crashed at start\n${'detail '.repeat(100)}`]
  await assert.rejects(w.core.forAgent('s1', undefined, never), isCode('wont-start', 'Chromium crashed at start'))
  w.driver.failLaunches = [`${'x'.repeat(300)}\nmore`]
  await assert.rejects(w.core.forAgent('s1', undefined, never), (error: unknown) => isCode('wont-start')(error) && (error as BrowserError).detail.length === 200)
  assert.equal(w.driver.launches.length, 3)
  await w.core.forAgent('s1', undefined, never)
  assert.equal(w.driver.launches.length, 4)
  assert.equal(w.core.view('s1').sandboxOff, false)
  assert.equal(w.core.view('s1').status, 'open')
})

test('unavailable: no launch, the error names the path, and the view says unavailable', async () => {
  const w = world({ unavailable: '/usr/bin/chromium' })
  assert.equal(w.core.unavailable, '/usr/bin/chromium')
  await assert.rejects(w.core.forAgent('s1', undefined, never), isCode('unavailable', '/usr/bin/chromium'))
  assert.equal(w.driver.launches.length, 0)
  assert.equal(w.core.view('s1').status, 'unavailable')
})

// --- the cap ----------------------------------------------------------------------------------------------------------

test('eviction past maxBrowsers closes the least recently used browser not in a call, watched or not; its next call gets the note', async () => {
  const w = world({ limits: { maxBrowsers: 3, idleMinutes: 15 } })
  const oldest = await busyCall(w, 's1')          // the oldest, but in a call
  w.clock.advance(1000)
  await (await w.core.forAgent('s2', undefined, never)).call(never, async () => {})
  w.clock.advance(1000)
  await (await w.core.forAgent('s3', undefined, never)).call(never, async () => {})
  w.core.watch('s2').setFrames(false)             // a frames-off watch: no protection, and no hold either
  w.clock.advance(1000)
  await w.core.forAgent('s4', undefined, never)
  assert.equal(w.core.isOpen('s1'), true)
  assert.equal(w.core.isOpen('s2'), false)
  assert.equal(w.core.isOpen('s3'), true)
  assert.deepEqual(w.core.view('s2'), { status: 'closed', reason: 'evicted', url: '', title: '', loading: false, canGoBack: false, canGoForward: false, acting: false, sandboxOff: false })
  assert.ok(w.events.some(event => event.kind === 'closed' && event.sessionId === 's2' && event.reason === 'evicted'))
  const again = await w.core.forAgent('s2', undefined, never)
  assert.deepEqual(again.takeNotes().events, [{ kind: 'reopened', reason: 'evicted' }])
  oldest.hold.release()
  await oldest.done
  noUrlsLogged(w)
})

test('at the cap with every browser in a call, a new call waits, and gets the first one freed', async () => {
  const w = world()
  const calls = []
  for (let i = 1; i <= 6; i++) calls.push(await busyCall(w, `s${i}`))
  let got: unknown
  const waiting = w.core.forAgent('s7', undefined, never).then(browser => { got = browser })
  await w.clock.tick(1000)
  assert.equal(got, undefined)
  calls[3]?.hold.release()
  await calls[3]?.done
  await waiting
  assert.ok(got !== undefined)
  assert.equal(w.core.isOpen('s7'), true)
  assert.equal(w.core.isOpen('s4'), false)
  assert.equal(w.core.view('s4').reason, 'evicted')
  for (const call of calls) call.hold.release()
})

test('at the cap with every browser in a call, a call waits 30 s, then busy; the browsers in calls are never evicted', async () => {
  const w = world()
  const calls = []
  for (let i = 1; i <= 6; i++) calls.push(await busyCall(w, `s${i}`))
  const waiting = w.core.forAgent('s7', undefined, never)
  waiting.catch(() => {})
  await w.clock.tick(CAP_WAIT_MS - 250, 250)
  let settled = false
  void waiting.then(() => { settled = true }, () => { settled = true })
  await flush()
  assert.equal(settled, false)
  await w.clock.tick(250, 250)
  await assert.rejects(waiting, isCode('busy'))
  for (let i = 1; i <= 6; i++) assert.equal(w.core.isOpen(`s${i}`), true)
  for (const call of calls) call.hold.release()
  assert.equal(w.clock.pending, 0)
})

test('at the cap, a waiting call\'s signal ends its wait with the signal\'s reason', async () => {
  const w = world({ limits: { maxBrowsers: 1, idleMinutes: 15 } })
  const call = await busyCall(w, 's1')
  const controller = new AbortController()
  const waiting = w.core.forAgent('s2', undefined, controller.signal)
  await w.clock.tick(500)
  controller.abort(new Error('the agent cancelled'))
  await assert.rejects(waiting, /the agent cancelled/)
  assert.equal(w.clock.pending, 0)
  call.hold.release()
  await call.done
  // A later call finds room as usual.
  await w.core.forAgent('s2', undefined, never)
  assert.equal(w.core.view('s1').reason, 'evicted')
})

test('at the cap, a browser just opened isn\'t taken by a waiting call before its own first call queues', async () => {
  const w = world({ limits: { maxBrowsers: 1, idleMinutes: 15 } })
  const hold = w.driver.holdLaunch()
  const first = w.core.forAgent('s1', undefined, never)
  await hold.reached
  const second = w.core.forAgent('s2', undefined, never)
  second.catch(() => {})
  hold.release()
  const browser = await first
  assert.equal(await browser.call(never, async () => 'ran'), 'ran')
  await second
  assert.equal(w.core.view('s1').reason, 'evicted')
})

test('a queued call counts as in a call: its browser isn\'t evicted', async () => {
  const w = world({ limits: { maxBrowsers: 1, idleMinutes: 15 } })
  const browser = await w.core.forAgent('s1', undefined, never)
  const gate = deferred()
  const first = browser.call(never, async () => { await gate.promise })
  const queued = browser.call(never, async () => 'ran')
  const waiting = w.core.forAgent('s2', undefined, never)
  waiting.catch(() => {})
  await w.clock.tick(500)
  gate.resolve()
  await first
  assert.equal(await queued, 'ran')
  await waiting
  assert.equal(w.core.view('s1').reason, 'evicted')
})

test('a call queued behind a crashed page\'s replacement counts as in a call: its browser isn\'t evicted', async () => {
  const w = world({ limits: { maxBrowsers: 1, idleMinutes: 15 } })
  const browser = await w.core.forAgent('s1', undefined, never)
  const context = w.driver.browser.contexts[0]!
  const replacement = deferred<FakePage>()
  const call = await busyCall(w, 's1')
  const queued = browser.call(never, async () => 'ran')
  context.newPage = () => replacement.promise
  pageOf(w, 's1').emit('crash')
  await assert.rejects(call.done, isCode('crashed'))
  assert.equal(browser.acting, false)
  assert.equal(browser.inCall, true)
  const waiting = w.core.forAgent('s2', undefined, never)
  waiting.catch(() => {})
  await w.clock.tick(500)
  assert.equal(w.core.isOpen('s1'), true)
  replacement.resolve(new FakePage())
  assert.equal(await queued, 'ran')
  await waiting
  assert.equal(w.core.view('s1').reason, 'evicted')
})

test('an opening abandoned during the launch: no browser, and Chromium lingers 60 s, then closes', async () => {
  const w = world()
  const hold = w.driver.holdLaunch()
  const controller = new AbortController()
  const opening = w.core.forAgent('s1', undefined, controller.signal)
  opening.catch(() => {})
  await hold.reached
  controller.abort(new Error('the agent cancelled'))
  await assert.rejects(opening, /the agent cancelled/)
  hold.release()
  await flush()
  assert.equal(w.core.isOpen('s1'), false)
  assert.equal(w.driver.browser.contexts.length, 0)
  w.clock.advance(LINGER_MS - 1)
  await flush()
  assert.equal(w.driver.browser.closeCalls, 0)
  w.clock.advance(1)
  await flush()
  assert.equal(w.driver.browser.closeCalls, 1)
  assert.equal(w.clock.pending, 0)
})

test('two callers sharing one opening: one aborts, the other still gets the browser', async () => {
  const w = world()
  const hold = w.driver.holdLaunch()
  const controller = new AbortController()
  const first = w.core.forAgent('s1', undefined, controller.signal)
  first.catch(() => {})
  const second = w.core.forAgent('s1', undefined, never)
  await hold.reached
  controller.abort(new Error('the first caller left'))
  await assert.rejects(first, /the first caller left/)
  hold.release()
  const browser = await second
  assert.equal(w.core.browserOf('s1'), browser)
  assert.equal(w.driver.browser.contexts.length, 1)
})

test('the tab and an agent sharing an opening: the tab joining an agent\'s wait at the cap gets busy at once; the agent goes on waiting', async () => {
  const w = world({ limits: { maxBrowsers: 1, idleMinutes: 15 } })
  const s0 = await busyCall(w, 's0')
  let agent = 'pending'
  const opening = w.core.forAgent('s1', undefined, never).then(() => { agent = 'opened' }, (error: unknown) => { agent = `rejected ${String((error as BrowserError).code)}` })
  await flush()
  let tabDone = false
  void w.core.user('s1', { kind: 'navigate', url: 'example.test' }, { workspace: undefined }).then(() => { tabDone = true })
  await flush()
  assert.equal(tabDone, true)
  assert.deepEqual(w.notices('s1'), [{ kind: 'error', code: 'busy', detail: '' }])
  assert.equal(agent, 'pending')
  s0.hold.release()
  await s0.done
  await opening
  assert.equal(agent, 'opened')
  assert.equal(w.core.view('s0').reason, 'evicted')
})

test('the tab and an agent sharing an opening: an agent arriving as the tab gets busy at the cap waits, as its own call would', async () => {
  // The address resolves at once, so the tab's opening is decided before the agent's call arrives in the next microtask.
  const rules = { ...simpleRules, resolve: () => Promise.resolve({ ok: true as const, url: 'https://example.test/' }) }
  const w = world({ limits: { maxBrowsers: 1, idleMinutes: 15 }, rules })
  const s0 = await busyCall(w, 's0')
  const tab = w.core.user('s1', { kind: 'navigate', url: 'example.test' }, { workspace: undefined })
  await Promise.resolve()
  let agent = 'pending'
  const opening = w.core.forAgent('s1', undefined, never).then(() => { agent = 'opened' }, (error: unknown) => { agent = `rejected ${String((error as BrowserError).code)}` })
  await tab
  await flush()
  assert.deepEqual(w.notices('s1'), [{ kind: 'error', code: 'busy', detail: '' }])
  assert.equal(agent, 'pending')
  s0.hold.release()
  await s0.done
  await opening
  assert.equal(agent, 'opened')
})

test('the pending notes are kept for the newest 200 sessions', async () => {
  const w = world()
  for (let i = 0; i <= 200; i++) {
    await w.core.forAgent(`s${i}`, undefined, never)
    await w.core.close(`s${i}`, 'idle')
  }
  assert.deepEqual((await w.core.forAgent('s0', undefined, never)).takeNotes().events, [])
  assert.deepEqual((await w.core.forAgent('s1', undefined, never)).takeNotes().events, [{ kind: 'reopened', reason: 'idle' }])
  assert.deepEqual((await w.core.forAgent('s200', undefined, never)).takeNotes().events, [{ kind: 'reopened', reason: 'idle' }])
})

// --- never a hang on the driver ---------------------------------------------------------------------------------------

test('never a hang: a crashed page whose replacement never comes, then a close: the tab\'s navigation and the queued call settle', async () => {
  const w = world()
  const browser = await w.core.forAgent('s1', undefined, never)
  const replacement = deferred<FakePage>()
  w.driver.browser.contexts[0]!.newPage = () => replacement.promise
  pageOf(w, 's1').emit('crash')
  const queued = browser.call(never, async () => 'never')
  queued.catch(() => {})
  let tabDone = false
  void w.core.user('s1', { kind: 'navigate', url: 'example.test/x' }, undefined).then(() => { tabDone = true })
  await flush()
  assert.equal(tabDone, false)
  await w.core.close('s1', 'tab')
  await flush()
  assert.equal(tabDone, true)
  await assert.rejects(queued, isCode('closed', 'tab'))
  const late = new FakePage()
  replacement.resolve(late)
  await flush()
  assert.equal(late.closed, true)
})

test('never a hang: a new context that never comes, then Chromium\'s disconnect: the call rejects closed, and a late context is closed', async () => {
  const w = world()
  await w.core.forAgent('s0', undefined, never)
  const fake = w.driver.browser
  const late = deferred<FakeContext>()
  fake.newContext = () => late.promise
  let outcome = 'pending'
  const opening = w.core.forAgent('s1', undefined, never).then(() => { outcome = 'opened' }, (error: unknown) => {
    outcome = error instanceof BrowserError ? `${error.code} ${error.detail}` : String(error)
  })
  await flush()
  assert.equal(outcome, 'pending')
  fake.disconnect()
  await flush()
  assert.equal(outcome, 'closed chromium')
  await opening
  const context = new FakeContext(fake, { viewport: VIEWPORT, route: async () => 'continue', refuseWebSocket: () => false })
  late.resolve(context)
  await flush()
  assert.equal(context.closeCalls, 1)
})

test('never a hang: a first page that never comes, then stop: the call rejects stopped, and the context is closed', async () => {
  const w = world()
  await w.core.forAgent('s0', undefined, never)
  const fake = w.driver.browser
  const late = deferred<FakePage>()
  const newContext = fake.newContext.bind(fake)
  fake.newContext = async options => {
    const context = await newContext(options)
    context.newPage = () => late.promise
    return context
  }
  let outcome = 'pending'
  const opening = w.core.forAgent('s1', undefined, never).then(() => { outcome = 'opened' }, (error: unknown) => {
    outcome = error instanceof BrowserError ? `${error.code} ${error.detail}` : String(error)
  })
  await flush()
  assert.equal(outcome, 'pending')
  await w.core.stop()
  await flush()
  assert.equal(outcome, 'closed stopped')
  await opening
  late.resolve(new FakePage())
  await flush()
  assert.equal(fake.contexts[1]?.closeCalls, 1)
})

test('never a hang: a launch that never ends, then stop: the call rejects stopped, and stop takes at most 5 s', async () => {
  const w = world()
  w.driver.holdLaunch()
  let outcome = 'pending'
  const opening = w.core.forAgent('s1', undefined, never).then(() => { outcome = 'opened' }, (error: unknown) => {
    outcome = error instanceof BrowserError ? `${error.code} ${error.detail}` : String(error)
  })
  await flush()
  const stopping = w.core.stop()
  await flush()
  assert.equal(outcome, 'closed stopped')
  await opening
  w.clock.advance(STOP_MS)
  await stopping
  assert.equal(w.clock.pending, 0)
})

// --- closing ----------------------------------------------------------------------------------------------------------

test('a close under a call: the call rejects closed with the reason, never a hang; the next call gets a new browser and the note', async () => {
  const w = world()
  const call = await busyCall(w, 's1')
  await w.core.user('s1', { kind: 'close' }, undefined)
  await assert.rejects(call.done, isCode('closed', 'tab'))
  assert.equal(w.driver.browser.contexts[0]?.closed, true)
  assert.deepEqual(w.core.view('s1').status, 'closed')
  const next = await w.core.forAgent('s1', undefined, never)
  assert.deepEqual(next.takeNotes().events, [{ kind: 'reopened', reason: 'tab' }])
  assert.ok(w.logs.some(log => log.message === 'closed the browser of s1 (tab)'))
})

test('close: nothing for a session with no browser; agent, archived and stopped leave no note', async () => {
  const w = world()
  await w.core.close('nobody', 'agent')
  assert.deepEqual(w.events, [])
  for (const reason of ['agent', 'archived'] as const) {
    await w.core.forAgent('s1', undefined, never)
    await w.core.close('s1', reason)
    assert.equal(w.core.view('s1').reason, reason)
  }
  const next = await w.core.forAgent('s1', undefined, never)
  assert.deepEqual(next.takeNotes().events, [])
})

test('agentDisposed: without a frames-on watcher the browser closes now; the header\'s frames-off watch holds nothing', async () => {
  const w = world()
  await w.core.forAgent('s1', undefined, never)
  const header = w.core.watch('s1')
  header.setFrames(false)
  w.core.agentDisposed('s1')
  await flush()
  assert.equal(w.core.view('s1').reason, 'agent')
  w.core.agentDisposed('s2')
  assert.ok(w.events.some(event => event.kind === 'changed' && event.sessionId === 's2'))
  header.close()
})

test('agentDisposed: with a frames-on watcher the browser is held, and closes when the last one leaves or turns frames off', async () => {
  const w = world()
  await w.core.forAgent('s1', undefined, never)
  const tab = w.core.watch('s1')
  const window2 = w.core.watch('s1')
  tab.setFrames(true)
  window2.setFrames(true)
  w.core.agentDisposed('s1')
  await flush()
  assert.equal(w.core.isOpen('s1'), true)
  tab.close()
  await flush()
  assert.equal(w.core.isOpen('s1'), true)
  window2.setFrames(false)
  await flush()
  assert.equal(w.core.view('s1').reason, 'agent')
  window2.close()
})

test('agentDisposed then the agent back (touch, or a call): the hold is gone, and a watcher leaving closes nothing', async () => {
  const w = world()
  await w.core.forAgent('s1', undefined, never)
  const tab = w.core.watch('s1')
  tab.setFrames(true)
  w.core.agentDisposed('s1')
  w.core.touch('s1')
  assert.ok(w.events.some(event => event.kind === 'changed' && event.sessionId === 's1'))
  tab.setFrames(false)
  await flush()
  assert.equal(w.core.isOpen('s1'), true)
  tab.setFrames(true)
  w.core.agentDisposed('s1')
  await w.core.forAgent('s1', undefined, never)
  tab.close()
  await flush()
  assert.equal(w.core.isOpen('s1'), true)
})

test('sweep: an archived session\'s browser closes; an idle one closes; not while watched or in a call', async () => {
  const w = world()
  for (const id of ['s1', 's2', 's3', 's4']) await w.core.forAgent(id, undefined, never)
  const watcher = w.core.watch('s3')
  watcher.setFrames(true)
  const call = await busyCall(w, 's4')
  w.clock.advance(15 * 60_000 - 1)
  await w.core.sweep(new Set(['s1']))
  assert.equal(w.core.view('s1').reason, 'archived')
  assert.equal(w.core.isOpen('s2'), true)
  w.clock.advance(1)
  await w.core.sweep(new Set())
  assert.equal(w.core.view('s2').reason, 'idle')
  assert.equal(w.core.isOpen('s3'), true)
  assert.equal(w.core.isOpen('s4'), true)
  call.hold.release()
  await call.done
  watcher.close()
  w.clock.advance(15 * 60_000)
  await w.core.sweep(new Set())
  assert.equal(w.core.view('s3').reason, 'idle')
  assert.equal(w.core.view('s4').reason, 'idle')
  const again = await w.core.forAgent('s2', undefined, never)
  assert.deepEqual(again.takeNotes().events, [{ kind: 'reopened', reason: 'idle' }])
})

// --- Chromium going away, lingering, stopping ---------------------------------------------------------------------------

test('Chromium\'s disconnect: every browser gone with reason chromium, a call in flight rejects, the next need relaunches with the note', async () => {
  const w = world()
  await w.core.forAgent('s1', undefined, never)
  const call = await busyCall(w, 's2')
  const contexts = w.driver.browser.contexts
  w.driver.browser.disconnect()
  await assert.rejects(call.done, isCode('closed', 'chromium'))
  assert.equal(w.core.view('s1').reason, 'chromium')
  assert.equal(w.core.view('s2').reason, 'chromium')
  assert.ok(w.logs.some(log => log.level === 'warn' && log.message === 'Chromium stopped unexpectedly'))
  assert.equal(contexts.every(context => context.closeCalls === 0), true)
  const again = await w.core.forAgent('s1', undefined, never)
  assert.equal(w.driver.launches.length, 2)
  assert.deepEqual(again.takeNotes().events, [{ kind: 'reopened', reason: 'chromium' }])
  noUrlsLogged(w)
})

test('the linger: Chromium closes 60 s after the last browser closes', async () => {
  const w = world()
  await w.core.forAgent('s1', undefined, never)
  await w.core.close('s1', 'agent')
  w.clock.advance(LINGER_MS - 1)
  assert.equal(w.driver.browser.closeCalls, 0)
  w.clock.advance(1)
  await flush()
  assert.equal(w.driver.browser.closeCalls, 1)
  assert.equal(w.logs.some(log => log.message === 'Chromium stopped unexpectedly'), false)
  assert.equal(w.clock.pending, 0)
  await w.core.forAgent('s1', undefined, never)
  assert.equal(w.driver.launches.length, 2)
})

test('the linger: a browser opened meanwhile keeps Chromium up', async () => {
  const w = world()
  await w.core.forAgent('s1', undefined, never)
  await w.core.close('s1', 'agent')
  w.clock.advance(LINGER_MS / 2)
  await w.core.forAgent('s2', undefined, never)
  w.clock.advance(LINGER_MS)
  await flush()
  assert.equal(w.driver.browser.closeCalls, 0)
  assert.equal(w.driver.launches.length, 1)
})

test('stop: every browser closes (no notes) and Chromium once; timers cancelled; idempotent; nothing opens after', async () => {
  const w = world()
  await w.core.forAgent('s1', undefined, never)
  const call = await busyCall(w, 's2')
  const watcher = w.core.watch('s1')
  watcher.setFrames(true)
  await w.core.stop()
  await w.core.stop()
  await assert.rejects(call.done, isCode('closed', 'stopped'))
  assert.equal(w.driver.browser.closeCalls, 1)
  assert.equal(w.driver.browser.contexts.every(context => context.closed), true)
  assert.equal(w.core.view('s1').reason, 'stopped')
  assert.equal(w.clock.pending, 0)
  await assert.rejects(w.core.forAgent('s3', undefined, never), isCode('closed', 'stopped'))
  assert.equal(w.driver.launches.length, 1)
  watcher.close()
})

test('stop during the linger: Chromium closes once, and no timer is left', async () => {
  const w = world()
  await w.core.forAgent('s1', undefined, never)
  await w.core.close('s1', 'agent')
  assert.equal(w.clock.pending, 1)
  await w.core.stop()
  assert.equal(w.clock.pending, 0)
  assert.equal(w.driver.browser.closeCalls, 1)
  w.clock.advance(LINGER_MS)
  await flush()
  assert.equal(w.driver.browser.closeCalls, 1)
})

test('stop: waits at most 5 s for a close that hangs', async () => {
  const w = world()
  await w.core.forAgent('s1', undefined, never)
  w.driver.browser.contexts[0]!.close = () => new Promise(() => {})
  w.driver.browser.close = () => new Promise(() => {})
  let done = false
  const stopping = w.core.stop().then(() => { done = true })
  await flush()
  assert.equal(done, false)
  w.clock.advance(STOP_MS)
  await stopping
  assert.equal(w.clock.pending, 0)
})

test('stop during a launch: Chromium is closed when it comes up, and the call fails', async () => {
  const w = world()
  const hold = w.driver.holdLaunch()
  const opening = w.core.forAgent('s1', undefined, never)
  opening.catch(() => {})
  await hold.reached
  const stopping = w.core.stop()
  hold.release()
  await assert.rejects(opening, isCode('closed', 'stopped'))
  await stopping
  assert.equal(w.driver.browser.closeCalls, 1)
})

// --- the route --------------------------------------------------------------------------------------------------------

test('the route: a refused main-frame navigation noted and sent to about:blank; a refused subresource aborted silently; dsh\'s WebSocket refused', async () => {
  const w = world()
  const browser = await w.core.forAgent('s1', '/work/project', never)
  const context = w.driver.browser.contexts[0]!
  assert.equal(await context.request('https://blocked.test/', { navigation: true, mainFrame: true, ownPage: true }), 'abort')
  await w.clock.tick(10)
  assert.deepEqual((browser.page as FakePage).callsOf('goto').map(args => args[0]), ['about:blank'])
  assert.deepEqual(w.notices('s1'), [{ kind: 'blocked', what: 'blocked.test' }])
  assert.equal(await context.request('file:///etc/hostname', { navigation: false, mainFrame: true }), 'abort')
  assert.equal(await context.request('http://localhost:4319/api', { navigation: false }), 'abort')
  assert.equal(await context.request('file:///work/project/app.js', { navigation: false }), 'continue')
  assert.equal(await context.request('http://127.0.0.1:5173/', { navigation: true, mainFrame: true, ownPage: true }), 'continue')
  assert.deepEqual(browser.takeNotes().events, [{ kind: 'blocked', what: 'blocked.test' }])
  assert.equal(context.refuseWebSocket('ws://127.0.0.1:4319/typert'), true)
  assert.equal(context.refuseWebSocket('ws://127.0.0.1:5173/hmr'), false)
  noUrlsLogged(w)
})

// --- watchers and frames ----------------------------------------------------------------------------------------------

test('the screencast: started by the first frames-on watcher, once for two, stopped when the last turns off; started on open when waiting', async () => {
  const w = world()
  const early = w.core.watch('s1')
  early.setFrames(true)
  early.setFrames(true)
  const browser = await w.core.forAgent('s1', undefined, never)
  await flush()
  const page = browser.page as FakePage
  assert.equal(page.screencasting, true)
  assert.deepEqual(page.screencastOptions, { quality: 60, maxWidth: 1280, maxHeight: 800 })
  const second = w.core.watch('s1')
  second.setFrames(true)
  await flush()
  assert.equal(page.callsOf('startScreencast').length, 1)
  early.setFrames(false)
  await flush()
  assert.equal(page.screencasting, true)
  second.close()
  await flush()
  assert.equal(page.screencasting, false)
  assert.equal(page.callsOf('stopScreencast').length, 1)
  early.close()
  early.close()
})

test('frames: each gets the next seq, rising across a new page; latestFrame; capture; a closed browser keeps its last frame', async () => {
  const w = world()
  const watcher = w.core.watch('s1')
  watcher.setFrames(true)
  const browser = await w.core.forAgent('s1', undefined, never)
  await flush()
  const page = browser.page as FakePage
  page.frame('one')
  page.frame('two')
  const frames = w.events.flatMap(event => event.kind === 'frame' ? [event.frame] : [])
  assert.deepEqual(frames.map(frame => frame.data), ['one', 'two'])
  assert.ok((frames[1]?.seq ?? 0) > (frames[0]?.seq ?? 0))
  assert.deepEqual(w.core.latestFrame('s1'), frames[1])
  page.emit('crash')
  await flush()
  const fresh = browser.page as FakePage
  assert.notEqual(fresh, page)
  assert.equal(fresh.screencasting, true)
  fresh.frame('three')
  const third = w.core.latestFrame('s1')
  assert.equal(third?.data, 'three')
  assert.ok((third?.seq ?? 0) > (frames[1]?.seq ?? 0))
  const captured = await w.core.capture('s1')
  assert.deepEqual(captured && { data: captured.data, width: captured.width, height: captured.height }, { data: 'capture', width: 1280, height: 800 })
  assert.ok((captured?.seq ?? 0) > (third?.seq ?? 0))
  assert.equal(await w.core.capture('nobody'), undefined)
  fresh.failNext('capture', new Error('no'))
  assert.equal(await w.core.capture('s1'), undefined)
  await w.core.close('s1', 'tab')
  assert.equal(w.core.latestFrame('s1')?.seq, captured?.seq)
  assert.equal(await w.core.capture('s1'), undefined)
  watcher.close()
})

// --- the view ---------------------------------------------------------------------------------------------------------

test('view: none, then open with the page\'s state and acting, then closed with its reason', async () => {
  const w = world()
  assert.deepEqual(w.core.view('s1'), { status: 'none', url: '', title: '', loading: false, canGoBack: false, canGoForward: false, acting: false, sandboxOff: false })
  const browser = await w.core.forAgent('s1', undefined, never)
  const page = browser.page as FakePage
  page.currentTitle = 'Docs'
  await page.goto('https://ok.test/docs', { timeoutMs: 1000, loadMs: 1000 })
  await flush()
  assert.deepEqual(w.core.view('s1'), { status: 'open', url: 'https://ok.test/docs', title: 'Docs', loading: false, canGoBack: true, canGoForward: false, acting: false, sandboxOff: false })
  const call = await busyCall(w, 's1')
  assert.equal(w.core.view('s1').acting, true)
  call.hold.release()
  await call.done
  assert.equal(w.core.view('s1').acting, false)
  await w.core.close('s1', 'idle')
  assert.equal(w.core.view('s1').status, 'closed')
  assert.equal(w.core.view('s1').reason, 'idle')
})

// --- the user's actions -----------------------------------------------------------------------------------------------

test('user navigate: no browser and no start → cannot-start; with start, a browser the user started, at the URL', async () => {
  const w = world()
  await w.core.user('s1', { kind: 'navigate', url: 'example.test/a' }, undefined)
  assert.deepEqual(w.notices('s1'), [{ kind: 'cannot-start' }])
  assert.equal(w.driver.launches.length, 0)
  await w.core.user('s1', { kind: 'navigate', url: 'example.test/a' }, { workspace: '/work/a' })
  assert.equal(w.core.view('s1').status, 'open')
  assert.equal(w.core.view('s1').url, 'https://example.test/a')
  const browser = await w.core.forAgent('s1', undefined, never)
  assert.equal(browser.workspace, '/work/a')
  const { user } = browser.takeNotes()
  assert.equal(user?.started, true)
  assert.deepEqual(user?.navigations, ['https://example.test/a'])
})

test('user navigate: a refused URL is a notice and starts no browser; with one open, its places decide', async () => {
  const w = world()
  await w.core.user('s1', { kind: 'navigate', url: 'blocked.test' }, { workspace: '/work/a' })
  assert.deepEqual(w.notices('s1'), [{ kind: 'refused', reason: 'blocked.test is blocked.' }])
  assert.equal(w.driver.launches.length, 0)
  await w.core.user('s1', { kind: 'navigate', url: '/work/a/index.html' }, { workspace: '/work/a' })
  assert.equal(w.core.view('s1').url, 'file:///work/a/index.html')
  await w.core.user('s1', { kind: 'navigate', url: '/work/b/index.html' }, { workspace: '/work/b' })
  assert.equal(w.notices('s1').at(-1)?.kind, 'refused')
})

test('user navigate at the cap: an idle browser is evicted; with every one in a call, a busy notice at once, no wait', async () => {
  const w = world({ limits: { maxBrowsers: 1, idleMinutes: 15 } })
  await w.core.forAgent('s1', undefined, never)
  await w.core.user('s2', { kind: 'navigate', url: 'example.test' }, { workspace: undefined })
  assert.equal(w.core.view('s1').reason, 'evicted')
  const call = await busyCall(w, 's2')
  await w.core.user('s3', { kind: 'navigate', url: 'example.test' }, { workspace: undefined })
  assert.deepEqual(w.notices('s3'), [{ kind: 'error', code: 'busy', detail: '' }])
  assert.equal(w.core.isOpen('s3'), false)
  call.hold.release()
  await call.done
})

test('user navigate: a failure is a notice with the URL and the error; a timeout says timeout; unavailable is an error notice', async () => {
  const w = world()
  await w.core.forAgent('s1', undefined, never)
  const page = pageOf(w, 's1')
  page.failNext('goto', new Error('page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:5173/'))
  await w.core.user('s1', { kind: 'navigate', url: 'http://127.0.0.1:5173/' }, undefined)
  page.failNext('goto', new DriverTimeout('Timeout 30000ms exceeded'))
  await w.core.user('s1', { kind: 'navigate', url: 'https://slow.test/' }, undefined)
  assert.deepEqual(w.notices('s1'), [
    { kind: 'failed', url: 'http://127.0.0.1:5173/', error: 'page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:5173/' },
    { kind: 'failed', url: 'https://slow.test/', error: 'timeout' },
  ])
  const none = world({ unavailable: '/usr/bin/chromium' })
  await none.core.user('s1', { kind: 'navigate', url: 'example.test' }, { workspace: undefined })
  assert.deepEqual(none.notices('s1'), [{ kind: 'error', code: 'unavailable', detail: '/usr/bin/chromium' }])
  noUrlsLogged(w)
})

test('user navigate that fails records the URL asked for, not the error page; a back or forward that goes nowhere records nothing', async () => {
  const w = world()
  const browser = await w.core.forAgent('s1', undefined, never)
  const page = browser.page as FakePage
  // As Chromium does: a failed load leaves its own error page as the URL.
  page.goto = async (url: string) => {
    page.currentUrl = 'chrome-error://chromewebdata/'
    throw new Error(`page.goto: net::ERR_CONNECTION_REFUSED at ${url}`)
  }
  await w.core.user('s1', { kind: 'navigate', url: 'http://127.0.0.1:5173/' }, undefined)
  await w.core.user('s1', { kind: 'back' }, undefined)
  await w.core.user('s1', { kind: 'forward' }, undefined)
  page.failNext('reload', new Error('page.reload: net::ERR_FAILED'))
  await w.core.user('s1', { kind: 'reload' }, undefined)
  const user = browser.takeNotes().user
  assert.deepEqual(user?.navigations, ['http://127.0.0.1:5173/'])
  assert.equal(user?.moreNavigations, 0)
  assert.equal(w.notices('s1').length, 2)
})

test('user navigate doesn\'t wait for the agent\'s call', async () => {
  const w = world()
  const call = await busyCall(w, 's1')
  await w.core.user('s1', { kind: 'navigate', url: 'example.test/now' }, undefined)
  assert.equal(w.core.view('s1').url, 'https://example.test/now')
  call.hold.release()
  await call.done
})

test('user back, forward and reload: done on the open browser and recorded; ignored with none', async () => {
  const w = world()
  await w.core.user('s1', { kind: 'back' }, undefined)
  assert.equal(w.driver.launches.length, 0)
  await w.core.user('s1', { kind: 'navigate', url: 'example.test/1' }, { workspace: undefined })
  await w.core.user('s1', { kind: 'navigate', url: 'example.test/2' }, undefined)
  await w.core.user('s1', { kind: 'back' }, undefined)
  assert.equal(w.core.view('s1').url, 'https://example.test/1')
  await w.core.user('s1', { kind: 'forward' }, undefined)
  assert.equal(w.core.view('s1').url, 'https://example.test/2')
  await w.core.user('s1', { kind: 'reload' }, undefined)
  const page = pageOf(w, 's1')
  assert.equal(page.callsOf('reload').length, 1)
  page.failNext('back', new Error('page.goBack: net::ERR_FAILED'))
  await w.core.user('s1', { kind: 'back' }, undefined)
  assert.deepEqual(w.notices('s1'), [{ kind: 'failed', url: 'https://example.test/2', error: 'page.goBack: net::ERR_FAILED' }])
  const browser = await w.core.forAgent('s1', undefined, never)
  const user = browser.takeNotes().user
  assert.deepEqual(user?.navigations, ['https://example.test/1', 'https://example.test/2', 'https://example.test/1', 'https://example.test/2', 'https://example.test/2'])
  // The failed back records nothing.
  assert.equal(user?.moreNavigations, 0)
})

test('user input: mouse, wheel, keys and text replayed in order while the agent\'s call is held; a move coalesced; a modifier released', async () => {
  const w = world()
  const call = await busyCall(w, 's1')
  const page = pageOf(w, 's1')
  const hold = page.hold('mouse')
  await w.core.user('s1', { kind: 'mouse', action: 'move', x: 1, y: 1, button: 'left', clickCount: 0 }, undefined)
  await hold.reached
  await w.core.user('s1', { kind: 'mouse', action: 'move', x: 5, y: 5, button: 'left', clickCount: 0 }, undefined)
  await w.core.user('s1', { kind: 'mouse', action: 'move', x: 9, y: 9, button: 'left', clickCount: 0 }, undefined)
  await w.core.user('s1', { kind: 'mouse', action: 'down', x: 9, y: 9, button: 'left', clickCount: 1 }, undefined)
  await w.core.user('s1', { kind: 'mouse', action: 'up', x: 9, y: 9, button: 'left', clickCount: 1 }, undefined)
  await w.core.user('s1', { kind: 'wheel', x: 9, y: 9, dx: 0, dy: 300 }, undefined)
  await w.core.user('s1', { kind: 'key', action: 'down', key: 'Control', code: 'ControlLeft', modifiers: CONTROL }, undefined)
  await w.core.user('s1', { kind: 'key', action: 'down', key: 'x', code: 'KeyX', modifiers: 0 }, undefined)
  await w.core.user('s1', { kind: 'key', action: 'up', key: 'x', code: 'KeyX', modifiers: 0 }, undefined)
  await w.core.user('s1', { kind: 'text', text: 'pasted' }, undefined)
  hold.release()
  await flush(8)
  const replayed = page.calls.filter(c => ['mouse', 'wheel', 'keyDown', 'keyUp', 'insertText'].includes(c.method))
  assert.deepEqual(replayed, [
    { method: 'mouse', args: ['move', 1, 1, 'left', 0] },
    { method: 'mouse', args: ['move', 9, 9, 'left', 0] },
    { method: 'mouse', args: ['down', 9, 9, 'left', 1] },
    { method: 'mouse', args: ['up', 9, 9, 'left', 1] },
    { method: 'wheel', args: [9, 9, 0, 300] },
    { method: 'keyDown', args: ['Control'] },
    { method: 'keyUp', args: ['Control'] },
    { method: 'keyDown', args: ['x'] },
    { method: 'keyUp', args: ['x'] },
    { method: 'insertText', args: ['pasted'] },
  ])
  assert.equal(w.core.view('s1').acting, true)
  call.hold.release()
  await call.done
  const user = (await w.core.forAgent('s1', undefined, never)).takeNotes().user
  assert.deepEqual([user?.clicks, user?.scrolled, user?.typed, user?.keys, user?.started], [1, true, true, false, false])
})

test('user input with no browser open is ignored', async () => {
  const w = world()
  await w.core.user('s1', { kind: 'mouse', action: 'down', x: 1, y: 1, button: 'left', clickCount: 1 }, { workspace: undefined })
  await w.core.user('s1', { kind: 'reload' }, { workspace: undefined })
  await w.core.user('s1', { kind: 'close' }, undefined)
  assert.equal(w.driver.launches.length, 0)
  assert.deepEqual(w.events, [])
})

test('a page\'s crash: a notice for the tab, a call in flight rejects crashed, and the browser stays open', async () => {
  const w = world()
  const call = await busyCall(w, 's1')
  pageOf(w, 's1').emit('crash')
  await assert.rejects(call.done, isCode('crashed'))
  assert.deepEqual(w.notices('s1'), [{ kind: 'crashed' }])
  assert.equal(w.core.isOpen('s1'), true)
  assert.ok(w.logs.some(log => log.message === 'the page of s1 crashed'))
})

test('a page that can\'t be replaced after a crash closes its browser (reason chromium)', async () => {
  const w = world()
  await w.core.forAgent('s1', undefined, never)
  w.driver.browser.contexts[0]!.failNewPage = new Error('context gone')
  pageOf(w, 's1').emit('crash')
  await flush()
  assert.equal(w.core.view('s1').reason, 'chromium')
  // Chromium is still up: the context is closed, not left until Chromium goes.
  assert.equal(w.driver.browser.closed, false)
  assert.equal(w.driver.browser.contexts[0]!.closeCalls, 1)
})

test('a context that won\'t open fails the call wont-start, and the cap isn\'t held by it', async () => {
  const w = world({ limits: { maxBrowsers: 1, idleMinutes: 15 } })
  await w.core.forAgent('s0', undefined, never)
  w.driver.browser.failNewContext = new Error('newContext failed')
  await assert.rejects(w.core.forAgent('s1', undefined, never), isCode('wont-start', 'newContext failed'))
  await w.core.forAgent('s2', undefined, never)
  assert.equal(w.core.isOpen('s2'), true)
})

// --- the system clock -------------------------------------------------------------------------------------------------

test('systemClock: a timer runs after its time, a cancelled one never runs', async () => {
  const ran: string[] = []
  systemClock.after(5, () => { ran.push('kept') })
  const cancel = systemClock.after(5, () => { ran.push('cancelled') })
  cancel()
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.deepEqual(ran, ['kept'])
  assert.ok(Math.abs(systemClock.now() - Date.now()) < 1000)
})

test('systemClock: its timers are unref\'d: a process with only a long one pending exits at once', async () => {
  const clock = new URL('../src/clock.ts', import.meta.url).href
  const started = Date.now()
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import { systemClock } from ${JSON.stringify(clock)}; systemClock.after(60_000, () => { process.exitCode = 3 })`], {
    encoding: 'utf8', timeout: 20_000,
  })
  assert.equal(child.status, 0, child.stderr)
  assert.ok(Date.now() - started < 20_000)
})

test('subscribe: a listener that throws doesn\'t stop the others; unsubscribe ends delivery', async () => {
  const w = world()
  const seen: string[] = []
  w.core.subscribe(() => { throw new Error('bad listener') })
  const off = w.core.subscribe(event => { seen.push(event.kind) })
  await w.core.forAgent('s1', undefined, never)
  assert.ok(seen.includes('opened'))
  off()
  const before = seen.length
  await w.core.close('s1', 'agent')
  assert.equal(seen.length, before)
})
