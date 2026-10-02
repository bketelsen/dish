import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_DESCRIPTION,
  MAX_NAME,
  ROLE_NAME,
  SHIPPED_ROLES,
  SKILL_FILE,
  SKILL_NAME,
  SKILLS_PREFIX,
  WARN_CHARS,
  checkSkill,
  isSkillName,
  nameFor,
  namespaceSpec,
  offeredTo,
  parseSkill,
  pathFor,
  validate,
} from '../src/skill.ts'
import type { ParsedSkill } from '../src/skill.ts'

const PATH = 'skills/x/SKILL.md'

/** A document that passes every rule, built from the given frontmatter lines and body. */
function doc(frontmatter: string[] = ['name: x', 'description: Use when you are testing.'], body = 'Do the thing.'): string {
  return `---\n${frontmatter.join('\n')}\n---\n${body}\n`
}

/** The problem `parseSkill` reports for `text`, failing the test if it parses. */
function problemOf(text: string, path = PATH): string {
  const result = parseSkill(path, text)
  if (result.ok) assert.fail(`expected a problem for ${JSON.stringify(text)}`)
  return result.problem
}

/** The skill `parseSkill` returns for `text`, failing the test if it doesn't parse. */
function skillOf(text: string, path = PATH): ParsedSkill {
  const result = parseSkill(path, text)
  if (!result.ok) assert.fail(result.problem)
  return result.skill
}

// --- constants --------------------------------------------------------------------------------

test('the constants are the ones the spec names', () => {
  assert.equal(SKILLS_PREFIX, 'skills/')
  assert.equal(SKILL_FILE, 'SKILL.md')
  assert.equal(MAX_NAME, 64)
  assert.equal(MAX_DESCRIPTION, 1024)
  assert.equal(WARN_CHARS, 8000)
  assert.deepEqual([...SHIPPED_ROLES], ['main', 'architect', 'coder', 'reviewer', 'researcher', 'ops', 'writer'])
  assert.equal(SKILL_NAME.source, '^[a-z0-9]+(?:-[a-z0-9]+)*$')
  assert.equal(ROLE_NAME.source, '^[a-z][a-z0-9-]*$')
})

test('every shipped role is a valid role name', () => {
  for (const role of SHIPPED_ROLES) assert.match(role, ROLE_NAME)
})

// --- names and paths --------------------------------------------------------------------------

test('isSkillName takes dsh\'s grammar up to 64 characters', () => {
  for (const name of ['a', 'a1', '1', 'a-b', 'test-driven-development', '0-9', 'a'.repeat(64)]) {
    assert.equal(isSkillName(name), true, name)
  }
  for (const name of ['', 'A', 'Aa', 'a_b', '-a', 'a-', 'a--b', 'a b', 'a/b', 'a.b', 'é', '..', 'a'.repeat(65)]) {
    assert.equal(isSkillName(name), false, JSON.stringify(name))
  }
})

test('isSkillName is false for anything that is not a string', () => {
  for (const value of [undefined, null, 1, {}, ['a']]) {
    assert.equal(isSkillName(value as unknown as string), false)
  }
})

test('pathFor and nameFor round-trip', () => {
  for (const name of ['a', 'brainstorming', 'test-driven-development', 'a1-b2', 'a'.repeat(64)]) {
    assert.equal(pathFor(name), `skills/${name}/SKILL.md`)
    assert.equal(nameFor(pathFor(name)), name)
  }
})

test('pathFor throws on a name that is not a skill name', () => {
  for (const name of ['', 'A', 'a_b', 'a/b', '../x', 'a b', '-a', 'a'.repeat(65)]) {
    assert.throws(() => pathFor(name), /invalid skill name/, JSON.stringify(name))
  }
})

test('nameFor is undefined for any path that is not skills/<name>/SKILL.md', () => {
  for (const path of [
    '',
    'skills',
    'skills/',
    'skills/SKILL.md', // no name
    'skills//SKILL.md', // empty name
    'skills/x/skill.md', // wrong case
    'skills/x/SKILL.md.bak',
    'skills/x/README.md', // a second file beside it
    'skills/x/y/SKILL.md', // too deep
    'skills/X/SKILL.md', // upper case
    'skills/x_y/SKILL.md',
    `skills/${'a'.repeat(65)}/SKILL.md`,
    'prompts/x/SKILL.md', // another namespace
    'x/SKILL.md',
    '/skills/x/SKILL.md',
    'skills/x/SKILL.md/',
    'skills/x',
  ]) {
    assert.equal(nameFor(path), undefined, JSON.stringify(path))
  }
})

