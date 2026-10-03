import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { access, appendFile, chmod, copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { helperValue, tokensDir, writeFileAtomic } from '../src/paths.ts'
import { checkClone } from '../src/safety.ts'
import { TOKEN_USER, startFakeGit } from './fake-git-http.ts'
import type { FakeGitServer } from './fake-git-http.ts'
import { dishHome, makeBare, run, runOk, scratchGitEnv, tempDir, withEnv } from './helpers.ts'
import type { RunResult } from './helpers.ts'

const HELPER = fileURLToPath(new URL('../bin/git-credential-dish', import.meta.url))
const GITHUB = 'https://github.com'
const QUIT = 'quit=true\n'
/** How long a credential request that can't be answered may take: it must fail, not wait on a prompt. */
const FAST_MS = 5_000

/** Shaped like an installation token (`ghs_` and 36 more); a fresh one each time, never a real one. */
function newToken(): string {
  return `ghs_${randomBytes(18).toString('hex')}`
}

/** What the helper prints for a token. */
function answer(token: string): string {
  return `username=x-access-token\npassword=${token}\nquit=true\n`
}

/** A credential request as git writes it: `key=value` lines, then a blank line (or none: `end` ''). */
function request(fields: ReadonlyArray<readonly [string, string]>, end = '\n'): string {
  return fields.map(([key, value]) => `${key}=${value}\n`).join('') + end
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

interface Fixture {
  dir: string
  /** For every git and shell the test starts (see `fixture`). */
  env: Record<string, string>
  home: string
  /** The tokens directory, as `tokensDir` names it under `<dir>/state`: made 0700, empty. */
  tokens: string
  /** Left by the tripwire askpass if anything tried to prompt. */
  asked: string
}

/**
 * A scratch directory and the environment for what the test starts there: `scratchGitEnv` (a scratch HOME with a test
 * identity, no system config), no proxy (the fake listens on 127.0.0.1), and no askpass but a tripwire: anything that
 * tries to prompt runs `<dir>/askpass`, which leaves `<dir>/asked` and fails. A test ends by checking it never ran.
 */
async function fixture(): Promise<Fixture> {
  const dir = await tempDir()
  const env = await scratchGitEnv(dir)
  for (const name of Object.keys(env)) {
    if (/^(?:SSH_ASKPASS|SUDO_ASKPASS|(?:https?|all|no)_proxy)$/i.test(name)) delete env[name]
  }
  const asked = join(dir, 'asked')
  const askpass = join(dir, 'askpass')
  await writeFile(askpass, `#!/bin/sh\necho "$1" >> '${asked}'\nexit 1\n`, { mode: 0o755 })
  env.GIT_ASKPASS = askpass
  const tokens = tokensDir(join(dir, 'state'))
  await mkdir(tokens, { recursive: true, mode: 0o700 })
  return { dir, env, home: env.HOME!, tokens, asked }
}

/** A token file as dish-workspaces writes it: `<tokens>/<owner, lower-case>`, 0600, the token and a newline. */
async function writeToken(fx: Fixture, owner: string, token: string): Promise<void> {
  await writeFileAtomic(join(fx.tokens, owner.toLowerCase()), `${token}\n`)
}

async function assertNoPrompt(fx: Fixture): Promise<void> {
  assert.equal(await exists(fx.asked), false, `something prompted: ${await readFile(fx.asked, 'utf8').catch(() => '')}`)
}

/** The files under `dir` whose bytes hold `needle`. */
async function filesHolding(dir: string, needle: string): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const file = join(entry.parentPath, entry.name)
    if ((await readFile(file)).includes(needle)) found.push(file)
  }
  return found
}

/** Every path under `dir` with its size, mode and modification time: equal listings mean nothing was written. */
async function listing(dir: string): Promise<string[]> {
  const lines: string[] = []
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name)
    const info = await stat(path)
    lines.push(`${path} ${info.size} ${info.mode.toString(8)} ${info.mtimeMs}`)
  }
  return lines.sort()
}

