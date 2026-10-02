import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { DishWorkspaces } from '../src/service.ts'
import { MAIN_ONLY, worktreeTool } from '../src/tool.ts'
import type { CreatedWorktree, WorktreeInfo } from '../src/worktrees.ts'

const SHA = 'a'.repeat(40)
const CLONE = '/work/acme/widget'

/** The calling agent as the tool sees it (`exec.agent.session.header`), with a `cwd` unless it is `null`. */
function exec(options: { depth?: number, origin?: string, cwd?: string | null, signal?: AbortSignal } = {}): ToolRunContext {
  const header = {
    id: 'sess-1',
    ...(options.depth === undefined ? {} : { delegationDepth: options.depth }),
    ...(options.origin === undefined ? {} : { origin: options.origin }),
    ...(options.cwd === null ? {} : { cwd: options.cwd ?? CLONE }),
  }
  return { agent: { id: 'sess-1', session: { header } }, signal: options.signal ?? new AbortController().signal } as unknown as ToolRunContext
}

interface Calls {
  create: Array<{ project: string, slug: string, base: string | undefined, cwd: string | undefined, signal: AbortSignal | undefined }>
  list: Array<string | undefined>
  remove: Array<{ project: string, slug: string, force: boolean | undefined }>
}

function info(slug: string, overrides: Partial<WorktreeInfo> = {}): WorktreeInfo {
  return {
    project: 'acme/widget', slug, branch: `dish/${slug}`, path: `${CLONE}/.worktrees/${slug}`, clone: CLONE, base: SHA,
    ahead: 0, behind: 0, dirty: false, merged: false, managed: true, bound: [], ...overrides,
  }
}

/** A `dishWorkspaces` that records what the tool asks of it. */
function stub(overrides: Partial<DishWorkspaces> = {}): { service: DishWorkspaces, calls: Calls } {
  const calls: Calls = { create: [], list: [], remove: [] }
  const service = {
    async createWorktree(project, slug, base, options) {
      calls.create.push({ project, slug, base, cwd: options?.cwd, signal: options?.signal })
      const created: CreatedWorktree = {
        project, slug, branch: `dish/${slug}`, path: `${CLONE}/.worktrees/${slug}`, clone: CLONE, base: SHA,
        setup: { ran: false, reason: `setup didn't run outside the sandbox: a worktree picks up config from the clone, which agents can change. Run it yourself in ${CLONE}/.worktrees/${slug}: pnpm install` },
      }
      return created
    },
    async listWorktrees(project) {
      calls.list.push(project)
      return [
        info('fix-1', { ahead: 2, behind: 1, bound: [{ child: 'child-7', role: 'coder', title: 'Fix it', running: true }] }),
        info('old', { merged: true, dirty: true }),
        info('mine', { managed: false, branch: 'by-hand', base: '' }),
      ]
    },
    async removeWorktree(project, slug, force) {
      calls.remove.push({ project, slug, force })
    },
    ...overrides,
  } as DishWorkspaces
  return { service, calls }
}

test('the tool is called worktree, its schemas are ones dsh accepts, and its description names delegate\'s worktree', () => {
  const tool = worktreeTool(() => undefined)
  assert.equal(tool.name, 'worktree')
  assertSupportedJsonSchema(tool.parameters as never)
  assertSupportedJsonSchema(tool.output.schema as never)
  assert.match(tool.description, /delegate/)
  assert.match(tool.description, /`worktree`/)
  assert.match(tool.description, /origin\/<default/)
  assert.match(tool.description, /removed automatically/)
  assert.match(tool.description, /one worktree per task/i)
})

test('a caller that isn\'t the main agent is refused before anything is asked of the service', async () => {
  const { service, calls } = stub()
  const tool = worktreeTool(() => service)
  for (const who of [exec({ depth: 1 }), exec({ origin: 'subagent' }), ({}) as ToolRunContext]) {
    for (const action of ['create', 'list', 'remove']) {
      await assert.rejects(tool.execute({ action, project: 'acme/widget', slug: 'x' }, who), (error: Error) => error.message === MAIN_ONLY)
    }
  }
  assert.deepEqual(calls, { create: [], list: [], remove: [] })
})

test('without dish-workspaces the tool says so', async () => {
  const tool = worktreeTool(() => undefined)
  await assert.rejects(tool.execute({ action: 'list' }, exec()), /dish-workspaces/)
})

test('create and remove need a project and a slug; empty strings are absent', async () => {
  const { service, calls } = stub()
  const tool = worktreeTool(() => service)
  await assert.rejects(tool.execute({ action: 'create', slug: 'x' }, exec()), /`project` is required for create/)
  await assert.rejects(tool.execute({ action: 'create', project: '', slug: 'x' }, exec()), /`project` is required for create/)
  await assert.rejects(tool.execute({ action: 'create', project: 'acme/widget' }, exec()), /`slug` is required for create/)
  await assert.rejects(tool.execute({ action: 'create', project: 'acme/widget', slug: '  ' }, exec()), /`slug` is required for create/)
  await assert.rejects(tool.execute({ action: 'remove', slug: 'x' }, exec()), /`project` is required for remove/)
  await assert.rejects(tool.execute({ action: 'remove', project: 'acme/widget', slug: '' }, exec()), /`slug` is required for remove/)
  assert.deepEqual(calls, { create: [], list: [], remove: [] })
})

