/**
 * The listeners: crew's `dish-crew/delegated` and `dish-crew/settled`, and dish-gates' `dish-gates/result`, turned into the
 * harness's ledger entries.
 */

import assert from 'node:assert/strict'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { test } from 'node:test'
import type { CoderReport, ReviewerReport } from 'dish-crew'
import { createListeners, endedEntries, gateEntry, startedEntry } from '../src/listeners.ts'
import {
  HEAD, MASKED_TOKEN, NOW, SESSION, SHA_C, TOKEN, childRecord, delegated, gateDone, settled, waitFor, world,
} from './service-helpers.ts'

const CODER_REPORT: CoderReport = {
  role: 'coder', turn: 3, at: NOW, status: 'done', summary: 'Fixed the redirect', commits: [HEAD],
  rulings: [{ what: 'kept the cookie', why: 'compat', costIfWrong: 'a round' }],
}
const REVIEWER_REPORT: ReviewerReport = {
  role: 'reviewer', turn: 2, at: NOW, verdict: 'changes_requested', head: HEAD, summary: 'Two things',
  findings: [
    { severity: 'blocking', file: 'src/a.ts', line: 3, summary: 'wrong', fix: 'fix it' },
    { severity: 'nit', file: 'src/b.ts', summary: 'name', fix: 'rename' },
    { severity: 'nit', file: 'src/c.ts', summary: 'name', fix: 'rename' },
  ],
}

test('the pure builders: startedEntry, endedEntries and gateEntry', async () => {
  const w = await world()
  const run = await w.open()
  const child = childRecord({ id: 'r1', role: 'reviewer', reviews: 'c1', final: true, run: w.runs.refOf(run), task: 'fix-login' })
  assert.deepEqual(startedEntry(run, { sessionId: SESSION, child, followUp: true }, undefined, NOW), {
    at: NOW, run: run.id, kind: 'child.started', by: 'harness', session: SESSION, child: 'r1', task: 'fix-login', role: 'reviewer', title: 'Fix it',
    model: 'deepseek-chat', family: 'deepseek', followUp: true, reviews: 'c1', final: true,
  })
  const ended = endedEntries(run, settled(child, { structured: REVIEWER_REPORT, structuredFile: '/r/1-reviewer-1.json' }), HEAD, NOW)
  assert.deepEqual(ended.map(entry => entry.kind), ['child.ended', 'review.verdict'])
  assert.deepEqual(ended[1], {
    at: NOW, run: run.id, kind: 'review.verdict', by: 'harness', session: SESSION, child: 'r1', task: 'fix-login', verdict: 'changes_requested',
    head: HEAD, final: true, findings: { blocking: 1, should_fix: 0, nit: 2 },
  })
  assert.deepEqual(gateEntry(run, gateDone('c1', { outcome: 'error', reason: 'the worktree is gone', head: null, exitCode: null }), 'fix-login', NOW), {
    at: NOW, run: run.id, kind: 'gate.result', by: 'harness', session: SESSION, child: 'c1', task: 'fix-login', outcome: 'error', exitCode: null,
    timedOut: false, durationMs: 1200, log: '/state/gates/acme/widget/fix-login/child-1-1-1.log', head: null, gateTurn: 1, gateRound: 1,
    reason: 'the worktree is gone',
  })
})

test('child.started: a coder\'s start and follow-up on a task, each with its round; the listener returns undefined at once', async () => {
  const w = await world()
  const run = await w.open()
  const l = createListeners(w.runs)
  const tags = { run: w.runs.refOf(run), task: 'fix-login', worktree: run.worktree }
  assert.equal(l.delegated(delegated({ id: 'c1', ...tags })), undefined)
  assert.equal(l.delegated(delegated({ id: 'c1', ...tags, followUps: 1 }, { followUp: true })), undefined)
  await w.ledger.flush()
  const [, first, second] = await w.entries(run)
  assert.deepEqual(first, {
    at: NOW, run: run.id, kind: 'child.started', by: 'harness', session: SESSION, child: 'c1', task: 'fix-login', role: 'coder', title: 'Fix it',
    model: 'deepseek-chat', family: 'deepseek', followUp: false, round: 0,
  })
  assert.equal(second?.kind === 'child.started' && second.followUp, true)
  assert.equal(second?.kind === 'child.started' && second.round, 1)
})

