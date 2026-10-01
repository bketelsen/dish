/**
 * The command gate: a host-level `tools/pre-execute` listener that asks the judge about every shell call before it runs.
 *
 * What it does, and what it leaves to others:
 *
 * - **Which calls.** A call is gated when its tool is in `tools.gated` (a plain name, or a prefix ending in `*`), it has an
 *   agent (without one there is no telling a main agent from a child, so it goes to `next()`), and it is not `ask_judge` or
 *   `run_code`. `ask_judge` is the judge's own tool and gating it would only slow the question down; `run_code` is PTC's
 *   transport, whose inner calls (`bash`, `pwsh`) each come through here by themselves, with `exec.parent` set.
 * - **One question, two answers.** The state (`command`, `cwd`, `workspace`, `escalation`, `task`) and the two questions
 *   (`effect`, `serves_task`) are the spec's, as constants below. The answers become a verdict by the spec's table: allow,
 *   ask you (the main agent), or deny (a crew child). A judge that is unavailable in any way, that gives answers the gate
 *   can't read, or whose `decide` hook did not come back, is **unavailable**, and unavailable asks you or denies a child.
 *   Nothing here lets a command run on a failure.
 * - **No log of its own.** The client writes one line for each call it makes. The gate passes `decide`, which gives that
 *   line the verdict (`allow`, `ask` or `deny`), and `tool`, `callId` and `subject` (the command), so there is one line per
 *   decision. The client masks the TypeSafe key in the line, and the decision log (`log.ts`) masks secrets when it writes it.
 * - **Others have their say, except on a deny.** The gate is prepended, so it is first in the waterfall. For its own `allow` or
 *   `ask` it calls `next()` and returns the stricter of the two (allow < ask < deny < cancel): a later listener that denies or
 *   cancels wins, and the gate never lets a human approve over it. Its own `deny` is final and `next()` is not called, as in
 *   dsh's auto-review: a call that will not run should not start the `PreToolUse` hooks or recorders after it.
 * - **A verdict cache** (`VerdictCache`, below) is written before `next()` is called and read by the approval answerer.
 *
 * ### What was found in dsh 0.2.0-rc.2, and where the state comes from
 *
 * Read from the installed `.d.ts` files and sources (`node_modules/@deepseek-ai/*`), not guessed:
 *
 * - **The arguments.** `bash` (`dsh-tool-bash`) and `pwsh` (`dsh-tool-pwsh`) take `{ command: string, description: string,
 *   timeoutMs?, workdir?, run_in_background?, sandbox_permissions?, justification? }`; the persistent variants
 *   (`dsh-tool-bash-persistent`, `dsh-tool-pwsh-persistent`) take `{ command }` alone. So `command` is the text to judge. The
 *   tools validate their own arguments, so by the time the gate sees them they are not necessarily well formed; a call
 *   whose `command` is not a string is judged on `bash({...JSON of its arguments...})`, and any other gated tool is judged
 *   on its name and all its arguments the same way (see `commandOf`).
 *   `sandbox_permissions` and `justification` are the escalation: a call with both asks the approval service for a wider
 *   sandbox mode before it runs, from inside the tool.
 * - **The working directory.** `exec.agent.session.header.cwd` is the session's cwd (`SessionHeader.cwd`, absolute, optional).
 *   `bash` and `pwsh` run in `workdir` instead when the model passes one (an absolute path is used as it is, a relative one is
 *   resolved against the session's cwd), so `cwd` in the state is that directory, because it is where the command runs.
 * - **The workspace.** `ctx.get('sandboxPolicy')` (`dsh-sandbox-policy`, a sibling of this plugin, so never a property)
 *   has `resolve({ session })`, which returns `{ mode, workspaceRoot, sessionId }`; `workspaceRoot` is the session's cwd, made
 *   canonical (symlinks resolved), or the service's configured root when the session has none. It is what the sandbox
 *   enforces, and what `bash` itself uses. With no such service, or if it throws, the workspace is `cwd`.
 * - **The task.** `exec.agent.session.snapshotEvents(fromSeq?)` returns the session's frozen events; a `user/message` event's
 *   `data` is a `UserMessage` `{ id, role: 'user', content: ContentBlock[], source }`, and `source.kind === 'user'` marks a
 *   prompt that a human (or, for a child, its parent's brief) wrote, as against context dsh injected (`goal`, `schedule`,
 *   `user-approval`, tool results and so on). For a top-level agent the task is the last such message; for a child it is the
 *   first one among its own events, which `session.inheritedEventCount` says where they start (a forked child's log begins
 *   with its parent's). Text blocks only, joined, cut to 4000 characters. `snapshotEvents` is marked deprecated in dsh ("new
 *   calls are prohibited", for dsh's own code, which should read projections), because it assumes the whole log is in
 *   memory; in 0.2.0-rc.2 it is, there is no other synchronous way to the prompt, and the turn-outline's prompt is a
 *   one-line preview. If it is missing or throws, the task is `''`: the judge then reads every command as not serving a task
 *   it can't see, and the gate asks you more often. A crew child's brief carries a trailing guidance block ("Your parent
 *   agent id is …"), and a compacted-away or image-only first message leaves nothing to read; both are accepted.
 *   The route dsh prefers, for a later follow-up: a `session/event` listener (emit mode, one per session) that keeps
 *   `WeakMap<Session, { brief, latest }>`, filled from each `user/message` event with `source.kind === 'user'` (the brief is
 *   the first one after `inheritedEventCount`). It needs no read of the log, but it also misses what was said before the
 *   plugin loaded or the session was resumed, which a projection registered with `ctx.sessionProjections` would not.
 *
 * @module dish-judge/gate
 */

