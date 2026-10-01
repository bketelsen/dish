import { test } from 'node:test'
import assert from 'node:assert/strict'
import { maskSecrets, secretKind } from '../src/secrets.ts'
import * as kit from '../src/index.ts'

// Fake credentials, built from parts so that this file holds no literal that looks like one.
const GH_BODY = 'Zq9Xk2'.repeat(6)
const GH = `ghp_${GH_BODY}`
const PAT = `github_pat_${'Ab1_'.repeat(14)}`
const SK = `sk-${'aB3dE5gH'.repeat(5)}`
const AKIA = `AKIA${'IOSFODNN7EXAMPLE'}`
const ASIA = `ASIA${'IOSFODNN7EXAMPLE'}`
const PEM = '-----BEGIN RSA PRIVATE KEY-----'

const mask = (kind: string): string => `‹secret: ${kind}›`

test('dish-kit exports both from its index', () => {
  assert.equal(kit.secretKind, secretKind)
  assert.equal(kit.maskSecrets, maskSecrets)
})

// --- secretKind: the moved function keeps its behaviour --------------------------------------

test('secretKind names the kind of the first secret in a text, or nothing', () => {
  assert.equal(secretKind(`key ${GH}`), 'a GitHub token')
  assert.equal(secretKind(`key ${AKIA}`), 'an AWS access key ID')
  assert.equal(secretKind('a GitHub token, an AWS key, a PEM header'), undefined)
  assert.equal(secretKind(''), undefined)
})

test('secretKind is stateless: asking twice gives the same answer', () => {
  assert.equal(secretKind(GH), 'a GitHub token')
  assert.equal(secretKind(GH), 'a GitHub token')
  assert.equal(secretKind(`${GH} ${GH}`), 'a GitHub token')
})

// --- maskSecrets: each kind ------------------------------------------------------------------

const kinds: Array<{ name: string, secret: string, kind: string }> = [
  { name: 'ghp_', secret: GH, kind: 'a GitHub token' },
  { name: 'gho_', secret: `gho_${GH_BODY}`, kind: 'a GitHub token' },
  { name: 'ghu_', secret: `ghu_${GH_BODY}`, kind: 'a GitHub token' },
  { name: 'ghs_', secret: `ghs_${GH_BODY}`, kind: 'a GitHub token' },
  { name: 'ghr_', secret: `ghr_${GH_BODY}`, kind: 'a GitHub token' },
  { name: 'a fine-grained token', secret: PAT, kind: 'a GitHub fine-grained token' },
  { name: 'an sk- key', secret: SK, kind: 'an sk- API key' },
  { name: 'an sk- key with - and _', secret: `sk-proj-${'aB3_dE5-'.repeat(5)}`, kind: 'an sk- API key' },
  { name: 'a PEM header', secret: PEM, kind: 'a private key' },
  { name: 'an OPENSSH PEM header', secret: '-----BEGIN OPENSSH PRIVATE KEY-----', kind: 'a private key' },
  { name: 'a PGP block header', secret: '-----BEGIN PGP PRIVATE KEY BLOCK-----', kind: 'a private key' },
  { name: 'an AKIA key', secret: AKIA, kind: 'an AWS access key ID' },
  { name: 'an ASIA key', secret: ASIA, kind: 'an AWS access key ID' },
]

for (const { name, secret, kind } of kinds) {
  test(`maskSecrets masks ${name}, and only it`, () => {
    assert.equal(secretKind(secret), kind, 'the fixture is a secret')
    assert.equal(maskSecrets(secret), mask(kind))
    assert.equal(maskSecrets(`before ${secret} after`), `before ${mask(kind)} after`)
    assert.equal(maskSecrets(`TOKEN=${secret}\n`), `TOKEN=${mask(kind)}\n`)
    assert.equal(maskSecrets(`"${secret}"`), `"${mask(kind)}"`)
  })
}

test('maskSecrets masks each of several of the same kind', () => {
  const other = `ghs_${'Mn4Pq8'.repeat(6)}`
  assert.equal(maskSecrets(`${GH} and ${other} and ${GH}`), `${mask('a GitHub token')} and ${mask('a GitHub token')} and ${mask('a GitHub token')}`)
})

test('maskSecrets leaves text with no secret exactly as it is', () => {
  for (const text of ['', 'git status', 'a GitHub token, an AWS key, a PEM header', 'sk-short', 'ghp_short', 'unicode: ünï ‹ › 日本語 😀', 'line one\nline two\r\n']) {
    assert.equal(maskSecrets(text), text)
  }
})

test('maskSecrets never keeps any of a secret, whatever surrounds it', () => {
  for (const { secret } of kinds) {
    for (const text of [secret, ` ${secret} `, `x=${secret};`, `${secret}\n${secret}`, `[${secret}]`, `é${secret}é`]) {
      const masked = maskSecrets(text)
      assert.ok(!masked.includes(secret), `${secret} is gone from ${JSON.stringify(masked)}`)
      assert.equal(secretKind(masked), undefined)
    }
  }
})

// --- lookbehind and lookahead behave in a replace as they do in detection ---------------------

test('a lookbehind holds in a replace: a token glued to a letter or digit is not a match, so it is not masked', () => {
  for (const glued of [`x${GH}`, `1${GH}`, `risk-${'a'.repeat(40)}`, `task-${'a'.repeat(40)}`, `x${SK}`, `Z${AKIA}`]) {
    assert.equal(secretKind(glued), undefined, `detection agrees: ${glued}`)
    assert.equal(maskSecrets(glued), glued)
  }
  // `_` and `-` are not letters or digits, so a token after one is a match.
  assert.equal(maskSecrets(`TOKEN_${GH}`), `TOKEN_${mask('a GitHub token')}`)
  assert.equal(maskSecrets(`-${SK}`), `-${mask('an sk- API key')}`)
})

