import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { format } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import * as row from '../src/delegate.ts'
import type { DishCrew } from '../src/index.ts'
import { noticeText, rewriteNotices } from '../src/notice.ts'
import { CrewRecords } from '../src/record.ts'
import type { ChildRecord, EndedRun, NewChild } from '../src/record.ts'
import { DEFAULT_SETTINGS } from '../src/settings.ts'
import { provideStub, tempDir, watchLogs } from './helpers.ts'

const SESSION = 'session-main'
const WHO = 'coder «add login» (claude-sonnet-5.5)'

const disposables: Array<{ dispose(): Promise<void> | void }> = []
after(async () => {
  await Promise.all(disposables.splice(0).map(handle => handle.dispose()))
})

// --- messages, as dsh builds them -----------------------------------------------------------------

/**
 * dsh's opening line for a child that settled: `settlementSummary` in
 * `@deepseek-ai/dsh-subagent/lib/types/continuation-messages.js`, copied here because the package doesn't export it.
 */
function summaryFor(childId: string, stopReason: string): string {
  const subject = `Background subagent ${childId}`
  switch (stopReason) {
    case 'completed': return `${subject} finished and will do no further work unless you send it more.`
    case 'aborted': return `${subject} was stopped before it finished.`
    case 'max-tokens': return `${subject} ran out of room before it finished.`
    case 'refusal': return `${subject} declined the task.`
    case 'error': return `${subject} failed before it finished.`
    default: return `${subject} ended abnormally (${stopReason}) before it finished.`
  }
}

/**
 * The settlement notice dsh delivers to a parent: `createSettlementMessage` in the same file, copied for the same reason
 * (a scratch comparison against the real function gave the same shape, content and source). The closing blocks follow
 * the label, and a child with none gets `It left no closing message.` in its place.
 */
function settlement(childId: string, stopReason: string, closing: string[] = []): UserMessage {
  const summary = summaryFor(childId, stopReason)
  const blocks: ContentBlock[] = closing.map(text => ({ type: 'text', text }))
  return createUserMessage({
    content: [
      { type: 'text', text: summary },
      ...blocks.length === 0
        ? [{ type: 'text', text: 'It left no closing message.' } as const]
        : [{ type: 'text', text: 'Its closing message:' } as const, ...blocks],
    ],
    source: { kind: 'subagent-settled', form: 'notice', summary, senderSessionId: childId as never },
  })
}

function typed(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function fromAgent(senderId: string, text: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: `Agent ${senderId} sent a message: ` }, { type: 'text', text }],
    source: { kind: 'agent-message', form: 'relay', senderSessionId: senderId as never },
  })
}

function texts(message: UserMessage | undefined): string[] {
  assert.ok(message, 'a message')
  return message.content.map(block => block.type === 'text' ? block.text : `<${block.type}>`)
}

// --- the record -------------------------------------------------------------------------------------

interface Setup {
  records: CrewRecords
  /** What `whenRecorded` answers, by child id: the end being recorded now. */
  recording: Map<string, Promise<EndedRun | undefined>>
  crew: Pick<DishCrew, 'records' | 'whenRecorded'>
  warnings: string[]
  /** Run `rewriteNotices` for the session as the main agent's, with a short wait. */
  rewrite(messages: UserMessage[], extra?: { sessionId?: string, waitMs?: number }): Promise<UserMessage[]>
  child(id?: string, extra?: Partial<NewChild>, session?: string): Promise<ChildRecord>
}

async function setup(): Promise<Setup> {
  const records = new CrewRecords(await tempDir())
  const recording = new Map<string, Promise<EndedRun | undefined>>()
  const crew = { records, whenRecorded: (id: string) => recording.get(id) }
  const warnings: string[] = []
  return {
    records, recording, crew, warnings,
    rewrite: (messages, extra = {}) => rewriteNotices(messages, {
      crew, sessionId: extra.sessionId ?? SESSION, waitMs: extra.waitMs ?? 50, warn: (text, ...args) => { warnings.push(format(text, ...args)) },
    }),
    child: (id = 'child-1', extra = {}, session = SESSION) => records.addChild(session, {
      id, role: 'coder', title: 'add login', model: 'claude-sonnet-5.5', family: 'anthropic', ...extra,
    }),
  }
}

