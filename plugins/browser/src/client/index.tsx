/**
 * Browser half of dish-browser: the Browser tab, the header button, the guide entry and the screenshot's toolview.
 *
 * - **The tab type** (`dish-browser`, a page type: no address patterns, no `keepMounted`, so a hidden tab unmounts and its
 *   stream closes), its body and its title, keyed `dish-browser` in the right sidebar's seats. The guide lists it.
 * - **The header button** in `conversation.session.header.utilities`, after the scheduler's (-5).
 * - **The toolview** keyed `browser_screenshot`: the image, and a click that opens the tab on that chat.
 *
 * Each chat has one tab controller and one presence (`controller.ts`), made when a slot first asks for them and disposed
 * with the scope. Everything here needs dish-browser's own remote (`remote.dishBrowser`): the tab, the button and the row go
 * when it does, and come back with it.
 */

import type { Context } from '@deepseek-ai/cordis'
import { RemoteStreamCarrierError } from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import type { Down } from '../protocol.ts'
import { BrowserTab, TAB_KIND } from './BrowserTab.tsx'
import type { TabFace } from './BrowserTab.tsx'
import { createPresence, createTabController } from './controller.ts'
import type { PresenceActions, TabController } from './controller.ts'
import type { Stream, StreamOptions } from './follow.ts'
import { HeaderButton } from './HeaderButton.tsx'
import type { PresenceFace } from './HeaderButton.tsx'
import { browserRemote } from './remote.ts'
import { ScreenshotRow } from './ScreenshotRow.tsx'
import { Title } from './Title.tsx'
import './styles.ts'

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightTabParamsMap {
    /** The chat whose browser the tab shows; the chat the tab is in when absent. */
    'dish-browser': { readonly sessionId?: string }
  }
}

export const inject = ['remote', 'slots', 'sidebarRight', 'sidebarRightTabs']

/** The tab type, and its guide entry. */
const TAB: SidebarRightTabDefinition = {
  id: 'dish-browser',
  kind: TAB_KIND,
  title: () => 'Browser',
  guide: [{ id: 'watch', order: 31, title: () => 'Browser', description: () => 'What this chat’s agents see, live' }],
}

/** The header button's place: after the scheduler's catalog (-5). */
const HEADER_ORDER = -4

export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(browserRemote)
  const ui = ctx.inject(['remote.dishBrowser', 'slots'], register)
  try { await ui } catch (error) { await ui.dispose(); await disposeRemote(); throw error }
  return async () => { await ui.dispose(); await disposeRemote() }
}

function register(ctx: Context): void {
  const api = () => ctx.remote.dishBrowser
  // `ctx.remote.$stream` reopens a generation that ends only when `ended` answers its own carrier error; `follow` can't make
  // one (it runs under Node too), so its error becomes one here.
  const stream = (options: StreamOptions<Down>): Stream<Down> => ctx.remote.$stream<Down>({
    ...options,
    ended: accepted => new RemoteStreamCarrierError(options.ended(accepted).message),
  })

  // One controller and one presence per chat. This scope ends when the remote goes (or the plugin does) and is made again
  // with the next one: what the ended one made must stop with it.
  const controllers = new Map<string, TabController>()
  const presences = new Map<string, { face: PresenceActions, dispose(): void }>()
  ctx.effect(() => () => {
    for (const controller of controllers.values()) controller.dispose()
    for (const presence of presences.values()) presence.dispose()
    controllers.clear()
    presences.clear()
  }, 'dish-browser: controllers')

  const tabFor = (sessionId: string): TabFace => {
    let controller = controllers.get(sessionId)
    if (controller === undefined) {
      controller = createTabController(api, stream)
      controllers.set(sessionId, controller)
    }
    return { ...controller.face, session: sessionId }
  }

  const presenceFor = (sessionId: string): PresenceFace => {
    let presence = presences.get(sessionId)
    if (presence === undefined) {
      presence = createPresence(api, stream, () => { ctx.sidebarRight.openTab(TAB_KIND) })
      presences.set(sessionId, presence)
    }
    return { ...presence.face, session: sessionId }
  }

  ctx.effect(() => ctx.sidebarRightTabs.register(TAB), 'dish-browser: tab type')

  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: TAB.id,
    inject: sessionId => tabFor(String(sessionId)),
  }, BrowserTab))

  ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab.title',
    key: TAB.id,
    inject: sessionId => tabFor(String(sessionId)),
  }, Title))

  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'dish-browser',
    order: HEADER_ORDER,
    inject: sessionId => presenceFor(String(sessionId)),
  }, HeaderButton))

  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview',
    key: 'browser_screenshot',
    inject: (sessionId) => {
      const session = String(sessionId)
      return { open: () => { ctx.sidebarRight.openTab(TAB_KIND, { params: { sessionId: session } }) } }
    },
  }, ScreenshotRow))
}
