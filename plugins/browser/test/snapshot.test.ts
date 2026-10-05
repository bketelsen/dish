/**
 * `snapshot.ts`: a page's aria snapshot made fit for a result. A password field's value is blanked, by the element's type
 * (the check the caller gives), secrets are masked, and the text is cut at a line end.
 *
 * The snapshot lines here are in the shape playwright-core 1.63.0's renderer gives them (`renderAriaSnapshotAsYaml` in the
 * injected script): `- role "name" [attrs]: value`, the key in single quotes when it needs them, and a textbox with a
 * placeholder as a block, its value on a `- text:` line under the placeholder.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PASSWORD_CHECKS } from '../src/types.ts'
import { elementOf, processSnapshot, REF } from '../src/snapshot.ts'

const TOKEN = `ghp_${'A1b2C3d4E5'.repeat(4)}`
const PASSWORD = '(a password field; its value isn\'t shown)'
const UNCHECKED = '(its value isn\'t shown)'

/** A check that knows the given refs as password fields, and records what it was asked. */
function checker(passwords: readonly string[], fail: readonly string[] = []) {
  const asked: string[] = []
  const isPassword = async (ref: string): Promise<boolean> => {
    asked.push(ref)
    if (fail.includes(ref)) throw new Error('the frame is gone')
    return passwords.includes(ref)
  }
  return { asked, isPassword }
}

const FORM = [
  '- generic [ref=e1]:',
  '  - heading "Sign in" [level=1] [ref=e2]',
  '  - textbox "Name" [ref=e3]: alice',
  '  - textbox "Password" [ref=e5]: hunter2-SECRET',
  '  - button "Sign in" [ref=e6] [cursor=pointer]',
].join('\n')

test('REF is the form Playwright gives a ref, in a frame or not', () => {
  for (const ref of ['e7', 'e123', 'f1e5', 'f12e3']) assert.ok(REF.test(ref), ref)
  for (const ref of ['', '7', 'e', 'E7', 'f1', 'fe7', 'e7 ', 'e7]', 'ref=e7', 'f1e5e6', 'e-1']) assert.ok(!REF.test(ref), ref)
})

test('a password field\'s value is blanked; a text field\'s is kept', async () => {
  const { asked, isPassword } = checker(['e5'])
  const result = await processSnapshot(FORM, isPassword, 30_000)
  assert.equal(result.text, [
    '- generic [ref=e1]:',
    '  - heading "Sign in" [level=1] [ref=e2]',
    '  - textbox "Name" [ref=e3]: alice',
    `  - textbox "Password" [ref=e5] ${PASSWORD}`,
    '  - button "Sign in" [ref=e6] [cursor=pointer]',
  ].join('\n'))
  assert.ok(!result.text.includes('hunter2'))
  assert.deepEqual(asked.sort(), ['e3', 'e5'], 'only textbox lines with a value are checked')
  assert.equal(result.cut, false)
  assert.equal(result.total, result.text.length)
})

test('a check that rejects blanks the value as a password', async () => {
  const { isPassword } = checker([], ['e3'])
  const result = await processSnapshot(FORM, isPassword, 30_000)
  assert.ok(result.text.includes(`  - textbox "Name" [ref=e3] ${PASSWORD}`))
  assert.ok(!result.text.includes('alice'))
})

test('a check that throws at once, or answers something other than false, blanks too', async () => {
  const throwing = (_ref: string): Promise<boolean> => { throw new Error('sync') }
  const result = await processSnapshot('- textbox "Name" [ref=e3]: alice', throwing, 30_000)
  assert.equal(result.text, `- textbox "Name" [ref=e3] ${PASSWORD}`)
  const odd = async (_ref: string) => undefined as unknown as boolean
  assert.equal((await processSnapshot('- textbox "Name" [ref=e3]: alice', odd, 30_000)).text, `- textbox "Name" [ref=e3] ${PASSWORD}`)
})

test('an iframe\'s ref (f1e5) is checked as it is', async () => {
  const raw = [
    '- iframe [ref=e4]:',
    '  - textbox "Card PIN" [ref=f1e5]: 4321',
    '  - textbox "Card name" [ref=f1e6]: Alice',
  ].join('\n')
  const { asked, isPassword } = checker(['f1e5'])
  const result = await processSnapshot(raw, isPassword, 30_000)
  assert.deepEqual(asked.sort(), ['f1e5', 'f1e6'])
  assert.equal(result.text, [
    '- iframe [ref=e4]:',
    `  - textbox "Card PIN" [ref=f1e5] ${PASSWORD}`,
    '  - textbox "Card name" [ref=f1e6]: Alice',
  ].join('\n'))
})

