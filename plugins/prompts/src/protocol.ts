/**
 * The wire shapes shared by the server remote (`remote.ts`) and the Prompts page (`client/`). Types and one constant,
 * so both halves can import it, and it imports nothing: the browser build must not reach into the store (or, through
 * it, into Node's modules). `CommitInfo` is therefore declared here, as `dish-config`'s own `protocol.ts` declares it,
 * and `remote.ts` checks at compile time that the store's type fits it, so a change to either side is a type error.
 *
 * Everything here is plain JSON, and an empty string stands for "absent" in the parameters of a call (see
 * `remote.ts`): the page's own convention, as in `dish-config`'s remote.
 * @module dish-prompts/protocol
 */

/** The remote's wire namespace: the page calls `ctx.remote.dishPrompts`. (Its Cordis service key is `dishPromptsRemote`.) */
export const NAMESPACE = 'dishPrompts'

/**
 * The failures a call reports as a result: the store's own stable codes, as `dish-config`'s remote has them, and
 * `UNAVAILABLE` for a write while there is no store.
 */
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
  | 'UNAVAILABLE'

/**
 * What every call returns. A refusal that means a person to act on (a conflict, an empty prompt, no store to save
 * to) is a result, not an error: Typert's own failure codes can't carry the store's.
 */
export type Outcome<T> =
  | { ok: true, value: T }
  | { ok: false, code: ErrorCode, message: string }

/** Who made a commit. `system` is the store's own. */
export type Author =
  | { kind: 'user' }
  | { kind: 'agent', sessionId: string, role?: string }
  | { kind: 'system' }

/** A commit of the config store, as a save or a reset returns it (and `dish-config`'s remote sends it). */
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

/** One role in the page's list. */
export interface RoleInfo {
  /** `common`, `main`, or a crew role. */
  role: string
  /** The role's document in the store. */
  path: string
  /** The most an agent may do with the document: `propose` for `common` and `main`, `write` for a crew role. */
  agent: 'write' | 'propose'
  /** The stored text isn't the shipped default. `false` for a role with no shipped default, and for a missing document. */
  differsFromDefault: boolean
  /** The document isn't in the store (deleted by hand or by a revert), so the role is served as its default. */
  missing: boolean
  /** The open and stale proposals whose paths include this role's document. */
  pendingProposals: number
}

/** A role's document, as the editor loads it. */
export interface ReadResult {
  /** The stored text, or the shipped default when `missing`. */
  text: string
  /** The `main` commit `text` was read at: what a save passes as `base`. `null` when there is no store. */
  commit: string | null
  /** The shipped default, or `null` for a role dish ships none for (one that exists only in the store). */
  defaultText: string | null
  /** The document isn't in the store, and `text` is the default. */
  missing: boolean
}

/** What a new agent in a role would be told, as far as dish can build it. */
export interface PreviewResult {
  /** The system prompt, rendered. */
  text: string
  /** Always `true`: runtime context (sandbox and approval policy, `AGENTS.md`) reaches the model as separate messages and isn't in it. */
  approximate: true
  /** dsh's own assembly couldn't be used: `text` is the persona texts between `[dsh: ...]` markers in place of dsh's sections. */
  fallback: boolean
  /**
   * The `{{names}}` in the role's texts that have no value, left as written, in order of first appearance. Always
   * `[]` when `fallback` is true: without dsh's assembly there is no telling which names have a value.
   */
  unknownVariables: string[]
}

/** One prompt variable visible to the dish preset. */
export interface VariableInfo {
  name: string
  /** Empty for a variable that only has a value per agent (`model`, `cwd`, ...). */
  value: string
}

/** The variables a prompt may use, and whether dsh's assembly could be read for them. */
export interface VariablesResult {
  variables: VariableInfo[]
  /** dsh's assembly couldn't be used, so `variables` is empty: it says nothing of what a prompt may use. */
  fallback: boolean
}
