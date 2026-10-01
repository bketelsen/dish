import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { ConfigStoreError } from './errors.ts'
import { Git, literal, pathProblem } from './git.ts'
import type { Change, GitIdentity } from './git.ts'
import { checkContent, secretKind } from './guard.ts'
import { SerialQueue, acquireLock } from './lock.ts'
import type { NamespaceRegistry, NamespaceSpec } from './namespaces.ts'

export type { Change, GitIdentity }

/**
 * Who made a commit. `system` is the store's own (the root commit and `seed`);
 * callers of `write` are `user` or `agent` (`EditAuthor`).
 */
export type Author =
  | { kind: 'user' }
  | { kind: 'agent', sessionId: string, role?: string }
  | { kind: 'system' }

/** The authors a caller may write as. */
export type EditAuthor = Exclude<Author, { kind: 'system' }>

export interface CommitInfo {
  /** The commit's full object id. */
  id: string
  /** Commit time in milliseconds since the epoch (git records seconds). */
  time: number
  /** An agent's `role` is always filled in (`main` when the caller gave none), as `Dish-Role` records it. */
  author: Author
  /** The whole commit message: subject, blank line, trailers. */
  message: string
  /** The normalized note, when there was one. */
  note?: string
  /** The paths this commit changed, sorted. */
  paths: string[]
}

export interface WriteMeta {
  author: EditAuthor
  /** Why, in a line: whitespace is collapsed and it's cut to 200 characters. */
  note?: string
  /** Optimistic concurrency: the full id of the `main` commit the editor loaded. */
  base?: string
}

/** The arguments of `revert`: those of `write`, without `base` (a revert's base is the commit it reverts). */
export type RevertMeta = Omit<WriteMeta, 'base'>

/** What `history` asks for. */
export interface HistoryQuery {
  /** Only commits that changed this document. Not with `prefix`. */
  path?: string
  /** Only commits that changed something under this path (`prompts/` or `prompts`). Not with `path`. */
  prefix?: string
  /** How many commits at most. Default 50, kept between 1 and 500. */
  limit?: number
  /** The full id of a commit on `main`: the history starts just below it. */
  before?: string
}

/** One file's change between two commits, as git's own patch. */
export interface FileDiff {
  path: string
  status: 'added' | 'modified' | 'deleted'
  patch: string
}

export interface StoreOptions {
  /** The bare repository's directory; created if missing. */
  repository: string
  namespaces: NamespaceRegistry
  /** Git identity for commits authored by a person. */
  user: GitIdentity
  /** Git identity for commits authored by an agent, and for the store's own. */
  agent: GitIdentity
  /** Per-document size cap in bytes. Default 262144. */
  maxBytes?: number
  /** Called after each commit to `main` made by `write` or `seed` (not for the root commit). A throw is reported as a process warning and never fails the write. */
  onCommit?: (info: CommitInfo) => void
}

const MAIN = 'refs/heads/main'
const DEFAULT_MAX_BYTES = 262144
const FULL_COMMIT_ID = /^[0-9a-f]{40}$/
/** What a session id or a role may look like: no whitespace, no punctuation a log line could trip on. */
const IDENTIFIER = /^[A-Za-z0-9._:-]{1,128}$/
const DEFAULT_ROLE = 'main'
const NOTE_MAX_CHARS = 200
const SUBJECT_PATHS = 3
const SHORT_ID_CHARS = 7
const DEFAULT_HISTORY_LIMIT = 50
const MAX_HISTORY_LIMIT = 500
const INIT_SUBJECT = 'Initialize dish config'
const SYSTEM: Author = { kind: 'system' }
const CONTROL = /[\x00-\x1f\x7f]/
/** Control characters as a note may still hold them once whitespace is gone: C0, DEL and C1. */
const NOTE_CONTROL = /[\x00-\x1f\x7f-\x9f]/
/** `dish.lock.<pid>.<random>.tmp`: the temporary file `acquireLock` links the lock from. */
const LOCK_TEMP = /^dish\.lock\.(\d+)\.[0-9a-f]+\.tmp$/
/** A lock temp file lives for a moment; one this old was left by a crash, not by a process mid-acquire. */
const STALE_TEMP_MS = 60_000
/** Everything `git init --bare` puts in a directory. */
const GIT_INIT_ENTRIES: readonly string[] = ['HEAD', 'branches', 'config', 'description', 'hooks', 'info', 'objects', 'refs']
/** The files `git init` writes through a lock, which a crash can leave behind and which would make the next `git init` fail. */
const GIT_INIT_LOCKS: readonly string[] = ['config.lock', 'HEAD.lock']

/** What `write`, `seed` and `revert` hand to `commitPrepared` once every check has passed. */
interface Prepared {
  changes: Change[]
  author: Author
  note?: string
  base?: string
  /** The subject's text after `<paths>: `. */
  summary: string
  /** Replaces the whole subject (`<paths>: <summary>`); gets the paths that changed. */
  subject?: (changed: string[]) => string
  /** `Key: value` lines added to the trailers, after the author's and the note. */
  trailers?: string[]
}

function invalid(message: string): ConfigStoreError {
  return new ConfigStoreError('INVALID', message)
}

