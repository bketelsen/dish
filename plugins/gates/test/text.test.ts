import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONTEXT_SUMMARY_MAX_CHARS } from '@deepseek-ai/dsh-llm'
import { maskSecrets } from 'dish-kit'
import {
  BLOCKED_REASON, DEFAULT_TAIL_LINES, EXCERPT_LINES, EXCERPT_MAX_CHARS, SUMMARY_MAX_CHARS, TAIL_MAX_BYTES,
  duration, excerptOf, failureMessage, failureSummary, fenced, tailOf,
} from '../src/text.ts'
import type { Failure } from '../src/text.ts'

const lines = (count: number, make = (n: number) => `line ${n}`): string =>
  Array.from({ length: count }, (_, i) => make(i + 1)).join('\n')

// --- tailOf -----------------------------------------------------------------------------------------

test('the constants are the plan\'s', () => {
  assert.equal(TAIL_MAX_BYTES, 16_384)
  assert.equal(DEFAULT_TAIL_LINES, 200)
  assert.equal(EXCERPT_LINES, 10)
  assert.equal(EXCERPT_MAX_CHARS, 1000)
  assert.equal(SUMMARY_MAX_CHARS, 120)
  assert.equal(SUMMARY_MAX_CHARS, CONTEXT_SUMMARY_MAX_CHARS, 'dsh bounds a notice summary at the same length')
  assert.equal(BLOCKED_REASON, 'the coder reported BLOCKED / NEEDS CONTEXT')
})

test('tailOf keeps the last lines', () => {
  assert.equal(tailOf(lines(10), 3), 'line 8\nline 9\nline 10')
  assert.equal(tailOf(lines(3), 3), lines(3))
  assert.equal(tailOf(lines(3), 50), lines(3), 'fewer lines than the limit: all of them')
  assert.equal(tailOf(lines(10), 1), 'line 10')
})

test('tailOf: a final newline is not a line', () => {
  assert.equal(tailOf(`${lines(10)}\n`, 3), 'line 8\nline 9\nline 10')
  assert.equal(tailOf('a\n', 5), 'a')
  assert.equal(tailOf('a\n\n', 1), '', 'a blank last line is a line')
  assert.equal(tailOf('a\n\nb\n', 2), '\nb')
})

test('tailOf: empty output, and a limit of no lines', () => {
  assert.equal(tailOf('', 5), '')
  assert.equal(tailOf('\n', 5), '')
  assert.equal(tailOf(lines(5), 0), '', '0 lines is none, not all of them')
  assert.equal(tailOf(lines(5), -3), '')
  assert.equal(tailOf(lines(5), 3, 0), '')
})

test('tailOf cuts to the last bytes, at a character', () => {
  assert.equal(tailOf('abcdefghij', 5, 4), 'ghij')
  assert.equal(tailOf('abcdefghij', 5, 10), 'abcdefghij', 'exactly the limit: untouched')
  assert.equal(tailOf('abcdefghij', 5, 100), 'abcdefghij')
  // "é" is 2 bytes: 3 bytes of "aéé" are "éé"'s last 3, which starts inside the first é, so only the second é stays
  assert.equal(tailOf('aéé', 5, 3), 'é')
  assert.equal(tailOf('aéé', 5, 4), 'éé')
  assert.equal(tailOf('日本語', 5, 8), '本語', '3-byte characters, 8 bytes: two whole ones')
})

test('tailOf never cuts inside a surrogate pair', () => {
  const emoji = '\u{1F600}' // 4 bytes in UTF-8, two UTF-16 units
  const text = `ab${emoji}${emoji}${emoji}`
  for (let max = 0; max <= 16; max++) {
    // the oracle: the longest run of whole characters from the end that fits
    let expected = ''
    for (const char of [...text].reverse()) {
      if (Buffer.byteLength(char + expected) > max) break
      expected = char + expected
    }
    assert.equal(tailOf(text, 5, max), expected, `max ${max}`)
  }
  assert.equal(tailOf(`x${emoji}`, 5, 4), emoji)
  assert.equal(tailOf(`x${emoji}`, 5, 3), '')
  assert.equal(tailOf(`x${emoji}`, 5, 5), `x${emoji}`)
})

