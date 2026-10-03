/**
 * The core of dish-orchestrator: runs, who drives them, where a child belongs, and every entry the harness writes. The
 * `dishRuns` service (`service.ts`) is five of its methods; the listeners (`listeners.ts`) and the tools build on the rest.
 *
 * - **Records decide who drives.** A run's record (`store.ts`) holds its state and its driver; the ledger (`ledger.ts`)
 *   holds what happened. A change to who drives is written to the record first, then to the ledger, so a ledger that
 *   couldn't be written never leaves two chats driving one run. A ledger write that fails after its record is logged.
 * - **Who writes what.** Only `harness` makes `by: 'harness'` entries, and only `main` `by: 'main'` ones; neither takes `by`
 *   (or `at`, or `run`) from what it is given, and each takes only its own kinds.
 * - **Locks.** A session's lock (`withSession`) is always taken before a run's (`withRun`), never the other way round.
 *   `openAround`, `setGoal`, `attachPlan` and `close` take none: they are called holding the locks their callers name.
 *   `drive` takes the run's, and is called holding the session's. `worktreeCreated` takes the session's. `place`,
 *   `worktreeRemoved`, `ladder` and `driving` take none, and none of these calls a locking method of another plugin.
 * - **Never stuck, never thrown.** The five service methods wait for the store, catch, log once per distinct message
 *   (masked; at most 100 kept), and give `undefined`. Each has a time limit: crew awaits `place` and `ladder` inside its
 *   own locks, the `worktree` tool awaits `worktreeCreated`, and dish-workspaces' `close` awaits the sweep's
 *   `worktreeRemoved`, all with none of their own. A call past its limit is logged and given up on by its caller; what it
 *   was doing finishes in the background. `worktreeCreated`'s limit is on the wait for the session's lock: once it holds
 *   it, its caller waits for it (local writes only). A worktree whose hook gave up waiting joins late only the run its chat
 *   drives in that project by then, and only if it still resolves: a late hook never opens, switches or releases a run.
 *   Each read of another plugin's service inside them (`resolve`, `headOf`, crew's `lookup`) has a shorter limit of its own.
 *
 * @module dish-orchestrator/runs
 */

import { realpath } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { isTopLevelAgent, maskSecrets } from 'dish-kit'
import type { AgentLike } from 'dish-kit'
import { nextRound, openTasks, summarize } from './derive.ts'
import type { RunSummary } from './derive.ts'
import { HARNESS_KINDS, MAIN_KINDS } from './entries.ts'
import type { HarnessEntry, LedgerEntry, MainEntry } from './entries.ts'
import type { Ledger } from './ledger.ts'
import { KeyedLock } from './locks.ts'
import { parseRef, runRef, SEGMENT, SLUG, splitProject } from './paths.ts'
import type { CreatedForRun, JoinedRun, LadderEntry, Placement, PlaceTarget, RunInfo } from './service.ts'
import type { Services } from './services.ts'
import type { Run, RunStore } from './store.ts'
import { cut, given, oneLine, rulingBody, shortSession } from './text.ts'

export interface Logger {
  info(format: string, ...args: unknown[]): void
  warn(format: string, ...args: unknown[]): void
}

/** How long the core waits, in ms. Each has a default; a test sets them shorter. */
export interface Limits {
  /** One read of another plugin's service: `resolve`, `headOf`, crew's `lookup`. Default 10 s. */
  lookupMs?: number
  /** `place`, all of it. Default 30 s. */
  placeMs?: number
  /** `driving`, `worktreeCreated`, `worktreeRemoved` and `ladder`, each all of it. Default 30 s. */
  hookMs?: number
}

export interface RunsDeps {
  store: RunStore
  ledger: Ledger
  services: Services
  now: () => number
  logger: Logger
  limits?: Limits
}

/** What a tool is made from. */
export interface ToolDeps {
  runs: Runs
  services: Services
}

type Input<E> = E extends unknown ? Omit<E, 'at' | 'run' | 'by'> : never
/** A harness entry as `harness` takes it: the kind and its fields; `at`, `run` and `by` are the core's. */
export type HarnessInput = Input<HarnessEntry>
/** A main-agent entry as `main` takes it; `session` is the caller's. */
export type MainInput = Input<MainEntry>

/** Where a child is, as the core remembers it (the child index) or crew's record says. */
export interface ChildTags {
  /** The run's ref. */
  ref: string
  task?: string
  sessionId?: string
}

const LOOKUP_MS = 10_000
const PLACE_MS = 30_000
const HOOK_MS = 30_000
/** How many distinct failures are remembered as logged. */
const TOLD_MAX = 100
/** How many children the index keeps: the oldest go first. */
const CHILDREN_MAX = 1000
/** The most characters a ladder's ruling keeps in the ledger. */
const RULING_MAX = 1000

