import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { StatusStore } from '../src/status.ts'
import type { ProjectStatus } from '../src/status.ts'
import { tempDir } from './helpers.ts'

/** Where a store keeps its file: a directory that doesn't exist yet. */
async function where(): Promise<{ dir: string, file: string }> {
  const dir = join(await tempDir(), 'state', 'projects')
  return { dir, file: join(dir, 'status.json') }
}

async function loaded(file: string): Promise<StatusStore> {
  const store = new StatusStore(file)
  await store.load()
  return store
}

const READY: ProjectStatus = { state: 'ready', at: 2000, readyAt: 2000 }
const FAILED: ProjectStatus = { state: 'failed', step: 'installation', message: 'install the dish App on acme and give it widget', at: 3000 }

test('a project the store never heard of is pending at 0, and a missing file is an empty store', async () => {
  const { dir, file } = await where()
  const store = await loaded(file)
  assert.deepEqual(store.get('acme/widget'), { state: 'pending', at: 0 })
  // Loading writes nothing.
  await assert.rejects(readdir(dir), { code: 'ENOENT' })
})

test('what is set is what a new store loads, field for field', async () => {
  const { file } = await where()
  const first = await loaded(file)
  const skipped: ProjectStatus = { state: 'ready', at: 4000, readyAt: 4000, setupSkipped: 'setup didn\'t run outside the sandbox: the checkout isn\'t clean. Run it yourself in /w/acme/gadget: make' }
  await first.set('acme/widget', READY)
  await first.set('acme/broken', FAILED)
  await first.set('acme/gadget', skipped)
  assert.deepEqual(first.get('acme/widget'), READY)

  const second = await loaded(file)
  assert.deepEqual(second.get('acme/widget'), READY)
  assert.deepEqual(second.get('acme/broken'), FAILED)
  assert.deepEqual(second.get('acme/gadget'), skipped)
})

test('names are compared without regard to case, as GitHub\'s are', async () => {
  const { file } = await where()
  const store = await loaded(file)
  await store.set('Acme/Widget', READY)
  assert.deepEqual(store.get('acme/widget'), READY)
  assert.deepEqual(store.get('ACME/WIDGET'), READY)
  await store.set('acme/Gadget', FAILED)
  assert.deepEqual(store.names(), ['acme/gadget', 'acme/widget'])
  await store.forget('acme/WIDGET')
  assert.deepEqual(store.get('Acme/Widget'), { state: 'pending', at: 0 })
  assert.deepEqual(store.names(), ['acme/gadget'])
})

test('the file is JSON, mode 0600 in a 0700 directory, and no temp file is left behind', async () => {
  const { dir, file } = await where()
  const store = await loaded(file)
  await store.set('acme/widget', READY)
  assert.equal((await stat(dir)).mode & 0o777, 0o700)
  assert.equal((await stat(file)).mode & 0o777, 0o600)
  assert.deepEqual(await readdir(dir), ['status.json'])
  const parsed = JSON.parse(await readFile(file, 'utf8')) as { projects: Record<string, unknown> }
  assert.deepEqual(parsed.projects['acme/widget'], READY)
})

test('a corrupt file is set aside, kept as it was, and the store starts empty', async () => {
  for (const text of ['{"projects": {', '[]', '"ready"', '{"projects": []}', '{}']) {
    const { dir, file } = await where()
    await mkdir(dir, { recursive: true })
    await writeFile(file, text)
    const store = await loaded(file)
    assert.deepEqual(store.get('acme/widget'), { state: 'pending', at: 0 }, text)
    const names = await readdir(dir)
    assert.equal(names.length, 1, text)
    assert.match(names[0]!, /^status\.json\.corrupt-\d+$/, text)
    assert.equal(await readFile(join(dir, names[0]!), 'utf8'), text)
    // The next set writes a fresh file beside it.
    await store.set('acme/widget', READY)
    assert.deepEqual((await readdir(dir)).sort(), [names[0]!, 'status.json'].sort())
    assert.deepEqual((await loaded(file)).get('acme/widget'), READY)
  }
})

