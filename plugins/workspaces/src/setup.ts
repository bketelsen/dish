/**
 * A project's `setup`, run by dish (not by an agent) outside dsh's sandbox, like a CI job, and GitHub's word on a
 * clone's default branch (`githubDefault`, which the sweep uses for ancestry).
 *
 * - **runSetup** runs `bash -c <setup>` only in dish's own fresh clone, at onboarding (onboard.ts): an adopted clone
 *   (adopting, or Retry) and a new worktree are skipped with the command to run instead, since an existing
 *   checkout's ignored files, and a worktree's clone around it, can't be trusted. Stdin closed, the environment
 *   `childEnvironment()` gives dish's own children (dsh's scrub, no `GIT_*` name, `GIT_TERMINAL_PROMPT=0`) plus
 *   `SAFE_FLAGS`' settings as `GIT_CONFIG_*` and `GIT_GRAFT_FILE=/dev/null`, its own process group, and a time limit. A
 *   timeout or an abort sends the group TERM, then KILL after `KILL_GRACE_MS`; so does bash's exit, for anything it left
 *   running in its group. The last 64 KB of its output, masked, is the log.
 * - **githubDefault** asks GitHub (`ls-remote --symref origin HEAD`), never the clone's own `origin/*` refs, which an
 *   agent in the workspace can write.
 *
 * The check that once let setup run in a new worktree on merged code (`onMergedCode`, the spec's option B) was removed
 * with the user's choice of A on 2026-10-02: see the history.
 *
 * Why a new worktree can't be trusted: it sits at `<clone>/.worktrees/<slug>`, inside a clone agents can write, and
 * tools read config from parent directories: pnpm and npm workspaces (`pnpm-workspace.yaml`, a parent `package.json`'s
 * `workspaces`), `.pnpmfile.cjs`, `.npmrc`, Node's `node_modules` resolution up the tree, `.cargo/config.toml`,
 * `go.work`, and the like. Such a file an agent put in the clone reaches a worktree's setup, so even merged code in the
 * worktree could run code an agent wrote. Only the fresh clone is free of this.
 *
 * Known limits of setup's protection:
 * - **`GIT_CONFIG_COUNT` protects the git that setup runs, not everything:**
 *   - a tool that builds its own environment (dropping these names), or passes its own `GIT_CONFIG_COUNT` or `-c`
 *     (which can turn a setting back);
 *   - tools that use libgit2 or another git library, not the git binary;
 *   - config outside `SAFE_FLAGS` in the shared `.git/config` and `.git/info/attributes` (filters, a
 *     `submodule.<name>.update=!command`, credential helpers): setup's git reads them for the whole run, and
 *     `checkClone` vouches for them only at the moment it ran;
 *   - `safe.bareRepository=explicit` breaks a tool that runs git in a bare repository by its working directory.
 * - **The group kill** reaches what stays in setup's process group: a process that calls `setsid` or daemonizes
 *   escapes it and outlives setup.
 *
 * @module dish-workspaces/setup
 */

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { maskSecrets } from 'dish-kit'
import { childEnvironment } from './env.ts'
import { SAFE_FLAGS, SHA, git, maskUrlPasswords, shown } from './git.ts'
import type { GitResult } from './git.ts'
import { writeFileAtomic } from './paths.ts'

/** How much of setup's output its log keeps: the last 64 KB. */
export const LOG_TAIL_BYTES = 65_536
/** After the TERM, how long setup's process group has before a KILL. */
export const KILL_GRACE_MS = 5_000

/** How many lines of the log `tail` holds. */
const TAIL_LINES = 40
/** Output kept beyond the log's 64 KB before masking, so a secret that starts before the cut is masked whole. */
const MASK_MARGIN_BYTES = 16 * 1024
/** How often the group is looked at once bash has gone, while it is being ended. */
const GROUP_POLL_MS = 50
/** After bash and its group have gone, how long the pipes may stay open (something that left the group may hold them). */
const PIPE_GRACE_MS = 1_000
/** The longest delay `setTimeout` takes. */
const MAX_TIMER_MS = 2 ** 31 - 1
/** The start of every reason that comes from not hearing GitHub's word. */
const UNCONFIRMED = "couldn't confirm the default branch with GitHub"

