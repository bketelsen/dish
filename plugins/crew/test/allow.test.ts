import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import { RUN_CODE_NAME, ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { NEVER, allowList, visibleTools } from '../src/allow.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { DEFAULT_SETTINGS } from '../src/settings.ts'

/** Every name of the never-list, as the plan's Global Constraints spell it. */
const NEVER_NAMES = ['delegate', 'subagent', 'subagent_fork', 'subagent_codex', 'subagent_claude_code', 'list_subagent_models', 'workflow', 'ralph', 'interrupt_agent', 'list_agents', 'ask_user_question', 'create_goal', 'update_goal', 'exit_plan_mode', 'present', 'worktree', 'run', 'open_pr', 'pr_feedback']

function allowed(roleTools: string[], visible: string[]): string[] {
  const result = allowList(roleTools, new Set(visible))
  assert.ok(result.ok, result.ok ? '' : result.problem)
  return result.allow
}

function problemOf(roleTools: string[], visible: string[], role?: string): string {
  const result = allowList(roleTools, new Set(visible), role)
  assert.equal(result.ok, false, 'expected a problem')
  return result.ok ? '' : result.problem
}

// --- NEVER ----------------------------------------------------------------------------------------

test('NEVER is exactly the never-list: nothing a child must not have is missing, and nothing else is in it', () => {
  assert.deepEqual([...NEVER].sort(), [...NEVER_NAMES].sort())
  assert.equal(NEVER.size, 19)
})

test('worktree, dish-workspaces\' tool for the main agent, is dropped like delegate, and the problem names it among what children never get', () => {
  assert.deepEqual(allowed(['read', 'worktree', 'delegate'], ['read', 'worktree', 'delegate']), ['read'])
  assert.match(problemOf(['worktree'], ['worktree', 'read'], 'coder'), /Children never get [^.]*\bworktree\b/)
})

test('run, open_pr and pr_feedback, dish-orchestrator\'s tools for the main agent, are dropped from a role that lists them, and the problem names them', () => {
  const orchestrator = ['run', 'open_pr', 'pr_feedback']
  assert.deepEqual(allowed(['read', ...orchestrator], ['read', ...orchestrator]), ['read'])
  for (const name of orchestrator) {
    assert.ok(NEVER.has(name), name)
    assert.match(problemOf([name], [name, 'read'], 'coder'), new RegExp(`Children never get [^.]*\\b${name}\\b`), name)
  }
})

// --- allowList ------------------------------------------------------------------------------------

test('the allow list is the role\'s tools that are visible', () => {
  assert.deepEqual(allowed(['read', 'glob', 'grep', 'web_fetch'], ['read', 'grep', 'glob', 'write', 'edit']), ['glob', 'grep', 'read'])
})

test('a tool that isn\'t visible is dropped, not an error', () => {
  assert.deepEqual(allowed(['read', 'read_image', 'web_search'], ['read']), ['read'])
  assert.deepEqual(allowed(['read', 'bash'], ['read']), ['read'])
})

test('a visible tool the role doesn\'t list is not allowed', () => {
  assert.deepEqual(allowed(['read'], ['read', 'write', 'edit', 'bash']), ['read'])
})

test('pwsh is added wherever bash is listed, and kept only if visible', () => {
  // Only pwsh visible (Windows): bash is dropped, pwsh stands in for it.
  assert.deepEqual(allowed(['read', 'bash'], ['read', 'pwsh']), ['pwsh', 'read'])
  // Both visible: both.
  assert.deepEqual(allowed(['read', 'bash'], ['read', 'bash', 'pwsh']), ['bash', 'pwsh', 'read'])
  // Only bash visible: bash alone.
  assert.deepEqual(allowed(['read', 'bash'], ['read', 'bash']), ['bash', 'read'])
  // Neither: neither.
  assert.deepEqual(allowed(['read', 'bash'], ['read', 'edit']), ['read'])
})

test('pwsh is not added when bash is not listed', () => {
  assert.deepEqual(allowed(['read'], ['read', 'bash', 'pwsh']), ['read'])
  assert.deepEqual(allowed(['read', 'pwsh'], ['read', 'bash', 'pwsh']), ['pwsh', 'read'])
})

test('every name of the never-list is dropped, even when the role lists it and it is visible', () => {
  for (const name of NEVER_NAMES) {
    assert.deepEqual(allowed(['read', name], ['read', name]), ['read'], name)
  }
  assert.deepEqual(allowed(['read', ...NEVER_NAMES], ['read', ...NEVER_NAMES]), ['read'])
})

test('a role that lists only never-list tools has no tools', () => {
  assert.match(problemOf(['delegate', 'subagent'], ['delegate', 'subagent', 'read'], 'coder'), /^role coder would have no tools here/)
})

test('an empty result is a problem that names the role, the visible tools and what the role listed', () => {
  const problem = problemOf(['web_search'], ['write', 'read', 'edit'], 'researcher')
  assert.match(problem, /^role researcher would have no tools here \(visible: edit, read, write\)/)
  assert.ok(problem.includes('web_search'), problem)
  assert.match(problem, /crew\.yaml/)
})

test('an empty tools list and nothing visible are problems too', () => {
  assert.match(problemOf([], ['read'], 'writer'), /^role writer would have no tools here \(visible: read\)/)
  assert.match(problemOf(['read'], [], 'writer'), /^role writer would have no tools here \(visible: none\)/)
  assert.match(problemOf([], [], 'writer'), /would have no tools here/)
})

test('without a role name the problem still says so', () => {
  assert.match(problemOf(['read'], ['write']), /^the role would have no tools here \(visible: write\)/)
})

test('the result is deduplicated and sorted, whatever order the file and the registry list things in', () => {
  const forward = allowed(['web_fetch', 'read', 'bash', 'grep', 'read', 'glob', 'web_fetch'], ['pwsh', 'glob', 'grep', 'read', 'web_fetch', 'bash'])
  assert.deepEqual(forward, ['bash', 'glob', 'grep', 'pwsh', 'read', 'web_fetch'])
  const reversed = allowed(['glob', 'web_fetch', 'bash', 'read', 'grep'].reverse(), ['bash', 'web_fetch', 'read', 'grep', 'glob', 'pwsh'].reverse())
  assert.deepEqual(reversed, forward)
  assert.deepEqual(forward, [...forward].sort())
})

test('the reserved presentation transport can\'t be named in a tool filter, so it is never allowed', () => {
  // dsh's tools.restrict() throws on it, which would make the delegation fail over a line in crew.yaml.
  assert.equal(RUN_CODE_NAME, 'run_code')
  assert.deepEqual(allowed(['read', 'run_code'], ['read', 'run_code']), ['read'])
})

test('names are matched exactly: no trimming, no case folding, no prototype members', () => {
  assert.match(problemOf(['Read', ' read', 'read '], ['read']), /would have no tools here/)
  assert.match(problemOf(['constructor', 'toString', '__proto__', 'hasOwnProperty'], ['read']), /would have no tools here/)
  assert.deepEqual(allowed(['Read', ' read', 'read'], ['read']), ['read'])
})

test('the shipped crew.yaml gives every role tools when the standard ones are visible, and none of the never-list', () => {
  const visible = ['read', 'glob', 'grep', 'write', 'edit', 'bash', 'job_output', 'job_list', 'job_kill', 'web_search', 'web_fetch', 'skill', 'todo_write', 'send_message', ...NEVER_NAMES]
  for (const [name, role] of Object.entries(DEFAULT_SETTINGS.roles)) {
    const allow = allowed([...role.tools], visible)
    assert.ok(allow.length > 0, name)
    for (const tool of allow) assert.ok(!NEVER.has(tool), `${name}: ${tool}`)
    assert.deepEqual(allow, [...allow].sort(), name)
  }
  // On a host with pwsh instead of bash, the coder keeps a shell.
  const windows = visible.filter(name => name !== 'bash').concat('pwsh')
  assert.ok(allowed([...DEFAULT_SETTINGS.roles.coder!.tools], windows).includes('pwsh'))
})

test('ask_judge is allowed where dish-judge provides it, and left out, with nothing else lost, where it isn\'t installed', () => {
  const standard = ['read', 'glob', 'grep', 'write', 'edit', 'bash', 'job_output', 'job_list', 'job_kill', 'web_search', 'web_fetch', 'skill', 'todo_write', 'send_message', ...NEVER_NAMES]
  for (const [name, role] of Object.entries(DEFAULT_SETTINGS.roles)) {
    assert.ok(role.tools.includes('ask_judge'), `${name} lists ask_judge`)
    const without = allowed([...role.tools], standard)
    assert.ok(!without.includes('ask_judge'), `${name}: dropped when no tool of that name is visible`)
    // Dropping it costs the role nothing else: the list is what it was before the shipped roles listed ask_judge.
    assert.deepEqual(without, allowed(role.tools.filter(tool => tool !== 'ask_judge'), standard), name)
    const withJudge = allowed([...role.tools], [...standard, 'ask_judge'])
    assert.deepEqual(withJudge, [...without, 'ask_judge'].sort(), `${name}: allowed once dish-judge registers it`)
  }
})

test('a role that lists only ask_judge, with dish-judge not installed, is the readable "no tools" problem, not a throw', () => {
  const problem = problemOf(['ask_judge'], ['read', 'write'], 'reviewer')
  assert.match(problem, /^role reviewer would have no tools here \(visible: read, write\)/)
  assert.ok(problem.includes('crew.yaml lists: ask_judge'), problem)
  assert.match(problem, /roles\.reviewer\.tools/)
})

test('allowList doesn\'t change what it is given', () => {
  const tools = ['read', 'bash', 'delegate']
  const visible = new Set(['read', 'pwsh', 'delegate'])
  allowList(tools, visible)
  assert.deepEqual(tools, ['read', 'bash', 'delegate'])
  assert.deepEqual([...visible], ['read', 'pwsh', 'delegate'])
})

// --- visibleTools ---------------------------------------------------------------------------------

const registries: Array<{ dispose(): Promise<void> | void }> = []
after(async () => {
  await Promise.all(registries.splice(0).map(handle => handle.dispose()))
})

function stub(name: string): ToolDefinition {
  return defineTool({
    name,
    description: `the ${name} tool`,
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: false, properties: {} }, render: () => [{ type: 'text', text: 'done' }] },
    async execute() { return {} },
  }) as ToolDefinition
}