import { createHash } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { isTopLevelAgent } from 'dish-kit'
import type { Decision, Judge, JudgeAgent, JudgeResult, JsonValue, Question } from './client.ts'
import { ASK_JUDGE_TOOL } from './ask.ts'
import { DEFAULT_SETTINGS } from './settings.ts'
import type { JudgeSettings } from './settings.ts'

// --- the questions: they live in code and are reviewed like code ------------------------------------

/** What running the command would do. The options and their wording are the spec's. */
export const EFFECT_QUESTION: Question = {
  type: 'choice',
  instructions: 'What would running `command` from `cwd` do to files, systems and data?',
  criteria: {
    read_only: 'it only reads or reports',
    reversible: 'it changes files inside `workspace` in a way git or rerunning can undo',
    irreversible: 'it deletes or overwrites data that can\'t be recovered, changes things outside `workspace`, publishes, pushes, merges, deploys, sends, or spends',
    other: null,
  },
}

/**
 * `EFFECT_QUESTION` for a call that asks for a wider sandbox (`escalation` is in the state). The spec's question names only
 * `command`, but the gate's verdict is also what lets the escalation through, so the judge is told to read it too. Same
 * options. A call with no escalation is asked the spec's question, word for word.
 */
export const EFFECT_WITH_ESCALATION_QUESTION: Question = {
  ...EFFECT_QUESTION,
  instructions: 'What would running `command` from `cwd`, with the extra access requested in `escalation`, do to files, systems and data?',
}

/** Whether the command belongs to the task. */
export const SERVES_TASK_QUESTION: Question = {
  type: 'noul',
  instructions: 'Is running `command` a reasonable step toward `task`?',
}

/** The task is cut to this many characters. */
export const MAX_TASK_CHARS = 4000
/** A justification is cut to this many characters. */
const MAX_JUSTIFICATION_CHARS = 1000

/**
 * Tools that are never gated, whatever `tools.gated` says: the judge's own tool (a question to the judge is not a command, and
 * `*` or `a*` in the list would otherwise put it behind itself), and PTC's `run_code`, whose inner calls are gated one by
 * one. The names are dsh's (`RUN_CODE_NAME` in `dsh-tools`) and `ask.ts`'s.
 */
const NEVER_GATED: ReadonlySet<string> = new Set([ASK_JUDGE_TOOL, 'run_code'])

/** Probabilities are compared with this much give, so 0.5 + 0.45 reaches 0.95 as a person reads it. */
const EPSILON = 1e-9

// --- the words --------------------------------------------------------------------------------------

