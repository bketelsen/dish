import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lstat, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { helperValue, tokensDir } from '../src/paths.ts'
import { createDishWorkspaces } from '../src/service.ts'
import type { WorkspacesInternals, WorkspacesService } from '../src/service.ts'
import { exists, filesHolding } from './onboard-helpers.ts'
import { runOk, tempDir, withEnv } from './helpers.ts'
import {
  APP_ID_NAME, HELPER, PRIVATE_KEY_NAME, credentialsStub, crewStub, fakeTimers, mountRegistryOn, projectOf, projectsStub, provideStub,
  startServiceWorld, useScratchProcess, waitFor, watchLogs,
} from './service-helpers.ts'
import type { FakeTimers, MountedRegistry, ServiceWorld } from './service-helpers.ts'

const scratch = useScratchProcess()

const widget = projectOf('acme/widget')
const gadget = projectOf('acme/gadget')

interface Setup {
  world: ServiceWorld
  ctx: Context
  logs: string[]
  projects: ReturnType<typeof projectsStub>
  crew: ReturnType<typeof crewStub>
  service: WorkspacesService
  registry: MountedRegistry | undefined
}

async function setup(options: { registry?: boolean, timers?: FakeTimers, internals?: WorkspacesInternals, files?: Record<string, string>, world?: ServiceWorld, credentials?: unknown } = {}): Promise<Setup> {
  const world = options.world ?? await startServiceWorld({ files: options.files })
  const ctx = new Context()
  const logs = watchLogs(ctx, true)
  const projects = projectsStub()
  projects.add(widget)
  projects.add(gadget)
  await provideStub(ctx, 'dishProjects', projects.service)
  await provideStub(ctx, 'credentials', options.credentials ?? credentialsStub(world.credentials))
  const crew = crewStub()
  await provideStub(ctx, 'dishCrew', crew.service)
  const registry = options.registry === true ? await mountRegistryOn(ctx, join(world.dir, 'dsh')) : undefined
  const service = createDishWorkspaces(ctx, { appIdName: APP_ID_NAME, privateKeyName: PRIVATE_KEY_NAME }, world.internals({
    timers: options.timers ?? fakeTimers(),
    ...options.internals,
  }))
  service.start()
  if (registry !== undefined) service.useRegistry(registry.registry)
  return { world, ctx, logs, projects, crew, service, registry }
}

async function teardown(run: Setup): Promise<void> {
  await run.service.close()
  await run.registry?.stop()
}