// --- parseSkill: the happy path ---------------------------------------------------------------

test('parseSkill reads a minimal skill', () => {
  const skill = skillOf(doc())
  assert.deepEqual(skill, {
    name: 'x',
    description: 'Use when you are testing.',
    roles: null,
    modelInvocable: true,
    userInvocable: true,
    metadata: {},
    body: 'Do the thing.',
  })
})

test('parseSkill reads the roles, the invocation flags and the rest of the metadata', () => {
  const skill = skillOf(doc([
    'name: x',
    'description: Use when you are testing.',
    'disable-model-invocation: true',
    'user-invocable: false',
    'license: MIT',
    'metadata:',
    '  roles: [coder, main]',
    '  note: kept',
  ]))
  assert.deepEqual(skill.roles, ['coder', 'main'])
  assert.equal(skill.modelInvocable, false)
  assert.equal(skill.userInvocable, false)
  assert.deepEqual(skill.metadata, { roles: ['coder', 'main'], note: 'kept' })
})

test('parseSkill: roles absent is every role, and an empty list is none', () => {
  assert.equal(skillOf(doc()).roles, null)
  assert.equal(skillOf(doc(['name: x', 'description: d', 'metadata: {}'])).roles, null)
  assert.deepEqual(skillOf(doc(['name: x', 'description: d', 'metadata:', '  roles: []'])).roles, [])
})

test('parseSkill: invocation is on unless the keys turn it off', () => {
  const on = skillOf(doc(['name: x', 'description: d', 'disable-model-invocation: false', 'user-invocable: true']))
  assert.equal(on.modelInvocable, true)
  assert.equal(on.userInvocable, true)
  const off = skillOf(doc(['name: x', 'description: d', 'disable-model-invocation: true']))
  assert.equal(off.modelInvocable, false)
  assert.equal(off.userInvocable, true)
})

test('parseSkill trims the body and keeps everything after the closing delimiter, a second --- included', () => {
  const skill = skillOf('---\nname: x\ndescription: d\n---\n\n\n# Title\n\ntext\n\n---\n\nmore\n\n\n')
  assert.equal(skill.body, '# Title\n\ntext\n\n---\n\nmore')
})

test('parseSkill accepts a document that ends right after the closing delimiter plus a body line', () => {
  assert.equal(skillOf('---\nname: x\ndescription: d\n---\nbody').body, 'body')
})

test('parseSkill reads YAML block scalars and quoted values in the description', () => {
  assert.equal(skillOf(doc(['name: x', 'description: >', '  Use when', '  folding.'])).description, 'Use when folding.')
  assert.equal(skillOf(doc(['name: x', 'description: "Use when: a colon"'])).description, 'Use when: a colon')
})

test('parseSkill measures the description after trimming: a folded block of 1024 characters is accepted, 1025 refused', () => {
  // A folded block scalar keeps one trailing newline, so the raw value is one longer than what is stored.
  const folded = (length: number) => doc(['name: x', 'description: >', `  ${'a'.repeat(length)}`])
  assert.equal(skillOf(folded(1024)).description, 'a'.repeat(1024))
  assert.equal(problemOf(folded(1025)), `${PATH}: description is 1025 characters; the most is 1024`)
  // Padding in a quoted value is trimmed first too.
  assert.equal(skillOf(doc(['name: x', `description: "  ${'a'.repeat(1024)}  "`])).description.length, 1024)
})

test('parseSkill trims the description', () => {
  assert.equal(skillOf(doc(['name: x', 'description: "  Use when padded.  "'])).description, 'Use when padded.')
})

// --- parseSkill: line endings and BOM ---------------------------------------------------------

test('parseSkill reads a document with CRLF line endings', () => {
  const text = doc(['name: x', 'description: d', 'metadata:', '  roles: [coder]'], 'one\ntwo').replaceAll('\n', '\r\n')
  const skill = skillOf(text)
  assert.equal(skill.description, 'd')
  assert.deepEqual(skill.roles, ['coder'])
  assert.equal(skill.body, 'one\ntwo')
})

