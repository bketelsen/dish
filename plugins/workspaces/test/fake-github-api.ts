/**
 * A fake of GitHub's REST API for the GitHub App, on `127.0.0.1:0`: the App, its installations, installation tokens, the
 * bot user, pull requests by commit, and (step 7) pull requests opened, listed, read, edited and commented on, with
 * their reviews, review comments, issue comments, check runs and commit statuses. No test reaches GitHub.
 *
 * It checks what GitHub checks, so a client that gets something wrong fails here as it would there:
 * - every request carries the contract's headers (`Accept`, `X-GitHub-Api-Version`, `User-Agent`), else 400;
 * - `/app…` takes only a JWT (`Authorization: Bearer`): header `alg` RS256, the signature against the test's public
 *   key, `iss` the App's id, `exp − iat` at most 600 s, `iat` not in the future and `exp` not past. Anything else is 401;
 * - `GET /users/<login>` is public, as on GitHub: it takes no credential, or a good installation token;
 * - the rest takes only an installation token it minted (`Authorization: token`) that hasn't expired (401), for a
 *   repository the token covers (404, as GitHub hides what a token can't see), with the permission the call needs (403);
 * - a token request is 422 unless each level asked is `read` or `write` and at most the App's (`permissions`, read-only
 *   by default, as 6b's Apps) and the installation's (what its owner accepted), with `read` below `write`; so is a
 *   repository the installation doesn't have.
 * - pull requests (`pullRequests`) are opened with `POST /repos/{o}/{r}/pulls` and live only here: the fake knows
 *   nothing of the git server's branches. Their head commit is `headSha`, which a test sets.
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

/**
 * What the App may ask for by default: read only, as both Apps are created in 6b, with Checks and Commit statuses read,
 * which step 7's App has (the in-memory API token asks for them).
 */
export const APP_PERMISSIONS: Readonly<Record<string, string>> = Object.freeze({ contents: 'read', metadata: 'read', pull_requests: 'read', checks: 'read', statuses: 'read' })
/** Step 7's App: Contents and Pull requests read and write; Metadata, Checks and Commit statuses read. */
export const WRITE_APP_PERMISSIONS: Readonly<Record<string, string>> = Object.freeze({ contents: 'write', metadata: 'read', pull_requests: 'write', checks: 'read', statuses: 'read' })
/** A level's rank: `read` below `write`. Anything else is no level the fake grants. */
const RANK: Readonly<Record<string, number>> = { read: 1, write: 2 }
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

/** A pull request the fake holds. Mutable: a test sets `headSha`, `mergeable`, `state` and the rest. */
export interface FakePull {
  /** `<owner>/<repo>`, lower-case. */
  repo: string
  number: number
  title: string
  body: string
  /** The head branch (`dish/fix-1`), and its commit (all zeros until a test sets it). */
  head: string
  headSha: string
  base: string
  state: 'open' | 'closed'
  merged: boolean
  draft: boolean
  mergeable: boolean | null
  mergeableState: string
}

export interface FakeComment {
  repo: string
  number: number
  body: string
}

export interface FakePullEdit {
  repo: string
  number: number
  title?: string
  body?: string
}

/**
 * What `GET …/reviews`, `…/pulls/{n}/comments` and `…/issues/{n}/comments` serve: GitHub's JSON, as given, oldest first, a
 * page at a time (`per_page`, `page`), with GitHub's `Link` header when there is more than one page. Its URLs point at
 * `LINK_ORIGIN` (`/repositories/1/…`, as GitHub's do), which nothing listens on: a client must take only the page number.
 */
export interface FakeFeedback {
  reviews?: unknown[]
  reviewComments?: unknown[]
  issueComments?: unknown[]
}

/** What `GET …/commits/{sha}/check-runs` and `…/status` serve: GitHub's JSON items, as given. */
export interface FakeChecks {
  checkRuns?: unknown[]
  statuses?: unknown[]
}

/** Where the fake's `Link` URLs point: a port nothing listens on, so a client that followed one would fail. */
export const LINK_ORIGIN = 'http://127.0.0.1:9'

