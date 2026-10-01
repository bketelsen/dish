import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ConfigStoreError } from '../src/store/errors.ts'
import { checkContent, secretKind } from '../src/store/guard.ts'
import { NamespaceRegistry } from '../src/store/namespaces.ts'
import type { NamespaceSpec } from '../src/store/namespaces.ts'

const MAX = 262144

function spec(prefix: string, owner = 'test', agent: NamespaceSpec['agent'] = 'write'): NamespaceSpec {
  return { prefix, owner, agent, validate: () => undefined }
}

/** `assert.throws` for the plain `Error` a bad claim raises: a programmer error, never a `ConfigStoreError`. */
function assertBadClaim(registry: NamespaceRegistry, bad: unknown, message: RegExp): void {
  assert.throws(() => registry.claim(bad as NamespaceSpec), (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.ok(!(error instanceof ConfigStoreError), 'a bad claim is a programmer error, not a ConfigStoreError')
    assert.match(error.message, message)
    return true
  })
}

// --- NamespaceRegistry -----------------------------------------------------------------------

test('a subtree claim owns everything under it, and nothing that merely shares the spelling', () => {
  const registry = new NamespaceRegistry()
  const prompts = spec('prompts/', 'prompts')
  registry.claim(prompts)
  assert.equal(registry.ownerOf('prompts/coder.md'), prompts)
  assert.equal(registry.ownerOf('prompts/deep/er/x.md'), prompts)
  assert.equal(registry.ownerOf('promptsx/coder.md'), undefined)
  assert.equal(registry.ownerOf('prompts'), undefined)
  assert.equal(registry.ownerOf('other/prompts/a.md'), undefined)
})

test('an exact-path claim owns that path only', () => {
  const registry = new NamespaceRegistry()
  const crew = spec('crew.yaml', 'crew')
  registry.claim(crew)
  assert.equal(registry.ownerOf('crew.yaml'), crew)
  assert.equal(registry.ownerOf('crew.yaml.bak'), undefined)
  assert.equal(registry.ownerOf('crew.yaml/x'), undefined)
  assert.equal(registry.ownerOf('crew'), undefined)
})

test('releasing a claim makes the path unowned, and the prefix claimable again', () => {
  const registry = new NamespaceRegistry()
  const release = registry.claim(spec('prompts/'))
  assert.ok(registry.ownerOf('prompts/a.md'))
  release()
  assert.equal(registry.ownerOf('prompts/a.md'), undefined)
  assert.deepEqual(registry.all(), [])
  const again = spec('prompts/', 'again')
  registry.claim(again)
  assert.equal(registry.ownerOf('prompts/a.md'), again)
})

test('all() lists the live claims in claim order', () => {
  const registry = new NamespaceRegistry()
  const a = spec('a/')
  const b = spec('b.yaml')
  const c = spec('c/')
  registry.claim(a)
  const releaseB = registry.claim(b)
  registry.claim(c)
  assert.deepEqual(registry.all(), [a, b, c])
  releaseB()
  assert.deepEqual(registry.all(), [a, c])
})

test('all() returns a copy: changing it does not change the registry', () => {
  const registry = new NamespaceRegistry()
  registry.claim(spec('a/'))
  registry.all().length = 0
  registry.all().push(spec('b/'))
  assert.equal(registry.all().length, 1)
  assert.equal(registry.ownerOf('b/x.md'), undefined)
})

test('overlapping claims are refused: subtree inside subtree, either order, and the same subtree', () => {
  const registry = new NamespaceRegistry()
  registry.claim(spec('prompts/', 'prompts'))
  assertBadClaim(registry, spec('prompts/x/'), /overlap/)
  assertBadClaim(registry, spec('prompts/'), /overlap/)
  assertBadClaim(registry, spec('prompts/a.md'), /overlap/)

  const inner = new NamespaceRegistry()
  inner.claim(spec('prompts/x/'))
  assertBadClaim(inner, spec('prompts/'), /overlap/)
})

