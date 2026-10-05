/**
 * The chat header's "Browser" button: shown while the chat has an open browser, or one of its crew children does. Its
 * presence watches the chat with frames off (`createPresence`), so a chat left open keeps no browser alive. A click opens
 * the Browser tab.
 */

import { useEffect } from 'react'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { PresenceActions } from './controller.ts'

/** The chat's presence's face, with the chat the slot is for. */
export type PresenceFace = PresenceActions & { session: string }

export function HeaderButton({ useShown, attach, detach, open, session }: InjectFace<PresenceFace>) {
  useEffect(() => {
    attach(session)
    return () => { detach() }
  }, [attach, detach, session])
  const shown = useShown(value => value)
  if (!shown) return null
  return (
    <button type="button" className="dish-browser-header-button" title="What this chat’s agents see, live" onClick={() => { open() }}>
      Browser
    </button>
  )
}
