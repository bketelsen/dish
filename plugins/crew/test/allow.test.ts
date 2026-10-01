import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { RUN_CODE_NAME, ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { NEVER, allowList, visibleTools } from '../src/allow.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { DEFAULT_SETTINGS } from '../src/settings.ts'

/** Every name of the never-list, as the plan's Global Constraints spell it. */
const NEVER_NAMES = ['delegate', 'subagent', 'subagent_fork', 'workflow', 'interrupt_agent', 'list_agents', 'ask_user_question', 'create_goal', 'update_goal', 'exit_plan_mode', 'present']

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
  assert.equal(NEVER.size, 11)
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

/** A context with a real tool registry (and a stub system prompt, which is all the registry needs of it). */
async function withTools(...names: string[]): Promise<Context> {
  const ctx = new Context()
  ctx.provide('systemPrompt', { tools() {}, section() {}, getSectionOrder: () => 1 } as never)
  registries.push(await ctx.plugin(ToolRuntime, {}))
  for (const name of names) ctx.tools.register(stub(name))
  return ctx
}

/** The parent agent as `visibleTools` reads it: its `ctx`, whose registry it is looked up in. */
const agentOn = (ctx: Context): Agent => ({ id: 'parent', ctx }) as unknown as Agent

test('visibleTools names the tools the parent agent can see, as the registry lists them for it', async () => {
  const ctx = await withTools('read', 'bash', 'delegate', 'send_message')
  const agent = agentOn(ctx)
  const visible = visibleTools(agent)
  assert.deepEqual([...visible].sort(), ['bash', 'delegate', 'read', 'send_message'])
  assert.deepEqual(new Set(ctx.tools.schemas(agent).map(schema => schema.name)), visible)
  // It's a snapshot of now: a tool registered later is in the next one.
  const dispose = ctx.tools.register(stub('write'))
  assert.ok(visibleTools(agent).has('write'))
  assert.ok(!visible.has('write'))
  dispose()
  assert.ok(!visibleTools(agent).has('write'))
})

test('the allow list over the visible tools of a real registry never names the never-list, and each name is one the registry has', async () => {
  const ctx = await withTools('read', 'glob', 'grep', 'pwsh', 'delegate', 'subagent', 'send_message', 'ask_user_question')
  const visible = visibleTools(agentOn(ctx))
  const result = allowList(['read', 'glob', 'bash', 'delegate', 'subagent', 'send_message', 'ask_user_question', 'web_search'], visible)
  assert.ok(result.ok)
  assert.deepEqual(result.allow, ['glob', 'pwsh', 'read', 'send_message'])
  for (const name of result.allow) assert.ok(ctx.tools.get(name, agentOn(ctx)) !== undefined, name)
})
