/**
 * The `dishMemory` service: the vault's memories and each family's direction, for the context row, the remote and, later,
 * the family chat.
 *
 * - **One write queue.** Every write, delete, release, revert and direction save runs on a queue of the service's own.
 *   Inside it, a change reads the scope's memory files at `main`, makes its change, regenerates the scope's `MEMORY.md`
 *   from the files as they will be, and commits everything as one `store.write`. An index with nothing to list is
 *   deleted. So the index is always the files', and a commit is always one change and its index.
 * - **`base` is checked on the memory file,** not by the store: every write changes the scope's index, so the store's
 *   own check would refuse a save made after any other memory of the scope changed. A memory's text at `base` must be
 *   its text at `main` (absent at both counts as equal), and `base` `''` means "new": a memory that exists is `CONFLICT`.
 * - **Before anything is written,** a memory's fields are checked (`INVALID`), then it is scanned for credentials
 *   (`SECRET`), then an agent's is screened by the judge, in that order: a credential never reaches the judge. One the
 *   judge scores at `warn` or above is saved held: out of the index, the message and `recall`, until the user releases
 *   it. With no judge, or one that can't screen, it is saved as usual. A person's own writes aren't screened, and keep a
 *   held memory held only while its text is what was held.
 * - **Untrusted text.** A memory's description and body, and a direction, go only into the vault, the config store and
 *   what the service returns. No error, warning or event carries them: errors name a memory by its id.
 * - **The caches.** `scopesFor` is cached per agent until the next config change (one without a family for a minute
 *   only, so a clone onboarded later is found), and `compose` per identity until a vault commit or a config change.
 *   The plugin calls `clearCaches` on `dish-config/changed`; the service clears `compose`'s on its own commits.
 *
 * @module dish-memory/service
 */

import { realpath } from 'node:fs/promises'
import { isTopLevelAgent, secretKind } from 'dish-kit'
import { SerialQueue } from 'dish-kit/store'
import type { Author, Change, CommitInfo, EditAuthor, FileDiff, RemoteStatus, VersionedStore } from 'dish-kit/store'
import {
  budgeted, directionPath, identityOf, indexPath, indexText, inputProblem, memoryId, memoryPath, messageText, parseMemory,
  pathScope, scopeDirectory, scopeKey, serializeMemory,
} from './format.ts'
import type { Budget, MemoryFile, MemoryInput, MessageParts, Scope } from './format.ts'
import { DIRECTION_TEMPLATE, NAME, RESERVED_NAME, TYPES } from './protocol.ts'
import type { DirectionInfo, ErrorCode, Memory, MemoryInfo, MemoryType, ScopeInfo, ScopeKey } from './protocol.ts'
import type { DishConfigLike, Services } from './services.ts'

/** The scopes an agent's message is for: the user's memory, and its family's direction, repos and memory. */
export interface Scopes { user: boolean, family?: string }

/** The parts of a dsh agent the service reads: its id, its session's working directory, and whether it is a child. */
export interface AgentLike { id: unknown, session?: { header?: { cwd?: string, delegationDepth?: unknown, origin?: unknown } }, options?: object }

/** What a write did: its commit, whether the memory is new, why it is held if it is, and how full the scope's index now is. */
export interface WriteResult { commit: CommitInfo, created: boolean, held?: string, nearFull: boolean, count: number }

