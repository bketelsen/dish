import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CLOSING_RULINGS, closingRulings, closingRulingsBlock, gateAt, latestFinal, nextRound, openTasks, sameHead, summarize, taskOfChild } from '../src/derive.ts'
import type { RunSummary } from '../src/derive.ts'
import type { LedgerEntry } from '../src/entries.ts'
import { everyKind, MASKED_TOKEN, MINUTE, NOW, run, SHA_A, SHA_B, SHA_C, TOKEN } from './helpers.ts'

const ID = '20261003-fix-login'
const at = (minute: number): number => NOW + minute * MINUTE

function started(child: string, role: string, task: string | undefined, minute: number, more: Record<string, unknown> = {}): LedgerEntry {
  return {
    at: at(minute), run: ID, kind: 'child.started', by: 'harness', session: 'session-1', child, role, title: `${role} ${child}`,
    model: 'm', family: 'f', followUp: false, ...(task === undefined ? {} : { task }), ...more,
  } as LedgerEntry
}

function ended(child: string, role: string, task: string | undefined, minute: number, more: Record<string, unknown> = {}): LedgerEntry {
  return {
    at: at(minute), run: ID, kind: 'child.ended', by: 'harness', session: 'session-1', child, role, stopReason: 'completed',
    reportFile: `/r/${child}.md`, head: SHA_B, ...(task === undefined ? {} : { task }), ...more,
  } as LedgerEntry
}

function gate(child: string, task: string | undefined, head: string | null, minute: number, outcome = 'passed'): LedgerEntry {
  return {
    at: at(minute), run: ID, kind: 'gate.result', by: 'harness', session: 'session-1', child, outcome, exitCode: outcome === 'passed' ? 0 : 1,
    timedOut: false, durationMs: 10, log: `/logs/${minute}.log`, head, gateTurn: 1, gateRound: 1, ...(task === undefined ? {} : { task }),
  } as LedgerEntry
}

function verdict(child: string, task: string | undefined, head: string, final: boolean, minute: number, value: 'approved' | 'changes_requested' = 'approved'): LedgerEntry {
  return {
    at: at(minute), run: ID, kind: 'review.verdict', by: 'harness', session: 'session-1', child, verdict: value, head, final,
    findings: { blocking: 0, should_fix: 1, nit: 2 }, ...(task === undefined ? {} : { task }),
  } as LedgerEntry
}

function taskOpened(task: string, minute: number, path = `/work/Acme/widget/.worktrees/${task}`): LedgerEntry {
  return { at: at(minute), run: ID, kind: 'task.opened', by: 'harness', session: 'session-1', task, path, branch: `dish/${task}`, base: 'dish/fix-login', baseCommit: SHA_A }
}

function taskRemoved(task: string, minute: number): LedgerEntry {
  return { at: at(minute), run: ID, kind: 'task.removed', by: 'harness', task }
}

/** The main agent's `ruling`, on `task` when given. */
function mainRuling(what: string, minute: number, task?: string, more: Record<string, unknown> = {}): LedgerEntry {
  return {
    at: at(minute), run: ID, kind: 'ruling', by: 'main', session: 'session-1', what, why: 'why', costIfWrong: 'cost', ...(task === undefined ? {} : { task }), ...more,
  } as LedgerEntry
}

/** A coder's `child.ended` whose report holds `rulings`. */
function coderEnded(child: string, task: string | undefined, minute: number, rulings: unknown[]): LedgerEntry {
  return ended(child, 'coder', task, minute, { report: { role: 'coder', turn: 1, at: 0, status: 'done', summary: 'done', rulings } })
}

test('nextRound counts the coder starts and follow-ups on the task only', () => {
  const entries = [
    started('c1', 'coder', 'api', 1),
    started('c1', 'coder', 'api', 2, { followUp: true, round: 1 }),
    started('r1', 'reviewer', 'api', 3, { reviews: 'c1' }),
    started('c2', 'coder', 'ui', 4),
    started('c3', 'coder', undefined, 5),
    started('c4', 'coder', 'api', 6, { round: 2 }),
  ]
  assert.equal(nextRound(entries, 'api'), 3)
  assert.equal(nextRound(entries, 'ui'), 1)
  assert.equal(nextRound(entries, 'docs'), 0)
  assert.equal(nextRound([], 'api'), 0)
})

