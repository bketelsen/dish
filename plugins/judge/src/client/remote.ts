/**
 * The browser's view of `JudgeRemote`, written by hand: dsh generates these descriptors for in-tree packages, but the
 * generator is not published.
 *
 * Every method is served through the gateway's source-mode fallback, which answers with plain JSON (`src-json`) and reads
 * each argument off the wire by the name of the method's parameter, so the names here are the server's
 * (`plugins/judge/src/remote.ts`; `test/client-remote.test.ts` compares the two). Every parameter is JSON, with `''`
 * meaning absent.
 *
 * Also here, as types: the part of dish-config's remote this page uses (its history, a commit's diff, a revert, and the
 * `watch` stream), and the part of dsh's own `credentials` remote the key card uses. The page does not import dish-config:
 * that is a Node package, and the browser build must not reach into it. The copies are checked against dish-config's own in
 * `test/client-remote.test.ts`; `index.tsx` hands dsh's own remote to the controller, which the client typecheck holds to
 * `CredentialsCalls`.
 *
 * **There is no call here that takes or returns the TypeSafe key.** `credentials.set` is dsh's: the browser sends the key to
 * dsh's credential store, which is not this plugin, and nothing reads it back.
 */

import type {
  InvocationDescriptor, InvocationParameterDescriptor, RemoteResult, RemoteStreamHandle, TypertRemoteContribution,
} from '@deepseek-ai/dsh-typert-protocol'
import { jsonCodec, remoteContribution, remoteDescriptor } from 'dish-kit/client'
import type { FileDiff } from 'dish-kit/ui/diff'
import {
  NAMESPACE, type CommitInfo, type LogPage, type Outcome, type SettingsValues, type StatusInfo, type TestResult, type ThresholdsRead, type WithheldContent,
} from '../protocol.ts'

/**
 * What the page calls on `dishJudge`. Every call but `status` resolves to `Outcome<...>` inside the gateway's `RemoteResult`:
 * the outer one is the carrier's (offline, an internal fault), the inner one the server's (a conflict, a setting out of
 * range, no store).
 */
export interface JudgeApi {
  status(): Promise<RemoteResult<StatusInfo>>
  test(): Promise<RemoteResult<Outcome<TestResult>>>
  thresholds(): Promise<RemoteResult<Outcome<ThresholdsRead>>>
  saveThresholds(settings: SettingsValues, base: string, note: string): Promise<RemoteResult<Outcome<CommitInfo | null>>>
  log(purpose: string, decision: string, limit: number, before: string): Promise<RemoteResult<Outcome<LogPage>>>
  withheld(id: string): Promise<RemoteResult<Outcome<WithheldContent>>>
}

/** Whether a credential is set, and where it comes from: dsh's `CredentialInfo`, never the value. */
export interface CredentialView {
  configured: boolean
  source?: string
  writable: boolean
}

/** The calls on dsh's `credentials` remote that the key card makes. `set` sends a key to dsh and nothing comes back. */
export interface CredentialsCalls {
  describe(refs: string[]): Promise<RemoteResult<Record<string, CredentialView>>>
  set(ref: string, value: string): Promise<RemoteResult<void>>
  unset(ref: string): Promise<RemoteResult<void>>
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
    dishJudge: JudgeApi
  }
}

const parameter = (name: string): InvocationParameterDescriptor => ({ name, wire: name, source: 'json', codec: jsonCodec })

const descriptor = (method: string, parameters: string[] = [], extra: Partial<InvocationDescriptor> = {}) =>
  remoteDescriptor('dish-judge', NAMESPACE, method, { parameters: parameters.map(parameter), ...extra })

export const judgeRemote: TypertRemoteContribution = remoteContribution('dish-judge', [
  descriptor('status'),
  descriptor('test'),
  descriptor('thresholds'),
  descriptor('saveThresholds', ['settings', 'base', 'note']),
  descriptor('log', ['purpose', 'decision', 'limit', 'before']),
  descriptor('withheld', ['id']),
])
