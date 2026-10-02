/**
 * The `dishProjects` service: which projects there are, how far each is onboarded, and what drives the onboarding.
 *
 * - **The registry** is `projects.yaml` in the config store (`dishConfig`), which is optional: without it there are no
 *   projects. It is read from `main` on every call (parsed once per commit). A file that doesn't parse (a hand edit in
 *   the repository; the store refuses one otherwise) is no projects, and `problem()` says why; it is logged once per
 *   commit. A store that fails to answer makes the call reject.
 * - **Driving.** `drive()` compares the registry with what it last saw and queues the work (see `Onboarding`):
 *   - the first time, or after `restart` (dish-workspaces appeared): a project that isn't ready is onboarded, and a
 *     ready one is prepared. The first time, a status kept for a project no longer listed is forgotten too;
 *   - always: a new project is onboarded; a failed (or waiting) one whose fields changed is onboarded again; a ready
 *     one whose fields changed is left alone (its next fetch, worktree and gate read the new fields); a removed one
 *     is cancelled (its setup is killed) and its status forgotten;
 *   - whenever something differs, `changed` is told every name that is in either list.
 *   A registry that can't be read or parsed leaves everything as it was, and a restart asked for then is carried out
 *   by the next pass that can read it. Passes never overlap: one asked for while another runs runs after it, once for
 *   all asked meanwhile.
 * - **Names** compare without regard to case, as GitHub's do.
 *
 * @module dish-projects/service
 */
import type { DishConfigService } from 'dish-config'
import { Onboarding, statusMessage } from './onboarding.ts'
import type { OnboardingLogger, WorkspacesDriver } from './onboarding.ts'
import { PROJECTS_PATH, parseProjects } from './registry.ts'
import type { ParseResult, Project } from './registry.ts'
import type { ProjectStatus, StatusStore } from './status.ts'

export interface DishProjects {
  /** `projects.yaml` at `main` now, parsed and sorted by name; `[]` without a store or when the file doesn't parse. */
  list(): Promise<Project[]>
  /** The project called `name`, compared without regard to case, as it is in `projects.yaml` now. */
  get(name: string): Promise<Project | undefined>
  /** `name`'s onboarding status; pending at 0 for a project with none. */
  status(name: string): ProjectStatus
  /**
   * Onboard `name` again. Refused (throws) only while its onboarding is queued or running. On a ready project it
   * onboards again: it adopts the clone, runs setup (on merged code) and registers the workspace again.
   */
  retry(name: string): Promise<void>
  /** Why the stored `projects.yaml` doesn't parse, or `undefined` when it does (or there is no store). */
  problem(): Promise<string | undefined>
}

// Here, not in the plugin's own file, so that whoever imports these types also gets `ctx.get('dishProjects')` and the
// events typed.
declare module '@deepseek-ai/cordis' {
  interface Context {
    dishProjects: DishProjects
  }

  interface Events {
    /** `projects.yaml` changed: every project name in the list before or after (a name added, removed or edited). */
    'dish-projects/changed'(names: string[]): void
    /** A project's onboarding status changed. */
    'dish-projects/status'(name: string, status: ProjectStatus): void
  }
}

/** What the service needs of the store: its head, and a document at a commit. */
export type StoreReader = Pick<DishConfigService, 'head' | 'read'>

export interface ProjectsOptions {
  /** The store as it is now, or `undefined`. Called on every read. */
  store: () => StoreReader | undefined
  /** The status file's store. The service loads it at once (`loadSync`), so `status()` is right from the start. */
  status: StatusStore
  /** `dishWorkspaces` as it is now, or `undefined`. */
  workspaces: () => WorkspacesDriver | undefined
  /** `dish-projects/changed`. */
  changed: (names: string[]) => void
  /** `dish-projects/status`. */
  emitStatus: (name: string, status: ProjectStatus) => void
  logger: OnboardingLogger
  now?: () => number
}

export interface ProjectsService extends DishProjects {
  /** Compare the registry with what was last seen and queue the work. `restart`: as at start. Never rejects. */
  drive(options?: { restart?: boolean }): Promise<void>
  /** `dishWorkspaces` went away: the running job can't finish (see `Onboarding.interrupt`). */
  workspacesGone(): void
  /** Stop: no more passes, and the queue is cancelled. */
  close(): void
  /** Resolves when no pass runs and the queue is empty. For tests. */
  idle(): Promise<void>
}

