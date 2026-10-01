/**
 * The page's side of the wire: the hand-written descriptors must name exactly the methods `PromptsRemote` marks, with the
 * parameter names the gateway reads off its source (it reads each argument by the name of the method's parameter), and
 * the copies of dish-config's wire types the page keeps must be the store's own.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { jsonCodec } from 'dish-kit/client'
import type { FileDiff } from 'dish-kit/ui/diff'
import type { CommitInfo as StoreCommit, ConfigEvent as StoreEvent, FileDiff as StoreDiff } from '../../config/src/protocol.ts'
import type { ConfigRemote } from '../../config/src/remote.ts'
import { promptsRemote } from '../src/client/remote.ts'
import type { ConfigCalls, ConfigEvent } from '../src/client/remote.ts'
import type { CommitInfo } from '../src/protocol.ts'
import { PromptsRemote } from '../src/remote.ts'

// What the page believes of dish-config's wire is checked here, where Node's types and the store's are both in reach: this
// fails to compile if either side changes.
type Same<A, B> = [A] extends [B] ? [B] extends [A] ? SameKeys<A, B> : false : false
/** Mutual assignability lets a field that is optional on one side only through: the keys of two objects must be the same too. */
type SameKeys<A, B> = [A] extends [object] ? [B] extends [object] ? ([keyof A] extends [keyof B] ? [keyof B] extends [keyof A] ? true : false : false) : true : true
type Check<T extends true> = T
export type PageMatchesStore = [
  Check<Same<ConfigEvent, StoreEvent>>,
  Check<Same<CommitInfo, StoreCommit>>,
  Check<Same<FileDiff, StoreDiff>>,
]

/**
 * What the page calls of dish-config's remote must be what that remote's methods take and give: the same parameters, and the
 * same value inside the `Outcome` (the page's own `Outcome` has one more code, `UNAVAILABLE`, which dish-config never says, so
 * the value is compared and not the whole). A change to `ConfigRemote`'s signature is a type error here.
 */
type Value<R> = R extends { ok: true, value: infer V } ? V : never
type Served<K extends keyof ConfigCalls> = Value<Awaited<ReturnType<ConfigRemote[K]>>>
type Called<K extends keyof ConfigCalls> = Value<Value<Awaited<ReturnType<ConfigCalls[K]>>>>
export type CallsMatchTheRemote = [
  Check<Same<Parameters<ConfigCalls['history']>, Parameters<ConfigRemote['history']>>>,
  Check<Same<Parameters<ConfigCalls['commit']>, Parameters<ConfigRemote['commit']>>>,
  Check<Same<Parameters<ConfigCalls['revert']>, Parameters<ConfigRemote['revert']>>>,
  Check<Same<Called<'history'>, Served<'history'>>>,
  Check<Same<Called<'commit'>, Served<'commit'>>>,
  Check<Same<Called<'revert'>, Served<'revert'>>>,
]

/** The gateway's source-mode reading of a method's parameter names: the text between its first parentheses, split on commas. */
function parameterNames(method: (...args: never[]) => unknown): string[] {
  const source = Function.prototype.toString.call(method)
  const open = source.indexOf('(')
  const body = source.slice(open + 1, source.indexOf(')', open + 1)).trim()
  return body === '' ? [] : body.split(',').map(part => part.trim())
}

test('the descriptors list exactly the methods PromptsRemote marks, no more and no fewer', () => {
  const marked = remoteMethods(Object.create(PromptsRemote.prototype) as PromptsRemote).map(mark => mark.method).sort()
  assert.deepEqual(marked, ['preview', 'read', 'reset', 'roles', 'save', 'variables'])
  assert.deepEqual(promptsRemote.descriptors.map(descriptor => descriptor.method).sort(), marked)
  assert.equal(promptsRemote.package, 'dish-prompts')
})

test('each descriptor is a direct, plain-JSON call in the dishPrompts namespace, and sends the parameters the server reads, by name', () => {
  const expected: Record<string, string[]> = {
    roles: [],
    read: ['role'],
    save: ['role', 'text', 'base', 'note'],
    reset: ['role', 'base', 'note'],
    preview: ['role'],
    variables: [],
  }
  for (const descriptor of promptsRemote.descriptors) {
    const method = descriptor.method
    assert.equal(descriptor.id, `dish-prompts#dishPrompts/${method}`)
    assert.equal(descriptor.namespace, 'dishPrompts', method)
    assert.equal(descriptor.service, 'dishPrompts', method)
    assert.deepEqual(descriptor.invocation, { kind: 'direct' }, method)
    assert.deepEqual(descriptor.result, { mode: 'src-json' }, method)
    assert.equal(descriptor.mode, undefined, `${method} is not a stream`)

    const sent = descriptor.parameters.map(parameter => parameter.name)
    assert.deepEqual(sent, expected[method], method)
    // The names the server's own source gives are the ones the gateway reads: the page must send those.
    const server = (PromptsRemote.prototype as unknown as Record<string, (...args: never[]) => unknown>)[method]!
    assert.deepEqual(sent, parameterNames(server), `${method}: the server's parameter names`)
    for (const parameter of descriptor.parameters) {
      assert.equal(parameter.wire, parameter.name, `${method}.${parameter.name}`)
      assert.equal(parameter.source, 'json', `${method}.${parameter.name}`)
      assert.equal(parameter.codec, jsonCodec, `${method}.${parameter.name}`)
    }
  }
})