/** What a test of `visibleTools` stands on: dsh's real tool registry and real scopes, laid out as dsh does. */
interface World {
  ctx: Context
  /** The scope the agents' preset registers its tools in, which every agent under it inherits. `undefined` when there is no preset. */
  preset: { ctx: Context, key: object } | undefined
  /** A new agent: the scope key and the owner of a scope under the preset (or the root), as dsh's agent loop makes one. */
  agent(id: string): Agent
}

/**
 * A context with a real tool registry (and a stub system prompt, which is all the registry needs of it). Global tools are
 * `globals`. With `presetTools` there's a preset scope, as the agent preset registry mints one, and each agent joins
 * it with `bindScopeParent`: its scope's parent is the preset's, which is what `composeFrom` does for a child too.
 */
async function world(globals: string[], presetTools?: string[]): Promise<World> {
  const ctx = new Context()
  ctx.provide('systemPrompt', { tools() {}, section() {}, getSectionOrder: () => 1 } as never)
  registries.push(await ctx.plugin(ToolRuntime, {}))
  // Scopes are minted under a plugin that has the registry injected, as the agent loop and the preset registry are.
  let owner!: Context
  registries.push(await ctx.plugin({ name: 'scope-owner', inject: ['tools'], apply(own: Context) { owner = own } } as never, undefined as never))
  for (const name of globals) ctx.tools.register(stub(name))
  let preset: World['preset']
  if (presetTools !== undefined) {
    const key = {}
    const scope = createScope(owner, key)
    registries.push(scope)
    for (const name of presetTools) scope.ctx.tools.register(stub(name))
    preset = { ctx: scope.ctx, key }
  }
  return {
    ctx,
    preset,
    agent(id) {
      const agent = { id } as unknown as Agent
      const scope = createScope(owner, agent, preset === undefined ? {} : { parent: preset.key })
      registries.push(scope)
      ;(agent as { ctx: Context }).ctx = scope.ctx
      return agent
    },
  }
}

