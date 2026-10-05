import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import type { DishConfigService } from 'dish-config'
import type { DishProjects } from '../src/index.ts'
import { NAMESPACE } from '../src/protocol.ts'
import type { ErrorCode, Fields, Outcome, ProjectInfo } from '../src/protocol.ts'
import { PROJECTS_PATH, SEED_TEXT, fieldsProblem, parseProjects, serializeProjects } from '../src/registry.ts'
import type { ProjectFields } from '../src/registry.ts'
import { ProjectsRemote } from '../src/remote.ts'
import {
  fakeDriver, freshInstance, mountConfig, mountProjects, outsideCommit, provideStub, tempDir, useScratchEnv, waitFor, watchLogs,
} from './helpers.ts'

useScratchEnv()

const AGENT = { kind: 'agent', sessionId: 's1', role: 'main' } as const
const USER = { kind: 'user' } as const
const COMMIT = /^[0-9a-f]{40}$/
const TOKEN = `ghp_${'a'.repeat(40)}`
const INSTALL_TOKEN = `ghs_${'a1B2'.repeat(9)}`

// --- helpers ------------------------------------------------------------------------------------

/** The fields a form sends: the required ones, `''` for the optional ones left empty, and `overrides`. */
function wireFields(overrides: Partial<Fields> = {}): Fields {
  return { family: 'acme', role: 'a test project', gate: 'make check', gateTimeout: '2m', setup: '', setupTimeout: '', gateEnv: {}, ...overrides }
}

/** The same project as `projects.yaml` writes it. */
function fileFields(overrides: Partial<ProjectFields> = {}): ProjectFields {
  return { family: 'acme', role: 'a test project', gate: 'make check', gateTimeout: '2m', ...overrides }
}

/** What `describe` of a `dishWorkspaces` answers (the part the remote reads). */
interface Described {
  clone: string
  workspace: { id: string, title: string } | null
  lastFetch: { at: number, ok: boolean, message?: string } | null
}

interface Run {
  remote: ProjectsRemote
  store: DishConfigService
  ctx: Context
  repository: string
  logs: string[]
  fake: ReturnType<typeof fakeDriver>
  /** What the `dishWorkspaces` stub describes, by project name; and which names it was asked about. */
  described: Map<string, Described>
  asked: string[]
  /** From now on the stub's `describe` throws `error`; `undefined` puts it right. */
  breakDescribe(error: unknown): void
  service: () => DishProjects
  write(registry: Record<string, ProjectFields>): ReturnType<DishConfigService['write']>
}

/**
 * dish-config, a `dishWorkspaces` stub from a sibling (unless `workspaces` is false), then the real dish-projects
 * with its remote, in a fresh `Context` and a fresh instance home.
 */
async function withRemote<T>(body: (run: Run) => Promise<T>, options: { workspaces?: boolean } = {}): Promise<T> {
  await freshInstance()
  const repository = join(await tempDir(), 'config.git')
  const ctx = new Context()
  const logs = watchLogs(ctx)
  const config = mountConfig(ctx, repository)
  await config
  const fake = fakeDriver()
  const described = new Map<string, Described>()
  const asked: string[] = []
  let broken: unknown
  const stub = options.workspaces === false
    ? undefined
    : provideStub(ctx, 'dishWorkspaces', {
      ...fake.driver,
      describe: (name: string) => {
        asked.push(name)
        if (broken !== undefined) throw broken
        return described.get(name)
      },
    })
  await stub
  const projects = mountProjects(ctx)
  await projects
  try {
    await waitFor('the registry to be seeded', async () => (await ctx.dishConfig.read(PROJECTS_PATH)) !== undefined)
    const remote = await waitFor('the remote', () => ctx.get('dishProjectsRemote') as ProjectsRemote | undefined)
    return await body({
      remote,
      store: ctx.dishConfig,
      ctx,
      repository,
      logs,
      fake,
      described,
      asked,
      breakDescribe: (error) => { broken = error },
      service: () => ctx.get('dishProjects') as DishProjects,
      write: registry => ctx.dishConfig.write([{ path: PROJECTS_PATH, text: serializeProjects(registry) }], { author: USER }),
    })
  } finally {
    await projects.dispose()
    await stub?.dispose()
    await config.dispose()
  }
}

/** Run `body` with dish-projects alone: no store. */
async function withoutStore<T>(body: (remote: ProjectsRemote, ctx: Context) => Promise<T>): Promise<T> {
  await freshInstance()
  const ctx = new Context()
  const projects = mountProjects(ctx)
  await projects
  try {
    const remote = await waitFor('the remote', () => ctx.get('dishProjectsRemote') as ProjectsRemote | undefined)
    return await body(remote, ctx)
  } finally {
    await projects.dispose()
  }
}

/** The value of a call that succeeded. */
function ok<T>(outcome: Outcome<T>): T {
  assert.ok(outcome.ok, JSON.stringify(outcome))
  return outcome.value
}

/** Assert that a call failed with `code`, as a result and not a throw; the message is returned. */
function failed(outcome: Outcome<unknown>, code: ErrorCode): string {
  assert.ok(!outcome.ok, `expected ${code}, got ${JSON.stringify(outcome)}`)
  assert.equal(outcome.code, code, outcome.message)
  assert.equal(typeof outcome.message, 'string')
  return outcome.message
}

/** What the wire sees of `value`: JSON, with nothing `undefined` in it. */
function plain(value: unknown): void {
  assert.deepStrictEqual(value, JSON.parse(JSON.stringify(value)))
}

function info(projects: ProjectInfo[], name: string): ProjectInfo {
  const found = projects.find(candidate => candidate.name === name)
  assert.ok(found, `project ${name}`)
  return found
}

/** The registry in the store now, as the file says its projects. */
async function stored(store: DishConfigService): Promise<Record<string, ProjectFields>> {
  const text = await store.read(PROJECTS_PATH)
  assert.ok(text !== undefined)
  const parsed = parseProjects(text)
  assert.ok(parsed.ok, JSON.stringify(parsed))
  return parsed.fields
}

// --- the wire contract ---------------------------------------------------------------------------

const METHODS = ['projects', 'check', 'save', 'removeProject', 'retry']

test('ProjectsRemote is bound as dishProjectsRemote under the dishProjects namespace, and marks every method', async () => {
  await withRemote(async ({ remote, ctx }) => {
    assert.ok(ctx.get('dishProjectsRemote') !== undefined)
    assert.equal(remote.typertRemote.serviceKey, 'dishProjectsRemote')
    assert.equal(remote.typertRemote.namespace, 'dishProjects')
    assert.equal(NAMESPACE, 'dishProjects')
    assert.ok(remote.typertRemote.service instanceof ProjectsRemote)

    const marks = remoteMethods(remote)
    assert.deepEqual(marks.map(mark => mark.method).sort(), [...METHODS].sort())
    for (const mark of marks) {
      assert.deepEqual(mark.invocation, { kind: 'direct' }, mark.method)
      assert.equal(mark.mode, undefined, mark.method)
      assert.equal(mark.exportName, undefined, mark.method)
    }
    // Nothing public is left unmarked: what the page can't call it must not look like it can.
    const own = Object.getOwnPropertyNames(ProjectsRemote.prototype)
      .filter(key => key !== 'constructor' && typeof (ProjectsRemote.prototype as unknown as Record<string, unknown>)[key] === 'function')
    assert.deepEqual(own.sort(), [...METHODS].sort())
  })
})