/** `path` for an error message: quoted, unless it looks like a secret, which must not be echoed. */
function label(path: string): string {
  return secretKind(path) === undefined ? JSON.stringify(path) : '(a path that looks like a secret)'
}

// --- checking what a caller hands in -------------------------------------------------------------

function checkChange(raw: unknown): Change {
  if (typeof raw !== 'object' || raw === null) throw invalid('each change must be an object')
  const { path, text, delete: remove } = raw as Record<string, unknown>
  if (typeof path !== 'string') throw invalid('a change needs a string path')
  if (remove !== undefined) {
    if (remove !== true || text !== undefined) throw invalid(`${label(path)}: a change is either { text } or { delete: true }`)
    return { path, delete: true }
  }
  if (typeof text !== 'string') throw invalid(`${label(path)}: a change needs a string text, or delete: true`)
  return { path, text }
}

/** Step 1: a non-empty list of well-formed changes with distinct paths, copied so later steps see what was checked. */
function checkChanges(changes: unknown): Change[] {
  if (!Array.isArray(changes) || changes.length === 0) throw invalid('changes must be a non-empty array')
  const seen = new Set<string>()
  return changes.map(raw => {
    const change = checkChange(raw)
    if (seen.has(change.path)) throw invalid(`${label(change.path)} appears more than once`)
    seen.add(change.path)
    return change
  })
}

/** Step 2. */
function checkPaths(changes: Change[]): void {
  for (const { path } of changes) {
    const problem = pathProblem(path)
    if (problem !== undefined) throw invalid(`invalid path ${label(path)}: ${problem}`)
  }
}

function checkAuthorKind(meta: unknown): EditAuthor {
  const author = (meta as { author?: unknown } | null | undefined)?.author
  const kind = (author as { kind?: unknown } | null | undefined)?.kind
  if (kind !== 'user' && kind !== 'agent') throw invalid('author kind must be "user" or "agent"')
  return author as EditAuthor
}

/** An optional agent field (`sessionId`, `role`) that must match `IDENTIFIER`. */
function checkIdentifier(field: string, value: unknown): string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
    throw invalid(`agent ${field} must match ${String(IDENTIFIER)}`)
  }
  return value
}

/** The note as it will be committed, before the length cap; `undefined` for none (or only whitespace). */
function normalizeNote(note: unknown): string | undefined {
  if (note === undefined) return undefined
  if (typeof note !== 'string') throw invalid('note must be a string')
  const text = note.replace(/\s+/g, ' ').trim()
  if (NOTE_CONTROL.test(text)) throw invalid('note contains control characters')
  return text === '' ? undefined : text
}

function capNote(note: string): string {
  // By code point, so the cut never splits a surrogate pair.
  const capped = Array.from(note).slice(0, NOTE_MAX_CHARS).join('')
  return capped.trimEnd()
}

/** Step 6: the author's fields and the note. Returns the author as it will be recorded, and the note as committed. */
function checkMeta(author: EditAuthor, rawNote: unknown): { author: EditAuthor, note?: string } {
  const note = normalizeNote(rawNote)
  let recorded: EditAuthor = author
  const fields: Array<[string, string]> = []
  if (author.kind === 'agent') {
    const sessionId = checkIdentifier('sessionId', author.sessionId)
    const role = author.role === undefined ? DEFAULT_ROLE : checkIdentifier('role', author.role)
    recorded = { kind: 'agent', sessionId, role }
    fields.push(['role', role], ['sessionId', sessionId])
  }
  // The whole note is scanned, not just what survives the cap: a token must not slip out half-cut.
  if (note !== undefined) fields.unshift(['note', note])
  for (const [field, value] of fields) refuseSecret(field, value)
  if (note === undefined) return { author: recorded }
  // And the cut itself is scanned: dropping the tail of a near-miss (AKIA plus 17 characters) can leave a match.
  const capped = capNote(note)
  refuseSecret('note', capped)
  return { author: recorded, note: capped }
}

function refuseSecret(field: string, value: string): void {
  const kind = secretKind(value)
  if (kind !== undefined) throw new ConfigStoreError('SECRET', `the ${field} looks like ${kind}`)
}

// --- commit messages ----------------------------------------------------------------------------

function pathList(paths: string[]): string {
  const shown = paths.slice(0, SUBJECT_PATHS).join(', ')
  return paths.length > SUBJECT_PATHS ? `${shown} and ${paths.length - SUBJECT_PATHS} more` : shown
}

function defaultSummary(author: EditAuthor): string {
  return author.kind === 'user' ? 'edited in web UI' : `edited by ${author.role ?? DEFAULT_ROLE} agent`
}

/** The message: `subject`, a blank line, then the `Dish-*` trailers. Every value is single-line by now. */
function messageFor(subject: string, author: Author, note?: string, extra: string[] = []): string {
  const trailers = [`Dish-Author-Kind: ${author.kind}`]
  if (author.kind === 'agent') trailers.push(`Dish-Session: ${author.sessionId}`, `Dish-Role: ${author.role ?? DEFAULT_ROLE}`)
  if (note !== undefined) trailers.push(`Dish-Note: ${note}`)
  return `${subject}\n\n${[...trailers, ...extra].join('\n')}\n`
}

