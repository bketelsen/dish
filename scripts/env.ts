/**
 * The launcher for root package scripts that run dsh: `node scripts/env.ts <command> [args...]`.
 *
 * dish has two configurations, and dev is the default.
 *
 * - **dev** (unset, empty or `DISH_ENV=dev`): dsh's home and every dish directory live in the checkout's git-ignored
 *   `.dev/`. The launcher sets `DSH_HOME=<checkout>/.dev/dsh`, `DSH_DISH_HOME=<checkout>/.dev` and `DISH_ENV=dev`,
 *   replacing inherited values (dsh gives every agent shell a `DSH_HOME` of its own, and the agent's `pnpm dsh` must
 *   not follow it).
 * - **prod** (`DISH_ENV=prod`): the environment passes through. Only the VM's service is prod, and it does not come
 *   here: its unit runs the checkout's dsh binary directly with the account's defaults, because dsh hands its own
 *   environment to every agent shell and a `DISH_ENV=prod` on the service would make every agent's `pnpm dsh` prod.
 * - Any other `DISH_ENV` is refused.
 *
 * Both modes put the checkout's `node_modules/.bin` first on `PATH`, so `dsh` and the other binaries resolve whatever
 * runs this. The launcher sets no `XDG_*` variable and nothing of pnpm's: `DSH_DISH_HOME` moves dish's directories
 * instead (dish-kit's `xdgPaths`), and the pnpm store stays the account's. Both `XDG_*` and pnpm's names would reach
 * every agent shell (dsh drops only `DSH_*` names and names that look like secrets), which would move `gh`'s and git's
 * configuration, and give pnpm another store.
 *
 *   node scripts/env.ts dsh web --host 127.0.0.1 --port 3090
 */

import { spawn } from 'node:child_process'
import { chmod, mkdir } from 'node:fs/promises'
import { constants } from 'node:os'
import { delimiter, join, resolve } from 'node:path'

export type Mode = 'dev' | 'prod'

/** The command line or `DISH_ENV` is wrong. The message is one line, without the `env: ` the launcher puts in front. */
export class UsageError extends Error {}

/** The checkout this file belongs to (its parent directory), never `process.cwd()`. */
export const ROOT: string = resolve(import.meta.dirname, '..')

/** The directories under `.dev/`: dsh's home, then dish's config, state, data and cache (`DSH_DISH_HOME`'s layout). */
const DEV_DIRECTORIES = ['dsh', 'config', 'state', 'data', 'cache']

/** `DISH_ENV`: unset, '' or 'dev' → 'dev'; 'prod' → 'prod'; anything else throws a UsageError (exact match, case-sensitive). */
export function resolveMode(env: NodeJS.ProcessEnv): Mode {
  const value = env.DISH_ENV
  if (value === undefined || value === '' || value === 'dev') return 'dev'
  if (value === 'prod') return 'prod'
  throw new UsageError(`DISH_ENV must be dev or prod (unset means dev), not ${JSON.stringify(value)}`)
}

/** `PATH` with the checkout's `node_modules/.bin` in front, and no empty entry (which would mean the working directory). */
function pathWithBin(root: string, path: string | undefined): string {
  const bin = join(root, 'node_modules', '.bin')
  return path === undefined || path === '' ? bin : `${bin}${delimiter}${path}`
}

/**
 * `env` plus exactly: `DSH_HOME=<root>/.dev/dsh`, `DSH_DISH_HOME=<root>/.dev`, `DISH_ENV=dev` and
 * `PATH=<root>/node_modules/.bin:<PATH>`. Inherited values of those names are replaced. Nothing else is added,
 * changed or removed, and `env` itself is not modified.
 */
export function devEnvironment(root: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    DSH_HOME: join(root, '.dev', 'dsh'),
    DSH_DISH_HOME: join(root, '.dev'),
    DISH_ENV: 'dev',
    PATH: pathWithBin(root, env.PATH),
  }
}

/** dev → `devEnvironment`; prod → `env` with only the `PATH` prefix added. */
export function environmentFor(mode: Mode, root: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return mode === 'dev' ? devEnvironment(root, env) : { ...env, PATH: pathWithBin(root, env.PATH) }
}

/** Make `<root>/.dev` and `dsh/`, `config/`, `state/`, `data/`, `cache/` under it, mode 0700 (chmod, since the umask only narrows). */
export async function ensureDevDirectories(root: string): Promise<void> {
  const base = join(root, '.dev')
  await mkdir(base, { recursive: true, mode: 0o700 })
  await chmod(base, 0o700)
  for (const name of DEV_DIRECTORIES) {
    const path = join(base, name)
    await mkdir(path, { recursive: true, mode: 0o700 })
    await chmod(path, 0o700)
  }
}

const USAGE = 'usage: node scripts/env.ts <command> [args...]'
const FORWARDED: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP']

/**
 * `node scripts/env.ts <command> [args...]`. Returns the exit code: the command's, 128+n when a signal ended it, 127
 * when it can't be started, 2 for usage, and 1 when dev's directories can't be made. `SIGINT`, `SIGTERM` and `SIGHUP`
 * go on to the command. The command runs in the current directory with inherited stdio.
 */
export async function main(argv: string[], options: { root?: string, env?: NodeJS.ProcessEnv } = {}): Promise<number> {
  const root = options.root ?? ROOT
  const env = options.env ?? process.env
  const [command, ...args] = argv
  let mode: Mode
  try {
    if (command === undefined || command === '') throw new UsageError(USAGE)
    mode = resolveMode(env)
  } catch (error) {
    if (!(error instanceof UsageError)) throw error
    console.error(`env: ${error.message}`)
    return 2
  }
  if (mode === 'dev') {
    try {
      await ensureDevDirectories(root)
    } catch (error) {
      console.error(`env: cannot make ${join(root, '.dev')}: ${(error as Error).message}`)
      return 1
    }
  }
  return await new Promise<number>(settle => {
    const child = spawn(command, args, { stdio: 'inherit', env: environmentFor(mode, root, env) })
    const forward = (signal: NodeJS.Signals): void => {
      child.kill(signal)
    }
    for (const signal of FORWARDED) process.on(signal, forward)
    const finish = (code: number): void => {
      for (const signal of FORWARDED) process.off(signal, forward)
      settle(code)
    }
    child.once('error', error => {
      console.error(`env: cannot start ${command}: ${error.message}`)
      finish(127)
    })
    child.once('close', (code, signal) => {
      finish(code ?? (signal === null ? 1 : 128 + (constants.signals[signal] ?? 0)))
    })
  })
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2))
