/**
 * The Jev client: one `fetch` to TypeSafe's `POST /v1/systemone` for each judgment, with the request checked before it is
 * sent and the answer checked before it is believed.
 *
 * What it promises, because every gate in dish-judge stands on it:
 *
 * - **It never throws for a Jev failure.** A missing key, a refused key, a time out, a bad status, a dropped connection, a
 *   malformed answer: each is `{ ok: false, reason: 'unavailable' }` (or `'invalid'`, for a request that was refused as
 *   written, with `from: 'request'` when this client refused it before sending and `from: 'server'` when TypeSafe did).
 *   The caller decides what that means; the gates fail closed.
 * - **It is bounded, whatever its dependencies do.** One request, no retries, and `timeoutMs` covers the whole call: the
 *   settings lookup, the key lookup, the exchange, reading the body and the caller's `decide` hook. The caller's signal
 *   cuts it short too. A lookup that never answers is cut off (the settings at the `timeoutMs` last seen, the shipped one
 *   before any; the key within what is left of the call), and a `decide` always gets a few milliseconds of its own, so a
 *   call that timed out can still be decided. A `429` or `529` also puts Jev out of use for a while (`retry-after`,
 *   between 1 and 60 seconds, 5 if it says nothing), and a call in that time answers `unavailable` at once without calling
 *   `fetch`: the back-off is host-wide, one client for every gate. The back-off and the latencies are measured on a
 *   monotonic clock, so a wall clock that is set back can neither extend one nor make the other negative.
 * - **The key stays in the call.** It is resolved at the start of each call, goes into one header, and is dropped. It is not
 *   in any string the client produces: every message, log line and status passes through a mask that hides the key (as it
 *   is, JSON-escaped and URL-encoded; a value of fewer than `MIN_MASKED_KEY_CHARS` characters is no working key, and is left,
 *   so that a key of "a" doesn't turn every "a" into noise) and an error body is cut to 200 characters first. A call that ended before the key
 *   was looked up, and has text of the caller's to log, looks it up for the mask (and the caller's signal ends that lookup
 *   too: a call that was cancelled is not held for a credential store that hangs).
 * - **No credential leaves with the request.** Before the body is made, every string in the `state` (at any depth, object keys
 *   included) and the texts of the questions (instructions, a choice option's description, a noul's criteria, a score's
 *   levels) are passed through the key's mask and then dish-kit's `maskSecrets`, so a command that carries a token, or a page
 *   that shows one, goes to TypeSafe with the token masked. Question ids and a choice's option names are not masked: the
 *   answers are keyed by them, and they are limited to a charset already. The limits on the state (100 KB) and the body
 *   (256 KB) are checked on what is sent, since a mask can be longer than what it hides (a request that is too big as it is
 *   given is refused before that). A request with a private key's mask in it is not sent either (`OPAQUE_MASKS`: that mask takes
 *   in whatever is written around the key), and is `invalid` from the request with `opaque: true`, which says so to a gate without its reading the message
 *   (and is on no other result). If the masking fails, for any reason, nothing is sent: the call is `unavailable`. What the
 *   caller gave is not changed, and the log line is made from it as it was.
 * - **Statuses.** `401` is `unavailable` ("the TypeSafe key was refused"); `400` and `422` are `invalid`, with the start of
 *   what TypeSafe said; `429` and `529` are `unavailable` and start the back-off; any other non-2xx is `unavailable`.
 *   A request that is too big (the state over 100 KB, the whole body over 256 KB, or TypeSafe's `max_tokens_exceeded`) is
 *   `invalid` with `tooBig: true`, and says nothing about Jev: it leaves the status alone.
 * - **An answer is believed only if it is what was asked for:** the right type for each question, probabilities that cover
 *   exactly the declared options and sum to 1 within 0.025, a choice that is one of its options, a score within its range.
 *
 * The client doesn't know where its log goes: `log` is a function it is given, called once for every call, whatever its
 * outcome, and never waited for (a call whose settling fails has a minimal line, so every call has one). The caller can
 * have its decision written on that line: `decide` is called with the settled result and returns what was decided, which
 * goes on the line and comes back as `decided`. `decide` is given a signal that ends with its time, or with the caller's, for
 * whatever it waits for. This file imports no dsh, so it can be tested against a fake server alone.
 *
 * @module dish-judge/client
 */

import { isTopLevelAgent, maskSecrets } from 'dish-kit'
import type { AgentLike } from 'dish-kit'
// Types only, so that this file does not load the log: the one line type and its parts are the log's.
import type { JsonValue, JudgeLogLine, JudgePurpose } from './log.ts'
import { DEFAULT_SETTINGS } from './settings.ts'
import type { JudgeSettings } from './settings.ts'

/** Anything JSON can hold. */
export type { JsonValue }

/** What Jev is asked about the state. A noul is a yes/no, a choice picks an option, a score places the state on a scale. */
export type Question =
  | { type: 'noul', instructions: string, criteria?: { true: string, false: string } }
  | { type: 'choice', instructions: string, criteria: Record<string, string | null> }     // 2–255 options
  | { type: 'score', instructions: string, criteria: string[] }                           // 2–10 levels, low → high

/** What Jev answers, checked: the shape matches its question. */
export type Answer =
  /** P(yes), from 0 to 1. */
  | { type: 'noul', noul: number }
  /** The likeliest option, every option's probability (they sum to 1), and how sure Jev is. */
  | { type: 'choice', choice: string, probabilities: Record<string, number>, confidence: number }
  /** A place on the scale from 0 to levels − 1, which can fall between levels; `probabilities` is keyed by level number. */
  | { type: 'score', score: number, probabilities: Record<string, number>, confidence: number }

/** Why a call is made: who is asking, for the log and for the page's filters. */
export type Purpose = JudgePurpose

/**
 * Who is asking: any dsh `Agent` fits. Only what the log needs is read: its `id` (the session id) and whether it is a
 * child, which `isTopLevelAgent` decides.
 */
export type JudgeAgent = AgentLike & { readonly id?: unknown }

/**
 * What a caller decided from a result, as the log line has it. A caller can return more than this (its own verdict, its
 * reason), and gets it all back as `decided`.
 */
export interface Decision {
  /** What was decided, in a word: `allow`, `ask`, `deny`, `withhold`, `warn`, `pass`. Shown on the page. */
  decision: string
  /** The id of content the log kept because the decision withheld it from an agent, if it did. */
  withheld?: string
}

