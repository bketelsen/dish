import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import type { DishConfigService } from 'dish-config'
import * as plugin from '../src/index.ts'
import type { DishCrew } from '../src/index.ts'
import { CREW_SPEC, DEFAULT_SETTINGS, DEFAULT_TEXT, parseSettings } from '../src/settings.ts'
import {
  captureStderr, dirs, mountConfig, mountCrew, seeded, shippedWith, tempDir, waitFor, watchLogs, withEnv,
} from './helpers.ts'
import type { Dirs } from './helpers.ts'

const AGENT = { kind: 'agent', sessionId: 's1', role: 'main' } as const
const USER = { kind: 'user' } as const

/** Mount dish-config and dish-crew on `where` in `ctx`, wait for `crew.yaml`, and return what unmounts them. */
async function start(ctx: Context, where: Dirs): Promise<() => Promise<void>> {
  const config = mountConfig(ctx, where.repository)
  await config
  const crew = mountCrew(ctx, where.data)
  await crew
  await seeded(ctx.dishConfig)
  return async () => {
    await crew.dispose()
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

/** A `dishConfig` that is only a reader, answering `read` as `answer` says. */
function readerOf(answer: () => Promise<string | undefined>): DishConfigService {
  return {
    claim: () => () => {},
    seed: () => Promise.resolve(undefined),
    read: answer,
  } as unknown as DishConfigService
}

/** The logged lines about crew.yaml: what the plugin said, once per distinct problem. */
function crewLines(logs: string[]): string[] {
  return logs.filter(line => line.startsWith('[dish-crew] warn:'))
}

// --- the service ----------------------------------------------------------------------------------

test('dishCrew is provided when the plugin loads, with settings(), and goes when it does', async () => {
  const where = await dirs()
  const ctx = new Context()
  assert.equal(ctx.get('dishCrew'), undefined)
  const handle = mountCrew(ctx, where.data)
  await handle
  const service: DishCrew = ctx.dishCrew
  assert.deepEqual(Object.keys(service), ['settings'])
  await handle.dispose()
  assert.equal(ctx.get('dishCrew'), undefined)
})

// --- with the store -------------------------------------------------------------------------------

test('with the store there, crew.yaml is seeded as the shipped default; a second start rewrites nothing', async () => {
  const where = await dirs()
  const first = await (async () => {
    const ctx = new Context()
    const stop = await start(ctx, where)
    try {
      const store = ctx.dishConfig
      assert.equal(await store.read('crew.yaml'), DEFAULT_TEXT)
      const commits = await store.history({ path: 'crew.yaml' })
      assert.equal(commits.length, 1)
      assert.deepEqual(commits[0]!.author, { kind: 'system' })
      assert.match(commits[0]!.message, /dish-crew defaults/)
      assert.deepEqual(commits[0]!.paths, ['crew.yaml'])
      return { head: await store.head(), commit: commits[0]!.id }
    } finally {
      await stop()
    }
  })()
  await withBoth(where, async (ctx) => {
    const store = ctx.dishConfig
    assert.equal(await store.head(), first.head)
    assert.deepEqual((await store.history({ path: 'crew.yaml' })).map(commit => commit.id), [first.commit])
  })
})

test('settings() is the file in the store, parsed, and a person\'s edit shows at once and survives a restart', async () => {
  const where = await dirs()
  const edited = shippedWith((d) => { d.limits.running = 2; d.roles.coder.tier = 'strong' })
  await withBoth(where, async (ctx) => {
    assert.deepEqual(await ctx.dishCrew.settings(), DEFAULT_SETTINGS)
    assert.ok(await ctx.dishConfig.write([{ path: 'crew.yaml', text: edited }], { author: USER }))
    const settings = await ctx.dishCrew.settings()
    assert.equal(settings.limits.running, 2)
    assert.equal(settings.roles.coder!.tier, 'strong')
    const parsed = parseSettings(edited)
    assert.ok(parsed.ok)
    assert.deepEqual(settings, parsed.settings)
  })
  await withBoth(where, async (ctx) => {
    assert.equal(await ctx.dishConfig.read('crew.yaml'), edited)
    assert.equal((await ctx.dishCrew.settings()).limits.running, 2)
  })
})

test('the policy of the namespace holds through dishConfig: a person\'s broken file is INVALID and changes nothing', async () => {
  await withBoth(await dirs(), async (ctx) => {
    const store = ctx.dishConfig
    const broken = shippedWith((d) => { d.roles.coder.family = 'antropic' })
    await assert.rejects(
      store.write([{ path: 'crew.yaml', text: broken }], { author: USER }),
      { code: 'INVALID', message: /crew\.yaml.*roles\.coder\.family: "antropic" is not a family \(families: anthropic, openai\)/ })
    await assert.rejects(store.write([{ path: 'crew.yaml', text: 'roles: [' }], { author: USER }), { code: 'INVALID' })
    await assert.rejects(store.write([{ path: 'crew.yaml', text: 'provider: !!js/function "function () {}"\n' }], { author: USER }), { code: 'INVALID' })
    // The store puts the path in front of what the namespace says, so what it says doesn't name the file again.
    await assert.rejects(
      store.write([{ path: 'crew.yaml', text: '' }], { author: USER }),
      (error: Error) => /^crew\.yaml: the file is empty; it needs /.test(error.message) && (error as { code?: string }).code === 'INVALID')
    await assert.rejects(
      store.write([{ path: 'crew.yaml', text: 'roles: [' }], { author: USER }),
      (error: Error) => /^crew\.yaml: not valid YAML \(line \d+, column \d+\): /.test(error.message))
    assert.equal(await store.read('crew.yaml'), DEFAULT_TEXT)
    assert.equal((await store.history({ path: 'crew.yaml' })).length, 1)
  })
})

test('an agent may write a valid crew.yaml directly, and not a broken one', async () => {
  await withBoth(await dirs(), async (ctx) => {
    const store = ctx.dishConfig
    const valid = shippedWith((d) => { d.limits.perSession = 12 })
    const commit = await store.write([{ path: 'crew.yaml', text: valid }], { author: AGENT, note: 'fewer delegations' })
    assert.ok(commit)
    assert.deepEqual(commit.author, { kind: 'agent', sessionId: 's1', role: 'main' })
    assert.equal(await store.read('crew.yaml'), valid)
    assert.equal((await ctx.dishCrew.settings()).limits.perSession, 12)
    await assert.rejects(
      store.write([{ path: 'crew.yaml', text: shippedWith((d) => { d.limits.writers = 9 }) }], { author: AGENT }),
      { code: 'INVALID', message: /limits\.writers: 9 is more than limits\.running \(4\)/ })
    assert.equal(await store.read('crew.yaml'), valid)
  })
})

test('the claim goes with the plugin: crew.yaml is unowned once dish-crew unloads', async () => {
  const where = await dirs()
  const ctx = new Context()
  const config = mountConfig(ctx, where.repository)
  await config
  const crew = mountCrew(ctx, where.data)
  await crew
  await seeded(ctx.dishConfig)
  await crew.dispose()
  try {
    await assert.rejects(ctx.dishConfig.write([{ path: 'crew.yaml', text: DEFAULT_TEXT }], { author: USER }), { code: 'UNOWNED' })
  } finally {
    await config.dispose()
  }
})

// --- without the store, or with a bad file --------------------------------------------------------

test('with no store, settings() is the shipped default, and the absence is logged once', async () => {
  const ctx = new Context()
  const logs = watchLogs(ctx)
  const handle = mountCrew(ctx, (await dirs()).data)
  try {
    await handle
    for (let call = 0; call < 4; call++) assert.equal(await ctx.dishCrew.settings(), DEFAULT_SETTINGS)
    const lines = crewLines(logs)
    assert.equal(lines.length, 1, logs.join('\n'))
    assert.match(lines[0]!, /dish-config is not running; using the shipped crew\.yaml/)
  } finally {
    await handle.dispose()
  }
})

test('the store comes and goes: the file while it is there, the default when it is not', async () => {
  const where = await dirs()
  const ctx = new Context()
  const handle = mountCrew(ctx, where.data)
  try {
    await handle
    assert.equal(await ctx.dishCrew.settings(), DEFAULT_SETTINGS)
    const config = mountConfig(ctx, where.repository)
    await config
    await seeded(ctx.dishConfig)
    await ctx.dishConfig.write([{ path: 'crew.yaml', text: shippedWith((d) => { d.limits.running = 3 }) }], { author: USER })
    assert.equal((await ctx.dishCrew.settings()).limits.running, 3)
    await config.dispose()
    assert.equal(ctx.get('dishConfig'), undefined)
    assert.equal(await ctx.dishCrew.settings(), DEFAULT_SETTINGS)
  } finally {
    await handle.dispose()
  }
})

test('a store that has no crew.yaml gives the default, with one warning', async () => {
  const ctx = new Context()
  const logs = watchLogs(ctx)
  ctx.provide('dishConfig', readerOf(() => Promise.resolve(undefined)))
  const handle = mountCrew(ctx, (await dirs()).data)
  try {
    await handle
    for (let call = 0; call < 3; call++) assert.equal(await ctx.dishCrew.settings(), DEFAULT_SETTINGS)
    const lines = crewLines(logs)
    assert.equal(lines.length, 1, logs.join('\n'))
    assert.match(lines[0]!, /crew\.yaml is not in the config store; using the shipped default/)
  } finally {
    await handle.dispose()
  }
})

test('a store that can not be read gives the default, once per distinct error, and never throws', async () => {
  const ctx = new Context()
  const logs = watchLogs(ctx)
  let failure: unknown = new Error('git is broken')
  ctx.provide('dishConfig', readerOf(() => Promise.reject(failure)))
  const handle = mountCrew(ctx, (await dirs()).data)
  try {
    await handle
    for (let call = 0; call < 3; call++) assert.equal(await ctx.dishCrew.settings(), DEFAULT_SETTINGS)
    assert.equal(crewLines(logs).length, 1, logs.join('\n'))
    assert.match(crewLines(logs)[0]!, /could not read crew\.yaml from the config store \(git is broken\); using the shipped default/)
    // Another problem is another message.
    failure = new Error('the disk is full')
    for (let call = 0; call < 3; call++) assert.equal(await ctx.dishCrew.settings(), DEFAULT_SETTINGS)
    assert.equal(crewLines(logs).length, 2, logs.join('\n'))
    assert.match(crewLines(logs)[1]!, /the disk is full/)
    // A rejection that isn't an Error is handled too.
    failure = 'plain string'
    assert.equal(await ctx.dishCrew.settings(), DEFAULT_SETTINGS)
    assert.match(crewLines(logs)[2]!, /plain string/)
  } finally {
    await handle.dispose()
  }
})

test('a crew.yaml in the store that is not valid gives the default, with the problem named once and none of the file', async () => {
  const ctx = new Context()
  const logs = watchLogs(ctx)
  let text = shippedWith((d) => { d.roles.coder.family = 'antropic'; d.provider = 'a-secret-looking-token-value' })
  ctx.provide('dishConfig', readerOf(() => Promise.resolve(text)))
  const handle = mountCrew(ctx, (await dirs()).data)
  try {
    await handle
    for (let call = 0; call < 3; call++) assert.equal(await ctx.dishCrew.settings(), DEFAULT_SETTINGS)
    const lines = crewLines(logs)
    assert.equal(lines.length, 1, logs.join('\n'))
    assert.match(lines[0]!, /crew\.yaml in the config store is not valid, so the shipped default is used: roles\.coder\.family: "antropic" is not a family \(families: anthropic, openai\)/)
    assert.ok(!lines[0]!.includes('a-secret-looking-token-value'), lines[0])
    // A different problem is reported too, and a good file is used.
    text = 'roles: ['
    assert.equal(await ctx.dishCrew.settings(), DEFAULT_SETTINGS)
    assert.equal(crewLines(logs).length, 2, logs.join('\n'))
    text = shippedWith((d) => { d.limits.running = 3 })
    assert.equal((await ctx.dishCrew.settings()).limits.running, 3)
    assert.equal(crewLines(logs).length, 2, logs.join('\n'))
  } finally {
    await handle.dispose()
  }
})

test('settings() does not throw because the logger does', async () => {
  const ctx = new Context()
  ctx.logger.exporter({ levels: { default: 3 }, export: () => { throw new Error('the exporter broke') } })
  const handle = mountCrew(ctx, (await dirs()).data)
  try {
    await handle
    assert.equal(await ctx.dishCrew.settings(), DEFAULT_SETTINGS)
    ctx.provide('dishConfig', readerOf(() => Promise.reject(new Error('git is broken'))))
    assert.equal(await ctx.dishCrew.settings(), DEFAULT_SETTINGS)
  } finally {
    await handle.dispose()
  }
})

test('a claim on crew.yaml by someone else is logged, and the plugin carries on with the default', async () => {
  const where = await dirs()
  const ctx = new Context()
  const logs = watchLogs(ctx)
  const config = mountConfig(ctx, where.repository)
  await config
  ctx.dishConfig.claim({ prefix: 'crew.yaml', owner: 'someone-else', agent: 'none', validate: () => undefined })
  const crew = mountCrew(ctx, where.data)
  try {
    await crew
    await waitFor('the claim to be refused', () => crewLines(logs).length > 0 || undefined)
    assert.match(crewLines(logs)[0]!, /could not claim crew\.yaml: .*someone-else/)
    assert.equal(await ctx.dishConfig.read('crew.yaml'), undefined)
    assert.equal(await ctx.dishCrew.settings(), DEFAULT_SETTINGS)
  } finally {
    await crew.dispose()
    await config.dispose()
  }
})

test('a seed that fails is logged, and settings() is the default', async () => {
  const where = await dirs()
  const ctx = new Context()
  const logs = watchLogs(ctx)
  // A store that takes no document as large as crew.yaml.
  const config = mountConfig(ctx, where.repository, { maxBytes: 200 })
  await config
  const crew = mountCrew(ctx, where.data)
  try {
    await crew
    await waitFor('the seed to fail', () => crewLines(logs).some(line => /could not seed crew\.yaml/.test(line)) || undefined)
    assert.equal(await ctx.dishConfig.read('crew.yaml'), undefined)
    assert.equal(await ctx.dishCrew.settings(), DEFAULT_SETTINGS)
  } finally {
    await crew.dispose()
    await config.dispose()
  }
})

test('CREW_SPEC is what is claimed: the store applies this validate', async () => {
  await withBoth(await dirs(), async (ctx) => {
    const text = shippedWith((d) => { d.limits.perSession = 31 })
    assert.equal(CREW_SPEC.validate('crew.yaml', text), undefined)
    assert.ok(await ctx.dishConfig.write([{ path: 'crew.yaml', text }], { author: USER }))
  })
})

// --- configuration --------------------------------------------------------------------------------

test('dataDirectory defaults to the XDG data directory for dish, and takes ~/ and absolute paths', async () => {
  const root = await tempDir()
  await withEnv({ XDG_DATA_HOME: join(root, 'xdg') }, async () => {
    assert.equal(plugin.dataDirectoryPath(undefined), join(root, 'xdg', 'dish', 'crew'))
  })
  assert.equal(plugin.dataDirectoryPath('~'), homedir())
  assert.equal(plugin.dataDirectoryPath('~/crew-data'), join(homedir(), 'crew-data'))
  assert.equal(plugin.dataDirectoryPath(join(root, 'abs')), join(root, 'abs'))
  assert.throws(() => plugin.dataDirectoryPath('relative/dir'), /dataDirectory must be an absolute path \(or start with ~\/\)/)
  assert.throws(() => plugin.dataDirectoryPath('~other/dir'), /dataDirectory must be an absolute path/)
})

test('a blank dataDirectory is the default, and a relative one fails the plugin to load, with nothing provided', async () => {
  const root = await tempDir()
  await withEnv({ XDG_DATA_HOME: join(root, 'xdg') }, async () => {
    for (const setting of [undefined, '', '   ']) {
      const ctx = new Context()
      const handle = ctx.plugin(plugin, { terminal: false, ...setting === undefined ? {} : { dataDirectory: setting } } as plugin.Config)
      await handle
      assert.ok(ctx.get('dishCrew'), JSON.stringify(setting))
      await handle.dispose()
    }
  })
  const ctx = new Context()
  const handle = ctx.plugin(plugin, { terminal: false, dataDirectory: 'relative/dir' } as plugin.Config)
  await assert.rejects(async () => { await handle }, /dataDirectory must be an absolute path/)
  assert.equal(ctx.get('dishCrew'), undefined)
})

test('the configuration has dataDirectory, subagentProvider (spawn) and terminal, and nothing of the spike', () => {
  const config = plugin.Config({} as plugin.Config)
  assert.deepEqual({ ...config }, { dataDirectory: '', subagentProvider: 'spawn', terminal: true })
  assert.equal(plugin.name, 'dish-crew')
})

test('terminal prints this plugin\'s warnings to stderr, and terminal: false does not', async () => {
  const where = await dirs()
  const run = async (terminal: boolean) => {
    const out = captureStderr()
    try {
      const ctx = new Context()
      const handle = mountCrew(ctx, where.data, { terminal })
      await handle
      await ctx.dishCrew.settings()
      await handle.dispose()
    } finally {
      out.restore()
    }
    return out.lines()
  }
  const printed = await run(true)
  assert.ok(printed.some(line => /^\[dish-crew\] warn: .*shipped crew\.yaml/.test(line)), printed.join('\n'))
  assert.deepEqual(await run(false), [])
})
