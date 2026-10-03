/**
 * The world the service's and the plugin's tests run in: a fake GitHub (the API, and git over smart HTTP, wired so
 * every token the API mints is one git takes), the App's test key, temp work and state directories, dsh's real
 * workspace registry composition mounted on the test's own `Context`, and sibling stubs for the services
 * dish-workspaces reads with `ctx.get` (`credentials`, `dishProjects`, `dishCrew`).
 *
 * Nothing here reaches the network or the real home:
 * - the servers listen on 127.0.0.1, and every directory is a temp one;
 * - `useScratchProcess()` gives this test file's process a scratch `HOME` and `XDG_*`, no system or global git config,
 *   and no `DSH_DISH_HOME`, for the whole file: the service works in the background (the hourly round, a sweep after
 *   `create`), so a scratch home set only around one call wouldn't cover it. dish's own git drops every `GIT_*` name, so
 *   the modules' `internals.gitEnv` carry `GIT_CONFIG_NOSYSTEM` for it (`scratchGit()`).
 *
 * @module dish-workspaces/test/service-helpers
 */

import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before } from 'node:test'
import { format } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import session from '@deepseek-ai/dsh-session'
import persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import storage from '@deepseek-ai/dsh-storage'
import * as storageDomain from '@deepseek-ai/dsh-storage-domain'
import * as storageJson from '@deepseek-ai/dsh-storage-json'
import workspace from '@deepseek-ai/dsh-workspace'
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import type { ProjectState } from 'dish-projects'
import type { Project } from 'dish-projects/registry'
import { internals as cloneInternals } from '../src/clone.ts'
import type { WorkspacesInternals } from '../src/service.ts'
import { internals as sweepInternals } from '../src/sweep.ts'
import { internals as worktreeInternals } from '../src/worktrees.ts'
import { startFakeGit } from './fake-git-http.ts'
import type { FakeGitServer } from './fake-git-http.ts'
import { startFakeGitHub, testKeys } from './fake-github-api.ts'
import type { FakeGitHub } from './fake-github-api.ts'
import { NOSYSTEM, makeBare, scratchGitEnv, tempDir } from './helpers.ts'
import { HELPER } from './onboard-helpers.ts'

export { HELPER }

/** The credential names dish-workspaces reads by default. */
export const APP_ID_NAME = 'DISH_GITHUB_APP_ID'
export const PRIVATE_KEY_NAME = 'DISH_GITHUB_APP_PRIVATE_KEY'

