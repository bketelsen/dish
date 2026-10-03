/**
 * The launcher for root package scripts that run dsh: `node scripts/env.ts <command> [args...]`.
 *
 * dish has two configurations, and dev is the default.
 *
 * - **dev** (unset, empty or `DISH_ENV=dev`): dsh's home and every dish directory live in the checkout's git-ignored
 *   `.dev/`. The launcher sets `DSH_HOME=<checkout>/.dev/dsh`, `DSH_DISH_HOME=<checkout>/.dev` and `DISH_ENV=dev`,
 *   replacing inherited values (dsh gives every agent shell a `DSH_HOME` of its own, and the agent's `pnpm dsh` must
 *   not follow it).
 * - **prod** (`DISH_ENV=prod`): the environment passes through, but for `PATH` and `NODE_PATH`. Only the VM's service
 *   is prod, and it does not come here: its unit runs the checkout's dsh directly with the account's defaults, because
 *   dsh hands its own environment to every agent shell and a `DISH_ENV=prod` on the service would make every agent's
 *   `pnpm dsh` prod.
 * - Any other `DISH_ENV` is refused.
 *
 * In both modes a bare command is looked up in the checkout's `node_modules/.bin` first, by its absolute path, so `dsh`
 * is the checkout's whatever runs this. That directory never goes on the command's `PATH`, and neither does any other
 * directory an agent could write (`agentPath`): dsh hands its `PATH` to every agent shell, and finds `bash` on it for
 * every command an agent runs, approved escalations outside the sandbox included. `dsh` itself is not started through
 * its shim there, but as its own script, by the node that runs this (`invocation`), and neither mode passes `NODE_PATH`
 * on (`withoutNodePath`): the shim sets one that names the checkout's `node_modules/.pnpm/node_modules`, which would
 * reach every agent shell the same way, for every CommonJS program an agent runs to load a module from.
 *
 * The launcher sets no `XDG_*` variable and nothing of pnpm's: `DSH_DISH_HOME` moves dish's directories instead
 * (dish-kit's `xdgPaths`), and the pnpm store stays the account's. Both `XDG_*` and pnpm's names would reach every agent
 * shell (dsh drops only `DSH_*` names and names that look like secrets), which would move `gh`'s and git's
 * configuration, and give pnpm another store.
 *
 *   node scripts/env.ts dsh web --host 127.0.0.1 --port 3090
 */

import { spawn } from 'node:child_process'
import { constants as fsConstants, realpathSync } from 'node:fs'
import { access, chmod, mkdir, readFile, stat } from 'node:fs/promises'
import { constants } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

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

/** `agentPath`'s answer when nothing of the inherited `PATH` is left: the system part of the VM unit's. */
export const SYSTEM_PATH = ['/usr/local/bin', '/usr/bin', '/bin'].join(delimiter)

/** `path` itself and, when it exists, its real path (`/home` is a link to `/var/home` on some desktops). */
function spellings(path: string): string[] {
  try {
    return [path, realpathSync(path)]
  } catch {
    return [path]
  }
}

/** Whether `path` is `dir` or lies under it. Both are absolute. */
function within(path: string, dir: string): boolean {
  const rest = relative(dir, path)
  return rest === '' || (rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest))
}

/** Whether `agentPath` drops an absolute, normalized `path`: a `node_modules/.bin`, a `node-gyp-bin`, or one in `roots`. */
function dropped(path: string, roots: string[]): boolean {
  const name = basename(path)
  return (name === '.bin' && basename(dirname(path)) === 'node_modules')
    || name === 'node-gyp-bin'
    || roots.some(root => within(path, root))
}

