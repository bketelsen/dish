import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { ConfigStoreError } from 'dish-config'
import * as plugin from '../src/index.ts'
import type { DishProjects } from '../src/index.ts'
import { PROJECTS_PATH, SEED_TEXT, namespaceSpec, serializeProjects } from '../src/registry.ts'
import type { ProjectFields } from '../src/registry.ts'
import type { ProjectStatus } from '../src/status.ts'
import {
  captureStderr, fakeDriver, freshInstance, mountConfig, mountProjects, outsideCommit, provideStub, tempDir, useScratchEnv, waitFor,
  watchLogs,
} from './helpers.ts'

useScratchEnv()

const AGENT = { kind: 'agent', sessionId: 's1', role: 'main' } as const
const USER = { kind: 'user' } as const
const TOKEN = `ghs_${'a1B2'.repeat(9)}`

/** A project's fields: the required ones, and `overrides`. */
function fields(overrides: Partial<ProjectFields> = {}): ProjectFields {
  return { family: 'acme', role: 'a test project', gate: 'make check', gateTimeout: '2m', ...overrides }
}

/** The registry text with these projects. */
function registry(projects: Record<string, ProjectFields>): string {
  return serializeProjects(projects)
}

const settle = () => new Promise(resolve => setTimeout(resolve, 50))

/**
 * dish-config on a fresh store, a fake `dishWorkspaces` from a sibling (unless `driver` is false), then dish-projects,
 * with a fresh instance home for the status file. Everything the plugin emits is recorded.
 */
async function start(options: { driver?: boolean, repository?: string, keepInstance?: boolean } = {}) {
  const instance = options.keepInstance === true ? undefined : await freshInstance()
  const repository = options.repository ?? join(await tempDir(), 'config.git')
  const ctx = new Context()
  const logs = watchLogs(ctx)
  const fake = fakeDriver()
  const changed: string[][] = []
  const statuses: Array<[string, ProjectStatus]> = []
  ctx.on('dish-projects/changed', (names) => { changed.push(names) })
  ctx.on('dish-projects/status', (name, status) => { statuses.push([name, status]) })
  let config: ReturnType<typeof mountConfig> | undefined = mountConfig(ctx, repository)
  await config
  let stub = options.driver === false ? undefined : provideStub(ctx, 'dishWorkspaces', fake.driver)
  await stub
  const projects = mountProjects(ctx)
  await projects
  await waitFor('the registry to be seeded', async () => (await ctx.dishConfig.read(PROJECTS_PATH)) !== undefined)
  return {
    ctx,
    logs,
    fake,
    changed,
    statuses,
    repository,
    statusFile: instance?.statusFile,
    projects,
    service: () => ctx.get('dishProjects') as DishProjects,
    write: (text: string) => ctx.dishConfig.write([{ path: PROJECTS_PATH, text }], { author: USER }),
    provideDriver: async () => {
      stub = provideStub(ctx, 'dishWorkspaces', fake.driver)
      await stub
    },
    removeDriver: async () => {
      await stub?.dispose()
      stub = undefined
    },
    dropStore: async () => {
      await config?.dispose()
      config = undefined
    },
    restoreStore: async () => {
      config = mountConfig(ctx, repository)
      await config
    },
    stop: async () => {
      await projects.dispose()
      await stub?.dispose()
      await config?.dispose()
    },
  }
}

async function statusFileProjects(file: string): Promise<Record<string, ProjectStatus>> {
  return (JSON.parse(await readFile(file, 'utf8')) as { projects: Record<string, ProjectStatus> }).projects
}

const waitState = (service: () => DishProjects, name: string, state: ProjectStatus['state']) =>
  waitFor(`${name} to be ${state}`, () => service().status(name).state === state)

// --- the service ------------------------------------------------------------------------------------

