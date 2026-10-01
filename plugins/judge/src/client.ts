/**
 * The Jev client: one `fetch` to TypeSafe's `POST /v1/systemone` for each judgment, with the request checked before it is
 * sent and the answer checked before it is believed.
 *
 * What it promises, because every gate in dish-judge stands on it:
 *
 * - **It never throws for a Jev failure.** A missing key, a refused key, a time out, a bad status, a dropped connection, a
 *   malformed answer: each is `{ ok: false, reason: 'unavailable' }` (or `'invalid'`, for a request that was refused as
 *   written). The caller decides what that means; the gates fail closed.
 * - **It is bounded.** One request, no retries, and `timeoutMs` covers the whole call: looking the key up, the exchange and
 *   reading the body. A `429` or `529` also puts Jev out of use for a while (`retry-after`, between 1 and 60 seconds, 5 if
 *   it says nothing), and a call in that time answers `unavailable` at once without calling `fetch`: the back-off is
 *   host-wide, one client for every gate.
 * - **The key stays in the call.** It is resolved at the start of each call, goes into one header, and is dropped. It is not
 *   in any string the client produces: every message, log line and status passes through a mask that hides the key (as it
 *   is, JSON-escaped and URL-encoded) and an error body is cut to 200 characters first.
 * - **Statuses.** `401` is `unavailable` ("the TypeSafe key was refused"); `400` and `422` are `invalid`, with the start of
 *   what TypeSafe said; `429` and `529` are `unavailable` and start the back-off; any other non-2xx is `unavailable`.
 * - **An answer is believed only if it is what was asked for:** the right type for each question, probabilities that cover
 *   exactly the declared options and sum to 1 within 0.025, a choice that is one of its options, a score within its range.
 *
 * The client doesn't know where its log goes: `log` is a function it is given, called once for every call, whatever its
 * outcome, and never waited for. This file imports no dsh, so it can be tested against a fake server alone.
 *
 * @module dish-judge/client
 */

import { isTopLevelAgent } from 'dish-kit'
import type { AgentLike } from 'dish-kit'
import type { JudgeSettings } from './settings.ts'

/** Anything JSON can hold. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

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
export type Purpose = 'command' | 'approval' | 'screen' | 'ask'

/**
 * Who is asking: any dsh `Agent` fits. Only what the log needs is read: its `id` (the session id) and whether it is a
 * child, which `isTopLevelAgent` decides.
 */
export type JudgeAgent = AgentLike & { readonly id?: unknown }

export interface JudgeRequest {
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
}

export type JudgeResult =
  | { ok: true, answers: Record<string, Answer>, latencyMs: number }
  | { ok: false, reason: 'unavailable' | 'invalid', message: string }

/**
 * Where Jev stands, from the last 100 calls.
 *
 * `p50` and `p95` are the latencies of the last 100 calls that **returned answers**: a failed call (a timeout, an error
 * status, a malformed answer) is not counted, so the figures say how fast Jev is when it works, not how long a failure
 * took. They are `null` until there is such a call.
 */
export interface JudgeStatus {
  /** Whether there is a usable key now. */
  keySet: boolean
  /**
   * `no-key` without a key. Otherwise `unavailable` while Jev is being skipped (a `429` or `529`) or when the last call that
   * was sent got no answers (a `400` or `422` is that too), and `ok` if not, including before any call.
   */
  state: 'ok' | 'unavailable' | 'no-key'
  /** The message of the last call that was sent and got no answers; kept after a success, with `lastErrorAt`. */
  lastError?: string
  lastErrorAt?: number
  lastOkAt?: number
  p50: number | null
  p95: number | null
}

