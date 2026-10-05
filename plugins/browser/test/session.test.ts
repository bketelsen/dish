/**
 * `SessionBrowser`: one session's browser, on a `FakePage`. Its call queue, the page's events (dialogs, popups,
 * downloads, file choosers, navigations, crashes), the logs, the notes, the user's input, and what a close does to the
 * calls on it.
 */

import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { BrowserError } from '../src/browsers.ts'
import { SessionBrowser } from '../src/session.ts'
import type { SessionHost } from '../src/session.ts'
import type { ScreencastFrame } from '../src/driver.ts'
import { CONTROL, SHIFT } from '../src/protocol.ts'
import { LISTED, LOG_RING, POPUP_URL_MS } from '../src/types.ts'
import type { Note, TabNotice } from '../src/types.ts'
import { FakeBrowser, FakeContext, FakeDialog, FakePage, FakePopup, ManualClock, deferred, flush, simpleRules } from './fake-driver.ts'

const VIEWPORT = { width: 1280, height: 800 }
const never = new AbortController().signal

interface World {
  browser: SessionBrowser
  context: FakeContext
  page: FakePage
  clock: ManualClock
  notices: TabNotice[]
  frames: ScreencastFrame[]
  logs: string[]
  counts: { changed: number, callEnded: number, broken: number }
}

/** Every log line of the file: none holds a URL. */
const allLogs: string[] = []
after(() => { for (const line of allLogs) assert.doesNotMatch(line, /https?:|file:/) })

async function world(options: { workspace?: string, started?: boolean, notes?: Note[] } = {}): Promise<World> {
  const clock = new ManualClock()
  const fake = new FakeBrowser()
  const context = await fake.newContext({ viewport: VIEWPORT, route: async () => 'continue', refuseWebSocket: () => false })
  const page = await context.newPage()
  const notices: TabNotice[] = []
  const frames: ScreencastFrame[] = []
  const logs: string[] = []
  const counts = { changed: 0, callEnded: 0, broken: 0 }
  const host: SessionHost = {
    clock,
    rules: simpleRules,
    sharedTmp: false,
    viewport: VIEWPORT,
    own: () => ({ port: 4319, trustedHost: undefined }),
    replayAs: key => key === 'Nope' ? undefined : [...key].length === 1 && /[^\x20-\x7e]/.test(key) ? 'text' : 'key',
    log: { info: message => { logs.push(message); allLogs.push(message) }, warn: message => { logs.push(message); allLogs.push(message) } },
    changed: () => { counts.changed++ },
    notice: notice => { notices.push(notice) },
    frame: frame => { frames.push(frame) },
    callEnded: () => { counts.callEnded++ },
    broken: () => { counts.broken++ },
  }
  const browser = new SessionBrowser({
    sessionId: 's1', context, page, workspace: options.workspace, started: options.started, notes: options.notes, host,
  })
  return { browser, context, page, clock, notices, frames, logs, counts }
}

// --- the queue --------------------------------------------------------------------------------------------------------

test('the queue: one call at a time, in order; acting while one runs; a queued call aborted never runs', async () => {
  const w = await world()
  const order: string[] = []
  const gate = deferred()
  const first = w.browser.call(never, async page => {
    assert.equal(page, w.page)
    order.push('first starts')
    await gate.promise
    order.push('first ends')
    return 1
  })
  const aborted = new AbortController()
  const second = w.browser.call(aborted.signal, async () => { order.push('second'); return 2 })
  const third = w.browser.call(never, async () => { order.push('third'); return 3 })
  await flush()
  assert.deepEqual(order, ['first starts'])
  assert.equal(w.browser.acting, true)
  assert.equal(w.browser.inCall, true)
  aborted.abort(new Error('the agent cancelled'))
  await assert.rejects(second, /the agent cancelled/)
  gate.resolve()
  assert.equal(await first, 1)
  assert.equal(await third, 3)
  assert.deepEqual(order, ['first starts', 'first ends', 'third'])
  assert.equal(w.browser.acting, false)
  assert.equal(w.browser.inCall, false)
})

test('the queue: changed at each call\'s start and end; lastUsed and dialogAnswer set at its end, whatever its outcome', async () => {
  const w = await world()
  const before = w.counts.changed
  w.clock.advance(5_000)
  await assert.rejects(w.browser.call(never, async () => {
    w.browser.dialogAnswer = 'accept'
    assert.equal(w.browser.acting, true)
    throw new Error('the action failed')
  }), /the action failed/)
  assert.equal(w.counts.changed - before, 2)
  assert.equal(w.browser.dialogAnswer, 'dismiss')
  assert.equal(w.browser.lastUsed, w.clock.now())
  assert.ok(w.counts.callEnded >= 1)
})

