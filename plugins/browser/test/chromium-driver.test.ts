/**
 * The Playwright driver (`src/playwright.ts`) against a real Chromium.
 *
 * It skips without one: `DISH_TEST_CHROMIUM` when set, else `/usr/bin/chromium` (the VM's, where the project's gate runs
 * it). Every page comes from a server on `127.0.0.1` that this file starts, and `file://` pages from its scratch
 * `TMPDIR`. One Chromium serves the file; each case opens its own context and closes it. The last case closes Chromium
 * and checks that no process holds the scratch `TMPDIR`; `scratchTmp`'s `after` checks again, even on failure.
 *
 * Assertions wait on what a real browser does in its own time (a popup's address, a console line, a frame) with
 * `eventually`, never with a fixed sleep, except to check that nothing more arrives.
 */

import { test } from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DriverBadArgument, DriverClosed, DriverTimeout } from '../src/driver.ts'
import type {
  Driver, DriverBrowser, DriverContext, DriverDialog, DriverPage, DriverPopup, FailedRequest, RouteDecider, RouteRequest, ScreencastFrame,
} from '../src/driver.ts'
import { playwrightDriver } from '../src/playwright.ts'
import { REF_MS } from '../src/types.ts'
import { chromiumPath, launchForTests, pageServer, processesHolding, scratchTmp } from './chromium.ts'
import type { PageServer, TestPage } from './chromium.ts'

const exe = chromiumPath()
const tmp = scratchTmp()

const VIEWPORT = { width: 800, height: 600 }
/** A navigation's times: generous, for a loaded VM. */
const NAV = { timeoutMs: 15_000, loadMs: 5_000 }
/** A ref action's time. */
const ACT = { timeoutMs: 5_000 }
const SNAP = { timeoutMs: 10_000 }

/** Skips `t` when there is no Chromium; says whether it did. */
function skipped(t: TestContext): boolean {
  if (exe !== undefined) return false
  t.skip('no Chromium: set DISH_TEST_CHROMIUM')
  return true
}