// --- the notice -------------------------------------------------------------------------------------

test('a finished child\'s notice names its role, title and model, its report, and keeps its closing message', async () => {
  const world = await setup()
  await world.child()
  const ended = await world.records.endRun('child-1', { stopReason: 'completed', closing: 'Login works.\nTests pass.' })
  const message = settlement('child-1', 'completed', ['Login works.', 'Tests pass.'])
  const [out] = await world.rewrite([message])
  assert.deepEqual(texts(out), [`${WHO} finished. Report: ${ended!.report}. Its closing message:`, 'Login works.', 'Tests pass.'])
  assert.deepEqual(world.warnings, [])
  // What dsh made stays: the message's identity and its source, and the closing blocks are the very objects.
  assert.equal(out!.id, message.id)
  assert.equal(out!.role, 'user')
  assert.equal(out!.source, message.source)
  assert.equal(out!.content[1], message.content[2])
  assert.equal(out!.content[2], message.content[3])
  // dsh's messages are deep-frozen; so is the rewritten one.
  assert.ok(Object.isFrozen(out) && Object.isFrozen(out!.content) && Object.isFrozen(out!.content[0]))
  // The original is as it was.
  assert.match(texts(message)[0]!, /^Background subagent child-1 finished/)
})

test('a failed child\'s notice says it failed, with the error it reported', async () => {
  const world = await setup()
  await world.child()
  const ended = await world.records.endRun('child-1', { stopReason: 'error', error: 'rate limited by the provider', closing: 'Got partway.' })
  const [out] = await world.rewrite([settlement('child-1', 'error', ['Got partway.'])])
  assert.deepEqual(texts(out), [`${WHO} failed: rate limited by the provider. Report: ${ended!.report}. Its closing message:`, 'Got partway.'])
})

test('a failure with no error recorded gives the stop reason in its place', async () => {
  const world = await setup()
  await world.child()
  const ended = await world.records.endRun('child-1', { stopReason: 'error', closing: '' })
  const [out] = await world.rewrite([settlement('child-1', 'error')])
  assert.deepEqual(texts(out), [`${WHO} failed: error. Report: ${ended!.report}. It left no closing message.`])
})

test('a stopped child\'s notice says it was stopped, with the stop reason', async () => {
  const world = await setup()
  await world.child()
  const ended = await world.records.endRun('child-1', { stopReason: 'aborted', closing: 'Halfway.' })
  const [out] = await world.rewrite([settlement('child-1', 'aborted', ['Halfway.'])])
  assert.deepEqual(texts(out), [`${WHO} was stopped: aborted. Report: ${ended!.report}. Its closing message:`, 'Halfway.'])
})

test('each stop reason has its verb: ran out of room, declined, and for one dsh adds later, stopped with the reason', async () => {
  const cases: Array<[string, string]> = [
    ['max-tokens', 'ran out of room: max-tokens'],
    ['refusal', 'declined: refusal'],
    ['error', 'failed: error'],
    ['aborted', 'was stopped: aborted'],
    ['future-reason', 'stopped (future-reason)'],
  ]
  for (const [stopReason, said] of cases) {
    const world = await setup()
    await world.child()
    const ended = await world.records.endRun('child-1', { stopReason, closing: 'x' })
    const [out] = await world.rewrite([settlement('child-1', stopReason, ['x'])])
    assert.equal(texts(out)[0], `${WHO} ${said}. Report: ${ended!.report}. Its closing message:`, stopReason)
  }
})

test('an unknown stop reason with an error says both', async () => {
  const world = await setup()
  await world.child()
  const ended = await world.records.endRun('child-1', { stopReason: 'weird', error: 'it broke', closing: 'x' })
  const [out] = await world.rewrite([settlement('child-1', 'weird', ['x'])])
  assert.equal(texts(out)[0], `${WHO} stopped (weird): it broke. Report: ${ended!.report}. Its closing message:`)
})

test('an error is one line, and its own full stop is not doubled', async () => {
  const world = await setup()
  await world.child()
  const ended = await world.records.endRun('child-1', { stopReason: 'error', error: 'connection reset.\n  retries exhausted. ', closing: 'x' })
  const [out] = await world.rewrite([settlement('child-1', 'error', ['x'])])
  assert.equal(texts(out)[0], `${WHO} failed: connection reset. retries exhausted. Report: ${ended!.report}. Its closing message:`)
})

