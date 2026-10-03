/**
 * `deploy/dish-sandbox`, run for real: dsh's own provider (`@deepseek-ai/dsh-sandbox-local`, found through the root
 * `@deepseek-ai/dsh`) builds the argv for each call, with the script as its `runnerCommand`, and real bwrap runs it. So
 * the argv shape these tests feed the script is dsh's, not a copy of it, and a dsh upgrade that changes it shows here.
 * dsh's own classifiers (`@deepseek-ai/dsh-sandbox`) say what dsh would make of each result: a denial, a runner failure,
 * or neither.
 *
 * The script binds $HOME writable, so every run here has a HOME of the test's own: a fresh directory under the test's
 * temp directory, never the runner's home (checked before every run). The whole environment is the test's own making.
 * The tests are skipped when there is no bwrap at /usr/bin/bwrap or /usr/local/bin/bwrap, or it can't make a sandbox
 * (no user namespaces).
 */

import assert from 'node:assert/strict'
import { execFile, spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir, userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse } from 'yaml'
import { RUNNER_FAILURE_SIGNATURES, writeDishRows } from '../profile.ts'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SCRIPT = join(ROOT, 'deploy', 'dish-sandbox')
const BWRAP = ['/usr/bin/bwrap', '/usr/local/bin/bwrap'].find((path) => existsSync(path))
/** The runner's own home, from the password database rather than HOME: no run may bind it. */
const REAL_HOME = userInfo().homedir
const TMP = realpathSync(tmpdir())

// dsh's provider and classifiers, each resolved by the package that depends on it, starting from the root dsh.
const dsh = createRequire(join(ROOT, 'package.json')).resolve('@deepseek-ai/dsh/package.json')
const base = createRequire(dsh).resolve('@deepseek-ai/dsh-base/package.json')
const localEntry = createRequire(base).resolve('@deepseek-ai/dsh-sandbox-local')
const seamEntry = createRequire(localEntry).resolve('@deepseek-ai/dsh-sandbox')
const { LocalSandboxProvider } = await import(pathToFileURL(localEntry).href)
const { classifyRunnerFailure, matchesSignature } = await import(pathToFileURL(seamEntry).href)

type Mode = 'read-only' | 'workspace-write'

interface Confined {
  argv: string[]
  enforcement: string
  denialSignatures: string[]
  runnerFailureRules: Array<{ fatalSignatures: string[], allowedExitCodes?: number[] }>
}

/** What dsh's provider would hand its executor for `argv` under `mode`, with `runnerCommand` as its hook. */
async function confine(runnerCommand: string[], argv: string[], mode: Mode, workspaceRoot: string): Promise<Confined> {
  const provider = { runnerCommand, configuredRunnerFailureSignatures: [...RUNNER_FAILURE_SIGNATURES] }
  return await LocalSandboxProvider.prototype.confine.call(provider, argv, { mode, workspaceRoot }) as Confined
}

/** Whether bwrap can make dsh's read-only sandbox here, as dsh's own probe asks it. */
function bwrapWorks(): boolean {
  if (BWRAP === undefined) return false
  const probe = spawnSync(BWRAP, ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent', '--', 'true'], {
    env: { PATH: '/usr/bin:/bin' }, stdio: 'ignore', timeout: 10_000,
  })
  return probe.status === 0
}

const SKIP = BWRAP === undefined
  ? 'no bwrap at /usr/bin/bwrap or /usr/local/bin/bwrap'
  : bwrapWorks() ? false : 'bwrap cannot make a sandbox here (user namespaces?)'

const boxes: string[] = []
after(async () => {
  await Promise.all(boxes.map((dir) => rm(dir, { recursive: true, force: true })))
})

interface Box {
  dir: string
  home: string
  workspace: string
  /** The script the runs use: the checkout's, or a copy inside a fake checkout. */
  script: string
  env: NodeJS.ProcessEnv
}

/**
 * A fresh scratch home and workspace. `workspace: 'outside'` puts the workspace outside the home. `env` adds to, or
 * with `undefined` removes from, the run's environment. `checkout: true` copies the script into `~/checkout/deploy`, so
 * that its checkout is under the home.
 */
