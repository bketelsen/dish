/**
 * The plugin, in a `Context` with dish-crew's real host plugin (its records in a temp directory) and sibling plugins
 * providing stubs of `dishWorkspaces`, `dishProjects` and dsh's `shell` (a fake shell that sandboxes). Most tests drive
 * dsh's two events by hand, with a fake agent: `session/event` for the closing message and `agent/turn-stopping`.
 *
 * A few tests run a **real crew child** instead, through dsh's own agent loop (`dsh-agent-loop`), its spawn backend
 * (`dsh-subagent`, `dsh-subagent-spawn-in-process`) and a scripted model, with crew's host listeners recording the child
 * as they do in dsh. They pin what dish-gates relies on and the other tests only assume: that a child's
 * `agent/turn-stopping` and `session/event` reach a host plugin's listeners, that the closing message comes before the
 * stop, that a steer from the stop continues the child's turn, and that the gate's results reach crew's record before
 * that run's `subagent/end` files it. dsh's packages come from the workspace root's `@deepseek-ai/dsh` (dsh-base's
 * dependencies), the dsh this repo runs: dish-gates doesn't declare them.
 *
 * Nothing here runs a process: the shell is fake. Logs go under the test's temp directory, or under a scratch
 * `DSH_DISH_HOME`.
 *
 * @module dish-gates/test/plugin
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { chmod, mkdir, readFile, stat, utimes, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { mock, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { format } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { ShellExecRequest, ShellExecSpec, ShellExecution, ShellRunResult } from '@deepseek-ai/dsh-shell'
import * as crewPlugin from 'dish-crew'
import { maskSecrets } from 'dish-kit'
import type { ChildRecord, CrewRecords, DishCrew } from 'dish-crew'
import type { Project } from 'dish-projects'
import type { Worktree } from 'dish-workspaces'
import * as gates from '../src/index.ts'
import type { Config, GatesInternals } from '../src/index.ts'
import { LOG_KEEP_MS } from '../src/logs.ts'
import type { ShellLike } from '../src/run.ts'
import { BLOCKED_REASON } from '../src/text.ts'
import { tempDir, withEnv } from './helpers.ts'

const SESSION = 'main-1'
const TOKEN = `ghs_${'A1b2C3d4E5'.repeat(4)}`
const CLONE = '/w/acme/widget'
const FIX1 = `${CLONE}/.worktrees/fix-1`

const PROJECT: Project = {
  name: 'acme/widget', owner: 'acme', repo: 'widget', family: 'anthropic', role: 'coder',
  gate: 'pnpm test', gateTimeout: '5m', gateTimeoutMs: 300_000,
  setup: undefined, setupTimeout: '15m', setupTimeoutMs: 900_000, gateEnv: {},
}

function worktreeOf(path: string): Worktree {
  const slug = path.slice(path.lastIndexOf('/') + 1)
  return { project: 'acme/widget', slug, branch: `dish/${slug}`, path, clone: CLONE, base: 'abc123' }
}

// --- small helpers ------------------------------------------------------------------------------------------------

/** Poll `check` until it holds, for at most `ms`. */
async function waitFor(what: string, check: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const end = Date.now() + ms
  while (!await check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise(settle => setTimeout(settle, 10))
  }
}

function deferred<T = void>(): { promise: Promise<T>, resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

function textOf(message: UserMessage): string {
  return message.content.map(block => block.type === 'text' ? block.text : '').join('')
}

/** A plugin of its own that provides `value` as `name`: a sibling's service, as dsh's reach dish-gates. */
function provideStub(ctx: Context, name: string, value: unknown) {
  return ctx.plugin({
    name: `stub-${name}`,
    apply(own: Context) { (own as unknown as { provide(name: string, value: unknown): void }).provide(name, value) },
  } as never, undefined as never)
}

/** Every warning and info line any plugin logs in `ctx`, as `[name] type: text`. */
function watchLogs(ctx: Context): string[] {
  const seen: string[] = []
  ctx.logger.exporter({
    levels: { default: 3 },
    export: ({ name, type, args }) => { seen.push(`[${name}] ${type}: ${format(...args)}`) },
  })
  return seen
}

/** What stderr was written while it was captured. */
function captureStderr(): { text: () => string, restore: () => void } {
  const original = process.stderr.write
  const chunks: string[] = []
  process.stderr.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk))
    return true
  }) as typeof process.stderr.write
  return { text: () => chunks.join(''), restore: () => { process.stderr.write = original } }
}

