/**
 * The page saves settings, and the server writes them back as `judge.yaml` in the shipped file's key order with its
 * comments. These tests are about that round trip: the text that comes out must pass the same check the store applies, mean
 * what was given, and keep what a person reads the file for.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { serializeSettings } from '../src/serialize.ts'
import { DEFAULT_SETTINGS, DEFAULT_TEXT, parseSettings } from '../src/settings.ts'
import type { JudgeSettings } from '../src/settings.ts'

/** The default, with `change` applied to a copy that is not frozen. */
function changed(change: (settings: Record<string, any>) => void): JudgeSettings {
  const copy = JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as Record<string, any>
  change(copy)
  const parsed = parseSettings(JSON.stringify(copy))
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.problem)
  return parsed.settings
}

function parsedBack(text: string): JudgeSettings {
  const parsed = parseSettings(text)
  assert.ok(parsed.ok, parsed.ok ? '' : `${parsed.problem}\n${text}`)
  return parsed.settings
}

/** The lines of `text` that are comments, or end in one: what a person reads the file for. */
function commentsOf(text: string): string[] {
  return text.split('\n').filter(line => line.includes('#')).map(line => line.slice(line.indexOf('#')))
}

test('the shipped settings serialize to the shipped file, byte for byte', () => {
  assert.equal(serializeSettings(DEFAULT_SETTINGS), DEFAULT_TEXT)
})

