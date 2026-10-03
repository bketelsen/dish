/**
 * The world orchestrator's service, listener, tool and remote tests run in (Tasks 8–11; Tasks 9, 10 and 11 read it and
 * don't change it):
 *
 * - **`world()`**: temp `state` and `data` directories, a `Runs` over them with a clock the test sets, and a stub of each
 *   sibling's service. Each stub is a plain object that records its calls (`calls.<method>`, the arguments of each, oldest
 *   first) and runs `impl.<method>`, which a test replaces to change what it does. A service in `absent` isn't there.
 * - **`pluginWorld()`**: the same stubs, provided by sibling plugins in a cordis `Context`, and dish-orchestrator mounted
 *   there over the world's directories (its `Runs` is the world's), optionally with dsh's `ToolRuntime` and crew's real host
 *   plugin.
 * - **Builders** for crew's and dish-gates' event payloads, and `ToolRunContext`s for the main agent and a crew child.
 *
 * Nothing here runs a process or reaches a network.
 *
 * @module dish-orchestrator/test/service-helpers
 */

import { mkdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { format } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ChildRecord, CrewRecords, GateResult, RunRecord as CrewRunRecord, WorktreeBinding } from 'dish-crew'
import type { GateCheck } from 'dish-gates'
import type { Project } from 'dish-projects'
import type { CreatedWorktree, PullFeedback, Worktree } from 'dish-workspaces'
import type { LedgerEntry } from '../src/entries.ts'
import type { Config } from '../src/index.ts'
import { Ledger } from '../src/ledger.ts'
import type { Delegated, GateFinished, Settled } from '../src/listeners.ts'
import { Runs } from '../src/runs.ts'
import type { Logger, RunsDeps, ToolDeps } from '../src/runs.ts'
import type { CreatedForRun } from '../src/service.ts'
import type { AgentsReader, CrewReader, GatesReader, ProjectsReader, Services, WorkspacesReader } from '../src/services.ts'
import { RunStore } from '../src/store.ts'
import type { Run } from '../src/store.ts'
import { NOW, SHA_A, SHA_B, tempDir } from './helpers.ts'

export { NOW, SHA_A, SHA_B, SHA_C, TOKEN, MASKED_TOKEN, tempDir } from './helpers.ts'

/** The main agent of the first chat: its `String(agent.id)`, crew's session id. */
export const SESSION = 'session-1'
/** Another chat's. */
export const OTHER_SESSION = 'session-2'
/** The project most tests use, as projects.yaml writes it. */
export const PROJECT = 'Acme/widget'
/** A second registered project. */
export const OTHER_PROJECT = 'Acme/gadget'
/** The commit every stub worktree is cut from (`created.base`). */
export const BASE = SHA_A
/** The HEAD every stub worktree has unless a test says otherwise. */
export const HEAD = SHA_B

// --- the stubs -----------------------------------------------------------------------------------------------------

/** Each method's calls: the arguments of each, oldest first. */
export type Calls<T> = { [K in keyof T]: T[K] extends (...args: infer A) => unknown ? A[] : never }

/** A sibling's service as a stub: `service` is handed out, records each call in `calls`, and runs `impl`'s method. */
export interface Stub<T> {
  /** What each method does: replace one to change it (the change is seen at once, through `service`). */
  impl: T
  calls: Calls<T>
  service: T
}

/** A stub over `impl`'s methods. */
export function stub<T extends object>(impl: T): Stub<T> {
  const calls: Record<string, unknown[]> = {}
  const service: Record<string, unknown> = {}
  for (const name of Object.keys(impl)) {
    calls[name] = []
    service[name] = (...args: unknown[]) => {
      calls[name]!.push(args)
      return (impl as Record<string, (...given: unknown[]) => unknown>)[name]!(...args)
    }
  }
  return { impl, calls: calls as Calls<T>, service: service as T }
}

/** What the crew stub does: `records.lookup` and `worktreeBindings`. */
export interface CrewImpl {
  lookup(childId: string): Promise<{ sessionId: string, record: ChildRecord } | undefined>
  worktreeBindings(worktree: string): Promise<WorktreeBinding[]>
}

