/**
 * A fake GitHub for git: a smart-HTTP server on `127.0.0.1:0` that runs `git http-backend` (CGI) over the bare
 * repositories under `root` (`<root>/<owner>/<repo>.git`), and asks for a token the way GitHub does.
 *
 * - No credential, or a Basic credential that isn't `x-access-token` with a token in `tokens`: 401 with
 *   `WWW-Authenticate: Basic`, so git asks its credential helper and tries again.
 * - `git-receive-pack` (a push: its `info/refs` advertisement or its POST) with a `read` token: 403, as GitHub answers
 *   a token without Contents write. A `write` token reaches http-backend, which lets an authenticated user push.
 * - Everything else goes to `git http-backend`, whose children get a scratch `HOME` (removed by `close`), no system or
 *   global config, and none of the test runner's environment but `PATH`.
 *
 * `requests` records each request without its token: the path, the git service, the user name, the token's level
 * (`null` when refused) and the status sent.
 *
 * `hold(service)` makes the next authorised `POST` of that service (a push's pack, for `git-receive-pack`) wait until
 * the test releases it, so a test can look at the processes while a push is under way.
 *
 * @module dish-workspaces/test/fake-git-http
 */

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { IncomingMessage, OutgoingHttpHeaders, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** What a token may do: `read` fetches and clones; `write` may push too. */
export type TokenLevel = 'read' | 'write'

export interface FakeGitRequest {
  /** The URL's path, without the query (`/acme/widget.git/info/refs`). */
  path: string
  /** `git-upload-pack` or `git-receive-pack` (from the path or `?service=`), or `null` for anything else. */
  service: string | null
  /** The Basic credential's user name, or `null` without one. Its password (the token) is never recorded. */
  user: string | null
  /** The level of the token the request was let in with; `null` when it was refused with 401. */
  level: TokenLevel | null
  /** The status sent (0 until the response starts). */
  status: number
}

export interface FakeGitServer {
  /** `http://127.0.0.1:<port>` */
  origin: string
  /** GIT_PROJECT_ROOT: `<root>/<owner>/<repo>.git` */
  root: string
  /** The tokens it takes. The tests and Task 4's fake add minted tokens here. */
  tokens: Map<string, TokenLevel>
  requests: FakeGitRequest[]
  /**
   * The next authorised `POST` of `service` waits until `release()`; `reached` resolves when it arrives. Released by
   * `close` too.
   */
  hold(service: 'git-upload-pack' | 'git-receive-pack'): { reached: Promise<void>, release(): void }
  close(): Promise<void>
}

/** The user name GitHub documents for an installation token over HTTPS. Any other is refused. */
export const TOKEN_USER = 'x-access-token'

const SERVICES: ReadonlySet<string> = new Set(['git-upload-pack', 'git-receive-pack'])
/** What GitHub says when a token can't push. */
const NO_WRITE = 'Write access to repository not granted.\n'
/** Where a CGI response's headers end. http-backend writes CRLFs; a bare LF is taken too. */
const HEADER_END = /\r?\n\r?\n/

/** The git service a request is for: the last path segment of a POST, or `?service=` of an `info/refs`. */
function serviceOf(path: string, query: URLSearchParams): string | null {
  const last = path.slice(path.lastIndexOf('/') + 1)
  if (SERVICES.has(last)) return last
  const asked = query.get('service')
  return path.endsWith('/info/refs') && asked !== null && SERVICES.has(asked) ? asked : null
}

/** The user name and password of a `Basic` Authorization header, or `undefined`. */
function basicCredential(header: string | undefined): { user: string, password: string } | undefined {
  const match = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header ?? '')
  if (match === null) return undefined
  const decoded = Buffer.from(match[1]!, 'base64').toString('utf8')
  const colon = decoded.indexOf(':')
  return colon < 0 ? undefined : { user: decoded.slice(0, colon), password: decoded.slice(colon + 1) }
}

/** A plain-text answer that isn't http-backend's. The request's body is drained first, so the connection stays usable. */
function answer(req: IncomingMessage, res: ServerResponse, record: FakeGitRequest, status: number, text: string, headers: OutgoingHttpHeaders = {}): void {
  req.resume()
  record.status = status
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache', ...headers })
  res.end(text)
}

/** The status and headers of a CGI response's header block. */
function cgiHead(block: string): { status: number, headers: OutgoingHttpHeaders } {
  let status = 200
  const headers: OutgoingHttpHeaders = {}
  for (const line of block.split(/\r?\n/)) {
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    const name = line.slice(0, colon).trim()
    const value = line.slice(colon + 1).trim()
    if (name.toLowerCase() === 'status') status = Number.parseInt(value, 10) || 500
    else headers[name] = value
  }
  return { status, headers }
}

