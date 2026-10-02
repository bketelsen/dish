/**
 * `pnpm dev` (`scripts/dev.ts`): its arguments, the install environment, the git identity, the sign-in link, and what
 * `main` does. Nothing here boots dsh or touches a real `.dev`, dsh home or XDG directory. Every `main` run uses a temp
 * `root` that holds stand-ins for the three programs `pnpm dev` starts: `deploy/install.sh`, `node_modules/.bin/dsh`
 * and `node_modules/.bin/pnpm` (the watchers). The stand-ins log what they are given and which signals reach them.
 */

import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { UsageError } from '../env.ts'
import { DEFAULT_PORT, gitIdentity, installEnvironment, main, parseDevArgs, signInLink } from '../dev.ts'

const DEV = fileURLToPath(new URL('../dev.ts', import.meta.url))
const REPO = fileURLToPath(new URL('../..', import.meta.url))
const BASE_PATH = process.env.PATH ?? '/usr/bin:/bin'

let dir: string
let counter = 0

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dish-dev-test-'))
})
after(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false)
}

/** Runs `fn` with `process.stderr` captured (the refusals print nothing else), and returns what it got. */
async function capturedStderr<T>(fn: () => Promise<T>): Promise<{ result: T, stderr: string }> {
  const err: string[] = []
  const write = process.stderr.write
  process.stderr.write = ((chunk: string | Uint8Array) => {
    err.push(String(chunk))
    return true
  }) as typeof process.stderr.write
  try {
    const result = await fn()
    return { result, stderr: err.join('') }
  } finally {
    process.stderr.write = write
  }
}

// ---- parseDevArgs -----------------------------------------------------------------------------------------------

test('parseDevArgs: the default port is 3090', () => {
  assert.equal(DEFAULT_PORT, 3090)
  assert.deepEqual(parseDevArgs([]), { port: 3090 })
})

test('parseDevArgs: --port <n> and --port=<n>, 0 to 65535', () => {
  assert.deepEqual(parseDevArgs(['--port', '3091']), { port: 3091 })
  assert.deepEqual(parseDevArgs(['--port=3092']), { port: 3092 })
  assert.deepEqual(parseDevArgs(['--port=0']), { port: 0 })
  assert.deepEqual(parseDevArgs(['--port', '0']), { port: 0 })
  assert.deepEqual(parseDevArgs(['--port', '65535']), { port: 65535 })
})

test('parseDevArgs: a bad port, a missing value, a repeat and an unknown argument throw a UsageError', () => {
  const bad: string[][] = [
    ['--port', '-1'],
    ['--port=-1'],
    ['--port', '65536'],
    ['--port', '70000'],
    ['--port', 'abc'],
    ['--port=abc'],
    ['--port', '3.5'],
    ['--port', '0x10'],
    ['--port', ''],
    ['--port='],
    ['--port'],
    ['--port', '3091', '--port', '3092'],
    ['--host', '0.0.0.0'],
    ['--bogus'],
    ['3091'],
  ]
  for (const argv of bad) {
    assert.throws(() => parseDevArgs(argv), error => {
      assert.ok(error instanceof UsageError, `${JSON.stringify(argv)}: a UsageError`)
      assert.ok(!error.message.includes('\n'), 'one line')
      return true
    }, JSON.stringify(argv))
  }
})

// ---- installEnvironment -----------------------------------------------------------------------------------------

test('installEnvironment: the remote is always empty, the profile is web, the identity passes through', () => {
  const devEnv: NodeJS.ProcessEnv = {
    PATH: BASE_PATH,
    DSH_HOME: '/r/.dev/dsh',
    DSH_DISH_HOME: '/r/.dev',
    DISH_ENV: 'dev',
    DISH_REMOTE: 'git@github-dish-config:bketelsen/dish-config.git',
    DISH_PROFILE: 'other',
    DISH_USER_NAME: 'inherited',
    DISH_USER_EMAIL: 'inherited@example.com',
    OTHER: 'kept',
  }
  const before = { ...devEnv }
  const result = installEnvironment(devEnv, { name: 'Ada Lovelace', email: 'ada@example.com' })
  assert.deepEqual(devEnv, before, 'the input is not modified')
  assert.equal(result.DISH_REMOTE, '', 'an inherited remote becomes empty')
  assert.ok('DISH_REMOTE' in result, 'set but empty, which keeps the store local')
  assert.equal(result.DISH_PROFILE, 'web')
  assert.equal(result.DISH_USER_NAME, 'Ada Lovelace')
  assert.equal(result.DISH_USER_EMAIL, 'ada@example.com')
  assert.equal(result.DSH_HOME, '/r/.dev/dsh', 'DSH_HOME is untouched')
  assert.equal(result.DSH_DISH_HOME, '/r/.dev', 'DSH_DISH_HOME is untouched')
  assert.equal(result.DISH_ENV, 'dev')
  assert.equal(result.OTHER, 'kept')
  assert.equal(result.PATH, BASE_PATH)
})