/** What SAFE_FLAGS sets, as `[key, value]` pairs: the one list both dish's git and setup's draw from. */
function safeSettings(): Array<[string, string]> {
  const pairs: Array<[string, string]> = []
  for (let index = 0; index < SAFE_FLAGS.length; index += 2) {
    const setting = SAFE_FLAGS[index + 1]
    const equals = setting?.indexOf('=') ?? -1
    if (SAFE_FLAGS[index] !== '-c' || setting === undefined || equals <= 0) throw new Error('SAFE_FLAGS must be -c key=value pairs')
    pairs.push([setting.slice(0, equals), setting.slice(equals + 1)])
  }
  return pairs
}

/**
 * setup's environment: `childEnvironment(env)`, then SAFE_FLAGS' settings as `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_<n>`
 * and `GIT_CONFIG_VALUE_<n>` (git gives these the precedence of `-c`, so no config file of the clone's can undo them)
 * and `GIT_GRAFT_FILE=/dev/null`. The scrub has dropped every inherited `GIT_*` name, so none of these can be steered
 * from outside.
 */
function setupEnvironment(env: NodeJS.ProcessEnv | undefined): Record<string, string> {
  const child: Record<string, string> = childEnvironment(env)
  const settings = safeSettings()
  child.GIT_CONFIG_COUNT = String(settings.length)
  settings.forEach(([key, value], index) => {
    child[`GIT_CONFIG_KEY_${index}`] = key
    child[`GIT_CONFIG_VALUE_${index}`] = value
  })
  child.GIT_GRAFT_FILE = '/dev/null'
  return child
}

export interface SetupOptions {
  /** The project's `setup`, run by `bash -c`. */
  command: string
  /** Where it runs: dish's fresh clone. */
  cwd: string
  /** After this long, the group is ended (TERM, then KILL). */
  timeoutMs: number
  /** Where the log goes (written 0600, its directories made 0700). */
  log: string
  /** Aborting it ends the group the same way; a signal aborted already starts nothing. */
  signal?: AbortSignal
  /** The environment to scrub with `childEnvironment` (default `process.env`). */
  env?: NodeJS.ProcessEnv
}

export interface SetupResult {
  /** bash's exit code; `null` if a signal ended it, or it never started. */
  exitCode: number | null
  /** The signal that ended bash, if one did. */
  signal: string | null
  /** The time limit ended it. */
  timedOut: boolean
  /** The abort signal ended it (or it was aborted before it started). */
  aborted: boolean
  durationMs: number
  /** The log's path. */
  log: string
  /** The log's last 40 lines. */
  tail: string
}

/**
 * `bash -c <command>` in `cwd`, detached, stdin closed, env childEnvironment(options.env) plus SAFE_FLAGS' settings as
 * `GIT_CONFIG_*` and `GIT_GRAFT_FILE=/dev/null` (the git it runs gets dish's git's settings, within the module's known
 * limits). Output (both streams, interleaved as read) keeps its last LOG_TAIL_BYTES, masked, written to `log` (0600)
 * when it ends. A timeout or abort
 * sends TERM to the group, then KILL after KILL_GRACE_MS; when bash exits, whatever it left in its group is ended the
 * same way. `tail` is the log's last 40 lines. Never throws for the command's failure (one that can't even start is a
 * result with `exitCode: null`, its log saying why); rejects only for a time limit that isn't a positive number of
 * milliseconds, or a log that can't be written.
 */
export async function runSetup(options: SetupOptions): Promise<SetupResult> {
  const { timeoutMs } = options
  if (!(typeof timeoutMs === 'number' && timeoutMs > 0 && timeoutMs <= MAX_TIMER_MS)) {
    throw new RangeError('runSetup: timeoutMs must be a positive number of milliseconds')
  }
  const started = Date.now()
  if (options.signal?.aborted) {
    await writeFileAtomic(options.log, '', 0o600)
    return { exitCode: null, signal: null, timedOut: false, aborted: true, durationMs: 0, log: options.log, tail: '' }
  }
  const run = await runGroup(options)
  const text = run.failure === undefined ? logText(run.output, run.dropped) : mask(`setup couldn't start: ${run.failure}\n`)
  await writeFileAtomic(options.log, text, 0o600)
  return {
    exitCode: run.exitCode,
    signal: run.signal,
    timedOut: run.timedOut,
    aborted: run.aborted,
    durationMs: Date.now() - started,
    log: options.log,
    tail: lastLines(text, TAIL_LINES),
  }
}