/**
 * `path` without the entries a sandboxed agent could write, for dsh and so for every agent shell. dsh-subprocess-local
 * finds `bash` on this `PATH`, and dsh-tool-bash runs commands with it, so a writable entry ahead of the system
 * directories (`<root>/node_modules/.bin`, which pnpm puts first for `pnpm dsh` and `pnpm dev`) lets an agent whose
 * workspace holds the checkout plant a `bash`, or any other name, that runs for every later command, escalations
 * outside the sandbox included. These go, each by its own spelling or its real path:
 *
 * - an empty or relative entry: it is resolved against the working directory, which for an agent's command is its
 *   workspace;
 * - every `node_modules/.bin`, wherever it is. `pnpm run` and `pnpm exec` put the running package's first (the
 *   checkout's, for `pnpm dsh` and `pnpm dev`), and any other belongs to a project, which may be an agent's workspace;
 * - a `node-gyp-bin`, which `pnpm run` puts first too, so that `pnpm dsh` gives dsh the `PATH` the shell had;
 * - an entry in the checkout (`root`, or under it).
 *
 * The rest keeps its order, repeats included. The account's own directories (`~/.local/bin`, mise's) stay where they
 * were: an agent can write them only from a workspace that holds them, such as the home directory. When nothing is
 * left, the answer is `SYSTEM_PATH`: an empty `PATH` would mean the working directory.
 */
export function agentPath(root: string, path: string | undefined): string {
  const roots = spellings(resolve(root))
  const kept = (path ?? '').split(delimiter)
    .filter(entry => isAbsolute(entry) && !spellings(resolve(entry)).some(spelling => dropped(spelling, roots)))
  return kept.length === 0 ? SYSTEM_PATH : kept.join(delimiter)
}

/**
 * A copy of `env` without `NODE_PATH`. Node's CommonJS `require` looks a bare name up in each of its directories when
 * no `node_modules` above the requiring file has it, and dsh hands it to every agent shell (it drops only `DSH_*` and
 * names that look like secrets), so a writable directory there is one an agent can plant a module in for any later
 * CommonJS program to load, approved escalations outside the sandbox included. pnpm's shim for `dsh` sets one that
 * names the checkout's `node_modules/.pnpm/node_modules`, and an inherited one is the same: an agent shell under a dsh
 * started through that shim has it. dsh needs none: it is ES modules, which never read `NODE_PATH`, and every package
 * it loads resolves from where it lies.
 */
function withoutNodePath(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = { ...env }
  delete result.NODE_PATH
  return result
}

/**
 * `env` plus exactly: `DSH_HOME=<root>/.dev/dsh`, `DSH_DISH_HOME=<root>/.dev`, `DISH_ENV=dev` and
 * `PATH=agentPath(root, PATH)`, less `NODE_PATH` (`withoutNodePath`). Inherited values of those names are replaced.
 * Nothing else is added, changed or removed, and `env` itself is not modified.
 */
export function devEnvironment(root: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return withoutNodePath({
    ...env,
    DSH_HOME: join(root, '.dev', 'dsh'),
    DSH_DISH_HOME: join(root, '.dev'),
    DISH_ENV: 'dev',
    PATH: agentPath(root, env.PATH),
  })
}

/** dev → `devEnvironment`; prod → `env` with `PATH` changed, to `agentPath(root, PATH)`, and `NODE_PATH` removed. */
export function environmentFor(mode: Mode, root: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return mode === 'dev' ? devEnvironment(root, env) : withoutNodePath({ ...env, PATH: agentPath(root, env.PATH) })
}

/**
 * `<root>/node_modules/.bin/<command>` when `command` is a bare name and that is an executable file, else `command`
 * as given, which the child's `PATH` resolves. This is how `dsh` is found without that directory on `PATH`.
 */
export async function resolveCommand(root: string, command: string): Promise<string> {
  if (command.includes(sep)) return command
  const local = join(root, 'node_modules', '.bin', command)
  try {
    await access(local, fsConstants.X_OK)
    if ((await stat(local)).isFile()) return local
  } catch {
    // Not there, or not executable: the PATH lookup decides.
  }
  return command
}

/**
 * dsh's own script in the checkout, `<root>/node_modules/@deepseek-ai/dsh/<bin>`, with `bin` from its package.json:
 * the file pnpm's `node_modules/.bin/dsh` shim runs. Undefined when the checkout has no dsh, or names no such file.
 */
