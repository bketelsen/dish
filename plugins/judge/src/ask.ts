/**
 * `ask_judge`: the agents' own door to the judge. One global tool, so every agent sees it (a crew child through its allow
 * list, which names it): it puts typed questions about some material to Jev and gives back numbers.
 *
 * What it does, and what it leaves to the client:
 *
 * - **Checks of its own, before the call:** one to 20 questions, and a `state` with something in it. That the state is a
 *   string or a JSON object (not a list) is the tool schema's, which the registry enforces. Everything else (ids, types,
 *   options, levels, instructions, sizes) is the client's to check, once, so there is a single source of truth: the
 *   client's message, which names the problem, is passed on with a hint.
 * - **Empty strings are absent.** Models fill every optional field, often with `''`: a noul's empty criteria are left out,
 *   and a choice option's empty description is `null`.
 * - **Errors that say what to do next.** A request the client refused is an `Error` that names the fix. A judge that can't
 *   be had (no key, a failure, a time out, and a refusal from TypeSafe itself such as an unknown model, which is the
 *   user's configuration and not the model's mistake) is `the judge is unavailable: <reason>; continue without it`: nothing
 *   fails closed here, the agent decides. A state that is too big says to send an excerpt.
 * - **One log line per call, written by the client.** The tool hands the client a `decide` hook, which puts `answered`,
 *   `refused`, `unavailable` or `too-big` on the line, with the subject `ask_judge`. The state is never logged, and the tool
 *   writes no line of its own: a refusal it makes before any call (too many questions, an empty state, an argument the
 *   registry's schema refuses) is no call.
 * - **Scores get `normalized`**, `score / (levels - 1)` rounded to three places, so an agent can compare scales.
 *
 * @module dish-judge/ask
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Answer, Judge, JudgeResult, JsonValue, Question } from './client.ts'

/** The tool's name. The command gate leaves it alone, and crew's roles list it. */
export const ASK_JUDGE_TOOL = 'ask_judge'

/** The most questions in one call: a model that wants more splits them over calls. */
export const MAX_QUESTIONS = 20

/**
 * What an agent is told about a state that is too big, whether this client or TypeSafe said so. TypeSafe counts tokens, so
 * dense state (code, JSON) can be refused well under the client's 100 KB: the advice is to send less, not just under that.
 */
const TOO_BIG = 'the state is too large for the judge: send a smaller excerpt with only the part that matters (at most about 100 KB of prose, less of code or JSON)'

/** What goes into every agent's prompt: kept to what changes how it asks. */
export const ASK_JUDGE_DESCRIPTION = [
  'Ask a fast, cheap judge (TypeSafe\'s Jev) typed questions about some material. It answers in about 200 ms with numbers only, never an explanation: a second opinion for snap judgments you would otherwise eyeball, not a proof.',
  '',
  'One call takes one `state` (the material: text, a diff, a stack trace, or an object) and 1–20 `questions`, answered together. In each question\'s `instructions`, refer to `state` (or a field of it) in backticks. A question is { type, instructions, criteria }:',
  '- noul (yes/no): returns P(yes), 0 to 1. `criteria` is optional: { true, false }, what each answer means.',
  '- choice (pick one): `criteria` maps 2–255 option names (1–64 characters) to a short description or null. Returns the likeliest option, every option\'s probability and a confidence.',
  '- score (rate on a rubric): `criteria` lists 2–10 levels, low to high. Returns `score` from 0 to levels-1 (it can fall between levels), `normalized` (0 to 1), probabilities and a confidence.',
  '',
  'Phrase each question as one snap judgment: describe situations, not degrees, and spell them out. Abstract words read as strict: "Is the error handling complete?" gave 0.19 for sound code, where "Is every call that can fail inside a try/catch that handles or rethrows the error?" gave 0.76. Phrase it so a high value means yes, and avoid negations: a question and its negation don\'t sum to 1. Always include `other` in a choice. Keep counting, arithmetic and dates in your own code. Send only what matters in `state`: a large state full of irrelevant detail makes answers worse.',
  '',
  'Jev isn\'t deterministic (repeats move by a few hundredths), so read answers as bands, not exact cuts: below 0.3 is no, above 0.7 is yes, in between look for yourself.',
  '',
  'Examples:',
  '- noul, `state` is a function: { "handled": { "type": "noul", "instructions": "Is every call in `state` that can fail inside a try/catch that handles or rethrows the error?" } }',
  '- choice, `state` is a stack trace: { "owner": { "type": "choice", "instructions": "Which file contains the code that threw the error in `state`?", "criteria": { "src/parse.ts": null, "src/render.ts": null, "other": null } } }',
  '- score, `state` is a diff: { "ready": { "type": "score", "instructions": "How ready to merge is the change in `state`?", "criteria": ["not ready: broken or unclear", "needs work: works but untested", "nearly: tested, with naming or size problems", "ready: small, tested and clearly named"] } }',
  '',
  '`state` goes to TypeSafe; known secret patterns are masked first, but leave other secrets out.',
].join('\n')

/** A plain object, like what `JSON.parse` makes or an object literal is. */
function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** A string with nothing in it: what a model leaves where it has nothing to say. */
const blank = (value: unknown): boolean => typeof value === 'string' && value.trim() === ''

/** The error for a request that can't go: its message, and what to do about it. */
function refusal(message: string): Error {
  return new Error(`the judge request is not valid: ${message}; fix it and call ${ASK_JUDGE_TOOL} again`)
}

