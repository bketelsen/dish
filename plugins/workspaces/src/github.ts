/**
 * The GitHub App client: a JWT signed with the App's key (`node:crypto`, RS256), and `fetch` to GitHub's REST API.
 *
 * - **The App's credentials** (its id and private key) come from the function the client is given, called for every
 *   request that needs the JWT, and are dropped once the JWT is signed: nothing here keeps them. The service's function
 *   reads them with `ctx.get('credentials')?.resolve(ref)` each time.
 * - **Read only (6b), for every token but two.** `createToken` takes only `read` permissions, and throws before anything is
 *   sent otherwise. Step 7's `createWriteToken` mints exactly `PUSH_PERMISSIONS` (Contents write, for `pushBranch`) or
 *   `PULL_PERMISSIONS` (Pull requests write, for `openPull`, `updatePull` and `commentPull`), for one repository, and
 *   refuses a token GitHub granted more than asked, or for another repository.
 * - **Pull requests** (step 7): opened, found, edited, commented on, and read with their reviews, comments and checks,
 *   each with an installation token. What GitHub answers is untrusted: the service masks and caps it (`readPull`).
 * - **Secrets never travel out.** The JWT and a token go only in the `Authorization` header, never in a URL; an error
 *   names the call and the status, and at most 200 characters of GitHub's `message`, masked (dish-kit's `maskSecrets`);
 *   never a header, a token or the key. Redirects are not followed, so a header never goes anywhere it wasn't sent.
 * - **The base URL** is `https://api.github.com`. Only tests give another (`options.api`, from the service's
 *   `internals`), never config.
 *
 * @module dish-workspaces/github
 */

import { createPrivateKey, sign } from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import { maskSecrets } from 'dish-kit'

export const GITHUB_API = 'https://api.github.com'
export const GITHUB_WEB = 'https://github.com'

/** The headers of every request (the contract's). */
const API_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Accept': 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'dish-workspaces',
})
/** How long one request (its answer read whole) may take. */
const DEFAULT_TIMEOUT_MS = 15_000
/** The JWT: issued a minute back (GitHub's advice, for clock drift), and good for nine minutes after now (at most ten). */
const JWT_BACK_S = 60
const JWT_AHEAD_S = 540
/** The most characters of GitHub's `message` an error carries. */
const MAX_MESSAGE_CHARS = 200
/** The most of an answer that is read: an error's, and a success's (a page of 100 installations is a few hundred KB). */
const MAX_ERROR_BYTES = 64 * 1024
const MAX_ANSWER_BYTES = 8 * 1024 * 1024
/** A page of `GET /app/installations`, and the most pages read (10,000 installations). */
const PER_PAGE = 100
const MAX_PAGES = 100
/** GitHub takes up to 500 repository names in one token request. */
const MAX_REPOSITORIES = 500
/** A repository's name, as a token request takes it. */
const REPOSITORY = /^[A-Za-z0-9._-]{1,100}$/
/** The largest pull request number dish takes (GitHub's are 32-bit). */
const MAX_PULL_NUMBER = 2 ** 31 - 1

/** A push's token (`pushBranch`): Contents write, and Metadata read, which every token has. */
export const PUSH_PERMISSIONS: Readonly<{ contents: 'write', metadata: 'read' }> = Object.freeze({ contents: 'write', metadata: 'read' })
/** A pull request's token (`openPull`, `updatePull`, `commentPull`): Pull requests write, and Metadata read. */
export const PULL_PERMISSIONS: Readonly<{ metadata: 'read', pull_requests: 'write' }> = Object.freeze({ metadata: 'read', pull_requests: 'write' })
/** The only permissions `createWriteToken` takes. */
export type WritePermissions = typeof PUSH_PERMISSIONS | typeof PULL_PERMISSIONS
/** A permission level's rank: what a token may do more of. */
const LEVELS: Readonly<Record<string, number>> = { read: 1, write: 2, admin: 3 }

export interface AppCredentials {
  /** The App's id (or client id): the JWT's `iss`. */
  appId: string
  /** The App's private key, PEM (PKCS#1 as GitHub gives it, or PKCS#8). */
  privateKey: string
}

export type GitHubErrorKind = 'no-credentials' | 'key' | 'auth' | 'not-found' | 'unprocessable' | 'rate-limited' | 'network' | 'other'

