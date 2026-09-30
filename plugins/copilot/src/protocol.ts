/**
 * The wire shapes shared by the server remote (`remote.ts`) and the browser
 * card (`client/`). Types only, so both halves can import it.
 * @module dish-copilot/protocol
 */

/** The remote's service key, which is also its wire namespace. */
export const NAMESPACE = 'dishCopilot'

/** What the card shows when it is not mid-sign-in. */
export interface CopilotStatus {
  signedIn: boolean
  /** A sign-in attempt is running, possibly started elsewhere (terminal, another tab). */
  inFlight: boolean
  /** The latest model refresh, if any has run. */
  models?: {
    refreshedAt: number
    available: number
    added: string[]
    unavailable: string[]
  }
}

/** One item of the `signIn` stream; the stream ends after the first non-notice. */
export type SignInEvent =
  | { type: 'notice', message: string, url?: string, code?: string }
  | { type: 'settled', status: 'authorized' | 'cancelled' }
  | { type: 'failed', message: string }
