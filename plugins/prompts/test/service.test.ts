import { chmod, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { format } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import type { DishConfigService } from 'dish-config'
import { DEFAULTS } from '../src/defaults.ts'
import { CREW_ROLES, namespaceSpecs, pathFor } from '../src/roles.ts'
import { createDishPrompts } from '../src/service.ts'
import type { DishPrompts, SnapshotStore, StoreReader } from '../src/service.ts'
import { SnapshotFiles } from '../src/snapshots.ts'
import { COMMIT, dirs, mountConfig, snapshotFile, userWrite } from './helpers.ts'
import type { Dirs } from './helpers.ts'

const SORTED_CREW = [...CREW_ROLES].sort()
const MAIN_ONE = 'main text, one'
const MAIN_TWO = 'main text, two'
const COMMON_ONE = 'common text, one'

// --- helpers ------------------------------------------------------------------------------------

interface Harness {
  ctx: Context
  /** dish-config's real store, with dish-prompts' three namespaces claimed (and nothing seeded). */
  store: DishConfigService
  dirs: Dirs
  /** What the services built here logged as warnings. */
  warnings: string[]
  /** And as info lines. */
  infos: string[]
}

/** Run `body` with dish-config's real plugin mounted in a fresh `Context` on a temp repository. */
async function withStore(body: (harness: Harness) => Promise<void>): Promise<void> {
  const ctx = new Context()
  const where = await dirs()
  const handle = mountConfig(ctx, where.repository)
  try {
    await handle
    const store = ctx.dishConfig
    for (const spec of namespaceSpecs('dish-prompts')) ctx.effect(() => store.claim(spec))
    await body({ ctx, store, dirs: where, warnings: [], infos: [] })
  } finally {
    await handle.dispose()
  }
}

interface ServiceOverrides {
  store?: () => StoreReader | undefined
  files?: SnapshotStore
}

/** A `dishPrompts` service over the harness' store and its snapshot directory, which logs into `harness.warnings`. */
function serviceFor(harness: Harness, overrides: ServiceOverrides = {}): DishPrompts {
  return createDishPrompts({
    store: overrides.store ?? (() => harness.ctx.get('dishConfig')),
    files: overrides.files ?? new SnapshotFiles(harness.dirs.agents),
    logger: {
      warn: (...args: [string, ...unknown[]]) => { harness.warnings.push(format(...args)) },
      info: (...args: [string, ...unknown[]]) => { harness.infos.push(format(...args)) },
    },
  })
}

/** `files` with some methods replaced, and a count of every call. */
function spy(real: SnapshotStore, replace: Partial<SnapshotStore> = {}): SnapshotStore & { calls: { get: number, put: number, drop: number } } {
  const calls = { get: 0, put: 0, drop: 0 }
  return {
    calls,
    get: (id) => { calls.get++; return (replace.get ?? real.get.bind(real))(id) },
    put: (id, record) => { calls.put++; return (replace.put ?? real.put.bind(real))(id, record) },
    drop: (id) => { calls.drop++; return (replace.drop ?? real.drop.bind(real))(id) },
  }
}

/** A store reader with some methods replaced. */
function readerWith(store: DishConfigService, replace: Partial<StoreReader>): StoreReader {
  return {
    head: replace.head ?? (() => store.head()),
    read: replace.read ?? ((path, ref) => store.read(path, ref)),
    list: replace.list ?? ((prefix, ref) => store.list(prefix, ref)),
  }
}

/** The error the store throws for a ref it doesn't know, as another package's class: only `code` can be relied on. */
function notFound(): Error {
  return Object.assign(new Error('no such ref'), { code: 'NOT_FOUND' })
}

// --- roles ----------------------------------------------------------------------------------------

test('roles without a store is common, main and the shipped crew, sorted', async () => {
  const where = await dirs()
  const prompts = createDishPrompts({ store: () => undefined, files: new SnapshotFiles(where.agents), logger: { warn() {}, info() {} } })
  assert.deepEqual(await prompts.roles(), ['common', 'main', ...SORTED_CREW])
})

test('roles adds the crew roles found in the store, merged with the shipped ones and sorted', async () => {
  await withStore(async (harness) => {
    const prompts = serviceFor(harness)
    assert.deepEqual(await prompts.roles(), ['common', 'main', ...SORTED_CREW])
    await userWrite(harness.store, 'data-2', 'a role of our own')
    await userWrite(harness.store, 'ops', 'ops, rewritten')
    await userWrite(harness.store, 'zeta', 'last')
    await userWrite(harness.store, 'main', MAIN_ONE)
    assert.deepEqual(await prompts.roles(), ['common', 'main', 'architect', 'coder', 'data-2', 'ops', 'researcher', 'reviewer', 'writer', 'zeta'])
  })
})

test('roles follows the store as it comes and goes, call by call', async () => {
  await withStore(async (harness) => {
    await userWrite(harness.store, 'data-2', 'x')
    let current: StoreReader | undefined = harness.store
    const prompts = serviceFor(harness, { store: () => current })
    assert.ok((await prompts.roles()).includes('data-2'))
    current = undefined
    assert.deepEqual(await prompts.roles(), ['common', 'main', ...SORTED_CREW])
    current = harness.store
    assert.ok((await prompts.roles()).includes('data-2'))
  })
})

test('defaultText is the shipped text, and undefined for a role dish ships none for', async () => {
  await withStore(async (harness) => {
    const prompts = serviceFor(harness)
    for (const role of ['common', 'main', ...CREW_ROLES]) assert.equal(prompts.defaultText(role), DEFAULTS[role])
    assert.equal(prompts.defaultText('data-2'), undefined)
    assert.equal(prompts.defaultText('constructor'), undefined)
  })
})

// --- persona --------------------------------------------------------------------------------------

test('persona with no document in the store is the shipped defaults at the head', async () => {
  await withStore(async (harness) => {
    const prompts = serviceFor(harness)
    const head = await harness.store.head()
    assert.deepEqual(await prompts.persona('main'), { prefix: DEFAULTS.main, suffix: DEFAULTS.common, commit: head })
    assert.deepEqual(await prompts.persona('coder'), { prefix: DEFAULTS.coder, suffix: DEFAULTS.common, commit: head })
  })
})

test('persona is the role\'s document as a prefix and common as the suffix, at the head', async () => {
  await withStore(async (harness) => {
    const prompts = serviceFor(harness)
    await userWrite(harness.store, 'coder', 'coder, edited')
    const second = await userWrite(harness.store, 'common', COMMON_ONE)
    assert.ok(second)
    assert.deepEqual(await prompts.persona('coder'), { prefix: 'coder, edited', suffix: COMMON_ONE, commit: second.id })
    // Another role keeps its default prefix, with the shared suffix.
    assert.deepEqual(await prompts.persona('main'), { prefix: DEFAULTS.main, suffix: COMMON_ONE, commit: second.id })
    const third = await userWrite(harness.store, 'main', MAIN_ONE)
    assert.ok(third)
    assert.deepEqual(await prompts.persona('main'), { prefix: MAIN_ONE, suffix: COMMON_ONE, commit: third.id })
  })
})

test('persona of a crew role nobody shipped works once it has a document, and is unknown before', async () => {
  await withStore(async (harness) => {
    const prompts = serviceFor(harness)
    await assert.rejects(prompts.persona('data-2'), { message: 'unknown role "data-2"' })
    await userWrite(harness.store, 'data-2', 'we model data')
    const persona = await prompts.persona('data-2')
    assert.equal(persona.prefix, 'we model data')
    assert.equal(persona.suffix, DEFAULTS.common)
  })
})

test('persona of a deleted document is its default again', async () => {
  await withStore(async (harness) => {
    const prompts = serviceFor(harness)
    await userWrite(harness.store, 'writer', 'edited')
    assert.equal((await prompts.persona('writer')).prefix, 'edited')
    await harness.store.write([{ path: pathFor('writer'), delete: true }], { author: { kind: 'user' } })
    assert.equal((await prompts.persona('writer')).prefix, DEFAULTS.writer)
  })
})

test('persona refuses common, an invalid role name, and anything that is not a string, with a plain Error', async () => {
  await withStore(async (harness) => {
    const prompts = serviceFor(harness)
    await assert.rejects(prompts.persona('common'), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.equal((error as { code?: unknown }).code, undefined)
      assert.match(error.message, /common/)
      return true
    })
    for (const bad of ['Bad Role', '../main', '', 'a/b', 'UPPER']) {
      await assert.rejects(prompts.persona(bad), (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.equal((error as { code?: unknown }).code, undefined)
        assert.match(error.message, /invalid role/)
        return true
      }, bad)
    }
    await assert.rejects(prompts.persona(undefined as unknown as string), TypeError)
    await assert.rejects(prompts.persona(5 as unknown as string), TypeError)
  })
})