/** The `judge` service: one place that asks Jev, for the gates, the screen and `ask_judge`. */
export interface Judge {
  /**
   * One Jev call: one state, any number of typed questions. Never throws for a Jev failure: it returns `{ ok: false }`.
   * A request that is refused before it is sent (`invalid`) is not a failure of Jev and does not change the status.
   */
  ask(request: JudgeRequest): Promise<JudgeResult>
  /**
   * The status now. It is asynchronous because whether there is a key is looked up afresh (the key is only ever held for
   * the length of a call); it never calls Jev.
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
 * One line of the decision log, as the spec's "The log" has it. The client writes one for every call it handles, with
 * `decision: null`: it knows what Jev said and how long it took, not what the caller did about it.
 */
export interface LogLine {
  /** When the call began, in ms since the epoch. */
  at: number
  purpose: Purpose
  /** The asking agent's session id, or `null` with no agent. */
  agent: string | null
  /** Whether the asker is a child: an agent that isn't plainly the main one counts as one. */
  child: boolean
  tool: string | null
  callId: string | null
  subject: string
  /** The checked answers, or `null` when there were none. */
  answers: Record<string, Answer> | null
  decision: string | null
  /** How long Jev took; `null` when it wasn't called. */
  latencyMs: number | null
  /** Why the call failed, with the key masked; `null` for an answer. */
  error: string | null
}

export interface JudgeDeps {
  /** The TypeSafe API, with no trailing slash needed: the call is `<baseUrl>/v1/systemone`. */
  baseUrl: string
  /** The key, looked up for every call and every status. Nothing, or blank, is no key. */
  key: () => Promise<string | undefined>
  /** The settings now: the model and the time limit. */
  settings: () => Promise<JudgeSettings>
  /** Where each call is recorded. It is called, never waited for, and may throw or reject: nothing comes of it. */
  log: (line: LogLine) => void | Promise<void>
  /** The clock, in ms since the epoch. For tests. */
  now?: () => number
}

/** The most of `state`, as JSON text in UTF-8: Jev's own limit is 32k tokens for `state` and the longest question. */
export const MAX_STATE_BYTES = 100 * 1024

/** How many answered calls the latencies are over. */
const LATENCY_WINDOW = 100
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
/** A choice's option: letters, digits and underscores, with spaces and hyphens after the first character, up to 64 in all. */
const CHOICE_OPTION = /^[A-Za-z0-9_][A-Za-z0-9_ -]{0,63}$/
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

type Checked<T> = { ok: true, value: T } | { ok: false, message: string }

const bad = (message: string): { ok: false, message: string } => ({ ok: false, message })

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
      const described: Record<string, string | null> = {}
      for (const option of options) {
        if (!CHOICE_OPTION.test(option) || option === '__proto__') {
          return bad(`question ${name}: option ${JSON.stringify(option.length > 40 ? `${option.slice(0, 40)}…` : option)} is not allowed: options are 1–64 characters of letters, digits, _, - and spaces, not starting with a space or -`)
        }
        const description = criteria[option]
        if (description !== null && !isText(description)) return bad(`question ${name}: the description of option ${JSON.stringify(option)} must be a non-empty string or null`)
        described[option] = description
      }
      wire[id] = { type, instructions, criteria: described }
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
  if (typeof state === 'string' && state.length > MAX_STATE_BYTES) return bad(tooBig(state.length))
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
  if (bytes > MAX_STATE_BYTES) return bad(tooBig(bytes))
  return { ok: true, value: text }
}

function tooBig(bytes: number): string {
  return `state is ${Math.ceil(bytes / 1024)} KB of JSON and the most is 100 KB: send the part that matters`
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

/** A function that hides every form of `key` in a text: as it is, JSON-escaped, and URL-encoded. */
function maskerFor(key: string): (text: string) => string {
  const forms = [...new Set([key, JSON.stringify(key).slice(1, -1), encodeURIComponent(key)])].sort((a, b) => b.length - a.length)
  return text => forms.reduce((masked, form) => masked.split(form).join(MASKED), text)
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
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value) },
      (error: unknown) => { signal.removeEventListener('abort', onAbort); reject(error) },
    )
  })
}

/** `nearest-rank` percentile of an ascending list. */
function percentile(sorted: readonly number[], p: number): number {
  return sorted[Math.max(0, Math.ceil(p * sorted.length / 100) - 1)]!
}

