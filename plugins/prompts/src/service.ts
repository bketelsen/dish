/**
 * The `dishPrompts` service: what each role's prompt says, now and for one agent's whole life.
 *
 * The texts live in the config store (`dishConfig`), and the store is optional. A service call looks the store
 * up when it is made, so a store that appears or goes away is handled call by call, and with none every answer
 * is the shipped default.
 *
 * - `persona(role)` and `roles()` read the store as it is now. A failure of the store is passed on to the caller:
 *   these are for pages and for `crew`, which can say what went wrong.
 * - `snapshot(agent, role)` is for the agent's own step, which a prompt must never fail, so it doesn't reject
 *   because of the snapshot files or the store. At worst it returns the shipped defaults, with `commit: null`, and
 *   logs why. It still rejects when there is no text to give: for a name that isn't a role, and for a crew role
 *   with no shipped default (one that exists only in the store) while the store can't supply its document.
 *
 * A snapshot is the store's `main` commit when the agent was first asked about, kept in `SnapshotFiles`; its texts
 * are read at that commit, which never changes. In detail:
 *
 * - one in-memory promise per agent id, so concurrent first calls share one snapshot, and later calls read no files;
 * - the role in the record decides, not the role of the call (after a restart the first call would otherwise
 *   choose it). A record whose role is not a role, or has no text at its commit, is replaced by a fresh snapshot
 *   for the call's role, as is a record whose commit the store doesn't have;
 * - a record that can't be read at all (permissions, say) is not replaced, because a rename over it would destroy
 *   the original. The agent gets a fresh snapshot from memory, for this process only;
 * - when the store can't answer for a record that has a commit, the agent gets the defaults for now and nothing is
 *   remembered, neither in memory nor on disk, so its own text is back as soon as the store answers;
 * - each kind of trouble is logged once per agent, until the agent has a snapshot again or is dropped, and the
 *   return from the defaults to its own text is logged once, because dsh records it as a new system message.
 *
 * @module dish-prompts/service
 */
import type { DishConfigService } from 'dish-config'
import { defaultText } from './defaults.ts'
import { CREW_ROLES, pathFor, roleFor } from './roles.ts'
import type { Role } from './roles.ts'
import type { SnapshotFiles, SnapshotRecord } from './snapshots.ts'

/** A role's prompt, as text. Interpolation of `{{variables}}` is the caller's, where the agent's variables are known. */
export interface Persona {
  /** The role's own document: `prompts/main.md`, or `prompts/crew/<role>.md`. */
  prefix: string
  /** The rules every role shares: `prompts/common.md`. */
  suffix: string
  /** The store commit the texts were read at, or `null` when they are the shipped defaults of a store that wasn't there. */
  commit: string | null
}

export interface DishPrompts {
  /** `common`, `main`, then the crew roles (shipped, or found under `prompts/crew/`), sorted. */
  roles(): Promise<string[]>
  /**
   * The texts on `main` right now, with the shipped default for a document that is missing.
   * @throws `Error` for `common` (it isn't a role of its own), for a name that can't be a role, and for a crew role
   * with neither a document nor a default: that one has the `code` `UNKNOWN_ROLE`. A failure of the store is passed on.
   */
  persona(role: string): Promise<Persona>
  /**
   * The agent's snapshot: taken on the first call for that agent, the same for its whole life, even across a restart.
   * The role is the one in the agent's record if it has a usable one, else the one of the call. Never rejects
   * because of the snapshot files or the store; see the module comment. Rejects like `persona` for a name that isn't a
   * role, and for a crew role that has no shipped default (one that exists only in the store) while the store can't
   * supply its document.
   */
  snapshot(agent: { id: string }, role: string): Promise<Persona>
  /** Forget the agent's snapshot (on `/clear`); its next call takes a new one. Never rejects. */
  drop(agent: { id: string }): Promise<void>
  /** The shipped default for a role, or `undefined` for a role with none. */
  defaultText(role: string): string | undefined
}

// Here, not in the plugin's own file, so that whoever imports these types (the persona row does, and only that) also
// gets `ctx.get('dishPrompts')` typed.
declare module '@deepseek-ai/cordis' {
  interface Context {
    dishPrompts: DishPrompts
  }
}

/** What the service needs of the store: dish-config's reads. */
export type StoreReader = Pick<DishConfigService, 'head' | 'read' | 'list'>

/** What the service needs of the snapshot files. */
export type SnapshotStore = Pick<SnapshotFiles, 'get' | 'put' | 'drop'>

export interface ServiceLogger {
  warn(format: string, ...args: unknown[]): void
  info(format: string, ...args: unknown[]): void
}

export interface ServiceOptions {
  /** The store as it is right now, or `undefined` if there is none. Called on every operation. */
  store: () => StoreReader | undefined
  files: SnapshotStore
  logger: ServiceLogger
}

/** The documents of a role as the store holds them: `undefined` for one that is missing. */
interface Documents {
  own: string | undefined
  common: string | undefined
}

/** A snapshot, and whether it is final: a snapshot that isn't (the store failed to answer) is not remembered. */
interface Taken {
  persona: Persona
  final: boolean
}

