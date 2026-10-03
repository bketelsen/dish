import { test } from 'node:test'
import assert from 'node:assert/strict'
import { access, chmod, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { format } from 'node:util'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { ensureScratch } from '../src/scratch.ts'
import type { ScratchOptions } from '../src/scratch.ts'
import { scratchRecordFile } from '../src/paths.ts'
import type { WorkspaceRegistryLike } from '../src/registry.ts'
import { mountRegistry } from './registry-helpers.ts'
import type { MountedRegistry } from './registry-helpers.ts'
import { tempDir } from './helpers.ts'

interface Setup {
  dir: string
  workRoot: string
  scratch: string
  record: string
  warnings: string[]
  /** `ensureScratch` over `registry` with this setup's paths and logger, and the caller's `logged` set when one is given. */
  run(registry: WorkspaceRegistryLike, logged?: Set<string>): ReturnType<typeof ensureScratch>
}

/** `linkedWorkRoot`: the work root is a symlink to a directory beside it, as `/home` is to `/var/home` on this host. */
async function setup(settings: { linkedWorkRoot?: boolean } = {}): Promise<Setup> {
  const dir = await tempDir()
  const workRoot = join(dir, 'work')
  if (settings.linkedWorkRoot) {
    await mkdir(join(dir, 'real-work'))
    await symlink(join(dir, 'real-work'), workRoot)
  }
  const state = join(dir, 'state')
  const warnings: string[] = []
  const options = (registry: WorkspaceRegistryLike, logged?: Set<string>): ScratchOptions => ({
    registry,
    workRoot,
    record: scratchRecordFile(state),
    logger: { warn: (...args: [string, ...unknown[]]) => { warnings.push(format(...args)) } },
    ...(logged ? { logged } : {}),
  })
  return {
    dir, workRoot, scratch: join(workRoot, 'scratch'), record: scratchRecordFile(state), warnings,
    run: (registry, logged) => ensureScratch(options(registry, logged)),
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** `body` with dsh's real registry mounted over `s.dir`, unmounted however it ends. */
async function withRegistry(s: Setup, body: (mounted: MountedRegistry) => Promise<void>): Promise<void> {
  const mounted = await mountRegistry(s.dir)
  try {
    await body(mounted)
  } finally {
    await mounted.stop()
  }
}

test('first start: <work root>/scratch is made, registered as "scratch", and recorded as JSON', async () => {
  const s = await setup()
  await withRegistry(s, async ({ registry }) => {
    const before = Date.now()
    assert.equal(await s.run(registry), 'registered')
    const after = Date.now()

    const info = await stat(s.scratch)
    assert.ok(info.isDirectory())
    assert.equal(info.mode & 0o777, 0o700)

    const [workspace] = registry.list()
    assert.equal(registry.list().length, 1)
    assert.equal(workspace!.path, s.scratch)
    assert.equal(workspace!.title, 'scratch')

    const record = JSON.parse(await readFile(s.record, 'utf8')) as { path: unknown, workspace: unknown, at: unknown }
    assert.deepEqual(Object.keys(record).sort(), ['at', 'path', 'workspace'])
    assert.equal(record.path, s.scratch)
    assert.equal(record.workspace, workspace!.id)
    assert.ok(typeof record.at === 'number' && record.at >= before && record.at <= after, 'at is the time, in ms')
    assert.equal((await stat(s.record)).mode & 0o777, 0o600)
    assert.deepEqual(s.warnings, [])
  })
})

test('the record holds the path dsh holds: the real one, when the work root is a symlink', async () => {
  const s = await setup({ linkedWorkRoot: true })
  await withRegistry(s, async ({ registry }) => {
    assert.equal(await s.run(registry), 'registered')
    const real = await realpath(s.scratch)
    assert.notEqual(real, s.scratch, 'the fixture links')
    const [workspace] = registry.list()
    assert.equal(workspace!.path, real)
    const record = JSON.parse(await readFile(s.record, 'utf8')) as { path: string, workspace: string }
    assert.equal(record.path, workspace!.path)
    assert.equal(record.workspace, workspace!.id)
  })
})

test('an adopted workspace is recorded at its real path too', async () => {
  const s = await setup({ linkedWorkRoot: true })
  await withRegistry(s, async ({ registry }) => {
    await mkdir(s.scratch, { recursive: true })
    const mine = await registry.create(s.scratch, 'mine')
    assert.equal(await s.run(registry), 'adopted')
    const record = JSON.parse(await readFile(s.record, 'utf8')) as { path: string }
    assert.equal(record.path, mine.path)
    assert.equal(record.path, await realpath(s.scratch))
  })
})

test('a workspace already at that path is adopted, titled as it was, and recorded', async () => {
  const s = await setup()
  await withRegistry(s, async ({ registry }) => {
    await mkdir(s.scratch, { recursive: true })
    const mine = await registry.create(s.scratch, 'mine')
    assert.equal(await s.run(registry), 'adopted')
    assert.equal(registry.list().length, 1)
    assert.equal(registry.get(mine.id)?.title, 'mine')
    const record = JSON.parse(await readFile(s.record, 'utf8')) as { workspace: string }
    assert.equal(record.workspace, mine.id)
  })
})

test('an existing directory with no workspace is registered, and its mode and contents are left alone', async () => {
  const s = await setup()
  await withRegistry(s, async ({ registry }) => {
    await mkdir(s.scratch, { recursive: true, mode: 0o755 })
    await writeFile(join(s.scratch, 'notes.txt'), 'keep me')
    assert.equal(await s.run(registry), 'registered')
    assert.equal(await readFile(join(s.scratch, 'notes.txt'), 'utf8'), 'keep me')
    assert.equal((await stat(s.scratch)).mode & 0o777, 0o755)
    assert.equal(registry.list()[0]?.title, 'scratch')
  })
})

test('once recorded, a later call does nothing', async () => {
  const s = await setup()
  await withRegistry(s, async ({ registry }) => {
    assert.equal(await s.run(registry), 'registered')
    const recorded = await readFile(s.record, 'utf8')
    const ids = registry.list().map(workspace => workspace.id)
    assert.equal(await s.run(registry), 'recorded-before')
    assert.deepEqual(registry.list().map(workspace => workspace.id), ids)
    assert.equal(await readFile(s.record, 'utf8'), recorded, 'the record is not rewritten')
  })
})

test('a scratch workspace the user removes stays removed', async () => {
  const s = await setup()
  await withRegistry(s, async ({ registry }) => {
    assert.equal(await s.run(registry), 'registered')
    const [workspace] = registry.list()
    assert.equal(await registry.delete(workspace!.id), true)
    assert.equal(registry.list().length, 0)

    assert.equal(await s.run(registry), 'recorded-before')
    assert.equal(registry.list().length, 0, 'it stays deleted')
    assert.ok(await exists(s.scratch), 'its directory is untouched')
  })
})

test('deleting the record brings the scratch workspace back, as a new registration', async () => {
  const s = await setup()
  await withRegistry(s, async ({ registry }) => {
    assert.equal(await s.run(registry), 'registered')
    const first = registry.list()[0]!
    await registry.delete(first.id)
    await rm(s.record)

    assert.equal(await s.run(registry), 'registered')
    assert.equal(registry.list().length, 1)
    const second = registry.list()[0]!
    assert.notEqual(second.id, first.id)
    assert.equal(second.title, 'scratch')
    assert.equal((JSON.parse(await readFile(s.record, 'utf8')) as { workspace: string }).workspace, second.id)
  })
})

test('deleting the record while the workspace is still registered adopts it, and does not add another', async () => {
  const s = await setup()
  await withRegistry(s, async ({ registry }) => {
    assert.equal(await s.run(registry), 'registered')
    const first = registry.list()[0]!
    await first.setTitle('renamed')
    await rm(s.record)
    assert.equal(await s.run(registry), 'adopted')
    assert.equal(registry.list().length, 1)
    assert.equal(registry.list()[0]!.id, first.id)
    assert.equal(registry.list()[0]!.title, 'renamed')
  })
})

test('a restart: the registry and the record are on disk, so a second start does nothing, and a removal survives it', async () => {
  const s = await setup()
  const first = await mountRegistry(s.dir)
  let id: string
  try {
    assert.equal(await s.run(first.registry), 'registered')
    id = first.registry.list()[0]!.id
  } finally {
    await first.stop()
  }

  const second = await mountRegistry(s.dir)
  try {
    assert.deepEqual(second.registry.list().map(workspace => workspace.id), [id], 'dsh kept it')
    assert.equal(await s.run(second.registry), 'recorded-before')
    assert.equal(await second.registry.delete(WorkspaceId(id)), true)
  } finally {
    await second.stop()
  }

  const third = await mountRegistry(s.dir)
  try {
    assert.equal(third.registry.list().length, 0)
    assert.equal(await s.run(third.registry), 'recorded-before')
    assert.equal(third.registry.list().length, 0, 'removed stays removed across restarts')
  } finally {
    await third.stop()
  }
})

test('with a record, nothing is made: not the work root, not the directory', async () => {
  const s = await setup()
  await withRegistry(s, async ({ registry }) => {
    await mkdir(join(s.record, '..'), { recursive: true })
    await writeFile(s.record, JSON.stringify({ path: s.scratch, workspace: 'gone', at: 1 }))
    assert.equal(await s.run(registry), 'recorded-before')
    assert.equal(await exists(s.workRoot), false)
    assert.equal(registry.list().length, 0)
  })
})

test('a record that does not parse is still a record: scratch is not registered again', async () => {
  const s = await setup()
  await withRegistry(s, async ({ registry }) => {
    await mkdir(join(s.record, '..'), { recursive: true })
    await writeFile(s.record, '')
    assert.equal(await s.run(registry), 'recorded-before')
    assert.equal(registry.list().length, 0)
    assert.deepEqual(s.warnings, [])
  })
})

/** A registry whose every method rejects (or throws) with `error`. */
function failingRegistry(error: () => Error): WorkspaceRegistryLike {
  return {
    create: () => Promise.reject(error()),
    resolveByPath: () => Promise.reject(error()),
    get: () => { throw error() },
    list: () => { throw error() },
  }
}

test('a registry that throws gives "failed", never throws, and writes no record', async () => {
  const s = await setup()
  const registry = failingRegistry(() => new Error('the domain is not open'))
  assert.equal(await s.run(registry), 'failed')
  assert.equal(s.warnings.length, 1)
  assert.match(s.warnings[0]!, /scratch/)
  assert.match(s.warnings[0]!, /the domain is not open/)
  assert.equal(await exists(s.record), false, 'no record: the next start tries again')
})

test('a failure that repeats is logged once when the caller keeps the set, and a different one is logged too', async () => {
  const s = await setup()
  const logged = new Set<string>()
  const registry = failingRegistry(() => new Error('the domain is not open'))
  assert.equal(await s.run(registry, logged), 'failed')
  assert.equal(await s.run(registry, logged), 'failed')
  assert.equal(s.warnings.length, 1, 'twice gives one line')

  assert.equal(await s.run(failingRegistry(() => new Error('something else broke')), logged), 'failed')
  assert.equal(s.warnings.length, 2)
  assert.match(s.warnings[1]!, /something else broke/)
})

test('the set is the caller\'s: a new one (a plugin reload) logs again, and with none every call logs', async () => {
  const s = await setup()
  const registry = failingRegistry(() => new Error('the domain is not open'))
  const first = new Set<string>()
  assert.equal(await s.run(registry, first), 'failed')
  assert.equal(await s.run(registry, first), 'failed')
  assert.equal(s.warnings.length, 1)
  assert.ok(first.size > 0, 'the set holds what was logged')

  assert.equal(await s.run(registry, new Set()), 'failed')
  assert.equal(s.warnings.length, 2, 'a plugin that reloads starts with a set of its own')

  assert.equal(await s.run(registry), 'failed')
  assert.equal(await s.run(registry), 'failed')
  assert.equal(s.warnings.length, 4, 'without a set nothing is remembered between calls')
})

test('the same failure for another record is logged again', async () => {
  const a = await setup()
  const b = await setup()
  const logged = new Set<string>()
  const registry = failingRegistry(() => new Error('the domain is not open'))
  assert.equal(await a.run(registry, logged), 'failed')
  assert.equal(await b.run(registry, logged), 'failed')
  assert.equal(a.warnings.length + b.warnings.length, 2)
})

test('a failure is retried at the next start: once the registry works, scratch is registered', async () => {
  const s = await setup()
  assert.equal(await s.run(failingRegistry(() => new Error('not yet'))), 'failed')
  await withRegistry(s, async ({ registry }) => {
    assert.equal(await s.run(registry), 'registered')
    assert.equal(registry.list().length, 1)
  })
})

test('a record that cannot be written is "failed"; the registration is kept and adopted by the next start', { skip: process.getuid?.() === 0 && 'root can write anywhere' }, async () => {
  const s = await setup()
  await withRegistry(s, async ({ registry }) => {
    const directory = join(s.record, '..')
    await mkdir(directory, { recursive: true })
    await chmod(directory, 0o500)
    try {
      assert.equal(await s.run(registry), 'failed')
      assert.equal(s.warnings.length, 1)
      // The error names the temporary file, whose name is random; under a long TMPDIR the cut may come before it.
      assert.match(s.warnings[0]!, /could not set up the scratch workspace: EACCES/)
      assert.equal(registry.list().length, 1, 'registered, but not recorded')
      assert.equal(await exists(s.record), false)
    } finally {
      await chmod(directory, 0o700)
    }

    assert.equal(await s.run(registry), 'adopted')
    assert.equal(registry.list().length, 1)
    assert.ok(await exists(s.record))
  })
})

test('a record write that fails the same way every time is logged once, whatever the temporary file is called', { skip: process.getuid?.() === 0 && 'root can write anywhere' }, async () => {
  const s = await setup()
  await withRegistry(s, async ({ registry }) => {
    const directory = join(s.record, '..')
    await mkdir(directory, { recursive: true })
    await chmod(directory, 0o500)
    try {
      const logged = new Set<string>()
      for (let attempt = 0; attempt < 3; attempt++) assert.equal(await s.run(registry, logged), 'failed')
      assert.equal(s.warnings.length, 1, 'three starts, one line')
    } finally {
      await chmod(directory, 0o700)
    }
  })
})

test('a failure whose message is cut inside the temporary file\'s name is still one line', async () => {
  // Wherever the 200-character cut falls (a long TMPDIR moves it), the random part of the name doesn't make it a new error.
  for (const pad of [170, 185, 190, 196]) {
    const s = await setup()
    const logged = new Set<string>()
    let attempt = 0
    const registry = failingRegistry(() => new Error(`EACCES: open '/${'d'.repeat(pad)}/.scratch.${(++attempt).toString(16)}${'b'.repeat(11)}.tmp'`))
    for (let run = 0; run < 3; run++) assert.equal(await s.run(registry, logged), 'failed')
    assert.equal(s.warnings.length, 1, `cut at ${pad}: ${s.warnings.join('\n')}`)
  }
})

test('a record whose state is unreadable (its directory is a file) is "failed" before anything is registered', async () => {
  const s = await setup()
  await withRegistry(s, async ({ registry }) => {
    // <state>/workspaces is a file: whether a record exists can't be told, so nothing is done.
    await mkdir(join(s.record, '..', '..'), { recursive: true })
    await writeFile(join(s.record, '..'), 'in the way')
    assert.equal(await s.run(registry), 'failed')
    assert.equal(s.warnings.length, 1)
    assert.equal(registry.list().length, 0)
    assert.equal(await exists(s.scratch), false)
  })
})

test('a work root that is a file, or a scratch that is a file, is "failed" and does not throw', async () => {
  const s = await setup()
  await withRegistry(s, async ({ registry }) => {
    await writeFile(s.workRoot, 'not a directory')
    assert.equal(await s.run(registry), 'failed')
    assert.equal(s.warnings.length, 1)
    assert.equal(registry.list().length, 0)
    assert.equal(await exists(s.record), false)

    await rm(s.workRoot)
    await mkdir(s.workRoot)
    await writeFile(s.scratch, 'not a directory either')
    assert.equal(await s.run(registry), 'failed')
    assert.equal(s.warnings.length, 2)
    assert.equal(registry.list().length, 0)
  })
})

test('an error text with a token in it is masked in the log line', async () => {
  const s = await setup()
  const token = `ghs_${'Ab1Cd2Ef3G'.repeat(4)}`
  assert.equal(await s.run(failingRegistry(() => new Error(`boom ${token}`))), 'failed')
  assert.equal(s.warnings.length, 1)
  assert.ok(!s.warnings[0]!.includes(token))
})
