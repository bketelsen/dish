/**
 * Live checks of the Jev client against the real TypeSafe API. They are not part of `pnpm test`: that only runs the
 * `test` directories, and this one is `test-live`. Run them with `pnpm --filter dish-judge test:live`, with
 * `TYPESAFE_API_KEY` in the environment. Without it every test here skips, with a message saying so.
 *
 * Jev costs $0.042 per million input tokens, so a run is a fraction of a cent.
 *
 * The key is never printed: nothing here writes it, and the raw responses that are shown have it masked first. Each test
 * ends by checking that the key isn't in any string the client produced.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createJudge } from '../src/client.ts'
import type { JudgeResult, LogLine, Question } from '../src/client.ts'
import { DEFAULT_SETTINGS } from '../src/settings.ts'

const KEY = process.env.TYPESAFE_API_KEY?.trim()
const SKIP = KEY === undefined || KEY === ''
  ? 'TYPESAFE_API_KEY is not set: put it in the environment to run the live tests (pnpm --filter dish-judge test:live)'
  : false
const BASE_URL = 'https://api.typesafe.ai'

/** What the real server sent back, for each call, as the client read it. */
const exchanges: Array<{ status: number, text: string }> = []
const realFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const response = await realFetch(input, init)
  // Only the response is kept: the request, with the key in it, never is.
  response.clone().text().then(text => { exchanges.push({ status: response.status, text }) }, () => {})
  return response
}

/** `text` with the key hidden, for printing. */
function safe(text: string): string {
  return KEY === undefined || KEY === '' ? text : text.split(KEY).join('‹key›')
}

/** Every string anywhere in `value`, keys included. */
function stringsIn(value: unknown, into: string[] = []): string[] {
  if (typeof value === 'string') into.push(value)
  else if (Array.isArray(value)) for (const item of value) stringsIn(item, into)
  else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) { into.push(key); stringsIn(item, into) }
  }
  return into
}

/** The shape of a JSON value: its keys and the types of what's in them, with numbers kept (they are probabilities). */
function shape(value: unknown, depth = 0): string {
  if (Array.isArray(value)) return `[${value.map(item => shape(item, depth + 1)).join(', ')}]`
  if (value !== null && typeof value === 'object') {
    return `{ ${Object.entries(value).map(([k, v]) => `${k}: ${shape(v, depth + 1)}`).join(', ')} }`
  }
  if (typeof value === 'string') return value.length > 24 ? `string(${value.length})` : JSON.stringify(value)
  return String(value)
}

/** The last response the real server sent: the copy is read a moment after the client is done with the original. */
async function lastExchange(): Promise<{ status: number, text: string } | undefined> {
  await new Promise(resolve => setTimeout(resolve, 100))
  return exchanges.at(-1)
}

function client(key: string, timeoutMs = DEFAULT_SETTINGS.timeoutMs) {
  const lines: LogLine[] = []
  const judge = createJudge({
    baseUrl: BASE_URL,
    key: async () => key,
    settings: async () => ({ ...DEFAULT_SETTINGS, timeoutMs }),
    log: (line) => { lines.push(structuredClone(line)) },
  })
  return { judge, lines }
}

const QUESTIONS: Record<string, Question> = {
  serves_task: {
    type: 'noul',
    instructions: 'Is running `command` a reasonable step toward `task`?',
  },
  effect: {
    type: 'choice',
    instructions: 'What would running `command` from `cwd` do to files, systems and data?',
    criteria: {
      read_only: 'it only reads or reports',
      reversible: 'it changes files inside the workspace in a way git or rerunning can undo',
      irreversible: 'it deletes or overwrites data that can\'t be recovered, or changes things outside the workspace, or publishes, pushes, deploys or sends',
      other: null,
    },
  },
  risk: {
    type: 'score',
    instructions: 'How much harm could running `command` do?',
    criteria: ['none: it only reads', 'some: it changes local files', 'a lot: it can destroy data or reach outside'],
  },
}

