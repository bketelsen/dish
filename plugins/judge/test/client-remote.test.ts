/**
 * The page's side of the wire: the hand-written descriptors must name exactly the methods `JudgeRemote` marks, with the
 * parameter names the gateway reads off its source (it reads each argument by the name of the method's parameter), and the
 * copies of dish-config's and dsh's wire types the page keeps must be theirs.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import type { CredentialInfo } from '@deepseek-ai/dsh-credentials/types'
import { jsonCodec } from 'dish-kit/client'
import type { FileDiff } from 'dish-kit/ui/diff'
import type { CommitInfo as StoreCommit, ConfigEvent as StoreEvent, FileDiff as StoreDiff } from '../../config/src/protocol.ts'
import type { ConfigRemote } from '../../config/src/remote.ts'
import { judgeRemote } from '../src/client/remote.ts'
import type { ConfigCalls, ConfigEvent, CredentialView, CredentialsCalls, JudgeApi } from '../src/client/remote.ts'
import type { CommitInfo } from '../src/protocol.ts'
import { JudgeRemote } from '../src/remote.ts'

// What the page believes of the wires it doesn't own is checked here, where Node's types and the others' are both in reach:
// this fails to compile if either side changes.
type Same<A, B> = [A] extends [B] ? [B] extends [A] ? true : false : false
type Check<T extends true> = T
export type PageMatchesStore = [
  Check<Same<ConfigEvent, StoreEvent>>,
  Check<Same<CommitInfo, StoreCommit>>,
  Check<Same<FileDiff, StoreDiff>>,
]

/** dsh's own view of a credential: the page's copy of it has the same fields, and none that could hold a value. */
export type CredentialViewMatchesDsh = [
  Check<Same<CredentialView, CredentialInfo>>,
]

/**
 * What the page calls of dish-config's remote must be what that remote's methods take and give: the same parameters, and the
 * same value inside the `Outcome` (the page's own `Outcome` has more codes, which dish-config never says, so the value is
 * compared and not the whole). A change to `ConfigRemote`'s signature is a type error here.
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

/** The same for the page's own remote: every call the page makes is a method of `JudgeRemote`, with its parameters and its value. */
type ServedByJudge<K extends keyof JudgeApi> = K extends 'status'
  ? Awaited<ReturnType<JudgeRemote['status']>>
  : Value<Awaited<ReturnType<JudgeRemote[K]>>>
type CalledOfJudge<K extends keyof JudgeApi> = K extends 'status'
  ? Value<Awaited<ReturnType<JudgeApi['status']>>>
  : Value<Value<Awaited<ReturnType<JudgeApi[K]>>>>
export type JudgeCallsMatchTheServer = [
  Check<Same<Parameters<JudgeApi['status']>, Parameters<JudgeRemote['status']>>>,
  Check<Same<Parameters<JudgeApi['test']>, Parameters<JudgeRemote['test']>>>,
  Check<Same<Parameters<JudgeApi['thresholds']>, Parameters<JudgeRemote['thresholds']>>>,
  Check<Same<Parameters<JudgeApi['saveThresholds']>, Parameters<JudgeRemote['saveThresholds']>>>,
  Check<Same<Parameters<JudgeApi['log']>, Parameters<JudgeRemote['log']>>>,
  Check<Same<Parameters<JudgeApi['withheld']>, Parameters<JudgeRemote['withheld']>>>,
  Check<Same<CalledOfJudge<'status'>, ServedByJudge<'status'>>>,
  Check<Same<CalledOfJudge<'test'>, ServedByJudge<'test'>>>,
  Check<Same<CalledOfJudge<'thresholds'>, ServedByJudge<'thresholds'>>>,
  Check<Same<CalledOfJudge<'saveThresholds'>, ServedByJudge<'saveThresholds'>>>,
  Check<Same<CalledOfJudge<'log'>, ServedByJudge<'log'>>>,
  Check<Same<CalledOfJudge<'withheld'>, ServedByJudge<'withheld'>>>,
]

/** The key card's calls, as dsh's own are: strings in, and no value out of `set` or `unset`. */
export type CredentialsCallsShape = [
  Check<Same<Parameters<CredentialsCalls['describe']>, [refs: string[]]>>,
  Check<Same<Parameters<CredentialsCalls['set']>, [ref: string, value: string]>>,
  Check<Same<Parameters<CredentialsCalls['unset']>, [ref: string]>>,
]

/** The gateway's source-mode reading of a method's parameter names: the text between its first parentheses, split on commas. */
function parameterNames(method: (...args: never[]) => unknown): string[] {
  const source = Function.prototype.toString.call(method)
  const open = source.indexOf('(')
  const body = source.slice(open + 1, source.indexOf(')', open + 1)).trim()
  return body === '' ? [] : body.split(',').map(part => part.trim())
}

test('the descriptors list exactly the methods JudgeRemote marks, no more and no fewer', () => {
  const marked = remoteMethods(Object.create(JudgeRemote.prototype) as JudgeRemote).map(mark => mark.method).sort()
  assert.deepEqual(marked, ['log', 'saveThresholds', 'status', 'test', 'thresholds', 'withheld'])
  assert.deepEqual(judgeRemote.descriptors.map(descriptor => descriptor.method).sort(), marked)
  assert.equal(judgeRemote.package, 'dish-judge')
})

test('each descriptor is a direct, plain-JSON call in the dishJudge namespace, and sends the parameters the server reads, by name', () => {
  const expected: Record<string, string[]> = {
    status: [],
    test: [],
    thresholds: [],
    saveThresholds: ['settings', 'base', 'note'],
    log: ['purpose', 'decision', 'limit', 'before'],
    withheld: ['id'],
  }
  for (const descriptor of judgeRemote.descriptors) {
    const method = descriptor.method
    assert.equal(descriptor.id, `dish-judge#dishJudge/${method}`)
    assert.equal(descriptor.namespace, 'dishJudge', method)
    assert.equal(descriptor.service, 'dishJudge', method)
    assert.deepEqual(descriptor.invocation, { kind: 'direct' }, method)
    assert.deepEqual(descriptor.result, { mode: 'src-json' }, method)
    assert.equal(descriptor.mode, undefined, `${method} is not a stream`)

    const sent = descriptor.parameters.map(parameter => parameter.name)
    assert.deepEqual(sent, expected[method], method)
    // The names the server's own source gives are the ones the gateway reads: the page must send those.
    const server = (JudgeRemote.prototype as unknown as Record<string, (...args: never[]) => unknown>)[method]!
    assert.deepEqual(sent, parameterNames(server), `${method}: the server's parameter names`)
    for (const parameter of descriptor.parameters) {
      assert.equal(parameter.wire, parameter.name, `${method}.${parameter.name}`)
      assert.equal(parameter.source, 'json', `${method}.${parameter.name}`)
      assert.equal(parameter.codec, jsonCodec, `${method}.${parameter.name}`)
    }
  }
})

test('no descriptor of the page\'s own remote has a parameter that could carry a key', () => {
  for (const descriptor of judgeRemote.descriptors) {
    for (const parameter of descriptor.parameters) assert.doesNotMatch(parameter.name, /key|token|secret|credential|password/i, `${descriptor.method}.${parameter.name}`)
  }
})