export interface DishMemory {
  /**
   * user: a top-level agent (`isTopLevelAgent`); family: the project whose clone holds the working directory, by real
   * path. Cached per agent id (and working directory) until a config change; one without a family for 60 seconds only.
   */
  scopesFor(agent: AgentLike): Promise<Scopes>
  /**
   * "You", then each family in projects.yaml, then the families with memories and no project (orphans). Without
   * dishProjects, or when it fails, "You" and the vault's families, none marked an orphan.
   */
  scopes(): Promise<ScopeInfo[]>
  /** The scope's memories, held ones included and marked, in the index's order. */
  list(scope: Scope): Promise<MemoryInfo[]>
  read(scope: Scope, name: string): Promise<Memory | undefined>
  /**
   * Create or replace. Refuses INVALID, SECRET, CONFLICT (base: the memory changed since; or base '' and it exists). An
   * agent author's text is screened first.
   */
  write(scope: Scope, input: MemoryInput, meta: { author: Author, base?: string, agent?: unknown, signal?: AbortSignal }): Promise<WriteResult>
  /** NOT_FOUND, CONFLICT. */
  delete(scope: Scope, name: string, meta: { author: Author, base?: string }): Promise<CommitInfo>
  /** NOT_FOUND; a memory that isn't held is INVALID. */
  release(scope: Scope, name: string, meta: { author: Author }): Promise<CommitInfo>
  /** The message for an agent with these scopes, or undefined when there is nothing to say. Cached per identity until a vault commit or a config change. */
  compose(scopes: Scopes): Promise<string | undefined>
  /** The direction at the config store's head, or the template (`missing`). UNAVAILABLE without dishConfig. */
  direction(family: string): Promise<DirectionInfo>
  /** Write the direction as the user; the store checks `base`. UNAVAILABLE without dishConfig. */
  saveDirection(family: string, text: string, meta: { base?: string, note?: string }): Promise<CommitInfo | undefined>
  history(scope: Scope, options?: { limit?: number, before?: string }): Promise<CommitInfo[]>
  commit(id: string): Promise<{ info: CommitInfo, diffs: FileDiff[] }>
  /** Restore the memory files `id` changed and regenerate their indexes. CONFLICT when one changed since; undefined when nothing is left to restore. */
  revert(id: string, meta: { author: Author }): Promise<CommitInfo | undefined>
  remoteStatus(): Promise<RemoteStatus>
}

/** A refusal of the service's own, as the store's `StoreError` is one of the vault's: both carry a `code`. */
export class MemoryError extends Error {
  code: ErrorCode

  constructor(code: ErrorCode, message: string) {
    super(message)
    this.name = 'MemoryError'
    this.code = code
  }
}

// Here, with the type, so that whoever imports it also gets `ctx.get('dishMemory')` and the events typed.
declare module '@deepseek-ai/cordis' {
  interface Context {
    dishMemory: DishMemory
  }

  interface Events {
    /** After every vault commit: the scopes it touched (`user`, `family:<f>`), its id and who made it. */
    'dish-memory/changed'(scopes: ScopeKey[], commit: string, author: Author): void
    /** The vault's remote copy changed: a push started, failed or succeeded, or a commit is waiting. */
    'dish-memory/remote'(status: RemoteStatus): void
  }
}

export interface MemoryOptions {
  store: VersionedStore
  services: Services
  /** Each scope's budget in the message, and in a write's `nearFull`. */
  budget: Budget
  /** A line for the log. Never given a memory's text. */
  warn: (message: string) => void
  /** Told of every commit the service makes: `dish-memory/changed`. */
  emit: (scopes: ScopeKey[], commit: string, author: Author) => void
  /** The clock, in milliseconds since the epoch. Default `Date.now`. */
  now?: () => number
}

const USER: Scope = { kind: 'user' }
/** How long `scopesFor` keeps an answer without a family. */
const NO_FAMILY_MS = 60_000
/** The most agents `scopesFor` remembers; the oldest goes first. */
const AGENTS_KEPT = 1000
/** A write's note, `<id>: <description>`, is cut to this many characters. */
const NOTE_CHARS = 120
const SHORT_ID = 7
const NO_CONFIG = 'the config store isn\'t running'
const FAMILY_RULE = 'family must be a lowercase name: letters, digits and hyphens, starting with a letter or digit, at most 64 characters'
const NAME_RULE = 'name must be lowercase letters, digits and hyphens, starting with a letter or digit, at most 64 characters'
const SCOPE_RULE = 'a scope is the user\'s or a family\'s'

/** A memory file as read: its text, and what it says. */
interface Entry { text: string, memory: MemoryFile }

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function checkFamily(family: unknown): string {
  if (typeof family !== 'string' || !NAME.test(family)) throw new MemoryError('INVALID', FAMILY_RULE)
  return family
}

function checkScope(scope: Scope): Scope {
  if (scope?.kind === 'user') return USER
  if (scope?.kind === 'family') return { kind: 'family', family: checkFamily(scope.family) }
  throw new MemoryError('INVALID', SCOPE_RULE)
}

