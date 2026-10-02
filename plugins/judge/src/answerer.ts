/**
 * The approval answerer: a host-level `approval/request` listener that decides every approval request of a child, so that a
 * crew child never waits on a human, and passes the main agent's on to you; and the switch that makes children ask the judge.
 *
 * ### What it decides
 *
 * The spec's cases, in order, with the command gate's verdict for the same call (`VerdictCache`, by agent and call id)
 * as the only thing it knows about the call: a request carries the agent, tool name, call id and reason, never the arguments.
 *
 * | The gate's verdict for this agent's call | Main agent | Child |
 * |---|---|---|
 * | `allow`, with the escalation it was shown (`escalationCovered`), and this is that escalation's request | `allowed-once` | `allowed-once` |
 * | `ask`, the gate's own, which showed you the escalation, and you said yes to it (`coveredByYou`); this is that escalation's request, the first | `allowed-once` | `rejected` (a child is never asked, so never has one) |
 * | `ask` (the gate's own, or another listener's: the cache keeps the stricter) | `next()`: you | `rejected` |
 * | `deny`, `allow` with nothing covered, or no entry at all | `next()`: you | `rejected` |
 * | the cache fails | `next()`: you | `rejected` |
 *
 * - **A child's request never calls `next()`.** `next()` falls through to the browser's answerer, which would put the
 *   question to a human in a session nobody is watching. A child gets `allowed-once` for a covered escalation, and `rejected`
 *   for everything else: no entry, an `ask`, a `deny`, a missing judge (the gate then denied), an agent nobody can place, a
 *   throw. Which agent is a child is `isTopLevelAgent`'s call, and an agent it can't vouch for is a child.
 * - **The judge never approves a main-agent request on its own,** except an escalation of a call that it allowed with the
 *   escalation in view. Anything else (`plugin_manager`, `run_code`, a tool not in `tools.gated`, the gate's own ask) is
 *   yours: the answerer makes no Jev call, and "the judge is unavailable" for an approval request is the gate's: its verdict
 *   was `ask` for you or `deny` for a child, which are the rows above.
 * - **Your yes to the gate's own ask covers that call's escalation, once.** An escalated call the gate asks you about would
 *   otherwise ask you twice: the gate's ask, and then the tool's escalation request for the same call. The gate's ask shows you
 *   the escalation (the mode and the whole justification) and the cache keeps its reason (`askReason`). When the answerer
 *   passes that ask to you (this tool, exactly that reason) and you say yes (`allowed-once`), it writes `coveredByYou` on the
 *   entry it read, if the entry is still that one (`VerdictCache.replace`). The escalation's request (this agent, this call
 *   id, this tool, exactly `escalationReason`) is then `allowed-once`, and the cover is used up before it is answered, so a
 *   second request for the call is put to you. A no, a cancel, an ask that showed you no escalation, or a yes to anything else
 *   covers nothing. A child's call is never put to you (the gate refuses it instead of asking), so a child never has one.
 * - **A covered entry covers one request.** The gate records the tool (`exec.name`) and the reason dsh's tool will put on the request
 *   for the escalation (`escalate sandbox to <mode>: <justification>`, from `approveEscalation` in `dsh-sandbox`, which `bash` and
 *   `pwsh` both call). Only a request with that tool name and exactly that reason is approved. A hook's ask, or `run_code`'s,
 *   under the same call id is not the escalation the judge was shown. The cover is used up before the request is answered
 *   (`escalationCovered` is written back `false` through `VerdictCache.replace`), so a second request for the same call is
 *   put to you, or refused for a child, and a cover that can't be used up covers nothing. The gate writes the entry afresh
 *   when the same call comes through it again, its cover included.
 * - **The owner is always `verdictOwner(request.agent)`.** The cache is keyed by agent and call id, because a call id is the
 *   model provider's and two agents can use the same one at once: another agent's covered `allow` must not approve this
 *   agent's call.
 * - **One log line for each decision,** through `ctx.get('dishJudge').log.write`: the approval purpose, no answers (the
 *   answerer asks nothing), no latency, and `pass`, `allowed-once` or `rejected` for the decision. The subject is the tool
 *   and a short reason, with what the tool said it was asking for (`reason`, cut short; the log masks secrets). A line that
 *   can't be written changes nothing. An escalation your yes covered says so ("you approved the command gate's ask about
 *   this call …"); recording the yes itself is not a decision, and has no line.
 * - **No reason travels to the model.** The waterfall's result is one of four words (`ApprovalOutcome`), so a child that is
 *   rejected is told what dsh's tool says ("the user rejected escalating ...; it stays denied, so stop and explain instead of
 *   working around it") and the reason is in the log. Reasons written for the model are the gate's (it denies with them,
 *   before the call), and the delegation notice dsh gives every child already says to state the limitation in its reply.
 *
 * ### Why children are switched to `ask`, and which children
 *
 * dsh-subagent pins every child to the approval policy `never`, and the approval service rejects a request from a `never`
 * session before any listener runs: the answerer would never hear a child, and a child's escalation could never be allowed.
 * `agent/created` is a serial event whose listeners are awaited before the agent is released ("AgentLoop holds queued input
 * until all listeners finish"), after dsh-subagent has pinned the child and before its first prompt, so the switch is made
 * in time, and fires again on a resume, which is why the policy is read first. `setApprovalPolicy(session, 'ask')` appends
 * the one durable event (the last one wins; it survives a resume). It does not use `ApprovalService.setPolicy`, which also
 * queues a "changed by the user" message to the model: this is initialization, and the policy sentence in the system prompt
 * follows the effective policy on its own ("Approval policy: ask. ...").
 *
 * **Only crew's children.** The spec says so ("`origin: subagent` sessions that crew's record knows"), and a child that
 * isn't crew's keeps dsh's `never`: rejected by policy, no human, no judge. Crew exposes its record as the `dishCrew`
 * service (`records.lookup(childId)`), by the child's session id: delegate writes the record before it starts the child, with
 * the child's id as the session id, so the record is there when `agent/created` fires, for a new child and for a resume.
 * The lookup is asynchronous (a small pointer file and the session's file, behind crew's own queue), which an awaited serial
 * listener can wait for; it is cut off after `CREW_LOOKUP_BUDGET_MS`, so a slow disk can't hold up an agent's creation.
 * There is no marker on the session or agent to read instead (a child's header says `origin: subagent`, and so does every
 * other plugin's). Whatever goes wrong (no crew service, a record that can't be read, a lookup that hangs) leaves the
 * child at `never`, where nothing waits on anyone: it fails toward refusing, and says so once.
 *
 * **Never more than its parent.** A child is switched to `ask` only if its parent's effective policy is `ask`: the parent's own
 * override (`overrideOf`), else the deployment's default (`approval.config.policy`). The parent is the live agent its header names
 * (`parentSession`, looked up in `ctx.agents`). A parent at `never` has its own escalations rejected, and shouldn't see its
 * child's approved; one that can't be found or read counts as not at `ask`. A child that comes back already at `ask` (a follow-up
 * to one that settled while this plugin was loaded, or a crash) whose parent isn't at `ask` is put back to `never`.
 *
 * ### The risk, and what is done about it
 *
 * With a child at `ask` and no answerer of ours, dsh does not fail closed in the web profile. The waterfall goes on to the
 * browser's answerer (`api-remotes` forwards it, the gateway holds it until a client answers, `ui-approval` shows it in that
 * child's composer), and **nothing times it out**: not the approval service (it races only the request's signal), not the
 * gateway (it settles on an answer, an abort or a released agent context), not the UI, and not the tool (dsh's `bash`, `pwsh`
 * and file tools have no time limit; `bash`'s own `timeoutMs` covers the command, not the wait for approval). The child sits on
 * a prompt nobody sees until someone interrupts it. Only a deployment with no browser answerer ends in dsh's own
 * `unavailable`.
 *
 * So the policy is only meant to be `ask` while this plugin is there, and two things keep it so:
 *
 * - **Here:** when the plugin is disposed (unloaded, disabled, uninstalled or reloaded in a running dsh, or a clean shutdown),
 *   `restore` puts `never` back on every crew child it switched, or found at `ask`, **that is still live**, and from then on
 *   switches nothing (a lookup that was in flight can't leave an `ask` behind). That is all it guarantees.
 * - **In crew:** dish-crew's approval guard (`plugins/crew/src/guard.ts`) refuses a crew child's request whenever the `dishJudge`
 *   service is absent. That is what covers the rest, which nothing here can reach: a child that has **settled** keeps `ask` in its
 *   durable log (dsh-subagent flushes an idle child's final state and only then disposes it, so `agent/disposed` comes after the
 *   last flush: nothing appended then is reliably kept, and this forgets the child), and so does one whose process died without
 *   disposing anything. A follow-up
 *   (`delegate` with `to`) resumes it at `ask`, and if dish-judge is not loaded then, this plugin does not run at all.
 *
 * @module dish-judge/answerer
 */

