import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { defineTool, ToolRuntime } from '@deepseek-ai/dsh-tools'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import type { Answer, Decision, JudgeRequest, JudgeResult, LogLine } from '../src/client.ts'
import {
  commandGate, decideCommand, EFFECT_QUESTION, EFFECT_WITH_ESCALATION_QUESTION, isGated, MAX_TASK_CHARS, registerCommandGate, SERVES_TASK_QUESTION, taskOf,
  VERDICT_MAX_ENTRIES, VERDICT_TTL_MS, verdictOwner, VerdictCache,
} from '../src/gate.ts'
import type { CommandGateDeps, GateAgent } from '../src/gate.ts'
import { DEFAULT_SETTINGS, DEFAULT_TEXT, parseSettings } from '../src/settings.ts'
import type { JudgeSettings } from '../src/settings.ts'
import * as plugin from '../src/index.ts'
import { createSettingsReader } from '../src/index.ts'
import { choiceAnswer, dirs, jevBody, mountConfig, mountJudge, noulAnswer, provideStub, seeded, shippedWith, startFakeJev } from './helpers.ts'

// --- what the tests are made of -----------------------------------------------------------------------

const KEY = 'tsk-live-0123456789abcdef-test-key'

/** `JudgeResult` as the client would hand back for these probabilities and this P(serves the task). */
function answers(probabilities: Record<string, number>, serves: number): JudgeResult {
  const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]![0]
  const effect: Answer = { type: 'choice', choice, probabilities, confidence: 0.9 }
  return { ok: true, answers: { effect, serves_task: { type: 'noul', noul: serves } }, latencyMs: 12 }
}

const READ_ONLY = { read_only: 0.97, reversible: 0.02, irreversible: 0.01, other: 0 }
const REVERSIBLE = { read_only: 0.01, reversible: 0.96, irreversible: 0.02, other: 0.01 }
const IRREVERSIBLE = { read_only: 0.05, reversible: 0.08, irreversible: 0.87, other: 0 }
const DOWN: JudgeResult = { ok: false, reason: 'unavailable', message: 'TypeSafe answered HTTP 503' }

/** The settings of the shipped file, changed by `change`. */
function settingsWith(change: (document: Record<string, any>) => void): JudgeSettings {
  const parsed = parseSettings(shippedWith(change))
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.problem)
  return parsed.settings
}

/** The shipped settings with `tools.gated` as given: for lists `parseSettings` would refuse (a lone `*`), which the gate still reads as every tool. */
function gatedSettings(gated: string[]): JudgeSettings {
  return { ...DEFAULT_SETTINGS, tools: { ...DEFAULT_SETTINGS.tools, gated } }
}

/** A fake client with the real one's contract: `decide` is called with the result, and what it says comes back as `decided`. */
function fakeJudge(script: (request: JudgeRequest<any>) => JudgeResult | Promise<JudgeResult>, options: { skipDecide?: boolean, throws?: boolean } = {}) {
  const requests: Array<JudgeRequest<any>> = []
  /** What each call's `decide` said, as the client would put it on the log line. */
  const decisions: string[] = []
  return {
    requests,
    decisions,
    async ask(request: JudgeRequest<any>) {
      requests.push(request)
      if (options.throws === true) throw new Error('the fake judge fell over')
      const result = await script(request)
      if (options.skipDecide === true || request.decide === undefined) return result
      const decided = await request.decide(result, { signal: new AbortController().signal })
      decisions.push(decided.decision)
      return { ...result, decided } as JudgeResult & { decided?: Decision }
    },
    status: () => Promise.reject(new Error('not used')),
  }
}

/** A user message event, as dsh logs one: the text, and who it came from. */
function userEvent(seq: number, text: string, kind = 'user') {
  return { type: 'user/message', seq, time: 1_790_000_000_000 + seq, data: { id: `m${seq}`, role: 'user', content: [{ type: 'text', text }], source: { kind } } }
}

function otherEvent(seq: number, type = 'assistant/message') {
  return { type, seq, time: 1_790_000_000_000 + seq, data: { id: `m${seq}`, role: 'assistant', content: [{ type: 'text', text: 'ok' }], source: { kind: 'model' } } }
}

interface AgentOptions {
  id?: string
  cwd?: string
  /** A crew child, by the session header's `delegationDepth` and `origin`. */
  child?: boolean
  events?: unknown[]
  inheritedEventCount?: number
}

/** A dsh agent as far as the gate reads one. */
function agentOf(options: AgentOptions = {}): GateAgent {
  const id = options.id ?? (options.child === true ? 'child-1' : 'main-1')
  const events = options.events ?? []
  return {
    id,
    options: {},
    session: {
      id,
      header: {
        id,
        ...options.cwd === undefined ? {} : { cwd: options.cwd },
        ...options.child === true ? { delegationDepth: 1, origin: 'subagent' } : {},
      },
      inheritedEventCount: options.inheritedEventCount ?? 0,
      snapshotEvents: (from = 0) => events.slice(from),
    },
  } as GateAgent
}

let calls = 0
interface ExecOptions {
  name?: string
  args?: unknown
  agent?: GateAgent | null
  callId?: string
  signal?: AbortSignal
}

function execOf(options: ExecOptions = {}): ToolExecution {
  calls += 1
  return {
    callId: options.callId ?? `call-${calls}`,
    rootCallId: options.callId ?? `call-${calls}`,
    name: options.name ?? 'bash',
    arguments: 'args' in options ? options.args : { command: 'git status', description: 'Show working tree status' },
    ...options.agent === null ? {} : { agent: options.agent ?? agentOf({ cwd: '/work/app', events: [userEvent(1, 'fix the failing test in parser.ts')] }) },
    signal: options.signal ?? new AbortController().signal,
  } as unknown as ToolExecution
}

const ALLOW: PreToolDecision = { kind: 'allow' }

/** `next()` that says what it is told to, and counts. */
function nextOf(decision: PreToolDecision = ALLOW) {
  const spy = { calls: 0 }
  const next = () => { spy.calls += 1; return Promise.resolve(decision) }
  return { spy, next }
}

/** A gate over a fake client that answers `script`, with the cache it keeps. */
function gateOf(script: (request: JudgeRequest<any>) => JudgeResult | Promise<JudgeResult>, extra: Partial<Omit<CommandGateDeps, 'settings'>> & { settings?: JudgeSettings } = {}) {
  const judge = fakeJudge(script)
  const cache = extra.cache ?? new VerdictCache()
  const { settings = DEFAULT_SETTINGS, ...rest } = extra
  const gate = commandGate({ judge: () => judge, settings: async () => settings, cache, ...rest })
  return { gate, judge, cache }
}

/** The gate's entry for a call: of the agent it names, under its call id. */
function verdictFor(cache: VerdictCache, call: { agent?: unknown, callId: unknown }) {
  return cache.get(verdictOwner(call.agent as GateAgent | undefined), String(call.callId))
}

/** The state a request carried, as an object to read fields from. */
function stateOf(request: JudgeRequest<any>): Record<string, any> {
  return request.state as Record<string, any>
}

/** What the gate says for one call. */
async function run(gate: ReturnType<typeof commandGate>, options: ExecOptions = {}, decision: PreToolDecision = ALLOW) {
  const exec = execOf(options)
  return { exec, decision: await gate(exec, nextOf(decision).next) }
}

// --- the cache ---------------------------------------------------------------------------------------

test('VerdictCache: set, get and delete by call id', () => {
  const cache = new VerdictCache()
  assert.equal(cache.get('o', 'c1'), undefined)
  cache.set('o', 'c1', { verdict: 'ask', escalationCovered: false })
  cache.set('o', 'c2', { verdict: 'allow', escalationCovered: true })
  assert.deepEqual({ ...cache.get('o', 'c1') }, { verdict: 'ask', escalationCovered: false, at: cache.get('o', 'c1')!.at })
  assert.equal(cache.get('o', 'c2')?.verdict, 'allow')
  assert.equal(cache.get('o', 'c2')?.escalationCovered, true)
  cache.delete('o', 'c1')
  assert.equal(cache.get('o', 'c1'), undefined)
  assert.equal(cache.get('o', 'c2')?.verdict, 'allow')
  cache.delete('o', 'never-there')
})

test('VerdictCache: an entry expires after 10 minutes on the injected monotonic clock, and the wall clock does not matter', () => {
  assert.equal(VERDICT_TTL_MS, 10 * 60 * 1000)
  let now = 5_000
  const cache = new VerdictCache({ now: () => now })
  cache.set('o', 'c1', { verdict: 'allow', escalationCovered: false })
  assert.equal(cache.get('o', 'c1')!.at, 5_000)
  now += VERDICT_TTL_MS - 1
  assert.equal(cache.get('o', 'c1')?.verdict, 'allow')
  now += 1
  assert.equal(cache.get('o', 'c1'), undefined)
  assert.equal(cache.size, 0, 'an expired entry is dropped when it is found')
  // The default clock is monotonic: the cache reads performance.now(), not Date.now().
  const realDate = Date.now
  try {
    Date.now = () => realDate() + 3 * 3_600_000
    const fresh = new VerdictCache()
    fresh.set('o', 'c', { verdict: 'ask', escalationCovered: false })
    assert.equal(fresh.get('o', 'c')?.verdict, 'ask')
    Date.now = () => realDate() - 3 * 3_600_000
    assert.equal(fresh.get('o', 'c')?.verdict, 'ask')
  } finally {
    Date.now = realDate
  }
})

test('VerdictCache: expired entries go when something is written, so they are not kept', () => {
  let now = 0
  const cache = new VerdictCache({ now: () => now })
  cache.set('o', 'a', { verdict: 'allow', escalationCovered: false })
  cache.set('o', 'b', { verdict: 'allow', escalationCovered: false })
  now = VERDICT_TTL_MS
  cache.set('o', 'c', { verdict: 'allow', escalationCovered: false })
  assert.equal(cache.size, 1)
  assert.equal(cache.get('o', 'c')?.verdict, 'allow')
})

test('VerdictCache: holds at most 1000 entries and evicts the oldest', () => {
  assert.equal(VERDICT_MAX_ENTRIES, 1000)
  const cache = new VerdictCache()
  for (let i = 0; i < 1000; i++) cache.set('o', `c${i}`, { verdict: 'allow', escalationCovered: false })
  assert.equal(cache.size, 1000)
  cache.set('o', 'c1000', { verdict: 'ask', escalationCovered: false })
  assert.equal(cache.size, 1000)
  assert.equal(cache.get('o', 'c0'), undefined, 'the oldest is gone')
  assert.equal(cache.get('o', 'c1')?.verdict, 'allow')
  assert.equal(cache.get('o', 'c1000')?.verdict, 'ask')
  for (let i = 1001; i < 3000; i++) cache.set('o', `c${i}`, { verdict: 'allow', escalationCovered: false })
  assert.equal(cache.size, 1000)
  assert.equal(cache.get('o', 'c1999'), undefined)
  assert.equal(cache.get('o', 'c2000')?.verdict, 'allow')
})

