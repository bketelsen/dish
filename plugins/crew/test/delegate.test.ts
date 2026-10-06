import { mkdir, realpath, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import { ToolRuntime, assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ContinuableStartSpec } from '@deepseek-ai/dsh-subagent'
import { maskSecrets, RETURN_NOTE_LEAD } from 'dish-kit'
import * as promptsPlugin from 'dish-prompts'
import * as row from '../src/delegate.ts'
import type { CrewDelegated, CrewSettled } from '../src/events.ts'
import { CrewRecords, isRunning } from '../src/record.ts'
import type { ChildRecord, GateResult } from '../src/record.ts'
import { BLOCK_END, gateOverrideBrief, worktreeBrief } from '../src/text.ts'
import { DEFAULT_SETTINGS, parseSettings } from '../src/settings.ts'
import type { CrewSettings } from '../src/settings.ts'
import { provideStub, shippedWith, tempDir, watchLogs } from './helpers.ts'

/** What the preset's agents can see: the standard tools, less what dish removes, plus a global one. */
const GLOBAL_TOOLS = ['glob']
const PRESET_TOOLS = ['read', 'grep', 'write', 'edit', 'bash', 'job_output', 'job_list', 'job_kill', 'web_search', 'web_fetch', 'skill', 'todo_write', 'send_message', 'subagent', 'interrupt_agent']

const SESSION = 'session-main'

const disposables: Array<{ dispose(): Promise<void> | void }> = []
after(async () => {
  await Promise.all(disposables.splice(0).map(handle => handle.dispose()))
})

function settingsFrom(change: (document: Record<string, any>) => void): CrewSettings {
  const parsed = parseSettings(shippedWith(change))
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.problem)
  return parsed.settings
}

interface Sent {
  sender: Agent
  target: string
  content: unknown[]
  options: { signal: AbortSignal }
}

interface Options {
  settings?: CrewSettings
  /** The records the `dishCrew` stub wraps; a fresh directory when absent. */
  records?: CrewRecords
  dishCrew?: boolean
  dishPrompts?: boolean
  /** Mount the real dish-prompts plugin instead of a stub (with no store: the shipped prompts). */
  realPrompts?: boolean
  dishConfig?: boolean
  /** Whether dsh's agent registry is there. */
  agents?: boolean
  /** Global tools beyond the standard ones, as a plugin that isn't crew registers them (dish-judge's `ask_judge`). */
  globalTools?: string[]
  /** Standard tools the preset leaves out. */
  withoutTools?: string[]
  /** The preset's `send_message` is dsh's own, marked one (a preset that still loads `tool-subagent-control`). */
  dshSendMessage?: boolean
  /** Whether dish-workspaces' service is there (a stub that resolves what `makeWorktree` made). */
  workspaces?: boolean
  /** Whether dish-gates' service is there (a stub whose `gateFor` gives what `World.gates` has for a project). */
  dishGates?: boolean
  /** Whether dish-orchestrator's service is there (a stub whose `place` gives what `World.placements` has). */
  runs?: boolean
}

/** What `dishRuns.place` gives (dish-orchestrator's `Placement`). */
interface Placement {
  run: string
  task?: string
  round?: number
  final?: true
}

/** What `dishRuns.ladder` is given (dish-orchestrator's `LadderEntry`). */
interface LadderEntry {
  sessionId: string
  run: string
  task: string
  round: number
  outcome: 'refused' | 'ruled'
  ruling?: string
  child?: string
}

/** A worktree as dish-workspaces' `resolve` gives one. */
interface Worktree {
  project: string
  slug: string
  branch: string
  path: string
  clone: string
  base: string
}

/** Everything a test of the `delegate` tool stands on: a real Context, the real tool registry, and recording stubs for the rest. */
interface World {
  ctx: Context
  settings: { current: CrewSettings }
  records: CrewRecords
  directory: string
  /** The model the main agent's latest request used. */
  mainModel: { current: string | undefined }
  /** The live agents `ctx.agents.get` knows, by id. */
  agents: Map<string, { status: 'running' | 'idle' }>
  starts: ContinuableStartSpec[]
  sends: Sent[]
  resolves: Array<{ config: Record<string, unknown>, signal: AbortSignal | undefined }>
  personaAsked: string[]
  /** What `startContinuable` sees of the record at the moment it is called, per child id. */
  recordedAtStart: Map<string, ChildRecord | undefined>
  /** The main session's `cwd`: a temp directory (canonical) that stands for a project's clone. */
  workspace: string
  /** What the `dishWorkspaces` stub resolves, by `<project>/<slug>` and by path. */
  worktrees: Map<string, Worktree>
  /** What `dishWorkspaces.resolve` was asked, in order. */
  resolveAsked: string[]
  /** What `dishWorkspaces.resolveProblem` says, by ref: why a worktree dish made doesn't resolve. */
  problems: Map<string, string>
  /** What the `dishGates` stub's `gateFor` gives, by project. */
  gates: Map<string, string>
  /** What `dishGates.gateFor` was asked, in order. */
  gateAsked: string[]
  /**
   * What the `dishRuns` stub's `place` gives, by `${sessionId}|${worktree ?? ''}|${reviews ?? ''}`: a placement, or a function
   * that gives one when it is asked. `undefined` (no run) for a key it doesn't have.
   */
  placements: Map<string, unknown>
  /** What `dishRuns.place` was asked, in order. */
  placeAsked: Array<{ sessionId: string, target: Record<string, unknown> }>
  /** What `dishRuns.ladder` was given, in order. */
  ladderCalls: LadderEntry[]
  /** What the `dishRuns` stub's `driving` gives, by session: the run it drives. `undefined` (none) for a session it doesn't have. */
  driving: Map<string, unknown>
  /** What `dishRuns.driving` was asked, in order. */
  drivingAsked: string[]
  stub: {
    /** An error `startContinuable` throws instead of starting. */
    startFails: Error | undefined
    sendFails: Error | undefined
    resolveFails: Error | undefined
    /** How long `startContinuable` takes. */
    startMs: number
    /** Roles `persona()` refuses as the real service does for a role with no document and no default: `unknown role` with the code `UNKNOWN_ROLE`. */
    noPrompt: Set<string>
    /** An error `persona()` throws instead, as it does when the store can't be read. */
    promptFails: Error | undefined
    /** The status a started child has in `ctx.agents` once started. */
    startedStatus: 'running' | 'idle'
    /** An error `dishWorkspaces.resolve` throws instead of answering. */
    resolveWorktreeFails: Error | undefined
    /** An error `dishWorkspaces.resolveProblem` throws instead of answering. */
    resolveProblemFails: Error | undefined
    /** An error `dishGates.gateFor` throws instead of answering. */
    gateForFails: Error | undefined
    /** An error `dishRuns.place` throws instead of answering (dish-orchestrator's never rejects: this is a broken one). */
    placeFails: Error | undefined
    /** An error `dishRuns.ladder` throws instead of answering. */
    ladderFails: Error | undefined
    /** An error `dishRuns.driving` throws instead of answering. */
    drivingFails: Error | undefined
  }
  main: Agent
  /** A scoped agent as dsh makes one under the preset. */
  agent(id: string, extra?: Record<string, unknown>): Agent
  exec(agent?: Agent | undefined, signal?: AbortSignal): ToolRunContext
  tool: ToolDefinition
  /** Call `delegate` as the main agent. */
  delegate(args: Record<string, unknown>, exec?: ToolRunContext): Promise<any>
  /** Put a child in the record, as `delegate` would have, and in `ctx.agents` as `status` says. */
  seed(child: Partial<ChildRecord> & { id: string }, status?: 'running' | 'idle' | 'absent', session?: string): Promise<ChildRecord>
  /** Make `<root>/.worktrees/<slug>` (root defaults to the workspace) and have the stub resolve it as `frostyard/snosi/<slug>` and by path. */
  makeWorktree(slug: string, root?: string): Promise<Worktree>
  /** The main agent of another chat, top-level, whose session's `cwd` is `cwd` (none if `undefined`). */
  chat(id: string, cwd: string | undefined): Agent
}

let counter = 0

/** Provide a service the way dsh does, from a plugin of its own (see `provideStub`), and take it away when the test file is done. */
async function provide(ctx: Context, name: string, value: unknown): Promise<void> {
  disposables.push(await provideStub(ctx, name, value))
}

async function world(options: Options = {}): Promise<World> {
  const directory = await tempDir()
  const records = options.records ?? new CrewRecords(directory)
  const ctx = new Context()
  await provide(ctx, 'systemPrompt', { tools() {}, section() {}, getSectionOrder: () => 1 })
  disposables.push(await ctx.plugin(ToolRuntime, {}))
  let owner!: Context
  disposables.push(await ctx.plugin({ name: 'scope-owner', inject: ['tools'], apply(own: Context) { owner = own } } as never, undefined as never))
  for (const name of [...GLOBAL_TOOLS, ...options.globalTools ?? []]) ctx.tools.register(stubTool(name))
  const presetKey = {}
  const preset = createScope(owner, presetKey)
  disposables.push(preset)
  for (const name of PRESET_TOOLS) {
    if (options.withoutTools?.includes(name)) continue
    const tool = stubTool(name)
    // dsh's mark, as `markAdjacentAgentSendMessageTool` sets it on its own send_message.
    if (name === 'send_message' && options.dshSendMessage === true) Object.assign(tool, { [Symbol.for('dsh.subagent.adjacentAgentSendMessageTool')]: true })
    preset.ctx.tools.register(tool)
  }

  const settings = { current: options.settings ?? DEFAULT_SETTINGS }
  const mainModel = { current: 'claude-opus-5.5' as string | undefined }
  const agents = new Map<string, { status: 'running' | 'idle' }>()
  const starts: ContinuableStartSpec[] = []
  const sends: Sent[] = []
  const resolves: World['resolves'] = []
  const personaAsked: string[] = []
  const recordedAtStart = new Map<string, ChildRecord | undefined>()
  const stub: World['stub'] = {
    startFails: undefined, sendFails: undefined, resolveFails: undefined, startMs: 0, noPrompt: new Set(), promptFails: undefined, startedStatus: 'running',
    resolveWorktreeFails: undefined, resolveProblemFails: undefined, gateForFails: undefined, placeFails: undefined, ladderFails: undefined,
    drivingFails: undefined,
  }
  const workspace = await realpath(await tempDir())
  const worktrees = new Map<string, Worktree>()
  const resolveAsked: string[] = []
  const problems = new Map<string, string>()
  const gates = new Map<string, string>()
  const gateAsked: string[] = []
  const placements = new Map<string, unknown>()
  const placeAsked: World['placeAsked'] = []
  const ladderCalls: LadderEntry[] = []
  const driving = new Map<string, unknown>()
  const drivingAsked: string[] = []

  if (options.agents !== false) await provide(ctx, 'agents', { get: (id: string) => agents.get(id) })
  await provide(ctx, 'llm', {
    async resolveCallConfig(config: Record<string, unknown>, signal?: AbortSignal) {
      resolves.push({ config, signal })
      if (stub.resolveFails !== undefined) throw stub.resolveFails
      return config
    },
  })
  await provide(ctx, 'subagents', {
    async startContinuable(spec: ContinuableStartSpec) {
      starts.push(spec)
      recordedAtStart.set(String(spec.childId), (await records.lookup(String(spec.childId)))?.record)
      if (stub.startMs > 0) await new Promise(resolve => setTimeout(resolve, stub.startMs))
      if (stub.startFails !== undefined) throw stub.startFails
      const childId = String(spec.childId ?? `generated-${++counter}`)
      agents.set(childId, { status: stub.startedStatus })
      return { childId, messageId: 'm1' }
    },
    async sendMessage(sender: Agent, target: string, content: unknown[], sendOptions: { signal: AbortSignal }) {
      if (stub.sendFails !== undefined) throw stub.sendFails
      sends.push({ sender, target, content, options: sendOptions })
      return 'm2'
    },
  })
  if (options.dishCrew !== false) {
    await provide(ctx, 'dishCrew', {
      settings: async () => settings.current, records, whenRecorded: () => undefined, subagentProvider: 'spawn',
      // The host's own, over the same record and registry.
      async worktreeBindings(path: string) {
        return (await records.boundTo(path)).map(({ sessionId, record }) => ({
          child: record.id, sessionId, role: record.role, title: record.title, running: isRunning(record, { get: (id: string) => agents.get(id) }),
        }))
      },
    })
  }
  if (options.workspaces !== false) {
    await provide(ctx, 'dishWorkspaces', {
      async resolve(ref: string) {
        resolveAsked.push(ref)
        if (stub.resolveWorktreeFails !== undefined) throw stub.resolveWorktreeFails
        const found = worktrees.get(ref)
        return found === undefined ? undefined : { ...found }
      },
      async resolveProblem(ref: string) {
        if (stub.resolveProblemFails !== undefined) throw stub.resolveProblemFails
        return problems.get(ref)
      },
    })
  }
  if (options.dishGates === true) {
    await provide(ctx, 'dishGates', {
      async gateFor(project: string) {
        gateAsked.push(project)
        if (stub.gateForFails !== undefined) throw stub.gateForFails
        return gates.get(project)
      },
    })
  }
  if (options.runs === true) {
    await provide(ctx, 'dishRuns', {
      async place(sessionId: string, target: { worktree?: string, reviews?: string, final?: boolean }) {
        placeAsked.push({ sessionId, target: { ...target } })
        if (stub.placeFails !== undefined) throw stub.placeFails
        const found = placements.get(`${sessionId}|${target.worktree ?? ''}|${target.reviews ?? ''}`)
        return typeof found === 'function' ? (found as (asked: typeof target) => unknown)(target) : found
      },
      async ladder(entry: LadderEntry) {
        ladderCalls.push({ ...entry })
        if (stub.ladderFails !== undefined) throw stub.ladderFails
      },
      async driving(sessionId: string) {
        drivingAsked.push(sessionId)
        if (stub.drivingFails !== undefined) throw stub.drivingFails
        return driving.get(sessionId)
      },
    })
  }
  if (options.realPrompts === true) {
    disposables.push(await ctx.plugin(promptsPlugin, { terminal: false, stateDirectory: await tempDir() } as promptsPlugin.Config))
  } else if (options.dishPrompts !== false) {
    await provide(ctx, 'dishPrompts', {
      async persona(role: string) {
        personaAsked.push(role)
        if (stub.promptFails !== undefined) throw stub.promptFails
        if (stub.noPrompt.has(role)) throw Object.assign(new Error(`unknown role "${role}"`), { code: 'UNKNOWN_ROLE' })
        return { prefix: `You are the ${role}. {{model}}`, suffix: 'common rules', commit: null }
      },
    })
  }
  if (options.dishConfig === true) await provide(ctx, 'dishConfig', {})

  disposables.push(await ctx.plugin(row, {} as never))

  const agent = (id: string, extra: Record<string, unknown> = {}): Agent => {
    const made: Record<string, unknown> = {
      id,
      session: {
        header: { id, ...id === SESSION ? { cwd: workspace } : {} },
        requestHeader: () => id === SESSION && mainModel.current !== undefined ? { config: { provider: 'github-copilot', model: mainModel.current } } : undefined,
      },
      options: {},
      ...extra,
    }
    const scope = createScope(owner, made, { parent: presetKey })
    disposables.push(scope)
    made.ctx = scope.ctx
    return made as unknown as Agent
  }
  const main = agent(SESSION)
  const tool = ctx.tools.get('delegate', main)!
  const exec = (who: Agent | undefined = main, signal: AbortSignal = new AbortController().signal): ToolRunContext => ({ agent: who, signal }) as unknown as ToolRunContext

  return {
    ctx, settings, records, directory, mainModel, agents, starts, sends, resolves, personaAsked, recordedAtStart, stub, main, agent, exec, tool,
    workspace, worktrees, resolveAsked, problems, gates, gateAsked, placements, placeAsked, ladderCalls, driving, drivingAsked,
    delegate: (args, who = exec()) => tool.execute(args, who),
    async makeWorktree(slug, root = workspace) {
      const path = join(root, '.worktrees', slug)
      await mkdir(path, { recursive: true })
      const made = { project: 'frostyard/snosi', slug, branch: `dish/${slug}`, path, clone: root, base: 'a'.repeat(40) }
      worktrees.set(`frostyard/snosi/${slug}`, made)
      worktrees.set(path, made)
      return made
    },
    chat: (id, cwd) => agent(id, { session: { header: { id, ...cwd === undefined ? {} : { cwd } }, requestHeader: () => undefined } }),
    async seed(child, status = 'running', session = SESSION) {
      const added = await records.addChild(session, {
        role: 'coder', title: 'a task', model: 'claude-sonnet-5.5', family: 'anthropic', ...child,
      })
      if (status !== 'absent') agents.set(child.id, { status })
      if (child.last !== undefined && child.last !== 'running') {
        await records.endRun(child.id, { stopReason: child.last === 'finished' ? 'completed' : child.last === 'failed' ? 'error' : 'aborted', closing: 'x' })
      }
      return added
    },
  }
}

function stubTool(name: string): ToolDefinition {
  return {
    name,
    description: `the ${name} tool`,
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: false, properties: {} }, render: () => [{ type: 'text', text: 'done' }] },
    async execute() { return {} },
  } as unknown as ToolDefinition
}

/** The refusal a call fails with: its message. */
async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    assert.ok(error instanceof Error, 'a refusal is an Error')
    return error.message
  }
  assert.fail('expected the call to be refused')
}

const CODER = { role: 'coder', title: 'add login', task: 'Add a login form to app/' }
const RESEARCHER = { role: 'researcher', title: 'survey auth libs', task: 'Compare auth libraries.' }

// --- the row ---------------------------------------------------------------------------------------

test('the row is dish-crew-delegate, needs tools, subagents and llm, and takes no configuration', () => {
  assert.equal(row.name, 'dish-crew-delegate')
  assert.deepEqual([...row.inject], ['tools', 'subagents', 'llm'])
  assert.deepEqual(row.Config(({}) as never), {})
})

test('it registers delegate with a schema the tool registry accepts, and the output renders', async () => {
  const w = await world()
  assert.equal(w.tool.name, 'delegate')
  assert.doesNotThrow(() => assertSupportedJsonSchema(w.tool.output.schema as never))
  // defineTool turns each property's `required: true` into the JSON-Schema list.
  const schema = w.tool.output.schema as { properties: Record<string, unknown>, required: string[] }
  assert.deepEqual(Object.keys(schema.properties).sort(), ['child', 'label', 'model', 'note', 'role'])
  assert.deepEqual([...schema.required].sort(), ['child', 'label', 'model', 'role'], 'note is there only for a coder on a run\'s task')
  const parameters = w.tool.parameters as { properties: Record<string, unknown>, required: string[] }
  assert.deepEqual(Object.keys(parameters.properties).sort(), ['final', 'gateOverride', 'model', 'reviews', 'role', 'ruling', 'task', 'title', 'to', 'worktree'])
  assert.deepEqual([...parameters.required].sort(), ['role', 'task'], 'title is checked in execute: a follow-up needs none')
})

test('the description names the roles of crew.yaml and tells the model how to work', async () => {
  const w = await world({ settings: settingsFrom((d) => { d.roles.tester = { tier: 'mid', family: 'anthropic', tools: ['read'] } }) })
  const text = w.tool.description
  for (const role of ['architect', 'coder', 'reviewer', 'researcher', 'ops', 'writer', 'tester']) assert.match(text, new RegExp(`\\b${role}\\b`), role)
  assert.match(text, /self-contained/)
  assert.match(text, /end your turn/i)
  assert.match(text, /notif/i)
  assert.match(text, /`to`/)
  assert.match(text, /`reviews`/)
  assert.match(text, /main/)
})

test('the description still stands when the crew service is missing at registration', async () => {
  const w = await world({ dishCrew: false })
  assert.match(w.tool.description, /crew\.yaml/)
  assert.match(w.tool.description, /self-contained/)
})

test('the tool goes when the row does', async () => {
  const ctx = new Context()
  await provide(ctx, 'systemPrompt', { tools() {}, section() {}, getSectionOrder: () => 1 })
  disposables.push(await ctx.plugin(ToolRuntime, {}))
  await provide(ctx, 'subagents', {})
  await provide(ctx, 'llm', {})
  const handle = await ctx.plugin(row, {} as never)
  assert.ok(ctx.tools.get('delegate'))
  await handle.dispose()
  assert.equal(ctx.tools.get('delegate'), undefined)
})

test('the output renders a start and a follow-up', async () => {
  const w = await world()
  const render = (args: Record<string, unknown>, value: Record<string, string>) => (w.tool.output.render as any)(args, value)[0].text
  const value = { child: 'c1', role: 'coder', model: 'claude-sonnet-5.5', label: 'coder · claude-sonnet-5.5 · add login' }
  assert.equal(render(CODER, value), 'started coder «add login» on claude-sonnet-5.5 (child c1)')
  assert.equal(render({ ...CODER, to: 'c1' }, value), 'sent a follow-up to coder «add login» (child c1)')
  assert.equal(render({ ...CODER, to: '' }, value), 'started coder «add login» on claude-sonnet-5.5 (child c1)')
  // The ladder's note, for a coder on a run's task, on a line of its own.
  const note = 'Round 2 of task `fix-1`. The ladder: …'
  assert.equal(render(CODER, { ...value, note }), `started coder «add login» on claude-sonnet-5.5 (child c1)\n${note}`)
  assert.equal(render({ ...CODER, to: 'c1' }, { ...value, note }), `sent a follow-up to coder «add login» (child c1)\n${note}`)
})

// --- the caller and the services -------------------------------------------------------------------

test('a child, an agent with no session and a call with no agent are refused, first of all', async () => {
  const w = await world()
  const child = w.agent('child-1', { session: { header: { id: 'child-1', parentSession: SESSION, delegationDepth: 1, origin: 'subagent' } } })
  // The arguments are bad too (an unknown role, no task): the caller is what's refused.
  const bad = { role: 'nobody', title: '', task: '' }
  for (const who of [w.exec(child), w.exec(w.agent('bare', { session: undefined })), { ...w.exec(), agent: undefined } as ToolRunContext]) {
    assert.match(await refusal(w.delegate(bad, who)), /main agent only/)
    assert.match(await refusal(w.delegate(CODER, who)), /main agent only/)
  }
  assert.equal(w.starts.length, 0)
  assert.deepEqual(await w.records.children(SESSION), [])
})

test('a missing dishCrew or dishPrompts is an error that names the plugin that isn\'t running', async () => {
  const noCrew = await world({ dishCrew: false })
  assert.match(await refusal(noCrew.delegate(CODER)), /dish-crew plugin is not running/)
  const noPrompts = await world({ dishPrompts: false })
  assert.match(await refusal(noPrompts.delegate(CODER)), /dish-prompts plugin is not running/)
  assert.equal(noPrompts.starts.length, 0)
})

test('without dsh\'s agent registry nobody can be counted as running, so the call is refused, not let through', async () => {
  const w = await world({ agents: false })
  const message = await refusal(w.delegate(CODER))
  assert.match(message, /agent registry/)
  assert.match(message, /nothing was started/)
  assert.match(message, /Try again, or tell the user/)
  assert.equal(w.starts.length, 0)
  assert.deepEqual(await w.records.children(SESSION), [])
  // A follow-up needs the count as much as a start does.
  await w.seed({ id: 'c1', role: 'coder', last: 'finished' }, 'absent')
  assert.match(await refusal(w.delegate({ ...CODER, to: 'c1' })), /agent registry/)
  assert.equal(w.sends.length, 0)
})

test('an empty role, title or task is refused', async () => {
  const w = await world()
  assert.match(await refusal(w.delegate({ ...CODER, task: '  ' })), /task is empty/)
  assert.match(await refusal(w.delegate({ ...CODER, title: '' })), /title is empty/)
  assert.match(await refusal(w.delegate({ ...CODER, role: '' })), /role is empty.*architect, coder/)
  assert.equal(w.starts.length, 0)
})

// --- the role ----------------------------------------------------------------------------------------

test('an unknown role is refused with the roles of crew.yaml, and an Object member is not a role', async () => {
  const w = await world()
  assert.match(await refusal(w.delegate({ ...CODER, role: 'wizard' })), /unknown role "wizard".*architect, coder, reviewer, researcher, ops, writer/)
  for (const role of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    assert.match(await refusal(w.delegate({ ...CODER, role })), /unknown role/, role)
  }
  assert.equal(w.starts.length, 0)
})

test('a role with no prompt is refused, saying which document it needs', async () => {
  const w = await world()
  w.stub.noPrompt.add('coder')
  const message = await refusal(w.delegate(CODER))
  assert.match(message, /^role coder has no prompt/)
  assert.match(message, /prompts\/crew\/coder\.md/)
  assert.match(message, /unknown role "coder"/)
  assert.equal(w.starts.length, 0)
  assert.deepEqual(await w.records.children(SESSION), [])
  // Another role is not affected.
  await w.delegate(RESEARCHER)
  assert.equal(w.starts.length, 1)
})