test('dishProjects is provided at once, with no store and no dish-workspaces, and goes with the plugin', async () => {
  await freshInstance()
  const ctx = new Context()
  const logs = watchLogs(ctx)
  const handle = mountProjects(ctx)
  await handle
  const service = ctx.get('dishProjects') as DishProjects
  assert.deepEqual(Object.keys(service).sort(), ['get', 'list', 'problem', 'retry', 'status'])
  assert.deepEqual(await service.list(), [])
  assert.equal(await service.get('acme/widget'), undefined)
  assert.equal(await service.problem(), undefined)
  assert.deepEqual(service.status('acme/widget'), { state: 'pending', at: 0 })
  await assert.rejects(service.retry('acme/widget'), /no project acme\/widget/)
  await handle.dispose()
  assert.equal(ctx.get('dishProjects'), undefined)
  assert.deepEqual(logs, [])
})

test('the config: one row, terminal, on by default', () => {
  const parse = plugin.Config as unknown as (value: unknown) => unknown
  assert.deepEqual(parse({}), { terminal: true })
  assert.deepEqual(parse({ terminal: false }), { terminal: false })
  assert.throws(() => parse({ terminal: 'yes' }))
  assert.equal(plugin.name, 'dish-projects')
})

// --- the store ----------------------------------------------------------------------------------------

test('projects.yaml is claimed and seeded empty; a person writes it, an agent may only propose, and an invalid one is refused', async () => {
  const run = await start()
  try {
    const store = run.ctx.dishConfig
    assert.equal(await store.read(PROJECTS_PATH), SEED_TEXT)
    const seeds = await store.history({ prefix: PROJECTS_PATH })
    assert.equal(seeds.length, 1)
    assert.deepEqual(seeds[0]!.author, { kind: 'system' })
    // Nobody else can claim it.
    assert.throws(() => store.claim(namespaceSpec('someone-else')), /projects\.yaml/)

    const text = registry({ 'acme/widget': fields() })
    const forbidden = await store.write([{ path: PROJECTS_PATH, text }], { author: AGENT }).then(() => undefined, (error: unknown) => error as ConfigStoreError)
    assert.equal(forbidden?.code, 'FORBIDDEN')
    const proposal = await store.propose([{ path: PROJECTS_PATH, text }], { author: AGENT, title: 'Add the widget', rationale: 'a test' })
    assert.deepEqual(await run.service().list(), [])
    await store.accept(proposal.id, { author: USER })
    assert.deepEqual((await run.service().list()).map(project => project.name), ['acme/widget'])

    const invalid = await run.write(registry({ 'acme/widget': fields({ gateTimeout: '1s' }) })).then(() => undefined, (error: unknown) => error as ConfigStoreError)
    assert.equal(invalid?.code, 'INVALID')
    assert.match(invalid!.message, /gateTimeout must be/)
    const badProposal = await store.propose([{ path: PROJECTS_PATH, text: 'projects: nope\n' }], { author: AGENT, title: 'Break it', rationale: 'a test' }).then(() => undefined, (error: unknown) => error as ConfigStoreError)
    assert.equal(badProposal?.code, 'INVALID')
  } finally {
    await run.stop()
  }
  // A second start seeds nothing more: the seed and the accepted proposal.
  const again = await start({ repository: run.repository })
  try {
    assert.equal((await again.ctx.dishConfig.history({ prefix: PROJECTS_PATH })).length, 2)
    assert.deepEqual((await again.service().list()).map(project => project.name), ['acme/widget'])
  } finally {
    await again.stop()
  }
})

