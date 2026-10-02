/**
 * The `dishWorkspaces` service: the modules of dish-workspaces composed behind one lock per project, with the hourly
 * round, the read tokens and the workspace registry.
 *
 * - **One lock per project** (`KeyedLock`, keyed by the name lower-cased): `onboard`, `prepare`, `createWorktree`,
 *   `removeWorktree`, the sweep (with the fetch before it) and a late workspace registration never overlap in one clone.
 *   A job holds the lock until its work has settled, child processes included: an abort kills them (git's process
 *   group, setup's TERM then KILL), and the lock is released only once they are gone. The fetch `Worktrees` asks for runs
 *   inside the caller's job and never takes the lock itself. `resolve`, `listWorktrees` and `describe` don't lock.
 * - **Projects** are read from `dishProjects` (`ctx.get`) on each use: `createWorktree` takes only a ready project, and
 *   only from a chat with a workspace (`cwd`), which `Worktrees.create` checks is the clone or inside it.
 * - **`describe`** is synchronous: it answers from an in-memory copy of each clone's state (`clone.json`), loaded at
 *   `start` and read again after every operation that writes it.
 * - **The App's credentials** are read with `ctx.get('credentials')?.resolve(ref)` for every request that needs the JWT,
 *   and never kept. The bot identity (`GET /app`, then the public `GET /users/<slug>[bot]`, which GitHub limits to 60 an
 *   hour per address without a credential) is looked up once per service life, and again after either credential changes.
 * - **The App's status** (`appStatus`, for Settings → GitHub App): a test is `GET /app`, the installations and the bot's
 *   public profile, made with the credentials read for that one test and dropped after it. Its answer is remembered until
 *   either credential changes (`credentialsChanged`); a test that was under way when one did is not remembered. The answer
 *   has neither credential, and the texts in it have the App's ID and the lines of the key taken out as well as masked.
 * - **The read tokens:** the owner map (each owner's installation and the repos of its projects whose clone state names
 *   an installation) is recomputed at start, on `dish-projects/changed` and after each onboarding, one recompute at a
 *   time; onboarding's own addition of a new repo goes through the same queue, and only adds.
 * - **The workspace registry** (`useRegistry`, from the plugin's `ctx.inject(['workspaceRegistry'])`): each time one
 *   appears, the scratch workspace (once, by its record) and every ready project whose clone state has no workspace,
 *   each under its project's lock. A project whose onboarding found no registry at its last step is registered when
 *   dish-projects records it ready (`registerIfMissing`, on `dish-projects/status`), and a prepare registers one too.
 *   Every registration checks the signal, and that the project is still ready, inside the lock: a project removed while
 *   it onboarded, or while it waited for the lock, never gets a workspace.
 * - **The hourly round:** first `firstRoundMs` after `start`, then every `roundEveryMs`: per ready project, one at a time,
 *   under its lock: its fetch (which makes sure of its read token first), then the sweep. A round never overlaps the one
 *   before (a tick while one runs is skipped). A failure is logged once per project and error, and the round goes on.
 *   After `createWorktree` and `prepare` (each fetched), that project's sweep runs in the background.
 * - **`close`:** no more work is taken; every timer is cleared; everything in flight is aborted and awaited (its children
 *   dead), and rejects with an Error named `AbortError` (dish-projects leaves such a project pending, never failed); then
 *   the token files are removed (`TokenManager.close`).
 *
 * @module dish-workspaces/service
 */

