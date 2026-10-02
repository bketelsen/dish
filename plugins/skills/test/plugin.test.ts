import { createHash } from 'node:crypto'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { format } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../src/index.ts'
import type { DishSkills } from '../src/index.ts'
import { DEFAULTS } from '../src/defaults.ts'
import { namespaceSpec, pathFor } from '../src/skill.ts'
import {
  DEFAULTS_BY_PATH, captureStderr, dirs, mountConfig, mountSkills, provideStub, seeded, skillText, userWrite, waitFor, watchLogs,
} from './helpers.ts'
import type { Dirs } from './helpers.ts'

const AGENT = { kind: 'agent', sessionId: 's1', role: 'coder' } as const
const USER = { kind: 'user' } as const
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

/** Mount dish-config and dish-skills on `where` in `ctx`, wait for the defaults, and return what unmounts them. */
async function start(ctx: Context, where: Dirs): Promise<() => Promise<void>> {
  const config = mountConfig(ctx, where.repository)
  await config
  const skills = mountSkills(ctx)
  await skills
  await seeded(ctx.dishConfig)
  return async () => {
    await skills.dispose()
    await config.dispose()
  }
}

/** Run `body` with both plugins mounted in a fresh `Context`, and unmount them however `body` ends. */
async function withBoth(where: Dirs, body: (ctx: Context) => Promise<void>): Promise<void> {
  const ctx = new Context()
  const stop = await start(ctx, where)
  try {
    await body(ctx)
  } finally {
    await stop()
  }
}

/** A plugin that does what dish-skills does with the store, with `replace` of its own: a run of it is a start of the plugin. */
function linking(replace: Record<string, readonly string[]>, changed: () => void = () => {}, warnings: string[] = []) {
  return {
    name: 'test-linker',
    apply(ctx: Context) {
      plugin.linkStore(ctx, { replace, changed, logger: { warn: (...args: [string, ...unknown[]]) => { warnings.push(format(...args)) } } })
    },
  }
}

/** Start the store half with `replace`, and wait until it has tried the seed (it tells `changed()` then). */
async function relink(ctx: Context, replace: Record<string, readonly string[]>) {
  let tried = false
  const handle = ctx.plugin(linking(replace, () => { tried = true }))
  await handle
  await waitFor('the seed to be tried', () => tried)
  return handle
}

// --- the service ------------------------------------------------------------------------------------

test('dishSkills is provided at once, is the documented service, and goes with the plugin', async () => {
  const ctx = new Context()
  const handle = mountSkills(ctx)
  assert.equal(ctx.get('dishSkills'), undefined)
  await handle
  const service: DishSkills = ctx.dishSkills
  assert.deepEqual(Object.keys(service).sort(), ['catalog', 'changed', 'defaultText', 'forRole', 'knownRoles', 'onChange', 'shipped'])
  await handle.dispose()
  assert.equal(ctx.get('dishSkills'), undefined)
})

test('the config defaults: the dish preset is main, and the plugin prints to the terminal', () => {
  // The schema takes whatever a config file holds.
  const parse = plugin.Config as unknown as (value: unknown) => unknown
  assert.deepEqual(parse({}), { presets: { dish: 'main' }, terminal: true })
  assert.deepEqual(parse({ presets: { dish: 'main', work: 'coder' }, terminal: false }), { presets: { dish: 'main', work: 'coder' }, terminal: false })
  assert.equal(plugin.name, 'dish-skills')
  // A preset's role is a role name.
  for (const role of ['Main', 'two words', '', '9lives', 3, null]) {
    assert.throws(() => parse({ presets: { dish: role } }), String(role))
  }
  assert.throws(() => parse({ terminal: 'yes' }))
})

test('without the store the catalog is the shipped defaults, and nothing is logged', async () => {
  const ctx = new Context()
  const logs = watchLogs(ctx)
  const handle = mountSkills(ctx)
  await handle
  const catalog = await ctx.dishSkills.catalog()
  assert.equal(catalog.commit, null)
  assert.deepEqual(catalog.skills.map(skill => skill.name), Object.keys(DEFAULTS).sort())
  assert.deepEqual(catalog.problems, [])
  assert.deepEqual(logs, [])
  await handle.dispose()
})

