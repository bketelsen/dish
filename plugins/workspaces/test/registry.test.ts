import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { registerWorkspace } from '../src/registry.ts'
import type { WorkspaceRegistryLike } from '../src/registry.ts'
import { mountRegistry } from './registry-helpers.ts'
import { tempDir } from './helpers.ts'

/** A directory under `dir` for a workspace to point at. */
async function folder(dir: string, name: string): Promise<string> {
  const path = join(dir, name)
  await mkdir(path, { recursive: true })
  return path
}

test('registerWorkspace: a new path gets a record with the title, created', async () => {
  const dir = await tempDir()
  const mounted = await mountRegistry(dir)
  try {
    const path = await folder(dir, 'acme-widget')
    const result = await registerWorkspace(mounted.registry, path, 'acme/widget')
    assert.equal(result.created, true)
    assert.equal(result.title, 'acme/widget')
    const workspace = mounted.registry.get(WorkspaceId(result.id))
    assert.ok(workspace, 'the registry holds it')
    assert.equal(workspace.title, 'acme/widget')
    assert.equal(workspace.path, path)
    assert.equal(mounted.registry.list().length, 1)
  } finally {
    await mounted.stop()
  }
})

test('registerWorkspace: the same path again is the same record, and the first title stays', async () => {
  const dir = await tempDir()
  const mounted = await mountRegistry(dir)
  try {
    const path = await folder(dir, 'acme-widget')
    const first = await registerWorkspace(mounted.registry, path, 'first')
    const again = await registerWorkspace(mounted.registry, path, 'second')
    assert.equal(again.id, first.id)
    assert.equal(again.created, false)
    assert.equal(again.title, 'first', 'an existing record keeps its title')
    assert.equal(mounted.registry.list().length, 1)
    assert.equal(mounted.registry.get(WorkspaceId(first.id))?.title, 'first')
  } finally {
    await mounted.stop()
  }
})

test('registerWorkspace: a record somebody renamed keeps the new name', async () => {
  const dir = await tempDir()
  const mounted = await mountRegistry(dir)
  try {
    const path = await folder(dir, 'acme-widget')
    const first = await registerWorkspace(mounted.registry, path, 'acme/widget')
    await mounted.registry.get(WorkspaceId(first.id))!.setTitle('My widget')
    const again = await registerWorkspace(mounted.registry, path, 'acme/widget')
    assert.equal(again.id, first.id)
    assert.equal(again.created, false)
    assert.equal(again.title, 'My widget')
  } finally {
    await mounted.stop()
  }
})

test('registerWorkspace: a path through a symlink, or with a trailing slash, is the same record', async () => {
  const dir = await tempDir()
  const mounted = await mountRegistry(dir)
  try {
    const path = await folder(dir, 'real')
    const link = join(dir, 'link')
    await symlink(path, link)
    const first = await registerWorkspace(mounted.registry, path, 'real')
    const viaLink = await registerWorkspace(mounted.registry, link, 'link')
    assert.equal(viaLink.id, first.id)
    assert.equal(viaLink.created, false)
    assert.equal(viaLink.title, 'real')
    const slashed = await registerWorkspace(mounted.registry, `${path}/`, 'slashed')
    assert.equal(slashed.id, first.id)
    assert.equal(slashed.created, false)
    assert.equal(mounted.registry.list().length, 1)
  } finally {
    await mounted.stop()
  }
})

test('registerWorkspace: a missing path, a file and a relative path reject, and nothing is registered', async () => {
  const dir = await tempDir()
  const mounted = await mountRegistry(dir)
  try {
    await assert.rejects(registerWorkspace(mounted.registry, join(dir, 'missing'), 'x'), /ENOENT/)
    const file = join(dir, 'a-file')
    await writeFile(file, 'x')
    await assert.rejects(registerWorkspace(mounted.registry, file, 'x'))
    await assert.rejects(registerWorkspace(mounted.registry, 'relative/dir', 'x'))
    assert.equal(mounted.registry.list().length, 0)
  } finally {
    await mounted.stop()
  }
})

