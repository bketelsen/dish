/**
 * What the service and plugin tests share: temporary directories, a real vault and a real stand-in for the config store
 * in them, fakes for dish's other services, and agents at a working directory. Every repository is opened in a
 * `mkdtemp(join(tmpdir(), 'dish-memory-'))` directory, and every remote is a local bare repository.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after } from 'node:test'
import { format } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import { Git, NamespaceRegistry, StoreError, VersionedStore } from 'dish-kit/store'
import type { Author, CommitInfo, ErrorCode, GitIdentity, RemoteStatus, StoreNaming } from 'dish-kit/store'
import type { TextScreen, TextScreenRequest } from 'dish-judge'
import { validateDirection } from '../src/format.ts'
import type { Budget, MemoryInput, Scope } from '../src/format.ts'
import type { ErrorCode as MemoryErrorCode } from '../src/protocol.ts'
import { MemoryError, createMemory } from '../src/service.ts'
import type { AgentLike, DishMemory } from '../src/service.ts'
import type { Services } from '../src/services.ts'
import { openVault } from '../src/vault.ts'

export const COMMIT = /^[0-9a-f]{40}$/
export const USER_IDENTITY: GitIdentity = { name: 'Test User', email: 'user@test' }
export const AGENT_IDENTITY: GitIdentity = { name: 'Test Agent', email: 'agent@test' }
/** The time the world's clock starts at, and so every memory's `modified` unless the test moves it. */
export const START = Date.parse('2026-10-05T12:00:00Z')
export const MODIFIED = '2026-10-05T12:00:00Z'
export const BUDGET: Budget = { lines: 150, bytes: 16_384 }

export const USER: Scope = { kind: 'user' }
export const ACME: Scope = { kind: 'family', family: 'acme' }
export const AS_USER = { author: { kind: 'user' } } as const
export const AS_AGENT = { author: { kind: 'agent', sessionId: 'session-1', role: 'main' } } as const

/** The words the config store opens its store with, for the stand-in. */
const CONFIG_NAMING: StoreNaming = { label: 'config store', kind: 'config', logName: 'dish-config', warningCode: 'DISH_CONFIG' }

const made: string[] = []
const opened: VersionedStore[] = []

