/**
 * The card's side of the wire: the hand-written descriptors must name exactly the methods `WorkspacesRemote` marks, with the
 * parameter names the gateway reads off its source (it reads each argument by the name of the method's parameter), and the
 * copy of dsh's credentials wire that the card keeps must be dsh's. Also what the card must not do: no call of its own may
 * carry the App's ID or its key, and its face must stay clear of the settings shell's props.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import type { CredentialInfo } from '@deepseek-ai/dsh-credentials/types'
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import { RESERVED_REMOTE_METHODS } from 'dish-kit/client'
import type { AppCardActions } from '../src/client/controller.ts'
import { workspacesRemote } from '../src/client/remote.ts'
import type { CredentialView, CredentialsCalls, WorkspacesApi } from '../src/client/remote.ts'
import { NAMESPACE } from '../src/protocol.ts'
import { WorkspacesRemote } from '../src/remote.ts'

// What the card believes of the wires it doesn't own is checked here, where Node's types and the others' are both in reach:
// this fails to compile if either side changes.
type Same<A, B> = [A] extends [B] ? [B] extends [A] ? SameKeys<A, B> : false : false
/** Mutual assignability lets a field that is optional on one side only through: the keys of two objects must be the same too. */
type SameKeys<A, B> = [A] extends [object] ? [B] extends [object] ? ([keyof A] extends [keyof B] ? [keyof B] extends [keyof A] ? true : false : false) : true : true
type Check<T extends true> = T

/** dsh's own view of a credential: the card's copy of it has the same fields, and none that could hold a value. */
export type CredentialViewMatchesDsh = [
  Check<Same<CredentialView, CredentialInfo>>,
]

/** The card's calls on dsh's credentials remote, as dsh's own: strings in, and no value out of `set` or `unset`. */
export type CredentialsCallsShape = [
  Check<Same<Parameters<CredentialsCalls['describe']>, [refs: string[]]>>,
  Check<Same<Parameters<CredentialsCalls['set']>, [ref: string, value: string]>>,
  Check<Same<Parameters<CredentialsCalls['unset']>, [ref: string]>>,
]

/**
 * The card's own calls must be what `WorkspacesRemote`'s methods take and give: no parameters, and the same status inside
 * the gateway's `RemoteResult`. A change to a server signature is a type error here and not a wrong call in the browser.
 */
type Value<R> = R extends { ok: true, value: infer V } ? V : never
export type ApiMatchesTheRemote = [
  Check<Same<Parameters<WorkspacesApi['status']>, Parameters<WorkspacesRemote['status']>>>,
  Check<Same<Parameters<WorkspacesApi['test']>, Parameters<WorkspacesRemote['test']>>>,
  Check<Same<Value<Awaited<ReturnType<WorkspacesApi['status']>>>, Awaited<ReturnType<WorkspacesRemote['status']>>>>,
  Check<Same<Value<Awaited<ReturnType<WorkspacesApi['test']>>>, Awaited<ReturnType<WorkspacesRemote['test']>>>>,
]

/**
 * The slot renderer lets a section's owner props win over its injected face's, and the settings shell hands every section a
 * `close` of its own (it closes Settings). A face member with that name would never reach the component, which would call the
 * shell's instead. So the face must have no member the shell's props have. (Found building the Projects page: the face's
 * `close`, which stopped the polling, became `hide`.)
 */
export type FaceStaysClearOfTheShellsProps = [
  Check<[Extract<keyof SettingsSectionOwnerProps, keyof AppCardActions>] extends [never] ? true : false>,
]

/** The gateway's source-mode reading of a method's parameter names: the text between its first parentheses, split on commas. */
function parameterNames(method: (...args: never[]) => unknown): string[] {
  const source = Function.prototype.toString.call(method)
  const open = source.indexOf('(')
  const body = source.slice(open + 1, source.indexOf(')', open + 1)).trim()
  return body === '' ? [] : body.split(',').map(part => part.trim())
}

test('the descriptors list exactly the methods WorkspacesRemote marks, no more and no fewer', () => {
  const marked = remoteMethods(Object.create(WorkspacesRemote.prototype) as WorkspacesRemote).map(mark => mark.method).sort()
  assert.deepEqual(marked, ['status', 'test'])
  assert.deepEqual(workspacesRemote.descriptors.map(descriptor => descriptor.method).sort(), marked)
  assert.equal(workspacesRemote.package, 'dish-workspaces')
})

// A method named like a member of the browser's namespace service (`remove`, `has`, `name`, ...) can't be mounted, which fails
// the whole plugin's load. dish-kit's `remoteContribution` throws at once for such a name; this keeps the server from using one.
test('no method is named like a member of the browser\'s namespace service, which would not mount', () => {
  assert.ok(RESERVED_REMOTE_METHODS.includes('remove'))
  const served = remoteMethods(Object.create(WorkspacesRemote.prototype) as WorkspacesRemote).map(mark => mark.method)
  for (const method of [...served, ...workspacesRemote.descriptors.map(descriptor => descriptor.method)]) {
    assert.ok(!RESERVED_REMOTE_METHODS.includes(method), `${method} is a member of the gateway's namespace service`)
    assert.ok(!(method in Object.prototype), `${method} is a member of every object`)
  }
})

test('each descriptor is a direct, plain-JSON call in the dishWorkspaces namespace that sends no parameter', () => {
  for (const descriptor of workspacesRemote.descriptors) {
    const method = descriptor.method
    assert.equal(descriptor.id, `dish-workspaces#dishWorkspaces/${method}`)
    assert.equal(descriptor.namespace, NAMESPACE, method)
    assert.equal(descriptor.service, NAMESPACE, method)
    assert.deepEqual(descriptor.invocation, { kind: 'direct' }, method)
    assert.deepEqual(descriptor.result, { mode: 'src-json' }, method)
    assert.equal(descriptor.mode, undefined, `${method} is not a stream`)
    // Nothing the card sends to this remote could be the App's ID or its key: there is nothing it sends.
    assert.deepEqual(descriptor.parameters, [], method)
    const server = (WorkspacesRemote.prototype as unknown as Record<string, (...args: never[]) => unknown>)[method]!
    assert.deepEqual(parameterNames(server), [], `${method}: the server's parameter names`)
  }
})

test('the card keeps the key in a text area it never fills back, and takes no string for markup', () => {
  // A PEM is lines: a one-line input would drop its breaks, and the next save would send that. The textarea is the key's, the
  // input the ID's; neither is given a value but what the person typed (`field.input`).
  const card = readFileSync(fileURLToPath(new URL('../src/client/AppCard.tsx', import.meta.url)), 'utf8')
  assert.equal((card.match(/<textarea/g) ?? []).length, 1, 'one text area, for the key')
  assert.equal((card.match(/<Input/g) ?? []).length, 1, 'one input, for the ID')
  assert.equal((card.match(/\bvalue=\{field\.input\}/g) ?? []).length, 2, 'a field shows what was typed in it, nothing else')
  assert.ok(!/dangerouslySetInnerHTML|innerHTML|insertAdjacentHTML|outerHTML/.test(card), 'a string is never taken for markup')
  for (const file of ['AppCard.tsx', 'index.tsx', 'controller.ts', 'input.ts']) {
    const source = readFileSync(fileURLToPath(new URL(`../src/client/${file}`, import.meta.url)), 'utf8')
    assert.ok(!/localStorage|sessionStorage|indexedDB|document\.cookie/.test(source), `${file} stores nothing in the browser`)
    assert.ok(!/console\.(log|info|warn|error|debug)/.test(source), `${file} logs nothing`)
  }
})