test('nextRound counts only what the harness wrote', () => {
  const forged = { ...started('c9', 'coder', 'api', 1), by: 'main' } as unknown as LedgerEntry
  assert.equal(nextRound([forged, started('c1', 'coder', 'api', 2)], 'api'), 1)
})

test('taskOfChild is the newest child.started\'s task', () => {
  const entries = [started('c1', 'coder', 'api', 1), started('c2', 'coder', 'ui', 2), started('c1', 'coder', 'ui', 3, { followUp: true })]
  assert.equal(taskOfChild(entries, 'c1'), 'ui')
  assert.equal(taskOfChild(entries, 'c2'), 'ui')
  assert.equal(taskOfChild(entries, 'c3'), undefined)
  assert.equal(taskOfChild([started('c1', 'coder', 'api', 1), started('c1', 'coder', undefined, 2, { followUp: true })], 'c1'), undefined)
})

test('openTasks: the run\'s own first, then each task.opened, without the removed ones', () => {
  const entries = [taskOpened('api', 1), taskOpened('ui', 2), taskRemoved('api', 3), taskOpened('docs', 4)]
  assert.deepEqual([...openTasks(run(), entries)], [
    ['fix-login', '/work/Acme/widget/.worktrees/fix-login'],
    ['ui', '/work/Acme/widget/.worktrees/ui'],
    ['docs', '/work/Acme/widget/.worktrees/docs'],
  ])
  // A slug made again after its removal is open again, at its new path.
  assert.equal(openTasks(run(), [...entries, taskOpened('api', 5, '/elsewhere/api')]).get('api'), '/elsewhere/api')
  // The run's own worktree, removed (the sweep, after a merge), is gone too.
  assert.deepEqual([...openTasks(run(), [taskRemoved('fix-login', 1)]).keys()], [])
  // A removal before the task was opened doesn't count.
  assert.deepEqual([...openTasks(run(), [taskRemoved('api', 1), taskOpened('api', 2)]).keys()], ['fix-login', 'api'])
})

test('latestFinal is the newest final verdict', () => {
  const entries = [
    verdict('r1', 'api', SHA_A, true, 1, 'changes_requested'),
    verdict('r1', 'api', SHA_B, true, 2),
    verdict('r2', 'api', SHA_C, false, 3),
  ]
  assert.deepEqual(latestFinal(entries), {
    child: 'r1', verdict: 'approved', head: SHA_B, final: true, at: at(2), findings: { blocking: 0, should_fix: 1, nit: 2 },
  })
  assert.equal(latestFinal([verdict('r2', 'api', SHA_C, false, 3)]), undefined)
  assert.equal(latestFinal([]), undefined)
})

test('latestFinal: a final verdict without a head (a review of work outside git) is the latest, and no head matches it', () => {
  const { head: _head, ...headless } = verdict('r2', 'api', SHA_B, true, 3) as unknown as Record<string, unknown>
  const entries = [verdict('r1', 'api', SHA_B, true, 2), headless as unknown as LedgerEntry]
  const final = latestFinal(entries)
  assert.deepEqual(final, { child: 'r2', verdict: 'approved', final: true, at: at(3), findings: { blocking: 0, should_fix: 1, nit: 2 } })
  // The approval of SHA_B before it doesn't count: the latest final review is the one without a head.
  assert.equal(sameHead(final!.head, SHA_B), false)
  assert.equal(summarize(run(), entries).finalReview?.child, 'r2')
  // A head that isn't a string is a malformed entry, passed over as before.
  assert.equal(latestFinal([verdict('r1', 'api', SHA_B, true, 2), { ...headless, head: 5 } as unknown as LedgerEntry])!.child, 'r1')
})

test('gateAt is the newest gate.result at that head', () => {
  const entries = [gate('c1', 'api', SHA_A, 1), gate('c1', 'api', SHA_B, 2, 'failed'), gate('c1', 'api', SHA_B, 3), gate('c1', 'api', null, 4), gate('c1', 'api', SHA_A, 5, 'failed')]
  assert.deepEqual(gateAt(entries, SHA_B), { child: 'c1', outcome: 'passed', exitCode: 0, head: SHA_B, at: at(3), log: '/logs/3.log' })
  assert.equal(gateAt(entries, SHA_B.slice(0, 7)), undefined, 'a prefix is no head')
  assert.equal(gateAt(entries, SHA_A)!.outcome, 'failed')
  assert.equal(gateAt(entries, SHA_C), undefined)
})

