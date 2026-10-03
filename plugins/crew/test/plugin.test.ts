import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubagentRunEndInfo, SubagentRunInfo } from '@deepseek-ai/dsh-subagent'
import type { DishConfigService } from 'dish-config'
import { computePrevious, xdgPaths } from 'dish-kit'
import * as plugin from '../src/index.ts'
import type { CoderReport, CrewSettled, DishCrew } from '../src/index.ts'
import { CrewRecords } from '../src/record.ts'
import type { NewChild, RunEnd } from '../src/record.ts'
import { CODER_PARAMETERS, REVIEWER_PARAMETERS, reportSteerText } from '../src/report.ts'
import { CREW_SPEC, DEFAULT_SETTINGS, DEFAULT_TEXT, PREVIOUS_HASHES, parseSettings } from '../src/settings.ts'
import {
  agentScopes, captureStderr, dirs, mountConfig, mountCrew, provideStub, seeded, shippedWith, tempDir, waitFor, watchLogs, withEnv,
} from './helpers.ts'
import type { AgentScopes, Dirs, ScopedAgent } from './helpers.ts'

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
  assert.deepEqual(Object.keys(service), ['settings', 'records', 'whenRecorded', 'subagentProvider', 'worktreeBindings', 'reportSteered'])
  await handle.dispose()
  assert.equal(ctx.get('dishCrew'), undefined)
})

test('dishCrew gives the subagent provider setting to the preset row, which can\'t see the host\'s config: spawn by default', async () => {
  const where = await dirs()
  const ctx = new Context()
  const handle = mountCrew(ctx, where.data)
  await handle
  assert.equal(ctx.dishCrew.subagentProvider, 'spawn')
  await handle.dispose()
  const other = new Context()
  const again = mountCrew(other, where.data, { subagentProvider: ' fork ' })
  await again
  assert.equal(other.dishCrew.subagentProvider, 'fork')
  await again.dispose()
  const blank = new Context()
  const last = mountCrew(blank, where.data, { subagentProvider: '  ' })
  await last
  assert.equal(blank.dishCrew.subagentProvider, 'spawn')
  await last.dispose()
})

// --- worktree bindings ----------------------------------------------------------------------------

const TREE = '/work/frostyard/snosi/.worktrees/fix-1'

test('worktreeBindings names the children bound to a worktree, across sessions, and says which run by dsh\'s agent registry', async () => {
  const where = await dirs()
  const ctx = new Context()
  const live = new Map<string, { status: 'running' | 'idle' }>()
  // From a sibling plugin, as dsh provides it: the host reads it with ctx.get on each call.
  const registry = await provideStub(ctx, 'agents', { get: (id: string) => live.get(id) })
  const handle = mountCrew(ctx, where.data)
  await handle
  try {
    const { records } = ctx.dishCrew
    await records.addChild('s1', crewChild('stepping', { worktree: TREE, startedAt: 1 }))
    live.set('stepping', { status: 'running' })
    await records.addChild('s1', crewChild('done', { worktree: TREE, startedAt: 2, title: 'fix the bug' }))
    await records.endRun('done', { stopReason: 'completed', closing: 'fixed' })
    live.set('done', { status: 'idle' })
    // The record says running, and no agent is there: a crash's record, not running.
    await records.addChild('s2', crewChild('crashed', { worktree: TREE, startedAt: 3, role: 'ops' }))
    await records.addChild('s2', crewChild('elsewhere', { worktree: `${TREE}-other`, startedAt: 4 }))
    await records.addChild('s2', crewChild('unbound', { startedAt: 5 }))
    live.set('elsewhere', { status: 'running' })
    assert.deepEqual(await ctx.dishCrew.worktreeBindings(TREE), [
      { child: 'stepping', sessionId: 's1', role: 'coder', title: 'add login', running: true },
      { child: 'done', sessionId: 's1', role: 'coder', title: 'fix the bug', running: false },
      { child: 'crashed', sessionId: 's2', role: 'ops', title: 'add login', running: false },
    ])
    // Accepted and not stepping yet: the record says running and the agent is there.
    live.set('crashed', { status: 'idle' })
    // A finished child that is woken again is running.
    live.set('done', { status: 'running' })
    assert.deepEqual((await ctx.dishCrew.worktreeBindings(TREE)).map(binding => [binding.child, binding.running]), [['stepping', true], ['done', true], ['crashed', true]])
    assert.deepEqual(await ctx.dishCrew.worktreeBindings('/nowhere'), [])

    // With no registry, the record's word.
    await registry.dispose()
    assert.equal(ctx.get('agents'), undefined)
    assert.deepEqual((await ctx.dishCrew.worktreeBindings(TREE)).map(binding => [binding.child, binding.running]), [['stepping', true], ['done', false], ['crashed', true]])
  } finally {
    await handle.dispose()
  }
})

