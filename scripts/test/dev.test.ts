/**
 * `pnpm dev` (`scripts/dev.ts`): its arguments, the install environment, the git identity, the sign-in link, and what
 * `main` does. Nothing here boots dsh or touches a real `.dev`, dsh home or XDG directory. Every `main` run uses a temp
 * `root` that holds stand-ins for the three programs `pnpm dev` starts: `deploy/install.sh`, `node_modules/.bin/dsh`
 * and `node_modules/.bin/pnpm` (the watchers). The stand-ins log what they are given and which signals reach them.
 */

import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { UsageError } from '../env.ts'
import { DEFAULT_PORT, gitIdentity, installEnvironment, main, parseDevArgs, serverEnvironment, signInLink } from '../dev.ts'

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

// ---- serverEnvironment ------------------------------------------------------------------------------------------

test('serverEnvironment: install.sh\'s four inputs are taken out, whatever their values, and nothing else is', () => {
  const devEnv: NodeJS.ProcessEnv = {
    PATH: BASE_PATH,
    DSH_HOME: '/r/.dev/dsh',
    DSH_DISH_HOME: '/r/.dev',
    DISH_ENV: 'dev',
    DISH_REMOTE: 'git@github-dish-config:bketelsen/dish-config.git',
    DISH_PROFILE: 'web',
    DISH_USER_NAME: 'inherited',
    DISH_USER_EMAIL: '',
    OTHER: 'kept',
  }
  const before = { ...devEnv }
  assert.deepEqual(serverEnvironment(devEnv), { PATH: BASE_PATH, DSH_HOME: '/r/.dev/dsh', DSH_DISH_HOME: '/r/.dev', DISH_ENV: 'dev', OTHER: 'kept' })
  assert.deepEqual(devEnv, before, 'the input is not modified')
})

// ---- gitIdentity ------------------------------------------------------------------------------------------------

/** An environment in which git reads no global or system configuration, so only the repository's own counts. */
function isolatedGit(): NodeJS.ProcessEnv {
  return { PATH: BASE_PATH, HOME: dir, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
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
  assert.deepEqual(await gitIdentity(repo, { PATH: join(dir, 'no-such-bin'), HOME: dir }), { name: 'dish dev', email: 'dev@dish.invalid' })
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
    const { result, stderr } = await capturedStderr(() => main([], { root, env: { PATH: BASE_PATH, HOME: dir, DISH_ENV: value } }))
    assert.equal(result, 2, value)
    assert.equal(stderr, message, value)
    assert.equal(await exists(join(root, '.dev')), false, `${value}: no .dev`)
  }
})

test('main: a bad --port returns 2 and makes no .dev', async () => {
  for (const argv of [['--port', 'abc'], ['--port', '70000'], ['--port'], ['--nope']]) {
    const root = join(dir, `badport-${++counter}`)
    await mkdir(root)
    const { result, stderr } = await capturedStderr(() => main(argv, { root, env: { PATH: BASE_PATH, HOME: dir } }))
    assert.equal(result, 2, JSON.stringify(argv))
    assert.match(stderr, /^dev: [^\n]+\n$/, 'one line')
    assert.equal(await exists(join(root, '.dev')), false)
  }
})

// ---- main: with stand-ins for install.sh, dsh and the watchers ---------------------------------------------------

/**
 * What a stand-in does. By default it runs until it is signalled: SIGTERM ends it with `termCode` (0) at once, and SIGINT
 * with 130 after `interruptMs` (dsh takes a moment to shut down). Every start and every signal is appended to
 * `<role>.log`. How it ended goes to `<role>.exit`: its exit code, which an error nobody handled (an EIO or an EPIPE on
 * stdout or stderr) makes 1, as dsh's own fail-loud handler does, with the error's code in `<role>.uncaught`.
 */