/**
 * What a call came to, before it is logged and turned into a result. `effect` says what it means for the status:
 * `failed` for a call that was sent and got no answers (or could not be sent for a reason that is Jev's side of things:
 * a key it can't use, a time out), `none` for one that says nothing about Jev (a request refused as written, no key, a
 * cancel, a call skipped in a back-off).
 */
type Outcome =
  | { kind: 'answers', answers: Record<string, Answer>, latencyMs: number }
  | { kind: 'failure', reason: 'unavailable' | 'invalid', message: string, effect: 'failed' | 'none', latencyMs: number | null }

function failure(reason: 'unavailable' | 'invalid', message: string, effect: 'failed' | 'none', latencyMs: number | null = null): Outcome {
  return { kind: 'failure', reason, message, effect, latencyMs }
}

/** What goes with one call while it runs: how to hide the key once there is one. */
interface Scope {
  mask: (text: string) => string
}

export function createJudge(deps: JudgeDeps): Judge {
  const now = deps.now ?? Date.now
  const endpoint = `${deps.baseUrl.replace(/\/+$/, '')}/v1/systemone`

  /** The latencies of the last answered calls, oldest first. */
  const latencies: number[] = []
  /** Jev is out of use until this time: a `429` or `529` said so. */
  let skipUntil = 0
  let lastFailed = false
  let lastOkAt: number | undefined
  let lastError: string | undefined
  let lastErrorAt: number | undefined

  /** The call itself, up to what it came to. It may throw only for a mistake in this file. */
  async function run(request: JudgeRequest, scope: Scope): Promise<Outcome> {
    const questions = checkQuestions(request.questions)
    if (!questions.ok) return failure('invalid', questions.message, 'none')
    const state = checkState(request.state)
    if (!state.ok) return failure('invalid', state.message, 'none')
    if (request.signal?.aborted) return failure('unavailable', CANCELLED, 'none')

    // A call in a back-off is answered before anything else is looked up.
    const waiting = skipUntil - now()
    if (waiting > 0) {
      return failure('unavailable', `TypeSafe asked for a pause: skipping the judge for another ${Math.ceil(waiting / 1000)} s`, 'none')
    }

    let settings: JudgeSettings
    try {
      settings = await deps.settings()
    } catch {
      return failure('unavailable', 'could not read the judge settings', 'failed')
    }

    // From here on the whole call has `timeoutMs`: the key lookup too, so a credential store that hangs can't hang a gate.
    const timeout = AbortSignal.timeout(settings.timeoutMs)
    const signal = request.signal === undefined ? timeout : AbortSignal.any([request.signal, timeout])
    const timedOut = (what: string, latencyMs: number | null = null) => failure('unavailable', `${what} timed out after ${settings.timeoutMs} ms`, 'failed', latencyMs)

    let key: string | undefined
    try {
      key = cleanKey(await untilAborted(Promise.resolve().then(deps.key), signal))
    } catch {
      if (request.signal?.aborted) return failure('unavailable', CANCELLED, 'none')
      if (timeout.aborted) return timedOut('reading the TypeSafe key')
      // What the credential store said is not repeated: it may be a line of the file the key is in.
      return failure('unavailable', 'could not read the TypeSafe key from the credential store', 'failed')
    }
    if (key === undefined) return failure('unavailable', NO_KEY, 'none')
    if (!HEADER_SAFE.test(key)) {
      return failure('unavailable', 'the TypeSafe key has characters that can\'t be sent in a header: set it again on Settings → Judge', 'failed')
    }
    scope.mask = maskerFor(key)

    const body = `{"model":${JSON.stringify(settings.model)},"state":${state.value},"questions":${JSON.stringify(questions.value)}}`
    const started = now()
    let status: number
    let retryAfter: string | null
    let text = ''
    let truncated = false
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body,
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
      const latencyMs = now() - started
      if (request.signal?.aborted) return failure('unavailable', CANCELLED, 'none', latencyMs)
      if (timeout.aborted) return timedOut('the call to TypeSafe', latencyMs)
      return failure('unavailable', `could not reach TypeSafe: ${describeNetworkError(error)}`, 'failed', latencyMs)
    }
    const latencyMs = now() - started

    /** The start of an error body, with the key hidden first, whitespace made plain and the whole cut to 200 characters. */
    const excerpt = (): string => {
      const flat = scope.mask(refusalText(text)).replace(/[\s\x00-\x1f\x7f]+/g, ' ').trim()
      return flat.length > EXCERPT_CHARS ? `${flat.slice(0, EXCERPT_CHARS - 1)}…` : flat
    }
    const detail = (): string => {
      const shown = excerpt()
      return shown === '' ? '' : `: ${shown}`
    }

    if (status === 401) return failure('unavailable', 'the TypeSafe key was refused', 'failed', latencyMs)
    if (status === 429 || status === 529) {
      const pause = backOffMs(retryAfter, now())
      skipUntil = Math.max(skipUntil, now() + pause)
      const why = status === 429 ? 'is rate-limiting the judge' : 'is overloaded'
      return failure('unavailable', `TypeSafe ${why} (HTTP ${status}): skipping it for ${Math.ceil(pause / 1000)} s`, 'failed', latencyMs)
    }
    // TypeSafe says 422 for a request that fails its schema and 400 for one its own rules refuse (an unknown model, too many
    // score levels, too many tokens): either way the request, as written, is what it won't take.
    if (status === 400 || status === 422) return failure('invalid', `TypeSafe refused the request (HTTP ${status})${detail()}`, 'failed', latencyMs)
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

  /** Record the call in the status and the log, and make the result. */
  function settle(request: JudgeRequest, at: number, outcome: Outcome, scope: Scope): JudgeResult {
    const agentId = request.agent?.id
    const line: LogLine = {
      at,
      purpose: request.purpose,
      agent: typeof agentId === 'string' ? agentId : typeof agentId === 'number' ? String(agentId) : null,
      child: request.agent !== undefined && !isTopLevelAgent(request.agent),
      tool: typeof request.tool === 'string' ? request.tool : null,
      callId: typeof request.callId === 'string' ? request.callId : null,
      subject: scope.mask(typeof request.subject === 'string' ? request.subject : ''),
      answers: null,
      decision: null,
      latencyMs: outcome.latencyMs,
      error: null,
    }
    let result: JudgeResult
    if (outcome.kind === 'answers') {
      latencies.push(outcome.latencyMs)
      if (latencies.length > LATENCY_WINDOW) latencies.shift()
      lastFailed = false
      lastOkAt = now()
      line.answers = structuredClone(outcome.answers)
      result = { ok: true, answers: outcome.answers, latencyMs: outcome.latencyMs }
    } else {
      const message = scope.mask(outcome.message)
      if (outcome.effect === 'failed') {
        lastFailed = true
        lastError = message
        lastErrorAt = now()
      }
      line.error = message
      result = { ok: false, reason: outcome.reason, message }
    }
    try {
      Promise.resolve(deps.log(line)).catch(() => {})
    } catch {
      // A log that can't be written to is not a reason to fail a call.
    }
    return result
  }

  return {
    async ask(request) {
      const at = now()
      const scope: Scope = { mask: text => text }
      let outcome: Outcome
      try {
        outcome = await run(request, scope)
      } catch (error) {
        outcome = failure('unavailable', `the judge failed unexpectedly: ${describe(error)}`, 'failed')
      }
      return settle(request, at, outcome, scope)
    },

    async status() {
      let keySet = false
      try {
        keySet = cleanKey(await deps.key()) !== undefined
      } catch {
        // Not a key we can use.
      }
      const sorted = [...latencies].sort((a, b) => a - b)
      return {
        keySet,
        state: !keySet ? 'no-key' : lastFailed || skipUntil > now() ? 'unavailable' : 'ok',
        ...lastError === undefined ? {} : { lastError },
        ...lastErrorAt === undefined ? {} : { lastErrorAt },
        ...lastOkAt === undefined ? {} : { lastOkAt },
        p50: sorted.length === 0 ? null : percentile(sorted, 50),
        p95: sorted.length === 0 ? null : percentile(sorted, 95),
      }
    },
  }
}
