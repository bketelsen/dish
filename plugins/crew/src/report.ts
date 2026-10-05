/**
 * The `report` tool: how a crew coder or reviewer finishes (step 7), and crew's steer back to one that ends its turn without it.
 *
 * ### The tool
 *
 * A coder or a reviewer (`reportRole`: a child with `reviews` is a reviewer, role `coder` a coder) finishes with `report`, as its
 * last call. Its arguments are the role's structured report (`CoderReport`, `ReviewerReport` in `record.ts`). dsh-tools checks
 * them against the schema before `execute` runs (a mismatch is `invalid arguments: …`, naming the field). `execute` then makes
 * the checks a schema can't: a blank `summary`, a coder that isn't `done` without `blockedOn`, a reviewer's `head`, when it
 * gives one, that isn't a full sha (an abbreviated one could match another commit, and `open_pr` compares it with the head it
 * pushes; a review of work outside git gives none, and so never counts for `open_pr`), and a `remember` of more than five
 * items, or with one that isn't one line of at most 300 characters (each is trimmed, and a blank one dropped). All of them are
 * said at once, and nothing is recorded. Otherwise the report is recorded on the child with `setReport` (masked there), the turn
 * is concluded (`exec.concludeTurn()`), and the tool's value is the stored report. A later call replaces an earlier one.
 *
 * `report` is registered at `agent/created` on the child's own scope (`agent.ctx`), never in the preset, as dsh's own
 * `structured_output` is: a scope's own layer isn't subject to its tool filter, so no allow list names it, and the main agent
 * never sees it. A cold resume makes a new agent object with the same id, and it is given `report` as well. `ReportRegistrar`
 * keeps which agent objects this crew instance gave it to (`roleOf`). When the record has lost the child (its `children.json` was
 * set aside as corrupt after `report` was given), `setReport` gives `undefined` and the tool tells the child to end its turn with
 * its report as its closing message. From then on that agent counts as one without `report` (`lost`): crew doesn't steer it back
 * to call it, and the report guard's refusals are the closing message's again. The tool stays, and says the same if called.
 *
 * ### The steer
 *
 * crew's `agent/turn-stopping` listener, prepended so that it runs before dish-gates' whatever the load order (dsh runs the
 * listeners in order, `serial`), sends a coder or reviewer this crew instance gave `report` back to call it when its turn is
 * about to end without a successful `report` since its newest assistant message: at most `reportSteers` times a turn, and not at
 * all when that is 0 (the tool stays). `dishCrew.reportSteered(childId)` is true from that steer until the child's next
 * assistant message or turn: dish-gates reads it at the same stop, after this listener, and doesn't gate a stop crew sent back.
 *
 * What it knows comes from dsh's events (`ReportTracker`): `session/event` gives each session's turn and clears its report at
 * each `assistant/message` and `turn/start`, and `tools/result` marks a session reported when a successful `report` concluded
 * its turn. Within a step dsh keeps the order assistant message, tool calls, `tools/result`, `agent/turn-stopping`, so a session
 * is reported at a stop exactly when its newest assistant message called `report` and the call succeeded.
 *
 * Nothing here throws into dsh: a throw in `agent/created` fails the child's creation, and one in `agent/turn-stopping` its turn.
 *
 * @module dish-crew/report
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, UserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { InferValue, ParameterSchemaSpec, ToolDefinition, ToolExecution, ToolExecutionResult, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { isTopLevelAgent, maskSecrets } from 'dish-kit'
import type { AgentLike } from 'dish-kit'
import { describe, idOf } from './guard.ts'
import { reportRole } from './record.ts'
import type { CoderReport, CrewRecords, ReportRole, ReviewerReport, StructuredReport } from './record.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** crew's message to a coder or reviewer that ended its turn without `report`. */
    'dish-crew': { kind: 'dish-crew' } & ContextFormed
  }
}

/** The tool's name. */
export const REPORT_TOOL = 'report'

/** How many times in one turn a coder or reviewer that ends without `report` is sent back to call it, unless the setting says otherwise. */
export const DEFAULT_REPORT_STEERS = 2

