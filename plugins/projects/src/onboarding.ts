/**
 * The onboarding queue: one project at a time, in the background, through `dish-workspaces`.
 *
 * - **One at a time.** Jobs run in the order they were queued, and the next starts only when the one before has
 *   settled, an aborted one included (its setup is still being killed until then). An aborted job that still hasn't
 *   settled after a grace period (30 s) is logged and left behind, and the queue goes on: dish-workspaces' per-project
 *   lock still guards its clone.
 * - **No duplicates.** A project already queued isn't queued again: the queued job takes the newer fields, and an
 *   onboarding asked for while a prepare is queued turns that job into an onboarding. A project whose onboarding is
 *   running isn't queued again; one whose prepare is running gets its onboarding queued behind it. A job whose end is
 *   decided (its driver call has settled, or it found no driver) and is only recording it counts no more: what is
 *   asked for then (dish-workspaces back, the fields changed) is queued behind it, not dropped.
 * - **Status.** Each step `dish-workspaces` reports moves the project's status (`installation`, `clone` and
 *   `configure` are cloning; `setup` and `workspace` are setup; any other is ignored), and the end is `ready` or
 *   `failed`. Each change is set in the status store and emitted. A job that dish-projects aborted (a removal, a stop)
 *   records nothing more, however it ends.
 * - **dish-workspaces going away** is never a project's failure: an onboarding it abandons (its close rejects the work
 *   with an `AbortError`, or the service is gone by the time the work fails) leaves the project pending, waiting for
 *   it; a prepare it abandons leaves the project ready, to be prepared when it comes back.
 * - **Messages** are masked with dish-kit's `maskSecrets` (the driver masks them too: this is the second line) and cut
 *   short.
 *
 * The driver is read when a job starts, and may be missing: an onboarding then leaves the project pending, saying so,
 * and the plugin queues it again when `dish-workspaces` appears.
 *
 * @module dish-projects/onboarding
 */
import { maskSecrets } from 'dish-kit'
import type { Project } from './registry.ts'
import type { ProjectState, ProjectStatus, StatusStore } from './status.ts'

/** What onboarding calls of `dish-workspaces` (its `dishWorkspaces` service), structurally. */
export interface WorkspacesDriver {
  onboard(project: Project, options: { signal: AbortSignal, progress: (step: string) => void }): Promise<{ setup: { ran: boolean, reason?: string } }>
  prepare(project: Project): Promise<void>
}

export interface OnboardingLogger {
  info(format: string, ...args: unknown[]): void
  warn(format: string, ...args: unknown[]): void
}

export interface OnboardingOptions {
  status: StatusStore
  /** `dishWorkspaces` as it is now, or `undefined`. Called when a job starts. */
  workspaces: () => WorkspacesDriver | undefined
  /** Tell the rest of dish a project's status changed (`dish-projects/status`). */
  emit: (name: string, status: ProjectStatus) => void
  logger: OnboardingLogger
  /** The clock, in ms since the epoch. */
  now?: () => number
  /** How long an aborted job may take to settle before the queue goes on without it. Default `ABORT_GRACE_MS`. */
  abortGraceMs?: number
}

/** Why a project waits as pending when there is nothing to onboard it with. */
export const NO_WORKSPACES = 'dish-workspaces isn\'t running'

/** How long an aborted job may take to settle (its setup killed: TERM, then KILL after 5 s) before the queue goes on. */
export const ABORT_GRACE_MS = 30_000

/** The step a failed prepare is reported at: prepare is onboarding's configure step again. */
const PREPARE_STEP = 'configure'

/** The longest message a status keeps. */
const MAX_MESSAGE = 1000

/** The state each onboarding step puts a project in. Only these steps are recorded. */
const STEP_STATES: Readonly<Record<string, ProjectState>> = {
  installation: 'cloning',
  clone: 'cloning',
  configure: 'cloning',
  setup: 'setup',
  workspace: 'setup',
}

/** `step`'s state, if it is a step dish knows. */
function stepState(step: unknown): ProjectState | undefined {
  return typeof step === 'string' && Object.hasOwn(STEP_STATES, step) ? STEP_STATES[step] : undefined
}

type Kind = 'onboard' | 'prepare'

interface Job {
  key: string
  project: Project
  kind: Kind
}

interface Running extends Job {
  controller: AbortController
  /**
   * The driver's call has settled, or there was no driver: what is left is the job's own record, which an interrupt must
   * not undo, and which a new job for the project needn't wait to be queued behind.
   */
  finishing: boolean
  /** The job has settled. */
  settled: boolean
  /** Let the queue go on without the job: its grace after an abort ran out. */
  release: () => void
  grace: ReturnType<typeof setTimeout> | undefined
}

const keyOf = (name: string): string => name.toLowerCase()

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Whether `error` is an abort: from dish-workspaces closing, when dish-projects didn't abort the job itself. */
function isAbort(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === 'AbortError'
}

