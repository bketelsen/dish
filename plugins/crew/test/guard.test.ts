import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { CrewRecords } from '../src/record.ts'
import type { DishCrew } from '../src/index.ts'
import { approvalGuard, GUARD_LOOKUP_BUDGET_MS } from '../src/guard.ts'
import { dirs, mountCrew, watchLogs } from './helpers.ts'

// --- what the tests are made of -----------------------------------------------------------------------

/** Provide `value` as the service `name` from a plugin of its own, a sibling of whatever is mounted next, as dsh's services are. Dispose the handle to take it away. */
function provideStub(ctx: Context, name: string, value: unknown, extra?: (own: Context) => void) {
  return ctx.plugin({
    name: `stub-${name}`,
    apply(own: Context) {
      (own as unknown as { provide(name: string, value: unknown): void }).provide(name, value)
      extra?.(own)
    },
  } as never, undefined as never)
}

/** A session as far as dsh's approval service reads one: a log with `seq`, `eventAt` and `append`. */
interface FakeEvent { type: string, data: Record<string, unknown> }
function sessionOf(id: string, header: Record<string, unknown>, events: FakeEvent[]) {
  const log = events.map(event => ({ ...event }))
  return {
    id,
    header: { id, cwd: '/w', ...header },
    inheritedEventCount: 0,
    events: log,
    get seq() { return log.length },
    eventAt: (seq: number) => log[seq],
    append(type: string, data: Record<string, unknown>) { log.push({ type, data }) },
    snapshotEvents: (from = 0) => log.slice(from),
  }
}

const ASK: FakeEvent = { type: 'approval/policy', data: { policy: 'ask' } }
const NEVER: FakeEvent = { type: 'approval/policy', data: { policy: 'never', source: 'delegation' } }
const TURN: FakeEvent = { type: 'turn/start', data: { turn: 1 } }

/** A crew child, as dsh makes one, with the events its log holds (a dsh-judge switch leaves `ASK`). */
function childOf(id: string, ...events: FakeEvent[]) {
  return { id, options: {}, session: sessionOf(id, { delegationDepth: 1, origin: 'subagent', parentSession: 'main-1' }, [...events, TURN]) }
}

/** The main agent. */
function mainOf(id = 'main-1') {
  return { id, options: {}, session: sessionOf(id, {}, [TURN]) }
}

/** `next()` that says what it is told to, and counts. */
function nextOf(outcome: ApprovalOutcome = 'allowed-once') {
  const spy = { calls: 0 }
  return { spy, next: (): Promise<ApprovalOutcome> => { spy.calls += 1; return Promise.resolve(outcome) } }
}

// --- the guard on its own ----------------------------------------------------------------------------

test('with dish-judge loaded, the guard steps aside for everyone: next()', async () => {
  const guard = approvalGuard({ judgeIsLoaded: () => true, isCrewChild: async () => true })
  for (const agent of [childOf('child-1', NEVER, ASK), mainOf(), undefined, { id: 'x' }]) {
    const { spy, next } = nextOf('allowed-once')
    assert.equal(await guard({ agent }, next), 'allowed-once')
    assert.equal(spy.calls, 1)
  }
})

test('without dish-judge, a crew child is rejected and next() is not called; a main agent, a child crew did not start, and what is not an agent go to next()', async () => {
  const asked: string[] = []
  const guard = approvalGuard({ judgeIsLoaded: () => false, isCrewChild: async (id) => { asked.push(id); return id.startsWith('crew-') } })
  const crew = nextOf('allowed-once')
  assert.equal(await guard({ agent: childOf('crew-1', NEVER, ASK) }, crew.next), 'rejected')
  assert.equal(crew.spy.calls, 0, 'a crew child is never put to a human')
  assert.deepEqual(asked, ['crew-1'])

  for (const agent of [childOf('stranger', NEVER, ASK), mainOf('crew-main'), undefined, {}, { id: '' }, { id: 7 }, null]) {
    const { spy, next } = nextOf('unavailable')
    assert.equal(await guard({ agent }, next), 'unavailable')
    assert.equal(spy.calls, 1)
  }
  assert.deepEqual(asked, ['crew-1', 'stranger'], 'the record is asked about children only, by id')
  const { spy, next } = nextOf('unavailable')
  assert.equal(await guard(undefined as never, next), 'unavailable')
  assert.equal(await guard(null as never, next), 'unavailable')
  assert.equal(spy.calls, 2)
})