/** A reviewer's `head`, once trimmed and lowercased: a full sha-1 or sha-256 commit id. */
export const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

/** How many distinct problems a listener says; the rest are dropped. */
const MAX_TOLD = 100

// --- the schemas -----------------------------------------------------------------------------------------------------
// The defineTool DSL (dsh-tools `schema.d.ts`). Nested objects say `additionalProperties: false`; the parameter root stays dsh's
// implicit open object, so an extra argument is ignored, not refused. No `oneOf`, lengths or patterns: what a schema can't say
// is checked in `execute`.

const RULING = {
  type: 'object', additionalProperties: false,
  properties: {
    what: { type: 'string', required: true, description: 'What you decided.' },
    why: { type: 'string', required: true, description: 'Why.' },
    costIfWrong: { type: 'string', required: true, description: 'What it costs if the call is wrong.' },
  },
} as const

const NOT_FIXED = {
  type: 'object', additionalProperties: false,
  properties: {
    finding: { type: 'string', required: true, description: 'The finding, as the review gave it.' },
    why: { type: 'string', required: true, description: 'Why it isn\'t fixed.' },
  },
} as const

/** Both roles' `remember`: suggestions the main agent may keep with dish-memory's `remember`. Its limits are checked in `execute`. */
const REMEMBER = {
  type: 'array', items: { type: 'string' },
  description: 'Up to five one-line things a later agent in this family should know that the code doesn\'t say: a pitfall, a flaky test, an undocumented requirement. Leave it out when there is none.',
} as const

/** A coder's `report` arguments. */
export const CODER_PARAMETERS = {
  status: {
    type: 'string', enum: ['done', 'blocked', 'needs_context'], required: true,
    description: '`done`: the work is complete and committed. `blocked` or `needs_context`: you can\'t go on; say why in `blockedOn`.',
  },
  summary: { type: 'string', required: true, description: 'What changed, for a person: a few sentences.' },
  commits: { type: 'array', items: { type: 'string' }, description: 'The shas of the commits you made, oldest first.' },
  blockedOn: { type: 'string', description: 'Required when status isn\'t done: the question you\'re blocked on, or what you need.' },
  rulings: { type: 'array', items: RULING, description: 'Your own judgment calls.' },
  concerns: { type: 'array', items: { type: 'string' }, description: 'What the main agent should know: risks, doubts, loose ends.' },
  notFixed: { type: 'array', items: NOT_FIXED, description: 'In a fix round: the findings you didn\'t fix, and why.' },
  remember: REMEMBER,
} as const satisfies ParameterSchemaSpec

const FINDING = {
  type: 'object', additionalProperties: false,
  properties: {
    severity: { type: 'string', enum: ['blocking', 'should_fix', 'nit'], required: true },
    file: { type: 'string', required: true, description: 'The path, relative to the repository root.' },
    line: { type: 'integer', description: 'The line, when the finding has one.' },
    summary: { type: 'string', required: true, description: 'What is wrong.' },
    fix: { type: 'string', required: true, description: 'What to change.' },
  },
} as const

const CHECK = {
  type: 'object', additionalProperties: false,
  properties: {
    command: { type: 'string', required: true },
    exitCode: { type: 'integer', required: true },
    summary: { type: 'string', required: true, description: 'What it showed.' },
  },
} as const

const ADDRESSED = {
  type: 'object', additionalProperties: false,
  properties: {
    finding: { type: 'string', required: true, description: 'The earlier finding.' },
    addressed: { type: 'boolean', required: true },
    evidence: { type: 'string', required: true, description: 'What shows it, either way.' },
  },
} as const