test('overlapping claims are refused: identical exact paths, and an exact path inside a subtree', () => {
  const registry = new NamespaceRegistry()
  registry.claim(spec('crew.yaml'))
  assertBadClaim(registry, spec('crew.yaml'), /overlap/)

  const inner = new NamespaceRegistry()
  inner.claim(spec('prompts/a.md'))
  assertBadClaim(inner, spec('prompts/'), /overlap/)
})

test('a file and a directory of the same name overlap, since one tree cannot hold both', () => {
  for (const [first, second] of [['prompts', 'prompts/'], ['prompts/', 'prompts'], ['x/y', 'x/y/z'], ['x/y/z', 'x/y'],
    ['x/y', 'x/y/z/'], ['x/y/z/', 'x/y'], ['x/y/', 'x/y/z']]) {
    const registry = new NamespaceRegistry()
    registry.claim(spec(first))
    assertBadClaim(registry, spec(second), /overlap/)
    assert.equal(registry.all().length, 1)
  }
})

test('a refused overlap names both owners and leaves the registry unchanged', () => {
  const registry = new NamespaceRegistry()
  const first = spec('prompts/', 'prompts-plugin')
  registry.claim(first)
  assertBadClaim(registry, spec('prompts/x/', 'greedy-plugin'), /prompts-plugin.*greedy-plugin|greedy-plugin.*prompts-plugin/)
  assert.deepEqual(registry.all(), [first])
})

test('claims that only share a spelling do not overlap', () => {
  const registry = new NamespaceRegistry()
  registry.claim(spec('crew.yaml'))
  registry.claim(spec('crew.yaml.bak'))
  registry.claim(spec('prompts/'))
  registry.claim(spec('promptsx/'))
  registry.claim(spec('prompt/'))
  registry.claim(spec('x/y'))
  registry.claim(spec('x/yz/'))
  registry.claim(spec('x/y.md'))
  assert.equal(registry.all().length, 8)
})

test('the disposer is idempotent and removes only its own claim', () => {
  const registry = new NamespaceRegistry()
  const old = spec('prompts/', 'old')
  const release = registry.claim(old)
  release()
  const fresh = spec('prompts/', 'fresh')
  registry.claim(fresh)
  release()
  release()
  assert.equal(registry.ownerOf('prompts/a.md'), fresh)
  assert.deepEqual(registry.all(), [fresh])
})

test('claiming the same spec object again after release gets a claim its old disposer cannot remove', () => {
  const registry = new NamespaceRegistry()
  const s = spec('prompts/')
  const first = registry.claim(s)
  first()
  const second = registry.claim(s)
  first()
  assert.equal(registry.ownerOf('prompts/a.md'), s)
  second()
  assert.equal(registry.ownerOf('prompts/a.md'), undefined)
})

test('ownerOf refuses paths that cannot be documents, even when a prefix matches them lexically', () => {
  const registry = new NamespaceRegistry()
  registry.claim(spec('prompts/', 'prompts'))
  registry.claim(spec('crew.yaml', 'crew', 'none'))
  assert.equal(registry.ownerOf('prompts/../crew.yaml'), undefined)
  assert.equal(registry.ownerOf('prompts/./a.md'), undefined)
  assert.equal(registry.ownerOf('prompts//a.md'), undefined)
  assert.equal(registry.ownerOf('prompts/a\\b.md'), undefined)
  assert.equal(registry.ownerOf('prompts/a\nb.md'), undefined)
  assert.equal(registry.ownerOf('prompts/.git/config'), undefined)
  assert.equal(registry.ownerOf('prompts/'), undefined)
  assert.equal(registry.ownerOf('/prompts/a.md'), undefined)
  assert.equal(registry.ownerOf(''), undefined)
})

test('claim refuses a bad prefix with a plain Error', () => {
  const registry = new NamespaceRegistry()
  const bad = [
    '', '/', '/prompts/', '/crew.yaml', 'a\\b/', 'a\\b', '..', '../', '../x/', 'a/../b/', 'a/..', '.', './', 'a/./b/',
    'a//b/', 'a//b', '//', 'prompts//', 'a\nb/', 'prompts/.git/', '.git',
  ]
  for (const prefix of bad) assertBadClaim(registry, spec(prefix), /invalid namespace prefix/)
  assertBadClaim(registry, { ...spec('a/'), prefix: undefined }, /prefix/)
  assertBadClaim(registry, { ...spec('a/'), prefix: 7 }, /prefix/)
  assert.deepEqual(registry.all(), [])
})

