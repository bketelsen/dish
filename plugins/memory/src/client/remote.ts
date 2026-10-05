/**
 * The browser's view of `MemoryRemote`, written by hand: dsh generates these descriptors for in-tree packages, but the
 * generator is not published.
 *
 * Every method is served through the gateway's source-mode fallback, which answers with plain JSON (`src-json`) and reads
 * each argument off the wire by the name of the method's parameter, so the names here are the server's
 * (`plugins/memory/src/remote.ts`; `test/client-remote.test.ts` compares the two). Every parameter is JSON, with `''`
 * meaning absent; `save`'s `base` `''` is a new memory. `watch` is a stream with no uplink, cancelled by its `signal`.
 *
 * The method that deletes a memory is `forget`: `remove` is a member of the browser's namespace service, which would
 * refuse to mount it.
 */

import type {
  InvocationDescriptor, InvocationParameterDescriptor, RemoteResult, RemoteStreamHandle, TypertRemoteContribution,
} from '@deepseek-ai/dsh-typert-protocol'
import { jsonCodec, remoteContribution, remoteDescriptor } from 'dish-kit/client'
import { NAMESPACE } from '../protocol.ts'
import type {
  CommitInfo, DirectionInfo, FileDiff, Memory, MemoryEvent, MemoryInfo, Outcome, RemoteStatus, ScopeInfo,
} from '../protocol.ts'

/**
 * What the page calls on `dishMemory`. Every call but `watch` resolves to `Outcome<...>` inside the gateway's
 * `RemoteResult`: the outer one is the carrier's (offline, an internal fault), the inner one the service's (a conflict, a
 * malformed memory, no config store). A scope is its key: `user` or `family:<family>`.
 */
export interface MemoryApi {
  scopes(): Promise<RemoteResult<Outcome<ScopeInfo[]>>>
  list(scope: string): Promise<RemoteResult<Outcome<MemoryInfo[]>>>
  read(scope: string, name: string): Promise<RemoteResult<Outcome<Memory | null>>>
  save(scope: string, name: string, type: string, description: string, body: string, base: string): Promise<RemoteResult<Outcome<CommitInfo>>>
  forget(scope: string, name: string, base: string): Promise<RemoteResult<Outcome<CommitInfo>>>
  release(scope: string, name: string): Promise<RemoteResult<Outcome<CommitInfo>>>
  direction(family: string): Promise<RemoteResult<Outcome<DirectionInfo>>>
  saveDirection(family: string, text: string, base: string, note: string): Promise<RemoteResult<Outcome<CommitInfo | null>>>
  /** 20 at a time: `before` is `''` for the newest page, else the last id of the page before. */
  history(scope: string, before: string): Promise<RemoteResult<Outcome<CommitInfo[]>>>
  commit(id: string): Promise<RemoteResult<Outcome<{ info: CommitInfo, diffs: FileDiff[] }>>>
  revert(id: string): Promise<RemoteResult<Outcome<CommitInfo | null>>>
  /** The message a main agent in this scope gets now; `''` with none. */
  preview(scope: string): Promise<RemoteResult<Outcome<{ text: string }>>>
  remoteStatus(): Promise<RemoteResult<Outcome<RemoteStatus>>>
  /** The vault's remote status first, then a `changed`, `direction` or `remote` whenever there is something to read again. */
  watch(signal?: AbortSignal): RemoteStreamHandle<MemoryEvent, never>
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespaceMap {
    dishMemory: MemoryApi
  }
}

const parameter = (name: string): InvocationParameterDescriptor => ({ name, wire: name, source: 'json', codec: jsonCodec })

const descriptor = (method: string, parameters: string[] = [], extra: Partial<InvocationDescriptor> = {}) =>
  remoteDescriptor('dish-memory', NAMESPACE, method, { parameters: parameters.map(parameter), ...extra })

export const memoryRemote: TypertRemoteContribution = remoteContribution('dish-memory', [
  descriptor('scopes'),
  descriptor('list', ['scope']),
  descriptor('read', ['scope', 'name']),
  descriptor('save', ['scope', 'name', 'type', 'description', 'body', 'base']),
  descriptor('forget', ['scope', 'name', 'base']),
  descriptor('release', ['scope', 'name']),
  descriptor('direction', ['family']),
  descriptor('saveDirection', ['family', 'text', 'base', 'note']),
  descriptor('history', ['scope', 'before']),
  descriptor('commit', ['id']),
  descriptor('revert', ['id']),
  descriptor('preview', ['scope']),
  descriptor('remoteStatus'),
  descriptor('watch', [], { mode: 'stream', cancellation: { parameter: 'signal' } }),
])