async function makeBox(options: { workspace?: 'home' | 'outside', env?: Record<string, string | undefined>, checkout?: boolean } = {}): Promise<Box> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'dish-sandbox-test-')))
  boxes.push(dir)
  const home = join(dir, 'home')
  const workspace = options.workspace === 'outside' ? join(dir, 'outside', 'project') : join(home, 'work', 'project')
  await mkdir(home)
  await mkdir(workspace, { recursive: true })
  let script = SCRIPT
  if (options.checkout === true) {
    script = join(home, 'checkout', 'deploy', 'dish-sandbox')
    await mkdir(dirname(script), { recursive: true })
    await copyFile(SCRIPT, script)
    await chmod(script, 0o755)
  }
  const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin', HOME: home, LANG: 'C.UTF-8' }
  for (const [name, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) delete env[name]
    else env[name] = value
  }
  return { dir, home, workspace, script, env }
}

/** Refuse a run whose HOME could be anything but the box's own scratch home. */
function assertScratch(box: Box, env: NodeJS.ProcessEnv): void {
  assert.ok(box.home.startsWith(`${box.dir}/`) && box.dir.startsWith(`${TMP}/`), `${box.home} is not a scratch home`)
  if (env.HOME !== undefined && env.HOME.startsWith('/')) {
    assert.ok(env.HOME === box.home || env.HOME.startsWith(`${box.dir}/`), `HOME ${env.HOME} is not the box's`)
  }
  assert.notEqual(box.home, REAL_HOME)
  assert.ok(!REAL_HOME.startsWith(`${box.home}/`), 'the real home is under the scratch home')
}

interface Result {
  code: number
  stdout: string
  stderr: string
  confined: Confined
}

function exec(file: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ code: number, stdout: string, stderr: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { cwd, env, encoding: 'utf8', timeout: 30_000 }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : -1
      resolve({ code, stdout, stderr })
    })
  })
}

/** Run `argv` the way dsh's sandboxed bash would, through the box's script with `protect` as --protect pairs. */
async function sandboxed(box: Box, argv: string[], options: { mode?: Mode, protect?: string[], env?: NodeJS.ProcessEnv } = {}): Promise<Result> {
  const env = options.env ?? box.env
  assertScratch(box, env)
  const runner = [box.script, ...(options.protect ?? []).flatMap((path) => ['--protect', path])]
  const confined = await confine(runner, argv, options.mode ?? 'workspace-write', box.workspace)
  const [file, ...args] = confined.argv
  return { ...await exec(file!, args, box.workspace, env), confined }
}

/** `bash -c <script>` in the sandbox. */
function bash(box: Box, script: string, options: { mode?: Mode, protect?: string[], env?: NodeJS.ProcessEnv } = {}): Promise<Result> {
  return sandboxed(box, ['bash', '-c', script], options)
}

/** What dsh makes of a result: `denied`, `runner` (the command did not run), or `ok` for anything else. */
function verdict(result: Result): 'denied' | 'runner' | 'ok' {
  if (classifyRunnerFailure(result.code, result.stderr, result.confined.runnerFailureRules) !== undefined) return 'runner'
  return matchesSignature(result.code, result.stderr, result.confined.denialSignatures) ? 'denied' : 'ok'
}

const mode = (path: string): number => statSync(path).mode & 0o777

/** What is in the box's home besides the workspace's own directory. */
async function made(box: Box): Promise<string[]> {
  return (await readdir(box.home)).filter((name) => name !== 'work')
}

/** The protected directories and files for a home with no XDG or DSH variables set, relative to it. */
const PROTECTED_DIRS = [
  '.dsh', '.config/dish', '.local/share/dish', '.local/state/dish', '.cache/dish',
  '.ssh', '.gnupg', '.config/git', '.config/systemd', '.local/share/systemd', '.config/environment.d', '.config/autostart',
  '.config/mise',
]
const PROTECTED_FILES = [
  '.gitconfig', '.git-credentials', '.pam_environment', '.bashrc', '.bash_profile', '.bash_login', '.bash_logout', '.profile',
]