/** The file crew keeps a session's children in. */
function childrenFile(crewData: string, sessionId: string): string {
  return join(crewData, 'sessions', createHash('sha256').update(sessionId).digest('hex'), 'children.json')
}

// --- the fake shell -----------------------------------------------------------------------------------------------

/** What one gate run gives: an exit and its output, or a run that ends when its signal aborts. */
type Outcome = { exitCode: number | null, stdout: string } | ((spec: ShellExecSpec) => Promise<Partial<ShellRunResult>>)

const PASS: Outcome = { exitCode: 0, stdout: 'ok 1 - adds\n' }
const FAIL: Outcome = { exitCode: 1, stdout: 'not ok 1 - adds\n# fail 1\n' }

interface FakeShell extends ShellLike {
  /** Every request, in order. */
  requests: ShellExecRequest[]
  /** What the next runs give, in order; with none left, a run passes. */
  script: Outcome[]
}

function fakeShell(): FakeShell {
  const requests: ShellExecRequest[] = []
  const script: Outcome[] = []
  return {
    requests,
    script,
    sandboxMode: 'workspace-write',
    resolve(request: ShellExecRequest): ShellExecSpec {
      requests.push(request)
      return {
        command: request.command,
        workdir: request.workdir ?? '/nowhere',
        timeoutMs: request.timeoutMs ?? 120_000,
        onExpiry: request.onExpiry ?? 'kill',
        stdoutMaxBytes: request.stdoutMaxBytes ?? 64_000,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        ...(request.env === undefined ? {} : { env: request.env }),
        sandboxPolicy: request.sandboxPolicy,
      }
    },
    async execute(spec: ShellExecSpec): Promise<ShellExecution> {
      const next = script.shift() ?? PASS
      const result = async (): Promise<ShellRunResult> => {
        const given: Partial<ShellRunResult> = typeof next === 'function'
          ? await next(spec)
          : { exitCode: next.exitCode, stdout: { text: next.stdout, truncated: false } }
        return {
          exitCode: null, signal: null, timedOut: false, aborted: false, timeoutMs: spec.timeoutMs,
          stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false },
          sandbox: { mode: 'workspace-write', denied: false, enforcement: 'full' },
          ...given,
        } as ShellRunResult
      }
      return { result } as unknown as ShellExecution
    },
  }
}

// --- a world: crew's host plugin, stubs, and dish-gates -----------------------------------------------------------

interface FakeAgent {
  id: string
  session: { header: { delegationDepth?: number, origin?: string } }
  options: object
  steers: UserMessage[]
  steer(message: UserMessage): void
}

type Handle = { dispose(): unknown } & PromiseLike<unknown>

interface World {
  ctx: Context
  dir: string
  crewData: string
  state: string
  shell: FakeShell
  /** What `dishProjects.get('acme/widget')` gives; change it to change projects.yaml. */
  project: { current: Project | undefined }
  handles: { crew?: Handle, gates: Handle, workspaces: Handle, projects: Handle, shell: Handle }
  logs: string[]
  records(): CrewRecords
  /** A crew child of `SESSION`, bound to FIX1. */
  coder(id: string): Promise<void>
  agent(id: string): FakeAgent
  /** dsh's `agent/turn-stopping` for `agent`, awaited as dsh awaits it. */
  stop(agent: FakeAgent, turn?: number, signal?: AbortSignal): Promise<void>
  /** dsh's `session/event` for an assistant message with `text`, in `agent`'s session. */
  says(agent: FakeAgent, text: string): void
  child(id: string): Promise<ChildRecord>
  dispose(): Promise<void>
}

interface WorldOptions {
  /** Mount dish-crew's host plugin (default true). */
  crew?: boolean
  config?: Partial<Config>
  /** Internals for `start`; `null` mounts the plugin as dsh does, through `apply`, with no internals. */
  internals?: GatesInternals | null
  /** Mount on this context (dsh's stack) instead of a fresh one. */
  ctx?: Context
}

/** Mount dish-gates on `ctx`: through `apply` when `internals` is null, else through `start` with them. */
function mountGates(ctx: Context, config: Partial<Config>, internals: GatesInternals | null): Handle {
  const plugin = internals === null
    ? gates
    : { name: gates.name, Config: gates.Config, apply: (own: Context, given: Config) => gates.start(own, given, internals) }
  return ctx.plugin(plugin as never, { terminal: false, ...config } as never) as unknown as Handle
}