test('claim accepts ordinary prefixes', () => {
  const registry = new NamespaceRegistry()
  for (const prefix of ['prompts/', 'crew.yaml', 'families/', 'a/b/c/', 'a/b.yaml', '.config/', 'My Docs/']) {
    registry.claim(spec(prefix))
  }
  assert.equal(registry.all().length, 7)
})

test('claim refuses a missing owner, a bad agent policy, or a missing validate', () => {
  const registry = new NamespaceRegistry()
  assertBadClaim(registry, { ...spec('a/'), owner: '' }, /owner/)
  assertBadClaim(registry, { ...spec('a/'), owner: undefined }, /owner/)
  assertBadClaim(registry, { ...spec('a/'), agent: 'admin' }, /agent/)
  assertBadClaim(registry, { ...spec('a/'), agent: undefined }, /agent/)
  assertBadClaim(registry, { ...spec('a/'), validate: undefined }, /validate/)
  assertBadClaim(registry, { ...spec('a/'), validate: 'yes' }, /validate/)
  assertBadClaim(registry, undefined, /spec/)
  assertBadClaim(registry, null, /spec/)
  assert.deepEqual(registry.all(), [])
  for (const agent of ['write', 'propose', 'none'] as const) registry.claim(spec(`${agent}/`, 'o', agent))
  assert.equal(registry.all().length, 3)
})

test('a spec whose validate uses `this` still works through the registry', () => {
  const registry = new NamespaceRegistry()
  const s = {
    prefix: 'a/',
    owner: 'o',
    agent: 'write' as const,
    message: 'nope',
    validate(this: { message: string }) { return this.message },
  }
  registry.claim(s)
  assert.equal(registry.ownerOf('a/x')?.validate('a/x', ''), 'nope')
})

// --- checkContent ----------------------------------------------------------------------------

/** The error `checkContent` throws, or a failure if it doesn't throw. */
function refusal(path: string, text: string, maxBytes = MAX): ConfigStoreError {
  try {
    checkContent(path, text, maxBytes)
  } catch (error) {
    assert.ok(error instanceof ConfigStoreError, `expected a ConfigStoreError, got ${String(error)}`)
    return error
  }
  assert.fail('checkContent accepted it')
}

/** The error message shows no part of the secret: not all of it, and not any 8-character stretch of it. */
function assertNoLeak(message: string, secret: string, around: string[] = []): void {
  assert.ok(!message.includes(secret), 'message contains the whole secret')
  for (let i = 0; i + 8 <= secret.length; i++) {
    assert.ok(!message.includes(secret.slice(i, i + 8)), `message contains part of the secret: ${secret.slice(i, i + 8)}`)
  }
  for (const text of around) assert.ok(!message.includes(text), `message contains surrounding content: ${text}`)
}

