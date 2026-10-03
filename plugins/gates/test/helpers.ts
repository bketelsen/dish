/**
 * Helpers for dish-gates' tests.
 *
 * Nothing here may touch the real `~/.gitconfig`, `/etc/gitconfig` or the real home:
 * - every git a test starts itself (`run`, `runOk`, `makeClone`) gets `scratchGitEnv`: a scratch `HOME` holding a test
 *   identity, `GIT_CONFIG_NOSYSTEM=1` and `GIT_CONFIG_GLOBAL` in that home; `run` refuses an environment without a
 *   `HOME`;
 * - code under test that reads `process.env` (dsh's shell stack gives a gate dsh's own environment) gets scratch values
 *   with `withEnv`, which also always clears `DSH_DISH_HOME` unless the test sets it.
 *
 * @module dish-gates/test/helpers
 */

import { spawn } from 'node:child_process'
import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after } from 'node:test'

/** The identity every scratch git commits as. */
export const TEST_IDENTITY = { name: 'Dish Test', email: 'dish-test@example.invalid' } as const

const made: string[] = []

after(async () => {
  await Promise.all(made.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/** A fresh empty directory under the OS temp directory (its real path), removed when the test file finishes. */
export async function tempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'dish-gates-')))
  made.push(dir)
  return dir
}

/**
 * Run `body` with `vars` set in this process (an `undefined` value unsets the name), and put every name back as it
 * was. DSH_DISH_HOME is always cleared for the body unless `vars` sets it: it moves dish's directories ahead of HOME
 * and XDG_*, so one inherited from a `pnpm dev` shell would point the code under test at a real instance.
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

/** `<dir>/home`, with a `.gitconfig` holding the test identity unless one is there already. */
export async function scratchHome(dir: string): Promise<string> {
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
 * The environment for a git a test starts itself: the runner's (minus `GIT_*`, `DSH_*`, credential-shaped names and
 * `SSH_ASKPASS*`), `HOME=<dir>/home` with a test identity in its `.gitconfig`, `XDG_CONFIG_HOME` under it,
 * `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=<dir>/home/.gitconfig` and `GIT_TERMINAL_PROMPT=0`.
 */
export async function scratchGitEnv(dir: string): Promise<Record<string, string>> {
  const home = await scratchHome(dir)
  const { SSH_ASKPASS: _askpass, SSH_ASKPASS_REQUIRE: _require, ...rest } = inherited()
  return {
    ...rest,
    HOME: home,
    HISTFILE: join(home, '.bash_history'),
    XDG_CONFIG_HOME: join(home, '.config'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
    GIT_TERMINAL_PROMPT: '0',
  }
}

export interface RunOptions {
  cwd?: string
  /** The whole environment of the command. It must name a `HOME` (a scratch one): nothing a test starts sees the real home. */
  env: Record<string, string>
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
    const child = spawn(cmd, [...args], { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', code => resolve({ code: code ?? -1, stdout, stderr }))
  })
}

/** `run`, failing on a non-zero exit with the command's stderr. Returns stdout. */
export async function runOk(cmd: string, args: readonly string[], options: RunOptions): Promise<string> {
  const result = await run(cmd, args, options)
  if (result.code !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (exit ${result.code}): ${result.stderr.trim()}`)
  return result.stdout
}

export interface Clone {
  /** The clone, its real path. */
  clone: string
  /** Its worktree `.worktrees/fix-1` on `dish/fix-1`, its real path. */
  worktree: string
  /** `scratchGitEnv(dir)`, for gits the test starts in it. */
  env: Record<string, string>
}

/**
 * A clone at `<dir>/clone`, as dish lays one out: `git init -b main`, one commit, `.worktrees/` in
 * `.git/info/exclude`, and `git worktree add --no-track -b dish/fix-1 .worktrees/fix-1`. Made by a scratch git.
 */
export async function makeClone(dir: string): Promise<Clone> {
  const env = await scratchGitEnv(dir)
  const clone = join(dir, 'clone')
  await runOk('git', ['init', '-q', '-b', 'main', clone], { env })
  await writeFile(join(clone, 'README.md'), '# test\n')
  await runOk('git', ['add', '-A'], { cwd: clone, env })
  await runOk('git', ['commit', '-q', '-m', 'first'], { cwd: clone, env })
  await appendFile(join(clone, '.git', 'info', 'exclude'), '.worktrees/\n')
  await runOk('git', ['worktree', 'add', '-q', '--no-track', '-b', 'dish/fix-1', '.worktrees/fix-1'], { cwd: clone, env })
  return { clone: await realpath(clone), worktree: await realpath(join(clone, '.worktrees', 'fix-1')), env }
}
