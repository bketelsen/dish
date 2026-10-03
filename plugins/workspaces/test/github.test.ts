import assert from 'node:assert/strict'
import { createPrivateKey, generateKeyPairSync, verify } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, it } from 'node:test'
import {
  appJwt, botIdentity, GITHUB_API, GITHUB_WEB, GitHubApp, GitHubError, PULL_PERMISSIONS, PUSH_PERMISSIONS,
} from '../src/github.ts'
import type { AppCredentials, GitHubErrorKind, WritePermissions } from '../src/github.ts'
import { LINK_ORIGIN, WRITE_APP_PERMISSIONS, startFakeGitHub, testKeys } from './fake-github-api.ts'

const keys = testKeys()
const APP_ID = 4242

function decode(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>
}

/** A credentials function that counts its calls. */
function credentialsOf(value: AppCredentials | undefined): (() => Promise<AppCredentials | undefined>) & { calls: number } {
  const fn = Object.assign(async () => { fn.calls++; return value }, { calls: 0 })
  return fn
}

async function setup(options: { appId?: number, permissions?: Readonly<Record<string, string>> } = {}) {
  const fake = await startFakeGitHub({ publicKey: keys.publicKey, appId: options.appId, ...(options.permissions === undefined ? {} : { permissions: options.permissions }) })
  const credentials = credentialsOf({ appId: String(APP_ID), privateKey: keys.privateKeyPem })
  const app = new GitHubApp(credentials, { api: fake.api })
  return { fake, credentials, app }
}

/** `promise` rejects with a GitHubError of `kind`; returns it. */
async function rejectsWith(promise: Promise<unknown>, kind: GitHubErrorKind): Promise<GitHubError> {
  try {
    await promise
  } catch (error) {
    assert.ok(error instanceof GitHubError, `expected a GitHubError, got ${String(error)}`)
    assert.equal(error.kind, kind, error.message)
    return error
  }
  assert.fail(`expected a GitHubError (${kind})`)
}

describe('appJwt', () => {
  it('is an RS256 JWT with iat a minute back, exp nine minutes on, and iss the App id', () => {
    const now = 1_790_000_000_123
    const jwt = appJwt({ appId: '4242', privateKey: keys.privateKeyPem }, now)
    const parts = jwt.split('.')
    assert.equal(parts.length, 3)
    assert.deepEqual(decode(parts[0]!), { alg: 'RS256', typ: 'JWT' })
    assert.deepEqual(decode(parts[1]!), { iat: 1_790_000_000 - 60, exp: 1_790_000_000 + 540, iss: '4242' })
    assert.ok(verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), keys.publicKey, Buffer.from(parts[2]!, 'base64url')))
  })

  it('takes a PKCS#8 key too', () => {
    const pkcs8 = createPrivateKey(keys.privateKeyPem).export({ type: 'pkcs8', format: 'pem' }) as string
    assert.match(pkcs8, /BEGIN PRIVATE KEY/)
    const jwt = appJwt({ appId: '4242', privateKey: pkcs8 })
    const [header, payload, signature] = jwt.split('.') as [string, string, string]
    assert.ok(verify('sha256', Buffer.from(`${header}.${payload}`), keys.publicKey, Buffer.from(signature, 'base64url')))
  })

  it('takes the App id and the key with surrounding whitespace, as pasted', () => {
    const jwt = appJwt({ appId: ' 4242\n', privateKey: `\n${keys.privateKeyPem}\n\n` }, 1_790_000_000_000)
    assert.equal(decode(jwt.split('.')[1]!).iss, '4242')
  })

  it('throws `key` for a key it cannot read, without quoting it', () => {
    const garbage = '-----BEGIN RSA PRIVATE KEY-----\nnot-really-a-key-ZmFrZWtleW1hdGVyaWFs\n-----END RSA PRIVATE KEY-----\n'
    let thrown: unknown
    try {
      appJwt({ appId: '4242', privateKey: garbage })
    } catch (error) {
      thrown = error
    }
    assert.ok(thrown instanceof GitHubError)
    assert.equal(thrown.kind, 'key')
    assert.ok(!thrown.message.includes('not-really-a-key'), thrown.message)
    assert.ok(!thrown.message.includes('ZmFrZWtleW1hdGVyaWFs'), thrown.message)
    assert.ok(!String(thrown.stack).includes('ZmFrZWtleW1hdGVyaWFs'))
  })

  it('throws `key` for a key that is not RSA', () => {
    const { privateKey } = generateKeyPairSync('ed25519')
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
    assert.throws(() => appJwt({ appId: '4242', privateKey: pem }), (error: unknown) => error instanceof GitHubError && error.kind === 'key')
  })

  it('throws `no-credentials` for an empty App id', () => {
    assert.throws(() => appJwt({ appId: '  ', privateKey: keys.privateKeyPem }), (error: unknown) => error instanceof GitHubError && error.kind === 'no-credentials')
  })
})

