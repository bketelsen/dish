import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { gitEnv } from './git.ts'
import type { Git } from './git.ts'
import { secretKind } from './guard.ts'
import type { StoreNaming } from './store.ts'

const MAIN = 'refs/heads/main'
/** Backoff after a failed push, in milliseconds; the last delay repeats. */
export const DEFAULT_PUSH_DELAYS: readonly number[] = [1_000, 5_000, 30_000, 120_000, 600_000]
/** How long one network git command (push, ls-remote, fetch) may run before its process group is killed. */
export const DEFAULT_PUSH_TIMEOUT_MS = 60_000
/** What is kept of a child's output; a runaway child must not fill memory. */
const MAX_CAPTURE = 256 * 1024
/** After git exits, how long its output pipes may stay open (a background ssh mux master can hold them) before they are given up on. */
const PIPE_GRACE_MS = 1_000
const MAX_ERROR_CHARS = 300
/** The longest delay `setTimeout` takes. */
const MAX_TIMER_MS = 2 ** 31 - 1
const DIVERGED = "remote main has commits this store doesn't have; resolve manually"

/** Where the remote copy stands. */
export interface RemoteStatus {
  /** The configured remote, with any password in its URL masked; absent when none is configured. */
  remote?: string
  /** The `main` commit last pushed successfully by this process; absent until the first success. */
  pushed?: string
  /**
   * Commits on `main` the remote may not have: those after `pushed`, or all of them while nothing
   * has been pushed yet in this process (an upper bound after a restart: the remote may be up to date).
   */
  pending: number
  /** Why the last attempt failed, as one line with credentials masked; absent after a success. */
  lastError?: string
  /** When the last attempt started, in milliseconds since the epoch. */
  lastAttempt?: number
}

export interface PushQueueOptions {
  /** Backoff after each failed attempt in milliseconds, repeating the last. Default 1s, 5s, 30s, 120s, 600s. */
  delays?: number[] | undefined
  /** A push still running after this long is killed, and counts as failed. Default 60 000. */
  timeoutMs?: number | undefined
  /** Called after every change to what `status()` returns, one at a time and in order. A throw is reported as a process warning. */
  onStatus?: ((status: RemoteStatus) => void) | undefined
  /** The store's words for its warnings: `<logName> push loop failed: ...`, with the code `<warningCode>_PUSH`. */
  naming: Pick<StoreNaming, 'logName' | 'warningCode'>
}

// --- the remote, as text ---------------------------------------------------------------------------

/**
 * A remote as it is safe to pass to git as an argument: a non-empty one-line string that
 * git can't read as an option or as the `ext::` transport (which runs a command).
 * @throws a plain `Error`; the messages never repeat the remote, which may hold credentials.
 */
export function checkRemote(remote: unknown): string {
  if (typeof remote !== 'string' || remote.trim() === '') throw new Error('remote must be a non-empty string')
  if (/[\x00-\x1f\x7f]/.test(remote)) throw new Error('remote must not contain control characters')
  const start = remote.trimStart()
  if (start.startsWith('-')) throw new Error('remote must not start with "-"')
  if (/^ext::/i.test(start)) throw new Error('remote must not use the ext:: transport')
  return remote
}

/**
 * `text` as it is safe to show: a password in a URL (`scheme://user:secret@host`) masked, and the
 * whole text replaced by a note if it still looks like a credential. Output of git goes into
 * status, logs and the UI, and credentials can appear in URLs and in what a server says.
 */
export function redact(text: string): string {
  const masked = text.replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^/\s@:]*):[^/\s@]*@/gi, '$1:***@')
  const kind = secretKind(masked)
  return kind === undefined ? masked : `(hidden: it looks like ${kind})`
}

/** The first non-empty line of git's output, without control characters, redacted and cut. `''` if there is none. */
export function firstLine(output: string): string {
  const line = output.split(/\r?\n/).map(part => part.replace(/[\x00-\x1f\x7f]/g, ' ').trim()).find(part => part !== '') ?? ''
  // Redacted before the cut: a cut can leave most of a token that no longer matches a pattern.
  return Array.from(redact(line)).slice(0, MAX_ERROR_CHARS).join('')
}

/**
 * `options`' delays and time limit with the defaults filled in.
 * @throws a plain `Error` if either isn't made of numbers of milliseconds.
 */