/** Resolves once `check` returns true (or doesn't throw), polling every 50 ms; fails after `ms` with `what`. */
async function eventually(what: string, check: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  let last: unknown
  for (;;) {
    try {
      if (await check()) return
      last = undefined
    } catch (error) {
      last = error
    }
    if (Date.now() >= deadline) assert.fail(`${what}: not within ${ms} ms${last === undefined ? '' : ` (${String(last)})`}`)
    await sleep(50)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** The ref of the line `- <role> "<name>" … [ref=…]` in `snapshot`. */
function refOf(snapshot: string, role: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`- ${role} "${escaped}"[^\\n]*?\\[ref=((?:f\\d+)?e\\d+)\\]`).exec(snapshot)
  assert.ok(match, `no ${role} "${name}" with a ref in:\n${snapshot}`)
  return match[1]!
}

/** The ref on the first line of `snapshot` that holds `text`. */
function lineRef(snapshot: string, text: string): string {
  const line = snapshot.split('\n').find(candidate => candidate.includes(text) && /\[ref=/.test(candidate))
  const match = line === undefined ? null : /\[ref=((?:f\d+)?e\d+)\]/.exec(line)
  assert.ok(match, `no line with "${text}" and a ref in:\n${snapshot}`)
  return match[1]!
}

/** A ref's frame part: '' for `e5`, 'f2' for `f2e5`. */
function framePart(ref: string): string {
  return /^(f\d+)?/.exec(ref)?.[1] ?? ''
}

/** A ref's form, as `snapshot.ts`'s `REF`. A main frame's refs aren't always `e…`: Playwright numbers the main frame anew on each new document after the first. */
const REF_FORM = /^(?:f\d+)?e\d+$/

/** Settles with `work`'s outcome, or 'hung' after `ms`. */
async function outcome<T>(work: Promise<T>, ms: number): Promise<{ value: T } | { error: unknown } | 'hung'> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      work.then(value => ({ value }), (error: unknown) => ({ error })),
      new Promise<'hung'>(resolve => { timer = setTimeout(() => resolve('hung'), ms) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Every regular file under `dir` whose whole content is `body`. */
function filesHolding(dir: string, body: string): string[] {
  const found: string[] = []
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return found
  }
  for (const entry of entries) {
    const path = resolve(dir, entry)
    try {
      const stat = statSync(path)
      if (stat.isDirectory()) found.push(...filesHolding(path, body))
      else if (stat.isFile() && stat.size === Buffer.byteLength(body) && readFileSync(path, 'utf8') === body) found.push(path)
    } catch {
      // Gone meanwhile, or not ours to read.
    }
  }
  return found
}

/** A PNG's width and height, from its IHDR chunk; fails when `bytes` isn't a PNG. */
function pngSize(bytes: Uint8Array): { width: number, height: number } {
  const buffer = Buffer.from(bytes)
  assert.deepEqual([...buffer.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'a PNG signature')
  assert.equal(buffer.subarray(12, 16).toString('latin1'), 'IHDR')
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

function assertJpeg(base64: string): void {
  const buffer = Buffer.from(base64, 'base64')
  assert.deepEqual([...buffer.subarray(0, 3)], [0xff, 0xd8, 0xff], 'a JPEG signature')
}

/** A port on 127.0.0.1 where nothing listens: one the OS gave, then closed. */
async function refusedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  await new Promise<void>(resolve => server.close(() => resolve()))
  if (address === null || typeof address === 'string') throw new Error('no port')
  return address.port
}

/** The download's body: no file anywhere may hold it, since downloads are refused. */
const DOWNLOAD_BODY = 'DOWNLOAD-BODY-of-report.txt'

function pages(refused: number): Record<string, TestPage> {
  const html = (body: string): TestPage => ({ body: `<!doctype html><meta charset="utf-8">${body}` })
  return {
    '/form.html': html(`<title>Form</title>
      <form onsubmit="event.preventDefault(); document.title = 'submitted:' + document.getElementById('name').value">
        <p><label>Name <input id="name"></label></p>
        <p><label>Password <input id="password" type="password" value="hunter2-SECRET"></label></p>
        <p><label>Colour <select id="colour"><option value="red">Red</option><option value="green">Green</option><option value="blue">Blue</option></select></label></p>
        <p><button type="submit">Save</button></p>
      </form>
      <p><button onclick="const li = document.createElement('li'); li.textContent = 'item ' + (document.querySelectorAll('#items li').length + 1); document.getElementById('items').append(li)">Add item</button></p>
      <ul id="items"></ul>
      <div role="region" aria-label="Notes">Some notes</div>
      <p><a href="/second.html">Second page</a></p>
      <p><a href="/popup-target.html" target="_blank">Open popup</a></p>
      <p><a href="/blocked-popup.html" target="_blank">Refused popup</a></p>
      <p><button onclick="const w = window.open(''); w.document.write('<p>written by script</p>')">Blank popup</button></p>
      <button id="point" style="position: fixed; left: 620px; top: 20px; width: 150px; height: 40px" onclick="clicks++; show()" ondblclick="doubles++; show()">Point 0 0</button>
      <script>let clicks = 0, doubles = 0; function show() { document.getElementById('point').textContent = 'Point ' + clicks + ' ' + doubles }</script>`),
    '/second.html': html('<title>Second</title><h1>Second page</h1>'),
    '/popup-target.html': html('<title>Popup</title><p>Popup target</p>'),
    '/frame.html': html('<title>Frame</title><p>Outer</p><iframe src="/inner.html" title="Inner"></iframe>'),
    '/inner.html': html(`<button onclick="this.textContent = 'Inner clicked'">Inner button</button>`),
    '/dialogs.html': html(`<title>Dialogs</title>
      <button onclick="alert('hello there')">Alert</button>
      <button onclick="document.title = confirm('sure?') ? 'confirmed' : 'declined'">Confirm</button>
      <script>addEventListener('beforeunload', event => { event.preventDefault(); event.returnValue = '' })</script>`),
    '/download.html': html('<title>Download</title><a href="/report.txt" download="report.txt">Download</a>'),
    '/report.txt': { type: 'text/plain', body: DOWNLOAD_BODY, headers: { 'content-disposition': 'attachment; filename="report.txt"' } },
    '/upload.html': html(`<title>Upload</title><button onclick="document.getElementById('file').click()">Choose file</button><input id="file" type="file" hidden>`),
    '/errors.html': html(`<title>Errors</title>
      <script>console.error('broken thing'); setTimeout(() => { throw new Error('kaboom') }, 0)</script>
      <img src="/missing.png" alt="missing"><img src="http://127.0.0.1:${refused}/refused.png" alt="refused">`),
    '/long.html': html('<title>Long</title><div style="height: 5000px">Top</div><button>Bottom</button>'),
    '/later.html': html(`<title>Later</title><p id="leaving">Leaving soon</p>
      <script>setTimeout(() => { document.getElementById('leaving').remove(); const p = document.createElement('p'); p.textContent = 'Arrived now'; document.body.append(p) }, 500)</script>`),
    '/settle.html': html(`<title>Settle</title><button onclick="location.href = '/slow.html'">Go slow</button><button onclick="this.textContent = 'Stayed'">Stay</button>`),
    '/slow.html': html('<title>Slow</title><script src="/slow.js"></script><p>Slow page</p>'),
    '/slow.js': { type: 'text/javascript', body: `document.title = 'slow done'`, delayMs: 1_500 },
    '/with-blocked.html': html('<title>Blocked image</title><p>Has a blocked image</p><img src="/blocked.png" alt="blocked">'),
    '/ws.html': html(`<title>WebSockets</title><ul id="log"></ul>
      <script>
        const log = text => { const li = document.createElement('li'); li.textContent = text; document.getElementById('log').append(li) }
        const base = location.origin.replace(/^http/, 'ws')
        for (const name of ['refused', 'allowed']) {
          const ws = new WebSocket(base + '/ws-' + name)
          ws.onopen = () => log(name + ' open')
          ws.onclose = event => log(name + ' closed ' + event.code)
          ws.onerror = () => log(name + ' error')
        }
      </script>`),
    '/screencast.html': html(`<title>Screencast</title><p id="tick">0</p>
      <script>let n = 0; setInterval(() => { document.getElementById('tick').textContent = String(++n) }, 50)</script>`),
    '/frozen.html': html('<title>Frozen</title><p>Soon stuck</p><script>setTimeout(() => { for (;;) {} }, 500)</script>'),
    '/freeze-on-wheel.html': html(`<title>Freeze on wheel</title><div style="height: 3000px">Tall</div>
      <script>addEventListener('wheel', () => setTimeout(() => { for (;;) {} }, 0))</script>`),
    '/number.html': html('<title>Number</title><label>Quantity <input type="number" value="7" data-secret="PAGE-ATTR-TEXT"></label>'),
    '/traps.html': html(`<title>Traps</title><label>Secret <input type="password" value="pw"></label><div style="height: 3000px"></div>
      <script>
        Object.defineProperty(window, 'scrollY', { get() { throw new Error('PAGE-SAYS-SCROLL') } })
        Object.defineProperty(HTMLInputElement.prototype, 'type', { get() { throw new Error('PAGE-SAYS-TYPE') } })
      </script>`),
    '/sw.html': html(`<title>Service worker</title><ul id="log"></ul>
      <script>
        const log = text => { const li = document.createElement('li'); li.textContent = text; document.getElementById('log').append(li) }
        // The usual call, or the container's own method: 'block' in Playwright 1.63 only replaced the first.
        const registered = new URLSearchParams(location.search).get('how') === 'prototype'
          ? ServiceWorkerContainer.prototype.register.call(navigator.serviceWorker, '/sw.js')
          : navigator.serviceWorker.register('/sw.js')
        registered.then(async () => {
          log('registered')
          const ready = await navigator.serviceWorker.ready
          navigator.serviceWorker.onmessage = event => log(event.data)
          ready.active.postMessage('go')
        }, error => log('not registered ' + error.name))
      </script>`),
    '/sw.js': { type: 'text/javascript', body: `self.addEventListener('message', event => {
      const say = text => event.source.postMessage(text)
      fetch('/sw-allowed').then(response => say('allowed ' + response.status), () => say('allowed failed'))
      fetch('/blocked-from-sw').then(response => say('blocked ' + response.status), () => say('blocked failed'))
    })` },
    '/sw-allowed': { type: 'text/plain', body: 'fine' },
    '/blocked-from-sw': { type: 'text/plain', body: 'should never be served' },
    '/input.html': html(`<title>Input</title>
      <button style="position: fixed; left: 20px; top: 20px; width: 200px; height: 50px" onclick="this.textContent = 'Pressed ' + (++presses)">Pressed 0</button>
      <input aria-label="Text" style="position: fixed; left: 20px; top: 100px; width: 300px; height: 30px">
      <div style="height: 5000px"></div>
      <script>let presses = 0</script>`),
  }
}

/** The file's page server and Chromium, started on first use. */
let shared: Promise<{ server: PageServer, browser: DriverBrowser, sandbox: boolean }> | undefined
function setUp(): Promise<{ server: PageServer, browser: DriverBrowser, sandbox: boolean }> {
  shared ??= (async () => {
    const server = await pageServer(pages(await refusedPort()))
    const { browser, sandbox } = await launchForTests(playwrightDriver, exe!)
    return { server, browser, sandbox }
  })()
  return shared
}

/** A context and its page for one case, closed after it. `route` defaults to letting everything through. */
async function open(
  t: TestContext,
  options: { route?: RouteDecider, refuseWebSocket?: (url: string) => boolean } = {},
): Promise<{ server: PageServer, context: DriverContext, page: DriverPage }> {
  const { server, browser } = await setUp()
  const context = await browser.newContext({
    viewport: VIEWPORT,
    route: options.route ?? (async () => 'continue'),
    refuseWebSocket: options.refuseWebSocket ?? (() => false),
  })
  t.after(() => context.close())
  const page = await context.newPage()
  return { server, context, page }
}

test('launchForTests falls back to no sandbox only for want of one (a fake driver: this runs without Chromium)', async () => {
  const fakeBrowser: DriverBrowser = {
    newContext: () => Promise.reject(new Error('a fake')),
    onDisconnected: () => {},
    close: async () => {},
  }
  const fake = (failure: string, asked: boolean[]): Driver => ({
    async launch({ sandbox }) {
      asked.push(sandbox)
      if (sandbox) throw new Error(failure)
      return fakeBrowser
    },
  })
  for (const failure of ['[FATAL:zygote_host_impl_linux.cc] No usable sandbox!', 'Failed to move to new namespace: PID namespaces supported']) {
    const asked: boolean[] = []
    const launched = await launchForTests(fake(failure, asked), '/usr/bin/chromium')
    assert.equal(launched.sandbox, false)
    assert.equal(launched.browser, fakeBrowser)
    assert.deepEqual(asked, [true, false])
  }
  const asked: boolean[] = []
  await assert.rejects(launchForTests(fake('error while loading shared libraries: libnss3.so', asked), '/usr/bin/chromium'), /libnss3/)
  assert.deepEqual(asked, [true])
})

test('launch: with Chromium\'s sandbox, or the fallback (says which)', async (t) => {
  if (skipped(t)) return
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const
  const before = signals.map(signal => process.listenerCount(signal))
  const { browser, sandbox } = await setUp()
  t.diagnostic(sandbox ? 'Chromium runs with its own sandbox' : 'Chromium runs without its own sandbox (the fallback)')
  assert.ok(browser)
  // Playwright's signal handlers are off: launching added none (its SIGINT handler would end in process.exit(130)).
  assert.deepEqual(signals.map(signal => process.listenerCount(signal)), before)
  // Chromium's profile is in the scratch TMPDIR, so its processes carry it.
  assert.ok(processesHolding(tmp).length > 0, 'a Chromium process holds the scratch TMPDIR')
})

test('snapshot: refs in ai mode; an iframe\'s refs f…e…; a password value is in the raw snapshot (the reason snapshot.ts blanks it)', async (t) => {
  if (skipped(t)) return
  const { server, page } = await open(t)
  await page.goto(`${server.origin}/form.html`, NAV)
  const snapshot = await page.snapshot(SNAP)
  for (const [role, name] of [['textbox', 'Name'], ['textbox', 'Password'], ['combobox', 'Colour'], ['button', 'Add item'], ['link', 'Second page']]) {
    assert.match(refOf(snapshot, role!, name!), REF_FORM)
  }
  assert.match(snapshot, /textbox "Password" [^\n]*hunter2-SECRET/)

  const notes = refOf(snapshot, 'region', 'Notes')
  const subtree = await page.snapshot({ ...SNAP, ref: notes })
  assert.match(subtree, /Some notes/)
  assert.doesNotMatch(subtree, /Add item/)

  await page.goto(`${server.origin}/frame.html`, NAV)
  const framed = await page.snapshot(SNAP)
  const inner = refOf(framed, 'button', 'Inner button')
  const outer = lineRef(framed, 'Outer')
  assert.match(inner, /^f\d+e\d+$/)
  // The iframe's refs carry its own frame's number, not the main frame's (which may carry one too).
  assert.notEqual(framePart(inner), framePart(outer), `the iframe's ${inner} and the page's ${outer}`)
  assert.equal(await page.hasRef(inner), true)
  await page.click({ ref: inner }, { ...ACT, double: false })
  assert.match(await page.snapshot(SNAP), /button "Inner clicked"/)
})

test('hasRef and isPassword', async (t) => {
  if (skipped(t)) return
  const { server, page } = await open(t)
  await page.goto(`${server.origin}/form.html`, NAV)
  const snapshot = await page.snapshot(SNAP)
  const name = refOf(snapshot, 'textbox', 'Name')
  const password = refOf(snapshot, 'textbox', 'Password')
  assert.equal(await page.hasRef(name), true)
  assert.equal(await page.hasRef('e99999'), false)
  assert.equal(await page.hasRef('f999e1'), false, 'a frame that is gone')
  assert.equal(await page.hasRef('not a ref'), false)
  assert.equal(await page.isPassword(password), true)
  assert.equal(await page.isPassword(name), false)
  await assert.rejects(page.isPassword('e99999'), 'it can\'t tell')
})

test('click by ref and at a point; double', async (t) => {
  if (skipped(t)) return
  const { server, page } = await open(t)
  await page.goto(`${server.origin}/form.html`, NAV)
  let snapshot = await page.snapshot(SNAP)
  await page.click({ ref: refOf(snapshot, 'button', 'Add item') }, { ...ACT, double: false })
  snapshot = await page.snapshot(SNAP)
  assert.match(snapshot, /listitem[^\n]*item 1/)

  // The point button is fixed at x 620–770, y 20–60.
  await page.click({ x: 695, y: 40 }, { ...ACT, double: false })
  assert.match(await page.snapshot(SNAP), /button "Point 1 0"/)
  await page.click({ x: 695, y: 40 }, { ...ACT, double: true })
  assert.match(await page.snapshot(SNAP), /button "Point 3 1"/)
  snapshot = await page.snapshot(SNAP)
  await page.click({ ref: refOf(snapshot, 'button', 'Point 3 1') }, { ...ACT, double: true })
  assert.match(await page.snapshot(SNAP), /button "Point 5 2"/)
})

test('fill, type, press, select, scrollIntoView, scrollBy and scrollPosition', async (t) => {
  if (skipped(t)) return
  const { server, page } = await open(t)
  await page.goto(`${server.origin}/form.html`, NAV)
  let snapshot = await page.snapshot(SNAP)
  const name = refOf(snapshot, 'textbox', 'Name')
  await page.fill(name, 'Ada', ACT)
  assert.match(await page.snapshot(SNAP), /textbox "Name" [^\n]*: Ada$/m)
  // type goes to the focused element: the field fill left focused.
  await page.type(' Lovelace', ACT)
  assert.match(await page.snapshot(SNAP), /textbox "Name" [^\n]*: Ada Lovelace$/m)
  await page.press('Backspace', ACT)
  assert.match(await page.snapshot(SNAP), /textbox "Name" [^\n]*: Ada Lovelac$/m)
  await page.press('Enter', { ...ACT, ref: name })
  await eventually('the form submitted', async () => await page.title() === 'submitted:Ada Lovelac')

  snapshot = await page.snapshot(SNAP)
  assert.deepEqual(await page.select(refOf(snapshot, 'combobox', 'Colour'), ['green'], ACT), ['green'])
  assert.match(await page.snapshot(SNAP), /option "Green" \[selected\]/)

  await page.goto(`${server.origin}/long.html`, NAV)
  const top = await page.scrollPosition()
  assert.equal(top.y, 0)
  assert.ok(top.height >= 5000, `the page is long: ${top.height}`)
  await page.scrollBy(0, 300)
  const scrolled = await page.scrollPosition()
  assert.ok(scrolled.y > 0 && scrolled.y <= 300, `scrolled by the wheel: ${scrolled.y}`)
  snapshot = await page.snapshot(SNAP)
  await page.scrollIntoView(refOf(snapshot, 'button', 'Bottom'), ACT)
  const bottom = await page.scrollPosition()
  assert.ok(bottom.y > 4000, `scrolled to the bottom button: ${bottom.y}`)
})

test('waitForText: appears, gone, a timeout as DriverTimeout', async (t) => {
  if (skipped(t)) return
  const { server, page } = await open(t)
  await page.goto(`${server.origin}/later.html`, NAV)
  await page.waitForText('Arrived now', { timeoutMs: 10_000, gone: false })
  await page.waitForText('Leaving soon', { timeoutMs: 10_000, gone: true })
  await assert.rejects(page.waitForText('Never there', { timeoutMs: 500, gone: false }), DriverTimeout)
})

test('a stale ref after a navigation: hasRef false; an action on it times out as DriverTimeout', async (t) => {
  if (skipped(t)) return
  const { server, page } = await open(t)
  await page.goto(`${server.origin}/form.html`, NAV)
  const add = refOf(await page.snapshot(SNAP), 'button', 'Add item')
  await page.goto(`${server.origin}/second.html`, NAV)
  assert.equal(await page.hasRef(add), false)
  const started = Date.now()
  await assert.rejects(page.click({ ref: add }, { timeoutMs: 1_000, double: false }), DriverTimeout)
  assert.ok(Date.now() - started < 5_000, 'it gave up at its own timeout')
})

test('errors: an unknown key, select on a button, fill on a div → DriverBadArgument', async (t) => {
  if (skipped(t)) return
  const { server, page } = await open(t)
  await page.goto(`${server.origin}/form.html`, NAV)
  const snapshot = await page.snapshot(SNAP)
  const badArgument = (what: DriverBadArgument['what']) => (error: unknown) => error instanceof DriverBadArgument && error.what === what
  await assert.rejects(page.press('NoSuchKey', ACT), badArgument('key'))
  await assert.rejects(page.press('NoSuchKey', { ...ACT, ref: refOf(snapshot, 'textbox', 'Name') }), badArgument('key'))
  await assert.rejects(page.keyDown('NoSuchKey'), badArgument('key'))
  await assert.rejects(page.select(refOf(snapshot, 'button', 'Add item'), ['red'], ACT), badArgument('select'))
  await assert.rejects(page.fill(refOf(snapshot, 'region', 'Notes'), 'text', ACT), badArgument('fill'))
})

test('a frozen page: the calls Playwright doesn\'t time out end within about REF_MS', async (t) => {
  if (skipped(t)) return
  const { server, page } = await open(t)
  await page.goto(`${server.origin}/frozen.html`, NAV)
  // Its script loops for ever from 0.5 s on: nothing in the page answers again.
  await sleep(1_500)
  const limit = REF_MS + 4_000
  const started = Date.now()
  const [hasRef, title, position, scrolled] = await Promise.all([
    outcome(page.hasRef('e1'), limit),
    outcome(page.title(), limit),
    outcome(page.scrollPosition(), limit),
    outcome(page.scrollBy(0, 100), limit),
  ])
  const timedOut = (result: typeof hasRef | typeof title | typeof position | typeof scrolled) =>
    result !== 'hung' && 'error' in result && result.error instanceof DriverTimeout
  assert.ok(timedOut(hasRef), `hasRef: ${String(hasRef === 'hung' ? 'hung' : JSON.stringify(hasRef))}`)
  assert.ok(timedOut(title), `title: ${String(title === 'hung' ? 'hung' : JSON.stringify(title))}`)
  assert.ok(timedOut(scrolled), `scrollBy: ${String(scrolled === 'hung' ? 'hung' : JSON.stringify(scrolled))}`)
  // The scroll position comes from CDP: it may answer, or time out, but never hangs.
  assert.ok(position !== 'hung' && ('value' in position || position.error instanceof DriverTimeout), `scrollPosition: ${JSON.stringify(position)}`)
  t.diagnostic(`scrollPosition on a frozen page: ${'value' in position ? 'CDP answered' : 'timed out'}`)
  assert.ok(Date.now() - started < limit, `they ended in ${Date.now() - started} ms`)

  // A page that freezes once the wheel is in: scrollBy's wait for the scroll to land gives up, and scrollBy ends.
  const wheeled = await open(t)
  await wheeled.page.goto(`${server.origin}/freeze-on-wheel.html`, NAV)
  const result = await outcome(wheeled.page.scrollBy(0, 100), limit)
  assert.ok(result !== 'hung', 'scrollBy ended')
})

test('errors are one line, with no typed text and no page text', async (t) => {
  if (skipped(t)) return
  const { server, page } = await open(t)
  await page.goto(`${server.origin}/number.html`, NAV)
  const quantity = lineRef(await page.snapshot(SNAP), 'Quantity')
  const filled = await outcome(page.fill(quantity, 'TYPED-SECRET-abc', ACT), 10_000)
  assert.ok(filled !== 'hung' && 'error' in filled, 'text into a number field fails')
  const fillError = filled.error as Error
  assert.ok(fillError instanceof DriverBadArgument && fillError.what === 'fill', `a not-fillable error: ${fillError.message}`)
  assert.doesNotMatch(fillError.message, /\n|TYPED-SECRET|PAGE-ATTR-TEXT/)

  // An error the driver doesn't map keeps its first line only: Playwright's call log is dropped.
  const port = await refusedPort()
  const failed = await outcome(page.goto(`http://127.0.0.1:${port}/nothing-here`, NAV), 20_000)
  assert.ok(failed !== 'hung' && 'error' in failed)
  const gotoError = failed.error as Error
  assert.match(gotoError.message, /net::ERR_CONNECTION_REFUSED/)
  assert.doesNotMatch(gotoError.message, /\n|Call log/)

  // What the page's own script can make Playwright say never comes out.
  await page.goto(`${server.origin}/traps.html`, NAV)
  const position = await page.scrollPosition()
  assert.equal(position.y, 0)
  assert.ok(position.height >= 3000, `the page's height: ${position.height}`)
  await page.scrollBy(0, 200).catch((error: unknown) => assert.doesNotMatch(String((error as Error).message), /PAGE-SAYS/))
  // The page's broken scrollY ends scrollBy's wait for the scroll to land, so look again until it has.
  await eventually('the wheel scrolled, though the page\'s scrollY throws', async () => (await page.scrollPosition()).y > 0)
  const secret = lineRef(await page.snapshot(SNAP), 'Secret')
  const checked = await outcome(page.isPassword(secret), 10_000)
  assert.ok(checked !== 'hung' && 'error' in checked, 'it can\'t tell, since the page broke `type`')
  assert.doesNotMatch((checked.error as Error).message, /PAGE-SAYS|\n/)
})

test('a stale f-ref: hasRef false, and an action on it is a DriverTimeout "stale ref" at once', async (t) => {
  if (skipped(t)) return
  const { server, page } = await open(t)
  await page.goto(`${server.origin}/form.html`, NAV)
  await page.goto(`${server.origin}/second.html`, NAV)
  // After the second new document, Playwright numbers the main frame anew, so its refs carry a frame part.
  const heading = refOf(await page.snapshot(SNAP), 'heading', 'Second page')
  assert.match(heading, /^f\d+e\d+$/)
  await page.goto(`${server.origin}/form.html`, NAV)
  assert.equal(await page.hasRef(heading), false)
  const stale = (error: unknown) => error instanceof DriverTimeout && error.message === 'stale ref'
  const started = Date.now()
  await assert.rejects(page.click({ ref: heading }, { ...ACT, double: false }), stale)
  await assert.rejects(page.snapshot({ ...SNAP, ref: heading }), stale)
  await assert.rejects(page.fill(heading, 'text', ACT), stale)
  assert.ok(Date.now() - started < 2_000, 'none of them waited for its timeout')
  // A ref of the page's own frame that matches nothing reads the same way.
  const current = refOf(await page.snapshot(SNAP), 'button', 'Add item')
  await assert.rejects(page.snapshot({ ...SNAP, ref: `${framePart(current)}e99999` }), stale)
})

test('events: navigated and load; popup with its URL; a script-filled popup stays about:blank; dialog accept and dismiss; download name; filechooser; consoleError and uncaught; requestFailed for a 404 and a refused port', async (t) => {
  if (skipped(t)) return
  const { server, page } = await open(t)
  const navigated: string[] = []
  let loads = 0
  const popups: DriverPopup[] = []
  const dialogs: DriverDialog[] = []
  let answer: 'accept' | 'dismiss' = 'dismiss'
  const downloads: string[] = []
  let choosers = 0
  const consoleErrors: string[] = []
  const failed: FailedRequest[] = []
  page.on('navigated', url => navigated.push(url))
  page.on('load', () => { loads++ })
  page.on('popup', popup => popups.push(popup))
  page.on('dialog', dialog => {
    dialogs.push(dialog)
    void (answer === 'accept' || dialog.kind === 'beforeunload' ? dialog.accept() : dialog.dismiss())
  })
  page.on('download', name => downloads.push(name))
  page.on('filechooser', () => { choosers++ })
  page.on('consoleError', text => consoleErrors.push(text))
  page.on('requestFailed', request => failed.push(request))

  await t.test('navigated and load', async () => {
    await page.goto(`${server.origin}/second.html`, NAV)
    await eventually('navigated', () => navigated.includes(`${server.origin}/second.html`))
    await eventually('load', () => loads > 0)
  })

  await t.test('a popup, with its URL', async () => {
    await page.goto(`${server.origin}/form.html`, NAV)
    const snapshot = await page.snapshot(SNAP)
    await page.click({ ref: refOf(snapshot, 'link', 'Open popup') }, { ...ACT, double: false })
    await eventually('a popup', () => popups.length === 1)
    assert.equal(await popups[0]!.waitForUrl(5_000), `${server.origin}/popup-target.html`)
    await popups[0]!.close()
    // A popup doesn't move the page.
    assert.equal(page.url(), `${server.origin}/form.html`)

    await page.click({ ref: refOf(snapshot, 'button', 'Blank popup') }, { ...ACT, double: false })
    await eventually('a second popup', () => popups.length === 2)
    assert.equal(await popups[1]!.waitForUrl(1_000), 'about:blank')
    await popups[1]!.close()
    await popups[1]!.close()
  })

  await t.test('dialogs: dismissed, accepted, and beforeunload', async () => {
    await page.goto(`${server.origin}/dialogs.html`, NAV)
    const snapshot = await page.snapshot(SNAP)
    await page.click({ ref: refOf(snapshot, 'button', 'Alert') }, { ...ACT, double: false })
    await page.click({ ref: refOf(snapshot, 'button', 'Confirm') }, { ...ACT, double: false })
    await eventually('the confirm dismissed', async () => await page.title() === 'declined')
    answer = 'accept'
    await page.click({ ref: refOf(snapshot, 'button', 'Confirm') }, { ...ACT, double: false })
    await eventually('the confirm accepted', async () => await page.title() === 'confirmed')
    answer = 'dismiss'
    // The page asks before it unloads (it had a click); the listener accepts, and the navigation goes on.
    await page.goto(`${server.origin}/second.html`, NAV)
    assert.equal(page.url(), `${server.origin}/second.html`)
    assert.deepEqual(dialogs.map(dialog => dialog.kind), ['alert', 'confirm', 'confirm', 'beforeunload'])
    assert.deepEqual(dialogs.slice(0, 2).map(dialog => dialog.message), ['hello there', 'sure?'])
  })

  await t.test('a download\'s name', async () => {
    await page.goto(`${server.origin}/download.html`, NAV)
    await page.click({ ref: refOf(await page.snapshot(SNAP), 'link', 'Download') }, { ...ACT, double: false })
    await eventually('a download', () => downloads.length === 1)
    assert.deepEqual(downloads, ['report.txt'])
    // acceptDownloads: false: the download is refused, and nothing is written, in Playwright's places or the user's.
    await sleep(1_000)
    assert.ok(server.requests.includes('/report.txt'))
    assert.deepEqual([...filesHolding(tmp, DOWNLOAD_BODY), ...filesHolding(process.env.HOME ?? '', DOWNLOAD_BODY)], [])
  })

  await t.test('a file chooser', async () => {
    await page.goto(`${server.origin}/upload.html`, NAV)
    await page.click({ ref: refOf(await page.snapshot(SNAP), 'button', 'Choose file') }, { ...ACT, double: false })
    await eventually('a file chooser', () => choosers === 1)
  })

  await t.test('console errors, uncaught exceptions and failed requests', async () => {
    await page.goto(`${server.origin}/errors.html`, NAV)
    await eventually('the console error', () => consoleErrors.includes('broken thing'))
    await eventually('the uncaught exception', () => consoleErrors.includes('uncaught: kaboom'))
    await eventually('the 404', () => failed.some(request => request.url === `${server.origin}/missing.png` && request.status === 404))
    await eventually('the refused port', () => failed.some(request => request.url.endsWith('/refused.png') && /ERR_CONNECTION_REFUSED/.test(request.error ?? '')))
  })
})

test('route: sees file:// subresources and the main frame\'s navigations, with mainFrame and ownPage; abort stops them', async (t) => {
  if (skipped(t)) return
  const seen: RouteRequest[] = []
  const route: RouteDecider = async request => {
    seen.push(request)
    return /\/blocked|\/outside\//.test(request.url) ? 'abort' : 'continue'
  }
  const { server, page } = await open(t, { route })
  const strip = (request: RouteRequest | undefined) => request && { navigation: request.navigation, mainFrame: request.mainFrame, ownPage: request.ownPage }

  await t.test('over http: the page, its image, a navigation refused', async () => {
    await page.goto(`${server.origin}/with-blocked.html`, NAV)
    assert.deepEqual(strip(seen.find(request => request.url === `${server.origin}/with-blocked.html`)), { navigation: true, mainFrame: true, ownPage: true })
    assert.deepEqual(strip(seen.find(request => request.url === `${server.origin}/blocked.png`)), { navigation: false, mainFrame: true, ownPage: true })
    assert.ok(!server.requests.includes('/blocked.png'), 'the aborted image never reached the server')
    await assert.rejects(page.goto(`${server.origin}/blocked.html`, NAV), /ERR_BLOCKED_BY_CLIENT/)
    assert.ok(!server.requests.includes('/blocked.html'), 'the aborted navigation never reached the server')
    // The rejection came after Chromium's error page: a navigation right after isn't interrupted by it.
    assert.match(page.url(), /^chrome-error:/)
    await page.goto(`${server.origin}/second.html`, NAV)
    assert.equal(page.url(), `${server.origin}/second.html`)
  })

  await t.test('a popup\'s requests aren\'t the own page\'s; a refused popup gives the address it tried', async () => {
    await page.goto(`${server.origin}/form.html`, NAV)
    const popups: DriverPopup[] = []
    page.on('popup', popup => popups.push(popup))
    const snapshot = await page.snapshot(SNAP)
    await page.click({ ref: refOf(snapshot, 'link', 'Open popup') }, { ...ACT, double: false })
    await eventually('a popup', () => popups.length === 1)
    assert.equal(await popups[0]!.waitForUrl(5_000), `${server.origin}/popup-target.html`)
    const popupRequests = seen.filter(request => request.url === `${server.origin}/popup-target.html`)
    assert.ok(popupRequests.length > 0, 'the route saw the popup\'s navigation')
    assert.ok(popupRequests.every(request => !request.ownPage && request.navigation))
    await popups[0]!.close()

    // The route aborts it, so the popup shows Chromium's error page; what it tried to open is what dish checks.
    await page.click({ ref: refOf(snapshot, 'link', 'Refused popup') }, { ...ACT, double: false })
    await eventually('a refused popup', () => popups.length === 2)
    assert.equal(await popups[1]!.waitForUrl(5_000), `${server.origin}/blocked-popup.html`)
    assert.ok(!server.requests.includes('/blocked-popup.html'))
    await popups[1]!.close()
  })

  await t.test('file://: a workspace page\'s image and iframe outside it', async () => {
    const workspace = resolve(tmp, 'workspace')
    const outside = resolve(tmp, 'outside')
    mkdirSync(workspace, { recursive: true })
    mkdirSync(outside, { recursive: true })
    writeFileSync(resolve(outside, 'secret.html'), '<!doctype html><p>TOP-SECRET-TEXT</p>')
    writeFileSync(resolve(outside, 'secret.png'), Buffer.from('not really a png'))
    const index = pathToFileURL(resolve(workspace, 'index.html')).href
    const image = pathToFileURL(resolve(outside, 'secret.png')).href
    const framed = pathToFileURL(resolve(outside, 'secret.html')).href
    writeFileSync(resolve(workspace, 'index.html'),
      `<!doctype html><title>Workspace</title><p>In the workspace</p><img src="${image}" alt="secret"><iframe src="${framed}" title="Secret"></iframe>`)

    // Allowed, the iframe's text reaches the snapshot (the spike's finding): the route is what keeps it out.
    const control = await open(t)
    await control.page.goto(index, NAV)
    assert.match(await control.page.snapshot(SNAP), /TOP-SECRET-TEXT/)

    await page.goto(index, NAV)
    assert.deepEqual(strip(seen.find(request => request.url === index)), { navigation: true, mainFrame: true, ownPage: true })
    assert.deepEqual(strip(seen.find(request => request.url === image)), { navigation: false, mainFrame: true, ownPage: true })
    const iframe = seen.find(request => request.url === framed)
    assert.ok(iframe, 'the route saw the iframe\'s navigation')
    assert.equal(iframe.navigation, true)
    assert.equal(iframe.mainFrame, false)
    const snapshot = await page.snapshot(SNAP)
    assert.match(snapshot, /In the workspace/)
    assert.doesNotMatch(snapshot, /TOP-SECRET-TEXT/)
  })

  await t.test('a decider that throws aborts the request', async () => {
    const throwing = await open(t, {
      route: async request => {
        if (/\/blocked/.test(request.url)) throw new Error('dish could not check it')
        return 'continue'
      },
    })
    const before = server.requests.length
    await throwing.page.goto(`${server.origin}/with-blocked.html`, NAV)
    await assert.rejects(throwing.page.goto(`${server.origin}/blocked.html`, NAV), /ERR_BLOCKED_BY_CLIENT/)
    const reached = server.requests.slice(before)
    assert.ok(reached.includes('/with-blocked.html'))
    assert.ok(!reached.includes('/blocked.png') && !reached.includes('/blocked.html'), `reached: ${reached.join(', ')}`)
  })
})

test('service workers: the route sees a worker\'s script and its fetches, however it was registered, and aborts a refused one', async (t) => {
  if (skipped(t)) return
  for (const how of ['usual', 'prototype']) {
    await t.test(how, async () => {
      const seen: RouteRequest[] = []
      const { server, page } = await open(t, {
        route: async request => {
          seen.push(request)
          return /\/blocked/.test(request.url) ? 'abort' : 'continue'
        },
      })
      const before = server.requests.length
      await page.goto(`${server.origin}/sw.html?how=${how}`, NAV)
      await page.waitForText('allowed 200', { timeoutMs: 15_000, gone: false })
      await page.waitForText('blocked failed', { timeoutMs: 15_000, gone: false })
      const strip = (request: RouteRequest | undefined) => request && { navigation: request.navigation, mainFrame: request.mainFrame, ownPage: request.ownPage }
      assert.deepEqual(strip(seen.find(request => request.url === `${server.origin}/sw.js`)), { navigation: false, mainFrame: false, ownPage: false })
      assert.deepEqual(strip(seen.find(request => request.url === `${server.origin}/blocked-from-sw`)), { navigation: false, mainFrame: false, ownPage: false })
      const reached = server.requests.slice(before)
      assert.ok(reached.includes('/sw-allowed'), `reached: ${reached.join(', ')}`)
      assert.ok(!reached.includes('/blocked-from-sw'), 'the refused fetch never reached the server')
    })
  }
})

test('routeWebSocket: a refused URL is closed', async (t) => {
  if (skipped(t)) return
  const asked: string[] = []
  const { server, page } = await open(t, {
    refuseWebSocket: url => {
      asked.push(url)
      return url.endsWith('/ws-refused')
    },
  })
  await page.goto(`${server.origin}/ws.html`, NAV)
  await page.waitForText('allowed open', { timeoutMs: 10_000, gone: false })
  await page.waitForText('refused closed 1008', { timeoutMs: 10_000, gone: false })
  const snapshot = await page.snapshot(SNAP)
  assert.doesNotMatch(snapshot, /refused open/)
  assert.ok(asked.includes(`ws://127.0.0.1:${server.port}/ws-refused`), `asked about: ${asked.join(', ')}`)
  assert.ok(server.upgrades.includes('/ws-allowed'))
  assert.ok(!server.upgrades.includes('/ws-refused'), 'the refused socket never reached the server')
})

test('settle: waits for a click\'s navigation; returns at once with none', async (t) => {
  if (skipped(t)) return
  const { server, page } = await open(t)
  await page.goto(`${server.origin}/settle.html`, NAV)
  await page.click({ ref: refOf(await page.snapshot(SNAP), 'button', 'Go slow') }, { ...ACT, double: false })
  // The new page commits at once, and its DOM waits for a script the server holds back 1.5 s.
  await page.settle(10_000)
  assert.equal(page.url(), `${server.origin}/slow.html`)
  assert.equal(await page.title(), 'slow done')

  await page.goto(`${server.origin}/settle.html`, NAV)
  await page.click({ ref: refOf(await page.snapshot(SNAP), 'button', 'Stay') }, { ...ACT, double: false })
  const started = Date.now()
  await page.settle(3_000)
  assert.ok(Date.now() - started < 1_500, `settle returned in ${Date.now() - started} ms`)
})

test('history: canGoBack and canGoForward', async (t) => {
  if (skipped(t)) return
  const { server, page } = await open(t)
  assert.deepEqual(await page.history(), { canGoBack: false, canGoForward: false })
  assert.equal(await page.back(ACT), false)
  assert.equal(await page.forward(ACT), false)
  await page.goto(`${server.origin}/form.html`, NAV)
  await page.goto(`${server.origin}/second.html`, NAV)
  assert.deepEqual(await page.history(), { canGoBack: true, canGoForward: false })
  assert.equal(await page.back(ACT), true)
  assert.equal(page.url(), `${server.origin}/form.html`)
  assert.equal((await page.history()).canGoForward, true)
  assert.equal(await page.forward(ACT), true)
  assert.equal(page.url(), `${server.origin}/second.html`)
  assert.equal((await page.history()).canGoForward, false)
  await page.reload(ACT)
  assert.equal(page.url(), `${server.origin}/second.html`)
})

test('screenshot: a PNG (its signature), of the viewport and of an element', async (t) => {
  if (skipped(t)) return
  const { server, page } = await open(t)
  await page.goto(`${server.origin}/form.html`, NAV)
  assert.deepEqual(pngSize(await page.screenshot({ timeoutMs: 10_000 })), VIEWPORT)
  const add = refOf(await page.snapshot(SNAP), 'button', 'Add item')
  const element = pngSize(await page.screenshot({ timeoutMs: 10_000, ref: add }))
  assert.ok(element.width > 0 && element.width < VIEWPORT.width, `the element's width: ${element.width}`)
  assert.ok(element.height > 0 && element.height < VIEWPORT.height, `the element's height: ${element.height}`)
})

test('screencast: frames arrive with the viewport\'s size while started, none after stop; capture gives a JPEG', async (t) => {
  if (skipped(t)) return
  const { server, page } = await open(t)
  await page.goto(`${server.origin}/screencast.html`, NAV)
  const frames: ScreencastFrame[] = []
  await page.startScreencast({ quality: 60, maxWidth: VIEWPORT.width, maxHeight: VIEWPORT.height }, frame => frames.push(frame))
  await eventually('two frames', () => frames.length >= 2)
  for (const frame of frames) {
    assert.deepEqual({ width: frame.width, height: frame.height }, VIEWPORT)
    assertJpeg(frame.data)
  }
  await page.stopScreencast()
  const count = frames.length
  // The page keeps painting (a counter every 50 ms): a frame would come if the screencast were still on.
  await sleep(1_000)
  assert.equal(frames.length, count, 'no frame after stop')
  await page.stopScreencast()

  const captured = await page.capture(60)
  assert.deepEqual({ width: captured.width, height: captured.height }, VIEWPORT)
  assertJpeg(captured.data)
})

test('input: mouse down and up on a button increments its counter; keyDown and keyUp; insertText; wheel scrolls', async (t) => {
  if (skipped(t)) return
  const { server, page } = await open(t)
  await page.goto(`${server.origin}/input.html`, NAV)
  // The button is fixed at x 20–220, y 20–70; the field at x 20–320, y 100–130.
  await page.mouse('move', 120, 45, 'left', 0)
  await page.mouse('down', 120, 45, 'left', 1)
  await page.mouse('up', 120, 45, 'left', 1)
  assert.match(await page.snapshot(SNAP), /button "Pressed 1"/)

  await page.mouse('down', 170, 115, 'left', 1)
  await page.mouse('up', 170, 115, 'left', 1)
  await page.keyDown('a')
  await page.keyUp('a')
  await page.keyDown('Shift')
  await page.keyDown('B')
  await page.keyUp('B')
  await page.keyUp('Shift')
  await page.insertText(' héllo wörld')
  assert.match(await page.snapshot(SNAP), /textbox "Text" [^\n]*: aB héllo wörld$/m)

  assert.equal((await page.scrollPosition()).y, 0)
  await page.wheel(400, 400, 0, 300)
  await eventually('the wheel scrolled', async () => (await page.scrollPosition()).y > 0)
})

test('crash: page.goto("chrome://crash") through Playwright fires crash', async (t) => {
  if (skipped(t)) return
  const { page } = await open(t)
  let crashed = 0
  page.on('crash', () => { crashed++ })
  await page.goto('chrome://crash', { timeoutMs: 10_000, loadMs: 1_000 }).catch(() => {})
  await eventually('the crash event', () => crashed === 1)
  // The page is gone: an action on it says so.
  await assert.rejects(page.snapshot(SNAP), (error: unknown) => error instanceof DriverClosed)
})

test('close: no process holds the scratch TMPDIR afterwards', async (t) => {
  if (skipped(t)) return
  const { browser } = await setUp()
  const context = await browser.newContext({ viewport: VIEWPORT, route: async () => 'continue', refuseWebSocket: () => false })
  const page = await context.newPage()
  let disconnected = 0
  browser.onDisconnected(() => { disconnected++ })
  await page.close()
  await page.close()
  await context.close()
  await context.close()
  await browser.close()
  await eventually('disconnected', () => disconnected === 1)
  await eventually('no process holds the scratch TMPDIR', () => processesHolding(tmp).length === 0, 15_000)
  await browser.close()
  // A listener that comes after the end is still called, once.
  let late = 0
  browser.onDisconnected(() => { late++ })
  await eventually('a late listener', () => late === 1)
  assert.equal(disconnected, 1)
  await assert.rejects(browser.newContext({ viewport: VIEWPORT, route: async () => 'continue', refuseWebSocket: () => false }), DriverClosed)
})
