/**
 * What the timeline says of each ledger line (`describeEntry`), and the page's small wordings (`format.ts`): every kind of the
 * spec's two tables in words, with the fields Task 7 defines; an unknown kind and fields of the wrong type as a generic line,
 * never a throw; and `prHref`, the one way a string becomes a link.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { describeEntry } from '../src/client/entries.ts'
import { prHref, relativeTime, shortSha } from '../src/client/format.ts'
import { BASE_FIELDS, HARNESS_KINDS, MAIN_KINDS } from '../src/entries.ts'
import type { LedgerEntry } from '../src/entries.ts'
import type { JsonValue, LedgerLine } from '../src/protocol.ts'
import { DAY, HOUR, MINUTE, NOW, SHA_A, SHA_B, SHA_C, everyKind } from './helpers.ts'

const ID = '20261003-fix-login'

/** An entry as the remote gives it: the base fields, and the rest in `fields`. */
function toLine(entry: LedgerEntry | Record<string, unknown>): LedgerLine {
  const line: Record<string, unknown> = { fields: {} }
  for (const [key, value] of Object.entries(entry)) {
    if (BASE_FIELDS.includes(key)) line[key] = value
    else (line.fields as Record<string, JsonValue>)[key] = value as JsonValue
  }
  return JSON.parse(JSON.stringify(line)) as LedgerLine
}

function line(kind: string, fields: Record<string, unknown>, base: Partial<LedgerLine> = {}): LedgerLine {
  return { at: NOW, run: ID, kind, by: 'harness', ...base, fields: JSON.parse(JSON.stringify(fields)) as Record<string, JsonValue> }
}

/** The words of `line`, label and text, as one string. */
function words(of: LedgerLine): string {
  const { label, text } = describeEntry(of)
  return [label, ...text].join('\n')
}

function assertHas(of: LedgerLine, ...expected: string[]): void {
  const said = words(of)
  for (const part of expected) assert.ok(said.includes(part), `${JSON.stringify(part)} in:\n${said}`)
}

// --- every kind --------------------------------------------------------------------------------------

test('every kind of the two tables has words of its own: a label that isn\'t the bare kind, and lines of text', () => {
  const lines = everyKind(ID).map(toLine)
  const kinds = new Set(lines.map(each => each.kind))
  for (const kind of [...HARNESS_KINDS, ...MAIN_KINDS]) assert.ok(kinds.has(kind), `everyKind has ${kind}`)
  for (const each of lines) {
    const { label, text } = describeEntry(each)
    assert.equal(typeof label, 'string')
    assert.notEqual(label, each.kind, `${each.kind} has its own label`)
    assert.ok(label.length > 0)
    assert.ok(Array.isArray(text) && text.length > 0, each.kind)
    for (const part of text) assert.equal(typeof part, 'string', each.kind)
    // No raw JSON for a kind the page knows.
    assert.ok(!text.some(part => part.startsWith('{')), `${each.kind}: ${text.join(' | ')}`)
  }
})

test('the run: opened, goal, plan, resumed, reopened, taken over and closed', () => {
  const [opened, goal, plan] = everyKind(ID).map(toLine)
  assertHas(opened!, 'Fix the login redirect', 'dish/fix-login', 'origin/main', SHA_A.slice(0, 7), '/work/Acme/widget/.worktrees/fix-login')
  assertHas(line('run.opened', { goal: 'g', branch: 'dish/x', worktree: '/w', base: 'origin/main', baseCommit: SHA_A, how: 'auto', plan: { path: 'docs/p.md', commit: SHA_B } }), 'docs/p.md', SHA_B.slice(0, 7), 'worktree')
  assertHas(goal!, 'Fix the login redirect for SSO')
  assertHas(plan!, 'docs/plans/x.md', SHA_A.slice(0, 7))

  const resumed = describeEntry(line('run.resumed', { driver: 'session-2', previous: 'session-1' }))
  assert.ok(!/reopen/i.test(resumed.label))
  assertHas(line('run.resumed', { driver: 'abcdef0123456789' }), 'abcdef01…')
  const reopened = describeEntry(line('run.resumed', { driver: 'session-2', reopened: true }))
  assert.match(reopened.label, /reopened/i)
  assert.match(reopened.text.join(' '), /review feedback/)
  assertHas(line('run.takenOver', { driver: 'abcdef0123456789', previous: '0123456789abcdef' }), 'abcdef01…', '01234567…')

  const closedPr = line('run.closed', { state: 'pr', pr: { url: 'https://github.com/Acme/widget/pull/7', number: 7 } })
  assertHas(closedPr, '#7')
  const abandoned = line('run.closed', { state: 'abandoned', reason: 'the user changed their mind' })
  assertHas(abandoned, 'the user changed their mind')
  assert.match(describeEntry(abandoned).label, /abandoned/i)
})