test('VerdictCache: writing a call id again makes it the newest, so it is evicted last', () => {
  const cache = new VerdictCache({ max: 3 })
  cache.set('o', 'a', { verdict: 'allow', escalationCovered: false })
  cache.set('o', 'b', { verdict: 'allow', escalationCovered: false })
  cache.set('o', 'c', { verdict: 'allow', escalationCovered: false })
  cache.set('o', 'a', { verdict: 'deny', escalationCovered: false })
  cache.set('o', 'd', { verdict: 'allow', escalationCovered: false })
  assert.equal(cache.get('o', 'b'), undefined)
  assert.equal(cache.get('o', 'a')?.verdict, 'deny')
  assert.equal(cache.size, 3)
})

// --- which calls are gated ----------------------------------------------------------------------------

test('isGated: a plain entry matches exactly, an entry ending in * is a prefix, and ask_judge and run_code never match', () => {
  assert.equal(isGated('bash', ['bash', 'pwsh']), true)
  assert.equal(isGated('pwsh', ['bash', 'pwsh']), true)
  assert.equal(isGated('bashful', ['bash']), false)
  assert.equal(isGated('bas', ['bash']), false)
  assert.equal(isGated('bashful', ['bash*']), true)
  assert.equal(isGated('bash', ['bash*']), true)
  assert.equal(isGated('mcp__ssh__run', ['mcp__*']), true)
  assert.equal(isGated('mcp_ssh', ['mcp__*']), false)
  assert.equal(isGated('anything', ['*']), true)
  assert.equal(isGated('read_file', ['bash', 'pwsh']), false)
  assert.equal(isGated('ask_judge', ['a*']), false)
  assert.equal(isGated('ask_judge', ['*']), false)
  assert.equal(isGated('ask_judge', ['ask_judge']), false)
  assert.equal(isGated('run_code', ['*']), false)
  assert.equal(isGated('run_code', ['run_code', 'run*']), false)
})

test('a tool that is not gated passes through to next(), and the judge is not asked', async () => {
  const { gate, judge, cache } = gateOf(() => answers(READ_ONLY, 0.9))
  const downstream: PreToolDecision = { kind: 'deny', reason: 'someone else says so' }
  const { next, spy } = nextOf(downstream)
  const exec = execOf({ name: 'read_file', args: { path: '/etc/hosts' } })
  assert.equal(await gate(exec, next), downstream)
  assert.equal(spy.calls, 1)
  assert.equal(judge.requests.length, 0)
  assert.equal(cache.size, 0)
})

test('ask_judge is never gated, even when a gated prefix matches it', async () => {
  for (const gated of [['a*'], ['*'], ['ask_judge'], ['ask*', 'bash']]) {
    const { gate, judge } = gateOf(() => answers(IRREVERSIBLE, 0.9), { settings: gatedSettings(gated) })
    const { next, spy } = nextOf()
    assert.deepEqual(await gate(execOf({ name: 'ask_judge', args: { state: 'x', questions: {} } }), next), ALLOW)
    assert.equal(spy.calls, 1)
    assert.equal(judge.requests.length, 0, `gated ${JSON.stringify(gated)}`)
  }
})

test('PTC run_code passes through to next(), even when * is gated; its inner bash calls are gated', async () => {
  const { gate, judge } = gateOf(() => answers(IRREVERSIBLE, 0.9), { settings: gatedSettings(['*']) })
  const { next, spy } = nextOf()
  assert.deepEqual(await gate(execOf({ name: 'run_code', args: { code: 'await tools.bash({ command: "rm -rf /" })' } }), next), ALLOW)
  assert.equal(spy.calls, 1)
  assert.equal(judge.requests.length, 0)
  // An inner call has a parent token, and is a bash call like any other.
  const inner = execOf({ args: { command: 'rm -rf build/' } })
  ;(inner as unknown as { parent: symbol }).parent = Symbol('run_code')
  const decision = await gate(inner, nextOf().next)
  assert.equal(decision.kind, 'ask')
  assert.equal(judge.requests.length, 1)
})

test('a call with no exec.agent passes through to next()', async () => {
  const { gate, judge, cache } = gateOf(() => answers(IRREVERSIBLE, 0.9))
  const downstream: PreToolDecision = { kind: 'ask', reason: 'later' }
  const { next, spy } = nextOf(downstream)
  assert.equal(await gate(execOf({ agent: null }), next), downstream)
  assert.equal(spy.calls, 1)
  assert.equal(judge.requests.length, 0)
  assert.equal(cache.size, 0)
})

test('pwsh, and a tool matched by a gated prefix, are gated too', async () => {
  const { gate, judge } = gateOf(() => answers(READ_ONLY, 0.9), { settings: settingsWith(d => { d.tools.gated = ['pwsh', 'mcp__ssh*'] }) })
  assert.deepEqual((await run(gate, { name: 'pwsh', args: { command: 'Get-ChildItem' } })).decision, ALLOW)
  assert.deepEqual((await run(gate, { name: 'mcp__ssh__run', args: { command: 'uptime' } })).decision, ALLOW)
  assert.deepEqual((await run(gate, { name: 'bash', args: { command: 'git status' } })).decision, ALLOW)
  assert.deepEqual(judge.requests.map(request => request.tool), ['pwsh', 'mcp__ssh__run'])
})

// --- the table ---------------------------------------------------------------------------------------

interface Row {
  name: string
  probabilities: Record<string, number>
  serves: number
  allowed: boolean
  settings?: JudgeSettings
}

const ROWS: Row[] = [
  { name: 'read-only above the bar', probabilities: READ_ONLY, serves: 0.9, allowed: true },
  { name: 'read-only exactly at the bar (0.90)', probabilities: { read_only: 0.9, reversible: 0.05, irreversible: 0.03, other: 0.02 }, serves: 0.9, allowed: true },
  { name: 'read-only just under the first bar, but read-only + reversible reaches the second', probabilities: { read_only: 0.89, reversible: 0.07, irreversible: 0.03, other: 0.01 }, serves: 0.9, allowed: true },
  { name: 'reversible above the second bar', probabilities: REVERSIBLE, serves: 0.9, allowed: true },
  { name: 'read-only + reversible exactly at 0.95, as floating point sees it', probabilities: { read_only: 0.5, reversible: 0.45, irreversible: 0.03, other: 0.02 }, serves: 0.9, allowed: true, settings: settingsWith(d => { d.commands.reversible = 0.95 }) },
  {
    name: 'read-only 0.06 + reversible 0.84 reaches a 0.90 bar, though floating point makes it 0.8999999999999999',
    probabilities: { read_only: 0.06, reversible: 0.84, irreversible: 0.06, other: 0.04 },
    serves: 0.9,
    allowed: true,
    settings: settingsWith(d => { d.commands.reversible = 0.9 }),
  },
  { name: 'read-only + reversible just under 0.90', probabilities: { read_only: 0.5, reversible: 0.39, irreversible: 0.08, other: 0.03 }, serves: 0.9, allowed: false },
  { name: 'irreversible', probabilities: IRREVERSIBLE, serves: 0.91, allowed: false },
  { name: 'read-only, but not serving the task', probabilities: READ_ONLY, serves: 0.12, allowed: false },
  { name: 'serving the task exactly at the bar (0.50)', probabilities: READ_ONLY, serves: 0.5, allowed: true },
  { name: 'serving the task just under the bar', probabilities: READ_ONLY, serves: 0.49, allowed: false },
  { name: 'other', probabilities: { read_only: 0.1, reversible: 0.05, irreversible: 0.05, other: 0.8 }, serves: 0.9, allowed: false },
  {
    name: 'irreversible is the likeliest reading, though read-only + reversible reaches a lowered bar',
    probabilities: { read_only: 0.2, reversible: 0.3, irreversible: 0.45, other: 0.05 },
    serves: 0.9,
    allowed: false,
    settings: settingsWith(d => { d.commands.reversible = 0.5 }),
  },
  { name: 'a stricter bar from judge.yaml', probabilities: READ_ONLY, serves: 0.9, allowed: false, settings: settingsWith(d => { d.commands.readOnly = 0.99; d.commands.reversible = 0.995 }) },
]

for (const row of ROWS) {
  test(`the table, main agent: ${row.name} → ${row.allowed ? 'allow' : 'ask you'}`, async () => {
    const { gate, cache } = gateOf(() => answers(row.probabilities, row.serves), { settings: row.settings })
    const { exec, decision } = await run(gate)
    if (row.allowed) {
      assert.deepEqual(decision, ALLOW)
      assert.equal(verdictFor(cache, exec)?.verdict, 'allow')
    } else {
      assert.equal(decision.kind, 'ask')
      assert.equal(verdictFor(cache, exec)?.verdict, 'ask')
    }
  })

  test(`the table, crew child: ${row.name} → ${row.allowed ? 'allow' : 'deny'}`, async () => {
    const { gate, cache } = gateOf(() => answers(row.probabilities, row.serves), { settings: row.settings })
    const { exec, decision } = await run(gate, { agent: agentOf({ child: true, cwd: '/work/app', events: [userEvent(1, 'add a test for the parser')] }) })
    if (row.allowed) {
      assert.deepEqual(decision, ALLOW)
      assert.equal(verdictFor(cache, exec)?.verdict, 'allow')
    } else {
      assert.equal(decision.kind, 'deny')
      assert.equal(verdictFor(cache, exec)?.verdict, 'deny')
    }
  })
}

test('a crew child is told by the session header, by options.subagentDepth, and by having no header at all', async () => {
  const { gate } = gateOf(() => answers(IRREVERSIBLE, 0.9))
  const byDepth = { ...agentOf({ cwd: '/work/app' }), options: { subagentDepth: 1 } } as GateAgent
  const noHeader = { id: 'x', options: {}, session: {} } as GateAgent
  for (const agent of [byDepth, noHeader]) {
    assert.equal((await run(gate, { agent })).decision.kind, 'deny')
  }
  assert.equal((await run(gate, { agent: agentOf({ cwd: '/work/app' }) })).decision.kind, 'ask')
})

// --- the words -------------------------------------------------------------------------------------

test('the main agent\'s ask carries the judge\'s reading, with the spec\'s wording and probabilities to 2 places', async () => {
  const { gate } = gateOf(() => answers(IRREVERSIBLE, 0.91))
  const { decision } = await run(gate)
  assert.deepEqual(decision, {
    kind: 'ask',
    reason: 'The judge reads this as irreversible (p 0.87), and as serving the task (p 0.91).',
    displayReason: { en: 'The judge reads this as irreversible (p 0.87), and as serving the task (p 0.91).' },
  })
  const rounded = gateOf(() => answers({ read_only: 0.05, reversible: 0.08, irreversible: 0.866, other: 0.004 }, 0.9049))
  const second = await run(rounded.gate)
  assert.equal(second.decision.kind === 'ask' && second.decision.displayReason?.en, 'The judge reads this as irreversible (p 0.87), and as serving the task (p 0.90).')
})