test('a prompt that can\'t be read because the store failed is not a missing document, and the advice is not to write one', async () => {
  const w = await world()
  w.stub.promptFails = new Error('could not read the config store: lock held')
  const message = await refusal(w.delegate(CODER))
  assert.match(message, /^could not read the prompt of role coder/)
  assert.match(message, /lock held/)
  assert.match(message, /Try again, or tell the user/)
  assert.doesNotMatch(message, /prompts\/crew\/coder\.md/)
  assert.doesNotMatch(message, /dish-config is not running/)
  assert.equal(w.starts.length, 0)
  assert.deepEqual(await w.records.children(SESSION), [])
})

test('a missing document is told by the error\'s code, not by its words', async () => {
  const w = await world()
  // The same words with no code: some other failure, so no advice to write a document.
  w.stub.promptFails = new Error('unknown role "coder"')
  const message = await refusal(w.delegate(CODER))
  assert.match(message, /^could not read the prompt of role coder/)
  assert.doesNotMatch(message, /prompts\/crew\/coder\.md/)
  // The code with other words is a missing document.
  w.stub.promptFails = Object.assign(new Error('nothing for this one'), { code: 'UNKNOWN_ROLE' })
  assert.match(await refusal(w.delegate(CODER)), /^role coder has no prompt.*prompts\/crew\/coder\.md/)
})

test('with the real dish-prompts service: a role it has no text for is a missing document, and one it has starts with the shipped prompt', async () => {
  const w = await world({ realPrompts: true, settings: settingsFrom((d) => { d.roles.tester = { tier: 'mid', family: 'anthropic', tools: ['read'] } }) })
  // The code the row checks for is the one the service gives: the row can't import it (it loads nothing of dish-prompts).
  assert.equal(promptsPlugin.UNKNOWN_ROLE, 'UNKNOWN_ROLE')
  await assert.rejects(w.ctx.dishPrompts.persona('tester'), { code: promptsPlugin.UNKNOWN_ROLE })
  const message = await refusal(w.delegate({ role: 'tester', title: 'test it', task: 'Test.' }))
  assert.match(message, /^role tester has no prompt/)
  assert.match(message, /prompts\/crew\/tester\.md/)
  assert.match(message, /dish-config is not running/)
  assert.equal(w.starts.length, 0)
  await w.delegate(RESEARCHER)
  const shipped = w.ctx.dishPrompts.defaultText('researcher')
  assert.ok(shipped)
  assert.equal(w.starts[0]!.request.persona, shipped)
})

test('the refusal for a missing prompt says when the config store isn\'t running', async () => {
  const without = await world()
  without.stub.noPrompt.add('coder')
  assert.match(await refusal(without.delegate(CODER)), /dish-config is not running/)
  const withStore = await world({ dishConfig: true })
  withStore.stub.noPrompt.add('coder')
  assert.doesNotMatch(await refusal(withStore.delegate(CODER)), /dish-config is not running/)
})

test('the prompt is read for a start, and not for a follow-up, which keeps the prompt its child began with', async () => {
  const w = await world()
  await w.seed({ id: 'c1', role: 'coder', last: 'finished' }, 'idle')
  w.stub.noPrompt.add('coder')
  const result = await w.delegate({ ...CODER, to: 'c1' })
  assert.equal(result.child, 'c1')
  assert.deepEqual(w.personaAsked, [])
})

// --- a start -------------------------------------------------------------------------------------------

test('a start gives startContinuable everything, and records the child before it starts', async () => {
  const w = await world()
  const result = await w.delegate(CODER)
  assert.equal(w.starts.length, 1)
  const spec = w.starts[0]!
  assert.equal(spec.provider, 'spawn')
  assert.equal(spec.label, 'coder · claude-sonnet-5.5 · add login')
  assert.match(String(spec.childId), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  assert.equal(spec.request.parent, w.main)
  assert.deepEqual(spec.request.prompt, [{ type: 'text', text: CODER.task + BLOCK_END }, { type: 'text', text: REPORT_NOTE + BLOCK_END }])
  assert.equal(spec.request.persona, 'You are the coder. {{model}}')
  assert.deepEqual(spec.request.agentOptions, { provider: 'github-copilot', model: 'claude-sonnet-5.5' })
  assert.equal(spec.request.maxDepth, 1)
  assert.deepEqual(spec.request.toolFilter, {
    allow: ['bash', 'glob', 'grep', 'job_kill', 'job_list', 'job_output', 'read', 'send_message', 'skill', 'todo_write', 'web_fetch', 'edit', 'write'].sort(),
  })
  assert.ok(spec.signal instanceof AbortSignal)
  assert.deepEqual(w.personaAsked, ['coder'])
  // The route was checked, with the signal.
  assert.deepEqual(w.resolves.map(r => r.config), [{ provider: 'github-copilot', model: 'claude-sonnet-5.5' }])
  // The output.
  assert.deepEqual(result, { child: String(spec.childId), role: 'coder', model: 'claude-sonnet-5.5', label: 'coder · claude-sonnet-5.5 · add login' })
  // The record, written before startContinuable was called, and unchanged by it.
  const before = w.recordedAtStart.get(String(spec.childId))
  assert.ok(before, 'the child was in the record when startContinuable was called')
  assert.equal(before.last, 'running')
  const [recorded] = await w.records.children(SESSION)
  assert.deepEqual({ ...recorded, startedAt: 0 }, { id: String(spec.childId), n: 1, role: 'coder', title: 'add login', model: 'claude-sonnet-5.5', family: 'anthropic', startedAt: 0, followUps: 0, runs: [], last: 'running' })
})

// The note a child that has `send_message` gets after its task: its parent's id, and that its closing message is its report. It
// begins as dsh's own return note does, where dish-judge ends the brief. With dsh's marked send_message (a preset that still
// loads dsh's row), dsh appends its note after this one, and this one says so.
const closing = (marked: boolean): string => `Your parent agent id is "${SESSION}". `
  + 'Your closing message is your report: when you finish, the main agent receives it in full, automatically. '
  + `So don't send your result with send_message, not even a summary or part of it${marked ? ', even though the note after this one says to' : ''}. `
  + `Use send_message({ agent_id: "${SESSION}", message: "…" }) only for a short question you're blocked on while you work.`
const CLOSING_NOTE = closing(false)

// The note a coder or a reviewer gets in its place (step 7): they finish with `report`. It begins as the closing note does, with
// the parent's id, and differs from it only in the sentence after the id.
const reportNoteText = (marked: boolean): string => `Your parent agent id is "${SESSION}". `
  + 'Finish by calling `report`: it is your report, and the main agent receives it in full, automatically. '
  + `So don't send your result with send_message, not even a summary or part of it${marked ? ', even though the note after this one says to' : ''}. `
  + `Use send_message({ agent_id: "${SESSION}", message: "…" }) only for a short question you're blocked on while you work.`
const REPORT_NOTE = reportNoteText(false)

test('the closing note gives the parent\'s id, begins as dsh\'s note does, and names dsh\'s note only when dsh will add one', async () => {
  const w = await world()
  await w.delegate(RESEARCHER)
  const note = w.starts[0]!.request.prompt.at(-1)!
  assert.ok(note.type === 'text' && note.text.startsWith(RETURN_NOTE_LEAD), 'dish-judge ends the brief at it')
  assert.deepEqual(note, { type: 'text', text: closing(false) + BLOCK_END })
  assert.equal(row.closingNote(SESSION, false), closing(false))
  const marked = await world({ dshSendMessage: true })
  await marked.delegate(RESEARCHER)
  assert.deepEqual(marked.starts[0]!.request.prompt.at(-1), { type: 'text', text: closing(true) + BLOCK_END })
})

test('a coder\'s and a reviewer\'s prompts end with reportNote: the parent\'s id first, as dsh\'s note began, then finish with report', async () => {
  const w = await world()
  const coder = await w.delegate(CODER)
  await w.delegate({ ...REVIEW, reviews: coder.child })
  await w.delegate({ ...REVIEW, title: 'review mine', reviews: 'main' })
  assert.equal(w.starts.length, 3)
  for (const spec of w.starts) {
    const note = spec.request.prompt.at(-1)!
    assert.ok(note.type === 'text' && note.text.startsWith(`${RETURN_NOTE_LEAD}"${SESSION}". `), 'dish-judge ends the brief at it')
    assert.ok(note.type === 'text' && note.text.includes('`report`'))
    assert.deepEqual(note, { type: 'text', text: REPORT_NOTE + BLOCK_END }, spec.label)
  }
  assert.equal(row.reportNote(SESSION, false), REPORT_NOTE)
  assert.equal(row.reportNote(SESSION, true), reportNoteText(true))
  // With dsh's marked send_message, it says so, as the closing note does.
  const marked = await world({ dshSendMessage: true })
  const markedCoder = await marked.delegate(CODER)
  await marked.delegate({ ...REVIEW, reviews: markedCoder.child })
  for (const spec of marked.starts) assert.deepEqual(spec.request.prompt.at(-1), { type: 'text', text: reportNoteText(true) + BLOCK_END }, spec.label)
})

test('a researcher\'s, a writer\'s, an ops child\'s and an architect\'s prompts end with the closing note, byte for byte', async () => {
  const w = await world({ settings: settingsFrom((d) => { d.limits = { running: 8, writers: 8, perSession: 30 } }) })
  for (const role of ['researcher', 'writer', 'ops', 'architect']) await w.delegate({ role, title: 'a task', task: 'Do it.' })
  assert.equal(w.starts.length, 4)
  for (const spec of w.starts) assert.deepEqual(spec.request.prompt.at(-1), { type: 'text', text: CLOSING_NOTE + BLOCK_END }, spec.label)
})

test('a child that has send_message is told, after its task, that its closing message is its report; one that has not, is not', async () => {
  const w = await world()
  await w.delegate(CODER)
  await w.delegate(RESEARCHER)
  for (const spec of w.starts) {
    assert.ok(spec.request.toolFilter?.allow?.includes('send_message'))
    assert.equal(spec.request.prompt.length, 2)
    // A coder's is the report note; the researcher's, the closing note.
    assert.deepEqual(spec.request.prompt[1], { type: 'text', text: (spec === w.starts[0] ? REPORT_NOTE : CLOSING_NOTE) + BLOCK_END })
  }
  assert.equal(w.starts[0]!.request.prompt[0]!.type === 'text' && w.starts[0]!.request.prompt[0]!.text, `${CODER.task}${BLOCK_END}`, 'the task is first, unchanged but for the blank line after it')

  // A role without it, or whose send_message the parent can't give (dropped from the list), gets the task alone.
  const without = await world({ settings: settingsFrom((d) => { d.roles.researcher.tools = ['read', 'grep'] }) })
  await without.delegate(RESEARCHER)
  assert.deepEqual(without.starts[0]!.request.toolFilter, { allow: ['grep', 'read'] })
  assert.deepEqual(without.starts[0]!.request.prompt, [{ type: 'text', text: RESEARCHER.task + BLOCK_END }])
})

test('crew\'s blocks end with a blank line: dsh\'s adapters join a message\'s text blocks with nothing between them', async () => {
  assert.equal(BLOCK_END, '\n\n')
  const w = await world()
  await w.delegate(CODER)
  // What a model reads of the prompt, as pi-ai's adapter joins it (dsh adds its own note after the closing note).
  const read = w.starts[0]!.request.prompt.map(block => block.type === 'text' ? block.text : '').join('')
  assert.equal(read, `${CODER.task}\n\n${REPORT_NOTE}\n\n`)
})

test('the closing note is not added when the parent can not give send_message, even if the role lists it', async () => {
  const w = await world({ withoutTools: ['send_message'], settings: settingsFrom((d) => { d.roles.researcher.tools = ['read', 'send_message'] }) })
  await w.delegate(RESEARCHER)
  assert.deepEqual(w.starts[0]!.request.toolFilter, { allow: ['read'] })
  assert.deepEqual(w.starts[0]!.request.prompt, [{ type: 'text', text: RESEARCHER.task + BLOCK_END }])
})

test('the signal of the call goes to the route check and to startContinuable', async () => {
  const w = await world()
  const controller = new AbortController()
  await w.delegate(CODER, w.exec(w.main, controller.signal))
  assert.equal(w.starts[0]!.signal, controller.signal)
  assert.equal(w.resolves[0]!.signal, controller.signal)
})

test('the provider of the children is the host\'s subagentProvider', async () => {
  const w = await world()
  ;(w.ctx.dishCrew as { subagentProvider: string }).subagentProvider = 'fork'
  await w.delegate(CODER)
  assert.equal(w.starts[0]!.provider, 'fork')
})

test('each role starts on its own model and with its own tools', async () => {
  const w = await world()
  await w.delegate({ role: 'architect', title: 'plan it', task: 'Plan.' })
  await w.delegate(RESEARCHER)
  const [architect, researcher] = w.starts
  assert.deepEqual(architect!.request.agentOptions, { provider: 'github-copilot', model: 'claude-opus-5.5' })
  assert.deepEqual(architect!.request.toolFilter, { allow: ['edit', 'glob', 'grep', 'read', 'send_message', 'skill', 'todo_write', 'web_fetch', 'web_search', 'write'] })
  assert.deepEqual(researcher!.request.agentOptions, { provider: 'github-copilot', model: 'claude-sonnet-5.5' })
  assert.deepEqual(researcher!.request.toolFilter, { allow: ['glob', 'grep', 'read', 'send_message', 'skill', 'todo_write', 'web_fetch', 'web_search'] })
})

test('ask_judge: every shipped role lists it, and a child starts without it when dish-judge isn\'t installed, with it when it is', async () => {
  // Every role in one world, so the running and writer limits are raised: this isn't about them.
  const settings = settingsFrom((d) => { d.limits.running = 10; d.limits.writers = 10 })
  const bare = await world({ settings })
  const installed = await world({ settings, globalTools: ['ask_judge'] })
  for (const [role, title] of [['architect', 'plan it'], ['coder', 'add login'], ['reviewer', 'check it'], ['researcher', 'look it up'], ['ops', 'ship it'], ['writer', 'write it up']]) {
    assert.ok(DEFAULT_SETTINGS.roles[role]!.tools.includes('ask_judge'), role)
    const args = { role, title, task: 'Do it.', ...role === 'reviewer' ? { reviews: 'main' } : {} }
    // No ask_judge tool exists: the name is left out of the filter, the child starts, and nothing is refused.
    const before = bare.starts.length
    const started = await bare.delegate(args)
    assert.equal(bare.starts.length, before + 1, role)
    assert.equal(started.role, role)
    const without = bare.starts.at(-1)!.request.toolFilter!.allow!
    assert.ok(without.length > 0 && !without.includes('ask_judge'), role)
    // dish-judge's global tool is inherited, so it is allowed, and the rest of the list is the same.
    await installed.delegate(args)
    const withJudge = installed.starts.at(-1)!.request.toolFilter!.allow!
    assert.deepEqual(withJudge, [...without, 'ask_judge'].sort(), role)
  }
})

test('a role whose only tool is ask_judge is refused with what to do when dish-judge isn\'t installed, and nothing is started', async () => {
  const w = await world({ settings: settingsFrom((d) => { d.roles.researcher.tools = ['ask_judge'] }) })
  const message = await refusal(w.delegate(RESEARCHER))
  assert.match(message, /^role researcher would have no tools here/)
  assert.match(message, /crew\.yaml lists: ask_judge/)
  assert.match(message, /roles\.researcher\.tools/)
  assert.equal(w.starts.length, 0)
})

test('a model override from crew.yaml is used, and one that isn\'t is refused with the models offered', async () => {
  const w = await world()
  const result = await w.delegate({ ...CODER, model: 'gpt-5.6-sol' })
  assert.equal(result.model, 'gpt-5.6-sol')
  assert.deepEqual(w.starts[0]!.request.agentOptions, { provider: 'github-copilot', model: 'gpt-5.6-sol' })
  assert.equal(w.starts[0]!.label, 'coder · gpt-5.6-sol · add login')
  const [recorded] = await w.records.children(SESSION)
  assert.equal(recorded!.family, 'openai')
  w.agents.clear()
  const message = await refusal(w.delegate({ ...RESEARCHER, model: 'llama-9' }))
  assert.match(message, /llama-9/)
  assert.match(message, /gpt-5\.6-sol/)
  assert.equal(w.starts.length, 1)
})

test('empty strings are absent', async () => {
  const w = await world()
  const result = await w.delegate({ ...CODER, to: '', reviews: '', model: '' })
  assert.equal(result.model, 'claude-sonnet-5.5')
  assert.equal(w.starts.length, 1)
  assert.equal(w.sends.length, 0)
  const [recorded] = await w.records.children(SESSION)
  assert.equal(recorded!.reviews, undefined)
  // Whitespace is empty too.
  w.agents.clear()
  const second = await w.delegate({ ...RESEARCHER, to: '  ', reviews: ' ', model: '\n' })
  assert.equal(second.model, 'claude-sonnet-5.5')
  assert.equal(w.starts.length, 2)
})

test('the title is one line of reasonable length', async () => {
  const w = await world()
  const result = await w.delegate({ ...RESEARCHER, title: '  survey\n  auth   libs  ' })
  assert.equal(result.label, 'researcher · claude-sonnet-5.5 · survey auth libs')
  const long = await w.delegate({ ...RESEARCHER, title: 'x'.repeat(500) })
  assert.ok(long.label.length < 200, long.label)
  assert.match(long.label, /…$/)
  const records = await w.records.children(SESSION)
  assert.equal(records[0]!.title, 'survey auth libs')
})

// --- the route and the tools -----------------------------------------------------------------------------

test('a route that doesn\'t resolve is refused with the models crew.yaml offers, and nothing is started or recorded', async () => {
  const w = await world()
  w.stub.resolveFails = new Error('no such model')
  const message = await refusal(w.delegate(CODER))
  assert.match(message, /github-copilot\/claude-sonnet-5\.5/)
  assert.match(message, /no such model/)
  for (const model of ['claude-opus-5.5', 'claude-sonnet-5.5', 'gpt-6.1-sol', 'gpt-5.6-sol']) assert.ok(message.includes(model), model)
  assert.equal(w.starts.length, 0)
  assert.deepEqual(await w.records.children(SESSION), [])
})

test('a role with no tools here is refused before anything starts', async () => {
  const w = await world({ settings: settingsFrom((d) => { d.roles.writer.tools = ['not_a_tool'] }) })
  const message = await refusal(w.delegate({ role: 'writer', title: 'write docs', task: 'Write.' }))
  assert.match(message, /^role writer would have no tools here/)
  assert.match(message, /roles\.writer\.tools/)
  assert.equal(w.starts.length, 0)
  assert.deepEqual(await w.records.children(SESSION), [])
})

test('a tool the parent has on its own scope is left out of the list, because the child could not be restricted to it', async () => {
  const w = await world({ settings: settingsFrom((d) => { d.roles.researcher.tools = ['read', 'schedule_create'] }) })
  w.main.ctx.tools.register(stubTool('schedule_create'))
  await w.delegate(RESEARCHER)
  assert.deepEqual(w.starts[0]!.request.toolFilter, { allow: ['read'] })
})

test('never-list tools in a role are not given', async () => {
  const w = await world({ settings: settingsFrom((d) => { d.roles.researcher.tools = ['read', 'delegate', 'subagent', 'interrupt_agent'] }) })
  await w.delegate(RESEARCHER)
  assert.deepEqual(w.starts[0]!.request.toolFilter, { allow: ['read'] })
  // dish-orchestrator's tools are the main agent's, registered globally like worktree: a role that lists them doesn't get them.
  const orchestrator = ['run', 'open_pr', 'pr_feedback']
  const listed = await world({ globalTools: orchestrator, settings: settingsFrom((d) => { d.roles.researcher.tools = ['read', ...orchestrator] }) })
  await listed.delegate(RESEARCHER)
  assert.deepEqual(listed.starts[0]!.request.toolFilter, { allow: ['read'] })
})

// --- a provider per family -----------------------------------------------------------------------------

/** Direct API keys: Claude through `anthropic`, GPT through `openai`; the file's own provider is Copilot's. */
function directKeys(): CrewSettings {
  return settingsFrom((d) => {
    d.families.anthropic.provider = 'anthropic'
    d.families.openai.provider = 'openai'
    d.limits = { running: 8, writers: 8, perSession: 30 }
  })
}

test('the shipped default starts every role on github-copilot, the reviewer included', async () => {
  const w = await world({ settings: settingsFrom((d) => { d.limits = { running: 8, writers: 8, perSession: 30 } }) })
  for (const role of ['architect', 'coder', 'researcher', 'ops', 'writer']) await w.delegate({ role, title: 'a task', task: 'Do it.' })
  await w.delegate({ ...REVIEW, reviews: 'main' })
  assert.equal(w.starts.length, 6)
  for (const spec of w.starts) assert.equal(spec.request.agentOptions?.provider, 'github-copilot', spec.label)
  for (const resolved of w.resolves) assert.equal(resolved.config.provider, 'github-copilot')
})

test('a role starts on its family\'s provider, and the route check is made against that provider', async () => {
  const w = await world({ settings: directKeys() })
  const result = await w.delegate(CODER)
  assert.deepEqual(w.starts[0]!.request.agentOptions, { provider: 'anthropic', model: 'claude-sonnet-5.5' })
  assert.deepEqual(w.resolves[0]!.config, { provider: 'anthropic', model: 'claude-sonnet-5.5' })
  // The label and the record carry the model alone, as they did: the model is in one family, which has one provider.
  assert.equal(result.label, 'coder · claude-sonnet-5.5 · add login')
  assert.equal(w.starts[0]!.label, 'coder · claude-sonnet-5.5 · add login')
  const [recorded] = await w.records.children(SESSION)
  assert.deepEqual({ ...recorded, startedAt: 0 }, { id: result.child, n: 1, role: 'coder', title: 'add login', model: 'claude-sonnet-5.5', family: 'anthropic', startedAt: 0, followUps: 0, runs: [], last: 'running' })
})

test('an override in another family starts on that family\'s provider, however it is spelled', async () => {
  const w = await world({ settings: directKeys() })
  await w.delegate({ ...CODER, model: 'gpt-5.6-sol' })
  await w.delegate({ ...RESEARCHER, model: 'openai/gpt-6.1-sol' })
  assert.deepEqual(w.starts[0]!.request.agentOptions, { provider: 'openai', model: 'gpt-5.6-sol' })
  assert.deepEqual(w.starts[1]!.request.agentOptions, { provider: 'openai', model: 'gpt-6.1-sol' })
  assert.deepEqual(w.resolves.map(resolved => resolved.config), [{ provider: 'openai', model: 'gpt-5.6-sol' }, { provider: 'openai', model: 'gpt-6.1-sol' }])
  assert.equal(w.starts[1]!.label, 'researcher · gpt-6.1-sol · survey auth libs')
  const records = await w.records.children(SESSION)
  assert.deepEqual(records.map(record => [record.model, record.family]), [['gpt-5.6-sol', 'openai'], ['gpt-6.1-sol', 'openai']])
})

test('the reviewer starts on its own family\'s provider: GPT for Claude work, Claude for GPT work, and for the main agent\'s own', async () => {
  const w = await world({ settings: directKeys() })
  const claude = await w.delegate(CODER)
  const gpt = await w.delegate({ ...RESEARCHER, model: 'gpt-5.6-sol' })
  const first = await w.delegate({ ...REVIEW, reviews: claude.child })
  const second = await w.delegate({ ...REVIEW, reviews: gpt.child })
  const third = await w.delegate({ ...REVIEW, reviews: 'main' })
  assert.deepEqual([first.model, second.model, third.model], ['gpt-5.6-sol', 'claude-sonnet-5.5', 'gpt-5.6-sol'])
  assert.deepEqual(w.starts[2]!.request.agentOptions, { provider: 'openai', model: 'gpt-5.6-sol' })
  assert.deepEqual(w.starts[3]!.request.agentOptions, { provider: 'anthropic', model: 'claude-sonnet-5.5' })
  assert.deepEqual(w.starts[4]!.request.agentOptions, { provider: 'openai', model: 'gpt-5.6-sol' })
  assert.deepEqual(w.resolves.slice(2).map(resolved => resolved.config.provider), ['openai', 'anthropic', 'openai'])
  // A reviewer override is in the other family and takes its provider.
  const other = await w.delegate({ ...REVIEW, reviews: claude.child, model: 'openai/gpt-6.1-sol' })
  assert.equal(other.model, 'gpt-6.1-sol')
  assert.deepEqual(w.starts[5]!.request.agentOptions, { provider: 'openai', model: 'gpt-6.1-sol' })
  assert.match(await refusal(w.delegate({ ...REVIEW, reviews: claude.child, model: 'anthropic/claude-opus-5.5' })), /different family/)
})

test('a reviewer follow-up under family providers goes through, and starts nothing', async () => {
  const w = await world({ settings: directKeys() })
  const coder = await w.delegate(CODER)
  const reviewer = await w.delegate({ ...REVIEW, reviews: coder.child })
  w.agents.set(reviewer.child, { status: 'idle' })
  await w.records.endRun(reviewer.child, { stopReason: 'completed', closing: 'x' })
  const resolved = w.resolves.length
  await w.delegate({ ...REVIEW, task: 'Look again.', to: reviewer.child })
  assert.equal(w.sends.length, 1)
  assert.equal(w.starts.length, 2)
  assert.equal(w.resolves.length, resolved)
})

test('the reviewer rule reads models, not providers: a provider named anthropic-proxy on the openai family changes nothing', async () => {
  const w = await world({ settings: settingsFrom((d) => { d.families.openai.provider = 'anthropic-proxy'; d.limits = { running: 8, writers: 8, perSession: 30 } }) })
  const claude = await w.delegate(CODER)
  const result = await w.delegate({ ...REVIEW, reviews: claude.child })
  assert.equal(result.model, 'gpt-5.6-sol')
  assert.deepEqual(w.starts[1]!.request.agentOptions, { provider: 'anthropic-proxy', model: 'gpt-5.6-sol' })
  assert.deepEqual(w.resolves[1]!.config, { provider: 'anthropic-proxy', model: 'gpt-5.6-sol' })
  // GPT work is reviewed on Claude, the file's provider; and a Claude reviewer is refused for Claude work as before.
  const gpt = await w.delegate({ ...RESEARCHER, model: 'gpt-5.6-sol' })
  assert.deepEqual(w.starts[2]!.request.agentOptions, { provider: 'anthropic-proxy', model: 'gpt-5.6-sol' })
  const again = await w.delegate({ ...REVIEW, reviews: gpt.child })
  assert.equal(again.model, 'claude-sonnet-5.5')
  assert.deepEqual(w.starts[3]!.request.agentOptions, { provider: 'github-copilot', model: 'claude-sonnet-5.5' })
  assert.match(await refusal(w.delegate({ ...REVIEW, reviews: claude.child, model: 'claude-opus-5.5' })), /different family/)
})

test('a route that doesn\'t resolve names its provider, and lists the models as provider/model', async () => {
  const w = await world({ settings: directKeys() })
  w.stub.resolveFails = new Error('no key for anthropic')
  const message = await refusal(w.delegate(CODER))
  assert.match(message, /^model anthropic\/claude-sonnet-5\.5 is not available \(no key for anthropic\)\. /)
  assert.match(message, /Models crew\.yaml offers: anthropic\/claude-opus-5\.5, anthropic\/claude-sonnet-5\.5, openai\/gpt-6\.1-sol, openai\/gpt-5\.6-sol\./)
  assert.equal(w.starts.length, 0)
  assert.deepEqual(await w.records.children(SESSION), [])
  // On the file's provider the models are listed as they were.
  const plain = await world()
  plain.stub.resolveFails = new Error('down')
  assert.match(await refusal(plain.delegate(CODER)), /Models crew\.yaml offers: claude-opus-5\.5, claude-sonnet-5\.5, gpt-6\.1-sol, gpt-5\.6-sol\./)
})

test('an override that isn\'t offered is refused with the models as provider/model, and what is listed can be passed back', async () => {
  const w = await world({ settings: directKeys() })
  const message = await refusal(w.delegate({ ...CODER, model: 'llama-9' }))
  assert.match(message, /"llama-9"/)
  assert.match(message, /anthropic: anthropic\/claude-opus-5\.5, anthropic\/claude-sonnet-5\.5; openai: openai\/gpt-6\.1-sol, openai\/gpt-5\.6-sol/)
  assert.equal(w.starts.length, 0)
  // A provider that is not the model's family's is no way to name the model.
  assert.match(await refusal(w.delegate({ ...CODER, model: 'anthropic/gpt-5.6-sol' })), /not one crew\.yaml offers/)
  assert.equal(w.starts.length, 0)
  const ok = await w.delegate({ ...CODER, model: 'openai/gpt-5.6-sol' })
  assert.equal(ok.model, 'gpt-5.6-sol')
})

// --- the order -----------------------------------------------------------------------------------------

test('the checks run in the spec\'s order, each before the next', async () => {
  const w = await world({ settings: settingsFrom((d) => { d.limits = { running: 4, writers: 1, perSession: 30 } }) })
  const prompts = w.stub.noPrompt
  // 2. the role before its prompt; and a follow-up doesn't read the prompt.
  prompts.add('coder')
  assert.match(await refusal(w.delegate({ ...CODER, role: 'wizard' })), /unknown role/)
  assert.match(await refusal(w.delegate(CODER)), /prompts\/crew\/coder\.md/)
  assert.match(await refusal(w.delegate({ ...CODER, to: 'nobody' })), /not a crew child of this session/)
  prompts.clear()
  // 3. `to` before the limits.
  await w.seed({ id: 'w1', role: 'coder' })
  assert.match(await refusal(w.delegate({ ...CODER, to: 'nobody' })), /not a crew child of this session/)
  // 4. limits before the model.
  assert.match(await refusal(w.delegate({ ...CODER, model: 'llama-9' })), /a coder is running/)
  // The reviewer's `reviews` is looked up before its model override is judged.
  const reviewing = await refusal(w.delegate({ role: 'reviewer', title: 't', task: 't', reviews: 'nobody', model: 'llama-9' }))
  assert.match(reviewing, /"nobody" is not a crew child of this session/)
  assert.doesNotMatch(reviewing, /llama-9/)
  // 5. model before the route.
  w.stub.resolveFails = new Error('down')
  assert.match(await refusal(w.delegate({ ...RESEARCHER, model: 'llama-9' })), /llama-9/)
  assert.doesNotMatch(await refusal(w.delegate({ ...RESEARCHER, model: 'llama-9' })), /down/)
  assert.equal(w.resolves.length, 0)
  // 6. the route before the tools.
  const noTools = await world({ settings: settingsFrom((d) => { d.roles.writer.tools = ['not_a_tool'] }) })
  noTools.stub.resolveFails = new Error('down')
  assert.match(await refusal(noTools.delegate({ role: 'writer', title: 't', task: 't' })), /is not available/)
  assert.equal(w.starts.length, 0)
})

// --- the limits ------------------------------------------------------------------------------------------

test('the writer limit: a second writer is refused while one is running, with who is running and what to do', async () => {
  const w = await world()
  const first = await w.delegate(CODER)
  const message = await refusal(w.delegate({ role: 'ops', title: 'deploy it', task: 'Deploy.' }))
  assert.match(message, /^a coder is running \(child /)
  assert.ok(message.includes(first.child), message)
  assert.ok(message.includes('«add login»'), message)
  assert.match(message, /wait for its notice, or delegate a read-only role/)
  assert.equal(w.starts.length, 1)
  // A read-only role is fine, and so is any other once the coder isn't running.
  await w.delegate(RESEARCHER)
  assert.equal(w.starts.length, 2)
  w.agents.set(first.child, { status: 'idle' })
  await w.records.endRun(first.child, { stopReason: 'completed', closing: 'done' })
  await w.delegate({ role: 'ops', title: 'deploy it', task: 'Deploy.' })
  assert.equal(w.starts.length, 3)
})

test('an article that fits the role: an architect', async () => {
  const w = await world()
  await w.delegate({ role: 'architect', title: 'plan it', task: 'Plan.' })
  assert.match(await refusal(w.delegate(CODER)), /^an architect is running/)
})

test('more writers than one, when crew.yaml allows several', async () => {
  const w = await world({ settings: settingsFrom((d) => { d.limits = { running: 4, writers: 2, perSession: 30 } }) })
  await w.delegate(CODER)
  await w.delegate({ ...CODER, title: 'second one' })
  const message = await refusal(w.delegate({ ...CODER, title: 'third one' }))
  assert.match(message, /^2 writing children are running/)
  assert.match(message, /limits\.writers/)
  assert.match(message, /add login/)
  assert.match(message, /second one/)
  assert.match(message, /wait for a notice, or delegate a read-only role/)
})

test('the running limit: the fifth child is refused with who is running', async () => {
  const w = await world()
  for (let n = 1; n <= 4; n++) await w.delegate({ ...RESEARCHER, title: `look ${n}` })
  const message = await refusal(w.delegate({ ...RESEARCHER, title: 'look 5' }))
  assert.match(message, /^4 crew children are running/)
  assert.match(message, /limits\.running/)
  for (let n = 1; n <= 4; n++) assert.ok(message.includes(`«look ${n}»`), message)
  assert.equal(w.starts.length, 4)
})

test('the per-session limit counts every child ever started, and a follow-up is not a new child', async () => {
  const w = await world({ settings: settingsFrom((d) => { d.limits = { running: 4, writers: 1, perSession: 2 } }) })
  const one = await w.delegate(RESEARCHER)
  const two = await w.delegate({ ...RESEARCHER, title: 'second' })
  // None of them is running now: only the count is at issue.
  for (const child of [one.child, two.child]) {
    w.agents.set(child, { status: 'idle' })
    await w.records.endRun(child, { stopReason: 'completed', closing: 'x' })
  }
  const message = await refusal(w.delegate({ ...RESEARCHER, title: 'third' }))
  assert.match(message, /started 2 crew children/)
  assert.match(message, /limits\.perSession/)
  assert.match(message, /follow-up/)
  assert.equal(w.starts.length, 2)
  // A follow-up goes through.
  await w.delegate({ ...RESEARCHER, to: one.child })
  assert.equal(w.sends.length, 1)
})

test('the per-session limit holds after a restart: the count comes from the record, not memory', async () => {
  const directory = await tempDir()
  const settings = settingsFrom((d) => { d.limits = { running: 4, writers: 1, perSession: 2 } })
  const before = await world({ settings, records: new CrewRecords(directory) })
  const ids: string[] = []
  for (const title of ['one', 'two']) ids.push((await before.delegate({ ...RESEARCHER, title })).child)
  await before.records.flush()
  // A new process: a new CrewRecords on the same directory, a new Context, no live agents.
  const after = await world({ settings, records: new CrewRecords(directory) })
  assert.match(await refusal(after.delegate({ ...RESEARCHER, title: 'three' })), /started 2 crew children/)
  assert.equal(after.starts.length, 0)
  // The same session, and so the same count, for another session's children.
  const elsewhere = await world({ settings, records: new CrewRecords(directory) })
  const other = elsewhere.agent('another-session', { session: { header: { id: 'another-session' } } })
  const result = await elsewhere.delegate({ ...RESEARCHER, title: 'theirs' }, elsewhere.exec(other))
  assert.ok(result.child)
  assert.deepEqual((await elsewhere.records.children('another-session')).map(child => child.title), ['theirs'])
})

test('the writer limit holds after a restart too, for a child still running', async () => {
  const directory = await tempDir()
  const before = await world({ records: new CrewRecords(directory) })
  const coder = await before.delegate(CODER)
  await before.records.flush()
  const after = await world({ records: new CrewRecords(directory) })
  // The child is resident in the new process and running.
  after.agents.set(coder.child, { status: 'running' })
  assert.match(await refusal(after.delegate({ role: 'ops', title: 'x', task: 'x' })), /a coder is running/)
})

test('who counts as running: a live child that is stepping, or one that is accepted and recorded as running; not a record with no agent', async () => {
  const w = await world({ settings: settingsFrom((d) => { d.limits = { running: 1, writers: 1, perSession: 30 } }) })
  const blocked = async (): Promise<boolean> => {
    try {
      await w.delegate(RESEARCHER)
      return false
    } catch (error) {
      assert.match((error as Error).message, /^1 crew child is running/)
      return true
    }
  }
  // A crash left the record saying running, and no agent: not running.
  await w.seed({ id: 'stale', last: 'running' }, 'absent')
  assert.equal(await blocked(), false)
  w.agents.clear()
  // The agent is stepping, whatever the record says.
  await w.seed({ id: 'stepping', last: 'finished' }, 'running')
  assert.equal(await blocked(), true)
  // The agent is resident and idle and the record says finished: not running.
  w.agents.set('stepping', { status: 'idle' })
  assert.equal(await blocked(), false)
  w.agents.clear()
  // Accepted, not stepping yet: the record says running and the agent exists.
  await w.seed({ id: 'accepted', last: 'running' }, 'idle')
  assert.equal(await blocked(), true)
})

test('a child of another session is not counted, and neither does it block', async () => {
  const w = await world()
  await w.seed({ id: 'theirs', role: 'coder' }, 'running', 'another-session')
  const result = await w.delegate(CODER)
  assert.ok(result.child)
})

test('two delegations of writers in one step: exactly one starts', async () => {
  const w = await world()
  w.stub.startMs = 30
  const results = await Promise.allSettled([
    w.delegate({ ...CODER, title: 'first' }),
    w.delegate({ ...CODER, title: 'second' }),
    w.delegate({ role: 'ops', title: 'third', task: 'x' }),
  ])
  assert.deepEqual(results.map(result => result.status), ['fulfilled', 'rejected', 'rejected'])
  for (const result of results.slice(1)) assert.match((result as PromiseRejectedResult).reason.message, /a coder is running/)
  assert.equal(w.starts.length, 1)
  assert.equal((await w.records.children(SESSION)).length, 1)
})

test('five delegations of researchers in one step: the running limit holds', async () => {
  const w = await world()
  w.stub.startMs = 10
  const results = await Promise.allSettled([1, 2, 3, 4, 5].map(n => w.delegate({ ...RESEARCHER, title: `look ${n}` })))
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 4)
  assert.equal(results.filter(result => result.status === 'rejected').length, 1)
  assert.equal(w.starts.length, 4)
  assert.equal((await w.records.children(SESSION)).length, 4)
})

test('the per-session limit holds against calls in one step', async () => {
  const w = await world({ settings: settingsFrom((d) => { d.limits = { running: 4, writers: 1, perSession: 2 } }) })
  w.stub.startMs = 10
  const results = await Promise.allSettled([1, 2, 3].map(n => w.delegate({ ...RESEARCHER, title: `look ${n}` })))
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 2)
  assert.equal((await w.records.children(SESSION)).length, 2)
})

