import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import { ToolRuntime, assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { ASK_JUDGE_TOOL, MAX_QUESTIONS, askJudgeTool } from '../src/ask.ts'
import * as plugin from '../src/index.ts'
import { JudgeLog } from '../src/log.ts'
import type { JudgeLogLine } from '../src/log.ts'
import {
  choiceAnswer, dirs, jevBody, mountJudge, noulAnswer, provideStub, scoreAnswer, startFakeJev, waitFor, watchLogs,
} from './helpers.ts'
import type { Dirs, FakeJev } from './helpers.ts'

const KEY = 'tsk_live_0123456789abcdefghijklmnopqrstuv'

type Result = { isError: boolean, content: Array<{ type: string, text?: string }>, value?: any }
const textOf = (result: Result): string => result.content.map(block => block.type === 'text' ? block.text ?? '' : '').join('\n')

/** The calling agent as dsh builds it: a top-level session has a depth of 0, a crew child's has one below. */
const MAIN = { id: 'sess-main', session: { header: { id: 'sess-main', delegationDepth: 0 } } }
const CHILD = { id: 'sess-child', session: { header: { id: 'sess-child', delegationDepth: 1, origin: 'subagent' } } }

const disposables: Array<{ dispose(): Promise<void> | void }> = []
after(async () => {
  await Promise.all(disposables.splice(0).reverse().map(handle => handle.dispose()))
})

interface World {
  ctx: Context
  jev: FakeJev
  where: Dirs
  logs: string[]
  /** The log lines written so far, once every one is on the disk. */
  lines(): Promise<JudgeLogLine[]>
  /** One call of the tool through the real registry, with its arguments validated. */
  call(args: unknown, agent?: object, signal?: AbortSignal): Promise<Result>
  /** The tool itself, as the plugin registered it. */
  tool(): ToolDefinition | undefined
}

/** dsh's real tool registry, dish-judge against a fake Jev, and `credentials` as a sibling plugin provides it. */
async function world(options: { key?: string | undefined, config?: Partial<plugin.Config> } = {}): Promise<World> {
  const ctx = new Context()
  const logs = watchLogs(ctx)
  const where = await dirs()
  const jev = await startFakeJev()
  disposables.push(await provideStub(ctx, 'systemPrompt', { tools() {}, section() {}, getSectionOrder: () => 1 }))
  disposables.push(await ctx.plugin(ToolRuntime, {}))
  const key = 'key' in options ? options.key : KEY
  disposables.push(await provideStub(ctx, 'credentials', { resolve: async () => key === undefined ? undefined : { value: key } }))
  const handle = mountJudge(ctx, where.state, { baseUrl: jev.url, ...options.config })
  await handle
  disposables.push(handle)
  let counter = 0
  return {
    ctx,
    jev,
    where,
    logs,
    async lines() {
      await ctx.dishJudge.log.flush()
      return (await ctx.dishJudge.log.read()).lines.reverse()
    },
    call(args, agent = MAIN, signal = new AbortController().signal) {
      return ctx.tools.execute({ callId: `call-${++counter}` as never, name: ASK_JUDGE_TOOL, arguments: args, agent: agent as never, signal }) as unknown as Promise<Result>
    },
    tool: () => ctx.tools.get(ASK_JUDGE_TOOL),
  }
}

/** What an agent is told when the state is too big: send the part that matters, and dense text counts for more than its size. */
const TOO_BIG = 'the state is too large for the judge: send a smaller excerpt with only the part that matters (at most about 100 KB of prose, less of code or JSON)'

const NOUL = { complete: { type: 'noul', instructions: 'Does `state` handle every failure of the calls it makes?' } }
const answered = (answers: Record<string, unknown>) => ({ kind: 'answer', body: jevBody(answers) }) as const

/** The error a call came to, for a call that must be refused: it is the tool's own message, in the registry's error result. */
async function refused(w: World, args: unknown, agent?: object): Promise<string> {
  const result = await w.call(args, agent)
  assert.equal(result.isError, true, `expected an error, got ${textOf(result)}`)
  // The registry puts the error's name in front of its message.
  return textOf(result).replace(/^Error: /, '')
}

// --- the definition -------------------------------------------------------------------------------

test('ASK_JUDGE_TOOL is the tool\'s name, which the gate leaves alone and crew\'s roles list', () => {
  assert.equal(ASK_JUDGE_TOOL, 'ask_judge')
})

test('the tool is ask_judge, with a state and questions that are both required, and an output schema the tool registry accepts', async () => {
  const w = await world()
  const tool = w.tool()
  assert.ok(tool, 'ask_judge is registered')
  assert.equal(tool.name, 'ask_judge')
  // Registering it already ran this: an output schema with a JSON-Schema `required` array would have failed the plugin's load.
  assert.doesNotThrow(() => assertSupportedJsonSchema(tool.output.schema as never))
  const parameters = tool.parameters as { properties: Record<string, unknown>, required?: string[] }
  assert.deepEqual(Object.keys(parameters.properties).sort(), ['questions', 'state'])
  assert.deepEqual([...parameters.required ?? []].sort(), ['questions', 'state'])
  const output = tool.output.schema as { properties: Record<string, unknown>, required?: string[] }
  assert.deepEqual(Object.keys(output.properties), ['answers'])
  assert.deepEqual(output.required, ['answers'])
})

test('the description carries the three types, the phrasing advice, the numbers-only warning, the band advice and the three examples', async () => {
  const description = (await world()).tool()!.description
  for (const word of ['noul', 'choice', 'score']) assert.match(description, new RegExp(`\\b${word}\\b`), word)
  assert.match(description, /numbers/i)
  assert.match(description, /no explanation|never an explanation/i)
  // The research note's advice, one item at a time.
  assert.match(description, /situations, not degrees/)
  assert.match(description, /high value means yes/)
  assert.match(description, /negation/)
  assert.match(description, /always include `other`/i)
  assert.match(description, /arithmetic/)
  assert.match(description, /only what matters|filter/i)
  // The state leaves the machine, and what the client masks first.
  assert.match(description, /`state` goes to TypeSafe; known secret patterns are masked first, but leave other secrets out\./)
  // The score example describes situations, and asks for one judgment, not a count.
  assert.match(description, /How ready to merge is the change in `state`\?/)
  assert.doesNotMatch(description, /How many of these/)
  // Jev isn't deterministic.
  assert.match(description, /isn't deterministic/)
  assert.match(description, /band/)
  // The spec's three examples.
  assert.match(description, /error handling|failure of the calls/i)
  assert.match(description, /which file/i)
  assert.match(description, /diff/i)
  assert.match(description, /"other": null/)
  assert.match(description, /normalized/)
  // It goes into every agent's prompt: it stays short.
  assert.ok(description.length <= 3000, `the description is ${description.length} characters`)
})

test('parallel ask_judge calls run together: the registry classifies a valid call as parallel, and an invalid one fails closed', async () => {
  const w = await world()
  const exec = (args: unknown) => ({ callId: 'c' as never, name: 'ask_judge', arguments: args, agent: MAIN as never, signal: new AbortController().signal })
  assert.deepEqual(w.ctx.tools.executionMode(exec({ state: 'x', questions: NOUL })), { kind: 'parallel' })
  assert.deepEqual(w.ctx.tools.executionMode(exec({ state: 42, questions: NOUL })), { kind: 'exclusive' })
  // And they are one request each, answered under their own ids.
  w.jev.always(answered({ complete: noulAnswer(0.5) }))
  const results = await Promise.all([1, 2, 3].map(() => w.call({ state: 'x', questions: NOUL })))
  assert.ok(results.every(result => !result.isError))
  assert.equal(w.jev.requests.length, 3)
})

// --- the answers ----------------------------------------------------------------------------------

test('a noul: the request is the model, the state and the question, and the answer is P(yes) under its id', async () => {
  const w = await world()
  w.jev.always(answered({ complete: noulAnswer(0.93) }))
  const result = await w.call({ state: 'function f() { try { g() } catch (e) { log(e) } }', questions: NOUL })
  assert.equal(result.isError, false, textOf(result))
  assert.deepEqual(result.value, { answers: { complete: { type: 'noul', noul: 0.93 } } })
  assert.equal(w.jev.requests.length, 1)
  const request = w.jev.requests[0]!
  assert.equal(request.method, 'POST')
  assert.equal(request.path, '/v1/systemone')
  assert.deepEqual(request.json, { model: 'jev-1.13.0', state: 'function f() { try { g() } catch (e) { log(e) } }', questions: NOUL })
  // What the model reads is the answers, as JSON.
  assert.deepEqual(JSON.parse(textOf(result)), { answers: { complete: { type: 'noul', noul: 0.93 } } })
})

test('a choice: the option, every probability and the confidence come back as Jev gave them', async () => {
  const w = await world()
  const probabilities = { 'src/parse.ts': 0.81, 'src/render.ts': 0.1, other: 0.09 }
  w.jev.always(answered({ owner: choiceAnswer('src/parse.ts', probabilities, 0.77) }))
  const questions = { owner: { type: 'choice', instructions: 'Which file holds the bug in `state`?', criteria: { 'src/parse.ts': 'parsing', 'src/render.ts': null, other: null } } }
  const result = await w.call({ state: 'TypeError at parse.ts:41', questions })
  assert.equal(result.isError, false, textOf(result))
  assert.deepEqual(result.value, { answers: { owner: { type: 'choice', choice: 'src/parse.ts', probabilities, confidence: 0.77 } } })
  assert.deepEqual(w.jev.requests[0]!.json.questions, questions)
})

test('a score: normalized is score / (levels - 1), rounded to 3 places, beside the score, the probabilities and the confidence', async () => {
  const w = await world()
  const levels = ['none', 'one', 'two', 'three', 'all four']
  const questions = { quality: { type: 'score', instructions: 'How well does `state` meet: small, tested, named well?', criteria: levels } }
  const cases: Array<[number, number]> = [[0, 0], [4, 1], [2, 0.5], [2.3333, 0.583], [0.3, 0.075], [3.9, 0.975], [1.0004, 0.25]]
  for (const [score, normalized] of cases) {
    const probabilities = { 0: 0.1, 1: 0.2, 2: 0.4, 3: 0.2, 4: 0.1 }
    w.jev.always(answered({ quality: scoreAnswer(score, probabilities, 0.66) }))
    const result = await w.call({ state: 'a diff', questions })
    assert.equal(result.isError, false, textOf(result))
    assert.deepEqual(result.value, { answers: { quality: { type: 'score', score, normalized, probabilities, confidence: 0.66 } } }, `score ${score}`)
  }
  // A level count other than five: ten levels, and a score that doesn't divide evenly.
  const ten = Array.from({ length: 10 }, (_, index) => `level ${index}`)
  w.jev.always(answered({ quality: scoreAnswer(3.7, Object.fromEntries(ten.map((_, i) => [String(i), 0.1])), 0.5) }))
  const result = await w.call({ state: 'x', questions: { quality: { type: 'score', instructions: 'How well?', criteria: ten } } })
  assert.equal(result.value.answers.quality.normalized, 0.411)
})

test('several questions are one call to Jev, and each answer is under its own id', async () => {
  const w = await world()
  w.jev.always(answered({
    done: noulAnswer(0.9),
    owner: choiceAnswer('a', { a: 0.7, other: 0.3 }, 0.6),
    quality: scoreAnswer(1, { 0: 0.2, 1: 0.6, 2: 0.2 }, 0.9),
  }))
  const questions = {
    done: { type: 'noul', instructions: 'Is `state` finished?' },
    owner: { type: 'choice', instructions: 'Who owns `state`?', criteria: { a: null, other: null } },
    quality: { type: 'score', instructions: 'How good is `state`?', criteria: ['poor', 'fair', 'good'] },
  }
  const result = await w.call({ state: { note: 'x' }, questions })
  assert.equal(result.isError, false, textOf(result))
  assert.deepEqual(Object.keys(result.value.answers), ['done', 'owner', 'quality'])
  assert.equal(result.value.answers.quality.normalized, 0.5)
  assert.equal(w.jev.requests.length, 1)
})

test('state is a string or a JSON object, and is sent as it is', async () => {
  const w = await world()
  w.jev.always(answered({ complete: noulAnswer(0.5) }))
  await w.call({ state: 'plain text', questions: NOUL })
  await w.call({ state: { file: 'a.ts', diff: '+x', nested: { n: [1, 2] } }, questions: NOUL })
  assert.equal(w.jev.requests[0]!.json.state, 'plain text')
  assert.deepEqual(w.jev.requests[1]!.json.state, { file: 'a.ts', diff: '+x', nested: { n: [1, 2] } })
})

test('a question with more than the schema asks for is sent with only what Jev knows', async () => {
  const w = await world()
  w.jev.always(answered({ complete: noulAnswer(0.5) }))
  await w.call({ state: 'x', questions: { complete: { type: 'noul', instructions: 'Is `state` complete?', note: 'why I ask' } } })
  assert.deepEqual(w.jev.requests[0]!.json.questions, { complete: { type: 'noul', instructions: 'Is `state` complete?' } })
})

// --- empty strings are absent ---------------------------------------------------------------------

test('a noul\'s criteria that are empty are left out: an empty string, null, {}, [], and { true, false } whose values are empty strings or null', async () => {
  const w = await world()
  w.jev.always(answered({ complete: noulAnswer(0.5) }))
  const empties: unknown[] = ['', '  ', null, {}, [], { true: '', false: '' }, { true: ' ', false: '' }, { true: null, false: null }, { true: null, false: '' }]
  for (const criteria of empties) {
    const result = await w.call({ state: 'x', questions: { complete: { type: 'noul', instructions: 'Is `state` complete?', criteria } } })
    assert.equal(result.isError, false, `${JSON.stringify(criteria)}: ${textOf(result)}`)
  }
  assert.equal(w.jev.requests.length, empties.length)
  for (const request of w.jev.requests) assert.deepEqual(request.json.questions, { complete: { type: 'noul', instructions: 'Is `state` complete?' } })
})

test('a noul\'s criteria with something in them are kept', async () => {
  const w = await world()
  w.jev.always(answered({ complete: noulAnswer(0.5) }))
  const criteria = { true: 'every failure is handled', false: 'some failure is not' }
  await w.call({ state: 'x', questions: { complete: { type: 'noul', instructions: 'Is `state` complete?', criteria } } })
  assert.deepEqual(w.jev.requests[0]!.json.questions.complete.criteria, criteria)
})

test('a choice option\'s empty description is null on the wire; a description with words is kept', async () => {
  const w = await world()
  w.jev.always(answered({ owner: choiceAnswer('a', { a: 0.6, b: 0.3, c: 0.1 }) }))
  await w.call({ state: 'x', questions: { owner: { type: 'choice', instructions: 'Who owns `state`?', criteria: { a: '', b: '   ', c: 'the third' } } } })
  assert.deepEqual(w.jev.requests[0]!.json.questions.owner.criteria, { a: null, b: null, c: 'the third' })
})

test('half-empty noul criteria are refused, saying both are needed', async () => {
  const w = await world()
  const message = await refused(w, { state: 'x', questions: { complete: { type: 'noul', instructions: 'Is `state` complete?', criteria: { true: 'yes', false: '' } } } })
  assert.match(message, /noul criteria must be exactly \{ true, false \}/)
  assert.equal(w.jev.requests.length, 0)
})

// --- refusals: before anything is sent -----------------------------------------------------------

/** Each of these is refused by the tool or the client, with a message that names the fix, and Jev is never called. */
const REFUSED: Array<[string, unknown, RegExp]> = [
  ['no questions', { state: 'x', questions: {} }, /at least one question.*1–20/],
  ['an id that is not lower-case', { state: 'x', questions: { Done: { type: 'noul', instructions: 'Is `state` done?' } } }, /question id "Done" must be lower-case letters, digits and underscores/],
  ['an id that starts with a digit', { state: 'x', questions: { '1st': { type: 'noul', instructions: 'Is `state` done?' } } }, /question id "1st"/],
  ['no type', { state: 'x', questions: { done: { instructions: 'Is `state` done?' } } }, /question "done" needs a type: noul, choice or score/],
  ['an unknown type', { state: 'x', questions: { done: { type: 'rank', instructions: 'Is `state` done?' } } }, /question "done" needs a type: noul, choice or score/],
  ['empty instructions', { state: 'x', questions: { done: { type: 'noul', instructions: '' } } }, /question "done" needs instructions: a non-empty string/],
  ['no instructions', { state: 'x', questions: { done: { type: 'noul' } } }, /question "done" needs instructions/],
  ['a question that is not an object', { state: 'x', questions: { done: 'Is `state` done?' } }, /question "done" must be an object like \{ type, instructions, criteria \}/],
  ['a choice with no criteria', { state: 'x', questions: { pick: { type: 'choice', instructions: 'Which?' } } }, /question "pick" needs criteria: an object of 2–255 options/],
  ['a choice with one option', { state: 'x', questions: { pick: { type: 'choice', instructions: 'Which?', criteria: { a: null } } } }, /a choice needs 2–255 options, got 1/],
  ['a choice with 256 options', { state: 'x', questions: { pick: { type: 'choice', instructions: 'Which?', criteria: Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`o${i}`, null])) } } }, /a choice needs 2–255 options, got 256/],
  ['a choice option that is too long', { state: 'x', questions: { pick: { type: 'choice', instructions: 'Which?', criteria: { ['a'.repeat(65)]: null, b: null } } } }, /options are 1–64 characters/],
  ['a choice option with spaces at its ends', { state: 'x', questions: { pick: { type: 'choice', instructions: 'Which?', criteria: { ' a': null, b: null } } } }, /options are 1–64 characters/],
  ['a score with no criteria', { state: 'x', questions: { rate: { type: 'score', instructions: 'How good?' } } }, /question "rate" needs criteria: a list of 2–10 levels, from low to high/],
  ['a score with one level', { state: 'x', questions: { rate: { type: 'score', instructions: 'How good?', criteria: ['bad'] } } }, /a score needs 2–10 levels, got 1/],
  ['a score with eleven levels', { state: 'x', questions: { rate: { type: 'score', instructions: 'How good?', criteria: Array.from({ length: 11 }, (_, i) => `l${i}`) } } }, /a score needs 2–10 levels, got 11/],
  ['a score with an empty level', { state: 'x', questions: { rate: { type: 'score', instructions: 'How good?', criteria: ['bad', '', 'good'] } } }, /level 1 must be a non-empty string/],
  ['noul criteria with other keys', { state: 'x', questions: { done: { type: 'noul', instructions: 'Is `state` done?', criteria: { yes: 'a', no: 'b' } } } }, /noul criteria must be exactly \{ true, false \}/],
]