test('tasks and children: opened, removed, started, a follow-up, a round, a final review, and how each ended', () => {
  const lines = everyKind(ID).map(toLine)
  const taskOpened = lines.find(each => each.kind === 'task.opened')!
  assertHas(taskOpened, 'dish/api', 'dish/fix-login', '/work/Acme/widget/.worktrees/api')
  assert.ok(words(lines.find(each => each.kind === 'task.removed')!).length > 0)

  const coderStart = lines.find(each => each.kind === 'child.started' && each.fields.role === 'coder')!
  assertHas(coderStart, 'coder', 'API', 'deepseek-chat', 'round 0')
  const reviewerStart = lines.find(each => each.kind === 'child.started' && each.fields.role === 'reviewer')!
  assertHas(reviewerStart, 'reviewer', 'Review API', 'reviews c1', 'final')
  const followUp = describeEntry(line('child.started', { child: 'c1', role: 'coder', title: 'API', model: 'm', family: 'f', followUp: true, round: 1 }))
  assert.match(followUp.label, /follow-up/i)

  const coderEnd = lines.find(each => each.kind === 'child.ended' && each.fields.role === 'coder')!
  assertHas(coderEnd, 'completed', 'done', 'Fixed the redirect', SHA_B.slice(0, 7), 'kept the old cookie', 'compat', 'one more round', 'flaky test', '/r/1-coder-1.md')
  const reviewerEnd = lines.find(each => each.kind === 'child.ended' && each.fields.role === 'reviewer')!
  assertHas(reviewerEnd, 'approved', 'Looks right', 'nit', 'src/a.ts:3', 'name', 'rename it', 'pnpm test', 'exit 0')
  assertHas(line('child.ended', {
    child: 'c2', role: 'coder', stopReason: 'error', error: 'the model went away', reportFile: '/r.md', head: null,
    report: { role: 'coder', turn: 1, at: NOW, status: 'blocked', summary: 'stuck', blockedOn: 'a missing key', notFixed: [{ finding: 'the race', why: 'out of scope' }] },
  }), 'the model went away', 'blocked', 'a missing key', 'the race', 'out of scope')
  assertHas(line('child.ended', {
    child: 'r2', role: 'reviewer', stopReason: 'completed', reportFile: '/r.md', head: SHA_C,
    report: { role: 'reviewer', turn: 1, at: NOW, verdict: 'changes_requested', head: SHA_C, summary: 'not yet', findings: [], addressed: [{ finding: 'the race', addressed: false, evidence: 'still there' }] },
  }), 'changes requested', 'not yet', 'the race', 'still there')
})

test('gates, verdicts and the ladder', () => {
  const lines = everyKind(ID).map(toLine)
  assertHas(lines.find(each => each.kind === 'gate.result')!, 'passed', 'exit 0', '1.2 s', SHA_B.slice(0, 7), '/logs/gate-1.log')
  assertHas(line('gate.result', { child: 'c1', outcome: 'failed', exitCode: null, timedOut: true, durationMs: 300_000, log: null, head: null, gateTurn: 1, gateRound: 2, reason: 'killed' }), 'failed', 'timed out', 'killed')
  const verdict = describeEntry(lines.find(each => each.kind === 'review.verdict')!)
  assert.match(verdict.label, /final/i)
  assertHas(lines.find(each => each.kind === 'review.verdict')!, 'approved', SHA_B.slice(0, 7), '0 blocking', '0 should fix', '1 nit')
  assertHas(line('review.verdict', { child: 'r1', verdict: 'changes_requested', head: SHA_B, final: false, findings: { blocking: 2, should_fix: 1, nit: 0 } }), 'changes requested', '2 blocking')
  assert.doesNotMatch(describeEntry(line('review.verdict', { child: 'r1', verdict: 'approved', head: SHA_B, final: false, findings: { blocking: 0, should_fix: 0, nit: 0 } })).label, /final/i)
  // A review of work outside git gives no head.
  const headless = describeEntry(line('review.verdict', { child: 'r1', verdict: 'approved', final: true, findings: { blocking: 0, should_fix: 0, nit: 0 } }))
  assert.equal(headless.label, 'Final review')
  assert.equal(headless.text[0], 'approved, no head given')
  assertHas(lines.find(each => each.kind === 'ladder.refused')!, 'round 5')
  assertHas(lines.find(each => each.kind === 'ladder.ruled')!, 'round 5', 'one more round — close — an hour')
})

