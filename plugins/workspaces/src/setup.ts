/**
 * A project's `setup`, run by dish (not by an agent) outside dsh's sandbox, like a CI job, and the check that decides
 * whether it may run there at all.
 *
 * - **runSetup** runs `bash -c <setup>` in a clone or a new worktree: stdin closed, the environment `childEnvironment()`
 *   gives dish's own children (dsh's scrub, no `GIT_*` name, `GIT_TERMINAL_PROMPT=0`) plus `SAFE_FLAGS`' settings as
 *   `GIT_CONFIG_*` and `GIT_GRAFT_FILE=/dev/null`, its own process group, and a time limit. A timeout or an abort sends
 *   the group TERM, then KILL after `KILL_GRACE_MS`; so does bash's exit, for anything it left running in its group.
 *   The last 64 KB of its output, masked, is the log.
 * - **onMergedCode** is the spec's decision 1, as hardened on 2026-10-02 (option A, then Task 6's review): setup runs
 *   outside the sandbox only on code a human merged, and only in a checkout dish has just made (its own fresh clone, or
 *   a new worktree), since an existing checkout's ignored files can't be trusted. So it checks a commit, never a
 *   working tree. An agent in the workspace can write anything in the clone, `.git` included, so nothing the check reads
 *   may be the agent's to choose:
 *   - GitHub's word: `ls-remote --symref origin HEAD` names the default branch and its sha. A local `origin/<default>`
 *     (or `origin/HEAD`) is never read.
 *   - Ancestry ignores replace refs and grafts (git()'s `SAFE_FLAGS` and environment) and the commit-graph file
 *     (`core.commitGraph=false`), each of which an agent can plant to make its commit look like an ancestor.
 *   - No gitlink or nested-repository check: see `onMergedCode`.
 *
 * What neither covers (known limits, on top of the spec's forged objects and the time between check and run):
 * - **A new worktree is not a clean room.** It sits at `<clone>/.worktrees/<slug>`, inside a clone agents can write,
 *   and tools read config from parent directories: pnpm and npm workspaces (`pnpm-workspace.yaml`, a parent
 *   `package.json`'s `workspaces`), `.pnpmfile.cjs`, `.npmrc`, Node's `node_modules` resolution up the tree,
 *   `.cargo/config.toml`, `go.work`, and the like. Such a file an agent put in the clone reaches the worktree's setup,
 *   so merged code in the worktree can still run code an agent wrote. Only the fresh clone is free of this.
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
import { SAFE_FLAGS, git, maskUrlPasswords } from './git.ts'
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
/** Turns off the commit-graph file for one git call: a forged one lies about parents. */
// SAFE_FLAGS carries core.commitGraph=false too (on `projects`, after this module was written); this stays as a belt.
const NO_COMMIT_GRAPH: readonly string[] = ['-c', 'core.commitGraph=false']
/** The start of every reason that comes from not hearing GitHub's word. */
const UNCONFIRMED = "couldn't confirm the default branch with GitHub"

/**
 * Settings `projects`' SAFE_FLAGS has (Tasks 3a's and 3b's reviews) that this branch's copy may lack. Each is added to
 * setup's git config unless SAFE_FLAGS already sets its key; once SAFE_FLAGS carries both, this list can go.
 */
const SAFE_SETTINGS_TO_COME: ReadonlyArray<readonly [string, string]> = [['credential.interactive', 'false'], ['core.commitGraph', 'false']]

/** What SAFE_FLAGS sets, as `[key, value]` pairs (the one list both dish's git and setup's draw from), and the settings to come. */
function safeSettings(): Array<[string, string]> {
  const pairs: Array<[string, string]> = []
  for (let index = 0; index < SAFE_FLAGS.length; index += 2) {
    const setting = SAFE_FLAGS[index + 1]
    const equals = setting?.indexOf('=') ?? -1
    if (SAFE_FLAGS[index] !== '-c' || setting === undefined || equals <= 0) throw new Error('SAFE_FLAGS must be -c key=value pairs')
    pairs.push([setting.slice(0, equals), setting.slice(equals + 1)])
  }
  for (const [key, value] of SAFE_SETTINGS_TO_COME) {
    if (!pairs.some(([known]) => known.toLowerCase() === key.toLowerCase())) pairs.push([key, value])
  }
  return pairs
}

