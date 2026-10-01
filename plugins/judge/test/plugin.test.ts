import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import type { DishConfigService, NamespaceSpec } from 'dish-config'
import { xdgPaths } from 'dish-kit'
import * as plugin from '../src/index.ts'
import type { DishJudge } from '../src/index.ts'
import { DEFAULT_SETTINGS, DEFAULT_TEXT, parseSettings } from '../src/settings.ts'
import {
  captureStderr, dirs, mountConfig, mountJudge, provideStub, seeded, shippedWith, tempDir, watchLogs, withEnv,
} from './helpers.ts'
import type { Dirs } from './helpers.ts'

const AGENT = { kind: 'agent', sessionId: 's1', role: 'main' } as const
const USER = { kind: 'user' } as const

/** Mount dish-config and dish-judge on `where` in `ctx`, wait for `judge.yaml`, and return what unmounts them. */
async function start(ctx: Context, where: Dirs): Promise<() => Promise<void>> {
  const config = mountConfig(ctx, where.repository)
  await config
  const judge = mountJudge(ctx, where.state)
  await judge
  await seeded(ctx.dishConfig)
  return async () => {
    await judge.dispose()
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
function readerOf(answer: () => Promise<string | undefined>, more: Partial<DishConfigService> = {}): DishConfigService {
  return {
    claim: () => () => {},
    seed: () => Promise.resolve(undefined),
    read: answer,
    ...more,
  } as unknown as DishConfigService
}

/** The logged lines about judge.yaml: what the plugin said, once per distinct problem. */
function judgeLines(logs: string[]): string[] {
  return logs.filter(line => line.startsWith('[dish-judge] warn:'))
}

// --- the service ----------------------------------------------------------------------------------

test('dishJudge is provided when the plugin loads, with settings(), and goes when it does', async () => {
  const where = await dirs()
  const ctx = new Context()
  assert.equal(ctx.get('dishJudge'), undefined)
  const handle = mountJudge(ctx, where.state)
  await handle
  const service: DishJudge = ctx.dishJudge
  assert.deepEqual(Object.keys(service), ['settings'])
  await handle.dispose()
  assert.equal(ctx.get('dishJudge'), undefined)
})

test('the plugin is named dish-judge', () => {
  assert.equal(plugin.name, 'dish-judge')
})

// --- the configuration ----------------------------------------------------------------------------

test('the configuration has baseUrl, keyName, stateDirectory and terminal, with the spec\'s defaults', () => {
  const config = plugin.Config({} as plugin.Config)
  assert.deepEqual({ ...config }, { baseUrl: 'https://api.typesafe.ai', keyName: 'TYPESAFE_API_KEY', stateDirectory: '', terminal: true })
})

test('baseUrl is an http or https address with no credentials, query or fragment, and its trailing slashes are dropped', () => {
  assert.equal(plugin.baseUrlOf(undefined), 'https://api.typesafe.ai')
  assert.equal(plugin.baseUrlOf('https://api.typesafe.ai'), 'https://api.typesafe.ai')
  assert.equal(plugin.baseUrlOf('https://example.test/'), 'https://example.test')
  assert.equal(plugin.baseUrlOf('http://127.0.0.1:8080//'), 'http://127.0.0.1:8080')
  assert.equal(plugin.baseUrlOf('https://example.test/prefix/'), 'https://example.test/prefix')
  for (const bad of ['api.typesafe.ai', 'ftp://example.test', 'file:///etc/passwd', 'not a url', '//example.test', 'https://example.test/?x=1', 'https://example.test/#top']) {
    assert.throws(() => plugin.baseUrlOf(bad), /^Error: baseUrl must be an http or https address/, bad)
  }
})

test('a baseUrl with a password in it is refused without repeating the password', () => {
  assert.throws(() => plugin.baseUrlOf('https://user:hunter2@example.test'), (error: Error) => {
    assert.match(error.message, /baseUrl must not have a username or password in it/)
    assert.doesNotMatch(error.message, /hunter2/)
    return true
  })
  assert.throws(() => plugin.baseUrlOf('https://hunter2@example.test'), (error: Error) => !/hunter2/.test(error.message))
})

test('keyName is an environment variable name, and a blank one is the default', () => {
  assert.equal(plugin.keyNameOf(undefined), 'TYPESAFE_API_KEY')
  assert.equal(plugin.keyNameOf('MY_JEV_KEY'), 'MY_JEV_KEY')
  assert.equal(plugin.keyNameOf('_x9'), '_x9')
  for (const bad of ['my key', '1KEY', 'KEY-NAME', 'KEY=1', '$KEY']) {
    assert.throws(() => plugin.keyNameOf(bad), /^Error: keyName must be an environment variable name/, bad)
  }
})

test('stateDirectory defaults to the XDG state directory for dish, and takes ~/ and absolute paths', async () => {
  const root = await tempDir()
  await withEnv({ XDG_STATE_HOME: join(root, 'xdg') }, async () => {
    assert.equal(plugin.stateDirectoryPath(undefined), join(root, 'xdg', 'dish', 'judge'))
    assert.equal(plugin.stateDirectoryPath(undefined), join(xdgPaths('dish').state, 'judge'))
  })
  assert.equal(plugin.stateDirectoryPath('~'), homedir())
  assert.equal(plugin.stateDirectoryPath('~/judge-state'), join(homedir(), 'judge-state'))
  assert.equal(plugin.stateDirectoryPath(join(root, 'abs')), join(root, 'abs'))
  assert.throws(() => plugin.stateDirectoryPath('relative/dir'), /stateDirectory must be an absolute path \(or start with ~\/\)/)
  assert.throws(() => plugin.stateDirectoryPath('~other/dir'), /stateDirectory must be an absolute path/)
})

test('blank settings are the defaults, and a bad one fails the plugin to load, with nothing provided', async () => {
  const root = await tempDir()
  const blanks: Array<Partial<plugin.Config>> = [{ baseUrl: '  ' }, { keyName: '' }, { stateDirectory: '   ' }, { baseUrl: ' https://example.test/ ', keyName: ' K ' }]
  // A blank stateDirectory is the XDG state directory, which is somewhere in the temp directory here.
  await withEnv({ XDG_STATE_HOME: join(root, 'xdg') }, async () => {
    for (const blank of blanks) {
      const ctx = new Context()
      const handle = ctx.plugin(plugin, { terminal: false, stateDirectory: join(root, 'state'), ...blank } as plugin.Config)
      try {
        await handle
        assert.ok(ctx.get('dishJudge'), JSON.stringify(blank))
      } finally {
        await handle.dispose()
      }
    }
  })
  for (const [bad, message] of [
    [{ baseUrl: 'ftp://example.test' }, /baseUrl must be an http or https address/],
    [{ keyName: 'not a name' }, /keyName must be an environment variable name/],
    [{ stateDirectory: 'relative/dir' }, /stateDirectory must be an absolute path/],
  ] as const) {
    const ctx = new Context()
    const handle = ctx.plugin(plugin, { terminal: false, stateDirectory: join(root, 'state'), ...bad } as plugin.Config)
    await assert.rejects(async () => { await handle }, message)
    assert.equal(ctx.get('dishJudge'), undefined)
    await handle.dispose()
  }
})

// --- with the store -------------------------------------------------------------------------------

test('with the store there, judge.yaml is seeded as the shipped default; a second start rewrites nothing', async () => {
  const where = await dirs()
  const first = await (async () => {
    const ctx = new Context()
    const stop = await start(ctx, where)
    try {
      const store = ctx.dishConfig
      assert.equal(await store.read('judge.yaml'), DEFAULT_TEXT)
      const commits = await store.history({ path: 'judge.yaml' })
      assert.equal(commits.length, 1)
      assert.deepEqual(commits[0]!.author, { kind: 'system' })
      assert.match(commits[0]!.message, /dish-judge defaults/)
      assert.deepEqual(commits[0]!.paths, ['judge.yaml'])
      return { head: await store.head(), commit: commits[0]!.id }
    } finally {
      await stop()
    }
  })()
  await withBoth(where, async (ctx) => {
    const store = ctx.dishConfig
    assert.equal(await store.head(), first.head)
    assert.deepEqual((await store.history({ path: 'judge.yaml' })).map(commit => commit.id), [first.commit])
  })
})

test('settings() is the file in the store, parsed, and a person\'s edit shows at once and survives a restart', async () => {
  const where = await dirs()
  const edited = shippedWith((d) => { d.timeoutMs = 3500; d.commands.readOnly = 0.8 })
  await withBoth(where, async (ctx) => {
    assert.deepEqual(await ctx.dishJudge.settings(), DEFAULT_SETTINGS)
    assert.ok(await ctx.dishConfig.write([{ path: 'judge.yaml', text: edited }], { author: USER }))
    const settings = await ctx.dishJudge.settings()
    assert.equal(settings.timeoutMs, 3500)
    assert.equal(settings.commands.readOnly, 0.8)
    const parsed = parseSettings(edited)
    assert.ok(parsed.ok)
    assert.deepEqual(settings, parsed.settings)
  })
  await withBoth(where, async (ctx) => {
    assert.equal(await ctx.dishConfig.read('judge.yaml'), edited)
    assert.equal((await ctx.dishJudge.settings()).timeoutMs, 3500)
  })
})

test('the policy of the namespace holds through dishConfig: a person\'s broken file is INVALID and changes nothing', async () => {
  await withBoth(await dirs(), async (ctx) => {
    const store = ctx.dishConfig
    await assert.rejects(
      store.write([{ path: 'judge.yaml', text: shippedWith((d) => { d.screening.warn = 0.95 }) }], { author: USER }),
      { code: 'INVALID', message: /^judge\.yaml: screening\.warn: 0\.95 is more than screening\.withhold \(0\.9\)$/ })
    await assert.rejects(store.write([{ path: 'judge.yaml', text: 'tools: [' }], { author: USER }), { code: 'INVALID' })
    await assert.rejects(store.write([{ path: 'judge.yaml', text: 'model: !!js/function "function () {}"\n' }], { author: USER }), { code: 'INVALID' })
    await assert.rejects(
      store.write([{ path: 'judge.yaml', text: shippedWith((d) => { d.speed = 1 }) }], { author: USER }),
      { code: 'INVALID', message: /^judge\.yaml: speed: unknown key \(allowed: model, timeoutMs, commands, screening, tools\)$/ })
    // The store puts the path in front of what the namespace says, so what it says doesn't name the file again.
    await assert.rejects(
      store.write([{ path: 'judge.yaml', text: '' }], { author: USER }),
      (error: Error) => /^judge\.yaml: the file is empty; it needs /.test(error.message) && (error as { code?: string }).code === 'INVALID')
    await assert.rejects(
      store.write([{ path: 'judge.yaml', text: 'tools: [' }], { author: USER }),
      (error: Error) => /^judge\.yaml: not valid YAML \(line \d+, column \d+\): /.test(error.message))
    assert.equal(await store.read('judge.yaml'), DEFAULT_TEXT)
    assert.equal((await store.history({ path: 'judge.yaml' })).length, 1)
  })
})

test('an agent can not write judge.yaml, whatever it holds, and the file stays as it was', async () => {
  await withBoth(await dirs(), async (ctx) => {
    const store = ctx.dishConfig
    const valid = shippedWith((d) => { d.timeoutMs = 9000 })
    await assert.rejects(store.write([{ path: 'judge.yaml', text: valid }], { author: AGENT }), { code: 'FORBIDDEN' })
    await assert.rejects(store.write([{ path: 'judge.yaml', delete: true }], { author: AGENT }), { code: 'FORBIDDEN' })
    await assert.rejects(store.propose([{ path: 'judge.yaml', text: valid }], { author: AGENT, title: 'Slower', rationale: 'Because.' } as never), { code: 'FORBIDDEN' })
    assert.equal(await store.read('judge.yaml'), DEFAULT_TEXT)
    assert.equal((await ctx.dishJudge.settings()).timeoutMs, 2000)
    assert.equal((await store.history({ path: 'judge.yaml' })).length, 1)
  })
})

/** A context with a real tool registry: dsh's `ToolRuntime`, with a stub of the system prompt it needs, as a sibling. */
async function withTools(): Promise<Context> {
  const ctx = new Context()
  await provideStub(ctx, 'systemPrompt', { tools() {}, section() {}, getSectionOrder: () => 1 })
  await ctx.plugin(ToolRuntime, {})
  return ctx
}

type Result = { isError: boolean, content: Array<{ type: string, text?: string }>, value?: unknown }

/** One call of a tool through the registry, as the main agent of session `sess-main` makes it. */
function call(ctx: Context, name: string, args: unknown): Promise<Result> {
  const agent = { id: 'sess-main', session: { header: { id: 'sess-main', delegationDepth: 0 } } }
  return ctx.tools.execute({ callId: `call-${name}` as never, name, arguments: args, agent: agent as never, signal: new AbortController().signal }) as unknown as Promise<Result>
}

const textOf = (result: Result): string => result.content.map(block => block.type === 'text' ? block.text ?? '' : '').join('\n')

test('through dish-config\'s agent tools an agent can not read, list, write or propose judge.yaml, and the file is not even listed', async () => {
  const ctx = await withTools()
  const where = await dirs()
  const config = mountConfig(ctx, where.repository)
  await config
  const judge = mountJudge(ctx, where.state)
  await judge
  try {
    const store = ctx.dishConfig
    await seeded(store)
    // A namespace that agents may use, to show the tools work and what a listing looks like when it has something in it.
    const open: NamespaceSpec = { prefix: 't/', owner: 'test', agent: 'write', validate: () => undefined }
    ctx.effect(() => store.claim(open))
    await store.write([{ path: 't/a.md', text: 'hello' }], { author: USER })
    assert.equal((await call(ctx, 'config_read', { path: 't/a.md' })).isError, false)

    const read = await call(ctx, 'config_read', { path: 'judge.yaml' })
    assert.equal(read.isError, true)
    assert.match(textOf(read), /FORBIDDEN/)
    assert.doesNotMatch(textOf(read), /jev-1\.13\.0|timeoutMs/)

    const everything = await call(ctx, 'config_list', { prefix: '' })
    assert.equal(everything.isError, false)
    const everyPath = (everything.value as { paths: string[] }).paths
    assert.ok(everyPath.includes('t/a.md'), everyPath.join(', '))
    assert.ok(!everyPath.includes('judge.yaml'), everyPath.join(', '))
    assert.doesNotMatch(textOf(everything), /judge\.yaml/)
    const exact = await call(ctx, 'config_list', { prefix: 'judge.yaml' })
    assert.equal(exact.isError, false)
    assert.deepEqual((exact.value as { paths: string[] }).paths, [])

    const valid = shippedWith((d) => { d.timeoutMs = 9000 })
    const write = await call(ctx, 'config_write', { changes: [{ path: 'judge.yaml', text: valid }], note: '', base: '' })
    assert.equal(write.isError, true)
    assert.match(textOf(write), /FORBIDDEN/)
    const remove = await call(ctx, 'config_write', { changes: [{ path: 'judge.yaml', text: '', delete: true }], note: '', base: '' })
    assert.equal(remove.isError, true)
    assert.match(textOf(remove), /FORBIDDEN/)
    const propose = await call(ctx, 'config_propose', { title: 'Slower', rationale: 'Because.', changes: [{ path: 'judge.yaml', text: valid }] })
    assert.equal(propose.isError, true)
    assert.match(textOf(propose), /FORBIDDEN/)

    // Nothing changed, and nothing was proposed.
    assert.equal(await store.read('judge.yaml'), DEFAULT_TEXT)
    assert.equal((await store.history({ path: 'judge.yaml' })).length, 1)
    assert.deepEqual(await store.proposals('open'), [])
    assert.equal((await ctx.dishJudge.settings()).timeoutMs, 2000)
  } finally {
    await judge.dispose()
    await config.dispose()
  }
})

test('the claim goes with the plugin: judge.yaml is unowned once dish-judge unloads', async () => {
  const where = await dirs()
  const ctx = new Context()
  const config = mountConfig(ctx, where.repository)
  await config
  const judge = mountJudge(ctx, where.state)
  await judge
  await seeded(ctx.dishConfig)
  await judge.dispose()
  try {
    await assert.rejects(ctx.dishConfig.write([{ path: 'judge.yaml', text: DEFAULT_TEXT }], { author: USER }), { code: 'UNOWNED' })
  } finally {
    await config.dispose()
  }
})

test('a claim that is refused is logged, and settings() still answers', async () => {
  const where = await dirs()
  const ctx = new Context()
  const logs = watchLogs(ctx)
  const config = mountConfig(ctx, where.repository)
  await config
  ctx.effect(() => ctx.dishConfig.claim({ prefix: 'judge.yaml', owner: 'someone-else', agent: 'write', validate: () => undefined }))
  const judge = mountJudge(ctx, where.state)
  try {
    await judge
    await new Promise(resolve => setImmediate(resolve))
    const lines = judgeLines(logs)
    assert.equal(lines.length, 1, logs.join('\n'))
    assert.match(lines[0]!, /could not claim judge\.yaml: /)
    assert.equal(await ctx.dishConfig.read('judge.yaml'), undefined)
    assert.equal(await ctx.dishJudge.settings(), DEFAULT_SETTINGS)
  } finally {
    await judge.dispose()
    await config.dispose()
  }
})

test('a seed that fails is logged, and the plugin works all the same', async () => {
  const ctx = new Context()
  const logs = watchLogs(ctx)
  await provideStub(ctx, 'dishConfig', readerOf(() => Promise.resolve(undefined), { seed: () => Promise.reject(new Error('disk full')) }))
  const judge = mountJudge(ctx, (await dirs()).state)
  try {
    await judge
    await new Promise(resolve => setTimeout(resolve, 20))
    const lines = judgeLines(logs)
    assert.ok(lines.some(line => /could not seed judge\.yaml: disk full/.test(line)), logs.join('\n'))
    assert.equal(await ctx.dishJudge.settings(), DEFAULT_SETTINGS)
  } finally {
    await judge.dispose()
  }
})

// --- without the store, or with a bad file --------------------------------------------------------

test('with no store, settings() is the shipped default, and the absence is logged once', async () => {
  const ctx = new Context()
  const logs = watchLogs(ctx)
  const handle = mountJudge(ctx, (await dirs()).state)
  try {
    await handle
    for (let call = 0; call < 4; call++) assert.equal(await ctx.dishJudge.settings(), DEFAULT_SETTINGS)
    const lines = judgeLines(logs)
    assert.equal(lines.length, 1, logs.join('\n'))
    assert.match(lines[0]!, /dish-config is not running; using the shipped judge\.yaml/)
  } finally {
    await handle.dispose()
  }
})

test('the store comes and goes: the file while it is there, the default when it is not', async () => {
  const where = await dirs()
  const ctx = new Context()
  const handle = mountJudge(ctx, where.state)
  try {
    await handle
    assert.equal(await ctx.dishJudge.settings(), DEFAULT_SETTINGS)
    const config = mountConfig(ctx, where.repository)
    await config
    await seeded(ctx.dishConfig)
    await ctx.dishConfig.write([{ path: 'judge.yaml', text: shippedWith((d) => { d.timeoutMs = 3000 }) }], { author: USER })
    assert.equal((await ctx.dishJudge.settings()).timeoutMs, 3000)
    await config.dispose()
    assert.equal(ctx.get('dishConfig'), undefined)
    assert.equal(await ctx.dishJudge.settings(), DEFAULT_SETTINGS)
  } finally {
    await handle.dispose()
  }
})

test('a store that is a sibling plugin of this one is found by ctx.get, with a file in it or without', async () => {
  const ctx = new Context()
  const logs = watchLogs(ctx)
  let stored: string | undefined = shippedWith((d) => { d.timeoutMs = 4000 })
  const stub = await provideStub(ctx, 'dishConfig', readerOf(() => Promise.resolve(stored)))
  const handle = mountJudge(ctx, (await dirs()).state)
  try {
    await handle
    assert.equal((await ctx.dishJudge.settings()).timeoutMs, 4000)
    assert.deepEqual(judgeLines(logs), [])
    stored = undefined
    for (let call = 0; call < 3; call++) assert.equal(await ctx.dishJudge.settings(), DEFAULT_SETTINGS)
    assert.equal(judgeLines(logs).length, 1, logs.join('\n'))
    assert.match(judgeLines(logs)[0]!, /judge\.yaml is not in the config store; using the shipped default/)
  } finally {
    await handle.dispose()
    await stub.dispose()
  }
})

test('a store whose judge.yaml is not valid gives the default, with one warning that names the problem', async () => {
  const ctx = new Context()
  const logs = watchLogs(ctx)
  const bad = shippedWith((d) => { d.screening.warn = 0.95 })
  await provideStub(ctx, 'dishConfig', readerOf(() => Promise.resolve(bad)))
  const handle = mountJudge(ctx, (await dirs()).state)
  try {
    await handle
    for (let call = 0; call < 3; call++) assert.equal(await ctx.dishJudge.settings(), DEFAULT_SETTINGS)
    const lines = judgeLines(logs)
    assert.equal(lines.length, 1, logs.join('\n'))
    assert.match(lines[0]!, /judge\.yaml in the config store is not valid, so the shipped default is used: screening\.warn: 0\.95 is more than screening\.withhold \(0\.9\)/)
  } finally {
    await handle.dispose()
  }
})

test('a store that can not be read gives the default, once per distinct error, and never throws', async () => {
  const ctx = new Context()
  const logs = watchLogs(ctx)
  let failure: unknown = new Error('git is broken')
  await provideStub(ctx, 'dishConfig', readerOf(() => Promise.reject(failure)))
  const handle = mountJudge(ctx, (await dirs()).state)
  try {
    await handle
    for (let call = 0; call < 3; call++) assert.equal(await ctx.dishJudge.settings(), DEFAULT_SETTINGS)
    assert.equal(judgeLines(logs).length, 1, logs.join('\n'))
    assert.match(judgeLines(logs)[0]!, /could not read judge\.yaml from the config store \(git is broken\); using the shipped default/)
    // Another problem is another message.
    failure = new Error('disk is full')
    assert.equal(await ctx.dishJudge.settings(), DEFAULT_SETTINGS)
    assert.equal(judgeLines(logs).length, 2, logs.join('\n'))
    assert.match(judgeLines(logs)[1]!, /disk is full/)
    // Even a failure that is not an Error.
    failure = 'plain text'
    assert.equal(await ctx.dishJudge.settings(), DEFAULT_SETTINGS)
    assert.match(judgeLines(logs)[2]!, /plain text/)
  } finally {
    await handle.dispose()
  }
})

test('a store that throws instead of rejecting still gives the default', async () => {
  const ctx = new Context()
  await provideStub(ctx, 'dishConfig', { claim: () => () => {}, seed: () => Promise.resolve(undefined), read: () => { throw new Error('sync failure') } })
  const handle = mountJudge(ctx, (await dirs()).state)
  try {
    await handle
    assert.equal(await ctx.dishJudge.settings(), DEFAULT_SETTINGS)
  } finally {
    await handle.dispose()
  }
})

// --- logging --------------------------------------------------------------------------------------

test('with terminal on, the plugin prints its own messages to stderr as dish-judge; with it off, it prints nothing', async () => {
  for (const terminal of [true, false]) {
    const ctx = new Context()
    const capture = captureStderr()
    try {
      const handle = mountJudge(ctx, (await dirs()).state, { terminal })
      try {
        await handle
        await ctx.dishJudge.settings()
      } finally {
        await handle.dispose()
      }
    } finally {
      capture.restore()
    }
    const lines = capture.lines().filter(line => line.includes('judge.yaml'))
    if (terminal) {
      assert.equal(lines.length, 1, lines.join('\n'))
      assert.match(lines[0]!, /^\[dish-judge\] warn: dish-config is not running; using the shipped judge\.yaml$/)
    } else {
      assert.deepEqual(lines, [])
    }
  }
})
