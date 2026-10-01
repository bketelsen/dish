/**
 * Live checks of `ask_judge` against the real TypeSafe API, through the tool as an agent would call it (dsh's real tool
 * registry, arguments validated, the output schema enforced): a noul, a choice with `other`, a 5-level score, a request the
 * tool refuses, and a request TypeSafe refuses (an unknown model).
 *
 * Not part of `pnpm test`: run it with `pnpm --filter dish-judge test:live`, with `TYPESAFE_API_KEY` in the environment.
 * Without it every test here skips, with a message saying so. Jev costs $0.042 per million input tokens: a run is a
 * fraction of a cent. The key is never printed: nothing here writes it, and every output string is checked for it.
 *
 * Jev isn't deterministic (it moves by hundredths), so the assertions are broad: shapes, and which side of a wide band an
 * answer falls on. The probabilities are printed in a table at the end, to calibrate the tool's advice from.
 */
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { ASK_JUDGE_TOOL, askJudgeTool } from '../src/ask.ts'
import { createJudge } from '../src/client.ts'
import type { LogLine } from '../src/client.ts'
import { DEFAULT_SETTINGS } from '../src/settings.ts'
import { provideStub } from '../test/helpers.ts'

const KEY = process.env.TYPESAFE_API_KEY?.trim()
const SKIP = KEY === undefined || KEY === ''
  ? 'TYPESAFE_API_KEY is not set: put it in the environment to run the live tests (pnpm --filter dish-judge test:live)'
  : false
const BASE_URL = 'https://api.typesafe.ai'

const AGENT = { id: 'sess-live', session: { header: { id: 'sess-live', delegationDepth: 0 } } }

type Result = { isError: boolean, content: Array<{ type: string, text?: string }>, value?: any }
const textOf = (result: Result): string => result.content.map(block => block.type === 'text' ? block.text ?? '' : '').join('\n')

/** Every string anywhere in `value`, keys included. */
function stringsIn(value: unknown, into: string[] = []): string[] {
  if (typeof value === 'string') into.push(value)
  else if (Array.isArray(value)) for (const item of value) stringsIn(item, into)
  else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) { into.push(key); stringsIn(item, into) }
  }
  return into
}

/** What every test shows at the end, for the table. */
const rows: Array<{ case: string, expected: string, got: string, ms: string }> = []
const row = (name: string, expected: string, got: string, ms: number | null) => { rows.push({ case: name, expected, got, ms: ms === null ? '-' : String(ms) }) }

after(() => {
  if (rows.length === 0) return
  const widths = (['case', 'expected', 'got', 'ms'] as const).map(key => Math.max(key.length, ...rows.map(r => r[key].length)))
  const line = (cells: string[]) => cells.map((cell, index) => cell.padEnd(widths[index]!)).join('  ')
  console.log(['', line(['case', 'expected', 'got', 'ms']), line(widths.map(width => '-'.repeat(width))), ...rows.map(r => line([r.case, r.expected, r.got, r.ms]))].join('\n'))
})

interface Live {
  /** One call of ask_judge through the registry, as the main agent. */
  call(args: unknown): Promise<Result>
  /** The log lines the client wrote. */
  lines: LogLine[]
}

/** dsh's tool registry with ask_judge over a client that talks to the real API, as `model` (the shipped one by default). */
async function live(model: string = DEFAULT_SETTINGS.model): Promise<Live> {
  const lines: LogLine[] = []
  const judge = createJudge({
    baseUrl: BASE_URL,
    key: async () => KEY,
    settings: async () => ({ ...DEFAULT_SETTINGS, model }),
    log: (line) => { lines.push(structuredClone(line)) },
  })
  const ctx = new Context()
  await provideStub(ctx, 'systemPrompt', { tools() {}, section() {}, getSectionOrder: () => 1 })
  await ctx.plugin(ToolRuntime, {})
  ctx.tools.register(askJudgeTool(() => judge))
  let counter = 0
  return {
    lines,
    call: args => ctx.tools.execute({ callId: `live-${++counter}` as never, name: ASK_JUDGE_TOOL, arguments: args, agent: AGENT as never, signal: new AbortController().signal }) as unknown as Promise<Result>,
  }
}

