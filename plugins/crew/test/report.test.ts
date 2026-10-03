/**
 * crew's `report` tool, what crew keeps of each session for it, and the steer back to a coder or reviewer that ends its turn
 * without it. The tool is called as dsh's registry calls a definition (`execute(args, exec)`), over a real `CrewRecords` in a
 * temp directory; the tracker and the steer listener are driven with the events dsh publishes. `plugin.test.ts` drives them
 * through crew's host plugin and dsh's real tool registry.
 */

import { test } from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { assertSupportedJsonSchema, parameterSchemaSpecToJsonSchema } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolExecution, ToolExecutionResult, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { maskSecrets } from 'dish-kit'
import { CrewRecords } from '../src/record.ts'
import type { CoderReport, ReportRole, StructuredReport } from '../src/record.ts'
import {
  CODER_DESCRIPTION, CODER_PARAMETERS, DEFAULT_REPORT_STEERS, FULL_SHA, REPORT_TOOL, REVIEWER_DESCRIPTION, REVIEWER_PARAMETERS, ReportTracker,
  reportSteerListener, reportSteerSummary, reportSteerText, reportTool,
} from '../src/report.ts'
import type { ReportToolDeps, SteeringAgent } from '../src/report.ts'
import { tempDir } from './helpers.ts'

// --- what the tests are made of -----------------------------------------------------------------------------------------

const NOW = 1_700_000_000_000
const SHA = '3d412b9e0c85d50cce297dbd2bd3d3e44720aaaa'
const TOKEN = `ghp_${'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'}`

/** A child as dsh makes one: depth 1, origin `subagent`, its session's id its own. */
function childOf(id: string) {
  const steers: UserMessage[] = []
  return {
    id, options: {}, session: { id, header: { id, cwd: '/w', delegationDepth: 1, origin: 'subagent' } }, steers,
    steer(message: UserMessage) { steers.push(message) },
  }
}

/** The part of dsh's `ToolRunContext` the tool uses, counting the conclusions. */
function execOf(agent: unknown = childOf('c1')): { exec: ToolRunContext, concluded: () => number } {
  let count = 0
  const exec = {
    callId: 'call-1', rootCallId: 'call-1', name: REPORT_TOOL, arguments: {}, agent, signal: new AbortController().signal,
    concludeTurn() { count += 1 },
    deferContext() {},
  } as unknown as ToolRunContext
  return { exec, concluded: () => count }
}

interface Fixture {
  records: CrewRecords
  tracker: ReportTracker
  agent: ReturnType<typeof childOf>
  tool: ToolDefinition
  /** The calls of `records.setReport`. */
  setReports(): number
  /** How many times the tool said the record has lost the child (`lost`). */
  losses(): number
  call(args: Record<string, unknown>): Promise<{ value?: StructuredReport, error?: Error, concluded: number }>
}

/** `report` for crew child `c1` of `role`, recorded in a fresh `CrewRecords` (unless `recorded` is false). */
async function fixture(t: TestContext, role: ReportRole, options: { recorded?: boolean, records?: ReportToolDeps['records'] } = {}): Promise<Fixture> {
  const records = new CrewRecords(await tempDir())
  if (options.recorded !== false) {
    await records.addChild('main-1', {
      id: 'c1', role, title: 'the task', model: 'claude-sonnet-5.5', family: 'anthropic',
      ...role === 'reviewer' ? { reviews: 'c0' } : {},
    })
  }
  const spy = t.mock.method(records, 'setReport')
  const tracker = new ReportTracker()
  const agent = childOf('c1')
  let losses = 0
  const tool = reportTool({ role, agent, records: options.records ?? records, tracker, now: () => NOW, lost: () => { losses += 1 } })
  return {
    records, tracker, agent, tool,
    setReports: () => spy.mock.callCount(),
    losses: () => losses,
    async call(args) {
      const { exec, concluded } = execOf(agent)
      try {
        const value = await tool.execute(args, exec) as StructuredReport
        return { value, concluded: concluded() }
      } catch (error) {
        assert.ok(error instanceof Error)
        return { error, concluded: concluded() }
      }
    },
  }
}

