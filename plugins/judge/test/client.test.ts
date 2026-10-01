import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { createJudge } from '../src/client.ts'
import type { Judge, JudgeResult, JudgeStatus, LogLine, Question } from '../src/client.ts'
import { DEFAULT_SETTINGS } from '../src/settings.ts'
import {
  choiceAnswer, jevBody, mountJudge, noulAnswer, provideStub, scoreAnswer, startFakeJev, tempDir,
} from './helpers.ts'
import type { Behaviour, FakeJev, RecordedRequest } from './helpers.ts'

/** A key nobody would write by accident, so finding it in any output is a leak. */
const KEY = 'tsk-CANARY-5f3a9c1e7b2d4a68'

const SERVES_TASK: Question = {
  type: 'noul',
  instructions: 'Is running `command` a reasonable step toward `task`?',
}
const EFFECT: Question = {
  type: 'choice',
  instructions: 'What would running `command` from `cwd` do to files, systems and data?',
  criteria: { read_only: 'it only reads or reports', reversible: 'git or rerunning can undo it', irreversible: 'it can\'t be undone', other: null },
}
const RISK: Question = {
  type: 'score',
  instructions: 'How risky is `command`?',
  criteria: ['no risk', 'some risk', 'a lot of risk'],
}
const QUESTIONS = { serves_task: SERVES_TASK, effect: EFFECT, risk: RISK }

/** What Jev says to QUESTIONS when all is well. */
const GOOD = {
  serves_task: noulAnswer(0.91),
  effect: choiceAnswer('read_only', { read_only: 0.88, reversible: 0.1, irreversible: 0.01, other: 0.01 }, 0.81),
  risk: scoreAnswer(1.05, { 0: 0, 1: 0.95, 2: 0.05 }, 0.92),
}

interface Rig {
  judge: Judge
  jev: FakeJev
  /** The lines the client logged, as they were when it logged them. */
  lines: LogLine[]
  /** How many times the key was asked for. */
  keyCalls: () => number
  ask(overrides?: Record<string, unknown>): Promise<JudgeResult>
}

interface RigOptions {
  key?: () => Promise<string | undefined>
  timeoutMs?: number
  now?: () => number
  log?: (line: LogLine) => void | Promise<void>
  /** Added to the fake Jev's address, as a base URL with a path. */
  prefix?: string
}

async function rig(options: RigOptions = {}): Promise<Rig> {
  const jev = await startFakeJev()
  const lines: LogLine[] = []
  let keyCalls = 0
  const keyOf = options.key ?? (async () => KEY)
  const judge = createJudge({
    baseUrl: jev.url + (options.prefix ?? ''),
    key: async () => { keyCalls++; return keyOf() },
    settings: async () => ({ ...DEFAULT_SETTINGS, timeoutMs: options.timeoutMs ?? DEFAULT_SETTINGS.timeoutMs }),
    log: options.log ?? ((line) => { lines.push(structuredClone(line)) }),
    ...options.now === undefined ? {} : { now: options.now },
  })
  return {
    judge, jev, lines, keyCalls: () => keyCalls,
    ask: (overrides = {}) => judge.ask({ state: { command: 'ls', cwd: '/work' }, questions: QUESTIONS, purpose: 'command', ...overrides } as never),
  }
}

/** The answers of a call that must have succeeded. */
function answersOf(result: JudgeResult) {
  assert.equal(result.ok, true, result.ok ? '' : `expected success, got ${result.reason}: ${result.message}`)
  if (!result.ok) throw new Error('unreachable')
  return result
}

/** The failure of a call that must have failed. */
function failureOf(result: JudgeResult, reason: 'unavailable' | 'invalid' = 'unavailable') {
  assert.equal(result.ok, false, 'expected a failure')
  if (result.ok) throw new Error('unreachable')
  assert.equal(result.reason, reason, result.message)
  return result
}

const ok = (answers: Record<string, unknown> = GOOD): Behaviour => ({ kind: 'answer', body: jevBody(answers) })

// --- the request ----------------------------------------------------------------------------------

test('a call is one POST to /v1/systemone with the key as a bearer token and { model, state, questions } as the body', async () => {
  const r = await rig()
  r.jev.queue(ok())
  const state = { command: 'git status', cwd: '/work', task: 'fix the build' }
  const result = answersOf(await r.ask({ state }))
  assert.equal(r.jev.requests.length, 1)
  const request = r.jev.requests[0]!
  assert.equal(request.method, 'POST')
  assert.equal(request.path, '/v1/systemone')
  assert.equal(request.headers.authorization, `Bearer ${KEY}`)
  assert.match(String(request.headers['content-type']), /^application\/json/)
  assert.deepEqual(request.json, { model: DEFAULT_SETTINGS.model, state, questions: QUESTIONS })
  assert.deepEqual(Object.keys(request.json), ['model', 'state', 'questions'])
  assert.equal(typeof result.latencyMs, 'number')
})

test('the model on the wire is the one in the settings now', async () => {
  const jev = await startFakeJev()
  let model = 'jev-1.13.0'
  const judge = createJudge({
    baseUrl: jev.url,
    key: async () => KEY,
    settings: async () => ({ ...DEFAULT_SETTINGS, model }),
    log: () => {},
  })
  const request = { state: 's', questions: { q: SERVES_TASK }, purpose: 'ask' } as const
  const body = jevBody({ q: noulAnswer(0.5) })
  jev.always({ kind: 'answer', body })
  answersOf(await judge.ask(request))
  model = 'jev-2.0.0'
  answersOf(await judge.ask(request))
  assert.deepEqual(jev.requests.map(r => r.json.model), ['jev-1.13.0', 'jev-2.0.0'])
})

test('a base URL with a path keeps it, and a trailing slash is not doubled', async () => {
  for (const [prefix, path] of [['/api', '/api/v1/systemone'], ['/api/', '/api/v1/systemone']] as const) {
    const r = await rig({ prefix })
    r.jev.queue(ok())
    answersOf(await r.ask())
    assert.equal(r.jev.requests[0]!.path, path)
  }
})

test('the state may be a string, an object or an array', async () => {
  const r = await rig()
  r.jev.always(ok())
  for (const state of ['plain text', { a: 1 }, ['x', { b: [2] }]]) answersOf(await r.ask({ state }))
  assert.deepEqual(r.jev.requests.map(request => request.json.state), ['plain text', { a: 1 }, ['x', { b: [2] }]])
})

