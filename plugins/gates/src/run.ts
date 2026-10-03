/**
 * One gate run, through dsh's sandboxed shell (`ctx.shell`, the executor dsh's bash tool uses).
 *
 * - **Only a sandboxing shell.** The gate runs only when the shell sandboxes (`sandboxMode` is set), and always with an
 *   explicit `workspace-write` policy whose workspace root is the clone: the worktree and the clone's `.git` are
 *   writable, and so is `/tmp` (the call's own, or on dish's VM the machine's: `deploy/dish-sandbox`). dsh's local bash ignores a policy, so with it the gate isn't run at all.
 *   When no sandbox runner works, dsh refuses to run unconfined (`SANDBOX_UNAVAILABLE`): that is an `error` here, and
 *   never a retry. dish-gates runs no process of its own.
 * - **One stream of output.** dsh collects stdout and stderr apart, and the 4 MiB budget is stdout's alone (stderr keeps
 *   the executor's 64 KB). So the command is `exec 2>&1`, a newline, and the gate: its two streams are one, in order.
 *   That also keeps the gate's own stderr from being taken for the runner failing, which dsh decides by `bwrap: ` and
 *   `dish-sandbox: ` on stderr. Anything still on stderr is the runner's own, and comes after the output under a
 *   `[stderr]` line. A sandbox refusal is recognised by "Read-only file system" in the output (`denied`).
 * - **The environment** is the coder's own: dsh's, with dsh's scrub, plus the expanded `gateEnv` (`env.ts`) and nothing
 *   else. No `stdin`, no `DSH_*` facts.
 * - **The timeout** is the project's `gateTimeoutMs`, at most 10 minutes: dish asks for no more than 600 000 ms, and
 *   dsh's executor clamps to its own cap besides. The limit that applied is reported. On a timeout, or when `signal`
 *   aborts, dsh kills the gate's whole process range (bwrap runs it in a PID namespace of its own, with
 *   `--die-with-parent`).
 * - **Secrets.** The output, the command in the log's header, and every error text are masked (dish-kit's
 *   `maskSecrets`) before they reach the log or the result.
 * - **The log** is written for every gate that ran: a header, then the kept output. A log that can't be written leaves
 *   `log: null` and why, and the run's result stands.
 *
 * @module dish-gates/run
 */

import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { ShellExecRequest, ShellExecutor, ShellRunResult } from '@deepseek-ai/dsh-shell'
import { rm } from 'node:fs/promises'
import { maskSecrets } from 'dish-kit'
import { writeLog } from './logs.ts'

/** What is kept of a gate's (joined) output: its last 4 MiB. */
export const OUTPUT_MAX_BYTES = 4_194_304
/** The longest a gate may run: 10 minutes, dsh's executor's default cap. */
export const GATE_MAX_TIMEOUT_MS = 600_000
/** An error's reason, at most. */
const REASON_MAX_CHARS = 300
/** dsh's code for "no sandbox runner works, so the command wasn't run unconfined" (`@deepseek-ai/dsh-sandbox`). */
const SANDBOX_UNAVAILABLE = 'SANDBOX_UNAVAILABLE'
/** Where dsh's SANDBOX_UNAVAILABLE message gives the runner's own failure. */
const RUNNER_FAILURE = ' Runner failure: '
const NO_SANDBOX = 'dsh\'s shell here doesn\'t sandbox commands, so dish won\'t run the gate'
const DENIED = /read-only file system/i

/** The shell's command: stderr joined to stdout, then the gate. */
export function gateCommand(gate: string): string {
  return `exec 2>&1\n${gate}`
}

/** What a gate run uses of dsh's `ctx.shell`. */
export type ShellLike = Pick<ShellExecutor, 'resolve' | 'execute' | 'sandboxMode'>

export interface GateRun {
  shell: ShellLike
  /** projects.yaml's gate, as it is now. */
  command: string
  /** The coder's worktree, and its clone (the sandbox's workspace root), both canonical, from `dishWorkspaces.resolve`. */
  worktree: { path: string, clone: string }
  /** gateTimeoutMs. */
  timeoutMs: number
  /** gateEnvironment(...). */
  env: Record<string, string>
  /** gateLogFile(...). */
  log: string
  /** The turn's, joined with the plugin's. */
  signal: AbortSignal
  /** The coder's session id, for the sandbox policy. */
  sessionId?: string | undefined
  now?: () => number
}

export type GateRunResult =
  | { kind: 'ran', exitCode: number | null, timedOut: boolean, timeoutMs: number, durationMs: number,
      output: string, truncated: boolean, denied: boolean, log: string | null, logProblem?: string }
  | { kind: 'cancelled' }
  | { kind: 'error', reason: string, durationMs: number }

type SessionId = NonNullable<SandboxExecutionPolicy['sessionId']>
type Ran = Extract<GateRunResult, { kind: 'ran' }>

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  try {
    return String(error)
  } catch {
    return 'an error that can\'t be printed'
  }
}

/** `text` on one line, at most `max` characters (an ellipsis where it was cut, never half a surrogate pair). */
function brief(text: string, max: number = REASON_MAX_CHARS): string {
  const line = text.replace(/\s+/g, ' ').trim()
  if (line.length <= max) return line
  let end = max - 1
  const last = line.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end--
  return `${line.slice(0, end)}…`
}

