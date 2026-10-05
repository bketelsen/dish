/**
 * The live picture: the newest frame, drawn as large as the pane allows (keeping its shape), and the place where you use the
 * page. It is focusable; while it has focus, the pointer and the keys go to the page.
 *
 * - **The pointer.** `pointerdown` focuses the picture and captures the pointer (a drag that leaves it still ends in it).
 *   The press itself is sent from `mousedown`, whose `detail` is the click count (a pointer event's is always 0): a `move`
 *   to the point, then a `down`. A point outside the image is ignored. While a button is down, moves go at most every
 *   `MOVE_INTERVAL_MS`, the last one kept for the release; the release goes at the point (or the last one inside).
 * - **The wheel** is taken from the pane (a listener that may `preventDefault`), and turns are summed and sent at most every
 *   `MOVE_INTERVAL_MS`.
 * - **The keys** call `preventDefault()` and `stopPropagation()`, so dsh's shortcuts don't see them, and go up as `key`
 *   items. A paste (Ctrl or Cmd with V) is left to the `paste` event, which sends the clipboard's text; keys that aren't keys
 *   yet (an input method's, a dead key) are skipped, and a composition's end sends its text. The picture remembers what it
 *   pressed: leaving it (blur) releases each key, and a held button.
 * - **Acks.** Each frame is acked when its image has loaded (or failed to), so the host sends the next one; a frame whose
 *   source is the one already drawn is acked at once.
 * - A closed browser's picture is dimmed and takes no input: only the address bar starts a new browser.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type {
  ClipboardEvent, CompositionEvent, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent,
} from 'react'
import type { MouseButton, Up, Viewport } from '../protocol.ts'
import { MOVE_INTERVAL_MS, buttonOf, clickCountOf, fit, isPaste, keyMessage, pasteText, toViewport, wheelPixels } from './input.ts'
import type { KeyLike } from './input.ts'
import type { TabFrame } from './model.ts'
import { PictureFrame } from './TabView.tsx'

export interface PictureProps {
  frame: TabFrame
  viewport: Viewport
  dimmed: boolean
  send(up: Up): void
  ack(seq: number): void
}

type KeyUp = Extract<Up, { kind: 'key' }>

interface Held { button: MouseButton, clickCount: number, x: number, y: number }

interface Pace {
  /** When the last item went. */
  at: number
  timer: ReturnType<typeof setTimeout> | undefined
}

