/**
 * The page's side of the wire: the hand-written descriptors must name exactly the methods `RunsRemote` marks, with the
 * parameter names the gateway reads off its source (it reads each argument by the name of the method's parameter), and what
 * the page calls must be what the server serves.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { jsonCodec, remoteContribution, RESERVED_REMOTE_METHODS } from 'dish-kit/client'
import { runsRemote } from '../src/client/remote.ts'
import type { RunsApi } from '../src/client/remote.ts'
import { RunsRemote } from '../src/remote.ts'

type Same<A, B> = [A] extends [B] ? [B] extends [A] ? SameKeys<A, B> : false : false
/** Mutual assignability lets a field that is optional on one side only through: the keys of two objects must be the same too. */
type SameKeys<A, B> = [A] extends [object] ? [B] extends [object] ? ([keyof A] extends [keyof B] ? [keyof B] extends [keyof A] ? true : false : false) : true : true
type Check<T extends true> = T

/** Every call the page makes is a method of `RunsRemote`, with its parameters and its value. A change to either is a type error here. */
type Value<R> = R extends { ok: true, value: infer V } ? V : never
type Served<K extends keyof RunsApi> = Awaited<ReturnType<RunsRemote[K]>>
type Called<K extends keyof RunsApi> = Value<Awaited<ReturnType<RunsApi[K]>>>
export type CallsMatchTheServer = [
  Check<Same<Parameters<RunsApi['runs']>, Parameters<RunsRemote['runs']>>>,
  Check<Same<Parameters<RunsApi['run']>, Parameters<RunsRemote['run']>>>,
  Check<Same<Parameters<RunsApi['ledger']>, Parameters<RunsRemote['ledger']>>>,
  Check<Same<Called<'runs'>, Served<'runs'>>>,
  Check<Same<Called<'run'>, Served<'run'>>>,
  Check<Same<Called<'ledger'>, Served<'ledger'>>>,
]

/** The gateway's source-mode reading of a method's parameter names: the text between its first parentheses, split on commas. */
function parameterNames(method: (...args: never[]) => unknown): string[] {
  const source = Function.prototype.toString.call(method)
  const open = source.indexOf('(')
  const body = source.slice(open + 1, source.indexOf(')', open + 1)).trim()
  return body === '' ? [] : body.split(',').map(part => part.trim())
}

test('the descriptors list exactly the methods RunsRemote marks, no more and no fewer', () => {
  const marked = remoteMethods(Object.create(RunsRemote.prototype) as RunsRemote).map(mark => mark.method).sort()
  assert.deepEqual(marked, ['ledger', 'run', 'runs'])
  assert.deepEqual(runsRemote.descriptors.map(descriptor => descriptor.method).sort(), marked)
  assert.equal(runsRemote.package, 'dish-orchestrator')
})

test('each descriptor is a direct, plain-JSON call in the dishRuns namespace, and sends the parameters the server reads, by name', () => {
  const expected: Record<string, string[]> = {
    runs: [],
    run: ['project', 'id'],
    ledger: ['project', 'id', 'limit', 'before'],
  }
  for (const descriptor of runsRemote.descriptors) {
    const method = descriptor.method
    assert.equal(descriptor.id, `dish-orchestrator#dishRuns/${method}`)
    assert.equal(descriptor.namespace, 'dishRuns', method)
    assert.equal(descriptor.service, 'dishRuns', method)
    assert.deepEqual(descriptor.invocation, { kind: 'direct' }, method)
    assert.deepEqual(descriptor.result, { mode: 'src-json' }, method)
    assert.equal(descriptor.mode, undefined, `${method} is not a stream`)

    const sent = descriptor.parameters.map(parameter => parameter.name)
    assert.deepEqual(sent, expected[method], method)
    // The names the server's own source gives are the ones the gateway reads: the page must send those.
    const server = (RunsRemote.prototype as unknown as Record<string, (...args: never[]) => unknown>)[method]!
    assert.deepEqual(sent, parameterNames(server), `${method}: the server's parameter names`)
    for (const parameter of descriptor.parameters) {
      assert.equal(parameter.wire, parameter.name, `${method}.${parameter.name}`)
      assert.equal(parameter.source, 'json', `${method}.${parameter.name}`)
      assert.equal(parameter.codec, jsonCodec, `${method}.${parameter.name}`)
    }
  }
})

test('remoteContribution takes the descriptors: no method is named like a member of the browser\'s namespace service', () => {
  for (const descriptor of runsRemote.descriptors) assert.ok(!RESERVED_REMOTE_METHODS.includes(descriptor.method), descriptor.method)
  assert.doesNotThrow(() => remoteContribution('dish-orchestrator', [...runsRemote.descriptors]))
})
