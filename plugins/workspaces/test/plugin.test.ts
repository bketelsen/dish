import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import * as configPlugin from 'dish-config'
import * as projectsPlugin from 'dish-projects'
import type { DishProjects, ProjectStatus } from 'dish-projects'
import { PROJECTS_PATH, serializeProjects } from 'dish-projects/registry'
import * as plugin from '../src/index.ts'
import { helperValue, scratchRecordFile, tokensDir } from '../src/paths.ts'
import type { DishWorkspaces } from '../src/service.ts'
import { exists, filesHolding } from './onboard-helpers.ts'
import { runOk, tempDir } from './helpers.ts'
import {
  APP_ID_NAME, HELPER, PRIVATE_KEY_NAME, credentialsStub, crewStub, mountRegistryOn, projectOf, projectsStub, provideStub, startServiceWorld,
  useScratchProcess, waitFor, watchLogs,
} from './service-helpers.ts'
import type { MountedRegistry, ServiceWorld } from './service-helpers.ts'
import { mergedPull } from './worktree-helpers.ts'

useScratchProcess()

const USER = { kind: 'user' } as const
const FIELDS = { family: 'acme', role: 'a test project', gate: 'true', gateTimeout: '1m' }

/** dish-workspaces as dsh would mount it, but with the test's internals (the fakes, temp directories). */
function mountWorkspaces(ctx: Context, world: ServiceWorld) {
  return ctx.plugin({
    name: plugin.name,
    apply: (inner: Context, config: plugin.Config) => { plugin.start(inner, config, world.internals()) },
  } as never, { appIdName: APP_ID_NAME, privateKeyName: PRIVATE_KEY_NAME, terminal: false } as never)
}

interface Run {
  world: ServiceWorld
  ctx: Context
  logs: string[]
  statuses: Array<[string, ProjectStatus]>
  crew: ReturnType<typeof crewStub>
  registry: MountedRegistry | undefined
  workspaces: ReturnType<typeof mountWorkspaces>
  projects: () => DishProjects
  service: () => DishWorkspaces | undefined
  write(text: string): Promise<unknown>
  stop(): Promise<void>
}

/**
 * dsh's tools service, dish-config on a temp store, a credentials stub with the App's test key, a dishCrew stub, dsh's
 * real workspace registry (unless `registry: false`), the real dish-projects, then dish-workspaces over the fakes.
 */
async function start(options: { registry?: boolean } = {}): Promise<Run> {
  const world = await startServiceWorld()
  // dish-projects keeps its status file under DSH_DISH_HOME: a fresh one per test.
  process.env.DSH_DISH_HOME = join(world.dir, 'inst')
  const ctx = new Context()
  const logs = watchLogs(ctx, true)
  const statuses: Array<[string, ProjectStatus]> = []
  ctx.on('dish-projects/status', (name, status) => { statuses.push([name, status]) })
  await provideStub(ctx, 'systemPrompt', { tools() {}, section() {}, getSectionOrder: () => 1 })
  const tools = ctx.plugin(ToolRuntime, {})
  await tools
  const config = ctx.plugin(configPlugin, { terminal: false, repository: join(world.dir, 'config.git'), userName: 'Test User', userEmail: 'test@example.test' } as configPlugin.Config)
  await config
  const credentials = provideStub(ctx, 'credentials', credentialsStub(world.credentials))
  await credentials
  const crew = crewStub()
  const crewFiber = provideStub(ctx, 'dishCrew', crew.service)
  await crewFiber
  const registry = options.registry === false ? undefined : await mountRegistryOn(ctx, join(world.dir, 'dsh'))
  const projects = ctx.plugin(projectsPlugin, { terminal: false } as projectsPlugin.Config)
  await projects
  await waitFor('projects.yaml to be seeded', async () => (await ctx.dishConfig.read(PROJECTS_PATH)) !== undefined)
  const run: Run = {
    world, ctx, logs, statuses, crew, registry,
    workspaces: mountWorkspaces(ctx, world),
    projects: () => ctx.get('dishProjects') as DishProjects,
    service: () => ctx.get('dishWorkspaces') as DishWorkspaces | undefined,
    write: text => ctx.dishConfig.write([{ path: PROJECTS_PATH, text }], { author: USER }),
    async stop() {
      await run.workspaces.dispose()
      await projects.dispose()
      await registry?.stop()
      await crewFiber.dispose()
      await credentials.dispose()
      await config.dispose()
      await tools.dispose()
    },
  }
  await run.workspaces
  return run
}

