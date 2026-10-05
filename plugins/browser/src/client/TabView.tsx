/**
 * The Browser tab's face, as plain functions of their props: the toolbar, the switcher, the lines, and the picture's frame.
 * No hooks and nothing from dsh, so a test renders them under Node (`test/client-rendering.test.ts`); `BrowserTab.tsx` and
 * `Picture.tsx` hold the hooks and hand these what to show and what to call.
 *
 * Everything from the host is text: the URL is the address input's value, a child's label an option's text, a reason and a
 * notice a line's text. The one source is the frame's, a JPEG data source `model.ts` built from base64.
 */

import type {
  ClipboardEvent, CompositionEvent, FocusEvent, KeyboardEvent, MouseEvent, PointerEvent, ReactElement, Ref, SyntheticEvent,
} from 'react'
import type { TabState } from './model.ts'

/** What the tab's controls call. */
export interface TabViewActions {
  /** The address being typed; undefined when not editing. */
  edit(text: string | undefined): void
  navigate(text: string): void
  back(): void
  forward(): void
  reload(): void
  close(): void
  /** The switcher: undefined is "This chat". */
  choose(sessionId: string | undefined): void
  dismissNotice(): void
}

export interface TabViewProps {
  state: TabState
  /** What is typed in the address bar; undefined shows the page's URL. */
  editing: string | undefined
  actions: TabViewActions
  /** The live picture (`Picture`), or null when there is no frame. */
  picture: ReactElement | null
  /** The crew child whose browser the tab shows, when it isn't this chat's own. */
  away?: { sessionId: string, label: string } | undefined
}

export function TabView({ state, editing, actions, picture, away }: TabViewProps) {
  const open = state.status === 'open'
  const addressOn = open || state.canStart
  return (
    <div className="dish-browser">
      <div className="dish-browser-toolbar">
        <button type="button" className="dish-browser-tool" aria-label="Back" title="Back" disabled={!open || !state.canGoBack} onClick={() => { actions.back() }}>←</button>
        <button type="button" className="dish-browser-tool" aria-label="Forward" title="Forward" disabled={!open || !state.canGoForward} onClick={() => { actions.forward() }}>→</button>
        <button type="button" className="dish-browser-tool" aria-label="Reload" title="Reload" disabled={!open} onClick={() => { actions.reload() }}>↻</button>
        <form
          className="dish-browser-address-form"
          onSubmit={(event) => {
            event.preventDefault()
            actions.navigate(editing ?? state.url)
          }}
        >
          <input
            type="text"
            className="dish-browser-address"
            aria-label="Address"
            autoComplete="off"
            spellCheck={false}
            value={editing ?? state.url}
            disabled={!addressOn}
            onChange={(event) => { actions.edit(event.currentTarget.value) }}
            onKeyDown={(event) => { if (event.key === 'Escape') actions.edit(undefined) }}
            onBlur={() => { actions.edit(undefined) }}
          />
        </form>
        {open && <button type="button" className="dish-browser-close" onClick={() => { actions.close() }}>Close</button>}
      </div>
      <Switcher state={state} away={away} choose={actions.choose} />
      {state.acting && <p className="dish-browser-line dish-browser-acting">The agent is using this browser.</p>}
      {state.sandboxOff && <p className="dish-browser-line dish-browser-warn">Chromium runs without its own sandbox on this host.</p>}
      {state.connection === 'down' && <p className="dish-browser-line">Reconnecting…</p>}
      {state.notice !== undefined && (
        <div className="dish-browser-notice" role="status" aria-live="polite">
          <span className="dish-browser-notice-text">{state.notice}</span>
          <button type="button" className="dish-browser-dismiss" aria-label="Dismiss" title="Dismiss" onClick={() => { actions.dismissNotice() }}>×</button>
        </div>
      )}
      <div className="dish-browser-stage">
        <Body state={state} picture={picture} />
      </div>
    </div>
  )
}

/** The chooser between this chat's browser and its crew children's. Shown when there are children, or while one is shown. */
function Switcher({ state, away, choose }: { state: TabState, away: TabViewProps['away'], choose: TabViewActions['choose'] }) {
  if (state.children.length === 0 && away === undefined) return null
  const listed = away !== undefined && state.children.some(child => child.sessionId === away.sessionId)
  return (
    <div className="dish-browser-switch">
      <select
        aria-label="Browser"
        className="dish-browser-switcher"
        value={away?.sessionId ?? ''}
        onChange={(event) => {
          const value = event.currentTarget.value
          choose(value === '' ? undefined : value)
        }}
      >
        <option value="">This chat</option>
        {away !== undefined && !listed && <option value={away.sessionId}>{away.label}</option>}
        {state.children.map(child => <option key={child.sessionId} value={child.sessionId}>{child.label}</option>)}
      </select>
    </div>
  )
}

