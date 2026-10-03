/**
 * The `dishWorkspaces` service: the modules of dish-workspaces composed behind one lock per project, with the hourly
 * round, the read tokens and the workspace registry.
 *
 * - **One lock per project** (`KeyedLock`, keyed by the name lower-cased): `onboard`, `prepare`, `createWorktree`,
 *   `removeWorktree`, the sweep (with the fetch before it) and a late workspace registration never overlap in one clone.
 *   A job holds the lock until its work has settled, child processes included: an abort kills them (git's process
 *   group, setup's TERM then KILL), and the lock is released only once they are gone. The fetch `Worktrees` asks for runs
 *   inside the caller's job and never takes the lock itself. `resolve`, `listWorktrees` and `describe` don't lock.
 * - **Projects** are read from `dishProjects` (`ctx.get`) on each use: `createWorktree` takes only a ready project, and
 *   only from a chat with a workspace (`cwd`), which `Worktrees.create` checks is the clone or inside it.
 * - **`describe`** is synchronous: it answers from an in-memory copy of each clone's state (`clone.json`), loaded at
 *   `start` and read again after every operation that writes it.
 * - **The App's credentials** are read with `ctx.get('credentials')?.resolve(ref)` for every request that needs the JWT,
 *   and never kept. The bot identity (`GET /app`, then the public `GET /users/<slug>[bot]`, which GitHub limits to 60 an
 *   hour per address without a credential) is looked up once per service life, and again after either credential changes.
 * - **The App's status** (`appStatus`, for Settings → GitHub App): a test is `GET /app`, the installations and the bot's
 *   public profile, made with the credentials read for that one test and dropped after it. Its answer is remembered until
 *   either credential changes (`credentialsChanged`); a test that was under way when one did is not remembered. The answer
 *   has neither credential, and the texts in it have the App's ID and the lines of the key taken out as well as masked.
 * - **The read tokens:** the owner map (each owner's installation and the repos of its projects whose clone state names
 *   an installation) is recomputed at start, on `dish-projects/changed` and after each onboarding, one recompute at a
 *   time; onboarding's own addition of a new repo goes through the same queue, and only adds.
 * - **The workspace registry** (`useRegistry`, from the plugin's `ctx.inject(['workspaceRegistry'])`): each time one
 *   appears, the scratch workspace (once, by its record) and every ready project whose clone state has no workspace,
 *   each under its project's lock. A project whose onboarding found no registry at its last step is registered when
 *   dish-projects records it ready (`registerIfMissing`, on `dish-projects/status`), and a prepare registers one too.
 *   Every registration checks the signal, and that the project is still ready, inside the lock: a project removed while
 *   it onboarded, or while it waited for the lock, never gets a workspace.
 * - **The hourly round:** first `firstRoundMs` after `start`, then every `roundEveryMs`: per ready project, one at a time,
 *   under its lock: its fetch (which makes sure of its read token first), then the sweep. A round never overlaps the one
 *   before (a tick while one runs is skipped). A failure is logged once per project and error, and the round goes on.
 *   After `createWorktree` and `prepare` (each fetched), that project's sweep runs in the background. Only a project
 *   that is still ready once it has its lock is fetched and swept: one removed after the round listed it, or while a
 *   prepare of it ran, is left alone.
 * - **`close`:** no more work is taken; every timer is cleared; everything in flight is aborted and awaited (its children
 *   dead), and rejects with an Error named `AbortError` (dish-projects leaves such a project pending, never failed); then
 *   the token files are removed (`TokenManager.close`).
 * - **Step 7, for dish-orchestrator:** `headOf` and `isClean` (no lock); `pushBranch` and `compareBranch` (under the
 *   project's lock: a push, and a fetch); `openPull`, `updatePull` and `commentPull` (no lock; each mints a write token
 *   in memory for its one call, as `pushBranch` does); `readPull` (no lock; the in-memory API token). What `readPull`
 *   brings from GitHub is untrusted: every string is masked and capped where it is read.
 * - **The run hooks** (`dishRuns`, read with `ctx.get` on each use; everything works as before without it): the sweep
 *   tells `worktreeRemoved` of each worktree it removed, once the project's lock is released; the `worktree` tool (not
 *   the service) tells `worktreeCreated` and `worktreeRemoved` of its own. No hook is called, or awaited, while a
 *   project's lock is held: `open_pr` holds a run's lock while `pushBranch` waits for the project's.
 *
 * @module dish-workspaces/service
 */

import { readFileSync, readdirSync, realpathSync } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { DishProjects } from 'dish-projects'
import type { Project } from 'dish-projects/registry'
import { maskSecrets, workRoot as defaultWorkRoot, xdgPaths } from 'dish-kit'
import { configureClone, defaultBranch, fetchClone, httpsUrl } from './clone.ts'
import type { CloneDeps } from './clone.ts'
import { SHA, maskUrlPasswords, shown } from './git.ts'
import { GITHUB_API, GITHUB_WEB, GitHubApp, GitHubError, PULL_PERMISSIONS, PUSH_PERMISSIONS, botIdentity } from './github.ts'
import type { AppCredentials, GitHubClientOptions, PullDetails, PullSummary, RawList } from './github.ts'
import { hiding } from './hiding.ts'
import { KeyedLock } from './locks.ts'
import { appIdentity, onboardProject } from './onboard.ts'
import type { OnboardDeps, OnboardResult, OnboardStep } from './onboard.ts'
import { cloneStateFile, clonePath, helperValue, projectStateDir, scratchRecordFile, tokensDir } from './paths.ts'
import type { AppStatus } from './protocol.ts'
import { pushIsolated } from './push.ts'
import { registerWorkspace } from './registry.ts'
import type { WorkspaceRegistryLike } from './registry.ts'
import { ensureScratch } from './scratch.ts'
import { parseCloneState, readCloneState, writeCloneState } from './state.ts'
import type { CloneState } from './state.ts'
import { sweepProject } from './sweep.ts'
import type { SweepResult } from './sweep.ts'
import { TokenManager } from './tokens.ts'
import type { OwnerRepos, TokenManagerOptions } from './tokens.ts'
import { SLUG, Worktrees } from './worktrees.ts'
import type { Binding, BranchComparison, CreatedWorktree, Worktree, WorktreeDeps, WorktreeInfo } from './worktrees.ts'

/** The first hourly round runs this long after `start`. */
export const FIRST_ROUND_MS = 300_000
/** Then one every hour. */
export const ROUND_EVERY_MS = 3_600_000

export interface CloneInfo {
  /** The clone's path. */
  clone: string
  /** Whether dish adopted a clone it found there. */
  adopted: boolean
  /** The workspace dish registered for the clone, as dsh's registry has it now; null when there is none (or no registry to ask). */
  workspace: { id: string, title: string } | null
  lastFetch: { at: number, ok: boolean, message?: string } | null
  /** How many worktrees dish made in it (their records). */
  worktrees: number
}

/**
 * What dish-workspaces reads of dish-orchestrator (dishRuns), structurally: neither package depends on the other. The
 * `worktree` tool calls worktreeCreated after createWorktree returned, and worktreeRemoved after its remove; the sweep calls
 * worktreeRemoved for each worktree it removed. None is called, or awaited, while a project's lock is held.
 */
export interface CreatedForRun {
  project: string
  slug: string
  branch: string
  path: string
  clone: string
  /** The commit it was cut from. */
  base: string
  /** The base as asked for (`origin/<default>`, or the `base` given). */
  baseRef: string
}

export interface RunsHooks {
  /** `released`, with `opened`: the id of the run the chat drove in another project, which opening this one released. */
  worktreeCreated(sessionId: string, created: CreatedForRun): Promise<{ id: string, opened: boolean, released?: string } | undefined>
  worktreeRemoved(project: string, slug: string): Promise<void>
}

/** What openPull gives: the pull request, and whether it was open already (and so left as it was). */
export interface OpenedPull {
  url: string
  number: number
  existing: boolean
}

/** What readPull gives: every string masked and capped (masked, control characters made spaces, bodies 4000, the rest 200). */
export interface PullFeedback {
  number: number
  url: string
  title: string
  state: 'open' | 'closed'
  merged: boolean
  draft: boolean
  /** null: GitHub hasn't computed it yet. */
  mergeable: boolean | null
  /** GitHub's mergeable_state: clean, dirty, behind, blocked, unstable, unknown, … */
  mergeableState: string
  head: { ref: string, sha: string }
  base: { ref: string }
  reviews: Array<{ author: string, state: string, body: string, at: string | null, commit: string | null }>
  reviewComments: Array<{ path: string, line: number | null, author: string, body: string, outdated: boolean, at: string | null }>
  issueComments: Array<{ author: string, body: string, at: string | null }>
  checks: Array<{ name: string, source: 'check-run' | 'status', status: string, conclusion: string | null }>
  /**
   * Why the checks couldn't be read (wholly or in part: `checks` holds what the other source gave): the token lacks
   * Checks or Commit statuses read, or GitHub failed ("could not read the checks: …", masked and cut).
   */
  checksUnavailable?: string
  /**
   * Which lists GitHub has more of: the reviews and the comments are each the newest 100 (GitHub's last pages), so for them
   * older ones weren't read; the checks are the first 100, so for them a page was full.
   */
  more: { reviews: boolean, reviewComments: boolean, issueComments: boolean, checks: boolean }
}