test(`the first ${PASSWORD_CHECKS} textboxes are checked; the rest are blanked unchecked`, async () => {
  const lines = Array.from({ length: PASSWORD_CHECKS + 1 }, (_, i) => `- textbox "Field ${i}" [ref=e${i + 1}]: value ${i}`)
  const { asked, isPassword } = checker([])
  const result = await processSnapshot(lines.join('\n'), isPassword, 1_000_000)
  assert.equal(asked.length, PASSWORD_CHECKS)
  assert.ok(!asked.includes(`e${PASSWORD_CHECKS + 1}`))
  const out = result.text.split('\n')
  assert.equal(out[0], '- textbox "Field 0" [ref=e1]: value 0')
  assert.equal(out[PASSWORD_CHECKS - 1], `- textbox "Field ${PASSWORD_CHECKS - 1}" [ref=e${PASSWORD_CHECKS}]: value ${PASSWORD_CHECKS - 1}`)
  assert.equal(out[PASSWORD_CHECKS], `- textbox "Field ${PASSWORD_CHECKS}" [ref=e${PASSWORD_CHECKS + 1}] ${UNCHECKED}`)
})

test('the checks run in parallel', async () => {
  let running = 0
  let most = 0
  const isPassword = async (_ref: string) => {
    running++
    most = Math.max(most, running)
    await new Promise(resolve => setImmediate(resolve))
    running--
    return false
  }
  await processSnapshot(FORM, isPassword, 30_000)
  assert.equal(most, 2)
})

test('a textbox with a placeholder (its value on a text line below) is blanked too', async () => {
  const raw = [
    '- textbox "Password" [ref=e5]:',
    '  - /placeholder: Your password',
    '  - text: hunter2-SECRET',
    '- textbox "Email" [ref=e6]:',
    '  - /placeholder: you@example.com',
    '  - text: alice@example.com',
    '- textbox "Empty" [ref=e7]:',
    '  - /placeholder: Nothing yet',
    '- button "Go" [ref=e8]',
  ].join('\n')
  const { asked, isPassword } = checker(['e5'])
  const result = await processSnapshot(raw, isPassword, 30_000)
  assert.deepEqual(asked.sort(), ['e5', 'e6'], 'a block with no text line has no value to check')
  assert.equal(result.text, [
    `- textbox "Password" [ref=e5] ${PASSWORD}:`,
    '  - /placeholder: Your password',
    '- textbox "Email" [ref=e6]:',
    '  - /placeholder: you@example.com',
    '  - text: alice@example.com',
    '- textbox "Empty" [ref=e7]:',
    '  - /placeholder: Nothing yet',
    '- button "Go" [ref=e8]',
  ].join('\n'))
})

test('a key in single quotes (a name with ": " in it) is still found', async () => {
  const raw = [
    `- 'textbox "Password: at least 8" [ref=e5]': hunter2-SECRET`,
    `- 'textbox "It''s: yours" [active] [ref=e6]':`,
    '  - /placeholder: pin',
    '  - text: "1234"',
  ].join('\n')
  const { asked, isPassword } = checker(['e5', 'e6'])
  const result = await processSnapshot(raw, isPassword, 30_000)
  assert.deepEqual(asked.sort(), ['e5', 'e6'])
  assert.equal(result.text, [
    `- 'textbox "Password: at least 8" [ref=e5]' ${PASSWORD}`,
    `- 'textbox "It''s: yours" [active] [ref=e6]' ${PASSWORD}:`,
    '  - /placeholder: pin',
  ].join('\n'))
})

test('a name\'s own "[ref=…]" text is not taken for the ref', async () => {
  const { asked, isPassword } = checker(['e5'])
  const result = await processSnapshot('- textbox "see [ref=e9]" [ref=e5]: hunter2', isPassword, 30_000)
  assert.deepEqual(asked, ['e5'])
  assert.equal(result.text, `- textbox "see [ref=e9]" [ref=e5] ${PASSWORD}`)
})

test('a textbox with a value and no ref (covered, or not visible) is blanked without a check', async () => {
  const raw = [
    '- textbox "Password": hunter2-SECRET',
    '- textbox "Pin":',
    '  - /placeholder: pin',
    '  - text: "4321"',
    '- textbox "Name" [ref=e3]: alice',
  ].join('\n')
  const { asked, isPassword } = checker([])
  const result = await processSnapshot(raw, isPassword, 30_000)
  assert.deepEqual(asked, ['e3'])
  assert.equal(result.text, [
    `- textbox "Password" ${UNCHECKED}`,
    `- textbox "Pin" ${UNCHECKED}:`,
    '  - /placeholder: pin',
    '- textbox "Name" [ref=e3]: alice',
  ].join('\n'))
})