test('get finds a project in any case, and gives what the gates read: gate, gateTimeout, gateTimeoutMs and gateEnv', async () => {
  const run = await start({ driver: false })
  try {
    await run.write(registry({
      'Acme/Widget': fields({ gate: 'pnpm test', gateTimeout: '10m', gateEnv: { CI: '1' }, setup: 'pnpm install', setupTimeout: '20m' }),
      'acme/gadget': fields(),
    }))
    const service = run.service()
    assert.deepEqual((await service.list()).map(project => project.name), ['acme/gadget', 'Acme/Widget'])
    const found = await service.get('acme/WIDGET')
    assert.ok(found)
    assert.equal(found.name, 'Acme/Widget')
    assert.equal(found.gate, 'pnpm test')
    assert.equal(found.gateTimeout, '10m')
    assert.equal(found.gateTimeoutMs, 600_000)
    assert.deepEqual(found.gateEnv, { CI: '1' })
    assert.equal(found.setup, 'pnpm install')
    assert.equal(found.setupTimeoutMs, 1_200_000)
    assert.deepEqual((await service.get('acme/gadget'))!.gateEnv, {})
    assert.equal(await service.get('acme/nothing'), undefined)
    // Each call reads the file as it is now.
    await run.write(registry({ 'acme/gadget': fields({ gate: 'make' }) }))
    assert.equal(await service.get('acme/widget'), undefined)
    assert.equal((await service.get('acme/gadget'))!.gate, 'make')
  } finally {
    await run.stop()
  }
})

// --- driving onboarding -----------------------------------------------------------------------------

test('a project added to projects.yaml is onboarded: changed is emitted, its status goes to ready, and is kept in <state>/projects/status.json', async () => {
  const run = await start()
  try {
    await run.write(registry({ 'acme/widget': fields() }))
    const call = await run.fake.next('onboard', 'acme/widget')
    await waitFor('changed to be emitted', () => run.changed.some(names => names.includes('acme/widget')))
    call.progress('installation')
    assert.equal(run.service().status('acme/widget').state, 'cloning')
    call.progress('setup')
    assert.equal(run.service().status('acme/widget').state, 'setup')
    call.resolve({ setup: { ran: true } })
    await waitState(run.service, 'acme/widget', 'ready')
    const ready = run.service().status('ACME/widget')
    assert.equal(ready.state, 'ready')
    assert.equal(typeof ready.readyAt, 'number')
    assert.deepEqual(run.statuses.filter(([name]) => name === 'acme/widget').map(([, status]) => status.state), ['cloning', 'setup', 'ready'])
    const saved = await waitFor('the file to say ready', async () => {
      const projects = await statusFileProjects(run.statusFile!).catch(() => undefined)
      return projects?.['acme/widget']?.state === 'ready' ? projects : undefined
    })
    assert.deepEqual(Object.keys(saved), ['acme/widget'])
    // One onboarding, and nothing else.
    await settle()
    assert.deepEqual(run.fake.calls.map(entry => `${entry.kind} ${entry.project.name}`), ['onboard acme/widget'])
  } finally {
    await run.stop()
  }
})

test('projects are onboarded one at a time', async () => {
  const run = await start()
  try {
    await run.write(registry({ 'acme/one': fields(), 'acme/two': fields() }))
    const one = await run.fake.next('onboard', 'acme/one')
    await settle()
    assert.equal(run.fake.calls.length, 1)
    one.resolve()
    ;(await run.fake.next('onboard', 'acme/two')).resolve()
    await waitState(run.service, 'acme/two', 'ready')
  } finally {
    await run.stop()
  }
})

test('editing a failed project onboards it again; editing a ready one does not', async () => {
  const run = await start()
  try {
    await run.write(registry({ 'acme/bad': fields({ setup: 'make brokn' }), 'acme/good': fields() }))
    ;(await run.fake.next('onboard', 'acme/bad')).reject(new Error('setup exited 2; last lines: make: *** No rule to make target \'brokn\''))
    ;(await run.fake.next('onboard', 'acme/good')).resolve()
    await waitState(run.service, 'acme/good', 'ready')
    assert.equal(run.service().status('acme/bad').state, 'failed')
    assert.match(run.service().status('acme/bad').message!, /^setup exited 2/)

    const before = run.changed.length
    await run.write(registry({ 'acme/bad': fields({ setup: 'make' }), 'acme/good': fields({ gate: 'make test' }) }))
    const again = await run.fake.next('onboard', 'acme/bad')
    assert.equal(again.project.setup, 'make')
    again.resolve()
    await waitState(run.service, 'acme/bad', 'ready')
    await settle()
    assert.deepEqual(run.fake.calls.map(entry => `${entry.kind} ${entry.project.name}`), ['onboard acme/bad', 'onboard acme/good', 'onboard acme/bad'])
    await waitFor('changed to be emitted', () => run.changed.length > before)
    assert.deepEqual(run.changed.at(-1), ['acme/bad', 'acme/good'])
    // The ready one's new fields are what get gives.
    assert.equal((await run.service().get('acme/good'))!.gate, 'make test')
  } finally {
    await run.stop()
  }
})