interface Stub {
  /** Exit by itself after this many milliseconds, with `code`. */
  exitAfterMs?: number
  code?: number
  /** Lines to print to stdout on start (the sign-in line, for dsh). */
  print?: string[]
  /** Lines to print to stderr on start. */
  printErr?: string[]
  /**
   * Lines to log as it shuts down, once a signal has told it to and its `interruptMs` or `termMs` is up, as dsh logs its
   * dispose: on stdout, stderr, stdout, stderr and stdout, 100 ms apart, each line followed by ` (stdout)` or ` (stderr)`.
   * So it writes to each stream again after pnpm dev has had a write fail and has seen more of its output. The exit comes
   * 100 ms after the last, so a write that failed has ended it by then.
   */
  stopLines?: string[]
  /** Milliseconds from a first SIGINT to the exit. */
  interruptMs?: number
  /** The exit code after a SIGTERM or SIGHUP. */
  termCode?: number
  /** Milliseconds from a first SIGTERM or SIGHUP to the exit: dsh takes a moment, and a second signal would show. */
  termMs?: number
  /** Start a child of its own that outlives this stand-in's exit, as pnpm's build scripts outlive pnpm's death. */
  grandchild?: boolean
}

/** The start line a stand-in logs. */
interface StubStart {
  argv: string[]
  cwd: string
  pid: number
  pgrp?: number
  DSH_HOME?: string
  DSH_DISH_HOME?: string
  DISH_ENV?: string
  DISH_REMOTE?: string
  dishNames: string[]
}

