import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import { ClosingHeads, HEAD_CHARS, OPT_OUT, REPORT_STATUSES, REPORT_TOOL, optsOut } from '../src/closing.ts'

const disposables: Array<{ dispose(): Promise<void> | void }> = []
after(async () => {
  await Promise.all(disposables.splice(0).map(handle => handle.dispose()))
})

// --- the opt-out ------------------------------------------------------------------------------------

test('optsOut is true for the markers, with marks, in any case', () => {
  for (const head of [
    'BLOCKED: x',
    '  \n NEEDS CONTEXT: y',
    '**BLOCKED:** z',
    '**BLOCKED**: z',
    '# Needs context: q',
    'NEEDS_CONTEXT: q',
    'blocked: x',
    '> BLOCKED: quoted',
    '`BLOCKED`: code',
    '__NEEDS CONTEXT__: bold',
    'BLOCKED : spaced',
    'Needs_Context: mixed',
    'BLOCKED:',
  ]) assert.equal(optsOut(head), true, JSON.stringify(head))
})

test('optsOut is false for anything else', () => {
  for (const head of [
    '',
    '   ',
    'I\'m BLOCKED: x',
    'BLOCKED x',
    'Done. BLOCKED: no',
    'Blockedness: not a marker',
    'NEEDS CONTEXTS: x',
    'NEEDS-CONTEXT: x',
    'NEEDS  CONTEXT: x',
    'The task is done.\nBLOCKED: not first',
    '1. BLOCKED: x',
    '- BLOCKED: x',
    'NEEDS CONTEXT',
  ]) assert.equal(optsOut(head), false, JSON.stringify(head))
})

test('OPT_OUT is the contract\'s expression and holds no state between calls', () => {
  assert.equal(OPT_OUT.source, '^[\\s#>*_`]*(?:BLOCKED|NEEDS[ _]CONTEXT)[*_`]*\\s*:')
  assert.equal(OPT_OUT.flags, 'i')
  for (let i = 0; i < 4; i++) assert.equal(optsOut('BLOCKED: x'), true)
})

test('optsOut takes a long head without trouble', () => {
  assert.equal(optsOut(`${' '.repeat(100_000)}BLOCKED: x`), true)
  assert.equal(optsOut(`${'*'.repeat(100_000)}x`), false)
  assert.equal(optsOut(`BLOCKED${'*'.repeat(100_000)} x`), false)
})

// --- ClosingHeads, with events as the session publishes them ----------------------------------------

/** An `assistant/message` event as `Session.append` publishes it (the parts `ClosingHeads` reads, and the rest). */
function assistantEvent(content: ContentBlock[], seq = 0): unknown {
  const message = createAssistantMessage({ content, source: { kind: 'model' } as never })
  return { type: 'assistant/message', seq, time: 1, data: { turn: 1, step: 1, message, stream: [] }, surfaceOp: 'append' }
}
const text = (value: string): ContentBlock => ({ type: 'text', text: value })
const call = (name = 'bash'): ContentBlock => ({ type: 'tool-call', id: 'call-1' as never, name, arguments: '{}' })

test('a text message gives its head', () => {
  const heads = new ClosingHeads()
  const session = {}
  heads.observe(session, assistantEvent([text('All done. The tests pass.')]))
  assert.equal(heads.headOf(session), 'All done. The tests pass.')
})

test('leading whitespace is dropped, and the head is the first HEAD_CHARS characters', () => {
  assert.equal(HEAD_CHARS, 200)
  const heads = new ClosingHeads()
  const session = {}
  heads.observe(session, assistantEvent([text('\n\n   BLOCKED: need the key')]))
  assert.equal(heads.headOf(session), 'BLOCKED: need the key')
  assert.equal(optsOut(heads.headOf(session)), true)
  heads.observe(session, assistantEvent([text(`${' '.repeat(5000)}${'a'.repeat(10_000)}`)]))
  assert.equal(heads.headOf(session), 'a'.repeat(200))
})

test('a 10,000-character message keeps 200', () => {
  const heads = new ClosingHeads()
  const session = {}
  const body = 'BLOCKED: '.concat('x'.repeat(10_000))
  heads.observe(session, assistantEvent([text(body)]))
  assert.equal(heads.headOf(session).length, 200)
  assert.equal(heads.headOf(session), body.slice(0, 200))
})

test('several text blocks are joined by a newline', () => {
  const heads = new ClosingHeads()
  const session = {}
  heads.observe(session, assistantEvent([text('first'), call(), text('second')]))
  assert.equal(heads.headOf(session), 'first\nsecond')
  heads.observe(session, assistantEvent([text(''), text('BLOCKED: after an empty block')]))
  assert.equal(optsOut(heads.headOf(session)), true, 'an empty first block does not hide the marker')
  assert.equal(heads.headOf(session), 'BLOCKED: after an empty block')
})

