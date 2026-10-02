/**
 * The Skills page's pure helpers: what each answer the store can give is called in plain language, and how roles,
 * invocation, authors and times are worded. The JSX around them is checked in a browser.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  authorLabel, commitText, groupDigits, invocableText, offerOf, optionText, relativeTime, roleLabel, rolesText, shortId, subjectOf,
  summaryText,
} from '../src/client/format.ts'
import {
  ALREADY_DEFAULT, NOTHING_TO_REVERT, SAME_AS_DEFAULT, SHIPPED_NOT_DELETABLE, failureNotice, unexpectedNotice,
} from '../src/client/outcome.ts'
import type { CheckSummary, SkillInfo } from '../src/protocol.ts'

/** A valid, shipped, unedited skill offered to `main`, to change a field of. */
function skill(over: Partial<SkillInfo> = {}): SkillInfo {
  return {
    name: 'brainstorming',
    path: 'skills/brainstorming/SKILL.md',
    description: 'Use when starting new work',
    roles: ['main'],
    modelInvocable: true,
    userInvocable: true,
    shipped: true,
    differsFromDefault: false,
    missing: false,
    problem: '',
    pendingProposals: 0,
    ...over,
  }
}

test('failureNotice: a CONFLICT on a save or a reset says the draft is safe', () => {
  const save = { text: 'This skill changed since you loaded it. Your text is still in the editor.', detail: 'skills/tdd/SKILL.md changed since abc' }
  assert.deepEqual(failureNotice('CONFLICT', 'skills/tdd/SKILL.md changed since abc', 'save'), save)
  assert.deepEqual(failureNotice('CONFLICT', 'skills/tdd/SKILL.md changed since abc', 'reset'), save)
  assert.deepEqual(failureNotice('CONFLICT', 'skills/tdd/SKILL.md changed since abc'), save, 'no action: the wording of a save')
})

test('failureNotice: a CONFLICT on a delete says nothing was deleted; on a revert, what to do about a later change', () => {
  assert.deepEqual(failureNotice('CONFLICT', 'changed since abc', 'delete'), {
    text: 'This skill changed since you loaded it, so it wasn\'t deleted. Look at what changed, then try again.',
    detail: 'changed since abc',
  })
  assert.deepEqual(failureNotice('CONFLICT', 'a later change touched the same files', 'revert'), {
    text: 'A later change touched the same file — revert that change first, or edit the skill directly.',
    detail: 'a later change touched the same files',
  })
})

test('failureNotice: INVALID is the store\'s own message, said as what could not be done', () => {
  assert.deepEqual(failureNotice('INVALID', 'the description is over 1024 characters', 'save'), {
    text: 'Can\'t save: the description is over 1024 characters',
  })
  assert.deepEqual(failureNotice('INVALID', 'x', 'reset'), { text: 'Can\'t reset: x' })
  assert.deepEqual(failureNotice('INVALID', 'x', 'delete'), { text: 'Can\'t delete: x' })
  assert.deepEqual(failureNotice('INVALID', 'x', 'revert'), { text: 'Can\'t revert: x' })
})

test('failureNotice: SECRET, TOO_LARGE, UNAVAILABLE and NOT_FOUND each have words of their own', () => {
  assert.deepEqual(failureNotice('SECRET', 'note looks like a token'), {
    text: 'This looks like a key or a token, and the store never keeps those. Take it out and try again.',
    detail: 'note looks like a token',
  })
  assert.deepEqual(failureNotice('TOO_LARGE', 'over 1 MiB'), { text: 'This skill is too large for the store.', detail: 'over 1 MiB' })
  assert.deepEqual(failureNotice('UNAVAILABLE', 'the config store isn\'t running'), {
    text: 'The config store isn\'t running, so skills are read-only. Start dish-config to change them.',
  })
  assert.deepEqual(failureNotice('NOT_FOUND', 'there is no commit abc'), {
    text: 'Not found: it may have been deleted or reverted elsewhere.',
    detail: 'there is no commit abc',
  })
})