/** Why a rejected run didn't run, masked, on one line, cut. */
function rejection(error: unknown): string {
  let detail = messageOf(error)
  if (errorCode(error) === SANDBOX_UNAVAILABLE) {
    // dsh's message goes on to suggest danger-full-access, which dish never uses: keep only the runner's own words.
    const at = detail.indexOf(RUNNER_FAILURE)
    const runner = at === -1 ? '' : detail.slice(at + RUNNER_FAILURE.length).trim()
    detail = `no sandbox runner works here (${SANDBOX_UNAVAILABLE})${runner === '' ? '' : `: ${runner}`}`
  }
  // Masked first, then cut: a cut can leave the start of a secret that no pattern would match any more.
  return brief(maskSecrets(`the sandbox couldn't run the gate: ${detail}`))
}

/** The shell request: the contract's, and nothing more. */
function request(run: GateRun): ShellExecRequest {
  const policy: SandboxExecutionPolicy = {
    mode: 'workspace-write',
    workspaceRoot: run.worktree.clone,
    ...(run.sessionId === undefined ? {} : { sessionId: run.sessionId as SessionId }),
  }
  return {
    command: gateCommand(run.command),
    workdir: run.worktree.path,
    timeoutMs: Math.min(run.timeoutMs, GATE_MAX_TIMEOUT_MS),
    onExpiry: 'kill',
    stdoutMaxBytes: OUTPUT_MAX_BYTES,
    env: { ...run.env },
    signal: run.signal,
    sandboxPolicy: policy,
  }
}

/**
 * A stream's kept text, masked. A cut stream keeps its tail, which can start partway through a token (that the mask wouldn't
 * know without its prefix) or a character: its first, partial line goes before masking.
 */
function maskedTail(stream: { text: string, truncated: boolean }): string {
  if (!stream.truncated) return maskSecrets(stream.text)
  const lineEnd = stream.text.indexOf('\n')
  return maskSecrets(lineEnd === -1 ? '' : stream.text.slice(lineEnd + 1))
}

/** dsh's full-stream spill files of a cut run: unmasked, and not needed, since the gate keeps its own log. Never throws. */
async function dropSpills(result: ShellRunResult): Promise<void> {
  for (const spill of [result.stdout.spillPath, result.stderr.spillPath]) {
    if (spill !== undefined) await rm(spill, { force: true }).catch(() => undefined)
  }
}

/** The joined output, masked, then whatever the runner itself put on stderr. */
function outputOf(result: ShellRunResult): string {
  const out = maskedTail(result.stdout)
  const err = maskedTail(result.stderr)
  if (err.length === 0) return out
  const separator = out.length === 0 || out.endsWith('\n') ? '' : '\n'
  return `${out}${separator}[stderr]\n${err}`
}

/** The log: its header, then the output. */
function logText(run: GateRun, ran: Omit<Ran, 'log' | 'logProblem'>): string {
  const ended = ran.timedOut
    ? `timed out at ${ran.timeoutMs} ms`
    : ran.exitCode !== null ? `exit ${ran.exitCode}` : 'killed'
  const header = [
    `# gate: ${maskSecrets(run.command).replace(/[\r\n]+/g, ' ')}`,
    `# in: ${run.worktree.path}`,
    `# ended: ${ended}, after ${ran.durationMs} ms`,
    ...(ran.truncated ? ['# output cut: only its last 4 MiB are kept'] : []),
  ]
  return `${header.join('\n')}\n${ran.output}`
}

/** Run one gate. Never throws. */
export async function runGate(run: GateRun): Promise<GateRunResult> {
  const now = run.now ?? Date.now
  const started = now()
  try {
    if (run.shell.sandboxMode === undefined) return { kind: 'error', reason: NO_SANDBOX, durationMs: 0 }
    if (run.signal.aborted) return { kind: 'cancelled' }
    let result: ShellRunResult
    try {
      const spec = run.shell.resolve(request(run))
      const execution = await run.shell.execute(spec)
      result = await execution.result()
    } catch (error) {
      if (run.signal.aborted) return { kind: 'cancelled' }
      return { kind: 'error', reason: rejection(error), durationMs: now() - started }
    }
    const durationMs = now() - started
    await dropSpills(result)
    if (result.aborted || run.signal.aborted) return { kind: 'cancelled' }
    const output = outputOf(result)
    const ran = {
      kind: 'ran' as const,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      timeoutMs: result.timeoutMs,
      durationMs,
      output,
      truncated: result.stdout.truncated,
      denied: DENIED.test(output),
    }
    try {
      return { ...ran, log: await writeLog(run.log, logText(run, ran)) }
    } catch (error) {
      return { ...ran, log: null, logProblem: brief(maskSecrets(messageOf(error))) }
    }
  } catch (error) {
    // dish's own code, or a shell that broke its contract: an error, never a throw.
    return { kind: 'error', reason: brief(maskSecrets(`dish-gates couldn't run the gate: ${messageOf(error)}`)), durationMs: now() - started }
  }
}
