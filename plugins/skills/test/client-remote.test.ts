/**
 * The page's side of the wire: the hand-written descriptors must name exactly the methods `SkillsRemote` marks, with the
 * parameter names the gateway reads off its source (it reads each argument by the name of the method's parameter), and
 * the copies of dish-config's wire types the page keeps must be the store's own. Also the page's copy of the skill-name
 * grammar, which the browser can't import from `skill.ts` (that reads YAML).
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { jsonCodec } from 'dish-kit/client'
import type { FileDiff } from 'dish-kit/ui/diff'
import type { CommitInfo as StoreCommit, ConfigEvent as StoreEvent, FileDiff as StoreDiff } from '../../config/src/protocol.ts'
import type { ConfigRemote } from '../../config/src/remote.ts'
import { MAX_SKILL_NAME, SKILL_NAME_PATTERN, nameProblem } from '../src/client/names.ts'
import { skillsRemote } from '../src/client/remote.ts'
import type { ConfigCalls, ConfigEvent, SkillsApi } from '../src/client/remote.ts'
import type { CommitInfo } from '../src/protocol.ts'
import { SkillsRemote } from '../src/remote.ts'
import { MAX_NAME, SKILL_NAME } from '../src/skill.ts'

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

/**
 * The same for the page's own calls: each of `SkillsApi`'s must take what `SkillsRemote`'s method takes and give the same
 * value inside the `Outcome`, so a change to a server signature is a type error here and not a wrong call in the browser.
 */
type ServedBy<K extends keyof SkillsApi> = Value<Awaited<ReturnType<SkillsRemote[K]>>>
type CalledOn<K extends keyof SkillsApi> = Value<Value<Awaited<ReturnType<SkillsApi[K]>>>>
export type ApiMatchesTheSkillsRemote = [
  Check<Same<Parameters<SkillsApi['skills']>, Parameters<SkillsRemote['skills']>>>,
  Check<Same<Parameters<SkillsApi['read']>, Parameters<SkillsRemote['read']>>>,
  Check<Same<Parameters<SkillsApi['check']>, Parameters<SkillsRemote['check']>>>,
  Check<Same<Parameters<SkillsApi['save']>, Parameters<SkillsRemote['save']>>>,
  Check<Same<Parameters<SkillsApi['reset']>, Parameters<SkillsRemote['reset']>>>,
  Check<Same<Parameters<SkillsApi['deleteSkill']>, Parameters<SkillsRemote['deleteSkill']>>>,
  Check<Same<CalledOn<'skills'>, ServedBy<'skills'>>>,
  Check<Same<CalledOn<'read'>, ServedBy<'read'>>>,
  Check<Same<CalledOn<'check'>, ServedBy<'check'>>>,
  Check<Same<CalledOn<'save'>, ServedBy<'save'>>>,
  Check<Same<CalledOn<'reset'>, ServedBy<'reset'>>>,
  Check<Same<CalledOn<'deleteSkill'>, ServedBy<'deleteSkill'>>>,
]

/** The gateway's source-mode reading of a method's parameter names: the text between its first parentheses, split on commas. */
function parameterNames(method: (...args: never[]) => unknown): string[] {
  const source = Function.prototype.toString.call(method)
  const open = source.indexOf('(')
  const body = source.slice(open + 1, source.indexOf(')', open + 1)).trim()
  return body === '' ? [] : body.split(',').map(part => part.trim())
}

test('the descriptors list exactly the methods SkillsRemote marks, no more and no fewer', () => {
  const marked = remoteMethods(Object.create(SkillsRemote.prototype) as SkillsRemote).map(mark => mark.method).sort()
  assert.deepEqual(marked, ['check', 'deleteSkill', 'read', 'reset', 'save', 'skills'])
  assert.deepEqual(skillsRemote.descriptors.map(descriptor => descriptor.method).sort(), marked)
  assert.equal(skillsRemote.package, 'dish-skills')
})

