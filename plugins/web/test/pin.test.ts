/**
 * What dish-web leans on that dsh doesn't promise, read from the dsh that is installed, so that a dsh upgrade has to
 * re-check dish-web instead of finding out over the tailnet:
 *
 * - the page: the `dsh-client-connection` dsh serves counts a transport global that says `ownsHost` (dsh's desktop shell
 *   sets it, a served page never does) as the operator's machine, in `isLoopback`;
 * - the server: dsh's web server asks for index rows with `webserver/index-inject`, and renders dish-web's row (an inline
 *   classic script, `placement: 'head'`) at the top of the head;
 * - nothing else turns on the flag: the files in what dsh serves that read `ownsHost`, `__DSH_TRANSPORT__` or `isLoopback`
 *   are exactly the ones in `READERS`, each of which has been looked at.
 *
 * Every dsh package here is found through the root `@deepseek-ai/dsh` (dsh → its dependencies): this package pins no copy
 * of its own, which would go on passing after a dsh upgrade (the same care as `plugins/crew/test/preset.test.ts`).
 * dish-web's own devDependency on `dsh-host-webserver` is there for its types, and is not what is checked here.
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import * as plugin from '../src/index.ts'

const PLUGIN = new URL('..', import.meta.url)
const CHANGED = 'dsh changed how pages decide they are the operator\'s machine; re-check dish-web (docs/specs/ops.md, Settings over the tailnet)'
const SERVER_CHANGED = 'dsh changed how its web server adds rows to the page; re-check that dish-web\'s script still runs in the head before dsh\'s connection reads the transport global (plugins/web/src/index.ts, docs/specs/ops.md, Settings over the tailnet)'

/** The dsh packages this file reads, each resolved by the package that depends on it, starting from the root `dsh`. */
function resolveServed() {
  const dsh = createRequire(new URL('../../package.json', PLUGIN)).resolve('@deepseek-ai/dsh/package.json')
  const webApp = createRequire(dsh).resolve('@deepseek-ai/dsh-web-app/package.json')
  const client = createRequire(webApp).resolve('@deepseek-ai/dsh-client-connection/client')
  const webserver = createRequire(webApp).resolve('@deepseek-ai/dsh-host-webserver')
  return { dsh, webApp, client, webserver }
}

const served = resolveServed()
const source = readFileSync(served.client, 'utf8')

// --- the page --------------------------------------------------------------------------------------------------------

test('the connection still counts a transport that owns the host as the operator\'s machine', () => {
  const line = source.split('\n').find(text => /\bisLoopback:/.test(text))
  assert.ok(line !== undefined, `no isLoopback computation was found. ${CHANGED}`)
  // Anchored at the start of the computation and followed by `||`, so that a term AND-ed in front of or onto it fails too.
  assert.match(line, /\bisLoopback:\s*transport\?\.ownsHost === true\s*\|\|/, `the isLoopback computation is ${JSON.stringify(line.trim())}. ${CHANGED}`)
})

test('the connection still reads the transport from globalThis.__DSH_TRANSPORT__', () => {
  assert.match(source, /\b(?:globals|globalThis)\.__DSH_TRANSPORT__\b/, `nothing reads __DSH_TRANSPORT__ from the global any more. ${CHANGED}`)
})

test('the connection is the one dsh resolves, so a dsh upgrade is what moves this check', () => {
  const connection = realpathSync(dirname(dirname(served.client)))
  const manifest = JSON.parse(readFileSync(`${connection}/package.json`, 'utf8')) as { name: string, version: string }
  assert.equal(manifest.name, '@deepseek-ai/dsh-client-connection')
  const webApp = JSON.parse(readFileSync(served.webApp, 'utf8')) as { dependencies?: Record<string, string> }
  const wanted = webApp.dependencies?.['@deepseek-ai/dsh-client-connection']
  assert.ok(wanted !== undefined, 'dsh-web-app depends on dsh-client-connection')
  if (/^\d/.test(wanted)) assert.equal(manifest.version, wanted, 'dsh-web-app pins an exact dsh-client-connection')
})