export function Picture({ frame, viewport, dimmed, send, ack }: PictureProps) {
  const box = useRef<HTMLDivElement | null>(null)
  const image = useRef<HTMLImageElement | null>(null)
  const [room, setRoom] = useState({ width: 0, height: 0 })
  // What the handlers and the listeners attached once need, as of the latest render.
  const latest = useRef({ viewport, dimmed, send })
  latest.current = { viewport, dimmed, send }
  const pressed = useRef(new Map<string, KeyUp>())
  const held = useRef<Held | undefined>(undefined)
  const moves = useRef<Pace & { pending: { x: number, y: number } | undefined }>({ at: 0, timer: undefined, pending: undefined })
  const wheel = useRef<Pace & { pending: { x: number, y: number, dx: number, dy: number } | undefined }>({ at: 0, timer: undefined, pending: undefined })
  /** The source last drawn. */
  const drawn = useRef<string | undefined>(undefined)

  /** The page's point for a client point, or undefined outside the image. */
  const locate = (clientX: number, clientY: number): { x: number, y: number } | undefined => {
    const element = image.current
    if (element === null) return undefined
    const rect = element.getBoundingClientRect()
    return toViewport(clientX, clientY, { left: rect.left, top: rect.top, width: rect.width, height: rect.height }, latest.current.viewport)
  }

  const sendMove = (point: { x: number, y: number }): void => {
    const button = held.current
    if (button === undefined) return
    moves.current.at = Date.now()
    button.x = point.x
    button.y = point.y
    latest.current.send({ kind: 'mouse', action: 'move', x: point.x, y: point.y, button: button.button, clickCount: 1 })
  }

  const flushMove = (): void => {
    const pace = moves.current
    pace.timer = undefined
    const point = pace.pending
    pace.pending = undefined
    if (point !== undefined) sendMove(point)
  }

  /** Release the held button at `point`, or where it last was. */
  const release = (point: { x: number, y: number } | undefined): void => {
    const button = held.current
    if (button === undefined) return
    const pace = moves.current
    if (pace.timer !== undefined) clearTimeout(pace.timer)
    pace.timer = undefined
    const at = point ?? pace.pending ?? { x: button.x, y: button.y }
    pace.pending = undefined
    if (at.x !== button.x || at.y !== button.y) sendMove(at)
    held.current = undefined
    latest.current.send({ kind: 'mouse', action: 'up', x: at.x, y: at.y, button: button.button, clickCount: button.clickCount })
  }

  const releaseKeys = (): void => {
    for (const up of pressed.current.values()) latest.current.send({ ...up, action: 'up' })
    pressed.current.clear()
  }

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

  // The wheel, from a listener that may prevent the pane from scrolling (React's own is passive).
  useEffect(() => {
    const element = box.current
    if (element === null) return
    const flush = (): void => {
      const pace = wheel.current
      pace.timer = undefined
      const turn = pace.pending
      pace.pending = undefined
      if (turn === undefined || (turn.dx === 0 && turn.dy === 0)) return
      pace.at = Date.now()
      latest.current.send({ kind: 'wheel', x: turn.x, y: turn.y, dx: turn.dx, dy: turn.dy })
    }
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      if (latest.current.dimmed) return
      const point = locate(event.clientX, event.clientY)
      if (point === undefined) return
      const { dx, dy } = wheelPixels(event, latest.current.viewport)
      const pace = wheel.current
      const pending = pace.pending
      pace.pending = { x: point.x, y: point.y, dx: (pending?.dx ?? 0) + dx, dy: (pending?.dy ?? 0) + dy }
      if (pace.timer !== undefined) return
      const wait = MOVE_INTERVAL_MS - (Date.now() - pace.at)
      if (wait <= 0) flush()
      else pace.timer = setTimeout(flush, wait)
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      element.removeEventListener('wheel', onWheel)
      if (wheel.current.timer !== undefined) clearTimeout(wheel.current.timer)
      wheel.current.timer = undefined
    }
  }, [])

  // Going away releases what the picture holds down, as leaving it does.
  useEffect(() => () => {
    if (moves.current.timer !== undefined) clearTimeout(moves.current.timer)
    moves.current.timer = undefined
    release(undefined)
    releaseKeys()
  }, [])

  // A frame the same as the one drawn loads nothing: ack it now, or the host would wait for an ack that never comes.
  useEffect(() => {
    if (drawn.current === frame.src) ack(frame.seq)
  }, [frame.seq])

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
          if (latest.current.dimmed || held.current !== undefined) return
          const button = buttonOf(event.button)
          const point = locate(event.clientX, event.clientY)
          if (button === undefined || point === undefined) return
          event.preventDefault()
          const clickCount = clickCountOf(event.detail)
          held.current = { button, clickCount, x: point.x, y: point.y }
          moves.current.at = Date.now()
          send({ kind: 'mouse', action: 'move', x: point.x, y: point.y, button, clickCount: 1 })
          send({ kind: 'mouse', action: 'down', x: point.x, y: point.y, button, clickCount })
        },
        onMouseMove: (event: ReactMouseEvent<HTMLDivElement>) => {
          if (held.current === undefined) return
          const point = locate(event.clientX, event.clientY)
          if (point === undefined) return
          const pace = moves.current
          if (pace.timer === undefined && Date.now() - pace.at >= MOVE_INTERVAL_MS) {
            sendMove(point)
            return
          }
          pace.pending = point
          if (pace.timer === undefined) pace.timer = setTimeout(flushMove, Math.max(0, MOVE_INTERVAL_MS - (Date.now() - pace.at)))
        },
        onMouseUp: (event: ReactMouseEvent<HTMLDivElement>) => {
          if (held.current === undefined || buttonOf(event.button) !== held.current.button) return
          event.preventDefault()
          release(locate(event.clientX, event.clientY))
        },
        onContextMenu: (event: ReactMouseEvent<HTMLDivElement>) => { event.preventDefault() },
        onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => {
          event.stopPropagation()
          const like = keyOf(event)
          // A paste is the `paste` event's: the browser makes it only if the key goes on.
          if (isPaste(like)) return
          const up = keyMessage(like, 'down')
          if (up === undefined || up.kind !== 'key') return
          event.preventDefault()
          if (latest.current.dimmed) return
          pressed.current.set(event.code === '' ? event.key : event.code, up)
          send(up)
        },
        onKeyUp: (event: ReactKeyboardEvent<HTMLDivElement>) => {
          event.stopPropagation()
          const id = event.code === '' ? event.key : event.code
          const down = pressed.current.get(id)
          if (down === undefined) return
          event.preventDefault()
          pressed.current.delete(id)
          const up = keyMessage(keyOf(event), 'up')
          send(up !== undefined && up.kind === 'key' ? up : { ...down, action: 'up' })
        },
        onBlur: () => {
          release(undefined)
          releaseKeys()
        },
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
        onLoad: () => {
          drawn.current = frame.src
          ack(frame.seq)
        },
        onError: () => {
          drawn.current = frame.src
          ack(frame.seq)
        },
      }}
    />
  )
}