describe('GitHubApp against the fake', () => {
  it('app() reads the App with a JWT', async () => {
    const { fake, app, credentials } = await setup()
    assert.deepEqual(await app.app(), fake.app)
    assert.deepEqual(fake.requests.map(r => [r.method, r.path, r.auth, r.status]), [['GET', '/app', 'jwt', 200]])
    assert.equal(credentials.calls, 1)
  })

  it('reads the credentials again for every request, and never keeps them', async () => {
    const { app, credentials } = await setup()
    await app.app()
    await app.app()
    assert.equal(credentials.calls, 2)
    // Nothing of the key is on the object.
    assert.ok(!JSON.stringify(Object.entries(app)).includes('PRIVATE KEY'))
  })

  it('installations() reads every page', async () => {
    const { fake, app } = await setup()
    for (let i = 1; i <= 150; i++) fake.installations.set(`owner-${i}`, { id: 1000 + i, account: `Owner-${i}`, repos: i % 2 === 0 ? 'all' : new Set(['x']) })
    const list = await app.installations()
    assert.equal(list.length, 150)
    assert.deepEqual(list[0], { id: 1001, account: 'Owner-1', accountType: 'Organization', selection: 'selected' })
    assert.deepEqual(list[1], { id: 1002, account: 'Owner-2', accountType: 'Organization', selection: 'all' })
    assert.deepEqual(fake.requests.map(r => r.path), ['/app/installations?per_page=100&page=1', '/app/installations?per_page=100&page=2'])
  })

  it('installations() with none is an empty list', async () => {
    const { app } = await setup()
    assert.deepEqual(await app.installations(), [])
  })

  it('installationFor() finds the installation, and a 404 is undefined', async () => {
    const { fake, app } = await setup()
    fake.installations.set('acme', { id: 77, account: 'Acme', repos: new Set(['widget']) })
    assert.deepEqual(await app.installationFor('acme', 'widget'), { id: 77, account: 'Acme', accountType: 'Organization', selection: 'selected' })
    assert.equal(await app.installationFor('acme', 'gadget'), undefined)
    assert.equal(await app.installationFor('nobody', 'widget'), undefined)
    assert.deepEqual(fake.requests.map(r => [r.path, r.auth, r.status]), [
      ['/repos/acme/widget/installation', 'jwt', 200],
      ['/repos/acme/gadget/installation', 'jwt', 404],
      ['/repos/nobody/widget/installation', 'jwt', 404],
    ])
  })

  it('createToken() asks for exactly the read permissions and the repositories given', async () => {
    const { fake, app } = await setup()
    fake.installations.set('acme', { id: 77, account: 'Acme', repos: new Set(['widget', 'gadget']) })
    const before = Date.now()
    const token = await app.createToken(77, ['widget', 'gadget'], { contents: 'read', metadata: 'read' })
    assert.equal(fake.minted.length, 1)
    assert.deepEqual(fake.minted[0]!.permissions, { contents: 'read', metadata: 'read' })
    assert.deepEqual(fake.minted[0]!.repositories, ['widget', 'gadget'])
    assert.equal(fake.minted[0]!.installation, 77)
    assert.equal(token.token, fake.minted[0]!.token)
    assert.match(token.token, /^ghs_[A-Za-z0-9]{36}$/)
    assert.deepEqual(token.permissions, { contents: 'read', metadata: 'read' })
    assert.deepEqual(token.repositories, ['widget', 'gadget'])
    // An hour, to the second GitHub writes.
    assert.ok(token.expiresAt >= before + 3_600_000 - 1000 && token.expiresAt <= Date.now() + 3_600_000, String(token.expiresAt))
    assert.deepEqual(fake.requests.map(r => [r.method, r.path, r.auth]), [['POST', '/app/installations/77/access_tokens', 'jwt']])
  })

  it('createToken() refuses a token GitHub granted more than read, and returns none', async () => {
    const { fake, app } = await setup()
    fake.installations.set('acme', { id: 77, account: 'Acme', repos: new Set(['widget']) })
    const token = `ghs_${'W'.repeat(36)}`
    fake.failNext('/app/installations/77/access_tokens', 201, {
      token,
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      permissions: { contents: 'write', metadata: 'read' },
      repositories: [{ name: 'widget' }],
    })
    let returned: unknown
    let thrown: unknown
    try {
      returned = await app.createToken(77, ['widget'], { contents: 'read', metadata: 'read' })
    } catch (error) {
      thrown = error
    }
    assert.equal(returned, undefined)
    assert.ok(thrown instanceof GitHubError, String(thrown))
    assert.equal(thrown.kind, 'other')
    assert.match(thrown.message, /more than read/)
    assert.ok(!thrown.message.includes(token))
    assert.ok(!String(thrown.stack).includes(token))
  })

  it('botUser() looks up <slug>[bot] with a token', async () => {
    const { fake, app } = await setup()
    fake.installations.set('acme', { id: 77, account: 'Acme', repos: new Set(['widget']) })
    const { token } = await app.createToken(77, ['widget'], { metadata: 'read', pull_requests: 'read' })
    assert.deepEqual(await app.botUser('dish-test', token), { id: fake.bot.id, login: 'dish-test[bot]' })
    const last = fake.requests.at(-1)!
    assert.deepEqual([last.method, last.path, last.auth, last.status], ['GET', '/users/dish-test%5Bbot%5D', 'token', 200])
  })

  it('botUser() without a token asks without a credential, reading no App credentials (a public endpoint: no installation permission needed)', async () => {
    const { fake, app, credentials } = await setup()
    assert.deepEqual(await app.botUser('dish-test'), { id: fake.bot.id, login: 'dish-test[bot]' })
    const last = fake.requests.at(-1)!
    assert.deepEqual([last.method, last.path, last.auth, last.status], ['GET', '/users/dish-test%5Bbot%5D', 'none', 200])
    assert.equal(fake.minted.length, 0)
    assert.equal(credentials.calls, 0)
  })

  it('pullsForCommit() lists the pull requests, and a 404 or a 422 is an empty list', async () => {
    const { fake, app } = await setup()
    fake.installations.set('acme', { id: 77, account: 'Acme', repos: new Set(['widget']) })
    const { token } = await app.createToken(77, ['widget'], { metadata: 'read', pull_requests: 'read' })
    const tip = 'a'.repeat(40)
    fake.pulls.set(tip, [
      { number: 12, state: 'closed', mergedAt: '2026-10-01T10:00:00Z', headSha: tip, headRef: 'dish/fix-1' },
      { number: 13, state: 'open', mergedAt: null, headSha: 'b'.repeat(40), headRef: 'dish/other' },
    ])
    assert.deepEqual(await app.pullsForCommit('acme', 'widget', tip, token), fake.pulls.get(tip))
    assert.equal(fake.requests.at(-1)!.path, `/repos/acme/widget/commits/${tip}/pulls?per_page=100`)
    assert.equal(fake.requests.at(-1)!.auth, 'token')

    // A sha GitHub hasn't: 422, as GitHub answers.
    assert.deepEqual(await app.pullsForCommit('acme', 'widget', 'c'.repeat(40), token), [])
    assert.equal(fake.requests.at(-1)!.status, 422)

    fake.failNext(`/repos/acme/widget/commits/${tip}/pulls`, 404, { message: 'Not Found' })
    assert.deepEqual(await app.pullsForCommit('acme', 'widget', tip, token), [])
    assert.equal(fake.requests.at(-1)!.status, 404)
  })

  it('pullsForCommit() with the file token (no pull_requests) is refused by the fake', async () => {
    const { fake, app } = await setup()
    fake.installations.set('acme', { id: 77, account: 'Acme', repos: new Set(['widget']) })
    const { token } = await app.createToken(77, ['widget'], { contents: 'read', metadata: 'read' })
    fake.pulls.set('a'.repeat(40), [])
    await rejectsWith(app.pullsForCommit('acme', 'widget', 'a'.repeat(40), token), 'auth')
  })

  it('a JWT signed with another key is refused (the fake checks the signature)', async () => {
    const fake = await startFakeGitHub({ publicKey: keys.publicKey })
    const other = testKeys()
    const app = new GitHubApp(async () => ({ appId: String(APP_ID), privateKey: other.privateKeyPem }), { api: fake.api })
    await rejectsWith(app.app(), 'auth')
  })

  it('a JWT for another App id is refused', async () => {
    const { fake } = await setup({ appId: 9 })
    const app = new GitHubApp(async () => ({ appId: '4242', privateKey: keys.privateKeyPem }), { api: fake.api })
    await rejectsWith(app.app(), 'auth')
  })
})

