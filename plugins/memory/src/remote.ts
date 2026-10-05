/**
 * The server half of Settings → Memory: a Typert remote service the browser calls through `ctx.remote.dishMemory`.
 *
 * It is built like `dish-prompts`' and `dish-config`'s remotes, and for the same reasons:
 *
 * - the gateway serves any root service that carries a `typertRemote` binding and `@Remote` markers, reading wire
 *   parameter names from the method source (so every parameter is a plain identifier, and `signal` is last on the
 *   stream). This package runs as type-stripped `.ts`, which has no decorator syntax, so the markers are applied by
 *   `markRemote`;
 * - every parameter is plain JSON, and `''` means absent: no base, no note, the newest page of history. `save`'s `base`
 *   is the one place `''` says something: a new memory, as the service's `base` has it;
 * - a scope is its wire key, `user` or `family:<family>`, and one that isn't is `INVALID`;
 * - every change is made as the user, a person at the keyboard;
 * - a refusal the person can act on comes back as `{ ok: false, code, message }`, not as a throw: Typert has a closed set
 *   of failure codes, and its gateway folds anything thrown into `gateway/internal`. That covers the service's
 *   `MemoryError`, this remote's own `Refusal`, and the vault's and the config store's own codes, matched on `.code` (an
 *   error class from another copy of dish-kit is not recognised by `instanceof`). Anything else is a bug, and is thrown.
 *
 * A memory's text, and a direction, go only into the answers: never into an error's message or a log line.
 *
 * The method that deletes a memory is `forget`: `remove` is a member of the browser's namespace service, which would
 * refuse to mount it.
 *
 * @module dish-memory/remote
 */

import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { markRemote } from 'dish-kit'
import type {
  Author as StoreAuthor, CommitInfo as StoreCommitInfo, ErrorCode as StoreErrorCode, FileDiff as StoreFileDiff,
  RemoteStatus as StoreRemoteStatus,
} from 'dish-kit/store'
import { directionPath, parseScopeKey } from './format.ts'
import type { Scope } from './format.ts'
import { NAME, NAMESPACE } from './protocol.ts'
import type {
  Author, CommitInfo, DirectionInfo, ErrorCode, FileDiff, Memory, MemoryEvent, MemoryInfo, Outcome, RemoteStatus, ScopeInfo,
} from './protocol.ts'
import { MemoryError } from './service.ts'

/** The Cordis service key. (The wire namespace is `NAMESPACE`.) */
export const SERVICE = 'dishMemoryRemote'

/** A page of a scope's history. */
const HISTORY_PAGE = 20

/** The most `changed` and `direction` events a stream holds for a reader that has fallen behind. */
const MAX_PENDING = 100

/** Every change the page makes is the user's. */
const AS_USER = { author: { kind: 'user' } } as const

declare module '@deepseek-ai/cordis' {
  interface Context {
    dishMemoryRemote: MemoryRemote
  }
}

// What the page is told must be what the store says: these fail to compile if either side drifts.
type Same<A, B> = [A] extends [B] ? [B] extends [A] ? SameKeys<A, B> : false : false
/** Mutual assignability lets a field that is optional on one side only through: the keys of two objects must be the same too. */
type SameKeys<A, B> = [A] extends [object] ? [B] extends [object] ? ([keyof A] extends [keyof B] ? [keyof B] extends [keyof A] ? true : false : false) : true : true
type Check<T extends true> = T
export type WireMatchesStore = [
  Check<Same<StoreErrorCode, Exclude<ErrorCode, 'UNAVAILABLE'>>>,
  Check<Same<StoreAuthor, Author>>,
  Check<Same<StoreCommitInfo, CommitInfo>>,
  Check<Same<StoreFileDiff, FileDiff>>,
  Check<Same<StoreRemoteStatus, RemoteStatus>>,
]