test('worktreeBindings finds a binding by a path that reaches the worktree through a link, and takes a path that isn\'t there as it is', async () => {
  const where = await dirs()
  const real = join(where.root, 'work', 'o', 'r', '.worktrees', 'fix-1')
  await mkdir(real, { recursive: true })
  const canonical = await realpath(real)
  await symlink(join(where.root, 'work'), join(where.root, 'linked-work'))
  const linked = join(where.root, 'linked-work', 'o', 'r', '.worktrees', 'fix-1')
  const ctx = new Context()
  const handle = mountCrew(ctx, where.data)
  await handle
  try {
    await ctx.dishCrew.records.addChild('s1', crewChild('c1', { worktree: canonical }))
    assert.deepEqual((await ctx.dishCrew.worktreeBindings(linked)).map(binding => binding.child), ['c1'])
    assert.deepEqual((await ctx.dishCrew.worktreeBindings(canonical)).map(binding => binding.child), ['c1'])
    // Gone from disk: the path as given, which is what the record holds.
    await rm(real, { recursive: true })
    assert.deepEqual((await ctx.dishCrew.worktreeBindings(canonical)).map(binding => binding.child), ['c1'])
  } finally {
    await handle.dispose()
  }
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

const DEFAULTS_DIRECTORY = fileURLToPath(new URL('../defaults/', import.meta.url))

/** A shipped crew.yaml from git history whose sha256 is `hash`, or `undefined` (and `t` skipped) with no history here. */
async function earlierDefault(t: TestContext, hash: string): Promise<string | undefined> {
  try {
    await computePrevious(DEFAULTS_DIRECTORY, '')
  } catch (error) {
    if ((error as { code?: unknown }).code !== 'NO_HISTORY') throw error
    t.skip((error as Error).message)
    return undefined
  }
  // A scratch HOME, never the runner's, and no global git config.
  const env = { PATH: process.env.PATH, HOME: await tempDir(), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
  const git = (...args: string[]): string => execFileSync('git', ['-C', DEFAULTS_DIRECTORY, ...args], { encoding: 'utf8', env })
  for (const commit of git('log', '--full-history', '--format=%H', '--', 'crew.yaml').split('\n').filter(Boolean)) {
    const text = git('show', `${commit}:./crew.yaml`)
    if (createHash('sha256').update(text, 'utf8').digest('hex') === hash) return text
  }
  throw new Error(`no earlier crew.yaml has the hash ${hash}`)
}

test('at start, a crew.yaml that is an earlier shipped default becomes the current one; an edited one stays', async (t) => {
  const earlier = await earlierDefault(t, PREVIOUS_HASHES[0]!)
  if (earlier === undefined) return
  assert.notEqual(earlier, DEFAULT_TEXT)
  const unedited = await dirs()
  const edited = await dirs()
  const mine = `${earlier}# mine\n`
  await withBoth(unedited, async (ctx) => { assert.ok(await ctx.dishConfig.write([{ path: 'crew.yaml', text: earlier }], { author: USER })) })
  await withBoth(edited, async (ctx) => { assert.ok(await ctx.dishConfig.write([{ path: 'crew.yaml', text: mine }], { author: USER })) })

  await withBoth(unedited, async (ctx) => {
    // The seed isn't awaited by start-up, so the upgrade lands a moment after the plugin is up.
    await waitFor('the earlier default to be replaced', async () => (await ctx.dishConfig.read('crew.yaml')) === DEFAULT_TEXT || undefined)
    const [latest] = await ctx.dishConfig.history({ path: 'crew.yaml' })
    assert.deepEqual(latest!.author, { kind: 'system' })
    assert.equal(latest!.note, 'updated to the new defaults')
  })
  await withBoth(edited, async (ctx) => {
    // The plugin's own seed isn't awaited: seeding again as it does shows there is nothing to replace.
    await ctx.dishConfig.seed({ 'crew.yaml': DEFAULT_TEXT }, 'dish-crew', { replace: { 'crew.yaml': [...PREVIOUS_HASHES] } })
    assert.equal(await ctx.dishConfig.read('crew.yaml'), mine)
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

test('the configuration has dataDirectory, subagentProvider (spawn), messageLimit (1200), reportSteers (2) and terminal, and nothing of the spike', () => {
  const config = plugin.Config({} as plugin.Config)
  assert.deepEqual({ ...config }, { dataDirectory: '', subagentProvider: 'spawn', messageLimit: 1200, reportSteers: 2, terminal: true })
  assert.equal(plugin.name, 'dish-crew')
})

test('reportSteers is a natural number: 0 is accepted (the steer is off), and a negative, a fraction or a string is not', () => {
  const parse = (input: Record<string, unknown>): plugin.Config => plugin.Config(input as unknown as plugin.Config)
  assert.equal(parse({ reportSteers: 0 }).reportSteers, 0)
  assert.equal(parse({ reportSteers: 5 }).reportSteers, 5)
  assert.throws(() => parse({ reportSteers: -1 }))
  assert.throws(() => parse({ reportSteers: 1.5 }))
  assert.throws(() => parse({ reportSteers: '2' }))
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

// --- the record and run capture -------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function crewChild(id: string, overrides: Partial<NewChild> = {}): NewChild {
  return { id, role: 'coder', title: 'add login', model: 'claude-sonnet-5.5', family: 'anthropic', ...overrides }
}

/** The part of an agent that `agent/error` listeners here use. */
function agentOf(id: string): Agent {
  return { id } as unknown as Agent
}

function errored(ctx: Context, id: string, error: unknown): void {
  ctx.emit('agent/error', { agent: agentOf(id), turn: 1, step: 2, error })
}

function ended(ctx: Context, id: string, stopReason: string, lastAssistantMessage?: unknown[]): void {
  ctx.emit('subagent/end', {
    runId: 'run-1', provider: 'spawn', id, local: true, stopReason,
    ...lastAssistantMessage === undefined ? {} : { lastAssistantMessage },
  } as unknown as SubagentRunEndInfo)
}

/** A run of a child that starts: dsh publishes one for a first start, a wake and a resume alike. */
function started(ctx: Context, id: string): void {
  ctx.emit('subagent/start', { runId: 'run-2', provider: 'spawn', id, local: true } as unknown as SubagentRunInfo)
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false)
}

function sessionPath(where: Dirs, session: string, ...rest: string[]): string {
  return join(where.data, 'sessions', sha(session), ...rest)
}

/** A plugin mounted on `where.data` in a fresh `Context`, and what unmounts it. */
async function mounted(where: Dirs): Promise<{ ctx: Context, handle: ReturnType<typeof mountCrew>, logs: string[] }> {
  const ctx = new Context()
  const logs = watchLogs(ctx)
  const handle = mountCrew(ctx, where.data)
  await handle
  return { ctx, handle, logs }
}

/**
 * One turn of the event loop. The listeners chain what they do through promises, so by the next turn every step that is
 * not waiting on a file or a gate has run. For a test to show that something did *not* happen: after it, what would
 * have been called by now has been.
 */
function turn(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

/** What `t.mock.method` gives: enough of it to wait for calls and for what they returned. */
interface Calls {
  mock: { callCount(): number, calls: ReadonlyArray<{ result: unknown }> }
}

/** Wait until `spy` has been called `count` times, then until everything it returned is done. */
async function done(spy: Calls, count: number): Promise<void> {
  await waitFor(`${count} call(s)`, () => spy.mock.callCount() >= count || undefined)
  await Promise.all(spy.mock.calls.map(call => call.result))
}

test('dishCrew.records is the record on the data directory, and nothing is written until a child is added', async () => {
  const where = await dirs()
  const { ctx, handle } = await mounted(where)
  try {
    const { records } = ctx.dishCrew
    assert.ok(records instanceof CrewRecords)
    assert.equal(await exists(where.data), false)
    const added = await records.addChild('s1', crewChild('c1'))
    assert.equal(added.n, 1)
    assert.ok(await exists(sessionPath(where, 's1', 'children.json')))
    assert.equal(ctx.dishCrew.whenRecorded('c1'), undefined)
  } finally {
    await handle.dispose()
  }
})

test('an agent/error and a subagent/end for a crew child are recorded: the report holds the closing message, the run holds the error', async () => {
  const where = await dirs()
  const { ctx, handle, logs } = await mounted(where)
  try {
    await ctx.dishCrew.records.addChild('s1', crewChild('c1'))
    errored(ctx, 'c1', new Error('429 rate limited'))
    ended(ctx, 'c1', 'error', [
      { type: 'reasoning', text: 'thinking about it' },
      { type: 'text', text: 'I got as far as the router.' },
      { type: 'tool_use', id: 't1', name: 'read', input: {} },
      { type: 'text', text: '   ' },
      { type: 'text', text: 'Then the API stopped answering.' },
    ])
    const recorded = await ctx.dishCrew.whenRecorded('c1')
    const report = sessionPath(where, 's1', '1-coder-1.md')
    assert.equal(recorded?.report, report)
    assert.equal(await readFile(report, 'utf8'), 'I got as far as the router.\n\nThen the API stopped answering.\n')
    const [child] = await ctx.dishCrew.records.children('s1')
    assert.equal(child!.last, 'failed')
    assert.equal(child!.runs.length, 1)
    assert.deepEqual({ ...child!.runs[0]!, endedAt: 0 }, { endedAt: 0, stopReason: 'error', error: '429 rate limited', report })
    // The file on disk is what the record says.
    const onDisk = JSON.parse(await readFile(sessionPath(where, 's1', 'children.json'), 'utf8'))
    assert.equal(onDisk.children[0].runs[0].error, '429 rate limited')
    assert.deepEqual(logs, [])
  } finally {
    await handle.dispose()
  }
})

test('a run that finished with no error is finished; a missing last message is a report that says so', async () => {
  const where = await dirs()
  const { ctx, handle } = await mounted(where)
  try {
    await ctx.dishCrew.records.addChild('s1', crewChild('c1'))
    await ctx.dishCrew.records.addChild('s1', crewChild('c2', { role: 'researcher' }))
    ended(ctx, 'c1', 'completed', [{ type: 'text', text: 'Done.' }])
    ended(ctx, 'c2', 'aborted')
    await ctx.dishCrew.whenRecorded('c1')
    await ctx.dishCrew.whenRecorded('c2')
    assert.equal(await readFile(sessionPath(where, 's1', '1-coder-1.md'), 'utf8'), 'Done.\n')
    assert.equal(await readFile(sessionPath(where, 's1', '2-researcher-1.md'), 'utf8'), '(no closing message)\n')
    const [one, two] = await ctx.dishCrew.records.children('s1')
    assert.deepEqual([one!.last, two!.last], ['finished', 'stopped'])
    assert.ok(!('error' in one!.runs[0]!))
  } finally {
    await handle.dispose()
  }
})

test('an error and an end in the same tick still meet, and an end clears the error so the next run does not have it', async () => {
  const where = await dirs()
  const { ctx, handle } = await mounted(where)
  try {
    await ctx.dishCrew.records.addChild('s1', crewChild('c1'))
    errored(ctx, 'c1', new Error('first run broke'))
    errored(ctx, 'c1', new Error('and then the last thing that broke'))
    ended(ctx, 'c1', 'error')
    await ctx.dishCrew.whenRecorded('c1')
    ended(ctx, 'c1', 'completed', [{ type: 'text', text: 'second run is fine' }])
    await ctx.dishCrew.whenRecorded('c1')
    const [child] = await ctx.dishCrew.records.children('s1')
    assert.deepEqual(child!.runs.map(run => run.error), ['and then the last thing that broke', undefined])
    assert.deepEqual(child!.runs.map(run => run.report.split('/').pop()), ['1-coder-1.md', '1-coder-2.md'])
    assert.equal(child!.last, 'finished')
  } finally {
    await handle.dispose()
  }
})

test('two runs that end close together are recorded in the order they ended', async () => {
  const where = await dirs()
  const { ctx, handle } = await mounted(where)
  try {
    await ctx.dishCrew.records.addChild('s1', crewChild('c1'))
    for (let run = 1; run <= 6; run++) {
      // An error only for the odd ones: its lookup is slower than none, which must not let a later end overtake.
      if (run % 2 === 1) errored(ctx, 'c1', new Error(`error ${run}`))
      ended(ctx, 'c1', run % 2 === 1 ? 'error' : 'completed', [{ type: 'text', text: `run ${run}` }])
    }
    await ctx.dishCrew.whenRecorded('c1')
    const [child] = await ctx.dishCrew.records.children('s1')
    assert.deepEqual(child!.runs.map(run => run.error), ['error 1', undefined, 'error 3', undefined, 'error 5', undefined])
    for (const [index, run] of child!.runs.entries()) assert.equal(await readFile(run.report, 'utf8'), `run ${index + 1}\n`)
  } finally {
    await handle.dispose()
  }
})

test('whenRecorded is the run being recorded: there as soon as the event is, the report when it settles, then gone', async () => {
  const where = await dirs()
  const { ctx, handle } = await mounted(where)
  try {
    await ctx.dishCrew.records.addChild('s1', crewChild('c1'))
    assert.equal(ctx.dishCrew.whenRecorded('c1'), undefined)
    ended(ctx, 'c1', 'completed', [{ type: 'text', text: 'x' }])
    const pending = ctx.dishCrew.whenRecorded('c1')
    assert.ok(pending instanceof Promise)
    assert.equal((await pending)?.report, sessionPath(where, 's1', '1-coder-1.md'))
    assert.equal(ctx.dishCrew.whenRecorded('c1'), undefined)
  } finally {
    await handle.dispose()
  }
})

test('the errors and ends of agents crew did not start are ignored: nothing is written, and an error is not kept for later', async (t) => {
  const where = await dirs()
  const { ctx, handle, logs } = await mounted(where)
  try {
    const lookups = t.mock.method(ctx.dishCrew.records, 'lookup')
    errored(ctx, 'stranger', new Error('not ours'))
    ended(ctx, 'stranger', 'error', [{ type: 'text', text: 'not ours' }])
    assert.equal(await ctx.dishCrew.whenRecorded('stranger'), undefined)
    assert.equal(await exists(where.data), false)
    // An error for an id that is not a crew child is not remembered, so if it becomes one it doesn't have it. The
    // lookup the listener made has to have answered (that it is not one) before the child is added: it is awaited.
    errored(ctx, 'late', new Error('before it was ours'))
    await done(lookups, 2)
    await ctx.dishCrew.records.addChild('s1', crewChild('late'))
    ended(ctx, 'late', 'completed', [{ type: 'text', text: 'fine' }])
    await ctx.dishCrew.whenRecorded('late')
    const [child] = await ctx.dishCrew.records.children('s1')
    assert.ok(!('error' in child!.runs[0]!))
    assert.deepEqual(logs, [])
  } finally {
    await handle.dispose()
  }
})

test('an error is remembered as its message, or a short form of it', async () => {
  const where = await dirs()
  const { ctx, handle } = await mounted(where)
  try {
    const cases: Array<[unknown, string]> = [
      [new Error('boom'), 'boom'],
      [new TypeError(''), 'TypeError'],
      ['plain text', 'plain text'],
      [{ message: 'from an object', code: 1 }, 'from an object'],
      [{ code: 42 }, '{"code":42}'],
      [undefined, 'unknown error'],
      [null, 'unknown error'],
      [42, '42'],
      ['x'.repeat(5000), `${'x'.repeat(999)}…`],
    ]
    for (const [index] of cases.entries()) await ctx.dishCrew.records.addChild('s1', crewChild(`c${index}`))
    for (const [index, [error]] of cases.entries()) {
      errored(ctx, `c${index}`, error)
      ended(ctx, `c${index}`, 'error')
    }
    for (const [index] of cases.entries()) await ctx.dishCrew.whenRecorded(`c${index}`)
    const listed = await ctx.dishCrew.records.children('s1')
    assert.deepEqual(listed.map(child => child.runs[0]!.error), cases.map(([, expected]) => expected))
  } finally {
    await handle.dispose()
  }
})

test('what is remembered for errors is bounded: the oldest are forgotten first', async () => {
  const where = await dirs()
  const { ctx, handle } = await mounted(where)
  try {
    const total = plugin.ERROR_MEMORY + 3
    const ids = Array.from({ length: total }, (_, index) => `c${index}`)
    for (const id of ids) await ctx.dishCrew.records.addChild('s1', crewChild(id))
    // Eviction is as the errors come in, so no waiting is needed: the first three are out by the time this returns.
    for (const id of ids) errored(ctx, id, new Error(`error of ${id}`))
    for (const id of [ids[0]!, ids[1]!, ids[total - 1]!]) ended(ctx, id, 'error')
    for (const id of [ids[0]!, ids[1]!, ids[total - 1]!]) await ctx.dishCrew.whenRecorded(id)
    const errors = Object.fromEntries((await ctx.dishCrew.records.children('s1')).map(child => [child.id, child.runs[0]?.error]))
    assert.equal(errors[ids[0]!], undefined)
    assert.equal(errors[ids[1]!], undefined)
    assert.equal(errors[ids[total - 1]!], `error of ${ids[total - 1]}`)
  } finally {
    await handle.dispose()
  }
})

test('a record that can not be written is logged, never thrown, and whenRecorded still resolves', async () => {
  const where = await dirs()
  const { ctx, handle, logs } = await mounted(where)
  try {
    await ctx.dishCrew.records.addChild('s1', crewChild('c1'))
    const file = sessionPath(where, 's1', 'children.json')
    await rm(file)
    await mkdir(file)
    errored(ctx, 'c1', new Error('x'))
    assert.doesNotThrow(() => { ended(ctx, 'c1', 'completed', [{ type: 'text', text: 'x' }]) })
    assert.equal(await ctx.dishCrew.whenRecorded('c1'), undefined)
    const lines = logs.filter(line => line.startsWith('[dish-crew] warn:'))
    assert.ok(lines.some(line => /could not record the end of child c1: /.test(line)), logs.join('\n'))
    // The next one after the trouble is gone is recorded.
    await rm(file, { recursive: true })
    await ctx.dishCrew.records.addChild('s1', crewChild('c1'))
    ended(ctx, 'c1', 'completed', [{ type: 'text', text: 'y' }])
    assert.ok(await ctx.dishCrew.whenRecorded('c1'))
  } finally {
    await handle.dispose()
  }
})

test('events with nothing in them are no trouble: the listeners take what they are given and do not throw', async () => {
  const where = await dirs()
  const { ctx, handle } = await mounted(where)
  try {
    const odd: unknown[] = [undefined, null, 5, 'text', {}, { agent: null }, { agent: {} }, { agent: { id: 5 } }, { id: '' }, { id: 7 }, { id: 'x', stopReason: 5, lastAssistantMessage: 'text' }, { id: 'x', lastAssistantMessage: [null, 5, { type: 'text' }, { type: 'text', text: 5 }] }]
    for (const payload of odd) {
      assert.doesNotThrow(() => { ctx.emit('agent/error', payload as never) }, JSON.stringify(payload))
      assert.doesNotThrow(() => { ctx.emit('subagent/start', payload as never) }, JSON.stringify(payload))
      assert.doesNotThrow(() => { ctx.emit('subagent/end', payload as never) }, JSON.stringify(payload))
    }
    // The payloads with an id of 'x' are the only ones the listeners do anything with, and the last of them is an end,
    // which comes after the starts of 'x': when it is recorded, they all are.
    assert.equal(await ctx.dishCrew.whenRecorded('x'), undefined)
    assert.equal(await exists(where.data), false)
  } finally {
    await handle.dispose()
  }
})

test('the listeners go with the plugin, and the unmount waits for a record that is being written', async (t) => {
  const where = await dirs()
  const { ctx, handle } = await mounted(where)
  const { records } = ctx.dishCrew
  await records.addChild('s1', crewChild('c1'))
  await records.addChild('s1', crewChild('c2'))
  ended(ctx, 'c1', 'completed', [{ type: 'text', text: 'written before the unmount finished' }])
  await handle.dispose()
  assert.equal(await readFile(sessionPath(where, 's1', '1-coder-1.md'), 'utf8'), 'written before the unmount finished\n')
  const calls = [t.mock.method(records, 'endRun'), t.mock.method(records, 'startRun')]
  ended(ctx, 'c2', 'completed', [{ type: 'text', text: 'after' }])
  started(ctx, 'c2')
  // Something that is not heard does not happen: after a turn, a listener that was still there would have called the record.
  await turn()
  assert.deepEqual(calls.map(call => call.mock.callCount()), [0, 0])
  assert.deepEqual((await records.children('s1'))[1]!.runs, [])
  assert.equal(ctx.get('dishCrew'), undefined)
})

test('an end that comes while the plugin unmounts is not heard, and the unmount waits for the one being written', async (t) => {
  const where = await dirs()
  const { ctx, handle } = await mounted(where)
  const { records } = ctx.dishCrew
  await records.addChild('s1', crewChild('c1'))
  await records.addChild('s1', crewChild('c2'))
  // The record of c1's end is held until the test lets it go.
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const original = CrewRecords.prototype.endRun
  const filed: string[] = []
  t.mock.method(records, 'endRun', async function (this: CrewRecords, id: string, end: RunEnd) {
    filed.push(id)
    await gate
    return original.call(this, id, end)
  })
  ended(ctx, 'c1', 'completed', [{ type: 'text', text: 'c1 was being recorded' }])
  const unmounting = handle.dispose()
  // The unmount is waiting for c1. An end that comes now is one it would not wait for, if it were heard: it would be filed
  // after the unmount's wait, with the plugin gone. cordis removes the listeners in the same microtask batch as the flush
  // takes its snapshot, whatever the order the effects were registered in, so this holds the two together: c2 (a turn
  // later) is not heard, and c1 is waited for.
  await turn()
  ended(ctx, 'c2', 'completed', [{ type: 'text', text: 'c2 came while unmounting' }])
  await turn()
  release()
  await unmounting
  assert.deepEqual(filed, ['c1'])
  assert.equal(await readFile(sessionPath(where, 's1', '1-coder-1.md'), 'utf8'), 'c1 was being recorded\n')
  assert.deepEqual((await records.children('s1')).map(child => child.runs.length), [1, 0])
})

// --- starts ---------------------------------------------------------------------------------------

test('a child that dsh brings back up (a message to one that had finished) is running again, so the limits count it', async (t) => {
  const where = await dirs()
  const { ctx, handle } = await mounted(where)
  try {
    const { records } = ctx.dishCrew
    await records.addChild('s1', crewChild('c1'))
    ended(ctx, 'c1', 'completed', [{ type: 'text', text: 'first run' }])
    await ctx.dishCrew.whenRecorded('c1')
    assert.equal((await records.children('s1'))[0]!.last, 'finished')
    const starts = t.mock.method(records, 'startRun')
    started(ctx, 'c1')
    await done(starts, 1)
    const [child] = await records.children('s1')
    assert.equal(child!.last, 'running')
    assert.equal(child!.runs.length, 1)
    assert.equal(child!.followUps, 0)
    // And its next end settles it again.
    ended(ctx, 'c1', 'completed', [{ type: 'text', text: 'second run' }])
    await ctx.dishCrew.whenRecorded('c1')
    assert.equal((await records.children('s1'))[0]!.last, 'finished')
  } finally {
    await handle.dispose()
  }
})

test('a start, an end and a start in one tick leave the child running: the second start waits for the end', async (t) => {
  const where = await dirs()
  const { ctx, handle } = await mounted(where)
  try {
    const { records } = ctx.dishCrew
    await records.addChild('s1', crewChild('c1'))
    // The end is held, so that a start that did not wait for it would be filed first, and the end would then undo it.
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const order: string[] = []
    const endRun = CrewRecords.prototype.endRun
    const startRun = CrewRecords.prototype.startRun
    t.mock.method(records, 'endRun', async function (this: CrewRecords, id: string, end: RunEnd) {
      await gate
      const result = await endRun.call(this, id, end)
      order.push('end')
      return result
    })
    const starts = t.mock.method(records, 'startRun', async function (this: CrewRecords, id: string) {
      order.push('start')
      await startRun.call(this, id)
    })
    started(ctx, 'c1')
    ended(ctx, 'c1', 'completed', [{ type: 'text', text: 'done' }])
    started(ctx, 'c1')
    await turn()
    release()
    await ctx.dishCrew.whenRecorded('c1')
    await done(starts, 2)
    assert.deepEqual(order, ['start', 'end', 'start'])
    const [child] = await records.children('s1')
    assert.equal(child!.last, 'running')
    assert.equal(child!.runs.length, 1)
  } finally {
    await handle.dispose()
  }
})

test('the start of an agent crew did not start is ignored, and writes nothing', async (t) => {
  const where = await dirs()
  const { ctx, handle, logs } = await mounted(where)
  try {
    const starts = t.mock.method(ctx.dishCrew.records, 'startRun')
    started(ctx, 'stranger')
    await done(starts, 1)
    assert.equal(await exists(where.data), false)
    assert.deepEqual(logs, [])
  } finally {
    await handle.dispose()
  }
})

test('a start that can not be recorded is logged, never thrown, and the next end is still recorded', async () => {
  const where = await dirs()
  const { ctx, handle, logs } = await mounted(where)
  try {
    await ctx.dishCrew.records.addChild('s1', crewChild('c1'))
    const file = sessionPath(where, 's1', 'children.json')
    await rm(file)
    await mkdir(file)
    assert.doesNotThrow(() => { started(ctx, 'c1') })
    await waitFor('the failure to be logged', () => logs.some(line => /could not record the start of child c1: /.test(line)) || undefined)
    await rm(file, { recursive: true })
    await ctx.dishCrew.records.addChild('s1', crewChild('c1'))
    ended(ctx, 'c1', 'completed', [{ type: 'text', text: 'y' }])
    assert.ok(await ctx.dishCrew.whenRecorded('c1'))
  } finally {
    await handle.dispose()
  }
})

// --- pruning at start, and what the record logs ---------------------------------------------------

/** A session in `where.data` whose files were last written `ageMs` ago. */
async function seedSession(where: Dirs, session: string, ageMs: number): Promise<void> {
  const records = new CrewRecords(where.data)
  await records.addChild(session, crewChild(`${session}-child`))
  await records.endRun(`${session}-child`, { stopReason: 'completed', closing: 'x' })
  const dir = sessionPath(where, session)
  const when = new Date(Date.now() - ageMs)
  for (const name of await readdir(dir)) await utimes(join(dir, name), when, when)
}

test('at start, sessions not written to for 180 days are pruned, before dishCrew is provided, and the rest are kept', async () => {
  const where = await dirs()
  await seedSession(where, 'old', 181 * DAY)
  await seedSession(where, 'recent', 179 * DAY)
  const ctx = new Context()
  // Whether the old session was still there when the service appeared: the prune comes first.
  let oldWhenProvided: boolean | undefined
  ctx.on('internal/service', (name) => {
    if (name === 'dishCrew' && oldWhenProvided === undefined) oldWhenProvided = existsSync(sessionPath(where, 'old'))
  })
  const handle = mountCrew(ctx, where.data)
  try {
    await handle
    assert.equal(await exists(sessionPath(where, 'old')), false)
    assert.equal(await exists(sessionPath(where, 'recent')), true)
    assert.equal(await exists(join(where.data, 'by-child', sha('old-child'))), false)
    assert.equal(await exists(join(where.data, 'by-child', sha('recent-child'))), true)
    assert.equal((await ctx.dishCrew.records.children('recent')).length, 1)
    assert.equal((await ctx.dishCrew.records.children('old')).length, 0)
    assert.equal(oldWhenProvided, false)
  } finally {
    await handle.dispose()
  }
})

test('a prune that fails is logged and the service is provided all the same', async () => {
  const where = await dirs()
  // A data directory that is a file: nothing under it can be listed.
  await writeFile(where.data, 'not a directory')
  const ctx = new Context()
  const seen = watchLogs(ctx)
  const handle = mountCrew(ctx, where.data)
  try {
    await handle
    assert.ok(ctx.get('dishCrew'))
    const lines = seen.filter(line => line.startsWith('[dish-crew] warn:'))
    assert.equal(lines.length, 1, seen.join('\n'))
    assert.match(lines[0]!, /could not prune the crew's old records in .*: /)
  } finally {
    await handle.dispose()
  }
})

test('a children.json that is not valid is logged with where it went and what happens to the count', async () => {
  const where = await dirs()
  const { ctx, handle, logs } = await mounted(where)
  try {
    await ctx.dishCrew.records.addChild('s1', crewChild('c1'))
    await writeFile(sessionPath(where, 's1', 'children.json'), '{ nope')
    assert.deepEqual(await ctx.dishCrew.records.children('s1'), [])
    const lines = logs.filter(line => line.startsWith('[dish-crew] warn:'))
    assert.equal(lines.length, 1, logs.join('\n'))
    assert.match(lines[0]!, /the record of session s1 is not valid; it was moved to .*children\.json\.corrupt-\d+ and the session starts a new one, so its delegation count starts again from 0/)
    const moved = (await readdir(sessionPath(where, 's1'))).filter(name => name.startsWith('children.json.corrupt-'))
    assert.equal(moved.length, 1)
    assert.ok(lines[0]!.includes(join(sessionPath(where, 's1'), moved[0]!)))
  } finally {
    await handle.dispose()
  }
})

// DSH_DISH_HOME moves every dish directory ahead of XDG_*. A parent environment that has it (a `pnpm dev` shell) must not
// leak into the tests that steer dish's directories with XDG_*: withEnv hides it for its body and puts it back.
test('withEnv hides an inherited DSH_DISH_HOME, so XDG_* steer dish in its body, and puts it back', async () => {
  const root = await tempDir()
  const instance = join(root, 'instance')
  const inherited = process.env.DSH_DISH_HOME
  process.env.DSH_DISH_HOME = instance
  try {
    await withEnv({ XDG_DATA_HOME: join(root, 'xdg') }, async () => {
      assert.equal(process.env.DSH_DISH_HOME, undefined)
      assert.equal(xdgPaths('dish').data, join(root, 'xdg', 'dish'))
      assert.equal(plugin.dataDirectoryPath(undefined), join(root, 'xdg', 'dish', 'crew'))
    })
    assert.equal(process.env.DSH_DISH_HOME, instance, 'put back after the body')
    await assert.rejects(withEnv({ XDG_DATA_HOME: join(root, 'xdg') }, async () => { throw new Error('boom') }), /boom/)
    assert.equal(process.env.DSH_DISH_HOME, instance, 'put back after a failing body too')
    assert.equal(existsSync(instance), false, 'nothing was written under DSH_DISH_HOME')
  } finally {
    if (inherited === undefined) delete process.env.DSH_DISH_HOME
    else process.env.DSH_DISH_HOME = inherited
  }
})

// --- dish-crew/settled and the notice's id (step 7) -----------------------------------------------

const REPORT: CoderReport = { role: 'coder', turn: 1, at: 1_700_000_000_000, status: 'done', summary: 'Added the login form.', commits: ['a'.repeat(40)] }

/** dsh's settlement notice for child `sender`, as it enters the parent's inbox. */
function settlement(sender: string, id: string): unknown {
  return {
    id, role: 'user', content: [{ type: 'text', text: `Subagent ${sender} finished.` }],
    source: { kind: 'subagent-settled', form: 'notice', summary: `Subagent ${sender} finished.`, senderSessionId: sender },
  }
}

function inserted(ctx: Context, message: unknown): void {
  ctx.emit('agent/inbox/inserted', { agent: agentOf('main'), message } as never)
}

test('dish-crew/settled: after subagent/end files a crew child\'s run, it carries the session, the filed child and the run, with its report', async () => {
  const where = await dirs()
  const { ctx, handle, logs } = await mounted(where)
  const heard: CrewSettled[] = []
  ctx.on('dish-crew/settled', (event) => { heard.push(event) })
  try {
    await ctx.dishCrew.records.addChild('s1', crewChild('c1'))
    const stored = await ctx.dishCrew.records.setReport('c1', REPORT)
    ended(ctx, 'c1', 'completed', [{ type: 'tool_use', id: 't1', name: 'report', input: {} }])
    const recorded = await ctx.dishCrew.whenRecorded('c1')
    assert.equal(heard.length, 1)
    const [event] = heard
    const { record } = (await ctx.dishCrew.records.lookup('c1'))!
    assert.equal(event!.sessionId, 's1')
    assert.deepEqual(event!.child, record)
    assert.deepEqual(event!.run, record.runs.at(-1))
    assert.deepEqual(event!.run.structured, stored)
    assert.equal(event!.run.structuredFile, sessionPath(where, 's1', '1-coder-1.json'))
    assert.equal(recorded?.report, sessionPath(where, 's1', '1-coder-1.md'))
    // A run without a report is published too, without one.
    ended(ctx, 'c1', 'completed', [{ type: 'text', text: 'and again' }])
    await ctx.dishCrew.whenRecorded('c1')
    assert.equal(heard.length, 2)
    assert.ok(!('structured' in heard[1]!.run))
    assert.deepEqual(logs, [])
  } finally {
    await handle.dispose()
  }
})

test('whenRecorded resolves only once the dish-crew/settled listeners have, and a child\'s next end waits as well', async () => {
  const where = await dirs()
  const { ctx, handle } = await mounted(where)
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  const order: string[] = []
  ctx.on('dish-crew/settled', async (event) => {
    order.push(`heard ${event.run.report.split('/').pop()}`)
    if (event.child.runs.length === 1) await held
  })
  try {
    await ctx.dishCrew.records.addChild('s1', crewChild('c1'))
    ended(ctx, 'c1', 'completed', [{ type: 'text', text: 'first' }])
    let resolved = false
    void ctx.dishCrew.whenRecorded('c1')!.then(() => { resolved = true })
    await waitFor('the listener', () => order.length === 1 || undefined)
    for (let n = 0; n < 5; n++) await turn()
    assert.equal(resolved, false)
    ended(ctx, 'c1', 'completed', [{ type: 'text', text: 'second' }])
    for (let n = 0; n < 5; n++) await turn()
    assert.deepEqual(order, ['heard 1-coder-1.md'], 'the second end waits for the first one\'s listeners')
    release()
    await ctx.dishCrew.whenRecorded('c1')
    assert.equal(resolved, true)
    assert.deepEqual(order, ['heard 1-coder-1.md', 'heard 1-coder-2.md'])
  } finally {
    release()
    await handle.dispose()
  }
})

test('a dish-crew/settled listener that throws is logged, and the run is filed', async () => {
  const where = await dirs()
  const { ctx, handle, logs } = await mounted(where)
  ctx.on('dish-crew/settled', () => { throw new Error('the ledger is full') })
  try {
    await ctx.dishCrew.records.addChild('s1', crewChild('c1'))
    ended(ctx, 'c1', 'completed', [{ type: 'text', text: 'done' }])
    const recorded = await ctx.dishCrew.whenRecorded('c1')
    assert.equal(recorded?.report, sessionPath(where, 's1', '1-coder-1.md'))
    assert.equal((await ctx.dishCrew.records.lookup('c1'))!.record.runs.length, 1)
    assert.deepEqual(logs, ['[dish-crew] warn: a dish-crew/settled listener failed: the ledger is full'])
  } finally {
    await handle.dispose()
  }
})

test('an agent crew didn\'t start gets no dish-crew/settled', async () => {
  const where = await dirs()
  const { ctx, handle } = await mounted(where)
  const heard: CrewSettled[] = []
  ctx.on('dish-crew/settled', (event) => { heard.push(event) })
  try {
    ended(ctx, 'stranger', 'completed', [{ type: 'text', text: 'not ours' }])
    assert.equal(await ctx.dishCrew.whenRecorded('stranger'), undefined)
    assert.deepEqual(heard, [])
  } finally {
    await handle.dispose()
  }
})

test('the notice\'s id: a settlement for c1 in the parent\'s inbox, then c1\'s end in the same tick, puts the id on the run', async () => {
  const where = await dirs()
  const { ctx, handle } = await mounted(where)
  try {
    await ctx.dishCrew.records.addChild('s1', crewChild('c1'))
    inserted(ctx, settlement('c1', 'msg-1'))
    ended(ctx, 'c1', 'completed', [{ type: 'text', text: 'done' }])
    const recorded = await ctx.dishCrew.whenRecorded('c1')
    assert.equal(recorded?.run.notice, 'msg-1')
    assert.equal((await ctx.dishCrew.records.lookup('c1'))!.record.runs[0]!.notice, 'msg-1')
  } finally {
    await handle.dispose()
  }
})

test('the notice\'s id: an end in a later turn gets none, and one child\'s notice never lands on another\'s run', async () => {
  const where = await dirs()
  const { ctx, handle } = await mounted(where)
  try {
    await ctx.dishCrew.records.addChild('s1', crewChild('c1'))
    await ctx.dishCrew.records.addChild('s1', crewChild('c2', { role: 'researcher' }))
    inserted(ctx, settlement('c1', 'msg-late'))
    await turn()
    ended(ctx, 'c1', 'completed', [{ type: 'text', text: 'done' }])
    assert.ok(!('notice' in (await ctx.dishCrew.whenRecorded('c1'))!.run))

    inserted(ctx, settlement('c2', 'msg-c2'))
    ended(ctx, 'c1', 'completed', [{ type: 'text', text: 'again' }])
    ended(ctx, 'c2', 'completed', [{ type: 'text', text: 'found it' }])
    // Both taken now: `whenRecorded` is only the run being recorded, and c2's may be done while c1's is awaited.
    const [first, second] = [ctx.dishCrew.whenRecorded('c1'), ctx.dishCrew.whenRecorded('c2')]
    assert.ok(!('notice' in (await first)!.run))
    assert.equal((await second)?.run.notice, 'msg-c2')
    // Taken: the next end of c2 in the same run of the loop has none.
    inserted(ctx, settlement('c2', 'msg-c2b'))
    ended(ctx, 'c2', 'completed', [{ type: 'text', text: 'one' }])
    ended(ctx, 'c2', 'completed', [{ type: 'text', text: 'two' }])
    await ctx.dishCrew.whenRecorded('c2')
    const { runs } = (await ctx.dishCrew.records.lookup('c2'))!.record
    assert.deepEqual(runs.map(run => run.notice), ['msg-c2', 'msg-c2b', undefined])
  } finally {
    await handle.dispose()
  }
})

test('the notice\'s id: other messages and malformed payloads are ignored, and nothing throws', async () => {
  const where = await dirs()
  const { ctx, handle, logs } = await mounted(where)
  try {
    await ctx.dishCrew.records.addChild('s1', crewChild('c1'))
    const payloads: unknown[] = [
      undefined, null, 5, {}, { message: null }, { message: 'text' },
      { message: { id: 'm1', source: { kind: 'user' } } },
      { message: { id: 'm2', source: { kind: 'agent-message', senderSessionId: 'c1' } } },
      { message: { id: 'm3', source: { kind: 'subagent-settled', senderSessionId: '' } } },
      { message: { id: 'm4', source: { kind: 'subagent-settled', senderSessionId: 5 } } },
      { message: { id: 5, source: { kind: 'subagent-settled', senderSessionId: 'c1' } } },
      { message: { source: { kind: 'subagent-settled', senderSessionId: 'c1' } } },
      { message: { id: 'm5', source: null } },
      { message: { id: 'm6' } },
    ]
    for (const payload of payloads) assert.doesNotThrow(() => { ctx.emit('agent/inbox/inserted', payload as never) }, JSON.stringify(payload))
    ended(ctx, 'c1', 'completed', [{ type: 'text', text: 'done' }])
    assert.ok(!('notice' in (await ctx.dishCrew.whenRecorded('c1'))!.run))
    assert.deepEqual(logs, [])
  } finally {
    await handle.dispose()
  }
})

// --- the report tool, its steer and reportSteered (step 7) -----------------------------------------------------------

const HEAD = '3d412b9e0c85d50cce297dbd2bd3d3e44720aaaa'

/** What dsh's registry gives back for a call: enough of it to read. */
interface CallResult { isError: boolean, concludesTurn?: true, value?: unknown, content: Array<{ type: string, text?: string }> }

/** dish-crew mounted over dsh's real tool registry, with agents on scopes of their own (`agentScopes`). */
interface ReportWorld {
  ctx: Context
  where: Dirs
  scopes: AgentScopes
  logs: string[]
  handle: ReturnType<typeof mountCrew>
  crew(): DishCrew
  /** dsh's `agent/created` for `agent`, awaited as dsh awaits it. */
  created(agent: ScopedAgent): Promise<void>
  disposed(agent: ScopedAgent): void
  /** A `session/event` in `agent`'s session: its turn starts, or it says something in `turn`. */
  turnStarts(agent: ScopedAgent, turn: number): void
  says(agent: ScopedAgent, turn: number, step?: number): void
  /** dsh's `agent/turn-stopping` for `agent`, awaited as dsh awaits it. */
  stop(agent: ScopedAgent, turn?: number): Promise<void>
  /** Call `name` as `agent`, through dsh's registry. */
  call(agent: ScopedAgent | object, name: string, args: Record<string, unknown>): Promise<CallResult>
  dispose(): Promise<void>
}

/** `before` runs once the registry is there and before crew is mounted: for what has to be there when crew loads. */
async function reportWorld(options: { config?: Partial<plugin.Config>, before?(ctx: Context, scopes: AgentScopes, where: Dirs): Promise<void> } = {}): Promise<ReportWorld> {
  const where = await dirs()
  const ctx = new Context()
  const logs = watchLogs(ctx)
  const scopes = await agentScopes(ctx)
  await options.before?.(ctx, scopes, where)
  const handle = mountCrew(ctx, where.data, options.config)
  await handle
  const serial = (name: string, payload: unknown) => (ctx as unknown as { serial(name: string, payload: unknown): Promise<unknown> }).serial(name, payload)
  const emit = (name: string, ...args: unknown[]) => { (ctx as unknown as { emit(name: string, ...args: unknown[]): void }).emit(name, ...args) }
  let calls = 0
  return {
    ctx, where, scopes, logs, handle,
    crew: () => ctx.get('dishCrew') as DishCrew,
    async created(agent) { await serial('agent/created', { agent, source: 'startup' }) },
    disposed(agent) { emit('agent/disposed', { agent }) },
    turnStarts(agent, turn) { emit('session/event', agent.session, { type: 'turn/start', seq: 0, time: 0, data: { turn } }) },
    says(agent, turn, step = 1) {
      emit('session/event', agent.session, { type: 'assistant/message', seq: step, time: 0, data: { turn, step, message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } } })
    },
    async stop(agent, turn = 1) { await serial('agent/turn-stopping', { agent, turn, signal: new AbortController().signal }) },
    call: (agent, name, args) => ctx.tools.execute({
      callId: `call-${++calls}` as never, name, arguments: args, agent: agent as never, signal: new AbortController().signal,
    }) as unknown as Promise<CallResult>,
    async dispose() {
      await handle.dispose()
      await scopes.dispose()
    },
  }
}

const reportOf = (w: ReportWorld, agent: object) => w.ctx.tools.get('report', agent)

/** A `send_message` in dsh's registry that delivers anything, for the report guard to stand in front of. */
function registerSendMessage(w: ReportWorld): void {
  w.ctx.tools.register({
    name: 'send_message', description: 'Send a message to an agent.',
    parameters: { type: 'object', properties: { agent_id: { type: 'string' }, message: { type: 'string' } }, required: ['agent_id', 'message'] },
    output: { schema: { type: 'string' }, render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }] },
    async execute() { return 'delivered' },
  } as never)
}

/** A result's text. */
const resultText = (result: CallResult): string => result.content.map(block => block.text ?? '').join('')

/** What the report tool says when the record has no such child. */
const NOT_RECORDED = 'Error: dish-crew has no record of you as a crew child, so the report wasn\'t recorded; end your turn with your report as your closing message'

test('report is on a crew coder\'s and a reviewer\'s own scope after agent/created, each with its role\'s schema; not on the main agent, a researcher or an agent crew doesn\'t know', async () => {
  const w = await reportWorld()
  try {
    const { records } = w.crew()
    await records.addChild('main-1', crewChild('c1'))
    await records.addChild('main-1', crewChild('r1', { role: 'reviewer', reviews: 'c1' }))
    await records.addChild('main-1', crewChild('x1', { role: 'researcher' }))
    const [coder, reviewer, researcher, stranger] = ['c1', 'r1', 'x1', 'nobody'].map(id => w.scopes.child(id))
    const main = w.scopes.main('main-1')
    for (const agent of [coder!, reviewer!, researcher!, stranger!, main]) await w.created(agent)
    assert.deepEqual(Object.keys(reportOf(w, coder!)!.parameters.properties!), Object.keys(CODER_PARAMETERS))
    assert.deepEqual(Object.keys(reportOf(w, reviewer!)!.parameters.properties!), Object.keys(REVIEWER_PARAMETERS))
    for (const agent of [researcher!, stranger!, main]) assert.equal(reportOf(w, agent), undefined, agent.id)
    assert.equal(w.ctx.tools.get('report'), undefined, 'it is no global tool: nobody else sees it')
    assert.deepEqual(w.logs, [])
  } finally {
    await w.dispose()
  }
})

test('report: a second agent object for the same child (a cold resume) gets it too, and the same object twice registers once', async () => {
  const w = await reportWorld()
  try {
    await w.crew().records.addChild('main-1', crewChild('c1'))
    const first = w.scopes.child('c1')
    const resumed = w.scopes.child('c1')
    // Two agent/created for one object, at once: the second can race the first's lookup.
    await Promise.all([w.created(first), w.created(first)])
    await w.created(resumed)
    assert.ok(reportOf(w, first))
    assert.ok(reportOf(w, resumed))
    assert.notEqual(reportOf(w, first), reportOf(w, resumed), 'each agent object has its own')
    assert.deepEqual(w.logs, [], 'a second registration in one scope would have failed, and been logged')
  } finally {
    await w.dispose()
  }
})

test('report is gone after agent/disposed, and after crew unloads', async () => {
  const w = await reportWorld()
  try {
    await w.crew().records.addChild('main-1', crewChild('c1'))
    await w.crew().records.addChild('main-1', crewChild('c2'))
    const one = w.scopes.child('c1')
    const two = w.scopes.child('c2')
    await w.created(one)
    await w.created(two)
    w.disposed(one)
    assert.equal(reportOf(w, one), undefined)
    assert.ok(reportOf(w, two))
    // Disposed twice, or never given it: nothing happens.
    w.disposed(one)
    w.disposed(w.scopes.child('c3'))
    await w.handle.dispose()
    assert.equal(reportOf(w, two), undefined)
    assert.deepEqual(w.logs, [])
  } finally {
    await w.dispose()
  }
})

test('report: a child already in dsh\'s agent registry when crew loads (crew reloaded) gets it', async () => {
  let running!: ScopedAgent
  const w = await reportWorld({
    async before(ctx, scopes, where) {
      const records = new CrewRecords(where.data)
      await records.addChild('main-1', crewChild('c1'))
      await records.flush()
      running = scopes.child('c1')
      await provideStub(ctx, 'agents', { list: () => [scopes.main('main-1'), running], get: () => undefined })
    },
  })
  try {
    await waitFor('report on the running child', () => reportOf(w, running) !== undefined)
    assert.deepEqual(w.logs, [])
  } finally {
    await w.dispose()
  }
})

test('report: a lookup that throws is logged once, and the child\'s creation goes on', async () => {
  const w = await reportWorld()
  try {
    ;(w.crew().records as unknown as { lookup: () => Promise<never> }).lookup = () => Promise.reject(new Error('EIO: the record is unreadable'))
    const agent = w.scopes.child('c1')
    await w.created(agent)
    await w.created(w.scopes.child('c1'))
    assert.equal(reportOf(w, agent), undefined)
    assert.deepEqual(w.logs, ['[dish-crew] warn: could not give crew child c1 the report tool: EIO: the record is unreadable'])
  } finally {
    await w.dispose()
  }
})

test('the order at a stop: crew\'s steer is before a sibling\'s listener registered before crew, which reads reportSteered true; after a concluding report, false and no steer', async () => {
  const seen: Array<boolean | undefined> = []
  const w = await reportWorld({
    async before(ctx) {
      await ctx.plugin({
        name: 'sibling',
        apply(own: Context) {
          own.on('agent/turn-stopping', ({ agent }) => { seen.push((own.get('dishCrew') as DishCrew | undefined)?.reportSteered(String(agent.id))) })
        },
      } as never, undefined as never)
    },
  })
  try {
    await w.crew().records.addChild('main-1', crewChild('c1'))
    const coder = w.scopes.child('c1')
    await w.created(coder)
    w.turnStarts(coder, 1)
    w.says(coder, 1)
    await w.stop(coder)
    assert.deepEqual(seen, [true])
    assert.equal(coder.steers.length, 1)
    assert.equal(coder.steers[0]!.content.map(block => block.type === 'text' ? block.text : '').join(''), reportSteerText('coder', 1, 2))
    assert.deepEqual(coder.steers[0]!.source, { kind: 'dish-crew', form: 'notice', summary: 'Asked to finish with report (1 of 2)' })

    // It goes on, and finishes with report.
    w.says(coder, 1, 2)
    assert.equal(w.crew().reportSteered('c1'), false, 'the next assistant message clears it')
    const result = await w.call(coder, 'report', { status: 'done', summary: 'Added the form.', commits: [HEAD] })
    assert.equal(result.isError, false)
    assert.equal(result.concludesTurn, true)
    await w.stop(coder)
    assert.deepEqual(seen, [true, false])
    assert.equal(coder.steers.length, 1, 'not steered after a concluding report')
    assert.deepEqual(w.logs, [])
  } finally {
    await w.dispose()
  }
})

test('reportSteers: 0 turns the steer off, and report stays', async () => {
  const w = await reportWorld({ config: { reportSteers: 0 } })
  try {
    await w.crew().records.addChild('main-1', crewChild('c1'))
    const coder = w.scopes.child('c1')
    await w.created(coder)
    w.says(coder, 1)
    await w.stop(coder)
    assert.equal(coder.steers.length, 0)
    assert.equal(w.crew().reportSteered('c1'), false)
    assert.ok(reportOf(w, coder))
  } finally {
    await w.dispose()
  }
})

test('through the record: a coder\'s report, then its subagent/end, leaves the run\'s structured report and its .json', async () => {
  const w = await reportWorld()
  try {
    await w.crew().records.addChild('main-1', crewChild('c1'))
    const coder = w.scopes.child('c1')
    await w.created(coder)
    w.turnStarts(coder, 1)
    w.says(coder, 1)
    const result = await w.call(coder, 'report', { status: 'done', summary: 'Added the form.', commits: [HEAD], concerns: [] })
    assert.equal(result.isError, false)
    assert.deepEqual(result.content, [{ type: 'text', text: 'Report recorded: done.' }])
    ended(w.ctx, 'c1', 'completed', [{ type: 'tool-call', id: 't1', name: 'report' }])
    const recorded = await w.crew().whenRecorded('c1')
    const structured = recorded!.run.structured as CoderReport
    assert.deepEqual({ ...structured, at: 0 }, { role: 'coder', turn: 1, at: 0, status: 'done', summary: 'Added the form.', commits: [HEAD] })
    assert.equal(recorded!.run.structuredFile, sessionPath(w.where, 'main-1', '1-coder-1.json'))
    assert.deepEqual(JSON.parse(await readFile(recorded!.run.structuredFile!, 'utf8')), structured)
    assert.equal((await w.crew().records.lookup('c1'))!.record.report, undefined)
  } finally {
    await w.dispose()
  }
})

test('a report the record can\'t file (setReport gives undefined): crew stops sending that child back to call report, and the guard goes back to today\'s words', async () => {
  const w = await reportWorld()
  try {
    registerSendMessage(w)
    await w.crew().records.addChild('main-1', crewChild('c1'))
    const coder = w.scopes.child('c1')
    await w.created(coder)
    w.turnStarts(coder, 1)
    w.says(coder, 1)
    ;(w.crew().records as unknown as { setReport: () => Promise<undefined> }).setReport = async () => undefined
    const failed = await w.call(coder, 'report', { status: 'done', summary: 'Added the form.' })
    assert.equal(failed.isError, true)
    assert.equal(resultText(failed), NOT_RECORDED)
    // It does as it was told, and ends its turn with its report as text: that stop isn't sent back.
    w.says(coder, 1, 2)
    await w.stop(coder)
    assert.equal(coder.steers.length, 0)
    assert.equal(w.crew().reportSteered('c1'), false)
    // The guard's words are today's: there is no report for it to point to.
    const long = await w.call(coder, 'send_message', { agent_id: 'main-1', message: 'r'.repeat(5000) })
    assert.match(resultText(long), /^Error: Not sent: this is your result, and in this crew your closing message is your report\. /)
    assert.match(resultText(await w.call(coder, 'send_message', { agent_id: 'main-1', message: 'hi' })), /Put everything for the main agent in your closing message, and finish\.$/)
    // The tool is still there, and still says why it can't record.
    assert.ok(reportOf(w, coder))
    assert.deepEqual(w.logs, [])
  } finally {
    await w.dispose()
  }
})

test('a record that lost the child (its children.json set aside as corrupt): its report fails as above, and a later text stop isn\'t steered', async () => {
  const w = await reportWorld()
  try {
    await w.crew().records.addChild('main-1', crewChild('c1'))
    const coder = w.scopes.child('c1')
    await w.created(coder)
    w.turnStarts(coder, 1)
    w.says(coder, 1)
    await w.crew().records.flush()
    await writeFile(sessionPath(w.where, 'main-1', 'children.json'), 'not json\n')
    const failed = await w.call(coder, 'report', { status: 'done', summary: 'Added the form.' })
    assert.equal(resultText(failed), NOT_RECORDED)
    w.says(coder, 1, 2)
    await w.stop(coder)
    assert.equal(coder.steers.length, 0)
    assert.equal(w.logs.length, 1)
    assert.match(w.logs[0]!, /^\[dish-crew\] warn: the record of session \S+ is not valid; it was moved to /, 'the only warning is the record\'s own')
  } finally {
    await w.dispose()
  }
})

test('the report guard through the host: a coder that has report reads the words for report; a researcher child reads today\'s', async () => {
  const w = await reportWorld()
  try {
    registerSendMessage(w)
    await w.crew().records.addChild('main-1', crewChild('c1'))
    await w.crew().records.addChild('main-1', crewChild('x1', { role: 'researcher' }))
    const coder = w.scopes.child('c1')
    const researcher = w.scopes.child('x1')
    await w.created(coder)
    await w.created(researcher)
    const long = 'r'.repeat(5000)
    const fromCoder = await w.call(coder, 'send_message', { agent_id: 'main-1', message: long })
    assert.equal(fromCoder.isError, true)
    assert.match(resultText(fromCoder), /^Error: Not sent: this is your result, and in this crew you report with `report`\. /)
    assert.match(resultText(await w.call(coder, 'send_message', { agent_id: 'main-1', message: 'hi' })), /Put everything for the main agent in your `report`, and finish\.$/)
    const fromResearcher = await w.call(researcher, 'send_message', { agent_id: 'main-1', message: long })
    assert.match(resultText(fromResearcher), /^Error: Not sent: this is your result, and in this crew your closing message is your report\. /)
  } finally {
    await w.dispose()
  }
})

test('the report listeners take odd payloads without a throw, and an odd agent/created doesn\'t fail', async () => {
  const w = await reportWorld()
  const serial = (name: string, payload: unknown) => (w.ctx as unknown as { serial(name: string, payload: unknown): Promise<unknown> }).serial(name, payload)
  const emit = (name: string, ...args: unknown[]) => { (w.ctx as unknown as { emit(name: string, ...args: unknown[]): void }).emit(name, ...args) }
  try {
    const odd: unknown[] = [undefined, null, 5, 'text', {}, { agent: null }, { agent: {} }, { agent: { id: 5 } }, { agent: { id: 'x', session: 5 } }]
    for (const payload of odd) {
      await serial('agent/created', payload)
      assert.doesNotThrow(() => { w.ctx.emit('agent/disposed', payload as never) }, JSON.stringify(payload))
      assert.doesNotThrow(() => { emit('session/event', payload, payload) }, JSON.stringify(payload))
      assert.doesNotThrow(() => { emit('tools/result', payload, payload) }, JSON.stringify(payload))
      await serial('agent/turn-stopping', payload)
    }
    assert.deepEqual(w.logs, [])
  } finally {
    await w.dispose()
  }
})