test('child.started: a reviewer with reviews and final, and its follow-up still final (sticky on the record); no round', async () => {
  const w = await world()
  const run = await w.open()
  const l = createListeners(w.runs)
  const reviewer = { id: 'r1', role: 'reviewer', reviews: 'c1', final: true as const, run: w.runs.refOf(run), task: 'fix-login' }
  l.delegated(delegated(reviewer))
  l.delegated(delegated({ ...reviewer, followUps: 1 }, { followUp: true }))
  await w.ledger.flush()
  const started = (await w.entries(run)).filter(entry => entry.kind === 'child.started')
  assert.equal(started.length, 2)
  for (const entry of started) {
    assert.equal(entry.kind === 'child.started' && entry.final, true)
    assert.equal(entry.kind === 'child.started' && entry.reviews, 'c1')
    assert.equal(entry.kind === 'child.started' && 'round' in entry, false)
  }
})

test('child.started: an untagged child and an unknown ref write nothing; the unknown ref is logged once for two events', async () => {
  const w = await world()
  const run = await w.open()
  const l = createListeners(w.runs)
  l.delegated(delegated({ id: 'c1' }))
  l.delegated(delegated({ id: 'c2', run: 'Acme/widget/20260101-gone' }))
  l.delegated(delegated({ id: 'c3', run: 'Acme/widget/20260101-gone' }))
  await w.ledger.flush()
  assert.deepEqual(await w.kinds(run), ['run.opened'])
  assert.equal(w.logs.filter(line => line.includes('20260101-gone')).length, 1, w.logs.join('\n'))
})

test('child.ended: the stop reason, error, report files, the structured report copied, and the head of the child\'s worktree', async () => {
  const w = await world()
  const run = await w.open()
  w.heads.set(run.worktree, SHA_C)
  const l = createListeners(w.runs)
  const child = { id: 'c1', run: w.runs.refOf(run), task: 'fix-login', worktree: run.worktree }
  assert.equal(l.settled(settled(child, { stopReason: 'error', error: 'the model failed', report: '/r/1-coder-1.md', structured: CODER_REPORT, structuredFile: '/r/1-coder-1.json' })), undefined)
  await w.ledger.flush()
  assert.deepEqual((await w.entries(run)).slice(1), [{
    at: NOW, run: run.id, kind: 'child.ended', by: 'harness', session: SESSION, child: 'c1', task: 'fix-login', role: 'coder', stopReason: 'error',
    error: 'the model failed', reportFile: '/r/1-coder-1.md', structuredFile: '/r/1-coder-1.json', report: CODER_REPORT, head: SHA_C,
  }])
  assert.deepEqual(w.workspaces.calls.headOf, [[run.worktree]])
})

test('child.ended: a reviewer\'s head comes from its task\'s path; headOf rejecting is null; no structured report, none', async () => {
  const w = await world()
  const run = await w.open()
  const l = createListeners(w.runs)
  const reviewer = { id: 'r1', role: 'reviewer', reviews: 'c1', run: w.runs.refOf(run), task: 'fix-login' }
  l.settled(settled(reviewer))
  await w.ledger.flush()
  const [, ended] = await w.entries(run)
  assert.equal(ended?.kind === 'child.ended' && ended.head, HEAD)
  assert.equal(ended !== undefined && 'report' in ended, false)
  assert.equal(ended !== undefined && 'structuredFile' in ended, false)
  w.workspaces.impl.headOf = async () => { throw new Error('git broke') }
  l.settled(settled(reviewer))
  await w.ledger.flush()
  const again = (await w.entries(run)).at(-1)
  assert.equal(again?.kind === 'child.ended' && again.head, null)
  // A child with no worktree and no task: no head to read.
  l.settled(settled({ id: 'u1', run: w.runs.refOf(run) }))
  await w.ledger.flush()
  const unbound = (await w.entries(run)).at(-1)
  assert.equal(unbound?.kind === 'child.ended' && unbound.head, null)
})

test('review.verdict: the counts by severity, with final true and false; a coder\'s report makes none', async () => {
  const w = await world()
  const run = await w.open()
  const l = createListeners(w.runs)
  const tags = { run: w.runs.refOf(run), task: 'fix-login' }
  l.settled(settled({ id: 'r1', role: 'reviewer', reviews: 'c1', final: true, ...tags }, { structured: REVIEWER_REPORT }))
  l.settled(settled({ id: 'r2', role: 'reviewer', reviews: 'c1', ...tags }, { structured: { ...REVIEWER_REPORT, verdict: 'approved', findings: [] } }))
  l.settled(settled({ id: 'c1', ...tags, worktree: run.worktree }, { structured: CODER_REPORT }))
  await w.ledger.flush()
  const verdicts = (await w.entries(run)).filter(entry => entry.kind === 'review.verdict')
  assert.deepEqual(verdicts.map(entry => entry.kind === 'review.verdict' && [entry.child, entry.verdict, entry.final, entry.findings]), [
    ['r1', 'changes_requested', true, { blocking: 1, should_fix: 0, nit: 2 }],
    ['r2', 'approved', false, { blocking: 0, should_fix: 0, nit: 0 }],
  ])
})

