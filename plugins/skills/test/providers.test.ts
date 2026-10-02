/**
 * The providers, against dsh's real skill registry (`@deepseek-ai/dsh-skill`) and real scopes (`@deepseek-ai/dsh-scope`).
 *
 * The registry is mounted as a plugin on a root `Context`, as dsh mounts it. Scopes are minted with `createScope`: a
 * fake preset's, and under it an agent's whose key is the agent object, as dsh's agent loop does. What an agent is
 * offered is read with `skills.snapshot({ scope })` and `skills.get(name, { scope })`, and `isModelInvocable` says what
 * the `skill` tool would let the model load. `agentPresets` and `dishCrew` are stubs provided by sibling plugins.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry, { isModelInvocable } from '@deepseek-ai/dsh-skill'
import type { SkillCandidate, SkillProvider, SkillProviderControl, SkillSummary } from '@deepseek-ai/dsh-skill'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import { DEFAULTS } from '../src/defaults.ts'
import {
  DEFAULT_SOURCE, GLOBAL_PROVIDER, GLOBAL_RANK, ROLE_PROVIDER, ROLE_RANK, STORE_SOURCE, globalProvider, roleProvider, watchAgents,
} from '../src/providers.ts'
import type { WatchOptions } from '../src/providers.ts'
import type { Catalog, DishSkills, SkillDoc } from '../src/service.ts'
import { createDishSkills } from '../src/service.ts'
import { SHIPPED_ROLES, offeredTo, parseSkill, pathFor } from '../src/skill.ts'
import { COMMIT, dirs, mountConfig, mountSkills, provideStub, seeded, skillText, userWrite, waitFor, watchLogs } from './helpers.ts'

// --- the registry and the scopes ----------------------------------------------------------------------

/** A root `Context` with dsh's real skill registry mounted on it, as a plugin. */
async function registryRoot(): Promise<Context> {
  const root = new Context()
  await root.plugin(SkillRegistry)
  return root
}

/** The registry, as a test reads it: unscoped, so `snapshot` and `get` see exactly the scope they are given. */
const registryOf = (root: Context): SkillRegistry => root.get('skills')!

/** A fake agent, shaped as dish reads one: an id, a session header that says whether it is a child, and its own scoped `ctx`. */
interface FakeAgent {
  id: string
  session: { header: { delegationDepth?: number, origin?: string } }
  options: object
  ctx: Context
}

/** What a test needs of an agent: the agent, its scope (to dispose) and the preset key it is under. */
interface Minted {
  agent: FakeAgent
  scope: Scope
}

/**
 * Mint a fake agent under `presetKey`'s scope: its scope key is the agent object, as dsh's agent loop makes it
 * (`createScope(loopCtx, this)`), with the preset's key as its parent, as the preset registry binds it.
 */
function mintAgent(root: Context, presetKey: object, id: string, child = false): Minted {
  const agent = { id, session: { header: child ? { delegationDepth: 1, origin: 'subagent' } : {} }, options: {} } as FakeAgent
  const scope = createScope(root, agent, { parent: presetKey })
  agent.ctx = scope.ctx
  return { agent, scope }
}

/** A preset's scope key, with its scope minted as the preset registry mints one. */
function mintPreset(root: Context): object {
  const key = {}
  createScope(root, key)
  return key
}

/** A stub `agentPresets` that names the preset of each agent ctx it was told about. */
function presetsStub(): { composedPreset(ctx: Context): string | undefined, bind(agent: FakeAgent, preset: string): void } {
  const bound = new WeakMap<object, string>()
  return {
    composedPreset: ctx => bound.get(scopeOf(ctx) as object),
    bind: (agent, preset) => { bound.set(agent, preset) },
  }
}

interface CrewStub {
  records: { lookup(childId: string): Promise<{ sessionId: string, record: { role: string } } | undefined> }
  roles: Map<string, string>
  failing: boolean
  calls: string[]
}

/** A stub `dishCrew` whose record knows the children in `roles`, and rejects every lookup while `failing`. */
function crewStub(): CrewStub {
  const stub: CrewStub = {
    roles: new Map(),
    failing: false,
    calls: [],
    records: {
      lookup: async (childId) => {
        stub.calls.push(childId)
        if (stub.failing) throw new Error('the record is locked')
        const role = stub.roles.get(childId)
        return role === undefined ? undefined : { sessionId: 'parent-session', record: { role } }
      },
    },
  }
  return stub
}

/** Announce `agent` as dsh's agent loop does: a serial `agent/created`, awaited. */
async function announce(root: Context, agent: FakeAgent, source = 'startup'): Promise<void> {
  await root.serial('agent/created', { agent, source } as never)
}