/** Every code the store throws on purpose, as an object so that a code the store adds is a compile error here. */
const STORE_CODES: Record<StoreErrorCode, true> = {
  CONFLICT: true, INVALID: true, UNOWNED: true, FORBIDDEN: true, SECRET: true, TOO_LARGE: true, LOCKED: true, STALE: true, NOT_FOUND: true,
}

function isStoreCode(code: unknown): code is StoreErrorCode {
  return typeof code === 'string' && Object.hasOwn(STORE_CODES, code)
}

/** A refusal made here, with the code the page sees. */
class Refusal extends Error {
  code: ErrorCode

  constructor(code: ErrorCode, message: string) {
    super(message)
    this.name = 'Refusal'
    this.code = code
  }
}

/** `value` as the wire will carry it: JSON, with no key (or array item) left `undefined`. */
function wire<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/**
 * A string parameter. They arrive off the wire untyped: a missing one is `undefined` (the client leaves out an `undefined`
 * positional), which is as good as `''`, the page's own way to say "absent". Anything else that is not a string gets
 * `INVALID`, not a `TypeError`.
 */
function stringOf(name: string, value: unknown): string {
  if (value === undefined) return ''
  if (typeof value !== 'string') throw new Refusal('INVALID', `${name} must be a string`)
  return value
}

/** A scope, as it comes off the wire: its key, `user` or `family:<family>`. */
function scopeOf(value: unknown): Scope {
  const key = stringOf('scope', value)
  const scope = parseScopeKey(key)
  if (scope === undefined) throw new Refusal('INVALID', `no scope ${JSON.stringify(key)}`)
  return scope
}

/** Run `task` and put what it returns, or a refusal, in an `Outcome`; any other failure is thrown. */
async function outcome<T>(task: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: wire(await task()) }
  } catch (error) {
    if (error instanceof Refusal || error instanceof MemoryError) return { ok: false, code: error.code, message: error.message }
    const code = (error as { code?: unknown } | null)?.code
    if (error instanceof Error && isStoreCode(code)) return { ok: false, code, message: error.message }
    throw error
  }
}

/** The family whose direction lives at `path` in the config store (`directionPath`'s inverse), or `undefined`. */
function directionFamily(path: string): string | undefined {
  const family = path.split('/')[1]
  return family !== undefined && NAME.test(family) && directionPath(family) === path ? family : undefined
}

/**
 * Put `event` in `queue` for a reader that is behind. Only the latest `remote` status matters, so it replaces an earlier one.
 * Of the others, the oldest beyond `MAX_PENDING` is dropped: every one of them means "read again", so the reader loses nothing.
 */
function enqueue(queue: MemoryEvent[], event: MemoryEvent): void {
  if (event.kind === 'remote') {
    const earlier = queue.findIndex(item => item.kind === 'remote')
    if (earlier !== -1) queue.splice(earlier, 1)
  }
  queue.push(event)
  if (event.kind === 'remote') return
  let others = queue.reduce((count, item) => item.kind === 'remote' ? count : count + 1, 0)
  for (let index = 0; others > MAX_PENDING; index++) {
    if (queue[index]!.kind === 'remote') continue
    queue.splice(index--, 1)
    others--
  }
}

export class MemoryRemote extends TypertRemoteService {
  static inject = ['dishMemory']

  /** Aborted when the service is unloaded, which ends the streams still open. */
  private readonly closing = new AbortController()

  constructor(ctx: Context) {
    super(ctx, SERVICE, { namespace: NAMESPACE })
    ctx.effect(() => () => { this.closing.abort() })
  }

  /** "You", then each family in projects.yaml, then the families with memories and no project (`orphan`), with their counts. */
  async scopes(): Promise<Outcome<ScopeInfo[]>> {
    return outcome(async () => this.ctx.dishMemory.scopes())
  }

  /** The scope's memories, held ones included and marked, in the index's order. */
  async list(scope: string): Promise<Outcome<MemoryInfo[]>> {
    return outcome(async () => this.ctx.dishMemory.list(scopeOf(scope)))
  }

