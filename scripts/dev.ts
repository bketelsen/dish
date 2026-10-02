/**
 * `pnpm dev`: dish in dev, from this checkout: `node scripts/dev.ts [--port <n>]`.
 *
 * 1. Refuse `DISH_ENV=prod` (prod is the `dish-web` service, which never goes through here), then make the checkout's
 *    `.dev/` and take the launcher's dev environment (`scripts/env.ts`): `DSH_HOME`, `DSH_DISH_HOME` and `DISH_ENV=dev`.
 * 2. Run `deploy/install.sh` under that environment, with `DISH_REMOTE=''` whatever the environment says (dev's config
 *   store never has a remote, so it can never push over prod's) and the checkout's git identity. It is idempotent, so
 *   every run does it: the install, the build, and on the first run the profile, then any new bundle.
 * 3. Start the plugins' client bundle watchers (`pnpm ... run dev`) and `dsh web` on `127.0.0.1:<port>` (3090), and print
 *   `dev: open <url>` after dsh's own sign-in line.
 *
 * When one of the two stops, the other is stopped. The exit code is the first non-zero code of the two, or 128+n when
 * this process was itself sent signal n.
 *
 * **Signals.** The two children are treated differently, because they sit differently in the terminal's process
 * groups.
 *
 * - dsh is in this process's group, so a terminal's Ctrl-C signals it directly. `SIGINT` is therefore not forwarded to
 *   it: a second signal of either kind during dsh's shutdown (`createProcessShutdown`: `interrupt` after `interrupt`)
 *   is a demand to force-exit, which cuts disposal short and can leave agent commands, which run detached, running.
 *   So this process only survives a SIGINT (a listener, so the default action, dying, does not apply) and waits, as
 *   `scripts/env.ts` does. `SIGTERM` and `SIGHUP` sent to this process alone go on to dsh, once.
 * - The watchers are `pnpm --filter ... run dev`, and pnpm does not pass a signal on to the build scripts it starts:
 *   on `SIGTERM` it carries on, and on `SIGHUP` it dies and leaves them running. So they get a process group of their
 *   own (`detached`), and every signal and the final sweep go to the whole group. A terminal's Ctrl-C does not reach
 *   that group, and this process does not forward SIGINT to it either: the watchers are stopped, with a SIGTERM to
 *   the group, when dsh has gone, which is when the stop-the-other rule applies. `SIGTERM` and `SIGHUP` go to the
 *   group straight away.
 * - Stopping the other child sends nothing to one that a SIGINT or a forwarded signal has already reached.
 * - A SIGINT sent to this process alone (`kill -INT <pid>`, not a terminal) reaches neither child, so it stops
 *   nothing: use `kill -TERM`.
 *
 * Nothing here sets `XDG_*` or anything of pnpm's, as in the launcher (its header says why).
 */

import { execFile, spawn } from 'node:child_process'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { constants } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { devEnvironment, ensureDevDirectories, resolveMode, ROOT, UsageError } from './env.ts'

export const DEFAULT_PORT = 3090

export interface DevOptions { port: number }

const USAGE = 'usage: pnpm dev [--port <0-65535>]'

/** A decimal port, 0 (dsh picks one) to 65535. */
function parsePort(value: string): number {
  if (!/^[0-9]+$/.test(value) || Number(value) > 65535) {
    throw new UsageError(`--port must be an integer from 0 to 65535, not ${JSON.stringify(value)}`)
  }
  return Number(value)
}

/** `--port <n>` or `--port=<n>`, an integer 0..65535 (0: dsh picks); default 3090. Anything else throws a UsageError. */
export function parseDevArgs(argv: string[]): DevOptions {
  let port: number | undefined
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!
    let value: string
    if (arg === '--port') {
      const next = argv[++index]
      if (next === undefined) throw new UsageError(`--port needs a value; ${USAGE}`)
      value = next
    } else if (arg.startsWith('--port=')) {
      value = arg.slice('--port='.length)
    } else {
      throw new UsageError(`unknown argument ${JSON.stringify(arg)}; ${USAGE}`)
    }
    if (port !== undefined) throw new UsageError(`--port given twice; ${USAGE}`)
    port = parsePort(value)
  }
  return { port: port ?? DEFAULT_PORT }
}

