import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { defineTool, ToolRuntime } from '@deepseek-ai/dsh-tools'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import type { SubagentRunEndInfo } from '@deepseek-ai/dsh-subagent'
import * as plugin from '../src/index.ts'
import type { DishCrew } from '../src/index.ts'
import { CrewRecords } from '../src/record.ts'
import { GUARD_LOOKUP_BUDGET_MS } from '../src/guard.ts'
import { DEFAULT_MESSAGE_LIMIT, MAX_REFUSED, reportGuard } from '../src/report-guard.ts'
import type { ReportGuardDeps } from '../src/report-guard.ts'
import { dirs, mountCrew, provideStub, watchLogs } from './helpers.ts'

// --- what the tests are made of -----------------------------------------------------------------------

const LIMIT = 1200

/** A child as dsh makes one: depth 1, origin `subagent`. */
function childOf(id: string) {
  return { id, options: {}, session: { id, header: { id, cwd: '/w', delegationDepth: 1, origin: 'subagent', parentSession: 'main-1' } } }
}

/** The main agent. */
function mainOf(id = 'main-1') {
  return { id, options: {}, session: { id, header: { id, cwd: '/w' } } }
}

/** `n` characters, as a report would be. */
const text = (n: number): string => 'r'.repeat(n)

interface ExecOptions {
  name?: string
  agent?: unknown
  /** The arguments as dsh hands them over: parsed. */
  args?: unknown
}

let sequence = 0
/** The part of a `ToolExecution` the guard reads, as a send_message of `message` from `agent`. */
function execOf(message: unknown, options: ExecOptions = {}): ToolExecution {
  return {
    callId: `call-${++sequence}`,
    name: options.name ?? 'send_message',
    arguments: 'args' in options ? options.args : { agent_id: 'main-1', message },
    agent: 'agent' in options ? options.agent : childOf('crew-1'),
    signal: new AbortController().signal,
  } as unknown as ToolExecution
}

const ALLOW: PreToolDecision = { kind: 'allow' }

/** `next()` that allows, and counts. */
function nextOf() {
  const spy = { calls: 0 }
  return { spy, next: (): Promise<PreToolDecision> => { spy.calls += 1; return Promise.resolve(ALLOW) } }
}

/** A guard whose record knows the ids that start with `crew-`, and which says what it was asked. */
function guardOf(more: Partial<ReportGuardDeps> = {}) {
  const asked: string[] = []
  const told: string[] = []
  const guard = reportGuard({
    messageLimit: LIMIT,
    isCrewChild: async (id) => { asked.push(id); return id.startsWith('crew-') },
    tell: (message) => { told.push(message) },
    ...more,
  })
  return { guard, asked, told }
}

/** What a child reads the first time: it frames the message as its result, and says nothing of lengths. */
const REFUSED = 'Not sent: this is your result, and in this crew your closing message is your report. '
  + 'It reaches the main agent in full, automatically, when you finish, whatever your task says about sending your result with send_message. '
  + 'Don\'t resend it shorter or in parts: send_message is closed to you until you finish. '
  + 'Finish the work and write the report as your closing message. '
  + 'If this was a question you\'re blocked on, put it in your closing message instead; the main agent will follow up.'

/** What it reads for every later send_message in the same run. */
const CLOSED = 'Not sent: send_message is closed to you until you finish, because your report was refused here once already. '
  + 'Put everything for the main agent in your closing message, and finish.'

/** What a child crew gave `report` (a coder or a reviewer) reads the first time: it reports with `report`, not its closing message. */
const REFUSED_REPORT = 'Not sent: this is your result, and in this crew you report with `report`. '
  + 'It reaches the main agent in full, automatically, when you call it, whatever your task says about sending your result with send_message. '
  + 'Don\'t resend it shorter or in parts: send_message is closed to you until you finish. '
  + 'Finish the work and call `report`. '
  + 'If this was a question you\'re blocked on, put it in your report instead; the main agent will follow up.'

/** And for every later send_message in the same run. */
const CLOSED_REPORT = 'Not sent: send_message is closed to you until you finish, because your report was refused here once already. '
  + 'Put everything for the main agent in your `report`, and finish.'

