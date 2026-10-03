/**
 * dish-crew: a fixed crew of specialists the main agent delegates to.
 *
 * This is the host plugin. The `delegate` tool and the finish notices are a preset row, `dish-crew/delegate`, which
 * reads what is provided here. The plugin:
 *
 * - provides the `dishCrew` service: `settings()` is the `crew.yaml` in the config store as it is now (see
 *   `settings.ts`), `records` is the crew's own record of its children, their reports and the gate results dish-gates
 *   records for coders bound to a worktree (`addGate`; see `record.ts`),
 *   `whenRecorded(child)` is the run of that child that is being recorded now, if there is one, and
 *   `worktreeBindings(path)` is the children bound to a worktree, with whether each is running (for `delegate`, and for
 *   dish-workspaces' `list`, `remove` and sweep);
 * - captures every crew child's runs: the error an `agent/error` reports is held for the child, `subagent/end` files the
 *   run, with that error, the closing message and the id of its finish notice, in the record, and `subagent/start` marks
 *   the child running again (dsh starts a run each time it brings a child up, not only the first). A child's starts and
 *   ends are recorded in the order they were published. The listeners are the host's, so they hear every agent, and they
 *   act only on children the record knows. They never throw;
 * - publishes `dish-crew/settled` (see `events.ts`) once `subagent/end` has filed a crew child's run, with the session, the
 *   child as filed and the run (its structured report included), and awaits its listeners, up to their budget, before
 *   `whenRecorded` resolves: a child's next start or end waits as well. `delegate` publishes `dish-crew/delegated`, and the
 *   `settled` of a start dsh refused;
 * - keeps the id of each finish notice: an `agent/inbox/inserted` listener notes a `subagent-settled` message's id for its
 *   child, and that child's `subagent/end`, which dsh emits in the same synchronous run, just after it delivers the notice
 *   (`notifySettlement`, then `observer.settle`, in dsh-subagent), takes it for the run (`RunRecord.notice`). An id whose end
 *   doesn't come in that run is dropped at the next microtask, so it can't land on a later run;
 * - at start, before it provides the service, removes the sessions' records not written to for 180 days;
 * - guards its children's approvals (see `guard.ts`): an `approval/request` listener that refuses a crew child's request when
 *   dish-judge, whose answerer is the only one a child has, is not loaded. It is registered before anything is awaited, so there is
 *   no start-up window without it;
 * - guards its children's reports (see `report-guard.ts`): a prepended `tools/pre-execute` listener that refuses a crew child's
 *   `send_message` longer than `messageLimit` characters and then closes `send_message` to that child until its run ends
 *   (`subagent/end` opens it), so that a child reports once, in its closing message, and the main agent gets one delivery.
 *   Registered with the approval guard, before anything is awaited;
 * - claims `crew.yaml` in the store and seeds it when `dishConfig` is there, moving an unedited earlier default to the
 *   current one. `dishConfig` is optional, so there is no order to keep: with no store, every answer is the shipped
 *   default;
 * - logs as `dish-crew`.
 *
 * @module dish-crew
 */

import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { printOwnLogs, xdgPaths } from 'dish-kit'
import { publisher } from './events.ts'
import { approvalGuard } from './guard.ts'
import { CrewRecords, closingOf, isRunning } from './record.ts'
import type { EndedRun, LiveAgents } from './record.ts'
import { DEFAULT_MESSAGE_LIMIT, reportGuard } from './report-guard.ts'
import { CREW_SPEC, DEFAULT_SETTINGS, DEFAULT_TEXT, PREVIOUS_HASHES, parseSettings } from './settings.ts'
import type { CrewSettings } from './settings.ts'

export type { CrewSettings, FamilySettings, Limits, ParseResult, RoleSettings, Tier } from './settings.ts'
export type { ChildRecord, ChildStatus, EndedRun, GateOutcome, GateResult, LiveAgents, NewChild, RunEnd, RunRecord } from './record.ts'
export { CrewRecords, gateProblem, isRunning, latestGate, statusFor } from './record.ts'
export type {
  CoderReport, CoderStatus, NotFixed, ReportRole, ReportRuling, ReviewAddressed, ReviewCheck, ReviewerReport, ReviewFinding, Severity,
  StructuredReport, Verdict,
} from './record.ts'
export { CODER_STATUSES, SEVERITIES, VERDICTS, maskReport, reportProblem, reportRole } from './record.ts'
export type { CrewDelegated, CrewSettled } from './events.ts'

export const name = 'dish-crew'