test('the queue: an already-aborted signal rejects at once, with its reason', async () => {
  const w = await world()
  const controller = new AbortController()
  controller.abort(new Error('gone already'))
  let ran = false
  await assert.rejects(w.browser.call(controller.signal, async () => { ran = true }), /gone already/)
  assert.equal(ran, false)
})

test('the queue: an abort while a call runs doesn\'t end it early: the next call never overlaps it', async () => {
  const w = await world()
  const gate = deferred()
  const controller = new AbortController()
  let running = 0
  let overlapped = false
  const first = w.browser.call(controller.signal, async () => { running++; await gate.promise; running-- })
  const second = w.browser.call(never, async () => { if (running > 0) overlapped = true })
  await flush()
  controller.abort(new Error('late'))
  await flush()
  assert.equal(w.browser.acting, true)
  gate.resolve()
  await first
  await second
  assert.equal(overlapped, false)
})

test('a close: the call in flight and the queued ones reject closed with the reason, without waiting for the run; new calls too', async () => {
  const w = await world()
  const hold = w.page.hold('click')
  const inFlight = w.browser.call(never, page => page.click({ ref: 'e1' }, { timeoutMs: 5000, double: false }))
  const queued = w.browser.call(never, async () => 'never')
  await hold.reached
  w.browser.markClosed('tab')
  for (const promise of [inFlight, queued, w.browser.call(never, async () => 'never')]) {
    await assert.rejects(promise, (error: unknown) => error instanceof BrowserError && error.code === 'closed' && error.detail === 'tab')
  }
  assert.equal(w.browser.closedReason, 'tab')
  assert.equal(w.browser.acting, false)
})

test('whileOpen: a close ends the wait with closed, never a hang', async () => {
  const w = await world()
  const hold = w.page.hold('goto')
  const going = w.browser.whileOpen(w.page.goto('https://ok.test/', { timeoutMs: 30_000, loadMs: 3_000 }))
  await hold.reached
  w.browser.markClosed('idle')
  await assert.rejects(going, (error: unknown) => error instanceof BrowserError && error.code === 'closed' && error.detail === 'idle')
  await assert.rejects(w.browser.whileOpen(Promise.resolve(1)), (error: unknown) => error instanceof BrowserError && error.code === 'closed')
})

// --- dialogs ----------------------------------------------------------------------------------------------------------

test('dialogs: dismissed by default; accepted in a call that asked; beforeunload always accepted; each noted and a notice', async () => {
  const w = await world()
  const outside = new FakeDialog('alert', 'Hello')
  w.page.emit('dialog', outside)
  assert.equal(await outside.answered.promise, 'dismiss')

  const asked = new FakeDialog('confirm', 'Delete it?')
  await w.browser.call(never, async () => {
    w.browser.dialogAnswer = 'accept'
    w.page.emit('dialog', asked)
  })
  assert.equal(await asked.answered.promise, 'accept')

  const notAsked = new FakeDialog('prompt', 'Name?')
  await w.browser.call(never, async () => { w.page.emit('dialog', notAsked) })
  assert.equal(await notAsked.answered.promise, 'dismiss')

  const leaving = new FakeDialog('beforeunload', '')
  w.page.emit('dialog', leaving)
  assert.equal(await leaving.answered.promise, 'accept')

  const long = new FakeDialog('alert', 'x'.repeat(5000))
  w.page.emit('dialog', long)

  const { events } = w.browser.takeNotes()
  assert.deepEqual(events.slice(0, 4), [
    { kind: 'dialog', dialog: 'alert', message: 'Hello', accepted: false },
    { kind: 'dialog', dialog: 'confirm', message: 'Delete it?', accepted: true },
    { kind: 'dialog', dialog: 'prompt', message: 'Name?', accepted: false },
    { kind: 'dialog', dialog: 'beforeunload', message: '', accepted: true },
  ])
  const last = events[4]
  assert.ok(last?.kind === 'dialog' && last.message.length === 1000)
  assert.equal(w.notices.filter(notice => notice.kind === 'dialog').length, 5)
})

// --- popups -----------------------------------------------------------------------------------------------------------