test('sameHead', () => {
  const full = '0123456789abcdef0123456789abcdef01234567'
  assert.equal(sameHead(full, full), true)
  assert.equal(sameHead(full, full.toUpperCase()), true)
  // Full shas only (correction 6): an abbreviated one could match another commit.
  assert.equal(sameHead(full, full.slice(0, 7)), false, 'a prefix')
  assert.equal(sameHead(full.slice(0, 7), full), false, 'a prefix')
  assert.equal(sameHead(full.slice(0, 7), full.slice(0, 7)), false, 'two equal prefixes')
  assert.equal(sameHead(full, full.slice(0, 39)), false, '39 characters')
  assert.equal(sameHead(full, full.slice(0, 6)), false, '6 characters')
  assert.equal(sameHead(full, `${full.slice(0, 39)}z`), false, 'not hex')
  assert.equal(sameHead('zzzzzzz', 'zzzzzzz'), false, 'not hex')
  assert.equal(sameHead(full, 'f'.repeat(40)), false, 'different')
  assert.equal(sameHead(full, `${full.slice(0, 8)}0`), false, 'a different prefix')
  assert.equal(sameHead('a'.repeat(64), 'A'.repeat(64)), true, 'sha-256')
  assert.equal(sameHead('a'.repeat(64), 'a'.repeat(40)), false, 'a sha-1 isn\'t a sha-256\'s prefix')
  assert.equal(sameHead('a'.repeat(65), 'a'.repeat(65)), false, 'longer than 64')
  assert.equal(sameHead(null, full), false)
  assert.equal(sameHead(undefined, undefined), false)
  assert.equal(sameHead(42, 42), false)
})

test('summarize, over a ledger of every kind, gives the documented views', () => {
  const summary = summarize(run(), everyKind(ID))
  const url = 'https://github.com/Acme/widget/pull/7'
  const expected: RunSummary = {
    tasks: [
      { task: 'fix-login', own: true, path: '/work/Acme/widget/.worktrees/fix-login', removed: false, rounds: 0 },
      {
        task: 'api', own: false, path: '/work/Acme/widget/.worktrees/api', removed: true, rounds: 1,
        coder: { child: 'c1', at: at(4), ended: true, stopReason: 'completed', status: 'done', summary: 'Fixed the redirect' },
        gate: { child: 'c1', outcome: 'passed', exitCode: 0, head: SHA_B, at: at(5), log: '/logs/gate-1.log' },
        verdict: { child: 'r1', verdict: 'approved', head: SHA_B, final: true, at: at(9), findings: { blocking: 0, should_fix: 0, nit: 1 } },
      },
    ],
    finalReview: { child: 'r1', verdict: 'approved', head: SHA_B, final: true, at: at(9), findings: { blocking: 0, should_fix: 0, nit: 1 } },
    rulings: [
      { at: at(11), by: 'harness', source: 'ladder', text: 'one more round — close — an hour', task: 'api' },
      { at: at(12), by: 'main', source: 'ruling', text: 'skip the e2e — flaky — a regression', task: 'api' },
    ],
    deferred: [{ at: at(13), what: 'rename helper', where: 'src/a.ts', why: 'out of scope' }],
    notes: [{ at: at(14), text: 'waiting on the user' }],
    pr: {
      checked: { at: at(15), head: SHA_B, result: 'pass' },
      opened: { at: at(16), url, number: 7, head: SHA_B },
      updated: { at: at(22), url, number: 7, head: SHA_C },
      feedback: { at: at(20), number: 7, reviews: 3, comments: 6, failedChecks: 1 },
    },
  }
  assert.deepEqual(summary, expected)
})

test('summarize: an empty ledger has the run\'s own task and nothing else', () => {
  assert.deepEqual(summarize(run(), []), {
    tasks: [{ task: 'fix-login', own: true, path: '/work/Acme/widget/.worktrees/fix-login', removed: false, rounds: 0 }],
    rulings: [],
    deferred: [],
    notes: [],
  })
})