test('persona without a store is the shipped defaults, commit null; an unknown crew role throws', async () => {
  const where = await dirs()
  const prompts = createDishPrompts({ store: () => undefined, files: new SnapshotFiles(where.agents), logger: { warn() {}, info() {} } })
  assert.deepEqual(await prompts.persona('main'), { prefix: DEFAULTS.main, suffix: DEFAULTS.common, commit: null })
  assert.deepEqual(await prompts.persona('reviewer'), { prefix: DEFAULTS.reviewer, suffix: DEFAULTS.common, commit: null })
  await assert.rejects(prompts.persona('data-2'), { message: 'unknown role "data-2"' })
  await assert.rejects(prompts.persona('common'), /common/)
})

test('persona and roles pass a store failure on instead of hiding it behind defaults', async () => {
  await withStore(async (harness) => {
    const broken = readerWith(harness.store, {
      head: () => Promise.reject(new Error('config store is closed')),
      list: () => Promise.reject(new Error('config store is closed')),
    })
    const prompts = serviceFor(harness, { store: () => broken })
    await assert.rejects(prompts.persona('main'), /closed/)
    await assert.rejects(prompts.roles(), /closed/)
  })
})

test('a missing document is logged once per path, not once per call', async () => {
  await withStore(async (harness) => {
    const prompts = serviceFor(harness)
    await prompts.persona('main')
    await prompts.persona('main')
    await prompts.snapshot({ id: 'a1' }, 'main')
    await prompts.snapshot({ id: 'a2' }, 'main')
    const about = (path: string) => harness.warnings.filter(line => line.includes(path))
    assert.equal(about('prompts/main.md').length, 1, harness.warnings.join('\n'))
    assert.equal(about('prompts/common.md').length, 1, harness.warnings.join('\n'))
    // A document that is there says nothing.
    await userWrite(harness.store, 'coder', 'here')
    await prompts.persona('coder')
    assert.equal(about('prompts/crew/coder.md').length, 0)
  })
})