interface Shell { name: string, cmd: string, args: readonly string[] }

/** `/bin/sh`, and other POSIX shells this machine has: the helper is run by whatever `/bin/sh` is where dish runs. */
async function shells(env: Record<string, string>): Promise<Shell[]> {
  const found: Shell[] = [{ name: '/bin/sh', cmd: '/bin/sh', args: [] }]
  for (const [name, cmd, args] of [['bash --posix', 'bash', ['--posix']], ['busybox sh', 'busybox', ['sh']], ['dash', 'dash', []]] as const) {
    if ((await run('/bin/sh', ['-c', `command -v ${cmd}`], { env })).code === 0) found.push({ name, cmd, args })
  }
  return found
}

/** Run the helper as git does (`/bin/sh <helper> <tokens> <web> <action>`), from an empty directory. */
async function ask(fx: Fixture, input: string, options: { action?: string[], web?: string, shell?: Shell } = {}): Promise<RunResult> {
  const shell = options.shell ?? { name: '/bin/sh', cmd: '/bin/sh', args: [] }
  const cwd = join(fx.dir, 'cwd')
  await mkdir(cwd, { recursive: true })
  return run(shell.cmd, [...shell.args, HELPER, fx.tokens, options.web ?? GITHUB, ...(options.action ?? ['get'])], { cwd, env: fx.env, input })
}

/**
 * Run a command in a new session (no controlling terminal: a prompt has nowhere to go) and its own process group,
 * killed whole after `timeoutMs`. Returns how long it took.
 */
function runDetached(cmd: string, args: readonly string[], options: { cwd: string, env: Record<string, string>, input?: string, timeoutMs?: number }): Promise<RunResult & { ms: number, killed: boolean }> {
  assert.ok(options.env.HOME, 'a scratch HOME')
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, [...args], { cwd: options.cwd, env: options.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let killed = false
    const timer = setTimeout(() => {
      killed = true
      try { process.kill(-child.pid!, 'SIGKILL') } catch { /* gone */ }
    }, options.timeoutMs ?? 15_000)
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    child.stdin.on('error', () => {})
    child.stdin.end(options.input ?? '')
    child.on('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr, ms: Date.now() - started, killed })
    })
  })
}

/** `env` without `GIT_TERMINAL_PROMPT`: what an agent's shell has (dish can't set it there). */
function withoutPromptGuard(env: Record<string, string>): Record<string, string> {
  const { GIT_TERMINAL_PROMPT: _dropped, ...rest } = env
  return rest
}

/**
 * The credential keys and the rest of what the contract says dish writes in a clone's config: `credential.<web>.helper`
 * `''` then the helper's value, `useHttpPath`, `credential.interactive=false`, the identity, origin's URL, and the
 * `.worktrees/` exclude line.
 */
async function configureLikeDish(clone: string, env: Record<string, string>, web: string, value: string, url: string): Promise<void> {
  const config = (...args: string[]): Promise<string> => runOk('git', ['config', ...args], { cwd: clone, env })
  await config('--add', `credential.${web}.helper`, '')
  await config('--add', `credential.${web}.helper`, value)
  await config(`credential.${web}.useHttpPath`, 'true')
  await config('credential.interactive', 'false')
  await config('user.name', 'dish-test[bot]')
  await config('user.email', '1+dish-test[bot]@users.noreply.github.com')
  await config('remote.origin.url', url)
  await mkdir(join(clone, '.git', 'info'), { recursive: true })
  await appendFile(join(clone, '.git', 'info', 'exclude'), '.worktrees/\n')
}

/** The clone check (Task 3a) accepts what `configureLikeDish` wrote. */
async function assertCheckPasses(fx: Fixture, clone: string, url: string, value: string, web: string): Promise<void> {
  const result = await withEnv(await dishHome(fx.dir), () => checkClone(clone, { url, helper: value, web }))
  assert.deepEqual(result, { ok: true })
}