test('tailOf applies the line limit, then the byte limit', () => {
  const output = lines(500, n => `${String(n).padStart(4, '0')} ${'x'.repeat(95)}`) // 100 characters a line
  const uncapped = tailOf(output, 200, 1_000_000)
  assert.equal(uncapped.split('\n').length, 200, '200 lines')
  assert.ok(Buffer.byteLength(uncapped) > TAIL_MAX_BYTES)
  assert.equal(uncapped, output.split('\n').slice(300).join('\n'))
  const capped = tailOf(output, 200, TAIL_MAX_BYTES)
  assert.equal(Buffer.byteLength(capped), TAIL_MAX_BYTES)
  assert.ok(uncapped.endsWith(capped), 'the cut keeps the end')
  assert.ok(capped.endsWith(`0500 ${'x'.repeat(95)}`))
  assert.equal(tailOf(output, 200), capped, 'the default byte limit is TAIL_MAX_BYTES')
})

test('tailOf: the default byte limit is 16 KiB', () => {
  const tail = tailOf('y'.repeat(50_000), 5)
  assert.equal(Buffer.byteLength(tail), TAIL_MAX_BYTES)
})

// --- excerptOf --------------------------------------------------------------------------------------

test('excerptOf is the last 10 lines, at most 1000 characters', () => {
  assert.equal(excerptOf(lines(30)), lines(30).split('\n').slice(20).join('\n'))
  assert.equal(excerptOf(`${lines(3)}\n`), lines(3))
  assert.equal(excerptOf(''), '')
  const long = excerptOf(lines(10, () => 'z'.repeat(500)))
  assert.equal(long.length, EXCERPT_MAX_CHARS)
  assert.ok(long.endsWith('z'))
})

test('excerptOf never cuts inside a surrogate pair', () => {
  const emoji = '\u{1F600}'
  const out = excerptOf(emoji.repeat(600)) // 1200 units
  assert.ok(out.length <= EXCERPT_MAX_CHARS)
  assert.equal(out, emoji.repeat(out.length / 2), 'only whole characters')
  assert.equal(out.length, 1000)
  const odd = excerptOf(`${emoji.repeat(600)}a`) // 1201 units: the cut would start at a low surrogate
  assert.equal(odd, `${emoji.repeat(499)}a`, 'the half pair is dropped')
})

// --- fenced -----------------------------------------------------------------------------------------

test('fenced wraps text in a code fence', () => {
  assert.equal(fenced('hello'), '```\nhello\n```')
  assert.equal(fenced('a\nb'), '```\na\nb\n```')
  assert.equal(fenced(''), '```\n\n```')
})

test('fenced uses a fence longer than any run of backticks inside', () => {
  assert.equal(fenced('use `x` here'), '```\nuse `x` here\n```', 'a run of one: three is enough')
  assert.equal(fenced('a\n```\nb'), '````\na\n```\nb\n````', 'a run of three: four')
  assert.equal(fenced('a\n````\nb'), '`````\na\n````\nb\n`````', 'a run of four: five')
  assert.equal(fenced('``` and ````` and ``'), '``````\n``` and ````` and ``\n``````', 'the longest run counts')
})

// --- duration ---------------------------------------------------------------------------------------

test('duration', () => {
  assert.equal(duration(0), '0 ms')
  assert.equal(duration(850), '850 ms')
  assert.equal(duration(999), '999 ms')
  assert.equal(duration(999.6), '1 s', 'rounding up to a second says a second')
  assert.equal(duration(1000), '1 s')
  assert.equal(duration(42_000), '42 s')
  assert.equal(duration(42_400), '42 s')
  assert.equal(duration(59_400), '59 s')
  assert.equal(duration(59_600), '1 min', 'rounding up to a minute says a minute')
  assert.equal(duration(60_000), '1 min')
  assert.equal(duration(185_000), '3 min 5 s')
  assert.equal(duration(180_000), '3 min')
  assert.equal(duration(600_000), '10 min')
  assert.equal(duration(-5), '0 ms')
  assert.equal(duration(Number.NaN), '0 ms')
  assert.equal(duration(Number.POSITIVE_INFINITY), '0 ms')
})

// --- failureMessage ---------------------------------------------------------------------------------

