/**
 * What the Decisions table makes of log lines, with no page around it: the reading of each line (what Jev answered, in words),
 * how decisions are toned, and how the lines of one tool call are grouped. Every function here gives plain strings: what the
 * lines say is written by agents and web pages, and the page shows it as text.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { KNOWN_DECISIONS, PURPOSES, decisionTone, groupLines, readingOf } from '../src/client/decisions.ts'
import { milliseconds, probability, shortAgent, sourceLabel } from '../src/client/format.ts'
import type { LogLine } from '../src/protocol.ts'

function line(overrides: Partial<LogLine> = {}): LogLine {
  return { at: 1_000, purpose: 'command', subject: 'git status', answers: {}, decision: 'allow', latencyMs: 100, error: null, ...overrides }
}

const EFFECT = {
  type: 'choice', choice: 'reversible', probabilities: { read_only: 0.05, reversible: 0.9, irreversible: 0.04, other: 0.01 }, confidence: 0.8,
}

test('a command line reads as the effect Jev chose with its probability, and whether the command serves the task', () => {
  const parts = readingOf(line({ answers: { effect: EFFECT, serves_task: { type: 'noul', noul: 0.912 } } }))
  assert.deepEqual(parts, [
    { label: 'effect', text: 'reversible (0.90)', detail: 'reversible 0.90, read_only 0.05, irreversible 0.04, other 0.01, confidence 0.80' },
    { label: 'serves the task', text: 'p 0.91' },
  ])
})

test('the probabilities in the detail are in order, highest first, and ties keep Jev\'s order', () => {
  const parts = readingOf(line({ answers: { effect: { type: 'choice', choice: 'a', probabilities: { c: 0.2, a: 0.4, b: 0.2, d: 0.2 }, confidence: 0.5 } } }))
  assert.equal(parts[0]!.detail, 'a 0.40, c 0.20, b 0.20, d 0.20, confidence 0.50')
})

test('a score reads as its place on the scale; a screen\'s chunks each read as their own noul', () => {
  assert.deepEqual(readingOf(line({ purpose: 'ask', answers: { quality: { type: 'score', score: 3.46, probabilities: { 3: 0.6, 4: 0.4 }, confidence: 0.9 } } })), [
    { label: 'quality', text: 'score 3.46', detail: '3 0.60, 4 0.40, confidence 0.90' },
  ])
  assert.deepEqual(readingOf(line({ purpose: 'screen', answers: { content_0: { type: 'noul', noul: 0.04 }, content_1: { type: 'noul', noul: 0.96 } } })), [
    { label: 'content_0', text: 'p 0.04' },
    { label: 'content_1', text: 'p 0.96' },
  ])
})

test('a line whose answers were cut to fit has the bare values, and they read too', () => {
  assert.deepEqual(readingOf(line({ answersCut: true, answers: { effect: { type: 'choice', choice: 'irreversible', confidence: 0.7 }, serves_task: { type: 'noul', noul: 0.3 }, third: 0.25, fourth: 'hello', fifth: true, sixth: null } })), [
    { label: 'effect', text: 'irreversible', detail: 'confidence 0.70' },
    { label: 'serves the task', text: 'p 0.30' },
    { label: 'third', text: '0.25' },
    { label: 'fourth', text: 'hello' },
    { label: 'fifth', text: 'true' },
    { label: 'sixth', text: '—' },
  ])
  assert.deepEqual(readingOf(line({ answersCut: true, answers: {} })), [])
})

test('no answers is no reading', () => {
  assert.deepEqual(readingOf(line({ answers: {}, error: 'Jev said no', decision: null })), [])
})

test('answers of a shape nobody gave it are shown, not thrown at: any JSON reads as something', () => {
  const odd: Array<[string, unknown]> = [
    ['list', [1, 2, 3]],
    ['nested', { deep: { deeper: [1, { x: 2 }] } }],
    ['empty object', {}],
    ['choice without a choice', { type: 'choice', probabilities: {} }],
    ['choice with odd probabilities', { type: 'choice', choice: 'x', probabilities: { x: 'high', y: null, z: [1] }, confidence: 'sure' }],
    ['noul that is not a number', { type: 'noul', noul: 'yes' }],
    ['score that is not a number', { type: 'score', score: null }],
    ['probabilities that is a list', { type: 'choice', choice: 'x', probabilities: [0.5, 0.5] }],
    ['a long string', 'x'.repeat(5000)],
  ]
  for (const [name, answer] of odd) {
    const parts = readingOf(line({ answers: { [name]: answer } as LogLine['answers'] }))
    assert.equal(parts.length, 1, name)
    assert.equal(typeof parts[0]!.label, 'string')
    assert.equal(typeof parts[0]!.text, 'string')
    assert.ok(parts[0]!.text.length <= 130, `${name}: ${parts[0]!.text.length}`)
    if (parts[0]!.detail !== undefined) assert.ok(parts[0]!.detail.length <= 1_000, name)
  }
})

test('text that tries to be HTML stays text: the reading is plain strings, with nothing in them taken away or added', () => {
  const html = '<img src=x onerror="alert(1)">'
  const parts = readingOf(line({ answers: { [html]: { type: 'choice', choice: html, probabilities: { [html]: 0.9, '</b>': 0.1 }, confidence: 0.5 } } }))
  assert.equal(parts[0]!.label, html)
  assert.ok(parts[0]!.text.includes(html))
  assert.ok(parts[0]!.detail!.includes(html))
})

test('the known decisions are the ones the judge writes, and decisions are toned by what they mean for the person', () => {
  assert.deepEqual(KNOWN_DECISIONS, [
    'allow', 'ask', 'deny', 'cancel', 'pass', 'allowed-once', 'rejected', 'withhold', 'warn', 'not-screened', 'split', 'answered', 'refused', 'unavailable', 'too-big', 'test',
  ])
  assert.deepEqual(PURPOSES, ['command', 'approval', 'screen', 'ask'])
  for (const decision of ['allow', 'allowed-once', 'answered']) assert.equal(decisionTone(decision, 'command'), 'success', decision)
  for (const decision of ['ask', 'warn', 'not-screened', 'split']) assert.equal(decisionTone(decision, 'command'), 'warning', decision)
  for (const decision of ['deny', 'withhold', 'rejected', 'refused', 'unavailable', 'too-big']) assert.equal(decisionTone(decision, 'command'), 'danger', decision)
  for (const decision of ['cancel', 'test', 'something-new', '']) assert.equal(decisionTone(decision, 'command'), 'neutral', decision)
  assert.equal(decisionTone(null, 'command'), 'neutral')
  // `pass` is two things: the screen found nothing, or the judge passed the question on to you.
  assert.equal(decisionTone('pass', 'screen'), 'success')
  assert.equal(decisionTone('pass', 'approval'), 'neutral')
})

test('lines of one tool call are grouped, at the place of the newest one, with the others in their order', () => {
  const a = line({ at: 9, callId: 'call-a', agent: 's1', subject: 'a-newest' })
  const b = line({ at: 8, subject: 'b-no-call' })
  const c = line({ at: 7, callId: 'call-c', agent: 's1', subject: 'c-only' })
  const a2 = line({ at: 6, callId: 'call-a', agent: 's1', subject: 'a-older' })
  const d = line({ at: 5, callId: '', subject: 'd-empty-call' })
  const a3 = line({ at: 4, callId: 'call-a', agent: 's1', subject: 'a-oldest' })
  const groups = groupLines([a, b, c, a2, d, a3])
  assert.deepEqual(groups.map(group => group.lines.map(l => l.subject)), [['a-newest', 'a-older', 'a-oldest'], ['b-no-call'], ['c-only'], ['d-empty-call']])
  assert.deepEqual(groups.map(group => group.callId), ['call-a', undefined, 'call-c', undefined])
  assert.equal(new Set(groups.map(group => group.key)).size, 4, 'every group has its own key')
})

test('a call id belongs to one agent: the same id from two agents is two groups', () => {
  const groups = groupLines([line({ callId: 'c1', agent: 's1' }), line({ callId: 'c1', agent: 's2' }), line({ callId: 'c1', agent: 's1' }), line({ callId: 'c1' })])
  assert.deepEqual(groups.map(group => group.lines.length), [2, 1, 1])
})

test('a command and its approval share a call id, so they are one group; the group keys do not change as older lines are added at the end', () => {
  const command = line({ purpose: 'command', callId: 'c1', agent: 's1', decision: 'allow' })
  const approval = line({ purpose: 'approval', callId: 'c1', agent: 's1', decision: 'allowed-once' })
  const first = groupLines([approval, command])
  assert.equal(first.length, 1)
  const older = line({ purpose: 'command', callId: 'c0', agent: 's1' })
  const second = groupLines([approval, command, older])
  assert.equal(second[0]!.key, first[0]!.key)
  assert.equal(second.length, 2)
})

test('no lines, no groups', () => {
  assert.deepEqual(groupLines([]), [])
})

test('probabilities, latencies and agents are said briefly, and what is not a number is shown as it is', () => {
  assert.equal(probability(0.9), '0.90')
  assert.equal(probability(1), '1.00')
  assert.equal(probability(0.123456), '0.12')
  assert.equal(probability('high'), 'high')
  assert.equal(probability(null), 'null')
  assert.equal(probability(NaN), 'NaN')
  assert.equal(milliseconds(312.4), '312 ms')
  assert.equal(milliseconds(null), '—')
  assert.equal(milliseconds(undefined), '—')
  assert.equal(milliseconds(NaN), '—')
  assert.equal(shortAgent('0123456789abcdef'), '01234567')
  assert.equal(shortAgent('main'), 'main')
})

test('where a credential comes from is said in words, and a source this page has not heard of as dsh names it', () => {
  assert.equal(sourceLabel('env'), 'the environment dsh was started in')
  assert.equal(sourceLabel('file'), 'dsh\'s credential file')
  assert.equal(sourceLabel('dotenv'), 'the "dotenv" source')
  assert.equal(sourceLabel(undefined), 'somewhere dsh can\'t change')
})
