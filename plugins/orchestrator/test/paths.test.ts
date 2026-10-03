/**
 * The pure helpers: `paths.ts` (where records and ledgers go, run ids and refs) and `text.ts` (the wording helpers the
 * store, the ledger and the tools share).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ledgerFile, parseRef, recordFile, RUN_ID, runId, runRef, SEGMENT, SLUG, splitProject,
} from '../src/paths.ts'
import { age, cut, given, hasRuling, oneLine, RULING_FORM, rulingBody, shortSession, shortSha } from '../src/text.ts'
import { DAY, HOUR, MINUTE, NOW } from './helpers.ts'

// --- text -------------------------------------------------------------------------------------------------------------

test('given: blanks are absent, a value is trimmed', () => {
  assert.equal(given(undefined), undefined)
  assert.equal(given(''), undefined)
  assert.equal(given('  \n\t '), undefined)
  assert.equal(given('  owner/repo \n'), 'owner/repo')
})

test('oneLine folds runs of whitespace, line breaks among them, into one space', () => {
  assert.equal(oneLine('  fix\n\nthe   login\tredirect \r\n'), 'fix the login redirect')
  assert.equal(oneLine(''), '')
})

test('cut keeps at most max UTF-16 units, with … when it cut, and never half a surrogate pair', () => {
  assert.equal(cut('short', 10), 'short')
  assert.equal(cut('exactly10!', 10), 'exactly10!')
  assert.equal(cut('abcdefghijk', 10), 'abcdefghi…')
  assert.equal(cut('abcdefghijk', 10).length, 10)
  // The emoji is two units, at 8 and 9: a cut at 9 units would split it, so it goes whole.
  const text = `abcdefgh😀xyz`
  const result = cut(text, 10)
  assert.equal(result, 'abcdefgh…')
  assert.ok(result.length <= 10)
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(result), 'no lone high surrogate')
  // The emoji fits whole when the cut falls after it.
  assert.equal(cut(text, 11), 'abcdefgh😀…')
  assert.equal(cut('abc', 0), '')
  assert.equal(cut('abc', 1), '…')
})

test('hasRuling: something past Ruling:, not the placeholder', () => {
  assert.equal(RULING_FORM, 'Ruling: what — why — cost if wrong')
  assert.equal(hasRuling('Ruling:'), false)
  assert.equal(hasRuling('  Ruling:  '), false)
  assert.equal(hasRuling('**Ruling:** — —'), false)
  assert.equal(hasRuling(RULING_FORM), false)
  assert.equal(hasRuling('ruling: WHAT — WHY — COST IF WRONG'), false)
  assert.equal(hasRuling('what — why — cost if wrong'), false)
  assert.equal(hasRuling('**Ruling:** x — y — z'), true)
  assert.equal(hasRuling('Ruling: ship it — the flake is known — a revert'), true)
  assert.equal(hasRuling('ship it — the flake is known — a revert'), true)
})

test('rulingBody: one line, with a leading Ruling: and its marks taken off', () => {
  assert.equal(rulingBody('**Ruling:** x — y — z'), 'x — y — z')
  assert.equal(rulingBody('Ruling: ship it —\n the flake —\n a revert '), 'ship it — the flake — a revert')
  assert.equal(rulingBody('> _ruling_: keep it'), 'keep it')
  assert.equal(rulingBody('keep it — fine — none'), 'keep it — fine — none')
  // Only a leading one.
  assert.equal(rulingBody('keep the Ruling: header'), 'keep the Ruling: header')
})

test('shortSha and shortSession', () => {
  assert.equal(shortSha('0123456789abcdef'), '0123456')
  assert.equal(shortSha('abc'), 'abc')
  assert.equal(shortSession('1234567890'), '12345678…')
  assert.equal(shortSession('12345678'), '12345678')
  assert.equal(shortSession('42'), '42')
})

test('age at each boundary', () => {
  assert.equal(age(NOW, NOW), 'just now')
  assert.equal(age(NOW + MINUTE, NOW), 'just now', 'a time ahead of now')
  assert.equal(age(NOW - MINUTE + 1, NOW), 'just now')
  assert.equal(age(NOW - MINUTE, NOW), '1 min ago')
  assert.equal(age(NOW - 12 * MINUTE, NOW), '12 min ago')
  assert.equal(age(NOW - HOUR + 1, NOW), '59 min ago')
  assert.equal(age(NOW - HOUR, NOW), '1 h ago')
  assert.equal(age(NOW - 5 * HOUR, NOW), '5 h ago')
  assert.equal(age(NOW - 48 * HOUR + 1, NOW), '47 h ago')
  assert.equal(age(NOW - 48 * HOUR, NOW), '2 days ago')
  assert.equal(age(NOW - 3 * DAY, NOW), '3 days ago')
  assert.equal(age(NOW - 30 * DAY + 1, NOW), '29 days ago')
  assert.equal(age(NOW - 30 * DAY, NOW), '2026-09-03')
})

// --- paths ------------------------------------------------------------------------------------------------------------

test('the record and the ledger of a run', () => {
  assert.equal(recordFile('/s/dish', 'Acme/widget.js', '20261003-fix-login'), '/s/dish/orchestrator/Acme/widget.js/runs/20261003-fix-login.json')
  assert.equal(ledgerFile('/d/dish', 'Acme/widget.js', '20261003-fix-login-2'), '/d/dish/ledgers/Acme/widget.js/20261003-fix-login-2.jsonl')
})

test('splitProject takes owner/repo, each one segment', () => {
  assert.deepEqual(splitProject('Acme/widget'), { owner: 'Acme', repo: 'widget' })
  assert.deepEqual(splitProject('a-b_c.d/e.f-g_h'), { owner: 'a-b_c.d', repo: 'e.f-g_h' })
  for (const bad of ['', 'acme', 'a/b/c', '/b', 'a/', '../b', 'a/..', './b', 'a/.', 'a b/c', 'a\\b/c', 'a\0/b', 'a\n/b', 'ä/b']) {
    assert.throws(() => splitProject(bad), TypeError, JSON.stringify(bad))
  }
  assert.throws(() => splitProject(42 as unknown as string), TypeError)
})

test('a path is refused, never joined, for a bad project or id', () => {
  for (const project of ['..', '.', 'a/b/c', 'a/b/../c', '../x/y', 'a//b']) {
    assert.throws(() => recordFile('/s', project, '20261003-x'), TypeError, project)
    assert.throws(() => ledgerFile('/d', project, '20261003-x'), TypeError, project)
    assert.throws(() => runRef(project, '20261003-x'), TypeError, project)
  }
  for (const id of ['', '..', 'x', '2026103-x', '20261003-', '20261003-X', '20261003-a/b', '20261003-../x', '../20261003-x',
    `20261003-${'a'.repeat(51)}`, '20261003--x']) {
    assert.throws(() => recordFile('/s', 'Acme/widget', id), TypeError, id)
    assert.throws(() => ledgerFile('/d', 'Acme/widget', id), TypeError, id)
    assert.throws(() => runRef('Acme/widget', id), TypeError, id)
  }
})

test('SEGMENT, SLUG and RUN_ID', () => {
  assert.ok(SEGMENT.test('a.b-c_d'))
  assert.ok(!SEGMENT.test('.'))
  assert.ok(!SEGMENT.test('..'))
  assert.ok(SEGMENT.test('...'))
  assert.ok(SEGMENT.test('.github'))
  assert.ok(!SEGMENT.test('a/b'))
  assert.ok(SLUG.test('fix-1'))
  assert.ok(SLUG.test('a'.repeat(40)))
  assert.ok(!SLUG.test('a'.repeat(41)))
  assert.ok(!SLUG.test('-x'))
  assert.ok(!SLUG.test('Fix'))
  assert.ok(RUN_ID.test(`20261003-${'a'.repeat(40)}-99`))
  assert.ok(!RUN_ID.test('20261003'))
})

test('runRef and parseRef, both ways', () => {
  const ref = runRef('Acme/widget', '20261003-fix-login')
  assert.equal(ref, 'Acme/widget/20261003-fix-login')
  assert.deepEqual(parseRef(ref), { project: 'Acme/widget', id: '20261003-fix-login' })
  assert.deepEqual(parseRef('o/r/20261003-a-2'), { project: 'o/r', id: '20261003-a-2' })
})

test('parseRef of junk is undefined', () => {
  for (const junk of [undefined, null, 42, {}, '', 'Acme/widget', '20261003-fix', 'a/b/c/20261003-x', '../b/20261003-x',
    'a/../20261003-x', 'a/b/../x', 'a/b/20261003-X', 'a/b/20261003-x/', ' a/b/20261003-x']) {
    assert.equal(parseRef(junk), undefined, JSON.stringify(junk))
  }
})

test('runId: the UTC date of at, then -2, -3, …', () => {
  const nearMidnight = Date.UTC(2026, 9, 3, 23, 59, 59, 999)
  assert.equal(runId('fix', nearMidnight, () => false), '20261003-fix')
  assert.equal(runId('fix', nearMidnight + 1, () => false), '20261004-fix')
  // Just after midnight UTC is still the day before in the Americas: the id is UTC's.
  assert.equal(runId('fix', Date.UTC(2026, 0, 1, 0, 0, 0, 1), () => false), '20260101-fix')
  const taken = new Set(['20261003-fix'])
  assert.equal(runId('fix', NOW, id => taken.has(id)), '20261003-fix-2')
  taken.add('20261003-fix-2')
  assert.equal(runId('fix', NOW, id => taken.has(id)), '20261003-fix-3')
  assert.throws(() => runId('Bad slug', NOW, () => false), TypeError)
  assert.throws(() => runId('fix', Number.NaN, () => false), TypeError)
})