export type { BranchComparison }

/** How many untracked paths `isClean` names, with `{ untracked: 'ignore' }`, before `and <n> more`. */
export const UNTRACKED_NAMED = 20

/** `isClean`'s options: `untracked: 'ignore'` lets a worktree with only untracked files be clean (and names them). */
export interface CleanOptions {
  untracked?: 'ignore'
}

/** What `isClean` gives. `untracked` only with `{ untracked: 'ignore' }`, and only when there are untracked files. */
export type Cleanliness = { clean: true, untracked?: string[] } | { clean: false, why: string }

export interface DishWorkspaces {
  /** Onboarding's steps 1 to 5 (onboard.ts), under the project's lock. */
  onboard(project: Project, options?: { signal?: AbortSignal, progress?: (step: OnboardStep) => void }): Promise<OnboardResult>
  /**
   * For a ready project at start: step 3 again (the helper path, the identity, the safety check), then its fetch; and its
   * workspace, if it has none and a registry is there. It fails only when the clone is gone ("the clone at <path> is
   * gone; press Retry on Settings → Projects to clone it again") or can't be configured or checked: a bot identity GitHub
   * can't give (the network not up yet) leaves the clone's own, and a failed fetch is in `lastFetch`; each is logged
   * once. A project that is no longer ready once it is configured (removed meanwhile) isn't fetched.
   */
  prepare(project: Project): Promise<void>
  /** What dish knows of `name`'s clone, from memory; undefined for a project with no clone state. */
  describe(name: string): CloneInfo | undefined
  createWorktree(project: string, slug: string, base?: string, options?: { cwd?: string, signal?: AbortSignal }): Promise<CreatedWorktree>
  /** One project's worktrees, or every ready project's. */
  listWorktrees(project?: string): Promise<WorktreeInfo[]>
  removeWorktree(project: string, slug: string, force?: boolean): Promise<void>
  /** For delegate and gates: `<project>/<slug>`, or a worktree's path (any spelling: crew's records are canonical); a worktree dish made, of a registered project. */
  resolve(pathOrRef: string): Promise<Worktree | undefined>
  /**
   * For a refusal's words, after `resolve` gave `undefined`: why, for a worktree dish made whose clone or worktree fails
   * dish's safety check, or whose branch is gone (`Worktrees.problem`); `undefined` for anything else.
   */
  resolveProblem(pathOrRef: string): Promise<string | undefined>
  /** Fetch, then sweep, one project or every ready one. A project that isn't ready (by the time it has its lock) is neither. */
  sweep(project?: string): Promise<SweepResult>
  /**
   * What GitHub says of the App, for Settings → GitHub App. `test` makes the test (`GET /app`, the installations, the bot) and
   * remembers its answer; without it the last answer is given from memory, and a test is made when there is none. A change to
   * either credential forgets the memory. The answer holds neither credential, and every text in it is masked. Never rejects
   * but for a service that has stopped.
   */
  appStatus(test: boolean): Promise<AppStatus>
  /** HEAD's commit in the worktree; undefined when resolve gives none. Rejects when git can't say. No lock. */
  headOf(pathOrRef: string): Promise<string | undefined>
  /**
   * Whether the worktree has nothing a commit would lose, on its own branch: nothing uncommitted or untracked, `dish/<slug>`
   * checked out, no nested worktree or repository. Rejects when resolve gives none, or git can't say. No lock.
   *
   * With `{ untracked: 'ignore' }` (open_pr's, since a gate may leave output git doesn't ignore), untracked files don't
   * count: a worktree whose only change is untracked files is `{ clean: true, untracked }`, their paths relative, masked,
   * at most `UNTRACKED_NAMED` and then `and <n> more`. A tracked change, staged or not, another branch, and a nested
   * worktree or repository (one in an untracked folder too) are still `{ clean: false, why }`.
   */
  isClean(pathOrRef: string, options?: CleanOptions): Promise<Cleanliness>
  /**
   * Push dish/<slug> of a worktree dish made, at `head` only, to the project's HTTPS URL, with a write token minted for
   * this call, from an isolated repository, never forced. Under the project's lock. Rejects with GitHub's reason, masked.
   */
  pushBranch(project: string, slug: string, options: { head: string, signal?: AbortSignal }): Promise<{ head: string }>
  /** Open the pull request from `head` (dish/<slug>) to the project's default branch, or report the open one, unchanged. No lock. */
  openPull(project: string, pull: { head: string, title: string, body: string }): Promise<OpenedPull>
  /** Comment on pull request `number` of the project (its issue comments), with a write token minted for this call. No lock. */
  commentPull(project: string, number: number, body: string): Promise<void>
  /** Change pull request `number`'s title, body or both (at least one), with a write token minted for this call. No lock. */
  updatePull(project: string, number: number, fields: { title?: string, body?: string }): Promise<void>
  /**
   * Fetch (dish's own git, as the sweep's), then compare dish/<slug> with origin/<default> and origin/dish/<slug>. Under
   * the project's lock. Read-only on the worktree.
   */
  compareBranch(project: string, slug: string): Promise<BranchComparison>
  /**
   * Pull request `number`'s feedback, read with the in-memory API token: its newest 100 reviews, review comments and
   * comments (GitHub's last pages), and the first 100 checks of each source. Untrusted: masked and capped here. No lock.
   */
  readPull(project: string, number: number): Promise<PullFeedback>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    dishWorkspaces: DishWorkspaces
  }
}

/** For tests only; never config. */
export interface WorkspacesInternals {
  workRoot?: string
  state?: string
  /** GitHub's API (the fake's). */
  api?: string
  /** GitHub's web origin (the fake git server's). */
  web?: string
  /** The credential helper's path. */
  helper?: string
  /** The App client's `fetch`. */
  fetch?: typeof fetch
  /** The clock of the sweep's recent-resolve guard. */
  now?: () => number
  /** The hourly round's timers and the token refreshes'. */
  timers?: TokenManagerOptions['timers']
  firstRoundMs?: number
  roundEveryMs?: number
}

export interface WorkspacesConfig {
  /** The credential reference of the App's id. */
  appIdName: string
  /** The credential reference of the App's private key. */
  privateKeyName: string
}

export interface WorkspacesService extends DishWorkspaces {
  /** Load the clone states, recompute the tokens and prune stale token files, and set the first round. Not awaited. */
  start(): void
  /** Stop: see the module's notes. Safe to call twice. */
  close(): Promise<void>
  /** dsh's workspace registry appeared: use it until the returned function is called. */
  useRegistry(registry: WorkspaceRegistryLike): () => void
  /**
   * `dish-projects/status` said `name` is ready: register its workspace if its clone state has none and a registry is
   * there (a registry that appeared after its onboarding's last step looked, and before dish-projects recorded it ready).
   * Under its lock; a project no longer ready by then gets none. In the background; a failure is logged once.
   */
  registerIfMissing(name: string): void
  /** `dish-projects/changed` (with the names it carries, which the recompute doesn't need): recompute the owner map. */
  projectsChanged(names?: readonly string[]): void
  /** `credentials/reference-updated`: look the bot identity up again if `ref` is one of the App's. */
  credentialsChanged(ref: string): void
  /** Resolves when nothing is in flight. For tests. */
  idle(): Promise<void>
}

/** What dish-workspaces reads of crew (`dishCrew`), structurally: crew doesn't depend on it, nor it on crew. */
interface CrewReader {
  worktreeBindings(path: string): Promise<Array<{ child: string, role: string, title: string, running: boolean }>>
}

type Identity = { name: string, email: string }

/** The most bots (one per App slug) whose lookup is kept. */
const MAX_BOTS = 16

/** The longest error text a log line carries. */
const LOGGED_CHARS = 300
/** The longest error text from GitHub or git an error of the step-7 calls carries. */
const MESSAGE_CHARS = 400
/** A pull request's head branch: `dish/<slug>`. */
const PULL_HEAD = /^dish\/([a-z0-9][a-z0-9-]{0,39})$/
/** GitHub's limits on a pull request's title and on a body or a comment, in characters. */
const MAX_TITLE = 256
const MAX_BODY = 65_536
/** The largest pull request number taken (GitHub's are 32-bit). */
const MAX_PULL_NUMBER = 2 ** 31 - 1
/** What readPull keeps of what GitHub says: bodies, and every other string, in characters; and items per list. */
const FEEDBACK_BODY_CHARS = 4000
const FEEDBACK_TEXT_CHARS = 200
const FEEDBACK_ITEMS = 100

