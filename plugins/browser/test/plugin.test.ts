/**
 * The plugin's wiring (`index.ts`), in a cordis `Context`: dsh's and crew's services as stub plugins (`provideStub`, as
 * orchestrator's tests do), dsh's `ToolRuntime` where tools are concerned, dsh's real gateway where a watch needs an uplink,
 * the fake driver, and a manual clock.
 *
 * - the config's defaults and bounds;
 * - with Chromium, the ten tools, gone with the plugin; without, none, a log line, and the tab's `unavailable`;
 * - the listeners: `agent/disposed` (held by a frames-on watch), `workspace/session-stop`, `agent/created` and the disposal
 *   reaching a watch's `canStart`; never an answer to `workspace/session-activity`;
 * - the sweep: archived and idle;
 * - the stop: every browser, Chromium once, the open watches, every timer;
 * - one call end to end through `ToolRuntime`; the shared viewport and dsh's own address;
 * - the logs: the terminal, and a logger that throws;
 * - the sources: `playwright-core` only in `src/playwright.ts`; the client imports nothing of the host's but the wire.
 */

import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { format } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import { TypertGatewayService } from '@deepseek-ai/dsh-api-gateway'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import type { Browsers } from '../src/browsers.ts'
import * as plugin from '../src/index.ts'
import type { BrowserInternals, Config } from '../src/index.ts'
import { NAMESPACE } from '../src/protocol.ts'
import type { Down, StateDown } from '../src/protocol.ts'
import type { BrowserRemote } from '../src/remote.ts'
import { SERVICE } from '../src/remote.ts'
import type { AgentHandle } from '../src/services.ts'
import { TOOL_NAMES } from '../src/tools.ts'
import { SWEEP_MS } from '../src/types.ts'
import { errorText, urlRefusal } from '../src/words.ts'
import { FakeDriver, FakePage, ManualClock, flush } from './fake-driver.ts'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')
const never = new AbortController().signal
const PORT = 4319
const TRUSTED = 'dish.example.test'
const DEFAULTS: Config = {
  executablePath: '/usr/bin/chromium',
  viewport: { width: 1280, height: 800 },
  maxBrowsers: 6,
  idleMinutes: 15,
  snapshotChars: 30_000,
  terminal: true,
}
/** A page as Playwright's `ai` snapshot gives it. */
const TREE = ['- heading "Items" [level=1] [ref=e1]', '- button "Save" [ref=e2] [cursor=pointer]'].join('\n')

/** A cordis fiber, as `ctx.plugin` gives it: awaited for its start, disposed for its end. */
type Handle = PromiseLike<unknown> & { dispose(): Promise<unknown> }

/** A sibling's service, provided by a plugin of its own (as orchestrator's tests do), so it comes and goes like one. */
function provideStub(ctx: Context, name: string, value: unknown): Handle {
  return ctx.plugin({
    name: `stub-${name}`,
    apply(own: Context) { (own as unknown as { provide(name: string, value: unknown): void }).provide(name, value) },
  } as never, undefined as never) as unknown as Handle
}

/** Every line any plugin logs in `ctx`, as `[name] type: text`. */
function watchLogs(ctx: Context): string[] {
  const seen: string[] = []
  ctx.logger.exporter({
    levels: { default: 3 },
    export: ({ name, type, args }) => { seen.push(`[${name}] ${type}: ${format(...args)}`) },
  })
  return seen
}

interface ToolsService {
  register(tool: ToolDefinition): () => void
  view(): { visible: Map<string, ToolDefinition> }
  execute(call: { callId: string, name: string, arguments: unknown, agent: unknown, signal: AbortSignal }): Promise<{ isError: boolean, content: Array<{ type: string, text?: string }> }>
}

interface WorldOptions {
  /** Whether `executable` says there is Chromium. Default: true. */
  chromium?: boolean
  config?: Partial<Config>
  /** Mount dsh's `ToolRuntime` (with a `systemPrompt` stub) before the plugin. */
  tools?: boolean
  /** Mount dsh's Typert registry and gateway before the plugin. */
  gateway?: boolean
  env?: NodeJS.ProcessEnv
  /** A log exporter that throws, as a broken terminal would. */
  throwingLogger?: boolean
}