/** One `git config --get <key>` in `root`: its value, or undefined when it is unset, empty, or git can't run. */
function gitConfig(root: string, key: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  return new Promise(resolve => {
    execFile('git', ['config', '--get', key], { cwd: root, env, encoding: 'utf8' }, (error, stdout) => {
      const value = error === null ? stdout.trim() : ''
      resolve(value === '' ? undefined : value)
    })
  })
}

/** git config user.name / user.email in `root`, else 'dish dev' / 'dev@dish.invalid'. */
export async function gitIdentity(root: string, env: NodeJS.ProcessEnv = process.env): Promise<{ name: string, email: string }> {
  const [name, email] = await Promise.all([gitConfig(root, 'user.name', env), gitConfig(root, 'user.email', env)])
  return { name: name ?? 'dish dev', email: email ?? 'dev@dish.invalid' }
}

/** `devEnv` plus DISH_REMOTE='' (always, whatever is inherited), DISH_USER_NAME, DISH_USER_EMAIL and DISH_PROFILE=web. */
export function installEnvironment(devEnv: NodeJS.ProcessEnv, identity: { name: string, email: string }): NodeJS.ProcessEnv {
  return {
    ...devEnv,
    DISH_REMOTE: '',
    DISH_USER_NAME: identity.name,
    DISH_USER_EMAIL: identity.email,
    DISH_PROFILE: 'web',
  }
}

const SIGN_IN_LINE = /^dsh web: (https?:\/\/\S+)/

/** The URL from a `dsh web: <url>` line (the first one, when dsh adds a LAN address), else undefined. */
export function signInLink(line: string): string | undefined {
  return SIGN_IN_LINE.exec(line)?.[1]
}

/** Signals that go on to the children as soon as they arrive. SIGINT is left to the terminal; see the header. */
const FORWARDED: NodeJS.Signals[] = ['SIGTERM', 'SIGHUP']
const ignore = (): void => {}

/** How long after the first child's exit the other is stopped, so that a Ctrl-C that is still arriving is seen first. */
const STOP_GRACE_MS = 200
/** How long dsh's stdout may take to close after dsh has exited: a command that outlived dsh could hold it open. */
const DRAIN_MS = 1000

/** A running child: the process, whether this process has signalled it, and its exit code once it is gone. */
interface Running {
  name: string
  process: ChildProcess
  /** It leads a process group of its own (spawned `detached`): signals go to the group, and a terminal's Ctrl-C misses it. */
  group: boolean
  signalled: boolean
  exited: boolean
  /** The exit code: the child's, 128+n when a signal ended it, 127 when it couldn't be started. Never rejects. */
  done: Promise<number>
}

function codeOf(code: number | null, signal: NodeJS.Signals | null): number {
  return code ?? (signal === null ? 1 : 128 + (constants.signals[signal] ?? 0))
}

/** `signal` to the process group `pid` leads. A group with no member left is not an error. */
function signalGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return
  try {
    process.kill(-pid, signal)
  } catch {
    // ESRCH: nobody is left in the group.
  }
}

function start(name: string, command: string, args: string[], options: SpawnOptions): Running {
  const child = spawn(command, args, options)
  const running: Running = {
    name,
    process: child,
    group: options.detached === true,
    signalled: false,
    exited: false,
    done: new Promise<number>(settle => {
      child.on('error', error => {
        if (running.exited) return
        console.error(`dev: cannot start ${name}: ${error.message}`)
        running.exited = true
        settle(127)
      })
      child.once('exit', (code, signal) => {
        running.exited = true
        // Whatever the leader started and left behind (pnpm dies of a SIGHUP without its scripts) goes with it.
        if (running.group) signalGroup(child.pid, 'SIGTERM')
        settle(codeOf(code, signal))
      })
    }),
  }
  return running
}

function send(running: Running, signal: NodeJS.Signals): void {
  if (running.exited) return
  running.signalled = true
  if (running.group) signalGroup(running.process.pid, signal)
  else running.process.kill(signal)
}

/** What has reached this process: `SIGTERM` and `SIGHUP` are forwarded, `SIGINT` is only survived. */
interface Guard {
  /** The first signal received, if any. */
  received: () => NodeJS.Signals | undefined
  /** Whether a SIGINT has been received (the terminal has then signalled the children in this process's group). */
  interrupted: () => boolean
  release: () => void
}