export function checkPushOptions(options: Pick<PushQueueOptions, 'delays' | 'timeoutMs'>): { delays: number[], timeoutMs: number } {
  const delays = options.delays ?? [...DEFAULT_PUSH_DELAYS]
  if (!Array.isArray(delays) || delays.length === 0 || !delays.every(delay => typeof delay === 'number' && delay >= 0 && delay <= MAX_TIMER_MS)) {
    throw new Error('push delays must be a non-empty list of milliseconds')
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_PUSH_TIMEOUT_MS
  if (!(typeof timeoutMs === 'number' && timeoutMs > 0 && timeoutMs <= MAX_TIMER_MS)) {
    throw new Error('the push time limit must be a positive number of milliseconds')
  }
  return { delays: [...delays], timeoutMs }
}

// --- running git against a remote ------------------------------------------------------------------

export interface NetworkResult {
  /** The exit code; `-1` if the process was ended by a signal. */
  code: number
  stdout: string
  stderr: string
  /** `true` if the time limit ended it. */
  timedOut: boolean
  /** `true` if `kill()` or the time limit ended it. */
  killed: boolean
}

export interface NetworkRun {
  /** Resolves when the process is over (and for a failing git too); rejects only if git can't be run at all. */
  done: Promise<NetworkResult>
  /** End the process and everything it started. Does nothing once it has exited. */
  kill(): void
}

/**
 * Run `git` with `args` where a person could be asked for something, and must never be waited for:
 * - `detached`: a new session, so no controlling terminal; ssh can't prompt on `/dev/tty`, and a
 *   host-key or passphrase question fails instead of hanging.
 * - no stdin; a scrubbed environment (`gitEnv`) that keeps the user's `GIT_SSH*`, `GIT_ASKPASS`,
 *   `GIT_CONFIG_GLOBAL` and the like, and sets `GIT_TERMINAL_PROMPT=0`.
 * - a hard time limit that kills the whole process group (git, ssh, hooks, helpers).
 * Not the store's `Git.run`: that one has no limit and shares the terminal.
 */
export function runNetworkGit(args: string[], timeoutMs: number): NetworkRun {
  const child: ChildProcess = spawn('git', args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv() })
  let exited = false
  let killed = false
  let timedOut = false
  const killGroup = (): void => {
    // Once the process has exited its group id may be anyone's.
    if (exited || child.pid === undefined) return
    killed = true
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      // No such group (or no groups on this platform): the process itself, at least.
      try { child.kill('SIGKILL') } catch { /* already gone */ }
    }
  }
  const done = new Promise<NetworkResult>((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    const capture = (stream: NodeJS.ReadableStream | null, add: (chunk: string) => void): void => {
      stream?.setEncoding('utf8')
      stream?.on('data', (chunk: string) => add(chunk))
      stream?.on('error', () => {})
    }
    capture(child.stdout, chunk => { if (stdout.length < MAX_CAPTURE) stdout += chunk })
    capture(child.stderr, chunk => { if (stderr.length < MAX_CAPTURE) stderr += chunk })
    const timer = setTimeout(() => {
      // Exited, and only waiting out the pipes: that is not a timeout.
      if (exited) return
      timedOut = true
      killGroup()
    }, timeoutMs)
    let grace: NodeJS.Timeout | undefined
    let settled = false
    const finish = (code: number | null, failure?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(grace)
      child.stdout?.destroy()
      child.stderr?.destroy()
      if (failure !== undefined) reject(failure)
      else resolve({ code: code ?? -1, stdout, stderr, timedOut, killed })
    }
    child.on('error', error => finish(null, error))
    child.on('exit', code => {
      exited = true
      // The pipes close with the process unless something it started (ssh's multiplexing master) kept them.
      grace = setTimeout(() => finish(code), killed ? 0 : PIPE_GRACE_MS)
    })
    child.on('close', code => finish(code))
  })
  return { done, kill: killGroup }
}

/**
 * Fetch the remote's `main` into `git`, a freshly initialized bare repository (SHA-1, loose refs,
 * `HEAD` on `main`: see `Git.initBare`). `ls-remote` first, so that a remote that can't be
 * reached is told apart from one that has nothing yet.
 * @returns `true` once `refs/heads/main` is there and checked; `false` if the remote has no `main`.
 * @throws a plain `Error` with git's first line if the remote can't be reached or fetched from,
 *   or if what came is not a SHA-1, loose-refs repository with a `main` commit.
 */
