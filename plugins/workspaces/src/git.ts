/**
 * dish's own git: the one way dish-workspaces runs git (a test fails if another module of the package starts it).
 *
 * Agents in a project's workspace can write anything in the clone, `.git` included, so nothing a clone holds may choose
 * what this git runs:
 * - every call passes `SAFE_FLAGS`: hooks come from `/dev/null` and fsmonitor is off, whatever `.git/hooks` and
 *   `.git/config` say (`-c` beats every config file). Other keys that run programs (filters, drivers, includes, …)
 *   can't be turned off one by one: `checkClone` (safety.ts) refuses a clone that has them before dish works in it.
 * - the environment is `childEnvironment()`: no inherited `GIT_*` name (that could point git at another repository
 *   or config), nothing credential-shaped, no `DSH_*`, and `GIT_TERMINAL_PROMPT=0`.
 * - git runs detached: in its own session and process group, with no terminal to prompt on and stdin closed unless
 *   `input` is given. A time limit (and an abort) ends the whole group: TERM, then KILL for whatever is left once git
 *   has gone, or after a grace if it hasn't. Modelled on dish-config's `runNetworkGit` (`store/push.ts`).
 * - output is capped, and a failure's message is git's first stderr line with credentials masked (`maskSecrets`) and
 *   cut short.
 *
 * @module dish-workspaces/git
 */

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { maskSecrets } from 'dish-kit'
import { childEnvironment } from './env.ts'

/** Passed before every git command dish runs: no hooks, no fsmonitor, whatever the clone's own files say. */
export const SAFE_FLAGS: readonly string[] = Object.freeze(['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'])
/** How long one git command may run before its process group is killed. */
export const DEFAULT_GIT_TIMEOUT_MS = 120_000

/** The most of stdout, and of stderr, that is kept. */
const MAX_OUTPUT = 4 * 1024 * 1024
/** After the TERM, how long git has before the whole group gets a KILL. */
const KILL_GRACE_MS = 5_000
/** After git exits, how long its pipes may stay open (something outside its group may hold them) before they are given up on. */
const PIPE_GRACE_MS = 1_000
/** The most characters of git's stderr a `GitError` message carries. */
const MAX_ERROR_CHARS = 200
/** How much of the first stderr line is masked before the cut: masking first, so a cut never leaves most of a token. */
const MAX_MASKED_CHARS = 64 * 1024
/** The longest delay `setTimeout` takes. */
const MAX_TIMER_MS = 2 ** 31 - 1

export interface GitOptions {
  /** The working directory. Default: this process's. */
  cwd?: string
  /** Kill the process group after this long. Default `DEFAULT_GIT_TIMEOUT_MS`. */
  timeoutMs?: number
  /** Aborting it kills the process group; a signal aborted already starts nothing. */
  signal?: AbortSignal
  /** Set on top of `childEnvironment()`, after its scrub (so a name it drops can be given on purpose). */
  env?: Record<string, string>
  /** Written to git's stdin, which is then closed. Without it, stdin is closed from the start. */
  input?: string
}

export interface GitResult {
  /** The exit code; `-1` if git was ended by a signal (or never started, for an aborted signal). */
  code: number
  /** At most 4 MB of each. */
  stdout: string
  stderr: string
  /** The time limit ended it. */
  timedOut: boolean
  /** The signal ended it, or it was aborted before it started. */
  aborted: boolean
}

/** A git command that didn't exit 0. The message never carries more than git's first stderr line, masked and cut. */
export class GitError extends Error {
  readonly code: number
  readonly timedOut: boolean

  constructor(message: string, code: number, timedOut: boolean) {
    super(message)
    this.name = 'GitError'
    this.code = code
    this.timedOut = timedOut
  }
}

/** Up to `MAX_OUTPUT` bytes of a stream; the rest is read and dropped, so the child never blocks on a full pipe. */
class Capture {
  private readonly chunks: Buffer[] = []
  private size = 0

  add(chunk: Buffer): void {
    const room = MAX_OUTPUT - this.size
    if (room <= 0) return
    const part = chunk.length > room ? chunk.subarray(0, room) : chunk
    this.chunks.push(part)
    this.size += part.length
  }

  text(): string {
    return Buffer.concat(this.chunks).toString('utf8')
  }
}

/**
 * `git ...SAFE_FLAGS ...args`, detached (its own process group), stdin `input` or closed, env childEnvironment() plus
 * `options.env`. A timeout or an abort kills the group. Output capped at 4 MB each. Never throws for an exit code;
 * throws only when git can't be started (or for a time limit that isn't a positive number of milliseconds).
 */