/** For tests only, never set by dish: put on top of the environment of this module's own git (a test's `GIT_CONFIG_NOSYSTEM`); never setup's. */
export const internals: { gitEnv?: Record<string, string> } = {}

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
  /** Where it runs: the clone, or a new worktree. */
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

// --- on merged code only -------------------------------------------------------------------------------------------

export type MergedCheck = { ok: true } | { ok: false, reason: string }

/**
 * Whether setup may run outside the sandbox, in a checkout dish has just made of `at.commit` (the spec's decision 1, as
 * hardened 2026-10-02: option A, then fresh checkouts only).
 * - First the remote's word: `ls-remote --symref origin HEAD` (through the credential helper), right after the
 *   caller's fetch, gives GitHub's default branch and its sha. `defaultBranch` must be that branch. A local
 *   `origin/<defaultBranch>` is never trusted: an agent can write refs. If ls-remote fails, GitHub names another
 *   branch, or the sha isn't in the clone, setup is skipped ("couldn't confirm the default branch with GitHub").
 * - The commit is an ancestor of (or equal to) that sha.
 *
 * A gitlink (a submodule) in the commit is not refused. The rule against nested repositories was for an existing
 * checkout, where `--ignore-submodules=dirty` hides edits inside one. A commit can't hold a nested repository (git
 * refuses a `.git` path), and dish's `worktree add` (submodule recursion off) leaves a gitlink an empty directory. If
 * setup fetches it (`git submodule update`), it gets the commit the merged tree pins, from the URL the merged
 * `.gitmodules` names, into a module directory git makes new (a fresh clone's `.git/modules`, or a new worktree's own
 * `.git/worktrees/<name>/modules`, not the shared `.git/modules`: checked with git 2.47). It also writes
 * `submodule.<name>.url` and `.active` into the clone's shared `.git/config`. This says nothing about the rest of
 * what a new worktree's setup can read from the clone around it (see the module's known limits).
 *
 * Ancestry ignores replace refs, grafts and the commit-graph file. Uses git() only. Never throws: a failure is a
 * refusal with its reason.
 *
 * Before it, the caller fetches and checks the clone (`checkClone` with the expected `url`): `origin` is whatever the
 * clone's config says, so only that check keeps an agent from pointing it at a remote of its own.
 */
export async function onMergedCode(clone: string, at: { commit: string }, defaultBranch: string, signal?: AbortSignal): Promise<MergedCheck> {
  try {
    return await mergedCheck(clone, at.commit, defaultBranch, signal)
  } catch (error) {
    if (signal?.aborted) return aborted()
    return { ok: false, reason: `the check failed: ${shown(messageOf(error), 200)}` }
  }
}

async function mergedCheck(clone: string, revision: string, defaultBranch: string, signal?: AbortSignal): Promise<MergedCheck> {
  if (signal?.aborted) return aborted()
  if (revision === '' || revision.startsWith('-') || /[\x00-\x20\x7f]/.test(revision)) {
    return { ok: false, reason: `${JSON.stringify(shown(revision, 60))} isn't a commit` }
  }
  const remote = await githubTip(clone, defaultBranch, signal)
  if (signal?.aborted) return aborted()
  if ('reason' in remote) return { ok: false, reason: remote.reason }
  const commit = await resolveCommit(clone, revision, signal)
  if (signal?.aborted) return aborted()
  if (commit === undefined) return { ok: false, reason: `commit ${shown(revision, 60)} isn't in the clone` }
  if (!await isAncestor(clone, commit, remote.sha, signal)) {
    if (signal?.aborted) return aborted()
    return { ok: false, reason: `commit ${await describe(clone, commit, signal)} isn't on origin/${shown(defaultBranch, 100)}` }
  }
  return { ok: true }
}

function aborted(): MergedCheck {
  return { ok: false, reason: 'the check was aborted' }
}