interface World {
  ctx: Context
  driver: FakeDriver
  clock: ManualClock
  core: Browsers
  /** The live agents, as `ctx.agents.get` gives them. */
  agents: Map<string, AgentHandle>
  /** `workspaceRegistry.archivedSessionIds`. */
  archived: string[]
  /** Whether reading `archivedSessionIds` throws, as dsh's registry does before its state is loaded. */
  registryThrows: boolean
  /** Every line any plugin logged. */
  logs: string[]
  /** The paths `executable` was asked about. */
  checked: string[]
  plugin: Handle
  /** dsh's tools, with `tools: true`. */
  tools: ToolsService | undefined
  dispose(): Promise<void>
}

const worlds: World[] = []
after(async () => { for (const w of worlds) await w.dispose() })

async function world(options: WorldOptions = {}): Promise<World> {
  const ctx = new Context()
  const logs = watchLogs(ctx)
  if (options.throwingLogger === true) {
    ctx.logger.exporter({ levels: { default: 3 }, export: () => { throw new Error('the terminal is gone') } })
  }
  const handles: Handle[] = []
  const undo: Array<() => void> = []
  const mount = async (handle: Handle): Promise<void> => {
    handles.push(handle)
    await handle
  }
  if (options.gateway === true) {
    await mount(ctx.plugin(TypertRegistry) as unknown as Handle)
    undo.push(ctx.typert.lookups.register('session', {
      parameter: 'session',
      wire: 'sessionId',
      hostTypeSymbol: '@deepseek-ai/dsh-session#Session',
      wireTypeSymbol: '@deepseek-ai/dsh-session/types#SessionId',
      resolve: () => undefined,
    }))
    await mount(ctx.plugin(TypertGatewayService, {}) as unknown as Handle)
  }
  if (options.tools === true) {
    const { ToolRuntime } = await import('@deepseek-ai/dsh-tools')
    await mount(provideStub(ctx, 'systemPrompt', { tools() {}, section() {}, getSectionOrder: () => 1 }))
    await mount(ctx.plugin(ToolRuntime, {}) as unknown as Handle)
  }
  const agents = new Map<string, AgentHandle>()
  const archived: string[] = []
  const registry = { throws: false }
  await mount(provideStub(ctx, 'agents', { get: (id: string) => agents.get(id) }))
  await mount(provideStub(ctx, 'workspaceRegistry', {
    get archivedSessionIds() {
      if (registry.throws) throw new Error('the registry isn\'t ready')
      return archived
    },
  }))
  await mount(provideStub(ctx, 'webServer', { port: PORT }))
  const driver = new FakeDriver()
  driver.onPage = page => {
    page.tree = TREE
    for (const ref of ['e1', 'e2']) page.refs.add(ref)
  }
  const clock = new ManualClock()
  const checked: string[] = []
  const internals: BrowserInternals = {
    driver,
    clock,
    executable: path => {
      checked.push(path)
      return options.chromium ?? true
    },
    sharedTmp: false,
    env: options.env ?? {},
  }
  let core: Browsers | undefined
  const mounted = ctx.plugin({
    name: plugin.name,
    Config: plugin.Config,
    apply: (own: Context, config: Config) => { core = plugin.start(own, config, internals) },
  } as never, { terminal: false, ...options.config } as never) as unknown as Handle
  await mount(mounted)
  assert.ok(core !== undefined, 'the plugin started')
  let disposed = false
  const w: World = {
    ctx, driver, clock, core, agents, archived, logs, checked,
    get registryThrows() { return registry.throws },
    set registryThrows(value: boolean) { registry.throws = value },
    plugin: mounted,
    tools: options.tools === true ? ctx.get('tools') as unknown as ToolsService : undefined,
    dispose: async () => {
      if (disposed) return
      disposed = true
      for (const handle of handles.reverse()) await handle.dispose()
      for (const done of undo) done()
    },
  }
  worlds.push(w)
  return w
}

/** The tools `ToolRuntime` shows, but its own transport. */
function registered(tools: ToolsService): string[] {
  return [...tools.view().visible.keys()].filter(name => name !== 'run_code').sort()
}