const CODER = { status: 'done', summary: 'Added the login form; the tests pass.', commits: [SHA] }
const REVIEWER = {
  verdict: 'changes_requested', head: SHA, summary: 'One bug.',
  findings: [{ severity: 'blocking', file: 'src/login.ts', line: 12, summary: 'off by one', fix: 'use <=' }],
}

const BLOCKED_ON = 'blockedOn is required when status is blocked or needs_context: say what you\'re blocked on, or what you need'
const HEAD_FORM = 'head must be the full sha of the commit you reviewed (40 hex digits): run `git rev-parse HEAD` in the worktree you reviewed, or leave head out when the work isn\'t in a git repository'

/** Every node of a JSON schema, depth first. */
function nodes(schema: unknown, out: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> {
  if (typeof schema !== 'object' || schema === null) return out
  const node = schema as Record<string, unknown>
  out.push(node)
  for (const child of Object.values((node.properties ?? {}) as Record<string, unknown>)) nodes(child, out)
  if (node.items !== undefined) nodes(node.items, out)
  return out
}

// --- the schemas ---------------------------------------------------------------------------------------------------------

test('the schemas: dsh-tools compiles both parameter sets, every nested object is closed, there is no oneOf, and the required lists are the contract\'s', () => {
  const coder = parameterSchemaSpecToJsonSchema(CODER_PARAMETERS)
  const reviewer = parameterSchemaSpecToJsonSchema(REVIEWER_PARAMETERS)
  for (const schema of [coder, reviewer]) {
    assertSupportedJsonSchema(schema)
    assert.equal('additionalProperties' in schema, false, 'the root stays dsh\'s open object: an extra argument is ignored')
    for (const node of nodes(schema)) {
      assert.equal('oneOf' in node, false)
      if (node !== (schema as unknown) && node.type === 'object') assert.equal(node.additionalProperties, false, JSON.stringify(node))
    }
  }
  const items = (schema: Record<string, any>, name: string) => schema.properties[name].items
  assert.deepEqual(coder.required, ['status', 'summary'])
  assert.deepEqual(coder.properties.status, { type: 'string', enum: ['done', 'blocked', 'needs_context'], description: CODER_PARAMETERS.status.description })
  assert.deepEqual(items(coder, 'rulings').required, ['what', 'why', 'costIfWrong'])
  assert.deepEqual(items(coder, 'notFixed').required, ['finding', 'why'])
  assert.deepEqual(items(coder, 'commits'), { type: 'string' })
  assert.deepEqual(items(coder, 'concerns'), { type: 'string' })
  assert.deepEqual(reviewer.required, ['verdict', 'summary', 'findings'])
  assert.equal(reviewer.properties.head.type, 'string')
  assert.equal(REVIEWER_PARAMETERS.head.description, 'The full sha of the commit you reviewed (`git rev-parse HEAD`), when the work is in a git repository.')
  assert.deepEqual(items(reviewer, 'findings').required, ['severity', 'file', 'summary', 'fix'])
  assert.deepEqual(items(reviewer, 'findings').properties.severity.enum, ['blocking', 'should_fix', 'nit'])
  assert.equal(items(reviewer, 'findings').properties.line.type, 'integer')
  assert.deepEqual(items(reviewer, 'checks').required, ['command', 'exitCode', 'summary'])
  assert.deepEqual(items(reviewer, 'addressed').required, ['finding', 'addressed', 'evidence'])
  assert.ok(FULL_SHA.test(SHA) && FULL_SHA.test('a'.repeat(64)) && !FULL_SHA.test(SHA.slice(0, 12)) && !FULL_SHA.test(SHA.toUpperCase()))
  assert.equal(DEFAULT_REPORT_STEERS, 2)
})

test('each role\'s tool is named report, with its own description, parameters and output schema, which dsh accepts', async (t) => {
  const coder = (await fixture(t, 'coder')).tool
  const reviewer = (await fixture(t, 'reviewer')).tool
  assert.equal(coder.name, 'report')
  assert.equal(reviewer.name, 'report')
  assert.equal(coder.description, CODER_DESCRIPTION)
  assert.equal(reviewer.description, REVIEWER_DESCRIPTION)
  assert.deepEqual(coder.parameters, parameterSchemaSpecToJsonSchema(CODER_PARAMETERS))
  assert.deepEqual(reviewer.parameters, parameterSchemaSpecToJsonSchema(REVIEWER_PARAMETERS))
  for (const tool of [coder, reviewer]) {
    const output = tool.output!.schema as Record<string, any>
    assertSupportedJsonSchema(tool.output!.schema)
    assert.equal(output.additionalProperties, false)
    assert.deepEqual(output.required.slice(0, 3), ['role', 'turn', 'at'])
  }
  assert.equal((coder.output!.schema as Record<string, any>).properties.role.const, 'coder')
  assert.equal((reviewer.output!.schema as Record<string, any>).properties.role.const, 'reviewer')
  assert.match(CODER_DESCRIPTION, /^Finish your work with this, as your last call/)
  assert.match(REVIEWER_DESCRIPTION, /^Finish your review with this, as your last call/)
})

// --- a call -------------------------------------------------------------------------------------------------------------

test('a coder\'s call: setReport gets the report, the value is the stored and masked report, the turn is concluded once, and it renders', async (t) => {
  const f = await fixture(t, 'coder')
  const result = await f.call({ ...CODER, summary: `Added the login form with ${TOKEN}.` })
  assert.equal(result.error, undefined)
  const expected = { role: 'coder', turn: 0, at: NOW, status: 'done', summary: `Added the login form with ${maskSecrets(TOKEN)}.`, commits: [SHA] }
  assert.deepEqual(result.value, expected)
  assert.ok(!JSON.stringify(result.value).includes(TOKEN))
  assert.equal(result.concluded, 1)
  assert.equal(f.setReports(), 1)
  assert.deepEqual((await f.records.lookup('c1'))!.record.report, expected)
  assert.deepEqual(f.tool.output!.render({ ...CODER }, result.value as never), [{ type: 'text', text: 'Report recorded: done.' }])
})

test('a reviewer\'s call keeps every field, and renders its verdict and the first 12 of its head', async (t) => {
  const f = await fixture(t, 'reviewer')
  const args = {
    ...REVIEWER,
    checks: [{ command: 'pnpm test', exitCode: 1, summary: 'one failure' }],
    addressed: [{ finding: 'the earlier race', addressed: true, evidence: 'login.ts:40 takes the lock' }],
  }
  const result = await f.call(args)
  assert.deepEqual(result.value, { role: 'reviewer', turn: 0, at: NOW, ...args })
  assert.equal(result.concluded, 1)
  assert.deepEqual(f.tool.output!.render(args, result.value as never), [{ type: 'text', text: `Report recorded: changes_requested at ${SHA.slice(0, 12)}.` }])
})

test('a call that doesn\'t fit the schema is dsh\'s invalid arguments, naming the field: nothing is recorded, and the turn goes on', async (t) => {
  const coder = await fixture(t, 'coder')
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ summary: 'x' }, /^invalid arguments: .*"status"/],
    [{ status: 'finished', summary: 'x' }, /^invalid arguments: "status" must be one of/],
    [{ ...CODER, rulings: [{ what: 'kept it', why: 'callers' }] }, /^invalid arguments: .*"rulings\[0\]\.costIfWrong"/],
    [{ ...CODER, commits: SHA }, /^invalid arguments: .*"commits"/],
  ]
  for (const [args, message] of cases) {
    const result = await coder.call(args)
    assert.match(result.error?.message ?? '', message, JSON.stringify(args))
    assert.equal(result.concluded, 0)
  }
  const reviewer = await fixture(t, 'reviewer')
  const bad = await reviewer.call({ ...REVIEWER, findings: [{ ...REVIEWER.findings[0], severity: 'major' }] })
  assert.match(bad.error?.message ?? '', /^invalid arguments: .*"findings\[0\]\.severity"/)
  const missing = await reviewer.call({ verdict: 'approved', head: SHA, summary: 'clean' })
  assert.match(missing.error?.message ?? '', /^invalid arguments: .*"findings"/)
  assert.equal(bad.concluded + missing.concluded, 0)
  assert.equal(coder.setReports() + reviewer.setReports(), 0)
  assert.equal((await coder.records.lookup('c1'))!.record.report, undefined)
})

