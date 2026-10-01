/**
 * The History page's pure helpers: how a patch's lines are told apart, how times and authors are worded, and what
 * each outcome the store can give is called in plain language. The JSX around them is checked in a browser.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifyPatch, patchTotals } from '../src/client/diff.ts'
import { authorLabel, commitText, orderProposals, relativeTime, remoteLine, shortId, subjectOf } from '../src/client/format.ts'
import {
  NOTHING_TO_ACCEPT, NOTHING_TO_REVERT, STALE_TEXT, failureNotice, unexpectedNotice,
} from '../src/client/outcome.ts'
import type { ProposalInfo, RemoteStatus } from '../src/protocol.ts'

const PATCH = [
  'diff --git a/prompts/a.md b/prompts/a.md',
  'index 1111111..2222222 100644',
  '--- a/prompts/a.md',
  '+++ b/prompts/a.md',
  '@@ -1,3 +1,3 @@ heading',
  ' keep',
  '-old',
  '+new',
  ' tail',
  '',
].join('\n')

test('classifyPatch tells headers, hunk markers, added, removed and context lines apart', () => {
  const lines = classifyPatch(PATCH)
  assert.deepEqual(lines.map(line => line.kind), [
    'meta', 'meta', 'meta', 'meta', 'hunk', 'context', 'remove', 'add', 'context',
  ])
  assert.equal(lines[4]!.text, '@@ -1,3 +1,3 @@ heading')
  assert.equal(lines[6]!.text, '-old', 'a line keeps its marker')
  assert.equal(lines[7]!.text, '+new')
})

test('classifyPatch: the trailing newline is not a line of its own', () => {
  assert.equal(classifyPatch('diff --git a/x b/x\n').length, 1)
  assert.deepEqual(classifyPatch(''), [])
})

test('classifyPatch: inside a hunk a line starting with --- or +++ is a removed or added line, not a header', () => {
  const lines = classifyPatch([
    'diff --git a/x.md b/x.md',
    '--- a/x.md',
    '+++ b/x.md',
    '@@ -1,2 +1,2 @@',
    '--- a rule',
    '+++ a heading',
    '',
  ].join('\n'))
  assert.deepEqual(lines.map(line => line.kind), ['meta', 'meta', 'meta', 'hunk', 'remove', 'add'])
})

test('classifyPatch: "no newline" notes and empty context lines', () => {
  const lines = classifyPatch([
    'diff --git a/x b/x',
    '@@ -1 +1 @@',
    '-a',
    '\\ No newline at end of file',
    '+b',
    '',
    ' c',
    '',
  ].join('\n'))
  assert.deepEqual(lines.map(line => line.kind), ['meta', 'hunk', 'remove', 'note', 'add', 'context', 'context'])
})

test('classifyPatch: several hunks, and a binary file or a new empty file with no hunk at all', () => {
  const several = classifyPatch([
    'diff --git a/x b/x',
    '@@ -1 +1 @@',
    '-a',
    '+b',
    '@@ -9 +9 @@',
    '-y',
    '+z',
    '',
  ].join('\n'))
  assert.deepEqual(several.map(line => line.kind), ['meta', 'hunk', 'remove', 'add', 'hunk', 'remove', 'add'])

  const none = classifyPatch('diff --git a/e b/e\nnew file mode 100644\nindex 0000000..e69de29\n')
  assert.deepEqual(none.map(line => line.kind), ['meta', 'meta', 'meta'])
})

test('patchTotals counts the added and removed lines, and not the headers', () => {
  assert.deepEqual(patchTotals(classifyPatch(PATCH)), { added: 1, removed: 1 })
  assert.deepEqual(patchTotals([]), { added: 0, removed: 0 })
})

test('authorLabel: you, "<role> agent", and the store itself', () => {
  assert.equal(authorLabel({ kind: 'user' }), 'You')
  assert.equal(authorLabel({ kind: 'agent', sessionId: 's1', role: 'coder' }), 'coder agent')
  assert.equal(authorLabel({ kind: 'agent', sessionId: 's1' }), 'Agent', 'no role recorded')
  assert.equal(authorLabel({ kind: 'agent', sessionId: 's1', role: '' }), 'Agent', 'an empty role is none')
  assert.equal(authorLabel({ kind: 'system' }), 'dish-config')
})

test('relativeTime', () => {
  const now = Date.UTC(2026, 9, 1, 12, 0, 0)
  const ago = (ms: number): string => relativeTime(now - ms, now)
  const MIN = 60_000
  const HOUR = 60 * MIN
  const DAY = 24 * HOUR
  assert.equal(ago(0), 'just now')
  assert.equal(ago(59_999), 'just now')
  assert.equal(ago(MIN), '1 min ago')
  assert.equal(ago(59 * MIN + 59_000), '59 min ago', 'rounds down: never "60 min ago"')
  assert.equal(ago(HOUR), '1 h ago')
  assert.equal(ago(47 * HOUR + 30 * MIN), '47 h ago')
  assert.equal(ago(2 * DAY), '2 days ago')
  assert.equal(ago(29 * DAY + 23 * HOUR), '29 days ago')
  assert.equal(ago(30 * DAY), '2026-09-01', 'older than 30 days: the date')
  assert.equal(relativeTime(now + 5 * MIN, now), 'just now', 'a clock that runs ahead is not "in the future"')
})

test('shortId is the first 7 characters', () => {
  assert.equal(shortId('0123456789abcdef0123456789abcdef01234567'), '0123456')
  assert.equal(shortId('abcd'), 'abcd')
})

test('subjectOf is the first line of a commit message', () => {
  assert.equal(subjectOf('prompts/a.md: update\n\nnote\n\nDish-Author-Kind: user'), 'prompts/a.md: update')
  assert.equal(subjectOf('one line'), 'one line')
  assert.equal(subjectOf(''), '')
})

test('commitText is the note when there is one, else the subject', () => {
  const message = 'prompts/a.md: update\n\nwhy\n\nDish-Author-Kind: user'
  assert.equal(commitText({ message, note: 'tightened the intro' }), 'tightened the intro')
  assert.equal(commitText({ message }), 'prompts/a.md: update')
  assert.equal(commitText({ message, note: '' }), 'prompts/a.md: update')
})

test('remoteLine: pushed, pending and the last error', () => {
  const status = (value: Partial<RemoteStatus>): RemoteStatus => ({ pending: 0, ...value })
  assert.equal(remoteLine(status({})), 'No remote configured')
  assert.equal(
    remoteLine(status({ remote: 'git@github.com:me/x.git', pushed: '0123456789abcdef', pending: 0 })),
    'Pushed 0123456 · 0 pending',
  )
  assert.equal(
    remoteLine(status({ remote: 'git@github.com:me/x.git', pushed: '0123456789abcdef', pending: 2, lastError: 'permission denied' })),
    'Pushed 0123456 · 2 pending · permission denied',
  )
  assert.equal(
    remoteLine(status({ remote: 'git@github.com:me/x.git', pending: 1 })),
    'Not pushed yet · 1 pending',
    'nothing has been pushed by this process',
  )
  assert.equal(
    remoteLine(status({ remote: 'git@github.com:me/x.git', pending: 1, lastError: 'no route' })),
    'Not pushed yet · 1 pending · no route',
  )
})

test('orderProposals puts those awaiting a decision before the rejected, each group in the order given', () => {
  const make = (id: string, status: ProposalInfo['status']): ProposalInfo => ({
    id, status, title: id, rationale: '', author: { kind: 'user' }, created: 0, base: 'b', tip: 't', paths: [],
  })
  const given = [make('r1', 'rejected'), make('o1', 'open'), make('s1', 'stale'), make('r2', 'rejected'), make('o2', 'open')]
  assert.deepEqual(orderProposals(given).map(proposal => proposal.id), ['o1', 's1', 'o2', 'r1', 'r2'])
  assert.deepEqual(given.map(proposal => proposal.id), ['r1', 'o1', 's1', 'r2', 'o2'], 'the list given is not reordered in place')
  assert.deepEqual(orderProposals([]), [])
})

test('failureNotice puts each store code in plain language and keeps the store message as detail', () => {
  assert.deepEqual(failureNotice('CONFLICT', 'prompts/a.md changed since abc'), {
    text: 'This changed since you loaded it — reload and try again',
    detail: 'prompts/a.md changed since abc',
  })
  assert.deepEqual(failureNotice('STALE', 'main moved'), { text: STALE_TEXT, detail: 'main moved' })
  assert.equal(STALE_TEXT, 'Stale: main changed since this was proposed — the agent will rebuild it')
  assert.deepEqual(failureNotice('NOT_FOUND', 'there is no proposal "x"'), {
    text: 'Not found (it may have been accepted or rejected elsewhere)',
    detail: 'there is no proposal "x"',
  })
  for (const code of ['INVALID', 'UNOWNED', 'FORBIDDEN', 'SECRET', 'TOO_LARGE', 'LOCKED'] as const) {
    assert.deepEqual(failureNotice(code, 'the reason'), { text: `${code}: the reason` }, code)
  }
})

test('the "nothing to do" results of a revert and an accept', () => {
  assert.equal(NOTHING_TO_REVERT, 'Already reverted — nothing to do')
  assert.equal(NOTHING_TO_ACCEPT, 'Main already has this — nothing to do')
})

test('unexpectedNotice is a generic line, with whatever the failure said as detail', () => {
  assert.deepEqual(unexpectedNotice({ message: 'gateway offline' }), {
    text: 'Something went wrong talking to dish-config',
    detail: 'gateway offline',
  })
  assert.deepEqual(unexpectedNotice(new Error('boom')), {
    text: 'Something went wrong talking to dish-config',
    detail: 'boom',
  })
  assert.deepEqual(unexpectedNotice('plain'), { text: 'Something went wrong talking to dish-config', detail: 'plain' })
  assert.deepEqual(unexpectedNotice(undefined), { text: 'Something went wrong talking to dish-config' })
  assert.deepEqual(unexpectedNotice({ message: '' }), { text: 'Something went wrong talking to dish-config' })
})