// --- reading commits back ------------------------------------------------------------------------

/** Separates the values of a trailer that appears more than once; no trailer value can hold it unnoticed. */
const VALUE_SEPARATOR = '\x1f'

function trailerValues(key: string): string {
  return `%(trailers:key=${key},valueonly,separator=%x1f)`
}

/**
 * What `git log` is asked for, one commit per record. Fields are split by NUL
 * and records end in NUL (`-z`): git cuts a message at its first NUL, so no
 * message, however forged, can add a field or end a record early. The
 * trailers are git's own reading of the message's last paragraph; nothing in
 * the body above it counts.
 */
const LOG_FIELDS = ['%H', '%at', '%P', ...['Dish-Author-Kind', 'Dish-Session', 'Dish-Role', 'Dish-Note'].map(trailerValues), '%B']
const LOG_FORMAT = LOG_FIELDS.join('%x00')

/**
 * Who a commit's trailers name. Only what this store writes counts: a commit
 * made any other way (by hand, or by a clone's remote) is not a user's or an
 * agent's action, so whatever doesn't read as exactly one valid author is the system's.
 */
function authorOf(kind: string, session: string, role: string): Author {
  if (kind === 'user') return { kind: 'user' }
  if (kind === 'agent' && IDENTIFIER.test(session) && IDENTIFIER.test(role)) return { kind: 'agent', sessionId: session, role }
  return SYSTEM
}

/** A commit's `Dish-Note` as `write` would have recorded it: one line, at most 200 characters. Never more than one note, never control characters. */
function noteOf(value: string): string | undefined {
  if (value.includes(VALUE_SEPARATOR)) return undefined
  const text = value.replace(/\s+/g, ' ').trim()
  if (text === '' || NOTE_CONTROL.test(text)) return undefined
  return capNote(text)
}

/** `history`'s query, checked, with its defaults filled in. `before` is passed on unchecked. */
function checkHistoryQuery(query: unknown): { pathspec: string[], limit: number, before: unknown } {
  if (typeof query !== 'object' || query === null) throw invalid('history takes an object')
  const { path, prefix, limit, before } = query as Record<string, unknown>
  if (path !== undefined && prefix !== undefined) throw invalid('give a path or a prefix, not both')
  const pathspec: string[] = []
  for (const [field, value] of [['path', path], ['prefix', prefix]] as const) {
    if (value === undefined) continue
    if (typeof value !== 'string') throw invalid(`${field} must be a string`)
    // A prefix may end in a slash (`prompts/`): what is left must still be a path that could exist.
    const bare = field === 'prefix' && value.endsWith('/') ? value.slice(0, -1) : value
    const problem = pathProblem(bare)
    if (problem !== undefined) throw invalid(`invalid ${field} ${label(value)}: ${problem}`)
    pathspec.push(literal(bare))
  }
  if (limit !== undefined && (typeof limit !== 'number' || Number.isNaN(limit))) throw invalid('limit must be a number')
  const wanted = limit === undefined ? DEFAULT_HISTORY_LIMIT : Math.trunc(limit as number)
  return { pathspec, limit: Math.min(MAX_HISTORY_LIMIT, Math.max(1, wanted)), before }
}

function isOwnLockFile(name: string): boolean {
  return name === 'dish.lock' || LOCK_TEMP.test(name)
}

/** Whether no process has `pid`. Any answer but "no such process" (including a pid that isn't valid) counts as alive. */
function processIsGone(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return (error as { code?: unknown }).code === 'ESRCH'
  }
}

function warn(message: string): void {
  process.emitWarning(message, { code: 'DISH_CONFIG_ON_COMMIT' })
}

/**
 * The config repository: one bare git repository, `main` its only branch of
 * record, driven through git plumbing behind one queue and a process lock.
 *
 * Every operation, reads included, runs on the queue, so a read never sees a
 * write half done. Callers see `ConfigStoreError`s for refusals and plain
 * `Error`s for anything wrong with the environment or with how the store was used.
 */
export class ConfigStore {
  private readonly git: Git
  private readonly queue = new SerialQueue()
  private readonly repository: string
  private readonly options: StoreOptions
  private readonly maxBytes: number
  private readonly release: () => Promise<void>
  private closed = false
  private closing: Promise<void> | undefined

  private constructor(options: StoreOptions, repository: string, release: () => Promise<void>) {
    this.options = options
    this.repository = repository
    this.git = new Git(repository)
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    this.release = release
  }

  /**
   * Open the store at `options.repository`: create the directory, take the
   * process lock, then make sure the repository is there (initializing it with
   * one root commit if the directory is empty) and clear what a crashed run left.
   * @throws `LOCKED` if another process holds the store; a plain `Error` if the
   *   directory holds something that isn't a dish config repository.
   */
  static async open(options: StoreOptions): Promise<ConfigStore> {
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    if (!(maxBytes >= 0)) throw new Error(`maxBytes must be zero or more, got ${String(maxBytes)}`)
    const repository = resolve(options.repository)
    await mkdir(repository, { recursive: true })
    const release = await acquireLock(repository)
    try {
      const store = new ConfigStore(options, repository, release)
      await store.ensureRepository()
      return store
    } catch (error) {
      await release()
      throw error
    }
  }

