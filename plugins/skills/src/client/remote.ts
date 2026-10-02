/**
 * The browser's view of `SkillsRemote`, written by hand: dsh generates these descriptors for in-tree packages, but the
 * generator is not published.
 *
 * Every method is served through the gateway's source-mode fallback, which answers with plain JSON (`src-json`) and
 * reads each argument off the wire by the name of the method's parameter, so the names here are the server's
 * (`plugins/skills/src/remote.ts`; `test/client-remote.test.ts` compares the two). Every parameter is JSON, with `''`
 * meaning absent.
 *
 * Also here: the part of dish-config's remote this page uses (its history, a commit's diff, a revert, and the `watch`
 * stream), as types. The page does not import dish-config: that is a Node package, and the browser build must not reach
 * into it. The copies are checked against dish-config's own in `test/client-remote.test.ts`.
 */

import type {
  InvocationParameterDescriptor, RemoteResult, RemoteStreamHandle, TypertRemoteContribution,
} from '@deepseek-ai/dsh-typert-protocol'
import { jsonCodec, remoteContribution, remoteDescriptor } from 'dish-kit/client'
import type { FileDiff } from 'dish-kit/ui/diff'
import { NAMESPACE } from '../protocol.ts'
import type { CheckResult, CommitInfo, Outcome, ReadResult, SkillsResult } from '../protocol.ts'

/**
 * What the page calls on `dishSkills`. Every call resolves to `Outcome<...>` inside the gateway's `RemoteResult`: the outer
 * one is the carrier's (offline, an internal fault), the inner one the store's (a conflict, an invalid document, no store).
 */
export interface SkillsApi {
  skills(): Promise<RemoteResult<Outcome<SkillsResult>>>
  read(name: string): Promise<RemoteResult<Outcome<ReadResult>>>
  check(name: string, text: string): Promise<RemoteResult<Outcome<CheckResult>>>
  save(name: string, text: string, base: string, note: string): Promise<RemoteResult<Outcome<CommitInfo | null>>>
  reset(name: string, base: string, note: string): Promise<RemoteResult<Outcome<CommitInfo | null>>>
  remove(name: string, base: string, note: string): Promise<RemoteResult<Outcome<CommitInfo | null>>>
}

/** Where dish-config's remote stands, as its `watch` reports it. */
export interface RemoteStatus {
  remote?: string
  pushed?: string
  pending: number
  lastError?: string
  lastAttempt?: number
}

/**
 * One item of dish-config's `watch` stream. Any of them means "read again": a `changed` lists the paths a commit touched,
 * a `proposal` says one was opened, went stale, or was decided.
 */
export type ConfigEvent =
  | { kind: 'changed', commit: string, paths: string[] }
  | { kind: 'proposal', id: string, status: 'open' | 'stale' | 'accepted' | 'rejected' }
  | { kind: 'remote', status: RemoteStatus }

/** The calls on dish-config's remote that the History tab makes. Its answers are `Outcome`s of the same shape as this page's own. */
export interface ConfigCalls {
  history(prefix: string, limit: number, before: string): Promise<RemoteResult<Outcome<CommitInfo[]>>>
  commit(id: string): Promise<RemoteResult<Outcome<{ info: CommitInfo, diffs: FileDiff[] }>>>
  revert(id: string): Promise<RemoteResult<Outcome<CommitInfo | null>>>
}

/** What the page uses of dish-config's remote: those calls, and the stream that says when to read again. */
export interface ConfigHistoryApi extends ConfigCalls {
  watch(signal?: AbortSignal): RemoteStreamHandle<ConfigEvent, never>
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespaceMap {
    dishSkills: SkillsApi
  }
}

const parameter = (name: string): InvocationParameterDescriptor => ({ name, wire: name, source: 'json', codec: jsonCodec })

const descriptor = (method: string, parameters: string[] = []) =>
  remoteDescriptor('dish-skills', NAMESPACE, method, { parameters: parameters.map(parameter) })

export const skillsRemote: TypertRemoteContribution = remoteContribution('dish-skills', [
  descriptor('skills'),
  descriptor('read', ['name']),
  descriptor('check', ['name', 'text']),
  descriptor('save', ['name', 'text', 'base', 'note']),
  descriptor('reset', ['name', 'base', 'note']),
  descriptor('remove', ['name', 'base', 'note']),
])