/**
 * One question with what the model left empty taken out: a noul's criteria that are an empty string, `null`, `{}`, `[]` or
 * `{ true, false }` with only empty strings or `null` in it are not there, and a choice option's empty description is `null`. Anything that isn't the shape
 * of a question is left as it is, for the client to refuse in words.
 */
function cleaned(question: unknown): unknown {
  if (!isRecord(question)) return question
  const { criteria } = question
  if (question.type === 'noul') {
    const empty = criteria === undefined || criteria === null || blank(criteria)
      || (Array.isArray(criteria) && criteria.length === 0)
      || (isRecord(criteria) && Object.values(criteria).every(value => value === null || blank(value)))
    if (!empty) return question
    const { criteria: _left, ...rest } = question
    return rest
  }
  if (question.type === 'choice' && isRecord(criteria)) {
    return { ...question, criteria: Object.fromEntries(Object.entries(criteria).map(([option, description]) => [option, blank(description) ? null : description])) }
  }
  return question
}

/**
 * What goes to the client for the model's `questions`: each question cleaned. The registry has checked that `questions` is
 * an object; what is in each question is the client's to check.
 * @throws a refusal for none, or more than `MAX_QUESTIONS`.
 */
function questionsFor(questions: Record<string, unknown>): Record<string, unknown> {
  const count = Object.keys(questions).length
  if (count === 0) throw refusal(`questions: send at least one question (1–${MAX_QUESTIONS} in a call)`)
  if (count > MAX_QUESTIONS) throw refusal(`questions: at most ${MAX_QUESTIONS} in a call, got ${count}; ask the most important ones first and make a second call for the rest`)
  return Object.fromEntries(Object.entries(questions).map(([id, question]) => [id, cleaned(question)]))
}

/**
 * The state as the client takes it. The registry has checked that it is a string or an object (and a list is refused there,
 * by the schema); this is for one with nothing in it, which an answer would only pretend to be about.
 * @throws a refusal for a blank string or an object with no fields.
 */
function stateFor(state: string | Record<string, JsonValue>): JsonValue {
  const empty = typeof state === 'string' ? state.trim() === '' : Object.keys(state).length === 0
  if (empty) throw refusal('state is empty: pass the text or object to judge')
  return state
}

/** `score / (levels - 1)`, to three places. */
function normalize(score: number, levels: number): number {
  return Math.round(score / (levels - 1) * 1000) / 1000
}

/** An answer as the model gets it: what the client checked, and for a score, where on its scale it falls. */
function shown(answer: Answer, question: unknown): JsonValue {
  if (answer.type !== 'score') return answer
  const levels = isRecord(question) && Array.isArray(question.criteria) ? question.criteria.length : 0
  return { type: 'score', score: answer.score, normalized: levels > 1 ? normalize(answer.score, levels) : answer.score, probabilities: answer.probabilities, confidence: answer.confidence }
}

/** What the log line says was decided for this call. */
function decision(result: JudgeResult): { decision: 'answered' | 'refused' | 'unavailable' | 'too-big' } {
  if (result.ok) return { decision: 'answered' }
  if (result.tooBig === true) return { decision: 'too-big' }
  return { decision: result.reason === 'invalid' && result.from === 'request' ? 'refused' : 'unavailable' }
}

/**
 * The tool, over `judge`: a function, read on every call, so that the judge is the one that is there at the time. It is a
 * service the plugin that registers this does not inject, so the caller reads it with `ctx.get`. With none, the tool says
 * the judge is unavailable.
 */
export function askJudgeTool(judge: () => Judge | undefined): ToolDefinition {
  return defineTool({
    name: ASK_JUDGE_TOOL,
    description: ASK_JUDGE_DESCRIPTION,
    parameters: {
      state: {
        oneOf: [{ type: 'string' }, { type: 'object', additionalProperties: true }],
        required: true,
        description: 'The material to judge: a string (text, a diff, a stack trace) or a JSON object whose fields the questions can name (put a list in an object, like { "files": [...] }). At most about 100 KB: send only the part that matters.',
      },
      questions: {
        type: 'object',
        additionalProperties: true,
        required: true,
        description: '1–20 questions keyed by id (lower-case letters, digits and underscores, starting with a letter). Each is { type: "noul" | "choice" | "score", instructions, criteria }; see the tool description.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          answers: { type: 'object', additionalProperties: true, required: true, description: 'One answer for each question id: numbers only, with no explanation.' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    // It mutates nothing of the parent's: each call is its own request, so parallel calls run together.
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const questions = questionsFor(args.questions)
      const state = stateFor(args.state)
      const service = judge()
      if (service === undefined) throw new Error('the judge is unavailable: it is not running; continue without it')
      const result = await service.ask({
        state,
        questions: questions as Record<string, Question>,
        purpose: 'ask',
        agent: exec.agent,
        signal: exec.signal,
        tool: ASK_JUDGE_TOOL,
        callId: exec.callId,
        subject: ASK_JUDGE_TOOL,
        decide: decision,
      })
      if (result.ok) {
        return { answers: Object.fromEntries(Object.entries(result.answers).map(([id, answer]) => [id, shown(answer, questions[id])])) }
      }
      if (result.tooBig === true) throw new Error(TOO_BIG)
      if (result.reason === 'invalid' && result.from === 'request') throw refusal(result.message)
      throw new Error(`the judge is unavailable: ${result.message}; continue without it`)
    },
  })
}
