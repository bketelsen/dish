import { test } from 'node:test'
import assert from 'node:assert/strict'
import { maskSecrets, secretKind } from '../src/secrets.ts'
import * as kit from '../src/index.ts'

// Fake credentials, built from parts so that this file holds no literal that looks like one. Each has a body of its own, so
// that a leak of any of them can be told from a leak of another.
const GH_BODY = 'Zq9Xk2'.repeat(6)
const GH2_BODY = 'Mn4Pq8'.repeat(6)
const PAT_BODY = 'Ab1_'.repeat(14)
const SK_BODY = 'aB3dE5gH'.repeat(5)
const AKIA_BODY = 'IOSFODNN7EXAMPLE'
const PEM_BODY = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj'
const GH = `ghp_${GH_BODY}`
const GH2 = `ghs_${GH2_BODY}`
const PAT = `github_pat_${PAT_BODY}`
const SK = `sk-${SK_BODY}`
const AKIA = `AKIA${AKIA_BODY}`
const ASIA = `ASIA${AKIA_BODY}`
const PEM = '-----BEGIN RSA PRIVATE KEY-----'
const PEM_END = '-----END RSA PRIVATE KEY-----'
/** A whole key: header, body, END line. */
const PEM_BLOCK = `${PEM}\n${PEM_BODY}\n${PEM_BODY.split('').reverse().join('')}\n${PEM_END}`

/** Everything in a fixture that must not survive masking. */
const BODIES = [GH_BODY, GH2_BODY, PAT_BODY, SK_BODY, AKIA_BODY, PEM_BODY, PEM_BODY.split('').reverse().join(''), 'PRIVATE KEY-----', 'ghp_', 'ghs_', 'github_pat_', 'AKIA', 'ASIA']

/** Assert that none of a fixture is in `masked`. A text with no pattern match in it can still hold the whole of a body. */
function assertNoBodies(masked: string, what: string): void {
  for (const body of BODIES) assert.ok(!masked.includes(body), `${body} is in the masked text of ${what}: ${JSON.stringify(masked)}`)
}

const mask = (kind: string): string => `‹secret: ${kind}›`
const GH_MASK = mask('a GitHub token')
const PAT_MASK = mask('a GitHub fine-grained token')
const SK_MASK = mask('an sk- API key')
const PEM_MASK = mask('a private key')
const AKIA_MASK = mask('an AWS access key ID')

/** How long `run` takes, in milliseconds. */
function took(run: () => unknown): number {
  const started = process.hrtime.bigint()
  run()
  return Number(process.hrtime.bigint() - started) / 1e6
}

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

test('secretKind finds every private key header: RSA, EC, OPENSSH, ENCRYPTED, bare, DSA, PGP', () => {
  for (const header of [
    '-----BEGIN RSA PRIVATE KEY-----', '-----BEGIN EC PRIVATE KEY-----', '-----BEGIN OPENSSH PRIVATE KEY-----',
    '-----BEGIN ENCRYPTED PRIVATE KEY-----', '-----BEGIN PRIVATE KEY-----', '-----BEGIN DSA PRIVATE KEY-----',
    '-----BEGIN PGP PRIVATE KEY BLOCK-----',
  ]) {
    assert.equal(secretKind(`x\n${header}\nMII`), 'a private key', header)
  }
  assert.equal(secretKind('-----BEGIN PUBLIC KEY-----'), undefined)
  assert.equal(secretKind('-----BEGIN CERTIFICATE-----'), undefined)
  // The words before `PRIVATE KEY` are at most 40 characters: no real header has more.
  assert.equal(secretKind(`-----BEGIN ${'A'.repeat(41)} PRIVATE KEY-----`), undefined)
  assert.equal(secretKind(`-----BEGIN ${'A'.repeat(39)} PRIVATE KEY-----`), 'a private key')
})

// --- maskSecrets: each kind ------------------------------------------------------------------