function failure(over: Partial<Failure> = {}): Failure {
  return {
    command: 'pnpm test', exitCode: 1, timedOut: false, timeoutMs: 600_000, durationMs: 42_000,
    tail: 'FAIL src/a.test.ts\n  expected 1, got 2', log: '/state/dish/gates/acme/widget/fix-1/c1-1-1.log',
    round: 1, maxRounds: 3, denied: false,
    ...over,
  }
}

const FIRST = (message: string): string => message.split('\n')[0]!
/** What is inside the message's (three-backtick) fence. */
const bodyOf = (message: string): string => /^```\n([\s\S]*?)\n```$/m.exec(message)![1]!

test('failureMessage: the first line for an exit code', () => {
  assert.equal(FIRST(failureMessage(failure())), 'The gate failed (round 1 of 3): `pnpm test` exited 1 after 42 s.')
  assert.equal(FIRST(failureMessage(failure({ exitCode: 137, durationMs: 3_900, round: 2 }))),
    'The gate failed (round 2 of 3): `pnpm test` exited 137 after 4 s.')
})

test('failureMessage: the first line for a timeout', () => {
  const message = failureMessage(failure({ timedOut: true, exitCode: null, timeoutMs: 600_000, durationMs: 600_120 }))
  assert.equal(FIRST(message), 'The gate failed (round 1 of 3): `pnpm test` was stopped at its time limit (10 min) after 10 min.')
  const withCode = failureMessage(failure({ timedOut: true, exitCode: 143, timeoutMs: 90_000, durationMs: 90_300 }))
  assert.equal(FIRST(withCode), 'The gate failed (round 1 of 3): `pnpm test` was stopped at its time limit (1 min 30 s) after 1 min 30 s.',
    'a timeout is a timeout, whatever code the stopped process left')
})

test('failureMessage: the first line when it was killed with no exit code', () => {
  const message = failureMessage(failure({ exitCode: null, durationMs: 8_000 }))
  assert.equal(FIRST(message), 'The gate failed (round 1 of 3): `pnpm test` was killed after 8 s, with no exit code.')
})

test('failureMessage: the command is shown whole on one line, whatever is in it', () => {
  const backticks = failureMessage(failure({ command: 'echo `date` && make' }))
  assert.equal(FIRST(backticks), 'The gate failed (round 1 of 3): `` echo `date` && make `` exited 1 after 42 s.')
  const multi = failureMessage(failure({ command: 'set -e\npnpm lint\r\n  pnpm test\n' }))
  assert.equal(FIRST(multi), 'The gate failed (round 1 of 3): `set -e ↵ pnpm lint ↵ pnpm test` exited 1 after 42 s.')
  const long = failureMessage(failure({ command: `make ${'x'.repeat(500)}` }))
  assert.ok(FIRST(long).length < 300, `${FIRST(long).length} characters`)
  assert.match(FIRST(long), /^The gate failed \(round 1 of 3\): `make x+…` exited 1 after 42 s\.$/)
})

test('failureMessage: a credential in the command is masked, before it is cut', () => {
  const token = `ghs_${'A1b2C3d4E5'.repeat(4)}`
  const message = failureMessage(failure({ command: `GH_TOKEN=${token} pnpm test` }))
  assert.ok(!message.includes(token))
  assert.ok(!message.includes('ghs_A1b2'))
  assert.equal(FIRST(message), `The gate failed (round 1 of 3): \`GH_TOKEN=${maskSecrets(token)} pnpm test\` exited 1 after 42 s.`)
  // Cut after masking: a cut in the token can't leave its start shown.
  const long = failureMessage(failure({ command: `${'x'.repeat(190)} ${token}` }))
  assert.ok(!long.includes('ghs_'), FIRST(long))
})

test('failureMessage: the output, fenced', () => {
  const message = failureMessage(failure({ tail: 'one\ntwo' }))
  assert.ok(message.includes('Last lines of its output:\n```\none\ntwo\n```\n'), message)
})

test('failureMessage: output that holds backticks and fences stays inside its fence', () => {
  const message = failureMessage(failure({ tail: 'before\n```\nafter' }))
  assert.ok(message.includes('Last lines of its output:\n````\nbefore\n```\nafter\n````\n'), message)
})