test('popups: an allowed one is followed in the session\'s own page; a refused one and a blank one are closed; each noted', async () => {
  const w = await world()
  const followed = new FakePopup('https://ok.test/next')
  w.page.emit('popup', followed)
  await flush()
  assert.equal(followed.waitedMs, POPUP_URL_MS)
  assert.equal(followed.closed, true)
  assert.equal(w.page.currentUrl, 'https://ok.test/next')

  const refused = new FakePopup('https://blocked.test/x')
  w.page.emit('popup', refused)
  await flush()
  assert.equal(refused.closed, true)
  assert.equal(w.page.currentUrl, 'https://ok.test/next')

  const blank = new FakePopup('about:blank')
  w.page.emit('popup', blank)
  await flush()
  assert.equal(blank.closed, true)

  assert.deepEqual(w.browser.takeNotes().events, [
    { kind: 'popup', url: 'https://ok.test/next', outcome: 'followed' },
    { kind: 'popup', url: 'https://blocked.test/x', outcome: 'refused', what: 'blocked.test' },
    { kind: 'popup', url: 'about:blank', outcome: 'blank' },
  ])
  assert.deepEqual(w.notices.map(notice => notice.kind === 'popup' ? notice.outcome : notice.kind), ['followed', 'refused', 'blank'])
})

// --- downloads, file choosers, navigations ----------------------------------------------------------------------------

test('a download and a file chooser: noted, and a notice each', async () => {
  const w = await world()
  w.page.emit('download', 'report.pdf')
  w.page.emit('filechooser')
  assert.deepEqual(w.browser.takeNotes().events, [{ kind: 'download', name: 'report.pdf' }, { kind: 'filechooser' }])
  assert.deepEqual(w.notices, [{ kind: 'download', name: 'report.pdf' }, { kind: 'filechooser' }])
})

test('a navigation: loading and the URL at once, the title 200 ms later, the history read; load ends loading', async () => {
  const w = await world()
  w.page.currentTitle = 'Home'
  w.page.historyState = { canGoBack: true, canGoForward: false }
  w.page.currentUrl = 'https://ok.test/'
  w.page.emit('navigated', 'https://ok.test/')
  assert.equal(w.browser.view.url, 'https://ok.test/')
  assert.equal(w.browser.view.loading, true)
  assert.equal(w.browser.view.title, '')
  await flush()
  assert.equal(w.browser.view.canGoBack, true)
  w.clock.advance(200)
  await flush()
  assert.equal(w.browser.view.title, 'Home')
  w.page.currentTitle = 'Home, loaded'
  w.page.emit('load')
  assert.equal(w.browser.view.loading, false)
  await flush()
  assert.equal(w.browser.view.title, 'Home, loaded')
  assert.deepEqual(w.browser.takeNotes().events, [])
})

test('a navigation the rules refuse: noted as blocked, a notice, and the page sent to about:blank', async () => {
  const w = await world()
  w.page.currentUrl = 'chrome://settings'
  w.page.emit('navigated', 'chrome://settings')
  await flush()
  assert.deepEqual(w.page.callsOf('goto').map(args => args[0]), ['about:blank'])
  assert.deepEqual(w.browser.takeNotes().events, [{ kind: 'blocked', what: 'chrome:' }])
  assert.deepEqual(w.notices, [{ kind: 'blocked', what: 'chrome:' }])
})

test('the route: a refused main-frame navigation of its own page is aborted, noted, and the page sent to about:blank', async () => {
  const w = await world({ workspace: '/work/project' })
  assert.equal(await w.browser.route({ url: 'file:///etc/passwd', navigation: true, mainFrame: true, ownPage: true }), 'abort')
  w.clock.advance(0)
  await flush()
  assert.deepEqual(w.page.callsOf('goto').map(args => args[0]), ['about:blank'])
  assert.deepEqual(w.browser.takeNotes().events, [{ kind: 'blocked', what: '/etc/passwd' }])
  assert.deepEqual(w.notices, [{ kind: 'blocked', what: '/etc/passwd' }])
})