test('a child that left no closing message gets dsh\'s own words for that, after the report', async () => {
  const world = await setup()
  await world.child()
  const ended = await world.records.endRun('child-1', { stopReason: 'completed', closing: '' })
  const message = settlement('child-1', 'completed')
  const [out] = await world.rewrite([message])
  assert.deepEqual(texts(out), [`${WHO} finished. Report: ${ended!.report}. It left no closing message.`])
  assert.equal(out!.source, message.source)
})

test('a child with several runs gets the notice of its latest', async () => {
  const world = await setup()
  await world.child()
  const first = await world.records.endRun('child-1', { stopReason: 'completed', closing: 'one' })
  await world.records.addFollowUp('child-1')
  const second = await world.records.endRun('child-1', { stopReason: 'completed', closing: 'two' })
  assert.notEqual(first!.report, second!.report)
  const [out] = await world.rewrite([settlement('child-1', 'completed', ['two'])])
  assert.equal(texts(out)[0], `${WHO} finished. Report: ${second!.report}. Its closing message:`)
})

test('a title with the marks in it is shown as it is', async () => {
  const world = await setup()
  await world.child('child-1', { title: 'fix «quotes» & <angles>', role: 'reviewer', model: 'gpt-6' })
  const ended = await world.records.endRun('child-1', { stopReason: 'completed', closing: 'ok' })
  const [out] = await world.rewrite([settlement('child-1', 'completed', ['ok'])])
  assert.equal(texts(out)[0], `reviewer «fix «quotes» & <angles>» (gpt-6) finished. Report: ${ended!.report}. Its closing message:`)
})

test('several notices in one step are each rewritten for their own child, in order, around other messages', async () => {
  const world = await setup()
  await world.child('child-1', { role: 'coder', title: 'one' })
  await world.child('child-2', { role: 'architect', title: 'two', model: 'claude-opus-5.5' })
  const a = await world.records.endRun('child-1', { stopReason: 'completed', closing: 'A' })
  const b = await world.records.endRun('child-2', { stopReason: 'aborted', closing: 'B' })
  const before = typed('keep going')
  const after = fromAgent('child-3', 'hello')
  const out = await world.rewrite([before, settlement('child-1', 'completed', ['A']), after, settlement('child-2', 'aborted', ['B'])])
  assert.equal(out.length, 4)
  assert.equal(out[0], before)
  assert.equal(texts(out[1])[0], `coder «one» (claude-sonnet-5.5) finished. Report: ${a!.report}. Its closing message:`)
  assert.equal(out[2], after)
  assert.equal(texts(out[3])[0], `architect «two» (claude-opus-5.5) was stopped: aborted. Report: ${b!.report}. Its closing message:`)
})

// --- what is not crew's ---------------------------------------------------------------------------

test('a settled notice from a child crew didn\'t start passes through as the same object', async () => {
  const world = await setup()
  await world.child()
  await world.records.endRun('child-1', { stopReason: 'completed', closing: 'x' })
  const foreign = settlement('dsh-subagent-9', 'completed', ['x'])
  const messages = [foreign]
  const out = await world.rewrite(messages)
  assert.equal(out, messages, 'nothing changed, so the same array')
  assert.equal(out[0], foreign)
  assert.deepEqual(world.warnings, [])
})

test('a notice from a crew child of another session is left alone', async () => {
  const world = await setup()
  await world.child('child-1', {}, 'session-other')
  await world.records.endRun('child-1', { stopReason: 'completed', closing: 'x' })
  const message = settlement('child-1', 'completed', ['x'])
  const [out] = await world.rewrite([message])
  assert.equal(out, message)
  assert.match(texts(out)[0]!, /^Background subagent child-1 finished/)
})

test('other messages are untouched, as the same objects', async () => {
  const world = await setup()
  await world.child()
  await world.records.endRun('child-1', { stopReason: 'completed', closing: 'x' })
  // A message another agent sent is not a settlement, even one from a crew child.
  const messages = [typed('hello'), fromAgent('child-1', 'my result'), typed('Background subagent child-1 finished.')]
  const out = await world.rewrite(messages)
  assert.equal(out, messages)
  out.forEach((message, index) => assert.equal(message, messages[index]))
})