const waitState = (run: Run, name: string, state: ProjectStatus['state']) =>
  waitFor(`${name} to be ${state} (now ${JSON.stringify(run.projects().status(name))})`, () => run.projects().status(name).state === state)

/** The main agent of a chat whose workspace is `cwd`. */
function mainAgent(cwd: string) {
  return { id: 'sess-main', session: { header: { id: 'sess-main', cwd } } }
}

async function callTool(run: Run, args: Record<string, unknown>, agent: unknown) {
  const tools = run.ctx.get('tools') as unknown as {
    execute(call: { callId: string, name: string, arguments: unknown, agent: unknown, signal: AbortSignal }): Promise<{ isError: boolean, value?: unknown, content: Array<{ type: string, text?: string }> }>
  }
  return tools.execute({ callId: `c-${Math.random()}`, name: 'worktree', arguments: args, agent, signal: new AbortController().signal })
}

test('the config: appIdName, privateKeyName and terminal, with defaults; a name that isn\'t an environment variable\'s fails the load', () => {
  const parse = plugin.Config as unknown as (value: unknown) => unknown
  assert.deepEqual(parse({}), { appIdName: 'DISH_GITHUB_APP_ID', privateKeyName: 'DISH_GITHUB_APP_PRIVATE_KEY', terminal: true })
  assert.equal(plugin.name, 'dish-workspaces')
  assert.throws(() => plugin.start(new Context(), { appIdName: 'not a name', privateKeyName: PRIVATE_KEY_NAME, terminal: false }, {}), /appIdName must be an environment variable name/)
  assert.throws(() => plugin.start(new Context(), { appIdName: APP_ID_NAME, privateKeyName: '1KEY', terminal: false }, {}), /privateKeyName must be an environment variable name/)
})

