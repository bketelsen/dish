import { test } from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, open, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SnapshotFiles, TEMP_GRACE_MS } from '../src/snapshots.ts'
import type { SnapshotRecord } from '../src/snapshots.ts'

const DAY = 24 * 60 * 60 * 1000
const COMMIT = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const RECORD: SnapshotRecord = { role: 'main', commit: COMMIT, takenAt: 1_790_000_000_000 }

const hash = (id: string): string => createHash('sha256').update(id).digest('hex')

/** Values that are not a snapshot record: anything JSON can hold (or `put` is handed) that `get` must refuse. */
const BAD_SHAPES: unknown[] = [
  null, 5, 'main', true, [], [RECORD], {},
  { ...RECORD, role: '' },
  { ...RECORD, role: 7 },
  { ...RECORD, role: null },
  { commit: COMMIT, takenAt: 1 },
  { ...RECORD, commit: undefined },
  { role: 'main', takenAt: 1 },
  { ...RECORD, commit: '' },
  { ...RECORD, commit: COMMIT.slice(1) },
  { ...RECORD, commit: `${COMMIT}0` },
  { ...RECORD, commit: COMMIT.toUpperCase() },
  { ...RECORD, commit: `g${COMMIT.slice(1)}` },
  { ...RECORD, commit: 5 },
  { ...RECORD, takenAt: '1' },
  { ...RECORD, takenAt: null },
  { ...RECORD, takenAt: undefined },
  { role: 'main', commit: null },
]

/**
 * Run `body` with a fresh temp directory and a `SnapshotFiles` over a directory inside it that doesn't exist yet.
 * `invalid` collects the ids `onInvalid` was called with.
 */
