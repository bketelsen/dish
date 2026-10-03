import { chmod, readFile, writeFile } from 'node:fs/promises'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { format } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { SubagentRunEndInfo } from '@deepseek-ai/dsh-subagent'
import * as row from '../src/delegate.ts'
import type { DishCrew } from '../src/index.ts'
import { COMPARE_BYTES, gateLine, noticeSummary, noticeText, rewriteNotices } from '../src/notice.ts'
import { CrewRecords } from '../src/record.ts'
import type { ChildRecord, EndedRun, GateResult, NewChild, RunRecord } from '../src/record.ts'
import { DEFAULT_SETTINGS } from '../src/settings.ts'
import { dirs, mountCrew, provideStub, tempDir, watchLogs } from './helpers.ts'

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
  rewrite(messages: UserMessage[], extra?: { sessionId?: string, waitMs?: number, signal?: AbortSignal }): Promise<UserMessage[]>
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
      ...extra.signal === undefined ? {} : { signal: extra.signal },
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
  const ended = await world.records.endRun('child-1', { stopReason: 'completed', closing: 'Login works.\n\nTests pass.' })
  const message = settlement('child-1', 'completed', ['Login works.', 'Tests pass.'])
  const [out] = await world.rewrite([message])
  assert.deepEqual(texts(out), [`${WHO} finished. Report: \`${ended!.report}\`. Its closing message:`, 'Login works.', 'Tests pass.'])
  assert.deepEqual(world.warnings, [])
  // What dsh made stays: the message's identity, the source's kind, form and sender, and the closing blocks are the very objects.
  assert.equal(out!.id, message.id)
  assert.equal(out!.role, 'user')
  assert.deepEqual(out!.source, { ...message.source, summary: `${WHO} finished.` })
  assert.ok(Object.isFrozen(out!.source))
  assert.equal(out!.content[1], message.content[2])
  assert.equal(out!.content[2], message.content[3])
  // dsh's messages are deep-frozen; so is the rewritten one.
  assert.ok(Object.isFrozen(out) && Object.isFrozen(out!.content) && Object.isFrozen(out!.content[0]))
  // The original is as it was.
  assert.match(texts(message)[0]!, /^Background subagent child-1 finished/)
  assert.match((message.source as { summary: string }).summary, /^Background subagent child-1 finished/)
})

test('a failed child\'s notice says it failed, with the error it reported', async () => {
  const world = await setup()
  await world.child()
  const ended = await world.records.endRun('child-1', { stopReason: 'error', error: 'rate limited by the provider', closing: 'Got partway.' })
  const [out] = await world.rewrite([settlement('child-1', 'error', ['Got partway.'])])
  assert.deepEqual(texts(out), [`${WHO} failed: rate limited by the provider. Report: \`${ended!.report}\`. Its closing message:`, 'Got partway.'])
})

test('a failure with no error recorded is just the verb', async () => {
  const world = await setup()
  await world.child()
  const ended = await world.records.endRun('child-1', { stopReason: 'error', closing: '' })
  const [out] = await world.rewrite([settlement('child-1', 'error')])
  assert.deepEqual(texts(out), [`${WHO} failed. Report: \`${ended!.report}\`. It left no closing message.`])
})

test('a stopped child\'s notice says it was stopped', async () => {
  const world = await setup()
  await world.child()
  const ended = await world.records.endRun('child-1', { stopReason: 'aborted', closing: 'Halfway.' })
  const [out] = await world.rewrite([settlement('child-1', 'aborted', ['Halfway.'])])
  assert.deepEqual(texts(out), [`${WHO} was stopped. Report: \`${ended!.report}\`. Its closing message:`, 'Halfway.'])
})

test('each stop reason has its verb, and one dsh adds later is stopped with the reason in brackets', async () => {
  const cases: Array<[string, string]> = [
    ['max-tokens', 'ran out of room'],
    ['refusal', 'declined'],
    ['error', 'failed'],
    ['aborted', 'was stopped'],
    ['future-reason', 'stopped (future-reason)'],
  ]
  for (const [stopReason, said] of cases) {
    const world = await setup()
    await world.child()
    const ended = await world.records.endRun('child-1', { stopReason, closing: 'x' })
    const [out] = await world.rewrite([settlement('child-1', stopReason, ['x'])])
    assert.equal(texts(out)[0], `${WHO} ${said}. Report: \`${ended!.report}\`. Its closing message:`, stopReason)
  }
})

test('an unknown stop reason with an error says both', async () => {
  const world = await setup()
  await world.child()
  const ended = await world.records.endRun('child-1', { stopReason: 'weird', error: 'it broke', closing: 'x' })
  const [out] = await world.rewrite([settlement('child-1', 'weird', ['x'])])
  assert.equal(texts(out)[0], `${WHO} stopped (weird): it broke. Report: \`${ended!.report}\`. Its closing message:`)
})

test('an error is one line, and its own full stop is not doubled', async () => {
  const world = await setup()
  await world.child()
  const ended = await world.records.endRun('child-1', { stopReason: 'error', error: 'connection reset.\n  retries exhausted. ', closing: 'x' })
  const [out] = await world.rewrite([settlement('child-1', 'error', ['x'])])
  assert.equal(texts(out)[0], `${WHO} failed: connection reset. retries exhausted. Report: \`${ended!.report}\`. Its closing message:`)
})

