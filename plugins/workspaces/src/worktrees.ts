/**
 * Task worktrees: `<clone>/.worktrees/<slug>` on a new branch `dish/<slug>`, made by the main agent with the `worktree`
 * tool, bound to coders by crew's `delegate`, gated by 6c, and removed once merged (sweep.ts).
 *
 * - **Managed** means dish made it: dish records each one it makes (`<state>/workspaces/<owner>/<repo>/worktrees/
 *   <slug>.json`, with the commit it was cut from) in its state directory, which agents can't write. Only a managed
 *   worktree is resolved, removed or swept. Anything else under `.worktrees/` (6c's `.cache`, a worktree made by hand)
 *   is listed at most, and never changed.
 * - **Paths are canonical:** the clone is `realpath`'d and `.worktrees` must be a real directory, so
 *   `<clone>/.worktrees/<slug>` is the path crew records and compares, the one `bindings` is asked about, and the one
 *   `git worktree remove` is given (never a caller's spelling).
 * - **dish's own git only:** every command is `git()` (git.ts), with `-C <clone>` after `checkClone` passes (with the
 *   project's expectations: its origin, its credential helper) or `-C <worktree>` after `checkWorktree` passes. A failed
 *   check refuses the operation with the finding. A `status` in a worktree takes no optional lock, so it never gets in
 *   the way of a coder's own git there.
 * - **Setup is not run in a worktree** (`worktreeSetup`): the user chose A on 2026-10-02.
 * - **Removal touches one worktree:** `git worktree remove` on its own path (a missing directory included, for its
 *   administrative entry), never `git worktree prune`, which would also drop the entries of hand-made worktrees whose
 *   directories are gone (and leave their commits unreachable). A worktree holding another worktree is never removed,
 *   force or not, and a branch another worktree (the clone's own checkout included) has checked out is never deleted.
 *
 * Known limits:
 * - **A nested repository inside an ignored folder** (a clone under `node_modules/` or another ignored path) is an
 *   ignored file to git and to `dirty`, so it is deleted with the worktree, its history and uncommitted edits included.
 * - **`.worktrees` swapped for a link** between `create`'s check of it and `git worktree add`: git then makes the
 *   worktree wherever the link points. `create` sees it afterwards (git's record of the new worktree, or the path
 *   itself, isn't canonical), removes what git just made where git put it, and refuses; if that removal fails, it says
 *   so and keeps the branch and the record. The check and the add are still two steps.
 *
 * Nothing here takes the project's lock: the service runs `create`, `remove` and the sweep under it.
 *
 * @module dish-workspaces/worktrees
 */