test('parseSkill reads a document that starts with a UTF-8 BOM', () => {
  assert.equal(skillOf(`﻿${doc()}`).name, 'x')
  assert.equal(skillOf(`﻿${doc().replaceAll('\n', '\r\n')}`).name, 'x')
})

// --- parseSkill: refusals, in order -----------------------------------------------------------

test('parseSkill refuses a path that is not a skill document', () => {
  assert.equal(
    problemOf(doc(), 'skills/X/SKILL.md'),
    'skills/X/SKILL.md: not a skill document; use skills/<name>/SKILL.md, where <name> is lowercase letters, digits and hyphens, at most 64 characters',
  )
  assert.match(problemOf(doc(), 'prompts/main.md'), /^prompts\/main\.md: not a skill document/)
})

test('parseSkill refuses a document with no frontmatter', () => {
  const expected = `${PATH}: the frontmatter is missing; the document must start with a --- line`
  assert.equal(problemOf(''), expected)
  assert.equal(problemOf('Just text.\n'), expected)
  assert.equal(problemOf('---'), expected) // no newline after the opening delimiter
  assert.equal(problemOf(' ---\nname: x\n---\nbody'), expected)
  assert.equal(problemOf('\n---\nname: x\n---\nbody'), expected) // a blank line before it
  assert.equal(problemOf('--- \nname: x\n---\nbody'), expected) // not exactly ---
  assert.equal(problemOf('----\nname: x\n---\nbody'), expected)
})

test('parseSkill refuses frontmatter that is never closed', () => {
  const expected = `${PATH}: the frontmatter is not closed; end it with a --- line`
  assert.equal(problemOf('---\nname: x\ndescription: d\n'), expected)
  assert.equal(problemOf('---\nname: x\ndescription: d\n--- \nbody\n'), expected) // trailing space
  assert.equal(problemOf('---\nname: x\ndescription: d\n ---\nbody\n'), expected) // indented
  assert.equal(problemOf('---\nname: x\n----\nbody\n'), expected)
  assert.equal(problemOf('---\n'), expected)
})

test('parseSkill closes the frontmatter at the first line that is exactly ---', () => {
  // The second --- is body, not a second closer.
  assert.equal(skillOf('---\nname: x\ndescription: d\n---\n---\n').body, '---')
})