test('only the known fields of a question go on the wire', async () => {
  const r = await rig()
  r.jev.queue(ok({ a: noulAnswer(0.4) }))
  const questions = { a: { type: 'noul', instructions: 'Is it?', criteria: { true: 'yes', false: 'no' }, extra: 'dropped', weight: 3 } }
  answersOf(await r.ask({ questions }))
  assert.deepEqual(r.jev.requests[0]!.json.questions, { a: { type: 'noul', instructions: 'Is it?', criteria: { true: 'yes', false: 'no' } } })
})

test('the key is resolved on every call and never kept: a changed key reaches the next call', async () => {
  const jev = await startFakeJev()
  jev.always({ kind: 'answer', body: jevBody({ q: noulAnswer(0.5) }) })
  let current: string | undefined = 'key-one-aaaa'
  let calls = 0
  const judge = createJudge({
    baseUrl: jev.url,
    key: async () => { calls++; return current },
    settings: async () => DEFAULT_SETTINGS,
    log: () => {},
  })
  const request = { state: 's', questions: { q: SERVES_TASK }, purpose: 'ask' } as const
  answersOf(await judge.ask(request))
  current = 'key-two-bbbb'
  answersOf(await judge.ask(request))
  assert.equal(calls, 2)
  assert.deepEqual(jev.requests.map(r => r.headers.authorization), ['Bearer key-one-aaaa', 'Bearer key-two-bbbb'])
  current = undefined
  failureOf(await judge.ask(request))
  assert.equal(jev.requests.length, 2, 'with the key gone, nothing was sent')
})

test('the answers come back typed, with the latency of the exchange', async () => {
  let t = 5_000
  const r = await rig({ now: () => t })
  r.jev.queue({ kind: 'answer', body: () => { t += 137; return jevBody(GOOD) } })
  const result = answersOf(await r.ask())
  assert.equal(result.latencyMs, 137)
  assert.deepEqual(result.answers, {
    serves_task: { type: 'noul', noul: 0.91 },
    effect: { type: 'choice', choice: 'read_only', probabilities: { read_only: 0.88, reversible: 0.1, irreversible: 0.01, other: 0.01 }, confidence: 0.81 },
    risk: { type: 'score', score: 1.05, probabilities: { 0: 0, 1: 0.95, 2: 0.05 }, confidence: 0.92 },
  })
})

test('an answer to a question that wasn\'t asked is dropped, and fields Jev adds are ignored', async () => {
  const r = await rig()
  r.jev.queue({ kind: 'answer', body: { ...jevBody({ q: { type: 'noul', noul: 0.3, note: 'extra' }, ghost: noulAnswer(1) }), cost: 1 } })
  const result = answersOf(await r.ask({ questions: { q: SERVES_TASK } }))
  assert.deepEqual(result.answers, { q: { type: 'noul', noul: 0.3 } })
})

test('question ids that are also names on Object.prototype are answered as any other', async () => {
  const r = await rig()
  r.jev.queue(ok({ constructor: noulAnswer(0.2), tostring: noulAnswer(0.4) }))
  const result = answersOf(await r.ask({ questions: { constructor: SERVES_TASK, tostring: SERVES_TASK } }))
  const id: string = 'constructor'
  assert.equal(Object.hasOwn(result.answers, id), true)
  assert.deepEqual(result.answers[id], { type: 'noul', noul: 0.2 })
  // and one that isn't answered is missing, not inherited
  r.jev.queue(ok({ tostring: noulAnswer(0.4) }))
  failureOf(await r.ask({ questions: { constructor: SERVES_TASK, tostring: SERVES_TASK } }))
})

// --- the statuses ---------------------------------------------------------------------------------

test('401 is unavailable: the key was refused', async () => {
  const r = await rig()
  r.jev.queue({ kind: 'status', status: 401, body: '{"error":"bad key"}' })
  const failure = failureOf(await r.ask())
  assert.equal(failure.message, 'the TypeSafe key was refused')
  assert.equal((await r.judge.status()).state, 'unavailable')
})

test('422 is invalid, with the body\'s text trimmed to 200 characters', async () => {
  const r = await rig()
  r.jev.queue({ kind: 'status', status: 422, body: '  \n {"detail":"questions.effect.criteria: expected at most 255 options"}\n\n ' })
  const failure = failureOf(await r.ask(), 'invalid')
  assert.match(failure.message, /questions\.effect\.criteria: expected at most 255 options/)
  assert.doesNotMatch(failure.message, /\n/)

  r.jev.queue({ kind: 'status', status: 422, body: `{"detail":"${'x'.repeat(5000)}"}` })
  const long = failureOf(await r.ask(), 'invalid')
  const excerpt = long.message.slice(long.message.indexOf('): ') + 3)
  assert.equal(excerpt.length, 200)
  assert.ok(excerpt.endsWith('…'))
  assert.ok(long.message.length < 300)
})

test('400 is invalid too, as TypeSafe uses it for requests its own rules refuse, and its JSON bodies are read for their words', async () => {
  const r = await rig()
  const refused = (status: number, body: string) => { r.jev.queue({ kind: 'status', status, body }) }

  refused(400, '{"detail":{"error_type":"api_usage_error","message":"Unknown model: jev-9"}}')
  let failure = failureOf(await r.ask(), 'invalid')
  assert.equal(failure.message, 'TypeSafe refused the request (HTTP 400): Unknown model: jev-9')

  refused(400, '{"detail":"Too many score levels. Must have at most 10 levels."}')
  failure = failureOf(await r.ask(), 'invalid')
  assert.equal(failure.message, 'TypeSafe refused the request (HTTP 400): Too many score levels. Must have at most 10 levels.')

  refused(400, '{"detail":{"error_type":"max_tokens_exceeded"}}')
  failure = failureOf(await r.ask(), 'invalid')
  assert.equal(failure.message, 'TypeSafe refused the request (HTTP 400): max_tokens_exceeded')

  refused(400, 'plain text')
  assert.equal(failureOf(await r.ask(), 'invalid').message, 'TypeSafe refused the request (HTTP 400): plain text')
  assert.equal(r.jev.requests.length, 4, 'no retries')
})