import { readFileSync, readdirSync, realpathSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { DishProjects } from 'dish-projects'
import type { Project } from 'dish-projects/registry'
import { workRoot as defaultWorkRoot, xdgPaths } from 'dish-kit'
import { configureClone, defaultBranch, fetchClone, httpsUrl } from './clone.ts'
import type { CloneDeps } from './clone.ts'
import { shown } from './git.ts'
import { GITHUB_API, GITHUB_WEB, GitHubApp, GitHubError, botIdentity } from './github.ts'
import type { AppCredentials, GitHubClientOptions, PullSummary } from './github.ts'
import { hiding } from './hiding.ts'
import { KeyedLock } from './locks.ts'
import { appIdentity, onboardProject } from './onboard.ts'
import type { OnboardDeps, OnboardResult, OnboardStep } from './onboard.ts'
import { cloneStateFile, clonePath, helperValue, projectStateDir, scratchRecordFile, tokensDir } from './paths.ts'
import type { AppStatus } from './protocol.ts'
import { registerWorkspace } from './registry.ts'
import type { WorkspaceRegistryLike } from './registry.ts'
import { ensureScratch } from './scratch.ts'
import { parseCloneState, readCloneState, writeCloneState } from './state.ts'
import type { CloneState } from './state.ts'
import { sweepProject } from './sweep.ts'
import type { SweepResult } from './sweep.ts'
import { TokenManager } from './tokens.ts'
import type { OwnerRepos, TokenManagerOptions } from './tokens.ts'
import { SLUG, Worktrees } from './worktrees.ts'
import type { Binding, CreatedWorktree, Worktree, WorktreeDeps, WorktreeInfo } from './worktrees.ts'

/** The first hourly round runs this long after `start`. */
export const FIRST_ROUND_MS = 300_000
/** Then one every hour. */
export const ROUND_EVERY_MS = 3_600_000

export interface CloneInfo {
  /** The clone's path. */
  clone: string
  /** Whether dish adopted a clone it found there. */
  adopted: boolean
  /** The workspace dish registered for the clone, as dsh's registry has it now; null when there is none (or no registry to ask). */
  workspace: { id: string, title: string } | null
  lastFetch: { at: number, ok: boolean, message?: string } | null
  /** How many worktrees dish made in it (their records). */
  worktrees: number
}

export interface DishWorkspaces {
  /** Onboarding's steps 1 to 5 (onboard.ts), under the project's lock. */
  onboard(project: Project, options?: { signal?: AbortSignal, progress?: (step: OnboardStep) => void }): Promise<OnboardResult>
  /**
   * For a ready project at start: step 3 again (the helper path, the identity, the safety check), then its fetch; and its
   * workspace, if it has none and a registry is there. It fails only when the clone can't be configured or checked: a bot
   * identity GitHub can't give (the network not up yet) leaves the clone's own, and a failed fetch is in `lastFetch`;
   * each is logged once.
   */
  prepare(project: Project): Promise<void>
  /** What dish knows of `name`'s clone, from memory; undefined for a project with no clone state. */
  describe(name: string): CloneInfo | undefined
  createWorktree(project: string, slug: string, base?: string, options?: { cwd?: string, signal?: AbortSignal }): Promise<CreatedWorktree>
  /** One project's worktrees, or every ready project's. */
  listWorktrees(project?: string): Promise<WorktreeInfo[]>
  removeWorktree(project: string, slug: string, force?: boolean): Promise<void>
  /** For delegate and gates: `<project>/<slug>`, or a worktree's path (any spelling: crew's records are canonical); a worktree dish made, of a registered project. */
  resolve(pathOrRef: string): Promise<Worktree | undefined>
  /** Fetch, then sweep, one project or every ready one. */
  sweep(project?: string): Promise<SweepResult>
  /**
   * What GitHub says of the App, for Settings → GitHub App. `test` makes the test (`GET /app`, the installations, the bot) and
   * remembers its answer; without it the last answer is given from memory, and a test is made when there is none. A change to
   * either credential forgets the memory. The answer holds neither credential, and every text in it is masked. Never rejects
   * but for a service that has stopped.
   */
  appStatus(test: boolean): Promise<AppStatus>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    dishWorkspaces: DishWorkspaces
  }
}

/** For tests only; never config. */
export interface WorkspacesInternals {
  workRoot?: string
  state?: string
  /** GitHub's API (the fake's). */
  api?: string
  /** GitHub's web origin (the fake git server's). */
  web?: string
  /** The credential helper's path. */
  helper?: string
  /** The App client's `fetch`. */
  fetch?: typeof fetch
  /** The clock of the sweep's recent-resolve guard. */
  now?: () => number
  /** The hourly round's timers and the token refreshes'. */
  timers?: TokenManagerOptions['timers']
  firstRoundMs?: number
  roundEveryMs?: number
}

export interface WorkspacesConfig {
  /** The credential reference of the App's id. */
  appIdName: string
  /** The credential reference of the App's private key. */
  privateKeyName: string
}

export interface WorkspacesService extends DishWorkspaces {
  /** Load the clone states, recompute the tokens and prune stale token files, and set the first round. Not awaited. */
  start(): void
  /** Stop: see the module's notes. Safe to call twice. */
  close(): Promise<void>
  /** dsh's workspace registry appeared: use it until the returned function is called. */
  useRegistry(registry: WorkspaceRegistryLike): () => void
  /**
   * `dish-projects/status` said `name` is ready: register its workspace if its clone state has none and a registry is
   * there (a registry that appeared after its onboarding's last step looked, and before dish-projects recorded it ready).
   * Under its lock; a project no longer ready by then gets none. In the background; a failure is logged once.
   */
  registerIfMissing(name: string): void
  /** `dish-projects/changed` (with the names it carries, which the recompute doesn't need): recompute the owner map. */
  projectsChanged(names?: readonly string[]): void
  /** `credentials/reference-updated`: look the bot identity up again if `ref` is one of the App's. */
  credentialsChanged(ref: string): void
  /** Resolves when nothing is in flight. For tests. */
  idle(): Promise<void>
}

/** What dish-workspaces reads of crew (`dishCrew`), structurally: crew doesn't depend on it, nor it on crew. */
interface CrewReader {
  worktreeBindings(path: string): Promise<Array<{ child: string, role: string, title: string, running: boolean }>>
}

type Identity = { name: string, email: string }

/** The most bots (one per App slug) whose lookup is kept. */
const MAX_BOTS = 16

/** The longest error text a log line carries. */
const LOGGED_CHARS = 300

const defaultTimers: NonNullable<TokenManagerOptions['timers']> = {
  set(fn, ms) {
    const timer = setTimeout(fn, ms)
    timer.unref()
    return timer
  },
  clear(handle) {
    clearTimeout(handle as NodeJS.Timeout)
  },
}

