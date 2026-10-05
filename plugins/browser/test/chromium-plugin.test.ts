/**
 * The whole plugin against a real Chromium: `index.ts` mounted in a cordis `Context` on the real driver, its tools called
 * through dsh's `ToolRuntime`, and its stream through `watchStream` over the plugin's own core.
 *
 * It skips without Chromium: `DISH_TEST_CHROMIUM` when set, else `/usr/bin/chromium` (the VM's, where the project's gate
 * runs it). Pages come from a server on `127.0.0.1` that this file starts; a second one stands for dsh's own web server,
 * and its port is `webServer`'s. `file://` pages come from a workspace in the scratch `TMPDIR`. dsh's and crew's services
 * are stubs: a live agent whose route takes images, the sandbox policy giving the workspace, an attachment store that
 * records `saveImage`, and `llm`.
 *
 * Each case uses a session of its own and closes its browser after it. The last case disposes the plugin and checks that
 * no process holds the scratch `TMPDIR`; `scratchTmp`'s `after` disposes it too (`closeLater`), even on failure, and checks
 * again. Assertions wait on what a real browser does in its own time with `eventually`, never with a fixed sleep, except
 * to check that nothing more arrives.
 */

import { test } from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { format } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Browsers } from '../src/browsers.ts'
import { systemClock } from '../src/clock.ts'
import type { Driver, DriverBrowser, DriverContext, DriverPage } from '../src/driver.ts'
import * as plugin from '../src/index.ts'
import type { Config } from '../src/index.ts'
import { KEY_NAMES } from '../src/keys.ts'
import { playwrightDriver } from '../src/playwright.ts'
import type { Down, FrameDown } from '../src/protocol.ts'
import { watchStream } from '../src/remote.ts'
import type { RemoteOptions } from '../src/remote.ts'
import { contextServices } from '../src/services.ts'
import type { AgentHandle, ImageRef } from '../src/services.ts'
import { REF_MS } from '../src/types.ts'
import { errorText, notDone, noteText, PASSWORD_HIDDEN, urlRefusal } from '../src/words.ts'
import { chromiumPath, closeLater, pageServer, processesHolding, scratchTmp } from './chromium.ts'
import type { PageServer, TestPage } from './chromium.ts'

const exe = chromiumPath()
const tmp = scratchTmp()

const VIEWPORT = { width: 800, height: 600 }
const LIMITS = { maxBrowsers: 6, idleMinutes: 15 }
/** A navigation's times, for the driver called directly: generous, for a loaded VM. */
const NAV = { timeoutMs: 15_000, loadMs: 5_000 }
const SNAP = { timeoutMs: 10_000 }
const PASSWORD = 'hunter2-SECRET'

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

/** The ref of the line `- <role> "<name>" … [ref=…]` in a result's tree. */
function refOf(text: string, role: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`- ${role} "${escaped}"[^\\n]*?\\[ref=((?:f\\d+)?e\\d+)\\]`).exec(text)
  assert.ok(match, `no ${role} "${name}" with a ref in:\n${text}`)
  return match[1]!
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

// --- the pages ----------------------------------------------------------------------------------------------------------

