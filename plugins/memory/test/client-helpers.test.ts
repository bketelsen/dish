/**
 * The Memory page's pure helpers: what each answer the vault or the config store can give is called in plain language, and
 * how scopes, ids, authors, times and the remote are worded. The JSX around them is rendered in `client-rendering.test.ts`.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  authorLabel, byteLength, characters, commitText, familyOf, idOf, memoryPathOf, memoryText, modifiedText, relativeTime,
  remoteLine, scopeOptionText, shortId, subjectOf,
} from '../src/client/format.ts'
import { NOTHING_TO_REVERT, failureNotice, unexpectedNotice } from '../src/client/outcome.ts'

test('failureNotice: CONFLICT says what it means for each action, and keeps the store\'s words as detail', () => {
  const detail = 'user/style changed since you loaded it'
  assert.deepEqual(failureNotice('CONFLICT', detail, 'save'), {
    text: 'This memory changed since you loaded it. Your text is still in the editor.', detail,
  })
  assert.deepEqual(failureNotice('CONFLICT', detail), failureNotice('CONFLICT', detail, 'save'), 'no action: the wording of a save')
  assert.deepEqual(failureNotice('CONFLICT', detail, 'forget'), {
    text: 'This memory changed since you loaded it, so it wasn\'t deleted. Look at the change first.', detail,
  })
  assert.deepEqual(failureNotice('CONFLICT', 'families/dish/direction.md changed since abc', 'direction'), {
    text: 'The direction changed since you loaded it. Your text is still in the editor.', detail: 'families/dish/direction.md changed since abc',
  })
  assert.deepEqual(failureNotice('CONFLICT', 'user/style changed since', 'revert'), {
    text: 'A later change touched the same memory — revert that change first, or edit the memory directly.', detail: 'user/style changed since',
  })
})

test('failureNotice: INVALID is the service\'s own message, said as what could not be done', () => {
  const rule = 'description must be one line of at most 150 characters'
  assert.deepEqual(failureNotice('INVALID', rule, 'save'), { text: `Can't save: ${rule}` })
  assert.deepEqual(failureNotice('INVALID', 'user/style isn\'t held', 'release'), { text: 'Can\'t release: user/style isn\'t held' })
  assert.deepEqual(failureNotice('INVALID', 'x', 'forget'), { text: 'Can\'t delete: x' })
  assert.deepEqual(failureNotice('INVALID', 'x', 'direction'), { text: 'Can\'t save the direction: x' })
  assert.deepEqual(failureNotice('INVALID', 'x', 'revert'), { text: 'Can\'t revert: x' })
})

test('failureNotice: SECRET, TOO_LARGE, NOT_FOUND, UNOWNED, FORBIDDEN and LOCKED each have words of their own', () => {
  const secret = 'the memory looks like it holds a credential (GitHub token); never save secrets'
  assert.deepEqual(failureNotice('SECRET', secret), {
    text: 'This looks like a key or a token, and dish never stores those. Take it out and try again.', detail: secret,
  })
  assert.deepEqual(failureNotice('TOO_LARGE', 'over 1 MiB'), { text: 'This is too large to save.', detail: 'over 1 MiB' })
  assert.deepEqual(failureNotice('NOT_FOUND', 'no memory user/style'), {
    text: 'Not found: it may have been deleted or reverted elsewhere.', detail: 'no memory user/style',
  })
  assert.deepEqual(failureNotice('UNOWNED', 'no namespace owns user/x.md'), {
    text: 'The store has no claim on this path, so dish-memory probably isn\'t running. Check that it is loaded, then reload this page.',
    detail: 'no namespace owns user/x.md',
  })
  assert.deepEqual(failureNotice('FORBIDDEN', 'agents may only propose'), {
    text: 'The store doesn\'t allow this change.', detail: 'agents may only propose',
  })
  assert.deepEqual(failureNotice('LOCKED', 'the vault is locked by another process'), {
    text: 'Another dish process has the store locked. Try again in a moment.', detail: 'the vault is locked by another process',
  })
})

test('failureNotice: UNAVAILABLE for a direction says the config store isn\'t running; a code with no words of its own reads <code>: <message>', () => {
  assert.deepEqual(failureNotice('UNAVAILABLE', 'the config store isn\'t running', 'direction'), {
    text: 'The config store isn\'t running, so directions can\'t be read or saved. Start dish-config to edit them.',
  })
  assert.deepEqual(failureNotice('UNAVAILABLE', 'something is down', 'save'), { text: 'Not available: something is down' })
  assert.deepEqual(failureNotice('STALE', 'the reason'), { text: 'STALE: the reason' })
})

test('unexpectedNotice is a generic line naming dish-memory, with whatever the failure said as detail', () => {
  const text = 'Something went wrong talking to dish-memory'
  assert.deepEqual(unexpectedNotice({ message: 'gateway offline' }), { text, detail: 'gateway offline' })
  assert.deepEqual(unexpectedNotice(new Error('boom')), { text, detail: 'boom' })
  assert.deepEqual(unexpectedNotice('plain'), { text, detail: 'plain' })
  assert.deepEqual(unexpectedNotice(undefined), { text })
  assert.deepEqual(unexpectedNotice({ message: '' }), { text })
})

test('the fixed sentences', () => {
  assert.equal(NOTHING_TO_REVERT, 'Already reverted — nothing to do')
})

test('remoteLine is the History page\'s wording', () => {
  assert.equal(remoteLine({ pending: 0 }), 'No remote configured')
  assert.equal(remoteLine({ remote: 'git@github.com:me/vault.git', pending: 2 }), 'Not pushed yet · 2 pending')
  assert.equal(remoteLine({ remote: 'r', pushed: '0123456789abcdef', pending: 0 }), 'Pushed 0123456 · 0 pending')
  assert.equal(remoteLine({ remote: 'r', pushed: '0123456789abcdef', pending: 1, lastError: 'push failed: denied' }), 'Pushed 0123456 · 1 pending · push failed: denied')
  assert.equal(remoteLine({ remote: 'r', pending: 0, lastError: '' }), 'Not pushed yet · 0 pending')
})

test('ids, families and paths from a scope key', () => {
  assert.equal(idOf('user', 'style'), 'user/style')
  assert.equal(idOf('family:dish', 'deploy-gate'), 'family/deploy-gate')
  assert.equal(familyOf('user'), undefined)
  assert.equal(familyOf('family:dish'), 'dish')
  assert.equal(familyOf(undefined), undefined)
  assert.equal(memoryPathOf('user', 'style'), 'user/style.md')
  assert.equal(memoryPathOf('family:dish', 'deploy-gate'), 'families/dish/deploy-gate.md')
})

test('memoryText: the fields a person edits, as one text to diff', () => {
  assert.equal(memoryText({ type: 'feedback', description: 'Terse answers', body: 'Keep it short.\n' }), 'type: feedback\ndescription: Terse answers\n\nKeep it short.\n')
})

test('characters counts code points, byteLength UTF-8 bytes', () => {
  assert.equal(characters('abc'), 3)
  assert.equal(characters('naïve 🐟'), 7)
  assert.equal(byteLength('abc'), 3)
  assert.equal(byteLength('🐟'), 4)
})

test('scopeOptionText: the count, what is held, and an orphan', () => {
  assert.equal(scopeOptionText({ key: 'user', label: 'You', count: 3, held: 0, orphan: false }), 'You (3)')
  assert.equal(scopeOptionText({ key: 'family:dish', label: 'dish', count: 5, held: 1, orphan: false }), 'dish (5, 1 held)')
  assert.equal(scopeOptionText({ key: 'family:old', label: 'old', count: 2, held: 0, orphan: true }), 'old (2, no projects)')
})

test('authorLabel, shortId, subjectOf and commitText', () => {
  assert.equal(authorLabel({ kind: 'user' }), 'You')
  assert.equal(authorLabel({ kind: 'agent', sessionId: 's1', role: 'main' }), 'main agent')
  assert.equal(authorLabel({ kind: 'agent', sessionId: 's1' }), 'Agent')
  assert.equal(authorLabel({ kind: 'system' }), 'dish-memory')
  assert.equal(shortId('0123456789abcdef'), '0123456')
  assert.equal(subjectOf('user/style: Terse\n\nDish-Note: x'), 'user/style: Terse')
  assert.equal(commitText({ message: 'subject\nbody' }), 'subject')
  assert.equal(commitText({ message: 'subject', note: 'user/style: Terse answers' }), 'user/style: Terse answers')
  assert.equal(commitText({ message: 'subject', note: '' }), 'subject')
})

test('relativeTime and modifiedText', () => {
  const now = Date.UTC(2026, 9, 5, 12, 0, 0)
  const MIN = 60_000
  const HOUR = 60 * MIN
  const DAY = 24 * HOUR
  assert.equal(relativeTime(now, now), 'just now')
  assert.equal(relativeTime(now - 5 * MIN, now), '5 min ago')
  assert.equal(relativeTime(now - 3 * HOUR, now), '3 h ago')
  assert.equal(relativeTime(now - 3 * DAY, now), '3 days ago')
  assert.equal(relativeTime(now - 31 * DAY, now), '2026-09-04')
  assert.equal(relativeTime(now + 5 * MIN, now), 'just now')
  assert.equal(modifiedText('2026-10-05T11:00:00Z', now), '1 h ago')
  assert.equal(modifiedText('not a time', now), 'not a time')
})