test('summarize: the coder is the newest start, ended only by an end after it; the gate and verdict are the task\'s newest', () => {
  const entries = [
    started('c1', 'coder', 'fix-login', 1),
    ended('c1', 'coder', 'fix-login', 2, { report: { role: 'coder', turn: 1, at: 0, status: 'blocked', summary: 'stuck', blockedOn: 'a key' } }),
    gate('c1', 'fix-login', SHA_A, 3, 'failed'),
    gate('c9', 'other', SHA_C, 4),
    started('c1', 'coder', 'fix-login', 5, { followUp: true }),
    verdict('r1', 'fix-login', SHA_A, false, 6, 'changes_requested'),
    verdict('r9', 'other', SHA_C, true, 7),
  ]
  const [own] = summarize(run(), entries).tasks
  assert.deepEqual(own, {
    task: 'fix-login', own: true, path: '/work/Acme/widget/.worktrees/fix-login', removed: false, rounds: 2,
    coder: { child: 'c1', at: at(5), ended: false },
    gate: { child: 'c1', outcome: 'failed', exitCode: 1, head: SHA_A, at: at(3), log: '/logs/3.log' },
    verdict: { child: 'r1', verdict: 'changes_requested', head: SHA_A, final: false, at: at(6), findings: { blocking: 0, should_fix: 1, nit: 2 } },
  })
  const settled = summarize(run(), [...entries, ended('c1', 'coder', 'fix-login', 8, { stopReason: 'error', error: 'boom' })])
  assert.deepEqual(settled.tasks[0]!.coder, { child: 'c1', at: at(5), ended: true, stopReason: 'error' })
  // A reviewer's report says nothing of the coder.
  assert.equal(summarize(run(), [started('c1', 'coder', 'fix-login', 1), ended('c1', 'coder', 'fix-login', 2, {
    report: { role: 'reviewer', turn: 1, at: 0, verdict: 'approved', head: SHA_A, summary: 'x', findings: [] },
  })]).tasks[0]!.coder!.status, undefined)
})

test('summarize: a pr.checked\'s overrides are rulings, gate first; with no checks pr.feedback\'s failedChecks is null', () => {
  const entries: LedgerEntry[] = [
    { at: at(1), run: ID, kind: 'pr.checked', by: 'harness', session: 's', head: SHA_A, gate: null, final: null, gateOk: false, reviewOk: false,
      overrides: { review: 'no reviewer — trivial — a bug', gate: 'flaky — known — a revert' }, result: 'pass' },
    { at: at(2), run: ID, kind: 'pr.feedback', by: 'harness', session: 's', number: 3, state: 'open', merged: false, mergeable: null,
      reviews: { approved: 1, changesRequested: 0, commented: 0, other: 1 }, reviewComments: 0, outdated: 0, issueComments: 5, checks: null },
  ]
  const summary = summarize(run(), entries)
  assert.deepEqual(summary.rulings, [
    { at: at(1), by: 'harness', source: 'pr', text: 'gate: flaky — known — a revert' },
    { at: at(1), by: 'harness', source: 'pr', text: 'review: no reviewer — trivial — a bug' },
  ])
  assert.deepEqual(summary.pr, {
    checked: { at: at(1), head: SHA_A, result: 'pass' },
    feedback: { at: at(2), number: 3, reviews: 2, comments: 5, failedChecks: null },
  })
})