/** The siblings a world has. */
export type ServiceName = 'workspaces' | 'crew' | 'gates' | 'projects' | 'agents'

/** A registered project, as dish-projects gives it. */
export function projectOf(name: string): Project {
  const [owner = '', repo = ''] = name.split('/')
  return {
    name, owner, repo, family: 'anthropic', role: 'a test project', gate: 'pnpm test', gateTimeout: '5m', gateTimeoutMs: 300_000,
    setup: undefined, setupTimeout: '15m', setupTimeoutMs: 900_000, gateEnv: {},
  }
}

/** A pull request's feedback with nothing on it yet: `readPull`'s default answer. */
export function pullFeedback(project: string, number: number, overrides: Partial<PullFeedback> = {}): PullFeedback {
  return {
    number, url: `https://github.com/${project}/pull/${number}`, title: 'A change', state: 'open', merged: false, draft: false,
    mergeable: true, mergeableState: 'clean', head: { ref: 'dish/fix-login', sha: HEAD }, base: { ref: 'main' },
    reviews: [], reviewComments: [], issueComments: [], checks: [],
    more: { reviews: false, reviewComments: false, issueComments: false, checks: false },
    ...overrides,
  }
}

// --- the world -----------------------------------------------------------------------------------------------------

export interface WorldOptions {
  /** The clock's first reading. Default: NOW. */
  now?: number
  /** The core's time limits, for a test of them. */
  limits?: RunsDeps['limits']
}

export interface World {
  dir: string
  state: string
  data: string
  /** What the core's clock reads: set `clock.now` to move it. */
  clock: { now: number }
  /** Every line the core logged, as `info: …` or `warn: …`. */
  logs: string[]
  runs: Runs
  store: RunStore
  ledger: Ledger
  /** The services as the core reads them: the stubs, less those in `absent`. */
  services: Services
  /** What a tool is made from: `{ runs, services }`. */
  deps: ToolDeps
  /** Services that aren't running: `services.<name>()` gives undefined. */
  absent: Set<ServiceName>
  workspaces: Stub<WorkspacesReader>
  crew: Stub<CrewImpl>
  gates: Stub<GatesReader>
  projects: Stub<ProjectsReader>
  /** dsh's agent registry: the ids that have a live agent. */
  live: Set<string>
  /** `resolve`'s answers, by a worktree's path and by `<project>/<slug>`. `worktree()` fills it. */
  worktrees: Map<string, Worktree>
  /** `headOf`'s answers, by a worktree's path. */
  heads: Map<string, string>
  /** crew's record, by child id: `records.lookup`'s answers. */
  children: Map<string, { sessionId: string, record: ChildRecord }>
  /** `worktreeBindings`' answers, by path. */
  bindings: Map<string, WorktreeBinding[]>
  /** The projects `projects.get` knows (compared without case). */
  registered: Set<string>
  /**
   * A real directory `<dir>/work/<owner>/<repo>/.worktrees/<slug>` (its real path, so a link to it can be told apart), known
   * to `resolve` by its path and by `<project>/<slug>`, with `head` (default HEAD) for `headOf`.
   */
  worktree(slug: string, options?: { project?: string, head?: string }): Promise<string>
  /** What the `worktree` tool gives `worktreeCreated` for a new worktree `slug` (made with `worktree`). */
  created(slug: string, options?: { project?: string, baseRef?: string }): Promise<CreatedForRun>
  /** A run opened as `run` `open` opens one: its worktree made, then `openAround` under the session's lock. */
  open(options?: { session?: string, slug?: string, project?: string, goal?: string, plan?: { path: string, commit: string }, how?: 'run' | 'auto' }): Promise<Run>
  /** The run's ledger, oldest first, once its queue is written. */
  entries(run: Run): Promise<LedgerEntry[]>
  /** The kinds of `entries(run)`. */
  kinds(run: Run): Promise<string[]>
  /** The record as the store has it now. */
  record(run: Run): Run | undefined
  /** A restart: a new store, ledger and `Runs` over the same directories and stubs, loaded. Replaces the world's. */
  restart(): Promise<Runs>
}

