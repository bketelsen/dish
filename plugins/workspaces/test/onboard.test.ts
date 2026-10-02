import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFile, readFile, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { workRoot } from 'dish-kit'
import { internals } from '../src/clone.ts'
import { NO_REGISTRY, OnboardError, onboardProject } from '../src/onboard.ts'
import type { OnboardDeps, OnboardResult, OnboardStep } from '../src/onboard.ts'
import { cloneStateFile, setupLogFile, tokensDir } from '../src/paths.ts'
import { skipReason } from '../src/setup.ts'
import { readCloneState } from '../src/state.ts'
import { FILE_PERMISSIONS } from '../src/tokens.ts'
import type { OwnerRepos } from '../src/tokens.ts'
import type { WorkspaceRegistryLike } from '../src/registry.ts'
import { HELPER, exists, filesHolding, project, startWorld } from './onboard-helpers.ts'
import type { World, WorldOptions } from './onboard-helpers.ts'
import { mountRegistry } from './registry-helpers.ts'
import type { MountedRegistry } from './registry-helpers.ts'
import { NOSYSTEM, dishHome, runOk, scratchGitEnv, withEnv } from './helpers.ts'

internals.gitEnv = NOSYSTEM

/** Prints something shaped like an installation token, without the command holding one. */
const PRINT_TOKEN = `printf 'token ghs_%s\\n' "$(printf 'Ab1%.0s' $(seq 1 12))"`

interface Run {
  world: World
  deps: OnboardDeps
  registry: MountedRegistry | undefined
  home: Record<string, string>
  steps: OnboardStep[]
}

/** A world, dsh's real registry (unless `registry: false`), and onboarding deps over them. */
async function prepare(options: WorldOptions & { registry?: boolean, repositories?: Map<string, OwnerRepos> } = {}): Promise<Run> {
  const world = await startWorld(options)
  const registry = options.registry === false ? undefined : await mountRegistry(join(world.dir, 'dsh'))
  const steps: OnboardStep[] = []
  const deps: OnboardDeps = {
    workRoot: world.workRoot,
    state: world.state,
    web: world.git.origin,
    helper: HELPER,
    tokens: world.tokens,
    logger: world.logger,
    app: world.app,
    repositories: () => options.repositories ?? new Map(),
    registry: () => registry?.registry,
  }
  return { world, deps, registry, home: await dishHome(world.dir), steps }
}

async function onboard(run: Run, overrides: Parameters<typeof project>[0] = {}, signal?: AbortSignal): Promise<OnboardResult> {
  return withEnv(run.home, () => onboardProject(project(overrides), run.deps, { signal, progress: step => { run.steps.push(step) } }))
}

async function failsAt(body: Promise<unknown>, step: OnboardStep): Promise<OnboardError> {
  try {
    await body
  } catch (error) {
    assert.ok(error instanceof OnboardError, `expected an OnboardError, got ${String(error)}`)
    assert.equal(error.step, step, error.message)
    return error
  }
  assert.fail(`expected an OnboardError at ${step}`)
}

/** No `ghs_` in the clone's .git, the state directory (but the token files), the home, or a logged line. */
async function assertNoToken(run: Run, ...texts: string[]): Promise<void> {
  const { world } = run
  const clone = join(world.workRoot, 'acme', 'widget')
  assert.deepEqual(await filesHolding(join(clone, '.git'), 'ghs_'), [])
  const tokens = tokensDir(world.state)
  assert.deepEqual((await filesHolding(world.state, 'ghs_')).filter(file => !file.startsWith(`${tokens}/`)), [])
  assert.deepEqual(await filesHolding(run.home.HOME!, 'ghs_'), [])
  for (const line of world.lines) assert.ok(!line.includes('ghs_'), line)
  for (const text of texts) assert.ok(!text.includes('ghs_'), text)
}

