/**
 * `pnpm dev`: dish in dev, from this checkout: `node scripts/dev.ts [--port <n>]`.
 *
 * 1. Refuse `DISH_ENV=prod` (prod is the `dish-web` service, which never goes through here), then make the checkout's
 *    `.dev/` and take the launcher's dev environment (`scripts/env.ts`): `DSH_HOME`, `DSH_DISH_HOME` and `DISH_ENV=dev`.
 * 2. Run `deploy/install.sh` under that environment, with `DISH_REMOTE=''` whatever the environment says (dev's config
 *   store never has a remote, so it can never push over prod's) and the checkout's git identity. It is idempotent, so
 *   every run does it: the install, the build, and on the first run the profile, then any new bundle.
 * 3. Start the plugins' client bundle watchers (`pnpm ... run dev`) and `dsh web` on `127.0.0.1:<port>` (3090), and print
 *   `dev: open <url>` after dsh's own sign-in line. Neither gets install.sh's inputs (`DISH_REMOTE`, `DISH_USER_NAME`,
 *   `DISH_USER_EMAIL`, `DISH_PROFILE`), set here or inherited: dsh passes its environment on to agent shells, where an
 *   install.sh run by hand would find an inherited remote and make dev's store push to it.
 *
 * When one of the two stops, the other is stopped. The exit code is the first non-zero code of the two, or 128+n when
 * this process was itself sent signal n.
 *
 * **Output.** dsh and the watchers write to pipes, never to the terminal: this process reads both of each one's streams
 * and copies them to its own stdout and stderr. dsh's shutdown takes up to 5 s and logs as it goes, and by then the
 * terminal may be gone (a write to it fails with EIO) or a pipe closed (`pnpm dev | tee log`, where a Ctrl-C ends tee
 * too: EPIPE). A child writing there itself would die of it halfway (dsh's fail-loud handler exits 1 on an error nobody
 * handled), and so would this process. So a write that fails here is dropped, with whatever follows on that stream, and
 * the children's pipes are still read to their end, so that neither blocks on a full pipe or gets an EPIPE of its own.
 *
 * **Signals.** dsh handles SIGINT and SIGTERM and nothing else. A SIGHUP kills it at once, without its shutdown, which
 * leaves agent commands (they run detached) behind; and a second signal of either kind during its shutdown
 * (`createProcessShutdown`: `interrupt` after `interrupt`) makes it force-exit. So nothing reaches dsh but what this
 * process sends: it is spawned `detached`, in a session of its own (`dsh web` never reads stdin), so neither a
 * terminal's Ctrl-C nor a signal sent to this process's group touches it. And this process sends it a second signal
 * only for a second Ctrl-C, which is a demand to force it out.
 *
 * - SIGINT is forwarded to dsh as SIGINT, every time. One Ctrl-C is one graceful shutdown, and a second one forces dsh
 *   out, as dsh does on its own.
 * - SIGTERM is forwarded as SIGTERM, and SIGHUP (a closed terminal) and SIGQUIT (Ctrl-\) as SIGTERM, so dsh shuts down
 *   instead of dying. Once dsh has been signalled, any of these is dropped: a closed terminal hangs up twice (the
 *   shell's SIGHUP to its jobs, then the kernel's when the shell exits), and a group kill can be followed by the
 *   kernel's hangup, so forwarding each would be two signals.
 * - The watchers are `pnpm --filter ... run dev`, and pnpm does not pass a signal on to the build scripts it starts: on
 *   `SIGTERM` it carries on, and on `SIGHUP` it dies and leaves them running. So they get a process group of their own
 *   (`detached`), and every signal and the final sweep go to the whole group. SIGTERM and SIGHUP are forwarded to the
 *   group, and SIGQUIT as SIGTERM, each once. SIGINT is not: the watchers are stopped, with a SIGTERM to the group, when
 *   dsh has gone.
 * - Stopping the other child, when one has exited, sends nothing to one that has been signalled already.
 * - install.sh stays in this process's group, so the terminal's Ctrl-C reaches it directly and is not forwarded.
 *
 * Stop it with Ctrl-C, or SIGTERM the node process. A signal sent to the outer `pnpm dev` alone does not reach this
 * process (pnpm does not pass it on; `pnpm dsh` is the same). Ctrl-\ stops dsh too, but pnpm itself dies of it at once
 * and gives the prompt back before dsh has stopped, so a second key goes to the shell: prefer Ctrl-C. Ctrl-Z stops only
 * pnpm and this process: dsh and the watchers, in sessions of their own, keep running until the job is resumed (`fg`)
 * and stopped. If this process is SIGKILLed, dsh and the watchers are orphaned: no hangup reaches their sessions.
 *
 * Nothing here sets `XDG_*` or anything of pnpm's, as in the launcher (its header says why).
 */

