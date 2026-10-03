import { createContext, runInContext, Script } from 'node:vm'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import * as plugin from '../src/index.ts'

// --- trustedPageHosts ------------------------------------------------------------------------------

test('trustedPageHosts keeps DNS names and drops IPv4, IPv6 and bracketed IPv6 entries', () => {
  assert.deepEqual(
    plugin.trustedPageHosts(['10.0.0.5', '192.168.0.2:3080', '::1', 'fe80::1', '[::1]', '[fe80::1]:3080', 'dish.example-tailnet.ts.net'], []),
    ['dish.example-tailnet.ts.net'],
  )
})

test('trustedPageHosts strips a port, folds case, removes duplicates and sorts', () => {
  assert.deepEqual(
    plugin.trustedPageHosts(['Dish.TS.net:443', 'b.example', 'dish.ts.net', 'A.example:8080', 'b.example:3080'], []),
    ['a.example', 'b.example', 'dish.ts.net'],
  )
})

test('trustedPageHosts drops what is not a DNS name: a scheme, a path, a blank, a bad port, a wildcard, or a numeric last label', () => {
  assert.deepEqual(
    plugin.trustedPageHosts(['https://a.example', 'a.example/path', '', '   ', 'a.example:', 'a.example:http', '*.ts.net', '-a.example', 'a..example', 'a.example.', 'user@a.example', 'a_b.example', '1.2', '0x7f', '300.300.300.300', 'ok.example'], []),
    ['ok.example'],
  )
})

test('trustedPageHosts: with an override, the override is the list, and the derived hosts are ignored', () => {
  assert.deepEqual(plugin.trustedPageHosts(['derived.example'], ['Mine.example', 'mine.example', 'a.example']), ['a.example', 'mine.example'])
  assert.deepEqual(plugin.trustedPageHosts([], ['only.example']), ['only.example'])
})

test('trustedPageHosts: an override entry that is not a bare DNS name is a clear error, naming the entry', () => {
  for (const bad of ['10.0.0.5', '::1', '[::1]', 'a.example:3080', 'https://a.example', 'a b', '', 'a..example', '*.example', 'a.example/x', '1.2.3']) {
    assert.throws(() => plugin.trustedPageHosts(['derived.example'], ['ok.example', bad]), (error: Error) => {
      assert.match(error.message, /dish-web: hosts entry /)
      assert.ok(error.message.includes(JSON.stringify(bad)), `${error.message} names ${JSON.stringify(bad)}`)
      assert.match(error.message, /bare DNS name/)
      return true
    }, JSON.stringify(bad))
  }
})

// --- flipScript ------------------------------------------------------------------------------------

