/**
 * A fake VM for `deploy/update.sh`: a bare repo standing in for GitHub, a clone of it as the account's checkout, the
 * account's home with its `~/.config/dish` inputs, and stub commands for everything that would reach the real system.
 *
 * update.sh runs only as the account; as root, fleet's dish-update wrapper runs it through runuser. So a run here is the
 * account's by default, and `as: 'root'` or `as: 'other'` is someone it must refuse. `runuser` is stubbed only so that a
 * call to it would be seen.
 *
 * Nothing a script does here can reach the real machine:
 * - `id`, `getent`, `runuser`, `systemctl`, `journalctl`, `curl` and `pnpm` are stubs, first on the PATH of the
 *   checkout's unit, which is the PATH update.sh runs everything with. createHost checks that each name resolves to its
 *   stub before any test runs a script.
 * - The account's uid is made up, so `XDG_RUNTIME_DIR=/run/user/<uid>` names no directory. A real `systemctl --user`
 *   that slipped through could not reach a user manager.
 * - The account's home, and every path the scripts write, is inside the host's temp directory.
 * `git`, `flock`, `stat`, `sha256sum` and `node` are real. The account is the user running the tests, since it owns the
 * checkout; the stubs answer for it.
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

/** The account's uid on the fake host. Made up, so that /run/user/<uid> doesn't exist. */
export const UID = 54321

/** The commands the fake host replaces. */
export const STUBBED = ['id', 'getent', 'runuser', 'systemctl', 'journalctl', 'curl', 'pnpm']

/** What the caller's environment carries on every run, and what update.sh must keep from install.sh. */
export const LEAKED = ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'PNPM_HOME', 'DSH_HOME', 'DSH_DISH_HOME', 'NODE_ENV']

export const INPUTS = {
  DISH_REMOTE: 'git@github-dish-config:example/dish-config.git',
  DISH_USER_NAME: 'Dish Test',
  DISH_USER_EMAIL: 'dish-test@example.invalid',
}

/** install.env as fleet writes it. */
export const INSTALL_ENV = `# Managed by fleet (test host). update.sh reads this; the unit never loads it.
DISH_REMOTE=${INPUTS.DISH_REMOTE}
DISH_USER_NAME=${INPUTS.DISH_USER_NAME}
DISH_USER_EMAIL=${INPUTS.DISH_USER_EMAIL}
`

export const DEPLOY_ENV = 'DISH_TRUSTED_HOST=dish.example.ts.net\n'

export const PNPM_VERSION = '11.25.0'

const JOURNAL = [
  '2026-10-02T10:00:00+00:00 dish dsh[4242]: dish-config: the store is ready',
  '2026-10-02T10:00:01+00:00 dish dsh[4242]: listening on 127.0.0.1:3080',
]

export interface HostOptions {
  /** Who runs the script: the account (the default, as fleet's dish-update wrapper does), root, or another user. */
  as?: 'root' | 'account' | 'other'
  /** Set the service's state before the run. Without these, it stays as earlier runs left it: a new host has it active and not enabled. */
  active?: boolean
  enabled?: boolean
  /** Whether the account's user manager answers at all. Default up. */
  manager?: 'up' | 'down'
  /** Make `systemctl --user daemon-reload` fail in this run. */
  reloadFails?: boolean
  /** Make the user manager hold an older definition of the unit than the installed file, so it needs a daemon-reload. */
  needDaemonReload?: boolean
  /** Whether `systemctl show -p NeedDaemonReload` answers. Default true; false prints nothing, as if it didn't know. */
  reportsReload?: boolean
  /** Whether 127.0.0.1:3080 answers: always, never, or only once the service has restarted during this run. Default up. */
  curl?: 'up' | 'down' | 'after-restart'
  pnpmVersion?: string
  /** Lines the stub install.sh prints before its last line. */
  installOutput?: string[]
  /** The stub install.sh's last line. Default `install: no changes to the profile`. */
  installLastLine?: string
  installExit?: number
  journal?: string[]
  /** A string writes the file, null removes it, and undefined leaves it as it is. */
  installEnv?: string | null
  deployEnv?: string | null
  /** DISH_UPDATE_WAIT, in seconds. Unset by default. */
  wait?: number
  /** More variables for the run's environment. */
  env?: Record<string, string>
  /** Run with exactly what fleet's dish-update wrapper passes (env -i, then HOME, USER, LOGNAME, XDG_RUNTIME_DIR, PATH). */
  wrapper?: boolean
}

