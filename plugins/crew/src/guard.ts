/**
 * The approval guard: a host-level `approval/request` listener that refuses a crew child's approval request when dish-judge is
 * not there, so that a crew child never waits on a human, with or without dish-judge.
 *
 * ### Why crew has it
 *
 * dsh pins every child to the approval policy `never`, and rejects a child's request before any answerer hears it. dish-judge
 * switches crew's children to `ask`, so that its answerer can approve an escalation its command gate has judged, and it is
 * then the only answerer a child has. If that answerer is not there, a child at `ask` is not refused: dsh's waterfall goes on to
 * the browser's answerer, which shows the prompt in the child's own session, where nobody is looking, and **nothing times it
 * out** (not the approval service, the gateway, the UI or dsh's `bash`). The child waits until someone interrupts it.
 *
 * dish-judge puts `never` back on the children it switched when it is unloaded, but that reaches only the children that are
 * live then. A child that has settled (dsh-subagent flushes an idle child's final state and only then disposes it, so nothing
 * written after that is reliably kept) keeps `ask` in its durable log, and so does one whose process died. A follow-up (`delegate` with `to`) cold-resumes it at
 * `ask`. If dish-judge is not loaded then (disabled, uninstalled, failed to load, unloaded, or a restart without it), nothing of
 * dish-judge's runs, and this guard is what stands between that child and the browser. It is here because it is crew that makes
 * the children, and crew is the plugin that is there when dish-judge is not.
 *
 * ### What it does
 *
 * - **dish-judge is there** (the `dishJudge` service, read with `ctx.get` on each request, so the load order and a reload make no
 *   difference): `next()`. dish-judge's answerer, which is prepended too and runs whichever was loaded first or last, decides.
 * - **It is not, and the agent is a crew child** (not top-level by `isTopLevelAgent`, and in crew's record): `'rejected'`. A
 *   record that can't be read, or that takes longer than `GUARD_LOOKUP_BUDGET_MS`, is the same: a child that can't be told from
 *   crew's is not put to a human either, because the cost of a refusal is a child that reports its limit to the main agent, and
 *   the cost of the other is a child that hangs. One warning for each distinct problem.
 * - **Anything else** (a top-level agent, a child that isn't crew's, a request with no agent): `next()`. They are not crew's
 *   business: the main agent's prompts are for you, and other plugins' children keep what dsh gave them.
 *
 * @module dish-crew/guard
 */

import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { isTopLevelAgent } from 'dish-kit'

/** How long the guard waits for crew's record before it refuses: 2 s. The lookup reads two small files. */
export const GUARD_LOOKUP_BUDGET_MS = 2000

export interface ApprovalGuardDeps {
  /** Whether dish-judge is there. Read on each request. If it throws, dish-judge is taken as not there. */
  judgeIsLoaded(): boolean
  /** Whether crew's record knows this child id: `records.lookup` found it. May reject. */
  isCrewChild(childId: string): Promise<boolean>
  /** Says a problem once. Never needs to throw. */
  tell?: (message: string) => void
  /** How long a lookup may take. */
  budgetMs?: number
}

/** The part of dsh's approval request the guard reads. */
export interface GuardRequest {
  readonly agent?: unknown
}

export type ApprovalGuard = (request: GuardRequest, next: () => Promise<ApprovalOutcome>) => Promise<ApprovalOutcome>

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** An agent's id: a non-empty string `id`, or `undefined`. */
function idOf(agent: unknown): string | undefined {
  const id = typeof agent === 'object' && agent !== null ? (agent as { id?: unknown }).id : undefined
  return typeof id === 'string' && id !== '' ? id : undefined
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

/** The `approval/request` listener: see the header. It never throws, and never calls `next()` for a crew child it has refused. */
export function approvalGuard(deps: ApprovalGuardDeps): ApprovalGuard {
  const tell = deps.tell ?? (() => {})
  const budgetMs = deps.budgetMs ?? GUARD_LOOKUP_BUDGET_MS
  return async (request, next) => {
    let judgeIsLoaded: boolean
    try {
      judgeIsLoaded = deps.judgeIsLoaded()
    } catch {
      judgeIsLoaded = false
    }
    if (judgeIsLoaded) return next()

    const agent = request?.agent
    let topLevel = false
    try {
      topLevel = isTopLevelAgent(agent as Parameters<typeof isTopLevelAgent>[0])
    } catch {
      // An agent that can't be read is not vouched for: it is looked up like any child.
    }
    if (topLevel) return next()
    let id: string | undefined
    try {
      id = idOf(agent)
    } catch {
      id = undefined
    }
    if (id === undefined) return next()

    let known: boolean
    try {
      known = await within(Promise.resolve().then(() => deps.isCrewChild(id)), budgetMs)
    } catch (error) {
      tell(`could not tell whether a child agent asking for approval is one of the crew's (${describe(error)}); with dish-judge not loaded it is refused`)
      return 'rejected'
    }
    return known ? 'rejected' : next()
  }
}