/** A failed call. Its message names the call and the status, never a token or the key. */
export class GitHubError extends Error {
  readonly kind: GitHubErrorKind
  /** The HTTP status, when GitHub answered. */
  readonly status: number | undefined

  constructor(kind: GitHubErrorKind, message: string, status?: number) {
    super(message)
    this.name = 'GitHubError'
    this.kind = kind
    this.status = status
  }
}

export interface Installation {
  id: number
  /** The owner's login. */
  account: string
  /** `Organization` or `User`. */
  accountType: string
  selection: 'all' | 'selected'
}

export interface InstallationToken {
  token: string
  /** Epoch ms. */
  expiresAt: number
  permissions: Record<string, string>
  /** The repository names it covers. */
  repositories: string[]
}

export interface PullSummary {
  number: number
  state: string
  mergedAt: string | null
  headSha: string
  headRef: string
}

/** A pull request `createPull` opened, or `findOpenPull` found. */
export interface PullOpened {
  number: number
  url: string
  base: string
}

/** What `readPull` needs of `GET /repos/{o}/{r}/pulls/{number}`. Unmasked: the service masks it. */
export interface PullDetails {
  number: number
  url: string
  title: string
  state: 'open' | 'closed'
  merged: boolean
  draft: boolean
  /** null: GitHub hasn't computed it yet. */
  mergeable: boolean | null
  mergeableState: string
  head: { ref: string, sha: string }
  base: { ref: string }
}

/**
 * GitHub's items, unparsed (readPull reads each field with a type check), and `full`: whether GitHub has items this list
 * doesn't hold. For the reviews and the comments (the newest 100), those are older ones; for the checks (the first page),
 * a full page.
 */
export interface RawList {
  items: unknown[]
  full: boolean
}

export interface GitHubClientOptions {
  /** The API's base URL. Tests only. Default `GITHUB_API`. */
  api?: string
  fetch?: typeof fetch
  /** Per request. Default 15 000. */
  timeoutMs?: number
  now?: () => number
}

/** Ends of lines and other whitespace, made plain, in an error's excerpt. */
const WHITESPACE = /[\s\x00-\x1f\x7f]+/g

/** `text` masked first (so a cut never leaves most of a token), made one line, and cut to `max` characters. */
function excerpt(text: string, max = MAX_MESSAGE_CHARS): string {
  const plain = maskSecrets(text).replace(WHITESPACE, ' ').trim()
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain
}

function base64url(data: string | Buffer): string {
  return Buffer.from(data).toString('base64url')
}

/**
 * RS256 JWT. iat = now − 60 s, exp = now + 540 s, iss = appId. Throws GitHubError('key') for a key node:crypto can't
 * read, without quoting it, and GitHubError('no-credentials') for an empty App id.
 */
export function appJwt(credentials: AppCredentials, nowMs: number = Date.now()): string {
  const iss = credentials.appId.trim()
  if (iss === '' || /[\x00-\x1f\x7f]/.test(iss)) {
    throw new GitHubError('no-credentials', "the GitHub App's ID is empty or not one line")
  }
  let key: KeyObject
  try {
    key = createPrivateKey(credentials.privateKey.trim())
  } catch (error) {
    // node:crypto's message names the decoder that failed, never the key; only its code is kept, to be sure.
    const code = (error as { code?: unknown }).code
    const why = typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? ` (${code})` : ''
    throw new GitHubError('key', `the GitHub App's private key couldn't be read as a PEM key${why}`)
  }
  if (key.asymmetricKeyType !== 'rsa') {
    throw new GitHubError('key', "the GitHub App's private key isn't an RSA key")
  }
  const now = Math.floor(nowMs / 1000)
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const payload = base64url(JSON.stringify({ iat: now - JWT_BACK_S, exp: now + JWT_AHEAD_S, iss }))
  const signature = sign('sha256', Buffer.from(`${header}.${payload}`), key)
  return `${header}.${payload}.${base64url(signature)}`
}

/** '<slug>[bot]', '<id>+<slug>[bot]@users.noreply.github.com': the identity of the App's commits. */
export function botIdentity(slug: string, id: number): { name: string, email: string } {
  return { name: `${slug}[bot]`, email: `${id}+${slug}[bot]@users.noreply.github.com` }
}