test('the route: a refused subresource or frame is aborted silently; an allowed one continues', async () => {
  const w = await world({ workspace: '/work/project' })
  assert.equal(await w.browser.route({ url: 'file:///etc/hostname', navigation: false, mainFrame: true, ownPage: true }), 'abort')
  assert.equal(await w.browser.route({ url: 'http://127.0.0.1:4319/api', navigation: true, mainFrame: false, ownPage: true }), 'abort')
  assert.equal(await w.browser.route({ url: 'https://blocked.test/', navigation: true, mainFrame: true, ownPage: false }), 'abort')
  assert.equal(await w.browser.route({ url: 'file:///work/project/index.html', navigation: true, mainFrame: true, ownPage: true }), 'continue')
  assert.equal(await w.browser.route({ url: 'https://ok.test/app.js', navigation: false, mainFrame: true, ownPage: true }), 'continue')
  w.clock.advance(0)
  await flush()
  assert.deepEqual(w.page.callsOf('goto'), [])
  assert.deepEqual(w.browser.takeNotes().events, [])
  assert.deepEqual(w.notices, [])
})

test('places: the workspace, /tmp and dsh\'s own address, as they are now', async () => {
  const w = await world({ workspace: '/work/a' })
  assert.deepEqual(w.browser.places(), { workspace: '/work/a', sharedTmp: false, own: { port: 4319, trustedHost: undefined } })
  w.browser.workspace = '/work/b'
  assert.equal(w.browser.places().workspace, '/work/b')
})

test('ensureAllowed: a page whose URL the rules refuse now goes to about:blank, awaited, and is noted; an allowed one stays', async () => {
  const w = await world({ workspace: '/work/project' })
  w.page.currentUrl = 'https://ok.test/'
  await w.browser.ensureAllowed()
  assert.deepEqual(w.page.callsOf('goto'), [])
  w.page.currentUrl = 'file:///work/other/x.html'
  await w.browser.ensureAllowed()
  assert.equal(w.page.currentUrl, 'about:blank')
  assert.deepEqual(w.browser.takeNotes().events, [{ kind: 'blocked', what: '/work/other/x.html' }])
})

// --- logs -------------------------------------------------------------------------------------------------------------

test('logs: console errors and failed requests in rings of 100 (lines cut to 1000); takeLogs clears; newLogCounts counts and resets', async () => {
  const w = await world()
  for (let i = 1; i <= LOG_RING + 50; i++) w.page.emit('consoleError', `error ${i}`)
  w.page.emit('consoleError', 'y'.repeat(3000))
  w.page.emit('requestFailed', { url: 'https://ok.test/missing.png', status: 404 })
  w.page.emit('requestFailed', { url: 'http://127.0.0.1:9/', error: 'net::ERR_CONNECTION_REFUSED' })
  assert.deepEqual(w.browser.newLogCounts(), { console: LOG_RING + 51, requests: 2 })
  assert.deepEqual(w.browser.newLogCounts(), { console: 0, requests: 0 })
  const logs = w.browser.takeLogs()
  assert.equal(logs.console.length, LOG_RING)
  assert.equal(logs.console[0], 'error 52')
  assert.equal(logs.console.at(-1)?.length, 1000)
  assert.equal(logs.moreConsole, 51)
  assert.deepEqual(logs.requests, ['404 https://ok.test/missing.png', 'net::ERR_CONNECTION_REFUSED http://127.0.0.1:9/'])
  assert.equal(logs.moreRequests, 0)
  assert.deepEqual(w.browser.takeLogs(), { console: [], requests: [], moreConsole: 0, moreRequests: 0 })
  w.page.emit('consoleError', 'later')
  assert.deepEqual(w.browser.newLogCounts(), { console: 1, requests: 0 })
})

test('newLogCounts: when new ones came, the totals since the last read (takeLogs), not only the new ones', async () => {
  const w = await world()
  w.page.emit('consoleError', 'first')
  w.page.emit('consoleError', 'second')
  assert.deepEqual(w.browser.newLogCounts(), { console: 2, requests: 0 })
  w.page.emit('consoleError', 'one more')
  assert.deepEqual(w.browser.newLogCounts(), { console: 3, requests: 0 }, 'the two before are still unread')
  w.page.emit('requestFailed', { url: 'https://ok.test/a.js', status: 404 })
  assert.deepEqual(w.browser.newLogCounts(), { console: 3, requests: 1 })
  assert.deepEqual(w.browser.newLogCounts(), { console: 0, requests: 0 }, 'nothing new: no note')
  w.browser.takeLogs()
  w.page.emit('consoleError', 'after the read')
  assert.deepEqual(w.browser.newLogCounts(), { console: 1, requests: 0 })
})

// --- notes ------------------------------------------------------------------------------------------------------------