/** A logger that keeps each line. */
function keeping(lines: string[]): Logger {
  return {
    info: (text, ...args) => { lines.push(`info: ${format(text, ...args)}`) },
    warn: (text, ...args) => { lines.push(`warn: ${format(text, ...args)}`) },
  }
}

/** The directories, the clock and the stubs of a world, without its core. */
async function parts(options: WorldOptions) {
  const dir = await tempDir()
  const state = join(dir, 'state')
  const data = join(dir, 'data')
  const clock = { now: options.now ?? NOW }
  const worktrees = new Map<string, Worktree>()
  const heads = new Map<string, string>()
  const children = new Map<string, { sessionId: string, record: ChildRecord }>()
  const bindings = new Map<string, WorktreeBinding[]>()
  const registered = new Set<string>([PROJECT, OTHER_PROJECT])
  const live = new Set<string>()
  let pulls = 0

  const worktree = async (slug: string, given: { project?: string, head?: string } = {}): Promise<string> => {
    const project = given.project ?? PROJECT
    const clone = join(dir, 'work', ...project.split('/'))
    const made = join(clone, '.worktrees', slug)
    await mkdir(made, { recursive: true })
    const path = await realpath(made)
    const found: Worktree = { project, slug, branch: `dish/${slug}`, path, clone: await realpath(clone), base: BASE }
    worktrees.set(path, found)
    worktrees.set(`${project}/${slug}`, found)
    heads.set(path, given.head ?? HEAD)
    return path
  }
  const resolve = async (pathOrRef: string): Promise<Worktree | undefined> => {
    const found = worktrees.get(pathOrRef) ?? worktrees.get(await realpath(pathOrRef).catch(() => pathOrRef))
    return found === undefined ? undefined : { ...found }
  }

  const workspaces = stub<WorkspacesReader>({
    async createWorktree(project, slug, base) {
      const path = await worktree(slug, { project })
      const created: CreatedWorktree = { ...worktrees.get(path)!, setup: { ran: false, reason: 'no setup' }, baseRef: base ?? 'origin/main' }
      return created
    },
    resolve,
    async resolveProblem() { return undefined },
    async headOf(pathOrRef) {
      const found = await resolve(pathOrRef)
      return found === undefined ? undefined : heads.get(found.path)
    },
    async isClean() { return { clean: true } },
    async compareBranch() { return { behindDefault: 0, aheadOfDefault: 1, remoteAhead: null } },
    async pushBranch(_project, _slug, pushed) { return { head: pushed.head } },
    async openPull(project) {
      pulls += 1
      return { url: `https://github.com/${project}/pull/${pulls}`, number: pulls, existing: false }
    },
    async updatePull() {},
    async commentPull() {},
    async readPull(project, number) { return pullFeedback(project, number) },
  })
  const crew = stub<CrewImpl>({
    async lookup(childId) {
      const found = children.get(childId)
      return found === undefined ? undefined : structuredClone(found)
    },
    async worktreeBindings(path) { return structuredClone(bindings.get(path) ?? []) },
  })
  const gates = stub<GatesReader>({
    async runAt(_project, worktreePath, options): Promise<GateCheck> {
      return {
        outcome: 'passed', command: 'pnpm test', exitCode: 0, timedOut: false, durationMs: 1000, log: join(dir, 'gates', 'run.log'),
        excerpt: '', at: clock.now, head: options.head ?? heads.get(worktreePath) ?? null,
      }
    },
  })
  const projects = stub<ProjectsReader>({
    async get(name) {
      const found = [...registered].find(known => known.toLowerCase() === String(name).toLowerCase())
      return found === undefined ? undefined : projectOf(found)
    },
  })
  const agents: AgentsReader = { get: id => live.has(id) ? { id, status: 'idle' } : undefined }
  const crewService = { records: { lookup: crew.service.lookup } as unknown as CrewRecords, worktreeBindings: crew.service.worktreeBindings } satisfies CrewReader
  return { dir, state, data, clock, worktrees, heads, children, bindings, registered, live, worktree, workspaces, crew, gates, projects, agents, crewService }
}