test('an empty step is as it was', async () => {
  const world = await setup()
  const messages: UserMessage[] = []
  assert.equal(await world.rewrite(messages), messages)
})

test('a settled message whose first block is not text is left alone', async () => {
  const world = await setup()
  await world.child()
  await world.records.endRun('child-1', { stopReason: 'completed', closing: 'x' })
  const odd = createUserMessage({
    content: [{ type: 'image', url: 'https://example.com/x.png' } as never],
    source: { kind: 'subagent-settled', form: 'notice', summary: 's', senderSessionId: 'child-1' as never },
  })
  const [out] = await world.rewrite([odd])
  assert.equal(out, odd)
})

test('a notice with a shape dsh may have changed to keeps every block after the first, and drops no label', async () => {
  const world = await setup()
  await world.child()
  const ended = await world.records.endRun('child-1', { stopReason: 'completed', closing: 'x' })
  const odd = createUserMessage({
    content: [
      { type: 'text', text: 'Background subagent child-1 finished.' },
      { type: 'text', text: 'Output follows' },
      { type: 'text', text: 'x' },
    ],
    source: { kind: 'subagent-settled', form: 'notice', summary: 's', senderSessionId: 'child-1' as never },
  })
  const [out] = await world.rewrite([odd])
  assert.deepEqual(texts(out), [`${WHO} finished. Report: ${ended!.report}.`, 'Output follows', 'x'])
})

// --- the end that hasn't been recorded --------------------------------------------------------------

test('a notice that arrives before its run is recorded waits for it, then reports it', async () => {
  const world = await setup()
  await world.child()
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  world.recording.set('child-1', gate.then(() => world.records.endRun('child-1', { stopReason: 'completed', closing: 'Done.' })))
  let settled = false
  const result = world.rewrite([settlement('child-1', 'completed', ['Done.'])], { waitMs: 10_000 }).then((out) => {
    settled = true
    return out
  })
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(settled, false, 'still waiting for the end to be recorded')
  release()
  const [out] = await result
  const run = (await world.records.lookup('child-1'))!.record.runs[0]!
  assert.deepEqual(texts(out), [`${WHO} finished. Report: ${run.report}. Its closing message:`, 'Done.'])
})

test('a run that is never recorded: after the wait, the notice is rewritten without the report', async () => {
  const world = await setup()
  await world.child()
  world.recording.set('child-1', new Promise(() => {}))
  const started = Date.now()
  const [out] = await world.rewrite([settlement('child-1', 'error', ['It died.'])], { waitMs: 60 })
  assert.ok(Date.now() - started >= 55, 'it waited')
  // The outcome is dsh's own: nothing else says whether it failed.
  assert.deepEqual(texts(out), [`${WHO} failed before it finished. Its closing message:`, 'It died.'])
  assert.ok(!texts(out).join(' ').includes('Report'))
})

test('the wait is two seconds unless told otherwise', async () => {
  const world = await setup()
  await world.child()
  world.recording.set('child-1', new Promise(() => {}))
  const waited = rewriteNotices([settlement('child-1', 'completed', ['x'])], { crew: world.crew, sessionId: SESSION, warn: () => {} })
  let settled = false
  void waited.then(() => { settled = true })
  await new Promise(resolve => setTimeout(resolve, 1500))
  assert.equal(settled, false, 'not done at 1.5 s')
  const [out] = await waited
  assert.ok(!texts(out).join(' ').includes('Report'))
})

test('a recording that rejects is as good as one that finished', async () => {
  const world = await setup()
  await world.child()
  await world.records.endRun('child-1', { stopReason: 'completed', closing: 'x' })
  const crew = { records: world.records, whenRecorded: () => Promise.reject(new Error('never happens')) }
  const [out] = await rewriteNotices([settlement('child-1', 'completed', ['x'])], { crew, sessionId: SESSION, warn: (text, ...args) => { world.warnings.push(format(text, ...args)) } })
  assert.match(texts(out)[0]!, /Report: .*1-coder-1\.md\. Its closing message:$/)
  assert.deepEqual(world.warnings, [])
})