const keyOf = (name: string): string => name.toLowerCase()

/** An error's text as a log line may carry it: masked and cut short. */
function describe(error: unknown): string {
  return statusMessage(error instanceof Error ? error.message : String(error))
}

function byName(a: string, b: string): number {
  const first = a.toLowerCase()
  const second = b.toLowerCase()
  if (first !== second) return first < second ? -1 : 1
  return a < b ? -1 : a > b ? 1 : 0
}

/** Whether `a` and `b` say the same project, field for field (the order of `gateEnv`'s names aside). */
function sameProject(a: Project, b: Project): boolean {
  const env = (project: Project): string => JSON.stringify(Object.entries(project.gateEnv).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)))
  return a.name === b.name && a.family === b.family && a.role === b.role && a.gate === b.gate && a.gateTimeout === b.gateTimeout
    && a.setup === b.setup && a.setupTimeout === b.setupTimeout && env(a) === env(b)
}

/** The caller's own copy of a project: the parsed ones are kept per commit and shared. */
function copyProject(project: Project): Project {
  return { ...project, gateEnv: { ...project.gateEnv } }
}

interface Read {
  commit: string
  result: ParseResult
}

export function createDishProjects(options: ProjectsOptions): ProjectsService {
  const now = options.now ?? Date.now
  const { status, logger } = options

  const warn = (format: string, ...args: unknown[]): void => {
    try {
      logger.warn(format, ...args)
    } catch {
      // Logging is not worth a failed call.
    }
  }

  // At once, not in the background: dish-workspaces checks which projects are ready as soon as it starts, and an empty
  // store would say none is. The file is small.
  try {
    status.loadSync()
  } catch (error) {
    warn('could not read the onboarding status, so every project starts as pending: %s', describe(error))
  }

  const onboarding = new Onboarding({ status, workspaces: options.workspaces, emit: options.emitStatus, logger, now })

  // --- reading the registry -----------------------------------------------------------------------

  let memo: Read | undefined
  /** The commit whose broken registry was told last, so each is told once. */
  let toldBroken: string | undefined

  /** The registry at `main` now, or `undefined` without a store. Rejects when the store does. */
  async function read(): Promise<Read | undefined> {
    const store = options.store()
    if (store === undefined) return undefined
    const commit = await store.head()
    if (memo?.commit === commit) return memo
    const text = await store.read(PROJECTS_PATH, commit)
    // Before the seed there is no file: no projects.
    const result: ParseResult = text === undefined ? { ok: true, projects: [], fields: {} } : parseProjects(text)
    if (!result.ok && toldBroken !== commit) {
      toldBroken = commit
      warn('%s; dish sees no projects until it is fixed', result.problem)
    }
    memo = { commit, result }
    return memo
  }

  async function list(): Promise<Project[]> {
    const current = await read()
    return current?.result.ok === true ? current.result.projects.map(copyProject) : []
  }

  async function get(name: string): Promise<Project | undefined> {
    const key = keyOf(String(name))
    return (await list()).find(project => keyOf(project.name) === key)
  }

  async function problem(): Promise<string | undefined> {
    const current = await read()
    return current?.result.ok === false ? current.result.problem : undefined
  }

  // --- statuses -----------------------------------------------------------------------------------

  /** The last failure to save a status that was logged here, told once for as long as it lasts. */
  let saveTrouble: string | undefined
  const saved = (saving: Promise<void>, what: string): void => {
    saving.then(() => { saveTrouble = undefined }, (error: unknown) => {
      const message = describe(error)
      if (saveTrouble === message) return
      saveTrouble = message
      warn('could not save the onboarding status of %s: %s', what, message)
    })
  }

  function emitStatus(name: string, value: ProjectStatus): void {
    try {
      options.emitStatus(name, value)
    } catch (error) {
      warn('a dish-projects/status listener failed: %s', describe(error))
    }
  }

  async function retry(name: string): Promise<void> {
    const project = await get(name)
    if (project === undefined) throw new Error(`no project ${name} in projects.yaml`)
    const under = onboarding.onboarding(project.name)
    if (under === 'queued') throw new Error(`${project.name} is queued for onboarding already`)
    if (under === 'running') throw new Error(`${project.name} is being onboarded`)
    const pending: ProjectStatus = { state: 'pending', at: now() }
    saved(status.set(project.name, pending), project.name)
    emitStatus(project.name, pending)
    onboarding.enqueue(project, 'onboard')
  }

  // --- driving ------------------------------------------------------------------------------------

  /** The projects the last pass saw, by lower-cased name; `undefined` before the first. */
  let known: Map<string, Project> | undefined
  let closed = false
  /** The trouble reading the registry told last, so a store that keeps failing is told once. */
  let readTrouble: string | undefined
  /** A restart that a pass couldn't carry out (no store, or a registry it couldn't read): the next pass that can, does. */
  let restartOwed = false

  function forget(name: string): void {
    onboarding.cancel(name)
    saved(status.forget(name), name)
  }

  function emitChanged(names: string[]): void {
    try {
      options.changed(names)
    } catch (error) {
      warn('a dish-projects/changed listener failed: %s', describe(error))
    }
  }

  /** One pass (see the module's notes). Never rejects. */
  async function pass(restart: boolean): Promise<void> {
    if (closed) return
    if (restart) restartOwed = true
    let current: Read | undefined
    try {
      current = await read()
      readTrouble = undefined
    } catch (error) {
      const message = describe(error)
      if (readTrouble !== message) {
        readTrouble = message
        warn('could not read %s from the config store: %s', PROJECTS_PATH, message)
      }
      return
    }
    // No store, or a registry broken by hand: keep what was known. The log and problem() say why.
    if (closed || current === undefined || !current.result.ok) return

    const listed = new Map(current.result.projects.map(project => [keyOf(project.name), project]))
    const previous = known
    const atStart = previous === undefined || restartOwed
    restartOwed = false
    const names = new Set<string>()
    let differs = previous === undefined

    if (previous === undefined) {
      // Statuses of projects removed while dish was down.
      for (const name of status.names()) if (!listed.has(name)) forget(name)
    } else {
      for (const [key, project] of previous) {
        if (listed.has(key)) continue
        names.add(project.name)
        differs = true
        forget(project.name)
      }
    }

    for (const [key, project] of listed) {
      names.add(project.name)
      const before = previous?.get(key)
      const edited = before !== undefined && !sameProject(before, project)
      if (before === undefined || edited) differs = true
      if (before !== undefined && edited) names.add(before.name)
      const state = status.get(project.name).state
      if (atStart) {
        onboarding.enqueue(project, state === 'ready' ? 'prepare' : 'onboard')
      } else if (before === undefined) {
        onboarding.enqueue(project, 'onboard')
      } else if (edited && (state === 'failed' || state === 'pending')) {
        // A failed one may be fixed (a setup corrected, say); a waiting one takes the new fields when it runs. A ready
        // one is left alone, and one being onboarded finishes with what it had.
        onboarding.enqueue(project, 'onboard')
      }
    }

    known = listed
    if (differs && names.size > 0) emitChanged([...names].sort(byName))
  }

  let requested: { restart: boolean } | undefined
  let driving: Promise<void> | undefined

  async function passes(): Promise<void> {
    // So that `driving` is set before the loop can end.
    await Promise.resolve()
    try {
      while (requested !== undefined && !closed) {
        const { restart } = requested
        requested = undefined
        try {
          await pass(restart)
        } catch (error) {
          warn('driving onboarding failed: %s', describe(error))
        }
      }
    } finally {
      driving = undefined
    }
  }

  function drive(drive: { restart?: boolean } = {}): Promise<void> {
    if (closed) return Promise.resolve()
    requested = { restart: requested?.restart === true || drive.restart === true }
    driving ??= passes()
    return driving
  }

  return {
    list,
    get,
    status: (name: string) => status.get(String(name)),
    retry,
    problem,
    drive,
    workspacesGone: () => onboarding.interrupt(),
    close() {
      closed = true
      requested = undefined
      onboarding.close()
    },
    async idle() {
      while (driving !== undefined) await driving
      await onboarding.idle()
    },
  }
}