/** One path segment, encoded; `.`, `..` and an empty one throw (a URL would resolve them). */
function segment(what: string, value: string): string {
  if (typeof value !== 'string' || value === '' || value === '.' || value === '..') {
    throw new Error(`${what} must be a name, not ${JSON.stringify(value)}`)
  }
  return encodeURIComponent(value)
}

/** `number`, if it is a pull request's: a positive whole number below 2³¹. */
function pullNumber(number: number): number {
  if (!Number.isSafeInteger(number) || number <= 0 || number > MAX_PULL_NUMBER) throw new Error('a pull request number is a positive whole number')
  return number
}

/** `sha`, if it is a full commit id. */
function commitId(sha: string): string {
  if (typeof sha !== 'string' || !/^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(sha)) throw new Error(`${JSON.stringify(sha)} is not a commit id`)
  return sha
}

/** The sorted `[name, level]` entries of a permission set, as one string to compare. */
function permissionKey(permissions: unknown): string {
  return isRecord(permissions) ? JSON.stringify(Object.entries(permissions).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : ''
}

/** A token, if it is one header value: printable ASCII, no spaces. Never quoted. */
function checkedToken(token: string): string {
  if (typeof token !== 'string' || !/^[\x21-\x7e]+$/.test(token)) throw new Error('the installation token is malformed')
  return token
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** What a failed `fetch` was, in a few words: its message, and its cause's code or message when that says more. Masked. */
function describeNetworkError(error: unknown): string {
  if (!(error instanceof Error)) return 'an unknown error'
  if (error.name === 'TimeoutError') return 'timed out'
  const cause = (error as { cause?: unknown }).cause
  const detail = cause instanceof Error ? ((cause as { code?: unknown }).code ?? cause.message) : undefined
  const text = typeof detail === 'string' && detail !== '' && detail !== error.message ? `${error.message} (${detail})` : error.message
  return excerpt(text)
}

/** The body of `response`, at most `max` bytes of it. */
async function readCapped(response: Response, max: number): Promise<{ text: string, truncated: boolean }> {
  if (response.body === null) return { text: '', truncated: false }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  let truncated = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (size + value.byteLength > max) {
        chunks.push(value.subarray(0, max - size))
        truncated = true
        break
      }
      chunks.push(value)
      size += value.byteLength
    }
  } finally {
    if (truncated) await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated }
}

type Auth = { kind: 'jwt' } | { kind: 'token', token: string } | { kind: 'none' }

interface Answer {
  status: number
  json: unknown
  headers: Headers
}

export class GitHubApp {
  readonly #credentials: () => Promise<AppCredentials | undefined>
  readonly #api: string
  readonly #fetch: typeof fetch
  readonly #timeoutMs: number
  readonly #now: () => number

  /** `credentials` is called for every request that needs the JWT; `undefined` is GitHubError('no-credentials'). */
  constructor(credentials: () => Promise<AppCredentials | undefined>, options: GitHubClientOptions = {}) {
    this.#credentials = credentials
    this.#api = (options.api ?? GITHUB_API).replace(/\/+$/, '')
    this.#fetch = options.fetch ?? globalThis.fetch
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.#now = options.now ?? Date.now
  }

  /** `GET /app`: the App's id, slug and name. */
  async app(): Promise<{ id: number, slug: string, name: string }> {
    const call = 'GET /app'
    const { json } = await this.#request('GET', '/app', { kind: 'jwt' }, call)
    if (!isRecord(json) || typeof json.id !== 'number' || typeof json.slug !== 'string' || typeof json.name !== 'string') {
      throw malformed(call)
    }
    return { id: json.id, slug: json.slug, name: json.name }
  }

  /** `GET /app/installations?per_page=100`, every page. */
  async installations(): Promise<Installation[]> {
    const all: Installation[] = []
    for (let page = 1; page <= MAX_PAGES; page++) {
      const call = 'GET /app/installations'
      const { json } = await this.#request('GET', `/app/installations?per_page=${PER_PAGE}&page=${page}`, { kind: 'jwt' }, call)
      if (!Array.isArray(json)) throw malformed(call)
      for (const item of json) all.push(installationOf(item, call))
      if (json.length < PER_PAGE) break
    }
    return all
  }

  /** `GET /repos/{o}/{r}/installation`; a 404 (not installed, or not given that repo) is undefined. */
  async installationFor(owner: string, repo: string): Promise<Installation | undefined> {
    const path = `/repos/${segment('owner', owner)}/${segment('repo', repo)}/installation`
    const call = `GET ${path}`
    try {
      const { json } = await this.#request('GET', path, { kind: 'jwt' }, call)
      return installationOf(json, call)
    } catch (error) {
      if (error instanceof GitHubError && error.kind === 'not-found') return undefined
      throw error
    }
  }