function pages(dshPort: number): Record<string, TestPage> {
  const html = (body: string): TestPage => ({ body: `<!doctype html><meta charset="utf-8">${body}` })
  const fixedButton = 'style="position: fixed; left: 20px; top: 20px; width: 200px; height: 50px" onclick="this.textContent = \'Pressed \' + (++presses)"'
  return {
    '/form.html': html(`<title>Form</title>
      <form onsubmit="event.preventDefault(); document.title = 'submitted:' + document.getElementById('name').value">
        <p><label>Name <input id="name"></label></p>
        <p><label>Password <input id="password" type="password" value="${PASSWORD}"></label></p>
        <p><label>Colour <select id="colour"><option value="red">Red</option><option value="green">Green</option></select></label></p>
        <p><label>Keys <input id="keys" onkeydown="document.title = 'key:' + event.key"></label></p>
        <p><button type="submit">Save</button></p>
      </form>
      <p><button onclick="const li = document.createElement('li'); li.textContent = 'item ' + (document.querySelectorAll('#items li').length + 1); document.getElementById('items').append(li)">Add item</button></p>
      <ul id="items"></ul>
      <div role="region" aria-label="Notes">Some notes</div>
      <p><button onclick="setTimeout(() => { document.getElementById('leaving').remove(); const p = document.createElement('p'); p.textContent = 'Arrived now'; document.body.append(p) }, 300)">Later</button></p>
      <p id="leaving">Leaving soon</p>
      <p><a href="/second.html">Second page</a></p>
      <div style="height: 3000px"></div>
      <button>Bottom</button>`),
    '/second.html': html('<title>Second</title><h1>Second page</h1><p><a href="/form.html">Back to the form</a></p>'),
    '/third.html': html('<title>Third</title><h1>Third page</h1>'),
    '/events.html': html(`<title>Events</title>
      <p><a href="/popup-target.html" target="_blank">Open popup</a></p>
      <p><button onclick="document.title = confirm('sure?') ? 'confirmed' : 'declined'">Confirm</button></p>
      <p><a href="/report.txt" download="report.txt">Download</a></p>`),
    '/popup-target.html': html('<title>Popup</title><p>Popup target</p>'),
    '/report.txt': { type: 'text/plain', body: 'DOWNLOAD-BODY', headers: { 'content-disposition': 'attachment; filename="report.txt"' } },
    '/own.html': html(`<title>Own</title><p>Reaching dsh</p>
      <img src="http://127.0.0.1:${dshPort}/probe.png" alt="probe">
      <p><a href="http://localhost:${dshPort}/">dsh itself</a></p>
      <script>
        fetch('http://localhost:${dshPort}/fetched').catch(() => {})
        try { new WebSocket('ws://127.0.0.1:${dshPort}/ws') } catch {}
      </script>`),
    '/input.html': html(`<title>Input</title><button ${fixedButton}>Pressed 0</button>
      <textarea aria-label="Keys" autofocus style="position: fixed; left: 20px; top: 100px; width: 300px; height: 60px"></textarea>
      <script>let presses = 0</script>`),
    '/frozen.html': html('<title>Frozen</title><p>Soon stuck</p><script>document.cookie = "kept=yes; path=/"; setTimeout(() => { for (;;) {} }, 300)</script>'),
    '/cookie.html': html('<title>Cookie</title><p id="cookie"></p><script>document.getElementById("cookie").textContent = "cookie " + document.cookie</script>'),
    '/long.html': html(`<title>Long</title><ul>${Array.from({ length: 1500 }, (_, i) => `<li><a href="/x${i}">Link number ${i}</a></li>`).join('')}</ul>
      <section aria-label="Bottom"><button onclick="const li = document.createElement('li'); li.textContent = 'ADDED-' + document.querySelectorAll('#added li').length; document.getElementById('added').append(li)">Add at bottom</button><ul id="added"></ul></section>`),
    '/spam.html': html(`<title>Spam</title><button onclick="for (let i = 0; i < 150; i++) alert('message ' + i + ' ' + 'x'.repeat(600))">Spam</button>`),
    '/screencast.html': html(`<title>Screencast</title><button ${fixedButton}>Pressed 0</button>
      <p id="tick" style="position: fixed; left: 20px; top: 120px">0</p>
      <script>let presses = 0, n = 0; setInterval(() => { document.getElementById('tick').textContent = String(++n) }, 30)</script>`),
  }
}

// --- the plugin ---------------------------------------------------------------------------------------------------------

/** A cordis fiber, as `ctx.plugin` gives it. */
type Handle = PromiseLike<unknown> & { dispose(): Promise<unknown> }

function provideStub(ctx: Context, name: string, value: unknown): Handle {
  return ctx.plugin({
    name: `stub-${name}`,
    apply(own: Context) { (own as unknown as { provide(name: string, value: unknown): void }).provide(name, value) },
  } as never, undefined as never) as unknown as Handle
}

interface ToolResult { isError: boolean, content: Array<{ type: string, text?: string }>, meta?: unknown }
interface ToolsService {
  register(tool: ToolDefinition): () => void
  execute(call: { callId: string, name: string, arguments: unknown, agent: unknown, signal: AbortSignal }): Promise<ToolResult>
}

/** What a test may do between the core's `hasRef` and the action that follows: the page moving on meanwhile. */
interface Hooks { afterHasRef: ((page: DriverPage) => Promise<void>) | undefined }

/**
 * The real driver, counted, with one seam: `hooks.afterHasRef` runs (once) after a `hasRef` that found its ref, before
 * the tool's action. Everything else is the real page's.
 */
function hookedDriver(real: Driver, hooks: Hooks, launched: () => void): Driver {
  const forward = <T extends object>(target: T, own: Partial<Record<keyof T, unknown>>): T => new Proxy(target, {
    get(object, property) {
      if (Object.hasOwn(own, property)) return own[property as keyof T]
      const value = Reflect.get(object, property, object) as unknown
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(object) : value
    },
  })
  const page = (target: DriverPage): DriverPage => forward(target, {
    hasRef: async (ref: string) => {
      const found = await target.hasRef(ref)
      const hook = hooks.afterHasRef
      if (found && hook !== undefined) {
        hooks.afterHasRef = undefined
        await hook(target)
      }
      return found
    },
  })
  const context = (target: DriverContext): DriverContext => forward(target, { newPage: async () => page(await target.newPage()) })
  const browser = (target: DriverBrowser): DriverBrowser => forward(target, {
    newContext: async (options: Parameters<DriverBrowser['newContext']>[0]) => context(await target.newContext(options)),
  })
  return {
    async launch(options) {
      launched()
      return browser(await real.launch(options))
    },
  }
}

interface Setup {
  ctx: Context
  core: Browsers
  tools: ToolsService
  site: PageServer
  dsh: PageServer
  workspace: string
  agents: Map<string, AgentHandle>
  saved: Array<{ data: Uint8Array, mediaType: string, name?: string }>
  logs: string[]
  hooks: Hooks
  launches(): number
  dispose(): Promise<void>
}