/** A setup command that writes its pid to `pid`, then waits until `go` exists. */
function waitingSetup(dir: string): { setup: string, pid: string, go: string } {
  const pid = join(dir, 'setup.pid')
  const go = join(dir, 'go')
  return { setup: `echo $$ > '${pid}'; while [ ! -f '${go}' ]; do sleep 0.05; done`, pid, go }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const settled = async (promise: Promise<unknown>, ms = 300): Promise<boolean> => {
  let done = false
  void promise.then(() => { done = true }, () => { done = true })
  await new Promise(resolve => setTimeout(resolve, ms))
  return done
}

test('onboard: the project is cloned, configured and registered; describe follows it; its token file is 0600; nothing logs a token', async () => {
  const run = await setup({ registry: true })
  try {
    const steps: string[] = []
    const result = await run.service.onboard(widget, { progress: step => { steps.push(step) } })
    assert.deepEqual(steps, ['installation', 'clone', 'configure', 'setup', 'workspace'])
    const clone = join(run.world.workRoot, 'acme', 'widget')
    assert.equal(result.clone, clone)
    assert.equal(result.adopted, false)
    assert.ok('id' in result.workspace)
    const record = run.registry!.registry.get(result.workspace.id as never)
    assert.equal(record?.title, 'acme/widget')
    assert.equal(record?.path, clone)

    const described = run.service.describe('ACME/Widget')
    assert.deepEqual(described, { clone, adopted: false, workspace: { id: result.workspace.id, title: 'acme/widget' }, lastFetch: null, worktrees: 0 })
    assert.equal(run.service.describe('acme/nothing'), undefined)

    const token = join(tokensDir(run.world.state), 'acme')
    assert.equal((await stat(token)).mode & 0o777, 0o600)
    assert.equal((await stat(tokensDir(run.world.state))).mode & 0o777, 0o700)
    assert.deepEqual(await filesHolding(join(clone, '.git'), 'ghs_'), [])
    assert.deepEqual((await filesHolding(run.world.state, 'ghs_')).filter(file => file !== token), [])
    for (const line of run.logs) assert.ok(!line.includes('ghs_'), line)
    // The clone's helper is dish's own, by its real path.
    const config = await readFile(join(clone, '.git', 'config'), 'utf8')
    assert.ok(config.includes(HELPER))
  } finally {
    await teardown(run)
  }
})

test('close rejects onboarding in flight and work queued behind it with an AbortError, once setup is dead, and removes the token files', async () => {
  const dir = await tempDir()
  const wait = waitingSetup(dir)
  const run = await setup()
  const project = projectOf('acme/widget', { setup: wait.setup })
  run.projects.add(project)
  const onboarding = run.service.onboard(project)
  const pid = Number(await waitFor('setup to start', async () => (await readFile(wait.pid, 'utf8').catch(() => '')).trim() || undefined))
  assert.ok(alive(pid))
  const queued = run.service.removeWorktree('acme/widget', 'nope', true)
  const token = join(tokensDir(run.world.state), 'acme')
  assert.ok(await exists(token))

  const onboardingRejects = assert.rejects(onboarding, (error: Error) => error.name === 'AbortError')
  const queuedRejects = assert.rejects(queued, (error: Error) => error.name === 'AbortError')
  await run.service.close()
  assert.equal(alive(pid), false, 'setup was killed before close resolved')
  await onboardingRejects
  await queuedRejects
  assert.equal(await exists(token), false)
  // Nothing more is taken.
  await assert.rejects(run.service.onboard(widget), (error: Error) => error.name === 'AbortError')
  await assert.rejects(run.service.createWorktree('acme/widget', 'x', undefined, { cwd: dir }), (error: Error) => error.name === 'AbortError')
  // Safe to call twice.
  await run.service.close()
})

test('the per-project lock: work on a project waits for its onboarding, and another project\'s doesn\'t', async () => {
  const dir = await tempDir()
  const wait = waitingSetup(dir)
  const run = await setup()
  try {
    const project = projectOf('acme/widget', { setup: wait.setup })
    run.projects.add(project)
    const onboarding = run.service.onboard(project)
    await waitFor('setup to start', () => exists(wait.pid))
    const waiting = run.service.removeWorktree('acme/widget', 'nope', true)
    const other = run.service.removeWorktree('acme/gadget', 'nope', true)
    await assert.rejects(other, /no worktree/)
    assert.equal(await settled(waiting), false, 'a removal in the onboarding project waits for the lock')
    await writeFile(wait.go, '')
    await onboarding
    await assert.rejects(waiting, /no worktree "nope" that dish made/)
  } finally {
    await teardown(run)
  }
})

test('a project removed while it onboards (its signal aborted) registers no workspace', async () => {
  const dir = await tempDir()
  const wait = waitingSetup(dir)
  const run = await setup({ registry: true })
  try {
    const project = projectOf('acme/widget', { setup: wait.setup })
    run.projects.add(project)
    const controller = new AbortController()
    const onboarding = run.service.onboard(project, { signal: controller.signal })
    await waitFor('setup to start', () => exists(wait.pid))
    controller.abort()
    await assert.rejects(onboarding, (error: Error) => error.name === 'AbortError')
    const clone = join(run.world.workRoot, 'acme', 'widget')
    assert.equal(await run.registry!.registry.resolveByPath(clone), undefined)
    assert.equal(run.service.describe('acme/widget')?.workspace, null)
  } finally {
    await teardown(run)
  }
})

test('without a registry onboarding skips the workspace; a registry that appears registers each ready project without one, and the scratch workspace once', async () => {
  const run = await setup()
  let mounted: MountedRegistry | undefined
  try {
    const result = await run.service.onboard(widget)
    assert.deepEqual(result.workspace, { skipped: 'no workspace registry in this profile' })
    assert.equal(run.service.describe('acme/widget')?.workspace, null)
    // gadget is listed but not ready: it gets nothing.
    run.projects.set('acme/widget', 'ready')

    mounted = await mountRegistryOn(run.ctx, join(run.world.dir, 'dsh'))
    const detach = run.service.useRegistry(mounted.registry)
    const clone = join(run.world.workRoot, 'acme', 'widget')
    const described = await waitFor('the workspace to be registered', () => run.service.describe('acme/widget')?.workspace ?? undefined)
    assert.equal(described.title, 'acme/widget')
    await run.service.idle()
    const titles = () => mounted!.registry.list().map(item => item.title).sort()
    assert.deepEqual(titles(), ['acme/widget', 'scratch'])
    assert.equal((await mounted.registry.resolveByPath(clone))?.id, described.id)

    // The registry going and coming back registers nothing twice.
    detach()
    run.service.useRegistry(mounted.registry)
    await run.service.idle()
    assert.deepEqual(titles(), ['acme/widget', 'scratch'])

    // A workspace the user removes stays removed: its record says dish registered it.
    await mounted.registry.delete(described.id as never)
    run.service.useRegistry(mounted.registry)
    await run.service.idle()
    assert.deepEqual(titles(), ['scratch'])
  } finally {
    await teardown(run)
    await mounted?.stop()
  }
})

test('the bot a test of the App looked up is the one onboarding uses: one /users call between them', async () => {
  const run = await setup()
  try {
    const users = (): number => run.world.github.requests.filter(request => request.path.startsWith('/users/')).length
    const status = await run.service.appStatus(true)
    assert.equal(status.bot?.login, 'dish-test[bot]')
    assert.equal(users(), 1)
    await run.service.onboard(widget)
    assert.equal(users(), 1, 'onboarding\'s identity came from the lookup the test made')
    assert.equal((await runOk('git', ['-C', join(run.world.workRoot, 'acme', 'widget'), 'config', 'user.email'], { env: run.world.env })).trim(), `${run.world.github.bot.id}+dish-test[bot]@users.noreply.github.com`)
  } finally {
    await teardown(run)
  }
})

test('prepare configures before it fetches: a helper path from an older checkout is put back, the fetch is recorded, and the identity is asked once', async () => {
  const run = await setup()
  try {
    await run.service.onboard(widget)
    const clone = join(run.world.workRoot, 'acme', 'widget')
    const web = run.world.git.origin
    const current = helperValue(HELPER, tokensDir(run.world.state), web)
    const older = helperValue('/old/checkout/plugins/workspaces/bin/git-credential-dish', tokensDir(run.world.state), web)
    const config = join(clone, '.git', 'config')
    await writeFile(config, (await readFile(config, 'utf8')).replace(current, older))
    assert.ok((await readFile(config, 'utf8')).includes(older))

    await run.service.prepare(widget)
    const after = await readFile(config, 'utf8')
    assert.ok(after.includes(current))
    assert.ok(!after.includes(older))
    const fetched = run.service.describe('acme/widget')?.lastFetch
    assert.equal(fetched?.ok, true, fetched?.message)

    // The bot identity: looked up by onboarding, not again by prepare; again after the App's credentials change.
    const asked = () => run.world.github.requests.filter(request => request.path === '/app').length
    assert.equal(asked(), 1)
    await run.service.prepare(widget)
    assert.equal(asked(), 1)
    run.service.credentialsChanged(PRIVATE_KEY_NAME)
    await run.service.prepare(widget)
    assert.equal(asked(), 2)
    run.service.credentialsChanged('SOMETHING_ELSE')
    await run.service.prepare(widget)
    assert.equal(asked(), 2)
  } finally {
    await teardown(run)
  }
})

test('prepare stays ready when GitHub can\'t give the bot identity: the clone keeps its own, the helper is put back, one warning, and the next prepare asks again', async () => {
  const run = await setup()
  try {
    await run.service.onboard(widget)
    const clone = join(run.world.workRoot, 'acme', 'widget')
    const config = join(clone, '.git', 'config')
    const web = run.world.git.origin
    const current = helperValue(HELPER, tokensDir(run.world.state), web)
    const older = helperValue('/old/checkout/plugins/workspaces/bin/git-credential-dish', tokensDir(run.world.state), web)
    const bot = `${run.world.github.app.slug}[bot]`
    assert.ok((await readFile(config, 'utf8')).includes(bot))
    const warnings = () => run.logs.filter(line => line.includes('warn') && line.includes('bot identity'))
    const asked = () => run.world.github.requests.filter(request => request.path === '/app').length

    // A start before the network is up: GitHub fails the App lookup.
    await writeFile(config, (await readFile(config, 'utf8')).replace(current, older))
    run.service.credentialsChanged(APP_ID_NAME)
    run.world.github.failNext('/app', 500)
    await run.service.prepare(widget)
    const after = await readFile(config, 'utf8')
    assert.ok(after.includes(current) && !after.includes(older), 'the helper is put back without the identity')
    assert.ok(after.includes(bot), 'the clone keeps the identity it has')
    assert.equal(run.service.describe('acme/widget')?.lastFetch?.ok, true)
    assert.equal(warnings().length, 1, run.logs.join('\n'))

    // The same trouble again is not logged again; the next prepare asks GitHub again.
    const before = asked()
    run.world.github.failNext('/app', 500)
    await run.service.prepare(widget)
    assert.equal(asked(), before + 1)
    assert.equal(warnings().length, 1)
    await run.service.prepare(widget)
    assert.equal(asked(), before + 2)
    await run.service.prepare(widget)
    assert.equal(asked(), before + 2, 'once found, it is kept')

    // No App key at all: the same, with its own warning.
    const key = run.world.credentials.get(PRIVATE_KEY_NAME)!
    run.world.credentials.delete(PRIVATE_KEY_NAME)
    run.service.credentialsChanged(PRIVATE_KEY_NAME)
    await run.service.prepare(widget)
    assert.equal(warnings().length, 2)
    assert.match(warnings()[1]!, /Settings → GitHub App/)
    run.world.credentials.set(PRIVATE_KEY_NAME, key)
    for (const line of run.logs) assert.ok(!line.includes('ghs_') && !line.includes('PRIVATE KEY'), line)
  } finally {
    await teardown(run)
  }
})

test('a registry that appears after onboarding\'s last step, before dish-projects records the project ready, registers it once it is', async () => {
  const run = await setup()
  let mounted: MountedRegistry | undefined
  try {
    const result = await run.service.onboard(widget)
    assert.deepEqual(result.workspace, { skipped: 'no workspace registry in this profile' })
    // dish-projects hasn't recorded it ready yet when the registry comes: the registry's own pass leaves it.
    mounted = await mountRegistryOn(run.ctx, join(run.world.dir, 'dsh'))
    run.service.useRegistry(mounted.registry)
    await run.service.idle()
    const clone = join(run.world.workRoot, 'acme', 'widget')
    assert.equal(await mounted.registry.resolveByPath(clone), undefined)
    // Then it does (dish-projects/status), and the workspace is registered.
    run.projects.set('acme/widget', 'ready')
    run.service.registerIfMissing('acme/widget')
    await run.service.idle()
    const record = await mounted.registry.resolveByPath(clone)
    assert.equal(record?.title, 'acme/widget')
    assert.deepEqual(run.service.describe('acme/widget')?.workspace, { id: record!.id, title: 'acme/widget' })
    // Once.
    run.service.registerIfMissing('acme/widget')
    run.service.registerIfMissing('ACME/Widget')
    await run.service.idle()
    assert.equal(mounted.registry.list().filter(item => item.title === 'acme/widget').length, 1)
  } finally {
    await teardown(run)
    await mounted?.stop()
  }
})

test('a project removed while its registration waits for the lock gets no workspace; an aborted call doesn\'t wait for the lock', async () => {
  const world = await startServiceWorld()
  // Credentials the test can hold, so that a prepare holds the project's lock.
  let gate: Promise<void> | undefined
  let waiting = 0
  const credentials = {
    async resolve(ref: string) {
      if (gate !== undefined) {
        waiting++
        await gate
      }
      const value = world.credentials.get(ref)
      return value === undefined ? undefined : { value, source: 'file' }
    },
  }
  const run = await setup({ world, credentials })
  let mounted: MountedRegistry | undefined
  let release = (): void => {}
  try {
    await run.service.onboard(widget)
    run.projects.set('acme/widget', 'ready')
    await run.service.idle()
    run.service.credentialsChanged(APP_ID_NAME)
    gate = new Promise<void>((resolve) => { release = resolve })
    const preparing = run.service.prepare(widget)
    await waitFor('prepare to hold the lock', () => waiting > 0)

    // An aborted call is refused at once, not after the lock.
    const aborted = run.service.onboard(widget, { signal: AbortSignal.abort() })
    assert.equal(await settled(aborted, 100), true)
    await assert.rejects(aborted, (error: Error) => error.name === 'AbortError')

    // The registry comes: its pass finds the project ready and waits for the lock; so does a registerIfMissing.
    mounted = await mountRegistryOn(run.ctx, join(run.world.dir, 'dsh'))
    const listed = run.projects.calls()
    run.service.useRegistry(mounted.registry)
    await waitFor('the registry\'s pass to list the projects', () => run.projects.calls() > listed)
    run.service.registerIfMissing('acme/widget')
    await new Promise(resolve => setTimeout(resolve, 50))
    // Removed meanwhile.
    run.projects.remove('acme/widget')
    gate = undefined
    release()
    await preparing
    await run.service.idle()
    const clone = join(run.world.workRoot, 'acme', 'widget')
    assert.equal(await mounted.registry.resolveByPath(clone), undefined)
    assert.deepEqual(mounted.registry.list().map(item => item.title), ['scratch'])
  } finally {
    // A failed assertion must not leave the prepare holding the lock, or close would wait for it.
    gate = undefined
    release()
    await teardown(run)
    await mounted?.stop()
  }
})

test('the App\'s credentials are read on every use: without them onboarding says where to set them', async () => {
  const run = await setup()
  try {
    const key = run.world.credentials.get(PRIVATE_KEY_NAME)!
    run.world.credentials.delete(PRIVATE_KEY_NAME)
    await assert.rejects(run.service.onboard(widget), /set the GitHub App on Settings → GitHub App/)
    run.world.credentials.set(PRIVATE_KEY_NAME, key)
    await run.service.onboard(widget)
  } finally {
    await teardown(run)
  }
})

test('createWorktree refuses a project that isn\'t registered or ready, and a call without a cwd', async () => {
  const run = await setup()
  try {
    await assert.rejects(run.service.createWorktree('acme/nothing', 'x', undefined, { cwd: '/' }), /no project acme\/nothing/)
    await assert.rejects(run.service.createWorktree('acme/widget', 'x', undefined, { cwd: '/' }), /acme\/widget isn't ready \(pending\); see Settings → Projects/)
    await run.service.onboard(widget)
    run.projects.set('acme/widget', 'ready')
    await assert.rejects(run.service.createWorktree('acme/widget', 'x'), /no workspace/)
    // Outside the clone: Worktrees' own check, passed through.
    await assert.rejects(run.service.createWorktree('acme/widget', 'x', undefined, { cwd: await tempDir() }), /outside this chat's workspace/)
  } finally {
    await teardown(run)
  }
})

test('a removal without force fetches first, under the lock', async () => {
  const run = await setup()
  try {
    await run.service.onboard(widget)
    run.projects.set('acme/widget', 'ready')
    const clone = join(run.world.workRoot, 'acme', 'widget')
    await run.service.createWorktree('acme/widget', 'fix-1', undefined, { cwd: clone })
    await run.service.idle()
    const before = run.service.describe('acme/widget')!.lastFetch!.at
    await new Promise(resolve => setTimeout(resolve, 5))
    await assert.rejects(run.service.removeWorktree('acme/widget', 'fix-1'), /isn't merged/)
    assert.ok(run.service.describe('acme/widget')!.lastFetch!.at > before)
    assert.equal(run.service.describe('acme/widget')!.worktrees, 1)
    await run.service.removeWorktree('acme/widget', 'fix-1', true)
    assert.equal(run.service.describe('acme/widget')!.worktrees, 0)
  } finally {
    await teardown(run)
  }
})

test('the hourly round: after firstRoundMs, then every roundEveryMs, one project at a time, never two rounds at once', async () => {
  const timers = fakeTimers()
  const run = await setup({ timers, internals: { firstRoundMs: 1_000, roundEveryMs: 7_000 } })
  try {
    await run.service.onboard(widget)
    await run.service.onboard(gadget)
    run.projects.set('acme/widget', 'ready')
    run.projects.set('acme/gadget', 'ready')
    await run.service.idle()
    assert.equal(timers.pending().filter(timer => timer.ms === 1_000).length, 1)
    assert.equal(run.service.describe('acme/widget')?.lastFetch, null)

    const release = run.projects.hold()
    const listed = run.projects.calls()
    const from = run.world.git.requests.length
    timers.fire(1_000)
    // The next round is set at once, and fired while this one still runs: it is skipped.
    timers.fire(7_000)
    release()
    await run.service.idle()
    assert.equal(run.projects.calls() - listed, 1, 'one round ran')
    const paths = run.world.git.requests.slice(from).map(request => request.path)
    const lastWidget = paths.findLastIndex(path => path.startsWith('/acme/widget.git/'))
    const firstGadget = paths.findIndex(path => path.startsWith('/acme/gadget.git/'))
    assert.ok(lastWidget >= 0 && firstGadget > lastWidget, `widget's fetch, then gadget's: ${paths.join(' ')}`)
    const first = run.service.describe('acme/widget')!.lastFetch!
    assert.equal(first.ok, true)
    assert.equal(run.service.describe('acme/gadget')!.lastFetch!.ok, true)

    assert.equal(timers.pending().filter(timer => timer.ms === 7_000).length, 1)
    await new Promise(resolve => setTimeout(resolve, 5))
    timers.fire(7_000)
    await run.service.idle()
    assert.ok(run.service.describe('acme/widget')!.lastFetch!.at > first.at)
  } finally {
    await teardown(run)
  }
  assert.deepEqual(timers.pending().filter(timer => timer.ms === 7_000 || timer.ms === 1_000), [], 'close clears the round\'s timer')
})

test('a round\'s failure is logged once per project and error, and the round goes on', async () => {
  const timers = fakeTimers()
  const run = await setup({ timers, internals: { firstRoundMs: 1_000, roundEveryMs: 7_000 } })
  try {
    await run.service.onboard(widget)
    await run.service.onboard(gadget)
    run.projects.set('acme/widget', 'ready')
    run.projects.set('acme/gadget', 'ready')
    await run.service.idle()
    // GitHub loses widget.
    const bare = join(run.world.root, 'acme', 'widget.git')
    await rename(bare, `${bare}.gone`)
    const warnings = () => run.logs.filter(line => line.includes('warn') && line.includes('acme/widget'))
    timers.fire(1_000)
    await run.service.idle()
    assert.equal(warnings().length, 1, run.logs.join('\n'))
    assert.equal(run.service.describe('acme/widget')!.lastFetch!.ok, false)
    assert.equal(run.service.describe('acme/gadget')!.lastFetch!.ok, true, 'the round went on')
    timers.fire(7_000)
    await run.service.idle()
    assert.equal(warnings().length, 1, 'the same error is not logged again')
    await rename(`${bare}.gone`, bare)
    timers.fire(7_000)
    await run.service.idle()
    assert.equal(run.service.describe('acme/widget')!.lastFetch!.ok, true)
    for (const line of run.logs) assert.ok(!line.includes('ghs_'), line)
  } finally {
    await teardown(run)
  }
})

test('the token map follows the projects: a removed project\'s owner loses its token file', async () => {
  const run = await setup()
  try {
    await run.service.onboard(widget)
    const token = join(tokensDir(run.world.state), 'acme')
    assert.ok(await exists(token))
    run.projects.remove('acme/widget')
    run.projects.remove('acme/gadget')
    run.service.projectsChanged(['acme/widget'])
    await waitFor('the token file to go', async () => !(await exists(token)))
  } finally {
    await teardown(run)
  }
})

test('dev isolation: the defaults put clones, state and token files under DSH_DISH_HOME, and nothing under HOME/work', async () => {
  const world = await startServiceWorld()
  const dir = await tempDir()
  const instance = join(dir, 'inst')
  const home = join(dir, 'home')
  await withEnv({ DSH_DISH_HOME: instance, HOME: home }, async () => {
    const ctx = new Context()
    const projects = projectsStub()
    projects.add(widget)
    await provideStub(ctx, 'dishProjects', projects.service)
    await provideStub(ctx, 'credentials', credentialsStub(world.credentials))
    const service = createDishWorkspaces(ctx, { appIdName: APP_ID_NAME, privateKeyName: PRIVATE_KEY_NAME }, { api: world.github.api, web: world.git.origin, timers: fakeTimers() })
    service.start()
    try {
      const result = await service.onboard(widget)
      assert.equal(result.clone, join(instance, 'work', 'acme', 'widget'))
      assert.ok((await lstat(join(instance, 'state', 'dish', 'workspaces', 'acme', 'widget', 'clone.json'))).isFile())
      assert.ok((await lstat(join(instance, 'state', 'dish', 'workspaces', 'tokens', 'acme'))).isFile())
      assert.equal(await exists(join(home, 'work')), false)
      assert.equal(await exists(join(scratch.home(), 'work')), false)
      // The helper is dish's own, by its real path.
      const config = await readFile(join(result.clone, '.git', 'config'), 'utf8')
      assert.ok(config.includes(`'${HELPER}'`))
    } finally {
      await service.close()
    }
    assert.deepEqual(await readdir(join(instance, 'state', 'dish', 'workspaces', 'tokens')), [])
  })
  // A scratch git can read the clone it made.
  await runOk('git', ['-C', join(instance, 'work', 'acme', 'widget'), 'log', '--oneline'], { env: world.env })
})
