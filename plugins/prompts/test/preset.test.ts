import { execFile } from 'node:child_process'
import { copyFileSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import assert from 'node:assert/strict'
import { generate, readStandard } from '../scripts/sync-preset.mjs'
import { tempDir } from './helpers.ts'

const run = promisify(execFile)

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..')
const COMMITTED = join(PLUGIN, 'presets', 'dish.patch.yml')
const SCRIPT = join(PLUGIN, 'scripts', 'sync-preset.mjs')

const SYNC = 'pnpm --filter dish-prompts sync-preset'
const PERSONA_NAME = "'@deepseek-ai/dsh-persona'"
const DESCRIPTION = 'The dish main agent: your prompts from Settings → Prompts, on the standard tool set.'

/** The standard preset's file text and its dsh-web-app version, read from the dsh-web-app that dsh itself resolves. */
const standard = readStandard()

// --- the drift check -------------------------------------------------------------------------

test('the committed dish preset is what generate makes from the standard preset dsh resolves', () => {
  assert.equal(
    generate(standard.text, standard.version),
    readFileSync(COMMITTED, 'utf8'),
    `presets/dish.patch.yml has drifted from @deepseek-ai/dsh-web-app ${standard.version}'s standard preset. Run \`${SYNC}\` and commit the result.`,
  )
})

test('the standard preset is read from the dsh-web-app that dsh resolves, so a dsh upgrade is what moves it', () => {
  const dsh = createRequire(join(PLUGIN, '..', '..', 'package.json')).resolve('@deepseek-ai/dsh/package.json')
  const dshWebApp = realpathSync(createRequire(dsh).resolve('@deepseek-ai/dsh-web-app/package.json'))
  assert.equal(realpathSync(standard.packagePath), dshWebApp)
  assert.equal(realpathSync(standard.path), join(dirname(dshWebApp), 'presets', 'standard.patch.yml'))
  const wanted: string = JSON.parse(readFileSync(dsh, 'utf8')).dependencies['@deepseek-ai/dsh-web-app']
  if (/^\d/.test(wanted)) assert.equal(standard.version, wanted, 'dsh pins an exact dsh-web-app')
})

test('this package does not pin its own dsh-web-app, which would hide a dsh upgrade from the drift check', () => {
  const manifest = JSON.parse(readFileSync(join(PLUGIN, 'package.json'), 'utf8'))
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    assert.ok(!(manifest[field] ?? {})['@deepseek-ai/dsh-web-app'], field)
  }
})

/** Every `name:` line of a preset's plugin list (nested groups too), in order. The wrapper's own come before `plugins:`. */
function listNames(text: string): string[] {
  const lines = text.split('\n')
  const start = lines.findIndex(line => /^\s+plugins:\s*$/.test(line))
  assert.notEqual(start, -1, 'a plugins: list')
  return lines.slice(start + 1).flatMap(line => /^\s*name:\s*(.+?)\s*$/.exec(line)?.[1] ?? [])
}

test('the dish preset swaps the persona row and keeps every other row of the standard list, in order', () => {
  const output = generate(standard.text, standard.version)
  const names = listNames(standard.text)
  assert.equal(names.filter(name => name === PERSONA_NAME).length, 1, 'the standard preset has one persona row')
  assert.deepEqual(listNames(output), names.map(name => name === PERSONA_NAME ? 'dish-prompts/persona' : name))
  assert.ok(!output.includes('@deepseek-ai/dsh-persona'), 'no stock persona row')
  assert.ok(!output.includes('You are a coding agent'), 'the stock persona config is gone')
  assert.equal(output.split('\n').filter(line => line.trim() === 'name: dish-prompts/persona').length, 1)
  assert.equal(output.split('\n').filter(line => line.trim() === 'role: main').length, 1)
  assert.equal(output.split('\n').filter(line => line.trim() === '- id: dish-persona').length, 1)
})

// --- the output is YAML dsh can read -----------------------------------------------------------

interface YamlParser {
  Type: new (tag: string, options: { kind: 'scalar', construct: (data: string) => unknown }) => unknown
  DEFAULT_SCHEMA: { extend(types: unknown[]): unknown }
  load(text: string, options: { schema: unknown }): unknown
}

/**
 * js-yaml is not a dependency of this package. dsh's agent preset registry declares it, so follow the chain of declared
 * dependencies from the dsh-web-app dsh resolves: web app, then agent preset, then its registry, then js-yaml.
 */
function findYaml(): YamlParser | undefined {
  try {
    const next = (from: string, name: string) => realpathSync(createRequire(from).resolve(`${name}/package.json`))
    const agentPreset = next(standard.packagePath, '@deepseek-ai/dsh-agent-preset')
    const registry = next(agentPreset, '@deepseek-ai/dsh-agent-preset-registry')
    return createRequire(registry)('js-yaml') as YamlParser
  } catch {
    return undefined
  }
}

