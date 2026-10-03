/**
 * The check dish makes before its git works in a clone that agents can write.
 *
 * `SAFE_FLAGS` (git.ts) turn off hooks and fsmonitor for every command, but many other keys of a clone's config run a
 * program (filters, diff and merge drivers, `core.sshCommand`, `core.pager`, `remote.<name>.uploadpack`, …) or read
 * more config (`include.path`, `includeIf.*`, `extensions.worktreeConfig`), and they can't be turned off one by one.
 * So the local config is checked against an allowlist of keys git never runs a program from, with the values dish
 * writes, and the files that make git read config from elsewhere are refused. A refusal names the key or the file;
 * it never quotes a value (a URL may hold a password), and is masked (`maskSecrets`) besides.
 *
 * Reading runs nothing of the clone's: files are opened without following a link and without blocking on a FIFO, and
 * the config is listed by `git config --file <clone>/.git/config --no-includes --null --list` from `/`, with no system
 * or global config, through `git()`. Once the config passes, git is asked where the clone's repository is
 * (`git -C <clone> rev-parse --absolute-git-dir`, no system or global config): it must be `<clone>/.git`, so a `.git`
 * git doesn't take as a repository (its `HEAD` removed, say) is refused, whatever repository is around the clone.
 *
 * @module dish-workspaces/safety
 */

import { constants } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { maskSecrets } from 'dish-kit'
import { GitError, gitOk, maskUrlPasswords } from './git.ts'

/** When `expect.url` is given, origin's refspec must be exactly this, so a planted one can't fetch into `refs/remotes/origin/*` from elsewhere. */
export const ORIGIN_FETCH = '+refs/heads/*:refs/remotes/origin/*'

export interface CloneExpectations {
  /** `remote.origin.url` must be exactly this (and be there), and `remote.origin.fetch`, when set, exactly `ORIGIN_FETCH`. */
  url?: string
  /** The one non-empty value a `credential.<web>.helper` may have: `helperValue(...)`. Without it, only `''` is allowed. */
  helper?: string
  /** The only `<web>` a `credential.<web>.*` key may name. */
  web?: string
}

export type SafetyResult = { ok: true } | { ok: false, problem: string }

/**
 * The keys a clone's local config may have (exact names as `git config --list` prints them, or patterns with a <name> part).
 * Section and variable names are lower case there; a `<name>` (a subsection) keeps its case.
 */
export const ALLOWED: readonly (string | RegExp)[] = Object.freeze([
  'core.repositoryformatversion', 'core.filemode', 'core.bare', 'core.logallrefupdates', 'core.ignorecase',
  'core.precomposeunicode', 'core.symlinks',
  // A JS project's setup (husky's `prepare`) sets it; dish's git and setup's override it with core.hooksPath=/dev/null.
  'core.hookspath',
  /^remote\.(?<name>.+)\.(?:url|fetch|pushurl|prune|tagopt)$/,
  // `git submodule update --init` (a setup's, or an agent's) writes these; dish's git never recurses into submodules.
  /^submodule\.(?<name>.+)\.(?:url|active)$/,
  /^branch\.(?<name>.+)\.(?:remote|merge|rebase|pushremote|description)$/,
  'user.name', 'user.email',
  'credential.interactive',
  /^credential\.(?<name>.+)\.(?:helper|usehttppath)$/,
  'extensions.objectformat', 'extensions.refstorage',
  'pull.rebase', 'pull.ff', 'push.default', 'push.autosetupremote', 'fetch.prune', 'init.defaultbranch',
])

/** Keys refused with a reason of their own (none is in ALLOWED: these only say more than "not allowed"). */
const REFUSED: ReadonlyMap<string, string> = new Map([
  ['extensions.worktreeconfig', "it makes git read each worktree's config.worktree, which this check doesn't see"],
])

/** How long listing a clone's config may take: it is one small file. */
const CONFIG_READ_TIMEOUT_MS = 10_000
/** The largest administrative file (a `commondir`, a `gitdir`, a worktree's `.git`) that is read. */
const MAX_SMALL_FILE = 4096
/** The most characters of a key a problem shows. */
const MAX_KEY_CHARS = 200
const CONTROL = /[\x00-\x1f\x7f]/g
/** `<transport>::<address>`: git hands the address to `git-remote-<transport>`, a program (`ext::` runs any command). */
const REMOTE_HELPER_URL = /^\s*[A-Za-z][A-Za-z0-9+.-]*::/

