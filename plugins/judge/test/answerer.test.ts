import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { defineTool, ToolRuntime } from '@deepseek-ai/dsh-tools'
import ApprovalService, { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { approvalAnswerer, childPolicy, CREW_LOOKUP_BUDGET_MS, registerApprovalAnswerer } from '../src/answerer.ts'
import type { ApprovalAnswererRequest, ChildPolicyDeps } from '../src/answerer.ts'
import type { Answer, Decision, JudgeRequest, JudgeResult } from '../src/client.ts'
import { registerCommandGate, VerdictCache, verdictOwner } from '../src/gate.ts'
import type { JudgeLogLine } from '../src/log.ts'
import { DEFAULT_SETTINGS } from '../src/settings.ts'
import { choiceAnswer, dirs, jevBody, mountJudge, noulAnswer, provideStub, startFakeJev } from './helpers.ts'

// --- what the tests are made of -----------------------------------------------------------------------

/** A session as far as dsh's approval service and the gate read one: a log with `seq`, `eventAt` and `append`. */
interface FakeEvent { type: string, data: Record<string, unknown> }
interface FakeSession {
  id: string
  header: Record<string, unknown>
  inheritedEventCount: number
  readonly events: FakeEvent[]
  readonly seq: number
  eventAt(seq: number): FakeEvent | undefined
  append(type: string, data: Record<string, unknown>): void
  snapshotEvents(from?: number): readonly FakeEvent[]
}

interface SessionOptions {
  /** A crew child: the session header's `delegationDepth` and `origin`, which is how dsh marks one. */
  child?: boolean
  cwd?: string
  /** The approval policy the session starts with, as dsh-subagent pins a child's: `never`. */
  policy?: 'ask' | 'never'
  /** The first user message: a child's brief, a main agent's prompt. */
  prompt?: string
  /** A turn is open, which the real approval service requires of a request. */
  turn?: boolean
}

function sessionOf(id: string, options: SessionOptions = {}): FakeSession {
  const events: FakeEvent[] = []
  const session: FakeSession = {
    id,
    header: { id, cwd: options.cwd ?? '/work/app', ...options.child === true ? { delegationDepth: 1, origin: 'subagent' } : {} },
    inheritedEventCount: 0,
    events,
    get seq() { return events.length },
    eventAt: seq => events[seq],
    append(type, data) { events.push({ type, data }) },
    snapshotEvents: (from = 0) => events.slice(from),
  }
  if (options.policy !== undefined) session.append('approval/policy', { policy: options.policy, source: 'delegation' })
  session.append('user/message', { id: 'm1', role: 'user', content: [{ type: 'text', text: options.prompt ?? 'fix the failing test in parser.ts' }], source: { kind: 'user' } })
  if (options.turn !== false) session.append('turn/start', { turn: 1 })
  return session
}

interface FakeAgent {
  id: string
  options: object
  session: FakeSession
}

function agentOf(id: string, options: SessionOptions = {}): FakeAgent {
  return { id, options: {}, session: sessionOf(id, options) }
}

const main = (id = 'main-1', options: SessionOptions = {}): FakeAgent => agentOf(id, options)
const child = (id = 'child-1', options: SessionOptions = {}): FakeAgent => agentOf(id, { child: true, policy: 'never', prompt: 'add a test for the parser', ...options })

/** The policy events of a session, in order. */
const policies = (agent: FakeAgent): unknown[] => agent.session.events.filter(event => event.type === 'approval/policy').map(event => event.data.policy)

/** `next()` that answers what it is told to, and counts how many times it was called. */
function nextOf(outcome: ApprovalOutcome = 'allowed-once') {
  const spy = { calls: 0 }
  const next = (): Promise<ApprovalOutcome> => { spy.calls += 1; return Promise.resolve(outcome) }
  return { spy, next }
}

/** A log sink that keeps what is written. */
function sink() {
  const lines: JudgeLogLine[] = []
  return { lines, log: { write(line: JudgeLogLine): void { lines.push(line) } } }
}

/** The request the approval service passes: what dsh's tools send for a sandbox escalation, and for a hook's ask. */
function requestOf(agent: unknown, toolName = 'bash', callId: string | null = 'call-1', reason = 'escalate sandbox to danger-full-access: needs the network'): ApprovalAnswererRequest {
  return { agent, toolName, ...callId === null ? {} : { callId }, reason, signal: new AbortController().signal } as ApprovalAnswererRequest
}

const COVERED = { verdict: 'allow', escalationCovered: true } as const

/** Everything the answerer is not to approve for a child: and, for the main agent, everything that goes to the human. */
const OTHER_ENTRIES = [
  ['no entry for the call', undefined],
  ['an ask (the gate\'s own, or another listener\'s)', { verdict: 'ask', escalationCovered: false }],
  ['a deny', { verdict: 'deny', escalationCovered: false }],
  ['an allow with no escalation covered', { verdict: 'allow', escalationCovered: false }],
  // The gate never writes these two; a cache that held one still can't approve anything.
  ['an ask that says its escalation is covered', { verdict: 'ask', escalationCovered: true }],
  ['a deny that says its escalation is covered', { verdict: 'deny', escalationCovered: true }],
] as const

// --- approvalAnswerer: the main agent ------------------------------------------------------------------

test('main agent: the gate\'s own ask goes to you, through next(), and what you say is the outcome', async () => {
  const agent = main()
  const cache = new VerdictCache()
  cache.set(verdictOwner(agent), 'call-1', { verdict: 'ask', escalationCovered: false })
  for (const said of ['allowed-once', 'rejected', 'cancelled', 'unavailable'] as const) {
    const { spy, next } = nextOf(said)
    const { log, lines } = sink()
    const outcome = await approvalAnswerer(cache, log)(requestOf(agent), next)
    assert.equal(outcome, said)
    assert.equal(spy.calls, 1)
    assert.equal(lines.at(-1)?.decision, 'pass')
  }
})

test('main agent: an escalation the gate covered is allowed once, and you are not asked', async () => {
  const agent = main()
  const cache = new VerdictCache()
  cache.set(verdictOwner(agent), 'call-1', COVERED)
  const { spy, next } = nextOf('rejected')
  const { log, lines } = sink()
  assert.equal(await approvalAnswerer(cache, log)(requestOf(agent), next), 'allowed-once')
  assert.equal(spy.calls, 0)
  assert.equal(lines.length, 1)
  assert.equal(lines[0]!.decision, 'allowed-once')
})

test('main agent: any other request goes to you, and the judge approves nothing alone', async () => {
  const agent = main()
  for (const [name, entry] of OTHER_ENTRIES) {
    const cache = new VerdictCache()
    if (entry !== undefined) cache.set(verdictOwner(agent), 'call-1', entry)
    const { spy, next } = nextOf('rejected')
    const { log, lines } = sink()
    assert.equal(await approvalAnswerer(cache, log)(requestOf(agent), next), 'rejected', name)
    assert.equal(spy.calls, 1, name)
    assert.equal(lines.at(-1)?.decision, 'pass', name)
  }
  // A request with no call id (plugin_manager and the like) can't be a call the gate judged, whatever the cache holds.
  const cache = new VerdictCache()
  cache.set(verdictOwner(agent), 'call-1', COVERED)
  const { spy, next } = nextOf('unavailable')
  const { log } = sink()
  assert.equal(await approvalAnswerer(cache, log)(requestOf(agent, 'plugin_manager', null), next), 'unavailable')
  assert.equal(spy.calls, 1)
})

test('main agent: a cache that throws goes to you, the same as no entry', async () => {
  const boom = { get: () => { throw new Error('the cache is broken') } }
  const { spy, next } = nextOf('rejected')
  const { log, lines } = sink()
  assert.equal(await approvalAnswerer(boom, log)(requestOf(main()), next), 'rejected')
  assert.equal(spy.calls, 1)
  assert.equal(lines.at(-1)?.decision, 'pass')
})

// --- approvalAnswerer: a child ------------------------------------------------------------------------

test('child: a cached allow with the escalation covered, for the same agent and call, is allowed once, and next() is never called', async () => {
  const agent = child()
  const cache = new VerdictCache()
  cache.set(verdictOwner(agent), 'call-1', COVERED)
  const { spy, next } = nextOf('allowed-once')
  const { log, lines } = sink()
  assert.equal(await approvalAnswerer(cache, log)(requestOf(agent), next), 'allowed-once')
  assert.equal(spy.calls, 0)
  assert.equal(lines.length, 1)
  assert.equal(lines[0]!.decision, 'allowed-once')
  assert.equal(lines[0]!.child, true)
})

test('child: everything else is rejected, and next() is never called, whatever you would have said', async () => {
  const agent = child()
  for (const [name, entry] of OTHER_ENTRIES) {
    const cache = new VerdictCache()
    if (entry !== undefined) cache.set(verdictOwner(agent), 'call-1', entry)
    const { spy, next } = nextOf('allowed-once')
    const { log, lines } = sink()
    assert.equal(await approvalAnswerer(cache, log)(requestOf(agent), next), 'rejected', name)
    assert.equal(spy.calls, 0, `${name}: a child never waits on a human`)
    assert.equal(lines.length, 1, name)
    assert.equal(lines[0]!.decision, 'rejected', name)
  }
})

test('child: no call id, a cache that throws, and an agent that is not top-level and not known are all rejected, with next() never called', async () => {
  const agent = child()
  const cache = new VerdictCache()
  cache.set(verdictOwner(agent), 'call-1', COVERED)
  const broken = { get: () => { throw new Error('the cache is broken') } }
  const odd: Array<[string, { get: VerdictCache['get'] }, ApprovalAnswererRequest | null | undefined]> = [
    ['no call id', cache, requestOf(agent, 'plugin_manager', null)],
    ['a cache that throws', broken, requestOf(agent)],
    ['no agent', cache, requestOf(undefined)],
    ['an agent with no session header, which is not trusted as the main agent', cache, requestOf({ id: 'odd-1', options: {}, session: {} })],
    ['a depth that is not 0', cache, requestOf({ id: 'odd-2', options: { subagentDepth: 2 }, session: { header: { id: 'odd-2' } } })],
    ['a null request', cache, null],
    ['an undefined request', cache, undefined],
    ['an empty request', cache, {}],
  ]
  for (const [name, source, request] of odd) {
    const { spy, next } = nextOf('allowed-once')
    const { log } = sink()
    const outcome = await approvalAnswerer(source, log)(request as never, next)
    assert.equal(outcome, 'rejected', name)
    assert.equal(spy.calls, 0, name)
  }
})

test('child: an agent that throws when it is read is a child, and is rejected', async () => {
  const unreadable = { id: 'odd-3', options: {}, get session(): never { throw new Error('the session is gone') } }
  const cache = new VerdictCache()
  const { spy, next } = nextOf('allowed-once')
  assert.equal(await approvalAnswerer(cache, sink().log)(requestOf(unreadable), next), 'rejected')
  assert.equal(spy.calls, 0)
})

test('child: a log that throws, or an answerer with no log at all, still rejects', async () => {
  const agent = child()
  const { spy, next } = nextOf('allowed-once')
  const throwing = { write(): void { throw new Error('disk full') } }
  assert.equal(await approvalAnswerer(new VerdictCache(), throwing)(requestOf(agent), next), 'rejected')
  assert.equal(await approvalAnswerer(new VerdictCache(), { write: () => undefined })(requestOf(agent), next), 'rejected')
  assert.equal(spy.calls, 0)
})

test('child: next() is not called even when it is the only thing that can answer, and an aborted request is not special', async () => {
  const agent = child()
  const controller = new AbortController()
  controller.abort()
  const { spy, next } = nextOf('allowed-once')
  const { log } = sink()
  const request = { ...requestOf(agent), signal: controller.signal } as ApprovalAnswererRequest
  assert.equal(await approvalAnswerer(new VerdictCache(), log)(request, next), 'rejected')
  assert.equal(spy.calls, 0)
})

// --- the cache is by agent: one agent's covered allow is not another's ---------------------------------

test('a collision across owners: agent B\'s covered allow can not approve agent A\'s call with the same call id', async () => {
  const a = child('child-A')
  const b = child('child-B')
  const mainA = main('main-A')
  const cache = new VerdictCache()
  cache.set(verdictOwner(b), 'call-7', COVERED)
  const { log } = sink()
  const answer = approvalAnswerer(cache, log)

  const forChildA = nextOf('allowed-once')
  assert.equal(await answer(requestOf(a, 'bash', 'call-7'), forChildA.next), 'rejected', 'A is a child: no entry of its own, so rejected')
  assert.equal(forChildA.spy.calls, 0)

  const forMainA = nextOf('rejected')
  assert.equal(await answer(requestOf(mainA, 'bash', 'call-7'), forMainA.next), 'rejected', 'a main agent with no entry of its own is put to you')
  assert.equal(forMainA.spy.calls, 1, 'next() is called, and nothing was allowed once')

  const forB = nextOf('rejected')
  assert.equal(await answer(requestOf(b, 'bash', 'call-7'), forB.next), 'allowed-once', 'B\'s own request is covered')
  assert.equal(forB.spy.calls, 0)

  // And the other way round: A's ask is not turned into B's.
  cache.set(verdictOwner(a), 'call-7', { verdict: 'ask', escalationCovered: false })
  const again = nextOf('rejected')
  assert.equal(await answer(requestOf(b, 'bash', 'call-7'), again.next), 'allowed-once')
  assert.equal(await answer(requestOf(a, 'bash', 'call-7'), nextOf().next), 'rejected')
})

test('the owner is verdictOwner(request.agent): the id, or the session id of an agent without one', async () => {
  const bySession = { options: {}, session: { id: 'sess-9', header: { id: 'sess-9', delegationDepth: 1, origin: 'subagent' } } }
  const cache = new VerdictCache()
  cache.set('sess-9', 'call-1', COVERED)
  assert.equal(verdictOwner(bySession), 'sess-9')
  assert.equal(await approvalAnswerer(cache, sink().log)(requestOf(bySession), nextOf().next), 'allowed-once')
  // An agent that has neither is the owner '': it never meets an entry of a real agent.
  const anonymous = { options: {}, session: { header: { id: 'x', delegationDepth: 1, origin: 'subagent' } } }
  assert.equal(await approvalAnswerer(cache, sink().log)(requestOf(anonymous), nextOf().next), 'rejected')
})

// --- the lines written ---------------------------------------------------------------------------------

test('every decision writes one line for the approval purpose, with no answers, no latency and no error', async () => {
  const mainAgent = main('main-L')
  const childAgent = child('child-L')
  const cache = new VerdictCache()
  cache.set(verdictOwner(mainAgent), 'c-ask', { verdict: 'ask', escalationCovered: false })
  cache.set(verdictOwner(mainAgent), 'c-cov', COVERED)
  cache.set(verdictOwner(childAgent), 'c-cov', COVERED)
  const { log, lines } = sink()
  const answer = approvalAnswerer(cache, log, () => 1_790_000_000_000)
  await answer(requestOf(mainAgent, 'bash', 'c-ask'), nextOf().next)
  await answer(requestOf(mainAgent, 'bash', 'c-cov'), nextOf().next)
  await answer(requestOf(mainAgent, 'plugin_manager', null, 'install a plugin'), nextOf().next)
  await answer(requestOf(childAgent, 'bash', 'c-cov'), nextOf().next)
  await answer(requestOf(childAgent, 'run_code', 'c-code', 'run a program'), nextOf().next)

  assert.equal(lines.length, 5)
  for (const line of lines) {
    assert.equal(line.purpose, 'approval')
    assert.deepEqual(line.answers, {})
    assert.equal(line.latencyMs, null)
    assert.equal(line.error, null)
    assert.equal(line.at, 1_790_000_000_000)
    assert.equal(typeof line.subject, 'string')
  }
  assert.deepEqual(lines.map(line => [line.decision, line.agent, line.child, line.tool, line.callId]), [
    ['pass', 'main-L', false, 'bash', 'c-ask'],
    ['allowed-once', 'main-L', false, 'bash', 'c-cov'],
    ['pass', 'main-L', false, 'plugin_manager', undefined],
    ['allowed-once', 'child-L', true, 'bash', 'c-cov'],
    ['rejected', 'child-L', true, 'run_code', 'c-code'],
  ])
  // The subject is the tool and a short reason; fields that are not known are not there, not null.
  assert.match(lines[0]!.subject, /^bash: /)
  assert.match(lines[0]!.subject, /asked you/)
  assert.match(lines[2]!.subject, /^plugin_manager: /)
  assert.ok(!('callId' in lines[2]!))
  assert.match(lines[4]!.subject, /^run_code: /)
  assert.match(lines[4]!.subject, /never waits/)
  for (const line of lines) assert.ok(line.subject.length < 400, 'a short reason')
})

test('the subject carries what the tool said it was asking for, cut short, and an unnamed tool is named so', async () => {
  const { log, lines } = sink()
  const long = `escalate sandbox to danger-full-access: ${'x'.repeat(2000)}`
  await approvalAnswerer(new VerdictCache(), log)(requestOf(child(), 'bash', 'c1', long), nextOf().next)
  await approvalAnswerer(new VerdictCache(), log)({ agent: child() } as ApprovalAnswererRequest, nextOf().next)
  assert.match(lines[0]!.subject, /escalate sandbox to danger-full-access: x+/)
  assert.ok(lines[0]!.subject.length < 600, 'cut short')
  assert.match(lines[1]!.subject, /^an unnamed tool: /)
})

// --- childPolicy: the switch ----------------------------------------------------------------------------

/** The real approval service, mounted as dsh mounts it, and the context it is in. */
async function realApproval() {
  const ctx = new Context()
  await provideStub(ctx, 'systemPrompt', { tools() {}, section() {}, context() {}, getSectionOrder: () => 1, getContextOrder: () => 1 })
  await ctx.plugin(ApprovalService, {})
  const approval = ctx.get('approval')
  assert.ok(approval !== undefined, 'the approval service is mounted')
  return { ctx, approval }
}

/** A crew record that knows `ids`: `lookup` as dish-crew's `CrewRecords` has it. */
function crewKnowing(...ids: string[]): NonNullable<ReturnType<ChildPolicyDeps['crew']>> {
  return { records: { lookup: async (id: string) => ids.includes(id) ? { sessionId: 'parent', record: { id } } : undefined } }
}

async function policyOf(ids: string[], extra: Partial<ChildPolicyDeps> = {}) {
  const { approval } = await realApproval()
  const told: string[] = []
  const policy = childPolicy({ approval: () => approval, crew: () => crewKnowing(...ids), tell: message => { told.push(message) }, ...extra })
  const created = (agent: unknown, source = 'creation') => policy.created({ agent, source } as never)
  return { approval, policy, told, created }
}

test('a crew child whose policy is never is switched to ask, with one event, and the real service reads it back', async () => {
  const { approval, created, told } = await policyOf(['child-1'])
  const agent = child('child-1')
  assert.equal(approval.overrideOf(agent.session as never), 'never')
  await created(agent)
  assert.equal(approval.overrideOf(agent.session as never), 'ask')
  assert.deepEqual(policies(agent), ['never', 'ask'])
  assert.deepEqual(told, [])
})

test('on a resume the policy is checked first: a child that is already ask gets no new event', async () => {
  const { approval, created } = await policyOf(['child-1'])
  const agent = child('child-1')
  await created(agent)
  assert.deepEqual(policies(agent), ['never', 'ask'])
  await created(agent, 'resume')
  await created(agent, 'resume')
  assert.deepEqual(policies(agent), ['never', 'ask'], 'nothing is appended')
  assert.equal(approval.overrideOf(agent.session as never), 'ask')
})

test('a resumed child that dsh pinned to never again is switched again: the last event wins, and it is checked each time', async () => {
  const { approval, created } = await policyOf(['child-1'])
  const agent = child('child-1')
  await created(agent)
  setApprovalPolicy(agent.session as never, 'never')
  assert.equal(approval.overrideOf(agent.session as never), 'never')
  await created(agent, 'resume')
  assert.deepEqual(policies(agent), ['never', 'ask', 'never', 'ask'])
})

test('crew\'s record is only asked about a child that is at never: not for a top-level agent, a resume at ask, or a child with no override', async () => {
  const asked: string[] = []
  const { approval } = await realApproval()
  const policy = childPolicy({
    approval: () => approval,
    crew: () => ({ records: { lookup: async (id: string) => { asked.push(id); return { sessionId: 'parent', record: { id } } } } }),
  })
  const created = (agent: FakeAgent, source = 'creation') => policy.created({ agent, source } as never)
  await created(main('m1', { policy: 'never' }))
  await created(child('resumed', { policy: 'ask' }), 'resume')
  const unpinned = child('unpinned')
  unpinned.session.events.splice(0, unpinned.session.events.length)
  await created(unpinned)
  assert.deepEqual(asked, [], 'no lookup')
  await created(child('pinned'))
  assert.deepEqual(asked, ['pinned'])
})

test('a top-level agent is left alone, whatever its policy', async () => {
  const { approval, created } = await policyOf(['main-1', 'main-2', 'main-3'])
  const never = main('main-1', { policy: 'never' })
  const ask = main('main-2', { policy: 'ask' })
  const none = main('main-3')
  for (const agent of [never, ask, none]) await created(agent)
  assert.deepEqual(policies(never), ['never'])
  assert.deepEqual(policies(ask), ['ask'])
  assert.deepEqual(policies(none), [])
  assert.equal(approval.overrideOf(never.session as never), 'never')
})

test('a child that crew\'s record does not know is left alone: it stays never, and no human is involved', async () => {
  const { approval, created, told } = await policyOf(['someone-else'])
  const agent = child('child-1')
  await created(agent)
  assert.deepEqual(policies(agent), ['never'])
  assert.equal(approval.overrideOf(agent.session as never), 'never')
  assert.deepEqual(told, [], 'not being crew\'s child is no problem to report')
})

test('a child with no override at all (no pin) is left alone', async () => {
  const { created } = await policyOf(['child-1'])
  const agent = child('child-1', { policy: undefined })
  agent.session.events.splice(0, agent.session.events.length)
  await created(agent)
  assert.deepEqual(policies(agent), [])
})

test('with no crew service, no approval service, or no record of the child, nothing is switched and nothing throws', async () => {
  const agent = child('child-1')
  const { approval } = await realApproval()
  const noCrew = childPolicy({ approval: () => approval, crew: () => undefined })
  await noCrew.created({ agent, source: 'creation' } as never)
  const noApproval = childPolicy({ approval: () => undefined, crew: () => crewKnowing('child-1') })
  await noApproval.created({ agent, source: 'creation' } as never)
  assert.deepEqual(policies(agent), ['never'])
})

test('a crew record that fails to answer leaves the child at never and says so once; one that hangs is not waited for', async () => {
  const told: string[] = []
  const { approval } = await realApproval()
  const failing = childPolicy({
    approval: () => approval,
    crew: () => ({ records: { lookup: () => Promise.reject(new Error('EIO: the record is unreadable')) } }),
    tell: message => { told.push(message) },
  })
  const agent = child('child-1')
  await failing.created({ agent, source: 'creation' } as never)
  assert.deepEqual(policies(agent), ['never'])
  assert.equal(told.length, 1)
  assert.match(told[0]!, /EIO: the record is unreadable/)
  assert.match(told[0]!, /never/)

  const hung: string[] = []
  const hanging = childPolicy({
    approval: () => approval,
    crew: () => ({ records: { lookup: () => new Promise(() => {}) } }),
    tell: message => { hung.push(message) },
    lookupBudgetMs: 25,
  })
  const started = performance.now()
  await hanging.created({ agent, source: 'creation' } as never)
  assert.ok(performance.now() - started < 1000, 'the creation of an agent is not held up by the record')
  assert.deepEqual(policies(agent), ['never'])
  assert.equal(hung.length, 1)
  assert.match(hung[0]!, /25 ms/)
  assert.ok(CREW_LOOKUP_BUDGET_MS >= 100 && CREW_LOOKUP_BUDGET_MS <= 5000, 'a few seconds at the most')
})

test('a crew lookup that throws, rather than rejects, is the same as one that rejects', async () => {
  const told: string[] = []
  const { approval } = await realApproval()
  const policy = childPolicy({
    approval: () => approval,
    crew: () => ({ records: { lookup: () => { throw new Error('the record is closed') } } }),
    tell: message => { told.push(message) },
  })
  const agent = child('child-1')
  await policy.created({ agent, source: 'creation' } as never)
  assert.deepEqual(policies(agent), ['never'])
  assert.equal(told.length, 1)
})

test('a session that refuses the event does not make the creation fail: it stays never, with one warning', async () => {
  const { approval, created, told } = await policyOf(['child-1'])
  const agent = child('child-1')
  agent.session.append = (type, data) => {
    if (type === 'approval/policy') throw new Error('the log is closed')
    agent.session.events.push({ type, data })
  }
  await assert.doesNotReject(created(agent))
  assert.equal(approval.overrideOf(agent.session as never), 'never')
  assert.equal(told.length, 1)
  assert.match(told[0]!, /the log is closed/)
})

test('the listener never throws, whatever it is given', async () => {
  const { created } = await policyOf(['child-1'])
  for (const payload of [undefined, null, {}, { agent: null }, { agent: {} }, { agent: { session: null } }, { agent: { id: 7, session: 'no' } }, { agent: { id: 'x', options: {}, session: { header: { delegationDepth: 1 } } } }, 42, 'agent']) {
    await assert.doesNotReject(async () => { await childPolicy({ approval: () => ({ overrideOf: () => { throw new Error('no') } }), crew: () => undefined }).created(payload as never) })
    await assert.doesNotReject(created(payload))
  }
})

test('a creation that was cancelled is not switched', async () => {
  const { approval, policy } = await policyOf(['child-1'])
  const agent = child('child-1')
  const controller = new AbortController()
  controller.abort()
  await policy.created({ agent, source: 'creation', signal: controller.signal } as never)
  assert.equal(approval.overrideOf(agent.session as never), 'never')
})

test('the policy is read again after the crew lookup: a switch someone else made meanwhile is left alone', async () => {
  const { approval } = await realApproval()
  const agent = child('child-1')
  const policy = childPolicy({
    approval: () => approval,
    crew: () => ({
      records: {
        lookup: async () => {
          setApprovalPolicy(agent.session as never, 'ask')
          return { sessionId: 'parent', record: {} }
        },
      },
    }),
  })
  await policy.created({ agent, source: 'creation' } as never)
  assert.deepEqual(policies(agent), ['never', 'ask'], 'one ask, not two')
})

// --- childPolicy: the mitigation, restoring never ------------------------------------------------------

test('restore puts never back on the sessions this policy switched, and on no others', async () => {
  const { approval, policy, created } = await policyOf(['c1', 'c2', 'resumed'])
  const switched1 = child('c1')
  const switched2 = child('c2')
  const alreadyAsk = child('resumed', { policy: 'ask' })
  const noncrew = child('stranger')
  const topLevel = main('m1', { policy: 'ask' })
  for (const agent of [switched1, switched2, alreadyAsk, noncrew, topLevel]) await created(agent)
  policy.restore()
  assert.equal(approval.overrideOf(switched1.session as never), 'never')
  assert.equal(approval.overrideOf(switched2.session as never), 'never')
  assert.deepEqual(policies(switched1), ['never', 'ask', 'never'])
  assert.deepEqual(policies(alreadyAsk), ['ask'], 'a session this policy did not switch is not touched')
  assert.deepEqual(policies(noncrew), ['never'])
  assert.deepEqual(policies(topLevel), ['ask'])
  // Once: a second restore has nothing left to do.
  policy.restore()
  assert.deepEqual(policies(switched1), ['never', 'ask', 'never'])
})

test('restore leaves alone a session that is already not ask, and one whose agent is gone', async () => {
  const { approval, policy, created } = await policyOf(['c1', 'c2', 'c3'])
  const changed = child('c1')
  const gone = child('c2')
  const kept = child('c3')
  for (const agent of [changed, gone, kept]) await created(agent)
  setApprovalPolicy(changed.session as never, 'never')
  policy.disposed({ agent: gone } as never)
  policy.restore()
  assert.deepEqual(policies(changed), ['never', 'ask', 'never'], 'someone had put never back: no second never')
  assert.deepEqual(policies(gone), ['never', 'ask'], 'a disposed agent is not touched')
  assert.deepEqual(policies(kept), ['never', 'ask', 'never'])
  assert.equal(approval.overrideOf(kept.session as never), 'never')
})

test('restore never throws: a session that refuses the event is one warning, and the others are still restored', async () => {
  const { policy, created, told } = await policyOf(['c1', 'c2'])
  const stuck = child('c1')
  const fine = child('c2')
  await created(stuck)
  await created(fine)
  const append = stuck.session.append
  stuck.session.append = (type, data) => {
    if (type === 'approval/policy') throw new Error('the log is closed')
    append(type, data)
  }
  assert.doesNotThrow(() => { policy.restore() })
  assert.deepEqual(policies(fine), ['never', 'ask', 'never'])
  assert.equal(told.length, 1)
  assert.match(told[0]!, /the log is closed/)
})

test('disposed never throws for what is not an agent', async () => {
  const { policy } = await policyOf([])
  for (const payload of [undefined, null, {}, { agent: null }, { agent: {} }, 7]) assert.doesNotThrow(() => { policy.disposed(payload as never) })
})

// --- through the real approval service and tool registry -------------------------------------------------

const READ_ONLY = { read_only: 0.97, reversible: 0.02, irreversible: 0.01, other: 0 }
const IRREVERSIBLE = { read_only: 0.05, reversible: 0.08, irreversible: 0.87, other: 0 }

/** `JudgeResult` as the client would hand it back for these probabilities and this P(serves the task). */
function answers(probabilities: Record<string, number>, serves: number): JudgeResult {
  const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]![0]
  const effect: Answer = { type: 'choice', choice, probabilities, confidence: 0.9 }
  return { ok: true, answers: { effect, serves_task: { type: 'noul', noul: serves } }, latencyMs: 12 }
}

