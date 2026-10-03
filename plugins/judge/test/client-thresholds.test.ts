/**
 * The thresholds form's own logic, with no page around it: how settings become text fields and back, when the form counts as
 * changed, and which warnings it gives. What counts as valid is the server's (`parseSettings`), not this module's: a value
 * that is not a number is passed on as typed, to be refused there with its message.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { covers, formOf, formWarnings, sameSettings, settingsOf, toolsOf } from '../src/client/thresholds.ts'
import type { ThresholdForm } from '../src/client/thresholds.ts'
import type { SettingsValues } from '../src/protocol.ts'
import { DEFAULT_SETTINGS } from '../src/settings.ts'

function shipped(): SettingsValues {
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as SettingsValues
}

function formWith(change: Partial<ThresholdForm>): ThresholdForm {
  return { ...formOf(shipped()), ...change }
}

test('the form has the settings as text: numbers as they read, the tool lists one per line', () => {
  assert.deepEqual(formOf(shipped()), {
    model: 'jev-1.13.0',
    timeoutMs: '2000',
    readOnly: '0.9',
    reversible: '0.9',
    servesTask: '0.5',
    withhold: '0.9',
    warn: '0.5',
    chunkChars: '24000',
    gated: 'bash\npwsh',
    screened: 'web_search\nweb_fetch\nread_mcp_resource\nmcp__*\npr_feedback',
  })
})

test('settings round trip through the form, whatever they are', () => {
  const settings: SettingsValues = {
    model: 'org/model:1',
    timeoutMs: 9999,
    commands: { readOnly: 0.123456789, reversible: 1, servesTask: 0 },
    screening: { withhold: 0.875, warn: 0.0001, chunkChars: 60000 },
    tools: { gated: ['bash'], screened: ['a*', 'b'] },
  }
  assert.deepEqual(settingsOf(formOf(settings)), settings)
  assert.deepEqual(settingsOf(formOf(shipped())), shipped())
})

test('a number is read as typed: spaces around it are not part of it, and exponents are numbers', () => {
  const sent = settingsOf(formWith({ readOnly: ' 0.95 ', reversible: '1e-1', servesTask: '.5', withhold: '1', warn: '0', timeoutMs: '3000', chunkChars: '2000.0' }))
  assert.deepEqual(sent.commands, { readOnly: 0.95, reversible: 0.1, servesTask: 0.5 })
  assert.deepEqual(sent.screening, { withhold: 1, warn: 0, chunkChars: 2000 })
  assert.equal(sent.timeoutMs, 3000)
})

test('what is not a number as typed is sent as typed, so the server\'s check says so in its own words', () => {
  const odd = ['', ' ', 'abc', '0x10', 'Infinity', '-Infinity', 'NaN', '1,5', '0.9.1', '1 2', '--1', 'e5', '0.9%']
  for (const text of odd) {
    const sent = settingsOf(formWith({ readOnly: text, timeoutMs: text }))
    assert.equal(sent.commands.readOnly as unknown, text, JSON.stringify(text))
    assert.equal(sent.timeoutMs as unknown, text, JSON.stringify(text))
  }
})

test('the model is sent as typed, trimmed; the tool lists are lines, trimmed, with the blank ones dropped', () => {
  const sent = settingsOf(formWith({ model: '  jev-2  ', gated: ' bash \r\n\n  pwsh\n\t\n', screened: 'web_fetch\r\nmcp__*\r\n' }))
  assert.equal(sent.model, 'jev-2')
  assert.deepEqual(sent.tools, { gated: ['bash', 'pwsh'], screened: ['web_fetch', 'mcp__*'] })
  assert.deepEqual(toolsOf(''), [])
  assert.deepEqual(toolsOf('\n\n'), [])
  assert.deepEqual(toolsOf('a\na'), ['a', 'a'], 'a repeated name is the person\'s to remove')
})

test('the form is changed when what it would send differs from what is saved, not when its text does', () => {
  const saved = shipped()
  assert.equal(sameSettings(settingsOf(formOf(saved)), saved), true)
  assert.equal(sameSettings(settingsOf(formWith({ readOnly: '0.90' })), saved), true, '0.90 is 0.9')
  assert.equal(sameSettings(settingsOf(formWith({ gated: 'bash\r\npwsh\n' })), saved), true, 'line endings and a last newline are no change')
  assert.equal(sameSettings(settingsOf(formWith({ model: ' jev-1.13.0 ' })), saved), true)
  assert.equal(sameSettings(settingsOf(formWith({ readOnly: '0.91' })), saved), false)
  assert.equal(sameSettings(settingsOf(formWith({ readOnly: '0.9x' })), saved), false)
  assert.equal(sameSettings(settingsOf(formWith({ gated: 'bash' })), saved), false)
  assert.equal(sameSettings(settingsOf(formWith({ gated: 'pwsh\nbash' })), saved), false, 'the order of a list is its own')
  assert.equal(sameSettings(settingsOf(formWith({ model: 'jev-2' })), saved), false)
})

test('a tool list covers a tool by its name or by a prefix ending in *, as the gate matches them', () => {
  assert.equal(covers(['bash'], 'bash'), true)
  assert.equal(covers(['bash', 'pwsh'], 'pwsh'), true)
  assert.equal(covers(['pwsh'], 'bash'), false)
  assert.equal(covers(['ba*'], 'bash'), true)
  assert.equal(covers(['bash*'], 'bash'), true)
  assert.equal(covers(['bashx*'], 'bash'), false)
  assert.equal(covers(['mcp__*'], 'mcp__shell__run'), true)
  assert.equal(covers(['mcp__*'], 'mcp_'), false)
  assert.equal(covers(['BASH'], 'bash'), false, 'names are case-sensitive')
  assert.equal(covers(['bash '], 'bash'), false, 'a name with a space is another name (and the server refuses it)')
  assert.equal(covers([], 'bash'), false)
})

test('the shipped form has no warnings', () => {
  assert.deepEqual(formWarnings(formOf(shipped()), shipped()), [])
})

test('gated tools that do not cover bash are warned about, whatever else they cover', () => {
  const saved = shipped()
  const only = formWarnings(formWith({ gated: 'pwsh' }), saved)
  assert.equal(only.length, 1)
  assert.match(only[0]!, /pwsh but not bash/)
  const typo = formWarnings(formWith({ gated: 'bsh\npwsh2' }), saved)
  assert.equal(typo.length, 1)
  assert.match(typo[0]!, /neither bash nor pwsh/)
  assert.match(typo[0]!, /without the judge/)
  assert.deepEqual(formWarnings(formWith({ gated: 'bash' }), saved), [])
  assert.deepEqual(formWarnings(formWith({ gated: 'ba*' }), saved), [])
  assert.deepEqual(formWarnings(formWith({ gated: 'bash\nrun_code\nmcp__*' }), saved), [])
  // An empty list covers neither, and the server refuses it on save: the warning says so sooner.
  assert.match(formWarnings(formWith({ gated: '' }), saved)[0]!, /neither bash nor pwsh/)
})

test('changing the model is warned about, with both names: the thresholds were set against the old one', () => {
  const saved = shipped()
  const warnings = formWarnings(formWith({ model: 'jev-2.0.0' }), saved)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0]!, /jev-1\.13\.0/)
  assert.match(warnings[0]!, /jev-2\.0\.0/)
  assert.match(warnings[0]!, /thresholds were set against/)
  assert.deepEqual(formWarnings(formWith({ model: ' jev-1.13.0 ' }), saved), [])
  assert.deepEqual(formWarnings(formWith({ model: '' }), saved), [], 'an empty model is the server\'s to refuse, not a change to warn about')
})

test('warnings add up, and are plain text', () => {
  const warnings = formWarnings(formWith({ gated: 'pwsh', model: 'x<img src=1 onerror=alert(1)>' }), shipped())
  assert.equal(warnings.length, 2)
  for (const warning of warnings) assert.equal(typeof warning, 'string')
})