test('a request the client refuses is an Error that says what is wrong and what to do, and nothing is sent', async () => {
  const w = await world()
  for (const [what, args, pattern] of REFUSED) {
    const message = await refused(w, args)
    assert.match(message, pattern, what)
    assert.match(message, /fix it and call ask_judge again/, what)
  }
  assert.equal(w.jev.requests.length, 0, 'no refused request was sent')
})

test('the errors are plain Errors from the tool, with the client\'s message in them', async () => {
  const w = await world()
  const tool = w.tool()!
  const exec = { agent: MAIN, callId: 'call-x', signal: new AbortController().signal } as never
  await assert.rejects(tool.execute({ state: 'x', questions: { Done: { type: 'noul', instructions: 'i' } } }, exec), (error: Error) => {
    assert.equal(error.constructor, Error)
    assert.equal(error.message, 'the judge request is not valid: question id "Done" must be lower-case letters, digits and underscores, starting with a letter (/^[a-z][a-z0-9_]*$/); fix it and call ask_judge again')
    return true
  })
})

test('more than 20 questions, or none, is refused with the range, and says how to split', async () => {
  const w = await world()
  const many = Object.fromEntries(Array.from({ length: MAX_QUESTIONS + 1 }, (_, i) => [`q${i}`, { type: 'noul', instructions: 'Is `state` fine?' }]))
  const message = await refused(w, { state: 'x', questions: many })
  assert.match(message, /at most 20 in a call, got 21/)
  assert.match(message, /second call/)
  assert.equal(MAX_QUESTIONS, 20)
  // Exactly 20 goes through.
  const twenty = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`q${i}`, { type: 'noul', instructions: 'Is `state` fine?' }]))
  w.jev.always(answered(Object.fromEntries(Object.keys(twenty).map(id => [id, noulAnswer(0.5)]))))
  const result = await w.call({ state: 'x', questions: twenty })
  assert.equal(result.isError, false, textOf(result))
  assert.equal(Object.keys(result.value.answers).length, 20)
  assert.match(await refused(w, { state: 'x', questions: {} }), /at least one question \(1–20 in a call\)/)
})

