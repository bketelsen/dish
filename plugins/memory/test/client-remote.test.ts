/**
 * The page's side of the wire: the hand-written descriptors (`src/client/remote.ts`) must name exactly the methods
 * `MemoryRemote` marks, with the parameter names the gateway reads off its source (it reads each argument by the name of the
 * method's parameter, and takes a last `signal` as the stream's cancellation), and what the page calls must be what the
 * server serves. The wire's copies of the store's types (`protocol.ts`) must be the store's own.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteStreamHandle } from '@deepseek-ai/dsh-typert-protocol'
import { RESERVED_REMOTE_METHODS, jsonCodec, remoteContribution } from 'dish-kit/client'
import type {
  Author as StoreAuthor, CommitInfo as StoreCommit, FileDiff as StoreDiff, RemoteStatus as StoreStatus,
} from 'dish-kit/store'
import type { FileDiff as KitDiff } from 'dish-kit/ui/diff'
import { memoryRemote } from '../src/client/remote.ts'
import type { MemoryApi } from '../src/client/remote.ts'
import { NAMESPACE } from '../src/protocol.ts'
import type { Author, CommitInfo, FileDiff, MemoryEvent, RemoteStatus } from '../src/protocol.ts'
import { MemoryRemote } from '../src/remote.ts'

type Same<A, B> = [A] extends [B] ? [B] extends [A] ? SameKeys<A, B> : false : false
/** Mutual assignability lets a field that is optional on one side only through: the keys of two objects must be the same too. */
type SameKeys<A, B> = [A] extends [object] ? [B] extends [object] ? ([keyof A] extends [keyof B] ? [keyof B] extends [keyof A] ? true : false : false) : true : true
type Check<T extends true> = T
/** True when every property of `T` is `true`. */
type Every<T> = [T[keyof T]] extends [true] ? true : false

/** The page's copies of the store's types are the store's, and the diffs it hands dish-kit's `DiffView` are the ones it takes. */
export type WireMatchesTheStore = [
  Check<Same<Author, StoreAuthor>>,
  Check<Same<CommitInfo, StoreCommit>>,
  Check<Same<FileDiff, StoreDiff>>,
  Check<Same<RemoteStatus, StoreStatus>>,
  Check<Same<FileDiff, KitDiff>>,
]

/**
 * Every call the page makes is a method of `MemoryRemote`, with its parameters, in order, and its `Outcome`; and the stream
 * is the server's, item for item. A change to either side is a type error here and not a wrong call in the browser.
 */
type Value<R> = R extends { ok: true, value: infer V } ? V : never
type Item<T> = T extends AsyncIterable<infer I> ? I : never
type Calls = Exclude<keyof MemoryApi, 'watch'>
type Served<K extends Calls> = Awaited<ReturnType<MemoryRemote[K]>>
type Called<K extends Calls> = Value<Awaited<ReturnType<MemoryApi[K]>>>
type CallMatches<K extends Calls> =
  [Same<Parameters<MemoryApi[K]>, Parameters<MemoryRemote[K]>>, Same<Called<K>, Served<K>>] extends [true, true] ? true : false
export type ApiMatchesTheServer = [
  Check<Every<{ [K in Calls]: CallMatches<K> }>>,
  Check<Same<ReturnType<MemoryApi['watch']>, RemoteStreamHandle<MemoryEvent, never>>>,
  Check<Same<Item<ReturnType<MemoryRemote['watch']>>, MemoryEvent>>,
  Check<Same<Parameters<MemoryRemote['watch']>, [signal: AbortSignal]>>,
]

/** What each method takes, by the names the server's source gives them; `watch`'s `signal` is its cancellation. */
const PARAMETERS: Record<string, string[]> = {
  scopes: [],
  list: ['scope'],
  read: ['scope', 'name'],
  save: ['scope', 'name', 'type', 'description', 'body', 'base'],
  forget: ['scope', 'name', 'base'],
  release: ['scope', 'name'],
  direction: ['family'],
  saveDirection: ['family', 'text', 'base', 'note'],
  history: ['scope', 'before'],
  commit: ['id'],
  revert: ['id'],
  preview: ['scope'],
  remoteStatus: [],
  watch: [],
}