  /**
   * `POST /app/installations/{id}/access_tokens`. Every permission value must be 'read' and `repositories` non-empty,
   * else it throws before any request (before the credentials are read, too).
   */
  async createToken(installationId: number, repositories: readonly string[], permissions: Readonly<Record<string, 'read'>>): Promise<InstallationToken> {
    if (!Number.isSafeInteger(installationId) || installationId <= 0) throw new Error('the installation id must be a positive integer')
    if (!Array.isArray(repositories) || repositories.length === 0) throw new Error('a token needs at least one repository')
    if (repositories.length > MAX_REPOSITORIES) throw new Error(`a token covers at most ${MAX_REPOSITORIES} repositories`)
    for (const repo of repositories) {
      if (typeof repo !== 'string' || !/^[A-Za-z0-9._-]{1,100}$/.test(repo)) throw new Error(`repository ${JSON.stringify(repo)} is not a repository name`)
    }
    const asked = isRecord(permissions) ? Object.entries(permissions) : []
    if (asked.length === 0) throw new Error('a token needs at least one permission')
    for (const [name, level] of asked) {
      if (!/^[a-z_]+$/.test(name)) throw new Error(`${JSON.stringify(name)} is not a permission name`)
      if (level !== 'read') throw new Error(`dish asks only for read tokens: ${name} is ${JSON.stringify(level)}`)
    }

    const path = `/app/installations/${installationId}/access_tokens`
    const call = `POST ${path}`
    const body = { repositories: [...repositories], permissions: Object.fromEntries(asked) }
    const { json } = await this.#request('POST', path, { kind: 'jwt' }, call, body)
    if (!isRecord(json) || typeof json.token !== 'string' || typeof json.expires_at !== 'string') throw malformed(call)
    const expiresAt = Date.parse(json.expires_at)
    if (!Number.isFinite(expiresAt)) throw malformed(call)
    const granted: Record<string, string> = {}
    if (isRecord(json.permissions)) {
      for (const [name, level] of Object.entries(json.permissions)) granted[name] = String(level)
    }
    // Belt and braces: a token that can do more than read is not used (it expires on its own within the hour).
    if (Object.values(granted).some(level => level !== 'read')) {
      throw new GitHubError('other', `${call}: GitHub granted more than read; the token is not used`)
    }
    const names = Array.isArray(json.repositories)
      ? json.repositories.flatMap(item => isRecord(item) && typeof item.name === 'string' ? [item.name] : [])
      : []
    let token: string
    try {
      token = checkedToken(json.token)
    } catch {
      throw malformed(call)
    }
    return { token, expiresAt, permissions: granted, repositories: names }
  }

  /**
   * POST /app/installations/{id}/access_tokens for one repository with exactly PUSH_PERMISSIONS or PULL_PERMISSIONS.
   * Anything else throws before any request. A token GitHub granted more than asked for (a permission not asked, or a
   * higher level), or for another repository, is GitHubError('other') and isn't returned.
   */
  async createWriteToken(installationId: number, repository: string, permissions: WritePermissions): Promise<InstallationToken> {
    if (!Number.isSafeInteger(installationId) || installationId <= 0) throw new Error('the installation id must be a positive integer')
    if (typeof repository !== 'string' || !REPOSITORY.test(repository)) throw new Error(`repository ${JSON.stringify(repository)} is not a repository name`)
    const key = permissionKey(permissions)
    if (key !== permissionKey(PUSH_PERMISSIONS) && key !== permissionKey(PULL_PERMISSIONS)) {
      throw new Error('dish mints write tokens only for a push (contents) or a pull request (pull_requests)')
    }
    const asked: Record<string, string> = { ...permissions }

    const path = `/app/installations/${installationId}/access_tokens`
    const call = `POST ${path}`
    const { json } = await this.#request('POST', path, { kind: 'jwt' }, call, { repositories: [repository], permissions: asked })
    if (!isRecord(json) || typeof json.token !== 'string' || typeof json.expires_at !== 'string') throw malformed(call)
    const expiresAt = Date.parse(json.expires_at)
    if (!Number.isFinite(expiresAt)) throw malformed(call)
    const granted: Record<string, string> = {}
    if (isRecord(json.permissions)) {
      for (const [name, level] of Object.entries(json.permissions)) granted[name] = String(level)
    }
    // A token that can do more than asked, anywhere, is not used (it expires on its own within the hour).
    for (const [name, level] of Object.entries(granted)) {
      const wanted = asked[name]
      if (wanted === undefined || (LEVELS[level] ?? Number.POSITIVE_INFINITY) > LEVELS[wanted]!) {
        throw new GitHubError('other', `${call}: GitHub granted more than asked; the token is not used`)
      }
    }
    const names = Array.isArray(json.repositories)
      ? json.repositories.flatMap(item => isRecord(item) && typeof item.name === 'string' ? [item.name] : [])
      : []
    if (names.length !== 1 || names[0]!.toLowerCase() !== repository.toLowerCase()) {
      throw new GitHubError('other', `${call}: the token covers other repositories; it is not used`)
    }
    let token: string
    try {
      token = checkedToken(json.token)
    } catch {
      throw malformed(call)
    }
    return { token, expiresAt, permissions: granted, repositories: names }
  }

