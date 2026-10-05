/**
 * `services.ts`: the services read with `ctx.get` on each use, the session's workspace, dsh's own address, and whether a
 * session's agent is live.
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { contextServices, isLive, ownAddress, workspaceOf } from '../src/services.ts'
import type { Services } from '../src/services.ts'

const dirs: string[] = []
after(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }) })

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dish-browser-services-'))
  dirs.push(dir)
  return realpath(dir)
}

/** Services with nothing running, and the ones given. */
function services(given: Partial<Services> = {}): Services {
  return {
    agents: () => undefined,
    sandboxPolicy: () => undefined,
    attachments: () => undefined,
    llm: () => undefined,
    workspaceRegistry: () => undefined,
    crew: () => undefined,
    webServer: () => undefined,
    ...given,
  }
}

test('contextServices: each read is a ctx.get of its name, on each use', () => {
  const asked: string[] = []
  const values: Record<string, unknown> = { agents: { get: () => undefined }, webServer: { port: 4242 } }
  const ctx = { get(name: string) { asked.push(name); return values[name] } } as unknown as Context
  const read = contextServices(ctx)
  assert.equal(read.webServer()?.port, 4242)
  values.webServer = { port: 5151 }
  assert.equal(read.webServer()?.port, 5151)
  read.agents(); read.sandboxPolicy(); read.attachments(); read.llm(); read.workspaceRegistry(); read.crew()
  assert.deepEqual(asked, ['webServer', 'webServer', 'agents', 'sandboxPolicy', 'attachments', 'llm', 'workspaceRegistry', 'dishCrew'])
})

test('contextServices: a ctx.get that throws reads as no service', () => {
  const ctx = { get() { throw new Error('no such service') } } as unknown as Context
  assert.equal(contextServices(ctx).agents(), undefined)
})

test('workspaceOf: the sandbox policy\'s workspace root, canonical', async () => {
  const dir = await tempDir()
  const session = { header: { cwd: '/somewhere/else' } }
  let asked: unknown
  const read = services({ sandboxPolicy: () => ({ resolve: request => { asked = request.session; return { workspaceRoot: dir } } }) })
  assert.equal(await workspaceOf(read, session), dir)
  assert.equal(asked, session)
})

test('workspaceOf: the session\'s header.cwd when there is no sandbox policy, or it gives no root', async () => {
  const dir = await tempDir()
  const session = { header: { cwd: dir } }
  assert.equal(await workspaceOf(services(), session), dir)
  assert.equal(await workspaceOf(services({ sandboxPolicy: () => ({ resolve: () => ({ workspaceRoot: '' }) }) }), session), dir)
  assert.equal(await workspaceOf(services({ sandboxPolicy: () => ({ resolve: () => { throw new Error('boom') } }) }), session), dir)
})

test('workspaceOf: through a symbolic link, the real path', async () => {
  const dir = await tempDir()
  const real = join(dir, 'real')
  await mkdir(real)
  const link = join(dir, 'link')
  await symlink(real, link)
  const read = services({ sandboxPolicy: () => ({ resolve: () => ({ workspaceRoot: link }) }) })
  assert.equal(await workspaceOf(read, {}), real)
})

test('workspaceOf: neither, a path that doesn\'t exist, or a session that isn\'t one, is undefined', async () => {
  const dir = await tempDir()
  assert.equal(await workspaceOf(services(), {}), undefined)
  assert.equal(await workspaceOf(services(), undefined), undefined)
  assert.equal(await workspaceOf(services(), { header: { cwd: 7 } }), undefined)
  assert.equal(await workspaceOf(services(), { header: { cwd: join(dir, 'gone') } }), undefined)
  const throwing = { get header(): never { throw new Error('boom') } }
  assert.equal(await workspaceOf(services(), throwing), undefined)
})

test('ownAddress: the web server\'s port and DISH_TRUSTED_HOST', () => {
  const read = services({ webServer: () => ({ port: 4319 }) })
  assert.deepEqual(ownAddress(read, { DISH_TRUSTED_HOST: 'dish.example.ts.net' }), { port: 4319, trustedHost: 'dish.example.ts.net' })
  assert.deepEqual(ownAddress(read, {}), { port: 4319, trustedHost: undefined })
  assert.deepEqual(ownAddress(read, { DISH_TRUSTED_HOST: '' }), { port: 4319, trustedHost: undefined })
  assert.deepEqual(ownAddress(services(), {}), { port: undefined, trustedHost: undefined })
})

test('isLive: whether dsh has the session\'s agent loaded', () => {
  const read = services({ agents: () => ({ get: id => id === 's1' ? { id: 's1', session: {} } : undefined }) })
  assert.equal(isLive(read, 's1'), true)
  assert.equal(isLive(read, 's2'), false)
  assert.equal(isLive(services(), 's1'), false)
})