// --- The protocol: the script run directly -------------------------------------------------------------------------

test('get for the web origin answers with the token file of the URL\'s owner, lower-cased, in every POSIX shell here', async () => {
  const fx = await fixture()
  const token = newToken()
  await writeToken(fx, 'Acme', token)
  for (const shell of await shells(fx.env)) {
    for (const path of ['acme/widget.git', 'Acme/widget.git', 'ACME/Widget.git', 'acme', 'acme/']) {
      const result = await ask(fx, request([['protocol', 'https'], ['host', 'github.com'], ['path', path]]), { shell })
      assert.deepEqual(result, { code: 0, stdout: answer(token), stderr: '' }, `${shell.name}: ${path}`)
    }
    // What git 2.47 sends besides, a credential of its own (never echoed), and no blank line before EOF.
    const busy = request([
      ['capability[]', 'authtype'], ['capability[]', 'state'], ['protocol', 'https'], ['host', 'github.com'],
      ['path', 'acme/widget.git'], ['username', 'input-user'], ['password', 'input-secret'], ['wwwauth[]', 'Basic realm="GitHub"'],
    ], '')
    const result = await ask(fx, busy, { shell })
    assert.deepEqual(result, { code: 0, stdout: answer(token), stderr: '' }, `${shell.name}: busy request`)
    assert.ok(!result.stdout.includes('input-'), 'the input is never in the output')
  }
  await assertNoPrompt(fx)
})

test('only the first line of the token file is the password', async () => {
  const fx = await fixture()
  const token = newToken()
  await writeFileAtomic(join(fx.tokens, 'acme'), `${token}\nsecond line\n`)
  const result = await ask(fx, request([['protocol', 'https'], ['host', 'github.com'], ['path', 'acme/widget.git']]))
  assert.deepEqual(result, { code: 0, stdout: answer(token), stderr: '' })
  // A file without its newline is read whole.
  await writeFileAtomic(join(fx.tokens, 'acme'), token)
  const bare = await ask(fx, request([['protocol', 'https'], ['host', 'github.com'], ['path', 'acme/widget.git']]))
  assert.deepEqual(bare, { code: 0, stdout: answer(token), stderr: '' })
})

test('an owner without a readable, non-empty token file gets quit=true and nothing else', async () => {
  const fx = await fixture()
  await writeToken(fx, 'acme', newToken())
  await writeFileAtomic(join(fx.tokens, 'empty'), '')
  await writeFileAtomic(join(fx.tokens, 'blank'), '\n')
  await mkdir(join(fx.tokens, 'adir'))
  await writeFileAtomic(join(fx.tokens, 'locked'), `${newToken()}\n`, 0o000)
  const owners = ['other', 'empty', 'blank', 'adir']
  if (process.getuid?.() !== 0) owners.push('locked')     // root reads a 0000 file
  for (const owner of owners) {
    const result = await ask(fx, request([['protocol', 'https'], ['host', 'github.com'], ['path', `${owner}/widget.git`]]))
    assert.deepEqual(result, { code: 0, stdout: QUIT, stderr: '' }, owner)
  }
})

test('a path whose owner is not a GitHub login gets quit=true, and nothing outside the tokens directory is read', async () => {
  const fx = await fixture()
  await writeToken(fx, 'acme', newToken())
  // Beside the tokens directory, where `..` would lead.
  await writeFile(join(fx.tokens, '..', 'secret'), `${newToken()}\n`)
  // Files whose names aren't logins, in the tokens directory itself: they are there, and still not read.
  for (const name of ['a b', 'acme.x', 'acme_x', 'ac%2fme', 'acmé', 'acme\\x', '*', '$HOME', '.hidden']) {
    await writeFile(join(fx.tokens, name), `${newToken()}\n`, { mode: 0o600 })
  }
  const paths = [
    '../secret', '..', '../acme', './acme', '.', 'a b/x.git', 'acme.x/y', 'acme_x/y', 'ac%2fme/x', '/acme/widget.git', '',
    'acmé/x', 'acme\\x/y', '*/x', '$HOME/x', '.hidden/x', '.hidden',
  ]
  for (const path of paths) {
    const result = await ask(fx, request([['protocol', 'https'], ['host', 'github.com'], ['path', path]]))
    assert.deepEqual(result, { code: 0, stdout: QUIT, stderr: '' }, JSON.stringify(path))
  }
  // No path at all (a clone without useHttpPath).
  const none = await ask(fx, request([['protocol', 'https'], ['host', 'github.com']]))
  assert.deepEqual(none, { code: 0, stdout: QUIT, stderr: '' })
})