const DOWN: JudgeResult = { ok: false, reason: 'unavailable', message: 'TypeSafe answered HTTP 503' }

/** A fake client with the real one's contract: `decide` is called with the result, and what it says comes back as `decided`. */
function fakeJudge(script: (request: JudgeRequest<any>) => JudgeResult) {
  const requests: Array<JudgeRequest<any>> = []
  return {
    requests,
    async ask(request: JudgeRequest<any>) {
      requests.push(request)
      const result = script(request)
      if (request.decide === undefined) return result
      const decided = await request.decide(result, { signal: new AbortController().signal })
      return { ...result, decided } as JudgeResult & { decided?: Decision }
    },
    status: () => Promise.reject(new Error('not used')),
  }
}

type Result = { isError: boolean, content: Array<{ type: string, text?: string }> }
const textOf = (result: Result): string => result.content.map(block => block.type === 'text' ? block.text ?? '' : '').join('\n')

/**
 * The tools of the world: a bash that asks for an escalation the way dsh's does (`approveEscalation` in dsh-sandbox) and a
 * `plugin_manager` that asks for approval by itself, with no call the gate judged. `ran` is what they ran, `approvalOutcomes`
 * what the approval service answered them.
 */
function registerTools(ctx: Context) {
  const ran: Array<Record<string, unknown>> = []
  const approvalOutcomes: ApprovalOutcome[] = []
  ctx.tools.register(defineTool({
    name: 'bash',
    description: 'Run a command.',
    parameters: {
      command: { type: 'string', required: true },
      description: { type: 'string' },
      sandbox_permissions: { type: 'string' },
      justification: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      // What dsh's bash does with an escalation, before anything runs (dsh-sandbox's approveEscalation).
      if (args.sandbox_permissions !== undefined && args.justification !== undefined) {
        const outcome = await ctx.get('approval')!.request({
          agent: exec.agent!,
          toolName: 'bash',
          callId: exec.callId,
          reason: `escalate sandbox to ${args.sandbox_permissions}: ${args.justification}`,
          displayReason: { en: `Allow this operation with ${args.sandbox_permissions} permissions: ${args.justification}` },
          signal: exec.signal,
        })
        approvalOutcomes.push(outcome)
        if (outcome === 'rejected') throw new Error(`the user rejected escalating this command to "${args.sandbox_permissions}"; it stays denied, so stop and explain instead of working around it`)
        if (outcome !== 'allowed-once') throw new Error(`sandbox escalation to "${args.sandbox_permissions}" was not approved (${outcome})`)
      }
      ran.push({ ...args })
      return 'it ran'
    },
  }))
  // A tool that asks for approval by itself, with no call the gate judged: what plugin_manager does.
  ctx.tools.register(defineTool({
    name: 'plugin_manager',
    description: 'Manage plugins.',
    parameters: { action: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      const outcome = await ctx.get('approval')!.request({ agent: exec.agent!, toolName: 'plugin_manager', callId: exec.callId, reason: `plugin_manager ${args.action}`, signal: exec.signal })
      approvalOutcomes.push(outcome)
      if (outcome !== 'allowed-once') throw new Error(`plugin_manager was not approved (${outcome})`)
      ran.push({ ...args })
      return 'done'
    },
  }))
  return { ran, approvalOutcomes }
}