export interface Result {
  code: number
  stdout: string
  stderr: string
}

/** What the stub user manager holds. */
export interface Service {
  active: boolean
  enabled: boolean
  /** Restarts so far. */
  starts: number
  /** The unit file's text at the last daemon-reload; null before any. */
  loaded: string | null
  /** The definition the service last started with: `loaded` at the last restart. */
  startedWith: string | null
}

export interface Install {
  /** Every DISH_* variable install.sh saw, with its value. */
  env: Record<string, string>
  /** The name of every variable install.sh saw, sorted. */
  names: string[]
  /** install.sh's TMPDIR, and its mode when it is a directory (null when it isn't one). */
  tmpdir: string | undefined
  tmpdirMode: number | null
}

export interface Host {
  dir: string
  home: string
  bare: string
  checkout: string
  stubs: string
  /** The account: the user who owns the checkout. */
  owner: string
  /** The PATH line of the seed's unit, and the PATH every run starts with. */
  unitPath: string
  /** The seed commit. */
  seed: string
  /** Commit files (null deletes) on main in a separate upstream clone and push; returns the new sha. */
  commit(files: Record<string, string | null>, message: string): Promise<string>
  run(script: 'update.sh' | 'url.sh', args: string[], options?: HostOptions): Promise<Result>
  /** Each stub's argv per call, from <dir>/calls/<name>.jsonl. */
  calls(name: string): string[][]
  /** What the stub install.sh saw: its DISH_* values and the names of every other variable. */
  installs(): Install[]
  head(): Promise<string>
  stamp(): string | undefined
  installedUnit(): string | undefined
  service(): Service
}

const hosts: string[] = []

/** Remove every host made so far. */
export async function removeHosts(): Promise<void> {
  await Promise.all(hosts.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
}

/** git with no user or system configuration, so a test machine's hooks, signing or default branch play no part. */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: cwd,
      LANG: 'C',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Host Test',
      GIT_AUTHOR_EMAIL: 'host-test@example.invalid',
      GIT_COMMITTER_NAME: 'Host Test',
      GIT_COMMITTER_EMAIL: 'host-test@example.invalid',
    },
  })
  return stdout
}

