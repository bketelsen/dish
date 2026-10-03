import assert from 'node:assert/strict'
import { chmod, lstat, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { format } from 'node:util'
import { GitHubApp, PULL_PERMISSIONS, PUSH_PERMISSIONS } from '../src/github.ts'
import { tokensDir } from '../src/paths.ts'
import { API_BASE_PERMISSIONS, API_PERMISSIONS, FILE_PERMISSIONS, REFRESH_BEFORE_MS, TokenManager } from '../src/tokens.ts'
import type { OwnerRepos } from '../src/tokens.ts'
import { WRITE_APP_PERMISSIONS, startFakeGitHub, testKeys } from './fake-github-api.ts'
import type { FakeGitHub } from './fake-github-api.ts'
import { tempDir } from './helpers.ts'

const keys = testKeys()

interface FakeTimer { fn: () => void, ms: number, cleared: boolean, fired: boolean }

/** A manager on a fake clock and fake timers, against a fresh fake GitHub with `acme` installed (id 77). */
async function setup(repos: string[] = ['widget', 'gadget'], options: { write?: boolean } = {}) {
  const fake = await startFakeGitHub({ publicKey: keys.publicKey, ...(options.write === true ? { permissions: WRITE_APP_PERMISSIONS } : {}) })
  fake.installations.set('acme', { id: 77, account: 'Acme', repos: new Set(repos) })
  const app = new GitHubApp(async () => ({ appId: String(fake.app.id), privateKey: keys.privateKeyPem }), { api: fake.api })
  const dir = await tempDir()
  const state = join(dir, 'state')
  const directory = tokensDir(state)
  const lines: string[] = []
  const logger = {
    warn: (fmt: string, ...args: unknown[]) => { lines.push(`warn ${format(fmt, ...args)}`) },
    info: (fmt: string, ...args: unknown[]) => { lines.push(`info ${format(fmt, ...args)}`) },
  }
  const clock = { now: Date.now() }
  const timers: FakeTimer[] = []
  const manager = new TokenManager({
    directory,
    app,
    logger,
    now: () => clock.now,
    timers: {
      set: (fn, ms) => { const timer = { fn, ms, cleared: false, fired: false }; timers.push(timer); return timer },
      clear: (handle) => { (handle as FakeTimer).cleared = true },
    },
  })
  const pending = () => timers.filter(timer => !timer.cleared && !timer.fired)
  /** Fire a timer as the clock reaches it. */
  const fire = (timer: FakeTimer) => {
    clock.now += timer.ms
    timer.fired = true
    timer.fn()
  }
  return { fake, app, dir, state, directory, lines, clock, timers, pending, fire, manager }
}

function owners(entries: Record<string, OwnerRepos>): Map<string, OwnerRepos> {
  return new Map(Object.entries(entries))
}

/** Every file under `dir`, with its text. */
async function filesUnder(dir: string): Promise<Array<{ path: string, text: string }>> {
  const out: Array<{ path: string, text: string }> = []
  for (const name of await readdir(dir, { recursive: true })) {
    const path = join(dir, name)
    if ((await lstat(path)).isFile()) out.push({ path, text: await readFile(path, 'utf8') })
  }
  return out
}

/** No `ghs_` anywhere but the token files, and no logged line with one. */
async function assertNoTokenLeaks(fake: FakeGitHub, dir: string, directory: string, lines: string[]): Promise<void> {
  for (const line of lines) assert.ok(!line.includes('ghs_'), `a logged line holds a token: ${line}`)
  for (const { token } of fake.minted) for (const line of lines) assert.ok(!line.includes(token))
  for (const { path, text } of await filesUnder(dir)) {
    if (path.startsWith(`${directory}/`) && !path.slice(directory.length + 1).includes('/')) continue
    assert.ok(!text.includes('ghs_'), `${path} holds a token`)
  }
}

describe('TokenManager', () => {
  it('mints the file token with the file permissions, writes it 0600 in a 0700 directory, and sets the refresh timer', async () => {
    const { fake, dir, directory, lines, clock, pending, manager } = await setup()
    // A directory that is there already, too open: it is made 0700 all the same.
    await mkdir(directory, { recursive: true })
    await chmod(directory, 0o755)
    await manager.setRepositories(owners({ acme: { installation: 77, repos: ['widget', 'gadget'] } }))
    assert.equal(fake.minted.length, 1)
    assert.deepEqual(fake.minted[0]!.permissions, { ...FILE_PERMISSIONS })
    assert.deepEqual(fake.minted[0]!.permissions, { contents: 'read', metadata: 'read' })
    assert.deepEqual([...fake.minted[0]!.repositories].sort(), ['gadget', 'widget'])
    const file = join(directory, 'acme')
    assert.equal(await readFile(file, 'utf8'), `${fake.minted[0]!.token}\n`)
    assert.equal((await stat(file)).mode & 0o777, 0o600)
    assert.equal((await stat(directory)).mode & 0o777, 0o700)
    assert.deepEqual(await readdir(directory), ['acme'])
    // One timer, 10 minutes before the hour runs out.
    assert.equal(pending().length, 1)
    const ms = pending()[0]!.ms
    // The fake's expiry is a real hour from the mint, to the second; the manager's clock is the test's.
    const expected = 3_600_000 - REFRESH_BEFORE_MS - (clock.now - Date.now())
    assert.ok(Math.abs(ms - expected) < 5_000, `refresh in ${ms} ms, expected about ${expected}`)
    await manager.close()
    await assertNoTokenLeaks(fake, dir, directory, lines)
  })

  it('ensureFileToken before the refresh window mints nothing; inside it, mints again', async () => {
    const { fake, directory, clock, manager } = await setup()
    await manager.setRepositories(owners({ acme: { installation: 77, repos: ['widget'] } }))
    assert.deepEqual(await manager.ensureFileToken('acme'), { dropped: [] })
    assert.deepEqual(await manager.ensureFileToken('Acme'), { dropped: [] })
    assert.equal(fake.minted.length, 1)
    clock.now += 3_600_000 - REFRESH_BEFORE_MS + 1_000
    await manager.ensureFileToken('acme')
    assert.equal(fake.minted.length, 2)
    assert.equal(await readFile(join(directory, 'acme'), 'utf8'), `${fake.minted[1]!.token}\n`)
    await manager.close()
  })

  it('a token file removed behind its back is minted again', async () => {
    const { fake, directory, manager } = await setup()
    await manager.setRepositories(owners({ acme: { installation: 77, repos: ['widget'] } }))
    await rm(join(directory, 'acme'))
    await manager.ensureFileToken('acme')
    assert.equal(fake.minted.length, 2)
    assert.equal(await readFile(join(directory, 'acme'), 'utf8'), `${fake.minted[1]!.token}\n`)
    await manager.close()
  })

  it('concurrent ensureFileToken calls mint once', async () => {
    const { fake, directory, manager } = await setup()
    await manager.setRepositories(owners({ acme: { installation: 77, repos: ['widget'] } }))
    await rm(join(directory, 'acme'))
    await Promise.all([manager.ensureFileToken('acme'), manager.ensureFileToken('acme'), manager.ensureFileToken('acme')])
    assert.equal(fake.minted.length, 2)
    await manager.close()
  })

  it('the timer fires 10 minutes before expiry and rewrites the file', async () => {
    const { fake, dir, directory, lines, pending, fire, manager } = await setup()
    await manager.setRepositories(owners({ acme: { installation: 77, repos: ['widget'] } }))
    const [timer] = pending()
    fire(timer!)
    await waitFor(() => fake.minted.length === 2)
    await waitFor(async () => (await readFile(join(directory, 'acme'), 'utf8')) === `${fake.minted[1]!.token}\n`)
    assert.notEqual(fake.minted[0]!.token, fake.minted[1]!.token)
    // The next refresh is scheduled from the new token.
    await waitFor(() => pending().length === 1 && pending()[0] !== timer)
    await manager.close()
    await assertNoTokenLeaks(fake, dir, directory, lines)
  })

  it('a failed refresh is logged once per distinct error, retried after a minute, and leaves the old file', async () => {
    const { fake, dir, directory, lines, pending, fire, manager } = await setup()
    await manager.setRepositories(owners({ acme: { installation: 77, repos: ['widget'] } }))
    const old = await readFile(join(directory, 'acme'), 'utf8')
    const path = '/app/installations/77/access_tokens'
    fake.failNext(path, 500, { message: `server trouble near ghs_${'L'.repeat(36)}` })
    fake.failNext(path, 500, { message: `server trouble near ghs_${'L'.repeat(36)}` })
    fake.failNext(path, 502, { message: 'bad gateway' })

    let timer = pending()[0]!
    fire(timer)
    await waitFor(() => pending().length === 1 && pending()[0] !== timer)
    timer = pending()[0]!
    assert.equal(timer.ms, 60_000)
    assert.equal(lines.filter(line => line.startsWith('warn')).length, 1)
    assert.match(lines.at(-1)!, /acme/)
    assert.match(lines.at(-1)!, /HTTP 500/)

    // The same error again: not logged again.
    fire(timer)
    await waitFor(() => pending().length === 1 && pending()[0] !== timer)
    timer = pending()[0]!
    assert.equal(lines.filter(line => line.startsWith('warn')).length, 1)

    // Another error: logged.
    fire(timer)
    await waitFor(() => pending().length === 1 && pending()[0] !== timer)
    timer = pending()[0]!
    assert.equal(lines.filter(line => line.startsWith('warn')).length, 2)
    assert.match(lines.at(-1)!, /HTTP 502/)
    assert.equal(await readFile(join(directory, 'acme'), 'utf8'), old)

    // Then it works again.
    fire(timer)
    await waitFor(() => fake.minted.length === 2)
    await waitFor(async () => (await readFile(join(directory, 'acme'), 'utf8')) === `${fake.minted[1]!.token}\n`)
    await manager.close()
    await assertNoTokenLeaks(fake, dir, directory, lines)
  })

  it('setRepositories: a changed set mints anew; an owner no longer listed loses its file and its timer', async () => {
    const { fake, directory, pending, manager } = await setup()
    fake.installations.set('beta', { id: 88, account: 'beta', repos: 'all' })
    await manager.setRepositories(owners({ acme: { installation: 77, repos: ['widget'] }, beta: { installation: 88, repos: ['one'] } }))
    assert.equal(fake.minted.length, 2)
    assert.deepEqual((await readdir(directory)).sort(), ['acme', 'beta'])
    assert.equal(pending().length, 2)

    // The same sets again (in another order): nothing minted.
    await manager.setRepositories(owners({ beta: { installation: 88, repos: ['one'] }, acme: { installation: 77, repos: ['widget'] } }))
    assert.equal(fake.minted.length, 2)

    // acme gains a repo: a new token for both; beta goes: its file and timer go.
    await manager.setRepositories(owners({ acme: { installation: 77, repos: ['widget', 'gadget'] } }))
    assert.equal(fake.minted.length, 3)
    assert.deepEqual([...fake.minted[2]!.repositories].sort(), ['gadget', 'widget'])
    assert.equal(fake.minted[2]!.installation, 77)
    assert.equal(await readFile(join(directory, 'acme'), 'utf8'), `${fake.minted[2]!.token}\n`)
    assert.deepEqual(await readdir(directory), ['acme'])
    assert.equal(pending().length, 1)
    await assert.rejects(manager.ensureFileToken('beta'), /beta/)
    await manager.close()
  })

  it('setRepositories keys owners without case', async () => {
    const { fake, directory, manager } = await setup()
    await manager.setRepositories(owners({ Acme: { installation: 77, repos: ['widget'] } }))
    assert.deepEqual(await readdir(directory), ['acme'])
    await manager.setRepositories(owners({ acme: { installation: 77, repos: ['widget'] } }))
    assert.equal(fake.minted.length, 1)
    await manager.close()
  })

  it('a setRepositories that cannot mint logs it and tries again in a minute, without throwing', async () => {
    const { fake, lines, pending, manager } = await setup()
    fake.failNext('/app/installations/77/access_tokens', 500, { message: 'down' })
    await manager.setRepositories(owners({ acme: { installation: 77, repos: ['widget'] } }))
    assert.equal(lines.filter(line => line.startsWith('warn')).length, 1)
    assert.equal(pending().length, 1)
    assert.equal(pending()[0]!.ms, 60_000)
    await manager.close()
  })

  it('a repo the installation no longer has (a 422) is dropped and reported', async () => {
    const { fake, dir, directory, lines, clock, manager } = await setup()
    await manager.setRepositories(owners({ acme: { installation: 77, repos: ['widget', 'gadget'] } }))
    assert.equal(fake.minted.length, 1)
    // The owner takes gadget away from the App.
    fake.installations.set('acme', { id: 77, account: 'Acme', repos: new Set(['widget']) })
    clock.now += 3_600_000
    assert.deepEqual(await manager.ensureFileToken('acme'), { dropped: ['gadget'] })
    assert.equal(fake.minted.length, 2)
    assert.deepEqual(fake.minted[1]!.repositories, ['widget'])
    assert.equal(await readFile(join(directory, 'acme'), 'utf8'), `${fake.minted[1]!.token}\n`)
    assert.ok(lines.some(line => line.startsWith('warn') && line.includes('acme/gadget')), lines.join('\n'))
    assert.ok(fake.requests.some(request => request.path === '/repos/acme/gadget/installation' && request.status === 404))
    // The same set given again tries gadget again: still missing, it is dropped again, and widget's token is minted.
    const asked = fake.requests.length
    await manager.setRepositories(owners({ acme: { installation: 77, repos: ['widget', 'gadget'] } }))
    assert.equal(fake.minted.length, 3)
    assert.deepEqual(fake.minted[2]!.repositories, ['widget'])
    assert.ok(fake.requests.slice(asked).some(request => request.path === '/app/installations/77/access_tokens' && request.status === 422))
    assert.equal(await readFile(join(directory, 'acme'), 'utf8'), `${fake.minted[2]!.token}\n`)
    // Given back to the App: the next recompute's token covers it again.
    fake.installations.set('acme', { id: 77, account: 'Acme', repos: new Set(['widget', 'gadget']) })
    await manager.setRepositories(owners({ acme: { installation: 77, repos: ['widget', 'gadget'] } }))
    assert.equal(fake.minted.length, 4)
    assert.deepEqual([...fake.minted[3]!.repositories].sort(), ['gadget', 'widget'])
    // Nothing dropped now: the same set again changes nothing.
    await manager.setRepositories(owners({ acme: { installation: 77, repos: ['widget', 'gadget'] } }))
    assert.equal(fake.minted.length, 4)
    await manager.close()
    await assertNoTokenLeaks(fake, dir, directory, lines)
  })

  it('a 422 with every repo still there is the error itself', async () => {
    const { fake, directory, manager } = await setup()
    await manager.setRepositories(owners({ acme: { installation: 77, repos: ['widget'] } }))
    await rm(join(directory, 'acme'))
    fake.failNext('/app/installations/77/access_tokens', 422, { message: `something else, near ghs_${'E'.repeat(36)}` })
    await assert.rejects(manager.ensureFileToken('acme'), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /HTTP 422: something else/)
      assert.ok(!error.message.includes('ghs_'), error.message)
      for (const { token } of fake.minted) assert.ok(!String(error.stack).includes(token))
      return true
    })
    await manager.close()
  })

  it('apiToken is minted with the API permissions, kept in memory and never written', async () => {
    const { fake, dir, directory, lines, clock, manager } = await setup()
    await manager.setRepositories(owners({ acme: { installation: 77, repos: ['widget'] } }))
    const before = await readdir(directory)
    const token = await manager.apiToken('acme')
    assert.equal(fake.minted.length, 2)
    assert.deepEqual(fake.minted[1]!.permissions, { ...API_PERMISSIONS })
    assert.deepEqual(fake.minted[1]!.permissions, { metadata: 'read', pull_requests: 'read', checks: 'read', statuses: 'read' })
    assert.equal(token, fake.minted[1]!.token)
    assert.deepEqual(await readdir(directory), before)
    for (const { text } of await filesUnder(dir)) assert.ok(!text.includes(token))
    // Kept: a second call mints nothing, until the refresh window.
    assert.equal(await manager.apiToken('Acme'), token)
    assert.equal(fake.minted.length, 2)
    clock.now += 3_600_000 - REFRESH_BEFORE_MS + 1_000
    assert.notEqual(await manager.apiToken('acme'), token)
    assert.equal(fake.minted.length, 3)
    await manager.close()
    await assertNoTokenLeaks(fake, dir, directory, lines)
  })

  it("an installation that hasn't accepted checks and statuses gets API_BASE_PERMISSIONS, logged once; the sweep's pullsForCommit still works with it; the next mint near its expiry asks for the wide set again", async () => {
    const { fake, app, dir, directory, lines, clock, manager } = await setup()
    const installation = fake.installations.get('acme')!
    installation.permissions = { contents: 'read', metadata: 'read', pull_requests: 'read' }
    assert.deepEqual(API_BASE_PERMISSIONS, { metadata: 'read', pull_requests: 'read' })
    await manager.setRepositories(owners({ acme: { installation: 77, repos: ['widget'] } }))
    const mints = () => fake.requests.filter(request => request.path === '/app/installations/77/access_tokens').map(request => request.status)
    const narrowLines = () => lines.filter(line => line.includes("hasn't accepted Checks and Commit statuses read"))
    const token = await manager.apiToken('acme')
    assert.deepEqual(mints(), [201, 422, 201], 'the file token, the wide set refused, the narrow one')
    assert.deepEqual(fake.minted.at(-1)!.permissions, { ...API_BASE_PERMISSIONS })
    assert.equal(token, fake.minted.at(-1)!.token)
    assert.deepEqual(narrowLines(), [
      "warn the dish App's installation for acme hasn't accepted Checks and Commit statuses read; pr_feedback shows no checks until it does (Settings → GitHub App)",
    ])
    // The sweep's read still works with it.
    const tip = 'a'.repeat(40)
    fake.pulls.set(tip, [{ number: 3, state: 'closed', mergedAt: '2026-10-01T10:00:00Z', headSha: tip, headRef: 'dish/x' }])
    assert.deepEqual(await app.pullsForCommit('acme', 'widget', tip, token), fake.pulls.get(tip))
    // Kept like the wide one: nothing is minted until its refresh window.
    assert.equal(await manager.apiToken('acme'), token)
    assert.deepEqual(mints(), [201, 422, 201])
    // Near its expiry the wide set is asked for again; still refused, the narrow one again, not logged again.
    clock.now += 3_600_000 - REFRESH_BEFORE_MS + 1_000
    const again = await manager.apiToken('acme')
    assert.notEqual(again, token)
    assert.deepEqual(mints(), [201, 422, 201, 422, 201])
    assert.equal(narrowLines().length, 1)
    // Accepted on GitHub: the next mint gets the wide set.
    delete installation.permissions
    clock.now += 3_600_000
    await manager.apiToken('acme')
    assert.deepEqual(fake.minted.at(-1)!.permissions, { ...API_PERMISSIONS })
    assert.deepEqual(mints(), [201, 422, 201, 422, 201, 201])
    await manager.close()
    await assertNoTokenLeaks(fake, dir, directory, lines)
  })

  it('writeToken mints a new token on each call for one repo with the asked permissions, and keeps nothing: no file, no cache, no timer', async () => {
    const { fake, dir, directory, lines, pending, manager } = await setup(['widget', 'gadget'], { write: true })
    await manager.setRepositories(owners({ acme: { installation: 77, repos: ['widget', 'gadget'] } }))
    const files = await filesUnder(dir)
    const timers = pending().length
    const minted = fake.minted.length
    const one = await manager.writeToken('acme', 'widget', PUSH_PERMISSIONS)
    const two = await manager.writeToken('Acme', 'Widget', PUSH_PERMISSIONS)
    const three = await manager.writeToken('acme', 'gadget', PULL_PERMISSIONS)
    assert.equal(fake.minted.length, minted + 3)
    assert.deepEqual(fake.minted.slice(-3).map(({ token, repositories, permissions }) => ({ token, repositories, permissions })), [
      { token: one, repositories: ['widget'], permissions: { contents: 'write', metadata: 'read' } },
      { token: two, repositories: ['Widget'], permissions: { contents: 'write', metadata: 'read' } },
      { token: three, repositories: ['gadget'], permissions: { metadata: 'read', pull_requests: 'write' } },
    ])
    assert.equal(new Set([one, two, three]).size, 3)
    // Nothing kept: no file changed, no timer set, and the API token is its own.
    assert.deepEqual(await filesUnder(dir), files)
    assert.equal(pending().length, timers)
    const api = await manager.apiToken('acme')
    assert.ok(![one, two, three].includes(api))
    assert.deepEqual(fake.minted.at(-1)!.permissions, { ...API_PERMISSIONS })
    for (const token of [one, two, three]) for (const line of lines) assert.ok(!line.includes(token))
    await manager.close()
    await assertNoTokenLeaks(fake, dir, directory, lines)
  })

  it("writeToken refuses an owner it doesn't hold and a repo none of its projects has, before minting", async () => {
    const { fake, manager } = await setup(['widget', 'gadget', 'other'], { write: true })
    await manager.setRepositories(owners({ acme: { installation: 77, repos: ['widget'] } }))
    const minted = fake.minted.length
    await assert.rejects(manager.writeToken('beta', 'widget', PUSH_PERMISSIONS), /beta/)
    await assert.rejects(manager.writeToken('../x', 'widget', PUSH_PERMISSIONS), /not a GitHub owner/)
    await assert.rejects(manager.writeToken('acme', 'gadget', PUSH_PERMISSIONS), /^Error: the dish App can't reach acme\/gadget: no project of dish has it installed$/)
    await assert.rejects(manager.writeToken('acme', 'other', PULL_PERMISSIONS), /can't reach acme\/other/)
    assert.equal(fake.minted.length, minted)
    await manager.close()
    await assert.rejects(manager.writeToken('acme', 'widget', PUSH_PERMISSIONS), /closed/)
    assert.equal(fake.minted.length, minted)
  })

  it("writeToken's 422 says what the App needs, and holds no token", async () => {
    const { fake, dir, directory, lines, manager } = await setup()
    await manager.setRepositories(owners({ acme: { installation: 77, repos: ['widget'] } }))
    const push = await manager.writeToken('acme', 'widget', PUSH_PERMISSIONS).catch((error: unknown) => error)
    assert.ok(push instanceof Error)
    assert.match(push.message, /^dish couldn't get a write token for acme\/widget: POST \/app\/installations\/77\/access_tokens answered HTTP 422: The permissions requested are not granted to this installation\. The dish App needs Contents read and write, and each installation must accept it \(Settings → GitHub App\)$/)
    const pull = await manager.writeToken('acme', 'widget', PULL_PERMISSIONS).catch((error: unknown) => error)
    assert.ok(pull instanceof Error)
    assert.match(pull.message, /The dish App needs Pull requests read and write, and each installation must accept it/)
    for (const { token } of fake.minted) {
      assert.ok(!push.message.includes(token) && !pull.message.includes(token))
      assert.ok(!String(push.stack).includes(token) && !String(pull.stack).includes(token))
    }
    // Another failure goes through as it is.
    fake.failNext('/app/installations/77/access_tokens', 500, { message: 'boom' })
    await assert.rejects(manager.writeToken('acme', 'widget', PUSH_PERMISSIONS), /^GitHubError: POST \/app\/installations\/77\/access_tokens answered HTTP 500: boom$/)
    await manager.close()
    await assertNoTokenLeaks(fake, dir, directory, lines)
  })

  it('apiToken and ensureFileToken refuse an owner it holds no repos for, and a name that is not an owner', async () => {
    const { manager } = await setup()
    await assert.rejects(manager.apiToken('acme'), /acme/)
    await assert.rejects(manager.ensureFileToken('acme'), /acme/)
    await assert.rejects(manager.ensureFileToken('../x'))
    await manager.close()
  })

  it('prune removes the token files of other owners and leftover temporary files, and nothing else', async () => {
    const { directory, manager } = await setup()
    await mkdir(join(directory, 'somedir'), { recursive: true })
    await writeFile(join(directory, 'acme'), 'x\n')
    await writeFile(join(directory, 'other'), 'x\n')
    await writeFile(join(directory, '.other.0123456789ab.tmp'), 'x\n')
    await writeFile(join(directory, 'Not An Owner'), 'x\n')
    await manager.prune(['Acme'])
    assert.deepEqual((await readdir(directory)).sort(), ['Not An Owner', 'acme', 'somedir'])
    await manager.close()
  })

  it("prune removes a held owner's leftover temporary file, under its lock, and keeps its token file", async () => {
    const { fake, directory, manager } = await setup()
    await manager.setRepositories(owners({ acme: { installation: 77, repos: ['widget'] } }))
    await writeFile(join(directory, '.acme.0123456789ab.tmp'), 'x\n')
    await manager.prune(['acme'])
    assert.deepEqual(await readdir(directory), ['acme'])
    assert.equal(await readFile(join(directory, 'acme'), 'utf8'), `${fake.minted[0]!.token}\n`)
    await manager.close()
  })

  it('prune with no directory is fine', async () => {
    const { manager } = await setup()
    await manager.prune(['acme'])
    await manager.close()
  })

  it('close removes the files it wrote and clears the timers; twice is fine; a timer after it does nothing', async () => {
    const { fake, directory, timers, pending, manager } = await setup()
    fake.installations.set('beta', { id: 88, account: 'beta', repos: 'all' })
    await writeFile(join(await mkdirp(directory), 'unrelated'), 'x\n')
    await manager.setRepositories(owners({ acme: { installation: 77, repos: ['widget'] }, beta: { installation: 88, repos: ['one'] } }))
    await manager.apiToken('acme')
    const minted = fake.minted.length
    assert.equal(pending().length, 2)
    await manager.close()
    assert.equal(pending().length, 0)
    assert.deepEqual(await readdir(directory), ['unrelated'])
    await manager.close()
    for (const timer of timers) timer.fn()
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(fake.minted.length, minted)
    assert.deepEqual(await readdir(directory), ['unrelated'])
    await assert.rejects(manager.ensureFileToken('acme'))
  })

  it('a mint that lands after close writes nothing', async () => {
    const { fake, directory, manager } = await setup()
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    const slowApp = {
      createToken: async (...args: Parameters<GitHubApp['createToken']>) => {
        await gate
        return realApp.createToken(...args)
      },
      installationFor: (owner: string, repo: string) => realApp.installationFor(owner, repo),
      createWriteToken: (...args: Parameters<GitHubApp['createWriteToken']>) => realApp.createWriteToken(...args),
    }
    const realApp = new GitHubApp(async () => ({ appId: String(fake.app.id), privateKey: keys.privateKeyPem }), { api: fake.api })
    const slow = new TokenManager({ directory, app: slowApp, logger: { warn() {}, info() {} } })
    const done = slow.setRepositories(owners({ acme: { installation: 77, repos: ['widget'] } }))
    await slow.close()
    release()
    await done
    await assert.rejects(readFile(join(directory, 'acme'), 'utf8'), { code: 'ENOENT' })
    await manager.close()
  })

  it('nothing is on disk the moment close resolves, wherever a write was when it was called', async () => {
    const fake = await startFakeGitHub({ publicKey: keys.publicKey })
    fake.installations.set('acme', { id: 77, account: 'Acme', repos: new Set(['widget']) })
    const real = new GitHubApp(async () => ({ appId: String(fake.app.id), privateKey: keys.privateKeyPem }), { api: fake.api })
    const { token, expiresAt, permissions, repositories } = await real.createToken(77, ['widget'], FILE_PERMISSIONS)
    // A token at once, so close lands at every step of the write as the ticks go by.
    const app = {
      createToken: async () => ({ token, expiresAt, permissions, repositories }),
      installationFor: async () => undefined,
      createWriteToken: async () => { throw new Error('not in this test') },
    }
    const dir = await tempDir()
    for (let ticks = 0; ticks < 40; ticks++) {
      const directory = join(dir, String(ticks))
      const manager = new TokenManager({ directory, app, logger: { warn() {}, info() {} } })
      const set = manager.setRepositories(owners({ acme: { installation: 77, repos: ['widget'] } }))
      for (let tick = 0; tick < ticks; tick++) await new Promise(resolve => setImmediate(resolve))
      await manager.close()
      const left = await readdir(directory).catch(() => [])
      assert.deepEqual(left, [], `after ${ticks} ticks, close left ${left.join(', ')}`)
      await set
      assert.deepEqual(await readdir(directory).catch(() => []), [], `after ${ticks} ticks, a write landed after close`)
    }
  })

  it('its refresh timers do not keep the process alive (unref)', async () => {
    const fake = await startFakeGitHub({ publicKey: keys.publicKey })
    fake.installations.set('acme', { id: 77, account: 'Acme', repos: new Set(['widget']) })
    const app = new GitHubApp(async () => ({ appId: String(fake.app.id), privateKey: keys.privateKeyPem }), { api: fake.api })
    const dir = await tempDir()
    const manager = new TokenManager({ directory: tokensDir(join(dir, 'state')), app, logger: { warn() {}, info() {} } })
    const timeouts = () => process.getActiveResourcesInfo().filter(kind => kind === 'Timeout').length
    const before = timeouts()
    await manager.setRepositories(owners({ acme: { installation: 77, repos: ['widget'] } }))
    assert.equal(timeouts(), before)
    await manager.close()
  })

  it('with real timers, nothing keeps the process alive after close', async () => {
    const fake = await startFakeGitHub({ publicKey: keys.publicKey })
    fake.installations.set('acme', { id: 77, account: 'Acme', repos: new Set(['widget']) })
    const app = new GitHubApp(async () => ({ appId: String(fake.app.id), privateKey: keys.privateKeyPem }), { api: fake.api })
    const dir = await tempDir()
    const manager = new TokenManager({ directory: tokensDir(join(dir, 'state')), app, logger: { warn() {}, info() {} } })
    await manager.setRepositories(owners({ acme: { installation: 77, repos: ['widget'] } }))
    await manager.close()
  })
})

async function mkdirp(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true })
  return dir
}

/** Poll `check` until it holds, for up to 5 s. */
async function waitFor(check: () => boolean | Promise<boolean>): Promise<void> {
  const until = Date.now() + 5_000
  for (;;) {
    if (await check()) return
    if (Date.now() > until) assert.fail('timed out waiting')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}