function checkName(name: unknown): string {
  if (typeof name !== 'string' || !NAME.test(name) || name === RESERVED_NAME) throw new MemoryError('INVALID', NAME_RULE)
  return name
}

/** The store's author: a person or an agent. The store's own (`system`) is never a caller's. */
function editAuthor(author: Author): EditAuthor {
  if (author?.kind !== 'user' && author?.kind !== 'agent') throw new MemoryError('INVALID', 'a memory is changed by the user or an agent')
  return author
}

/** `ms` as `modified` writes it: ISO 8601 in UTC, to the second. */
function stamp(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z')
}

/** A commit's note: one line, without control characters, cut to `NOTE_CHARS` characters (by code point). */
function noteOf(text: string): string {
  const line = text.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim()
  return Array.from(line).slice(0, NOTE_CHARS).join('').trimEnd()
}

/** Whether a memory says what `input` says: its type, description and body. When, and whether it's held, aside. */
function sameText(memory: MemoryFile, input: { type: string, description: string, body: string }): boolean {
  return memory.type === input.type && memory.description === input.description && memory.body === input.body
}

/** The scopes a commit's paths touched, as the wire names them. */
function scopesOf(paths: readonly string[]): ScopeKey[] {
  const keys = new Set<ScopeKey>()
  for (const path of paths) {
    const at = pathScope(path)
    if (at !== undefined) keys.add(scopeKey(at.scope))
  }
  return [...keys]
}

function timeOf(memory: MemoryFile): number {
  const value = Date.parse(memory.modified)
  return Number.isNaN(value) ? 0 : value
}

/** The index's order: by type, then newest first, then by name. */
function byIndexOrder(a: MemoryFile, b: MemoryFile): number {
  return TYPES.indexOf(a.type) - TYPES.indexOf(b.type) || timeOf(b) - timeOf(a) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
}

function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function infoOf(scope: Scope, memory: MemoryFile): MemoryInfo {
  const info: MemoryInfo = { scope: scopeKey(scope), name: memory.name, type: memory.type, description: memory.description, modified: memory.modified }
  if (memory.held !== undefined) info.held = memory.held
  return info
}

function memoriesOf(files: ReadonlyMap<string, Entry>): MemoryFile[] {
  return [...files.values()].map(entry => entry.memory)
}

