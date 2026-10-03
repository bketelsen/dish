/**
 * dish-orchestrator's run hooks, as dish-workspaces calls them: a `dishRuns` stub from a sibling plugin, the `worktree`
 * tool driven through dsh's tools service, and the sweep. No hook may be called while a project's lock is held.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import * as plugin from '../src/index.ts'
import { worktreeRecordFile } from '../src/paths.ts'
import type { CreatedForRun, WorkspacesService } from '../src/service.ts'
import { exists } from './onboard-helpers.ts'
import { runOk } from './helpers.ts'
import {
  APP_ID_NAME, PRIVATE_KEY_NAME, credentialsStub, crewStub, fakeTimers, projectOf, projectsStub, provideStub, startServiceWorld,
  useScratchProcess, waitFor, watchLogs,
} from './service-helpers.ts'
import type { ServiceWorld } from './service-helpers.ts'
import { mergedPull } from './worktree-helpers.ts'

useScratchProcess()

const widget = projectOf('acme/widget')

/** What the `dishRuns` stub does: each test sets these. */
interface Hooks {
  created(sessionId: string, created: CreatedForRun): Promise<unknown>
  removed(project: string, slug: string): Promise<void>
}

interface Run {
  world: ServiceWorld
  ctx: Context
  logs: string[]
  service: WorkspacesService
  clone: string
  hooks: Hooks
  calls: { created: Array<{ sessionId: string, created: CreatedForRun }>, removed: Array<{ project: string, slug: string }> }
  tool(args: Record<string, unknown>): Promise<{ isError: boolean, value?: unknown, content: Array<{ type: string, text?: string }> }>
  stop(): Promise<void>
}

/** dsh's tools service, the stubs (dishRuns unless `runs: false`), then dish-workspaces over the fakes, with widget onboarded and ready. */
async function start(options: { runs?: boolean } = {}): Promise<Run> {
  const world = await startServiceWorld()
  const ctx = new Context()
  const logs = watchLogs(ctx)
  const fibers = [provideStub(ctx, 'systemPrompt', { tools() {}, section() {}, getSectionOrder: () => 1 })]
  const tools = ctx.plugin(ToolRuntime, {})
  await tools
  const projects = projectsStub()
  projects.add(widget)
  fibers.push(provideStub(ctx, 'dishProjects', projects.service))
  fibers.push(provideStub(ctx, 'credentials', credentialsStub(world.credentials)))
  fibers.push(provideStub(ctx, 'dishCrew', crewStub().service))
  const calls: Run['calls'] = { created: [], removed: [] }
  const hooks: Hooks = { created: async () => undefined, removed: async () => {} }
  if (options.runs !== false) {
    fibers.push(provideStub(ctx, 'dishRuns', {
      async worktreeCreated(sessionId: string, created: CreatedForRun) {
        calls.created.push({ sessionId, created })
        return hooks.created(sessionId, created)
      },
      async worktreeRemoved(project: string, slug: string) {
        calls.removed.push({ project, slug })
        return hooks.removed(project, slug)
      },
    }))
  }
  for (const fiber of fibers) await fiber
  let service: WorkspacesService | undefined
  const workspaces = ctx.plugin({
    name: plugin.name,
    apply: (inner: Context, config: plugin.Config) => { service = plugin.start(inner, config, world.internals({ timers: fakeTimers() })) },
  } as never, { appIdName: APP_ID_NAME, privateKeyName: PRIVATE_KEY_NAME, terminal: false } as never)
  await workspaces
  await service!.onboard(widget)
  projects.set('acme/widget', 'ready')
  const clone = join(world.workRoot, 'acme', 'widget')
  const agent = { id: 'sess-main', session: { header: { id: 'sess-main', cwd: clone } } }
  return {
    world, ctx, logs, service: service!, clone, hooks, calls,
    tool(args) {
      const runtime = ctx.get('tools') as unknown as {
        execute(call: { callId: string, name: string, arguments: unknown, agent: unknown, signal: AbortSignal }): Promise<{ isError: boolean, value?: unknown, content: Array<{ type: string, text?: string }> }>
      }
      return runtime.execute({ callId: `c-${Math.random()}`, name: 'worktree', arguments: args, agent, signal: new AbortController().signal })
    },
    async stop() {
      await workspaces.dispose()
      for (const fiber of fibers.reverse()) await fiber.dispose()
      await tools.dispose()
    },
  }
}

/** `promise`, or a failure naming `what` after `ms`: a deadlock fails the test instead of hanging it. */
async function within<T>(what: string, promise: Promise<T>, ms = 20_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${what} didn't finish: a deadlock?`)), ms) })])
  } finally {
    clearTimeout(timer)
  }
}

function text(result: { content: Array<{ type: string, text?: string }> }): string {
  return result.content.map(block => block.text ?? '').join('\n')
}