  /**
   * `GET /users/<slug>%5Bbot%5D`: the bot's id, for its commit email. With an installation token when one is given;
   * without one, the request carries no credential at all. The endpoint is public, so onboarding asks it that way (Task
   * 7a's review): the in-memory API token needs Pull requests read, which an installation that hasn't accepted it yet
   * can't mint, and the identity mustn't wait on that.
   */
  async botUser(slug: string, token?: string): Promise<{ id: number, login: string }> {
    const auth: Auth = token === undefined ? { kind: 'none' } : { kind: 'token', token: checkedToken(token) }
    const path = `/users/${segment('slug', `${slug}[bot]`)}`
    const call = `GET ${path}`
    const { json } = await this.#request('GET', path, auth, call)
    if (!isRecord(json) || typeof json.id !== 'number' || typeof json.login !== 'string') throw malformed(call)
    return { id: json.id, login: json.login }
  }

  /**
   * `GET /repos/{o}/{r}/commits/{sha}/pulls` with an installation token (Pull requests read): the pull requests that
   * hold the commit. A 404 and a 422 (GitHub hasn't the commit) are an empty list.
   */
  async pullsForCommit(owner: string, repo: string, sha: string, token: string): Promise<PullSummary[]> {
    const auth: Auth = { kind: 'token', token: checkedToken(token) }
    if (typeof sha !== 'string' || !/^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(sha)) throw new Error(`${JSON.stringify(sha)} is not a commit id`)
    const path = `/repos/${segment('owner', owner)}/${segment('repo', repo)}/commits/${sha}/pulls`
    const call = `GET ${path}`
    let json: unknown
    try {
      ({ json } = await this.#request('GET', `${path}?per_page=100`, auth, call))
    } catch (error) {
      if (error instanceof GitHubError && (error.kind === 'not-found' || error.kind === 'unprocessable')) return []
      throw error
    }
    if (!Array.isArray(json)) throw malformed(call)
    return json.map(item => {
      if (!isRecord(item) || typeof item.number !== 'number' || typeof item.state !== 'string' || !isRecord(item.head)
        || typeof item.head.sha !== 'string' || typeof item.head.ref !== 'string'
        || (item.merged_at !== null && item.merged_at !== undefined && typeof item.merged_at !== 'string')) {
        throw malformed(call)
      }
      return { number: item.number, state: item.state, mergedAt: (item.merged_at as string | null | undefined) ?? null, headSha: item.head.sha, headRef: item.head.ref }
    })
  }

  /** POST /repos/{o}/{r}/pulls with an installation token: `{ title, head, base, body }`. */
  async createPull(owner: string, repo: string, pull: { title: string, head: string, base: string, body: string }, token: string): Promise<PullOpened> {
    const auth: Auth = { kind: 'token', token: checkedToken(token) }
    const path = `${repoPath(owner, repo)}/pulls`
    const call = `POST ${path}`
    const { json } = await this.#request('POST', path, auth, call, { title: pull.title, head: pull.head, base: pull.base, body: pull.body })
    if (!isRecord(json) || typeof json.number !== 'number' || typeof json.html_url !== 'string') throw malformed(call)
    return { number: json.number, url: json.html_url, base: pull.base }
  }

  /** GET /repos/{o}/{r}/pulls?head=<owner>:<branch>&state=open&per_page=100: the first whose head.ref is `branch`, or undefined. */
  async findOpenPull(owner: string, repo: string, branch: string, token: string): Promise<PullOpened | undefined> {
    const auth: Auth = { kind: 'token', token: checkedToken(token) }
    const path = `${repoPath(owner, repo)}/pulls`
    const call = `GET ${path}`
    const { json } = await this.#request('GET', `${path}?head=${encodeURIComponent(`${owner}:${branch}`)}&state=open&per_page=${PER_PAGE}`, auth, call)
    if (!Array.isArray(json)) throw malformed(call)
    for (const item of json) {
      if (!isRecord(item) || !isRecord(item.head) || item.head.ref !== branch) continue
      if (typeof item.number !== 'number' || typeof item.html_url !== 'string' || !isRecord(item.base) || typeof item.base.ref !== 'string') throw malformed(call)
      return { number: item.number, url: item.html_url, base: item.base.ref }
    }
    return undefined
  }

  /** POST /repos/{o}/{r}/issues/{number}/comments with an installation token: `{ body }`. A 201 is enough. */
  async createComment(owner: string, repo: string, number: number, body: string, token: string): Promise<void> {
    const auth: Auth = { kind: 'token', token: checkedToken(token) }
    const path = `${repoPath(owner, repo)}/issues/${pullNumber(number)}/comments`
    await this.#request('POST', path, auth, `POST ${path}`, { body })
  }

  /** PATCH /repos/{o}/{r}/pulls/{number} with an installation token: only the fields given. A 200 is enough. */
  async updatePull(owner: string, repo: string, number: number, fields: { title?: string, body?: string }, token: string): Promise<void> {
    const auth: Auth = { kind: 'token', token: checkedToken(token) }
    const path = `${repoPath(owner, repo)}/pulls/${pullNumber(number)}`
    const changed: { title?: string, body?: string } = {}
    if (fields.title !== undefined) changed.title = fields.title
    if (fields.body !== undefined) changed.body = fields.body
    await this.#request('PATCH', path, auth, `PATCH ${path}`, changed)
  }

  /** GET /repos/{o}/{r}/pulls/{number}: what readPull needs of it. */
  async pullDetails(owner: string, repo: string, number: number, token: string): Promise<PullDetails> {
    const auth: Auth = { kind: 'token', token: checkedToken(token) }
    const path = `${repoPath(owner, repo)}/pulls/${pullNumber(number)}`
    const call = `GET ${path}`
    const { json } = await this.#request('GET', path, auth, call)
    if (!isRecord(json) || typeof json.number !== 'number' || typeof json.html_url !== 'string' || typeof json.title !== 'string'
      || (json.state !== 'open' && json.state !== 'closed') || !isRecord(json.head) || typeof json.head.ref !== 'string'
      || typeof json.head.sha !== 'string' || !isRecord(json.base) || typeof json.base.ref !== 'string') {
      throw malformed(call)
    }
    return {
      number: json.number,
      url: json.html_url,
      title: json.title,
      state: json.state,
      merged: json.merged === true,
      draft: json.draft === true,
      mergeable: typeof json.mergeable === 'boolean' ? json.mergeable : null,
      mergeableState: typeof json.mergeable_state === 'string' ? json.mergeable_state : 'unknown',
      head: { ref: json.head.ref, sha: json.head.sha },
      base: { ref: json.base.ref },
    }
  }

  /** GET …/pulls/{number}/reviews: the newest 100 (`#newest`). */
  async pullReviews(owner: string, repo: string, number: number, token: string): Promise<RawList> {
    return this.#newest(`${repoPath(owner, repo)}/pulls/${pullNumber(number)}/reviews`, token)
  }

  /** GET …/pulls/{number}/comments: the newest 100 (`#newest`). */
  async pullReviewComments(owner: string, repo: string, number: number, token: string): Promise<RawList> {
    return this.#newest(`${repoPath(owner, repo)}/pulls/${pullNumber(number)}/comments`, token)
  }

  /** GET /repos/{o}/{r}/issues/{number}/comments: the newest 100 (`#newest`). */
  async issueComments(owner: string, repo: string, number: number, token: string): Promise<RawList> {
    return this.#newest(`${repoPath(owner, repo)}/issues/${pullNumber(number)}/comments`, token)
  }

  /** GET /repos/{o}/{r}/commits/{sha}/check-runs?per_page=100: its `check_runs`. */
  async checkRuns(owner: string, repo: string, sha: string, token: string): Promise<RawList> {
    return this.#list(`${repoPath(owner, repo)}/commits/${commitId(sha)}/check-runs`, token, 'check_runs')
  }

  /** GET /repos/{o}/{r}/commits/{sha}/status?per_page=100 (the combined status): its `statuses`. */
  async combinedStatus(owner: string, repo: string, sha: string, token: string): Promise<RawList> {
    return this.#list(`${repoPath(owner, repo)}/commits/${commitId(sha)}/status`, token, 'statuses')
  }

  /**
   * The newest 100 items of a list GitHub gives oldest first, a page at a time, in GitHub's order: the first page (which
   * says how many pages there are), then, when its `Link` header names a last page past it, that page, and the page before
   * it when the last is short. Only the page number is taken from the header: each request is `path` with `page`, never a
   * URL GitHub gave. `full` is true when older items weren't read. A `Link` with no last page it can read leaves the first
   * page, and `full`.
   */
  async #newest(path: string, token: string): Promise<RawList> {
    const auth: Auth = { kind: 'token', token: checkedToken(token) }
    const call = `GET ${path}`
    const page = async (number?: number): Promise<{ items: unknown[], headers: Headers }> => {
      const { json, headers } = await this.#request('GET', `${path}?per_page=${PER_PAGE}${number === undefined ? '' : `&page=${number}`}`, auth, call)
      if (!Array.isArray(json)) throw malformed(call)
      return { items: json, headers }
    }
    const first = await page()
    const links = linkRelations(first.headers.get('link'))
    const last = pageNumber(links.get('last'))
    if (last === undefined) {
      // No other page; or one GitHub names only as `next`, which can't be the newest.
      const more = links.size > 0 || first.items.length > PER_PAGE
      return { items: first.items.slice(-PER_PAGE), full: more }
    }
    if (last <= 1) return { items: first.items.slice(-PER_PAGE), full: first.items.length > PER_PAGE }
    let items = (await page(last)).items
    if (items.length < PER_PAGE) {
      const before = last === 2 ? first.items : (await page(last - 1)).items
      items = [...before, ...items]
    }
    return { items: items.slice(-PER_PAGE), full: true }
  }