function noLeak(...outputs: unknown[]): void {
  for (const text of stringsIn(outputs)) assert.ok(!text.includes(KEY ?? '\u0000no key\u0000'), 'the key leaked into a string the tool produced')
}

const WITH_TRY = `async function loadConfig(path) {
  try {
    const text = await fs.readFile(path, 'utf8')
    return JSON.parse(text)
  } catch (error) {
    if (error.code === 'ENOENT') return {}
    throw new Error(\`cannot load config \${path}: \${error.message}\`)
  }
}`

/** The first call can fail and is handled; the second can fail and isn't. */
const PARTIAL_TRY = `async function loadConfig(path) {
  let text
  try {
    text = await fs.readFile(path, 'utf8')
  } catch (error) {
    return {}
  }
  return JSON.parse(text)
}`

const WITHOUT_TRY = `async function loadConfig(path) {
  const text = await fs.readFile(path, 'utf8')
  return JSON.parse(text)
}`

// The wording of the tool description's own example: a situation, spelled out. "Is the error handling complete?" read 0.19 for
// the code with a try/catch, which is why the description says so.
const HANDLED = 'Is every call in `state` that can fail inside a try/catch that handles or rethrows the error?'

test('live: a noul about a function\'s error handling reads a full try/catch high, a partial one in between, and none low', { skip: SKIP, timeout: 30_000 }, async () => {
  const { call, lines } = await live()
  const questions = { handled: { type: 'noul', instructions: HANDLED } }
  const [withTry, partial, withoutTry] = [await call({ state: WITH_TRY, questions }), await call({ state: PARTIAL_TRY, questions }), await call({ state: WITHOUT_TRY, questions })]
  for (const result of [withTry, partial, withoutTry]) assert.equal(result.isError, false, textOf(result))
  const [high, middle, low] = [withTry, partial, withoutTry].map(result => result.value.answers.handled)
  for (const answer of [high, middle, low]) {
    assert.equal(answer.type, 'noul')
    assert.ok(answer.noul >= 0 && answer.noul <= 1)
  }
  row('noul: try/catch around both', '> 0.5', high.noul.toFixed(2), lines[0]?.latencyMs ?? null)
  row('noul: around one of two', 'between', middle.noul.toFixed(2), lines[1]?.latencyMs ?? null)
  row('noul: no try/catch', '< 0.3', low.noul.toFixed(2), lines[2]?.latencyMs ?? null)
  assert.ok(high.noul > 0.5, `with a try/catch: ${high.noul}`)
  assert.ok(low.noul < 0.3, `without one: ${low.noul}`)
  assert.ok(high.noul > middle.noul && middle.noul > low.noul, `with ${high.noul}, partial ${middle.noul}, without ${low.noul}`)
  assert.deepEqual(lines.map(line => [line.purpose, line.tool, line.subject, line.decision, line.error]), Array(3).fill(['ask', 'ask_judge', 'ask_judge', 'answered', null]))
  noLeak(withTry, partial, withoutTry, lines)
})

const TRACE = `TypeError: Cannot read properties of undefined (reading 'map')
    at renderRows (src/render/table.ts:41:18)
    at renderTable (src/render/table.ts:12:10)
    at main (src/cli/main.ts:27:5)`

const OTHER_TRACE = `Error: connect ECONNREFUSED 10.0.0.5:5432
    at Pool.connect (src/db/pool.ts:88:11)
    at runMigrations (src/db/migrate.ts:15:3)`

