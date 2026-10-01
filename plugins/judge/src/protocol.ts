/**
 * The wire shapes shared by the server remote (`remote.ts`) and the Settings → Judge page (`client/`). Types and one constant,
 * so both halves can import it, and it imports nothing: the browser build must not reach into the store (or, through it,
 * into Node's modules). `CommitInfo` and the rest are therefore declared here, as `dish-config`'s own `protocol.ts` and
 * dish-prompts' do, and `remote.ts` checks at compile time that the server's types fit them, so a change to either side is a
 * type error.
 *
 * Everything here is plain JSON, and an empty string stands for "absent" in the parameters of a call (see `remote.ts`).
 *
 * **There is no key in this file, and none anywhere on this remote.** The page sets, removes and describes the TypeSafe key
 * through dsh's own `credentials` remote, in the browser; no method here takes the key or gives it back, and `StatusInfo`
 * has a name for it (`keyName`) and a flag (`keySet`), nothing more.
 * @module dish-judge/protocol
 */

/** The remote's wire namespace: the page calls `ctx.remote.dishJudge`. (Its Cordis service key is `dishJudgeRemote`.) */
export const NAMESPACE = 'dishJudge'

/**
 * The failures a call reports as a result: the store's own stable codes, as `dish-config`'s remote has them, and two of this
 * remote's own: `UNAVAILABLE` for a write while there is no store, and `JUDGE_UNAVAILABLE` for a test that Jev could not
 * answer (no key, a time out, a refused key; the message says which).
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
  | 'JUDGE_UNAVAILABLE'

/**
 * What every call but `status` returns. A refusal that means a person to act on (a conflict, a setting out of range, no
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

/** A commit of the config store, as a save returns it (and `dish-config`'s remote sends it). */
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

/** The judge's state, as `ctx.judge.status()` has it, with the credential's name. */
export interface StatusInfo {
  /** Whether there is a usable key now. */
  keySet: boolean
  /** `no-key` when the credential store has none; `unavailable` when it can't be asked, or Jev is being skipped or refused the last call; else `ok`. */
  state: 'ok' | 'unavailable' | 'no-key'
  /** The message of the last call that tried Jev and got no answers. Kept after a success. */
  lastError?: string
  lastErrorAt?: number
  lastOkAt?: number
  /** Latency percentiles of the last 100 calls that answered, in milliseconds; `null` until there is one. */
  p50: number | null
  p95: number | null
  /** How many calls the window holds, at most 100, and how many of them failed. */
  calls: number
  failures: number
  /** The credential's name in dsh's store (an environment variable name): what the page sets, removes and describes. Not the key. */
  keyName: string
}

/** What a test of the judge found: the one fixed question's answer, and how long Jev took. */
export interface TestResult {
  /** The noul's answer: `noul` is P(yes), from 0 to 1. */
  answer: { type: 'noul', noul: number }
  latencyMs: number
}

/** `judge.yaml` as settings: plain JSON, with no `readonly`. What `saveThresholds` takes and `thresholds` gives. */
export interface SettingsValues {
  model: string
  timeoutMs: number
  commands: { readOnly: number, reversible: number, servesTask: number }
  screening: { withhold: number, warn: number, chunkChars: number }
  tools: { gated: string[], screened: string[] }
}

/** The thresholds' document, as the form loads it. */
export interface ThresholdsRead {
  /** The stored text, or the shipped default when `missing` or when there is no store. */
  text: string
  /** The settings in `text`; the shipped default's when `text` doesn't pass the check (`problem`) or there is no store. */
  settings: SettingsValues
  /** The `main` commit `text` was read at: what a save passes as `base`. `null` when there is no store. */
  commit: string | null
  /** The document isn't in the store, so the shipped default is in use. Saving adds it. */
  missing: boolean
  /** Why the stored text isn't used, when it doesn't pass the check: the judge is using the shipped default meanwhile. */
  problem?: string
}

/** What a Jev call was for. */
export type PurposeName = 'command' | 'approval' | 'screen' | 'ask'

/** One JSON value. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/**
 * One line of the decision log, as the server reads it: the log's own line type. Every string in it is text to show, and
 * nothing more: a subject is a command or a tool's name, written by an agent or by a web page.
 */
export interface LogLine {
  /** When, in milliseconds since the epoch. */
  at: number
  purpose: PurposeName
  /** The session id of the agent the call was for. */
  agent?: string
  /** Whether that agent is a crew child. */
  child?: boolean
  tool?: string
  /** The tool call this line is for: lines of one screen, and of a command and its approval, share it. */
  callId?: string
  /** The command, or the tool and size of a result, or `ask_judge`. */
  subject: string
  /** What Jev answered, by question id. `{}` when it didn't; the bare values of each when `answersCut`. */
  answers: { [question: string]: JsonValue }
  answersCut?: boolean
  /** What was decided, in a word. An open set: filters take any string. `null` if none was recorded. */
  decision: string | null
  /** How long the call took; `null` if Jev wasn't called. */
  latencyMs: number | null
  /** Why the call failed, or `null`. */
  error: string | null
  /** The id of content the screen withheld: `withheld(id)` gives it. */
  withheld?: string
}

/** A page of the log, newest first. */
export interface LogPage {
  lines: LogLine[]
  /** What to pass as `before` for the page after this one. Not there when there are no older lines (that match). */
  next?: string
  /** How many lines were skipped for being unreadable. */
  skipped: number
}

/** What a stored withheld result gives: the tool and the content, masked and capped. Attacker-written: show it as text and as nothing else. */
export interface WithheldContent {
  tool: string
  content: string
}