  /** The first page (100) of `path` with an installation token: the answer itself, or its `field`, must be a list. */
  async #list(path: string, token: string, field?: string): Promise<RawList> {
    const auth: Auth = { kind: 'token', token: checkedToken(token) }
    const call = `GET ${path}`
    const { json } = await this.#request('GET', `${path}?per_page=${PER_PAGE}`, auth, call)
    const items: unknown = field === undefined ? json : isRecord(json) ? json[field] : undefined
    if (!Array.isArray(items)) throw malformed(call)
    return { items, full: items.length >= PER_PAGE }
  }

  /** One request. `call` (method and path, no query) is what an error names. */
  async #request(method: 'GET' | 'POST' | 'PATCH', path: string, auth: Auth, call: string, body?: unknown): Promise<Answer> {
    let authorization: string | undefined
    if (auth.kind === 'jwt') {
      let credentials: AppCredentials | undefined
      try {
        credentials = await this.#credentials()
      } catch (error) {
        throw new GitHubError('no-credentials', `the GitHub App's credentials couldn't be read: ${excerpt(error instanceof Error ? error.message : String(error))}`)
      }
      if (credentials === undefined) {
        throw new GitHubError('no-credentials', "the GitHub App's ID and private key aren't set (Settings → GitHub App)")
      }
      // The credentials are dropped here: only the JWT, good for minutes, goes on.
      authorization = `Bearer ${appJwt(credentials, this.#now())}`
    } else if (auth.kind === 'token') {
      authorization = `token ${auth.token}`
    }

    const headers: Record<string, string> = { ...API_HEADERS }
    if (authorization !== undefined) headers.Authorization = authorization
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const signal = AbortSignal.timeout(Math.max(1, Math.ceil(this.#timeoutMs)))
    let response: Response
    let text: string
    let truncated: boolean
    try {
      response = await this.#fetch(`${this.#api}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
        // A header never follows a redirect: GitHub's answer is the answer.
        redirect: 'manual',
      })
      ;({ text, truncated } = await readCapped(response, response.ok ? MAX_ANSWER_BYTES : MAX_ERROR_BYTES))
    } catch (error) {
      const why = signal.aborted ? `timed out after ${Math.ceil(this.#timeoutMs / 1000)} s` : describeNetworkError(error)
      throw new GitHubError('network', `${call} failed: ${why}`)
    }

    const status = response.status
    if (status >= 200 && status <= 299) {
      if (truncated) throw new GitHubError('other', `${call}: GitHub's answer is too large`, status)
      if (text.trim() === '') return { status, json: undefined, headers: response.headers }
      try {
        return { status, json: JSON.parse(text), headers: response.headers }
      } catch {
        throw malformed(call, status)
      }
    }

    let message = ''
    try {
      const parsed: unknown = JSON.parse(text)
      if (isRecord(parsed)) message = excerpt(failureText(parsed))
    } catch {
      // Not JSON: no message.
    }
    const detail = message === '' ? '' : `: ${message}`
    throw new GitHubError(kindOf(status, response.headers), `${call} answered HTTP ${status}${detail}`, status)
  }
}

