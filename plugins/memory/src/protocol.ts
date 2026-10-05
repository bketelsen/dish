/**
 * The wire shapes shared by the server remote (`remote.ts`) and the Memory page (`client/`), and the memory format's
 * constants. Types and constants, so both halves can import it, and it imports nothing: the browser build must not
 * reach into the store (or, through it, into Node's modules). The store's `Author`, `CommitInfo`, `FileDiff` and
 * `RemoteStatus` are therefore copied here, as `dish-prompts`' `protocol.ts` copies them, and `remote.ts` checks at
 * compile time that the store's types fit them, so a change to either side is a type error.
 *
 * Everything here is plain JSON, and an empty string stands for "absent" in the parameters of a call (see
 * `remote.ts`), as in `dish-prompts`' and `dish-config`'s remotes.
 * @module dish-memory/protocol
 */

/** The remote's wire namespace: the page calls `ctx.remote.dishMemory`. (Its Cordis service key is `dishMemoryRemote`.) */
export const NAMESPACE = 'dishMemory'

/** A memory's types, in the order the index lists them. */
export const TYPES = ['feedback', 'user', 'project', 'reference'] as const

export type MemoryType = typeof TYPES[number]

/** A memory's name, which is also its file's name without `.md`. A family's name follows the same grammar. */
export const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/

/** The one name no memory may have: `memory.md` and the index, `MEMORY.md`, are one file where case doesn't count. */
export const RESERVED_NAME = 'memory'

/** The longest description, in characters. */
export const DESCRIPTION_MAX = 150

/** The largest body, in bytes of UTF-8. */
export const BODY_MAX = 8192

/** The longest direction, in characters. */
export const DIRECTION_MAX = 16_000

/** The longest reason a memory is held for, in characters. */
export const REASON_MAX = 200

/**
 * Each scope's budget in the message, in lines and in bytes of UTF-8 (newlines included), and the share of either
 * from which the scope counts as nearly full.
 */
export const INDEX_LINES = 150, INDEX_BYTES = 16_384, NEAR_FULL = 0.8

/** The text the Direction tab starts a missing direction from. */
export const DIRECTION_TEMPLATE = '# Direction\n\n## North star\n\n\n## Priorities\n\n1. \n\n## Non-goals\n\n\n## Constraints\n\n\n## What needs your go-ahead\n\n'

/**
 * The failures a call reports as a result: the store's own stable codes, as `dish-config`'s remote has them, and
 * `UNAVAILABLE` when a service the call needs isn't running.
 */
export type ErrorCode = 'CONFLICT' | 'INVALID' | 'UNOWNED' | 'FORBIDDEN' | 'SECRET' | 'TOO_LARGE' | 'LOCKED' | 'STALE' | 'NOT_FOUND' | 'UNAVAILABLE'

/**
 * What every call returns. A refusal that means a person to act on (a conflict, a malformed memory, no config store to
 * save a direction to) is a result, not an error: Typert's own failure codes can't carry the store's.
 */
export type Outcome<T> = { ok: true, value: T } | { ok: false, code: ErrorCode, message: string }

/** A scope on the wire: `user`, or `family:<family>`. */
export type ScopeKey = string

/** A memory as the list shows it. */
export interface MemoryInfo { scope: ScopeKey, name: string, type: MemoryType, description: string, modified: string, held?: string }

/** A memory as the editor loads it. `commit` is the vault's `main` when it was read: what a save passes as `base`. */
export interface Memory extends MemoryInfo { body: string, commit: string }

/** One entry in the page's list of scopes. `orphan` marks a family with memories and no project any more. */
export interface ScopeInfo { key: ScopeKey, label: string, count: number, held: number, orphan: boolean }

/** A family's direction, as the Direction tab loads it. `commit` is the config store's head it was read at. */
export interface DirectionInfo { family: string, text: string, commit: string, missing: boolean, pendingProposals: number }

/** Who made a commit: the store's `Author`, copied. `system` is the store's own. */
export type Author = { kind: 'user' } | { kind: 'agent', sessionId: string, role?: string } | { kind: 'system' }

/** A commit of the vault: the store's `CommitInfo`, copied (`store.ts:30-44`), and checked with `Same` in `remote.ts`. */
export interface CommitInfo { id: string, time: number, author: Author, message: string, note?: string, paths: string[] }

/** One file's change in a commit: the store's `FileDiff`, copied, since the client's tsconfig can't import `dish-kit/store`. */
export interface FileDiff { path: string, status: 'added' | 'modified' | 'deleted', patch: string }

/** Where the vault's remote copy stands: the store's `RemoteStatus`, copied (`push.ts:22-36`). */
export interface RemoteStatus { remote?: string, pushed?: string, pending: number, lastError?: string, lastAttempt?: number }

/** What the page's `watch` stream sends: a vault commit and the scopes it touched, a family's direction changed, or the remote's status. */
export type MemoryEvent = { kind: 'changed', commit: string, scopes: ScopeKey[] } | { kind: 'direction', family: string } | { kind: 'remote', status: RemoteStatus }
