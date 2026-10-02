/**
 * What the page says when a call does not simply succeed: the store's refusals in plain language, with the store's own
 * message kept as detail where it adds something. Plain TypeScript with no DOM or React in it, so `node --test` can load it.
 * @module dish-skills/client/outcome
 */

import type { ErrorCode } from '../protocol.ts'

/** One line for the person, and what the store itself said, when that adds something. */
export interface Notice {
  text: string
  detail?: string
}

/** What the person was doing when the store refused, for the codes whose remedy depends on it. A reset is a save of the default. */
export type Action = 'save' | 'reset' | 'delete' | 'revert'

/** A revert that came back `null`: the commit was undone already. */
export const NOTHING_TO_REVERT = 'Already reverted — nothing to do'

/** A reset that came back `null`: the skill already is the shipped default. */
export const ALREADY_DEFAULT = 'Already the default — nothing to do'

/** The Default tab, when what is saved is the shipped default. */
export const SAME_AS_DEFAULT = 'Same as the default.'

/** Why a shipped skill has no Delete, and what to do instead. */
export const SHIPPED_NOT_DELETABLE = 'A shipped skill can\'t be deleted: it comes back at the next start. Turn it off with `roles: []` instead.'

/** What the person was doing, as a verb, for the refusals that say "can't <verb>". */
const VERB: Record<Action, string> = { save: 'save', reset: 'reset', delete: 'delete', revert: 'revert' }

/**
 * What a store refusal (`{ ok: false, code, message }`) is called. A code with no wording of its own (`STALE`, which the page
 * never causes) reads `<code>: <message>`.
 * @param action - what was being done. A `CONFLICT` on a save means what the page loaded is out of date, and the draft is
 *   safe; on a delete it means the skill changed, so nothing was deleted; on a revert it means a later commit touched the
 *   same file, which reloading does not help.
 */
export function failureNotice(code: ErrorCode, message: string, action: Action = 'save'): Notice {
  switch (code) {
    case 'CONFLICT':
      if (action === 'revert') {
        return { text: 'A later change touched the same file — revert that change first, or edit the skill directly.', detail: message }
      }
      if (action === 'delete') {
        return { text: 'This skill changed since you loaded it, so it wasn\'t deleted. Look at what changed, then try again.', detail: message }
      }
      return { text: 'This skill changed since you loaded it. Your text is still in the editor.', detail: message }
    case 'INVALID':
      return { text: `Can't ${VERB[action]}: ${message}` }
    case 'SECRET':
      return { text: 'This looks like a key or a token, and the store never keeps those. Take it out and try again.', detail: message }
    case 'TOO_LARGE':
      return { text: 'This skill is too large for the store.', detail: message }
    case 'UNAVAILABLE':
      return { text: 'The config store isn\'t running, so skills are read-only. Start dish-config to change them.' }
    case 'NOT_FOUND':
      return { text: 'Not found: it may have been deleted or reverted elsewhere.', detail: message }
    case 'UNOWNED':
      // The store knows no claim on the skills' paths: the plugin that makes the claim, this one's host half, isn't running.
      return { text: 'The config store has no claim on the skills, so dish-skills probably isn\'t running. Check that it is loaded, then reload this page.', detail: message }
    case 'FORBIDDEN':
      return { text: 'The config store doesn\'t allow this change.', detail: message }
    case 'LOCKED':
      return { text: 'Another dish process has the config store locked. Try again in a moment.', detail: message }
    default:
      return { text: `${code}: ${message}` }
  }
}

/**
 * What a call that failed for a reason other than a store refusal is called: the Remote's own failure (a carrier that
 * is down, the gateway's `internal`), or anything thrown.
 * @param failure - the `RemoteResult`'s error, or what was thrown.
 * @param remote - which remote the call was to: this page talks to dish-skills' and, for the History tab, dish-config's.
 */
export function unexpectedNotice(failure: unknown, remote = 'dish-skills'): Notice {
  const text = `Something went wrong talking to ${remote}`
  const detail = describe(failure)
  return detail === '' ? { text } : { text, detail }
}

function describe(failure: unknown): string {
  if (typeof failure === 'string') return failure
  if (typeof failure === 'object' && failure !== null && 'message' in failure && typeof failure.message === 'string') return failure.message
  return ''
}