test('the pull request: checked, opened, and the main agent\'s rulings, deferred findings and notes', () => {
  const lines = everyKind(ID).map(toLine)
  const checked = lines.find(each => each.kind === 'pr.checked')!
  assert.match(describeEntry(checked).label, /pass/i)
  assertHas(checked, SHA_B.slice(0, 7), 'passed', 'approved')
  const refused = line('pr.checked', {
    head: SHA_C, gate: null, final: null, gateOk: false, reviewOk: false, overrides: { gate: 'flaky e2e — known — a broken main' }, result: 'refused',
    refused: ['no approved final review of this head'],
  })
  assert.match(describeEntry(refused).label, /refused/i)
  assertHas(refused, 'flaky e2e — known — a broken main', 'no approved final review of this head', 'no gate')
  // A final review that gave no head (a review of work outside git).
  const headless = line('pr.checked', {
    head: SHA_C, gate: null, final: { child: 'r1', verdict: 'approved', at: NOW }, gateOk: false, reviewOk: false, overrides: {}, result: 'refused',
  })
  assertHas(headless, 'final review: approved, no head given by r1')
  assertHas(lines.find(each => each.kind === 'pr.opened')!, '#7', 'https://github.com/Acme/widget/pull/7', 'dish/fix-login', SHA_B.slice(0, 7))
  assertHas(lines.find(each => each.kind === 'ruling')!, 'skip the e2e — flaky — a regression')
  assertHas(lines.find(each => each.kind === 'deferred')!, 'rename helper', 'src/a.ts', 'out of scope')
  assertHas(lines.find(each => each.kind === 'note')!, 'waiting on the user')
})

test('pr.updated: the title and the body changed or not, an update that failed, and the override comment posted or not', () => {
  const base = { url: 'https://github.com/Acme/widget/pull/7', number: 7, head: SHA_C, branch: 'dish/fix-login' }
  assertHas(line('pr.updated', { ...base, titleChanged: true, bodyChanged: true }), '#7', SHA_C.slice(0, 7), 'title and body changed')
  assertHas(line('pr.updated', { ...base, titleChanged: true, bodyChanged: false }), 'title changed')
  assertHas(line('pr.updated', { ...base, titleChanged: false, bodyChanged: true }), 'body changed')
  assertHas(line('pr.updated', { ...base, titleChanged: false, bodyChanged: false }), 'title and body left as they were')
  assertHas(line('pr.updated', { ...base, titleChanged: false, bodyChanged: false, updateError: 'GitHub said 422' }), 'GitHub said 422')
  assertHas(line('pr.updated', { ...base, titleChanged: false, bodyChanged: false, comment: 'posted' }), 'posted as a comment')
  assertHas(line('pr.updated', { ...base, titleChanged: false, bodyChanged: false, comment: 'failed', commentError: 'no write token' }), 'couldn\'t be posted', 'no write token')
  assert.doesNotMatch(words(line('pr.updated', { ...base, titleChanged: false, bodyChanged: false })), /comment/)
})

test('pr.feedback: its counts, and checks that couldn\'t be read', () => {
  const read = everyKind(ID).map(toLine).find(each => each.kind === 'pr.feedback')!
  assertHas(read, '#7', 'open', '0 approved', '1 changes requested', '2 commented', '4 review comments', '1 outdated', '2 comments', '3 passed', '1 failed', '0 pending')
  const unread = line('pr.feedback', {
    number: 7, state: 'closed', merged: true, mergeable: null, reviews: { approved: 1, changesRequested: 0, commented: 0, other: 0 },
    reviewComments: 0, outdated: 0, issueComments: 0, checks: null,
  })
  assertHas(unread, 'closed', 'merged', 'checks couldn\'t be read')
})

// --- what the page doesn't know ------------------------------------------------------------------------

test('an unknown kind shows its fields as JSON, at most 2000 characters', () => {
  const small = describeEntry(line('future.kind', { a: 1, b: 'two' }))
  assert.equal(small.label, 'future.kind')
  assert.deepEqual(small.text, ['{"a":1,"b":"two"}'])
  const big = describeEntry(line('future.kind', { text: '😀'.repeat(3_000) }))
  assert.equal(big.text.length, 1)
  assert.ok(big.text[0]!.length <= 2000, String(big.text[0]!.length))
  assert.ok(big.text[0]!.endsWith('…'))
  // Never half a surrogate pair.
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(big.text[0]!))
  assert.deepEqual(describeEntry(line('empty.kind', {})).text, ['{}'])
})

