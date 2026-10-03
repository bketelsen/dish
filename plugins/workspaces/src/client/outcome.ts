/**
 * What the card says when a call does not simply succeed. Plain TypeScript with no DOM or React in it, so `node --test` can
 * load it.
 * @module dish-workspaces/client/outcome
 */

/** One line for the person, and what the server (or dsh) itself said, when that adds something. */
export interface Notice {
  text: string
  detail?: string
}

/**
 * What a call that failed is called: the Remote's own failure (a carrier that is down, the gateway's `internal`), or anything
 * thrown. This card has no refusals of its own: a test that could not go through is an `error` inside the status.
 * @param failure - the `RemoteResult`'s error, or what was thrown.
 * @param remote - which remote the call was to: this card talks to dish-workspaces' and to dsh's own credentials.
 */
export function unexpectedNotice(failure: unknown, remote = 'dish-workspaces'): Notice {
  const text = `Something went wrong talking to ${remote}`
  const detail = describe(failure)
  return detail === '' ? { text } : { text, detail }
}

function describe(failure: unknown): string {
  if (typeof failure === 'string') return failure
  if (typeof failure === 'object' && failure !== null && 'message' in failure && typeof failure.message === 'string') return failure.message
  return ''
}
