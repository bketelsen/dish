/**
 * What the page says when a call does not simply succeed: the service's and the stores' refusals in plain language, with
 * their own message kept as detail where it adds something. Plain TypeScript with no DOM or React in it, so `node --test`
 * can load it. A refusal's message never holds a memory's text or a direction (the service keeps those out of errors), so
 * showing it is safe.
 * @module dish-memory/client/outcome
 */

import type { ErrorCode } from '../protocol.ts'

/** One line for the person, and what the service itself said, when that adds something. */
export interface Notice {
  text: string
  detail?: string
}

/** What the person was doing when the call was refused, for the codes whose wording depends on it. */
export type Action = 'save' | 'forget' | 'release' | 'direction' | 'revert'

/** A revert that came back `null`: the commit was undone already. */
export const NOTHING_TO_REVERT = 'Already reverted — nothing to do'

/** What each action is, in "Can't …". */
const VERB: Record<Action, string> = {
  save: 'save', forget: 'delete', release: 'release', direction: 'save the direction', revert: 'revert',
}

/**
 * What a refusal (`{ ok: false, code, message }`) is called. A code with no wording of its own (`STALE`, which the page never
 * causes) reads `<code>: <message>`.
 * @param action - what was being done. A `CONFLICT` on a save means what the page loaded is out of date, and the draft is
 *   safe; on a delete that nothing was deleted; on a revert that a later commit touched the same memory, which reloading
 *   does not help.
 */
export function failureNotice(code: ErrorCode, message: string, action: Action = 'save'): Notice {
  switch (code) {
    case 'CONFLICT':
      switch (action) {
        case 'forget': return { text: 'This memory changed since you loaded it, so it wasn\'t deleted. Look at the change first.', detail: message }
        case 'direction': return { text: 'The direction changed since you loaded it. Your text is still in the editor.', detail: message }
        case 'revert': return { text: 'A later change touched the same memory — revert that change first, or edit the memory directly.', detail: message }
        default: return { text: 'This memory changed since you loaded it. Your text is still in the editor.', detail: message }
      }
    case 'INVALID':
      return { text: `Can't ${VERB[action]}: ${message}` }
    case 'SECRET':
      return { text: 'This looks like a key or a token, and dish never stores those. Take it out and try again.', detail: message }
    case 'TOO_LARGE':
      return { text: 'This is too large to save.', detail: message }
    case 'UNAVAILABLE':
      // The only thing the page asks for that can be missing is the config store, which holds the directions.
      return action === 'direction'
        ? { text: 'The config store isn\'t running, so directions can\'t be read or saved. Start dish-config to edit them.' }
        : { text: `Not available: ${message}` }
    case 'NOT_FOUND':
      return { text: 'Not found: it may have been deleted or reverted elsewhere.', detail: message }
    case 'UNOWNED':
      // No claim on the path: the plugin that makes the vault's and the directions' claims, this one's host half, isn't running.
      return { text: 'The store has no claim on this path, so dish-memory probably isn\'t running. Check that it is loaded, then reload this page.', detail: message }
    case 'FORBIDDEN':
      return { text: 'The store doesn\'t allow this change.', detail: message }
    case 'LOCKED':
      return { text: 'Another dish process has the store locked. Try again in a moment.', detail: message }
    default:
      return { text: `${code}: ${message}` }
  }
}

/**
 * What a call that failed for a reason other than a refusal is called: the Remote's own failure (a carrier that is down, the
 * gateway's `internal`), or anything thrown.
 * @param failure - the `RemoteResult`'s error, or what was thrown.
 */
export function unexpectedNotice(failure: unknown): Notice {
  const text = 'Something went wrong talking to dish-memory'
  const detail = describe(failure)
  return detail === '' ? { text } : { text, detail }
}

function describe(failure: unknown): string {
  if (typeof failure === 'string') return failure
  if (typeof failure === 'object' && failure !== null && 'message' in failure && typeof failure.message === 'string') return failure.message
  return ''
}