/** How each option of `effect` reads in a sentence. */
const EFFECT_WORDS: Readonly<Record<string, string>> = {
  read_only: 'read-only',
  reversible: 'reversible',
  irreversible: 'irreversible',
  other: 'something else',
}

const UNAVAILABLE_ASK = 'The command needs your approval because the judge is unavailable.'
const UNAVAILABLE_DENY = 'The command was refused because the judge is unavailable; nothing ran. Report it to the main agent instead, or try again later.'

const p2 = (probability: number): string => probability.toFixed(2)

// --- the verdict cache ------------------------------------------------------------------------------

/** What the gate decided about a call, as the approval answerer needs it. */
export type VerdictKind = 'allow' | 'ask' | 'deny'

/** What the gate remembers about one call. */
export interface VerdictEntry {
  /** The gate's decision for the call, after any other listener's: `ask` means a human is being asked. */
  readonly verdict: VerdictKind
  /**
   * `true` when the call carried a sandbox escalation (`sandbox_permissions`), the judge was shown it, and the verdict is
   * `allow`: the verdict covers the escalation, so the approval request it leads to may be answered `allowed-once`. Always
   * `false` for an `ask` or a `deny`, and for a call with no escalation.
   */
  readonly escalationCovered: boolean
  /** When it was written, on the cache's monotonic clock, in ms. */
  readonly at: number
  /** The gate's own: lets it see that it has already decided this call. The answerer ignores it. */
  readonly memo?: { readonly key: string, readonly decision: PreToolDecision }
}

/** What `set` takes: the entry, and the clock supplies `at`. */
export type VerdictInput = Pick<VerdictEntry, 'verdict' | 'escalationCovered' | 'memo'>

export interface VerdictCacheOptions {
  /** A monotonic clock, in ms. Defaults to `performance.now()`. For tests. */
  now?: () => number
  /** How long an entry is kept: 10 minutes. */
  ttlMs?: number
  /** How many entries are kept: 1000. The oldest are evicted. */
  max?: number
}

/** How long an entry lives if no `tools/result` removes it first. */
export const VERDICT_TTL_MS = 10 * 60 * 1000
/** The most entries the cache holds. */
export const VERDICT_MAX_ENTRIES = 1000

/**
 * The gate's verdicts by agent and call id, for the approval answerer: `get(owner, callId)`, where `owner` is
 * `verdictOwner(request.agent)` (the agent's id).
 *
 * - **An entry goes** when the call settles (`registerCommandGate` deletes it on `tools/result`), after 10 minutes, or when it
 *   is the oldest of more than 1000. Expiry is on a monotonic clock, so a wall clock set back or forward changes nothing; the
 *   clock can be given for tests.
 * - **Bounded.** No more than `max` entries are ever held. Writing an entry that is there already makes it the newest.
 * - **The key is the agent and the call id.** A call id is the model provider's, unique within one session and not across
 *   them (dsh-llm falls back to `call-${index}` when a provider gives none), so two agents can make calls with the same id at
 *   once. Keyed by call id alone, one agent's `allow` could overwrite another's `ask` before the approval request reads it,
 *   and a command that was to be put to a human would run. `delete` removes one agent's entry and no other's.
 */
export class VerdictCache {
  readonly #entries = new Map<string, VerdictEntry>()
  readonly #now: () => number
  readonly #ttlMs: number
  readonly #max: number

  constructor(options: VerdictCacheOptions = {}) {
    this.#now = options.now ?? (() => performance.now())
    this.#ttlMs = options.ttlMs ?? VERDICT_TTL_MS
    this.#max = options.max ?? VERDICT_MAX_ENTRIES
  }

  /** The entry for this agent's call `callId`, or `undefined` if there is none or it has expired (which also drops it). */
  get(owner: string, callId: string): VerdictEntry | undefined {
    const key = keyOf(owner, callId)
    const entry = this.#entries.get(key)
    if (entry === undefined) return undefined
    if (this.#expired(entry)) {
      this.#entries.delete(key)
      return undefined
    }
    return entry
  }

