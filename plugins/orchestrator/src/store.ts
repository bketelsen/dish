/**
 * The run records: one JSON file a run, `<state>/orchestrator/<owner>/<repo>/runs/<id>.json`.
 *
 * - **Read once.** `load` reads every record into memory, and the rest answer from that copy (each gives copies). Writes go
 *   to the file first and then to the copy, so the copy is what is on disk, as far as this process knows.
 * - **Written whole.** A temp file in the same directory (`wx`, 0600), synced, renamed over the record, then the
 *   directory synced (crew's `writeAtomic`, copied). Directories are made 0700. A reader sees the old
 *   record or the new one; a crash leaves at worst a temp file, which `load` leaves alone.
 * - **One queue a project.** `create` and `update` go through the project's promise queue, so two runs opened at once
 *   get two ids, and two changes to a record can't each drop the other's.
 * - **Checked.** What is written is made plain JSON (a field set to `undefined` is left out, in memory as on disk) and
 *   passes `runProblem` first; what is read back must pass it too, and sit where its `project` and `id` say. A record that
 *   doesn't is corrupt: it is renamed `<file>.corrupt-<ms>` (nothing is removed, and its id stays taken, so its ledger is
 *   never a new run's), and `onCorrupt` is told.
 * - **One bad record is one record.** A record that can't be read, or a corrupt one that can't be set aside, is skipped
 *   where it is and `onCorrupt` is told (with `aside` `''`); the rest load. Its name still holds its id. Only a directory
 *   that can't be listed fails the load, which the next call tries again.
 * - **No secrets.** `goal`, `reason` and `plan.path` are masked (`maskSecrets`) where they are written; `goal` and `reason`
 *   are also folded to one line and cut, to 300 and 1000 characters.
 * - **Kept.** Nothing here deletes a record.
 *
 * @module dish-orchestrator/store
 */

