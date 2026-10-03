/**
 * The read tokens: per owner, a file token for the credential helper, and an in-memory token for dish's own API reads.
 *
 * - **The file token** (`FILE_PERMISSIONS`: contents and metadata, read) covers the repos of that owner's projects (one
 *   installation per owner). It is written atomically to `<tokens dir>/<owner, lower-case>`, mode 0600, as the token and
 *   `\n`, in a directory this manager makes 0700 (and sets to 0700 if it was there already). It is refreshed
 *   `REFRESH_BEFORE_MS` before it expires, by a timer per owner; a failed refresh is logged once per distinct error,
 *   tried again after a minute, and leaves the old file (good until it expires).
 * - **The API token** (`API_PERMISSIONS`: metadata and pull requests, read) is kept in memory only, so the file token
 *   stays as narrow as above.
 * - **A repo the installation no longer has** fails the whole token request (422): the repos are looked up one by one
 *   with `installationFor`, the ones it lacks are dropped (and reported), and the token is minted for the rest.
 * - **Nothing logs a token.** A log line or an error names the owner, the repos and GitHub's masked message only.
 * - **`close`** removes every token file this manager wrote and clears its timers (the files come back at the next start).
 *
 * One owner's file work runs one job at a time (a `KeyedLock`), so a refresh, a change of repos and a removal never
 * interleave.
 *
 * @module dish-workspaces/tokens
 */