test('state must be a string or a JSON object: a number, a list and null are refused by the schema, naming state', async () => {
  const w = await world()
  for (const state of [42, true, null, ['a', 'b']]) {
    const message = await refused(w, { state, questions: NOUL })
    assert.match(message, /"state" must match exactly one oneOf branch/, JSON.stringify(state))
  }
  assert.equal(w.jev.requests.length, 0)
  // The schema is where it is said, so the model has the types in its tool definition: a string, or an object.
  const state = (w.tool()!.parameters as { properties: { state: { oneOf: Array<{ type: string }> } } }).properties.state
  assert.deepEqual(state.oneOf.map(branch => branch.type), ['string', 'object'])
  assert.match(JSON.stringify(state), /put a list in an object/)
})

test('an empty state is refused: there is nothing to judge, and an answer about nothing would look like an answer', async () => {
  const w = await world()
  const tool = w.tool()!
  const exec = { agent: MAIN, callId: 'call-x', signal: new AbortController().signal } as never
  for (const state of ['', '   \n', {}]) {
    await assert.rejects(tool.execute({ state, questions: NOUL }, exec), (error: Error) => {
      assert.match(error.message, /state is empty: pass the text or object to judge/)
      return true
    })
  }
  assert.equal(w.jev.requests.length, 0)
})