// --- the config --------------------------------------------------------------------------------------------------

/** `key` as git compares it: section and variable names without case, the subsection (between them) as it is. */
function normalizeKey(key: string): string {
  const first = key.indexOf('.')
  const last = key.lastIndexOf('.')
  if (first < 0) return key.toLowerCase()
  const section = key.slice(0, first).toLowerCase()
  const variable = key.slice(last + 1).toLowerCase()
  return first === last ? `${section}.${variable}` : `${section}.${key.slice(first + 1, last)}.${variable}`
}

/** A key as a problem shows it: a password in a subsection URL masked, control characters replaced, cut short. (The whole problem is masked after.) */
function showKey(key: string): string {
  return Array.from(maskUrlPasswords(key).replace(CONTROL, '?')).slice(0, MAX_KEY_CHARS).join('')
}

function isAllowed(key: string): boolean {
  return ALLOWED.some(entry => (typeof entry === 'string' ? entry === key : entry.test(key)))
}

/** Why `value` can't be a remote's URL (or a branch's remote, which may be a URL): it would run a program, or read as an option. */
function urlProblem(value: string): string | undefined {
  if (REMOTE_HELPER_URL.test(value)) return 'uses a <transport>:: URL, which runs a program'
  if (value.trimStart().startsWith('-')) return 'starts with "-"'
  return undefined
}

/** What is wrong with `value` for `key` (normalized and allowed), or `undefined`. */
function valueProblem(key: string, value: string, expect: CloneExpectations): string | undefined {
  const shown = showKey(key)
  if (key === 'core.bare') return value === 'false' ? undefined : 'core.bare must be false'
  if (key === 'credential.interactive') return value === 'false' ? undefined : 'credential.interactive must be false'
  if (key === 'pull.rebase' || /^branch\..+\.rebase$/.test(key)) {
    return ['true', 'false', 'merges'].includes(value) ? undefined : `${shown} must be true, false or merges`
  }
  if (/^remote\..+\.(?:url|pushurl)$/.test(key) || /^branch\..+\.(?:remote|pushremote)$/.test(key) || /^submodule\..+\.url$/.test(key)) {
    const problem = urlProblem(value)
    if (problem !== undefined) return `${shown} ${problem}`
    if (key === 'remote.origin.url' && expect.url !== undefined && value !== expect.url) return `remote.origin.url is not ${expect.url}`
    return undefined
  }
  // A planted origin refspec could fetch into refs/remotes/origin/* from elsewhere, so pin it once the URL is known.
  if (key === 'remote.origin.fetch' && expect.url !== undefined && value !== ORIGIN_FETCH) {
    return `remote.origin.fetch is not ${ORIGIN_FETCH}`
  }
  const credential = /^credential\.(.+)\.(helper|usehttppath)$/.exec(key)
  if (credential !== null) {
    const [, web, variable] = credential
    if (expect.web !== undefined && web !== expect.web) return `${shown} is a credential key for another origin than ${expect.web}`
    if (variable === 'usehttppath') return value === 'true' ? undefined : `${shown} must be true`
    if (value === '' || (expect.helper !== undefined && value === expect.helper)) return undefined
    return `${shown} is not dish's credential helper`
  }
  return undefined
}

/**
 * The first problem with a clone's local config, given as `[key, value]` pairs in file order (keys as
 * `git config --list` prints them; a key without a value counts as `true`), or `undefined` if there is none.
 */
export function configProblem(entries: ReadonlyArray<readonly [string, string]>, expect: CloneExpectations = {}): string | undefined {
  for (const [raw, value] of entries) {
    const key = normalizeKey(raw)
    const reason = REFUSED.get(key)
    if (reason !== undefined) return maskSecrets(`.git/config sets ${key}, which dish refuses: ${reason}`)
    if (!isAllowed(key)) return maskSecrets(`.git/config sets ${showKey(key)}, which dish doesn't allow`)
    const problem = valueProblem(key, value, expect)
    if (problem !== undefined) return maskSecrets(`.git/config: ${problem}`)
  }
  if (expect.url !== undefined && !entries.some(([key]) => normalizeKey(key) === 'remote.origin.url')) {
    return maskSecrets(`.git/config has no remote.origin.url (dish expects ${expect.url})`)
  }
  return undefined
}