import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import type { Dirent } from 'node:fs'
import { mkdir, open, readdir, rename, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { maskSecrets } from 'dish-kit'
import { recordFile, recordsRoot, RUN_ID, runId, RUNS_DIRECTORY, runsDirectory, sameProject, SEGMENT, SLUG, splitProject } from './paths.ts'
import { cut, errorCode, isObject, isText, oneLine } from './text.ts'

export type RunState = 'open' | 'pr' | 'abandoned'
export const RUN_STATES: readonly RunState[] = ['open', 'pr', 'abandoned']

export interface Run {
  id: string
  /** `owner/repo`, as projects.yaml writes it (dish-workspaces' `created.project`). */
  project: string
  slug: string
  /** One line, masked, at most 300 characters. */
  goal: string
  plan?: { path: string, commit: string }
  /** `dish/<slug>`. */
  branch: string
  /** Absolute, canonical (createWorktree's `path`). */
  worktree: string
  /** The ref it was cut from: CreatedWorktree.baseRef (`origin/<default>`, or the base asked for). */
  base: string
  baseCommit: string
  state: RunState
  /** Kept when a run with a PR is reopened for review feedback (`run` `resume`): it is `open` again. */
  pr?: { url: string, number: number }
  /** abandoned: why, one line, masked, at most 1000 characters. */
  reason?: string
  /** session '' = released: nobody drives it; never live. */
  driver: { session: string, since: number }
  openedAt: number
  /** Absent while open; a reopen removes it. */
  closedAt?: number
}

export interface NewRun {
  project: string
  slug: string
  goal: string
  branch: string
  worktree: string
  base: string
  baseCommit: string
  plan?: { path: string, commit: string }
  /** The session that opens it. */
  driver: string
  openedAt?: number
}

/** The most characters a goal keeps. */
export const GOAL_MAX = 300
/** The most characters a reason keeps. */
export const REASON_MAX = 1000

const NOT_LOADED = 'the run store isn\'t loaded'
const RECORD_FILE = /^([0-9]{8}-[a-z0-9][a-z0-9-]{0,49})\.json$/
/** A name in a `runs` directory whose id is taken: a record, or one set aside as corrupt. */
const TAKEN_FILE = /^([0-9]{8}-[a-z0-9][a-z0-9-]{0,49})\.json(?:\.corrupt-\d+)?$/
/** Files are opened without following a link in the last place of the path: a link there isn't one of ours. */
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0

function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** What is wrong with `value` as a Run, or undefined. */
export function runProblem(value: unknown): string | undefined {
  if (!isObject(value)) return 'a run must be an object'
  if (typeof value.id !== 'string' || !RUN_ID.test(value.id)) return 'id must be <yyyymmdd>-<slug>'
  if (typeof value.project !== 'string') return 'project must be owner/repo'
  try {
    splitProject(value.project)
  } catch {
    return 'project must be owner/repo'
  }
  if (typeof value.slug !== 'string' || !SLUG.test(value.slug)) return 'slug must be 1 to 40 of a-z, 0-9 and "-"'
  if (typeof value.goal !== 'string') return 'goal must be a string'
  if (value.plan !== undefined && !(isObject(value.plan) && isText(value.plan.path) && isText(value.plan.commit))) {
    return 'plan must be { path, commit }, both non-empty strings'
  }
  if (!isText(value.branch)) return 'branch must be a non-empty string'
  if (!isText(value.worktree) || !isAbsolute(value.worktree)) return 'worktree must be an absolute path'
  if (!isText(value.base)) return 'base must be a non-empty string'
  if (!isText(value.baseCommit)) return 'baseCommit must be a non-empty string'
  if (typeof value.state !== 'string' || !(RUN_STATES as readonly string[]).includes(value.state)) return `state must be one of ${RUN_STATES.join(', ')}`
  if (value.pr !== undefined && !(isObject(value.pr) && isText(value.pr.url) && Number.isSafeInteger(value.pr.number) && (value.pr.number as number) > 0)) {
    return 'pr must be { url, number }: a non-empty string and a whole number above 0'
  }
  if (value.state === 'pr' && value.pr === undefined) return 'a run in state pr must have its pr'
  if (value.reason !== undefined && typeof value.reason !== 'string') return 'reason must be a string'
  if (value.reason !== undefined && value.state !== 'abandoned') return 'only an abandoned run has a reason'
  if (!isObject(value.driver) || typeof value.driver.session !== 'string' || !isTime(value.driver.since)) {
    return 'driver must be { session, since }: a string (\'\' when released) and a time'
  }
  if (!isTime(value.openedAt)) return 'openedAt must be a time'
  if (value.closedAt !== undefined && !isTime(value.closedAt)) return 'closedAt must be a time'
  if (value.state === 'open' && value.closedAt !== undefined) return 'an open run has no closedAt'
  if (value.state !== 'open' && value.closedAt === undefined) return `a run in state ${value.state} must have its closedAt`
  return undefined
}

/** Folded to one line, masked, and cut. */
function cleanLine(text: string, max: number): string {
  return cut(oneLine(maskSecrets(oneLine(text))), max)
}

/**
 * `run` with its free text made safe to keep: `goal` and `reason` folded, masked and cut, `plan.path` masked. Fields that
 * aren't strings are left for `runProblem` to refuse.
 */
function cleaned(run: Run): Run {
  const result: Run = { ...run }
  if (typeof result.goal === 'string') result.goal = cleanLine(result.goal, GOAL_MAX)
  if (typeof result.reason === 'string') result.reason = cleanLine(result.reason, REASON_MAX)
  if (isObject(result.plan) && typeof result.plan.path === 'string') result.plan = { ...result.plan, path: maskSecrets(result.plan.path) }
  return result
}

/** Flush a directory's entries to disk, if the platform lets us: a rename is only durable once its directory is. */
async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch {
    // Best effort: the file is written and in place; this only narrows what a power cut can undo.
  }
}

/**
 * Write `text` as `file`, replacing any: a temp file in the same directory, synced, then renamed over it, then the
 * directory synced. The directory is created (mode 0o700) if it isn't there; the file is mode 0o600.
 */
async function writeAtomic(file: string, text: string): Promise<void> {
  const directory = dirname(file)
  const temp = join(directory, `.${basename(file)}.${randomBytes(8).toString('hex')}.tmp`)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  // Outside the try: if `open` fails nothing of ours was created (on EEXIST the file isn't ours to remove).
  const handle = await open(temp, 'wx', 0o600)
  try {
    try {
      await handle.writeFile(text)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temp, file)
  } catch (error) {
    await unlink(temp).catch(() => {})
    throw error
  }
  await syncDirectory(directory)
}

/** The entries of `directory`, or none when it isn't there or isn't a directory. */
async function listing(directory: string): Promise<Dirent[]> {
  try {
    return await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') return []
    throw error
  }
}

/** The text of `file`, opened without following a link; `undefined` when it is gone, a link, or not a plain file. */
async function readRecord(file: string): Promise<string | undefined> {
  let handle
  try {
    handle = await open(file, constants.O_RDONLY | NO_FOLLOW)
  } catch (error) {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ELOOP') return undefined
    throw error
  }
  try {
    if (!(await handle.stat()).isFile()) return undefined
    return await handle.readFile('utf8')
  } finally {
    await handle.close()
  }
}

function copy(run: Run): Run {
  return structuredClone(run)
}

/** `value` as plain JSON: what the file will hold, so that the copy in memory is the same (a field set to `undefined` goes). @throws TypeError if it isn't JSON. */
function plain<T>(value: T): T {
  try {
    return JSON.parse(JSON.stringify(value)) as T
  } catch (error) {
    throw new TypeError(`not a run: it isn't plain JSON (${error instanceof Error ? error.message : String(error)})`)
  }
}