test('a command that does not serve the task says so, as an unlikely reading and not as a likely one', async () => {
  const { gate } = gateOf(() => answers(READ_ONLY, 0.12))
  const { decision } = await run(gate)
  assert.equal(decision.kind === 'ask' && decision.displayReason?.en, 'The judge reads this as read-only (p 0.97), and as unlikely to serve the task (p 0.12).')
})

test('a child\'s denial is written for the model, with the spec\'s wording', async () => {
  const child = agentOf({ child: true, cwd: '/work/app', events: [userEvent(1, 'add a test')] })
  const irreversible = await run(gateOf(() => answers(IRREVERSIBLE, 0.91)).gate, { agent: child })
  assert.deepEqual(irreversible.decision, {
    kind: 'deny',
    reason: 'The judge didn\'t let this run: it reads as irreversible (p 0.87). Report it to the main agent instead, or find a reversible way.',
  })
  const offTask = await run(gateOf(() => answers(READ_ONLY, 0.12)).gate, { agent: child })
  assert.deepEqual(offTask.decision, {
    kind: 'deny',
    reason: 'The judge didn\'t let this run: it doesn\'t look like it serves the task (p 0.12). Report it to the main agent instead, or find a step that serves the task.',
  })
  const both = await run(gateOf(() => answers(IRREVERSIBLE, 0.12)).gate, { agent: child })
  assert.deepEqual(both.decision, {
    kind: 'deny',
    reason: 'The judge didn\'t let this run: it reads as irreversible (p 0.87), and it doesn\'t look like it serves the task (p 0.12). Report it to the main agent instead, or find a reversible way that serves the task.',
  })
})

test('decideCommand gives the log line its word: allow, ask or deny', () => {
  assert.equal(decideCommand(answers(READ_ONLY, 0.9), DEFAULT_SETTINGS, true).decision, 'allow')
  assert.equal(decideCommand(answers(IRREVERSIBLE, 0.9), DEFAULT_SETTINGS, true).decision, 'ask')
  assert.equal(decideCommand(answers(IRREVERSIBLE, 0.9), DEFAULT_SETTINGS, false).decision, 'deny')
  assert.equal(decideCommand(DOWN, DEFAULT_SETTINGS, true).decision, 'ask')
  assert.equal(decideCommand(DOWN, DEFAULT_SETTINGS, false).decision, 'deny')
})

// --- an unavailable judge ----------------------------------------------------------------------------

const UNAVAILABLE_CASES: Array<{ name: string, build: () => ReturnType<typeof commandGate> }> = [
  { name: 'Jev answered an error', build: () => gateOf(() => DOWN).gate },
  { name: 'Jev refused the request as invalid', build: () => gateOf(() => ({ ok: false, reason: 'invalid', from: 'server', message: 'TypeSafe refused the request (HTTP 400)' })).gate },
  { name: 'the request was too big', build: () => gateOf(() => ({ ok: false, reason: 'invalid', from: 'request', message: 'the state is too big', tooBig: true })).gate },
  { name: 'the answers are not the ones asked for', build: () => gateOf(() => ({ ok: true, latencyMs: 1, answers: { effect: { type: 'noul', noul: 0.5 }, serves_task: { type: 'noul', noul: 0.9 } } })).gate },
  { name: 'an answer is missing', build: () => gateOf(() => ({ ok: true, latencyMs: 1, answers: {} })).gate },
  {
    name: 'decide did not come back (no decided)',
    build: () => commandGate({ judge: () => fakeJudge(() => answers(READ_ONLY, 0.99), { skipDecide: true }), settings: async () => DEFAULT_SETTINGS, cache: new VerdictCache() }),
  },
  {
    name: 'the judge threw',
    build: () => commandGate({ judge: () => fakeJudge(() => answers(READ_ONLY, 0.99), { throws: true }), settings: async () => DEFAULT_SETTINGS, cache: new VerdictCache() }),
  },
  { name: 'there is no judge service', build: () => commandGate({ judge: () => undefined, settings: async () => DEFAULT_SETTINGS, cache: new VerdictCache() }) },
]

for (const { name, build } of UNAVAILABLE_CASES) {
  test(`unavailable (${name}): the main agent is asked, and a child is refused with nothing run`, async () => {
    const gate = build()
    const main = (await run(gate)).decision
    assert.equal(main.kind, 'ask')
    assert.ok(main.kind === 'ask' && main.reason?.includes('the judge is unavailable'), main.kind === 'ask' ? main.reason : '')
    assert.ok(main.kind === 'ask' && main.displayReason?.en.includes('the judge is unavailable'))
    const child = (await run(gate, { agent: agentOf({ child: true, cwd: '/work/app' }) })).decision
    assert.equal(child.kind, 'deny')
    assert.ok(child.kind === 'deny' && child.reason.includes('the judge is unavailable; nothing ran'), child.kind === 'deny' ? child.reason : '')
  })
}

test('an unavailable judge is cached as an ask for the main agent and a deny for a child', async () => {
  const { gate, cache } = gateOf(() => DOWN)
  const main = await run(gate)
  assert.equal(verdictFor(cache, main.exec)?.verdict, 'ask')
  const child = await run(gate, { agent: agentOf({ child: true }) })
  assert.equal(verdictFor(cache, child.exec)?.verdict, 'deny')
})

test('settings that fail to read fall back to the shipped default, and the call is gated by it', async () => {
  const judge = fakeJudge(() => answers(READ_ONLY, 0.9))
  const gate = commandGate({ judge: () => judge, settings: () => Promise.reject(new Error('store stuck')), cache: new VerdictCache() })
  assert.deepEqual((await run(gate)).decision, ALLOW)
  assert.equal(judge.requests.length, 1)
})

// --- what is asked ----------------------------------------------------------------------------------

test('the questions are the spec\'s, word for word', () => {
  assert.deepEqual(EFFECT_QUESTION, {
    type: 'choice',
    instructions: 'What would running `command` from `cwd` do to files, systems and data?',
    criteria: {
      read_only: 'it only reads or reports',
      reversible: 'it changes files inside `workspace` in a way git or rerunning can undo',
      irreversible: 'it deletes or overwrites data that can\'t be recovered, changes things outside `workspace`, publishes, pushes, merges, deploys, sends, or spends',
      other: null,
    },
  })
  assert.deepEqual(SERVES_TASK_QUESTION, { type: 'noul', instructions: 'Is running `command` a reasonable step toward `task`?' })
})

test('one call to the judge, for the command purpose, with both questions, the log fields and the call\'s own signal', async () => {
  const { gate, judge } = gateOf(() => answers(READ_ONLY, 0.9))
  const controller = new AbortController()
  const agent = agentOf({ cwd: '/work/app', events: [userEvent(1, 'fix the failing test in parser.ts')] })
  const exec = execOf({ agent, signal: controller.signal, callId: 'call-xyz', args: { command: 'npm test', description: 'Run the tests' } })
  await gate(exec, nextOf().next)
  assert.equal(judge.requests.length, 1)
  const request = judge.requests[0]!
  assert.equal(request.purpose, 'command')
  assert.deepEqual(Object.keys(request.questions).sort(), ['effect', 'serves_task'])
  assert.equal(request.questions.effect, EFFECT_QUESTION)
  assert.equal(request.questions.serves_task, SERVES_TASK_QUESTION)
  assert.equal(request.tool, 'bash')
  assert.equal(request.callId, 'call-xyz')
  assert.equal(request.subject, 'npm test')
  assert.equal(request.agent, agent)
  assert.equal(request.signal, controller.signal)
  assert.equal(typeof request.decide, 'function')
})

test('the state: the command, where it runs, the workspace, and the task', async () => {
  const { gate, judge } = gateOf(() => answers(READ_ONLY, 0.9), { workspaceRoot: () => '/canonical/work/app' })
  await run(gate, { args: { command: 'grep -rn foo src', description: 'x' }, agent: agentOf({ cwd: '/work/app', events: [userEvent(1, 'find where foo is used')] }) })
  assert.deepEqual(stateOf(judge.requests[0]!), {
    command: 'grep -rn foo src',
    cwd: '/work/app',
    workspace: '/canonical/work/app',
    task: 'find where foo is used',
  })
})

test('with no sandbox policy, or one that says nothing, the workspace is the cwd', async () => {
  for (const workspaceRoot of [undefined, () => undefined]) {
    const { gate, judge } = gateOf(() => answers(READ_ONLY, 0.9), { workspaceRoot })
    await run(gate, { agent: agentOf({ cwd: '/work/app' }) })
    assert.equal(stateOf(judge.requests[0]!).workspace, '/work/app')
    assert.equal(stateOf(judge.requests[0]!).cwd, '/work/app')
  }
})

test('a workdir the model passes is where the command runs: absolute as it is, relative against the session\'s cwd, blank ignored', async () => {
  const { gate, judge } = gateOf(() => answers(READ_ONLY, 0.9), { workspaceRoot: () => '/work/app' })
  const agent = agentOf({ cwd: '/work/app' })
  await run(gate, { agent, args: { command: 'ls', description: 'x', workdir: '/etc' } })
  await run(gate, { agent, args: { command: 'ls', description: 'x', workdir: 'packages/api' } })
  await run(gate, { agent, args: { command: 'ls', description: 'x', workdir: '../elsewhere' } })
  await run(gate, { agent, args: { command: 'ls', description: 'x', workdir: '' } })
  assert.deepEqual(judge.requests.map(request => stateOf(request).cwd), ['/etc', '/work/app/packages/api', resolve('/work/app', '../elsewhere'), '/work/app'])
  assert.ok(judge.requests.every(request => stateOf(request).workspace === '/work/app'))
})

test('the escalation is in the state: sandbox_permissions and its justification, and empty strings are no escalation', async () => {
  const { gate, judge } = gateOf(() => answers(READ_ONLY, 0.9))
  await run(gate, { args: { command: 'npm publish', description: 'x', sandbox_permissions: 'danger-full-access', justification: 'Needs the network to reach the registry' } })
  await run(gate, { args: { command: 'npm test', description: 'x', sandbox_permissions: 'workspace-write' } })
  await run(gate, { args: { command: 'npm test', description: 'x', sandbox_permissions: '', justification: '' } })
  await run(gate, { args: { command: 'npm test', description: 'x', sandbox_permissions: '  ', justification: 'because' } })
  assert.equal(stateOf(judge.requests[0]!).escalation, 'sandbox_permissions: danger-full-access; justification: Needs the network to reach the registry')
  assert.equal(stateOf(judge.requests[1]!).escalation, 'sandbox_permissions: workspace-write')
  assert.equal('escalation' in (stateOf(judge.requests[2]!) as object), false)
  assert.equal('escalation' in (stateOf(judge.requests[3]!) as object), false)
})

