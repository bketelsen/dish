import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CREW_SPEC, DEFAULT_SETTINGS, DEFAULT_TEXT, parseSettings } from '../src/settings.ts'
import type { CrewSettings } from '../src/settings.ts'
import { render, shippedDocument, shippedWith } from './helpers.ts'

/** The problem `parseSettings` gives for `text`; fails the test if the text is accepted. */
function problemOf(text: string): string {
  const parsed = parseSettings(text)
  assert.equal(parsed.ok, false, 'expected the text to be refused')
  return parsed.ok ? '' : parsed.problem
}

/** The problem for the shipped file after `change`. */
function problemWith(change: (document: Record<string, any>) => void): string {
  return problemOf(shippedWith(change))
}

function settingsOf(text: string): CrewSettings {
  const parsed = parseSettings(text)
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.problem)
  return parsed.settings
}

const ROLES = ['architect', 'coder', 'reviewer', 'researcher', 'ops', 'writer']
const STANDARD_TOOLS = ['read', 'glob', 'grep', 'skill', 'todo_write', 'send_message']

// --- the shipped default --------------------------------------------------------------------------

test('the shipped crew.yaml is the one in the spec, and DEFAULT_TEXT is that file', () => {
  assert.equal(DEFAULT_TEXT, readFileSync(new URL('../defaults/crew.yaml', import.meta.url), 'utf8'))
  const spec = readFileSync(new URL('../../../docs/specs/crew.md', import.meta.url), 'utf8')
  const block = /^## `crew\.yaml`[\s\S]*?```yaml\n([\s\S]*?)```/m.exec(spec)?.[1]
  assert.equal(DEFAULT_TEXT, block)
})

test('parseSettings accepts the shipped default, and DEFAULT_SETTINGS is what it makes of it', () => {
  const parsed = parseSettings(DEFAULT_TEXT)
  assert.ok(parsed.ok)
  assert.deepEqual(parsed.settings, DEFAULT_SETTINGS)
})

test('the default has the models, limits and roles of the spec', () => {
  const settings = DEFAULT_SETTINGS
  assert.equal(settings.provider, 'github-copilot')
  assert.deepEqual(Object.keys(settings.families), ['anthropic', 'openai'])
  assert.deepEqual({ ...settings.families.anthropic }, { strong: 'claude-opus-5.5', mid: 'claude-sonnet-5.5' })
  assert.deepEqual({ ...settings.families.openai }, { strong: 'gpt-6.1-sol', mid: 'gpt-5.6-sol' })
  assert.deepEqual([...settings.reviewerFamilies], ['openai', 'anthropic'])
  assert.deepEqual({ ...settings.limits }, { running: 4, writers: 1, perSession: 30 })
  assert.deepEqual(Object.keys(settings.roles), ROLES)
  const coder = settings.roles.coder!
  assert.equal(coder.tier, 'mid')
  assert.equal(coder.family, 'anthropic')
  assert.equal(coder.writes, true)
  assert.equal(coder.reviews, false)
  assert.deepEqual([...coder.tools], ['read', 'glob', 'grep', 'write', 'edit', 'bash', 'job_output', 'job_list', 'job_kill', 'web_fetch', 'skill', 'todo_write', 'send_message'])
  assert.equal(settings.roles.architect!.tier, 'strong')
  // writes and reviews are false unless the file says so.
  const researcher = settings.roles.researcher!
  assert.equal(researcher.writes, false)
  assert.equal(researcher.reviews, false)
  // The reviewer has a tier and no fixed family.
  const reviewer = settings.roles.reviewer!
  assert.equal(reviewer.reviews, true)
  assert.equal(reviewer.tier, 'mid')
  assert.equal(reviewer.family, undefined)
  assert.ok(!('family' in reviewer))
  assert.deepEqual(Object.keys(settings.roles).filter(role => settings.roles[role]!.writes), ['architect', 'coder', 'ops', 'writer'])
})

