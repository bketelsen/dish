/**
 * The server half of the Models-page card: a Typert remote service the
 * browser calls through `ctx.remote.dishCopilot`.
 *
 * The gateway serves any root service that carries a `typertRemote` binding and
 * `@Remote` markers, reading wire parameter names from the method source. This
 * package runs as type-stripped `.ts`, which has no decorator syntax, so the
 * markers are applied by {@link markRemote} instead.
 *
 * @module dish-copilot/remote
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AuthorizationInteraction } from '@deepseek-ai/dsh-authorization'
import type { CredentialKey } from '@deepseek-ai/dsh-credentials'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { markRemote } from 'dish-kit'
import type {} from './catalog.ts'
import { NAMESPACE, type CopilotStatus, type SignInEvent } from './protocol.ts'
import { hasCopilotRoute } from './route.ts'

export const KEY = 'llm-pi-ai/github-copilot' as CredentialKey

export interface RemoteConfig {
  enterpriseDomain: string
}

export class CopilotRemote extends TypertRemoteService {
  static inject = ['authorization', 'credentials', 'settings']

  private readonly config: RemoteConfig

  constructor(ctx: Context, config: RemoteConfig) {
    super(ctx, NAMESPACE)
    this.config = config
  }

  async status(): Promise<CopilotStatus> {
    const report = this.ctx.get('copilotCatalog')?.last
    return {
      signedIn: await this.ctx.credentials.readRecord(KEY) !== undefined,
      inFlight: this.ctx.authorization.describe(KEY)?.inFlight ?? false,
      route: hasCopilotRoute(this.ctx),
      ...report === undefined ? {} : {
        models: {
          refreshedAt: report.refreshedAt,
          available: report.available.length,
          added: report.added,
          unavailable: report.unavailable,
        },
      },
    }
  }

  /**
   * Run the device-code sign-in, streaming its notices (the code arrives as
   * one) and ending with how it settled. Closing the stream cancels it. An
   * attempt already running for the key, e.g. from the terminal, is withdrawn
   * first, since only one may run and this one has a human watching.
   */
  async *signIn(signal: AbortSignal): AsyncIterable<SignInEvent> {
    const queue: SignInEvent[] = []
    let wake: (() => void) | undefined
    const push = (event: SignInEvent): void => { queue.push(event); wake?.() }
    const abort = (): void => { wake?.() }
    signal.addEventListener('abort', abort, { once: true })

    const interaction: AuthorizationInteraction = {
      notify: notice => { push({ type: 'notice', ...notice }) },
      prompt: (prompt) => {
        // pi-ai's Copilot login asks one question: which GitHub host.
        if (prompt.kind === 'text' && /enterprise/i.test(prompt.message)) {
          return Promise.resolve(this.config.enterpriseDomain)
        }
        return Promise.reject(new Error(`the sign-in card cannot answer "${prompt.message}"`))
      },
    }
    void (async () => {
      await this.withdrawRunningAttempt(signal)
      return this.ctx.authorization.begin({ key: KEY, method: 'oauth', interaction, signal })
    })().then(
      outcome => { push({ type: 'settled', status: outcome.status }) },
      (error: unknown) => { push({ type: 'failed', message: error instanceof Error ? error.message : String(error) }) },
    )

    try {
      while (!signal.aborted) {
        const event = queue.shift()
        if (event === undefined) {
          await new Promise<void>((resolve) => { wake = resolve })
          continue
        }
        yield event
        if (event.type !== 'notice') return
      }
    } finally {
      signal.removeEventListener('abort', abort)
    }
  }

  cancel(): void {
    this.ctx.authorization.cancel(KEY)
  }

  /** Forget the stored sign-in locally; GitHub is not told. The route stays. */
  async signOut(): Promise<CopilotStatus> {
    await this.ctx.credentials.deleteRecord(KEY)
    return this.status()
  }

  async refreshModels(): Promise<CopilotStatus> {
    const catalog = this.ctx.get('copilotCatalog')
    if (catalog === undefined) throw new Error('the dish-copilot-catalog plugin is not running')
    await catalog.refresh()
    return this.status()
  }

  private async withdrawRunningAttempt(signal: AbortSignal): Promise<void> {
    if (this.ctx.authorization.describe(KEY)?.inFlight !== true) return
    const settled = new Promise<void>((resolve) => {
      const dispose = this.ctx.on('authorization/settled', (key) => {
        if (key === KEY) { dispose(); resolve() }
      })
      signal.addEventListener('abort', () => { dispose(); resolve() }, { once: true })
    })
    this.ctx.authorization.cancel(KEY)
    await settled
  }
}

markRemote(CopilotRemote, 'status')
markRemote(CopilotRemote, 'signIn', { mode: 'stream' })
markRemote(CopilotRemote, 'cancel')
markRemote(CopilotRemote, 'signOut')
markRemote(CopilotRemote, 'refreshModels')