const STUB_SOURCE = `
const fs = require('node:fs')
const role = process.env.STUB_ROLE
const stub = JSON.parse(process.env.STUB_CONFIG || '{}')[role] || {}
const log = line => fs.appendFileSync(process.env.STUB_LOG + '/' + role + '.log', line + '\\n')
fs.writeFileSync(process.env.STUB_LOG + '/' + role + '.pid', String(process.pid))
let pgrp
try {
  const stat = fs.readFileSync('/proc/self/stat', 'utf8')
  pgrp = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2])
} catch {}
process.on('uncaughtException', error => {
  fs.writeFileSync(process.env.STUB_LOG + '/' + role + '.uncaught', [error.code, error.syscall].filter(Boolean).join(' ') || String(error))
  process.exit(1)
})
process.on('exit', code => fs.writeFileSync(process.env.STUB_LOG + '/' + role + '.exit', String(code)))
// The streams' own write, not console's, which would swallow a failed write: a failure must end the stand-in.
const stop = code => {
  const bursts = stub.stopLines ? ['stdout', 'stderr', 'stdout', 'stderr', 'stdout'] : []
  const next = () => {
    const name = bursts.shift()
    if (name === undefined) return process.exit(code)
    for (const line of stub.stopLines) process[name].write(line + ' (' + name + ')\\n')
    setTimeout(next, 100)
  }
  next()
}
let ending = false
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    log(signal)
    if (ending) return
    ending = true
    if (signal === 'SIGINT') setTimeout(() => stop(130), stub.interruptMs ?? 300)
    else setTimeout(() => stop(stub.termCode ?? 0), stub.termMs ?? 0)
  })
}
// The tests signal a stand-in only once it has logged its start, so every handler is in place before that: a signal
// that came first would kill it, with no exit recorded.
log('start ' + JSON.stringify({
  argv: process.argv.slice(2), cwd: process.cwd(), pid: process.pid, pgrp,
  DSH_HOME: process.env.DSH_HOME, DSH_DISH_HOME: process.env.DSH_DISH_HOME, DISH_ENV: process.env.DISH_ENV,
  dishNames: Object.keys(process.env).filter(name => /^DISH_/.test(name)).sort(), DISH_REMOTE: process.env.DISH_REMOTE,
}))
for (const line of stub.print || []) console.log(line)
for (const line of stub.printErr || []) console.error(line)
if (stub.grandchild) {
  const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  fs.writeFileSync(process.env.STUB_LOG + '/' + role + '.child.pid', String(child.pid))
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
      // Nothing started from a fixture may find the real home: not a stand-in, not a shell on a pty.
      HOME: root,
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

/**
 * How a stand-in ended: its exit code, followed by the error that ended it (`1 (EIO write)`) if one did, or `no exit
 * recorded` when it recorded none within 5 s (it was killed).
 */
async function ending(fixture: Fixture, role: string): Promise<string> {
  for (const deadline = Date.now() + 5000; ;) {
    const code = await readFile(join(fixture.logs, `${role}.exit`), 'utf8').catch(() => undefined)
    if (code !== undefined) {
      const uncaught = await readFile(join(fixture.logs, `${role}.uncaught`), 'utf8').catch(() => '')
      return uncaught === '' ? code : `${code} (${uncaught})`
    }
    if (Date.now() > deadline) return 'no exit recorded'
    await new Promise(resolve => setTimeout(resolve, 25))
  }
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

/** Waits for pnpm dev to exit. When it doesn't, the test fails instead of hanging, so that its finally block can reap. */
async function finished(run: Launched, ms = 20000): Promise<{ code: number | null, signal: NodeJS.Signals | null }> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`pnpm dev did not exit within ${ms} ms (stderr: ${run.stderr()})`)), ms)
  })
  try {
    return await Promise.race([run.closed, timeout])
  } finally {
    clearTimeout(timer)
  }
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

/** Whether a process exists (signal 0). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Whether `pid` is one of this fixture's stand-ins or their children: they all run in the fixture's root. */
async function isStandIn(fixture: Fixture, pid: number): Promise<boolean> {
  return (await readlink(`/proc/${pid}/cwd`).catch(() => '')) === fixture.root
}

/**
 * Leaves nothing running, even when an assertion failed halfway: SIGKILL to the wrapper's group, and to the groups of
 * dsh and the watchers, which have their own, and to the watchers' child, found by the pids the stand-ins recorded (and
 * the wrapper's, when a terminal started it). A recorded pid is only signalled while it still is a process running in
 * the fixture's root.
 */
async function reap(fixture: Fixture, run?: Launched): Promise<void> {
  if (run !== undefined) killGroup(run, 'SIGKILL')
  for (const file of ['wrapper.pid', 'dsh.pid', 'pnpm.pid', 'pnpm.child.pid']) {
    const pid = Number(await readFile(join(fixture.logs, file), 'utf8').catch(() => '0'))
    if (pid <= 0 || !(await isStandIn(fixture, pid))) continue
    for (const target of [-pid, pid]) {
      try {
        process.kill(target, 'SIGKILL')
      } catch {
        // Not a group leader, or already gone.
      }
    }
  }
}

test('main: installs, then starts the watchers and dsh with the dev environment, and prints the sign-in link once', async () => {
  const fixture = await makeFixture({
    dsh: {
      print: ['booting', 'dsh web: http://127.0.0.1:3999/?token=abc', 'dsh web: opening the default browser; pass --no-open to disable'],
      printErr: ['dsh: a line on stderr'],
      exitAfterMs: 400,
    },
    pnpm: { print: ['watchers: built'], printErr: ['watchers: a line on stderr'] },
  })
  // install.sh's inputs, as a shell or an .envrc on the desktop might have them: the real remote among them.
  Object.assign(fixture.env, {
    DISH_REMOTE: 'git@github-dish-config:bketelsen/dish-config.git',
    DISH_USER_NAME: 'Inherited Name',
    DISH_USER_EMAIL: 'inherited@example.com',
    DISH_PROFILE: 'inherited-profile',
  })
  fixture.env.DSH_HOME = '/elsewhere'
  const run = await launch(fixture, ['--port', '3999'])
  try {
    const { code } = await finished(run)
    assert.equal(code, 0, run.stderr())

    const [install] = await readLog(fixture, 'install')
    assert.ok(install!.includes('DISH_REMOTE=[] '), `an inherited remote is emptied: ${install}`)
    assert.ok(install!.includes('DISH_PROFILE=[web]'), install)
    assert.ok(/DISH_USER_NAME=\[[^\]]+\]/.test(install!) && /DISH_USER_EMAIL=\[[^\]]+@[^\]]+\]/.test(install!), install)
    assert.ok(!install!.includes('nherited'), `the identity is the checkout's, not the inherited one: ${install}`)
    assert.ok(install!.includes(`DSH_HOME=[${join(fixture.root, '.dev', 'dsh')}]`), `DSH_HOME is the dev one: ${install}`)
    assert.ok(install!.includes(`DSH_DISH_HOME=[${join(fixture.root, '.dev')}]`), install)
    assert.ok(install!.includes('DISH_ENV=[dev]'), install)

    const [dshStart] = await readLog(fixture, 'dsh')
    const dsh = JSON.parse(dshStart!.slice('start '.length)) as StubStart
    assert.deepEqual(dsh.argv, ['web', '--host', '127.0.0.1', '--port', '3999', '--no-open'])
    assert.equal(dsh.cwd, fixture.root, 'dsh runs in the checkout')
    assert.equal(dsh.DSH_HOME, join(fixture.root, '.dev', 'dsh'))
    assert.equal(dsh.DSH_DISH_HOME, join(fixture.root, '.dev'))
    assert.equal(dsh.DISH_ENV, 'dev')

    const [pnpmStart] = await readLog(fixture, 'pnpm')
    const watchers = JSON.parse(pnpmStart!.slice('start '.length)) as StubStart
    assert.deepEqual(watchers.argv, ['--filter', './plugins/*', '--parallel', '--if-present', 'run', 'dev'])
    assert.equal(watchers.cwd, fixture.root)
    assert.equal(watchers.DSH_DISH_HOME, join(fixture.root, '.dev'))

    // Neither the install's inputs nor the inherited ones reach dsh or the watchers (nor, through dsh, an agent's shell,
    // where an install.sh run by hand would otherwise find the real remote and make dev's store a second pusher).
    for (const [name, seen] of [['dsh', dsh], ['the watchers', watchers]] as const) {
      assert.deepEqual(seen.dishNames, ['DISH_ENV'], `${name}: only DISH_ENV, whatever the parent had`)
    }
    // dsh and the watchers each lead a process group of their own, apart from pnpm dev's (the wrapper's).
    for (const [name, seen] of [['dsh', dsh], ['the watchers', watchers]] as const) {
      if (seen.pgrp === undefined) continue // no /proc here
      assert.equal(seen.pgrp, seen.pid, `${name} leads its own process group`)
      assert.notEqual(seen.pgrp, run.child.pid, `${name} is not in pnpm dev's group`)
    }

    const lines = run.stdout().split('\n')
    const own = lines.indexOf('dsh web: http://127.0.0.1:3999/?token=abc')
    const open = lines.indexOf('dev: open http://127.0.0.1:3999/?token=abc')
    assert.ok(lines.includes('booting'), 'dsh\'s own lines are passed through')
    assert.ok(own >= 0, 'including the sign-in line')
    assert.ok(open > own, 'the dev: open line follows it')
    assert.equal(lines.filter(line => line.startsWith('dev: open ')).length, 1, 'once')
    assert.ok(lines.includes('watchers: built'), 'the watchers\' stdout is passed through')
    const errors = run.stderr().split('\n')
    assert.ok(errors.includes('dsh: a line on stderr'), 'dsh\'s stderr is passed through to stderr')
    assert.ok(errors.includes('watchers: a line on stderr'), 'and the watchers\'')
    for (const name of ['dsh', 'config', 'state', 'data', 'cache']) {
      assert.equal((await stat(join(fixture.root, '.dev', name))).mode & 0o777, 0o700, name)
    }
  } finally {
    await reap(fixture, run)
  }
})

