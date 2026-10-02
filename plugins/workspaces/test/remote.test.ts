/**
 * The server half of Settings → GitHub App: `WorkspacesRemote`, over the real plugin and the fake GitHub. What matters most
 * here is what the page is never given: no method takes the App's ID or its key, none gives either back, and nothing it
 * returns has them in, whatever GitHub's error text or a broken key says.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { RESERVED_REMOTE_METHODS } from 'dish-kit/client'
import * as plugin from '../src/index.ts'
import { NAMESPACE } from '../src/protocol.ts'
import { WorkspacesRemote } from '../src/remote.ts'
import { testKeys } from './fake-github-api.ts'
import {
  APP_ID_NAME, PRIVATE_KEY_NAME, credentialsStub, fakeTimers, provideStub, startServiceWorld, useScratchProcess, waitFor, watchLogs,
} from './service-helpers.ts'
import type { ServiceWorld } from './service-helpers.ts'

useScratchProcess()

interface Rig {
  world: ServiceWorld
  /** The App's ID and key as the rig started: what no answer may hold, whatever the test does to the credentials. */
  secrets: { id: string, key: string }
  remote: WorkspacesRemote
  ctx: Context
  logs: string[]
  /** Requests the fake GitHub has seen since the rig started or since `forget`. */
  requests(): string[]
  forget(): void
}

/** dish-workspaces over the fakes, with a credentials stub holding the App's test ID and key, and its remote. */
async function withRemote<T>(body: (rig: Rig) => Promise<T>, names: { appIdName?: string, privateKeyName?: string } = {}): Promise<T> {
  const world = await startServiceWorld()
  const appIdName = names.appIdName ?? APP_ID_NAME
  const privateKeyName = names.privateKeyName ?? PRIVATE_KEY_NAME
  if (appIdName !== APP_ID_NAME) world.credentials.set(appIdName, world.credentials.get(APP_ID_NAME)!)
  if (privateKeyName !== PRIVATE_KEY_NAME) world.credentials.set(privateKeyName, world.credentials.get(PRIVATE_KEY_NAME)!)
  const ctx = new Context()
  const logs = watchLogs(ctx, true)
  const credentials = provideStub(ctx, 'credentials', credentialsStub(world.credentials))
  await credentials
  const workspaces = ctx.plugin({
    name: plugin.name,
    apply: (inner: Context, config: plugin.Config) => { plugin.start(inner, config, world.internals({ timers: fakeTimers() })) },
  } as never, { appIdName, privateKeyName, terminal: false } as never)
  await workspaces
  let seen = 0
  try {
    const remote = await waitFor('the remote', () => ctx.get('dishWorkspacesRemote') as WorkspacesRemote | undefined)
    return await body({
      world, remote, ctx, logs,
      secrets: { id: world.credentials.get(appIdName)!, key: world.credentials.get(privateKeyName)! },
      requests: () => world.github.requests.slice(seen).map(request => `${request.method} ${request.path} ${request.auth} ${request.status}`),
      forget: () => { seen = world.github.requests.length },
    })
  } finally {
    await workspaces.dispose()
    await credentials.dispose()
  }
}

/** dsh says a credential changed. */
function updated(rig: Rig, ref: string): void {
  (rig.ctx as unknown as { emit(name: string, ...args: unknown[]): void }).emit('credentials/reference-updated', ref)
}

/** What the test must never find in an answer: the key's body (its lines), and the App's ID as a number of its own. */
function secretsOf(rig: Rig): { pem: string[], appId: RegExp } {
  const pem = rig.secrets.key.split('\n').filter(line => line.length >= 16 && !line.startsWith('-----'))
  assert.ok(pem.length > 5, 'the test key has a body')
  return { pem, appId: new RegExp(`(?<![0-9])${rig.secrets.id}(?![0-9])`) }
}

/** An answer, as the wire carries it, holds neither the key nor the App's ID, nor anything token- or JWT-shaped. */
function assertClean(rig: Rig, ...answers: unknown[]): void {
  const { pem, appId } = secretsOf(rig)
  for (const answer of answers) {
    const text = JSON.stringify(answer)
    assert.deepStrictEqual(answer, JSON.parse(text), 'the answer is plain JSON')
    for (const line of pem) assert.ok(!text.includes(line), 'the key is in the answer')
    assert.ok(!text.includes('PRIVATE KEY'), 'a PEM marker is in the answer')
    assert.ok(!appId.test(text), 'the App ID is in the answer')
    assert.ok(!text.includes('ghs_'), 'a token is in the answer')
    assert.ok(!/eyJ[A-Za-z0-9_-]{10}/.test(text), 'a JWT is in the answer')
  }
}