describe('botIdentity', () => {
  it('is the bot name and its noreply address', () => {
    assert.deepEqual(botIdentity('dish-test', 9_000_001), { name: 'dish-test[bot]', email: '9000001+dish-test[bot]@users.noreply.github.com' })
  })
})

describe('refusals before any request', () => {
  it('createToken refuses a permission that is not read', async () => {
    const { fake, app, credentials } = await setup()
    fake.installations.set('acme', { id: 77, account: 'Acme', repos: new Set(['widget']) })
    const write = { contents: 'write', metadata: 'read' } as unknown as Record<string, 'read'>
    await assert.rejects(app.createToken(77, ['widget'], write), /read/)
    const admin = { administration: 'admin' } as unknown as Record<string, 'read'>
    await assert.rejects(app.createToken(77, ['widget'], admin), /read/)
    assert.equal(fake.requests.length, 0)
    assert.equal(fake.minted.length, 0)
    assert.equal(credentials.calls, 0)
  })

  it('createToken refuses no repositories, and no permissions', async () => {
    const { fake, app, credentials } = await setup()
    await assert.rejects(app.createToken(77, [], { contents: 'read' }), /repositor/)
    await assert.rejects(app.createToken(77, ['widget'], {}), /permission/)
    assert.equal(fake.requests.length, 0)
    assert.equal(credentials.calls, 0)
  })

  it('no credentials is `no-credentials`, with nothing sent', async () => {
    const fake = await startFakeGitHub({ publicKey: keys.publicKey })
    const app = new GitHubApp(async () => undefined, { api: fake.api })
    await rejectsWith(app.app(), 'no-credentials')
    await rejectsWith(app.installationFor('acme', 'widget'), 'no-credentials')
    await rejectsWith(app.createToken(77, ['widget'], { contents: 'read' }), 'no-credentials')
    assert.equal(fake.requests.length, 0)
  })

  it('a bad key is `key`, with nothing sent', async () => {
    const fake = await startFakeGitHub({ publicKey: keys.publicKey })
    const app = new GitHubApp(async () => ({ appId: '4242', privateKey: 'nope' }), { api: fake.api })
    const error = await rejectsWith(app.app(), 'key')
    assert.ok(!error.message.includes('nope'))
    assert.equal(fake.requests.length, 0)
  })
})

