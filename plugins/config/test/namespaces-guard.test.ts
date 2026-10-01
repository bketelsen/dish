import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ConfigStoreError } from '../src/store/errors.ts'
import { checkContent } from '../src/store/guard.ts'
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
  assert.equal(registry.all().length, 5)
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
  { name: 'AKIA', secret: `AKIA${'IOSFODNN7EXAMPLE'}`, label: 'an AWS access key ID' },
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
