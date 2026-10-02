/**
 * The wire shapes shared by the server remote (`remote.ts`) and the Projects page (`client/`). Types and constants,
 * so both halves can import it, and it imports nothing: the browser build must not reach into the store (or, through
 * it, into Node's modules). `CommitInfo` is therefore declared here, as `dish-config`'s own `protocol.ts` declares it,
 * and `remote.ts` checks at compile time that the store's type fits it, so a change to either side is a type error.
 * The registry's own rules live in `registry.ts`, which the browser can't use either (it reads YAML), so what the
 * page needs of them comes from the server's `check`.
 *
 * Everything here is plain JSON, and an empty string stands for "absent" in a project's fields and in the
 * parameters of a call (see `remote.ts`): the page's own convention, as in `dish-config`'s remote.
 * @module dish-projects/protocol
 */

/** The remote's wire namespace: the page calls `ctx.remote.dishProjects`. (Its Cordis service key is `dishProjectsRemote`.) */
export const NAMESPACE = 'dishProjects'

/**
 * The failures a call reports as a result: the store's own stable codes, as `dish-config`'s remote has them, and
 * `UNAVAILABLE` for a call that needs the store while there is none.
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
 * What every call returns. A refusal that means a person to act on (a conflict, a field the registry won't take, no
 * store to save to) is a result, not an error: Typert's own failure codes can't carry the store's.
 */
export type Outcome<T> =
  | { ok: true, value: T }
  | { ok: false, code: ErrorCode, message: string }

/** Who made a commit. `system` is the store's own. */
export type Author =
  | { kind: 'user' }
  | { kind: 'agent', sessionId: string, role?: string }
  | { kind: 'system' }

/** A commit of the config store, as a save or a removal returns it (and `dish-config`'s remote sends it). */
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

/**
 * A project's settings, as the form has them: all of them strings (and the environment, a mapping of strings), with
 * `''` for a field `projects.yaml` leaves out (`setup`, `setupTimeout`, and a `gateEnv` of `{}`). Nothing here is
 * trimmed or checked: that is the registry's, through `check`.
 */
export interface Fields {
  family: string
  role: string
  gate: string
  /** `<n>s`, `<n>m` or `<n>h`, between 10s and 10m. */
  gateTimeout: string
  /** `''` for none. */
  setup: string
  /** `''` for the default (15m). */
  setupTimeout: string
  gateEnv: Record<string, string>
}

/** Where a project is in onboarding. */
export type ProjectState = 'pending' | 'cloning' | 'setup' | 'ready' | 'failed'

/** One project in the page's list. */
export interface ProjectInfo {
  /** The key in `projects.yaml`, as written: `owner/repo`. */
  name: string
  fields: Fields
  status: {
    state: ProjectState
    /** Why it failed, or why it waits; masked. */
    message: string | null
    /** When it changed to this state, in milliseconds since the epoch; 0 for a project dish has said nothing of yet. */
    at: number
    /** Ready, with setup skipped: why, and the command to run instead. */
    setupSkipped: string | null
  }
  /** Where the clone is; `null` before dish-workspaces has one to describe (or without it). */
  clone: string | null
  /** The title of the project's workspace in dsh; `null` when it has none (not registered yet, or removed). */
  workspace: string | null
  lastFetch: { at: number, ok: boolean, message: string | null } | null
}

/** The registry at one commit of the store. */
export interface ProjectsResult {
  /** The `main` commit the list was read at: what a save passes as `base`. `''` when there is no store. */
  commit: string
  /** Every project in the file, sorted by name without regard to case. Empty while `problem` is set. */
  projects: ProjectInfo[]
  /** Why the stored `projects.yaml` doesn't parse (a hand edit in the repository), or `null`. */
  problem: string | null
  /** The open and stale proposals whose paths include `projects.yaml`. */
  pendingProposals: number
}

/** What `check` finds: the one problem that would stop the save, or `null`. */
export interface CheckResult {
  problem: string | null
}