const TIMED_OUT: unique symbol = Symbol('timed out')

/** `promise`, or TIMED_OUT once `ms` have passed. The timer goes when either settles. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const limit = new Promise<typeof TIMED_OUT>((settle) => {
    timer = setTimeout(() => { settle(TIMED_OUT) }, ms)
    // A call that stalls never holds the process open at exit.
    timer.unref?.()
  })
  return Promise.race([promise, limit]).finally(() => { clearTimeout(timer) })
}

function seconds(ms: number): string {
  return `${Math.round(ms / 100) / 10} s`
}

/** An error as one masked line. */
export function describe(error: unknown): string {
  let text: string
  try {
    text = error instanceof Error ? error.message : String(error)
  } catch {
    text = 'an error that can\'t be printed'
  }
  return cut(oneLine(maskSecrets(text)), 1000)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}

function sameProject(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

/** A run as `driving` gives it. */
function infoOf(run: Run): RunInfo {
  return {
    ref: runRef(run.project, run.id), id: run.id, project: run.project, slug: run.slug, goal: run.goal, branch: run.branch,
    worktree: run.worktree, state: run.state,
  }
}

/** What is wrong with what the `worktree` tool gave `worktreeCreated`, or undefined. */
function createdProblem(sessionId: unknown, created: unknown): string | undefined {
  if (!isText(sessionId)) return 'it came with no session'
  if (!isObject(created)) return 'it isn\'t a worktree'
  try {
    splitProject(created.project as string)
  } catch {
    return `${JSON.stringify(String(created.project))} isn't a project name`
  }
  if (typeof created.slug !== 'string' || !SLUG.test(created.slug)) return `${JSON.stringify(String(created.slug))} isn't a slug`
  if (created.branch !== `dish/${created.slug}`) return `its branch ${JSON.stringify(String(created.branch))} isn't dish/${created.slug}`
  if (typeof created.path !== 'string' || !isAbsolute(created.path)) return `its path ${JSON.stringify(String(created.path))} isn't absolute`
  if (!isText(created.base)) return 'it has no base commit'
  if (!isText(created.baseRef)) return 'it has no base ref'
  return undefined
}

/** `<owner>/<repo>/<slug>`, split; undefined for anything else. */
function worktreeRef(value: string): { project: string, slug: string } | undefined {
  const parts = value.split('/')
  if (parts.length !== 3) return undefined
  const [owner, repo, slug] = parts as [string, string, string]
  if (!SEGMENT.test(owner) || !SEGMENT.test(repo) || !SLUG.test(slug)) return undefined
  return { project: `${owner}/${repo}`, slug }
}

/** A run that `place` found, with its task and the entries it read (after the queue). */
interface Found {
  run: Run
  task?: string
  entries?: LedgerEntry[]
}

/**
 * The caller of a main-agent tool: `String(exec.agent.id)` when `isTopLevelAgent(exec.agent)` and it is non-empty, else
 * undefined. The same id crew's `delegate` takes as its session (`delegate.ts:819`), the worktree tool passes to
 * worktreeCreated, and dsh's agent registry is keyed by. `run`, `open_pr` and `pr_feedback` use it.
 */
export function mainSession(exec: { agent?: unknown }): string | undefined {
  const agent = (exec as { agent?: unknown } | undefined)?.agent
  if (!isObject(agent) || !isTopLevelAgent(agent as AgentLike)) return undefined
  const id = agent.id
  if (typeof id !== 'string' && typeof id !== 'number') return undefined
  const session = String(id)
  return session === '' ? undefined : session
}

export class Runs {
  readonly store: RunStore
  readonly ledger: Ledger
  readonly services: Services
  readonly #now: () => number
  readonly #logger: Logger
  readonly #lookupMs: number
  readonly #placeMs: number
  readonly #hookMs: number
  readonly #sessions = new KeyedLock()
  readonly #runLocks = new KeyedLock()
  #ready: Promise<void> | undefined
  #loaded = false
  /** The failures logged, oldest first. */
  readonly #told = new Set<string>()
  /** The child index: where each child heard of in this process was placed, oldest first. */
  readonly #children = new Map<string, ChildTags>()

  constructor(deps: RunsDeps) {
    this.store = deps.store
    this.ledger = deps.ledger
    this.services = deps.services
    this.#now = deps.now
    this.#logger = deps.logger
    this.#lookupMs = deps.limits?.lookupMs ?? LOOKUP_MS
    this.#placeMs = deps.limits?.placeMs ?? PLACE_MS
    this.#hookMs = deps.limits?.hookMs ?? HOOK_MS
  }

  // --- the store, the log and the clock -----------------------------------------------------------------------------

  /**
   * The store, read. The first call starts `store.load()`, and every call gives that promise. A failure is logged once and
   * forgotten, so the next call tries again.
   */
  ready(): Promise<void> {
    if (this.#ready === undefined) {
      const loading = this.store.load()
      this.#ready = loading
      // Registered first, so `loaded` is true before anyone who awaits `ready` goes on.
      loading.then(() => { this.#loaded = true }, (error: unknown) => {
        if (this.#ready === loading) this.#ready = undefined
        this.logOnce(`could not read the run records: ${describe(error)}`)
      })
    }
    return this.#ready
  }

  /** Whether `ready` has resolved: the store can be read now, synchronously. */
  get loaded(): boolean {
    return this.#loaded
  }

  /** The core's clock. */
  now(): number {
    return this.#now()
  }

  /** Log `message` (masked) as a warning, once: a message logged already isn't again, until 100 others have been. */
  logOnce(message: string): void {
    const text = maskSecrets(message)
    if (this.#told.has(text)) return
    this.#told.add(text)
    if (this.#told.size > TOLD_MAX) this.#told.delete(this.#told.values().next().value!)
    try {
      this.#logger.warn('%s', text)
    } catch {
      // A logger that throws is not worth a failed delegation.
    }
  }

  #info(message: string): void {
    try {
      this.#logger.info('%s', maskSecrets(message))
    } catch {
      // As above.
    }
  }

  /**
   * `job`, waited for at most `ms`: its value, or `fallback` when it throws (logged as `could not <what>: <why>`) or takes
   * longer (logged as `late`, or `could not <what>: it took longer than <ms>`; the job goes on in the background).
   */
  async #guarded<T>(what: string, job: () => Promise<T>, ms: number, fallback: T, late?: string): Promise<T> {
    const failed = (error: unknown): T => {
      this.logOnce(`could not ${what}: ${describe(error)}`)
      return fallback
    }
    let running: Promise<T>
    try {
      running = job()
    } catch (error) {
      return failed(error)
    }
    // Logged whenever it fails, in time or after its caller stopped waiting.
    const settled = running.then(value => ({ value }), (error: unknown) => ({ value: failed(error) }))
    const result = await within(settled, ms)
    if (result !== TIMED_OUT) return result.value
    this.logOnce(late ?? `could not ${what}: it took longer than ${seconds(ms)}`)
    return fallback
  }

  // --- reading runs -----------------------------------------------------------------------------------------------

  /** `<owner>/<repo>/<id>`. */
  refOf(run: Run): string {
    return runRef(run.project, run.id)
  }

  /** The run a ref names, or undefined. After ready. */
  byRef(ref: string): Run | undefined {
    const parsed = parseRef(ref)
    return parsed === undefined ? undefined : this.store.get(parsed.project, parsed.id)
  }

  /**
   * A run named by a tool's `id`: `owner/repo/<id>` (parseRef, then store.get), or a bare id (store.byId). @throws Error with
   * the words `run resume` and `pr_feedback` both use: "no run `<id>`: `run` `list` shows the runs", or "`<id>` names runs in
   * several projects (<a>, <b>): give `owner/repo/<id>`". After ready.
   */
  find(id: string): Run {
    const shown = cut(oneLine(maskSecrets(String(id))), 200)
    const unknown = new Error(`no run \`${shown}\`: \`run\` \`list\` shows the runs`)
    const parsed = parseRef(id)
    if (parsed !== undefined) {
      const run = this.store.get(parsed.project, parsed.id)
      if (run === undefined) throw unknown
      return run
    }
    const found = typeof id === 'string' ? this.store.byId(id) : []
    if (found.length === 0) throw unknown
    if (found.length === 1) return found[0]!
    const projects = found.map(run => run.project).sort((a, b) => a.localeCompare(b))
    throw new Error(`\`${shown}\` names runs in several projects (${projects.join(', ')}): give \`owner/repo/${shown}\``)
  }

  /** Its driver is not '' and dsh's agent registry has an agent with that id. No registry: false. */
  live(run: Run): boolean {
    const session = run?.driver?.session
    if (!isText(session)) return false
    try {
      const agents = this.services.agents()
      return agents !== undefined && agents.get(session) !== undefined
    } catch {
      return false
    }
  }

  /** The run's ledger, oldest first, once what is queued for it now is written. */
  async entries(run: Run): Promise<LedgerEntry[]> {
    return (await this.ledger.entries(run.project, run.id)).entries
  }

  async summary(run: Run): Promise<RunSummary> {
    return summarize(run, await this.entries(run))
  }

  // --- the dishRuns five ------------------------------------------------------------------------------------------

  /** The open run `sessionId` drives, or undefined. Never rejects. */
  driving(sessionId: string): Promise<RunInfo | undefined> {
    return this.#guarded('tell which run a chat drives', async () => {
      await this.ready()
      const run = this.store.drivenBy(sessionId)
      return run === undefined ? undefined : infoOf(run)
    }, this.#hookMs, undefined)
  }

  /**
   * Where a child `delegate` is starting or following up belongs: a bound child in the run that owns its worktree, a
   * reviewer where the child it reviews is, anything else in the run the session drives; undefined for no open run. Takes
   * no lock. Never rejects (a failure is logged, and gives undefined).
   */
  place(sessionId: string, target: PlaceTarget): Promise<Placement | undefined> {
    return this.#guarded(`place a delegation of session ${String(sessionId)} in a run`, () => this.#place(sessionId, target), this.#placeMs, undefined,
      `could not place a delegation of session ${String(sessionId)} in a run: it took longer than ${seconds(this.#placeMs)}, so it isn't placed: `
      + 'a start goes on outside any run, and a follow-up keeps its child\'s run and task but isn\'t counted by the escalation ladder')
  }

  async #place(sessionId: string, target: PlaceTarget): Promise<Placement | undefined> {
    await this.ready()
    const asked: Record<string, unknown> = isObject(target) ? target : {}
    const worktree = typeof asked.worktree === 'string' ? given(asked.worktree) : undefined
    const reviews = typeof asked.reviews === 'string' ? given(asked.reviews) : undefined
    let found: Found | undefined
    if (worktree !== undefined) found = await this.#owner(worktree)
    if (found === undefined && reviews !== undefined && reviews !== 'main') found = await this.#reviewed(reviews)
    if (found === undefined) {
      const run = isText(sessionId) ? this.store.drivenBy(sessionId) : undefined
      if (run === undefined) return undefined
      found = { run }
    }
    const placement: Placement = { run: this.refOf(found.run) }
    if (found.task !== undefined) {
      placement.task = found.task
      placement.round = nextRound(found.entries ?? await this.entries(found.run), found.task)
    }
    if (asked.final === true && reviews !== undefined) placement.final = true
    return placement
  }

  /** The open run whose open tasks hold `worktree` (a path, or `<owner>/<repo>/<slug>`), newest first; with its task. */
  async #owner(worktree: string): Promise<Found | undefined> {
    const resolved = await this.#resolve(worktree)
    const absolute = isAbsolute(worktree)
    const paths = new Set<string>([worktree])
    if (absolute) paths.add(await realpath(worktree).catch(() => worktree))
    if (resolved !== undefined) paths.add(resolved.path)
    const asRef = absolute ? undefined : worktreeRef(worktree)
    const project = resolved?.project
    const candidates = this.store.list().filter(run => run.state === 'open' && (project === undefined || sameProject(run.project, project)))
    for (const run of candidates) {
      const entries = await this.entries(run)
      for (const [slug, path] of openTasks(run, entries)) {
        if (paths.has(path) || (asRef !== undefined && slug === asRef.slug && sameProject(run.project, asRef.project))) return { run, task: slug, entries }
      }
    }
    return undefined
  }

  /** dish-workspaces' `resolve`, or undefined: without it, on a rejection, and past the lookup's time limit. */
  async #resolve(worktree: string): Promise<{ project: string, path: string } | undefined> {
    try {
      const workspaces = this.services.workspaces()
      if (workspaces === undefined) return undefined
      const resolved = await within(workspaces.resolve(worktree), this.#lookupMs)
      if (resolved === TIMED_OUT) {
        this.logOnce(`dish-workspaces took longer than ${seconds(this.#lookupMs)} to resolve a worktree; every open run was searched instead`)
        return undefined
      }
      return isObject(resolved) && isText(resolved.project) && isText(resolved.path) ? { project: resolved.project, path: resolved.path } : undefined
    } catch {
      return undefined
    }
  }

  /** Where the child `childId` (that a reviewer reviews) is: its run, if open, and its task, if still open. */
  async #reviewed(childId: string): Promise<Found | undefined> {
    const tags = this.#children.get(childId) ?? await this.lookupChild(childId)
    if (tags === undefined) return undefined
    const run = this.byRef(tags.ref)
    if (run === undefined || run.state !== 'open') return undefined
    if (tags.task === undefined) return { run }
    const entries = await this.entries(run)
    return openTasks(run, entries).has(tags.task) ? { run, task: tags.task, entries } : { run }
  }

  /**
   * The `worktree` tool made a worktree: it joins the run the session drives in that project (`task.opened`), or a run is
   * opened around it (`how: 'auto'`). Under the session's lock. Never rejects.
   *
   * The time limit is on the wait for the lock (another call of the same chat can hold it while it waits for a run's lock,
   * which `open_pr` holds through a gate and a push). Past it, the tool is answered `undefined`, and when the lock comes the
   * hook only joins late (`#joinLate`): never opening, switching or releasing a run the chat was told nothing about. Once
   * the hook holds the lock, its caller waits for it: what it does then is the store's and the ledger's writes.
   */
  async worktreeCreated(sessionId: string, created: CreatedForRun): Promise<JoinedRun | undefined> {
    const shown = isObject(created) ? `${String(created.project)}/${String(created.slug)}` : 'a worktree'
    /** Decided once, on the lock: whether the caller still waits (`joining`) or has stopped (`late`). */
    const turn: { state: 'waiting' | 'joining' | 'late' } = { state: 'waiting' }
    const job = (async (): Promise<JoinedRun | undefined> => {
      const problem = createdProblem(sessionId, created)
      if (problem !== undefined) {
        this.logOnce(`ignored worktree ${shown}, which can't join a run: ${problem}`)
        return undefined
      }
      await this.ready()
      return this.withSession(sessionId, () => {
        if (turn.state === 'late') return this.#joinLate(sessionId, created, shown)
        turn.state = 'joining'
        return this.#join(sessionId, created)
      })
    })()
    const settled = job.then(value => ({ value }), (error: unknown) => {
      this.logOnce(`could not add worktree ${shown} to a run: ${describe(error)}`)
      return { value: undefined }
    })
    const result = await within(settled, this.#hookMs)
    if (result !== TIMED_OUT) return result.value
    if (turn.state === 'joining') return (await settled).value
    turn.state = 'late'
    return undefined
  }

  /**
   * A worktree whose hook gave up waiting for its chat's lock, which the worktree tool answered without a run: it joins only
   * the run the chat drives in its project by then, and only while it still resolves. Never opens, switches or releases a
   * run. One line says what became of it.
   */
  async #joinLate(sessionId: string, created: CreatedForRun, shown: string): Promise<undefined> {
    const lead = `worktree ${shown} waited ${seconds(this.#hookMs)} for its chat's lock, so the worktree tool answered without a run;`
    const run = this.store.drivenBy(sessionId)
    if (run === undefined || !sameProject(run.project, created.project)) {
      const driven = run === undefined ? 'no run' : `run ${run.id} in ${run.project}`
      this.logOnce(`${lead} it wasn't added to one: by then this chat drove ${driven}, and a late worktree never opens or switches a run`)
      return undefined
    }
    const workspaces = this.services.workspaces()
    const resolved = workspaces === undefined ? undefined : await this.#resolve(created.path)
    if (resolved === undefined) {
      const why = workspaces === undefined ? 'dish-workspaces isn\'t running, so it can\'t be checked' : 'it no longer resolves to a worktree dish made (removed while it waited)'
      this.logOnce(`${lead} it wasn't added to run ${run.id}: ${why}`)
      return undefined
    }
    await this.harness(run, {
      kind: 'task.opened', session: sessionId, task: created.slug, path: created.path, branch: created.branch, base: created.baseRef,
      baseCommit: created.base,
    })
    this.#info(`${lead} it then joined run ${run.id} as task ${created.slug}`)
    return undefined
  }

  async #join(sessionId: string, created: CreatedForRun): Promise<JoinedRun> {
    const run = this.store.drivenBy(sessionId)
    if (run !== undefined && sameProject(run.project, created.project)) {
      await this.harness(run, {
        kind: 'task.opened', session: sessionId, task: created.slug, path: created.path, branch: created.branch, base: created.baseRef,
        baseCommit: created.base,
      })
      return { id: run.id, opened: false }
    }
    const { run: opened, released } = await this.openAround(sessionId, created, { goal: created.slug, how: 'auto' })
    if (released !== undefined) this.#info(`released run ${released.id} of ${released.project}: this chat opened run ${opened.id} in ${opened.project}`)
    return { id: opened.id, opened: true }
  }

  /**
   * dish-workspaces removed a worktree (the tool, or the sweep): `task.removed` in each open or `pr` run of the project
   * (compared without case) that has it as an open task. Through the ledger's queue only: no session or run lock. Never
   * rejects.
   */
  worktreeRemoved(project: string, slug: string): Promise<void> {
    return this.#guarded(`note that worktree ${String(project)}/${String(slug)} was removed`, async () => {
      if (typeof project !== 'string' || !isText(slug)) return
      await this.ready()
      const runs = this.store.list(project).filter(run => run.state === 'open' || run.state === 'pr')
      const results = await Promise.allSettled(runs.map(run => this.ledger.appendWith(run.project, run.id, async (current) => {
        return openTasks(run, await current()).has(slug) ? [this.#build(run, { kind: 'task.removed', task: slug }, 'harness')] : []
      })))
      for (const [index, result] of results.entries()) {
        if (result.status === 'rejected') this.logOnce(`could not record that worktree ${project}/${slug} was removed in run ${runs[index]!.id}: ${describe(result.reason)}`)
      }
    }, this.#hookMs, undefined)
  }

  /** `delegate` refused round 5+ on a task, or let it through on a ruling. Never rejects. */
  ladder(entry: LadderEntry): Promise<void> {
    return this.#guarded('record the escalation ladder', async () => {
      await this.ready()
      if (!isObject(entry)) {
        this.logOnce('ignored an escalation ladder entry that isn\'t one')
        return
      }
      const ref = String(entry.run)
      const run = typeof entry.run === 'string' ? this.byRef(entry.run) : undefined
      if (run === undefined) {
        this.logOnce(`ignored the escalation ladder's ${String(entry.outcome)} for run ${ref}: there is no such run`)
        return
      }
      if (typeof entry.task !== 'string' || !SLUG.test(entry.task)) {
        this.logOnce(`ignored the escalation ladder's ${String(entry.outcome)} in run ${run.id}: its task ${JSON.stringify(String(entry.task))} isn't a slug`)
        return
      }
      if (typeof entry.round !== 'number' || !Number.isSafeInteger(entry.round) || entry.round < 0) {
        this.logOnce(`ignored the escalation ladder's ${String(entry.outcome)} in run ${run.id}: its round ${String(entry.round)} isn't a whole number from 0`)
        return
      }
      const session = isText(entry.sessionId) ? { session: entry.sessionId } : {}
      const child = isText(entry.child) ? { child: entry.child } : {}
      if (entry.outcome === 'refused') {
        await this.harness(run, { kind: 'ladder.refused', ...session, ...child, task: entry.task, round: entry.round })
      } else if (entry.outcome === 'ruled') {
        const ruling = cut(rulingBody(maskSecrets(typeof entry.ruling === 'string' ? entry.ruling : '')), RULING_MAX)
        await this.harness(run, { kind: 'ladder.ruled', ...session, ...child, task: entry.task, round: entry.round, ruling })
      } else {
        this.logOnce(`ignored the escalation ladder's entry in run ${run.id}: its outcome ${JSON.stringify(String(entry.outcome))} is neither refused nor ruled`)
      }
    }, this.#hookMs, undefined)
  }

  // --- for the tools ---------------------------------------------------------------------------------------------------

  /** `job` under the session's lock. Taken before a run's, never after. */
  withSession<T>(sessionId: string, job: () => Promise<T>): Promise<T> {
    return this.#sessions.run(sessionId, job)
  }

  /** `job` under the run's lock (keyed by its ref). Always taken after the session's, never before. */
  withRun<T>(run: Run, job: () => Promise<T>): Promise<T> {
    return this.#runLocks.run(this.refOf(run).toLowerCase(), job)
  }

  /**
   * Holding the session's lock: write the record (driver = the session), `run.opened`, and release the session's other open
   * run. The record comes first: it decides who drives. A failure of the ledger's append is logged; the record stands.
   */
  async openAround(sessionId: string, worktree: CreatedForRun, options: { goal: string, plan?: { path: string, commit: string }, how: 'run' | 'auto' }): Promise<{ run: Run, released?: Run }> {
    const previous = this.store.drivenBy(sessionId)
    const now = this.#now()
    const run = await this.store.create({
      project: worktree.project, slug: worktree.slug, goal: options.goal, branch: worktree.branch, worktree: worktree.path, base: worktree.baseRef,
      baseCommit: worktree.base, ...options.plan === undefined ? {} : { plan: options.plan }, driver: sessionId, openedAt: now,
    })
    await this.#harnessLogged(run, {
      kind: 'run.opened', session: sessionId, goal: run.goal, branch: run.branch, worktree: run.worktree, base: run.base, baseCommit: run.baseCommit,
      ...run.plan === undefined ? {} : { plan: run.plan }, how: options.how,
    })
    const released = previous === undefined ? undefined : await this.#release(previous, sessionId, now)
    return { run, ...released === undefined ? {} : { released } }
  }

  /** Release `run` (its driver `''`) if it is still open and `sessionId`'s; gives it as written, or undefined when it wasn't. */
  async #release(run: Run, sessionId: string, now: number): Promise<Run | undefined> {
    return this.store.update(run.project, run.id, current =>
      current.state === 'open' && current.driver.session === sessionId ? { ...current, driver: { session: '', since: now } } : undefined)
  }

  /** The record changed by `change`, as written. @throws Error for a run the store doesn't have. */
  async #write(run: Run, change: (current: Run) => Run | undefined): Promise<Run> {
    const written = await this.store.update(run.project, run.id, change)
    if (written === undefined) {
      const current = this.store.get(run.project, run.id)
      if (current === undefined) throw new Error(`no run \`${run.id}\` in ${run.project}`)
      return current
    }
    return written
  }

  /**
   * Holding the session's lock (it takes the run's): the resume rules, and a `pr` run's reopening; @throws Error with the
   * refusal's words.
   */
  async drive(sessionId: string, run: Run, options: { takeover: boolean }): Promise<{ run: Run, how: 'already' | 'resumed' | 'takenOver' | 'reopened', previous?: string, released?: Run }> {
    return this.withRun(run, async () => {
      const fresh = this.store.get(run.project, run.id)
      if (fresh === undefined) throw new Error(`no run \`${run.id}\`: \`run\` \`list\` shows the runs`)
      const other = this.store.drivenBy(sessionId)
      const now = this.#now()
      const old = fresh.driver.session
      let written: Run
      let how: 'resumed' | 'takenOver' | 'reopened'
      if (fresh.state === 'abandoned') {
        throw new Error(`run \`${fresh.id}\` was abandoned (${fresh.reason ?? 'no reason was recorded'}). Open a new run with \`run\` \`open\`.`)
      }
      if (fresh.state === 'pr') {
        await this.#checkReopen(fresh)
        written = await this.#write(fresh, (current) => {
          const next: Run = { ...current, state: 'open', driver: { session: sessionId, since: now } }
          delete next.closedAt
          return next
        })
        how = 'reopened'
        await this.#harnessLogged(written, { kind: 'run.resumed', session: sessionId, driver: sessionId, ...old === '' ? {} : { previous: old }, reopened: true })
      } else if (old === sessionId) {
        return { run: fresh, how: 'already' }
      } else {
        const live = this.live(fresh)
        if (live && !options.takeover) {
          throw new Error(`run \`${fresh.id}\` is driven by another chat that is still open (session ${shortSession(old)}). Give \`takeover: true\` to drive it from here; that chat then drives nothing.`)
        }
        written = await this.#write(fresh, current => ({ ...current, driver: { session: sessionId, since: now } }))
        how = live ? 'takenOver' : 'resumed'
        await this.#harnessLogged(written, live
          ? { kind: 'run.takenOver', session: sessionId, driver: sessionId, previous: old }
          : { kind: 'run.resumed', session: sessionId, driver: sessionId, ...old === '' ? {} : { previous: old } })
      }
      const released = other === undefined || (other.id === fresh.id && sameProject(other.project, fresh.project)) ? undefined : await this.#release(other, sessionId, now)
      return { run: written, how, ...old === '' ? {} : { previous: old }, ...released === undefined ? {} : { released } }
    })
  }

  /** A `pr` run can be reopened while its worktree is one dish made. @throws Error with the refusal's words. */
  async #checkReopen(run: Run): Promise<void> {
    const workspaces = this.services.workspaces()
    if (workspaces === undefined) throw new Error(`dish-workspaces isn't running, so run \`${run.id}\`'s worktree can't be checked`)
    let resolved: unknown
    try {
      resolved = await within(workspaces.resolve(run.worktree), this.#lookupMs)
    } catch (error) {
      throw new Error(`run \`${run.id}\`'s worktree can't be checked: ${describe(error)}`, { cause: error })
    }
    if (resolved === TIMED_OUT) throw new Error(`run \`${run.id}\`'s worktree can't be checked: dish-workspaces took longer than ${seconds(this.#lookupMs)}`)
    if (resolved !== undefined && resolved !== null) return
    // A worktree dish made that fails its safety check resolves to nothing too: say why, as open_pr does.
    let problem: unknown
    try {
      problem = await within(workspaces.resolveProblem(run.worktree), this.#lookupMs)
    } catch {
      problem = undefined
    }
    if (isText(problem)) {
      throw new Error(`run \`${run.id}\` can't be reopened: its worktree ${run.worktree} can't be used: ${describe(problem).replace(/\.+$/, '')}. Fix that, or open a new run with \`run\` \`open\`.`)
    }
    throw new Error(`run \`${run.id}\` can't be reopened: its worktree is gone (the sweep removes it once its pull request ${run.pr?.url ?? ''} is merged). Open a new run with \`run\` \`open\`.`)
  }

  /** Holding the run's lock: the goal, then `run.goal`. Gives the record as written. */
  async setGoal(run: Run, sessionId: string, goal: string): Promise<Run> {
    const written = await this.#write(run, current => ({ ...current, goal }))
    await this.#harnessLogged(written, { kind: 'run.goal', session: sessionId, goal: written.goal })
    return written
  }

  /** Holding the run's lock: the plan, then `run.plan`. Gives the record as written. */
  async attachPlan(run: Run, sessionId: string, plan: { path: string, commit: string }): Promise<Run> {
    const written = await this.#write(run, current => ({ ...current, plan: { path: plan.path, commit: plan.commit } }))
    const stored = written.plan ?? plan
    await this.#harnessLogged(written, { kind: 'run.plan', session: sessionId, path: stored.path, commit: stored.commit })
    return written
  }

  /**
   * Holding the run's lock: `state`, `pr` (replacing any earlier one) or `reason`, `closedAt`, and the driver released
   * (`''`); then `run.closed`. Gives the record as written.
   */
  async close(run: Run, sessionId: string, end: { state: 'abandoned', reason: string } | { state: 'pr', pr: { url: string, number: number } }): Promise<Run> {
    const now = this.#now()
    const written = await this.#write(run, (current) => {
      const next: Run = { ...current, state: end.state, closedAt: now, driver: { session: '', since: now } }
      if (end.state === 'pr') {
        next.pr = { url: end.pr.url, number: end.pr.number }
        delete next.reason
      } else {
        next.reason = end.reason
      }
      return next
    })
    await this.#harnessLogged(written, written.state === 'pr' && written.pr !== undefined
      ? { kind: 'run.closed', session: sessionId, state: 'pr', pr: written.pr }
      : { kind: 'run.closed', session: sessionId, state: 'abandoned', ...written.reason === undefined ? {} : { reason: written.reason } })
    return written
  }

  /** An entry for `run`'s ledger: `at` now, `run` its id, `by` the writer; `kind` one of the writer's own. @throws TypeError otherwise. */
  #build(run: Run, entry: HarnessInput | MainInput, by: 'harness' | 'main', session?: string): LedgerEntry {
    const kind = isObject(entry) ? entry.kind : undefined
    const kinds: readonly string[] = by === 'harness' ? HARNESS_KINDS : MAIN_KINDS
    if (typeof kind !== 'string' || !kinds.includes(kind)) {
      throw new TypeError(`${JSON.stringify(String(kind))} isn't an entry the ${by === 'harness' ? 'harness' : 'main agent'} writes`)
    }
    const fields: Record<string, unknown> = { ...entry }
    for (const base of ['at', 'run', 'kind', 'by', 'cut']) delete fields[base]
    if (session !== undefined) delete fields.session
    return { at: this.#now(), run: run.id, kind, by, ...session === undefined ? {} : { session }, ...fields } as unknown as LedgerEntry
  }

  /** Append one entry by the harness (a harness kind only). @throws TypeError for a kind of the other writer; what the ledger throws. */
  async harness(run: Run, entry: HarnessInput): Promise<void> {
    await this.ledger.append(run.project, run.id, this.#build(run, entry, 'harness'))
  }

  /** Append one entry by the main agent (ruling, deferred, note only), with `sessionId` as its session. @throws TypeError otherwise. */
  async main(run: Run, sessionId: string, entry: MainInput): Promise<void> {
    await this.ledger.append(run.project, run.id, this.#build(run, entry, 'main', sessionId))
  }

  /** `harness`, its failure logged: for an entry whose record is already written. */
  async #harnessLogged(run: Run, entry: HarnessInput): Promise<void> {
    try {
      await this.harness(run, entry)
    } catch (error) {
      this.logOnce(`run ${run.id} of ${run.project}: its record was written, but its ledger couldn't record ${entry.kind}: ${describe(error)}`)
    }
  }

  // --- for the listeners -------------------------------------------------------------------------------------------

  /** Remember where `childId` was placed: the child index, which `place` reads for a reviewer. The oldest go past 1000. */
  noteChild(childId: string, tags: ChildTags): void {
    this.#children.delete(childId)
    this.#children.set(childId, tags)
    if (this.#children.size > CHILDREN_MAX) this.#children.delete(this.#children.keys().next().value!)
  }

  /** Where `childId` was placed, if this process heard. */
  childTags(childId: string): ChildTags | undefined {
    return this.#children.get(childId)
  }

  /** Where crew's record says `childId` is, or undefined: an untagged child, no crew, a rejection, or past the lookup's limit. Never rejects. */
  async lookupChild(childId: string): Promise<ChildTags | undefined> {
    try {
      const crew = this.services.crew()
      if (crew === undefined) return undefined
      const found = await within(crew.records.lookup(childId), this.#lookupMs)
      if (found === TIMED_OUT || found === undefined) return undefined
      const { record, sessionId } = found
      if (!isText(record?.run)) return undefined
      return { ref: record.run, ...isText(record.task) ? { task: record.task } : {}, ...isText(sessionId) ? { sessionId } : {} }
    } catch {
      return undefined
    }
  }

  /** The worktree's HEAD (`dishWorkspaces.headOf`), or null: no dish-workspaces, none, a rejection, or past the lookup's limit. Never rejects. */
  async headOf(path: string): Promise<string | null> {
    try {
      const workspaces = this.services.workspaces()
      if (workspaces === undefined) return null
      const head = await within(workspaces.headOf(path), this.#lookupMs)
      return typeof head === 'string' && head !== '' ? head : null
    } catch {
      return null
    }
  }
}
