/**
 * The browser's view of `WorkspacesRemote`, written by hand: dsh generates these descriptors for in-tree packages, but the
 * generator is not published.
 *
 * Every method is served through the gateway's source-mode fallback, which answers with plain JSON (`src-json`) and reads
 * each argument off the wire by the name of the method's parameter, so the names here are the server's
 * (`plugins/workspaces/src/remote.ts`; `test/client-remote.test.ts` compares the two). Both methods take none.
 *
 * Also here, as types: the part of dsh's own `credentials` remote the card uses (`describe`, `set` and `unset`). The copy is
 * checked against dsh's own in `test/client-remote.test.ts`; `index.tsx` hands dsh's own remote to the controller, which the
 * client typecheck holds to `CredentialsCalls`.
 *
 * **There is no call here that takes or returns the App's ID or its private key.** `credentials.set` is dsh's: the browser
 * sends them to dsh's credential store, which is not this plugin, and nothing reads them back.
 */

import type { InvocationDescriptor, RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { remoteContribution, remoteDescriptor } from 'dish-kit/client'
import { NAMESPACE, type AppStatus } from '../protocol.ts'

/**
 * What the card calls on `dishWorkspaces`. The answer is inside the gateway's `RemoteResult`: its failure is the carrier's
 * (offline, an internal fault). A test that could not go through is an `error` in the `AppStatus`, not a failure.
 */
export interface WorkspacesApi {
  status(): Promise<RemoteResult<AppStatus>>
  test(): Promise<RemoteResult<AppStatus>>
}

/** Whether a credential is set, and where it comes from: dsh's `CredentialInfo`, never the value. */
export interface CredentialView {
  configured: boolean
  source?: string
  writable: boolean
}

/** The calls on dsh's `credentials` remote that the card makes. `set` sends a value to dsh and nothing comes back. */
export interface CredentialsCalls {
  describe(refs: string[]): Promise<RemoteResult<Record<string, CredentialView>>>
  set(ref: string, value: string): Promise<RemoteResult<void>>
  unset(ref: string): Promise<RemoteResult<void>>
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespaceMap {
    dishWorkspaces: WorkspacesApi
  }
}

const descriptor = (method: string, extra: Partial<InvocationDescriptor> = {}) =>
  remoteDescriptor('dish-workspaces', NAMESPACE, method, extra)

export const workspacesRemote: TypertRemoteContribution = remoteContribution('dish-workspaces', [
  descriptor('status'),
  descriptor('test'),
])
