/**
 * `urls.ts`: what the agent's browser may open, typed or asked for by a page (the spec's URLs table).
 *
 * The file system part runs in scratch directories: a workspace with a file, a directory, a symbolic link that stays in and
 * one that leads out, a directory outside it, and one under the machine's `/tmp` itself. `/etc/hosts` stands for a file
 * that is outside both the workspace and `/tmp`.
 */

import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { UrlCheck, UrlPlaces } from '../src/types.ts'
import { checkUrl, isLoopbackHost, isOwnUrl, resolveUrl, rules, sharedTmpOf } from '../src/urls.ts'

const TOKEN = `ghp_${'A1b2C3d4E5'.repeat(4)}`
const OWN = { port: 3080, trustedHost: 'dish.example.ts.net' }
const OUTSIDE = '/etc/hosts'

let base = ''
let workspace = ''
let outsideDir = ''
let tmpPlace = ''

before(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'dish-browser-urls-')))
  workspace = join(base, 'work')
  mkdirSync(join(workspace, 'docs'), { recursive: true })
  writeFileSync(join(workspace, 'index.html'), '<h1>hi</h1>')
  writeFileSync(join(workspace, 'docs', 'a b.html'), '<p>a b</p>')
  symlinkSync(join(workspace, 'index.html'), join(workspace, 'in-link.html'))
  symlinkSync(OUTSIDE, join(workspace, 'out-link'))
  outsideDir = join(base, 'elsewhere')
  mkdirSync(outsideDir)
  writeFileSync(join(outsideDir, 'secret.txt'), 'x')
  // The machine's /tmp itself, whatever the test's TMPDIR is: what `sharedTmp` lets in.
  tmpPlace = realpathSync(mkdtempSync('/tmp/dish-browser-urls-tmp-'))
  writeFileSync(join(tmpPlace, 'report.html'), '<p>report</p>')
})

after(() => {
  if (base !== '') rmSync(base, { recursive: true, force: true })
  if (tmpPlace !== '') rmSync(tmpPlace, { recursive: true, force: true })
})

function places(extra: Partial<UrlPlaces> = {}): UrlPlaces {
  return { workspace, sharedTmp: false, own: OWN, ...extra }
}

function fileUrl(path: string): string {
  return pathToFileURL(path).href
}

function ok(check: UrlCheck): string {
  assert.ok(check.ok, `refused: ${check.ok ? '' : check.reason}`)
  return check.url
}

function refused(check: UrlCheck): { what: string, reason: string } {
  assert.ok(!check.ok, `opened: ${check.ok ? check.url : ''}`)
  return { what: check.what, reason: check.reason }
}

const SCHEME_TAIL = ' addresses aren\'t opened here: only http, https, file:// in this chat\'s workspace, and about:blank.'

// --- the table, typed and from the page ------------------------------------------------------------------------------

test('http and https open, on any host, typed and from the page', async () => {
  for (const url of [
    'http://localhost:5173/',
    'http://127.0.0.1:5173/items/3',
    'http://192.168.1.10:8080/',
    'https://example.com/a?b=1#c',
    'http://[::1]:3000/',
  ]) {
    assert.equal(ok(await resolveUrl(url, places())), url)
    assert.equal(ok(await checkUrl(url, places(), 'typed')), url)
    assert.equal(ok(await checkUrl(url, places(), 'page')), url)
  }
  assert.equal(ok(await resolveUrl('  HTTPS://Example.COM  ', places())), 'https://example.com/', 'trimmed, and the parsed href')
})

test('a bare host gets http:// on loopback and https:// elsewhere', async () => {
  const cases: Array<[string, string]> = [
    ['localhost:5173/x', 'http://localhost:5173/x'],
    ['localhost', 'http://localhost/'],
    ['127.0.0.1:8080', 'http://127.0.0.1:8080/'],
    ['[::1]:3000', 'http://[::1]:3000/'],
    ['app.localhost', 'http://app.localhost/'],
    ['example.com', 'https://example.com/'],
    ['example.com:8443/a', 'https://example.com:8443/a'],
    ['example.com/search?q=a:b#top', 'https://example.com/search?q=a:b#top'],
  ]
  for (const [input, url] of cases) assert.equal(ok(await resolveUrl(input, places())), url, input)
})

test('an absolute path is a file:// URL, then checked', async () => {
  const index = join(workspace, 'index.html')
  assert.equal(ok(await resolveUrl(index, places())), fileUrl(index))
  assert.equal(ok(await resolveUrl(join(workspace, 'docs', 'a b.html'), places())), fileUrl(join(workspace, 'docs', 'a b.html')))
  const out = refused(await resolveUrl(OUTSIDE, places()))
  assert.equal(out.what, OUTSIDE)
  assert.equal(out.reason, `file:///etc/hosts is outside this chat's workspace (${workspace}).`)
})