test('the body\'s checks: blockedOn when not done, a blank summary, a head that isn\'t a full sha; all of them at once, and nothing recorded', async (t) => {
  const coder = await fixture(t, 'coder')
  const said = async (f: Fixture, args: Record<string, unknown>): Promise<string> => {
    const result = await f.call(args)
    assert.equal(result.value, undefined, JSON.stringify(args))
    assert.equal(result.concluded, 0)
    return result.error!.message
  }
  assert.equal(await said(coder, { status: 'blocked', summary: 'Stuck.' }), BLOCKED_ON)
  assert.equal(await said(coder, { status: 'needs_context', summary: 'Stuck.', blockedOn: '  \n' }), BLOCKED_ON)
  assert.equal(await said(coder, { ...CODER, summary: ' \t ' }), 'summary is empty: say what changed, for a person')
  assert.equal(await said(coder, { status: 'blocked', summary: '' }), `summary is empty: say what changed, for a person; ${BLOCKED_ON}`)

  const reviewer = await fixture(t, 'reviewer')
  assert.equal(await said(reviewer, { ...REVIEWER, head: 'HEAD' }), HEAD_FORM)
  assert.equal(await said(reviewer, { ...REVIEWER, head: SHA.slice(0, 12) }), HEAD_FORM)
  assert.equal(await said(reviewer, { ...REVIEWER, head: `${SHA}0` }), HEAD_FORM)
  assert.equal(await said(reviewer, { ...REVIEWER, summary: '' }), 'summary is empty: say what you found, for a person')
  assert.equal(await said(reviewer, { ...REVIEWER, summary: ' ', head: 'HEAD' }), `summary is empty: say what you found, for a person; ${HEAD_FORM}`)
  assert.equal(coder.setReports() + reviewer.setReports(), 0)

  // A full sha, uppercased and with spaces around it, is stored trimmed and lowercased.
  const upper = await reviewer.call({ ...REVIEWER, head: `  ${SHA.toUpperCase()}\n` })
  assert.equal((upper.value as { head: string }).head, SHA)
  // No head (a review of work outside git), or a blank one: the report is recorded without it.
  const { head: _head, ...headless } = REVIEWER
  for (const args of [headless, { ...REVIEWER, head: '  ' }]) {
    const none = await reviewer.call(args)
    assert.equal(none.error, undefined, JSON.stringify(args))
    assert.equal(none.concluded, 1)
    assert.equal('head' in (none.value as object), false)
    assert.equal(reviewer.tool.output.render({}, none.value as never).map(block => (block as { text?: string }).text).join(''), 'Report recorded: changes_requested.')
  }
  assert.equal(reviewer.tool.output.render({}, upper.value as never).map(block => (block as { text?: string }).text).join(''), `Report recorded: changes_requested at ${SHA.slice(0, 12)}.`)
  // blocked with blockedOn is a report.
  const blocked = await coder.call({ status: 'blocked', summary: 'Stuck.', blockedOn: 'Which database?' })
  assert.deepEqual(blocked.value, { role: 'coder', turn: 0, at: NOW, status: 'blocked', summary: 'Stuck.', blockedOn: 'Which database?' })
})