after(async () => {
  await Promise.all(opened.splice(0).map(store => store.close().catch(() => {})))
  await Promise.all(made.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/** A fresh empty directory under the OS temp dir, removed when the test file finishes. */
export async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dish-memory-'))
  made.push(dir)
  return dir
}

/** A memory's input: `name`, with a description and a body of its own unless given. */
export function input(name: string, fields: Partial<MemoryInput> = {}): MemoryInput {
  return { name, type: 'feedback', description: `About ${name}`, body: `What ${name} says.`, ...fields }
}

export interface TestVaultOptions {
  repository?: string
  remote?: string
  onCommit?: (info: CommitInfo) => void
  onRemoteStatus?: (status: RemoteStatus) => void
}

/** A real vault, opened as the plugin opens it, in a temporary directory (or at `repository`). Closed when the test file finishes. */
export async function openTestVault(options: TestVaultOptions = {}): Promise<VersionedStore> {
  const store = await openVault({
    repository: options.repository ?? join(await tempDir(), 'vault.git'),
    ...(options.remote === undefined ? {} : { remote: options.remote }),
    user: USER_IDENTITY,
    agent: AGENT_IDENTITY,
    ...(options.onCommit === undefined ? {} : { onCommit: options.onCommit }),
    ...(options.onRemoteStatus === undefined ? {} : { onRemoteStatus: options.onRemoteStatus }),
  })
  opened.push(store)
  return store
}

/**
 * The stand-in for `dishConfig`: a second store in a temporary directory, under the config store's words, with
 * `families/` claimed as dish-memory claims it there. Closed when the test file finishes.
 */
export async function openTestConfig(): Promise<VersionedStore> {
  const namespaces = new NamespaceRegistry()
  namespaces.claim({ prefix: 'families/', owner: 'dish-memory', agent: 'propose', validate: validateDirection })
  const store = await VersionedStore.open({
    repository: join(await tempDir(), 'config.git'),
    namespaces,
    user: USER_IDENTITY,
    agent: AGENT_IDENTITY,
    naming: CONFIG_NAMING,
  })
  opened.push(store)
  return store
}

/** A bare repository to push to. */
export async function bareRemote(): Promise<{ path: string, git: Git }> {
  const path = join(await tempDir(), 'remote.git')
  const git = new Git(path)
  await git.initBare('main')
  return { path, git }
}

/** A project as the fake `dishProjects` lists it. */
export interface FakeProject { name: string, family: string, role?: string }

/** A fake judge: each call gives the next of `script` (the last repeats); an `Error` is thrown. Every request is kept. */
export interface FakeJudge {
  screenText(request: TextScreenRequest): Promise<TextScreen>
  requests: TextScreenRequest[]
}

export function fakeJudge(script: ReadonlyArray<TextScreen | Error>): FakeJudge {
  const requests: TextScreenRequest[] = []
  return {
    requests,
    async screenText(request) {
      const answer = script[Math.min(requests.length, script.length - 1)]!
      requests.push(request)
      if (answer instanceof Error) throw answer
      return answer
    },
  }
}

export interface FakeServicesOptions {
  /** What `dishProjects.list()` gives; leave it out for no `dishProjects`. */
  projects?: FakeProject[]
  /** Each project's clone, by project name, for `dishWorkspaces.describe`; leave it out for no `dishWorkspaces`. */
  clones?: Record<string, string>
  judge?: FakeJudge
  /** `true` for a config store of its own (`openTestConfig`), a store for that one; leave it out for no `dishConfig`. */
  config?: boolean | VersionedStore
}

export interface FakeServices extends Services {
  /** The stand-in for the config store, when there is one. */
  store: VersionedStore | undefined
  /** How often each service was asked. */
  calls: { list: number, describe: number, screenText: number }
  /**
   * Change what the services are: a field given replaces that one (`undefined` takes the service away). With
   * `projectsError`, `dishProjects.list()` rejects with it; with `projectsProblem`, `dishProjects.problem()` says it
   * (and `list()` gives `[]`, as dish-projects does for a broken `projects.yaml`); with `configReadError`,
   * `dishConfig.read()` rejects with it. Each lasts until it's set to `undefined`.
   */
  set(changes: {
    projects?: FakeProject[], projectsError?: Error, projectsProblem?: string, clones?: Record<string, string>, judge?: FakeJudge,
    config?: VersionedStore, configReadError?: Error,
  }): void
}

/** dish's services as the service reads them, faked, but for the config store, which is a real store in a temporary directory. */
export async function fakeServices(options: FakeServicesOptions = {}): Promise<FakeServices> {
  let { projects, clones, judge } = options
  let projectsError: Error | undefined
  let projectsProblem: string | undefined
  let configReadError: Error | undefined
  let store = options.config === true ? await openTestConfig() : options.config === false ? undefined : options.config
  const calls = { list: 0, describe: 0, screenText: 0 }
  const services: FakeServices = {
    get store() { return store },
    calls,
    set(changes) {
      if ('projects' in changes) projects = changes.projects
      if ('projectsError' in changes) projectsError = changes.projectsError
      if ('projectsProblem' in changes) projectsProblem = changes.projectsProblem
      if ('clones' in changes) clones = changes.clones
      if ('judge' in changes) judge = changes.judge
      if ('config' in changes) store = changes.config
      if ('configReadError' in changes) configReadError = changes.configReadError
    },
    config: () => {
      const real = store
      if (real === undefined || configReadError === undefined) return real
      const failure = configReadError
      return {
        head: () => real.head(),
        read: async () => { throw failure },
        write: (changes, meta) => real.write(changes, meta),
        proposals: () => real.proposals(),
      }
    },
    projects: () => projects === undefined ? undefined : {
      list: async () => {
        calls.list++
        if (projectsError !== undefined) throw projectsError
        if (projectsProblem !== undefined) return []
        return (projects ?? []).map(project => ({ name: project.name, family: project.family, role: project.role ?? '' }))
      },
      problem: async () => {
        if (projectsError !== undefined) throw projectsError
        return projectsProblem
      },
    },
    workspaces: () => clones === undefined ? undefined : {
      describe: (name: string) => {
        calls.describe++
        const clone = clones?.[name]
        return clone === undefined ? undefined : { clone }
      },
    },
    judge: () => judge === undefined ? undefined : {
      screenText: (request: TextScreenRequest) => {
        calls.screenText++
        return judge!.screenText(request)
      },
    },
  }
  return services
}

let agents = 0

/** An agent whose session works in `cwd`: the main agent, or a child at `depth`. Each gets an id of its own unless given. */
export function agentAt(cwd: string | undefined, options: { depth?: number, id?: string } = {}): AgentLike {
  const depth = options.depth ?? 0
  const header: { cwd?: string, delegationDepth?: unknown, origin?: unknown } = { delegationDepth: depth }
  if (cwd !== undefined) header.cwd = cwd
  if (depth > 0) header.origin = 'subagent'
  return { id: options.id ?? `agent-${++agents}`, session: { header }, options: {} }
}

export interface MemoryWorld {
  memory: DishMemory & { clearCaches(): void }
  store: VersionedStore
  services: FakeServices
  /** Every `dish-memory/changed` the service emitted, in order. */
  events: Array<{ scopes: string[], commit: string, author: Author }>
  /** Every warning the service gave. */
  warnings: string[]
  /** The service's clock, in milliseconds since the epoch: move it with `clock.now += …`. */
  clock: { now: number }
}

/** A service over a real vault in a temporary directory, with `fakeServices(options)` and a clock of its own. */
export async function memoryWorld(options: FakeServicesOptions & { budget?: Budget } = {}): Promise<MemoryWorld> {
  const store = await openTestVault()
  const services = await fakeServices(options)
  const events: MemoryWorld['events'] = []
  const warnings: string[] = []
  const clock = { now: START }
  const memory = createMemory({
    store,
    services,
    budget: options.budget ?? BUDGET,
    warn: message => { warnings.push(message) },
    emit: (scopes, commit, author) => { events.push({ scopes, commit, author }) },
    now: () => clock.now,
  })
  return { memory, store, services, events, warnings, clock }
}

/** For `assert.rejects`: a `MemoryError` or a `StoreError` with this `code`, and this message when one is given. */
export function refusal(code: MemoryErrorCode | ErrorCode, message?: string | RegExp): (error: unknown) => boolean {
  return (error: unknown) => {
    if (!(error instanceof MemoryError) && !(error instanceof StoreError)) throw new Error(`expected a MemoryError or a StoreError, got ${String(error)}`)
    if (error.code !== code) throw new Error(`expected ${code}, got ${error.code}: ${error.message}`)
    if (typeof message === 'string' && error.message !== message) throw new Error(`expected the message ${JSON.stringify(message)}, got ${JSON.stringify(error.message)}`)
    if (message instanceof RegExp && !message.test(error.message)) throw new Error(`expected a message matching ${String(message)}, got ${JSON.stringify(error.message)}`)
    return true
  }
}

/** Poll `check` until it returns something other than `undefined` or `false`. */
export async function waitFor<T>(what: string, check: () => Promise<T | undefined | false> | T | undefined | false, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = await check()
    if (found !== undefined && found !== false) return found
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 15))
  }
}

/** What `ctx.plugin` gives: wait for the plugin, and unload it. */
export interface Handle extends PromiseLike<unknown> {
  dispose(): Promise<void> | void
}

/** A plugin of its own that provides `value` as `name`: a sibling's service, as dish-memory reads them with `ctx.get`. */
export function provideStub(ctx: Context, name: string, value: unknown): Handle {
  return ctx.plugin({
    name: `stub-${name}`,
    apply(own: Context) { (own as unknown as { provide(name: string, value: unknown): void }).provide(name, value) },
  } as never, undefined as never) as unknown as Handle
}

/** Every line any plugin logs in `ctx`, as `[name] type: text`. */
export function watchLogs(ctx: Context): string[] {
  const seen: string[] = []
  ctx.logger.exporter({
    levels: { default: 3 },
    export: ({ name, type, args }) => { seen.push(`[${name}] ${type}: ${format(...args)}`) },
  })
  return seen
}