test('takeNotes: the pending notes first, then the events, in order; the user\'s activity on its own; both cleared', async () => {
  const w = await world({ notes: [{ kind: 'reopened', reason: 'idle' }] })
  w.page.emit('download', 'a.zip')
  w.browser.recordNavigation('https://ok.test/1')
  w.browser.input({ kind: 'mouse', action: 'down', x: 1, y: 1, button: 'left', clickCount: 1 })
  const taken = w.browser.takeNotes()
  assert.deepEqual(taken.events, [{ kind: 'reopened', reason: 'idle' }, { kind: 'download', name: 'a.zip' }])
  assert.equal(taken.user?.started, false)
  assert.deepEqual(taken.user?.navigations, ['https://ok.test/1'])
  assert.equal(taken.user?.clicks, 1)
  assert.equal(taken.user?.last, w.clock.now())
  assert.deepEqual(w.browser.takeNotes(), { user: undefined, events: [], leftOut: 0 })
})

test('notes keep the newest 10 page events and count the rest; reopened and crashed always stay', async () => {
  const w = await world({ notes: [{ kind: 'reopened', reason: 'idle' }] })
  for (let i = 0; i < 70; i++) w.page.emit('download', `f${i}.zip`)
  w.page.emit('crash')
  await flush()
  const fresh = w.context.pages[1]!
  for (let i = 70; i < 150; i++) fresh.emit('download', `f${i}.zip`)
  const { events, leftOut } = w.browser.takeNotes()
  assert.equal(leftOut, 140)
  assert.deepEqual(events, [
    { kind: 'reopened', reason: 'idle' },
    { kind: 'crashed' },
    ...Array.from({ length: LISTED }, (_, i) => ({ kind: 'download', name: `f${140 + i}.zip` })),
  ])
  fresh.emit('filechooser')
  assert.deepEqual(w.browser.takeNotes(), { user: undefined, events: [{ kind: 'filechooser' }], leftOut: 0 }, 'the count starts again')
})

test('takeNotes: a browser the user started says so once; mouse moves alone are no activity', async () => {
  const w = await world({ started: true })
  w.browser.recordNavigation('https://ok.test/')
  assert.equal(w.browser.takeNotes().user?.started, true)
  w.browser.input({ kind: 'mouse', action: 'move', x: 1, y: 1, button: 'left', clickCount: 0 })
  assert.equal(w.browser.takeNotes().user, undefined)
  w.browser.recordNavigation('https://ok.test/2')
  assert.equal(w.browser.takeNotes().user?.started, false)
})

test('the user\'s activity: clicks, typed, keys, scrolled, and the first 5 navigations with the rest counted', async () => {
  const w = await world()
  for (let i = 1; i <= 7; i++) w.browser.recordNavigation(`https://ok.test/${i}`)
  w.browser.input({ kind: 'mouse', action: 'down', x: 1, y: 1, button: 'left', clickCount: 1 })
  w.browser.input({ kind: 'mouse', action: 'up', x: 1, y: 1, button: 'left', clickCount: 1 })
  w.browser.input({ kind: 'mouse', action: 'down', x: 1, y: 1, button: 'right', clickCount: 1 })
  w.browser.input({ kind: 'mouse', action: 'down', x: 1, y: 1, button: 'left', clickCount: 2 })
  w.browser.input({ kind: 'wheel', x: 1, y: 1, dx: 0, dy: 100 })
  let user = w.browser.takeNotes().user
  assert.deepEqual(user?.navigations, ['https://ok.test/1', 'https://ok.test/2', 'https://ok.test/3', 'https://ok.test/4', 'https://ok.test/5'])
  assert.equal(user?.moreNavigations, 2)
  assert.equal(user?.clicks, 2)
  assert.equal(user?.scrolled, true)
  assert.equal(user?.typed, false)
  assert.equal(user?.keys, false)

  w.browser.input({ kind: 'key', action: 'down', key: 'a', code: 'KeyA', modifiers: 0 })
  w.browser.input({ kind: 'key', action: 'up', key: 'a', code: 'KeyA', modifiers: 0 })
  user = w.browser.takeNotes().user
  assert.deepEqual([user?.typed, user?.keys], [true, false])

  w.browser.input({ kind: 'text', text: 'pasted' })
  user = w.browser.takeNotes().user
  assert.deepEqual([user?.typed, user?.keys], [true, false])

  w.browser.input({ kind: 'key', action: 'down', key: 'é', code: 'Digit2', modifiers: 0 })
  user = w.browser.takeNotes().user
  assert.deepEqual([user?.typed, user?.keys], [true, false])

  w.browser.input({ kind: 'key', action: 'down', key: 'Enter', code: 'Enter', modifiers: 0 })
  user = w.browser.takeNotes().user
  assert.deepEqual([user?.typed, user?.keys], [false, true])

  w.browser.input({ kind: 'key', action: 'down', key: 'Control', code: 'ControlLeft', modifiers: CONTROL })
  w.browser.input({ kind: 'key', action: 'down', key: 'a', code: 'KeyA', modifiers: CONTROL })
  user = w.browser.takeNotes().user
  assert.deepEqual([user?.typed, user?.keys], [false, true])
})