async function world(options: WorldOptions = {}): Promise<World> {
  const dir = await tempDir()
  const crewData = join(dir, 'crew')
  const state = options.internals?.state ?? join(dir, 'state')
  const ctx = options.ctx ?? new Context()
  const logs = watchLogs(ctx)
  const shell = fakeShell()
  const project = { current: PROJECT as Project | undefined }
  const crew = options.crew === false
    ? undefined
    : ctx.plugin(crewPlugin, { terminal: false, dataDirectory: crewData, reportSteers: 0 } as crewPlugin.Config) as unknown as Handle
  if (crew !== undefined) await crew
  const workspaces = provideStub(ctx, 'dishWorkspaces', {
    resolve: async (path: string) => path === FIX1 ? worktreeOf(path) : undefined,
    resolveProblem: async () => undefined,
  }) as unknown as Handle
  const projects = provideStub(ctx, 'dishProjects', {
    get: async (name: string) => name === 'acme/widget' ? project.current : undefined,
  }) as unknown as Handle
  const shellHandle = provideStub(ctx, 'shell', shell) as unknown as Handle
  // dsh's environment for the gate's PATH: a scratch home with no mise shims, never the runner's.
  const internals = options.internals === undefined ? { state, environment: () => ({ PATH: '/usr/bin:/bin', HOME: join(dir, 'home') }) } : options.internals
  const gatesHandle = mountGates(ctx, options.config ?? {}, internals)
  await Promise.all([workspaces, projects, shellHandle, gatesHandle])
  const handles = { ...crew === undefined ? {} : { crew }, gates: gatesHandle, workspaces, projects, shell: shellHandle }
  const w: World = {
    ctx, dir, crewData, state, shell, project, handles, logs,
    records: () => (ctx.get('dishCrew') as DishCrew).records,
    async coder(id) {
      await w.records().addChild(SESSION, { id, role: 'coder', title: `task of ${id}`, model: 'claude-fake', family: 'anthropic', worktree: FIX1 })
    },
    agent(id) {
      const steers: UserMessage[] = []
      return { id, session: { header: { delegationDepth: 1, origin: 'subagent' } }, options: {}, steers, steer(message) { steers.push(message) } }
    },
    async stop(agent, turn = 1, signal = new AbortController().signal) {
      await (ctx as unknown as { serial(name: string, payload: unknown): Promise<void> }).serial('agent/turn-stopping', { agent, turn, signal })
    },
    says(agent, text) {
      const event = { type: 'assistant/message', seq: 1, time: 0, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } } }
      ;(ctx as unknown as { emit(name: string, ...args: unknown[]): void }).emit('session/event', agent.session, event)
    },
    async child(id) {
      const found = await w.records().lookup(id)
      assert.ok(found, `crew has no child ${id}`)
      return found.record
    },
    async dispose() {
      for (const handle of [gatesHandle, shellHandle, projects, workspaces, ...crew === undefined ? [] : [crew]]) await handle.dispose()
    },
  }
  return w
}

// --- the service and the config -----------------------------------------------------------------------------------

test('dishGates is there while the plugin runs, and goes with it', async () => {
  const w = await world()
  try {
    assert.equal(typeof w.ctx.get('dishGates')?.gateFor, 'function')
    await w.handles.gates.dispose()
    assert.equal(w.ctx.get('dishGates'), undefined)
  } finally {
    await w.dispose()
  }
})

test('the config: maxRounds 3 (at least 1), tailLines 200 (at least 10), terminal on', () => {
  const config = (given: object): Config => gates.Config(given as Config)
  assert.deepEqual(config({}), { maxRounds: 3, tailLines: 200, terminal: true })
  assert.deepEqual(config({ maxRounds: 1, tailLines: 10, terminal: false }), { maxRounds: 1, tailLines: 10, terminal: false })
  assert.throws(() => config({ maxRounds: 0 }))
  assert.throws(() => config({ tailLines: 9 }))
  assert.throws(() => config({ maxRounds: 1.5 }))
})

test('gateFor gives projects.yaml\'s gate as it is now; none for a project that isn\'t there, or without dish-projects', async () => {
  const w = await world()
  try {
    const service = w.ctx.get('dishGates')!
    assert.equal(await service.gateFor('acme/widget'), 'pnpm test')
    w.project.current = { ...PROJECT, gate: 'make check' }
    assert.equal(await service.gateFor('acme/widget'), 'make check')
    assert.equal(await service.gateFor('acme/other'), undefined)
    // A credential in it is masked: the gate is shown to agents (the coder's brief), never run from here.
    w.project.current = { ...PROJECT, gate: `GH_TOKEN=${TOKEN} make check` }
    assert.equal(await service.gateFor('acme/widget'), `GH_TOKEN=${maskSecrets(TOKEN)} make check`)
    await w.handles.projects.dispose()
    assert.equal(await service.gateFor('acme/widget'), undefined)
  } finally {
    await w.dispose()
  }
})