test('registerWorkspace: a removed registration is registered anew, with a new id', async () => {
  const dir = await tempDir()
  const mounted = await mountRegistry(dir)
  try {
    const path = await folder(dir, 'acme-widget')
    const first = await registerWorkspace(mounted.registry, path, 'acme/widget')
    assert.equal(await mounted.registry.delete(WorkspaceId(first.id)), true)
    const second = await registerWorkspace(mounted.registry, path, 'acme/widget')
    assert.equal(second.created, true)
    assert.notEqual(second.id, first.id)
  } finally {
    await mounted.stop()
  }
})

test('registerWorkspace: two at once for one path make one record', async () => {
  const dir = await tempDir()
  const mounted = await mountRegistry(dir)
  try {
    const path = await folder(dir, 'acme-widget')
    const [a, b] = await Promise.all([
      registerWorkspace(mounted.registry, path, 'acme/widget'),
      registerWorkspace(mounted.registry, path, 'acme/widget'),
    ])
    assert.equal(a.id, b.id)
    assert.equal(mounted.registry.list().length, 1)
    assert.equal(mounted.registry.list()[0]!.title, 'acme/widget')
  } finally {
    await mounted.stop()
  }
})

interface StubOptions {
  /** Whether `create` uses the title it is given (a dsh that dropped the parameter doesn't). */
  honorsTitle: boolean
  /** `setTitle` rejects with this. */
  setTitleFails?: Error
}

/** A registry with the four methods registerWorkspace uses, over a map, and a record of the `setTitle` calls. */
function stubRegistry(options: StubOptions) {
  const entries = new Map<string, Workspace & { title: string }>()
  const setTitles: string[] = []
  let counter = 0
  const registry: WorkspaceRegistryLike = {
    async create(path, title) {
      for (const entry of entries.values()) if (entry.path === path) return entry
      const id = `stub-${++counter}`
      const entry = {
        id,
        path,
        title: options.honorsTitle && title !== undefined ? title : basename(path),
        async setTitle(next: string) {
          if (options.setTitleFails) throw options.setTitleFails
          setTitles.push(next)
          entry.title = next
        },
      } as unknown as Workspace & { title: string }
      entries.set(id, entry)
      return entry
    },
    async resolveByPath(path) {
      for (const entry of entries.values()) if (entry.path === path) return entry
      return undefined
    },
    get: id => entries.get(id as string),
    list: () => [...entries.values()],
  }
  return { registry, setTitles, entries }
}

test('registerWorkspace: a dsh whose create ignores the title gets setTitle on the record it just made', async () => {
  const stub = stubRegistry({ honorsTitle: false })
  const result = await registerWorkspace(stub.registry, '/w/acme-widget', 'acme/widget')
  assert.equal(result.created, true)
  assert.equal(result.title, 'acme/widget')
  assert.deepEqual(stub.setTitles, ['acme/widget'])
  assert.equal(stub.entries.get(result.id)?.title, 'acme/widget')
})

test('registerWorkspace: setTitle is not called when create took the title, or for an existing record', async () => {
  const honoring = stubRegistry({ honorsTitle: true })
  const first = await registerWorkspace(honoring.registry, '/w/a', 'a title')
  assert.equal(first.title, 'a title')
  assert.deepEqual(honoring.setTitles, [])

  const ignoring = stubRegistry({ honorsTitle: false })
  const made = await registerWorkspace(ignoring.registry, '/w/b', 'b title')
  assert.deepEqual(ignoring.setTitles, ['b title'])
  const again = await registerWorkspace(ignoring.registry, '/w/b', 'another title')
  assert.equal(again.id, made.id)
  assert.equal(again.created, false)
  assert.equal(again.title, 'b title')
  assert.deepEqual(ignoring.setTitles, ['b title'], 'an existing record is not retitled')
})

test('registerWorkspace: a title that cannot be set does not undo the registration, and the result says what the title is', async () => {
  const stub = stubRegistry({ honorsTitle: false, setTitleFails: new Error('disk full') })
  const result = await registerWorkspace(stub.registry, '/w/acme-widget', 'acme/widget')
  assert.equal(result.created, true)
  assert.equal(result.title, 'acme-widget', 'the title dsh holds')
  assert.equal(stub.entries.size, 1)
})