/** The plugin, its stubs, the two servers and the workspace, made on first use and disposed in `after`. */
let shared: Promise<Setup> | undefined
function setUp(): Promise<Setup> {
  shared ??= (async () => {
    const dsh = await pageServer({})
    const site = await pageServer(pages(dsh.port))
    const workspace = join(tmp, 'workspace')
    mkdirSync(workspace)
    const outside = join(tmp, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'secret.html'), '<!doctype html><p>TOP-SECRET-TEXT</p>')
    writeFileSync(join(workspace, 'index.html'), '<!doctype html><meta charset="utf-8"><title>Workspace page</title><h1>In the workspace</h1>'
      + `<img src="file:///etc/hostname" alt="host"><iframe src="${pathToFileURL(join(outside, 'secret.html')).href}" title="Outside"></iframe>`)
    symlinkSync('/etc/hostname', join(workspace, 'out.html'))
    const root = realpathSync(workspace)

    const ctx = new Context()
    const logs: string[] = []
    ctx.logger.exporter({ levels: { default: 3 }, export: ({ name, type, args }) => { logs.push(`[${name}] ${type}: ${format(...args)}`) } })
    const handles: Handle[] = []
    const mount = async (handle: Handle): Promise<void> => {
      handles.push(handle)
      await handle
    }
    const { ToolRuntime } = await import('@deepseek-ai/dsh-tools')
    await mount(provideStub(ctx, 'systemPrompt', { tools() {}, section() {}, getSectionOrder: () => 1 }))
    await mount(ctx.plugin(ToolRuntime, {}) as unknown as Handle)
    const agents = new Map<string, AgentHandle>()
    const saved: Setup['saved'] = []
    await mount(provideStub(ctx, 'agents', { get: (id: string) => agents.get(id) }))
    await mount(provideStub(ctx, 'sandboxPolicy', { resolve: () => ({ workspaceRoot: root }) }))
    await mount(provideStub(ctx, 'llm', { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) }))
    await mount(provideStub(ctx, 'attachments', {
      imageLimits: { mediaTypes: ['image/png', 'image/jpeg'] },
      async saveImage(input: { data: Uint8Array, mediaType: string, name?: string }): Promise<ImageRef> {
        saved.push({ ...input })
        const size = pngSize(input.data)
        return { attachmentId: `att-${saved.length}`, mediaType: input.mediaType, bytes: input.data.length, ...size, ...input.name === undefined ? {} : { name: input.name } }
      },
    }))
    await mount(provideStub(ctx, 'workspaceRegistry', { archivedSessionIds: [] }))
    await mount(provideStub(ctx, 'webServer', { port: dsh.port }))
    const hooks: Hooks = { afterHasRef: undefined }
    let launches = 0
    let core: Browsers | undefined
    const config: Partial<Config> = { executablePath: exe!, viewport: VIEWPORT, terminal: false }
    const mounted = ctx.plugin({
      name: plugin.name,
      Config: plugin.Config,
      apply: (own: Context, given: Config) => {
        core = plugin.start(own, given, { driver: hookedDriver(playwrightDriver, hooks, () => { launches++ }), env: {} })
      },
    } as never, config as never) as unknown as Handle
    let disposed = false
    const dispose = async (): Promise<void> => {
      if (disposed) return
      disposed = true
      await mounted.dispose()
      for (const handle of handles.reverse()) await handle.dispose()
    }
    // Whatever happens, the plugin goes before `scratchTmp` checks for Chromium's processes.
    closeLater(dispose)
    await mounted
    assert.ok(core !== undefined, 'the plugin started')
    return {
      ctx, core, tools: ctx.get('tools') as unknown as ToolsService, site, dsh, workspace: root, agents, saved, logs, hooks,
      launches: () => launches,
      dispose,
    }
  })()
  return shared
}

/** A live agent of its own for one case, whose browser closes after it. */
function session(t: TestContext, s: Setup, id: string): string {
  s.agents.set(id, {
    id,
    session: { header: { id, cwd: s.workspace }, requestHeader: () => ({ config: { provider: 'test', model: 'vision' } }) },
    options: {},
  })
  t.after(async () => {
    s.agents.delete(id)
    await s.core.close(id, 'agent')
  })
  return id
}

let calls = 0
/** Every result text this file got, for the checks that run over all of them. */
const results: string[] = []

/** One tool call through dsh's ToolRuntime, as the session's agent. */
async function call(s: Setup, id: string, name: string, args: Record<string, unknown> = {}): Promise<ToolResult & { text: string }> {
  const result = await s.tools.execute({ callId: `c-${++calls}`, name, arguments: args, agent: s.agents.get(id), signal: new AbortController().signal })
  const text = result.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
  results.push(text)
  return { ...result, text }
}

/** A call that must succeed; gives its text. */
async function ok(s: Setup, id: string, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const result = await call(s, id, name, args)
  assert.equal(result.isError, false, `${name} failed: ${result.text}`)
  return result.text
}