test('the user\'s input: replayed in order on its own chain, a move skipped when a newer move is queued behind it', async () => {
  const w = await world()
  const hold = w.page.hold('mouse')
  w.browser.input({ kind: 'mouse', action: 'move', x: 1, y: 1, button: 'left', clickCount: 0 })
  await hold.reached
  w.browser.input({ kind: 'mouse', action: 'move', x: 2, y: 2, button: 'left', clickCount: 0 })
  w.browser.input({ kind: 'mouse', action: 'move', x: 3, y: 3, button: 'left', clickCount: 0 })
  w.browser.input({ kind: 'mouse', action: 'down', x: 3, y: 3, button: 'left', clickCount: 1 })
  w.browser.input({ kind: 'mouse', action: 'up', x: 3, y: 3, button: 'left', clickCount: 1 })
  w.browser.input({ kind: 'wheel', x: 3, y: 3, dx: 0, dy: 120 })
  w.browser.input({ kind: 'text', text: 'hi' })
  w.browser.input({ kind: 'key', action: 'down', key: 'é', code: 'Digit2', modifiers: 0 })
  w.browser.input({ kind: 'key', action: 'up', key: 'é', code: 'Digit2', modifiers: 0 })
  w.browser.input({ kind: 'key', action: 'down', key: 'Enter', code: 'Enter', modifiers: 0 })
  w.browser.input({ kind: 'key', action: 'up', key: 'Enter', code: 'Enter', modifiers: 0 })
  w.browser.input({ kind: 'key', action: 'down', key: 'Nope', code: '', modifiers: 0 })
  hold.release()
  await flush(6)
  const replayed = w.page.calls.filter(call => ['mouse', 'wheel', 'insertText', 'keyDown', 'keyUp'].includes(call.method))
  assert.deepEqual(replayed, [
    { method: 'mouse', args: ['move', 1, 1, 'left', 0] },
    { method: 'mouse', args: ['move', 3, 3, 'left', 0] },
    { method: 'mouse', args: ['down', 3, 3, 'left', 1] },
    { method: 'mouse', args: ['up', 3, 3, 'left', 1] },
    { method: 'wheel', args: [3, 3, 0, 120] },
    { method: 'insertText', args: ['hi'] },
    { method: 'insertText', args: ['é'] },
    { method: 'keyDown', args: ['Enter'] },
    { method: 'keyUp', args: ['Enter'] },
  ])
})

test('the user\'s input: a modifier the core holds down is released before a key whose modifiers don\'t name it', async () => {
  const w = await world()
  w.browser.input({ kind: 'key', action: 'down', key: 'Shift', code: 'ShiftLeft', modifiers: SHIFT })
  w.browser.input({ kind: 'key', action: 'down', key: 'Control', code: 'ControlLeft', modifiers: SHIFT | CONTROL })
  w.browser.input({ kind: 'key', action: 'down', key: 'A', code: 'KeyA', modifiers: SHIFT | CONTROL })
  w.browser.input({ kind: 'key', action: 'down', key: 'b', code: 'KeyB', modifiers: CONTROL })
  w.browser.input({ kind: 'key', action: 'down', key: 'c', code: 'KeyC', modifiers: 0 })
  await flush(6)
  const keys = w.page.calls.filter(call => call.method === 'keyDown' || call.method === 'keyUp').map(call => `${call.method} ${String(call.args[0])}`)
  assert.deepEqual(keys, ['keyDown Shift', 'keyDown Control', 'keyDown A', 'keyUp Shift', 'keyDown b', 'keyUp Control', 'keyDown c'])
})