function messageOf(error: unknown): string {
  return maskSecrets(error instanceof Error ? error.message : String(error))
}

/** Told about a record `load` didn't take: where it was, where it went (`''`: left where it is), and why. */
export type OnCorrupt = (file: string, aside: string, problem?: string) => void

/** The run records under one state directory. It needn't exist yet: the first write creates it. */
export class RunStore {
  readonly #state: string
  readonly #onCorrupt: OnCorrupt
  readonly #now: () => number
  /** The records, by their file. */
  #runs = new Map<string, Run>()
  #loaded = false
  #loading: Promise<void> | undefined
  /** The tail of each project's queue, until it's done. */
  readonly #queues = new Map<string, Promise<void>>()

  /**
   * @param state - dish's state directory (`xdgPaths('dish').state`). Made absolute.
   * @param options.onCorrupt - told when `load` set a corrupt record aside, with where it was, where it went and why; or
   *   when it skipped one it couldn't read or set aside, with `aside` `''` (left where it is) and the error. A callback that
   *   throws is ignored.
   * @param options.now - the time, in milliseconds: a new run's `openedAt` when none is given, and a corrupt record's suffix.
   */
  constructor(state: string, options: { onCorrupt?: OnCorrupt, now?: () => number } = {}) {
    this.#state = resolve(state)
    this.#onCorrupt = options.onCorrupt ?? (() => {})
    this.#now = options.now ?? Date.now
  }

  /** Run `job` after what is queued for `key`, whether that worked or not, and give what it gives. */
  #serial<T>(key: string, job: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(key) ?? Promise.resolve()
    const run = previous.then(job)
    const tail = run.then(() => {}, () => {})
    this.#queues.set(key, tail)
    void tail.then(() => {
      if (this.#queues.get(key) === tail) this.#queues.delete(key)
    })
    return run
  }

  #ready(): void {
    if (!this.#loaded) throw new Error(NOT_LOADED)
  }