export interface JudgeRequest<D extends Decision = Decision> {
  /** What is judged: a string, an object or an array, at most 100 KB of JSON. */
  state: JsonValue
  /** One to many questions, keyed by ids of lower-case letters, digits and underscores, starting with a letter. */
  questions: Record<string, Question>
  purpose: Purpose
  /** Who is asking. Without it, the call is logged as no agent's. */
  agent?: JudgeAgent
  /** Cancels the call. A cancelled call is `unavailable`, and says nothing about Jev in the status. */
  signal?: AbortSignal
  /** What follows is for the log only, and is not sent. The tool call this judgment is for. */
  tool?: string
  callId?: string
  /** What the line says was judged: the command, the tool and size of a result, or `ask_judge`. */
  subject?: string
  /**
   * What the caller decides from the result, for the log. It is called with the result of every call, an answer or a
   * failure, once that is settled (with the key masked out of its message) and before the line is written, and what it
   * returns is the line's `decision` (and `withheld`) and comes back as `decided`.
   *
   * It has the call's time limit, with a little time of its own if Jev used all of it, so a call that timed out can
   * still be decided. If it throws, rejects, takes too long or returns no `decision`, the line has `decision: null` and
   * says "decide failed: …", and the result has no `decided`: a caller that needs a decision must treat that as its
   * failure case.
   *
   * It is given a `signal` too (a hook of one argument still works): it aborts when the hook's time ends, whether that is
   * the call's time limit or the few milliseconds it always has, and when the caller's own `signal` does, and it is aborted
   * already for a call that was cancelled. A hook that waits for something, such as a `withhold` that looks up the key, hands
   * it on, so that what it waits for ends when the time does. The client does not wait for a hook that ignores it past its
   * time: that is the hook failing, as above.
   */
  decide?: (result: JudgeResult, options: DecideOptions) => D | Promise<D>
}

/** What a `decide` hook is given besides the result. */
export interface DecideOptions {
  /** Aborts when the hook's time ends (with an `Error` saying it took longer than the time limit), or when the request's `signal` aborts (with its reason). */
  signal: AbortSignal
}

export type JudgeResult =
  | { ok: true, answers: Record<string, Answer>, latencyMs: number }
  /** Jev could not be asked, or did not answer as it should: `from`, `tooBig` and `opaque` are only on an `invalid` result. */
  | { ok: false, reason: 'unavailable', message: string, from?: undefined, tooBig?: undefined, opaque?: undefined }
  /**
   * `invalid` is a request refused as written, and `from` says by whom: `'request'` is this client, before anything was
   * sent (a question id, type, option or count that isn't allowed, a state that can't be written as JSON or is too big),
   * so what to change is in the request the caller made, and `message` says what; `'server'` is TypeSafe, with a 400 or
   * 422 (an unknown model, a request its schema or its own rules refuse), which is more often the judge's configuration
   * than the caller's request. `tooBig` says it was too big (the state over 100 KB, the whole request over 256 KB, or
   * TypeSafe's `max_tokens_exceeded`), which says nothing about Jev, and can come from either. `opaque` is set for one refusal
   * only, and only from `'request'`: the request holds what looks like a private key, whose mask would take in what is written
   * around it, so nothing was sent and the judge could not have read it. It is how a gate tells that from any other refusal as
   * written (the message is for people, and no gate matches on it).
   */
  | { ok: false, reason: 'invalid', from: 'request' | 'server', message: string, tooBig?: true, opaque?: true }

/** A result, and what the request's `decide` made of it, if it made anything. */
export type Asked<D extends Decision = Decision> = JudgeResult & { decided?: D }

/**
 * Where Jev stands, from the last 100 calls.
 *
 * `p50` and `p95` are the latencies of the last 100 calls that **returned answers**: a failed call (a timeout, an error
 * status, a malformed answer) is not counted, so the figures say how fast Jev is when it works, not how long a failure
 * took. They are `null` until there is such a call.
 *
 * `calls` and `failures` are over the last 100 calls that tried Jev, whether they returned answers or failed: `failures`
 * of the `calls` did not (a time out is one). A call that says nothing about Jev is in neither: one refused as written
 * or as too big, one without a key, one that was cancelled, one skipped in a back-off.
 */
export interface JudgeStatus {
  /** Whether there is a usable key now. A lookup that returns nothing, fails, or takes longer than the call's time limit is no usable key. */
  keySet: boolean
  /**
   * `no-key` when the credential store has no key. `unavailable` when it can't be asked (the lookup fails or takes longer than
   * the call's time limit: the key may well be set, and `lastError` says it could not be read), while Jev is being skipped (a
   * `429` or `529`), and when the last call that tried Jev got no answers (a `400` or `422` that isn't about size is that
   * too). `ok` if not, including before any call.
   */
  state: 'ok' | 'unavailable' | 'no-key'
  /**
   * The message of the last call that tried Jev and got no answers; kept after a success, with `lastErrorAt`. When this status
   * could not read the key, that is the message, and `lastErrorAt` is now.
   */
  lastError?: string
  lastErrorAt?: number
  lastOkAt?: number
  p50: number | null
  p95: number | null
  /** How many calls the window holds, at most 100. */
  calls: number
  /** How many of them failed. */
  failures: number
}

/** The `judge` service: one place that asks Jev, for the gates, the screen and `ask_judge`. */
export interface Judge {
  /**
   * One Jev call: one state, any number of typed questions. Never throws for a Jev failure: it returns `{ ok: false }`.
   * A request that is refused before it is sent (`invalid`) is not a failure of Jev and does not change the status.
   */
  ask<D extends Decision = Decision>(request: JudgeRequest<D>): Promise<Asked<D>>
  /**
   * The status now. It is asynchronous because whether there is a key is looked up afresh (the key is only ever held for
   * the length of a call); it never calls Jev, and a key lookup that hangs is cut off like a call's.
   */
  status(): Promise<JudgeStatus>
}

// Here, with the type, so that whoever imports it also gets `ctx.get('judge')` typed.
declare module '@deepseek-ai/cordis' {
  interface Context {
    judge: Judge
  }
}

/**
 * One line of the decision log: the log's own line type, so that what the client writes is what the log takes, with no
 * cast between them. The client writes one for every call it handles. `decision` and `withheld` are what the caller's
 * `decide` said, and `decision` is `null` without one (or when it failed); `answers` is `{}` when there were none;
 * `agent`, `child`, `tool`, `callId` and `withheld` are left off, never `null`; `latencyMs` is `null` when Jev wasn't
 * called. `answersCut` is the log's own, set only when it cuts a line down.
 */