test('a 422 from the schema check lists where and why, and leaves out the input TypeSafe echoes (which can be the state)', async () => {
  const r = await rig()
  const secret = 'rm -rf /home/someone/private-notes'
  r.jev.queue({
    kind: 'status',
    status: 422,
    body: JSON.stringify({
      detail: [
        { type: 'missing', loc: ['body', 'model'], msg: 'Field required', input: { state: secret, questions: {} } },
        { type: 'too_short', loc: ['body', 'questions'], msg: 'Dictionary should have at least 1 item', input: {}, ctx: { min_length: 1 } },
      ],
    }),
  })
  const failure = failureOf(await r.ask({ state: secret }), 'invalid')
  assert.equal(failure.message, 'TypeSafe refused the request (HTTP 422): model: Field required; questions: Dictionary should have at least 1 item')
  assert.doesNotMatch(failure.message, /private-notes/)
  assert.doesNotMatch(JSON.stringify(r.lines), /private-notes/)
})

test('429 and 529 are unavailable and keep Jev skipped until retry-after (seconds) passes', async () => {
  for (const status of [429, 529]) {
    let t = 1_000_000
    const r = await rig({ now: () => t })
    r.jev.queue({ kind: 'status', status, headers: { 'retry-after': '3' } }, ok())
    failureOf(await r.ask())
    assert.equal(r.jev.requests.length, 1)

    t += 2_999
    const skipped = failureOf(await r.ask())
    assert.equal(r.jev.requests.length, 1, 'while skipping, fetch is not called')
    assert.match(skipped.message, /skipp/)

    t += 1
    answersOf(await r.ask())
    assert.equal(r.jev.requests.length, 2, 'once retry-after has passed, Jev is called again')
  }
})

test('retry-after: seconds or an HTTP date, clamped to 1 s .. 60 s, 5 s when absent or unreadable', async () => {
  const start = 1_000_000
  const cases: Array<[string, Record<string, string>, number]> = [
    ['absent', {}, 5_000],
    ['seconds', { 'retry-after': '12' }, 12_000],
    ['fractional seconds', { 'retry-after': '2.5' }, 2_500],
    ['zero is raised to 1 s', { 'retry-after': '0' }, 1_000],
    ['half a second is raised to 1 s', { 'retry-after': '0.5' }, 1_000],
    ['an hour is lowered to 60 s', { 'retry-after': '3600' }, 60_000],
    ['an HTTP date', { 'retry-after': new Date(start + 20_000).toUTCString() }, 20_000],
    ['an HTTP date in the past is raised to 1 s', { 'retry-after': new Date(start - 90_000).toUTCString() }, 1_000],
    ['an HTTP date far ahead is lowered to 60 s', { 'retry-after': new Date(start + 86_400_000).toUTCString() }, 60_000],
    ['garbage', { 'retry-after': 'soon' }, 5_000],
    ['a negative number', { 'retry-after': '-1' }, 5_000],
    ['empty', { 'retry-after': '' }, 5_000],
  ]
  for (const [label, headers, wait] of cases) {
    let t = start
    const r = await rig({ now: () => t })
    r.jev.queue({ kind: 'status', status: 429, headers }, ok(), ok())
    failureOf(await r.ask())
    t = start + wait - 1
    failureOf(await r.ask())
    assert.equal(r.jev.requests.length, 1, `${label}: still skipping 1 ms early`)
    t = start + wait
    answersOf(await r.ask())
    assert.equal(r.jev.requests.length, 2, `${label}: calls go through after ${wait} ms`)
  }
})

test('every other non-2xx status is unavailable, with the status and a trimmed body in the message', async () => {
  for (const status of [403, 404, 500, 502, 503]) {
    const r = await rig()
    r.jev.queue({ kind: 'status', status, body: `upstream said no ${status}` })
    const failure = failureOf(await r.ask())
    assert.match(failure.message, new RegExp(String(status)))
    assert.match(failure.message, /upstream said no/)
    assert.equal(r.jev.requests.length, 1, 'no retries inside a call')
  }
})

test('a redirect is refused, not followed, and the key goes nowhere else', async () => {
  const r = await rig()
  r.jev.queue({ kind: 'status', status: 302, headers: { location: '/elsewhere' } })
  const failure = failureOf(await r.ask())
  assert.match(failure.message, /redirect/i)
  assert.deepEqual(r.jev.requests.map(request => request.path), ['/v1/systemone'])
})

test('a dropped connection is unavailable', async () => {
  const r = await rig()
  r.jev.queue({ kind: 'drop' })
  const failure = failureOf(await r.ask())
  assert.match(failure.message, /reach|connection|fetch failed/i)
  assert.equal(r.jev.requests.length, 1, 'no retries inside a call')
})

test('a server that isn\'t there is unavailable', async () => {
  const jev = await startFakeJev()
  const url = jev.url
  await jev.close()
  const judge = createJudge({ baseUrl: url, key: async () => KEY, settings: async () => DEFAULT_SETTINGS, log: () => {} })
  failureOf(await judge.ask({ state: 's', questions: { q: SERVES_TASK }, purpose: 'ask' }))
})

// --- the time limit and cancelling ----------------------------------------------------------------

test('a call finishes near timeoutMs when Jev is slow, and says it timed out', async () => {
  const r = await rig({ timeoutMs: 150 })
  r.jev.queue({ kind: 'answer', body: jevBody(GOOD), delayMs: 3_000 })
  const started = performance.now()
  const failure = failureOf(await r.ask())
  const elapsed = performance.now() - started
  assert.match(failure.message, /timed out after 150 ms/)
  assert.ok(elapsed >= 140, `finished too early: ${elapsed} ms`)
  assert.ok(elapsed < 150 + 400, `finished too late: ${elapsed} ms`)
  assert.equal((await r.judge.status()).state, 'unavailable')
})

test('the time limit covers a key lookup that never answers', async () => {
  const r = await rig({ timeoutMs: 150, key: () => new Promise<string | undefined>(() => {}) })
  const started = performance.now()
  const failure = failureOf(await r.ask())
  assert.ok(performance.now() - started < 150 + 400)
  assert.match(failure.message, /timed out/)
  assert.equal(r.jev.requests.length, 0)
})

test('a signal that is already cancelled gives unavailable without calling Jev or looking for the key', async () => {
  const r = await rig()
  const failure = failureOf(await r.ask({ signal: AbortSignal.abort() }))
  assert.match(failure.message, /cancel/)
  assert.equal(r.jev.requests.length, 0)
  assert.equal(r.keyCalls(), 0)
})

test('cancelling during the call ends it at once, and says nothing about Jev being down', async () => {
  const r = await rig({ timeoutMs: 5_000 })
  r.jev.queue(ok(), { kind: 'answer', body: jevBody(GOOD), delayMs: 3_000 })
  answersOf(await r.ask())
  
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 50)
  const started = performance.now()
  const failure = failureOf(await r.ask({ signal: controller.signal }))
  assert.ok(performance.now() - started < 1_000)
  assert.match(failure.message, /cancel/)
  const status = await r.judge.status()
  assert.equal(status.state, 'ok', 'a cancel isn\'t a failure of Jev')
  assert.equal(status.lastError, undefined)
})