test('optional fields that are blank or empty are left out, an extra argument is ignored, and a reviewer\'s empty findings are kept', async (t) => {
  const coder = await fixture(t, 'coder')
  const result = await coder.call({ status: 'done', summary: 'Done.', commits: [], blockedOn: ' ', rulings: [], concerns: [], notFixed: [], role: 'x', turn: 99 })
  assert.deepEqual(result.value, { role: 'coder', turn: 0, at: NOW, status: 'done', summary: 'Done.' })
  const reviewer = await fixture(t, 'reviewer')
  const clean = await reviewer.call({ verdict: 'approved', head: SHA, summary: 'Clean.', findings: [], checks: [], addressed: [] })
  assert.deepEqual(clean.value, { role: 'reviewer', turn: 0, at: NOW, verdict: 'approved', head: SHA, summary: 'Clean.', findings: [] })
})

test('the turn is the newest the tracker saw for the child\'s session: turn 3 after its turn/start, 0 when none was seen', async (t) => {
  const f = await fixture(t, 'coder')
  assert.equal((await f.call(CODER)).value?.turn, 0)
  f.tracker.observe(f.agent.session, { type: 'turn/start', seq: 1, time: 0, data: { turn: 3 } })
  assert.equal((await f.call(CODER)).value?.turn, 3)
  // Another session's turn is not this one's.
  f.tracker.observe(childOf('c2').session, { type: 'turn/start', seq: 1, time: 0, data: { turn: 9 } })
  assert.equal((await f.call(CODER)).value?.turn, 3)
})