  /**
   * Wait for the work already queued, then release the lock. Safe to call
   * again; operations started after the first call throw a plain `Error`.
   */
  close(): Promise<void> {
    this.closed = true
    this.closing ??= this.queue.run(() => this.release()).catch(error => {
      // A failed release can be tried again.
      this.closing = undefined
      throw error
    })
    return this.closing
  }

  /** The commit `main` points at. */
  head(): Promise<string> {
    return this.run(() => this.mainCommit())
  }

  /**
   * The text of the document at `path`, or `undefined` if there is none (or `path` can't be a document).
   * @param ref - `'main'` or a full 40-hex commit id.
   * @throws `NOT_FOUND` for any other `ref`, or a commit that doesn't exist.
   */
  read(path: string, ref = 'main'): Promise<string | undefined> {
    return this.run(async () => {
      const commit = await this.commitFor(ref)
      if (pathProblem(path) !== undefined) return undefined
      return this.git.readBlob(commit, path)
    })
  }

  /**
   * Every document path under `prefix` (`prompts/`, `prompts` or `crew.yaml`;
   * `''` for everything), in git's order.
   * @param ref - as for `read`.
   */
  list(prefix: string, ref = 'main'): Promise<string[]> {
    return this.run(async () => {
      const commit = await this.commitFor(ref)
      // A trailing slash only marks a subtree; what's left must be a path that could exist.
      const bare = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix
      if (prefix !== '' && pathProblem(bare) !== undefined) return []
      return this.git.listPaths(commit, bare)
    })
  }

  /**
   * Commit `changes` to `main` as one atomic commit. Checked in this order,
   * and nothing reaches git until all have passed. First, the author's kind
   * must be `user` or `agent` (`INVALID`). Then:
   * 1. a non-empty, well-formed list with no path twice (`INVALID`)
   * 2. every path usable as a document path (`INVALID`)
   * 3. every path owned (`UNOWNED`); an agent author needs the namespace's `agent` policy to be `write` (`FORBIDDEN`)
   * 4. the content guard on every written document (`SECRET`, `TOO_LARGE`)
   * 5. the namespace's `validate` (`INVALID`, prefixed with the path)
   * 6. the author and note (`INVALID`, `SECRET`)
   *
   * Then: a delete of a missing path is `NOT_FOUND`; with `meta.base`, a path
   * changed on `main` since then is `CONFLICT` (and `NOT_FOUND` if `base` isn't a commit).
   * @returns the commit, or `undefined` when the changes leave `main` as it is: no commit is made.
   */
  write(changes: Change[], meta: WriteMeta): Promise<CommitInfo | undefined> {
    return this.run(() => this.commitPrepared(this.prepareWrite(changes, meta)))
  }

  /**
   * Write the documents in `defaults` that don't exist yet, as one commit by the
   * `system` author with the subject `<paths>: <owner> defaults`.
   * Existing documents are never touched. Every path must belong to a namespace
   * owned by `owner` (`UNOWNED`); the guard and validators run as for `write`,
   * but the agent policy doesn't apply.
   * @returns the commit, or `undefined` when nothing was missing.
   */
  seed(defaults: Record<string, string>, owner: string): Promise<CommitInfo | undefined> {
    return this.run(async () => {
      if (typeof owner !== 'string' || owner === '' || CONTROL.test(owner)) throw invalid('seed owner must be a one-line string')
      const entries = Object.entries(defaults)
      if (entries.length === 0) return undefined
      const all = checkChanges(entries.map(([path, text]) => ({ path, text })))
      checkPaths(all)
      const owners = this.ownersOf(all)
      for (const [path, spec] of owners) {
        if (spec.owner !== owner) throw new ConfigStoreError('UNOWNED', `${label(path)} belongs to ${JSON.stringify(spec.owner)}, not ${JSON.stringify(owner)}`)
      }
      // Every path is scanned before git sees any of them, not only the ones that turn out to be missing.
      for (const { path } of all) checkContent(path, '', this.maxBytes)
      const head = await this.mainCommit()
      const missing: Change[] = []
      for (const change of all) {
        if (!(await this.hasFile(head, change.path))) missing.push(change)
      }
      if (missing.length === 0) return undefined
      this.checkGuard(missing)
      this.checkValid(missing, owners)
      // `base` makes the retry notice a document that appeared in the meantime, instead of overwriting it.
      return this.commitPrepared({ changes: missing, author: SYSTEM, base: head, summary: `${owner} defaults` })
    })
  }