/** A shell script that tries to write each path (a directory gets a new file, a file gets a line) and reports each. */
function tryWrites(dirs: string[], files: string[]): string {
  const lines = [
    ...dirs.map((path) => `if touch ${JSON.stringify(`${path}/new`)} 2>/dev/null; then echo "wrote ${path}"; fi`),
    ...files.map((path) => `if echo x 2>/dev/null >>${JSON.stringify(path)}; then echo "wrote ${path}"; fi`),
  ]
  return lines.join('\n')
}

// --- dsh's side of the contract -------------------------------------------------------------------------------

test('dsh runs the runner as [...runnerCommand, ...its bwrap profile, --, ...argv], with --tmpfs /tmp only in workspace-write', async () => {
  const runner = ['/x/deploy/dish-sandbox', '--protect', '~/p']
  const write = await confine(runner, ['bash', '-c', 'true'], 'workspace-write', '/')
  const separator = write.argv.indexOf('--')
  assert.deepEqual(write.argv.slice(0, 3), runner)
  assert.deepEqual(write.argv.slice(separator), ['--', 'bash', '-c', 'true'])
  const profile = write.argv.slice(3, separator)
  assert.deepEqual(profile.slice(0, 3), ['--ro-bind', '/', '/'], 'the root comes first, so the home bind can win over it')
  assert.ok(profile.join(' ').includes('--tmpfs /tmp'), `workspace-write's profile is ${profile.join(' ')}`)
  assert.ok(!profile.includes('--'), 'the profile has no -- of its own')
  assert.deepEqual(write.runnerFailureRules, [{ fatalSignatures: [...RUNNER_FAILURE_SIGNATURES] }], 'no exit-code gate: any non-zero exit with a fatal line')
  assert.ok(write.denialSignatures.includes('read-only file system'))
  assert.equal(write.enforcement, 'full')

  const read = await confine(runner, ['bash', '-c', 'true'], 'read-only', '/')
  assert.ok(!read.argv.slice(3, read.argv.indexOf('--')).join(' ').includes('--tmpfs /tmp'), "read-only's profile has no --tmpfs /tmp")
})

test("dsh's schema accepts the row profile.ts writes", () => {
  const rows = parse(writeDishRows('', { remote: '', userName: 'T', userEmail: 't@example.invalid', sandboxRunner: SCRIPT })) as Array<{ id: string, name: string, config: unknown }>
  const row = rows.find((entry) => entry.id === 'sandbox')
  assert.equal(row?.name, '@deepseek-ai/dsh-sandbox-local')
  assert.deepEqual(LocalSandboxProvider.Config(row?.config), { runnerCommand: [SCRIPT], runnerFailureSignatures: ['bwrap: ', 'dish-sandbox: '], probeTimeoutMs: 5000 })
})

// --- workspace-write ------------------------------------------------------------------------------------------

test('workspace-write: a command can write the home directory: ~/x, ~/.cache/y and ~/go/z', { skip: SKIP }, async () => {
  const box = await makeBox()
  const result = await bash(box, 'touch ~/x && mkdir -p ~/.cache ~/go && touch ~/.cache/y ~/go/z && echo done')
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.stdout, 'done\n')
  for (const path of ['x', '.cache/y', 'go/z']) assert.ok(existsSync(join(box.home, path)), `${path} was written`)
  assert.equal(verdict(result), 'ok')
})