test('end to end: a project in projects.yaml is onboarded; a restart prepares it; worktrees are made, resolved, listed, bound and swept; dispose leaves no token', async () => {
  const run = await start()
  const { world } = run
  const clone = join(world.workRoot, 'acme', 'widget')
  const tokenFile = join(tokensDir(world.state), 'acme')
  try {
    // 1. Onboarding, driven by dish-projects.
    await run.write(serializeProjects({ 'acme/widget': FIELDS }))
    await waitState(run, 'acme/widget', 'ready')
    assert.ok((await stat(join(clone, '.git'))).isDirectory())
    const record = await run.registry!.registry.resolveByPath(clone)
    assert.equal(record?.title, 'acme/widget')
    assert.equal((await stat(tokenFile)).mode & 0o777, 0o600)
    assert.deepEqual(await filesHolding(join(clone, '.git'), 'ghs_'), [])
    assert.deepEqual((await filesHolding(world.state, 'ghs_')).filter(file => file !== tokenFile), [])
    for (const line of run.logs) assert.ok(!line.includes('ghs_'), line)
    assert.deepEqual(run.service()!.describe('acme/widget'), {
      clone, adopted: false, workspace: { id: record!.id, title: 'acme/widget' }, lastFetch: null, worktrees: 0,
    })
    // The scratch workspace, once.
    await waitFor('the scratch workspace', () => exists(scratchRecordFile(world.state)))
    const scratchOnes = () => run.registry!.registry.list().filter(item => item.title === 'scratch')
    assert.equal(scratchOnes().length, 1)
    assert.equal(scratchOnes()[0]!.path, join(world.workRoot, 'scratch'))

    // 2. A restart: not onboarded again, but prepared, which puts back a helper path changed by hand.
    const web = world.git.origin
    const current = helperValue(HELPER, tokensDir(world.state), web)
    const older = helperValue('/old/checkout/plugins/workspaces/bin/git-credential-dish', tokensDir(world.state), web)
    const config = join(clone, '.git', 'config')
    const installationLookups = () => world.github.requests.filter(request => request.path === '/repos/acme/widget/installation').length
    const lookups = installationLookups()
    await run.workspaces.dispose()
    assert.equal(await exists(tokenFile), false, 'a stopped dish-workspaces leaves no token file')
    await writeFile(config, (await readFile(config, 'utf8')).replace(current, older))
    const seen = run.statuses.length
    run.workspaces = mountWorkspaces(run.ctx, world)
    await run.workspaces
    await waitFor('prepare to put the helper back', async () => (await readFile(config, 'utf8')).includes(current))
    await waitFor('prepare\'s fetch', () => run.service()!.describe('acme/widget')?.lastFetch?.ok)
    assert.equal(installationLookups(), lookups, 'not onboarded again')
    assert.ok(run.statuses.slice(seen).every(([, status]) => status.state === 'ready'), JSON.stringify(run.statuses.slice(seen)))
    assert.equal(run.projects().status('acme/widget').state, 'ready')
    assert.equal(scratchOnes().length, 1, 'the scratch workspace isn\'t registered again')
    await waitFor('the token file again', () => exists(tokenFile))

    // 3. A worktree, through the tool, from a chat in the clone.
    const created = await callTool(run, { action: 'create', project: 'acme/widget', slug: 'feature' }, mainAgent(clone))
    assert.equal(created.isError, false, created.content.map(block => block.text).join('\n'))
    const value = created.value as { path: string, branch: string, base: string, setup: { ran: boolean, reason: string } }
    assert.equal(value.path, join(clone, '.worktrees', 'feature'))
    assert.equal(value.branch, 'dish/feature')
    assert.equal(value.setup.ran, false)
    // A child is refused.
    const child = await callTool(run, { action: 'list' }, { id: 'c', session: { header: { id: 'c', cwd: clone, delegationDepth: 1 } } })
    assert.equal(child.isError, true)
    // resolve: by ref (any case of the project), by path, and by a path through a link (crew's records are canonical).
    const byRef = await run.service()!.resolve('ACME/widget/feature')
    assert.deepEqual(byRef, { project: 'acme/widget', slug: 'feature', branch: 'dish/feature', path: value.path, clone, base: value.base })
    assert.deepEqual(await run.service()!.resolve(value.path), byRef)
    const link = join(await tempDir(), 'link')
    await symlink(world.workRoot, link)
    assert.deepEqual(await run.service()!.resolve(join(link, 'acme', 'widget', '.worktrees', 'feature')), byRef)
    assert.equal(await run.service()!.resolve('acme/widget/nothing'), undefined)
    assert.equal(await run.service()!.resolve('acme/other/feature'), undefined)
    assert.equal(await run.service()!.resolveProblem('acme/widget/feature'), undefined)
    assert.equal(await run.service()!.resolveProblem('acme/widget/nothing'), undefined)
    // A clone that fails dish's safety check: resolve gives nothing, and resolveProblem says why.
    await runOk('git', ['-C', clone, 'config', 'core.pager', 'less'], { env: world.env })
    assert.equal(await run.service()!.resolve('acme/widget/feature'), undefined)
    assert.equal(await run.service()!.resolveProblem('acme/widget/feature'),
      `acme/widget's clone (${clone}) failed dish's safety check: .git/config sets core.pager, which dish doesn't allow`)
    await runOk('git', ['-C', clone, 'config', '--unset', 'core.pager'], { env: world.env })

    // list shows who is bound (dishCrew), and remove refuses while that child runs.
    run.crew.bindings.set(value.path, [{ child: 'child-1', sessionId: 'sess-main', role: 'coder', title: 'Build it', running: true }])
    const listed = await run.service()!.listWorktrees('acme/widget')
    assert.equal(listed.length, 1)
    assert.deepEqual(listed[0]!.bound, [{ child: 'child-1', role: 'coder', title: 'Build it', running: true }])
    assert.equal(listed[0]!.managed, true)
    const listedByTool = await callTool(run, { action: 'list', project: '' }, mainAgent(clone))
    assert.match(listedByTool.content.map(block => block.text).join('\n'), /child-1 \(coder, running\)/)
    await assert.rejects(run.service()!.removeWorktree('acme/widget', 'feature', true), /bound to a running coder/)
    run.crew.bindings.clear()

    // 4. The sweep: a branch whose pull request merged goes; a merged but dirty one, and a new one, stay.
    const made = {
      merged: await run.service()!.createWorktree('acme/widget', 'merged-one', undefined, { cwd: clone }),
      dirty: await run.service()!.createWorktree('acme/widget', 'dirty-one', undefined, { cwd: clone }),
    }
    // Each create sweeps its project in the background, under the lock: a sweep asked for now runs after those.
    const quiet = await run.service()!.sweep('acme/widget')
    assert.deepEqual(quiet.removed, [], 'new worktrees are never merged')
    const commit = async (slug: string, path: string): Promise<string> => {
      await writeFile(join(path, `${slug}.txt`), `${slug}\n`)
      await runOk('git', ['-C', path, 'add', `${slug}.txt`], { env: world.env })
      await runOk('git', ['-C', path, 'commit', '-q', '-m', slug], { env: world.env })
      const tip = (await runOk('git', ['-C', path, 'rev-parse', 'HEAD'], { env: world.env })).trim()
      world.github.pulls.set(tip, [mergedPull(slug.length, tip, `dish/${slug}`)])
      return tip
    }
    await commit('merged-one', made.merged.path)
    await commit('dirty-one', made.dirty.path)
    const merged = made.merged
    await writeFile(join(made.dirty.path, 'scratch.txt'), 'not committed\n')
    const swept = await run.service()!.sweep()
    assert.deepEqual(swept.removed, [{ project: 'acme/widget', slug: 'merged-one', by: 'pull-request' }])
    assert.deepEqual(swept.kept.map(item => [item.slug, item.reason]).sort(), [['dirty-one', 'dirty'], ['feature', 'not-merged']])
    assert.equal(await exists(merged.path), false)
    const branches = await runOk('git', ['-C', clone, 'branch', '--list', 'dish/*', '--format=%(refname:short)'], { env: world.env })
    assert.deepEqual(branches.trim().split('\n').sort(), ['dish/dirty-one', 'dish/feature'])
    assert.equal(run.service()!.describe('acme/widget')!.worktrees, 2)

    // The tool removes one dish made.
    const removed = await callTool(run, { action: 'remove', project: 'acme/widget', slug: 'feature', force: true }, mainAgent(clone))
    assert.equal(removed.isError, false, removed.content.map(block => block.text).join('\n'))
    assert.equal(await exists(join(clone, '.worktrees', 'feature')), false)
  } finally {
    await run.stop()
  }
  // 5. Disposed: no token file, and nothing left running.
  assert.deepEqual(await readdir(tokensDir(world.state)), [])
  for (const line of run.logs) assert.ok(!line.includes('ghs_'), line)
  assert.deepEqual(run.logs.filter(line => /\] error:/.test(line)), [])
})

