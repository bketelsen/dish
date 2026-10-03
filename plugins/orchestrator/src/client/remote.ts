/**
 * The browser's view of `RunsRemote`, written by hand: dsh generates these descriptors for in-tree packages, but the
 * generator is not published.
 *
 * Every method is served through the gateway's source-mode fallback, which answers with plain JSON (`src-json`) and reads
 * each argument off the wire by the name of the method's parameter, so the names here are the server's
 * (`plugins/orchestrator/src/remote.ts`; `test/client-remote.test.ts` compares the two). Every parameter is JSON, with `''`
 * and `0` meaning absent.
 *
 * **Read only.** The three calls read; there is none that changes a run.
 */

import type { InvocationDescriptor, InvocationParameterDescriptor, RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { jsonCodec, remoteContribution, remoteDescriptor } from 'dish-kit/client'
import { NAMESPACE, type LedgerPage, type Outcome, type RunDetail, type RunRow } from '../protocol.ts'

/**
 * What the page calls on `dishRuns`. `run` and `ledger` resolve to `Outcome<...>` inside the gateway's `RemoteResult`: the
 * outer one is the carrier's (offline, an internal fault), the inner one the server's (a project or an id that isn't one, a
 * run that isn't there).
 */
export interface RunsApi {
  runs(): Promise<RemoteResult<RunRow[]>>
  run(project: string, id: string): Promise<RemoteResult<Outcome<RunDetail>>>
  ledger(project: string, id: string, limit: number, before: string): Promise<RemoteResult<Outcome<LedgerPage>>>
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespaceMap {
    dishRuns: RunsApi
  }
}

const parameter = (name: string): InvocationParameterDescriptor => ({ name, wire: name, source: 'json', codec: jsonCodec })

const descriptor = (method: string, parameters: string[] = [], extra: Partial<InvocationDescriptor> = {}) =>
  remoteDescriptor('dish-orchestrator', NAMESPACE, method, { parameters: parameters.map(parameter), ...extra })

export const runsRemote: TypertRemoteContribution = remoteContribution('dish-orchestrator', [
  descriptor('runs'),
  descriptor('run', ['project', 'id']),
  descriptor('ledger', ['project', 'id', 'limit', 'before']),
])