test('the user\'s input: a replay that fails is ignored, logged once for the session, and the chain goes on', async () => {
  const w = await world()
  w.page.failNext('mouse', new Error('mouse broke'))
  w.page.failNext('wheel', new Error('wheel broke'))
  w.browser.input({ kind: 'mouse', action: 'down', x: 1, y: 1, button: 'left', clickCount: 1 })
  w.browser.input({ kind: 'wheel', x: 1, y: 1, dx: 0, dy: 1 })
  w.browser.input({ kind: 'text', text: 'ok' })
  await flush(6)
  assert.deepEqual(w.page.callsOf('insertText'), [['ok']])
  assert.equal(w.logs.length, 1)
  assert.match(w.logs[0] ?? '', /s1/)
  assert.doesNotMatch(w.logs[0] ?? '', /broke/)
})

test('a replay that fails on a key logs no key: only the session and a reason', async () => {
  const w = await world()
  w.page.failNext('keyDown', new Error('keyboard.down: Unknown key: "Hunter2Secret"'))
  w.browser.input({ kind: 'key', action: 'down', key: 'Enter', code: 'Enter', modifiers: 0 })
  await w.browser.inputsDone()
  assert.equal(w.logs.length, 1)
  assert.doesNotMatch(w.logs[0] ?? '', /Hunter2Secret|Unknown key|Enter/)
})

test('the input chain ends at a close, even on a replay that never settles', async () => {
  const w = await world()
  w.page.hold('mouse')
  w.browser.input({ kind: 'mouse', action: 'down', x: 1, y: 1, button: 'left', clickCount: 1 })
  w.browser.input({ kind: 'mouse', action: 'up', x: 1, y: 1, button: 'left', clickCount: 1 })
  let done = false
  void w.browser.inputsDone().then(() => { done = true })
  await flush()
  assert.equal(done, false)
  w.browser.markClosed('tab')
  await flush()
  assert.equal(done, true)
  assert.equal(w.page.callsOf('mouse').length, 1)
  assert.deepEqual(w.logs, [])
})

test('ensureAllowed ends at a close, even when its about:blank never loads', async () => {
  const w = await world({ workspace: '/work/project' })
  w.page.currentUrl = 'file:///etc/passwd'
  w.page.hold('goto')
  let done = false
  void w.browser.ensureAllowed().then(() => { done = true })
  await flush()
  assert.equal(done, false)
  w.browser.markClosed('agent')
  await flush()
  assert.equal(done, true)
})

test('the user\'s input marks the browser used', async () => {
  const w = await world()
  w.clock.advance(60_000)
  w.browser.input({ kind: 'mouse', action: 'move', x: 1, y: 1, button: 'left', clickCount: 0 })
  assert.equal(w.browser.lastUsed, w.clock.now())
})

// --- the screencast ---------------------------------------------------------------------------------------------------

test('watched: the screencast at the viewport\'s size, frames passed on; lastUsed is now while watched; unwatched stops it', async () => {
  const w = await world()
  w.browser.setWatched(true)
  await flush()
  assert.equal(w.page.screencasting, true)
  assert.deepEqual(w.page.screencastOptions, { quality: 60, maxWidth: 1280, maxHeight: 800 })
  w.page.frame('a')
  assert.deepEqual(w.frames, [{ data: 'a', width: 1280, height: 800 }])
  const before = w.browser.lastUsed
  w.clock.advance(120_000)
  assert.equal(w.browser.lastUsed, before + 120_000)
  w.browser.setWatched(false)
  await flush()
  assert.equal(w.page.screencasting, false)
  w.clock.advance(1000)
  assert.equal(w.browser.lastUsed, w.clock.now() - 1000)
})

// --- a crash ----------------------------------------------------------------------------------------------------------