interface WorldOptions {
  script?: (request: JudgeRequest<any>) => JudgeResult
  /** Provide no judge service at all. */
  noJudge?: boolean
  /** What the human at the browser says to a request that reaches them. Without it they never answer. */
  human?: ApprovalOutcome
  /** The crew's record knows these children (by session id). */
  crew?: string[]
  /** `dishJudge` has settings and no log. */
  noLog?: boolean
}

/**
 * dish-judge's gate and answerer, mounted as a host plugin over dsh's real tool registry and real approval service, with a
 * bash that asks for an escalation the way dsh's does (`approveEscalation` in dsh-sandbox), a fake Jev, and a stand-in for
 * the browser's answerer registered first, so that it runs after the judge's prepended one. What it is asked is what a
 * human would be asked.
 */
async function world(options: WorldOptions = {}) {
  const ctx = new Context()
  await provideStub(ctx, 'systemPrompt', { tools() {}, section() {}, context() {}, getSectionOrder: () => 1, getContextOrder: () => 1 })
  await ctx.plugin(ToolRuntime, {})
  await ctx.plugin(ApprovalService, {})
  const humanSaw: Array<{ toolName: string, callId?: unknown, reason?: string }> = []
  const asked: Array<() => void> = []
  ctx.on('approval/request', (request, next) => {
    humanSaw.push({ toolName: request.toolName, ...request.callId === undefined ? {} : { callId: request.callId }, ...request.reason === undefined ? {} : { reason: request.reason } })
    if (options.human === undefined) return new Promise<ApprovalOutcome>(() => { asked.push(() => {}) })
    return Promise.resolve(options.human)
  })

  const judge = fakeJudge(options.script ?? (() => answers(READ_ONLY, 0.9)))
  if (options.noJudge !== true) await provideStub(ctx, 'judge', judge)
  const lines: JudgeLogLine[] = []
  await provideStub(ctx, 'dishJudge', { settings: async () => DEFAULT_SETTINGS, ...options.noLog === true ? {} : { log: { write: (line: JudgeLogLine) => { lines.push(line) } } } })
  const crew = options.crew ?? []
  await provideStub(ctx, 'dishCrew', crewKnowing(...crew))
  const told: string[] = []
  let cache!: VerdictCache
  const host = await ctx.plugin({
    name: 'judge-host',
    apply(own: Context) {
      cache = registerCommandGate(own)
      registerApprovalAnswerer(own, cache, message => { told.push(message) })
    },
  } as never, undefined as never)

  const { ran, approvalOutcomes } = registerTools(ctx)

  let sequence = 0
  const call = (name: string, args: unknown, who: FakeAgent, callId = `real-${++sequence}`, signal: AbortSignal = new AbortController().signal) =>
    ctx.tools.execute({ callId: callId as never, name, arguments: args, agent: who as never, signal }) as unknown as Promise<Result>
  /** The approval/asked and approval/decided events an agent's session has, as `[type, outcome | tool]`. */
  const audit = (agent: FakeAgent) => agent.session.events
    .filter(event => event.type === 'approval/asked' || event.type === 'approval/decided')
    .map(event => event.type === 'approval/asked' ? ['asked', event.data.toolName] : ['decided', event.data.outcome])
  const created = (agent: FakeAgent, source = 'creation') => ctx.serial('agent/created', { agent, source } as never)
  return { ctx, judge, cache, host, humanSaw, lines, told, ran, approvalOutcomes, call, audit, created }
}

