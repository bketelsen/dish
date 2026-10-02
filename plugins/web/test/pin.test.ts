/**
 * The one thing dish-web leans on that dsh doesn't promise: the page's `isLoopback` also counts a transport global that
 * says `ownsHost` (dsh's desktop shell sets it, a served page never does). This reads the `dsh-client-connection` that
 * dsh serves, and fails when that is no longer how it decides, so that a dsh upgrade has to re-check dish-web instead of
 * finding out over the tailnet.
 *
 * "The one dsh serves" is the one dsh's own `dsh-web-app` resolves, found through the root `@deepseek-ai/dsh`: this package
 * pins no copy of its own, which would go on passing after a dsh upgrade (the same care as `plugins/crew/test/preset.test.ts`).
 */

import assert from 'node:assert/strict'
import { readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { test } from 'node:test'

const PLUGIN = new URL('..', import.meta.url)
const CHANGED = 'dsh changed how pages decide they are the operator\'s machine; re-check dish-web (docs/specs/ops.md, Settings over the tailnet)'

/** The client entry of the `dsh-client-connection` that dsh's `dsh-web-app` resolves, and the manifests on the way to it. */
function resolveServed() {
  const dsh = createRequire(new URL('../../package.json', PLUGIN)).resolve('@deepseek-ai/dsh/package.json')
  const webApp = createRequire(dsh).resolve('@deepseek-ai/dsh-web-app/package.json')
  const client = createRequire(webApp).resolve('@deepseek-ai/dsh-client-connection/client')
  return { dsh, webApp, client }
}

const served = resolveServed()
const source = readFileSync(served.client, 'utf8')

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