test('malformed fields are passed over without a throw', () => {
  const entries = [
    started('c1', 'coder', 'fix-login', 1, { round: 'x' }),
    { ...verdict('r1', 'fix-login', SHA_A, true, 2), findings: null } as unknown as LedgerEntry,
    { ...gate('c1', 'fix-login', SHA_A, 3), exitCode: 'zero' } as unknown as LedgerEntry,
    { ...taskOpened('api', 4), path: 42 } as unknown as LedgerEntry,
    { at: at(5), run: ID, kind: 'ruling', by: 'main', what: 'x' } as unknown as LedgerEntry,
    { at: at(6), run: ID, kind: 'deferred', by: 'main', what: 1, where: 'w', why: 'y' } as unknown as LedgerEntry,
    { at: at(7), run: ID, kind: 'note', by: 'main', text: ['x'] } as unknown as LedgerEntry,
    { at: at(8), run: ID, kind: 'pr.checked', by: 'harness', head: SHA_A, result: 'maybe', overrides: 'none' } as unknown as LedgerEntry,
    { at: at(9), run: ID, kind: 'pr.opened', by: 'harness', url: 'u', number: '7', head: SHA_A } as unknown as LedgerEntry,
    { at: at(10), run: ID, kind: 'pr.feedback', by: 'harness', number: 7, reviews: null, reviewComments: 1, issueComments: 1, checks: null } as unknown as LedgerEntry,
    { at: at(11), run: ID, kind: 'ladder.ruled', by: 'harness', task: 'fix-login', round: 5, ruling: 7 } as unknown as LedgerEntry,
    { at: at(12), run: ID, kind: 'child.ended', by: 'harness', child: 'c1', role: 'coder', stopReason: 3, report: 'done' } as unknown as LedgerEntry,
    { at: at(13), run: ID, kind: 'from.the.future', by: 'harness', anything: true } as unknown as LedgerEntry,
    { at: at(14), run: ID, kind: 'task.removed', by: 'harness' } as unknown as LedgerEntry,
  ]
  // The round isn't read: the start still counts.
  assert.equal(nextRound(entries, 'fix-login'), 1)
  assert.equal(latestFinal(entries), undefined)
  assert.equal(gateAt(entries, SHA_A), undefined)
  assert.deepEqual([...openTasks(run(), entries).keys()], ['fix-login'])
  const summary = summarize(run(), entries)
  assert.deepEqual(summary, {
    tasks: [{ task: 'fix-login', own: true, path: '/work/Acme/widget/.worktrees/fix-login', removed: false, rounds: 1, coder: { child: 'c1', at: at(1), ended: false } }],
    rulings: [],
    deferred: [],
    notes: [],
  })
})

test('closingRulings: every kind, oldest first, coders\' with their task', () => {
  // everyKind: a coder's report ruling on api, then the ladder's ruling and the main agent's.
  assert.deepEqual(closingRulings(everyKind(ID)), [
    'kept the old cookie — compat — one more round (coder, api)',
    'api: one more round — close — an hour',
    'api: skip the e2e — flaky — a regression',
  ])
  // `run` `status`'s rulings are as they were: no coder's.
  assert.deepEqual(summarize(run(), everyKind(ID)).rulings.map(view => view.text), ['one more round — close — an hour', 'skip the e2e — flaky — a regression'])
  const entries: LedgerEntry[] = [
    mainRuling('kept the old cookie', 1),
    coderEnded('c1', undefined, 2, [{ what: 'a', why: 'b', costIfWrong: 'c' }, { what: 1, why: 'b', costIfWrong: 'c' }, 'not a ruling', { what: 'd', why: 'e', costIfWrong: 'f' }]),
    { at: at(3), run: ID, kind: 'ladder.ruled', by: 'harness', task: 'ui', round: 5, ruling: 'one more round — close — an hour' },
    { at: at(4), run: ID, kind: 'pr.checked', by: 'harness', session: 's', head: SHA_A, gate: null, final: null, gateOk: false, reviewOk: false,
      overrides: { review: 'no reviewer — trivial — a bug', gate: 'flaky — known — a revert' }, result: 'pass' },
    mainRuling('skip the e2e', 5, 'api'),
    coderEnded('c2', 'ui', 6, [{ what: 'g', why: 'h', costIfWrong: 'i' }]),
    // None of these: a reviewer's report, a coder's that ended without one or with rulings that aren't a list, and the wrong writers.
    ended('r1', 'reviewer', 'ui', 7, { report: { role: 'reviewer', turn: 1, at: 0, verdict: 'approved', head: SHA_A, summary: 'x', findings: [], rulings: [{ what: 'r', why: 'r', costIfWrong: 'r' }] } }),
    ended('c3', 'coder', 'ui', 8),
    coderEnded('c4', 'ui', 9, 'none' as unknown as unknown[]),
    { ...mainRuling('forged', 10), by: 'harness' } as unknown as LedgerEntry,
    { ...coderEnded('c5', 'ui', 11, [{ what: 'forged', why: 'w', costIfWrong: 'c' }]), by: 'main' } as unknown as LedgerEntry,
    { at: at(12), run: ID, kind: 'ladder.ruled', by: 'main', task: 'ui', round: 6, ruling: 'forged' } as unknown as LedgerEntry,
  ]
  assert.deepEqual(closingRulings(entries), [
    'kept the old cookie — why — cost',
    'a — b — c (coder)',
    'd — e — f (coder)',
    'ui: one more round — close — an hour',
    'gate: flaky — known — a revert',
    'review: no reviewer — trivial — a bug',
    'api: skip the e2e — why — cost',
    'g — h — i (coder, ui)',
  ])
  assert.deepEqual(closingRulings([]), [])
})