/** Let promise callbacks run, and move the manual clock on 10 ms a round, until `predicate` holds. */
async function eventually(w: World, predicate: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (predicate()) return
    await flush()
    w.clock.advance(10)
  }
  assert.fail(`never: ${what}`)
}

/** Real time, for what the gateway does in its own: at most 5 s. */
async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`)
    await new Promise<void>(resolve => setImmediate(resolve))
  }
}

/** One watch of the remote, called in process (no uplink), read as fast as it yields. */
class Reader {
  readonly items: Down[] = []
  readonly controller = new AbortController()
  done = false
  error: unknown

  constructor(ctx: Context, sessionId: string) {
    const remote = ctx.get(SERVICE) as unknown as BrowserRemote
    void this.run(remote.watch(sessionId, this.controller.signal))
  }

  private async run(stream: AsyncIterable<Down>): Promise<void> {
    try {
      for await (const item of stream) this.items.push(item)
    } catch (error) {
      this.error = error
    } finally {
      this.done = true
    }
  }

  get states(): StateDown[] {
    return this.items.filter((item): item is StateDown => item.kind === 'state')
  }

  get state(): StateDown {
    const state = this.states.at(-1)
    assert.ok(state !== undefined, 'no state yet')
    return state
  }

  async opened(): Promise<void> {
    await waitFor(() => this.items.length >= 3, 'hello, the state and the children')
  }
}

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

/** A watch through dsh's real gateway, with an uplink: what the tab opens. */
async function gatewayWatch(w: World, sessionId: string): Promise<{ uplink: Channel, items: Down[], controller: AbortController, ended: () => boolean }> {
  const uplink = new Channel()
  const controller = new AbortController()
  const items: Down[] = []
  let ended = false
  const stream = await w.ctx.typertGateway.stream({ namespace: NAMESPACE, method: 'watch', args: { sessionId }, uplink, signal: controller.signal })
  void (async () => {
    try {
      for await (const item of stream as AsyncIterable<Down>) items.push(item)
    } catch {
      // The abort ends it with `gateway/cancelled`.
    } finally {
      ended = true
    }
  })()
  await waitFor(() => items.length >= 3, 'the watch\'s opening')
  return { uplink, items, controller, ended: () => ended }
}

function agent(id: string): AgentHandle {
  return { id, session: { header: { id } }, options: {} }
}

// --- the config ---------------------------------------------------------------------------------------------------------

test('the config: the defaults and bounds of the contracts', () => {
  const parse = (given: object): Config => plugin.Config(given as Config)
  assert.equal(plugin.name, 'dish-browser')
  assert.deepEqual(parse({}), DEFAULTS)
  const edges = { executablePath: '/opt/chromium/chrome', viewport: { width: 320, height: 240 }, maxBrowsers: 1, idleMinutes: 1, snapshotChars: 2000, terminal: false }
  assert.deepEqual(parse(edges), edges)
  const top = { ...edges, viewport: { width: 3840, height: 2160 }, maxBrowsers: 20, idleMinutes: 24 * 60, snapshotChars: 48_000 }
  assert.deepEqual(parse(top), top)
  assert.deepEqual(parse({ viewport: { width: 1024 } }).viewport, { width: 1024, height: 800 })
  for (const wrong of [
    { viewport: { width: 319 } }, { viewport: { width: 3841 } }, { viewport: { height: 239 } }, { viewport: { height: 2161 } },
    { viewport: { width: 1280.5 } }, { maxBrowsers: 0 }, { maxBrowsers: 21 }, { maxBrowsers: 1.5 }, { idleMinutes: 0 },
    { snapshotChars: 1999 }, { snapshotChars: 48_001 },
  ]) {
    assert.throws(() => parse(wrong), Error, JSON.stringify(wrong))
  }
})

test('executablePath: the configured path is the one checked and launched; \'\' is the default', async () => {
  const custom = await world({ config: { executablePath: '/opt/chromium/chrome' } })
  assert.deepEqual(custom.checked, ['/opt/chromium/chrome'])
  await custom.core.forAgent('s1', undefined, never)
  assert.deepEqual(custom.driver.launches, [{ executablePath: '/opt/chromium/chrome', sandbox: true }])
  const empty = await world({ config: { executablePath: '' } })
  assert.deepEqual(empty.checked, ['/usr/bin/chromium'])
  await empty.core.forAgent('s1', undefined, never)
  assert.deepEqual(empty.driver.launches, [{ executablePath: '/usr/bin/chromium', sandbox: true }])
})

// --- the tools ----------------------------------------------------------------------------------------------------------

test('with Chromium: exactly the ten tools are registered, and they go when the plugin goes', async () => {
  const w = await world({ tools: true })
  assert.deepEqual(registered(w.tools!), [...TOOL_NAMES].sort())
  assert.equal(TOOL_NAMES.length, 10)
  await w.plugin.dispose()
  assert.deepEqual(registered(w.tools!), [])
})

test('a registration that throws is logged, and the rest still register', async () => {
  const ctx = new Context()
  const logs = watchLogs(ctx)
  const taken: string[] = []
  const handle = provideStub(ctx, 'tools', {
    register(tool: ToolDefinition) {
      if (tool.name === 'browser_back') throw new Error('a duplicate')
      taken.push(tool.name)
      return () => {}
    },
  })
  await handle
  const mounted = ctx.plugin({
    name: plugin.name,
    Config: plugin.Config,
    apply: (own: Context, config: Config) => { plugin.start(own, config, { driver: new FakeDriver(), clock: new ManualClock(), executable: () => true, sharedTmp: false, env: {} }) },
  } as never, { terminal: false } as never) as unknown as Handle
  await mounted
  try {
    assert.deepEqual(taken, TOOL_NAMES.filter(name => name !== 'browser_back'))
    assert.deepEqual(logs.filter(line => line.startsWith('[dish-browser]')), ['[dish-browser] warn: could not register browser_back: a duplicate'])
  } finally {
    await mounted.dispose()
    await handle.dispose()
  }
})

test('without Chromium: no tools, one log line, and the watch says unavailable with the path; the remote is mounted', async () => {
  const w = await world({ tools: true, chromium: false, config: { executablePath: '/nowhere/chromium' } })
  assert.deepEqual(registered(w.tools!), [])
  assert.deepEqual(w.checked, ['/nowhere/chromium'])
  assert.deepEqual(w.logs.filter(line => line.startsWith('[dish-browser]')), [
    '[dish-browser] warn: no Chromium at /nowhere/chromium: the browser tools aren\'t registered, and the Browser tab says so',
  ])
  assert.equal(w.core.unavailable, '/nowhere/chromium')
  const r = new Reader(w.ctx, 's1')
  await r.opened()
  assert.equal(r.state.status, 'unavailable')
  assert.equal(r.state.reason, errorText('unavailable', '/nowhere/chromium', { maxBrowsers: 6, idleMinutes: 15 }))
  assert.equal(r.state.canStart, false)
  r.controller.abort()
  await waitFor(() => r.done, 'the watch to end')
  assert.equal(w.driver.launches.length, 0)
})

test('one call end to end through ToolRuntime: navigate, then click by ref, on the fake driver', async () => {
  const w = await world({ tools: true })
  const tools = w.tools!
  const caller = agent('s1')
  let n = 0
  const execute = (name: string, args: unknown) => tools.execute({ callId: `c-${++n}`, name, arguments: args, agent: caller, signal: new AbortController().signal })
  const text = (result: { content: Array<{ text?: string }> }) => result.content.map(block => block.text ?? '').join('')
  const opened = await execute('browser_navigate', { url: 'localhost:5173/items' })
  assert.equal(opened.isError, false, text(opened))
  assert.match(text(opened), /^Opened http:\/\/localhost:5173\/items\.\nPage: http:\/\/localhost:5173\/items\n/)
  assert.match(text(opened), /- button "Save" \[ref=e2\]/)
  const page = w.driver.pages[0]!
  assert.deepEqual(page.callsOf('goto').map(args => args[0]), ['http://localhost:5173/items'])
  const clicked = await execute('browser_click', { ref: 'e2' })
  assert.equal(clicked.isError, false, text(clicked))
  assert.match(text(clicked), /^Clicked button "Save" \[ref=e2\]\./)
  assert.deepEqual(page.callsOf('click').map(args => args[0]), [{ ref: 'e2' }])
  assert.equal(w.driver.launches.length, 1)
  assert.equal(w.core.isOpen('s1'), true)
})

test('one viewport and dsh\'s own address: the core, the tools and the stream share them', async () => {
  const viewport = { width: 1024, height: 768 }
  const w = await world({ tools: true, gateway: true, config: { viewport }, env: { DISH_TRUSTED_HOST: TRUSTED } })
  const tools = w.tools!
  const caller = agent('s1')
  let n = 0
  const execute = (name: string, args: unknown) => tools.execute({ callId: `c-${++n}`, name, arguments: args, agent: caller, signal: new AbortController().signal })
  const text = (result: { content: Array<{ text?: string }> }) => result.content.map(block => block.text ?? '').join('')

  // dsh's own address, refused by the tools before a browser starts: the web server's port, and the trusted host.
  for (const url of [`http://localhost:${PORT}/`, `https://${TRUSTED}/settings`]) {
    const refused = await execute('browser_navigate', { url })
    assert.equal(refused.isError, true, url)
    assert.equal(text(refused), `Error: ${urlRefusal.own(url)}`)
  }
  assert.equal(w.driver.launches.length, 0)
  // A point the tools check against the config's viewport.
  const outside = await execute('browser_click', { x: 1100, y: 10 })
  assert.equal(outside.isError, true)
  assert.match(text(outside), /1024×768/)

  await w.core.forAgent('s1', undefined, never)
  const context = w.driver.browser.contexts[0]!
  assert.deepEqual(context.viewport, viewport)
  // The core's route and WebSockets know the same address.
  assert.equal(await context.request(`http://127.0.0.1:${PORT}/api`), 'abort')
  assert.equal(await context.request(`https://${TRUSTED}/x`), 'abort')
  assert.equal(context.refuseWebSocket(`wss://${TRUSTED}/ws`), true)
  assert.equal(context.refuseWebSocket(`ws://localhost:${PORT}/ws`), true)
  assert.equal(context.refuseWebSocket('ws://localhost:5173/ws'), false)

  // The stream's state, and the uplink's clamp, at the same viewport.
  const watch = await gatewayWatch(w, 's1')
  assert.deepEqual((watch.items[1] as StateDown).viewport, viewport)
  watch.uplink.push({ kind: 'mouse', action: 'down', x: 5000, y: -3, button: 'left', clickCount: 1 })
  const page = w.driver.pages[0]!
  await eventually(w, () => page.callsOf('mouse').length === 1, 'the click on the page')
  assert.deepEqual(page.callsOf('mouse'), [['down', 1023, 0, 'left', 1]])
  watch.controller.abort()
  await waitFor(watch.ended, 'the watch to end')
})