/** `text` masked and cut short: what a status may say. */
export function statusMessage(text: string): string {
  const masked = maskSecrets(text)
  return masked.length > MAX_MESSAGE ? `${masked.slice(0, MAX_MESSAGE)}…` : masked
}

export class Onboarding {
  readonly #status: StatusStore
  readonly #workspaces: () => WorkspacesDriver | undefined
  readonly #emit: (name: string, status: ProjectStatus) => void
  readonly #logger: OnboardingLogger
  readonly #now: () => number
  readonly #abortGraceMs: number
  #queue: Job[] = []
  #running: Running | undefined
  #draining: Promise<void> | undefined
  #closed = false
  /** The last failure to save a status that was logged, so a disk that stays broken is told once. */
  #saveTrouble: string | undefined

  constructor(options: OnboardingOptions) {
    this.#status = options.status
    this.#workspaces = options.workspaces
    this.#emit = options.emit
    this.#logger = options.logger
    this.#now = options.now ?? Date.now
    this.#abortGraceMs = options.abortGraceMs ?? ABORT_GRACE_MS
  }

  /**
   * Queue `project` for onboarding (or `prepare` when `kind` is 'prepare'). One job runs at a time, in order; a project
   * already queued or running isn't queued twice (see the module's notes for a prepare).
   */
  enqueue(project: Project, kind: Kind): void {
    if (this.#closed) return
    const key = keyOf(project.name)
    const queued = this.#queue.find(job => job.key === key)
    if (queued !== undefined) {
      queued.project = project
      if (kind === 'onboard') queued.kind = 'onboard'
      return
    }
    const running = this.#running
    if (running !== undefined && running.key === key && !running.controller.signal.aborted && !running.finishing) {
      if (running.kind === 'onboard' || kind === 'prepare') return
    }
    this.#queue.push({ key, project, kind })
    this.#drain()
  }

  /** Whether an onboarding of `name` is queued (`queued`) or running (`running`). A prepare, or an aborted job, doesn't count. */
  onboarding(name: string): 'queued' | 'running' | undefined {
    const key = keyOf(name)
    if (this.#queue.some(job => job.key === key && job.kind === 'onboard')) return 'queued'
    const running = this.#running
    if (running?.key === key && running.kind === 'onboard' && !running.controller.signal.aborted) return 'running'
    return undefined
  }

  /** Abort a queued or running job for `name` (its setup is killed through the signal). Nothing more is recorded for it. */
  cancel(name: string): void {
    const key = keyOf(name)
    this.#queue = this.#queue.filter(job => job.key !== key)
    if (this.#running?.key === key) this.#abort(this.#running)
  }

  /**
   * `dish-workspaces` went away, so the running job can't finish: abort it. An onboarding's project is pending again,
   * waiting for `dish-workspaces` (the plugin queues it when that comes back); a prepare's stays ready. The queue
   * stays. A job whose driver call has already settled is left to record its own end.
   */
  interrupt(): void {
    const running = this.#running
    if (this.#closed || running === undefined || running.controller.signal.aborted || running.finishing) return
    this.#abort(running)
    if (running.kind === 'onboard') void this.#record(running.project, { state: 'pending', message: NO_WORKSPACES, at: this.#now() })
  }

  /** Resolves when nothing is queued or running. For tests. */
  async idle(): Promise<void> {
    while (this.#draining !== undefined) await this.#draining
  }

  /**
   * Cancel everything, and take no more jobs. Safe to call twice. No grace period: nothing follows a close, so there is
   * no queue to go on with, and nothing should be logged once the plugin is gone.
   */
  close(): void {
    this.#closed = true
    this.#queue = []
    const running = this.#running
    if (running === undefined) return
    running.controller.abort()
    if (running.grace !== undefined) clearTimeout(running.grace)
    running.grace = undefined
  }

  /** Abort `running`, and give it the grace period to settle before the queue goes on without it. */
  #abort(running: Running): void {
    if (running.controller.signal.aborted) return
    running.controller.abort()
    if (running.settled) return
    running.grace = setTimeout(() => {
      running.grace = undefined
      if (running.settled) return
      const what = running.kind === 'onboard' ? 'onboarding' : 'preparing'
      this.#warn('%s %s didn\'t stop within %ds of being aborted; the queue goes on without it', what, running.project.name, Math.round(this.#abortGraceMs / 1000))
      running.release()
    }, this.#abortGraceMs)
    running.grace.unref?.()
  }

  #drain(): void {
    if (this.#draining !== undefined || this.#closed) return
    const draining = (async () => {
      // So that `#draining` is set before the first job looks at it.
      await Promise.resolve()
      for (;;) {
        const job = this.#queue.shift()
        if (job === undefined || this.#closed) return
        await this.#run(job)
      }
    })()
    this.#draining = draining
    void draining.finally(() => {
      if (this.#draining === draining) this.#draining = undefined
      // A job queued between the last look and now.
      if (this.#queue.length > 0) this.#drain()
    })
  }

  /** Run one job, until it settles or its grace after an abort runs out. Never rejects. */
  async #run(job: Job): Promise<void> {
    let release = (): void => {}
    const released = new Promise<void>((resolve) => { release = resolve })
    const running: Running = { ...job, controller: new AbortController(), finishing: false, settled: false, release, grace: undefined }
    this.#running = running
    const work = this.#work(running).finally(() => {
      running.settled = true
      if (running.grace !== undefined) clearTimeout(running.grace)
      if (this.#running === running) this.#running = undefined
    })
    await Promise.race([work, released])
    // Left behind: it records nothing more (it was aborted), and it is no longer the running job.
    if (this.#running === running) this.#running = undefined
  }

  async #work(running: Running): Promise<void> {
    try {
      if (running.kind === 'onboard') await this.#onboard(running)
      else await this.#prepare(running)
    } catch (error) {
      // The steps catch their own; this is a bug's last stop, not the queue's.
      this.#warn('onboarding %s stopped unexpectedly: %s', running.project.name, statusMessage(describe(error)))
    }
  }

  async #onboard(running: Running): Promise<void> {
    const { project } = running
    const { signal } = running.controller
    const driver = this.#workspaces()
    if (driver === undefined) {
      // Decided: dish-workspaces appearing while this is saved queues the project again (see `enqueue`).
      running.finishing = true
      await this.#record(project, { state: 'pending', message: NO_WORKSPACES, at: this.#now() })
      return
    }
    let step: string | undefined
    const progress = (next: string): void => {
      if (signal.aborted || running.finishing) return
      const state = stepState(next)
      if (state === undefined) return
      step = next
      void this.#record(project, { state, step: next, at: this.#now() })
    }
    this.#info('onboarding %s', project.name)
    try {
      const result = await driver.onboard(project, { signal, progress })
      running.finishing = true
      if (signal.aborted) return
      // `ran: false` for a project with no setup is nothing skipped.
      const setup = result?.setup
      const skipped = setup?.ran === false && project.setup !== undefined ? statusMessage(setup.reason ?? 'setup was skipped') : undefined
      const at = this.#now()
      await this.#record(project, { state: 'ready', at, readyAt: at, ...skipped === undefined ? {} : { setupSkipped: skipped } })
      if (skipped === undefined) this.#info('%s is ready', project.name)
      else this.#info('%s is ready, without setup: %s', project.name, skipped)
    } catch (error) {
      running.finishing = true
      if (signal.aborted) return
      if (this.#workspaces() !== driver || isAbort(error)) {
        // dish-workspaces went away under it (its close aborts what it was doing): not the project's failure.
        await this.#record(project, { state: 'pending', message: NO_WORKSPACES, at: this.#now() })
        return
      }
      const message = statusMessage(describe(error))
      await this.#record(project, { state: 'failed', ...step === undefined ? {} : { step }, message, at: this.#now() })
      this.#warn('onboarding %s failed%s: %s', project.name, step === undefined ? '' : ` at ${step}`, message)
    }
  }

  /** Configure a ready project's clone again (dish-workspaces' step 3 and its safety check). Only for a project still ready. */
  async #prepare(running: Running): Promise<void> {
    const { project } = running
    const { signal } = running.controller
    if (this.#status.get(project.name).state !== 'ready') return
    // Nothing to prepare with: the plugin queues it again when dish-workspaces appears.
    const driver = this.#workspaces()
    if (driver === undefined) return
    try {
      await driver.prepare(project)
      running.finishing = true
    } catch (error) {
      running.finishing = true
      // Aborted by dish-projects, or abandoned by dish-workspaces going away: it stays ready, and is prepared when
      // dish-workspaces comes back. Or a retry moved it on meanwhile, and the onboarding that follows will meet the
      // same trouble and say so.
      if (signal.aborted || this.#workspaces() !== driver || isAbort(error)) return
      if (this.#status.get(project.name).state !== 'ready') return
      const message = statusMessage(describe(error))
      await this.#record(project, { state: 'failed', step: PREPARE_STEP, message, at: this.#now() })
      this.#warn('preparing %s failed: %s', project.name, message)
    }
  }

  /** Set and emit `status`. A status that can't be saved stays in memory, and is logged once for as long as that lasts. */
  async #record(project: Project, status: ProjectStatus): Promise<void> {
    const saving = this.#status.set(project.name, status)
    try {
      this.#emit(project.name, status)
    } catch (error) {
      this.#warn('a dish-projects/status listener failed: %s', describe(error))
    }
    try {
      await saving
      this.#saveTrouble = undefined
    } catch (error) {
      const message = describe(error)
      if (this.#saveTrouble === message) return
      this.#saveTrouble = message
      this.#warn('could not save the onboarding status of %s: %s', project.name, message)
    }
  }

  #info(format: string, ...args: unknown[]): void {
    try {
      this.#logger.info(format, ...args)
    } catch {
      // Logging is not worth a failed job.
    }
  }

  #warn(format: string, ...args: unknown[]): void {
    try {
      this.#logger.warn(format, ...args)
    } catch {
      // Logging is not worth a failed job.
    }
  }
}
