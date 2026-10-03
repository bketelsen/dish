import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { CreatedForRun, DishWorkspaces, RunsHooks } from '../src/service.ts'
import { MAIN_ONLY, worktreeTool } from '../src/tool.ts'
import { worktreeSetupReason } from '../src/worktrees.ts'
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
        setup: { ran: false, reason: worktreeSetupReason(`${CLONE}/.worktrees/${slug}`, 'pnpm install') },
        baseRef: base ?? 'origin/main',
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
  assert.equal((answer.setup as { reason: string }).reason, worktreeSetupReason(`${CLONE}/.worktrees/fix-1`, 'pnpm install'))
  const text = tool.output.render({}, value as never).map(block => (block as { text?: string }).text ?? '').join('\n')
  assert.ok(text.includes(`${CLONE}/.worktrees/fix-1`))
  assert.ok(text.includes('dish/fix-1'))
  assert.ok(text.includes(SHA))
  assert.match(text, /delegate/)
  // What setup didn't do is said once, with how it goes ahead: in the sandbox, before the work starts, escalated only if that fails.
  assert.equal(text.match(/setup didn't run/gi)?.length, 1, text)
  assert.ok(text.includes(`Setup didn't run outside the sandbox: a worktree picks up config from the clone, which agents can change. `
    + `Run it in ${CLONE}/.worktrees/fix-1 in the sandbox before the work starts (yourself, or tell the coder to run it first): pnpm install. `
    + 'If it fails with "Read-only file system", run it again escalated (`sandbox_permissions: "danger-full-access"`), '
    + 'so the judge allows it or asks the user; a coder can\'t escalate, and reports it instead.'), text)

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
        baseRef: 'origin/main',
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

// --- dish-orchestrator's hooks (step 7) -----------------------------------------------------------------------------

/** A `dishRuns` that records what the tool tells it, and answers `answer`. */
function runsStub(answer: (sessionId: string, created: CreatedForRun) => Promise<unknown> = async () => undefined) {
  const order: string[] = []
  const created: Array<{ sessionId: string, created: CreatedForRun }> = []
  const removed: Array<{ project: string, slug: string }> = []
  const hooks = {
    async worktreeCreated(sessionId: string, made: CreatedForRun) {
      order.push('worktreeCreated')
      created.push({ sessionId, created: made })
      return answer(sessionId, made)
    },
    async worktreeRemoved(project: string, slug: string) {
      order.push('worktreeRemoved')
      removed.push({ project, slug })
    },
  } as RunsHooks
  return { hooks, order, created, removed }
}

function rendered(tool: ReturnType<typeof worktreeTool>, value: unknown): string {
  return tool.output.render({}, value as never).map(block => (block as { text?: string }).text ?? '').join('\n')
}

test('create asks the runs stub with String(exec.agent.id) (\'sess-1\') and the created worktree', async () => {
  const { service, calls } = stub()
  const runs = runsStub(async () => ({ id: '20261003-fix-1', opened: true }))
  const tool = worktreeTool(() => service, () => runs.hooks)
  const signal = new AbortController().signal
  await tool.execute({ action: 'create', project: 'acme/widget', slug: 'fix-1', base: 'origin/dish/plan' }, exec({ signal }))
  // createWorktree gets no session: only the hook does.
  assert.deepEqual(calls.create, [{ project: 'acme/widget', slug: 'fix-1', base: 'origin/dish/plan', cwd: CLONE, signal }])
  assert.deepEqual(runs.created, [{
    sessionId: 'sess-1',
    created: {
      project: 'acme/widget', slug: 'fix-1', branch: 'dish/fix-1', path: `${CLONE}/.worktrees/fix-1`, clone: CLONE, base: SHA, baseRef: 'origin/dish/plan',
    },
  }])
  // A numeric agent id is the same string crew's delegate takes.
  const numeric = { agent: { id: 42, session: { header: { id: 'x', cwd: CLONE } } }, signal } as unknown as ToolRunContext
  await tool.execute({ action: 'create', project: 'acme/widget', slug: 'fix-2' }, numeric)
  assert.equal(runs.created[1]!.sessionId, '42')
  assert.equal(runs.created[1]!.created.baseRef, 'origin/main')
})

test('create\'s answer says the run it opened, or the task it joined, or why there is none; without a run, its text is today\'s', async () => {
  const { service } = stub()
  const plain = worktreeTool(() => service)
  const none = await plain.execute({ action: 'create', project: 'acme/widget', slug: 'fix-1' }, exec())
  const today = rendered(plain, none)
  assert.equal('run' in (none as object), false)
  assert.equal('runProblem' in (none as object), false)
  assert.equal(today.split('\n').length, 3)
  assert.match(today.split('\n')[2]!, /^Bind a coder to it with delegate's `worktree`/)

  const answers: unknown[] = [
    { id: '20261003-fix-1', opened: true },
    { id: '20261003-fix-1', opened: false },
    undefined,
  ]
  let next = 0
  const runs = runsStub(async () => answers[next++])
  const tool = worktreeTool(() => service, () => runs.hooks)
  const opened = await tool.execute({ action: 'create', project: 'acme/widget', slug: 'fix-1' }, exec())
  assert.deepEqual((opened as { run?: unknown }).run, { id: '20261003-fix-1', opened: true })
  assert.equal(rendered(tool, opened), `${today}\nOpened run \`20261003-fix-1\` for this worktree; \`run\` with \`action: goal\` names it, and \`open_pr\` ends it.`)
  const joined = await tool.execute({ action: 'create', project: 'acme/widget', slug: 'fix-1' }, exec())
  assert.deepEqual((joined as { run?: unknown }).run, { id: '20261003-fix-1', opened: false })
  assert.equal(rendered(tool, joined), `${today}\nIt is task \`fix-1\` of run \`20261003-fix-1\`, which this chat drives.`)
  // A run opened in another project releases the chat's run there: the answer says which, and how to take it back.
  answers.splice(next, 0, { id: '20261003-fix-1', opened: true, released: '20261002-feat' })
  const switched = await tool.execute({ action: 'create', project: 'acme/widget', slug: 'fix-1' }, exec())
  assert.deepEqual((switched as { run?: unknown }).run, { id: '20261003-fix-1', opened: true, released: '20261002-feat' })
  assert.equal(rendered(tool, switched), `${today}\nOpened run \`20261003-fix-1\` for this worktree; \`run\` with \`action: goal\` names it, and \`open_pr\` ends it.\n`
    + 'Released run `20261002-feat`: it stays open, and `run` `resume` takes it back.')
  // A `released` that isn't a run id is left out; the run stands.
  answers.splice(next, 0, { id: '20261003-fix-1', opened: true, released: '../x' }, { id: '20261003-fix-1', opened: true, released: 42 })
  for (let index = 0; index < 2; index++) {
    const odd = await tool.execute({ action: 'create', project: 'acme/widget', slug: 'fix-1' }, exec())
    assert.deepEqual((odd as { run?: unknown }).run, { id: '20261003-fix-1', opened: true })
    assert.equal('runProblem' in (odd as object), false)
  }
  // No run (dish-orchestrator gave none): no field, and today's text.
  const nothing = await tool.execute({ action: 'create', project: 'acme/widget', slug: 'fix-1' }, exec())
  assert.equal('run' in (nothing as object), false)
  assert.equal(rendered(tool, nothing), today)

  // A malformed answer, and a throw (masked, cut, logged once): the worktree stands, and the answer says why there's no run.
  const warnings: string[] = []
  const warn = (format: string, ...args: unknown[]) => { warnings.push([format, ...args].map(String).join(' ')) }
  for (const bad of [{ id: '../x', opened: true }, { id: 42 }, 'run', { id: '' }]) {
    const odd = worktreeTool(() => service, () => runsStub(async () => bad).hooks, { warn })
    const value = await odd.execute({ action: 'create', project: 'acme/widget', slug: 'fix-1' }, exec())
    assert.equal((value as { runProblem?: string }).runProblem, 'dish-orchestrator gave a malformed run', JSON.stringify(bad))
    assert.equal(rendered(odd, value), `${today}\ndish couldn't add it to a run: dish-orchestrator gave a malformed run.`)
  }
  const token = `ghs_${'T'.repeat(36)}`
  const failing = worktreeTool(() => service, () => runsStub(async () => { throw new Error(`no store: ${token} ${'x'.repeat(400)}`) }).hooks, { warn })
  const failed = await failing.execute({ action: 'create', project: 'acme/widget', slug: 'fix-1' }, exec())
  const problem = (failed as { runProblem: string }).runProblem
  assert.ok(problem.startsWith('no store: '), problem)
  assert.ok(!problem.includes(token))
  assert.ok(Array.from(problem).length <= 300)
  assert.equal('run' in (failed as object), false)
  assert.match(rendered(failing, failed), /\ndish couldn't add it to a run: no store: /)
  assert.equal(warnings.filter(line => line.includes('no store')).length, 1)
  assert.ok(warnings.every(line => !line.includes(token)))
})

test('remove tells the runs stub after the removal', async () => {
  const order: string[] = []
  const { service } = stub({ async removeWorktree() { order.push('removeWorktree') } })
  const runs = runsStub()
  const tool = worktreeTool(() => service, () => ({
    worktreeCreated: runs.hooks.worktreeCreated,
    async worktreeRemoved(project, slug) {
      order.push('worktreeRemoved')
      await runs.hooks.worktreeRemoved(project, slug)
    },
  }))
  await tool.execute({ action: 'remove', project: 'acme/widget', slug: 'fix-1', force: true }, exec())
  assert.deepEqual(order, ['removeWorktree', 'worktreeRemoved'])
  assert.deepEqual(runs.removed, [{ project: 'acme/widget', slug: 'fix-1' }])

  // A removal that fails tells nothing.
  const refusing = stub({ async removeWorktree() { throw new Error('worktree fix-1 isn\'t merged') } })
  const told = runsStub()
  await assert.rejects(worktreeTool(() => refusing.service, () => told.hooks).execute({ action: 'remove', project: 'acme/widget', slug: 'fix-1' }, exec()), /isn't merged/)
  assert.deepEqual(told.removed, [])

  // A hook that throws is logged, and the removal stands.
  const warnings: string[] = []
  const throwing = worktreeTool(() => service, () => ({ worktreeCreated: runs.hooks.worktreeCreated, async worktreeRemoved() { throw new Error('the ledger is gone') } }), {
    warn: (format, ...args) => { warnings.push([format, ...args].map(String).join(' ')) },
  })
  const value = await throwing.execute({ action: 'remove', project: 'acme/widget', slug: 'fix-2' }, exec())
  assert.deepEqual(value, { action: 'remove', project: 'acme/widget', slug: 'fix-2', branch: 'dish/fix-2', forced: false })
  assert.equal(warnings.length, 1)
  assert.match(warnings[0]!, /the ledger is gone/)
  // Without dish-orchestrator, nothing is told.
  await worktreeTool(() => service, () => undefined).execute({ action: 'remove', project: 'acme/widget', slug: 'fix-3' }, exec())
})

test('the output schema dsh accepts includes run and runProblem', () => {
  const tool = worktreeTool(() => undefined, () => undefined)
  assertSupportedJsonSchema(tool.output.schema as never)
  // dsh's schema keeps each object's required properties in its `required` list.
  type Shape = { type?: string, required?: string[], properties?: Record<string, Shape> }
  const create = (tool.output.schema as { oneOf: Shape[] }).oneOf[0]!
  assert.equal(create.properties?.run?.type, 'object')
  assert.deepEqual(Object.keys(create.properties?.run?.properties ?? {}).sort(), ['id', 'opened', 'released'])
  // `released` is optional: dish-orchestrator gives it only for a run it released.
  assert.deepEqual([...(create.properties?.run?.required ?? [])].sort(), ['id', 'opened'])
  assert.equal(create.properties?.runProblem?.type, 'string')
  assert.ok(create.required?.includes('setup'))
  assert.ok(!create.required?.includes('run') && !create.required?.includes('runProblem'))
  assert.match(tool.description, /When dish keeps runs \(dish-orchestrator\), `create` also adds the worktree to the run this chat drives, or opens one; its answer says which\./)
})