test('this package does not pin its own dsh-client-connection, which would hide a dsh upgrade from this check', () => {
  const manifest = JSON.parse(readFileSync(new URL('package.json', PLUGIN), 'utf8')) as Record<string, Record<string, string> | undefined>
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    assert.ok(!(manifest[field] ?? {})['@deepseek-ai/dsh-client-connection'], field)
  }
})

// --- the server ------------------------------------------------------------------------------------------------------

/** A service provided by a stub plugin, as dsh's web app provides `webRuntime`. */
function provideStub(ctx: Context, name: string, value: unknown) {
  return ctx.plugin({
    name: `stub-${name}`,
    apply(own: Context) { (own as unknown as { provide(name: string, value: unknown): void }).provide(name, value) },
  } as never, undefined as never)
}

test('dsh\'s web server still asks for the page\'s rows with webserver/index-inject', () => {
  const server = readFileSync(served.webserver, 'utf8')
  assert.match(server, /\.emit\(\s*(["'])webserver\/index-inject\1\s*,/, `the web server no longer emits webserver/index-inject. ${SERVER_CHANGED}`)
})

test('dsh\'s web server still renders dish-web\'s row as an inline script at the top of the head', async () => {
  const server = await import(pathToFileURL(served.webserver).href) as { renderIndexInjections?: unknown }
  const render = server.renderIndexInjections
  assert.equal(typeof render, 'function', `the web server no longer exports renderIndexInjections. ${SERVER_CHANGED}`)

  const ctx = new Context()
  await provideStub(ctx, 'webRuntime', { trustedHosts: ['dish.example.ts.net'] })
  await ctx.plugin(plugin, { enabled: true, hosts: [] } as plugin.Config)
  const table: IndexInjection[] = []
  ctx.emit('webserver/index-inject', table)
  assert.deepEqual(table.map(row => row.kind), ['script'], 'dish-web added its one row')

  const page = '<!doctype html><html><head><meta charset="utf-8"><title>dsh</title></head><body><div id="root"></div></body></html>'
  let html: unknown
  assert.doesNotThrow(() => { html = (render as (html: string, rows: readonly IndexInjection[]) => string)(page, table) }, `the web server rejects dish-web's row. ${SERVER_CHANGED}`)
  const expected = `<head><script>${plugin.flipScript(['dish.example.ts.net'])}</script><meta charset="utf-8">`
  assert.ok(typeof html === 'string' && html.includes(expected), `dish-web's row is not the first thing in the head: ${JSON.stringify(html)}. ${SERVER_CHANGED}`)
})

// --- everything else that reads the flag -----------------------------------------------------------------------------

/**
 * The files in what dsh serves that mention `ownsHost`, `__DSH_TRANSPORT__` or `isLoopback` (dsh 0.2.0-rc.2), with the
 * names each one mentions, and why dish-web's `{ ownsHost: true }` on a trusted host is fine there. A bundle's hash is `*`.
 */
const READERS: Record<string, string[]> = {
  // Decides isLoopback from ownsHost (the check above): the one thing dish-web means to change.
  '@deepseek-ai/dsh-client-connection/lib/client.js': ['__DSH_TRANSPORT__', 'isLoopback', 'ownsHost'],
  // Hands the connection's isLoopback on as $host.isLoopback; reads only streamBaseUrl, unset by dish-web, from the global.
  '@deepseek-ai/dsh-api-gateway/lib/client.js': ['__DSH_TRANSPORT__', 'isLoopback'],
  // The package's per-module build of the same $host.isLoopback hand-on.
  '@deepseek-ai/dsh-api-gateway/lib/types/client/index.js': ['isLoopback'],
  // The package's per-module build of the same streamBaseUrl read: without it, the page's own base.
  '@deepseek-ai/dsh-api-gateway/lib/types/client/stream-client.js': ['__DSH_TRANSPORT__'],
  // Settings persistence: host when $host.isLoopback, else memory. Host persistence is what dish-web is for.
  '@deepseek-ai/dsh-client-ui-settings/lib/client.js': ['isLoopback'],
  // Settings > General's document store, only when $host.isLoopback: what dish-web is for.
  '@deepseek-ai/dsh-client-ui-settings-general/lib/client.js': ['isLoopback'],
  // Account sign-in reads only streamBaseUrl from the global: without it, the page's own origin.
  '@deepseek-ai/dsh-client-ui-settings-account/lib/client.js': ['__DSH_TRANSPORT__'],
  // isLoopback appears only in type declarations it carries as text.
  '@deepseek-ai/dsh-cordis-client-runner/lib/client.js': ['isLoopback'],
  // The module loader reads only loadBundle; the desktop shell's boot (dshDesktopBoot, never on a served page) writes ownsHost.
  '@deepseek-ai/dsh-web-frontend/dist/assets/index-*.js': ['__DSH_TRANSPORT__', 'ownsHost'],
}

const NAMES = /\bownsHost\b|__DSH_TRANSPORT__|\bisLoopback\b/g

/**
 * dsh's own packages (`@deepseek-ai/*`) that the root `dsh` brings, directly or not, by real directory: `dsh-web-app` and
 * everything it depends on, `dsh-web-frontend` among them. Every `dependencies` entry must resolve; an optional or peer one
 * that isn't installed (another platform's binary) is skipped.
 */
function dshPackages(): Map<string, string> {
  const found = new Map<string, string>()
  const queue = [served.dsh]
  for (let manifest = queue.shift(); manifest !== undefined; manifest = queue.shift()) {
    const dir = realpathSync(dirname(manifest))
    if (found.has(dir)) continue
    const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as Record<string, unknown> & { name: string }
    found.set(dir, pkg.name)
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const name of Object.keys((pkg[field] ?? {}) as Record<string, string>)) {
        if (!name.startsWith('@deepseek-ai/')) continue
        try {
          queue.push(createRequire(manifest).resolve(`${name}/package.json`))
        } catch (error) {
          if (field === 'dependencies') throw new Error(`${pkg.name}'s dependency ${name} does not resolve (${(error as Error).message}). ${CHANGED}`)
        }
      }
    }
  }
  return found
}

/** Every script or page in `dir` (not under node_modules) that mentions one of NAMES, as `<package>/<path>`: the names. */
function readersIn(name: string, root: string, dir: string, found: Record<string, string[]>): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      readersIn(name, root, path, found)
    } else if (/\.(?:[cm]?js|html)$/.test(entry.name)) {
      const names = new Set(readFileSync(path, 'utf8').match(NAMES))
      if (names.size === 0) continue
      const file = relative(root, path).replace(/^(dist\/assets\/.+)-[\w-]{8}(\.[cm]?js)$/, '$1-*$2')
      found[`${name}/${file}`] = [...names].sort()
    }
  }
}