test('one entry that isn\'t a status is left out, and the others are kept', async () => {
  const { dir, file } = await where()
  await mkdir(dir, { recursive: true })
  await writeFile(file, JSON.stringify({
    projects: {
      'acme/widget': READY,
      'acme/odd': { state: 'sleeping', at: 1 },
      'acme/nat': { state: 'ready' },
      'acme/text': { state: 'failed', at: 5, message: 7 },
    },
  }))
  const store = await loaded(file)
  assert.deepEqual(store.get('acme/widget'), READY)
  for (const name of ['acme/odd', 'acme/nat', 'acme/text']) assert.deepEqual(store.get(name), { state: 'pending', at: 0 }, name)
  // Not set aside: the file was readable.
  assert.deepEqual(await readdir(dir), ['status.json'])
})

test('a project that was cloning or in setup when dish stopped is pending again after a load', async () => {
  const { file } = await where()
  const first = await loaded(file)
  await first.set('acme/one', { state: 'cloning', step: 'clone', at: 10 })
  await first.set('acme/two', { state: 'setup', step: 'setup', at: 11 })
  const second = await loaded(file)
  assert.deepEqual(second.get('acme/one'), { state: 'pending', at: 10 })
  assert.deepEqual(second.get('acme/two'), { state: 'pending', at: 11 })
})

test('sets made at once are written one after another, and every one of them is kept', async () => {
  const { file } = await where()
  const store = await loaded(file)
  const names = Array.from({ length: 20 }, (_, index) => `acme/repo-${index}`)
  await Promise.all(names.map((name, index) => store.set(name, { state: 'ready', at: index, readyAt: index })))
  const again = await loaded(file)
  for (const [index, name] of names.entries()) assert.deepEqual(again.get(name), { state: 'ready', at: index, readyAt: index })
  // A forget amid sets.
  await Promise.all([store.set('acme/late', READY), store.forget('acme/repo-3'), store.set('acme/later', FAILED)])
  const last = await loaded(file)
  assert.deepEqual(last.get('acme/late'), READY)
  assert.deepEqual(last.get('acme/later'), FAILED)
  assert.deepEqual(last.get('acme/repo-3'), { state: 'pending', at: 0 })
  assert.deepEqual(last.get('acme/repo-4'), { state: 'ready', at: 4, readyAt: 4 })
})

test('get answers at once, before the write is done, and what it returns is a copy', async () => {
  const { file } = await where()
  const store = await loaded(file)
  const writing = store.set('acme/widget', { ...READY })
  assert.deepEqual(store.get('acme/widget'), READY)
  await writing
  const copy = store.get('acme/widget')
  copy.state = 'failed'
  assert.deepEqual(store.get('acme/widget'), READY)
})

test('a file that can\'t be read fails the load; a write that fails rejects, keeps the status in memory and leaves no temp file', async () => {
  const { dir, file } = await where()
  // A directory where the file should be: rename can't replace it.
  await mkdir(file, { recursive: true })
  const store = new StatusStore(file)
  await assert.rejects(store.load())
  await assert.rejects(store.set('acme/widget', READY))
  assert.deepEqual(store.get('acme/widget'), READY)
  // No temp file is left.
  assert.deepEqual(await readdir(dir), ['status.json'])
})

test('loadSync reads the same file at once: statuses, transient ones as pending, a corrupt file set aside, a missing one empty', async () => {
  const { dir, file } = await where()
  const empty = new StatusStore(file)
  empty.loadSync()
  assert.deepEqual(empty.get('acme/widget'), { state: 'pending', at: 0 })

  const first = await loaded(file)
  await first.set('Acme/Widget', READY)
  await first.set('acme/running', { state: 'setup', step: 'setup', at: 7 })
  const store = new StatusStore(file)
  store.loadSync()
  assert.deepEqual(store.get('acme/widget'), READY)
  assert.deepEqual(store.get('acme/running'), { state: 'pending', at: 7 })

  await writeFile(file, 'not json')
  const corrupt = new StatusStore(file)
  corrupt.loadSync()
  assert.deepEqual(corrupt.get('acme/widget'), { state: 'pending', at: 0 })
  const names = await readdir(dir)
  assert.equal(names.length, 1)
  assert.match(names[0]!, /^status\.json\.corrupt-\d+$/)

  // A file that can't be read throws.
  await mkdir(file)
  assert.throws(() => new StatusStore(file).loadSync(), { code: 'EISDIR' })
})