test('a call that waits for the lock and is cancelled meanwhile does not start anything', async () => {
  const w = await world()
  w.stub.startMs = 30
  const controller = new AbortController()
  const first = w.delegate(RESEARCHER)
  const second = w.delegate({ ...RESEARCHER, title: 'second' }, w.exec(w.main, controller.signal))
  controller.abort(new Error('cancelled'))
  await first
  await assert.rejects(second, /cancelled/)
  assert.equal(w.starts.length, 1)
  assert.equal((await w.records.children(SESSION)).length, 1)
})

test('a failure inside the lock does not wedge it', async () => {
  const w = await world()
  w.stub.startFails = new Error('boom')
  await refusal(w.delegate(RESEARCHER))
  w.stub.startFails = undefined
  w.agents.clear()
  const result = await w.delegate({ ...RESEARCHER, title: 'again' })
  assert.ok(result.child)
})

// --- follow-ups ----------------------------------------------------------------------------------------

test('a follow-up sends the task to the child, counts it, and starts nothing', async () => {
  const w = await world()
  const started = await w.delegate(CODER)
  w.agents.set(started.child, { status: 'idle' })
  await w.records.endRun(started.child, { stopReason: 'completed', closing: 'done' })
  const result = await w.delegate({ role: 'coder', title: 'ignored title', task: 'Fix the review findings.', to: started.child })
  assert.deepEqual(result, { child: started.child, role: 'coder', model: 'claude-sonnet-5.5', label: 'coder · claude-sonnet-5.5 · add login' })
  assert.equal(w.starts.length, 1)
  assert.equal(w.sends.length, 1)
  const sent = w.sends[0]!
  assert.equal(sent.sender, w.main)
  assert.equal(sent.target, started.child)
  assert.deepEqual(sent.content, [{ type: 'text', text: 'Fix the review findings.' }])
  assert.ok(sent.options.signal instanceof AbortSignal)
  const [record] = await w.records.children(SESSION)
  assert.equal(record!.followUps, 1)
  assert.equal(record!.last, 'running')
  assert.equal(record!.title, 'add login')
  assert.equal(w.resolves.length, 1, 'no route check for a follow-up: the child keeps its route')
})

test('a follow-up needs no title, and keeps its child\'s', async () => {
  const w = await world()
  const started = await w.delegate(CODER)
  w.agents.set(started.child, { status: 'idle' })
  await w.records.endRun(started.child, { stopReason: 'completed', closing: 'done' })
  const result = await w.delegate({ role: 'coder', task: 'Fix the review findings.', to: started.child })
  assert.equal(result.label, 'coder · claude-sonnet-5.5 · add login')
  assert.equal(w.sends.length, 1)
  // A start still needs one.
  const { title: _title, ...untitled } = CODER
  assert.match(await refusal(w.delegate(untitled)), /title is empty/)
  assert.equal(w.starts.length, 1)
})

test('a follow-up is refused for a child that is not one of this session\'s, naming the session\'s children', async () => {
  const w = await world()
  const started = await w.delegate(RESEARCHER)
  const unknown = await refusal(w.delegate({ ...RESEARCHER, to: 'no-such-child' }))
  assert.match(unknown, /"no-such-child" is not a crew child of this session/)
  assert.ok(unknown.includes(started.child), unknown)
  assert.ok(unknown.includes('«survey auth libs»'), unknown)
  // Another session's child is just as unknown.
  await w.seed({ id: 'theirs', role: 'researcher' }, 'idle', 'another-session')
  assert.match(await refusal(w.delegate({ ...RESEARCHER, to: 'theirs' })), /"theirs" is not a crew child of this session/)
  // And a session with none says so.
  const fresh = await world()
  assert.match(await refusal(fresh.delegate({ ...RESEARCHER, to: 'x' })), /has started no crew children/)
  assert.equal(w.sends.length, 0)
})

test('a follow-up is refused when the role is not the child\'s', async () => {
  const w = await world()
  const started = await w.delegate(RESEARCHER)
  w.agents.set(started.child, { status: 'idle' })
  await w.records.endRun(started.child, { stopReason: 'completed', closing: 'x' })
  const message = await refusal(w.delegate({ ...CODER, to: started.child }))
  assert.match(message, /is a researcher/)
  assert.match(message, /not a coder/)
  assert.match(message, /role to researcher/)
  assert.equal(w.sends.length, 0)
})

test('a follow-up is checked against the limits like a start', async () => {
  const w = await world()
  const coder = await w.delegate(CODER)
  w.agents.set(coder.child, { status: 'idle' })
  await w.records.endRun(coder.child, { stopReason: 'completed', closing: 'x' })
  // Another writer is running: the coder can't take a follow-up.
  const ops = await w.delegate({ role: 'ops', title: 'deploy', task: 'x' })
  const message = await refusal(w.delegate({ ...CODER, to: coder.child }))
  assert.match(message, /an ops is running/)
  assert.ok(message.includes(ops.child), message)
  assert.equal(w.sends.length, 0)
  // Once it's done, the follow-up goes.
  w.agents.set(ops.child, { status: 'idle' })
  await w.records.endRun(ops.child, { stopReason: 'completed', closing: 'x' })
  await w.delegate({ ...CODER, to: coder.child })
  assert.equal(w.sends.length, 1)
  // The running limit applies to a follow-up as well.
  const full = await world()
  const reader = await full.delegate(RESEARCHER)
  full.agents.set(reader.child, { status: 'idle' })
  await full.records.endRun(reader.child, { stopReason: 'completed', closing: 'x' })
  for (let n = 1; n <= 4; n++) await full.delegate({ ...RESEARCHER, title: `busy ${n}` })
  assert.match(await refusal(full.delegate({ ...RESEARCHER, to: reader.child })), /^4 crew children are running/)
})

test('a follow-up to a child that is running adds no running child: it is sent, whatever the limits are', async () => {
  const w = await world()
  // The one writer is running, and so it is the one the follow-up is for.
  const coder = await w.delegate(CODER)
  const result = await w.delegate({ ...CODER, task: 'Also handle logout.', to: coder.child })
  assert.equal(result.child, coder.child)
  assert.equal(w.sends.length, 1)
  assert.deepEqual(w.sends[0]!.content, [{ type: 'text', text: 'Also handle logout.' }])
  const [record] = await w.records.children(SESSION)
  assert.equal(record!.followUps, 1)
  // The running limit is full of children, this one among them: a message to one of them is still fine.
  const full = await world()
  const first = await full.delegate(RESEARCHER)
  for (let n = 2; n <= 4; n++) await full.delegate({ ...RESEARCHER, title: `busy ${n}` })
  await refusal(full.delegate({ ...RESEARCHER, title: 'one too many' }))
  await full.delegate({ ...RESEARCHER, to: first.child })
  assert.equal(full.sends.length, 1)
})