/** The world's own parts and helpers, around a core `runs` (made by `make`). */
function assemble(base: Awaited<ReturnType<typeof parts>>, logs: string[], services: Services, absent: Set<ServiceName>, made: { runs: Runs, store: RunStore, ledger: Ledger }, restart: () => Promise<Runs>): World {
  const w: World = {
    dir: base.dir, state: base.state, data: base.data, clock: base.clock, logs,
    runs: made.runs, store: made.store, ledger: made.ledger, services, deps: { runs: made.runs, services }, absent,
    workspaces: base.workspaces, crew: base.crew, gates: base.gates, projects: base.projects, live: base.live,
    worktrees: base.worktrees, heads: base.heads, children: base.children, bindings: base.bindings, registered: base.registered,
    worktree: base.worktree,
    async created(slug, given = {}) {
      const project = given.project ?? PROJECT
      const path = await base.worktree(slug, { project })
      const found = base.worktrees.get(path)!
      return { project, slug, branch: found.branch, path, clone: found.clone, base: BASE, baseRef: given.baseRef ?? 'origin/main' }
    },
    async open(given = {}) {
      const session = given.session ?? SESSION
      const created = await w.created(given.slug ?? 'fix-login', given.project === undefined ? {} : { project: given.project })
      const options = { goal: given.goal ?? 'Fix the login redirect', how: given.how ?? 'run' as const, ...given.plan === undefined ? {} : { plan: given.plan } }
      const { run } = await w.runs.withSession(session, () => w.runs.openAround(session, created, options))
      return run
    },
    async entries(run) {
      return (await w.ledger.entries(run.project, run.id)).entries
    },
    async kinds(run) {
      return (await w.entries(run)).map(entry => entry.kind)
    },
    record(run) {
      return w.store.get(run.project, run.id)
    },
    restart,
  }
  return w
}

/** A world: see the module's header. The core is loaded. */
export async function world(options: WorldOptions = {}): Promise<World> {
  const base = await parts(options)
  const logs: string[] = []
  const absent = new Set<ServiceName>()
  const services: Services = {
    workspaces: () => absent.has('workspaces') ? undefined : base.workspaces.service,
    crew: () => absent.has('crew') ? undefined : base.crewService,
    gates: () => absent.has('gates') ? undefined : base.gates.service,
    projects: () => absent.has('projects') ? undefined : base.projects.service,
    agents: () => absent.has('agents') ? undefined : base.agents,
  }
  const make = () => {
    const store = new RunStore(base.state, { now: () => base.clock.now, onCorrupt: (file, aside, problem) => { logs.push(`warn: corrupt ${file} → ${aside}: ${problem ?? ''}`) } })
    const ledger = new Ledger(base.data)
    const runs = new Runs({ store, ledger, services, now: () => base.clock.now, logger: keeping(logs), ...options.limits === undefined ? {} : { limits: options.limits } })
    return { runs, store, ledger }
  }
  const w: World = assemble(base, logs, services, absent, make(), async () => {
    const made = make()
    await made.runs.ready()
    Object.assign(w, { runs: made.runs, store: made.store, ledger: made.ledger, deps: { runs: made.runs, services } })
    return made.runs
  })
  await w.runs.ready()
  return w
}

// --- a world in a cordis Context ------------------------------------------------------------------------------------

/** What `ctx.plugin` gives, as the tests use it. */
export interface Handle extends PromiseLike<unknown> {
  dispose(): Promise<void> | void
}

/** A plugin of its own that provides `value` as `name`: a sibling's service, as dsh's reach orchestrator. */
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

export interface PluginWorldOptions extends WorldOptions {
  /** The plugin's config. Default: `{ terminal: false }`. */
  config?: Partial<Config>
  /** Mount dsh's `ToolRuntime` (with a `systemPrompt` stub) before the plugin. */
  tools?: boolean
  /** Mount crew's real host plugin (its records under `<dir>/crew`) in place of the crew stub. */
  realCrew?: boolean
  /** Siblings not to provide at all. */
  without?: readonly ServiceName[]
}