test('with no end heard yet and the child still running, no report is named, and an earlier round\'s is not mistaken for it', async () => {
  const world = await setup()
  await world.child()
  // Round one is recorded. A follow-up starts round two, whose notice reaches the parent before its end is heard.
  await world.records.endRun('child-1', { stopReason: 'completed', closing: 'round one' })
  await world.records.addFollowUp('child-1')
  const [out] = await world.rewrite([settlement('child-1', 'completed', ['round two'])])
  assert.deepEqual(texts(out), [`${WHO} finished and will do no further work unless you send it more. Its closing message:`, 'round two'])
})

test('a child with no run and no word of one gets the same: its role, title and model, and dsh\'s account', async () => {
  const world = await setup()
  await world.child()
  const [out] = await world.rewrite([settlement('child-1', 'aborted')])
  assert.deepEqual(texts(out), [`${WHO} was stopped before it finished. It left no closing message.`])
})

test('a dsh opening line that no longer names the child is kept whole after it', async () => {
  const world = await setup()
  await world.child()
  const odd = createUserMessage({
    content: [{ type: 'text', text: 'The helper is done.' }, { type: 'text', text: 'Its closing message:' }, { type: 'text', text: 'x' }],
    source: { kind: 'subagent-settled', form: 'notice', summary: 's', senderSessionId: 'child-1' as never },
  })
  const [out] = await world.rewrite([odd])
  assert.deepEqual(texts(out), [`${WHO}: The helper is done. Its closing message:`, 'x'])
})

// --- failures ---------------------------------------------------------------------------------------

test('a lookup that fails leaves the message as it was, and says so once', async () => {
  const world = await setup()
  const message = settlement('child-1', 'completed', ['x'])
  const crew = { ...world.crew, records: { lookup: async () => { throw new Error('disk on fire') } } as unknown as CrewRecords }
  const out = await rewriteNotices([message], { crew, sessionId: SESSION, warn: (text, ...args) => { world.warnings.push(format(text, ...args)) } })
  assert.equal(out[0], message)
  assert.equal(world.warnings.length, 1)
  assert.match(world.warnings[0]!, /child-1.*disk on fire/)
})

test('whenRecorded that throws leaves the message as it was', async () => {
  const world = await setup()
  await world.child()
  const message = settlement('child-1', 'completed', ['x'])
  const crew = { records: world.records, whenRecorded: () => { throw new Error('no such luck') } }
  const out = await rewriteNotices([message], { crew, sessionId: SESSION, warn: (text, ...args) => { world.warnings.push(format(text, ...args)) } })
  assert.equal(out[0], message)
  assert.equal(world.warnings.length, 1)
  assert.match(world.warnings[0]!, /no such luck/)
})

test('one notice that fails does not stop the others', async () => {
  const world = await setup()
  await world.child('child-1', { title: 'one' })
  await world.child('child-2', { title: 'two' })
  await world.records.endRun('child-1', { stopReason: 'completed', closing: 'A' })
  await world.records.endRun('child-2', { stopReason: 'completed', closing: 'B' })
  const first = settlement('child-1', 'completed', ['A'])
  const second = settlement('child-2', 'completed', ['B'])
  const lookup = world.records.lookup.bind(world.records)
  const records = { lookup: async (id: string) => { if (id === 'child-1') throw new Error('nope'); return lookup(id) } } as unknown as CrewRecords
  const out = await rewriteNotices([first, second], { crew: { ...world.crew, records }, sessionId: SESSION, warn: (text, ...args) => { world.warnings.push(format(text, ...args)) } })
  assert.equal(out[0], first)
  assert.match(texts(out[1])[0]!, /^coder «two» \(claude-sonnet-5.5\) finished\. Report: /)
  assert.equal(world.warnings.length, 1)
})

test('a logger that throws is not worth a failed step', async () => {
  const world = await setup()
  const message = settlement('child-1', 'completed', ['x'])
  const crew = { ...world.crew, records: { lookup: async () => { throw new Error('boom') } } as unknown as CrewRecords }
  const out = await rewriteNotices([message], { crew, sessionId: SESSION, warn: () => { throw new Error('logger down') } })
  assert.equal(out[0], message)
})

// --- noticeText -------------------------------------------------------------------------------------