test('file:// inside the workspace opens: a file, a directory, the root, a link that stays in', async () => {
  for (const path of [join(workspace, 'index.html'), join(workspace, 'docs'), workspace, join(workspace, 'in-link.html')]) {
    assert.equal(ok(await checkUrl(fileUrl(path), places(), 'typed')), fileUrl(path), path)
    assert.equal(ok(await checkUrl(fileUrl(path), places(), 'page')), fileUrl(path), path)
  }
  assert.equal(ok(await checkUrl(`file://localhost${join(workspace, 'index.html')}`, places(), 'typed')), fileUrl(join(workspace, 'index.html')))
})

test('file:// on another host (a share on another machine) is refused in its own words, not the scheme\'s', async () => {
  for (const sharedTmp of [false, true]) {
    for (const from of ['typed', 'page'] as const) {
      const share = refused(await checkUrl(`file://nas${join(workspace, 'index.html')}`, places({ sharedTmp }), from))
      assert.deepEqual(share, {
        what: 'file://nas/',
        reason: `file://nas/ addresses (a file on another machine) aren't opened here: only file:/// paths in this chat's workspace${sharedTmp ? ' or /tmp' : ''}.`,
      }, `${from}, sharedTmp ${sharedTmp}`)
    }
  }
  assert.equal(refused(await resolveUrl('file://Server.Example/x', places())).what, 'file://server.example/')
})

test('file:// outside the workspace, through a link out, or missing is refused', async () => {
  const outside = refused(await checkUrl(fileUrl(join(outsideDir, 'secret.txt')), places(), 'page'))
  assert.equal(outside.what, join(outsideDir, 'secret.txt'))
  assert.equal(outside.reason, `${fileUrl(join(outsideDir, 'secret.txt'))} is outside this chat's workspace (${workspace}).`)

  const linkOut = refused(await checkUrl(fileUrl(join(workspace, 'out-link')), places(), 'typed'))
  assert.equal(linkOut.what, join(workspace, 'out-link'))
  assert.equal(linkOut.reason, `${fileUrl(join(workspace, 'out-link'))} is outside this chat's workspace (${workspace}).`)

  const missing = refused(await checkUrl(fileUrl(join(workspace, 'nope.html')), places(), 'typed'))
  assert.equal(missing.what, join(workspace, 'nope.html'))
  assert.equal(missing.reason, `${fileUrl(join(workspace, 'nope.html'))} doesn't exist.`)

  // A sibling whose name starts with the workspace's is outside: the boundary is a `/`.
  mkdirSync(`${workspace}-two`, { recursive: true })
  writeFileSync(join(`${workspace}-two`, 'x.html'), 'x')
  refused(await checkUrl(fileUrl(join(`${workspace}-two`, 'x.html')), places(), 'typed'))
})

test('file:// with no workspace: refused with the reason, except under /tmp when it counts', async () => {
  const index = fileUrl(join(workspace, 'index.html'))
  const none = refused(await checkUrl(index, places({ workspace: undefined }), 'typed'))
  assert.equal(none.reason, `dish doesn't know this chat's workspace yet, so ${index} can't open: a file:// page opens once the chat's agent has used the browser, or while it is running.`)
  const report = fileUrl(join(tmpPlace, 'report.html'))
  assert.equal(ok(await checkUrl(report, places({ workspace: undefined, sharedTmp: true }), 'typed')), report)
  refused(await checkUrl(report, places({ workspace: undefined, sharedTmp: false }), 'typed'))
  refused(await checkUrl(fileUrl(OUTSIDE), places({ workspace: undefined, sharedTmp: true }), 'typed'))
})

test('file:// under /tmp opens only when /tmp counts', async () => {
  const report = fileUrl(join(tmpPlace, 'report.html'))
  assert.equal(ok(await checkUrl(report, places({ sharedTmp: true }), 'page')), report)
  const no = refused(await checkUrl(report, places({ sharedTmp: false }), 'page'))
  assert.equal(no.reason, `${report} is outside this chat's workspace (${workspace}).`)
  const both = refused(await checkUrl(fileUrl(OUTSIDE), places({ sharedTmp: true }), 'page'))
  assert.equal(both.reason, `file:///etc/hosts is outside this chat's workspace (${workspace}) and /tmp.`)
})

