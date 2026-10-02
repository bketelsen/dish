/**
 * The wire shapes shared by the server remote (`remote.ts`) and the Skills page (`client/`). Types and constants,
 * so both halves can import it, and it imports nothing: the browser build must not reach into the store (or, through
 * it, into Node's modules). `CommitInfo` is therefore declared here, as `dish-config`'s own `protocol.ts` declares it,
 * and `remote.ts` checks at compile time that the store's type fits it, so a change to either side is a type error.
 * The skill format's own rules live in `skill.ts`, which the browser can't use either (it reads YAML), so what the page
 * needs of them comes from the server's `check`.
 *
 * Everything here is plain JSON, and an empty string stands for "absent" in the parameters of a call (see
 * `remote.ts`): the page's own convention, as in `dish-config`'s remote.
 * @module dish-skills/protocol
 */

/** The remote's wire namespace: the page calls `ctx.remote.dishSkills`. (Its Cordis service key is `dishSkillsRemote`.) */
export const NAMESPACE = 'dishSkills'

/** The note a reset carries when the caller gives none, so that its commit says what it was in the history. */
export const RESET_NOTE = 'Reset to the default'

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
 * What every call returns. A refusal that means a person to act on (a conflict, a document that isn't a skill, no
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

/** A commit of the config store, as a save, a reset or a removal returns it (and `dish-config`'s remote sends it). */
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

/** One skill in the page's list. */
export interface SkillInfo {
  /** The skill's name: its directory in the store, and the `name` its document says. */
  name: string
  /** The skill's document in the store. */
  path: string
  /** What the document says (trimmed); `''` for a document that doesn't parse. */
  description: string
  /** The roles offered the skill; `null` for every role (and for a document that doesn't parse), `[]` for none. */
  roles: string[] | null
  /** A model may load it. `false` for a document that doesn't parse: nothing is offered from it. */
  modelInvocable: boolean
  /** It is in the `/` menu. `false` for a document that doesn't parse. */
  userInvocable: boolean
  /** dish ships a default for this name. */
  shipped: boolean
  /** The stored text isn't the shipped default. `false` for a skill dish ships none for, and for a missing one. */
  differsFromDefault: boolean
  /** A shipped skill that isn't in the store (deleted by hand or by a revert), served as its default. Never set without a store. */
  missing: boolean
  /** Why the stored document doesn't parse, in a sentence; `''` when it does. */
  problem: string
  /** The open and stale proposals whose paths include this skill's document. */
  pendingProposals: number
}

/** The skills at one commit of the store. */
export interface SkillsResult {
  /** The `main` commit the list was read at. `''` when there is no store, and the skills are the shipped defaults. */
  commit: string
  /** Every skill that has a document in the store, and every shipped skill that has none, sorted by name. */
  skills: SkillInfo[]
  /** The role names dish knows: `main`, then the crew's roles (or the shipped ones when crew isn't there). */
  roles: string[]
}

/** A skill's document, as the editor loads it. */
export interface ReadResult {
  /** The stored text, or the shipped default when `missing`. */
  text: string
  /** The `main` commit `text` was read at: what a save passes as `base`. `''` when there is no store. */
  commit: string
  /** The shipped default, or `''` for a skill you added. */
  defaultText: string
  /** The document isn't in the store, and `text` is the default. */
  missing: boolean
}

/** What a valid document says, for the line under the editor. */
export interface CheckSummary {
  description: string
  /** The roles offered the skill; `null` for every role. */
  roles: string[] | null
  modelInvocable: boolean
  userInvocable: boolean
  /** The length of the whole document, in characters. */
  chars: number
}

/** What `check` finds in a text. */
export interface CheckResult {
  /** Why the text can't be saved: empty, or the one problem found. */
  problems: string[]
  /** What is worth a look but doesn't refuse a save. */
  warnings: string[]
  /** `null` when there are problems. */
  summary: CheckSummary | null
}

/**
 * The text the editor opens on for a new skill called `name`: frontmatter (the name, a "Use when …" description to
 * fill in, offered to `main`) and an outline of the instructions. It is a valid document as it stands, so Save is not
 * held back by it; the person is meant to replace the placeholders.
 */
export const NEW_SKILL_TEMPLATE = (name: string): string => [
  '---',
  `name: ${name}`,
  'description: Use when … (finish this sentence so an agent knows when to load the skill)',
  'metadata:',
  '  roles: [main]',
  '---',
  '',
  '## Overview',
  '',
  '…',
  '',
].join('\n')
