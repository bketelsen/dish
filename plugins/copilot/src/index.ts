/**
 * dish-copilot — sign DeepSeek Harness into a GitHub Copilot subscription.
 *
 * The bundled `llm-pi-ai` adapter already speaks Copilot's API and registers a
 * device-code sign-in flow for it (credential key `llm-pi-ai/github-copilot`),
 * but no shipped surface ever starts that flow. This plugin is that surface:
 *
 * - a card on the Models page (browser half in `client/`, served through the
 *   `CopilotRemote` service in `remote.ts`), with sign-in, sign-out, and model
 *   refresh;
 * - optionally, a terminal sign-in at startup (`terminalSignIn`).
 *
 * However the sign-in was started, a successful one adds the `github-copilot`
 * route (if missing) and refreshes the model list through `copilotCatalog`.
 *
 * The credential itself is written, refreshed, and read by `llm-pi-ai`; this
 * plugin never touches the token.
 *
 * @module dish-copilot
 */

import { setTimeout as sleep } from 'node:timers/promises'
import type { Context, Logger } from '@deepseek-ai/cordis'
import type { AuthorizationInteraction } from '@deepseek-ai/dsh-authorization'
import Schema from '@deepseek-ai/schemastery'
import { printOwnLogs } from 'dish-kit'
import type {} from './catalog.ts'
import { CopilotRemote, KEY } from './remote.ts'
import { PI_AI_NS, PROVIDER_ID, addCopilotRoute, hasCopilotRoute } from './route.ts'

export const name = 'dish-copilot'
export const inject = ['authorization', 'credentials', 'settings']

export interface Config {
  terminal: boolean
  terminalSignIn: boolean
  enterpriseDomain: string
  addRoute: boolean
  flowWaitMs: number
}

export const Config: Schema<Config> = Schema.object({
  terminal: Schema.boolean().default(true)
    .description('Print this plugin\'s messages to the terminal.'),
  terminalSignIn: Schema.boolean().default(false)
    .description('At startup, when not signed in, start the sign-in and print the device code to the terminal.'),
  enterpriseDomain: Schema.string().default('')
    .description('GitHub Enterprise domain (e.g. company.ghe.com); leave blank for github.com.'),
  addRoute: Schema.boolean().default(true)
    .description(`After signing in, add a "${PROVIDER_ID}" route to ${PI_AI_NS} if none exists.`),
  flowWaitMs: Schema.natural().default(30_000)
    .description(`How long the terminal sign-in waits for ${PI_AI_NS} to register its Copilot flow.`),
})

export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger(name)
  if (config.terminal) printOwnLogs(ctx, name)

  ctx.plugin(CopilotRemote, { enterpriseDomain: config.enterpriseDomain })

  ctx.on('authorization/settled', (key, settlement) => {
    if (key !== KEY) return
    if (settlement !== 'authorized') {
      logger.info('GitHub Copilot: sign-in %s', settlement)
      return
    }
    afterSignIn(ctx, logger, config).catch((error: unknown) => {
      logger.warn('GitHub Copilot: post-sign-in setup failed: %s', error)
    })
  })

  const controller = new AbortController()
  ctx.effect(() => () => controller.abort())
  startup(ctx, logger, config, controller.signal).catch((error: unknown) => {
    if (!controller.signal.aborted) logger.warn('GitHub Copilot sign-in failed: %s', error)
  })
}

async function startup(ctx: Context, logger: Logger, config: Config, signal: AbortSignal): Promise<void> {
  if (await ctx.credentials.readRecord(KEY) !== undefined) {
    logger.info('GitHub Copilot: signed in')
    return
  }
  if (!config.terminalSignIn) {
    logger.info('GitHub Copilot: not signed in; use Sign in on the Models page')
    return
  }
  if (!await waitForFlow(ctx, config.flowWaitMs, signal)) {
    logger.warn('GitHub Copilot: %s registered no sign-in flow for %s within %dms', PI_AI_NS, KEY, config.flowWaitMs)
    return
  }
  // The outcome is handled by the `authorization/settled` listener.
  await ctx.authorization.begin({ key: KEY, method: 'oauth', interaction: terminalInteraction(logger, config), signal })
}

async function afterSignIn(ctx: Context, logger: Logger, config: Config): Promise<void> {
  logger.info('GitHub Copilot: signed in')
  if (config.addRoute && !hasCopilotRoute(ctx)) await addCopilotRoute(ctx, logger)
  await ctx.get('copilotCatalog')?.refresh()
}

/**
 * `llm-pi-ai` registers its flows from its own `inject(['authorization'])`
 * child, which can settle after this plugin applies; there is no event for a
 * new flow, so poll the registry briefly.
 */
async function waitForFlow(ctx: Context, timeoutMs: number, signal: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (ctx.authorization.describe(KEY) === undefined) {
    if (Date.now() >= deadline) return false
    await sleep(250, undefined, { signal })
  }
  return true
}

/**
 * Renders the flow's notices in the server log and answers its one question —
 * which GitHub host to sign into — from config. Anything else it asks has no
 * terminal answer, so it fails the attempt rather than hanging.
 */
function terminalInteraction(logger: Logger, config: Config): AuthorizationInteraction {
  return {
    notify(notice) {
      if (notice.code !== undefined && notice.url !== undefined) {
        logger.info('GitHub Copilot: open %s and enter code %s', notice.url, notice.code)
      } else {
        logger.info('GitHub Copilot: %s', notice.message)
      }
    },
    prompt(prompt) {
      if (prompt.kind === 'text' && /enterprise/i.test(prompt.message)) {
        return Promise.resolve(config.enterpriseDomain)
      }
      return Promise.reject(new Error(`cannot answer "${prompt.message}" from the terminal`))
    },
  }
}
