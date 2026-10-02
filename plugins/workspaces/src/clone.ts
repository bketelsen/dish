/**
 * A project's clone: onboarding's steps 2 (clone or adopt) and 3 (configure), and its fetch.
 *
 * - **Clone or adopt.** `<work root>/<owner>/<repo>` is adopted when it is a clone of the project (`.git` a directory,
 *   one `origin` that is the repo on GitHub, over HTTPS or SSH) whose config passes `checkClone`; an SSH origin is
 *   switched to HTTPS, and nothing else is written. Anything else there is refused with what was found, and left as it
 *   was: nothing in it is written, moved or removed. With nothing there, the repo is cloned into a temporary directory
 *   beside it (`.<repo>.cloning-<8 hex>`, made by dish), with the credential helper given only as `-c` flags of the
 *   clone command, then renamed into place. A failed or aborted clone removes that temporary directory, and only it.
 * - **The owner directory** (`<work root>/<owner>`) must be the work root's own: one that leads elsewhere (a link) is
 *   refused before anything else, so neither a clone nor its workspace lands outside the work root.
 * - **Configure.** The contract's keys: the credential pair (an empty helper, which drops any helper from the global
 *   config for the URL, then dish's), `useHttpPath`, `credential.interactive=false`, the App's bot identity, the HTTPS
 *   `origin`, and `.worktrees/` in `.git/info/exclude` once. The credential keys are replaced before the check, so a
 *   clone whose helper path is from an older checkout (before a `dish-update`) passes; then `checkClone` with every
 *   expectation. It runs again at every start, so a changed key is put back.
 * - **Writing a clone's files** (its `.git/config`, its exclude file, and adopt's switch of `origin`): agents can swap
 *   any of them, or `.git` itself, for a link to another repository's (the config store's, say), and git's own
 *   `git config --file` writes through a link to its target. So dish pins `.git` (by `lstat`: a directory, its device and
 *   inode), reads the file through a handle that follows no link and refuses one with another hard link, edits a
 *   private copy under dish's state directory with `git config --file <copy>` (from `/`, no system or global config:
 *   nothing of the clone's runs), and writes the result back through one handle that follows no link, only if it is
 *   still the file it read (device, inode, one link) and `.git` is still the directory it pinned. A config the edit
 *   doesn't change isn't written.
 * - **Fetch.** `checkClone` first, then `git fetch --prune origin +refs/heads/*:refs/remotes/origin/*`: the refspec on
 *   the command line, so a refspec written into the config can't fetch elsewhere or keep a hand-written origin ref
 *   alive. Then `git remote set-head origin --auto` every time, so an `origin/HEAD` an agent repointed is GitHub's again
 *   before `defaultBranch` reads it. Records `lastFetch` in the clone state.
 *
 * No token is ever in an argument, a URL, an environment variable or a config value: git asks the helper, which reads
 * the token file. Every message is masked.
 *
 * Known limits:
 * - `.git` is checked by path just before the file is opened again to write it: an agent that swaps `.git` for a link
 *   and back within the microseconds between those two steps, having done the same while dish read the file, could
 *   still get the edited config written into the file it linked to. A sub-millisecond window, closed fully only when
 *   dish's work in a clone runs inside the sandbox (6c's sandboxed runner); likewise the spec's race between the clone
 *   check and the next git command;
 * - a temporary directory left by a crash (dish killed mid-clone) stays: dish can't tell it from one it didn't make.
 *   It is `.<repo>.cloning-<8 hex>` beside the clone, for the user to remove.
 *
 * @module dish-workspaces/clone
 */

import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { Project } from 'dish-projects/registry'
import { maskSecrets } from 'dish-kit'
import { git, gitOk, maskUrlPasswords } from './git.ts'
import type { GitResult } from './git.ts'
import { cloneStateFile, clonePath, helperValue, projectStateDir, tokensDir } from './paths.ts'
import { ORIGIN_FETCH, checkClone } from './safety.ts'
import { readCloneState, writeCloneState } from './state.ts'
import type { CloneState } from './state.ts'
import type { TokenManager } from './tokens.ts'