export async function fetchRemoteMain(remote: string, git: Git, timeoutMs: number): Promise<boolean> {
  checkRemote(remote)
  const shown = redact(remote)
  const network = async (what: string, args: string[]): Promise<NetworkResult> => {
    const result = await runNetworkGit([`--git-dir=${git.gitDir}`, '-c', 'protocol.ext.allow=never', ...args], timeoutMs).done
    if (result.timedOut) throw new Error(`git ${what} timed out after ${timeoutMs} ms (remote ${shown})`)
    if (result.code !== 0) throw new Error(`cannot read the remote ${shown}: ${firstLine(result.stderr) || `git ${what} failed (exit ${result.code})`}`)
    return result
  }
  // `--git-dir` on both: outside a repository git would look for one from the working directory, and read its config.
  const listing = await network('ls-remote', ['ls-remote', '--', remote, MAIN])
  if (!listing.stdout.split('\n').some(line => line.split('\t')[1] === MAIN)) return false
  await network('fetch', [
    '-c', 'gc.auto=0', '-c', 'maintenance.auto=false',
    'fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--', remote, `+${MAIN}:${MAIN}`,
  ])
  const format = (await git.run(['rev-parse', '--show-object-format'])).stdout.trim()
  if (format !== 'sha1') throw new Error(`the remote ${shown} uses ${format}, not sha1`)
  const refs = (await git.run(['config', '--get', 'extensions.refstorage'], { allowFail: true })).stdout.trim()
  if (refs !== '') throw new Error(`the fetched repository uses ${refs} ref storage, not files`)
  if ((await git.resolve(MAIN)) === undefined) throw new Error(`the remote ${shown} has no usable ${MAIN}`)
  return true
}

// --- the push queue --------------------------------------------------------------------------------

/** A process warning from the queue: `message` after the store's `logName`, with the code `<warningCode>_PUSH`. */
function warn(naming: PushQueueOptions['naming'], message: string): void {
  process.emitWarning(`${naming.logName} ${message}`, { code: `${naming.warningCode}_PUSH` })
}

/**
 * Pushes `main` to a remote, one push at a time, off to the side of everything else: it takes no
 * lock of the store and runs on no queue of it, so a slow or dead network never holds up a write.
 *
 * - `schedule()` after every commit. A push already running is not interrupted: the queue
 *   notes that more has come and pushes once more when it is done, so a burst of writes costs a
 *   few pushes, not one each.
 * - A failed push is retried after a delay that grows (`delays`, the last repeating) and starts over
 *   after a success. A new commit shortens a retry that is waiting longer than the first delay to the first
 *   delay (so a save after a long outage is tried within a moment, not minutes), and never lengthens one. It
 *   doesn't touch the count of failures: if the remote is still dead, the wait goes straight back to the long delay.
 * - It is `git push --porcelain <remote> refs/heads/main:refs/heads/main`, to the URL itself and never
 *   forced: no remote is configured in the repository, no tracking ref is written, no local ref
 *   is locked. A rejection means the remote has commits this store lacks (another machine pushed);
 *   that is reported and retried on the same schedule, and never forced.
 * - `runNetworkGit` runs it: no terminal to ask on, and killed after `timeoutMs`.
 */
export class PushQueue {
  private readonly git: Git
  private readonly remote: string
  private readonly delays: number[]
  private readonly timeoutMs: number
  private readonly onStatus: ((status: RemoteStatus) => void) | undefined
  private readonly naming: PushQueueOptions['naming']
  private pushed: string | undefined
  private lastError: string | undefined
  private lastAttempt: number | undefined
  private failures = 0
  private timer: NodeJS.Timeout | undefined
  /** When the waiting retry fires, in milliseconds since the epoch; only meaningful while `timer` is set. */
  private due = 0
  private running: Promise<void> | undefined
  private current: NetworkRun | undefined
  private again = false
  private closed = false
  private notifying = false
  private notifyAgain = false

  /** @throws a plain `Error` for a `remote` that `checkRemote` refuses, or delays or a time limit that aren't numbers of milliseconds. */
  constructor(git: Git, remote: string, options: PushQueueOptions) {
    this.git = git
    this.remote = checkRemote(remote)
    const { delays, timeoutMs } = checkPushOptions(options)
    this.delays = delays
    this.timeoutMs = timeoutMs
    this.onStatus = options.onStatus
    this.naming = { logName: options.naming.logName, warningCode: options.naming.warningCode }
  }

  /** A commit has landed on `main` (or this is a start): push soon. Never throws, never waits. */
  schedule(): void {
    if (this.closed) return
    // Running: pushed again when it ends (or, if it fails, tried soon). Backing off: the coming retry carries it.
    if (this.running !== undefined) this.again = true
    else if (this.timer === undefined) this.start()
    else if (this.due - Date.now() > this.delays[0]!) this.arm(this.delays[0]!)
    this.notify()
  }