// --- the listeners ------------------------------------------------------------------------------------------------------

test('agent/disposed closes a browser; with a frames-on watch, not until the watch ends', async () => {
  const w = await world({ gateway: true })
  w.agents.set('s1', agent('s1'))
  await w.core.forAgent('s1', undefined, never)
  w.agents.delete('s1')
  w.ctx.emit('agent/disposed', { agent: { id: 's1' } } as never)
  assert.equal(w.core.isOpen('s1'), false)
  assert.equal(w.core.view('s1').reason, 'agent')
  assert.equal(w.driver.browser.contexts[0]!.closed, true)

  w.agents.set('s2', agent('s2'))
  await w.core.forAgent('s2', undefined, never)
  const watch = await gatewayWatch(w, 's2')
  watch.uplink.push({ kind: 'frames', on: true })
  await eventually(w, () => watch.items.some(item => item.kind === 'frame'), 'a frame')
  w.agents.delete('s2')
  w.ctx.emit('agent/disposed', { agent: { id: 's2' } } as never)
  assert.equal(w.core.isOpen('s2'), true, 'held while watched')
  watch.controller.abort()
  await waitFor(() => !w.core.isOpen('s2'), 'the browser to close when the watch ends')
  assert.equal(w.core.view('s2').reason, 'agent')
})