test('a state of more than 100 KB is too large: the message says to send an excerpt, and the line says too-big', async () => {
  const w = await world()
  const message = await refused(w, { state: 'x'.repeat(100 * 1024 + 1), questions: NOUL })
  assert.equal(message, TOO_BIG)
  assert.equal(w.jev.requests.length, 0)
  const [line] = await w.lines()
  assert.equal(line!.decision, 'too-big')
})

test('TypeSafe\'s own max_tokens_exceeded is the same: too large, and the same words', async () => {
  const w = await world()
  w.jev.always({ kind: 'status', status: 400, body: JSON.stringify({ detail: { error_type: 'max_tokens_exceeded' } }) })
  const message = await refused(w, { state: 'a state of a few thousand tokens', questions: NOUL })
  assert.equal(message, TOO_BIG)
  assert.equal(w.jev.requests.length, 1)
  assert.equal((await w.lines())[0]!.decision, 'too-big')
})

test('a 90 KB state that TypeSafe refuses for its tokens (dense code or JSON) is too large, and says to send less of it than 100 KB', async () => {
  const w = await world()
  w.jev.always({ kind: 'status', status: 400, body: JSON.stringify({ detail: { error_type: 'max_tokens_exceeded' } }) })
  // Under the client's own 100 KB, so it is sent, and TypeSafe is the one to say no.
  const message = await refused(w, { state: 'const a=[1,2,3];'.repeat(Math.floor(90 * 1024 / 16)), questions: NOUL })
  assert.equal(message, TOO_BIG)
  assert.match(message, /less of code or JSON/)
  assert.equal(w.jev.requests.length, 1, 'the client let it through')
  assert.ok(w.jev.requests[0]!.text.length > 85 * 1024)
  assert.equal((await w.lines())[0]!.decision, 'too-big')
})

