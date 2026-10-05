/**
 * The plugin in a cordis `Context`: with dish-config's real plugin where the claim is concerned, a vault in a temporary
 * directory always (never the XDG default), and a local bare repository for a remote.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import * as configPlugin from 'dish-config'
import type { Author, RemoteStatus } from 'dish-kit/store'
import * as plugin from '../src/index.ts'
import type { DishMemory } from '../src/index.ts'
import {
  ACME, AS_AGENT, AS_USER, USER, agentAt, bareRemote, input, provideStub, refusal, tempDir, waitFor, watchLogs,
} from './helpers.ts'
import type { Handle } from './helpers.ts'

/** What `dishMemory` holds: the documented methods, and nothing of the plugin's own. */
const METHODS = [
  'commit', 'compose', 'delete', 'direction', 'history', 'list', 'read', 'release', 'remoteStatus', 'revert', 'saveDirection',
  'scopes', 'scopesFor', 'write',
]

function mountMemory(ctx: Context, config: Partial<plugin.Config>) {
  return ctx.plugin(plugin, { terminal: false, userName: 'Test User', userEmail: 'user@test', ...config } as plugin.Config)
}

function mountConfig(ctx: Context, repository: string) {
  return ctx.plugin(configPlugin, { terminal: false, repository, userName: 'Test User', userEmail: 'user@test' } as configPlugin.Config)
}

test('the plugin provides dishMemory and claims families/ in dishConfig', async () => {
  const parse = plugin.Config as unknown as (value: unknown) => unknown
  assert.deepEqual(parse({}), { vault: '', remote: '', userName: '', userEmail: '', indexLines: 150, indexBytes: 16_384, terminal: true })
  assert.equal(plugin.name, 'dish-memory')

  const dir = await tempDir()
  const ctx = new Context()
  const config = mountConfig(ctx, join(dir, 'config.git'))
  await config
  const memory = mountMemory(ctx, { vault: join(dir, 'vault.git') })
  const stubs: Handle[] = []
  try {
    await memory
    const service = ctx.get('dishMemory') as DishMemory
    assert.deepEqual(Object.keys(service).sort(), METHODS)

    // The claim: a direction goes in as the user, through the service or the store; nothing else lives under families/.
    const saved = await waitFor('the families/ claim', () => service.saveDirection('acme', '# Direction\n\nShip it.\n', { note: 'first' }).catch(() => undefined))
    assert.deepEqual(saved.paths, ['families/acme/direction.md'])
    assert.equal((await service.direction('acme')).text, '# Direction\n\nShip it.\n')
    await assert.rejects(ctx.dishConfig.write([{ path: 'families/acme/notes.md', text: 'x' }], AS_USER),
      refusal('INVALID', 'families/acme/notes.md: only families/<family>/direction.md lives here'))
    // An agent may only propose there.
    await assert.rejects(ctx.dishConfig.write([{ path: 'families/acme/direction.md', text: 'x' }], AS_AGENT), refusal('FORBIDDEN'))
    await ctx.dishConfig.propose([{ path: 'families/acme/direction.md', text: 'Proposed.\n' }], { ...AS_AGENT, title: 'Steer acme', rationale: '' })
    assert.equal((await service.direction('acme')).pendingProposals, 1)

    // dish-config/changed clears both caches. With dishProjects and dishWorkspaces there, a message for acme has every
    // part, so it is kept, and an agent in the clone is placed in acme.
    const clone = join(dir, 'clone')
    await mkdir(clone)
    let family = 'acme'
    stubs.push(provideStub(ctx, 'dishProjects', { list: async () => [{ name: 'acme/widget', family, role: 'The widget' }], problem: async () => undefined }))
    stubs.push(provideStub(ctx, 'dishWorkspaces', { describe: (project: string) => project === 'acme/widget' ? { clone } : undefined }))
    await Promise.all(stubs)
    const agent = agentAt(clone)
    assert.deepEqual(await service.scopesFor(agent), { user: true, family: 'acme' })
    const before = await service.compose({ user: false, family: 'acme' })
    assert.ok(before?.includes('Ship it.') && before.includes('- acme/widget — The widget'), before)
    // The project moves to beta outside the config store: both answers are kept.
    family = 'beta'
    assert.deepEqual(await service.scopesFor(agent), { user: true, family: 'acme' })
    assert.equal(await service.compose({ user: false, family: 'acme' }), before)
    // A commit to the config store: both are worked out again.
    await ctx.dishConfig.write([{ path: 'families/acme/direction.md', text: 'Ship it later.\n' }], AS_USER)
    await waitFor('the scopes to be worked out again', async () => (await service.scopesFor(agent)).family === 'beta')
    const after = await service.compose({ user: false, family: 'acme' })
    assert.ok(after?.includes('Ship it later.') && !after.includes('acme/widget'), after)

    await memory.dispose()
    assert.equal(ctx.get('dishMemory'), undefined)
    // The claim went with the plugin; the direction stays.
    await assert.rejects(ctx.dishConfig.write([{ path: 'families/acme/direction.md', text: 'y' }], AS_USER), refusal('UNOWNED'))
    assert.equal(await ctx.dishConfig.read('families/acme/direction.md'), 'Ship it later.\n')
  } finally {
    for (const stub of stubs) await stub.dispose()
    await memory.dispose()
    await config.dispose()
  }
})