export interface PluginWorld extends World {
  ctx: Context
  /** Every line any plugin logged. */
  pluginLogs: string[]
  /** The sibling plugins, the tools runtime and dish-orchestrator itself, to dispose one. */
  handles: Partial<Record<ServiceName | 'plugin' | 'tools' | 'systemPrompt', Handle>>
  /** crew's records directory, with `realCrew`. */
  crewData: string
  /** Dispose everything, the plugin first. */
  dispose(): Promise<void>
}

/**
 * The world's stubs provided in a new `Context` by sibling plugins, and dish-orchestrator mounted there (through `start`,
 * with the world's directories and clock): the world's `runs`, `store` and `ledger` are the plugin's, and `services` reads
 * the context. Waits until everything is mounted and the store is loaded. `restart` isn't supported here.
 */
export async function pluginWorld(options: PluginWorldOptions = {}): Promise<PluginWorld> {
  const plugin = await import('../src/index.ts')
  const base = await parts(options)
  const ctx = new Context()
  const pluginLogs = watchLogs(ctx)
  const without = new Set(options.without ?? [])
  const handles: PluginWorld['handles'] = {}
  const crewData = join(base.dir, 'crew')
  if (options.tools === true) {
    const { ToolRuntime } = await import('@deepseek-ai/dsh-tools')
    handles.systemPrompt = provideStub(ctx, 'systemPrompt', { tools() {}, section() {}, getSectionOrder: () => 1 })
    await handles.systemPrompt
    handles.tools = ctx.plugin(ToolRuntime, {}) as unknown as Handle
    await handles.tools
  }
  if (options.realCrew === true) {
    const crewPlugin = await import('dish-crew')
    handles.crew = ctx.plugin(crewPlugin, { terminal: false, dataDirectory: crewData, reportSteers: 0 } as never) as unknown as Handle
    await handles.crew
  } else if (!without.has('crew')) {
    handles.crew = provideStub(ctx, 'dishCrew', base.crewService)
  }
  if (!without.has('workspaces')) handles.workspaces = provideStub(ctx, 'dishWorkspaces', base.workspaces.service)
  if (!without.has('gates')) handles.gates = provideStub(ctx, 'dishGates', base.gates.service)
  if (!without.has('projects')) handles.projects = provideStub(ctx, 'dishProjects', base.projects.service)
  if (!without.has('agents')) handles.agents = provideStub(ctx, 'agents', base.agents)
  await Promise.all(Object.values(handles))
  let started: Runs | undefined
  handles.plugin = ctx.plugin({
    name: plugin.name,
    Config: plugin.Config,
    apply: (own: Context, config: Config) => { started = plugin.start(own, config, { state: base.state, data: base.data, now: () => base.clock.now }) },
  } as never, { terminal: false, ...options.config } as never) as unknown as Handle
  await handles.plugin
  if (started === undefined) throw new Error('dish-orchestrator didn\'t start')
  await started.ready()
  const services = (await import('../src/services.ts')).contextServices(ctx)
  const logs: string[] = []
  const w = assemble(base, logs, services, new Set(), { runs: started, store: started.store, ledger: started.ledger }, async () => {
    throw new Error('restart isn\'t supported in a plugin world')
  }) as PluginWorld
  w.ctx = ctx
  w.pluginLogs = pluginLogs
  w.handles = handles
  w.crewData = crewData
  w.dispose = async () => {
    for (const name of ['plugin', 'workspaces', 'gates', 'projects', 'agents', 'crew', 'tools', 'systemPrompt'] as const) await handles[name]?.dispose()
  }
  return w
}

// --- tool contexts -----------------------------------------------------------------------------------------------