// --- snapshots ------------------------------------------------------------------------------------

test('a snapshot is the texts at the head when it is first asked for, and is recorded', async () => {
  await withStore(async (harness) => {
    const first = await userWrite(harness.store, 'main', MAIN_ONE)
    assert.ok(first)
    const prompts = serviceFor(harness)
    const snapshot = await prompts.snapshot({ id: 'a1' }, 'main')
    assert.deepEqual(snapshot, { prefix: MAIN_ONE, suffix: DEFAULTS.common, commit: first.id })
    const record = await new SnapshotFiles(harness.dirs.agents).get('a1')
    assert.ok(record)
    assert.equal(record.role, 'main')
    assert.equal(record.commit, first.id)
    assert.ok(Math.abs(record.takenAt - Date.now()) < 60_000)
    assert.deepEqual(await readdir(harness.dirs.agents), [snapshotFile('a1')])
  })
})

test('an agent keeps the texts of its snapshot after the store changes; a new agent gets the new ones', async () => {
  await withStore(async (harness) => {
    const prompts = serviceFor(harness)
    await userWrite(harness.store, 'main', MAIN_ONE)
    const old = await prompts.snapshot({ id: 'a1' }, 'main')
    await userWrite(harness.store, 'main', MAIN_TWO)
    await userWrite(harness.store, 'common', COMMON_ONE)
    assert.deepEqual(await prompts.snapshot({ id: 'a1' }, 'main'), old)
    assert.equal(old.prefix, MAIN_ONE)
    const fresh = await prompts.snapshot({ id: 'a2' }, 'main')
    assert.equal(fresh.prefix, MAIN_TWO)
    assert.equal(fresh.suffix, COMMON_ONE)
    assert.notEqual(fresh.commit, old.commit)
  })
})

test('a service started later on the same directory gives the agent the same texts, read at the recorded commit', async () => {
  await withStore(async (harness) => {
    const before = serviceFor(harness)
    await userWrite(harness.store, 'main', MAIN_ONE)
    const old = await before.snapshot({ id: 'a1' }, 'main')
    await userWrite(harness.store, 'main', MAIN_TWO)
    await userWrite(harness.store, 'common', COMMON_ONE)
    const restarted = serviceFor(harness)
    assert.deepEqual(await restarted.snapshot({ id: 'a1' }, 'main'), old)
    assert.equal((await restarted.snapshot({ id: 'a2' }, 'main')).prefix, MAIN_TWO)
  })
})

test('a document missing at the recorded commit is its default, however it looks now', async () => {
  await withStore(async (harness) => {
    const prompts = serviceFor(harness)
    const snapshot = await prompts.snapshot({ id: 'a1' }, 'main')
    assert.deepEqual(snapshot, { prefix: DEFAULTS.main, suffix: DEFAULTS.common, commit: await harness.store.head() })
    await userWrite(harness.store, 'main', MAIN_ONE)
    const restarted = serviceFor(harness)
    assert.equal((await restarted.snapshot({ id: 'a1' }, 'main')).prefix, DEFAULTS.main)
    // And a document that was there and went away is still there at the commit.
    await userWrite(harness.store, 'coder', 'coder one')
    const coder = await restarted.snapshot({ id: 'c1' }, 'coder')
    await harness.store.write([{ path: pathFor('coder'), delete: true }], { author: { kind: 'user' } })
    assert.equal((await serviceFor(harness).snapshot({ id: 'c1' }, 'coder')).prefix, 'coder one')
    assert.equal(coder.prefix, 'coder one')
  })
})

test('concurrent first calls for one agent share one snapshot: one read of its file, one write', async () => {
  await withStore(async (harness) => {
    const files = spy(new SnapshotFiles(harness.dirs.agents))
    const prompts = serviceFor(harness, { files })
    await userWrite(harness.store, 'main', MAIN_ONE)
    const pending = [1, 2, 3, 4, 5].map(() => prompts.snapshot({ id: 'a1' }, 'main'))
    // A change while they are in flight can't split them.
    const second = userWrite(harness.store, 'main', MAIN_TWO)
    const all = await Promise.all(pending)
    await second
    for (const snapshot of all) assert.deepEqual(snapshot, all[0])
    assert.equal(files.calls.get, 1)
    assert.equal(files.calls.put, 1)
    assert.deepEqual(await readdir(harness.dirs.agents), [snapshotFile('a1')])
    assert.equal(files.calls.get, 1)
    // Later calls come from memory.
    await prompts.snapshot({ id: 'a1' }, 'main')
    assert.equal(files.calls.get, 1)
  })
})

test('what a snapshot returns is the caller\'s: changing it does not change the next answer', async () => {
  await withStore(async (harness) => {
    const prompts = serviceFor(harness)
    const first = await prompts.snapshot({ id: 'a1' }, 'main')
    first.prefix = 'scribbled'
    assert.equal((await prompts.snapshot({ id: 'a1' }, 'main')).prefix, DEFAULTS.main)
  })
})