/** `<file>`'s entries, read by git without includes and without any other config; or a problem. */
async function listConfig(file: string): Promise<Array<[string, string]> | string> {
  let listing: string
  try {
    listing = await gitOk(['config', '--file', file, '--no-includes', '--null', '--list'], {
      cwd: '/',
      timeoutMs: CONFIG_READ_TIMEOUT_MS,
      env: { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    })
  } catch (error) {
    if (error instanceof GitError) return `.git/config can't be read: ${error.message}`
    throw error
  }
  const entries: Array<[string, string]> = []
  // `key\nvalue\0` per entry; `key\0` for a key written without `=` (a boolean true).
  for (const record of listing.split('\0')) {
    if (record === '') continue
    const newline = record.indexOf('\n')
    entries.push(newline < 0 ? [record, 'true'] : [record.slice(0, newline), record.slice(newline + 1)])
  }
  return entries
}

// --- files ----------------------------------------------------------------------------------------------------------

type Kind = 'missing' | 'directory' | 'file' | 'other'

/** What is at `path`, without following a link (a link is `other`). An error other than "not there" counts as `other`. */
async function kindOf(path: string): Promise<Kind> {
  try {
    const stats = await lstat(path)
    return stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : 'other'
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'other'
  }
}

type Small = { ok: true, text: string } | { ok: false, reason: string }

/**
 * A small regular file's text. Opened without following a link (O_NOFOLLOW) and without waiting on a FIFO (O_NONBLOCK);
 * what was opened is checked to be a regular file, so a swap after a check can't make this hang or read elsewhere.
 */
async function readSmall(file: string): Promise<Small> {
  let handle: FileHandle
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: false, reason: 'is missing' }
    if (code === 'ELOOP') return { ok: false, reason: 'is not a regular file' }
    return { ok: false, reason: `can't be read (${code ?? 'error'})` }
  }
  try {
    const stats = await handle.stat()
    if (!stats.isFile()) return { ok: false, reason: 'is not a regular file' }
    const buffer = Buffer.alloc(MAX_SMALL_FILE + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead > MAX_SMALL_FILE) return { ok: false, reason: 'is too large' }
    return { ok: true, text: buffer.subarray(0, bytesRead).toString('utf8') }
  } finally {
    await handle.close()
  }
}

/** A one-line administrative file's content: its text without the newline git ends it with. */
function line(text: string): string {
  return text.endsWith('\n') ? text.slice(0, -1) : text
}

/** A name from a directory listing, as a problem shows it. */
function showName(name: string): string {
  return Array.from(name.replace(CONTROL, '?')).slice(0, MAX_KEY_CHARS).join('')
}

/** The first problem with `.git/worktrees`: each entry a real directory whose `commondir` is `../..`, with no `config.worktree`. */
async function worktreesProblem(dotGit: string): Promise<string | undefined> {
  const root = join(dotGit, 'worktrees')
  const kind = await kindOf(root)
  if (kind === 'missing') return undefined
  if (kind !== 'directory') return '.git/worktrees is not a directory'
  let names: string[]
  try {
    names = (await readdir(root)).sort()
  } catch {
    return ".git/worktrees can't be listed"
  }
  for (const name of names) {
    const shown = `.git/worktrees/${showName(name)}`
    const admin = join(root, name)
    if (await kindOf(admin) !== 'directory') return `${shown} is not a directory`
    const common = await readSmall(join(admin, 'commondir'))
    if (!common.ok) return `${shown}: commondir ${common.reason}`
    if (line(common.text) !== '../..') return `${shown}: commondir is not ../..`
    if (await kindOf(join(admin, 'config.worktree')) !== 'missing') return `${shown}: config.worktree exists`
  }
  return undefined
}

async function cloneProblem(clone: string, expect: CloneExpectations): Promise<string | undefined> {
  const dotGit = join(clone, '.git')
  const kind = await kindOf(dotGit)
  if (kind === 'missing') return '.git is missing'
  if (kind !== 'directory') return ".git is not a directory (a linked worktree's or a submodule's .git file, or a link)"
  if (await kindOf(join(dotGit, 'commondir')) !== 'missing') return '.git/commondir exists: git would read another repository'
  if (await kindOf(join(dotGit, 'config.worktree')) !== 'missing') return '.git/config.worktree exists'
  const config = await kindOf(join(dotGit, 'config'))
  if (config === 'missing') return '.git/config is missing'
  if (config !== 'file') return '.git/config is not a regular file'
  const worktrees = await worktreesProblem(dotGit)
  if (worktrees !== undefined) return worktrees
  const entries = await listConfig(join(dotGit, 'config'))
  if (typeof entries === 'string') return entries
  return configProblem(entries, expect) ?? await gitDirProblem(clone)
}