/** The gateway's source-mode reading of a method's parameter names: the text between its first parentheses, split on commas. */
function parameterNames(method: (...args: never[]) => unknown): string[] {
  const source = Function.prototype.toString.call(method)
  const open = source.indexOf('(')
  const body = source.slice(open + 1, source.indexOf(')', open + 1)).trim()
  return body === '' ? [] : body.split(',').map(part => part.trim())
}

test('the descriptors are exactly the server\'s methods', () => {
  const marked = remoteMethods(Object.create(MemoryRemote.prototype) as MemoryRemote).map(mark => mark.method).sort()
  assert.deepEqual(marked, Object.keys(PARAMETERS).sort())
  assert.deepEqual(memoryRemote.descriptors.map(descriptor => descriptor.method).sort(), marked)
  assert.equal(memoryRemote.package, 'dish-memory')
})

test('each descriptor\'s parameters are the server method\'s, in order', () => {
  for (const descriptor of memoryRemote.descriptors) {
    const method = descriptor.method
    assert.equal(descriptor.id, `dish-memory#dishMemory/${method}`)
    assert.equal(descriptor.namespace, NAMESPACE, method)
    assert.equal(descriptor.service, 'dishMemory', method)
    assert.deepEqual(descriptor.invocation, { kind: 'direct' }, method)
    assert.deepEqual(descriptor.result, { mode: 'src-json' }, method)

    const sent = descriptor.parameters.map(parameter => parameter.name)
    assert.deepEqual(sent, PARAMETERS[method], method)
    // The names the server's own source gives are the ones the gateway reads: the page must send those, then the cancellation.
    const server = (MemoryRemote.prototype as unknown as Record<string, (...args: never[]) => unknown>)[method]!
    if (method === 'watch') {
      assert.equal(descriptor.mode, 'stream')
      assert.deepEqual(descriptor.cancellation, { parameter: 'signal' })
      assert.equal(descriptor.uplink, undefined, 'the stream has no uplink')
      assert.deepEqual([...sent, descriptor.cancellation?.parameter], parameterNames(server), 'watch: the server\'s parameter names')
    } else {
      assert.equal(descriptor.mode, undefined, `${method} is not a stream`)
      assert.equal(descriptor.cancellation, undefined, method)
      assert.deepEqual(sent, parameterNames(server), `${method}: the server's parameter names`)
    }
    for (const parameter of descriptor.parameters) {
      assert.equal(parameter.wire, parameter.name, `${method}.${parameter.name}`)
      assert.equal(parameter.source, 'json', `${method}.${parameter.name}`)
      assert.equal(parameter.codec, jsonCodec, `${method}.${parameter.name}`)
    }
  }
})

// The method that deletes a memory can't be called `remove`: the gateway's namespace service has a member of that name and
// refuses to mount the method, which fails the whole plugin's load. dish-kit's `remoteContribution` throws at once for such a
// name; this keeps the server from using one.
test('no method is a reserved name', () => {
  assert.ok(RESERVED_REMOTE_METHODS.includes('remove'))
  const served = remoteMethods(Object.create(MemoryRemote.prototype) as MemoryRemote).map(mark => mark.method)
  for (const method of [...served, ...memoryRemote.descriptors.map(descriptor => descriptor.method)]) {
    assert.ok(!RESERVED_REMOTE_METHODS.includes(method), `${method} is a member of the gateway's namespace service`)
    assert.ok(!(method in Object.prototype), `${method} is a member of every object`)
  }
  assert.doesNotThrow(() => remoteContribution('dish-memory', [...memoryRemote.descriptors]))
})