async function withFiles(body: (files: SnapshotFiles, directory: string, root: string, invalid: string[]) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'dish-prompts-snapshots-'))
  try {
    const directory = join(root, 'state', 'agents')
    const invalid: string[] = []
    await body(new SnapshotFiles(directory, id => { invalid.push(id) }), directory, root, invalid)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

/** Set a file's atime and mtime to `ageMs` ago. */
async function backdate(path: string, ageMs: number): Promise<void> {
  const then = new Date(Date.now() - ageMs)
  await utimes(path, then, then)
}

test('a record round-trips, and a null commit survives', () => withFiles(async (files) => {
  await files.put('a1', RECORD)
  assert.deepEqual(await files.get('a1'), RECORD)
  const bare: SnapshotRecord = { role: 'coder', commit: null, takenAt: 5 }
  await files.put('a2', bare)
  assert.deepEqual(await files.get('a2'), bare)
  assert.deepEqual(await files.get('a1'), RECORD)
}))

test('an agent with no record, or a directory that does not exist yet, reads as undefined, and is not invalid', () => withFiles(async (files, directory, _root, invalid) => {
  assert.equal(await files.get('nobody'), undefined)
  await files.put('a1', RECORD)
  assert.equal(await files.get('nobody'), undefined)
  assert.deepEqual(await files.get('a1'), RECORD)
  assert.ok((await stat(directory)).isDirectory())
  assert.deepEqual(invalid, [])
}))

test('put overwrites the agent\'s record', () => withFiles(async (files, directory) => {
  await files.put('a1', RECORD)
  const later: SnapshotRecord = { role: 'main', commit: null, takenAt: RECORD.takenAt + 1 }
  await files.put('a1', later)
  assert.deepEqual(await files.get('a1'), later)
  assert.deepEqual(await readdir(directory), [`${hash('a1')}.json`])
}))

test('the file name is the hash of the id, never the id', () => withFiles(async (files, directory, root) => {
  const ids = ['a1', '../../escape', 'a/b/c', '..', '/etc/passwd', 'x\0y', 'ünïcode 🐟', '']
  for (const id of ids) await files.put(id, RECORD)
  assert.deepEqual((await readdir(directory)).sort(), ids.map(id => `${hash(id)}.json`).sort())
  for (const id of ids) assert.deepEqual(await files.get(id), RECORD)
  // Nothing was written outside the directory.
  assert.deepEqual(await readdir(join(root, 'state')), ['agents'])
  assert.deepEqual(await readdir(root), ['state'])
  // And the hash is of the id's UTF-8, as sha256 hex.
  assert.match(hash('a1'), /^[0-9a-f]{64}$/)
  assert.equal(JSON.parse(await readFile(join(directory, `${hash('a1')}.json`), 'utf8')).role, 'main')
}))

test('the directory is created private, and so is the file', () => withFiles(async (files, directory, root) => {
  await files.put('a1', RECORD)
  assert.equal((await stat(directory)).mode & 0o777, 0o700)
  assert.equal((await stat(join(root, 'state'))).mode & 0o777, 0o700)
  assert.equal((await stat(join(directory, `${hash('a1')}.json`))).mode & 0o777, 0o600)
}))

test('put leaves no temp file behind, even when several puts for one agent race', () => withFiles(async (files, directory) => {
  const records = Array.from({ length: 12 }, (_, i): SnapshotRecord => ({ role: 'main', commit: null, takenAt: i }))
  await Promise.all(records.map(record => files.put('a1', record)))
  assert.deepEqual(await readdir(directory), [`${hash('a1')}.json`])
  const winner = await files.get('a1')
  assert.ok(winner !== undefined && records.some(record => record.takenAt === winner.takenAt))
}))

test('a failed put leaves nothing behind and does not disturb the existing record', () => withFiles(async (files, directory) => {
  await files.put('a1', RECORD)
  // A directory where the file belongs makes the rename fail.
  const blocked = `${hash('blocked')}.json`
  await mkdir(join(directory, blocked))
  await assert.rejects(files.put('blocked', RECORD))
  assert.deepEqual((await readdir(directory)).sort(), [`${hash('a1')}.json`, blocked].sort())
  assert.deepEqual(await files.get('a1'), RECORD)
}))

test('drop removes the record, and dropping a missing one is fine', () => withFiles(async (files, directory) => {
  await files.drop('a1') // no directory yet
  await files.put('a1', RECORD)
  await files.put('a2', RECORD)
  await files.drop('a1')
  assert.equal(await files.get('a1'), undefined)
  assert.deepEqual(await files.get('a2'), RECORD)
  await files.drop('a1') // gone already
  assert.deepEqual(await readdir(directory), [`${hash('a2')}.json`])
}))

test('a file that does not parse reads as undefined, is reported, and the next put replaces it', () => withFiles(async (files, directory, _root, invalid) => {
  await files.put('a1', RECORD)
  const file = join(directory, `${hash('a1')}.json`)
  const texts = ['', '{', 'not json', '{"role": "main", "commit": null, "takenAt": 1', '\0\0\0']
  for (const [i, text] of texts.entries()) {
    await writeFile(file, text)
    assert.equal(await files.get('a1'), undefined, JSON.stringify(text))
    assert.equal(invalid.length, i + 1, JSON.stringify(text))
  }
  assert.deepEqual(invalid, texts.map(() => 'a1'))
  await files.put('a1', RECORD)
  assert.deepEqual(await files.get('a1'), RECORD)
  assert.equal(invalid.length, texts.length)
}))

test('a file of the wrong shape reads as undefined, and is reported', () => withFiles(async (files, directory, _root, invalid) => {
  const file = join(directory, `${hash('a1')}.json`)
  await files.put('a1', RECORD)
  for (const [i, value] of BAD_SHAPES.entries()) {
    await writeFile(file, JSON.stringify(value) ?? '')
    assert.equal(await files.get('a1'), undefined, JSON.stringify(value))
    assert.equal(invalid.length, i + 1, JSON.stringify(value))
  }
  // A number JSON can't hold is not a finite takenAt either.
  await writeFile(file, '{"role":"main","commit":null,"takenAt":1e999}')
  assert.equal(await files.get('a1'), undefined)
  assert.equal(invalid.length, BAD_SHAPES.length + 1)
  assert.ok(invalid.every(id => id === 'a1'))
  // The right shape with extras reads as just the record, and is not reported.
  await writeFile(file, JSON.stringify({ ...RECORD, extra: 'x' }))
  assert.deepEqual(await files.get('a1'), RECORD)
  assert.equal(invalid.length, BAD_SHAPES.length + 1)
}))

test('an I/O error other than a missing file is thrown, and is not a report', () => withFiles(async (files, directory, _root, invalid) => {
  // A directory where the record belongs: reading it fails with EISDIR.
  await mkdir(join(directory, `${hash('a1')}.json`), { recursive: true })
  await assert.rejects(files.get('a1'), { code: 'EISDIR' })
  assert.deepEqual(invalid, [])
}))

test('put refuses a record get would refuse, and writes nothing', () => withFiles(async (files, directory) => {
  const bad: unknown[] = [
    ...BAD_SHAPES,
    { ...RECORD, takenAt: Number.NaN },
    { ...RECORD, takenAt: Number.POSITIVE_INFINITY },
    { ...RECORD, takenAt: Number.NEGATIVE_INFINITY },
  ]
  for (const value of bad) {
    await assert.rejects(files.put('a1', value as SnapshotRecord), TypeError, String(JSON.stringify(value)))
  }
  await assert.rejects(stat(directory), { code: 'ENOENT' })
  // What get accepts, put writes: an unusual role, an extreme number, a null commit, and extras are dropped.
  const odd: SnapshotRecord = { role: 'a role with spaces/and 🐟', commit: null, takenAt: -1.5e300 }
  await files.put('a1', { ...odd, extra: 'x' } as SnapshotRecord)
  assert.deepEqual(await files.get('a1'), odd)
  assert.deepEqual(JSON.parse(await readFile(join(directory, `${hash('a1')}.json`), 'utf8')), odd)
}))

test('get refreshes the mtime, and only for a record it could read', () => withFiles(async (files, directory, _root, invalid) => {
  await files.put('good', RECORD)
  await files.put('bad', RECORD)
  const good = join(directory, `${hash('good')}.json`)
  const bad = join(directory, `${hash('bad')}.json`)
  await writeFile(bad, '{')
  await backdate(good, 100 * DAY)
  await backdate(bad, 100 * DAY)
  const before = Date.now()
  assert.deepEqual(await files.get('good'), RECORD)
  const touched = await stat(good)
  assert.ok(touched.mtimeMs >= before - 2_000 && touched.mtimeMs <= Date.now() + 2_000, `mtime ${touched.mtimeMs}`)
  assert.ok(touched.atimeMs >= before - 2_000, `atime ${touched.atimeMs}`)
  assert.equal(await files.get('bad'), undefined)
  assert.deepEqual(invalid, ['bad'])
  assert.ok(Date.now() - (await stat(bad)).mtimeMs > 99 * DAY)
  // Which is what keeps a record that is read from being pruned.
  assert.equal(await files.prune(30 * DAY), 1)
  assert.deepEqual(await files.get('good'), RECORD)
}))

test('prune removes the records not touched for maxAgeMs, and returns how many', () => withFiles(async (files, directory) => {
  for (const id of ['old1', 'old2', 'fresh', 'edge']) await files.put(id, RECORD)
  await backdate(join(directory, `${hash('old1')}.json`), 200 * DAY)
  await backdate(join(directory, `${hash('old2')}.json`), 181 * DAY)
  await backdate(join(directory, `${hash('edge')}.json`), 179 * DAY)
  assert.equal(await files.prune(180 * DAY), 2)
  assert.equal(await files.get('old1'), undefined)
  assert.equal(await files.get('old2'), undefined)
  assert.deepEqual(await files.get('edge'), RECORD)
  assert.deepEqual(await files.get('fresh'), RECORD)
  assert.deepEqual((await readdir(directory)).sort(), [`${hash('edge')}.json`, `${hash('fresh')}.json`].sort())
  assert.equal(await files.prune(180 * DAY), 0)
}))

test('prune leaves a fresh temp file alone: it may be another process\'s put in flight', () => withFiles(async (files, directory) => {
  await files.put('a1', RECORD)
  const fresh = `.${hash('a2')}.0123456789abcdef.tmp`
  const recent = `.${hash('a3')}.fedcba9876543210.tmp`
  await writeFile(join(directory, fresh), '{"role":')
  await writeFile(join(directory, recent), '')
  await backdate(join(directory, recent), TEMP_GRACE_MS - 5 * 60 * 1000)
  await backdate(join(directory, `${hash('a1')}.json`), 60 * 1000)
  // Not even maxAgeMs = 0 takes a temp file inside its grace.
  assert.equal(await files.prune(0), 1) // the record only
  assert.deepEqual((await readdir(directory)).sort(), [fresh, recent].sort())
}))

test('prune removes a stray temp file past its grace, whatever maxAgeMs is, and counts it', () => withFiles(async (files, directory) => {
  assert.equal(TEMP_GRACE_MS, 60 * 60 * 1000)
  await files.put('a1', RECORD)
  const stale = `.${hash('a2')}.0123456789abcdef.tmp`
  const ancient = `.${hash('a3')}.fedcba9876543210.tmp`
  const fresh = `.${hash('a4')}.0011223344556677.tmp`
  await writeFile(join(directory, stale), '{"role":')
  await writeFile(join(directory, ancient), '')
  await writeFile(join(directory, fresh), '')
  await backdate(join(directory, stale), TEMP_GRACE_MS + 5 * 60 * 1000)
  await backdate(join(directory, ancient), 400 * DAY)
  assert.equal(await files.prune(180 * DAY), 2)
  assert.deepEqual((await readdir(directory)).sort(), [fresh, `${hash('a1')}.json`].sort())
  assert.deepEqual(await files.get('a1'), RECORD)
}))

test('prune leaves everything that is not a snapshot file alone, however old', () => withFiles(async (files, directory) => {
  const mine = `${hash('mine')}.json`
  const others = [
    'notes.json',
    'README',
    '.hidden',
    `${hash('x')}.json.bak`,
    `${hash('x').toUpperCase()}.json`,
    `${hash('x').slice(1)}.json`,
    `${hash('x')}0.json`,
    `.${hash('x')}.tmp`,
    `.${hash('x')}.zz.tmp`,
    `.${hash('x')}.0123456789abcdef.tmp.keep`,
    `${hash('x')}.0123456789abcdef.tmp`,
  ]
  await files.put('mine', RECORD)
  for (const name of others) await writeFile(join(directory, name), 'x')
  // A directory, and a symlink-free look-alike: neither is a regular file of ours.
  const folder = `${hash('dir')}.json`
  await mkdir(join(directory, folder))
  await mkdir(join(directory, `.${hash('dir')}.0123456789abcdef.tmp`))
  for (const name of [mine, ...others, folder, `.${hash('dir')}.0123456789abcdef.tmp`]) await backdate(join(directory, name), 1_000 * DAY)
  assert.equal(await files.prune(1), 1)
  assert.deepEqual((await readdir(directory)).sort(), [...others, folder, `.${hash('dir')}.0123456789abcdef.tmp`].sort())
}))

test('prune on a directory that does not exist is a no-op', () => withFiles(async (files, directory) => {
  assert.equal(await files.prune(DAY), 0)
  await assert.rejects(stat(directory), { code: 'ENOENT' })
}))

test('prune refuses a maxAgeMs that would delete everything, and deletes nothing', () => withFiles(async (files, directory) => {
  await assert.rejects(files.prune(Number.NaN), RangeError) // before the directory even exists
  await files.put('a1', RECORD)
  await backdate(join(directory, `${hash('a1')}.json`), 1_000 * DAY)
  for (const bad of [Number.NaN, -1, -DAY, Number.NEGATIVE_INFINITY, undefined as unknown as number]) {
    await assert.rejects(files.prune(bad), RangeError, String(bad))
  }
  assert.deepEqual(await readdir(directory), [`${hash('a1')}.json`])
  // 0 and Infinity are allowed: everything not touched just now, and nothing.
  assert.equal(await files.prune(Number.POSITIVE_INFINITY), 0)
  assert.equal(await files.prune(0), 1)
}))

/**
 * Spy on `FileHandle.prototype.sync` (calling through), recording the directory's listing at each call.
 * `fail` is the 1-based call to reject. Returns the listings.
 */
async function spyOnSync(t: TestContext, directory: string, fail?: number): Promise<string[][]> {
  const probe = await open(join(directory, '..', 'probe'), 'w')
  const prototype = Object.getPrototypeOf(probe) as { sync(): Promise<void> }
  await probe.close()
  const original = prototype.sync
  const listings: string[][] = []
  t.mock.method(prototype, 'sync', async function (this: unknown) {
    listings.push((await readdir(directory)).sort())
    if (fail === listings.length) throw new Error('sync failed')
    return original.call(this)
  })
  return listings
}

test('put syncs the file before the rename, and then the directory', async (t) => {
  await withFiles(async (files, directory) => {
    await files.put('a0', RECORD) // makes the directory
    await rm(join(directory, `${hash('a0')}.json`))
    const listings = await spyOnSync(t, directory)
    await files.put('a1', RECORD)
    const record = `${hash('a1')}.json`
    assert.equal(listings.length, 2)
    // The first sync sees only the temp file: it is on disk before it becomes the record.
    assert.equal(listings[0]?.length, 1)
    assert.match(listings[0]?.[0] ?? '', new RegExp(`^\\.${hash('a1')}\\.[0-9a-f]{16}\\.tmp$`))
    // The second sees only the record: the directory entry is synced after the rename.
    assert.deepEqual(listings[1], [record])
    assert.deepEqual(await files.get('a1'), RECORD)
  })
})

test('a failed file sync fails the put and leaves nothing; a failed directory sync does not', async (t) => {
  await withFiles(async (files, directory) => {
    await files.put('a0', RECORD)
    await rm(join(directory, `${hash('a0')}.json`))
    const fileSync = await spyOnSync(t, directory, 1)
    await assert.rejects(files.put('a1', RECORD), /sync failed/)
    assert.equal(fileSync.length, 1)
    assert.deepEqual(await readdir(directory), [])
    t.mock.restoreAll()
    const dirSync = await spyOnSync(t, directory, 2)
    await files.put('a1', RECORD)
    assert.equal(dirSync.length, 2)
    assert.deepEqual(await files.get('a1'), RECORD)
  })
})
