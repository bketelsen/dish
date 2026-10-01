import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readCache, writeCache, type Cache } from '../src/catalog.ts'

function sample(id: string): Cache {
  return {
    version: 1,
    report: { refreshedAt: 1, available: [id], added: [id], unavailable: [], routeUpdated: false },
    additions: [{ id, name: id, api: 'openai-responses', sibling: 'gpt-6', vision: false }],
  }
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'dish-copilot-cache-'))
  try { await run(dir) } finally { await rm(dir, { recursive: true, force: true }) }
}

test('a missing cache falls back to the legacy file', () => withTempDir(async (dir) => {
  const legacy = join(dir, 'legacy.json')
  await writeFile(legacy, JSON.stringify(sample('from-legacy')))
  assert.deepEqual(await readCache(join(dir, 'new.json'), legacy), sample('from-legacy'))
}))

test('when both exist, the new file wins', () => withTempDir(async (dir) => {
  const file = join(dir, 'new.json')
  const legacy = join(dir, 'legacy.json')
  await writeFile(file, JSON.stringify(sample('from-new')))
  await writeFile(legacy, JSON.stringify(sample('from-legacy')))
  assert.deepEqual(await readCache(file, legacy), sample('from-new'))
}))

test('with neither file, or no legacy path, there is no cache', () => withTempDir(async (dir) => {
  assert.equal(await readCache(join(dir, 'new.json'), join(dir, 'legacy.json')), undefined)
  assert.equal(await readCache(join(dir, 'new.json')), undefined)
}))

test('a corrupt or wrong-version cache reads as absent and is left alone', () => withTempDir(async (dir) => {
  const legacy = join(dir, 'legacy.json')
  await writeFile(legacy, JSON.stringify(sample('from-legacy')))

  const file = join(dir, 'new.json')
  for (const text of [
    '{ not json', 'null',
    '{"version":2,"report":{"available":[]},"additions":[]}',
    '{"version":1}',
    '{"version":1,"report":null,"additions":[]}',
    '{"version":1,"report":{},"additions":[]}',
    '{"version":1,"report":{"available":[]}}',
  ]) {
    await writeFile(file, text)
    assert.equal(await readCache(file, legacy), undefined, text)
    assert.equal(await readFile(file, 'utf8'), text)
  }
  assert.deepEqual(await readCache(legacy), sample('from-legacy'))
}))

test('the legacy file is only read, never rewritten or removed', () => withTempDir(async (dir) => {
  const legacy = join(dir, 'legacy.json')
  const text = JSON.stringify(sample('from-legacy'))
  await writeFile(legacy, text)
  await readCache(join(dir, 'new.json'), legacy)
  assert.equal(await readFile(legacy, 'utf8'), text)
  assert.deepEqual(await readdir(dir), ['legacy.json'])
}))

test('writeCache creates the missing cache directory and leaves no temporary file', () => withTempDir(async (dir) => {
  const file = join(dir, 'not', 'yet', 'there', 'copilot-models.json')
  await writeCache(file, sample('fresh'))
  assert.deepEqual(await readCache(file), sample('fresh'))
  assert.deepEqual(await readdir(join(dir, 'not', 'yet', 'there')), ['copilot-models.json'])

  await writeCache(file, sample('replaced'))
  assert.deepEqual(await readCache(file), sample('replaced'))
}))

test('after the first write the legacy file is no longer consulted', () => withTempDir(async (dir) => {
  const legacy = join(dir, 'legacy.json')
  const file = join(dir, 'cache', 'new.json')
  await mkdir(join(dir, 'cache'))
  await writeFile(legacy, JSON.stringify(sample('from-legacy')))
  assert.deepEqual(await readCache(file, legacy), sample('from-legacy'))
  await writeCache(file, sample('refreshed'))
  assert.deepEqual(await readCache(file, legacy), sample('refreshed'))
}))
