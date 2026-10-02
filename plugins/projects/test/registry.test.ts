import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as configPlugin from 'dish-config'
import type { ConfigStoreError } from 'dish-config'
import {
  GATE_TIMEOUT,
  OWNER,
  PROJECTS_PATH,
  REPO,
  RESERVED_OWNERS,
  SECRET_NAME,
  SEED_TEXT,
  SETUP_TIMEOUT,
  fieldsProblem,
  nameProblem,
  namespaceSpec,
  parseDuration,
  parseProjects,
  serializeProjects,
  validate,
} from '../src/registry.ts'
import type { Project, ProjectFields } from '../src/registry.ts'

// Nothing here may read the real ~/.gitconfig: the store test below starts git, which reads $HOME.
const GIT_ENV = ['HOME', 'XDG_CONFIG_HOME', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM'] as const
const saved = Object.fromEntries(GIT_ENV.map(name => [name, process.env[name]]))
const made: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dish-projects-'))
  made.push(dir)
  return dir
}

before(async () => {
  const home = await tempDir()
  process.env.HOME = home
  process.env.XDG_CONFIG_HOME = join(home, '.config')
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  // dish-config's git passes these two through, so a caller's own would win over the scratch HOME.
  process.env.GIT_CONFIG_GLOBAL = join(home, '.gitconfig')
  process.env.GIT_CONFIG_SYSTEM = '/dev/null'
})