const kinds: Array<{ name: string, secret: string, kind: string, header?: true }> = [
  { name: 'ghp_', secret: GH, kind: 'a GitHub token' },
  { name: 'gho_', secret: `gho_${GH_BODY}`, kind: 'a GitHub token' },
  { name: 'ghu_', secret: `ghu_${GH_BODY}`, kind: 'a GitHub token' },
  { name: 'ghs_', secret: `ghs_${GH_BODY}`, kind: 'a GitHub token' },
  { name: 'ghr_', secret: `ghr_${GH_BODY}`, kind: 'a GitHub token' },
  { name: 'a long ghp_', secret: `ghp_${GH_BODY}${GH_BODY}`, kind: 'a GitHub token' },
  { name: 'a fine-grained token', secret: PAT, kind: 'a GitHub fine-grained token' },
  { name: 'an sk- key', secret: SK, kind: 'an sk- API key' },
  { name: 'an sk- key with - and _', secret: `sk-proj-${'aB3_dE5-'.repeat(5)}`, kind: 'an sk- API key' },
  { name: 'an AKIA key', secret: AKIA, kind: 'an AWS access key ID' },
  { name: 'an ASIA key', secret: ASIA, kind: 'an AWS access key ID' },
  // A header with nothing after it: what follows (up to 8 KB) is taken for the key.
  { name: 'a PEM header', secret: PEM, kind: 'a private key', header: true },
  { name: 'an OPENSSH PEM header', secret: '-----BEGIN OPENSSH PRIVATE KEY-----', kind: 'a private key', header: true },
  { name: 'a PGP block header', secret: '-----BEGIN PGP PRIVATE KEY BLOCK-----', kind: 'a private key', header: true },
]

for (const { name, secret, kind, header } of kinds) {
  test(`maskSecrets masks ${name}, and only it`, () => {
    assert.equal(secretKind(secret), kind, 'the fixture is a secret')
    assert.equal(maskSecrets(secret), mask(kind))
    if (header === true) {
      // What follows a header is the key, so it goes with it.
      assert.equal(maskSecrets(`before ${secret} after`), `before ${mask(kind)}`)
      return
    }
    assert.equal(maskSecrets(`before ${secret} after`), `before ${mask(kind)} after`)
    assert.equal(maskSecrets(`TOKEN=${secret}\n`), `TOKEN=${mask(kind)}\n`)
    assert.equal(maskSecrets(`"${secret}"`), `"${mask(kind)}"`)
  })
}

test('maskSecrets masks each of several of the same kind', () => {
  assert.equal(maskSecrets(`${GH} and ${GH2} and ${GH}`), `${GH_MASK} and ${GH_MASK} and ${GH_MASK}`)
})

test('maskSecrets leaves text with no secret exactly as it is', () => {
  for (const text of ['', 'git status', 'a GitHub token, an AWS key, a PEM header', 'sk-short', 'ghp_short', '-----BEGIN PUBLIC KEY-----\nMII\n-----END PUBLIC KEY-----', 'unicode: ünï ‹ › 日本語 😀', 'line one\nline two\r\n']) {
    assert.equal(maskSecrets(text), text)
  }
})

