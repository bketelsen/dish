/**
 * The `browser_screenshot` call's row in the chat, as a plain function of its props: while it runs, a line; with an image, the
 * image and the page's URL and title under it, which open the Browser tab on this chat; without one (an error, or the judge's
 * note), "Browser: screenshot" and the result's text. No hooks and nothing from dsh, so a test renders it under Node;
 * `ScreenshotRow.tsx` loads the image and hands it here.
 *
 * Everything from the page is text. The one source is the image `loadImage` answered for the result's attachment.
 */

export interface ScreenshotViewProps {
  phase: 'running' | 'image' | 'text'
  /** The image's source, once `loadImage` has answered. */
  src?: string | undefined
  url?: string | undefined
  title?: string | undefined
  /** The result's text, for `text`. */
  text?: string | undefined
  /** Open the Browser tab on this chat. */
  open(): void
}

export function ScreenshotView({ phase, src, url, title, text, open }: ScreenshotViewProps) {
  if (phase === 'running') {
    return (
      <div className="dish-browser-shot">
        <span className="dish-browser-shot-line">Taking a screenshot…</span>
      </div>
    )
  }
  if (phase === 'text') {
    return (
      <div className="dish-browser-shot">
        <span className="dish-browser-shot-head">Browser: screenshot</span>
        {text !== undefined && text !== '' && <div className="dish-browser-shot-text">{text}</div>}
      </div>
    )
  }
  return (
    <div className="dish-browser-shot">
      <button type="button" className="dish-browser-shot-open" title="Open the Browser tab" onClick={() => { open() }}>
        {src !== undefined && src !== ''
          ? <img className="dish-browser-shot-image" src={src} alt="A screenshot of the page" />
          : <span className="dish-browser-shot-line">Loading the screenshot…</span>}
        {url !== undefined && url !== '' && <span className="dish-browser-shot-url">{url}</span>}
        {title !== undefined && title !== '' && <span className="dish-browser-shot-title">{title}</span>}
      </button>
    </div>
  )
}