// --- the guard on its own ----------------------------------------------------------------------------

test('the default limit is 1200 characters', () => {
  assert.equal(DEFAULT_MESSAGE_LIMIT, 1200)
})

test('another tool goes to next(), however long its message, and the record is not asked', async () => {
  const { guard, asked } = guardOf()
  for (const name of ['bash', 'delegate', 'send_messages', 'SEND_MESSAGE', 'interrupt_agent', '']) {
    const { spy, next } = nextOf()
    assert.deepEqual(await guard(execOf(text(5000), { name }), next), ALLOW)
    assert.equal(spy.calls, 1, name)
  }
  assert.deepEqual(asked, [])
})

test('a top-level agent goes to next(), however long its message, and the record is not asked', async () => {
  const { guard, asked } = guardOf()
  const { spy, next } = nextOf()
  assert.deepEqual(await guard(execOf(text(5000), { agent: mainOf() }), next), ALLOW)
  assert.equal(spy.calls, 1)
  assert.deepEqual(asked, [], 'the main agent briefs its children as long as it likes')
})

test('a short message from a crew child goes to next(), and the record is not asked', async () => {
  const { guard, asked } = guardOf()
  const { spy, next } = nextOf()
  assert.deepEqual(await guard(execOf('Should I use the v2 endpoint or the v1?'), next), ALLOW)
  assert.equal(spy.calls, 1)
  assert.deepEqual(asked, [], 'the cheap checks come first')
})