test('without a store, the snapshot is the defaults with commit null, and stays so when the store comes up', async () => {
  await withStore(async (harness) => {
    let current: StoreReader | undefined
    const prompts = serviceFor(harness, { store: () => current })
    await userWrite(harness.store, 'main', MAIN_ONE)
    const snapshot = await prompts.snapshot({ id: 'a1' }, 'main')
    assert.deepEqual(snapshot, { prefix: DEFAULTS.main, suffix: DEFAULTS.common, commit: null })
    const record = await new SnapshotFiles(harness.dirs.agents).get('a1')
    assert.equal(record?.role, 'main')
    assert.equal(record.commit, null)
    current = harness.store
    assert.deepEqual(await prompts.snapshot({ id: 'a1' }, 'main'), snapshot)
    // Across a restart too: the record says defaults.
    assert.deepEqual(await serviceFor(harness).snapshot({ id: 'a1' }, 'main'), snapshot)
    // An agent that starts now gets the store's.
    assert.equal((await prompts.snapshot({ id: 'a2' }, 'main')).prefix, MAIN_ONE)
  })
})

test('a record at a commit, with the store gone: the defaults for now, nothing cached or rewritten, the commit again when it is back', async () => {
  await withStore(async (harness) => {
    await userWrite(harness.store, 'main', MAIN_ONE)
    const pinned = await serviceFor(harness).snapshot({ id: 'a1' }, 'main')
    await userWrite(harness.store, 'main', MAIN_TWO)
    let current: StoreReader | undefined
    const prompts = serviceFor(harness, { store: () => current })
    assert.deepEqual(await prompts.snapshot({ id: 'a1' }, 'main'), { prefix: DEFAULTS.main, suffix: DEFAULTS.common, commit: null })
    assert.deepEqual(await prompts.snapshot({ id: 'a1' }, 'main'), { prefix: DEFAULTS.main, suffix: DEFAULTS.common, commit: null })
    // Said once for the agent, not once per step.
    assert.equal(harness.warnings.filter(line => line.includes('a1')).length, 1, harness.warnings.join('\n'))
    assert.equal((await new SnapshotFiles(harness.dirs.agents).get('a1'))?.commit, pinned.commit)
    current = harness.store
    assert.deepEqual(await prompts.snapshot({ id: 'a1' }, 'main'), pinned)
  })
})

test('a store that fails when asked for the head gives the defaults for now, nothing cached or recorded', async () => {
  await withStore(async (harness) => {
    let failing = true
    const flaky = readerWith(harness.store, { head: () => failing ? Promise.reject(new Error('boom')) : harness.store.head() })
    const files = spy(new SnapshotFiles(harness.dirs.agents))
    const prompts = serviceFor(harness, { store: () => flaky, files })
    await userWrite(harness.store, 'main', MAIN_ONE)
    assert.deepEqual(await prompts.snapshot({ id: 'a1' }, 'main'), { prefix: DEFAULTS.main, suffix: DEFAULTS.common, commit: null })
    assert.ok(harness.warnings.some(line => line.includes('boom')), harness.warnings.join('\n'))
    assert.equal(files.calls.put, 0)
    failing = false
    const later = await prompts.snapshot({ id: 'a1' }, 'main')
    assert.equal(later.prefix, MAIN_ONE)
    assert.match(later.commit ?? '', COMMIT)
    assert.equal(files.calls.put, 1)
  })
})

test('a store that fails when read at the recorded commit gives the defaults for now, and the real texts when it recovers', async () => {
  await withStore(async (harness) => {
    await userWrite(harness.store, 'main', MAIN_ONE)
    const pinned = await serviceFor(harness).snapshot({ id: 'a1' }, 'main')
    await userWrite(harness.store, 'main', MAIN_TWO)
    let failing = true
    const flaky = readerWith(harness.store, { read: (path, ref) => failing ? Promise.reject(new Error('git failed')) : harness.store.read(path, ref) })
    const files = spy(new SnapshotFiles(harness.dirs.agents))
    const prompts = serviceFor(harness, { store: () => flaky, files })
    assert.deepEqual(await prompts.snapshot({ id: 'a1' }, 'main'), { prefix: DEFAULTS.main, suffix: DEFAULTS.common, commit: null })
    assert.ok(harness.warnings.some(line => line.includes('git failed')), harness.warnings.join('\n'))
    assert.equal(files.calls.put, 0)
    failing = false
    assert.deepEqual(await prompts.snapshot({ id: 'a1' }, 'main'), pinned)
  })
})

test('a record whose commit the store does not have is logged and replaced by a fresh snapshot', async () => {
  await withStore(async (harness) => {
    const gone = 'f'.repeat(40)
    await new SnapshotFiles(harness.dirs.agents).put('a1', { role: 'main', commit: gone, takenAt: 1 })
    const head = (await userWrite(harness.store, 'main', MAIN_ONE))!.id
    const prompts = serviceFor(harness)
    assert.deepEqual(await prompts.snapshot({ id: 'a1' }, 'main'), { prefix: MAIN_ONE, suffix: DEFAULTS.common, commit: head })
    assert.ok(harness.warnings.some(line => line.includes('a1') && line.includes(gone)), harness.warnings.join('\n'))
    const record = await new SnapshotFiles(harness.dirs.agents).get('a1')
    assert.equal(record?.commit, head)
    assert.ok(record.takenAt > 1)
    // Nothing else about it is hidden: the new one is what a restart finds.
    await userWrite(harness.store, 'main', MAIN_TWO)
    assert.equal((await serviceFor(harness).snapshot({ id: 'a1' }, 'main')).prefix, MAIN_ONE)
  })
})