test('a new project is onboarded: installation, a fresh clone, configured, setup run, and its workspace registered and recorded', async () => {
  const run = await prepare()
  const { world } = run
  // A global store helper must keep nothing.
  await appendFile(join(run.home.HOME!, '.gitconfig'), '[credential]\n\thelper = store\n')
  try {
    const result = await onboard(run, { setup: `echo ran >> .setup-ran; ${PRINT_TOKEN}`, setupTimeoutMs: 30_000 })
    assert.deepEqual(run.steps, ['installation', 'clone', 'configure', 'setup', 'workspace'])
    const clone = await realpath(join(world.workRoot, 'acme', 'widget'))
    assert.equal(result.clone, clone)
    assert.equal(result.adopted, false)
    assert.equal(result.setup.ran, true)
    assert.ok(result.setup.ran && result.setup.exitCode === 0)
    assert.equal(await readFile(join(clone, '.setup-ran'), 'utf8'), 'ran\n')
    const log = await readFile(setupLogFile(world.state, 'acme', 'widget'), 'utf8')
    assert.match(log, /token /)

    // The workspace: in dsh's registry, titled with the project's name, and recorded.
    assert.ok('id' in result.workspace)
    const workspace = await run.registry!.registry.get(result.workspace.id as never)
    assert.equal(workspace?.title, 'acme/widget')
    assert.equal(workspace?.path, clone)
    const state = await readCloneState(cloneStateFile(world.state, 'acme', 'widget'))
    assert.equal(state?.clone, clone)
    assert.equal(state?.adopted, false)
    assert.equal(state?.installation, 77)
    assert.equal(state?.workspace?.id, result.workspace.id)
    assert.deepEqual({ ...state?.setup, at: 0 }, { at: 0, ran: true, exitCode: 0, timedOut: false })

    // The token file, 0600; only read tokens minted, none with pull requests; the bot looked up without one.
    const tokenFile = join(tokensDir(world.state), 'acme')
    assert.equal((await stat(tokenFile)).mode & 0o777, 0o600)
    assert.ok(world.github.minted.length > 0)
    for (const mint of world.github.minted) assert.deepEqual(mint.permissions, { ...FILE_PERMISSIONS })
    const bot = world.github.requests.find(request => request.path.startsWith('/users/'))
    assert.equal(bot?.auth, 'none')

    assert.equal(await exists(join(run.home.HOME!, '.git-credentials')), false)
    await assertNoToken(run, JSON.stringify(result))
  } finally {
    await run.registry?.stop()
  }
})

test('an installation that hasn\'t accepted Pull requests read still onboards', async () => {
  const run = await prepare({ registry: false })
  run.world.github.installations.set('acme', { id: 77, account: 'Acme', repos: new Set(['widget']), permissions: { contents: 'read', metadata: 'read' } })
  const result = await onboard(run)
  assert.equal(result.adopted, false)
  assert.deepEqual(result.workspace, { skipped: NO_REGISTRY })
  const env = await scratchGitEnv(run.world.dir)
  assert.equal((await runOk('git', ['-C', result.clone, 'config', 'user.email'], { env })).trim(), '9000001+dish-test[bot]@users.noreply.github.com')
})

test('an App not installed on the owner fails at installation, naming what to do, and clones nothing', async () => {
  const run = await prepare({ installed: false, registry: false })
  const error = await failsAt(onboard(run), 'installation')
  assert.equal(error.message, 'install the dish App on acme and give it widget')
  assert.deepEqual(run.steps, ['installation'])
  assert.equal(await exists(run.world.workRoot), false)
})

test('without the App\'s credentials it fails at installation, pointing at the card', async () => {
  const run = await prepare({ credentials: false, registry: false })
  const error = await failsAt(onboard(run), 'installation')
  assert.equal(error.message, 'set the GitHub App on Settings → GitHub App')
  assert.equal(await exists(run.world.workRoot), false)
})

test('a failing setup fails the project with its masked tail, and records the run', async () => {
  const run = await prepare({ registry: false })
  const error = await failsAt(onboard(run, { setup: `echo first; ${PRINT_TOKEN}; echo last; exit 3`, setupTimeoutMs: 30_000 }), 'setup')
  assert.match(error.message, /^setup exited 3; last lines:/)
  assert.match(error.message, /last/)
  assert.match(error.message, /token /)
  assert.deepEqual(run.steps, ['installation', 'clone', 'configure', 'setup'])
  const state = await readCloneState(cloneStateFile(run.world.state, 'acme', 'widget'))
  assert.deepEqual({ ...state?.setup, at: 0 }, { at: 0, ran: true, exitCode: 3, timedOut: false })
  assert.equal(state?.workspace, null)
  await assertNoToken(run, error.message, String(error.stack))
})

test('a setup that runs past its time is killed, and fails the project', async () => {
  const run = await prepare({ registry: false })
  const started = Date.now()
  const error = await failsAt(onboard(run, { setup: 'echo waiting; sleep 30', setupTimeout: '1s', setupTimeoutMs: 300 }), 'setup')
  assert.match(error.message, /^setup timed out after 1s; last lines:/)
  assert.match(error.message, /waiting/)
  assert.ok(Date.now() - started < 20_000)
  const state = await readCloneState(cloneStateFile(run.world.state, 'acme', 'widget'))
  assert.equal(state?.setup?.timedOut, true)
})