/** The service over `options.store`, with `clearCaches` for the plugin to call on a config change. */
export function createMemory(options: MemoryOptions): DishMemory & { clearCaches(): void } {
  const { store, services, budget } = options
  const now = options.now ?? Date.now
  const queue = new SerialQueue()
  const told = new Set<string>()

  const warn = (message: string): void => {
    try {
      options.warn(message)
    } catch {
      // A log line is not worth a failed call.
    }
  }

  // scopesFor's answers by agent id and working directory; `until` is when one without a family runs out. The generation
  // tells an answer worked out before a clear from one after it, so the older one isn't kept.
  const agents = new Map<string, { scopes: Scopes, until?: number }>()
  let generation = 0
  // compose's messages by identity, as promises, so that callers at once share one.
  const composed = new Map<string, Promise<string | undefined>>()

  const clearCaches = (): void => {
    agents.clear()
    generation++
    composed.clear()
  }

  /** A commit of the service's: the messages are out of date, and dish-memory/changed says what changed. */
  const committed = (info: CommitInfo): void => {
    composed.clear()
    try {
      options.emit(scopesOf(info.paths), info.id, info.author)
    } catch (error) {
      warn(`a dish-memory/changed listener failed: ${describe(error)}`)
    }
  }

  const requireConfig = (): DishConfigLike => {
    const config = services.config()
    if (config === undefined) throw new MemoryError('UNAVAILABLE', NO_CONFIG)
    return config
  }

  /** The scope's memory files at `ref`, by name. A file that doesn't parse (it got past the store somehow) is left out, and said once. */
  const readScope = async (scope: Scope, ref: string): Promise<Map<string, Entry>> => {
    const files = new Map<string, Entry>()
    for (const path of await store.list(scopeDirectory(scope), ref)) {
      const at = pathScope(path)
      if (at === undefined || 'index' in at) continue
      const text = await store.read(path, ref)
      if (text === undefined) continue
      const memory = parseMemory(path, text)
      if (typeof memory === 'string') {
        if (!told.has(`${path}\n${memory}`)) {
          told.add(`${path}\n${memory}`)
          warn(`left out ${path}, which isn't a memory: ${memory}`)
        }
        continue
      }
      files.set(at.name, { text, memory })
    }
    return files
  }

  /** The index's change for `files`, the scope's memories as they will be: its new text, or its deletion when it lists nothing. */
  const indexChanges = async (scope: Scope, files: ReadonlyMap<string, Entry>, head: string): Promise<Change[]> => {
    const path = indexPath(scope)
    const text = indexText(memoriesOf(files))
    if (text !== '') return [{ path, text }]
    return (await store.read(path, head)) === undefined ? [] : [{ path, delete: true }]
  }

  /** The memory file's `base` check (see the module comment), against its text at `main` now. */
  const checkBase = async (scope: Scope, name: string, current: string | undefined, base: string | undefined): Promise<void> => {
    if (base === undefined) return
    const id = memoryId(scope.kind, name)
    if (base === '') {
      if (current !== undefined) throw new MemoryError('CONFLICT', `${id} already exists`)
      return
    }
    if ((await store.read(memoryPath(scope, name), base)) !== current) throw new MemoryError('CONFLICT', `${id} changed since you loaded it`)
  }

  /** Commit `changes` on `head`, and tell of it. When they change nothing, `main` as it is. */
  const commitChanges = async (changes: Change[], author: EditAuthor, note: string, head: string): Promise<CommitInfo> => {
    const info = await store.write(changes, { author, note, base: head })
    if (info === undefined) return (await store.commit('main')).info
    committed(info)
    return info
  }

  /** Why an agent's memory is held, or `undefined`: the judge's verdict. No judge, or one that can't screen, holds nothing. */
  const screen = async (id: string, input: MemoryInput, meta: { agent?: unknown, signal?: AbortSignal }): Promise<string | undefined> => {
    const judge = services.judge()
    if (judge === undefined) return undefined
    try {
      const result = await judge.screenText({
        text: `${input.description}\n\n${input.body}`,
        subject: `memory:${id}`,
        tool: 'remember',
        ...(meta.agent === undefined ? {} : { agent: meta.agent }),
        ...(meta.signal === undefined ? {} : { signal: meta.signal }),
      })
      if (result.verdict !== 'warn' && result.verdict !== 'withhold') return undefined
      const p = Number(result.probability)
      return `Jev scored it ${Number.isFinite(p) ? p.toFixed(2) : 'high'} as instructions aimed at an agent`
    } catch {
      // screenText never throws; one that does is a judge that can't screen, and its error may quote what it was given.
      warn(`could not screen ${id}, so it is saved as usual: the screen failed`)
      return undefined
    }
  }

  /** The family whose project's clone holds `cwd`, by real path, or `undefined`. The deepest clone wins. */
  const familyAt = async (cwd: unknown): Promise<string | undefined> => {
    if (typeof cwd !== 'string' || cwd === '') return undefined
    const projects = services.projects()
    const workspaces = services.workspaces()
    if (projects === undefined || workspaces === undefined) return undefined
    let real: string
    try {
      real = await realpath(cwd)
    } catch {
      return undefined
    }
    let list: Awaited<ReturnType<typeof projects.list>>
    try {
      list = await projects.list()
    } catch (error) {
      warn(`could not list the projects, so no family is known: ${describe(error)}`)
      return undefined
    }
    let found: { clone: string, family: string } | undefined
    for (const project of list) {
      if (typeof project.family !== 'string' || !NAME.test(project.family)) continue
      let clone: string
      try {
        const where = workspaces.describe(project.name)?.clone
        if (typeof where !== 'string' || where === '') continue
        clone = await realpath(where)
      } catch {
        continue
      }
      const inside = real === clone || real.startsWith(clone.endsWith('/') ? clone : `${clone}/`)
      if (inside && (found === undefined || clone.length > found.clone.length)) found = { clone, family: project.family }
    }
    return found?.family
  }

  /** The message's parts, and whether every part could be read: one that couldn't isn't cached. */
  const build = async (scopes: Scopes): Promise<{ text: string | undefined, complete: boolean }> => {
    const head = await store.head()
    const parts: MessageParts = { repos: [] }
    let complete = true
    if (scopes.user) parts.user = budgeted(memoriesOf(await readScope(USER, head)), 'user', budget)
    if (scopes.family !== undefined && scopes.family !== '') {
      const family = checkFamily(scopes.family)
      parts.family = family
      parts.familyMemory = budgeted(memoriesOf(await readScope({ kind: 'family', family }, head)), 'family', budget)
      const config = services.config()
      if (config === undefined) {
        complete = false
      } else {
        try {
          const direction = await config.read(directionPath(family))
          if (direction !== undefined) parts.direction = direction
        } catch (error) {
          complete = false
          warn(`could not read family ${family}'s direction: ${describe(error)}`)
        }
      }
      const projects = services.projects()
      if (projects === undefined) {
        complete = false
      } else {
        try {
          parts.repos = (await projects.list())
            .filter(project => project.family === family && project.role.trim() !== '')
            .map(project => ({ name: project.name, role: project.role }))
            .sort((a, b) => byText(a.name, b.name))
        } catch (error) {
          complete = false
          warn(`could not list family ${family}'s repos: ${describe(error)}`)
        }
      }
    }
    return { text: messageText(parts), complete }
  }

  const service: DishMemory & { clearCaches(): void } = {
    clearCaches,

    async scopesFor(agent) {
      const id = agent?.id
      const cwd = agent?.session?.header?.cwd
      // By id and working directory, so that a session that moves is placed again. An agent without an id isn't kept:
      // it would share its answer with every other one.
      const key = id === undefined || id === null || id === '' ? undefined : `${String(id)}\0${String(cwd)}`
      const cached = key === undefined ? undefined : agents.get(key)
      if (cached !== undefined && (cached.until === undefined || now() < cached.until)) return { ...cached.scopes }
      const started = generation
      const user = isTopLevelAgent(agent)
      const family = await familyAt(cwd)
      const scopes: Scopes = family === undefined ? { user } : { user, family }
      if (key !== undefined && started === generation) {
        agents.delete(key)
        agents.set(key, family === undefined ? { scopes, until: now() + NO_FAMILY_MS } : { scopes })
        if (agents.size > AGENTS_KEPT) agents.delete(agents.keys().next().value!)
      }
      return { ...scopes }
    },

    async scopes() {
      const head = await store.head()
      const counts = new Map<ScopeKey, { scope: Scope, count: number, held: number }>()
      for (const path of await store.list('', head)) {
        const at = pathScope(path)
        if (at === undefined || 'index' in at) continue
        const text = await store.read(path, head)
        const memory = text === undefined ? undefined : parseMemory(path, text)
        if (memory === undefined || typeof memory === 'string') continue
        const key = scopeKey(at.scope)
        const entry = counts.get(key) ?? { scope: at.scope, count: 0, held: 0 }
        entry.count++
        if (memory.held !== undefined) entry.held++
        counts.set(key, entry)
      }
      const infoFor = (key: ScopeKey, label: string, orphan: boolean): ScopeInfo => {
        const entry = counts.get(key)
        return { key, label, count: entry?.count ?? 0, held: entry?.held ?? 0, orphan }
      }
      const inVault = [...counts.values()].flatMap(({ scope }) => scope.kind === 'family' ? [scope.family] : []).sort(byText)
      // The families of projects.yaml, or `undefined` when they can't be known: without dishProjects, or when it fails.
      // Then the vault's families are listed as they are, none of them taken for an orphan.
      let families: Set<string> | undefined
      const projects = services.projects()
      if (projects !== undefined) {
        try {
          families = new Set((await projects.list()).map(project => project.family).filter(family => NAME.test(family)))
        } catch (error) {
          warn(`could not list the projects, so only the vault's families are listed: ${describe(error)}`)
        }
      }
      if (families === undefined) return [infoFor('user', 'You', false), ...inVault.map(family => infoFor(`family:${family}`, family, false))]
      const known = families
      return [
        infoFor('user', 'You', false),
        ...[...known].sort(byText).map(family => infoFor(`family:${family}`, family, false)),
        ...inVault.filter(family => !known.has(family)).map(family => infoFor(`family:${family}`, family, true)),
      ]
    },

    async list(scope) {
      const checked = checkScope(scope)
      const files = await readScope(checked, await store.head())
      return memoriesOf(files).sort(byIndexOrder).map(memory => infoOf(checked, memory))
    },

    async read(scope, name) {
      const checked = checkScope(scope)
      if (typeof name !== 'string' || !NAME.test(name) || name === RESERVED_NAME) return undefined
      const head = await store.head()
      const path = memoryPath(checked, name)
      const text = await store.read(path, head)
      if (text === undefined) return undefined
      const memory = parseMemory(path, text)
      if (typeof memory === 'string') return undefined
      return { ...infoOf(checked, memory), body: memory.body, commit: head }
    },

    async write(scope, input, meta) {
      const checked = checkScope(scope)
      const author = editAuthor(meta.author)
      const problem = inputProblem(input)
      if (problem !== undefined) throw new MemoryError('INVALID', problem)
      const { name, description, body } = input
      const type = input.type as MemoryType
      const id = memoryId(checked.kind, name)
      const note = noteOf(`${id}: ${description}`)
      // Everything the commit will hold, as the store will scan it: the fields, the file and the note. Before the screen,
      // so that a credential never goes to the judge.
      const kind = secretKind(description) ?? secretKind(body) ?? secretKind(note)
        ?? secretKind(serializeMemory({ name, description, type, modified: stamp(now()), body }))
      if (kind !== undefined) throw new MemoryError('SECRET', `the memory looks like it holds a credential (${kind}); never save secrets`)
      const flagged = author.kind === 'agent' ? await screen(id, input, meta) : undefined
      // A call cancelled while it was screened saves nothing.
      meta.signal?.throwIfAborted()
      return queue.run(async () => {
        const head = await store.head()
        const files = await readScope(checked, head)
        const existing = files.get(name)
        await checkBase(checked, name, existing?.text, meta.base)
        const unchanged = existing !== undefined && sameText(existing.memory, input)
        const held = flagged ?? (unchanged ? existing.memory.held : undefined)
        const memory: MemoryFile = { name, description, type, modified: stamp(now()), body }
        if (held !== undefined) memory.held = held
        const text = serializeMemory(memory)
        files.set(name, { text, memory })
        const changes: Change[] = [{ path: memoryPath(checked, name), text }, ...await indexChanges(checked, files, head)]
        const info = await commitChanges(changes, author, note, head)
        const listed = budgeted(memoriesOf(files), checked.kind, budget)
        const result: WriteResult = { commit: info, created: existing === undefined, nearFull: listed.nearFull, count: listed.lines.length + listed.more }
        if (held !== undefined) result.held = held
        return result
      })
    },

    async delete(scope, name, meta) {
      const checked = checkScope(scope)
      checkName(name)
      const author = editAuthor(meta.author)
      const id = memoryId(checked.kind, name)
      return queue.run(async () => {
        const head = await store.head()
        const files = await readScope(checked, head)
        const existing = files.get(name)
        if (existing === undefined) throw new MemoryError('NOT_FOUND', `no memory ${id}`)
        await checkBase(checked, name, existing.text, meta.base)
        files.delete(name)
        const changes: Change[] = [{ path: memoryPath(checked, name), delete: true }, ...await indexChanges(checked, files, head)]
        return commitChanges(changes, author, `${id}: deleted`, head)
      })
    },

    async release(scope, name, meta) {
      const checked = checkScope(scope)
      checkName(name)
      const author = editAuthor(meta.author)
      const id = memoryId(checked.kind, name)
      return queue.run(async () => {
        const head = await store.head()
        const files = await readScope(checked, head)
        const existing = files.get(name)
        if (existing === undefined) throw new MemoryError('NOT_FOUND', `no memory ${id}`)
        if (existing.memory.held === undefined) throw new MemoryError('INVALID', `${id} isn't held`)
        const { held: _held, ...memory } = existing.memory
        const text = serializeMemory(memory)
        files.set(name, { text, memory })
        const changes: Change[] = [{ path: memoryPath(checked, name), text }, ...await indexChanges(checked, files, head)]
        return commitChanges(changes, author, `${id}: released`, head)
      })
    },

    async compose(scopes) {
      const identity = identityOf(scopes)
      if (identity === '') return undefined
      const cached = composed.get(identity)
      if (cached !== undefined) return cached
      const building = build(scopes)
      const text = building.then(built => built.text)
      composed.set(identity, text)
      const forget = (): void => {
        if (composed.get(identity) === text) composed.delete(identity)
      }
      building.then(built => { if (!built.complete) forget() }, forget)
      return text
    },

    async direction(family) {
      checkFamily(family)
      const config = requireConfig()
      const path = directionPath(family)
      const commit = await config.head()
      const text = await config.read(path, commit)
      const proposals = await config.proposals()
      const pendingProposals = proposals.filter(proposal => proposal.status !== 'rejected' && proposal.paths.includes(path)).length
      return { family, text: text ?? DIRECTION_TEMPLATE, commit, missing: text === undefined, pendingProposals }
    },

    async saveDirection(family, text, meta) {
      checkFamily(family)
      const config = requireConfig()
      return queue.run(async () => {
        const saved = await config.write([{ path: directionPath(family), text }], {
          author: { kind: 'user' },
          ...(meta.base === undefined || meta.base === '' ? {} : { base: meta.base }),
          ...(meta.note === undefined ? {} : { note: meta.note }),
        })
        if (saved !== undefined) composed.clear()
        return saved
      })
    },

    async history(scope, options = {}) {
      const checked = checkScope(scope)
      return store.history({
        prefix: scopeDirectory(checked),
        ...(options.limit === undefined ? {} : { limit: options.limit }),
        ...(options.before === undefined || options.before === '' ? {} : { before: options.before }),
      })
    },

    commit(id) {
      return store.commit(id)
    },

    async revert(id, meta) {
      const author = editAuthor(meta.author)
      return queue.run(async () => {
        const { info } = await store.commit(id)
        const short = info.id.slice(0, SHORT_ID)
        const memories = info.paths.flatMap(path => {
          const at = pathScope(path)
          return at === undefined || 'index' in at ? [] : [{ path, scope: at.scope, name: at.name }]
        })
        if (memories.length === 0) {
          const indexes = info.paths.some(path => pathScope(path) !== undefined)
          throw new MemoryError('INVALID', `${short} changed no memory${indexes ? ', only an index' : ''}: nothing to revert`)
        }
        // Its parent on main: `NOT_FOUND` for a commit that isn't on main.
        const [parent] = await store.history({ before: info.id, limit: 1 })
        if (parent === undefined) throw new MemoryError('INVALID', `${short} is the first commit: nothing to revert`)
        const head = await store.head()
        const restored = new Map<ScopeKey, { scope: Scope, texts: Map<string, string | undefined> }>()
        for (const { path, scope, name } of memories) {
          const before = await store.read(path, parent.id)
          const current = await store.read(path, head)
          // Already as it was before the commit: nothing left to restore here.
          if (current === before) continue
          if (current !== await store.read(path, info.id)) throw new MemoryError('CONFLICT', `${memoryId(scope.kind, name)} changed since ${short}`)
          const key = scopeKey(scope)
          const entry = restored.get(key) ?? { scope, texts: new Map() }
          entry.texts.set(name, before)
          restored.set(key, entry)
        }
        if (restored.size === 0) return undefined
        const changes: Change[] = []
        for (const { scope, texts } of restored.values()) {
          const files = await readScope(scope, head)
          for (const [name, text] of texts) {
            const path = memoryPath(scope, name)
            if (text === undefined) {
              files.delete(name)
              changes.push({ path, delete: true })
              continue
            }
            changes.push({ path, text })
            const memory = parseMemory(path, text)
            // A text that no longer parses is the store's to refuse (its validate), not the index's to list.
            if (typeof memory === 'string') files.delete(name)
            else files.set(name, { text, memory })
          }
          changes.push(...await indexChanges(scope, files, head))
        }
        return commitChanges(changes, author, `Revert ${short}`, head)
      })
    },

    remoteStatus() {
      return store.remoteStatus()
    },
  }
  return service
}
