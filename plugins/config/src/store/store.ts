import { access, mkdir, readdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { ConfigStoreError } from './errors.ts'
import { Git, pathProblem } from './git.ts'
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
const INIT_SUBJECT = 'Initialize dish config'
const SYSTEM: Author = { kind: 'system' }
const CONTROL = /[\x00-\x1f\x7f]/
/** Control characters as a note may still hold them once whitespace is gone: C0, DEL and C1. */
const NOTE_CONTROL = /[\x00-\x1f\x7f-\x9f]/
/** `dish.lock.<pid>.<random>.tmp`: the temporary file `acquireLock` links the lock from. */
const LOCK_TEMP = /^dish\.lock\.(\d+)\.[0-9a-f]+\.tmp$/

/** What `write` and `seed` hand to `commit` once every check has passed. */
interface Prepared {
  changes: Change[]
  author: Author
  note?: string
  base?: string
  /** The subject's text after `<paths>: `. */
  summary: string
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
  for (const [field, value] of fields) {
    const kind = secretKind(value)
    if (kind !== undefined) throw new ConfigStoreError('SECRET', `the ${field} looks like ${kind}`)
  }
  return note === undefined ? { author: recorded } : { author: recorded, note: capNote(note) }
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
function messageFor(subject: string, author: Author, note?: string): string {
  const trailers = [`Dish-Author-Kind: ${author.kind}`]
  if (author.kind === 'agent') trailers.push(`Dish-Session: ${author.sessionId}`, `Dish-Role: ${author.role ?? DEFAULT_ROLE}`)
  if (note !== undefined) trailers.push(`Dish-Note: ${note}`)
  return `${subject}\n\n${trailers.join('\n')}\n`
}

function isOwnLockFile(name: string): boolean {
  return name === 'dish.lock' || LOCK_TEMP.test(name)
}

/** A `dish.lock.<pid>.<random>.tmp` left by some other process. */
function isForeignLockTemp(name: string): boolean {
  const match = LOCK_TEMP.exec(name)
  return match !== null && Number(match[1]) !== process.pid
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
   * and nothing reaches git until all have passed:
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
    return this.run(() => this.commit(this.prepareWrite(changes, meta)))
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
      const head = await this.mainCommit()
      const missing: Change[] = []
      for (const change of all) {
        if (!(await this.hasFile(head, change.path))) missing.push(change)
      }
      if (missing.length === 0) return undefined
      this.checkGuard(missing)
      this.checkValid(missing, owners)
      // `base` makes the retry notice a document that appeared in the meantime, instead of overwriting it.
      return this.commit({ changes: missing, author: SYSTEM, base: head, summary: `${owner} defaults` })
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
   * With the lock held, a repository that already exists is cleaned of what a
   * crashed run left; one that doesn't is created, but only in a directory with
   * nothing else in it.
   */
  private async ensureRepository(): Promise<void> {
    if (!(await this.pathExists(join(this.repository, 'HEAD')))) {
      await this.initialize()
      return
    }
    await this.removeStaleFiles()
    if ((await this.git.resolve(MAIN)) === undefined) await this.completeInitialization()
  }

  private async pathExists(path: string): Promise<boolean> {
    try {
      await access(path)
      return true
    } catch (error) {
      if ((error as { code?: unknown }).code === 'ENOENT') return false
      throw error
    }
  }

  private async initialize(): Promise<void> {
    const others = (await readdir(this.repository)).filter(name => !isOwnLockFile(name))
    if (others.length > 0) {
      throw new Error(`${this.repository} is not a dish config repository, refusing to initialize over existing files`)
    }
    await this.git.initBare('main')
    await this.createRootCommit()
  }

  /**
   * A repository whose `HEAD` exists but `main` doesn't. The only one this
   * store will touch is a freshly initialized one with no refs at all (a crash
   * between `git init` and the root commit); anything else isn't its own.
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
   * temporary indexes (`dish-index-*`, `.lock` variants included), other
   * processes' lock temp files, and the ref and packed-refs locks that would make every ref update fail.
   */
  private async removeStaleFiles(): Promise<void> {
    const stale: string[] = []
    for (const entry of await readdir(this.repository, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      const { name } = entry
      if (name.startsWith('dish-index-') || name === 'packed-refs.lock' || isForeignLockTemp(name)) {
        stale.push(join(this.repository, name))
      }
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

  /** Whether `commit` has a file at `path` (a directory doesn't count). */
  private async hasFile(commit: string, path: string): Promise<boolean> {
    return (await this.git.listPaths(commit, path)).includes(path)
  }

  private identity(author: Author): GitIdentity {
    return author.kind === 'user' ? this.options.user : this.options.agent
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
  private async commit(prepared: Prepared): Promise<CommitInfo | undefined> {
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
      const tree = await this.git.buildTree(head, prepared.changes)
      const changed = (await this.git.changedPaths(head, tree)).sort()
      if (changed.length === 0) return undefined
      const message = messageFor(`${pathList(changed)}: ${prepared.summary}`, prepared.author, prepared.note)
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