test('settings are frozen, and families and roles have no prototype: a role named like an Object method is no role', () => {
  assert.ok(Object.isFrozen(DEFAULT_SETTINGS))
  assert.ok(Object.isFrozen(DEFAULT_SETTINGS.limits))
  assert.ok(Object.isFrozen(DEFAULT_SETTINGS.roles))
  assert.ok(Object.isFrozen(DEFAULT_SETTINGS.roles.coder))
  assert.ok(Object.isFrozen(DEFAULT_SETTINGS.roles.coder!.tools))
  assert.ok(Object.isFrozen(DEFAULT_SETTINGS.families.openai))
  assert.ok(Object.isFrozen(DEFAULT_SETTINGS.reviewerFamilies))
  for (const name of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
    assert.equal(DEFAULT_SETTINGS.roles[name], undefined, name)
    assert.equal(DEFAULT_SETTINGS.families[name], undefined, name)
  }
})

test('a role that is a legal name but an Object member (constructor) is a role like any other', () => {
  const name = 'constructor'
  const settings = settingsOf(shippedWith((document) => { document.roles[name] = { tier: 'mid', family: 'openai', tools: ['read'] } }))
  assert.equal(settings.roles[name]!.family, 'openai')
  assert.deepEqual(Object.keys(settings.roles).slice(-1), ['constructor'])
})

test('limits, families and the reviewer follow the file', () => {
  const settings = settingsOf(shippedWith((document) => {
    document.limits = { running: 2, writers: 2, perSession: 5 }
    document.families.google = { strong: 'gemini-3-pro', mid: 'gemini-3-flash' }
    document.reviewerFamilies = ['google']
    document.roles.coder.family = 'google'
    document.roles.coder.tools = ['read']
  }))
  assert.deepEqual({ ...settings.limits }, { running: 2, writers: 2, perSession: 5 })
  assert.deepEqual([...settings.reviewerFamilies], ['google'])
  assert.equal(settings.roles.coder!.family, 'google')
  assert.deepEqual([...settings.roles.coder!.tools], ['read'])
})

test('a one-model family, and a model reused by a family\'s two tiers, are fine', () => {
  const settings = settingsOf(shippedWith((document) => {
    document.families.anthropic = { strong: 'claude-opus-5.5', mid: 'claude-opus-5.5' }
  }))
  assert.equal(settings.families.anthropic!.mid, 'claude-opus-5.5')
})

// --- every rule, broken in turn -------------------------------------------------------------------

test('unknown keys are refused at every level, with the path', () => {
  assert.match(problemWith((d) => { d.extra = 1 }), /^extra: unknown key \(allowed: provider, families, reviewerFamilies, limits, roles\)/)
  assert.match(problemWith((d) => { d.families.openai.fast = 'gpt-x' }), /^families\.openai\.fast: unknown key \(allowed: strong, mid\)/)
  assert.match(problemWith((d) => { d.limits.total = 3 }), /^limits\.total: unknown key \(allowed: running, writers, perSession\)/)
  assert.match(problemWith((d) => { d.roles.coder.model = 'gpt-x' }), /^roles\.coder\.model: unknown key \(allowed: tier, family, writes, reviews, tools\)/)
})

test('a missing key is refused, with the path', () => {
  for (const key of ['provider', 'families', 'reviewerFamilies', 'limits', 'roles']) {
    assert.match(problemWith((d) => { delete d[key] }), new RegExp(`^${key}: required`), key)
  }
  for (const key of ['running', 'writers', 'perSession']) {
    assert.match(problemWith((d) => { delete d.limits[key] }), new RegExp(`^limits\\.${key}: required`), key)
  }
  assert.match(problemWith((d) => { delete d.roles.coder.tools }), /^roles\.coder\.tools: required/)
})

test('provider must be a non-empty string', () => {
  assert.match(problemWith((d) => { d.provider = '' }), /^provider: /)
  assert.match(problemWith((d) => { d.provider = 7 }), /^provider: /)
  assert.match(problemWith((d) => { d.provider = ['github-copilot'] }), /^provider: /)
})

test('a family must name both tiers, each a model id', () => {
  assert.match(problemWith((d) => { delete d.families.openai.mid }), /^families\.openai\.mid: required/)
  assert.match(problemWith((d) => { delete d.families.openai.strong }), /^families\.openai\.strong: required/)
  assert.match(problemWith((d) => { d.families.openai.mid = '' }), /^families\.openai\.mid: /)
  assert.match(problemWith((d) => { d.families.openai.strong = 6 }), /^families\.openai\.strong: /)
  assert.match(problemWith((d) => { d.families.openai = 'gpt-6.1-sol' }), /^families\.openai: /)
  assert.match(problemWith((d) => { d.families = [] }), /^families: /)
})