test('a later call replaces the earlier one', async (t) => {
  const f = await fixture(t, 'coder')
  await f.call(CODER)
  await f.call({ status: 'blocked', summary: 'Stuck after all.', blockedOn: 'The schema.' })
  assert.equal(((await f.records.lookup('c1'))!.record.report as CoderReport | undefined)?.status, 'blocked')
})

test('failures: a setReport that throws, or that gives undefined, is said to the child, and the turn goes on', async (t) => {
  const throwing = await fixture(t, 'coder', { records: { setReport: () => Promise.reject(new Error(`disk full near ${TOKEN}`)) } })
  const thrown = await throwing.call(CODER)
  assert.equal(thrown.error?.message, `dish couldn't record your report (disk full near ${maskSecrets(TOKEN)}); call report again`)
  assert.equal(thrown.concluded, 0)

  const unknown = await fixture(t, 'coder', { recorded: false })
  const missing = await unknown.call(CODER)
  assert.equal(missing.error?.message, 'dish-crew has no record of you as a crew child, so the report wasn\'t recorded; end your turn with your report as your closing message')
  assert.equal(missing.concluded, 0)
  assert.equal(unknown.setReports(), 1)
})

test('a setReport that gives undefined (the record lost the child) calls lost, once per such call; a throw, a refusal and a success don\'t', async (t) => {
  const unknown = await fixture(t, 'coder', { recorded: false })
  await unknown.call(CODER)
  assert.equal(unknown.losses(), 1)
  await unknown.call(CODER)
  assert.equal(unknown.losses(), 2)

  const throwing = await fixture(t, 'coder', { records: { setReport: () => Promise.reject(new Error('disk full')) } })
  await throwing.call(CODER)
  const known = await fixture(t, 'coder')
  await known.call({ status: 'blocked', summary: 'Stuck.' })
  await known.call(CODER)
  assert.equal(throwing.losses() + known.losses(), 0)

  // Without `lost`, the tool says the same and nothing else happens.
  const records = new CrewRecords(await tempDir())
  const bare = reportTool({ role: 'coder', agent: childOf('c1'), records, tracker: new ReportTracker() })
  await assert.rejects(bare.execute(CODER, execOf().exec), /^Error: dish-crew has no record of you as a crew child/)
})

// --- the tracker --------------------------------------------------------------------------------------------------------

function message(turn: number, step = 1) {
  return { type: 'assistant/message', seq: step, time: 0, data: { turn, step, message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] } } }
}
function turnStart(turn: number) {
  return { type: 'turn/start', seq: 0, time: 0, data: { turn } }
}
function reportCall(agent: unknown, name = REPORT_TOOL): Readonly<ToolExecution> {
  return { callId: 'call-1', name, arguments: {}, agent, signal: new AbortController().signal } as unknown as ToolExecution
}
const SUCCESS = { isError: false, value: {}, content: [], concludesTurn: true } as unknown as ToolExecutionResult