/** A value that came out of a vm context, as a plain object of this realm (the two realms' prototypes differ, so `deepEqual` would not compare them). */
function plain(value: unknown): unknown {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

/** Run `script` as a classic script on a page at `hostname` and return the page's global. */
function runOn(script: string, hostname: string | undefined, globals: Record<string, unknown> = {}): Record<string, unknown> {
  const page: Record<string, unknown> = { ...globals }
  if (hostname !== undefined) page.location = { hostname }
  const context = createContext(page)
  runInContext(script, context)
  return page
}

test('flipScript contains no </script, however the hosts are spelled', () => {
  for (const hosts of [[], ['dish.ts.net'], ['</script><script>alert(1)</script>'], ['a b', '"quoted"', '\\']]) {
    const script = plugin.flipScript(hosts)
    assert.ok(!/<\/script/i.test(script), JSON.stringify(hosts))
    assert.ok(!script.includes('<'), 'a < in a host is escaped')
  }
})

test('flipScript sets the transport on a listed host, and the transport only owns the host', () => {
  const page = runOn(plugin.flipScript(['dish.ts.net', 'other.example']), 'dish.ts.net')
  assert.deepEqual(plain(page.__DSH_TRANSPORT__), { ownsHost: true })
  const second = runOn(plugin.flipScript(['dish.ts.net', 'other.example']), 'other.example')
  assert.deepEqual(plain(second.__DSH_TRANSPORT__), { ownsHost: true })
})

test('flipScript folds the page hostname to lower case', () => {
  assert.deepEqual(plain(runOn(plugin.flipScript(['dish.ts.net']), 'DISH.TS.NET').__DSH_TRANSPORT__), { ownsHost: true })
})

test('flipScript leaves an unlisted host alone', () => {
  for (const hostname of ['evil.example', '127.0.0.1', 'localhost', 'dish.ts.net.evil.example', 'xdish.ts.net', '10.0.0.5', '']) {
    const page = runOn(plugin.flipScript(['dish.ts.net']), hostname)
    assert.equal('__DSH_TRANSPORT__' in page, false, JSON.stringify(hostname))
  }
})

test('flipScript with no hosts does nothing', () => {
  assert.equal('__DSH_TRANSPORT__' in runOn(plugin.flipScript([]), 'dish.ts.net'), false)
})

test('flipScript does not touch a transport that is already there', () => {
  const existing = { streamBaseUrl: 'https://elsewhere.example' }
  const page = runOn(plugin.flipScript(['dish.ts.net']), 'dish.ts.net', { __DSH_TRANSPORT__: existing })
  assert.equal(page.__DSH_TRANSPORT__, existing)
  assert.deepEqual(plain(page.__DSH_TRANSPORT__), { streamBaseUrl: 'https://elsewhere.example' })
})

test('flipScript never throws: a throwing location, no location, a location with no hostname, a global that refuses the write', () => {
  const script = plugin.flipScript(['dish.ts.net'])
  const throwing: Record<string, unknown> = {}
  Object.defineProperty(throwing, 'location', { get() { throw new Error('no location for you') }, enumerable: true })
  const throwingContext = createContext(throwing)
  assert.doesNotThrow(() => runInContext(script, throwingContext))
  assert.equal('__DSH_TRANSPORT__' in throwing, false)

  assert.doesNotThrow(() => runOn(script, undefined))
  assert.doesNotThrow(() => runInContext(script, createContext({ location: {} })))
  assert.doesNotThrow(() => runInContext(script, createContext({ location: { hostname: 7 } })))

  const refusing = createContext({ location: { hostname: 'dish.ts.net' } })
  runInContext('Object.defineProperty(globalThis, "__DSH_TRANSPORT__", { get() { return undefined }, set() { throw new Error("read only") } })', refusing)
  assert.doesNotThrow(() => runInContext(script, refusing))
})

test('flipScript is one classic script: it parses as a script, with no module syntax', () => {
  for (const hosts of [[], ['a.example'], ['a.example', 'b.example']]) assert.doesNotThrow(() => new Script(plugin.flipScript(hosts)))
})

// --- the plugin ------------------------------------------------------------------------------------

/** A service provided by a stub plugin, not on the root context, so that code reading it as a property would not find it. */
function provideStub(ctx: Context, name: string, value: unknown) {
  return ctx.plugin({
    name: `stub-${name}`,
    apply(own: Context) { (own as unknown as { provide(name: string, value: unknown): void }).provide(name, value) },
  } as never, undefined as never)
}

/** What a request for index.html collects: the web server emits `webserver/index-inject` with an empty table. */
function collect(ctx: Context): IndexInjection[] {
  const table: IndexInjection[] = []
  ctx.emit('webserver/index-inject', table)
  return table
}

/** What `dsh-web-app` provides. */
function webRuntime(trustedHosts: string[]) {
  return { lanAddresses: trustedHosts.filter(host => /^\d/.test(host)), trustedHosts }
}

function mount(ctx: Context, config: Partial<plugin.Config> = {}) {
  return ctx.plugin(plugin, { enabled: true, hosts: [], ...config } as plugin.Config)
}

test('with a webRuntime, the plugin adds exactly one script row to the head, for the non-IP trusted hosts', async () => {
  const ctx = new Context()
  await provideStub(ctx, 'webRuntime', webRuntime(['10.0.0.5', 'Dish.TS.net:443', 'dish.ts.net']))
  await mount(ctx)
  const rows = collect(ctx)
  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0], { kind: 'script', placement: 'head', text: plugin.flipScript(['dish.ts.net']) })
})

test('the plugin runs the script it adds: the transport is set on a trusted host and only there', async () => {
  const ctx = new Context()
  await provideStub(ctx, 'webRuntime', webRuntime(['dish.ts.net']))
  await mount(ctx)
  const [row] = collect(ctx)
  assert.equal(row.kind, 'script')
  const text = row.kind === 'script' ? row.text : ''
  assert.deepEqual(plain(runOn(text, 'dish.ts.net').__DSH_TRANSPORT__), { ownsHost: true })
  assert.equal('__DSH_TRANSPORT__' in runOn(text, 'elsewhere.example'), false)
})