describe('errors', () => {
  const cases: Array<[number, Record<string, string>, GitHubErrorKind]> = [
    [401, {}, 'auth'],
    [403, {}, 'auth'],
    [403, { 'x-ratelimit-remaining': '0' }, 'rate-limited'],
    [403, { 'retry-after': '60' }, 'rate-limited'],
    [429, {}, 'rate-limited'],
    [404, {}, 'not-found'],
    [422, {}, 'unprocessable'],
    [500, {}, 'other'],
    [502, {}, 'other'],
  ]
  for (const [status, headers, kind] of cases) {
    it(`HTTP ${status}${Object.keys(headers).length > 0 ? ' with ' + JSON.stringify(headers) : ''} is ${kind}, naming the call and the status`, async () => {
      const { fake, app } = await setup()
      fake.failNext('/app', status, { message: `fake says ${status}` }, headers)
      const error = await rejectsWith(app.app(), kind)
      assert.equal(error.status, status)
      assert.match(error.message, new RegExp(`^GET /app\\b.*HTTP ${status}: fake says ${status}$`))
    })
  }

  it('a redirect is not followed', async () => {
    const { fake, app } = await setup()
    fake.failNext('/app', 301, { message: 'Moved Permanently' }, { location: `${fake.api}/elsewhere` })
    const error = await rejectsWith(app.app(), 'other')
    assert.equal(error.status, 301)
    assert.equal(fake.requests.length, 1)
  })

  it('a token in the response message is masked, and the message is cut short', async () => {
    const { fake, app } = await setup()
    const leaked = `ghs_${'Q'.repeat(36)}`
    fake.failNext('/app', 422, { message: `bad token ${leaked} ${'x'.repeat(500)}` })
    const error = await rejectsWith(app.app(), 'unprocessable')
    assert.ok(!error.message.includes('ghs_'), error.message)
    assert.ok(!error.message.includes('QQQQ'), error.message)
    assert.match(error.message, /‹secret: a GitHub token›/)
    assert.ok(error.message.length < 'GET /app answered HTTP 422: '.length + 205, String(error.message.length))
  })

  it('a token used for a request never reaches the error', async () => {
    const { fake, app } = await setup()
    fake.installations.set('acme', { id: 77, account: 'Acme', repos: new Set(['widget']) })
    const { token } = await app.createToken(77, ['widget'], { metadata: 'read', pull_requests: 'read' })
    fake.failNext('/users/dish-test%5Bbot%5D', 500, { message: 'boom' })
    const error = await rejectsWith(app.botUser('dish-test', token), 'other')
    assert.ok(!error.message.includes(token))
    assert.ok(!String(error.stack).includes(token))
    assert.ok(!error.message.includes('ghs_'))
  })

  it('an answer that is not JSON, or not the right shape, is `other`', async () => {
    const server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(req.url === '/app' ? 'not json' : '{"id": "x"}')
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      const app = new GitHubApp(async () => ({ appId: '4242', privateKey: keys.privateKeyPem }), { api })
      await rejectsWith(app.app(), 'other')
      await rejectsWith(app.installationFor('acme', 'widget'), 'other')
    } finally {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('a server that is not there is `network`', async () => {
    const server = createServer()
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    await new Promise<void>(resolve => server.close(() => resolve()))
    const app = new GitHubApp(async () => ({ appId: '4242', privateKey: keys.privateKeyPem }), { api })
    const error = await rejectsWith(app.app(), 'network')
    assert.equal(error.status, undefined)
    assert.match(error.message, /^GET \/app\b/)
  })

  it('a timeout is `network`', async () => {
    const hanging: typeof fetch = (_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
    const app = new GitHubApp(async () => ({ appId: '4242', privateKey: keys.privateKeyPem }), { api: 'http://127.0.0.1:9', fetch: hanging, timeoutMs: 50 })
    const error = await rejectsWith(app.app(), 'network')
    assert.match(error.message, /timed out/)
  })

  it('a body that stalls after the headers times out too', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.write('{"id": ')
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      const app = new GitHubApp(async () => ({ appId: '4242', privateKey: keys.privateKeyPem }), { api, timeoutMs: 100 })
      await rejectsWith(app.app(), 'network')
    } finally {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})

describe('requests', () => {
  /** A fetch that records each call and answers `body` with 200. No network. */
  function recording(body: unknown) {
    const calls: Array<{ url: string, init: RequestInit }> = []
    const fn: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} })
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return { fn, calls }
  }

  it('go to api.github.com by default, with the contract headers, a JWT for /app and no redirects', async () => {
    assert.equal(GITHUB_API, 'https://api.github.com')
    assert.equal(GITHUB_WEB, 'https://github.com')
    const { fn, calls } = recording({ id: 1, slug: 's', name: 'n' })
    const app = new GitHubApp(async () => ({ appId: '4242', privateKey: keys.privateKeyPem }), { fetch: fn })
    await app.app()
    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.url, 'https://api.github.com/app')
    const headers = new Headers(calls[0]!.init.headers)
    assert.equal(headers.get('accept'), 'application/vnd.github+json')
    assert.equal(headers.get('x-github-api-version'), '2022-11-28')
    assert.equal(headers.get('user-agent'), 'dish-workspaces')
    assert.match(headers.get('authorization') ?? '', /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/)
    assert.equal(calls[0]!.init.method, 'GET')
    assert.notEqual(calls[0]!.init.redirect, 'follow')
    assert.ok(calls[0]!.init.signal instanceof AbortSignal)
  })

  it('a token goes only in the Authorization header, as `token <token>`', async () => {
    const { fn, calls } = recording({ id: 5, login: 'x[bot]' })
    const app = new GitHubApp(async () => undefined, { fetch: fn })
    const token = `ghs_${'Z'.repeat(36)}`
    await app.botUser('x', token)
    const headers = new Headers(calls[0]!.init.headers)
    assert.equal(headers.get('authorization'), `token ${token}`)
    assert.ok(!calls[0]!.url.includes(token))
    assert.equal(calls[0]!.url, 'https://api.github.com/users/x%5Bbot%5D')
  })

  it('botUser() without a token sends no Authorization header at all', async () => {
    const { fn, calls } = recording({ id: 5, login: 'x[bot]' })
    const app = new GitHubApp(async () => ({ appId: '4242', privateKey: keys.privateKeyPem }), { fetch: fn })
    assert.deepEqual(await app.botUser('x'), { id: 5, login: 'x[bot]' })
    const headers = new Headers(calls[0]!.init.headers)
    assert.equal(headers.get('authorization'), null)
    assert.equal(headers.get('user-agent'), 'dish-workspaces')
    assert.equal(calls[0]!.url, 'https://api.github.com/users/x%5Bbot%5D')
  })

  it('a token that is not one header value is refused before any request', async () => {
    const { fn, calls } = recording({})
    const app = new GitHubApp(async () => undefined, { fetch: fn })
    await assert.rejects(app.botUser('x', 'ghs_abc\nX-Other: 1'))
    await assert.rejects(app.botUser('x', ''))
    assert.equal(calls.length, 0)
  })

  it('a path segment that is not one is refused before any request', async () => {
    const { fn, calls } = recording([])
    const app = new GitHubApp(async () => ({ appId: '4242', privateKey: keys.privateKeyPem }), { fetch: fn })
    await assert.rejects(app.installationFor('..', 'widget'))
    await assert.rejects(app.installationFor('acme', '.'))
    await assert.rejects(app.pullsForCommit('acme', 'widget', '../../x', 'ghs_' + 'a'.repeat(36)))
    assert.equal(calls.length, 0)
  })
})