// --- the listeners, with a fake agent -----------------------------------------------------------------------------

test('the opt-out: a closing message heard on session/event that starts BLOCKED: is skipped, and the shell isn\'t asked', async () => {
  const w = await world()
  try {
    await w.coder('child-1')
    const agent = w.agent('child-1')
    w.says(agent, 'BLOCKED: which file?')
    await w.stop(agent)
    const record = await w.child('child-1')
    assert.deepEqual(record.gates?.map(result => [result.outcome, result.round, result.reason]), [['skipped', 1, BLOCKED_REASON]])
    assert.equal(w.shell.requests.length, 0)
    assert.equal(agent.steers.length, 0)
  } finally {
    await w.dispose()
  }
})

test('the record\'s order: a failure (steered) and a pass in one turn, then subagent/end at once: the run holds both', async () => {
  const w = await world()
  try {
    await w.coder('child-1')
    const agent = w.agent('child-1')
    w.shell.script.push(FAIL, PASS)
    w.says(agent, 'done')
    await w.stop(agent)
    assert.equal(agent.steers.length, 1)
    assert.match(textOf(agent.steers[0]!), /^The gate failed \(round 1 of 3\): `pnpm test` exited 1/)
    w.says(agent, 'fixed')
    await w.stop(agent)
    assert.equal(agent.steers.length, 1)
    // As dsh does: the turn closes once turn-stopping is done, and subagent/end follows.
    ;(w.ctx as unknown as { emit(name: string, ...args: unknown[]): void }).emit('subagent/end', {
      id: 'child-1', stopReason: 'completed', lastAssistantMessage: { role: 'assistant', content: [{ type: 'text', text: 'fixed' }] },
    })
    await (w.ctx.get('dishCrew') as DishCrew).whenRecorded('child-1')
    const file = JSON.parse(await readFile(childrenFile(w.crewData, SESSION), 'utf8')) as { children: ChildRecord[] }
    const child = file.children.find(one => one.id === 'child-1')!
    assert.equal(child.runs.length, 1)
    assert.deepEqual(child.runs[0]!.gates?.map(result => [result.outcome, result.round, result.turn, result.command, result.exitCode]), [
      ['failed', 1, 1, 'pnpm test', 1],
      ['passed', 2, 1, 'pnpm test', 0],
    ])
    assert.equal(child.gates, undefined)
    assert.equal(child.last, 'finished')
    // Each run's log, under the state directory.
    for (const [round, result] of child.runs[0]!.gates!.entries()) {
      assert.equal(result.log, join(w.state, 'gates', 'acme', 'widget', 'fix-1', `child-1-1-${round + 1}.log`))
      assert.equal((await stat(result.log!)).mode & 0o777, 0o600)
    }
  } finally {
    await w.dispose()
  }
})

test('dispose mid-gate: the shell sees its signal aborted, nothing is recorded, nothing steered, and the stop settles', async () => {
  const w = await world()
  try {
    await w.coder('child-1')
    const agent = w.agent('child-1')
    const started = deferred<AbortSignal>()
    w.shell.script.push(spec => new Promise((settle) => {
      const signal = spec.signal!
      started.resolve(signal)
      signal.addEventListener('abort', () => { settle({ aborted: true, exitCode: null, signal: 'SIGKILL' }) }, { once: true })
    }))
    const stopping = w.stop(agent)
    const signal = await started.promise
    assert.equal(signal.aborted, false)
    await w.handles.gates.dispose()
    assert.equal(signal.aborted, true)
    await stopping
    assert.deepEqual((await w.child('child-1')).gates ?? [], [])
    assert.equal(agent.steers.length, 0)
  } finally {
    await w.dispose()
  }
})

test('a turn that is aborted mid-gate records nothing, and the plugin goes on for the next stop', async () => {
  const w = await world()
  try {
    await w.coder('child-1')
    const agent = w.agent('child-1')
    const turn = new AbortController()
    w.shell.script.push(spec => new Promise((settle) => {
      spec.signal!.addEventListener('abort', () => { settle({ aborted: true, exitCode: null }) }, { once: true })
      turn.abort()
    }))
    await w.stop(agent, 1, turn.signal)
    assert.deepEqual((await w.child('child-1')).gates ?? [], [])
    await w.stop(agent, 2)
    assert.deepEqual((await w.child('child-1')).gates?.map(result => [result.outcome, result.turn]), [['passed', 2]])
  } finally {
    await w.dispose()
  }
})