test('ReportTracker: reported only by a successful report that concludes the turn, and cleared by the next assistant message or turn', () => {
  const tracker = new ReportTracker()
  const agent = childOf('c1')
  const { session } = agent
  assert.equal(tracker.reported(session), false)
  tracker.result(reportCall(agent), { isError: true, content: [], error: { message: 'no' } } as unknown as ToolExecutionResult)
  assert.equal(tracker.reported(session), false, 'an error')
  tracker.result(reportCall(agent, 'bash'), SUCCESS)
  assert.equal(tracker.reported(session), false, 'another tool')
  tracker.result(reportCall(agent), { isError: false, value: {}, content: [] } as unknown as ToolExecutionResult)
  assert.equal(tracker.reported(session), false, 'without concludesTurn')
  tracker.result(reportCall(agent), SUCCESS)
  assert.equal(tracker.reported(session), true)
  tracker.observe(session, message(1, 2))
  assert.equal(tracker.reported(session), false, 'a later assistant message')
  tracker.result(reportCall(agent), SUCCESS)
  tracker.observe(session, { type: 'tool/result', data: { turn: 1 } })
  assert.equal(tracker.reported(session), true, 'other events change nothing')
  tracker.observe(session, turnStart(2))
  assert.equal(tracker.reported(session), false, 'a new turn')
  assert.equal(tracker.turnOf(session), 2)
})

test('ReportTracker: takeSteer counts per turn and starts again in a new turn', () => {
  const tracker = new ReportTracker()
  const { session } = childOf('c1')
  assert.deepEqual([tracker.takeSteer(session, 1, 2), tracker.takeSteer(session, 1, 2), tracker.takeSteer(session, 1, 2)], [1, 2, undefined])
  assert.deepEqual([tracker.takeSteer(session, 2, 2), tracker.takeSteer(session, 2, 2), tracker.takeSteer(session, 2, 2)], [1, 2, undefined])
  assert.equal(tracker.takeSteer(session, 3, 0), undefined)
})

test('ReportTracker: steered is cleared by an assistant message, a turn/start and forget, and two sessions are kept apart', () => {
  const tracker = new ReportTracker()
  const one = childOf('c1')
  const two = childOf('c2')
  for (const clear of [() => tracker.observe(one.session, message(1)), () => tracker.observe(one.session, turnStart(2)), () => tracker.forget('c1')]) {
    tracker.markSteered('c1')
    tracker.markSteered('c2')
    assert.equal(tracker.steered('c1'), true)
    clear()
    assert.equal(tracker.steered('c1'), false)
    assert.equal(tracker.steered('c2'), true, 'the other child stays steered')
  }
  tracker.result(reportCall(one), SUCCESS)
  tracker.observe(one.session, turnStart(4))
  tracker.result(reportCall(two), SUCCESS)
  assert.deepEqual([tracker.reported(one.session), tracker.reported(two.session)], [false, true])
  assert.deepEqual([tracker.turnOf(one.session), tracker.turnOf(two.session)], [4, 0])
  assert.deepEqual([tracker.takeSteer(one.session, 4, 1), tracker.takeSteer(two.session, 4, 1)], [1, 1])
})

