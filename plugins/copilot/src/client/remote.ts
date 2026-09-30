/**
 * The browser's view of `CopilotRemote`, written by hand: dsh generates these
 * descriptors for in-tree packages, but the generator is not published.
 *
 * Every method is served through the gateway's source-mode fallback, which
 * answers with plain JSON (`src-json`). None takes a business parameter, so no
 * strict parameter codec is needed.
 */

import type {
  InvocationDescriptor, RemoteResult, RemoteStreamHandle, TypertRemoteContribution,
} from '@deepseek-ai/dsh-typert-protocol'
import { NAMESPACE, type CopilotStatus, type SignInEvent } from '../protocol.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespaceMap {
    dishCopilot: {
      status(): Promise<RemoteResult<CopilotStatus>>
      signIn(signal?: AbortSignal): RemoteStreamHandle<SignInEvent, never>
      cancel(): Promise<RemoteResult<void>>
      signOut(): Promise<RemoteResult<CopilotStatus>>
      refreshModels(): Promise<RemoteResult<CopilotStatus>>
    }
  }
}

function descriptor(method: string, extra: Partial<InvocationDescriptor> = {}): InvocationDescriptor {
  return {
    id: `dish-copilot#${NAMESPACE}/${method}`,
    service: NAMESPACE,
    namespace: NAMESPACE,
    method,
    invocation: { kind: 'direct' },
    parameters: [],
    result: { mode: 'src-json' },
    ...extra,
  }
}

export const copilotRemote: TypertRemoteContribution = {
  package: 'dish-copilot',
  descriptors: [
    descriptor('status'),
    descriptor('signIn', { mode: 'stream', cancellation: { parameter: 'signal' } }),
    descriptor('cancel'),
    descriptor('signOut'),
    descriptor('refreshModels'),
  ],
}