test('closingRulingsBlock: \'\' with none; the newest ten oldest first and how many more', () => {
  assert.equal(CLOSING_RULINGS, 10)
  assert.equal(closingRulingsBlock([]), '')
  assert.equal(closingRulingsBlock([started('c1', 'coder', 'api', 1), mainRuling('x', 2, undefined, { why: 1 })]), '')
  assert.equal(closingRulingsBlock(everyKind(ID)), [
    'Rulings in this run:',
    '- kept the old cookie — compat — one more round (coder, api)',
    '- api: one more round — close — an hour',
    '- api: skip the e2e — flaky — a regression',
  ].join('\n'))
  const many = (count: number): LedgerEntry[] => Array.from({ length: count }, (_, index) => mainRuling(`r${index + 1}`, index + 1))
  assert.deepEqual(closingRulingsBlock(many(10)).split('\n'), ['Rulings in this run:', ...Array.from({ length: 10 }, (_, index) => `- r${index + 1} — why — cost`)])
  assert.deepEqual(closingRulingsBlock(many(13)).split('\n'), [
    'Rulings in this run:', ...Array.from({ length: 10 }, (_, index) => `- r${index + 4} — why — cost`), '- and 3 more in the ledger',
  ])
  assert.equal(closingRulingsBlock(many(11)).split('\n').at(-1), '- and 1 more in the ledger')
})

test('a ruling with a secret is masked, and each is one line of at most 300 characters', () => {
  const entries: LedgerEntry[] = [
    mainRuling(`used ${TOKEN}`, 1, 'api'),
    { at: at(2), run: ID, kind: 'ladder.ruled', by: 'harness', task: 'api', round: 5, ruling: `round with ${TOKEN}` },
    { at: at(3), run: ID, kind: 'pr.checked', by: 'harness', session: 's', head: SHA_A, gate: null, final: null, gateOk: false, reviewOk: true,
      overrides: { gate: `key ${TOKEN}` }, result: 'pass' },
    coderEnded('c1', 'api', 4, [{ what: 'kept\nthe key', why: TOKEN, costIfWrong: 'a leak' }]),
    mainRuling(`${'x'.repeat(290)} ${TOKEN}`, 5),
    mainRuling('w'.repeat(400), 6),
  ]
  const lines = closingRulings(entries)
  assert.deepEqual(lines.slice(0, 4), [
    `api: used ${MASKED_TOKEN} — why — cost`,
    `api: round with ${MASKED_TOKEN}`,
    `gate: key ${MASKED_TOKEN}`,
    `kept the key — ${MASKED_TOKEN} — a leak (coder, api)`,
  ])
  // Masked before it is cut: no part of the token is left where the line ends.
  assert.equal(lines[4], `${`${'x'.repeat(290)} ${MASKED_TOKEN} — why — cost`.slice(0, 299)}…`)
  assert.equal(lines[5], `${'w'.repeat(299)}…`)
  for (const text of lines) assert.ok(text.length <= 300 && !text.includes('ghs_') && !text.includes('\n'), text)
  assert.ok(!closingRulingsBlock(entries).includes('ghs_'))
})

test('closingRulings: a coder\'s ruling over 300 characters is cut before its tag, which stays; the line is at most 300', () => {
  const long = { what: 'k'.repeat(400), why: 'w', costIfWrong: 'c' }
  const lines = closingRulings([
    coderEnded('c1', 'api', 1, [long]),
    coderEnded('c2', undefined, 2, [long]),
    // Masked before it is cut: no part of the token is left where the text ends.
    coderEnded('c3', 'api', 3, [{ what: `${'x'.repeat(280)} ${TOKEN}`, why: 'w', costIfWrong: 'c' }]),
  ])
  assert.deepEqual(lines, [
    `${'k'.repeat(286)}… (coder, api)`,
    `${'k'.repeat(291)}… (coder)`,
    `${`${'x'.repeat(280)} ${MASKED_TOKEN}`.slice(0, 286)}… (coder, api)`,
  ])
  for (const text of lines) assert.equal(text.length, 300, text)
  assert.ok(!lines.some(text => text.includes('ghs_')))
})