/** A crew child bound to a worktree, as `worktreeBindings` gives it. */
export interface WorktreeBinding {
  /** The child's agent (session) id. */
  child: string
  /** The session that started it. */
  sessionId: string
  role: string
  title: string
  /** Whether it is running now, by `isRunning`: dsh's agent registry, else the record's word. */
  running: boolean
}

/** The `dishCrew` service. */
export interface DishCrew {
  /**
   * The crew's settings: `crew.yaml` on `main` of the config store as it is now, so an edit shows at once. A missing
   * file, a file that doesn't pass `parseSettings`, a store that can't be read and no store at all each give the
   * shipped default, with one logged warning for each distinct problem. Never rejects.
   */
  settings(): Promise<CrewSettings>
  /** The crew's record: its children by session, and each run's report. */
  readonly records: CrewRecords
  /**
   * The latest `subagent/end` of `childId` that is still being recorded, or `undefined` if none is. It resolves, never
   * rejects, with where the report went and what was filed, or `undefined` if the child isn't a crew child or recording
   * failed (which is logged). It resolves once `dish-crew/settled`'s listeners have, or their budget is spent. Once it has
   * resolved it is gone from here: the run is in `records`.
   */
  whenRecorded(childId: string): Promise<EndedRun | undefined> | undefined
  /** The `ctx.subagents` provider the crew's children are created on: the `subagentProvider` setting. The preset row can't see the host's config. */
  readonly subagentProvider: string
  /**
   * The crew children bound to `worktree`, across sessions, oldest first. `worktree` is an absolute path, made canonical
   * with `realpath` (taken as it is when that fails, as for a worktree that is gone) and compared exactly with the
   * canonical paths the record holds. Each says whether it is running: dsh's agent registry (`ctx.get('agents')`) says
   * so, or the record says running and the agent exists, which is `delegate`'s rule; with no registry, the record's
   * `last === 'running'`. Rejects only if the record can't be read.
   */
  worktreeBindings(worktree: string): Promise<WorktreeBinding[]>
}

// Here, with the type, so that whoever imports it also gets `ctx.get('dishCrew')` typed.
declare module '@deepseek-ai/cordis' {
  interface Context {
    dishCrew: DishCrew
  }
}

export interface Config {
  dataDirectory: string
  subagentProvider: string
  messageLimit: number
  terminal: boolean
}

export const Config: Schema<Config> = Schema.object({
  dataDirectory: Schema.string().default('')
    .description('Where the crew\'s records and saved reports go: an absolute path, where a leading ~/ is your home directory. Leave blank for crew in the XDG data directory for dish.'),
  subagentProvider: Schema.string().default('spawn')
    .description('The ctx.subagents provider that creates the crew\'s children in-process.'),
  messageLimit: Schema.natural().default(DEFAULT_MESSAGE_LIMIT)
    .description('The most characters a crew child\'s send_message may have. A longer one is taken for the child\'s report: it is refused, and send_message stays closed to that child until it finishes, so that its closing message is its report and the main agent gets one delivery, not two. 0 turns this off.'),
  terminal: Schema.boolean().default(true)
    .description('Print this plugin\'s messages to the terminal.'),
})

/** A string setting as it will be used: trimmed, and `undefined` when nothing is left (use the default). */
function text(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === '' ? undefined : trimmed
}

/**
 * Where the crew's data lives: the setting with a leading `~/` (or a bare `~`) taken as the home directory, else the XDG default.
 * @throws a plain `Error` for any other relative path: what it would be relative to is not something to guess.
 */