/** A `ToolRunContext` for the main agent of chat `sessionId` (its `agent.id`), with `cwd` as its workspace (none for undefined). */
export function mainExec(sessionId: string, cwd?: string, options: { signal?: AbortSignal } = {}): ToolRunContext {
  const header = { id: sessionId, ...cwd === undefined ? {} : { cwd } }
  return {
    callId: 'call-1', rootCallId: 'call-1', name: 'tool', arguments: {}, token: 'token-1',
    agent: { id: sessionId, session: { header }, options: {} },
    signal: options.signal ?? new AbortController().signal,
    deferContext() {},
    concludeTurn() {},
  } as unknown as ToolRunContext
}

/** A `ToolRunContext` for a crew child (`delegationDepth: 1`, `origin: 'subagent'`). */
export function childExec(options: { id?: string, cwd?: string, signal?: AbortSignal } = {}): ToolRunContext {
  const id = options.id ?? 'child-1'
  const header = { id, delegationDepth: 1, origin: 'subagent', ...options.cwd === undefined ? {} : { cwd: options.cwd } }
  return {
    callId: 'call-1', rootCallId: 'call-1', name: 'tool', arguments: {}, token: 'token-1',
    agent: { id, session: { header }, options: {} },
    signal: options.signal ?? new AbortController().signal,
    deferContext() {},
    concludeTurn() {},
  } as unknown as ToolRunContext
}

// --- event payloads -----------------------------------------------------------------------------------------------

/** A crew child's record: a coder, with nothing run yet. */
export function childRecord(overrides: Partial<ChildRecord> = {}): ChildRecord {
  return {
    id: 'child-1', n: 1, role: 'coder', title: 'Fix it', model: 'deepseek-chat', family: 'deepseek', startedAt: NOW, followUps: 0, runs: [],
    last: 'running', ...overrides,
  }
}

/** `dish-crew/delegated`'s payload: a start (or, with `followUp`, a follow-up) of `child`. */
export function delegated(child: Partial<ChildRecord>, options: { sessionId?: string, followUp?: boolean } = {}): Delegated {
  return { sessionId: options.sessionId ?? SESSION, child: childRecord(child), followUp: options.followUp ?? false }
}

/** `dish-crew/settled`'s payload: `child`'s run filed, with `run`'s fields over a completed run with no structured report. */
export function settled(child: Partial<ChildRecord>, run: Partial<CrewRunRecord> = {}, options: { sessionId?: string } = {}): Settled {
  const record = childRecord(child)
  const filed: CrewRunRecord = { endedAt: NOW, stopReason: 'completed', report: `/crew/sessions/x/${record.n}-${record.role}-1.md`, ...run }
  return { sessionId: options.sessionId ?? SESSION, child: { ...record, runs: [...record.runs, filed], last: 'finished' }, run: filed }
}

/** `dish-gates/result`'s payload: a passed gate at HEAD, with `result`'s fields over it. */
export function gateDone(childId: string, result: Partial<GateResult> = {}, options: { sessionId?: string } = {}): GateFinished {
  return {
    childId,
    sessionId: options.sessionId ?? SESSION,
    result: {
      turn: 1, round: 1, maxRounds: 3, outcome: 'passed', command: 'pnpm test', exitCode: 0, timedOut: false, durationMs: 1200,
      log: '/state/gates/acme/widget/fix-login/child-1-1-1.log', excerpt: '', at: NOW, head: HEAD, ...result,
    },
  }
}

/** Run `body` with `vars` set (an `undefined` value unsets the name), DSH_DISH_HOME always cleared unless `vars` sets it, and every name put back after. */
export async function withEnv<T>(vars: Record<string, string | undefined>, body: () => Promise<T>): Promise<T> {
  const names = [...new Set([...Object.keys(vars), 'DSH_DISH_HOME'])]
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]))
  delete process.env.DSH_DISH_HOME
  for (const [name, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  try {
    return await body()
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

/** Poll `check` until it holds, for at most `ms`. */
export async function waitFor(what: string, check: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const end = Date.now() + ms
  while (!await check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise(settle => setTimeout(settle, 10))
  }
}

/** A promise and the function that settles it. */
export function deferred<T = void>(): { promise: Promise<T>, resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}