test('agent/created makes canStart true for a watch; agent/disposed makes it false again', async () => {
  const w = await world()
  const r = new Reader(w.ctx, 's1')
  await r.opened()
  assert.equal(r.state.status, 'none')
  assert.equal(r.state.canStart, false)
  // The agent comes: only agent/created tells the watch.
  w.agents.set('s1', agent('s1'))
  await w.clock.tick(500)
  assert.equal(r.states.length, 1, 'no state without the event')
  await w.ctx.serial('agent/created', { agent: { id: 's1' }, source: 'creation' } as never)
  await eventually(w, () => r.state.canStart, 'canStart true')
  // It goes: dsh removes it from the registry, then emits agent/disposed.
  w.agents.delete('s1')
  w.ctx.emit('agent/disposed', { agent: { id: 's1' } } as never)
  await eventually(w, () => !r.state.canStart, 'canStart false')
  assert.equal(r.state.status, 'none')
  r.controller.abort()
  await waitFor(() => r.done, 'the watch to end')
})

test('agent/created keeps a re-created agent\'s browser: an open one stays open, and a held one is the agent\'s again', async () => {
  const w = await world({ gateway: true })
  // Open and unwatched: the agent created again (a resume, a clear) finds its browser as it was.
  w.agents.set('s1', agent('s1'))
  await w.core.forAgent('s1', undefined, never)
  await w.ctx.serial('agent/created', { agent: { id: 's1' }, source: 'resume' } as never)
  assert.equal(w.core.isOpen('s1'), true, 'an open browser stays open')

  // Held: disposed while a frames-on watch watches it, then created again before the watch ends. The live agent owns it
  // again, so the watch leaving doesn't close it.
  w.agents.set('s2', agent('s2'))
  await w.core.forAgent('s2', undefined, never)
  const page = w.core.browserOf('s2')!.page as FakePage
  const watch = await gatewayWatch(w, 's2')
  watch.uplink.push({ kind: 'frames', on: true })
  await eventually(w, () => watch.items.some(item => item.kind === 'frame'), 'a frame')
  w.agents.delete('s2')
  w.ctx.emit('agent/disposed', { agent: { id: 's2' } } as never)
  assert.equal(w.core.isOpen('s2'), true, 'held while watched')
  w.agents.set('s2', agent('s2'))
  await w.ctx.serial('agent/created', { agent: { id: 's2' }, source: 'resume' } as never)
  watch.controller.abort()
  await waitFor(watch.ended, 'the watch to end')
  await eventually(w, () => !page.screencasting, 'the watch to let go of the browser')
  await flush()
  assert.equal(w.core.isOpen('s2'), true, 'the re-created agent\'s browser stays open')
})