/** A smart-HTTP git server over `git http-backend` (CGI). No or an unknown Basic credential: 401 with `WWW-Authenticate: Basic`. `git-receive-pack` with a read token: 403. Its child processes get a scratch HOME. */
export async function startFakeGit(root: string): Promise<FakeGitServer> {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'dish-fake-git-')))
  await mkdir(join(home, '.config'), { recursive: true })
  const tokens = new Map<string, TokenLevel>()
  const requests: FakeGitRequest[] = []
  const children = new Set<ChildProcess>()
  const holds: Array<{ service: string, arrived: () => void, released: Promise<void>, release: () => void }> = []
  /** Every hold's release, claimed or not: `close` lets them all go. */
  const releases: Array<() => void> = []

  /** http-backend's environment: CGI's variables, a scratch home, no system or global config, and only `PATH` of ours. */
  const backendEnv = (req: IncomingMessage, url: URL, pathInfo: string, user: string): Record<string, string> => {
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
      GIT_PROJECT_ROOT: root,
      GIT_HTTP_EXPORT_ALL: '1',
      GATEWAY_INTERFACE: 'CGI/1.1',
      SERVER_PROTOCOL: `HTTP/${req.httpVersion}`,
      REQUEST_METHOD: req.method ?? 'GET',
      PATH_INFO: pathInfo,
      QUERY_STRING: url.search.slice(1),
      CONTENT_TYPE: req.headers['content-type'] ?? '',
      REMOTE_ADDR: req.socket.remoteAddress ?? '127.0.0.1',
      // http-backend lets an authenticated user push (http.receivepack's default); only a write token gets this far.
      REMOTE_USER: user,
    }
    const length = req.headers['content-length']
    if (length !== undefined) env.CONTENT_LENGTH = length
    const encoding = req.headers['content-encoding']
    if (encoding !== undefined) env.HTTP_CONTENT_ENCODING = encoding
    const protocol = req.headers['git-protocol']
    if (typeof protocol === 'string') env.HTTP_GIT_PROTOCOL = protocol
    return env
  }

  /** Hand the request to `git http-backend` and relay its CGI response. */
  const backend = (req: IncomingMessage, res: ServerResponse, record: FakeGitRequest, url: URL, pathInfo: string, user: string): void => {
    const child = spawn('git', ['http-backend'], { cwd: home, env: backendEnv(req, url, pathInfo, user), stdio: ['pipe', 'pipe', 'ignore'] })
    children.add(child)
    // A client that hangs up mid-response: what's left of http-backend's output has nowhere to go.
    res.on('error', () => {})
    let head = Buffer.alloc(0)
    let started = false
    const start = (status: number, headers: OutgoingHttpHeaders): void => {
      started = true
      record.status = status
      res.writeHead(status, headers)
    }
    child.stdout!.on('data', (chunk: Buffer) => {
      if (started) {
        res.write(chunk)
        return
      }
      head = Buffer.concat([head, chunk])
      const text = head.toString('latin1')
      const end = HEADER_END.exec(text)
      if (end === null) return
      const { status, headers } = cgiHead(text.slice(0, end.index))
      start(status, headers)
      res.write(head.subarray(end.index + end[0].length))
    })
    child.stdin!.on('error', () => {})
    req.pipe(child.stdin!)
    child.on('error', () => {
      children.delete(child)
      if (!started) start(500, { 'Content-Type': 'text/plain' })
      res.end()
    })
    child.on('close', () => {
      children.delete(child)
      if (!started) start(500, { 'Content-Type': 'text/plain' })
      res.end()
    })
    res.on('close', () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    })
  }

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake.invalid')
    const service = serviceOf(url.pathname, url.searchParams)
    const credential = basicCredential(req.headers.authorization)
    const known = credential !== undefined && credential.user === TOKEN_USER ? tokens.get(credential.password) : undefined
    const record: FakeGitRequest = { path: url.pathname, service, user: credential?.user ?? null, level: known ?? null, status: 0 }
    requests.push(record)

    if (known === undefined) {
      answer(req, res, record, 401, 'Authentication required\n', { 'WWW-Authenticate': 'Basic realm="fake GitHub"' })
      return
    }
    if (service === 'git-receive-pack' && known !== 'write') {
      answer(req, res, record, 403, NO_WRITE)
      return
    }
    let pathInfo: string
    try {
      pathInfo = decodeURIComponent(url.pathname)
    } catch {
      answer(req, res, record, 400, 'Bad path\n')
      return
    }
    const held = req.method === 'POST' && closing === undefined ? holds.findIndex(item => item.service === service) : -1
    if (held >= 0) {
      const [item] = holds.splice(held, 1)
      item!.arrived()
      void item!.released.then(() => {
        // Released by close, or after the client went (a push killed mid-way): no http-backend is started for it.
        if (closing !== undefined || req.destroyed || res.destroyed) {
          res.destroy()
          return
        }
        backend(req, res, record, url, pathInfo, credential!.user)
      })
      return
    }
    backend(req, res, record, url, pathInfo, credential!.user)
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const { port } = server.address() as AddressInfo

  let closing: Promise<void> | undefined
  return {
    origin: `http://127.0.0.1:${port}`,
    root,
    tokens,
    requests,
    hold(service) {
      let arrived = (): void => {}
      const reached = new Promise<void>((resolve) => { arrived = resolve })
      let release = (): void => {}
      const released = new Promise<void>((resolve) => { release = resolve })
      holds.push({ service, arrived, released, release })
      releases.push(release)
      return { reached, release }
    },
    close() {
      closing ??= (async () => {
        holds.splice(0)
        for (const release of releases.splice(0)) release()
        for (const child of children) child.kill('SIGKILL')
        const closed = new Promise<void>(resolve => server.close(() => resolve()))
        server.closeAllConnections()
        await closed
        await rm(home, { recursive: true, force: true })
      })()
      return closing
    },
  }
}
