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
 *   logs why (a role that has no text at all is the one thing it still rejects for).
 *
 * A snapshot is the store's `main` commit when the agent was first asked about, kept in `SnapshotFiles`; its texts
 * are read at that commit, which never changes. In detail:
 *
 * - one in-memory promise per agent id, so concurrent first calls share one snapshot, and later calls read no files;
 * - a record whose commit the store doesn't have is replaced by a fresh snapshot;
 * - a record that can't be read at all (permissions, say) is not replaced, because a rename over it would destroy
 *   the original. The agent gets a fresh snapshot from memory, for this process only;
 * - when the store can't answer for a record that has a commit, the agent gets the defaults for now and nothing is
 *   remembered, neither in memory nor on disk, so its own text is back as soon as the store answers.
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
   * with neither a document nor a default. A failure of the store is passed on.
   */
  persona(role: string): Promise<Persona>
  /**
   * The agent's snapshot: taken on the first call for that agent, the same for its whole life, even across a restart.
   * The role is the one of the first call. Never rejects because of the snapshot files or the store; see the module
   * comment. Rejects like `persona` for a role that has no text.
   */
  snapshot(agent: { id: string }, role: string): Promise<Persona>
  /** Forget the agent's snapshot (on `/clear`); its next call takes a new one. Never rejects. */
  drop(agent: { id: string }): Promise<void>
  /** The shipped default for a role, or `undefined` for a role with none. */
  defaultText(role: string): string | undefined
}

/** What the service needs of the store: dish-config's reads. */
export type StoreReader = Pick<DishConfigService, 'head' | 'read' | 'list'>

/** What the service needs of the snapshot files. */
export type SnapshotStore = Pick<SnapshotFiles, 'get' | 'put' | 'drop'>

export interface ServiceLogger {
  warn(format: string, ...args: unknown[]): void
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

  /** One in-memory promise per agent id: the agent's snapshot, from its first call until it is dropped. */
  const agents = new Map<string, Promise<Taken>>()
  /** The drops that are still working, so a snapshot that follows one waits for it. */
  const dropping = new Map<string, Promise<void>>()
  /** Document paths already reported as missing from the store. */
  const missing = new Set<string>()
  /** Agents already reported as served the defaults because the store couldn't answer. */
  const degradedAgents = new Set<string>()

  /** `role`'s shipped text, for a document that isn't in the store. @throws `Error` for a role with none. */
  function fallback(role: Role, stored: boolean): string {
    const text = defaultText(role)
    if (text === undefined) throw new Error(`unknown role "${role}"`)
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

  /** The agent is served the defaults, because the store couldn't answer: said once until it can. */
  function degraded(id: string, why: string): void {
    if (degradedAgents.has(id)) return
    degradedAgents.add(id)
    warn('cannot read the prompts for agent %s from the store (%s); it gets the shipped defaults for now', id, why)
  }

  /** The snapshot a record stands for, or `undefined` if its commit is not in the store. */
  async function keep(id: string, role: Role, record: SnapshotRecord, reader: StoreReader | undefined): Promise<Taken | undefined> {
    const { commit } = record
    // Pinned to the defaults (the store wasn't there when the agent began): the defaults are the plugin's, and don't change.
    if (commit === null) return { persona: compose(role, undefined, null), final: true }
    if (reader === undefined) {
      degraded(id, 'the store is not available')
      return { persona: compose(role, undefined, null), final: false }
    }
    let documents: Documents
    try {
      documents = await readDocuments(reader, role, commit)
    } catch (error) {
      if (errorCode(error) === 'NOT_FOUND') {
        warn('the snapshot of agent %s is at commit %s, which the store does not have; taking a new one', id, commit)
        return undefined
      }
      degraded(id, describe(error))
      return { persona: compose(role, undefined, null), final: false }
    }
    degradedAgents.delete(id)
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
        degraded(id, describe(error))
        return { persona: compose(role, undefined, null), final: false }
      }
    }
    degradedAgents.delete(id)
    const persona = compose(role, documents, commit)
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
      warn('cannot read the snapshot of agent %s (%s); it gets the current prompts for this run only, and its file is left alone', id, describe(error))
    }
    if (record !== undefined) {
      const kept = await keep(id, role, record, reader)
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
      degradedAgents.delete(id)
      const before = dropping.get(id)
      // Wait for a snapshot that is still being taken (its write must not land after the removal), and for an
      // earlier drop. Nothing here rejects: a snapshot's failure is its caller's.
      const done = (async () => {
        await before
        await pending?.then(() => {}, () => {})
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