test('removing a project aborts its onboarding and forgets its status; its name is in the changed event', async () => {
  const run = await start()
  try {
    // Sorted by name: gone, then keep.
    await run.write(registry({ 'acme/keep': fields(), 'acme/gone': fields() }))
    const gone = await run.fake.next('onboard', 'acme/gone')
    gone.progress('clone')
    assert.equal(run.service().status('acme/gone').state, 'cloning')
    const changedBefore = run.changed.length

    await run.write(registry({ 'acme/keep': fields() }))
    await waitFor('the onboarding to be aborted', () => gone.signal!.aborted)
    await waitFor('the status to be forgotten', () => run.service().status('acme/gone').at === 0)
    assert.deepEqual(run.service().status('acme/gone'), { state: 'pending', at: 0 })
    await waitFor('changed to be emitted', () => run.changed.length > changedBefore)
    assert.deepEqual(run.changed.at(-1), ['acme/gone', 'acme/keep'])
    // The aborted job ends; nothing is recorded for it, and then the next project's turn comes.
    const goneStatuses = () => run.statuses.filter(([name]) => name === 'acme/gone').length
    const statusesBefore = goneStatuses()
    await settle()
    assert.equal(run.fake.calls.length, 1)
    gone.reject(new DOMException('The operation was aborted.', 'AbortError'))
    ;(await run.fake.next('onboard', 'acme/keep')).resolve()
    await waitState(run.service, 'acme/keep', 'ready')
    assert.equal(goneStatuses(), statusesBefore)
    assert.deepEqual(run.service().status('acme/gone'), { state: 'pending', at: 0 })
    const saved = await waitFor('the file to have only the one kept', async () => {
      const projects = await statusFileProjects(run.statusFile!)
      return Object.hasOwn(projects, 'acme/gone') || projects['acme/keep']?.state !== 'ready' ? undefined : projects
    })
    assert.deepEqual(Object.keys(saved), ['acme/keep'])
  } finally {
    await run.stop()
  }
})

test('a queued project that is removed is never onboarded', async () => {
  const run = await start()
  try {
    await run.write(registry({ 'acme/first': fields(), 'acme/second': fields() }))
    const first = await run.fake.next('onboard', 'acme/first')
    await run.write(registry({ 'acme/first': fields() }))
    await waitFor('changed to name the removed project', () => run.changed.some(names => names.includes('acme/second')) && run.changed.length >= 2)
    first.resolve()
    await waitState(run.service, 'acme/first', 'ready')
    await settle()
    assert.deepEqual(run.fake.calls.map(entry => entry.project.name), ['acme/first'])
  } finally {
    await run.stop()
  }
})