/** A reviewer's `report` arguments. */
export const REVIEWER_PARAMETERS = {
  verdict: {
    type: 'string', enum: ['approved', 'changes_requested'], required: true,
    description: '`changes_requested` when any finding must be fixed before this can merge, else `approved`.',
  },
  head: { type: 'string', description: 'The full sha of the commit you reviewed (`git rev-parse HEAD`), when the work is in a git repository.' },
  summary: { type: 'string', required: true, description: 'Your review, for a person: a few sentences.' },
  findings: { type: 'array', required: true, items: FINDING, description: 'Every finding; an empty list for a clean review.' },
  checks: { type: 'array', items: CHECK, description: 'The commands you ran, and their exit codes.' },
  addressed: { type: 'array', items: ADDRESSED, description: 'In a re-review: each earlier finding, whether it was addressed, and the evidence.' },
  remember: REMEMBER,
} as const satisfies ParameterSchemaSpec

/** The value the tool returns: the stored report. */
const REPORT_HEAD = {
  turn: { type: 'integer', required: true },
  at: { type: 'number', required: true },
} as const

const CODER_OUTPUT = {
  type: 'object', additionalProperties: false,
  properties: { role: { type: 'string', const: 'coder', required: true }, ...REPORT_HEAD, ...CODER_PARAMETERS },
} as const

const REVIEWER_OUTPUT = {
  type: 'object', additionalProperties: false,
  properties: { role: { type: 'string', const: 'reviewer', required: true }, ...REPORT_HEAD, ...REVIEWER_PARAMETERS },
} as const

/** What a coder reads of `report`. */
export const CODER_DESCRIPTION = 'Finish your work with this, as your last call: it records your report for the main agent and ends your turn. '
  + 'The main agent reads this report, not your last message. '
  + '`status` is `done` when the work is complete and committed: in a worktree, dish then runs the project\'s gate there, and a failure '
  + 'comes back to you to fix, after which you call `report` again. '
  + '`blocked` or `needs_context` when you can\'t go on, with `blockedOn`: the gate is skipped. '
  + '`remember` holds up to five one-line things a later agent in this family should know that the code doesn\'t say. '
  + 'A later call replaces an earlier one.'

/** What a reviewer reads of `report`. */
export const REVIEWER_DESCRIPTION = 'Finish your review with this, as your last call: it records your verdict for the main agent and ends your turn. '
  + 'The main agent reads this report, not your last message. '
  + '`head` is the full sha of the commit you reviewed, when the work is in a git repository; `findings` lists every finding (an empty list for a clean review). '
  + '`remember` holds up to five one-line things a later agent in this family should know that the code doesn\'t say. '
  + 'A later call replaces an earlier one.'

// --- the tool ----------------------------------------------------------------------------------------------------------

type Warn = (format: string, ...args: unknown[]) => void

/** What the tool and the steer use of dsh's Agent. */
export interface ReportAgent extends AgentLike {
  id: unknown
  session: NonNullable<AgentLike['session']>
}

/** What `execute` refuses, as the child reads it. */
const SUMMARY_EMPTY: Readonly<Record<ReportRole, string>> = {
  coder: 'summary is empty: say what changed, for a person',
  reviewer: 'summary is empty: say what you found, for a person',
}
const BLOCKED_ON_REQUIRED = 'blockedOn is required when status is blocked or needs_context: say what you\'re blocked on, or what you need'
const HEAD_NOT_FULL = 'head must be the full sha of the commit you reviewed (40 hex digits): run `git rev-parse HEAD` in the worktree you reviewed, or leave head out when the work isn\'t in a git repository'
const NOT_A_CHILD = 'dish-crew has no record of you as a crew child, so the report wasn\'t recorded; end your turn with your report as your closing message'
/** The most `remember` items, and the most characters in one. */
const REMEMBER_MAX = 5
const REMEMBER_LINE_MAX = 300
const REMEMBER_COUNT = `remember holds at most ${REMEMBER_MAX} items`
const REMEMBER_LINE = `each remember item is one line of at most ${REMEMBER_LINE_MAX} characters`

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function blank(value: string | undefined): boolean {
  return value === undefined || value.trim() === ''
}

/**
 * `{ [name]: value }` when an optional field says something, else `{}`: a blank string and an empty list are left out, since
 * models fill every optional parameter.
 */
function given<K extends string, V>(name: K, value: V | undefined): { [P in K]?: V } {
  if (value === undefined) return {}
  if (typeof value === 'string' && value.trim() === '') return {}
  if (Array.isArray(value) && value.length === 0) return {}
  return { [name]: value } as { [P in K]?: V }
}