// --- the judge is unavailable ---------------------------------------------------------------------

const UNAVAILABLE = /^the judge is unavailable: .+; continue without it$/s

test('with no key the tool says the judge is unavailable and to continue without it', async () => {
  const w = await world({ key: undefined })
  const message = await refused(w, { state: 'x', questions: NOUL })
  assert.match(message, UNAVAILABLE)
  assert.match(message, /no TypeSafe key/)
  assert.equal(w.jev.requests.length, 0)
})

test('a failing Jev (a 500, a refused key, a malformed answer, a dropped connection, an overload) is unavailable, with its reason', async () => {
  const w = await world()
  const cases: Array<[string, Parameters<FakeJev['always']>[0], RegExp]> = [
    ['500', { kind: 'status', status: 500, body: 'down' }, /HTTP 500/],
    ['401', { kind: 'status', status: 401 }, /key was refused/],
    ['malformed', { kind: 'malformed' }, /malformed/],
    ['drop', { kind: 'drop' }, /could not reach TypeSafe/],
    // Last: it puts Jev out of use for a while, and the next call in that time is unavailable too.
    ['529', { kind: 'status', status: 529, headers: { 'retry-after': '1' } }, /overloaded/],
  ]
  for (const [what, behaviour, reason] of cases) {
    w.jev.always(behaviour)
    const message = await refused(w, { state: 'x', questions: NOUL })
    assert.match(message, UNAVAILABLE, what)
    assert.match(message, reason, what)
  }
  assert.match(await refused(w, { state: 'x', questions: NOUL }), /asked for a pause/)
})