const ESCALATE = (command: string) => ({ command, description: 'a command', sandbox_permissions: 'danger-full-access', justification: 'needs the network' })

test('through the real services: a crew child\'s escalation, which the judge allows, runs, and no human is asked', async () => {
  const w = await world({ crew: ['child-1'] })
  const agent = child('child-1')
  await w.created(agent)
  assert.equal(w.ctx.get('approval')!.overrideOf(agent.session as never), 'ask', 'the child was switched when it was created')
  const result = await w.call('bash', ESCALATE('npm test'), agent, 'c-allowed')
  assert.equal(result.isError, false)
  assert.equal(textOf(result), 'it ran')
  assert.deepEqual(w.approvalOutcomes, ['allowed-once'])
  assert.equal(w.humanSaw.length, 0, 'a child never waits on a human')
  assert.deepEqual(w.audit(agent), [['asked', 'bash'], ['decided', 'allowed-once']], 'dsh logged the pair on the child\'s session')
  const line = w.lines.find(candidate => candidate.purpose === 'approval')
  assert.ok(line !== undefined, 'a line for the approval')
  assert.deepEqual([line.decision, line.child, line.tool, line.callId, line.agent], ['allowed-once', true, 'bash', 'c-allowed', 'child-1'])
  assert.equal(w.cache.size, 0, 'the verdict was forgotten when the call settled')
})