import type { Context } from '@deepseek-ai/cordis'
import { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import type { ApprovalOutcome, ApprovalService } from '@deepseek-ai/dsh-user-approval'
import { isTopLevelAgent } from 'dish-kit'
import { verdictOwner } from './gate.ts'
import type { GateAgent, VerdictCache, VerdictEntry } from './gate.ts'
import type { JudgeLogLine } from './log.ts'

// --- the answerer ---------------------------------------------------------------------------------------

/** The parts of dsh's `ApprovalRequest` the answerer reads. Every one is `unknown`: a rogue request must not be able to break it. */
export interface ApprovalAnswererRequest {
  readonly agent?: unknown
  readonly toolName?: unknown
  readonly callId?: unknown
  readonly reason?: unknown
}

/** Where a decision is written: the decision log's `write`, which returns at once and never throws. */
export interface AnswererLog {
  write(line: JudgeLogLine): void
}

/** The `approval/request` listener. `this` (the scoped carrier) is not used: the agent is in the request. */
export type ApprovalAnswerer = (request: ApprovalAnswererRequest, next: () => Promise<ApprovalOutcome>) => Promise<ApprovalOutcome>

/** The most of a tool's reason that goes on a line. */
const MAX_REASON_CHARS = 200

/** `text` cut to `max` characters, with `…` where it was cut and no half of a surrogate pair left. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text
  let end = max - 1
  const last = text.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end -= 1
  return `${text.slice(0, end)}…`
}

/** `value` if it is an object, else `undefined`: what `isTopLevelAgent` and `verdictOwner` are given. */
function asAgent(value: unknown): GateAgent | undefined {
  return typeof value === 'object' && value !== null ? value as GateAgent : undefined
}

type Decision = 'pass' | 'allowed-once' | 'rejected'

/** The gate's entry for a request's call, with the agent and call id it is kept under. */
interface Found {
  readonly owner: string
  readonly callId: string
  readonly entry: VerdictEntry
}

/** What the answerer does with a request, and what it says about it on the line. */
interface Verdict {
  decision: Decision
  why: string
}

const COVERED_WHY = 'the command gate approved this call, with the escalation it was shown'
const YOURS_WHY = 'you approved the command gate\'s ask about this call, which showed you this escalation'

/**
 * Whether `entry` covers this request: the gate allowed this agent's call with the escalation in view, and the request is that
 * escalation, and nothing else that has the same call id. The request must be the same tool's, and carry exactly the reason
 * dsh's tool gives when it asks to escalate the call (`escalate sandbox to <mode>: <justification>`, which the gate
 * recorded from the arguments it judged). A hook's ask, or `run_code`'s, under a call id that bash's escalation also has, is
 * not covered; and neither is any request when the entry has no tool or no reason to compare with.
 */
function covers(entry: VerdictEntry, request: ApprovalAnswererRequest): boolean {
  return entry.verdict === 'allow'
    && entry.escalationCovered
    && entry.tool !== undefined
    && entry.escalationReason !== undefined
    && request.toolName === entry.tool
    && request.reason === entry.escalationReason
}

/**
 * Whether your yes covers this request: you said yes to the gate's own ask about this agent's call, which showed you the
 * escalation (`coveredByYou`, on the entry of that ask), and the request is that escalation: the same tool, exactly
 * `escalationReason`. Never for a child, which is never asked; and not for an entry with no tool or no reason to compare with.
 */
function yourYesCovers(topLevel: boolean, entry: VerdictEntry, request: ApprovalAnswererRequest): boolean {
  return topLevel
    && entry.verdict === 'ask'
    && entry.coveredByYou === true
    && entry.tool !== undefined
    && entry.escalationReason !== undefined
    && request.toolName === entry.tool
    && request.reason === entry.escalationReason
}

/**
 * Whether the request is the gate's own ask about this call that showed you its escalation: the entry kept that ask's reason
 * (`askReason`), and the request is the same tool's with exactly that reason. A yes to it covers the escalation.
 */
function showsYouTheEscalation(entry: VerdictEntry, request: ApprovalAnswererRequest): boolean {
  return entry.askReason !== undefined
    && request.toolName === entry.tool
    && request.reason === entry.askReason
}

/**
 * The decision for one request: the table in the header. `entry` is the gate's verdict for this agent's call, or `undefined`;
 * `cover` is what covers this request, if anything does (the judge's allow, or your yes); and `showing` is whether the request
 * is the gate's ask that showed you the escalation. A child is never `pass`.
 */
function decide(topLevel: boolean, entry: VerdictEntry | undefined, cover: 'judge' | 'you' | undefined, showing: boolean): Verdict {
  if (cover === 'judge') return { decision: 'allowed-once', why: COVERED_WHY }
  if (cover === 'you') return { decision: 'allowed-once', why: YOURS_WHY }
  if (topLevel) {
    if (entry === undefined) return { decision: 'pass', why: 'not a call the command gate judged; passed on to you' }
    if (showing) return { decision: 'pass', why: 'the command gate asked you about this call, and showed you its escalation, which a yes also covers; passed on to you' }
    if (entry.verdict === 'ask') return { decision: 'pass', why: 'the command gate asked you about this call; passed on to you' }
    return { decision: 'pass', why: `the command gate's verdict for this call (${entry.verdict}) does not cover this request; passed on to you` }
  }
  const nothing = 'it was refused, and a child never waits for you'
  if (entry === undefined) return { decision: 'rejected', why: `the judge did not approve this request: it is not a call the command gate judged; ${nothing}` }
  const detail = entry.verdict !== 'allow' ? '' : entry.escalationCovered ? ', and this is not the escalation it was shown' : ', with no escalation covered'
  return { decision: 'rejected', why: `the judge did not approve this request (the command gate's verdict for the call was ${entry.verdict}${detail}); ${nothing}` }
}

/**
 * The `approval/request` listener, for `registerApprovalAnswerer` (and for tests, which give it a cache and a log of their own).
 * It is synchronous inside, answers at once, and does not wait for a log write; what it passes to you it waits for only to
 * record a yes that covers an escalation. It never throws, and for a child it never calls `next()`: see the header.
 */
export function approvalAnswerer(cache: Pick<VerdictCache, 'get' | 'replace'>, log: AnswererLog, now: () => number = Date.now): ApprovalAnswerer {
  return (request, next) => {
    const agent = asAgent(request?.agent)
    let topLevel = false
    try {
      topLevel = isTopLevelAgent(agent)
    } catch {
      // An agent that can't be read is not vouched for: it is a child.
    }
    let owner: string | undefined
    let callId: string | undefined
    /** The gate's entry for this agent's call, and where it is kept, which is where a yes is written. */
    let found: Found | undefined
    try {
      owner = verdictOwner(agent)
      callId = request.callId === undefined || request.callId === null ? undefined : String(request.callId)
      if (callId !== undefined) {
        const entry = cache.get(owner, callId)
        if (entry !== undefined) found = { owner, callId, entry }
      }
    } catch {
      // No entry is the same as one that doesn't cover anything: the main agent is asked, a child is refused.
      found = undefined
    }
    const entry = found?.entry

    let cover: 'judge' | 'you' | undefined
    /** Set when the request is the gate's ask that showed you the escalation: your yes to it is written there. */
    let shown: Found | undefined
    try {
      // A cover is used up before the request is answered, so that it covers one request; one that can't be used up covers nothing.
      if (found !== undefined && covers(found.entry, request)) {
        if (cache.replace(found.owner, found.callId, found.entry, { ...found.entry, escalationCovered: false })) cover = 'judge'
      } else if (found !== undefined && yourYesCovers(topLevel, found.entry, request)) {
        if (cache.replace(found.owner, found.callId, found.entry, { ...found.entry, coveredByYou: false })) cover = 'you'
      } else if (found !== undefined && showsYouTheEscalation(found.entry, request)) {
        shown = found
      }
    } catch {
      // Nothing is covered by what can't be read, or used up.
    }
    const verdict = decide(topLevel, entry, cover, shown !== undefined)

    try {
      const tool = typeof request?.toolName === 'string' && request.toolName !== '' ? request.toolName : undefined
      const asked = typeof request?.reason === 'string' && request.reason.trim() !== '' ? ` (${clip(request.reason.trim(), MAX_REASON_CHARS)})` : ''
      const line: JudgeLogLine = {
        at: now(),
        purpose: 'approval',
        ...owner === undefined || owner === '' ? {} : { agent: owner },
        child: !topLevel,
        ...tool === undefined ? {} : { tool },
        ...callId === undefined ? {} : { callId },
        subject: `${tool ?? 'an unnamed tool'}: ${verdict.why}${asked}`,
        answers: {},
        decision: verdict.decision,
        latencyMs: null,
        error: null,
      }
      log.write(line)
    } catch {
      // A line that can't be written changes nothing.
    }

    if (verdict.decision !== 'pass') return Promise.resolve(verdict.decision)
    if (shown === undefined) return next()
    // The gate's ask that showed you the escalation: your yes to it covers the escalation's request, if the entry is still the one
    // you were asked about (a child never gets here: it is never passed on).
    const asked = shown
    return next().then((outcome) => {
      if (outcome === 'allowed-once') {
        try {
          cache.replace(asked.owner, asked.callId, asked.entry, { ...asked.entry, coveredByYou: true })
        } catch {
          // Not recorded: the escalation is put to you.
        }
      }
      return outcome
    })
  }
}

// --- the children's policy ----------------------------------------------------------------------------

/** How long the lookup in crew's record may take before the child is left at `never`: 2 s. It reads two small files. */
export const CREW_LOOKUP_BUDGET_MS = 2000

/** What the switch needs of crew's `dishCrew` service: the record's lookup by child id. */
export interface CrewLookup {
  readonly records: { lookup(childId: string): Promise<unknown> }
}

/** What the policy reads of the approval service: a session's override, and the deployment's default policy. */
export type ApprovalPolicies = Pick<ApprovalService, 'overrideOf'> & { readonly config?: { readonly policy?: 'ask' | 'never' } }

/** What the policy reads of dsh's agent registry (`ctx.agents`): a live agent by id. */
export interface LiveAgents {
  get(id: string): unknown
}

export interface ChildPolicyDeps {
  /** The approval service, looked up on each call (it is a sibling's). Without one, there is no policy to switch. */
  approval(): ApprovalPolicies | undefined
  /** Crew's service, looked up on each call. Without one, no child is known to be crew's. */
  crew(): CrewLookup | undefined
  /** The live agents, looked up on each call: a child's parent is one. Without them no child's parent can be read. */
  agents(): LiveAgents | undefined
  /** Says a problem once, as the plugin's `warnOnce` does. */
  tell?: (message: string) => void
  /** How long a crew lookup may take. */
  lookupBudgetMs?: number
}

/** The `agent/created` payload, as far as the switch reads it. */
export interface CreatedPayload {
  readonly agent?: unknown
  readonly source?: unknown
  readonly signal?: AbortSignal
}

export interface ChildPolicy {
  /** The `agent/created` listener. Serial and awaited by dsh before the agent is released, so it must come back, and never throw. */
  created(payload: CreatedPayload): Promise<undefined>
  /** The `agent/disposed` listener: forget the agent, so that nothing keeps its session alive or touches it later. */
  disposed(payload: { readonly agent?: unknown }): void
  /** Put `never` back on every session this switched that is still live. Once. Never throws. */
  restore(): void
}

type Session = Parameters<typeof setApprovalPolicy>[0]
type Approval = ApprovalPolicies

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** `promise`, or a rejection once `ms` have passed. The timer does not keep the process alive. */
function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { reject(new Error(`no answer in ${ms} ms`)) }, ms)
    timer.unref()
  })
  return Promise.race([promise, late]).finally(() => { clearTimeout(timer) })
}