test('at start, a ready project is prepared and not onboarded, one that failed or never finished is onboarded, and one removed meanwhile is forgotten', async () => {
  const first = await start()
  const repository = first.repository
  const statusFile = first.statusFile!
  try {
    await first.write(registry({ 'acme/ready': fields(), 'acme/failed': fields(), 'acme/stopped': fields(), 'acme/removed': fields() }))
    // Sorted by name: failed, ready, removed, stopped.
    ;(await first.fake.next('onboard', 'acme/failed')).reject(new Error('install the dish App on acme and give it failed'))
    ;(await first.fake.next('onboard', 'acme/ready')).resolve()
    ;(await first.fake.next('onboard', 'acme/removed')).resolve()
    const stopped = await first.fake.next('onboard', 'acme/stopped')
    stopped.progress('setup')
    await waitFor('the file to have every project', async () => Object.keys(await statusFileProjects(statusFile).catch(() => ({}))).length === 4)
  } finally {
    await first.stop()
  }
  // dsh stopped mid-onboarding: the job was aborted.
  assert.equal(first.fake.calls.find(entry => entry.project.name === 'acme/stopped')!.signal!.aborted, true)
  // While dish was down, a person removed one by hand.
  await outsideCommit(repository, [{ path: PROJECTS_PATH, text: registry({ 'acme/ready': fields(), 'acme/failed': fields(), 'acme/stopped': fields() }) }])

  const second = await start({ repository, keepInstance: true })
  try {
    assert.equal(second.service().status('acme/ready').state, 'ready')
    ;(await second.fake.next('onboard', 'acme/failed')).resolve()
    ;(await second.fake.next('prepare', 'acme/ready')).resolve()
    ;(await second.fake.next('onboard', 'acme/stopped')).resolve()
    await waitState(second.service, 'acme/stopped', 'ready')
    await waitState(second.service, 'acme/failed', 'ready')
    await settle()
    assert.deepEqual(second.fake.calls.map(entry => `${entry.kind} ${entry.project.name}`), ['onboard acme/failed', 'prepare acme/ready', 'onboard acme/stopped'])
    assert.deepEqual(second.service().status('acme/removed'), { state: 'pending', at: 0 })
    const saved = await waitFor('the file to forget the removed one', async () => {
      const projects = await statusFileProjects(statusFile)
      return Object.hasOwn(projects, 'acme/removed') ? undefined : projects
    })
    assert.deepEqual(Object.keys(saved).sort(), ['acme/failed', 'acme/ready', 'acme/stopped'])
  } finally {
    await second.stop()
  }
})

test('retry: refused for an unknown or ready project, accepted for a failed one and for a ready one whose setup was skipped', async () => {
  const run = await start()
  try {
    const skipped = 'setup didn\'t run outside the sandbox: the checkout isn\'t clean. Run it yourself in /w/acme/skipped: make'
    await run.write(registry({ 'acme/failed': fields(), 'acme/ready': fields(), 'acme/skipped': fields({ setup: 'make' }) }))
    ;(await run.fake.next('onboard', 'acme/failed')).reject(new Error('install the dish App on acme and give it failed'))
    ;(await run.fake.next('onboard', 'acme/ready')).resolve()
    ;(await run.fake.next('onboard', 'acme/skipped')).resolve({ setup: { ran: false, reason: skipped } })
    await waitState(run.service, 'acme/skipped', 'ready')
    assert.equal(run.service().status('acme/skipped').setupSkipped, skipped)

    await assert.rejects(run.service().retry('acme/ready'), /^Error: acme\/ready is ready: only a failed project, or a ready one whose setup was skipped, can be retried$/)
    await assert.rejects(run.service().retry('acme/nothing'), /no project acme\/nothing in projects\.yaml/)

    await run.service().retry('ACME/failed')
    assert.equal(run.service().status('acme/failed').state, 'pending')
    const again = await run.fake.next('onboard', 'acme/failed')
    // It is on its way already.
    await assert.rejects(run.service().retry('acme/failed'), /acme\/failed is pending/)
    again.resolve()
    await waitState(run.service, 'acme/failed', 'ready')

    await run.service().retry('acme/skipped')
    ;(await run.fake.next('onboard', 'acme/skipped')).resolve({ setup: { ran: true } })
    await waitFor('the skipped setup to have run', () => run.service().status('acme/skipped').state === 'ready' && run.service().status('acme/skipped').setupSkipped === undefined)
    assert.deepEqual(run.fake.calls.map(entry => `${entry.kind} ${entry.project.name}`), [
      'onboard acme/failed', 'onboard acme/ready', 'onboard acme/skipped', 'onboard acme/failed', 'onboard acme/skipped',
    ])
  } finally {
    await run.stop()
  }
})