test('workspace-write: each protected path refuses a write with "Read-only file system", whether it existed or not', { skip: SKIP }, async () => {
  const box = await makeBox({ checkout: true })
  // Some exist already, with content; the rest are missing.
  await mkdir(join(box.home, '.ssh'), { mode: 0o700 })
  await writeFile(join(box.home, '.ssh', 'id_fake'), 'not a key\n')
  await writeFile(join(box.home, '.bashrc'), '# the account\'s own\n')
  await mkdir(join(box.home, '.config', 'git'), { recursive: true })
  const dirs = [...PROTECTED_DIRS.map((path) => join(box.home, path)), join(box.home, 'checkout')]
  const files = PROTECTED_FILES.map((path) => join(box.home, path))
  const before = new Map(files.map((path) => [path, existsSync(path) ? readFileSync(path, 'utf8') : undefined]))

  const result = await bash(box, tryWrites(dirs, files))
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.stdout, '', 'no protected path took a write')
  assert.equal(result.stderr, '')
  for (const path of dirs) assert.ok(!existsSync(join(path, 'new')), `${path}/new`)
  for (const path of files.filter((file) => before.get(file) !== undefined)) assert.equal(readFileSync(path, 'utf8'), before.get(path), path)
  assert.equal(readFileSync(join(box.home, '.ssh', 'id_fake'), 'utf8'), 'not a key\n')

  // One by one, as an agent would meet it: the kernel's words, a denial to dsh, and so the escalation hint.
  for (const command of ['touch ~/.ssh/x', 'echo x >> ~/.bashrc', 'touch ~/.config/systemd/evil.service', 'touch ~/checkout/deploy/dish-sandbox']) {
    const denied = await bash(box, command)
    assert.notEqual(denied.code, 0, command)
    assert.match(denied.stderr, /Read-only file system/, command)
    assert.equal(verdict(denied), 'denied', command)
  }
})

test('workspace-write: the protected list follows DSH_HOME, the XDG variables and DSH_DISH_HOME, and keeps ~/.dsh', { skip: SKIP }, async () => {
  const box = await makeBox()
  const at = (path: string): string => join(box.home, path)
  const env = {
    ...box.env,
    DSH_HOME: at('elsewhere/dsh'),
    XDG_CONFIG_HOME: at('xdg/config'),
    XDG_DATA_HOME: at('xdg/data'),
    XDG_STATE_HOME: at('xdg/state'),
    XDG_CACHE_HOME: at('xdg/cache'),
    DSH_DISH_HOME: at('instance'),
  }
  const moved = ['elsewhere/dsh', '.dsh', 'xdg/config/dish', 'xdg/data/dish', 'xdg/state/dish', 'xdg/cache/dish', 'instance'].map(at)
  const result = await bash(box, `${tryWrites(moved, [])}\ntouch ~/.config/dish-not && touch ~/xdg/config/other && echo free`, { env })
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.stdout, 'free\n', 'only the moved directories are protected; their neighbours are not')
  for (const path of moved) assert.equal(mode(path), 0o700, path)

  // A relative XDG variable, or DSH_DISH_HOME, counts for nothing, as in dish-kit's xdgPaths.
  const relative = await makeBox()
  const relativeEnv = { ...relative.env, XDG_CONFIG_HOME: 'xdg', DSH_DISH_HOME: 'instance' }
  const second = await bash(relative, 'touch ~/.config/dish/x', { env: relativeEnv })
  assert.match(second.stderr, /Read-only file system/)
  assert.ok(!existsSync(join(relative.home, 'xdg')) && !existsSync(join(relative.workspace, 'instance')))
})

test('workspace-write: missing protected paths are made first: directories 0700, files 0600, and ~/.bash_profile reads what bash read before', { skip: SKIP }, async () => {
  const box = await makeBox()
  const result = await bash(box, 'true')
  assert.equal(result.code, 0, result.stderr)
  for (const path of PROTECTED_DIRS) {
    const full = join(box.home, path)
    assert.ok(lstatSync(full).isDirectory(), `${path} is a directory`)
    assert.equal(mode(full), 0o700, path)
    assert.deepEqual(await readdir(full), [], `${path} is empty`)
  }
  for (const path of PROTECTED_FILES) {
    const full = join(box.home, path)
    assert.ok(lstatSync(full).isFile(), `${path} is a file`)
    assert.equal(mode(full), 0o600, path)
    if (path !== '.bash_profile') assert.equal(readFileSync(full, 'utf8'), '', `${path} is empty`)
  }
  // A login bash reads only the first of ~/.bash_profile, ~/.bash_login and ~/.profile: an empty ~/.bash_profile would
  // hide ~/.profile.
  assert.match(readFileSync(join(box.home, '.bash_profile'), 'utf8'), /^if \[ -r ~\/\.profile \]; then \. ~\/\.profile; fi$/m)

  // With a ~/.bash_login, that is what bash read, so that is what the new file reads.
  const withLogin = await makeBox()
  await writeFile(join(withLogin.home, '.bash_login'), 'echo login\n', { mode: 0o644 })
  assert.equal((await bash(withLogin, 'true')).code, 0)
  assert.match(readFileSync(join(withLogin.home, '.bash_profile'), 'utf8'), /^if \[ -r ~\/\.bash_login \]; then \. ~\/\.bash_login; fi$/m)
  assert.equal(readFileSync(join(withLogin.home, '.bash_login'), 'utf8'), 'echo login\n', 'an existing file is left as it is')
  assert.equal(mode(join(withLogin.home, '.bash_login')), 0o644)

  // A login shell outside the sandbox still reads ~/.profile.
  await writeFile(join(box.home, '.profile'), 'echo profile-was-read\n')
  const login = spawnSync('/bin/bash', ['--login', '-c', 'true'], { env: { PATH: '/usr/bin:/bin', HOME: box.home, HISTFILE: join(box.dir, 'history') }, encoding: 'utf8' })
  assert.match(login.stdout, /^profile-was-read$/m)
})