test('through the real services: the same call, which the judge denies, is refused by the gate, and no human is asked', async () => {
  const w = await world({ crew: ['child-1'], script: () => answers(IRREVERSIBLE, 0.9) })
  const agent = child('child-1')
  await w.created(agent)
  const result = await w.call('bash', ESCALATE('git push --force'), agent, 'c-denied')
  assert.equal(result.isError, true)
  assert.match(textOf(result), /The judge didn't let this run: it reads as irreversible/)
  assert.match(textOf(result), /Report it to the main agent/)
  assert.equal(w.ran.length, 0)
  assert.equal(w.humanSaw.length, 0)
  assert.deepEqual(w.audit(agent), [], 'the child never asked: the gate refused first')
  assert.equal(w.approvalOutcomes.length, 0)
})

test('through the real services: with the judge unavailable, or no judge service, a child is refused and no human is asked', async () => {
  for (const options of [{ script: () => DOWN }, { noJudge: true }] satisfies WorldOptions[]) {
    const w = await world({ crew: ['child-1'], ...options })
    const agent = child('child-1')
    await w.created(agent)
    const result = await w.call('bash', ESCALATE('ls'), agent, 'c-down')
    assert.equal(result.isError, true)
    assert.match(textOf(result), /the judge is unavailable; nothing ran/)
    assert.equal(w.ran.length, 0)
    assert.equal(w.humanSaw.length, 0)
  }
})

test('through the real services: a request a child makes that the gate did not judge is rejected, and the human is not asked', async () => {
  const w = await world({ crew: ['child-1'] })
  const agent = child('child-1')
  await w.created(agent)
  const result = await w.call('plugin_manager', { action: 'install' }, agent, 'c-pm')
  assert.equal(result.isError, true)
  assert.deepEqual(w.approvalOutcomes, ['rejected'])
  assert.equal(w.humanSaw.length, 0)
  assert.deepEqual(w.audit(agent), [['asked', 'plugin_manager'], ['decided', 'rejected']])
  assert.equal(w.lines.filter(line => line.purpose === 'approval' && line.decision === 'rejected').length, 1)
})

test('through the real services: a child that was not switched (policy never) is rejected by dsh before any listener, so the judge hears nothing', async () => {
  const w = await world({ crew: [] })
  const agent = child('child-1')
  await w.created(agent)
  assert.equal(w.ctx.get('approval')!.overrideOf(agent.session as never), 'never', 'not crew\'s child: not switched')
  const result = await w.call('bash', ESCALATE('npm test'), agent, 'c-never')
  assert.equal(result.isError, true)
  assert.deepEqual(w.approvalOutcomes, ['rejected'])
  assert.equal(w.humanSaw.length, 0)
  assert.equal(w.lines.filter(line => line.purpose === 'approval').length, 0, 'no listener ran: the policy answered')
})

test('through the real services: the main agent\'s covered escalation runs with no human', async () => {
  const w = await world()
  const agent = main('main-1')
  const result = await w.call('bash', ESCALATE('npm test'), agent, 'm-covered')
  assert.equal(result.isError, false)
  assert.deepEqual(w.approvalOutcomes, ['allowed-once'])
  assert.equal(w.humanSaw.length, 0)
  assert.equal(w.lines.find(line => line.purpose === 'approval')?.decision, 'allowed-once')
})

test('through the real services: the gate\'s own ask for the main agent reaches you, and your answer decides', async () => {
  for (const [human, runs] of [['allowed-once', 1], ['rejected', 0]] as const) {
    const w = await world({ script: () => answers(IRREVERSIBLE, 0.9), human })
    const agent = main('main-1')
    const result = await w.call('bash', { command: 'git push', description: 'push' }, agent, 'm-ask')
    assert.equal(w.humanSaw.length, 1, human)
    assert.equal(w.humanSaw[0]!.toolName, 'bash')
    assert.match(w.humanSaw[0]!.reason ?? '', /The judge reads this as irreversible/)
    assert.equal(w.ran.length, runs, human)
    assert.equal(result.isError, runs === 0, human)
    assert.equal(w.lines.find(line => line.purpose === 'approval')?.decision, 'pass')
  }
})

test('through the real services: an escalation the judge would not allow alone is put to you, not approved', async () => {
  const w = await world({ script: () => answers(IRREVERSIBLE, 0.9), human: 'allowed-once' })
  const result = await w.call('bash', ESCALATE('git push --force'), main('main-1'), 'm-esc')
  assert.equal(result.isError, false)
  // The gate's ask, and then the escalation: both go to you. The cache says ask, so the judge approves neither.
  assert.equal(w.humanSaw.length, 2)
  assert.deepEqual(w.lines.filter(line => line.purpose === 'approval').map(line => line.decision), ['pass', 'pass'])
})

test('through the real services: a request the main agent makes that the gate did not judge reaches you; a child\'s does not', async () => {
  const w = await world({ human: 'rejected' })
  const result = await w.call('plugin_manager', { action: 'install' }, main('main-1'), 'm-pm')
  assert.equal(result.isError, true)
  assert.equal(w.humanSaw.length, 1)
  assert.equal(w.humanSaw[0]!.toolName, 'plugin_manager')
  assert.equal(w.lines.find(line => line.purpose === 'approval')?.decision, 'pass')
})

test('through the real services: a collision of call ids across two agents does not let one\'s allow approve the other\'s request', async () => {
  const w = await world({ crew: ['child-A', 'child-B'], script: request => (request.agent as FakeAgent).id === 'child-B' ? answers(READ_ONLY, 0.95) : answers(IRREVERSIBLE, 0.9) })
  const a = child('child-A')
  const b = child('child-B')
  await w.created(a)
  await w.created(b)
  // B's call is allowed with its escalation and is covered, under call id 'same'. A's call with the same id is denied by the gate.
  const [first, second] = await Promise.all([w.call('bash', ESCALATE('ls'), b, 'same'), w.call('bash', ESCALATE('git push'), a, 'same')])
  assert.equal(first.isError, false)
  assert.equal(second.isError, true)
  assert.equal(w.ran.length, 1)
  assert.deepEqual(w.ran[0]!.command, 'ls')
  assert.equal(w.humanSaw.length, 0)
})

// --- through the real services: the policy switch and its mitigation -----------------------------------

test('through the real services: a crew child is switched when created, and a resume appends nothing', async () => {
  const w = await world({ crew: ['child-1'] })
  const agent = child('child-1')
  await w.created(agent)
  await w.created(agent, 'resume')
  assert.deepEqual(policies(agent), ['never', 'ask'])
  const top = main('main-1', { policy: 'never' })
  await w.created(top)
  assert.deepEqual(policies(top), ['never'])
})

test('through the real services: when dish-judge goes, the children it switched are back at never, and a request is rejected, not put to a human', async () => {
  const w = await world({ crew: ['child-1'] })
  const agent = child('child-1')
  await w.created(agent)
  assert.equal(w.ctx.get('approval')!.overrideOf(agent.session as never), 'ask')
  await w.host.dispose()
  assert.equal(w.ctx.get('approval')!.overrideOf(agent.session as never), 'never')
  assert.deepEqual(policies(agent), ['never', 'ask', 'never'])
  // dish-judge is gone, so the gate is too: the escalation goes to the approval service, which rejects it by policy.
  const result = await w.call('bash', ESCALATE('npm test'), agent, 'c-after')
  assert.equal(result.isError, true)
  assert.deepEqual(w.approvalOutcomes, ['rejected'])
  assert.equal(w.humanSaw.length, 0, 'the human is not asked: that is the point of putting never back')
})

test('what the mitigation is for: with the policy left at ask and no answerer, dsh puts a child\'s request to the browser\'s answerer, which has no time limit', async () => {
  const w = await world({ crew: ['child-1'] })
  const agent = child('child-1')
  await w.created(agent)
  // Unload the judge without the mitigation: the answerer goes, and the policy stays ask. A session this plugin did not switch
  // is left as it is (it is not the plugin's), which is the state a crashed process leaves behind.
  const approval = w.ctx.get('approval')!
  const second = child('child-2', { policy: 'never' })
  setApprovalPolicy(second.session as never, 'ask')
  await w.host.dispose()
  assert.equal(approval.overrideOf(second.session as never), 'ask', 'a session the plugin did not switch is left as it is')
  assert.equal(approval.overrideOf(agent.session as never), 'never', 'the one it switched is back at never')
  const controller = new AbortController()
  let settled: ApprovalOutcome | undefined
  const pending = approval.request({ agent: second as never, toolName: 'bash', callId: 'c-hang' as never, reason: 'escalate sandbox to danger-full-access: x', signal: controller.signal })
    .then((outcome) => { settled = outcome; return outcome })
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(w.humanSaw.length, 1, 'it reached the human\'s answerer')
  assert.equal(settled, undefined, 'and nothing times it out: it is still waiting')
  controller.abort()
  assert.equal(await pending, 'cancelled', 'only the request\'s own signal ends it')
})

test('through the real services: with no decision log, or a log that throws, a child is still rejected and the main agent still asked', async () => {
  for (const noLog of [true, false]) {
    const w = await world({ crew: ['child-1'], noLog, human: 'rejected' })
    if (!noLog) w.ctx.get('dishJudge')!.log.write = () => { throw new Error('disk full') }
    const agent = child('child-1')
    await w.created(agent)
    assert.equal((await w.call('plugin_manager', { action: 'install' }, agent, 'c-nolog')).isError, true)
    assert.equal(w.humanSaw.length, 0, 'a child is never put to the human')
    assert.equal((await w.call('plugin_manager', { action: 'install' }, main('main-1'), 'm-nolog')).isError, true)
    assert.equal(w.humanSaw.length, 1, 'the main agent is')
  }
})

// --- the plugin as a whole: its own client, log, gate and answerer -------------------------------------------

const KEY = 'tsk-live-0123456789abcdef-test-key'

function jevSays(probabilities: Record<string, number>, serves: number) {
  const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]![0]
  return { kind: 'answer' as const, body: jevBody({ effect: choiceAnswer(choice, probabilities), serves_task: noulAnswer(serves) }) }
}