test('without dish-workspaces a project waits as pending and says why; it is onboarded when dish-workspaces appears, and prepared when it comes back', async () => {
  const run = await start({ driver: false })
  try {
    await run.write(registry({ 'acme/widget': fields() }))
    await waitFor('the project to say why it waits', () => run.service().status('acme/widget').message === 'dish-workspaces isn\'t running')
    assert.equal(run.service().status('acme/widget').state, 'pending')
    assert.equal(run.fake.calls.length, 0)

    await run.provideDriver()
    ;(await run.fake.next('onboard', 'acme/widget')).resolve()
    await waitState(run.service, 'acme/widget', 'ready')

    // dish-workspaces restarts: its clones are prepared again.
    await run.removeDriver()
    await run.provideDriver()
    ;(await run.fake.next('prepare', 'acme/widget')).resolve()
    await settle()
    assert.deepEqual(run.fake.calls.map(entry => `${entry.kind} ${entry.project.name}`), ['onboard acme/widget', 'prepare acme/widget'])
    assert.equal(run.service().status('acme/widget').state, 'ready')
  } finally {
    await run.stop()
  }
})

test('dish-workspaces going away mid-onboarding aborts it and leaves the project pending, not failed; it is onboarded when dish-workspaces is back', async () => {
  const run = await start()
  try {
    await run.write(registry({ 'acme/widget': fields() }))
    const first = await run.fake.next('onboard', 'acme/widget')
    first.progress('clone')
    await run.removeDriver()
    await waitFor('the onboarding to be aborted', () => first.signal!.aborted)
    first.reject(new DOMException('The operation was aborted.', 'AbortError'))
    await waitFor('the project to wait', () => run.service().status('acme/widget').message === 'dish-workspaces isn\'t running')
    assert.equal(run.service().status('acme/widget').state, 'pending')

    await run.provideDriver()
    ;(await run.fake.next('onboard', 'acme/widget')).resolve()
    await waitState(run.service, 'acme/widget', 'ready')
    assert.ok(run.statuses.every(([, status]) => status.state !== 'failed'))
  } finally {
    await run.stop()
  }
})

test('dish-workspaces coming back while the store is away is a start all the same, once the store is back', async () => {
  const run = await start()
  try {
    await run.write(registry({ 'acme/ready': fields(), 'acme/widget': fields() }))
    ;(await run.fake.next('onboard', 'acme/ready')).resolve()
    const widget = await run.fake.next('onboard', 'acme/widget')
    await run.dropStore()
    await run.removeDriver()
    widget.reject(new DOMException('The operation was aborted.', 'AbortError'))
    await waitFor('the project to wait', () => run.service().status('acme/widget').message === 'dish-workspaces isn\'t running')
    await run.provideDriver()
    await settle()
    assert.equal(run.fake.calls.length, 2)

    await run.restoreStore()
    ;(await run.fake.next('prepare', 'acme/ready')).resolve()
    ;(await run.fake.next('onboard', 'acme/widget')).resolve()
    await waitState(run.service, 'acme/widget', 'ready')
    await settle()
    assert.deepEqual(run.fake.calls.map(entry => `${entry.kind} ${entry.project.name}`), [
      'onboard acme/ready', 'onboard acme/widget', 'prepare acme/ready', 'onboard acme/widget',
    ])
  } finally {
    await run.stop()
  }
})

test('the store going away forgets nothing and aborts nothing, and coming back onboards nothing that is ready', async () => {
  const run = await start()
  try {
    await run.write(registry({ 'acme/running': fields(), 'acme/widget': fields() }))
    const running = await run.fake.next('onboard', 'acme/running')
    running.progress('clone')
    await run.dropStore()
    assert.equal(run.ctx.get('dishConfig'), undefined)
    assert.deepEqual(await run.service().list(), [])
    assert.equal(running.signal!.aborted, false)
    running.resolve()
    ;(await run.fake.next('onboard', 'acme/widget')).resolve()
    await waitState(run.service, 'acme/widget', 'ready')
    assert.equal(run.service().status('acme/running').state, 'ready')

    await run.restoreStore()
    await waitFor('the projects to be read again', async () => (await run.service().list()).length === 2)
    await settle()
    assert.deepEqual(run.fake.calls.map(entry => `${entry.kind} ${entry.project.name}`), ['onboard acme/running', 'onboard acme/widget'])
    assert.equal(run.service().status('acme/widget').state, 'ready')
  } finally {
    await run.stop()
  }
})