/** `browser_read` until `until` holds of the newest text, at most `ms`; gives every text read, oldest first. */
async function readUntil(s: Setup, id: string, until: (text: string) => boolean, what: string, ms = 10_000): Promise<string[]> {
  const texts: string[] = []
  await eventually(what, async () => {
    texts.push(await ok(s, id, 'browser_read'))
    return until(texts.at(-1)!)
  }, ms)
  return texts
}

// --- the cases ----------------------------------------------------------------------------------------------------------

test('navigate, then click by ref: the button\'s effect is in the next tree', async (t) => {
  if (skipped(t)) return
  const s = await setUp()
  const id = session(t, s, 'click')
  const opened = await ok(s, id, 'browser_navigate', { url: `${s.site.origin}/form.html` })
  assert.match(opened, new RegExp(`^Opened ${s.site.origin}/form\\.html\\.\\nPage: ${s.site.origin}/form\\.html — "Form"`))
  const add = refOf(opened, 'button', 'Add item')
  const clicked = await ok(s, id, 'browser_click', { ref: add })
  assert.match(clicked, new RegExp(`^Clicked button "Add item" \\[ref=${add}\\]\\.`))
  assert.match(clicked, /listitem[^\n]*item 1/)
  const twice = await ok(s, id, 'browser_click', { ref: add })
  assert.match(twice, /item 2/)
  assert.equal(s.launches(), 1, 'one Chromium')
})

test('type with submit, select, press, scroll and wait', async (t) => {
  if (skipped(t)) return
  const s = await setUp()
  const id = session(t, s, 'forms')
  const opened = await ok(s, id, 'browser_navigate', { url: `${s.site.origin}/form.html` })

  const typed = await ok(s, id, 'browser_type', { ref: refOf(opened, 'textbox', 'Name'), text: 'Ada', submit: true })
  assert.match(typed, /^Typed into textbox "Name" \[ref=[^\]]+\] and pressed Enter\.\n/)
  assert.match(typed, /— "submitted:Ada"/)

  const chose = await ok(s, id, 'browser_select', { ref: refOf(opened, 'combobox', 'Colour'), values: ['Green'] })
  assert.match(chose, /^Chose "green" in combobox "Colour"/)

  const pressed = await ok(s, id, 'browser_press', { ref: refOf(opened, 'textbox', 'Keys'), key: 'ArrowDown' })
  assert.match(pressed, /^Pressed ArrowDown on textbox "Keys"/)
  assert.match(pressed, /— "key:ArrowDown"/)

  const toBottom = await ok(s, id, 'browser_scroll', { ref: refOf(opened, 'button', 'Bottom') })
  assert.match(toBottom, /^Scrolled button "Bottom" \[ref=[^\]]+\] into view\./)
  const down = Number(/^Scrolled (\d+) of/m.exec((await ok(s, id, 'browser_read')).replace(/,/g, ''))?.[1])
  assert.ok(down > 0, 'scrolled down')
  const up = await ok(s, id, 'browser_scroll', { dy: -500 })
  const now = Number(/^Scrolled the page: now at (\d+) of/.exec(up.replace(/,/g, ''))?.[1])
  assert.ok(now < down, `${now} < ${down}`)

  await ok(s, id, 'browser_click', { ref: refOf(opened, 'button', 'Later') })
  assert.match(await ok(s, id, 'browser_wait', { text: 'Arrived now' }), /^"Arrived now" appeared\./)
  assert.match(await ok(s, id, 'browser_wait', { gone: 'Leaving soon' }), /^"Leaving soon" is gone\./)
  const started = Date.now()
  assert.match(await ok(s, id, 'browser_wait', { seconds: 1 }), /^Waited 1 s\./)
  assert.ok(Date.now() - started >= 900, 'it waited')
  const missing = await ok(s, id, 'browser_wait', { text: 'Never there', seconds: 1 })
  assert.match(missing, /^Not done: "Never there" didn't appear within 1 s\./)
})

test('a stale ref after a navigation: Not done, without waiting 5 s; the driver\'s "stale ref" reads the same', async (t) => {
  if (skipped(t)) return
  const s = await setUp()
  const id = session(t, s, 'stale')
  const form = await ok(s, id, 'browser_navigate', { url: `${s.site.origin}/form.html` })
  const add = refOf(form, 'button', 'Add item')
  const second = await ok(s, id, 'browser_navigate', { url: `${s.site.origin}/second.html` })
  let started = Date.now()
  const stale = await ok(s, id, 'browser_click', { ref: add })
  assert.ok(Date.now() - started < REF_MS, `found stale in ${Date.now() - started} ms`)
  assert.equal(stale.split('\n')[0], notDone.stale(add))
  assert.match(stale, /heading "Second page"/, 'with a fresh tree')

  // The page moves on between `hasRef` and the click: the driver finds the ref stale at once ('stale ref'), and the tool
  // words it as stale, not as slow. A ref of the second document onward carries its frame's number, which a new
  // document changes.
  const heading = refOf(second, 'heading', 'Second page')
  assert.match(heading, /^f\d+e\d+$/)
  let movingMs: number | undefined
  s.hooks.afterHasRef = async (page) => {
    const from = Date.now()
    await page.goto(`${s.site.origin}/third.html`, NAV)
    movingMs = Date.now() - from
  }
  started = Date.now()
  const raced = await ok(s, id, 'browser_click', { ref: heading })
  assert.ok(movingMs !== undefined, 'the page moved on after hasRef')
  const took = Date.now() - started - movingMs
  assert.ok(took < REF_MS, `found stale in ${took} ms besides the navigation`)
  assert.equal(raced.split('\n')[0], notDone.stale(heading))
  assert.match(raced, /heading "Third page"/)
})