test('a lookahead holds in a replace: an AWS key followed by a capital or digit is not a match', () => {
  assert.equal(secretKind(`${AKIA}X`), undefined)
  assert.equal(maskSecrets(`${AKIA}X`), `${AKIA}X`)
  assert.equal(maskSecrets(`${AKIA}7`), `${AKIA}7`)
  assert.equal(maskSecrets(`${AKIA}.`), `${mask('an AWS access key ID')}.`)
  assert.equal(maskSecrets(`${AKIA} ${AKIA}`), `${mask('an AWS access key ID')} ${mask('an AWS access key ID')}`)
})

// --- overlapping matches ----------------------------------------------------------------------

test('a text with two different secrets masks both', () => {
  const text = `aws ${AKIA} and github ${GH}`
  assert.equal(maskSecrets(text), `aws ${mask('an AWS access key ID')} and github ${mask('a GitHub token')}`)
  const three = `${PEM}\n${SK} ${GH} ${AKIA}`
  assert.equal(maskSecrets(three), `${mask('a private key')}\n${mask('an sk- API key')} ${mask('a GitHub token')} ${mask('an AWS access key ID')}`)
})

test('matches that overlap become one mask over all of them, so no tail of either is left', () => {
  // The sk- pattern takes `_` and letters, so it runs over the whole of the GitHub token that follows it, which is a
  // match of its own that starts inside the sk- match.
  const nested = `${SK}_${GH}`
  assert.equal(secretKind(nested), 'a GitHub token')
  assert.equal(maskSecrets(nested), mask('an sk- API key'))
  // The kind is the one that starts first.
  const inside = `sk-${GH}`
  assert.equal(maskSecrets(inside), mask('an sk- API key'))
  // A partial overlap: the sk- match runs on through `-----BEGIN` (its characters include `-`), where a private-key header
  // starts and then goes on past it. One mask covers both, so that neither ` PRIVATE KEY-----` nor the key's tail is left.
  const partial = `${SK}${PEM}`
  assert.equal(secretKind(partial), 'an sk- API key')
  assert.equal(maskSecrets(partial), mask('an sk- API key'))
})

test('two secrets that touch each other are both masked', () => {
  assert.equal(maskSecrets(`${AKIA}${GH}`), `${mask('an AWS access key ID')}${mask('a GitHub token')}`)
  assert.equal(maskSecrets(`${PEM}${PEM}`), `${mask('a private key')}${mask('a private key')}`)
})

// --- idempotence ------------------------------------------------------------------------------

const samples = [
  '',
  'plain text',
  GH,
  `${GH} ${AKIA} ${PEM}`,
  `${SK}_${GH}`,
  `${AKIA}${GH}`,
  `${AKIA}${GH}${AKIA}${GH}`,
  `${PEM}${GH}${PAT}`,
  `${GH}${GH}`,
  `${GH}${SK}`,
  `x${GH}`,
  `${AKIA}X ${AKIA}`,
  `${mask('a GitHub token')} then ${GH}`,
  ...kinds.map(({ secret }) => `a ${secret} b`),
]

test('masking an already-masked string changes nothing', () => {
  for (const text of samples) {
    const once = maskSecrets(text)
    assert.equal(maskSecrets(once), once, JSON.stringify(text))
  }
})

test('the mask text is not itself a secret, for every kind', () => {
  for (const { secret, kind } of kinds) {
    assert.equal(secretKind(mask(kind)), undefined)
    assert.equal(maskSecrets(mask(kind)), mask(kind))
    assert.equal(secretKind(maskSecrets(secret)), undefined)
  }
})

test('a secret that the first pass left unmatched because of a neighbour is masked by the pass that sees it free', () => {
  // The AWS key is a match (a lowercase letter follows). The token after it is glued to the key's last character, so it
  // is not a match in the original, but it is once the key is a mask. Masked in one call, so that the result is stable.
  const text = `${AKIA}${GH}`
  const once = maskSecrets(text)
  assert.equal(secretKind(once), undefined)
  assert.equal(maskSecrets(once), once)
})

test('no text is left that looks like a secret, over a spread of mixed and adjacent inputs', () => {
  const parts = [GH, PAT, SK, AKIA, PEM, ' ', '_', '-', 'x', 'A', '7', '\n', mask('a GitHub token')]
  // A small deterministic generator: every sequence of up to three parts.
  const sequences: string[] = []
  const walk = (prefix: string, depth: number): void => {
    sequences.push(prefix)
    if (depth === 0) return
    for (const part of parts) walk(prefix + part, depth - 1)
  }
  walk('', 3)
  assert.ok(sequences.length > 2000)
  for (const text of sequences) {
    const once = maskSecrets(text)
    assert.equal(secretKind(once), undefined, JSON.stringify(text))
    assert.equal(maskSecrets(once), once, JSON.stringify(text))
  }
})

test('a long text with many secrets is masked in a reasonable time', () => {
  const text = `${'filler line with nothing in it\n'.repeat(20_000)}${`${GH} ${AKIA}\n`.repeat(2_000)}`
  const started = Date.now()
  const masked = maskSecrets(text)
  assert.ok(Date.now() - started < 5_000)
  assert.equal(secretKind(masked), undefined)
  assert.equal(masked.split('‹secret: a GitHub token›').length - 1, 2_000)
})