test('fields of the wrong type never throw: a known kind whose fields don\'t fit is a generic line', () => {
  const odd: Array<[string, Record<string, unknown>]> = [
    ['run.opened', { goal: 7, branch: null }],
    ['run.resumed', { driver: { nested: true } }],
    ['run.takenOver', {}],
    ['run.plan', { path: ['x'] }],
    ['run.goal', { goal: false }],
    ['task.opened', { path: 3 }],
    ['child.started', { role: 1, title: [] }],
    ['child.ended', { role: 'coder', stopReason: 5, report: 'not an object' }],
    ['gate.result', { outcome: 0 }],
    ['review.verdict', { verdict: 'approved', head: 12, findings: 'many' }],
    ['ladder.refused', { round: 'five' }],
    ['ladder.ruled', { round: 5, ruling: { x: 1 } }],
    ['pr.checked', { head: SHA_A, result: 'pass', gate: 'yes', final: 3, overrides: 'none', refused: 'all' }],
    ['pr.opened', { url: 7, number: '7' }],
    ['pr.updated', { url: 'u', number: null }],
    ['pr.feedback', { number: 'seven', reviews: [] }],
    ['run.closed', { state: 9 }],
    ['ruling', { what: 'x', why: null }],
    ['deferred', { what: [] }],
    ['note', { text: { html: '<b>' } }],
  ]
  for (const [kind, fields] of odd) {
    let said: { label: string, text: string[] } | undefined
    assert.doesNotThrow(() => { said = describeEntry(line(kind, fields)) }, kind)
    assert.equal(typeof said!.label, 'string', kind)
    assert.ok(said!.text.length > 0, kind)
    for (const part of said!.text) assert.equal(typeof part, 'string', kind)
  }
  // The generic line is the fields as JSON.
  assert.deepEqual(describeEntry(line('note', { text: { html: '<b>' } })).text, ['{"text":{"html":"<b>"}}'])
  // Optional fields of the wrong type are left out, and the rest is said.
  assertHas(line('pr.checked', { head: SHA_A, result: 'pass', gate: 'yes', final: 3, overrides: 'none', refused: 'all' }), SHA_A.slice(0, 7))
  // A line that isn't even an object of fields.
  assert.doesNotThrow(() => describeEntry({ at: NOW, run: ID, kind: 'note', by: 'main', fields: null } as unknown as LedgerLine))
  assert.doesNotThrow(() => describeEntry({ at: NOW, run: ID, kind: 7, by: 'main', fields: [] } as unknown as LedgerLine))
})

// --- format -------------------------------------------------------------------------------------------

test('prHref takes exactly https://github.com/<owner>/<repo>/pull/<n>, and nothing else', () => {
  for (const url of ['https://github.com/Acme/widget/pull/7', 'https://github.com/a.b-c_d/re.po/pull/12345']) assert.equal(prHref(url), url)
  for (const url of [
    'javascript:alert(1)',
    'JavaScript:alert(1)//https://github.com/Acme/widget/pull/7',
    'http://github.com/Acme/widget/pull/7',
    'https://evil.example/Acme/widget/pull/7',
    'https://github.com.evil.example/Acme/widget/pull/7',
    'https://user@github.com/Acme/widget/pull/7',
    'https://GITHUB.com/Acme/widget/pull/7',
    'https://github.com/Acme/widget/pull/7/files',
    'https://github.com/Acme/widget/pull/7?tab=files',
    'https://github.com/Acme/widget/pull/7#discussion',
    'https://github.com/Acme/widget/issues/7',
    'https://github.com/Acme/pull/7',
    'https://github.com/../widget/pull/7',
    'https://github.com/Acme/./pull/7',
    'https://github.com/Acme/widget/pull/0',
    'https://github.com/Acme/widget/pull/07',
    'https://github.com/Acme/widget/pull/',
    'https://github.com/Acme/widget/pull/7\n',
    ' https://github.com/Acme/widget/pull/7',
    'https://github.com/Acme%2Fx/widget/pull/7',
    '',
  ]) {
    assert.equal(prHref(url), undefined, url)
  }
  assert.equal(prHref(7 as unknown as string), undefined)
})

test('relativeTime is workspaces\' rule, and a time that names no date says so; shortSha is the first seven', () => {
  assert.equal(relativeTime(NOW, NOW + 30_000), 'just now')
  assert.equal(relativeTime(NOW + MINUTE, NOW), 'just now')
  assert.equal(relativeTime(NOW, NOW + 59 * MINUTE + 59_000), '59 min ago')
  assert.equal(relativeTime(NOW, NOW + 5 * HOUR), '5 h ago')
  assert.equal(relativeTime(NOW, NOW + 47 * HOUR), '47 h ago')
  assert.equal(relativeTime(NOW, NOW + 3 * DAY), '3 days ago')
  assert.equal(relativeTime(NOW, NOW + 40 * DAY), '2026-10-03')
  assert.equal(relativeTime(1e20, NOW + 1e21), 'at an unknown time')
  assert.equal(relativeTime(Number.NaN, NOW), 'at an unknown time')
  assert.equal(shortSha(SHA_C), SHA_C.slice(0, 7))
  assert.equal(shortSha('abc'), 'abc')
})
