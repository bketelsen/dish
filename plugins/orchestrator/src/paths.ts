/**
 * Where runs and their ledgers live, and what a run's id and ref look like.
 *
 * ```
 * <state>/orchestrator/<owner>/<repo>/runs/<id>.json      a run's record (store.ts)
 * <data>/ledgers/<owner>/<repo>/<id>.jsonl                 its ledger (ledger.ts)
 * ```
 *
 * Every part of a path is checked here, not trusted from a caller: owner and repo are each one `SEGMENT`, a slug a `SLUG`
 * and an id a `RUN_ID`, and anything else is a `TypeError` before a path is joined. orchestrator imports no runtime code
 * from dish-workspaces, so its rules are copied here.
 *
 * @module dish-orchestrator/paths
 */

import { join } from 'node:path'

/** One path segment: letters, digits, `.`, `_` and `-`, and not `.` or `..`. */
export const SEGMENT = /^(?!\.{1,2}$)[A-Za-z0-9._-]+$/
/** A worktree's (and a run's) slug: dish-workspaces' rule (its worktrees module's `SLUG`), copied. */
export const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/
/** Whether two `owner/repo` names are the same project: GitHub's names don't tell case apart. */
export function sameProject(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

/** `<yyyymmdd>-<slug>`, with `-2`, `-3`, … when the day's slug was taken. */
export const RUN_ID = /^[0-9]{8}-[a-z0-9][a-z0-9-]{0,49}$/

/** The directory under `<state>` that holds every run's record. */
const RECORDS = 'orchestrator'
/** The directory of a project that holds its records. */
const RUNS = 'runs'
/** The directory under `<data>` that holds every ledger. */
const LEDGERS = 'ledgers'

/** `owner/repo` split; throws TypeError unless both are a SEGMENT. */
export function splitProject(project: string): { owner: string, repo: string } {
  const parts = typeof project === 'string' ? project.split('/') : []
  if (parts.length !== 2 || !SEGMENT.test(parts[0]!) || !SEGMENT.test(parts[1]!)) {
    throw new TypeError(`${JSON.stringify(typeof project === 'string' ? project : String(project))} isn't a project name: owner/repo`)
  }
  return { owner: parts[0]!, repo: parts[1]! }
}

function checkId(id: string): string {
  if (typeof id !== 'string' || !RUN_ID.test(id)) throw new TypeError(`${JSON.stringify(String(id))} isn't a run id: <yyyymmdd>-<slug>`)
  return id
}

/** `<state>/orchestrator`: where `RunStore.load` starts. */
export function recordsRoot(state: string): string {
  return join(state, RECORDS)
}

/** `<state>/orchestrator/<owner>/<repo>/runs`. @throws TypeError for a project that fails splitProject. */
export function runsDirectory(state: string, project: string): string {
  const { owner, repo } = splitProject(project)
  return join(state, RECORDS, owner, repo, RUNS)
}

/** The name of a project's records directory, under `<state>/orchestrator/<owner>/<repo>`. */
export const RUNS_DIRECTORY = RUNS

/** `<state>/orchestrator/<owner>/<repo>/runs/<id>.json`. @throws TypeError for a project that fails splitProject or an id that isn't RUN_ID. */
export function recordFile(state: string, project: string, id: string): string {
  return join(runsDirectory(state, project), `${checkId(id)}.json`)
}

/** `<data>/ledgers/<owner>/<repo>/<id>.jsonl`. @throws TypeError as recordFile does. */
export function ledgerFile(data: string, project: string, id: string): string {
  const { owner, repo } = splitProject(project)
  return join(data, LEDGERS, owner, repo, `${checkId(id)}.jsonl`)
}

/** `${owner}/${repo}/${id}`: what a child is tagged with. @throws TypeError as recordFile does. */
export function runRef(project: string, id: string): string {
  const { owner, repo } = splitProject(project)
  return `${owner}/${repo}/${checkId(id)}`
}

/** A ref's project and id, or `undefined` for anything that isn't `<owner>/<repo>/<id>` with each part valid. */
export function parseRef(ref: unknown): { project: string, id: string } | undefined {
  if (typeof ref !== 'string') return undefined
  const parts = ref.split('/')
  if (parts.length !== 3) return undefined
  const [owner, repo, id] = parts as [string, string, string]
  if (!SEGMENT.test(owner) || !SEGMENT.test(repo) || !RUN_ID.test(id)) return undefined
  return { project: `${owner}/${repo}`, id }
}

/** The UTC date of `at` as `yyyymmdd`. @throws TypeError if `at` names no date with a four-digit year. */
function dateOf(at: number): string {
  const date = new Date(at)
  const day = typeof at === 'number' && !Number.isNaN(date.getTime()) ? date.toISOString().slice(0, 10) : ''
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new TypeError(`${String(at)} isn't a time a run id can be dated by`)
  return day.replaceAll('-', '')
}

/** How many suffixes `runId` tries before it gives up: a day's slug taken this often is something else going wrong. */
const MAX_SUFFIX = 10_000

/**
 * `<yyyymmdd>-<slug>` (the UTC date of `at`), else `-2`, `-3`, … : the first that `taken` refuses.
 * @throws TypeError for a slug that isn't a SLUG or an `at` with no date; Error if 10,000 are taken.
 */
export function runId(slug: string, at: number, taken: (id: string) => boolean): string {
  if (typeof slug !== 'string' || !SLUG.test(slug)) throw new TypeError(`${JSON.stringify(String(slug))} isn't a slug: 1 to 40 of a-z, 0-9 and "-"`)
  const first = `${dateOf(at)}-${slug}`
  if (!taken(first)) return first
  for (let suffix = 2; suffix <= MAX_SUFFIX; suffix++) {
    const id = `${first}-${suffix}`
    if (!taken(id)) return id
  }
  throw new Error(`every run id from ${first} to ${first}-${MAX_SUFFIX} is taken`)
}