test('failureNotice: UNOWNED says the plugin is probably not running, FORBIDDEN and LOCKED say what they are', () => {
  assert.deepEqual(failureNotice('UNOWNED', 'no namespace owns skills/x/SKILL.md'), {
    text: 'The config store has no claim on the skills, so dish-skills probably isn\'t running. Check that it is loaded, then reload this page.',
    detail: 'no namespace owns skills/x/SKILL.md',
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
  assert.match(SHIPPED_NOT_DELETABLE, /comes back at the next start/)
  assert.match(SHIPPED_NOT_DELETABLE, /roles: \[\]/)
})

test('unexpectedNotice is a generic line, with whatever the failure said as detail', () => {
  assert.deepEqual(unexpectedNotice({ message: 'gateway offline' }), {
    text: 'Something went wrong talking to dish-skills',
    detail: 'gateway offline',
  })
  assert.deepEqual(unexpectedNotice(new Error('boom')), { text: 'Something went wrong talking to dish-skills', detail: 'boom' })
  assert.deepEqual(unexpectedNotice('plain'), { text: 'Something went wrong talking to dish-skills', detail: 'plain' })
  assert.deepEqual(unexpectedNotice(undefined), { text: 'Something went wrong talking to dish-skills' })
  assert.deepEqual(unexpectedNotice({ message: '' }), { text: 'Something went wrong talking to dish-skills' })
})

test('unexpectedNotice names the remote the call was to', () => {
  assert.deepEqual(unexpectedNotice({ message: 'gateway offline' }, 'dish-config'), {
    text: 'Something went wrong talking to dish-config',
    detail: 'gateway offline',
  })
  assert.deepEqual(unexpectedNotice(undefined, 'dish-config'), { text: 'Something went wrong talking to dish-config' })
})

test('roleLabel: a role by its name with a capital', () => {
  assert.equal(roleLabel('main'), 'Main')
  assert.equal(roleLabel('architect'), 'Architect')
  assert.equal(roleLabel('front-end'), 'Front-end')
  assert.equal(roleLabel(''), '')
})

test('authorLabel, shortId, subjectOf and commitText', () => {
  assert.equal(authorLabel({ kind: 'user' }), 'You')
  assert.equal(authorLabel({ kind: 'agent', sessionId: 's1', role: 'coder' }), 'coder agent')
  assert.equal(authorLabel({ kind: 'agent', sessionId: 's1', role: '' }), 'Agent')
  assert.equal(authorLabel({ kind: 'agent', sessionId: 's1' }), 'Agent')
  assert.equal(authorLabel({ kind: 'system' }), 'dish-config')
  assert.equal(shortId('0123456789abcdef'), '0123456')
  assert.equal(subjectOf('skills/tdd/SKILL.md: update\n\nnote'), 'skills/tdd/SKILL.md: update')
  assert.equal(subjectOf('one line'), 'one line')
  assert.equal(commitText({ message: 'subject\n\nbody', note: 'Why I did it' }), 'Why I did it')
  assert.equal(commitText({ message: 'subject\n\nbody', note: '' }), 'subject')
  assert.equal(commitText({ message: 'subject\n\nbody' }), 'subject')
})

test('relativeTime', () => {
  const now = Date.UTC(2026, 9, 2, 12, 0, 0)
  const ago = (ms: number): string => relativeTime(now - ms, now)
  const MIN = 60_000
  const HOUR = 60 * MIN
  const DAY = 24 * HOUR
  assert.equal(ago(0), 'just now')
  assert.equal(ago(MIN), '1 min ago')
  assert.equal(ago(59 * MIN + 59_000), '59 min ago')
  assert.equal(ago(HOUR), '1 h ago')
  assert.equal(ago(2 * DAY), '2 days ago')
  assert.equal(ago(30 * DAY), '2026-09-02')
  assert.equal(relativeTime(now + 5 * MIN, now), 'just now')
})

test('offerOf: a problem row shows the problem, not chips', () => {
  assert.deepEqual(
    offerOf(skill({ problem: 'the frontmatter has no name', roles: [], modelInvocable: false, userInvocable: false })),
    { kind: 'problem', problem: 'the frontmatter has no name' },
  )
})

test('offerOf: roles null is every role, a list is its roles', () => {
  assert.deepEqual(offerOf(skill({ roles: null })), { kind: 'all' })
  assert.deepEqual(offerOf(skill({ roles: ['main', 'coder'] })), { kind: 'roles', roles: ['main', 'coder'] })
})

test('offerOf: "off" is no roles at all, or nothing invocable', () => {
  assert.deepEqual(offerOf(skill({ roles: [] })), { kind: 'off' })
  assert.deepEqual(offerOf(skill({ roles: [], userInvocable: false })), { kind: 'off' })
  assert.deepEqual(offerOf(skill({ roles: ['main'], modelInvocable: false, userInvocable: false })), { kind: 'off' })
  assert.deepEqual(offerOf(skill({ roles: null, modelInvocable: false, userInvocable: false })), { kind: 'off' })
})

test('offerOf: a skill only the menu or only a model can use is still offered', () => {
  assert.deepEqual(offerOf(skill({ roles: ['main'], modelInvocable: false, userInvocable: true })), { kind: 'roles', roles: ['main'] })
  assert.deepEqual(offerOf(skill({ roles: null, modelInvocable: true, userInvocable: false })), { kind: 'all' })
})

test('rolesText: all roles, no roles, or the names', () => {
  assert.equal(rolesText(null), 'all roles')
  assert.equal(rolesText([]), 'no roles')
  assert.equal(rolesText(['main']), 'main')
  assert.equal(rolesText(['main', 'coder']), 'main, coder')
})

test('invocableText', () => {
  assert.equal(invocableText(true, true), 'model- and user-invocable')
  assert.equal(invocableText(true, false), 'model-invocable only')
  assert.equal(invocableText(false, true), 'user-invocable only')
  assert.equal(invocableText(false, false), 'not invocable')
})

test('groupDigits puts a comma every three digits', () => {
  assert.equal(groupDigits(0), '0')
  assert.equal(groupDigits(999), '999')
  assert.equal(groupDigits(1000), '1,000')
  assert.equal(groupDigits(8001), '8,001')
  assert.equal(groupDigits(1234567), '1,234,567')
})

test('summaryText: description length, roles, invocation and size', () => {
  const summary: CheckSummary = { description: 'Use when starting new work', roles: ['main', 'architect'], modelInvocable: true, userInvocable: true, chars: 2345 }
  assert.equal(
    summaryText(summary),
    'description 26 characters · roles: main, architect · model- and user-invocable · 2,345 characters',
  )
  assert.equal(
    summaryText({ description: 'x', roles: null, modelInvocable: false, userInvocable: true, chars: 1 }),
    'description 1 character · roles: all roles · user-invocable only · 1 character',
  )
  assert.equal(
    summaryText({ description: 'Use when', roles: [], modelInvocable: true, userInvocable: false, chars: 40 }),
    'description 8 characters · roles: no roles · model-invocable only · 40 characters',
  )
})

test('optionText: the name, then what the list would show beside it', () => {
  assert.equal(optionText(skill()), 'brainstorming (main)')
  assert.equal(optionText(skill({ roles: null })), 'brainstorming (all roles)')
  assert.equal(optionText(skill({ roles: ['main', 'coder'] })), 'brainstorming (main, coder)')
  assert.equal(optionText(skill({ roles: [] })), 'brainstorming (off)')
  assert.equal(
    optionText(skill({ shipped: false, differsFromDefault: false, name: 'mine', roles: ['coder'] })),
    'mine (coder, yours)',
  )
  assert.equal(optionText(skill({ differsFromDefault: true })), 'brainstorming (main, edited)')
  assert.equal(optionText(skill({ pendingProposals: 2 })), 'brainstorming (main, 2 waiting)')
  assert.equal(optionText(skill({ missing: true })), 'brainstorming (main, not in the store)')
  assert.equal(
    optionText(skill({ problem: 'no name', shipped: false, name: 'broken', roles: [] })),
    'broken (problem, yours)',
  )
})
