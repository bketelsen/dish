/**
 * The server half of Settings → GitHub App: a Typert remote service the browser calls through `ctx.remote.dishWorkspaces`.
 *
 * It is built like `dish-judge`'s remote, and for the same reasons:
 *
 * - the gateway serves any root service that carries a `typertRemote` binding and `@Remote` markers, reading wire parameter
 *   names from the method source. This package runs as type-stripped `.ts`, which has no decorator syntax, so the markers are
 *   applied by `markRemote`;
 * - neither method takes a parameter, and what each gives is plain JSON (`AppStatus`). Nothing it refuses is a result with a
 *   code: a test that could not go through is an `error` inside the status, in the status's own words.
 *
 * **The App's ID and private key never touch this remote.** No method takes either and none gives either back: the card sets,
 * removes and describes them through dsh's own `credentials` remote, in the browser (`describe`, `set` and `unset`), and the
 * service reads them from dsh's store when it makes a test. What this remote says is the credentials' *names* (the card
 * needs them for that), and what GitHub says of the App. As a last line, everything that leaves here passes the secret mask
 * once more.
 *
 * A method's name may not be one of dish-kit's `RESERVED_REMOTE_METHODS` (`remove`, `has`, `name`, ...): the browser's namespace
 * service owns them, and a remote method with one cannot be mounted. `test/client-remote.test.ts` keeps it so.
 *
 * @module dish-workspaces/remote
 */

import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { markRemote, maskSecrets } from 'dish-kit'
import { NAMESPACE } from './protocol.ts'
import type { AppStatus } from './protocol.ts'

/** The Cordis service key. (The wire namespace is `NAMESPACE`.) */
export const SERVICE = 'dishWorkspacesRemote'

declare module '@deepseek-ai/cordis' {
  interface Context {
    dishWorkspacesRemote: WorkspacesRemote
  }
}

export interface RemoteOptions {
  /** The credentials' names in dsh's store: what the card sets and removes. Not the values. */
  appIdName: string
  privateKeyName: string
}

/** `value` as the wire will carry it: JSON, with no key left `undefined`. */
function wire<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** `value` with every string in it, and every key, passed through the secret mask: for what came from outside the code. */
function masked<T>(value: T): T {
  if (typeof value === 'string') return maskSecrets(value) as T
  if (Array.isArray(value)) return value.map(masked) as T
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [maskSecrets(key), masked(inner)])) as T
  }
  return value
}

export class WorkspacesRemote extends TypertRemoteService {
  static inject = ['dishWorkspaces']

  private readonly names: AppStatus['names']

  constructor(ctx: Context, options: RemoteOptions) {
    super(ctx, SERVICE, { namespace: NAMESPACE })
    this.names = { appId: options.appIdName, privateKey: options.privateKeyName }
  }

  /**
   * What dish knows of the App: the last test's result, from memory, or a fresh test when there is none (either credential
   * changing forgets it). With no credentials set the status says so as its `error`, and GitHub is not asked.
   */
  async status(): Promise<AppStatus> {
    return this.answer(await this.ctx.dishWorkspaces.appStatus(false))
  }

  /**
   * Ask GitHub now: `GET /app` with a JWT signed by the App's key, the installations the App can see, and the bot's public
   * profile. What went wrong is the status's `error`, masked; the rest of the status is what did go through.
   */
  async test(): Promise<AppStatus> {
    return this.answer(await this.ctx.dishWorkspaces.appStatus(true))
  }

  /** An answer as it leaves: plain JSON, masked once more, with the names this remote was given. */
  private answer(status: AppStatus): AppStatus {
    return masked(wire({ ...status, names: this.names }))
  }
}

markRemote(WorkspacesRemote, 'status')
markRemote(WorkspacesRemote, 'test')