// The secrets are assembled at run time so this file never contains one that a scanner would flag.
const GH_BODY = 'Zq9Xk2'.repeat(6)
const secrets: Array<{ name: string, secret: string, label: string }> = [
  { name: 'ghp_', secret: `ghp_${GH_BODY}`, label: 'a GitHub token' },
  { name: 'gho_', secret: `gho_${GH_BODY}`, label: 'a GitHub token' },
  { name: 'ghu_', secret: `ghu_${GH_BODY}`, label: 'a GitHub token' },
  { name: 'ghs_', secret: `ghs_${GH_BODY}`, label: 'a GitHub token' },
  { name: 'ghr_', secret: `ghr_${GH_BODY}`, label: 'a GitHub token' },
  { name: 'longer ghp_', secret: `ghp_${GH_BODY}${GH_BODY}`, label: 'a GitHub token' },
  { name: 'github_pat_', secret: `github_pat_${'Qw7Lm3'.repeat(4)}_${'Rt5Yp8'.repeat(10)}`, label: 'a GitHub fine-grained token' },
  { name: 'sk-', secret: `sk-${'Hj4Nb6'.repeat(6)}`, label: 'an sk- API key' },
  { name: 'sk-proj style', secret: `sk-proj-${'Ac8Vd1'.repeat(5)}_${'Mn2Bx7'.repeat(3)}`, label: 'an sk- API key' },
  { name: 'OPENSSH private key', secret: `-----BEGIN ${'OPENSSH'} PRIVATE KEY-----`, label: 'a private key' },
  { name: 'RSA private key', secret: `-----BEGIN ${'RSA'} PRIVATE KEY-----`, label: 'a private key' },
  { name: 'bare private key', secret: `-----BEGIN PRIVATE KEY-----`, label: 'a private key' },
  { name: 'encrypted private key', secret: `-----BEGIN ${'ENCRYPTED'} PRIVATE KEY-----`, label: 'a private key' },
  { name: 'PGP private key block', secret: `-----BEGIN ${'PGP'} PRIVATE KEY BLOCK-----`, label: 'a private key' },
  { name: 'AKIA', secret: `AKIA${'IOSFODNN7EXAMPLE'}`, label: 'an AWS access key ID' },
  { name: 'ASIA (temporary AWS key)', secret: `ASIA${'IOSFODNN7EXAMPLE'}`, label: 'an AWS access key ID' },
]

for (const { name, secret, label } of secrets) {
  test(`checkContent refuses ${name}, naming the kind and the path but never the secret`, () => {
    const text = `intro line mentioning pelican\nkey = ${secret}\ntrailing line about walrus\n`
    const error = refusal('prompts/coder.md', text)
    assert.equal(error.code, 'SECRET')
    assert.equal(error.message, `prompts/coder.md: looks like ${label}`)
    assertNoLeak(error.message, secret, ['pelican', 'walrus', 'key ='])
  })
}

// A token glued to other word characters is still a token: `_` and `-` are not letters or digits.
const GH = `ghp_${GH_BODY}`
const PAT = `github_pat_${'Qw7Lm3'.repeat(4)}_${'Rt5Yp8'.repeat(10)}`
const SK = `sk-${'Hj4Nb6'.repeat(6)}`
const AKIA = `AKIA${'IOSFODNN7EXAMPLE'}`
const wrapped: Array<{ name: string, text: string, secret: string, label: string }> = [
  { name: 'ghp_ token then _old', text: `${GH}_old`, secret: GH, label: 'a GitHub token' },
  { name: 'ghp_ token in underscores', text: `_${GH}_`, secret: GH, label: 'a GitHub token' },
  { name: 'ghp_ token in double underscores', text: `__${GH}__`, secret: GH, label: 'a GitHub token' },
  { name: 'ghp_ token after TOKEN_', text: `TOKEN_${GH}`, secret: GH, label: 'a GitHub token' },
  { name: 'ghp_ token followed by letters', text: `${GH}tail`, secret: GH, label: 'a GitHub token' },
  { name: 'github_pat_ token in underscores', text: `_${PAT}_`, secret: PAT, label: 'a GitHub fine-grained token' },
  { name: 'github_pat_ token after an equals sign', text: `GITHUB_TOKEN=${PAT}`, secret: PAT, label: 'a GitHub fine-grained token' },
  { name: 'sk- key in underscores', text: `_${SK}_`, secret: SK, label: 'an sk- API key' },
  { name: 'sk- key after an equals sign', text: `API_KEY=${SK}`, secret: SK, label: 'an sk- API key' },
  { name: 'AKIA key then _x', text: `${AKIA}_x`, secret: AKIA, label: 'an AWS access key ID' },
  { name: 'AKIA key then lowercase letters', text: `${AKIA}abc`, secret: AKIA, label: 'an AWS access key ID' },
  { name: 'AKIA key in underscores', text: `_${AKIA}_`, secret: AKIA, label: 'an AWS access key ID' },
  { name: 'AKIA key after a prefix and underscore', text: `AWS_KEY_${AKIA}`, secret: AKIA, label: 'an AWS access key ID' },
]