test('main: a failing install.sh returns 1, says so, and starts neither dsh nor the watchers', async () => {
  const fixture = await makeFixture({}, { STUB_INSTALL_EXIT: '9' })
  const run = await launch(fixture)
  try {
    const { code } = await finished(run)
    assert.equal(code, 1)
    assert.equal(run.stderr(), 'dev: install.sh failed (exit 9)\n')
    assert.deepEqual(await readLog(fixture, 'dsh'), [])
    assert.deepEqual(await readLog(fixture, 'pnpm'), [])
  } finally {
    await reap(fixture, run)
  }
})

test('main: when dsh exits, the watchers are stopped once, and the exit code is dsh\'s', async () => {
  const fixture = await makeFixture({ dsh: { exitAfterMs: 300, code: 3 } })
  const run = await launch(fixture)
  try {
    const { code } = await finished(run)
    assert.equal(code, 3, run.stderr())
    for (const role of ['dsh', 'pnpm']) {
      const [start] = await readLog(fixture, role)
      assert.deepEqual((JSON.parse(start!.slice('start '.length)) as StubStart).dishNames, ['DISH_ENV'], `${role}: only DISH_ENV, with no remote to inherit`)
    }
    assert.deepEqual((await readLog(fixture, 'pnpm')).slice(1), ['SIGTERM'], 'the watchers got one SIGTERM')
  } finally {
    await reap(fixture, run)
  }
})

test('main: when the watchers exit, dsh is stopped once, and the exit code is the watchers\'', async () => {
  const fixture = await makeFixture({ pnpm: { exitAfterMs: 300, code: 4 } })
  const run = await launch(fixture)
  try {
    const { code } = await finished(run)
    assert.equal(code, 4, run.stderr())
    assert.deepEqual((await readLog(fixture, 'dsh')).slice(1), ['SIGTERM'], 'dsh got one SIGTERM, and no second signal')
  } finally {
    await reap(fixture, run)
  }
})