/** `remember`'s items trimmed, the blank ones dropped (models fill every optional parameter), or `undefined` when none is given. */
function remembered(items: readonly string[] | undefined): string[] | undefined {
  return items?.map(item => item.trim()).filter(item => item !== '')
}

/** What is wrong with `remember`'s items, as `execute` says it: too many, and one that isn't one short line. */
function rememberProblems(items: readonly string[] | undefined): string[] {
  if (items === undefined) return []
  const problems: string[] = []
  if (items.length > REMEMBER_MAX) problems.push(REMEMBER_COUNT)
  if (items.some(item => /[\r\n]/.test(item) || item.length > REMEMBER_LINE_MAX)) problems.push(REMEMBER_LINE)
  return problems
}

export interface ReportToolDeps {
  role: ReportRole
  agent: ReportAgent
  records: Pick<CrewRecords, 'setReport'>
  tracker: Pick<ReportTracker, 'turnOf'>
  now?: () => number
  /**
   * Called when `setReport` gives `undefined`: the record has no such child, and the child is told to report in its closing
   * message. The registrar stops counting the agent as one that reports with `report`. A throw is ignored.
   */
  lost?(): void
}

/** Record `report` for the child, conclude its turn, and give the stored report; a failure is the error the child reads. */
async function record(deps: ReportToolDeps, report: StructuredReport, exec: ToolRunContext): Promise<StructuredReport> {
  let stored: StructuredReport | undefined
  try {
    stored = await deps.records.setReport(String(deps.agent.id), report)
  } catch (error) {
    throw new Error(`dish couldn't record your report (${maskSecrets(describe(error))}); call report again`)
  }
  if (stored === undefined) {
    // It is told to report in its closing message: crew mustn't send it back to call `report`, nor the guard name it.
    try {
      deps.lost?.()
    } catch {
      // The child is told all the same.
    }
    throw new Error(NOT_A_CHILD)
  }
  exec.concludeTurn()
  return stored
}

function coderTool(deps: ReportToolDeps): ToolDefinition {
  const now = deps.now ?? Date.now
  return defineTool({
    name: REPORT_TOOL,
    description: CODER_DESCRIPTION,
    parameters: CODER_PARAMETERS,
    output: {
      schema: CODER_OUTPUT,
      render: (_args, value) => [{ type: 'text', text: `Report recorded: ${value.status}.` }],
    },
    async execute(args, exec) {
      const problems: string[] = []
      if (blank(args.summary)) problems.push(SUMMARY_EMPTY.coder)
      if (args.status !== 'done' && blank(args.blockedOn)) problems.push(BLOCKED_ON_REQUIRED)
      const remember = remembered(args.remember)
      problems.push(...rememberProblems(remember))
      if (problems.length > 0) throw new Error(problems.join('; '))
      const report: CoderReport = {
        role: 'coder',
        turn: deps.tracker.turnOf(deps.agent.session),
        at: now(),
        status: args.status,
        summary: args.summary,
        ...given('commits', args.commits),
        ...given('blockedOn', args.blockedOn),
        ...given('rulings', args.rulings),
        ...given('concerns', args.concerns),
        ...given('notFixed', args.notFixed),
        ...given('remember', remember),
      }
      return await record(deps, report, exec) as InferValue<typeof CODER_OUTPUT>
    },
  })
}