const defaultTimers: NonNullable<TokenManagerOptions['timers']> = {
  set(fn, ms) {
    const timer = setTimeout(fn, ms)
    timer.unref()
    return timer
  },
  clear(handle) {
    clearTimeout(handle as NodeJS.Timeout)
  },
}

/** dish's credential helper: `bin/git-credential-dish` beside this plugin's `src`, by its real path. */
function defaultHelper(): string {
  return realpathSync(fileURLToPath(new URL('../bin/git-credential-dish', import.meta.url)))
}

/** dish's push helper: `bin/git-credential-dish-push` beside this plugin's `src`, by its real path. */
function pushHelper(): string {
  return realpathSync(fileURLToPath(new URL('../bin/git-credential-dish-push', import.meta.url)))
}

/** Refuse a slug that can't name a worktree. */
function checkSlug(slug: string): void {
  if (typeof slug !== 'string' || !SLUG.test(slug)) {
    throw new Error(`${JSON.stringify(shown(String(slug), 80))} can't name a worktree: use 1 to 40 of a-z, 0-9 and "-", starting with a letter or a digit`)
  }
}

/** Refuse a number that can't be a pull request's. */
function checkPullNumber(number: number): void {
  if (!Number.isSafeInteger(number) || number <= 0 || number > MAX_PULL_NUMBER) throw new Error('a pull request number is a positive whole number')
}

/** A pull request's title as dish sends it: masked, on one line, not empty, at most 256 characters. */
function pullTitle(title: unknown): string {
  const text = maskSecrets(maskUrlPasswords(typeof title === 'string' ? title : '')).replace(/[\s\x00-\x1f\x7f]+/g, ' ').trim()
  if (text === '') throw new Error('a pull request needs a title')
  const length = Array.from(text).length
  if (length > MAX_TITLE) throw new Error(`the title is ${length} characters; GitHub takes at most 256`)
  return text
}

/** A pull request's body, or a comment, as dish sends it: masked, without NUL, at most 65 536 characters. */
function pullText(text: unknown, what: 'body' | 'comment'): string {
  const masked = maskSecrets(maskUrlPasswords(typeof text === 'string' ? text : '')).replace(/\x00/g, '')
  const length = Array.from(masked).length
  if (length > MAX_BODY) throw new Error(`the ${what} is ${length} characters; GitHub takes at most 65 536`)
  return masked
}

/**
 * Text GitHub gave (anyone can write a review or a comment): masked (`maskSecrets`, URL passwords), control characters
 * made spaces (but `\n` and `\t` in a body), and cut to `max` characters with `…`. Masked before the cut and after.
 */