export type LogLine = JudgeLogLine

export interface JudgeDeps {
  /** The TypeSafe API, with no trailing slash needed: the call is `<baseUrl>/v1/systemone`. */
  baseUrl: string
  /** The key, looked up for every call and every status. Nothing, or blank, is no key. */
  key: () => Promise<string | undefined>
  /** The settings now: the model and the time limit. */
  settings: () => Promise<JudgeSettings>
  /** Where each call is recorded. It is called, never waited for, and may throw or reject: nothing comes of it. */
  log: (line: LogLine) => void | Promise<void>
  /** The wall clock, in ms since the epoch: for `at`, `lastOkAt` and `retry-after` dates. For tests. */
  now?: () => number
  /** A monotonic clock, in ms: for the back-off, the time limit and the latencies. Defaults to `performance.now()`. */
  tick?: () => number
  /** What hides the credentials in every text that is sent. Defaults to dish-kit's `maskSecrets`; here for a test of what a failure of it does. */
  maskSecrets?: (text: string) => string
}

/** The most of `state`, as JSON text in UTF-8: Jev's own limit is 32k tokens for `state` and the longest question. */
export const MAX_STATE_BYTES = 100 * 1024
/** The most of the whole request body, `state` and the questions together, in UTF-8. */
export const MAX_BODY_BYTES = 256 * 1024

/** How many calls the status is over: the latencies of the answered ones, and how many calls and failures there were. */
const WINDOW = 100
/** The time a `decide` gets at the least, when Jev used up the call's time limit: enough for a quick one, and no more. */
const DECIDE_FLOOR_MS = 50
/** `retry-after`, in ms: the least, the most and the guess when it says nothing usable. */
const BACK_OFF = { min: 1_000, max: 60_000, fallback: 5_000 } as const
/** The most of an error body that is read, and of an answer. */
const MAX_ERROR_BYTES = 4_096
const MAX_ANSWER_BYTES = 1024 * 1024
/** The most of an error body that goes into a message. */
const EXCERPT_CHARS = 200
/** How far a distribution's total may be from 1. */
const SUM_TOLERANCE = 0.025

const NO_KEY = 'no TypeSafe key: set it on Settings → Judge'
const CANCELLED = 'the call to the judge was cancelled'
const MASKED = '‹key›'

const QUESTION_ID = /^[a-z][a-z0-9_]*$/
/** C0 and C1 control characters, and DEL. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/
/** What a header value can safely be for a bearer token: visible ASCII, no spaces. */
const HEADER_SAFE = /^[\x21-\x7e]+$/

/** A plain object, like what `JSON.parse` makes or an object literal is. */
function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** A number from 0 to 1. */
function isUnit(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

const isText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// --- checking the request -------------------------------------------------------------------------

type Checked<T> = { ok: true, value: T } | { ok: false, message: string, tooBig?: true }

const bad = (message: string): { ok: false, message: string } => ({ ok: false, message })

/**
 * Whether `option` can be a choice's option. It is what Jev is asked to pick between, so it should mean something to it (a
 * file path, a name, a word): 1–64 characters with no whitespace at either end, no control characters, and not `__proto__`.
 */
function isOption(option: string): boolean {
  return option.length >= 1 && option.length <= 64 && option === option.trim() && !CONTROL.test(option) && option !== '__proto__'
}

/**
 * The questions as they will go on the wire: only the fields Jev knows, and every rule of the spec checked. The first
 * problem is the answer; its message names the question and what to change.
 */
function checkQuestions(questions: unknown): Checked<Record<string, Question>> {
  if (!isRecord(questions)) return bad('questions must be an object of questions keyed by id')
  const ids = Object.keys(questions)
  if (ids.length === 0) return bad('questions: at least one question is needed')
  const wire: Record<string, Question> = {}
  for (const id of ids) {
    if (!QUESTION_ID.test(id)) return bad(`question id ${JSON.stringify(id)} must be lower-case letters, digits and underscores, starting with a letter (${QUESTION_ID})`)
    const question = questions[id]
    const name = JSON.stringify(id)
    if (!isRecord(question)) return bad(`question ${name} must be an object like { type, instructions, criteria }`)
    const { type, instructions, criteria } = question
    if (type !== 'noul' && type !== 'choice' && type !== 'score') return bad(`question ${name} needs a type: noul, choice or score`)
    if (!isText(instructions)) return bad(`question ${name} needs instructions: a non-empty string`)
    if (type === 'noul') {
      if (criteria === undefined) {
        wire[id] = { type, instructions }
        continue
      }
      if (!isRecord(criteria) || Object.keys(criteria).sort().join() !== 'false,true' || !isText(criteria.true) || !isText(criteria.false)) {
        return bad(`question ${name}: noul criteria must be exactly { true, false }, each a non-empty string describing what that answer means`)
      }
      wire[id] = { type, instructions, criteria: { true: criteria.true, false: criteria.false } }
    } else if (type === 'choice') {
      if (!isRecord(criteria)) return bad(`question ${name} needs criteria: an object of 2–255 options, each a description or null`)
      const options = Object.keys(criteria)
      if (options.length < 2 || options.length > 255) return bad(`question ${name}: a choice needs 2–255 options, got ${options.length}`)
      const described: Array<[string, string | null]> = []
      for (const option of options) {
        if (!isOption(option)) {
          return bad(`question ${name}: option ${JSON.stringify(option.length > 40 ? `${option.slice(0, 40)}…` : option)} is not allowed: options are 1–64 characters with no whitespace at either end and no control characters, and not __proto__`)
        }
        const description = criteria[option]
        if (description !== null && !isText(description)) return bad(`question ${name}: the description of option ${JSON.stringify(option)} must be a non-empty string or null`)
        described.push([option, description])
      }
      // `fromEntries` defines each option as a property of its own, whatever it is called.
      wire[id] = { type, instructions, criteria: Object.fromEntries(described) }
    } else {
      if (!Array.isArray(criteria)) return bad(`question ${name} needs criteria: a list of 2–10 levels, from low to high`)
      if (criteria.length < 2 || criteria.length > 10) return bad(`question ${name}: a score needs 2–10 levels, got ${criteria.length}`)
      const levels: string[] = []
      for (const [index, level] of criteria.entries()) {
        if (!isText(level)) return bad(`question ${name}: level ${index} must be a non-empty string`)
        levels.push(level)
      }
      wire[id] = { type, instructions, criteria: levels }
    }
  }
  return { ok: true, value: wire }
}

/** The JSON text of `state`, if it is a string, an object or an array that JSON can hold, within the limit. */
function checkState(state: unknown): Checked<string> {
  const shape = 'state must be a string, an object or an array that can be written as JSON'
  if (typeof state === 'string' && state.length > MAX_STATE_BYTES) return tooBig(`state is ${kb(state.length)} KB of JSON and the most is 100 KB: send the part that matters`)
  let text: string | undefined
  try {
    text = JSON.stringify(state)
  } catch {
    return bad(shape)
  }
  // A string, an object or an array starts with a quote or a bracket; a number, a boolean, null, `undefined` and
  // whatever a `toJSON` turned into one of them do not.
  if (text === undefined || (text[0] !== '"' && text[0] !== '{' && text[0] !== '[')) return bad(shape)
  const bytes = Buffer.byteLength(text)
  if (bytes > MAX_STATE_BYTES) return tooBig(`state is ${kb(bytes)} KB of JSON and the most is 100 KB: send the part that matters`)
  return { ok: true, value: text }
}

const kb = (bytes: number): number => Math.ceil(bytes / 1024)

/** A refusal for being too big: says nothing about Jev. */
function tooBig(message: string): { ok: false, message: string, tooBig: true } {
  return { ok: false, message, tooBig: true }
}

// --- masking what is sent --------------------------------------------------------------------------

/**
 * `value` with every string in it, and every key of every object, passed through `mask`: a copy, so what the caller gave is
 * as it was. Numbers, booleans and `null` are as they are. `value` is what `JSON.parse` made, so it has no cycles, no
 * `undefined`, no class instances. An object is rebuilt with `fromEntries`, which defines each key as a property of its own,
 * `__proto__` too.
 */
function maskDeep(value: unknown, mask: (text: string) => string): unknown {
  if (typeof value === 'string') return mask(value)
  if (Array.isArray(value)) return value.map(item => maskDeep(item, mask))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [mask(key), maskDeep(item, mask)]))
  }
  return value
}