function reviewerTool(deps: ReportToolDeps): ToolDefinition {
  const now = deps.now ?? Date.now
  return defineTool({
    name: REPORT_TOOL,
    description: REVIEWER_DESCRIPTION,
    parameters: REVIEWER_PARAMETERS,
    output: {
      schema: REVIEWER_OUTPUT,
      render: (_args, value) => [{ type: 'text', text: `Report recorded: ${value.verdict}${value.head === undefined ? '' : ` at ${value.head.slice(0, 12)}`}.` }],
    },
    async execute(args, exec) {
      const problems: string[] = []
      if (blank(args.summary)) problems.push(SUMMARY_EMPTY.reviewer)
      // Optional: a review of work outside git (the scratch workspace, a writer's change) has no commit. Given, it is a full sha.
      const head = blank(args.head) ? undefined : args.head!.trim().toLowerCase()
      if (head !== undefined && !FULL_SHA.test(head)) problems.push(HEAD_NOT_FULL)
      const remember = remembered(args.remember)
      problems.push(...rememberProblems(remember))
      if (problems.length > 0) throw new Error(problems.join('; '))
      const report: ReviewerReport = {
        role: 'reviewer',
        turn: deps.tracker.turnOf(deps.agent.session),
        at: now(),
        verdict: args.verdict,
        ...head === undefined ? {} : { head },
        summary: args.summary,
        findings: args.findings,
        ...given('checks', args.checks),
        ...given('addressed', args.addressed),
        ...given('remember', remember),
      }
      return await record(deps, report, exec) as InferValue<typeof REVIEWER_OUTPUT>
    },
  })
}

/** The `report` tool for one child, with its role's schema. */
export function reportTool(deps: ReportToolDeps): ToolDefinition {
  return deps.role === 'reviewer' ? reviewerTool(deps) : coderTool(deps)
}

// --- what crew keeps of each session -----------------------------------------------------------------------------------

/** What `ReportTracker` keeps of a session. */
interface SessionState {
  /** The newest turn seen; 0 when none was. */
  turn: number
  /** Whether a successful concluding `report` came after the newest assistant message. */
  reported: boolean
  /** The steers counted in `turn`. */
  steers?: { turn: number, count: number }
}

/**
 * What crew keeps of each child's session from dsh's events, for the tool and the steer. Keyed by the session object in
 * WeakMaps, as dish-gates' ClosingHeads is, except `steered`, which is keyed by child id. No method throws.
 */
export class ReportTracker {
  readonly #sessions = new WeakMap<object, SessionState>()
  readonly #steered = new Set<string>()

  #state(session: object): SessionState {
    let state = this.#sessions.get(session)
    if (state === undefined) {
      state = { turn: 0, reported: false }
      this.#sessions.set(session, state)
    }
    return state
  }

  /**
   * `session/event`: a `turn/start` or an `assistant/message` sets the session's turn (its `data.turn`, when that is a whole
   * number), clears its report, and takes its child (`session.id`) out of `steered`. Anything else is ignored, and so is a
   * malformed event.
   */
  observe(session: object, event: unknown): void {
    try {
      if (!isObject(session) || !isObject(event)) return
      if (event.type !== 'turn/start' && event.type !== 'assistant/message') return
      const state = this.#state(session)
      const turn = isObject(event.data) ? event.data.turn : undefined
      if (Number.isSafeInteger(turn) && (turn as number) >= 0) state.turn = turn as number
      state.reported = false
      const id = session.id
      if (typeof id === 'string' || typeof id === 'number') this.#steered.delete(String(id))
    } catch {
      // A malformed event, or one that throws when read: nothing to keep.
    }
  }

  /** `tools/result`: a successful `report` that concludes the turn marks its agent's session reported. */
  result(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): void {
    try {
      if (exec?.name !== REPORT_TOOL) return
      if (result?.isError !== false || result.concludesTurn !== true) return
      const session: unknown = (exec.agent as { session?: unknown } | undefined)?.session
      if (!isObject(session)) return
      this.#state(session).reported = true
    } catch {
      // Not a result to keep.
    }
  }

  /** The newest turn seen for the session; 0 when none was. */
  turnOf(session: object): number {
    try {
      return this.#sessions.get(session)?.turn ?? 0
    } catch {
      return 0
    }
  }

  /** Whether a successful concluding `report` came after the session's newest assistant message. */
  reported(session: object): boolean {
    try {
      return this.#sessions.get(session)?.reported ?? false
    } catch {
      return false
    }
  }

  /** Count one steer in `turn`, and give its ordinal (1-based), or undefined when `limit` are counted already. */
  takeSteer(session: object, turn: number, limit: number): number | undefined {
    try {
      const state = this.#state(session)
      if (state.steers === undefined || state.steers.turn !== turn) state.steers = { turn, count: 0 }
      if (state.steers.count >= limit) return undefined
      state.steers.count += 1
      return state.steers.count
    } catch {
      return undefined
    }
  }

  markSteered(childId: string): void {
    this.#steered.add(childId)
  }

  /** dishCrew.reportSteered. */
  steered(childId: string): boolean {
    return this.#steered.has(childId)
  }

  /** agent/disposed. */
  forget(childId: string): void {
    this.#steered.delete(childId)
  }
}

