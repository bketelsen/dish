import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubagentRunEndInfo, SubagentRunInfo } from '@deepseek-ai/dsh-subagent'
import type { DishConfigService } from 'dish-config'
import * as plugin from '../src/index.ts'
import type { DishCrew } from '../src/index.ts'
import { CrewRecords } from '../src/record.ts'
import type { NewChild, RunEnd } from '../src/record.ts'
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
  assert.deepEqual(Object.keys(service), ['settings', 'records', 'whenRecorded', 'subagentProvider'])
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

test('the configuration has dataDirectory, subagentProvider (spawn), messageLimit (1200) and terminal, and nothing of the spike', () => {
  const config = plugin.Config({} as plugin.Config)
  assert.deepEqual({ ...config }, { dataDirectory: '', subagentProvider: 'spawn', messageLimit: 1200, terminal: true })
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
    assert.deepEqual(recorded, { report })
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
    assert.deepEqual(await pending, { report: sessionPath(where, 's1', '1-coder-1.md') })
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
