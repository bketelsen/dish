/**
 * Browser half of dish-workspaces: **Settings → GitHub App**, through a `settings.section` entry.
 *
 * The card's state lives here (`controller.ts`), not in the component. The card needs dish-workspaces' own remote (what GitHub
 * says of the App, and the Test button), and one more, looked for as a service of its own (`remote.credentials`), so it can
 * arrive after this plugin has loaded, and leave again:
 *
 * - **dsh's `credentials` remote** is how the App's ID and private key are set, removed and described. They go from the browser
 *   to dsh and to nobody else; dish-workspaces' server doesn't see them. Without the remote the card says so. When dsh says a
 *   credential changed (it can be set from another page), the card reads it, and the App's status, again.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { AppCard } from './AppCard.tsx'
import { createAppCard } from './controller.ts'
import type { AppCardController } from './controller.ts'
import { workspacesRemote } from './remote.ts'
import './styles.ts'

export const inject = ['remote', 'slots']

/** The seat in Settings' nav: after Projects (48), and before History (50). */
const ORDER = 49

export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(workspacesRemote)
  const ui = ctx.inject(['remote.dishWorkspaces', 'slots'], registerCard)
  try { await ui } catch (error) { await ui.dispose(); await disposeRemote(); throw error }
  return async () => { await ui.dispose(); await disposeRemote() }
}

function registerCard(ctx: Context): void {
  const card = createAppCard(ctx.remote.dishWorkspaces)
  // This scope ends when the remote goes (or the plugin does) and is made again with the next one: a call of the controller of the
  // one that ended must not change the page of the new one.
  ctx.effect(() => () => { card.dispose() }, 'dish-workspaces: controller')
  // Optional: these run when dsh's credentials remote is there, again if it is mounted anew, and end when it goes.
  ctx.inject(['remote.credentials'], (inner) => { attachCredentials(inner, card) })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'dish-workspaces',
    order: ORDER,
    label: () => 'GitHub App',
    inject: () => card.face,
  }, AppCard))
}

/**
 * Give the card dsh's credentials remote for as long as `ctx` lives, and read the credentials again when dsh says one changed
 * (it can be set from another page). The remote is dsh's, typed by dsh: handing it to the controller is checked against
 * `CredentialsCalls`.
 */
function attachCredentials(ctx: Context, card: AppCardController): void {
  card.setCredentials(ctx.remote.credentials)
  ctx.effect(() => () => { card.setCredentials(undefined) }, 'dish-workspaces: credentials remote')
  ctx.effect(() => ctx.remote.$on('credentials/reference-updated', (ref) => { card.credentialChanged(ref) }), 'dish-workspaces: credential changes')
}