test('a model belongs to one family, since the family of a model is how the reviewer rule works', () => {
  assert.match(
    problemWith((d) => { d.families.openai.mid = 'claude-sonnet-5.5' }),
    /^families\.openai\.mid: "claude-sonnet-5\.5" is also in family anthropic; a model belongs to one family/)
})

test('reviewerFamilies must be a list naming only known families', () => {
  assert.equal(problemWith((d) => { d.reviewerFamilies = ['openai', 'gogle'] }), 'reviewerFamilies[1]: "gogle" is not a family (families: anthropic, openai)')
  assert.match(problemWith((d) => { d.reviewerFamilies = 'openai' }), /^reviewerFamilies: /)
  assert.match(problemWith((d) => { d.reviewerFamilies = ['openai', 3] }), /^reviewerFamilies\[1\]: /)
})

test('limits are positive integers, and writers is at most running', () => {
  for (const key of ['running', 'writers', 'perSession']) {
    for (const value of [0, -1, 1.5, '4', null, true]) {
      assert.match(problemWith((d) => { d.limits[key] = value }), new RegExp(`^limits\\.${key}: `), `${key}: ${JSON.stringify(value)}`)
    }
  }
  assert.equal(problemWith((d) => { d.limits.writers = 5 }), 'limits.writers: 5 is more than limits.running (4)')
  assert.ok(parseSettings(shippedWith((d) => { d.limits.writers = 4 })).ok)
  assert.match(problemWith((d) => { d.limits = [4, 1, 30] }), /^limits: /)
})

