/**
 * The onboarding queue: one project at a time, in the background, through `dish-workspaces`.
 *
 * - **One at a time.** Jobs run in the order they were queued, and the next starts only when the one before has
 *   settled, an aborted one included (its setup is still being killed until then).
 * - **No duplicates.** A project already queued isn't queued again: the queued job takes the newer fields, and an
 *   onboarding asked for while a prepare is queued turns that job into an onboarding. A project whose onboarding is
 *   running isn't queued again; one whose prepare is running gets its onboarding queued behind it.
 * - **Status.** Each step `dish-workspaces` reports moves the project's status (`installation`, `clone` and
 *   `configure` are cloning; `setup` and `workspace` are setup), and the end is `ready` or `failed`. Each change is
 *   set in the status store and emitted. A job that was cancelled records nothing more, however it ends.
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
}

/** Why a project waits as pending when there is nothing to onboard it with. */
export const NO_WORKSPACES = 'dish-workspaces isn\'t running'

/** The step a failed prepare is reported at: prepare is onboarding's configure step again. */
const PREPARE_STEP = 'configure'

/** The longest message a status keeps. */
const MAX_MESSAGE = 1000

/** The state each onboarding step puts a project in. A step not listed here is taken as cloning. */
const STEP_STATES: Readonly<Record<string, ProjectState>> = {
  installation: 'cloning',
  clone: 'cloning',
  configure: 'cloning',
  setup: 'setup',
  workspace: 'setup',
}

type Kind = 'onboard' | 'prepare'

interface Job {
  key: string
  project: Project
  kind: Kind
}

interface Running extends Job {
  controller: AbortController
}

const keyOf = (name: string): string => name.toLowerCase()

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
    if (running !== undefined && running.key === key && !running.controller.signal.aborted) {
      if (running.kind === 'onboard' || kind === 'prepare') return
    }
    this.#queue.push({ key, project, kind })
    this.#drain()
  }

  /** Abort a queued or running job for `name` (its setup is killed through the signal). Nothing more is recorded for it. */
  cancel(name: string): void {
    const key = keyOf(name)
    this.#queue = this.#queue.filter(job => job.key !== key)
    if (this.#running?.key === key) this.#running.controller.abort()
  }

  /**
   * `dish-workspaces` went away, so the running job can't finish: abort it. An onboarding's project is pending again,
   * waiting for `dish-workspaces` (the plugin queues it when that comes back); a prepare's stays ready. The queue stays.
   */
  interrupt(): void {
    const running = this.#running
    if (this.#closed || running === undefined || running.controller.signal.aborted) return
    running.controller.abort()
    if (running.kind === 'onboard') void this.#record(running.project, { state: 'pending', message: NO_WORKSPACES, at: this.#now() })
  }

  /** Resolves when nothing is queued or running. For tests. */
  async idle(): Promise<void> {
    while (this.#draining !== undefined) await this.#draining
  }

  /** Cancel everything, and take no more jobs. Safe to call twice. */
  close(): void {
    this.#closed = true
    this.#queue = []
    this.#running?.controller.abort()
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

  /** Run one job. Never rejects. */
  async #run(job: Job): Promise<void> {
    const controller = new AbortController()
    this.#running = { ...job, controller }
    try {
      if (job.kind === 'onboard') await this.#onboard(job.project, controller.signal)
      else await this.#prepare(job.project, controller.signal)
    } catch (error) {
      // The steps catch their own; this is a bug's last stop, not the queue's.
      this.#warn('onboarding %s stopped unexpectedly: %s', job.project.name, statusMessage(describe(error)))
    } finally {
      this.#running = undefined
    }
  }

  async #onboard(project: Project, signal: AbortSignal): Promise<void> {
    const driver = this.#workspaces()
    if (driver === undefined) {
      await this.#record(project, { state: 'pending', message: NO_WORKSPACES, at: this.#now() })
      return
    }
    let step: string | undefined
    const progress = (next: string): void => {
      if (signal.aborted) return
      step = String(next)
      void this.#record(project, { state: STEP_STATES[step] ?? 'cloning', step, at: this.#now() })
    }
    this.#info('onboarding %s', project.name)
    try {
      const result = await driver.onboard(project, { signal, progress })
      if (signal.aborted) return
      // `ran: false` for a project with no setup is nothing skipped.
      const setup = result?.setup
      const skipped = setup?.ran === false && project.setup !== undefined ? statusMessage(setup.reason ?? 'setup was skipped') : undefined
      const at = this.#now()
      await this.#record(project, { state: 'ready', at, readyAt: at, ...skipped === undefined ? {} : { setupSkipped: skipped } })
      if (skipped === undefined) this.#info('%s is ready', project.name)
      else this.#info('%s is ready, without setup: %s', project.name, skipped)
    } catch (error) {
      if (signal.aborted) return
      if (this.#workspaces() !== driver) {
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
  async #prepare(project: Project, signal: AbortSignal): Promise<void> {
    if (this.#status.get(project.name).state !== 'ready') return
    // Nothing to prepare with: the plugin queues it again when dish-workspaces appears.
    const driver = this.#workspaces()
    if (driver === undefined) return
    try {
      await driver.prepare(project)
    } catch (error) {
      // A retry may have moved it on meanwhile; the onboarding that follows will meet the same trouble and say so.
      if (signal.aborted || this.#status.get(project.name).state !== 'ready') return
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