/** Whether crew's record knows `childId`. @throws if the lookup fails or takes longer than `budgetMs`. */
async function isCrewChild(crew: CrewLookup, childId: string, budgetMs: number): Promise<boolean> {
  const found = await within(Promise.resolve().then(() => crew.records.lookup(childId)), budgetMs)
  return found !== undefined && found !== null
}

/**
 * The policy switch of crew's children, and its undo: see the header. A child is switched when it is not top-level, its
 * policy is `never` as dsh pinned it (no override at all, or `ask` already, is left as it is), and crew's record knows it.
 */
export function childPolicy(deps: ChildPolicyDeps): ChildPolicy {
  const tell = deps.tell ?? (() => {})
  const budgetMs = deps.lookupBudgetMs ?? CREW_LOOKUP_BUDGET_MS
  /** The sessions this switched or found at `ask`, with the service that reads their policy, so that nothing is looked up when the plugin goes. */
  const switched = new Map<Session, Approval>()
  /** Set by `restore`: from then on nothing is switched, so a lookup that ends after the plugin went can't leave an `ask` behind. */
  let closed = false

  /**
   * The effective policy of the parent of `agent`: its own override, else the deployment's default. `undefined` if the parent can't
   * be found (no registry, not live, no `parentSession` in the header) or read: that is not `ask`.
   */
  const parentPolicyOf = (agent: GateAgent, approval: Approval): 'ask' | 'never' | undefined => {
    try {
      const parentId = (agent.session as { header?: { parentSession?: unknown } } | undefined)?.header?.parentSession
      if (typeof parentId !== 'string' || parentId === '') return undefined
      const parent = deps.agents()?.get(parentId) as { session?: unknown } | undefined
      const session = parent?.session as Session | undefined | null
      if (session === undefined || session === null) return undefined
      return approval.overrideOf(session) ?? approval.config?.policy ?? 'ask'
    } catch {
      return undefined
    }
  }

  return {
    async created(payload) {
      try {
        const agent = asAgent(payload?.agent)
        const cancelled = (): boolean => closed || payload.signal?.aborted === true
        if (agent === undefined || cancelled()) return undefined
        if (isTopLevelAgent(agent)) return undefined
        const approval = deps.approval()
        const session = (agent as { session?: unknown }).session as Session | undefined | null
        if (approval === undefined || session === undefined || session === null) return undefined
        // The pin dsh-subagent made, or a crew child that a resume brings back at ask (a follow-up to one that settled while this
        // was loaded, or a crash): that one is not switched again, but it is put back to never when the plugin goes.
        const before = approval.overrideOf(session)
        if (before !== 'never' && before !== 'ask') return undefined
        // A child never gets more than its parent: a parent at never has its own escalations rejected, and would see its
        // child's approved. Nothing to do for a child that is at never already, and crew need not be asked.
        const wantsAsk = parentPolicyOf(agent, approval) === 'ask'
        if (before === 'never' && !wantsAsk) return undefined

        const crew = deps.crew()
        if (crew === undefined) return undefined
        const id = verdictOwner(agent)
        let known: boolean
        try {
          known = id !== '' && await isCrewChild(crew, id, budgetMs)
        } catch (error) {
          tell(`could not tell whether a new child agent is one of the crew's (${describe(error)}); its approval policy stays "${before}", so ${before === 'never' ? 'its escalations are refused' : 'check that dish-crew is running'}`)
          return undefined
        }
        if (!known || cancelled()) return undefined
        // Someone else may have changed it while the record was read.
        if (approval.overrideOf(session) !== before) return undefined

        if (wantsAsk) {
          if (before === 'never') setApprovalPolicy(session, 'ask')
          switched.set(session, approval)
        } else {
          // At ask, with a parent that is not: back to never, and nothing for this to restore.
          setApprovalPolicy(session, 'never')
        }
      } catch (error) {
        tell(`could not switch a crew child's approval policy (${describe(error)}); it stays as it was`)
      }
      return undefined
    },

    disposed(payload) {
      try {
        const session = (asAgent(payload?.agent) as { session?: unknown } | undefined)?.session
        if (typeof session === 'object' && session !== null) switched.delete(session as Session)
      } catch {
        // Nothing to forget.
      }
    },

    restore() {
      closed = true
      for (const [session, approval] of [...switched]) {
        switched.delete(session)
        try {
          // Only if it is still what this made it: a session someone has put back, or switched on, is theirs.
          if (approval.overrideOf(session) === 'ask') setApprovalPolicy(session, 'never')
        } catch (error) {
          tell(`could not put a crew child's approval policy back to "never" (${describe(error)}); if dish-judge stays unloaded, that child's approval requests go to the browser`)
        }
      }
    },
  }
}