test('maskSecrets never keeps any of a secret, whatever surrounds it', () => {
  for (const { secret } of kinds) {
    for (const text of [secret, ` ${secret} `, `x=${secret};`, `${secret}\n${secret}`, `[${secret}]`, `é${secret}é`]) {
      const masked = maskSecrets(text)
      assert.ok(!masked.includes(secret), `${secret} is gone from ${JSON.stringify(masked)}`)
      assertNoBodies(masked, JSON.stringify(text))
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
  assert.equal(maskSecrets(`TOKEN_${GH}`), `TOKEN_${GH_MASK}`)
  assert.equal(maskSecrets(`-${SK}`), `-${SK_MASK}`)
})

test('a lookahead holds in a replace: an AWS key followed by a capital or digit is not a match', () => {
  assert.equal(secretKind(`${AKIA}X`), undefined)
  assert.equal(maskSecrets(`${AKIA}X`), `${AKIA}X`)
  assert.equal(maskSecrets(`${AKIA}7`), `${AKIA}7`)
  assert.equal(maskSecrets(`${AKIA}.`), `${AKIA_MASK}.`)
  assert.equal(maskSecrets(`${AKIA} ${AKIA}`), `${AKIA_MASK} ${AKIA_MASK}`)
})

// --- private keys: the body and the END line go with the header ---------------------------------

test('a private key is masked whole: header, body and END line', () => {
  assert.equal(maskSecrets(PEM_BLOCK), PEM_MASK)
  assert.equal(maskSecrets(`before\n${PEM_BLOCK}\nafter`), `before\n${PEM_MASK}\nafter`)
  assert.equal(maskSecrets(`${PEM_BLOCK}\n${PEM_BLOCK}`), `${PEM_MASK}\n${PEM_MASK}`)
  assert.equal(maskSecrets(`${PEM_BLOCK}${PEM_BLOCK}`), `${PEM_MASK}${PEM_MASK}`)
  for (const [header, end] of [
    ['-----BEGIN OPENSSH PRIVATE KEY-----', '-----END OPENSSH PRIVATE KEY-----'],
    ['-----BEGIN PRIVATE KEY-----', '-----END PRIVATE KEY-----'],
    ['-----BEGIN ENCRYPTED PRIVATE KEY-----', '-----END ENCRYPTED PRIVATE KEY-----'],
    ['-----BEGIN PGP PRIVATE KEY BLOCK-----', '-----END PGP PRIVATE KEY BLOCK-----'],
  ] as const) {
    const masked = maskSecrets(`a ${header}\r\n${PEM_BODY}\r\n${end}\r\nb`)
    assert.equal(masked, `a ${PEM_MASK}\r\nb`, header)
  }
  // Only up to the first END line, so that what comes after a key is not taken for it.
  assert.equal(maskSecrets(`${PEM_BLOCK}\nthe next line, ${AKIA}\nand more`), `${PEM_MASK}\nthe next line, ${AKIA_MASK}\nand more`)
})

test('a private key with no END line is masked for up to 8 KB after its header, and not beyond', () => {
  const cut = `${PEM}\n${PEM_BODY}\n${PEM_BODY}`
  assert.equal(maskSecrets(cut), PEM_MASK)
  assert.equal(maskSecrets(`log: ${cut}`), `log: ${PEM_MASK}`)
  const after = 'the line after the cut '.repeat(600) // about 13 KB
  const masked = maskSecrets(`${PEM}\n${PEM_BODY}\n${after}`)
  assert.ok(masked.startsWith(PEM_MASK))
  assertNoBodies(masked, 'a key with no END')
  assert.ok(masked.length > 4_000 && masked.length < 8_000 && masked.endsWith('the line after the cut '), `what is left is the text after 8 KB: ${masked.length}`)
  assert.ok(after.endsWith(masked.slice(PEM_MASK.length)))
})

test('private keys are masked next to other secrets: before them, after them, over them', () => {
  assert.equal(maskSecrets(`${GH} ${PEM_BLOCK} ${AKIA}`), `${GH_MASK} ${PEM_MASK} ${AKIA_MASK}`)
  assert.equal(maskSecrets(`${GH}${PEM_BLOCK}${AKIA}`), `${GH_MASK}${PEM_MASK}${AKIA_MASK}`)
  assert.equal(maskSecrets(`${SK}${PEM_BLOCK}`), SK_MASK, 'an sk- key runs on into the header: one mask for both')
})

// --- glued secrets ---------------------------------------------------------------------------------

const glued: Array<[string, string, string]> = [
  ['a GitHub token and a GitHub token', GH + GH2, GH_MASK + GH_MASK],
  ['the same GitHub token twice', GH + GH, GH_MASK + GH_MASK],
  ['a GitHub token and a fine-grained token', GH + PAT, GH_MASK + PAT_MASK],
  ['a GitHub token and an sk- key', GH + SK, GH_MASK + SK_MASK],
  ['a fine-grained token and an sk- key', PAT + SK, PAT_MASK + SK_MASK],
  ['an AWS key and a GitHub token', AKIA + GH, AKIA_MASK + GH_MASK],
  ['an AWS key and a fine-grained token', ASIA + PAT, AKIA_MASK + PAT_MASK],
  ['an AWS key and an sk- key', AKIA + SK, AKIA_MASK + SK_MASK],
  ['an AWS key and a private key', AKIA + PEM_BLOCK, AKIA_MASK + PEM_MASK],
  ['a private key and a GitHub token', PEM_BLOCK + GH, PEM_MASK + GH_MASK],
  ['a private key and an AWS key', PEM_BLOCK + AKIA, PEM_MASK + AKIA_MASK],
]

for (const [name, text, expected] of glued) {
  test(`secrets glued together are each masked: ${name}`, () => {
    const masked = maskSecrets(text)
    assert.equal(masked, expected)
    assertNoBodies(masked, name)
    assert.equal(maskSecrets(masked), masked)
  })
}

test('three and more glued secrets are each masked, whatever the order', () => {
  assert.equal(maskSecrets(GH + GH2 + GH), GH_MASK.repeat(3))
  assert.equal(maskSecrets(GH + PAT + SK), GH_MASK + PAT_MASK + SK_MASK, 'a fine-grained token is followed by an sk- key; a token before it is cut short of it')
  assert.equal(maskSecrets(AKIA + GH + SK + PAT), AKIA_MASK + GH_MASK + SK_MASK, 'an sk- key runs over what follows it')
  assert.equal(maskSecrets(`${GH}${GH2}-${GH}_${GH2}`), `${GH_MASK}${GH_MASK}-${GH_MASK}_${GH_MASK}`)
  assert.equal(maskSecrets(GH + SK + GH2), GH_MASK + SK_MASK)
})

test('a token glued to a letter that is not part of a secret is still not a match', () => {
  assert.equal(maskSecrets(`x${GH}${GH2}`), `x${GH}${GH2}`)
  assert.equal(secretKind(`x${GH}${GH2}`), undefined)
})

test('matches that overlap become one mask over all of them, so no tail of either is left', () => {
  // The sk- pattern takes `_` and letters, so it runs over the whole of the GitHub token that follows it, which is a
  // match of its own that starts inside the sk- match.
  const nested = `${SK}_${GH}`
  assert.equal(secretKind(nested), 'a GitHub token')
  assert.equal(maskSecrets(nested), SK_MASK)
  // The kind is the one that starts first.
  assert.equal(maskSecrets(`sk-${GH}`), SK_MASK)
  // A partial overlap: the sk- match runs on through `-----BEGIN` (its characters include `-`), where a private key header
  // starts and then goes on past it. One mask covers both, so that neither ` PRIVATE KEY-----` nor the key's tail is left.
  const partial = `${SK}${PEM}`
  assert.equal(secretKind(partial), 'an sk- API key')
  assert.equal(maskSecrets(partial), SK_MASK)
  assert.equal(maskSecrets(`${SK}${PEM_BLOCK}`), SK_MASK)
})

test('a text with two different secrets masks both', () => {
  assert.equal(maskSecrets(`aws ${AKIA} and github ${GH}`), `aws ${AKIA_MASK} and github ${GH_MASK}`)
  assert.equal(maskSecrets(`${SK} ${GH} ${AKIA}\n${PEM_BLOCK}`), `${SK_MASK} ${GH_MASK} ${AKIA_MASK}\n${PEM_MASK}`)
})

// --- idempotence and completeness -------------------------------------------------------------------

const samples = [
  '',
  'plain text',
  GH,
  `${GH} ${AKIA} ${PEM_BLOCK}`,
  `${SK}_${GH}`,
  `${AKIA}${GH}`,
  `${AKIA}${GH}${AKIA}${GH}`,
  `${PEM_BLOCK}${GH}${PAT}`,
  `${GH}${GH}`,
  `${GH}${SK}`,
  `${PAT}${SK}${GH}`,
  `x${GH}`,
  `${AKIA}X ${AKIA}`,
  `${PEM}\n${PEM_BODY}`,
  `${GH_MASK} then ${GH}`,
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

test('no secret is left in any mixture of secrets and what goes between them, and masking the result changes nothing', () => {
  // Secrets, and what a text puts between and around them. Every sequence of up to three. A secret here is one a pattern
  // matches where it stands: not after a letter, and an AWS key not before a capital, which are not secrets on their own.
  const secrets = [GH, GH2, PAT, SK, AKIA, ASIA, PEM_BLOCK]
  const parts = [...secrets, ' ', '\n', '_', '-', '.']
  const sequences: string[] = []
  const walk = (prefix: string, depth: number): void => {
    sequences.push(prefix)
    if (depth === 0) return
    for (const part of parts) walk(prefix + part, depth - 1)
  }
  walk('', 3)
  assert.ok(sequences.length > 1_500)
  let tested = 0
  for (const text of sequences) {
    if (/(?:AKIA|ASIA)[0-9A-Z]{16}(?:AKIA|ASIA)/.test(text)) continue
    tested++
    const once = maskSecrets(text)
    assertNoBodies(once, JSON.stringify(text))
    assert.equal(secretKind(once), undefined, JSON.stringify(text))
    assert.equal(maskSecrets(once), once, JSON.stringify(text))
    assert.equal(once.includes('‹secret:'), secrets.some(secret => text.includes(secret)), JSON.stringify(text))
  }
  assert.ok(tested > 1_400)
})

test('no body is left, and the text around is, in a mixture with words between the secrets', () => {
  const secrets = [GH, GH2, PAT, SK, AKIA, PEM_BLOCK]
  for (const first of secrets) {
    for (const second of secrets) {
      for (const between of [' and ', '\n', ', ', '=']) {
        const text = `a ${first}${between}${second} b`
        const masked = maskSecrets(text)
        assertNoBodies(masked, JSON.stringify(text))
        assert.ok(masked.startsWith('a ‹secret:') && masked.endsWith(' b'), JSON.stringify(masked))
        assert.equal(masked.split('‹secret:').length - 1, 2, `each of the two has a mask: ${JSON.stringify(masked)}`)
      }
    }
  }
})

// --- how long it takes -------------------------------------------------------------------------------

// Withheld web and MCP content is attacker-controlled, so what a text does to a pattern has to be bounded. Each of these
// is a megabyte of what a pattern nearly matches. The bound is a generous 500 ms against what is, on a laptop, a few ms.
const MEGABYTE = 1024 * 1024
const nearMisses: Array<[string, () => string]> = [
  ['a header and PRIVATE KEY over and over', () => `-----BEGIN ${'PRIVATE KEY'.repeat(MEGABYTE / 11)}`],
  ['a header and capitals', () => `-----BEGIN ${'A'.repeat(MEGABYTE)}`],
  ['a header and capitals and spaces', () => `-----BEGIN ${'A '.repeat(MEGABYTE / 2)}`],
  ['header starts over and over', () => '-----BEGIN '.repeat(MEGABYTE / 11)],
  ['headers with no END over and over', () => '-----BEGIN PRIVATE KEY-----'.repeat(MEGABYTE / 27)],
  ['headers with an END over and over', () => `${PEM_BLOCK}\n`.repeat(MEGABYTE / (PEM_BLOCK.length + 1))],
  ['a header and END lines that are not its', () => `-----BEGIN PRIVATE KEY-----${'-----END PRIVATE KEY'.repeat(MEGABYTE / 20)}`],
  ['ghp_ over and over', () => 'ghp_'.repeat(MEGABYTE / 4)],
  ['ghp_ and a megabyte of letters', () => `ghp_${'a'.repeat(MEGABYTE)}`],
  ['github_pat_ over and over', () => 'github_pat_'.repeat(MEGABYTE / 11)],
  ['github_pat_ and a megabyte of letters and underscores', () => `github_pat_${'a_'.repeat(MEGABYTE / 2)}`],
  ['sk- over and over', () => 'sk-'.repeat(MEGABYTE / 3)],
  ['sk- and a megabyte of letters', () => `sk-${'a'.repeat(MEGABYTE)}`],
  ['AKIA over and over', () => 'AKIA'.repeat(MEGABYTE / 4)],
  ['AKIA and a megabyte of capitals', () => `AKIA${'A'.repeat(MEGABYTE)}`],
  ['a long unbroken mix of every prefix', () => 'ghp_github_pat_sk-AKIA-----BEGIN '.repeat(MEGABYTE / 33)],
  ['a megabyte of letters', () => 'a'.repeat(MEGABYTE)],
  ['a megabyte of dashes', () => '-'.repeat(MEGABYTE)],
]

for (const [name, build] of nearMisses) {
  test(`a megabyte of ${name} takes well under a second to scan and to mask`, () => {
    const text = build()
    assert.ok(text.length >= MEGABYTE * 0.9, `built ${text.length}`)
    const scan = took(() => secretKind(text))
    assert.ok(scan < 500, `secretKind took ${scan.toFixed(0)} ms`)
    let masked = ''
    const time = took(() => { masked = maskSecrets(text) })
    assert.ok(time < 500, `maskSecrets took ${time.toFixed(0)} ms`)
    assert.equal(secretKind(masked), undefined)
  })
}

test('a megabyte of glued tokens is masked in one pass over it, not one pass for each', () => {
  const text = GH.repeat(MEGABYTE / GH.length)
  const count = Math.floor(MEGABYTE / GH.length)
  let masked = ''
  const time = took(() => { masked = maskSecrets(text) })
  assert.ok(time < 500, `maskSecrets took ${time.toFixed(0)} ms for ${count} tokens`)
  assert.equal(masked, GH_MASK.repeat(count))
  const mixed = `${GH}${PAT}${SK} ${AKIA}${GH2}`.repeat(10_000)
  const mixedTime = took(() => { masked = maskSecrets(mixed) })
  assert.ok(mixedTime < 1_000, `maskSecrets took ${mixedTime.toFixed(0)} ms`)
  assert.equal(masked, `${GH_MASK}${PAT_MASK}${SK_MASK} ${AKIA_MASK}${GH_MASK}`.repeat(10_000))
})

test('a long text with many secrets is masked in a reasonable time', () => {
  const text = `${'filler line with nothing in it\n'.repeat(20_000)}${`${GH} ${AKIA}\n`.repeat(2_000)}`
  let masked = ''
  const time = took(() => { masked = maskSecrets(text) })
  assert.ok(time < 1_000)
  assert.equal(secretKind(masked), undefined)
  assert.equal(masked.split(GH_MASK).length - 1, 2_000)
})
