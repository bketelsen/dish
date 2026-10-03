/**
 * Browser half of dish-orchestrator: **Settings → Runs**, through a `settings.section` entry. Read only: the page shows the
 * runs and their ledgers, and changes nothing.
 *
 * The page's state lives here (`controller.ts`), not in the component. It needs dish-orchestrator's own remote alone
 * (`remote.dishRuns`); the page goes when it does, and comes back with it.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { createRunsPage } from './controller.ts'
import { runsRemote } from './remote.ts'
import { Runs } from './Runs.tsx'
import './styles.ts'

export const inject = ['remote', 'slots']

/** The seat in Settings' nav: after History (50). */
const ORDER = 51

export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(runsRemote)
  const ui = ctx.inject(['remote.dishRuns', 'slots'], registerPage)
  try { await ui } catch (error) { await ui.dispose(); await disposeRemote(); throw error }
  return async () => { await ui.dispose(); await disposeRemote() }
}

function registerPage(ctx: Context): void {
  const page = createRunsPage(ctx.remote.dishRuns)
  // This scope ends when the remote goes (or the plugin does) and is made again with the next one: a call of the controller of the
  // one that ended must not change the page of the new one.
  ctx.effect(() => () => { page.dispose() }, 'dish-orchestrator: controller')

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'dish-orchestrator',
    order: ORDER,
    label: () => 'Runs',
    inject: () => page.face,
  }, Runs))
}
