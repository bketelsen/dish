/**
 * The browser's view of `BrowserRemote`, written by hand: dsh generates these descriptors for in-tree packages, but the
 * generator is not published.
 *
 * One method, `watch(sessionId, signal)`, a stream with an uplink. It is served through the gateway's source-mode fallback,
 * which reads each argument off the wire by the name of the method's parameter, so the name here is the server's
 * (`src/remote.ts`; `test/client-remote.test.ts` compares the two). It is `sessionId`, not `session`: dsh resolves a parameter
 * named `session` (or `agent`, or `workspaceFileScope`) to an object. The uplink carries the tab's input as plain JSON
 * (`Up`), which the host checks item by item.
 */

import type { InvocationParameterDescriptor, RemoteStreamHandle, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { jsonCodec, remoteContribution, remoteDescriptor } from 'dish-kit/client'
import { NAMESPACE } from '../protocol.ts'
import type { Down, Up } from '../protocol.ts'

/** What the tab calls on `dishBrowser`. Calling `watch` opens one generation of the stream; its handle carries the uplink. */
export interface BrowserApi {
  watch(sessionId: string, signal?: AbortSignal): RemoteStreamHandle<Down, Up>
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespaceMap {
    dishBrowser: BrowserApi
  }
}

const parameter = (name: string): InvocationParameterDescriptor => ({ name, wire: name, source: 'json', codec: jsonCodec })

export const browserRemote: TypertRemoteContribution = remoteContribution('dish-browser', [
  remoteDescriptor('dish-browser', NAMESPACE, 'watch', {
    parameters: [parameter('sessionId')],
    mode: 'stream',
    cancellation: { parameter: 'signal' },
    uplink: { codec: jsonCodec },
  }),
])