/** The gateway's source-mode reading of a method's parameter names: the text between its first parentheses, split on commas. */
function parameterNames(method: (...args: never[]) => unknown): string[] {
  const source = Function.prototype.toString.call(method)
  const open = source.indexOf('(')
  const body = source.slice(open + 1, source.indexOf(')', open + 1)).trim()
  return body === '' ? [] : body.split(',').map(part => part.trim())
}

test('the gateway can read every method\'s parameter names from source, and they are the ones the page sends', () => {
  const expected: Record<string, string[]> = {
    projects: [],
    check: ['name', 'fields', 'adding'],
    save: ['name', 'fields', 'base', 'note', 'adding'],
    removeProject: ['name', 'base', 'note'],
    retry: ['name'],
  }
  for (const method of METHODS) {
    const names = parameterNames((ProjectsRemote.prototype as unknown as Record<string, (...args: never[]) => unknown>)[method]!)
    assert.deepEqual(names, expected[method], method)
    for (const name of names) assert.match(name, /^[$A-Z_a-z][$\w]*$/u, `${method}: ${name}`)
  }
})

test('this package and typert-protocol are on one copy of cordis', () => {
  const packageDirectory = (specifier: string): string => {
    let directory = dirname(fileURLToPath(import.meta.resolve(specifier)))
    while (!existsSync(join(directory, 'package.json'))) directory = dirname(directory)
    return realpathSync(directory)
  }
  const own = packageDirectory('@deepseek-ai/cordis')
  assert.equal(realpathSync(join(packageDirectory('@deepseek-ai/dsh-typert-protocol'), '..', 'cordis')), own)
})