export function dataDirectoryPath(setting: string | undefined): string {
  if (setting === undefined) return join(xdgPaths('dish').data, 'crew')
  if (setting === '~') return homedir()
  if (setting.startsWith('~/')) return join(homedir(), setting.slice(2))
  if (!isAbsolute(setting)) throw new Error(`dataDirectory must be an absolute path (or start with ~/), got ${JSON.stringify(setting)}`)
  return setting
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** What the settings need of the store: its reads. */
type Reader = { read(path: string): Promise<string | undefined> }

interface Logger {
  warn(format: string, ...args: unknown[]): void
}

/**
 * `settings()` over a store that may or may not be there, looked up on every call. Each distinct problem is logged
 * once, and none of it is thrown: a delegation reads this on every call, and the shipped default always works.
 */
function createSettingsReader(store: () => Reader | undefined, logger: Logger): () => Promise<CrewSettings> {
  const told = new Set<string>()
  /** Say `message` once. A logger that throws is not worth a failed call. */
  const tell = (message: string): void => {
    if (told.has(message)) return
    told.add(message)
    try {
      logger.warn('%s', message)
    } catch {
      // Nothing to do about it.
    }
  }
  return async () => {
    try {
      const reader = store()
      if (reader === undefined) {
        tell('dish-config is not running; using the shipped crew.yaml')
        return DEFAULT_SETTINGS
      }
      let stored: string | undefined
      try {
        stored = await reader.read('crew.yaml')
      } catch (error) {
        tell(`could not read crew.yaml from the config store (${describe(error)}); using the shipped default`)
        return DEFAULT_SETTINGS
      }
      if (stored === undefined) {
        tell('crew.yaml is not in the config store; using the shipped default')
        return DEFAULT_SETTINGS
      }
      const parsed = parseSettings(stored)
      if (!parsed.ok) {
        tell(`crew.yaml in the config store is not valid, so the shipped default is used: ${parsed.problem}`)
        return DEFAULT_SETTINGS
      }
      return parsed.settings
    } catch (error) {
      tell(`could not get the crew settings (${describe(error)}); using the shipped default`)
      return DEFAULT_SETTINGS
    }
  }
}

/** How long a session's record is kept without being written to. */
const KEEP_RECORDS_MS = 180 * 24 * 60 * 60 * 1000
/** How many children's errors are held for the `subagent/end` that follows. A child ends within moments of its error. */
export const ERROR_MEMORY = 64
/** The longest an error is kept, in characters: a record of it, not a copy of a stack. */
const MAX_ERROR_LENGTH = 1000

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** An agent's or a child's id from `value`, if it has one: a non-empty string `id`. */
function idOf(value: unknown): string | undefined {
  const id = isObject(value) ? value.id : undefined
  return typeof id === 'string' && id !== '' ? id : undefined
}

/** `error` as a short line: an error's message, a string, a message in an object, or a short form of anything else. */
function errorText(error: unknown): string {
  let text = ''
  try {
    if (error instanceof Error) text = error.message.trim() || error.name
    else if (typeof error === 'string') text = error.trim()
    else if (isObject(error) && typeof error.message === 'string' && error.message.trim() !== '') text = error.message.trim()
    else if (error !== undefined && error !== null) text = JSON.stringify(error) ?? String(error)
  } catch {
    try {
      text = String(error)
    } catch {
      text = ''
    }
  }
  if (text === '') return 'unknown error'
  return text.length > MAX_ERROR_LENGTH ? `${text.slice(0, MAX_ERROR_LENGTH - 1)}…` : text
}

/** Whether `error` is cordis refusing an effect because the plugin has been unloaded: a plugin that is going away didn't fail. */
function unloaded(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'INACTIVE_EFFECT'
}

/**
 * Provide `dishCrew`, and claim and seed `crew.yaml` whenever the store is there.
 * @throws a plain `Error` for a `dataDirectory` that is a relative path.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const logger = ctx.logger(name)
  if (config.terminal) printOwnLogs(ctx, name)
  /** A logger that throws is not worth a failed event, a failed lookup or a failed start. */
  const warn = (format: string, ...args: unknown[]): void => {
    try {
      logger.warn(format, ...args)
    } catch {
      // Nothing to do about it.
    }
  }

  // Checked now, so a bad setting fails the plugin to load rather than the first delegation.
  const directory = resolve(dataDirectoryPath(text(config.dataDirectory)))
  const records = new CrewRecords(directory, (session, path) => {
    warn('the record of session %s is not valid; it was moved to %s and the session starts a new one, so its delegation count starts again from 0', session, path)
  })
  // `dish-crew/settled`, once a run is filed. Before the first `await`, like the listeners.
  const publish = publisher(ctx, warn)

  // A crew child asks nobody but dish-judge: when dish-judge is not loaded, its approval requests are refused here, not left to the
  // browser, where nobody sees them and nothing times them out. The services are looked up on each request, so the order the two
  // plugins load in, and a reload of either, make no difference. Before the first `await`, like the listeners below.
  const lookup = ctx as unknown as { get(name: string): unknown }
  /** Whether crew's record knows this child: the question both guards ask. */
  const isCrewChild = async (childId: string): Promise<boolean> => (await records.lookup(childId)) !== undefined
  const toldGuard = new Set<string>()
  ctx.on('approval/request', approvalGuard({
    judgeIsLoaded: () => lookup.get('dishJudge') !== undefined,
    isCrewChild,
    tell: (message) => {
      if (toldGuard.has(message) || toldGuard.size >= 100) return
      toldGuard.add(message)
      warn('%s', message)
    },
  }), { prepend: true })

  // A crew child reports once, in its closing message: a `send_message` longer than `messageLimit` is refused, and the child may not
  // send another until its run ends (see `report-guard.ts`; `subagent/end` below opens it). Prepended, like the guard above, so
  // that a call it refuses reaches nothing after it: no PreToolUse hook, no auto-review classifier (an LLM call) and no
  // workspace-changes recorder, which is the judge's own rule for its gate (`plugins/judge/src/gate.ts`). The judge's gate is
  // prepended as well, so which of the two is first is up to the load order, and it makes no difference for `send_message`: the gate
  // doesn't gate `send_message` by default (`tools.gated`) and calls `next()` for any call it doesn't gate, and when it does gate
  // one it calls `next()` for an allow or an ask and keeps the stricter answer, which is our deny. It says each distinct problem
  // once itself. Before the first `await`, like the listeners above and below.
  const report = reportGuard({
    messageLimit: config.messageLimit,
    isCrewChild,
    tell: (message) => { warn('%s', message) },
  })
  ctx.on('tools/pre-execute', report, { prepend: true })

  // The error each crew child's agent last reported, until its `subagent/end`. The promise answers whether the agent is a
  // crew child (the record has to be asked), and an agent that isn't takes its entry out, so what is kept is the
  // children's and no more. Oldest first, and bounded: a child whose end never comes can't grow this.
  const remembered = new Map<string, Promise<string | undefined>>()
  // What is being recorded for each child, a start or an end, until it is: the one the next waits for, so that a child's
  // runs reach the record in the order dsh published them, an end before the next start and a start before its end.
  // Never rejects.
  const chain = new Map<string, Promise<void>>()
  // The end of each child that is being recorded now, until it is. For `whenRecorded`: starts are not in it. Never rejects.
  const pending = new Map<string, Promise<EndedRun | undefined>>()
  // The id of the finish notice dsh just delivered for each child, until that child's `subagent/end` takes it, or the
  // microtask after it was delivered drops it: dsh delivers the notice and emits the end in one synchronous run.
  const settling = new Map<string, string>()

  /** Do `job` for child `id` after whatever is being recorded for it. A failure is logged as `failed` says and gives `undefined`. */
  const inOrder = <T>(id: string, failed: string, job: () => Promise<T>): Promise<T | undefined> => {
    const previous = chain.get(id)
    const run = (async () => {
      await previous
      return job()
    })().catch((cause: unknown) => {
      warn(failed, id, describe(cause))
      return undefined
    })
    const link = run.then(() => {})
    chain.set(id, link)
    void link.then(() => {
      if (chain.get(id) === link) chain.delete(id)
    })
    return run
  }

  // A shutdown waits for what is being recorded: a run that ended just before it is not lost. cordis disposes a plugin's
  // effects together, one microtask after dispose(), so removing the listeners and taking this snapshot of `chain` happen
  // in the same batch: everything heard is in the snapshot, and nothing after it is heard, whatever the registration order.
  ctx.effect(() => async () => {
    await Promise.all([...chain.values()])
    await records.flush()
  })

  ctx.on('agent/error', (payload) => {
    try {
      const event: unknown = payload
      const id = idOf(isObject(event) ? event.agent : undefined)
      if (id === undefined) return
      const message = errorText((event as { error?: unknown }).error)
      const found = records.lookup(id).then(
        hit => hit === undefined ? undefined : message,
        (cause: unknown) => {
          warn('could not tell whether agent %s is a crew child: %s', id, describe(cause))
          return undefined
        })
      // Last, so that the oldest entry is the first out.
      remembered.delete(id)
      remembered.set(id, found)
      while (remembered.size > ERROR_MEMORY) remembered.delete(remembered.keys().next().value!)
      void found.then((kept) => {
        if (kept === undefined && remembered.get(id) === found) remembered.delete(id)
      })
    } catch (cause) {
      warn('could not note the error of an agent: %s', describe(cause))
    }
  })

  // dsh publishes a start for every run of a child: its first, and each time it is brought up again after it had ended (a
  // message to it, a resume after a restart). The record says running from the first and from a follow-up that `delegate`
  // sends; this is how it learns of the others, so that a child that is running again counts against the limits.
  ctx.on('subagent/start', (info) => {
    try {
      const id = idOf(info)
      if (id === undefined) return
      void inOrder(id, 'could not record the start of child %s: %s', () => records.startRun(id))
    } catch (cause) {
      warn('could not record the start of a child: %s', describe(cause))
    }
  })

  // dsh delivers a child's finish notice to its parent's inbox (`notifySettlement` in dsh-subagent) and then, in the same
  // synchronous run, emits the child's `subagent/end` (`observer.settle`): the id is noted here and taken there.
  ctx.on('agent/inbox/inserted', (payload) => {
    try {
      const message: unknown = (payload as { message?: unknown } | null | undefined)?.message
      if (!isObject(message)) return
      const { source, id } = message as { source?: unknown, id?: unknown }
      if (!isObject(source) || source.kind !== 'subagent-settled') return
      const sender = source.senderSessionId
      if (typeof sender !== 'string' || sender === '' || typeof id !== 'string') return
      const noticeId = String(id)
      settling.set(sender, noticeId)
      queueMicrotask(() => {
        if (settling.get(sender) === noticeId) settling.delete(sender)
      })
    } catch (cause) {
      warn('could not note the finish notice of a child: %s', describe(cause))
    }
  })

  ctx.on('subagent/end', (info) => {
    try {
      const event: unknown = info
      const id = idOf(event)
      if (id === undefined) return
      // The run is over: the child may send_message again in its next one (a follow-up, `delegate` with `to`).
      report.runEnded(id)
      const { stopReason, lastAssistantMessage } = event as { stopReason?: unknown, lastAssistantMessage?: unknown }
      const error = remembered.get(id)
      remembered.delete(id)
      const notice = settling.get(id)
      settling.delete(id)
      const closing = closingOf(lastAssistantMessage)
      const run = inOrder(id, 'could not record the end of child %s: %s', async () => {
        const ended = await records.endRun(id, { stopReason: stopReason as string, error: await error, closing, ...notice === undefined ? {} : { notice } })
        // Awaited here, so `whenRecorded`, and this child's next start or end, wait for the listeners (up to their budget).
        if (ended !== undefined) await publish('dish-crew/settled', { sessionId: ended.sessionId, child: ended.child, run: ended.run })
        return ended
      })
      pending.set(id, run)
      void run.then(() => {
        if (pending.get(id) === run) pending.delete(id)
      })
    } catch (cause) {
      warn('could not record the end of a child: %s', describe(cause))
    }
  })

  // `ctx.get` is read on every call: the store is optional, and may come, go and come back.
  const settings = createSettingsReader(() => ctx.get('dishConfig'), logger)

  // With the store there: claim crew.yaml, as an effect so it goes when the store, or this plugin, does, and seed it.
  // A claim that is refused (someone else owns the path) or a seed that fails leaves the store as it is.
  ctx.inject(['dishConfig'], async (child) => {
    const store = child.dishConfig
    let present = true
    child.effect(() => () => { present = false })
    try {
      child.effect(() => child.dishConfig.claim(CREW_SPEC))
    } catch (error) {
      warn('could not claim crew.yaml: %s', describe(error))
      return
    }
    try {
      // An unedited earlier default moves to the current one (2026-10-03: `read_image` for coder, reviewer and writer).
      await store.seed({ 'crew.yaml': DEFAULT_TEXT }, name, { replace: { 'crew.yaml': [...PREVIOUS_HASHES] } })
    } catch (error) {
      // Unless the store is going away, which closed it under the seed.
      if (present) warn('could not seed crew.yaml: %s', describe(error))
    }
  })

  // Before the service is there, so that nothing asks the record while it is pruned. A failure is logged, and the crew
  // works all the same: old records that stay are only disk.
  try {
    const removed = await records.prune(KEEP_RECORDS_MS)
    if (removed > 0) logger.info('removed the records of %d crew session(s) not written to for 180 days', removed)
  } catch (error) {
    warn('could not prune the crew\'s old records in %s: %s', directory, describe(error))
  }

  /**
   * `DishCrew.worktreeBindings`. A caller may reach the worktree through a link (`/home` to `/var/home`, a linked
   * `DSH_DISH_HOME`), and the record holds canonical paths. The registry is a sibling's service, read on each call.
   */
  const worktreeBindings = async (worktree: string): Promise<WorktreeBinding[]> => {
    const found = await records.boundTo(await realpath(worktree).catch(() => worktree))
    const agents = lookup.get('agents') as LiveAgents | undefined
    return found.map(({ sessionId, record }) => ({ child: record.id, sessionId, role: record.role, title: record.title, running: isRunning(record, agents) }))
  }

  try {
    ctx.provide('dishCrew', {
      settings, records, whenRecorded: (childId: string) => pending.get(childId), subagentProvider: text(config.subagentProvider) ?? 'spawn', worktreeBindings,
    })
  } catch (error) {
    // Unloaded while it was pruning: the plugin is going away, and didn't fail.
    if (unloaded(error)) return
    throw error
  }
}