  /**
   * The commits of `main`, newest first (its first-parent line), each as `write`
   * returned it: `author` and `note` come from the commit's trailers, and a
   * commit made any other way is the `system`'s. With `path` or `prefix`, only
   * the commits that changed it; both at once is `INVALID`. `before` starts the
   * list just below that commit, so `before` = the last id of a page gives the next.
   * @throws `INVALID` for a `path`, `prefix` or `limit` that can't be used; `NOT_FOUND`
   *   if `before` isn't the full id of a commit reachable from `main`.
   */
  history(query: HistoryQuery = {}): Promise<CommitInfo[]> {
    return this.run(async () => {
      const { pathspec, limit, before } = checkHistoryQuery(query)
      let start = MAIN
      if (before !== undefined) {
        const parent = await this.git.resolve(`${await this.mainCommitFor(before)}^`)
        if (parent === undefined) return []
        start = parent
      }
      return this.readCommits(['-n', String(limit), start], pathspec)
    })
  }

  /**
   * What changed between two commits, one entry per file with git's own patch,
   * in path order. External diff programs and textconv filters are never run.
   * @param from - `'main'`, a full commit id, or the empty tree's id.
   * @param to - as for `from`.
   * @param path - only this file, or the files under this directory.
   * @throws `NOT_FOUND` for any other `from` or `to`; `INVALID` for a `path` that can't exist.
   */
  diff(from: string, to: string, path?: string): Promise<FileDiff[]> {
    return this.run(async () => {
      let pathspec: string[] = []
      if (path !== undefined) {
        const problem = typeof path === 'string' ? pathProblem(path) : 'not a string'
        if (problem !== undefined) throw invalid(`invalid path ${typeof path === 'string' ? label(path) : typeof path}: ${problem}`)
        pathspec = [literal(path)]
      }
      return this.fileDiffs(await this.diffEnd(from), await this.diffEnd(to), pathspec)
    })
  }

  /**
   * One commit and what it changed: its diff against its parent, or against the
   * empty tree for a commit with none.
   * @param id - `'main'` or a full commit id (any commit in the repository, not only one on `main`).
   * @throws `NOT_FOUND` for anything else.
   */
  commit(id: string): Promise<{ info: CommitInfo, diffs: FileDiff[] }> {
    return this.run(async () => {
      const found = await this.commitFor(id)
      const [info] = await this.readCommits(['-n', '1', found], [])
      const parent = await this.git.resolve(`${found}^`) ?? await this.git.emptyTree()
      return { info: info!, diffs: await this.fileDiffs(parent, found, []) }
    })
  }

  /**
   * Undo what `commit` changed: every path it touched goes back to its parent's
   * version (a path the commit added is deleted), as one new commit by the same
   * pipeline as `write`, with the reverted commit as `base`. So a path changed
   * since is `CONFLICT`, and an agent author needs `agent: 'write'` on every
   * namespace involved. The subject is `Revert <short id>: <paths>`, and a
   * `Dish-Revert: <full id>` trailer names the commit. A path already back at its
   * parent's version is left out; when none is left (it was reverted before) no
   * commit is made.
   * @param commit - the full id of a commit on `main`.
   * @returns the commit, or `undefined` when there was nothing left to revert.
   * @throws `NOT_FOUND` if `commit` isn't the full id of a commit on `main`; `INVALID` for the
   *   first commit, which has nothing to go back to, and for a bad author or note.
   */
  revert(commit: string, meta: RevertMeta): Promise<CommitInfo | undefined> {
    return this.run(async () => {
      // As `write` does: the author and note are checked before anything is read.
      checkMeta(checkAuthorKind(meta), meta.note)
      const target = await this.mainCommitFor(commit)
      const parent = await this.git.resolve(`${target}^`)
      if (parent === undefined) throw invalid('nothing to revert: the first commit has no earlier state to go back to')
      const touched = await this.git.changedPaths(parent, target)
      // Of those, what still differs from the parent's version is what is left to undo.
      const pending = (await this.git.changedPaths(parent, await this.mainCommit(), touched)).sort()
      if (pending.length === 0) return undefined
      const changes: Change[] = []
      for (const path of pending) {
        const text = await this.git.readBlob(parent, path)
        changes.push(text === undefined ? { path, delete: true } : { path, text })
      }
      const prepared = this.prepareWrite(changes, { ...meta, base: target })
      prepared.subject = changed => `Revert ${target.slice(0, SHORT_ID_CHARS)}: ${pathList(changed)}`
      prepared.trailers = [`Dish-Revert: ${target}`]
      return this.commitPrepared(prepared)
    })
  }

  // --- the queue ---------------------------------------------------------------------------------