// --- registration ------------------------------------------------------------------------------------------------------

export interface RegisteringAgent extends ReportAgent {
  ctx: { tools: { register(definition: ToolDefinition): () => void }, effect(execute: () => () => void): () => unknown }
}

export interface RegistrarDeps {
  records: Pick<CrewRecords, 'lookup' | 'setReport'>
  tracker: ReportTracker
  /** The host's `ctx.effect`. */
  effect(execute: () => () => unknown): () => unknown
  warn: Warn
  now?: () => number
}

/** Whether `error` is cordis refusing an effect on a context that is going away: the agent or crew is going, and nothing failed. */
function inactive(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'INACTIVE_EFFECT'
}

/** Gives crew's coders and reviewers their `report`, at `agent/created`, and takes it back at `agent/disposed`. */
export class ReportRegistrar {
  readonly #deps: RegistrarDeps
  /** Each agent object given `report`; `lost` once the record had no such child when it called it. */
  readonly #attached = new WeakMap<object, { role: ReportRole, detach: () => unknown, lost: boolean }>()
  readonly #told = new Set<string>()

  constructor(deps: RegistrarDeps) {
    this.#deps = deps
  }

  #tell(id: string, error: unknown): void {
    const message = maskSecrets(describe(error))
    const key = `${id}\n${message}`
    if (this.#told.has(key) || this.#told.size >= MAX_TOLD) return
    this.#told.add(key)
    try {
      this.#deps.warn('could not give crew child %s the report tool: %s', id, message)
    } catch {
      // Nothing to do about it.
    }
  }

