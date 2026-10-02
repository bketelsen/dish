import assert from 'node:assert/strict'
import { createPrivateKey, generateKeyPairSync, verify } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, it } from 'node:test'
import {
  appJwt, botIdentity, GITHUB_API, GITHUB_WEB, GitHubApp, GitHubError,
} from '../src/github.ts'
import type { AppCredentials, GitHubErrorKind } from '../src/github.ts'
import { startFakeGitHub, testKeys } from './fake-github-api.ts'

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

async function setup(options: { appId?: number } = {}) {
  const fake = await startFakeGitHub({ publicKey: keys.publicKey, appId: options.appId })
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