test('failureMessage: 500 lines of output give 200 in the message, within 16 KiB', () => {
  const output = lines(500)
  const message = failureMessage(failure({ tail: output }))
  const body = bodyOf(message)
  assert.equal(body.split('\n').length, DEFAULT_TAIL_LINES)
  assert.equal(body, output.split('\n').slice(300).join('\n'))
  assert.ok(message.includes('line 500\n```'))
  assert.ok(!message.includes('line 300\n'), 'line 300 is cut')
  assert.ok(message.includes('line 301\n'))
})

test('failureMessage: the line limit is the settings\' when the caller gives it', () => {
  const output = lines(500)
  assert.equal(bodyOf(failureMessage(failure({ tail: output, tailLines: 10 }))).split('\n').length, 10)
  assert.equal(bodyOf(failureMessage(failure({ tail: output, tailLines: 400 }))).split('\n').length, 400)
})

test('failureMessage: the output is at most 16 KiB', () => {
  const output = lines(500, n => `${String(n).padStart(4, '0')} ${'x'.repeat(995)}`) // 1 KB a line
  const message = failureMessage(failure({ tail: output }))
  const body = bodyOf(message)
  assert.ok(Buffer.byteLength(body) <= TAIL_MAX_BYTES, `${Buffer.byteLength(body)} bytes`)
  assert.ok(Buffer.byteLength(body) > TAIL_MAX_BYTES - 4)
  assert.ok(body.endsWith(`0500 ${'x'.repeat(995)}`), 'the end is kept')
  assert.ok(Buffer.byteLength(message) < TAIL_MAX_BYTES + 3_000, `the message is ${Buffer.byteLength(message)} bytes`)
})

test('failureMessage: no output', () => {
  for (const tail of ['', '\n', '  \n\n ']) {
    const message = failureMessage(failure({ tail }))
    assert.ok(message.includes('It printed nothing.'), JSON.stringify(tail))
    assert.ok(!message.includes('Last lines of its output:'))
    assert.ok(!message.includes('```'))
  }
  assert.ok(!failureMessage(failure()).includes('It printed nothing.'))
})

test('failureMessage: the hint when the sandbox refused a write', () => {
  const hint = 'Some of it was refused with "Read-only file system": a gate can write in the clone and `/tmp`, and on dish\'s VM in the home directory, '
    + 'except dish\'s own files, `~/.ssh`, git\'s config and shell startup files. If it needs another directory, say so in your closing message.'
  const denied = failureMessage(failure({ denied: true }))
  assert.ok(denied.includes(`\n${hint}\n`), denied)
  assert.ok(denied.indexOf('```\n', denied.indexOf('```\n') + 1) < denied.indexOf(hint), 'the hint follows the output')
  assert.ok(!failureMessage(failure({ denied: false })).includes('Read-only file system'))
  const silent = failureMessage(failure({ denied: true, tail: '' }))
  assert.ok(silent.includes(hint), 'the hint stands when the output is empty')
})

test('failureMessage: the log, or why there is none', () => {
  const log = '/state/dish/gates/acme/widget/fix-1/c1-1-1.log'
  assert.ok(failureMessage(failure({ log })).includes(`Full log: \`${log}\`.`))
  const none = failureMessage(failure({ log: null, logProblem: 'EACCES: permission denied' }))
  assert.ok(none.includes('(No log: EACCES: permission denied.)'), none)
  assert.ok(!none.includes('Full log:'))
  assert.ok(failureMessage(failure({ log: null, logProblem: 'disk full.' })).includes('(No log: disk full.)'), 'no doubled full stop')
  assert.ok(failureMessage(failure({ log: null })).includes('(No log.)'), 'no problem given')
  const folded = failureMessage(failure({ log: null, logProblem: 'one\ntwo\n  three' }))
  assert.ok(folded.includes('(No log: one two three.)'), 'one line')
  const huge = failureMessage(failure({ log: null, logProblem: 'p'.repeat(5000) }))
  assert.ok(huge.length < 2000)
  const odd = failureMessage(failure({ log: '/state/we`ird/c1-1-1.log' }))
  assert.ok(odd.includes('Full log: `` /state/we`ird/c1-1-1.log ``.'), odd)
})

test('failureMessage: what to do', () => {
  const message = failureMessage(failure())
  assert.ok(message.includes('Fix it in your worktree and finish again; the gate runs again when you do.'))
})