test('a NOT_FOUND from another package\'s class is recognised by its code alone', async () => {
  await withStore(async (harness) => {
    await new SnapshotFiles(harness.dirs.agents).put('a1', { role: 'main', commit: 'e'.repeat(40), takenAt: 1 })
    const head = await harness.store.head()
    const picky = readerWith(harness.store, { read: (path, ref) => ref === 'e'.repeat(40) ? Promise.reject(notFound()) : harness.store.read(path, ref) })
    const snapshot = await serviceFor(harness, { store: () => picky }).snapshot({ id: 'a1' }, 'main')
    assert.equal(snapshot.commit, head)
  })
})

test('a record that is not valid is replaced by a fresh snapshot', async () => {
  await withStore(async (harness) => {
    await mkdir(harness.dirs.agents, { recursive: true })
    await writeFile(join(harness.dirs.agents, snapshotFile('a1')), '{ not json')
    await userWrite(harness.store, 'main', MAIN_ONE)
    const snapshot = await serviceFor(harness).snapshot({ id: 'a1' }, 'main')
    assert.equal(snapshot.prefix, MAIN_ONE)
    assert.equal((await new SnapshotFiles(harness.dirs.agents).get('a1'))?.commit, snapshot.commit)
  })
})

test('when the snapshot file can not be read, the agent gets a fresh snapshot from memory, and nothing is written', async () => {
  await withStore(async (harness) => {
    // `agents` is a file, so every read of it fails with ENOTDIR, not ENOENT.
    await mkdir(harness.dirs.state, { recursive: true })
    await writeFile(harness.dirs.agents, 'in the way')
    const files = spy(new SnapshotFiles(harness.dirs.agents))
    const prompts = serviceFor(harness, { files })
    await userWrite(harness.store, 'main', MAIN_ONE)
    const snapshot = await prompts.snapshot({ id: 'a1' }, 'main')
    assert.equal(snapshot.prefix, MAIN_ONE)
    assert.match(snapshot.commit ?? '', COMMIT)
    assert.ok(harness.warnings.some(line => line.includes('a1')), harness.warnings.join('\n'))
    assert.equal(files.calls.put, 0)
    assert.equal(await readFile(harness.dirs.agents, 'utf8'), 'in the way')
    // From memory after that: a change to the store doesn't reach the agent in this process.
    await userWrite(harness.store, 'main', MAIN_TWO)
    assert.deepEqual(await prompts.snapshot({ id: 'a1' }, 'main'), snapshot)
    assert.equal(files.calls.get, 1)
    assert.equal((await prompts.snapshot({ id: 'a2' }, 'main')).prefix, MAIN_TWO)
  })
})

test('a snapshot file that exists but can not be read is left as it is, and the agent gets a fresh snapshot in memory', async (t) => {
  if (process.getuid?.() === 0) return t.skip('root reads any file')
  await withStore(async (harness) => {
    await userWrite(harness.store, 'main', MAIN_ONE)
    const files = new SnapshotFiles(harness.dirs.agents)
    const pinned = await serviceFor(harness).snapshot({ id: 'a1' }, 'main')
    const file = join(harness.dirs.agents, snapshotFile('a1'))
    const original = await readFile(file, 'utf8')
    await userWrite(harness.store, 'main', MAIN_TWO)
    await chmod(file, 0o000)
    try {
      const prompts = serviceFor(harness)
      const snapshot = await prompts.snapshot({ id: 'a1' }, 'main')
      assert.equal(snapshot.prefix, MAIN_TWO)
      assert.notEqual(snapshot.commit, pinned.commit)
      assert.ok(harness.warnings.some(line => line.includes('a1')), harness.warnings.join('\n'))
    } finally {
      await chmod(file, 0o600)
    }
    // Neither replaced nor removed: a rename over it would have destroyed the original.
    assert.equal(await readFile(file, 'utf8'), original)
    assert.equal((await files.get('a1'))?.commit, pinned.commit)
    assert.deepEqual((await stat(file)).mode & 0o777, 0o600)
  })
})

test('a snapshot that can not be written is logged and kept in memory, and the call does not fail', async () => {
  await withStore(async (harness) => {
    const files = spy(new SnapshotFiles(harness.dirs.agents), { put: () => Promise.reject(new Error('disk full')) })
    const prompts = serviceFor(harness, { files })
    await userWrite(harness.store, 'main', MAIN_ONE)
    const snapshot = await prompts.snapshot({ id: 'a1' }, 'main')
    assert.equal(snapshot.prefix, MAIN_ONE)
    assert.ok(harness.warnings.some(line => line.includes('disk full') && line.includes('a1')), harness.warnings.join('\n'))
    await userWrite(harness.store, 'main', MAIN_TWO)
    assert.deepEqual(await prompts.snapshot({ id: 'a1' }, 'main'), snapshot)
    assert.equal(files.calls.put, 1)
  })
})