/** The entries of `snapshot`, by name. */
function byName(skills: readonly SkillSummary[]): Map<string, SkillSummary> {
  return new Map(skills.map(skill => [skill.name, skill]))
}

/** The names `snapshot` lets a model load: what the `skill` tool would offer and accept. */
function modelNames(skills: readonly SkillSummary[]): string[] {
  return skills.filter(isModelInvocable).map(skill => skill.name).sort()
}

/** The shipped skills, parsed: what a store-less service serves. */
const SHIPPED: SkillDoc[] = Object.entries(DEFAULTS).map(([name, text]) => {
  const result = parseSkill(pathFor(name), text)
  if (!result.ok) throw new Error(result.problem)
  return { ...result.skill, path: pathFor(name), text }
}).sort((a, b) => a.name < b.name ? -1 : 1)

/** The shipped skills offered to `role`, by name. */
const shippedFor = (role: string): string[] => SHIPPED.filter(doc => offeredTo(doc, role)).map(doc => doc.name).sort()

const silent = { warn() {}, info() {} }

/** A store-less service: the shipped skills at `commit: null`. */
const defaultsService = (): DishSkills => createDishSkills({ store: () => undefined, crew: () => undefined, logger: silent })

// --- a service of the test's own --------------------------------------------------------------------

/** A valid skill document of the test's own, with `overrides` laid over it afterwards (which may make it invalid). */
function doc(name: string, roles: string[] | null, overrides: Partial<Record<keyof SkillDoc, unknown>> = {}, extra = ''): SkillDoc {
  const text = skillText(name, roles).replace('---\nDo', `${extra}---\nDo`)
  const result = parseSkill(pathFor(name), text)
  if (!result.ok) throw new Error(result.problem)
  return { ...result.skill, path: pathFor(name), text, ...overrides } as SkillDoc
}

interface FakeService extends DishSkills {
  /** Serve `catalog` from now on (the next `catalog()`), or fail with `error`. */
  serve(catalog: Catalog | Error): void
  /** The listeners subscribed now. */
  listeners(): number
  /** How many times `catalog()` was called. */
  reads(): number
}