test('workspace-write: a protected directory cannot be moved out of the way, nor a protected file replaced', { skip: SKIP }, async () => {
  const box = await makeBox()
  await mkdir(join(box.home, '.config', 'git'), { recursive: true })
  await writeFile(join(box.home, '.config', 'git', 'config'), '[user]\n\tname = Test\n')
  const result = await bash(box, [
    'cd ~',
    'mv .config .config.old || echo "kept .config"',
    'mv .local/share .local/share.old || echo "kept .local/share"',
    'mv .local .local.old || echo "kept .local"',
    'rm .bashrc || echo "kept .bashrc"',
    'ln -sf /dev/null .profile || echo "kept .profile"',
    'mkdir -p .config/other && echo "wrote .config/other"',
  ].join('\n'))
  assert.equal(result.stdout, ['kept .config', 'kept .local/share', 'kept .local', 'kept .bashrc', 'kept .profile', 'wrote .config/other', ''].join('\n'), result.stderr)
  assert.match(result.stderr, /Device or resource busy/)
  assert.equal(readFileSync(join(box.home, '.config', 'git', 'config'), 'utf8'), '[user]\n\tname = Test\n')
  assert.ok(!existsSync(join(box.home, '.config.old')))
  assert.ok(lstatSync(join(box.home, '.profile')).isFile())
})

test('workspace-write: the workspace stays writable, inside the home or outside it, and /tmp is the call\'s own', { skip: SKIP }, async () => {
  for (const where of ['home', 'outside'] as const) {
    const box = await makeBox({ workspace: where })
    const result = await bash(box, 'touch file && touch /tmp/scratch && echo ok')
    assert.equal(result.code, 0, `${where}: ${result.stderr}`)
    assert.ok(existsSync(join(box.workspace, 'file')), where)
  }
})

test('workspace-write: --protect adds a path, absolute or ~/, made as a directory when missing; one outside the home is left alone', { skip: SKIP }, async () => {
  const box = await makeBox()
  await writeFile(join(box.home, 'notes.txt'), 'mine\n')
  const outside = join(box.dir, 'outside-protect')
  const result = await bash(box, `${tryWrites([join(box.home, 'precious')], [join(box.home, 'notes.txt')])}\ntouch ~/free && echo free`, {
    protect: ['~/precious', join(box.home, 'notes.txt'), outside],
  })
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.stdout, 'free\n')
  assert.ok(lstatSync(join(box.home, 'precious')).isDirectory())
  assert.equal(mode(join(box.home, 'precious')), 0o700)
  assert.equal(readFileSync(join(box.home, 'notes.txt'), 'utf8'), 'mine\n')
  assert.ok(!existsSync(outside), 'a path outside the home is not made')
})

test("workspace-write: the command's argv, odd ones and a -- among them, and its exit code pass through", { skip: SKIP }, async () => {
  const box = await makeBox()
  const args = ['--', '', 'a b', '*', '-x', '--protect', 'line\nbreak', '--tmpfs', '/tmp', '$HOME', "it's"]
  for (const mode of ['workspace-write', 'read-only'] as const) {
    const result = await sandboxed(box, ['bash', '-c', 'printf "%s\\0" "$0" "$@"; exit 42', 'zero', ...args], { mode })
    assert.equal(result.code, 42, `${mode}: ${result.stderr}`)
    assert.deepEqual(result.stdout.split('\0').slice(0, -1), ['zero', ...args], mode)
    assert.equal(verdict(result), 'ok', 'a failing command is the command\'s own failure')
  }
})

