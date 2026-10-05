import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { CREW_ROLES, namespaceSpecs, pathFor, roleFor, validate } from '../src/roles.ts'
import { DEFAULTS, defaultText } from '../src/defaults.ts'

const ALL_ROLES = ['common', 'main', ...CREW_ROLES]

const EMPTY_MESSAGE = 'a prompt can\'t be empty; use Reset to go back to the default'

// --- paths and roles -------------------------------------------------------------------------

test('the crew roles are the six the spec names', () => {
  assert.deepEqual([...CREW_ROLES], ['architect', 'coder', 'researcher', 'ops', 'writer', 'reviewer'])
})

test('pathFor maps common, main and every crew role to its document', () => {
  assert.equal(pathFor('common'), 'prompts/common.md')
  assert.equal(pathFor('main'), 'prompts/main.md')
  for (const role of CREW_ROLES) assert.equal(pathFor(role), `prompts/crew/${role}.md`)
  assert.equal(pathFor('data-2'), 'prompts/crew/data-2.md')
})

test('pathFor and roleFor round-trip for every role, including a crew role nobody shipped', () => {
  for (const role of [...ALL_ROLES, 'data-2', 'x']) {
    assert.equal(roleFor(pathFor(role)), role)
  }
})

test('pathFor refuses a role that has no document', () => {
  for (const role of ['', 'A', 'Coder', '1a', '-a', 'a b', 'a_b', 'a/b', '../main', 'a.md', 'é']) {
    assert.throws(() => pathFor(role), /invalid role/, JSON.stringify(role))
  }
})

test('roleFor rejects anything that is not a prompt document', () => {
  for (const path of [
    'prompts/crew/a/b.md', // a subdirectory
    'prompts/crew/A.md', // an upper-case role
    'prompts/x.md', // not common or main
    'prompts/crew/.md',
    'prompts/crew/1a.md',
    'prompts/crew/a_b.md',
    'prompts/crew/coder.txt',
    'prompts/crew/coder.md/',
    'prompts/crew/coder',
    'prompts/crew/',
    'prompts/crew',
    'prompts/common.md/x',
    'prompts/Common.md',
    'prompts/crew/coder.md\n',
    'x/prompts/crew/coder.md',
    'prompts/crew/../main.md',
    'crew/coder.md',
    'README.md',
    '',
  ]) {
    assert.equal(roleFor(path), undefined, JSON.stringify(path))
  }
})

test('"common" and "main" are reserved: a crew document of that name is no role', () => {
  // pathFor('main') is prompts/main.md, so prompts/crew/main.md could never be reached by a role.
  assert.equal(roleFor('prompts/crew/main.md'), undefined)
  assert.equal(roleFor('prompts/crew/common.md'), undefined)
})

// --- validation ------------------------------------------------------------------------------

test('validate refuses an empty or whitespace-only prompt, with the Reset hint', () => {
  for (const path of ['prompts/common.md', 'prompts/main.md', 'prompts/crew/coder.md']) {
    for (const text of ['', ' ', '\n', ' \t\r\n  ', '  ']) {
      assert.equal(validate(path, text), EMPTY_MESSAGE, `${path} ${JSON.stringify(text)}`)
    }
    assert.equal(validate(path, 'x'), undefined)
    assert.equal(validate(path, '  text  \n'), undefined)
  }
})

test('validate refuses a path under prompts/crew/ that is not <role>.md', () => {
  for (const path of [
    'prompts/crew/a/b.md',
    'prompts/crew/A.md',
    'prompts/crew/.md',
    'prompts/crew/a_b.md',
    'prompts/crew/coder.txt',
    'prompts/crew/main.md',
    'prompts/crew/common.md',
  ]) {
    const message = validate(path, 'real text')
    assert.ok(message !== undefined, `${path} should be refused`)
    assert.match(message, /^not a crew prompt: use prompts\/crew\/<role>\.md, where <role> /, path)
    // The store prefixes every message with the path, so the message must not repeat it.
    assert.ok(!message.includes(path), `${path} is repeated in: ${message}`)
  }
  assert.equal(
    validate('prompts/crew/A.md', 'x'),
    'not a crew prompt: use prompts/crew/<role>.md, where <role> is lowercase letters, digits and hyphens, '
    + 'starts with a letter, and isn\'t "common" or "main"')
  // The path is judged before the text, so a bad path says so even when the text is empty too.
  assert.match(validate('prompts/crew/a/b.md', '')!, /^not a crew prompt: /)
})

test('validate accepts a role the crew spec allows, and refuses a path that is no prompt at all', () => {
  assert.equal(validate('prompts/crew/data-2.md', 'text'), undefined)
  assert.equal(validate('prompts/crew/a.md', 'text'), undefined)
  assert.equal(
    validate('prompts/x.md', 'text'),
    'not a prompt document: use prompts/common.md, prompts/main.md or prompts/crew/<role>.md')
})

// --- namespace specs -------------------------------------------------------------------------

