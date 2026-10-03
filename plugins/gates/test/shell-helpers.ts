/**
 * dsh's real shell stack for dish-gates' tests, composed in a fresh `Context` from the packages dish-gates declares as
 * devDependencies, as dsh-base mounts them: `dsh-subprocess-local`, `dsh-sandbox-local` (with or without
 * `deploy/dish-sandbox` as its `runnerCommand`), `dsh-session-projection`, `dsh-sandbox-policy` and `dsh-bash-sandbox`,
 * which registers as `ctx.shell`.
 *
 * A gate's environment is dsh's own process environment, scrubbed. So every run here is inside `withEnv` with a scratch
 * `HOME`, `HISTFILE`, the four XDG base directories, `DSH_HOME`, `DSH_DISH_HOME` and a git without the system config,
 * all under the test's temp directory: nothing a gate runs sees the runner's home. `SKIP` says why the real-shell tests
 * can't run here (no bwrap, or a bwrap that can't make a sandbox), decided as `deploy/test/dish-sandbox.test.ts` does.
 *
 * @module dish-gates/test/shell-helpers
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import BashSandbox from '@deepseek-ai/dsh-bash-sandbox'
import SandboxLocal from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjection from '@deepseek-ai/dsh-session-projection'
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import { RUNNER_FAILURE_SIGNATURES } from '../../../deploy/profile.ts'
import type { ShellLike } from '../src/run.ts'
import { makeClone, scratchHome, tempDir, withEnv } from './helpers.ts'

/** The checkout this test runs from. */
export const ROOT = fileURLToPath(new URL('../../..', import.meta.url))
/** dish's sandbox runner, as the VM's `sandbox` row names it. */
export const DISH_SANDBOX = join(ROOT, 'deploy', 'dish-sandbox')

const BWRAP = ['/usr/bin/bwrap', '/usr/local/bin/bwrap'].find(path => existsSync(path))

/** Whether bwrap can make dsh's read-only sandbox here, as dsh's own probe asks it (with a scratch HOME). */
function bwrapWorks(bwrap: string): boolean {
  const home = mkdtempSync(join(tmpdir(), 'dish-gates-probe-'))
  try {
    const probe = spawnSync(bwrap, ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent', '--', 'true'], {
      env: { PATH: '/usr/bin:/bin', HOME: home }, stdio: 'ignore', timeout: 10_000,
    })
    return probe.status === 0
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

/** Why the real-shell tests are skipped here, or false when they run. */
export const SKIP: string | false = BWRAP === undefined
  ? 'no bwrap at /usr/bin/bwrap or /usr/local/bin/bwrap'
  : bwrapWorks(BWRAP) ? false : 'bwrap cannot make a sandbox here (user namespaces?)'

export interface ComposedShell {
  shell: ShellLike
  dispose(): Promise<void>
}

/** dsh's stack in a fresh Context, waiting for `ctx.shell`. `runner` is the `sandbox` row's `runnerCommand`, if any. */
export async function composeShell(options: { workspaceRoot: string, runner?: string[] }): Promise<ComposedShell> {
  const ctx = new Context()
  const sandbox = options.runner === undefined
    ? {}
    : { runnerCommand: options.runner, runnerFailureSignatures: [...RUNNER_FAILURE_SIGNATURES] }
  const fibers = [
    ctx.plugin(SubprocessLocal),
    ctx.plugin(SandboxLocal, sandbox),
    ctx.plugin(SessionProjection),
    ctx.plugin(SandboxPolicy, { mode: 'workspace-write', workspaceRoot: options.workspaceRoot }),
    ctx.plugin(BashSandbox, { cwd: options.workspaceRoot }),
  ]
  const dispose = async (): Promise<void> => {
    for (const fiber of [...fibers].reverse()) await fiber.dispose()
  }
  try {
    for (const fiber of fibers) await fiber
    for (let i = 0; i < 250 && ctx.get('shell') === undefined; i++) await new Promise(resolve => setTimeout(resolve, 20))
    const shell = ctx.get('shell')
    if (shell === undefined) throw new Error('dsh\'s shell stack never provided ctx.shell')
    return { shell, dispose }
  } catch (error) {
    await dispose()
    throw error
  }
}

/** The scratch process environment a real-shell test runs dsh's stack in: everything under `dir`. */
export function scratchShellEnv(dir: string, home: string): Record<string, string> {
  return {
    HOME: home,
    HISTFILE: join(home, '.bash_history'),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    XDG_CACHE_HOME: join(home, '.cache'),
    DSH_HOME: join(dir, 'dsh-home'),
    DSH_DISH_HOME: join(dir, 'instance'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
    GIT_TERMINAL_PROMPT: '0',
    // Set here so a test can tell dsh's own values from anything dish-gates might set: a gate must see these as they are.
    GOPATH: join(home, 'go'),
    npm_config_cache: join(home, '.npm'),
    CARGO_HOME: join(home, '.cargo'),
  }
}

export interface ShellWorld {
  shell: ShellLike
  /** The test's temp directory: the clone, the home and everything else are under it. */
  dir: string
  /** The scratch HOME the stack (and so the gate) runs with. */
  home: string
  clone: string
  worktree: string
  /** What `withEnv` set for the body. */
  vars: Record<string, string>
}

/**
 * A temp directory with `makeClone`'s clone and worktree, the scratch environment set, and dsh's stack composed with the
 * clone as its workspace root; `runner: true` puts `deploy/dish-sandbox` in as the runner, a list puts that in. `env`
 * adds to the scratch environment, or with `undefined` unsets a name. The stack is disposed and the environment put back
 * however `body` ends.
 */
export async function withRealShell(
  options: { runner?: true | string[], env?: Record<string, string | undefined> },
  body: (world: ShellWorld) => Promise<void>,
): Promise<void> {
  const dir = await tempDir()
  const { clone, worktree } = await makeClone(dir)
  const home = await scratchHome(dir)
  const vars = scratchShellEnv(dir, home)
  const runner = options.runner === true ? [DISH_SANDBOX] : options.runner
  await withEnv({ ...vars, ...options.env }, async () => {
    const composed = await composeShell({ workspaceRoot: clone, ...(runner === undefined ? {} : { runner }) })
    try {
      await body({ shell: composed.shell, dir, home, clone, worktree, vars })
    } finally {
      await composed.dispose()
    }
  })
}

/** The host PIDs whose command line holds `marker` (a process inside bwrap's PID namespace has another PID there). */
export async function processesWith(marker: string): Promise<number[]> {
  const found: number[] = []
  for (const name of await readdir('/proc')) {
    if (!/^\d+$/.test(name)) continue
    const cmdline = await readFile(join('/proc', name, 'cmdline'), 'utf8').catch(() => '')
    if (cmdline.includes(marker)) found.push(Number(name))
  }
  return found
}

/** Wait up to `ms` for no process to hold `marker`; gives what is still there then. */
export async function goneWithin(marker: string, ms: number): Promise<number[]> {
  const until = Date.now() + ms
  for (;;) {
    const left = await processesWith(marker)
    if (left.length === 0 || Date.now() >= until) return left
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}