  /**
   * agent/created: give a crew coder or reviewer its `report`, on its own scope. A top-level agent, an agent given it already,
   * one the record doesn't know and another role are left alone. Never rejects: a failure is logged once per distinct message.
   */
  async attach(agent: RegisteringAgent): Promise<void> {
    let id = 'with no id'
    try {
      if (!isObject(agent) || isTopLevelAgent(agent)) return
      if (this.#attached.has(agent)) return
      const known = idOf(agent)
      if (known === undefined) return
      id = known
      const found = await this.#deps.records.lookup(id)
      if (found === undefined) return
      const role = reportRole(found.record)
      if (role === undefined) return
      // A second `agent/created` for the same object can have raced the lookup.
      if (this.#attached.has(agent)) return
      const { records, tracker, now } = this.#deps
      const lost = (): void => {
        const entry = this.#attached.get(agent)
        if (entry !== undefined) entry.lost = true
      }
      const tool = reportTool({ role, agent, records, tracker, lost, ...now === undefined ? {} : { now } })
      const detach = this.#deps.effect(() => agent.ctx.effect(() => agent.ctx.tools.register(tool)))
      this.#attached.set(agent, { role, detach, lost: false })
    } catch (error) {
      if (inactive(error)) return
      this.#tell(id, error)
    }
  }

  /** agent/disposed: take back the agent's `report`. Never throws. */
  detach(agent: object): void {
    try {
      const entry = this.#attached.get(agent)
      if (entry === undefined) return
      this.#attached.delete(agent)
      const done = entry.detach()
      if (done instanceof Promise) done.catch(() => {})
    } catch {
      // The scope is gone already: so is the tool.
    }
  }

  /**
   * The role `report` was registered for on this agent object, by this crew instance; undefined otherwise, and once its `report`
   * found the record had lost the child.
   */
  roleOf(agent: object): ReportRole | undefined {
    try {
      const entry = this.#attached.get(agent)
      return entry === undefined || entry.lost ? undefined : entry.role
    } catch {
      return undefined
    }
  }
}

// --- the steer ---------------------------------------------------------------------------------------------------------

const STEER_TEXT: Readonly<Record<ReportRole, string>> = {
  coder: 'Finish by calling `report`: `status` (`done` when the work is complete and committed; `blocked` or `needs_context`, with '
    + '`blockedOn`, when you can\'t go on), a `summary` of what changed, for a person, and `commits`, `rulings`, `concerns`, '
    + '`notFixed` and `remember` where they apply. The main agent reads your report, not your last message, and your turn ends '
    + 'when you call it.',
  reviewer: 'Finish by calling `report`: your `verdict` (`approved` or `changes_requested`), `head` (the full sha of the commit you '
    + 'reviewed, when the work is in a git repository), a `summary`, and `findings`, each with its severity, file, line, summary and fix (an empty list for a clean '
    + 'review), with the `checks` you ran, in a re-review `addressed`, and `remember` when a later agent in this family should '
    + 'know something the code doesn\'t say. The main agent reads your report, not your last message, and your turn ends when '
    + 'you call it.',
}

/** What the last steer of a turn adds. */
const LAST_STEER = ' If you end your turn without it, the main agent gets your work without a report.'

/** What a coder or reviewer reads when it is sent back to call `report`: the `steer`th of `of` this turn. */
export function reportSteerText(role: ReportRole, steer: number, of: number): string {
  return STEER_TEXT[role] + (steer === of ? LAST_STEER : '')
}

/** `Asked to finish with report (<steer> of <of>)`, within dsh's 120 characters. */
export function reportSteerSummary(steer: number, of: number): string {
  return `Asked to finish with report (${steer} of ${of})`
}

export interface SteeringAgent extends ReportAgent {
  steer(message: UserMessage): void
}

export interface SteerDeps {
  /** The `reportSteers` row. */
  limit: number
  tracker: ReportTracker
  /** ReportRegistrar.roleOf. */
  roleOf(agent: object): ReportRole | undefined
  warn: Warn
}

/**
 * The prepended `agent/turn-stopping` listener: a coder or reviewer this crew instance gave `report`, whose turn is ending with no
 * successful `report` since its newest assistant message, is steered back to call it, at most `limit` times a turn. Never throws:
 * a throw fails the turn. Each distinct problem is logged once, up to 100.
 */
export function reportSteerListener(deps: SteerDeps): (payload: { agent: SteeringAgent, turn: number, signal: AbortSignal }) => Promise<void> {
  const told = new Set<string>()
  const tell = (message: string): void => {
    if (told.has(message) || told.size >= MAX_TOLD) return
    told.add(message)
    try {
      deps.warn('%s', message)
    } catch {
      // Nothing to do about it.
    }
  }
  return async (payload) => {
    try {
      const limit = deps.limit
      if (!(limit > 0)) return
      // dsh's payload always has an agent; anything else is no stop of ours.
      if (!isObject(payload) || !isObject(payload.agent)) return
      const { agent, turn, signal } = payload
      if (signal?.aborted === true) return
      const role = deps.roleOf(agent)
      if (role === undefined) return
      if (deps.tracker.reported(agent.session)) return
      const n = deps.tracker.takeSteer(agent.session, turn, limit)
      if (n === undefined) return
      const id = String(agent.id)
      // Before the steer, so that dish-gates, after this listener, sees it at this stop.
      deps.tracker.markSteered(id)
      try {
        agent.steer(createUserMessage({
          content: [{ type: 'text', text: reportSteerText(role, n, limit) }],
          source: { kind: 'dish-crew', form: 'notice', summary: reportSteerSummary(n, limit) },
        }))
      } catch (error) {
        deps.tracker.forget(id)
        tell(maskSecrets(`could not ask crew child ${id} to finish with report: ${describe(error)}`))
      }
    } catch (error) {
      tell(maskSecrets(`could not tell whether a crew child finished with report: ${describe(error)}`))
    }
  }
}