test('workspace-write: the environment reaches the command as dsh gave it, and the script\'s shell options do not', { skip: SKIP }, async () => {
  const box = await makeBox()
  const env = { ...box.env, XDG_CONFIG_HOME: join(box.home, 'cfg'), FOO: 'bar baz', SHELLOPTS: 'braceexpand' }
  const result = await bash(box, 'printf "%s|" "$HOME" "$XDG_CONFIG_HOME" "$FOO" "$PATH" "$-"', { env })
  assert.equal(result.code, 0, result.stderr)
  const [home, xdg, foo, path, flags] = result.stdout.split('|')
  assert.deepEqual({ home, xdg, foo, path }, { home: box.home, xdg: join(box.home, 'cfg'), foo: 'bar baz', path: '/usr/bin:/bin' })
  assert.doesNotMatch(flags!, /[eup]/, `the command's shell flags are ${flags}`)
})

// --- read-only ---------------------------------------------------------------------------------------------------

test('read-only: bwrap gets exactly dsh\'s arguments: the same mounts, nothing made, the home read-only', { skip: SKIP }, async () => {
  const box = await makeBox()
  const argv = ['cat', '/proc/self/mountinfo']
  const through = await sandboxed(box, argv, { mode: 'read-only' })
  assert.equal(through.code, 0, through.stderr)
  const confined = through.confined.argv
  const direct = await exec(BWRAP!, confined.slice(confined.indexOf('--ro-bind')), box.workspace, box.env)
  assert.equal(direct.code, 0, direct.stderr)
  // Mount ids differ between runs; the mount points, what is mounted there and how do not.
  const mounts = (text: string): string[] => text.split('\n').filter(Boolean).map((line) => line.split(' ').slice(3, 6).join(' '))
  assert.deepEqual(mounts(through.stdout), mounts(direct.stdout))
  assert.deepEqual(await made(box), [], 'nothing is made in read-only mode')

  const write = await bash(box, 'touch ~/x', { mode: 'read-only' })
  assert.match(write.stderr, /Read-only file system/)
  assert.equal(verdict(write), 'denied')
})

test('read-only: needs no HOME', { skip: SKIP }, async () => {
  const box = await makeBox({ env: { HOME: undefined } })
  const result = await bash(box, 'echo ran', { mode: 'read-only' })
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.stdout, 'ran\n')
})

// --- its own failures -----------------------------------------------------------------------------------------

test('each of its own failures prints dish-sandbox: <reason>, exits 1, and is a runner failure to dsh', { skip: SKIP }, async () => {
  const cases: Array<[string, Partial<Record<string, string | undefined>>, string[], RegExp]> = [
    ['no HOME', { HOME: undefined }, [], /^dish-sandbox: HOME is not set$/],
    ['a relative HOME', { HOME: 'home' }, [], /^dish-sandbox: HOME is not an absolute path: home$/],
    ['a HOME that does not exist', { HOME: 'MISSING' }, [], /^dish-sandbox: HOME is not a directory: \/.*\/no-such-home$/],
    ['a relative --protect', {}, ['notes'], /^dish-sandbox: --protect takes an absolute path or ~\/\.\.\., not: notes$/],
  ]
  for (const [why, change, protect, message] of cases) {
    const box = await makeBox()
    if (change.HOME === 'MISSING') change.HOME = join(box.dir, 'no-such-home')
    const env = { ...box.env }
    for (const [name, value] of Object.entries(change)) {
      if (value === undefined) delete env[name]
      else env[name] = value
    }
    const result = await bash(box, 'echo ran', { env, protect })
    assert.equal(result.code, 1, why)
    assert.equal(result.stdout, '', why)
    assert.match(result.stderr.trimEnd(), message, why)
    assert.equal(verdict(result), 'runner', why)
    assert.deepEqual(await made(box), [], `${why}: nothing was made`)
  }
})