test('a vault that can\'t open is logged, and nothing is provided', async () => {
  const dir = await tempDir()
  await writeFile(join(dir, 'mine.txt'), 'not a vault')
  for (const vault of [dir, 'relative/vault.git']) {
    const ctx = new Context()
    const logs = watchLogs(ctx)
    const handle = mountMemory(ctx, { vault })
    try {
      await handle
      assert.equal(ctx.get('dishMemory'), undefined)
      const line = logs.find(entry => entry.startsWith('[dish-memory] error: cannot open the vault'))
      assert.ok(line !== undefined, logs.join('\n'))
      assert.ok(line.includes(vault), line)
    } finally {
      await handle.dispose()
    }
  }
})

test('onCommit emits dish-memory/changed with the scopes', async () => {
  const dir = await tempDir()
  const ctx = new Context()
  const events: Array<{ scopes: string[], commit: string, author: Author }> = []
  ctx.on('dish-memory/changed', (scopes, commit, author) => { events.push({ scopes, commit, author }) })
  const handle = mountMemory(ctx, { vault: join(dir, 'vault.git') })
  try {
    await handle
    const service = ctx.get('dishMemory') as DishMemory
    const user = await service.write(USER, input('a'), AS_USER)
    const family = await service.write(ACME, input('b'), AS_AGENT)
    const reverted = await service.revert(family.commit.id, AS_USER)
    assert.deepEqual(events, [
      { scopes: ['user'], commit: user.commit.id, author: { kind: 'user' } },
      { scopes: ['family:acme'], commit: family.commit.id, author: { kind: 'agent', sessionId: 'session-1', role: 'main' } },
      { scopes: ['family:acme'], commit: reverted?.id, author: { kind: 'user' } },
    ])
  } finally {
    await handle.dispose()
  }
})

test('the vault pushes to a local bare remote, and remoteStatus says so', async () => {
  const dir = await tempDir()
  const remote = await bareRemote()
  const ctx = new Context()
  const statuses: RemoteStatus[] = []
  ctx.on('dish-memory/remote', status => { statuses.push(status) })
  const handle = mountMemory(ctx, { vault: join(dir, 'vault.git'), remote: remote.path })
  try {
    await handle
    const service = ctx.get('dishMemory') as DishMemory
    const result = await service.write(USER, input('a'), AS_USER)
    const status = await waitFor('the push', async () => {
      const now = await service.remoteStatus()
      return now.pending === 0 && now.pushed === result.commit.id && now
    })
    assert.equal(status.remote, remote.path)
    assert.equal(status.lastError, undefined)
    assert.equal(await remote.git.resolve('refs/heads/main'), result.commit.id)
    assert.deepEqual(await remote.git.listPaths('refs/heads/main', ''), ['user/MEMORY.md', 'user/a.md'])
    await waitFor('the remote event', () => statuses.some(seen => seen.pushed === result.commit.id))
  } finally {
    await handle.dispose()
  }
})

test('the vault restores from the remote on first start', async () => {
  const dir = await tempDir()
  const remote = await bareRemote()
  const first = new Context()
  const firstHandle = mountMemory(first, { vault: join(dir, 'first.git'), remote: remote.path })
  let written: string
  try {
    await firstHandle
    const service = first.get('dishMemory') as DishMemory
    written = (await service.write(ACME, input('kept', { type: 'project' }), AS_USER)).commit.id
    await waitFor('the push', async () => (await service.remoteStatus()).pushed === written)
  } finally {
    await firstHandle.dispose()
  }

  const second = new Context()
  const secondHandle = mountMemory(second, { vault: join(dir, 'second.git'), remote: remote.path })
  try {
    await secondHandle
    const service = second.get('dishMemory') as DishMemory
    const kept = await service.read(ACME, 'kept')
    assert.equal(kept?.commit, written)
    assert.equal(kept?.body, 'What kept says.')
    assert.deepEqual((await service.history(ACME)).map(commit => commit.id), [written])
    assert.ok((await service.compose({ user: false, family: 'acme' }))?.includes('- family/kept — About kept (project)'))
    // Without dishConfig and dishProjects that message misses parts: asked for a whole one, the service says so.
    await assert.rejects(service.compose({ user: false, family: 'acme' }, { complete: true }), refusal('UNAVAILABLE', /^the message for family:acme isn't complete: /))
  } finally {
    await secondHandle.dispose()
  }
})