test('a shell call whose command is not a string is judged on its name and arguments, as they are', async () => {
  const { gate, judge } = gateOf(() => answers(READ_ONLY, 0.9))
  await run(gate, { args: { cmd: 'uptime' } })
  await run(gate, { args: { command: '' } })
  await run(gate, { args: undefined })
  assert.deepEqual(judge.requests.map(request => stateOf(request).command), ['bash({"cmd":"uptime"})', 'bash({"command":""})', 'bash()'])
  assert.deepEqual(judge.requests.map(request => request.subject), ['bash({"cmd":"uptime"})', 'bash({"command":""})', 'bash()'])
})

test('a gated tool that is not a shell is judged on its name and all its arguments, so none of them is hidden', async () => {
  const { gate, judge } = gateOf(() => answers(READ_ONLY, 0.9), { settings: settingsWith(d => { d.tools.gated = ['bash', 'mcp__ssh__*'] }) })
  const args = { host: 'prod-db', command: 'rm -rf /var/lib/postgres' }
  await run(gate, { name: 'mcp__ssh__run', args })
  await run(gate, { name: 'mcp__ssh__run', args: { host: 'prod-db' } })
  const [first, second] = judge.requests
  assert.equal(stateOf(first!).command, 'mcp__ssh__run({"host":"prod-db","command":"rm -rf /var/lib/postgres"})')
  assert.equal(first!.subject, stateOf(first!).command)
  assert.equal(stateOf(second!).command, 'mcp__ssh__run({"host":"prod-db"})')
  // The shell's own arguments are not the shell's `command` here: a `workdir` or an escalation on another tool is just an argument.
  const other = gateOf(() => answers(READ_ONLY, 0.9), { settings: settingsWith(d => { d.tools.gated = ['mcp__ssh__*'] }) })
  await run(other.gate, { name: 'mcp__ssh__run', args: { command: 'ls', workdir: '/etc', sandbox_permissions: 'danger-full-access', justification: 'x' }, agent: agentOf({ cwd: '/work/app' }) })
  const sent = stateOf(other.judge.requests[0]!)
  assert.equal(sent.cwd, '/work/app')
  assert.equal('escalation' in sent, false)
  assert.equal(other.judge.requests[0]!.questions.effect, EFFECT_QUESTION)
})

test('a command is sent to the judge whole, however long: cutting it would hide what is judged', async () => {
  const { gate, judge } = gateOf(() => answers(READ_ONLY, 0.9))
  const long = `echo ${'a'.repeat(30_000)}; rm -rf /`
  await run(gate, { args: { command: long, description: 'x' } })
  assert.equal(stateOf(judge.requests[0]!).command, long)
})

// --- the task ---------------------------------------------------------------------------------------

test('a top-level agent\'s task is the latest prompt a human wrote, not injected context', async () => {
  const events = [
    userEvent(1, 'first, set up the project'),
    otherEvent(2),
    userEvent(3, 'now fix the failing test in parser.ts'),
    userEvent(4, 'Goal continuation: keep going', 'goal'),
    userEvent(5, 'file changed: src/parser.ts', 'dsh-file-watch'),
    otherEvent(6),
  ]
  assert.equal(taskOf(agentOf({ events }), true), 'now fix the failing test in parser.ts')
})

test('the task joins the text blocks of a message and ignores the other kinds of block', () => {
  const event = { type: 'user/message', seq: 1, time: 1, data: { id: 'm1', role: 'user', source: { kind: 'user' }, content: [
    { type: 'text', text: 'look at this screenshot' },
    { type: 'image', url: 'attachment://abc' },
    { type: 'text', text: 'and fix the layout' },
  ] } }
  assert.equal(taskOf(agentOf({ events: [event] }), true), 'look at this screenshot\nand fix the layout')
})

test('a message with no text falls back to the prompt before it', () => {
  const image = { type: 'user/message', seq: 2, time: 2, data: { id: 'm2', role: 'user', source: { kind: 'user' }, content: [{ type: 'image', url: 'attachment://abc' }] } }
  assert.equal(taskOf(agentOf({ events: [userEvent(1, 'fix the layout'), image] }), true), 'fix the layout')
})

test('a child\'s task is its brief: the first prompt among its own events, after what it inherited from a fork', () => {
  const events = [
    userEvent(0, 'the parent\'s first request'),
    otherEvent(1),
    userEvent(2, 'the parent\'s second request'),
    otherEvent(3, 'session/fork-marker'),
    userEvent(4, 'Write tests for src/parser.ts. Your parent agent id is "main-1".'),
    otherEvent(5),
    userEvent(6, 'a follow-up from the parent', 'user'),
  ]
  assert.equal(taskOf(agentOf({ child: true, events, inheritedEventCount: 4 }), false), 'Write tests for src/parser.ts. Your parent agent id is "main-1".')
  assert.equal(taskOf(agentOf({ child: true, events: events.slice(4) }), false), 'Write tests for src/parser.ts. Your parent agent id is "main-1".')
})

test('a child\'s brief is not the parent\'s injected context, and the later prompts are not the brief', () => {
  const events = [userEvent(0, 'context', 'subagent-notice'), userEvent(1, 'the brief'), userEvent(2, 'something else')]
  assert.equal(taskOf(agentOf({ child: true, events }), false), 'the brief')
})

test('a task is cut to 4000 characters, with the cut marked and no pair of surrogates split', () => {
  assert.equal(MAX_TASK_CHARS, 4000)
  const long = taskOf(agentOf({ events: [userEvent(1, 'x'.repeat(10_000))] }), true)
  assert.equal(long.length, 4000)
  assert.equal(long.endsWith('…'), true)
  const emoji = taskOf(agentOf({ events: [userEvent(1, `${'x'.repeat(3_998)}😀😀😀`)] }), true)
  assert.ok(emoji.length <= 4000)
  assert.doesNotMatch(emoji, /[\ud800-\udbff](?![\udc00-\udfff])/)
  assert.equal(taskOf(agentOf({ events: [userEvent(1, 'x'.repeat(4000))] }), true).length, 4000)
})

test('a task that can\'t be read is the empty string, and the gate goes on', async () => {
  const noEvents = { id: 'main-1', options: {}, session: { id: 'main-1', header: { cwd: '/work/app' } } } as GateAgent
  const throwing = { id: 'main-1', options: {}, session: { id: 'main-1', header: { cwd: '/work/app' }, snapshotEvents: () => { throw new Error('the log is on disk') } } } as GateAgent
  const garbage = agentOf({ events: [null, 7, 'x', { type: 'user/message' }, { type: 'user/message', data: null }, { type: 'user/message', data: { role: 'user', source: { kind: 'user' }, content: 'text' } }] })
  for (const agent of [noEvents, throwing, garbage]) {
    assert.equal(taskOf(agent, true), '')
    assert.equal(taskOf(agent, false), '')
  }
  const { gate, judge } = gateOf(() => answers(READ_ONLY, 0.9))
  assert.deepEqual((await run(gate, { agent: throwing })).decision, ALLOW)
  assert.equal(stateOf(judge.requests[0]!).task, '')
})

// --- the cache, as the gate keeps it -----------------------------------------------------------------

test('the cache gets every verdict by call id, and an allowed call with an escalation is marked as covered', async () => {
  const cache = new VerdictCache()
  const allow = gateOf(() => answers(READ_ONLY, 0.9), { cache }).gate
  const ask = gateOf(() => answers(IRREVERSIBLE, 0.9), { cache }).gate
  const plain = await run(allow, { callId: 'c-plain' })
  const escalated = await run(allow, { callId: 'c-escalated', args: { command: 'ls', description: 'x', sandbox_permissions: 'danger-full-access', justification: 'needs it' } })
  const asked = await run(ask, { callId: 'c-asked', args: { command: 'git push', description: 'x', sandbox_permissions: 'danger-full-access', justification: 'needs it' } })
  const denied = await run(ask, { callId: 'c-denied', agent: agentOf({ child: true, cwd: '/w' }), args: { command: 'git push', description: 'x', sandbox_permissions: 'danger-full-access', justification: 'x' } })
  assert.deepEqual([plain.decision.kind, escalated.decision.kind, asked.decision.kind, denied.decision.kind], ['allow', 'allow', 'ask', 'deny'])
  const entry = (id: string, owner = 'main-1') => { const found = cache.get(owner, id); return found === undefined ? undefined : { verdict: found.verdict, escalationCovered: found.escalationCovered } }
  assert.deepEqual(entry('c-plain'), { verdict: 'allow', escalationCovered: false })
  assert.deepEqual(entry('c-escalated'), { verdict: 'allow', escalationCovered: true })
  assert.deepEqual(entry('c-asked'), { verdict: 'ask', escalationCovered: false })
  assert.deepEqual(entry('c-denied', 'child-1'), { verdict: 'deny', escalationCovered: false })
})

test('a call id is gated at most once: the same call again is not put to the judge, a different one is', async () => {
  const { gate, judge, cache } = gateOf(() => answers(IRREVERSIBLE, 0.9))
  const agent = agentOf({ cwd: '/work/app' })
  const first = await run(gate, { callId: 'same', agent, args: { command: 'git push', description: 'x' } })
  const again = await run(gate, { callId: 'same', agent, args: { command: 'git push', description: 'x' } })
  assert.equal(judge.requests.length, 1)
  assert.deepEqual(again.decision, first.decision)
  assert.equal(cache.get('main-1', 'same')?.verdict, 'ask')
  // A different command under the same call id, or a different agent, is a different call.
  await run(gate, { callId: 'same', agent, args: { command: 'git push --force', description: 'x' } })
  await run(gate, { callId: 'same', agent: agentOf({ id: 'main-2', cwd: '/work/app' }), args: { command: 'git push --force', description: 'x' } })
  assert.equal(judge.requests.length, 3)
})

test('a call that was cancelled while the judge was asked is cancelled, leaves no entry, and leaves no prompt', async () => {
  const controller = new AbortController()
  const { gate, cache } = gateOf(() => { controller.abort(); return DOWN })
  const { decision, exec } = await run(gate, { signal: controller.signal })
  assert.deepEqual(decision, { kind: 'cancel' })
  assert.equal(verdictFor(cache, exec), undefined)
})

test('a later listener\'s stricter answer stands, and the cache says what the call came to', async () => {
  const allowing = gateOf(() => answers(READ_ONLY, 0.9))
  const denied = await run(allowing.gate, {}, { kind: 'deny', reason: 'policy says no' })
  assert.deepEqual(denied.decision, { kind: 'deny', reason: 'policy says no' })
  assert.equal(verdictFor(allowing.cache, denied.exec)?.verdict, 'deny')

  const withEscalation = await run(allowing.gate, { args: { command: 'ls', description: 'x', sandbox_permissions: 'danger-full-access', justification: 'x' } }, { kind: 'ask', reason: 'policy wants a human' })
  assert.deepEqual(withEscalation.decision, { kind: 'ask', reason: 'policy wants a human' })
  assert.deepEqual(
    { verdict: verdictFor(allowing.cache, withEscalation.exec)?.verdict, covered: verdictFor(allowing.cache, withEscalation.exec)?.escalationCovered },
    { verdict: 'ask', covered: false },
    'the gate\'s allow must not approve a prompt somebody else asked for',
  )

  const asking = gateOf(() => answers(IRREVERSIBLE, 0.9))
  const cancelled = await run(asking.gate, {}, { kind: 'cancel' })
  assert.deepEqual(cancelled.decision, { kind: 'cancel' })
  // The gate's ask beats a later allow; its deny beats a later ask.
  assert.equal((await run(asking.gate, {}, ALLOW)).decision.kind, 'ask')
  const child = agentOf({ child: true, cwd: '/w' })
  assert.equal((await run(asking.gate, { agent: child }, { kind: 'ask', reason: 'x' })).decision.kind, 'deny')
})

