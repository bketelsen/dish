import { mkdir, readFile, readdir, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../src/index.ts'
import type { DishPrompts } from '../src/index.ts'
import { DEFAULTS } from '../src/defaults.ts'
import { CREW_ROLES, pathFor } from '../src/roles.ts'
import { SnapshotFiles } from '../src/snapshots.ts'
import {
  ALL_ROLES, COMMIT, DEFAULTS_BY_PATH, captureStderr, dirs, mountConfig, mountPrompts, seeded, snapshotFile, tempDir,
  userWrite, waitFor, watchLogs, withEnv,
} from './helpers.ts'
import type { Dirs } from './helpers.ts'
import type { DishConfigService } from 'dish-config'

const DAY = 24 * 60 * 60 * 1000
const AGENT = { kind: 'agent', sessionId: 's1', role: 'coder' } as const
const MAIN_ONE = 'main text, one'
const MAIN_TWO = 'main text, two'

/** Mount dish-config and dish-prompts on `where` in `ctx`, wait for the defaults, and return what unmounts them. */
async function start(ctx: Context, where: Dirs): Promise<() => Promise<void>> {
  const config = mountConfig(ctx, where.repository)
  await config
  const prompts = mountPrompts(ctx, where.state)
  await prompts
  await seeded(ctx.dishConfig)
  return async () => {
    await prompts.dispose()
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

// --- the service and the store --------------------------------------------------------------------

test('dishPrompts is provided once start-up (the prune) is over, and is the documented service', async () => {
  const where = await dirs()
  const ctx = new Context()
  const handle = mountPrompts(ctx, where.state)
  assert.equal(ctx.get('dishPrompts'), undefined)
  await handle
  const service: DishPrompts = ctx.dishPrompts
  assert.deepEqual(Object.keys(service).sort(), ['defaultText', 'drop', 'persona', 'roles', 'snapshot'])
  await handle.dispose()
  assert.equal(ctx.get('dishPrompts'), undefined)
})

test('with the store there, all eight documents are seeded; a second start rewrites nothing', async () => {
  const where = await dirs()
  const first = await (async () => {
    const ctx = new Context()
    const stop = await start(ctx, where)
    try {
      const store = ctx.dishConfig
      for (const role of ALL_ROLES) assert.equal(await store.read(pathFor(role)), DEFAULTS[role], role)
      const commits = await store.history({ prefix: 'prompts/' })
      assert.equal(commits.length, 1)
      assert.deepEqual(commits[0]!.author, { kind: 'system' })
      assert.match(commits[0]!.message, /dish-prompts defaults/)
      assert.deepEqual(commits[0]!.paths, Object.keys(DEFAULTS_BY_PATH).sort())
      return { head: await store.head(), commit: commits[0]!.id }
    } finally {
      await stop()
    }
  })()
  await withBoth(where, async (ctx) => {
    const store = ctx.dishConfig
    assert.equal(await store.head(), first.head)
    assert.deepEqual((await store.history({ prefix: 'prompts/' })).map(commit => commit.id), [first.commit])
  })
})

test('a person\'s edit survives a restart: the defaults are only seeded where nothing exists', async () => {
  const where = await dirs()
  await withBoth(where, async (ctx) => {
    await userWrite(ctx.dishConfig, 'main', MAIN_ONE)
  })
  await withBoth(where, async (ctx) => {
    assert.equal(await ctx.dishConfig.read(pathFor('main')), MAIN_ONE)
    assert.equal(await ctx.dishConfig.read(pathFor('coder')), DEFAULTS.coder)
  })
})

test('the policies of the three namespaces hold through dishConfig', async () => {
  await withBoth(await dirs(), async (ctx) => {
    const store = ctx.dishConfig
    // An agent can't write main or common...
    for (const path of ['prompts/main.md', 'prompts/common.md']) {
      await assert.rejects(store.write([{ path, text: 'by an agent' }], { author: AGENT }), { code: 'FORBIDDEN' }, path)
      assert.ok(await store.read(path) !== 'by an agent')
    }
    // ...but can propose a change, which waits for a person.
    const proposal = await store.propose([{ path: 'prompts/main.md', text: 'proposed' }], { author: AGENT, title: 'Tighten main', rationale: 'shorter' })
    assert.equal(await store.read('prompts/main.md'), DEFAULTS.main)
    assert.ok(proposal.id)
    // A crew prompt takes a direct write.
    assert.ok(await store.write([{ path: 'prompts/crew/coder.md', text: 'coder, by an agent' }], { author: AGENT, note: 'be terse' }))
    assert.equal(await store.read('prompts/crew/coder.md'), 'coder, by an agent')
    // A new crew role too.
    assert.ok(await store.write([{ path: 'prompts/crew/data-2.md', text: 'we model data' }], { author: AGENT }))
    // A person can write all of them.
    assert.ok(await userWrite(store, 'main', MAIN_ONE))
    assert.ok(await userWrite(store, 'common', 'common, edited'))
  })
})

test('the namespaces validate: no empty prompts, no stray paths under prompts/crew/', async () => {
  await withBoth(await dirs(), async (ctx) => {
    const store = ctx.dishConfig
    const user = { kind: 'user' } as const
    await assert.rejects(store.write([{ path: 'prompts/main.md', text: ' \n' }], { author: user }), { code: 'INVALID', message: /can't be empty/ })
    await assert.rejects(store.write([{ path: 'prompts/crew/a/b.md', text: 'x' }], { author: user }), { code: 'INVALID' })
    await assert.rejects(store.write([{ path: 'prompts/crew/Upper.md', text: 'x' }], { author: user }), { code: 'INVALID' })
    await assert.rejects(store.write([{ path: 'prompts/other.md', text: 'x' }], { author: user }), { code: 'UNOWNED' })
  })
})

test('roles() and persona() follow the store: a person\'s edits show at once', async () => {
  await withBoth(await dirs(), async (ctx) => {
    const prompts = ctx.dishPrompts
    const store = ctx.dishConfig
    assert.deepEqual(await prompts.roles(), ['common', 'main', ...[...CREW_ROLES].sort()])
    const head = await store.head()
    assert.deepEqual(await prompts.persona('main'), { prefix: DEFAULTS.main, suffix: DEFAULTS.common, commit: head })
    const edit = await userWrite(store, 'main', MAIN_ONE)
    assert.ok(edit)
    assert.deepEqual(await prompts.persona('main'), { prefix: MAIN_ONE, suffix: DEFAULTS.common, commit: edit.id })
    await store.write([{ path: 'prompts/crew/data-2.md', text: 'we model data' }], { author: AGENT })
    assert.deepEqual(await prompts.roles(), ['common', 'main', 'architect', 'coder', 'data-2', 'ops', 'researcher', 'reviewer', 'writer'])
    assert.equal((await prompts.persona('data-2')).prefix, 'we model data')
    await assert.rejects(prompts.persona('common'))
    await assert.rejects(prompts.persona('nobody'), { message: 'unknown role "nobody"', code: plugin.UNKNOWN_ROLE })
  })
})

// --- snapshots across a restart -------------------------------------------------------------------

test('an agent keeps its prompt across an edit and a restart; a new agent and a /clear get the new one', async () => {
  const where = await dirs()
  const a1 = { id: 'agent-1' }
  const a2 = { id: 'agent-2' }

  // First life: a1 starts, then the prompt changes, then a2 starts.
  await withBoth(where, async (ctx) => {
    const prompts = ctx.dishPrompts
    await userWrite(ctx.dishConfig, 'main', MAIN_ONE)
    assert.equal((await prompts.snapshot(a1, 'main')).prefix, MAIN_ONE)
    await userWrite(ctx.dishConfig, 'main', MAIN_TWO)
    // 1. The same agent, after the edit: the old text.
    assert.equal((await prompts.snapshot(a1, 'main')).prefix, MAIN_ONE)
    // 2. Another agent: the new one.
    assert.equal((await prompts.snapshot(a2, 'main')).prefix, MAIN_TWO)
  })

  // 3. Both plugins stopped and started again on the same directories.
  await withBoth(where, async (ctx) => {
    const prompts = ctx.dishPrompts
    const first = await prompts.snapshot(a1, 'main')
    assert.equal(first.prefix, MAIN_ONE)
    assert.match(first.commit ?? '', COMMIT)
    assert.equal((await prompts.snapshot(a2, 'main')).prefix, MAIN_TWO)
    // 4. A drop (/clear) gives the agent the current prompt.
    await prompts.drop(a1)
    assert.equal((await prompts.snapshot(a1, 'main')).prefix, MAIN_TWO)
  })

  // The dropped agent's new snapshot is what a restart finds.
  await withBoth(where, async (ctx) => {
    assert.equal((await ctx.dishPrompts.snapshot(a1, 'main')).prefix, MAIN_TWO)
  })
})

test('concurrent first calls give one file and the same answer', async () => {
  const where = await dirs()
  await withBoth(where, async (ctx) => {
    const prompts = ctx.dishPrompts
    const all = await Promise.all(Array.from({ length: 8 }, () => prompts.snapshot({ id: 'agent-x' }, 'main')))
    for (const snapshot of all) assert.deepEqual(snapshot, all[0])
    assert.deepEqual(await readdir(where.agents), [snapshotFile('agent-x')])
  })
})

test('the snapshot of a crew role is that role\'s text at the commit, with common as the suffix', async () => {
  const where = await dirs()
  await withBoth(where, async (ctx) => {
    const prompts = ctx.dishPrompts
    await ctx.dishConfig.write([{ path: pathFor('reviewer'), text: 'review one' }], { author: AGENT })
    const snapshot = await prompts.snapshot({ id: 'child-1' }, 'reviewer')
    await ctx.dishConfig.write([{ path: pathFor('reviewer'), text: 'review two' }], { author: AGENT })
    assert.deepEqual(await prompts.snapshot({ id: 'child-1' }, 'reviewer'), snapshot)
    assert.equal(snapshot.prefix, 'review one')
    assert.equal(snapshot.suffix, DEFAULTS.common)
  })
})

// --- no store, a store that goes away, a store that arrives later ---------------------------------

test('with no store at all, the plugin starts and answers with the defaults, quietly', async () => {
  const where = await dirs()
  const ctx = new Context()
  const logs = watchLogs(ctx)
  const handle = mountPrompts(ctx, where.state)
  try {
    await handle
    const prompts = ctx.dishPrompts
    assert.deepEqual(await prompts.persona('main'), { prefix: DEFAULTS.main, suffix: DEFAULTS.common, commit: null })
    assert.deepEqual(await prompts.snapshot({ id: 'a1' }, 'main'), { prefix: DEFAULTS.main, suffix: DEFAULTS.common, commit: null })
    assert.deepEqual(await prompts.snapshot({ id: 'a2' }, 'coder'), { prefix: DEFAULTS.coder, suffix: DEFAULTS.common, commit: null })
    assert.deepEqual(await prompts.roles(), ['common', 'main', ...[...CREW_ROLES].sort()])
    assert.equal(prompts.defaultText('ops'), DEFAULTS.ops)
    assert.deepEqual(logs, [])
  } finally {
    await handle.dispose()
  }
})

test('a store that arrives after dish-prompts gets the claims and the seed; an agent that began without it stays on the defaults', async () => {
  const where = await dirs()
  const ctx = new Context()
  const prompts = mountPrompts(ctx, where.state)
  await prompts
  const early = await ctx.dishPrompts.snapshot({ id: 'early' }, 'main')
  assert.equal(early.commit, null)
  const config = mountConfig(ctx, where.repository)
  try {
    await config
    await seeded(ctx.dishConfig)
    const service = ctx.dishPrompts
    const head = await ctx.dishConfig.head()
    assert.deepEqual(await service.persona('main'), { prefix: DEFAULTS.main, suffix: DEFAULTS.common, commit: head })
    assert.deepEqual(await service.snapshot({ id: 'early' }, 'main'), early)
    assert.equal((await service.snapshot({ id: 'late' }, 'main')).commit, head)
  } finally {
    await config.dispose()
    await prompts.dispose()
  }
})

test('a store that goes away and comes back: defaults while it is gone, the claims again when it returns', async () => {
  const where = await dirs()
  const ctx = new Context()
  const prompts = mountPrompts(ctx, where.state)
  let config = mountConfig(ctx, where.repository)
  try {
    await Promise.all([prompts, config])
    await seeded(ctx.dishConfig)
    await userWrite(ctx.dishConfig, 'main', MAIN_ONE)
    const service = ctx.dishPrompts
    assert.equal((await service.persona('main')).prefix, MAIN_ONE)
    const pinned = await service.snapshot({ id: 'a1' }, 'main')

    await config.dispose()
    assert.equal(ctx.get('dishConfig'), undefined)
    assert.deepEqual(await service.persona('main'), { prefix: DEFAULTS.main, suffix: DEFAULTS.common, commit: null })
    assert.deepEqual(await service.roles(), ['common', 'main', ...[...CREW_ROLES].sort()])
    // An agent already pinned in memory is unaffected; one that is read back from its file has no store to read the
    // commit from, so it gets the defaults for as long as the store is gone, and its own text again after.
    assert.deepEqual(await service.snapshot({ id: 'a1' }, 'main'), pinned)
    const lonely = new Context()
    const restarted = mountPrompts(lonely, where.state)
    await restarted
    assert.equal((await lonely.dishPrompts.snapshot({ id: 'a1' }, 'main')).commit, null)
    await restarted.dispose()

    config = mountConfig(ctx, where.repository)
    await config
    const store = ctx.dishConfig
    assert.equal((await service.persona('main')).prefix, MAIN_ONE)
    assert.deepEqual(await service.snapshot({ id: 'a1' }, 'main'), pinned)
    // Claimed again, and nothing was seeded twice.
    assert.ok(await userWrite(store, 'main', MAIN_TWO))
    assert.equal((await store.history({ prefix: 'prompts/' })).filter(commit => commit.author.kind === 'system').length, 1)
  } finally {
    await config.dispose()
    await prompts.dispose()
  }
})

test('unloading dish-prompts releases its claims; loading it again takes them back and seeds nothing new', async () => {
  const where = await dirs()
  const ctx = new Context()
  const config = mountConfig(ctx, where.repository)
  try {
    await config
    let prompts = mountPrompts(ctx, where.state)
    await prompts
    await seeded(ctx.dishConfig)
    const store = ctx.dishConfig
    const head = await store.head()
    await prompts.dispose()
    await assert.rejects(userWrite(store, 'main', MAIN_ONE), { code: 'UNOWNED' })
    prompts = mountPrompts(ctx, where.state)
    await prompts
    // The claims come with the inject callback, once the store is seen: wait for them.
    await waitFor('the claims', async () => userWrite(store, 'main', MAIN_ONE).then(() => true, () => undefined))
    assert.equal(await store.read(pathFor('main')), MAIN_ONE)
    assert.equal((await store.history({ prefix: 'prompts/' })).filter(commit => commit.author.kind === 'system').length, 1)
    assert.notEqual(await store.head(), head)
    await prompts.dispose()
  } finally {
    await config.dispose()
  }
})

test('a seed that fails is logged by dish-prompts, and the plugin and the service work on the defaults', async () => {
  const where = await dirs()
  const ctx = new Context()
  const logs = watchLogs(ctx)
  // A size cap smaller than any prompt: the seed is refused.
  const config = mountConfig(ctx, where.repository, { maxBytes: 16 })
  try {
    await config
    const handle = mountPrompts(ctx, where.state)
    await handle
    const line = await waitFor('the seed warning', () => logs.find(entry => entry.startsWith('[dish-prompts] warn:') && /seed/.test(entry)))
    assert.match(line, /TOO_LARGE|too large|exceeds|bytes/i)
    const service = ctx.dishPrompts
    const head = await ctx.dishConfig.head()
    // The store is up and has no prompts: the defaults, at its head.
    assert.deepEqual(await service.persona('main'), { prefix: DEFAULTS.main, suffix: DEFAULTS.common, commit: head })
    await handle.dispose()
  } finally {
    await config.dispose()
  }
})

// --- the state directory and the prune ------------------------------------------------------------

test('start-up prunes snapshot files not read for 180 days, before dishPrompts is provided', async () => {
  const where = await dirs()
  const files = new SnapshotFiles(where.agents)
  const record = { role: 'main', commit: null, takenAt: 1_790_000_000_000 }
  await Promise.all(['stale', 'fresh', 'almost'].map(id => files.put(id, record)))
  const age = async (id: string, days: number) => {
    const when = new Date(Date.now() - days * DAY)
    await utimes(join(where.agents, snapshotFile(id)), when, when)
  }
  await age('stale', 181)
  await age('almost', 179)

  const ctx = new Context()
  const handle = mountPrompts(ctx, where.state)
  assert.equal(ctx.get('dishPrompts'), undefined)
  await handle
  assert.deepEqual((await readdir(where.agents)).sort(), [snapshotFile('almost'), snapshotFile('fresh')].sort())
  await handle.dispose()
})

test('a prune that fails is logged, and the service is still provided', async () => {
  const where = await dirs()
  const ctx = new Context()
  const logs = watchLogs(ctx)
  // `agents` is a file, so listing it fails with ENOTDIR.
  await mkdir(where.state, { recursive: true })
  await writeFile(where.agents, 'in the way')
  const handle = mountPrompts(ctx, where.state)
  try {
    await handle
    assert.ok(ctx.get('dishPrompts'))
    assert.ok(logs.some(line => line.startsWith('[dish-prompts] warn:') && /prun/.test(line)), logs.join('\n'))
    // And it works: the defaults, from memory, with the file in the way left alone.
    assert.equal((await ctx.dishPrompts.snapshot({ id: 'a1' }, 'main')).prefix, DEFAULTS.main)
    assert.equal(await readFile(where.agents, 'utf8'), 'in the way')
  } finally {
    await handle.dispose()
  }
})

test('a snapshot file that is not valid is logged by the plugin, and replaced', async () => {
  const where = await dirs()
  await mkdir(where.agents, { recursive: true })
  await writeFile(join(where.agents, snapshotFile('a1')), '[]')
  const ctx = new Context()
  const logs = watchLogs(ctx)
  const handle = mountPrompts(ctx, where.state)
  try {
    await handle
    const snapshot = await ctx.dishPrompts.snapshot({ id: 'a1' }, 'main')
    assert.equal(snapshot.prefix, DEFAULTS.main)
    assert.ok(logs.some(line => line.startsWith('[dish-prompts] warn:') && line.includes('a1')), logs.join('\n'))
    assert.equal((await new SnapshotFiles(where.agents).get('a1'))?.commit, null)
    assert.equal(logs.filter(line => line.includes('a1')).length, 1, logs.join('\n'))
  } finally {
    await handle.dispose()
  }
})

test('a bad snapshot file is reported once per agent, though every step looks at it until the agent can be snapshotted', async () => {
  const where = await dirs()
  await mkdir(where.agents, { recursive: true })
  await writeFile(join(where.agents, snapshotFile('a1')), 'garbage')
  const ctx = new Context()
  const logs = watchLogs(ctx)
  // A store that is there but can not say where `main` is: the agent is served the defaults, and nothing is written over the file.
  ctx.provide('dishConfig', {
    claim: () => () => {},
    seed: () => Promise.resolve(undefined),
    head: () => Promise.reject(new Error('git is broken')),
    read: () => Promise.reject(new Error('git is broken')),
    list: () => Promise.reject(new Error('git is broken')),
  } as unknown as DishConfigService)
  const handle = mountPrompts(ctx, where.state)
  try {
    await handle
    for (let step = 0; step < 5; step++) assert.equal((await ctx.dishPrompts.snapshot({ id: 'a1' }, 'main')).commit, null)
    assert.equal(await readFile(join(where.agents, snapshotFile('a1')), 'utf8'), 'garbage')
    const about = (pattern: RegExp) => logs.filter(line => line.startsWith('[dish-prompts] warn:') && line.includes('a1') && pattern.test(line))
    assert.equal(about(/not valid/).length, 1, logs.join('\n'))
    assert.equal(about(/shipped defaults for now/).length, 1, logs.join('\n'))
    // Another agent with the same trouble is reported on its own.
    await writeFile(join(where.agents, snapshotFile('a2')), 'garbage')
    for (let step = 0; step < 3; step++) await ctx.dishPrompts.snapshot({ id: 'a2' }, 'main')
    assert.equal(logs.filter(line => line.includes('a2') && /not valid/.test(line)).length, 1, logs.join('\n'))
  } finally {
    await handle.dispose()
  }
})

test('a logger that throws does not make a bad snapshot file fail the call', async () => {
  const where = await dirs()
  await mkdir(where.agents, { recursive: true })
  await writeFile(join(where.agents, snapshotFile('a1')), 'garbage')
  const ctx = new Context()
  ctx.logger.exporter({ levels: { default: 3 }, export: () => { throw new Error('the exporter broke') } })
  const handle = mountPrompts(ctx, where.state)
  try {
    await handle
    assert.equal((await ctx.dishPrompts.snapshot({ id: 'a1' }, 'main')).prefix, DEFAULTS.main)
  } finally {
    await handle.dispose()
  }
})

test('stateDirectory defaults to the XDG state directory for dish, and takes ~/ and absolute paths', async () => {
  const root = await tempDir()
  const files = async (directory: string) => (await readdir(join(directory, 'agents'))).sort()

  // The default: <XDG_STATE_HOME>/dish/prompts.
  await withEnv({ XDG_STATE_HOME: join(root, 'xdg') }, async () => {
    for (const setting of [undefined, '', '   ']) {
      const ctx = new Context()
      const handle = ctx.plugin(plugin, { terminal: false, ...setting === undefined ? {} : { stateDirectory: setting } } as plugin.Config)
      await handle
      await ctx.dishPrompts.snapshot({ id: `xdg-${JSON.stringify(setting)}` }, 'main')
      await handle.dispose()
    }
    assert.equal((await files(join(root, 'xdg', 'dish', 'prompts'))).length, 3)
  })

  // ~/ is the home directory (`os.homedir()` reads $HOME).
  await withEnv({ HOME: join(root, 'home') }, async () => {
    const ctx = new Context()
    const handle = ctx.plugin(plugin, { terminal: false, stateDirectory: '~/snaps' } as plugin.Config)
    await handle
    await ctx.dishPrompts.snapshot({ id: 'home' }, 'main')
    await handle.dispose()
    assert.deepEqual(await files(join(root, 'home', 'snaps')), [snapshotFile('home')])
  })

  // An absolute path as it is.
  const ctx = new Context()
  const handle = mountPrompts(ctx, join(root, 'abs'))
  await handle
  await ctx.dishPrompts.snapshot({ id: 'abs' }, 'main')
  await handle.dispose()
  assert.deepEqual(await files(join(root, 'abs')), [snapshotFile('abs')])
  assert.ok((await stat(join(root, 'abs', 'agents'))).isDirectory())
})

test('a relative stateDirectory fails the plugin to load, and nothing is provided', async () => {
  const ctx = new Context()
  const handle = ctx.plugin(plugin, { terminal: false, stateDirectory: 'relative/dir' } as plugin.Config)
  await assert.rejects(async () => { await handle }, /stateDirectory must be an absolute path/)
  assert.equal(ctx.get('dishPrompts'), undefined)
})

test('terminal prints this plugin\'s warnings to stderr, and terminal: false does not', async () => {
  const where = await dirs()
  await mkdir(where.state, { recursive: true })
  await writeFile(where.agents, 'in the way')
  const run = async (terminal: boolean) => {
    const out = captureStderr()
    try {
      const ctx = new Context()
      const handle = mountPrompts(ctx, where.state, { terminal })
      await handle
      await handle.dispose()
    } finally {
      out.restore()
    }
    return out.lines()
  }
  const printed = await run(true)
  assert.ok(printed.some(line => /^\[dish-prompts\] warn: /.test(line)), printed.join('\n'))
  assert.deepEqual(await run(false), [])
})