/** Run dish's git in `dir`, the commit-graph file off. */
function gitIn(dir: string, args: readonly string[], signal?: AbortSignal): Promise<GitResult> {
  return git([...NO_COMMIT_GRAPH, '-C', dir, ...args], { signal, env: { ...internals.gitEnv } })
}

/** GitHub's default branch tip: `ls-remote --symref origin HEAD`, which must name `refs/heads/<defaultBranch>`, and whose sha must be in the clone. */
async function githubTip(clone: string, defaultBranch: string, signal?: AbortSignal): Promise<{ sha: string } | { reason: string }> {
  const listed = await gitIn(clone, ['ls-remote', '--symref', 'origin', 'HEAD'], signal)
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
    const tip = /^([0-9a-f]{40}|[0-9a-f]{64})\tHEAD$/.exec(entry)
    if (tip !== null) sha = tip[1]
  }
  if (target === undefined || sha === undefined || !target.startsWith('refs/heads/')) {
    return { reason: `${UNCONFIRMED}: origin didn't name its default branch` }
  }
  const branch = target.slice('refs/heads/'.length)
  if (branch !== defaultBranch) {
    return { reason: `${UNCONFIRMED}: GitHub's default branch is ${shown(branch, 100)}, not ${shown(defaultBranch, 100)}` }
  }
  if (await resolveCommit(clone, sha, signal) !== sha) {
    return { reason: `${UNCONFIRMED}: its ${shown(branch, 100)} (${sha.slice(0, 12)}) isn't in the clone; fetch, then try again` }
  }
  return { sha }
}

/** `revision`'s commit in `dir`, or undefined when there is none. */
async function resolveCommit(dir: string, revision: string, signal?: AbortSignal): Promise<string | undefined> {
  const result = await gitIn(dir, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${revision}^{commit}`], signal)
  const sha = result.stdout.trim()
  return result.code === 0 && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha) ? sha : undefined
}

/** Whether `commit` is `tip` or an ancestor of it (an error is a no). */
async function isAncestor(dir: string, commit: string, tip: string, signal?: AbortSignal): Promise<boolean> {
  const result = await gitIn(dir, ['merge-base', '--is-ancestor', commit, tip], signal)
  return result.code === 0 && !result.timedOut && !result.aborted
}

/** A short sha, and the local branches at it (an agent's names, shown safely), for a reason. */
async function describe(dir: string, commit: string, signal?: AbortSignal): Promise<string> {
  const short = commit.slice(0, 12)
  const listed = await gitIn(dir, ['for-each-ref', `--points-at=${commit}`, '--format=%(refname:short)', 'refs/heads/'], signal)
  const names = listed.code === 0 ? listed.stdout.split('\n').filter(name => name !== '').slice(0, 3).map(name => shown(name, 60)) : []
  return names.length === 0 ? short : `${short} (${names.join(', ')})`
}

/** The first non-empty line of git's stderr, masked and cut short. */
function firstLine(stderr: string): string {
  const line = stderr.split(/[\r\n]+/).map(part => part.trim()).find(part => part !== '') ?? ''
  return shown(line, 200)
}

/**
 * Text from outside (a branch name, a path, git's stderr) as it may appear in a reason: no control characters, masked,
 * then cut to `max` characters (masked before the cut, so no part of a secret is left, and after, in case the cut
 * changed what matches).
 */
function shown(text: string, max: number): string {
  const masked = mask(text.slice(0, 64 * 1024).replace(/[\x00-\x1f\x7f]/g, ' '))
  const chars = Array.from(masked)
  return chars.length > max ? mask(`${chars.slice(0, max - 1).join('')}…`) : masked
}

/** The skip message: why, and the command to run instead, e.g. "setup didn't run outside the sandbox: base dish/plan-x isn't on origin/main. Run it yourself in <cwd>: <command>". */
export function skipReason(why: string, cwd: string, command: string): string {
  const reason = why.replace(/\.+$/, '')
  return `setup didn't run outside the sandbox: ${reason}. Run it yourself in ${cwd}: ${command}`
}