test('noticeText is the plan\'s wording for a finished run and for a failed one', () => {
  const child = { id: 'c', role: 'coder', title: 'add login', model: 'claude-sonnet-5.5' }
  const run = (stopReason: string, error?: string) => ({ endedAt: 1, stopReason, report: '/data/1-coder-1.md', ...error === undefined ? {} : { error } })
  assert.equal(noticeText(child, run('completed'), 'dsh lead', 'Its closing message:'), 'coder «add login» (claude-sonnet-5.5) finished. Report: /data/1-coder-1.md. Its closing message:')
  assert.equal(noticeText(child, run('error', 'boom'), 'dsh lead', 'Its closing message:'), 'coder «add login» (claude-sonnet-5.5) failed: boom. Report: /data/1-coder-1.md. Its closing message:')
  assert.equal(noticeText(child, run('aborted'), 'dsh lead', 'It left no closing message.'), 'coder «add login» (claude-sonnet-5.5) was stopped: aborted. Report: /data/1-coder-1.md. It left no closing message.')
})

// --- the row ----------------------------------------------------------------------------------------

interface Wired {
  ctx: Context
  /** The main agent, under the preset. */
  main: Agent
  /** A child of the main agent: its scope is below the main agent's. */
  below: Agent
  /** An agent that isn't under the preset. */
  outside: Agent
  lookups: string[]
  records: CrewRecords
  recording: Map<string, Promise<EndedRun | undefined>>
  logs: string[]
  step(agent: Agent, messages: UserMessage[], decision?: PreStepDecision): Promise<PreStepDecision>
}

async function wired(options: { dishCrew?: boolean } = {}): Promise<Wired> {
  const records = new CrewRecords(await tempDir())
  const lookups: string[] = []
  const lookup = records.lookup.bind(records)
  records.lookup = async (id: string) => {
    lookups.push(id)
    return lookup(id)
  }
  const recording = new Map<string, Promise<EndedRun | undefined>>()
  const ctx = new Context()
  const logs = watchLogs(ctx)
  // As dsh's services reach a row: from plugins of their own, so that the listener can only read `dishCrew` with `ctx.get`.
  const provide = async (name: string, value: unknown): Promise<void> => {
    disposables.push(await provideStub(ctx, name, value))
  }
  await provide('tools', { register: () => () => {} })
  await provide('llm', {})
  await provide('subagents', {})
  if (options.dishCrew !== false) {
    await provide('dishCrew', { settings: async () => DEFAULT_SETTINGS, records, whenRecorded: (id: string) => recording.get(id), subagentProvider: 'spawn' })
  }
  let owner!: Context
  disposables.push(await ctx.plugin({ name: 'scope-owner', inject: ['tools'], apply(own: Context) { owner = own } } as never, undefined as never))
  // The row, mounted as dsh mounts a preset's: in the preset's scope, so that only agents under it are heard.
  const presetKey = {}
  const preset = createScope(owner, presetKey)
  disposables.push(preset)
  disposables.push(await preset.ctx.plugin(row, {} as never))

  const agent = (id: string, parent?: object): Agent => {
    const made = { id, session: { header: { id } }, options: {} }
    disposables.push(createScope(owner, made, parent === undefined ? {} : { parent }))
    return made as unknown as Agent
  }
  const main = agent(SESSION, presetKey)
  const below = agent('child-1', main)
  const outside = agent('session-elsewhere')
  const signal = new AbortController().signal
  return {
    ctx, main, below, outside, lookups, records, recording, logs,
    step: (who, messages, decision = { kind: 'enter', messages }) => agentEvents(ctx, who)
      .waterfall('agent/pre-step', { messages, turn: 1, step: 1, signal }, () => Promise.resolve(decision)),
  }
}

test('the row rewrites a crew child\'s notice at the main agent\'s pre-step, and keeps the rest of the decision', async () => {
  const world = await wired()
  await world.records.addChild(SESSION, { id: 'child-1', role: 'coder', title: 'add login', model: 'claude-sonnet-5.5', family: 'anthropic' })
  const ended = await world.records.endRun('child-1', { stopReason: 'completed', closing: 'Done.' })
  const note = settlement('child-1', 'completed', ['Done.'])
  const other = typed('and also')
  const decision = await world.step(world.main, [note, other], { kind: 'enter', messages: [note, other], startsRequestSeries: true })
  assert.equal(decision.kind, 'enter')
  assert.ok(decision.kind === 'enter')
  assert.equal(decision.startsRequestSeries, true)
  assert.equal(decision.messages.length, 2)
  assert.deepEqual(texts(decision.messages[0]), [`${WHO} finished. Report: ${ended!.report}. Its closing message:`, 'Done.'])
  assert.equal(decision.messages[0]!.id, note.id)
  assert.equal(decision.messages[1], other)
  assert.deepEqual(world.logs, [])
})