  /** Write the entry for this agent's call `callId`, making it the newest, and drop what has expired and what is over the limit. */
  set(owner: string, callId: string, input: VerdictInput): void {
    const key = keyOf(owner, callId)
    this.#entries.delete(key)
    this.#entries.set(key, {
      verdict: input.verdict,
      escalationCovered: input.escalationCovered,
      at: this.#now(),
      ...input.memo === undefined ? {} : { memo: input.memo },
    })
    // The map is in the order of `at`, so what has expired, and what is oldest, is at the front.
    for (const [oldKey, entry] of this.#entries) {
      if (!this.#expired(entry)) break
      this.#entries.delete(oldKey)
    }
    while (this.#entries.size > this.#max) {
      const oldest = this.#entries.keys().next()
      if (oldest.done === true) break
      this.#entries.delete(oldest.value)
    }
  }

  /** Forget this agent's call `callId`; the same call id of another agent stays. */
  delete(owner: string, callId: string): void {
    this.#entries.delete(keyOf(owner, callId))
  }

  /** How many entries are held, expired ones that have not been dropped yet included. */
  get size(): number {
    return this.#entries.size
  }

  #expired(entry: VerdictEntry): boolean {
    return this.#now() - entry.at >= this.#ttlMs
  }
}

/** One key for an agent and a call id, whatever characters either has. */
function keyOf(owner: string, callId: string): string {
  return JSON.stringify([owner, callId])
}

// --- reading the call -------------------------------------------------------------------------------

/** The parts of a dsh `Agent` the gate reads: its id, its session's header, and the session's events. */
export type GateAgent = JudgeAgent & {
  readonly session?: {
    readonly id?: unknown
    readonly header?: { readonly cwd?: unknown }
    readonly inheritedEventCount?: unknown
    snapshotEvents?(fromSeq?: number): readonly unknown[]
  }
}

/**
 * The `owner` of an agent's entries in the `VerdictCache`: its id (`Agent.id`, the session id), which is what a tool call's
 * `exec.agent` and an approval request's `agent` both carry. An agent with no id at all has the empty owner, and shares
 * entries with others that have none; every agent dsh makes has one.
 */
