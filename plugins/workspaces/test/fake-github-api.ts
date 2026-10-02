/**
 * A fake of GitHub's REST API for the GitHub App, on `127.0.0.1:0`: the App, its installations, installation tokens, the
 * bot user, and pull requests by commit. No test reaches GitHub.
 *
 * It checks what GitHub checks, so a client that gets something wrong fails here as it would there:
 * - every request carries the contract's headers (`Accept`, `X-GitHub-Api-Version`, `User-Agent`), else 400;
 * - `/app…` takes only a JWT (`Authorization: Bearer`): header `alg` RS256, the signature against the test's public
 *   key, `iss` the App's id, `exp − iat` at most 600 s, `iat` not in the future and `exp` not past. Anything else is 401;
 * - `GET /users/<login>` is public, as on GitHub: it takes no credential, or a good installation token;
 * - the rest takes only an installation token it minted (`Authorization: token`) that hasn't expired (401), for a
 *   repository the token covers (404, as GitHub hides what a token can't see), with the permission the call needs (403);
 * - the App is read-only (the spec's decision 2): asking for any permission but `read`, or for one it lacks, is 422,
 *   and so is a repository the installation doesn't have.
 *
 * Tokens are `ghs_` and 36 letters and digits, and expire an hour after they are minted. Servers still open when the
 * test file finishes are closed then.
 *
 * @module dish-workspaces/test/fake-github-api
 */

import { generateKeyPairSync, randomBytes, verify } from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after } from 'node:test'
import type { PullSummary } from '../src/github.ts'

/** What the App may ask for: read only, as both Apps are created in 6b. */
const APP_PERMISSIONS: Readonly<Record<string, string>> = { contents: 'read', metadata: 'read', pull_requests: 'read' }
const TOKEN_LIFE_MS = 3_600_000
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

/** A fresh RSA 2048 key pair: the private key as a PKCS#1 PEM (`BEGIN RSA PRIVATE KEY`), as GitHub gives it. Made at run time, never kept. */
export function testKeys(): { privateKeyPem: string, publicKey: KeyObject } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  return { privateKeyPem: privateKey.export({ type: 'pkcs1', format: 'pem' }) as string, publicKey }
}

export interface FakeInstallation {
  id: number
  /** The owner's login, as GitHub spells it. */
  account: string
  /** The repositories it was given (names, any case), or all of the owner's. */
  repos: Set<string> | 'all'
  /**
   * The permissions the owner has accepted, when fewer than the App asks for (an installation that hasn't accepted a
   * permission the App added later): a token asking for another is 422, as on GitHub. Default: all of the App's.
   */
  permissions?: Readonly<Record<string, string>>
}

export interface FakeMint {
  installation: number
  token: string
  repositories: string[]
  permissions: Record<string, string>
}

export interface FakeRequest {
  method: string
  /** The path and query, as sent. */
  path: string
  auth: 'jwt' | 'token' | 'none'
  status: number
}

export interface FakeGitHub {
  /** `http://127.0.0.1:<port>`: the client's `api`. */
  api: string
  app: { id: number, slug: string, name: string }
  bot: { id: number }
  /** By owner, lower-case. */
  installations: Map<string, FakeInstallation>
  /** By commit sha: the pull requests `GET /repos/{o}/{r}/commits/{sha}/pulls` lists. A sha it hasn't is 422, as on GitHub. */
  pulls: Map<string, PullSummary[]>
  minted: FakeMint[]
  requests: FakeRequest[]
  /** Called with every token it mints, e.g. to add it to `FakeGitServer.tokens`. */
  onToken(listener: (token: string, permissions: Record<string, string>) => void): void
  /** The next request for `path` (with or without its query) answers `status` with `body` (and `headers`) instead. */
  failNext(path: string, status: number, body?: object, headers?: Record<string, string>): void
  close(): Promise<void>
}

const open: FakeGitHub[] = []

after(async () => {
  await Promise.all(open.splice(0).map(fake => fake.close()))
})

interface Minted {
  installation: number
  repositories: string[]
  permissions: Record<string, string>
  expiresAt: number
}