test('another origin gets no answer at all', async () => {
  const fx = await fixture()
  await writeToken(fx, 'acme', newToken())
  const origins: Array<Array<readonly [string, string]>> = [
    [['protocol', 'https'], ['host', 'gitlab.com']],
    [['protocol', 'http'], ['host', 'github.com']],
    [['protocol', 'https'], ['host', 'github.com:443']],
    [['protocol', 'https'], ['host', 'github.com.example.invalid']],
    [['protocol', 'https'], ['host', 'api.github.com']],
    [['protocol', 'https'], ['host', 'GitHub.com']],
    [['protocol', 'ssh'], ['host', 'github.com']],
    [['host', 'github.com']],
    [['protocol', 'https']],
    [],
  ]
  for (const origin of origins) {
    const result = await ask(fx, request([...origin, ['path', 'acme/widget.git']]))
    assert.deepEqual(result, { code: 0, stdout: '', stderr: '' }, JSON.stringify(origin))
  }
  // Configured for the fake's origin, it doesn't answer for github.com, and does for the fake (the port is part of host).
  const fake = 'http://127.0.0.1:8080'
  const github = await ask(fx, request([['protocol', 'https'], ['host', 'github.com'], ['path', 'acme/widget.git']]), { web: fake })
  assert.deepEqual(github, { code: 0, stdout: '', stderr: '' })
  const other = await ask(fx, request([['protocol', 'http'], ['host', '127.0.0.1:8081'], ['path', 'acme/widget.git']]), { web: fake })
  assert.deepEqual(other, { code: 0, stdout: '', stderr: '' })
  const right = await ask(fx, request([['protocol', 'http'], ['host', '127.0.0.1:8080'], ['path', 'acme/widget.git']]), { web: fake })
  assert.equal(right.stdout.split('\n')[0], 'username=x-access-token')
})

test('store, erase and anything but get print nothing and exit 0, and the helper writes nothing', async () => {
  const fx = await fixture()
  const token = newToken()
  await writeToken(fx, 'acme', token)
  await mkdir(join(fx.dir, 'cwd'), { recursive: true })
  const before = await listing(fx.dir)
  const full = request([['protocol', 'https'], ['host', 'github.com'], ['path', 'acme/widget.git'], ['username', TOKEN_USER], ['password', token]])
  for (const action of [['store'], ['erase'], [''], ['GET'], ['get2'], ['capability'], []]) {
    const result = await ask(fx, full, { action })
    assert.deepEqual(result, { code: 0, stdout: '', stderr: '' }, JSON.stringify(action))
  }
  // Missing arguments: nothing either.
  for (const args of [[], [fx.tokens], [fx.tokens, GITHUB]]) {
    const result = await run('/bin/sh', [HELPER, ...args], { cwd: join(fx.dir, 'cwd'), env: fx.env, input: full })
    assert.deepEqual(result, { code: 0, stdout: '', stderr: '' }, JSON.stringify(args))
  }
  // An answered get changes nothing on disk either (its cwd, the tokens directory, the home).
  await ask(fx, request([['protocol', 'https'], ['host', 'github.com'], ['path', 'acme/widget.git']]))
  assert.deepEqual(await listing(fx.dir), before)
})