function guardSignals(targets: () => Running[]): Guard {
  let first: NodeJS.Signals | undefined
  let interrupted = false
  const forward = (signal: NodeJS.Signals): void => {
    first ??= signal
    for (const target of targets()) send(target, signal)
  }
  const interrupt = (): void => {
    first ??= 'SIGINT'
    interrupted = true
  }
  for (const signal of FORWARDED) process.on(signal, forward)
  process.on('SIGINT', interrupt)
  return {
    received: () => first,
    interrupted: () => interrupted,
    release: () => {
      for (const signal of FORWARDED) process.off(signal, forward)
      process.off('SIGINT', interrupt)
    },
  }
}

/**
 * `node scripts/dev.ts [--port <n>]`. Returns the exit code: 2 for usage (a bad port, a bad or `prod` `DISH_ENV`),
 * 1 when `.dev` can't be made or `install.sh` fails, else 128+n when a signal n was sent to this process, else the
 * first non-zero code of dsh and the watchers (128+n when a signal ended one, 127 when one can't be started), else 0.
 */
export async function main(argv: string[], options: { root?: string, env?: NodeJS.ProcessEnv } = {}): Promise<number> {
  const root = options.root ?? ROOT
  const inherited = options.env ?? process.env
  let port: number
  try {
    if (resolveMode(inherited) === 'prod') throw new UsageError('pnpm dev runs dev only; prod is the dish-web service')
    port = parseDevArgs(argv).port
  } catch (error) {
    if (!(error instanceof UsageError)) throw error
    console.error(`dev: ${error.message}`)
    return 2
  }
  try {
    await ensureDevDirectories(root)
  } catch (error) {
    console.error(`dev: cannot make ${join(root, '.dev')}: ${(error as Error).message}`)
    return 1
  }
  const env = devEnvironment(root, inherited)

  const children: Running[] = []
  const guard = guardSignals(() => children)
  let stopTimer: NodeJS.Timeout | undefined
  try {
    // The install. A Ctrl-C reaches install.sh through the terminal, as it reaches the servers later.
    const identity = await gitIdentity(root, env)
    const early = guard.received()
    if (early !== undefined) return 128 + (constants.signals[early] ?? 0)
    const install = start('install.sh', join(root, 'deploy', 'install.sh'), [], {
      cwd: root,
      env: installEnvironment(env, identity),
      stdio: 'inherit',
    })
    children.push(install)
    const installCode = await install.done
    children.length = 0
    if (installCode !== 0) {
      console.error(`dev: install.sh failed (exit ${installCode})`)
      return 1
    }
    const received = guard.received()
    if (received !== undefined) return 128 + (constants.signals[received] ?? 0)

    const watchers = start('the watchers', 'pnpm', ['--filter', './plugins/*', '--parallel', '--if-present', 'run', 'dev'], {
      cwd: root,
      env,
      stdio: 'inherit',
      detached: true,
    })
    const server = start('dsh', join(root, 'node_modules', '.bin', 'dsh'), [
      'web', '--host', '127.0.0.1', '--port', String(port), '--no-open',
    ], { cwd: root, env, stdio: ['inherit', 'pipe', 'inherit'] })
    children.push(watchers, server)

    let announced = false
    const drained = server.process.stdout === null
      ? Promise.resolve()
      : new Promise<void>(settle => {
        const lines = createInterface({ input: server.process.stdout! })
        lines.on('line', line => {
          process.stdout.write(`${line}\n`)
          const url = announced ? undefined : signInLink(line)
          if (url !== undefined) {
            announced = true
            process.stdout.write(`dev: open ${url}\n`)
          }
        })
        lines.once('close', settle)
      })

    // When either child has exited, stop the other, unless a signal has already reached it: one this process
    // forwarded, or a Ctrl-C, which the terminal delivers to the children in this process's group but not to the watchers.
    const codes: number[] = []
    const stopOthers = (): void => {
      for (const child of children) {
        if (child.exited || child.signalled || (guard.interrupted() && !child.group)) continue
        send(child, 'SIGTERM')
      }
    }
    for (const child of children) {
      void child.done.then(code => {
        codes.push(code)
        stopTimer ??= setTimeout(stopOthers, STOP_GRACE_MS)
      })
    }
    await Promise.all(children.map(child => child.done))
    await Promise.race([drained, new Promise(settle => setTimeout(settle, DRAIN_MS).unref())])
    // Ended by a signal sent to this process: the children's codes only say how they were stopped.
    const signalled = guard.received()
    if (signalled !== undefined) return 128 + (constants.signals[signalled] ?? 0)
    return codes.find(code => code !== 0) ?? 0
  } finally {
    if (stopTimer !== undefined) clearTimeout(stopTimer)
    guard.release()
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2))