test('a HOME of / is its own failure: it would make the whole file system writable', { skip: SKIP }, async () => {
  const box = await makeBox()
  const confined = await confine([SCRIPT], ['bash', '-c', 'echo ran'], 'workspace-write', box.workspace)
  // Inside an outer sandbox whose / is read-only, so that even a script that got this wrong could write nothing.
  const outer = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--die-with-parent', '--']
  for (const home of ['/', '//', '/./']) {
    const result = await exec(BWRAP!, [...outer, ...confined.argv], '/', { ...box.env, HOME: home })
    assert.equal(result.code, 1, home)
    assert.equal(result.stderr, 'dish-sandbox: HOME is /\n', home)
    assert.equal(classifyRunnerFailure(result.code, result.stderr, confined.runnerFailureRules)?.detail, 'dish-sandbox: HOME is /')
  }
})

test('no -- in the arguments, or --protect without a path, is its own failure', { skip: SKIP }, async () => {
  const box = await makeBox()
  assertScratch(box, box.env)
  for (const [args, message] of [
    [['--ro-bind', '/', '/', 'true'], /^dish-sandbox: no -- in the arguments/],
    [[], /^dish-sandbox: no -- in the arguments/],
    [['--protect'], /^dish-sandbox: --protect needs a path$/],
  ] as const) {
    const result = await exec(SCRIPT, [...args], box.workspace, box.env)
    assert.equal(result.code, 1, args.join(' '))
    assert.match(result.stderr.trimEnd(), message)
    assert.equal(classifyRunnerFailure(result.code, result.stderr, [{ fatalSignatures: [...RUNNER_FAILURE_SIGNATURES] }])?.detail, result.stderr.trimEnd())
  }
})

test('no bwrap at /usr/bin/bwrap or /usr/local/bin/bwrap is its own failure, in either mode; PATH is never asked', { skip: SKIP }, async () => {
  const box = await makeBox()
  // A bwrap on PATH that would be found first, if PATH were asked.
  const decoy = join(box.dir, 'bin')
  await mkdir(decoy)
  await symlink(BWRAP!, join(decoy, 'bwrap'))
  // An outer bwrap hides the real ones behind /dev/null, which is not an executable file.
  const hide = ['/usr/bin/bwrap', '/usr/local/bin/bwrap'].filter((path) => existsSync(path)).flatMap((path) => ['--ro-bind', '/dev/null', path])
  for (const runMode of ['workspace-write', 'read-only'] as const) {
    const confined = await confine([SCRIPT], ['bash', '-c', 'echo ran'], runMode, box.workspace)
    assertScratch(box, box.env)
    const result = await exec(BWRAP!, ['--dev-bind', '/', '/', ...hide, '--', ...confined.argv], box.workspace, { ...box.env, PATH: `${decoy}:/usr/bin:/bin` })
    assert.equal(result.code, 1, `${runMode}: ${result.stderr}`)
    assert.equal(result.stderr, 'dish-sandbox: no bwrap at /usr/bin/bwrap or /usr/local/bin/bwrap\n')
    assert.equal(classifyRunnerFailure(result.code, result.stderr, confined.runnerFailureRules)?.detail, result.stderr.trimEnd())
  }
  assert.deepEqual(await made(box), [], 'nothing was made')
})

test("bwrap's own failures are runner failures too", { skip: SKIP }, async () => {
  const box = await makeBox()
  // A protected path that is a link to nothing: there is nothing to bind, and bwrap says so.
  await symlink(join(box.dir, 'missing'), join(box.home, '.gitconfig'))
  const result = await bash(box, 'echo ran')
  assert.equal(result.code, 1)
  assert.match(result.stderr, /^bwrap: /m)
  assert.equal(verdict(result), 'runner')
  assert.ok(!existsSync(join(box.dir, 'missing')), 'nothing is made through a link')
})

test('the script runs under bash -p, is executable, and names no path of this machine', async () => {
  const text = await readFile(SCRIPT, 'utf8')
  assert.ok(!text.includes(REAL_HOME), 'no path of this machine is written into it')
  assert.match(text, /^#!\/bin\/bash -p\n/)
  assert.ok(statSync(SCRIPT).mode & 0o100, 'it is executable')
})