test('a role with no text anywhere rejects the snapshot, caches nothing and writes nothing', async () => {
  await withStore(async (harness) => {
    const files = spy(new SnapshotFiles(harness.dirs.agents))
    const prompts = serviceFor(harness, { files })
    await assert.rejects(prompts.snapshot({ id: 'a1' }, 'data-2'), { message: 'unknown role "data-2"' })
    await assert.rejects(prompts.snapshot({ id: 'a1' }, 'data-2'), { message: 'unknown role "data-2"' })
    await assert.rejects(prompts.snapshot({ id: 'a1' }, 'common'), /common/)
    await assert.rejects(prompts.snapshot({ id: 'a1' }, 'Bad Role'), /invalid role/)
    assert.equal(files.calls.put, 0)
    await assert.rejects(readdir(harness.dirs.agents), { code: 'ENOENT' })
    // A rejection is not remembered: once there is a document the same agent gets it.
    await userWrite(harness.store, 'data-2', 'we model data')
    assert.equal((await prompts.snapshot({ id: 'a1' }, 'data-2')).prefix, 'we model data')
  })
})

test('snapshot refuses an agent without an id', async () => {
  await withStore(async (harness) => {
    const prompts = serviceFor(harness)
    await assert.rejects(prompts.snapshot({} as { id: string }, 'main'), TypeError)
    await assert.rejects(prompts.snapshot({ id: '' }, 'main'), TypeError)
  })
})

// --- the recorded role ----------------------------------------------------------------------------

test('after a restart the role in the record decides, not the role of the first call', async () => {
  await withStore(async (harness) => {
    await userWrite(harness.store, 'main', MAIN_ONE)
    await userWrite(harness.store, 'coder', 'coder one')
    const old = await serviceFor(harness).snapshot({ id: 'r1' }, 'main')
    assert.equal(old.prefix, MAIN_ONE)
    await userWrite(harness.store, 'main', MAIN_TWO)
    await userWrite(harness.store, 'coder', 'coder two')
    const restarted = serviceFor(harness)
    // Called as another role, it is still main's text at the old commit.
    assert.deepEqual(await restarted.snapshot({ id: 'r1' }, 'coder'), old)
    // And so it is from the record, however the first call after the next restart asks.
    assert.deepEqual(await serviceFor(harness).snapshot({ id: 'r1' }, 'reviewer'), old)
    assert.equal((await new SnapshotFiles(harness.dirs.agents).get('r1'))?.role, 'main')
  })
})

test('a store-only role keeps the text it had at the recorded commit, whatever the call asks for', async () => {
  await withStore(async (harness) => {
    await userWrite(harness.store, 'data-2', 'we model data')
    const old = await serviceFor(harness).snapshot({ id: 'r1' }, 'data-2')
    await harness.store.write([{ path: pathFor('data-2'), delete: true }], { author: { kind: 'user' } })
    assert.deepEqual(await serviceFor(harness).snapshot({ id: 'r1' }, 'main'), old)
  })
})

test('a record whose role is not a role, or has no text at its commit, is replaced by a snapshot for the call\'s role', async () => {
  await withStore(async (harness) => {
    const head = await harness.store.head()
    const files = new SnapshotFiles(harness.dirs.agents)
    const cases: Array<[string, string | null]> = [
      ['Bad Role', head], ['common', head], ['../x', head],
      // A crew role with no default and no document at the commit; and with commit null, which can never have had one.
      ['data-2', head], ['data-2', null],
    ]
    for (const [index, [role, commit]] of cases.entries()) {
      const id = `bad-${index}`
      await files.put(id, { role, commit, takenAt: 1 })
      const prompts = serviceFor(harness)
      assert.deepEqual(await prompts.snapshot({ id }, 'coder'), { prefix: DEFAULTS.coder, suffix: DEFAULTS.common, commit: head }, `${role} ${String(commit)}`)
      const record = await files.get(id)
      assert.equal(record?.role, 'coder')
      assert.equal(record.commit, head)
      assert.equal(harness.warnings.filter(line => line.includes(id)).length, 1, harness.warnings.join('\n'))
    }
  })
})

test('a record for a store-only role is not replaced while the store can not supply its text', async () => {
  await withStore(async (harness) => {
    await userWrite(harness.store, 'data-2', 'we model data')
    const pinned = await serviceFor(harness).snapshot({ id: 'r1' }, 'data-2')
    const files = spy(new SnapshotFiles(harness.dirs.agents))
    const without = serviceFor(harness, { store: () => undefined, files })
    await assert.rejects(without.snapshot({ id: 'r1' }, 'main'), { message: 'unknown role "data-2"' })
    assert.equal(files.calls.put, 0)
    assert.equal((await new SnapshotFiles(harness.dirs.agents).get('r1'))?.role, 'data-2')
    // The store back: the text it had.
    assert.deepEqual(await serviceFor(harness).snapshot({ id: 'r1' }, 'main'), pinned)
  })
})

// --- one report per agent, and the recovery -------------------------------------------------------

/** The warnings that mention `id`, as a count of those that also match `pattern`. */
function count(lines: string[], id: string, pattern: RegExp): number {
  return lines.filter(line => line.includes(id) && pattern.test(line)).length
}

