/**
 * The Prompts page's pure helpers: what each answer the store can give is called in plain language, and how roles,
 * authors and times are worded. The JSX around them is checked in a browser.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { authorLabel, relativeTime, roleLabel, shortId, subjectOf } from '../src/client/format.ts'
import {
  ALREADY_DEFAULT, NOTHING_TO_REVERT, SAME_AS_DEFAULT, failureNotice, unexpectedNotice,
} from '../src/client/outcome.ts'
import type { ErrorCode } from '../src/protocol.ts'

test('failureNotice: a CONFLICT on a save or a reset says the draft is safe; on a revert, what to do about a later change', () => {
  const save = { text: 'This prompt changed since you loaded it. Your text is still in the editor.', detail: 'prompts/main.md changed since abc' }
  assert.deepEqual(failureNotice('CONFLICT', 'prompts/main.md changed since abc', 'save'), save)
  assert.deepEqual(failureNotice('CONFLICT', 'prompts/main.md changed since abc', 'reset'), save)
  assert.deepEqual(failureNotice('CONFLICT', 'prompts/main.md changed since abc'), save, 'no action: the wording of a save')
  assert.deepEqual(failureNotice('CONFLICT', 'a later change touched the same files', 'revert'), {
    text: 'A later change touched the same file — revert that change first, or edit the prompt directly.',
    detail: 'a later change touched the same files',
  })
})

test('failureNotice: INVALID is the store\'s own message, said as what could not be done', () => {
  assert.deepEqual(failureNotice('INVALID', 'a prompt can\'t be empty; use Reset to go back to the default', 'save'), {
    text: 'Can\'t save: a prompt can\'t be empty; use Reset to go back to the default',
  })
  assert.deepEqual(failureNotice('INVALID', 'x', 'reset'), { text: 'Can\'t save: x' })
  assert.deepEqual(failureNotice('INVALID', 'x', 'revert'), { text: 'Can\'t revert: x' })
})

test('failureNotice: SECRET, TOO_LARGE, UNAVAILABLE and NOT_FOUND each have words of their own', () => {
  assert.deepEqual(failureNotice('SECRET', 'note looks like a token'), {
    text: 'This looks like a key or a token, and the store never keeps those. Take it out and try again.',
    detail: 'note looks like a token',
  })
  assert.deepEqual(failureNotice('TOO_LARGE', 'over 1 MiB'), {
    text: 'This prompt is too large for the store.',
    detail: 'over 1 MiB',
  })
  assert.deepEqual(failureNotice('UNAVAILABLE', 'the config store isn\'t running, so prompts can\'t be saved'), {
    text: 'The config store isn\'t running, so prompts are read-only. Start dish-config to change them.',
  })
  assert.deepEqual(failureNotice('NOT_FOUND', 'there is no commit abc'), {
    text: 'Not found: it may have been deleted or reverted elsewhere.',
    detail: 'there is no commit abc',
  })
})

test('failureNotice: UNOWNED says the plugin is probably not running, FORBIDDEN and LOCKED say what they are', () => {
  assert.deepEqual(failureNotice('UNOWNED', 'no namespace owns prompts/main.md'), {
    text: 'The config store has no claim on the prompts, so dish-prompts probably isn\'t running. Check that it is loaded, then reload this page.',
    detail: 'no namespace owns prompts/main.md',
  })
  assert.deepEqual(failureNotice('FORBIDDEN', 'only a user may accept a proposal'), {
    text: 'The config store doesn\'t allow this change.',
    detail: 'only a user may accept a proposal',
  })
  assert.deepEqual(failureNotice('LOCKED', 'the config store is locked by another process (x)'), {
    text: 'Another dish process has the config store locked. Try again in a moment.',
    detail: 'the config store is locked by another process (x)',
  })
})

test('failureNotice: a code with no wording of its own reads <code>: <message>', () => {
  assert.deepEqual(failureNotice('STALE', 'the reason'), { text: 'STALE: the reason' })
})

test('the fixed sentences', () => {
  assert.equal(NOTHING_TO_REVERT, 'Already reverted — nothing to do')
  assert.equal(ALREADY_DEFAULT, 'Already the default — nothing to do')
  assert.equal(SAME_AS_DEFAULT, 'Same as the default.')
})

test('unexpectedNotice is a generic line, with whatever the failure said as detail', () => {
  assert.deepEqual(unexpectedNotice({ message: 'gateway offline' }), {
    text: 'Something went wrong talking to dish-prompts',
    detail: 'gateway offline',
  })
  assert.deepEqual(unexpectedNotice(new Error('boom')), { text: 'Something went wrong talking to dish-prompts', detail: 'boom' })
  assert.deepEqual(unexpectedNotice('plain'), { text: 'Something went wrong talking to dish-prompts', detail: 'plain' })
  assert.deepEqual(unexpectedNotice(undefined), { text: 'Something went wrong talking to dish-prompts' })
  assert.deepEqual(unexpectedNotice({ message: '' }), { text: 'Something went wrong talking to dish-prompts' })
})

test('unexpectedNotice names the remote the call was to', () => {
  assert.deepEqual(unexpectedNotice({ message: 'gateway offline' }, 'dish-config'), {
    text: 'Something went wrong talking to dish-config',
    detail: 'gateway offline',
  })
  assert.deepEqual(unexpectedNotice(undefined, 'dish-config'), { text: 'Something went wrong talking to dish-config' })
})

test('roleLabel: Common, Main, then a crew role by its name with a capital', () => {
  assert.equal(roleLabel('common'), 'Common')
  assert.equal(roleLabel('main'), 'Main')
  assert.equal(roleLabel('architect'), 'Architect')
  assert.equal(roleLabel('front-end'), 'Front-end')
  assert.equal(roleLabel(''), '')
})

test('authorLabel, shortId and subjectOf', () => {
  assert.equal(authorLabel({ kind: 'user' }), 'You')
  assert.equal(authorLabel({ kind: 'agent', sessionId: 's1', role: 'coder' }), 'coder agent')
  assert.equal(authorLabel({ kind: 'agent', sessionId: 's1' }), 'Agent')
  assert.equal(authorLabel({ kind: 'system' }), 'dish-config')
  assert.equal(shortId('0123456789abcdef'), '0123456')
  assert.equal(subjectOf('prompts/main.md: update\n\nnote'), 'prompts/main.md: update')
  assert.equal(subjectOf('one line'), 'one line')
})

test('relativeTime', () => {
  const now = Date.UTC(2026, 9, 1, 12, 0, 0)
  const ago = (ms: number): string => relativeTime(now - ms, now)
  const MIN = 60_000
  const HOUR = 60 * MIN
  const DAY = 24 * HOUR
  assert.equal(ago(0), 'just now')
  assert.equal(ago(MIN), '1 min ago')
  assert.equal(ago(59 * MIN + 59_000), '59 min ago')
  assert.equal(ago(HOUR), '1 h ago')
  assert.equal(ago(2 * DAY), '2 days ago')
  assert.equal(ago(30 * DAY), '2026-09-01')
  assert.equal(relativeTime(now + 5 * MIN, now), 'just now')
})
