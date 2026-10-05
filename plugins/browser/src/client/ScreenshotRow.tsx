/**
 * The `browser_screenshot` call's toolview: the owner of the hook that loads the image. A keyed toolview replaces dsh's
 * generic row for its key, so this one draws every phase itself (`ScreenshotView.tsx`):
 * - preparing or started: "Taking a screenshot…";
 * - a result with an image: the first image block's attachment, loaded with the row's own `loadImage`, and the page's URL and
 *   title from the result's `meta` (the tool's `presentationMeta`), read with type checks;
 * - a result without one (an error, or the judge's note), or an image that won't load: "Browser: screenshot" and the result's
 *   text.
 *
 * It never declares `tool.call.images`: that child slot belongs to the one toolview that declares it.
 */

import { useEffect, useState } from 'react'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { ScreenshotView } from './ScreenshotView.tsx'

type Props = ToolCallViewProps & InjectFace<{ open(): void }>

type Content = Extract<ToolCallViewProps, { phase: 'result' }>['block']['content']
type ImageRef = Extract<Content[number], { type: 'image' }>['attachment']

/** What became of loading `ref`. */
type Loading = { ref: ImageRef, url: string } | { ref: ImageRef, failed: true }

export function ScreenshotRow(props: Props) {
  const block = props.phase === 'result' ? props.block : undefined
  const image = block === undefined || block.isError ? undefined : firstImage(block.content)
  const { loadImage, open } = props
  const [loading, setLoading] = useState<Loading | undefined>(undefined)

  useEffect(() => {
    if (image === undefined) return
    const known = loadImage.peek?.(image)
    if (known !== undefined && known !== '') {
      setLoading({ ref: image, url: known })
      return
    }
    let live = true
    loadImage(image).then(
      (url) => { if (live) setLoading({ ref: image, url }) },
      () => { if (live) setLoading({ ref: image, failed: true }) },
    )
    return () => { live = false }
  }, [image, loadImage])

  if (block === undefined) return <ScreenshotView phase="running" open={open} />
  const mine = loading !== undefined && loading.ref === image ? loading : undefined
  if (image === undefined || (mine !== undefined && 'failed' in mine)) return <ScreenshotView phase="text" text={textOf(block.content)} open={open} />
  const loaded = mine !== undefined && 'url' in mine ? mine.url : undefined
  const meta = metaOf(block.meta)
  return <ScreenshotView phase="image" src={loaded} url={meta.url} title={meta.title} open={open} />
}

function firstImage(content: Content): ImageRef | undefined {
  for (const part of content) if (part.type === 'image') return part.attachment
  return undefined
}

function textOf(content: Content): string {
  return content.map(part => (part.type === 'text' ? part.text : '')).filter(text => text !== '').join('\n')
}

/** The page's URL and title from the result's `meta`, when they are strings. */
function metaOf(meta: unknown): { url?: string, title?: string } {
  if (typeof meta !== 'object' || meta === null) return {}
  const { url, title } = meta as { url?: unknown, title?: unknown }
  return {
    ...(typeof url === 'string' ? { url } : {}),
    ...(typeof title === 'string' ? { title } : {}),
  }
}