/** The code each stub runs after recording its argv. `argv`, `config`, `state()`, `save()` and `fail()` are in scope. */
const STUB_BODIES: Record<string, string> = {
  id: `
    if (argv.length === 1 && argv[0] === '-u') console.log(config.as === 'root' ? '0' : config.as === 'other' ? '4242' : String(config.uid))
    else fail()
  `,
  getent: `
    if (argv.length === 2 && argv[0] === 'passwd' && argv[1] === config.owner) {
      console.log([config.owner, 'x', config.uid, config.uid, '', config.home, '/bin/bash'].join(':'))
    } else {
      process.exit(2)
    }
  `,
  runuser: `
    if (argv.length < 4 || argv[0] !== '-u' || argv[2] !== '--') fail()
    const { spawnSync } = process.getBuiltinModule('node:child_process')
    const { constants } = process.getBuiltinModule('node:os')
    const result = spawnSync(argv[3], argv.slice(4), { stdio: 'inherit' })
    process.exit(result.status ?? 128 + (constants.signals[result.signal] ?? 0))
  `,
  systemctl: `
    if (config.manager === 'down') {
      console.error('Failed to connect to bus: No such file or directory')
      process.exit(1)
    }
    const verbs = ['is-active', 'is-enabled', 'restart', 'enable', 'daemon-reload', 'show']
    const verb = argv.find((arg) => verbs.includes(arg))
    const s = state()
    const unitFile = config.home + '/.config/systemd/user/dish-web.service'
    const installed = fs.existsSync(unitFile) ? fs.readFileSync(unitFile, 'utf8') : null
    if (verb === 'is-active') {
      console.log(s.active ? 'active' : 'inactive')
      process.exit(s.active ? 0 : 3)
    } else if (verb === 'is-enabled') {
      console.log(s.enabled ? 'enabled' : 'disabled')
      process.exit(s.enabled ? 0 : 1)
    } else if (verb === 'restart') {
      s.active = true
      s.starts += 1
      s.startedWith = s.loaded
      save(s)
    } else if (verb === 'enable') {
      s.enabled = true
      save(s)
    } else if (verb === 'daemon-reload') {
      if (config.reloadFails) {
        console.error('Failed to reload daemon: Connection timed out')
        process.exit(1)
      }
      s.loaded = installed
      save(s)
    } else if (verb === 'show' && argv.includes('NeedDaemonReload')) {
      if (config.reportsReload) console.log(installed !== null && installed !== s.loaded ? 'yes' : 'no')
    } else if (verb === 'show') {
      console.log('MainPID=' + (s.active ? 4242 : 0))
      console.log('ExecMainStartTimestamp=' + (s.active ? 'Fri 2026-10-02 10:00:00 UTC' : ''))
    } else {
      fail()
    }
  `,
  journalctl: `
    for (const line of config.journal) console.log(line)
  `,
  curl: `
    const up = config.curl === 'up' || (config.curl === 'after-restart' && state().starts > config.startsBefore)
    process.stdout.write(up ? '200' : '000')
    process.exit(up ? 0 : 7)
  `,
  pnpm: `
    if (argv.length === 1 && argv[0] === '--version') console.log(config.pnpmVersion)
    else fail()
  `,
}

/** A stub: record argv, then act from <dir>/config.json and <dir>/state.json. Runs as either module type. */
function stubSource(dir: string, name: string): string {
  return `#!${process.execPath}
const fs = process.getBuiltinModule('node:fs')
const dir = ${JSON.stringify(dir)}
const argv = process.argv.slice(2)
fs.appendFileSync(dir + '/calls/${name}.jsonl', JSON.stringify(argv) + '\\n')
const config = JSON.parse(fs.readFileSync(dir + '/config.json', 'utf8'))
const state = () => JSON.parse(fs.readFileSync(dir + '/state.json', 'utf8'))
const save = (value) => fs.writeFileSync(dir + '/state.json', JSON.stringify(value))
const fail = () => {
  console.error('${name} stub: unexpected arguments: ' + argv.join(' '))
  process.exit(64)
}
${STUB_BODIES[name]}
`
}

/**
 * The stub install.sh, committed in the seed: it records what it was given, then prints the configured last line. It
 * finds node on the PATH it was given, as the real one does.
 */
function installSource(dir: string): string {
  return `#!/usr/bin/env node
const fs = process.getBuiltinModule('node:fs')
const dir = ${JSON.stringify(dir)}
const env = {}
for (const [name, value] of Object.entries(process.env)) if (name.startsWith('DISH_')) env[name] = value
const tmpdir = process.env.TMPDIR
let tmpdirMode = null
try { const stat = fs.statSync(tmpdir); if (stat.isDirectory()) tmpdirMode = stat.mode & 0o777 } catch {}
fs.appendFileSync(dir + '/calls/install.jsonl', JSON.stringify({ env, names: Object.keys(process.env).sort(), tmpdir, tmpdirMode }) + '\\n')
const config = JSON.parse(fs.readFileSync(dir + '/config.json', 'utf8'))
console.log('install: pnpm install --frozen-lockfile')
for (const line of config.installOutput) console.log(line)
if (config.installExit !== 0) {
  console.error('install: FAILED at step: pnpm build (exit ' + config.installExit + ')')
  process.exit(config.installExit)
}
console.log(config.installLastLine)
`
}

