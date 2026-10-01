import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SnapshotFiles } from '../src/snapshots.ts'
import type { SnapshotRecord } from '../src/snapshots.ts'

const DAY = 24 * 60 * 60 * 1000
const COMMIT = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const RECORD: SnapshotRecord = { role: 'main', commit: COMMIT, takenAt: 1_790_000_000_000 }

const hash = (id: string): string => createHash('sha256').update(id).digest('hex')

/** Run `body` with a fresh temp directory and a `SnapshotFiles` over a directory inside it that doesn't exist yet. */
async function withFiles(body: (files: SnapshotFiles, directory: string, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'dish-prompts-snapshots-'))
  try {
    const directory = join(root, 'state', 'agents')
    await body(new SnapshotFiles(directory), directory, root)
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

test('an agent with no record, or a directory that does not exist yet, reads as undefined', () => withFiles(async (files, directory) => {
  assert.equal(await files.get('nobody'), undefined)
  await files.put('a1', RECORD)
  assert.equal(await files.get('nobody'), undefined)
  assert.ok((await stat(directory)).isDirectory())
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

test('a file that does not parse reads as undefined, and the next put replaces it', () => withFiles(async (files, directory) => {
  await files.put('a1', RECORD)
  const file = join(directory, `${hash('a1')}.json`)
  for (const text of ['', '{', 'not json', '{"role": "main", "commit": null, "takenAt": 1', '\0\0\0']) {
    await writeFile(file, text)
    assert.equal(await files.get('a1'), undefined, JSON.stringify(text))
  }
  await files.put('a1', RECORD)
  assert.deepEqual(await files.get('a1'), RECORD)
}))

test('a file of the wrong shape reads as undefined', () => withFiles(async (files, directory) => {
  const file = join(directory, `${hash('a1')}.json`)
  await files.put('a1', RECORD)
  const bad: unknown[] = [
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
  for (const value of bad) {
    await writeFile(file, JSON.stringify(value) ?? '')
    assert.equal(await files.get('a1'), undefined, JSON.stringify(value))
  }
  // A number JSON can't hold is not a finite takenAt either.
  await writeFile(file, '{"role":"main","commit":null,"takenAt":1e999}')
  assert.equal(await files.get('a1'), undefined)
  // The right shape with extras reads as just the record.
  await writeFile(file, JSON.stringify({ ...RECORD, extra: 'x' }))
  assert.deepEqual(await files.get('a1'), RECORD)
}))

test('get refreshes the mtime, and only for a record it could read', () => withFiles(async (files, directory) => {
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

test('prune removes a stray temp file of any age, and counts it', () => withFiles(async (files, directory) => {
  await files.put('a1', RECORD)
  const young = `.${hash('a1')}.0123456789abcdef.tmp`
  const old = `.${hash('a2')}.fedcba9876543210.tmp`
  await writeFile(join(directory, young), '{"role":')
  await writeFile(join(directory, old), '')
  await backdate(join(directory, old), 400 * DAY)
  assert.equal(await files.prune(180 * DAY), 2)
  assert.deepEqual(await readdir(directory), [`${hash('a1')}.json`])
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