test('without dish-judge, a record that fails or hangs rejects the child, and says so once: a child that can not be told from crew\'s is not put to a human either', async () => {
  const told: string[] = []
  const failing = approvalGuard({ judgeIsLoaded: () => false, isCrewChild: () => Promise.reject(new Error('EIO: unreadable')), tell: (message) => { told.push(message) } })
  const { spy, next } = nextOf('allowed-once')
  assert.equal(await failing({ agent: childOf('child-1', NEVER, ASK) }, next), 'rejected')
  assert.equal(spy.calls, 0)
  assert.equal(told.length, 1)
  assert.match(told[0]!, /EIO: unreadable/)

  const throwing = approvalGuard({ judgeIsLoaded: () => false, isCrewChild: () => { throw new Error('the record is closed') } })
  assert.equal(await throwing({ agent: childOf('child-1', NEVER, ASK) }, next), 'rejected')

  const hangingTold: string[] = []
  const hanging = approvalGuard({ judgeIsLoaded: () => false, isCrewChild: () => new Promise(() => {}), budgetMs: 25, tell: (message) => { hangingTold.push(message) } })
  const started = performance.now()
  assert.equal(await hanging({ agent: childOf('child-1', NEVER, ASK) }, next), 'rejected')
  assert.ok(performance.now() - started < 1000)
  assert.match(hangingTold[0]!, /25 ms/)
  assert.equal(spy.calls, 0)
  assert.ok(GUARD_LOOKUP_BUDGET_MS >= 100 && GUARD_LOOKUP_BUDGET_MS <= 5000, 'a few seconds at the most')
})

test('a service lookup that throws is dish-judge not being there, and the guard never throws for what it is given', async () => {
  const guard = approvalGuard({ judgeIsLoaded: () => { throw new Error('no such service') }, isCrewChild: async () => true })
  const { spy, next } = nextOf('allowed-once')
  assert.equal(await guard({ agent: childOf('child-1', NEVER, ASK) }, next), 'rejected')
  assert.equal(spy.calls, 0)
  const unreadable = { id: 'child-2', options: {}, get session(): never { throw new Error('the session is gone') } }
  assert.equal(await guard({ agent: unreadable }, next), 'rejected', 'an agent that can not be read is looked up like any child')
  assert.equal(spy.calls, 0)
})

// --- through the plugin, the real approval service, and dish-judge coming and going ----------------------

/** What a browser would be asked: every request that reaches it, and a way to wait for the next. */
function stand(ctx: Context) {
  const saw: string[] = []
  const waiting: Array<() => void> = []
  ctx.on('approval/request', (request) => {
    saw.push(request.toolName)
    for (const wake of waiting.splice(0)) wake()
    return new Promise<ApprovalOutcome>(() => {})
  })
  return {
    saw,
    asked: (count = 1) => new Promise<void>((resolve) => {
      const check = (): void => { if (saw.length >= count) resolve(); else waiting.push(check) }
      check()
    }),
  }
}

async function mounted(t: { after(fn: () => unknown): void }) {
  const where = await dirs()
  const ctx = new Context()
  await provideStub(ctx, 'systemPrompt', { tools() {}, section() {}, context() {}, getSectionOrder: () => 1, getContextOrder: () => 1 })
  await ctx.plugin(ApprovalService, {})
  return { ctx, where, browser: stand(ctx), mountCrew: async () => {
    const handle = mountCrew(ctx, where.data)
    t.after(async () => { await handle.dispose() })
    await handle
    const crew = ctx.get('dishCrew') as DishCrew
    // The record knows this crew child, as delegate writes it before it starts one.
    await crew.records.addChild('main-1', { id: 'crew-child', role: 'coder', title: 'add login', model: 'claude-sonnet-5.5', family: 'anthropic' })
    return { handle, crew }
  } }
}

/** A stand-in for dish-judge: the `dishJudge` service and an answerer, prepended, that decides every request as `says`. */
function judgeStub(ctx: Context, says: ApprovalOutcome, decided: string[]) {
  return provideStub(ctx, 'dishJudge', { log: { write() {} } }, (own) => {
    own.on('approval/request', (request) => {
      decided.push(request.toolName)
      return Promise.resolve(says)
    }, { prepend: true })
  })
}

/** Start an approval request for an escalation. `abort()` withdraws it (the outcome is then `cancelled`), as a cancelled call does. */
function begin(ctx: Context, agent: unknown, toolName = 'bash') {
  const controller = new AbortController()
  const pending = ctx.get('approval')!.request({ agent: agent as never, toolName, callId: 'c1' as never, reason: 'escalate sandbox to danger-full-access: net', signal: controller.signal })
  return { pending, abort: () => { controller.abort() } }
}

/** Ask the approval service for an escalation, and give what it says. A request nobody answers is ended after 5 s, so a broken test fails and does not hang. */
async function ask(ctx: Context, agent: unknown, toolName = 'bash') {
  const started = begin(ctx, agent, toolName)
  const timer = setTimeout(started.abort, 5000)
  try {
    return await started.pending
  } finally {
    clearTimeout(timer)
  }
}