test('the store appearing and going away tells the listeners, and the catalog follows', async () => {
  const where = await dirs()
  const ctx = new Context()
  const skills = mountSkills(ctx)
  await skills
  let told = 0
  ctx.dishSkills.onChange(() => { told++ })
  assert.equal((await ctx.dishSkills.catalog()).commit, null)

  const config = mountConfig(ctx, where.repository)
  await config
  await seeded(ctx.dishConfig)
  await waitFor('the listeners to be told the store came', () => told > 0)
  const withStore = await ctx.dishSkills.catalog()
  assert.equal(withStore.commit, await ctx.dishConfig.head())
  assert.equal(withStore.skills.length, 18)
  // The seed is a change under skills/ itself, and the store appearing is another: two in all, on a fresh store.
  await waitFor('the seed and the store appearing to be told', () => told >= 2)

  const before = told
  await config.dispose()
  await waitFor('the listeners to be told the store went', () => told > before)
  assert.equal(ctx.get('dishConfig'), undefined)
  const without = await ctx.dishSkills.catalog()
  assert.equal(without.commit, null)
  assert.equal(without.skills.length, 18)
  await skills.dispose()
})

// --- the store ----------------------------------------------------------------------------------------

test('with the store there, all eighteen skills are seeded in one system commit; a second start rewrites nothing', async () => {
  const where = await dirs()
  const first = await (async () => {
    const ctx = new Context()
    const stop = await start(ctx, where)
    try {
      const store = ctx.dishConfig
      assert.equal(Object.keys(DEFAULTS_BY_PATH).length, 18)
      for (const [path, text] of Object.entries(DEFAULTS_BY_PATH)) assert.equal(await store.read(path), text, path)
      const commits = await store.history({ prefix: 'skills/' })
      assert.equal(commits.length, 1)
      assert.deepEqual(commits[0]!.author, { kind: 'system' })
      assert.match(commits[0]!.message, /dish-skills defaults/)
      assert.doesNotMatch(commits[0]!.message, /updated to the new defaults/)
      assert.deepEqual(commits[0]!.paths, Object.keys(DEFAULTS_BY_PATH).sort())
      // NOTICE.md and previous.json are not seeded.
      assert.deepEqual((await store.list('skills/')).sort(), Object.keys(DEFAULTS_BY_PATH).sort())
      const catalog = await ctx.dishSkills.catalog()
      assert.equal(catalog.commit, await store.head())
      assert.deepEqual(catalog.skills.map(skill => skill.text), Object.keys(DEFAULTS).sort().map(name => DEFAULTS[name]))
      return { head: await store.head(), commit: commits[0]!.id }
    } finally {
      await stop()
    }
  })()
  await withBoth(where, async (ctx) => {
    const store = ctx.dishConfig
    assert.equal(await store.head(), first.head)
    assert.deepEqual((await store.history({ prefix: 'skills/' })).map(commit => commit.id), [first.commit])
  })
})

test('a person\'s edit survives a restart: the defaults are only seeded where nothing exists', async () => {
  const where = await dirs()
  const edited = skillText('brainstorming', ['main'], 'My own way of brainstorming.')
  await withBoth(where, async (ctx) => {
    await userWrite(ctx.dishConfig, 'brainstorming', edited)
    assert.equal((await ctx.dishSkills.catalog()).skills.find(skill => skill.name === 'brainstorming')!.body, 'My own way of brainstorming.')
    // A skill of their own.
    await userWrite(ctx.dishConfig, 'mine', skillText('mine'))
  })
  await withBoth(where, async (ctx) => {
    assert.equal(await ctx.dishConfig.read(pathFor('brainstorming')), edited)
    assert.equal(await ctx.dishConfig.read(pathFor('researching')), DEFAULTS.researching)
    const { skills } = await ctx.dishSkills.catalog()
    assert.equal(skills.length, 19)
    assert.ok(skills.some(skill => skill.name === 'mine'))
  })
})

test('a shipped skill that was deleted is seeded back at the next start', async () => {
  const where = await dirs()
  await withBoth(where, async (ctx) => {
    await ctx.dishConfig.write([{ path: pathFor('researching'), delete: true }], { author: USER })
    assert.equal(await ctx.dishConfig.read(pathFor('researching')), undefined)
  })
  await withBoth(where, async (ctx) => {
    assert.equal(await ctx.dishConfig.read(pathFor('researching')), DEFAULTS.researching)
  })
})