test('a call that takes longer than the time limit is unavailable', async () => {
  const w = await world()
  w.jev.always({ kind: 'answer', body: jevBody({ complete: noulAnswer(0.5) }), delayMs: 2000 })
  const timeout = (await w.ctx.dishJudge.settings()).timeoutMs
  assert.equal(timeout, 2000)
  const started = Date.now()
  const message = await refused(w, { state: 'x', questions: NOUL })
  assert.match(message, UNAVAILABLE)
  assert.match(message, /timed out after 2000 ms/)
  assert.ok(Date.now() - started < 3500)
})

test('a server refusal such as an unknown model is the judge\'s configuration, not the model\'s mistake: unavailable, with the reason', async () => {
  const w = await world()
  w.jev.always({ kind: 'status', status: 400, body: JSON.stringify({ detail: { error_type: 'invalid_request_error', message: 'Unknown model: jev-0.0.0' } }) })
  const message = await refused(w, { state: 'x', questions: NOUL })
  assert.match(message, UNAVAILABLE)
  assert.match(message, /HTTP 400.*Unknown model/)
  assert.doesNotMatch(message, /fix it and call ask_judge again/)
  assert.equal((await w.lines())[0]!.decision, 'unavailable')
  // The same for a 422.
  w.jev.always({ kind: 'status', status: 422, body: JSON.stringify({ detail: [{ type: 'missing', loc: ['body', 'model'], msg: 'Field required', input: 'THE STATE TEXT' }] }) })
  const second = await refused(w, { state: 'THE STATE TEXT', questions: NOUL })
  assert.match(second, UNAVAILABLE)
  assert.match(second, /model: Field required/)
  assert.doesNotMatch(second, /THE STATE TEXT/)
})

test('a cancelled call is unavailable, and never reaches Jev', async () => {
  const w = await world()
  const controller = new AbortController()
  controller.abort()
  const result = await w.call({ state: 'x', questions: NOUL }, MAIN, controller.signal)
  assert.equal(result.isError, true)
  assert.equal(w.jev.requests.length, 0)
})

test('the key is in none of the errors', async () => {
  const w = await world()
  w.jev.always({ kind: 'status', status: 500, body: `echoed ${KEY} and ${encodeURIComponent(KEY)}` })
  const message = await refused(w, { state: 'x', questions: NOUL })
  assert.match(message, UNAVAILABLE)
  assert.ok(!message.includes(KEY))
  for (const [, args] of REFUSED.slice(0, 3)) assert.ok(!(await refused(w, args)).includes(KEY))
})

test('with no judge service the tool says it is unavailable, and does not throw anything else', async () => {
  const tool = askJudgeTool(() => undefined)
  const exec = { agent: MAIN, callId: 'call-x', signal: new AbortController().signal } as never
  await assert.rejects(tool.execute({ state: 'x', questions: NOUL }, exec), (error: Error) => {
    assert.match(error.message, UNAVAILABLE)
    return true
  })
})

// --- the log --------------------------------------------------------------------------------------

test('every call to Jev is one line: purpose ask, tool and subject ask_judge, the agent, the call id, the decision and the answers', async () => {
  const w = await world()
  w.jev.always(answered({ complete: noulAnswer(0.93) }))
  const result = await w.call({ state: 'SECRET-LOOKING STATE TEXT', questions: NOUL })
  assert.equal(result.isError, false)
  const lines = await w.lines()
  assert.equal(lines.length, 1)
  const [line] = lines
  assert.deepEqual({ ...line!, at: 0, latencyMs: typeof line!.latencyMs }, {
    at: 0, purpose: 'ask', agent: 'sess-main', child: false, tool: 'ask_judge', callId: 'call-1', subject: 'ask_judge',
    answers: { complete: { type: 'noul', noul: 0.93 } }, decision: 'answered', latencyMs: 'number', error: null,
  })
})

test('the line says child for a crew child\'s call, and the child\'s own session id', async () => {
  const w = await world()
  w.jev.always(answered({ complete: noulAnswer(0.2) }))
  await w.call({ state: 'x', questions: NOUL }, CHILD)
  const [line] = await w.lines()
  assert.equal(line!.agent, 'sess-child')
  assert.equal(line!.child, true)
})