import { chmod, lstat, mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { maskSecrets } from 'dish-kit'
import { GitHubError } from './github.ts'
import type { GitHubApp, InstallationToken } from './github.ts'
import { KeyedLock } from './locks.ts'
import { writeFileAtomic } from './paths.ts'

export const FILE_PERMISSIONS = { contents: 'read', metadata: 'read' } as const
export const API_PERMISSIONS = { metadata: 'read', pull_requests: 'read' } as const
/** A token is minted again this long before it expires (GitHub's last an hour). */
export const REFRESH_BEFORE_MS = 600_000
/** A failed refresh is tried again after this long. */
export const RETRY_AFTER_MS = 60_000

/** The longest delay `setTimeout` takes. */
const MAX_TIMER_MS = 2 ** 31 - 1
/** An owner's login, as a token file's name may be: GitHub's characters, so it is one path segment. */
const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/
/** A token file's name: an owner, lower-case. */
const TOKEN_FILE = /^[a-z0-9][a-z0-9-]{0,38}$/
/** A temporary file `writeFileAtomic` left behind (a crash between its write and its rename): `.<owner>.<12 hex>.tmp`. */
const LEFTOVER = /^\.([a-z0-9][a-z0-9-]{0,38})\.[0-9a-f]{12}\.tmp$/
/** The most characters of an error a log line carries. */
const MAX_LOGGED_CHARS = 300

export interface OwnerRepos {
  installation: number
  repos: readonly string[]
}

export interface TokenManagerOptions {
  /** `tokensDir(state)`. */
  directory: string
  app: Pick<GitHubApp, 'createToken' | 'installationFor'>
  logger: { warn(format: string, ...args: unknown[]): void, info(format: string, ...args: unknown[]): void }
  now?: () => number
  /** Tests; default an unref'd `setTimeout`. */
  timers?: { set(fn: () => void, ms: number): unknown, clear(handle: unknown): void }
}

interface OwnerState {
  /** The lower-case owner: the file's name and the lock's key. */
  owner: string
  installation: number
  /** The repos as last given to `setRepositories`, sorted: what a change is judged by. */
  given: string
  /** The repos tokens are minted for: those given, less the ones the installation turned out not to have. */
  repos: string[]
  /** What the file holds now. */
  file: { repos: string, installation: number, expiresAt: number } | undefined
  api: { repos: string, installation: number, expiresAt: number, token: string } | undefined
  timer: unknown
  /** The last refresh error logged, so the same one isn't logged every minute. */
  lastError: string | undefined
}

/** A token from `#mint`, and what it covers. */
interface Minted {
  /** Undefined when no repo is left to read. */
  token: InstallationToken | undefined
  /** The repos the installation turned out not to have. */
  dropped: string[]
  installation: number
  repos: string[]
}

const defaultTimers: NonNullable<TokenManagerOptions['timers']> = {
  set(fn, ms) {
    const timer = setTimeout(fn, Math.min(MAX_TIMER_MS, Math.max(0, Math.ceil(ms))))
    timer.unref()
    return timer
  },
  clear(handle) {
    clearTimeout(handle as NodeJS.Timeout)
  },
}

/** The owner's file name and key; throws for a name that isn't an owner's. */
function ownerKey(owner: string): string {
  if (typeof owner !== 'string' || !OWNER.test(owner)) throw new Error(`${JSON.stringify(owner)} is not a GitHub owner`)
  return owner.toLowerCase()
}

function reposKey(repos: readonly string[]): string {
  return repos.join('\n')
}

/** Remove `file` if it is a file (never a directory or what a link points at); gone already is fine. */
async function removeIfFile(file: string): Promise<void> {
  try {
    if (!(await lstat(file)).isFile()) return
    await rm(file, { force: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

/** An error's message, masked, on one line, cut short: what a log line may say. */
function describe(error: unknown): string {
  const text = maskSecrets(error instanceof Error ? error.message : String(error)).replace(/[\s\x00-\x1f\x7f]+/g, ' ').trim()
  return text.length > MAX_LOGGED_CHARS ? `${text.slice(0, MAX_LOGGED_CHARS - 1)}…` : text
}

export class TokenManager {
  readonly #directory: string
  readonly #app: TokenManagerOptions['app']
  readonly #logger: TokenManagerOptions['logger']
  readonly #now: () => number
  readonly #timers: NonNullable<TokenManagerOptions['timers']>
  readonly #lock = new KeyedLock()
  readonly #owners = new Map<string, OwnerState>()
  /** Every token file this manager has written (and not removed since). */
  readonly #written = new Set<string>()
  /** The writes in progress, which `close` waits for. */
  readonly #writes = new Set<Promise<void>>()
  #closed = false
  #closing: Promise<void> | undefined

  constructor(options: TokenManagerOptions) {
    this.#directory = options.directory
    this.#app = options.app
    this.#logger = options.logger
    this.#now = options.now ?? Date.now
    this.#timers = options.timers ?? defaultTimers
  }

  /** The repos per owner (lower-case) dish holds tokens for. An owner whose set changed gets a new file token now; an owner no longer listed loses its file and timer. */
  async setRepositories(byOwner: ReadonlyMap<string, OwnerRepos>): Promise<void> {
    if (this.#closed) return
    const next = new Map<string, OwnerRepos>()
    for (const [owner, entry] of byOwner) next.set(ownerKey(owner), entry)
    const jobs: Promise<void>[] = []
    for (const owner of [...this.#owners.keys()]) {
      if (!next.has(owner)) jobs.push(this.#forget(owner))
    }
    for (const [owner, entry] of next) {
      const repos = [...new Set(entry.repos)].sort()
      const given = reposKey(repos)
      const current = this.#owners.get(owner)
      // Unchanged, and nothing dropped: nothing to do. A repo dropped after a 422 is tried again at every recompute (the 422
      // path drops it again if the installation still lacks it), so one given back to the App is read again without a restart.
      if (current !== undefined && current.given === given && reposKey(current.repos) === given && current.installation === entry.installation) continue
      const state: OwnerState = current ?? { owner, installation: entry.installation, given, repos, file: undefined, api: undefined, timer: undefined, lastError: undefined }
      state.installation = entry.installation
      state.given = given
      state.repos = repos
      state.api = undefined
      this.#owners.set(owner, state)
      jobs.push(this.#refresh(state, true))
    }
    await Promise.all(jobs)
  }

  /** The file token: minted when missing or within REFRESH_BEFORE_MS of expiry, written atomically 0600, with a refresh timer. Repos the installation no longer has (a 422) are found with installationFor, dropped, and reported. */
  async ensureFileToken(owner: string): Promise<{ dropped: string[] }> {
    const key = ownerKey(owner)
    return this.#lock.run(key, () => this.#ensure(key, false))
  }

  /** The in-memory API token for `owner`, minted with API_PERMISSIONS, never written. */
  async apiToken(owner: string): Promise<string> {
    const key = ownerKey(owner)
    // Its own lock key (an owner has no space in it), so an API read never waits behind a file refresh.
    return this.#lock.run(`api ${key}`, async () => {
      const state = this.#held(key)
      const repos = reposKey(state.repos)
      const cached = state.api
      if (cached !== undefined && cached.repos === repos && cached.installation === state.installation && this.#now() < cached.expiresAt - REFRESH_BEFORE_MS) {
        return cached.token
      }
      if (state.repos.length === 0) throw new Error(`the dish App can read no repository of ${key} any more`)
      const { token, repos: covered, installation } = await this.#mint(state, API_PERMISSIONS)
      if (token === undefined) throw new Error(`the dish App can read no repository of ${key} any more`)
      if (this.#owners.get(key) === state && !this.#closed) {
        state.api = { repos: reposKey(covered), installation, expiresAt: token.expiresAt, token: token.token }
      }
      return token.token
    })
  }

  /**
   * At start: remove token files of owners not in `owners`, and temporary files a crash left. Owners this manager holds
   * keep their token file; their leftovers are removed under the owner's lock, which every write of theirs holds, so
   * none is a write in progress.
   */
  async prune(owners: readonly string[]): Promise<void> {
    const keep = new Set(owners.map(owner => owner.toLowerCase()))
    let names: string[]
    try {
      names = await readdir(this.#directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for (const name of names) {
      const leftover = LEFTOVER.exec(name)
      const owner = leftover?.[1] ?? (TOKEN_FILE.test(name) ? name : undefined)
      if (owner === undefined) continue
      const file = join(this.#directory, name)
      if (leftover !== null && this.#owners.has(owner)) {
        await this.#lock.run(owner, () => removeIfFile(file))
        continue
      }
      if (this.#owners.has(owner) || (leftover === null && keep.has(owner))) continue
      await removeIfFile(file)
    }
  }

  /**
   * Remove every token file this manager wrote, clear its timers. Safe to call twice. A write in progress is waited for
   * (no write starts once it is called), so nothing of it is on disk when this resolves.
   */
  close(): Promise<void> {
    if (this.#closing !== undefined) return this.#closing
    this.#closed = true
    for (const state of this.#owners.values()) this.#clearTimer(state)
    this.#closing = (async () => {
      await Promise.allSettled([...this.#writes])
      await Promise.all([...this.#written].map(file => rm(file, { force: true }).catch(() => {})))
      this.#written.clear()
    })()
    return this.#closing
  }

  /** The owner's state; throws when this manager holds no repos for it. */
  #held(owner: string): OwnerState {
    if (this.#closed) throw new Error('the token manager is closed')
    const state = this.#owners.get(owner)
    if (state === undefined) throw new Error(`dish holds no read token for ${owner}: no project of it has the App installed`)
    return state
  }

  /** Under the owner's lock: the file token, minted when it must be (or when `force`). */
  async #ensure(owner: string, force: boolean): Promise<{ dropped: string[] }> {
    const state = this.#held(owner)
    if (!force && state.repos.length > 0 && await this.#fresh(state)) return { dropped: [] }
    const { token, dropped, repos, installation } = state.repos.length === 0
      ? { token: undefined, dropped: [], repos: [], installation: state.installation }
      : await this.#mint(state, FILE_PERMISSIONS)
    // The owner went (or the manager closed) while the token was on its way: nothing is written.
    if (this.#owners.get(owner) !== state || this.#closed) return { dropped }
    if (token === undefined) {
      // No repo is left to read: no token, and no file.
      this.#clearTimer(state)
      state.file = undefined
      await this.#removeFile(owner)
      return { dropped }
    }
    await this.#write(owner, token.token)
    if (this.#owners.get(owner) !== state || this.#closed) return { dropped }
    // What the token covers: if the repos changed while it was minted, the change's own refresh, queued behind this one, mints again.
    state.file = { repos: reposKey(repos), installation, expiresAt: token.expiresAt }
    // Never sooner than a retry: a token that is short-lived already isn't asked for again in a loop.
    this.#schedule(state, Math.max(RETRY_AFTER_MS, token.expiresAt - REFRESH_BEFORE_MS - this.#now()))
    return { dropped }
  }

  /** Whether the file holds a token for the current repos, outside the refresh window, and is there. */
  async #fresh(state: OwnerState): Promise<boolean> {
    const file = state.file
    if (file === undefined || file.repos !== reposKey(state.repos) || file.installation !== state.installation) return false
    if (this.#now() >= file.expiresAt - REFRESH_BEFORE_MS) return false
    try {
      return (await lstat(join(this.#directory, state.owner))).isFile()
    } catch {
      return false
    }
  }

  /**
   * A token for the owner's repos with `permissions`. On a 422, the repos the installation lacks are dropped (and
   * logged) and it is asked again for the rest; `token` is undefined when none is left. A 422 with every repo still
   * there is the error itself. `installation` and `repos` are what the token covers.
   */
  async #mint(state: OwnerState, permissions: Readonly<Record<string, 'read'>>): Promise<Minted> {
    const installation = state.installation
    const repos = [...state.repos]
    try {
      return { token: await this.#app.createToken(installation, repos, permissions), dropped: [], repos, installation }
    } catch (error) {
      if (!(error instanceof GitHubError && error.kind === 'unprocessable')) throw error
      const dropped: string[] = []
      for (const repo of repos) {
        const found = await this.#app.installationFor(state.owner, repo)
        if (found === undefined || found.id !== installation) dropped.push(repo)
      }
      if (dropped.length === 0) throw error
      if (state.installation === installation) {
        state.repos = state.repos.filter(repo => !dropped.includes(repo))
        state.api = undefined
      }
      this.#logger.warn('the dish App can no longer read %s: its read token leaves %s out', dropped.map(repo => `${state.owner}/${repo}`).join(', '), dropped.length === 1 ? 'it' : 'them')
      const rest = repos.filter(repo => !dropped.includes(repo))
      if (rest.length === 0) return { token: undefined, dropped, repos: rest, installation }
      return { token: await this.#app.createToken(installation, rest, permissions), dropped, repos: rest, installation }
    }
  }

  /** Under the lock, never throwing: a refresh from a timer or a change of repos. A failure is logged once per distinct error and tried again in a minute. */
  async #refresh(state: OwnerState, force: boolean): Promise<void> {
    try {
      await this.#lock.run(state.owner, () => this.#ensure(state.owner, force))
      if (state.lastError !== undefined && this.#owners.get(state.owner) === state && !this.#closed) {
        state.lastError = undefined
        this.#logger.info('the read token for %s is current again', state.owner)
      }
    } catch (error) {
      if (this.#owners.get(state.owner) !== state || this.#closed) return
      const message = describe(error)
      if (state.lastError !== message) {
        state.lastError = message
        this.#logger.warn('could not refresh the read token for %s (trying again every minute): %s', state.owner, message)
      }
      this.#schedule(state, RETRY_AFTER_MS)
    }
  }

  #schedule(state: OwnerState, ms: number): void {
    this.#clearTimer(state)
    if (this.#closed) return
    state.timer = this.#timers.set(() => {
      state.timer = undefined
      if (this.#closed || this.#owners.get(state.owner) !== state) return
      void this.#refresh(state, true)
    }, ms)
  }

  #clearTimer(state: OwnerState): void {
    if (state.timer === undefined) return
    this.#timers.clear(state.timer)
    state.timer = undefined
  }

  /** The owner is no longer listed: its timer now, its file under its lock (after any job of its that is running). */
  #forget(owner: string): Promise<void> {
    const state = this.#owners.get(owner)
    if (state !== undefined) this.#clearTimer(state)
    this.#owners.delete(owner)
    return this.#lock.run(owner, async () => {
      // Listed again while this waited: its new state's job, queued after this one, writes a fresh file.
      await this.#removeFile(owner)
    }).catch((error: unknown) => {
      this.#logger.warn('could not remove the read token file of %s: %s', owner, describe(error))
    })
  }

  async #removeFile(owner: string): Promise<void> {
    const file = join(this.#directory, owner)
    await rm(file, { force: true })
    this.#written.delete(file)
  }

  /** `<token>\n` to the owner's file, 0600, atomically, in a 0700 directory. Tracked, so `close` can wait for it; refused once closed. */
  #write(owner: string, token: string): Promise<void> {
    if (this.#closed) return Promise.reject(new Error('the token manager is closed'))
    const job = this.#writeNow(owner, token)
    this.#writes.add(job)
    const settled = () => { this.#writes.delete(job) }
    job.then(settled, settled)
    return job
  }

  async #writeNow(owner: string, token: string): Promise<void> {
    const directory = this.#directory
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const info = await lstat(directory)
    if (!info.isDirectory()) throw new Error(`${directory} is not a directory`)
    // `writeFileAtomic` leaves a directory that is there already as it is.
    await chmod(directory, 0o700)
    const file = join(directory, owner)
    this.#written.add(file)
    await writeFileAtomic(file, `${token}\n`, 0o600)
  }
}