test('a clone already there (clean, on origin/main) is adopted and setup is skipped; Retry adopts again and registers the same workspace', async () => {
  const run = await prepare()
  const { world } = run
  try {
    // The user's own clone, over HTTP from the fake, as it would be from GitHub.
    const env = await scratchGitEnv(world.dir)
    const path = join(world.workRoot, 'acme', 'widget')
    await runOk('git', ['clone', '-q', `file://${world.bare}`, path], { env })
    await runOk('git', ['-C', path, 'remote', 'set-url', 'origin', `${world.git.origin}/acme/widget.git`], { env })
    const setup = 'echo ran >> .setup-ran'
    const first = await onboard(run, { setup })
    assert.equal(first.adopted, true)
    assert.deepEqual(first.setup, { ran: false, reason: skipReason('it is an existing checkout', first.clone, setup) })
    assert.equal(await exists(join(path, '.setup-ran')), false)
    const state = await readCloneState(cloneStateFile(world.state, 'acme', 'widget'))
    assert.deepEqual({ ...state?.setup, at: 0 }, { at: 0, ran: false, exitCode: null, timedOut: false, reason: first.setup.ran ? '' : first.setup.reason })

    // Retry: the clone (dish's own by now, or not) is adopted again, setup skipped again, the workspace the same.
    run.steps.length = 0
    const again = await onboard(run, { setup })
    assert.equal(again.adopted, true)
    assert.equal(again.setup.ran, false)
    assert.deepEqual(again.workspace, first.workspace)
    assert.deepEqual(run.steps, ['installation', 'clone', 'configure', 'setup', 'workspace'])
    assert.equal(await exists(join(path, '.setup-ran')), false)
    assert.equal((await run.registry!.registry.list()).length, 1)
  } finally {
    await run.registry?.stop()
  }
})

test('a project dish cloned, onboarded again (Retry), is adopted with setup skipped', async () => {
  const run = await prepare({ registry: false })
  const setup = 'echo ran >> .setup-ran'
  assert.equal((await onboard(run, { setup })).setup.ran, true)
  const again = await onboard(run, { setup })
  assert.equal(again.adopted, true)
  assert.equal(again.setup.ran, false)
  assert.equal(await readFile(join(again.clone, '.setup-ran'), 'utf8'), 'ran\n')
})

test('no setup is not a skip; no registry leaves the workspace for later', async () => {
  const run = await prepare({ registry: false })
  const result = await onboard(run)
  assert.deepEqual(result.setup, { ran: false, reason: 'no setup' })
  assert.deepEqual(result.workspace, { skipped: 'no workspace registry in this profile' })
  const state = await readCloneState(cloneStateFile(run.world.state, 'acme', 'widget'))
  assert.equal(state?.workspace, null)
})

test('an onboarding aborted before its workspace step registers no workspace', async () => {
  const run = await prepare()
  try {
    const controller = new AbortController()
    const steps: OnboardStep[] = []
    const onboarding = withEnv(run.home, () => onboardProject(project(), run.deps, {
      signal: controller.signal,
      progress: step => {
        steps.push(step)
        // The project is removed while its setup runs: by the time the workspace step comes, it is aborted.
        if (step === 'setup') controller.abort()
      },
    }))
    await assert.rejects(onboarding, (error: Error) => error.name === 'AbortError')
    assert.ok(!steps.includes('workspace'))
    assert.deepEqual(await run.registry!.registry.list(), [])
  } finally {
    await run.registry?.stop()
  }
})

test('an aborted setup ends, and the onboarding rejects as aborted', async () => {
  const run = await prepare({ registry: false })
  const controller = new AbortController()
  const onboarding = withEnv(run.home, () => onboardProject(project({ setup: 'echo started; sleep 30' }), run.deps, {
    signal: controller.signal,
    progress: step => { if (step === 'setup') setTimeout(() => controller.abort(), 200) },
  }))
  const started = Date.now()
  await assert.rejects(onboarding, (error: Error) => error.name === 'AbortError')
  assert.ok(Date.now() - started < 15_000)
})

test('a new project\'s repo joins its owner\'s token with the repos dish already reads', async () => {
  const run = await prepare({ registry: false, repositories: new Map([['acme', { installation: 77, repos: ['gadget'] }]]) })
  await onboard(run)
  const last = run.world.github.minted.at(-1)!
  assert.deepEqual([...last.repositories].sort(), ['gadget', 'widget'])
})

test('dev isolation: with DSH_DISH_HOME set, the clone lands under it and nothing under the home', async () => {
  const run = await prepare({ registry: false })
  const inst = join(run.world.dir, 'inst')
  await withEnv({ ...run.home, DSH_DISH_HOME: inst }, async () => {
    const deps = { ...run.deps, workRoot: workRoot() }
    const result = await onboardProject(project(), deps)
    assert.equal(result.clone, await realpath(join(inst, 'work', 'acme', 'widget')))
  })
  assert.equal(await exists(join(run.home.HOME!, 'work')), false)
})

test('a registry that fails fails the workspace step, with its message', async () => {
  const run = await prepare({ registry: false })
  const broken: WorkspaceRegistryLike = {
    create: async () => { throw new Error('the registry is broken') },
    resolveByPath: async () => undefined,
    get: async () => undefined,
    list: async () => [],
  } as unknown as WorkspaceRegistryLike
  run.deps.registry = () => broken
  const error = await failsAt(onboard(run), 'workspace')
  assert.match(error.message, /the registry is broken/)
})