import { lstat, mkdir, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import type { Project } from 'dish-projects/registry'
import { SHA, git, gitOk, shown } from './git.ts'
import type { GitResult } from './git.ts'
import type { PullSummary } from './github.ts'
import { clonePath, projectStateDir, worktreeRecordFile, worktreeSetupLogFile, writeFileAtomic } from './paths.ts'
import { checkClone, checkWorktree } from './safety.ts'
import type { CloneExpectations } from './safety.ts'
import { skipReason } from './setup.ts'
import type { GitHubDefault, SetupOutcome } from './setup.ts'
import { checkMerged, defaultBranchOf, githubWord } from './sweep.ts'

/** A worktree's name: its folder under `.worktrees/` and its branch `dish/<slug>`. (`.cache`, 6c's, can't be one.) */
export const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/
/** How long after a `resolve` the sweep leaves a worktree alone: a coder about to start in it. */
export const RECENT_RESOLVE_MS = 300_000
/** Why setup doesn't run in a new worktree (see `worktreeSetup`). */
export const WORKTREE_SETUP_SKIPPED = 'a worktree picks up config from the clone, which agents can change'

/**
 * For tests only, never set by dish: `gitEnv` goes on top of the environment of this module's git (a test's
 * `GIT_CONFIG_NOSYSTEM`); `beforeAdd` runs between `create`'s check of `.worktrees` and its `git worktree add`, and
 * `afterAdd` right after the add.
 */
export const internals: { gitEnv?: Record<string, string>, beforeAdd?: () => Promise<void>, afterAdd?: () => Promise<void> } = {}

/** git()'s cap on stdout: a listing this long may have been cut. */
const GIT_OUTPUT_CAP = 4 * 1024 * 1024
/** The longest `base` taken. */
const MAX_BASE = 256

export interface Worktree {
  /** `owner/repo`, as in projects.yaml. */
  project: string
  slug: string
  /** `dish/<slug>` */
  branch: string
  /** `<clone>/.worktrees/<slug>`, absolute and canonical. */
  path: string
  /** Absolute and canonical. */
  clone: string
  /** The commit it was cut from. */
  base: string
}

/** What dish keeps of a worktree it made. */
export interface WorktreeRecord {
  project: string
  slug: string
  branch: string
  /** The commit it was cut from. */
  base: string
  /** The base as asked for (`origin/main`, a tag, a branch). */
  baseRef: string
  /** Epoch ms. */
  createdAt: number
}

/** A crew child bound to a worktree (crew's `WorktreeBinding`, as far as dish-workspaces reads it). */
export interface Binding {
  child: string
  role: string
  title: string
  running: boolean
}

export interface WorktreeInfo extends Worktree {
  /** Commits on its branch that `origin/<default>` hasn't, and the other way round. */
  ahead: number
  behind: number
  dirty: boolean
  /** Computed for managed worktrees only. */
  merged: boolean
  /** dish made it. */
  managed: boolean
  bound: Binding[]
}

export interface CreatedWorktree extends Worktree {
  setup: SetupOutcome
}

export interface WorktreeDeps {
  workRoot: string
  state: string
  /** What `checkClone` expects of the project's clone: its origin's URL, dish's helper value and the web origin. */
  cloneExpectations(project: Project): CloneExpectations
  /** The service's fetchClone: called while the service holds the project's lock; must not take it. */
  fetch(project: Project, signal?: AbortSignal): Promise<void>
  /** origin/HEAD's branch, else 'main'. */
  defaultBranch(clone: string): Promise<string>
  /** `dishCrew.worktreeBindings`, or [] without crew. Always asked with the canonical path. */
  bindings(path: string): Promise<Binding[]>
  /** The pull requests holding `sha` (GitHub with the API token); [] on error (logged by the caller). */
  pulls(project: Project, sha: string): Promise<PullSummary[]>
  now?: () => number
}

/** One managed worktree as `inspect` found it: what `remove` and the sweep decide on. */
export interface WorktreeState {
  record: WorktreeRecord
  /** Canonical, and `checkClone` passed. */
  clone: string
  /** `<clone>/.worktrees/<slug>`, canonical. */
  path: string
  /** Something is at `path`. */
  exists: boolean
  /** `dish/<slug>`'s commit; undefined when the branch is gone. */
  tip: string | undefined
  /** Why `checkWorktree` refuses it, when something is at `path`. */
  problem: string | undefined
}

/**
 * Setup in a new worktree: not run, with the command to run instead.
 *
 * This is A, which the user chose on 2026-10-02. A worktree sits inside the clone, and tools read config
 * from parent directories (`pnpm-workspace.yaml`, `.pnpmfile.cjs`, `.npmrc`, a parent `package.json`'s workspaces,
 * `.cargo/config.toml`, `go.work`, …), which agents in the project's workspace can write: merged code in the worktree
 * could still run code an agent wrote, outside the sandbox (setup.ts's known limits). Only a fresh clone is free of it.
 *
 * Option B (not chosen) would make this, right after `create`'s fetch: `checkClone(clone, deps.cloneExpectations(
 * project))`, then `onMergedCode(clone, { commit: base }, defaultBranch, signal)`, and when that's ok `runSetup({
 * command: project.setup, cwd: path, timeoutMs: project.setupTimeoutMs, log: worktreeSetupLogFile(…), signal })`;
 * else `skipReason(check.reason, path, command)`.
 */
function worktreeSetup(project: Project, path: string): SetupOutcome {
  if (project.setup === undefined || project.setup.trim() === '') return { ran: false, reason: 'no setup' }
  return { ran: false, reason: skipReason(WORKTREE_SETUP_SKIPPED, path, project.setup) }
}

export class Worktrees {
  readonly #deps: WorktreeDeps
  /** Canonical path → when `resolve` last gave it. */
  readonly #resolved = new Map<string, number>()

  constructor(deps: WorktreeDeps) {
    this.#deps = deps
  }

  /**
   * The spec's create. The new path must be inside `options.cwd` (the calling chat's workspace), which must be the
   * clone or inside it: crew's children work in the chat's sandbox. Then the slug must be free (no record, no
   * directory, no branch `dish/<slug>`); fetch; resolve `base` (default `origin/<default>`) to a commit; record it;
   * `git worktree add --no-track -b dish/<slug> <path> <commit>`. Setup is not run (`worktreeSetup`).
   */
  async create(project: Project, slug: string, base: string | undefined, options: { cwd: string, signal?: AbortSignal }): Promise<CreatedWorktree> {
    const { signal } = options
    if (typeof slug !== 'string' || !SLUG.test(slug)) {
      throw new Error(`${quote(String(slug))} can't name a worktree: use 1 to 40 of a-z, 0-9 and "-", starting with a letter or a digit`)
    }
    if (base !== undefined) checkBase(base)
    const clone = await this.#checkedClone(project)
    const path = join(clone, '.worktrees', slug)
    await insideWorkspace(project, clone, path, options.cwd)
    await this.#free(project, clone, slug, path, signal)

    await this.#deps.fetch(project, signal)
    signal?.throwIfAborted()
    await this.#check(project, clone)
    const defaultBranch = await defaultBranchOf(this.#deps, clone)
    const baseRef = base ?? `origin/${defaultBranch}`
    const commit = await commitOf(clone, base ?? `refs/remotes/origin/${defaultBranch}`, signal)
    if (commit === undefined) throw new Error(`${base === undefined ? baseRef : `base ${quote(base)}`} isn't a commit in ${project.name}'s clone`)
    await worktreesDir(clone)

    const record: WorktreeRecord = { project: project.name, slug, branch: `dish/${slug}`, base: commit, baseRef, createdAt: this.#now() }
    const file = this.#recordFile(project, slug)
    // The record first: a crash after it leaves a record with no worktree and no branch, which the sweep drops.
    await writeFileAtomic(file, `${JSON.stringify(record, null, 2)}\n`)
    try {
      await internals.beforeAdd?.()
      await gitOk(['-C', clone, 'worktree', 'add', '--no-track', '-b', record.branch, path, commit], this.#options(signal))
    } catch (error) {
      await rm(file, { force: true }).catch(() => {})
      throw new Error(`${project.name}: couldn't make worktree ${slug}: ${messageOf(error)}`, { cause: error })
    }
    await internals.afterAdd?.()
    // Where git put it, by git's own record (the real path it wrote), and what `path` is now.
    const landed = (await worktreeEntries(clone)).find(entry => entry.branch === `refs/heads/${record.branch}`)?.path
    if (landed !== path || await realpath(path).catch(() => undefined) !== path) {
      await this.#undo(project, clone, record, landed, path)
    }
    return { project: project.name, slug, branch: record.branch, path, clone, base: commit, setup: worktreeSetup(project, path) }
  }

  /** Every linked worktree of the clone (not its main checkout), in git's order; `merged` is computed for managed ones only. */
  async list(project: Project): Promise<WorktreeInfo[]> {
    const clone = await this.#checkedClone(project)
    const defaultBranch = await defaultBranchOf(this.#deps, clone)
    const records = new Map((await this.records(project)).map(record => [record.slug, record]))
    // For display only: the clone's own origin/<default>. Removal (remove, the sweep) asks GitHub instead.
    const local = await localDefault(clone, defaultBranch)
    const infos: WorktreeInfo[] = []
    const linked = (await worktreeEntries(clone)).slice(1).filter(entry => !entry.prunable)
    for (const entry of linked) {
      const { path } = entry
      const name = dirname(path) === join(clone, '.worktrees') ? basename(path) : undefined
      const record = name === undefined ? undefined : records.get(name)
      const bound = (await this.#deps.bindings(path)).map(({ child, role, title, running }) => ({ child, role, title, running }))
      if (record !== undefined) {
        const state = await this.inspect(project, record)
        const merged = await checkMerged(project, state, local, this.#deps).then(check => check.merged, () => false)
        const dirty = state.problem !== undefined || await this.dirty(clone, path, record.branch).then(why => why !== undefined, () => true)
        const counts = await aheadBehind(clone, defaultBranch, state.tip ?? entry.head)
        infos.push({ project: project.name, slug: record.slug, branch: record.branch, path, clone, base: record.base, ...counts, dirty, merged, managed: true, bound })
      } else {
        const dirty = await this.dirty(clone, path).then(why => why !== undefined, () => true)
        const counts = await aheadBehind(clone, defaultBranch, entry.head)
        const branch = entry.branch?.replace(/^refs\/heads\//, '') ?? ''
        infos.push({ project: project.name, slug: basename(path), branch, path, clone, base: '', ...counts, dirty, merged: false, managed: false, bound })
      }
    }
    return infos
  }

  /**
   * Managed only. Refused while a running coder is bound (force or not), and for a worktree whose `.git` isn't what git
   * made; without `force`, refused unless merged and clean. Then `worktree remove` (`--force` only with `force`), the
   * branch, the record and its setup log.
   */
  async remove(project: Project, slug: string, force: boolean): Promise<void> {
    const record = SLUG.test(slug) ? await this.#record(project, slug) : undefined
    if (record === undefined) {
      throw new Error(`${project.name} has no worktree ${quote(slug)} that dish made; dish never removes a worktree it didn't make`)
    }
    const state = await this.inspect(project, record)
    const running = (await this.#deps.bindings(state.path)).filter(binding => binding.running)
    if (running.length > 0) {
      const who = running.map(binding => `${binding.child} (${binding.role}, ${quote(binding.title)})`).join(', ')
      throw new Error(`worktree ${slug} is bound to a running coder: ${who}; wait for it to finish, even with force`)
    }
    if (state.problem !== undefined) throw new Error(`worktree ${slug} can't be removed: ${state.problem}`)
    if (!force) {
      const merge = await checkMerged(project, state, githubWord(state.clone), this.#deps)
      if (!merge.merged) throw new Error(`worktree ${slug} isn't merged (${merge.reason ?? 'unknown'}); pass force to remove it anyway`)
      if (state.exists) {
        const dirty = await this.dirty(state.clone, state.path, record.branch)
        if (dirty !== undefined) throw new Error(`worktree ${slug} has work removing it would lose (${dirty}); pass force to remove it anyway`)
      }
    }
    await this.discard(project, state, force)
  }

  /**
   * `<project>/<slug>` (the project matched case-insensitively among `projects`) or the absolute path of a worktree
   * (any spelling: it's `realpath`'d, so crew's canonical record path works). Only a managed worktree with its record,
   * its directory, its branch, and a `checkWorktree` that passes, in a clone that `checkClone` passes. Marks it
   * recently resolved. Anything else is `undefined`.
   */
  async resolve(ref: string, projects: readonly Project[]): Promise<Worktree | undefined> {
    const found = await this.#find(ref, projects)
    if (found === undefined) return undefined
    const { project, clone, slug } = found
    const record = await this.#record(project, slug)
    if (record === undefined) return undefined
    if (!(await checkClone(clone, this.#deps.cloneExpectations(project))).ok) return undefined
    if (!await isDirectory(join(clone, '.worktrees'))) return undefined
    const path = join(clone, '.worktrees', slug)
    if (!(await checkWorktree(clone, path)).ok) return undefined
    if (await branchTip(clone, record.branch) === undefined) return undefined
    this.#resolved.set(path, this.#now())
    return { project: project.name, slug, branch: record.branch, path, clone, base: record.base }
  }

  /** Whether `resolve` gave the worktree at `path` (canonical, as `resolve` returns it) within the last 5 minutes. */
  recentlyResolved(path: string): boolean {
    const now = this.#now()
    for (const [key, at] of this.#resolved) if (now - at >= RECENT_RESOLVE_MS) this.#resolved.delete(key)
    const at = this.#resolved.get(path)
    return at !== undefined && now - at < RECENT_RESOLVE_MS
  }

  /** The project's records, by slug. A file that isn't a whole, consistent record is skipped (its worktree is then not dish's). */
  async records(project: Project): Promise<WorktreeRecord[]> {
    const dir = join(projectStateDir(this.#deps.state, project.owner, project.repo), 'worktrees')
    let names: string[]
    try {
      names = await readdir(dir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const records: WorktreeRecord[] = []
    for (const name of names.sort()) {
      const slug = /^(.+)\.json$/.exec(name)?.[1]
      if (slug === undefined || !SLUG.test(slug)) continue
      const record = await this.#record(project, slug)
      if (record !== undefined) records.push(record)
    }
    return records
  }

  /** For `remove` and the sweep: the clone (checked), the canonical path, what's there, the branch's tip, and `checkWorktree`'s word. */
  async inspect(project: Project, record: WorktreeRecord): Promise<WorktreeState> {
    const clone = await this.#checkedClone(project)
    const path = resolve(join(clone, '.worktrees', record.slug))
    const exists = await present(path)
    const tip = await branchTip(clone, record.branch)
    let problem: string | undefined
    if (exists && !await isDirectory(join(clone, '.worktrees'))) {
      problem = `${join(clone, '.worktrees')} is not a directory (a link?)`
    } else if (exists) {
      const check = await checkWorktree(clone, path)
      if (!check.ok) problem = check.problem
    }
    return { record, clone, path, exists, tip, problem }
  }

  /**
   * Why the worktree at `path` has work that removing it would lose, or `undefined` if it has none. `checkWorktree`
   * first (a refusal throws). With `branch`, it must have that branch checked out. Then: `status` with untracked files
   * (ignored ones don't count); another worktree of the clone inside it (`.worktrees/` is in the clone's shared
   * `info/exclude`, so a worktree nested at `<path>/.worktrees/<name>` is an ignored folder to `status`); and nested
   * repositories, whose own edits `--ignore-submodules=dirty` hides and whose history removal would delete: a gitlink
   * in its index, or a `.git` in a folder git tracks (one in an untracked folder shows in `status`; one in an ignored
   * folder is an ignored file, a known limit).
   */
  async dirty(clone: string, path: string, branch?: string): Promise<string | undefined> {
    const check = await checkWorktree(clone, path)
    if (!check.ok) throw new Error(check.problem)
    const dir = resolve(path)
    if (branch !== undefined) {
      const head = await git(['-C', dir, 'symbolic-ref', '--quiet', 'HEAD'], this.#options())
      const ref = head.code === 0 ? head.stdout.trim() : undefined
      if (ref !== `refs/heads/${branch}`) return ref === undefined ? `a detached HEAD, not ${branch}, is checked out` : `${shown(ref.replace(/^refs\/heads\//, ''), 100)}, not ${branch}, is checked out`
    }
    const status = await gitOk(['-C', dir, '--no-optional-locks', 'status', '--porcelain', '-z', '--untracked-files=normal', '--ignore-submodules=dirty'], this.#options())
    const changed = status.split('\0').filter(entry => entry !== '')
    if (changed.length > 0) return `${shown(changed[0]!, 120)}${changed.length > 1 ? ` and ${changed.length - 1} more` : ''}`
    const inner = nestedWorktree(await worktreeEntries(clone), dir)
    if (inner !== undefined) return `it holds another worktree (${shown(inner, 200)})`
    const modes = await gitOk(['-C', dir, 'ls-files', '-z', '--format=%(objectmode)'], this.#options())
    if (modes.length >= GIT_OUTPUT_CAP - 16) return 'too many files to check for nested repositories'
    if (modes.split('\0').includes('160000')) return 'it has a nested repository (a gitlink, as a submodule is)'
    const folders = await gitOk(['-C', dir, 'ls-tree', '-r', '-d', '-z', '--name-only', 'HEAD'], this.#options())
    if (folders.length >= GIT_OUTPUT_CAP - 16) return 'too many folders to check for nested repositories'
    for (const folder of folders.split('\0')) {
      if (folder !== '' && await present(join(dir, folder, '.git'))) return `it has a nested repository (${shown(folder, 100)})`
    }
    return undefined
  }

  /**
   * For `remove` and the sweep, once they've decided. Refused, with everything kept, when another worktree is inside this
   * one (force or not: it isn't this worktree's to delete) or when another worktree (the clone's own checkout included)
   * has its branch checked out. Then, with something at the path, `checkWorktree` again and `git worktree remove` on the
   * resolved path (`--force` only with `force`); with nothing there, `git worktree remove` on the path only if git still
   * has an entry for it (never `git worktree prune`, which would drop other worktrees' entries too). Then the branch,
   * only if it is still at the tip `inspect` found (`update-ref -d <ref> <tip>`), so a commit made since stays; then the
   * record and its setup log.
   */
  async discard(project: Project, state: WorktreeState, force: boolean): Promise<void> {
    const { clone, record, tip } = state
    const path = resolve(state.path)
    const entries = await worktreeEntries(clone)
    const inner = nestedWorktree(entries, path)
    if (inner !== undefined) {
      const shownInner = shown(inner, 200)
      throw new Error(`worktree ${record.slug} holds another worktree (${shownInner}); dish won't remove it, even with force: remove it first (\`git worktree remove ${shownInner}\`), then try again`)
    }
    const other = entries.find(entry => entry.branch === `refs/heads/${record.branch}` && !entry.at(path))
    if (other !== undefined) {
      throw new Error(`${record.branch} is checked out in ${shown(other.path, 200)}; dish keeps the branch, worktree ${record.slug} and its record`)
    }
    if (state.exists) {
      const check = await checkWorktree(clone, path)
      if (!check.ok) throw new Error(`worktree ${record.slug} can't be removed: ${check.problem}`)
      await gitOk(['-C', clone, 'worktree', 'remove', ...(force ? ['--force'] : []), path], this.#options())
    } else if (entries.some(entry => entry.at(path))) {
      // git 2.47 removes the entry of a worktree whose directory is gone, and only that one, without --force.
      await gitOk(['-C', clone, 'worktree', 'remove', path], this.#options())
    }
    if (tip !== undefined) await gitOk(['-C', clone, 'update-ref', '-d', `refs/heads/${record.branch}`, tip], this.#options())
    await rm(this.#recordFile(project, record.slug), { force: true })
    await rm(worktreeSetupLogFile(this.#deps.state, project.owner, project.repo, record.slug), { force: true })
    this.#resolved.delete(path)
  }

  /**
   * `create`'s worktree didn't land at its canonical path (`.worktrees` changed under git: a link swapped in, maybe
   * swapped back since). What git made is dish's, so it is removed where git put it: `checkWorktree` on that real path,
   * then `git worktree remove --force` there; only if that worked are the branch and the record removed too. Always
   * throws, saying which happened.
   */
  async #undo(project: Project, clone: string, record: WorktreeRecord, landed: string | undefined, path: string): Promise<never> {
    const where = `worktree ${record.slug} landed at ${shown(landed ?? 'a path git has no record of', 200)}, not ${path} (.worktrees changed while it was made)`
    let failure: string | undefined
    if (landed === undefined) {
      failure = `git has no worktree on ${record.branch}`
    } else {
      const check = await checkWorktree(clone, landed)
      if (!check.ok) failure = check.problem
      else failure = await gitOk(['-C', clone, 'worktree', 'remove', '--force', landed], this.#options()).then(() => undefined, (error: unknown) => messageOf(error))
    }
    if (failure === undefined) {
      await gitOk(['-C', clone, 'update-ref', '-d', `refs/heads/${record.branch}`, record.base], this.#options()).catch(() => {})
      await rm(this.#recordFile(project, record.slug), { force: true }).catch(() => {})
      throw new Error(`${project.name}: ${where}; dish removed it`)
    }
    const by = landed === undefined ? '' : `: git -C ${clone} worktree remove --force ${shown(landed, 200)}, then git -C ${clone} branch -D ${record.branch}`
    throw new Error(`${project.name}: ${where}, and dish couldn't remove it there (${shown(failure, 200)}), so its branch ${record.branch} and its record are kept; remove it yourself${by}`)
  }

  #now(): number {
    return (this.#deps.now ?? Date.now)()
  }

  #options(signal?: AbortSignal): { signal?: AbortSignal, env: Record<string, string> } {
    return { signal, env: { ...internals.gitEnv } }
  }

  #recordFile(project: Project, slug: string): string {
    return worktreeRecordFile(this.#deps.state, project.owner, project.repo, slug)
  }

  /** The project's clone, canonical, after `checkClone` passes with the project's expectations. */
  async #checkedClone(project: Project): Promise<string> {
    const where = clonePath(this.#deps.workRoot, project.owner, project.repo)
    let clone: string
    try {
      clone = await realpath(where)
    } catch {
      throw new Error(`${project.name} has no clone at ${where}`)
    }
    await this.#check(project, clone)
    return clone
  }

  async #check(project: Project, clone: string): Promise<void> {
    const result = await checkClone(clone, this.#deps.cloneExpectations(project))
    if (!result.ok) throw new Error(`dish won't work in ${project.name}'s clone (${clone}): ${result.problem}`)
  }

  /** Refuse a slug that's in use: its record, anything at its path, or its branch. */
  async #free(project: Project, clone: string, slug: string, path: string, signal?: AbortSignal): Promise<void> {
    const used = await present(this.#recordFile(project, slug)) ? 'its record'
      : await present(path) ? `.worktrees/${slug}`
        : await branchTip(clone, `dish/${slug}`, signal) !== undefined ? `the branch dish/${slug}` : undefined
    if (used !== undefined) throw new Error(`worktree ${slug} is in use in ${project.name} (${used} exists); pick another name`)
  }

  async #record(project: Project, slug: string): Promise<WorktreeRecord | undefined> {
    let text: string
    try {
      text = await readFile(this.#recordFile(project, slug), 'utf8')
    } catch {
      return undefined
    }
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      return undefined
    }
    if (typeof value !== 'object' || value === null) return undefined
    const record = value as Record<string, unknown>
    if (typeof record.project !== 'string' || record.project.toLowerCase() !== project.name.toLowerCase()) return undefined
    if (record.slug !== slug || record.branch !== `dish/${slug}`) return undefined
    if (typeof record.base !== 'string' || !SHA.test(record.base) || typeof record.baseRef !== 'string') return undefined
    if (typeof record.createdAt !== 'number' || !Number.isFinite(record.createdAt)) return undefined
    return { project: record.project, slug, branch: record.branch, base: record.base, baseRef: record.baseRef, createdAt: record.createdAt }
  }

  /** The project and slug `ref` names: `<project>/<slug>`, or the canonical path `<clone>/.worktrees/<slug>`. */
  async #find(ref: string, projects: readonly Project[]): Promise<{ project: Project, clone: string, slug: string } | undefined> {
    if (typeof ref !== 'string' || ref === '') return undefined
    if (isAbsolute(ref)) {
      const real = await realpath(ref).catch(() => undefined)
      if (real === undefined) return undefined
      for (const project of projects) {
        const clone = await realpath(clonePath(this.#deps.workRoot, project.owner, project.repo)).catch(() => undefined)
        if (clone === undefined || dirname(real) !== join(clone, '.worktrees')) continue
        const slug = basename(real)
        return SLUG.test(slug) ? { project, clone, slug } : undefined
      }
      return undefined
    }
    const at = ref.lastIndexOf('/')
    if (at < 0) return undefined
    const name = ref.slice(0, at).toLowerCase()
    const slug = ref.slice(at + 1)
    const project = projects.find(item => item.name.toLowerCase() === name)
    if (project === undefined || !SLUG.test(slug)) return undefined
    const clone = await realpath(clonePath(this.#deps.workRoot, project.owner, project.repo)).catch(() => undefined)
    return clone === undefined ? undefined : { project, clone, slug }
  }
}

/** Refuse a base that isn't plausibly a revision: empty, too long, an option, or with a control character. */
function checkBase(base: string): void {
  if (typeof base !== 'string' || base === '' || base.length > MAX_BASE || base.startsWith('-') || /[\x00-\x1f\x7f]/.test(base)) {
    throw new Error(`base ${quote(String(base))} can't be a base: give a branch, a tag or a commit`)
  }
}

/**
 * The calling chat's workspace (`cwd`, canonical) must be the clone or inside it, and hold `path`: a coder of that chat
 * works in its sandbox, which is its workspace.
 */
async function insideWorkspace(project: Project, clone: string, path: string, cwd: string): Promise<void> {
  const where = `start a chat in ${project.name}'s workspace (${clone})`
  if (typeof cwd !== 'string' || cwd === '') throw new Error(`this chat has no workspace, so a coder couldn't write in a worktree; ${where}`)
  const root = await realpath(cwd).catch(() => undefined)
  if (root === undefined) throw new Error(`this chat's workspace (${cwd}) can't be read, so a coder couldn't write in a worktree; ${where}`)
  if (!within(root, clone) || !within(path, root)) {
    throw new Error(`worktree ${path} would be outside this chat's workspace (${root}), where a coder couldn't write; ${where}`)
  }
}

/** Whether `path` is `root` or inside it (both canonical). */
function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root === '/' ? '/' : `${root}/`)
}

/** `<clone>/.worktrees`, made if missing; a link or anything but a directory there is refused. */
async function worktreesDir(clone: string): Promise<void> {
  const dir = join(clone, '.worktrees')
  try {
    await mkdir(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const stats = await lstat(dir)
  if (!stats.isDirectory()) throw new Error(`${dir} is not a directory (${stats.isSymbolicLink() ? 'a symbolic link' : 'a file'}); dish won't make a worktree there`)
}

/** Whether `path` is a directory itself, not a link to one. */
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory()
  } catch {
    return false
  }
}

/** Whether anything (a link included) is at `path`. */
async function present(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

/** `revision`'s commit in `clone`, or undefined. */
async function commitOf(clone: string, revision: string, signal?: AbortSignal): Promise<string | undefined> {
  const result = await git(['-C', clone, 'rev-parse', '--verify', '--quiet', '--end-of-options', `${revision}^{commit}`], { signal, env: { ...internals.gitEnv } })
  const sha = result.stdout.trim()
  return result.code === 0 && SHA.test(sha) ? sha : undefined
}

/** `refs/heads/<branch>`'s commit, or undefined when there's no such branch. */
function branchTip(clone: string, branch: string, signal?: AbortSignal): Promise<string | undefined> {
  return commitOf(clone, `refs/heads/${branch}`, signal)
}

/** `rev-list --left-right --count refs/remotes/origin/<default>...<sha>`; zeros when it can't be told. */
async function aheadBehind(clone: string, defaultBranch: string, sha: string | undefined): Promise<{ ahead: number, behind: number }> {
  if (sha === undefined || !SHA.test(sha)) return { ahead: 0, behind: 0 }
  const result: GitResult = await git(['-C', clone, 'rev-list', '--left-right', '--count', `refs/remotes/origin/${defaultBranch}...${sha}`], { env: { ...internals.gitEnv } })
  const counts = /^(\d+)\s+(\d+)\s*$/.exec(result.stdout)
  if (result.code !== 0 || counts === null) return { ahead: 0, behind: 0 }
  return { behind: Number(counts[1]), ahead: Number(counts[2]) }
}

interface WorktreeEntry {
  /** As git has it; canonical (`realpath`) when the directory is there. */
  path: string
  head: string | undefined
  /** `refs/heads/<name>`, or undefined when detached. */
  branch: string | undefined
  /** Its directory is gone. */
  prunable: boolean
  /** Whether this entry is the worktree at `path` (canonical): by git's spelling or by its real path. */
  at(path: string): boolean
}

/** `git worktree list --porcelain -z`: every worktree of the clone, its own checkout first, with canonical paths. */
async function worktreeEntries(clone: string): Promise<WorktreeEntry[]> {
  const text = await gitOk(['-C', clone, 'worktree', 'list', '--porcelain', '-z'], { env: { ...internals.gitEnv } })
  const raw: Array<{ path: string, head?: string, branch?: string, prunable: boolean }> = []
  for (const field of text.split('\0')) {
    if (field === '') continue
    const space = field.indexOf(' ')
    const key = space < 0 ? field : field.slice(0, space)
    const value = space < 0 ? '' : field.slice(space + 1)
    const current = raw.at(-1)
    if (key === 'worktree') raw.push({ path: value, prunable: false })
    else if (current === undefined) continue
    else if (key === 'HEAD') current.head = value
    else if (key === 'branch') current.branch = value
    else if (key === 'prunable') current.prunable = true
  }
  return Promise.all(raw.map(async entry => {
    const spelled = resolve(entry.path)
    const real = await realpath(spelled).catch(() => spelled)
    return { path: real, head: entry.head, branch: entry.branch, prunable: entry.prunable, at: (path: string) => path === real || path === spelled }
  }))
}

/** The first worktree in `entries` strictly inside `path` (canonical), if any; one whose directory is gone holds nothing to lose. */
function nestedWorktree(entries: readonly WorktreeEntry[], path: string): string | undefined {
  return entries.find(entry => !entry.prunable && !entry.at(path) && entry.path.startsWith(`${path}/`))?.path
}

/** The clone's own `refs/remotes/origin/<default>`, as a target for `list`'s display of merged (never for removal). */
async function localDefault(clone: string, defaultBranch: string): Promise<GitHubDefault> {
  const sha = await commitOf(clone, `refs/remotes/origin/${defaultBranch}`)
  return sha === undefined ? { reason: `origin/${defaultBranch} isn't in the clone` } : { branch: defaultBranch, sha }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A name from outside (a slug, a base, a title) in a message: shown safely, in quotes. */
function quote(text: string): string {
  return JSON.stringify(shown(text, 80))
}
