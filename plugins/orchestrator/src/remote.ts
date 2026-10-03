/**
 * The server half of Settings → Runs: a Typert remote service the browser calls through `ctx.remote.dishRuns`, over the run
 * store and the ledgers.
 *
 * It is built like dish-judge's `JudgeRemote` (judge `remote.ts`), and for the same reasons:
 *
 * - the gateway serves any root service that carries a `typertRemote` binding and `@Remote` markers, reading wire
 *   parameter names from the method source (so every parameter is a plain identifier). This package runs as type-stripped
 *   `.ts`, which has no decorator syntax, so the markers are applied by `markRemote`;
 * - every parameter is plain JSON, and `''` and `0` mean absent: no cursor, the ledger's default page;
 * - a refusal the person can act on comes back as `{ ok: false, code, message }`, not as a throw: Typert has a closed set of
 *   failure codes, and its gateway folds anything thrown into `gateway/internal`. `INVALID` is a project, an id or a page
 *   that isn't one; `NOT_FOUND` a run the store doesn't have. Anything else is a bug, or a disk that can't be read, and is
 *   thrown.
 *
 * **Read only.** There are three methods and none writes: no record, no ledger line, no directory. Every method first awaits
 * the store's `load` (the same promise every time, once it has read), and then reads its copy and the ledger files.
 *
 * **Masked once more.** Records and ledger lines were masked where they were written. Everything that leaves here passes the
 * mask again, keys and all: for a line that something else wrote into a ledger file, or one from before a pattern was added.
 *
 * Everything the page shows from the ledger was written by agents, or by GitHub: a goal, a summary, a finding, a ruling, a
 * URL. This remote hands it over as it is, as strings; it is the page's part to show it as text and as nothing else.
 *
 * @module dish-orchestrator/remote
 */

import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { markRemote, maskSecrets } from 'dish-kit'
import { summarize } from './derive.ts'
import type * as derive from './derive.ts'
import { BASE_FIELDS } from './entries.ts'
import type { LedgerEntry } from './entries.ts'
import type { Ledger } from './ledger.ts'
import { RUN_ID, splitProject } from './paths.ts'
import { NAMESPACE } from './protocol.ts'
import type {
  ErrorCode, GateView, JsonValue, LedgerLine, LedgerPage, Outcome, RulingView, RunDetail, RunRow, RunSummary, TaskView, VerdictView,
} from './protocol.ts'
import type { Run, RunStore } from './store.ts'

/** The Cordis service key. (The wire namespace is `NAMESPACE`.) */
export const SERVICE = 'dishRunsRemote'

declare module '@deepseek-ai/cordis' {
  interface Context {
    dishRunsRemote: RunsRemote
  }
}

// What the page is told must be what the server derives: these fail to compile if either side drifts.
type Same<A, B> = [A] extends [B] ? [B] extends [A] ? SameKeys<A, B> : false : false
/** Mutual assignability lets a field that is optional on one side only through: the keys of two objects must be the same too. */
type SameKeys<A, B> = [A] extends [object] ? [B] extends [object] ? ([keyof A] extends [keyof B] ? [keyof B] extends [keyof A] ? true : false : false) : true : true
type Check<T extends true> = T
export type WireMatchesServer = [
  Check<Same<RunSummary, derive.RunSummary>>,
  Check<Same<TaskView, derive.TaskView>>,
  Check<Same<GateView, derive.GateView>>,
  Check<Same<VerdictView, derive.VerdictView>>,
  Check<Same<RulingView, derive.RulingView>>,
  Check<Same<NonNullable<RunSummary['pr']>, NonNullable<derive.RunSummary['pr']>>>,
  Check<Same<NonNullable<TaskView['coder']>, NonNullable<derive.TaskView['coder']>>>,
]

/** What the remote reads: the records, the ledgers, and whether a run's driver is live. */
export interface RemoteOptions {
  store: RunStore
  ledger: Ledger
  live(run: Run): boolean
}

/** A refusal made here, with the code the page sees. */
class Refusal extends Error {
  code: ErrorCode

  constructor(code: ErrorCode, message: string) {
    super(message)
    this.name = 'Refusal'
    this.code = code
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** `value` as the wire will carry it: JSON, with no key (or array item) left `undefined`. */
function wire<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** `value` with every string in it, and every key, passed through the secret mask: for what came from outside the code. */
function masked<T>(value: T): T {
  if (typeof value === 'string') return maskSecrets(value) as T
  if (Array.isArray(value)) return value.map(masked) as T
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [maskSecrets(key), masked(inner)])) as T
  }
  return value
}

/**
 * A string parameter. They arrive off the wire untyped: a missing one is `undefined` (the client leaves out an `undefined`
 * positional), which is as good as `''`, the page's own way to say "absent". Anything else that is not a string gets
 * `INVALID`, not a `TypeError`.
 */
function stringOf(name: string, value: unknown): string {
  if (value === undefined) return ''
  if (typeof value !== 'string') throw new Refusal('INVALID', `${name} must be a string`)
  return value
}

/** A count parameter: a missing one is `0`, which the ledger reads as its default. */
function countOf(name: string, value: unknown): number {
  if (value === undefined) return 0
  if (typeof value !== 'number') throw new Refusal('INVALID', `${name} must be a number`)
  return value
}

/** Run `task` and put what it returns, or a refusal, in an `Outcome`; any other failure is thrown. */
async function outcome<T>(task: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: wire(await task()) }
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, code: error.code, message: maskSecrets(error.message) }
    throw error
  }
}

/** Open runs first; the rest in no order of their own. */
function stateRank(run: Run): number {
  return run.state === 'open' ? 0 : 1
}

