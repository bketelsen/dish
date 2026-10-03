/**
 * The wire shapes shared by the server remote (`remote.ts`) and the Settings → GitHub App card (`client/`). Types and one
 * constant, so both halves can import it, and it imports nothing: the browser build must not reach into Node's modules.
 *
 * Everything here is plain JSON.
 *
 * **There is no key in this file, and none anywhere on this remote.** The card sets, removes and describes the App's ID and
 * private key through dsh's own `credentials` remote, in the browser; no method here takes either value or gives it back.
 * `AppStatus` has the credentials' *names* (the references the card passes to dsh) and what GitHub says of the App: its
 * name, its bot, its installations. Nothing in it is a token, a JWT or the key.
 * @module dish-workspaces/protocol
 */

/** The remote's wire namespace: the card calls `ctx.remote.dishWorkspaces`. (Its Cordis service key is `dishWorkspacesRemote`.) */
export const NAMESPACE = 'dishWorkspaces'

/** An installation of the App, as `GET /app/installations` lists it. */
export interface InstallationInfo {
  id: number
  /** The owner's login. */
  account: string
  /** `Organization` or `User`. */
  type: string
  /** Whether the owner gave the App all its repositories or chose some. */
  selection: 'all' | 'selected'
}

/**
 * What dish knows of the GitHub App: the result of the last test (`GET /app`, the installations, the bot), or of none yet.
 */
export interface AppStatus {
  /** The credentials' references in dsh's store (the `appIdName` and `privateKeyName` rows). Names, never values. */
  names: { appId: string, privateKey: string }
  /**
   * `GET /app`: its name and slug, or null when it wasn't reached or answered. GitHub's `id` (the App's ID, the first of the
   * two credentials) is left out: no answer of this remote holds either value, so the card has nothing to show that the person
   * didn't type, and a test can check for them in everything it says.
   */
  app: { slug: string, name: string } | null
  /** The App's bot, whose name and email dish's commits carry: null when it wasn't looked up. */
  bot: { login: string, email: string } | null
  /** Every installation the App can see: empty when they weren't listed. */
  installations: InstallationInfo[]
  /** What went wrong, masked and cut short; null when the test went through. */
  error: string | null
  /** When the test was made (milliseconds since the epoch). */
  checkedAt: number | null
}