import { execFile, spawn } from 'node:child_process'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import type { Readable } from 'node:stream'
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

/** install.sh's inputs, which dsh and the watchers never get (`serverEnvironment`). */
const INSTALL_INPUTS = ['DISH_REMOTE', 'DISH_USER_NAME', 'DISH_USER_EMAIL', 'DISH_PROFILE'] as const

/**
 * `devEnv` less install.sh's inputs, whatever it inherited: what dsh and the watchers get. dsh passes its environment on
 * to every agent shell, and an install.sh run there by hand would take an inherited DISH_REMOTE (the real one, from a
 * shell or an .envrc on the desktop) and make dev's config store a second pusher of prod's.
 */
export function serverEnvironment(devEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...devEnv }
  for (const name of INSTALL_INPUTS) delete env[name]
  return env
}

const SIGN_IN_LINE = /^dsh web: (https?:\/\/\S+)/

/** The URL from a `dsh web: <url>` line (the first one, when dsh adds a LAN address), else undefined. */
export function signInLink(line: string): string | undefined {
  return SIGN_IN_LINE.exec(line)?.[1]
}

/**
 * What each child gets for a signal this process receives: the signal to send, or nothing. A child gets at most one
 * signal this way, except that every SIGINT is forwarded to dsh (see `guardSignals`).
 */
type Forwarding = Partial<Record<NodeJS.Signals, NodeJS.Signals>>

/** install.sh is in this process's group, which a terminal's Ctrl-C and Ctrl-\ signal: neither is forwarded. */
const INSTALL_SIGNALS: Forwarding = { SIGTERM: 'SIGTERM', SIGHUP: 'SIGHUP' }
/** dsh is in a session of its own: it gets every signal from here, and SIGHUP and SIGQUIT as SIGTERM, which it handles. */
const DSH_SIGNALS: Forwarding = { SIGINT: 'SIGINT', SIGTERM: 'SIGTERM', SIGHUP: 'SIGTERM', SIGQUIT: 'SIGTERM' }
/** The watchers' group is not signalled by a terminal either, but it is not stopped by a SIGINT; see the header. */
const WATCHER_SIGNALS: Forwarding = { SIGTERM: 'SIGTERM', SIGHUP: 'SIGHUP', SIGQUIT: 'SIGTERM' }
const RECEIVED: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']

/** How long after the first child's exit the other is stopped, so that a signal that is still arriving is forwarded first. */
const STOP_GRACE_MS = 200
/** How long the children's output may take to close after they have exited: a command that outlived dsh could hold it open. */
const DRAIN_MS = 1000

/** This process's stdout or stderr, once a write to it has failed: nothing more is written there (see the header's Output). */
const failedOutput = new Set<NodeJS.WriteStream>()
const guardedOutput = new Set<NodeJS.WriteStream>()

/**
 * From here on, a closed terminal or pipe can't end this process: an error on its stdout or stderr is not thrown, but
 * marks the stream failed. (`writable` can't tell: node revives its own stdio streams after an error.)
 */
function guardOutput(): void {
  for (const stream of [process.stdout, process.stderr]) {
    if (guardedOutput.has(stream)) continue
    guardedOutput.add(stream)
    stream.on('error', () => { failedOutput.add(stream) })
  }
}

/** Writes to this process's `stream`, unless a write to it has failed. */
function put(stream: NodeJS.WriteStream, text: string | Uint8Array): void {
  if (!failedOutput.has(stream)) stream.write(text)
}