/**
 * The `code` of the error `persona` and `snapshot` throw for a crew role that has neither a document in the store nor a shipped
 * default. A caller in another module tells that failure from a store that can't be read by this string, not by `instanceof`
 * (separate copies of a module have separate classes) or by the message.
 */
export const UNKNOWN_ROLE = 'UNKNOWN_ROLE'

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** `error`'s `code`, if it has one. Another package's error classes are recognised by this alone. */
function errorCode(error: unknown): unknown {
  return (error as { code?: unknown } | null)?.code
}

/** @throws `Error` unless `role` is `main` or a crew role name: those are the roles with a persona. */
function checkRole(role: unknown): asserts role is Role {
  if (typeof role !== 'string') throw new TypeError(`role must be a string, not ${typeof role}`)
  if (role === 'common') throw new Error('"common" has no persona of its own: it is the suffix of every role')
  // Throws for a name that can't be a role.
  pathFor(role)
}

/** @throws `TypeError` unless `agent` has a non-empty id. */
function agentId(agent: unknown): string {
  const id = (agent as { id?: unknown } | null | undefined)?.id
  if (typeof id !== 'string' || id === '') throw new TypeError('an agent needs a non-empty id')
  return id
}

export function createDishPrompts(options: ServiceOptions): DishPrompts {
  const { store, files } = options
  /** A log line that can't throw into the caller, whatever the logger does. */
  const warn = (format: string, ...args: unknown[]): void => {
    try {
      options.logger.warn(format, ...args)
    } catch {
      // Logging is not worth a failed step.
    }
  }

  const info = (format: string, ...args: unknown[]): void => {
    try {
      options.logger.info(format, ...args)
    } catch {
      // As above.
    }
  }

  /** One in-memory promise per agent id: the agent's snapshot, from its first call until it is dropped. */
  const agents = new Map<string, Promise<Taken>>()
  /** The drops that are still working, so a snapshot that follows one waits for it. */
  const dropping = new Map<string, Promise<void>>()
  /** Document paths already reported as missing from the store. */
  const missing = new Set<string>()
  /** What has been reported about each agent, by kind, until it has a snapshot again or is dropped. */
  const reported = new Map<string, Set<string>>()

  /** `role`'s shipped text, for a document that isn't in the store. @throws `Error` for a role with none. */
  function fallback(role: Role, stored: boolean): string {
    const text = defaultText(role)
    if (text === undefined) throw Object.assign(new Error(`unknown role "${role}"`), { code: UNKNOWN_ROLE })
    const path = pathFor(role)
    if (stored && !missing.has(path)) {
      missing.add(path)
      warn('%s is not in the config store; using the shipped default', path)
    }
    return text
  }

  /** The persona from what the store held at `commit`, or, with `documents` `undefined`, from the defaults alone. */
  function compose(role: Role, documents: Documents | undefined, commit: string | null): Persona {
    const stored = documents !== undefined
    return {
      prefix: documents?.own ?? fallback(role, stored),
      suffix: documents?.common ?? fallback('common', stored),
      commit,
    }
  }

  /** The documents of `role` and of `common` at `ref`. Store errors are thrown. */
  async function readDocuments(reader: StoreReader, role: Role, ref: string): Promise<Documents> {
    const [own, common] = await Promise.all([reader.read(pathFor(role), ref), reader.read(pathFor('common'), ref)])
    return { own, common }
  }

  /** A warning about the agent, unless this kind of trouble has already been reported since it last had a snapshot. */
  function reportOnce(id: string, kind: string, format: string, ...args: unknown[]): void {
    let kinds = reported.get(id)
    if (kinds === undefined) {
      kinds = new Set()
      reported.set(id, kinds)
    }
    if (kinds.has(kind)) return
    kinds.add(kind)
    warn(format, ...args)
  }

  /** The agent is served the defaults, because the store couldn't answer. */
  function degraded(id: string, why: string): void {
    reportOnce(id, 'degraded', 'cannot read the prompts for agent %s from the store (%s); it gets the shipped defaults for now', id, why)
  }

  /**
   * The agent has a snapshot for good: what was reported about it is forgotten. If it had been served the defaults
   * and now moves to the text of `commit`, say so once: dsh records the change as a new system message.
   */
  function settled(id: string, commit: string | null): void {
    const wasDegraded = reported.get(id)?.has('degraded') === true
    reported.delete(id)
    if (wasDegraded && commit !== null) {
      info('the prompt of agent %s moved from the shipped defaults to its snapshot at %s; dsh records the change as a new system message', id, commit)
    }
  }

  /**
   * The snapshot a record stands for, for the role in the record, or `undefined` if the record is no use: its role
   * isn't one, there is no text for it at its commit, or the store doesn't have its commit.
   */
  async function keep(id: string, record: SnapshotRecord, reader: StoreReader | undefined): Promise<Taken | undefined> {
    const { role, commit } = record
    try {
      checkRole(role)
    } catch (error) {
      reportOnce(id, 'record', 'the snapshot of agent %s is for "%s", which is not a role (%s); taking a new one', id, role, describe(error))
      return undefined
    }
    // Pinned to the defaults (the store wasn't there when the agent began): the defaults are the plugin's, and don't change.
    if (commit === null) {
      if (defaultText(role) === undefined) {
        reportOnce(id, 'record', 'the snapshot of agent %s is for role "%s", which has no shipped text and no commit to read it at; taking a new one', id, role)
        return undefined
      }
      settled(id, null)
      return { persona: compose(role, undefined, null), final: true }
    }
    if (reader === undefined) {
      // For a store-only role this throws: there is nothing to give, and the record stays as it is.
      const persona = compose(role, undefined, null)
      degraded(id, 'the store is not available')
      return { persona, final: false }
    }
    let documents: Documents
    try {
      documents = await readDocuments(reader, role, commit)
    } catch (error) {
      if (errorCode(error) === 'NOT_FOUND') {
        reportOnce(id, 'commit', 'the snapshot of agent %s is at commit %s, which the store does not have; taking a new one', id, commit)
        return undefined
      }
      const persona = compose(role, undefined, null)
      degraded(id, describe(error))
      return { persona, final: false }
    }
    if (documents.own === undefined && defaultText(role) === undefined) {
      reportOnce(id, 'record', 'the snapshot of agent %s is for role "%s", which has no text at commit %s; taking a new one', id, role, commit)
      return undefined
    }
    settled(id, commit)
    return { persona: compose(role, documents, commit), final: true }
  }

  /** A snapshot of the store as it is now, recorded unless `writable` is false. */
  async function fresh(id: string, role: Role, reader: StoreReader | undefined, writable: boolean): Promise<Taken> {
    let commit: string | null = null
    let documents: Documents | undefined
    if (reader !== undefined) {
      try {
        commit = await reader.head()
        documents = await readDocuments(reader, role, commit)
      } catch (error) {
        const persona = compose(role, undefined, null)
        degraded(id, describe(error))
        return { persona, final: false }
      }
    }
    const persona = compose(role, documents, commit)
    settled(id, commit)
    if (writable) {
      try {
        await files.put(id, { role, commit, takenAt: Date.now() })
      } catch (error) {
        warn('cannot write the snapshot of agent %s (%s); it is kept in memory for this run', id, describe(error))
      }
    }
    return { persona, final: true }
  }

  /** The agent's snapshot: its record if it has one the store can still answer for, else a fresh one. */
  async function take(id: string, role: Role): Promise<Taken> {
    await dropping.get(id)
    const reader = store()
    let record: SnapshotRecord | undefined
    let writable = true
    try {
      record = await files.get(id)
    } catch (error) {
      // Unreadable, not absent: a new record would be renamed over the original and destroy it.
      writable = false
      reportOnce(id, 'read', 'cannot read the snapshot of agent %s (%s); it gets the current prompts for this run only, and its file is left alone', id, describe(error))
    }
    if (record !== undefined) {
      const kept = await keep(id, record, reader)
      if (kept !== undefined) return kept
    }
    return fresh(id, role, reader, writable)
  }

  return {
    async roles() {
      const roles = new Set<Role>(CREW_ROLES)
      const reader = store()
      if (reader !== undefined) {
        for (const path of await reader.list('prompts/crew/')) {
          const role = roleFor(path)
          if (role !== undefined) roles.add(role)
        }
      }
      return ['common', 'main', ...[...roles].sort()]
    },

    async persona(role) {
      checkRole(role)
      const reader = store()
      if (reader === undefined) return compose(role, undefined, null)
      // Read at the commit that is reported, not at `main`, which may have moved on since.
      const commit = await reader.head()
      return compose(role, await readDocuments(reader, role, commit), commit)
    },

    snapshot(agent, role) {
      return (async () => {
        const id = agentId(agent)
        checkRole(role)
        let taking = agents.get(id)
        if (taking === undefined) {
          const mine = take(id, role)
          taking = mine
          agents.set(id, mine)
          // Only a snapshot that is final is remembered, and a rejection never is.
          const forget = (): void => {
            if (agents.get(id) === mine) agents.delete(id)
          }
          mine.then((taken) => { if (!taken.final) forget() }, forget)
        }
        return { ...(await taking).persona }
      })()
    },

    async drop(agent) {
      let id: string
      try {
        id = agentId(agent)
      } catch (error) {
        warn('cannot drop a snapshot: %s', describe(error))
        return
      }
      const pending = agents.get(id)
      agents.delete(id)
      const before = dropping.get(id)
      // Wait for a snapshot that is still being taken (its write must not land after the removal), and for an
      // earlier drop. Nothing here rejects: a snapshot's failure is its caller's.
      const done = (async () => {
        await before
        await pending?.then(() => {}, () => {})
        // Only now: a snapshot in flight could still record a warning, which would hide the next one after the drop.
        reported.delete(id)
        try {
          await files.drop(id)
        } catch (error) {
          warn('cannot remove the snapshot file of agent %s: %s', id, describe(error))
        }
      })()
      dropping.set(id, done)
      try {
        await done
      } finally {
        if (dropping.get(id) === done) dropping.delete(id)
      }
    },

    defaultText: role => defaultText(role),
  }
}