test('ReportTracker: malformed events and results don\'t throw, and a turn that isn\'t a whole number is not taken', () => {
  const tracker = new ReportTracker()
  const { session } = childOf('c1')
  tracker.observe(session, turnStart(2))
  const events: unknown[] = [
    undefined, null, 5, 'turn/start', {}, { type: 'turn/start' }, { type: 'turn/start', data: null }, { type: 'turn/start', data: { turn: 'x' } },
    { type: 'assistant/message', data: { turn: 1.5 } }, { type: 'assistant/message', data: { turn: -1 } }, { get type(): never { throw new Error('no') } },
  ]
  for (const event of events) assert.doesNotThrow(() => { tracker.observe(session, event) }, String(event))
  assert.equal(tracker.turnOf(session), 2)
  for (const odd of [undefined, null, 5, 'session']) {
    assert.doesNotThrow(() => { tracker.observe(odd as never, turnStart(1)) })
    assert.doesNotThrow(() => { tracker.result(odd as never, odd as never) })
    assert.doesNotThrow(() => { tracker.result(reportCall(odd), SUCCESS) })
    assert.doesNotThrow(() => { tracker.result(reportCall({ session: odd }), SUCCESS) })
    assert.equal(tracker.turnOf(odd as never), 0)
    assert.equal(tracker.reported(odd as never), false)
    assert.equal(tracker.takeSteer(odd as never, 1, 2), undefined)
  }
})

// --- the steer listener --------------------------------------------------------------------------------------------------

interface SteerWorld {
  tracker: ReportTracker
  roles: WeakMap<object, ReportRole>
  warned: string[]
  stop(agent: SteeringAgent, turn?: number, signal?: AbortSignal): Promise<void>
}

function steerWorld(limit = 2): SteerWorld {
  const tracker = new ReportTracker()
  const roles = new WeakMap<object, ReportRole>()
  const warned: string[] = []
  const listener = reportSteerListener({ limit, tracker, roleOf: agent => roles.get(agent), warn: (format, ...args) => { warned.push([format, ...args].join(' | ')) } })
  return { tracker, roles, warned, stop: (agent, turn = 1, signal = new AbortController().signal) => listener({ agent, turn, signal }) }
}

const textOf = (steer: UserMessage): string => steer.content.map(block => block.type === 'text' ? block.text : '').join('')

test('the steer: a coder with no report since its newest message is sent back to call it, with the text, the source and the summary', async () => {
  const w = steerWorld()
  const coder = childOf('c1')
  w.roles.set(coder, 'coder')
  w.tracker.observe(coder.session, turnStart(1))
  w.tracker.observe(coder.session, message(1))
  await w.stop(coder)
  assert.equal(coder.steers.length, 1)
  const [steer] = coder.steers
  assert.equal(steer!.role, 'user')
  assert.equal(textOf(steer!), reportSteerText('coder', 1, 2))
  assert.deepEqual(steer!.source, { kind: 'dish-crew', form: 'notice', summary: 'Asked to finish with report (1 of 2)' })
  assert.equal(w.tracker.steered('c1'), true)
  assert.deepEqual(w.warned, [])
})

test('the steer: not after a successful concluding report; again after a later assistant message', async () => {
  const w = steerWorld()
  const coder = childOf('c1')
  w.roles.set(coder, 'coder')
  w.tracker.observe(coder.session, message(1))
  w.tracker.result(reportCall(coder), SUCCESS)
  await w.stop(coder)
  assert.equal(coder.steers.length, 0)
  assert.equal(w.tracker.steered('c1'), false)
  // dish-gates sent it back (a failed gate): it went on, and ended with text.
  w.tracker.observe(coder.session, message(1, 2))
  await w.stop(coder)
  assert.equal(coder.steers.length, 1)
})

test('the steer: at most two a turn, the last says what happens without it, and a new turn is steered again', async () => {
  const w = steerWorld()
  const reviewer = childOf('r1')
  w.roles.set(reviewer, 'reviewer')
  for (let step = 1; step <= 3; step++) {
    w.tracker.observe(reviewer.session, message(1, step))
    await w.stop(reviewer, 1)
  }
  assert.equal(reviewer.steers.length, 2, 'the third stop isn\'t steered')
  assert.equal(w.tracker.steered('r1'), false, 'and isn\'t marked: dish-gates falls back to its newest-message rule')
  assert.equal(textOf(reviewer.steers[0]!), reportSteerText('reviewer', 1, 2))
  assert.equal(textOf(reviewer.steers[1]!), reportSteerText('reviewer', 2, 2))
  assert.ok(textOf(reviewer.steers[1]!).endsWith(' If you end your turn without it, the main agent gets your work without a report.'))
  assert.ok(!textOf(reviewer.steers[0]!).includes('without a report'))
  assert.equal((reviewer.steers[1]!.source as { summary: string }).summary, 'Asked to finish with report (2 of 2)')
  w.tracker.observe(reviewer.session, turnStart(2))
  w.tracker.observe(reviewer.session, message(2))
  await w.stop(reviewer, 2)
  assert.equal(reviewer.steers.length, 3)
  assert.equal((reviewer.steers[2]!.source as { summary: string }).summary, 'Asked to finish with report (1 of 2)')
})