function base64urlJson(part: string): unknown {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `ghs_` and 36 letters and digits. */
function newToken(): string {
  const bytes = randomBytes(36)
  let body = ''
  for (const byte of bytes) body += ALNUM[byte % ALNUM.length]
  return `ghs_${body}`
}

/** GitHub's timestamp: ISO 8601 without the milliseconds. */
function githubTime(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export async function startFakeGitHub(options: { publicKey: KeyObject, appId?: number, slug?: string }): Promise<FakeGitHub> {
  const appId = options.appId ?? 4242
  const slug = options.slug ?? 'dish-test'
  const app = { id: appId, slug, name: `${slug} app` }
  const bot = { id: 9_000_001 }
  const installations = new Map<string, FakeInstallation>()
  const pulls = new Map<string, PullSummary[]>()
  const minted: FakeMint[] = []
  const requests: FakeRequest[] = []
  const listeners: Array<(token: string, permissions: Record<string, string>) => void> = []
  const failures: Array<{ path: string, status: number, body: object, headers: Record<string, string> }> = []
  const tokens = new Map<string, Minted>()

  /** The JWT's problem, or undefined for one GitHub would take. */
  const jwtProblem = (jwt: string): string | undefined => {
    const parts = jwt.split('.')
    if (parts.length !== 3) return 'not three parts'
    let header: unknown
    let payload: unknown
    try {
      header = base64urlJson(parts[0]!)
      payload = base64urlJson(parts[1]!)
    } catch {
      return 'not base64url JSON'
    }
    if (!isRecord(header) || header.alg !== 'RS256') return 'alg is not RS256'
    const signed = verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), options.publicKey, Buffer.from(parts[2]!, 'base64url'))
    if (!signed) return 'bad signature'
    if (!isRecord(payload)) return 'payload is not an object'
    const { iat, exp, iss } = payload
    if (typeof iat !== 'number' || typeof exp !== 'number') return 'iat or exp is not a number'
    if (String(iss) !== String(appId)) return 'iss is not the App id'
    const now = Math.floor(Date.now() / 1000)
    if (exp - iat > 600) return 'exp is more than 10 minutes after iat'
    if (iat > now) return 'iat is in the future'
    if (exp <= now) return 'expired'
    return undefined
  }

  const send = (res: ServerResponse, request: FakeRequest, status: number, body: unknown, headers: Record<string, string> = {}): void => {
    request.status = status
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers })
    res.end(body === undefined ? '' : JSON.stringify(body))
  }

  const installationJson = (installation: FakeInstallation): Record<string, unknown> => ({
    id: installation.id,
    account: { login: installation.account, id: installation.id + 100_000, type: 'Organization' },
    repository_selection: installation.repos === 'all' ? 'all' : 'selected',
    app_id: appId,
    app_slug: slug,
  })

  const has = (installation: FakeInstallation, repo: string): boolean =>
    installation.repos === 'all' || [...installation.repos].some(name => name.toLowerCase() === repo.toLowerCase())

  const handle = (req: IncomingMessage, res: ServerResponse, body: string): void => {
    const method = req.method ?? ''
    const raw = req.url ?? '/'
    const url = new URL(raw, 'http://fake')
    const path = url.pathname
    const authorization = req.headers.authorization ?? ''
    const auth: FakeRequest['auth'] = authorization.startsWith('Bearer ') ? 'jwt' : authorization.startsWith('token ') ? 'token' : 'none'
    const request: FakeRequest = { method, path: raw, auth, status: 0 }
    requests.push(request)

    if (req.headers.accept !== 'application/vnd.github+json'
      || req.headers['x-github-api-version'] !== '2022-11-28'
      || req.headers['user-agent'] !== 'dish-workspaces') {
      send(res, request, 400, { message: 'fake GitHub: missing or wrong API headers' })
      return
    }

    const failure = failures.findIndex(item => item.path === raw || item.path === path)
    if (failure >= 0) {
      const [item] = failures.splice(failure, 1)
      send(res, request, item!.status, item!.body, item!.headers)
      return
    }

    const segments = path.split('/').slice(1).map(part => decodeURIComponent(part))

    // The App's own routes: a JWT only.
    if (segments[0] === 'app') {
      if (auth !== 'jwt' || jwtProblem(authorization.slice('Bearer '.length)) !== undefined) {
        send(res, request, 401, { message: 'A JSON web token could not be decoded' })
        return
      }
      if (method === 'GET' && segments.length === 1) {
        send(res, request, 200, { ...app, owner: { login: 'fake-owner' }, permissions: APP_PERMISSIONS })
        return
      }
      if (method === 'GET' && segments.length === 2 && segments[1] === 'installations') {
        const perPage = Math.min(100, Math.max(1, Number(url.searchParams.get('per_page') ?? '30') || 30))
        const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1)
        const all = [...installations.values()].sort((a, b) => a.id - b.id)
        const items = all.slice((page - 1) * perPage, page * perPage).map(installationJson)
        const last = Math.max(1, Math.ceil(all.length / perPage))
        const link: Record<string, string> = page < last ? { link: `<http://fake/app/installations?per_page=${perPage}&page=${page + 1}>; rel="next"` } : {}
        send(res, request, 200, items, link)
        return
      }
      if (method === 'POST' && segments.length === 4 && segments[1] === 'installations' && segments[3] === 'access_tokens') {
        const id = Number(segments[2])
        const installation = [...installations.values()].find(item => item.id === id)
        if (installation === undefined) {
          send(res, request, 404, { message: 'Not Found' })
          return
        }
        let parsed: unknown
        try {
          parsed = body === '' ? {} : JSON.parse(body)
        } catch {
          send(res, request, 400, { message: 'Problems parsing JSON' })
          return
        }
        const asked = isRecord(parsed) ? parsed : {}
        const repositories = Array.isArray(asked.repositories) ? asked.repositories.map(String) : []
        const permissions = isRecord(asked.permissions) ? Object.fromEntries(Object.entries(asked.permissions).map(([k, v]) => [k, String(v)])) : {}
        const accepted = installation.permissions ?? APP_PERMISSIONS
        for (const [name, level] of Object.entries(permissions)) {
          if (level !== 'read' || APP_PERMISSIONS[name] === undefined || accepted[name] === undefined) {
            send(res, request, 422, { message: 'The permissions requested are not granted to this installation.' })
            return
          }
        }
        if (repositories.length === 0 || repositories.some(repo => !has(installation, repo))) {
          send(res, request, 422, { message: 'There is at least one repository that does not exist or is not accessible to the parent installation.' })
          return
        }
        const token = newToken()
        const granted = Object.keys(permissions).length === 0 ? { ...accepted } : permissions
        const expiresAt = Date.now() + TOKEN_LIFE_MS
        tokens.set(token, { installation: id, repositories, permissions: granted, expiresAt })
        minted.push({ installation: id, token, repositories: [...repositories], permissions: { ...granted } })
        for (const listener of listeners) listener(token, { ...granted })
        send(res, request, 201, {
          token,
          expires_at: githubTime(expiresAt),
          permissions: granted,
          repository_selection: 'selected',
          repositories: repositories.map((name, index) => ({ id: index + 1, name, full_name: `${installation.account}/${name}` })),
        })
        return
      }
      send(res, request, 404, { message: 'Not Found' })
      return
    }

    // `GET /repos/{o}/{r}/installation`: a JWT too.
    if (method === 'GET' && segments[0] === 'repos' && segments.length === 4 && segments[3] === 'installation') {
      if (auth !== 'jwt' || jwtProblem(authorization.slice('Bearer '.length)) !== undefined) {
        send(res, request, 401, { message: 'A JSON web token could not be decoded' })
        return
      }
      const installation = installations.get(segments[1]!.toLowerCase())
      if (installation === undefined || !has(installation, segments[2]!)) {
        send(res, request, 404, { message: 'Not Found' })
        return
      }
      send(res, request, 200, installationJson(installation))
      return
    }

    // `GET /users/<login>` is public: GitHub answers it without a credential too (with one, the token must be good).
    if (method === 'GET' && segments[0] === 'users' && segments.length === 2 && auth === 'none') {
      if (segments[1] !== `${slug}[bot]`) {
        send(res, request, 404, { message: 'Not Found' })
        return
      }
      send(res, request, 200, { login: `${slug}[bot]`, id: bot.id, type: 'Bot' })
      return
    }

    // Everything else: an installation token it minted.
    const held = auth === 'token' ? tokens.get(authorization.slice('token '.length)) : undefined
    if (held === undefined || held.expiresAt <= Date.now()) {
      send(res, request, 401, { message: 'Bad credentials' })
      return
    }

    if (method === 'GET' && segments[0] === 'users' && segments.length === 2) {
      if (segments[1] !== `${slug}[bot]`) {
        send(res, request, 404, { message: 'Not Found' })
        return
      }
      send(res, request, 200, { login: `${slug}[bot]`, id: bot.id, type: 'Bot' })
      return
    }

    if (method === 'GET' && segments[0] === 'repos' && segments.length === 6 && segments[3] === 'commits' && segments[5] === 'pulls') {
      const [, owner, repo, , sha] = segments as [string, string, string, string, string]
      const installation = [...installations.values()].find(item => item.id === held.installation)
      if (installation === undefined || installation.account.toLowerCase() !== owner.toLowerCase()
        || !held.repositories.some(name => name.toLowerCase() === repo.toLowerCase())) {
        send(res, request, 404, { message: 'Not Found' })
        return
      }
      if (held.permissions.pull_requests === undefined) {
        send(res, request, 403, { message: 'Resource not accessible by integration' })
        return
      }
      const list = pulls.get(sha)
      if (list === undefined) {
        send(res, request, 422, { message: `No commit found for SHA: ${sha}` })
        return
      }
      send(res, request, 200, list.map(pull => ({
        number: pull.number,
        state: pull.state,
        merged_at: pull.mergedAt,
        head: { sha: pull.headSha, ref: pull.headRef },
        base: { ref: 'main' },
      })))
      return
    }

    send(res, request, 404, { message: 'Not Found' })
  }

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => handle(req, res, Buffer.concat(chunks).toString('utf8')))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address() as AddressInfo

  let closed: Promise<void> | undefined
  const fake: FakeGitHub = {
    api: `http://127.0.0.1:${port}`,
    app,
    bot,
    installations,
    pulls,
    minted,
    requests,
    onToken: (listener) => { listeners.push(listener) },
    failNext: (path, status, body = { message: `fake GitHub: HTTP ${status}` }, headers = {}) => {
      failures.push({ path, status, body, headers })
    },
    close: () => {
      closed ??= new Promise<void>(resolve => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
      return closed
    },
  }
  open.push(fake)
  return fake
}