test('a listener catches its own errors: a payload without an agent throws nothing into dsh', async () => {
  const w = await world()
  await w.ctx.serial('agent/created', {} as never)
  w.ctx.emit('agent/disposed', {} as never)
  w.ctx.emit('agent/disposed', null as never)
  await w.ctx.parallel('workspace/session-stop', {} as never)
  await w.core.forAgent('s1', undefined, never)
  assert.equal(w.core.isOpen('s1'), true)
})

test('workspace/session-stop closes the session\'s browser; workspace/session-activity is never answered', async () => {
  const w = await world()
  await w.core.forAgent('s1', undefined, never)
  await w.core.forAgent('s2', undefined, never)
  const activity = await (w.ctx as unknown as { waterfall(name: string, request: unknown, next: () => Promise<unknown>): Promise<unknown> })
    .waterfall('workspace/session-activity', { sessionId: 's2' }, () => Promise.resolve([]))
  assert.deepEqual(activity, [], 'an open browser isn\'t work to wait for')
  await w.ctx.parallel('workspace/session-stop', { sessionId: 's1' } as never)
  assert.equal(w.core.isOpen('s1'), false)
  assert.equal(w.core.view('s1').reason, 'archived')
  assert.equal(w.core.isOpen('s2'), true)
})

// --- the sweep ----------------------------------------------------------------------------------------------------------