/** A `DishSkills` that serves whatever the test says, and counts what is asked of it. */
function fakeService(initial: Catalog): FakeService {
  let current: Catalog | Error = initial
  let reads = 0
  const listeners = new Set<() => void>()
  const service: FakeService = {
    catalog: async () => {
      reads++
      if (current instanceof Error) throw current
      return { ...current, skills: [...current.skills] }
    },
    forRole: async role => (await service.catalog()).skills.filter(skill => offeredTo(skill, role)),
    knownRoles: async () => [...SHIPPED_ROLES],
    defaultText: () => undefined,
    shipped: () => [],
    onChange(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    changed() {
      for (const listener of [...listeners]) listener()
    },
    serve(catalog) { current = catalog },
    listeners: () => listeners.size,
    reads: () => reads,
  }
  return service
}

const COMMIT_A = 'a'.repeat(40)
const COMMIT_B = 'b'.repeat(40)

/** A plugin that does only `watchAgents`, with `options`: the agent half of dish-skills, with a service of the test's own. */
async function mountWatcher(root: Context, options: WatchOptions): Promise<void> {
  await root.plugin({ name: 'watcher', apply: (ctx: Context) => { watchAgents(ctx, options) } } as never, undefined as never)
}

/** A provider of the test's own, in the global layer, that lists one skill: to see that it survives the others' trouble. */
function bystander(): (control: SkillProviderControl) => SkillProvider {
  return () => ({
    name: 'bystander',
    list: async () => [{
      name: 'bystander-skill', description: 'Use when testing.', invocation: { modelInvocable: true, userInvocable: true },
      source: 'custom', provider: 'bystander', rank: 500, locator: null,
    }],
    get: async () => undefined,
  })
}

// --- the spike: the registry can be driven this way ---------------------------------------------------

test('the real registry: a host context registers globally, an agent context in its own layer, and a scope sees its chain', async () => {
  const root = await registryRoot()
  const skills = registryOf(root)
  const presetKey = mintPreset(root)
  const { agent, scope } = mintAgent(root, presetKey, 'a1')
  const other = mintAgent(root, presetKey, 'a2')
  assert.equal(scopeOf(root), undefined)
  assert.equal(scopeOf(agent.ctx), agent)

  skills.registerProvider(bystander())
  // An agent's ctx has no `skills` property (dsh's agent loop doesn't inject it), but `get` finds the registry, bound to that ctx.
  assert.throws(() => (agent.ctx as unknown as { skills: unknown }).skills, /without inject/)
  agent.ctx.get('skills')!.registerProvider(roleProvider(defaultsService(), async () => 'coder'))

  const own = await skills.snapshot({ scope: agent })
  assert.equal(own.complete, true)
  assert.deepEqual(modelNames(own.skills), [...shippedFor('coder'), 'bystander-skill'].sort())
  // Neither another agent of the same preset, the preset, nor the global view sees the agent's layer.
  for (const scopeKey of [other.agent, presetKey, undefined]) {
    assert.deepEqual(modelNames((await skills.snapshot({ scope: scopeKey })).skills), ['bystander-skill'])
  }
  await scope.dispose()
  assert.deepEqual(modelNames((await skills.snapshot({ scope: agent })).skills), ['bystander-skill'])
})

// --- the global provider --------------------------------------------------------------------------------

test('global only: every skill is listed for the / menu, and none is offered to a model, in every scope', async () => {
  const root = await registryRoot()
  await mountSkills(root)
  const skills = registryOf(root)
  const presetKey = mintPreset(root)
  const { agent } = mintAgent(root, presetKey, 'a1')

  // Unscoped: the host plugin's context has no scope, so its provider is in the global layer, which every view merges.
  for (const scopeKey of [undefined, presetKey, agent]) {
    const snapshot = await skills.snapshot({ scope: scopeKey })
    assert.equal(snapshot.complete, true)
    assert.deepEqual(snapshot.skills.map(skill => skill.name), SHIPPED.map(doc => doc.name))
    for (const skill of snapshot.skills) {
      assert.deepEqual(skill.invocation, { modelInvocable: false, userInvocable: true }, skill.name)
      assert.equal(skill.provider, GLOBAL_PROVIDER)
      assert.equal(skill.source, DEFAULT_SOURCE)
    }
  }
  // Loading one gives its body, though the `skill` tool would refuse it to a model.
  const loaded = await skills.get('brainstorming', { scope: agent })
  assert.equal(loaded?.content, SHIPPED.find(doc => doc.name === 'brainstorming')!.body)
  assert.equal(loaded && isModelInvocable(loaded), false)
})

test('the global provider: the skill\'s own user-invocable flag, never model-invocable, and the candidate\'s fields', async () => {
  const root = await registryRoot()
  const catalog: Catalog = {
    commit: COMMIT_A,
    skills: [doc('hidden', ['main'], {}, 'user-invocable: false\n'), doc('menu-only', null, {}, 'disable-model-invocation: true\n'), doc('plain', ['coder'])],
    problems: [],
  }
  const service = fakeService(catalog)
  let provider: SkillProvider | undefined
  registryOf(root).registerProvider((control) => {
    provider = globalProvider(service)(control)
    return provider
  })
  const listed = await provider!.list({})
  assert.ok(!Array.isArray(listed))
  const { candidates, complete } = listed as { candidates: readonly SkillCandidate[], complete: boolean }
  assert.equal(complete, true)
  assert.deepEqual(candidates.map(candidate => ({ ...candidate })), [
    {
      name: 'hidden', description: 'Use when you need hidden.', invocation: { modelInvocable: false, userInvocable: false },
      source: STORE_SOURCE, provider: GLOBAL_PROVIDER, rank: GLOBAL_RANK, locator: { commit: COMMIT_A, name: 'hidden' }, metadata: { roles: ['main'] },
    },
    {
      name: 'menu-only', description: 'Use when you need menu-only.', invocation: { modelInvocable: false, userInvocable: true },
      source: STORE_SOURCE, provider: GLOBAL_PROVIDER, rank: GLOBAL_RANK, locator: { commit: COMMIT_A, name: 'menu-only' }, metadata: {},
    },
    {
      name: 'plain', description: 'Use when you need plain.', invocation: { modelInvocable: false, userInvocable: true },
      source: STORE_SOURCE, provider: GLOBAL_PROVIDER, rank: GLOBAL_RANK, locator: { commit: COMMIT_A, name: 'plain' }, metadata: { roles: ['coder'] },
    },
  ])
  assert.equal(GLOBAL_PROVIDER, 'dish')
  assert.equal(GLOBAL_RANK, 350)
  const definition = await provider!.get(candidates[2]!, {})
  assert.deepEqual({ ...definition }, {
    name: 'plain', description: 'Use when you need plain.', invocation: { modelInvocable: false, userInvocable: true },
    source: STORE_SOURCE, provider: GLOBAL_PROVIDER, content: 'Do the plain thing.', metadata: { roles: ['coder'] },
  })
})

test('the global provider comes with the registry and goes with it, whichever starts first', async () => {
  const root = new Context()
  await mountSkills(root)
  const registry = root.plugin(SkillRegistry)
  await registry
  assert.equal((await registryOf(root).list()).length, SHIPPED.length)
  await registry.dispose()
  assert.equal(root.get('skills'), undefined)
  await root.plugin(SkillRegistry)
  assert.equal((await registryOf(root).list()).length, SHIPPED.length)
})

// --- agents ---------------------------------------------------------------------------------------------

interface Agents {
  root: Context
  skills: SkillRegistry
  presets: ReturnType<typeof presetsStub>
  crew: CrewStub
  presetKey: object
  logs: string[]
}

/** The registry, dish-skills (store-less, so the shipped skills) and the stubs, all mounted on one root. */
async function agents(options: { crew?: boolean, config?: Parameters<typeof mountSkills>[1] } = {}): Promise<Agents> {
  const root = await registryRoot()
  const logs = watchLogs(root)
  const presets = presetsStub()
  const crew = crewStub()
  await provideStub(root, 'agentPresets', presets)
  if (options.crew !== false) await provideStub(root, 'dishCrew', crew)
  await mountSkills(root, options.config)
  return { root, skills: registryOf(root), presets, crew, presetKey: mintPreset(root), logs }
}

test('a main agent on the dish preset: main\'s skills are offered to the model, the rest stay menu-only, and get returns the body', async () => {
  const { root, skills, presets, presetKey, logs } = await agents()
  const { agent } = mintAgent(root, presetKey, 'main-1')
  presets.bind(agent, 'dish')
  await announce(root, agent)

  const snapshot = await skills.snapshot({ scope: agent })
  assert.equal(snapshot.complete, true)
  // Every skill is still there, for the menu.
  assert.deepEqual(snapshot.skills.map(skill => skill.name), SHIPPED.map(doc => doc.name))
  assert.deepEqual(modelNames(snapshot.skills), shippedFor('main'))
  const entries = byName(snapshot.skills)
  assert.ok(isModelInvocable(entries.get('brainstorming')!))
  assert.equal(entries.get('brainstorming')!.provider, ROLE_PROVIDER)
  assert.equal(entries.get('brainstorming')!.source, DEFAULT_SOURCE)
  // Not main's: the global entry, which the `skill` tool refuses to a model.
  for (const name of ['reviewing-work', 'researching', 'writing-for-readers', 'changing-infrastructure']) {
    assert.equal(isModelInvocable(entries.get(name)!), false, name)
    assert.equal(entries.get(name)!.provider, GLOBAL_PROVIDER, name)
  }

  const loaded = await skills.get('brainstorming', { scope: agent })
  assert.equal(loaded?.content, SHIPPED.find(doc => doc.name === 'brainstorming')!.body)
  assert.equal(loaded?.provider, ROLE_PROVIDER)
  assert.ok(loaded && isModelInvocable(loaded))
  const refused = await skills.get('reviewing-work', { scope: agent })
  assert.equal(refused?.provider, GLOBAL_PROVIDER)
  assert.equal(refused && isModelInvocable(refused), false)
  assert.deepEqual(logs, [])
})

test('a coder child gets its role from the crew\'s record', async () => {
  const { root, skills, presets, crew, presetKey } = await agents()
  const { agent } = mintAgent(root, presetKey, 'child-1', true)
  presets.bind(agent, 'dish')
  crew.roles.set('child-1', 'coder')
  await announce(root, agent)

  const snapshot = await skills.snapshot({ scope: agent })
  assert.equal(snapshot.complete, true)
  assert.deepEqual(modelNames(snapshot.skills), shippedFor('coder'))
  assert.ok(modelNames(snapshot.skills).includes('test-driven-development'))
  assert.ok(!modelNames(snapshot.skills).includes('brainstorming'))
  assert.deepEqual(crew.calls, ['child-1'])
  // The role is read once: a fresh catalog doesn't ask again.
  ;(root.get('dishSkills') as DishSkills).changed()
  await skills.snapshot({ scope: agent })
  assert.deepEqual(crew.calls, ['child-1'])
})

test('a crew lookup that fails is incomplete, and complete once it recovers', async () => {
  const { root, skills, presets, crew, presetKey, logs } = await agents()
  const { agent } = mintAgent(root, presetKey, 'child-2', true)
  presets.bind(agent, 'dish')
  crew.roles.set('child-2', 'reviewer')
  crew.failing = true
  await announce(root, agent)

  const first = await skills.snapshot({ scope: agent })
  assert.equal(first.complete, false)
  assert.deepEqual(modelNames(first.skills), [])
  // An incomplete catalog isn't cached, so the next step asks again.
  crew.failing = false
  const second = await skills.snapshot({ scope: agent })
  assert.equal(second.complete, true)
  assert.deepEqual(modelNames(second.skills), shippedFor('reviewer'))
  assert.deepEqual(crew.calls, ['child-2', 'child-2'])
  assert.equal(logs.filter(line => line.includes('the record is locked')).length, 1, logs.join('\n'))
})

test('a child the crew doesn\'t know, or a child with no crew loaded, is offered nothing of its own', async () => {
  for (const withCrew of [true, false]) {
    const { root, skills, presets, presetKey, logs } = await agents({ crew: withCrew })
    const { agent } = mintAgent(root, presetKey, 'stranger', true)
    presets.bind(agent, 'dish')
    await announce(root, agent)
    const snapshot = await skills.snapshot({ scope: agent })
    assert.equal(snapshot.complete, true)
    assert.deepEqual(modelNames(snapshot.skills), [])
    assert.deepEqual(logs, [])
  }
})

test('an agent on another preset, or on none, gets nothing in its own layer', async () => {
  const { root, skills, presets, presetKey } = await agents()
  const other = mintAgent(root, presetKey, 'other-1')
  presets.bind(other.agent, 'other')
  const none = mintAgent(root, presetKey, 'none-1')
  const inherited = mintAgent(root, presetKey, 'constructor')
  presets.bind(inherited.agent, 'constructor')
  for (const { agent } of [other, none, inherited]) {
    await announce(root, agent)
    const snapshot = await skills.snapshot({ scope: agent })
    assert.deepEqual(modelNames(snapshot.skills), [], agent.id)
    assert.ok(snapshot.skills.every(skill => skill.provider === GLOBAL_PROVIDER), agent.id)
  }
})

test('the presets setting picks the preset and the role of its top-level agents', async () => {
  const { root, skills, presets, presetKey } = await agents({ config: { presets: { work: 'coder' } } })
  const worker = mintAgent(root, presetKey, 'w1')
  presets.bind(worker.agent, 'work')
  const dish = mintAgent(root, presetKey, 'd1')
  presets.bind(dish.agent, 'dish')
  await announce(root, worker.agent)
  await announce(root, dish.agent)
  assert.deepEqual(modelNames((await skills.snapshot({ scope: worker.agent })).skills), shippedFor('coder'))
  assert.deepEqual(modelNames((await skills.snapshot({ scope: dish.agent })).skills), [])
})

test('the registrations go when the agent\'s scope is disposed, and so do their change listeners', async () => {
  const root = await registryRoot()
  const skills = registryOf(root)
  const presets = presetsStub()
  await provideStub(root, 'agentPresets', presets)
  const service = fakeService({ commit: COMMIT_A, skills: [doc('alpha', ['main']), doc('beta', ['coder'])], problems: [] })
  await mountWatcher(root, { service, presets: { dish: 'main' }, logger: silent })
  const presetKey = mintPreset(root)
  const { agent, scope } = mintAgent(root, presetKey, 'main-2')
  presets.bind(agent, 'dish')
  await announce(root, agent)
  assert.deepEqual(modelNames((await skills.snapshot({ scope: agent })).skills), ['alpha'])
  assert.equal(service.listeners(), 1)

  await scope.dispose()
  const after = await skills.snapshot({ scope: agent })
  assert.deepEqual(after.skills, [])
  assert.equal(service.listeners(), 0)
})

test('the registrations go with the plugin, and the agent keeps nothing of a plugin that is gone', async () => {
  const root = await registryRoot()
  const skills = registryOf(root)
  const presets = presetsStub()
  await provideStub(root, 'agentPresets', presets)
  const handle = mountSkills(root)
  await handle
  const presetKey = mintPreset(root)
  const { agent } = mintAgent(root, presetKey, 'main-3')
  presets.bind(agent, 'dish')
  await announce(root, agent)
  assert.deepEqual(modelNames((await skills.snapshot({ scope: agent })).skills), shippedFor('main'))

  await handle.dispose()
  assert.deepEqual((await skills.snapshot({ scope: agent })).skills, [])
  // A new start offers new agents their skills again; the old agent was announced before it and is left as it is.
  await mountSkills(root)
  const { agent: next } = mintAgent(root, presetKey, 'main-4')
  presets.bind(next, 'dish')
  await announce(root, next)
  assert.deepEqual(modelNames((await skills.snapshot({ scope: next })).skills), shippedFor('main'))
  assert.deepEqual(modelNames((await skills.snapshot({ scope: agent })).skills), [])
})

test('an agent announced twice is registered once', async () => {
  const { root, skills, presets, presetKey, logs } = await agents()
  const { agent } = mintAgent(root, presetKey, 'main-5')
  presets.bind(agent, 'dish')
  await announce(root, agent, 'startup')
  await announce(root, agent, 'clear')
  assert.deepEqual(modelNames((await skills.snapshot({ scope: agent })).skills), shippedFor('main'))
  assert.deepEqual(logs, [])
})

test('watchAgents never throws into dsh: no registry on the agent, a failing preset lookup, an agent that is gone, nonsense', async () => {
  const root = new Context()
  const logs: string[] = []
  const logger = { warn: (format: string, ...args: unknown[]) => { logs.push([format, ...args].join(' ')) } }
  let presetError: Error | undefined
  const presets = presetsStub()
  await provideStub(root, 'agentPresets', {
    composedPreset: (ctx: Context) => {
      if (presetError !== undefined) throw presetError
      return presets.composedPreset(ctx)
    },
  })
  await mountWatcher(root, { service: defaultsService(), presets: { dish: 'main' }, logger })
  const presetKey = mintPreset(root)

  // No skills registry at all.
  for (const id of ['n1', 'n2']) {
    const { agent } = mintAgent(root, presetKey, id)
    presets.bind(agent, 'dish')
    await announce(root, agent)
  }
  assert.equal(logs.length, 1, logs.join('\n'))
  assert.match(logs[0]!, /skill registry/)

  // The preset lookup throws.
  presetError = new Error('presets are reloading')
  for (const id of ['p1', 'p2']) await announce(root, mintAgent(root, presetKey, id).agent)
  presetError = undefined
  assert.equal(logs.length, 2, logs.join('\n'))
  assert.match(logs[1]!, /presets are reloading/)

  // An agent whose scope is gone: the registry refuses the registration.
  await root.plugin(SkillRegistry)
  const gone = mintAgent(root, presetKey, 'g1')
  presets.bind(gone.agent, 'dish')
  await gone.scope.dispose()
  await announce(root, gone.agent)
  assert.equal(logs.length, 3, logs.join('\n'))

  // Payloads that aren't agents.
  for (const agent of [undefined, null, 3, {}, { ctx: null }]) await root.serial('agent/created', { agent, source: 'startup' } as never)
  await root.serial('agent/created', undefined as never)
  assert.equal(logs.length, 3, logs.join('\n'))
})

// --- refresh ----------------------------------------------------------------------------------------------

test('service.changed() refreshes every scope\'s snapshot; without it the registry keeps its cached catalog', async () => {
  const root = await registryRoot()
  const skills = registryOf(root)
  const service = fakeService({ commit: COMMIT_A, skills: [doc('alpha', ['main'])], problems: [] })
  skills.registerProvider(globalProvider(service))
  const presetKey = mintPreset(root)
  const { agent } = mintAgent(root, presetKey, 'main-6')
  agent.ctx.get('skills')!.registerProvider(roleProvider(service, async () => 'main'))
  assert.deepEqual(modelNames((await skills.snapshot({ scope: agent })).skills), ['alpha'])

  service.serve({ commit: COMMIT_B, skills: [doc('alpha', ['main']), doc('beta', ['main'])], problems: [] })
  assert.deepEqual(modelNames((await skills.snapshot({ scope: agent })).skills), ['alpha'])
  service.changed()
  assert.deepEqual(modelNames((await skills.snapshot({ scope: agent })).skills), ['alpha', 'beta'])
  assert.deepEqual((await skills.snapshot()).skills.map(skill => skill.name), ['alpha', 'beta'])
  // Both providers subscribed.
  assert.equal(service.listeners(), 2)
})

test('an edit in the store reaches every agent\'s catalog, and the source says the store', async () => {
  const where = await dirs()
  const root = await registryRoot()
  const presets = presetsStub()
  await provideStub(root, 'agentPresets', presets)
  const config = mountConfig(root, where.repository)
  await config
  const handle = mountSkills(root)
  await handle
  try {
    await seeded(root.dishConfig)
    const skills = registryOf(root)
    const presetKey = mintPreset(root)
    const { agent } = mintAgent(root, presetKey, 'main-7')
    presets.bind(agent, 'dish')
    await announce(root, agent)

    const before = await waitFor('the store\'s catalog', async () => {
      const snapshot = await skills.snapshot({ scope: agent })
      return snapshot.skills.every(skill => skill.source === STORE_SOURCE) ? snapshot : undefined
    })
    assert.deepEqual(modelNames(before.skills), shippedFor('main'))
    assert.match(await root.dishConfig.head(), COMMIT)

    // A new skill for main, and brainstorming taken away from main.
    await userWrite(root.dishConfig, 'pairing', skillText('pairing', ['main']))
    await userWrite(root.dishConfig, 'brainstorming', DEFAULTS['brainstorming']!.replace('roles: [main]', 'roles: [architect]'))
    const after = await waitFor('the edit to reach the catalog', async () => {
      const names = modelNames((await skills.snapshot({ scope: agent })).skills)
      return names.includes('pairing') && !names.includes('brainstorming') ? names : undefined
    })
    assert.deepEqual(after, [...shippedFor('main').filter(name => name !== 'brainstorming'), 'pairing'].sort())
    const loaded = await skills.get('pairing', { scope: agent })
    assert.equal(loaded?.content, 'Do the pairing thing.')
    assert.equal(loaded?.source, STORE_SOURCE)
  } finally {
    await handle.dispose()
    await config.dispose()
  }
})

// --- what a provider lists, and what it loads ----------------------------------------------------------------

test('an invalid document never reaches the registry: it is left out and logged once, and the rest still serve', async () => {
  const root = await registryRoot()
  const skills = registryOf(root)
  const logs: string[] = []
  const logger = { warn: (format: string, ...args: unknown[]) => { logs.push([format, ...args].join(' ')) } }
  const service = fakeService({
    commit: COMMIT_A,
    skills: [
      doc('alpha', ['main']),
      doc('blank', ['main'], { description: '' }),
      doc('spaces', ['main'], { description: '   ' }),
      doc('bad-name', ['main'], { name: 'Bad Name' }),
      doc('long-name', ['main'], { name: 'x'.repeat(65) }),
      doc('flags', ['main'], { modelInvocable: 'yes' }),
      doc('nobody', ['main'], { body: undefined }),
      doc('zeta', ['main']),
    ],
    problems: [],
  })
  skills.registerProvider(globalProvider(service, logger))
  const presetKey = mintPreset(root)
  const { agent } = mintAgent(root, presetKey, 'main-8')
  agent.ctx.get('skills')!.registerProvider(roleProvider(service, async () => 'main', logger))
  skills.registerProvider(bystander())

  const snapshot = await skills.snapshot({ scope: agent })
  assert.equal(snapshot.complete, true)
  assert.deepEqual(snapshot.skills.map(skill => skill.name), ['alpha', 'bystander-skill', 'zeta'])
  assert.deepEqual(modelNames(snapshot.skills), ['alpha', 'bystander-skill', 'zeta'])
  // Six documents, each told once per provider; a second catalog tells nothing new.
  assert.equal(logs.length, 12, logs.join('\n'))
  service.changed()
  await skills.snapshot({ scope: agent })
  assert.equal(logs.length, 12, logs.join('\n'))
  assert.equal(await skills.get('blank', { scope: agent }), undefined)
})

test('a catalog that rejects makes the provider\'s list incomplete, never a throw, and the other providers\' skills survive', async () => {
  const root = await registryRoot()
  const skills = registryOf(root)
  const logs: string[] = []
  const logger = { warn: (format: string, ...args: unknown[]) => { logs.push([format, ...args].join(' ')) } }
  const service = fakeService({ commit: COMMIT_A, skills: [doc('alpha', ['main'])], problems: [] })
  service.serve(new Error('the store fell over'))
  let global: SkillProvider | undefined
  let role: SkillProvider | undefined
  skills.registerProvider((control) => { global = globalProvider(service, logger)(control); return global })
  const presetKey = mintPreset(root)
  const { agent } = mintAgent(root, presetKey, 'main-9')
  agent.ctx.get('skills')!.registerProvider((control) => { role = roleProvider(service, async () => 'main', logger)(control); return role })
  skills.registerProvider(bystander())

  assert.deepEqual(await global!.list({}), { candidates: [], complete: false })
  assert.deepEqual(await role!.list({}), { candidates: [], complete: false })
  const snapshot = await skills.snapshot({ scope: agent })
  assert.equal(snapshot.complete, false)
  assert.deepEqual(snapshot.skills.map(skill => skill.name), ['bystander-skill'])
  assert.ok(logs.some(line => line.includes('the store fell over')), logs.join('\n'))

  service.serve({ commit: COMMIT_A, skills: [doc('alpha', ['main'])], problems: [] })
  const recovered = await skills.snapshot({ scope: agent })
  assert.equal(recovered.complete, true)
  assert.deepEqual(modelNames(recovered.skills), ['alpha', 'bystander-skill'])
})

test('the role provider: the role is asked once, a rejection is not kept, no role lists nothing, and a strange role is no role', async () => {
  const root = await registryRoot()
  const service = fakeService({ commit: COMMIT_A, skills: [doc('alpha', ['main']), doc('beta', null), doc('gamma', ['coder'])], problems: [] })
  const asked: string[] = []
  let answer: () => Promise<string | undefined> = async () => { throw new Error('not yet') }
  let provider: SkillProvider | undefined
  registryOf(root).registerProvider((control) => {
    provider = roleProvider(service, () => { asked.push('role'); return answer() })(control)
    return provider
  })
  assert.equal(ROLE_PROVIDER, 'dish-role')
  assert.equal(ROLE_RANK, 250)

  assert.deepEqual(await provider!.list({}), { candidates: [], complete: false })
  answer = async () => 'coder'
  const [first, second] = await Promise.all([provider!.list({}), provider!.list({})])
  assert.deepEqual(first, second)
  const { candidates } = first as { candidates: readonly SkillCandidate[] }
  assert.deepEqual(candidates.map(candidate => [candidate.name, candidate.provider, candidate.rank, candidate.invocation.modelInvocable]), [
    ['beta', ROLE_PROVIDER, ROLE_RANK, true],
    ['gamma', ROLE_PROVIDER, ROLE_RANK, true],
  ])
  await provider!.list({})
  assert.deepEqual(asked, ['role', 'role'])

  for (const strange of [undefined, '', 3, null]) {
    let strangeProvider: SkillProvider | undefined
    const scope = createScope(root, {})
    scope.ctx.get('skills')!.registerProvider((control) => {
      strangeProvider = roleProvider(service, async () => strange as string | undefined)(control)
      return strangeProvider
    })
    assert.deepEqual(await strangeProvider!.list({}), { candidates: [], complete: true }, String(strange))
  }
})

test('the role provider keeps the skill\'s own invocation flags, and loads only its role\'s skills', async () => {
  const root = await registryRoot()
  const service = fakeService({
    commit: COMMIT_A,
    skills: [doc('hidden', ['main'], {}, 'user-invocable: false\n'), doc('menu-only', null, {}, 'disable-model-invocation: true\n'), doc('other', ['coder'])],
    problems: [],
  })
  let provider: SkillProvider | undefined
  registryOf(root).registerProvider((control) => {
    provider = roleProvider(service, async () => 'main')(control)
    return provider
  })
  const { candidates } = await provider!.list({}) as { candidates: readonly SkillCandidate[] }
  assert.deepEqual(candidates.map(candidate => [candidate.name, candidate.invocation]), [
    ['hidden', { modelInvocable: true, userInvocable: false }],
    ['menu-only', { modelInvocable: false, userInvocable: true }],
  ])
  // A candidate for a skill this role isn't offered (another provider's, or one the role lost since) isn't loaded.
  assert.equal(await provider!.get({ ...candidates[0]!, name: 'other', locator: { commit: COMMIT_A, name: 'other' } }, {}), undefined)
})

test('get: the current document of the locator\'s name, so a newer commit\'s text is loaded and a name that went is gone', async () => {
  const root = await registryRoot()
  const service = fakeService({ commit: COMMIT_A, skills: [doc('alpha', null)], problems: [] })
  let provider: SkillProvider | undefined
  registryOf(root).registerProvider((control) => {
    provider = globalProvider(service)(control)
    return provider
  })
  const { candidates } = await provider!.list({}) as { candidates: readonly SkillCandidate[] }
  const candidate = candidates[0]!
  assert.deepEqual(candidate.locator, { commit: COMMIT_A, name: 'alpha' })
  assert.equal((await provider!.get(candidate, {}))?.content, 'Do the alpha thing.')

  const edited = doc('alpha', null)
  service.serve({ commit: COMMIT_B, skills: [{ ...edited, body: 'Do it the new way.', description: 'Use when it is new.' }], problems: [] })
  const loaded = await provider!.get(candidate, {})
  assert.equal(loaded?.content, 'Do it the new way.')
  assert.equal(loaded?.description, 'Use when it is new.')

  service.serve({ commit: COMMIT_B, skills: [], problems: [] })
  assert.equal(await provider!.get(candidate, {}), undefined)
  // Without the store, the shipped defaults: no commit.
  service.serve({ commit: null, skills: [doc('alpha', null)], problems: [] })
  const shipped = await provider!.get(candidate, {})
  assert.equal(shipped?.source, DEFAULT_SOURCE)
})

test('a provider stops listening for changes when its registration goes, or when it never took', async () => {
  const root = await registryRoot()
  const service = fakeService({ commit: COMMIT_A, skills: [doc('alpha', null)], problems: [] })
  const dispose = registryOf(root).registerProvider(globalProvider(service))
  assert.equal(service.listeners(), 1)
  dispose()
  assert.equal(service.listeners(), 0)
  // A second provider of the same name in the same layer is refused, and leaves no listener behind.
  registryOf(root).registerProvider(globalProvider(service))
  assert.throws(() => registryOf(root).registerProvider(globalProvider(service)), /already registered/)
  assert.equal(service.listeners(), 1)
})