/**
 * What the browser's namespace service already has: the gateway mounts each descriptor as a method of one Cordis service
 * per namespace (`RemoteNamespaceService` in `@deepseek-ai/dsh-api-gateway/client`, which isn't exported) and refuses, as
 * "conflicts with its namespace service", a method named like one of its members, which fails the whole plugin's load. This
 * is that class's fields and methods in 0.2.0-rc.2, copied; anything an object has (`toString`) is refused the same way.
 * It was found live: the method that deletes a skill was first called `remove`, one of these, and the page never mounted.
 */
const NAMESPACE_SERVICE_MEMBERS = [
  'ctx', 'empty', 'invokeRemote', 'methods', 'name', 'namespace',
  'assertMethodAvailable', 'has', 'install', 'installDirect', 'installScoped', 'remove',
]

test('no method is named like a member of the browser\'s namespace service, which would not mount', () => {
  for (const descriptor of skillsRemote.descriptors) {
    const method = descriptor.method
    assert.ok(!NAMESPACE_SERVICE_MEMBERS.includes(method), `${method} is a member of the gateway's namespace service`)
    assert.ok(!(method in Object.prototype), `${method} is a member of every object`)
  }
})

test('each descriptor is a direct, plain-JSON call in the dishSkills namespace, and sends the parameters the server reads, by name', () => {
  const expected: Record<string, string[]> = {
    skills: [],
    read: ['name'],
    check: ['name', 'text'],
    save: ['name', 'text', 'base', 'note'],
    reset: ['name', 'base', 'note'],
    deleteSkill: ['name', 'base', 'note'],
  }
  for (const descriptor of skillsRemote.descriptors) {
    const method = descriptor.method
    assert.equal(descriptor.id, `dish-skills#dishSkills/${method}`)
    assert.equal(descriptor.namespace, 'dishSkills', method)
    assert.equal(descriptor.service, 'dishSkills', method)
    assert.deepEqual(descriptor.invocation, { kind: 'direct' }, method)
    assert.deepEqual(descriptor.result, { mode: 'src-json' }, method)
    assert.equal(descriptor.mode, undefined, `${method} is not a stream`)

    const sent = descriptor.parameters.map(parameter => parameter.name)
    assert.deepEqual(sent, expected[method], method)
    // The names the server's own source gives are the ones the gateway reads: the page must send those.
    const server = (SkillsRemote.prototype as unknown as Record<string, (...args: never[]) => unknown>)[method]!
    assert.deepEqual(sent, parameterNames(server), `${method}: the server's parameter names`)
    for (const parameter of descriptor.parameters) {
      assert.equal(parameter.wire, parameter.name, `${method}.${parameter.name}`)
      assert.equal(parameter.source, 'json', `${method}.${parameter.name}`)
      assert.equal(parameter.codec, jsonCodec, `${method}.${parameter.name}`)
    }
  }
})

test('the page\'s copy of the skill-name grammar is the server\'s', () => {
  assert.equal(SKILL_NAME_PATTERN.source, SKILL_NAME.source)
  assert.equal(SKILL_NAME_PATTERN.flags, SKILL_NAME.flags)
  assert.equal(MAX_SKILL_NAME, MAX_NAME)
})

test('nameProblem: the grammar first, then the names already taken', () => {
  assert.equal(nameProblem('release-notes', ['brainstorming']), undefined)
  assert.equal(nameProblem('a', []), undefined)
  assert.equal(nameProblem('x'.repeat(MAX_NAME), []), undefined)
  assert.match(nameProblem('', []) ?? '', /Give the skill a name/)
  for (const bad of ['Release', 'two words', '-lead', 'trail-', 'dou--ble', 'under_score', 'sl/ash', 'ünï', 'x'.repeat(MAX_NAME + 1)]) {
    assert.match(nameProblem(bad, []) ?? '', /isn't a valid skill name/, bad)
  }
  assert.match(nameProblem('brainstorming', ['brainstorming']) ?? '', /already a skill called "brainstorming"/)
})

test('nameProblem does not repeat a very long name in full', () => {
  const problem = nameProblem('Y'.repeat(500), []) ?? ''
  assert.ok(problem.length < 300, `${problem.length} characters`)
})