test('a changed value is written where the shipped file has it, and nothing else moves', () => {
  const settings = changed((s) => {
    s.commands.reversible = 0.95
    s.screening.warn = 0.4
    s.timeoutMs = 3000
  })
  const text = serializeSettings(settings)
  assert.deepEqual(parsedBack(text), settings)
  const before = DEFAULT_TEXT.split('\n')
  const after = text.split('\n')
  assert.equal(after.length, before.length, 'the same number of lines')
  const differing = after.flatMap((line, index) => line === before[index] ? [] : [index])
  assert.equal(differing.length, 3, differing.map(index => after[index]).join('\n'))
  assert.match(text, /^timeoutMs: 3000$/m)
  assert.match(text, /^ {2}reversible: 0\.95 +# P\(read_only\) \+ P\(reversible\) at or above this/m)
  assert.match(text, /^ {2}warn: 0\.40 +# at or above this/m)
})

test('every comment of the shipped file is still there, in order, whatever the values are', () => {
  const settings = changed((s) => {
    s.model = 'a-much-longer-model-id-than-the-shipped-one-1.2.3'
    s.commands = { readOnly: 0.123456, reversible: 1, servesTask: 0 }
    s.screening.chunkChars = 60000
    s.tools.gated = ['bash', 'pwsh', 'run_code', 'mcp__shell__*']
  })
  const text = serializeSettings(settings)
  assert.deepEqual(commentsOf(text), commentsOf(DEFAULT_TEXT))
  assert.deepEqual(text.split('\n').map(line => line.replace(/^(\s*\w+:).*?(\s+#.*)?$/, '$1$2').replace(/\s+/g, ' ')),
    DEFAULT_TEXT.split('\n').map(line => line.replace(/^(\s*\w+:).*?(\s+#.*)?$/, '$1$2').replace(/\s+/g, ' ')), 'keys and comments, line for line')
  assert.deepEqual(parsedBack(text), settings)
})

test('the keys are in the shipped file\'s order, which is not the order the page gave them in', () => {
  const text = serializeSettings(DEFAULT_SETTINGS)
  const keys = text.split('\n').map(line => /^(\s*)(\w+):/.exec(line)).filter(match => match !== null).map(match => `${match[1]!.length}:${match[2]}`)
  assert.deepEqual(keys, ['0:model', '0:timeoutMs', '0:commands', '2:readOnly', '2:reversible', '2:servesTask', '0:screening', '2:withhold', '2:warn', '2:chunkChars', '0:tools', '2:gated', '2:screened'])
})

test('a value longer than the shipped one still has a space before its comment, and the comment is not lost', () => {
  const text = serializeSettings(changed((s) => { s.model = 'x'.repeat(100) }))
  assert.match(text, /^model: x{100} {2}# pinned: thresholds were set against this version$/m)
})

test('numbers are written as the file has them: two decimals when two are enough, else whole', () => {
  const settings = changed((s) => {
    s.commands = { readOnly: 0.9, reversible: 1, servesTask: 0 }
    s.screening.withhold = 0.875
    s.screening.warn = 0.123456789
  })
  const text = serializeSettings(settings)
  assert.match(text, /^ {2}readOnly: 0\.90 /m)
  assert.match(text, /^ {2}reversible: 1\.00 /m)
  assert.match(text, /^ {2}servesTask: 0\.00 /m)
  assert.match(text, /^ {2}withhold: 0\.875 /m)
  assert.match(text, /^ {2}warn: 0\.123456789 /m)
  assert.deepEqual(parsedBack(text), settings)
})

test('a model that YAML would read as something other than a string is written in quotes', () => {
  for (const model of ['1.13', '123', '0x1f', 'true', 'null', 'a/b:c', 'org/model:tag', 'v1.0-beta_2']) {
    const settings = changed((s) => { s.model = model })
    const text = serializeSettings(settings)
    assert.equal(parsedBack(text).model, model, model)
  }
  assert.match(serializeSettings(changed((s) => { s.model = '1.13' })), /^model: "1\.13" /m)
  assert.match(serializeSettings(changed((s) => { s.model = 'jev-1.14.0' })), /^model: jev-1\.14\.0 /m)
})

test('tool names that YAML would read as something else, or that would end a list, are quoted, and the list comes back whole', () => {
  const names = ['bash', 'true', 'null', '123', 'a,b', 'a]b', 'a[b', 'a{b', 'a}b', 'a#b', 'a:b', 'a"b', 'a\'b', 'a\\b', 'x*', 'mcp__*', '-flag', '?x', '!tag', '&anchor', '@at', '%pct', '|pipe', '>fold', '`tick']
  const settings = changed((s) => { s.tools.gated = names; s.tools.screened = [...names].reverse() })
  const text = serializeSettings(settings)
  const back = parsedBack(text)
  assert.deepEqual([...back.tools.gated], names)
  assert.deepEqual([...back.tools.screened], [...names].reverse())
  assert.match(text, /^ {2}gated: \[bash, "true", "null", "123", /m)
})

test('the text written is one line per setting: a name with a newline or a space is not accepted to begin with, so none can break the file', () => {
  // The values are checked by parseSettings before anything is written: a hostile name never reaches the serializer.
  for (const bad of ['a\nb', 'a b', ' a', 'a ', '', '*']) {
    const parsed = parseSettings(JSON.stringify({ ...DEFAULT_SETTINGS, tools: { gated: [bad], screened: ['web_fetch'] } }))
    assert.equal(parsed.ok, false, JSON.stringify(bad))
  }
})

test('whatever valid settings go in, the text that comes out passes the check and means the same (a sweep)', () => {
  let seed = 12345
  const random = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789_.-'
  const word = (): string => Array.from({ length: 1 + Math.floor(random() * 12) }, () => pick([...alphabet])).join('')
  for (let run = 0; run < 300; run++) {
    const withhold = Math.round(random() * 1000) / 1000
    const warn = Math.round(random() * withhold * 1000) / 1000
    const settings = changed((s) => {
      s.model = `${pick(['jev', 'x', '1', 'true', 'a/b'])}${word().replace(/^[._-]/, 'q')}`
      s.timeoutMs = 200 + Math.floor(random() * 9800)
      s.commands = { readOnly: random(), reversible: Math.round(random() * 100) / 100, servesTask: pick([0, 1, 0.5, random()]) }
      s.screening = { withhold, warn, chunkChars: 2000 + Math.floor(random() * 58000) }
      s.tools = {
        gated: Array.from({ length: 1 + Math.floor(random() * 4) }, () => pick(['bash', word(), `${word()}*`, 'null', 'yes'])),
        screened: Array.from({ length: 1 + Math.floor(random() * 4) }, () => pick(['web_fetch', word(), `${word()}*`, '42'])),
      }
    })
    const text = serializeSettings(settings)
    assert.deepEqual(parsedBack(text), settings, text)
    assert.equal(text.split('\n').length, DEFAULT_TEXT.split('\n').length)
    assert.deepEqual(commentsOf(text), commentsOf(DEFAULT_TEXT))
  }
})

test('the output is stable: serializing what was written gives the same text', () => {
  const settings = changed((s) => { s.commands.readOnly = 0.97; s.tools.gated = ['bash', 'pwsh', 'extra*'] })
  const once = serializeSettings(settings)
  assert.equal(serializeSettings(parsedBack(once)), once)
})