/**
 * The masks that can stand for more than a credential. A private key is masked from its header to its END line, or through
 * 8 KB of what a key can be made of (letters, digits, spaces, line breaks, `/`, `-`, `.` and more), and that takes in whatever
 * is written there: `npm test`, a fake header and `git push --force` on the next line is sent as `npm test` and a mask, and a page
 * that wraps its instructions to an agent in a fake key is sent as a mask. The judge would be asked about what is left, and its
 * answer would be about something other than what runs or what the agent reads. A scan that failed hides all of a text. A
 * request with either in what it would send is not sent: it is `invalid` from the request, with `opaque: true`.
 */
const OPAQUE_MASKS: readonly string[] = ['‹secret: a private key›', '‹secret: an unreadable secret scan›']
/**
 * A text that came back as one mask, though it had whitespace in it, which no token has: `maskSecrets`' last resort, which
 * hides all of a text it could not make safe any other way. Opaque too.
 */
const LONE_MASK = /^‹secret: [^›]*›$/
const OPAQUE_REFUSAL = 'the request holds what looks like a private key, which is not sent to TypeSafe, and with it masked the judge could not read what is written around it: nothing was sent; leave the key out'

/**
 * The questions as they will go on the wire, with every text in them masked: instructions, a choice option's description, a
 * noul's criteria, a score's levels. **Not** the question ids, nor a choice's option names: the answers are keyed by them, and
 * `checkQuestions` has limited what they can be.
 */
function maskQuestions(questions: Record<string, Question>, mask: (text: string) => string): Record<string, Question> {
  const masked: Record<string, Question> = {}
  for (const [id, question] of Object.entries(questions)) {
    const instructions = mask(question.instructions)
    if (question.type === 'noul') {
      masked[id] = question.criteria === undefined
        ? { type: 'noul', instructions }
        : { type: 'noul', instructions, criteria: { true: mask(question.criteria.true), false: mask(question.criteria.false) } }
    } else if (question.type === 'choice') {
      masked[id] = { type: 'choice', instructions, criteria: Object.fromEntries(Object.entries(question.criteria).map(([option, description]) => [option, description === null ? null : mask(description)])) }
    } else {
      masked[id] = { type: 'score', instructions, criteria: question.criteria.map(level => mask(level)) }
    }
  }
  return masked
}

// --- checking the answer --------------------------------------------------------------------------

/**
 * Whether `body` is the answer to `questions` and nothing else: the checks of the ten-levels client that matter to a
 * decision, and no more (the envelope's `model` and `usage` and a score's `legend` are not needed, so a change in them
 * would not make a gate ask for no reason). The answers that come back are copies with only the known fields. A
 * message says which question and what was wrong, never what Jev wrote.
 */
function checkAnswers(body: unknown, questions: Record<string, Question>): { ok: true, answers: Record<string, Answer> } | { ok: false, problem: string } {
  const wrong = (problem: string) => ({ ok: false as const, problem })
  if (!isRecord(body) || !isRecord(body.answers)) return wrong('there is no "answers" object')
  const given = body.answers
  const answers: Record<string, Answer> = {}
  for (const [id, question] of Object.entries(questions)) {
    const name = JSON.stringify(id)
    if (!Object.hasOwn(given, id)) return wrong(`there is no answer for ${name}`)
    const answer = given[id]
    if (!isRecord(answer) || answer.type !== question.type) return wrong(`the answer for ${name} is not a ${question.type}`)
    if (question.type === 'noul') {
      if (!isUnit(answer.noul)) return wrong(`the noul for ${name} is not a number from 0 to 1`)
      answers[id] = { type: 'noul', noul: answer.noul }
      continue
    }
    const keys = question.type === 'choice' ? Object.keys(question.criteria) : question.criteria.map((_, index) => String(index))
    if (!isUnit(answer.confidence)) return wrong(`the confidence for ${name} is not a number from 0 to 1`)
    const given_ = answer.probabilities
    if (!isRecord(given_)) return wrong(`there are no probabilities for ${name}`)
    if (Object.keys(given_).length !== keys.length || !keys.every(key => Object.hasOwn(given_, key) && isUnit(given_[key]))) {
      return wrong(`the probabilities for ${name} are not one number from 0 to 1 for each of its ${question.type === 'choice' ? 'options' : 'levels'}`)
    }
    const probabilities = Object.fromEntries(keys.map(key => [key, given_[key] as number]))
    const sum = Object.values(probabilities).reduce((total, p) => total + p, 0)
    // A little over the tolerance is float error, not Jev's.
    if (Math.abs(sum - 1) > SUM_TOLERANCE + 1e-9) return wrong(`the probabilities for ${name} sum to ${sum.toFixed(3)}, not 1`)
    if (question.type === 'choice') {
      if (typeof answer.choice !== 'string' || !keys.includes(answer.choice)) return wrong(`the choice for ${name} is not one of its options`)
      answers[id] = { type: 'choice', choice: answer.choice, probabilities, confidence: answer.confidence }
    } else {
      if (typeof answer.score !== 'number' || !Number.isFinite(answer.score) || answer.score < 0 || answer.score > keys.length - 1) {
        return wrong(`the score for ${name} is not between 0 and ${keys.length - 1}`)
      }
      answers[id] = { type: 'score', score: answer.score, probabilities, confidence: answer.confidence }
    }
  }
  return { ok: true, answers }
}