// --- the key --------------------------------------------------------------------------------------

test('with no key the call is unavailable with the spec\'s message, and Jev is not called', async () => {
  for (const key of [undefined, '', '   \n']) {
    const r = await rig({ key: async () => key })
    const failure = failureOf(await r.ask())
    assert.equal(failure.message, 'no TypeSafe key: set it on Settings → Judge')
    assert.equal(r.jev.requests.length, 0)
    const status = await r.judge.status()
    assert.equal(status.keySet, false)
    assert.equal(status.state, 'no-key')
  }
})

test('a key lookup that throws is unavailable, and what it threw is not repeated', async () => {
  const r = await rig({ key: async () => { throw new Error('credential file says: hunter2') } })
  const failure = failureOf(await r.ask())
  assert.match(failure.message, /could not read the TypeSafe key/)
  assert.doesNotMatch(failure.message, /hunter2/)
  assert.equal(r.jev.requests.length, 0)
})

test('a key that can\'t go in a header is unavailable, and not sent', async () => {
  for (const key of ['two words', 'new\nline', 'naïve-key', `tab\there`]) {
    const r = await rig({ key: async () => key })
    const failure = failureOf(await r.ask())
    assert.match(failure.message, /can't be sent|cannot be sent/)
    assert.equal(r.jev.requests.length, 0)
    assert.doesNotMatch(JSON.stringify([failure, r.lines]), /naïve|two words/)
  }
})

test('a key with spaces around it is trimmed', async () => {
  const r = await rig({ key: async () => `  ${KEY}\n` })
  r.jev.queue(ok())
  answersOf(await r.ask())
  assert.equal(r.jev.requests[0]!.headers.authorization, `Bearer ${KEY}`)
})

// --- malformed answers ----------------------------------------------------------------------------

/** A good answer to QUESTIONS, changed by `change`. */
function bodyWith(change: (answers: Record<string, any>) => void): unknown {
  const answers = structuredClone(GOOD) as Record<string, any>
  change(answers)
  return jevBody(answers)
}

const MALFORMED: Array<[string, unknown, RegExp]> = [
  ['an answer is missing', bodyWith(a => { delete a.risk }), /risk/],
  ['an answer is of the wrong type', bodyWith(a => { a.serves_task = choiceAnswer('read_only', { read_only: 1 }) }), /serves_task/],
  ['an answer has the shape of the right type but is labelled another', bodyWith(a => { a.effect.type = 'score' }), /effect/],
  ['a noul is above 1', bodyWith(a => { a.serves_task = noulAnswer(1.2) }), /serves_task/],
  ['a noul is below 0', bodyWith(a => { a.serves_task = noulAnswer(-0.1) }), /serves_task/],
  ['a noul is a string', bodyWith(a => { a.serves_task = { type: 'noul', noul: '0.9' } }), /serves_task/],
  ['a noul is missing', bodyWith(a => { a.serves_task = { type: 'noul' } }), /serves_task/],
  ['probabilities sum to well under 1', bodyWith(a => { a.effect.probabilities = { read_only: 0.5, reversible: 0.1, irreversible: 0.01, other: 0.01 } }), /effect/],
  ['probabilities sum to well over 1', bodyWith(a => { a.effect.probabilities = { read_only: 0.9, reversible: 0.5, irreversible: 0.01, other: 0.01 } }), /effect/],
  ['probabilities sum to 1.03', bodyWith(a => { a.effect.probabilities = { read_only: 0.9, reversible: 0.125, irreversible: 0.004, other: 0.001 } }), /effect/],
  ['probabilities sum to 0.97', bodyWith(a => { a.effect.probabilities = { read_only: 0.9, reversible: 0.065, irreversible: 0.004, other: 0.001 } }), /effect/],
  ['a probability is outside 0..1', bodyWith(a => { a.effect.probabilities = { read_only: 1.4, reversible: -0.4, irreversible: 0, other: 0 } }), /effect/],
  ['a probability key is missing', bodyWith(a => { a.effect.probabilities = { read_only: 0.9, reversible: 0.1, irreversible: 0 } }), /effect/],
  ['a probability key is extra', bodyWith(a => { a.effect.probabilities = { read_only: 0.8, reversible: 0.1, irreversible: 0.05, other: 0.04, odd: 0.01 } }), /effect/],
  ['a probability key is not a declared one', bodyWith(a => { a.effect.probabilities = { read_only: 0.8, reversible: 0.1, irreversible: 0.05, wrong: 0.05 } }), /effect/],
  ['the probabilities are missing', bodyWith(a => { delete a.effect.probabilities }), /effect/],
  ['the confidence is missing', bodyWith(a => { delete a.effect.confidence }), /effect/],
  ['the confidence is above 1', bodyWith(a => { a.effect.confidence = 1.5 }), /effect/],
  ['a choice is not one of its keys', bodyWith(a => { a.effect.choice = 'delete_everything' }), /effect/],
  ['a choice is not a string', bodyWith(a => { a.effect.choice = 3 }), /effect/],
  ['a choice names something every object has', bodyWith(a => { a.effect.choice = 'constructor' }), /effect/],
  ['a score is above its range', bodyWith(a => { a.risk.score = 2.5 }), /risk/],
  ['a score is below 0', bodyWith(a => { a.risk.score = -0.2 }), /risk/],
  ['a score is not a number', bodyWith(a => { a.risk.score = null }), /risk/],
  ['score probabilities have the wrong number of levels', bodyWith(a => { a.risk.probabilities = { 0: 0.5, 1: 0.5 } }), /risk/],
  ['score probabilities are keyed by something else', bodyWith(a => { a.risk.probabilities = { low: 0, mid: 0.95, high: 0.05 } }), /risk/],
  ['the envelope has no answers', { model: 'jev-1.13.0' }, /answers/],
  ['the answers are a list', { model: 'jev-1.13.0', answers: [] }, /answers/],
  ['the body is a list', [], /answers/],
  ['the body is a number', 42, /answers/],
  ['the body is null', null, /answers/],
]

test('a malformed answer is unavailable, and says which question and what was wrong', async () => {
  const r = await rig()
  let sent = 0
  for (const [label, body, mentions] of MALFORMED) {
    r.jev.queue({ kind: 'answer', body })
    const failure = failureOf(await r.ask())
    assert.match(failure.message, /malformed/i, label)
    assert.match(failure.message, mentions, label)
    assert.equal(r.jev.requests.length, ++sent, `${label}: no retry`)
    assert.equal((await r.judge.status()).state, 'unavailable', label)
  }
})

test('a body that isn\'t JSON, or is cut off, is unavailable', async () => {
  const r = await rig()
  for (const body of [undefined, '', 'not json at all', '{"answers": {"effect": ']) {
    r.jev.queue({ kind: 'malformed', ...body === undefined ? {} : { body } })
    const failure = failureOf(await r.ask())
    assert.match(failure.message, /malformed/i)
  }
})

test('probabilities that sum to 1 within 0.025, and a score at either end of its range, are fine', async () => {
  const r = await rig()
  for (const probabilities of [
    { read_only: 0.9, reversible: 0.115, irreversible: 0.004, other: 0.001 },   // 1.02
    { read_only: 0.9, reversible: 0.075, irreversible: 0.004, other: 0.001 },   // 0.98
    { read_only: 0.9, reversible: 0.12, irreversible: 0.004, other: 0.001 },    // 1.025: the edge counts
    { read_only: 0.9, reversible: 0.07, irreversible: 0.004, other: 0.001 },    // 0.975: so does this one
  ]) {
    r.jev.queue(ok({ ...GOOD, effect: choiceAnswer('read_only', probabilities) }))
    answersOf(await r.ask())
  }
  for (const score of [0, 2]) {
    r.jev.queue(ok({ ...GOOD, risk: scoreAnswer(score, { 0: 1, 1: 0, 2: 0 }) }))
    answersOf(await r.ask())
  }
})

// --- the questions are checked before anything is sent -------------------------------------------

const many = (count: number, make: (index: number) => [string, string | null]) => Object.fromEntries(Array.from({ length: count }, (_, i) => make(i)))
const BAD_QUESTIONS: Array<[string, Record<string, unknown>, RegExp]> = [
  ['no questions at all', {}, /at least one question/],
  ['an id with capitals', { Effect: SERVES_TASK }, /"Effect"/],
  ['an id that starts with a digit', { '1st': SERVES_TASK }, /"1st"/],
  ['an id with a hyphen', { 'a-b': SERVES_TASK }, /"a-b"/],
  ['an empty id', { '': SERVES_TASK }, /""/],
  ['a question that isn\'t an object', { q: 'is it?' }, /"q".*object/],
  ['a question that is null', { q: null }, /"q".*object/],
  ['an unknown type', { q: { type: 'rank', instructions: 'x' } }, /"q".*type/],
  ['no type', { q: { instructions: 'x' } }, /"q".*type/],
  ['empty instructions', { q: { type: 'noul', instructions: '' } }, /"q".*instructions/],
  ['blank instructions', { q: { type: 'noul', instructions: '  \n ' } }, /"q".*instructions/],
  ['instructions that aren\'t text', { q: { type: 'noul', instructions: { ask: 'x' } } }, /"q".*instructions/],
  ['noul criteria with the wrong keys', { q: { type: 'noul', instructions: 'x', criteria: { yes: 'a', no: 'b' } } }, /"q".*true.*false/],
  ['noul criteria with only true', { q: { type: 'noul', instructions: 'x', criteria: { true: 'a' } } }, /"q".*true.*false/],
  ['noul criteria with an extra key', { q: { type: 'noul', instructions: 'x', criteria: { true: 'a', false: 'b', maybe: 'c' } } }, /"q".*true.*false/],
  ['noul criteria that aren\'t text', { q: { type: 'noul', instructions: 'x', criteria: { true: 1, false: 'b' } } }, /"q"/],
  ['noul criteria that are a list', { q: { type: 'noul', instructions: 'x', criteria: ['a', 'b'] } }, /"q"/],
  ['a choice with no criteria', { q: { type: 'choice', instructions: 'x' } }, /"q".*criteria/],
  ['a choice with one option', { q: { type: 'choice', instructions: 'x', criteria: { a: null } } }, /"q".*2.*255/],
  ['a choice with 256 options', { q: { type: 'choice', instructions: 'x', criteria: many(256, i => [`o${i}`, null]) } }, /"q".*2.*255/],
  ['a choice option with a leading space', { q: { type: 'choice', instructions: 'x', criteria: { ' a': null, b: null } } }, /"q".*option/],
  ['a choice option with a dot', { q: { type: 'choice', instructions: 'x', criteria: { 'a.b': null, b: null } } }, /"q".*"a\.b"/],
  ['a choice option that is empty', { q: { type: 'choice', instructions: 'x', criteria: { '': null, b: null } } }, /"q".*option/],
  ['a choice option of 65 characters', { q: { type: 'choice', instructions: 'x', criteria: { ['a'.repeat(65)]: null, b: null } } }, /"q".*option/],
  ['a choice option called __proto__', { q: { type: 'choice', instructions: 'x', criteria: JSON.parse('{"__proto__": null, "b": null}') } }, /"q".*__proto__/],
  ['a choice description that isn\'t text or null', { q: { type: 'choice', instructions: 'x', criteria: { a: 3, b: null } } }, /"q".*"a"/],
  ['a choice with list criteria', { q: { type: 'choice', instructions: 'x', criteria: ['a', 'b'] } }, /"q".*criteria/],
  ['a score with no criteria', { q: { type: 'score', instructions: 'x' } }, /"q".*criteria/],
  ['a score with one level', { q: { type: 'score', instructions: 'x', criteria: ['only'] } }, /"q".*2.*10/],
  ['a score with 11 levels', { q: { type: 'score', instructions: 'x', criteria: Array.from({ length: 11 }, (_, i) => `level ${i}`) } }, /"q".*2.*10/],
  ['a score with an empty level', { q: { type: 'score', instructions: 'x', criteria: ['low', ''] } }, /"q".*level/],
  ['a score with a blank level', { q: { type: 'score', instructions: 'x', criteria: ['low', '  '] } }, /"q".*level/],
  ['a score level that isn\'t text', { q: { type: 'score', instructions: 'x', criteria: ['low', 4] } }, /"q".*level/],
  ['score criteria that are a map', { q: { type: 'score', instructions: 'x', criteria: { low: 'a', high: 'b' } } }, /"q".*criteria/],
]

test('a malformed question is invalid, names the question and the fix, and nothing is sent or asked of the key', async () => {
  for (const [label, questions, mentions] of BAD_QUESTIONS) {
    const r = await rig()
    r.jev.always(ok())
    const failure = failureOf(await r.ask({ questions }), 'invalid')
    assert.match(failure.message, mentions, label)
    assert.equal(r.jev.requests.length, 0, label)
    assert.equal(r.keyCalls(), 0, label)
    assert.equal(r.lines.length, 1, `${label}: it is logged`)
    assert.equal(r.lines[0]!.error, failure.message, label)
  }
})

test('255 choice options, 10 score levels, and the edge cases of a valid id and option are accepted', async () => {
  const r = await rig()
  const questions = {
    a: { type: 'choice', instructions: 'x', criteria: many(255, i => [`option ${i}`, i % 2 === 0 ? null : 'described']) },
    b: { type: 'score', instructions: 'x', criteria: Array.from({ length: 10 }, (_, i) => `level ${i}`) },
    c1_d: { type: 'choice', instructions: 'x', criteria: { _: null, '9 - x': 'ok', [`A${'z'.repeat(63)}`]: null } },
  }
  r.jev.queue(ok({
    a: choiceAnswer('option 0', Object.fromEntries(Array.from({ length: 255 }, (_, i) => [`option ${i}`, i === 0 ? 1 : 0]))),
    b: scoreAnswer(9, Object.fromEntries(Array.from({ length: 10 }, (_, i) => [String(i), i === 9 ? 1 : 0]))),
    c1_d: choiceAnswer('_', { _: 1, '9 - x': 0, [`A${'z'.repeat(63)}`]: 0 }),
  }))
  answersOf(await r.ask({ questions }))
})

test('the state must be a string, an object or an array, and no more than 100 KB of JSON', async () => {
  const r = await rig()
  r.jev.always(ok())
  for (const state of [42, true, null, undefined]) {
    failureOf(await r.ask({ state }), 'invalid')
  }
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  assert.match(failureOf(await r.ask({ state: cyclic }), 'invalid').message, /state/i)
  assert.match(failureOf(await r.ask({ state: { big: 10n } }), 'invalid').message, /state/i)
  assert.match(failureOf(await r.ask({ state: 'x'.repeat(100 * 1024 + 1) }), 'invalid').message, /100 KB/)
  assert.match(failureOf(await r.ask({ state: { text: 'é'.repeat(60_000) } }), 'invalid').message, /100 KB/)
  assert.equal(r.jev.requests.length, 0)

  // the limit is on the JSON text of the state, quotes and all
  const atLimit = 'x'.repeat(100 * 1024 - 2)
  r.jev.queue(ok())
  answersOf(await r.ask({ state: atLimit }))
  assert.equal(r.jev.requests.length, 1)
  assert.match(failureOf(await r.ask({ state: `${atLimit}x` }), 'invalid').message, /100 KB/)
})

// --- the status -----------------------------------------------------------------------------------

test('status before any call: the key is looked up, and nothing is known about Jev', async () => {
  const r = await rig()
  const status: JudgeStatus = await r.judge.status()
  assert.deepEqual(status, { keySet: true, state: 'ok', p50: null, p95: null })
  assert.equal(r.keyCalls(), 1)
  assert.equal(r.jev.requests.length, 0, 'asking for the status never calls Jev')

  const none = await rig({ key: async () => undefined })
  assert.deepEqual(await none.judge.status(), { keySet: false, state: 'no-key', p50: null, p95: null })
})

test('status follows the last call: ok after an answer, unavailable after a failure, with when and why', async () => {
  let t = 10_000
  const r = await rig({ now: () => t })
  r.jev.queue(ok(), { kind: 'status', status: 503, body: 'down' }, ok())

  answersOf(await r.ask())
  let status = await r.judge.status()
  assert.equal(status.state, 'ok')
  assert.equal(status.lastOkAt, 10_000)
  assert.equal(status.lastError, undefined)

  t = 20_000
  failureOf(await r.ask())
  status = await r.judge.status()
  assert.equal(status.state, 'unavailable')
  assert.match(status.lastError!, /503/)
  assert.equal(status.lastErrorAt, 20_000)
  assert.equal(status.lastOkAt, 10_000, 'the last success is kept')

  t = 30_000
  answersOf(await r.ask())
  status = await r.judge.status()
  assert.equal(status.state, 'ok')
  assert.equal(status.lastOkAt, 30_000)
  assert.match(status.lastError!, /503/, 'the last error stays until another replaces it')
})

test('a request that was refused before it was sent says nothing about Jev, and a 422 does', async () => {
  const r = await rig()
  failureOf(await r.ask({ questions: {} }), 'invalid')
  assert.deepEqual(await r.judge.status(), { keySet: true, state: 'ok', p50: null, p95: null })

  r.jev.queue({ kind: 'status', status: 422, body: 'bad questions' })
  failureOf(await r.ask(), 'invalid')
  const status = await r.judge.status()
  assert.equal(status.state, 'unavailable')
  assert.match(status.lastError!, /bad questions/)
})

test('while Jev is being skipped, the state is unavailable', async () => {
  let t = 1_000_000
  const r = await rig({ now: () => t })
  r.jev.queue({ kind: 'status', status: 429, headers: { 'retry-after': '10' } })
  failureOf(await r.ask())
  failureOf(await r.ask())
  assert.equal((await r.judge.status()).state, 'unavailable')
})

test('p50 and p95 are over the last 100 calls that returned answers: failures are not counted', async () => {
  let t = 1_000_000
  const r = await rig({ now: () => t })
  const ask = () => r.ask({ questions: { q: SERVES_TASK } })

  // 150 successes with latencies 1..150 ms, each followed by a failure
  for (let i = 1; i <= 150; i++) {
    r.jev.queue({ kind: 'answer', body: () => { t += i; return jevBody({ q: noulAnswer(0.5) }) } })
    answersOf(await ask())
    r.jev.queue({ kind: 'status', status: 500, body: 'down' })
    failureOf(await ask())
  }
  // the last 100 successes are 51..150 ms. Nearest rank: p50 is the 50th of them, p95 the 95th.
  const status = await r.judge.status()
  assert.equal(status.p50, 100)
  assert.equal(status.p95, 145)
})

test('percentiles of a few calls', async () => {
  let t = 1_000_000
  const r = await rig({ now: () => t })
  const ask = () => r.ask({ questions: { q: SERVES_TASK } })
  r.jev.queue({ kind: 'answer', body: () => { t += 70; return jevBody({ q: noulAnswer(0.5) }) } })
  answersOf(await ask())
  assert.deepEqual([(await r.judge.status()).p50, (await r.judge.status()).p95], [70, 70])
  for (const ms of [10, 30, 500]) {
    r.jev.queue({ kind: 'answer', body: () => { t += ms; return jevBody({ q: noulAnswer(0.5) }) } })
    answersOf(await ask())
  }
  // sorted: 10, 30, 70, 500: p50 = 2nd, p95 = 4th
  const status = await r.judge.status()
  assert.equal(status.p50, 30)
  assert.equal(status.p95, 500)
})

// --- the log --------------------------------------------------------------------------------------

test('every outcome writes one log line, with what the spec\'s log has', async () => {
  let t = 1_790_881_930_415
  const r = await rig({ now: () => t })
  const agent = { id: 'session-7', session: { header: { delegationDepth: 1 } }, options: {} }

  r.jev.queue({ kind: 'answer', body: () => { t += 280; return jevBody(GOOD) } })
  const result = answersOf(await r.ask({ agent, tool: 'bash', callId: 'call-1', subject: 'git push' }))
  assert.equal(r.lines.length, 1)
  assert.deepEqual(r.lines[0], {
    at: 1_790_881_930_415, purpose: 'command', agent: 'session-7', child: true, tool: 'bash', callId: 'call-1',
    subject: 'git push', answers: result.answers, decision: null, latencyMs: 280, error: null,
  })
})

test('failures are logged too: the reason, no answers, and the time it took when Jev was asked', async () => {
  const r = await rig()
  r.jev.queue(
    { kind: 'status', status: 401 },
    { kind: 'status', status: 422, body: 'no' },
    { kind: 'status', status: 500, body: 'oops' },
    { kind: 'malformed' },
    { kind: 'drop' },
    ok({ serves_task: noulAnswer(7) }),
  )
  for (let i = 0; i < 6; i++) await r.ask()
  failureOf(await r.ask({ questions: {} }), 'invalid')
  assert.equal(r.lines.length, 7)
  for (const line of r.lines) {
    assert.equal(line.answers, null)
    assert.equal(line.decision, null)
    assert.equal(typeof line.error, 'string')
    assert.equal(line.purpose, 'command')
  }
  assert.match(r.lines[0]!.error!, /key was refused/)
  assert.match(r.lines[1]!.error!, /422/)
  assert.match(r.lines[2]!.error!, /500/)
  assert.match(r.lines[3]!.error!, /malformed/)
  assert.equal(typeof r.lines[0]!.latencyMs, 'number', 'Jev was asked')
  assert.equal(r.lines[6]!.latencyMs, null, 'it never was')
})

test('no key, a skipped call and a cancel are logged', async () => {
  let t = 1_000_000
  const none = await rig({ key: async () => undefined })
  await none.ask()
  assert.match(none.lines[0]!.error!, /no TypeSafe key/)
  assert.equal(none.lines[0]!.latencyMs, null)

  const r = await rig({ now: () => t })
  r.jev.queue({ kind: 'status', status: 429 })
  await r.ask()
  await r.ask()
  assert.equal(r.lines.length, 2)
  assert.match(r.lines[1]!.error!, /skipp/)
  await r.ask({ signal: AbortSignal.abort() })
  assert.match(r.lines[2]!.error!, /cancel/)
})

test('a call with no agent, tool or call id logs them as null, and the agent is a child unless it is top-level', async () => {
  const r = await rig()
  r.jev.always(ok())
  await r.ask({ purpose: 'ask' })
  assert.deepEqual([r.lines[0]!.agent, r.lines[0]!.child, r.lines[0]!.tool, r.lines[0]!.callId, r.lines[0]!.subject], [null, false, null, null, ''])

  await r.ask({ agent: { id: 'main-1', session: { header: {} }, options: {} } })
  assert.deepEqual([r.lines[1]!.agent, r.lines[1]!.child], ['main-1', false])
  await r.ask({ agent: { id: 'kid-1', session: { header: { origin: 'subagent' } }, options: {} } })
  assert.deepEqual([r.lines[2]!.agent, r.lines[2]!.child], ['kid-1', true])
  await r.ask({ agent: { id: 'odd-1' } })
  assert.deepEqual([r.lines[3]!.agent, r.lines[3]!.child], ['odd-1', true], 'an agent that can\'t be told apart is not trusted as the main one')
})

test('a log that throws or rejects does not fail the call or hold it up', async () => {
  const throwing = await rig({ log: () => { throw new Error('disk full') } })
  throwing.jev.always(ok())
  answersOf(await throwing.ask())

  const rejecting = await rig({ log: () => Promise.reject(new Error('disk full')) })
  rejecting.jev.always(ok())
  answersOf(await rejecting.ask())

  const hanging = await rig({ log: () => new Promise<void>(() => {}) })
  hanging.jev.always(ok())
  const started = performance.now()
  answersOf(await hanging.ask())
  assert.ok(performance.now() - started < 1_000, 'the call does not wait for the log')
})

test('a settings lookup that throws is unavailable', async () => {
  const jev = await startFakeJev()
  const judge = createJudge({
    baseUrl: jev.url, key: async () => KEY, log: () => {},
    settings: async () => { throw new Error('store is gone') },
  })
  failureOf(await judge.ask({ state: 's', questions: { q: SERVES_TASK }, purpose: 'ask' }))
  assert.equal(jev.requests.length, 0)
})

test('concurrent calls are independent', async () => {
  const r = await rig()
  r.jev.always({ kind: 'answer', body: (request: RecordedRequest) => jevBody(Object.fromEntries(Object.keys(request.json.questions).map(id => [id, noulAnswer(id === 'a' ? 0.1 : 0.9)]))), delayMs: 20 })
  const [a, b] = await Promise.all([
    r.ask({ questions: { a: SERVES_TASK } }),
    r.ask({ questions: { b: SERVES_TASK } }),
  ])
  assert.deepEqual(answersOf(a).answers, { a: { type: 'noul', noul: 0.1 } })
  assert.deepEqual(answersOf(b).answers, { b: { type: 'noul', noul: 0.9 } })
})

// --- the key never leaks ---------------------------------------------------------------------------

/** Every string anywhere in `value`, keys included. */
function stringsIn(value: unknown, into: string[] = []): string[] {
  if (typeof value === 'string') into.push(value)
  else if (Array.isArray(value)) for (const item of value) stringsIn(item, into)
  else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) { into.push(key); stringsIn(item, into) }
  }
  return into
}