/** Copies a child's `from` to this process's `to`, reading it to its end whatever happens to `to`. Settles when it closes. */
function relay(from: Readable | null, to: NodeJS.WriteStream): Promise<void> {
  if (from === null) return Promise.resolve()
  from.on('data', (chunk: Uint8Array) => put(to, chunk))
  return new Promise(settle => from.once('close', () => settle()))
}

/** `relay`, a line at a time, to `each`. */
function relayLines(from: Readable | null, each: (line: string) => void): Promise<void> {
  if (from === null) return Promise.resolve()
  createInterface({ input: from }).on('line', each)
  return new Promise(settle => from.once('close', () => settle()))
}

/** A running child: the process, whether this process has signalled it, and its exit code once it is gone. */
interface Running {
  name: string
  process: ChildProcess
  /** It leads a process group of its own (spawned `detached`), and signals go to the whole group. */
  group: boolean
  forwarding: Forwarding
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

/**
 * Starts a child. `group`: it leads a group of its own, which gets its signals and a SIGTERM when it exits. A child
 * can be `detached` without that (dsh: its own agent commands are its business, not ours).
 */
function start(
  name: string,
  command: string,
  args: string[],
  options: SpawnOptions,
  behavior: { forwarding: Forwarding, group?: boolean },
): Running {
  const child = spawn(command, args, options)
  const running: Running = {
    name,
    process: child,
    group: behavior.group === true,
    forwarding: behavior.forwarding,
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

/** What has reached this process, and each child's share of it. */
interface Guard {
  /** The first signal received, if any. */
  received: () => NodeJS.Signals | undefined
  release: () => void
}

function guardSignals(targets: () => Running[]): Guard {
  let first: NodeJS.Signals | undefined
  const receive = (signal: NodeJS.Signals): void => {
    first ??= signal
    for (const target of targets()) {
      const forwarded = target.forwarding[signal]
      // A hangup arrives twice (the shell's, then the kernel's as the shell exits), and a group kill can be followed by
      // the kernel's hangup: only a repeated Ctrl-C is a demand to force dsh out.
      if (forwarded === undefined || (target.signalled && signal !== 'SIGINT')) continue
      send(target, forwarded)
    }
  }
  for (const signal of RECEIVED) process.on(signal, receive)
  return {
    received: () => first,
    release: () => {
      for (const signal of RECEIVED) process.off(signal, receive)
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
  guardOutput()
  try {
    await ensureDevDirectories(root)
  } catch (error) {
    console.error(`dev: cannot make ${join(root, '.dev')}: ${(error as Error).message}`)
    return 1
  }
  const env = devEnvironment(root, inherited)
  const serverEnv = serverEnvironment(env)

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
    }, { forwarding: INSTALL_SIGNALS })
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
      env: serverEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    }, { forwarding: WATCHER_SIGNALS, group: true })
    const server = start('dsh', join(root, 'node_modules', '.bin', 'dsh'), [
      'web', '--host', '127.0.0.1', '--port', String(port), '--no-open',
    ], { cwd: root, env: serverEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: true }, { forwarding: DSH_SIGNALS })
    children.push(watchers, server)

    // dsh's stdout a line at a time, for its sign-in line; the rest as it comes.
    let announced = false
    const drained = Promise.all([
      relayLines(server.process.stdout, line => {
        put(process.stdout, `${line}\n`)
        const url = announced ? undefined : signInLink(line)
        if (url !== undefined) {
          announced = true
          put(process.stdout, `dev: open ${url}\n`)
        }
      }),
      relay(server.process.stderr, process.stderr),
      relay(watchers.process.stdout, process.stdout),
      relay(watchers.process.stderr, process.stderr),
    ])

    // When either child has exited, stop the other, unless a signal has already been sent to it: a second one makes
    // dsh force-exit. (Watchers that did not get the Ctrl-C's SIGINT are stopped here, once dsh has gone.)
    const codes: number[] = []
    const stopOthers = (): void => {
      for (const child of children) {
        if (!child.exited && !child.signalled) send(child, 'SIGTERM')
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