test('main: the first non-zero code wins, not the one of the child that was stopped afterwards', async () => {
  const fixture = await makeFixture({ dsh: { exitAfterMs: 300, code: 3 }, pnpm: { termCode: 143 } })
  const run = await launch(fixture)
  try {
    const { code } = await finished(run)
    assert.equal(code, 3, run.stderr())
    assert.deepEqual((await readLog(fixture, 'pnpm')).slice(1), ['SIGTERM'])
  } finally {
    await reap(fixture, run)
  }
})

test('main: a child that cannot be started gives 127 for it, and the other is stopped', async () => {
  const fixture = await makeFixture()
  await rm(join(fixture.root, 'node_modules', '.bin', 'dsh'))
  const run = await launch(fixture)
  try {
    const { code } = await finished(run)
    assert.equal(code, 127)
    assert.match(run.stderr(), /^dev: cannot start dsh: /m)
    assert.deepEqual((await readLog(fixture, 'pnpm')).slice(1), ['SIGTERM'], 'the watchers were stopped')
  } finally {
    await reap(fixture, run)
  }
})

test('Ctrl-C: dsh gets one SIGINT from pnpm dev, and the watchers a SIGTERM once dsh has gone', async () => {
  // dsh is in a session of its own, so a terminal's Ctrl-C (a SIGINT to the foreground group, which here is the
  // wrapper's) doesn't reach it: pnpm dev forwards it, once. The watchers are not sent the SIGINT; they are stopped
  // with a SIGTERM when dsh has finished its shutdown. The wrapper's exit code is the SIGINT's: 130.
  const fixture = await makeFixture({ dsh: { interruptMs: 800 } })
  const run = await launch(fixture)
  try {
    await bothUp(fixture, run)
    killGroup(run, 'SIGINT')
    const { code, signal } = await finished(run)
    assert.equal(signal, null, 'pnpm dev did not die of the SIGINT')
    assert.equal(code, 130, 'it waited for the children and returned 128 + SIGINT')
    assert.deepEqual((await readLog(fixture, 'dsh')).slice(1), ['SIGINT'], 'dsh: one SIGINT, and nothing after it')
    assert.deepEqual((await readLog(fixture, 'pnpm')).slice(1), ['SIGTERM'], 'the watchers: a SIGTERM, not a forwarded SIGINT')
  } finally {
    await reap(fixture, run)
  }
})