test('the namespace: a person writes valid skills, an agent can only propose, and nothing else is a skill', async () => {
  await withBoth(await dirs(), async (ctx) => {
    const store = ctx.dishConfig
    const fresh = skillText('fresh', ['coder'])
    const path = pathFor('fresh')

    // An agent can't write a new skill or change an existing one...
    await assert.rejects(store.write([{ path, text: fresh }], { author: AGENT }), { code: 'FORBIDDEN' })
    await assert.rejects(store.write([{ path: pathFor('researching'), text: skillText('researching') }], { author: AGENT }), { code: 'FORBIDDEN' })
    assert.equal(await store.read(path), undefined)
    assert.equal(await store.read(pathFor('researching')), DEFAULTS.researching)
    // ...but can propose one, which waits for a person.
    const proposal = await store.propose([{ path, text: fresh }], { author: AGENT, title: 'A fresh skill', rationale: 'the crew needs it' })
    assert.ok(proposal.id)
    assert.equal(await store.read(path), undefined)
    await store.accept(proposal.id, { author: USER })
    assert.equal(await store.read(path), fresh)
    assert.deepEqual((await ctx.dishSkills.forRole('coder')).map(skill => skill.name).includes('fresh'), true)

    // A person writes what is valid...
    assert.ok(await userWrite(store, 'fresh', skillText('fresh', ['writer'])))
    // ...and what is not, is refused, by the agent's proposal too.
    await assert.rejects(userWrite(store, 'fresh', 'no frontmatter'), { code: 'INVALID', message: /frontmatter is missing/ })
    await assert.rejects(userWrite(store, 'fresh', skillText('other')), { code: 'INVALID', message: /name is "other" but the folder is "fresh"/ })
    await assert.rejects(store.write([{ path: 'skills/fresh/notes.md', text: 'x' }], { author: USER }), { code: 'INVALID' })
    await assert.rejects(store.write([{ path: 'skills/Upper/SKILL.md', text: 'x' }], { author: USER }), { code: 'INVALID' })
    await assert.rejects(store.propose([{ path, text: 'broken' }], { author: AGENT, title: 'Broken', rationale: 'x' }), { code: 'INVALID' })
    // It is the only namespace this plugin claims.
    await assert.rejects(store.write([{ path: 'other/a.md', text: 'x' }], { author: USER }), { code: 'UNOWNED' })
  })
})

test('a skill with a very long list in its metadata is saved, proposed and served like any other', async () => {
  await withBoth(await dirs(), async (ctx) => {
    const store = ctx.dishConfig
    // 130000 entries fit the store's size limit, and used to overflow the stack in the validator.
    const long = (name: string): string => `---\nname: ${name}\ndescription: Use when testing.\nmetadata:\n  other: [${'a,'.repeat(130_000)}a]\n---\nBody.\n`
    assert.ok(long('long-one').length < 262_144)
    assert.ok(await userWrite(store, 'long-one', long('long-one')))
    const proposal = await store.propose([{ path: pathFor('long-two'), text: long('long-two') }], { author: AGENT, title: 'A long one', rationale: 'a test' })
    await store.accept(proposal.id, { author: USER })
    // Refused as a document is, not thrown: a bad name in the same shape.
    await assert.rejects(userWrite(store, 'long-one', long('long-other')), { code: 'INVALID', message: /name is "long-other" but the folder is "long-one"/ })

    const catalog = await ctx.dishSkills.catalog()
    assert.equal(catalog.commit, await store.head())
    assert.deepEqual(catalog.skills.map(skill => skill.name).filter(name => name.startsWith('long-')), ['long-one', 'long-two'])
    assert.equal(catalog.skills.length, 20)
    assert.deepEqual(catalog.problems, [])
  })
})

test('the namespace is claimed as dish-skills\'s, and released with the store', async () => {
  const where = await dirs()
  const ctx = new Context()
  const config = mountConfig(ctx, where.repository)
  await config
  // Nobody else can claim skills/ while the plugin has it.
  const skills = mountSkills(ctx)
  await skills
  assert.throws(() => ctx.dishConfig.claim(namespaceSpec('someone-else')), /skills/)
  await skills.dispose()
  const release = ctx.dishConfig.claim(namespaceSpec('someone-else'))
  release()
  await config.dispose()
})

