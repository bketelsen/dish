/**
 * What the page says when a call does not simply succeed: the store's refusals in plain language, with the store's own
 * message kept as detail. Plain TypeScript with no DOM or React in it, so `node --test` can load it.
 * @module dish-config/client/outcome
 */

import type { ErrorCode } from '../protocol.ts'

/** One line for the person, and what the store itself said, when that adds something. */
export interface Notice {
  text: string
  detail?: string
}

/** Said on a stale proposal, beside the disabled Accept and as the result of an accept the store refuses as `STALE`. */
export const STALE_TEXT = 'Stale: main changed since this was proposed — the agent will rebuild it'

/** A revert that came back `null`: the commit was undone already. */
export const NOTHING_TO_REVERT = 'Already reverted — nothing to do'

/** An accept that came back `null`: `main` already has all of the proposal. */
export const NOTHING_TO_ACCEPT = 'Main already has this — nothing to do'

/** What the person was doing when the store refused, for the codes whose remedy depends on it. */
export type Action = 'revert' | 'accept' | 'reject'

/**
 * What a store refusal (`{ ok: false, code, message }`) is called. A code with no wording of its own reads `<code>: <message>`.
 * @param action - what was being done. A `CONFLICT` on a revert means a later commit touched the same files, which
 *   reloading does not help; on anything else it means what the page showed is out of date.
 */
export function failureNotice(code: ErrorCode, message: string, action?: Action): Notice {
  switch (code) {
    case 'CONFLICT':
      return action === 'revert'
        ? { text: 'A later change touched the same files — revert that change first, or edit the files directly.', detail: message }
        : { text: 'This changed since you loaded it — reload and try again', detail: message }
    case 'STALE': return { text: STALE_TEXT, detail: message }
    case 'NOT_FOUND': return { text: 'Not found (it may have been accepted or rejected elsewhere)', detail: message }
    default: return { text: `${code}: ${message}` }
  }
}

/**
 * What a call that failed for a reason other than a store refusal is called: the Remote's own failure (a carrier that
 * is down, the gateway's `internal`), or anything thrown.
 * @param failure - the `RemoteResult`'s error, or what was thrown.
 */
export function unexpectedNotice(failure: unknown): Notice {
  const text = 'Something went wrong talking to dish-config'
  const detail = describe(failure)
  return detail === '' ? { text } : { text, detail }
}

function describe(failure: unknown): string {
  if (typeof failure === 'string') return failure
  if (typeof failure === 'object' && failure !== null && 'message' in failure && typeof failure.message === 'string') return failure.message
  return ''
}