test('parseSkill refuses frontmatter that is not YAML', () => {
  const problem = problemOf('---\nname: [x\ndescription: d\n---\nbody\n')
  assert.match(problem, /^skills\/x\/SKILL\.md: the frontmatter isn't valid YAML: /)
  assert.ok(!problem.includes('\n'), 'one line')
})

test('parseSkill points at the line where the YAML went wrong, counted in the document', () => {
  // The document's line 1 is the opening ---, so the tab is on line 2.
  assert.match(problemOf('---\n\tname: x\n---\nbody\n'), /isn't valid YAML: .+ \(line 2\)$/)
  // The parser notices the unclosed list when it reaches the next entry, on line 3.
  assert.match(problemOf('---\nname: [x\ndescription: d\n---\nbody\n'), /isn't valid YAML: .+ \(line 3\)$/)
})

test('parseSkill refuses frontmatter that repeats a key', () => {
  assert.equal(
    problemOf('---\nname: x\nname: x\ndescription: d\n---\nbody\n'),
    `${PATH}: the frontmatter isn't valid YAML: duplicated mapping key (line 3)`,
  )
})

test('parseSkill uses no custom YAML types', () => {
  for (const tag of ['!!js/function "function () {}"', '!!python/object {}', '!!binary aGk=', '!!set {a, b}']) {
    const problem = problemOf(doc(['name: x', 'description: d', `extra: ${tag}`]))
    assert.match(problem, /isn't valid YAML/, tag)
  }
})

test('parseSkill refuses a YAML alias that makes a cycle', () => {
  const expected = `${PATH}: the frontmatter reuses a value through a YAML alias; write it out`
  assert.equal(problemOf(doc(['name: x', 'description: d', 'metadata: &m {self: *m}'])), expected)
  assert.equal(problemOf(doc(['name: x', 'description: d', 'extra: &e [*e]'])), expected)
})

test('parseSkill refuses any reused value, cyclic or not', () => {
  const expected = `${PATH}: the frontmatter reuses a value through a YAML alias; write it out`
  assert.equal(problemOf(doc(['name: x', 'description: d', 'a: &a [1]', 'b: *a'])), expected)
  assert.equal(problemOf(doc(['name: x', 'description: d', 'metadata:', '  one: &r {k: v}', '  two: *r'])), expected)
  // An alias of a plain string is no shared object.
  assert.equal(skillOf(doc(['name: x', 'description: &d Use when aliasing.', 'note: *d'])).description, 'Use when aliasing.')
})

test('parseSkill refuses a small alias bomb quickly', () => {
  // Nine levels of ten references each: a billion entries if anything walks it out. A document of about 600 bytes.
  const levels = 'abcdefghi'
  const lines = ['x0: &l0 [z, z, z, z, z, z, z, z, z, z]']
  for (let i = 1; i < levels.length; i++) lines.push(`x${i}: &l${i} [${Array(10).fill(`*l${i - 1}`).join(', ')}]`)
  const text = doc(['name: x', 'description: d', ...lines])
  assert.ok(text.length < 1000, `${text.length} bytes`)
  const started = performance.now()
  assert.equal(problemOf(text), `${PATH}: the frontmatter reuses a value through a YAML alias; write it out`)
  assert.ok(performance.now() - started < 2000, 'refused in linear time')
  // The same through the namespace validator, which is what the store calls.
  assert.equal(validate(PATH, text), 'the frontmatter reuses a value through a YAML alias; write it out')
})

/** The most entries of a flat list that fit in the store's 256 KiB limit as `a,a,a,...`. */
const LONG_LIST = 130_000

test('a list of 130000 entries is no problem: the alias check walks it without spreading it onto the stack', () => {
  const list = `[${'a,'.repeat(LONG_LIST)}a]`
  const text = doc(['name: x', 'description: Use when testing.', 'metadata:', `  other: ${list}`])
  assert.ok(text.length < 262_144, `${text.length} bytes fit the store's limit`)
  // Nothing throws: the document is valid, and what the store's validator says is that it is.
  const skill = skillOf(text)
  assert.equal((skill.metadata.other as unknown[]).length, LONG_LIST + 1)
  assert.equal(validate(PATH, text), undefined)
  assert.deepEqual(checkSkill(PATH, text, SHIPPED_ROLES).problems, [])
})

test('a very long list is still searched for a reused value', () => {
  const text = doc(['name: x', 'description: d', 'metadata:', `  other: [&r [1], ${'a,'.repeat(LONG_LIST)} *r]`])
  assert.equal(validate(PATH, text), 'the frontmatter reuses a value through a YAML alias; write it out')
})

test('parseSkill reads dates and timestamps as the plain strings they are', () => {
  const skill = skillOf(doc(['name: x', 'description: d', 'metadata:', '  updated: 2026-10-02']))
  assert.equal(skill.metadata.updated, '2026-10-02')
})

test('parseSkill refuses frontmatter that is not a mapping', () => {
  const expected = `${PATH}: the frontmatter must be a mapping of keys to values`
  assert.equal(problemOf('---\n---\nbody\n'), expected) // empty
  assert.equal(problemOf('---\n- a\n- b\n---\nbody\n'), expected)
  assert.equal(problemOf('---\njust a string\n---\nbody\n'), expected)
  assert.equal(problemOf('---\n42\n---\nbody\n'), expected)
  assert.equal(problemOf('---\nnull\n---\nbody\n'), expected)
})

test('parseSkill: name must be there and equal the folder', () => {
  assert.equal(problemOf(doc(['description: d'])), `${PATH}: name is missing`)
  assert.equal(problemOf(doc(['name: y', 'description: d'])), `${PATH}: name is "y" but the folder is "x"; they must match`)
  assert.equal(problemOf(doc(['name: X', 'description: d'])), `${PATH}: name is "X" but the folder is "x"; they must match`)
  assert.equal(problemOf(doc(['name: ""', 'description: d'])), `${PATH}: name is "" but the folder is "x"; they must match`)
  assert.equal(problemOf(doc(['name: 12', 'description: d'])), `${PATH}: name must be a string (got 12)`)
  assert.equal(problemOf(doc(['name: [x]', 'description: d'])), `${PATH}: name must be a string (got a list)`)
  assert.equal(problemOf(doc(['name: null', 'description: d'])), `${PATH}: name must be a string (got null)`)
})

test('parseSkill cuts a long wrong name short in its message', () => {
  const problem = problemOf(doc([`name: ${'z'.repeat(500)}`, 'description: d']))
  assert.ok(problem.length < 300, problem.length.toString())
  assert.match(problem, /…/)
})

test('parseSkill: description must be a non-blank string of at most 1024 characters', () => {
  assert.equal(problemOf(doc(['name: x'])), `${PATH}: description is missing`)
  assert.equal(problemOf(doc(['name: x', 'description: 5'])), `${PATH}: description must be a string (got 5)`)
  assert.equal(problemOf(doc(['name: x', 'description: [a]'])), `${PATH}: description must be a string (got a list)`)
  assert.equal(problemOf(doc(['name: x', 'description:'])), `${PATH}: description must be a string (got null)`)
  assert.equal(problemOf(doc(['name: x', 'description: ""'])), `${PATH}: description is blank`)
  assert.equal(problemOf(doc(['name: x', 'description: "   "'])), `${PATH}: description is blank`)
  assert.equal(problemOf(doc(['name: x', `description: ${'a'.repeat(1025)}`])), `${PATH}: description is 1025 characters; the most is 1024`)
  assert.equal(skillOf(doc(['name: x', `description: ${'a'.repeat(1024)}`])).description.length, 1024)
})

test('parseSkill: the body must not be empty', () => {
  const expected = `${PATH}: the instructions are empty; write them after the frontmatter`
  assert.equal(problemOf('---\nname: x\ndescription: d\n---\n'), expected)
  assert.equal(problemOf('---\nname: x\ndescription: d\n---'), expected)
  assert.equal(problemOf('---\nname: x\ndescription: d\n---\n\n  \n\t\n'), expected)
})

test('parseSkill refuses dsh\'s legacy camelCase keys', () => {
  assert.equal(
    problemOf(doc(['name: x', 'description: d', 'disableModelInvocation: true'])),
    `${PATH}: "disableModelInvocation" is unsupported; use "disable-model-invocation"`,
  )
  assert.equal(
    problemOf(doc(['name: x', 'description: d', 'modelInvocable: false'])),
    `${PATH}: "modelInvocable" is unsupported; use "disable-model-invocation"`,
  )
  assert.equal(
    problemOf(doc(['name: x', 'description: d', 'userInvocable: false'])),
    `${PATH}: "userInvocable" is unsupported; use "user-invocable"`,
  )
})

test('parseSkill: the invocation keys must be booleans', () => {
  for (const key of ['disable-model-invocation', 'user-invocable']) {
    for (const value of ['yes', '"true"', '1', '0', 'null', '[true]', '{}', '"no"']) {
      const problem = problemOf(doc(['name: x', 'description: d', `${key}: ${value}`]))
      assert.equal(problem, `${PATH}: ${key} must be true or false`, `${key}: ${value}`)
    }
  }
})

test('parseSkill: metadata must be a mapping', () => {
  for (const value of ['[a]', 'text', '5', 'null', 'true']) {
    assert.equal(
      problemOf(doc(['name: x', 'description: d', `metadata: ${value}`])),
      `${PATH}: metadata must be a mapping`,
      value,
    )
  }
  assert.equal(problemOf(doc(['name: x', 'description: d', 'metadata:'])), `${PATH}: metadata must be a mapping`)
})

test('parseSkill: metadata.roles must be a list of role names', () => {
  const expected = `${PATH}: metadata.roles must be a list of role names (lowercase letters, digits and hyphens, starting with a letter)`
  for (const value of ['coder', '5', 'null', '{a: b}', '[1]', '[Coder]', '[a_b]', '["a b"]', '[1a]', '[-a]', '[""]', '[[coder]]', '[null]', '[coder, ""]']) {
    assert.equal(problemOf(doc(['name: x', 'description: d', 'metadata:', `  roles: ${value}`])), expected, value)
  }
})

test('parseSkill reports only the first problem', () => {
  // name, description, body and roles are all wrong: the name is the first in the order of the rules.
  const text = '---\nname: wrong\nmetadata:\n  roles: 5\n---\n'
  assert.equal(problemOf(text), `${PATH}: name is "wrong" but the folder is "x"; they must match`)
  // With the name fixed, the description comes next.
  assert.equal(problemOf('---\nname: x\nmetadata:\n  roles: 5\n---\n'), `${PATH}: description is missing`)
  // Then the body.
  assert.match(problemOf('---\nname: x\ndescription: d\nmetadata:\n  roles: 5\n---\n'), /instructions are empty/)
  // Then the legacy keys, the booleans, the metadata, the roles.
  assert.match(problemOf(doc(['name: x', 'description: d', 'userInvocable: true', 'user-invocable: 7'])), /"userInvocable" is unsupported/)
  assert.match(problemOf(doc(['name: x', 'description: d', 'user-invocable: 7', 'metadata: 3'])), /user-invocable must be/)
  assert.match(problemOf(doc(['name: x', 'description: d', 'metadata: 3'])), /metadata must be a mapping/)
})

test('parseSkill never returns a problem with a line break in it', () => {
  for (const text of ['---\nname: [x\n---\nb', '---\n\tname: x\n---\nb', '---\n: x\n---\nb', '---\n&a [*a]\n---\nb']) {
    assert.ok(!problemOf(text).includes('\n'), JSON.stringify(text))
  }
})

test('parseSkill reads a key named like an Object.prototype member as an ordinary key', () => {
  // Not an own key, so the name is missing, not inherited.
  assert.equal(problemOf(doc(['description: d', 'constructor: x'])), `${PATH}: name is missing`)
  const skill = skillOf(doc(['name: x', 'description: d', 'metadata:', '  __proto__: 1', '  toString: 2']))
  assert.equal(skill.name, 'x')
})

// --- checkSkill -------------------------------------------------------------------------------

test('checkSkill of a good document has no problems and no warnings, and returns the skill', () => {
  const check = checkSkill(PATH, doc(['name: x', 'description: d', 'metadata:', '  roles: [main, coder]']), SHIPPED_ROLES)
  assert.deepEqual(check.problems, [])
  assert.deepEqual(check.warnings, [])
  assert.deepEqual(check.skill?.roles, ['main', 'coder'])
})

test('checkSkill of a bad document has its problem, no warnings, and no skill', () => {
  const check = checkSkill(PATH, doc(['name: x']), SHIPPED_ROLES)
  assert.deepEqual(check.problems, [`${PATH}: description is missing`])
  assert.deepEqual(check.warnings, [])
  assert.equal(check.skill, null)
})

test('checkSkill warns about a role dish doesn\'t know, once each, naming the known ones', () => {
  const text = doc(['name: x', 'description: d', 'metadata:', '  roles: [coder, designer, designer, qa]'])
  const check = checkSkill(PATH, text, SHIPPED_ROLES)
  assert.deepEqual(check.problems, [])
  assert.deepEqual(check.warnings, [
    'role "designer" isn\'t a role dish knows (main, architect, coder, reviewer, researcher, ops, writer)',
    'role "qa" isn\'t a role dish knows (main, architect, coder, reviewer, researcher, ops, writer)',
  ])
  assert.notEqual(check.skill, null, 'a warning keeps the skill')
})

test('checkSkill takes the roles that are known from its caller', () => {
  const text = doc(['name: x', 'description: d', 'metadata:', '  roles: [designer]'])
  assert.deepEqual(checkSkill(PATH, text, ['main', 'designer']).warnings, [])
  assert.equal(checkSkill(PATH, text, ['main']).warnings.length, 1)
})

test('checkSkill does not warn about roles when every role is meant, or none', () => {
  assert.deepEqual(checkSkill(PATH, doc(), SHIPPED_ROLES).warnings, [])
  assert.deepEqual(checkSkill(PATH, doc(['name: x', 'description: d', 'metadata:', '  roles: []']), SHIPPED_ROLES).warnings, [])
})

test('checkSkill warns above 8000 characters of document, and not at 8000', () => {
  const head = '---\nname: x\ndescription: d\n---\n'
  const exactly = head + 'a'.repeat(WARN_CHARS - head.length)
  assert.equal(exactly.length, WARN_CHARS)
  assert.deepEqual(checkSkill(PATH, exactly, SHIPPED_ROLES).warnings, [])
  const over = checkSkill(PATH, `${exactly}a`, SHIPPED_ROLES)
  assert.deepEqual(over.warnings, ['dsh may trim a skill this long when the context is full; keep it under 8000 characters'])
  assert.deepEqual(over.problems, [])
  assert.notEqual(over.skill, null)
})

test('checkSkill gives the length warning before the role warnings', () => {
  const text = `${doc(['name: x', 'description: d', 'metadata:', '  roles: [nobody]'], 'a'.repeat(WARN_CHARS))}`
  const warnings = checkSkill(PATH, text, SHIPPED_ROLES).warnings
  assert.equal(warnings.length, 2)
  assert.match(warnings[0]!, /^dsh may trim/)
  assert.match(warnings[1]!, /^role "nobody"/)
})

test('checkSkill measures the document as it was written, not as it parses', () => {
  // A BOM and CRLF count: it is the text the page shows.
  const head = '---\r\nname: x\r\ndescription: d\r\n---\r\n'
  const text = head + 'a'.repeat(WARN_CHARS - head.length + 1)
  assert.equal(text.length, WARN_CHARS + 1)
  assert.equal(checkSkill(PATH, text, SHIPPED_ROLES).warnings.length, 1)
  // The BOM counts as well: 8000 characters with it is 7999 without, and 8001 with it warns.
  const bomHead = '---\nname: x\ndescription: d\n---\n'
  const atLimit = `\uFEFF${bomHead}${'a'.repeat(WARN_CHARS - 1 - bomHead.length)}`
  assert.equal(atLimit.length, WARN_CHARS)
  assert.deepEqual(checkSkill(PATH, atLimit, SHIPPED_ROLES).warnings, [])
  assert.equal(checkSkill(PATH, `${atLimit}a`, SHIPPED_ROLES).warnings.length, 1)
  // Without a BOM the same body would still be exactly at the limit, not over it.
  assert.deepEqual(checkSkill(PATH, `${bomHead}${'a'.repeat(WARN_CHARS - bomHead.length)}`, SHIPPED_ROLES).warnings, [])
})

// --- offeredTo --------------------------------------------------------------------------------

test('offeredTo: null roles is every role, a list is those roles, an empty list is none', () => {
  assert.equal(offeredTo({ roles: null }, 'coder'), true)
  assert.equal(offeredTo({ roles: null }, 'anything-at-all'), true)
  assert.equal(offeredTo({ roles: ['coder', 'main'] }, 'coder'), true)
  assert.equal(offeredTo({ roles: ['coder', 'main'] }, 'main'), true)
  assert.equal(offeredTo({ roles: ['coder', 'main'] }, 'writer'), false)
  assert.equal(offeredTo({ roles: ['coder'] }, 'cod'), false)
  assert.equal(offeredTo({ roles: [] }, 'coder'), false)
})

test('offeredTo takes a parsed skill', () => {
  const skill = skillOf(doc(['name: x', 'description: d', 'metadata:', '  roles: [ops]']))
  assert.equal(offeredTo(skill, 'ops'), true)
  assert.equal(offeredTo(skill, 'coder'), false)
})

// --- the namespace ----------------------------------------------------------------------------

test('validate is undefined for a good skill', () => {
  assert.equal(validate(PATH, doc()), undefined)
  assert.equal(validate('skills/test-driven-development/SKILL.md', doc(['name: test-driven-development', 'description: d'])), undefined)
})

test('validate returns the problem of parseSkill without the path, which the store puts in front of every message', () => {
  assert.equal(validate(PATH, doc(['name: x'])), 'description is missing')
  assert.equal(validate(PATH, doc(['name: y', 'description: d'])), 'name is "y" but the folder is "x"; they must match')
  assert.match(validate('skills/x/other.md', doc()) ?? '', /^not a skill document; use skills\/<name>\/SKILL\.md/)
  assert.match(validate('skills/x/SKILL.md', 'no frontmatter') ?? '', /^the frontmatter is missing/)
})

test('validate does not refuse a document that only has warnings', () => {
  const text = doc(['name: x', 'description: d', 'metadata:', '  roles: [nobody]'], 'a'.repeat(WARN_CHARS * 2))
  assert.equal(validate(PATH, text), undefined)
})

test('namespaceSpec claims skills/ for the owner, and an agent may only propose there', () => {
  const spec = namespaceSpec('dish-skills')
  assert.equal(spec.prefix, 'skills/')
  assert.equal(spec.owner, 'dish-skills')
  assert.equal(spec.agent, 'propose')
  assert.equal(spec.validate, validate)
  assert.deepEqual(Object.keys(spec).sort(), ['agent', 'owner', 'prefix', 'validate'])
})

test('the spec\'s validate is the one the store will call', () => {
  const spec = namespaceSpec('dish-skills')
  assert.equal(spec.validate(PATH, doc()), undefined)
  assert.equal(spec.validate(PATH, doc(['name: x'])), 'description is missing')
})