test('an agent served the defaults is reported once, not on every step', async () => {
  await withStore(async (harness) => {
    await userWrite(harness.store, 'main', MAIN_ONE)
    const pinned = await serviceFor(harness).snapshot({ id: 'a1' }, 'main')
    const files = new SnapshotFiles(harness.dirs.agents)
    // A commit the store lost, a store that can not give a head, and the steps of an agent, one after the other.
    await files.put('a2', { role: 'main', commit: 'f'.repeat(40), takenAt: 1 })
    const flaky = readerWith(harness.store, { head: () => Promise.reject(new Error('boom')) })
    const prompts = serviceFor(harness, { store: () => flaky })
    for (let step = 0; step < 5; step++) {
      assert.equal((await prompts.snapshot({ id: 'a2' }, 'main')).commit, null)
    }
    assert.equal(count(harness.warnings, 'a2', /does not have/), 1, harness.warnings.join('\n'))
    assert.equal(count(harness.warnings, 'a2', /shipped defaults for now/), 1, harness.warnings.join('\n'))
    assert.equal(harness.warnings.filter(line => line.includes('a2')).length, 2, harness.warnings.join('\n'))
    // One for an agent that has a record and a store that is gone, too.
    const gone = serviceFor(harness, { store: () => undefined })
    for (let step = 0; step < 5; step++) assert.equal((await gone.snapshot({ id: 'a1' }, 'main')).commit, null)
    assert.equal(count(harness.warnings, 'a1', /shipped defaults for now/), 1, harness.warnings.join('\n'))
    assert.ok(pinned.commit)
  })
})

test('a snapshot file that can not be read is reported once, while the agent is still being served defaults', async () => {
  await withStore(async (harness) => {
    await mkdir(harness.dirs.state, { recursive: true })
    await writeFile(harness.dirs.agents, 'in the way')
    let failing = true
    const flaky = readerWith(harness.store, { head: () => failing ? Promise.reject(new Error('boom')) : harness.store.head() })
    const prompts = serviceFor(harness, { store: () => flaky })
    for (let step = 0; step < 4; step++) await prompts.snapshot({ id: 'a1' }, 'main')
    assert.equal(count(harness.warnings, 'a1', /cannot read the snapshot/), 1, harness.warnings.join('\n'))
    assert.equal(count(harness.warnings, 'a1', /shipped defaults for now/), 1, harness.warnings.join('\n'))

    // A success clears what was said: the same trouble after a drop is reported again.
    failing = false
    await userWrite(harness.store, 'main', MAIN_ONE)
    assert.equal((await prompts.snapshot({ id: 'a1' }, 'main')).prefix, MAIN_ONE)
    await prompts.drop({ id: 'a1' })
    failing = true
    for (let step = 0; step < 3; step++) await prompts.snapshot({ id: 'a1' }, 'main')
    assert.equal(count(harness.warnings, 'a1', /cannot read the snapshot/), 2, harness.warnings.join('\n'))
    assert.equal(count(harness.warnings, 'a1', /shipped defaults for now/), 2, harness.warnings.join('\n'))
  })
})

test('a drop clears what was reported about the agent', async () => {
  await withStore(async (harness) => {
    await new SnapshotFiles(harness.dirs.agents).put('a1', { role: 'main', commit: 'f'.repeat(40), takenAt: 1 })
    const flaky = readerWith(harness.store, { head: () => Promise.reject(new Error('boom')) })
    const prompts = serviceFor(harness, { store: () => flaky })
    for (let step = 0; step < 3; step++) await prompts.snapshot({ id: 'a1' }, 'main')
    assert.equal(count(harness.warnings, 'a1', /does not have/), 1, harness.warnings.join('\n'))
    assert.equal(count(harness.warnings, 'a1', /shipped defaults for now/), 1, harness.warnings.join('\n'))
    // The drop removes the record and what was said about it: the same agent, still without a head, is reported afresh.
    await prompts.drop({ id: 'a1' })
    for (let step = 0; step < 3; step++) await prompts.snapshot({ id: 'a1' }, 'main')
    assert.equal(count(harness.warnings, 'a1', /does not have/), 1, harness.warnings.join('\n'))
    assert.equal(count(harness.warnings, 'a1', /shipped defaults for now/), 2, harness.warnings.join('\n'))
  })
})

test('when a degraded agent is served its own text again, one info line says so', async () => {
  await withStore(async (harness) => {
    await userWrite(harness.store, 'main', MAIN_ONE)
    const pinned = await serviceFor(harness).snapshot({ id: 'a1' }, 'main')
    await userWrite(harness.store, 'main', MAIN_TWO)
    let current: StoreReader | undefined
    const prompts = serviceFor(harness, { store: () => current })
    for (let step = 0; step < 3; step++) await prompts.snapshot({ id: 'a1' }, 'main')
    assert.equal(harness.infos.length, 0)
    current = harness.store
    assert.deepEqual(await prompts.snapshot({ id: 'a1' }, 'main'), pinned)
    assert.equal(harness.infos.length, 1, harness.infos.join('\n'))
    assert.ok(harness.infos[0]!.includes('a1') && harness.infos[0]!.includes(pinned.commit!), harness.infos[0])
    assert.match(harness.infos[0]!, /shipped defaults/)
    // Once: later steps, and a step of an agent that was never degraded, say nothing.
    await prompts.snapshot({ id: 'a1' }, 'main')
    await prompts.snapshot({ id: 'a2' }, 'main')
    assert.equal(harness.infos.length, 1, harness.infos.join('\n'))
  })
})