test('installEnvironment: adds exactly its four names to an environment that has none of them', () => {
  const result = installEnvironment({ PATH: BASE_PATH }, { name: 'n', email: 'e@x' })
  assert.deepEqual(Object.keys(result).sort(), ['DISH_PROFILE', 'DISH_REMOTE', 'DISH_USER_EMAIL', 'DISH_USER_NAME', 'PATH'])
})

// ---- gitIdentity ------------------------------------------------------------------------------------------------

/** An environment in which git reads no global or system configuration, so only the repository's own counts. */
function isolatedGit(): NodeJS.ProcessEnv {
  return { PATH: BASE_PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
}

async function makeRepo(): Promise<string> {
  const repo = join(dir, `repo-${++counter}`)
  await mkdir(repo)
  execFileSync('git', ['init', '--quiet', repo], { env: isolatedGit() })
  return repo
}

test('gitIdentity: the repository\'s own user.name and user.email', async () => {
  const repo = await makeRepo()
  execFileSync('git', ['config', 'user.name', 'Grace Hopper'], { cwd: repo, env: isolatedGit() })
  execFileSync('git', ['config', 'user.email', 'grace@example.com'], { cwd: repo, env: isolatedGit() })
  assert.deepEqual(await gitIdentity(repo, isolatedGit()), { name: 'Grace Hopper', email: 'grace@example.com' })
})

test('gitIdentity: the fallbacks without a configured identity, or one that is empty', async () => {
  const repo = await makeRepo()
  assert.deepEqual(await gitIdentity(repo, isolatedGit()), { name: 'dish dev', email: 'dev@dish.invalid' })
  execFileSync('git', ['config', 'user.name', ''], { cwd: repo, env: isolatedGit() })
  assert.deepEqual(await gitIdentity(repo, isolatedGit()), { name: 'dish dev', email: 'dev@dish.invalid' })
})

test('gitIdentity: each half falls back on its own', async () => {
  const repo = await makeRepo()
  execFileSync('git', ['config', 'user.name', 'Only Name'], { cwd: repo, env: isolatedGit() })
  assert.deepEqual(await gitIdentity(repo, isolatedGit()), { name: 'Only Name', email: 'dev@dish.invalid' })
})

test('gitIdentity: git missing from PATH gives the fallbacks too', async () => {
  const repo = await makeRepo()
  assert.deepEqual(await gitIdentity(repo, { PATH: join(dir, 'no-such-bin') }), { name: 'dish dev', email: 'dev@dish.invalid' })
})

// ---- signInLink -------------------------------------------------------------------------------------------------

test('signInLink: the URL of a "dsh web:" line, and nothing for any other line', () => {
  assert.equal(signInLink('dsh web: http://127.0.0.1:3090/?token=abc'), 'http://127.0.0.1:3090/?token=abc')
  assert.equal(
    signInLink('dsh web: http://127.0.0.1:3090/?token=abc (LAN: http://10.0.0.5:3090/?token=abc)'),
    'http://127.0.0.1:3090/?token=abc',
    'the first URL only',
  )
  assert.equal(signInLink('dsh web: opening the default browser; pass --no-open to disable'), undefined)
  assert.equal(signInLink('dish-config: store ready at http://127.0.0.1:3090/'), undefined)
  assert.equal(signInLink('web-app: dsh web: http://127.0.0.1:3090/?token=abc'), undefined)
  assert.equal(signInLink(''), undefined)
})

// ---- main: refusals ---------------------------------------------------------------------------------------------

test('main: DISH_ENV=prod and a bad DISH_ENV return 2, say so on one stderr line, and make no .dev', async () => {
  const cases: Array<[string, string]> = [
    ['prod', 'dev: pnpm dev runs dev only; prod is the dish-web service\n'],
    ['bogus', 'dev: DISH_ENV must be dev or prod (unset means dev), not "bogus"\n'],
  ]
  for (const [value, message] of cases) {
    const root = join(dir, `refuse-${++counter}`)
    await mkdir(root)
    const { result, stderr } = await capturedStderr(() => main([], { root, env: { PATH: BASE_PATH, DISH_ENV: value } }))
    assert.equal(result, 2, value)
    assert.equal(stderr, message, value)
    assert.equal(await exists(join(root, '.dev')), false, `${value}: no .dev`)
  }
})

test('main: a bad --port returns 2 and makes no .dev', async () => {
  for (const argv of [['--port', 'abc'], ['--port', '70000'], ['--port'], ['--nope']]) {
    const root = join(dir, `badport-${++counter}`)
    await mkdir(root)
    const { result, stderr } = await capturedStderr(() => main(argv, { root, env: { PATH: BASE_PATH } }))
    assert.equal(result, 2, JSON.stringify(argv))
    assert.match(stderr, /^dev: [^\n]+\n$/, 'one line')
    assert.equal(await exists(join(root, '.dev')), false)
  }
})

// ---- main: with stand-ins for install.sh, dsh and the watchers ---------------------------------------------------

/**
 * What a stand-in does. By default it runs until it is signalled: SIGTERM ends it with `termCode` (0) at once, and SIGINT
 * with 130 after `interruptMs` (dsh takes a moment to shut down). Every start and every signal is appended to
 * `<role>.log`.
 */
interface Stub {
  /** Exit by itself after this many milliseconds, with `code`. */
  exitAfterMs?: number
  code?: number
  /** Lines to print to stdout on start (the sign-in line, for dsh). */
  print?: string[]
  /** Milliseconds from a first SIGINT to the exit. */
  interruptMs?: number
  /** The exit code after a SIGTERM or SIGHUP. */
  termCode?: number
  /** Start a child of its own that outlives this stand-in's exit, as pnpm's build scripts outlive pnpm's death. */
  grandchild?: boolean
}

const STUB_SOURCE = `
const fs = require('node:fs')
const role = process.env.STUB_ROLE
const stub = JSON.parse(process.env.STUB_CONFIG || '{}')[role] || {}
const log = line => fs.appendFileSync(process.env.STUB_LOG + '/' + role + '.log', line + '\\n')
fs.writeFileSync(process.env.STUB_LOG + '/' + role + '.pid', String(process.pid))
log('start ' + JSON.stringify({
  argv: process.argv.slice(2), cwd: process.cwd(),
  DSH_HOME: process.env.DSH_HOME, DSH_DISH_HOME: process.env.DSH_DISH_HOME, DISH_ENV: process.env.DISH_ENV,
}))
for (const line of stub.print || []) console.log(line)
if (stub.grandchild) {
  const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  fs.writeFileSync(process.env.STUB_LOG + '/' + role + '.child.pid', String(child.pid))
}
let ending = false
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    log(signal)
    if (ending) return
    ending = true
    if (signal === 'SIGINT') setTimeout(() => process.exit(130), stub.interruptMs ?? 300)
    else process.exit(stub.termCode ?? 0)
  })
}
if (stub.exitAfterMs !== undefined) setTimeout(() => process.exit(stub.code ?? 0), stub.exitAfterMs)
setInterval(() => {}, 1000)
`

/** Logs the variables install.sh is told about, as `NAME=[value]`, or `NAME=` when unset, and exits `STUB_INSTALL_EXIT`. */
const INSTALL_SOURCE = `
const fs = require('node:fs')
const names = ['DISH_REMOTE', 'DISH_USER_NAME', 'DISH_USER_EMAIL', 'DISH_PROFILE', 'DSH_HOME', 'DSH_DISH_HOME', 'DISH_ENV']
const seen = names.map(name => name + '=' + (process.env[name] === undefined ? '' : '[' + process.env[name] + ']'))
fs.appendFileSync(process.env.STUB_LOG + '/install.log', seen.join(' ') + ' cwd=' + process.cwd() + '\\n')
if (process.env.STUB_INSTALL_HOLD) {
  // Runs until signalled, like a long install; a SIGINT ends it with 130 after a moment, as install.sh's trap does.
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      fs.appendFileSync(process.env.STUB_LOG + '/install.log', signal + '\\n')
      setTimeout(() => process.exit(signal === 'SIGINT' ? 130 : 143), 200)
    })
  }
  setInterval(() => {}, 1000)
} else {
  process.exit(Number(process.env.STUB_INSTALL_EXIT || 0))
}
`

interface Fixture {
  root: string
  logs: string
  env: NodeJS.ProcessEnv
}

/** A temp root with stand-ins for deploy/install.sh, node_modules/.bin/dsh and node_modules/.bin/pnpm. */
async function makeFixture(stubs: { dsh?: Stub, pnpm?: Stub } = {}, extraEnv: NodeJS.ProcessEnv = {}): Promise<Fixture> {
  const root = join(dir, `root-${++counter}`)
  const logs = join(root, 'logs')
  const bin = join(root, 'node_modules', '.bin')
  await mkdir(join(root, 'deploy'), { recursive: true })
  await mkdir(bin, { recursive: true })
  await mkdir(logs)
  const node = JSON.stringify(process.execPath)
  await writeFile(join(root, 'install.stub.js'), INSTALL_SOURCE)
  await writeFile(join(root, 'deploy', 'install.sh'), `#!/bin/sh\nSTUB_ROLE=install exec ${node} ${JSON.stringify(join(root, 'install.stub.js'))} "$@"\n`)
  await chmod(join(root, 'deploy', 'install.sh'), 0o755)
  await writeFile(join(root, 'stub.js'), STUB_SOURCE)
  for (const role of ['dsh', 'pnpm']) {
    await writeFile(join(bin, role), `#!/bin/sh\nSTUB_ROLE=${role} exec ${node} ${JSON.stringify(join(root, 'stub.js'))} "$@"\n`)
    await chmod(join(bin, role), 0o755)
  }
  return {
    root,
    logs,
    env: {
      PATH: BASE_PATH,
      STUB_LOG: logs,
      STUB_CONFIG: JSON.stringify({ dsh: stubs.dsh ?? {}, pnpm: stubs.pnpm ?? {} }),
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      ...extraEnv,
    },
  }
}

async function readLog(fixture: Fixture, role: string): Promise<string[]> {
  return (await readFile(join(fixture.logs, `${role}.log`), 'utf8').catch(() => '')).split('\n').filter(line => line !== '')
}

interface Launched {
  child: ReturnType<typeof spawn>
  stdout: () => string
  stderr: () => string
  closed: Promise<{ code: number | null, signal: NodeJS.Signals | null }>
}

/**
 * Runs `main` against the fixture the way the CLI tail runs it against the real checkout, in a subprocess of its own
 * process group (so the test can signal the group the way a terminal does), and returns once both stand-ins are up.
 */
async function launch(fixture: Fixture, argv: string[] = []): Promise<Launched> {
  const wrapper = join(fixture.root, 'wrapper.ts')
  await writeFile(wrapper, [
    `import { main } from ${JSON.stringify(DEV)}`,
    `process.exitCode = await main(process.argv.slice(2), { root: ${JSON.stringify(fixture.root)} })`,
    '',
  ].join('\n'))
  const child = spawn(process.execPath, [wrapper, ...argv], { env: fixture.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  let stdout = ''
  let stderr = ''
  child.stdout!.on('data', chunk => { stdout += String(chunk) })
  child.stderr!.on('data', chunk => { stderr += String(chunk) })
  const closed = new Promise<{ code: number | null, signal: NodeJS.Signals | null }>(resolve => {
    child.on('close', (code, signal) => resolve({ code, signal }))
  })
  return { child, stdout: () => stdout, stderr: () => stderr, closed }
}

/** Waits until both stand-ins have started. */
async function bothUp(fixture: Fixture, run: Launched): Promise<void> {
  const deadline = Date.now() + 15000
  for (;;) {
    if ((await readLog(fixture, 'dsh')).length > 0 && (await readLog(fixture, 'pnpm')).length > 0) return
    assert.ok(Date.now() < deadline, `the stand-ins started (stderr: ${run.stderr()})`)
    assert.equal(run.child.exitCode, null, `pnpm dev is still running (stderr: ${run.stderr()})`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

function killGroup(run: Launched, signal: NodeJS.Signals): void {
  try {
    process.kill(-run.child.pid!, signal)
  } catch {
    // The group is already gone, which is the normal case after a clean run.
  }
}

test('main: installs, then starts the watchers and dsh with the dev environment, and prints the sign-in link once', async () => {
  const fixture = await makeFixture({
    dsh: {
      print: ['booting', 'dsh web: http://127.0.0.1:3999/?token=abc', 'dsh web: opening the default browser; pass --no-open to disable'],
      exitAfterMs: 400,
    },
  })
  fixture.env.DISH_REMOTE = 'git@github-dish-config:bketelsen/dish-config.git'
  fixture.env.DSH_HOME = '/elsewhere'
  const run = await launch(fixture, ['--port', '3999'])
  try {
    const { code } = await run.closed
    assert.equal(code, 0, run.stderr())

    const [install] = await readLog(fixture, 'install')
    assert.ok(install!.includes('DISH_REMOTE=[] '), `an inherited remote is emptied: ${install}`)
    assert.ok(install!.includes('DISH_PROFILE=[web]'), install)
    assert.ok(/DISH_USER_NAME=\[[^\]]+\]/.test(install!) && /DISH_USER_EMAIL=\[[^\]]+@[^\]]+\]/.test(install!), install)
    assert.ok(install!.includes(`DSH_HOME=[${join(fixture.root, '.dev', 'dsh')}]`), `DSH_HOME is the dev one: ${install}`)
    assert.ok(install!.includes(`DSH_DISH_HOME=[${join(fixture.root, '.dev')}]`), install)
    assert.ok(install!.includes('DISH_ENV=[dev]'), install)

    const [dshStart] = await readLog(fixture, 'dsh')
    const dsh = JSON.parse(dshStart!.slice('start '.length)) as { argv: string[], cwd: string, DSH_HOME: string, DSH_DISH_HOME: string, DISH_ENV: string }
    assert.deepEqual(dsh.argv, ['web', '--host', '127.0.0.1', '--port', '3999', '--no-open'])
    assert.equal(dsh.cwd, fixture.root, 'dsh runs in the checkout')
    assert.equal(dsh.DSH_HOME, join(fixture.root, '.dev', 'dsh'))
    assert.equal(dsh.DSH_DISH_HOME, join(fixture.root, '.dev'))
    assert.equal(dsh.DISH_ENV, 'dev')

    const [pnpmStart] = await readLog(fixture, 'pnpm')
    const watchers = JSON.parse(pnpmStart!.slice('start '.length)) as { argv: string[], cwd: string, DSH_DISH_HOME: string }
    assert.deepEqual(watchers.argv, ['--filter', './plugins/*', '--parallel', '--if-present', 'run', 'dev'])
    assert.equal(watchers.cwd, fixture.root)
    assert.equal(watchers.DSH_DISH_HOME, join(fixture.root, '.dev'))

    const lines = run.stdout().split('\n')
    const own = lines.indexOf('dsh web: http://127.0.0.1:3999/?token=abc')
    const open = lines.indexOf('dev: open http://127.0.0.1:3999/?token=abc')
    assert.ok(lines.includes('booting'), 'dsh\'s own lines are passed through')
    assert.ok(own >= 0, 'including the sign-in line')
    assert.ok(open > own, 'the dev: open line follows it')
    assert.equal(lines.filter(line => line.startsWith('dev: open ')).length, 1, 'once')
    for (const name of ['dsh', 'config', 'state', 'data', 'cache']) {
      assert.equal((await stat(join(fixture.root, '.dev', name))).mode & 0o777, 0o700, name)
    }
  } finally {
    killGroup(run, 'SIGKILL')
  }
})

test('main: a failing install.sh returns 1, says so, and starts neither dsh nor the watchers', async () => {
  const fixture = await makeFixture({}, { STUB_INSTALL_EXIT: '9' })
  const run = await launch(fixture)
  try {
    const { code } = await run.closed
    assert.equal(code, 1)
    assert.equal(run.stderr(), 'dev: install.sh failed (exit 9)\n')
    assert.deepEqual(await readLog(fixture, 'dsh'), [])
    assert.deepEqual(await readLog(fixture, 'pnpm'), [])
  } finally {
    killGroup(run, 'SIGKILL')
  }
})

test('main: when dsh exits, the watchers are stopped once, and the exit code is dsh\'s', async () => {
  const fixture = await makeFixture({ dsh: { exitAfterMs: 300, code: 3 } })
  const run = await launch(fixture)
  try {
    const { code } = await run.closed
    assert.equal(code, 3, run.stderr())
    assert.deepEqual((await readLog(fixture, 'pnpm')).slice(1), ['SIGTERM'], 'the watchers got one SIGTERM')
  } finally {
    killGroup(run, 'SIGKILL')
  }
})

test('main: when the watchers exit, dsh is stopped once, and the exit code is the watchers\'', async () => {
  const fixture = await makeFixture({ pnpm: { exitAfterMs: 300, code: 4 } })
  const run = await launch(fixture)
  try {
    const { code } = await run.closed
    assert.equal(code, 4, run.stderr())
    assert.deepEqual((await readLog(fixture, 'dsh')).slice(1), ['SIGTERM'], 'dsh got one SIGTERM, and no second signal')
  } finally {
    killGroup(run, 'SIGKILL')
  }
})

test('main: the first non-zero code wins, not the one of the child that was stopped afterwards', async () => {
  const fixture = await makeFixture({ dsh: { exitAfterMs: 300, code: 3 }, pnpm: { termCode: 143 } })
  const run = await launch(fixture)
  try {
    const { code } = await run.closed
    assert.equal(code, 3, run.stderr())
    assert.deepEqual((await readLog(fixture, 'pnpm')).slice(1), ['SIGTERM'])
  } finally {
    killGroup(run, 'SIGKILL')
  }
})

test('main: a child that cannot be started gives 127 for it, and the other is stopped', async () => {
  const fixture = await makeFixture()
  await rm(join(fixture.root, 'node_modules', '.bin', 'dsh'))
  const run = await launch(fixture)
  try {
    const { code } = await run.closed
    assert.equal(code, 127)
    assert.match(run.stderr(), /^dev: cannot start dsh: /m)
    assert.deepEqual((await readLog(fixture, 'pnpm')).slice(1), ['SIGTERM'], 'the watchers were stopped')
  } finally {
    killGroup(run, 'SIGKILL')
  }
})

test('SIGINT is left to the terminal: dsh gets one and nothing sends a second; the watchers get a SIGTERM once dsh has gone', async () => {
  // A terminal's Ctrl-C signals the whole foreground process group. dsh is in pnpm dev's group, so the test signals the
  // group the way a terminal does. A forwarded copy would be a second SIGINT, and a second signal of either kind during
  // dsh's shutdown makes dsh force-exit with its work half done. The watchers are in a group of their own, which a
  // terminal doesn't signal; they are stopped (SIGTERM, not a forwarded SIGINT) when dsh has gone. The wrapper's
  // exit code is the SIGINT's: 130.
  const fixture = await makeFixture({ dsh: { interruptMs: 800 } })
  const run = await launch(fixture)
  try {
    await bothUp(fixture, run)
    killGroup(run, 'SIGINT')
    const { code, signal } = await run.closed
    assert.equal(signal, null, 'pnpm dev did not die of the SIGINT')
    assert.equal(code, 130, 'it waited for the children and returned 128 + SIGINT')
    assert.deepEqual((await readLog(fixture, 'dsh')).slice(1), ['SIGINT'], 'dsh: one SIGINT, and nothing after it')
    assert.deepEqual((await readLog(fixture, 'pnpm')).slice(1), ['SIGTERM'], 'the watchers: a SIGTERM, not a forwarded SIGINT')
  } finally {
    killGroup(run, 'SIGKILL')
  }
})

test('the watchers leaving first, while dsh is still shutting down from a Ctrl-C, does not get dsh a SIGTERM', async () => {
  // The watchers' stand-in is signalled directly here, so that it leaves 700 ms before dsh does. pnpm dev must not
  // answer that with a SIGTERM to dsh, which the terminal's SIGINT has already reached.
  const fixture = await makeFixture({ dsh: { interruptMs: 800 }, pnpm: { interruptMs: 100 } })
  const run = await launch(fixture)
  try {
    await bothUp(fixture, run)
    const [, pid] = /^(\d+)$/.exec(await readFile(join(fixture.logs, 'pnpm.pid'), 'utf8')) ?? []
    process.kill(Number(pid), 'SIGINT')
    killGroup(run, 'SIGINT')
    const { code } = await run.closed
    assert.equal(code, 130)
    assert.deepEqual((await readLog(fixture, 'dsh')).slice(1), ['SIGINT'], 'dsh: one SIGINT, and no SIGTERM after the watchers left')
    assert.deepEqual((await readLog(fixture, 'pnpm')).slice(1), ['SIGINT'], 'the watchers: the one SIGINT')
  } finally {
    killGroup(run, 'SIGKILL')
  }
})

test('SIGINT while install.sh runs: pnpm dev waits for it, and starts neither dsh nor the watchers', async () => {
  // The stand-in install runs until signalled. The group gets a SIGINT, as a terminal sends it; install.sh answers with
  // 130, and pnpm dev, which did not die of it, reports the failed install.
  const fixture = await makeFixture({}, { STUB_INSTALL_HOLD: '1' })
  const run = await launch(fixture)
  try {
    for (const deadline = Date.now() + 15000; (await readLog(fixture, 'install')).length === 0;) {
      assert.ok(Date.now() < deadline, `install started (stderr: ${run.stderr()})`)
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    killGroup(run, 'SIGINT')
    const { code, signal } = await run.closed
    assert.equal(signal, null, 'pnpm dev did not die of the SIGINT')
    assert.equal(code, 1)
    assert.equal(run.stderr(), 'dev: install.sh failed (exit 130)\n')
    assert.deepEqual((await readLog(fixture, 'install')).slice(1), ['SIGINT'], 'install.sh got one SIGINT')
    assert.deepEqual(await readLog(fixture, 'dsh'), [])
    assert.deepEqual(await readLog(fixture, 'pnpm'), [])
  } finally {
    killGroup(run, 'SIGKILL')
  }
})

/** Whether a process exists (signal 0). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('SIGTERM and SIGHUP sent to pnpm dev alone go on to dsh and the watchers, and nothing the watchers started is left', async () => {
  // The watchers' stand-in exits at once on either signal and leaves its own child behind, as pnpm does with its build
  // scripts (a SIGHUP kills pnpm and orphans them; a SIGTERM leaves pnpm running with them). pnpm dev signals the
  // watchers' whole process group, so the child must go too.
  for (const [signal, expected] of [['SIGTERM', 143], ['SIGHUP', 129]] as const) {
    const fixture = await makeFixture({ pnpm: { grandchild: true } })
    const run = await launch(fixture)
    let grandchild = 0
    try {
      await bothUp(fixture, run)
      for (const deadline = Date.now() + 5000; grandchild === 0 && Date.now() < deadline;) {
        grandchild = Number(await readFile(join(fixture.logs, 'pnpm.child.pid'), 'utf8').catch(() => '0'))
        if (grandchild === 0) await new Promise(resolve => setTimeout(resolve, 25))
      }
      assert.ok(grandchild > 0 && alive(grandchild), `${signal}: the watchers' child is running`)
      run.child.kill(signal)
      const { code, signal: died } = await run.closed
      assert.equal(died, null, signal)
      assert.equal(code, expected, `${signal}: 128 + the signal (${run.stderr()})`)
      assert.deepEqual((await readLog(fixture, 'dsh')).slice(1), [signal], `${signal}: dsh`)
      assert.deepEqual((await readLog(fixture, 'pnpm')).slice(1), [signal], `${signal}: the watchers`)
      for (const deadline = Date.now() + 5000; alive(grandchild) && Date.now() < deadline;) {
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      assert.equal(alive(grandchild), false, `${signal}: the watchers' child is gone`)
    } finally {
      killGroup(run, 'SIGKILL')
      if (grandchild > 0 && alive(grandchild)) process.kill(grandchild, 'SIGKILL')
    }
  }
})

test('when the watchers die by themselves, what they started goes too', async () => {
  const fixture = await makeFixture({ pnpm: { grandchild: true, exitAfterMs: 400, code: 4 } })
  const run = await launch(fixture)
  let grandchild = 0
  try {
    const { code } = await run.closed
    assert.equal(code, 4, run.stderr())
    grandchild = Number(await readFile(join(fixture.logs, 'pnpm.child.pid'), 'utf8'))
    assert.ok(grandchild > 0)
    for (const deadline = Date.now() + 5000; alive(grandchild) && Date.now() < deadline;) {
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    assert.equal(alive(grandchild), false, 'the watchers\' child is gone')
  } finally {
    killGroup(run, 'SIGKILL')
    if (grandchild > 0 && alive(grandchild)) process.kill(grandchild, 'SIGKILL')
  }
})

test('package.json: pnpm dev runs the script', async () => {
  const pkg = JSON.parse(await readFile(join(REPO, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
  assert.equal(pkg.scripts.dev, 'node scripts/dev.ts')
})