/** What the stage shows for each state, in the spec's words, with the picture where there is one. */
function Body({ state, picture }: { state: TabState, picture: ReactElement | null }) {
  switch (state.status) {
    case 'unknown':
      return <p className="dish-browser-message">{state.connection === 'down' ? 'Can’t reach dish-browser right now.' : 'Connecting…'}</p>
    case 'none':
      return (
        <p className="dish-browser-message">
          {state.canStart
            ? 'No browser in this chat yet. An agent\'s first browser call starts one, or open a page here.'
            : 'No browser in this chat yet. An agent\'s first browser call starts one.'}
        </p>
      )
    case 'open':
      return picture ?? <p className="dish-browser-message">Waiting for the page’s picture…</p>
    case 'closed': {
      const why = state.reason === '' ? 'This browser closed.' : `This browser closed (${state.reason}).`
      return (
        <>
          <p className="dish-browser-message">
            {`${why} Its cookies and sign-ins are gone.${state.canStart ? ' Open a page to start a new one.' : ''}`}
          </p>
          {picture}
        </>
      )
    }
    case 'unavailable':
      return <p className="dish-browser-message">{state.reason === '' ? 'No browser on this host.' : state.reason}</p>
    case 'refused':
      return <p className="dish-browser-message">{state.reason === '' ? 'This chat’s browser can’t be shown.' : state.reason}</p>
    default:
      return null
  }
}

/** The picture's handlers, from `Picture.tsx`. */
export interface PictureHandlers {
  onKeyDown(event: KeyboardEvent<HTMLDivElement>): void
  onKeyUp(event: KeyboardEvent<HTMLDivElement>): void
  onBlur(event: FocusEvent<HTMLDivElement>): void
  onPaste(event: ClipboardEvent<HTMLDivElement>): void
  onCompositionEnd(event: CompositionEvent<HTMLDivElement>): void
  onContextMenu(event: MouseEvent<HTMLDivElement>): void
  onPointerDown(event: PointerEvent<HTMLDivElement>): void
  onMouseDown(event: MouseEvent<HTMLDivElement>): void
  onMouseMove(event: MouseEvent<HTMLDivElement>): void
  onMouseUp(event: MouseEvent<HTMLDivElement>): void
  onLoad(event: SyntheticEvent<HTMLImageElement>): void
  onError(event: SyntheticEvent<HTMLImageElement>): void
}

export interface PictureFrameProps {
  /** The frame's `data:image/jpeg;base64,…` source. */
  source: string
  /** The drawn size (`fit`); undefined until the room is known. */
  width: number | undefined
  height: number | undefined
  /** A closed browser's last picture. */
  dimmed: boolean
  handlers: PictureHandlers
  boxRef?: Ref<HTMLDivElement> | undefined
  imageRef?: Ref<HTMLImageElement> | undefined
}

/**
 * The picture: a focusable box that takes the pointer and the keys while it has focus, holding the frame. Its handlers are
 * `Picture`'s.
 */
export function PictureFrame({ source, width, height, dimmed, handlers, boxRef, imageRef }: PictureFrameProps) {
  return (
    <div
      ref={boxRef}
      className={dimmed ? 'dish-browser-picture dish-browser-picture-dimmed' : 'dish-browser-picture'}
      tabIndex={0}
      role="application"
      aria-label="The page, live: click to use it"
      onKeyDown={handlers.onKeyDown}
      onKeyUp={handlers.onKeyUp}
      onBlur={handlers.onBlur}
      onPaste={handlers.onPaste}
      onCompositionEnd={handlers.onCompositionEnd}
      onContextMenu={handlers.onContextMenu}
      onPointerDown={handlers.onPointerDown}
      onMouseDown={handlers.onMouseDown}
      onMouseMove={handlers.onMouseMove}
      onMouseUp={handlers.onMouseUp}
    >
      <img
        ref={imageRef}
        className="dish-browser-frame"
        src={source}
        alt=""
        draggable={false}
        width={width}
        height={height}
        onLoad={handlers.onLoad}
        onError={handlers.onError}
      />
    </div>
  )
}