test('live: a choice with other picks the file that threw, and a trace in none of the files is other', { skip: SKIP, timeout: 30_000 }, async () => {
  const { call, lines } = await live()
  const criteria = { 'src/parse/csv.ts': 'parses the CSV text into rows', 'src/render/table.ts': 'draws rows as a table', 'src/cli/main.ts': 'reads arguments and calls the rest', other: null }
  const questions = { owner: { type: 'choice', instructions: 'Which file contains the code that threw the error in `state`?', criteria } }
  const owned = await call({ state: TRACE, questions })
  assert.equal(owned.isError, false, textOf(owned))
  const answer = owned.value.answers.owner
  assert.equal(answer.type, 'choice')
  assert.deepEqual(Object.keys(answer.probabilities).sort(), Object.keys(criteria).sort())
  const sum = Object.values(answer.probabilities as Record<string, number>).reduce((total, p) => total + p, 0)
  assert.ok(Math.abs(sum - 1) <= 0.025, `the probabilities sum to ${sum}`)
  assert.ok(answer.confidence >= 0 && answer.confidence <= 1)
  const top = (probabilities: Record<string, number>) => Object.entries(probabilities).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([option, p]) => `${option.split('/').pop()} ${p.toFixed(2)}`).join(', ')
  row('choice: stack trace', 'table.ts', `${answer.choice.split('/').pop()} (conf ${answer.confidence.toFixed(2)}): ${top(answer.probabilities)}`, lines[0]?.latencyMs ?? null)
  assert.equal(answer.choice, 'src/render/table.ts')
  assert.ok(answer.probabilities['src/render/table.ts'] >= 0.6, `table.ts got ${answer.probabilities['src/render/table.ts']}`)

  const elsewhere = await call({ state: OTHER_TRACE, questions })
  assert.equal(elsewhere.isError, false, textOf(elsewhere))
  const other = elsewhere.value.answers.owner
  row('choice: trace in none of them', 'other', `${other.choice.split('/').pop()} (conf ${other.confidence.toFixed(2)}): ${top(other.probabilities)}`, lines[1]?.latencyMs ?? null)
  assert.equal(other.choice, 'other')
  assert.ok(other.probabilities.other >= 0.6, `other got ${other.probabilities.other}`)
  noLeak(owned, elsewhere, lines)
})

const GOOD_DIFF = `diff --git a/src/slug.ts b/src/slug.ts
--- a/src/slug.ts
+++ b/src/slug.ts
@@ -3,3 +3,4 @@ export function slugify(title: string): string {
-  return title.toLowerCase().replace(/ /g, '-')
+  return title.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
 }
diff --git a/test/slug.test.ts b/test/slug.test.ts
+test('slugify trims, collapses punctuation and keeps digits', () => {
+  assert.equal(slugify('  Hello, World 2!  '), 'hello-world-2')
+})`

const NO_TEST_DIFF = `diff --git a/src/slug.ts b/src/slug.ts
--- a/src/slug.ts
+++ b/src/slug.ts
@@ -3,3 +3,4 @@ export function slugify(title: string): string {
-  return title.toLowerCase().replace(/ /g, '-')
+  return title.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
 }`

const BAD_DIFF = `diff --git a/src/a.ts b/src/a.ts
@@ -1,60 +1,240 @@
+function f2(x, y, z) { let tmp2 = x; let q = y; for (let i = 0; i < z; i++) { tmp2 = g(tmp2, q, i) } return tmp2 }
+const data1 = f2(a, b, c); const data2 = f2(data1, d, e); const data3 = f2(data2, f, g)
+// ... 230 more lines of the same, in one commit, with a rewrite of the config loader, the CLI and the parser
diff --git a/src/config.ts b/src/config.ts
@@ -1,80 +1,5 @@
-... the whole of the old loader, deleted
+export const c = () => ({})
diff --git a/src/cli.ts b/src/cli.ts
@@ -1,44 +1,120 @@
+let x1 = process.argv; let x2 = x1.slice(2); if (x2[0] == 'a') { doA(x2) } else if (x2[0] == 'b') { doB(x2) }`