test('the gate\'s allow gives way to a later listener\'s own allow, which is what next() returns', async () => {
  const { gate } = gateOf(() => answers(READ_ONLY, 0.9))
  const theirs: PreToolDecision = { kind: 'allow' }
  const exec = execOf()
  assert.equal(await gate(exec, () => Promise.resolve(theirs)), theirs)
})

// --- through dsh's real tool registry ------------------------------------------------------------------

type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
interface ApprovalRequest { agent: unknown, toolName: string, callId: string, reason?: string, displayReason?: { en: string }, signal: AbortSignal }
type Result = { isError: boolean, content: Array<{ type: string, text?: string }> }
const textOf = (result: Result): string => result.content.map(block => block.type === 'text' ? block.text ?? '' : '').join('\n')

interface WorldOptions {
  script?: (request: JudgeRequest<any>) => JudgeResult | Promise<JudgeResult>
  settings?: JudgeSettings
  approval?: ApprovalOutcome
  /** Provide no judge at all. */
  noJudge?: boolean
  /** An already-built client to use as `ctx.judge`. */
  judge?: unknown
  workspaceRoot?: string
  /** Hold every approval request until `release()`, which a test calls. */
  holdApproval?: Promise<void>
}

/** A real tool registry with the gate mounted by `registerCommandGate`, and stubs of the services around it, as siblings. */
async function world(options: WorldOptions = {}) {
  const ctx = new Context()
  await provideStub(ctx, 'systemPrompt', { tools() {}, section() {}, getSectionOrder: () => 1 })
  await ctx.plugin(ToolRuntime, {})
  const judge = fakeJudge(options.script ?? (() => answers(READ_ONLY, 0.9)))
  if (options.noJudge !== true) await provideStub(ctx, 'judge', options.judge ?? judge)
  await provideStub(ctx, 'dishJudge', { settings: async () => options.settings ?? DEFAULT_SETTINGS })
  if (options.workspaceRoot !== undefined) {
    const root = options.workspaceRoot
    await provideStub(ctx, 'sandboxPolicy', { resolve: (request: { session?: unknown }) => ({ mode: 'workspace-write', workspaceRoot: root, ...request.session === undefined ? {} : { sessionId: 's' } }) })
  }
  const approvals: ApprovalRequest[] = []
  const seenByApproval: Array<ReturnType<VerdictCache['get']>> = []
  let cache!: VerdictCache
  await provideStub(ctx, 'approval', {
    async request(request: ApprovalRequest): Promise<ApprovalOutcome> {
      approvals.push(request)
      await options.holdApproval
      seenByApproval.push(verdictFor(cache, request))
      return options.approval ?? 'rejected'
    },
  })
  const host = await ctx.plugin({ name: 'gate-host', apply(own: Context) { cache = registerCommandGate(own) } } as never, undefined as never)

  const ran: Array<Record<string, unknown>> = []
  ctx.tools.register(defineTool({
    name: 'bash',
    description: 'Run a command.',
    parameters: {
      command: { type: 'string', required: true },
      description: { type: 'string' },
      workdir: { type: 'string' },
      sandbox_permissions: { type: 'string' },
      justification: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args) { ran.push({ ...args }); return 'it ran' },
  }))
  ctx.tools.register(defineTool({
    name: 'read_file',
    description: 'Read a file.',
    parameters: { path: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() { return 'contents' },
  }))

  let sequence = 0
  const call = (name: string, args: unknown, who: GateAgent = agentOf({ cwd: '/work/app', events: [userEvent(1, 'fix the failing test in parser.ts')] }), callId = `real-${++sequence}`) =>
    ctx.tools.execute({ callId: callId as never, name, arguments: args, agent: who as never, signal: new AbortController().signal }) as unknown as Promise<Result>
  return { ctx, judge, cache, approvals, seenByApproval, ran, call, host }
}

const BASH = (command: string, more: Record<string, unknown> = {}) => ({ command, description: 'a command', ...more })

test('through the registry: a command the judge allows runs, and its verdict is forgotten when the call settles', async () => {
  const w = await world({ workspaceRoot: '/canonical/app' })
  const result = await w.call('bash', BASH('git status'), undefined, 'call-allowed')
  assert.equal(result.isError, false)
  assert.equal(textOf(result), 'it ran')
  assert.equal(w.ran.length, 1)
  assert.equal(w.approvals.length, 0)
  assert.equal(w.cache.get('main-1', 'call-allowed'), undefined, 'the entry is deleted on tools/result')
  assert.equal(w.cache.size, 0)
  assert.equal(stateOf(w.judge.requests[0]!).workspace, '/canonical/app', 'the workspace is read from the sandbox policy service through ctx.get')
})

test('through the registry: an ask goes to the approval service with the judge\'s reading, and the answer decides', async () => {
  for (const [approval, runs] of [['allowed-once', 1], ['rejected', 0], ['cancelled', 0], ['unavailable', 0]] as const) {
    const w = await world({ script: () => answers(IRREVERSIBLE, 0.91), approval })
    const result = await w.call('bash', BASH('git push'), undefined, 'call-asked')
    assert.equal(w.ran.length, runs, approval)
    assert.equal(result.isError, runs === 0, approval)
    assert.equal(w.approvals.length, 1)
    const request = w.approvals[0]!
    assert.equal(request.toolName, 'bash')
    assert.equal(request.callId, 'call-asked')
    assert.equal(request.displayReason?.en, 'The judge reads this as irreversible (p 0.87), and as serving the task (p 0.91).')
    assert.equal(request.reason, request.displayReason?.en)
    assert.equal(w.seenByApproval[0]?.verdict, 'ask', 'the approval answerer can see that this is the gate\'s own ask')
    assert.equal(w.cache.size, 0)
  }
})

test('through the registry: a child that the judge refuses gets the reason as a tool error, and nobody is asked', async () => {
  const w = await world({ script: () => answers(IRREVERSIBLE, 0.91) })
  const child = agentOf({ child: true, cwd: '/work/app', events: [userEvent(1, 'add a test')] })
  const result = await w.call('bash', BASH('git push'), child)
  assert.equal(result.isError, true)
  assert.equal(textOf(result), 'Error: The judge didn\'t let this run: it reads as irreversible (p 0.87). Report it to the main agent instead, or find a reversible way.')
  assert.equal(w.ran.length, 0)
  assert.equal(w.approvals.length, 0)
})

test('through the registry: with no judge service the main agent is asked and a child is refused', async () => {
  const w = await world({ noJudge: true, approval: 'rejected' })
  await w.call('bash', BASH('ls'))
  assert.equal(w.approvals.length, 1)
  assert.match(w.approvals[0]!.displayReason?.en ?? '', /the judge is unavailable/)
  const child = await w.call('bash', BASH('ls'), agentOf({ child: true, cwd: '/w' }))
  assert.equal(child.isError, true)
  assert.match(textOf(child), /the judge is unavailable; nothing ran/)
  assert.equal(w.ran.length, 0)
})

test('through the registry: when the plugin that registered the gate goes, the gate goes with it', async () => {
  const w = await world({ script: () => answers(IRREVERSIBLE, 0.9) })
  assert.equal((await w.call('bash', BASH('git push'))).isError, true)
  assert.equal(w.judge.requests.length, 1)
  await w.host.dispose()
  const after = await w.call('bash', BASH('git push'))
  assert.equal(after.isError, false)
  assert.equal(w.judge.requests.length, 1, 'the judge is not asked any more')
})

test('a sandbox policy that throws leaves the workspace as the cwd, and the gate goes on', async () => {
  const { gate, judge } = gateOf(() => answers(READ_ONLY, 0.9), { workspaceRoot: () => { throw new Error('no policy') } })
  assert.deepEqual((await run(gate, { agent: agentOf({ cwd: '/work/app' }) })).decision, ALLOW)
  assert.equal(stateOf(judge.requests[0]!).workspace, '/work/app')
})

test('through the registry: a tool that is not gated runs without the judge', async () => {
  const w = await world({ script: () => { throw new Error('the judge must not be asked') } })
  const result = await w.call('read_file', { path: '/etc/hosts' })
  assert.equal(textOf(result), 'contents')
  assert.equal(w.judge.requests.length, 0)
})

test('through the registry: the listener is prepended, so an earlier-registered listener runs after it and sees its verdict', async () => {
  const ctx = new Context()
  await provideStub(ctx, 'systemPrompt', { tools() {}, section() {}, getSectionOrder: () => 1 })
  await ctx.plugin(ToolRuntime, {})
  const judge = fakeJudge(() => answers(IRREVERSIBLE, 0.9))
  await provideStub(ctx, 'judge', judge)
  await provideStub(ctx, 'dishJudge', { settings: async () => DEFAULT_SETTINGS })
  let cache!: VerdictCache
  const order: string[] = []
  const seen: Array<string | undefined> = []
  // Registered first, so without `prepend` the gate would run after it.
  ctx.on('tools/pre-execute', async (exec, next) => {
    order.push(`earlier (judge asked ${judge.requests.length} times)`)
    seen.push(verdictFor(cache, exec)?.verdict)
    return next()
  })
  await ctx.plugin({ name: 'gate-host', apply(own: Context) { cache = registerCommandGate(own) } } as never, undefined as never)
  ctx.on('tools/pre-execute', async (exec, next) => {
    order.push('later')
    seen.push(verdictFor(cache, exec)?.verdict)
    return next()
  })
  ctx.tools.register(defineTool({
    name: 'bash',
    description: 'Run a command.',
    parameters: { command: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() { return 'it ran' },
  }))
  const result = await ctx.tools.execute({
    callId: 'order-1' as never,
    name: 'bash',
    arguments: { command: 'git push' },
    agent: agentOf({ cwd: '/w' }) as never,
    signal: new AbortController().signal,
  }) as unknown as Result
  assert.equal(result.isError, true, 'asked, and nobody to ask')
  assert.deepEqual(order, ['earlier (judge asked 1 times)', 'later'])
  assert.deepEqual(seen, ['ask', 'ask'], 'a later listener sees the gate\'s verdict')
})

test('through the registry: a call the gate denies runs no later listener, as in dsh\'s auto-review; an ask and an allow do', async () => {
  const w = await world({ script: request => request.callId === 'wants-allow' ? answers(READ_ONLY, 0.9) : answers(IRREVERSIBLE, 0.9), approval: 'rejected' })
  const later: string[] = []
  w.ctx.on('tools/pre-execute', async (exec, next) => { later.push(String(exec.callId)); return next() })
  const child = agentOf({ child: true, cwd: '/w' })
  const denied = await w.call('bash', BASH('git push'), child, 'wants-deny')
  assert.equal(denied.isError, true)
  assert.match(textOf(denied), /^Error: The judge didn't let this run/)
  assert.deepEqual(later, [], 'a denied call starts no hook that listens after the gate')
  await w.call('bash', BASH('git push'), undefined, 'wants-ask')
  await w.call('bash', BASH('git status'), undefined, 'wants-allow')
  assert.deepEqual(later, ['wants-ask', 'wants-allow'])
})

test('through the registry: a listener that denies after the gate allowed wins, and the command does not run', async () => {
  const w = await world()
  w.ctx.on('tools/pre-execute', async (_exec, next) => {
    await next()
    return { kind: 'deny', reason: 'another policy says no' }
  })
  const result = await w.call('bash', BASH('git status'))
  assert.equal(result.isError, true)
  assert.equal(textOf(result), 'Error: another policy says no')
  assert.equal(w.ran.length, 0)
})

// --- F2: the cache is keyed by agent and call id ---------------------------------------------------------

test('two agents with the same call id have entries of their own: one\'s allow does not overwrite the other\'s ask', async () => {
  const { gate, cache } = gateOf(request => (request.agent as GateAgent).id === 'main-1' ? answers(IRREVERSIBLE, 0.9) : answers(READ_ONLY, 0.95))
  const asked = await run(gate, { callId: 'call-0', agent: agentOf({ id: 'main-1', cwd: '/w' }) })
  const allowed = await run(gate, {
    callId: 'call-0',
    agent: agentOf({ id: 'main-2', cwd: '/w' }),
    args: { command: 'ls', description: 'x', sandbox_permissions: 'danger-full-access', justification: 'needs it' },
  })
  assert.equal(asked.decision.kind, 'ask')
  assert.equal(allowed.decision.kind, 'allow')
  assert.deepEqual({ verdict: cache.get('main-1', 'call-0')?.verdict, covered: cache.get('main-1', 'call-0')?.escalationCovered }, { verdict: 'ask', covered: false })
  assert.deepEqual({ verdict: cache.get('main-2', 'call-0')?.verdict, covered: cache.get('main-2', 'call-0')?.escalationCovered }, { verdict: 'allow', covered: true })
  cache.delete('main-2', 'call-0')
  assert.equal(cache.get('main-1', 'call-0')?.verdict, 'ask', 'a delete removes its own agent\'s entry only')
  assert.equal(cache.get('main-2', 'call-0'), undefined)
  assert.equal(verdictOwner({ id: 'main-1' }), 'main-1')
  assert.equal(verdictOwner({ session: { id: 's9' } }), 's9')
  assert.equal(verdictOwner(undefined), '')
})

test('a verdict entry names the tool, and the reason dsh will give for the escalation only when the call asks for one', async () => {
  const { gate, cache } = gateOf(() => answers(READ_ONLY, 0.95))
  const plain = await run(gate, { callId: 'entry-plain' })
  assert.equal(verdictFor(cache, plain.exec)?.tool, 'bash')
  assert.equal(verdictFor(cache, plain.exec)?.escalationCovered, false)
  assert.equal(verdictFor(cache, plain.exec)?.escalationReason, undefined)

  const escalating = await run(gate, { callId: 'entry-esc', args: { command: 'npm publish', description: 'x', sandbox_permissions: 'danger-full-access', justification: 'Needs the network to reach the registry' } })
  assert.equal(verdictFor(cache, escalating.exec)?.escalationCovered, true)
  assert.equal(verdictFor(cache, escalating.exec)?.escalationReason, 'escalate sandbox to danger-full-access: Needs the network to reach the registry', 'the wording of approveEscalation in dsh-sandbox')

  const powershell = await run(gate, { callId: 'entry-pwsh', name: 'pwsh', args: { command: 'Get-ChildItem', description: 'x', sandbox_permissions: 'workspace-write', justification: 'writes a cache' } })
  assert.equal(verdictFor(cache, powershell.exec)?.tool, 'pwsh')
  assert.equal(verdictFor(cache, powershell.exec)?.escalationReason, 'escalate sandbox to workspace-write: writes a cache')

  // The reason is what dsh will send, so it is whole, where what the judge reads is cut: a long justification is not clipped.
  const long = 'j'.repeat(3000)
  const lengthy = await run(gate, { callId: 'entry-long', args: { command: 'ls', description: 'x', sandbox_permissions: 'danger-full-access', justification: long } })
  assert.equal(verdictFor(cache, lengthy.exec)?.escalationReason, `escalate sandbox to danger-full-access: ${long}`)

  // As the model gave it, spaces and all: dsh puts the arguments in the reason as they are.
  const padded = await run(gate, { callId: 'entry-padded', args: { command: 'ls', description: 'x', sandbox_permissions: 'danger-full-access', justification: '  needs the network \n' } })
  assert.equal(verdictFor(cache, padded.exec)?.escalationReason, 'escalate sandbox to danger-full-access:   needs the network \n')

  // No justification, or one that is not text: bash does not ask, so there is no request to match.
  const bare = await run(gate, { callId: 'entry-bare', args: { command: 'ls', description: 'x', sandbox_permissions: 'danger-full-access' } })
  assert.equal(verdictFor(cache, bare.exec)?.escalationReason, undefined)
  const odd = await run(gate, { callId: 'entry-odd', args: { command: 'ls', description: 'x', sandbox_permissions: 'danger-full-access', justification: 7 } })
  assert.equal(verdictFor(cache, odd.exec)?.escalationReason, undefined)
})

test('an ask or a deny keeps the tool, and covers no escalation, whatever the call asked for', async () => {
  const { gate, cache } = gateOf(() => answers(IRREVERSIBLE, 0.9))
  const asked = await run(gate, { callId: 'entry-ask', args: { command: 'git push', description: 'x', sandbox_permissions: 'danger-full-access', justification: 'needs the network' } })
  assert.equal(verdictFor(cache, asked.exec)?.verdict, 'ask')
  assert.equal(verdictFor(cache, asked.exec)?.tool, 'bash')
  assert.equal(verdictFor(cache, asked.exec)?.escalationCovered, false)
  // Another listener that asks after the gate allowed turns the entry into an ask, and it is still bash's.
  const allowing = gateOf(() => answers(READ_ONLY, 0.95))
  const exec = execOf({ callId: 'entry-later', args: { command: 'ls', description: 'x', sandbox_permissions: 'danger-full-access', justification: 'needs the network' } })
  const final = await allowing.gate(exec, () => Promise.resolve({ kind: 'ask', reason: 'a hook asks' } as PreToolDecision))
  assert.equal(final.kind, 'ask')
  assert.deepEqual([verdictFor(allowing.cache, exec)?.verdict, verdictFor(allowing.cache, exec)?.escalationCovered, verdictFor(allowing.cache, exec)?.tool], ['ask', false, 'bash'])
})

test('VerdictCache: the owner and the call id are both part of the key, whatever characters they have', () => {
  const cache = new VerdictCache()
  cache.set('a', 'b,c', { verdict: 'ask', escalationCovered: false })
  cache.set('a,b', 'c', { verdict: 'allow', escalationCovered: true })
  assert.equal(cache.get('a', 'b,c')?.verdict, 'ask')
  assert.equal(cache.get('a,b', 'c')?.verdict, 'allow')
  assert.equal(cache.get('a', 'c'), undefined)
})

test('through the registry: another agent\'s call with the same id, which settles first, leaves this call\'s ask for the approval to read', async () => {
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  const w = await world({ script: request => (request.agent as GateAgent).id === 'main-1' ? answers(IRREVERSIBLE, 0.9) : answers(READ_ONLY, 0.95), approval: 'rejected', holdApproval: held })
  // This agent's call is asked, and waits for the human.
  const waiting = w.call('bash', BASH('git push'), agentOf({ id: 'main-1', cwd: '/w' }), 'call-0')
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(w.approvals.length, 1)
  // Another agent's call with the same id is allowed with an escalation, runs, and settles (its entry is deleted on tools/result).
  const other = await w.call('bash', BASH('ls', { sandbox_permissions: 'danger-full-access', justification: 'needs it' }), agentOf({ id: 'main-2', cwd: '/w' }), 'call-0')
  assert.equal(other.isError, false)
  assert.equal(w.cache.get('main-2', 'call-0'), undefined, 'its own entry is gone')
  // Now the approval for the first reads the cache.
  release()
  const first = await waiting
  assert.equal(first.isError, true)
  assert.equal(w.seenByApproval[0]?.verdict, 'ask', 'the approval sees this call\'s ask, not the other agent\'s allow')
  assert.equal(w.seenByApproval[0]?.escalationCovered, false)
  assert.deepEqual(w.ran.map(args => args.command), ['ls'])
})

// --- F3: the escalation is in the effect question -------------------------------------------------------

test('a call with an escalation is asked an effect question that names it, with the same options; one without is asked the spec\'s', async () => {
  assert.equal(
    EFFECT_WITH_ESCALATION_QUESTION.type === 'choice' && EFFECT_WITH_ESCALATION_QUESTION.instructions,
    'What would running `command` from `cwd`, with the extra access requested in `escalation`, do to files, systems and data?',
  )
  assert.deepEqual((EFFECT_WITH_ESCALATION_QUESTION as { criteria: unknown }).criteria, (EFFECT_QUESTION as { criteria: unknown }).criteria)
  const { gate, judge } = gateOf(() => answers(READ_ONLY, 0.9))
  await run(gate, { args: { command: 'npm install', description: 'x', sandbox_permissions: 'danger-full-access', justification: 'writes ~/.npm' } })
  await run(gate, { args: { command: 'npm install', description: 'x' } })
  await run(gate, { args: { command: 'npm install', description: 'x', sandbox_permissions: '', justification: '' } })
  const [withEscalation, without, blank] = judge.requests
  assert.equal(withEscalation!.questions.effect, EFFECT_WITH_ESCALATION_QUESTION)
  assert.notEqual(withEscalation!.questions.effect.instructions, without!.questions.effect.instructions)
  assert.match(withEscalation!.questions.effect.instructions, /`escalation`/)
  assert.equal(without!.questions.effect, EFFECT_QUESTION)
  assert.equal(blank!.questions.effect, EFFECT_QUESTION, 'an empty escalation is none')
  assert.equal(without!.questions.effect.instructions, 'What would running `command` from `cwd` do to files, systems and data?')
  assert.deepEqual(Object.keys(withEscalation!.questions).sort(), ['effect', 'serves_task'])
})

// --- F5: its own deny is final; F6: a cancelled call is logged as cancelled ------------------------------

test('the gate\'s own deny does not call next(); its ask and its allow do', async () => {
  const child = agentOf({ child: true, cwd: '/w' })
  const denying = nextOf()
  assert.equal((await gateOf(() => answers(IRREVERSIBLE, 0.9)).gate(execOf({ agent: child }), denying.next)).kind, 'deny')
  assert.equal(denying.spy.calls, 0)
  const asking = nextOf()
  assert.equal((await gateOf(() => answers(IRREVERSIBLE, 0.9)).gate(execOf(), asking.next)).kind, 'ask')
  assert.equal(asking.spy.calls, 1)
  const allowing = nextOf()
  assert.equal((await gateOf(() => answers(READ_ONLY, 0.9)).gate(execOf(), allowing.next)).kind, 'allow')
  assert.equal(allowing.spy.calls, 1)
  // An unavailable judge denies a child the same way, and a repeated call keeps its deny.
  const down = gateOf(() => DOWN)
  const again = nextOf()
  const exec = execOf({ agent: child, callId: 'twice' })
  assert.equal((await down.gate(exec, again.next)).kind, 'deny')
  assert.equal((await down.gate(exec, again.next)).kind, 'deny')
  assert.equal(again.spy.calls, 0)
  assert.equal(down.judge.requests.length, 1)
})

test('a call that is cancelled is decided as cancel, so the log line says so, and not as ask or deny', async () => {
  for (const agent of [agentOf({ cwd: '/w' }), agentOf({ child: true, cwd: '/w' })]) {
    const controller = new AbortController()
    const { gate, judge, cache } = gateOf(() => { controller.abort(); return DOWN })
    const { decision, exec } = await run(gate, { signal: controller.signal, agent })
    assert.deepEqual(decision, { kind: 'cancel' })
    assert.deepEqual(judge.decisions, ['cancel'])
    assert.equal(verdictFor(cache, exec), undefined)
  }
  // Not cancelled: the word is the verdict's.
  const { gate, judge } = gateOf(() => answers(IRREVERSIBLE, 0.9))
  await run(gate)
  await run(gate, { agent: agentOf({ child: true }) })
  assert.deepEqual(judge.decisions, ['ask', 'deny'])
})

// --- F7: the brief is the task ------------------------------------------------------------------------------

test('a child with several prompts is judged against its brief, the first, and a main agent against its latest', async () => {
  const events = [userEvent(1, 'the brief: write tests for parser.ts'), otherEvent(2), userEvent(3, 'a later nudge from the parent'), userEvent(4, 'and another')]
  const { gate, judge } = gateOf(() => answers(READ_ONLY, 0.9))
  await run(gate, { agent: agentOf({ child: true, cwd: '/w', events }) })
  await run(gate, { agent: agentOf({ cwd: '/w', events }) })
  assert.equal(stateOf(judge.requests[0]!).task, 'the brief: write tests for parser.ts')
  assert.equal(stateOf(judge.requests[1]!).task, 'and another')
})

// --- through the plugin's own wiring -----------------------------------------------------------------------

function jevSays(probabilities: Record<string, number>, serves: number) {
  const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]![0]
  return { kind: 'answer' as const, body: jevBody({ effect: choiceAnswer(choice, probabilities), serves_task: noulAnswer(serves) }) }
}

const USER = { kind: 'user' } as const

interface PluggedOptions {
  /** What `start` takes besides the configuration: a log whose prune hangs, say. */
  internals?: plugin.Internals
  /** Mount dish-config on a real repository, and wait for judge.yaml to be seeded. */
  store?: boolean
  /** A stand-in for `dishConfig`, from a sibling plugin. */
  dishConfig?: unknown
}

/**
 * dish-judge itself, mounted as dsh would, over a real tool registry and a fake Jev: its own client, its own settings, its own
 * decision log in a temp directory, and the gate it registers. Stubs of the services it doesn't inject are siblings.
 */
async function plugged(t: { after(fn: () => unknown): void }, options: PluggedOptions = {}) {
  const jev = await startFakeJev()
  const where = await dirs()
  const ctx = new Context()
  await provideStub(ctx, 'systemPrompt', { tools() {}, section() {}, getSectionOrder: () => 1 })
  await provideStub(ctx, 'credentials', { resolve: async () => ({ value: KEY }) })
  const approvals: ApprovalRequest[] = []
  await provideStub(ctx, 'approval', { request: async (request: ApprovalRequest) => { approvals.push(request); return 'rejected' } })
  await ctx.plugin(ToolRuntime, {})
  if (options.dishConfig !== undefined) await provideStub(ctx, 'dishConfig', options.dishConfig)
  const config = options.store === true ? mountConfig(ctx, where.repository) : undefined
  await config
  const handle = options.internals === undefined
    ? mountJudge(ctx, where.state, { baseUrl: jev.url })
    : ctx.plugin({ name: plugin.name, apply: (own: Context, given: plugin.Config) => { void plugin.start(own, given, options.internals!) } } as never, { terminal: false, stateDirectory: where.state, baseUrl: jev.url } as never)
  t.after(async () => {
    await handle.dispose()
    await config?.dispose()
  })
  await handle
  if (options.store === true) await seeded(ctx.dishConfig)
  const ran: Array<Record<string, unknown>> = []
  ctx.tools.register(defineTool({
    name: 'bash',
    description: 'Run a command.',
    parameters: { command: { type: 'string', required: true }, description: { type: 'string' }, sandbox_permissions: { type: 'string' }, justification: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args) { ran.push({ ...args }); return 'it ran' },
  }))
  ctx.tools.register(defineTool({
    name: 'read_file',
    description: 'Read a file.',
    parameters: { path: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() { return 'contents' },
  }))
  let sequence = 0
  const call = (name: string, args: unknown, who: GateAgent = agentOf({ cwd: '/work/app', events: [userEvent(1, 'fix the failing test in parser.ts')] }), callId = `plug-${++sequence}`, signal = new AbortController().signal) =>
    ctx.tools.execute({ callId: callId as never, name, arguments: args, agent: who as never, signal }) as unknown as Promise<Result>
  /** What the decision log has, oldest first. */
  const written = async () => { await ctx.dishJudge.log.flush(); return (await ctx.dishJudge.log.read()).lines.reverse() }
  return { ctx, jev, where, handle, ran, approvals, call, written }
}

test('the dish-judge plugin gates shell calls itself, with its own client and settings', async (t) => {
  const p = await plugged(t)
  const main = agentOf({ cwd: '/work/app', events: [userEvent(1, 'fix the failing test in parser.ts')] })
  p.jev.queue(jevSays(READ_ONLY, 0.95), jevSays(IRREVERSIBLE, 0.9))
  assert.equal(textOf(await p.call('bash', BASH('git status'), main)), 'it ran')
  const refused = await p.call('bash', BASH('git push origin main'), agentOf({ child: true, cwd: '/work/app', events: [userEvent(1, 'add a test')] }))
  assert.equal(refused.isError, true)
  assert.match(textOf(refused), /^Error: The judge didn't let this run: it reads as irreversible \(p 0\.87\)/)
  assert.deepEqual(p.ran.map(args => args.command), ['git status'])
  assert.equal(p.approvals.length, 0)
  assert.equal(p.jev.requests.length, 2)
  assert.equal(p.jev.requests[0]!.headers.authorization, `Bearer ${KEY}`)
  assert.equal(p.jev.requests[0]!.json.state.command, 'git status')
})

test('a command that a fake private key header would hide from the judge does not run on its say-so: you are asked, a child is refused, nothing is sent', async (t) => {
  const p = await plugged(t)
  // What Jev said, live, of `npm test` and the mask that this command was sent as: read-only, serving the task.
  p.jev.always(jevSays(READ_ONLY, 0.95))
  const hidden = 'npm test\n: -----BEGIN PRIVATE KEY-----\ngit push --force origin main\nrm -rf /work/app'
  const main = await p.call('bash', BASH(hidden))
  assert.equal(main.isError, true)
  assert.equal(p.approvals.length, 1, 'the main agent\'s call is put to you')
  const child = await p.call('bash', BASH(hidden), agentOf({ child: true, cwd: '/work/app', events: [userEvent(1, 'fix the failing test in parser.ts')] }))
  assert.equal(child.isError, true)
  assert.match(textOf(child), /the judge is unavailable; nothing ran/)
  assert.deepEqual(p.ran, [], 'nothing ran')
  assert.equal(p.jev.requests.length, 0, 'and nothing was sent to TypeSafe')
})

test('a gated call writes its line to the plugin\'s decision log in the state directory, with the verdict, the command and the call, and secrets masked', async (t) => {
  const p = await plugged(t)
  const token = `ghp_${'a1B2c3D4e5'.repeat(4)}`
  const command = `curl -H "Authorization: Bearer ${token}" https://api.github.com/user`
  p.jev.queue(
    jevSays(READ_ONLY, 0.95),
    jevSays(IRREVERSIBLE, 0.9),
    jevSays(IRREVERSIBLE, 0.9),
    { kind: 'status', status: 503, body: 'down' },
    { kind: 'status', status: 503, body: 'down' },
  )
  await p.call('bash', BASH('git status'), undefined, 'line-allow')
  await p.call('bash', BASH(command), undefined, 'line-ask')
  await p.call('bash', BASH('git push'), agentOf({ id: 'child-7', child: true, cwd: '/work/app', events: [userEvent(1, 'add a test')] }), 'line-deny')
  await p.call('bash', BASH('ls'), undefined, 'line-down-main')
  await p.call('bash', BASH('ls'), agentOf({ id: 'child-7', child: true, cwd: '/work/app' }), 'line-down-child')

  const lines = await p.written()
  assert.equal(lines.length, 5, 'one line per decision')
  assert.deepEqual(lines.map(line => [line.callId, line.decision]), [
    ['line-allow', 'allow'], ['line-ask', 'ask'], ['line-deny', 'deny'], ['line-down-main', 'ask'], ['line-down-child', 'deny'],
  ])
  for (const line of lines) {
    assert.equal(line.purpose, 'command')
    assert.equal(line.tool, 'bash')
  }
  assert.equal(lines[0]!.subject, 'git status')
  assert.equal(lines[0]!.child, false)
  assert.equal(lines[0]!.error, null)
  assert.equal(lines[2]!.child, true)
  assert.equal(lines[2]!.agent, 'child-7')
  assert.deepEqual(Object.keys(lines[0]!.answers).sort(), ['effect', 'serves_task'])
  assert.ok(lines[3]!.error !== null && lines[3]!.error.includes('503'))
  assert.deepEqual(lines[3]!.answers, {})
  // The command is in the log, with the token masked; the key is nowhere.
  assert.ok(lines[1]!.subject.includes('curl -H "Authorization: Bearer'))
  assert.ok(!lines[1]!.subject.includes(token), 'the token is masked in the log')
  assert.ok(!JSON.stringify(lines).includes(KEY), 'the key is not in the log')
  // The files are in the state directory, and say the same.
  const files = (await readdir(p.where.state)).filter(name => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
  assert.equal(files.length, 1, files.join(', '))
  const onDisk = await readFile(join(p.where.state, files[0]!), 'utf8')
  assert.equal(onDisk.trim().split('\n').length, 5)
  assert.ok(onDisk.includes('"callId":"line-deny"'))
  assert.ok(!onDisk.includes(token) && !onDisk.includes(KEY))
  // What Jev was sent is the command with its secrets masked: the judge can still read what it does.
  assert.equal(p.jev.requests[1]!.json.state.command, command.replace(token, '‹secret: a GitHub token›'))
  assert.ok(!JSON.stringify(p.jev.requests.map(r => r.json)).includes(token), 'no token went to Jev')
  assert.equal(p.jev.requests[0]!.json.state.task, 'fix the failing test in parser.ts')
  assert.equal(p.jev.requests[0]!.json.state.cwd, '/work/app')
  assert.deepEqual(Object.keys(p.jev.requests[0]!.json.questions).sort(), ['effect', 'serves_task'])
})

test('a cancelled call is logged as cancel by the plugin, and the effect question names an escalation when there is one', async (t) => {
  const p = await plugged(t)
  const controller = new AbortController()
  p.jev.queue({ ...jevSays(READ_ONLY, 0.9), delayMs: 400 })
  setTimeout(() => controller.abort(), 40)
  const cancelled = await p.call('bash', BASH('npm install', { sandbox_permissions: 'danger-full-access', justification: 'writes ~/.npm' }), undefined, 'line-cancel', controller.signal)
  assert.equal(cancelled.isError, true)
  assert.equal(p.ran.length, 0)
  assert.equal(p.approvals.length, 0, 'no prompt is left behind a cancelled call')
  const lines = await p.written()
  assert.deepEqual(lines.map(line => [line.callId, line.decision]), [['line-cancel', 'cancel']])
  const asked = p.jev.requests[0]!.json
  assert.equal(asked.questions.effect.instructions, 'What would running `command` from `cwd`, with the extra access requested in `escalation`, do to files, systems and data?')
  assert.match(asked.state.escalation, /^sandbox_permissions: danger-full-access; justification: writes ~\/\.npm$/)
  // Without an escalation, the spec's question is what Jev gets.
  p.jev.queue(jevSays(READ_ONLY, 0.9))
  await p.call('bash', BASH('npm test'))
  assert.equal(p.jev.requests[1]!.json.questions.effect.instructions, 'What would running `command` from `cwd` do to files, systems and data?')
})

/** A log that is only what the plugin needs of one: nothing is written, and `prune` is `prune`. */
function fakeLog(prune: () => Promise<{ days: number, withheld: number }>): plugin.Internals['log'] {
  return {
    write: async () => {},
    withhold: async () => '0123456789abcdef',
    read: async () => ({ lines: [], skipped: 0 }),
    withheld: async () => undefined,
    flush: async () => {},
    prune,
  } as plugin.Internals['log']
}

test('the gate is active while the log\'s prune is still going: the gate and the judge are there before it, and it waits for nothing', async (t) => {
  let pruning = 0
  const p = await plugged(t, { internals: { log: fakeLog(() => { pruning++; return new Promise(() => {}) }) } })
  assert.equal(pruning, 1, 'the prune has started, and never ends')
  p.jev.queue(jevSays(IRREVERSIBLE, 0.9), jevSays(READ_ONLY, 0.95))
  const refused = await p.call('bash', BASH('git push'), agentOf({ child: true, cwd: '/work/app', events: [userEvent(1, 'add a test')] }))
  assert.equal(refused.isError, true)
  assert.match(textOf(refused), /^Error: The judge didn't let this run: it reads as irreversible \(p 0\.87\)/)
  assert.deepEqual(p.ran, [], 'not run ungated')
  assert.equal(textOf(await p.call('bash', BASH('git status'))), 'it ran')
  assert.equal(p.jev.requests.length, 2, 'the judge was asked, as it is once loaded')
  assert.equal(pruning, 1)
})

// --- F4: the settings are read once and kept until judge.yaml changes ---------------------------------------------

/** A store that is only a reader, which counts its reads and answers `text()`. */
function countingStore(text: () => Promise<string | undefined> | string | undefined) {
  const store = {
    reads: 0,
    claim: () => () => {},
    seed: () => Promise.resolve(undefined),
    async read(_path: string) { store.reads += 1; return text() },
  }
  return store
}

const quietLogger = { warn() {} }

test('the settings reader keeps what it read: many calls, one read of the store', async () => {
  const store = countingStore(() => shippedWith(d => { d.commands.readOnly = 0.5 }))
  const settings = createSettingsReader(() => store as never, quietLogger)
  const first = await settings()
  assert.equal(first.commands.readOnly, 0.5)
  for (let i = 0; i < 20; i++) assert.equal(await settings(), first)
  assert.equal(store.reads, 1)
})

test('invalidate() makes the next call read the store again, and what it finds is kept in its turn', async () => {
  let text = shippedWith(d => { d.commands.readOnly = 0.5 })
  const store = countingStore(() => text)
  const settings = createSettingsReader(() => store as never, quietLogger)
  assert.equal((await settings()).commands.readOnly, 0.5)
  text = shippedWith(d => { d.commands.readOnly = 0.7 })
  assert.equal((await settings()).commands.readOnly, 0.5, 'not read again until it is said to have changed')
  settings.invalidate()
  assert.equal((await settings()).commands.readOnly, 0.7)
  assert.equal((await settings()).commands.readOnly, 0.7)
  assert.equal(store.reads, 2)
})

test('a file that is missing, or does not pass, is kept as the default too, and said once', async () => {
  const told: string[] = []
  for (const text of [undefined, 'tools: [']) {
    const store = countingStore(() => text)
    const settings = createSettingsReader(() => store as never, { warn: (_format: string, message: string) => { told.push(message) } })
    for (let i = 0; i < 5; i++) assert.equal(await settings(), DEFAULT_SETTINGS)
    assert.equal(store.reads, 1)
    settings.invalidate()
    assert.equal(await settings(), DEFAULT_SETTINGS)
    assert.equal(store.reads, 2)
  }
  assert.equal(told.length, 2, 'one message for each problem, however many calls')
})

test('a read that fails is not kept: the next call tries the store again', async () => {
  let failing = true
  const store = countingStore(() => { if (failing) throw new Error('git is busy'); return shippedWith(d => { d.commands.readOnly = 0.5 }) })
  const settings = createSettingsReader(() => store as never, quietLogger)
  assert.equal(await settings(), DEFAULT_SETTINGS)
  failing = false
  assert.equal((await settings()).commands.readOnly, 0.5)
  assert.equal(store.reads, 2)
})

test('a read that began before an invalidate and ends after it is not kept, and calls after the invalidate do not join it', async () => {
  const pending: Array<(text: string) => void> = []
  const store = countingStore(() => new Promise<string>((resolve) => { pending.push(resolve) }))
  const settings = createSettingsReader(() => store as never, quietLogger)
  const old = settings()
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(store.reads, 1)
  settings.invalidate()
  const fresh = settings()
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(store.reads, 2, 'a new read, not the one that began before the edit')
  pending[1]!(shippedWith(d => { d.commands.readOnly = 0.7 }))
  assert.equal((await fresh).commands.readOnly, 0.7)
  pending[0]!(shippedWith(d => { d.commands.readOnly = 0.5 }))
  assert.equal((await old).commands.readOnly, 0.5)
  assert.equal((await settings()).commands.readOnly, 0.7, 'the stale read did not replace the newer one')
  assert.equal(store.reads, 2)
})

test('a different store is a different answer: it is read afresh', async () => {
  const one = countingStore(() => shippedWith(d => { d.commands.readOnly = 0.5 }))
  const two = countingStore(() => shippedWith(d => { d.commands.readOnly = 0.7 }))
  let current = one
  const settings = createSettingsReader(() => current as never, quietLogger)
  assert.equal((await settings()).commands.readOnly, 0.5)
  current = two
  assert.equal((await settings()).commands.readOnly, 0.7)
  assert.deepEqual([one.reads, two.reads], [1, 1])
})

test('through the plugin: calls read the store once, and only a change to judge.yaml makes it read again', async (t) => {
  let text = DEFAULT_TEXT
  const store = countingStore(() => text)
  const p = await plugged(t, { dishConfig: store })
  p.jev.queue(jevSays(READ_ONLY, 0.9), jevSays(READ_ONLY, 0.9))
  for (let i = 0; i < 3; i++) assert.equal(textOf(await p.call('read_file', { path: '/etc/hosts' })), 'contents')
  await p.call('bash', BASH('git status'))
  await p.call('bash', BASH('git status'))
  assert.equal(p.jev.requests.length, 2, 'bash is gated, read_file is not')
  assert.equal(store.reads, 1, 'five calls of two tools, one read of judge.yaml')

  // Another document changing is no reason to read it again.
  const author = { kind: 'user' }
  await p.ctx.parallel('dish-config/changed', ['t/other.md'], 'abc', author as never)
  await p.call('read_file', { path: '/etc/hosts' })
  assert.equal(store.reads, 1)

  // judge.yaml changing is: read_file is now a gated tool, from the next call.
  text = shippedWith(d => { d.tools.gated = ['bash', 'pwsh', 'read_file'] })
  await p.ctx.parallel('dish-config/changed', ['judge.yaml'], 'def', author as never)
  p.jev.queue(jevSays(READ_ONLY, 0.9))
  await p.call('read_file', { path: '/etc/hosts' })
  assert.equal(store.reads, 2)
  assert.equal(p.jev.requests.length, 3, 'read_file went to the judge')
  assert.equal(p.jev.requests[2]!.json.state.command, 'read_file({"path":"/etc/hosts"})')
})

test('through the plugin and a real store: an edit of judge.yaml takes effect on the next call', async (t) => {
  const p = await plugged(t, { store: true })
  const store = p.ctx.dishConfig
  assert.equal((await p.ctx.dishJudge.settings()).commands.readOnly, 0.9)
  // The file now has a different bar, and read_file in the gated list; the very next call sees both.
  await store.write([{ path: 'judge.yaml', text: shippedWith((d) => { d.commands.readOnly = 0.5; d.tools.gated = ['bash', 'read_file'] }) }], { author: USER })
  assert.equal((await p.ctx.dishJudge.settings()).commands.readOnly, 0.5)
  p.jev.queue(jevSays(READ_ONLY, 0.9))
  await p.call('read_file', { path: '/etc/hosts' })
  assert.equal(p.jev.requests.length, 1)
  // And back, as the page would.
  await store.write([{ path: 'judge.yaml', text: DEFAULT_TEXT }], { author: USER })
  assert.equal((await p.ctx.dishJudge.settings()).commands.readOnly, 0.9)
  await p.call('read_file', { path: '/etc/hosts' })
  assert.equal(p.jev.requests.length, 1, 'read_file is not gated again')
})