test('without dish-crew nothing happens: no record to read, the shell isn\'t asked, and the stop settles', async () => {
  const w = await world({ crew: false })
  try {
    const agent = w.agent('child-1')
    w.says(agent, 'done')
    await w.stop(agent)
    assert.equal(w.shell.requests.length, 0)
    assert.equal(agent.steers.length, 0)
    assert.deepEqual(w.logs.filter(line => line.startsWith('[dish-gates]')), [])
  } finally {
    await w.dispose()
  }
})

test('terminal: false prints nothing; terminal: true prints the plugin\'s own lines', async () => {
  for (const terminal of [false, true]) {
    const captured = captureStderr()
    let printed: string
    try {
      const w = await world({ config: { terminal } })
      try {
        await w.coder('child-1')
        await w.stop(w.agent('child-1'))
      } finally {
        await w.dispose()
      }
    } finally {
      captured.restore()
      printed = captured.text()
    }
    const lines = printed.split('\n').filter(line => line.startsWith('[dish-gates]'))
    if (terminal) assert.match(lines.join('\n'), /^\[dish-gates\] child child-1, round 1, \/w\/acme\/widget\/\.worktrees\/fix-1: passed in /m)
    else assert.deepEqual(lines, [])
  }
})

// --- logs and their pruning ---------------------------------------------------------------------------------------

/** Write a `.log` under `<state>/gates` whose time is `ageMs` ago; gives its path. */
async function oldLog(state: string, slug: string, ageMs = LOG_KEEP_MS + 86_400_000): Promise<string> {
  const directory = join(state, 'gates', 'acme', 'widget', slug)
  await mkdir(directory, { recursive: true })
  const file = join(directory, 'child-0-1-1.log')
  await writeFile(file, '# gate: old\n')
  const then = (Date.now() - ageMs) / 1000
  await utimes(file, then, then)
  return file
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false)
}