export async function dshEntry(root: string): Promise<string | undefined> {
  const pkg = join(root, 'node_modules', '@deepseek-ai', 'dsh')
  try {
    const { bin } = JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8')) as { bin?: unknown }
    const script = typeof bin === 'string' ? bin : (bin as Record<string, unknown> | null | undefined)?.dsh
    if (typeof script !== 'string' || script === '') return undefined
    const entry = join(pkg, script)
    return (await stat(entry)).isFile() ? entry : undefined
  } catch {
    return undefined
  }
}

/**
 * The argv that starts `command`. `dsh` is `[process.execPath, dshEntry(root)]` when the checkout has it: its shim
 * would set a `NODE_PATH` naming the checkout (`withoutNodePath`), and run a `node_modules/.bin/node` in place of node
 * when there is one. Any other bare name, and `dsh` when the checkout has none, is `[resolveCommand(root, command)]`.
 */
export async function invocation(root: string, command: string): Promise<string[]> {
  if (command === 'dsh') {
    const entry = await dshEntry(root)
    if (entry !== undefined) return [process.execPath, entry]
  }
  return [await resolveCommand(root, command)]
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
/**
 * Signals sent to the launcher alone (a service manager, `kill`) that the command must still get. dsh handles SIGINT and
 * SIGTERM and nothing else: a SIGHUP kills it at once, without its shutdown, which can orphan agent commands, which run
 * detached. So a SIGHUP goes on as a SIGTERM (`forwardedAs`). A real terminal hangup signals the whole foreground group,
 * so dsh still gets its own SIGHUP from the terminal, and this cannot prevent that. For the same reason a SIGTERM sent
 * to the launcher's process group (`kill -- -<pgid>`, `timeout`) reaches dsh twice, directly and forwarded, and dsh
 * force-exits on the second: SIGTERM the node process, not the group.
 */
const FORWARDED: NodeJS.Signals[] = ['SIGTERM', 'SIGHUP']

/** The signal the command gets for a forwarded `signal`. */
function forwardedAs(signal: NodeJS.Signals): NodeJS.Signals {
  return signal === 'SIGHUP' ? 'SIGTERM' : signal
}

/**
 * SIGINT is not forwarded. A terminal's Ctrl-C signals the whole foreground process group, and the command is in the
 * launcher's group, so it already gets one. A forwarded copy would be a second, and dsh treats a second SIGINT during
 * its shutdown as a demand to force-exit: disposal is cut short and agent commands, which run detached, can be left
 * running. So the launcher only has to survive it (a listener, so the default action, dying, does not apply) and
 * wait for the command, whose exit code it then returns.
 */
const ignore = (): void => {}

/**
 * `node scripts/env.ts <command> [args...]`. Returns the exit code: the command's, 128+n when a signal ended it, 127
 * when it can't be started, 2 for usage, and 1 when dev's directories can't be made. `SIGTERM` goes on to the command,
 * and `SIGHUP` goes on as a `SIGTERM` (see `FORWARDED`). `SIGINT` does not go on (the terminal has already delivered it
 * to the command): the launcher outlives it, waits, and returns the command's code. The command stays in the
 * launcher's process group, which interactive dsh commands need for the terminal's job control. It runs in the current
 * directory with inherited stdio. A bare command is the checkout's own when it has one, and `dsh` is started as its
 * script by this node (`invocation`).
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
  const [executable, ...prefix] = await invocation(root, command)
  return await new Promise<number>(settle => {
    const child = spawn(executable!, [...prefix, ...args], { stdio: 'inherit', env: environmentFor(mode, root, env) })
    const forward = (signal: NodeJS.Signals): void => {
      child.kill(forwardedAs(signal))
    }
    for (const signal of FORWARDED) process.on(signal, forward)
    process.on('SIGINT', ignore)
    const finish = (code: number): void => {
      for (const signal of FORWARDED) process.off(signal, forward)
      process.off('SIGINT', ignore)
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