test('a first snapshot that had to wait for the store is reported when it is finally taken', async () => {
  await withStore(async (harness) => {
    let failing = true
    const flaky = readerWith(harness.store, { head: () => failing ? Promise.reject(new Error('boom')) : harness.store.head() })
    const prompts = serviceFor(harness, { store: () => flaky })
    await userWrite(harness.store, 'main', MAIN_ONE)
    for (let step = 0; step < 3; step++) assert.equal((await prompts.snapshot({ id: 'a1' }, 'main')).commit, null)
    failing = false
    const taken = await prompts.snapshot({ id: 'a1' }, 'main')
    assert.equal(taken.prefix, MAIN_ONE)
    assert.equal(harness.infos.length, 1, harness.infos.join('\n'))
    assert.ok(harness.infos[0]!.includes('a1') && harness.infos[0]!.includes(taken.commit!), harness.infos[0])
    await prompts.snapshot({ id: 'a1' }, 'main')
    assert.equal(harness.infos.length, 1)
  })
})

// --- drop -----------------------------------------------------------------------------------------

test('drop forgets the snapshot, in memory and on disk, so the next call takes a new one', async () => {
  await withStore(async (harness) => {
    const prompts = serviceFor(harness)
    await userWrite(harness.store, 'main', MAIN_ONE)
    await prompts.snapshot({ id: 'a1' }, 'main')
    await prompts.snapshot({ id: 'a2' }, 'main')
    await userWrite(harness.store, 'main', MAIN_TWO)
    assert.equal((await prompts.snapshot({ id: 'a1' }, 'main')).prefix, MAIN_ONE)
    await prompts.drop({ id: 'a1' })
    assert.deepEqual(await readdir(harness.dirs.agents), [snapshotFile('a2')])
    assert.equal((await prompts.snapshot({ id: 'a1' }, 'main')).prefix, MAIN_TWO)
    // Another agent is untouched.
    assert.equal((await prompts.snapshot({ id: 'a2' }, 'main')).prefix, MAIN_ONE)
    // And so is a restart's view of the one that was dropped: the new snapshot is the record.
    assert.equal((await serviceFor(harness).snapshot({ id: 'a1' }, 'main')).prefix, MAIN_TWO)
  })
})

test('drop of an agent that has no snapshot is fine, and so is dropping twice', async () => {
  await withStore(async (harness) => {
    const prompts = serviceFor(harness)
    await prompts.drop({ id: 'nobody' })
    await prompts.snapshot({ id: 'a1' }, 'main')
    await Promise.all([prompts.drop({ id: 'a1' }), prompts.drop({ id: 'a1' })])
    await prompts.drop({ id: 'a1' })
    assert.deepEqual(await readdir(harness.dirs.agents), [])
  })
})

test('drop that can not remove the file logs and resolves', async () => {
  await withStore(async (harness) => {
    const files = spy(new SnapshotFiles(harness.dirs.agents), { drop: () => Promise.reject(new Error('read-only')) })
    const prompts = serviceFor(harness, { files })
    const first = await prompts.snapshot({ id: 'a1' }, 'main')
    await prompts.drop({ id: 'a1' })
    assert.ok(harness.warnings.some(line => line.includes('read-only') && line.includes('a1')), harness.warnings.join('\n'))
    // The memory is forgotten all the same, so the next call reads the file, which is still there.
    assert.equal(files.calls.get, 1)
    assert.deepEqual(await prompts.snapshot({ id: 'a1' }, 'main'), first)
    assert.equal(files.calls.get, 2)
  })
})

test('drop of something that is not an agent logs and resolves', async () => {
  await withStore(async (harness) => {
    const prompts = serviceFor(harness)
    await prompts.drop(undefined as unknown as { id: string })
    await prompts.drop({} as { id: string })
    assert.equal(harness.warnings.length, 2, harness.warnings.join('\n'))
  })
})

test('a drop while the first snapshot is in flight leaves no file behind, and the next call takes a new one', async () => {
  await withStore(async (harness) => {
    const prompts = serviceFor(harness)
    await userWrite(harness.store, 'main', MAIN_ONE)
    const taking = prompts.snapshot({ id: 'a1' }, 'main')
    const dropping = prompts.drop({ id: 'a1' })
    await Promise.all([taking, dropping])
    assert.equal((await taking).prefix, MAIN_ONE)
    // The first snapshot's write can't land after the drop removed the file.
    assert.deepEqual(await readdir(harness.dirs.agents), [])
    await userWrite(harness.store, 'main', MAIN_TWO)
    assert.equal((await prompts.snapshot({ id: 'a1' }, 'main')).prefix, MAIN_TWO)
  })
})

test('a call that arrives while a drop is working waits for it and takes a snapshot of its own', async () => {
  await withStore(async (harness) => {
    const prompts = serviceFor(harness)
    await userWrite(harness.store, 'main', MAIN_ONE)
    await prompts.snapshot({ id: 'a1' }, 'main')
    const dropping = prompts.drop({ id: 'a1' })
    const after = prompts.snapshot({ id: 'a1' }, 'main')
    await Promise.all([dropping, after])
    // Its record survived the drop, because the drop was over before it looked.
    assert.deepEqual(await readdir(harness.dirs.agents), [snapshotFile('a1')])
    await userWrite(harness.store, 'main', MAIN_TWO)
    assert.deepEqual(await serviceFor(harness).snapshot({ id: 'a1' }, 'main'), await after)
  })
})