test('without a registry a project becomes ready with no workspace; a registry mounted later registers it, and the scratch workspace', async () => {
  const run = await start({ registry: false })
  let registry: MountedRegistry | undefined
  try {
    await run.write(serializeProjects({ 'acme/widget': FIELDS }))
    await waitState(run, 'acme/widget', 'ready')
    assert.equal(run.service()!.describe('acme/widget')!.workspace, null)
    const clone = join(run.world.workRoot, 'acme', 'widget')
    registry = await mountRegistryOn(run.ctx, join(run.world.dir, 'dsh'))
    const workspace = await waitFor('the workspace', () => run.service()!.describe('acme/widget')!.workspace ?? undefined)
    assert.equal(workspace.title, 'acme/widget')
    assert.equal((await registry.registry.resolveByPath(clone))?.id, workspace.id)
    await waitFor('the scratch workspace', () => registry!.registry.list().some(item => item.title === 'scratch'))
  } finally {
    await run.stop()
    await registry?.stop()
  }
})

test('dish-workspaces stopping mid-onboarding kills its setup and leaves the project pending, never failed; back, it adopts the clone and skips setup', async () => {
  const run = await start()
  try {
    const dir = await tempDir()
    const pidFile = join(dir, 'setup.pid')
    const go = join(dir, 'go')
    const setup = `echo $$ > '${pidFile}'; while [ ! -f '${go}' ]; do sleep 0.05; done`
    await run.write(serializeProjects({ 'acme/widget': { ...FIELDS, setup } }))
    await waitState(run, 'acme/widget', 'setup')
    const pid = Number(await waitFor('setup to start', async () => (await readFile(pidFile, 'utf8').catch(() => '')).trim() || undefined))
    await run.workspaces.dispose()
    assert.throws(() => process.kill(pid, 0), 'setup was killed before dish-workspaces finished stopping')
    await waitState(run, 'acme/widget', 'pending')
    assert.deepEqual(run.statuses.filter(([, status]) => status.state === 'failed'), [])

    // Back: the clone is there, so it is adopted, and setup doesn't run outside the sandbox in an existing checkout.
    run.workspaces = mountWorkspaces(run.ctx, run.world)
    await run.workspaces
    await waitState(run, 'acme/widget', 'ready')
    assert.match(run.projects().status('acme/widget').setupSkipped ?? '', /existing checkout/)
    assert.equal(run.service()!.describe('acme/widget')!.adopted, true)
    assert.equal(await exists(go), false)
  } finally {
    await run.stop()
  }
})