test('create passes the session\'s cwd and the call\'s signal, and answers the path, branch, base and the setup outcome', async () => {
  const { service, calls } = stub()
  const tool = worktreeTool(() => service)
  const signal = new AbortController().signal
  const value = await tool.execute({ action: 'create', project: 'acme/widget', slug: 'fix-1', base: '', force: false }, exec({ signal, cwd: CLONE }))
  assert.deepEqual(calls.create, [{ project: 'acme/widget', slug: 'fix-1', base: undefined, cwd: CLONE, signal }])
  const answer = value as Record<string, unknown>
  assert.equal(answer.action, 'create')
  assert.equal(answer.path, `${CLONE}/.worktrees/fix-1`)
  assert.equal(answer.branch, 'dish/fix-1')
  assert.equal(answer.base, SHA)
  assert.equal((answer.setup as { ran: boolean }).ran, false)
  assert.match((answer.setup as { reason: string }).reason, /Run it yourself in .*: pnpm install/)
  const text = tool.output.render({}, value as never).map(block => (block as { text?: string }).text ?? '').join('\n')
  assert.ok(text.includes(`${CLONE}/.worktrees/fix-1`))
  assert.ok(text.includes('dish/fix-1'))
  assert.ok(text.includes(SHA))
  assert.match(text, /pnpm install/)
  assert.match(text, /delegate/)

  // A base, and a chat with no workspace (the service refuses that, not the tool).
  await tool.execute({ action: 'create', project: 'acme/widget', slug: 'fix-2', base: 'origin/dish/plan' }, exec({ cwd: null }))
  assert.deepEqual(calls.create[1], { project: 'acme/widget', slug: 'fix-2', base: 'origin/dish/plan', cwd: undefined, signal: calls.create[1]!.signal })
})

test('create answers a setup that ran with its exit code and log', async () => {
  const { service } = stub({
    async createWorktree(project, slug) {
      return {
        project, slug, branch: `dish/${slug}`, path: `${CLONE}/.worktrees/${slug}`, clone: CLONE, base: SHA,
        setup: { ran: true, exitCode: 0, signal: null, timedOut: false, aborted: false, durationMs: 5, log: '/state/x.setup.log', tail: 'ok\n' },
      }
    },
  })
  const tool = worktreeTool(() => service)
  const value = await tool.execute({ action: 'create', project: 'acme/widget', slug: 'fix-3' }, exec())
  assert.deepEqual((value as { setup: unknown }).setup, { ran: true, exitCode: 0, timedOut: false, log: '/state/x.setup.log' })
  const text = tool.output.render({}, value as never).map(block => (block as { text?: string }).text ?? '').join('\n')
  assert.match(text, /exit 0/)
  assert.ok(text.includes('/state/x.setup.log'))
})

test('list answers one line per worktree, with its state and who is bound to it', async () => {
  const { service, calls } = stub()
  const tool = worktreeTool(() => service)
  const value = await tool.execute({ action: 'list', project: '' }, exec())
  assert.deepEqual(calls.list, [undefined])
  await tool.execute({ action: 'list', project: 'acme/widget' }, exec())
  assert.deepEqual(calls.list, [undefined, 'acme/widget'])
  const listed = (value as { worktrees: Array<Record<string, unknown>> }).worktrees
  assert.equal(listed.length, 3)
  assert.deepEqual(listed[0], {
    project: 'acme/widget', slug: 'fix-1', branch: 'dish/fix-1', path: `${CLONE}/.worktrees/fix-1`, base: SHA,
    ahead: 2, behind: 1, dirty: false, merged: false, managed: true,
    bound: [{ child: 'child-7', role: 'coder', title: 'Fix it', running: true }],
  })
  const lines = tool.output.render({}, value as never).map(block => (block as { text?: string }).text ?? '').join('\n').split('\n')
  assert.equal(lines.length, 3)
  assert.match(lines[0]!, /acme\/widget\/fix-1/)
  assert.match(lines[0]!, /ahead 2, behind 1/)
  assert.match(lines[0]!, /child-7 \(coder, running\)/)
  assert.match(lines[1]!, /merged/)
  assert.match(lines[1]!, /dirty/)
  assert.match(lines[2]!, /not made by dish/)

  const empty = worktreeTool(() => stub({ listWorktrees: async () => [] }).service)
  const none = await empty.execute({ action: 'list' }, exec())
  assert.match(empty.output.render({}, none as never).map(block => (block as { text?: string }).text ?? '').join('\n'), /no worktrees/i)
})

test('remove passes force and answers what it removed', async () => {
  const { service, calls } = stub()
  const tool = worktreeTool(() => service)
  const value = await tool.execute({ action: 'remove', project: 'acme/widget', slug: 'fix-1', force: true }, exec())
  assert.deepEqual(calls.remove, [{ project: 'acme/widget', slug: 'fix-1', force: true }])
  await tool.execute({ action: 'remove', project: 'acme/widget', slug: 'fix-2' }, exec())
  assert.deepEqual(calls.remove[1], { project: 'acme/widget', slug: 'fix-2', force: false })
  const text = tool.output.render({}, value as never).map(block => (block as { text?: string }).text ?? '').join('\n')
  assert.match(text, /Removed worktree acme\/widget\/fix-1/)
  assert.match(text, /dish\/fix-1/)
})

test('the service\'s refusals reach the model as plain Errors with its message', async () => {
  const { service } = stub({
    async removeWorktree() {
      throw new Error('worktree fix-1 is bound to a running coder: child-7 (coder, "Fix it"); wait for it to finish, even with force')
    },
  })
  const tool = worktreeTool(() => service)
  await assert.rejects(tool.execute({ action: 'remove', project: 'acme/widget', slug: 'fix-1', force: true }, exec()), /bound to a running coder/)
})
