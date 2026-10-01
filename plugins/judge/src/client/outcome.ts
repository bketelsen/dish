/**
 * What the page says when a call does not simply succeed: the store's refusals in plain language, with the store's own
 * message kept as detail where it adds something. Plain TypeScript with no DOM or React in it, so `node --test` can load it.
 * @module dish-judge/client/outcome
 */

import type { ErrorCode } from '../protocol.ts'

/** One line for the person, and what the server itself said, when that adds something. */
export interface Notice {
  text: string
  detail?: string
}

/** What the person was doing when the store refused, for the codes whose remedy depends on it. */
export type Action = 'save' | 'revert'

/** A revert that came back `null`: the commit was undone already. */
export const NOTHING_TO_REVERT = 'Already reverted — nothing to do'

/** A save that came back `null`: the document already has these values. */
export const NOTHING_TO_SAVE = 'Nothing to save: the store already has these values.'

/**
 * What a refusal (`{ ok: false, code, message }`) is called. A code with no wording of its own (`STALE`, which the page never
 * causes) reads `<code>: <message>`.
 * @param action - what was being done. A `CONFLICT` on a save means what the page loaded is out of date, and the person's
 *   values are safe; on a revert it means a later commit touched the same file, which reloading does not help.
 */
export function failureNotice(code: ErrorCode, message: string, action: Action = 'save'): Notice {
  switch (code) {
    case 'CONFLICT':
      return action === 'revert'
        ? { text: 'A later change touched the same file — revert that change first, or edit the thresholds directly.', detail: message }
        : { text: 'The thresholds changed since you loaded them. Your values are still in the form.', detail: message }
    case 'INVALID':
      // The server's own check says which setting, by its path in the file, and why.
      return { text: `Can't ${action === 'revert' ? 'revert' : 'save'}: ${message}` }
    case 'SECRET':
      return { text: 'This looks like a key or a token, and the store never keeps those. Take it out and try again.', detail: message }
    case 'TOO_LARGE':
      return { text: 'This is too large for the store.', detail: message }
    case 'UNAVAILABLE':
      return { text: 'The config store isn\'t running, so the thresholds are read-only. Start dish-config to change them.' }
    case 'NOT_FOUND':
      return { text: 'Not found: it may have been deleted, reverted or pruned elsewhere.', detail: message }
    case 'UNOWNED':
      // The store knows no claim on judge.yaml: the plugin that makes the claim, this one's host half, isn't running.
      return { text: 'The config store has no claim on judge.yaml, so dish-judge probably isn\'t running. Check that it is loaded, then reload this page.', detail: message }
    case 'FORBIDDEN':
      return { text: 'The config store doesn\'t allow this change.', detail: message }
    case 'LOCKED':
      return { text: 'Another dish process has the config store locked. Try again in a moment.', detail: message }
    case 'JUDGE_UNAVAILABLE':
      return { text: 'The judge didn\'t answer.', detail: message }
    default:
      return { text: `${code}: ${message}` }
  }
}

/**
 * What a call that failed for a reason other than a refusal is called: the Remote's own failure (a carrier that is down, the
 * gateway's `internal`), or anything thrown.
 * @param failure - the `RemoteResult`'s error, or what was thrown.
 * @param remote - which remote the call was to: this page talks to dish-judge's, dish-config's (History) and dsh's own credentials.
 */
export function unexpectedNotice(failure: unknown, remote = 'dish-judge'): Notice {
  const text = `Something went wrong talking to ${remote}`
  const detail = describe(failure)
  return detail === '' ? { text } : { text, detail }
}

function describe(failure: unknown): string {
  if (typeof failure === 'string') return failure
  if (typeof failure === 'object' && failure !== null && 'message' in failure && typeof failure.message === 'string') return failure.message
  return ''
}