test('live: a 5-level score of a diff against small, tested and named well orders a good diff, one without a test and a bad one', { skip: SKIP, timeout: 30_000 }, async () => {
  const { call, lines } = await live()
  const questions = {
    quality: {
      type: 'score',
      instructions: 'How many of these does `state` meet: small, tested, named well?',
      criteria: ['none of them', 'one of them', 'two of them', 'all three, with flaws', 'all three, cleanly'],
    },
  }
  const [good, noTest, bad] = [await call({ state: GOOD_DIFF, questions }), await call({ state: NO_TEST_DIFF, questions }), await call({ state: BAD_DIFF, questions })]
  for (const result of [good, noTest, bad]) assert.equal(result.isError, false, textOf(result))
  const [high, middle, low] = [good, noTest, bad].map(result => result.value.answers.quality)
  for (const answer of [high, middle, low]) {
    assert.equal(answer.type, 'score')
    assert.ok(answer.score >= 0 && answer.score <= 4)
    assert.equal(answer.normalized, Math.round(answer.score / 4 * 1000) / 1000)
    assert.deepEqual(Object.keys(answer.probabilities).sort(), ['0', '1', '2', '3', '4'])
    assert.ok(answer.confidence >= 0 && answer.confidence <= 1)
  }
  const shown = (answer: any) => `${answer.score.toFixed(2)} -> ${answer.normalized.toFixed(3)} (conf ${answer.confidence.toFixed(2)})`
  row('score: small, tested, named', 'normalized > 0.6', shown(high), lines[0]?.latencyMs ?? null)
  row('score: no test', 'between', shown(middle), lines[1]?.latencyMs ?? null)
  row('score: big, untested, x1/tmp2', 'normalized < 0.3', shown(low), lines[2]?.latencyMs ?? null)
  assert.ok(high.normalized > 0.6, `good ${high.normalized}`)
  assert.ok(low.normalized < 0.3, `bad ${low.normalized}`)
  assert.ok(high.normalized > middle.normalized && middle.normalized > low.normalized, `good ${high.normalized}, no test ${middle.normalized}, bad ${low.normalized}`)
  noLeak(good, noTest, bad, lines)
})

test('live: a request the tool refuses is an Error that names the fix, and nothing is sent to Jev', { skip: SKIP, timeout: 30_000 }, async () => {
  const { call, lines } = await live()
  const result = await call({ state: 'x', questions: { 'Not Valid': { type: 'noul', instructions: 'Is `state` fine?' } } })
  assert.equal(result.isError, true)
  const message = textOf(result)
  row('request-invalid', 'refused, no call', message.replace(/^Error: /, '').slice(0, 70), lines[0]?.latencyMs ?? null)
  assert.match(message, /question id "Not Valid" must be lower-case letters, digits and underscores/)
  assert.match(message, /fix it and call ask_judge again/)
  assert.deepEqual(lines.map(line => [line.decision, line.latencyMs]), [['refused', null]])
  noLeak(result, lines)
})

test('live: TypeSafe refusing the model is the judge being unavailable, with its own words, not the model\'s mistake', { skip: SKIP, timeout: 30_000 }, async () => {
  const { call, lines } = await live('jev-0.0.0-nonexistent')
  const result = await call({ state: 'x', questions: { fine: { type: 'noul', instructions: 'Is `state` fine?' } } })
  assert.equal(result.isError, true)
  const message = textOf(result)
  row('server-invalid (bad model)', 'unavailable', message.replace(/^Error: /, '').slice(0, 70), lines[0]?.latencyMs ?? null)
  assert.match(message, /^Error: the judge is unavailable: TypeSafe refused the request \(HTTP 400\)/)
  assert.match(message, /; continue without it$/)
  assert.doesNotMatch(message, /fix it and call/)
  assert.deepEqual(lines.map(line => line.decision), ['unavailable'])
  noLeak(result, lines)
})
