/**
 * Helpers for dish-workspaces' tests.
 *
 * Nothing here may touch the real `~/.gitconfig`, `/etc/gitconfig` or the real home:
 * - every git a test starts itself (`run`, `runOk`, `makeBare`, `makeClone`) gets `scratchGitEnv`: a scratch `HOME`
 *   holding a test identity, `GIT_CONFIG_NOSYSTEM=1` and `GIT_CONFIG_GLOBAL` in that home; `run` refuses an
 *   environment without a `HOME`;
 * - the code under test reads `process.env` (its git drops every `GIT_*` name), so a test gives it a scratch home with
 *   `withEnv(dishHome(dir), …)`, and passes `NOSYSTEM` as the call's own `env` where it can.
 *
 * @module dish-workspaces/test/helpers
 */

import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after } from 'node:test'

/** The identity every scratch git commits as. */
export const TEST_IDENTITY = { name: 'Dish Test', email: 'dish-test@example.invalid' } as const

/** For the `env` of a call to the code's `git()`: no system config. (`process.env`'s `GIT_*` names never reach it.) */
export const NOSYSTEM: Record<string, string> = { GIT_CONFIG_NOSYSTEM: '1' }

const made: string[] = []

after(async () => {
  await Promise.all(made.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/** A fresh empty directory under the OS temp directory (its real path), removed when the test file finishes. */
export async function tempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'dish-workspaces-')))
  made.push(dir)
  return dir
}

/**
 * Run `body` with `vars` set in this process (an `undefined` value unsets the name), and put every name back as it
 * was. DSH_DISH_HOME is always unset for the body: it moves dish's directories ahead of HOME and XDG_*, so one inherited
 * from a `pnpm dev` shell would point the code under test at a real instance.
 */
export async function withEnv<T>(vars: Record<string, string | undefined>, body: () => Promise<T>): Promise<T> {
  const names = [...new Set([...Object.keys(vars), 'DSH_DISH_HOME'])]
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]))
  delete process.env.DSH_DISH_HOME
  for (const [name, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  try {
    return await body()
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

/** The names a scratch git must not inherit from the test runner's environment. */
function inherited(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    const upper = name.toUpperCase()
    if (upper.startsWith('GIT_') || upper.startsWith('DSH_') || /KEY|PASSWORD|SECRET|TOKEN/i.test(name)) continue
    env[name] = value
  }
  return env
}

/** `<dir>/home`, with a `.gitconfig` holding the test identity unless one is there already (a test may have added to it). */
async function scratchHome(dir: string): Promise<string> {
  const home = join(dir, 'home')
  await mkdir(join(home, '.config'), { recursive: true })
  const config = [
    '[user]', `\tname = ${TEST_IDENTITY.name}`, `\temail = ${TEST_IDENTITY.email}`,
    '[init]', '\tdefaultBranch = main',
    '[advice]', '\tdetachedHead = false',
    '',
  ].join('\n')
  await writeFile(join(home, '.gitconfig'), config, { flag: 'wx' }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error
  })
  return home
}

/**
 * The environment for a git a test starts itself: the runner's (minus `GIT_*`, `DSH_*`, credential-shaped names and `SSH_ASKPASS*`),
 * `HOME=<dir>/home` with a test identity in its `.gitconfig`, `XDG_CONFIG_HOME` under it, `GIT_CONFIG_NOSYSTEM=1`,
 * `GIT_CONFIG_GLOBAL=<dir>/home/.gitconfig` and `GIT_TERMINAL_PROMPT=0`.
 */
export async function scratchGitEnv(dir: string): Promise<Record<string, string>> {
  const home = await scratchHome(dir)
  // No GUI password prompt either: a desktop's SSH_ASKPASS (with a DISPLAY) would let a test git that tries to prompt
  // open a dialog. GIT_ASKPASS is already gone with the other GIT_* names.
  const { SSH_ASKPASS: _askpass, SSH_ASKPASS_REQUIRE: _require, ...rest } = inherited()
  return {
    ...rest,
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
    GIT_TERMINAL_PROMPT: '0',
  }
}

/** For `withEnv`: the same scratch home for the code under test (`HOME` and `XDG_CONFIG_HOME`; git reads both). */
export async function dishHome(dir: string): Promise<Record<string, string>> {
  const home = await scratchHome(dir)
  return { HOME: home, XDG_CONFIG_HOME: join(home, '.config') }
}

export interface RunOptions {
  cwd?: string
  /** The whole environment of the command. It must name a `HOME` (a scratch one): nothing a test starts sees the real home. */
  env: Record<string, string>
  input?: string
}

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

/** Run `cmd` with `args` (no shell) and collect its output. Rejects only when it can't be started. */
export function run(cmd: string, args: readonly string[], options: RunOptions): Promise<RunResult> {
  if (options.env.HOME === undefined || options.env.HOME === '') {
    return Promise.reject(new Error(`run(${cmd}): give the command a scratch HOME`))
  }
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', code => resolve({ code: code ?? -1, stdout, stderr }))
    if (options.input !== undefined) {
      child.stdin?.on('error', () => {})
      child.stdin?.end(options.input)
    }
  })
}

/** `run`, failing on a non-zero exit with the command's stderr. Returns stdout. */
export async function runOk(cmd: string, args: readonly string[], options: RunOptions): Promise<string> {
  const result = await run(cmd, args, options)
  if (result.code !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (exit ${result.code}): ${result.stderr.trim()}`)
  return result.stdout
}

/**
 * A bare repository at `dir` (made, with its parents) whose `main` has one commit holding `files` (paths relative to
 * the repository, made with their directories). Built in a scratch work tree by a scratch git. Returns `dir`.
 */
export async function makeBare(dir: string, files: Record<string, string> = { 'README.md': '# test\n' }): Promise<string> {
  const scratch = await tempDir()
  const env = await scratchGitEnv(scratch)
  const work = join(scratch, 'work')
  await runOk('git', ['init', '-q', '-b', 'main', work], { env })
  for (const [name, text] of Object.entries(files)) {
    await mkdir(dirname(join(work, name)), { recursive: true })
    await writeFile(join(work, name), text)
  }
  await runOk('git', ['add', '-A'], { cwd: work, env })
  await runOk('git', ['commit', '-q', '--allow-empty', '-m', 'first'], { cwd: work, env })
  await mkdir(dirname(dir), { recursive: true })
  await runOk('git', ['clone', '-q', '--bare', work, dir], { env })
  return dir
}

export interface Clone {
  /** The bare repository the clone came from. */
  bare: string
  /** Its `file://` URL: the clone's `remote.origin.url`. */
  url: string
  /** The clone (a work tree with `.git` a directory). */
  clone: string
  /** `scratchGitEnv` for gits the test starts in it. */
  env: Record<string, string>
}

/** `makeBare` under `dir`, and a clone of it (by a scratch git) at `<dir>/clone`. */
export async function makeClone(dir: string, files?: Record<string, string>): Promise<Clone> {
  const bare = await makeBare(join(dir, 'origin.git'), files)
  const env = await scratchGitEnv(dir)
  const url = `file://${bare}`
  const clone = join(dir, 'clone')
  await runOk('git', ['clone', '-q', url, clone], { env })
  return { bare, url, clone, env }
}
