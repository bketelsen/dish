/**
 * dish's own git: the one way dish-workspaces runs git (a test fails if another module of the package starts it).
 *
 * Agents in a project's workspace can write anything in the clone, `.git` included, so nothing a clone holds may choose
 * what this git runs:
 * - every call passes `SAFE_FLAGS`: hooks come from `/dev/null` and fsmonitor is off, whatever `.git/hooks` and
 *   `.git/config` say (`-c` beats every config file). Other keys that run programs (filters, drivers, includes, …)
 *   can't be turned off one by one: `checkClone` (safety.ts) refuses a clone that has them before dish works in it.
 * - nothing recurses into a nested repository (a submodule, or any repository an agent made inside the clone and
 *   `git add`ed): that repository's config is outside `checkClone`'s reach. `SAFE_FLAGS` turn fetch's and the other
 *   commands' submodule recursion off (`-c` beats an agent's `.gitmodules`), and `status`, `diff`, `diff-index` and
 *   `diff-files`, which look inside a nested repository to tell whether it is dirty, are refused unless the call
 *   passes `--ignore-submodules=dirty` or `=all` (only the command-line option beats `.gitmodules`' `ignore`).
 * - no planted object rewrite: `core.useReplaceRefs=false` ignores a `refs/replace/<sha>` an agent wrote (which
 *   otherwise makes `rev-parse`, `cat-file` and `worktree add <sha>` resolve to the agent's tree), and
 *   `GIT_GRAFT_FILE=/dev/null` ignores a planted `.git/info/grafts` (which otherwise rewrites history, turning a
 *   `merge-base --is-ancestor` from false to true). Only the env var switches grafts off, so it is set after the
 *   scrub, which has dropped every inherited `GIT_*` name.
 * - `safe.bareRepository=explicit`, so a bare repository an agent planted where dish `-C`s is refused unless named
 *   with `--git-dir`. dish never `-C`s into a bare repository, so this changes nothing it does.
 * - no repository above the directory git starts in: `GIT_CEILING_DIRECTORIES` is that directory's parent (by its real
 *   path), so a clone whose `.git` git doesn't accept (its `HEAD` removed, say) is an error, never the repository
 *   around it (the dish checkout, around a dev work root). `checkClone` asks git where `.git` is as well.
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
import { realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { maskSecrets } from 'dish-kit'
import { childEnvironment } from './env.ts'

/**
 * Passed before every git command dish runs, whatever the clone's own files say (`-c` beats every config file): no
 * hooks, no fsmonitor, no recursion into submodules, no replace refs, no commit-graph (a forged one fakes ancestry), no credential prompt, and a bare repository only when
 * named.
 * Grafts are switched off through `GIT_GRAFT_FILE` in the environment, since no `-c` key does it; setting that var
 * makes git print a deprecation hint on every command that parses commits, which would push the real `fatal:` line
 * out of `GitError`'s first-line message, so the hint is silenced here.
 */
export const SAFE_FLAGS: readonly string[] = Object.freeze([
  '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
  '-c', 'fetch.recurseSubmodules=false', '-c', 'submodule.recurse=false',
  '-c', 'core.useReplaceRefs=false', '-c', 'safe.bareRepository=explicit',
  '-c', 'advice.graftFileDeprecated=false', '-c', 'credential.interactive=false',
  '-c', 'core.commitGraph=false',
])
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
/** Subcommands that run git inside a nested repository to see whether it is dirty, unless told not to. */
const LOOKS_INSIDE_SUBMODULES: ReadonlySet<string> = new Set(['status', 'diff', 'diff-index', 'diff-files'])
/** The values of `--ignore-submodules` that keep them from it. */
const SUBMODULES_LEFT_ALONE: ReadonlySet<string> = new Set(['--ignore-submodules=dirty', '--ignore-submodules=all'])

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
 * Why `args` would let git look inside a nested repository, or `undefined`. For `status`, `diff`, `diff-index` and
 * `diff-files`: every option of the `--ignore-submodules` family before the end of the options (git takes the last
 * one, and abbreviations: `--ignore-sub=none`, `--no-ignore-submodules`) must be `--ignore-submodules=dirty` or
 * `--ignore-submodules=all`, and there must be one.
 */
export function submoduleProblem(args: readonly string[]): string | undefined {
  const at = subcommandIndex(args)
  if (at < 0 || !LOOKS_INSIDE_SUBMODULES.has(args[at]!)) return undefined
  let found = false
  for (const arg of args.slice(at + 1)) {
    if (arg === '--' || arg === '--end-of-options') break
    if (!/^--(?:no-)?ignore-s/.test(arg)) continue
    if (!SUBMODULES_LEFT_ALONE.has(arg)) return `git ${args[at]} refused: ${arg.split('=')[0]} must be --ignore-submodules=dirty or =all`
    found = true
  }
  return found
    ? undefined
    : `git ${args[at]} refused: pass --ignore-submodules=dirty or --ignore-submodules=all, so git doesn't run inside a nested repository`
}

/**
 * Where git starts looking for a repository: `cwd` (else this process's directory), then each `-C` before the
 * subcommand in turn, as git joins them (an empty one changes nothing).
 */
