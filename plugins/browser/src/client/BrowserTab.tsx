/**
 * The Browser tab's body: the owner of the hooks. Its state lives in the chat's controller (`controller.ts`); the toolbar, the
 * lines and the picture's frame are plain functions of their props (`TabView.tsx`); the picture's input is `Picture.tsx`'s.
 *
 * - **Which browser.** The session the tab is in, unless the tab was opened for another (`sessionId` in its parameters: the
 *   switcher, or a screenshot in a child's chat). A new one re-attaches the controller.
 * - **Frames only while seen:** the tab is visible (`tab.visible`) and so is the document.
 * - **The switcher** reopens this tab with the chosen session, through the tab's own `openTab`: a page type keeps one tab per
 *   pane, so it is this tab that navigates.
 * - dsh's refresh command reloads the page.
 */

import { useEffect, useState } from 'react'
import type { UseSidebarRightTabInfo } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { TabActions } from './controller.ts'
import { Picture } from './Picture.tsx'
import { TabView } from './TabView.tsx'
import type { TabViewActions } from './TabView.tsx'

/** The tab's kind: what `openTab` names. Not dsh's `browser`, whose own page owns that kind. */
export const TAB_KIND = 'dish-browser'

/** The chat's controller's face, with the chat the slot is for. */
export type TabFace = TabActions & { session: string }

type Props = InjectFace<TabFace> & { useTabInfo: UseSidebarRightTabInfo }

export function BrowserTab(props: Props) {
  const { useTab, useTabInfo, session, attach, detach, setVisible, reload } = props
  const { tab } = useTabInfo()
  const state = useTab(snapshot => snapshot)
  const target = requested(tab.navigation.params) ?? session

  useEffect(() => {
    attach(target)
    return () => { detach(target) }
  }, [attach, detach, target])

  const documentVisible = useDocumentVisible()
  const visible = tab.visible && documentVisible
  useEffect(() => { setVisible(visible) }, [setVisible, visible])
  useEffect(() => () => { setVisible(false) }, [setVisible])

  useEffect(() => tab.actions.bindCommands({ refresh: () => { reload() } }), [tab.actions, reload])

  const [editing, setEditing] = useState<string | undefined>(undefined)
  useEffect(() => { setEditing(undefined) }, [target])

  const actions: TabViewActions = {
    edit: setEditing,
    navigate: (text) => {
      props.navigate(text)
      setEditing(undefined)
    },
    back: props.back,
    forward: props.forward,
    reload: props.reload,
    close: props.close,
    choose: (sessionId) => {
      tab.actions.openTab(TAB_KIND, { params: sessionId === undefined ? {} : { sessionId } })
    },
    dismissNotice: props.dismissNotice,
  }
  const away = target === session ? undefined : { sessionId: target, label: props.labelOf(target) ?? 'A crew child’s browser' }
  const picture = state.frame !== undefined && (state.status === 'open' || state.status === 'closed')
    ? <Picture frame={state.frame} viewport={state.viewport} dimmed={state.status !== 'open'} send={props.send} ack={props.ack} />
    : null
  return <TabView state={state} editing={editing} actions={actions} picture={picture} away={away} />
}

/** The session the tab was opened for, from its parameters, read with type checks. */
function requested(params: unknown): string | undefined {
  if (typeof params !== 'object' || params === null) return undefined
  const value = (params as { sessionId?: unknown }).sessionId
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Whether the document is visible, followed through `visibilitychange`. */
function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible')
  useEffect(() => {
    const update = (): void => { setVisible(document.visibilityState === 'visible') }
    document.addEventListener('visibilitychange', update)
    update()
    return () => { document.removeEventListener('visibilitychange', update) }
  }, [])
  return visible
}