test('the defaults: with DSH_DISH_HOME, logs go under <it>/state/dish/gates, and an old log there is pruned at start', async () => {
  const dir = await tempDir()
  const instance = join(dir, 'inst')
  const state = join(instance, 'state', 'dish')
  const old = await oldLog(state, 'gone-1')
  const kept = await oldLog(state, 'fresh-1', 1000)
  await withEnv({ DSH_DISH_HOME: instance }, async () => {
    const w = await world({ internals: null })
    try {
      await waitFor('the old log to be pruned', async () => !await exists(old))
      assert.equal(await exists(dirname(old)), false)
      assert.equal(await exists(kept), true)
      await w.coder('child-1')
      w.shell.script.push(FAIL)
      await w.stop(w.agent('child-1'))
      const [result] = (await w.child('child-1')).gates!
      assert.equal(result!.log, join(state, 'gates', 'acme', 'widget', 'fix-1', 'child-1-1-1.log'))
      assert.match(await readFile(result!.log!, 'utf8'), /^# gate: pnpm test\n/)
      assert.equal(result!.maxRounds, 3)
    } finally {
      await w.dispose()
    }
  })
})

test('pruning runs again every day while the plugin runs, and stops with it', async () => {
  mock.timers.enable({ apis: ['setInterval'] })
  try {
    const state = join(await tempDir(), 'state')
    const atStart = await oldLog(state, 'day-0')
    const w = await world({ crew: false, internals: { state } })
    try {
      await waitFor('the pruning at start', async () => !await exists(atStart))
      const first = await oldLog(w.state, 'day-1')
      mock.timers.tick(gates.PRUNE_EVERY_MS - 1)
      await new Promise(settle => setTimeout(settle, 50))
      assert.equal(await exists(first), true)
      mock.timers.tick(1)
      await waitFor('the daily pruning', async () => !await exists(first))
      await w.handles.gates.dispose()
      const second = await oldLog(w.state, 'day-2')
      mock.timers.tick(gates.PRUNE_EVERY_MS * 2)
      await new Promise(settle => setTimeout(settle, 50))
      assert.equal(await exists(second), true)
    } finally {
      await w.dispose()
    }
  } finally {
    mock.timers.reset()
  }
})

test('a pruning that fails is logged once, and the gate still runs', { skip: process.getuid?.() === 0 ? 'root reads a directory of mode 000' : false }, async () => {
  const dir = await tempDir()
  const gatesDir = join(dir, 'state', 'gates')
  try {
    // Inside the try, so a setup that throws still has the timers reset below.
    mock.timers.enable({ apis: ['setInterval'] })
    await mkdir(join(gatesDir, 'acme'), { recursive: true })
    await chmod(gatesDir, 0o000)
    const w = await world({ internals: { state: join(dir, 'state') } })
    try {
      const failed = (): string[] => w.logs.filter(line => /^\[dish-gates\] warn: .*prune/.test(line))
      await waitFor('the pruning to fail', () => failed().length === 1)
      mock.timers.tick(gates.PRUNE_EVERY_MS)
      await new Promise(settle => setTimeout(settle, 50))
      assert.equal(failed().length, 1)
      await chmod(gatesDir, 0o700)
      await w.coder('child-1')
      await w.stop(w.agent('child-1'))
      assert.deepEqual((await w.child('child-1')).gates?.map(result => result.outcome), ['passed'])
    } finally {
      await w.dispose()
    }
  } finally {
    mock.timers.reset()
    await chmod(gatesDir, 0o700).catch(() => undefined)
  }
})

// --- a real crew child, through dsh's own agent loop --------------------------------------------------------------

/** Resolves dsh's packages as the dsh this repo runs has them: the workspace root's `@deepseek-ai/dsh`, then dsh-base. */
const fromDsh = (() => {
  const root = fileURLToPath(new URL('../../../', import.meta.url))
  const dsh = realpathSync(join(root, 'node_modules', '@deepseek-ai', 'dsh'))
  const base = dirname(createRequire(join(dsh, 'package.json')).resolve('@deepseek-ai/dsh-base/package.json'))
  return createRequire(join(base, 'package.json'))
})()

async function dshModule(name: string): Promise<any> {
  return import(pathToFileURL(fromDsh.resolve(name)).href)
}

/**
 * What the coder's model answers in one step: text, tool calls (by name, with `{}` for arguments), and whether the answer
 * is cut at `max-tokens`. A string is text alone.
 */
type CoderReply = string | { text?: string, calls?: string[], cut?: boolean }

/** What the coder's model answers to a request, given every earlier request's text and this one's. */
type CoderScript = (request: string, count: number) => CoderReply

interface DshWorld {
  ctx: Context
  main: Agent
  /** The text of every request the coder's model got, in order. */
  coderRequests: string[]
  /** How many requests the main agent's model got. */
  mainRequests: () => number
  /** Record `childId` as crew's `delegate` does (bound to FIX1), then start it with dsh's spawn backend. */
  delegate(childId: string, task: string): Promise<void>
}

/**
 * dsh's agent stack in a fresh `Context`, as dsh-base mounts it, with a model `fake` that answers from a script: the main
 * agent (`fake-main`) always says "ok", the coder (`fake-coder`) as `coder` says. Session logs go to a temp directory, and
 * the process environment's dsh and XDG directories are scratch while it runs.
 */
async function withDsh(coder: CoderScript, body: (dsh: DshWorld) => Promise<void>): Promise<void> {
  const dir = await tempDir()
  const home = join(dir, 'home')
  await withEnv({
    DSH_HOME: join(dir, 'dsh-home'), XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'), XDG_CACHE_HOME: join(home, '.cache'),
  }, async () => {
    const [llm, session, projection, agent, systemPrompt, tools, loop, subagent, spawn, persistence] = await Promise.all([
      'dsh-llm', 'dsh-session', 'dsh-session-projection', 'dsh-agent', 'dsh-system-prompt', 'dsh-tools', 'dsh-agent-loop',
      'dsh-subagent', 'dsh-subagent-spawn-in-process', 'dsh-session-persistence-jsonl',
    ].map(name => dshModule(`@deepseek-ai/${name}`)))
    const coderRequests: string[] = []
    let mainRequests = 0
    class Scripted extends llm.LlmAdapter {
      providerInfo(provider: string) { return { id: provider, name: provider } }
      async *stream(options: { model: string, messages: unknown }) {
        const request = JSON.stringify(options.messages)
        let reply: CoderReply = 'ok'
        if (options.model === 'fake-coder') {
          coderRequests.push(request)
          reply = coder(request, coderRequests.length)
        } else {
          mainRequests++
        }
        const { text, calls = [], cut = false } = typeof reply === 'string' ? { text: reply } : reply
        let index = 0
        if (text !== undefined) {
          yield { type: 'block-start', index, blockType: 'text' }
          yield { type: 'text-delta', index, text }
          yield { type: 'block-end', index, block: { type: 'text', text } }
          index++
        }
        for (const name of calls) {
          const id = `call-${coderRequests.length}-${index}`
          yield { type: 'block-start', index, blockType: 'tool-call' }
          yield { type: 'tool-call-delta', index, id, name, argumentsDelta: '{}' }
          yield { type: 'block-end', index, block: { type: 'tool-call', id, name, arguments: '{}' } }
          index++
        }
        yield { type: 'finish', reason: { kind: cut ? 'max-tokens' : calls.length > 0 ? 'tool-calls' : 'stop' } }
      }
    }
    const ctx = new Context()
    const fibers: Handle[] = [
      ctx.plugin(llm.default),
      ctx.plugin(session.default),
      ctx.plugin(projection.default),
      ctx.plugin(agent.default),
      ctx.plugin(systemPrompt.default, { personaPrefix: '' }),
      ctx.plugin(tools.default),
      ctx.plugin(loop.default, { agents: [] }),
      ctx.plugin(subagent.default),
      ctx.plugin(spawn, { providerName: 'spawn' }),
      ctx.plugin(persistence.default, { root: join(dir, 'sessions') }),
      ctx.plugin({ name: 'scripted-model', inject: ['llm'], apply(own: any) { own.llm.registerAdapter(['fake'], new Scripted()) } } as never, undefined as never),
    ] as unknown as Handle[]
    let main: { agent: Agent, dispose(): Promise<void> } | undefined
    try {
      await Promise.all(fibers)
      const services = ctx as unknown as Record<string, any>
      await waitFor('dsh\'s agent stack', () => ['agentLoop', 'subagents', 'sessionPersistence'].every(name => ctx.get(name as never) !== undefined))
      main = await services.agents.create({ sessionId: SESSION, agentOptions: { provider: 'fake', model: 'fake-main' } })
      const parent = main!.agent
      await body({
        ctx,
        main: parent,
        coderRequests,
        mainRequests: () => mainRequests,
        async delegate(childId, task) {
          const crew = ctx.get('dishCrew')!
          await crew.records.addChild(SESSION, { id: childId, role: 'coder', title: task, model: 'fake-coder', family: 'anthropic', worktree: FIX1 })
          await services.subagents.startContinuable({
            provider: 'spawn', label: `coder · fake-coder · ${task}`, childId,
            request: { prompt: [{ type: 'text', text: task }], parent, agentOptions: { provider: 'fake', model: 'fake-coder' }, maxDepth: 1 },
            signal: new AbortController().signal,
          })
        },
      })
    } finally {
      await main?.dispose()
      for (const fiber of [...fibers].reverse()) await fiber.dispose()
    }
  })
}

/** Wait until crew has filed `count` runs of `childId` and the main agent has answered the last notice. */
async function settled(w: World, dsh: DshWorld, childId: string, count = 1): Promise<ChildRecord> {
  let record: ChildRecord | undefined
  await waitFor(`run ${count} of ${childId} to be filed`, async () => {
    record = (await w.records().lookup(childId))?.record
    return record !== undefined && record.runs.length >= count && record.last !== 'running'
  })
  await waitFor('the main agent to answer the notice', () => dsh.mainRequests() >= count && (dsh.main as unknown as { status: string }).status === 'idle')
  return record!
}

const GATE_FAILED = 'The gate failed (round 1 of 3)'

test('a real crew child, through dsh\'s agent loop: its gate fails, the steer reaches it, it fixes, and crew files both results', async () => {
  await withDsh((request) => request.includes(GATE_FAILED) ? 'fixed' : 'done', async (dsh) => {
    const w = await world({ ctx: dsh.ctx })
    try {
      w.shell.script.push(FAIL, PASS)
      await dsh.delegate('child-1', 'create ok.txt')
      const record = await settled(w, dsh, 'child-1')
      // The coder's second request holds the gate's message: the steer continued its turn.
      assert.equal(dsh.coderRequests.length, 2)
      assert.equal(dsh.coderRequests[0]!.includes(GATE_FAILED), false)
      assert.ok(dsh.coderRequests[1]!.includes(GATE_FAILED))
      assert.ok(dsh.coderRequests[1]!.includes('not ok 1 - adds'))
      // Both results are on the run crew filed at subagent/end, in order, and none is left on the child.
      assert.equal(record.runs.length, 1)
      assert.deepEqual(record.runs[0]!.gates?.map(result => [result.outcome, result.round, result.turn]), [['failed', 1, 1], ['passed', 2, 1]])
      assert.equal(record.gates, undefined)
      assert.equal(record.runs[0]!.stopReason, 'completed')
      // The gate ran in the coder's worktree, for the coder's session; the main agent's own turn isn't gated.
      assert.equal(w.shell.requests.length, 2)
      for (const request of w.shell.requests) {
        assert.equal(request.workdir, FIX1)
        assert.deepEqual(request.sandboxPolicy, { mode: 'workspace-write', workspaceRoot: CLONE, sessionId: 'child-1' })
      }
    } finally {
      await w.dispose()
    }
  })
})

test('a real crew child that closes with BLOCKED: its own session\'s message is heard, and the gate is skipped', async () => {
  await withDsh(() => '**BLOCKED:** which file should this go in?', async (dsh) => {
    const w = await world({ ctx: dsh.ctx })
    try {
      await dsh.delegate('child-2', 'create ok.txt')
      const record = await settled(w, dsh, 'child-2')
      assert.equal(dsh.coderRequests.length, 1)
      assert.deepEqual(record.runs[0]!.gates?.map(result => [result.outcome, result.reason]), [['skipped', BLOCKED_REASON]])
      assert.equal(w.shell.requests.length, 0)
    } finally {
      await w.dispose()
    }
  })
})

test('a real crew child cut at max-tokens: its stop is gated once, the tool-call steps after it aren\'t, and the step that finishes is', async () => {
  // dsh keeps a turn's end as max-tokens once a step is cut, so agent/turn-stopping fires after every later step of the turn.
  const steps: CoderReply[] = [
    // The cut step: dsh drops its tool call, so the message holds text alone, and the stop is gated (and fails).
    { text: 'Half of the work', calls: ['no_such_tool'], cut: true },
    // Two steps that call tools, each followed by a stop: the coder hasn't finished, and they aren't gated.
    { calls: ['no_such_tool'] },
    { text: 'Still going.', calls: ['no_such_tool'] },
    'Done.',
  ]
  await withDsh((_, count) => steps[count - 1] ?? 'Done.', async (dsh) => {
    const w = await world({ ctx: dsh.ctx })
    // A steer after each tool-call step, as a message sent to the running child would be: without one, dsh would end the
    // turn there, as the turn's end is already max-tokens.
    let nudges = 0
    const nudge = dsh.ctx.plugin({
      name: 'nudge',
      apply(own: Context) {
        own.on('agent/turn-stopping' as never, ((payload: { agent: Agent }) => {
          if (String(payload.agent.id) !== 'child-3' || dsh.coderRequests.length < 2 || dsh.coderRequests.length > 3) return
          nudges++
          payload.agent.steer(createUserMessage({ content: [{ type: 'text', text: 'keep going' }], source: { kind: 'user' } }))
        }) as never)
      },
    } as never, undefined as never) as unknown as Handle
    try {
      await nudge
      w.shell.script.push(FAIL, PASS)
      await dsh.delegate('child-3', 'create ok.txt')
      const record = await settled(w, dsh, 'child-3')
      assert.equal(dsh.coderRequests.length, 4)
      assert.equal(nudges, 2)
      assert.ok(dsh.coderRequests[1]!.includes(GATE_FAILED), 'the cut stop was gated, and its failure steered')
      // Two gate runs: the cut stop's, and the finishing step's; none after the tool-call steps.
      assert.equal(w.shell.requests.length, 2)
      assert.deepEqual(record.runs[0]!.gates?.map(result => [result.outcome, result.round, result.turn]), [['failed', 1, 1], ['passed', 2, 1]])
    } finally {
      await nudge.dispose()
      await w.dispose()
    }
  })
})

test('a real crew child whose gate holds a credential: crew files it masked, which its notice shows; the gate ran as it is', async () => {
  await withDsh(() => 'done', async (dsh) => {
    const w = await world({ ctx: dsh.ctx, config: { maxRounds: 1 } })
    try {
      const gate = `GH_TOKEN=${TOKEN} pnpm test`
      const shown = `GH_TOKEN=${maskSecrets(TOKEN)} pnpm test`
      w.project.current = { ...PROJECT, gate }
      w.shell.script.push(FAIL)
      await dsh.delegate('child-4', 'create ok.txt')
      const record = await settled(w, dsh, 'child-4')
      assert.equal(w.shell.requests.length, 1)
      assert.equal(w.shell.requests[0]!.command, `exec 2>&1\n${gate}`)
      // What crew's finish notice reads for its gate line (crew's notice tests show it masks it again).
      assert.deepEqual(record.runs[0]!.gates?.map(result => [result.outcome, result.command]), [['failed', shown]])
      assert.ok(!JSON.stringify(record).includes(TOKEN))
      assert.ok(!dsh.coderRequests.some(text => text.includes(TOKEN)))
    } finally {
      await w.dispose()
    }
  })
})