test('the helper is POSIX sh, runs by path through /bin/sh without an exec bit, and passes shellcheck', async (t) => {
  const text = await readFile(HELPER, 'utf8')
  assert.equal(text.split('\n')[0], '#!/bin/sh')
  assert.match(text, /^set -u$/m)

  const fx = await fixture()
  const token = newToken()
  await writeToken(fx, 'acme', token)
  const copy = join(fx.dir, 'git-credential-dish')
  await copyFile(HELPER, copy)
  await chmod(copy, 0o644)
  const value = helperValue(copy, fx.tokens, GITHUB)
  const result = await run('git', ['-c', `credential.${GITHUB}.helper=`, '-c', `credential.${GITHUB}.helper=${value}`, '-c', `credential.${GITHUB}.useHttpPath=true`, 'credential', 'fill'], {
    cwd: fx.dir, env: fx.env, input: request([['url', `${GITHUB}/acme/widget.git`]]),
  })
  assert.equal(result.code, 0, result.stderr)
  assert.ok(result.stdout.includes(`password=${token}\n`))

  if ((await run('/bin/sh', ['-c', 'command -v shellcheck'], { env: fx.env })).code !== 0) {
    t.skip('shellcheck is not on PATH')
    return
  }
  const checked = await run('shellcheck', [HELPER], { env: fx.env })
  assert.deepEqual(checked, { code: 0, stdout: '', stderr: '' })
})

// --- git's view: a clone configured as dish configures it ----------------------------------------------------------

test('in a clone configured as dish does it, git credential fill gets the token, and the global store helper keeps nothing', async () => {
  const fx = await fixture()
  const token = newToken()
  await writeToken(fx, 'acme', token)
  const clone = join(fx.dir, 'clone')
  const url = `${GITHUB}/acme/widget.git`
  const value = helperValue(HELPER, fx.tokens, GITHUB)
  await runOk('git', ['init', '-q', clone], { env: fx.env })
  await configureLikeDish(clone, fx.env, GITHUB, value, url)
  await assertCheckPasses(fx, clone, url, value, GITHUB)
  // The global config keeps every credential it is told about in ~/.git-credentials.
  await runOk('git', ['config', '--global', '--add', 'credential.helper', 'store'], { env: fx.env })
  const stored = join(fx.home, '.git-credentials')
  const xdgStored = join(fx.env.XDG_CONFIG_HOME!, 'git', 'credentials')

  const fill = (input: string): Promise<RunResult> => run('git', ['credential', 'fill'], { cwd: clone, env: fx.env, input })
  const approve = (cwd: string, password: string): Promise<string> =>
    runOk('git', ['credential', 'approve'], { cwd, env: fx.env, input: request([['url', url], ['username', TOKEN_USER], ['password', password]]) })

  for (const input of [request([['url', url]]), request([['url', `${GITHUB}/Acme/Widget.git`]])]) {
    const filled = await fill(input)
    assert.equal(filled.code, 0, filled.stderr)
    assert.ok(filled.stdout.includes(`username=x-access-token\npassword=${token}\n`), 'the token, from the helper')
  }
  // git tells its helpers a credential worked: the store helper is dropped for this origin, and dish's keeps nothing.
  await approve(clone, token)
  assert.equal(await exists(stored), false, '~/.git-credentials written')
  assert.equal(await exists(xdgStored), false, '$XDG_CONFIG_HOME/git/credentials written')

  // The fixture: outside the clone, the store helper does keep what it's told.
  await approve(fx.dir, 'not-a-token')
  assert.ok((await readFile(stored, 'utf8')).includes('not-a-token'), 'the global store helper works outside the clone')
  // Inside, it isn't asked either: the fill gets the helper's token, not the stored one, and an approve adds nothing.
  const again = await fill(request([['url', url]]))
  assert.ok(again.stdout.includes(`password=${token}\n`))
  assert.ok(!again.stdout.includes('not-a-token'))
  await approve(clone, token)

  assert.deepEqual(await filesHolding(fx.home, token), [])
  assert.deepEqual(await filesHolding(clone, token), [])
  await assertNoPrompt(fx)
})