/** GitHub's `Link` header for page `page` of `last`, at `path` (its own form: `next` and `last`, then `prev` and `first`). */
function pageLinks(path: string, perPage: number, page: number, last: number): Record<string, string> {
  const at = (n: number): string => `<${LINK_ORIGIN}${path}?per_page=${perPage}&page=${n}>`
  const links: string[] = []
  if (page < last) links.push(`${at(page + 1)}; rel="next"`, `${at(last)}; rel="last"`)
  if (page > 1) links.push(`${at(page - 1)}; rel="prev"`, `${at(1)}; rel="first"`)
  return links.length === 0 ? {} : { link: links.join(', ') }
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
  /** The pull requests opened (or put here by a test), in order. */
  pullRequests: FakePull[]
  /** The comments posted on pull requests' issues. */
  comments: FakeComment[]
  /** Each `PATCH` of a pull request: the fields it changed. */
  pullEdits: FakePullEdit[]
  /** Store reviews and comments of pull request `number` of `repo` (`owner/repo`), added to what it holds. */
  feedback(repo: string, number: number, items: FakeFeedback): void
  /** Store check runs and statuses of commit `sha` of `repo`, added to what it holds. */
  checks(repo: string, sha: string, items: FakeChecks): void
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

export async function startFakeGitHub(options: { publicKey: KeyObject, appId?: number, slug?: string, permissions?: Readonly<Record<string, string>> }): Promise<FakeGitHub> {
  const appPermissions: Readonly<Record<string, string>> = { ...(options.permissions ?? APP_PERMISSIONS) }
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
  const pullRequests: FakePull[] = []
  const comments: FakeComment[] = []
  const pullEdits: FakePullEdit[] = []
  const feedbackStore = new Map<string, Required<FakeFeedback>>()
  const checksStore = new Map<string, Required<FakeChecks>>()
  let nextPull = 1
  let nextComment = 1

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
        send(res, request, 200, { ...app, owner: { login: 'fake-owner' }, permissions: appPermissions })
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
        const accepted = installation.permissions ?? appPermissions
        for (const [name, level] of Object.entries(permissions)) {
          const asked = RANK[level]
          if (asked === undefined || (RANK[appPermissions[name] ?? ''] ?? 0) < asked || (RANK[accepted[name] ?? ''] ?? 0) < asked) {
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

    // The pull requests, their feedback and the checks (step 7): /repos/{o}/{r}/…, with a token that covers the repo.
    if (segments[0] === 'repos' && segments.length >= 4) {
      const [, owner, repo] = segments as [string, string, string]
      const installation = [...installations.values()].find(item => item.id === held.installation)
      if (installation === undefined || installation.account.toLowerCase() !== owner.toLowerCase()
        || !held.repositories.some(name => name.toLowerCase() === repo.toLowerCase())) {
        send(res, request, 404, { message: 'Not Found' })
        return
      }
      const key = `${owner}/${repo}`.toLowerCase()
      const rest = segments.slice(3)
      const perPage = Math.min(100, Math.max(1, Number(url.searchParams.get('per_page') ?? '30') || 30))
      const can = (name: string, level: 'read' | 'write'): boolean => (RANK[held.permissions[name] ?? ''] ?? 0) >= RANK[level]!
      const refuse = (): void => send(res, request, 403, { message: 'Resource not accessible by integration' })
      const parsed = (): Record<string, unknown> | undefined => {
        try {
          const value: unknown = body === '' ? {} : JSON.parse(body)
          return isRecord(value) ? value : undefined
        } catch {
          return undefined
        }
      }
      const pullOf = (number: string | undefined): FakePull | undefined =>
        pullRequests.find(pull => pull.repo === key && String(pull.number) === number)
      const pullJson = (pull: FakePull): Record<string, unknown> => ({
        number: pull.number,
        html_url: `https://github.com/${owner}/${repo}/pull/${pull.number}`,
        state: pull.state,
        title: pull.title,
        body: pull.body,
        merged: pull.merged,
        draft: pull.draft,
        mergeable: pull.mergeable,
        mergeable_state: pull.mergeableState,
        head: { ref: pull.head, sha: pull.headSha, label: `${installation.account}:${pull.head}` },
        base: { ref: pull.base },
      })

      // POST /repos/{o}/{r}/pulls
      if (method === 'POST' && rest.length === 1 && rest[0] === 'pulls') {
        if (!can('pull_requests', 'write')) return refuse()
        const asked = parsed()
        if (asked === undefined) {
          send(res, request, 400, { message: 'Problems parsing JSON' })
          return
        }
        for (const field of ['title', 'head', 'base'] as const) {
          if (typeof asked[field] !== 'string' || asked[field] === '') {
            send(res, request, 422, { message: 'Validation Failed', errors: [{ resource: 'PullRequest', field, code: 'missing_field' }] })
            return
          }
        }
        const head = String(asked.head)
        if (pullRequests.some(pull => pull.repo === key && pull.head === head && pull.state === 'open')) {
          send(res, request, 422, {
            message: 'Validation Failed',
            errors: [{ resource: 'PullRequest', code: 'custom', message: `A pull request already exists for ${installation.account}:${head}.` }],
          })
          return
        }
        const pull: FakePull = {
          repo: key, number: nextPull++, title: String(asked.title), body: typeof asked.body === 'string' ? asked.body : '',
          head, headSha: '0'.repeat(40), base: String(asked.base), state: 'open', merged: false, draft: false, mergeable: null, mergeableState: 'unknown',
        }
        pullRequests.push(pull)
        send(res, request, 201, pullJson(pull))
        return
      }
      // GET /repos/{o}/{r}/pulls?head=<owner>:<branch>&state=…
      if (method === 'GET' && rest.length === 1 && rest[0] === 'pulls') {
        if (!can('pull_requests', 'read')) return refuse()
        const head = url.searchParams.get('head')
        const state = url.searchParams.get('state') ?? 'open'
        const found = pullRequests.filter(pull => pull.repo === key
          && (head === null || `${installation.account}:${pull.head}`.toLowerCase() === head.toLowerCase())
          && (state === 'all' || pull.state === state))
        send(res, request, 200, found.slice(0, perPage).map(pullJson))
        return
      }
      // GET or PATCH /repos/{o}/{r}/pulls/{n}
      if (rest.length === 2 && rest[0] === 'pulls' && (method === 'GET' || method === 'PATCH')) {
        if (!can('pull_requests', method === 'GET' ? 'read' : 'write')) return refuse()
        const pull = pullOf(rest[1])
        if (pull === undefined) {
          send(res, request, 404, { message: 'Not Found' })
          return
        }
        if (method === 'PATCH') {
          const asked = parsed()
          if (asked === undefined) {
            send(res, request, 400, { message: 'Problems parsing JSON' })
            return
          }
          const edit: FakePullEdit = { repo: key, number: pull.number }
          if (typeof asked.title === 'string') pull.title = edit.title = asked.title
          if (typeof asked.body === 'string') pull.body = edit.body = asked.body
          pullEdits.push(edit)
        }
        send(res, request, 200, pullJson(pull))
        return
      }
      // GET /repos/{o}/{r}/pulls/{n}/reviews and …/comments, GET /repos/{o}/{r}/issues/{n}/comments
      if (method === 'GET' && rest.length === 3 && (rest[0] === 'pulls' || rest[0] === 'issues')
        && (rest[2] === 'reviews' || rest[2] === 'comments') && !(rest[0] === 'issues' && rest[2] === 'reviews')) {
        if (!can('pull_requests', 'read')) return refuse()
        if (pullOf(rest[1]) === undefined) {
          send(res, request, 404, { message: 'Not Found' })
          return
        }
        const stored = feedbackStore.get(`${key}#${rest[1]}`)
        const items = (rest[0] === 'issues' ? stored?.issueComments : rest[2] === 'reviews' ? stored?.reviews : stored?.reviewComments) ?? []
        const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1)
        const last = Math.max(1, Math.ceil(items.length / perPage))
        // GitHub's own links name the repository by its id.
        const linked = `/repositories/1/${rest.join('/')}`
        send(res, request, 200, items.slice((page - 1) * perPage, page * perPage), pageLinks(linked, perPage, page, last))
        return
      }
      // POST /repos/{o}/{r}/issues/{n}/comments
      if (method === 'POST' && rest.length === 3 && rest[0] === 'issues' && rest[2] === 'comments') {
        if (!can('pull_requests', 'write')) return refuse()
        const pull = pullOf(rest[1])
        if (pull === undefined) {
          send(res, request, 404, { message: 'Not Found' })
          return
        }
        const asked = parsed()
        if (asked === undefined || typeof asked.body !== 'string' || asked.body === '') {
          send(res, request, 422, { message: 'Validation Failed', errors: [{ resource: 'IssueComment', field: 'body', code: 'missing_field' }] })
          return
        }
        comments.push({ repo: key, number: pull.number, body: asked.body })
        const id = nextComment++
        send(res, request, 201, { id, html_url: `https://github.com/${owner}/${repo}/pull/${pull.number}#issuecomment-${id}`, body: asked.body })
        return
      }
      // GET /repos/{o}/{r}/commits/{sha}/check-runs and …/status
      if (method === 'GET' && rest.length === 3 && rest[0] === 'commits' && (rest[2] === 'check-runs' || rest[2] === 'status')) {
        if (!can(rest[2] === 'check-runs' ? 'checks' : 'statuses', 'read')) return refuse()
        const stored = checksStore.get(`${key}@${rest[1]}`)
        if (rest[2] === 'check-runs') {
          const runs = stored?.checkRuns ?? []
          send(res, request, 200, { total_count: runs.length, check_runs: runs.slice(0, perPage) })
        } else {
          const statuses = stored?.statuses ?? []
          send(res, request, 200, { state: statuses.length === 0 ? 'pending' : 'success', sha: rest[1], total_count: statuses.length, statuses: statuses.slice(0, perPage) })
        }
        return
      }
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
    pullRequests,
    comments,
    pullEdits,
    feedback: (repo, number, items) => {
      const key = `${repo.toLowerCase()}#${number}`
      const stored = feedbackStore.get(key) ?? { reviews: [], reviewComments: [], issueComments: [] }
      stored.reviews.push(...(items.reviews ?? []))
      stored.reviewComments.push(...(items.reviewComments ?? []))
      stored.issueComments.push(...(items.issueComments ?? []))
      feedbackStore.set(key, stored)
    },
    checks: (repo, sha, items) => {
      const key = `${repo.toLowerCase()}@${sha}`
      const stored = checksStore.get(key) ?? { checkRuns: [], statuses: [] }
      stored.checkRuns.push(...(items.checkRuns ?? []))
      stored.statuses.push(...(items.statuses ?? []))
      checksStore.set(key, stored)
    },
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