test('a follow-up to a finished coder while another coder runs is refused, naming the other and not the target', async () => {
  const w = await world()
  const first = await w.delegate(CODER)
  w.agents.set(first.child, { status: 'idle' })
  await w.records.endRun(first.child, { stopReason: 'completed', closing: 'x' })
  const second = await w.delegate({ ...CODER, title: 'second one' })
  const message = await refusal(w.delegate({ ...CODER, to: first.child }))
  assert.match(message, /^a coder is running \(child /)
  assert.ok(message.includes(second.child), message)
  assert.ok(message.includes('«second one»'), message)
  assert.ok(!message.includes(first.child), message)
  assert.equal(w.sends.length, 0)
  // With room for two writers, the other coder is no obstacle, and neither is a follow-up to the one that is running.
  const two = await world({ settings: settingsFrom((d) => { d.limits = { running: 4, writers: 2, perSession: 30 } }) })
  const a = await two.delegate(CODER)
  const b = await two.delegate({ ...CODER, title: 'b' })
  await two.delegate({ ...CODER, to: a.child })
  await two.delegate({ ...CODER, to: b.child })
  assert.equal(two.sends.length, 2)
  // A third running writer takes the room: another coder, finished, can't be written to; the running ones still can.
  const c = await two.seed({ id: 'finished-coder', last: 'finished' }, 'idle')
  assert.match(await refusal(two.delegate({ ...CODER, to: c.id })), /^2 writing children are running/)
  await two.delegate({ ...CODER, to: a.child })
  assert.equal(two.sends.length, 3)
})

test('a follow-up is not a delegation: the per-session limit does not apply to it', async () => {
  const w = await world({ settings: settingsFrom((d) => { d.limits = { running: 4, writers: 1, perSession: 1 } }) })
  const only = await w.delegate(RESEARCHER)
  w.agents.set(only.child, { status: 'idle' })
  await w.records.endRun(only.child, { stopReason: 'completed', closing: 'x' })
  await w.delegate({ ...RESEARCHER, to: only.child })
  assert.equal(w.sends.length, 1)
})

test('a follow-up can\'t change the model', async () => {
  const w = await world()
  const started = await w.delegate(RESEARCHER)
  w.agents.set(started.child, { status: 'idle' })
  await w.records.endRun(started.child, { stopReason: 'completed', closing: 'x' })
  const message = await refusal(w.delegate({ ...RESEARCHER, to: started.child, model: 'gpt-5.6-sol' }))
  assert.match(message, /can't change the model/)
  assert.match(message, /claude-sonnet-5\.5/)
  assert.equal(w.sends.length, 0)
  // An empty model is none.
  await w.delegate({ ...RESEARCHER, to: started.child, model: '' })
  assert.equal(w.sends.length, 1)
})

test('reviews on a role that doesn\'t review is refused, for a start and for a follow-up', async () => {
  const w = await world()
  const started = await w.delegate(RESEARCHER)
  w.agents.set(started.child, { status: 'idle' })
  await w.records.endRun(started.child, { stopReason: 'completed', closing: 'x' })
  const message = await refusal(w.delegate({ ...CODER, reviews: started.child }))
  assert.match(message, /reviews is for the reviewer role/)
  assert.match(message, /reviewer/)
  assert.match(await refusal(w.delegate({ ...RESEARCHER, to: started.child, reviews: 'main' })), /reviews is for the reviewer role/)
  assert.equal(w.starts.length, 1)
  assert.equal(w.sends.length, 0)
})

test('a follow-up that can\'t be sent is refused, and not counted', async () => {
  const w = await world()
  const started = await w.delegate(RESEARCHER)
  w.agents.set(started.child, { status: 'idle' })
  await w.records.endRun(started.child, { stopReason: 'completed', closing: 'x' })
  w.stub.sendFails = new Error('subagent is unavailable')
  const message = await refusal(w.delegate({ ...RESEARCHER, to: started.child }))
  assert.match(message, /could not send the follow-up to child /)
  assert.match(message, /subagent is unavailable/)
  assert.match(message, /start a new researcher/)
  const [record] = await w.records.children(SESSION)
  assert.equal(record!.followUps, 0)
  assert.equal(record!.last, 'finished')
})

test('a follow-up that is sent but can\'t be counted still succeeds, and says so in the log', async () => {
  const w = await world()
  const logs = watchLogs(w.ctx)
  const started = await w.delegate(RESEARCHER)
  w.agents.set(started.child, { status: 'idle' })
  await w.records.endRun(started.child, { stopReason: 'completed', closing: 'x' })
  ;(w.records as { addFollowUp: unknown }).addFollowUp = async () => { throw new Error('disk full') }
  const result = await w.delegate({ ...RESEARCHER, to: started.child })
  assert.equal(result.child, started.child)
  assert.equal(w.sends.length, 1)
  assert.ok(logs.some(line => /disk full/.test(line)), logs.join('\n'))
})

// --- a read-only chat (the nsl session's decision 1) --------------------------------------------------------

/** The refusal of a coder in a read-only chat, with the shipped crew.yaml, word for word. */
const READ_ONLY_CODER = 'This chat is read-only (`/permission read-only`), so a coder couldn\'t write its worktree. '
  + 'Ask your user to switch the chat to workspace-write (`/permission workspace-write`), then delegate again. '
  + 'Read-only roles (researcher, reviewer) still run.'

/** A stub of dsh's sandbox policy, and what it was asked. */
interface Policy {
  /** The `mode` that `resolve` gives now, for a session `sessions` doesn't have. */
  mode: unknown
  /** The mode `resolve` gives for a session, by the session object, or an error it throws for that session. */
  sessions: Map<unknown, unknown>
  /** What `resolve` was asked, in order. */
  asked: Array<Record<string, unknown>>
  /** An error `resolve` throws instead of answering. */
  fails: Error | undefined
  /** Takes the service away. */
  handle: { dispose(): Promise<void> | void }
}

/**
 * dsh's `sandboxPolicy` (`dsh-sandbox-policy`), provided from a plugin of its own as dsh provides it, after the row is
 * mounted: `resolve({ session })` gives `{ mode, workspaceRoot, sessionId }`, with the mode `Policy.sessions` has for the
 * session at the time, else `Policy.mode`.
 */
async function sandboxPolicy(w: World, mode: unknown): Promise<Policy> {
  const policy: Omit<Policy, 'handle'> = { mode, sessions: new Map(), asked: [], fails: undefined }
  const handle = await provideStub(w.ctx, 'sandboxPolicy', {
    defaultMode: 'workspace-write',
    resolve(request: Record<string, unknown> = {}) {
      policy.asked.push(request)
      if (policy.fails !== undefined) throw policy.fails
      const own = policy.sessions.has(request.session) ? policy.sessions.get(request.session) : policy.mode
      if (own instanceof Error) throw own
      return { mode: own, workspaceRoot: w.workspace, sessionId: SESSION }
    },
  })
  disposables.push(handle)
  return Object.assign(policy, { handle })
}

test('in a read-only chat, a start of a role that writes is refused before anything starts, and says how to switch', async () => {
  const w = await world()
  const policy = await sandboxPolicy(w, 'read-only')
  assert.equal(await refusal(w.delegate(CODER)), READ_ONLY_CODER)
  assert.equal(policy.asked.length, 1)
  assert.equal(policy.asked[0]!.session, w.main.session, 'the policy is resolved for the delegating agent\'s session')
  // Each role with `writes: true`, with the article that fits it.
  for (const [role, named] of [['architect', 'an architect'], ['ops', 'an ops'], ['writer', 'a writer']] as const) {
    assert.equal(await refusal(w.delegate({ role, title: 't', task: 't' })), READ_ONLY_CODER.replace('a coder', named), role)
  }
  // Before the worktree is looked up, and before the limits: a writer running is not the reason.
  await w.makeWorktree('login')
  assert.equal(await refusal(w.delegate({ ...CODER, worktree: 'frostyard/snosi/login' })), READ_ONLY_CODER)
  assert.deepEqual(w.resolveAsked, [])
  await w.seed({ id: 'w1', role: 'coder' })
  assert.equal(await refusal(w.delegate({ role: 'ops', title: 't', task: 't' })), READ_ONLY_CODER.replace('a coder', 'an ops'))
  assert.equal(w.starts.length, 0)
  assert.equal(w.resolves.length, 0)
  assert.deepEqual((await w.records.children(SESSION)).map(child => child.id), ['w1'], 'nothing was recorded')
})

test('in a read-only chat, a follow-up to a role that writes is refused too, and nothing is sent or counted', async () => {
  const w = await world()
  await w.seed({ id: 'c1', role: 'coder', last: 'finished' }, 'idle')
  const policy = await sandboxPolicy(w, 'read-only')
  assert.equal(await refusal(w.delegate({ ...CODER, to: 'c1' })), READ_ONLY_CODER)
  assert.equal(policy.asked[0]!.session, w.main.session)
  assert.equal(w.sends.length, 0)
  assert.equal((await w.records.children(SESSION))[0]!.followUps, 0)
  // The target is checked first: a child that isn't this session's, or of another role, is that refusal.
  assert.match(await refusal(w.delegate({ ...CODER, to: 'nobody' })), /"nobody" is not a crew child of this session/)
  assert.match(await refusal(w.delegate({ role: 'ops', task: 't', to: 'c1' })), /is a coder/)
  // Once the user switches, the same follow-up goes.
  policy.mode = 'workspace-write'
  await w.delegate({ ...CODER, to: 'c1' })
  assert.equal(w.sends.length, 1)
})

test('in a read-only chat, the read-only roles still start, and their follow-ups go', async () => {
  const w = await world()
  const policy = await sandboxPolicy(w, 'read-only')
  const researcher = await w.delegate(RESEARCHER)
  const reviewer = await w.delegate({ role: 'reviewer', title: 'review it', task: 'Review.', reviews: 'main' })
  assert.equal(w.starts.length, 2)
  await finish(w, researcher.child)
  await finish(w, reviewer.child)
  await w.delegate({ ...RESEARCHER, to: researcher.child })
  await w.delegate({ role: 'reviewer', task: 'Again.', to: reviewer.child })
  assert.equal(w.sends.length, 2)
  assert.equal(policy.asked.length, 0, 'a role that doesn\'t write doesn\'t ask')
})

test('workspace-write and full access change nothing: a coder starts, and takes a follow-up', async () => {
  for (const mode of ['workspace-write', 'danger-full-access']) {
    const w = await world()
    const policy = await sandboxPolicy(w, mode)
    const started = await w.delegate(CODER)
    await finish(w, started.child)
    await w.delegate({ ...CODER, to: started.child })
    assert.equal(w.starts.length, 1, mode)
    assert.equal(w.sends.length, 1, mode)
    assert.equal(policy.asked.length, 2, mode)
  }
})

test('no sandbox policy, one that throws, or a mode that isn\'t exactly read-only: no refusal', async () => {
  const many = settingsFrom((d) => { d.limits = { running: 20, writers: 20, perSession: 30 } })
  // No service.
  const none = await world({ settings: many })
  await none.delegate(CODER)
  assert.equal(none.starts.length, 1)
  // A service with no `resolve`.
  const odd = await world({ settings: many })
  disposables.push(await provideStub(odd.ctx, 'sandboxPolicy', { overrideOf: () => 'read-only' }))
  await odd.delegate(CODER)
  assert.equal(odd.starts.length, 1)
  // A `resolve` that throws: logged, and the coder starts.
  const w = await world({ settings: many })
  const logs = watchLogs(w.ctx)
  const policy = await sandboxPolicy(w, 'read-only')
  policy.fails = new Error('policy broke')
  await w.delegate(CODER)
  assert.equal(w.starts.length, 1)
  assert.ok(logs.some(line => /sandbox mode/.test(line) && /policy broke/.test(line)), logs.join('\n'))
  policy.fails = undefined
  // Modes dsh doesn't have, and answers with none.
  const modes: unknown[] = [undefined, null, '', 'READ-ONLY', ' read-only', 'readonly', 'locked-down', 42, ['read-only'], { mode: 'read-only' }]
  for (const mode of modes) {
    policy.mode = mode
    await w.delegate({ ...CODER, title: `mode ${JSON.stringify(mode)}` })
  }
  assert.equal(w.starts.length, 1 + modes.length)
})

test('the mode is read on each call: a switch, and a policy that goes away, take effect at once', async () => {
  const w = await world()
  const policy = await sandboxPolicy(w, 'read-only')
  assert.equal(await refusal(w.delegate(CODER)), READ_ONLY_CODER)
  policy.mode = 'workspace-write'
  const started = await w.delegate(CODER)
  await finish(w, started.child)
  policy.mode = 'read-only'
  assert.equal(await refusal(w.delegate({ ...CODER, to: started.child })), READ_ONLY_CODER)
  await policy.handle.dispose()
  await w.delegate({ ...CODER, to: started.child })
  assert.equal(w.starts.length, 1)
  assert.equal(w.sends.length, 1)
  assert.equal(policy.asked.length, 3)
})

/** The refusal of a follow-up to a coder whose own sandbox is read-only, while the chat's isn't, word for word. */
const STUCK_CODER = 'This coder started while the chat was read-only, and keeps that sandbox: it can\'t write its worktree. '
  + 'Delegate a new coder (without `to`) instead.'

/** Seed a finished child of this session, live in the registry (idle) on `session`: what `ctx.agents.get` gives for it. */
async function liveChild(w: World, id: string, role: string, session: unknown): Promise<void> {
  await w.seed({ id, role, last: 'finished' }, 'idle')
  w.agents.set(id, { status: 'idle', session } as never)
}

test('a follow-up to a writing child whose own sandbox is read-only is refused once the chat isn\'t: it keeps the mode it started with', async () => {
  const w = await world()
  const policy = await sandboxPolicy(w, 'workspace-write')
  // The nsl session: the coder started while the chat was read-only, and the user has switched the chat since.
  const stuck = { id: 'c1', header: { id: 'c1' } }
  await liveChild(w, 'c1', 'coder', stuck)
  policy.sessions.set(stuck, 'read-only')
  assert.equal(await refusal(w.delegate({ ...CODER, to: 'c1' })), STUCK_CODER)
  assert.deepEqual(policy.asked.map(request => request.session), [w.main.session, stuck], 'the chat\'s mode, then the child\'s')
  // So in a full-access chat.
  policy.mode = 'danger-full-access'
  assert.equal(await refusal(w.delegate({ ...CODER, to: 'c1' })), STUCK_CODER)
  // The role is the call's.
  const ops = { id: 'o1', header: { id: 'o1' } }
  await liveChild(w, 'o1', 'ops', ops)
  policy.sessions.set(ops, 'read-only')
  assert.equal(await refusal(w.delegate({ role: 'ops', task: 't', to: 'o1' })),
    'This ops started while the chat was read-only, and keeps that sandbox: it can\'t write its worktree. Delegate a new ops (without `to`) instead.')
  // Both read-only: the chat's refusal wins, and the child isn't asked.
  policy.mode = 'read-only'
  policy.asked.length = 0
  assert.equal(await refusal(w.delegate({ ...CODER, to: 'c1' })), READ_ONLY_CODER)
  assert.deepEqual(policy.asked.map(request => request.session), [w.main.session])
  // Nothing was sent or counted.
  assert.equal(w.sends.length, 0)
  for (const child of await w.records.children(SESSION)) assert.equal(child.followUps, 0, child.id)
  // A new coder, as the refusal says, starts.
  policy.mode = 'workspace-write'
  await w.delegate(CODER)
  assert.equal(w.starts.length, 1)
})

test('a writing child started outside a read-only chat takes its follow-up, and a read-only role\'s child isn\'t asked', async () => {
  const w = await world()
  const policy = await sandboxPolicy(w, 'workspace-write')
  const session = { id: 'c1', header: { id: 'c1' } }
  await liveChild(w, 'c1', 'coder', session)
  for (const mode of ['workspace-write', 'danger-full-access', undefined, 'READ-ONLY']) {
    policy.sessions.set(session, mode)
    await w.delegate({ ...CODER, to: 'c1' })
    await finish(w, 'c1')
    w.agents.set('c1', { status: 'idle', session } as never)
  }
  assert.equal(w.sends.length, 4)
  // A researcher's child read-only is as it should be: nothing is asked of it, or of the chat.
  const researcher = { id: 'r1', header: { id: 'r1' } }
  await liveChild(w, 'r1', 'researcher', researcher)
  policy.sessions.set(researcher, 'read-only')
  policy.asked.length = 0
  await w.delegate({ ...RESEARCHER, to: 'r1' })
  assert.equal(w.sends.length, 5)
  assert.deepEqual(policy.asked, [])
})

test('a writing child whose sandbox can\'t be read takes its follow-up: not live, no session, or a policy that throws for it (logged)', async () => {
  const w = await world({ settings: settingsFrom((d) => { d.limits = { running: 10, writers: 10, perSession: 30 } }) })
  const logs = watchLogs(w.ctx)
  const policy = await sandboxPolicy(w, 'workspace-write')
  // Not live (a restart, say): no agent to read.
  await w.seed({ id: 'gone', role: 'coder', last: 'finished' }, 'absent')
  await w.delegate({ ...CODER, to: 'gone' })
  // Live with no session, or one that can't be read: the policy isn't asked for it, since it would resolve the default.
  await w.seed({ id: 'bare', role: 'coder', last: 'finished' }, 'idle')
  await w.delegate({ ...CODER, to: 'bare' })
  await w.seed({ id: 'broken', role: 'coder', last: 'finished' }, 'idle')
  w.agents.set('broken', { status: 'idle', get session() { throw new Error('session closed') } } as never)
  await w.delegate({ ...CODER, to: 'broken' })
  assert.deepEqual(policy.asked.map(request => request.session), [w.main.session, w.main.session, w.main.session])
  // A policy that throws for the child's session: logged, naming the child.
  const session = { id: 'c1', header: { id: 'c1' } }
  await liveChild(w, 'c1', 'coder', session)
  policy.sessions.set(session, new Error('log unreadable'))
  await w.delegate({ ...CODER, to: 'c1' })
  assert.equal(w.sends.length, 4)
  assert.ok(logs.some(line => /sandbox mode of child c1/.test(line) && /log unreadable/.test(line)), logs.join('\n'))
})

test('the read-only roles the refusal names are crew.yaml\'s, and with none it names none', async () => {
  const w = await world({
    settings: settingsFrom((d) => {
      d.roles.tester = { tier: 'mid', family: 'anthropic', tools: ['read'] }
      d.roles.researcher.writes = true
    }),
  })
  await sandboxPolicy(w, 'read-only')
  assert.equal(await refusal(w.delegate(RESEARCHER)), READ_ONLY_CODER.replace('a coder', 'a researcher').replace('(researcher, reviewer)', '(reviewer, tester)'))
  await w.delegate({ role: 'tester', title: 't', task: 't' })
  assert.equal(w.starts.length, 1)
  const all = await world({ settings: settingsFrom((d) => { for (const role of Object.values(d.roles) as Array<Record<string, unknown>>) role.writes = true }) })
  await sandboxPolicy(all, 'read-only')
  assert.equal(await refusal(all.delegate(RESEARCHER)), READ_ONLY_CODER.replace('a coder', 'a researcher').replace(' Read-only roles (researcher, reviewer) still run.', ''))
})

// --- the reviewer rule, end to end -------------------------------------------------------------------------

const REVIEW = { role: 'reviewer', title: 'review the login', task: 'Review the change.' }

test('a reviewer needs reviews, and the child must be one of this session\'s', async () => {
  const w = await world()
  assert.match(await refusal(w.delegate(REVIEW)), /the reviewer role needs reviews: .*"main"/)
  assert.match(await refusal(w.delegate({ ...REVIEW, reviews: 'no-such-child' })), /"no-such-child" is not a crew child of this session/)
  await w.seed({ id: 'theirs', role: 'coder' }, 'idle', 'another-session')
  assert.match(await refusal(w.delegate({ ...REVIEW, reviews: 'theirs' })), /"theirs" is not a crew child of this session/)
  assert.equal(w.starts.length, 0)
})

test('reviews a Claude coder: the reviewer runs on GPT', async () => {
  const w = await world()
  const coder = await w.delegate(CODER)
  const result = await w.delegate({ ...REVIEW, reviews: coder.child })
  assert.equal(result.model, 'gpt-5.6-sol')
  const spec = w.starts[1]!
  assert.deepEqual(spec.request.agentOptions, { provider: 'github-copilot', model: 'gpt-5.6-sol' })
  assert.equal(spec.label, 'reviewer · gpt-5.6-sol · review the login')
  assert.equal(spec.request.persona, 'You are the reviewer. {{model}}')
  const recorded = (await w.records.children(SESSION)).find(child => child.id === result.child)!
  assert.equal(recorded.family, 'openai')
  assert.equal(recorded.reviews, coder.child)
  assert.deepEqual(w.resolves[1]!.config, { provider: 'github-copilot', model: 'gpt-5.6-sol' })
})

test('reviews a GPT coder (by an override): the reviewer runs on Claude', async () => {
  const w = await world()
  const coder = await w.delegate({ ...CODER, model: 'gpt-5.6-sol' })
  const result = await w.delegate({ ...REVIEW, reviews: coder.child })
  assert.equal(result.model, 'claude-sonnet-5.5')
  assert.equal((await w.records.children(SESSION)).find(child => child.id === result.child)!.family, 'anthropic')
})

test('a reviewer override in the reviewed family is refused, and in another family it is accepted', async () => {
  const w = await world()
  const coder = await w.delegate(CODER)
  const same = await refusal(w.delegate({ ...REVIEW, reviews: coder.child, model: 'claude-opus-5.5' }))
  assert.match(same, /claude-opus-5\.5/)
  assert.match(same, /different family/)
  assert.equal(w.starts.length, 1)
  const other = await w.delegate({ ...REVIEW, reviews: coder.child, model: 'gpt-6.1-sol' })
  assert.equal(other.model, 'gpt-6.1-sol')
})

test('reviews "main": a Claude main agent gets a GPT reviewer, and a GPT main agent a Claude one', async () => {
  const w = await world()
  w.mainModel.current = 'claude-opus-5.5'
  const first = await w.delegate({ ...REVIEW, reviews: 'main' })
  assert.equal(first.model, 'gpt-5.6-sol')
  assert.equal((await w.records.children(SESSION))[0]!.reviews, 'main')
  const gpt = await world()
  gpt.mainModel.current = 'gpt-6.1-sol'
  const second = await gpt.delegate({ ...REVIEW, reviews: 'main' })
  assert.equal(second.model, 'claude-sonnet-5.5')
})

test('reviews "main": a provider prefix on the main model is handled, and a model crew.yaml doesn\'t list is told by its vendor', async () => {
  const w = await world()
  w.mainModel.current = 'github-copilot/claude-opus-4.7'
  assert.equal((await w.delegate({ ...REVIEW, reviews: 'main' })).model, 'gpt-5.6-sol')
  const gpt = await world()
  gpt.mainModel.current = 'openai/gpt-4o-mini'
  assert.equal((await gpt.delegate({ ...REVIEW, reviews: 'main' })).model, 'claude-sonnet-5.5')
})

test('reviews "main": the main agent\'s model is read from its latest request, else from its options', async () => {
  const w = await world()
  w.mainModel.current = undefined
  ;(w.main as unknown as { options: object }).options = { model: 'gpt-5.6-sol' }
  assert.equal((await w.delegate({ ...REVIEW, reviews: 'main' })).model, 'claude-sonnet-5.5')
  // The latest request wins over the options the agent was created with.
  const switched = await world()
  switched.mainModel.current = 'claude-opus-5.5'
  ;(switched.main as unknown as { options: object }).options = { model: 'gpt-5.6-sol' }
  assert.equal((await switched.delegate({ ...REVIEW, reviews: 'main' })).model, 'gpt-5.6-sol')
})

test('reviews "main" with no main model is refused and nothing starts; a model of no known vendor, or a qwen one, gets the first reviewer family', async () => {
  const w = await world()
  w.mainModel.current = undefined
  const message = await refusal(w.delegate({ ...REVIEW, reviews: 'main' }))
  assert.match(message, /can't tell which model you/)
  assert.match(message, /reviews/)
  assert.equal(w.starts.length, 0)
  w.mainModel.current = 'mystery-1'
  assert.equal((await w.delegate({ ...REVIEW, reviews: 'main' })).model, 'gpt-5.6-sol')
  w.mainModel.current = 'halogen-qwen3.8-flash-next'
  assert.equal((await w.delegate({ ...REVIEW, reviews: 'main' })).model, 'gpt-5.6-sol')
  assert.equal(w.starts.length, 2)
})

test('a child that was started on a model crew.yaml no longer lists is still reviewed from outside its vendor', async () => {
  const w = await world()
  await w.seed({ id: 'old', role: 'coder', model: 'claude-3-haiku', family: 'anthropic' }, 'idle')
  const result = await w.delegate({ ...REVIEW, reviews: 'old' })
  assert.equal(result.model, 'gpt-5.6-sol')
})

test('reviews can\'t name a reviewer: its report is a review, so the work it reviewed is what to review', async () => {
  const w = await world()
  const coder = await w.delegate(CODER)
  const first = await w.delegate({ ...REVIEW, reviews: coder.child })
  const message = await refusal(w.delegate({ ...REVIEW, title: 'review the review', reviews: first.child }))
  assert.match(message, /is a reviewer/)
  assert.match(message, new RegExp(`review the work it reviewed: ${coder.child}`))
  // A reviewer of the main agent's work points back at "main".
  w.agents.clear()
  const ofMain = await w.delegate({ ...REVIEW, title: 'review main', reviews: 'main' })
  assert.match(await refusal(w.delegate({ ...REVIEW, title: 'again', reviews: ofMain.child })), /review the work it reviewed: main/)
  // A reviewer the record has no work for (the role is the reviewer's, the record says nothing) is refused all the same.
  await w.seed({ id: 'bare', role: 'reviewer', model: 'gpt-5.6-sol', family: 'openai' }, 'idle')
  const bare = await refusal(w.delegate({ ...REVIEW, title: 'third', reviews: 'bare' }))
  assert.match(bare, /is a reviewer/)
  assert.match(bare, /review the work itself/)
  assert.equal(w.starts.length, 3)
})

test('a reviewer follow-up whose reviewed child is no longer in the record is refused, saying so and to start a new reviewer', async () => {
  const w = await world()
  await w.seed({ id: 'r1', role: 'reviewer', model: 'gpt-5.6-sol', family: 'openai', reviews: 'gone-child', last: 'finished' }, 'idle')
  const message = await refusal(w.delegate({ ...REVIEW, to: 'r1' }))
  assert.match(message, /no longer in the record/)
  assert.match(message, /gone-child/)
  assert.match(message, /start a new reviewer/i)
  assert.doesNotMatch(message, /Use one of those ids/)
  assert.equal(w.sends.length, 0)
  // A child of another session is as gone.
  await w.seed({ id: 'theirs', role: 'coder' }, 'idle', 'another-session')
  await w.seed({ id: 'r2', role: 'reviewer', model: 'gpt-5.6-sol', family: 'openai', reviews: 'theirs', last: 'finished' }, 'idle')
  assert.match(await refusal(w.delegate({ ...REVIEW, to: 'r2' })), /no longer in the record/)
})

test('a reviewer follow-up is checked against the work as it is now: the main agent switching to the reviewer\'s family refuses it', async () => {
  const w = await world()
  w.mainModel.current = 'claude-opus-5.5'
  const reviewer = await w.delegate({ ...REVIEW, reviews: 'main' })
  assert.equal(reviewer.model, 'gpt-5.6-sol')
  w.agents.set(reviewer.child, { status: 'idle' })
  await w.records.endRun(reviewer.child, { stopReason: 'completed', closing: 'x' })
  // Still Claude on the main side: fine, with or without `reviews`.
  await w.delegate({ ...REVIEW, task: 'Look again.', to: reviewer.child })
  await w.delegate({ ...REVIEW, task: 'Look again.', to: reviewer.child, reviews: 'main' })
  assert.equal(w.sends.length, 2)
  // The user switches the main agent to GPT: the reviewer is on its family now.
  w.mainModel.current = 'gpt-6.1-sol'
  const message = await refusal(w.delegate({ ...REVIEW, task: 'Look again.', to: reviewer.child }))
  assert.match(message, /follow-up to reviewer/)
  assert.match(message, /start a new reviewer/i)
  assert.equal(w.sends.length, 2)
})

test('a reviewer follow-up can\'t be pointed at other work', async () => {
  const w = await world()
  const claude = await w.delegate(CODER)
  const gpt = await w.delegate({ ...RESEARCHER, model: 'gpt-5.6-sol' })
  const reviewer = await w.delegate({ ...REVIEW, reviews: claude.child })
  assert.equal(reviewer.model, 'gpt-5.6-sol')
  w.agents.set(reviewer.child, { status: 'idle' })
  await w.records.endRun(reviewer.child, { stopReason: 'completed', closing: 'x' })
  const message = await refusal(w.delegate({ ...REVIEW, to: reviewer.child, reviews: gpt.child }))
  assert.match(message, new RegExp(`reviews ${claude.child}`))
  assert.match(message, /start a new reviewer/i)
  assert.equal(w.sends.length, 0)
  // The same work is fine.
  await w.delegate({ ...REVIEW, to: reviewer.child, reviews: claude.child })
  assert.equal(w.sends.length, 1)
})

test('a reviewer follow-up whose model crew.yaml has since dropped is refused, with what to do', async () => {
  const w = await world()
  const coder = await w.delegate(CODER)
  const reviewer = await w.delegate({ ...REVIEW, reviews: coder.child })
  w.agents.set(reviewer.child, { status: 'idle' })
  await w.records.endRun(reviewer.child, { stopReason: 'completed', closing: 'x' })
  w.settings.current = settingsFrom((d) => { d.families.openai = { strong: 'gpt-7', mid: 'gpt-7-mini' } })
  const message = await refusal(w.delegate({ ...REVIEW, to: reviewer.child }))
  assert.match(message, /gpt-5\.6-sol/)
  assert.match(message, /start a new reviewer/i)
})

test('a reviewer follow-up whose reviewed work is itself a review is refused with advice for a follow-up: start a new reviewer', async () => {
  const w = await world()
  await w.seed({ id: 'r0', role: 'reviewer', model: 'gpt-5.6-sol', family: 'openai', reviews: 'main' }, 'idle')
  await w.seed({ id: 'r1', role: 'reviewer', model: 'claude-sonnet-5.5', family: 'anthropic', reviews: 'r0', last: 'finished' }, 'idle')
  const message = await refusal(w.delegate({ ...REVIEW, to: 'r1' }))
  assert.match(message, /^can't send a follow-up to reviewer child r1/)
  assert.match(message, /itself a review/)
  assert.match(message, /Start a new reviewer instead/)
  // Not the advice for a start: that would have the model re-point a follow-up, which isn't allowed.
  assert.doesNotMatch(message, /review the work it reviewed/)
  assert.doesNotMatch(message, /set reviews/)
  assert.equal(w.sends.length, 0)
})

test('a reviewer follow-up when the main agent\'s model can\'t be told is refused with advice for a follow-up too', async () => {
  const w = await world()
  w.mainModel.current = 'claude-opus-5.5'
  const reviewer = await w.delegate({ ...REVIEW, reviews: 'main' })
  w.agents.set(reviewer.child, { status: 'idle' })
  await w.records.endRun(reviewer.child, { stopReason: 'completed', closing: 'x' })
  w.mainModel.current = undefined
  const message = await refusal(w.delegate({ ...REVIEW, to: reviewer.child }))
  assert.match(message, /^can't send a follow-up to reviewer child /)
  assert.match(message, /can't tell which model you/)
  assert.match(message, /Start a new reviewer instead/)
  assert.doesNotMatch(message, /set reviews/)
  assert.equal(w.sends.length, 0)
})

// --- a start that fails ----------------------------------------------------------------------------------------

test('a start dsh refuses over a tool the child can\'t be restricted to is a refusal naming the tool to remove', async () => {
  const w = await world()
  w.stub.startFails = new Error('tools.restrict() names unknown global tool "schedule_create"; known global tools: glob, read')
  const message = await refusal(w.delegate(CODER))
  assert.match(message, /^role coder's tools include schedule_create, which a child can't be given here; remove it from roles\.coder\.tools in crew\.yaml/)
  assert.match(message, /counts as a delegation/)
  w.stub.startFails = new Error('tools.restrict() names unknown global tools "a_tool", "b_tool"; known global tools: glob')
  w.agents.clear()
  const several = await refusal(w.delegate({ ...RESEARCHER, title: 'look' }))
  assert.match(several, /^role researcher's tools include a_tool, b_tool, which a child can't be given here; remove them from roles\.researcher\.tools in crew\.yaml/)
})

test('the restrict failure is found when dsh wraps it', async () => {
  const w = await world()
  w.stub.startFails = new Error('could not create the child', { cause: new Error('tools.restrict() names unknown global tool "x_tool"; known global tools: glob') })
  assert.match(await refusal(w.delegate(CODER)), /^role coder's tools include x_tool/)
})

test('a failed start is recorded as failed, with its error, and counts as a delegation', async () => {
  const w = await world({ settings: settingsFrom((d) => { d.limits = { running: 4, writers: 1, perSession: 1 } }) })
  w.stub.startFails = new Error('provider spawn is down')
  const message = await refusal(w.delegate(CODER))
  assert.match(message, /could not start the coder/)
  assert.match(message, /provider spawn is down/)
  assert.match(message, /counts as a delegation/)
  assert.match(message, /Try again, or tell the user/)
  const [record] = await w.records.children(SESSION)
  assert.ok(record, 'the child was recorded before the start')
  assert.equal(record.id, String(w.starts[0]!.childId))
  assert.equal(record.last, 'failed')
  assert.equal(record.runs.length, 1)
  assert.equal(record.runs[0]!.stopReason, 'error')
  assert.equal(record.runs[0]!.error, 'provider spawn is down')
  // It isn't running, so it doesn't block a writer, and it counts toward the session.
  w.stub.startFails = undefined
  assert.match(await refusal(w.delegate(CODER)), /started 1 crew child\b/)
})

test('a failed start does not block the writer limit: the child never ran', async () => {
  const w = await world()
  w.stub.startFails = new Error('down')
  await refusal(w.delegate(CODER))
  w.stub.startFails = undefined
  const result = await w.delegate({ ...CODER, title: 'second try' })
  assert.ok(result.child)
})

test('a call that is cancelled before it begins starts and records nothing', async () => {
  const w = await world()
  const controller = new AbortController()
  controller.abort(new Error('cancelled'))
  await assert.rejects(w.delegate(CODER, w.exec(w.main, controller.signal)), /cancelled/)
  assert.equal(w.starts.length, 0)
  assert.deepEqual(await w.records.children(SESSION), [])
})

test('if the record can\'t be read, nothing is started or sent, for the limits, a follow-up and a review alike', async () => {
  const w = await world()
  const started = await w.delegate(RESEARCHER)
  w.agents.set(started.child, { status: 'idle' })
  await w.records.endRun(started.child, { stopReason: 'completed', closing: 'x' })
  const records = w.records as { children: unknown, lookup: unknown }
  records.children = async () => { throw new Error('EIO') }
  for (const args of [{ ...RESEARCHER, title: 'again' }, { ...REVIEW, reviews: 'main' }]) {
    const message = await refusal(w.delegate(args))
    assert.match(message, /could not read the crew's record \(EIO\), so nothing was started or sent/)
  }
  records.lookup = async () => { throw new Error('EIO') }
  assert.match(await refusal(w.delegate({ ...RESEARCHER, to: started.child })), /could not read the crew's record/)
  assert.match(await refusal(w.delegate({ ...REVIEW, reviews: started.child })), /could not read the crew's record/)
  assert.equal(w.starts.length, 1)
  assert.equal(w.sends.length, 0)
})

test('if the record can\'t be written, nothing is started', async () => {
  const w = await world()
  ;(w.records as { addChild: unknown }).addChild = async () => { throw new Error('read-only file system') }
  const message = await refusal(w.delegate(CODER))
  assert.match(message, /could not record the delegation/)
  assert.match(message, /read-only file system/)
  assert.match(message, /nothing was started/)
  assert.match(message, /Try again, or tell the user/)
  assert.equal(w.starts.length, 0)
})

test('if a failed start can\'t be recorded as failed, the refusal still comes, and the log says why', async () => {
  const w = await world()
  const logs = watchLogs(w.ctx)
  w.stub.startFails = new Error('provider down')
  ;(w.records as { endRun: unknown }).endRun = async () => { throw new Error('disk full') }
  const message = await refusal(w.delegate(CODER))
  assert.match(message, /provider down/)
  assert.ok(logs.some(line => /disk full/.test(line)), logs.join('\n'))
})

// --- binding a worktree ------------------------------------------------------------------------------------------

/** The block a bound coder's prompt gets after its task, as the plan words it. */
function brief(path: string, branch: string): string {
  return `Your worktree is \`${path}\` on branch \`${branch}\`. Work only there: use absolute paths, and \`git -C ${path}\` or \`cd ${path} &&\` in commands. `
    + 'The main agent\'s own checkout is not yours to change.'
}

/** Finish child `id`: its run ends and its agent is idle. */
async function finish(w: World, id: string): Promise<void> {
  w.agents.set(id, { status: 'idle' })
  await w.records.endRun(id, { stopReason: 'completed', closing: 'done' })
}

test('worktreeBrief names the path and the branch, says to work only there, and keeps the main agent\'s checkout out of it', () => {
  assert.equal(worktreeBrief({ path: '/work/o/r/.worktrees/fix-1', branch: 'dish/fix-1' }), brief('/work/o/r/.worktrees/fix-1', 'dish/fix-1'))
})

test('the worktree parameter and the description say what binding is', async () => {
  const w = await world()
  const parameters = w.tool.parameters as { properties: Record<string, { type: string, description: string }>, required: string[] }
  assert.equal(parameters.properties.worktree!.type, 'string')
  assert.ok(!parameters.required.includes('worktree'))
  assert.equal(parameters.properties.worktree!.description, 'A worktree from the `worktree` tool, as `<project>/<slug>` or the path it returned, to bind a coder to: '
    + 'its brief names it, and the harness checks its work there. Only for roles that write. Leave empty otherwise.')
  assert.match(w.tool.description, /`worktree`/)
})

test('a coder bound to a worktree: the record has its path, and the prompt is the task, the brief, and the closing note last', async () => {
  const w = await world()
  const tree = await w.makeWorktree('fix-1')
  const result = await w.delegate({ ...CODER, worktree: ' frostyard/snosi/fix-1 ' })
  assert.deepEqual(w.resolveAsked, ['frostyard/snosi/fix-1'])
  assert.equal(w.starts.length, 1)
  assert.deepEqual(w.starts[0]!.request.prompt, [
    { type: 'text', text: CODER.task + BLOCK_END },
    { type: 'text', text: brief(tree.path, 'dish/fix-1') + BLOCK_END },
    { type: 'text', text: REPORT_NOTE + BLOCK_END },
  ])
  // Recorded before the start, with the binding.
  assert.equal(w.recordedAtStart.get(result.child)?.worktree, tree.path)
  const [recorded] = await w.records.children(SESSION)
  assert.equal(recorded!.worktree, tree.path)
  assert.equal((await w.records.lookup(result.child))?.record.worktree, tree.path)

  // By the path `create` returned, once the first coder is done with it.
  await finish(w, result.child)
  const again = await w.delegate({ ...CODER, title: 'fix it again', worktree: tree.path })
  assert.equal((await w.records.lookup(again.child))?.record.worktree, tree.path)
})

test('a bound child without send_message gets the task and the brief', async () => {
  const w = await world({ settings: settingsFrom((d) => { d.roles.coder.tools = ['read', 'write', 'edit'] }) })
  const tree = await w.makeWorktree('fix-1')
  await w.delegate({ ...CODER, worktree: 'frostyard/snosi/fix-1' })
  assert.deepEqual(w.starts[0]!.request.prompt, [{ type: 'text', text: CODER.task + BLOCK_END }, { type: 'text', text: brief(tree.path, 'dish/fix-1') + BLOCK_END }])
})

test('a start without a worktree is as it was: no brief, no binding, and dish-workspaces is not asked', async () => {
  const w = await world()
  await w.delegate({ ...CODER, worktree: '' })
  assert.deepEqual(w.starts[0]!.request.prompt, [{ type: 'text', text: CODER.task + BLOCK_END }, { type: 'text', text: REPORT_NOTE + BLOCK_END }])
  assert.ok(!('worktree' in (await w.records.children(SESSION))[0]!))
  assert.deepEqual(w.resolveAsked, [])
  // Nor is it needed: a start without one works with no dish-workspaces at all.
  const without = await world({ workspaces: false })
  await without.delegate(CODER)
  assert.equal(without.starts.length, 1)
})

test('a role that doesn\'t write is refused a worktree, before dish-workspaces is asked, and is told to put the path in its task', async () => {
  const w = await world()
  await w.makeWorktree('fix-1')
  await w.seed({ id: 'c1', role: 'coder', last: 'finished' }, 'idle')
  const reviewer = await refusal(w.delegate({ role: 'reviewer', title: 'review it', task: 'Review c1.', reviews: 'c1', worktree: 'frostyard/snosi/fix-1' }))
  assert.equal(reviewer, '`worktree` is for roles that write; give a reviewer the path in its task instead')
  const researcher = await refusal(w.delegate({ ...RESEARCHER, worktree: 'frostyard/snosi/fix-1' }))
  assert.match(researcher, /give a researcher the path in its task instead/)
  assert.deepEqual(w.resolveAsked, [])
  assert.equal(w.starts.length, 0)
  assert.equal((await w.records.children(SESSION)).length, 1)
})

test('without dish-workspaces a worktree is refused, naming the plugin, and nothing starts', async () => {
  const w = await world({ workspaces: false })
  const message = await refusal(w.delegate({ ...CODER, worktree: 'frostyard/snosi/fix-1' }))
  assert.match(message, /dish-workspaces plugin is not running/)
  assert.equal(w.starts.length, 0)
  assert.deepEqual(await w.records.children(SESSION), [])
})

test('a worktree dish-workspaces doesn\'t know is refused, with how to make one; one it can\'t look up is refused with why', async () => {
  const w = await world()
  const message = await refusal(w.delegate({ ...CODER, worktree: 'frostyard/snosi/nope' }))
  assert.equal(message, 'no worktree `frostyard/snosi/nope` in a registered project; make one with the worktree tool (action create)')
  w.stub.resolveWorktreeFails = new Error('the state directory is unreadable')
  const failed = await refusal(w.delegate({ ...CODER, worktree: 'frostyard/snosi/nope' }))
  assert.match(failed, /could not look up worktree `frostyard\/snosi\/nope`/)
  assert.match(failed, /the state directory is unreadable/)
  assert.equal(w.starts.length, 0)
  assert.deepEqual(await w.records.children(SESSION), [])
})

test('a worktree outside the calling chat\'s workspace is refused, where a coder couldn\'t write; a workspace reached by a link is the same place', async () => {
  const w = await world()
  const tree = await w.makeWorktree('fix-1')
  const elsewhere = await realpath(await tempDir())
  const other = w.chat('session-other', elsewhere)
  const message = await refusal(w.delegate({ ...CODER, worktree: 'frostyard/snosi/fix-1' }, w.exec(other)))
  assert.equal(message, `worktree \`${tree.path}\` is outside this chat's workspace (\`${elsewhere}\`), where a coder couldn't write; `
    + `start a chat in the project's workspace (\`${w.workspace}\`)`)
  // A chat with no workspace at all.
  assert.match(await refusal(w.delegate({ ...CODER, worktree: 'frostyard/snosi/fix-1' }, w.exec(w.chat('session-bare', undefined)))), /this chat has no workspace/)
  // The clone's parent is not the clone: the worktree must be inside the chat's workspace, not beside it.
  const sibling = await w.makeWorktree('fix-2', elsewhere)
  assert.match(await refusal(w.delegate({ ...CODER, worktree: sibling.path })), /is outside this chat's workspace/)
  assert.equal(w.starts.length, 0)

  // Through a link to the workspace: both sides are compared canonically.
  const links = await tempDir()
  await symlink(w.workspace, join(links, 'clone'))
  const linked = w.chat('session-linked', join(links, 'clone'))
  await w.delegate({ ...CODER, worktree: 'frostyard/snosi/fix-1' }, w.exec(linked))
  assert.equal(w.starts.length, 1)
  assert.equal((await w.records.children('session-linked'))[0]!.worktree, tree.path)
})

test('the path resolve gives is made canonical: a worktree reached through a link is recorded, briefed and found by its real path', async () => {
  const w = await world()
  const tree = await w.makeWorktree('fix-1')
  const links = await tempDir()
  await symlink(w.workspace, join(links, 'clone'))
  const linked = { ...tree, path: join(links, 'clone', '.worktrees', 'fix-1'), clone: join(links, 'clone') }
  w.worktrees.set('frostyard/snosi/fix-1', linked)
  const started = await w.delegate({ ...CODER, worktree: 'frostyard/snosi/fix-1' })
  assert.equal((await w.records.lookup(started.child))?.record.worktree, tree.path)
  assert.deepEqual(w.starts[0]!.request.prompt[1], { type: 'text', text: brief(tree.path, 'dish/fix-1') + BLOCK_END })
  assert.deepEqual((await w.records.boundTo(tree.path)).map(({ record }) => record.id), [started.child])
  assert.deepEqual(await w.records.boundTo(linked.path), [])
})

test('inside the workspace means under it: a sibling directory that shares its name\'s start, and the workspace itself, are refused', async () => {
  const w = await world()
  const sibling = `${w.workspace}-x`
  try {
    const beside = await w.makeWorktree('fix', sibling)
    assert.equal(beside.path, `${w.workspace}-x/.worktrees/fix`)
    assert.match(await refusal(w.delegate({ ...CODER, worktree: 'frostyard/snosi/fix' })), /is outside this chat's workspace/)
    w.worktrees.set('frostyard/snosi/whole', { project: 'frostyard/snosi', slug: 'whole', branch: 'dish/whole', path: w.workspace, clone: w.workspace, base: 'a'.repeat(40) })
    assert.match(await refusal(w.delegate({ ...CODER, worktree: 'frostyard/snosi/whole' })), /is outside this chat's workspace/)
    assert.equal(w.starts.length, 0)
    assert.deepEqual(await w.records.children(SESSION), [])
  } finally {
    await rm(sibling, { recursive: true, force: true })
  }
})

test('a worktree bound to a running child is refused, naming it; once that child has finished, it can be bound again', async () => {
  const w = await world()
  const tree = await w.makeWorktree('fix-1')
  // A coder of another chat in the same clone: this session's limits don't see it.
  await w.seed({ id: 'theirs', role: 'coder', title: 'their fix', worktree: tree.path }, 'running', 'session-other')
  const message = await refusal(w.delegate({ ...CODER, worktree: 'frostyard/snosi/fix-1' }))
  assert.match(message, /coder «their fix» \(child theirs\)/)
  assert.match(message, /running/)
  assert.ok(message.includes(tree.path), message)
  assert.equal(w.starts.length, 0)
  assert.deepEqual(await w.records.children(SESSION), [])
  // Another worktree is free.
  await w.makeWorktree('fix-2')
  await w.delegate({ ...CODER, worktree: 'frostyard/snosi/fix-2' })
  assert.equal(w.starts.length, 1)

  // Finished: bound, but not running.
  const other = await world()
  const free = await other.makeWorktree('fix-1')
  await other.seed({ id: 'theirs', role: 'coder', worktree: free.path, last: 'finished' }, 'idle', 'session-other')
  await other.delegate({ ...CODER, worktree: 'frostyard/snosi/fix-1' })
  assert.equal(other.starts.length, 1)
})

test('a running child bound there is refused within one session too, when crew.yaml allows several writers', async () => {
  const w = await world({ settings: settingsFrom((d) => { d.limits = { running: 4, writers: 2, perSession: 30 } }) })
  await w.makeWorktree('fix-1')
  await w.delegate({ ...CODER, worktree: 'frostyard/snosi/fix-1' })
  assert.match(await refusal(w.delegate({ ...CODER, title: 'second', worktree: 'frostyard/snosi/fix-1' })), /is bound to coder «add login»/)
  assert.equal(w.starts.length, 1)
})

test('two chats binding one worktree in one step: exactly one starts', async () => {
  const w = await world()
  w.stub.startMs = 30
  await w.makeWorktree('fix-1')
  const second = w.chat('session-two', w.workspace)
  const results = await Promise.allSettled([
    w.delegate({ ...CODER, worktree: 'frostyard/snosi/fix-1' }),
    w.delegate({ ...CODER, worktree: 'frostyard/snosi/fix-1' }, w.exec(second)),
  ])
  assert.deepEqual(results.map(result => result.status).sort(), ['fulfilled', 'rejected'])
  assert.equal(w.starts.length, 1)
  const refused = results.find(result => result.status === 'rejected') as PromiseRejectedResult
  assert.match(refused.reason.message, /is bound to coder «add login»/)
})

test('a follow-up keeps the binding and adds nothing to its text; naming the same worktree, by ref or path, is fine', async () => {
  const w = await world()
  const tree = await w.makeWorktree('fix-1')
  const started = await w.delegate({ ...CODER, worktree: 'frostyard/snosi/fix-1' })
  await finish(w, started.child)
  await w.delegate({ ...CODER, task: 'Fix the findings.', to: started.child })
  assert.deepEqual(w.sends[0]!.content, [{ type: 'text', text: 'Fix the findings.' }])
  // The binding was checked: the worktree is still there.
  assert.deepEqual(w.resolveAsked, ['frostyard/snosi/fix-1', tree.path])
  await finish(w, started.child)
  await w.delegate({ ...CODER, task: 'Once more.', to: started.child, worktree: 'frostyard/snosi/fix-1' })
  await finish(w, started.child)
  await w.delegate({ ...CODER, task: 'And again.', to: started.child, worktree: tree.path })
  assert.equal(w.sends.length, 3)
  const record = (await w.records.lookup(started.child))!.record
  assert.equal(record.worktree, tree.path)
  assert.equal(record.followUps, 3)
})

test('a follow-up naming another worktree is refused, and so is binding a child that started unbound', async () => {
  const w = await world()
  const tree = await w.makeWorktree('fix-1')
  await w.makeWorktree('fix-2')
  const bound = await w.delegate({ ...CODER, worktree: 'frostyard/snosi/fix-1' })
  await finish(w, bound.child)
  const moved = await refusal(w.delegate({ ...CODER, task: 'Move.', to: bound.child, worktree: 'frostyard/snosi/fix-2' }))
  assert.match(moved, new RegExp(`child ${bound.child} is bound to worktree`))
  assert.ok(moved.includes(tree.path), moved)
  const unbound = await w.delegate({ ...CODER, title: 'unbound' })
  await finish(w, unbound.child)
  assert.match(await refusal(w.delegate({ ...CODER, task: 'Bind.', to: unbound.child, worktree: 'frostyard/snosi/fix-2' })), /isn't bound to a worktree, and a follow-up can't bind one/)
  // That is the reason whatever dish-workspaces could say: it isn't asked.
  const asked = w.resolveAsked.length
  assert.match(await refusal(w.delegate({ ...CODER, task: 'Bind.', to: unbound.child, worktree: 'frostyard/snosi/nope' })), /isn't bound to a worktree/)
  assert.equal(w.resolveAsked.length, asked)
  // A worktree nobody knows is refused as for a start.
  assert.match(await refusal(w.delegate({ ...CODER, task: 'x', to: bound.child, worktree: 'frostyard/snosi/nope' })), /no worktree `frostyard\/snosi\/nope`/)
  assert.equal(w.sends.length, 0)
})

test('a worktree dish made that fails dish\'s safety check is refused with why, and nothing starts', async () => {
  const w = await world()
  const why = 'frostyard/snosi\'s clone (/w/frostyard/snosi) failed dish\'s safety check: .git/config sets core.pager, which dish doesn\'t allow'
  w.problems.set('frostyard/snosi/fix-1', why)
  assert.equal(await refusal(w.delegate({ ...CODER, worktree: 'frostyard/snosi/fix-1' })),
    `worktree \`frostyard/snosi/fix-1\` can't be bound: ${why}. Nothing was started or sent; tell the user.`)
  // When dish-workspaces can't say why, the refusal is the one for a worktree it doesn't know.
  w.stub.resolveProblemFails = new Error('the state directory is unreadable')
  assert.match(await refusal(w.delegate({ ...CODER, worktree: 'frostyard/snosi/fix-1' })), /^no worktree `frostyard\/snosi\/fix-1` in a registered project/)
  assert.equal(w.starts.length, 0)
  assert.deepEqual(await w.records.children(SESSION), [])
})

test('a follow-up to a child whose worktree now fails dish\'s safety check is refused with why, not as gone', async () => {
  const w = await world()
  const tree = await w.makeWorktree('fix-1')
  const started = await w.delegate({ ...CODER, worktree: 'frostyard/snosi/fix-1' })
  await finish(w, started.child)
  w.worktrees.clear()
  const why = 'worktree fix-1 failed dish\'s safety check: .git does not point at a worktree of /w/frostyard/snosi'
  w.problems.set(tree.path, why)
  assert.equal(await refusal(w.delegate({ ...CODER, task: 'Fix it.', to: started.child })),
    `child ${started.child}'s worktree \`${tree.path}\` can't be used: ${why}. Nothing was sent; tell the user.`)
  assert.equal(w.sends.length, 0)
})

test('a follow-up to a child whose worktree is gone is refused, and so is one when dish-workspaces is not there to say', async () => {
  const w = await world()
  const tree = await w.makeWorktree('fix-1')
  const started = await w.delegate({ ...CODER, worktree: 'frostyard/snosi/fix-1' })
  await finish(w, started.child)
  // Merged and swept, or removed.
  w.worktrees.clear()
  assert.equal(await refusal(w.delegate({ ...CODER, task: 'Fix it.', to: started.child })),
    `child ${started.child}'s worktree \`${tree.path}\` is gone (merged or removed); start a new coder`)
  assert.equal(w.sends.length, 0)

  const records = new CrewRecords(await tempDir())
  const bound = await records.addChild(SESSION, { id: 'c1', role: 'coder', title: 't', model: 'claude-sonnet-5.5', family: 'anthropic', worktree: tree.path })
  await records.endRun(bound.id, { stopReason: 'completed', closing: 'x' })
  const without = await world({ workspaces: false, records })
  assert.match(await refusal(without.delegate({ ...CODER, task: 'Fix it.', to: 'c1' })), /dish-workspaces plugin is not running/)
  // A child that was never bound is told so, not that the plugin is missing.
  await records.addChild(SESSION, { id: 'c2', role: 'coder', title: 't', model: 'claude-sonnet-5.5', family: 'anthropic' })
  await records.endRun('c2', { stopReason: 'completed', closing: 'x' })
  const unbound = await refusal(without.delegate({ ...CODER, task: 'Bind.', to: 'c2', worktree: tree.path }))
  assert.match(unbound, /child c2 isn't bound to a worktree, and a follow-up can't bind one/)
  assert.doesNotMatch(unbound, /dish-workspaces/)
  assert.equal(without.sends.length, 0)
})

test('a follow-up to a bound child is refused while another running child is bound to its worktree', async () => {
  const w = await world()
  const tree = await w.makeWorktree('fix-1')
  const mine = await w.delegate({ ...CODER, worktree: 'frostyard/snosi/fix-1' })
  await finish(w, mine.child)
  // Another chat bound the worktree once this one's coder was done.
  await w.seed({ id: 'theirs', role: 'coder', title: 'their fix', worktree: tree.path }, 'running', 'session-other')
  assert.match(await refusal(w.delegate({ ...CODER, task: 'Fix it.', to: mine.child })), /is bound to coder «their fix» \(child theirs\)/)
  assert.equal(w.sends.length, 0)
  // A follow-up to a child that is itself running is not refused on its own account.
  await finish(w, 'theirs')
  w.agents.set(mine.child, { status: 'running' })
  await w.delegate({ ...CODER, task: 'One more thing.', to: mine.child })
  assert.equal(w.sends.length, 1)
})

// --- gates (6c): the brief's gate sentence, and a review that waits for the coder's gate ----------------------------

const GATE = 'pnpm typecheck && pnpm test'
/** How every refusal of the review check says to override it (step 7: `ruling`, of which `gateOverride` is the old name). */
const RULING_HINT = '`ruling: "Ruling: what — why — cost if wrong"`'
const LOG_3 = '/state/gates/frostyard/snosi/fix-1/c1-1-3.log'

/** The sentence a bound writer's brief (any role that writes but the coder) gains while dish-gates runs: 6c's. */
function gateSentence(gate: string): string {
  return ` When you finish, dish runs this project's gate (\`${gate}\`) in your worktree, and a failure comes back to you. `
    + 'If you\'re blocked, start your closing message with `BLOCKED: <question>` or `NEEDS CONTEXT: <what you need>`, and the gate is skipped.'
}

/** The sentence a bound coder's brief gains while dish-gates runs (step 7): a coder finishes with `report`. */
function reportGateSentence(gate: string): string {
  return ` When you finish with \`report\` and \`status: "done"\`, dish runs this project's gate (\`${gate}\`) in your worktree, and a failure comes back to you. `
    + 'If you\'re blocked, report `status: "blocked"` or `"needs_context"` with `blockedOn`, and the gate is skipped.'
}

/** A gate result as dish-gates records one: a pass in round 1 unless `over` says otherwise. */
function gateResult(over: Partial<GateResult> = {}): GateResult {
  return {
    turn: 1, round: 1, maxRounds: 3, outcome: 'passed', command: GATE, exitCode: 0, timedOut: false, durationMs: 4200,
    log: `/state/gates/frostyard/snosi/fix-1/c1-1-${over.round ?? 1}.log`, excerpt: '', at: 1, ...over,
  }
}

/** Every round of a turn failed: the last one is recorded and not steered, and the run ends with it. */
const FAILED_3 = [1, 2, 3].map(round => gateResult({ round, outcome: 'failed', exitCode: 1, excerpt: 'FAIL login.test.ts' }))
const SKIPPED = gateResult({ outcome: 'skipped', command: '', exitCode: null, durationMs: 0, log: null, reason: 'the coder reported BLOCKED / NEEDS CONTEXT' })

/** How the reviewer's block names the work it reviews. */
const REVIEWED = 'coder «add login», child c1'
/** Where the gate of a coder with no gate result stands. */
const NO_RESULT = 'no gate result: it didn\'t run (for example, the coder ran before gates were on)'

/**
 * Put coder `id` of this session in the record, bound to a worktree, with `gates` recorded during its run. With `ended`
 * (the default) its run is filed and its agent is idle; without, it is still running.
 */
async function boundCoder(w: World, id: string, gates: readonly GateResult[], ended = true): Promise<ChildRecord> {
  const record = await w.records.addChild(SESSION, {
    id, role: 'coder', title: 'add login', model: 'claude-sonnet-5.5', family: 'anthropic', worktree: join(w.workspace, '.worktrees', 'fix-1'),
  })
  for (const result of gates) assert.equal(await w.records.addGate(id, result), true)
  w.agents.set(id, { status: ended ? 'idle' : 'running' })
  if (ended) await w.records.endRun(id, { stopReason: 'completed', closing: 'done' })
  return record
}

/** The refusal of a review start whose reviewed coder c1's gate stands at `standing`, when it isn't running. */
function gateRefusal(standing: string): string {
  return `coder «add login» (child c1)'s gate hasn't passed (${standing}). Send it a fix round with \`to: "c1"\`, or start the review anyway with ${RULING_HINT}.`
}

test('worktreeBrief with a gate is 6b\'s block and then the gate sentence; without one it is 6b\'s, byte for byte', () => {
  const tree = { path: '/work/o/r/.worktrees/fix-1', branch: 'dish/fix-1' }
  assert.equal(worktreeBrief(tree), brief(tree.path, tree.branch))
  assert.equal(worktreeBrief(tree, undefined), brief(tree.path, tree.branch))
  assert.equal(worktreeBrief(tree, GATE), brief(tree.path, tree.branch) + gateSentence(GATE))
  assert.equal(worktreeBrief(tree, GATE, false), brief(tree.path, tree.branch) + gateSentence(GATE))
  // A gate with nothing in it is none.
  assert.equal(worktreeBrief(tree, ' '), brief(tree.path, tree.branch))
})

test('worktreeBrief for a child that reports (a coder): with a gate, the gate sentence speaks of report; without one, 6b\'s block', () => {
  const tree = { path: '/work/o/r/.worktrees/fix-1', branch: 'dish/fix-1' }
  assert.equal(worktreeBrief(tree, GATE, true), brief(tree.path, tree.branch) + reportGateSentence(GATE))
  assert.equal(worktreeBrief(tree, undefined, true), brief(tree.path, tree.branch))
  assert.equal(worktreeBrief(tree, ' ', true), brief(tree.path, tree.branch))
})

test('gateOverrideBrief tells the reviewer the gate hasn\'t passed, and the main agent\'s ruling, without its "Ruling:"', () => {
  assert.equal(gateOverrideBrief(REVIEWED, 'skipped: the coder reported BLOCKED / NEEDS CONTEXT', 'Ruling: x — y — z'),
    'The harness\'s gate for the work you review (coder «add login», child c1) hasn\'t passed: skipped: the coder reported BLOCKED / NEEDS CONTEXT. '
    + 'The main agent started this review anyway, with this ruling: x — y — z')
  for (const ruling of ['ruling: x — y — z', '  RULING :x — y — z', 'x — y — z']) {
    assert.ok(gateOverrideBrief(REVIEWED, 'failed', ruling).endsWith('with this ruling: x — y — z'), ruling)
  }
  // Only a leading one.
  assert.ok(gateOverrideBrief(REVIEWED, 'failed', 'x — Ruling: y — z').endsWith('with this ruling: x — Ruling: y — z'))
})

test('the ruling, gateOverride and final parameters and the description say what the checks are and how to rule past them', async () => {
  const w = await world()
  const parameters = w.tool.parameters as { properties: Record<string, { type: string, description: string }>, required: string[] }
  for (const name of ['ruling', 'gateOverride', 'final']) assert.ok(!parameters.required.includes(name), name)
  assert.equal(parameters.properties.ruling!.type, 'string')
  assert.equal(parameters.properties.ruling!.description, 'Only after delegate refused for want of one (a review of work whose gate hasn\'t passed, or a coder past round 4 of its task): '
    + 'your ruling, on one line, as `Ruling: what — why — cost if wrong`. It is recorded. Leave empty otherwise.')
  assert.equal(parameters.properties.gateOverride!.type, 'string')
  assert.equal(parameters.properties.gateOverride!.description, 'The old name of `ruling`, still accepted. Use `ruling`. Leave empty.')
  assert.equal(parameters.properties.final!.type, 'boolean')
  assert.equal(parameters.properties.final!.description, 'Reviewer role only: true makes this the run\'s final review, the one `open_pr` checks (its verdict must approve the head that is pushed). '
    + 'It stays final for its follow-ups, and a follow-up with true makes that reviewer final. Leave false otherwise.')
  assert.ok(w.tool.description.includes('While gates are on, a bound coder\'s work is gated when it reports done, and its finish notice says how the gate ended; '
    + 'a review of that work is refused until the gate passes, unless `ruling` carries your ruling. '
    + 'In a run, each coder start or follow-up on a task is a round: from round 5, delegate refuses more coder work on that task unless `ruling` carries your ruling. '
    + 'Set `final: true` on the reviewer of a run\'s final review.'), w.tool.description)
  assert.ok(w.tool.description.endsWith('Returns the child\'s id, role, model and label, and for a coder on a run\'s task the ladder\'s note.'), w.tool.description)
  assert.doesNotMatch(w.tool.description, /gateOverride/)
  // Agent-facing text names no plugin.
  assert.doesNotMatch(w.tool.description, /dish-gates|dish-orchestrator/)
})

test('a bound coder\'s brief names its project\'s gate while dish-gates runs: after the block, before the closing note', async () => {
  const w = await world({ dishGates: true })
  w.gates.set('frostyard/snosi', GATE)
  const tree = await w.makeWorktree('fix-1')
  await w.delegate({ ...CODER, worktree: 'frostyard/snosi/fix-1' })
  assert.deepEqual(w.gateAsked, ['frostyard/snosi'])
  assert.deepEqual(w.starts[0]!.request.prompt, [
    { type: 'text', text: CODER.task + BLOCK_END },
    { type: 'text', text: brief(tree.path, 'dish/fix-1') + reportGateSentence(GATE) + BLOCK_END },
    { type: 'text', text: REPORT_NOTE + BLOCK_END },
  ])
  // An unbound coder gets no block, and dish-gates isn't asked.
  await finish(w, String(w.starts[0]!.childId))
  await w.delegate({ ...CODER, title: 'unbound' })
  assert.deepEqual(w.starts[1]!.request.prompt, [{ type: 'text', text: CODER.task + BLOCK_END }, { type: 'text', text: REPORT_NOTE + BLOCK_END }])
  assert.deepEqual(w.gateAsked, ['frostyard/snosi'])
})

test('a credential in the gate dish-gates gives is masked in the coder\'s brief', async () => {
  const w = await world({ dishGates: true })
  const token = `ghs_${'A1b2C3d4E5'.repeat(4)}`
  w.gates.set('frostyard/snosi', `GH_TOKEN=${token} pnpm test`)
  const tree = await w.makeWorktree('fix-1')
  await w.delegate({ ...CODER, worktree: 'frostyard/snosi/fix-1' })
  assert.deepEqual(w.starts[0]!.request.prompt[1], { type: 'text', text: brief(tree.path, 'dish/fix-1') + reportGateSentence(`GH_TOKEN=${maskSecrets(token)} pnpm test`) + BLOCK_END })
  assert.ok(!JSON.stringify(w.starts[0]!.request.prompt).includes(token))
})

test('with dish-gates, a bound writer\'s brief keeps 6c\'s gate sentence and its closing note: only a coder finishes with report', async () => {
  const w = await world({ dishGates: true })
  w.gates.set('frostyard/snosi', GATE)
  const tree = await w.makeWorktree('docs-1')
  await w.delegate({ role: 'writer', title: 'write docs', task: 'Write.', worktree: 'frostyard/snosi/docs-1' })
  assert.deepEqual(w.starts[0]!.request.prompt, [
    { type: 'text', text: 'Write.' + BLOCK_END },
    { type: 'text', text: brief(tree.path, 'dish/docs-1') + gateSentence(GATE) + BLOCK_END },
    { type: 'text', text: CLOSING_NOTE + BLOCK_END },
  ])
})

test('without a gate to name, the brief is 6b\'s: no dish-gates, a project it has no gate for, and a gateFor that throws', async () => {
  const without = await world()
  const tree = await without.makeWorktree('fix-1')
  await without.delegate({ ...CODER, worktree: 'frostyard/snosi/fix-1' })
  assert.deepEqual(without.starts[0]!.request.prompt[1], { type: 'text', text: brief(tree.path, 'dish/fix-1') + BLOCK_END })

  const w = await world({ dishGates: true })
  const other = await w.makeWorktree('fix-1')
  const first = await w.delegate({ ...CODER, worktree: 'frostyard/snosi/fix-1' })
  assert.deepEqual(w.starts[0]!.request.prompt[1], { type: 'text', text: brief(other.path, 'dish/fix-1') + BLOCK_END })
  await finish(w, first.child)
  const logs = watchLogs(w.ctx)
  w.gates.set('frostyard/snosi', GATE)
  w.stub.gateForFails = new Error('projects.yaml is unreadable')
  const second = await w.delegate({ ...CODER, title: 'again', worktree: 'frostyard/snosi/fix-1' })
  assert.deepEqual(w.starts[1]!.request.prompt, [
    { type: 'text', text: CODER.task + BLOCK_END },
    { type: 'text', text: brief(other.path, 'dish/fix-1') + BLOCK_END },
    { type: 'text', text: REPORT_NOTE + BLOCK_END },
  ])
  assert.equal((await w.records.lookup(second.child))?.record.worktree, other.path)
  assert.ok(logs.some(line => /projects\.yaml is unreadable/.test(line)), logs.join('\n'))
})

test('a review of a bound coder whose gate hasn\'t passed is refused, saying why and how to go on, and nothing starts', async () => {
  const cases: Array<[string, GateResult[], string]> = [
    ['failed in its last round', FAILED_3, `failed, round 3 of 3; log ${LOG_3}`],
    ['failed with rounds to spare: the run ended another way', [FAILED_3[0]!], 'failed, round 1 of 3; log /state/gates/frostyard/snosi/fix-1/c1-1-1.log'],
    ['failed with no log', [gateResult({ outcome: 'failed', exitCode: 2, round: 3, log: null })], 'failed, round 3 of 3'],
    ['skipped', [SKIPPED], 'skipped: the coder reported BLOCKED / NEEDS CONTEXT'],
    ['not run', [gateResult({ outcome: 'error', command: '', exitCode: null, durationMs: 0, log: null, reason: 'dsh\'s shell here doesn\'t sandbox commands, so dish won\'t run the gate' })],
      'error: dsh\'s shell here doesn\'t sandbox commands, so dish won\'t run the gate'],
    ['no result: the run ended before its turn could', [], NO_RESULT],
  ]
  for (const [what, gates, standing] of cases) {
    const w = await world({ dishGates: true })
    await boundCoder(w, 'c1', gates)
    assert.equal(await refusal(w.delegate({ ...REVIEW, reviews: 'c1' })), gateRefusal(standing), what)
    // An empty override is none, as for every optional parameter.
    assert.equal(await refusal(w.delegate({ ...REVIEW, reviews: 'c1', gateOverride: ' \n ' })), gateRefusal(standing), what)
    assert.equal(w.starts.length, 0, what)
    assert.deepEqual((await w.records.children(SESSION)).map(child => child.id), ['c1'], what)
  }
})

test('a review of a bound coder that is still running is refused, saying to wait for its notice or rule', async () => {
  const w = await world({ dishGates: true })
  // Its gate has passed, and its turn hasn't closed yet: the run isn't over, so it can still change the work.
  await boundCoder(w, 'c1', [gateResult()], false)
  assert.equal(await refusal(w.delegate({ ...REVIEW, reviews: 'c1' })),
    'coder «add login» (child c1)\'s gate hasn\'t passed (it is still running). Wait for its finish notice, which says how its gate ended, '
    + `and delegate the review then, or start the review anyway with ${RULING_HINT}.`)
  assert.equal(w.starts.length, 0)
  // With a ruling it starts, and the reviewer is told the coder was still running.
  const ruling = 'Ruling: review the plan so far — it is a draft — findings on code that changes'
  const result = await w.delegate({ ...REVIEW, reviews: 'c1', gateOverride: ruling })
  assert.deepEqual(w.starts[0]!.request.prompt[1], { type: 'text', text: gateOverrideBrief(REVIEWED, 'it is still running', ruling) + BLOCK_END })
  assert.equal((await w.records.lookup(result.child))?.record.gateOverride, ruling)
})

test('the latest run is what counts: an older run\'s pass doesn\'t cover a newer run, even one dsh stopped before it ended', async () => {
  const w = await world({ dishGates: true })
  await boundCoder(w, 'c1', [gateResult()])
  // A fix round whose gate failed in every round.
  await w.records.addFollowUp('c1')
  for (const result of FAILED_3) await w.records.addGate('c1', { ...result, turn: 2 })
  await w.records.endRun('c1', { stopReason: 'completed', closing: 'done' })
  assert.equal(await refusal(w.delegate({ ...REVIEW, reviews: 'c1' })), gateRefusal(`failed, round 3 of 3; log ${LOG_3}`))

  // Another, and dsh stopped mid-run (a restart): the record says running, there is no agent, and nothing was recorded for it.
  const restarted = await world({ dishGates: true })
  await boundCoder(restarted, 'c1', [gateResult()])
  await restarted.records.addFollowUp('c1')
  restarted.agents.delete('c1')
  assert.equal(await refusal(restarted.delegate({ ...REVIEW, reviews: 'c1' })), gateRefusal(NO_RESULT))
  // What was recorded of that run before it stopped is its result.
  await restarted.records.addGate('c1', { ...FAILED_3[0]!, turn: 2 })
  assert.equal(await refusal(restarted.delegate({ ...REVIEW, reviews: 'c1' })), gateRefusal('failed, round 1 of 3; log /state/gates/frostyard/snosi/fix-1/c1-1-1.log'))
  assert.equal(w.starts.length + restarted.starts.length, 0)
})

test('a pass counts only when its run ended completed: a run that ended another way after it, or that dsh stopped, hasn\'t passed', async () => {
  for (const reason of ['aborted', 'error', 'max-tokens']) {
    const w = await world({ dishGates: true })
    // The gate passed; a follow-up steered into the same turn had the coder edit more, and the turn then ended abnormally.
    await boundCoder(w, 'c1', [gateResult()], false)
    w.agents.set('c1', { status: 'idle' })
    await w.records.endRun('c1', { stopReason: reason, closing: 'done' })
    const standing = `the run ended (${reason}) after its gate passed, so any work after the gate wasn't gated`
    assert.equal(await refusal(w.delegate({ ...REVIEW, reviews: 'c1' })), gateRefusal(standing), reason)
    assert.equal(w.starts.length, 0, reason)
    // A ruling starts it, and the reviewer is told where the gate stands.
    const ruling = 'Ruling: review it anyway — the run was stopped by hand — a missed bug'
    await w.delegate({ ...REVIEW, reviews: 'c1', gateOverride: ruling })
    assert.deepEqual(w.starts[0]!.request.prompt[1], { type: 'text', text: gateOverrideBrief(REVIEWED, standing, ruling) + BLOCK_END }, reason)
  }

  // dsh stopped mid-run (a restart) after the gate passed: the record says running, there is no agent, and the pass is on
  // the run that never ended.
  const restarted = await world({ dishGates: true })
  await boundCoder(restarted, 'c1', [gateResult()], false)
  restarted.agents.delete('c1')
  assert.equal(await refusal(restarted.delegate({ ...REVIEW, reviews: 'c1' })),
    gateRefusal('dsh stopped the run after its gate passed, so any work after the gate wasn\'t gated'))
  assert.equal(restarted.starts.length, 0)
})

test('a review after the gate passed starts as before, and an override given is ignored and not recorded', async () => {
  const w = await world({ dishGates: true })
  // Failed once, fixed, passed: the latest result is the one that counts.
  await boundCoder(w, 'c1', [FAILED_3[0]!, gateResult({ round: 2 })])
  const result = await w.delegate({ ...REVIEW, reviews: 'c1' })
  assert.deepEqual(w.starts[0]!.request.prompt, [{ type: 'text', text: REVIEW.task + BLOCK_END }, { type: 'text', text: REPORT_NOTE + BLOCK_END }])
  assert.ok(!('gateOverride' in (await w.records.lookup(result.child))!.record))
  // Not even a ruling with nothing in it is refused when there is nothing to override.
  await finish(w, result.child)
  const again = await w.delegate({ ...REVIEW, title: 'again', reviews: 'c1', gateOverride: 'Ruling:' })
  assert.deepEqual(w.starts[1]!.request.prompt, [{ type: 'text', text: REVIEW.task + BLOCK_END }, { type: 'text', text: REPORT_NOTE + BLOCK_END }])
  assert.ok(!('gateOverride' in (await w.records.lookup(again.child))!.record))
})

test('a review with a ruling starts: the ruling, on one line, is recorded and told to the reviewer before the closing note', async () => {
  const w = await world({ dishGates: true })
  await boundCoder(w, 'c1', FAILED_3)
  const result = await w.delegate({ ...REVIEW, reviews: 'c1', gateOverride: '  Ruling: review it anyway —\n  the failure is a flaky\ttest —\r\n a missed bug  ' })
  const ruling = 'Ruling: review it anyway — the failure is a flaky test — a missed bug'
  assert.deepEqual(w.starts[0]!.request.prompt, [
    { type: 'text', text: REVIEW.task + BLOCK_END },
    { type: 'text', text: gateOverrideBrief(REVIEWED, `failed, round 3 of 3; log ${LOG_3}`, ruling) + BLOCK_END },
    { type: 'text', text: REPORT_NOTE + BLOCK_END },
  ])
  const recorded = (await w.records.lookup(result.child))!.record
  assert.equal(recorded.gateOverride, ruling)
  assert.equal(recorded.reviews, 'c1')
  // Recorded before the start, as the rest of the child is.
  assert.equal(w.recordedAtStart.get(result.child)?.gateOverride, ruling)
  // The word "Ruling:" isn't required: the ruling is.
  await finish(w, result.child)
  const plain = await w.delegate({ ...REVIEW, title: 'again', reviews: 'c1', gateOverride: 'the failure is a flaky test — a missed bug' })
  assert.equal((await w.records.lookup(plain.child))!.record.gateOverride, 'the failure is a flaky test — a missed bug')
})

test('an override with no ruling in it is refused, with what a ruling is and how to go on', async () => {
  const w = await world({ dishGates: true })
  await boundCoder(w, 'c1', [SKIPPED])
  // The placeholder the refusal shows is no ruling either, with or without `Ruling:`, in any case, however it is spaced.
  const placeholders = ['Ruling: what — why — cost if wrong', 'what — why — cost if wrong', '  RULING:  What —\n why —  Cost if wrong ', 'What — Why — Cost If Wrong']
  for (const blank of ['Ruling:', '  ruling:  ', 'Ruling: — —', 'RULING:\n', ...placeholders]) {
    assert.equal(await refusal(w.delegate({ ...REVIEW, reviews: 'c1', gateOverride: blank })),
      `ruling needs the ruling itself: what — why — cost if wrong. ${gateRefusal('skipped: the coder reported BLOCKED / NEEDS CONTEXT')}`, JSON.stringify(blank))
  }
  assert.equal(w.starts.length, 0)
})

test('not checked: an unbound coder, reviews "main", any review while dish-gates isn\'t running, and a role that doesn\'t review', async () => {
  const w = await world({ dishGates: true })
  // An unbound coder has no gate.
  await w.seed({ id: 'u1', role: 'coder', last: 'finished' }, 'idle')
  const unbound = await w.delegate({ ...REVIEW, reviews: 'u1', gateOverride: 'Ruling: x — y — z' })
  assert.deepEqual(w.starts[0]!.request.prompt, [{ type: 'text', text: REVIEW.task + BLOCK_END }, { type: 'text', text: REPORT_NOTE + BLOCK_END }])
  assert.ok(!('gateOverride' in (await w.records.lookup(unbound.child))!.record))
  await finish(w, unbound.child)
  // The main agent's own work.
  const main = await w.delegate({ ...REVIEW, title: 'review mine', reviews: 'main', gateOverride: 'Ruling: x — y — z' })
  assert.deepEqual(w.starts[1]!.request.prompt, [{ type: 'text', text: REVIEW.task + BLOCK_END }, { type: 'text', text: REPORT_NOTE + BLOCK_END }])
  assert.ok(!('gateOverride' in (await w.records.lookup(main.child))!.record))
  // A coder's start with an override: there is no review to override.
  await finish(w, main.child)
  const coder = await w.delegate({ ...CODER, gateOverride: 'Ruling: x — y — z' })
  assert.ok(!('gateOverride' in (await w.records.lookup(coder.child))!.record))
  assert.equal(w.gateAsked.length, 0)

  // Without dish-gates nothing is gated, so nothing is checked: a bound coder whose gate failed, or that is running, is reviewed.
  const off = await world()
  await boundCoder(off, 'c1', FAILED_3)
  const failed = await off.delegate({ ...REVIEW, reviews: 'c1', gateOverride: 'Ruling:' })
  assert.deepEqual(off.starts[0]!.request.prompt, [{ type: 'text', text: REVIEW.task + BLOCK_END }, { type: 'text', text: REPORT_NOTE + BLOCK_END }])
  assert.ok(!('gateOverride' in (await off.records.lookup(failed.child))!.record))
  await boundCoder(off, 'c2', [], false)
  await off.delegate({ ...REVIEW, title: 'review c2', reviews: 'c2' })
  assert.equal(off.starts.length, 2)
})

test('a re-review (a follow-up to a reviewer, with to) is checked the same way: refused, then sent with a ruling', async () => {
  const w = await world({ dishGates: true })
  await boundCoder(w, 'c1', [gateResult()])
  const reviewer = await w.delegate({ ...REVIEW, reviews: 'c1' })
  await finish(w, reviewer.child)
  // The coder's fix round, whose gate then failed in every round.
  await w.records.addFollowUp('c1')
  for (const result of FAILED_3) await w.records.addGate('c1', { ...result, turn: 2 })
  await w.records.endRun('c1', { stopReason: 'completed', closing: 'done' })

  const standing = `failed, round 3 of 3; log ${LOG_3}`
  const body = `coder «add login» (child c1)'s gate hasn't passed (${standing}). Send that coder a fix round with \`to: "c1"\`, or send this follow-up anyway with ${RULING_HINT}.`
  const lead = `can't send a follow-up to reviewer child ${reviewer.child}:`
  const again = { ...REVIEW, task: 'Review the fix.', to: reviewer.child }
  assert.equal(await refusal(w.delegate(again)), `${lead} ${body}`)
  assert.equal(await refusal(w.delegate({ ...again, gateOverride: '' })), `${lead} ${body}`)
  assert.equal(await refusal(w.delegate({ ...again, gateOverride: 'Ruling:' })), `ruling needs the ruling itself: what — why — cost if wrong. ${lead} ${body}`)
  assert.equal(await refusal(w.delegate({ ...again, ruling: 'Ruling:' })), `ruling needs the ruling itself: what — why — cost if wrong. ${lead} ${body}`)
  assert.equal(w.sends.length, 0)
  assert.equal((await w.records.lookup(reviewer.child))!.record.followUps, 0)

  const ruling = 'Ruling: re-review anyway — the failing test is unrelated — a missed regression'
  await w.delegate({ ...again, gateOverride: `${ruling}\n` })
  assert.equal(w.sends.length, 1)
  assert.deepEqual(w.sends[0]!.content, [{ type: 'text', text: 'Review the fix.' + BLOCK_END }, { type: 'text', text: gateOverrideBrief(REVIEWED, standing, ruling) }])
  const record = (await w.records.lookup(reviewer.child))!.record
  assert.equal(record.gateOverride, ruling)
  assert.equal(record.followUps, 1)

  // Once the coder's gate passes, a re-review is sent as before: the override is ignored, and the ruling on record stays.
  await finish(w, reviewer.child)
  await w.records.addFollowUp('c1')
  await w.records.addGate('c1', gateResult({ turn: 3 }))
  await w.records.endRun('c1', { stopReason: 'completed', closing: 'done' })
  await w.delegate({ ...again, task: 'Once more.', gateOverride: 'Ruling: a — b — c' })
  assert.deepEqual(w.sends[1]!.content, [{ type: 'text', text: 'Once more.' }])
  assert.equal((await w.records.lookup(reviewer.child))!.record.gateOverride, ruling)
})

test('a ruling given on a re-review carries over to the next re-review, until the coder runs again', async () => {
  const w = await world({ dishGates: true })
  const pause = () => new Promise(resolve => setTimeout(resolve, 10))
  await boundCoder(w, 'c1', [gateResult()])
  // t0: the reviewer is made, on a coder whose gate passed: no ruling.
  await pause()
  const reviewer = await w.delegate({ ...REVIEW, reviews: 'c1' })
  await finish(w, reviewer.child)
  // t1: the coder's fix round fails its gate in every round.
  await pause()
  await w.records.addFollowUp('c1')
  for (const result of FAILED_3) await w.records.addGate('c1', { ...result, turn: 2 })
  await w.records.endRun('c1', { stopReason: 'completed', closing: 'done' })
  const standing = `failed, round 3 of 3; log ${LOG_3}`
  const again = { ...REVIEW, task: 'Review the fix.', to: reviewer.child }
  // t2: a re-review with a ruling.
  await pause()
  const ruling = 'Ruling: re-review anyway — the failing test is unrelated — a missed regression'
  await w.delegate({ ...again, gateOverride: ruling })
  await finish(w, reviewer.child)
  // t3: a second re-review with no new ruling: the coder hasn't run since the ruling, so it stands.
  await pause()
  await w.delegate({ ...again, task: 'Once more.' })
  assert.equal(w.sends.length, 2)
  assert.deepEqual(w.sends[1]!.content, [{ type: 'text', text: 'Once more.' + BLOCK_END }, { type: 'text', text: gateOverrideBrief(REVIEWED, standing, ruling) }])
  await finish(w, reviewer.child)
  // The coder runs again, and fails again: the ruling was on the work before, so it no longer stands.
  await pause()
  await w.records.addFollowUp('c1')
  await w.records.addGate('c1', { ...FAILED_3[2]!, turn: 3 })
  await w.records.endRun('c1', { stopReason: 'completed', closing: 'done' })
  assert.match(await refusal(w.delegate({ ...again, task: 'And again.' })), /gate hasn't passed \(failed, round 3 of 3/)
  assert.equal(w.sends.length, 2)
})

test('a re-review of the main agent\'s own work, or of an unbound coder, is not checked', async () => {
  const w = await world({ dishGates: true })
  const mine = await w.delegate({ ...REVIEW, reviews: 'main' })
  await finish(w, mine.child)
  await w.delegate({ ...REVIEW, task: 'Again.', to: mine.child, gateOverride: 'Ruling:' })
  assert.deepEqual(w.sends[0]!.content, [{ type: 'text', text: 'Again.' }])
  await w.seed({ id: 'u1', role: 'coder', last: 'finished' }, 'idle')
  const theirs = await w.delegate({ ...REVIEW, title: 'review u1', reviews: 'u1' })
  await finish(w, theirs.child)
  await w.delegate({ ...REVIEW, task: 'Again.', to: theirs.child })
  assert.equal(w.sends.length, 2)
  assert.ok(!('gateOverride' in (await w.records.lookup(theirs.child))!.record))
})

test('a re-review keeps the reviewer\'s ruling while the coder hasn\'t run since the reviewer was made, and not once it has', async () => {
  const w = await world({ dishGates: true })
  await boundCoder(w, 'c1', [SKIPPED])
  // The reviewer is made after the coder's run ended.
  await new Promise(resolve => setTimeout(resolve, 10))
  const ruling = 'Ruling: review it anyway — the task answers its question — a missed bug'
  const reviewer = await w.delegate({ ...REVIEW, reviews: 'c1', gateOverride: ruling })
  await finish(w, reviewer.child)
  const standing = 'skipped: the coder reported BLOCKED / NEEDS CONTEXT'

  // No new ruling: the one on record stands, and the reviewer is told it again.
  await w.delegate({ ...REVIEW, task: 'Look again at the form.', to: reviewer.child })
  assert.deepEqual(w.sends[0]!.content, [{ type: 'text', text: 'Look again at the form.' + BLOCK_END }, { type: 'text', text: gateOverrideBrief(REVIEWED, standing, ruling) }])
  let record = (await w.records.lookup(reviewer.child))!.record
  assert.equal(record.gateOverride, ruling)
  assert.equal(record.followUps, 1)
  // A new ruling replaces it.
  await finish(w, reviewer.child)
  const newer = 'Ruling: once more — the form changed little — a missed bug'
  await w.delegate({ ...REVIEW, task: 'Once more.', to: reviewer.child, gateOverride: newer })
  assert.deepEqual(w.sends[1]!.content, [{ type: 'text', text: 'Once more.' + BLOCK_END }, { type: 'text', text: gateOverrideBrief(REVIEWED, standing, newer) }])
  record = (await w.records.lookup(reviewer.child))!.record
  assert.equal(record.gateOverride, newer)
  await finish(w, reviewer.child)

  // The coder runs again (a fix round): the ruling was about the work before it, so it no longer stands.
  const lead = `can't send a follow-up to reviewer child ${reviewer.child}:`
  const again = { ...REVIEW, task: 'Review the fix.', to: reviewer.child }
  await w.records.addFollowUp('c1')
  assert.match(await refusal(w.delegate(again)), /\(it is still running\)\. Wait for its finish notice/)
  // dsh stopped it mid-run (a restart): the record says running, and there is no agent.
  w.agents.delete('c1')
  assert.equal(await refusal(w.delegate(again)),
    `${lead} coder «add login» (child c1)'s gate hasn't passed (${NO_RESULT}). Send that coder a fix round with \`to: "c1"\`, or send this follow-up anyway with ${RULING_HINT}.`)
  // Its run ends, skipped again.
  w.agents.set('c1', { status: 'idle' })
  await w.records.addGate('c1', { ...SKIPPED, turn: 2 })
  await w.records.endRun('c1', { stopReason: 'completed', closing: 'BLOCKED: which form?' })
  assert.equal(await refusal(w.delegate(again)),
    `${lead} coder «add login» (child c1)'s gate hasn't passed (${standing}). Send that coder a fix round with \`to: "c1"\`, or send this follow-up anyway with ${RULING_HINT}.`)
  assert.equal(w.sends.length, 2)
  assert.equal((await w.records.lookup(reviewer.child))!.record.followUps, 2)

  // A reviewer started while the coder was still running: the coder's run ended after the reviewer was made.
  const early = await world({ dishGates: true })
  await boundCoder(early, 'c1', [], false)
  const started = await early.delegate({ ...REVIEW, reviews: 'c1', gateOverride: ruling })
  await finish(early, started.child)
  early.agents.set('c1', { status: 'idle' })
  await early.records.addGate('c1', FAILED_3[2]!)
  await early.records.endRun('c1', { stopReason: 'completed', closing: 'done' })
  assert.match(await refusal(early.delegate({ ...REVIEW, task: 'Again.', to: started.child })), /gate hasn't passed \(failed, round 3 of 3/)
  assert.equal(early.sends.length, 0)
})

// --- dish-crew/delegated and dish-crew/settled (step 7) ----------------------------------------------

test('a start publishes dish-crew/delegated once, with the recorded child, before dsh starts it', async () => {
  const w = await world()
  const heard: Array<{ event: CrewDelegated, found: ChildRecord | undefined, starts: number }> = []
  w.ctx.on('dish-crew/delegated', async (event) => {
    const found = (await w.records.lookup(event.child.id))?.record
    heard.push({ event, found, starts: w.starts.length })
  })
  const result = await w.delegate(CODER)
  assert.equal(heard.length, 1)
  const [{ event, found, starts }] = heard as [typeof heard[0]]
  assert.equal(event.sessionId, SESSION)
  assert.equal(event.followUp, false)
  assert.equal(event.child.id, result.child)
  assert.equal(event.child.role, 'coder')
  assert.deepEqual(event.child, found)
  assert.deepEqual(event.child, (await w.records.lookup(result.child))?.record)
  assert.equal(starts, 0, 'dsh hadn\'t started the child yet')
  assert.equal(w.starts.length, 1)
})

test('a dish-crew/delegated listener held on a promise holds delegate\'s answer, and dsh\'s start', async () => {
  const w = await world()
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  w.ctx.on('dish-crew/delegated', () => held)
  let answered = false
  const answer = w.delegate(CODER).then((value) => {
    answered = true
    return value
  })
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(answered, false)
  assert.equal(w.starts.length, 0)
  release()
  await answer
  assert.equal(w.starts.length, 1)
})

test('a follow-up publishes dish-crew/delegated with followUp: true and the counted child', async () => {
  const w = await world()
  const started = await w.delegate(CODER)
  w.agents.set(started.child, { status: 'idle' })
  await w.records.endRun(started.child, { stopReason: 'completed', closing: 'done' })
  const heard: CrewDelegated[] = []
  w.ctx.on('dish-crew/delegated', (event) => { heard.push(event) })
  await w.delegate({ role: 'coder', task: 'Fix the findings.', to: started.child })
  assert.equal(heard.length, 1)
  const [event] = heard as [CrewDelegated]
  assert.equal(event.followUp, true)
  assert.equal(event.sessionId, SESSION)
  assert.equal(event.child.id, started.child)
  assert.equal(event.child.followUps, 1)
  assert.equal(event.child.last, 'running')
  assert.deepEqual(event.child, (await w.records.lookup(started.child))?.record)
  assert.equal(w.sends.length, 1)
})

test('a follow-up whose count can\'t be recorded or read back still publishes, with the child as it would be', async () => {
  const w = await world()
  const logs = watchLogs(w.ctx)
  const started = await w.delegate(RESEARCHER)
  w.agents.set(started.child, { status: 'idle' })
  await w.records.endRun(started.child, { stopReason: 'completed', closing: 'x' })
  const before = (await w.records.lookup(started.child))!.record
  const records = w.records as { addFollowUp: unknown, lookup: unknown }
  records.addFollowUp = async () => {
    records.lookup = async () => { throw new Error('disk gone') }
    throw new Error('disk full')
  }
  const heard: CrewDelegated[] = []
  w.ctx.on('dish-crew/delegated', (event) => { heard.push(event) })
  await w.delegate({ ...RESEARCHER, to: started.child })
  assert.deepEqual(heard.map(event => event.child), [{ ...before, followUps: 1, last: 'running' }])
  assert.equal(heard[0]!.followUp, true)
  assert.ok(logs.some(line => /disk full/.test(line)), logs.join('\n'))
})

test('a start dsh refuses publishes dish-crew/delegated, then dish-crew/settled for the failed run', async () => {
  const w = await world()
  const events: string[] = []
  let settled: CrewSettled | undefined
  w.ctx.on('dish-crew/delegated', (event) => { events.push(`delegated ${event.child.id}`) })
  w.ctx.on('dish-crew/settled', (event) => {
    events.push(`settled ${event.child.id}`)
    settled = event
  })
  w.stub.startFails = new Error('provider spawn is down')
  await refusal(w.delegate(CODER))
  const [child] = await w.records.children(SESSION)
  assert.deepEqual(events, [`delegated ${child!.id}`, `settled ${child!.id}`])
  assert.equal(settled!.sessionId, SESSION)
  assert.equal(settled!.run.stopReason, 'error')
  assert.equal(settled!.run.error, 'provider spawn is down')
  assert.deepEqual(settled!.child, child)
  assert.equal(settled!.child.last, 'failed')
  assert.deepEqual(settled!.run, child!.runs.at(-1))
})

test('a refusal at the limits publishes nothing', async () => {
  const w = await world()
  await w.delegate(CODER)
  const heard: string[] = []
  w.ctx.on('dish-crew/delegated', () => { heard.push('delegated') })
  w.ctx.on('dish-crew/settled', () => { heard.push('settled') })
  assert.match(await refusal(w.delegate({ role: 'ops', title: 'deploy it', task: 'Deploy.' })), /^a coder is running/)
  assert.deepEqual(heard, [])
})

test('a dish-crew/delegated listener that throws is logged, and the delegation stands', async () => {
  const w = await world()
  const logs = watchLogs(w.ctx)
  w.ctx.on('dish-crew/delegated', () => { throw new Error('the ledger is full') })
  const result = await w.delegate(CODER)
  assert.equal(w.starts.length, 1)
  assert.equal((await w.records.lookup(result.child))?.record.id, result.child)
  assert.ok(logs.includes('[dish-crew] warn: a dish-crew/delegated listener failed: the ledger is full'), logs.join('\n'))
})

// --- step 7: ruling, final, run tags and the escalation ladder -----------------------------------------

/** A run's ref, as dish-orchestrator's `place` gives it. */
const RUN = 'frostyard/snosi/20261003-fix-1'
/** A coder bound to worktree fix-1. */
const BOUND = { ...CODER, worktree: 'frostyard/snosi/fix-1' }
const TOKEN = `ghp_${'A1b2C3d4E5'.repeat(4)}`
const NO_RUN = '`final` had no effect: this chat drives no run, so there is no final review for `open_pr` to read.'
const NO_ORCHESTRATOR = '`final` had no effect: dish keeps no runs here (dish-orchestrator isn\'t loaded).'
const FINAL_OTHER_RUN = '`final` had no effect: this reviewer was started outside the run this chat drives now, so start a fresh reviewer with `final: true` for that run\'s final review.'
const UNPLACED = '`final` had no effect: dish couldn\'t place this reviewer in a run, so `final` wasn\'t recorded; try again with a fresh reviewer and `final: true`; '
  + 'if it is bound to a closed run\'s worktree, `run` `resume` that run first.'

/** The ladder's refusal of more coder work on task `task` at `round`, as the plan words it. */
function ladderRefusal(round: number, task = 'fix-1'): string {
  return `round ${round} of task \`${task}\`: the escalation ladder ends at round 4, so delegate won't send more coder work on this task without your ruling. `
    + 'Rule with `ruling: "Ruling: what — why — cost if wrong"` (it is recorded), or stop and tell the user (`run` action `abandon`, with a reason, only if they drop the change).'
}

/** A world with dish-orchestrator's stub and worktree fix-1, which `place` puts in run RUN as task fix-1 at `round.current`. */
async function ladderWorld(options: Options = {}): Promise<{ w: World, tree: Worktree, round: { current: number } }> {
  const w = await world({ runs: true, ...options })
  const tree = await w.makeWorktree('fix-1')
  const round = { current: 0 }
  w.placements.set(`${SESSION}|${tree.path}|`, () => ({ run: RUN, task: 'fix-1', round: round.current }))
  return { w, tree, round }
}

/** The record of child `id`. */
async function recordOf(w: World, id: string): Promise<ChildRecord> {
  const found = await w.records.lookup(id)
  assert.ok(found, `child ${id} is recorded`)
  return found.record
}

// The ruling.

test('ruling: a review refused for its gate starts with ruling, which is recorded as gateOverride and told to the reviewer', async () => {
  const w = await world({ dishGates: true })
  await boundCoder(w, 'c1', FAILED_3)
  const standing = `failed, round 3 of 3; log ${LOG_3}`
  assert.equal(await refusal(w.delegate({ ...REVIEW, reviews: 'c1' })), gateRefusal(standing))
  const ruling = 'Ruling: review it anyway — the failure is a flaky test — a missed bug'
  const result = await w.delegate({ ...REVIEW, reviews: 'c1', ruling: `  ${ruling.replace(' — the', ' —\n the')}\n` })
  assert.deepEqual(w.starts[0]!.request.prompt, [
    { type: 'text', text: REVIEW.task + BLOCK_END },
    { type: 'text', text: gateOverrideBrief(REVIEWED, standing, ruling) + BLOCK_END },
    { type: 'text', text: REPORT_NOTE + BLOCK_END },
  ])
  assert.equal((await recordOf(w, result.child)).gateOverride, ruling)
  assert.equal(w.recordedAtStart.get(result.child)?.gateOverride, ruling)
})

test('ruling: gateOverride alone still works, and when ruling is given it wins and gateOverride is ignored', async () => {
  const w = await world({ dishGates: true })
  await boundCoder(w, 'c1', FAILED_3)
  const old = 'Ruling: the old name — it is still accepted — none'
  const first = await w.delegate({ ...REVIEW, reviews: 'c1', gateOverride: old })
  assert.equal((await recordOf(w, first.child)).gateOverride, old)
  const ruling = 'Ruling: the new name — it wins — none'
  const second = await w.delegate({ ...REVIEW, title: 'again', reviews: 'c1', ruling, gateOverride: old })
  assert.equal((await recordOf(w, second.child)).gateOverride, ruling)
  // An empty ruling is none, so gateOverride counts; a ruling with nothing in it is still given, so gateOverride doesn't.
  const third = await w.delegate({ ...REVIEW, title: 'third', reviews: 'c1', ruling: ' ', gateOverride: old })
  assert.equal((await recordOf(w, third.child)).gateOverride, old)
  assert.match(await refusal(w.delegate({ ...REVIEW, title: 'fourth', reviews: 'c1', ruling: 'Ruling:', gateOverride: old })), /^ruling needs the ruling itself: /)
  assert.equal(w.starts.length, 3)
})

test('ruling: a credential in a ruling is masked on the record and in the reviewer\'s brief', async () => {
  const w = await world({ dishGates: true })
  await boundCoder(w, 'c1', FAILED_3)
  const given = `Ruling: review it anyway — the log printed ${TOKEN} — a leaked token`
  const result = await w.delegate({ ...REVIEW, reviews: 'c1', ruling: given })
  const recorded = (await recordOf(w, result.child)).gateOverride
  assert.equal(recorded, maskSecrets(given))
  assert.notEqual(recorded, given)
  assert.ok(!JSON.stringify(w.starts[0]!.request.prompt).includes(TOKEN))
  assert.ok(!JSON.stringify(await w.records.children(SESSION)).includes(TOKEN))
})

// final.

test('final: a reviewer started with final: true asks place for it, and is recorded final when place gives it', async () => {
  const w = await world({ runs: true })
  const coder = await w.delegate(CODER)
  // As dish-orchestrator answers: final only when asked for it, for a reviewer it placed in a run.
  w.placements.set(`${SESSION}||${coder.child}`, (asked: { final?: boolean }) => ({ run: RUN, task: 'fix-1', ...asked.final === true ? { final: true } : {} }))
  const reviewer = await w.delegate({ ...REVIEW, reviews: coder.child, final: true })
  assert.deepEqual(w.placeAsked.at(-1), { sessionId: SESSION, target: { reviews: coder.child, final: true } })
  const record = await recordOf(w, reviewer.child)
  assert.equal(record.final, true)
  assert.equal(record.run, RUN)
  assert.equal(record.task, 'fix-1')
  assert.equal(w.recordedAtStart.get(reviewer.child)?.final, true)
  assert.ok(!('note' in reviewer))
  // false, or left out: place isn't asked for it, and nothing is recorded.
  for (const final of [false, undefined]) {
    const other = await w.delegate({ ...REVIEW, title: `not final ${final}`, reviews: coder.child, ...final === undefined ? {} : { final } })
    assert.deepEqual(w.placeAsked.at(-1), { sessionId: SESSION, target: { reviews: coder.child } })
    assert.ok(!('final' in await recordOf(w, other.child)), String(final))
    assert.ok(!('note' in other))
  }
})

test('final: what place gives is recorded only for a call that asked for it', async () => {
  const w = await world({ runs: true })
  w.placements.set(`${SESSION}||main`, { run: RUN, final: true })
  const reviewer = await w.delegate({ ...REVIEW, reviews: 'main' })
  assert.ok(!('final' in await recordOf(w, reviewer.child)))
})

test('final: with no run placed, or without dish-orchestrator, the reviewer starts, nothing is recorded, and the note says final had no effect', async () => {
  const w = await world({ runs: true })
  const result = await w.delegate({ ...REVIEW, reviews: 'main', final: true })
  assert.equal(w.starts.length, 1)
  assert.deepEqual(w.placeAsked, [{ sessionId: SESSION, target: { reviews: 'main', final: true } }])
  const record = await recordOf(w, result.child)
  assert.ok(!('final' in record) && !('run' in record) && !('task' in record))
  assert.equal(result.note, NO_RUN)
  // No run placed: dish-orchestrator is asked whether the chat drives one, which it doesn't.
  assert.deepEqual(w.drivingAsked, [SESSION])

  const without = await world()
  const off = await without.delegate({ ...REVIEW, reviews: 'main', final: true })
  assert.equal(without.starts.length, 1)
  assert.ok(!('final' in await recordOf(without, off.child)))
  assert.equal(off.note, NO_ORCHESTRATOR)
  // And the output shows it.
  const render = (args: Record<string, unknown>, value: Record<string, string>) => (without.tool.output.render as any)(args, value)[0].text
  assert.equal(render({ ...REVIEW, reviews: 'main', final: true }, off), `started reviewer «review the login» on ${off.model} (child ${off.child})\n${NO_ORCHESTRATOR}`)
})

test('final: a place that failed, or gave no run while the chat drives one, says dish couldn\'t place the reviewer, not that the chat drives no run', async () => {
  const w = await world({ runs: true })
  const logs = watchLogs(w.ctx)
  /** A final reviewer of the main agent's work, finished at once (crew runs at most 4 children); its answer. */
  const reviewer = async (title: string): Promise<any> => {
    const result = await w.delegate({ ...REVIEW, title, reviews: 'main', final: true })
    await finish(w, result.child)
    return result
  }
  // place throws, or answers with no run in it: crew logs it, and needn't ask which run the chat drives.
  w.stub.placeFails = new Error('broken')
  assert.equal((await reviewer('thrown')).note, UNPLACED)
  w.stub.placeFails = undefined
  w.placements.set(`${SESSION}||main`, { run: '' })
  assert.equal((await reviewer('malformed')).note, UNPLACED)
  w.placements.delete(`${SESSION}||main`)
  assert.deepEqual(w.drivingAsked, [])
  // No run placed while the chat drives one: dish-orchestrator's place failed or ran out of time (it logs which).
  w.driving.set(SESSION, { ref: RUN, id: '20261003-fix-1', state: 'open' })
  const unplaced = await reviewer('gave up')
  assert.equal(unplaced.note, UNPLACED)
  assert.ok(!('final' in await recordOf(w, unplaced.child)))
  assert.deepEqual(w.drivingAsked, [SESSION])
  // A follow-up the same.
  const again = await w.delegate({ ...REVIEW, task: 'Again.', to: unplaced.child, final: true })
  assert.equal(again.note, UNPLACED)
  await finish(w, unplaced.child)
  // driving failing too: dish can't say, so it couldn't place it; logged.
  w.stub.drivingFails = new Error('no store')
  assert.equal((await reviewer('no answer')).note, UNPLACED)
  assert.ok(logs.includes('[dish-crew] warn: could not ask dish-orchestrator which run this chat drives: no store'), logs.join('\n'))
  w.stub.drivingFails = undefined
  // No run, and none driven: today's text.
  w.driving.delete(SESSION)
  assert.equal((await reviewer('none')).note, NO_RUN)
  // Without final, driving isn't asked.
  const asked = w.drivingAsked.length
  const plain = await w.delegate({ ...REVIEW, title: 'plain', reviews: 'main' })
  assert.ok(!('note' in plain))
  assert.equal(w.drivingAsked.length, asked)
})

test('final: on a role that doesn\'t review it is refused, before the prompt, the target or anything else is read', async () => {
  const w = await world({ runs: true })
  assert.equal(await refusal(w.delegate({ ...CODER, final: true })),
    'final is for the reviewer role (reviewer): it marks the run\'s final review. Leave final out for a coder.')
  assert.equal(await refusal(w.delegate({ ...RESEARCHER, final: true })),
    'final is for the reviewer role (reviewer): it marks the run\'s final review. Leave final out for a researcher.')
  assert.match(await refusal(w.delegate({ role: 'ops', title: 'deploy', task: 'x', final: true })), /Leave final out for an ops\.$/)
  // A follow-up too, before its target is looked up; and a role whose prompt is missing is refused for final first.
  assert.match(await refusal(w.delegate({ ...CODER, to: 'nobody', final: true })), /^final is for the reviewer role/)
  w.stub.noPrompt.add('coder')
  assert.match(await refusal(w.delegate({ ...CODER, final: true })), /^final is for the reviewer role/)
  assert.deepEqual(w.personaAsked, [])
  assert.deepEqual(w.placeAsked, [])
  assert.equal(w.starts.length, 0)
  assert.deepEqual(await w.records.children(SESSION), [])
  // final: false is none.
  w.stub.noPrompt.clear()
  await w.delegate({ ...CODER, final: false })
  assert.equal(w.starts.length, 1)
  // A role crew.yaml has that reviews is named.
  const renamed = await world({ settings: settingsFrom((d) => { d.roles.critic = d.roles.reviewer; delete d.roles.reviewer }) })
  assert.match(await refusal(renamed.delegate({ ...CODER, final: true })), /^final is for the reviewer role \(critic\)/)
})

test('final: a follow-up with final: true (placed final) makes a reviewer final, and one without it keeps it final', async () => {
  const w = await world({ runs: true })
  const coder = await w.delegate(CODER)
  w.placements.set(`${SESSION}||${coder.child}`, (asked: { final?: boolean }) => ({ run: RUN, task: 'fix-1', ...asked.final === true ? { final: true } : {} }))
  const reviewer = await w.delegate({ ...REVIEW, reviews: coder.child })
  assert.ok(!('final' in await recordOf(w, reviewer.child)))
  await finish(w, reviewer.child)
  const heard: CrewDelegated[] = []
  w.ctx.on('dish-crew/delegated', (event) => { heard.push(event) })
  const again = await w.delegate({ ...REVIEW, task: 'Re-review, as the final review.', to: reviewer.child, final: true })
  assert.ok(!('note' in again))
  assert.deepEqual(w.placeAsked.at(-1), { sessionId: SESSION, target: { reviews: coder.child, final: true } })
  let record = await recordOf(w, reviewer.child)
  assert.equal(record.final, true)
  assert.equal(record.followUps, 1)
  assert.equal(heard[0]!.child.final, true)
  await finish(w, reviewer.child)
  await w.delegate({ ...REVIEW, task: 'Once more.', to: reviewer.child })
  assert.deepEqual(w.placeAsked.at(-1), { sessionId: SESSION, target: { reviews: coder.child } })
  record = await recordOf(w, reviewer.child)
  assert.equal(record.final, true, 'final is sticky')
  assert.equal(record.followUps, 2)

  // No run placed: the follow-up is sent, the reviewer isn't made final, and the note says so.
  const lone = await world({ runs: true })
  const mine = await lone.delegate({ ...REVIEW, reviews: 'main' })
  await finish(lone, mine.child)
  const sent = await lone.delegate({ ...REVIEW, task: 'Again.', to: mine.child, final: true })
  assert.equal(sent.note, NO_RUN)
  assert.equal(lone.sends.length, 1)
  assert.ok(!('final' in await recordOf(lone, mine.child)))
})

test('final: a follow-up is made final only in the run its reviewer is tagged with: not after the chat moved to another run', async () => {
  const w = await world({ runs: true })
  const other = 'frostyard/snosi/20261004-fix-2'
  // place answers as dish-orchestrator does for reviews "main": the run the chat drives, final when asked.
  const drives = { current: RUN }
  w.placements.set(`${SESSION}||main`, (asked: { final?: boolean }) => ({ run: drives.current, ...asked.final === true ? { final: true } : {} }))
  const reviewer = await w.delegate({ ...REVIEW, reviews: 'main' })
  assert.equal((await recordOf(w, reviewer.child)).run, RUN)
  await finish(w, reviewer.child)
  // The chat now drives another run: its final review isn't this reviewer's to give.
  drives.current = other
  const heard: CrewDelegated[] = []
  w.ctx.on('dish-crew/delegated', (event) => { heard.push(event) })
  const result = await w.delegate({ ...REVIEW, task: 'Re-review, as the final review.', to: reviewer.child, final: true })
  assert.deepEqual(w.placeAsked.at(-1), { sessionId: SESSION, target: { reviews: 'main', final: true } })
  assert.equal(result.note, FINAL_OTHER_RUN)
  assert.equal(w.sends.length, 1, 'the follow-up is still sent')
  const record = await recordOf(w, reviewer.child)
  assert.ok(!('final' in record))
  assert.equal(record.run, RUN, 'its tags are its own')
  assert.equal(record.followUps, 1)
  assert.ok(!('final' in heard[0]!.child))
  // Back in its own run, it is made final.
  await finish(w, reviewer.child)
  drives.current = RUN
  const again = await w.delegate({ ...REVIEW, task: 'Once more, as the final review.', to: reviewer.child, final: true })
  assert.ok(!('note' in again))
  assert.equal((await recordOf(w, reviewer.child)).final, true)
})

test('final: a follow-up to a reviewer started outside any run isn\'t made final, whatever place says now', async () => {
  const w = await world({ runs: true })
  const reviewer = await w.delegate({ ...REVIEW, reviews: 'main' })
  assert.ok(!('run' in await recordOf(w, reviewer.child)))
  await finish(w, reviewer.child)
  w.placements.set(`${SESSION}||main`, (asked: { final?: boolean }) => ({ run: RUN, ...asked.final === true ? { final: true } : {} }))
  const result = await w.delegate({ ...REVIEW, task: 'Re-review, as the final review.', to: reviewer.child, final: true })
  assert.equal(result.note, FINAL_OTHER_RUN)
  assert.equal(w.sends.length, 1)
  const record = await recordOf(w, reviewer.child)
  assert.ok(!('final' in record) && !('run' in record))
})

// Run tags.

test('tags: a bound coder is placed by its worktree\'s canonical path, and the record and the delegated event carry run and task', async () => {
  const w = await world({ runs: true })
  const tree = await w.makeWorktree('fix-1')
  // dish-workspaces gives the worktree through a link to the workspace: place is asked with the canonical path.
  const links = await tempDir()
  await symlink(w.workspace, join(links, 'clone'))
  w.worktrees.set('frostyard/snosi/fix-1', { ...tree, path: join(links, 'clone', '.worktrees', 'fix-1'), clone: join(links, 'clone') })
  w.placements.set(`${SESSION}|${tree.path}|`, { run: RUN, task: 'fix-1', round: 0 })
  const heard: CrewDelegated[] = []
  w.ctx.on('dish-crew/delegated', (event) => { heard.push(event) })
  const result = await w.delegate(BOUND)
  assert.deepEqual(w.placeAsked, [{ sessionId: SESSION, target: { worktree: tree.path } }])
  const record = await recordOf(w, result.child)
  assert.equal(record.run, RUN)
  assert.equal(record.task, 'fix-1')
  assert.ok(!('final' in record))
  assert.equal(w.recordedAtStart.get(result.child)?.run, RUN)
  assert.equal(heard.length, 1)
  assert.equal(heard[0]!.child.run, RUN)
  assert.equal(heard[0]!.child.task, 'fix-1')
  assert.ok(!('note' in result), 'round 0 has no note')
})

test('tags: a researcher is placed with nothing and gets the run only; a reviewer is placed by the work it reviews', async () => {
  const w = await world({ runs: true })
  w.placements.set(`${SESSION}||`, { run: RUN })
  const researcher = await w.delegate(RESEARCHER)
  assert.deepEqual(w.placeAsked.at(-1), { sessionId: SESSION, target: {} })
  const record = await recordOf(w, researcher.child)
  assert.equal(record.run, RUN)
  assert.ok(!('task' in record))
  const coder = await w.delegate(CODER)
  w.placements.set(`${SESSION}||${coder.child}`, { run: RUN, task: 'fix-1', round: 3 })
  const reviewer = await w.delegate({ ...REVIEW, reviews: coder.child })
  assert.deepEqual(w.placeAsked.at(-1), { sessionId: SESSION, target: { reviews: coder.child } })
  const reviewed = await recordOf(w, reviewer.child)
  assert.equal(reviewed.run, RUN)
  assert.equal(reviewed.task, 'fix-1')
})

test('tags: a follow-up keeps the child\'s tags whatever place says', async () => {
  const { w, tree } = await ladderWorld()
  const started = await w.delegate(BOUND)
  await finish(w, started.child)
  w.placements.set(`${SESSION}|${tree.path}|`, { run: 'frostyard/snosi/20261004-other', task: 'other', round: 2 })
  const heard: CrewDelegated[] = []
  w.ctx.on('dish-crew/delegated', (event) => { heard.push(event) })
  await w.delegate({ ...CODER, task: 'Fix it.', to: started.child })
  assert.deepEqual(w.placeAsked.at(-1), { sessionId: SESSION, target: { worktree: tree.path } })
  const record = await recordOf(w, started.child)
  assert.equal(record.run, RUN)
  assert.equal(record.task, 'fix-1')
  assert.equal(record.followUps, 1)
  assert.equal(heard[0]!.child.run, RUN)
  assert.equal(heard[0]!.child.task, 'fix-1')
  // A child started outside a run stays untagged, whatever place says of its follow-up.
  const untagged = await world({ runs: true })
  const loose = await untagged.delegate(RESEARCHER)
  await finish(untagged, loose.child)
  untagged.placements.set(`${SESSION}||`, { run: RUN })
  await untagged.delegate({ ...RESEARCHER, to: loose.child })
  assert.ok(!('run' in await recordOf(untagged, loose.child)))
})

test('tags: without dish-orchestrator nothing is asked and nothing is tagged', async () => {
  const w = await world()
  await w.makeWorktree('fix-1')
  const result = await w.delegate(BOUND)
  const record = await recordOf(w, result.child)
  assert.ok(!('run' in record) && !('task' in record) && !('final' in record))
  assert.ok(!('note' in result))
  await finish(w, result.child)
  const again = await w.delegate({ ...CODER, task: 'Again.', to: result.child })
  assert.ok(!('note' in again))
  assert.deepEqual(w.placeAsked, [])
  assert.deepEqual(w.ladderCalls, [])
})

test('tags: a place that throws, or answers with no run in it, is logged, and the child is delegated untagged', async () => {
  const w = await world({ runs: true })
  const logs = watchLogs(w.ctx)
  const tree = await w.makeWorktree('fix-1')
  w.stub.placeFails = new Error('the ledger is unreadable')
  const placed = await w.delegate(BOUND)
  assert.equal(w.starts.length, 1)
  const untagged = await recordOf(w, placed.child)
  assert.ok(!('run' in untagged) && !('task' in untagged))
  assert.ok(logs.some(line => line === '[dish-crew] warn: could not place a delegation in a run: the ledger is unreadable'), logs.join('\n'))
  w.stub.placeFails = undefined
  for (const answer of [{ run: '' }, { run: 7, task: 'fix-1', round: 9 }, 'frostyard/snosi/x', null, { task: 'fix-1', round: 9 }]) {
    await finish(w, placed.child)
    w.placements.set(`${SESSION}|${tree.path}|`, answer)
    const before = logs.length
    const result = await w.delegate({ ...CODER, task: 'Again.', to: placed.child })
    assert.ok(!('note' in result), JSON.stringify(answer))
    assert.equal(logs.length, before + 1, JSON.stringify(answer))
    assert.match(logs.at(-1)!, /could not place a delegation in a run: /)
  }
  assert.ok(!('run' in await recordOf(w, placed.child)))
  assert.deepEqual(w.ladderCalls, [])
  // No run at all (undefined) is no failure: nothing is logged.
  await finish(w, placed.child)
  w.placements.delete(`${SESSION}|${tree.path}|`)
  const before = logs.length
  await w.delegate({ ...CODER, task: 'Again.', to: placed.child })
  assert.equal(logs.length, before)
})

// Where place runs.

test('place: a call refused by the limits, a busy worktree, the route, the tools or the gate check never asks place', async () => {
  const w = await world({ runs: true })
  await w.delegate(CODER)
  assert.equal(w.placeAsked.length, 1)
  assert.match(await refusal(w.delegate({ role: 'ops', title: 'deploy', task: 'x' })), /^a coder is running/)
  assert.equal(w.placeAsked.length, 1)

  const busy = await world({ runs: true })
  const tree = await busy.makeWorktree('fix-1')
  await busy.seed({ id: 'theirs', role: 'coder', title: 'their fix', worktree: tree.path }, 'running', 'session-other')
  assert.match(await refusal(busy.delegate(BOUND)), /is bound to coder «their fix»/)
  assert.deepEqual(busy.placeAsked, [])

  const route = await world({ runs: true })
  route.stub.resolveFails = new Error('down')
  assert.match(await refusal(route.delegate(CODER)), /is not available/)
  assert.deepEqual(route.placeAsked, [])

  const tools = await world({ runs: true, settings: settingsFrom((d) => { d.roles.writer.tools = ['not_a_tool'] }) })
  assert.match(await refusal(tools.delegate({ role: 'writer', title: 'write', task: 'x' })), /would have no tools here/)
  assert.deepEqual(tools.placeAsked, [])

  const gated = await world({ runs: true, dishGates: true })
  await boundCoder(gated, 'c1', FAILED_3)
  assert.match(await refusal(gated.delegate({ ...REVIEW, reviews: 'c1' })), /gate hasn't passed/)
  const reviewer = await gated.delegate({ ...REVIEW, reviews: 'c1', ruling: 'Ruling: x — y — z' })
  await finish(gated, reviewer.child)
  assert.equal(gated.placeAsked.length, 1)
  // A re-review the gate check refuses never asks it either.
  await gated.records.addFollowUp('c1')
  await gated.records.addGate('c1', { ...FAILED_3[2]!, turn: 2 })
  await gated.records.endRun('c1', { stopReason: 'completed', closing: 'done' })
  assert.match(await refusal(gated.delegate({ ...REVIEW, task: 'Again.', to: reviewer.child })), /gate hasn't passed/)
  assert.equal(gated.placeAsked.length, 1)
  assert.equal(gated.sends.length, 0)
})

test('place: two coder delegations at once on one task in one session: the second is placed after the first\'s delegated listener settled', async () => {
  const w = await world({ runs: true, settings: settingsFrom((d) => { d.limits = { running: 4, writers: 2, perSession: 30 } }) })
  const order: string[] = []
  let rounds = 0
  w.placements.set(`${SESSION}||`, () => {
    order.push(`place ${rounds}`)
    return { run: RUN, task: 'fix-1', round: rounds }
  })
  // As dish-orchestrator's listener does, it counts the round before it returns; this one takes a while about it.
  w.ctx.on('dish-crew/delegated', async () => {
    await new Promise(resolve => setTimeout(resolve, 20))
    rounds += 1
    order.push('counted')
  })
  const [first, second] = await Promise.all([w.delegate({ ...CODER, title: 'first' }), w.delegate({ ...CODER, title: 'second' })])
  assert.deepEqual(order, ['place 0', 'counted', 'place 1', 'counted'])
  assert.ok(!('note' in first))
  assert.equal(second.note, row.ladderNote('fix-1', 1))
})

// The escalation ladder.

test('ladderNote: none for round 0; the ladder for rounds 1 to 3; round 4\'s rung; none from round 5, which the caller words', () => {
  assert.equal(row.LADDER_RULING_ROUND, 5)
  assert.equal(row.ladderNote('fix-1', 0), undefined)
  for (const round of [1, 2, 3]) {
    assert.equal(row.ladderNote('fix-1', round), `Round ${round} of task \`fix-1\`. The ladder: rounds 1–3 go to the same coder with \`to\`; `
      + 'round 4 is a fresh coder on the strong tier (`model`), with the open findings and the previous coder\'s report; from round 5, delegate needs your ruling.')
  }
  assert.equal(row.ladderNote('fix-1', 4), 'Round 4 of task `fix-1`: the ladder starts a fresh coder on the strong tier (`model`), '
    + 'with the open findings and the previous coder\'s report. From round 5, delegate needs your ruling.')
  for (const round of [5, 6, 12]) assert.equal(row.ladderNote('fix-1', round), undefined)
})

test('the ladder: a coder on a run\'s task gets no note at round 0, and the ladder\'s note at rounds 1 to 4, on its own line', async () => {
  const { w, round } = await ladderWorld()
  const first = await w.delegate(BOUND)
  assert.ok(!('note' in first))
  for (const n of [1, 2, 3]) {
    await finish(w, first.child)
    round.current = n
    const result = await w.delegate({ ...CODER, task: `Round ${n}.`, to: first.child })
    assert.equal(result.note, row.ladderNote('fix-1', n), String(n))
  }
  // Round 4: a fresh coder on the strong tier.
  await finish(w, first.child)
  round.current = 4
  const fresh = await w.delegate({ ...BOUND, title: 'round 4', model: 'claude-opus-5.5' })
  assert.equal(fresh.note, row.ladderNote('fix-1', 4))
  const render = (args: Record<string, unknown>, value: Record<string, string>) => (w.tool.output.render as any)(args, value)[0].text
  assert.equal(render(BOUND, fresh), `started coder «round 4» on claude-opus-5.5 (child ${fresh.child})\n${row.ladderNote('fix-1', 4)}`)
  assert.deepEqual(w.ladderCalls, [])
})

test('the ladder: round 5 without a ruling is refused, the ladder records it, and nothing is recorded, started or published', async () => {
  const { w, round } = await ladderWorld()
  round.current = 5
  const heard: string[] = []
  w.ctx.on('dish-crew/delegated', () => { heard.push('delegated') })
  assert.equal(await refusal(w.delegate(BOUND)), ladderRefusal(5))
  assert.deepEqual(w.ladderCalls, [{ sessionId: SESSION, run: RUN, task: 'fix-1', round: 5, outcome: 'refused' }])
  assert.equal(w.starts.length, 0)
  assert.deepEqual(await w.records.children(SESSION), [])
  assert.deepEqual(heard, [])
  // A ruling with nothing in it is no ruling: refused the same way, and said so first.
  for (const blank of ['Ruling:', ' ruling: — — ', 'Ruling: what — why — cost if wrong']) {
    assert.equal(await refusal(w.delegate({ ...BOUND, ruling: blank })), `ruling needs the ruling itself: what — why — cost if wrong. ${ladderRefusal(5)}`, blank)
  }
  assert.equal(w.ladderCalls.length, 4)
  assert.ok(w.ladderCalls.every(entry => entry.outcome === 'refused' && !('ruling' in entry)))
  assert.equal(w.starts.length, 0)
  assert.deepEqual(heard, [])
})

test('the ladder: round 5 with a ruling starts, the ladder records the masked ruling, and the note says so', async () => {
  const { w, round } = await ladderWorld()
  round.current = 5
  const ruling = `Ruling: one more round — the fix is one line (${TOKEN}) — a wasted round`
  const result = await w.delegate({ ...BOUND, ruling: `${ruling}\n` })
  assert.equal(w.starts.length, 1)
  assert.deepEqual(w.ladderCalls, [{ sessionId: SESSION, run: RUN, task: 'fix-1', round: 5, outcome: 'ruled', ruling: maskSecrets(ruling) }])
  assert.ok(!JSON.stringify(w.ladderCalls).includes(TOKEN))
  assert.equal(result.note, 'Round 5 of task `fix-1`, past the ladder, on your ruling (recorded).')
  const record = await recordOf(w, result.child)
  assert.equal(record.run, RUN)
  assert.equal(record.task, 'fix-1')
  assert.ok(!('gateOverride' in record), 'the ladder\'s ruling goes to the ledger, not on the coder')
  // gateOverride, the old name, rules here too.
  await finish(w, result.child)
  round.current = 6
  const again = await w.delegate({ ...CODER, task: 'Again.', to: result.child, gateOverride: 'Ruling: a — b — c' })
  assert.equal(again.note, 'Round 6 of task `fix-1`, past the ladder, on your ruling (recorded).')
  assert.deepEqual(w.ladderCalls[1], { sessionId: SESSION, run: RUN, task: 'fix-1', round: 6, outcome: 'ruled', ruling: 'Ruling: a — b — c', child: result.child })
})

test('the ladder: a follow-up at round 6 is refused the same way, and nothing is sent or counted', async () => {
  const { w, round } = await ladderWorld()
  const started = await w.delegate(BOUND)
  await finish(w, started.child)
  round.current = 6
  const heard: string[] = []
  w.ctx.on('dish-crew/delegated', () => { heard.push('delegated') })
  assert.equal(await refusal(w.delegate({ ...CODER, task: 'Again.', to: started.child })), ladderRefusal(6))
  assert.equal(w.sends.length, 0)
  assert.equal((await recordOf(w, started.child)).followUps, 0)
  assert.deepEqual(heard, [])
  assert.deepEqual(w.ladderCalls, [{ sessionId: SESSION, run: RUN, task: 'fix-1', round: 6, outcome: 'refused', child: started.child }])
})

test('the ladder: a follow-up whose child the run no longer places where its tags say isn\'t counted', async () => {
  const { w, tree } = await ladderWorld()
  const started = await w.delegate(BOUND)
  for (const placement of [{ run: 'frostyard/snosi/20261004-fix-1', task: 'fix-1', round: 9 }, { run: RUN, task: 'other', round: 9 }, { run: RUN }, { run: RUN, task: 'fix-1' }]) {
    await finish(w, started.child)
    w.placements.set(`${SESSION}|${tree.path}|`, placement)
    const result = await w.delegate({ ...CODER, task: 'Again.', to: started.child })
    assert.ok(!('note' in result), JSON.stringify(placement))
  }
  assert.equal(w.sends.length, 4)
  assert.deepEqual(w.ladderCalls, [])
})

test('the ladder: a writer bound to a task at round 7, a reviewer, and a coder outside a task aren\'t counted', async () => {
  const { w, round } = await ladderWorld()
  round.current = 7
  const writer = await w.delegate({ role: 'writer', title: 'write docs', task: 'Write.', worktree: 'frostyard/snosi/fix-1' })
  assert.ok(!('note' in writer))
  const record = await recordOf(w, writer.child)
  assert.equal(record.run, RUN)
  assert.equal(record.task, 'fix-1')
  await finish(w, writer.child)
  w.placements.set(`${SESSION}||${writer.child}`, { run: RUN, task: 'fix-1', round: 7 })
  const reviewer = await w.delegate({ ...REVIEW, reviews: writer.child })
  assert.ok(!('note' in reviewer))
  // A coder placed in the run with no task.
  w.placements.set(`${SESSION}||`, { run: RUN, round: 7 })
  const loose = await w.delegate({ ...CODER, title: 'unbound' })
  assert.ok(!('note' in loose))
  assert.equal(w.starts.length, 3)
  assert.deepEqual(w.ladderCalls, [])
})

test('the ladder: a ruling before round 5 is ignored, not recorded, and the ladder isn\'t called', async () => {
  const { w, round } = await ladderWorld()
  round.current = 2
  const result = await w.delegate({ ...BOUND, ruling: 'Ruling: x — y — z' })
  assert.equal(result.note, row.ladderNote('fix-1', 2))
  assert.deepEqual(w.ladderCalls, [])
  assert.ok(!('gateOverride' in await recordOf(w, result.child)))
  // Nor is one with nothing in it refused there.
  await finish(w, result.child)
  round.current = 3
  assert.equal((await w.delegate({ ...CODER, task: 'Again.', to: result.child, ruling: 'Ruling:' })).note, row.ladderNote('fix-1', 3))
})

test('the ladder: a ladder that throws is logged; the refusal still comes, and a ruled call still starts', async () => {
  const { w, round } = await ladderWorld()
  const logs = watchLogs(w.ctx)
  w.stub.ladderFails = new Error('the ledger is full')
  round.current = 5
  assert.equal(await refusal(w.delegate(BOUND)), ladderRefusal(5))
  assert.equal(w.starts.length, 0)
  const result = await w.delegate({ ...BOUND, ruling: 'Ruling: x — y — z' })
  assert.equal(w.starts.length, 1)
  assert.equal(result.note, 'Round 5 of task `fix-1`, past the ladder, on your ruling (recorded).')
  assert.equal(w.ladderCalls.length, 2)
  assert.equal(logs.filter(line => /the ledger is full/.test(line)).length, 2, logs.join('\n'))
})