const SCRATCH_ENV = ['HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'DSH_DISH_HOME'] as const

/**
 * For the whole test file: a scratch `HOME` (with a test identity in its `.gitconfig`), `XDG_*` under it, no system
 * config and the scratch global one for the git dish-config starts, and no `DSH_DISH_HOME`. Put back when the file ends.
 * Also sets the modules' `internals.gitEnv` to `NOSYSTEM` (`scratchGit`).
 */
export function useScratchProcess(): { home: () => string } {
  const saved = Object.fromEntries(SCRATCH_ENV.map(name => [name, process.env[name]]))
  let home = ''
  before(async () => {
    const dir = await tempDir()
    home = join(dir, 'home')
    await mkdir(join(home, '.config'), { recursive: true })
    await writeFile(join(home, '.gitconfig'), '[user]\n\tname = Test User\n\temail = test@example.test\n[init]\n\tdefaultBranch = main\n')
    process.env.HOME = home
    process.env.XDG_CONFIG_HOME = join(home, '.config')
    process.env.XDG_STATE_HOME = join(home, '.local', 'state')
    process.env.XDG_DATA_HOME = join(home, '.local', 'share')
    process.env.XDG_CACHE_HOME = join(home, '.cache')
    process.env.GIT_CONFIG_NOSYSTEM = '1'
    process.env.GIT_CONFIG_GLOBAL = join(home, '.gitconfig')
    process.env.GIT_CONFIG_SYSTEM = '/dev/null'
    delete process.env.DSH_DISH_HOME
    scratchGit()
  })
  after(() => {
    for (const name of SCRATCH_ENV) {
      const value = saved[name]
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })
  return { home: () => home }
}

/** dish's own git, in this test process, reads no system config. */
export function scratchGit(): void {
  cloneInternals.gitEnv = NOSYSTEM
  worktreeInternals.gitEnv = NOSYSTEM
  sweepInternals.gitEnv = NOSYSTEM
}

/** A project as dish-projects parses one. */
export function projectOf(name: string, overrides: Partial<Project> = {}): Project {
  const slash = name.indexOf('/')
  return {
    name, owner: name.slice(0, slash), repo: name.slice(slash + 1),
    family: 'acme', role: 'a test project', gate: 'true', gateTimeout: '1m', gateTimeoutMs: 60_000,
    setup: undefined, setupTimeout: '15m', setupTimeoutMs: 900_000, gateEnv: {},
    ...overrides,
  }
}

/** A `dishProjects` the test drives: the projects listed, their states, and a `list` the test can hold. */
export function projectsStub() {
  const listed = new Map<string, Project>()
  const states = new Map<string, ProjectState>()
  let held: Promise<void> | undefined
  let calls = 0
  return {
    add(project: Project, state: ProjectState = 'pending') {
      listed.set(project.name.toLowerCase(), project)
      states.set(project.name.toLowerCase(), state)
    },
    remove(name: string) {
      listed.delete(name.toLowerCase())
      states.delete(name.toLowerCase())
    },
    set(name: string, state: ProjectState) {
      states.set(name.toLowerCase(), state)
    },
    /** Hold every `list()` until the returned function is called. */
    hold(): () => void {
      let release = (): void => {}
      held = new Promise<void>((resolve) => { release = resolve })
      return () => { held = undefined; release() }
    },
    calls: () => calls,
    service: {
      async list() {
        calls++
        if (held !== undefined) await held
        return [...listed.values()]
      },
      async get(name: string) { return listed.get(name.toLowerCase()) },
      status(name: string) { return { state: states.get(name.toLowerCase()) ?? 'pending', at: 0 } },
      async retry() {},
      async problem() { return undefined },
    },
  }
}

export interface ServiceWorld {
  dir: string
  /** The fake git server's repositories: `<root>/<owner>/<repo>.git`. */
  root: string
  git: FakeGitServer
  github: FakeGitHub
  /** The App's id and private key, as the credentials stub hands them out. */
  credentials: Map<string, string>
  /** `<dir>/work` and `<dir>/state`. */
  workRoot: string
  state: string
  /** `scratchGitEnv` for gits the test starts itself. */
  env: Record<string, string>
  /** What the service is given: the work root, state, the fakes, and dish's real helper. */
  internals(overrides?: WorkspacesInternals): WorkspacesInternals
}

/**
 * A fresh fake GitHub holding `acme/widget` and `acme/gadget` (one commit on `main` each), with the App installed on
 * `acme` (id 77, both repos). `files` replaces widget's first commit.
 */
export async function startServiceWorld(options: { files?: Record<string, string> } = {}): Promise<ServiceWorld> {
  const dir = await tempDir()
  const root = join(dir, 'srv')
  await makeBare(join(root, 'acme', 'widget.git'), options.files ?? { 'README.md': '# widget\n' })
  await makeBare(join(root, 'acme', 'gadget.git'), { 'README.md': '# gadget\n' })
  const git = await startFakeGit(root)
  after(() => git.close())
  const keys = testKeys()
  const github = await startFakeGitHub({ publicKey: keys.publicKey })
  github.installations.set('acme', { id: 77, account: 'Acme', repos: new Set(['widget', 'gadget']) })
  github.onToken(token => { git.tokens.set(token, 'read') })
  const credentials = new Map([[APP_ID_NAME, String(github.app.id)], [PRIVATE_KEY_NAME, keys.privateKeyPem]])
  const workRoot = join(dir, 'work')
  const state = join(dir, 'state')
  const env = await scratchGitEnv(dir)
  return {
    dir, root, git, github, credentials, workRoot, state, env,
    internals: (overrides = {}) => ({ workRoot, state, api: github.api, web: git.origin, helper: HELPER, ...overrides }),
  }
}

/**
 * Provide `value` as the service `name` from a sibling plugin, the way dsh's plugins provide theirs (a service provided
 * at the root would hide a plugin reading it as a property). Dispose the handle to take the service away.
 */
export function provideStub(ctx: Context, name: string, value: unknown) {
  return ctx.plugin({
    name: `stub-${name}`,
    apply(own: Context) { (own as unknown as { provide(name: string, value: unknown): void }).provide(name, value) },
  } as never, undefined as never)
}

/** A `credentials` service that resolves the names in `values` (read on every call, so a test can change them). */
export function credentialsStub(values: Map<string, string>) {
  return {
    async resolve(ref: string) {
      const value = values.get(ref)
      return value === undefined ? undefined : { value, source: 'file' }
    },
  }
}

export interface CrewStub {
  /** By canonical worktree path: who is bound. */
  bindings: Map<string, Array<{ child: string, sessionId: string, role: string, title: string, running: boolean }>>
  /** Every path asked about. */
  asked: string[]
  service: { worktreeBindings(path: string): Promise<Array<{ child: string, sessionId: string, role: string, title: string, running: boolean }>> }
}

/** A `dishCrew` that answers `worktreeBindings` from a map. */
export function crewStub(): CrewStub {
  const bindings: CrewStub['bindings'] = new Map()
  const asked: string[] = []
  return {
    bindings,
    asked,
    service: {
      async worktreeBindings(path: string) {
        asked.push(path)
        return bindings.get(await realpath(path).catch(() => path)) ?? []
      },
    },
  }
}

/** Every warning or error logged in `ctx` by anyone, as `[name] type: text`; info lines too with `all`. */
export function watchLogs(ctx: Context, all = false): string[] {
  const seen: string[] = []
  ctx.logger.exporter({
    levels: { default: 3 },
    export: message => {
      if (all || message.type === 'error' || message.type === 'warn') seen.push(`[${message.name}] ${message.type}: ${format(...message.args)}`)
    },
  })
  return seen
}

export interface MountedRegistry {
  registry: WorkspaceRegistry
  /** Take it away again: its plugins, in reverse. */
  stop(): Promise<void>
}

/**
 * dsh's workspace registry, mounted on `ctx` as dsh-web-app mounts it (its storage under `<dir>/storages` and
 * `<dir>/sessions`), started.
 */
export async function mountRegistryOn(ctx: Context, dir: string): Promise<MountedRegistry> {
  const fibers = [
    ctx.plugin(storage),
    ctx.plugin(storageJson, { root: join(dir, 'storages') }),
    ctx.plugin(storageDomain, { backend: 'json' }),
    ctx.plugin(session),
    ctx.plugin(persistence, { root: join(dir, 'sessions') }),
    ctx.plugin(workspace),
  ]
  const registry = await waitFor('dsh-workspace to start', () => ctx.get('workspaceRegistry'))
  let stopped = false
  return {
    registry,
    async stop() {
      if (stopped) return
      stopped = true
      for (const fiber of fibers.reverse()) await fiber.dispose()
    },
  }
}

/** Poll `check` until it returns something other than `undefined` or `false`. */
export async function waitFor<T>(what: string, check: () => Promise<T | undefined | false> | T | undefined | false, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = await check()
    if (found !== undefined && found !== false) return found
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

/** A fake `timers` for the service: nothing runs until the test fires it. */
export interface FakeTimers {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
  /** The timers set and not yet fired or cleared. */
  pending(): Array<{ id: number, ms: number }>
  /** Fire (and drop) the first pending timer set for `ms`; throws when there is none. */
  fire(ms: number): void
}

export function fakeTimers(): FakeTimers {
  let next = 1
  const timers = new Map<number, { fn: () => void, ms: number }>()
  return {
    set(fn, ms) {
      const id = next++
      timers.set(id, { fn, ms })
      return id
    },
    clear(handle) {
      timers.delete(handle as number)
    },
    pending: () => [...timers].map(([id, { ms }]) => ({ id, ms })),
    fire(ms) {
      const found = [...timers].find(([, timer]) => timer.ms === ms)
      if (found === undefined) throw new Error(`no timer pending for ${ms} ms (pending: ${[...timers.values()].map(timer => timer.ms).join(', ') || 'none'})`)
      timers.delete(found[0])
      found[1].fn()
    },
  }
}