test('a textbox line in a shape the rules don\'t know loses everything after its role', async () => {
  const { isPassword } = checker([])
  const result = await processSnapshot('  - textbox "unclosed [ref=e5]: hunter2', isPassword, 30_000)
  assert.equal(result.text, `  - textbox ${UNCHECKED}`)
})

test('a textbox with no value, other roles, and text lines are left alone', async () => {
  const raw = [
    '- textbox "Search" [ref=e2]',
    `- 'textbox "Password: at least 8" [ref=e4]'`,
    '- slider "Volume" [ref=e3]: "50"',
    '- text: "textbox \\"x\\" [ref=e9]: not a field"',
    '- paragraph: "- textbox: inside a paragraph"',
  ].join('\n')
  const { asked, isPassword } = checker(['e2', 'e3'])
  const result = await processSnapshot(raw, isPassword, 30_000)
  assert.deepEqual(asked, [])
  assert.equal(result.text, raw)
})

test('a password input under another role (searchbox, combobox, spinbutton) is checked and blanked the same way', async () => {
  const raw = [
    '- searchbox "Password" [ref=e6]: hunter2',
    '- combobox "PIN" [ref=e7]: "1234"',
    `- 'spinbutton "Code: 6 digits" [ref=e8]': "987654"`,
    '- searchbox "Find" [ref=e9]: cats',
    '- searchbox "Hidden": hunter3',
    '- combobox "Country" [ref=e10]:',
    '  - option "France" [selected]',
    '  - option "Germany"',
  ].join('\n')
  const { asked, isPassword } = checker(['e6', 'e7', 'e8'])
  const result = await processSnapshot(raw, isPassword, 30_000)
  assert.deepEqual(asked.sort(), ['e6', 'e7', 'e8', 'e9'], 'one check per line with a value; a <select>\'s options are no value')
  assert.equal(result.text, [
    `- searchbox "Password" [ref=e6] ${PASSWORD}`,
    `- combobox "PIN" [ref=e7] ${PASSWORD}`,
    `- 'spinbutton "Code: 6 digits" [ref=e8]' ${PASSWORD}`,
    '- searchbox "Find" [ref=e9]: cats',
    `- searchbox "Hidden" ${UNCHECKED}`,
    '- combobox "Country" [ref=e10]:',
    '  - option "France" [selected]',
    '  - option "Germany"',
  ].join('\n'))
  for (const secret of ['hunter2', 'hunter3', '1234', '987654']) assert.ok(!result.text.includes(secret), secret)
})

test('a name written /like this/ is a name: the value after it is checked, and kept when it isn\'t a password', async () => {
  const raw = [
    '- textbox /re/ [ref=e5]: hunter2',
    '- textbox /path/ [ref=e6]: /usr/bin/x',
    `- 'textbox /a: b/ [active] [ref=e7]': pw-three`,
  ].join('\n')
  const { asked, isPassword } = checker(['e5', 'e7'])
  const result = await processSnapshot(raw, isPassword, 30_000)
  assert.deepEqual(asked.sort(), ['e5', 'e6', 'e7'])
  assert.equal(result.text, [
    `- textbox /re/ [ref=e5] ${PASSWORD}`,
    '- textbox /path/ [ref=e6]: /usr/bin/x',
    `- 'textbox /a: b/ [active] [ref=e7]' ${PASSWORD}`,
  ].join('\n'))
  assert.equal(elementOf(raw, 'e6'), 'textbox "/path/" [ref=e6]')
})

test('a name that is a lone "/" ends at the slash: no part of the value is kept', async () => {
  const raw = [
    '- textbox / [ref=e5]: "hunter2/: rest"',
    '- textbox /: "pw-two/ [ref=e9]: x"',
    '- textbox / [ref=e6]:',
    '  - /placeholder: pin',
    '  - text: pw-three/',
  ].join('\n')
  const { asked, isPassword } = checker(['e5', 'e6'])
  const result = await processSnapshot(raw, isPassword, 30_000)
  assert.deepEqual(asked.sort(), ['e5', 'e6'])
  assert.equal(result.text, [
    `- textbox / [ref=e5] ${PASSWORD}`,
    `- textbox / ${UNCHECKED}`,
    `- textbox / [ref=e6] ${PASSWORD}:`,
    '  - /placeholder: pin',
  ].join('\n'))
  for (const secret of ['hunter2', 'pw-two', 'pw-three']) assert.ok(!result.text.includes(secret), secret)
})