const yaml = findYaml()

test('the dish preset parses as YAML with its !!js tags, and its list is the standard list with the persona swapped', {
  skip: yaml === undefined ? 'js-yaml could not be reached through dsh-agent-preset-registry' : false,
}, () => {
  const parse = (text: string): any => yaml!.load(text, {
    schema: yaml!.DEFAULT_SCHEMA.extend([new yaml!.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: data => ({ js: data }) })]),
  })
  const dish = parse(generate(standard.text, standard.version))
  const stock = parse(standard.text)

  // The wrapper is fixed. A preset-level key dsh adds to its own row would be dropped by it, so fail instead.
  const known = ['id', 'name', 'description', 'order', 'plugins']
  const unknown = Object.keys(stock[0].insert[0].config).filter(key => !known.includes(key))
  assert.deepEqual(unknown, [], `dsh's standard preset has config keys the dish preset's wrapper doesn't carry: update WRAPPER in scripts/sync-preset.mjs to carry ${unknown.join(', ')}`)

  assert.equal(dish.length, 1)
  assert.equal(dish[0].insert.length, 1)
  const row = dish[0].insert[0]
  assert.equal(row.id, 'preset-dish')
  assert.equal(row.name, '@deepseek-ai/dsh-agent-preset')
  assert.deepEqual(Object.keys(row.config), ['id', 'name', 'description', 'order', 'plugins'])
  assert.equal(row.config.id, 'dish')
  assert.equal(row.config.name, 'dish')
  assert.equal(row.config.description, DESCRIPTION)
  assert.equal(row.config.order, 0)

  const persona = { id: 'dish-persona', name: 'dish-prompts/persona', config: { role: 'main' } }
  const expected = stock[0].insert[0].config.plugins.map((entry: { id: string }) => entry.id === 'persona' ? persona : entry)
  assert.deepEqual(row.config.plugins, expected)
  assert.ok(row.config.plugins.some((entry: { disabled?: unknown }) => typeof entry.disabled === 'object'), 'the !!js tags came through')
})

// --- synthetic standard files -------------------------------------------------------------------

const WRAPPER = [
  '- insert:',
  '    - id: preset-dish',
  "      name: '@deepseek-ai/dsh-agent-preset'",
  '      config:',
  '        id: dish',
  '        name: dish',
  `        description: '${DESCRIPTION}'`,
  '        order: 0',
  '        plugins:',
]

/** The standard file's own wrapper around a list; lines of the list are given whole, with their indentation. */
function standardOf(list: string[], listIndent = 10, head: string[] = ['# Agent preset standard.']): string {
  return [
    ...head,
    '- insert:',
    '    - id: preset-standard',
    "      name: '@deepseek-ai/dsh-agent-preset'",
    '      config:',
    '        id: standard',
    '        order: 1',
    '        plugins:',
    ...list.map(line => line === '' ? '' : ' '.repeat(listIndent - 10) + line),
    '',
  ].join('\n')
}

const BASH = [
  '          - id: tool-bash',
  "            name: '@deepseek-ai/dsh-tool-bash'",
  "            disabled: !!js process.platform === 'win32'",
]
const PERSONA = [
  '          - id: persona',
  `            name: ${PERSONA_NAME}`,
  '            config:',
  '              suffix: Your working directory is {{cwd}}.',
  '              prefix: |',
  '                You are a coding agent.',
  '',
  '                Use {{model}}.',
]
const GROUP = [
  '          - id: planning',
  '            name: cordis:group',
  '            group: true',
  '            config:',
  '              # a comment inside a group',
  '              - id: plan-mode',
  "                name: '@deepseek-ai/dsh-plan-mode'",
]
const DISH_PERSONA = [
  '          - id: dish-persona',
  '            name: dish-prompts/persona',
  '            config:',
  '              role: main',
]

/** What the generator makes, as `[header, body]`. */
function split(output: string): [string, string] {
  const at = output.indexOf('- insert:')
  assert.notEqual(at, -1)
  return [output.slice(0, at), output.slice(at)]
}

test('the header says the file is generated, from which dsh-web-app version, and how to regenerate it', () => {
  const [header] = split(generate(standardOf([...BASH, ...PERSONA]), '9.8.7-test'))
  assert.ok(header.split('\n').filter(line => line !== '').every(line => line.startsWith('#')), header)
  assert.match(header, /generated/i)
  assert.match(header, /@deepseek-ai\/dsh-web-app 9\.8\.7-test/)
  assert.ok(header.includes(SYNC), header)
})