test('the steer\'s texts, word for word', () => {
  assert.equal(reportSteerText('coder', 1, 2), 'Finish by calling `report`: `status` (`done` when the work is complete and committed; `blocked` or `needs_context`, with `blockedOn`, when you can\'t go on), a `summary` of what changed, for a person, and `commits`, `rulings`, `concerns` and `notFixed` where they apply. The main agent reads your report, not your last message, and your turn ends when you call it.')
  assert.equal(reportSteerText('reviewer', 1, 2), 'Finish by calling `report`: your `verdict` (`approved` or `changes_requested`), `head` (the full sha of the commit you reviewed), a `summary`, and `findings`, each with its severity, file, line, summary and fix (an empty list for a clean review), with the `checks` you ran and, in a re-review, `addressed`. The main agent reads your report, not your last message, and your turn ends when you call it.')
  assert.equal(reportSteerText('coder', 1, 1), `${reportSteerText('coder', 1, 2)} If you end your turn without it, the main agent gets your work without a report.`)
  assert.equal(reportSteerSummary(2, 2), 'Asked to finish with report (2 of 2)')
  assert.ok(reportSteerSummary(999_999, 999_999).length <= 120)
})

test('the steer: a limit of 0 never steers, nor does an agent crew gave no report, nor an aborted stop', async () => {
  const off = steerWorld(0)
  const coder = childOf('c1')
  off.roles.set(coder, 'coder')
  await off.stop(coder)
  assert.equal(coder.steers.length, 0)

  const w = steerWorld()
  for (const agent of [{ ...childOf('main-1'), session: { id: 'main-1', header: { id: 'main-1' } } }, childOf('researcher-1'), childOf('stranger')]) {
    await w.stop(agent as SteeringAgent)
    assert.equal((agent as { steers: unknown[] }).steers.length, 0)
  }
  const aborted = new AbortController()
  aborted.abort()
  w.roles.set(coder, 'coder')
  await w.stop(coder, 1, aborted.signal)
  assert.equal(coder.steers.length, 0)
  assert.equal(w.tracker.steered('c1'), false)
})

test('the steer: reportSteered is true right after the steer, and false after the child\'s next assistant message', async () => {
  const w = steerWorld()
  const coder = childOf('c1')
  w.roles.set(coder, 'coder')
  await w.stop(coder)
  assert.equal(w.tracker.steered('c1'), true)
  w.tracker.observe(coder.session, message(1, 2))
  assert.equal(w.tracker.steered('c1'), false)
})

test('the steer: a steer that throws is logged once, the child leaves steered, and the listener resolves', async () => {
  const w = steerWorld()
  const coder = { ...childOf('c1'), steer() { throw new Error('the agent is gone') } }
  w.roles.set(coder, 'coder')
  await w.stop(coder)
  assert.equal(w.tracker.steered('c1'), false)
  w.tracker.observe(coder.session, message(1, 2))
  await w.stop(coder)
  assert.deepEqual(w.warned, ['%s | could not ask crew child c1 to finish with report: the agent is gone'])
  // A payload with nothing in it is no trouble either.
  const listener = reportSteerListener({ limit: 2, tracker: w.tracker, roleOf: () => { throw new Error('the map is gone') }, warn: () => { throw new Error('the log is closed') } })
  await listener({ agent: coder, turn: 1, signal: new AbortController().signal })
  await listener(undefined as never)
})