// --- registration -----------------------------------------------------------------------------------

/**
 * Register the answerer and the children's policy on `ctx`, the host context. There is no `await` here: the plugin's `start`
 * has none, so that a load that is slow can never leave a window with the plugin there and no answerer.
 *
 * - **`approval/request`, prepended,** so that it runs before the browser's answerer, and answers (for a child, always)
 *   without it.
 * - **`agent/created`** switches crew's children to `ask`, and **`agent/disposed`** forgets the agents that go.
 * - **An effect that restores `never`** on every session the plugin switched, when the plugin is disposed: see the header.
 *
 * Everything else is looked up with `ctx.get` on each use, because the services are siblings' and may come and go: the
 * decision log (`dishJudge`), the approval service and crew's record. `cache` is the command gate's (`registerCommandGate`).
 * @param tell says a problem once (the plugin's `warnOnce`).
 */
export function registerApprovalAnswerer(ctx: Context, cache: VerdictCache, tell?: (message: string) => void): void {
  const log: AnswererLog = {
    write(line) {
      try {
        ctx.get('dishJudge')?.log.write(line)
      } catch {
        // No log: the decision stands.
      }
    },
  }
  ctx.on('approval/request', approvalAnswerer(cache, log), { prepend: true })

  const lookup = ctx as unknown as { get(name: string): unknown }
  const policy = childPolicy({
    approval: () => ctx.get('approval'),
    crew: () => lookup.get('dishCrew') as CrewLookup | undefined,
    agents: () => lookup.get('agents') as LiveAgents | undefined,
    ...tell === undefined ? {} : { tell },
  })
  ctx.on('agent/created', policy.created)
  ctx.on('agent/disposed', policy.disposed)
  ctx.effect(() => () => { policy.restore() })
}