test('the row is the same on every request, and comes before rows added earlier or later', async () => {
  const ctx = new Context()
  ctx.on('webserver/index-inject', (table) => { table.push({ kind: 'global', name: 'earlier', value: 1 }) })
  await provideStub(ctx, 'webRuntime', webRuntime(['dish.ts.net']))
  await mount(ctx)
  ctx.on('webserver/index-inject', (table) => { table.push({ kind: 'global', name: 'later', value: 2 }) })
  const first = collect(ctx)
  assert.deepEqual(first, collect(ctx))
  assert.deepEqual(first.map(row => row.kind), ['script', 'global', 'global'])
})

test('the plugin waits for webRuntime: it adds its row once there is one, and not after it is gone', async () => {
  const ctx = new Context()
  await mount(ctx)
  assert.deepEqual(collect(ctx), [])
  const runtime = provideStub(ctx, 'webRuntime', webRuntime(['dish.ts.net']))
  await runtime
  assert.equal(collect(ctx).length, 1)
  await runtime.dispose()
  assert.deepEqual(collect(ctx), [])
})

test('with no webRuntime, nothing is registered and nothing is added', async () => {
  const ctx = new Context()
  const handle = mount(ctx)
  await handle
  assert.deepEqual(collect(ctx), [])
  assert.equal(ctx.get('webRuntime' as never), undefined)
})

test('with enabled: false, nothing is added', async () => {
  const ctx = new Context()
  await provideStub(ctx, 'webRuntime', webRuntime(['dish.ts.net']))
  await mount(ctx, { enabled: false })
  assert.deepEqual(collect(ctx), [])
})

test('with no non-IP trusted host, and none configured, nothing is added', async () => {
  for (const trusted of [[], ['10.0.0.5'], ['[::1]:3080'], ['10.0.0.5', '192.168.1.9']]) {
    const ctx = new Context()
    await provideStub(ctx, 'webRuntime', webRuntime(trusted))
    await mount(ctx)
    assert.deepEqual(collect(ctx), [], JSON.stringify(trusted))
  }
})

test('hosts replaces the derived list, and can supply one when there is none', async () => {
  const replaced = new Context()
  await provideStub(replaced, 'webRuntime', webRuntime(['derived.example']))
  await mount(replaced, { hosts: ['Mine.example'] })
  assert.deepEqual(collect(replaced), [{ kind: 'script', placement: 'head', text: plugin.flipScript(['mine.example']) }])

  const supplied = new Context()
  await provideStub(supplied, 'webRuntime', webRuntime([]))
  await mount(supplied, { hosts: ['mine.example'] })
  assert.equal(collect(supplied).length, 1)
})

test('a hosts entry that is an IP or has a port fails the plugin to load, and adds nothing', async () => {
  for (const bad of ['10.0.0.5', 'dish.ts.net:3080']) {
    const ctx = new Context()
    await provideStub(ctx, 'webRuntime', webRuntime(['dish.ts.net']))
    const handle = mount(ctx, { hosts: [bad] })
    await assert.rejects(async () => { await handle }, /dish-web: hosts entry .*bare DNS name/)
    assert.deepEqual(collect(ctx), [], bad)
  }
})

test('a webRuntime without a trustedHosts list adds nothing and does not throw', async () => {
  const ctx = new Context()
  await provideStub(ctx, 'webRuntime', {})
  await mount(ctx)
  assert.deepEqual(collect(ctx), [])
})

test('disposing the plugin takes its row away', async () => {
  const ctx = new Context()
  await provideStub(ctx, 'webRuntime', webRuntime(['dish.ts.net']))
  const handle = mount(ctx)
  await handle
  assert.equal(collect(ctx).length, 1)
  await handle.dispose()
  assert.deepEqual(collect(ctx), [])
})

test('the configuration has enabled (true) and hosts (empty), and the plugin is called dish-web', () => {
  assert.deepEqual({ ...plugin.Config({} as plugin.Config) }, { enabled: true, hosts: [] })
  assert.equal(plugin.name, 'dish-web')
})