test("the worktree tool's create asks worktreeCreated with the caller's session and the new worktree, baseRef included, and its answer gives the run", async () => {
  const run = await start()
  try {
    run.hooks.created = async () => ({ id: '20261003-fix-1', opened: true })
    const result = await run.tool({ action: 'create', project: 'acme/widget', slug: 'fix-1' })
    assert.equal(result.isError, false, text(result))
    const path = join(run.clone, '.worktrees', 'fix-1')
    const base = (await runOk('git', ['-C', path, 'rev-parse', 'HEAD'], { env: run.world.env })).trim()
    assert.deepEqual(run.calls.created, [{
      sessionId: 'sess-main',
      created: { project: 'acme/widget', slug: 'fix-1', branch: 'dish/fix-1', path, clone: run.clone, base, baseRef: 'origin/main' },
    }])
    assert.deepEqual((result.value as { run?: unknown }).run, { id: '20261003-fix-1', opened: true })
    assert.match(text(result), /Opened run `20261003-fix-1` for this worktree/)

    run.hooks.created = async () => ({ id: '20261003-fix-1', opened: false })
    const joined = await run.tool({ action: 'create', project: 'acme/widget', slug: 'fix-2', base: 'origin/main' })
    assert.equal(run.calls.created[1]!.created.baseRef, 'origin/main')
    assert.match(text(joined), /It is task `fix-2` of run `20261003-fix-1`, which this chat drives\./)
  } finally {
    await run.stop()
  }
})

test("worktreeCreated is called outside the project's lock: a hook that calls removeWorktree of another worktree of the same project (a test of the rule, not something dish-orchestrator does) finishes", async () => {
  const run = await start()
  try {
    await run.service.createWorktree('acme/widget', 'other', undefined, { cwd: run.clone })
    run.hooks.created = async () => {
      await run.service.removeWorktree('acme/widget', 'other', true)
      return { id: '20261003-fix-1', opened: true }
    }
    const result = await within('the tool\'s create', run.tool({ action: 'create', project: 'acme/widget', slug: 'fix-1' }))
    assert.equal(result.isError, false, text(result))
    assert.equal(await exists(join(run.clone, '.worktrees', 'other')), false)
    assert.deepEqual((result.value as { run?: unknown }).run, { id: '20261003-fix-1', opened: true })
  } finally {
    await run.stop()
  }
})