test('the key is in no log line, error, answer or status, even when Jev echoes it back', async () => {
  const keys = [KEY, 'tsk"quote\\slash-CANARY-0a1b2c', 'tsk+plus/slash=CANARY&q?x#y-77aa']
  for (const key of keys) {
    const escaped = JSON.stringify(key).slice(1, -1)
    const encoded = encodeURIComponent(key)
    const echoes = [
      `bad key ${key}`,
      `{"detail":"invalid credential ${escaped}"}`,
      `Authorization: Bearer ${key}`,
      `see ?key=${encoded}`,
      `bad key ${'x'.repeat(150)}${key}tail`,                    // straddles the 200-character cut
      `bad key ${'x'.repeat(170)}${key.slice(0, 12)}`,           // a piece of it at the cut: not the key, so not masked
    ]
    // the clock jumps a minute at every reading, so a 429's retry-after never holds up the next call
    let t = 1_000_000
    const r = await rig({ key: async () => key, now: () => (t += 60_000) })
    const behaviours: Behaviour[] = []
    for (const body of echoes) behaviours.push({ kind: 'status', status: 422, body }, { kind: 'status', status: 500, body })
    behaviours.push(
      { kind: 'status', status: 401, body: key },
      { kind: 'status', status: 429, body: key, headers: { 'retry-after': '1', 'x-echo': key } },
      { kind: 'malformed', body: `{"echo": "${escaped}"` },
      { kind: 'answer', body: { model: key, answers: { effect: { type: 'noul', noul: 0.5, echo: key } } } },
      { kind: 'drop' },
      ok(),
    )
    r.jev.queue(...behaviours)

    const outputs: unknown[] = []
    for (let i = 0; i < behaviours.length; i++) outputs.push(await r.ask())
    outputs.push(await r.ask({ questions: { constructor: SERVES_TASK, bad: 5 } }), await r.judge.status(), r.lines)

    for (const text of stringsIn(outputs)) {
      for (const form of [key, escaped, encoded]) {
        assert.equal(text.includes(form), false, `the key leaked into: ${text.slice(0, 120)}`)
      }
    }
    // it was a real test: Jev saw the key, and what it echoed came through in some form
    assert.equal(r.jev.requests[0]!.headers.authorization, `Bearer ${key}`)
    const shown = stringsIn(outputs).join('\n')
    assert.match(shown, /bad key/)
    assert.match(shown, /‹key›/)
  }
})