test('a child that left no closing message gets dsh\'s own words for that, after the report', async () => {
  const world = await setup()
  await world.child()
  const ended = await world.records.endRun('child-1', { stopReason: 'completed', closing: '' })
  const message = settlement('child-1', 'completed')
  const [out] = await world.rewrite([message])
  assert.deepEqual(texts(out), [`${WHO} finished. Report: \`${ended!.report}\`. It left no closing message.`])
  assert.deepEqual(out!.source, { ...message.source, summary: `${WHO} finished.` })
})

test('a child with several runs gets the notice of its latest', async () => {
  const world = await setup()
  await world.child()
  const first = await world.records.endRun('child-1', { stopReason: 'completed', closing: 'one' })
  await world.records.addFollowUp('child-1')
  const second = await world.records.endRun('child-1', { stopReason: 'completed', closing: 'two' })
  assert.notEqual(first!.report, second!.report)
  const [out] = await world.rewrite([settlement('child-1', 'completed', ['two'])])
  assert.equal(texts(out)[0], `${WHO} finished. Report: \`${second!.report}\`. Its closing message:`)
})

test('a title with the marks in it is shown as it is', async () => {
  const world = await setup()
  await world.child('child-1', { title: 'fix «quotes» & <angles>', role: 'reviewer', model: 'gpt-6' })
  const ended = await world.records.endRun('child-1', { stopReason: 'completed', closing: 'ok' })
  const [out] = await world.rewrite([settlement('child-1', 'completed', ['ok'])])
  assert.equal(texts(out)[0], `reviewer «fix «quotes» & <angles>» (gpt-6) finished. Report: \`${ended!.report}\`. Its closing message:`)
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
  assert.equal(texts(out[1])[0], `coder «one» (claude-sonnet-5.5) finished. Report: \`${a!.report}\`. Its closing message:`)
  assert.equal(out[2], after)
  assert.equal(texts(out[3])[0], `architect «two» (claude-opus-5.5) was stopped. Report: \`${b!.report}\`. Its closing message:`)
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

test('a notice in a shape dsh may have changed to can\'t be matched to a run: it keeps every block after the first, and names no report', async () => {
  const world = await setup()
  await world.child()
  await world.records.endRun('child-1', { stopReason: 'completed', closing: 'x' })
  const odd = createUserMessage({
    content: [
      { type: 'text', text: 'Background subagent child-1 finished.' },
      { type: 'text', text: 'Output follows' },
      { type: 'text', text: 'x' },
    ],
    source: { kind: 'subagent-settled', form: 'notice', summary: 's', senderSessionId: 'child-1' as never },
  })
  const [out] = await world.rewrite([odd])
  assert.deepEqual(texts(out), [`${WHO} finished.`, 'Output follows', 'x'])
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
  assert.deepEqual(texts(out), [`${WHO} finished. Report: \`${run.report}\`. Its closing message:`, 'Done.'])
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
  assert.match(texts(out)[0]!, /Report: `.*1-coder-1\.md`\. Its closing message:$/)
  assert.deepEqual(world.warnings, [])
})

test('a notice whose run is not in the record does not cite an earlier round\'s report', async () => {
  const world = await setup()
  await world.child()
  // Round one is recorded, and a follow-up started round two. Nothing of round two's end is in the record, and nothing is
  // being recorded: the report that is there says something else than this notice does.
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

// --- which round ------------------------------------------------------------------------------------

/** The text of a run's report, as the notice cites it. */
async function reportText(path: string): Promise<string> {
  return readFile(path, 'utf8')
}

test('two notices from one child in one step each cite their own round: an error, then a completion', async () => {
  const world = await setup()
  await world.child()
  // Round one fails. The parent sends a follow-up while it is mid-step, round two completes, and the parent's next step
  // claims both notices at once.
  const one = await world.records.endRun('child-1', { stopReason: 'error', error: 'rate limited', closing: 'It broke.' })
  await world.records.addFollowUp('child-1')
  const two = await world.records.endRun('child-1', { stopReason: 'completed', closing: 'Fixed.' })
  const n1 = settlement('child-1', 'error', ['It broke.'])
  const n2 = settlement('child-1', 'completed', ['Fixed.'])
  const out = await world.rewrite([n1, n2])
  assert.deepEqual(texts(out[0]), [`${WHO} failed: rate limited. Report: \`${one!.report}\`. Its closing message:`, 'It broke.'])
  assert.deepEqual(texts(out[1]), [`${WHO} finished. Report: \`${two!.report}\`. Its closing message:`, 'Fixed.'])
  assert.equal((out[0]!.source as { summary: string }).summary, `${WHO} failed: rate limited.`)
  assert.equal((out[1]!.source as { summary: string }).summary, `${WHO} finished.`)
  assert.equal(await reportText(one!.report), 'It broke.\n')
  assert.equal(await reportText(two!.report), 'Fixed.\n')
  assert.deepEqual(world.warnings, [])
})

test('the same two notices in the other order are matched by what they say, not by where they are', async () => {
  const world = await setup()
  await world.child()
  const one = await world.records.endRun('child-1', { stopReason: 'error', closing: 'It broke.' })
  const two = await world.records.endRun('child-1', { stopReason: 'completed', closing: 'Fixed.' })
  const out = await world.rewrite([settlement('child-1', 'completed', ['Fixed.']), settlement('child-1', 'error', ['It broke.'])])
  assert.match(texts(out[0])[0]!, new RegExp(`finished\\. Report: \`${two!.report}\``))
  assert.match(texts(out[1])[0]!, new RegExp(`failed\\. Report: \`${one!.report}\``))
})

test('a notice whose round ended is not given the report of a round that ended after it', async () => {
  const world = await setup()
  await world.child()
  // Round two ended, and was recorded, after the parent claimed round one's notice and before it asked for the report.
  const one = await world.records.endRun('child-1', { stopReason: 'error', error: 'timed out', closing: 'Too slow.' })
  await world.records.addFollowUp('child-1')
  await world.records.endRun('child-1', { stopReason: 'completed', closing: 'Quick now.' })
  // And a third round is under way, so the record says running.
  await world.records.addFollowUp('child-1')
  const [out] = await world.rewrite([settlement('child-1', 'error', ['Too slow.'])])
  assert.deepEqual(texts(out), [`${WHO} failed: timed out. Report: \`${one!.report}\`. Its closing message:`, 'Too slow.'])
})

test('rounds with the same closing text and different stop reasons are told apart by the reason', async () => {
  const world = await setup()
  await world.child()
  const one = await world.records.endRun('child-1', { stopReason: 'error', error: 'boom', closing: 'Stopped here.' })
  const two = await world.records.endRun('child-1', { stopReason: 'completed', closing: 'Stopped here.' })
  assert.notEqual(one!.report, two!.report)
  const n1 = settlement('child-1', 'error', ['Stopped here.'])
  const n2 = settlement('child-1', 'completed', ['Stopped here.'])
  const both = await world.rewrite([n1, n2])
  assert.equal(texts(both[0])[0], `${WHO} failed: boom. Report: \`${one!.report}\`. Its closing message:`)
  assert.equal(texts(both[1])[0], `${WHO} finished. Report: \`${two!.report}\`. Its closing message:`)
  // The older round alone: the newer run has the same text, and still isn't its.
  const [alone] = await world.rewrite([n1])
  assert.equal(texts(alone)[0], `${WHO} failed: boom. Report: \`${one!.report}\`. Its closing message:`)
})

test('rounds with the same closing text and the same stop reason: the newest unclaimed run, the last notice first', async () => {
  const world = await setup()
  await world.child()
  const one = await world.records.endRun('child-1', { stopReason: 'completed', closing: 'Done.' })
  const two = await world.records.endRun('child-1', { stopReason: 'completed', closing: 'Done.' })
  assert.notEqual(one!.report, two!.report)
  const n1 = settlement('child-1', 'completed', ['Done.'])
  const n2 = settlement('child-1', 'completed', ['Done.'])
  // Both in one step: the reports say the same, so which is whose is decided by order. The last notice is the newest, so it
  // takes the newest run, and the one before it the next.
  const both = await world.rewrite([n1, n2])
  assert.equal(texts(both[0])[0], `${WHO} finished. Report: \`${one!.report}\`. Its closing message:`)
  assert.equal(texts(both[1])[0], `${WHO} finished. Report: \`${two!.report}\`. Its closing message:`)
  // One alone: the earlier notices went in earlier steps, so this one is the newest round's.
  const [alone] = await world.rewrite([n2])
  assert.equal(texts(alone)[0], `${WHO} finished. Report: \`${two!.report}\`. Its closing message:`)
})

test('a child with no closing message in either round: the reports say "(no closing message)", and the reasons tell them apart', async () => {
  const world = await setup()
  await world.child()
  const one = await world.records.endRun('child-1', { stopReason: 'aborted', closing: '' })
  const two = await world.records.endRun('child-1', { stopReason: 'completed', closing: '' })
  const out = await world.rewrite([settlement('child-1', 'aborted'), settlement('child-1', 'completed')])
  assert.equal(texts(out[0])[0], `${WHO} was stopped. Report: \`${one!.report}\`. It left no closing message.`)
  assert.equal(texts(out[1])[0], `${WHO} finished. Report: \`${two!.report}\`. It left no closing message.`)
  assert.equal(await reportText(one!.report), '(no closing message)\n')
})

test('a notice is matched to a report whatever the blank lines and spaces in its closing blocks', async () => {
  const world = await setup()
  await world.child()
  // The host drops a block that is only blanks, and joins the others with a blank line; the report ends in one newline.
  const run = await world.records.endRun('child-1', { stopReason: 'completed', closing: '  indented\n\nsecond' })
  const [out] = await world.rewrite([settlement('child-1', 'completed', ['  indented', '   ', 'second'])])
  assert.match(texts(out)[0]!, new RegExp(`Report: \`${run!.report}\``))
})

test('a report that is gone, or that no longer says what the notice says, is not cited', async () => {
  const world = await setup()
  await world.child()
  const run = await world.records.endRun('child-1', { stopReason: 'completed', closing: 'Done.' })
  const message = settlement('child-1', 'completed', ['Done.'])
  // Edited, to the same size.
  await writeFile(run!.report, 'Dome.\n')
  const [edited] = await world.rewrite([message])
  assert.deepEqual(texts(edited), [`${WHO} finished and will do no further work unless you send it more. Its closing message:`, 'Done.'])
  // Edited, to another size.
  await writeFile(run!.report, 'Something else entirely.\n')
  const [longer] = await world.rewrite([message])
  assert.ok(!texts(longer)[0]!.includes('Report'))
  // Gone.
  await (await import('node:fs/promises')).rm(run!.report)
  const [gone] = await world.rewrite([message])
  assert.deepEqual(texts(gone), [`${WHO} finished and will do no further work unless you send it more. Its closing message:`, 'Done.'])
  assert.deepEqual(world.warnings, [], 'a report that is not there is not worth a warning')
})

test('a report is compared by its size and its first mebibyte, so a long one is not read whole', async () => {
  const world = await setup()
  await world.child()
  const text = 'a'.repeat(COMPARE_BYTES + 1000)
  const run = await world.records.endRun('child-1', { stopReason: 'completed', closing: text })
  const message = settlement('child-1', 'completed', [text])
  const [matched] = await world.rewrite([message])
  assert.match(texts(matched)[0]!, new RegExp(`Report: \`${run!.report}\``))
  // Past the cap nothing is read: the same size with other bytes out there is taken as a match.
  await writeFile(run!.report, `${'a'.repeat(COMPARE_BYTES + 995)}bbbbb\n`)
  const [capped] = await world.rewrite([message])
  assert.match(texts(capped)[0]!, new RegExp(`Report: \`${run!.report}\``))
  // Within it, it is read: a difference there is seen.
  await writeFile(run!.report, `b${'a'.repeat(COMPARE_BYTES + 999)}\n`)
  const [seen] = await world.rewrite([message])
  assert.ok(!texts(seen)[0]!.includes('Report'))
})

test('a notice whose opening line dsh worded in a way this does not know is matched by its closing message alone', async () => {
  const world = await setup()
  await world.child()
  const one = await world.records.endRun('child-1', { stopReason: 'error', closing: 'One.' })
  const two = await world.records.endRun('child-1', { stopReason: 'completed', closing: 'Two.' })
  const odd = (text: string) => createUserMessage({
    content: [{ type: 'text', text: 'The helper is done.' }, { type: 'text', text: 'Its closing message:' }, { type: 'text', text }],
    source: { kind: 'subagent-settled', form: 'notice', summary: 's', senderSessionId: 'child-1' as never },
  })
  const out = await world.rewrite([odd('One.'), odd('Two.')])
  assert.deepEqual(texts(out[0]), [`${WHO} failed. Report: \`${one!.report}\`. Its closing message:`, 'One.'])
  assert.deepEqual(texts(out[1]), [`${WHO} finished. Report: \`${two!.report}\`. Its closing message:`, 'Two.'])
})

test('a notice for a round that matches no run gets the fallback, and the others in the step are rewritten', async () => {
  const world = await setup()
  await world.child()
  const one = await world.records.endRun('child-1', { stopReason: 'completed', closing: 'Known.' })
  const out = await world.rewrite([settlement('child-1', 'completed', ['Known.']), settlement('child-1', 'completed', ['Unrecorded.'])])
  assert.equal(texts(out[0])[0], `${WHO} finished. Report: \`${one!.report}\`. Its closing message:`)
  assert.deepEqual(texts(out[1]), [`${WHO} finished and will do no further work unless you send it more. Its closing message:`, 'Unrecorded.'])
})

test('a run the host plugin records from subagent/end is the report the notice for the same blocks cites', async () => {
  const where = await dirs()
  const ctx = new Context()
  const handle = mountCrew(ctx, where.data)
  await handle
  try {
    await ctx.dishCrew.records.addChild(SESSION, { id: 'child-1', role: 'coder', title: 'add login', model: 'claude-sonnet-5.5', family: 'anthropic' })
    // The blocks dsh publishes on `subagent/end` for a child: reasoning and tool calls too, and a block of blanks. dsh's
    // notice carries the text blocks of the same output, blanks included, so the two see the same closing message only if
    // the record and the notice read it by the same rule.
    const closing = ['I got as far as the router.', '   ', 'Then the API stopped answering.']
    ctx.emit('subagent/end', {
      runId: 'run-1', provider: 'spawn', id: 'child-1', local: true, stopReason: 'completed',
      lastAssistantMessage: [
        { type: 'reasoning', text: 'thinking about it' },
        { type: 'text', text: closing[0] },
        { type: 'tool_use', id: 't1', name: 'read', input: {} },
        { type: 'text', text: closing[1] },
        { type: 'text', text: closing[2] },
      ],
    } as unknown as SubagentRunEndInfo)
    const warnings: string[] = []
    const [out] = await rewriteNotices([settlement('child-1', 'completed', closing)], {
      crew: ctx.dishCrew, sessionId: SESSION, warn: (text, ...args) => { warnings.push(format(text, ...args)) },
    })
    const report = (await ctx.dishCrew.records.lookup('child-1'))!.record.runs[0]!.report
    assert.equal(await readFile(report, 'utf8'), 'I got as far as the router.\n\nThen the API stopped answering.\n')
    assert.deepEqual(texts(out).slice(0, 1), [`${WHO} finished. Report: \`${report}\`. Its closing message:`])
    assert.deepEqual(warnings, [])
    // And a child that left nothing says the same on both sides.
    await ctx.dishCrew.records.addChild(SESSION, { id: 'child-2', role: 'coder', title: 'add login', model: 'claude-sonnet-5.5', family: 'anthropic' })
    ctx.emit('subagent/end', {
      runId: 'run-2', provider: 'spawn', id: 'child-2', local: true, stopReason: 'completed',
      lastAssistantMessage: [{ type: 'text', text: '  \n' }],
    } as unknown as SubagentRunEndInfo)
    const [none] = await rewriteNotices([settlement('child-2', 'completed', ['  \n'])], { crew: ctx.dishCrew, sessionId: SESSION, warn: () => {} })
    assert.match(texts(none)[0]!, /finished\. Report: `.*2-coder-1\.md`\. Its closing message:$/)
  } finally {
    await handle.dispose()
  }
})

test('a report that can\'t be read is not the run, and the search goes on, with one warning', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async () => {
  const world = await setup()
  await world.child()
  // Two rounds that said the same: a notice takes the newest, and when that one can't be read, the one before it.
  const one = await world.records.endRun('child-1', { stopReason: 'completed', closing: 'Done.' })
  const two = await world.records.endRun('child-1', { stopReason: 'completed', closing: 'Done.' })
  await chmod(two!.report, 0o000)
  try {
    const [out] = await world.rewrite([settlement('child-1', 'completed', ['Done.'])])
    assert.deepEqual(texts(out), [`${WHO} finished. Report: \`${one!.report}\`. Its closing message:`, 'Done.'])
    assert.equal(world.warnings.length, 1)
    assert.match(world.warnings[0]!, /child-1.*EACCES/)
    // Two notices that both meet it are told once. The last takes the one report that can be read, and the other has none.
    world.warnings.length = 0
    const both = await world.rewrite([settlement('child-1', 'completed', ['Done.']), settlement('child-1', 'completed', ['Done.'])])
    assert.equal(world.warnings.length, 1)
    assert.ok(!texts(both[0])[0]!.includes('Report'))
    assert.equal(texts(both[1])[0], `${WHO} finished. Report: \`${one!.report}\`. Its closing message:`)
    // With nothing else that matches, it is the form without a report.
    await chmod(one!.report, 0o000)
    world.warnings.length = 0
    const [none] = await world.rewrite([settlement('child-1', 'completed', ['Done.'])])
    assert.deepEqual(texts(none), [`${WHO} finished and will do no further work unless you send it more. Its closing message:`, 'Done.'])
    assert.equal(world.warnings.length, 1)
  } finally {
    await chmod(two!.report, 0o600)
    await chmod(one!.report, 0o600)
  }
})

// --- the summary --------------------------------------------------------------------------------------

test('the source\'s summary is the role-named first sentence, without the report', async () => {
  const world = await setup()
  await world.child()
  await world.records.endRun('child-1', { stopReason: 'refusal', closing: 'No.' })
  const message = settlement('child-1', 'refusal', ['No.'])
  const [out] = await world.rewrite([message])
  assert.deepEqual(out!.source, { kind: 'subagent-settled', form: 'notice', summary: `${WHO} declined.`, senderSessionId: 'child-1' })
  assert.match((message.source as { summary: string }).summary, /^Background subagent child-1 declined the task\.$/)
})

test('the summary of a notice with no run is dsh\'s sentence, renamed', async () => {
  const world = await setup()
  await world.child()
  const [out] = await world.rewrite([settlement('child-1', 'max-tokens', ['x'])])
  assert.equal((out!.source as { summary: string }).summary, `${WHO} ran out of room before it finished.`)
})

test('a summary is bounded to 120 characters, as dsh bounds its own, and the text is not', async () => {
  const world = await setup()
  await world.child('child-1', { title: 'a'.repeat(60) })
  const error = 'e'.repeat(300)
  await world.records.endRun('child-1', { stopReason: 'error', error, closing: 'x' })
  const [out] = await world.rewrite([settlement('child-1', 'error', ['x'])])
  const summary = (out!.source as { summary: string }).summary
  assert.equal(summary.length, 120)
  assert.ok(summary.endsWith('…'))
  assert.ok(summary.startsWith(`coder «${'a'.repeat(60)}» (claude-sonnet-5.5) failed: eee`))
  assert.ok(texts(out)[0]!.includes(error), 'the text has the whole error')
})

// --- a turn that is cancelled -------------------------------------------------------------------------

test('a cancelled turn does not wait for a run that is being recorded', async () => {
  const world = await setup()
  await world.child()
  world.recording.set('child-1', new Promise(() => {}))
  const controller = new AbortController()
  const message = settlement('child-1', 'completed', ['x'])
  const started = Date.now()
  setTimeout(() => controller.abort(), 30)
  const out = await world.rewrite([message], { waitMs: 30_000, signal: controller.signal })
  assert.ok(Date.now() - started < 1500, 'it did not wait the 30 s')
  assert.equal(out[0], message, 'a step that is cancelled is not rewritten')
  assert.deepEqual(world.warnings, [])
})

test('a turn cancelled already is not looked at', async () => {
  const world = await setup()
  await world.child()
  const controller = new AbortController()
  controller.abort()
  const messages = [settlement('child-1', 'completed', ['x'])]
  assert.equal(await world.rewrite(messages, { signal: controller.signal }), messages)
})

test('a turn cancelled inside the first lookup does not wait for a run that is being recorded', async () => {
  const world = await setup()
  await world.child()
  world.recording.set('child-1', new Promise(() => {}))
  const controller = new AbortController()
  const lookup = world.records.lookup.bind(world.records)
  world.records.lookup = async (id: string) => {
    const found = await lookup(id)
    controller.abort()
    return found
  }
  const message = settlement('child-1', 'completed', ['x'])
  const started = Date.now()
  const out = await world.rewrite([message], { waitMs: 30_000, signal: controller.signal })
  assert.ok(Date.now() - started < 1500, 'it did not wait the 30 s')
  assert.equal(out[0], message)
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
  assert.equal(noticeText(child, run('completed'), 'dsh lead', 'Its closing message:'), 'coder «add login» (claude-sonnet-5.5) finished. Report: `/data/1-coder-1.md`. Its closing message:')
  assert.equal(noticeText(child, run('error', 'boom'), 'dsh lead', 'Its closing message:'), 'coder «add login» (claude-sonnet-5.5) failed: boom. Report: `/data/1-coder-1.md`. Its closing message:')
  assert.equal(noticeText(child, run('aborted'), 'dsh lead', 'It left no closing message.'), 'coder «add login» (claude-sonnet-5.5) was stopped. Report: `/data/1-coder-1.md`. It left no closing message.')
  assert.equal(noticeSummary(child, run('error', 'boom'), 'dsh lead'), 'coder «add login» (claude-sonnet-5.5) failed: boom.')
  assert.equal(noticeSummary(child, undefined, 'Background subagent c finished and will do no further work unless you send it more.'), 'coder «add login» (claude-sonnet-5.5) finished and will do no further work unless you send it more.')
})

// --- the gate line ----------------------------------------------------------------------------------

const BOUND = { worktree: '/work/dish/.worktrees/add-login' }
const LOG = '/state/dish/gates/bketelsen/dish/add-login/child-1-1-3.log'

/** A gate result as dish-gates records it, with what a test names changed. */
function gate(extra: Partial<GateResult> = {}): GateResult {
  return {
    turn: 1, round: 1, maxRounds: 3, outcome: 'passed', command: 'make test', exitCode: 0, timedOut: false, durationMs: 4200,
    log: LOG, excerpt: '', at: 1, ...extra,
  }
}

function runWith(gates?: GateResult[]): RunRecord {
  return { endedAt: 1, stopReason: 'completed', report: '/data/1-coder-1.md', ...gates === undefined ? {} : { gates } }
}

test('a pass: "Gate passed (round N)."', () => {
  assert.equal(gateLine(BOUND, runWith([gate({ round: 1 })])), 'Gate passed (round 1).')
  assert.equal(gateLine(BOUND, runWith([gate({ outcome: 'failed', exitCode: 1, round: 1 }), gate({ round: 2 })])), 'Gate passed (round 2).')
})

test('rounds that ran out: the command, the exit code, the last lines in a fence, the log, and what to do next', () => {
  const failed = gate({ outcome: 'failed', exitCode: 2, round: 3, excerpt: 'FAIL src/login.test.ts\n1 failed' })
  assert.equal(
    gateLine(BOUND, runWith([failed])),
    `Gate FAILED after 3 rounds (\`make test\`, exit 2); last lines:\n\`\`\`\nFAIL src/login.test.ts\n1 failed\n\`\`\`\n`
    + `Full log: \`${LOG}\`. Start a fix round with \`to\` or a fresh coder (escalation ladder).`,
  )
})

test('rounds that ran out on the time limit say so in place of an exit code', () => {
  const timedOut = gate({ outcome: 'failed', exitCode: null, timedOut: true, round: 3, excerpt: 'still going' })
  assert.equal(
    gateLine(BOUND, runWith([timedOut])),
    `Gate FAILED after 3 rounds (\`make test\`, stopped at its time limit); last lines:\n\`\`\`\nstill going\n\`\`\`\n`
    + `Full log: \`${LOG}\`. Start a fix round with \`to\` or a fresh coder (escalation ladder).`,
  )
})

test('the fence is longer than any run of backticks in the excerpt, and at least three', () => {
  const lines = (excerpt: string): string[] => gateLine(BOUND, runWith([gate({ outcome: 'failed', exitCode: 1, round: 3, excerpt })]))!.split('\n')
  assert.deepEqual(lines('plain').slice(1, 4), ['```', 'plain', '```'])
  assert.deepEqual(lines('a ``` b').slice(1, 4), ['````', 'a ``` b', '````'])
  assert.deepEqual(lines('``` one\n````` two\n`` three').slice(1, 5), ['``````', '``` one', '````` two', '`` three'])
  assert.equal(lines('``` one\n````` two\n`` three')[5], '``````')
  assert.deepEqual(lines('`single`').slice(1, 4), ['```', '`single`', '```'])
})

test('a failure with no output says so in place of a fence, and a failure with no log leaves the log out', () => {
  assert.equal(
    gateLine(BOUND, runWith([gate({ outcome: 'failed', exitCode: 1, round: 3, excerpt: '' })])),
    `Gate FAILED after 3 rounds (\`make test\`, exit 1); it printed no output. Full log: \`${LOG}\`. Start a fix round with \`to\` or a fresh coder (escalation ladder).`,
  )
  assert.equal(
    gateLine(BOUND, runWith([gate({ outcome: 'failed', exitCode: 1, round: 3, excerpt: 'boom', log: null })])),
    'Gate FAILED after 3 rounds (`make test`, exit 1); last lines:\n```\nboom\n```\nStart a fix round with `to` or a fresh coder (escalation ladder).',
  )
})

test('one round is "1 round", and a killed gate with no exit code says that', () => {
  assert.match(gateLine(BOUND, runWith([gate({ outcome: 'failed', exitCode: 1, round: 1, maxRounds: 1 })]))!, /^Gate FAILED after 1 round \(/)
  assert.match(gateLine(BOUND, runWith([gate({ outcome: 'failed', exitCode: null, round: 3 })]))!, /^Gate FAILED after 3 rounds \(`make test`, no exit code\)/)
})

test('a failure with a round to spare: the run ended before the coder finished again', () => {
  assert.equal(
    gateLine(BOUND, runWith([gate({ outcome: 'failed', exitCode: 1, round: 2, maxRounds: 3, excerpt: 'not shown' })])),
    `Gate failed in round 2 of 3 (\`make test\`, exit 1), and the run ended before the coder finished again. Full log: \`${LOG}\`.`,
  )
  assert.equal(
    gateLine(BOUND, runWith([gate({ outcome: 'failed', exitCode: null, timedOut: true, round: 1, log: null })])),
    'Gate failed in round 1 of 3 (`make test`, stopped at its time limit), and the run ended before the coder finished again.',
  )
})

test('a skip says why; an opt-out is the spec\'s sentence', () => {
  assert.equal(gateLine(BOUND, runWith([gate({ outcome: 'skipped', command: '', exitCode: null, log: null, reason: 'the coder reported BLOCKED / NEEDS CONTEXT' })])), 'Gate skipped: the coder reported BLOCKED / NEEDS CONTEXT.')
  assert.equal(gateLine(BOUND, runWith([gate({ outcome: 'skipped', command: '', exitCode: null, log: null, reason: 'its worktree is gone' })])), 'Gate skipped: its worktree is gone.')
  assert.equal(gateLine(BOUND, runWith([gate({ outcome: 'skipped', command: '', exitCode: null, log: null })])), 'Gate skipped.')
})

test('an error says it didn\'t run, and why', () => {
  assert.equal(gateLine(BOUND, runWith([gate({ outcome: 'error', command: 'make test', exitCode: null, log: null, reason: 'the sandbox is not available' })])), 'Gate not run: the sandbox is not available.')
  assert.equal(gateLine(BOUND, runWith([gate({ outcome: 'error', exitCode: null, log: null, reason: 'first line\nsecond   line.\n' })])), 'Gate not run: first line second line.')
  assert.equal(gateLine(BOUND, runWith([gate({ outcome: 'error', exitCode: null, log: null })])), 'Gate not run.')
})

test('a bound child\'s run with no gate result: "Gate not run."', () => {
  assert.equal(gateLine(BOUND, runWith()), 'Gate not run.')
  assert.equal(gateLine(BOUND, runWith([])), 'Gate not run.')
  // dish-gates isn't running: no gate was going to run, so a run with no result says nothing. A recorded result still shows.
  assert.equal(gateLine(BOUND, runWith(), false), undefined)
  assert.equal(gateLine(BOUND, runWith([gate({ outcome: 'passed', exitCode: 0 })]), false), 'Gate passed (round 1).')
})

test('an unbound child has no gate line, whatever its run holds', () => {
  assert.equal(gateLine({}, runWith()), undefined)
  assert.equal(gateLine({}, runWith([gate()])), undefined)
})

test('the line is of the run\'s last result', () => {
  const failed = gate({ outcome: 'failed', exitCode: 1, round: 1 })
  assert.equal(gateLine(BOUND, runWith([failed, gate({ outcome: 'failed', exitCode: 1, round: 2 }), gate({ round: 3 })])), 'Gate passed (round 3).')
  assert.match(gateLine(BOUND, runWith([gate(), gate({ outcome: 'failed', exitCode: 1, round: 3 })]))!, /^Gate FAILED after 3 rounds/)
})

test('a command with backticks or line breaks is quoted whole, on one line', () => {
  assert.equal(
    gateLine(BOUND, runWith([gate({ outcome: 'failed', exitCode: 1, round: 2, command: 'make test\n  && echo `date`' })])),
    `Gate failed in round 2 of 3 (\`\` make test && echo \`date\` \`\`, exit 1), and the run ended before the coder finished again. Full log: \`${LOG}\`.`,
  )
})

test('a bound child\'s notice carries the gate line after the report and before dsh\'s label', async () => {
  const world = await setup()
  await world.child('child-1', BOUND)
  await world.records.addGate('child-1', gate({ outcome: 'failed', exitCode: 1, round: 1 }))
  await world.records.addGate('child-1', gate({ round: 2 }))
  const ended = await world.records.endRun('child-1', { stopReason: 'completed', closing: 'Login works.' })
  const [out] = await world.rewrite([settlement('child-1', 'completed', ['Login works.'])])
  assert.deepEqual(texts(out), [`${WHO} finished. Report: \`${ended!.report}\`. Gate passed (round 2). Its closing message:`, 'Login works.'])
  // The collapsed row's sentence is the same as for any child.
  assert.equal((out!.source as { summary: string }).summary, `${WHO} finished.`)
  assert.deepEqual(world.warnings, [])
})

test('a failed gate\'s notice puts the fence, the log and the label in order', async () => {
  const world = await setup()
  await world.child('child-1', BOUND)
  await world.records.addGate('child-1', gate({ outcome: 'failed', exitCode: 2, round: 3, excerpt: 'FAIL one\nFAIL two' }))
  const ended = await world.records.endRun('child-1', { stopReason: 'completed', closing: 'I tried.' })
  const [out] = await world.rewrite([settlement('child-1', 'completed', ['I tried.'])])
  assert.deepEqual(texts(out), [
    `${WHO} finished. Report: \`${ended!.report}\`. Gate FAILED after 3 rounds (\`make test\`, exit 2); last lines:\n\`\`\`\nFAIL one\nFAIL two\n\`\`\`\n`
    + `Full log: \`${LOG}\`. Start a fix round with \`to\` or a fresh coder (escalation ladder). Its closing message:`,
    'I tried.',
  ])
})

test('a bound child\'s run with no gate result is told "Gate not run."', async () => {
  const world = await setup()
  await world.child('child-1', BOUND)
  const ended = await world.records.endRun('child-1', { stopReason: 'error', error: 'rate limited', closing: 'Got partway.' })
  const [out] = await world.rewrite([settlement('child-1', 'error', ['Got partway.'])])
  assert.deepEqual(texts(out), [`${WHO} failed: rate limited. Report: \`${ended!.report}\`. Gate not run. Its closing message:`, 'Got partway.'])
  // And the same for a child that left no closing message.
  await world.child('child-2', BOUND)
  const second = await world.records.endRun('child-2', { stopReason: 'completed', closing: '' })
  const [none] = await world.rewrite([settlement('child-2', 'completed')])
  assert.deepEqual(texts(none), [`${WHO} finished. Report: \`${second!.report}\`. Gate not run. It left no closing message.`])
})

test('an unbound child\'s notice is as it was', async () => {
  const world = await setup()
  await world.child()
  const ended = await world.records.endRun('child-1', { stopReason: 'completed', closing: 'Login works.' })
  const [out] = await world.rewrite([settlement('child-1', 'completed', ['Login works.'])])
  assert.deepEqual(texts(out), [`${WHO} finished. Report: \`${ended!.report}\`. Its closing message:`, 'Login works.'])
})

test('each round\'s notice has the gate line of its own run', async () => {
  const world = await setup()
  await world.child('child-1', BOUND)
  await world.records.addGate('child-1', gate({ outcome: 'failed', exitCode: 1, round: 3, excerpt: 'red' }))
  const first = await world.records.endRun('child-1', { stopReason: 'completed', closing: 'First try.' })
  await world.records.addFollowUp('child-1')
  await world.records.addGate('child-1', gate({ turn: 2, round: 1 }))
  const second = await world.records.endRun('child-1', { stopReason: 'completed', closing: 'Second try.' })
  const [one, two] = await world.rewrite([settlement('child-1', 'completed', ['First try.']), settlement('child-1', 'completed', ['Second try.'])])
  assert.ok(texts(one)[0]!.startsWith(`${WHO} finished. Report: \`${first!.report}\`. Gate FAILED after 3 rounds (\`make test\`, exit 1); last lines:\n`))
  assert.deepEqual(texts(two), [`${WHO} finished. Report: \`${second!.report}\`. Gate passed (round 1). Its closing message:`, 'Second try.'])
})

test('a notice that matches no run has no gate line, as it has no report', async () => {
  const world = await setup()
  await world.child('child-1', BOUND)
  await world.records.addGate('child-1', gate())
  await world.records.endRun('child-1', { stopReason: 'completed', closing: 'Something else.' })
  const [out] = await world.rewrite([settlement('child-1', 'completed', ['What the record never saw.'])])
  assert.deepEqual(texts(out), [`${WHO} finished and will do no further work unless you send it more. Its closing message:`, 'What the record never saw.'])
})

test('noticeText puts the gate line between the report and the label, for a bound child only', () => {
  const run = runWith([gate({ round: 2 })])
  assert.equal(
    noticeText({ id: 'c', role: 'coder', title: 'add login', model: 'claude-sonnet-5.5', ...BOUND }, run, 'dsh lead', 'Its closing message:'),
    'coder «add login» (claude-sonnet-5.5) finished. Report: `/data/1-coder-1.md`. Gate passed (round 2). Its closing message:',
  )
  assert.equal(
    noticeText({ id: 'c', role: 'coder', title: 'add login', model: 'claude-sonnet-5.5', ...BOUND }, run, 'dsh lead'),
    'coder «add login» (claude-sonnet-5.5) finished. Report: `/data/1-coder-1.md`. Gate passed (round 2).',
  )
  assert.equal(
    noticeText({ id: 'c', role: 'coder', title: 'add login', model: 'claude-sonnet-5.5' }, run, 'dsh lead', 'Its closing message:'),
    'coder «add login» (claude-sonnet-5.5) finished. Report: `/data/1-coder-1.md`. Its closing message:',
  )
  assert.equal(
    noticeSummary({ id: 'c', role: 'coder', title: 'add login', model: 'claude-sonnet-5.5', ...BOUND }, run, 'dsh lead'),
    'coder «add login» (claude-sonnet-5.5) finished.',
  )
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
  step(agent: Agent, messages: UserMessage[], decision?: PreStepDecision, signal?: AbortSignal): Promise<PreStepDecision>
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
  const quiet = new AbortController().signal
  return {
    ctx, main, below, outside, lookups, records, recording, logs,
    step: (who, messages, decision = { kind: 'enter', messages }, signal = quiet) => agentEvents(ctx, who)
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
  assert.deepEqual(texts(decision.messages[0]), [`${WHO} finished. Report: \`${ended!.report}\`. Its closing message:`, 'Done.'])
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
  assert.deepEqual(texts(decision.messages[0]), [`${WHO} failed: it fell over. Report: \`${report}\`. Its closing message:`, 'Sorry.'])
})

test('the row stops waiting when the turn is cancelled', async () => {
  const world = await wired()
  await world.records.addChild(SESSION, { id: 'child-1', role: 'coder', title: 'add login', model: 'claude-sonnet-5.5', family: 'anthropic' })
  world.recording.set('child-1', new Promise(() => {}))
  const controller = new AbortController()
  const messages = [settlement('child-1', 'completed', ['x'])]
  const decision: PreStepDecision = { kind: 'enter', messages }
  const started = Date.now()
  setTimeout(() => controller.abort(), 30)
  // The wait is two seconds when nothing cancels it.
  assert.equal(await world.step(world.main, messages, decision, controller.signal), decision)
  assert.ok(Date.now() - started < 1500, 'it did not wait the two seconds')
})

test('the row does nothing when dishCrew is not there', async () => {
  const world = await wired({ dishCrew: false })
  const messages = [settlement('child-1', 'completed', ['x'])]
  const decision: PreStepDecision = { kind: 'enter', messages }
  assert.equal(await world.step(world.main, messages, decision), decision)
  assert.deepEqual(world.lookups, [])
})
