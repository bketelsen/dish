/**
 * The page's side of the wire: the hand-written descriptors must name exactly the methods `ProjectsRemote` marks, with
 * the parameter names the gateway reads off its source (it reads each argument by the name of the method's parameter),
 * and the copies of dish-config's wire types the page keeps must be the store's own. Also what the page knows of the
 * registry (the file it watches and the defaults of a new project), which the browser can't import from `registry.ts`
 * (that reads YAML).
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { RESERVED_REMOTE_METHODS, jsonCodec } from 'dish-kit/client'
import type { FileDiff } from 'dish-kit/ui/diff'
import type { CommitInfo as StoreCommit, ConfigEvent as StoreEvent, FileDiff as StoreDiff } from '../../config/src/protocol.ts'
import type { ConfigRemote } from '../../config/src/remote.ts'
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import { NEW_FIELDS, PROJECTS_FILE } from '../src/client/controller.ts'
import type { ProjectsActions } from '../src/client/controller.ts'
import { projectsRemote } from '../src/client/remote.ts'
import type { ConfigCalls, ConfigEvent, ProjectsApi } from '../src/client/remote.ts'
import type { CommitInfo } from '../src/protocol.ts'
import { ProjectsRemote } from '../src/remote.ts'
import { PROJECTS_PATH, parseProjects, serializeProjects } from '../src/registry.ts'

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
 * The same for the page's own calls: each of `ProjectsApi`'s must take what `ProjectsRemote`'s method takes and give the same
 * value inside the `Outcome`, so a change to a server signature is a type error here and not a wrong call in the browser.
 */
type ServedBy<K extends keyof ProjectsApi> = Value<Awaited<ReturnType<ProjectsRemote[K]>>>
type CalledOn<K extends keyof ProjectsApi> = Value<Value<Awaited<ReturnType<ProjectsApi[K]>>>>
export type ApiMatchesTheProjectsRemote = [
  Check<Same<Parameters<ProjectsApi['projects']>, Parameters<ProjectsRemote['projects']>>>,
  Check<Same<Parameters<ProjectsApi['check']>, Parameters<ProjectsRemote['check']>>>,
  Check<Same<Parameters<ProjectsApi['save']>, Parameters<ProjectsRemote['save']>>>,
  Check<Same<Parameters<ProjectsApi['removeProject']>, Parameters<ProjectsRemote['removeProject']>>>,
  Check<Same<Parameters<ProjectsApi['retry']>, Parameters<ProjectsRemote['retry']>>>,
  Check<Same<CalledOn<'projects'>, ServedBy<'projects'>>>,
  Check<Same<CalledOn<'check'>, ServedBy<'check'>>>,
  Check<Same<CalledOn<'save'>, ServedBy<'save'>>>,
  Check<Same<CalledOn<'removeProject'>, ServedBy<'removeProject'>>>,
  Check<Same<CalledOn<'retry'>, ServedBy<'retry'>>>,
]

/**
 * The slot renderer lets a section's owner props win over its injected face's, and the settings shell hands every section a
 * `close` of its own (it closes Settings). A face member with that name would never reach the component, which would call the
 * shell's instead. So the face must have no member the shell's props have. (Found building the page: the face's `close`, which
 * stopped the polling, became `hide`.)
 */
export type FaceStaysClearOfTheShellsProps = [
  Check<[Extract<keyof SettingsSectionOwnerProps, keyof ProjectsActions>] extends [never] ? true : false>,
]

/** The gateway's source-mode reading of a method's parameter names: the text between its first parentheses, split on commas. */
function parameterNames(method: (...args: never[]) => unknown): string[] {
  const source = Function.prototype.toString.call(method)
  const open = source.indexOf('(')
  const body = source.slice(open + 1, source.indexOf(')', open + 1)).trim()
  return body === '' ? [] : body.split(',').map(part => part.trim())
}

test('the descriptors list exactly the methods ProjectsRemote marks, no more and no fewer', () => {
  const marked = remoteMethods(Object.create(ProjectsRemote.prototype) as ProjectsRemote).map(mark => mark.method).sort()
  assert.deepEqual(marked, ['check', 'projects', 'removeProject', 'retry', 'save'])
  assert.deepEqual(projectsRemote.descriptors.map(descriptor => descriptor.method).sort(), marked)
  assert.equal(projectsRemote.package, 'dish-projects')
})

// The method that removes a project can't be called `remove`: the gateway's namespace service has a member of that name
// and refuses to mount the method, which fails the whole plugin's load (found with dish-skills, whose method is
// `deleteSkill`). dish-kit's `remoteContribution` throws at once for such a name; this keeps the server from using one.
test('no method is named like a member of the browser\'s namespace service, which would not mount', () => {
  assert.ok(RESERVED_REMOTE_METHODS.includes('remove'))
  const served = remoteMethods(Object.create(ProjectsRemote.prototype) as ProjectsRemote).map(mark => mark.method)
  for (const method of [...served, ...projectsRemote.descriptors.map(descriptor => descriptor.method)]) {
    assert.ok(!RESERVED_REMOTE_METHODS.includes(method), `${method} is a member of the gateway's namespace service`)
    assert.ok(!(method in Object.prototype), `${method} is a member of every object`)
  }
})

test('each descriptor is a direct, plain-JSON call in the dishProjects namespace, and sends the parameters the server reads, by name', () => {
  const expected: Record<string, string[]> = {
    projects: [],
    check: ['name', 'fields', 'adding'],
    save: ['name', 'fields', 'base', 'note', 'adding'],
    removeProject: ['name', 'base', 'note'],
    retry: ['name'],
  }
  for (const descriptor of projectsRemote.descriptors) {
    const method = descriptor.method
    assert.equal(descriptor.id, `dish-projects#dishProjects/${method}`)
    assert.equal(descriptor.namespace, 'dishProjects', method)
    assert.equal(descriptor.service, 'dishProjects', method)
    assert.deepEqual(descriptor.invocation, { kind: 'direct' }, method)
    assert.deepEqual(descriptor.result, { mode: 'src-json' }, method)
    assert.equal(descriptor.mode, undefined, `${method} is not a stream`)

    const sent = descriptor.parameters.map(parameter => parameter.name)
    assert.deepEqual(sent, expected[method], method)
    // The names the server's own source gives are the ones the gateway reads: the page must send those.
    const server = (ProjectsRemote.prototype as unknown as Record<string, (...args: never[]) => unknown>)[method]!
    assert.deepEqual(sent, parameterNames(server), `${method}: the server's parameter names`)
    for (const parameter of descriptor.parameters) {
      assert.equal(parameter.wire, parameter.name, `${method}.${parameter.name}`)
      assert.equal(parameter.source, 'json', `${method}.${parameter.name}`)
      assert.equal(parameter.codec, jsonCodec, `${method}.${parameter.name}`)
    }
  }
})

test('the page watches the file the registry lives in', () => {
  assert.equal(PROJECTS_FILE, PROJECTS_PATH)
})

test('a new project\'s form starts with settings the registry takes once the rest is filled in', () => {
  const fields = { ...NEW_FIELDS, family: 'acme', role: 'the widget', gate: 'pnpm test' }
  const parsed = parseProjects(serializeProjects({ 'acme/widget': { family: fields.family, role: fields.role, gate: fields.gate, gateTimeout: fields.gateTimeout } }))
  assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.problem)
  // The empty ones are the optional ones, which the form leaves out of the file as `''`.
  assert.equal(NEW_FIELDS.setup, '')
  assert.equal(NEW_FIELDS.setupTimeout, '')
  assert.deepEqual(NEW_FIELDS.gateEnv, {})
})