test('gate.result: tags from the index; after a restart, through crew\'s lookup; an untagged child writes nothing', async () => {
  const w = await world()
  const run = await w.open()
  const l = createListeners(w.runs)
  l.delegated(delegated({ id: 'c1', run: w.runs.refOf(run), task: 'fix-login', worktree: run.worktree }))
  assert.equal(l.gateResult(gateDone('c1', { outcome: 'failed', exitCode: 1 })), undefined)
  await w.ledger.flush()
  const gate = (await w.entries(run)).at(-1)
  assert.deepEqual(gate, {
    at: NOW, run: run.id, kind: 'gate.result', by: 'harness', session: SESSION, child: 'c1', task: 'fix-login', outcome: 'failed', exitCode: 1,
    timedOut: false, durationMs: 1200, log: '/state/gates/acme/widget/fix-login/child-1-1-1.log', head: HEAD, gateTurn: 1, gateRound: 1,
  })
  assert.deepEqual(w.crew.calls.lookup, [])

  await w.restart()
  const after = createListeners(w.runs)
  w.children.set('c1', { sessionId: SESSION, record: childRecord({ id: 'c1', run: w.runs.refOf(run), task: 'fix-login' }) })
  after.gateResult(gateDone('c1', { round: 2 }))
  await waitFor('the gate after a restart', async () => (await w.kinds(run)).filter(kind => kind === 'gate.result').length === 2)
  assert.deepEqual(w.crew.calls.lookup, [['c1']])
  // A child crew has, untagged, and one it doesn't have: nothing.
  w.children.set('u1', { sessionId: SESSION, record: childRecord({ id: 'u1' }) })
  after.gateResult(gateDone('u1'))
  after.gateResult(gateDone('nobody'))
  await new Promise(settle => setTimeout(settle, 50))
  assert.equal((await w.kinds(run)).filter(kind => kind === 'gate.result').length, 2)
})

test('masking: a token in a coder\'s summary is masked in the ledger file; every entry the listeners write is by the harness', async () => {
  const w = await world()
  const run = await w.open()
  const l = createListeners(w.runs)
  const tags = { id: 'c1', run: w.runs.refOf(run), task: 'fix-login', worktree: run.worktree }
  l.delegated(delegated(tags))
  l.gateResult(gateDone('c1'))
  l.settled(settled(tags, { structured: { ...CODER_REPORT, summary: `pushed with ${TOKEN}` } }))
  await w.ledger.flush()
  const text = await readFile(w.ledger.file(run.project, run.id), 'utf8')
  assert.equal(text.includes(TOKEN), false)
  assert.ok(text.includes(MASKED_TOKEN))
  const entries = await w.entries(run)
  assert.deepEqual(entries.map(entry => entry.kind), ['run.opened', 'child.started', 'gate.result', 'child.ended'])
  assert.ok(entries.every(entry => entry.by === 'harness'))
})

test('failures: an append that fails (the ledger\'s directory replaced by a file) is logged, and the listener returns', async () => {
  const w = await world()
  const run = await w.open()
  const directory = dirname(w.ledger.file(run.project, run.id))
  await rm(directory, { recursive: true })
  await writeFile(directory, 'not a directory')
  // A new ledger, so the file isn't one this process already appended to.
  await w.restart()
  const l = createListeners(w.runs)
  assert.equal(l.delegated(delegated({ id: 'c1', run: w.runs.refOf(run), task: 'fix-login' })), undefined)
  assert.equal(l.settled(settled({ id: 'c1', run: w.runs.refOf(run), task: 'fix-login' })), undefined)
  await w.ledger.flush()
  await waitFor('the failures to be logged', () => w.logs.filter(line => line.startsWith('warn:') && /ENOTDIR|EEXIST|not a directory/i.test(line)).length >= 1)
})

test('a listener whose payload is malformed returns, and logs, and throws nothing', async () => {
  const w = await world()
  const l = createListeners(w.runs)
  assert.equal(l.delegated(null as never), undefined)
  assert.equal(l.settled({ child: { run: 42 } } as never), undefined)
  assert.equal(l.gateResult({} as never), undefined)
})