test('a message of only tool calls leaves the head before it', () => {
  const heads = new ClosingHeads()
  const session = {}
  heads.observe(session, assistantEvent([text('I will run the tests.')]))
  heads.observe(session, assistantEvent([call()]))
  assert.equal(heads.headOf(session), 'I will run the tests.')
  heads.observe(session, assistantEvent([{ type: 'reasoning', text: 'thinking' } as ContentBlock]))
  assert.equal(heads.headOf(session), 'I will run the tests.', 'reasoning is not text')
  heads.observe(session, assistantEvent([text('   \n  ')]))
  assert.equal(heads.headOf(session), 'I will run the tests.', 'blank text is not text')
  heads.observe(session, assistantEvent([]))
  assert.equal(heads.headOf(session), 'I will run the tests.')
})

test('a newer text replaces it', () => {
  const heads = new ClosingHeads()
  const session = {}
  heads.observe(session, assistantEvent([text('BLOCKED: first')]))
  heads.observe(session, assistantEvent([text('Fixed it after all.')]))
  assert.equal(heads.headOf(session), 'Fixed it after all.')
  assert.equal(optsOut(heads.headOf(session)), false)
})

test('a turn/start clears the head: a BLOCKED that closed an earlier turn says nothing about the next', () => {
  const heads = new ClosingHeads()
  const session = {}
  heads.observe(session, assistantEvent([text('BLOCKED: need the key')]))
  heads.observe(session, { type: 'turn/start', seq: 9, time: 2, data: { turn: 2 } })
  assert.equal(heads.headOf(session), '')
  // The new turn's last step had only tool calls, or reasoning: still nothing, not the old BLOCKED.
  heads.observe(session, assistantEvent([call()]))
  assert.equal(heads.headOf(session), '')
  assert.equal(optsOut(heads.headOf(session)), false)
  heads.observe(session, assistantEvent([text('Done.')]))
  assert.equal(heads.headOf(session), 'Done.')
})

test('closing: whether the newest message of the turn holds tool calls, beside the head', () => {
  const heads = new ClosingHeads()
  const session = {}
  assert.deepEqual(heads.closing(session), { head: '', toolCalls: false }, 'none seen')
  heads.observe(session, assistantEvent([text('I will run the tests.'), call()]))
  assert.deepEqual(heads.closing(session), { head: 'I will run the tests.', toolCalls: true })
  heads.observe(session, assistantEvent([call()]))
  assert.deepEqual(heads.closing(session), { head: 'I will run the tests.', toolCalls: true }, 'only tool calls: the head stays')
  heads.observe(session, assistantEvent([{ type: 'reasoning', text: 'thinking' } as ContentBlock]))
  assert.deepEqual(heads.closing(session), { head: 'I will run the tests.', toolCalls: false }, 'the newest message counts, text or not')
  heads.observe(session, assistantEvent([call()]))
  heads.observe(session, assistantEvent([text('Done.')]))
  assert.deepEqual(heads.closing(session), { head: 'Done.', toolCalls: false })
  heads.observe(session, assistantEvent([call()]))
  heads.observe(session, { type: 'turn/start', seq: 9, time: 2, data: { turn: 2 } })
  assert.deepEqual(heads.closing(session), { head: '', toolCalls: false }, 'a turn/start clears both')
  heads.observe(session, assistantEvent([call()]))
  heads.observe(session, { type: 'tool/result', seq: 10, time: 3, data: {} })
  assert.equal(heads.closing(session).toolCalls, true, 'other events leave it')
  assert.equal(heads.headOf(session), heads.closing(session).head)
})

test('none seen is the empty string', () => {
  const heads = new ClosingHeads()
  assert.equal(heads.headOf({}), '')
})

test('two sessions are kept apart', () => {
  const heads = new ClosingHeads()
  const a = {}
  const b = {}
  heads.observe(a, assistantEvent([text('BLOCKED: a')]))
  heads.observe(b, assistantEvent([text('b is done')]))
  assert.equal(heads.headOf(a), 'BLOCKED: a')
  assert.equal(heads.headOf(b), 'b is done')
  heads.observe(b, assistantEvent([text('BLOCKED: b')]))
  assert.equal(heads.headOf(a), 'BLOCKED: a')
  assert.equal(heads.headOf({}), '', 'an object it never saw')
})

test('other event types are ignored', () => {
  const heads = new ClosingHeads()
  const session = {}
  heads.observe(session, assistantEvent([text('real head')]))
  const message = createAssistantMessage({ content: [text('NOT a head')], source: { kind: 'model' } as never })
  for (const type of ['user/message', 'tool/result', 'system/message', 'assistant/attempt', 'turn/end', 'step/end', 'assistant/message-ish']) {
    heads.observe(session, { type, seq: 1, time: 1, data: { turn: 1, step: 1, message, stream: [] } })
  }
  assert.equal(heads.headOf(session), 'real head')
})