test('failureMessage: the next-to-last round says the next failure ends the turn', () => {
  const sentence = 'If it fails once more, your turn ends with the failure, and the main agent decides what\'s next.'
  assert.ok(!failureMessage(failure({ round: 1, maxRounds: 3 })).includes(sentence), 'round 1 of 3')
  assert.ok(failureMessage(failure({ round: 2, maxRounds: 3 })).includes(sentence), 'round 2 of 3')
  assert.ok(!failureMessage(failure({ round: 1, maxRounds: 5 })).includes(sentence), 'round 1 of 5')
  assert.ok(!failureMessage(failure({ round: 3, maxRounds: 5 })).includes(sentence), 'round 3 of 5')
  assert.ok(failureMessage(failure({ round: 4, maxRounds: 5 })).includes(sentence), 'round 4 of 5')
  assert.ok(failureMessage(failure({ round: 1, maxRounds: 2 })).includes(sentence), 'round 1 of 2')
  const full = failureMessage(failure({ round: 2 }))
  assert.ok(full.includes('the gate runs again when you do. If it fails once more'), 'it follows the fix sentence on its line')
})

test('failureMessage: the opt-out sentence ends the message', () => {
  const sentence = 'If you\'re blocked, start your closing message with `BLOCKED: <question>` or `NEEDS CONTEXT: <what you need>`, and the gate is skipped.'
  for (const round of [1, 2]) {
    const message = failureMessage(failure({ round }))
    assert.ok(message.endsWith(`\n${sentence}`), message)
  }
})

test('failureMessage: the whole message, as the spec lays it out', () => {
  assert.equal(failureMessage(failure({ round: 2 })), [
    'The gate failed (round 2 of 3): `pnpm test` exited 1 after 42 s.',
    'Last lines of its output:',
    '```',
    'FAIL src/a.test.ts',
    '  expected 1, got 2',
    '```',
    'Full log: `/state/dish/gates/acme/widget/fix-1/c1-1-1.log`. Fix it in your worktree and finish again; the gate runs again when you do. '
      + 'If it fails once more, your turn ends with the failure, and the main agent decides what\'s next.',
    'If you\'re blocked, start your closing message with `BLOCKED: <question>` or `NEEDS CONTEXT: <what you need>`, and the gate is skipped.',
  ].join('\n'))
})

test('failureMessage is built only for a round that can be steered', () => {
  assert.throws(() => failureMessage(failure({ round: 3, maxRounds: 3 })), RangeError, 'the failure in the last round is not sent back')
  assert.throws(() => failureMessage(failure({ round: 1, maxRounds: 1 })), RangeError)
  assert.throws(() => failureMessage(failure({ round: 4, maxRounds: 3 })), RangeError)
  assert.throws(() => failureMessage(failure({ round: 0, maxRounds: 3 })), RangeError)
  assert.doesNotThrow(() => failureMessage(failure({ round: 1, maxRounds: 2 })))
})

// --- failureSummary ---------------------------------------------------------------------------------

test('failureSummary', () => {
  assert.equal(failureSummary(failure()), 'Gate failed (round 1 of 3): exit 1')
  assert.equal(failureSummary(failure({ exitCode: 137, round: 2 })), 'Gate failed (round 2 of 3): exit 137')
  assert.equal(failureSummary(failure({ timedOut: true, exitCode: null, timeoutMs: 600_000 })), 'Gate failed (round 1 of 3): timed out after 10 min')
  assert.equal(failureSummary(failure({ exitCode: null })), 'Gate failed (round 1 of 3): killed')
})

test('failureSummary stays within its bound', () => {
  for (const f of [failure(), failure({ exitCode: 255, round: 99, maxRounds: 100 }), failure({ timedOut: true, exitCode: null })]) {
    const summary = failureSummary(f)
    assert.ok(summary.length <= SUMMARY_MAX_CHARS, summary)
    assert.ok(!summary.includes('\n'))
  }
  const absurd = failureSummary(failure({ exitCode: Number('9'.repeat(200)), round: 10 ** 100, maxRounds: 10 ** 101 }))
  assert.ok(absurd.length <= SUMMARY_MAX_CHARS, absurd)
  const long = failureSummary(failure({ command: 'x'.repeat(10_000) }))
  assert.ok(!long.includes('xxx'), 'the command is not in the summary')
})
