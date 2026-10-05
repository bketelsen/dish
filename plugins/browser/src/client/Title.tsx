/** The Browser tab's chip: "Browser", or "Browser · <the page's title>", cut; as text. */

import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { TabFace } from './BrowserTab.tsx'
import { titleText } from './model.ts'

export function Title({ useTab }: InjectFace<TabFace>) {
  const title = useTab(state => state.title)
  return <span className="dish-browser-title">{titleText(title)}</span>
}