function unitSource(unitPath: string): string {
  return `[Unit]
Description=dsh web for dish (test host)

[Service]
WorkingDirectory=%h/work
EnvironmentFile=%h/.config/dish/deploy.env
Environment=PATH=${unitPath}
ExecStart=%h/dish/node_modules/.bin/dsh web --host 127.0.0.1 --port 3080 --no-open --trusted-host \${DISH_TRUSTED_HOST}
Restart=on-failure

[Install]
WantedBy=default.target
`
}

function readIfExists(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined
}

function readLines(path: string): string[] {
  const text = readIfExists(path) ?? ''
  return text.split('\n').filter((line) => line !== '')
}

export async function createHost(): Promise<Host> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'dish-update-test-')))
  hosts.push(dir)
  const home = join(dir, 'home')
  const bare = join(dir, 'bare.git')
  const upstream = join(dir, 'upstream')
  const checkout = join(home, 'dish')
  const stubs = join(dir, 'stubs')
  const owner = userInfo().username
  const unitPath = `${stubs}:${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`

  for (const path of [stubs, join(dir, 'calls'), join(dir, 'elsewhere'), join(home, '.config', 'dish')]) {
    await mkdir(path, { recursive: true })
  }
  for (const name of STUBBED) await writeFile(join(stubs, name), stubSource(dir, name), { mode: 0o755 })
  await writeFile(join(dir, 'state.json'), JSON.stringify({ active: true, enabled: false, starts: 0, loaded: null, startedWith: null }))

  // The stubs must win: each stubbed name resolves to its stub on the unit's PATH.
  for (const name of STUBBED) {
    const { stdout } = await execFileAsync('bash', ['-c', 'command -v -- "$1"', 'bash', name], { env: { PATH: unitPath, HOME: join(dir, 'elsewhere') } })
    assert.equal(stdout.trim(), join(stubs, name), `${name} resolves to its stub`)
  }

  // The seed: the real scripts, a stub install.sh and a minimal unit.
  await git(dir, 'init', '--quiet', '--bare', '--initial-branch=main', bare)
  await git(dir, 'clone', '--quiet', bare, upstream)
  await mkdir(join(upstream, 'deploy'), { recursive: true })
  for (const script of ['update.sh', 'url.sh']) {
    const source = join(ROOT, 'deploy', script)
    if (existsSync(source)) await copyFile(source, join(upstream, 'deploy', script))
  }
  await writeFile(join(upstream, 'deploy', 'install.sh'), installSource(dir), { mode: 0o755 })
  await writeFile(join(upstream, 'deploy', 'dish-web.service'), unitSource(unitPath))
  await writeFile(join(upstream, '.gitignore'), 'node_modules/\n.dev/\n')
  await writeFile(join(upstream, 'README.md'), 'the seed\n')
  await git(upstream, 'add', '--all')
  await git(upstream, 'commit', '--quiet', '--message', 'seed')
  await git(upstream, 'push', '--quiet', 'origin', 'main')
  const seed = (await git(upstream, 'rev-parse', 'HEAD')).trim()

  await git(dir, 'clone', '--quiet', bare, checkout)
  await writeFile(join(home, '.config', 'dish', 'install.env'), INSTALL_ENV, { mode: 0o600 })
  await writeFile(join(home, '.config', 'dish', 'deploy.env'), DEPLOY_ENV, { mode: 0o600 })

  const host: Host = {
    dir,
    home,
    bare,
    checkout,
    stubs,
    owner,
    unitPath,
    seed,

    async commit(files, message) {
      for (const [path, content] of Object.entries(files)) {
        const target = join(upstream, path)
        if (content === null) {
          await rm(target, { force: true })
        } else {
          await mkdir(dirname(target), { recursive: true })
          await writeFile(target, content)
        }
      }
      await git(upstream, 'add', '--all')
      await git(upstream, 'commit', '--quiet', '--message', message)
      await git(upstream, 'push', '--quiet', 'origin', 'main')
      return (await git(upstream, 'rev-parse', 'HEAD')).trim()
    },

    async run(script, args, options = {}) {
      const state = host.service()
      if (options.active !== undefined) state.active = options.active
      if (options.enabled !== undefined) state.enabled = options.enabled
      if (options.needDaemonReload) state.loaded = '# an older definition\n'
      await writeFile(join(dir, 'state.json'), JSON.stringify(state))
      const config = {
        owner,
        uid: UID,
        home,
        as: options.as ?? 'account',
        manager: options.manager ?? 'up',
        reloadFails: options.reloadFails ?? false,
        reportsReload: options.reportsReload ?? true,
        curl: options.curl ?? 'up',
        startsBefore: state.starts,
        pnpmVersion: options.pnpmVersion ?? PNPM_VERSION,
        installOutput: options.installOutput ?? [],
        installLastLine: options.installLastLine ?? 'install: no changes to the profile',
        installExit: options.installExit ?? 0,
        journal: options.journal ?? JOURNAL,
      }
      await writeFile(join(dir, 'config.json'), JSON.stringify(config))
      for (const [name, content] of [['install.env', options.installEnv], ['deploy.env', options.deployEnv]] as const) {
        const path = join(home, '.config', 'dish', name)
        if (content === null) await rm(path, { force: true })
        else if (content !== undefined) await writeFile(path, content, { mode: 0o600 })
      }

      // A small environment of the test's own making, never the test runner's: HOME is somewhere else than the account's
      // home, and the variables update.sh must keep from install.sh are all set.
      const env: NodeJS.ProcessEnv = options.wrapper ? { PATH: unitPath, HOME: home, USER: owner, LOGNAME: owner, XDG_RUNTIME_DIR: `/run/user/${UID}` } : {
        PATH: unitPath,
        HOME: join(dir, 'elsewhere'),
        LANG: 'C.UTF-8',
        XDG_CONFIG_HOME: join(dir, 'leaked', 'config'),
        XDG_DATA_HOME: join(dir, 'leaked', 'data'),
        PNPM_HOME: join(dir, 'leaked', 'pnpm'),
        DSH_HOME: join(dir, 'leaked', 'dsh'),
        DSH_DISH_HOME: join(dir, 'leaked', 'dish'),
        NODE_ENV: 'production',
        ...options.env,
      }
      if (options.wait !== undefined) env.DISH_UPDATE_WAIT = String(options.wait)

      try {
        const { stdout, stderr } = await execFileAsync(join(checkout, 'deploy', script), args, { cwd: dir, env, encoding: 'utf8', timeout: 50_000 })
        return { code: 0, stdout, stderr }
      } catch (error) {
        const failure = error as { code?: unknown, stdout?: string, stderr?: string }
        return { code: typeof failure.code === 'number' ? failure.code : -1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
      }
    },

    calls(name) {
      return readLines(join(dir, 'calls', `${name}.jsonl`)).map((line) => JSON.parse(line) as string[])
    },

    installs() {
      return readLines(join(dir, 'calls', 'install.jsonl')).map((line) => JSON.parse(line) as Install)
    },

    async head() {
      return (await git(checkout, 'rev-parse', 'HEAD')).trim()
    },

    stamp() {
      return readIfExists(join(home, '.local', 'state', 'dish', 'deploy', 'started'))
    },

    installedUnit() {
      return readIfExists(join(home, '.config', 'systemd', 'user', 'dish-web.service'))
    },

    service() {
      return JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as Service
    },
  }
  return host
}
