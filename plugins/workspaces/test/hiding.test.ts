/** The one copy of "take a secret out of a text", used by the server for GitHub's errors and by the card for dsh's. */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { hiding } from '../src/hiding.ts'

const BODY = [
  'MIIEowIBAAKCAQEAnotARealKeyJustTestBodyLineNumberOne0123456789',
  'secondBodyLineOfTheTestKeyAbcdefghijklmnopqrstuvwxyz0123456789',
]
const PEM = `-----BEGIN RSA PRIVATE KEY-----\n${BODY.join('\n')}\n-----END RSA PRIVATE KEY-----\n`

test('a value is taken out in the forms it can take, and a long line of it alone', () => {
  const hide = hiding([PEM])
  assert.equal(hide(`x ${PEM.trim()} y`), 'x … y')
  assert.equal(hide(`x ${PEM} y`), 'x …\n y', 'the final line break is not part of the key')
  assert.ok(!hide(JSON.stringify(PEM)).includes(BODY[1]!))
  assert.ok(!hide(encodeURIComponent(PEM)).includes(encodeURIComponent(BODY[1]!)))
  assert.equal(hide(`only ${BODY[0]} here`), 'only … here')
})

test('several values at once; one too short to tell from other text is left; nothing to hide changes nothing', () => {
  const hide = hiding(['1234567', PEM, 'abc', ''])
  assert.equal(hide(`app 1234567 key ${BODY[0]} abc`), 'app … key … abc')
  assert.equal(hiding([])('anything'), 'anything')
  assert.equal(hiding(['   '])('   stays'), '   stays')
})

test('it imports nothing, so the browser bundle and the server can both have it', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/hiding.ts', import.meta.url)), 'utf8')
  assert.ok(!/^\s*import\b/m.test(source))
})