test('the sweep, every minute: an archived session\'s browser, then an idle one', async () => {
  const w = await world()
  await w.core.forAgent('s1', undefined, never)
  await w.core.forAgent('s2', undefined, never)
  w.archived.push('s2')
  w.clock.advance(SWEEP_MS - 1)
  await flush()
  assert.equal(w.core.isOpen('s2'), true, 'not before a minute')
  w.clock.advance(1)
  await flush()
  assert.equal(w.core.isOpen('s2'), false)
  assert.equal(w.core.view('s2').reason, 'archived')
  assert.equal(w.core.isOpen('s1'), true)
  // s1 was last used at the start: idle after 15 minutes, at the sweep after that.
  await w.clock.tick(14 * 60_000 - 1, SWEEP_MS / 4)
  assert.equal(w.core.isOpen('s1'), true)
  await w.clock.tick(SWEEP_MS, SWEEP_MS / 4)
  assert.equal(w.core.isOpen('s1'), false)
  assert.equal(w.core.view('s1').reason, 'idle')
})

test('the sweep reads the registry on each round; a round whose registry throws closes no archived browser', async () => {
  const w = await world()
  await w.core.forAgent('s1', undefined, never)
  w.archived.push('s1')
  w.registryThrows = true
  w.clock.advance(SWEEP_MS)
  await flush()
  assert.equal(w.core.isOpen('s1'), true)
  w.registryThrows = false
  w.clock.advance(SWEEP_MS)
  await flush()
  assert.equal(w.core.isOpen('s1'), false)
  assert.equal(w.core.view('s1').reason, 'archived')
})

// --- the stop -----------------------------------------------------------------------------------------------------------

test('disposing the plugin closes every browser and Chromium once, ends open watches, and leaves no timer', async () => {
  const w = await world({ tools: true })
  await w.core.forAgent('s1', undefined, never)
  await w.core.forAgent('s2', undefined, never)
  const r = new Reader(w.ctx, 's1')
  await r.opened()
  // What the listeners and the sweep call on the core, seen from here on: first while the plugin runs, then after.
  const reached: string[] = []
  const spied = w.core as unknown as Record<string, (...args: unknown[]) => unknown>
  for (const method of ['touch', 'agentDisposed', 'close', 'sweep']) {
    const original = spied[method]!.bind(w.core)
    spied[method] = (...args: unknown[]) => {
      reached.push(method)
      return original(...args)
    }
  }
  const nobody = async (): Promise<void> => {
    await w.ctx.serial('agent/created', { agent: { id: 'nobody' }, source: 'creation' } as never)
    w.ctx.emit('agent/disposed', { agent: { id: 'nobody' } } as never)
    await w.ctx.parallel('workspace/session-stop', { sessionId: 'nobody' } as never)
    w.clock.advance(SWEEP_MS)
    await flush()
  }
  await nobody()
  assert.deepEqual(reached, ['touch', 'agentDisposed', 'close', 'sweep'], 'each event, and the minute, reach the core while the plugin runs')
  reached.length = 0
  await w.plugin.dispose()
  await waitFor(() => r.done, 'the open watch to end')
  assert.equal(r.error, undefined)
  assert.equal(w.driver.launches.length, 1)
  assert.equal(w.driver.browser.closeCalls, 1)
  assert.ok(w.driver.browser.contexts.every(context => context.closed), 'every context closed')
  assert.equal(w.core.isOpen('s1'), false)
  assert.equal(w.core.view('s1').reason, 'stopped')
  assert.equal(w.clock.pending, 0, 'no timer left: the sweep, the core\'s and the stream\'s')
  assert.deepEqual(registered(w.tools!), [])
  assert.equal(w.ctx.get(SERVICE), undefined, 'the remote went with it')
  // The listeners and the sweep went with it: the same events, and two minutes, reach nothing of the core's.
  reached.length = 0
  await nobody()
  await nobody()
  assert.deepEqual(reached, [], 'no listener, and no sweep, after the plugin went')
  assert.equal(w.driver.launches.length, 1)
})

// --- the logs -----------------------------------------------------------------------------------------------------------

/** What stderr was written while it was captured. */
function captureStderr(): { text: () => string, restore: () => void } {
  const original = process.stderr.write
  const chunks: string[] = []
  process.stderr.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk))
    return true
  }) as typeof process.stderr.write
  return { text: () => chunks.join(''), restore: () => { process.stderr.write = original } }
}