/** git's own word on where the clone's repository is, asked once its config has passed: it must be `<clone>/.git`, by its real path. */
async function gitDirProblem(clone: string): Promise<string | undefined> {
  let real: string
  try {
    real = await realpath(clone)
  } catch {
    return `${clone} can't be resolved`
  }
  let found: string
  try {
    found = (await gitOk(['-C', real, 'rev-parse', '--absolute-git-dir'], {
      timeoutMs: CONFIG_READ_TIMEOUT_MS,
      env: { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    })).replace(/\n$/, '')
  } catch (error) {
    if (error instanceof GitError) return `git doesn't take .git as a repository (${error.message})`
    throw error
  }
  const expected = join(real, '.git')
  return found === expected ? undefined : `git finds the repository at ${showName(found)}, not ${expected}`
}

/**
 * Check a clone before dish's git works in it. Reads files, runs `git config --file <clone>/.git/config --no-includes
 * --null --list` (with SAFE_FLAGS, cwd '/'), which runs nothing of the clone's, and once that config passes, `git -C
 * <clone> rev-parse --absolute-git-dir` (SAFE_FLAGS, no system or global config), which must name `<clone>/.git`.
 */
export async function checkClone(clone: string, expect: CloneExpectations = {}): Promise<SafetyResult> {
  const problem = await cloneProblem(clone, expect)
  return problem === undefined ? { ok: true } : { ok: false, problem: maskSecrets(problem) }
}

async function worktreeProblem(clone: string, path: string): Promise<string | undefined> {
  let realClone: string
  let realPath: string
  try {
    realClone = await realpath(clone)
  } catch {
    return `the clone ${clone} can't be resolved`
  }
  // The worktree path's own last component must not be a symbolic link: `git worktree remove` on a link that an agent
  // swapped in would delete whatever it points at (`<clone>/src`). An intermediate link (a clone reached through one)
  // is fine, so lstat the path itself, which follows every component but the last. Normalized first: lstat follows the
  // link for a trailing `/` or `/.` (`…/one/`, `…/one/.`), which would let those spellings through.
  const worktree = resolve(path)
  try {
    if ((await lstat(worktree)).isSymbolicLink()) return `${worktree} is a symbolic link`
  } catch {
    return `${worktree} can't be read`
  }
  try {
    realPath = await realpath(worktree)
  } catch {
    return `${worktree} can't be resolved`
  }
  const dotGit = await readSmall(join(realPath, '.git'))
  if (!dotGit.ok) return `${path}: .git ${dotGit.reason}`
  const admins = join(realClone, '.git', 'worktrees')
  const target = /^gitdir: (.+)\n?$/.exec(dotGit.text)?.[1]
  const name = target === undefined ? '' : basename(target)
  if (target === undefined || !isAbsolute(target) || name === '' || name === '.' || name === '..' || target !== join(admins, name)) {
    return `${path}: .git does not point at a worktree of ${realClone}`
  }
  const admin = join(admins, name)
  const shown = `.git/worktrees/${showName(name)}`
  if (await kindOf(admin) !== 'directory') return `${path}: ${shown} is not a directory`
  const common = await readSmall(join(admin, 'commondir'))
  if (!common.ok) return `${path}: commondir of ${shown} ${common.reason}`
  if (line(common.text) !== '../..') return `${path}: commondir of ${shown} is not ../..`
  const back = await readSmall(join(admin, 'gitdir'))
  if (!back.ok) return `${path}: gitdir of ${shown} ${back.reason}`
  if (line(back.text) !== join(realPath, '.git')) return `${path}: gitdir of ${shown} does not point back at it`
  if (await kindOf(join(admin, 'config.worktree')) !== 'missing') return `${path}: ${shown} has a config.worktree`
  return undefined
}

/** Check one worktree of `clone`: `<path>/.git` is a file reading `gitdir: <clone>/.git/worktrees/<name>`, that directory's `commondir` is `../..` and its `gitdir` is `<path>/.git`, and it has no `config.worktree`. */
export async function checkWorktree(clone: string, path: string): Promise<SafetyResult> {
  const problem = await worktreeProblem(clone, path)
  return problem === undefined ? { ok: true } : { ok: false, problem: maskSecrets(problem) }
}
