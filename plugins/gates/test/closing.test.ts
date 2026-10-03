import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import { ClosingHeads, HEAD_CHARS, OPT_OUT, optsOut } from '../src/closing.ts'

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
  first.append('assistant/message', { turn: 2, step: 1, message: message([text('Done, with tests.')]), stream: [] }, { surfaceOp: 'append' })
  assert.equal(heads.headOf(first), 'Done, with tests.')
})