// --- the exchange ---------------------------------------------------------------------------------

/**
 * The fewest characters a key can have and still be hidden in a text. The real key is about a hundred; TypeSafe answers 401 to
 * a shorter one than a key can be, so a value this short is no working key, and hiding it would hide every "a" in what is
 * logged. A call with such a key fails with "the TypeSafe key was refused" and logs what it was given, as it is.
 */
export const MIN_MASKED_KEY_CHARS = 20

/** A function that hides every form of `key` in a text: as it is, JSON-escaped, and URL-encoded. Not a key of fewer than `MIN_MASKED_KEY_CHARS` characters. */
function maskerFor(key: string): (text: string) => string {
  if (key.length < MIN_MASKED_KEY_CHARS) return text => text
  const forms = [...new Set([key, JSON.stringify(key).slice(1, -1), encodeURIComponent(key)])].sort((a, b) => b.length - a.length)
  return text => forms.reduce((masked, form) => masked.split(form).join(MASKED), text)
}

/**
 * A function that hides the key as it is now, in the forms `maskerFor` does, for a caller that has text of its own to keep
 * (the log's withheld content, which the client doesn't write). The key is looked up, not kept, and the lookup is given
 * `ms`, and is given up when `signal` aborts: no key, a lookup that fails, one that takes longer and one that is cancelled all
 * give a function that changes nothing, so that the caller can go on with the masking that needs no key. Never rejects.
 */
export async function currentKeyMask(lookup: () => Promise<string | undefined>, ms: number, signal?: AbortSignal): Promise<(text: string) => string> {
  try {
    const looked = within(Promise.resolve().then(lookup), ms, 'the key lookup took too long')
    const key = cleanKey(await (signal === undefined ? looked : untilAborted(looked, signal)))
    if (key !== undefined) return maskerFor(key)
  } catch {
    // No key to hide, or none that could be found in time, or the caller gave up.
  }
  return text => text
}

/** What a key lookup gave, as a key: trimmed, and nothing if nothing is left. */
function cleanKey(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * How long `retry-after` asks for, in ms, kept between 1 and 60 seconds: whole or fractional seconds, or an HTTP date
 * (which has to start with a weekday, since `Date.parse` alone takes things like "-1"). Anything else is the fallback.
 */
function backOffMs(header: string | null, at: number): number {
  const value = header?.trim() ?? ''
  let ms: number | undefined
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    ms = Number(value) * 1000
  } else if (/^(?:mon|tue|wed|thu|fri|sat|sun)/i.test(value)) {
    const date = Date.parse(value)
    if (Number.isFinite(date)) ms = date - at
  }
  if (ms === undefined || !Number.isFinite(ms)) return BACK_OFF.fallback
  return Math.min(BACK_OFF.max, Math.max(BACK_OFF.min, ms))
}

/** The start of `response`'s body as text, reading at most `maxBytes` (and a little over), then letting go of the rest. */
async function readText(response: Response, maxBytes: number): Promise<{ text: string, truncated: boolean }> {
  if (response.body === null) return { text: '', truncated: false }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let bytes = 0
  let truncated = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      text += decoder.decode(value, { stream: true })
      if (bytes > maxBytes) {
        truncated = true
        break
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return { text: text + decoder.decode(), truncated }
}

/**
 * The words of an error body, for a message. TypeSafe's bodies, as seen live, are `{"detail": "..."}`,
 * `{"detail": {"error_type": "...", "message": "..."}}`, and for a request that fails its schema (422) a list of
 * `{ "loc": [...], "msg": "...", "input": ... }` where `input` is the part of the request that was wrong, which can be
 * the state: the list is read as `<where>: <msg>` and the inputs are left behind. Anything else is the text as it came.
 */
function refusalText(text: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return text
  }
  if (!isRecord(parsed)) return text
  const { detail } = parsed
  if (typeof detail === 'string') return detail
  if (isRecord(detail)) {
    if (typeof detail.message === 'string') return detail.message
    if (typeof detail.error_type === 'string') return detail.error_type
  }
  if (Array.isArray(detail) && detail.length > 0) {
    const parts = detail.map((item: unknown) => {
      if (!isRecord(item) || typeof item.msg !== 'string') return undefined
      const where = Array.isArray(item.loc) ? item.loc.filter(part => part !== 'body').join('.') : ''
      return where === '' ? item.msg : `${where}: ${item.msg}`
    })
    if (parts.every(part => part !== undefined)) return parts.join('; ')
  }
  return text
}

/** What a failed `fetch` was, in a few words: its message, and its cause's code or message when that says more. */
function describeNetworkError(error: unknown): string {
  if (!(error instanceof Error)) return 'an unknown error'
  const cause = (error as { cause?: unknown }).cause
  const detail = cause instanceof Error ? ((cause as { code?: unknown }).code ?? cause.message) : undefined
  return typeof detail === 'string' && detail !== '' && detail !== error.message ? `${error.message} (${detail})` : error.message
}

/** `promise`, or its rejection when `signal` aborts first. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    // Listened to first, even for a signal that has aborted already: a promise that rejects later is then not an unhandled rejection.
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value) },
      (error: unknown) => { signal.removeEventListener('abort', onAbort); reject(error) },
    )
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** A signal that aborts after `ms`, which a clock reading can leave fractional or negative: `AbortSignal.timeout` takes whole numbers. */
function limitSignal(ms: number): AbortSignal {
  return AbortSignal.timeout(Number.isFinite(ms) ? Math.max(0, Math.ceil(ms)) : 0)
}

/** `promise`, or a rejection with `what` once `ms` have passed. */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(what)), Number.isFinite(ms) ? Math.max(0, ms) : 0)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error: unknown) => { clearTimeout(timer); reject(error) },
    )
  })
}