test('about:blank opens, with a query or a fragment; any other about: is refused', async () => {
  for (const url of ['about:blank', 'about:blank?x=1', 'about:blank#top']) {
    assert.equal(ok(await resolveUrl(url, places())), url)
    assert.equal(ok(await checkUrl(url, places(), 'page')), url)
  }
  const config = refused(await resolveUrl('about:config', places()))
  assert.deepEqual(config, { what: 'about:', reason: `about:${SCHEME_TAIL}` })
  refused(await checkUrl('about:srcdoc', places(), 'page'))
})

test('the scheme refusal says /tmp where it counts', async () => {
  const tmpTail = ' addresses aren\'t opened here: only http, https, file:// in this chat\'s workspace or /tmp, and about:blank.'
  assert.deepEqual(refused(await resolveUrl('javascript:alert(1)', places({ sharedTmp: true }))), { what: 'javascript:', reason: `javascript:${tmpTail}` })
  assert.deepEqual(refused(await checkUrl('chrome://settings', places({ sharedTmp: true }), 'page')), { what: 'chrome:', reason: `chrome:${tmpTail}` })
  assert.deepEqual(refused(await checkUrl('about:config', places({ workspace: undefined, sharedTmp: true }), 'typed')), { what: 'about:', reason: `about:${tmpTail}` })
})

test('every other scheme is refused, typed and from the page', async () => {
  for (const [url, scheme] of [
    ['chrome://settings', 'chrome:'],
    ['javascript:alert(1)', 'javascript:'],
    ['data:text/html,<h1>hi</h1>', 'data:'],
    ['view-source:http://example.com/', 'view-source:'],
    ['blob:http://localhost:5173/0b5c1f3e', 'blob:'],
    ['ftp://example.com/x', 'ftp:'],
    ['ws://localhost:5173/', 'ws:'],
    ['mailto:a@example.com', 'mailto:'],
  ]) {
    assert.deepEqual(refused(await resolveUrl(url, places())), { what: scheme, reason: `${scheme}${SCHEME_TAIL}` }, url)
    assert.deepEqual(refused(await checkUrl(url, places(), 'page')), { what: scheme, reason: `${scheme}${SCHEME_TAIL}` }, url)
  }
})

test('chrome-error: is let through from the page only', async () => {
  const error = 'chrome-error://chromewebdata/'
  assert.equal(ok(await checkUrl(error, places(), 'page')), error)
  assert.deepEqual(refused(await checkUrl(error, places(), 'typed')), { what: 'chrome-error:', reason: `chrome-error:${SCHEME_TAIL}` })
  refused(await resolveUrl(error, places()))
})

test('dsh\'s own address is refused, typed and from the page, on every loopback name and the trusted host', async () => {
  for (const url of [
    'http://localhost:3080/',
    'http://127.0.0.1:3080/api',
    'http://127.0.0.2:3080/',
    'http://0.0.0.0:3080/',
    'http://[::1]:3080/',
    'http://[::]:3080/',
    'http://app.localhost:3080/',
    'https://dish.example.ts.net/',
    'https://DISH.example.ts.net:8443/x',
  ]) {
    const typed = refused(await resolveUrl(url, places()))
    assert.equal(typed.what, 'dsh\'s own address', url)
    assert.match(typed.reason, / is dsh's own address; dish doesn't open it in this browser\.$/)
    refused(await checkUrl(url, places(), 'page'))
  }
  const bare = refused(await resolveUrl('localhost:3080', places()))
  assert.equal(bare.reason, 'http://localhost:3080/ is dsh\'s own address; dish doesn\'t open it in this browser.')
  // Another loopback port is a dev server.
  assert.equal(ok(await resolveUrl('http://localhost:3081/', places())), 'http://localhost:3081/')
  assert.equal(ok(await resolveUrl('http://127.0.0.1:5173/', places())), 'http://127.0.0.1:5173/')
})

test('the refusal words are masked and on one line', async () => {
  const own = refused(await resolveUrl(`http://localhost:3080/?token=${TOKEN}`, places()))
  assert.ok(!own.reason.includes(TOKEN))
  assert.equal(own.reason, 'http://localhost:3080/?token=‹secret: a GitHub token› is dsh\'s own address; dish doesn\'t open it in this browser.')
  const bad = refused(await resolveUrl(`http://[${TOKEN}`, places()))
  assert.equal(bad.reason, 'http://[‹secret: a GitHub token› isn\'t a URL.')
  const long = refused(await checkUrl(`http://localhost:3080/${'a'.repeat(1000)}`, places(), 'page'))
  assert.ok(long.reason.length < 400)
  assert.ok(!long.reason.includes('\n'))
})