test('a hostile line of ~300,000 characters (or ~1,000,000) is processed in well under 200 ms', async () => {
  const shapes = [
    `- textbox / [ref=e5]: ${'/ ['.repeat(100_000)}]x`,
    `- textbox / [ref=e5]: ${`/${' [a]'.repeat(50)}`.repeat(1_500)}x`,
    `- textbox / [ref=e5]: ${`/ [a=${'b'.repeat(20)}`.repeat(12_000)}`,
    `- textbox /${'/'.repeat(900)}${' [a]'.repeat(75_000)}`,
    `- textbox "${'\\"'.repeat(150_000)}`,
    // A million characters for these two, whose cost would grow with the line only a few hundred times over: every name
    // that ends at a `/` in the first 900 characters scanning on to a line separator, which `.` doesn't match, or to the
    // end of an attribute with no `]`.
    `- textbox /${'/: '.repeat(333_000)} x`,
    `- textbox /${'/ ['.repeat(333_000)}x`,
  ]
  for (const line of shapes) {
    assert.ok(line.length > 250_000 && line.length < 1_100_000, `${line.length}`)
    let started = performance.now()
    const result = await processSnapshot(line, async () => true, 30_000)
    const processMs = performance.now() - started
    assert.ok(processMs < 200, `processSnapshot took ${processMs.toFixed(0)} ms on ${line.slice(0, 30)}…`)
    assert.ok(!result.text.includes('x\n') && result.text.length <= 30_000)
    started = performance.now()
    // The ref at the end, so the line is one elementOf parses.
    elementOf(`${line.replace('textbox', 'button')} [ref=e5]`, 'e5')
    const elementMs = performance.now() - started
    assert.ok(elementMs < 200, `elementOf took ${elementMs.toFixed(0)} ms on ${line.slice(0, 30)}…`)
  }
})

test('a block\'s value is its first child line, or the second after a placeholder: nothing deeper is looked at', async () => {
  const raw = [
    '- textbox "Editor" [ref=e3]:',
    '  - paragraph: one',
    '  - text: two',
    '- textbox "Notes" [ref=e4]:',
    '  - text: first',
    '- textbox "Pin" [ref=e5]:',
    '  - /placeholder: pin',
    '  - paragraph: not a value',
    '  - text: three',
  ].join('\n')
  const { asked, isPassword } = checker(['e3', 'e4', 'e5'])
  const result = await processSnapshot(raw, isPassword, 30_000)
  assert.deepEqual(asked, ['e4'])
  assert.equal(result.text, [
    '- textbox "Editor" [ref=e3]:',
    '  - paragraph: one',
    '  - text: two',
    `- textbox "Notes" [ref=e4] ${PASSWORD}:`,
    '- textbox "Pin" [ref=e5]:',
    '  - /placeholder: pin',
    '  - paragraph: not a value',
    '  - text: three',
  ].join('\n'))
})

test('nested textbox blocks cost time in proportion to the snapshot, not more', async () => {
  const depth = 2_000
  const lines: string[] = []
  for (let i = 0; i < depth; i++) lines.push(`${'  '.repeat(i)}- textbox:`)
  for (let i = depth - 1; i >= 0; i--) lines.push(`${'  '.repeat(i + 1)}- text: tail`)
  const raw = lines.join('\n')
  assert.ok(raw.length > 8_000_000)
  const started = performance.now()
  const result = await processSnapshot(raw, async () => false, 30_000)
  const ms = performance.now() - started
  assert.ok(ms < 1_000, `${ms.toFixed(0)} ms`)
  assert.equal(result.cut, true)
})

test('elementOf knows a line processSnapshot blanked', async () => {
  const raw = [
    '- textbox "Password" [ref=e5]: hunter2',
    '- textbox "Pin" [ref=e6]:',
    '  - /placeholder: pin',
    '  - text: "1234"',
    `- 'searchbox "Key: here" [ref=e7]': secret`,
    ...Array.from({ length: PASSWORD_CHECKS }, (_, i) => `- textbox "F${i}" [ref=e${100 + i}]: v`),
    '- textbox "Last" [ref=e9]: past the checks',
  ].join('\n')
  const processed = (await processSnapshot(raw, async ref => ['e5', 'e6', 'e7'].includes(ref), 1_000_000)).text
  assert.ok(processed.includes(`- textbox "Last" [ref=e9] ${UNCHECKED}`))
  assert.equal(elementOf(processed, 'e5'), 'textbox "Password" [ref=e5]')
  assert.equal(elementOf(processed, 'e6'), 'textbox "Pin" [ref=e6]')
  assert.equal(elementOf(processed, 'e7'), 'searchbox "Key: here" [ref=e7]')
  assert.equal(elementOf(processed, 'e9'), 'textbox "Last" [ref=e9]')
})

test('secrets are masked, after the password fields', async () => {
  const raw = `- link "Docs" [ref=e2]:\n  - /url: https://example.com/?token=${TOKEN}\n- textbox "Token" [ref=e3]: ${TOKEN}`
  const { isPassword } = checker([])
  const result = await processSnapshot(raw, isPassword, 30_000)
  assert.ok(!result.text.includes(TOKEN))
  assert.ok(result.text.includes('/url: https://example.com/?token=‹secret: a GitHub token›'))
  assert.ok(result.text.includes('- textbox "Token" [ref=e3]: ‹secret: a GitHub token›'))
  assert.equal(result.total, result.text.length)
})

test('the cut: at a line end past half, total and cut set', async () => {
  const lines = Array.from({ length: 100 }, (_, i) => `- listitem [ref=e${i}]: item number ${String(i).padStart(3, '0')}`)
  const raw = lines.join('\n')
  const { isPassword } = checker([])
  const max = 1000
  const result = await processSnapshot(raw, isPassword, max)
  assert.equal(result.cut, true)
  assert.equal(result.total, raw.length)
  assert.ok(result.text.length <= max)
  assert.ok(result.text.length > max / 2)
  assert.ok(raw.startsWith(result.text))
  assert.equal(raw[result.text.length], '\n', 'it ends where a line ended')
  assert.equal(result.text.split('\n').at(-1), lines[result.text.split('\n').length - 1], 'the last line is whole')
})

test('the cut: a text exactly at max is not cut; a newline right at max counts', async () => {
  const { isPassword } = checker([])
  const exact = await processSnapshot('x'.repeat(50), isPassword, 50)
  assert.deepEqual(exact, { text: 'x'.repeat(50), total: 50, cut: false })
  const atMax = await processSnapshot(`${'x'.repeat(50)}\nmore`, isPassword, 50)
  assert.deepEqual(atMax, { text: 'x'.repeat(50), total: 55, cut: true })
})

test('the cut: a single long line, or a line end before half, is cut at max', async () => {
  const { isPassword } = checker([])
  const long = await processSnapshot(`- text: ${'y'.repeat(5000)}`, isPassword, 1000)
  assert.equal(long.text.length, 1000)
  assert.equal(long.cut, true)
  assert.equal(long.total, 5008)
  const early = await processSnapshot(`- a\n${'z'.repeat(5000)}`, isPassword, 1000)
  assert.equal(early.text.length, 1000)
  assert.ok(early.text.startsWith('- a\nzzz'))
})

test('the cut never leaves half a surrogate pair', async () => {
  const { isPassword } = checker([])
  const result = await processSnapshot(`${'a'.repeat(9)}🙂${'b'.repeat(20)}`, isPassword, 10)
  assert.equal(result.text, 'a'.repeat(9))
})

test('elementOf: a ref\'s words from its line, or the ref alone', () => {
  const snapshot = [
    '- generic [ref=e1]:',
    '  - button "Save" [ref=e14] [cursor=pointer]',
    '  - link "see [ref=e2]" [ref=e3]:',
    '    - /url: /x',
    `  - 'textbox "It''s: here" [active] [ref=e4]': hello`,
    '  - checkbox [checked] [ref=f1e7]',
  ].join('\n')
  assert.equal(elementOf(snapshot, 'e14'), 'button "Save" [ref=e14]')
  assert.equal(elementOf(snapshot, 'e3'), 'link "see [ref=e2]" [ref=e3]')
  assert.equal(elementOf(snapshot, 'e2'), '[ref=e2]', 'a ref named only inside a name is not found')
  assert.equal(elementOf(snapshot, 'e4'), 'textbox "It\'s: here" [ref=e4]')
  assert.equal(elementOf(snapshot, 'f1e7'), 'checkbox [ref=f1e7]')
  assert.equal(elementOf(snapshot, 'e99'), '[ref=e99]')
  assert.equal(elementOf(undefined, 'e7'), '[ref=e7]')
})

test('elementOf: cut to 120, keeping the ref, masked and on one line', () => {
  const long = `- button "${'Long name '.repeat(30)}" [ref=e9]`
  const words = elementOf(long, 'e9')
  assert.ok(words.length <= 120, `${words.length}`)
  assert.ok(words.startsWith('button "Long name Long'))
  assert.ok(words.endsWith('…" [ref=e9]'))
  const secret = elementOf(`- button "${TOKEN}\\nnext" [ref=e9]`, 'e9')
  assert.equal(secret, 'button "‹secret: a GitHub token› next" [ref=e9]')
})