/** The nearest-rank percentile of an ascending list. */
function percentile(sorted: readonly number[], p: number): number {
  return sorted[Math.max(0, Math.ceil(p * sorted.length / 100) - 1)]!
}

/** Whether a `400`'s body says TypeSafe's `max_tokens_exceeded`: the request was too big for it. */
function isTooManyTokens(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text)
    return isRecord(parsed) && isRecord(parsed.detail) && parsed.detail.error_type === 'max_tokens_exceeded'
  } catch {
    return false
  }
}

/** `text` cut to the length of an error excerpt. */
function clip(text: string): string {
  return text.length > EXCERPT_CHARS ? `${text.slice(0, EXCERPT_CHARS - 1)}…` : text
}

/**
 * What a call came to, before it is logged and turned into a result. `effect` says what it means for the status:
 * `failed` for a call that tried Jev and got no answers (or could not try for a reason that is Jev's side of things: a
 * key it can't use, a time out), `none` for one that says nothing about Jev (a request refused as written or as too big,
 * no key, a cancel, a call skipped in a back-off).
 */
type Outcome =
  | { kind: 'answers', answers: Record<string, Answer>, latencyMs: number }
  | { kind: 'failure', reason: 'unavailable', message: string, effect: 'failed' | 'none', latencyMs: number | null }
  | { kind: 'failure', reason: 'invalid', from: 'request' | 'server', message: string, effect: 'failed' | 'none', latencyMs: number | null, tooBig?: true, opaque?: true }

function failure(reason: 'unavailable', message: string, effect: 'failed' | 'none', latencyMs: number | null = null): Outcome {
  return { kind: 'failure', reason, message, effect, latencyMs }
}

/** A request refused as written, by this client (`request`) or by TypeSafe (`server`). */
function invalid(from: 'request' | 'server', message: string, effect: 'failed' | 'none', latencyMs: number | null = null, flags: { tooBig?: boolean, opaque?: boolean } = {}): Outcome {
  return { kind: 'failure', reason: 'invalid', from, message, effect, latencyMs, ...flags.tooBig === true ? { tooBig: true as const } : {}, ...flags.opaque === true ? { opaque: true as const } : {} }
}

/** What goes with one call while it runs. */
interface Scope {
  /** Hides the key, once there is one. */
  mask: (text: string) => string
  /** Whether the key was looked up, so `mask` is as good as it will get. */
  keyLooked: boolean
  /** When the call's time limit ends, on the monotonic clock, and how long that limit is. */
  deadline: number
  limit: number
  /** Whether the call's line was handed to the log. */
  logged: boolean
}