function startDirectory(args: readonly string[], cwd?: string): string {
  let dir = resolve(cwd ?? process.cwd())
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (VALUED_OPTIONS.has(arg)) {
      const value = args[index + 1]
      if (arg === '-C' && value !== undefined && value !== '') dir = resolve(dir, value)
      index++
      continue
    }
    if (!arg.startsWith('-')) break
  }
  return dir
}

/**
 * `GIT_CEILING_DIRECTORIES` for a git that starts in `dir`: its parent, by its real path (git compares the ceiling
 * with the directory it is in, which is real), so discovery never leaves `dir`. A `dir` that can't be resolved (it
 * isn't there: git fails on it anyway) gets the parent as spelled.
 */
function ceilingFor(dir: string): string {
  let real = dir
  try {
    real = realpathSync(dir)
  } catch {
    // git can't start there; nothing to walk up from.
  }
  return dirname(real)
}

/**
 * `git ...SAFE_FLAGS ...args`, detached (its own process group), stdin `input` or closed, env childEnvironment() plus
 * `options.env`, then `GIT_CEILING_DIRECTORIES` (the parent of the directory git starts in) and `GIT_GRAFT_FILE`. A
 * timeout or an abort kills the group. Output capped at 4 MB each. Never throws for an exit code; throws only when git
 * can't be started, for a time limit that isn't a positive number of milliseconds, and, before starting anything, for a
 * `status` or `diff*` call that `submoduleProblem` refuses.
 */
export function git(args: readonly string[], options: GitOptions = {}): Promise<GitResult> {
  const refused = submoduleProblem(args)
  if (refused !== undefined) return Promise.reject(new Error(refused))
  const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS
  if (!(typeof timeoutMs === 'number' && timeoutMs > 0 && timeoutMs <= MAX_TIMER_MS)) {
    return Promise.reject(new RangeError('git: timeoutMs must be a positive number of milliseconds'))
  }
  const { signal } = options
  if (signal?.aborted) return Promise.resolve({ code: -1, stdout: '', stderr: '', timedOut: false, aborted: true })

  let ceiling: string
  try {
    ceiling = ceilingFor(startDirectory(args, options.cwd))
  } catch (error) {
    // This process's directory is gone: git can't start in it either.
    return Promise.reject(error)
  }

  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn('git', [...SAFE_FLAGS, ...args], {
      cwd: options.cwd,
      // GIT_CEILING_DIRECTORIES and GIT_GRAFT_FILE last: after the scrub (which dropped every inherited GIT_*) and after
      // options.env, so no caller can let discovery walk up, or turn a planted grafts file back on. Only the latter var
      // switches grafts off.
      env: { ...childEnvironment(), ...options.env, GIT_CEILING_DIRECTORIES: ceiling, GIT_GRAFT_FILE: '/dev/null' },
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

/** Where the subcommand of `args` is (the first argument after git's own options), or -1 if there is none. */
function subcommandIndex(args: readonly string[]): number {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (VALUED_OPTIONS.has(arg)) {
      index++
      continue
    }
    if (!arg.startsWith('-')) return index
  }
  return -1
}

/** The subcommand of `args`, shown masked and short; `''` if there is none. */
function subcommand(args: readonly string[]): string {
  const at = subcommandIndex(args)
  return at < 0 ? '' : Array.from(maskSecrets(args[at]!.replace(/[\x00-\x1f\x7f]/g, ' '))).slice(0, 40).join('')
}

/** A password in a URL (`scheme://user:secret@host`), masked. `maskSecrets` doesn't cover these, so dish does. */
export function maskUrlPasswords(text: string): string {
  return text.replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^/\s@:]*):[^/\s@]*@/gi, '$1:***@')
}

/** A full commit id as git prints it: 40 hex digits (SHA-1) or 64 (SHA-256), lower case. */
export const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

/**
 * Text from outside (a branch name, a path, git's stderr, an agent's file name) as a message may show it: no control
 * characters, masked (`maskSecrets` and URL passwords), then cut to `max` characters. Masked before the cut, so no part
 * of a secret is left, and after, in case the cut changed what matches.
 */
export function shown(text: string, max: number): string {
  const mask = (value: string): string => maskSecrets(maskUrlPasswords(value))
  const masked = mask(text.slice(0, 64 * 1024).replace(/[\x00-\x1f\x7f]/g, ' '))
  const chars = Array.from(masked)
  return chars.length > max ? mask(`${chars.slice(0, max - 1).join('')}…`) : masked
}

/** The first non-empty line of git's stderr, without control characters, masked, then cut to `MAX_ERROR_CHARS`. */
function firstLine(stderr: string): string {
  const line = stderr.split(/[\r\n]+/).map(part => part.replace(/[\x00-\x1f\x7f]/g, ' ').trim()).find(part => part !== '') ?? ''
  const masked = maskSecrets(maskUrlPasswords(line.slice(0, MAX_MASKED_CHARS)))
  return Array.from(masked).slice(0, MAX_ERROR_CHARS).join('')
}
