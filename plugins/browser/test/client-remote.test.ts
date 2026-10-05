/**
 * The tab's side of the wire: the hand-written descriptor (`src/client/remote.ts`) must name exactly the methods
 * `BrowserRemote` marks, with the parameter names the gateway reads off the server's source (it reads each argument by the
 * name of the method's parameter, and takes the last one, `signal`, as the cancellation parameter), as a stream with an
 * uplink; and what the tab calls must be what the server serves.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteStreamHandle } from '@deepseek-ai/dsh-typert-protocol'
import { jsonCodec, remoteContribution, RESERVED_REMOTE_METHODS } from 'dish-kit/client'
import { browserRemote } from '../src/client/remote.ts'
import type { BrowserApi } from '../src/client/remote.ts'
import { NAMESPACE } from '../src/protocol.ts'
import type { Down, Up } from '../src/protocol.ts'
import { BrowserRemote } from '../src/remote.ts'

type Same<A, B> = [A] extends [B] ? [B] extends [A] ? true : false : false
type Check<T extends true> = T

/** What the tab calls is what the server serves: the session's id, the items down and the items up. A drift is a type error. */
type Item<T> = T extends AsyncIterable<infer I> ? I : never
export type CallsMatchTheServer = [
  Check<Same<Parameters<BrowserApi['watch']>[0], Parameters<BrowserRemote['watch']>[0]>>,
  Check<Same<Parameters<BrowserRemote['watch']>[1], AbortSignal>>,
  Check<Same<ReturnType<BrowserApi['watch']>, RemoteStreamHandle<Down, Up>>>,
  Check<Same<Item<ReturnType<BrowserRemote['watch']>>, Down>>,
]

/** The gateway's source-mode reading of a method's parameter names: the text between its first parentheses, split on commas. */
function parameterNames(method: (...args: never[]) => unknown): string[] {
  const source = Function.prototype.toString.call(method)
  const open = source.indexOf('(')
  const body = source.slice(open + 1, source.indexOf(')', open + 1)).trim()
  return body === '' ? [] : body.split(',').map(part => part.trim())
}

test('the descriptors list exactly the methods BrowserRemote marks: watch, a stream', () => {
  const marks = remoteMethods(Object.create(BrowserRemote.prototype) as BrowserRemote)
  assert.deepEqual(marks.map(mark => mark.method), ['watch'])
  assert.equal(marks[0]?.mode, 'stream')
  assert.deepEqual(browserRemote.descriptors.map(descriptor => descriptor.method), ['watch'])
  assert.equal(browserRemote.package, 'dish-browser')
})

test('watch is a direct, plain-JSON stream in the dishBrowser namespace, with the server\'s parameter names and a JSON uplink', () => {
  const [descriptor] = browserRemote.descriptors
  assert.ok(descriptor !== undefined)
  assert.equal(descriptor.id, 'dish-browser#dishBrowser/watch')
  assert.equal(descriptor.namespace, NAMESPACE)
  assert.equal(descriptor.namespace, 'dishBrowser')
  assert.equal(descriptor.service, 'dishBrowser')
  assert.deepEqual(descriptor.invocation, { kind: 'direct' })
  assert.deepEqual(descriptor.result, { mode: 'src-json' })
  assert.equal(descriptor.mode, 'stream')
  assert.deepEqual(descriptor.cancellation, { parameter: 'signal' })
  assert.equal(descriptor.uplink?.codec, jsonCodec)

  const server = parameterNames(BrowserRemote.prototype.watch as (...args: never[]) => unknown)
  assert.deepEqual(server, ['sessionId', 'signal'], 'the server\'s own names: not `session`, which dsh would resolve to an object')
  const sent = descriptor.parameters.map(parameter => parameter.name)
  assert.deepEqual([...sent, descriptor.cancellation?.parameter], server, 'the parameters, then the cancellation parameter, last')
  for (const parameter of descriptor.parameters) {
    assert.equal(parameter.wire, parameter.name)
    assert.equal(parameter.source, 'json')
    assert.equal(parameter.codec, jsonCodec)
  }
})

test('remoteContribution takes the descriptors: no method is named like a member of the browser\'s namespace service', () => {
  for (const descriptor of browserRemote.descriptors) assert.ok(!RESERVED_REMOTE_METHODS.includes(descriptor.method), descriptor.method)
  assert.doesNotThrow(() => remoteContribution('dish-browser', [...browserRemote.descriptors]))
})