  /** Run `task` on the queue; once `close()` has been called, nothing new starts. */
  private run<T>(task: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('config store is closed'))
    return this.queue.run(task)
  }

  // --- opening -----------------------------------------------------------------------------------

  /**
   * Make sure `<repository>` holds a dish config repository with a `main`.
   *
   * With the lock held and git agreeing the directory is a repository, it is
   * cleaned of what a crashed run left, and finished if the root commit is missing.
   * Otherwise it is created, but only in a directory that holds nothing except what
   * `git init --bare` makes (and the `config.lock` and `HEAD.lock` it works through,
   * which are removed first): that also finishes a first start that crashed inside
   * `git init`, which writes `config` before `HEAD` and `HEAD` before `objects/`.
   */
  private async ensureRepository(): Promise<void> {
    // A stray `HEAD` file doesn't make a repository: it is whatever git itself accepts.
    const check = await this.git.run(['rev-parse', '--git-dir'], { allowFail: true })
    if (check.code === 0) {
      await this.removeStaleFiles()
      if ((await this.git.resolve(MAIN)) === undefined) await this.completeInitialization()
      return
    }
    await this.initialize(check.stderr.trim())
  }

  /** @param why - what git said about the directory, for the message when it can't be initialized. */
  private async initialize(why: string): Promise<void> {
    const entries = await readdir(this.repository, { withFileTypes: true })
    // The init lock files are only leftovers if they are files; a directory by that name is somebody's.
    const isInitLock = (entry: { name: string, isFile(): boolean }): boolean => entry.isFile() && GIT_INIT_LOCKS.includes(entry.name)
    const others = entries.filter(entry => !isOwnLockFile(entry.name) && !GIT_INIT_ENTRIES.includes(entry.name) && !isInitLock(entry))
    if (others.length > 0) {
      throw new Error(`${this.repository} is not a dish config repository, refusing to initialize over existing files${why === '' ? '' : ` (git: ${why})`}`)
    }
    // This process holds `dish.lock`, so no git of ours is running: whatever lock `git init` left is a crash's.
    await Promise.all(entries.filter(isInitLock).map(entry => rm(join(this.repository, entry.name), { force: true })))
    // Safe on what a crashed `git init` left: it fills in whatever is missing and changes nothing else.
    await this.git.initBare('main')
    await this.completeInitialization()
  }

  /**
   * Make the root commit in a repository that has no `main`. The only one this
   * store will touch is a freshly initialized one with `HEAD` on `main` and no refs
   * at all (`git init` finished, the root commit didn't); anything else isn't its own.
   */
  private async completeInitialization(): Promise<void> {
    const head = (await this.git.run(['symbolic-ref', '-q', 'HEAD'], { allowFail: true })).stdout.trim()
    const refs = (await this.git.run(['for-each-ref', '--count=1'])).stdout.trim()
    if (head !== MAIN || refs !== '') {
      throw new Error(`${this.repository} has no ${MAIN}, and isn't a fresh repository; refusing to modify it`)
    }
    await this.createRootCommit()
  }

  private async createRootCommit(): Promise<void> {
    const tree = await this.git.emptyTree()
    const id = await this.git.commitTree(tree, [], messageFor(INIT_SUBJECT, SYSTEM), this.options.agent)
    if (!(await this.git.casRef(MAIN, id, null))) throw new Error(`${MAIN} appeared while initializing ${this.repository}`)
  }

  /**
   * Delete what a crashed process leaves behind, now that this one holds the lock:
   * temporary indexes (`dish-index-*`, `.lock` variants included), lock temp files
   * of dead processes, and the ref and packed-refs locks that would make every ref
   * update fail. A lock temp file is only taken for a leftover when its process is
   * gone and it is old: a second process starting up right now has one for a moment
   * (its `acquireLock` is about to fail with `LOCKED`), and must not lose it.
   */
  private async removeStaleFiles(): Promise<void> {
    const stale: string[] = []
    for (const entry of await readdir(this.repository, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      const { name } = entry
      const path = join(this.repository, name)
      if (name.startsWith('dish-index-') || name === 'packed-refs.lock' || (await this.isStaleLockTemp(name, path))) stale.push(path)
    }
    try {
      for (const entry of await readdir(join(this.repository, 'refs'), { recursive: true, withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.lock')) stale.push(join(entry.parentPath, entry.name))
      }
    } catch (error) {
      if ((error as { code?: unknown }).code !== 'ENOENT') throw error
    }
    await Promise.all(stale.map(path => rm(path, { force: true })))
  }

  private async isStaleLockTemp(name: string, path: string): Promise<boolean> {
    const match = LOCK_TEMP.exec(name)
    if (match === null) return false
    const pid = Number(match[1])
    if (pid === process.pid || !processIsGone(pid)) return false
    try {
      return Date.now() - (await stat(path)).mtimeMs > STALE_TEMP_MS
    } catch (error) {
      if ((error as { code?: unknown }).code === 'ENOENT') return false
      throw error
    }
  }

  // --- refs and commits --------------------------------------------------------------------------

  private async mainCommit(): Promise<string> {
    const head = await this.git.resolve(MAIN)
    if (head === undefined) throw new Error(`${MAIN} is missing from ${this.repository}`)
    return head
  }

  /** `'main'` or a full commit id, as a commit. Never hands a caller's string to git as a ref name. */
  private async commitFor(ref: string): Promise<string> {
    if (ref === 'main') return this.mainCommit()
    if (FULL_COMMIT_ID.test(ref)) {
      const commit = await this.git.resolve(ref)
      if (commit !== undefined) return commit
    }
    throw new ConfigStoreError('NOT_FOUND', `no such ref ${JSON.stringify(ref)}: use "main" or a full commit id`)
  }

  /** A full commit id that is reachable from `main`, as a commit; `NOT_FOUND` for anything else. */
  private async mainCommitFor(id: unknown): Promise<string> {
    const found = typeof id === 'string' && FULL_COMMIT_ID.test(id) ? await this.git.resolve(id) : undefined
    if (found !== undefined) {
      const result = await this.git.run(['merge-base', '--is-ancestor', found, MAIN], { allowFail: true })
      if (result.code === 0) return found
      // 1 is "not an ancestor"; anything else is git failing.
      if (result.code !== 1) throw new Error(`git merge-base --is-ancestor failed (exit ${result.code}): ${result.stderr.trim()}`)
    }
    throw new ConfigStoreError('NOT_FOUND', `no such commit on main: ${typeof id === 'string' ? JSON.stringify(id) : typeof id}; use a full commit id`)
  }

  /** One end of a diff: the empty tree, or `commitFor`. */
  private async diffEnd(ref: string): Promise<string> {
    return ref === await this.git.emptyTree() ? ref : this.commitFor(ref)
  }

  /** Whether `commit` has a file at `path` (a directory doesn't count). */
  private async hasFile(commit: string, path: string): Promise<boolean> {
    return (await this.git.listPaths(commit, path)).includes(path)
  }

  private identity(author: Author): GitIdentity {
    return author.kind === 'user' ? this.options.user : this.options.agent
  }

  /**
   * `git log` over `revisions` (see `LOG_FORMAT`), as `CommitInfo`s, newest first.
   * `paths` come from the diff against the first parent, or the empty tree for a first commit.
   */
  private async readCommits(revisions: string[], pathspec: string[]): Promise<CommitInfo[]> {
    // Options and config so that nothing in a user's git config changes the records: `log.showSignature`, `i18n.logOutputEncoding`,
    // `log.follow` (a single path would follow renames) and `core.commentChar`/`commentString` (a `Dish-` or `D` comment string
    // would make git skip every trailer line, and so turn every author into the system).
    const args = [
      '-c', 'core.commentChar=#', 'log', '-z', '--first-parent', '--no-follow', '--no-show-signature', '--encoding=UTF-8',
      `--format=${LOG_FORMAT}`,
    ]
    const fields = (await this.git.run([...args, ...revisions, '--', ...pathspec])).stdout.split('\0')
    fields.pop() // what follows the last record's NUL
    if (fields.length % LOG_FIELDS.length !== 0) throw new Error('git log printed something other than whole records')
    const infos: CommitInfo[] = []
    let empty: string | undefined
    for (let at = 0; at < fields.length; at += LOG_FIELDS.length) {
      const [id, time, parents, kind, session, role, noteValue, message] = fields.slice(at, at + LOG_FIELDS.length) as
        [string, string, string, string, string, string, string, string]
      const parent = parents.split(' ')[0]!
      const before = parent === '' ? (empty ??= await this.git.emptyTree()) : parent
      const paths = (await this.git.changedPaths(before, id)).sort()
      const info: CommitInfo = { id, time: (Number(time) || 0) * 1000, author: authorOf(kind, session, role), message, paths }
      const note = noteOf(noteValue)
      if (note !== undefined) info.note = note
      infos.push(info)
    }
    return infos
  }

  /** The files that differ between `from` and `to` (commits or trees), with their patches. Runs no external program: see `diff`. */
  private async fileDiffs(from: string, to: string, pathspec: string[]): Promise<FileDiff[]> {
    // A user's global git config can name an external diff command or a textconv filter, and git would run it for every file.
    // Its other diff settings must not change the output either: the path prefixes (`diff.noprefix`, `diff.mnemonicPrefix`),
    // the order of the files (`diff.orderFile`, which `-O/dev/null` empties) and whether a path in a header is quoted (`core.quotePath`).
    const base = [
      '-c', 'core.quotePath=false', 'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames',
      '--src-prefix=a/', '--dst-prefix=b/', '-O/dev/null',
    ]
    const listing = (await this.git.run([...base, '--name-status', '-z', from, to, '--', ...pathspec])).stdout.split('\0')
    const diffs: FileDiff[] = []
    for (let at = 0; at + 1 < listing.length; at += 2) {
      const status = listing[at]!
      const path = listing[at + 1]!
      const full = (await this.git.run([...base, from, to, '--', literal(path)])).stdout
      // A literal pathspec still names a directory's whole subtree, so the patch for a file that has become a directory goes on
      // into its children's. Every file's patch starts with `diff --git ` and no line inside one can (hunk lines begin with
      // a space, `+`, `-` or `\`), so a patch ends where the next one begins.
      const next = full.indexOf('\ndiff --git ', 1)
      const patch = next === -1 ? full : full.slice(0, next + 1)
      diffs.push({ path, status: status === 'A' ? 'added' : status === 'D' ? 'deleted' : 'modified', patch })
    }
    return diffs
  }

  // --- checks before git -------------------------------------------------------------------------

  /** Steps 1 to 6 of `write`. Synchronous: nothing here waits on git, so nothing here can be raced. */
  private prepareWrite(changes: Change[], meta: WriteMeta): Prepared {
    const asked = checkAuthorKind(meta)
    const checked = checkChanges(changes)
    checkPaths(checked)
    const owners = this.ownersOf(checked)
    if (asked.kind === 'agent') this.requireAgentMayWrite(owners)
    this.checkGuard(checked)
    this.checkValid(checked, owners)
    const { author, note } = checkMeta(asked, meta.note)
    const prepared: Prepared = { changes: checked, author, summary: note ?? defaultSummary(author) }
    if (note !== undefined) prepared.note = note
    if (meta.base !== undefined) prepared.base = meta.base
    return prepared
  }

  /** Step 3: the namespace that owns each path. */
  private ownersOf(changes: Change[]): Map<string, NamespaceSpec> {
    const owners = new Map<string, NamespaceSpec>()
    for (const { path } of changes) {
      const spec = this.options.namespaces.ownerOf(path)
      if (spec === undefined) throw new ConfigStoreError('UNOWNED', `no namespace owns ${label(path)}`)
      owners.set(path, spec)
    }
    return owners
  }

  private requireAgentMayWrite(owners: Map<string, NamespaceSpec>): void {
    for (const [path, spec] of owners) {
      if (spec.agent !== 'write') {
        throw new ConfigStoreError('FORBIDDEN', `agents may not write ${label(path)}: the ${spec.owner} namespace allows agents to "${spec.agent}" only`)
      }
    }
  }

  /** Step 4. A delete has no text, but its path still goes into the subject, so the path is scanned. */
  private checkGuard(changes: Change[]): void {
    for (const change of changes) checkContent(change.path, 'text' in change ? change.text : '', this.maxBytes)
  }

  /** Step 5. */
  private checkValid(changes: Change[], owners: Map<string, NamespaceSpec>): void {
    for (const change of changes) {
      if (!('text' in change)) continue
      const spec = owners.get(change.path)!
      const problem: unknown = spec.validate(change.path, change.text)
      if (problem === undefined) continue
      if (typeof problem !== 'string') {
        throw new Error(`the validate function of ${JSON.stringify(spec.prefix)} must return a string or undefined`)
      }
      throw invalid(`${change.path}: ${problem === '' ? 'invalid' : problem}`)
    }
  }

  // --- committing --------------------------------------------------------------------------------

  /**
   * Build the commit on the current head and move `main` to it, compare-and-swap.
   * If `main` moved in between (outside interference: inside this process the
   * queue keeps it still), rebuild on the new head, checking `base` again, and
   * try once more.
   */
  private async commitPrepared(prepared: Prepared): Promise<CommitInfo | undefined> {
    const paths = prepared.changes.map(change => change.path)
    for (let attempt = 0; attempt < 2; attempt++) {
      const head = await this.mainCommit()
      if (prepared.base !== undefined) await this.checkBase(prepared.base, head, paths)
      for (const change of prepared.changes) {
        if (!('delete' in change)) continue
        if (!(await this.hasFile(head, change.path))) {
          throw new ConfigStoreError('NOT_FOUND', `cannot delete ${label(change.path)}: it does not exist`)
        }
      }
      // Removals first, so a file can give way to a directory of the same name (or the reverse) in one commit.
      const ordered = [...prepared.changes.filter(change => 'delete' in change), ...prepared.changes.filter(change => !('delete' in change))]
      const tree = await this.git.buildTree(head, ordered)
      const changed = (await this.git.changedPaths(head, tree)).sort()
      if (changed.length === 0) return undefined
      const subject = prepared.subject?.(changed) ?? `${pathList(changed)}: ${prepared.summary}`
      const message = messageFor(subject, prepared.author, prepared.note, prepared.trailers)
      const id = await this.git.commitTree(tree, [head], message, this.identity(prepared.author))
      // Read before the ref moves, so a failure here can't leave a commit the caller was told failed.
      const time = Number((await this.git.run(['log', '-1', '--format=%at', id, '--'])).stdout.trim()) * 1000
      if (await this.git.casRef(MAIN, id, head)) {
        const info: CommitInfo = { id, time, author: prepared.author, message, paths: changed }
        if (prepared.note !== undefined) info.note = prepared.note
        this.announce(info)
        return info
      }
    }
    throw new ConfigStoreError('CONFLICT', 'main kept moving while the change was being committed; nothing was written')
  }

  /** `base` must be a commit, and none of `paths` may have changed between it and `head`. */
  private async checkBase(base: string, head: string, paths: string[]): Promise<void> {
    if (base === head) return
    if (!FULL_COMMIT_ID.test(base) || (await this.git.resolve(base)) === undefined) {
      throw new ConfigStoreError('NOT_FOUND', `base ${JSON.stringify(base)} is not a commit: pass the full id of a main commit`)
    }
    const changed = await this.git.changedPaths(base, head, paths)
    if (changed.length > 0) {
      throw new ConfigStoreError('CONFLICT', `${pathList(changed)} changed since ${base.slice(0, 7)}`)
    }
  }

  /** Tell `onCommit`. The commit has landed, so a failing listener is a warning, not a failed write. */
  private announce(info: CommitInfo): void {
    const { onCommit } = this.options
    if (onCommit === undefined) return
    const failed = (error: unknown): void => warn(`dish-config onCommit callback threw: ${error instanceof Error ? error.message : String(error)}`)
    try {
      Promise.resolve(onCommit(info)).catch(failed)
    } catch (error) {
      failed(error)
    }
  }
}