/** dish's credential helper: `bin/git-credential-dish` beside this plugin's `src`, by its real path. */
function defaultHelper(): string {
  return realpathSync(fileURLToPath(new URL('../bin/git-credential-dish', import.meta.url)))
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** An error's text as a log line may carry it: one line, masked, cut short. */
function logged(error: unknown): string {
  return shown(messageOf(error), LOGGED_CHARS)
}

function isAbort(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === 'AbortError'
}

/** What a closed service rejects with: dish-projects reads the name and records nothing against the project. */
function stopped(): Error {
  const error = new Error('dish-workspaces stopped before this finished')
  error.name = 'AbortError'
  return error
}

/** The reason `signal` was aborted, as an Error named `AbortError`. */
function abortedBy(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  if (reason instanceof Error && reason.name === 'AbortError') return reason
  const error = new Error('aborted')
  error.name = 'AbortError'
  return error
}

/** How many worktree records `<project state>/worktrees` holds (`<slug>.json`). */
function countRecords(names: readonly string[]): number {
  return names.filter(name => /^(.+)\.json$/.test(name) && SLUG.test(name.slice(0, -'.json'.length))).length
}

/** `current` with `extra`'s owners merged in: their installation, and the repos of both. */
function mergeOwners(current: ReadonlyMap<string, OwnerRepos>, extra: ReadonlyMap<string, OwnerRepos>): Map<string, OwnerRepos> {
  const merged = new Map(current)
  for (const [owner, entry] of extra) {
    const key = owner.toLowerCase()
    const repos = [...(merged.get(key)?.repos ?? [])]
    for (const repo of entry.repos) if (!repos.some(item => item.toLowerCase() === repo.toLowerCase())) repos.push(repo)
    merged.set(key, { installation: entry.installation, repos })
  }
  return merged
}

class Service implements WorkspacesService {
  readonly #ctx: Context
  readonly #config: WorkspacesConfig
  readonly #logger: { info(format: string, ...args: unknown[]): void, warn(format: string, ...args: unknown[]): void }
  readonly #workRoot: string
  readonly #state: string
  readonly #web: string
  readonly #helper: string
  readonly #timers: NonNullable<TokenManagerOptions['timers']>
  readonly #firstRoundMs: number
  readonly #roundEveryMs: number
  readonly #app: GitHubApp
  readonly #tokens: TokenManager
  readonly #lock = new KeyedLock()
  readonly #worktrees: Worktrees
  readonly #worktreeDeps: WorktreeDeps
  readonly #cloneDeps: CloneDeps
  readonly #closing = new AbortController()
  readonly #inFlight = new Set<Promise<unknown>>()
  /** By project name, lower-cased: the clone states, and how many worktree records each has. */
  readonly #clones = new Map<string, CloneState>()
  readonly #counts = new Map<string, number>()
  /** By topic: the last error logged, so one that repeats is one line. */
  readonly #trouble = new Map<string, string>()
  #started = false
  #closed = false
  #closingDone: Promise<void> | undefined
  #registry: WorkspaceRegistryLike | undefined
  #registryGeneration = 0
  #owners = new Map<string, OwnerRepos>()
  #tokenQueue: Promise<void> = Promise.resolve()
  #identity: Promise<Identity> | undefined
  /** The App client's options (the API's address, a test's `fetch`): the status test builds its own client with them. */
  readonly #appOptions: GitHubClientOptions
  /** The last test of the App, until a credential changes; the test under way, if any; and a count of credential changes. */
  #lastApp: AppStatus | undefined
  #appTest: Promise<AppStatus> | undefined
  #credentialsGeneration = 0
  /**
   * The bots looked up, by the App's slug. `GET /users/<slug>[bot]` is public and costs the address's 60 an hour, which
   * onboarding spends too; a bot's id never changes, so a slug is asked once (a failure is not kept), whatever else changes.
   */
  readonly #bots = new Map<string, { id: number, login: string }>()
  #roundTimer: unknown
  #round: Promise<void> | undefined

  constructor(ctx: Context, config: WorkspacesConfig, internals: WorkspacesInternals) {
    this.#ctx = ctx
    this.#config = config
    const logger = ctx.logger('dish-workspaces')
    this.#logger = {
      info: (format, ...args) => { logger.info(format, ...args) },
      warn: (format, ...args) => { logger.warn(format, ...args) },
    }
    this.#workRoot = internals.workRoot ?? defaultWorkRoot()
    this.#state = internals.state ?? xdgPaths('dish').state
    this.#web = (internals.web ?? GITHUB_WEB).replace(/\/+$/, '')
    this.#helper = internals.helper ?? defaultHelper()
    this.#timers = internals.timers ?? defaultTimers
    this.#firstRoundMs = internals.firstRoundMs ?? FIRST_ROUND_MS
    this.#roundEveryMs = internals.roundEveryMs ?? ROUND_EVERY_MS
    this.#appOptions = { api: internals.api ?? GITHUB_API, ...(internals.fetch === undefined ? {} : { fetch: internals.fetch }) }
    // Read for every request that needs the JWT, and dropped once it is signed.
    this.#app = new GitHubApp(() => this.#readCredentials(), this.#appOptions)
    this.#tokens = new TokenManager({
      directory: tokensDir(this.#state),
      app: this.#app,
      logger: this.#logger,
      ...(internals.timers === undefined ? {} : { timers: internals.timers }),
    })
    this.#cloneDeps = { workRoot: this.#workRoot, state: this.#state, web: this.#web, helper: this.#helper, tokens: this.#tokens, logger: this.#logger }
    this.#worktreeDeps = {
      workRoot: this.#workRoot,
      state: this.#state,
      cloneExpectations: project => ({
        url: httpsUrl(this.#web, project.owner, project.repo),
        helper: helperValue(this.#helper, tokensDir(this.#state), this.#web),
        web: this.#web,
      }),
      // Inside the caller's job, which holds the project's lock: never takes it.
      fetch: (project, signal) => this.#fetch(project, signal),
      defaultBranch: async clone => (await defaultBranch(clone)) ?? 'main',
      bindings: path => this.#bindings(path),
      pulls: (project, sha) => this.#pulls(project, sha),
      ...(internals.now === undefined ? {} : { now: internals.now }),
    }
    // One for resolve, create, remove and the sweep: the recent-resolve guard is its memory.
    this.#worktrees = new Worktrees(this.#worktreeDeps)
  }

  // --- the life ------------------------------------------------------------------------------------------------------

  start(): void {
    if (this.#started || this.#closed) return
    this.#started = true
    this.#loadClones()
    this.#track((async () => {
      await this.#recomputeTokens()
      try {
        await this.#tokens.prune([...this.#owners.keys()])
      } catch (error) {
        this.#warnOnce('prune', logged(error), 'could not remove old read token files: %s', logged(error))
      }
    })())
    this.#scheduleRound(this.#firstRoundMs)
  }

  close(): Promise<void> {
    if (this.#closingDone !== undefined) return this.#closingDone
    this.#closed = true
    this.#closing.abort(stopped())
    if (this.#roundTimer !== undefined) {
      this.#timers.clear(this.#roundTimer)
      this.#roundTimer = undefined
    }
    this.#registry = undefined
    this.#registryGeneration++
    this.#closingDone = (async () => {
      await this.idle()
      await this.#tokens.close()
    })()
    return this.#closingDone
  }

  async idle(): Promise<void> {
    while (this.#inFlight.size > 0) await Promise.allSettled([...this.#inFlight])
  }

  useRegistry(registry: WorkspaceRegistryLike): () => void {
    if (this.#closed) return () => {}
    this.#registry = registry
    const generation = ++this.#registryGeneration
    // What ensureScratch has logged, for this registry's life: a reloaded registry starts clean.
    const logged = new Set<string>()
    this.#track((async () => {
      await ensureScratch({ registry, workRoot: this.#workRoot, record: scratchRecordFile(this.#state), logger: this.#logger, logged })
      await this.#registerReady(registry, generation)
    })())
    return () => {
      if (this.#registryGeneration === generation) {
        this.#registry = undefined
        this.#registryGeneration++
      }
      logged.clear()
    }
  }

  registerIfMissing(name: string): void {
    const registry = this.#registry
    if (this.#closed || registry === undefined) return
    const generation = this.#registryGeneration
    const topic = `workspace ${name.toLowerCase()}`
    this.#track((async () => {
      const project = await this.#projects()?.get(name)
      if (project === undefined) return
      await this.#locked(project, undefined, async (signal) => {
        if (this.#registryGeneration !== generation || !this.#stillReady(project)) return
        try {
          await this.#register(project, registry, signal)
        } finally {
          await this.#reload(project)
        }
      })
      this.#clearTrouble(topic)
    })().catch((error: unknown) => {
      if (!this.#closed && !isAbort(error)) this.#warnOnce(topic, logged(error), 'could not register the workspace of %s: %s', name, logged(error))
    }))
  }

  projectsChanged(_names?: readonly string[]): void {
    if (!this.#closed) this.#track(this.#recomputeTokens())
  }

  credentialsChanged(ref: string): void {
    if (ref !== this.#config.appIdName && ref !== this.#config.privateKeyName) return
    this.#identity = undefined
    // What was tested with the old credentials says nothing of the new, and a test still out must not be kept.
    this.#lastApp = undefined
    this.#appTest = undefined
    this.#credentialsGeneration++
  }

  // --- DishWorkspaces ------------------------------------------------------------------------------------------------

  async onboard(project: Project, options: { signal?: AbortSignal, progress?: (step: OnboardStep) => void } = {}): Promise<OnboardResult> {
    try {
      return await this.#locked(project, options.signal, async (signal) => {
        try {
          // A registry that appears after its last step looked registers the workspace once dish-projects records the
          // project ready (`registerIfMissing`).
          return await onboardProject(project, this.#onboardDeps(), { signal, ...(options.progress === undefined ? {} : { progress: options.progress }) })
        } finally {
          await this.#reload(project)
        }
      })
    } finally {
      this.projectsChanged()
    }
  }

  async prepare(project: Project): Promise<void> {
    await this.#locked(project, undefined, async (signal) => {
      try {
        const file = cloneStateFile(this.#state, project.owner, project.repo)
        const current = await readCloneState(file)
        if (current === undefined) {
          throw new Error(`dish has no record of ${project.name}'s clone (${file}); press Retry on Settings → Projects to onboard it again`)
        }
        if (current.installation !== null) await this.#addRepositories(new Map([[project.owner.toLowerCase(), { installation: current.installation, repos: [project.repo] }]]))
        const topic = `project ${project.name.toLowerCase()}`
        let troubled = false
        // The unit can start before the network is up: without the bot identity, the clone keeps the one it has, the
        // rest is configured all the same, and the project stays ready. The next prepare asks again.
        let identity: Identity | undefined
        try {
          identity = await this.#botIdentity()
        } catch (error) {
          troubled = true
          const why = error instanceof GitHubError && error.kind === 'no-credentials' ? 'the GitHub App isn\'t set on Settings → GitHub App' : logged(error)
          this.#warnOnce(topic, why, 'could not look up the dish App\'s bot identity for %s; its clone keeps the identity it has: %s', project.name, why)
        }
        // Configure first: the fetch checks the clone with today's helper path, which this puts back.
        await configureClone(current.clone, project, identity, this.#cloneDeps)
        if (signal.aborted) throw abortedBy(signal)
        try {
          await this.#fetch(project, signal)
        } catch (error) {
          if (signal.aborted || isAbort(error)) throw error
          troubled = true
          // Recorded in lastFetch, which the page shows; the round tries again.
          this.#warnOnce(topic, logged(error), 'could not fetch %s: %s', project.name, logged(error))
        }
        if (!troubled) this.#clearTrouble(topic)
        const registry = this.#registry
        if (registry !== undefined && this.#stillReady(project)) await this.#register(project, registry, signal)
      } finally {
        await this.#reload(project)
      }
    })
    this.#sweepLater(project)
  }

  describe(name: string): CloneInfo | undefined {
    const key = name.toLowerCase()
    const state = this.#clones.get(key)
    if (state === undefined) return undefined
    let workspace: CloneInfo['workspace'] = null
    const registry = this.#registry
    if (state.workspace !== null && registry !== undefined) {
      try {
        const found = registry.get(state.workspace.id as WorkspaceId)
        if (found !== undefined) workspace = { id: found.id, title: found.title }
      } catch {
        // A registry on its way out: no workspace to show.
      }
    }
    return {
      clone: state.clone,
      adopted: state.adopted,
      workspace,
      lastFetch: state.lastFetch === null ? null : { ...state.lastFetch },
      worktrees: this.#counts.get(key) ?? 0,
    }
  }

  async createWorktree(name: string, slug: string, base?: string, options: { cwd?: string, signal?: AbortSignal } = {}): Promise<CreatedWorktree> {
    if (this.#closed) throw stopped()
    const project = await this.#registered(name)
    const state = this.#projects()?.status(project.name).state ?? 'unknown'
    if (state !== 'ready') throw new Error(`${project.name} isn't ready (${state}); see Settings → Projects`)
    const cwd = options.cwd
    if (typeof cwd !== 'string' || cwd === '') {
      throw new Error(`this chat has no workspace, so a coder couldn't write in a worktree; start a chat in ${project.name}'s workspace`)
    }
    const created = await this.#locked(project, options.signal, async (signal) => {
      try {
        return await this.#worktrees.create(project, slug, base, { cwd, signal })
      } finally {
        await this.#reload(project)
      }
    })
    this.#sweepLater(project)
    return created
  }

  async listWorktrees(name?: string): Promise<WorktreeInfo[]> {
    if (name !== undefined) return this.#worktrees.list(await this.#registered(name))
    const all: WorktreeInfo[] = []
    for (const project of await this.#readyProjects()) {
      const topic = `list ${project.name.toLowerCase()}`
      try {
        all.push(...await this.#worktrees.list(project))
        this.#clearTrouble(topic)
      } catch (error) {
        this.#warnOnce(topic, logged(error), 'could not list the worktrees of %s: %s', project.name, logged(error))
      }
    }
    return all
  }

  async removeWorktree(name: string, slug: string, force = false): Promise<void> {
    if (this.#closed) throw stopped()
    const project = await this.#registered(name)
    await this.#locked(project, undefined, async (signal) => {
      try {
        // Whether it is merged is GitHub's word right after a fetch.
        if (!force) await this.#fetch(project, signal)
        await this.#worktrees.remove(project, slug, force)
      } finally {
        await this.#reload(project)
      }
    })
  }

  async resolve(pathOrRef: string): Promise<Worktree | undefined> {
    const projects = this.#projects()
    if (projects === undefined || this.#closed) return undefined
    return this.#worktrees.resolve(pathOrRef, await projects.list())
  }

  async sweep(name?: string): Promise<SweepResult> {
    if (this.#closed) throw stopped()
    const targets = name === undefined ? await this.#readyProjects() : [await this.#registered(name)]
    const total: SweepResult = { removed: [], kept: [] }
    for (const project of targets) {
      try {
        const result = await this.#locked(project, undefined, signal => this.#fetchAndSweep(project, signal, true))
        total.removed.push(...result.removed)
        total.kept.push(...result.kept)
      } catch (error) {
        if (name !== undefined || this.#closed) throw error
        const topic = `project ${project.name.toLowerCase()}`
        this.#warnOnce(topic, logged(error), 'could not fetch and sweep %s: %s', project.name, logged(error))
      }
    }
    return total
  }

  async appStatus(test: boolean): Promise<AppStatus> {
    if (this.#closed) throw stopped()
    if (!test && this.#lastApp !== undefined) return structuredClone(this.#lastApp)
    return structuredClone(await this.#testApp())
  }

  // --- the lock and the work in flight -------------------------------------------------------------------------------

  /**
   * `body` under `project`'s lock, with a signal that aborts on `callerSignal` or on `close`. The job is tracked, so
   * `close` waits for it; once closed, its failure is an `AbortError`.
   */
  async #locked<T>(project: Project, callerSignal: AbortSignal | undefined, body: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.#closed) throw stopped()
    const signal = callerSignal === undefined ? this.#closing.signal : AbortSignal.any([callerSignal, this.#closing.signal])
    if (signal.aborted) throw abortedBy(signal)
    const job = this.#lock.run(project.name.toLowerCase(), async () => {
      if (this.#closed) throw stopped()
      if (signal.aborted) throw abortedBy(signal)
      return body(signal)
    })
    this.#track(job)
    try {
      return await job
    } catch (error) {
      if (this.#closed && !isAbort(error)) throw stopped()
      throw error
    }
  }

  #track<T>(promise: Promise<T>): Promise<T> {
    this.#inFlight.add(promise)
    const done = (): void => { this.#inFlight.delete(promise) }
    promise.then(done, done)
    return promise
  }

  // --- the clone states ------------------------------------------------------------------------------------------------

  /** Every `<state>/workspaces/<owner>/<repo>/clone.json`, read now (small files; `describe` answers from memory). */
  #loadClones(): void {
    const root = join(this.#state, 'workspaces')
    let owners: string[]
    try {
      owners = readdirSync(root)
    } catch {
      return
    }
    for (const owner of owners) {
      let repos: string[]
      try {
        repos = readdirSync(join(root, owner))
      } catch {
        continue
      }
      for (const repo of repos) {
        let text: string
        try {
          text = readFileSync(join(root, owner, repo, 'clone.json'), 'utf8')
        } catch {
          continue
        }
        const state = parseCloneState(text)
        if (state === undefined) continue
        const key = `${owner}/${repo}`.toLowerCase()
        this.#clones.set(key, state)
        try {
          this.#counts.set(key, countRecords(readdirSync(join(root, owner, repo, 'worktrees'))))
        } catch {
          this.#counts.set(key, 0)
        }
      }
    }
  }

  /** `project`'s clone state and worktree count, read again after an operation that may have written them. Never throws. */
  async #reload(project: Project): Promise<void> {
    const key = project.name.toLowerCase()
    try {
      const state = await readCloneState(cloneStateFile(this.#state, project.owner, project.repo))
      if (state === undefined) {
        this.#clones.delete(key)
        this.#counts.delete(key)
        return
      }
      this.#clones.set(key, state)
      const names = await readdir(join(projectStateDir(this.#state, project.owner, project.repo), 'worktrees')).catch(() => [])
      this.#counts.set(key, countRecords(names))
    } catch {
      // What memory has stays; the next operation reads it again.
    }
  }

  /** The clone dish knows for `project`, else where it would be. */
  #cloneOf(project: Project): string {
    return this.#clones.get(project.name.toLowerCase())?.clone ?? clonePath(this.#workRoot, project.owner, project.repo)
  }

  /** The project's fetch (clone.ts), recorded in its clone state. The caller holds the project's lock. */
  #fetch(project: Project, signal?: AbortSignal): Promise<void> {
    return fetchClone(this.#cloneOf(project), project, this.#cloneDeps, signal)
  }

  async #fetchAndSweep(project: Project, signal: AbortSignal, fetchFirst: boolean): Promise<SweepResult> {
    try {
      if (fetchFirst) await this.#fetch(project, signal)
      if (signal.aborted) throw abortedBy(signal)
      const result = await sweepProject(project, this.#worktrees, this.#worktreeDeps)
      for (const item of result.removed) this.#logger.info('removed worktree %s/%s: its branch is merged (%s)', item.project, item.slug, item.by)
      for (const item of result.kept) {
        const topic = `sweep ${project.name.toLowerCase()}/${item.slug}`
        if (item.reason === 'error') this.#warnOnce(topic, item.detail ?? '', 'the sweep kept worktree %s/%s: %s', item.project, item.slug, item.detail ?? 'an error')
        else this.#clearTrouble(topic)
      }
      return result
    } finally {
      await this.#reload(project)
    }
  }

  /** The project's sweep, queued under its lock, in the background (after a fetch it just made). */
  #sweepLater(project: Project): void {
    if (this.#closed) return
    const topic = `project ${project.name.toLowerCase()}`
    this.#locked(project, undefined, signal => this.#fetchAndSweep(project, signal, false)).catch((error: unknown) => {
      if (!this.#closed && !isAbort(error)) this.#warnOnce(topic, logged(error), 'could not sweep %s: %s', project.name, logged(error))
    })
  }

  // --- the hourly round --------------------------------------------------------------------------------------------------

  #scheduleRound(ms: number): void {
    if (this.#closed) return
    this.#roundTimer = this.#timers.set(() => this.#tick(), ms)
  }

  #tick(): void {
    this.#roundTimer = undefined
    if (this.#closed) return
    this.#scheduleRound(this.#roundEveryMs)
    // Never two at once: a round that is still running when the next is due takes its place.
    if (this.#round !== undefined) return
    const round = this.#track(this.#runRound())
    this.#round = round
    void round.finally(() => { if (this.#round === round) this.#round = undefined })
  }

  /** Per ready project, one at a time: its fetch (its read token first), then its sweep. Never rejects. */
  async #runRound(): Promise<void> {
    let projects: Project[]
    try {
      projects = await this.#readyProjects()
      this.#clearTrouble('round')
    } catch (error) {
      this.#warnOnce('round', logged(error), 'the hourly round could not list the projects: %s', logged(error))
      return
    }
    for (const project of projects) {
      if (this.#closed) return
      const topic = `project ${project.name.toLowerCase()}`
      try {
        await this.#locked(project, undefined, signal => this.#fetchAndSweep(project, signal, true))
        this.#clearTrouble(topic)
      } catch (error) {
        if (this.#closed) return
        this.#warnOnce(topic, logged(error), 'the hourly round could not fetch and sweep %s: %s', project.name, logged(error))
      }
    }
  }

  // --- projects, crew, GitHub ----------------------------------------------------------------------------------------------

  #projects(): DishProjects | undefined {
    return this.#ctx.get('dishProjects')
  }

  /** Whether dish-projects says `project` is ready now (a removed one isn't: its status is forgotten). */
  #stillReady(project: Project): boolean {
    return this.#projects()?.status(project.name).state === 'ready'
  }

  /** The project called `name` (any case), registered now. */
  async #registered(name: string): Promise<Project> {
    const projects = this.#projects()
    if (projects === undefined) throw new Error('dish-projects isn\'t running, so no project is registered')
    const project = await projects.get(name)
    if (project === undefined) throw new Error(`no project ${shown(String(name), 100)} in projects.yaml; add it on Settings → Projects`)
    return project
  }

  async #readyProjects(): Promise<Project[]> {
    const projects = this.#projects()
    if (projects === undefined) return []
    return (await projects.list()).filter(project => projects.status(project.name).state === 'ready')
  }

  async #bindings(path: string): Promise<Binding[]> {
    const crew = (this.#ctx as unknown as { get(name: string): unknown }).get('dishCrew') as CrewReader | undefined
    if (crew === undefined) return []
    return (await crew.worktreeBindings(path)).map(({ child, role, title, running }) => ({ child, role, title, running }))
  }

  /** The pull requests holding `sha`, read with the in-memory API token; [] on an error, which is logged once. */
  async #pulls(project: Project, sha: string): Promise<PullSummary[]> {
    const topic = `pulls ${project.name.toLowerCase()}`
    try {
      const token = await this.#tokens.apiToken(project.owner)
      const pulls = await this.#app.pullsForCommit(project.owner, project.repo, sha, token)
      this.#clearTrouble(topic)
      return pulls
    } catch (error) {
      this.#warnOnce(topic, logged(error), 'could not ask GitHub for the pull requests of %s: %s', project.name, logged(error))
      return []
    }
  }

  /** The bot identity, looked up once per service life (and again after a credential change, or a failure). */
  #botIdentity(): Promise<Identity> {
    if (this.#identity === undefined) {
      const asked = appIdentity({ app: () => this.#app.app(), botUser: slug => this.#botUser(this.#app, slug) })
      this.#identity = asked
      asked.catch(() => { if (this.#identity === asked) this.#identity = undefined })
    }
    return this.#identity
  }

  /** The bot of `slug` (public, no credential): from memory when it has been looked up, else asked with `app` and kept. */
  async #botUser(app: Pick<GitHubApp, 'botUser'>, slug: string): Promise<{ id: number, login: string }> {
    const known = this.#bots.get(slug)
    if (known !== undefined) return { ...known }
    const bot = await app.botUser(slug)
    this.#bots.set(slug, { id: bot.id, login: bot.login })
    // A handful of Apps in a life; the oldest goes if there are ever more.
    if (this.#bots.size > MAX_BOTS) this.#bots.delete(this.#bots.keys().next().value!)
    return bot
  }

  /** The App's ID and private key, read from dsh's credential store now; `undefined` when either (or the store) is missing. Kept by nobody. */
  async #readCredentials(): Promise<AppCredentials | undefined> {
    const provider = this.#ctx.get('credentials')
    if (provider === undefined) return undefined
    const [appId, privateKey] = await Promise.all([
      provider.resolve(this.#config.appIdName as CredentialRef),
      provider.resolve(this.#config.privateKeyName as CredentialRef),
    ])
    return appId === undefined || privateKey === undefined ? undefined : { appId: appId.value, privateKey: privateKey.value }
  }

  /** The status test, shared by callers that come while it runs, and remembered unless a credential changed meanwhile. */
  #testApp(): Promise<AppStatus> {
    if (this.#appTest !== undefined) return this.#appTest
    const generation = this.#credentialsGeneration
    const run = this.#runAppTest().then((status) => {
      if (generation === this.#credentialsGeneration && !this.#closed) this.#lastApp = status
      return status
    })
    const tracked: Promise<AppStatus> = run.finally(() => { if (this.#appTest === tracked) this.#appTest = undefined })
    this.#appTest = tracked
    return tracked
  }

  /**
   * `GET /app`, then the installations and the bot's profile, as far as they go: what one call could not do is in `error`
   * and the rest of the answer stands. The credentials are read once, used by a client made for this test, and dropped.
   * Never rejects.
   */
  async #runAppTest(): Promise<AppStatus> {
    const status: AppStatus = {
      names: { appId: this.#config.appIdName, privateKey: this.#config.privateKeyName },
      app: null, bot: null, installations: [], error: null, checkedAt: null,
    }
    let credentials: AppCredentials | undefined
    let unreadable: unknown
    try {
      credentials = await this.#readCredentials()
    } catch (error) {
      unreadable = error
    }
    // `undefined` credentials are the client's own 'no-credentials' error before any request; so is a store that failed.
    const app = new GitHubApp(async () => {
      if (unreadable !== undefined) throw unreadable
      return credentials
    }, this.#appOptions)
    const hide = hiding(credentials === undefined ? [] : [credentials.appId, credentials.privateKey])
    const errors: string[] = []
    const fail = (error: unknown): void => { errors.push(shown(hide(messageOf(error)), LOGGED_CHARS)) }

    let slug: string | undefined
    try {
      const found = await app.app()
      status.app = { slug: found.slug, name: found.name }
      slug = found.slug
    } catch (error) {
      fail(error)
    }
    if (slug !== undefined) {
      try {
        status.installations = (await app.installations()).map(({ id, account, accountType, selection }) => ({ id, account, type: accountType, selection }))
      } catch (error) {
        fail(error)
      }
      try {
        const bot = await this.#botUser(app, slug)
        status.bot = { login: bot.login, email: botIdentity(slug, bot.id).email }
      } catch (error) {
        fail(error)
      }
    }
    status.error = errors.length === 0 ? null : errors.join('; ')
    status.checkedAt = Date.now()
    return status
  }

  #onboardDeps(): OnboardDeps {
    return {
      ...this.#cloneDeps,
      app: this.#app,
      tokens: {
        ensureFileToken: owner => this.#tokens.ensureFileToken(owner),
        setRepositories: byOwner => this.#addRepositories(byOwner),
      },
      repositories: () => this.#owners,
      registry: () => this.#registry,
      identity: () => this.#botIdentity(),
    }
  }

  // --- the read tokens ---------------------------------------------------------------------------------------------------

  /** `job` after every token job queued before it. */
  #queueTokens(job: () => Promise<void>): Promise<void> {
    const next = this.#tokenQueue.then(job, job)
    this.#tokenQueue = next.catch(() => {})
    return next
  }

  /** Onboarding's addition (a new repo for its owner): only adds to the map. */
  #addRepositories(byOwner: ReadonlyMap<string, OwnerRepos>): Promise<void> {
    return this.#queueTokens(async () => {
      const merged = mergeOwners(this.#owners, byOwner)
      await this.#tokens.setRepositories(merged)
      this.#owners = merged
    })
  }

  /** The owner map from the projects listed now and their clone states (read from disk, in the queue). Never rejects. */
  #recomputeTokens(): Promise<void> {
    return this.#queueTokens(async () => {
      try {
        const projects = this.#projects()
        if (projects === undefined || this.#closed) return
        const byOwner = new Map<string, OwnerRepos>()
        for (const project of await projects.list()) {
          const state = await readCloneState(cloneStateFile(this.#state, project.owner, project.repo)).catch(() => undefined)
          if (state === undefined || state.installation === null) continue
          const key = project.owner.toLowerCase()
          const entry = byOwner.get(key)
          byOwner.set(key, { installation: entry?.installation ?? state.installation, repos: [...(entry?.repos ?? []), project.repo] })
        }
        await this.#tokens.setRepositories(byOwner)
        this.#owners = byOwner
        this.#clearTrouble('tokens')
      } catch (error) {
        this.#warnOnce('tokens', logged(error), 'could not update the read tokens: %s', logged(error))
      }
    })
  }

  // --- the workspace registry ------------------------------------------------------------------------------------------

  /**
   * Register `project`'s clone with `registry` when its clone state has no workspace, and record it. The signal is
   * checked first: a project removed meanwhile gets none. Its workspace id (the one it had, or the new one).
   */
  async #register(project: Project, registry: WorkspaceRegistryLike, signal: AbortSignal): Promise<string | undefined> {
    if (signal.aborted) throw abortedBy(signal)
    const file = cloneStateFile(this.#state, project.owner, project.repo)
    const current = await readCloneState(file)
    if (current === undefined) return undefined
    if (current.workspace !== null) return current.workspace.id
    const workspace = await registerWorkspace(registry, current.clone, project.name)
    await writeCloneState(file, { ...current, workspace: { id: workspace.id, registeredAt: Date.now() } })
    this.#logger.info('%s is registered as workspace %s', project.name, workspace.id)
    return workspace.id
  }

  /** A registry appeared: every ready project whose clone state has no workspace, each under its lock. */
  async #registerReady(registry: WorkspaceRegistryLike, generation: number): Promise<void> {
    const projects = this.#projects()
    if (projects === undefined) return
    let listed: Project[]
    try {
      listed = await projects.list()
    } catch (error) {
      this.#warnOnce('register', logged(error), 'could not list the projects to register their workspaces: %s', logged(error))
      return
    }
    for (const project of listed) {
      if (this.#closed || this.#registryGeneration !== generation) return
      if (projects.status(project.name).state !== 'ready') continue
      const topic = `workspace ${project.name.toLowerCase()}`
      try {
        await this.#locked(project, undefined, async (signal) => {
          // Removed (or no longer ready) while it waited for the lock: no workspace.
          if (this.#registryGeneration !== generation || !this.#stillReady(project)) return
          try {
            await this.#register(project, registry, signal)
          } finally {
            await this.#reload(project)
          }
        })
        this.#clearTrouble(topic)
      } catch (error) {
        if (this.#closed) return
        this.#warnOnce(topic, logged(error), 'could not register the workspace of %s: %s', project.name, logged(error))
      }
    }
  }

  // --- logging --------------------------------------------------------------------------------------------------------

  #warnOnce(topic: string, message: string, format: string, ...args: unknown[]): void {
    if (this.#trouble.get(topic) === message) return
    this.#trouble.set(topic, message)
    this.#logger.warn(format, ...args)
  }

  #clearTrouble(topic: string): void {
    this.#trouble.delete(topic)
  }
}

/** The service over `ctx` (for `credentials`, `dishProjects`, `dishCrew` and the logger). `start` it, and `close` it when the plugin goes. */
export function createDishWorkspaces(ctx: Context, config: WorkspacesConfig, internals: WorkspacesInternals = {}): WorkspacesService {
  return new Service(ctx, config, internals)
}