test('the state is not in the log, not even for a refused call, and nothing but the client writes lines', async () => {
  const w = await world()
  const marker = 'zebra-marker-state-text-7731'
  w.jev.queue(answered({ complete: noulAnswer(0.4) }), { kind: 'status', status: 500, body: 'down' })
  await w.call({ state: marker, questions: NOUL })
  await refused(w, { state: marker, questions: NOUL })
  // A refusal of the client's own.
  await refused(w, { state: marker, questions: { Bad: { type: 'noul', instructions: 'Is `state` fine?' } } })
  const lines = await w.lines()
  assert.deepEqual(lines.map(line => line.decision), ['answered', 'unavailable', 'refused'])
  assert.ok(lines.every(line => line.subject === 'ask_judge'))
  assert.ok(!JSON.stringify(lines).includes(marker))
  for (const file of await readdir(w.where.state)) {
    if (file.endsWith('.jsonl')) assert.ok(!(await readFile(join(w.where.state, file), 'utf8')).includes(marker), file)
  }
})

test('the decisions are answered, refused, unavailable and too-big', async () => {
  const w = await world()
  w.jev.queue(answered({ complete: noulAnswer(0.4) }), { kind: 'status', status: 503 })
  await w.call({ state: 'x', questions: NOUL })
  await refused(w, { state: 'x', questions: NOUL })
  await refused(w, { state: 'x', questions: { done: { type: 'rank', instructions: 'i' } } })
  await refused(w, { state: 'x'.repeat(200 * 1024), questions: NOUL })
  assert.deepEqual((await w.lines()).map(line => line.decision), ['answered', 'unavailable', 'refused', 'too-big'])
})

test('a refusal the tool makes itself (21 questions, an empty state) makes no call and writes no line', async () => {
  const w = await world()
  const tool = w.tool()!
  const exec = { agent: MAIN, callId: 'call-x', signal: new AbortController().signal } as never
  const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`q${i}`, { type: 'noul', instructions: 'Is `state` fine?' }]))
  await assert.rejects(tool.execute({ state: 'x', questions: many }, exec))
  await assert.rejects(tool.execute({ state: '', questions: NOUL }, exec))
  assert.deepEqual(await w.lines(), [])
})

// --- global: every agent sees it ------------------------------------------------------------------

const names = (ctx: Context, scope: object): string[] => ctx.tools.schemas(scope).map(schema => schema.name).sort()

test('the tool is global: a child scope under a preset sees it, can have its allow list name it, and can call it', async () => {
  const w = await world()
  w.jev.always(answered({ complete: noulAnswer(0.7) }))
  let owner!: Context
  disposables.push(await w.ctx.plugin({ name: 'scope-owner', inject: ['tools'], apply(own: Context) { owner = own } } as never, undefined as never))
  // A preset with tools of its own, which an agent's scope joins, as dsh makes them; a child's scope is under the same preset.
  const presetKey = {}
  const preset = createScope(owner, presetKey)
  disposables.push(preset)
  const stub = (name: string) => ({ name, description: name, parameters: {}, output: { schema: { type: 'object', additionalProperties: false, properties: {} }, render: () => [] }, async execute() { return {} } }) as unknown as ToolDefinition
  preset.ctx.tools.register(stub('read'))
  // A child of its own: the scope is keyed by the agent object.
  const child = { ...CHILD }
  const childScope = createScope(owner, child, { parent: presetKey })
  disposables.push(childScope)
  assert.deepEqual(names(w.ctx, child), ['ask_judge', 'read'])
  // crew's allow list for a child names it: restrict() throws on a name that isn't a global or inherited tool.
  assert.doesNotThrow(() => childScope.ctx.tools.restrict({ allow: ['read', 'ask_judge'] }))
  assert.deepEqual(names(w.ctx, child), ['ask_judge', 'read'])
  const result = await w.call({ state: 'x', questions: NOUL }, child)
  assert.equal(result.isError, false, textOf(result))
  assert.deepEqual(result.value, { answers: { complete: { type: 'noul', noul: 0.7 } } })
  assert.equal((await w.lines())[0]!.child, true)
})

test('the tool registers when a tools service appears, and goes when it does; with none the plugin loads all the same', async () => {
  const ctx = new Context()
  const where = await dirs()
  const handle = mountJudge(ctx, where.state)
  await handle
  disposables.push(handle)
  assert.equal(ctx.get('judge') !== undefined, true)
  assert.equal(ctx.get('tools'), undefined)
  // Tools arrive later: the tool is there.
  disposables.push(await provideStub(ctx, 'systemPrompt', { tools() {}, section() {}, getSectionOrder: () => 1 }))
  const runtime = await ctx.plugin(ToolRuntime, {})
  assert.ok(ctx.tools.get('ask_judge'))
  // And goes with them.
  await runtime.dispose()
  assert.equal(ctx.get('tools'), undefined)
  // A new registry has it again, from the plugin that is still loaded.
  const again = await ctx.plugin(ToolRuntime, {})
  assert.ok(ctx.tools.get('ask_judge'))
  await again.dispose()
})

