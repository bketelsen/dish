/**
 * The events crew publishes, for a plugin that keeps an account of the crew's work (dish-orchestrator's ledger):
 *
 * - `dish-crew/delegated`: a child was recorded by `delegate`, a start (`addChild`, before dsh starts the child) or a
 *   follow-up (`addFollowUp`, after it was sent). Published and awaited inside `delegate`'s session lock, so a listener that
 *   queues its work before it returns has it queued before the next delegation of that session is checked;
 * - `dish-crew/settled`: a run of a crew child was filed (`endRun`), by the host's `subagent/end` listener, or by `delegate`
 *   for a start dsh refused. It carries the child as filed and the run, with its structured report when it ended with one.
 *
 * Each is published with `ctx.parallel`, as dish-projects publishes its own, and awaited for at most `EVENT_BUDGET_MS`:
 * crew goes on without a listener that takes longer, and a listener's failure is logged, never thrown. What a listener gets
 * is a copy: what it does with it changes nothing of crew's.
 *
 * @module dish-crew/events
 */
import type { Context } from '@deepseek-ai/cordis'
import { maskSecrets } from 'dish-kit'
import { describe, within } from './guard.ts'
import type { ChildRecord, RunRecord } from './record.ts'

/** How long a publish waits for its listeners: 10 s. A listener queues its work and returns; this is for one that doesn't. */
export const EVENT_BUDGET_MS = 10_000

/** `dish-crew/delegated`'s payload. */
export interface CrewDelegated {
  /** The session (the main agent's id) that delegated. */
  sessionId: string
  /** The child as recorded: after `addChild` for a start, after `addFollowUp` for a follow-up. */
  child: ChildRecord
  followUp: boolean
}

/** `dish-crew/settled`'s payload. */
export interface CrewSettled {
  /** The session the child belongs to. */
  sessionId: string
  /** The child as filed. */
  child: ChildRecord
  /** The run just filed: `child.runs.at(-1)`. */
  run: RunRecord
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** After `addChild` (before dsh starts the child) or after `addFollowUp`. */
    'dish-crew/delegated'(event: CrewDelegated): void | Promise<void>
    /** After `endRun` filed a run. */
    'dish-crew/settled'(event: CrewSettled): void | Promise<void>
  }
}

/** Publish one of crew's events. Never rejects. */
export type Publish = {
  (name: 'dish-crew/delegated', event: CrewDelegated): Promise<void>
  (name: 'dish-crew/settled', event: CrewSettled): Promise<void>
}

/** Whether `error` is cordis refusing an effect because a plugin has been unloaded: a plugin that is going away didn't fail. */
function unloaded(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'INACTIVE_EFFECT'
}

/**
 * `ctx.parallel(name, event)`, awaited for at most `budgetMs`, with a copy of `event`.
 * - A listener that fails is logged, once for each cause, and one that outlasts the wait is logged once for the publish.
 * - A plugin that is going away (cordis' `INACTIVE_EFFECT`, thrown or rejected) is silent.
 * - Never rejects.
 */
export function publisher(ctx: Context, warn: (format: string, ...args: unknown[]) => void, budgetMs: number = EVENT_BUDGET_MS): Publish {
  const say = (format: string, ...args: unknown[]): void => {
    try {
      warn(format, ...args)
    } catch {
      // A logger that throws is not worth a failed delegation.
    }
  }
  const failed = (name: string, error: unknown): void => {
    for (const cause of error instanceof AggregateError ? error.errors : [error]) {
      try {
        if (!unloaded(cause)) say('a %s listener failed: %s', name, maskSecrets(describe(cause)))
      } catch {
        // A cause that can't be read (no `toString`, or one that throws) is still a failure, and still never rejects.
        say('a %s listener failed', name)
      }
    }
  }
  const publish = async (name: 'dish-crew/delegated' | 'dish-crew/settled', event: CrewDelegated | CrewSettled): Promise<void> => {
    let outcome: Promise<{ error?: unknown }>
    try {
      const dispatch = ctx.parallel as (name: string, event: unknown) => Promise<void>
      // Listeners are called now, synchronously (cordis' `parallel`); what is awaited is what they return.
      outcome = dispatch.call(ctx, name, structuredClone(event)).then(() => ({}), (error: unknown) => ({ error }))
    } catch (error) {
      outcome = Promise.resolve({ error })
    }
    let result: { error?: unknown }
    try {
      result = await within(outcome, budgetMs)
    } catch {
      say('%s listeners took longer than %d s; crew went on without them', name, budgetMs / 1000)
      return
    }
    if ('error' in result) failed(name, result.error)
  }
  return publish as Publish
}