test('a long message from a crew child is denied, and next() is not called; the reason names no length or limit, so there is nothing to shorten it to', async () => {
  const { guard, asked, told } = guardOf()
  const { spy, next } = nextOf()
  const decision = await guard(execOf(text(2400), { agent: childOf('crew-7') }), next)
  assert.deepEqual(decision, { kind: 'deny', reason: REFUSED })
  assert.equal(spy.calls, 0, 'a refused call is not passed on')
  assert.deepEqual(asked, ['crew-7'])
  assert.deepEqual(told, [])
  const reason = (decision as { reason: string }).reason
  assert.doesNotMatch(reason, /\d/, 'no numbers: a limit in the reason is a budget to resend within')
  assert.doesNotMatch(reason, /\blimit/i)
  assert.match(reason, /closing message is your report/)
  assert.match(reason, /Don't resend it shorter or in parts/)
})

test('exactly the limit goes to next(); one more character is denied', async () => {
  const { guard } = guardOf()
  const exact = nextOf()
  assert.deepEqual(await guard(execOf(text(LIMIT)), exact.next), ALLOW)
  assert.equal(exact.spy.calls, 1)
  const over = nextOf()
  assert.deepEqual(await guard(execOf(text(LIMIT + 1)), over.next), { kind: 'deny', reason: REFUSED })
  assert.equal(over.spy.calls, 0)
})

test('the length is the string\'s JS length', async () => {
  const { guard } = guardOf({ messageLimit: 10 })
  // Five emoji are ten UTF-16 code units: the limit. Six are twelve.
  const five = nextOf()
  assert.deepEqual(await guard(execOf('😀'.repeat(5)), five.next), ALLOW)
  const six = nextOf()
  assert.deepEqual(await guard(execOf('😀'.repeat(6)), six.next), { kind: 'deny', reason: REFUSED })
})

test('a child that is not crew\'s goes to next(), however long its message', async () => {
  const { guard, asked } = guardOf()
  const { spy, next } = nextOf()
  assert.deepEqual(await guard(execOf(text(5000), { agent: childOf('stranger') }), next), ALLOW)
  assert.equal(spy.calls, 1)
  assert.deepEqual(asked, ['stranger'], 'the record is asked by the child\'s id')
})

test('an agent with no id goes to next(), and the record is not asked', async () => {
  const { guard, asked } = guardOf()
  for (const agent of [undefined, null, {}, { id: '' }, { id: 7 }]) {
    const { spy, next } = nextOf()
    assert.deepEqual(await guard(execOf(text(5000), { agent }), next), ALLOW)
    assert.equal(spy.calls, 1)
  }
  assert.deepEqual(asked, [])
})

test('an agent that can not be read is looked up like any child', async () => {
  const { guard, asked } = guardOf()
  const unreadable = { id: 'crew-2', options: {}, get session(): never { throw new Error('the session is gone') } }
  const { spy, next } = nextOf()
  assert.deepEqual(await guard(execOf(text(5000), { agent: unreadable }), next), { kind: 'deny', reason: REFUSED })
  assert.equal(spy.calls, 0)
  assert.deepEqual(asked, ['crew-2'])
})

test('a lookup that fails goes to next() with one warning for each distinct problem: a message is harmless, a refused question is not', async () => {
  const told: string[] = []
  let failure = 'EIO: unreadable'
  const failing = reportGuard({ messageLimit: LIMIT, isCrewChild: () => Promise.reject(new Error(failure)), tell: (message) => { told.push(message) } })
  const { spy, next } = nextOf()
  assert.deepEqual(await failing(execOf(text(5000)), next), ALLOW)
  assert.equal(spy.calls, 1)
  assert.equal(told.length, 1)
  assert.match(told[0]!, /EIO: unreadable/)
  assert.match(told[0]!, /let through/)

  assert.deepEqual(await failing(execOf(text(5000)), next), ALLOW)
  assert.equal(told.length, 1, 'the same problem is said once')
  failure = 'EACCES: denied'
  assert.deepEqual(await failing(execOf(text(5000)), next), ALLOW)
  assert.equal(told.length, 2, 'another problem is said')
  assert.match(told[1]!, /EACCES: denied/)

  const throwing = reportGuard({ messageLimit: LIMIT, isCrewChild: () => { throw new Error('the record is closed') }, tell: (message) => { told.push(message) } })
  assert.deepEqual(await throwing(execOf(text(5000)), next), ALLOW)
  assert.match(told[2]!, /the record is closed/)
  assert.equal(spy.calls, 4)
})

test('a lookup slower than its budget goes to next(), and says so once', async () => {
  const told: string[] = []
  const hanging = reportGuard({ messageLimit: LIMIT, isCrewChild: () => new Promise(() => {}), budgetMs: 25, tell: (message) => { told.push(message) } })
  const { spy, next } = nextOf()
  const started = performance.now()
  assert.deepEqual(await hanging(execOf(text(5000)), next), ALLOW)
  assert.deepEqual(await hanging(execOf(text(5000)), next), ALLOW)
  assert.ok(performance.now() - started < 1000)
  assert.equal(spy.calls, 2)
  assert.equal(told.length, 1)
  assert.match(told[0]!, /25 ms/)
  assert.ok(GUARD_LOOKUP_BUDGET_MS >= 100 && GUARD_LOOKUP_BUDGET_MS <= 5000, 'the budget it defaults to is a few seconds at the most')
})

test('a tell that throws does not fail the call', async () => {
  const guard = reportGuard({ messageLimit: LIMIT, isCrewChild: () => Promise.reject(new Error('no')), tell: () => { throw new Error('the log is closed') } })
  const { spy, next } = nextOf()
  assert.deepEqual(await guard(execOf(text(5000)), next), ALLOW)
  assert.equal(spy.calls, 1)
})

test('a message that is not a string goes to next(), and the record is not asked', async () => {
  const { guard, asked } = guardOf()
  const long = text(5000)
  const cases: unknown[] = [undefined, null, 42, true, [long], { text: long }, { toString: () => long }]
  for (const message of cases) {
    const { spy, next } = nextOf()
    assert.deepEqual(await guard(execOf(message), next), ALLOW, JSON.stringify(message))
    assert.equal(spy.calls, 1)
  }
  // And arguments that are not an object with a message: nothing, null, a string (dsh hands over the parsed arguments, never JSON text), a list, or an object with a getter that throws.
  const unreadable = { get message(): never { throw new Error('no') } }
  for (const args of [undefined, null, long, JSON.stringify({ message: long }), [long], {}, { agent_id: 'main-1' }, unreadable]) {
    const { spy, next } = nextOf()
    assert.deepEqual(await guard(execOf(undefined, { args }), next), ALLOW)
    assert.equal(spy.calls, 1)
  }
  assert.deepEqual(asked, [])
})

test('a limit of 0 turns the guard off: everything goes to next(), and the record is not asked', async () => {
  const { guard, asked } = guardOf({ messageLimit: 0 })
  for (const message of [text(5000), text(1), '']) {
    const { spy, next } = nextOf()
    assert.deepEqual(await guard(execOf(message), next), ALLOW)
    assert.equal(spy.calls, 1)
  }
  assert.deepEqual(asked, [])
})

test('the guard never throws for what it is given', async () => {
  const { guard } = guardOf()
  const { next } = nextOf()
  for (const exec of [undefined, null, {}, { name: 'send_message' }, { name: 'send_message', arguments: { message: text(5000) } }]) {
    assert.deepEqual(await guard(exec as never, next), ALLOW)
  }
  for (const id of ['nobody', '', undefined, null, 7, {}]) assert.doesNotThrow(() => { guard.runEnded(id as never) })
})

// --- a refusal closes send_message until the run ends ------------------------------------------------------

test('after a refusal the same child\'s later send_message is refused too, short or not, without asking the record again; other crew children and other tools are not affected', async () => {
  const { guard, asked } = guardOf()
  const first = nextOf()
  assert.deepEqual(await guard(execOf(text(5000), { agent: childOf('crew-1') }), first.next), { kind: 'deny', reason: REFUSED })
  assert.deepEqual(asked, ['crew-1'])

  for (const message of ['Which file?', '', text(3), text(5000), undefined, 42]) {
    assert.deepEqual(await guard(execOf(message, { agent: childOf('crew-1') }), first.next), { kind: 'deny', reason: CLOSED }, String(message))
  }
  assert.deepEqual(await guard(execOf(undefined, { agent: childOf('crew-1'), args: undefined }), first.next), { kind: 'deny', reason: CLOSED }, 'whatever the arguments are')
  assert.equal(first.spy.calls, 0)
  assert.deepEqual(asked, ['crew-1'], 'the record is not read again: only children it vouched for are held')

  const others = nextOf()
  assert.deepEqual(await guard(execOf('Which file?', { agent: childOf('crew-2') }), others.next), ALLOW, 'another crew child')
  assert.deepEqual(await guard(execOf('Which file?', { agent: mainOf('crew-1') }), others.next), ALLOW, 'a top-level agent is checked before the set')
  assert.deepEqual(await guard(execOf(text(5000), { name: 'bash', agent: childOf('crew-1') }), others.next), ALLOW, 'another tool of the same child')
  assert.equal(others.spy.calls, 3)
  assert.deepEqual(await guard(execOf(text(5000), { agent: childOf('crew-2') }), nextOf().next), { kind: 'deny', reason: REFUSED }, 'and the other child is told the first time as well')
})

test('only a crew child that was refused is held: a child that is not crew\'s, one whose record could not be read, and one that sent a short message are not', async () => {
  const told: string[] = []
  let readable = true
  const guard = reportGuard({
    messageLimit: LIMIT,
    isCrewChild: async (id) => { if (!readable) throw new Error('EIO'); return id.startsWith('crew-') },
    tell: (message) => { told.push(message) },
  })
  const { spy, next } = nextOf()
  assert.deepEqual(await guard(execOf(text(5000), { agent: childOf('stranger') }), next), ALLOW)
  assert.deepEqual(await guard(execOf('Which file?', { agent: childOf('stranger') }), next), ALLOW)
  readable = false
  assert.deepEqual(await guard(execOf(text(5000), { agent: childOf('crew-1') }), next), ALLOW, 'fail open')
  readable = true
  assert.deepEqual(await guard(execOf('Which file?', { agent: childOf('crew-1') }), next), ALLOW, 'and it was not held for it')
  assert.deepEqual(await guard(execOf('Which file?', { agent: childOf('crew-2') }), next), ALLOW)
  assert.deepEqual(await guard(execOf(text(5000), { agent: childOf('crew-2') }), next), { kind: 'deny', reason: REFUSED }, 'a short message before it changed nothing')
  assert.equal(spy.calls, 5)
  assert.equal(told.length, 1)
})

test('runEnded opens send_message for that child only, and a report in its next run is refused afresh', async () => {
  const { guard, asked } = guardOf()
  assert.deepEqual(await guard(execOf(text(5000), { agent: childOf('crew-1') }), nextOf().next), { kind: 'deny', reason: REFUSED })
  assert.deepEqual(await guard(execOf(text(5000), { agent: childOf('crew-2') }), nextOf().next), { kind: 'deny', reason: REFUSED })

  guard.runEnded('crew-1')
  const open = nextOf()
  assert.deepEqual(await guard(execOf('Which file?', { agent: childOf('crew-1') }), open.next), ALLOW)
  assert.equal(open.spy.calls, 1)
  assert.deepEqual(await guard(execOf('Which file?', { agent: childOf('crew-2') }), nextOf().next), { kind: 'deny', reason: CLOSED }, 'the other child\'s run has not ended')

  assert.deepEqual(await guard(execOf(text(5000), { agent: childOf('crew-1') }), nextOf().next), { kind: 'deny', reason: REFUSED })
  assert.deepEqual(await guard(execOf('Which file?', { agent: childOf('crew-1') }), nextOf().next), { kind: 'deny', reason: CLOSED })
  assert.deepEqual(asked, ['crew-1', 'crew-2', 'crew-1'])
})

test('the set of refused children is bounded: past MAX_REFUSED the oldest is let go', async () => {
  assert.ok(MAX_REFUSED >= 100 && MAX_REFUSED <= 1000, 'a few hundred: more than runs at once, and bounded')
  const { guard } = guardOf({ messageLimit: 10 })
  for (let i = 0; i < MAX_REFUSED; i++) {
    assert.deepEqual(await guard(execOf(text(11), { agent: childOf(`crew-${i}`) }), nextOf().next), { kind: 'deny', reason: REFUSED })
  }
  assert.deepEqual(await guard(execOf('hi', { agent: childOf('crew-0') }), nextOf().next), { kind: 'deny', reason: CLOSED }, 'all of them are held')
  // One more: crew-0, the oldest, goes.
  assert.deepEqual(await guard(execOf(text(11), { agent: childOf('crew-extra') }), nextOf().next), { kind: 'deny', reason: REFUSED })
  assert.deepEqual(await guard(execOf('hi', { agent: childOf('crew-0') }), nextOf().next), ALLOW, 'the oldest was let go')
  assert.deepEqual(await guard(execOf('hi', { agent: childOf('crew-1') }), nextOf().next), { kind: 'deny', reason: CLOSED }, 'the rest are held')
  assert.deepEqual(await guard(execOf('hi', { agent: childOf('crew-extra') }), nextOf().next), { kind: 'deny', reason: CLOSED })
  assert.deepEqual(await guard(execOf('hi', { agent: childOf(`crew-${MAX_REFUSED - 1}`) }), nextOf().next), { kind: 'deny', reason: CLOSED })
})

test('with the guard off, a refusal can not have happened: a limit of 0 holds nobody', async () => {
  const { guard } = guardOf({ messageLimit: 0 })
  assert.deepEqual(await guard(execOf(text(5000), { agent: childOf('crew-1') }), nextOf().next), ALLOW)
  assert.deepEqual(await guard(execOf('hi', { agent: childOf('crew-1') }), nextOf().next), ALLOW)
})

// --- the words for a child crew gave `report` (step 7) ------------------------------------------------------

test('a child crew gave report reads REFUSED_REPORT the first time and CLOSED_REPORT after, word for word; the checks and the hold are as before', async () => {
  const reporter = childOf('crew-coder')
  const asked: unknown[] = []
  const { guard } = guardOf({ reports: (agent) => { asked.push(agent); return agent === reporter } })
  const short = nextOf()
  assert.deepEqual(await guard(execOf('Which file?', { agent: reporter }), short.next), ALLOW, 'a short message from a child with report is still next()')
  assert.equal(short.spy.calls, 1)
  assert.deepEqual(asked, [], 'reports is read for a refusal\'s words only')
  const first = await guard(execOf(text(5000), { agent: reporter }), nextOf().next)
  assert.deepEqual(first, { kind: 'deny', reason: REFUSED_REPORT })
  for (const message of ['Which file?', text(5000)]) {
    assert.deepEqual(await guard(execOf(message, { agent: reporter }), nextOf().next), { kind: 'deny', reason: CLOSED_REPORT })
  }
  const reason = (first as { reason: string }).reason
  assert.doesNotMatch(reason, /\d/)
  assert.doesNotMatch(reason, /closing message/, 'a child that reports with report is never told its closing message is its report')
  assert.doesNotMatch(CLOSED_REPORT, /closing message/)
  // Another child of the same guard, which crew didn't give report, reads today's words.
  assert.deepEqual(await guard(execOf(text(5000), { agent: childOf('crew-researcher') }), nextOf().next), { kind: 'deny', reason: REFUSED })
  assert.deepEqual(await guard(execOf('hi', { agent: childOf('crew-researcher') }), nextOf().next), { kind: 'deny', reason: CLOSED })
})

test('with reports false, throwing or absent, a refusal is today\'s two texts, byte for byte', async () => {
  const cases: Array<[string, Partial<ReportGuardDeps>]> = [
    ['false', { reports: () => false }],
    ['throwing', { reports: () => { throw new Error('the registrar is gone') } }],
    ['absent', {}],
  ]
  for (const [name, more] of cases) {
    const { guard, told } = guardOf(more)
    assert.deepEqual(await guard(execOf(text(5000)), nextOf().next), { kind: 'deny', reason: REFUSED }, name)
    assert.deepEqual(await guard(execOf('hi'), nextOf().next), { kind: 'deny', reason: CLOSED }, name)
    assert.deepEqual(told, [], name)
  }
})

// --- through the plugin and the real tool registry ----------------------------------------------------

type Result = { isError: boolean, content: Array<{ type: string, text?: string }> }
const textOf = (result: Result): string => result.content.map(block => block.type === 'text' ? block.text ?? '' : '').join('\n')

/** dsh's tool registry, a `send_message` that records what it is given, and dish-crew with `config`; crew child `crew-child` is in its record. */
async function mounted(t: { after(fn: () => unknown): void }, config: Partial<plugin.Config> = {}) {
  const where = await dirs()
  const ctx = new Context()
  await provideStub(ctx, 'systemPrompt', { tools() {}, section() {}, context() {}, getSectionOrder: () => 1, getContextOrder: () => 1 })
  await ctx.plugin(ToolRuntime, {})
  const sent: Array<Record<string, unknown>> = []
  ctx.tools.register(defineTool({
    name: 'send_message',
    description: 'Send a message to an agent.',
    parameters: { agent_id: { type: 'string', required: true }, message: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args) { sent.push({ ...args }); return 'delivered' },
  }))
  const logs = watchLogs(ctx)
  // A listener from before crew was mounted, standing in for dsh's auto-review and the hooks: it hears every call that reaches it.
  const heard: string[] = []
  ctx.on('tools/pre-execute', (exec, next) => { heard.push(String(exec.callId)); return next() })
  const handle = mountCrew(ctx, where.data, config)
  t.after(async () => { await handle.dispose() })
  await handle
  const crew = ctx.get('dishCrew') as DishCrew
  // The record knows this crew child, as delegate writes it before it starts one.
  await crew.records.addChild('main-1', { id: 'crew-child', role: 'researcher', title: 'find the cause', model: 'claude-sonnet-5.5', family: 'anthropic' })
  let calls = 0
  const send = (agent: unknown, message: string): Promise<Result> =>
    ctx.tools.execute({ callId: `real-${++calls}` as never, name: 'send_message', arguments: { agent_id: 'main-1', message }, agent: agent as never, signal: new AbortController().signal }) as unknown as Promise<Result>
  return { ctx, where, crew, sent, logs, heard, handle, send }
}

test('the plugin refuses a crew child\'s long send_message in dsh\'s registry, and the tool does not run; a short one, the main agent and a child crew did not start are not touched', async (t) => {
  const w = await mounted(t)
  // Everything that goes through first, since a refusal closes send_message to that child (see below).
  assert.equal((await w.send(childOf('crew-child'), 'Which of the two config files is the live one?')).isError, false)
  assert.equal((await w.send(childOf('crew-child'), text(LIMIT))).isError, false)
  assert.equal((await w.send(mainOf(), text(5000))).isError, false, 'the main agent')
  assert.equal((await w.send(childOf('stranger'), text(5000))).isError, false, 'a child of some other plugin')
  assert.equal(w.sent.length, 4)

  const refused = await w.send(childOf('crew-child'), text(2400))
  assert.equal(refused.isError, true)
  assert.equal(textOf(refused), `Error: ${REFUSED}`)
  assert.equal(w.sent.length, 4, 'it was not delivered')
  assert.deepEqual(w.logs.filter(line => line.startsWith('[dish-crew] warn:')), [])
})

/** dsh's `subagent/end` for `id`, as the plugin hears it. */
function ended(ctx: Context, id: string): void {
  ctx.emit('subagent/end', { runId: 'run-1', provider: 'spawn', id, local: true, stopReason: 'end_turn' } as unknown as SubagentRunEndInfo)
}

test('through the registry: after a refusal the child can not send_message until its run ends; another crew child is not affected; a follow-up run can ask again', async (t) => {
  const w = await mounted(t)
  await w.crew.records.addChild('main-1', { id: 'crew-other', role: 'coder', title: 'add login', model: 'claude-sonnet-5.5', family: 'anthropic' })
  assert.equal(textOf(await w.send(childOf('crew-child'), text(2400))), `Error: ${REFUSED}`)
  for (const message of ['Which file?', text(2400), '']) {
    const closed = await w.send(childOf('crew-child'), message)
    assert.equal(closed.isError, true)
    assert.equal(textOf(closed), `Error: ${CLOSED}`)
  }
  assert.deepEqual(w.sent, [], 'nothing was delivered')
  assert.equal((await w.send(childOf('crew-other'), 'Which file?')).isError, false, 'another crew child')
  assert.equal((await w.send(mainOf(), 'Go on with the fix.')).isError, false, 'the main agent')

  // The run ends: dsh says so with `subagent/end`, which crew's own listener hears.
  ended(w.ctx, 'crew-other')
  assert.equal((await w.send(childOf('crew-child'), 'Which file?')).isError, true, 'the end of another child\'s run does not open it')
  ended(w.ctx, 'crew-child')
  assert.equal((await w.send(childOf('crew-child'), 'Which file?')).isError, false, 'a follow-up run may ask again')
  assert.equal(textOf(await w.send(childOf('crew-child'), text(2400))), `Error: ${REFUSED}`, 'and a report in it is refused afresh')
})

test('through the registry: the guard is the first to hear a call, so a refused call reaches no listener registered before it', async (t) => {
  const w = await mounted(t)
  assert.equal(w.heard.length, 0)
  assert.equal((await w.send(childOf('crew-child'), 'Which file?')).isError, false)
  assert.equal(w.heard.length, 1, 'a call that goes on is heard by the others')
  assert.equal((await w.send(childOf('crew-child'), text(2400))).isError, true)
  assert.equal(w.heard.length, 1, 'a refused call is not: no hook, auto-review or recorder after the guard hears of it')
  assert.equal((await w.send(childOf('crew-child'), 'Which file?')).isError, true)
  assert.equal(w.heard.length, 1, 'nor is one refused because send_message is closed')
})

test('the limit is the messageLimit setting; 0 turns the guard off', async (t) => {
  const small = await mounted(t, { messageLimit: 50 })
  assert.equal((await small.send(childOf('crew-child'), text(50))).isError, false)
  const refused = await small.send(childOf('crew-child'), text(51))
  assert.equal(refused.isError, true)
  assert.equal(textOf(refused), `Error: ${REFUSED}`)

  const off = await mounted(t, { messageLimit: 0 })
  assert.equal((await off.send(childOf('crew-child'), text(100_000))).isError, false)
  assert.equal(off.sent.length, 1)
})

test('messageLimit is a natural number and defaults to 1200', () => {
  /** The schema as the host parses a row's config: whatever it is given. */
  const parse = (input: Record<string, unknown>): plugin.Config => plugin.Config(input as unknown as plugin.Config)
  assert.equal(parse({}).messageLimit, 1200)
  assert.equal(parse({ messageLimit: 0 }).messageLimit, 0)
  assert.equal(parse({ messageLimit: 300 }).messageLimit, 300)
  assert.throws(() => parse({ messageLimit: -1 }))
  assert.throws(() => parse({ messageLimit: 1.5 }))
  assert.throws(() => parse({ messageLimit: '12' }))
})

test('a record that can not be read lets the message through, with one warning of the plugin however often it happens', async (t) => {
  const w = await mounted(t)
  ;(w.crew.records as unknown as { lookup: () => Promise<never> }).lookup = () => Promise.reject(new Error('EIO: the record is unreadable'))
  assert.equal((await w.send(childOf('crew-child'), text(5000))).isError, false)
  assert.equal((await w.send(childOf('crew-child'), text(5000))).isError, false)
  assert.equal(w.sent.length, 2)
  assert.equal(w.logs.filter(line => line.includes('EIO: the record is unreadable')).length, 1)
  assert.match(w.logs.find(line => line.includes('EIO: the record is unreadable'))!, /^\[dish-crew\] warn: /)
})

test('the guard goes with the plugin: once dish-crew is unloaded, a long message is delivered', async (t) => {
  const w = await mounted(t)
  assert.equal((await w.send(childOf('crew-child'), text(5000))).isError, true)
  await w.handle.dispose()
  assert.equal((await w.send(childOf('crew-child'), text(5000))).isError, false)
})

test('the guard is registered before the plugin awaits anything: a crew child is refused while the plugin is still pruning, before dishCrew is provided', async (t) => {
  const where = await dirs()
  const ctx = new Context()
  await provideStub(ctx, 'systemPrompt', { tools() {}, section() {}, context() {}, getSectionOrder: () => 1, getContextOrder: () => 1 })
  await ctx.plugin(ToolRuntime, {})
  ctx.tools.register(defineTool({
    name: 'send_message',
    description: 'Send a message to an agent.',
    parameters: { agent_id: { type: 'string', required: true }, message: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() { return 'delivered' },
  }))
  // The record is on disk already, as it is after a restart: the plugin is still loading when the call comes.
  const records = new CrewRecords(where.data)
  await records.addChild('main-1', { id: 'crew-child', role: 'researcher', title: 'find the cause', model: 'claude-sonnet-5.5', family: 'anthropic' })
  await records.flush()
  const loading = mountCrew(ctx, where.data)
  t.after(async () => { await loading.dispose() })
  // cordis starts `apply` a few microtasks after `plugin()` returns. This loop is deterministic: only microtasks run in it, so no
  // file read can finish, and `apply` has run as far as its first `await` (the pruning of old records) and no further. How many
  // ticks cordis needs before `apply` starts is cordis's scheduling, not ours: if an upgrade needs more than 50, the call below
  // goes through unguarded and this test fails loudly (the call is not refused) instead of flaking.
  for (let tick = 0; tick < 50; tick++) await Promise.resolve()
  assert.equal(ctx.get('dishCrew'), undefined, 'not provided yet: apply has not finished')
  const result = await ctx.tools.execute({
    callId: 'early-1' as never,
    name: 'send_message',
    arguments: { agent_id: 'main-1', message: text(5000) },
    agent: childOf('crew-child') as never,
    signal: new AbortController().signal,
  }) as unknown as Result
  assert.equal(result.isError, true)
  assert.equal(textOf(result), `Error: ${REFUSED}`)
  await loading
})