  /** Read every record once. Later calls give the same promise; a call after a failed one tries again. */
  load(): Promise<void> {
    if (this.#loading === undefined) {
      const loading = this.#readAll().then(runs => {
        this.#runs = runs
        this.#loaded = true
      })
      this.#loading = loading
      loading.catch(() => {
        if (this.#loading === loading) this.#loading = undefined
      })
    }
    return this.#loading
  }

  /** Every record under `<state>/orchestrator/<owner>/<repo>/runs/`, one level at a time, never through a link. */
  async #readAll(): Promise<Map<string, Run>> {
    const runs = new Map<string, Run>()
    const root = recordsRoot(this.#state)
    for (const owner of await listing(root)) {
      if (!owner.isDirectory() || !SEGMENT.test(owner.name)) continue
      for (const repo of await listing(join(root, owner.name))) {
        if (!repo.isDirectory() || !SEGMENT.test(repo.name)) continue
        const project = `${owner.name}/${repo.name}`
        const place = await listing(join(root, owner.name, repo.name))
        if (!place.some(entry => entry.name === RUNS_DIRECTORY && entry.isDirectory())) continue
        const directory = runsDirectory(this.#state, project)
        for (const entry of await listing(directory)) {
          const id = entry.isFile() ? RECORD_FILE.exec(entry.name)?.[1] : undefined
          if (id === undefined) continue
          const file = join(directory, entry.name)
          try {
            const text = await readRecord(file)
            if (text === undefined) continue
            const parsed = this.#parse(text, project, id)
            if ('problem' in parsed) await this.#setAside(file, parsed.problem)
            else runs.set(file, parsed.run)
          } catch (error) {
            // One record is not every run: it is skipped where it is (its name still holds its id), and the rest load.
            this.#tell(file, '', messageOf(error))
          }
        }
      }
    }
    return runs
  }

  /** The run in `text`, if it is one and sits where it should (`project`'s directory, under its own id); else why not. */
  #parse(text: string, project: string, id: string): { run: Run } | { problem: string } {
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      return { problem: 'it isn\'t JSON' }
    }
    const problem = runProblem(value)
    if (problem !== undefined) return { problem: maskSecrets(problem) }
    const run = value as Run
    if (run.project !== project || run.id !== id) return { problem: 'it names another run than the one its place is for' }
    return { run }
  }

  /** Rename a corrupt record `<file>.corrupt-<ms>`, and tell. @throws what the rename throws. */
  async #setAside(file: string, problem: string): Promise<void> {
    const aside = `${file}.corrupt-${this.#now()}`
    await rename(file, aside)
    this.#tell(file, aside, problem)
  }

  #tell(file: string, aside: string, problem: string): void {
    try {
      this.#onCorrupt(file, aside, problem)
    } catch {
      // The store carries on; a caller whose logger broke can't ask it to stop.
    }
  }

  /** `project` compared without case; newest openedAt first. */
  list(project?: string): Run[] {
    this.#ready()
    const runs = [...this.#runs.values()].filter(run => project === undefined || sameProject(run.project, project))
    return runs.sort((a, b) => b.openedAt - a.openedAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)).map(copy)
  }

  /** The run `id` of `project` (compared without case; an exact match first). */
  get(project: string, id: string): Run | undefined {
    this.#ready()
    const found = this.#find(project, id)
    return found === undefined ? undefined : copy(found)
  }

  #find(project: string, id: string): Run | undefined {
    if (typeof project !== 'string' || typeof id !== 'string') return undefined
    let loose: Run | undefined
    for (const run of this.#runs.values()) {
      if (run.id !== id || !sameProject(run.project, project)) continue
      if (run.project === project) return run
      loose ??= run
    }
    return loose
  }

  /** The runs with this id, in every project. */
  byId(id: string): Run[] {
    this.#ready()
    return [...this.#runs.values()].filter(run => run.id === id).map(copy)
  }

  /** The open run `sessionId` drives; when more than one says so (another process wrote), the newest driver.since. `''` drives nothing. */
  drivenBy(sessionId: string): Run | undefined {
    this.#ready()
    if (typeof sessionId !== 'string' || sessionId === '') return undefined
    let found: Run | undefined
    for (const run of this.#runs.values()) {
      if (run.state !== 'open' || run.driver.session !== sessionId) continue
      if (found === undefined || run.driver.since > found.driver.since) found = run
    }
    return found === undefined ? undefined : copy(found)
  }

  /** Assign the id (`runId`) and write the record, through the project's queue. @throws TypeError for fields runProblem refuses. */
  async create(fields: NewRun): Promise<Run> {
    this.#ready()
    if (!isObject(fields)) throw new TypeError('not a new run: it must be an object')
    const openedAt = fields.openedAt ?? this.#now()
    const draft = (id: string): Run => cleaned(plain({
      id,
      project: fields.project,
      slug: fields.slug,
      goal: fields.goal,
      ...(fields.plan === undefined ? {} : { plan: { path: fields.plan.path, commit: fields.plan.commit } }),
      branch: fields.branch,
      worktree: fields.worktree,
      base: fields.base,
      baseCommit: fields.baseCommit,
      state: 'open',
      driver: { session: fields.driver, since: openedAt },
      openedAt,
    }))
    // Checked before the queue, with the id the day would give first, so a refusal writes nothing.
    const problem = runProblem(draft(runId(fields.slug, openedAt, () => false)))
    if (problem !== undefined) throw new TypeError(`not a new run: ${problem}`)
    const project = fields.project
    return this.#serial(project, async () => {
      const directory = runsDirectory(this.#state, project)
      const listed = new Set<string>()
      for (const entry of await listing(directory)) {
        const id = TAKEN_FILE.exec(entry.name)?.[1]
        if (id !== undefined) listed.add(id)
      }
      const id = runId(fields.slug, openedAt, candidate => listed.has(candidate) || this.#find(project, candidate) !== undefined)
      const run = draft(id)
      const file = recordFile(this.#state, project, id)
      await writeAtomic(file, `${JSON.stringify(run, null, 2)}\n`)
      this.#runs.set(file, run)
      return copy(run)
    })
  }

  /**
   * `change` gets a copy and returns the new run, or undefined for no change. Through the project's queue. Gives the run as
   * written, or undefined when `change` made none or the store has no such run.
   * @throws TypeError for a result runProblem refuses, or one with another id or project. Nothing is written then.
   */
  async update(project: string, id: string, change: (run: Run) => Run | undefined): Promise<Run | undefined> {
    this.#ready()
    const found = this.#find(project, id)
    if (found === undefined) return undefined
    return this.#serial(found.project, async () => {
      const file = recordFile(this.#state, found.project, found.id)
      const current = this.#runs.get(file)
      if (current === undefined) return undefined
      const changed = change(copy(current))
      if (changed === undefined) return undefined
      if (!isObject(changed)) throw new TypeError('not a run: the change must give an object')
      const next = cleaned(plain(changed))
      const problem = runProblem(next)
      if (problem !== undefined) throw new TypeError(`not a run: ${problem}`)
      if (next.id !== current.id || next.project !== current.project) {
        throw new TypeError(`a change can't move run ${current.project}/${current.id} to ${next.project}/${next.id}`)
      }
      const stored = copy(next)
      await writeAtomic(file, `${JSON.stringify(stored, null, 2)}\n`)
      this.#runs.set(file, stored)
      return copy(stored)
    })
  }

  /** Resolve once every write queued now is done. Never rejects. */
  async flush(): Promise<void> {
    await Promise.all([...this.#queues.values()])
  }
}
