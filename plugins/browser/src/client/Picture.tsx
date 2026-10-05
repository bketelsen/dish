/**
 * The live picture: the newest frame, drawn as large as the pane allows (keeping its shape) at the top of its area, and the
 * place where you use the page. It is focusable; while it has focus, the pointer and the keys go to the page. What goes up,
 * and when, is the pacer's (`createInputPacer` in `input.ts`, tested there); this file turns events into its calls.
 *
 * - **The pointer.** `pointerdown` focuses the picture and captures the pointer (a drag that leaves it still ends in it).
 *   The press itself comes from `mousedown`, whose `detail` is the click count (a pointer event's is always 0). A point
 *   outside the image is ignored; a release outside it ends where the pointer last was inside.
 * - **The wheel** is taken from the pane (a listener that may `preventDefault`; React's own is passive).
 * - **The keys** call `preventDefault()` and `stopPropagation()`, so dsh's shortcuts don't see them. A paste (Ctrl or Cmd
 *   with V) is left to the `paste` event, which sends the clipboard's text; keys that aren't keys yet (an input method's, a
 *   dead key) are skipped, and a composition's end sends its text. Leaving the picture (blur), or the picture going, releases
 *   what it holds down.
 * - **Acks.** A frame is acked when its image has loaded, or failed to. A frame that draws nothing new (the source already
 *   shown) is the controller's to ack: no load event comes for it.
 * - A closed browser's picture is dimmed and takes no input: only the address bar starts a new browser.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type {
  ClipboardEvent, CompositionEvent, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent,
} from 'react'
import type { Up, Viewport } from '../protocol.ts'
import { buttonOf, clickCountOf, createInputPacer, fit, isPaste, keyMessage, pasteText, toViewport, wheelPixels } from './input.ts'
import type { InputPacer, KeyLike, Point } from './input.ts'
import type { TabFrame } from './model.ts'
import { PictureFrame } from './TabView.tsx'

export interface PictureProps {
  frame: TabFrame
  viewport: Viewport
  dimmed: boolean
  send(up: Up): void
  ack(seq: number): void
}

export function Picture({ frame, viewport, dimmed, send, ack }: PictureProps) {
  const box = useRef<HTMLDivElement | null>(null)
  const image = useRef<HTMLImageElement | null>(null)
  const [room, setRoom] = useState({ width: 0, height: 0 })
  // What the handlers and the listeners attached once need, as of the latest render.
  const latest = useRef({ viewport, dimmed, send })
  latest.current = { viewport, dimmed, send }
  const pacer = useRef<InputPacer | undefined>(undefined)

  /** The page's point for a client point, or undefined outside the image. */
  const locate = (clientX: number, clientY: number): Point | undefined => {
    const element = image.current
    if (element === null) return undefined
    const rect = element.getBoundingClientRect()
    return toViewport(clientX, clientY, { left: rect.left, top: rect.top, width: rect.width, height: rect.height }, latest.current.viewport)
  }

  // The pacer lives as long as the picture; going away releases what it holds down, as leaving it does.
  useEffect(() => {
    const made = createInputPacer((up) => { latest.current.send(up) })
    pacer.current = made
    return () => {
      made.releaseAll()
      made.dispose()
      if (pacer.current === made) pacer.current = undefined
    }
  }, [])

  // The room: the box fills the stage, so its size is the pane's, whatever the image's.
  useLayoutEffect(() => {
    const element = box.current
    if (element === null) return
    const measure = (): void => {
      const rect = element.getBoundingClientRect()
      setRoom(previous => (previous.width === rect.width && previous.height === rect.height ? previous : { width: rect.width, height: rect.height }))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [])

  // The wheel, from a listener that may keep the pane from scrolling.
  useEffect(() => {
    const element = box.current
    if (element === null) return
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      if (latest.current.dimmed) return
      const point = locate(event.clientX, event.clientY)
      if (point === undefined) return
      const { dx, dy } = wheelPixels(event, latest.current.viewport)
      pacer.current?.wheel(point, dx, dy)
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => { element.removeEventListener('wheel', onWheel) }
  }, [])

  const keyOf = (event: ReactKeyboardEvent<HTMLDivElement>): KeyLike => ({
    key: event.key,
    code: event.code,
    isComposing: event.nativeEvent.isComposing,
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey,
  })

  const size = fit(room, { width: frame.width, height: frame.height })

  return (
    <PictureFrame
      source={frame.src}
      width={size.width > 0 ? size.width : undefined}
      height={size.height > 0 ? size.height : undefined}
      dimmed={dimmed}
      boxRef={box}
      imageRef={image}
      handlers={{
        onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => {
          event.currentTarget.focus({ preventScroll: true })
          if (latest.current.dimmed || buttonOf(event.button) === undefined || locate(event.clientX, event.clientY) === undefined) return
          try {
            event.currentTarget.setPointerCapture(event.pointerId)
          } catch {
            // The pointer is gone already.
          }
        },
        onMouseDown: (event: ReactMouseEvent<HTMLDivElement>) => {
          event.currentTarget.focus({ preventScroll: true })
          const current = pacer.current
          if (latest.current.dimmed || current === undefined || current.holding()) return
          const button = buttonOf(event.button)
          const point = locate(event.clientX, event.clientY)
          if (button === undefined || point === undefined) return
          event.preventDefault()
          current.press(point, button, clickCountOf(event.detail))
        },
        onMouseMove: (event: ReactMouseEvent<HTMLDivElement>) => {
          const current = pacer.current
          if (current === undefined || !current.holding()) return
          current.move(locate(event.clientX, event.clientY))
        },
        onMouseUp: (event: ReactMouseEvent<HTMLDivElement>) => {
          const current = pacer.current
          const button = buttonOf(event.button)
          if (current === undefined || !current.holding() || button === undefined) return
          event.preventDefault()
          current.release(button, locate(event.clientX, event.clientY))
        },
        onContextMenu: (event: ReactMouseEvent<HTMLDivElement>) => { event.preventDefault() },
        onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => {
          event.stopPropagation()
          const like = keyOf(event)
          // A paste is the `paste` event's: the browser makes it only if the key goes on.
          if (isPaste(like)) return
          const item = keyMessage(like, 'down')
          if (item === undefined || item.kind !== 'key') return
          event.preventDefault()
          if (latest.current.dimmed) return
          pacer.current?.keyDown(event.code === '' ? event.key : event.code, item)
        },
        onKeyUp: (event: ReactKeyboardEvent<HTMLDivElement>) => {
          event.stopPropagation()
          const item = keyMessage(keyOf(event), 'up')
          const sent = pacer.current?.keyUp(event.code === '' ? event.key : event.code, item !== undefined && item.kind === 'key' ? item : undefined)
          if (sent === true) event.preventDefault()
        },
        onBlur: () => { pacer.current?.releaseAll() },
        onPaste: (event: ClipboardEvent<HTMLDivElement>) => {
          event.preventDefault()
          event.stopPropagation()
          if (latest.current.dimmed) return
          const text = pasteText(event.clipboardData.getData('text/plain'))
          if (text !== undefined) send({ kind: 'text', text })
        },
        onCompositionEnd: (event: CompositionEvent<HTMLDivElement>) => {
          if (latest.current.dimmed) return
          const text = pasteText(event.data)
          if (text !== undefined) send({ kind: 'text', text })
        },
        onLoad: () => { ack(frame.seq) },
        onError: () => { ack(frame.seq) },
      }}
    />
  )
}