/** How long a clone may take before its process group is killed. */
export const CLONE_TIMEOUT_MS = 30 * 60_000
/** How long a fetch (and `remote set-head`) may take. */
export const FETCH_TIMEOUT_MS = 10 * 60_000
/** How long a `git config --file` may take: one small file. */
const CONFIG_TIMEOUT_MS = 10_000
/** `git config --file` reads nothing else: no system config, no global config. */
const CONFIG_ENV: Readonly<Record<string, string>> = Object.freeze({ GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' })
/** The line `.git/info/exclude` gets. */
const EXCLUDE_LINE = '.worktrees/'
/** The most of a clone's `.git/config` or `.git/info/exclude` that is read. */
const MAX_CLONE_FILE_BYTES = 1024 * 1024
/** The most characters of something from outside (a URL, git's stderr) a message shows. */
const MAX_SHOWN = 200

/**
 * For tests only, never set by dish: `gitEnv` is put on top of the environment of the network gits here (a test's
 * `GIT_CONFIG_NOSYSTEM`); `beforeWrite` is called with a clone's file just before dish's last checks and its write
 * back, where a test plays an agent swapping the file.
 */
export const internals: { gitEnv?: Record<string, string>, beforeWrite?: (file: string) => Promise<void> | void } = {}

// --- the error --------------------------------------------------------------------------------------------------------

export type OnboardStep = 'installation' | 'clone' | 'configure' | 'setup' | 'workspace'

/** A step of onboarding that failed. Its message is masked (`maskSecrets`, and passwords in URLs). */
export class OnboardError extends Error {
  readonly step: OnboardStep

  constructor(step: OnboardStep, message: string) {
    super(mask(message))
    this.name = 'OnboardError'
    this.step = step
  }
}

/** An abort, as dish-projects reads one (`name === 'AbortError'`). */
export function abortError(what: string): Error {
  const error = new Error(`${what} was aborted`)
  error.name = 'AbortError'
  return error
}

function mask(text: string): string {
  return maskSecrets(maskUrlPasswords(text))
}

/** Text from outside (a URL, git's stderr) as a message may show it: one line, masked, cut short. */
function shown(text: string, max = MAX_SHOWN): string {
  const masked = mask(text.slice(0, 64 * 1024).replace(/[\x00-\x1f\x7f]+/g, ' ').trim())
  const chars = Array.from(masked)
  return chars.length > max ? mask(`${chars.slice(0, max - 1).join('')}…`) : masked
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** git's last `fatal:` or `error:` line, else its first non-empty one: shown. */
function gitFailure(result: GitResult): string {
  const lines = result.stderr.split(/[\r\n]+/).map(line => line.trim()).filter(line => line !== '')
  const line = [...lines].reverse().find(item => /^(?:fatal|error):/.test(item)) ?? lines[0] ?? ''
  return shown(line)
}

// --- names ------------------------------------------------------------------------------------------------------------

export interface CloneDeps {
  /** dish-kit's `workRoot()`. */
  workRoot: string
  /** dish-kit's `xdgPaths('dish').state`. */
  state: string
  /** GitHub's web origin (`https://github.com`); a test's fake git server. */
  web: string
  /** The credential helper's absolute path. */
  helper: string
  tokens: Pick<TokenManager, 'ensureFileToken'>
  logger: { warn(format: string, ...args: unknown[]): void, info(format: string, ...args: unknown[]): void }
}

/** `web` without a trailing slash: how it is spelled in a credential key and a URL. */
function originOf(web: string): string {
  return web.replace(/\/+$/, '')
}

/** `<web>/<owner>/<repo>.git` */
export function httpsUrl(web: string, owner: string, repo: string): string {
  return `${originOf(web)}/${owner}/${repo}.git`
}

/**
 * https://github.com/o/r(.git), git@github.com:o/r(.git), ssh://git@github.com/o/r(.git); case-insensitive; `web`
 * stands for https://github.com in tests. Nothing else: no credentials in the URL, no other scheme, port or host
 * (an SSH host alias included), no trailing slash.
 */
export function originMatches(url: string, web: string, owner: string, repo: string): boolean {
  let base: URL
  try {
    base = new URL(web)
  } catch {
    return false
  }
  const host = base.hostname.toLowerCase()
  const lower = url.toLowerCase()
  const prefixes = [`${base.origin.toLowerCase()}/`, `git@${host}:`, `ssh://git@${host}/`]
  const prefix = prefixes.find(item => lower.startsWith(item))
  if (prefix === undefined) return false
  const path = lower.slice(prefix.length)
  const bare = path.endsWith('.git') ? path.slice(0, -'.git'.length) : path
  return bare === `${owner}/${repo}`.toLowerCase()
}

/** The credential helper's value for this instance. */
function helperOf(deps: CloneDeps): string {
  return helperValue(deps.helper, tokensDir(deps.state), originOf(deps.web))
}

// --- files ------------------------------------------------------------------------------------------------------------

type Kind = 'missing' | 'directory' | 'file' | 'link' | 'other'

/** What is at `path`, without following a link. */
async function kindOf(path: string): Promise<Kind> {
  try {
    const stats = await lstat(path)
    return stats.isSymbolicLink() ? 'link' : stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : 'other'
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return 'missing'
    if (code === 'ENOTDIR') return 'missing'
    throw error
  }
}

/** `.git` a real directory and `.git/config` a regular file (neither a link), or what is wrong. */
async function layoutProblem(clone: string): Promise<string | undefined> {
  const dotGit = await kindOf(join(clone, '.git'))
  if (dotGit === 'missing') return "it isn't a clone (it has no .git)"
  if (dotGit !== 'directory') return ".git is not a directory (a linked worktree's or a submodule's .git file, or a link)"
  const config = await kindOf(join(clone, '.git', 'config'))
  if (config === 'missing') return '.git/config is missing'
  if (config !== 'file') return '.git/config is not a regular file'
  return undefined
}

// --- git config --file ------------------------------------------------------------------------------------------------

/** `git config --file <file> ...args` from `/`, reading no other config. */
function configGit(file: string, args: readonly string[]): Promise<GitResult> {
  return git(['config', '--file', file, ...args], { cwd: '/', timeoutMs: CONFIG_TIMEOUT_MS, env: { ...CONFIG_ENV } })
}

/** Every value of `key` in `file` (without includes); `[]` when it has none. Throws when the file can't be read. */
async function configValues(file: string, key: string): Promise<string[]> {
  const result = await configGit(file, ['--no-includes', '--null', '--get-all', key])
  if (result.code === 1 && !result.timedOut) return []
  if (result.code !== 0 || result.timedOut || result.aborted) throw new Error(`.git/config can't be read: ${gitFailure(result)}`)
  return result.stdout.split('\0').slice(0, -1)
}

/** Write with `git config --file`; `ok` are the exit codes that aren't failures. */
async function configWrite(file: string, args: readonly string[], ok: readonly number[], step: OnboardStep): Promise<void> {
  const result = await configGit(file, args)
  if (ok.includes(result.code) && !result.timedOut && !result.aborted) return
  throw new OnboardError(step, `git config ${args[0]} ${args[1] ?? ''} failed (exit ${result.code}): ${gitFailure(result)}`)
}

// --- writing a clone's files ------------------------------------------------------------------------------------------

/** What a directory or file was when dish looked: whether it is still the same one. */
interface Identity { dev: bigint, ino: bigint }

function codeOf(error: unknown): string {
  return (error as NodeJS.ErrnoException).code ?? messageOf(error)
}

/** `dir` (not followed if a link) as a directory: its identity. */
async function pinDirectory(dir: string, name: string, step: OnboardStep): Promise<Identity> {
  let stats
  try {
    stats = await lstat(dir, { bigint: true })
  } catch (error) {
    throw new OnboardError(step, codeOf(error) === 'ENOENT' ? `${name} is missing` : `${name} can't be read (${codeOf(error)})`)
  }
  if (!stats.isDirectory()) throw new OnboardError(step, `${name} is not a directory (a link, or something else)`)
  return { dev: stats.dev, ino: stats.ino }
}

/** `dir` is still the directory pinned; else nothing is written. */
async function stillDirectory(dir: string, pinned: Identity, name: string, step: OnboardStep): Promise<void> {
  const now = await pinDirectory(dir, name, step)
  if (now.dev !== pinned.dev || now.ino !== pinned.ino) {
    throw new OnboardError(step, `${name} was replaced while dish was configuring the clone; dish wrote nothing`)
  }
}

/**
 * A clone's file, read through a handle that follows no link and doesn't wait on a FIFO: its bytes and identity, or
 * `undefined` when it is missing. Refused unless it is a regular file with one link: a hard link to another file would
 * have dish's write land there too.
 */
async function readPinned(file: string, name: string, step: OnboardStep): Promise<{ bytes: Buffer, id: Identity } | undefined> {
  let handle: FileHandle
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return undefined
    throw new OnboardError(step, codeOf(error) === 'ELOOP' ? `${name} is a symbolic link` : `${name} can't be read (${codeOf(error)})`)
  }
  try {
    const stats = await handle.stat({ bigint: true })
    if (!stats.isFile()) throw new OnboardError(step, `${name} is not a regular file`)
    if (stats.nlink !== 1n) throw new OnboardError(step, `${name} has another hard link; dish won't write through it`)
    if (stats.size > BigInt(MAX_CLONE_FILE_BYTES)) throw new OnboardError(step, `${name} is too large`)
    return { bytes: await handle.readFile(), id: { dev: stats.dev, ino: stats.ino } }
  } finally {
    await handle.close()
  }
}

/** Write through one handle that follows no link, only if it is still the file read (`id`) with one link. */
async function writePinned(file: string, id: Identity, name: string, step: OnboardStep, write: (handle: FileHandle) => Promise<void>, append = false): Promise<void> {
  const replaced = new OnboardError(step, `${name} was replaced while dish was configuring the clone; dish wrote nothing`)
  let handle: FileHandle
  try {
    handle = await open(file, constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (append ? constants.O_APPEND : 0))
  } catch {
    throw replaced
  }
  try {
    const stats = await handle.stat({ bigint: true })
    if (!stats.isFile() || stats.nlink !== 1n || stats.dev !== id.dev || stats.ino !== id.ino) throw replaced
    await write(handle)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** All of `bytes` at `position` (or appended), however the writes split it. */
async function writeAll(handle: FileHandle, bytes: Buffer, position: number | null): Promise<void> {
  let done = 0
  while (done < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, done, bytes.length - done, position === null ? null : position + done)
    done += bytesWritten
  }
}

/**
 * Edit a clone's `.git/config` with `git config --file` on a private copy under dish's state directory, and write the
 * result back as the module says (`.git` pinned, the file read and written through handles that follow no link, the
 * write only to the file read). Nothing is written when the edits change nothing.
 */
async function editConfig(clone: string, project: Project, deps: CloneDeps, step: OnboardStep, edits: ReadonlyArray<{ args: readonly string[], ok?: readonly number[] }>): Promise<void> {
  const dotGit = join(clone, '.git')
  const file = join(dotGit, 'config')
  const pinned = await pinDirectory(dotGit, '.git', step)
  const read = await readPinned(file, '.git/config', step)
  if (read === undefined) throw new OnboardError(step, '.git/config is missing')
  await stillDirectory(dotGit, pinned, '.git', step)

  const scratch = projectStateDir(deps.state, project.owner, project.repo)
  await mkdir(scratch, { recursive: true, mode: 0o700 })
  const copy = join(scratch, `.config-edit-${randomBytes(6).toString('hex')}`)
  try {
    await writeFile(copy, read.bytes, { flag: 'wx', mode: 0o600 })
    for (const edit of edits) await configWrite(copy, edit.args, edit.ok ?? [0], step)
    const edited = await readFile(copy)
    if (edited.equals(read.bytes)) return
    await internals.beforeWrite?.(file)
    await stillDirectory(dotGit, pinned, '.git', step)
    await writePinned(file, read.id, '.git/config', step, async handle => {
      await handle.truncate(0)
      await writeAll(handle, edited, 0)
    })
  } finally {
    await rm(copy, { force: true }).catch(() => {})
    await rm(`${copy}.lock`, { force: true }).catch(() => {})
  }
}

/** Why `<work root>/<owner>`, when it is there, isn't the work root's own directory (a link out of it, say). */
async function ownerProblem(workRoot: string, owner: string): Promise<string | undefined> {
  if (await kindOf(owner) === 'missing') return undefined
  let real: string
  let root: string
  try {
    real = await realpath(owner)
    root = await realpath(workRoot)
  } catch (error) {
    return `can't be resolved (${codeOf(error)})`
  }
  return real === join(root, basename(owner)) ? undefined : `leads outside the work root (to ${shown(real)})`
}

/** A helper value in dish's shape (`!/bin/sh '<…/git-credential-dish>' '<tokens>' '<web>'`), whatever its paths. */
function isDishHelper(value: string, web: string): boolean {
  const quoted = web.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^!/bin/sh '/[^'\\x00-\\x1f\\x7f]*/git-credential-dish' '/[^'\\x00-\\x1f\\x7f]*' '${quoted}'$`).test(value)
}

// --- step 2: clone or adopt -------------------------------------------------------------------------------------------

/** Step 2. Adopt (origin matches, checkClone passes, SSH origin switched to HTTPS) or clone (temporary directory, helper via top-level -c only, rename into place). Anything else at the path: OnboardError('clone', what was found), untouched. */
export async function cloneOrAdopt(project: Project, deps: CloneDeps, signal?: AbortSignal): Promise<{ clone: string, adopted: boolean }> {
  if (signal?.aborted) throw abortError(`cloning ${project.name}`)
  const path = clonePath(deps.workRoot, project.owner, project.repo)
  // Before anything else: a clone found, or made, through a link would be outside the work root, and so its workspace.
  const owner = dirname(path)
  const problem = await ownerProblem(deps.workRoot, owner)
  if (problem !== undefined) throw new OnboardError('clone', `${owner} ${problem}; dish leaves it as it is and clones nothing there`)
  if (await kindOf(path) !== 'missing') return { clone: await adopt(path, project, deps), adopted: true }
  return { clone: await cloneFresh(path, project, deps, signal), adopted: false }
}

/** Adopt `path` if it is a clone of the project dish can work in; else refuse, having written nothing. Its real path. */
async function adopt(path: string, project: Project, deps: CloneDeps): Promise<string> {
  const web = originOf(deps.web)
  const refuse = (finding: string): OnboardError =>
    new OnboardError('clone', `${path} is there already, and dish can't adopt it: ${finding}. dish leaves it as it is; move it away or fix it, then retry`)

  const kind = await kindOf(path)
  if (kind === 'link') throw refuse('it is a symbolic link')
  if (kind !== 'directory') throw refuse('it is not a directory')
  const layout = await layoutProblem(path)
  if (layout !== undefined) throw refuse(layout)

  const config = join(path, '.git', 'config')
  let origins: string[]
  let helpers: string[]
  try {
    origins = await configValues(config, 'remote.origin.url')
    helpers = (await configValues(config, `credential.${web}.helper`)).filter(value => value !== '')
  } catch (error) {
    throw refuse(messageOf(error))
  }
  if (origins.length === 0) throw refuse('it has no origin')
  if (origins.length > 1) throw refuse('it has more than one origin URL')
  const origin = origins[0]!
  if (!originMatches(origin, web, project.owner, project.repo)) {
    throw refuse(`its origin is ${shown(origin)}, not ${project.name} on ${web}`)
  }

  // dish's own helper from an older checkout (before a dish-update) is dish's to replace, and configure does that
  // before anything here asks for a credential; any other helper is refused.
  const dishHelper = helpers.length > 0 && helpers.every(value => value === helpers[0] && isDishHelper(value, web)) ? helpers[0]! : helperOf(deps)
  const checked = await checkClone(path, { url: origin, helper: dishHelper, web })
  if (!checked.ok) throw refuse(checked.problem)

  const url = httpsUrl(web, project.owner, project.repo)
  if (origin !== url) {
    await editConfig(path, project, deps, 'clone', [{ args: ['--replace-all', 'remote.origin.url', url] }])
    deps.logger.info('adopted the clone at %s; its origin is now %s', path, url)
  } else {
    deps.logger.info('adopted the clone at %s', path)
  }
  return realpath(path)
}

/** Clone into a temporary directory dish makes beside `path`, then rename it into place. Its real path. */
async function cloneFresh(path: string, project: Project, deps: CloneDeps, signal?: AbortSignal): Promise<string> {
  const owner = dirname(path)
  try {
    await mkdir(owner, { recursive: true, mode: 0o700 })
    if (!(await stat(owner)).isDirectory()) throw new Error('it is not a directory')
  } catch (error) {
    throw new OnboardError('clone', `${owner} can't hold the clone: ${messageOf(error)}`)
  }
  const problem = await ownerProblem(deps.workRoot, owner)
  if (problem !== undefined) throw new OnboardError('clone', `${owner} ${problem}; dish clones nothing there`)
  let dropped: string[]
  try {
    ({ dropped } = await deps.tokens.ensureFileToken(project.owner))
  } catch (error) {
    throw new OnboardError('clone', `no read token for ${project.owner}: ${messageOf(error)}`)
  }
  if (dropped.some(repo => repo.toLowerCase() === project.repo.toLowerCase())) {
    throw new OnboardError('clone', `the dish App can't read ${project.name}: give it the repo on GitHub, then retry`)
  }
  if (signal?.aborted) throw abortError(`cloning ${project.name}`)

  const web = originOf(deps.web)
  const url = httpsUrl(web, project.owner, project.repo)
  const temporary = join(owner, `.${project.repo}.cloning-${randomBytes(4).toString('hex')}`)
  // Made here, new (no `recursive`: one that is there already isn't dish's), so removing it on failure removes only what dish made.
  try {
    await mkdir(temporary, { mode: 0o700 })
  } catch (error) {
    throw new OnboardError('clone', `can't make ${temporary}: ${messageOf(error)}`)
  }
  try {
    const result = await git([
      // The helper for this command only: the empty entry drops any helper the global config has for the URL.
      '-c', `credential.${web}.helper=`, '-c', `credential.${web}.helper=${helperOf(deps)}`, '-c', `credential.${web}.useHttpPath=true`,
      'clone', '--quiet', '--', url, temporary,
    ], { cwd: owner, timeoutMs: CLONE_TIMEOUT_MS, signal, env: { ...internals.gitEnv } })
    if (result.aborted || signal?.aborted) throw abortError(`cloning ${project.name}`)
    if (result.timedOut) throw new OnboardError('clone', `cloning ${url} timed out after ${CLONE_TIMEOUT_MS / 60_000} minutes`)
    if (result.code !== 0) throw new OnboardError('clone', `cloning ${url} failed (exit ${result.code}): ${gitFailure(result)}`)
    // The path is still free: something that appeared there meanwhile is left alone (a rename would replace an empty directory).
    if (await kindOf(path) !== 'missing') throw new OnboardError('clone', `${path} appeared while dish was cloning; dish leaves it as it is`)
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch(() => {})
    if (error instanceof OnboardError || (error as Error).name === 'AbortError') throw error
    throw new OnboardError('clone', `cloning ${project.name} failed: ${messageOf(error)}`)
  }
  deps.logger.info('cloned %s into %s', project.name, path)
  return realpath(path)
}

// --- step 3: configure ------------------------------------------------------------------------------------------------

/** Append `.worktrees/` to `.git/info/exclude` unless it has the line, as `editConfig` writes: never through a link, only to the file read. */
async function excludeWorktrees(clone: string, step: OnboardStep): Promise<void> {
  const dotGit = join(clone, '.git')
  const info = join(dotGit, 'info')
  const file = join(info, 'exclude')
  const pinned = await pinDirectory(dotGit, '.git', step)
  if (await kindOf(info) === 'missing') await mkdir(info, { mode: 0o755 })
  const pinnedInfo = await pinDirectory(info, '.git/info', step)
  await stillDirectory(dotGit, pinned, '.git', step)
  const read = await readPinned(file, '.git/info/exclude', step)
  const text = read?.bytes.toString('utf8') ?? ''
  if (text.split(/\r?\n/).some(line => line === EXCLUDE_LINE)) return
  const addition = Buffer.from(`${text === '' || text.endsWith('\n') ? '' : '\n'}${EXCLUDE_LINE}\n`)
  await internals.beforeWrite?.(file)
  await stillDirectory(dotGit, pinned, '.git', step)
  await stillDirectory(info, pinnedInfo, '.git/info', step)
  if (read !== undefined) {
    await writePinned(file, read.id, '.git/info/exclude', step, handle => writeAll(handle, addition, null), true)
    return
  }
  // There was none: a new one, never through a link or over one that appeared meanwhile.
  let handle: FileHandle
  try {
    handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o644)
  } catch (error) {
    throw new OnboardError(step, `.git/info/exclude can't be made (${codeOf(error)}); dish wrote nothing`)
  }
  try {
    await writeAll(handle, addition, 0)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** Step 3. The contract's keys (helper entries replaced as a pair, never accumulated), the identity, the exclude line once, all written with `git config --file <clone>/.git/config` (never `-C <clone>`, so nothing of the clone's runs before the check); then checkClone with the expectations. Idempotent. */
export async function configureClone(clone: string, project: Project, identity: { name: string, email: string }, deps: CloneDeps): Promise<void> {
  for (const [what, value] of [['name', identity.name], ['email', identity.email]] as const) {
    if (typeof value !== 'string' || value.trim() === '' || /[\x00-\x1f\x7f]/.test(value)) {
      throw new OnboardError('configure', `the bot identity's ${what} is empty or not one line`)
    }
  }
  const web = originOf(deps.web)
  const helper = helperOf(deps)
  const url = httpsUrl(web, project.owner, project.repo)

  // Single keys first, replaced where they are; the credential section last, removed and written again (git drops
  // the emptied section), so a second run leaves the file byte for byte as the first did. The credential pair is
  // replaced before the check below, so a helper path from an older checkout passes.
  await editConfig(clone, project, deps, 'configure', [
    { args: ['--replace-all', 'credential.interactive', 'false'] },
    { args: ['--replace-all', 'user.name', identity.name] },
    { args: ['--replace-all', 'user.email', identity.email] },
    { args: ['--replace-all', 'remote.origin.url', url] },
    // Exit 5: there was none.
    { args: ['--unset-all', `credential.${web}.helper`], ok: [0, 5] },
    { args: ['--unset-all', `credential.${web}.usehttppath`], ok: [0, 5] },
    { args: ['--add', `credential.${web}.helper`, ''] },
    { args: ['--add', `credential.${web}.helper`, helper] },
    { args: ['--add', `credential.${web}.useHttpPath`, 'true'] },
  ])
  await excludeWorktrees(clone, 'configure')

  const checked = await checkClone(clone, { url, helper, web })
  if (!checked.ok) throw new OnboardError('configure', `dish won't work in ${clone}: ${checked.problem}`)
}

// --- fetch ------------------------------------------------------------------------------------------------------------

/** `git fetch --prune origin +refs/heads/*:refs/remotes/origin/*` (the refspec on the command line, so a refspec an agent wrote in the config can't keep a hand-written origin ref alive), then `git remote set-head origin --auto` (every time: an agent can repoint origin/HEAD). Records lastFetch. */
export async function fetchClone(clone: string, project: Project, deps: CloneDeps, signal?: AbortSignal): Promise<void> {
  const at = Date.now()
  try {
    await fetchNow(clone, project, deps, signal)
  } catch (error) {
    if (signal?.aborted || (error as Error).name === 'AbortError') throw abortError(`fetching ${project.name}`)
    const message = mask(messageOf(error))
    await recordFetch(clone, project, deps, { at, ok: false, message })
    throw error instanceof Error ? error : new Error(message)
  }
  await recordFetch(clone, project, deps, { at, ok: true })
}

async function fetchNow(clone: string, project: Project, deps: CloneDeps, signal?: AbortSignal): Promise<void> {
  const web = originOf(deps.web)
  const { dropped } = await deps.tokens.ensureFileToken(project.owner)
  if (dropped.some(repo => repo.toLowerCase() === project.repo.toLowerCase())) {
    throw new Error(`the dish App can no longer read ${project.name}`)
  }
  const checked = await checkClone(clone, { url: httpsUrl(web, project.owner, project.repo), helper: helperOf(deps), web })
  if (!checked.ok) throw new Error(`dish won't fetch in ${clone}: ${checked.problem}`)
  const options = { timeoutMs: FETCH_TIMEOUT_MS, signal, env: { ...internals.gitEnv } }
  await gitOk(['-C', clone, 'fetch', '--prune', '--quiet', 'origin', ORIGIN_FETCH], options)
  // Every time, not only when it is missing: an agent can repoint origin/HEAD, and defaultBranch reads it.
  await gitOk(['-C', clone, 'remote', 'set-head', 'origin', '--auto'], options)
}

/** `lastFetch` into the clone state (a missing or corrupt one is started over). Never throws: a state that can't be saved is logged. */
async function recordFetch(clone: string, project: Project, deps: CloneDeps, lastFetch: NonNullable<CloneState['lastFetch']>): Promise<void> {
  const file = cloneStateFile(deps.state, project.owner, project.repo)
  try {
    const current = await readCloneState(file)
    if (current === undefined && await kindOf(file) !== 'missing') {
      deps.logger.warn('the clone state of %s was unreadable; it starts over', project.name)
    }
    // Without a state, dish can't tell whether it made the clone: it counts as adopted.
    const base: CloneState = current ?? { clone, adopted: true, installation: null, workspace: null, lastFetch: null, setup: null }
    await writeCloneState(file, { ...base, lastFetch })
  } catch (error) {
    deps.logger.warn('could not save the clone state of %s: %s', project.name, shown(messageOf(error)))
  }
}

/** refs/remotes/origin/HEAD's branch; undefined when unset. */
export async function defaultBranch(clone: string): Promise<string | undefined> {
  const result = await git(['-C', clone, 'symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], { timeoutMs: CONFIG_TIMEOUT_MS, env: { ...internals.gitEnv } })
  if (result.code !== 0 || result.timedOut) return undefined
  const ref = result.stdout.trim()
  const prefix = 'refs/remotes/origin/'
  if (!ref.startsWith(prefix)) return undefined
  const branch = ref.slice(prefix.length)
  return branch === '' || branch.startsWith('-') || /[\x00-\x20\x7f]/.test(branch) ? undefined : branch
}