test('the plugin guards its children: with no dish-judge a crew child at ask is rejected and the browser is never asked; a child crew did not start, and the main agent, are', async (t) => {
  const w = await mounted(t)
  await w.mountCrew()
  assert.equal(await ask(w.ctx, childOf('crew-child', NEVER, ASK)), 'rejected')
  assert.equal(w.browser.saw.length, 0, 'a crew child never waits on a human')

  const stranger = begin(w.ctx, childOf('stranger', NEVER, ASK))
  await w.browser.asked(1)
  stranger.abort()
  assert.equal(await stranger.pending, 'cancelled', 'a child crew did not start is the browser\'s, as dsh has it')
  const top = begin(w.ctx, mainOf())
  await w.browser.asked(2)
  top.abort()
  assert.equal(await top.pending, 'cancelled', 'and so is the main agent')
  assert.equal(w.browser.saw.length, 2)
})

for (const judgeFirst of [true, false]) {
  test(`dish-judge loaded ${judgeFirst ? 'before' : 'after'} crew: with it, it decides; without it, a settled child resumed at ask is rejected, and no human is asked`, async (t) => {
    const w = await mounted(t)
    const decided: string[] = []
    let judge: { dispose(): Promise<void> | void } | undefined
    if (judgeFirst) judge = await judgeStub(w.ctx, 'allowed-once', decided)
    await w.mountCrew()
    if (!judgeFirst) judge = await judgeStub(w.ctx, 'allowed-once', decided)

    // A child that settled under dish-judge, which switched it to ask, and a follow-up resumes it from its log.
    const resumed = childOf('crew-child', NEVER, ASK)
    assert.equal(await ask(w.ctx, resumed), 'allowed-once', 'dish-judge decides: the guard stood aside')
    assert.deepEqual(decided, ['bash'])
    assert.equal(w.browser.saw.length, 0)

    // dish-judge goes (disabled, uninstalled, unloaded, or a restart without it).
    await judge!.dispose()
    assert.equal(await ask(w.ctx, resumed), 'rejected', 'the guard refuses it')
    assert.equal(w.browser.saw.length, 0, 'the settled child does not wait on a human')
    assert.deepEqual(decided, ['bash'], 'dish-judge decided nothing more')

    // And when it is back, it decides again.
    await judgeStub(w.ctx, 'rejected', decided)
    assert.equal(await ask(w.ctx, resumed), 'rejected')
    assert.deepEqual(decided, ['bash', 'bash'])
    assert.equal(w.browser.saw.length, 0)
  })
}

test('the guard goes with the plugin: once dish-crew is unloaded, a child\'s request reaches the browser as dsh has it', async (t) => {
  const w = await mounted(t)
  const { handle } = await w.mountCrew()
  assert.equal(await ask(w.ctx, childOf('crew-child', NEVER, ASK)), 'rejected')
  await handle.dispose()
  const after = begin(w.ctx, childOf('crew-child', NEVER, ASK))
  await w.browser.asked(1)
  after.abort()
  assert.equal(await after.pending, 'cancelled')
})

test('the guard is registered before the plugin awaits anything: a crew child is refused while the plugin is still pruning, before dishCrew is provided', async (t) => {
  const w = await mounted(t)
  // The record is on disk already, as it is after a restart: the plugin is still loading when the request comes.
  const records = new CrewRecords(w.where.data)
  await records.addChild('main-1', { id: 'crew-child', role: 'coder', title: 'add login', model: 'claude-sonnet-5.5', family: 'anthropic' })
  await records.flush()
  const loading = mountCrew(w.ctx, w.where.data)
  t.after(async () => { await loading.dispose() })
  assert.equal(w.ctx.get('dishCrew'), undefined, 'not provided yet: apply has not finished')
  assert.equal(await ask(w.ctx, childOf('crew-child', NEVER, ASK)), 'rejected')
  assert.equal(w.browser.saw.length, 0)
  await loading
})

test('a lookup failure is a warning of the plugin, once, and the child is still refused', async (t) => {
  const w = await mounted(t)
  const logs = watchLogs(w.ctx)
  const { crew } = await w.mountCrew()
  ;(crew.records as unknown as { lookup: () => Promise<never> }).lookup = () => Promise.reject(new Error('EIO: the record is unreadable'))
  assert.equal(await ask(w.ctx, childOf('crew-child', NEVER, ASK)), 'rejected')
  assert.equal(await ask(w.ctx, childOf('crew-child', NEVER, ASK)), 'rejected')
  assert.equal(logs.filter(line => line.includes('EIO: the record is unreadable')).length, 1)
  assert.equal(w.browser.saw.length, 0)
})