test('the remote marks status and test, nothing else, and no name the browser\'s namespace service owns', () => {
  const marked = remoteMethods(Object.create(WorkspacesRemote.prototype) as WorkspacesRemote).map(mark => mark.method).sort()
  assert.deepEqual(marked, ['status', 'test'])
  for (const method of marked) {
    assert.ok(!RESERVED_REMOTE_METHODS.includes(method), `${method} is a member of the gateway's namespace service`)
    assert.ok(!(method in Object.prototype), `${method} is a member of every object`)
  }
  assert.equal(NAMESPACE, 'dishWorkspaces')
})

test('test: the App\'s name and slug, its bot, and its installations; the JWT calls, then the public bot lookup, and no token is made', async () => {
  await withRemote(async (rig) => {
    const { world } = rig
    world.github.installations.set('frost', { id: 88, account: 'Frost', repos: 'all' })
    const before = Date.now()
    const status = await rig.remote.test()
    assert.deepEqual(status.names, { appId: APP_ID_NAME, privateKey: PRIVATE_KEY_NAME })
    assert.deepEqual(status.app, { slug: 'dish-test', name: 'dish-test app' })
    assert.deepEqual(status.bot, { login: 'dish-test[bot]', email: `${world.github.bot.id}+dish-test[bot]@users.noreply.github.com` })
    assert.deepEqual(status.installations, [
      { id: 77, account: 'Acme', type: 'Organization', selection: 'selected' },
      { id: 88, account: 'Frost', type: 'Organization', selection: 'all' },
    ])
    assert.equal(status.error, null)
    assert.ok(status.checkedAt !== null && status.checkedAt >= before && status.checkedAt <= Date.now())
    assert.deepEqual(rig.requests(), [
      'GET /app jwt 200',
      'GET /app/installations?per_page=100&page=1 jwt 200',
      'GET /users/dish-test%5Bbot%5D none 200',
    ])
    assert.deepEqual(world.github.minted, [], 'a test needs no installation token')
    assertClean(rig, status)
    for (const line of rig.logs) assert.ok(!line.includes('PRIVATE KEY'), line)
  })
})

test('status: the last test\'s result from memory, with no new request; a fresh test when there is none', async () => {
  await withRemote(async (rig) => {
    const first = await rig.remote.status()
    assert.equal(first.error, null)
    assert.equal(first.installations.length, 1, 'nothing in memory: a fresh test')
    assert.equal(rig.requests().length, 3, 'the App, its installations and the bot')
    rig.forget()
    const again = await rig.remote.status()
    assert.deepEqual(again, first)
    assert.deepEqual(rig.requests(), [], 'from memory')
    // A test replaces the memory.
    rig.world.github.installations.set('frost', { id: 88, account: 'Frost', repos: 'all' })
    const tested = await rig.remote.test()
    assert.equal(tested.installations.length, 2)
    assert.equal(rig.requests().length, 2, 'the App and its installations: the bot is known')
    rig.forget()
    assert.deepEqual(await rig.remote.status(), tested)
    assert.deepEqual(rig.requests(), [])
    // An answer is the caller's: changing it changes nothing in memory.
    again.installations.length = 0
    assert.equal((await rig.remote.status()).installations.length, 2)
  })
})

test('a change to either credential forgets the memory; another reference does not', async () => {
  await withRemote(async (rig) => {
    await rig.remote.test()
    rig.forget()
    updated(rig, 'SOMETHING_ELSE')
    await rig.remote.status()
    assert.deepEqual(rig.requests(), [], 'another reference changed')

    for (const ref of [APP_ID_NAME, PRIVATE_KEY_NAME]) {
      updated(rig, ref)
      rig.forget()
      const fresh = await rig.remote.status()
      assert.equal(rig.requests().length, 2, `${ref} changed: the next status asks GitHub (the App and its installations; the bot is known)`)
      assert.equal(fresh.installations.length, 1)
    }
  })
})

test('a test that was under way when a credential changed leaves nothing in memory', async () => {
  await withRemote(async (rig) => {
    const slow = rig.remote.test()
    updated(rig, PRIVATE_KEY_NAME)
    await slow
    rig.forget()
    await rig.remote.status()
    assert.equal(rig.requests().length, 2, 'the answer of the old test was not kept (the App and its installations: the bot is known)')
  })
})