test('a crash: the call in flight rejects crashed; the page is replaced in the same context; noted; the queue goes on there', async () => {
  const w = await world()
  w.browser.lastSnapshot = { text: '- button "Old" [ref=e1]', digest: 'old' }
  w.browser.setWatched(true)
  await flush()
  const hold = w.page.hold('click')
  const inFlight = w.browser.call(never, page => page.click({ ref: 'e1' }, { timeoutMs: 5000, double: false }))
  const queued = w.browser.call(never, async page => page)
  await hold.reached
  w.page.emit('crash')
  await assert.rejects(inFlight, (error: unknown) => error instanceof BrowserError && error.code === 'crashed')
  const next = await queued
  assert.equal(w.context.pages.length, 2)
  assert.equal(next, w.context.pages[1])
  assert.equal(w.browser.page, w.context.pages[1])
  assert.equal(w.page.closed, true)
  assert.equal(w.browser.lastSnapshot, undefined)
  assert.equal(w.context.pages[1]?.screencasting, true)
  assert.deepEqual(w.browser.takeNotes().events, [{ kind: 'crashed' }])
  assert.deepEqual(w.notices, [{ kind: 'crashed' }])
  assert.equal(w.logs.length, 1)
  assert.match(w.logs[0] ?? '', /the page of s1 crashed/)
  // The old page's events are ignored.
  w.page.emit('download', 'old.zip')
  assert.deepEqual(w.browser.takeNotes().events, [])
})

test('a crash: the user\'s input while the page is replaced goes to the new page', async () => {
  const w = await world()
  w.page.emit('crash')
  w.browser.input({ kind: 'text', text: 'hi' })
  await flush(6)
  assert.deepEqual(w.page.callsOf('insertText'), [])
  assert.deepEqual(w.context.pages[1]?.callsOf('insertText'), [['hi']])
})

// --- a page that stops answering ---------------------------------------------------------------------------------------

test('replaceFrozen: the call in flight goes on, on a new page in the same context; the tab is told, and the agent when asked', async () => {
  const w = await world()
  w.browser.lastSnapshot = { text: '- button "Old" [ref=e1]', digest: 'old' }
  w.browser.lastSubtree = '- button "Older" [ref=e2]'
  w.browser.setWatched(true)
  await flush()
  const queued: string[] = []
  const inFlight = w.browser.call(never, async page => {
    const fresh = await w.browser.replaceFrozen(page, false)
    await fresh.goto('https://ok.test/', { timeoutMs: 1000, loadMs: 0 })
    return fresh
  })
  const next = w.browser.call(never, async page => { queued.push(page === w.context.pages[1] ? 'on the new page' : 'elsewhere') })
  const fresh = await inFlight
  await next
  assert.equal(fresh, w.context.pages[1])
  assert.equal(w.browser.page, fresh)
  assert.equal(w.page.closed, true)
  assert.deepEqual(queued, ['on the new page'])
  assert.equal(w.context.pages[1]?.screencasting, true)
  assert.equal(w.browser.lastSnapshot, undefined)
  assert.equal(w.browser.lastSubtree, undefined)
  assert.deepEqual(w.notices, [{ kind: 'frozen' }])
  assert.deepEqual(w.browser.takeNotes().events, [], 'no note: the call says it')
  assert.match(w.logs.join('\n'), /the page of s1 stopped responding; it was replaced/)

  const again = await w.browser.call(never, page => w.browser.replaceFrozen(page, true))
  assert.equal(again, w.context.pages[2])
  assert.deepEqual(w.browser.takeNotes().events, [{ kind: 'frozen' }])
})

test('replaceFrozen: a page that is no longer the browser\'s is left alone; a browser that closed meanwhile rejects', async () => {
  const w = await world()
  const old = w.page
  await w.browser.call(never, page => w.browser.replaceFrozen(page, false))
  const now = w.browser.page
  assert.equal(await w.browser.replaceFrozen(old, false), now, 'nothing more replaced')
  assert.equal(w.context.pages.length, 2)
  // The new page can't be made: the core closes the browser (`broken`), and the replacement says so.
  w.context.failNewPage = new Error('no more pages')
  const replacing = w.browser.replaceFrozen(now, false)
  w.browser.markClosed('chromium')
  await assert.rejects(replacing, (error: unknown) => error instanceof BrowserError && error.code === 'closed' && error.detail === 'chromium')
})

test('a crash whose page can\'t be replaced: the browser says it is broken', async () => {
  const w = await world()
  w.context.failNewPage = new Error('no more pages')
  w.page.emit('crash')
  await flush()
  assert.equal(w.counts.broken, 1)
})

test('a close cancels the browser\'s timers and ignores its page\'s later events', async () => {
  const w = await world()
  w.page.emit('navigated', 'https://ok.test/')
  w.browser.markClosed('agent')
  const before = w.page.calls.length
  w.clock.advance(1000)
  await flush()
  w.page.emit('download', 'late.zip')
  assert.equal(w.page.calls.length, before)
  assert.deepEqual(w.browser.takeNotes().events, [])
  assert.equal(w.clock.pending, 0)
})
