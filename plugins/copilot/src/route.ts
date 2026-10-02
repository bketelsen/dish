/**
 * The `github-copilot` route in `llm-pi-ai`'s settings: whether it exists, and
 * adding it. The remote reports the first (the Models page shows a first
 * sign-in card until it does); the plugin does the second after a sign-in.
 * @module dish-copilot/route
 */

import type { Context, Logger } from '@deepseek-ai/cordis'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'

/** The `llm-pi-ai` entry id in the base bundle, which is also its settings namespace. */
export const PI_AI_NS = 'llm-pi-ai' as SettingsNamespace
/** pi-ai's catalog id for Copilot; also the route key the model picker shows. */
export const PROVIDER_ID = 'github-copilot'

function piAiSettings(ctx: Context) {
  return ctx.settings.describe().find(descriptor => descriptor.ns === PI_AI_NS)
}

/** Whether `llm-pi-ai` has a `github-copilot` provider (an empty profile counts). */
export function hasCopilotRoute(ctx: Context): boolean {
  const value = piAiSettings(ctx)?.value as { providers?: Record<string, unknown> } | undefined
  return value?.providers?.[PROVIDER_ID] !== undefined
}

export async function addCopilotRoute(ctx: Context, logger: Logger): Promise<void> {
  const descriptor = piAiSettings(ctx)
  if (descriptor === undefined) {
    logger.warn('GitHub Copilot: no %s settings namespace; add the route on the Models page', PI_AI_NS)
    return
  }
  // An empty profile keeps pi-ai's installed Copilot catalog: endpoint, per-model
  // wire protocol, and models; the catalog refresh then narrows it to the account.
  await ctx.settings.mutate(PI_AI_NS, [{ op: 'set', path: ['providers', PROVIDER_ID], value: {} }], descriptor.revision)
  logger.info('GitHub Copilot: added the "%s" route', PROVIDER_ID)
}