test('a fill the helper can\'t answer fails at once without prompting, with no terminal and GIT_TERMINAL_PROMPT unset', async () => {
  const fx = await fixture()
  await writeToken(fx, 'acme', newToken())
  const clone = join(fx.dir, 'clone')
  const url = `${GITHUB}/acme/widget.git`
  await runOk('git', ['init', '-q', clone], { env: fx.env })
  await configureLikeDish(clone, fx.env, GITHUB, helperValue(HELPER, fx.tokens, GITHUB), url)
  const env = withoutPromptGuard(fx.env)
  const fill = (target: string, flags: string[] = []): ReturnType<typeof runDetached> =>
    runDetached('git', [...flags, 'credential', 'fill'], { cwd: clone, env, input: request([['url', target]]) })

  // An owner without a token: the helper says quit=true, and git stops there.
  const missing = await fill(`${GITHUB}/nobody/widget.git`)
  assert.notEqual(missing.code, 0)
  assert.equal(missing.killed, false)
  assert.ok(missing.ms < FAST_MS, `took ${missing.ms} ms`)
  assert.match(missing.stderr, /quit/)
  assert.ok(!missing.stdout.includes('password='))
  // An origin the helper isn't configured for: credential.interactive=false keeps git from asking anyone.
  const elsewhere = await fill('https://example.invalid/acme/widget.git')
  assert.notEqual(elsewhere.code, 0)
  assert.equal(elsewhere.killed, false)
  assert.ok(elsewhere.ms < FAST_MS, `took ${elsewhere.ms} ms`)
  assert.ok(!elsewhere.stdout.includes('password='))
  await assertNoPrompt(fx)

  // The fixture: without credential.interactive=false, git does try to prompt (the tripwire askpass runs).
  const control = await fill('https://example.invalid/acme/widget.git', ['-c', 'credential.interactive=true'])
  assert.notEqual(control.code, 0)
  assert.equal(await exists(fx.asked), true, 'git prompted without credential.interactive=false')
})

// --- End to end: the fake smart-HTTP server ------------------------------------------------------------------------

/** The `-c` flags a clone is made with, before its config exists: the helper for `origin`, and nothing else's. */
function cloneFlags(origin: string, value: string): string[] {
  return ['-c', `credential.${origin}.helper=`, '-c', `credential.${origin}.helper=${value}`, '-c', `credential.${origin}.useHttpPath=true`]
}

