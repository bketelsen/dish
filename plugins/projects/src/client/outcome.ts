/**
 * What the page says when a call does not simply succeed: the store's refusals in plain language, with the store's own
 * message kept as detail where it adds something. Plain TypeScript with no DOM or React in it, so `node --test` can load it.
 * @module dish-projects/client/outcome
 */

import type { ErrorCode } from '../protocol.ts'

/** One line for the person, and what the store itself said, when that adds something. */
export interface Notice {
  text: string
  detail?: string
}

/** What the person was doing when the call was refused, for the codes whose remedy depends on it. */
export type Action = 'save' | 'remove' | 'retry'

/** What the person was doing, as a verb, for the refusals that say "can't <verb>". */
const VERB: Record<Action, string> = { save: 'save', remove: 'remove', retry: 'retry' }

/**
 * What a refusal (`{ ok: false, code, message }`) is called. A code with no wording of its own (`STALE`, which the page
 * never causes) reads `<code>: <message>`.
 * @param action - what was being done. A `CONFLICT` on a save means what the page loaded is out of date, and the form is
 *   safe; on a remove it means the registry changed, so nothing was removed.
 */
export function failureNotice(code: ErrorCode, message: string, action: Action = 'save'): Notice {
  switch (code) {
    case 'CONFLICT':
      return action === 'remove'
        ? { text: 'projects.yaml changed since you loaded it, so nothing was removed. The list is up to date now: look at it, then try again.', detail: message }
        : { text: 'projects.yaml changed since you loaded it. Your settings are still in the form.', detail: message }
    case 'INVALID':
      return { text: `Can't ${VERB[action]}: ${message}` }
    case 'SECRET':
      return { text: 'This looks like a key or a token, and the store never keeps those. Take it out and try again.', detail: message }
    case 'TOO_LARGE':
      return { text: 'projects.yaml is too large for the store.', detail: message }
    case 'UNAVAILABLE':
      return { text: 'The config store isn\'t running, so projects are read-only. Start dish-config to change them.' }
    case 'NOT_FOUND':
      return { text: 'Not found: it may have been removed elsewhere.', detail: message }
    case 'UNOWNED':
      // The store knows no claim on projects.yaml: the plugin that makes the claim, this one's host half, isn't running.
      return { text: 'The config store has no claim on projects.yaml, so dish-projects probably isn\'t running. Check that it is loaded, then reload this page.', detail: message }
    case 'FORBIDDEN':
      return { text: 'The config store doesn\'t allow this change.', detail: message }
    case 'LOCKED':
      return { text: 'Another dish process has the config store locked. Try again in a moment.', detail: message }
    default:
      return { text: `${code}: ${message}` }
  }
}

/**
 * What a call that failed for a reason other than a refusal is called: the Remote's own failure (a carrier that is down,
 * the gateway's `internal`), or anything thrown.
 * @param failure - the `RemoteResult`'s error, or what was thrown.
 * @param remote - which remote the call was to.
 */
export function unexpectedNotice(failure: unknown, remote = 'dish-projects'): Notice {
  const text = `Something went wrong talking to ${remote}`
  const detail = describe(failure)
  return detail === '' ? { text } : { text, detail }
}

function describe(failure: unknown): string {
  if (typeof failure === 'string') return failure
  if (typeof failure === 'object' && failure !== null && 'message' in failure && typeof failure.message === 'string') return failure.message
  return ''
}