function untrusted(value: string, max: number, body = false): string {
  const mask = (text: string): string => maskSecrets(maskUrlPasswords(text))
  const plain = value.slice(0, 64 * 1024).replace(body ? /[\x00-\x08\x0b-\x1f\x7f]/g : /[\x00-\x1f\x7f]/g, ' ')
  const chars = Array.from(mask(plain))
  return chars.length > max ? mask(`${chars.slice(0, max - 1).join('')}…`) : chars.join('')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A short string field of GitHub's, untrusted; `fallback` when it isn't a string. */
function textOf(value: unknown, fallback: string): string {
  return typeof value === 'string' ? untrusted(value, FEEDBACK_TEXT_CHARS) : fallback
}

/** A timestamp or an id GitHub may leave null: the string, untrusted, else null. */
function optionalText(value: unknown): string | null {
  return typeof value === 'string' ? untrusted(value, FEEDBACK_TEXT_CHARS) : null
}

/** The author of an item: `user.login`, else `unknown` (a deleted account). */
function authorOf(item: Record<string, unknown>): string {
  return isRecord(item.user) && typeof item.user.login === 'string' ? untrusted(item.user.login, FEEDBACK_TEXT_CHARS) : 'unknown'
}

/** A body GitHub may leave null (a review with no text): '' then. Undefined (the item doesn't fit) for anything else. */
function bodyOf(value: unknown): string | undefined {
  if (value === null) return ''
  return typeof value === 'string' ? untrusted(value, FEEDBACK_BODY_CHARS, true) : undefined
}

/** Reviews, as readPull gives them: a PENDING review (its author's unsent draft), and one that doesn't fit, skipped. */
function reviewsOf(list: RawList): PullFeedback['reviews'] {
  return list.items.slice(0, FEEDBACK_ITEMS).flatMap((item) => {
    if (!isRecord(item) || typeof item.state !== 'string' || item.state === 'PENDING') return []
    const body = bodyOf(item.body)
    if (body === undefined) return []
    return [{ author: authorOf(item), state: untrusted(item.state, FEEDBACK_TEXT_CHARS), body, at: optionalText(item.submitted_at), commit: optionalText(item.commit_id) }]
  })
}

/**
 * Review comments: `outdated` when GitHub cleared `line` (the diff moved past the comment). A comment on a whole file
 * (`subject_type: 'file'`) has no line and isn't outdated.
 */
function reviewCommentsOf(list: RawList): PullFeedback['reviewComments'] {
  return list.items.slice(0, FEEDBACK_ITEMS).flatMap((item) => {
    if (!isRecord(item) || typeof item.path !== 'string' || typeof item.body !== 'string') return []
    const line = typeof item.line === 'number' && Number.isFinite(item.line) ? item.line : null
    return [{
      path: untrusted(item.path, FEEDBACK_TEXT_CHARS), line, author: authorOf(item),
      body: untrusted(item.body, FEEDBACK_BODY_CHARS, true), outdated: line === null && item.subject_type !== 'file', at: optionalText(item.created_at),
    }]
  })
}

function issueCommentsOf(list: RawList): PullFeedback['issueComments'] {
  return list.items.slice(0, FEEDBACK_ITEMS).flatMap((item) => {
    if (!isRecord(item) || typeof item.body !== 'string') return []
    return [{ author: authorOf(item), body: untrusted(item.body, FEEDBACK_BODY_CHARS, true), at: optionalText(item.created_at) }]
  })
}

function checkRunsOf(list: RawList): PullFeedback['checks'] {
  return list.items.slice(0, FEEDBACK_ITEMS).flatMap((item) => {
    if (!isRecord(item) || typeof item.name !== 'string' || typeof item.status !== 'string') return []
    if (item.conclusion !== null && item.conclusion !== undefined && typeof item.conclusion !== 'string') return []
    return [{
      name: untrusted(item.name, FEEDBACK_TEXT_CHARS), source: 'check-run' as const, status: untrusted(item.status, FEEDBACK_TEXT_CHARS),
      conclusion: typeof item.conclusion === 'string' ? untrusted(item.conclusion, FEEDBACK_TEXT_CHARS) : null,
    }]
  })
}

/** A combined status's statuses: `pending` is pending; any other state is a completed check with that conclusion. */
function statusesOf(list: RawList): PullFeedback['checks'] {
  return list.items.slice(0, FEEDBACK_ITEMS).flatMap((item): PullFeedback['checks'] => {
    if (!isRecord(item) || typeof item.context !== 'string' || typeof item.state !== 'string') return []
    const name = untrusted(item.context, FEEDBACK_TEXT_CHARS)
    return item.state === 'pending'
      ? [{ name, source: 'status' as const, status: 'pending', conclusion: null }]
      : [{ name, source: 'status' as const, status: 'completed', conclusion: untrusted(item.state, FEEDBACK_TEXT_CHARS) }]
  })
}

/** Whether a failure of the check runs or the combined status means the token can't read them: a 403 or a 404. */
function cantReadChecks(error: unknown): boolean {
  return error instanceof GitHubError && ((error.kind === 'auth' && error.status === 403) || error.kind === 'not-found')
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** An error's text as a log line may carry it: one line, masked, cut short. */
function logged(error: unknown): string {
  return shown(messageOf(error), LOGGED_CHARS)
}

function isAbort(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === 'AbortError'
}

/** What a closed service rejects with: dish-projects reads the name and records nothing against the project. */
function stopped(): Error {
  const error = new Error('dish-workspaces stopped before this finished')
  error.name = 'AbortError'
  return error
}

/** The reason `signal` was aborted, as an Error named `AbortError`. */
function abortedBy(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  if (reason instanceof Error && reason.name === 'AbortError') return reason
  const error = new Error('aborted')
  error.name = 'AbortError'
  return error
}

/** Whether nothing is at `path` (a link counts as something). Another error is not "missing": what reads it next says what it is. */
async function missing(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return false
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'ENOTDIR'
  }
}

/** How many worktree records `<project state>/worktrees` holds (`<slug>.json`). */
function countRecords(names: readonly string[]): number {
  return names.filter(name => /^(.+)\.json$/.test(name) && SLUG.test(name.slice(0, -'.json'.length))).length
}

/** `current` with `extra`'s owners merged in: their installation, and the repos of both. */
function mergeOwners(current: ReadonlyMap<string, OwnerRepos>, extra: ReadonlyMap<string, OwnerRepos>): Map<string, OwnerRepos> {
  const merged = new Map(current)
  for (const [owner, entry] of extra) {
    const key = owner.toLowerCase()
    const repos = [...(merged.get(key)?.repos ?? [])]
    for (const repo of entry.repos) if (!repos.some(item => item.toLowerCase() === repo.toLowerCase())) repos.push(repo)
    merged.set(key, { installation: entry.installation, repos })
  }
  return merged
}

class Service implements WorkspacesService {
  readonly #ctx: Context
  readonly #config: WorkspacesConfig
  readonly #logger: { info(format: string, ...args: unknown[]): void, warn(format: string, ...args: unknown[]): void }
  readonly #workRoot: string
  readonly #state: string
  readonly #web: string
  readonly #helper: string
  /** bin/git-credential-dish-push, by its real path. */
  readonly #pushHelper: string
  readonly #timers: NonNullable<TokenManagerOptions['timers']>
  readonly #firstRoundMs: number
  readonly #roundEveryMs: number
  readonly #app: GitHubApp
  readonly #tokens: TokenManager
  readonly #lock = new KeyedLock()
  readonly #worktrees: Worktrees
  readonly #worktreeDeps: WorktreeDeps
  readonly #cloneDeps: CloneDeps
  readonly #closing = new AbortController()
  readonly #inFlight = new Set<Promise<unknown>>()
  /** By project name, lower-cased: the clone states, and how many worktree records each has. */
  readonly #clones = new Map<string, CloneState>()
  readonly #counts = new Map<string, number>()
  /** By topic: the last error logged, so one that repeats is one line. */
  readonly #trouble = new Map<string, string>()
  #started = false
  #closed = false
  #closingDone: Promise<void> | undefined
  #registry: WorkspaceRegistryLike | undefined
  #registryGeneration = 0
  #owners = new Map<string, OwnerRepos>()
  #tokenQueue: Promise<void> = Promise.resolve()
  #identity: Promise<Identity> | undefined
  /** The App client's options (the API's address, a test's `fetch`): the status test builds its own client with them. */
  readonly #appOptions: GitHubClientOptions
  /** The last test of the App, until a credential changes; the test under way, if any; and a count of credential changes. */
  #lastApp: AppStatus | undefined
  #appTest: Promise<AppStatus> | undefined
  #credentialsGeneration = 0
  /**
   * The bots looked up, by the App's slug. `GET /users/<slug>[bot]` is public and costs the address's 60 an hour, which
   * onboarding spends too; a bot's id never changes, so a slug is asked once (a failure is not kept), whatever else changes.
   */
  readonly #bots = new Map<string, { id: number, login: string }>()
  #roundTimer: unknown
  #round: Promise<void> | undefined

  constructor(ctx: Context, config: WorkspacesConfig, internals: WorkspacesInternals) {
    this.#ctx = ctx
    this.#config = config
    const logger = ctx.logger('dish-workspaces')
    this.#logger = {
      info: (format, ...args) => { logger.info(format, ...args) },
      warn: (format, ...args) => { logger.warn(format, ...args) },
    }
    this.#workRoot = internals.workRoot ?? defaultWorkRoot()
    this.#state = internals.state ?? xdgPaths('dish').state
    this.#web = (internals.web ?? GITHUB_WEB).replace(/\/+$/, '')
    this.#helper = internals.helper ?? defaultHelper()
    this.#pushHelper = pushHelper()
    this.#timers = internals.timers ?? defaultTimers
    this.#firstRoundMs = internals.firstRoundMs ?? FIRST_ROUND_MS
    this.#roundEveryMs = internals.roundEveryMs ?? ROUND_EVERY_MS
    this.#appOptions = { api: internals.api ?? GITHUB_API, ...(internals.fetch === undefined ? {} : { fetch: internals.fetch }) }
    // Read for every request that needs the JWT, and dropped once it is signed.
    this.#app = new GitHubApp(() => this.#readCredentials(), this.#appOptions)
    this.#tokens = new TokenManager({
      directory: tokensDir(this.#state),
      app: this.#app,
      logger: this.#logger,
      ...(internals.timers === undefined ? {} : { timers: internals.timers }),
    })
    this.#cloneDeps = { workRoot: this.#workRoot, state: this.#state, web: this.#web, helper: this.#helper, tokens: this.#tokens, logger: this.#logger }
    this.#worktreeDeps = {
      workRoot: this.#workRoot,
      state: this.#state,
      cloneExpectations: project => ({
        url: httpsUrl(this.#web, project.owner, project.repo),
        helper: helperValue(this.#helper, tokensDir(this.#state), this.#web),
        web: this.#web,
      }),
      // Inside the caller's job, which holds the project's lock: never takes it.
      fetch: (project, signal) => this.#fetch(project, signal),
      defaultBranch: async clone => (await defaultBranch(clone)) ?? 'main',
      bindings: path => this.#bindings(path),
      pulls: (project, sha) => this.#pulls(project, sha),
      ...(internals.now === undefined ? {} : { now: internals.now }),
    }
    // One for resolve, create, remove and the sweep: the recent-resolve guard is its memory.
    this.#worktrees = new Worktrees(this.#worktreeDeps)
  }

  // --- the life ------------------------------------------------------------------------------------------------------

  start(): void {
    if (this.#started || this.#closed) return
    this.#started = true
    this.#loadClones()
    this.#track((async () => {
      await this.#recomputeTokens()
      try {
        await this.#tokens.prune([...this.#owners.keys()])
      } catch (error) {
        this.#warnOnce('prune', logged(error), 'could not remove old read token files: %s', logged(error))
      }
    })())
    this.#scheduleRound(this.#firstRoundMs)
  }

  close(): Promise<void> {
    if (this.#closingDone !== undefined) return this.#closingDone
    this.#closed = true
    this.#closing.abort(stopped())
    if (this.#roundTimer !== undefined) {
      this.#timers.clear(this.#roundTimer)
      this.#roundTimer = undefined
    }
    this.#registry = undefined
    this.#registryGeneration++
    this.#closingDone = (async () => {
      await this.idle()
      await this.#tokens.close()
    })()
    return this.#closingDone
  }

  async idle(): Promise<void> {
    while (this.#inFlight.size > 0) await Promise.allSettled([...this.#inFlight])
  }

  useRegistry(registry: WorkspaceRegistryLike): () => void {
    if (this.#closed) return () => {}
    this.#registry = registry
    const generation = ++this.#registryGeneration
    // What ensureScratch has logged, for this registry's life: a reloaded registry starts clean.
    const logged = new Set<string>()
    this.#track((async () => {
      await ensureScratch({ registry, workRoot: this.#workRoot, record: scratchRecordFile(this.#state), logger: this.#logger, logged })
      await this.#registerReady(registry, generation)
    })())
    return () => {
      if (this.#registryGeneration === generation) {
        this.#registry = undefined
        this.#registryGeneration++
      }
      logged.clear()
    }
  }

  registerIfMissing(name: string): void {
    const registry = this.#registry
    if (this.#closed || registry === undefined) return
    const generation = this.#registryGeneration
    const topic = `workspace ${name.toLowerCase()}`
    this.#track((async () => {
      const project = await this.#projects()?.get(name)
      if (project === undefined) return
      await this.#locked(project, undefined, async (signal) => {
        if (this.#registryGeneration !== generation || !this.#stillReady(project)) return
        try {
          await this.#register(project, registry, signal)
        } finally {
          await this.#reload(project)
        }
      })
      this.#clearTrouble(topic)
    })().catch((error: unknown) => {
      if (!this.#closed && !isAbort(error)) this.#warnOnce(topic, logged(error), 'could not register the workspace of %s: %s', name, logged(error))
    }))
  }

  projectsChanged(_names?: readonly string[]): void {
    if (!this.#closed) this.#track(this.#recomputeTokens())
  }

  credentialsChanged(ref: string): void {
    if (ref !== this.#config.appIdName && ref !== this.#config.privateKeyName) return
    this.#identity = undefined
    // What was tested with the old credentials says nothing of the new, and a test still out must not be kept.
    this.#lastApp = undefined
    this.#appTest = undefined
    this.#credentialsGeneration++
  }

  // --- DishWorkspaces ------------------------------------------------------------------------------------------------

  async onboard(project: Project, options: { signal?: AbortSignal, progress?: (step: OnboardStep) => void } = {}): Promise<OnboardResult> {
    try {
      return await this.#locked(project, options.signal, async (signal) => {
        try {
          // A registry that appears after its last step looked registers the workspace once dish-projects records the
          // project ready (`registerIfMissing`).
          return await onboardProject(project, this.#onboardDeps(), { signal, ...(options.progress === undefined ? {} : { progress: options.progress }) })
        } finally {
          await this.#reload(project)
        }
      })
    } finally {
      this.projectsChanged()
    }
  }

  async prepare(project: Project): Promise<void> {
    await this.#locked(project, undefined, async (signal) => {
      try {
        const file = cloneStateFile(this.#state, project.owner, project.repo)
        const current = await readCloneState(file)
        if (current === undefined) {
          throw new Error(`dish has no record of ${project.name}'s clone (${file}); press Retry on Settings → Projects to onboard it again`)
        }
        // Deleted by hand: Retry onboards the project again, which makes a fresh clone.
        if (await missing(current.clone)) throw new Error(`the clone at ${current.clone} is gone; press Retry on Settings → Projects to clone it again`)
        if (current.installation !== null) await this.#addRepositories(new Map([[project.owner.toLowerCase(), { installation: current.installation, repos: [project.repo] }]]))
        const topic = `project ${project.name.toLowerCase()}`
        let troubled = false
        // The unit can start before the network is up: without the bot identity, the clone keeps the one it has, the
        // rest is configured all the same, and the project stays ready. The next prepare asks again.
        let identity: Identity | undefined
        try {
          identity = await this.#botIdentity()
        } catch (error) {
          troubled = true
          const why = error instanceof GitHubError && error.kind === 'no-credentials' ? 'the GitHub App isn\'t set on Settings → GitHub App' : logged(error)
          this.#warnOnce(topic, why, 'could not look up the dish App\'s bot identity for %s; its clone keeps the identity it has: %s', project.name, why)
        }
        // Configure first: the fetch checks the clone with today's helper path, which this puts back.
        await configureClone(current.clone, project, identity, this.#cloneDeps)
        if (signal.aborted) throw abortedBy(signal)
        // Removed (or no longer ready) while it was prepared: no fetch, and the sweep queued after this does nothing.
        if (!this.#stillReady(project)) return
        try {
          await this.#fetch(project, signal)
        } catch (error) {
          if (signal.aborted || isAbort(error)) throw error
          troubled = true
          // Recorded in lastFetch, which the page shows; the round tries again.
          this.#warnOnce(topic, logged(error), 'could not fetch %s: %s', project.name, logged(error))
        }
        if (!troubled) this.#clearTrouble(topic)
        const registry = this.#registry
        if (registry !== undefined && this.#stillReady(project)) await this.#register(project, registry, signal)
      } finally {
        await this.#reload(project)
      }
    })
    this.#sweepLater(project)
  }

  describe(name: string): CloneInfo | undefined {
    const key = name.toLowerCase()
    const state = this.#clones.get(key)
    if (state === undefined) return undefined
    let workspace: CloneInfo['workspace'] = null
    const registry = this.#registry
    if (state.workspace !== null && registry !== undefined) {
      try {
        const found = registry.get(state.workspace.id as WorkspaceId)
        if (found !== undefined) workspace = { id: found.id, title: found.title }
      } catch {
        // A registry on its way out: no workspace to show.
      }
    }
    return {
      clone: state.clone,
      adopted: state.adopted,
      workspace,
      lastFetch: state.lastFetch === null ? null : { ...state.lastFetch },
      worktrees: this.#counts.get(key) ?? 0,
    }
  }

  async createWorktree(name: string, slug: string, base?: string, options: { cwd?: string, signal?: AbortSignal } = {}): Promise<CreatedWorktree> {
    if (this.#closed) throw stopped()
    const project = await this.#registered(name)
    const state = this.#projects()?.status(project.name).state ?? 'unknown'
    if (state !== 'ready') throw new Error(`${project.name} isn't ready (${state}); see Settings → Projects`)
    const cwd = options.cwd
    if (typeof cwd !== 'string' || cwd === '') {
      throw new Error(`this chat has no workspace, so a coder couldn't write in a worktree; start a chat in ${project.name}'s workspace`)
    }
    const created = await this.#locked(project, options.signal, async (signal) => {
      try {
        return await this.#worktrees.create(project, slug, base, { cwd, signal })
      } finally {
        await this.#reload(project)
      }
    })
    this.#sweepLater(project)
    return created
  }

  async listWorktrees(name?: string): Promise<WorktreeInfo[]> {
    if (name !== undefined) return this.#worktrees.list(await this.#registered(name))
    const all: WorktreeInfo[] = []
    for (const project of await this.#readyProjects()) {
      const topic = `list ${project.name.toLowerCase()}`
      try {
        all.push(...await this.#worktrees.list(project))
        this.#clearTrouble(topic)
      } catch (error) {
        this.#warnOnce(topic, logged(error), 'could not list the worktrees of %s: %s', project.name, logged(error))
      }
    }
    return all
  }

  async removeWorktree(name: string, slug: string, force = false): Promise<void> {
    if (this.#closed) throw stopped()
    const project = await this.#registered(name)
    await this.#locked(project, undefined, async (signal) => {
      try {
        // Whether it is merged is GitHub's word right after a fetch.
        if (!force) await this.#fetch(project, signal)
        await this.#worktrees.remove(project, slug, force)
      } finally {
        await this.#reload(project)
      }
    })
  }

  async resolve(pathOrRef: string): Promise<Worktree | undefined> {
    const projects = this.#projects()
    if (projects === undefined || this.#closed) return undefined
    return this.#worktrees.resolve(pathOrRef, await projects.list())
  }

  async resolveProblem(pathOrRef: string): Promise<string | undefined> {
    const projects = this.#projects()
    if (projects === undefined || this.#closed) return undefined
    return this.#worktrees.problem(pathOrRef, await projects.list())
  }

  async sweep(name?: string): Promise<SweepResult> {
    if (this.#closed) throw stopped()
    const targets = name === undefined ? await this.#readyProjects() : [await this.#registered(name)]
    const total: SweepResult = { removed: [], kept: [] }
    for (const project of targets) {
      try {
        const result = await this.#locked(project, undefined, signal => this.#fetchAndSweep(project, signal, true))
        // Out of the lock now: dish-orchestrator hears of each removal, in the background.
        this.#runsRemoved(result.removed)
        total.removed.push(...result.removed)
        total.kept.push(...result.kept)
      } catch (error) {
        if (name !== undefined || this.#closed) throw error
        const topic = `project ${project.name.toLowerCase()}`
        this.#warnOnce(topic, logged(error), 'could not fetch and sweep %s: %s', project.name, logged(error))
      }
    }
    return total
  }

  async appStatus(test: boolean): Promise<AppStatus> {
    if (this.#closed) throw stopped()
    if (!test && this.#lastApp !== undefined) return structuredClone(this.#lastApp)
    return structuredClone(await this.#testApp())
  }

  // --- step 7: the head, cleanliness, the push, the pull request ------------------------------------------------------

  async headOf(pathOrRef: string): Promise<string | undefined> {
    const worktree = await this.resolve(pathOrRef)
    if (worktree === undefined) return undefined
    return this.#worktrees.head(worktree.clone, worktree.path)
  }

  async isClean(pathOrRef: string, options?: CleanOptions): Promise<Cleanliness> {
    const worktree = await this.resolve(pathOrRef)
    if (worktree === undefined) throw new Error(`no worktree ${shown(String(pathOrRef), 200)} that dish made`)
    const untracked = options?.untracked === 'ignore' ? [] as string[] : undefined
    const why = await this.#worktrees.dirty(worktree.clone, worktree.path, worktree.branch, untracked === undefined ? undefined : { untracked })
    if (why !== undefined) return { clean: false, why }
    if (untracked === undefined || untracked.length === 0) return { clean: true }
    const named = untracked.slice(0, UNTRACKED_NAMED).map(path => shown(path, 200))
    if (untracked.length > UNTRACKED_NAMED) named.push(`and ${untracked.length - UNTRACKED_NAMED} more`)
    return { clean: true, untracked: named }
  }

  async pushBranch(name: string, slug: string, options: { head: string, signal?: AbortSignal }): Promise<{ head: string }> {
    const project = await this.#readyProject(name)
    checkSlug(slug)
    const head = options?.head
    // No push without the commit open_pr checked: the push is of that commit or of nothing.
    if (typeof head !== 'string' || !SHA.test(head)) throw new Error('head must be a full commit id: the commit open_pr checked')
    const pushed = await this.#locked(project, options.signal, async (signal) => {
      const worktree = await this.#managed(project, slug, 'pushed')
      const tip = await this.#worktrees.tip(worktree.clone, worktree.branch)
      if (tip === undefined) throw new Error(`its branch ${worktree.branch} is gone`)
      if (tip !== head) throw new Error(`${worktree.branch} is at ${tip}, not ${head} (the commit the checks ran on); nothing was pushed`)
      // Minted for this push, held by this call only, and dropped with it.
      const token = await this.#tokens.writeToken(project.owner, project.repo, PUSH_PERMISSIONS)
      return pushIsolated({
        clone: worktree.clone, branch: worktree.branch, tip, url: httpsUrl(this.#web, project.owner, project.repo), web: this.#web,
        helper: this.#pushHelper, parent: projectStateDir(this.#state, project.owner, project.repo), token, signal,
      })
    })
    this.#logger.info('pushed %s of %s at %s (%s)', pushed.branch, project.name, pushed.head.slice(0, 12), pushed.result)
    return { head: pushed.head }
  }

  async openPull(name: string, pull: { head: string, title: string, body: string }): Promise<OpenedPull> {
    const project = await this.#readyProject(name)
    const head = typeof pull?.head === 'string' ? pull.head : ''
    const slug = PULL_HEAD.exec(head)?.[1]
    const worktree = slug === undefined ? undefined : await this.resolve(`${project.name}/${slug}`)
    if (worktree === undefined || worktree.branch !== head) {
      throw new Error('dish opens pull requests only from the dish/<slug> branch of a worktree it made')
    }
    const base = await defaultBranch(worktree.clone)
    if (base === undefined) throw new Error(`dish doesn't know ${project.name}'s default branch (origin/HEAD isn't set); the next fetch sets it`)
    const title = pullTitle(pull.title)
    const body = pullText(pull.body, 'body')
    const token = await this.#tokens.writeToken(project.owner, project.repo, PULL_PERMISSIONS)
    try {
      try {
        const opened = await this.#app.createPull(project.owner, project.repo, { title, head, base, body }, token)
        return { url: opened.url, number: opened.number, existing: false }
      } catch (error) {
        // GitHub's 422 when one is open for the branch already: that one is reported, and nothing of it is changed.
        if (!(error instanceof GitHubError && error.kind === 'unprocessable')) throw error
        const found = await this.#app.findOpenPull(project.owner, project.repo, head, token)
        if (found === undefined) throw error
        return { url: found.url, number: found.number, existing: true }
      }
    } catch (error) {
      throw new Error(`could not open the pull request for ${head}: ${shown(messageOf(error), MESSAGE_CHARS)}`)
    }
  }

  async commentPull(name: string, number: number, body: string): Promise<void> {
    const project = await this.#readyProject(name)
    checkPullNumber(number)
    const text = pullText(body, 'comment')
    if (text.trim() === '') throw new Error('a comment needs a body')
    const token = await this.#tokens.writeToken(project.owner, project.repo, PULL_PERMISSIONS)
    try {
      await this.#app.createComment(project.owner, project.repo, number, text, token)
    } catch (error) {
      throw new Error(`could not comment on pull request #${number}: ${shown(messageOf(error), MESSAGE_CHARS)}`)
    }
  }

  async updatePull(name: string, number: number, fields: { title?: string, body?: string }): Promise<void> {
    const project = await this.#readyProject(name)
    checkPullNumber(number)
    const given = fields ?? {}
    if (given.title === undefined && given.body === undefined) throw new Error('updatePull needs a title or a body')
    const changed: { title?: string, body?: string } = {}
    if (given.title !== undefined) changed.title = pullTitle(given.title)
    if (given.body !== undefined) changed.body = pullText(given.body, 'body')
    const token = await this.#tokens.writeToken(project.owner, project.repo, PULL_PERMISSIONS)
    try {
      await this.#app.updatePull(project.owner, project.repo, number, changed, token)
    } catch (error) {
      throw new Error(`could not update pull request #${number}: ${shown(messageOf(error), MESSAGE_CHARS)}`)
    }
  }

  async compareBranch(name: string, slug: string): Promise<BranchComparison> {
    const project = await this.#readyProject(name)
    checkSlug(slug)
    const comparison = await this.#locked(project, undefined, async (signal) => {
      const worktree = await this.#managed(project, slug, 'compared')
      try {
        await this.#fetch(project, signal)
      } finally {
        await this.#reload(project)
      }
      const base = await defaultBranch(worktree.clone)
      if (base === undefined) throw new Error(`dish doesn't know ${project.name}'s default branch (origin/HEAD isn't set); the next fetch sets it`)
      return this.#worktrees.compare(worktree.clone, worktree.branch, base)
    })
    this.#sweepLater(project)
    return comparison
  }

  async readPull(name: string, number: number): Promise<PullFeedback> {
    const project = await this.#readyProject(name)
    checkPullNumber(number)
    const { owner, repo } = project
    const token = await this.#tokens.apiToken(owner)
    let details: PullDetails
    try {
      details = await this.#app.pullDetails(owner, repo, number, token)
    } catch (error) {
      if (error instanceof GitHubError && error.kind === 'not-found') throw new Error(`no pull request #${number} in ${project.name}`)
      throw new Error(`could not read pull request #${number}: ${shown(messageOf(error), MESSAGE_CHARS)}`)
    }
    const sha = details.head.sha
    const [reviews, reviewComments, issueComments, runs, statuses] = await Promise.allSettled([
      this.#app.pullReviews(owner, repo, number, token),
      this.#app.pullReviewComments(owner, repo, number, token),
      this.#app.issueComments(owner, repo, number, token),
      this.#app.checkRuns(owner, repo, sha, token),
      this.#app.combinedStatus(owner, repo, sha, token),
    ])
    const needed = (settled: PromiseSettledResult<RawList>, what: string): RawList => {
      if (settled.status === 'fulfilled') return settled.value
      throw new Error(`could not read pull request #${number}'s ${what}: ${shown(messageOf(settled.reason), MESSAGE_CHARS)}`)
    }
    const reviewList = needed(reviews, 'reviews')
    const reviewCommentList = needed(reviewComments, 'review comments')
    const issueCommentList = needed(issueComments, 'comments')
    // The checks are a part pr_feedback can do without: a source that fails leaves them unavailable, with why, and the
    // other source's checks, the reviews and the comments still come.
    const unavailable: string[] = []
    const checks: PullFeedback['checks'] = []
    let moreChecks = false
    for (const [settled, read] of [[runs, checkRunsOf], [statuses, statusesOf]] as const) {
      if (settled.status === 'fulfilled') {
        checks.push(...read(settled.value))
        moreChecks ||= settled.value.full
        continue
      }
      const why = cantReadChecks(settled.reason)
        ? `the dish App can't read checks of ${project.name}: it needs Checks and Commit statuses read (accept them on GitHub; Settings → GitHub App)`
        : `could not read the checks: ${shown(messageOf(settled.reason), MESSAGE_CHARS)}`
      if (!unavailable.includes(why)) unavailable.push(why)
    }
    return {
      number: details.number,
      url: untrusted(details.url, FEEDBACK_TEXT_CHARS),
      title: untrusted(details.title, FEEDBACK_TEXT_CHARS),
      state: details.state,
      merged: details.merged,
      draft: details.draft,
      mergeable: details.mergeable,
      mergeableState: untrusted(details.mergeableState, FEEDBACK_TEXT_CHARS),
      head: { ref: untrusted(details.head.ref, FEEDBACK_TEXT_CHARS), sha: untrusted(sha, FEEDBACK_TEXT_CHARS) },
      base: { ref: untrusted(details.base.ref, FEEDBACK_TEXT_CHARS) },
      reviews: reviewsOf(reviewList),
      reviewComments: reviewCommentsOf(reviewCommentList),
      issueComments: issueCommentsOf(issueCommentList),
      checks: checks.slice(0, 2 * FEEDBACK_ITEMS),
      ...(unavailable.length > 0 ? { checksUnavailable: unavailable.join('; ') } : {}),
      more: { reviews: reviewList.full, reviewComments: reviewCommentList.full, issueComments: issueCommentList.full, checks: moreChecks },
    }
  }

  /** `name`, registered and ready now; a closed service is `stopped()`. */
  async #readyProject(name: string): Promise<Project> {
    if (this.#closed) throw stopped()
    const project = await this.#registered(name)
    const state = this.#projects()?.status(project.name).state ?? 'unknown'
    if (state !== 'ready') throw new Error(`${project.name} isn't ready (${state}); see Settings → Projects`)
    return project
  }

  /** The worktree dish made at `<project>/<slug>`, or why there is none to be `what`. */
  async #managed(project: Project, slug: string, what: 'pushed' | 'compared'): Promise<Worktree> {
    const ref = `${project.name}/${slug}`
    const worktree = await this.resolve(ref)
    if (worktree !== undefined) return worktree
    const problem = await this.resolveProblem(ref)
    if (problem !== undefined) throw new Error(`${ref} can't be ${what}: ${problem}`)
    throw new Error(what === 'pushed'
      ? `no worktree ${ref} that dish made; dish pushes only the dish/<slug> branch of a worktree it made`
      : `no worktree ${ref} that dish made`)
  }

  // --- the lock and the work in flight -------------------------------------------------------------------------------

  /**
   * `body` under `project`'s lock, with a signal that aborts on `callerSignal` or on `close`. The job is tracked, so
   * `close` waits for it; once closed, its failure is an `AbortError`.
   */
  async #locked<T>(project: Project, callerSignal: AbortSignal | undefined, body: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.#closed) throw stopped()
    const signal = callerSignal === undefined ? this.#closing.signal : AbortSignal.any([callerSignal, this.#closing.signal])
    if (signal.aborted) throw abortedBy(signal)
    const job = this.#lock.run(project.name.toLowerCase(), async () => {
      if (this.#closed) throw stopped()
      if (signal.aborted) throw abortedBy(signal)
      return body(signal)
    })
    this.#track(job)
    try {
      return await job
    } catch (error) {
      if (this.#closed && !isAbort(error)) throw stopped()
      throw error
    }
  }

  #track<T>(promise: Promise<T>): Promise<T> {
    this.#inFlight.add(promise)
    const done = (): void => { this.#inFlight.delete(promise) }
    promise.then(done, done)
    return promise
  }

  // --- the clone states ------------------------------------------------------------------------------------------------

  /** Every `<state>/workspaces/<owner>/<repo>/clone.json`, read now (small files; `describe` answers from memory). */
  #loadClones(): void {
    const root = join(this.#state, 'workspaces')
    let owners: string[]
    try {
      owners = readdirSync(root)
    } catch {
      return
    }
    for (const owner of owners) {
      let repos: string[]
      try {
        repos = readdirSync(join(root, owner))
      } catch {
        continue
      }
      for (const repo of repos) {
        let text: string
        try {
          text = readFileSync(join(root, owner, repo, 'clone.json'), 'utf8')
        } catch {
          continue
        }
        const state = parseCloneState(text)
        if (state === undefined) continue
        const key = `${owner}/${repo}`.toLowerCase()
        this.#clones.set(key, state)
        try {
          this.#counts.set(key, countRecords(readdirSync(join(root, owner, repo, 'worktrees'))))
        } catch {
          this.#counts.set(key, 0)
        }
      }
    }
  }

  /** `project`'s clone state and worktree count, read again after an operation that may have written them. Never throws. */
  async #reload(project: Project): Promise<void> {
    const key = project.name.toLowerCase()
    try {
      const state = await readCloneState(cloneStateFile(this.#state, project.owner, project.repo))
      if (state === undefined) {
        this.#clones.delete(key)
        this.#counts.delete(key)
        return
      }
      this.#clones.set(key, state)
      const names = await readdir(join(projectStateDir(this.#state, project.owner, project.repo), 'worktrees')).catch(() => [])
      this.#counts.set(key, countRecords(names))
    } catch {
      // What memory has stays; the next operation reads it again.
    }
  }

  /** The clone dish knows for `project`, else where it would be. */
  #cloneOf(project: Project): string {
    return this.#clones.get(project.name.toLowerCase())?.clone ?? clonePath(this.#workRoot, project.owner, project.repo)
  }

  /** The project's fetch (clone.ts), recorded in its clone state. The caller holds the project's lock. */
  #fetch(project: Project, signal?: AbortSignal): Promise<void> {
    return fetchClone(this.#cloneOf(project), project, this.#cloneDeps, signal)
  }

  /**
   * Under the project's lock: its fetch (unless the caller has just made one), then its sweep. Nothing for a project
   * that isn't ready now: one removed after the round listed it, or while the work queued behind it (a prepare's sweep).
   */
  async #fetchAndSweep(project: Project, signal: AbortSignal, fetchFirst: boolean): Promise<SweepResult> {
    if (!this.#stillReady(project)) return { removed: [], kept: [] }
    try {
      if (fetchFirst) await this.#fetch(project, signal)
      if (signal.aborted) throw abortedBy(signal)
      const result = await sweepProject(project, this.#worktrees, this.#worktreeDeps)
      for (const item of result.removed) this.#logger.info('removed worktree %s/%s: its branch is merged (%s)', item.project, item.slug, item.by)
      for (const item of result.kept) {
        const topic = `sweep ${project.name.toLowerCase()}/${item.slug}`
        if (item.reason === 'error') this.#warnOnce(topic, item.detail ?? '', 'the sweep kept worktree %s/%s: %s', item.project, item.slug, item.detail ?? 'an error')
        else this.#clearTrouble(topic)
      }
      return result
    } finally {
      await this.#reload(project)
    }
  }

  /** The project's sweep, queued under its lock, in the background (after a fetch it just made). */
  #sweepLater(project: Project): void {
    if (this.#closed) return
    const topic = `project ${project.name.toLowerCase()}`
    this.#locked(project, undefined, signal => this.#fetchAndSweep(project, signal, false)).then((result) => {
      this.#runsRemoved(result.removed)
    }).catch((error: unknown) => {
      if (!this.#closed && !isAbort(error)) this.#warnOnce(topic, logged(error), 'could not sweep %s: %s', project.name, logged(error))
    })
  }

  /** dish-orchestrator's hooks, if it is there (read on each use). */
  #runs(): RunsHooks | undefined {
    return (this.#ctx as unknown as { get(name: string): unknown }).get('dishRuns') as RunsHooks | undefined
  }

  /**
   * Tell dish-orchestrator of each worktree a sweep removed, one after the other, once that sweep's lock is released.
   * Tracked, so `close` waits for it; never rejects: a failure is logged once per project and error.
   */
  #runsRemoved(removed: SweepResult['removed']): void {
    if (removed.length === 0) return
    this.#track((async () => {
      for (const item of removed) {
        const runs = this.#runs()
        if (runs === undefined) return
        const topic = `runs ${item.project.toLowerCase()}`
        try {
          await runs.worktreeRemoved(item.project, item.slug)
          this.#clearTrouble(topic)
        } catch (error) {
          this.#warnOnce(topic, logged(error), 'dish-orchestrator could not note that worktree %s/%s was removed: %s', item.project, item.slug, logged(error))
        }
      }
    })())
  }

  // --- the hourly round --------------------------------------------------------------------------------------------------

  #scheduleRound(ms: number): void {
    if (this.#closed) return
    this.#roundTimer = this.#timers.set(() => this.#tick(), ms)
  }

  #tick(): void {
    this.#roundTimer = undefined
    if (this.#closed) return
    this.#scheduleRound(this.#roundEveryMs)
    // Never two at once: a round that is still running when the next is due takes its place.
    if (this.#round !== undefined) return
    const round = this.#track(this.#runRound())
    this.#round = round
    void round.finally(() => { if (this.#round === round) this.#round = undefined })
  }

  /** Per ready project, one at a time: its fetch (its read token first), then its sweep. Never rejects. */
  async #runRound(): Promise<void> {
    let projects: Project[]
    try {
      projects = await this.#readyProjects()
      this.#clearTrouble('round')
    } catch (error) {
      this.#warnOnce('round', logged(error), 'the hourly round could not list the projects: %s', logged(error))
      return
    }
    for (const project of projects) {
      if (this.#closed) return
      const topic = `project ${project.name.toLowerCase()}`
      try {
        const result = await this.#locked(project, undefined, signal => this.#fetchAndSweep(project, signal, true))
        this.#runsRemoved(result.removed)
        this.#clearTrouble(topic)
      } catch (error) {
        if (this.#closed) return
        this.#warnOnce(topic, logged(error), 'the hourly round could not fetch and sweep %s: %s', project.name, logged(error))
      }
    }
  }

  // --- projects, crew, GitHub ----------------------------------------------------------------------------------------------

  #projects(): DishProjects | undefined {
    return this.#ctx.get('dishProjects')
  }

  /** Whether dish-projects says `project` is ready now (a removed one isn't: its status is forgotten). */
  #stillReady(project: Project): boolean {
    return this.#projects()?.status(project.name).state === 'ready'
  }

  /** The project called `name` (any case), registered now. */
  async #registered(name: string): Promise<Project> {
    const projects = this.#projects()
    if (projects === undefined) throw new Error('dish-projects isn\'t running, so no project is registered')
    const project = await projects.get(name)
    if (project === undefined) throw new Error(`no project ${shown(String(name), 100)} in projects.yaml; add it on Settings → Projects`)
    return project
  }

  async #readyProjects(): Promise<Project[]> {
    const projects = this.#projects()
    if (projects === undefined) return []
    return (await projects.list()).filter(project => projects.status(project.name).state === 'ready')
  }

  async #bindings(path: string): Promise<Binding[]> {
    const crew = (this.#ctx as unknown as { get(name: string): unknown }).get('dishCrew') as CrewReader | undefined
    if (crew === undefined) return []
    return (await crew.worktreeBindings(path)).map(({ child, role, title, running }) => ({ child, role, title, running }))
  }

  /** The pull requests holding `sha`, read with the in-memory API token; [] on an error, which is logged once. */
  async #pulls(project: Project, sha: string): Promise<PullSummary[]> {
    const topic = `pulls ${project.name.toLowerCase()}`
    try {
      const token = await this.#tokens.apiToken(project.owner)
      const pulls = await this.#app.pullsForCommit(project.owner, project.repo, sha, token)
      this.#clearTrouble(topic)
      return pulls
    } catch (error) {
      this.#warnOnce(topic, logged(error), 'could not ask GitHub for the pull requests of %s: %s', project.name, logged(error))
      return []
    }
  }

  /** The bot identity, looked up once per service life (and again after a credential change, or a failure). */
  #botIdentity(): Promise<Identity> {
    if (this.#identity === undefined) {
      const asked = appIdentity({ app: () => this.#app.app(), botUser: slug => this.#botUser(this.#app, slug) })
      this.#identity = asked
      asked.catch(() => { if (this.#identity === asked) this.#identity = undefined })
    }
    return this.#identity
  }

  /** The bot of `slug` (public, no credential): from memory when it has been looked up, else asked with `app` and kept. */
  async #botUser(app: Pick<GitHubApp, 'botUser'>, slug: string): Promise<{ id: number, login: string }> {
    const known = this.#bots.get(slug)
    if (known !== undefined) return { ...known }
    const bot = await app.botUser(slug)
    this.#bots.set(slug, { id: bot.id, login: bot.login })
    // A handful of Apps in a life; the oldest goes if there are ever more.
    if (this.#bots.size > MAX_BOTS) this.#bots.delete(this.#bots.keys().next().value!)
    return bot
  }

  /** The App's ID and private key, read from dsh's credential store now; `undefined` when either (or the store) is missing. Kept by nobody. */
  async #readCredentials(): Promise<AppCredentials | undefined> {
    const provider = this.#ctx.get('credentials')
    if (provider === undefined) return undefined
    const [appId, privateKey] = await Promise.all([
      provider.resolve(this.#config.appIdName as CredentialRef),
      provider.resolve(this.#config.privateKeyName as CredentialRef),
    ])
    return appId === undefined || privateKey === undefined ? undefined : { appId: appId.value, privateKey: privateKey.value }
  }

  /** The status test, shared by callers that come while it runs, and remembered unless a credential changed meanwhile. */
  #testApp(): Promise<AppStatus> {
    if (this.#appTest !== undefined) return this.#appTest
    const generation = this.#credentialsGeneration
    const run = this.#runAppTest().then((status) => {
      if (generation === this.#credentialsGeneration && !this.#closed) this.#lastApp = status
      return status
    })
    const tracked: Promise<AppStatus> = run.finally(() => { if (this.#appTest === tracked) this.#appTest = undefined })
    this.#appTest = tracked
    return tracked
  }

  /**
   * `GET /app`, then the installations and the bot's profile, as far as they go: what one call could not do is in `error`
   * and the rest of the answer stands. The credentials are read once, used by a client made for this test, and dropped.
   * Never rejects.
   */
  async #runAppTest(): Promise<AppStatus> {
    const status: AppStatus = {
      names: { appId: this.#config.appIdName, privateKey: this.#config.privateKeyName },
      app: null, bot: null, installations: [], error: null, checkedAt: null,
    }
    let credentials: AppCredentials | undefined
    let unreadable: unknown
    try {
      credentials = await this.#readCredentials()
    } catch (error) {
      unreadable = error
    }
    // `undefined` credentials are the client's own 'no-credentials' error before any request; so is a store that failed.
    const app = new GitHubApp(async () => {
      if (unreadable !== undefined) throw unreadable
      return credentials
    }, this.#appOptions)
    const hide = hiding(credentials === undefined ? [] : [credentials.appId, credentials.privateKey])
    const errors: string[] = []
    const fail = (error: unknown): void => { errors.push(shown(hide(messageOf(error)), LOGGED_CHARS)) }

    let slug: string | undefined
    try {
      const found = await app.app()
      status.app = { slug: found.slug, name: found.name }
      slug = found.slug
    } catch (error) {
      fail(error)
    }
    if (slug !== undefined) {
      try {
        status.installations = (await app.installations()).map(({ id, account, accountType, selection }) => ({ id, account, type: accountType, selection }))
      } catch (error) {
        fail(error)
      }
      try {
        const bot = await this.#botUser(app, slug)
        status.bot = { login: bot.login, email: botIdentity(slug, bot.id).email }
      } catch (error) {
        fail(error)
      }
    }
    status.error = errors.length === 0 ? null : errors.join('; ')
    status.checkedAt = Date.now()
    return status
  }

  #onboardDeps(): OnboardDeps {
    return {
      ...this.#cloneDeps,
      app: this.#app,
      tokens: {
        ensureFileToken: owner => this.#tokens.ensureFileToken(owner),
        setRepositories: byOwner => this.#addRepositories(byOwner),
      },
      repositories: () => this.#owners,
      registry: () => this.#registry,
      identity: () => this.#botIdentity(),
    }
  }

  // --- the read tokens ---------------------------------------------------------------------------------------------------

  /** `job` after every token job queued before it. */
  #queueTokens(job: () => Promise<void>): Promise<void> {
    const next = this.#tokenQueue.then(job, job)
    this.#tokenQueue = next.catch(() => {})
    return next
  }

  /** Onboarding's addition (a new repo for its owner): only adds to the map. */
  #addRepositories(byOwner: ReadonlyMap<string, OwnerRepos>): Promise<void> {
    return this.#queueTokens(async () => {
      const merged = mergeOwners(this.#owners, byOwner)
      await this.#tokens.setRepositories(merged)
      this.#owners = merged
    })
  }

  /** The owner map from the projects listed now and their clone states (read from disk, in the queue). Never rejects. */
  #recomputeTokens(): Promise<void> {
    return this.#queueTokens(async () => {
      try {
        const projects = this.#projects()
        if (projects === undefined || this.#closed) return
        const byOwner = new Map<string, OwnerRepos>()
        for (const project of await projects.list()) {
          const state = await readCloneState(cloneStateFile(this.#state, project.owner, project.repo)).catch(() => undefined)
          if (state === undefined || state.installation === null) continue
          const key = project.owner.toLowerCase()
          const entry = byOwner.get(key)
          byOwner.set(key, { installation: entry?.installation ?? state.installation, repos: [...(entry?.repos ?? []), project.repo] })
        }
        await this.#tokens.setRepositories(byOwner)
        this.#owners = byOwner
        this.#clearTrouble('tokens')
      } catch (error) {
        this.#warnOnce('tokens', logged(error), 'could not update the read tokens: %s', logged(error))
      }
    })
  }

  // --- the workspace registry ------------------------------------------------------------------------------------------

  /**
   * Register `project`'s clone with `registry` when its clone state has no workspace, and record it. The signal is
   * checked first: a project removed meanwhile gets none. Its workspace id (the one it had, or the new one).
   */
  async #register(project: Project, registry: WorkspaceRegistryLike, signal: AbortSignal): Promise<string | undefined> {
    if (signal.aborted) throw abortedBy(signal)
    const file = cloneStateFile(this.#state, project.owner, project.repo)
    const current = await readCloneState(file)
    if (current === undefined) return undefined
    if (current.workspace !== null) return current.workspace.id
    const workspace = await registerWorkspace(registry, current.clone, project.name)
    await writeCloneState(file, { ...current, workspace: { id: workspace.id, registeredAt: Date.now() } })
    this.#logger.info('%s is registered as workspace %s', project.name, workspace.id)
    return workspace.id
  }

  /** A registry appeared: every ready project whose clone state has no workspace, each under its lock. */
  async #registerReady(registry: WorkspaceRegistryLike, generation: number): Promise<void> {
    const projects = this.#projects()
    if (projects === undefined) return
    let listed: Project[]
    try {
      listed = await projects.list()
    } catch (error) {
      this.#warnOnce('register', logged(error), 'could not list the projects to register their workspaces: %s', logged(error))
      return
    }
    for (const project of listed) {
      if (this.#closed || this.#registryGeneration !== generation) return
      if (projects.status(project.name).state !== 'ready') continue
      const topic = `workspace ${project.name.toLowerCase()}`
      try {
        await this.#locked(project, undefined, async (signal) => {
          // Removed (or no longer ready) while it waited for the lock: no workspace.
          if (this.#registryGeneration !== generation || !this.#stillReady(project)) return
          try {
            await this.#register(project, registry, signal)
          } finally {
            await this.#reload(project)
          }
        })
        this.#clearTrouble(topic)
      } catch (error) {
        if (this.#closed) return
        this.#warnOnce(topic, logged(error), 'could not register the workspace of %s: %s', project.name, logged(error))
      }
    }
  }

  // --- logging --------------------------------------------------------------------------------------------------------

  #warnOnce(topic: string, message: string, format: string, ...args: unknown[]): void {
    if (this.#trouble.get(topic) === message) return
    this.#trouble.set(topic, message)
    this.#logger.warn(format, ...args)
  }

  #clearTrouble(topic: string): void {
    this.#trouble.delete(topic)
  }
}

/** The service over `ctx` (for `credentials`, `dishProjects`, `dishCrew` and the logger). `start` it, and `close` it when the plugin goes. */
export function createDishWorkspaces(ctx: Context, config: WorkspacesConfig, internals: WorkspacesInternals = {}): WorkspacesService {
  return new Service(ctx, config, internals)
}