/** A new commit on `bare`'s `main`, made by a scratch clone over `file://`. Returns its sha. */
async function commitUpstream(fx: Fixture, bare: string, name: string): Promise<string> {
  const work = join(fx.dir, `upstream-${name}`)
  await runOk('git', ['clone', '-q', `file://${bare}`, work], { env: fx.env })
  await writeFile(join(work, `${name}.txt`), `${name}\n`)
  await runOk('git', ['add', '-A'], { cwd: work, env: fx.env })
  await runOk('git', ['commit', '-q', '-m', name], { cwd: work, env: fx.env })
  await runOk('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: work, env: fx.env })
  return (await runOk('git', ['rev-parse', 'HEAD'], { cwd: work, env: fx.env })).trim()
}

async function withServer<T>(root: string, body: (server: FakeGitServer) => Promise<T>): Promise<T> {
  const server = await startFakeGit(root)
  try {
    return await body(server)
  } finally {
    await server.close()
  }
}

test('against a fake GitHub, a read token clones and fetches through the helper, a push gets 403, and the token lands nowhere', async () => {
  const fx = await fixture()
  const root = join(fx.dir, 'srv')
  const bare = await makeBare(join(root, 'acme', 'widget.git'), { 'README.md': '# widget\n' })
  await runOk('git', ['config', '--global', '--add', 'credential.helper', 'store'], { env: fx.env })
  await withServer(root, async server => {
    const token = newToken()
    server.tokens.set(token, 'read')
    await writeToken(fx, 'acme', token)
    const value = helperValue(HELPER, fx.tokens, server.origin)
    const url = `${server.origin}/acme/widget.git`
    const clone = join(fx.dir, 'clone')

    const cloned = await run('git', [...cloneFlags(server.origin, value), 'clone', '-q', url, clone], { cwd: fx.dir, env: fx.env })
    assert.equal(cloned.code, 0, cloned.stderr)
    assert.equal(await readFile(join(clone, 'README.md'), 'utf8'), '# widget\n')
    // git asked without a credential first, then with the helper's.
    assert.equal(server.requests[0]?.status, 401)
    const authenticated = server.requests.filter(request => request.level !== null)
    assert.ok(authenticated.some(request => request.service === 'git-upload-pack' && request.status === 200))
    assert.ok(authenticated.every(request => request.user === TOKEN_USER && request.level === 'read'))
    // The new config names no helper and holds no credential: the -c flags were for the clone command only.
    const config = await readFile(join(clone, '.git', 'config'), 'utf8')
    assert.doesNotMatch(config, /helper|credential|x-access-token/i)
    assert.equal((await runOk('git', ['config', '--get', 'remote.origin.url'], { cwd: clone, env: fx.env })).trim(), url)

    // Configured as dish configures it, the clone fetches through its own config.
    await configureLikeDish(clone, fx.env, server.origin, value, url)
    await assertCheckPasses(fx, clone, url, value, server.origin)
    const upstream = await commitUpstream(fx, bare, 'second')
    const fetched = await run('git', ['fetch', '-q', 'origin'], { cwd: clone, env: fx.env })
    assert.equal(fetched.code, 0, fetched.stderr)
    assert.equal((await runOk('git', ['rev-parse', 'origin/main'], { cwd: clone, env: fx.env })).trim(), upstream)

    // A push is refused: the token can only read.
    await runOk('git', ['commit', '-q', '--allow-empty', '-m', 'an agent\'s commit'], { cwd: clone, env: fx.env })
    const before = server.requests.length
    const pushed = await run('git', ['push', 'origin', 'HEAD:refs/heads/agent'], { cwd: clone, env: fx.env })
    assert.notEqual(pushed.code, 0)
    assert.match(pushed.stderr, /403/)
    assert.ok(server.requests.slice(before).some(request =>
      request.service === 'git-receive-pack' && request.level === 'read' && request.status === 403))
    const branch = await run('git', ['--git-dir', bare, 'rev-parse', '--verify', '-q', 'refs/heads/agent'], { env: fx.env })
    assert.notEqual(branch.code, 0, 'the push reached the repository')

    // The token is in its file and nowhere else: not in the clone, the home (no ~/.git-credentials), the server's repos.
    assert.equal(await exists(join(fx.home, '.git-credentials')), false, '~/.git-credentials written')
    for (const dir of [clone, fx.home, root]) assert.deepEqual(await filesHolding(dir, token), [], dir)
    assert.ok(!JSON.stringify(server.requests).includes(token))
    for (const output of [cloned, fetched, pushed]) assert.ok(!`${output.stdout}${output.stderr}`.includes(token))
    await assertNoPrompt(fx)
  })
})

test('against a fake GitHub, a clone with no token file fails at once without prompting, and leaves no directory', async () => {
  const fx = await fixture()
  const root = join(fx.dir, 'srv')
  await makeBare(join(root, 'acme', 'widget.git'))
  await withServer(root, async server => {
    server.tokens.set(newToken(), 'read')
    const value = helperValue(HELPER, fx.tokens, server.origin)
    const clone = join(fx.dir, 'clone')
    const result = await runDetached('git', [...cloneFlags(server.origin, value), 'clone', '-q', `${server.origin}/acme/widget.git`, clone], {
      cwd: fx.dir, env: withoutPromptGuard(fx.env),
    })
    assert.notEqual(result.code, 0)
    assert.equal(result.killed, false)
    assert.ok(result.ms < FAST_MS, `took ${result.ms} ms`)
    assert.match(result.stderr, /quit/)
    assert.equal(await exists(clone), false)
    assert.ok(server.requests.length > 0 && server.requests.every(request => request.status === 401 && request.level === null))
    await assertNoPrompt(fx)
  })
})

test('the fake asks for x-access-token and a known token, refuses a read token\'s push with 403, and lets a write token push', async () => {
  const fx = await fixture()
  const root = join(fx.dir, 'srv')
  const bare = await makeBare(join(root, 'acme', 'widget.git'))
  await withServer(root, async server => {
    const read = newToken()
    const write = newToken()
    server.tokens.set(read, 'read')
    server.tokens.set(write, 'write')
    const basic = (user: string, password: string): Record<string, string> =>
      ({ Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}` })
    const refs = (service: string): string => `${server.origin}/acme/widget.git/info/refs?service=${service}`

    for (const headers of [{}, basic(TOKEN_USER, newToken()), basic('someone', read), { Authorization: `Bearer ${read}` }]) {
      const response = await fetch(refs('git-upload-pack'), { headers })
      assert.equal(response.status, 401)
      assert.match(response.headers.get('www-authenticate') ?? '', /^Basic/)
      await response.arrayBuffer()
    }
    const refused = await fetch(refs('git-receive-pack'), { headers: basic(TOKEN_USER, read) })
    assert.equal(refused.status, 403)
    assert.match(await refused.text(), /Write access to repository not granted/)
    const advertised = await fetch(refs('git-upload-pack'), { headers: basic(TOKEN_USER, read) })
    assert.equal(advertised.status, 200)
    assert.equal(advertised.headers.get('content-type'), 'application/x-git-upload-pack-advertisement')
    await advertised.arrayBuffer()
    assert.deepEqual(server.requests.map(({ service, user, level, status }) => ({ service, user, level, status })), [
      { service: 'git-upload-pack', user: null, level: null, status: 401 },
      { service: 'git-upload-pack', user: TOKEN_USER, level: null, status: 401 },
      { service: 'git-upload-pack', user: 'someone', level: null, status: 401 },
      { service: 'git-upload-pack', user: null, level: null, status: 401 },
      { service: 'git-receive-pack', user: TOKEN_USER, level: 'read', status: 403 },
      { service: 'git-upload-pack', user: TOKEN_USER, level: 'read', status: 200 },
    ])

    // The fixture for the 403 above: with a write token in the file, the same push goes through.
    await writeToken(fx, 'acme', write)
    const value = helperValue(HELPER, fx.tokens, server.origin)
    const url = `${server.origin}/acme/widget.git`
    const clone = join(fx.dir, 'clone')
    await runOk('git', [...cloneFlags(server.origin, value), 'clone', '-q', url, clone], { cwd: fx.dir, env: fx.env })
    await configureLikeDish(clone, fx.env, server.origin, value, url)
    await runOk('git', ['commit', '-q', '--allow-empty', '-m', 'pushed'], { cwd: clone, env: fx.env })
    const pushed = await run('git', ['push', '-q', 'origin', 'HEAD:refs/heads/pushed'], { cwd: clone, env: fx.env })
    assert.equal(pushed.code, 0, pushed.stderr)
    const head = (await runOk('git', ['rev-parse', 'HEAD'], { cwd: clone, env: fx.env })).trim()
    assert.equal((await runOk('git', ['--git-dir', bare, 'rev-parse', 'refs/heads/pushed'], { env: fx.env })).trim(), head)
    assert.ok(!JSON.stringify(server.requests).includes(read) && !JSON.stringify(server.requests).includes(write))
    await assertNoPrompt(fx)
  })
})