/** dish-judge mounted whole, over a real tool registry and approval service, a fake Jev, a crew record and a stand-in browser. */
async function plugged(t: { after(fn: () => unknown): void }, crew: string[]) {
  const jev = await startFakeJev()
  const where = await dirs()
  const ctx = new Context()
  await provideStub(ctx, 'systemPrompt', { tools() {}, section() {}, context() {}, getSectionOrder: () => 1, getContextOrder: () => 1 })
  await provideStub(ctx, 'credentials', { resolve: async () => ({ value: KEY }) })
  await provideStub(ctx, 'dishCrew', crewKnowing(...crew))
  await ctx.plugin(ToolRuntime, {})
  await ctx.plugin(ApprovalService, {})
  const humanSaw: string[] = []
  ctx.on('approval/request', (request) => {
    humanSaw.push(request.toolName)
    return new Promise<ApprovalOutcome>(() => {})
  })
  const handle = mountJudge(ctx, where.state, { baseUrl: jev.url })
  t.after(async () => { await handle.dispose() })
  await handle
  const { ran, approvalOutcomes } = registerTools(ctx)
  let sequence = 0
  const call = (name: string, args: unknown, who: FakeAgent, callId = `plug-${++sequence}`) =>
    ctx.tools.execute({ callId: callId as never, name, arguments: args, agent: who as never, signal: new AbortController().signal }) as unknown as Promise<Result>
  const written = async () => { await ctx.dishJudge.log.flush(); return (await ctx.dishJudge.log.read()).lines.reverse() }
  return { ctx, jev, handle, humanSaw, ran, approvalOutcomes, call, written }
}