test('a step with nothing to rewrite comes back as the same decision, and asks nobody', async () => {
  const world = await wired()
  const messages = [typed('hello')]
  const decision: PreStepDecision = { kind: 'enter', messages }
  assert.equal(await world.step(world.main, messages, decision), decision)
  assert.deepEqual(world.lookups, [])
})

test('a notice for a child that is not crew\'s comes back as the same decision', async () => {
  const world = await wired()
  const messages = [settlement('someone-elses-child', 'completed', ['x'])]
  const decision: PreStepDecision = { kind: 'enter', messages }
  assert.equal(await world.step(world.main, messages, decision), decision)
  assert.deepEqual(world.lookups, ['someone-elses-child'])
})

test('a rejected step is as it was', async () => {
  const world = await wired()
  const decision: PreStepDecision = { kind: 'reject' }
  assert.equal(await world.step(world.main, [settlement('child-1', 'completed')], decision), decision)
  assert.deepEqual(world.lookups, [])
})

test('the row hears agents under its preset, children included, and not agents outside it', async () => {
  const world = await wired()
  await world.records.addChild(SESSION, { id: 'child-1', role: 'coder', title: 'add login', model: 'claude-sonnet-5.5', family: 'anthropic' })
  await world.records.endRun('child-1', { stopReason: 'completed', closing: 'x' })
  const messages = [settlement('child-1', 'completed', ['x'])]
  // An agent outside the preset: the scope filter never delivers its step to the row.
  assert.equal((await world.step(world.outside, messages)).kind, 'enter')
  assert.deepEqual(world.lookups, [])
  // A child of the main agent is under the preset, so it is heard, and its id is not the session the record names: untouched.
  const below = await world.step(world.below, messages)
  assert.ok(below.kind === 'enter')
  assert.equal(below.messages[0], messages[0])
  assert.deepEqual(world.lookups, ['child-1'])
  // The main agent's own step is rewritten.
  const main = await world.step(world.main, messages)
  assert.ok(main.kind === 'enter')
  assert.notEqual(main.messages[0], messages[0])
  assert.match(texts(main.messages[0])[0]!, /^coder «add login» /)
})

test('a failure in the row leaves the step as it was and logs once, as dish-crew', async () => {
  const world = await wired()
  world.records.lookup = async () => { throw new Error('store unreadable') }
  const messages = [settlement('child-1', 'completed', ['x'])]
  const decision: PreStepDecision = { kind: 'enter', messages }
  assert.equal(await world.step(world.main, messages, decision), decision)
  assert.equal(world.logs.length, 1)
  assert.match(world.logs[0]!, /^\[dish-crew\] warn: .*child-1.*store unreadable/)
})

test('the row waits for a run being recorded, through dishCrew.whenRecorded', async () => {
  const world = await wired()
  await world.records.addChild(SESSION, { id: 'child-1', role: 'coder', title: 'add login', model: 'claude-sonnet-5.5', family: 'anthropic' })
  world.recording.set('child-1', new Promise(resolve => setTimeout(resolve, 50)).then(() => world.records.endRun('child-1', { stopReason: 'error', error: 'it fell over', closing: 'Sorry.' })))
  const messages = [settlement('child-1', 'error', ['Sorry.'])]
  const decision = await world.step(world.main, messages)
  assert.ok(decision.kind === 'enter')
  const report = (await world.records.lookup('child-1'))!.record.runs[0]!.report
  assert.deepEqual(texts(decision.messages[0]), [`${WHO} failed: it fell over. Report: ${report}. Its closing message:`, 'Sorry.'])
})

test('the row does nothing when dishCrew is not there', async () => {
  const world = await wired({ dishCrew: false })
  const messages = [settlement('child-1', 'completed', ['x'])]
  const decision: PreStepDecision = { kind: 'enter', messages }
  assert.equal(await world.step(world.main, messages, decision), decision)
  assert.deepEqual(world.lookups, [])
})