test('dish-projects recording a project ready registers its workspace when a registry came after its onboarding\'s last step', async () => {
  const world = await startServiceWorld()
  const ctx = new Context()
  const logs = watchLogs(ctx)
  const projects = projectsStub()
  const widget = projectOf('acme/widget')
  projects.add(widget)
  const fibers = [provideStub(ctx, 'dishProjects', projects.service), provideStub(ctx, 'credentials', credentialsStub(world.credentials))]
  for (const fiber of fibers) await fiber
  let started: plugin.WorkspacesService | undefined
  const workspaces = ctx.plugin({
    name: plugin.name,
    apply: (inner: Context, config: plugin.Config) => { started = plugin.start(inner, config, world.internals()) },
  } as never, { appIdName: APP_ID_NAME, privateKeyName: PRIVATE_KEY_NAME, terminal: false } as never)
  await workspaces
  let registry: MountedRegistry | undefined
  try {
    const service = ctx.get('dishWorkspaces') as DishWorkspaces
    const result = await service.onboard(widget)
    assert.deepEqual(result.workspace, { skipped: 'no workspace registry in this profile' })
    // The registry comes before dish-projects has recorded the project ready: its own pass leaves it.
    registry = await mountRegistryOn(ctx, join(world.dir, 'dsh'))
    await waitFor('the scratch workspace', () => registry!.registry.list().some(item => item.title === 'scratch'))
    await started!.idle()
    const clone = join(world.workRoot, 'acme', 'widget')
    assert.equal(await registry.registry.resolveByPath(clone), undefined)
    projects.set('acme/widget', 'ready')
    ctx.emit('dish-projects/status', 'acme/widget', { state: 'ready', at: Date.now(), readyAt: Date.now() })
    const record = await waitFor('the workspace', () => registry!.registry.resolveByPath(clone))
    assert.equal(record.title, 'acme/widget')
    assert.deepEqual(logs, [])
  } finally {
    await workspaces.dispose()
    await registry?.stop()
    for (const fiber of fibers.reverse()) await fiber.dispose()
  }
})