/** GitHub's `Link` header as relation → URL (`next`, `last`, `prev`, `first`); empty for none. Nothing in it is fetched. */
function linkRelations(header: string | null): Map<string, string> {
  const relations = new Map<string, string>()
  if (header === null) return relations
  for (const part of header.slice(0, 8 * 1024).split(',')) {
    const found = /^\s*<([^>]*)>\s*;\s*rel="([^"]*)"\s*$/.exec(part)
    if (found === null) continue
    for (const rel of found[2]!.split(/\s+/)) if (rel !== '') relations.set(rel, found[1]!)
  }
  return relations
}

/** The `page` of a `Link` URL, a whole number from 1; undefined when there is none, or it isn't one. */
function pageNumber(url: string | undefined): number | undefined {
  if (url === undefined) return undefined
  let page: string | null
  try {
    page = new URL(url, 'https://api.github.com').searchParams.get('page')
  } catch {
    return undefined
  }
  if (page === null || !/^[1-9]\d{0,6}$/.test(page)) return undefined
  return Number(page)
}

/** The kind of a failed answer. */
function kindOf(status: number, headers: Headers): GitHubErrorKind {
  if (status === 401) return 'auth'
  if (status === 429) return 'rate-limited'
  if (status === 403) {
    // The primary limit says it in x-ratelimit-remaining; a secondary limit gives retry-after.
    return headers.get('x-ratelimit-remaining') === '0' || headers.has('retry-after') ? 'rate-limited' : 'auth'
  }
  if (status === 404) return 'not-found'
  if (status === 422) return 'unprocessable'
  return 'other'
}