const STATE = { command: 'git status', cwd: '/home/dev/project', workspace: '/home/dev/project', task: 'see which files I changed' }

function noLeak(outputs: unknown) {
  for (const text of stringsIn(outputs)) {
    assert.ok(!text.includes(KEY ?? '\u0000no key\u0000'), 'the key leaked into a string the client produced')
  }
}

test('live: one call with a noul, a choice with other and a 3-level score passes the client\'s own checks', { skip: SKIP, timeout: 30_000 }, async () => {
  const { judge, lines } = client(KEY!, 10_000)
  const result: JudgeResult = await judge.ask({ state: STATE, questions: QUESTIONS, purpose: 'command', subject: 'git status' })
  assert.equal(result.ok, true, result.ok ? '' : `${result.reason}: ${safe(result.message)}`)
  if (!result.ok) return

  const { serves_task, effect, risk } = result.answers
  assert.equal(serves_task?.type, 'noul')
  assert.equal(effect?.type, 'choice')
  assert.equal(risk?.type, 'score')
  if (effect?.type === 'choice') {
    assert.deepEqual(Object.keys(effect.probabilities).sort(), ['irreversible', 'other', 'read_only', 'reversible'])
  }
  if (risk?.type === 'score') {
    assert.deepEqual(Object.keys(risk.probabilities).sort(), ['0', '1', '2'])
    assert.ok(risk.score >= 0 && risk.score <= 2)
  }

  // What the real server's response looks like, to compare with docs/research/2026-10-01-typesafe-jev.md.
  const raw = await lastExchange()
  assert.equal(raw?.status, 200)
  const body = JSON.parse(safe(raw!.text)) as { model?: unknown, answers?: Record<string, unknown>, usage?: unknown }
  console.log('live: response envelope keys:', Object.keys(body).join(', '))
  console.log('live: model id returned:', body.model)
  console.log('live: usage:', shape(body.usage))
  for (const [id, answer] of Object.entries(body.answers ?? {})) console.log(`live: answer ${id}:`, shape(answer))
  console.log('live: latency:', result.latencyMs, 'ms')

  const status = await judge.status()
  assert.equal(status.state, 'ok')
  assert.equal(status.p50, result.latencyMs)
  assert.equal(lines.length, 1)
  assert.equal(lines[0]!.error, null)
  noLeak([result, status, lines])
})

test('live: a few calls in a row, for the latencies', { skip: SKIP, timeout: 60_000 }, async () => {
  const { judge } = client(KEY!, 10_000)
  const seen: number[] = []
  for (let i = 0; i < 5; i++) {
    const result = await judge.ask({ state: STATE, questions: QUESTIONS, purpose: 'command' })
    assert.equal(result.ok, true, result.ok ? '' : `${result.reason}: ${safe(result.message)}`)
    if (result.ok) seen.push(result.latencyMs)
  }
  const status = await judge.status()
  console.log('live: latencies (ms):', seen.join(', '), `| p50 ${status.p50} p95 ${status.p95}`)
  noLeak(status)
})

test('live: a wrong key is a 401, which is unavailable with "the TypeSafe key was refused"', { skip: SKIP, timeout: 30_000 }, async () => {
  const wrong = 'tsk-definitely-not-a-real-key-0000000000000000'
  const { judge, lines } = client(wrong, 10_000)
  const result = await judge.ask({ state: STATE, questions: QUESTIONS, purpose: 'command' })
  assert.deepEqual(result, { ok: false, reason: 'unavailable', message: 'the TypeSafe key was refused' })
  const raw = await lastExchange()
  assert.equal(raw?.status, 401)
  console.log('live: 401 body from the real server:', JSON.stringify(safe(raw!.text).slice(0, 200)))
  assert.equal(lines.length, 1)
  assert.equal((await judge.status()).state, 'unavailable')
  noLeak([result, lines])
})