test('a second Ctrl-C is a second SIGINT to dsh, which forces it out as it does on its own', async () => {
  const fixture = await makeFixture({ dsh: { interruptMs: 1500 } })
  const run = await launch(fixture)
  try {
    await bothUp(fixture, run)
    killGroup(run, 'SIGINT')
    for (const deadline = Date.now() + 5000; (await readLog(fixture, 'dsh')).length < 2;) {
      assert.ok(Date.now() < deadline, 'dsh got the first SIGINT')
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    killGroup(run, 'SIGINT')
    const { code } = await finished(run)
    assert.equal(code, 130)
    assert.deepEqual((await readLog(fixture, 'dsh')).slice(1), ['SIGINT', 'SIGINT'], 'each Ctrl-C was forwarded once')
  } finally {
    await reap(fixture, run)
  }
})

test('the watchers leaving while dsh is still shutting down from a Ctrl-C does not get dsh a SIGTERM', async () => {
  // The Ctrl-C comes within a second of the start; the watchers' stand-in leaves on its own 1.5 s after its start,
  // and dsh takes 3 s over its shutdown. A SIGTERM on top of dsh's SIGINT would make it force-exit.
  const fixture = await makeFixture({ dsh: { interruptMs: 3000 }, pnpm: { exitAfterMs: 1500 } })
  const run = await launch(fixture)
  try {
    await bothUp(fixture, run)
    killGroup(run, 'SIGINT')
    const { code } = await finished(run)
    assert.equal(code, 130)
    assert.deepEqual((await readLog(fixture, 'dsh')).slice(1), ['SIGINT'], 'dsh: the one SIGINT, and no SIGTERM after the watchers left')
  } finally {
    await reap(fixture, run)
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
    const { code, signal } = await finished(run)
    assert.equal(signal, null, 'pnpm dev did not die of the SIGINT')
    assert.equal(code, 1)
    assert.equal(run.stderr(), 'dev: install.sh failed (exit 130)\n')
    assert.deepEqual((await readLog(fixture, 'install')).slice(1), ['SIGINT'], 'install.sh got one SIGINT')
    assert.deepEqual(await readLog(fixture, 'dsh'), [])
    assert.deepEqual(await readLog(fixture, 'pnpm'), [])
  } finally {
    await reap(fixture, run)
  }
})

test('SIGTERM, SIGHUP and SIGQUIT, to pnpm dev alone or to its whole group: dsh gets one SIGTERM, the watchers their group\'s signal, nothing is left', async () => {
  // dsh handles SIGINT and SIGTERM only, and force-exits on a second signal. So a SIGHUP reaches it as a SIGTERM, and a
  // signal sent to pnpm dev's group (`kill -- -pgid`, `timeout`) is forwarded once, because dsh is not in that group.
  // The watchers' stand-in exits at once on either signal and leaves its own child behind, as pnpm does with its build
  // scripts (a SIGHUP kills pnpm and orphans them; a SIGTERM leaves pnpm running with them). pnpm dev signals the
  // watchers' whole process group, so the child must go too.
  const cases = [
    { signal: 'SIGTERM', to: 'process', dsh: 'SIGTERM', watchers: 'SIGTERM', code: 143 },
    { signal: 'SIGTERM', to: 'group', dsh: 'SIGTERM', watchers: 'SIGTERM', code: 143 },
    { signal: 'SIGHUP', to: 'process', dsh: 'SIGTERM', watchers: 'SIGHUP', code: 129 },
    { signal: 'SIGHUP', to: 'group', dsh: 'SIGTERM', watchers: 'SIGHUP', code: 129 },
    // Ctrl-\ kills pnpm and pnpm dev's other group members, but dsh and the watchers are in sessions of their own.
    { signal: 'SIGQUIT', to: 'process', dsh: 'SIGTERM', watchers: 'SIGTERM', code: 131 },
    { signal: 'SIGQUIT', to: 'group', dsh: 'SIGTERM', watchers: 'SIGTERM', code: 131 },
  ] as const
  for (const { signal, to, dsh, watchers, code } of cases) {
    const label = `${signal} to ${to}`
    const fixture = await makeFixture({ pnpm: { grandchild: true } })
    const run = await launch(fixture)
    let grandchild = 0
    try {
      await bothUp(fixture, run)
      for (const deadline = Date.now() + 5000; grandchild === 0 && Date.now() < deadline;) {
        grandchild = Number(await readFile(join(fixture.logs, 'pnpm.child.pid'), 'utf8').catch(() => '0'))
        if (grandchild === 0) await new Promise(resolve => setTimeout(resolve, 25))
      }
      assert.ok(grandchild > 0 && alive(grandchild), `${label}: the watchers' child is running`)
      if (to === 'group') killGroup(run, signal)
      else run.child.kill(signal)
      const { code: got, signal: died } = await finished(run)
      assert.equal(died, null, label)
      assert.equal(got, code, `${label}: 128 + the signal (${run.stderr()})`)
      assert.deepEqual((await readLog(fixture, 'dsh')).slice(1), [dsh], `${label}: dsh`)
      assert.deepEqual((await readLog(fixture, 'pnpm')).slice(1), [watchers], `${label}: the watchers`)
      for (const deadline = Date.now() + 5000; alive(grandchild) && Date.now() < deadline;) {
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      assert.equal(alive(grandchild), false, `${label}: the watchers' child is gone`)
    } finally {
      await reap(fixture, run)
    }
  }
})

test('a second signal for a child already signalled is dropped, except a second Ctrl-C', async () => {
  // A closed terminal hangs up twice (the shell's SIGHUP to its jobs, then the kernel's when the shell exits), and a
  // group SIGTERM can be followed by that hangup. Each would reach dsh as a SIGTERM, and two make it force-exit. The
  // stand-ins take 600 ms over their exit, so a second signal sent 60 ms after the first would show in their logs.
  const cases = [
    { signals: ['SIGHUP', 'SIGHUP'], dsh: ['SIGTERM'], watchers: ['SIGHUP'], code: 129 },
    { signals: ['SIGTERM', 'SIGHUP'], dsh: ['SIGTERM'], watchers: ['SIGTERM'], code: 143 },
    { signals: ['SIGTERM', 'SIGTERM'], dsh: ['SIGTERM'], watchers: ['SIGTERM'], code: 143 },
    { signals: ['SIGQUIT', 'SIGHUP'], dsh: ['SIGTERM'], watchers: ['SIGTERM'], code: 131 },
    // Ctrl-C and then a hangup: dsh is already shutting down, and the hangup is not a second Ctrl-C.
    { signals: ['SIGINT', 'SIGHUP'], dsh: ['SIGINT'], watchers: ['SIGHUP'], code: 130 },
  ] as const
  for (const { signals, dsh, watchers, code } of cases) {
    const label = signals.join(' then ')
    const fixture = await makeFixture({ dsh: { termMs: 600, interruptMs: 600 }, pnpm: { termMs: 600 } })
    const run = await launch(fixture)
    try {
      await bothUp(fixture, run)
      run.child.kill(signals[0])
      await new Promise(resolve => setTimeout(resolve, 60))
      run.child.kill(signals[1])
      const { code: got, signal: died } = await finished(run)
      assert.equal(died, null, label)
      assert.equal(got, code, `${label}: 128 + the first signal (${run.stderr()})`)
      assert.deepEqual((await readLog(fixture, 'dsh')).slice(1), dsh, `${label}: dsh got one signal`)
      assert.deepEqual((await readLog(fixture, 'pnpm')).slice(1), watchers, `${label}: the watchers got one signal`)
    } finally {
      await reap(fixture, run)
    }
  }
})

/** Whether util-linux's `script` is here: it runs a command on a pty of its own, which a terminal-close test needs. */
const HAS_SCRIPT = (() => {
  try {
    return /util-linux/.test(execFileSync('script', ['--version'], { encoding: 'utf8', env: { PATH: BASE_PATH, HOME: tmpdir() }, stdio: ['ignore', 'pipe', 'ignore'] }))
  } catch {
    return false
  }
})()

test('closing the terminal: dsh gets one SIGTERM, the watchers a hangup, all three end as they choose, nothing is left, and pnpm dev ends 129', {
  skip: !HAS_SCRIPT && 'needs util-linux script',
}, async () => {
  // An interactive bash on a pty runs pnpm dev as its foreground job. When the terminal goes away, bash hangs up its job
  // (a SIGHUP to the job's group) and, as it exits, the kernel hangs up the session's foreground group again: pnpm dev
  // sees two SIGHUPs a few milliseconds apart. dsh must still get exactly one signal, and it takes 500 ms over its exit
  // here, so a second one would show. Then dsh and the watchers log their shutdown on both streams, when the terminal is
  // gone (a write to it fails with EIO): that must end neither them nor pnpm dev, which relays it.
  const fixture = await makeFixture({ dsh: { termMs: 500, stopLines: ['dsh: shutting down'] }, pnpm: { grandchild: true, stopLines: ['watchers: stopping'] } })
  const wrapper = join(fixture.root, 'wrapper-pty.ts')
  const exitFile = join(fixture.logs, 'wrapper.exit')
  await writeFile(wrapper, [
    `import { writeFileSync } from 'node:fs'`,
    `import { main } from ${JSON.stringify(DEV)}`,
    `writeFileSync(${JSON.stringify(join(fixture.logs, 'wrapper.pid'))}, String(process.pid))`,
    `const code = await main(process.argv.slice(2), { root: ${JSON.stringify(fixture.root)} })`,
    `writeFileSync(${JSON.stringify(exitFile)}, String(code))`,
    '',
  ].join('\n'))
  // The shell keeps its history in the fixture: bash saves it when it is hung up, and with no HOME or HISTFILE of its
  // own it would rewrite the user's real ~/.bash_history.
  const history = join(fixture.root, '.bash_history')
  const terminal = spawn('script', ['-qefc', 'bash --norc -i', '/dev/null'], {
    env: { ...fixture.env, HOME: fixture.root, HISTFILE: history, TERM: 'dumb' },
    stdio: ['pipe', 'ignore', 'ignore'],
  })
  try {
    terminal.stdin.write(`cd ${JSON.stringify(fixture.root)} && node ${JSON.stringify(wrapper)}\n`)
    for (const deadline = Date.now() + 15000; ;) {
      if ((await readLog(fixture, 'dsh')).length > 0 && (await readLog(fixture, 'pnpm')).length > 0) break
      assert.ok(Date.now() < deadline, 'the stand-ins started')
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    terminal.kill('SIGKILL') // the pty master closes, and the kernel hangs up the session
    for (const deadline = Date.now() + 15000; !(await exists(exitFile));) {
      assert.ok(Date.now() < deadline, 'pnpm dev ended')
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    assert.equal(await readFile(exitFile, 'utf8'), '129', 'pnpm dev ended with 128 + SIGHUP')
    for (const deadline = Date.now() + 5000; !(await exists(history)) && Date.now() < deadline;) {
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    assert.ok(await exists(history), 'the shell saved its history in the fixture, not in a real home')
    assert.deepEqual((await readLog(fixture, 'dsh')).slice(1), ['SIGTERM'], 'dsh: one SIGTERM, though the hangup came twice')
    assert.equal(await ending(fixture, 'dsh'), '0', 'dsh finished its shutdown and exited as it chose to')
    assert.equal(await ending(fixture, 'pnpm'), '0', 'the watchers too')
    const grandchild = Number(await readFile(join(fixture.logs, 'pnpm.child.pid'), 'utf8'))
    for (const deadline = Date.now() + 5000; alive(grandchild) && Date.now() < deadline;) {
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    assert.equal(alive(grandchild), false, 'the watchers\' child is gone')
  } finally {
    terminal.kill('SIGKILL')
    await reap(fixture)
  }
})

test('a closed pipe (pnpm dev | tee, then Ctrl-C): pnpm dev, dsh and the watchers all end as they choose', async () => {
  // A Ctrl-C ends tee with the rest of the foreground group, so pnpm dev's stdout is a pipe nobody reads while dsh shuts
  // down and logs it (a write to it fails with EPIPE). pnpm dev must drop what it can't write and keep reading what dsh
  // and the watchers write, so that neither gets an EPIPE of its own; what goes to stderr still arrives.
  const fixture = await makeFixture({
    dsh: { print: ['dsh web: http://127.0.0.1:3999/?token=abc'], interruptMs: 300, stopLines: ['dsh: shutting down'] },
    pnpm: { stopLines: ['watchers: stopping'] },
  })
  const run = await launch(fixture)
  try {
    await bothUp(fixture, run)
    for (const deadline = Date.now() + 5000; !run.stdout().includes('dev: open ');) {
      assert.ok(Date.now() < deadline, `pnpm dev printed the link (stderr: ${run.stderr()})`)
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    run.child.stdout!.destroy() // tee is gone: nothing reads pnpm dev's stdout any more
    killGroup(run, 'SIGINT')
    const { code, signal } = await finished(run)
    assert.equal(signal, null, 'pnpm dev did not die')
    assert.equal(code, 130, `pnpm dev waited for the children and returned 128 + SIGINT (stderr: ${run.stderr()})`)
    assert.equal(await ending(fixture, 'dsh'), '130', 'dsh finished its shutdown and exited as it chose to')
    assert.equal(await ending(fixture, 'pnpm'), '0', 'the watchers, stopped once dsh had gone, too')
    const errors = run.stderr().split('\n')
    assert.ok(errors.includes('dsh: shutting down (stderr)'), `dsh's stderr still arrives: ${run.stderr()}`)
    assert.ok(errors.includes('watchers: stopping (stderr)'), `and the watchers': ${run.stderr()}`)
  } finally {
    await reap(fixture, run)
  }
})

test('when the watchers die by themselves, what they started goes too', async () => {
  const fixture = await makeFixture({ pnpm: { grandchild: true, exitAfterMs: 400, code: 4 } })
  const run = await launch(fixture)
  let grandchild = 0
  try {
    const { code } = await finished(run)
    assert.equal(code, 4, run.stderr())
    grandchild = Number(await readFile(join(fixture.logs, 'pnpm.child.pid'), 'utf8'))
    assert.ok(grandchild > 0)
    for (const deadline = Date.now() + 5000; alive(grandchild) && Date.now() < deadline;) {
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    assert.equal(alive(grandchild), false, 'the watchers\' child is gone')
  } finally {
    await reap(fixture, run)
  }
})

test('package.json: pnpm dev runs the script', async () => {
  const pkg = JSON.parse(await readFile(join(REPO, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
  assert.equal(pkg.scripts.dev, 'node scripts/dev.ts')
})