test('a read with ref, then a click on a ref outside that subtree works (refs re-armed)', async (t) => {
  if (skipped(t)) return
  const s = await setUp()
  const id = session(t, s, 'subtree')
  const opened = await ok(s, id, 'browser_navigate', { url: `${s.site.origin}/form.html` })
  const part = await ok(s, id, 'browser_read', { ref: refOf(opened, 'region', 'Notes') })
  assert.match(part, /Some notes/)
  assert.doesNotMatch(part, /Add item/)
  const clicked = await ok(s, id, 'browser_click', { ref: refOf(opened, 'button', 'Add item') })
  assert.match(clicked, /^Clicked button "Add item"/)
  assert.match(clicked, /item 1/)
})

test('a password field\'s value is never in a result', async (t) => {
  if (skipped(t)) return
  const s = await setUp()
  const id = session(t, s, 'password')
  const opened = await ok(s, id, 'browser_navigate', { url: `${s.site.origin}/form.html` })
  assert.match(opened, new RegExp(`textbox "Password" \\[ref=[^\\]]+\\] ${PASSWORD_HIDDEN.replace(/[()]/g, '\\$&')}`))
  const typed = await ok(s, id, 'browser_type', { ref: refOf(opened, 'textbox', 'Password'), text: 'typed-SECRET-2' })
  const read = await ok(s, id, 'browser_read')
  for (const text of [opened, typed, read]) {
    assert.equal(text.includes(PASSWORD), false)
    assert.equal(text.includes('typed-SECRET-2'), false)
  }
})

test('a popup followed; a confirm dismissed, then accepted with dialog "accept"; a download refused and noted', async (t) => {
  if (skipped(t)) return
  const s = await setUp()
  const id = session(t, s, 'events')
  const opened = await ok(s, id, 'browser_navigate', { url: `${s.site.origin}/events.html` })
  const confirm = refOf(opened, 'button', 'Confirm')

  const declined = await ok(s, id, 'browser_click', { ref: confirm })
  assert.match(declined, /The page showed a confirm: «sure\?» \(dismissed\)\./)
  assert.match(declined, /— "declined"/)
  const accepted = await ok(s, id, 'browser_click', { ref: confirm, dialog: 'accept' })
  assert.match(accepted, /The page showed a confirm: «sure\?» \(accepted\)\./)
  assert.match(accepted, /— "confirmed"/)

  const download = [await ok(s, id, 'browser_click', { ref: refOf(opened, 'link', 'Download') })]
  if (!download[0]!.includes('started a download')) download.push(...await readUntil(s, id, text => text.includes('started a download'), 'the download\'s note'))
  assert.ok(download.some(text => text.includes('The page started a download of report.txt; dish doesn\'t download files.')), download.join('\n---\n'))

  const popup = [await ok(s, id, 'browser_click', { ref: refOf(opened, 'link', 'Open popup') })]
  popup.push(...await readUntil(s, id, text => text.includes(`Page: ${s.site.origin}/popup-target.html`), 'the popup followed'))
  assert.ok(popup.some(text => text.includes('The page opened a new window; dish followed it here.')), popup.join('\n---\n'))
})