/**
 * A failure's text: its `message`, and each item of its `errors` (GitHub's 422 says what was wrong there): the item's
 * own `message`, else `<resource> <field> <code>` from the strings it has. `"<message> (<one>; <two>)"`; unmasked
 * (the caller masks, then cuts).
 */
function failureText(body: Record<string, unknown>): string {
  const message = typeof body.message === 'string' ? body.message : ''
  const parts = !Array.isArray(body.errors) ? [] : body.errors.flatMap((item): string[] => {
    if (!isRecord(item)) return []
    if (typeof item.message === 'string' && item.message !== '') return [item.message]
    const words = [item.resource, item.field, item.code].filter((word): word is string => typeof word === 'string' && word !== '')
    return words.length === 0 ? [] : [words.join(' ')]
  })
  return parts.length === 0 ? message : `${message} (${parts.join('; ')})`.trim()
}

/** `/repos/{owner}/{repo}`, each one segment, encoded. */
function repoPath(owner: string, repo: string): string {
  return `/repos/${segment('owner', owner)}/${segment('repo', repo)}`
}

function malformed(call: string, status?: number): GitHubError {
  return new GitHubError('other', `${call}: GitHub's answer is malformed`, status)
}

function installationOf(item: unknown, call: string): Installation {
  if (!isRecord(item) || typeof item.id !== 'number' || !isRecord(item.account) || typeof item.account.login !== 'string') {
    throw malformed(call)
  }
  return {
    id: item.id,
    account: item.account.login,
    accountType: typeof item.account.type === 'string' ? item.account.type : '',
    selection: item.repository_selection === 'all' ? 'all' : 'selected',
  }
}