test('a persona row first, in the middle, or last is replaced and nothing else changes', () => {
  const cases: [string, string[], string[]][] = [
    ['first', [...PERSONA, ...BASH, ...GROUP], [...DISH_PERSONA, ...BASH, ...GROUP]],
    ['middle', [...BASH, ...PERSONA, ...GROUP], [...BASH, ...DISH_PERSONA, ...GROUP]],
    ['last', [...BASH, ...GROUP, ...PERSONA], [...BASH, ...GROUP, ...DISH_PERSONA]],
    ['alone', PERSONA, DISH_PERSONA],
  ]
  for (const [where, list, expected] of cases) {
    const [, body] = split(generate(standardOf(list), '1.0.0'))
    assert.equal(body, [...WRAPPER, ...expected, ''].join('\n'), where)
  }
})

test('comments and blank lines inside the list stay; a comment above the next row stays with that row', () => {
  const list = [
    '          # the persona',
    ...PERSONA,
    '          # the shell',
    '',
    ...BASH,
    '          # trailing, in the list',
  ]
  const [, body] = split(generate(standardOf(list), '1.0.0'))
  assert.equal(body, [
    ...WRAPPER,
    '          # the persona',
    ...DISH_PERSONA,
    '          # the shell',
    '',
    ...BASH,
    '          # trailing, in the list',
    '',
  ].join('\n'))
})

test('a persona row with a comment of its own inside it goes entirely', () => {
  const persona = [...PERSONA.slice(0, 3), '              # why', ...PERSONA.slice(3)]
  const [, body] = split(generate(standardOf([...BASH, ...persona, ...GROUP]), '1.0.0'))
  assert.equal(body, [...WRAPPER, ...BASH, ...DISH_PERSONA, ...GROUP, ''].join('\n'))
})

test('a persona-looking row inside a nested group is not the persona row', () => {
  const nested = [...GROUP, '              - id: persona', "                name: '@deepseek-ai/dsh-persona'"]
  const [, body] = split(generate(standardOf([...nested, ...PERSONA]), '1.0.0'))
  assert.equal(body, [...WRAPPER, ...nested, ...DISH_PERSONA, ''].join('\n'))
})

test('a list at another indentation lands where the wrapper expects it, keeping its shape', () => {
  const [, body] = split(generate(standardOf([...BASH, ...PERSONA, ...GROUP], 14), '1.0.0'))
  assert.equal(body, [...WRAPPER, ...BASH, ...DISH_PERSONA, ...GROUP, ''].join('\n'))
})

test('CRLF line endings in the standard file make the same output', () => {
  const text = standardOf([...BASH, ...PERSONA, ...GROUP])
  assert.equal(generate(text.replaceAll('\n', '\r\n'), '1.0.0'), generate(text, '1.0.0'))
})

test('a standard file with no persona row, two persona rows, or no plugin list is refused', () => {
  assert.throws(() => generate(standardOf([...BASH, ...GROUP]), '1.0.0'), /persona/)
  assert.throws(() => generate(standardOf([...PERSONA, ...BASH, ...PERSONA]), '1.0.0'), /persona/)
  assert.throws(() => generate('- insert:\n    - id: preset-standard\n', '1.0.0'), /plugins/)
})

// --- running the script ------------------------------------------------------------------------

interface Ran { code: number, stdout: string, stderr: string }

async function sync(args: string[], cwd?: string): Promise<Ran> {
  try {
    const { stdout, stderr } = await run(process.execPath, [SCRIPT, ...args], { cwd })
    return { code: 0, stdout, stderr }
  } catch (error) {
    const { code, stdout, stderr } = error as Ran
    return { code, stdout, stderr }
  }
}

test('--check passes on the committed file, from any directory', async () => {
  const ran = await sync(['--check'], await tempDir())
  assert.equal(ran.code, 0, ran.stderr)
})

test('--check fails on a modified copy and says how to fix it, and leaves the file alone', async () => {
  const copy = join(await tempDir(), 'dish.patch.yml')
  copyFileSync(COMMITTED, copy)
  writeFileSync(copy, `${readFileSync(copy, 'utf8')}# hand edit\n`)
  const ran = await sync(['--check', '--out', copy])
  assert.equal(ran.code, 1)
  assert.ok(ran.stderr.includes(SYNC), ran.stderr)
  assert.ok(readFileSync(copy, 'utf8').endsWith('# hand edit\n'))
})

test('--check fails when the file is missing', async () => {
  const ran = await sync(['--check', '--out', join(await tempDir(), 'missing.yml')])
  assert.equal(ran.code, 1)
  assert.ok(ran.stderr.includes(SYNC), ran.stderr)
})

test('without --check the script writes the file, byte for byte what is committed', async () => {
  const out = join(await tempDir(), 'dish.patch.yml')
  const ran = await sync(['--out', out])
  assert.equal(ran.code, 0, ran.stderr)
  assert.equal(readFileSync(out, 'utf8'), readFileSync(COMMITTED, 'utf8'))
})

test('an unknown argument is refused', async () => {
  const ran = await sync(['--frobnicate'])
  assert.equal(ran.code, 2)
  assert.match(ran.stderr, /--frobnicate/)
})