  /** Where the remote copy stands, with `pending` counted now. */
  async status(): Promise<RemoteStatus> {
    const { pushed, lastError, lastAttempt } = this
    const status: RemoteStatus = { remote: redact(this.remote), pending: await this.countPending(pushed) }
    if (pushed !== undefined) status.pushed = pushed
    if (lastError !== undefined) status.lastError = lastError
    if (lastAttempt !== undefined) status.lastAttempt = lastAttempt
    return status
  }

  /**
   * Stop: drop a waiting retry, kill a push in flight (its whole process group) and push no more.
   * Resolves once the push has ended. Safe to call again.
   */
  close(): Promise<void> {
    this.closed = true
    clearTimeout(this.timer)
    this.timer = undefined
    this.current?.kill()
    return this.running ?? Promise.resolve()
  }

  private start(): void {
    this.running = this.loop()
      .catch(error => warn(this.naming, `push loop failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => { this.running = undefined })
  }

  private async loop(): Promise<void> {
    for (;;) {
      this.again = false
      const ok = await this.attempt()
      if (this.closed) return
      if (!ok) {
        // A commit that came in during the attempt may be newer than what it tried: not left waiting for the long delay either.
        this.backOff(this.again)
        return
      }
      if (!this.again) return
    }
  }

  /** Wait before the next try: the delay for this many failures, or the first delay if a commit came in meanwhile. */
  private backOff(sooner: boolean): void {
    const delay = this.delays[Math.min(this.failures - 1, this.delays.length - 1)]!
    this.arm(sooner ? Math.min(delay, this.delays[0]!) : delay)
  }

  private arm(delay: number): void {
    clearTimeout(this.timer)
    this.due = Date.now() + delay
    // A retry that is only waiting must not keep an otherwise finished process alive.
    this.timer = setTimeout(() => {
      this.timer = undefined
      if (!this.closed && this.running === undefined) this.start()
    }, delay)
    this.timer.unref()
  }

  /** One push. Resolves `true` on success, `false` on any failure (recorded in `lastError`); never rejects. */
  private async attempt(): Promise<boolean> {
    this.lastAttempt = Date.now()
    let failure: string | undefined
    let head: string | undefined
    try {
      head = await this.git.resolve(MAIN)
      if (head === undefined) throw new Error(`${MAIN} does not exist`)
      if (this.closed) return false
      this.current = runNetworkGit([
        `--git-dir=${this.git.gitDir}`, '-c', 'protocol.ext.allow=never',
        'push', '--porcelain', '--no-verify', '--', this.remote, `${MAIN}:${MAIN}`,
      ], this.timeoutMs)
      const result = await this.current.done
      this.current = undefined
      if (this.closed) return false
      if (result.timedOut) failure = `git push timed out after ${this.timeoutMs} ms`
      else if (result.code === 0) failure = undefined
      // `[rejected]` (and not `[remote rejected]`, which a hook or a branch protection says) is the remote having moved on.
      else if (/^!\t.*\[rejected\]/m.test(result.stdout)) failure = DIVERGED
      else failure = firstLine(result.stderr) || `git push failed (exit ${result.code})`
    } catch (error) {
      this.current = undefined
      failure = firstLine(error instanceof Error ? error.message : String(error)) || 'git push failed'
    }
    if (this.closed) return false
    if (failure === undefined) {
      this.pushed = head
      this.lastError = undefined
      this.failures = 0
    } else {
      this.lastError = failure
      this.failures++
    }
    this.notify()
    return failure === undefined
  }

  private async countPending(pushed: string | undefined): Promise<number> {
    if (pushed !== undefined) {
      const result = await this.git.run(['rev-list', '--count', `${pushed}..${MAIN}`, '--'], { allowFail: true })
      if (result.code === 0) return Number(result.stdout.trim())
    }
    return Number((await this.git.run(['rev-list', '--count', MAIN, '--'])).stdout.trim())
  }

  /** Tell `onStatus`, once per burst of changes, in order, with the status as it is by then. */
  private notify(): void {
    if (this.onStatus === undefined || this.closed) return
    if (this.notifying) {
      this.notifyAgain = true
      return
    }
    this.notifying = true
    void this.deliver(this.onStatus)
  }

  private async deliver(onStatus: (status: RemoteStatus) => void): Promise<void> {
    try {
      do {
        this.notifyAgain = false
        const status = await this.status()
        if (this.closed) return
        try {
          await onStatus(status)
        } catch (error) {
          warn(this.naming, `onRemoteStatus callback threw: ${error instanceof Error ? error.message : String(error)}`)
        }
      } while (this.notifyAgain && !this.closed)
    } catch (error) {
      warn(this.naming, `could not read the remote status: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.notifying = false
    }
  }
}