test('a projects.yaml broken by hand: list is empty, problem says why (logged once per commit), and no status is forgotten', async () => {
  const run = await start()
  try {
    await run.write(registry({ 'acme/widget': fields() }))
    ;(await run.fake.next('onboard', 'acme/widget')).resolve()
    await waitState(run.service, 'acme/widget', 'ready')

    const broken = await outsideCommit(run.repository, [{ path: PROJECTS_PATH, text: `projects:\n  acme/widget:\n    gate: ${TOKEN}\n` }])
    const service = run.service()
    assert.deepEqual(await service.list(), [])
    assert.equal(await service.get('acme/widget'), undefined)
    const problem = await service.problem()
    assert.match(problem!, /^projects\.yaml: acme\/widget: family is missing/)
    await service.list()
    const told = run.logs.filter(line => line.startsWith('[dish-projects] warn:') && line.includes('family is missing'))
    assert.equal(told.length, 1, run.logs.join('\n'))
    assert.ok(run.logs.every(line => !line.includes(TOKEN)))

    // The store tells the plugin (as it would for a commit of its own): the pass keeps what it knew.
    await run.ctx.parallel('dish-config/changed', [PROJECTS_PATH], broken, USER)
    await settle()
    assert.equal(service.status('acme/widget').state, 'ready')
    assert.deepEqual(run.fake.calls.map(entry => entry.kind), ['onboard'])

    // Another broken commit is told again; a fixed one serves again.
    await outsideCommit(run.repository, [{ path: PROJECTS_PATH, text: 'projects: [1]\n' }])
    await service.list()
    await waitFor('the second problem to be told', () => run.logs.filter(line => line.startsWith('[dish-projects] warn:')).length === 2)
    await outsideCommit(run.repository, [{ path: PROJECTS_PATH, text: registry({ 'acme/widget': fields() }) }])
    assert.deepEqual((await service.list()).map(project => project.name), ['acme/widget'])
    assert.equal(await service.problem(), undefined)
  } finally {
    await run.stop()
  }
})

test('unloading the plugin aborts the onboarding that runs, and nothing is recorded after', async () => {
  const run = await start()
  await run.write(registry({ 'acme/widget': fields() }))
  const call = await run.fake.next('onboard', 'acme/widget')
  call.progress('clone')
  await run.projects.dispose()
  assert.equal(call.signal!.aborted, true)
  call.reject(new DOMException('The operation was aborted.', 'AbortError'))
  await settle()
  assert.deepEqual(run.statuses.map(([, status]) => status.state), ['cloning'])
  await run.stop()
})

test('terminal prints this plugin\'s warnings to stderr, and terminal: false does not', async () => {
  const line = /^\[dish-projects\] warn: .*family is missing/
  const run = async (terminal: boolean) => {
    await freshInstance()
    const repository = join(await tempDir(), 'config.git')
    const out = captureStderr()
    try {
      const ctx = new Context()
      const config = mountConfig(ctx, repository)
      await config
      const projects = mountProjects(ctx, { terminal })
      await projects
      await waitFor('the seed', async () => (await ctx.dishConfig.read(PROJECTS_PATH)) !== undefined)
      await outsideCommit(repository, [{ path: PROJECTS_PATH, text: 'projects:\n  acme/widget: {}\n' }])
      await (ctx.get('dishProjects') as DishProjects).list()
      if (terminal) await waitFor('the warning to be printed', () => out.lines().some(text => line.test(text)))
      await projects.dispose()
      await config.dispose()
    } finally {
      out.restore()
    }
    return out.lines()
  }
  const printed = await run(true)
  assert.ok(printed.some(text => line.test(text)), printed.join('\n'))
  assert.deepEqual((await run(false)).filter(text => text.startsWith('[dish-projects]')), [])
})