test('namespaceSpecs: two single-file claims that only propose, and the crew subtree, which accepts writes', () => {
  const specs = namespaceSpecs('dish-prompts')
  assert.deepEqual(
    specs.map(({ prefix, agent, owner }) => ({ prefix, agent, owner })),
    [
      { prefix: 'prompts/common.md', agent: 'propose', owner: 'dish-prompts' },
      { prefix: 'prompts/main.md', agent: 'propose', owner: 'dish-prompts' },
      { prefix: 'prompts/crew/', agent: 'write', owner: 'dish-prompts' },
    ])
})

test('namespaceSpecs carries the owner it is given', () => {
  assert.deepEqual([...new Set(namespaceSpecs('someone-else').map(spec => spec.owner))], ['someone-else'])
})

test('namespaceSpecs: every claim validates with the same rules as validate', () => {
  const [common, main, crew] = namespaceSpecs('dish-prompts')
  for (const spec of [common!, main!]) {
    assert.equal(spec.validate(spec.prefix, ''), EMPTY_MESSAGE)
    assert.equal(spec.validate(spec.prefix, ' \n'), EMPTY_MESSAGE)
    assert.equal(spec.validate(spec.prefix, 'text'), undefined)
  }
  assert.equal(crew!.validate('prompts/crew/coder.md', ''), EMPTY_MESSAGE)
  assert.equal(crew!.validate('prompts/crew/coder.md', 'text'), undefined)
  assert.match(crew!.validate('prompts/crew/a/b.md', 'text')!, /^not a crew prompt: /)
  assert.match(crew!.validate('prompts/crew/A.md', 'text')!, /^not a crew prompt: /)
})

test('namespaceSpecs makes a fresh set each time', () => {
  assert.notEqual(namespaceSpecs('a')[0], namespaceSpecs('a')[0])
})

// --- defaults --------------------------------------------------------------------------------

test('DEFAULTS has exactly the eight roles, each non-empty and under 9 KiB', () => {
  assert.deepEqual(Object.keys(DEFAULTS).sort(), [...ALL_ROLES].sort())
  for (const role of ALL_ROLES) {
    const text = DEFAULTS[role]!
    assert.ok(text.trim() !== '', `${role} is empty`)
    assert.ok(Buffer.byteLength(text) < 9216, `${role} is ${Buffer.byteLength(text)} bytes`)
  }
})

test('every default is a valid prompt for its own document, and ends with a single newline', () => {
  for (const role of ALL_ROLES) {
    const text = DEFAULTS[role]!
    assert.equal(validate(pathFor(role), text), undefined, role)
    assert.ok(text.endsWith('\n') && !text.endsWith('\n\n'), `${role} should end with one newline`)
  }
})

test('defaultText returns the role\'s default, and undefined for a role with none', () => {
  for (const role of ALL_ROLES) assert.equal(defaultText(role), DEFAULTS[role])
  assert.equal(defaultText('nobody'), undefined)
  // Inherited names are not roles.
  assert.equal(defaultText('constructor'), undefined)
  assert.equal(defaultText('toString'), undefined)
})

test('DEFAULTS cannot be changed by a caller', () => {
  assert.ok(Object.isFrozen(DEFAULTS))
})

test('DEFAULTS inherits nothing: "constructor" is a legal crew role, and has no default', () => {
  assert.equal(Object.getPrototypeOf(DEFAULTS), null)
  assert.equal(DEFAULTS['constructor'], undefined)
  assert.equal(DEFAULTS['__proto__'], undefined)
  assert.equal(DEFAULTS['toString'], undefined)
  assert.equal(validate('prompts/crew/constructor.md', 'text'), undefined)
})

test('the shipped files are laid out like the store, one per role, with previous.json beside them', () => {
  const dir = new URL('../defaults/', import.meta.url)
  assert.deepEqual(readdirSync(dir).sort(), ['common.md', 'crew', 'main.md', 'previous.json'])
  assert.deepEqual(readdirSync(new URL('crew/', dir)).sort(), CREW_ROLES.map(role => `${role}.md`).sort())
})

/** The names of the `{{variable}}` groups in `text`, with every `{{` accounted for. */
function variables(text: string): string[] {
  const names = [...text.matchAll(/\{\{([^{}]*)\}\}/g)].map(match => match[1]!)
  assert.equal((text.match(/\{\{/g) ?? []).length, names.length, 'a "{{" that is not a well-formed variable')
  assert.equal((text.match(/\}\}/g) ?? []).length, names.length, 'a "}}" that is not a well-formed variable')
  return names
}

test('the crew defaults, and main, use only {{model}}; common uses only {{cwd}}', () => {
  for (const role of ['main', ...CREW_ROLES]) {
    assert.deepEqual([...new Set(variables(DEFAULTS[role]!))], ['model'], role)
  }
  assert.deepEqual([...new Set(variables(DEFAULTS.common!))], ['cwd'])
})
