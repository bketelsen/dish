/**
 * The Projects page's pure helpers: what each answer the registry can give is called in plain language, and how states,
 * fetches, skipped setup, changed settings and the questions the page asks are worded. The JSX around them is checked in a
 * browser.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Then } from '../src/client/controller.ts'
import { skipReason } from '../../workspaces/src/setup.ts'
import {
  changedFields, fetchText, fieldValue, optionText, relativeTime, retryHint, shortId, skippedParts, stateLabel, stateTone, statusLine,
  thenText,
} from '../src/client/format.ts'
import {
  BROKEN_FILE_HISTORY, STORE_MISSING, brokenFileText, failureNotice, proposalsText, removeQuestion, unexpectedNotice,
} from '../src/client/outcome.ts'
import type { Fields, ProjectInfo, ProjectState } from '../src/protocol.ts'

function fields(over: Partial<Fields> = {}): Fields {
  return { family: 'acme', role: 'the widget', gate: 'pnpm test', gateTimeout: '10m', setup: '', setupTimeout: '', gateEnv: {}, ...over }
}

function project(over: Partial<ProjectInfo> = {}): ProjectInfo {
  return {
    name: 'acme/widget',
    fields: fields(),
    status: { state: 'ready', message: null, at: 0, setupSkipped: null },
    clone: '/home/dish/work/acme/widget',
    workspace: 'acme/widget',
    lastFetch: null,
    ...over,
  }
}

const NOW = Date.UTC(2026, 9, 2, 12, 0, 0)
const MIN = 60_000

// --- outcome.ts ----------------------------------------------------------------------------------

test('failureNotice: a CONFLICT on a save says the form is safe; on a removal, that nothing was removed', () => {
  assert.deepEqual(failureNotice('CONFLICT', 'projects.yaml changed since abc1234', 'save'), {
    text: 'projects.yaml changed since you loaded it. Your settings are still in the form.',
    detail: 'projects.yaml changed since abc1234',
  })
  assert.deepEqual(failureNotice('CONFLICT', 'changed'), {
    text: 'projects.yaml changed since you loaded it. Your settings are still in the form.',
    detail: 'changed',
  })
  assert.deepEqual(failureNotice('CONFLICT', 'changed', 'remove'), {
    text: 'projects.yaml changed since you loaded it, so nothing was removed. The list is up to date now: look at it, then try again.',
    detail: 'changed',
  })
})

test('failureNotice: INVALID is the registry\'s own message, said as what could not be done', () => {
  assert.deepEqual(failureNotice('INVALID', 'projects.yaml: acme/widget: gate is blank', 'save'), {
    text: 'Can\'t save: projects.yaml: acme/widget: gate is blank',
  })
  assert.deepEqual(failureNotice('INVALID', 'it is being onboarded', 'retry'), { text: 'Can\'t retry: it is being onboarded' })
  assert.deepEqual(failureNotice('INVALID', 'x', 'remove'), { text: 'Can\'t remove: x' })
})

test('failureNotice: SECRET, TOO_LARGE, UNAVAILABLE and NOT_FOUND each have words of their own', () => {
  assert.deepEqual(failureNotice('SECRET', 'the note looks like a token'), {
    text: 'This looks like a key or a token, and the store never keeps those. Take it out and try again.',
    detail: 'the note looks like a token',
  })
  assert.deepEqual(failureNotice('TOO_LARGE', 'over 1 MiB'), { text: 'projects.yaml is too large for the store.', detail: 'over 1 MiB' })
  assert.deepEqual(failureNotice('UNAVAILABLE', ''), { text: STORE_MISSING + ' Start dish-config to change them.' })
  assert.deepEqual(failureNotice('NOT_FOUND', 'there is no acme/x'), {
    text: 'Not found: it may have been removed elsewhere.',
    detail: 'there is no acme/x',
  })
})

test('failureNotice: UNOWNED says the plugin is probably not running, FORBIDDEN and LOCKED say what they are', () => {
  assert.deepEqual(failureNotice('UNOWNED', 'no namespace owns projects.yaml'), {
    text: 'The config store has no claim on projects.yaml, so dish-projects probably isn\'t running. Check that it is loaded, then reload this page.',
    detail: 'no namespace owns projects.yaml',
  })
  assert.deepEqual(failureNotice('FORBIDDEN', 'only a user may accept a proposal'), {
    text: 'The config store doesn\'t allow this change.',
    detail: 'only a user may accept a proposal',
  })
  assert.deepEqual(failureNotice('LOCKED', 'locked by another process'), {
    text: 'Another dish process has the config store locked. Try again in a moment.',
    detail: 'locked by another process',
  })
})

test('failureNotice: a code with no wording of its own reads <code>: <message>', () => {
  assert.deepEqual(failureNotice('STALE', 'the reason'), { text: 'STALE: the reason' })
})

test('unexpectedNotice is a generic line, with whatever the failure said as detail', () => {
  assert.deepEqual(unexpectedNotice({ message: 'gateway offline' }), {
    text: 'Something went wrong talking to dish-projects',
    detail: 'gateway offline',
  })
  assert.deepEqual(unexpectedNotice(new Error('boom')), { text: 'Something went wrong talking to dish-projects', detail: 'boom' })
  assert.deepEqual(unexpectedNotice('plain'), { text: 'Something went wrong talking to dish-projects', detail: 'plain' })
  assert.deepEqual(unexpectedNotice(undefined), { text: 'Something went wrong talking to dish-projects' })
  assert.deepEqual(unexpectedNotice({ message: '' }), { text: 'Something went wrong talking to dish-projects' })
  assert.deepEqual(unexpectedNotice({ message: 'offline' }, 'dish-config'), {
    text: 'Something went wrong talking to dish-config',
    detail: 'offline',
  })
})

test('removeQuestion says the clone and the workspace stay, and where the clone is when it is known', () => {
  assert.equal(
    removeQuestion('acme/widget', '/home/dish/work/acme/widget'),
    'Remove acme/widget from projects.yaml? Its clone at /home/dish/work/acme/widget and its workspace stay; dish stops fetching, sweeping and gating it.',
  )
  assert.equal(
    removeQuestion('acme/widget', null),
    'Remove acme/widget from projects.yaml? Its clone and its workspace stay; dish stops fetching, sweeping and gating it.',
  )
})

test('proposalsText: a count, and where they are decided', () => {
  assert.equal(proposalsText(1), '1 proposal for projects.yaml: review it on History')
  assert.equal(proposalsText(2), '2 proposals for projects.yaml: review them on History')
  assert.equal(proposalsText(12), '12 proposals for projects.yaml: review them on History')
})

test('brokenFileText names the problem and History', () => {
  const text = brokenFileText('projects.yaml: acme/widget: gateTimeout must be <n>s, <n>m or <n>h between 10s and 10m')
  assert.match(text, /^projects\.yaml: acme\/widget: gateTimeout must be/)
  assert.match(text, /no project is listed/)
  assert.match(text, /History/)
  assert.match(BROKEN_FILE_HISTORY, /History/)
})

// --- format.ts -----------------------------------------------------------------------------------

test('shortId is the first seven characters', () => {
  assert.equal(shortId('0123456789abcdef'), '0123456')
})

test('relativeTime', () => {
  const ago = (ms: number): string => relativeTime(NOW - ms, NOW)
  const HOUR = 60 * MIN
  const DAY = 24 * HOUR
  assert.equal(ago(0), 'just now')
  assert.equal(ago(MIN), '1 min ago')
  assert.equal(ago(59 * MIN + 59_000), '59 min ago')
  assert.equal(ago(HOUR), '1 h ago')
  assert.equal(ago(2 * DAY), '2 days ago')
  assert.equal(ago(30 * DAY), '2026-09-02')
  assert.equal(relativeTime(NOW + 5 * MIN, NOW), 'just now')
})

test('stateLabel and stateTone: every state has a chip', () => {
  const states: ProjectState[] = ['pending', 'cloning', 'setup', 'ready', 'failed']
  assert.deepEqual(states.map(stateLabel), ['pending', 'cloning', 'setup', 'ready', 'failed'])
  assert.deepEqual(states.map(stateTone), ['neutral', 'info', 'info', 'success', 'danger'])
})

test('statusLine: the state, and when it began when dish has said something', () => {
  assert.equal(statusLine({ state: 'pending', message: null, at: 0, setupSkipped: null }, NOW), 'pending')
  assert.equal(statusLine({ state: 'ready', message: null, at: NOW - 5 * MIN, setupSkipped: null }, NOW), 'ready, 5 min ago')
  assert.equal(statusLine({ state: 'failed', message: 'clone failed', at: NOW, setupSkipped: null }, NOW), 'failed, just now')
})

test('fetchText: never fetched, fetched, and failed with the reason', () => {
  assert.deepEqual(fetchText(null, NOW), { text: 'not fetched yet', ok: true })
  assert.deepEqual(fetchText({ at: NOW - 3 * MIN, ok: true, message: null }, NOW), { text: 'fetched 3 min ago', ok: true })
  assert.deepEqual(fetchText({ at: NOW - 3 * MIN, ok: false, message: 'git fetch failed (exit 128): no route' }, NOW), {
    text: 'fetch failed 3 min ago: git fetch failed (exit 128): no route',
    ok: false,
  })
  assert.deepEqual(fetchText({ at: NOW, ok: false, message: null }, NOW), { text: 'fetch failed just now', ok: false })
})

test('skippedParts: the reason, and the command to run instead, from the message dish-workspaces builds', () => {
  assert.deepEqual(
    skippedParts(skipReason('it is an existing checkout', '/home/dish/work/acme/widget', 'pnpm install --frozen-lockfile')),
    { reason: 'it is an existing checkout.', where: '/home/dish/work/acme/widget', command: 'pnpm install --frozen-lockfile' },
  )
  // A reason that ends in dots, a command with colons and several lines.
  assert.deepEqual(
    skippedParts(skipReason('base dish/plan-x isn\'t on origin/main...', '/w/x', 'echo a: b\npnpm install')),
    { reason: 'base dish/plan-x isn\'t on origin/main.', where: '/w/x', command: 'echo a: b\npnpm install' },
  )
})

test('skippedParts: other texts are the reason as they are', () => {
  assert.deepEqual(skippedParts('Run it yourself in /w/x: make'), { reason: '', where: '/w/x', command: 'make' })
  assert.deepEqual(skippedParts('setup was skipped'), { reason: 'setup was skipped' })
  assert.deepEqual(skippedParts('setup didn\'t run outside the sandbox: no reason given'), { reason: 'no reason given' })
  assert.deepEqual(skippedParts(''), { reason: '' })
})

test('optionText: the name, then what the list would show beside it', () => {
  assert.equal(optionText(project()), 'acme/widget (ready)')
  assert.equal(optionText(project({ status: { state: 'failed', message: 'x', at: 1, setupSkipped: null } })), 'acme/widget (failed)')
  assert.equal(
    optionText(project({ status: { state: 'ready', message: null, at: 1, setupSkipped: 'setup was skipped' } })),
    'acme/widget (ready, setup skipped)',
  )
})

test('retryHint: a ready project onboards again, with what that does; others just try again', () => {
  assert.match(retryHint('ready'), /adopts the clone/)
  assert.match(retryHint('ready'), /skips setup/)
  assert.match(retryHint('ready'), /workspace you removed/)
  assert.equal(retryHint('failed'), 'Try onboarding again.')
})

test('fieldValue: texts as they are, what is left out in words, and the environment as NAME=value', () => {
  const entry = fields({ setup: 'pnpm install', gateEnv: { B: '2', A: '1' } })
  assert.equal(fieldValue('family', entry), 'acme')
  assert.equal(fieldValue('setup', entry), 'pnpm install')
  assert.equal(fieldValue('setup', fields()), 'none')
  assert.equal(fieldValue('setupTimeout', fields()), 'default (15m)')
  assert.equal(fieldValue('setupTimeout', fields({ setupTimeout: '20m' })), '20m')
  assert.equal(fieldValue('gateEnv', fields()), 'none')
  assert.equal(fieldValue('gateEnv', entry), 'A=1, B=2')
})

test('changedFields: only what differs, in the form\'s order, as it was and as it is', () => {
  const before = fields({ gate: 'pnpm test', gateEnv: { CI: '1' } })
  const after = fields({ gate: 'pnpm test:all', setup: 'pnpm install', gateEnv: { CI: '1', LANG: 'C' } })
  assert.deepEqual(changedFields(before, after), [
    { label: 'Gate', was: 'pnpm test', now: 'pnpm test:all' },
    { label: 'Setup', was: 'none', now: 'pnpm install' },
    { label: 'Gate environment', was: 'CI=1', now: 'CI=1, LANG=C' },
  ])
  assert.deepEqual(changedFields(before, before), [])
  assert.deepEqual(changedFields(fields({ gateEnv: { A: '1', B: '2' } }), fields({ gateEnv: { B: '2', A: '1' } })), [], 'order is not a change')
})

test('changedFields against nothing lists every setting that is set', () => {
  assert.deepEqual(changedFields(null, fields({ setup: 'make' })), [
    { label: 'Family', was: '', now: 'acme' },
    { label: 'Role', was: '', now: 'the widget' },
    { label: 'Gate', was: '', now: 'pnpm test' },
    { label: 'Gate timeout', was: '', now: '10m' },
    { label: 'Setup', was: '', now: 'make' },
  ])
})

test('thenText says where a discard goes', () => {
  const cases: Array<[Then, string]> = [
    [{ to: 'select', name: 'acme/widget' }, 'open acme/widget'],
    [{ to: 'edit', name: 'acme/widget' }, 'edit acme/widget'],
    [{ to: 'add' }, 'start a new project'],
  ]
  for (const [then, text] of cases) assert.equal(thenText(then), text)
})