const names = (ctx: Context, scope: object): string[] => ctx.tools.schemas(scope).map(schema => schema.name).sort()

test('visibleTools lists global and preset tools, and leaves out a tool on the parent agent\'s own scope: the child can\'t restrict that', async () => {
  const { ctx, agent } = await world(['glob'], ['read', 'delegate', 'send_message'])
  const parent = agent('parent')
  // dsh-schedule's schedule_*, agent-team's tools and the subagent tool's model selection register like this.
  parent.ctx.tools.register(stub('schedule_create'))
  // The registry shows the parent all four.
  assert.deepEqual(names(ctx, parent), ['delegate', 'glob', 'read', 'schedule_create', 'send_message'])
  // A child it starts joins the preset, not the parent, and can restrict only what it inherits.
  const child = agent('child')
  assert.throws(() => child.ctx.tools.restrict({ allow: ['read', 'schedule_create'] }), /unknown global tool "schedule_create"/)
  // So that's what visibleTools says.
  assert.deepEqual([...visibleTools(parent)].sort(), ['delegate', 'glob', 'read', 'send_message'])
})

test('a filter made from visibleTools is one the child\'s restrict accepts, and the child then sees exactly it', async () => {
  const { ctx, agent } = await world(['glob', 'pwsh', 'subagent'], ['read', 'delegate', 'send_message', 'web_fetch'])
  const parent = agent('parent')
  parent.ctx.tools.register(stub('schedule_create'))
  parent.ctx.tools.register(stub('schedule_list'))
  const result = allowList(['read', 'glob', 'bash', 'schedule_create', 'schedule_list', 'delegate', 'subagent', 'send_message', 'web_search'], visibleTools(parent), 'coder')
  assert.ok(result.ok)
  assert.deepEqual(result.allow, ['glob', 'pwsh', 'read', 'send_message'])
  const child = agent('child')
  child.ctx.tools.restrict({ allow: result.allow })
  assert.deepEqual(names(ctx, child), result.allow)
})