test('file:// in the workspace opens; file:///etc/hostname and a link out are refused; a workspace page\'s image and iframe outside it are aborted', async (t) => {
  if (skipped(t)) return
  const s = await setUp()
  const id = session(t, s, 'files')
  const opened = await ok(s, id, 'browser_navigate', { url: `${s.workspace}/index.html` })
  assert.match(opened, new RegExp(`^Opened file://${s.workspace}/index\\.html\\.`))
  assert.match(opened, /heading "In the workspace"/)
  // Chromium would load both (a file page may load files); the route aborts them.
  assert.doesNotMatch(opened, /TOP-SECRET-TEXT/)
  const failed = (await readUntil(s, id, text => text.includes('file:///etc/hostname'), 'the image\'s failed request')).at(-1)!
  assert.match(failed, /^Failed requests \(\d+\):$/m)
  assert.match(failed, /^- [^\n]*file:\/\/\/etc\/hostname$/m)

  for (const url of ['file:///etc/hostname', `file://${s.workspace}/out.html`]) {
    const refused = await call(s, id, 'browser_navigate', { url })
    assert.equal(refused.isError, true, url)
    assert.match(refused.text, /outside this chat's workspace/)
  }
  assert.match(await ok(s, id, 'browser_read'), new RegExp(`Page: file://${s.workspace}/index\\.html`), 'still where it was')
})

test('dsh\'s own port: refused as a URL; a page\'s image, fetch, WebSocket and link to it never reach it', async (t) => {
  if (skipped(t)) return
  const s = await setUp()
  const id = session(t, s, 'own')
  const url = `http://127.0.0.1:${s.dsh.port}/`
  const refused = await call(s, id, 'browser_navigate', { url })
  assert.equal(refused.isError, true)
  assert.equal(refused.text, `Error: ${urlRefusal.own(url)}`)

  const opened = await ok(s, id, 'browser_navigate', { url: `${s.site.origin}/own.html` })
  const clicked = [await ok(s, id, 'browser_click', { ref: refOf(opened, 'link', 'dsh itself') })]
  clicked.push(...await readUntil(s, id, text => text.includes('Page: about:blank'), 'the page sent to about:blank'))
  assert.ok(clicked.some(text => text.includes('The page went to an address dish doesn\'t allow (dsh\'s own address); it was sent to about:blank.')), clicked.join('\n---\n'))
  await sleep(500)
  assert.deepEqual(s.dsh.requests, [], 'no request reached dsh\'s port')
  assert.deepEqual(s.dsh.upgrades, [], 'no WebSocket reached dsh\'s port')
})

test('a screenshot: the store got a PNG at the viewport\'s size, and the result has two blocks', async (t) => {
  if (skipped(t)) return
  const s = await setUp()
  const id = session(t, s, 'screenshot')
  await ok(s, id, 'browser_navigate', { url: `${s.site.origin}/form.html` })
  const before = s.saved.length
  const shot = await call(s, id, 'browser_screenshot')
  assert.equal(shot.isError, false, shot.text)
  assert.deepEqual(shot.content.map(block => block.type), ['text', 'image'])
  assert.match(shot.text, new RegExp(`^Screenshot of ${s.site.origin}/form\\.html — "Form", 800×600 px\\.`))
  assert.deepEqual(shot.meta, { url: `${s.site.origin}/form.html`, title: 'Form' })
  assert.equal(s.saved.length, before + 1)
  const saved = s.saved.at(-1)!
  assert.equal(saved.mediaType, 'image/png')
  assert.equal(saved.name, 'screenshot.png')
  assert.deepEqual(pngSize(saved.data), VIEWPORT)
})

/** An uplink the test feeds, as the tab does. */
class Channel implements AsyncIterable<unknown> {
  private readonly items: unknown[] = []
  private wake: (() => void) | undefined
  private returned = false

  push(...items: unknown[]): void {
    this.items.push(...items)
    this.signal()
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return {
      next: async () => {
        for (;;) {
          if (this.returned) return { value: undefined, done: true }
          if (this.items.length > 0) return { value: this.items.shift(), done: false }
          await new Promise<void>(resolve => { this.wake = resolve })
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

test('the stream: frames on, one in flight, paced at most 15 a second by acks; a click from the uplink clicks the button', async (t) => {
  if (skipped(t)) return
  const s = await setUp()
  const id = session(t, s, 'watch')
  await ok(s, id, 'browser_navigate', { url: `${s.site.origin}/screencast.html` })
  const options: RemoteOptions = { core: s.core, services: contextServices(s.ctx), clock: systemClock, limits: LIMITS, viewport: VIEWPORT, log: { warn() {} } }
  const uplink = new Channel()
  const controller = new AbortController()
  t.after(() => { controller.abort() })
  const items: Down[] = []
  const frames: Array<{ frame: FrameDown, at: number }> = []
  const reading = (async () => {
    for await (const item of watchStream(options, id, uplink, controller.signal)) {
      items.push(item)
      if (item.kind === 'frame') frames.push({ frame: item, at: Date.now() })
    }
  })()
  await eventually('the opening', () => items.length >= 3)
  assert.deepEqual(items.map(item => item.kind), ['hello', 'state', 'children'])

  uplink.push({ kind: 'frames', on: true })
  await eventually('the first frame', () => frames.length === 1)
  const first = frames[0]!.frame
  assertJpeg(first.data)
  assert.deepEqual({ width: first.width, height: first.height }, VIEWPORT)
  // The page changes every 30 ms, but without an ack no second frame comes.
  await sleep(500)
  assert.equal(frames.length, 1, 'one frame in flight')
  for (let n = 2; n <= 9; n++) {
    uplink.push({ kind: 'ack', seq: frames.at(-1)!.frame.seq })
    await eventually(`frame ${n}`, () => frames.length === n)
  }
  const seqs = frames.map(entry => entry.frame.seq)
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), 'seq rises')
  assert.equal(new Set(seqs).size, seqs.length)
  // Frames 2 to 9 went out at most 15 a second: seven gaps of at least 1000 / 15 ms (less a little for timing).
  const span = frames.at(-1)!.at - frames[1]!.at
  assert.ok(span >= 7 * (1000 / 15) - 50, `7 frames in ${span} ms`)

  // The user's click, from the uplink, on the button fixed at x 20–220, y 20–70.
  const at = { x: 120, y: 45, button: 'left', clickCount: 1 }
  uplink.push({ kind: 'mouse', action: 'move', ...at, clickCount: 0 }, { kind: 'mouse', action: 'down', ...at }, { kind: 'mouse', action: 'up', ...at })
  const page = s.core.browserOf(id)!.page
  await eventually('the button pressed', async () => /button "Pressed 1"/.test(await page.snapshot(SNAP)))
  const read = await ok(s, id, 'browser_read')
  assert.match(read, /button "Pressed 1"/)
  assert.match(read, /The user used this browser since your last call: clicked once\./)

  controller.abort()
  await reading
})

test('a page crash (chrome://crash, on the core\'s page): a new page, and the next call says so', async (t) => {
  if (skipped(t)) return
  const s = await setUp()
  const id = session(t, s, 'crash')
  await ok(s, id, 'browser_navigate', { url: `${s.site.origin}/form.html` })
  const browser = s.core.browserOf(id)!
  const old = browser.page
  await old.goto('chrome://crash', { timeoutMs: 10_000, loadMs: 1_000 }).catch(() => {})
  await eventually('the page replaced', () => browser.page !== old)
  const next = await ok(s, id, 'browser_read')
  assert.match(next, /The page crashed; this is a new page\./)
  assert.match(await ok(s, id, 'browser_navigate', { url: `${s.site.origin}/second.html` }), /heading "Second page"/)
  assert.equal(s.core.browserOf(id), browser, 'the same browser, its context kept')
})

test('a frozen page: a call fails with the replacement\'s words, the tab is told, and a navigate then works, its cookie kept', async (t) => {
  if (skipped(t)) return
  const s = await setUp()
  const id = session(t, s, 'frozen')
  const told: unknown[] = []
  t.after(s.core.subscribe(event => { if (event.kind === 'notice' && event.sessionId === id) told.push(event.notice) }))
  await ok(s, id, 'browser_navigate', { url: `${s.site.origin}/frozen.html` })
  await sleep(800)
  const browser = s.core.browserOf(id)!
  const old = browser.page
  const started = Date.now()
  const read = await call(s, id, 'browser_read')
  t.diagnostic(`a read of the frozen page ended in ${Date.now() - started} ms`)
  assert.equal(read.isError, true)
  assert.equal(read.text, `Error: ${errorText('frozen', '', LIMITS)}`)
  assert.notEqual(browser.page, old)
  assert.equal(s.core.browserOf(id), browser, 'the same browser')
  assert.deepEqual(told, [{ kind: 'frozen' }])
  const next = await ok(s, id, 'browser_navigate', { url: `${s.site.origin}/cookie.html` })
  assert.match(next, /cookie kept=yes/, 'the same context: its cookie stays')

  // A click by ref: its `hasRef` times out on the frozen page, and the same happens.
  const frozen = await ok(s, id, 'browser_navigate', { url: `${s.site.origin}/frozen.html` })
  await sleep(800)
  const clickStarted = Date.now()
  const paragraph = /- paragraph \[ref=((?:f\d+)?e\d+)\]: Soon stuck/.exec(frozen)?.[1]
  assert.ok(paragraph !== undefined, frozen)
  const clicked = await call(s, id, 'browser_click', { ref: paragraph })
  t.diagnostic(`a click on the frozen page ended in ${Date.now() - clickStarted} ms`)
  assert.equal(clicked.isError, true)
  assert.equal(clicked.text, `Error: ${errorText('frozen', '', LIMITS)}`)
  assert.deepEqual(told, [{ kind: 'frozen' }, { kind: 'frozen' }])
  assert.match(await ok(s, id, 'browser_navigate', { url: `${s.site.origin}/cookie.html` }), /cookie kept=yes/)
})

test('a frozen page: browser_navigate replaces it at once and goes where it was asked, with the note', async (t) => {
  if (skipped(t)) return
  const s = await setUp()
  const id = session(t, s, 'frozen-navigate')
  await ok(s, id, 'browser_navigate', { url: `${s.site.origin}/frozen.html` })
  await sleep(800)
  const started = Date.now()
  const opened = await ok(s, id, 'browser_navigate', { url: `${s.site.origin}/cookie.html` })
  t.diagnostic(`the navigation ended in ${Date.now() - started} ms`)
  assert.ok(Date.now() - started < 10_000, `${Date.now() - started} ms`)
  assert.ok(opened.startsWith(`Opened ${s.site.origin}/cookie.html.\nNotes: ${noteText({ kind: 'frozen' }, LIMITS)}\n`), opened.slice(0, 300))
  assert.match(opened, /cookie kept=yes/)
})

test('a long page, cut: the sections past the cut are named; a change past it is no "Unchanged"; its elements have their words', async (t) => {
  if (skipped(t)) return
  const s = await setUp()
  const id = session(t, s, 'long')
  const opened = await ok(s, id, 'browser_navigate', { url: `${s.site.origin}/long.html` })
  const sections = /\nCut at 30,000 of [\d,]+ characters: `browser_read` with a section's ref reads that part\. Sections past the cut: (.*)\.$/.exec(opened)
  assert.ok(sections, opened.slice(-400))
  const bottom = /region "Bottom" \[ref=((?:f\d+)?e\d+)\]/.exec(sections[1]!)?.[1]
  assert.ok(bottom !== undefined, sections[1])
  assert.ok(opened.length < 33_000, `${opened.length} characters`)
  const part = await ok(s, id, 'browser_read', { ref: bottom })
  const button = refOf(part, 'button', 'Add at bottom')
  for (const n of [0, 1]) {
    const clicked = await ok(s, id, 'browser_click', { ref: button })
    assert.ok(clicked.startsWith(`Clicked button "Add at bottom" [ref=${button}].\n`), clicked.slice(0, 200))
    assert.doesNotMatch(clicked, /Unchanged since your last snapshot/, `click ${n + 1}: the change is past the cut`)
  }
  assert.match(await ok(s, id, 'browser_read', { ref: bottom }), /ADDED-0[\s\S]*ADDED-1/)
  assert.match(await ok(s, id, 'browser_click', { ref: refOf(opened, 'link', 'Link number 0') }), /^Clicked link "Link number 0"/)
})

test('a page\'s 150 alerts: the result lists the newest 10, after a count of the rest, and stays under dsh\'s spill cap', async (t) => {
  if (skipped(t)) return
  const s = await setUp()
  const id = session(t, s, 'spam')
  const opened = await ok(s, id, 'browser_navigate', { url: `${s.site.origin}/spam.html` })
  const clicked = await ok(s, id, 'browser_click', { ref: refOf(opened, 'button', 'Spam') })
  const notes = clicked.split('\n').find(line => line.startsWith('Notes:')) ?? ''
  assert.ok(notes.startsWith('Notes: 140 earlier page events (dialogs, popups, downloads) aren\'t listed; the newest 10 follow. The page showed an alert: «message 140 '), notes.slice(0, 300))
  assert.equal((notes.match(/The page showed an alert/g) ?? []).length, 10)
  assert.match(notes, /«message 149 x+…» \(dismissed\)\.$/)
  assert.ok(Math.ceil(clicked.length / 4) + 4 < 12_500, `${clicked.length} characters`)
})

test('every name in KEY_NAMES replays through keyDown and keyUp without an error, directly and on the tab\'s input chain', async (t) => {
  if (skipped(t)) return
  const s = await setUp()
  const id = session(t, s, 'keys')
  await ok(s, id, 'browser_navigate', { url: `${s.site.origin}/input.html` })
  const browser = s.core.browserOf(id)!
  const failed: string[] = []
  for (const key of KEY_NAMES) {
    try {
      await browser.page.keyDown(key)
      await browser.page.keyUp(key)
    } catch (error) {
      failed.push(`${key}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  assert.deepEqual(failed, [])
  for (const key of KEY_NAMES) {
    void s.core.user(id, { kind: 'key', action: 'down', key, code: key, modifiers: 0 }, undefined)
    void s.core.user(id, { kind: 'key', action: 'up', key, code: key, modifiers: 0 }, undefined)
  }
  await browser.inputsDone()
  assert.equal(s.core.browserOf(id), browser, 'still open')
  assert.deepEqual(s.logs.filter(line => line.includes('input from the Browser tab failed')), [])
})

test('Chromium killed: every browser goes, and the next call relaunches it, with the note', async (t) => {
  if (skipped(t)) return
  const s = await setUp()
  const id = session(t, s, 'killed')
  await ok(s, id, 'browser_navigate', { url: `${s.site.origin}/form.html` })
  const launched = s.launches()
  const pids = processesHolding(tmp)
  assert.ok(pids.length > 0, 'Chromium holds the scratch TMPDIR')
  for (const pid of pids) {
    try { process.kill(pid, 'SIGKILL') } catch { /* gone already */ }
  }
  await eventually('the browser gone with Chromium', () => !s.core.isOpen(id), 15_000)
  assert.equal(s.core.view(id).reason, 'chromium')
  const next = await ok(s, id, 'browser_navigate', { url: `${s.site.origin}/second.html` })
  assert.equal(s.launches(), launched + 1, 'relaunched')
  assert.match(next, /The browser restarted; this page is new, and cookies and sign-ins are gone\./)
  assert.match(next, /heading "Second page"/)
})

test('no result held the password field\'s value; no log line held a URL', async (t) => {
  if (skipped(t)) return
  const s = await setUp()
  assert.ok(results.length > 0)
  for (const text of results) assert.equal(text.includes(PASSWORD), false)
  const ours = s.logs.filter(line => line.startsWith('[dish-browser]'))
  assert.ok(ours.some(line => line.includes('launched Chromium')), ours.join('\n'))
  for (const line of ours) assert.doesNotMatch(line, /https?:|file:|127\.0\.0\.1/, line)
})

test('the plugin disposed: every browser closed, and no process holds the scratch TMPDIR', async (t) => {
  if (skipped(t)) return
  const s = await setUp()
  const id = session(t, s, 'last')
  await ok(s, id, 'browser_navigate', { url: `${s.site.origin}/form.html` })
  assert.ok(processesHolding(tmp).length > 0)
  await s.dispose()
  assert.equal(s.core.isOpen(id), false)
  assert.equal(s.core.view(id).reason, 'stopped')
  await eventually('no process holds the scratch TMPDIR', () => processesHolding(tmp).length === 0, 15_000)
})