  /** One memory, with its body and the commit it was read at (what to pass as `base` when saving); `null` when there's none. */
  async read(scope: string, name: string): Promise<Outcome<Memory | null>> {
    return outcome(async () => {
      const where = scopeOf(scope)
      return await this.ctx.dishMemory.read(where, stringOf('name', name)) ?? null
    })
  }

  /**
   * Create or replace a memory, as the user. Its fields are checked (`INVALID`) and scanned for credentials (`SECRET`); the
   * user's own aren't screened, and a held memory saved with its text unchanged stays held.
   * @param base - `''` for a new memory, and one that exists is `CONFLICT`; else `read`'s `commit`, and a memory that has
   *   changed since is `CONFLICT`.
   */
  async save(scope: string, name: string, type: string, description: string, body: string, base: string): Promise<Outcome<CommitInfo>> {
    return outcome(async () => {
      const where = scopeOf(scope)
      const memory = {
        name: stringOf('name', name), type: stringOf('type', type), description: stringOf('description', description), body: stringOf('body', body),
      }
      return (await this.ctx.dishMemory.write(where, memory, { ...AS_USER, base: stringOf('base', base) })).commit
    })
  }

  /**
   * Delete a memory, as the user. An unknown one is `NOT_FOUND`.
   * @param base - `''` for none; else `read`'s `commit`, and a memory that has changed since is `CONFLICT`.
   */
  async forget(scope: string, name: string, base: string): Promise<Outcome<CommitInfo>> {
    return outcome(async () => {
      const where = scopeOf(scope)
      const memory = stringOf('name', name)
      const loaded = stringOf('base', base)
      return this.ctx.dishMemory.delete(where, memory, loaded === '' ? AS_USER : { ...AS_USER, base: loaded })
    })
  }

  /** Let a held memory reach agents, as the user. One that isn't held is `INVALID`. */
  async release(scope: string, name: string): Promise<Outcome<CommitInfo>> {
    return outcome(async () => {
      const where = scopeOf(scope)
      return this.ctx.dishMemory.release(where, stringOf('name', name), AS_USER)
    })
  }

  /** A family's direction, or the template (`missing`), and the config store's commit it was read at. `UNAVAILABLE` without the store. */
  async direction(family: string): Promise<Outcome<DirectionInfo>> {
    return outcome(async () => this.ctx.dishMemory.direction(stringOf('family', family)))
  }

  /**
   * Save a family's direction in the config store, as the user. `UNAVAILABLE` without the store.
   * @param base - `''` for none; else `direction`'s `commit`, and a direction that has changed since is `CONFLICT`.
   * @param note - `''` for none; else why, in a line, which becomes the commit's `Dish-Note`.
   * @returns the commit, or `null` when the direction already says this.
   */
  async saveDirection(family: string, text: string, base: string, note: string): Promise<Outcome<CommitInfo | null>> {
    return outcome(async () => {
      const name = stringOf('family', family)
      const content = stringOf('text', text)
      const loaded = stringOf('base', base)
      const why = stringOf('note', note)
      const meta = { ...(loaded === '' ? {} : { base: loaded }), ...(why === '' ? {} : { note: why }) }
      return await this.ctx.dishMemory.saveDirection(name, content, meta) ?? null
    })
  }

  /**
   * The commits that changed the scope, newest first, 20 at a time.
   * @param before - `''` for the newest; else a full commit id, and the page starts just below it (the last id of a page gives the next).
   */
  async history(scope: string, before: string): Promise<Outcome<CommitInfo[]>> {
    return outcome(async () => {
      const where = scopeOf(scope)
      const below = stringOf('before', before)
      return this.ctx.dishMemory.history(where, below === '' ? { limit: HISTORY_PAGE } : { limit: HISTORY_PAGE, before: below })
    })
  }