export function git(args: readonly string[], options: GitOptions = {}): Promise<GitResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS
  if (!(typeof timeoutMs === 'number' && timeoutMs > 0 && timeoutMs <= MAX_TIMER_MS)) {
    return Promise.reject(new RangeError('git: timeoutMs must be a positive number of milliseconds'))
  }
  const { signal } = options
  if (signal?.aborted) return Promise.resolve({ code: -1, stdout: '', stderr: '', timedOut: false, aborted: true })

  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn('git', [...SAFE_FLAGS, ...args], {
      cwd: options.cwd,
      env: { ...childEnvironment(), ...options.env },
      detached: true,
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    })
    const stdout = new Capture()
    const stderr = new Capture()
    let exited = false
    let stopping = false
    let timedOut = false
    let aborted = false
    let settled = false
    let hardKill: NodeJS.Timeout | undefined
    let pipeGrace: NodeJS.Timeout | undefined

    /** Signal git's whole process group. While any member lives, the group id is theirs: no one else's can be hit. */
    const signalGroup = (name: NodeJS.Signals): void => {
      const pid = child.pid
      if (pid === undefined) return
      try {
        process.kill(-pid, name)
      } catch {
        // No such group: everyone in it has gone.
      }
    }
    /** End the group: TERM now, KILL once git has gone (see 'exit') or after the grace. Once git has exited, nothing is done. */
    const stop = (why: 'timeout' | 'abort'): void => {
      if (stopping || exited) return
      stopping = true
      if (why === 'timeout') timedOut = true
      else aborted = true
      signalGroup('SIGTERM')
      hardKill = setTimeout(() => signalGroup('SIGKILL'), KILL_GRACE_MS)
    }
    const timer = setTimeout(() => stop('timeout'), timeoutMs)
    const onAbort = (): void => stop('abort')
    signal?.addEventListener('abort', onAbort, { once: true })

    const finish = (code: number | null, failure?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(pipeGrace)
      clearTimeout(hardKill)
      signal?.removeEventListener('abort', onAbort)
      child.stdout?.destroy()
      child.stderr?.destroy()
      if (failure !== undefined) reject(failure)
      else resolve({ code: code ?? -1, stdout: stdout.text(), stderr: stderr.text(), timedOut, aborted })
    }

    child.stdout?.on('data', (chunk: Buffer) => stdout.add(chunk))
    child.stderr?.on('data', (chunk: Buffer) => stderr.add(chunk))
    child.stdout?.on('error', () => {})
    child.stderr?.on('error', () => {})
    if (options.input !== undefined) {
      // git may exit without reading all of it; that is told by its exit code.
      child.stdin?.on('error', () => {})
      child.stdin?.end(options.input)
    }
    child.on('error', error => finish(null, error))
    child.on('exit', code => {
      exited = true
      if (stopping) {
        // git has gone; what it started gets no more grace. Its group id stays theirs while any of them lives.
        clearTimeout(hardKill)
        signalGroup('SIGKILL')
      }
      // The pipes close with the group, unless something outside it (a daemonized helper) kept them.
      pipeGrace = setTimeout(() => finish(code), PIPE_GRACE_MS)
    })
    child.on('close', code => finish(code))
  })
}

/** git(), throwing GitError on anything but exit 0 (a timeout and an abort included). Returns stdout. */
export async function gitOk(args: readonly string[], options: GitOptions = {}): Promise<string> {
  const result = await git(args, options)
  if (result.code === 0 && !result.timedOut && !result.aborted) return result.stdout
  const command = `git ${subcommand(args)}`.trimEnd()
  let message: string
  if (result.timedOut) message = `${command} timed out after ${options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS} ms`
  else if (result.aborted) message = `${command} was aborted`
  else {
    const line = firstLine(result.stderr)
    message = `${command} failed (exit ${result.code})${line === '' ? '' : `: ${line}`}`
  }
  throw new GitError(message, result.code, result.timedOut)
}

/** Global options of git that take their value as the next argument. */
const VALUED_OPTIONS = new Set(['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix', '--attr-source'])

/** The subcommand of `args` (what follows git's own options), shown masked and short; `''` if there is none. */
function subcommand(args: readonly string[]): string {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (VALUED_OPTIONS.has(arg)) {
      index++
      continue
    }
    if (arg.startsWith('-')) continue
    return Array.from(maskSecrets(arg.replace(/[\x00-\x1f\x7f]/g, ' '))).slice(0, 40).join('')
  }
  return ''
}

/** A password in a URL (`scheme://user:secret@host`), masked. */
function maskUrlPasswords(text: string): string {
  return text.replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^/\s@:]*):[^/\s@]*@/gi, '$1:***@')
}

/** The first non-empty line of git's stderr, without control characters, masked, then cut to `MAX_ERROR_CHARS`. */
function firstLine(stderr: string): string {
  const line = stderr.split(/[\r\n]+/).map(part => part.replace(/[\x00-\x1f\x7f]/g, ' ').trim()).find(part => part !== '') ?? ''
  const masked = maskSecrets(maskUrlPasswords(line.slice(0, MAX_MASKED_CHARS)))
  return Array.from(masked).slice(0, MAX_ERROR_CHARS).join('')
}