test('terminal: true prints the plugin\'s own lines; false prints none', async () => {
  for (const terminal of [false, true]) {
    const captured = captureStderr()
    let printed: string
    try {
      const w = await world({ chromium: false, config: { terminal, executablePath: '/nowhere/chromium' } })
      await w.dispose()
    } finally {
      captured.restore()
      printed = captured.text()
    }
    const lines = printed.split('\n').filter(line => line.startsWith('[dish-browser]'))
    if (terminal) assert.deepEqual(lines, ['[dish-browser] warn: no Chromium at /nowhere/chromium: the browser tools aren\'t registered, and the Browser tab says so'])
    else assert.deepEqual(lines, [])
  }
})

test('a logger that throws is ignored: the plugin starts, the core logs, the stream drops a bad item, the stop runs', async () => {
  const w = await world({ chromium: false, throwingLogger: true, gateway: true })
  assert.equal(w.core.unavailable, '/usr/bin/chromium')
  const sane = await world({ throwingLogger: true, gateway: true })
  await sane.core.forAgent('s1', undefined, never)
  const watch = await gatewayWatch(sane, 's1')
  watch.uplink.push({ kind: 'nonsense' }, { kind: 'mouse', action: 'down', x: 1, y: 2, button: 'left', clickCount: 1 })
  const page = sane.driver.pages[0]!
  await eventually(sane, () => page.callsOf('mouse').length === 1, 'the click after the bad item')
  assert.ok(sane.logs.some(line => line.startsWith('[dish-browser] warn: dropped an item from the Browser tab')), 'the remote logs through the plugin\'s logger')
  watch.controller.abort()
  await waitFor(watch.ended, 'the watch to end')
  await sane.plugin.dispose()
  assert.equal(sane.driver.browser.closeCalls, 1)
})

test('no log line holds a URL', async () => {
  const w = await world({ tools: true, gateway: true })
  const tools = w.tools!
  await tools.execute({ callId: 'c-1', name: 'browser_navigate', arguments: { url: 'http://localhost:5173/secret-path?q=1' }, agent: agent('s1'), signal: new AbortController().signal })
  w.ctx.emit('agent/disposed', { agent: { id: 's1' } } as never)
  await w.plugin.dispose()
  const ours = w.logs.filter(line => line.startsWith('[dish-browser]'))
  assert.ok(ours.length > 0, 'something was logged')
  for (const line of ours) assert.doesNotMatch(line, /https?:|file:|secret-path/, line)
})

// --- the sources --------------------------------------------------------------------------------------------------------

/** Every file under `dir`, recursively. */
async function filesUnder(dir: string): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...await filesUnder(path))
    else found.push(path)
  }
  return found
}

/** The modules a source file imports, statically or dynamically. */
function importsOf(text: string): string[] {
  const found: string[] = []
  for (const match of text.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"]([^'"]+)['"]/g)) found.push(match[1]!)
  return found
}

test('the sources: only src/playwright.ts imports playwright-core; src/client imports neither driver.ts, types.ts nor node:', async () => {
  const files = await filesUnder(SRC)
  assert.ok(files.length > 20, 'the sources were found')
  const playwright: string[] = []
  for (const file of files) {
    const name = relative(SRC, file)
    const imports = importsOf(await readFile(file, 'utf8'))
    if (imports.some(module => module === 'playwright-core' || module.startsWith('playwright-core/') || module === 'playwright')) playwright.push(name)
    if (!name.startsWith('client/')) continue
    for (const module of imports) {
      assert.doesNotMatch(module, /^node:/, `${name} imports ${module}`)
      assert.doesNotMatch(module, /(?:^|\/)(?:driver|types)\.ts$/, `${name} imports ${module}`)
      assert.notEqual(module, 'playwright-core', name)
    }
  }
  assert.deepEqual(playwright, ['playwright.ts'])
  // The scan sees an import: index.ts's driver default is the real one, through playwright.ts.
  assert.ok(importsOf(await readFile(join(SRC, 'index.ts'), 'utf8')).includes('./playwright.ts'))
})
