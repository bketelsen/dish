import { format } from 'node:util'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { EVENT_BUDGET_MS, publisher } from '../src/events.ts'
import type { CrewDelegated, CrewSettled } from '../src/events.ts'
import type { ChildRecord, RunRecord } from '../src/record.ts'

function child(overrides: Partial<ChildRecord> = {}): ChildRecord {
  return {
    id: 'c1', n: 1, role: 'coder', title: 'add login', model: 'claude-sonnet-5.5', family: 'anthropic', startedAt: 1, followUps: 0,
    runs: [], last: 'running', ...overrides,
  }
}

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return { endedAt: 2, stopReason: 'completed', report: '/r/1-coder-1.md', ...overrides }
}

/** A publisher on `ctx` whose warnings land in the list it gives. */
function publishing(ctx: Context, budgetMs?: number) {
  const warnings: string[] = []
  const publish = publisher(ctx, (text, ...args) => { warnings.push(format(text, ...args)) }, budgetMs)
  return { publish, warnings }
}

const INACTIVE = (): Error => Object.assign(new Error('cannot create effect on inactive context'), { code: 'INACTIVE_EFFECT' })

test('the budget is 10 s', () => {
  assert.equal(EVENT_BUDGET_MS, 10_000)
})

test('publisher waits for async listeners, which get a copy of the event', async () => {
  const ctx = new Context()
  const { publish, warnings } = publishing(ctx)
  const heard: CrewDelegated[] = []
  ctx.on('dish-crew/delegated', async (event) => {
    await new Promise(resolve => setTimeout(resolve, 20))
    heard.push(event)
    event.child.title = 'changed by a listener'
  })
  const event: CrewDelegated = { sessionId: 's1', child: child(), followUp: false }
  await publish('dish-crew/delegated', event)
  assert.equal(heard.length, 1)
  assert.equal(heard[0]!.sessionId, 's1')
  assert.equal(heard[0]!.followUp, false)
  assert.notEqual(heard[0], event)
  assert.equal(event.child.title, 'add login', 'the caller\'s object is not the listener\'s')
  assert.deepEqual(warnings, [])
})

test('a failing listener is logged once for each cause, and the other listeners still run', async () => {
  const ctx = new Context()
  const { publish, warnings } = publishing(ctx)
  const heard: CrewSettled[] = []
  ctx.on('dish-crew/settled', () => { throw new Error('boom') })
  ctx.on('dish-crew/settled', async (event) => { heard.push(event) })
  ctx.on('dish-crew/settled', async () => { throw new Error('bang') })
  await publish('dish-crew/settled', { sessionId: 's1', child: child(), run: run() })
  assert.equal(heard.length, 1)
  assert.deepEqual(heard[0]!.run, run())
  assert.deepEqual(warnings, ['a dish-crew/settled listener failed: boom', 'a dish-crew/settled listener failed: bang'])
})

test('a listener held past the budget: the publish resolves after the budget, with a warning', async () => {
  const ctx = new Context()
  const { publish, warnings } = publishing(ctx, 50)
  ctx.on('dish-crew/settled', () => new Promise(() => {}))
  const started = Date.now()
  await publish('dish-crew/settled', { sessionId: 's1', child: child(), run: run() })
  assert.ok(Date.now() - started >= 45, String(Date.now() - started))
  assert.deepEqual(warnings, ['dish-crew/settled listeners took longer than 0.05 s; crew went on without them'])
})

test('a plugin that is going away is silent: a disposed context, and INACTIVE_EFFECT thrown or rejected', async () => {
  const ctx = new Context()
  let inner!: Context
  const fiber = ctx.plugin({ name: 'gone', apply(own: Context) { inner = own } } as never, undefined as never)
  await fiber
  await fiber.dispose()
  const gone = publishing(inner)
  await gone.publish('dish-crew/delegated', { sessionId: 's1', child: child(), followUp: false })
  assert.deepEqual(gone.warnings, [])

  // A listener whose own plugin is going away.
  const live = new Context()
  live.on('dish-crew/delegated', () => { throw INACTIVE() })
  live.on('dish-crew/delegated', async () => { throw INACTIVE() })
  const quiet = publishing(live)
  await quiet.publish('dish-crew/delegated', { sessionId: 's1', child: child(), followUp: true })
  assert.deepEqual(quiet.warnings, [])

  // cordis refusing the dispatch itself.
  const refusing = { parallel() { throw INACTIVE() } } as unknown as Context
  const refused = publishing(refusing)
  await refused.publish('dish-crew/settled', { sessionId: 's1', child: child(), run: run() })
  assert.deepEqual(refused.warnings, [])
  const rejecting = { parallel: () => Promise.reject(INACTIVE()) } as unknown as Context
  const rejected = publishing(rejecting)
  await rejected.publish('dish-crew/settled', { sessionId: 's1', child: child(), run: run() })
  assert.deepEqual(rejected.warnings, [])
})

test('a dispatch that fails some other way is logged, and the publish still resolves', async () => {
  const broken = { parallel() { throw new Error('no events here') } } as unknown as Context
  const { publish, warnings } = publishing(broken)
  await publish('dish-crew/delegated', { sessionId: 's1', child: child(), followUp: false })
  assert.deepEqual(warnings, ['a dish-crew/delegated listener failed: no events here'])
})

test('with no listeners, the publish resolves', async () => {
  const ctx = new Context()
  const { publish, warnings } = publishing(ctx)
  await publish('dish-crew/settled', { sessionId: 's1', child: child(), run: run() })
  await publish('dish-crew/delegated', { sessionId: 's1', child: child(), followUp: false })
  assert.deepEqual(warnings, [])
})

test('a listener\'s error is masked in the log', async () => {
  const ctx = new Context()
  const { publish, warnings } = publishing(ctx)
  const token = `ghp_${'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'}`
  ctx.on('dish-crew/settled', () => { throw new Error(`could not use ${token}`) })
  await publish('dish-crew/settled', { sessionId: 's1', child: child(), run: run() })
  assert.equal(warnings.length, 1)
  assert.ok(!warnings[0]!.includes(token), warnings[0])
})