test('error bodies are cut to 200 characters, with whitespace collapsed', async () => {
  const r = await rig()
  r.jev.queue({ kind: 'status', status: 500, body: `first\n\n   second\t\tthird ${'y'.repeat(400)}` })
  const failure = failureOf(await r.ask())
  assert.match(failure.message, /first second third y+…$/)
  const excerpt = failure.message.slice(failure.message.indexOf('first'))
  assert.equal(excerpt.length, 200)
})

// --- the plugin provides it -----------------------------------------------------------------------

/** Mount dish-judge on a fake Jev; the key comes from whatever `credentials` stub is given. */
async function mounted(config: Record<string, unknown> = {}) {
  const jev = await startFakeJev()
  const ctx = new Context()
  const handle = mountJudge(ctx, await tempDir(), { baseUrl: jev.url, ...config } as never)
  await handle
  return { ctx, jev, handle }
}
const asks = { state: { command: 'ls' }, questions: { q: SERVES_TASK }, purpose: 'ask' } as const

test('the plugin provides ctx.judge, and takes it away when it goes', async () => {
  const { ctx, handle } = await mounted()
  const judge: Judge = ctx.judge
  assert.deepEqual(Object.keys(judge).sort(), ['ask', 'status'])
  await handle.dispose()
  assert.equal(ctx.get('judge'), undefined)
})