  /** One commit of the vault and what it changed. */
  async commit(id: string): Promise<Outcome<{ info: CommitInfo, diffs: FileDiff[] }>> {
    return outcome(async () => this.ctx.dishMemory.commit(stringOf('id', id)))
  }

  /** Undo a commit's memories with a new commit, as the user. `null` when it was undone already: nothing to do. */
  async revert(id: string): Promise<Outcome<CommitInfo | null>> {
    return outcome(async () => await this.ctx.dishMemory.revert(stringOf('id', id), AS_USER) ?? null)
  }

  /**
   * The `dish-memory` message a main agent working in this scope gets now: the user's memory, and for a family its
   * direction, repos and memory too. `''` when it gets none.
   */
  async preview(scope: string): Promise<Outcome<{ text: string }>> {
    return outcome(async () => {
      const where = scopeOf(scope)
      const text = await this.ctx.dishMemory.compose(where.kind === 'user' ? { user: true } : { user: true, family: where.family })
      return { text: text ?? '' }
    })
  }

  /** Where the vault's remote copy stands. */
  async remoteStatus(): Promise<Outcome<RemoteStatus>> {
    return outcome(async () => this.ctx.dishMemory.remoteStatus())
  }

  /**
   * Tell the page when to read again. The first item is the vault's remote status (so a page that opens in the middle of an
   * outage shows it at once); after that `changed` after every vault commit, `direction` when a config commit changed a
   * family's direction, and `remote` as the status changes. Ends when `signal` aborts, when the consumer stops reading, or
   * when the plugin is unloaded.
   *
   * A reader that falls behind gets the newest 100 of the `changed` and `direction` events and the latest `remote` status
   * (see `enqueue`).
   */
  async *watch(signal: AbortSignal): AsyncIterable<MemoryEvent> {
    const stop = AbortSignal.any([signal, this.closing.signal])
    if (stop.aborted) return
    const queue: MemoryEvent[] = []
    let wake: (() => void) | undefined
    const push = (event: MemoryEvent): void => { enqueue(queue, event); wake?.() }
    const abort = (): void => { wake?.() }
    stop.addEventListener('abort', abort, { once: true })

    // Listening starts before the snapshot is read, so nothing that happens in between is missed.
    const unsubscribe = [
      this.ctx.on('dish-memory/changed', (scopes, commit) => { push({ kind: 'changed', commit, scopes: [...scopes] }) }),
      this.ctx.on('dish-config/changed', (paths) => {
        const families = new Set<string>()
        for (const path of paths) {
          const family = directionFamily(path)
          if (family !== undefined) families.add(family)
        }
        for (const family of families) push({ kind: 'direction', family })
      }),
      this.ctx.on('dish-memory/remote', (status) => { push({ kind: 'remote', status: wire(status) }) }),
    ]
    try {
      const snapshot = await this.ctx.dishMemory.remoteStatus()
      if (stop.aborted) return
      yield { kind: 'remote', status: wire(snapshot) }
      while (!stop.aborted) {
        const event = queue.shift()
        if (event === undefined) {
          await new Promise<void>((resolve) => { wake = resolve })
          continue
        }
        yield event
      }
    } finally {
      stop.removeEventListener('abort', abort)
      for (const dispose of unsubscribe) dispose()
    }
  }
}

markRemote(MemoryRemote, 'scopes')
markRemote(MemoryRemote, 'list')
markRemote(MemoryRemote, 'read')
markRemote(MemoryRemote, 'save')
markRemote(MemoryRemote, 'forget')
markRemote(MemoryRemote, 'release')
markRemote(MemoryRemote, 'direction')
markRemote(MemoryRemote, 'saveDirection')
markRemote(MemoryRemote, 'history')
markRemote(MemoryRemote, 'commit')
markRemote(MemoryRemote, 'revert')
markRemote(MemoryRemote, 'preview')
markRemote(MemoryRemote, 'remoteStatus')
markRemote(MemoryRemote, 'watch', { mode: 'stream' })