after(async () => {
  for (const name of GIT_ENV) {
    const value = saved[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  await Promise.all(made.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

// --- fixtures ---------------------------------------------------------------------------------

/** The spec's example, word for word. */
const EXAMPLE = `projects:
  bketelsen/dish:
    family: bketelsen
    role: dish itself, dsh plugins for a personal agent harness
    gate: pnpm typecheck && pnpm test
    gateTimeout: 10m
    setup: pnpm install --frozen-lockfile
    setupTimeout: 15m
  frostyard/snosi:
    family: frostyard
    role: the image build
    gate: just lint
    gateTimeout: 10m
`

/** A token-shaped string for the tests that check a message never carries one. Built here so no source line holds it whole. */
const TOKEN = `ghs_${'a1B2'.repeat(9)}`

const BASE = { family: 'acme', role: 'widgets', gate: 'make test', gateTimeout: '5m' }

/** A one-project document: JSON is YAML, so this needs no quoting rules. A field set to `undefined` is left out. */
function one(fields: Record<string, unknown>, name = 'acme/widget'): string {
  return JSON.stringify({ projects: { [name]: { ...BASE, ...fields } } })
}

/** The problem `parseProjects` reports for `text`, failing the test if it parses. */
function problemOf(text: string): string {
  const result = parseProjects(text)
  if (result.ok) assert.fail(`expected a problem for ${text}`)
  return result.problem
}

/** The projects `parseProjects` reads from `text`, failing the test if it refuses it. */
function projectsOf(text: string): Project[] {
  const result = parseProjects(text)
  if (!result.ok) assert.fail(result.problem)
  return result.projects
}

function only(text: string): Project {
  const projects = projectsOf(text)
  assert.equal(projects.length, 1)
  return projects[0]!
}

// --- constants --------------------------------------------------------------------------------

test('the constants are the ones the spec names', () => {
  assert.equal(PROJECTS_PATH, 'projects.yaml')
  assert.equal(SEED_TEXT, 'projects: {}\n')
  assert.deepEqual([...RESERVED_OWNERS], ['scratch', 'tokens'])
  assert.deepEqual({ ...GATE_TIMEOUT }, { min: 10_000, max: 600_000 })
  assert.deepEqual({ ...SETUP_TIMEOUT }, { min: 10_000, max: 3_600_000, fallback: '15m' })
  // dsh's own scrub pattern (the pin against dsh's constant is dish-workspaces' env test).
  assert.equal(SECRET_NAME.source, 'KEY|PASSWORD|SECRET|TOKEN')
  assert.equal(SECRET_NAME.flags, 'i')
})

test('the seed is a valid, empty registry', () => {
  assert.deepEqual(parseProjects(SEED_TEXT), { ok: true, projects: [], fields: {} })
  assert.equal(validate(PROJECTS_PATH, SEED_TEXT), undefined)
})

// --- durations --------------------------------------------------------------------------------

test('parseDuration reads <n>s, <n>m and <n>h, and nothing else', () => {
  assert.equal(parseDuration('10s'), 10_000)
  assert.equal(parseDuration('90s'), 90_000)
  assert.equal(parseDuration('15m'), 900_000)
  assert.equal(parseDuration('2h'), 7_200_000)
  assert.equal(parseDuration('1s'), 1000)
  for (const text of ['', '0m', '0s', '10', 'm', '10 m', ' 10m', '10m ', '10m\n', '10M', '10min', '1.5m', '-5m', '+5m', '1e3s', '0x10s', '10ms', '٣m']) {
    assert.equal(parseDuration(text), undefined, JSON.stringify(text))
  }
  // Too big to be exact.
  assert.equal(parseDuration(`${'9'.repeat(30)}h`), undefined)
  assert.equal(parseDuration(`${Number.MAX_SAFE_INTEGER}h`), undefined)
  assert.equal(parseDuration(5 as unknown as string), undefined)
})

// --- the document -----------------------------------------------------------------------------

test('the spec\'s example is valid, and parses to what it says', () => {
  const result = parseProjects(EXAMPLE)
  assert.ok(result.ok)
  assert.deepEqual(result.projects.map(project => project.name), ['bketelsen/dish', 'frostyard/snosi'])
  assert.deepEqual(result.projects[0], {
    name: 'bketelsen/dish',
    owner: 'bketelsen',
    repo: 'dish',
    family: 'bketelsen',
    role: 'dish itself, dsh plugins for a personal agent harness',
    gate: 'pnpm typecheck && pnpm test',
    gateTimeout: '10m',
    gateTimeoutMs: 600_000,
    setup: 'pnpm install --frozen-lockfile',
    setupTimeout: '15m',
    setupTimeoutMs: 900_000,
    gateEnv: {},
  })
  assert.deepEqual(result.projects[1], {
    name: 'frostyard/snosi',
    owner: 'frostyard',
    repo: 'snosi',
    family: 'frostyard',
    role: 'the image build',
    gate: 'just lint',
    gateTimeout: '10m',
    gateTimeoutMs: 600_000,
    setup: undefined,
    setupTimeout: '15m',
    setupTimeoutMs: 900_000,
    gateEnv: {},
  })
  assert.deepEqual(result.fields['frostyard/snosi'], { family: 'frostyard', role: 'the image build', gate: 'just lint', gateTimeout: '10m' })
  assert.equal(validate(PROJECTS_PATH, EXAMPLE), undefined)
})

test('projects: {} and an empty projects: are both no projects', () => {
  for (const text of ['projects: {}\n', 'projects:\n', 'projects: ~\n', '# nothing yet\nprojects: {}\n', 'projects: null\n']) {
    assert.deepEqual(parseProjects(text), { ok: true, projects: [], fields: {} }, JSON.stringify(text))
  }
})

test('projects come back sorted by name, case-insensitively', () => {
  const text = JSON.stringify({ projects: { 'zed/a': BASE, 'Bob/b': BASE, 'acme/z': BASE, 'Acme/b': BASE } })
  const result = parseProjects(text)
  assert.ok(result.ok)
  assert.deepEqual(result.projects.map(project => project.name), ['Acme/b', 'acme/z', 'Bob/b', 'zed/a'])
  assert.deepEqual(Object.keys(result.fields), ['Acme/b', 'acme/z', 'Bob/b', 'zed/a'])
})

test('a document that isn\'t a mapping with one key, projects, is refused', () => {
  assert.match(problemOf(''), /^projects\.yaml: the document must be a mapping/)
  assert.match(problemOf('# only a comment\n'), /^projects\.yaml: the document must be a mapping/)
  assert.match(problemOf('- a\n- b\n'), /^projects\.yaml: the document must be a mapping/)
  assert.match(problemOf('just text\n'), /^projects\.yaml: the document must be a mapping/)
  assert.match(problemOf('{}\n'), /^projects\.yaml: projects is missing/)
  assert.match(problemOf('projects: {}\nextra: 1\n'), /^projects\.yaml: unknown top-level key "extra"/)
  assert.match(problemOf('other: {}\n'), /^projects\.yaml: unknown top-level key "other"/)
  assert.match(problemOf('projects: []\n'), /^projects\.yaml: projects must be a mapping/)
  assert.match(problemOf('projects: [a/b]\n'), /^projects\.yaml: projects must be a mapping/)
  assert.match(problemOf('projects: text\n'), /^projects\.yaml: projects must be a mapping/)
  assert.match(problemOf('Projects: {}\n'), /^projects\.yaml: unknown top-level key "Projects"/)
})

test('YAML that doesn\'t parse is one sentence with the line, and quotes none of the text', () => {
  const text = `projects:\n  acme/widget:\n    gate: "${TOKEN}\n   bad: [\n`
  const problem = problemOf(text)
  assert.match(problem, /^projects\.yaml: isn't valid YAML \(line \d+\)$/)
  assert.ok(!problem.includes(TOKEN))
  // Two documents, a duplicated key, a tag a plain loader can't build.
  assert.match(problemOf('projects: {}\n---\nprojects: {}\n'), /^projects\.yaml: isn't valid YAML/)
  assert.match(problemOf('projects: {}\nprojects: {}\n'), /^projects\.yaml: isn't valid YAML/)
  assert.match(problemOf('projects: !!js/function "function(){}"\n'), /^projects\.yaml: isn't valid YAML/)
})

test('a YAML error never repeats an alias, a tag or a tag handle from the document', () => {
  const word = 'hunter2Secret'
  const gate = (value: string) => `projects:\n  acme/widget:\n    family: a\n    role: r\n    gate: ${value}\n    gateTimeout: 5m\n`
  const documents = {
    'an alias nothing defines': gate(`*${word}`),
    'a local tag': gate(`!${word} make`),
    'a verbatim tag': gate(`!<tag:example.test,2024:${word}> make`),
    'a tag handle nothing declares': gate(`!${word}!x make`),
    'a declared tag handle with a tag nothing builds': `%TAG !h! tag:example.test,2024:\n---\n${gate(`!h!${word} make`)}`,
    'a secondary tag': gate(`!!${word} make`),
    'an alias that resembles an anchor': `a: &${word} 1\nb: *${word}x\n`,
  }
  for (const [what, text] of Object.entries(documents)) {
    const problem = problemOf(text)
    assert.match(problem, /^projects\.yaml: isn't valid YAML( \(line \d+\))?$/, what)
    assert.ok(!problem.includes(word), `${what}: ${problem}`)
  }
  // The line it reports is the document's own.
  assert.equal(problemOf(gate(`*${word}`)), 'projects.yaml: isn\'t valid YAML (line 5)')
})

test('a document nested past what the parser can follow is a problem, not a crash', () => {
  assert.match(problemOf(`projects: ${'['.repeat(100_000)}`), /^projects\.yaml: /)
})

test('a byte order mark is ignored', () => {
  assert.deepEqual(parseProjects(`\uFEFF${SEED_TEXT}`), { ok: true, projects: [], fields: {} })
})

test('only the first problem is reported, in the order the file has them', () => {
  const text = JSON.stringify({
    projects: {
      'acme/first': { ...BASE, gateTimeout: '1s' },
      'acme/second': { ...BASE, family: '' },
      'bad name': BASE,
    },
  })
  const problem = problemOf(text)
  assert.match(problem, /^projects\.yaml: acme\/first: gateTimeout must be/)
  assert.ok(!problem.includes('second') && !problem.includes('bad name'))
  // A bad name before a bad field.
  const reversed = JSON.stringify({ projects: { 'bad name': BASE, 'acme/second': { ...BASE, family: '' } } })
  assert.match(problemOf(reversed), /^projects\.yaml: "bad name" isn't a valid project name/)
})

// --- names ------------------------------------------------------------------------------------

test('nameProblem accepts GitHub\'s names', () => {
  for (const name of [
    'a/b', 'bketelsen/dish', 'frostyard/snosi', 'Acme/Widget', 'a-b/c', 'a1/b2', '1/2', 'a/.github', 'a/b.c', 'a/b_c', 'a/b-c', 'a/-', 'a/_', 'a/...', 'a/x.gitx', 'a/x.github',
    `${'a'.repeat(39)}/b`, `a/${'b'.repeat(100)}`, 'a-b-c/d', 'scratchy/x', 'acme/scratch', 'xscratch/x',
  ]) {
    assert.equal(nameProblem(name), undefined, name)
  }
})

test('nameProblem refuses what isn\'t owner/repo', () => {
  for (const name of [
    '', 'a', 'ab', '/', '/b', 'a/', 'a/b/c', 'a//b', ' a/b', 'a/b ', 'a /b', 'a/ b', 'a/b\n', 'a\n/b', 'a/b c', 'a/b/', '/a/b', 'a\\b',
    // owner grammar
    '-a/b', 'a-/b', 'a--b/c', '-/b', 'a_b/c', 'a.b/c', 'é/b', 'a@b/c', `${'a'.repeat(40)}/b`,
    // repo grammar
    'a/b?c', 'a/b#c', 'a/é', 'a/b:c', `a/${'b'.repeat(101)}`, 'a/.', 'a/..',
    // repo names ending in .git
    'a/x.git', 'a/x.GIT', 'a/x.Git', 'a/.git', 'a/a.b.git',
    // keys that can't be a path, or that JavaScript treats specially
    '__proto__', 'a/__proto__x\0',
  ]) {
    const problem = nameProblem(name)
    assert.equal(typeof problem, 'string', JSON.stringify(name))
    assert.ok(!problem!.includes('\n'), JSON.stringify(problem))
  }
})

test('nameProblem names the rule', () => {
  assert.match(nameProblem('abc')!, /owner\/repo/)
  assert.match(nameProblem('-a/b')!, /owner/)
  assert.match(nameProblem(`${'a'.repeat(40)}/b`)!, /owner/)
  assert.match(nameProblem('a/x.git')!, /\.git/)
  assert.match(nameProblem('a/..')!, /"\.\."/)
  assert.match(nameProblem('a/b c')!, /repository/)
})

test('the owner tokens is reserved, in any case: the token files live in <state>/workspaces/tokens/', () => {
  for (const name of ['tokens/x', 'Tokens/x', 'TOKENS/repo']) {
    assert.match(nameProblem(name)!, /tokens is reserved for dish-workspaces' token files/, name)
  }
  assert.equal(nameProblem('tokensmith/x'), undefined)
  assert.equal(nameProblem('acme/tokens'), undefined)
})

test('the owner scratch is reserved, in any case', () => {
  for (const name of ['scratch/x', 'Scratch/x', 'SCRATCH/x', 'sCrAtCh/repo']) {
    assert.match(nameProblem(name)!, /scratch.+reserved/, name)
    assert.match(problemOf(JSON.stringify({ projects: { [name]: BASE } })), /reserved/, name)
  }
})

test('OWNER and REPO are the grammars the interfaces name', () => {
  for (const owner of ['a', 'A', 'a-b', 'a1', '9', `${'a'.repeat(39)}`]) assert.match(owner, OWNER)
  for (const owner of ['', '-', '-a', 'a-', 'a--b', 'a_b', 'a.b', 'a b', `${'a'.repeat(40)}`, 'a\n']) assert.doesNotMatch(owner, OWNER)
  for (const repo of ['a', '.', '..', '.github', 'a.git', 'a_b-c.d', 'b'.repeat(100)]) assert.match(repo, REPO)
  for (const repo of ['', 'a b', 'a/b', 'a:b', 'b'.repeat(101), 'a\n']) assert.doesNotMatch(repo, REPO)
})

test('two keys that differ only in case are refused', () => {
  const problem = problemOf(JSON.stringify({ projects: { 'a/b': BASE, 'A/B': BASE } }))
  assert.match(problem, /^projects\.yaml: /)
  assert.ok(problem.includes('"a/b"') && problem.includes('"A/B"'), problem)
  assert.match(problem, /case/)
  // Only the repo differs in case.
  assert.match(problemOf(JSON.stringify({ projects: { 'acme/Widget': BASE, 'Acme/widget': BASE, 'zed/q': BASE } })), /case/)
  // Different repos, and the same repo under different owners, are fine.
  assert.equal(projectsOf(JSON.stringify({ projects: { 'a/b': BASE, 'a/c': BASE, 'b/b': BASE } })).length, 3)
})

test('a key that isn\'t a name is refused with the key quoted and cut', () => {
  assert.match(problemOf(JSON.stringify({ projects: { 'no-slash': BASE } })), /^projects\.yaml: "no-slash" isn't a valid project name/)
  const long = 'x'.repeat(500)
  const problem = problemOf(JSON.stringify({ projects: { [long]: BASE } }))
  assert.ok(problem.length < 400, `${problem.length}`)
  assert.ok(problem.includes('…'))
  // A non-string key, as YAML writes it, is still a string by the time JavaScript has it.
  assert.match(problemOf('projects:\n  1: {}\n'), /"1" isn't a valid project name/)
  assert.match(problemOf('projects:\n  __proto__: {}\n'), /"__proto__" isn't a valid project name/)
})

// --- fields -----------------------------------------------------------------------------------

test('family, role, gate and gateTimeout are required', () => {
  for (const field of ['family', 'role', 'gate', 'gateTimeout']) {
    const problem = problemOf(one({ [field]: undefined }))
    assert.equal(problem, `projects.yaml: acme/widget: ${field} is missing`)
  }
})

test('family, role and gate must be non-blank, single-line strings', () => {
  for (const field of ['family', 'role', 'gate']) {
    for (const blank of ['', ' ', '   ', '\t', ' \n ']) {
      assert.equal(problemOf(one({ [field]: blank })), `projects.yaml: acme/widget: ${field} is blank`, `${field} ${JSON.stringify(blank)}`)
    }
    for (const bad of [1, true, null, ['a'], { a: 'b' }]) {
      assert.equal(problemOf(one({ [field]: bad })), `projects.yaml: acme/widget: ${field} must be a string`, `${field} ${JSON.stringify(bad)}`)
    }
    assert.equal(problemOf(one({ [field]: 'line one\nline two' })), `projects.yaml: acme/widget: ${field} must be one line`)
    assert.equal(problemOf(one({ [field]: 'line one\rline two' })), `projects.yaml: acme/widget: ${field} must be one line`)
  }
})

test('a value is trimmed, so a block scalar\'s trailing newline is not part of the gate', () => {
  const text = 'projects:\n  acme/widget:\n    family: " acme "\n    role: widgets\n    gate: |\n      make test\n    gateTimeout: 5m\n'
  const project = only(text)
  assert.equal(project.family, 'acme')
  assert.equal(project.gate, 'make test')
  const result = parseProjects(text)
  assert.ok(result.ok)
  assert.equal(result.fields['acme/widget']!.gate, 'make test')
})

test('the gate and setup may not hold a NUL, which no process can be given', () => {
  assert.equal(problemOf(one({ gate: 'make\u0000test' })), 'projects.yaml: acme/widget: gate must not contain a NUL character')
  assert.equal(problemOf(one({ setup: 'make\u0000setup' })), 'projects.yaml: acme/widget: setup must not contain a NUL character')
})

test('gateTimeout is required and must be a duration from 10s to 10m', () => {
  const sentence = 'gateTimeout must be <n>s, <n>m or <n>h between 10s and 10m'
  for (const bad of ['9s', '1s', '11m', '601s', '1h', '0m', '10', '10 m', '10M', '', '1.5m', ' 10m', 600, null, true, ['10m']]) {
    assert.equal(problemOf(one({ gateTimeout: bad })), `projects.yaml: acme/widget: ${sentence}`, JSON.stringify(bad))
  }
  assert.equal(only(one({ gateTimeout: '10s' })).gateTimeoutMs, 10_000)
  assert.equal(only(one({ gateTimeout: '10m' })).gateTimeoutMs, 600_000)
  assert.equal(only(one({ gateTimeout: '600s' })).gateTimeoutMs, 600_000)
  assert.equal(only(one({ gateTimeout: '90s' })).gateTimeoutMs, 90_000)
  assert.equal(only(one({ gateTimeout: '5m' })).gateTimeout, '5m')
})

test('setupTimeout is optional, defaults to 15m, and must be a duration from 10s to 1h', () => {
  const sentence = 'setupTimeout must be <n>s, <n>m or <n>h between 10s and 1h'
  for (const bad of ['9s', '61m', '3601s', '2h', '0h', '15', '15 m', '', 900, null]) {
    assert.equal(problemOf(one({ setupTimeout: bad })), `projects.yaml: acme/widget: ${sentence}`, JSON.stringify(bad))
  }
  assert.equal(only(one({ setupTimeout: '10s' })).setupTimeoutMs, 10_000)
  assert.equal(only(one({ setupTimeout: '1h' })).setupTimeoutMs, 3_600_000)
  assert.equal(only(one({ setupTimeout: '60m' })).setupTimeoutMs, 3_600_000)
  assert.equal(only(one({ setupTimeout: '3600s' })).setupTimeoutMs, 3_600_000)
  const absent = only(one({}))
  assert.equal(absent.setupTimeout, '15m')
  assert.equal(absent.setupTimeoutMs, 900_000)
  assert.equal(SETUP_TIMEOUT.fallback, '15m')
  // The fallback is not written into the fields: they are what the file says.
  const result = parseProjects(one({}))
  assert.ok(result.ok)
  assert.ok(!('setupTimeout' in result.fields['acme/widget']!))
})

test('setup is optional, and a non-blank string when given', () => {
  assert.equal(only(one({})).setup, undefined)
  assert.equal(only(one({ setup: 'pnpm install' })).setup, 'pnpm install')
  assert.equal(only(one({ setup: 'pnpm install\npnpm build\n' })).setup, 'pnpm install\npnpm build')
  for (const blank of ['', '  ', '\n']) assert.equal(problemOf(one({ setup: blank })), 'projects.yaml: acme/widget: setup is blank')
  for (const bad of [1, true, null, ['a']]) assert.equal(problemOf(one({ setup: bad })), 'projects.yaml: acme/widget: setup must be a string')
})

test('unknown fields are refused, and field names are case-sensitive', () => {
  assert.equal(
    problemOf(one({ extra: 1 })),
    'projects.yaml: acme/widget: unknown field "extra"; the fields are family, role, gate, gateTimeout, setup, setupTimeout and gateEnv',
  )
  assert.match(problemOf(one({ Family: 'x' })), /unknown field "Family"/)
  assert.match(problemOf(one({ gate_timeout: '5m' })), /unknown field "gate_timeout"/)
  // YAML can write a field called __proto__; it is an unknown field like any other.
  assert.match(problemOf('projects:\n  acme/widget:\n    family: a\n    __proto__: x\n'), /unknown field "__proto__"/)
})

test('a project\'s settings must be a mapping', () => {
  for (const bad of ['text', 1, null, ['a'], true]) {
    const problem = problemOf(JSON.stringify({ projects: { 'acme/widget': bad } }))
    assert.match(problem, /^projects\.yaml: acme\/widget: the settings must be a mapping/, JSON.stringify(bad))
  }
  assert.match(problemOf('projects:\n  acme/widget:\n'), /^projects\.yaml: acme\/widget: the settings must be a mapping/)
})

test('a problem names the project and the field, as one sentence', () => {
  assert.equal(
    problemOf(JSON.stringify({ projects: { 'frostyard/snosi': { ...BASE, gateTimeout: '1h' } } })),
    'projects.yaml: frostyard/snosi: gateTimeout must be <n>s, <n>m or <n>h between 10s and 10m',
  )
})

// --- gateEnv ----------------------------------------------------------------------------------

test('gateEnv is optional, a map of names to strings, and {} when absent', () => {
  assert.deepEqual(only(one({})).gateEnv, {})
  const env = { GOFLAGS: '-mod=mod', CACHE: '<clone>/.cache', OUT: '<worktree>/out', EMPTY: '', _x1: 'a b', lower_case: 'ok' }
  const project = only(one({ gateEnv: env }))
  assert.deepEqual(project.gateEnv, env)
  // Names that merely resemble the refused ones are fine.
  const resembling = { DSHELL: '1', MY_DSH_THING: '1', PASSWD: '1', TOKE: '1', KE_Y: '1' }
  assert.deepEqual(only(one({ gateEnv: resembling })).gateEnv, resembling)
})

test('an empty gateEnv is the same as none', () => {
  const result = parseProjects(one({ gateEnv: {} }))
  assert.ok(result.ok)
  assert.ok(!('gateEnv' in result.fields['acme/widget']!))
  assert.deepEqual(result.projects[0]!.gateEnv, {})
})

test('gateEnv must be a mapping of variable names to strings', () => {
  for (const bad of ['text', 1, true, null, ['A=b'], [{ A: 'b' }]]) {
    assert.equal(problemOf(one({ gateEnv: bad })), 'projects.yaml: acme/widget: gateEnv must be a mapping of variable names to strings', JSON.stringify(bad))
  }
  assert.match(problemOf('projects:\n  acme/widget:\n    family: a\n    role: r\n    gate: g\n    gateTimeout: 5m\n    gateEnv:\n'), /gateEnv must be a mapping/)
})

test('gateEnv refuses names that aren\'t variable names', () => {
  for (const name of ['1BAD', 'MY-VAR', 'A B', 'A=B', 'A.B', '', 'é', 'A\nB', '$HOME']) {
    const problem = problemOf(one({ gateEnv: { [name]: 'x' } }))
    assert.match(problem, /^projects\.yaml: acme\/widget: gateEnv names a variable .* that isn't a name \(letters, digits and underscores, not starting with a digit\)$/, JSON.stringify(name))
  }
})

test('gateEnv refuses names starting with DSH_, in any case', () => {
  for (const name of ['DSH_HOME', 'DSH_X', 'dsh_home', 'Dsh_Anything', 'DSH_']) {
    assert.equal(
      problemOf(one({ gateEnv: { [name]: 'x' } })),
      `projects.yaml: acme/widget: gateEnv can't set "${name}": dsh reserves names starting with DSH_`,
      name,
    )
  }
})

test('gateEnv refuses names that look like secrets, in any case', () => {
  for (const name of ['GH_TOKEN', 'API_KEY', 'KEY', 'DB_PASSWORD', 'MY_SECRET', 'token', 'apikey', 'PassWord', 'Secret_X', 'MONKEY', 'NPM_TOKEN_X', 'AWS_SECRET_ACCESS_KEY']) {
    assert.equal(
      problemOf(one({ gateEnv: { [name]: 'x' } })),
      `projects.yaml: acme/widget: gateEnv can't set "${name}": a name with KEY, PASSWORD, SECRET or TOKEN in it looks like a secret`,
      name,
    )
  }
})

test('a long variable name is cut where it is shown, as every name is', () => {
  for (const name of [`DSH_${'x'.repeat(200)}`, `${'x'.repeat(200)}_TOKEN`, 'A'.repeat(200).replace(/^A/, '1')]) {
    const problem = problemOf(one({ gateEnv: { [name]: 'x' } }))
    assert.ok(problem.length < 300, `${problem.length}`)
    assert.ok(problem.includes('…'), problem)
    assert.ok(!problem.includes('x'.repeat(100)), problem)
  }
})

test('gateEnv values must be strings without a line break', () => {
  for (const bad of [1, true, null, 1.5, ['a'], { a: 'b' }]) {
    assert.equal(problemOf(one({ gateEnv: { FOO: bad } })), 'projects.yaml: acme/widget: gateEnv.FOO must be a string', JSON.stringify(bad))
  }
  assert.equal(problemOf(one({ gateEnv: { FOO: 'a\nb' } })), 'projects.yaml: acme/widget: gateEnv.FOO must be one line')
  assert.equal(problemOf(one({ gateEnv: { FOO: 'a\rb' } })), 'projects.yaml: acme/widget: gateEnv.FOO must be one line')
  assert.equal(problemOf(one({ gateEnv: { FOO: 'a\u0000b' } })), 'projects.yaml: acme/widget: gateEnv.FOO must not contain a NUL character')
  // Spaces are the value's own.
  assert.equal(only(one({ gateEnv: { FOO: '  a  ' } })).gateEnv.FOO, '  a  ')
})

test('a variable called __proto__ is kept as a variable, not lost to the prototype', () => {
  const text = 'projects:\n  acme/widget:\n    family: a\n    role: r\n    gate: g\n    gateTimeout: 5m\n    gateEnv:\n      __proto__: x\n      OTHER: y\n'
  const project = only(text)
  assert.deepEqual(Object.keys(project.gateEnv), ['__proto__', 'OTHER'])
  assert.equal(Object.getPrototypeOf(project.gateEnv), Object.prototype)
  assert.equal(Object.getOwnPropertyDescriptor(project.gateEnv, '__proto__')!.value, 'x')
})

test('a problem never quotes a value', () => {
  const lines = `${TOKEN}\nmore`
  const cases: Array<Record<string, unknown>> = [
    { family: lines },
    { role: lines },
    { gate: lines },
    { gate: `${TOKEN}\u0000` },
    { gate: { token: TOKEN } },
    { setup: `${TOKEN}\u0000` },
    { gateTimeout: TOKEN },
    { setupTimeout: TOKEN },
    { gateEnv: { FOO: lines } },
    { gateEnv: { FOO: `${TOKEN}\u0000` } },
    { gateEnv: { FOO: 5, BAR: TOKEN } },
    { gateEnv: { FOO: { nested: TOKEN } } },
    { gateEnv: TOKEN },
    { gateEnv: [TOKEN] },
  ]
  for (const fields of cases) {
    const problem = problemOf(one(fields))
    assert.ok(!problem.includes(TOKEN), problem)
    assert.ok(!problem.includes('\n'), JSON.stringify(problem))
  }
})

test('the store\'s own guard is the store\'s: a token in a gate is not this validator\'s business', () => {
  assert.equal(validate(PROJECTS_PATH, one({ gate: `curl -H "Authorization: token ${TOKEN}" example.test` })), undefined)
})

// --- fieldsProblem ----------------------------------------------------------------------------

test('fieldsProblem checks one project\'s settings, and names the project', () => {
  assert.equal(fieldsProblem('acme/widget', BASE), undefined)
  assert.equal(fieldsProblem('acme/widget', { ...BASE, setup: 'make', setupTimeout: '1h', gateEnv: { A: 'b' } }), undefined)
  assert.equal(fieldsProblem('acme/widget', { ...BASE, gate: '' }), 'acme/widget: gate is blank')
  assert.equal(fieldsProblem('acme/widget', undefined), 'acme/widget: the settings must be a mapping of fields to values')
  assert.equal(fieldsProblem('acme/widget', 'x'), 'acme/widget: the settings must be a mapping of fields to values')
  assert.match(fieldsProblem('acme/widget', { ...BASE, gateTimeout: '1s' })!, /^acme\/widget: gateTimeout must be/)
  // It says nothing about the name itself: that is nameProblem's.
  assert.equal(fieldsProblem('not a name', BASE), undefined)
  // A name that could break the sentence is quoted.
  assert.match(fieldsProblem('a\nb', { ...BASE, gate: '' })!, /^"a\\nb": gate is blank$/)
  // The same rules as the document: the first problem only.
  assert.match(fieldsProblem('acme/widget', { family: '', role: '', gate: '', gateTimeout: '' })!, /family is blank$/)
})

// --- serialize --------------------------------------------------------------------------------

test('serializeProjects writes keys sorted and fields in order, optional ones only when set', () => {
  const fields: Record<string, ProjectFields> = {
    'zed/last': { family: 'z', role: 'r', gate: 'g', gateTimeout: '10s' },
    'acme/first': {
      gateEnv: { B: '2', A: '<clone>/x' },
      setupTimeout: '1h',
      setup: 'make setup',
      gateTimeout: '5m',
      gate: 'make test',
      role: 'widgets',
      family: 'acme',
    },
  }
  assert.equal(serializeProjects(fields), [
    'projects:',
    '  acme/first:',
    '    family: acme',
    '    role: widgets',
    '    gate: make test',
    '    gateTimeout: 5m',
    '    setup: make setup',
    '    setupTimeout: 1h',
    '    gateEnv:',
    '      B: \'2\'',
    '      A: <clone>/x',
    '  zed/last:',
    '    family: z',
    '    role: r',
    '    gate: g',
    '    gateTimeout: 10s',
    '',
  ].join('\n'))
})

test('serializeProjects leaves out an optional field that is empty', () => {
  const text = serializeProjects({
    'a/b': { family: 'f', role: 'r', gate: 'g', gateTimeout: '10s', setup: '  ', setupTimeout: '', gateEnv: {} },
  })
  assert.equal(text, 'projects:\n  a/b:\n    family: f\n    role: r\n    gate: g\n    gateTimeout: 10s\n')
})

test('serializeProjects of nothing is the seed', () => {
  assert.equal(serializeProjects({}), SEED_TEXT)
})

test('serializeProjects sorts as parseProjects does', () => {
  const fields = { 'zed/a': BASE, 'Bob/b': BASE, 'acme/z': BASE, 'Acme/b': BASE }
  const names = [...serializeProjects(fields).matchAll(/^ {2}(\S+):$/gm)].map(match => match[1])
  assert.deepEqual(names, ['Acme/b', 'acme/z', 'Bob/b', 'zed/a'])
})

test('what serializeProjects writes parses back to the same fields', () => {
  const awkward: Record<string, ProjectFields> = {
    'bketelsen/dish': {
      family: 'bketelsen',
      role: 'dish itself, dsh plugins: "a personal" agent #harness',
      gate: 'pnpm typecheck && pnpm test',
      gateTimeout: '10m',
      setup: 'pnpm install --frozen-lockfile',
      setupTimeout: '15m',
    },
    'frostyard/snosi': { family: 'true', role: '123', gate: 'null', gateTimeout: '10s', setup: 'line one\nline two\n  indented\nline three', gateEnv: { Z: 'true', A: '10', M: '- dash', Q: "it's", E: '', S: '  spaced  ' } },
    'a/1': { family: '2024-01-01', role: '~', gate: '[x]', gateTimeout: '600s', setup: '#!/bin/sh\necho "hi"', setupTimeout: '3600s' },
    'A/B.c': { family: 'é ü', role: 'tab\tinside', gate: '*star', gateTimeout: '1m', gateEnv: { _: '&anchor', X1: '!tag', Y: '%dir', U: '@at', T: '`tick`', P: 'a: b', H: 'a #b' } },
  }
  const text = serializeProjects(awkward)
  const result = parseProjects(text)
  if (!result.ok) assert.fail(`${result.problem}\n${text}`)
  assert.deepEqual(result.fields, Object.fromEntries(Object.keys(awkward).sort((a, b) => a.toLowerCase() < b.toLowerCase() ? -1 : 1).map(name => [name, awkward[name]])))
  // And the text a second time is the same text.
  assert.equal(serializeProjects(result.fields), text)
})

test('the spec\'s example round-trips through its parsed form', () => {
  const first = parseProjects(EXAMPLE)
  assert.ok(first.ok)
  const second = parseProjects(serializeProjects(first.fields))
  assert.ok(second.ok)
  assert.deepEqual(second.projects, first.projects)
  assert.deepEqual(second.fields, first.fields)
})

test('serializeProjects writes no YAML alias, even for a value two projects share', () => {
  const shared = { A: 'b' }
  const text = serializeProjects({ 'a/b': { ...BASE, gateEnv: shared }, 'a/c': { ...BASE, gateEnv: shared } })
  assert.ok(!/[&*]\w/.test(text.replaceAll('<clone>', '')), text)
  const result = parseProjects(text)
  assert.ok(result.ok)
  assert.equal(result.projects.length, 2)
})

// --- validate and the namespace ---------------------------------------------------------------

test('validate gives parseProjects\' problem without the path, which the store puts in front', () => {
  assert.equal(validate(PROJECTS_PATH, one({ gateTimeout: '1s' })), 'acme/widget: gateTimeout must be <n>s, <n>m or <n>h between 10s and 10m')
  assert.equal(validate(PROJECTS_PATH, 'projects: {}\nx: 1\n'), 'unknown top-level key "x"; the only key is projects')
  assert.equal(validate(PROJECTS_PATH, EXAMPLE), undefined)
})

test('namespaceSpec claims the one document, as a propose-only namespace', () => {
  const spec = namespaceSpec('dish-projects')
  assert.equal(spec.prefix, 'projects.yaml')
  assert.equal(spec.owner, 'dish-projects')
  assert.equal(spec.agent, 'propose')
  assert.equal(spec.validate, validate)
  assert.equal(namespaceSpec('someone').owner, 'someone')
})

// --- the store --------------------------------------------------------------------------------

test('the store applies the claim: the seed, a valid write, a refused write, and an agent that may only propose', async () => {
  const dir = await tempDir()
  const ctx = new Context()
  const config = ctx.plugin(configPlugin, {
    terminal: false,
    repository: join(dir, 'config.git'),
    userName: 'Test User',
    userEmail: 'test@example.test',
  } as configPlugin.Config)
  await config
  try {
    const store = ctx.dishConfig
    const release = store.claim(namespaceSpec('dish-projects'))
    // Nobody else can take the document while it is claimed.
    assert.throws(() => store.claim(namespaceSpec('someone-else')), /projects\.yaml/)

    await store.seed({ [PROJECTS_PATH]: SEED_TEXT }, 'dish-projects')
    assert.equal(await store.read(PROJECTS_PATH), SEED_TEXT)

    await store.write([{ path: PROJECTS_PATH, text: EXAMPLE }], { author: { kind: 'user' } })
    assert.equal(await store.read(PROJECTS_PATH), EXAMPLE)

    const refused = await store.write([{ path: PROJECTS_PATH, text: one({ gateTimeout: '1s' }) }], { author: { kind: 'user' } }).then(() => undefined, (error: unknown) => error as ConfigStoreError)
    assert.equal(refused?.code, 'INVALID')
    assert.equal(refused?.message, 'projects.yaml: acme/widget: gateTimeout must be <n>s, <n>m or <n>h between 10s and 10m')
    assert.equal(await store.read(PROJECTS_PATH), EXAMPLE)

    // An agent may not write it, only propose, and a proposal is checked as a write is.
    const agent = { kind: 'agent', sessionId: 's1', role: 'main' } as const
    const forbidden = await store.write([{ path: PROJECTS_PATH, text: serializeProjects({}) }], { author: agent }).then(() => undefined, (error: unknown) => error as ConfigStoreError)
    assert.equal(forbidden?.code, 'FORBIDDEN')
    const proposal = await store.propose([{ path: PROJECTS_PATH, text: SEED_TEXT }], { author: agent, title: 'Remove everything', rationale: 'a test' })
    assert.deepEqual(proposal.paths, [PROJECTS_PATH])
    const badProposal = await store.propose([{ path: PROJECTS_PATH, text: 'projects: nope\n' }], { author: agent, title: 'Break it', rationale: 'a test' }).then(() => undefined, (error: unknown) => error as ConfigStoreError)
    assert.equal(badProposal?.code, 'INVALID')

    release()
    store.claim(namespaceSpec('someone-else'))()
  } finally {
    await config.dispose()
  }
})