test('resolveUrl: empty, too long, and not a URL', async () => {
  assert.deepEqual(await resolveUrl('', places()), { ok: false, what: '', reason: 'The address is empty.' })
  assert.deepEqual(await resolveUrl(' \n\t ', places()), { ok: false, what: '', reason: 'The address is empty.' })
  assert.deepEqual(await resolveUrl(`https://example.com/${'a'.repeat(4096)}`, places()), {
    ok: false, what: '', reason: 'The address is too long (4,096 characters at most).',
  })
  assert.equal(ok(await resolveUrl(`https://example.com/${'a'.repeat(4096 - 20)}`, places())).length, 4096)
  const bad = refused(await resolveUrl('http://[bad', places()))
  assert.equal(bad.reason, 'http://[bad isn\'t a URL.')
  const bareBad = refused(await resolveUrl('exa mple.com', places()))
  assert.equal(bareBad.reason, 'exa mple.com isn\'t a URL.')
})

test('rules: the three functions, as UrlRules', async () => {
  assert.equal(rules.resolve, resolveUrl)
  assert.equal(rules.check, checkUrl)
  assert.equal(rules.own('ws://127.0.0.1:3080/socket', OWN), true)
  assert.equal(rules.own('ws://127.0.0.1:5173/socket', OWN), false)
})

// --- the parts ---------------------------------------------------------------------------------------------------------

test('isOwnUrl: schemes, ports, and the trusted host on any port', () => {
  assert.equal(isOwnUrl('ws://localhost:3080/', OWN), true)
  assert.equal(isOwnUrl('wss://dish.example.ts.net/ws', OWN), true)
  assert.equal(isOwnUrl('http://dish.example.ts.net:1234/', OWN), true)
  assert.equal(isOwnUrl('http://dish.example.ts.net./', OWN), true, 'a trailing dot is the same host')
  assert.equal(isOwnUrl('http://other.example.ts.net/', OWN), false)
  assert.equal(isOwnUrl('http://localhost/', OWN), false, 'port 80 is not 3080')
  assert.equal(isOwnUrl('http://localhost/', { port: 80, trustedHost: undefined }), true, 'the effective port, by scheme')
  assert.equal(isOwnUrl('https://127.0.0.1/', { port: 443, trustedHost: undefined }), true)
  assert.equal(isOwnUrl('http://192.168.1.10:3080/', OWN), false, 'the LAN is not loopback')
  assert.equal(isOwnUrl('http://localhost:3080/', { port: undefined, trustedHost: undefined }), false)
  assert.equal(isOwnUrl('http://dish.example.ts.net/', { port: 3080, trustedHost: 'Dish.Example.ts.net:8443' }), true, 'a trusted host given with a port')
  assert.equal(isOwnUrl('http://dish.example.ts.net/', { port: 3080, trustedHost: '' }), false)
  assert.equal(isOwnUrl('file:///etc/hosts', OWN), false)
  assert.equal(isOwnUrl('not a url', OWN), false)
  assert.equal(isOwnUrl('http://[::ffff:127.0.0.1]:3080/', OWN), true, 'an IPv4-mapped loopback address')
})

test('isLoopbackHost: every loopback name, as URL.hostname gives it', () => {
  for (const host of ['localhost', 'LOCALHOST', 'localhost.', 'app.localhost', 'a.b.localhost', '127.0.0.1', '127.0.0.2', '127.255.255.254',
    '[::1]', '::1', '0.0.0.0', '[::]', '[::ffff:7f00:1]', '[::ffff:0:0]']) {
    assert.equal(isLoopbackHost(host), true, host)
  }
  for (const host of ['example.com', 'localhost.example.com', 'notlocalhost', '128.0.0.1', '10.0.0.1', '192.168.1.1', '[::2]', '[::ffff:a00:1]', '']) {
    assert.equal(isLoopbackHost(host), false, host)
  }
})

test('sharedTmpOf: true only when the temp directory is outside /tmp', () => {
  assert.equal(sharedTmpOf('/tmp'), false)
  assert.equal(sharedTmpOf('/tmp/'), false)
  assert.equal(sharedTmpOf('/tmp/x'), false)
  assert.equal(sharedTmpOf(tmpPlace), false)
  assert.equal(sharedTmpOf('/home/dish/.cache/dish/tmp'), true)
  assert.equal(sharedTmpOf('/var/tmp'), true)
  assert.equal(sharedTmpOf('/tmpfoo'), true, 'the boundary is a /')
})
