/**
 * The one thing dish-web leans on that dsh doesn't promise: the page's `isLoopback` also counts a transport global that
 * says `ownsHost` (dsh's desktop shell sets it, a served page never does). This reads the installed
 * `@deepseek-ai/dsh-client-connection` and fails when that is no longer how it decides, so that a dsh upgrade has to
 * re-check dish-web instead of finding out over the tailnet.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const CHANGED = 'dsh changed how pages decide they are the operator\'s machine; re-check dish-web (docs/specs/ops.md, Settings over the tailnet)'

const source = readFileSync(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-client-connection/client')), 'utf8')

test('the connection still counts a transport that owns the host as the operator\'s machine', () => {
  const line = source.split('\n').find(text => /\bisLoopback:/.test(text))
  assert.ok(line !== undefined, `no isLoopback computation was found. ${CHANGED}`)
  assert.match(line, /transport\?\.ownsHost === true/, `the isLoopback computation is ${JSON.stringify(line.trim())}. ${CHANGED}`)
})

test('the connection still reads the transport from globalThis.__DSH_TRANSPORT__', () => {
  assert.match(source, /\b(?:globals|globalThis)\.__DSH_TRANSPORT__\b/, `nothing reads __DSH_TRANSPORT__ from the global any more. ${CHANGED}`)
})