/** By project without case (then with it, so one project's runs stay together), open first, newest opened first, then by id. */
function listOrder(a: Run, b: Run): number {
  const pa = a.project.toLowerCase()
  const pb = b.project.toLowerCase()
  if (pa !== pb) return pa < pb ? -1 : 1
  if (a.project !== b.project) return a.project < b.project ? -1 : 1
  return stateRank(a) - stateRank(b) || b.openedAt - a.openedAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
}

export class RunsRemote extends TypertRemoteService {
  static inject = ['dishRuns']

  private readonly options: RemoteOptions

  constructor(ctx: Context, options: RemoteOptions) {
    super(ctx, SERVICE, { namespace: NAMESPACE })
    this.options = options
  }

  /** `run` as a row: `driver` is `null` when it is released, and says whether its agent is live otherwise. */
  private row(run: Run): RunRow {
    const row: RunRow = {
      project: run.project, id: run.id, slug: run.slug, goal: run.goal, state: run.state,
      driver: run.driver.session === '' ? null : { session: run.driver.session, since: run.driver.since, live: this.live(run) },
      openedAt: run.openedAt,
    }
    if (run.closedAt !== undefined) row.closedAt = run.closedAt
    if (run.pr !== undefined) row.pr = { url: run.pr.url, number: run.pr.number }
    if (run.reason !== undefined) row.reason = run.reason
    return row
  }

  /** `options.live`, false when it throws: a registry that can't be asked is no live agent. */
  private live(run: Run): boolean {
    try {
      return this.options.live(run) === true
    } catch {
      return false
    }
  }

  /** The run the parameters name. Call it once the store has loaded. @throws Refusal: INVALID, NOT_FOUND. */
  private find(project: unknown, id: unknown): Run {
    const name = stringOf('project', project)
    const which = stringOf('id', id)
    try {
      splitProject(name)
    } catch (error) {
      throw new Refusal('INVALID', describe(error))
    }
    if (!RUN_ID.test(which)) throw new Refusal('INVALID', `${JSON.stringify(which)} isn't a run id: <yyyymmdd>-<slug>`)
    const run = this.options.store.get(name, which)
    if (run === undefined) throw new Refusal('NOT_FOUND', `no run ${name}/${which}`)
    return run
  }

  /** Every run, by project, open ones first, then newest opened first. Not an Outcome: it refuses nothing. */
  async runs(): Promise<RunRow[]> {
    await this.options.store.load()
    const rows = this.options.store.list().sort(listOrder).map(run => this.row(run))
    return masked(wire(rows))
  }

  /**
   * One run: its row, the rest of its record, and what its ledger says (`summarize`).
   * @param project - `owner/repo`, compared without case.
   * @param id - the run's id, `<yyyymmdd>-<slug>`.
   */
  async run(project: string, id: string): Promise<Outcome<RunDetail>> {
    return outcome(async () => {
      await this.options.store.load()
      const run = this.find(project, id)
      // The record's own project: the store matched without case, and the ledger's path has it as it is.
      const { entries } = await this.options.ledger.entries(run.project, run.id)
      const detail: RunDetail = {
        ...this.row(run),
        branch: run.branch, worktree: run.worktree, base: run.base, baseCommit: run.baseCommit,
        summary: summarize(run, entries),
      }
      if (run.plan !== undefined) detail.plan = { path: run.plan.path, commit: run.plan.commit }
      return masked(wire(detail))
    })
  }

  /**
   * A page of the run's ledger, newest first.
   * @param project - `owner/repo`, compared without case.
   * @param id - the run's id.
   * @param limit - at most this many (1 to 500); `0` is the default (200).
   * @param before - `''` is the newest; else the `next` of the page before.
   */
  async ledger(project: string, id: string, limit: number, before: string): Promise<Outcome<LedgerPage>> {
    return outcome(async () => {
      await this.options.store.load()
      const most = countOf('limit', limit)
      const after = stringOf('before', before)
      const run = this.find(project, id)
      const query: { limit?: number, before?: string } = {}
      if (most !== 0) query.limit = most
      if (after !== '') query.before = after
      let read
      try {
        read = await this.options.ledger.read(run.project, run.id, query)
      } catch (error) {
        // The ledger's words for a page that isn't one: a limit out of range, a cursor it didn't give.
        if (error instanceof RangeError) throw new Refusal('INVALID', error.message)
        throw error
      }
      const page: LedgerPage = { lines: read.entries.map(lineOf), skipped: read.skipped }
      if (read.next !== undefined) page.next = read.next
      return masked(wire(page))
    })
  }
}

markRemote(RunsRemote, 'runs')
markRemote(RunsRemote, 'run')
markRemote(RunsRemote, 'ledger')

/** An entry as the page reads it: the base fields, and everything else in `fields`. */
function lineOf(entry: LedgerEntry): LedgerLine {
  const source = entry as unknown as Record<string, unknown>
  const line: LedgerLine = { at: entry.at, run: entry.run, kind: entry.kind, by: entry.by, fields: {} }
  if (typeof source.session === 'string') line.session = source.session
  if (typeof source.child === 'string') line.child = source.child
  if (typeof source.task === 'string') line.task = source.task
  if (typeof source.cut === 'boolean') line.cut = source.cut
  for (const [key, value] of Object.entries(source)) {
    if (!BASE_FIELDS.includes(key)) line.fields[key] = value as JsonValue
  }
  return line
}

/** Mount the remote on `ctx`. It goes when `ctx` does, or `dishRuns` does. */
export function runsRemote(ctx: Context, options: RemoteOptions): void {
  ctx.plugin(RunsRemote, options)
}