test('without a preset the child inherits the global tools only, and so does the list', async () => {
  const { ctx, agent } = await world(['read', 'glob', 'send_message'])
  const parent = agent('parent')
  parent.ctx.tools.register(stub('schedule_create'))
  assert.deepEqual([...visibleTools(parent)].sort(), ['glob', 'read', 'send_message'])
  const result = allowList(['read', 'schedule_create', 'glob'], visibleTools(parent))
  assert.ok(result.ok)
  const child = agent('child')
  child.ctx.tools.restrict({ allow: result.allow })
  assert.deepEqual(names(ctx, child), ['glob', 'read'])
})

test('a tool the parent has restricted away isn\'t listed', async () => {
  const { agent } = await world(['glob'], ['read', 'write', 'send_message'])
  const parent = agent('parent')
  parent.ctx.tools.restrict({ deny: ['write'] })
  assert.deepEqual([...visibleTools(parent)].sort(), ['glob', 'read', 'send_message'])
})

test('the reserved run_code transport of a parent in a code mode is left out, and the filter without it is accepted', async () => {
  const { ctx, agent } = await world(['glob'], ['read', 'send_message'])
  const parent = agent('parent')
  parent.ctx.tools.presentAs('ptc')
  assert.ok(names(ctx, parent).includes(RUN_CODE_NAME), 'the registry lists it for the parent')
  const visible = visibleTools(parent)
  assert.ok(!visible.has(RUN_CODE_NAME))
  const child = agent('child')
  assert.throws(() => child.ctx.tools.restrict({ allow: [...names(ctx, parent)] }), /run_code/)
  const result = allowList(['read', 'run_code', 'glob'], visible)
  assert.ok(result.ok)
  assert.deepEqual(result.allow, ['glob', 'read'])
  child.ctx.tools.restrict({ allow: result.allow })
  assert.deepEqual(names(ctx, child), ['glob', 'read'])
})

test('ask_judge as a global tool reaches a child through the preset; where it isn\'t registered the filter is still one restrict accepts', async () => {
  const roleTools = [...DEFAULT_SETTINGS.roles.reviewer!.tools]
  // dish-judge registers ask_judge globally, so every agent inherits it, whatever preset the main agent is on.
  const installed = await world(['glob', 'ask_judge'], ['read', 'grep', 'bash', 'send_message'])
  const parent = installed.agent('parent')
  const withJudge = allowList(roleTools, visibleTools(parent), 'reviewer')
  assert.ok(withJudge.ok)
  assert.ok(withJudge.allow.includes('ask_judge'))
  const child = installed.agent('child')
  child.ctx.tools.restrict({ allow: withJudge.allow })
  assert.deepEqual(names(installed.ctx, child), withJudge.allow)
  // Without dish-judge nothing is registered under that name. restrict() throws on an unknown name, so the name has to be
  // left out of the filter, and it is: the child starts, with the rest of its role.
  const bare = await world(['glob'], ['read', 'grep', 'bash', 'send_message'])
  assert.throws(() => bare.agent('probe').ctx.tools.restrict({ allow: ['read', 'ask_judge'] }), /unknown global tool "ask_judge"/)
  const without = allowList(roleTools, visibleTools(bare.agent('parent')), 'reviewer')
  assert.ok(without.ok)
  assert.ok(!without.allow.includes('ask_judge'))
  assert.deepEqual(without.allow, ['bash', 'glob', 'grep', 'read', 'send_message'])
  const child2 = bare.agent('child')
  child2.ctx.tools.restrict({ allow: without.allow })
  assert.deepEqual(names(bare.ctx, child2), without.allow)
})

test('visibleTools is a snapshot of now: a tool registered later is in the next one', async () => {
  const { ctx, agent } = await world(['glob'], ['read'])
  const parent = agent('parent')
  const before = visibleTools(parent)
  const dispose = ctx.tools.register(stub('write'))
  assert.ok(visibleTools(parent).has('write'))
  assert.ok(!before.has('write'))
  dispose()
  assert.ok(!visibleTools(parent).has('write'))
})

test('dsh-scope is the instance dsh-tools uses: scopes made here are the scopes the registry reads', () => {
  // Two copies of the package would each have their own scope relation, and a scope made by one would look unscoped to the other.
  const here = realpathSync(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-scope')))
  const toolsUses = realpathSync(createRequire(import.meta.resolve('@deepseek-ai/dsh-tools')).resolve('@deepseek-ai/dsh-scope'))
  assert.equal(here, toolsUses)
})