test('the tool is registered before the startup prune of the log, which can\'t hold it back; until the judge is provided it says the judge is not running', async () => {
  const ctx = new Context()
  const where = await dirs()
  disposables.push(await provideStub(ctx, 'systemPrompt', { tools() {}, section() {}, getSectionOrder: () => 1 }))
  disposables.push(await ctx.plugin(ToolRuntime, {}))
  // A prune that doesn't finish until the test lets it: the plugin waits on it before it provides the judge.
  const original = JudgeLog.prototype.prune
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  JudgeLog.prototype.prune = async () => { await gate; return { days: 0, withheld: 0 } }
  try {
    const handle = mountJudge(ctx, where.state)
    disposables.push(handle)
    await waitFor('ask_judge to be registered', () => ctx.tools.get('ask_judge'))
    assert.equal(ctx.get('judge'), undefined, 'the prune is still going, so the judge is still to come')
    const early = await ctx.tools.execute({ callId: 'early' as never, name: 'ask_judge', arguments: { state: 'x', questions: NOUL }, agent: MAIN as never, signal: new AbortController().signal }) as unknown as Result
    assert.equal(early.isError, true)
    assert.match(textOf(early), /the judge is unavailable: it is not running; continue without it/)
    release()
    await handle
    assert.ok(ctx.get('judge'))
    assert.ok(ctx.tools.get('ask_judge'))
  } finally {
    JudgeLog.prototype.prune = original
    release()
  }
})

test('the tool goes with the plugin', async () => {
  const ctx = new Context()
  disposables.push(await provideStub(ctx, 'systemPrompt', { tools() {}, section() {}, getSectionOrder: () => 1 }))
  disposables.push(await ctx.plugin(ToolRuntime, {}))
  const where = await dirs()
  const handle = mountJudge(ctx, where.state)
  await handle
  assert.ok(ctx.tools.get('ask_judge'))
  await handle.dispose()
  assert.equal(ctx.tools.get('ask_judge'), undefined)
})

// --- what the tool hands the client -----------------------------------------------------------------

test('the client is handed the purpose, the agent, the signal, the call id, the tool and the subject, and a decide that names what happened', async () => {
  let seen: any
  const stub = {
    async ask(request: any) {
      seen = request
      return { ok: true, answers: { complete: { type: 'noul', noul: 0.1 } }, latencyMs: 1 }
    },
    async status() { throw new Error('not asked') },
  }
  const controller = new AbortController()
  const exec = { agent: CHILD, callId: 'call-7', signal: controller.signal } as never
  const value = await askJudgeTool(() => stub as never).execute({ state: 'x', questions: NOUL }, exec)
  assert.deepEqual(value, { answers: { complete: { type: 'noul', noul: 0.1 } } })
  assert.equal(seen.purpose, 'ask')
  assert.equal(seen.agent, CHILD)
  assert.equal(seen.signal, controller.signal)
  assert.equal(seen.callId, 'call-7')
  assert.equal(seen.tool, 'ask_judge')
  assert.equal(seen.subject, 'ask_judge')
  assert.equal(seen.state, 'x')
  const decided = (result: unknown) => seen.decide(result)
  assert.deepEqual(decided({ ok: true, answers: {}, latencyMs: 1 }), { decision: 'answered' })
  assert.deepEqual(decided({ ok: false, reason: 'invalid', from: 'request', message: 'm' }), { decision: 'refused' })
  assert.deepEqual(decided({ ok: false, reason: 'invalid', from: 'request', message: 'm', tooBig: true }), { decision: 'too-big' })
  assert.deepEqual(decided({ ok: false, reason: 'invalid', from: 'server', message: 'm', tooBig: true }), { decision: 'too-big' })
  assert.deepEqual(decided({ ok: false, reason: 'invalid', from: 'server', message: 'm' }), { decision: 'unavailable' })
  assert.deepEqual(decided({ ok: false, reason: 'unavailable', message: 'm' }), { decision: 'unavailable' })
})

test('the judge is looked up on each call: the one that is there at the time is asked', async () => {
  const answering = (noul: number) => ({ async ask() { return { ok: true, answers: { complete: { type: 'noul', noul } }, latencyMs: 1 } } })
  let current: unknown = answering(0.1)
  const tool = askJudgeTool(() => current as never)
  const exec = { agent: MAIN, callId: 'call-x', signal: new AbortController().signal } as never
  assert.deepEqual(await tool.execute({ state: 'x', questions: NOUL }, exec), { answers: { complete: { type: 'noul', noul: 0.1 } } })
  current = answering(0.9)
  assert.deepEqual(await tool.execute({ state: 'x', questions: NOUL }, exec), { answers: { complete: { type: 'noul', noul: 0.9 } } })
  current = undefined
  await assert.rejects(tool.execute({ state: 'x', questions: NOUL }, exec), /the judge is unavailable: it is not running; continue without it/)
})