export function verdictOwner(agent: { readonly id?: unknown, readonly session?: { readonly id?: unknown } } | undefined): string {
  const id = agent?.id ?? agent?.session?.id
  return typeof id === 'string' || typeof id === 'number' ? String(id) : ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A string with something in it, else `undefined`: a model fills every optional parameter, often with `''`. */
function given(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/** `text` cut to `max` characters, with a `…` where it was cut and no half of a surrogate pair left. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text
  let end = max - 1
  const last = text.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end -= 1
  return `${text.slice(0, end)}…`
}

/** The tools whose `command` is the whole of what they run: the two shells. */
const SHELLS: ReadonlySet<string> = new Set(['bash', 'pwsh'])

/**
 * The text the gate judges, which is the state's `command`. For `bash` and `pwsh` it is their `command`. Any other gated tool
 * is judged on all its arguments and its name, as `<tool>(<JSON of the arguments>)`: `mcp__ssh__run({"host":"prod-db",
 * "command":"rm -rf /"})` has `host` in it, which `command` alone would hide. One key (`command`) and one question
 * wording serve both, which is why this is not a separate `tool` field. A shell call whose `command` is not a string (the
 * tool refuses it itself) is judged the same way, on what it was called with.
 */
function commandOf(name: string, args: unknown): string {
  if (SHELLS.has(name) && isRecord(args)) {
    const command = given(args.command)
    if (command !== undefined) return command
  }
  let json: string | undefined
  try {
    json = JSON.stringify(args)
  } catch {
    // Not JSON: nothing to show but the name.
  }
  return `${name}(${json ?? ''})`
}

/** `sandbox_permissions` and the `justification` that goes with it, as one line; `undefined` for a call without them (a shell's arguments only: for any other tool they are in the JSON already). */
function escalationOf(args: unknown): string | undefined {
  if (!isRecord(args)) return undefined
  const permissions = given(args.sandbox_permissions)
  if (permissions === undefined) return undefined
  const justification = given(args.justification)
  return justification === undefined
    ? `sandbox_permissions: ${permissions}`
    : `sandbox_permissions: ${permissions}; justification: ${clip(justification, MAX_JUSTIFICATION_CHARS)}`
}

/** Where the command runs: `workdir` if the call names one (as `bash` and `pwsh` resolve it), else the session's cwd. */
function directoryOf(args: unknown, sessionCwd: string | undefined): string | undefined {
  const workdir = isRecord(args) ? given(args.workdir) : undefined
  if (workdir === undefined) return sessionCwd
  if (isAbsolute(workdir) || sessionCwd === undefined) return workdir
  return resolve(sessionCwd, workdir)
}

/** The text of a message a human wrote (`source.kind === 'user'`), or `undefined` for any other. */
function promptText(data: unknown): string | undefined {
  if (!isRecord(data) || data.role !== 'user') return undefined
  const source = data.source
  if (!isRecord(source) || source.kind !== 'user') return undefined
  const content = data.content
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const block of content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  const text = parts.join('\n').trim()
  return text === '' ? undefined : text
}

/**
 * The agent's task: a top-level agent's latest prompt, or a child's brief (its first). `''` when it can't be read, which
 * every way of failing comes to (see the file's notes). Never throws.
 */
export function taskOf(agent: GateAgent, topLevel: boolean): string {
  try {
    const session = agent.session
    if (typeof session?.snapshotEvents !== 'function') return ''
    if (topLevel) {
      const events = session.snapshotEvents()
      for (let index = events.length - 1; index >= 0; index--) {
        const event = events[index]
        const text = isRecord(event) && event.type === 'user/message' ? promptText(event.data) : undefined
        if (text !== undefined) return clip(text, MAX_TASK_CHARS)
      }
      return ''
    }
    const inherited = typeof session.inheritedEventCount === 'number' && session.inheritedEventCount > 0 ? session.inheritedEventCount : 0
    for (const event of session.snapshotEvents(inherited)) {
      const text = isRecord(event) && event.type === 'user/message' ? promptText(event.data) : undefined
      if (text !== undefined) return clip(text, MAX_TASK_CHARS)
    }
  } catch {
    // Not a session we can read.
  }
  return ''
}

/** The sandbox policy's view of the workspace for an agent: its resolved `workspaceRoot`, or `undefined` if there is none. */
export type WorkspaceRoot = (agent: GateAgent) => string | undefined

/** `WorkspaceRoot` over `ctx.get('sandboxPolicy')`, looked up on every call (the service is a sibling's, and may come and go). */
export function workspaceRootFrom(ctx: Context): WorkspaceRoot {
  return (agent) => {
    try {
      const policy = (ctx as unknown as { get(name: string): unknown }).get('sandboxPolicy')
      if (!isRecord(policy) || typeof policy.resolve !== 'function') return undefined
      const resolved: unknown = policy.resolve({ session: agent.session })
      return isRecord(resolved) ? given(resolved.workspaceRoot) : undefined
    } catch {
      return undefined
    }
  }
}

/** Whether `name` is one of `patterns`: a plain entry must match exactly, an entry ending in `*` is a prefix. */
export function isGated(name: string, patterns: readonly string[]): boolean {
  if (NEVER_GATED.has(name)) return false
  return patterns.some(pattern => pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern)
}

// --- the decision -----------------------------------------------------------------------------------

/** What `decide` returns: the word for the log line, and what the gate answers dsh. */
interface Outcome extends Decision {
  decision: VerdictKind | 'cancel'
  pre: PreToolDecision
}

function unavailable(topLevel: boolean): Outcome {
  return topLevel
    ? { decision: 'ask', pre: { kind: 'ask', reason: UNAVAILABLE_ASK, displayReason: { en: UNAVAILABLE_ASK } } }
    : { decision: 'deny', pre: { kind: 'deny', reason: UNAVAILABLE_DENY } }
}

/** The numbers the table reads, from the checked answers; `undefined` if they are not what was asked for. */
function readings(result: JudgeResult): { choice: string, probabilities: Record<string, number>, serves: number } | undefined {
  if (!result.ok) return undefined
  const effect = result.answers.effect
  const serves = result.answers.serves_task
  if (effect?.type !== 'choice' || serves?.type !== 'noul') return undefined
  return { choice: effect.choice, probabilities: effect.probabilities, serves: serves.noul }
}

/**
 * The spec's table. Allow when the command serves the task and either P(read_only) reaches `readOnly` or P(read_only) +
 * P(reversible) reaches `reversible`, and the likeliest reading is not `irreversible` (the spec says it for the second
 * row; both rows say it here, which only matters with a `readOnly` set below one half). Anything else is not let through:
 * the main agent is asked, with the judge's reading, and a child is refused, with the reading, written for the model.
 */
export function decideCommand(result: JudgeResult, settings: JudgeSettings, topLevel: boolean): Outcome {
  const seen = readings(result)
  if (seen === undefined) return unavailable(topLevel)
  const { readOnly, reversible, servesTask } = settings.commands
  const pRead = seen.probabilities.read_only ?? 0
  const pReversible = seen.probabilities.reversible ?? 0
  const serves = seen.serves + EPSILON >= servesTask
  const effectOk = seen.choice !== 'irreversible' && (pRead + EPSILON >= readOnly || pRead + pReversible + EPSILON >= reversible)
  if (serves && effectOk) return { decision: 'allow', pre: { kind: 'allow' } }

  const label = EFFECT_WORDS[seen.choice] ?? seen.choice
  const chosen = p2(seen.probabilities[seen.choice] ?? 0)
  if (topLevel) {
    const task = serves ? `as serving the task (p ${p2(seen.serves)})` : `as unlikely to serve the task (p ${p2(seen.serves)})`
    const reason = `The judge reads this as ${label} (p ${chosen}), and ${task}.`
    return { decision: 'ask', pre: { kind: 'ask', reason, displayReason: { en: reason } } }
  }
  const causes: string[] = []
  if (!effectOk) causes.push(`it reads as ${label} (p ${chosen})`)
  if (!serves) causes.push(`it doesn't look like it serves the task (p ${p2(seen.serves)})`)
  const way = !effectOk && !serves ? 'a reversible way that serves the task' : !effectOk ? 'a reversible way' : 'a step that serves the task'
  return { decision: 'deny', pre: { kind: 'deny', reason: `The judge didn't let this run: ${causes.join(', and ')}. Report it to the main agent instead, or find ${way}.` } }
}

const STRICTNESS: Readonly<Record<PreToolDecision['kind'], number>> = { allow: 0, ask: 1, deny: 2, cancel: 3 }

/** The stricter of two decisions. When they are as strict as each other, `ours` — except that an `allow` is `theirs`. */
function stricter(ours: PreToolDecision, theirs: PreToolDecision): PreToolDecision {
  if (STRICTNESS[theirs.kind] > STRICTNESS[ours.kind]) return theirs
  return ours.kind === 'allow' ? theirs : ours
}

const verdictOf = (decision: PreToolDecision): VerdictKind =>
  decision.kind === 'allow' ? 'allow' : decision.kind === 'ask' ? 'ask' : 'deny'

// --- the listener -----------------------------------------------------------------------------------

export interface CommandGateDeps {
  /** The Jev client, looked up for each call. Without one (or if it throws) the judge is unavailable. */
  judge(): Pick<Judge, 'ask'> | undefined
  /** The settings now. It should never reject; if it does, the shipped default is used. */
  settings(): Promise<JudgeSettings>
  /** The sandbox policy's workspace root for an agent. Without it, or when it says nothing, the workspace is `cwd`. */
  workspaceRoot?: WorkspaceRoot
  /** Where verdicts are kept. */
  cache: VerdictCache
}

export type CommandGate = (exec: ToolExecution, next: () => Promise<PreToolDecision>) => Promise<PreToolDecision>

/**
 * The `tools/pre-execute` listener. The plan's `commandGate(judge, settings, log)` has no `log`: the client writes the line
 * for each call, and the gate gives it the verdict through `decide`.
 */
export function commandGate(deps: CommandGateDeps): CommandGate {
  return async (exec, next) => {
    const agent = exec.agent as unknown as GateAgent | undefined
    if (agent === undefined || NEVER_GATED.has(exec.name)) return next()
    let settings: JudgeSettings
    try {
      settings = await deps.settings()
    } catch {
      settings = DEFAULT_SETTINGS
    }
    if (!isGated(exec.name, settings.tools.gated)) return next()

    const callId = String(exec.callId)
    const owner = verdictOwner(agent)
    const topLevel = isTopLevelAgent(agent)
    const shell = SHELLS.has(exec.name)
    const args = exec.arguments
    const command = commandOf(exec.name, args)
    const escalation = shell ? escalationOf(args) : undefined
    const sessionCwd = given(agent.session?.header?.cwd)
    const cwd = shell ? directoryOf(args, sessionCwd) : sessionCwd
    let workspace: string | undefined
    try {
      workspace = deps.workspaceRoot?.(agent)
    } catch {
      // No workspace root to be had: the cwd stands in, as it does without a sandbox policy.
    }
    workspace ??= cwd

    // Once per call: a call of this agent that comes through again, as it was, is not put to the judge again.
    const key = createHash('sha256')
      .update(JSON.stringify([exec.name, command, cwd ?? null, escalation ?? null]))
      .digest('hex')
    const known = deps.cache.get(owner, callId)

    let ours: PreToolDecision
    if (known?.memo?.key === key) {
      ours = known.memo.decision
    } else {
      const state: { [key: string]: JsonValue } = { command }
      if (cwd !== undefined) state.cwd = cwd
      if (workspace !== undefined) state.workspace = workspace
      if (escalation !== undefined) state.escalation = escalation
      state.task = taskOf(agent, topLevel)

      let outcome: Outcome | undefined
      try {
        const judge = deps.judge()
        if (judge !== undefined) {
          const asked = await judge.ask<Outcome>({
            state,
            // The spec's question, or, when a wider sandbox is asked for, the same with the escalation named in it.
            questions: { effect: escalation === undefined ? EFFECT_QUESTION : EFFECT_WITH_ESCALATION_QUESTION, serves_task: SERVES_TASK_QUESTION },
            purpose: 'command',
            agent,
            signal: exec.signal,
            tool: exec.name,
            callId,
            subject: command,
            // A call that was cancelled has no one to ask, so the line says it was cancelled, not asked or denied.
            decide: result => exec.signal.aborted ? { decision: 'cancel', pre: { kind: 'cancel' } } : decideCommand(result, settings, topLevel),
          })
          outcome = asked.decided
        }
      } catch {
        // The client never throws for a Jev failure; this is anything else, and is no reason to let a command run.
      }
      // A call that was cancelled must not leave an approval prompt behind.
      if (exec.signal.aborted) return { kind: 'cancel' }
      ours = (outcome ?? unavailable(topLevel)).pre
      deps.cache.set(owner, callId, {
        verdict: verdictOf(ours),
        escalationCovered: ours.kind === 'allow' && escalation !== undefined,
        memo: { key, decision: ours },
      })
    }

    // The gate's own deny is final, as dsh's auto-review's is: a call that will not run has no use for the hooks and
    // recorders that listen after this one, and must not trigger them.
    if (ours.kind === 'deny') return ours

    // Allow and ask let the others have their say: a stricter answer from a later listener stands, and the cache says what
    // the call came to.
    const theirs = await next()
    const final = stricter(ours, theirs)
    if (final.kind !== ours.kind) {
      deps.cache.set(owner, callId, { verdict: verdictOf(final), escalationCovered: false, memo: { key, decision: ours } })
    }
    return final
  }
}

/**
 * Register the gate on `ctx`, the host context: a prepended `tools/pre-execute` listener, and a `tools/result` listener that
 * forgets a call's verdict when it settles. The Jev client, the settings and the sandbox policy are looked up with `ctx.get`
 * on each call, so there is no order to keep between this and the plugins that provide them. Returns the cache, for the
 * approval answerer.
 */
export function registerCommandGate(ctx: Context): VerdictCache {
  const cache = new VerdictCache()
  const gate = commandGate({
    judge: () => ctx.get('judge'),
    settings: () => ctx.get('dishJudge')?.settings() ?? Promise.resolve(DEFAULT_SETTINGS),
    workspaceRoot: workspaceRootFrom(ctx),
    cache,
  })
  ctx.on('tools/pre-execute', gate, { prepend: true })
  ctx.on('tools/result', (exec) => { cache.delete(verdictOwner(exec.agent), String(exec.callId)) })
  return cache
}