test('worktreeCreated that throws or answers malformed leaves the worktree and its record, logs once, and gives runProblem', async () => {
  const run = await start()
  try {
    run.hooks.created = async () => { throw new Error('the run store is unreadable') }
    const thrown = await run.tool({ action: 'create', project: 'acme/widget', slug: 'fix-1' })
    assert.equal(thrown.isError, false, text(thrown))
    assert.equal((thrown.value as { runProblem?: string }).runProblem, 'the run store is unreadable')
    assert.equal('run' in (thrown.value as object), false)
    assert.match(text(thrown), /dish couldn't add it to a run: the run store is unreadable\./)
    assert.ok(await exists(join(run.clone, '.worktrees', 'fix-1')))
    assert.ok(await exists(worktreeRecordFile(run.world.state, 'acme', 'widget', 'fix-1')))
    assert.equal(await run.service.resolve('acme/widget/fix-1') !== undefined, true)
    // The same failure again is not logged again.
    await run.tool({ action: 'create', project: 'acme/widget', slug: 'fix-2' })
    const warned = run.logs.filter(line => line.includes('the run store is unreadable'))
    assert.equal(warned.length, 1, run.logs.join('\n'))
    assert.match(warned[0]!, /^\[dish-workspaces\] warn: dish-orchestrator could not add worktree acme\/widget\/fix-1 to a run: the run store is unreadable$/)

    run.hooks.created = async () => ({ id: 7 })
    const odd = await run.tool({ action: 'create', project: 'acme/widget', slug: 'fix-3' })
    assert.equal((odd.value as { runProblem?: string }).runProblem, 'dish-orchestrator gave a malformed run')
    assert.ok(await exists(worktreeRecordFile(run.world.state, 'acme', 'widget', 'fix-3')))
    assert.equal(run.logs.filter(line => line.includes('malformed run')).length, 1)
  } finally {
    await run.stop()
  }
})

test('without dishRuns nothing is asked and there is no run or runProblem; createWorktree called directly (as run open does) asks nothing', async () => {
  const bare = await start({ runs: false })
  try {
    const result = await bare.tool({ action: 'create', project: 'acme/widget', slug: 'fix-1' })
    assert.equal(result.isError, false, text(result))
    assert.equal('run' in (result.value as object), false)
    assert.equal('runProblem' in (result.value as object), false)
    assert.equal(text(result).split('\n').length, 3)
    const removed = await bare.tool({ action: 'remove', project: 'acme/widget', slug: 'fix-1', force: true })
    assert.equal(removed.isError, false, text(removed))
  } finally {
    await bare.stop()
  }
  const run = await start()
  try {
    const created = await run.service.createWorktree('acme/widget', 'fix-1', undefined, { cwd: run.clone })
    assert.equal(created.baseRef, 'origin/main')
    await run.service.removeWorktree('acme/widget', 'fix-1', true)
    await run.service.idle()
    assert.deepEqual(run.calls, { created: [], removed: [] })
  } finally {
    await run.stop()
  }
})

test("the tool's remove calls worktreeRemoved once, after the removal; a throw is logged once and the removal stands", async () => {
  const run = await start()
  try {
    await run.service.createWorktree('acme/widget', 'fix-1', undefined, { cwd: run.clone })
    await run.service.createWorktree('acme/widget', 'fix-2', undefined, { cwd: run.clone })
    const seen: boolean[] = []
    run.hooks.removed = async (_project, slug) => {
      // After the removal, and outside the lock: the project's lock can be taken from here.
      seen.push(await exists(join(run.clone, '.worktrees', slug)))
      await run.service.listWorktrees('acme/widget')
    }
    const removed = await within('the tool\'s remove', run.tool({ action: 'remove', project: 'acme/widget', slug: 'fix-1', force: true }))
    assert.equal(removed.isError, false, text(removed))
    assert.deepEqual(run.calls.removed, [{ project: 'acme/widget', slug: 'fix-1' }])
    assert.deepEqual(seen, [false])

    run.hooks.removed = async () => { throw new Error('the ledger is gone') }
    const second = await run.tool({ action: 'remove', project: 'acme/widget', slug: 'fix-2', force: true })
    assert.equal(second.isError, false, text(second))
    assert.equal(await exists(join(run.clone, '.worktrees', 'fix-2')), false)
    assert.deepEqual(run.calls.removed.map(call => call.slug), ['fix-1', 'fix-2'])
    const warned = run.logs.filter(line => line.includes('the ledger is gone'))
    assert.equal(warned.length, 1, run.logs.join('\n'))
    // A refused removal tells nothing.
    const refused = await run.tool({ action: 'remove', project: 'acme/widget', slug: 'nothing' })
    assert.equal(refused.isError, true)
    assert.equal(run.calls.removed.length, 2)
  } finally {
    await run.stop()
  }
})

test("the sweep calls worktreeRemoved once per worktree it removed, after the project's lock is released: a hook held on a promise doesn't hold a createWorktree of the project", async () => {
  const run = await start()
  try {
    /** Worktrees `slugs`, made (and their background sweeps done), then each with a commit whose pull request merged. */
    const merged = async (...slugs: string[]): Promise<void> => {
      const made = []
      for (const slug of slugs) made.push(await run.service.createWorktree('acme/widget', slug, undefined, { cwd: run.clone }))
      await run.service.idle()
      const env = run.world.env
      for (const [index, worktree] of made.entries()) {
        await runOk('git', ['-C', worktree.path, 'commit', '-q', '--allow-empty', '-m', worktree.slug], { env })
        const tip = (await runOk('git', ['-C', worktree.path, 'rev-parse', 'HEAD'], { env })).trim()
        run.world.github.pulls.set(tip, [mergedPull(index + 1, tip, worktree.branch)])
      }
    }
    await merged('one', 'two')
    run.calls.removed.length = 0
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    run.hooks.removed = () => gate
    const swept = await within('the sweep', run.service.sweep('acme/widget'))
    assert.deepEqual(swept.removed.map(item => item.slug).sort(), ['one', 'two'])
    // The first hook is held: the project's lock is free all the same.
    await waitFor('the first hook', () => run.calls.removed.length === 1)
    const next = await within('a createWorktree while the hook is held', run.service.createWorktree('acme/widget', 'three', undefined, { cwd: run.clone }))
    assert.equal(next.slug, 'three')
    // One after the other: the second waits for the first.
    assert.equal(run.calls.removed.length, 1)
    release()
    await run.service.idle()
    assert.deepEqual(run.calls.removed.map(call => [call.project, call.slug]).sort(), [['acme/widget', 'one'], ['acme/widget', 'two']])

    // A hook that throws is logged once per error, and the sweep goes on.
    await merged('four', 'five')
    run.calls.removed.length = 0
    run.hooks.removed = async () => { throw new Error('no ledger') }
    await run.service.sweep('acme/widget')
    await run.service.idle()
    assert.deepEqual(run.calls.removed.map(call => call.slug).sort(), ['five', 'four'])
    assert.equal(run.logs.filter(line => line.includes('no ledger')).length, 1, run.logs.join('\n'))
  } finally {
    await run.stop()
  }
})