test('live: a 1 ms time limit is unavailable, as a timeout', { skip: SKIP, timeout: 30_000 }, async () => {
  const { judge, lines } = client(KEY!, 1)
  const started = performance.now()
  const result = await judge.ask({ state: STATE, questions: QUESTIONS, purpose: 'command' })
  const elapsed = performance.now() - started
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.reason, 'unavailable')
  assert.match(result.message, /timed out after 1 ms/)
  console.log('live: a 1 ms limit gave up after', Math.round(elapsed), 'ms')
  assert.ok(elapsed < 500, `a 1 ms limit took ${elapsed} ms`)
  assert.equal(lines.length, 1)
  noLeak([result, lines, await judge.status()])
})

test('live: a request that is too many tokens for TypeSafe is a 400 max_tokens_exceeded: invalid and tooBig, and the status is left alone', { skip: SKIP, timeout: 30_000 }, async () => {
  const { judge, lines } = client(KEY!, 10_000)
  const ok = await judge.ask({ state: STATE, questions: { serves_task: QUESTIONS.serves_task! }, purpose: 'ask' })
  assert.equal(ok.ok, true, ok.ok ? '' : safe(ok.message))
  const before = await judge.status()
  // about 200 KB of instructions: under the client's 256 KB limit for a request, over TypeSafe's 32k tokens
  const long: Question = { type: 'noul', instructions: `Is \`command\` harmless? ${'The quick brown fox jumps over the lazy dog. '.repeat(4500)}` }
  const result = await judge.ask({ state: STATE, questions: { long }, purpose: 'ask' })
  assert.equal(result.ok, false)
  if (result.ok) return
  const raw = await lastExchange()
  console.log('live: ~200 KB of instructions → HTTP', raw?.status, '→', `${result.reason}${result.tooBig ? ' tooBig' : ''}: ${safe(result.message)}`)
  assert.equal(raw?.status, 400)
  assert.equal(result.reason, 'invalid')
  assert.equal(result.tooBig, true)
  assert.deepEqual(await judge.status(), before, 'the status is as it was')
  assert.equal(lines.length, 2)
  noLeak([ok, result, lines, before])
})

test('live: decide puts the decision on the line', { skip: SKIP, timeout: 30_000 }, async () => {
  const { judge, lines } = client(KEY!, 10_000)
  const result = await judge.ask({
    state: STATE, questions: QUESTIONS, purpose: 'command', tool: 'bash', callId: 'live-1', subject: 'git status',
    decide: (settled) => ({ decision: settled.ok ? 'allow' : 'ask' }),
  })
  assert.equal(result.ok, true, result.ok ? '' : safe(result.message))
  assert.deepEqual(result.decided, { decision: 'allow' })
  assert.equal(lines.length, 1)
  assert.equal(lines[0]!.decision, 'allow')
  assert.deepEqual(Object.keys(lines[0]!.answers).sort(), ['effect', 'risk', 'serves_task'])
  noLeak([result, lines])
})

test('live: a request TypeSafe refuses (an unknown model) is a 400, which is invalid, with its message', { skip: SKIP, timeout: 30_000 }, async () => {
  const lines: LogLine[] = []
  const judge = createJudge({
    baseUrl: BASE_URL,
    key: async () => KEY,
    settings: async () => ({ ...DEFAULT_SETTINGS, model: 'jev-0.0.0-does-not-exist', timeoutMs: 10_000 }),
    log: (line) => { lines.push(structuredClone(line)) },
  })
  const result = await judge.ask({ state: STATE, questions: { serves_task: QUESTIONS.serves_task! }, purpose: 'command' })
  assert.equal(result.ok, false)
  if (result.ok) return
  const raw = await lastExchange()
  console.log('live: unknown model → HTTP', raw?.status, '→', `${result.reason}: ${safe(result.message)}`)
  assert.equal(raw?.status, 400)
  assert.equal(result.reason, 'invalid')
  assert.match(result.message, /Unknown model: jev-0\.0\.0-does-not-exist/)
  assert.equal(result.tooBig, undefined)
  assert.equal((await judge.status()).state, 'unavailable', 'a typo\'d model shows')
  noLeak([result, lines, await judge.status()])
})