test('a claim on skills/ that someone else holds is logged, and the plugin carries on without seeding', async () => {
  const where = await dirs()
  const ctx = new Context()
  const logs = watchLogs(ctx)
  const config = mountConfig(ctx, where.repository)
  await config
  const release = ctx.dishConfig.claim(namespaceSpec('first-comer'))
  const skills = mountSkills(ctx)
  await skills
  await waitFor('the refusal to be logged', () => logs.some(line => /^\[dish-skills\] warn: could not claim/.test(line)))
  assert.match(logs.join('\n'), /\[dish-skills\] warn: could not claim skills\//)
  assert.deepEqual(await ctx.dishConfig.list('skills/'), [])
  assert.ok(ctx.dishSkills)
  release()
  await skills.dispose()
  await config.dispose()
})

test('a seed that fails is logged, and the plugin carries on', async () => {
  const where = await dirs()
  const ctx = new Context()
  const logs = watchLogs(ctx)
  // Smaller than any shipped skill.
  const config = mountConfig(ctx, where.repository, { maxBytes: 200 })
  await config
  const skills = mountSkills(ctx)
  await skills
  await waitFor('the failure to be logged', () => logs.some(line => /^\[dish-skills\] warn: could not seed/.test(line)))
  assert.match(logs.join('\n'), /\[dish-skills\] warn: could not seed the default skills: /)
  assert.deepEqual(await ctx.dishConfig.list('skills/'), [])
  // The store is there and has no skills: the catalog is the shipped one until it has.
  const catalog = await ctx.dishSkills.catalog()
  assert.equal(catalog.commit, null)
  assert.deepEqual(catalog.skills.map(skill => skill.name), Object.keys(DEFAULTS).sort())
  await skills.dispose()
  await config.dispose()
})

test('terminal prints this plugin\'s warnings to stderr, and terminal: false does not', async () => {
  const seedFailure = /^\[dish-skills\] warn: could not seed/
  const run = async (terminal: boolean) => {
    const where = await dirs()
    const out = captureStderr()
    try {
      const ctx = new Context()
      const logs = watchLogs(ctx)
      const config = mountConfig(ctx, where.repository, { maxBytes: 200 })
      await config
      const skills = mountSkills(ctx, { terminal })
      await skills
      // Whatever the setting, the warning is logged; whether it is printed is what is asked.
      await waitFor('the seed to fail', () => logs.some(line => seedFailure.test(line)))
      if (terminal) await waitFor('the warning to be printed', () => out.lines().some(line => seedFailure.test(line)))
      await skills.dispose()
      await config.dispose()
    } finally {
      out.restore()
    }
    return out.lines()
  }
  const printed = await run(true)
  assert.ok(printed.some(line => seedFailure.test(line)), printed.join('\n'))
  assert.deepEqual(await run(false), [])
})

// --- upgrading what was seeded -------------------------------------------------------------------------

test('seeding with replace: a stored default that still matches an earlier text moves to the new one, and an edited one stays', async () => {
  const where = await dirs()
  const ctx = new Context()
  const config = mountConfig(ctx, where.repository)
  await config
  const store = ctx.dishConfig
  const brainstorming = pathFor('brainstorming')
  const researching = pathFor('researching')
  const writing = pathFor('writing-for-readers')
  const earlier = skillText('brainstorming', ['main'], 'An earlier shipped brainstorming.')
  const earlierResearching = skillText('researching', ['researcher'], 'An earlier shipped researching.')
  const ours = skillText('writing-for-readers', ['writer'], 'A person\'s own text, after an earlier shipped one.')

  // The first start, with no earlier texts to replace; then the store holds what an older version of dish seeded...
  const first = await relink(ctx, {})
  await seeded(store)
  await store.write([
    { path: brainstorming, text: earlier },
    { path: researching, text: earlierResearching },
    { path: writing, text: ours },
  ], { author: USER })
  await first.dispose()

  // ...and the next start knows those texts as earlier shipped ones. Only the first two are listed with the text they
  // have now; the third is listed with some other earlier text, so what is stored there is the person's.
  const next = await relink(ctx, {
    [brainstorming]: [sha256('some other text'), sha256(earlier)],
    [researching]: [sha256(earlierResearching)],
    [writing]: [sha256('an earlier shipped text nobody kept')],
  })
  assert.equal(await store.read(brainstorming), DEFAULTS.brainstorming)
  assert.equal(await store.read(researching), DEFAULTS.researching)
  assert.equal(await store.read(writing), ours)
  const [commit] = await store.history({ prefix: 'skills/' })
  assert.deepEqual(commit!.author, { kind: 'system' })
  assert.match(commit!.message, /updated to the new defaults/)
  assert.deepEqual(commit!.paths, [brainstorming, researching].sort())

  // A person's edit after that is theirs again: the same list replaces nothing.
  const edited = skillText('brainstorming', ['main'], 'Edited after the upgrade.')
  await store.write([{ path: brainstorming, text: edited }], { author: USER })
  await next.dispose()
  const after = await relink(ctx, { [brainstorming]: [sha256(earlier)] })
  assert.equal(await store.read(brainstorming), edited)
  await after.dispose()
  await config.dispose()
})

test('linkStore tells changed() when the store appears (after the seed) and when it goes, and logs a refused seed', async () => {
  const where = await dirs()
  const ctx = new Context()
  const events: string[] = []
  const warnings: string[] = []
  const linked = ctx.plugin(linking({ 'skills/not-shipped/SKILL.md': [sha256('x')] }, () => { events.push('changed') }, warnings))
  await linked
  assert.deepEqual(events, [])

  const config = mountConfig(ctx, where.repository)
  await config
  // seed rejects a replace for a path that isn't in the defaults, so nothing is seeded and the refusal is logged.
  await waitFor('the refusal to be logged', () => warnings.length > 0)
  assert.match(warnings[0]!, /could not seed the default skills: .*not-shipped/)
  assert.deepEqual(await ctx.dishConfig.list('skills/'), [])
  assert.deepEqual(events, ['changed'])
  await config.dispose()
  await waitFor('the store going away to be told', () => events.length > 1)
  assert.deepEqual(events, ['changed', 'changed'])
  await linked.dispose()
})

// --- changes ---------------------------------------------------------------------------------------------

test('a change under skills/ tells the listeners once, and a change anywhere else tells them nothing', async () => {
  const where = await dirs()
  const ctx = new Context()
  const config = mountConfig(ctx, where.repository)
  await config
  const skills = mountSkills(ctx)
  await skills
  // Listening from the start, to know when what the start has to say has been said: the seed is a change under
  // skills/, and the store being there is another. (The seed takes git processes, so this is before either.)
  let told = 0
  ctx.dishSkills.onChange(() => { told++ })
  const store = ctx.dishConfig
  const release = store.claim({ prefix: 'other/', owner: 'test', agent: 'write', validate: () => undefined })
  try {
    await waitFor('the start to be told', () => told >= 2)
    const base = told
    // Registered after the plugin's own listener, so it hears each event once the plugin has: what the plugin did
    // about it is what `told` is by then.
    const seen: { paths: string[], told: number }[] = []
    ctx.on('dish-config/changed', (paths) => { seen.push({ paths, told: told - base }) })

    await userWrite(store, 'first', skillText('first'))
    await store.write([{ path: 'other/a.md', text: 'elsewhere' }], { author: USER })
    await userWrite(store, 'second', skillText('second'))
    await store.write([{ path: 'other/a.md', text: 'elsewhere again' }, { path: pathFor('first'), text: skillText('first', ['main']) }], { author: USER })
    await waitFor('the four changes to be heard', () => seen.length === 4)

    assert.deepEqual(seen.map(event => event.paths), [
      ['skills/first/SKILL.md'], ['other/a.md'], ['skills/second/SKILL.md'], ['other/a.md', 'skills/first/SKILL.md'],
    ])
    assert.deepEqual(seen.map(event => event.told), [1, 1, 2, 3])
  } finally {
    release()
    await skills.dispose()
    await config.dispose()
  }
})

test('an edit shows in the catalog at once', async () => {
  await withBoth(await dirs(), async (ctx) => {
    const edited = skillText('researching', ['researcher'], 'Cite everything, twice.')
    const before = await ctx.dishSkills.catalog()
    await userWrite(ctx.dishConfig, 'researching', edited)
    const after = await ctx.dishSkills.catalog()
    assert.notEqual(after.commit, before.commit)
    assert.equal(after.skills.find(skill => skill.name === 'researching')!.text, edited)
    assert.equal(after.skills.length, 18)
  })
})

// --- crew ----------------------------------------------------------------------------------------------------

test('the known roles are the crew\'s when dishCrew is there (looked up by name, from a sibling), and the shipped ones when it is not', async () => {
  const ctx = new Context()
  const skills = mountSkills(ctx)
  await skills
  const shipped = ['main', 'architect', 'coder', 'ops', 'researcher', 'reviewer', 'writer']
  assert.deepEqual(await ctx.dishSkills.knownRoles(), shipped)

  const crew = await provideStub(ctx, 'dishCrew', { settings: async () => ({ roles: { scribe: {}, coder: {} } }) })
  assert.deepEqual(await ctx.dishSkills.knownRoles(), ['main', 'coder', 'scribe'])
  await crew.dispose()
  assert.deepEqual(await ctx.dishSkills.knownRoles(), shipped)
  await skills.dispose()
})