// --- step 7: write tokens, pull requests and their feedback --------------------------------------------------------

/** A fake with step 7's App installed on acme (widget and gadget), and a client for it. */
async function writeSetup() {
  const world = await setup({ permissions: WRITE_APP_PERMISSIONS })
  world.fake.installations.set('acme', { id: 77, account: 'Acme', repos: new Set(['widget', 'gadget']) })
  return world
}

describe('createWriteToken', () => {
  it('asks for exactly PUSH_PERMISSIONS or PULL_PERMISSIONS for one repository; anything else throws before a request', async () => {
    const { fake, app, credentials } = await writeSetup()
    assert.deepEqual(PUSH_PERMISSIONS, { contents: 'write', metadata: 'read' })
    assert.deepEqual(PULL_PERMISSIONS, { metadata: 'read', pull_requests: 'write' })
    assert.ok(Object.isFrozen(PUSH_PERMISSIONS) && Object.isFrozen(PULL_PERMISSIONS))
    const push = await app.createWriteToken(77, 'widget', PUSH_PERMISSIONS)
    assert.deepEqual(fake.minted.at(-1), { installation: 77, token: push.token, repositories: ['widget'], permissions: { contents: 'write', metadata: 'read' } })
    assert.deepEqual(push.permissions, { contents: 'write', metadata: 'read' })
    assert.deepEqual(push.repositories, ['widget'])
    const pull = await app.createWriteToken(77, 'gadget', { pull_requests: 'write', metadata: 'read' })
    assert.deepEqual(fake.minted.at(-1)!.permissions, { pull_requests: 'write', metadata: 'read' })
    assert.deepEqual(fake.minted.at(-1)!.repositories, ['gadget'])
    assert.notEqual(pull.token, push.token)

    const requests = fake.requests.length
    const calls = credentials.calls
    const refused: Array<[number, string, unknown, RegExp]> = [
      [0, 'widget', PUSH_PERMISSIONS, /installation id/],
      [1.5, 'widget', PUSH_PERMISSIONS, /installation id/],
      [77, '', PUSH_PERMISSIONS, /repository/],
      [77, 'a/b', PUSH_PERMISSIONS, /repository/],
      [77, 'x'.repeat(101), PUSH_PERMISSIONS, /repository/],
      [77, 'widget', { contents: 'write' }, /only for a push \(contents\) or a pull request \(pull_requests\)/],
      [77, 'widget', { contents: 'write', metadata: 'read', pull_requests: 'write' }, /only for a push/],
      [77, 'widget', { contents: 'write', metadata: 'write' }, /only for a push/],
      [77, 'widget', { administration: 'write', metadata: 'read' }, /only for a push/],
      [77, 'widget', { contents: 'read', metadata: 'read' }, /only for a push/],
      [77, 'widget', { workflows: 'write', metadata: 'read' }, /only for a push/],
      [77, 'widget', {}, /only for a push/],
    ]
    for (const [installation, repository, permissions, pattern] of refused) {
      await assert.rejects(app.createWriteToken(installation, repository, permissions as WritePermissions), pattern, JSON.stringify([installation, repository, permissions]))
    }
    assert.equal(fake.requests.length, requests)
    assert.equal(credentials.calls, calls)
  })

  it('refuses a token GitHub granted more than asked, or for another repository', async () => {
    const { fake, app } = await writeSetup()
    const token = `ghs_${'W'.repeat(36)}`
    const answer = (permissions: Record<string, string>, repositories: unknown) => ({
      token, expires_at: new Date(Date.now() + 3_600_000).toISOString(), permissions, repositories,
    })
    const cases: Array<[WritePermissions, object, RegExp]> = [
      [PUSH_PERMISSIONS, answer({ contents: 'write', metadata: 'read', pull_requests: 'write' }, [{ name: 'widget' }]), /more than asked/],
      [PUSH_PERMISSIONS, answer({ contents: 'write', metadata: 'write' }, [{ name: 'widget' }]), /more than asked/],
      [PULL_PERMISSIONS, answer({ metadata: 'read', pull_requests: 'admin' }, [{ name: 'widget' }]), /more than asked/],
      [PULL_PERMISSIONS, answer({ metadata: 'read', pull_requests: 'write', workflows: 'write' }, [{ name: 'widget' }]), /more than asked/],
      [PUSH_PERMISSIONS, answer({ contents: 'write', metadata: 'read' }, [{ name: 'widget' }, { name: 'gadget' }]), /other repositories/],
      [PUSH_PERMISSIONS, answer({ contents: 'write', metadata: 'read' }, [{ name: 'gadget' }]), /other repositories/],
      [PUSH_PERMISSIONS, answer({ contents: 'write', metadata: 'read' }, undefined), /other repositories/],
    ]
    for (const [permissions, body, pattern] of cases) {
      fake.failNext('/app/installations/77/access_tokens', 201, body)
      const error = await rejectsWith(app.createWriteToken(77, 'widget', permissions), 'other')
      assert.match(error.message, pattern)
      assert.match(error.message, /not used/)
      assert.ok(!error.message.includes(token) && !String(error.stack).includes(token))
    }
    // Fewer than asked is GitHub's business (the call that needs more fails); the name's case is not.
    fake.failNext('/app/installations/77/access_tokens', 201, answer({ contents: 'write', metadata: 'read' }, [{ name: 'Widget' }]))
    assert.equal((await app.createWriteToken(77, 'widget', PUSH_PERMISSIONS)).token, token)
    // A malformed answer.
    fake.failNext('/app/installations/77/access_tokens', 201, { token: 42 })
    assert.match((await rejectsWith(app.createWriteToken(77, 'widget', PUSH_PERMISSIONS), 'other')).message, /malformed/)
  })

  it('an App without Contents write gets a 422 for a push token', async () => {
    const { fake, app } = await setup()
    fake.installations.set('acme', { id: 77, account: 'Acme', repos: new Set(['widget']) })
    await rejectsWith(app.createWriteToken(77, 'widget', PUSH_PERMISSIONS), 'unprocessable')
    await rejectsWith(app.createWriteToken(77, 'widget', PULL_PERMISSIONS), 'unprocessable')
    assert.equal(fake.minted.length, 0)
  })
})