test('the key comes from ctx.credentials, read as a sibling\'s service on each call, under the configured name', async () => {
  const { ctx, jev } = await mounted()
  jev.always({ kind: 'answer', body: jevBody({ q: noulAnswer(0.7) }) })
  const asked: string[] = []
  let value = 'first-key-1111'
  await provideStub(ctx, 'credentials', {
    resolve: async (ref: string) => { asked.push(ref); return { value, source: 'env' } },
  })
  answersOf(await ctx.judge.ask(asks))
  value = 'second-key-2222'
  answersOf(await ctx.judge.ask(asks))
  assert.deepEqual(asked, ['TYPESAFE_API_KEY', 'TYPESAFE_API_KEY'])
  assert.deepEqual(jev.requests.map(r => r.headers.authorization), ['Bearer first-key-1111', 'Bearer second-key-2222'])

  const other = await mounted({ keyName: 'MY_JEV_KEY' })
  other.jev.always({ kind: 'answer', body: jevBody({ q: noulAnswer(0.7) }) })
  const names: string[] = []
  await provideStub(other.ctx, 'credentials', { resolve: async (ref: string) => { names.push(ref); return { value: 'k-3333', source: 'file' } } })
  answersOf(await other.ctx.judge.ask(asks))
  assert.deepEqual(names, ['MY_JEV_KEY'])
})

