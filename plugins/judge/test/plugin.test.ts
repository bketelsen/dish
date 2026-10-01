import { existsSync, statSync } from 'node:fs'
import { chmod, mkdir, readdir, readFile, utimes, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import type { DishConfigService, NamespaceSpec } from 'dish-config'
import { maskSecrets, secretKind, xdgPaths } from 'dish-kit'
import type { Answer, LogLine, Purpose } from '../src/client.ts'
import * as plugin from '../src/index.ts'
import type { DishJudge } from '../src/index.ts'
import type { JudgeLogLine, JudgePurpose } from '../src/log.ts'
import { DEFAULT_SETTINGS, DEFAULT_TEXT, parseSettings } from '../src/settings.ts'
import {
  captureStderr, choiceAnswer, dirs, jevBody, mountConfig, mountJudge, noulAnswer, provideStub, seeded, shippedWith, startFakeJev, tempDir, waitFor, watchLogs, withEnv,
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
  assert.deepEqual(Object.keys(service), ['settings', 'log'])
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

test('http is for this machine only: the key is sent to baseUrl, so anywhere else it has to be https', () => {
  for (const good of ['http://localhost', 'http://localhost:8080', 'http://LOCALHOST:8080/', 'http://127.0.0.1', 'http://127.0.0.1:9/prefix', 'http://[::1]', 'http://[::1]:8080/', 'http://[0:0:0:0:0:0:0:1]:8080', 'https://example.test', 'https://localhost:8443', 'HTTPS://EXAMPLE.TEST']) {
    assert.equal(plugin.baseUrlOf(good), good.replace(/\/+$/, ''), good)
  }
  for (const bad of ['http://example.test', 'http://api.typesafe.ai', 'http://api.typesafe.ai:80/', 'http://127.0.0.2', 'http://127.0.0.1.example.test', 'http://localhost.example.test', 'http://localhost.', 'http://0.0.0.0', 'http://[::]', 'http://[::ffff:127.0.0.1]', 'http://10.0.0.5:8080', 'http://192.168.1.10', 'http://[fe80::1]', 'HTTP://EXAMPLE.TEST']) {
    assert.throws(() => plugin.baseUrlOf(bad), (error: Error) => {
      assert.equal(error.message, 'baseUrl must use https, because the key is sent to it: http is allowed only for localhost, 127.0.0.1 and [::1]', bad)
      return true
    }, bad)
  }
})

test('a baseUrl that already ends in the path of the call is refused, because the client adds that path itself', () => {
  for (const bad of ['https://api.typesafe.ai/v1/systemone', 'https://api.typesafe.ai/v1/systemone/', 'https://api.typesafe.ai/v1/systemone//', 'https://example.test/prefix/v1/systemone', 'http://127.0.0.1:8080/v1/systemone']) {
    assert.throws(() => plugin.baseUrlOf(bad), (error: Error) => {
      assert.equal(error.message, 'baseUrl must not end with /v1/systemone: it is the address of the API, and the judge adds that path itself', bad)
      return true
    }, bad)
  }
  // Only at the end: a path that goes on, or is only like it, is a prefix of some proxy and is left alone.
  assert.equal(plugin.baseUrlOf('https://example.test/v1/systemone/proxy'), 'https://example.test/v1/systemone/proxy')
  assert.equal(plugin.baseUrlOf('https://example.test/v1/systemones'), 'https://example.test/v1/systemones')
  assert.equal(plugin.baseUrlOf('https://example.test/v1'), 'https://example.test/v1')
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

test('a stateDirectory that is refused is shown with any secret in it masked, and cut short', () => {
  const body = 'Zq9XvB2nLp0TaR7uWcE4yKd8MfH1sJgO5iN3'
  for (const setting of [`sk-ant-api03-${body}-AbCd`, `relative/sk-ant-api03-${body}-AbCd`, `ghp_${'A1b2C3d4E5'.repeat(4)}/x`, `${'x'.repeat(100 * 1024)}`]) {
    assert.throws(() => plugin.stateDirectoryPath(setting), (error: Error) => {
      assert.match(error.message, /^stateDirectory must be an absolute path \(or start with ~\/\), got "/)
      assert.doesNotMatch(error.message, new RegExp(`${body.slice(0, 10)}|A1b2C3d4E5`))
      assert.doesNotMatch(error.message, /sk-ant-api03/)
      assert.ok(error.message.length < 250, `${error.message.length}`)
      return true
    })
  }
  assert.throws(() => plugin.stateDirectoryPath(`sk-ant-api03-${body}-AbCd`), /got "‹secret: an sk- API key›"$/)
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
    // The seed is the plugin's own, started when it loaded and not waited for by it: wait for its warning, with a bound.
    await waitFor('the seed warning', () => judgeLines(logs).some(line => /could not seed judge\.yaml: disk full/.test(line)), 5000)
    assert.equal(judgeLines(logs).length, 1, logs.join('\n'))
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

// --- a store that is slow, or never answers ---------------------------------------------------------

/** A logger that keeps what it is told. */
function collector(): { warn(format: string, ...args: unknown[]): void, lines: string[] } {
  const lines: string[] = []
  return { lines, warn: (format, ...args) => { lines.push(format.replace(/%s/g, () => String(args.shift()))) } }
}

/** A store whose reads are answered by `answer`, counting them. */
function countingStore(answer: (call: number) => Promise<string | undefined>): { store: () => { read(path: string): Promise<string | undefined> }, reads: () => number } {
  let reads = 0
  return { store: () => ({ read: () => answer(++reads) }), reads: () => reads }
}

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const wait = <T>() => new Promise<T>(() => {})

test('the read budget is 200 ms', () => {
  assert.equal(plugin.SETTINGS_READ_BUDGET_MS, 200)
})

test('a store that never answers: after the budget settings() gives the shipped default, says so once, and asks the store once', async () => {
  const log = collector()
  const { store, reads } = countingStore(() => wait())
  const settings = plugin.createSettingsReader(store, log, 40)
  const started = performance.now()
  assert.equal(await settings(), DEFAULT_SETTINGS)
  const elapsed = performance.now() - started
  assert.ok(elapsed >= 35 && elapsed < 40 + 150, `took ${elapsed} ms`)
  assert.equal(log.lines.length, 1, log.lines.join('\n'))
  assert.match(log.lines[0]!, /took more than 40 ms; using the shipped default until it answers/)
  // more calls, one at a time and together, join the read that is going: the store is not asked again and again
  assert.equal(await settings(), DEFAULT_SETTINGS)
  await Promise.all([settings(), settings(), settings()])
  assert.equal(reads(), 1)
  assert.equal(log.lines.length, 1, 'said once')
})

test('a store that is slow but within the budget gives what it read, and a later edit shows at once', async () => {
  const log = collector()
  let text = shippedWith((d) => { d.timeoutMs = 3000 })
  const { store, reads } = countingStore(async () => { const now = text; await pause(20); return now })
  const settings = plugin.createSettingsReader(store, log, 500)
  assert.equal((await settings()).timeoutMs, 3000)
  text = shippedWith((d) => { d.timeoutMs = 4000 })
  assert.equal((await settings()).timeoutMs, 4000, 'calls that are one after the other each read the store')
  assert.equal(reads(), 2)
  assert.deepEqual(log.lines, [])
})

test('past the budget the settings last read are used, not the default, and a read that ends late is kept for the next call', async () => {
  const log = collector()
  const texts = [
    shippedWith((d) => { d.timeoutMs = 3000 }),   // read 1: fast
    shippedWith((d) => { d.timeoutMs = 4000 }),   // read 2: ends after the budget
  ]
  const { store, reads } = countingStore(async (call) => {
    if (call === 1) return texts[0]
    if (call === 2) { await pause(120); return texts[1] }
    return wait()                                  // read 3 and on: never
  })
  const settings = plugin.createSettingsReader(store, log, 40)
  assert.equal((await settings()).timeoutMs, 3000)
  // read 2 is slow: the call gets the settings of read 1
  assert.equal((await settings()).timeoutMs, 3000)
  assert.equal(log.lines.length, 1, log.lines.join('\n'))
  assert.match(log.lines[0]!, /took more than 40 ms; using the settings last read until it answers/)
  // it ends, late, and its settings are what the next call gets when the store has stopped answering
  await pause(150)
  assert.equal((await settings()).timeoutMs, 4000)
  assert.equal(reads(), 3)
})

test('with nothing read yet, a read that ends late is the cache too', async () => {
  const log = collector()
  const { store } = countingStore(async (call) => {
    if (call === 1) { await pause(100); return shippedWith((d) => { d.timeoutMs = 5000 }) }
    return wait()
  })
  const settings = plugin.createSettingsReader(store, log, 30)
  assert.equal(await settings(), DEFAULT_SETTINGS)
  await pause(120)
  assert.equal((await settings()).timeoutMs, 5000)
})

test('a read that ends late with a file that is not valid, or an error, does not replace the settings last read', async () => {
  const log = collector()
  const { store } = countingStore(async (call) => {
    if (call === 1) return shippedWith((d) => { d.timeoutMs = 3000 })
    if (call === 2) { await pause(80); return 'tools: [' }
    if (call === 3) { await pause(80); throw new Error('git is broken') }
    return wait()
  })
  const settings = plugin.createSettingsReader(store, log, 30)
  assert.equal((await settings()).timeoutMs, 3000)
  assert.equal((await settings()).timeoutMs, 3000)
  await pause(100)
  assert.equal((await settings()).timeoutMs, 3000)      // read 3, which ends in an error
  await pause(100)
  assert.equal((await settings()).timeoutMs, 3000)      // read 4, which never answers
})

test('while a read is stuck, the calls after the first are answered at once: they do not wait the budget each, and they join nothing', async () => {
  const log = collector()
  const { store, reads } = countingStore(() => wait())
  const settings = plugin.createSettingsReader(store, log, 100)
  const started = performance.now()
  assert.equal(await settings(), DEFAULT_SETTINGS)
  const first = performance.now() - started
  assert.ok(first >= 90 && first < 100 + 150, `the first took ${first} ms`)
  const next = performance.now()
  for (let call = 0; call < 50; call++) assert.equal(await settings(), DEFAULT_SETTINGS)
  const rest = performance.now() - next
  assert.ok(rest < 50, `fifty more took ${rest} ms`)
  assert.equal(reads(), 1)
  assert.equal(log.lines.length, 1, log.lines.join('\n'))
})

test('while a read is stuck, what is attached to it stays bounded, however many calls come', async () => {
  const { store } = countingStore(() => wait())
  const settings = plugin.createSettingsReader(store, collector(), 30)
  await settings()
  // Every `then` there is while the calls are made, on any promise: after the budget, a call makes none.
  const original = Promise.prototype.then
  let thens = 0
  Promise.prototype.then = function counted(this: Promise<unknown>, ...args: Parameters<typeof original>) {
    thens++
    return original.apply(this, args) as never
  } as typeof original
  try {
    for (let call = 0; call < 2000; call++) await settings()
  } finally {
    Promise.prototype.then = original
  }
  assert.ok(thens < 10, `${thens} promises were chained to in 2000 calls`)
})

test('a read that is stuck for ten budgets is tried again, and the old one is let go: its late answer is still kept', async () => {
  assert.equal(plugin.SETTINGS_RETRY_AFTER_BUDGETS, 10)
  const log = collector()
  const { store, reads } = countingStore(async (call) => {
    if (call === 1) { await pause(450); return shippedWith((d) => { d.timeoutMs = 3000 }) }
    return wait()
  })
  const settings = plugin.createSettingsReader(store, log, 30)     // a retry after 300 ms
  assert.equal(await settings(), DEFAULT_SETTINGS)
  assert.equal(reads(), 1)
  await pause(200)
  assert.equal(await settings(), DEFAULT_SETTINGS, 'at 230 ms, which is not ten budgets, it is not tried again')
  assert.equal(reads(), 1)
  await pause(100)
  // At 330 ms, more than ten budgets since the first read began, a new one is made.
  assert.equal(await settings(), DEFAULT_SETTINGS)
  assert.equal(reads(), 2)
  // The first answers, at 450 ms, with a file: its settings are what is used while the second is stuck.
  await pause(150)
  assert.equal((await settings()).timeoutMs, 3000)
  assert.equal(reads(), 2, 'the second, which is not ten budgets old, is not asked again')
})

test('a read that is tried again does not let an old read that ends later put older settings over the newer', async () => {
  const log = collector()
  const { store } = countingStore(async (call) => {
    if (call === 1) { await pause(500); return shippedWith((d) => { d.timeoutMs = 3000 }) }   // stuck, and then stale
    if (call === 2) { await pause(80); return shippedWith((d) => { d.timeoutMs = 4000 }) }    // the retry: slow, but it ends first
    return wait()
  })
  const settings = plugin.createSettingsReader(store, log, 30)
  assert.equal(await settings(), DEFAULT_SETTINGS)
  await pause(320)
  assert.equal(await settings(), DEFAULT_SETTINGS)    // read 2 starts, at 350 ms, and ends at 430
  await pause(200)                                      // read 1 ends at 500, after it
  assert.equal((await settings()).timeoutMs, 4000)     // read 3, which never answers: the last good is read 2's
  await pause(100)
  assert.equal((await settings()).timeoutMs, 4000, 'what read 1 found, late, is older than what read 2 found, and is not kept over it')
})

test('a store that never answers is not asked more than three times at once, however long it goes on', async () => {
  const log = collector()
  const { store, reads } = countingStore(() => wait())
  const settings = plugin.createSettingsReader(store, log, 5)
  const until = performance.now() + 400
  while (performance.now() < until) {
    await settings()
    await pause(5)
  }
  // 400 ms is eight times the 50 ms a retry waits: the first, and the two it was let go of, and no more.
  assert.equal(reads(), 3)
  assert.equal((await settings()), DEFAULT_SETTINGS)
})

test('a stuck read that ends frees its place, so a later one is tried again', async () => {
  const log = collector()
  const answers: Array<() => void> = []
  const { store, reads } = countingStore(() => new Promise<string | undefined>((resolve) => { answers.push(() => resolve(shippedWith((d) => { d.timeoutMs = 3500 }))) }))
  const settings = plugin.createSettingsReader(store, log, 5)
  const until = performance.now() + 250
  while (performance.now() < until) {
    await settings()
    await pause(5)
  }
  assert.equal(reads(), 3)
  for (const answer of answers) answer()
  await new Promise<void>(resolve => setImmediate(resolve))   // for what they found to be read
  assert.equal((await settings()).timeoutMs, 3500)
  assert.equal(reads(), 4, 'they have all ended, so there is a read to make')
})

test('the store going away is the default, not a cache', async () => {
  const log = collector()
  let present = true
  const store = () => present ? { read: async () => shippedWith((d) => { d.timeoutMs = 3000 }) } : undefined
  const settings = plugin.createSettingsReader(store, log, 40)
  assert.equal((await settings()).timeoutMs, 3000)
  present = false
  assert.equal(await settings(), DEFAULT_SETTINGS)
})

test('the plugin gives the shipped default after the read budget when the store never answers, and the store is asked once', async () => {
  const ctx = new Context()
  const logs = watchLogs(ctx)
  let reads = 0
  await provideStub(ctx, 'dishConfig', readerOf(() => { reads++; return wait() }))
  const handle = mountJudge(ctx, (await dirs()).state)
  try {
    await handle
    const started = performance.now()
    assert.equal(await ctx.dishJudge.settings(), DEFAULT_SETTINGS)
    const elapsed = performance.now() - started
    assert.ok(elapsed >= plugin.SETTINGS_READ_BUDGET_MS - 20 && elapsed < plugin.SETTINGS_READ_BUDGET_MS + 250, `took ${elapsed} ms`)
    assert.equal(await ctx.dishJudge.settings(), DEFAULT_SETTINGS)
    assert.equal(reads, 1)
    assert.equal(judgeLines(logs).length, 1, logs.join('\n'))
    assert.match(judgeLines(logs)[0]!, /took more than 200 ms/)
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

// --- the warn-once helper -------------------------------------------------------------------------

test('warnOnce says each message once, passes it on whole, and survives a logger that throws', () => {
  const log = collector()
  const tell = plugin.warnOnce(log)
  tell('a')
  tell('a')
  tell('b')
  tell('a')
  assert.deepEqual(log.lines, ['a', 'b'])
  const tellOnThrow = plugin.warnOnce({ warn: () => { throw new Error('the logger is broken') } })
  assert.doesNotThrow(() => tellOnThrow('x'))
})

test('warnOnce remembers at most 100 distinct messages: past that it forgets the oldest, so memory is bounded and a flood of one-offs can not mute the rest for ever', () => {
  assert.equal(plugin.MAX_TOLD, 100)
  const log = collector()
  const tell = plugin.warnOnce(log)
  for (let i = 0; i < 100; i++) tell(`message ${i}`)
  assert.equal(log.lines.length, 100)
  for (let i = 0; i < 100; i++) tell(`message ${i}`)
  assert.equal(log.lines.length, 100, 'the 100 are all remembered')
  tell('message 100')
  assert.equal(log.lines.length, 101)
  tell('message 0')
  assert.equal(log.lines.length, 102, 'the oldest was forgotten to make room, so it is said again')
  tell('message 0')
  assert.equal(log.lines.length, 102, 'and then it is remembered again')
  tell('message 99')
  tell('message 100')
  assert.equal(log.lines.length, 102, 'the newer ones are still remembered')
  for (let i = 0; i < 10_000; i++) tell(`flood ${i}`)
  assert.equal(log.lines.length, 102 + 10_000)
})

test('a message that is very long is cut before it is remembered or said', () => {
  const log = collector()
  const tell = plugin.warnOnce(log)
  tell('x'.repeat(100_000))
  tell('x'.repeat(100_000))
  assert.equal(log.lines.length, 1)
  assert.ok(log.lines[0]!.length < 2100, `${log.lines[0]!.length}`)
  assert.ok(log.lines[0]!.endsWith('…'))
})

test('the settings reader says what it has to through the helper it is given, and has one of its own if it is given none', async () => {
  const told: string[] = []
  const log = collector()
  const settings = plugin.createSettingsReader(() => undefined, log, 40, message => { told.push(message) })
  await settings()
  await settings()
  assert.deepEqual(told, ['dish-config is not running; using the shipped judge.yaml', 'dish-config is not running; using the shipped judge.yaml'], 'it is the helper that says it once, not the reader')
  assert.deepEqual(log.lines, [])
  const own = collector()
  const alone = plugin.createSettingsReader(() => undefined, own, 40)
  await alone()
  await alone()
  assert.equal(own.lines.length, 1)
})

test('the settings reader and the log share one helper: a store that fails in 150 different ways does not grow what is remembered', async () => {
  const log = collector()
  let n = 0
  const tell = plugin.warnOnce(log)
  const settings = plugin.createSettingsReader(() => ({ read: () => Promise.reject(new Error(`failure ${n++}`)) }), log, 40, tell)
  for (let i = 0; i < 150; i++) await settings()
  assert.equal(log.lines.length, 150)
  tell('could not read judge.yaml from the config store (failure 0); using the shipped default')
  assert.equal(log.lines.length, 151, 'the first of them was forgotten, as the cap says')
  tell('could not read judge.yaml from the config store (failure 149); using the shipped default')
  assert.equal(log.lines.length, 151, 'and the last is remembered')
})

// --- the decision log ------------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000
/** A key as Jev's is not: nothing in dish-kit's secret patterns matches it, and each of its three forms is different. */
const FAKE_KEY = 'fk-Q9x+7/Zr"k\\%Y_dist1nct'
const ASK_AGENT = { id: 'sess-9', session: { header: { delegationDepth: 0 } }, options: {} }
const SERVES = { serves_task: { type: 'noul' as const, instructions: 'Does the command serve the task?' } }

/** `credentials` as a sibling plugin provides it: `resolve` gives what `resolver` says, for any name. */
function credentials(resolver: (name: string) => Promise<{ value: string } | undefined>) {
  return { resolve: resolver }
}

/** Mount dish-judge against a fake Jev that answers as scripted, with `key` as the key in a stub `credentials`. */
async function mountWithJev(where: Dirs, key: string | undefined = FAKE_KEY, config: Partial<plugin.Config> = {}) {
  const ctx = new Context()
  const logs = watchLogs(ctx)
  const jev = await startFakeJev()
  jev.always({ kind: 'answer', body: jevBody({ serves_task: noulAnswer(0.9) }) })
  const stub = await provideStub(ctx, 'credentials', credentials(async () => key === undefined ? undefined : { value: key }))
  const handle = mountJudge(ctx, where.state, { baseUrl: jev.url, ...config })
  await handle
  return { ctx, logs, jev, dispose: async () => { await handle.dispose(); await stub.dispose() } }
}

function logAt(overrides: Partial<JudgeLogLine> = {}): JudgeLogLine {
  return { at: Date.now(), purpose: 'approval', subject: 'git push', answers: {}, decision: 'ask', latencyMs: null, error: null, ...overrides }
}

test('the one line type: the client\'s LogLine is the log\'s JudgeLogLine, with no cast between them', () => {
  type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
  const sameLine: Same<LogLine, JudgeLogLine> = true
  const samePurpose: Same<Purpose, JudgePurpose> = true
  // What the client builds for `answers` is what the log takes: a checked answer is JSON.
  const answers: JudgeLogLine['answers'] = {} as Record<string, Answer>
  assert.equal(sameLine && samePurpose, true)
  assert.deepEqual(answers, {})
})

test('lines from a real ask against the fake Jev are in the state directory, as the spec shows them, and read back', async () => {
  const where = await dirs()
  const { ctx, jev, dispose } = await mountWithJev(where)
  try {
    const judge = ctx.get('judge')!
    const before = Date.now()
    const asked = await judge.ask({
      state: { command: 'ls' }, questions: SERVES, purpose: 'command', agent: ASK_AGENT, tool: 'bash', callId: 'call-1', subject: 'ls -la',
      decide: () => ({ decision: 'allow' }),
    })
    assert.equal(asked.ok, true)
    assert.equal(jev.requests.length, 1)
    jev.always({ kind: 'status', status: 500, body: 'fake Jev: down' })
    await judge.ask({ state: 'x', questions: SERVES, purpose: 'ask', subject: 'ask_judge' })
    // The lines are on their way when the calls return, and not waited for by them.
    await ctx.dishJudge.log.flush()

    const read = await ctx.dishJudge.log.read()
    assert.equal(read.skipped, 0)
    assert.equal(read.lines.length, 2)
    const [failed, answered] = read.lines
    assert.ok(answered!.at >= before && answered!.at <= Date.now())
    assert.deepEqual({ ...answered!, at: 0, latencyMs: typeof answered!.latencyMs }, {
      at: 0, purpose: 'command', agent: 'sess-9', child: false, tool: 'bash', callId: 'call-1', subject: 'ls -la',
      answers: { serves_task: { type: 'noul', noul: 0.9 } }, decision: 'allow', latencyMs: 'number', error: null,
    })
    assert.deepEqual({ ...failed!, at: 0 }, {
      at: 0, purpose: 'ask', subject: 'ask_judge', answers: {}, decision: null, latencyMs: failed!.latencyMs, error: failed!.error,
    })
    assert.match(failed!.error ?? '', /HTTP 500/)
    assert.equal((await ctx.dishJudge.log.read({ purpose: 'command' })).lines.length, 1)
    assert.equal((await ctx.dishJudge.log.read({ decision: 'allow' })).lines.length, 1)

    // And they are in files, in the state directory: one for the day, private, JSON a line each, with no key in it.
    const day = new Date(answered!.at).toISOString().slice(0, 10)
    const raw = await readFile(join(where.state, `${day}.jsonl`), 'utf8')
    assert.equal(raw.endsWith('\n'), true)
    assert.deepEqual(raw.slice(0, -1).split('\n').map(line => JSON.parse(line) as JudgeLogLine).map(line => line.purpose), ['command', 'ask'])
    assert.ok(!raw.includes(FAKE_KEY))
    assert.equal(statSync(join(where.state, `${day}.jsonl`)).mode & 0o777, 0o600)
    assert.equal(statSync(where.state).mode & 0o777, 0o700)
  } finally {
    await dispose()
  }
})

test('the log is in $XDG_STATE_HOME/dish/judge when stateDirectory is blank', async () => {
  const root = await tempDir()
  await withEnv({ XDG_STATE_HOME: join(root, 'xdg') }, async () => {
    const ctx = new Context()
    const handle = ctx.plugin(plugin, { terminal: false, stateDirectory: '' } as plugin.Config)
    await handle
    try {
      ctx.dishJudge.log.write(logAt({ subject: 'xdg' }))
      await ctx.dishJudge.log.flush()
      assert.deepEqual((await ctx.dishJudge.log.read()).lines.map(line => line.subject), ['xdg'])
      assert.equal(existsSync(join(root, 'xdg', 'dish', 'judge')), true)
      assert.equal((await readdir(join(root, 'xdg', 'dish', 'judge'))).length, 1)
    } finally {
      await handle.dispose()
    }
  })
})

test('the log\'s surface is write, withhold, read and withheld: write is a plain function that returns at once, and keeps working when taken off the service', async () => {
  const { ctx, dispose } = await mountWithJev(await dirs())
  try {
    assert.deepEqual(Object.keys(ctx.dishJudge.log).sort(), ['flush', 'read', 'withheld', 'withhold', 'write'])
    const { write, read, flush } = ctx.dishJudge.log
    const returned: unknown = write(logAt({ subject: 'detached' }))
    assert.equal(returned, undefined, 'nothing to wait for: a gate can not wait on a disk write')
    await flush()
    assert.deepEqual((await read()).lines.map(line => line.subject), ['detached'])
    assert.equal(await ctx.dishJudge.log.withheld('0123456789abcdef'), undefined)
    assert.equal(await ctx.dishJudge.log.withheld('../../etc/passwd'), undefined)
  } finally {
    await dispose()
  }
})

test('lines written through the service, the way the approval answerer will, are read back with the client\'s', async () => {
  const { ctx, dispose } = await mountWithJev(await dirs())
  try {
    await ctx.get('judge')!.ask({ state: 'x', questions: SERVES, purpose: 'command', subject: 'first', decide: () => ({ decision: 'allow' }) })
    ctx.dishJudge.log.write(logAt({ at: Date.now() + 1, subject: 'second', purpose: 'approval', decision: 'rejected', child: true, agent: 'kid-1' }))
    await ctx.dishJudge.log.flush()
    const lines = (await ctx.dishJudge.log.read()).lines
    assert.deepEqual(lines.map(line => [line.purpose, line.subject]), [['approval', 'second'], ['command', 'first']])
    assert.deepEqual((await ctx.dishJudge.log.read({ purpose: 'approval' })).lines.map(line => line.decision), ['rejected'])
  } finally {
    await dispose()
  }
})

test('a log that can not be written does not fail the call, and says so', async () => {
  const where = await dirs()
  // The state directory is a path through a file: nothing can be made there.
  const file = join(where.root, 'a-file')
  await writeFile(file, 'not a directory')
  const stateDirectory = join(file, 'judge')
  const ctx = new Context()
  const logs = watchLogs(ctx)
  const jev = await startFakeJev()
  jev.always({ kind: 'answer', body: jevBody({ serves_task: noulAnswer(0.9) }) })
  const stub = await provideStub(ctx, 'credentials', credentials(async () => ({ value: FAKE_KEY })))
  const handle = mountJudge(ctx, stateDirectory, { baseUrl: jev.url })
  try {
    await handle
    for (let call = 0; call < 3; call++) {
      const asked = await ctx.get('judge')!.ask({ state: 'x', questions: SERVES, purpose: 'ask', decide: () => ({ decision: 'pass' }) })
      assert.equal(asked.ok, true, 'the call is answered whatever the disk says')
      assert.equal(asked.ok && asked.latencyMs >= 0, true)
      assert.deepEqual(asked.decided, { decision: 'pass' })
    }
    assert.equal(jev.requests.length, 3)
    // The writes are on their way when the calls return: wait for them to fail, and then for each cause there is one warning.
    await ctx.dishJudge.log.flush()
    const about = (): string[] => judgeLines(logs).filter(line => /decision log/.test(line))
    assert.equal(about().length, 1, logs.join('\n'))
    assert.match(about()[0]!, /^\[dish-judge\] warn: could not write the decision log in .*a-file\/judge: ENOTDIR \(open\)$/)
    assert.ok(!judgeLines(logs).join('\n').includes(FAKE_KEY))
    assert.deepEqual((await ctx.dishJudge.log.read()).lines, [])

    // Another cause is another message: a line that is not a line.
    const bad = { not: 'a line' } as unknown as JudgeLogLine
    ctx.dishJudge.log.write(bad)
    ctx.dishJudge.log.write(bad)
    await ctx.dishJudge.log.flush()
    await waitFor('the second warning', () => about().length > 1, 5000)
    assert.equal(about().length, 2, logs.join('\n'))
    assert.match(about()[1]!, /could not write the decision log in .*a-file\/judge: not a log line: /)
  } finally {
    await handle.dispose()
    await stub.dispose()
  }
})

test('unloading waits for the lines that are on their way, so the last decisions are not lost with the process', async () => {
  const where = await dirs()
  const { ctx, dispose } = await mountWithJev(where)
  for (let i = 0; i < 50; i++) ctx.dishJudge.log.write(logAt({ subject: `line ${i}`, at: 1_790_881_930_415 + i }))
  await dispose()
  const raw = await readFile(join(where.state, '2026-10-01.jsonl'), 'utf8')
  assert.deepEqual(raw.slice(0, -1).split('\n').map(line => (JSON.parse(line) as JudgeLogLine).subject), Array.from({ length: 50 }, (_, i) => `line ${i}`))
})

/** A `JudgeLog` that is only what the service uses of one: writes that fail as `fail` says, and what else is asked of it. */
function failingLog(fail: () => unknown, more: Record<string, unknown> = {}) {
  return { write: async () => { throw fail() }, withhold: async () => { throw fail() }, read: async () => ({ lines: [], skipped: 0 }), withheld: async () => undefined, flush: async () => {}, ...more } as never
}

const diskError = (day: string): Error => Object.assign(new Error(`ENOTDIR: not a directory, open '/x/${day}.jsonl'`), { code: 'ENOTDIR', syscall: 'open' })

test('a write that fails is said once for each cause: the same cause on another day, or again and again, is the same message', async () => {
  const log = collector()
  const tell = plugin.warnOnce(log)
  let day = '2026-10-01'
  const service = plugin.createLogService(failingLog(() => diskError(day)), { key: async () => undefined, tell, directory: '/x' })
  for (let i = 0; i < 5; i++) service.write(logAt())
  day = '2026-10-02'
  for (let i = 0; i < 5; i++) service.write(logAt())
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(log.lines, ['could not write the decision log in /x: ENOTDIR (open)'])
  // Other causes, each said once: a disk that is full, an error with no code.
  let next: unknown = Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC', syscall: 'write' })
  const other = plugin.createLogService(failingLog(() => next), { key: async () => undefined, tell, directory: '/x' })
  other.write(logAt())
  other.write(logAt())
  next = new RangeError('a log line is over 16384 bytes even with its subject, error and answers cut')
  other.write(logAt())
  other.write(logAt())
  next = 'not even an error'
  other.write(logAt())
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(log.lines, [
    'could not write the decision log in /x: ENOTDIR (open)',
    'could not write the decision log in /x: ENOSPC (write)',
    'could not write the decision log in /x: a log line is over 16384 bytes even with its subject, error and answers cut',
    'could not write the decision log in /x: not even an error',
  ])
})

test('a write that throws at once, as a write of another make might, does not reach the caller either', async () => {
  const log = collector()
  const tell = plugin.warnOnce(log)
  const service = plugin.createLogService({
    write: () => { throw new Error('threw at once') },
    withhold: () => { throw new Error('threw at once') },
    read: () => Promise.reject(new Error('r')),
    withheld: () => Promise.reject(new Error('w')),
  } as never, { key: async () => undefined, tell, directory: '/somewhere' })
  assert.doesNotThrow(() => service.write(logAt()))
  await assert.rejects(service.withhold({ tool: 't', content: 'c' }), /threw at once/)
  assert.deepEqual(log.lines, [
    'could not write the decision log in /somewhere: threw at once',
    'could not keep a withheld result in /somewhere: threw at once',
  ])
})

test('at start, day files and withheld files older than 30 days are removed before the service is provided, and the rest are kept', async () => {
  const where = await dirs()
  const day = (ago: number): string => new Date(Date.now() - ago * DAY_MS).toISOString().slice(0, 10)
  await mkdir(join(where.state, 'withheld'), { recursive: true })
  const oldDay = join(where.state, `${day(40)}.jsonl`)
  const edgeDay = join(where.state, `${day(29)}.jsonl`)
  const today = join(where.state, `${day(0)}.jsonl`)
  const text = `${JSON.stringify(logAt())}\n`
  for (const file of [oldDay, edgeDay, today]) await writeFile(file, text)
  const oldWithheld = join(where.state, 'withheld', '0123456789abcdef.txt')
  const newWithheld = join(where.state, 'withheld', 'fedcba9876543210.txt')
  await writeFile(oldWithheld, '"bash"\nold content')
  await writeFile(newWithheld, '"bash"\nnew content')
  const longAgo = new Date(Date.now() - 40 * DAY_MS)
  await utimes(oldWithheld, longAgo, longAgo)
  await utimes(oldDay, longAgo, longAgo)

  const ctx = new Context()
  // Whether the old day was still there when the service appeared: the prune comes first, as crew's does.
  let oldWhenProvided: boolean | undefined
  ctx.on('internal/service', (name) => {
    if (name === 'dishJudge' && oldWhenProvided === undefined) oldWhenProvided = existsSync(oldDay)
  })
  const handle = mountJudge(ctx, where.state)
  try {
    await handle
    assert.equal(oldWhenProvided, false)
    assert.equal(existsSync(oldDay), false)
    assert.equal(existsSync(oldWithheld), false)
    assert.equal(existsSync(edgeDay), true)
    assert.equal(existsSync(today), true)
    assert.equal(existsSync(newWithheld), true)
    assert.equal((await ctx.dishJudge.log.read()).lines.length, 2)
    assert.deepEqual(await ctx.dishJudge.log.withheld('fedcba9876543210'), { tool: 'bash', content: 'new content' })
  } finally {
    await handle.dispose()
  }
})

test('a prune that fails is logged once, and the plugin loads and works all the same', async () => {
  if (process.getuid?.() === 0) return // a directory can't be made unreadable to root
  const where = await dirs()
  await mkdir(where.state, { recursive: true })
  await writeFile(join(where.state, '2020-01-01.jsonl'), '{}\n')
  await chmod(where.state, 0o000)
  const ctx = new Context()
  const logs = watchLogs(ctx)
  const jev = await startFakeJev()
  const stub = await provideStub(ctx, 'credentials', credentials(async () => ({ value: FAKE_KEY })))
  const handle = mountJudge(ctx, where.state, { baseUrl: jev.url })
  try {
    await handle
    assert.ok(ctx.get('dishJudge'), 'the plugin is there')
    assert.ok(ctx.get('judge'), 'and so is the client')
    const lines = judgeLines(logs)
    assert.equal(lines.length, 1, logs.join('\n'))
    assert.match(lines[0]!, /^\[dish-judge\] warn: could not prune the decision log in .*: .*EACCES/)
    assert.deepEqual(await ctx.dishJudge.settings(), DEFAULT_SETTINGS)
  } finally {
    await chmod(where.state, 0o700)
    await handle.dispose()
    await stub.dispose()
  }
})

test('a plugin that is unloaded while it prunes goes away quietly: it does not fail, and it provides nothing', async () => {
  const where = await dirs()
  await mkdir(where.state, { recursive: true })
  await writeFile(join(where.state, '2020-01-01.jsonl'), `${JSON.stringify(logAt())}\n`)
  const ctx = new Context()
  const logs = watchLogs(ctx)
  const handle = mountJudge(ctx, where.state)
  // The plugin says it removed a file in the one step between the prune and providing the services: unload it there.
  let unloaded: Promise<void> | undefined
  ctx.logger.exporter({
    levels: { default: 3 },
    export: (message) => {
      if (message.name === 'dish-judge' && message.type === 'info') unloaded ??= Promise.resolve(handle.dispose())
    },
  })
  await handle
  await unloaded
  assert.ok(unloaded !== undefined, 'the plugin was unloaded while it was loading')
  assert.equal(existsSync(join(where.state, '2020-01-01.jsonl')), false, 'the prune was done')
  assert.equal(ctx.get('dishJudge'), undefined)
  assert.equal(ctx.get('judge'), undefined)
  assert.deepEqual(judgeLines(logs), [])
})

// --- withheld content: the key is masked --------------------------------------------------------------

/** What a screen might hold: the key in its three forms, a token the patterns know, and text around them. */
function leaky(key: string): string {
  const token = `ghp_${'A1b2C3d4E5'.repeat(4)}`
  return `start ${key} json ${JSON.stringify(key).slice(1, -1)} url ${encodeURIComponent(key)} token ${token} end ${key}`
}

/** What is in the content for a test to say it hid: every form of the key, and the token's body. */
function forms(key: string): string[] {
  return [key, JSON.stringify(key).slice(1, -1), encodeURIComponent(key), 'A1b2C3d4E5']
}

test('the fake key is one the secret patterns do not know, and its three forms differ: so what hides it is the key mask', () => {
  assert.equal(secretKind(FAKE_KEY), undefined)
  assert.equal(secretKind(leaky(FAKE_KEY).replaceAll('ghp_', 'x_')), undefined)
  assert.equal(new Set([FAKE_KEY, JSON.stringify(FAKE_KEY).slice(1, -1), encodeURIComponent(FAKE_KEY)]).size, 3)
  const patternsOnly = maskSecrets(leaky(FAKE_KEY))
  assert.ok(patternsOnly.includes(FAKE_KEY), 'the patterns alone leave the key')
})

test('withheld content has the key hidden in the form it is in, the JSON-escaped one and the URL-encoded one, and the secret patterns apply too', async () => {
  const where = await dirs()
  const { ctx, dispose } = await mountWithJev(where)
  try {
    const id = await ctx.dishJudge.log.withhold({ tool: `mcp__${FAKE_KEY}__fetch`, content: leaky(FAKE_KEY) })
    assert.match(id, /^[0-9a-f]{16}$/)
    const kept = await ctx.dishJudge.log.withheld(id)
    assert.ok(kept !== undefined)
    assert.equal(kept.content, 'start ‹key› json ‹key› url ‹key› token ‹secret: a GitHub token› end ‹key›')
    assert.equal(kept.tool, 'mcp__‹key›__fetch')
    // Nor is any form of it in the file.
    const raw = await readFile(join(where.state, 'withheld', `${id}.txt`), 'utf8')
    for (const form of forms(FAKE_KEY)) assert.ok(!raw.includes(form), form)
  } finally {
    await dispose()
  }
})

test('the key is looked up for each withheld result, and a key that is set again is the one that is hidden', async () => {
  const where = await dirs()
  const ctx = new Context()
  let key = FAKE_KEY
  let lookups = 0
  const stub = await provideStub(ctx, 'credentials', credentials(async () => { lookups++; return { value: key } }))
  const handle = mountJudge(ctx, where.state)
  try {
    await handle
    const first = await ctx.dishJudge.log.withhold({ tool: 't', content: `a ${FAKE_KEY} b` })
    key = 'second-key-Mx83'
    const second = await ctx.dishJudge.log.withhold({ tool: 't', content: `a ${FAKE_KEY} b ${key} c` })
    assert.equal(lookups, 2)
    assert.equal((await ctx.dishJudge.log.withheld(first))?.content, 'a ‹key› b')
    assert.equal((await ctx.dishJudge.log.withheld(second))?.content, `a ${FAKE_KEY} b ‹key› c`)
  } finally {
    await handle.dispose()
    await stub.dispose()
  }
})

test('the key is looked up by the name in keyName', async () => {
  const where = await dirs()
  const ctx = new Context()
  const asked: string[] = []
  const stub = await provideStub(ctx, 'credentials', credentials(async (name) => { asked.push(name); return { value: FAKE_KEY } }))
  const handle = mountJudge(ctx, where.state, { keyName: 'MY_JEV_KEY' })
  try {
    await handle
    await ctx.dishJudge.log.withhold({ tool: 't', content: 'c' })
    assert.deepEqual(asked, ['MY_JEV_KEY'])
  } finally {
    await handle.dispose()
    await stub.dispose()
  }
})

test('when the key can not be had, withheld content is kept all the same, with the patterns only: no credentials, no key, a lookup that fails or throws', async () => {
  const content = leaky(FAKE_KEY)
  const lookups: Array<[string, (name: string) => Promise<{ value: string } | undefined>] | undefined> = [
    undefined,
    ['no key', async () => undefined],
    ['blank key', async () => ({ value: '   ' })],
    ['a rejection', async () => { throw new Error(`the store failed on ${FAKE_KEY}`) }],
    ['a throw', () => { throw new Error('sync') }],
  ]
  for (const lookup of lookups) {
    const where = await dirs()
    const ctx = new Context()
    const stub = lookup === undefined ? undefined : await provideStub(ctx, 'credentials', credentials(lookup[1]))
    const logs = watchLogs(ctx)
    const handle = mountJudge(ctx, where.state)
    try {
      await handle
      const id = await ctx.dishJudge.log.withhold({ tool: 'web_fetch', content })
      const text = (await ctx.dishJudge.log.withheld(id))?.content
      assert.equal(text, content.replaceAll('ghp_' + 'A1b2C3d4E5'.repeat(4), '‹secret: a GitHub token›'), lookup?.[0] ?? 'no credentials service')
      assert.deepEqual(judgeLines(logs).filter(line => line.includes(FAKE_KEY)), [], 'what the store said is not repeated')
    } finally {
      await handle.dispose()
      await stub?.dispose()
    }
  }
})

test('a key lookup that never answers holds withhold for its bound and no longer: the screen does not hang', async () => {
  assert.equal(plugin.WITHHOLD_KEY_BUDGET_MS, 250)
  const where = await dirs()
  const ctx = new Context()
  let lookups = 0
  const stub = await provideStub(ctx, 'credentials', credentials(() => { lookups++; return new Promise(() => {}) }))
  const handle = mountJudge(ctx, where.state)
  try {
    await handle
    const started = performance.now()
    const id = await ctx.dishJudge.log.withhold({ tool: 'web_fetch', content: leaky(FAKE_KEY) })
    const elapsed = performance.now() - started
    assert.ok(elapsed >= plugin.WITHHOLD_KEY_BUDGET_MS - 20 && elapsed < plugin.WITHHOLD_KEY_BUDGET_MS + 400, `took ${elapsed} ms`)
    assert.equal(lookups, 1)
    const text = (await ctx.dishJudge.log.withheld(id))?.content ?? ''
    assert.ok(text.includes('‹secret: a GitHub token›') && !text.includes('A1b2C3d4E5'), 'the patterns were applied')
  } finally {
    await handle.dispose()
    await stub.dispose()
  }
})

test('withhold takes { tool, content } as strings, as the log does, and says so when it is given something else', async () => {
  const { ctx, dispose } = await mountWithJev(await dirs())
  try {
    for (const bad of [undefined, null, 'text', { tool: 1, content: 'x' }, { tool: 'x', content: 2 }, { tool: 'x' }]) {
      await assert.rejects(ctx.dishJudge.log.withhold(bad as never), TypeError, JSON.stringify(bad))
    }
  } finally {
    await dispose()
  }
})

test('a withhold that the disk refuses is rejected to its caller and said once', async () => {
  const where = await dirs()
  const file = join(where.root, 'a-file')
  await writeFile(file, 'not a directory')
  const ctx = new Context()
  const logs = watchLogs(ctx)
  const stub = await provideStub(ctx, 'credentials', credentials(async () => ({ value: FAKE_KEY })))
  const handle = mountJudge(ctx, join(file, 'judge'))
  try {
    await handle
    await assert.rejects(ctx.dishJudge.log.withhold({ tool: 't', content: 'c' }), { code: 'ENOTDIR' })
    await assert.rejects(ctx.dishJudge.log.withhold({ tool: 't', content: 'c' }), { code: 'ENOTDIR' })
    assert.equal(judgeLines(logs).length, 1, logs.join('\n'))
    assert.match(judgeLines(logs)[0]!, /^\[dish-judge\] warn: could not keep a withheld result in .*a-file\/judge: ENOTDIR \(mkdir\)$/)
  } finally {
    await handle.dispose()
    await stub.dispose()
  }
})