test('in what dsh serves, the flag and what it decides are read where they were, and nowhere else', () => {
  const found: Record<string, string[]> = {}
  for (const [dir, name] of dshPackages()) readersIn(name, dir, dir, found)
  const describe = (files: string[], from: Record<string, string[]>) => files.map(file => `${file} (${from[file]!.join(', ')})`).join('; ') || 'none'
  const added = Object.keys(found).filter(file => !(file in READERS)).sort()
  const gone = Object.keys(READERS).filter(file => !(file in found)).sort()
  const changed = Object.keys(READERS).filter(file => file in found && found[file]!.join() !== READERS[file]!.join()).sort()
  assert.ok(added.length + gone.length + changed.length === 0, [
    `the files dsh serves that read ownsHost, __DSH_TRANSPORT__ or isLoopback have changed.`,
    `New: ${describe(added, found)}. Now reading other names: ${describe(changed, found)}. Gone: ${describe(gone, READERS)}.`,
    'For each new or changed one, work out what a page on a trusted host does differently once dish-web has set',
    '__DSH_TRANSPORT__ = { ownsHost: true } (isLoopback true, and no streamBaseUrl or loadBundle), then update READERS in',
    `plugins/web/test/pin.test.ts with a line on why. ${CHANGED}`,
  ].join(' '))
})
