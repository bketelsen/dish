/**
 * What the page says when a call does not simply succeed: the server's refusals with its own message, and a call that failed
 * on the way. Plain TypeScript with no DOM or React in it, so `node --test` can load it.
 * @module dish-orchestrator/client/outcome
 */

import type { ErrorCode } from '../protocol.ts'

/** One line for the person, and what the server itself said, when that adds something. */
export interface Notice {
  text: string
  detail?: string
}

/** What a refusal (`{ ok: false, code, message }`) is called, with the server's message beneath it. */
export function failureNotice(code: ErrorCode, message: string): Notice {
  switch (code) {
    case 'NOT_FOUND':
      return { text: 'That run isn\'t there. Its record may have been set aside as unreadable.', detail: message }
    case 'INVALID':
      return { text: 'The page asked for something that isn\'t a run or a page of its ledger.', detail: message }
    default:
      return { text: `${String(code)}: ${message}` }
  }
}

/**
 * What a call that failed for a reason other than a refusal is called: the Remote's own failure (a carrier that is down, the
 * gateway's `internal`), or anything thrown.
 * @param failure - the `RemoteResult`'s error, or what was thrown.
 */
export function unexpectedNotice(failure: unknown, remote = 'dish-orchestrator'): Notice {
  const text = `Something went wrong talking to ${remote}`
  const detail = describe(failure)
  return detail === '' ? { text } : { text, detail }
}

function describe(failure: unknown): string {
  if (typeof failure === 'string') return failure
  if (typeof failure === 'object' && failure !== null && 'message' in failure && typeof failure.message === 'string') return failure.message
  return ''
}
