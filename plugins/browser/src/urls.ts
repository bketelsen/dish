/**
 * What the agent's browser may open: the same rules for the agent's `browser_navigate`, the tab's address bar, and every
 * address a page goes to or asks for (the spec's URLs).
 * - `http:` and `https:` open, on any host, except dsh's own address;
 * - `file:` opens only when its real path is the workspace or under it, or `/tmp` or under it where `/tmp` counts;
 * - `about:blank` opens, and Chromium's error page from the page itself;
 * - anything else is refused.
 *
 * Pure, but for `realpath`: what it needs comes in as arguments. Its refusals are worded by `words.ts`.
 *
 * @module dish-browser/urls
 */

import { realpathSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { URL_MAX } from './protocol.ts'
import type { OwnAddress, UrlCheck, UrlPlaces, UrlRules } from './types.ts'
import { urlRefusal } from './words.ts'

/** A scheme at the start of what was typed. */
const SCHEME = /^[a-z][a-z0-9+.-]*:/i
/** A host and a port, which `SCHEME` would take for a scheme: `localhost:5173/x`. */
const HOST_AND_PORT = /^[^:/?#]+:\d+(?:[/?#]|$)/
/** The `what` of a refusal of dsh's own address. */
const OWN_WHAT = 'dsh\'s own address'
/** The `what` of something that doesn't parse. */
const NOT_A_URL = 'not a URL'
/** The schemes `isOwnUrl` looks at: a page reaches dsh over these. */
const OWN_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:', 'ws:', 'wss:'])

function parse(text: string): URL | undefined {
  try {
    return new URL(text)
  } catch {
    return undefined
  }
}

function notUrl(text: string): UrlCheck {
  return { ok: false, what: NOT_A_URL, reason: urlRefusal.notUrl(text) }
}

function schemeRefused(scheme: string, places: UrlPlaces): UrlCheck {
  return { ok: false, what: scheme, reason: urlRefusal.scheme(scheme, places.sharedTmp) }
}

/** What the agent or the address bar typed: made a URL, then checked as typed. */
export async function resolveUrl(input: string, places: UrlPlaces): Promise<UrlCheck> {
  const text = typeof input === 'string' ? input.trim() : ''
  if (text === '') return { ok: false, what: '', reason: urlRefusal.empty }
  if (text.length > URL_MAX) return { ok: false, what: '', reason: urlRefusal.tooLong }
  let href: string
  if (text.startsWith('/')) {
    href = pathToFileURL(text).href
  } else if (SCHEME.test(text) && !HOST_AND_PORT.test(text)) {
    const parsed = parse(text)
    if (parsed === undefined) return notUrl(text)
    href = parsed.href
  } else {
    // A bare host: http:// on loopback, where dev servers are, and https:// elsewhere. Parsing it gives the host as
    // URL.hostname has it, its port and any user part taken off.
    const plain = parse(`http://${text}`)
    if (plain === undefined) return notUrl(text)
    const secure = isLoopbackHost(plain.hostname) ? undefined : parse(`https://${text}`)
    href = (secure ?? plain).href
  }
  return checkUrl(href, places, 'typed')
}

/** A URL checked against the rules. `from: 'page'` lets Chromium's error page through. */
export async function checkUrl(url: string, places: UrlPlaces, from: 'typed' | 'page'): Promise<UrlCheck> {
  const parsed = parse(url)
  if (parsed === undefined) return notUrl(url)
  switch (parsed.protocol) {
    case 'http:':
    case 'https:':
      if (isOwnUrl(parsed.href, places.own)) return { ok: false, what: OWN_WHAT, reason: urlRefusal.own(parsed.href) }
      return { ok: true, url: parsed.href }
    case 'about:':
      return parsed.pathname === 'blank' ? { ok: true, url: parsed.href } : schemeRefused(parsed.protocol, places)
    case 'file:':
      return checkFile(parsed, places)
    case 'chrome-error:':
      return from === 'page' ? { ok: true, url: parsed.href } : schemeRefused(parsed.protocol, places)
    default:
      return schemeRefused(parsed.protocol, places)
  }
}

/** Whether `path` is `root` or under it, on a `/` boundary. */
function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`)
}

/** `path`'s real path, or undefined when it doesn't exist (or can't be read). */
async function realOf(path: string): Promise<string | undefined> {
  try {
    return await realpath(path)
  } catch {
    return undefined
  }
}

/** `/tmp`'s real path, for a file under it. */
async function realTmp(): Promise<string> {
  return (await realOf('/tmp')) ?? '/tmp'
}

/** A `file:` URL: its real path inside the workspace, or under `/tmp` when it counts. */
async function checkFile(parsed: URL, places: UrlPlaces): Promise<UrlCheck> {
  // `file://localhost/x` parses with an empty host; another host is a remote share, which isn't this chat's workspace.
  if (parsed.hostname !== '' && parsed.hostname !== 'localhost') {
    return { ok: false, what: `file://${parsed.hostname}/`, reason: urlRefusal.remoteFile(parsed.hostname, places.sharedTmp) }
  }
  let path: string
  try {
    path = fileURLToPath(parsed)
  } catch {
    // An encoded `/` in a path segment: no file has that name.
    return { ok: false, what: parsed.pathname, reason: urlRefusal.missing(parsed.href) }
  }
  const ok: UrlCheck = { ok: true, url: parsed.href }
  const workspace = places.workspace === '' ? undefined : places.workspace
  if (workspace === undefined) {
    if (places.sharedTmp) {
      const real = await realOf(path)
      const tmp = await realTmp()
      if (real !== undefined && within(real, tmp)) return ok
      if (real === undefined && within(resolve(path), '/tmp')) return { ok: false, what: path, reason: urlRefusal.missing(parsed.href) }
    }
    return { ok: false, what: path, reason: urlRefusal.noWorkspace(parsed.href) }
  }
  const real = await realOf(path)
  if (real === undefined) return { ok: false, what: path, reason: urlRefusal.missing(parsed.href) }
  if (within(real, (await realOf(workspace)) ?? resolve(workspace))) return ok
  if (places.sharedTmp && within(real, await realTmp())) return ok
  return { ok: false, what: path, reason: urlRefusal.outside(parsed.href, workspace, places.sharedTmp) }
}

/** A host name as compared: in small letters, without the trailing dot of a fully qualified name. */
function bareHost(host: string): string {
  return host.toLowerCase().replace(/\.$/, '')
}

/** The trusted host's name, without a port: `DISH_TRUSTED_HOST` is a bare host, with a port or not. */
function trustedHostOf(trustedHost: string | undefined): string | undefined {
  const text = trustedHost?.trim() ?? ''
  if (text === '') return undefined
  const parsed = parse(`http://${text}`)
  return bareHost(parsed !== undefined ? parsed.hostname : text.replace(/:\d+$/, ''))
}

/** The port a URL reaches: its own, or its scheme's. */
function effectivePort(url: URL): number {
  if (url.port !== '') return Number(url.port)
  return url.protocol === 'https:' || url.protocol === 'wss:' ? 443 : 80
}

/** Whether `url` is dsh's own address: the trusted host on any port, or a loopback name on dsh's port. Over http(s) or ws(s). */
export function isOwnUrl(url: string, own: OwnAddress): boolean {
  const parsed = parse(url)
  if (parsed === undefined || !OWN_SCHEMES.has(parsed.protocol)) return false
  const trusted = trustedHostOf(own.trustedHost)
  if (trusted !== undefined && bareHost(parsed.hostname) === trusted) return true
  return own.port !== undefined && isLoopbackHost(parsed.hostname) && effectivePort(parsed) === own.port
}

const IPV4_LOOPBACK = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/
/** An IPv4-mapped IPv6 address as URL writes it: `::ffff:7f00:1` is 127.0.0.1. */
const IPV4_MAPPED = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/

/**
 * Whether `host`, as URL.hostname gives it, is loopback: `localhost`, `*.localhost`, `127.0.0.0/8`, `[::1]`, and `0.0.0.0`
 * and `[::]`, which reach `127.0.0.1` on Linux; and an IPv4-mapped IPv6 address of one of these.
 */
export function isLoopbackHost(host: string): boolean {
  const name = bareHost(String(host))
  if (name === 'localhost' || name.endsWith('.localhost')) return true
  if (IPV4_LOOPBACK.test(name) || name === '0.0.0.0') return true
  const v6 = name.startsWith('[') && name.endsWith(']') ? name.slice(1, -1) : name
  if (v6 === '::1' || v6 === '::') return true
  const mapped = IPV4_MAPPED.exec(v6)
  if (mapped !== null) {
    const high = Number.parseInt(mapped[1]!, 16)
    const low = Number.parseInt(mapped[2]!, 16)
    return high >> 8 === 127 || (high === 0 && low === 0)
  }
  return false
}

/** `path`'s real path, or the path itself when it can't be read. */
function realSync(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

/**
 * Whether `/tmp` counts for `file://`: the machine's `/tmp` is shared with agents' commands only where dsh's own temporary
 * directory is elsewhere (on the VM, `~/.cache/dish/tmp`). So: `realpath(tmpdir)` is neither `/tmp` nor under it.
 */
export function sharedTmpOf(tmpdir: string): boolean {
  const real = realSync(tmpdir)
  return !within(real, '/tmp') && !within(real, realSync('/tmp'))
}

/** The rules as the core takes them. */
export const rules: UrlRules = {
  resolve: resolveUrl,
  check: checkUrl,
  own: (url, own) => isOwnUrl(url, own),
}