test('with no credentials service, or nothing in it, or an empty value, there is no key', async () => {
  const bare = await mounted()
  const failure = failureOf(await bare.ctx.judge.ask(asks))
  assert.equal(failure.message, 'no TypeSafe key: set it on Settings → Judge')
  assert.equal((await bare.ctx.judge.status()).state, 'no-key')

  for (const resolved of [undefined, { value: '', source: 'env' }, { value: '  ', source: 'file' }]) {
    const m = await mounted()
    await provideStub(m.ctx, 'credentials', { resolve: async () => resolved })
    failureOf(await m.ctx.judge.ask(asks))
    assert.equal((await m.ctx.judge.status()).keySet, false)
    assert.equal(m.jev.requests.length, 0)
  }

  const broken = await mounted()
  await provideStub(broken.ctx, 'credentials', { resolve: async () => { throw new Error('locked') } })
  assert.match(failureOf(await broken.ctx.judge.ask(asks)).message, /could not read the TypeSafe key/)
})

test('the plugin\'s settings reach the call: the shipped model and time limit', async () => {
  const { ctx, jev } = await mounted()
  jev.always({ kind: 'answer', body: jevBody({ q: noulAnswer(0.7) }) })
  await provideStub(ctx, 'credentials', { resolve: async () => ({ value: KEY, source: 'env' }) })
  answersOf(await ctx.judge.ask(asks))
  assert.equal(jev.requests[0]!.json.model, DEFAULT_SETTINGS.model)
})