for (const { name, text, secret, label } of wrapped) {
  test(`checkContent refuses a wrapped secret: ${name}`, () => {
    const error = refusal('prompts/coder.md', `before\n${text}\nafter\n`)
    assert.equal(error.code, 'SECRET')
    assert.equal(error.message, `prompts/coder.md: looks like ${label}`)
    assertNoLeak(error.message, secret)
  })
}

// In a YAML double-quoted string or a JSON one, a line break is written `\n`: a backslash and a letter. The letter is right in
// front of whatever follows, and used to hide a token there from the guard, though a parser reads it as a token on its own line.
const escapedIn: Array<{ name: string, text: string, secret: string, label: string }> = [
  { name: 'ghp_ token after \\n in a YAML double-quoted string', text: `note: "first line\\n${GH}"`, secret: GH, label: 'a GitHub token' },
  { name: 'ghp_ token after \\t in a YAML double-quoted string', text: `note: "first\\t${GH}"`, secret: GH, label: 'a GitHub token' },
  { name: 'ghp_ token after \\r\\n in a YAML double-quoted string', text: `note: "first line\\r\\n${GH}"`, secret: GH, label: 'a GitHub token' },
  { name: 'ghp_ token after an escaped backslash and n', text: `note: "first line\\\\n${GH}"`, secret: GH, label: 'a GitHub token' },
  { name: 'github_pat_ token after \\n', text: `note: "x\\n${PAT}"`, secret: PAT, label: 'a GitHub fine-grained token' },
  { name: 'sk- key after \\t in a JSON object', text: `{"key": "x\\t${SK}"}`, secret: SK, label: 'an sk- API key' },
  { name: 'sk- key after \\n in a JSON array', text: `["first\\n${SK}"]`, secret: SK, label: 'an sk- API key' },
]

for (const { name, text, secret, label } of escapedIn) {
  test(`checkContent refuses a token that follows an escape sequence: ${name}`, () => {
    const error = refusal('prompts/coder.md', `before\n${text}\nafter\n`)
    assert.equal(error.code, 'SECRET')
    assert.equal(error.message, `prompts/coder.md: looks like ${label}`)
    assertNoLeak(error.message, secret)
  })
}

test('checkContent allows a token-shaped run that follows a plain letter, escape or not', () => {
  for (const text of [`note: "x${GH}"`, `note: "first line\\nx${GH}"`, `{"key": "x${SK}"}`, `note: "first line\\n1${PAT}"`]) {
    assert.doesNotThrow(() => checkContent('prompts/coder.md', text, MAX), text)
  }
})

test('secretKind names the kind of the first secret in a text, or nothing', () => {
  assert.equal(secretKind(`key ${GH}`), 'a GitHub token')
  assert.equal(secretKind(`key ${AKIA}`), 'an AWS access key ID')
  assert.equal(secretKind('a GitHub token, an AWS key, a PEM header'), undefined)
  assert.equal(secretKind(''), undefined)
})

test('a secret anywhere in the text is found: first byte, last byte, in the middle of a long document', () => {
  const secret = `ghp_${GH_BODY}`
  assert.equal(refusal('a.md', secret).code, 'SECRET')
  assert.equal(refusal('a.md', `${'filler line\n'.repeat(5000)}${secret}`).code, 'SECRET')
  assert.equal(refusal('a.md', `${secret}${'\nfiller line'.repeat(5000)}`).code, 'SECRET')
})

test('checkContent allows prose that mentions credentials without containing one', () => {
  const prose = [
    'Never paste a GitHub token or an AWS access key into a prompt.',
    'Tokens start with ghp_ or gho_, keys with sk- or AKIA, and PEM files with a BEGIN PRIVATE KEY line.',
    'Use `github_pat_` tokens sparingly, and never `sk-` ones.',
    'ghp_tooshort and sk-tooshort and AKIASHORT',
    'AKIA' + 'a'.repeat(16),
    'xghp_' + 'a'.repeat(36),
    'The key is -----BEGIN-----.',
    'github_pat_token_for_deploy_scripts',
    'Words that merely end in sk-: risk-assessment-for-the-whole-release-pipeline, task-runner-configuration-for-ci.',
    '-----BEGIN CERTIFICATE-----',
  ].join('\n')
  checkContent('prompts/security.md', prose, MAX)
  checkContent('empty.md', '', MAX)
  checkContent('crew.yaml', 'crew:\n  coder:\n    model: deepseek-chat\n', MAX)
})