describe('pull requests', () => {
  it('createPull posts title, head, base and body with the token, and gives the number, URL and base', async () => {
    const { fake, app } = await writeSetup()
    const { token } = await app.createWriteToken(77, 'widget', PULL_PERMISSIONS)
    const opened = await app.createPull('acme', 'widget', { title: 'Fix it', head: 'dish/fix-1', base: 'main', body: 'Why.\n' }, token)
    assert.deepEqual(opened, { number: 1, url: 'https://github.com/acme/widget/pull/1', base: 'main' })
    assert.equal(fake.pullRequests.length, 1)
    const pull = fake.pullRequests[0]!
    assert.deepEqual([pull.repo, pull.title, pull.head, pull.base, pull.body, pull.state], ['acme/widget', 'Fix it', 'dish/fix-1', 'main', 'Why.\n', 'open'])
    const last = fake.requests.at(-1)!
    assert.deepEqual([last.method, last.path, last.auth, last.status], ['POST', '/repos/acme/widget/pulls', 'token', 201])
    // The read-only API token can't.
    const read = (await app.createToken(77, ['widget'], { metadata: 'read', pull_requests: 'read' })).token
    await rejectsWith(app.createPull('acme', 'widget', { title: 'x', head: 'dish/x', base: 'main', body: '' }, read), 'auth')
    // A 201 without a number or a URL is malformed.
    fake.failNext('/repos/acme/widget/pulls', 201, { html_url: 'https://github.com/acme/widget/pull/9' })
    assert.match((await rejectsWith(app.createPull('acme', 'widget', { title: 'x', head: 'dish/y', base: 'main', body: '' }, token), 'other')).message, /malformed/)
    await assert.rejects(app.createPull('..', 'widget', { title: 'x', head: 'dish/y', base: 'main', body: '' }, token))
    await assert.rejects(app.createPull('acme', 'widget', { title: 'x', head: 'dish/y', base: 'main', body: '' }, 'not a token'))
  })

  it('findOpenPull asks for <owner>:<branch>, open, and gives the first with that head; none is undefined', async () => {
    const { fake, app } = await writeSetup()
    const { token } = await app.createWriteToken(77, 'widget', PULL_PERMISSIONS)
    assert.equal(await app.findOpenPull('acme', 'widget', 'dish/fix-1', token), undefined)
    assert.equal(fake.requests.at(-1)!.path, `/repos/acme/widget/pulls?head=${encodeURIComponent('acme:dish/fix-1')}&state=open&per_page=100`)
    await app.createPull('acme', 'widget', { title: 'Other', head: 'dish/other', base: 'main', body: '' }, token)
    await app.createPull('acme', 'widget', { title: 'Fix', head: 'dish/fix-1', base: 'main', body: '' }, token)
    assert.deepEqual(await app.findOpenPull('acme', 'widget', 'dish/fix-1', token), { number: 2, url: 'https://github.com/acme/widget/pull/2', base: 'main' })
    // A closed one isn't open.
    fake.pullRequests[1]!.state = 'closed'
    assert.equal(await app.findOpenPull('acme', 'widget', 'dish/fix-1', token), undefined)
    // An answer whose head isn't the branch is skipped; one that isn't a list is malformed.
    fake.failNext('/repos/acme/widget/pulls', 200, [{ number: 5, html_url: 'u', head: { ref: 'dish/else' }, base: { ref: 'main' } }])
    assert.equal(await app.findOpenPull('acme', 'widget', 'dish/fix-1', token), undefined)
    fake.failNext('/repos/acme/widget/pulls', 200, { not: 'a list' })
    await rejectsWith(app.findOpenPull('acme', 'widget', 'dish/fix-1', token), 'other')
  })

  it("a 422 names GitHub's errors, masked and cut; a body without errors reads as before", async () => {
    const { fake, app } = await writeSetup()
    const { token } = await app.createWriteToken(77, 'widget', PULL_PERMISSIONS)
    const pull = { title: 'Fix', head: 'dish/fix-1', base: 'main', body: '' }
    await app.createPull('acme', 'widget', pull, token)
    const again = await rejectsWith(app.createPull('acme', 'widget', pull, token), 'unprocessable')
    assert.equal(again.message, 'POST /repos/acme/widget/pulls answered HTTP 422: Validation Failed (A pull request already exists for Acme:dish/fix-1.)')
    const missing = await rejectsWith(app.createPull('acme', 'widget', { ...pull, head: 'dish/two', title: '' }, token), 'unprocessable')
    assert.equal(missing.message, 'POST /repos/acme/widget/pulls answered HTTP 422: Validation Failed (PullRequest title missing_field)')
    const leaked = `ghs_${'Q'.repeat(36)}`
    fake.failNext('/repos/acme/widget/pulls', 422, {
      message: 'Validation Failed',
      errors: [{ message: `No commits between main and ${leaked}` }, { resource: 'PullRequest', code: 'custom' }, 'not an object', { message: 'x'.repeat(400) }],
    })
    const long = await rejectsWith(app.createPull('acme', 'widget', { ...pull, head: 'dish/three' }, token), 'unprocessable')
    assert.ok(!long.message.includes(leaked) && !long.message.includes('QQQQ'), long.message)
    assert.match(long.message, /Validation Failed \(No commits between main and ‹secret: a GitHub token›; PullRequest custom; x+…$/)
    assert.ok(long.message.length <= 'POST /repos/acme/widget/pulls answered HTTP 422: '.length + 200, String(long.message.length))
    fake.failNext('/repos/acme/widget/pulls', 422, { message: 'Just this' })
    assert.equal((await rejectsWith(app.createPull('acme', 'widget', { ...pull, head: 'dish/four' }, token), 'unprocessable')).message,
      'POST /repos/acme/widget/pulls answered HTTP 422: Just this')
  })

  it('updatePull PATCHes only the fields given; createComment posts the body', async () => {
    const { fake, app } = await writeSetup()
    const { token } = await app.createWriteToken(77, 'widget', PULL_PERMISSIONS)
    await app.createPull('acme', 'widget', { title: 'Fix', head: 'dish/fix-1', base: 'main', body: 'Old body' }, token)
    await app.updatePull('acme', 'widget', 1, { title: 'New title' }, token)
    await app.updatePull('acme', 'widget', 1, { body: 'New body' }, token)
    await app.updatePull('acme', 'widget', 1, { title: 'Both', body: '' }, token)
    assert.deepEqual(fake.pullEdits, [
      { repo: 'acme/widget', number: 1, title: 'New title' },
      { repo: 'acme/widget', number: 1, body: 'New body' },
      { repo: 'acme/widget', number: 1, title: 'Both', body: '' },
    ])
    assert.equal(fake.requests.at(-1)!.method, 'PATCH')
    assert.equal(fake.requests.at(-1)!.path, '/repos/acme/widget/pulls/1')
    await rejectsWith(app.updatePull('acme', 'widget', 9, { title: 'x' }, token), 'not-found')
    await app.createComment('acme', 'widget', 1, 'A comment', token)
    assert.deepEqual(fake.comments, [{ repo: 'acme/widget', number: 1, body: 'A comment' }])
    assert.deepEqual([fake.requests.at(-1)!.method, fake.requests.at(-1)!.path, fake.requests.at(-1)!.status], ['POST', '/repos/acme/widget/issues/1/comments', 201])
    await rejectsWith(app.createComment('acme', 'widget', 9, 'x', token), 'not-found')
    await assert.rejects(app.updatePull('acme', 'widget', 0, { title: 'x' }, token), /pull request number/)
    await assert.rejects(app.createComment('acme', 'widget', -1, 'x', token), /pull request number/)
  })

  it('pullDetails, pullReviews, pullReviewComments, issueComments, checkRuns and combinedStatus read their endpoints (per_page=100) with the token, and say when a page was full', async () => {
    const { fake, app } = await writeSetup()
    const write = (await app.createWriteToken(77, 'widget', PULL_PERMISSIONS)).token
    await app.createPull('acme', 'widget', { title: 'Fix', head: 'dish/fix-1', base: 'main', body: '' }, write)
    const sha = 'b'.repeat(40)
    Object.assign(fake.pullRequests[0]!, { headSha: sha, mergeable: true, mergeableState: 'clean', draft: true })
    const token = (await app.createToken(77, ['widget'], { metadata: 'read', pull_requests: 'read', checks: 'read', statuses: 'read' })).token
    assert.deepEqual(await app.pullDetails('acme', 'widget', 1, token), {
      number: 1, url: 'https://github.com/acme/widget/pull/1', title: 'Fix', state: 'open', merged: false, draft: true,
      mergeable: true, mergeableState: 'clean', head: { ref: 'dish/fix-1', sha }, base: { ref: 'main' },
    })
    assert.equal(fake.requests.at(-1)!.path, '/repos/acme/widget/pulls/1')
    await rejectsWith(app.pullDetails('acme', 'widget', 2, token), 'not-found')

    const review = { id: 1, user: { login: 'ann' }, state: 'APPROVED', body: 'Fine', commit_id: sha }
    fake.feedback('acme/widget', 1, {
      reviews: [review],
      reviewComments: Array.from({ length: 100 }, (_, index) => ({ id: index, path: 'a.ts', line: index + 1, body: `c${index}` })),
      issueComments: [{ id: 7, user: { login: 'bob' }, body: 'Hm' }],
    })
    fake.checks('acme/widget', sha, { checkRuns: [{ name: 'ci', status: 'completed', conclusion: 'success' }], statuses: [{ context: 'lint', state: 'pending' }] })
    assert.deepEqual(await app.pullReviews('acme', 'widget', 1, token), { items: [review], full: false })
    assert.equal(fake.requests.at(-1)!.path, '/repos/acme/widget/pulls/1/reviews?per_page=100')
    // 100 on one page: GitHub sends no Link, so there is nothing older.
    const comments = await app.pullReviewComments('acme', 'widget', 1, token)
    assert.equal(comments.items.length, 100)
    assert.equal(comments.full, false)
    assert.equal(fake.requests.at(-1)!.path, '/repos/acme/widget/pulls/1/comments?per_page=100')
    assert.deepEqual(await app.issueComments('acme', 'widget', 1, token), { items: [{ id: 7, user: { login: 'bob' }, body: 'Hm' }], full: false })
    assert.equal(fake.requests.at(-1)!.path, '/repos/acme/widget/issues/1/comments?per_page=100')
    assert.deepEqual(await app.checkRuns('acme', 'widget', sha, token), { items: [{ name: 'ci', status: 'completed', conclusion: 'success' }], full: false })
    assert.equal(fake.requests.at(-1)!.path, `/repos/acme/widget/commits/${sha}/check-runs?per_page=100`)
    assert.deepEqual(await app.combinedStatus('acme', 'widget', sha, token), { items: [{ context: 'lint', state: 'pending' }], full: false })
    assert.equal(fake.requests.at(-1)!.path, `/repos/acme/widget/commits/${sha}/status?per_page=100`)
    assert.ok(fake.requests.slice(-6).every(request => request.auth === 'token'))

    // A token without checks or statuses read: 403, as GitHub answers.
    const narrow = (await app.createToken(77, ['widget'], { metadata: 'read', pull_requests: 'read' })).token
    await rejectsWith(app.checkRuns('acme', 'widget', sha, narrow), 'auth')
    await rejectsWith(app.combinedStatus('acme', 'widget', sha, narrow), 'auth')
    // Malformed answers.
    fake.failNext('/repos/acme/widget/pulls/1/reviews', 200, { not: 'a list' })
    await rejectsWith(app.pullReviews('acme', 'widget', 1, token), 'other')
    fake.failNext(`/repos/acme/widget/commits/${sha}/check-runs`, 200, [])
    await rejectsWith(app.checkRuns('acme', 'widget', sha, token), 'other')
    fake.failNext('/repos/acme/widget/pulls/1', 200, { number: 1 })
    await rejectsWith(app.pullDetails('acme', 'widget', 1, token), 'other')
    await assert.rejects(app.checkRuns('acme', 'widget', '../x', token))
  })

  it('pullReviews, pullReviewComments and issueComments read the newest 100: the last page GitHub\'s Link names, and the one before it when the last is short; full says older ones weren\'t read', async () => {
    const { fake, app } = await writeSetup()
    const write = (await app.createWriteToken(77, 'widget', PULL_PERMISSIONS)).token
    await app.createPull('acme', 'widget', { title: 'Fix', head: 'dish/fix-1', base: 'main', body: '' }, write)
    const token = (await app.createToken(77, ['widget'], { metadata: 'read', pull_requests: 'read', checks: 'read', statuses: 'read' })).token
    const numbered = (count: number) => Array.from({ length: count }, (_, id) => ({ id, user: { login: 'ann' }, state: 'COMMENTED', path: 'a.ts', body: `c${id}` }))
    const ids = (from: number, to: number): number[] => Array.from({ length: to - from }, (_, index) => from + index)
    fake.feedback('acme/widget', 1, { issueComments: numbered(130), reviews: numbered(250), reviewComments: numbered(200) })
    const paths = async (read: () => Promise<{ items: unknown[], full: boolean }>): Promise<{ ids: number[], full: boolean, paths: string[] }> => {
      const seen = fake.requests.length
      const list = await read()
      const asked = fake.requests.slice(seen)
      assert.ok(asked.every(request => request.auth === 'token' && request.status === 200), JSON.stringify(asked))
      return { ids: list.items.map(item => (item as { id: number }).id), full: list.full, paths: asked.map(request => request.path) }
    }

    // 130: page 1, then page 2 (the last, 30): the newest 100, oldest first.
    assert.deepEqual(await paths(() => app.issueComments('acme', 'widget', 1, token)), {
      ids: ids(30, 130), full: true, paths: ['/repos/acme/widget/issues/1/comments?per_page=100', '/repos/acme/widget/issues/1/comments?per_page=100&page=2'],
    })
    // 250: page 1, page 3 (the last, 50), then page 2.
    assert.deepEqual(await paths(() => app.pullReviews('acme', 'widget', 1, token)), {
      ids: ids(150, 250), full: true,
      paths: ['/repos/acme/widget/pulls/1/reviews?per_page=100', '/repos/acme/widget/pulls/1/reviews?per_page=100&page=3', '/repos/acme/widget/pulls/1/reviews?per_page=100&page=2'],
    })
    // 200: page 1, then page 2, full: nothing before it is needed.
    assert.deepEqual(await paths(() => app.pullReviewComments('acme', 'widget', 1, token)), {
      ids: ids(100, 200), full: true, paths: ['/repos/acme/widget/pulls/1/comments?per_page=100', '/repos/acme/widget/pulls/1/comments?per_page=100&page=2'],
    })

    // A Link with no last page, or one whose page isn't a page number: the first page, and full. The Link's URL is never asked.
    const first = numbered(100)
    fake.failNext('/repos/acme/widget/issues/1/comments', 200, first, { link: `<${LINK_ORIGIN}/x?page=2>; rel="next"` })
    assert.deepEqual(await paths(() => app.issueComments('acme', 'widget', 1, token)), { ids: ids(0, 100), full: true, paths: ['/repos/acme/widget/issues/1/comments?per_page=100'] })
    for (const link of [`<${LINK_ORIGIN}/x?page=0>; rel="last"`, `<${LINK_ORIGIN}/x?page=two>; rel="last"`, '<not a url>; rel="last"']) {
      fake.failNext('/repos/acme/widget/issues/1/comments', 200, first, { link })
      assert.deepEqual(await paths(() => app.issueComments('acme', 'widget', 1, token)), { ids: ids(0, 100), full: true, paths: ['/repos/acme/widget/issues/1/comments?per_page=100'] }, link)
    }
    // A last page that is the first: one page, all read.
    fake.failNext('/repos/acme/widget/issues/1/comments', 200, first, { link: `<${LINK_ORIGIN}/x?per_page=100&page=1>; rel="last"` })
    assert.deepEqual(await paths(() => app.issueComments('acme', 'widget', 1, token)), { ids: ids(0, 100), full: false, paths: ['/repos/acme/widget/issues/1/comments?per_page=100'] })
    // A last page that fails fails the read.
    fake.failNext('/repos/acme/widget/issues/1/comments?per_page=100&page=2', 502)
    await rejectsWith(app.issueComments('acme', 'widget', 1, token), 'other')
  })
})
