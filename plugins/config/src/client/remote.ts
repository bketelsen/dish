/**
 * The browser's view of `ConfigRemote`, written by hand: dsh generates these descriptors for in-tree packages, but the
 * generator is not published.
 *
 * Every method is served through the gateway's source-mode fallback, which answers with plain JSON (`src-json`) and
 * reads each argument off the wire by the name of the method's parameter, so the names here are the server's
 * (`plugins/config/src/remote.ts`). Every parameter is JSON, with `''` meaning absent.
 */

import type {
  InvocationDescriptor, InvocationParameterDescriptor, RemoteResult, RemoteStreamHandle, TypertRemoteContribution,
} from '@deepseek-ai/dsh-typert-protocol'
import { jsonCodec, remoteContribution, remoteDescriptor } from 'dish-kit/client'
import type { FileDiff as KitFileDiff } from 'dish-kit/ui'
import {
  NAMESPACE, type CommitInfo, type ConfigEvent, type FileDiff, type NamespaceInfo, type Outcome, type ProposalInfo, type RemoteStatus,
} from '../protocol.ts'

// `DiffView` is dish-kit's, and dish-kit does not depend on dish-config, so it declares a `FileDiff` of its own. The page hands
// it the store's: this fails to compile if the two shapes ever differ.
type Same<A, B> = [A] extends [B] ? [B] extends [A] ? SameKeys<A, B> : false : false
/** Mutual assignability lets a field that is optional on one side only through: the keys of two objects must be the same too. */
type SameKeys<A, B> = [A] extends [object] ? [B] extends [object] ? ([keyof A] extends [keyof B] ? [keyof B] extends [keyof A] ? true : false : false) : true : true
type Check<T extends true> = T
export type DiffViewTakesStoreDiffs = Check<Same<FileDiff, KitFileDiff>>

/**
 * What the page calls. Every call but `namespaces` and `watch` resolves to `Outcome<...>` inside the gateway's
 * `RemoteResult`: the outer one is the carrier's (offline, an internal fault), the inner one the store's (a conflict, a stale
 * proposal, an unknown id).
 */
export interface ConfigApi {
  namespaces(): Promise<RemoteResult<NamespaceInfo[]>>
  history(prefix: string, limit: number, before: string): Promise<RemoteResult<Outcome<CommitInfo[]>>>
  commit(id: string): Promise<RemoteResult<Outcome<{ info: CommitInfo, diffs: FileDiff[] }>>>
  revert(id: string): Promise<RemoteResult<Outcome<CommitInfo | null>>>
  proposals(status: string): Promise<RemoteResult<Outcome<ProposalInfo[]>>>
  proposal(id: string): Promise<RemoteResult<Outcome<{ info: ProposalInfo, diffs: FileDiff[] }>>>
  accept(id: string): Promise<RemoteResult<Outcome<CommitInfo | null>>>
  reject(id: string, reason: string): Promise<RemoteResult<Outcome<null>>>
  remoteStatus(): Promise<RemoteResult<Outcome<RemoteStatus>>>
  watch(signal?: AbortSignal): RemoteStreamHandle<ConfigEvent, never>
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespaceMap {
    dishConfig: ConfigApi
  }
}

const parameter = (name: string): InvocationParameterDescriptor => ({ name, wire: name, source: 'json', codec: jsonCodec })

const descriptor = (method: string, parameters: string[] = [], extra: Partial<InvocationDescriptor> = {}) =>
  remoteDescriptor('dish-config', NAMESPACE, method, { parameters: parameters.map(parameter), ...extra })

export const configRemote: TypertRemoteContribution = remoteContribution('dish-config', [
  descriptor('namespaces'),
  descriptor('history', ['prefix', 'limit', 'before']),
  descriptor('commit', ['id']),
  descriptor('revert', ['id']),
  descriptor('proposals', ['status']),
  descriptor('proposal', ['id']),
  descriptor('accept', ['id']),
  descriptor('reject', ['id', 'reason']),
  descriptor('remoteStatus'),
  descriptor('watch', [], { mode: 'stream', cancellation: { parameter: 'signal' } }),
])