test('two tests at once are one run', async () => {
  await withRemote(async (rig) => {
    const [a, b] = await Promise.all([rig.remote.test(), rig.remote.test()])
    assert.deepEqual(a, b)
    assert.equal(rig.requests().length, 3)
  })
})

test('without the credentials: an error that points at the card, and no request at all', async () => {
  await withRemote(async (rig) => {
    const { world } = rig
    const all = new Map(world.credentials)
    for (const missing of [[APP_ID_NAME, PRIVATE_KEY_NAME], [PRIVATE_KEY_NAME], [APP_ID_NAME]]) {
      world.credentials.clear()
      for (const [name, value] of all) if (!missing.includes(name)) world.credentials.set(name, value)
      rig.forget()
      updated(rig, missing[0]!)
      const status = await rig.remote.test()
      assert.match(status.error ?? '', /aren't set \(Settings → GitHub App\)/)
      assert.equal(status.app, null)
      assert.equal(status.bot, null)
      assert.deepEqual(status.installations, [])
      assert.deepEqual(status.names, { appId: APP_ID_NAME, privateKey: PRIVATE_KEY_NAME })
      assert.ok(typeof status.checkedAt === 'number')
      assert.deepEqual(rig.requests(), [], 'GitHub is not asked without credentials')
      assert.deepEqual(await rig.remote.status(), status)
      assertClean(rig, status)
    }
  })
})

test('without a credentials service at all, the same', async () => {
  const world = await startServiceWorld()
  const ctx = new Context()
  const workspaces = ctx.plugin({
    name: plugin.name,
    apply: (inner: Context, config: plugin.Config) => { plugin.start(inner, config, world.internals({ timers: fakeTimers() })) },
  } as never, { appIdName: APP_ID_NAME, privateKeyName: PRIVATE_KEY_NAME, terminal: false } as never)
  await workspaces
  try {
    const remote = await waitFor('the remote', () => ctx.get('dishWorkspacesRemote') as WorkspacesRemote | undefined)
    const status = await remote.test()
    assert.match(status.error ?? '', /aren't set/)
    assert.equal(world.github.requests.length, 0)
  } finally {
    await workspaces.dispose()
  }
})

test('a key node:crypto can\'t read: the error says so, and has nothing of it', async () => {
  await withRemote(async (rig) => {
    const { world } = rig
    const lines = ['MIIEowIBAAKCAQEAdistinctKeyBodyLineNumberOne0123456789', 'distinctKeyBodyLineNumberTwoabcdefghijklmnopqrstuvwxyz', 'distinctKeyBodyLineNumberThree9876543210ZYXWVUTSRQ']
    world.credentials.set(PRIVATE_KEY_NAME, `-----BEGIN RSA PRIVATE KEY-----\n${lines.join('\n')}\n-----END RSA PRIVATE KEY-----\n`)
    updated(rig, PRIVATE_KEY_NAME)
    const status = await rig.remote.test()
    assert.match(status.error ?? '', /private key couldn't be read as a PEM key/)
    assert.equal(status.app, null)
    assert.deepEqual(rig.requests(), [])
    const text = JSON.stringify(status)
    for (const line of lines) assert.ok(!text.includes(line))
    assert.ok(!text.includes('PRIVATE KEY'))
    for (const line of rig.logs) for (const piece of lines) assert.ok(!line.includes(piece), line)
  })
})

test('a key that is not the App\'s: GitHub\'s refusal is the error, in its words and with nothing of the credentials', async () => {
  await withRemote(async (rig) => {
    const { world } = rig
    world.credentials.set(PRIVATE_KEY_NAME, testKeys().privateKeyPem)
    updated(rig, PRIVATE_KEY_NAME)
    const status = await rig.remote.test()
    assert.match(status.error ?? '', /GET \/app answered HTTP 401: A JSON web token could not be decoded/)
    assert.equal(status.app, null)
    assert.deepEqual(status.installations, [])
    assert.deepEqual(rig.requests(), ['GET /app jwt 401'], 'the rest needs the same JWT: nothing more is asked')
    assertClean(rig, status)
  })
})

test('an error text that repeats the App\'s ID and a line of the key is cleaned before it is kept', async () => {
  await withRemote(async (rig) => {
    const { world } = rig
    const [line] = secretsOf(rig).pem
    const id = rig.secrets.id
    world.github.failNext('/app', 500, { message: `trouble with app ${id} and key line ${line}` })
    const status = await rig.remote.test()
    assert.match(status.error ?? '', /GET \/app answered HTTP 500: trouble with app/)
    assert.ok(!(status.error ?? '').includes(id))
    assert.ok(!(status.error ?? '').includes(line!))
    assertClean(rig, status)
    // And the same in the memory the next status reads.
    assertClean(rig, await rig.remote.status())
  })
})

test('the installations failing leaves the rest of the answer: the App and its bot, and the error', async () => {
  await withRemote(async (rig) => {
    rig.world.github.failNext('/app/installations', 403, { message: 'Resource not accessible by integration' })
    const status = await rig.remote.test()
    assert.deepEqual(status.app, { slug: 'dish-test', name: 'dish-test app' })
    assert.equal(status.bot?.login, 'dish-test[bot]')
    assert.deepEqual(status.installations, [])
    assert.match(status.error ?? '', /GET \/app\/installations answered HTTP 403: Resource not accessible by integration/)
    assertClean(rig, status)
  })
})

test('the bot lookup failing leaves the App and its installations, and the error', async () => {
  await withRemote(async (rig) => {
    rig.world.github.failNext('/users/dish-test%5Bbot%5D', 404, { message: 'Not Found' })
    const status = await rig.remote.test()
    assert.deepEqual(status.app, { slug: 'dish-test', name: 'dish-test app' })
    assert.equal(status.bot, null)
    assert.equal(status.installations.length, 1)
    assert.match(status.error ?? '', /answered HTTP 404/)
  })
})

test('the bot of a slug is looked up once: the public /users quota (60 an hour per address) is onboarding\'s too', async () => {
  await withRemote(async (rig) => {
    const users = (): number => rig.world.github.requests.filter(request => request.path.startsWith('/users/')).length
    const first = await rig.remote.test()
    const second = await rig.remote.test()
    assert.equal(users(), 1, 'two tests, one lookup')
    assert.deepEqual(second.bot, first.bot)
    assert.equal(first.bot?.login, 'dish-test[bot]')
    // A changed credential gives the same App again: the same bot, and nothing new to ask.
    updated(rig, PRIVATE_KEY_NAME)
    assert.deepEqual((await rig.remote.test()).bot, first.bot)
    assert.equal(users(), 1)
    assert.equal(rig.requests().filter(request => request.startsWith('GET /app ')).length, 3, 'the App itself is asked every time')
  })
})

test('a bot lookup that failed is not remembered', async () => {
  await withRemote(async (rig) => {
    rig.world.github.failNext('/users/dish-test%5Bbot%5D', 500, { message: 'oops' })
    assert.equal((await rig.remote.test()).bot, null)
    updated(rig, PRIVATE_KEY_NAME)
    assert.equal((await rig.remote.test()).bot?.login, 'dish-test[bot]')
    assert.equal(rig.world.github.requests.filter(request => request.path.startsWith('/users/')).length, 2)
  })
})

test('GitHub failing: the error names the call, and a later test goes through', async () => {
  await withRemote(async (rig) => {
    rig.world.github.failNext('/app', 502, { message: 'Bad Gateway' })
    const down = await rig.remote.test()
    assert.match(down.error ?? '', /HTTP 502/)
    const up = await rig.remote.test()
    assert.equal(up.error, null)
    assert.equal(up.installations.length, 1)
  })
})

test('the names the card is told are the plugin\'s rows', async () => {
  await withRemote(async (rig) => {
    const status = await rig.remote.status()
    assert.deepEqual(status.names, { appId: 'MY_APP_ID', privateKey: 'MY_APP_KEY' })
    assert.equal(status.error, null)
  }, { appIdName: 'MY_APP_ID', privateKeyName: 'MY_APP_KEY' })
})

test('the remote goes with the plugin', async () => {
  const world = await startServiceWorld()
  const ctx = new Context()
  const credentials = provideStub(ctx, 'credentials', credentialsStub(world.credentials))
  await credentials
  const workspaces = ctx.plugin({
    name: plugin.name,
    apply: (inner: Context, config: plugin.Config) => { plugin.start(inner, config, world.internals({ timers: fakeTimers() })) },
  } as never, { appIdName: APP_ID_NAME, privateKeyName: PRIVATE_KEY_NAME, terminal: false } as never)
  await workspaces
  await waitFor('the remote', () => ctx.get('dishWorkspacesRemote'))
  await workspaces.dispose()
  assert.equal(ctx.get('dishWorkspacesRemote'), undefined)
  await credentials.dispose()
})
