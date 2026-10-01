/**
 * The wire shapes shared by the server remote (`remote.ts`) and the History page
 * (`client/`). Types and one constant, so both halves can import it, and it
 * imports nothing: the browser build must not reach into the store.
 *
 * Everything here is plain JSON. `remote.ts` checks at compile time that the
 * store's own types fit these, so a change to either side is a type error.
 * @module dish-config/protocol
 */

/** The remote's wire namespace: the page calls `ctx.remote.dishConfig`. (Its Cordis service key is `dishConfigRemote`.) */
export const NAMESPACE = 'dishConfig'

/** The store's stable failure codes, as the page sees them. */
export type ErrorCode =
  | 'CONFLICT'
  | 'INVALID'
  | 'UNOWNED'
  | 'FORBIDDEN'
  | 'SECRET'
  | 'TOO_LARGE'
  | 'LOCKED'
  | 'STALE'
  | 'NOT_FOUND'

/**
 * What every call but `namespaces` and `watch` returns. A refusal the store means a person to act on (a conflict,
 * a stale proposal, an unknown id) is a result, not an error: Typert's own failure codes can't carry the store's.
 */
export type Outcome<T> =
  | { ok: true, value: T }
  | { ok: false, code: ErrorCode, message: string }

/** Who made a commit or a proposal. `system` is the store's own. */
export type Author =
  | { kind: 'user' }
  | { kind: 'agent', sessionId: string, role?: string }
  | { kind: 'system' }

export interface CommitInfo {
  /** The commit's full object id. */
  id: string
  /** Commit time in milliseconds since the epoch. */
  time: number
  author: Author
  /** The whole commit message: subject, blank line, trailers. */
  message: string
  /** The note the author gave, when there was one. */
  note?: string
  /** The paths this commit changed, sorted. */
  paths: string[]
}

/** One file's change, as git's own unified patch. */
export interface FileDiff {
  path: string
  status: 'added' | 'modified' | 'deleted'
  patch: string
}

export type ProposalStatus = 'open' | 'stale' | 'rejected'

export interface ProposalInfo {
  /** 8 lowercase hex characters. */
  id: string
  title: string
  /** Empty when there was none. */
  rationale: string
  author: Author
  /** When it was proposed, in milliseconds since the epoch. */
  created: number
  /** The `main` commit the proposal was made on. */
  base: string
  /** The proposal's own commit: `base` plus the changes. */
  tip: string
  /** The paths the proposal changes, sorted. */
  paths: string[]
  status: ProposalStatus
  /** Why it was rejected; only on a rejected proposal. */
  reason?: string
}

/** Where the remote copy stands. */
export interface RemoteStatus {
  /** The configured remote, with any password masked; absent when none is configured. */
  remote?: string
  /** The `main` commit last pushed successfully by this process; absent until the first success. */
  pushed?: string
  /** Commits on `main` the remote may not have. */
  pending: number
  /** Why the last attempt failed, as one line; absent after a success. */
  lastError?: string
  /** When the last attempt started, in milliseconds since the epoch. */
  lastAttempt?: number
}

/** One claimed namespace, for the log's filter. */
export interface NamespaceInfo {
  /** `prompts/` is everything under that directory; anything else (`crew.yaml`) is that one path. */
  prefix: string
  /** The claiming plugin. */
  owner: string
  /** The most an agent may do there. */
  agent: 'write' | 'propose' | 'none'
}

/** What happened to a proposal, as `watch` reports it. */
export type ProposalEvent = 'open' | 'stale' | 'accepted' | 'rejected'

/**
 * One item of the `watch` stream. Any of them means "read again": the page refreshes the view it has open.
 * The first item is always the current `remote` status.
 */
export type ConfigEvent =
  | { kind: 'changed', commit: string, paths: string[] }
  | { kind: 'proposal', id: string, status: ProposalEvent }
  | { kind: 'remote', status: RemoteStatus }