export function createJudge(deps: JudgeDeps): Judge {
  const now = deps.now ?? Date.now
  const tick = deps.tick ?? (() => performance.now())
  const endpoint = `${deps.baseUrl.replace(/\/+$/, '')}/v1/systemone`
  const secrets = deps.maskSecrets ?? maskSecrets

  /** The latencies of the last answered calls, oldest first. */
  const latencies: number[] = []
  /** The last calls that tried Jev, oldest first: whether each returned answers. */
  const recent: boolean[] = []
  /** Jev is out of use until this time, on the monotonic clock: a `429` or `529` said so. */
  let skipUntil = Number.NEGATIVE_INFINITY
  /** The time limit of the settings last read: what a lookup that never answers is held to. Before any, the shipped one. */
  let lastLimit = DEFAULT_SETTINGS.timeoutMs
  let lastFailed = false
  let lastOkAt: number | undefined
  let lastError: string | undefined
  let lastErrorAt: number | undefined

  /** The call itself, up to what it came to. It may throw only for a mistake in this file. */
  async function run(request: JudgeRequest<Decision>, scope: Scope, begun: number): Promise<Outcome> {
    const questions = checkQuestions(request.questions)
    if (!questions.ok) return invalid('request', questions.message, 'none')
    const state = checkState(request.state)
    if (!state.ok) return invalid('request', state.message, 'none', null, { tooBig: state.tooBig === true })
    const cancelled = () => failure('unavailable', CANCELLED, 'none')
    if (request.signal?.aborted) return cancelled()

    // A call in a back-off is answered before anything else is looked up. A clock that went back can't make the wait longer
    // than a back-off ever is.
    let waiting = skipUntil - tick()
    if (waiting > BACK_OFF.max) {
      skipUntil = tick() + BACK_OFF.max
      waiting = BACK_OFF.max
    }
    if (waiting > 0) {
      return failure('unavailable', `TypeSafe asked for a pause: skipping the judge for another ${Math.ceil(waiting / 1000)} s`, 'none')
    }

    // The settings are read from the config store, which may be queued behind something that never ends: the lookup is held
    // to the time limit the settings last had, and to the caller's signal.
    const lookupLimit = lastLimit
    const lookupTimeout = limitSignal(lookupLimit)
    const lookupGuard = request.signal === undefined ? lookupTimeout : AbortSignal.any([request.signal, lookupTimeout])
    let settings: JudgeSettings
    try {
      settings = await untilAborted(Promise.resolve().then(deps.settings), lookupGuard)
    } catch {
      if (request.signal?.aborted) return cancelled()
      if (lookupTimeout.aborted) return failure('unavailable', `reading the judge settings timed out after ${lookupLimit} ms`, 'failed')
      return failure('unavailable', 'could not read the judge settings', 'failed')
    }
    if (typeof settings.timeoutMs !== 'number' || !Number.isFinite(settings.timeoutMs) || settings.timeoutMs <= 0) {
      return failure('unavailable', 'could not read the judge settings', 'failed')
    }
    lastLimit = settings.timeoutMs
    // From here on the whole call has `timeoutMs`, counted from when it began: what the settings lookup took is not
    // given back, so a slow store can't stretch the call.
    scope.limit = settings.timeoutMs
    scope.deadline = begun + settings.timeoutMs

    // Too big as it is given: refused before anything is asked of the key or masked. What is sent is checked again once it is masked.
    const bodyBytes = Buffer.byteLength(`{"model":${JSON.stringify(settings.model)},"state":${state.value},"questions":${JSON.stringify(questions.value)}}`)
    if (bodyBytes > MAX_BODY_BYTES) {
      return invalid('request', `the request is ${kb(bodyBytes)} KB and the most is 256 KB: send less`, 'none', null, { tooBig: true })
    }

    const timeout = limitSignal(scope.deadline - tick())
    const signal = request.signal === undefined ? timeout : AbortSignal.any([request.signal, timeout])
    const timedOut = (what: string, latencyMs: number | null = null) => failure('unavailable', `${what} timed out after ${scope.limit} ms`, 'failed', latencyMs)

    // So a credential store that hangs can't hang a gate: the key lookup is inside the time limit too.
    let key: string | undefined
    try {
      key = cleanKey(await untilAborted(Promise.resolve().then(deps.key), signal))
    } catch {
      if (request.signal?.aborted) return cancelled()
      if (timeout.aborted) return timedOut('reading the TypeSafe key')
      // What the credential store said is not repeated: it may be a line of the file the key is in.
      return failure('unavailable', 'could not read the TypeSafe key from the credential store', 'failed')
    } finally {
      scope.keyLooked = true
    }
    if (key === undefined) return failure('unavailable', NO_KEY, 'none')
    if (!HEADER_SAFE.test(key)) {
      return failure('unavailable', 'the TypeSafe key has characters that can\'t be sent in a header: set it again on Settings → Judge', 'failed')
    }
    scope.mask = maskerFor(key)

    // Nothing leaves this machine with a credential in it. Every string that is sent (the state, at any depth, object keys
    // included, and the texts of the questions) is passed through the key's mask, so that the key goes whole, and then
    // through the patterns of `maskSecrets`. The size limits are for what is sent, so they are checked again on it: a mask can
    // be longer than what it hides. If any of this fails, nothing is sent: the call is unavailable.
    let sent: string
    let opaque = false
    try {
      const hide = (text: string): string => {
        const hidden = secrets(scope.mask(text))
        if (typeof hidden !== 'string') throw new TypeError('a mask gave something that is not a string')
        if (OPAQUE_MASKS.some(mask => hidden.includes(mask)) || (LONE_MASK.test(hidden) && /\s/.test(text))) opaque = true
        return hidden
      }
      const maskedState = JSON.stringify(maskDeep(JSON.parse(state.value), hide))
      const maskedQuestions = JSON.stringify(maskQuestions(questions.value, hide))
      // Before the size: a split of what is too big would not make the judge see what a mask took in.
      if (opaque) return invalid('request', OPAQUE_REFUSAL, 'none', null, { opaque: true })
      const maskedBytes = Buffer.byteLength(maskedState)
      if (maskedBytes > MAX_STATE_BYTES) {
        return invalid('request', `state is ${kb(maskedBytes)} KB of JSON once its secrets are masked and the most is 100 KB: send the part that matters`, 'none', null, { tooBig: true })
      }
      sent = `{"model":${JSON.stringify(settings.model)},"state":${maskedState},"questions":${maskedQuestions}}`
    } catch {
      // What failed is not repeated: it may hold what was being masked.
      return failure('unavailable', 'the request could not be cleared of secrets, so nothing was sent', 'failed')
    }
    const sentBytes = Buffer.byteLength(sent)
    if (sentBytes > MAX_BODY_BYTES) {
      return invalid('request', `the request is ${kb(sentBytes)} KB once its secrets are masked and the most is 256 KB: send less`, 'none', null, { tooBig: true })
    }

    const started = tick()
    const elapsed = () => Math.max(0, Math.round(tick() - started))
    let status: number
    let retryAfter: string | null
    let text = ''
    let truncated = false
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: sent,
        signal,
        // The key must not follow a redirect anywhere.
        redirect: 'error',
      })
      status = response.status
      retryAfter = response.headers.get('retry-after')
      if (status === 401 || status === 429 || status === 529) {
        await response.body?.cancel().catch(() => {})
      } else {
        ({ text, truncated } = await readText(response, response.ok ? MAX_ANSWER_BYTES : MAX_ERROR_BYTES))
      }
    } catch (error) {
      if (request.signal?.aborted) return failure('unavailable', CANCELLED, 'none', elapsed())
      if (timeout.aborted) return timedOut('the call to TypeSafe', elapsed())
      return failure('unavailable', `could not reach TypeSafe: ${describeNetworkError(error)}`, 'failed', elapsed())
    }
    const latencyMs = elapsed()

    /** The start of an error body, with the key hidden first, whitespace made plain and the whole cut to 200 characters. */
    const excerpt = (): string => clip(scope.mask(refusalText(text)).replace(/[\s\x00-\x1f\x7f]+/g, ' ').trim())
    const detail = (): string => {
      const shown = excerpt()
      return shown === '' ? '' : `: ${shown}`
    }

    if (status === 401) return failure('unavailable', 'the TypeSafe key was refused', 'failed', latencyMs)
    if (status === 429 || status === 529) {
      const pause = backOffMs(retryAfter, now())
      skipUntil = Math.max(skipUntil, tick() + pause)
      const why = status === 429 ? 'is rate-limiting the judge' : 'is overloaded'
      return failure('unavailable', `TypeSafe ${why} (HTTP ${status}): skipping it for ${Math.ceil(pause / 1000)} s`, 'failed', latencyMs)
    }
    // TypeSafe says 422 for a request that fails its schema and 400 for one its own rules refuse (an unknown model, too many
    // score levels, too many tokens): either way the request, as written, is what it won't take. One that is too big for it
    // is no sign that Jev is down, so the status doesn't take it as one; any other is, so a typo'd model shows on the page.
    if (status === 400 || status === 422) {
      const big = status === 400 && isTooManyTokens(text)
      return invalid('server', `TypeSafe refused the request (HTTP ${status})${detail()}`, big ? 'none' : 'failed', latencyMs, { tooBig: big })
    }
    if (status < 200 || status > 299) return failure('unavailable', `TypeSafe answered HTTP ${status}${detail()}`, 'failed', latencyMs)

    const malformed = (problem: string) => failure('unavailable', `the judge's answer was malformed: ${problem}`, 'failed', latencyMs)
    if (truncated) return malformed('it is too large')
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return malformed('it is not JSON')
    }
    const checked = checkAnswers(parsed, questions.value)
    if (!checked.ok) return malformed(checked.problem)
    return { kind: 'answers', answers: checked.answers, latencyMs }
  }

  /** Put a call into the status: the window of calls, the latencies, the last success and the last error. */
  function record(outcome: Outcome, message: string | undefined): void {
    if (outcome.kind === 'answers') {
      latencies.push(outcome.latencyMs)
      if (latencies.length > WINDOW) latencies.shift()
      recent.push(true)
      lastFailed = false
      lastOkAt = now()
    } else if (outcome.effect === 'failed') {
      recent.push(false)
      lastFailed = true
      lastError = message
      lastErrorAt = now()
    }
    if (recent.length > WINDOW) recent.shift()
  }

  /**
   * Make the result of a call and write its line. The status is updated first, then the key is looked up for the mask if the
   * call ended before it was (and has text of the caller's to hide it from), then `decide` is called, and the line is
   * written last, without waiting for it.
   */
  async function settle<D extends Decision>(request: JudgeRequest<D>, at: number, outcome: Outcome, scope: Scope): Promise<Asked<D>> {
    const message = outcome.kind === 'failure' ? scope.mask(outcome.message) : undefined
    record(outcome, message)

    const agentId = request.agent?.id
    const given = (value: unknown): value is string => typeof value === 'string' && value !== ''
    const hasText = given(request.subject) || given(request.tool) || given(request.callId) || typeof agentId === 'string' || typeof agentId === 'number'
    if (!scope.keyLooked && (hasText || typeof request.decide === 'function')) {
      scope.keyLooked = true
      // The caller's signal ends it too: a call that was cancelled is not held for a credential store that hangs.
      scope.mask = await currentKeyMask(deps.key, Math.max(DECIDE_FLOOR_MS, scope.deadline - tick()), request.signal)
    }

    let result: JudgeResult
    if (outcome.kind === 'answers') {
      result = { ok: true, answers: outcome.answers, latencyMs: outcome.latencyMs }
    } else {
      const message = scope.mask(outcome.message)
      result = outcome.reason === 'invalid'
        ? { ok: false, reason: 'invalid', from: outcome.from, message, ...outcome.tooBig === true ? { tooBig: true as const } : {}, ...outcome.opaque === true ? { opaque: true as const } : {} }
        : { ok: false, reason: 'unavailable', message }
    }

    const line: LogLine = {
      at,
      purpose: request.purpose,
      subject: scope.mask(typeof request.subject === 'string' ? request.subject : ''),
      answers: outcome.kind === 'answers' ? structuredClone(outcome.answers) : {},
      decision: null,
      latencyMs: outcome.latencyMs,
      error: result.ok ? null : result.message,
    }
    if (request.agent !== undefined) {
      if (typeof agentId === 'string' || typeof agentId === 'number') line.agent = scope.mask(String(agentId))
      line.child = !isTopLevelAgent(request.agent)
    }
    if (given(request.tool)) line.tool = scope.mask(request.tool)
    if (given(request.callId)) line.callId = scope.mask(request.callId)

    let decided: D | undefined
    if (typeof request.decide === 'function') {
      const hook = request.decide
      // The hook's time, and a signal that ends with it, or with the caller's. One timer: the signal and the race with the
      // hook end together, with the same reason, whichever of them a hook is stopped by.
      const time = new AbortController()
      const timer = setTimeout(() => time.abort(new Error('it took longer than the time limit')), Math.max(DECIDE_FLOOR_MS, scope.deadline - tick()))
      const signal = request.signal === undefined ? time.signal : AbortSignal.any([time.signal, request.signal])
      try {
        const value: unknown = await untilAborted(Promise.resolve().then(() => hook(result, { signal })), time.signal)
        const said = value as Partial<Decision> | null
        if (said === null || typeof said !== 'object' || typeof said.decision !== 'string' || (said.withheld !== undefined && typeof said.withheld !== 'string')) {
          throw new Error('it returned no decision')
        }
        decided = value as D
        line.decision = scope.mask(decided.decision)
        if (decided.withheld !== undefined) line.withheld = decided.withheld
      } catch (error) {
        const problem = `decide failed: ${clip(scope.mask(describe(error)))}`
        line.error = line.error === null ? problem : `${line.error}; ${problem}`
      } finally {
        clearTimeout(timer)
      }
    }

    scope.logged = true
    try {
      Promise.resolve(deps.log(line)).catch(() => {})
    } catch {
      // A log that can't be written to is not a reason to fail a call.
    }
    return decided === undefined ? result : { ...result, decided }
  }

  return {
    async ask<D extends Decision = Decision>(request: JudgeRequest<D>): Promise<Asked<D>> {
      const at = now()
      const begun = tick()
      const scope: Scope = { mask: text => text, keyLooked: false, deadline: begun + lastLimit, limit: lastLimit, logged: false }
      let outcome: Outcome
      try {
        outcome = await run(request as JudgeRequest<Decision>, scope, begun)
      } catch (error) {
        outcome = failure('unavailable', `the judge failed unexpectedly: ${describe(error)}`, 'failed')
      }
      try {
        return await settle(request, at, outcome, scope)
      } catch (error) {
        // A mistake in settling: the call has still to come back, and as a failure, and every call has a line.
        const message = clip(scope.mask(`the judge failed unexpectedly: ${describe(error)}`))
        if (!scope.logged) {
          // What can be said without touching the request again, since that may be what failed: nothing in this can throw.
          try {
            scope.logged = true
            Promise.resolve(deps.log({ at, purpose: request.purpose, subject: '', answers: {}, decision: null, latencyMs: null, error: message })).catch(() => {})
          } catch {
            // No line, as before: the call is what matters.
          }
        }
        return { ok: false, reason: 'unavailable', message }
      }
    },

    async status() {
      let keySet = false
      // Why the key could not be read, when the lookup failed or hung: not the same as there being none, which is what the
      // page asks the user to fix. What the credential store said is not repeated, as in a call.
      let unreadable: string | undefined
      const limit = limitSignal(lastLimit)
      try {
        keySet = cleanKey(await untilAborted(Promise.resolve().then(deps.key), limit)) !== undefined
      } catch {
        unreadable = limit.aborted ? `reading the TypeSafe key timed out after ${lastLimit} ms` : 'could not read the TypeSafe key from the credential store'
      }
      const sorted = [...latencies].sort((a, b) => a - b)
      const shownError = unreadable ?? lastError
      return {
        keySet,
        state: unreadable !== undefined ? 'unavailable' : !keySet ? 'no-key' : lastFailed || skipUntil > tick() ? 'unavailable' : 'ok',
        ...shownError === undefined ? {} : { lastError: shownError },
        ...unreadable !== undefined ? { lastErrorAt: now() } : lastErrorAt === undefined ? {} : { lastErrorAt },
        ...lastOkAt === undefined ? {} : { lastOkAt },
        p50: sorted.length === 0 ? null : percentile(sorted, 50),
        p95: sorted.length === 0 ? null : percentile(sorted, 95),
        calls: recent.length,
        failures: recent.filter(answered => !answered).length,
      }
    },
  }
}