test('role names follow the prompts grammar, and common and main are reserved', () => {
  for (const name of ['Coder', '2fast', 'has_underscore', 'with space', '-dash', 'tëst', '']) {
    assert.match(problemWith((d) => { d.roles[name] = { tier: 'mid', family: 'openai', tools: ['read'] } }), /^roles[.[][^:]*: .*is not a valid role name/, JSON.stringify(name))
  }
  for (const name of ['common', 'main']) {
    assert.match(problemWith((d) => { d.roles[name] = { tier: 'mid', family: 'openai', tools: ['read'] } }), new RegExp(`^roles\\.${name}: .*reserved`), name)
  }
  assert.ok(parseSettings(shippedWith((d) => { d.roles['data-2'] = { tier: 'mid', family: 'openai', tools: ['read'] } })).ok)
  assert.match(problemWith((d) => { d.roles = {} }), /^roles: /)
  assert.match(problemWith((d) => { d.roles = ['coder'] }), /^roles: /)
  // `__proto__` as an own key, which is what the YAML says (assigning it would set a prototype instead).
  assert.match(problemWith((d) => {
    Object.defineProperty(d.roles, '__proto__', { value: { tier: 'mid', family: 'openai', tools: ['read'] }, enumerable: true, configurable: true, writable: true })
  }), /^roles\.__proto__: .*is not a valid role name/)
})

test('every role has a tier, strong or mid', () => {
  assert.match(problemWith((d) => { delete d.roles.coder.tier }), /^roles\.coder\.tier: required/)
  assert.equal(problemWith((d) => { d.roles.coder.tier = 'high' }), 'roles.coder.tier: "high" is not a tier (tiers: strong, mid)')
  assert.match(problemWith((d) => { d.roles.coder.tier = 3 }), /^roles\.coder\.tier: /)
  assert.match(problemWith((d) => { d.roles.coder = 'mid' }), /^roles\.coder: /)
})

test('writes and reviews are booleans', () => {
  assert.match(problemWith((d) => { d.roles.coder.writes = 'yes' }), /^roles\.coder\.writes: /)
  assert.match(problemWith((d) => { d.roles.coder.reviews = 1 }), /^roles\.coder\.reviews: /)
  assert.ok(parseSettings(shippedWith((d) => { d.roles.coder.writes = false; d.roles.coder.reviews = false })).ok)
})

test('exactly one role reviews, and it has no family', () => {
  assert.equal(problemWith((d) => { d.roles.reviewer.reviews = false; d.roles.reviewer.family = 'openai' }), 'roles: no role sets reviews: true; exactly one must')
  assert.equal(problemWith((d) => { delete d.roles.reviewer.reviews; d.roles.reviewer.family = 'openai' }), 'roles: no role sets reviews: true; exactly one must')
  assert.equal(problemWith((d) => { d.roles.coder.reviews = true; delete d.roles.coder.family }), 'roles: more than one role sets reviews: true (coder, reviewer); exactly one may')
  assert.match(problemWith((d) => { d.roles.reviewer.family = 'openai' }), /^roles\.reviewer\.family: .*reviewerFamilies/)
})

test('every other role has a known family', () => {
  assert.equal(problemWith((d) => { d.roles.coder.family = 'antropic' }), 'roles.coder.family: "antropic" is not a family (families: anthropic, openai)')
  assert.match(problemWith((d) => { delete d.roles.coder.family }), /^roles\.coder\.family: required \(families: anthropic, openai\)/)
  assert.match(problemWith((d) => { d.roles.coder.family = '' }), /^roles\.coder\.family: /)
  assert.match(problemWith((d) => { d.roles.coder.family = 4 }), /^roles\.coder\.family: /)
})

test('tools is a list of non-empty strings', () => {
  assert.match(problemWith((d) => { d.roles.coder.tools = 'read' }), /^roles\.coder\.tools: /)
  assert.match(problemWith((d) => { d.roles.coder.tools = { read: true } }), /^roles\.coder\.tools: /)
  assert.match(problemWith((d) => { d.roles.coder.tools = ['read', '', 'edit'] }), /^roles\.coder\.tools\[1\]: /)
  assert.match(problemWith((d) => { d.roles.coder.tools = ['read', '  '] }), /^roles\.coder\.tools\[1\]: /)
  assert.match(problemWith((d) => { d.roles.coder.tools = ['read', 7] }), /^roles\.coder\.tools\[1\]: /)
  assert.match(problemWith((d) => { d.roles.coder.tools = [['read']] }), /^roles\.coder\.tools\[0\]: /)
})

test('the first problem found is the one reported, in the order of the file', () => {
  const problem = problemWith((d) => { d.provider = ''; d.limits.running = 0; d.roles.coder.family = 'nope' })
  assert.match(problem, /^provider: /)
})

// --- what is not YAML of this shape ---------------------------------------------------------------

test('tags are refused: nothing in crew.yaml is executable, or anything but plain data', () => {
  for (const text of [
    'provider: !!js/function "function () { return 1 }"\n',
    DEFAULT_TEXT.replace('running: 4', 'running: !!js/regexp /x/'),
    DEFAULT_TEXT.replace('github-copilot', '!!js/function "function () {}"'),
    DEFAULT_TEXT.replace('running: 4', 'running: !!binary "NA=="'),
    DEFAULT_TEXT.replace('running: 4', 'running: !!set { 4 }'),
    DEFAULT_TEXT.replace('provider: github-copilot', 'provider: !custom github-copilot'),
  ]) {
    const problem = problemOf(text)
    assert.match(problem, /tag/, text.slice(0, 60))
  }
})

test('YAML that does not parse is refused with where, and without the document', () => {
  const problem = problemOf('provider: github-copilot\nfamilies: {\nroles: [\n')
  assert.match(problem, /^not valid YAML \(line \d+, column \d+\): /)
  assert.ok(problem.length < 300, problem)
  assert.ok(!problem.includes('github-copilot'), problem)
  // A duplicate key is a syntax error too: the second would silently win.
  assert.match(problemOf(DEFAULT_TEXT.replace('limits:', 'provider: other\nlimits:')), /duplicate/i)
  // A stream of several documents is one too many.
  assert.match(problemOf(`${DEFAULT_TEXT}---\nprovider: other\n`), /^not valid YAML/)
})

test('an empty file, or one that is not a mapping, is refused', () => {
  const empty = 'the file is empty; it needs provider, families, reviewerFamilies, limits and roles'
  assert.equal(problemOf(''), empty)
  assert.equal(problemOf('# only a comment\n'), empty)
  assert.equal(problemOf('~\n'), 'must be a mapping of settings (got null)')
  assert.equal(problemOf('- a\n- b\n'), 'must be a mapping of settings (got a list)')
  assert.equal(problemOf('just text\n'), 'must be a mapping of settings (got "just text")')
  assert.equal(problemOf('42\n'), 'must be a mapping of settings (got 42)')
})

test('no problem starts by naming crew.yaml: the store puts the path in front of it', () => {
  for (const text of ['', '~', 'roles: [', DEFAULT_TEXT.replace('running: 4', 'running: !!set {}'), `${DEFAULT_TEXT}---\n`, shippedWith((d) => { d.limits.running = 0 })]) {
    assert.doesNotMatch(problemOf(text), /crew\.yaml/, text.slice(0, 30))
  }
})

test('a refusal never echoes much of the file, however large the offending value', () => {
  const huge = 'x'.repeat(20_000)
  const problems = [
    problemWith((d) => { d.roles.coder.family = huge }),
    problemWith((d) => { d.reviewerFamilies = [huge] }),
    problemWith((d) => { d[huge] = 1 }),
    problemWith((d) => { d.roles[huge.toUpperCase()] = { tier: 'mid', family: 'openai', tools: ['read'] } }),
    problemWith((d) => { d.roles.coder.tier = huge }),
    problemWith((d) => { d.roles.coder.tools = [huge, 7] }),
    problemWith((d) => { d.families[huge] = { strong: 'a', mid: 'b' }; d.roles.coder.family = 'nope' }),
    problemWith((d) => { d.families.openai.mid = huge; d.families.anthropic.mid = huge }),
    problemOf(`provider: ${huge}\n  bad: [`),
  ]
  for (const problem of problems) assert.ok(problem.length < 500, `${problem.length}: ${problem.slice(0, 120)}`)
  // And the names of many families are listed in part.
  const many = problemWith((d) => {
    for (let index = 0; index < 100; index++) d.families[`family-${index}`] = { strong: `strong-${index}`, mid: `mid-${index}` }
    d.roles.coder.family = 'nope'
  })
  assert.ok(many.length < 500, many)
})

// --- strings that would be wrong in a way that is hard to see ---------------------------------------

/** A string with a space in front, and one with a space behind. */
const PADDED = (value: string) => [` ${value}`, `${value} `, `\t${value}`, `${value}\n`]

test('provider, model ids, tool names and reviewer families may not start or end with whitespace', () => {
  for (const provider of PADDED('github-copilot')) {
    assert.match(problemWith((d) => { d.provider = provider }), /^provider: must not start or end with whitespace \(got "/, JSON.stringify(provider))
  }
  for (const tier of ['strong', 'mid']) {
    for (const model of PADDED('gpt-5.6-sol')) {
      assert.match(problemWith((d) => { d.families.openai[tier] = model }), new RegExp(`^families\\.openai\\.${tier}: must not start or end with whitespace`), JSON.stringify(model))
    }
  }
  for (const tool of PADDED('read')) {
    assert.match(problemWith((d) => { d.roles.coder.tools = ['glob', tool] }), /^roles\.coder\.tools\[1\]: must not start or end with whitespace/, JSON.stringify(tool))
  }
  for (const family of PADDED('openai')) {
    assert.match(problemWith((d) => { d.reviewerFamilies = ['anthropic', family] }), /^reviewerFamilies\[1\]: must not start or end with whitespace/, JSON.stringify(family))
    assert.match(problemWith((d) => { d.roles.coder.family = family }), /^roles\.coder\.family: must not start or end with whitespace/, JSON.stringify(family))
  }
})

test('a padded copy of a model can not hide it in a second family', () => {
  assert.match(
    problemWith((d) => { d.families.openai.mid = ' claude-sonnet-5.5' }),
    /^families\.openai\.mid: must not start or end with whitespace/)
  assert.match(
    problemWith((d) => { d.families.openai.mid = 'claude-sonnet-5.5' }),
    /^families\.openai\.mid: "claude-sonnet-5\.5" is also in family anthropic/)
})

test('a family is named like a role: lowercase letters, digits and hyphens, starting with a letter', () => {
  const models = { strong: 'some-strong', mid: 'some-mid' }
  for (const name of ['two words', ' ', '', 'Upper', '2fast', '-dash', 'under_score', 'tëst', 'dot.ted']) {
    assert.match(problemWith((d) => { d.families[name] = models }), /^families(\.|\[)[^:]*: .*(is not a valid family name|must not start or end with whitespace)/, JSON.stringify(name))
  }
  // `__proto__` as an own key, which is what the YAML says (assigning it would set a prototype instead).
  assert.match(problemWith((d) => {
    Object.defineProperty(d.families, '__proto__', { value: models, enumerable: true, configurable: true, writable: true })
  }), /^families\.__proto__: .*is not a valid family name/)
  for (const name of ['google', 'x-ai', 'in-house-2']) assert.ok(parseSettings(shippedWith((d) => { d.families[name] = models })).ok, name)
})

test('a family named in reviewerFamilies or a role has to be one of the file, whatever it is called', () => {
  for (const name of ['two words', 'Anthropic', '__proto__', 'constructor', '']) {
    assert.match(problemWith((d) => { d.reviewerFamilies = [name] }), /^reviewerFamilies\[0\]: .*is not a family \(families: anthropic, openai\)/, JSON.stringify(name))
    assert.match(problemWith((d) => { d.roles.coder.family = name }), /^roles\.coder\.family: .*is not a family \(families: anthropic, openai\)/, JSON.stringify(name))
  }
})

test('a role needs at least one tool', () => {
  assert.equal(problemWith((d) => { d.roles.writer.tools = [] }), 'roles.writer.tools: a role needs at least one tool')
  assert.ok(parseSettings(shippedWith((d) => { d.roles.writer.tools = ['read'] })).ok)
})

test('the types of the settings are readonly, as the objects are frozen', () => {
  const settings = DEFAULT_SETTINGS
  // Each of these fails to typecheck, and fails when run.
  // @ts-expect-error the limits are readonly
  assert.throws(() => { settings.limits.running = 1 }, TypeError)
  // @ts-expect-error the provider is readonly
  assert.throws(() => { settings.provider = 'x' }, TypeError)
  // @ts-expect-error the families are readonly
  assert.throws(() => { settings.families.openai = { strong: 'a', mid: 'b' } }, TypeError)
  // @ts-expect-error a family's models are readonly
  assert.throws(() => { settings.families.openai!.mid = 'x' }, TypeError)
  // @ts-expect-error the roles are readonly
  assert.throws(() => { settings.roles.coder = settings.roles.writer! }, TypeError)
  // @ts-expect-error a role's tier is readonly
  assert.throws(() => { settings.roles.coder!.tier = 'strong' }, TypeError)
  // @ts-expect-error a role's tools can't be added to
  assert.throws(() => { settings.roles.coder!.tools.push('x') }, TypeError)
  // @ts-expect-error a role's tools can't be sorted in place
  assert.throws(() => { settings.roles.coder!.tools.sort() }, TypeError)
  // @ts-expect-error the reviewer families can't be added to
  assert.throws(() => { settings.reviewerFamilies.push('x') }, TypeError)
  // Copies are another matter.
  const tools: string[] = [...settings.roles.coder!.tools].sort()
  assert.equal(tools.length, settings.roles.coder!.tools.length)
})

// --- the namespace --------------------------------------------------------------------------------

test('CREW_SPEC claims crew.yaml for dish-crew, agents may write, and validate is parseSettings', () => {
  assert.equal(CREW_SPEC.prefix, 'crew.yaml')
  assert.equal(CREW_SPEC.owner, 'dish-crew')
  assert.equal(CREW_SPEC.agent, 'write')
  assert.equal(CREW_SPEC.validate('crew.yaml', DEFAULT_TEXT), undefined)
  assert.equal(CREW_SPEC.validate('crew.yaml', render(shippedDocument())), undefined)
  assert.equal(
    CREW_SPEC.validate('crew.yaml', shippedWith((d) => { d.roles.coder.family = 'antropic' })),
    'roles.coder.family: "antropic" is not a family (families: anthropic, openai)')
  assert.equal(typeof CREW_SPEC.validate('crew.yaml', ''), 'string')
})

test('the default has every tool a role lists, once', () => {
  for (const [role, settings] of Object.entries(DEFAULT_SETTINGS.roles)) {
    assert.equal(new Set(settings.tools).size, settings.tools.length, role)
    for (const tool of STANDARD_TOOLS) assert.ok(settings.tools.includes(tool), `${role} lacks ${tool}`)
  }
})