test('the dish-judge plugin mounted whole: it switches a crew child, judges its escalation, answers it, logs both, and gives never back when it goes', async (t) => {
  const p = await plugged(t, ['child-1'])
  const agent = child('child-1')
  await p.ctx.serial('agent/created', { agent, source: 'creation' } as never)
  assert.deepEqual(policies(agent), ['never', 'ask'])
  p.jev.queue(jevSays(READ_ONLY, 0.95))
  const result = await p.call('bash', ESCALATE('npm test'), agent, 'plug-esc')
  assert.equal(textOf(result), 'it ran')
  assert.deepEqual(p.approvalOutcomes, ['allowed-once'])
  assert.deepEqual(p.humanSaw, [], 'no human')
  assert.equal(p.jev.requests.length, 1, 'one Jev call: the gate\'s; the answerer asks nothing')
  assert.match(p.jev.requests[0]!.json.state.escalation, /danger-full-access/)
  const lines = await p.written()
  assert.deepEqual(lines.map(line => [line.purpose, line.decision, line.callId, line.child]), [
    ['command', 'allow', 'plug-esc', true],
    ['approval', 'allowed-once', 'plug-esc', true],
  ])
  assert.deepEqual(lines[1]!.answers, {})
  assert.equal(lines[1]!.latencyMs, null)
  assert.ok(!JSON.stringify(lines).includes(KEY))

  // A request nobody judged: refused for the child, and the line says so.
  assert.equal((await p.call('plugin_manager', { action: 'remove' }, agent, 'plug-pm')).isError, true)
  assert.deepEqual(p.humanSaw, [])
  assert.deepEqual((await p.written()).slice(2).map(line => [line.purpose, line.decision, line.tool]), [['approval', 'rejected', 'plugin_manager']])

  // The main agent's goes to the human.
  const mainAgent = main('main-1')
  void p.call('plugin_manager', { action: 'remove' }, mainAgent, 'plug-pm-main')
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.deepEqual(p.humanSaw, ['plugin_manager'])

  await p.handle.dispose()
  assert.deepEqual(policies(agent), ['never', 'ask', 'never'], 'unloading the plugin gives the child its never back')
  assert.equal(p.ctx.get('approval')!.overrideOf(agent.session as never), 'never')
})

test('the dish-judge plugin mounted whole leaves a child that crew does not know, and the main agent, as dsh made them', async (t) => {
  const p = await plugged(t, [])
  const stranger = child('stranger')
  const top = main('main-1', { policy: 'never' })
  await p.ctx.serial('agent/created', { agent: stranger, source: 'creation' } as never)
  await p.ctx.serial('agent/created', { agent: top, source: 'creation' } as never)
  assert.deepEqual(policies(stranger), ['never'])
  assert.deepEqual(policies(top), ['never'])
  await p.handle.dispose()
  assert.deepEqual(policies(stranger), ['never'])
  assert.deepEqual(policies(top), ['never'])
})