test('a malformed event is ignored, and observe never throws', () => {
  const heads = new ClosingHeads()
  const session = {}
  heads.observe(session, assistantEvent([text('kept')]))
  const bad: unknown[] = [
    undefined, null, 0, 'assistant/message', [], {},
    { type: 'assistant/message' },
    { type: 'assistant/message', data: null },
    { type: 'assistant/message', data: 'x' },
    { type: 'assistant/message', data: {} },
    { type: 'assistant/message', data: { message: null } },
    { type: 'assistant/message', data: { message: { content: 'text' } } },
    { type: 'assistant/message', data: { message: { content: null } } },
    { type: 'assistant/message', data: { message: { content: [null, 5, 'x', [], {}] } } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text' }] } } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 42 }] } } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: { x: 1 } }] } } },
    { get type(): string { throw new Error('boom') } },
    { type: 'assistant/message', get data(): never { throw new Error('boom') } },
    new Proxy({}, { get() { throw new Error('boom') } }),
  ]
  bad.forEach((event, index) => assert.doesNotThrow(() => heads.observe(session, event), `malformed event ${index}`))
  assert.equal(heads.headOf(session), 'kept')
  assert.doesNotThrow(() => heads.observe(session, assistantEvent([text('after the bad ones')])))
  assert.equal(heads.headOf(session), 'after the bad ones')
})

// --- a coder's report, from dsh-tools' tools/result -------------------------------------------------

/** `tools/result`'s two arguments for a `report` call by `agent`, as dsh-tools' registry gives them (the parts read, and more). */
function reported(agent: unknown, value: unknown = { role: 'coder', turn: 1, at: 1, status: 'done', summary: 'did it' }, over: object = {}): [unknown, unknown] {
  const exec = { callId: 'call-1', rootCallId: 'call-1', name: REPORT_TOOL, arguments: {}, agent, signal: new AbortController().signal }
  const result = { isError: false, value, content: [{ type: 'text', text: 'Report recorded.' }], concludesTurn: true, ...over }
  return [exec, result]
}

test('REPORT_TOOL and REPORT_STATUSES are crew\'s', () => {
  assert.equal(REPORT_TOOL, 'report')
  assert.deepEqual(REPORT_STATUSES, ['done', 'blocked', 'needs_context'])
})

test('toolResult: a successful report that concluded the turn keeps its status for that session', () => {
  for (const status of REPORT_STATUSES) {
    const heads = new ClosingHeads()
    const session = {}
    heads.observe(session, assistantEvent([call('report')]))
    heads.toolResult(...reported({ id: 'c1', session }, { role: 'coder', turn: 1, at: 1, status, summary: 's' }))
    assert.deepEqual(heads.closing(session), { head: '', toolCalls: true, report: status }, status)
  }
})

test('toolResult ignores another tool, an error result, one without concludesTurn, an unknown status, an agent without a session, and malformed arguments', () => {
  const heads = new ClosingHeads()
  const session = {}
  heads.observe(session, assistantEvent([text('Done.'), call('report')]))
  const agent = { id: 'c1', session }
  const [exec, result] = reported(agent)
  const ignored: Array<[unknown, unknown]> = [
    [{ ...exec as object, name: 'bash' }, result],
    [{ ...exec as object, name: 'Report' }, result],
    [exec, { isError: true, error: { message: 'invalid arguments' }, content: [] }],
    [exec, { ...result as object, isError: undefined }],
    [exec, { ...result as object, concludesTurn: undefined }],
    [exec, { ...result as object, concludesTurn: false }],
    [exec, { ...result as object, value: { role: 'coder', status: 'finished' } }],
    [exec, { ...result as object, value: { role: 'reviewer', verdict: 'approved', head: 'a'.repeat(40) } }],
    [exec, { ...result as object, value: null }],
    [exec, { ...result as object, value: 'done' }],
    [{ ...exec as object, agent: undefined }, result],
    [{ ...exec as object, agent: { id: 'c1' } }, result],
    [{ ...exec as object, agent: { id: 'c1', session: null } }, result],
    [{ ...exec as object, agent: { id: 'c1', session: 'not an object' } }, result],
    [undefined, result],
    [null, null],
    [exec, undefined],
    ['report', 'done'],
    [new Proxy({}, { get() { throw new Error('boom') } }), result],
    [exec, new Proxy({}, { get() { throw new Error('boom') } })],
    [{ name: 'report', get agent(): never { throw new Error('boom') } }, result],
  ]
  ignored.forEach(([e, r], index) => {
    assert.doesNotThrow(() => heads.toolResult(e, r), `call ${index}`)
    assert.deepEqual(heads.closing(session), { head: 'Done.', toolCalls: true }, `call ${index}`)
  })
})

test('the next assistant message drops the report, with or without text; turn/start drops it; two sessions are kept apart', () => {
  const heads = new ClosingHeads()
  const a = {}
  const b = {}
  heads.observe(a, assistantEvent([text('Here is my work.'), call('report')]))
  heads.toolResult(...reported({ id: 'a', session: a }))
  assert.equal(heads.closing(a).report, 'done')
  assert.equal(heads.closing(b).report, undefined, 'another session has none')

  heads.observe(a, assistantEvent([call('bash')]))
  assert.deepEqual(heads.closing(a), { head: 'Here is my work.', toolCalls: true }, 'a message of tool calls alone drops it')
  heads.toolResult(...reported({ id: 'a', session: a }, { role: 'coder', turn: 1, at: 1, status: 'blocked', summary: 's', blockedOn: 'x' }))
  assert.equal(heads.closing(a).report, 'blocked')
  heads.observe(a, assistantEvent([text('Fixed it.')]))
  assert.deepEqual(heads.closing(a), { head: 'Fixed it.', toolCalls: false }, 'a message with text drops it')

  heads.toolResult(...reported({ id: 'a', session: a }))
  heads.toolResult(...reported({ id: 'b', session: b }, { role: 'coder', turn: 1, at: 1, status: 'needs_context', summary: 's', blockedOn: 'y' }))
  heads.observe(a, { type: 'turn/start', seq: 9, time: 2, data: { turn: 2 } })
  assert.deepEqual(heads.closing(a), { head: '', toolCalls: false }, 'turn/start drops it')
  assert.equal(heads.closing(b).report, 'needs_context', 'b keeps its own')
})

test('a report keeps the head and toolCalls the session had', () => {
  const heads = new ClosingHeads()
  const session = {}
  heads.observe(session, assistantEvent([text('BLOCKED: an older message')]))
  heads.observe(session, assistantEvent([call('report')]))
  heads.toolResult(...reported({ id: 'c1', session }))
  assert.deepEqual(heads.closing(session), { head: 'BLOCKED: an older message', toolCalls: true, report: 'done' })
  assert.equal(heads.headOf(session), 'BLOCKED: an older message')
  // A session it never saw a message for: the report alone.
  const fresh = {}
  heads.toolResult(...reported({ id: 'c2', session: fresh }))
  assert.deepEqual(heads.closing(fresh), { head: '', toolCalls: false, report: 'done' })
  // A later report replaces an earlier one.
  heads.toolResult(...reported({ id: 'c2', session: fresh }, { role: 'coder', turn: 1, at: 2, status: 'blocked', summary: 's', blockedOn: 'z' }))
  assert.equal(heads.closing(fresh).report, 'blocked')
})

// --- with a real session ----------------------------------------------------------------------------

async function realSessions(): Promise<{ ctx: Context, sessions: SessionStore }> {
  const ctx = new Context()
  disposables.push(await ctx.plugin(SessionStore as never, undefined as never))
  return { ctx, sessions: ctx.get('sessions' as never) as unknown as SessionStore }
}

test('a real session publishes events that give the head, keyed by the session', async () => {
  const { ctx, sessions } = await realSessions()
  const heads = new ClosingHeads()
  let published = 0
  ctx.on('session/event' as never, ((session: Session, event: unknown) => {
    published += 1
    heads.observe(session, event)
  }) as never)
  const first = sessions.create()
  const second = sessions.create()
  const message = (blocks: ContentBlock[]) => createAssistantMessage({ content: blocks, source: { kind: 'model' } as never })
  first.append('assistant/message', { turn: 1, step: 1, message: message([text('  BLOCKED: the schema is missing')]), stream: [] }, { surfaceOp: 'append' })
  second.append('assistant/message', { turn: 1, step: 1, message: message([text('Finished.')]), stream: [] }, { surfaceOp: 'append' })
  first.append('assistant/message', { turn: 1, step: 2, message: message([call()]), stream: [] }, { surfaceOp: 'append' })
  assert.equal(published, 3)
  assert.equal(heads.headOf(first), 'BLOCKED: the schema is missing')
  assert.equal(optsOut(heads.headOf(first)), true)
  assert.equal(heads.headOf(second), 'Finished.')
  first.append('turn/start', { turn: 2 } as never)
  assert.equal(heads.headOf(first), '', 'a new turn starts with no head')
  first.append('assistant/message', { turn: 2, step: 1, message: message([text('Done, with tests.')]), stream: [] }, { surfaceOp: 'append' })
  assert.equal(heads.headOf(first), 'Done, with tests.')
})