interface GroupRun {
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  aborted: boolean
  output: Buffer
  /** Whether output was dropped from the front of `output`. */
  dropped: boolean
  /** Why bash couldn't start, if it couldn't. */
  failure?: string
}

/** The last `limit` bytes of what is added: whole chunks are dropped from the front once they are past it. */
class Tail {
  private readonly chunks: Buffer[] = []
  private size = 0
  private total = 0
  private readonly limit: number

  constructor(limit: number) {
    this.limit = limit
  }

  add(chunk: Buffer): void {
    this.chunks.push(chunk)
    this.size += chunk.length
    this.total += chunk.length
    while (this.chunks.length > 1 && this.size - this.chunks[0]!.length >= this.limit) this.size -= this.chunks.shift()!.length
  }

  /** Whether more was added than `bytes()` holds: its start is then the middle of something. */
  get dropped(): boolean {
    return this.total > this.limit
  }

  bytes(): Buffer {
    const all = Buffer.concat(this.chunks)
    return all.length > this.limit ? all.subarray(all.length - this.limit) : all
  }
}

/** Run bash in its own group and end the group as `runSetup` says. Resolves once bash and its group have gone. */
function runGroup(options: SetupOptions): Promise<GroupRun> {
  return new Promise(resolve => {
    const output = new Tail(LOG_TAIL_BYTES + MASK_MARGIN_BYTES)
    let child: ChildProcess
    try {
      child = spawn('bash', ['-c', options.command], {
        cwd: options.cwd,
        env: setupEnvironment(options.env),
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({ exitCode: null, signal: null, timedOut: false, aborted: false, output: output.bytes(), dropped: false, failure: messageOf(error) })
      return
    }
    const { signal } = options
    let exited = false
    let exitCode: number | null = null
    let exitSignal: string | null = null
    let timedOut = false
    let aborted = false
    let ending = false
    let killed = false
    let groupGone = false
    let pipesClosed = false
    let settled = false
    let killTimer: NodeJS.Timeout | undefined
    let poller: NodeJS.Timeout | undefined
    let pipeGrace: NodeJS.Timeout | undefined

    /** Signal the whole group; false when no one is left in it. While any member lives, the group id is theirs. */
    const signalGroup = (name: NodeJS.Signals | 0): boolean => {
      const pid = child.pid
      if (pid === undefined) return false
      try {
        process.kill(-pid, name)
        return true
      } catch {
        return false
      }
    }
    const kill = (): void => {
      if (killed) return
      killed = true
      clearTimeout(killTimer)
      signalGroup('SIGKILL')
    }
    /** TERM the group now, KILL it after the grace; once bash has gone, watch for the group to be empty. */
    const end = (): void => {
      if (ending) return
      ending = true
      signalGroup('SIGTERM')
      killTimer = setTimeout(kill, KILL_GRACE_MS)
      if (exited) watchGroup()
    }
    const watchGroup = (): void => {
      if (poller !== undefined) return
      const look = (): void => {
        // After the KILL, the group is as good as gone: nothing survives it but a process stuck in the kernel.
        if (!signalGroup(0) || killed) {
          groupGone = true
          clearInterval(poller)
          clearTimeout(killTimer)
          settle()
        }
      }
      poller = setInterval(look, GROUP_POLL_MS)
      look()
    }
    const settle = (): void => {
      if (settled || !exited || !groupGone) return
      if (!pipesClosed && pipeGrace === undefined) {
        pipeGrace = setTimeout(() => {
          pipesClosed = true
          settle()
        }, PIPE_GRACE_MS)
        return
      }
      if (!pipesClosed) return
      settled = true
      clearTimeout(timer)
      clearTimeout(killTimer)
      clearTimeout(pipeGrace)
      clearInterval(poller)
      signal?.removeEventListener('abort', onAbort)
      child.stdout?.destroy()
      child.stderr?.destroy()
      resolve({ exitCode, signal: exitSignal, timedOut, aborted, output: output.bytes(), dropped: output.dropped })
    }

    const timer = setTimeout(() => {
      if (exited) return
      timedOut = true
      end()
    }, options.timeoutMs)
    const onAbort = (): void => {
      if (!exited) {
        aborted = true
        end()
      } else if (ending) {
        // dish is going: what bash left gets no more grace.
        kill()
      }
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout?.on('data', (chunk: Buffer) => output.add(chunk))
    child.stderr?.on('data', (chunk: Buffer) => output.add(chunk))
    child.stdout?.on('error', () => {})
    child.stderr?.on('error', () => {})
    child.on('error', error => {
      if (child.pid !== undefined || settled) return
      // It never started: there is no group to end.
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve({ exitCode: null, signal: null, timedOut: false, aborted: false, output: output.bytes(), dropped: false, failure: messageOf(error) })
    })
    child.on('exit', (code, name) => {
      exited = true
      exitCode = code
      exitSignal = name
      clearTimeout(timer)
      if (killed) {
        groupGone = true
        settle()
      } else if (ending) {
        watchGroup()
      } else if (signalGroup(0)) {
        // bash is done, and left something running in its group: that is ended too.
        end()
      } else {
        groupGone = true
        settle()
      }
    })
    child.on('close', () => {
      pipesClosed = true
      settle()
    })
  })
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The log: the output's last LOG_TAIL_BYTES, masked, from a whole line.
 *
 * Where it starts is chosen in the output as read, never in the masked text (masking can shrink the text, which would
 * pull the start back into what isn't safe to show):
 * - from a line start at or after the last LOG_TAIL_BYTES;
 * - once output has been dropped, the kept part starts in the middle of something (a token's line, or a private key
 *   whose header is gone, which nothing can recognize any more), so the start is also past the kept part's first line
 *   and past the MASK_MARGIN_BYTES before the log, which is more than a key's masked length (8 KB). With nothing to
 *   start from, the log says so instead.
 * The kept part is masked whole, so a secret that starts before the log's start and runs past it is masked whole; the
 * log is the masked text from where it stops matching the masked text before the start (the start itself, or the
 * mask of a secret that runs across it). Masked once more after the cut, and cut at a line again if a mask grew it.
 */
function logText(output: Buffer, dropped: boolean): string {
  const raw = Buffer.from(decodeFrom(output, 0), 'utf8')
  let start = 0
  if (dropped || raw.length > LOG_TAIL_BYTES) {
    const from = Math.max(raw.length - LOG_TAIL_BYTES, dropped ? Math.min(MASK_MARGIN_BYTES, raw.length) : 0)
    const firstLine = dropped ? raw.indexOf(0x0a) + 1 : 0
    // No line start after the dropped part's line (none at all, or only the newline that ends it): nothing to show.
    if (dropped && (firstLine === 0 || firstLine >= raw.length)) return `[setup's last ${Math.round(raw.length / 1024)} KB of output were part of one line; not kept]\n`
    const at = Math.max(from, firstLine)
    const newline = raw.indexOf(0x0a, at - 1)
    // A line start if there is one; else the middle of the last line, which began after the first (so it is masked
    // in context) and is cut at a character.
    start = newline >= 0 && newline < raw.length - 1 ? newline + 1 : charStart(raw, at)
  }
  const whole = mask(raw.toString('utf8'))
  const before = mask(raw.subarray(0, start).toString('utf8'))
  let text = mask(whole.slice(commonPrefix(whole, before)))
  if (Buffer.byteLength(text) <= LOG_TAIL_BYTES) return text
  // Masks longer than what they hid: cut at a line again, or, in one long line, at a character, masking each time.
  const bytes = Buffer.from(text, 'utf8')
  const newline = bytes.indexOf(0x0a, bytes.length - LOG_TAIL_BYTES - 1)
  if (newline >= 0 && newline < bytes.length - 1) return mask(bytes.subarray(newline + 1).toString('utf8'))
  for (let round = 0; round < 4 && Buffer.byteLength(text) > LOG_TAIL_BYTES; round++) {
    const over = Buffer.from(text, 'utf8')
    text = mask(decodeFrom(over, over.length - LOG_TAIL_BYTES))
  }
  return text
}

/** How many characters `a` and `b` share from their start. */
function commonPrefix(a: string, b: string): number {
  const length = Math.min(a.length, b.length)
  let index = 0
  while (index < length && a.charCodeAt(index) === b.charCodeAt(index)) index++
  return index
}

/** `at`, moved forward past any UTF-8 continuation bytes of `bytes`. */
function charStart(bytes: Buffer, at: number): number {
  let index = Math.max(0, at)
  while (index < bytes.length && (bytes[index]! & 0xc0) === 0x80) index++
  return index
}

/** `bytes` from `start`, moved forward past any UTF-8 continuation bytes so no character is cut in half. */
function decodeFrom(bytes: Buffer, start: number): string {
  return bytes.subarray(charStart(bytes, start)).toString('utf8')
}

function mask(text: string): string {
  return maskSecrets(maskUrlPasswords(text))
}

/** The last `count` lines of `text`, without its final newline. */
function lastLines(text: string, count: number): string {
  const lines = text.replace(/\n$/, '').split('\n')
  return lines.slice(-count).join('\n')
}

// --- GitHub's word ------------------------------------------------------------------------------------------------

/** GitHub's default branch and its commit, or why dish couldn't hear it. */
export type GitHubDefault = { branch: string, sha: string } | { reason: string }

/**
 * GitHub's word on its default branch, right after the caller's fetch: `ls-remote --symref origin HEAD` (through the
 * credential helper) names the branch and its sha, which must be in the clone. A local `origin/<default>` or
 * `origin/HEAD` is never read: an agent in the workspace can write refs. A failure is a reason starting "couldn't
 * confirm the default branch with GitHub"; throws only when git can't be started. `options.env` goes on top of git()'s
 * (a test's `GIT_CONFIG_NOSYSTEM`).
 *
 * The caller has fetched and checked the clone (`checkClone` with the expected `url`) just before: `origin` is whatever
 * the clone's config says. Used by the sweep (sweep.ts) for ancestry.
 */
export async function githubDefault(clone: string, options: { signal?: AbortSignal, env?: Record<string, string> } = {}): Promise<GitHubDefault> {
  const { signal } = options
  const run = (args: readonly string[]): Promise<GitResult> => git(['-C', clone, ...args], { signal, env: { ...options.env } })
  const listed = await run(['ls-remote', '--symref', 'origin', 'HEAD'])
  if (listed.code !== 0 || listed.timedOut || listed.aborted) {
    const line = firstLine(listed.stderr)
    const how = listed.timedOut ? 'ls-remote timed out' : `ls-remote failed (exit ${listed.code})`
    return { reason: `${UNCONFIRMED}: ${how}${line === '' ? '' : `: ${line}`}` }
  }
  let target: string | undefined
  let sha: string | undefined
  for (const entry of listed.stdout.split('\n')) {
    const symref = /^ref: (\S+)\tHEAD$/.exec(entry)
    if (symref !== null) target = symref[1]
    const tip = /^(\S+)\tHEAD$/.exec(entry)
    if (tip !== null && SHA.test(tip[1]!)) sha = tip[1]
  }
  if (target === undefined || sha === undefined || !target.startsWith('refs/heads/')) {
    return { reason: `${UNCONFIRMED}: origin didn't name its default branch` }
  }
  const branch = target.slice('refs/heads/'.length)
  const inClone = await run(['rev-parse', '--verify', '--quiet', '--end-of-options', `${sha}^{commit}`])
  if (inClone.code !== 0 || inClone.stdout.trim() !== sha) {
    return { reason: `${UNCONFIRMED}: its ${shown(branch, 100)} (${sha.slice(0, 12)}) isn't in the clone; fetch, then try again` }
  }
  return { branch, sha }
}

/** The first non-empty line of git's stderr, masked and cut short. */
function firstLine(stderr: string): string {
  const line = stderr.split(/[\r\n]+/).map(part => part.trim()).find(part => part !== '') ?? ''
  return shown(line, 200)
}

export type SetupOutcome = { ran: false, reason: string } | ({ ran: true } & SetupResult)

/** The skip message: why, and the command to run instead, e.g. "setup didn't run outside the sandbox: it is an existing checkout. Run it yourself in <cwd>: <command>". */
export function skipReason(why: string, cwd: string, command: string): string {
  const reason = why.replace(/\.+$/, '')
  return `setup didn't run outside the sandbox: ${reason}. Run it yourself in ${cwd}: ${command}`
}