test('protocol.ts imports nothing, so the browser build cannot reach the store through it', () => {
  const source = readFileSync(new URL('../src/protocol.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /^\s*import\s/m)
  assert.doesNotMatch(source, /\brequire\s*\(/)
})

// --- projects ------------------------------------------------------------------------------------

test('projects with a fresh store: the head commit, no projects, no problem, no proposals', async () => {
  await withRemote(async ({ remote, store }) => {
    const result = await remote.projects()
    plain(result)
    assert.deepEqual(ok(result), { commit: await store.head(), projects: [], problem: null, pendingProposals: 0 })
    assert.match(ok(result).commit, COMMIT)
  })
})

test('projects lists what the file says, sorted by name without regard to case, with "" for what it leaves out', async () => {
  await withRemote(async ({ remote, store, write }) => {
    await write({
      'acme/widget': fileFields({ gate: 'pnpm test', gateTimeout: '10m', setup: 'pnpm install', setupTimeout: '20m', gateEnv: { CI: '1', LANG: 'C' } }),
      'Acme/another': fileFields({ role: 'the other one' }),
    })
    const result = await remote.projects()
    plain(result)
    const { commit, projects, problem } = ok(result)
    assert.equal(commit, await store.head())
    assert.equal(problem, null)
    assert.deepEqual(projects.map(project => project.name), ['Acme/another', 'acme/widget'])
    assert.deepEqual(info(projects, 'acme/widget').fields, {
      family: 'acme', role: 'a test project', gate: 'pnpm test', gateTimeout: '10m',
      setup: 'pnpm install', setupTimeout: '20m', gateEnv: { CI: '1', LANG: 'C' },
    })
    // What the file leaves out is empty, not a default: the page shows the field blank, and the default applies behind it.
    assert.deepEqual(info(projects, 'Acme/another').fields, {
      family: 'acme', role: 'the other one', gate: 'make check', gateTimeout: '2m', setup: '', setupTimeout: '', gateEnv: {},
    })
  })
})

test('projects without dish-workspaces: each project is pending with the reason, and has no clone, workspace or fetch', async () => {
  await withRemote(async ({ remote, write, service }) => {
    await write({ 'acme/widget': fileFields() })
    await waitFor('the status to say why', () => service().status('acme/widget').message !== undefined)
    const widget = info(ok(await remote.projects()).projects, 'acme/widget')
    plain(widget)
    assert.equal(widget.status.state, 'pending')
    assert.match(widget.status.message!, /dish-workspaces isn't running/)
    assert.equal(typeof widget.status.at, 'number')
    assert.equal(widget.status.setupSkipped, null)
    assert.equal(widget.clone, null)
    assert.equal(widget.workspace, null)
    assert.equal(widget.lastFetch, null)
  }, { workspaces: false })
})

test('projects merges the status, and what dish-workspaces describes: the clone, the workspace\'s title and the last fetch', async () => {
  await withRemote(async ({ remote, write, fake, described, asked, service }) => {
    await write({ 'acme/widget': fileFields({ setup: 'make deps' }), 'acme/gadget': fileFields(), 'acme/sprocket': fileFields(), 'acme/gizmo': fileFields() })
    // Onboarded one at a time, in name order: gadget, gizmo, sprocket, widget.
    ;(await fake.next('onboard', 'acme/gadget')).resolve()
    ;(await fake.next('onboard', 'acme/gizmo')).reject(new Error('could not clone it'))
    ;(await fake.next('onboard', 'acme/sprocket')).resolve({ setup: { ran: true } })
    ;(await fake.next('onboard', 'acme/widget')).resolve({ setup: { ran: false, reason: 'setup didn\'t run outside the sandbox: run it yourself: make deps' } })
    await waitFor('every project to be settled', () => ['acme/gadget', 'acme/gizmo', 'acme/sprocket', 'acme/widget']
      .every(name => ['ready', 'failed'].includes(service().status(name).state)))
    described.set('acme/gadget', { clone: '/work/acme/gadget', workspace: { id: 'w1', title: 'acme/gadget' }, lastFetch: { at: 1700, ok: true } })
    described.set('acme/gizmo', { clone: '/work/acme/gizmo', workspace: null, lastFetch: { at: 1800, ok: false, message: 'fetch failed (exit 128): no route' } })

    const result = await remote.projects()
    plain(result)
    const { projects } = ok(result)
    assert.deepEqual(asked.filter((name, at) => asked.indexOf(name) === at).sort(), ['acme/gadget', 'acme/gizmo', 'acme/sprocket', 'acme/widget'])

    const gadget = info(projects, 'acme/gadget')
    assert.equal(gadget.status.state, 'ready')
    assert.equal(gadget.status.message, null)
    assert.equal(gadget.status.setupSkipped, null)
    assert.equal(gadget.clone, '/work/acme/gadget')
    assert.equal(gadget.workspace, 'acme/gadget')
    assert.deepEqual(gadget.lastFetch, { at: 1700, ok: true, message: null })

    const gizmo = info(projects, 'acme/gizmo')
    assert.equal(gizmo.status.state, 'failed')
    assert.equal(gizmo.status.message, 'could not clone it')
    assert.equal(gizmo.clone, '/work/acme/gizmo')
    assert.equal(gizmo.workspace, null)
    assert.deepEqual(gizmo.lastFetch, { at: 1800, ok: false, message: 'fetch failed (exit 128): no route' })

    // Nothing described: no clone yet.
    const sprocket = info(projects, 'acme/sprocket')
    assert.equal(sprocket.status.state, 'ready')
    assert.equal(sprocket.clone, null)
    assert.equal(sprocket.workspace, null)
    assert.equal(sprocket.lastFetch, null)

    // Ready with setup skipped says why, so the page can show the command to run.
    const widget = info(projects, 'acme/widget')
    assert.equal(widget.status.state, 'ready')
    assert.match(widget.status.setupSkipped!, /run it yourself: make deps/)
  })
})

test('a dish-workspaces whose describe throws costs the list nothing: the project reads as having no clone, and a masked warning is logged', async () => {
  await withRemote(async ({ remote, write, logs, breakDescribe }) => {
    await write({ 'acme/widget': fileFields() })
    breakDescribe(new TypeError(`cannot read ${TOKEN}`))
    const { projects } = ok(await remote.projects())
    assert.equal(info(projects, 'acme/widget').clone, null)
    assert.equal(info(projects, 'acme/widget').workspace, null)
    assert.equal(info(projects, 'acme/widget').lastFetch, null)
    assert.equal(logs.filter(line => /describe/.test(line)).length, 1, logs.join('\n'))
    assert.ok(logs.every(line => !line.includes(TOKEN)), logs.join('\n'))
  })
})

test('a hand-broken registry is a problem, with no projects, and the rest of the answer still serves', async () => {
  await withRemote(async ({ remote, store, repository }) => {
    const commit = await outsideCommit(repository, [{ path: PROJECTS_PATH, text: 'projects:\n  acme/widget:\n    family: acme\n' }])
    const result = await remote.projects()
    plain(result)
    const value = ok(result)
    assert.equal(value.commit, commit)
    assert.equal(value.commit, await store.head())
    assert.deepEqual(value.projects, [])
    assert.match(value.problem!, /^projects\.yaml: acme\/widget: role is missing/)
    assert.equal(value.pendingProposals, 0)
  })
})

test('a store whose registry file is missing reads as no projects', async () => {
  await withRemote(async ({ remote, store }) => {
    // Before the seed (or after a hand deletion) there is no file.
    await store.write([{ path: PROJECTS_PATH, delete: true }], { author: USER })
    const value = ok(await remote.projects())
    assert.deepEqual(value, { commit: await store.head(), projects: [], problem: null, pendingProposals: 0 })
  })
})

test('what dish-workspaces says of the last fetch is masked: a token in its message does not reach the page', async () => {
  await withRemote(async ({ remote, write, described }) => {
    await write({ 'acme/widget': fileFields() })
    described.set('acme/widget', {
      clone: '/work/acme/widget',
      workspace: null,
      lastFetch: { at: 1800, ok: false, message: `fetch failed (exit 128): https://x-access-token:${INSTALL_TOKEN}@github.com/acme/widget.git` },
    })
    const result = await remote.projects()
    const message = info(ok(result).projects, 'acme/widget').lastFetch?.message
    assert.match(message ?? '', /^fetch failed \(exit 128\)/)
    assert.ok(!JSON.stringify(result).includes(INSTALL_TOKEN), JSON.stringify(result))
  })
})

// --- pending proposals -----------------------------------------------------------------------------

test('pendingProposals counts the open and stale proposals that change projects.yaml, and not rejected or accepted ones', async () => {
  await withRemote(async ({ remote, store }) => {
    const text = (name: string): string => serializeProjects({ [name]: fileFields() })
    const first = await store.propose([{ path: PROJECTS_PATH, text: text('acme/one') }], { author: AGENT, title: 'Add one', rationale: '' })
    assert.equal(ok(await remote.projects()).pendingProposals, 1)
    const second = await store.propose([{ path: PROJECTS_PATH, text: text('acme/two') }], { author: AGENT, title: 'Add two', rationale: 'because' })
    assert.equal(ok(await remote.projects()).pendingProposals, 2)

    // A user edit that conflicts makes them stale, and a stale proposal is still pending.
    await store.write([{ path: PROJECTS_PATH, text: text('acme/three') }], { author: USER })
    assert.equal((await store.proposals('stale')).length, 2)
    assert.equal(ok(await remote.projects()).pendingProposals, 2)

    await store.reject(first.id, 'no', { author: USER })
    assert.equal(ok(await remote.projects()).pendingProposals, 1)
    await store.reject(second.id, 'no', { author: USER })
    assert.equal(ok(await remote.projects()).pendingProposals, 0)

    // Accepted: it is on main, and no longer a proposal.
    const third = await store.propose([{ path: PROJECTS_PATH, text: text('acme/four') }], { author: AGENT, title: 'Add four', rationale: '' })
    assert.equal(ok(await remote.projects()).pendingProposals, 1)
    await store.accept(third.id, { author: USER })
    assert.equal(ok(await remote.projects()).pendingProposals, 0)
  })
})

test('a proposal for another document is not counted', async () => {
  await withRemote(async ({ remote, store }) => {
    // Another plugin's namespace, where an agent may propose.
    const claim = store.claim({ prefix: 'notes.yaml', owner: 'a-test', agent: 'propose', validate: () => undefined })
    try {
      await store.propose([{ path: 'notes.yaml', text: 'a: 1\n' }], { author: AGENT, title: 'Notes', rationale: '' })
      assert.equal((await store.proposals()).length, 1)
      assert.equal(ok(await remote.projects()).pendingProposals, 0)
      // One that spans both documents counts for projects.yaml.
      await store.propose([{ path: 'notes.yaml', text: 'a: 2\n' }, { path: PROJECTS_PATH, text: serializeProjects({ 'acme/one': fileFields() }) }], { author: AGENT, title: 'Both', rationale: '' })
      assert.equal(ok(await remote.projects()).pendingProposals, 1)
    } finally {
      claim()
    }
  })
})

// --- check ---------------------------------------------------------------------------------------

test('check of fields that would save says no problem, with and without a project of that name', async () => {
  await withRemote(async ({ remote, write }) => {
    const added = await remote.check('acme/widget', wireFields(), true)
    plain(added)
    assert.deepEqual(ok(added), { problem: null })
    await write({ 'acme/widget': fileFields() })
    assert.deepEqual(ok(await remote.check('acme/widget', wireFields({ gate: 'make' }), false)), { problem: null })
    assert.deepEqual(ok(await remote.check('acme/other', wireFields({ setup: 'make deps', setupTimeout: '1h', gateEnv: { CI: '1' } }), true)), { problem: null })
  })
})

test('check says what the registry says of a field, as a result: the sentence the store would refuse the save with', async () => {
  await withRemote(async ({ remote, store, write }) => {
    await write({ 'acme/widget': fileFields() })
    const head = await store.head()
    const cases: Array<[Partial<Fields>, RegExp]> = [
      [{ gateTimeout: '9s' }, /^projects\.yaml: acme\/widget: gateTimeout must be <n>s, <n>m or <n>h between 10s and 10m$/],
      [{ gateTimeout: '' }, /gateTimeout must be/],
      [{ family: '' }, /^projects\.yaml: acme\/widget: family is blank$/],
      [{ family: 'Frostyard' }, /family must be a lowercase name/],
      [{ role: '  ' }, /role is blank$/],
      [{ gate: 'a\nb' }, /gate must be one line$/],
      [{ setupTimeout: '61m' }, /setupTimeout must be/],
      [{ gateEnv: { GH_TOKEN: 'x' } }, /gateEnv can't set "GH_TOKEN"/],
      [{ gateEnv: { dsh_home: 'x' } }, /gateEnv can't set "dsh_home"/],
      [{ gateEnv: { '1BAD': 'x' } }, /gateEnv names a variable "1BAD"/],
      [{ gateEnv: { OK: 'a\nb' } }, /gateEnv\.OK must be one line/],
    ]
    for (const [override, pattern] of cases) {
      const fields = wireFields(override)
      const problem = ok(await remote.check('acme/widget', fields, false)).problem
      assert.match(problem ?? '', pattern, JSON.stringify(override))
      // The registry's own words, and the very ones the save is refused with.
      assert.equal(problem, `${'projects.yaml'}: ${fieldsProblem('acme/widget', {
        family: fields.family, role: fields.role, gate: fields.gate, gateTimeout: fields.gateTimeout,
        ...fields.setup === '' ? {} : { setup: fields.setup },
        ...fields.setupTimeout === '' ? {} : { setupTimeout: fields.setupTimeout },
        ...Object.keys(fields.gateEnv).length === 0 ? {} : { gateEnv: fields.gateEnv },
      })}`)
      assert.equal(failed(await remote.save('acme/widget', fields, '', '', false), 'INVALID'), problem)
    }
    assert.equal(await store.head(), head)
  })
})

test('check of a name the registry refuses, and of a name that is taken or missing, is a problem', async () => {
  await withRemote(async ({ remote, write }) => {
    await write({ 'Acme/Widget': fileFields() })
    for (const name of ['widget', 'a/b/c', 'scratch/x', 'Scratch/x', 'tokens/x', 'acme/x.git', 'acme/..', `${'o'.repeat(40)}/x`, '/x', 'x/']) {
      const problem = ok(await remote.check(name, wireFields(), true)).problem
      assert.match(problem ?? '', /^projects\.yaml: .*isn't a valid project name/, name)
    }
    assert.equal(ok(await remote.check('Acme/Widget', wireFields(), true)).problem, 'Acme/Widget is already in projects.yaml')
    // GitHub's names don't tell cases apart, so a second spelling is the same project.
    assert.equal(ok(await remote.check('acme/widget', wireFields(), true)).problem, 'acme/widget is already in projects.yaml as Acme/Widget')
    assert.match(ok(await remote.check('acme/nothing', wireFields(), false)).problem ?? '', /^acme\/nothing isn't in projects\.yaml/)
    // Editing under another spelling names the one that is there.
    assert.match(ok(await remote.check('acme/widget', wireFields(), false)).problem ?? '', /isn't in projects\.yaml.*Acme\/Widget/)
  })
})

test('check against a registry that does not parse says so', async () => {
  await withRemote(async ({ remote, repository }) => {
    await outsideCommit(repository, [{ path: PROJECTS_PATH, text: 'projects: nope\n' }])
    const problem = ok(await remote.check('acme/widget', wireFields(), true)).problem
    assert.match(problem ?? '', /^projects\.yaml: projects must be a mapping/)
    assert.match(problem ?? '', /History/)
  })
})

test('check of whitespace in the optional fields: those are as good as empty', async () => {
  await withRemote(async ({ remote }) => {
    assert.deepEqual(ok(await remote.check('acme/widget', wireFields({ setup: '  \n ' }), true)), { problem: null })
  })
})

test('check needs no store: the fields are judged, and names are not looked up', async () => {
  await withoutStore(async (remote, ctx) => {
    assert.equal(ctx.get('dishConfig'), undefined)
    assert.deepEqual(ok(await remote.check('acme/widget', wireFields(), true)), { problem: null })
    // With nothing stored there is nothing to collide with, nor to be missing.
    assert.deepEqual(ok(await remote.check('acme/widget', wireFields(), false)), { problem: null })
    assert.match(ok(await remote.check('acme/widget', wireFields({ gateTimeout: '1s' }), true)).problem ?? '', /gateTimeout must be/)
    assert.match(ok(await remote.check('nope', wireFields(), true)).problem ?? '', /isn't a valid project name/)
  })
})

// --- save: adding ----------------------------------------------------------------------------------

test('save adds a project, as the user, with the note; the file has it, sorted and trimmed, and it is onboarded', async () => {
  await withRemote(async ({ remote, store, ctx, fake, write }) => {
    await write({ 'acme/zed': fileFields() })
    // Onboarded one at a time: zed first, then the project added below.
    ;(await fake.next('onboard', 'acme/zed')).resolve()
    const base = ok(await remote.projects()).commit
    const heard: string[][] = []
    ctx.on('dish-config/changed', (paths) => { heard.push(paths) })

    const result = await remote.save('acme/alpha', wireFields({ family: ' acme ', role: 'The first', setup: 'make deps\nmake build', setupTimeout: '30m', gateEnv: { CI: '1' } }), base, 'a new one', true)
    plain(result)
    const commit = ok(result)
    assert.ok(commit)
    assert.deepEqual(commit.author, { kind: 'user' })
    assert.deepEqual(commit.paths, [PROJECTS_PATH])
    assert.equal(commit.note, 'a new one')
    assert.equal(await store.head(), commit.id)
    assert.deepEqual(await stored(store), {
      'acme/alpha': { family: 'acme', role: 'The first', gate: 'make check', gateTimeout: '2m', setup: 'make deps\nmake build', setupTimeout: '30m', gateEnv: { CI: '1' } },
      'acme/zed': fileFields(),
    })
    assert.deepEqual(Object.keys(await stored(store)), ['acme/alpha', 'acme/zed'])
    // What is written is what the parser read, written out again: trimmed, not the form's ' acme '.
    assert.equal(await store.read(PROJECTS_PATH), serializeProjects(await stored(store)))
    assert.doesNotMatch((await store.read(PROJECTS_PATH))!, /' acme '/)
    await waitFor('the changed event', () => heard.length > 0)
    assert.deepEqual(heard, [[PROJECTS_PATH]])
    // The service saw the new project and set about onboarding it.
    assert.equal((await fake.next('onboard', 'acme/alpha')).project.setup, 'make deps\nmake build')
    assert.deepEqual(ok(await remote.projects()).projects.map(project => project.name), ['acme/alpha', 'acme/zed'])
  })
})

test('save with no base, or a base of "", adds to the registry as it is now', async () => {
  await withRemote(async ({ remote, store }) => {
    assert.ok(ok(await remote.save('acme/one', wireFields(), '', '', true)))
    assert.ok(ok(await remote.save('acme/two', wireFields(), undefined as unknown as string, undefined as unknown as string, true)))
    assert.deepEqual(Object.keys(await stored(store)), ['acme/one', 'acme/two'])
    const [latest] = await store.history({ path: PROJECTS_PATH, limit: 1 })
    assert.equal(latest!.note, undefined)
  })
})

test('adding a name that is in the registry (in any case) is INVALID, and nothing is written', async () => {
  await withRemote(async ({ remote, store, write }) => {
    await write({ 'Acme/Widget': fileFields() })
    const head = await store.head()
    assert.equal(failed(await remote.save('Acme/Widget', wireFields({ gate: 'other' }), '', '', true), 'INVALID'), 'Acme/Widget is already in projects.yaml')
    assert.match(failed(await remote.save('acme/widget', wireFields(), '', '', true), 'INVALID'), /already in projects\.yaml as Acme\/Widget/)
    assert.equal(await store.head(), head)
    assert.equal((await stored(store))['Acme/Widget']!.gate, 'make check')
  })
})

test('adding with a name or a field the registry refuses is INVALID with its sentence', async () => {
  await withRemote(async ({ remote, store }) => {
    const head = await store.head()
    assert.match(failed(await remote.save('scratch/x', wireFields(), '', '', true), 'INVALID'), /^projects\.yaml: .*scratch/)
    assert.match(failed(await remote.save('nope', wireFields(), '', '', true), 'INVALID'), /use owner\/repo/)
    assert.match(failed(await remote.save('acme/x', wireFields({ gateTimeout: '11m' }), '', '', true), 'INVALID'), /gateTimeout must be/)
    assert.match(failed(await remote.save('acme/x', wireFields({ gateEnv: { MY_TOKEN: 'x' } }), '', '', true), 'INVALID'), /gateEnv can't set "MY_TOKEN"/)
    assert.equal(await store.head(), head)
  })
})

// --- save: editing -----------------------------------------------------------------------------------

test('save edits a project: its fields change, the others stay as they were, and a field emptied is left out', async () => {
  await withRemote(async ({ remote, store, write }) => {
    await write({
      'acme/widget': fileFields({ setup: 'make deps', setupTimeout: '20m', gateEnv: { CI: '1' } }),
      'acme/other': fileFields({ role: 'untouched' }),
    })
    const { commit } = ok(await remote.projects())
    const saved = ok(await remote.save('acme/widget', wireFields({ gate: 'pnpm test', gateTimeout: '5m' }), commit, '', false))
    assert.ok(saved)
    assert.deepEqual(await stored(store), {
      'acme/other': fileFields({ role: 'untouched' }),
      'acme/widget': { family: 'acme', role: 'a test project', gate: 'pnpm test', gateTimeout: '5m' },
    })
    // The page's view of it.
    const view = info(ok(await remote.projects()).projects, 'acme/widget')
    assert.deepEqual(view.fields, wireFields({ gate: 'pnpm test', gateTimeout: '5m' }))
  })
})

test('save of what is stored already changes nothing (null)', async () => {
  await withRemote(async ({ remote, store }) => {
    assert.ok(ok(await remote.save('acme/widget', wireFields(), '', '', true)))
    const head = await store.head()
    assert.equal(ok(await remote.save('acme/widget', wireFields(), '', '', false)), null)
    assert.equal(await store.head(), head)
  })
})

test('a rename is not an edit: editing a name the registry lacks is INVALID, and the old one stays', async () => {
  await withRemote(async ({ remote, store, write }) => {
    await write({ 'acme/widget': fileFields() })
    const head = await store.head()
    assert.match(failed(await remote.save('acme/gadget', wireFields(), '', '', false), 'INVALID'), /^acme\/gadget isn't in projects\.yaml/)
    // Another spelling of a name that is there is not that name either.
    assert.match(failed(await remote.save('ACME/widget', wireFields(), '', '', false), 'INVALID'), /isn't in projects\.yaml.*acme\/widget/)
    assert.equal(await store.head(), head)
    assert.deepEqual(Object.keys(await stored(store)), ['acme/widget'])
  })
})

test('editing a ready project writes the file and does not onboard it again', async () => {
  await withRemote(async ({ remote, write, fake, service }) => {
    await write({ 'acme/widget': fileFields() })
    ;(await fake.next('onboard', 'acme/widget')).resolve()
    await waitFor('ready', () => service().status('acme/widget').state === 'ready')
    ok(await remote.save('acme/widget', wireFields({ gate: 'make test' }), '', '', false))
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.deepEqual(fake.calls.map(call => `${call.kind} ${call.project.name}`), ['onboard acme/widget'])
    assert.equal((await service().get('acme/widget'))!.gate, 'make test')
  })
})

// --- a write is held to the file it was built on -------------------------------------------------------

/**
 * Make the next read of the registry through `store` be followed, before it returns, by a write of `text` to `path`
 * as the user: a change that lands between a remote's read of the registry and its write. Returns a function that
 * puts the store right.
 */
function interleave(store: DishConfigService, path: string, text: string): () => void {
  const original = store.read
  let done = false
  store.read = (async (...args: Parameters<DishConfigService['read']>) => {
    const read = await original.apply(store, args)
    if (!done && args[0] === PROJECTS_PATH) {
      done = true
      await store.write([{ path, text }], { author: USER })
    }
    return read
  }) as DishConfigService['read']
  return () => { store.read = original }
}

test('with no base, a change to the registry made after the read is a CONFLICT, not overwritten: save and remove', async () => {
  await withRemote(async ({ remote, store, write }) => {
    await write({ 'acme/base': fileFields() })
    const theirs = serializeProjects({ 'acme/base': fileFields(), 'acme/theirs': fileFields({ role: 'theirs' }) })
    for (const call of [
      () => remote.save('acme/mine', wireFields(), '', '', true),
      () => remote.save('acme/base', wireFields({ gate: 'mine' }), '', '', false),
      () => remote.save('acme/mine', wireFields(), undefined as unknown as string, '', true),
      () => remote.removeProject('acme/base', '', ''),
    ]) {
      await store.write([{ path: PROJECTS_PATH, text: serializeProjects({ 'acme/base': fileFields() }) }], { author: USER })
      const restore = interleave(store, PROJECTS_PATH, theirs)
      try {
        assert.match(failed(await call(), 'CONFLICT'), /projects\.yaml/)
      } finally {
        restore()
      }
      // Their change stands, and the call changed nothing.
      assert.equal(await store.read(PROJECTS_PATH), theirs)
    }
  })
})

test('a change elsewhere in the store is no race, and a write with no base carries the commit it read as its base', async () => {
  await withRemote(async ({ remote, store, write }) => {
    await write({ 'acme/base': fileFields() })
    const restore = interleave(store, 'README.md', '# elsewhere\n')
    try {
      // The registry did not change between the read and the write, so there is nothing to conflict with.
      await store.write([{ path: 'README.md', text: '# before\n' }], { author: USER })
      assert.ok(ok(await remote.save('acme/mine', wireFields(), '', '', true)))
    } finally {
      restore()
    }
    assert.deepEqual(Object.keys(await stored(store)), ['acme/base', 'acme/mine'])
    // With no race the write carries the commit it read as its base.
    const bases: Array<string | undefined> = []
    const original = store.write
    store.write = (async (...args: Parameters<DishConfigService['write']>) => {
      bases.push(args[1].base)
      return original.apply(store, args)
    }) as DishConfigService['write']
    try {
      const head = await store.head()
      ok(await remote.save('acme/more', wireFields(), '', '', true))
      assert.deepEqual(bases, [head])
    } finally {
      store.write = original
    }
  })
})

// --- save: conflicts and the store's word --------------------------------------------------------------

test('save with a base the registry has changed since is CONFLICT, and nothing is written', async () => {
  await withRemote(async ({ remote, store, write }) => {
    await write({ 'acme/widget': fileFields() })
    const { commit } = ok(await remote.projects())
    // Someone else edits it after the page loaded.
    await write({ 'acme/widget': fileFields({ gate: 'theirs' }), 'acme/gadget': fileFields() })
    const head = await store.head()
    const message = failed(await remote.save('acme/widget', wireFields({ gate: 'mine' }), commit, '', false), 'CONFLICT')
    assert.match(message, /projects\.yaml/)
    failed(await remote.save('acme/new', wireFields(), commit, '', true), 'CONFLICT')
    failed(await remote.removeProject('acme/widget', commit, ''), 'CONFLICT')
    assert.equal(await store.head(), head)
    assert.equal((await stored(store))['acme/widget']!.gate, 'theirs')

    // With the commit the page reloads, it goes through.
    const fresh = ok(await remote.projects()).commit
    assert.ok(ok(await remote.save('acme/widget', wireFields({ gate: 'mine' }), fresh, '', false)))
    assert.equal((await stored(store))['acme/widget']!.gate, 'mine')
  })
})

test('the base is per document: a commit elsewhere in the store is not a conflict; a base that is no commit is NOT_FOUND', async () => {
  await withRemote(async ({ remote, store }) => {
    const { commit } = ok(await remote.projects())
    await store.write([{ path: 'README.md', text: '# notes\n' }], { author: USER })
    assert.notEqual(await store.head(), commit)
    assert.ok(ok(await remote.save('acme/widget', wireFields(), commit, '', true)))
    failed(await remote.save('acme/other', wireFields(), '0'.repeat(40), '', true), 'NOT_FOUND')
    failed(await remote.removeProject('acme/widget', 'main~1', ''), 'NOT_FOUND')
    assert.deepEqual(Object.keys(await stored(store)), ['acme/widget'])
  })
})

test('a project is added to the registry as it was at base, so the file the page saw is the file that is edited', async () => {
  await withRemote(async ({ remote, store, write }) => {
    await write({ 'acme/widget': fileFields() })
    const { commit } = ok(await remote.projects())
    await store.write([{ path: 'README.md', text: '# elsewhere\n' }], { author: USER })
    ok(await remote.save('acme/gadget', wireFields(), commit, '', true))
    assert.deepEqual(Object.keys(await stored(store)), ['acme/gadget', 'acme/widget'])
    assert.equal(await store.read('README.md'), '# elsewhere\n')
  })
})

test('save of a secret in a field is SECRET, and the message does not repeat it; nothing is written', async () => {
  await withRemote(async ({ remote, store }) => {
    const head = await store.head()
    const message = failed(await remote.save('acme/widget', wireFields({ gate: `curl -H "Authorization: ${TOKEN}" x` }), '', '', true), 'SECRET')
    assert.ok(!message.includes(TOKEN), message)
    const noted = failed(await remote.save('acme/widget', wireFields(), '', `with ${TOKEN}`, true), 'SECRET')
    assert.ok(!noted.includes(TOKEN), noted)
    assert.equal(await store.head(), head)
  })
})

test('a registry too big to store is TOO_LARGE', async () => {
  await withRemote(async ({ remote }) => {
    failed(await remote.save('acme/widget', wireFields({ setup: 'x'.repeat(300_000) }), '', '', true), 'TOO_LARGE')
  })
})

test('save into a registry that does not parse is INVALID with the problem and a pointer to History; nothing is written', async () => {
  await withRemote(async ({ remote, store, repository }) => {
    const broken = await outsideCommit(repository, [{ path: PROJECTS_PATH, text: 'projects:\n  acme/widget:\n    family: acme\n' }])
    const message = failed(await remote.save('acme/other', wireFields(), '', '', true), 'INVALID')
    assert.match(message, /^projects\.yaml: acme\/widget: role is missing/)
    assert.match(message, /History/)
    assert.match(failed(await remote.removeProject('acme/widget', '', ''), 'INVALID'), /History/)
    assert.equal(await store.head(), broken)
  })
})

// --- remove --------------------------------------------------------------------------------------

test('remove deletes the entry, as the user, with the default note that says the clone and workspace stay', async () => {
  await withRemote(async ({ remote, store, write }) => {
    await write({ 'acme/widget': fileFields(), 'acme/gadget': fileFields({ role: 'stays' }) })
    const { commit } = ok(await remote.projects())
    const result = await remote.removeProject('acme/widget', commit, '')
    plain(result)
    const removed = ok(result)
    assert.ok(removed)
    assert.deepEqual(removed.author, { kind: 'user' })
    assert.deepEqual(removed.paths, [PROJECTS_PATH])
    assert.equal(removed.note, 'Removed acme/widget; its clone and workspace stay')
    assert.deepEqual(await stored(store), { 'acme/gadget': fileFields({ role: 'stays' }) })
    // The note is in History too.
    const [latest] = await store.history({ path: PROJECTS_PATH, limit: 1 })
    assert.equal(latest!.id, removed.id)
    assert.equal(latest!.note, 'Removed acme/widget; its clone and workspace stay')
    assert.deepEqual(ok(await remote.projects()).projects.map(project => project.name), ['acme/gadget'])
  })
})

test('remove with a note keeps it; the last project leaves an empty registry; a missing note is an empty one', async () => {
  await withRemote(async ({ remote, store, write }) => {
    await write({ 'acme/widget': fileFields() })
    const removed = ok(await remote.removeProject('acme/widget', '', 'archived upstream'))
    assert.equal(removed?.note, 'archived upstream')
    assert.equal(await store.read(PROJECTS_PATH), SEED_TEXT)
    await write({ 'acme/widget': fileFields() })
    assert.equal(ok(await remote.removeProject('acme/widget', undefined as unknown as string, undefined as unknown as string))?.note, 'Removed acme/widget; its clone and workspace stay')
  })
})

test('remove of a project the registry lacks is NOT_FOUND; only the exact spelling is there', async () => {
  await withRemote(async ({ remote, store, write }) => {
    await write({ 'acme/widget': fileFields() })
    const head = await store.head()
    assert.match(failed(await remote.removeProject('acme/gadget', '', ''), 'NOT_FOUND'), /acme\/gadget/)
    failed(await remote.removeProject('ACME/widget', '', ''), 'NOT_FOUND')
    failed(await remote.removeProject('__proto__', '', ''), 'NOT_FOUND')
    failed(await remote.removeProject('constructor', '', ''), 'NOT_FOUND')
    failed(await remote.removeProject('', '', ''), 'NOT_FOUND')
    assert.equal(await store.head(), head)
  })
})

test('removing a project stops its onboarding and forgets its status', async () => {
  await withRemote(async ({ remote, write, fake, service }) => {
    await write({ 'acme/widget': fileFields() })
    const call = await fake.next('onboard', 'acme/widget')
    assert.ok(ok(await remote.removeProject('acme/widget', '', '')))
    await waitFor('the onboarding to be aborted', () => call.signal?.aborted)
    await waitFor('the status to be forgotten', () => service().status('acme/widget').at === 0)
    assert.deepEqual(service().status('acme/widget'), { state: 'pending', at: 0 })
  })
})

// --- retry ---------------------------------------------------------------------------------------

test('retry onboards a failed project again; the status goes back to pending', async () => {
  await withRemote(async ({ remote, write, fake, service }) => {
    await write({ 'acme/widget': fileFields() })
    ;(await fake.next('onboard', 'acme/widget')).reject(new Error('could not clone it'))
    await waitFor('failed', () => service().status('acme/widget').state === 'failed')
    const result = await remote.retry('acme/widget')
    plain(result)
    assert.deepEqual(result, { ok: true, value: null })
    const again = await fake.next('onboard', 'acme/widget')
    assert.equal(fake.calls.filter(call => call.kind === 'onboard').length, 2)
    again.resolve()
    await waitFor('ready', () => service().status('acme/widget').state === 'ready')
  })
})

test('retry on a ready project onboards it again too', async () => {
  await withRemote(async ({ remote, write, fake, service }) => {
    await write({ 'acme/widget': fileFields() })
    ;(await fake.next('onboard', 'acme/widget')).resolve()
    await waitFor('ready', () => service().status('acme/widget').state === 'ready')
    assert.deepEqual(await remote.retry('acme/widget'), { ok: true, value: null })
    ;(await fake.next('onboard', 'acme/widget')).resolve()
    assert.equal(fake.calls.filter(call => call.kind === 'onboard').length, 2)
  })
})

test('retry while the project is being onboarded, or queued, is INVALID with the service\'s words', async () => {
  await withRemote(async ({ remote, write, fake }) => {
    await write({ 'acme/one': fileFields(), 'acme/two': fileFields() })
    const first = await fake.next('onboard', 'acme/one')
    assert.match(failed(await remote.retry('acme/one'), 'INVALID'), /acme\/one is being onboarded/)
    assert.match(failed(await remote.retry('acme/two'), 'INVALID'), /acme\/two is queued for onboarding already/)
    first.resolve()
    ;(await fake.next('onboard', 'acme/two')).resolve()
  })
})

test('retry of a project the registry lacks is INVALID', async () => {
  await withRemote(async ({ remote }) => {
    assert.match(failed(await remote.retry('acme/nothing'), 'INVALID'), /no project acme\/nothing in projects\.yaml/)
    failed(await remote.retry(''), 'INVALID')
  })
})

// --- no store ------------------------------------------------------------------------------------

test('without dishConfig, projects is empty at commit "", and save, remove and retry are UNAVAILABLE', async () => {
  await withoutStore(async (remote, ctx) => {
    assert.equal(ctx.get('dishConfig'), undefined)
    const result = await remote.projects()
    plain(result)
    assert.deepEqual(ok(result), { commit: '', projects: [], problem: null, pendingProposals: 0 })
    assert.match(failed(await remote.save('acme/widget', wireFields(), '', '', true), 'UNAVAILABLE'), /config store/)
    failed(await remote.save('acme/widget', wireFields(), '', '', false), 'UNAVAILABLE')
    failed(await remote.removeProject('acme/widget', '', ''), 'UNAVAILABLE')
    assert.match(failed(await remote.retry('acme/widget'), 'UNAVAILABLE'), /config store/)
  })
})

test('a store that comes and goes is looked up on every call', async () => {
  await freshInstance()
  const repository = join(await tempDir(), 'config.git')
  const ctx = new Context()
  const projects = mountProjects(ctx)
  await projects
  try {
    const remote = await waitFor('the remote', () => ctx.get('dishProjectsRemote') as ProjectsRemote | undefined)
    failed(await remote.save('acme/widget', wireFields(), '', '', true), 'UNAVAILABLE')
    assert.equal(ok(await remote.projects()).commit, '')
    const config = mountConfig(ctx, repository)
    await config
    await waitFor('the registry to be seeded', async () => (await ctx.dishConfig.read(PROJECTS_PATH)) !== undefined)
    assert.ok(ok(await remote.save('acme/widget', wireFields(), '', '', true)))
    assert.deepEqual(ok(await remote.projects()).projects.map(project => project.name), ['acme/widget'])
    assert.equal(ok(await remote.projects()).commit, await ctx.dishConfig.head())
    await config.dispose()
    failed(await remote.save('acme/other', wireFields(), '', '', true), 'UNAVAILABLE')
    assert.deepEqual(ok(await remote.projects()), { commit: '', projects: [], problem: null, pendingProposals: 0 })
  } finally {
    await projects.dispose()
  }
})

// --- what comes off the wire ---------------------------------------------------------------------

test('a name that is not a string is INVALID in every method that takes one', async () => {
  await withRemote(async ({ remote }) => {
    for (const name of [undefined, null, 7, {}, ['acme/widget']] as unknown as string[]) {
      failed(await remote.check(name, wireFields(), true), 'INVALID')
      failed(await remote.save(name, wireFields(), '', '', true), 'INVALID')
      failed(await remote.removeProject(name, '', ''), 'INVALID')
      failed(await remote.retry(name), 'INVALID')
    }
  })
})

test('fields that are not the shape of Fields are INVALID, and a missing optional one is an empty one', async () => {
  await withRemote(async ({ remote, store }) => {
    const head = await store.head()
    for (const fields of [undefined, null, 'x', 5, ['family']] as unknown as Fields[]) {
      failed(await remote.check('acme/widget', fields, true), 'INVALID')
      failed(await remote.save('acme/widget', fields, '', '', true), 'INVALID')
    }
    const bad: Array<Record<string, unknown>> = [
      { ...wireFields(), family: 5 },
      { ...wireFields(), gate: null },
      { ...wireFields(), setup: ['make'] },
      { ...wireFields(), gateTimeout: 120 },
      { ...wireFields(), gateEnv: 'CI=1' },
      { ...wireFields(), gateEnv: ['CI'] },
      { ...wireFields(), gateEnv: { CI: 1 } },
      { ...wireFields(), gateEnv: null },
      { ...wireFields(), extra: 'x' },
    ]
    for (const fields of bad) {
      failed(await remote.check('acme/widget', fields as unknown as Fields, true), 'INVALID')
      failed(await remote.save('acme/widget', fields as unknown as Fields, '', '', true), 'INVALID')
    }
    // `adding` is a boolean: it decides what the call means.
    for (const adding of [undefined, null, 'true', 1] as unknown as boolean[]) {
      failed(await remote.check('acme/widget', wireFields(), adding), 'INVALID')
      failed(await remote.save('acme/widget', wireFields(), '', '', adding), 'INVALID')
    }
    assert.equal(await store.head(), head)

    // Missing optional members are empty ones: no setup, no timeout, no environment.
    const minimal = { family: 'acme', role: 'r', gate: 'make', gateTimeout: '1m' } as unknown as Fields
    assert.deepEqual(ok(await remote.check('acme/widget', minimal, true)), { problem: null })
    assert.ok(ok(await remote.save('acme/widget', minimal, '', '', true)))
    assert.deepEqual((await stored(store))['acme/widget'], { family: 'acme', role: 'r', gate: 'make', gateTimeout: '1m' })
  })
})

test('the other parameters: one that is not a string is INVALID', async () => {
  await withRemote(async ({ remote }) => {
    failed(await remote.save('acme/widget', wireFields(), 5 as unknown as string, '', true), 'INVALID')
    failed(await remote.save('acme/widget', wireFields(), '', {} as unknown as string, true), 'INVALID')
    failed(await remote.removeProject('acme/widget', null as unknown as string, ''), 'INVALID')
    failed(await remote.removeProject('acme/widget', '', ['x'] as unknown as string), 'INVALID')
  })
})

test('an environment variable called __proto__ is a variable, not a change of prototype', async () => {
  await withRemote(async ({ remote, store }) => {
    const env = JSON.parse('{"__proto__": "x", "A": "1"}') as Record<string, string>
    assert.ok(ok(await remote.save('acme/widget', wireFields({ gateEnv: env }), '', '', true)))
    const fields = (await stored(store))['acme/widget']!
    assert.deepEqual(Object.keys(fields.gateEnv!), ['__proto__', 'A'])
    assert.equal(Object.getPrototypeOf(fields.gateEnv), Object.prototype)
    const view = info(ok(await remote.projects()).projects, 'acme/widget').fields.gateEnv
    assert.deepEqual(Object.keys(view), ['__proto__', 'A'])
    assert.equal(Object.getPrototypeOf(view), Object.prototype)
  })
})

// --- failures that aren't the registry's ----------------------------------------------------------

/** A remote over stub services, for failures the real store never produces. */
async function withStubs<T>(store: Partial<DishConfigService>, body: (remote: ProjectsRemote) => Promise<T>, projects: Partial<DishProjects> = {}): Promise<T> {
  const ctx = new Context()
  const service: DishProjects = {
    list: async () => [],
    get: async () => undefined,
    status: () => ({ state: 'pending', at: 0 }),
    retry: async () => {},
    problem: async () => undefined,
    ...projects,
  }
  ctx.provide('dishProjects', service)
  ctx.provide('dishConfig', { head: async () => 'c'.repeat(40), read: async () => SEED_TEXT, proposals: async () => [], ...store } as DishConfigService)
  const handle = ctx.plugin(ProjectsRemote)
  try {
    await handle
    return await body(ctx.get('dishProjectsRemote') as ProjectsRemote)
  } finally {
    await handle.dispose()
  }
}

test('a refusal is recognised by its code, whichever package\'s error it is; anything else is thrown', async () => {
  const coded = (code: string) => Object.assign(new Error(`refused: ${code}`), { code })
  for (const code of ['CONFLICT', 'INVALID', 'UNOWNED', 'FORBIDDEN', 'SECRET', 'TOO_LARGE', 'LOCKED', 'STALE', 'NOT_FOUND'] as const) {
    await withStubs({ write: async () => { throw coded(code) } }, async (remote) => {
      assert.equal(failed(await remote.save('acme/widget', wireFields(), '', '', true), code), `refused: ${code}`)
    })
  }
  // A bug, or a failure that isn't a refusal (an errno has a `code` too), is the caller's: thrown, like dish-config's remote does.
  await withStubs({ write: async () => { throw new Error('boom') } }, async (remote) => {
    await assert.rejects(remote.save('acme/widget', wireFields(), '', '', true), /boom/)
  })
  await withStubs({ write: async () => { throw coded('ENOENT') } }, async (remote) => {
    await assert.rejects(remote.save('acme/widget', wireFields(), '', '', true), /ENOENT/)
  })
  await withStubs({ head: async () => { throw new TypeError('not a function') } }, async (remote) => {
    await assert.rejects(remote.projects(), TypeError)
    await assert.rejects(remote.check('acme/widget', wireFields(), true), TypeError)
  })
  // A store that is locked answers with its own code, from the first read.
  await withStubs({ head: async () => { throw coded('LOCKED') } }, async (remote) => {
    assert.equal(failed(await remote.projects(), 'LOCKED'), 'refused: LOCKED')
    failed(await remote.removeProject('acme/widget', '', ''), 'LOCKED')
  })
})

test('the store has the last word: what it refuses after the page\'s own check is the answer', async () => {
  await withStubs({ write: async () => { throw Object.assign(new Error('projects.yaml: the store disagrees'), { code: 'INVALID' }) } }, async (remote) => {
    assert.equal(failed(await remote.save('acme/widget', wireFields(), '', '', true), 'INVALID'), 'projects.yaml: the store disagrees')
  })
})

test('retry makes the service\'s own refusal INVALID, masked; a store failure is the store\'s outcome; anything else is a bug and is thrown', async () => {
  const coded = (code: string) => Object.assign(new Error(`failed: ${code}`), { code })
  // What DishProjects.retry throws on purpose: a plain Error with no code.
  await withStubs({}, async (remote) => {
    const message = failed(await remote.retry('acme/widget'), 'INVALID')
    assert.ok(!message.includes(TOKEN), message)
    assert.match(message, /refused/)
  }, { retry: async () => { throw new Error(`refused: ${TOKEN}`) } })
  // The store failing under it (its `get` reads the registry): the store's code, not INVALID.
  await withStubs({}, async (remote) => {
    assert.equal(failed(await remote.retry('acme/widget'), 'LOCKED'), 'x')
  }, { retry: async () => { throw Object.assign(new Error('x'), { code: 'LOCKED' }) } })
  // Not refusals: an errno, a bug (a subclass of Error), a thrown string.
  await withStubs({}, async (remote) => {
    await assert.rejects(remote.retry('acme/widget'), /EACCES/)
  }, { retry: async () => { throw coded('EACCES') } })
  await withStubs({}, async (remote) => {
    await assert.rejects(remote.retry('acme/widget'), TypeError)
  }, { retry: async () => { throw new TypeError('not a function') } })
  await withStubs({}, async (remote) => {
    await assert.rejects(remote.retry('acme/widget'), /boom/)
  }, { retry: async () => { throw 'boom' } })
  await withStubs({}, async (remote) => {
    assert.deepEqual(await remote.retry('acme/widget'), { ok: true, value: null })
  })
})

test('the wire carries JSON: a commit with nothing undefined in it', async () => {
  const commit = { id: 'a'.repeat(40), time: 1, author: { kind: 'user' }, message: 'm', note: undefined, paths: [PROJECTS_PATH] }
  await withStubs({ write: async () => commit as never }, async (remote) => {
    const saved = ok(await remote.save('acme/widget', wireFields(), '', '', true))
    plain(saved)
    assert.ok(saved && !('note' in saved))
  })
  await withStubs({ write: async () => commit as never, read: async () => serializeProjects({ 'acme/widget': fileFields() }) }, async (remote) => {
    const removed = ok(await remote.removeProject('acme/widget', '', ''))
    plain(removed)
    assert.ok(removed && !('note' in removed))
  })
})

test('a remote doing its work logs nothing', async () => {
  await withRemote(async ({ remote, logs }) => {
    ok(await remote.projects())
    ok(await remote.check('acme/widget', wireFields(), true))
    ok(await remote.save('acme/widget', wireFields(), '', '', true))
    ok(await remote.removeProject('acme/widget', '', ''))
    assert.deepEqual(logs, [])
  }, { workspaces: false })
})