test('the size limit is exact and counts bytes, not characters', () => {
  checkContent('a.md', 'a'.repeat(MAX), MAX)
  const over = refusal('prompts/big.md', 'a'.repeat(MAX + 1))
  assert.equal(over.code, 'TOO_LARGE')
  assert.match(over.message, /^prompts\/big\.md: /)
  assert.match(over.message, /262145/)
  assert.match(over.message, /262144/)

  // 3 bytes per character: well under the limit in characters, over it in bytes.
  const euro = '€'.repeat(Math.floor(MAX / 3) + 1)
  assert.ok(euro.length < MAX)
  assert.equal(refusal('a.md', euro).code, 'TOO_LARGE')
  checkContent('a.md', '€'.repeat(Math.floor(MAX / 3)), MAX)

  assert.equal(refusal('a.md', 'abcd', 3).code, 'TOO_LARGE')
  checkContent('a.md', 'abc', 3)
})

test('the size check runs before the secret scan, and never shows content', () => {
  const secret = `ghp_${GH_BODY}`
  const error = refusal('a.md', `${secret}${'x'.repeat(MAX)}`)
  assert.equal(error.code, 'TOO_LARGE')
  assertNoLeak(error.message, secret)
})

test('a secret in the path is refused without showing the path, whatever the body is', () => {
  for (const { name, secret, label } of secrets) {
    const path = `prompts/${secret}.md`
    const error = refusal(path, 'hello')
    assert.equal(error.code, 'SECRET', name)
    assert.equal(error.message, `the document path looks like ${label}`, name)
    assertNoLeak(error.message, secret, ['prompts/'])
  }
})

test('the path is scanned before the size, so an oversized body never gets a message that shows a secret path', () => {
  const secret = `ghp_${GH_BODY}`
  const error = refusal(`prompts/${secret}.md`, 'x'.repeat(300_000))
  assert.equal(error.code, 'SECRET')
  assert.equal(error.message, 'the document path looks like a GitHub token')
  assertNoLeak(error.message, secret)
  // A path with no secret in it is still named in a TOO_LARGE message.
  assert.equal(refusal('prompts/big.md', 'x'.repeat(300_000)).message.startsWith('prompts/big.md: '), true)
})

test('a secret path wins over a secret body, and a clean path with a secret body still names the path', () => {
  const body = `ghp_${GH_BODY}`
  assert.equal(refusal(`prompts/${AKIA}.md`, body).message, 'the document path looks like an AWS access key ID')
  assert.equal(refusal('prompts/coder.md', body).message, 'prompts/coder.md: looks like a GitHub token')
})

test('wrapped secrets in a path are found too', () => {
  for (const { name, text, secret, label } of wrapped) {
    const error = refusal(`prompts/${text}.md`, 'hello')
    assert.equal(error.message, `the document path looks like ${label}`, name)
    assertNoLeak(error.message, secret)
  }
})

test('a path that could forge log lines is shown escaped', () => {
  const error = refusal('a\nFORGED: ok\n.md', `ghp_${GH_BODY}`)
  assert.equal(error.code, 'SECRET')
  assert.ok(!error.message.includes('\n'))
  assert.match(error.message, /looks like a GitHub token$/)
})

test('checkContent refuses a nonsensical size limit instead of silently allowing everything', () => {
  assert.throws(() => checkContent('a.md', 'x', Number.NaN), (error: unknown) => {
    assert.ok(error instanceof Error && !(error instanceof ConfigStoreError))
    return true
  })
  assert.throws(() => checkContent('a.md', 'x', -1), /maxBytes/)
  checkContent('a.md', 'x', Number.POSITIVE_INFINITY)
  checkContent('a.md', '', 0)
  assert.equal(refusal('a.md', 'x', 0).code, 'TOO_LARGE')
})
