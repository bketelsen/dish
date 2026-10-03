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

const SYNC = 'pnpm --filter dish-crew sync-preset'
/** dsh's row for `send_message` and `interrupt_agent`, which dish-crew/control replaces. */
const CONTROL_NAME = "'@deepseek-ai/dsh-tool-subagent-control'"
const PERSONA_NAME = "'@deepseek-ai/dsh-persona'"
const DESCRIPTION = "The dish main agent: your prompts from Settings → Prompts, and a crew to delegate to, on the standard tool set without dsh's own delegation tools."

/** The standard rows that dsh's own delegation machinery lives in: the dish preset disables them, so the main agent delegates through crew. */
const DISABLED_IDS = ['tool-subagent', 'tool-subagent-fork', 'workflow-ptc', 'tool-workflow']

/** Standard rows of the same machinery that dsh already ships disabled. The dish preset keeps them off. */
const STOCK_DISABLED_IDS = ['tool-subagent-codex', 'tool-subagent-claude-code', 'tool-ralph']

/** The packages that give an agent a way to delegate or run workflows around crew. Every row of one must be `disabled: true`, whatever its id. */
const DELEGATION_PACKAGES = [
  '@deepseek-ai/dsh-tool-subagent',
  '@deepseek-ai/dsh-tool-workflow',
  '@deepseek-ai/dsh-tool-ralph',
  '@deepseek-ai/dsh-workflow-ptc',
]

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

test('the dish preset swaps the persona row, adds the delegate row after it, and keeps every other row of the standard list, in order', () => {
  const output = generate(standard.text, standard.version)
  const names = listNames(standard.text)
  assert.equal(names.filter(name => name === PERSONA_NAME).length, 1, 'the standard preset has one persona row')
  assert.deepEqual(listNames(output), names.flatMap(name => name === PERSONA_NAME
    ? ['dish-prompts/persona', 'dish-crew/delegate']
    : name === CONTROL_NAME ? ['dish-crew/control'] : [name]))
  assert.ok(!output.includes('@deepseek-ai/dsh-persona'), 'no stock persona row')
  assert.ok(!output.includes('You are a coding agent'), 'the stock persona config is gone')
  assert.equal(output.split('\n').filter(line => line.trim() === 'name: dish-prompts/persona').length, 1)
  assert.equal(output.split('\n').filter(line => line.trim() === 'role: main').length, 1)
  assert.equal(output.split('\n').filter(line => line.trim() === '- id: dish-persona').length, 1)
})

test('the delegate row follows the persona row, at its indentation', () => {
  const output = generate(standard.text, standard.version)
  assert.ok(output.includes([...DISH_PERSONA, ...DELEGATE].join('\n') + '\n'), 'the persona row, then the delegate row')
  assert.equal(output.split('\n').filter(line => line.trim() === 'name: dish-crew/delegate').length, 1)
})

/** The standard file's rows (nested groups too) by id, as text: the row's lines, from its `- id:` line to the next row at or above its indentation. */
function rowLines(text: string, id: string): string[] {
  const lines = text.split('\n')
  const starts = lines.flatMap((line, i) => new RegExp(`^\\s*- id:\\s*['"]?${id}['"]?\\s*$`).test(line) ? [i] : [])
  assert.equal(starts.length, 1, `one \`${id}\` row`)
  const indent = lines[starts[0]].length - lines[starts[0]].trimStart().length
  const next = lines.findIndex((line, i) => i > starts[0] && line.trim() !== '' && line.length - line.trimStart().length <= indent)
  return lines.slice(starts[0], next === -1 ? lines.length : next)
}

test('the four rows of dsh\'s own delegation are disabled, right after their names; nothing else about them changes', () => {
  const output = generate(standard.text, standard.version)
  for (const id of DISABLED_IDS) {
    const stock = rowLines(standard.text, id)
    assert.ok(stock.every(line => !/^\s*disabled:/.test(line)), `the standard \`${id}\` row is enabled`)
    const dish = rowLines(output, id)
    assert.equal(dish[2].trim(), 'disabled: true', id)
    assert.deepEqual([...dish.slice(0, 2), ...dish.slice(3)], stock, id)
    assert.equal(dish[2].length - dish[2].trimStart().length, dish[1].length - dish[1].trimStart().length, `${id}: at the key indentation`)
  }
})

test('send_message and interrupt_agent come from dish-crew/control, where dsh\'s row was; list_agents stays as standard has it', () => {
  const output = generate(standard.text, standard.version)
  const stock = rowLines(standard.text, 'tool-subagent-control')
  const indent = stock[0]!.length - stock[0]!.trimStart().length
  const pad = ' '.repeat(indent)
  assert.deepEqual(rowLines(output, 'dish-crew-control'), [`${pad}- id: dish-crew-control`, `${pad}  name: dish-crew/control`])
  assert.ok(!output.split('\n').some(line => /^\s*- id:\s*tool-subagent-control\s*$/.test(line)), 'dsh\'s row is gone')
  assert.ok(!output.includes(`name: ${CONTROL_NAME}`), 'nothing loads dsh\'s send_message')
  assert.deepEqual(rowLines(output, 'tool-subagent-list-agents'), rowLines(standard.text, 'tool-subagent-list-agents'))
  assert.deepEqual(rowLines(output, 'tool-subagent-list-agents').filter(line => /^\s*disabled:/.test(line)), [])
  assert.ok(rowLines(output, 'tool-subagent-list-agents').some(line => line.includes('dsh-tool-subagent-control/list-agents')))
  assert.ok(output.includes('- id: delegation\n'), 'the delegation group stays')
})

test('the rows dsh ships disabled stay as they are, so the dish preset has no enabled delegation row', () => {
  const output = generate(standard.text, standard.version)
  for (const id of STOCK_DISABLED_IDS) {
    assert.deepEqual(rowLines(output, id), rowLines(standard.text, id), id)
    assert.ok(rowLines(output, id).some(line => line.trim() === 'disabled: true'), id)
  }
})

// --- the output is YAML dsh can read -----------------------------------------------------------

interface YamlParser {
  Type: new (tag: string, options: { kind: 'scalar', construct: (data: string) => unknown }) => unknown
  DEFAULT_SCHEMA: { extend(types: unknown[]): unknown }
  load(text: string, options: { schema: unknown }): unknown
}

/**
 * A js-yaml to parse the output with. It first follows the chain of dependencies dsh itself declares, from the
 * dsh-web-app dsh resolves (web app, then agent preset, then its registry, then js-yaml), so the check reads the
 * output the way dsh's own registry would. If that chain can't be followed (dsh moved its dependencies), it falls back
 * to this package's own js-yaml, so the structural check below never skips.
 */
function findYaml(): YamlParser {
  try {
    const next = (from: string, name: string) => realpathSync(createRequire(from).resolve(`${name}/package.json`))
    const agentPreset = next(standard.packagePath, '@deepseek-ai/dsh-agent-preset')
    const registry = next(agentPreset, '@deepseek-ai/dsh-agent-preset-registry')
    return createRequire(registry)('js-yaml') as YamlParser
  } catch {
    return createRequire(join(PLUGIN, 'package.json'))('js-yaml') as YamlParser
  }
}

const yaml = findYaml()

test('the dish preset parses as YAML with its !!js tags, and its list is the standard list with the persona swapped', () => {
  const parse = (text: string): any => yaml.load(text, {
    schema: yaml.DEFAULT_SCHEMA.extend([new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: data => ({ js: data }) })]),
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
  const delegate = { id: 'dish-crew-delegate', name: 'dish-crew/delegate' }
  const control = { id: 'dish-crew-control', name: 'dish-crew/control' }
  /** The standard list as the dish preset should have it: persona swapped, delegate after it, control swapped, the four rows disabled. */
  const expect = (entries: any[]): any[] => entries.flatMap(entry => {
    if (entry.id === 'persona') return [persona, delegate]
    if (entry.id === 'tool-subagent-control') return [control]
    const copy = DISABLED_IDS.includes(entry.id) ? { ...entry, disabled: true } : entry
    return [Array.isArray(copy.config) ? { ...copy, config: expect(copy.config) } : copy]
  })
  assert.deepEqual(row.config.plugins, expect(stock[0].insert[0].config.plugins))

  /** The ids of every row, nested groups too, with `disabled: true`. */
  const disabledIds = (entries: any[]): string[] => entries.flatMap(entry => [
    ...(entry.disabled === true ? [entry.id] : []),
    ...(Array.isArray(entry.config) ? disabledIds(entry.config) : []),
  ])
  const before = disabledIds(stock[0].insert[0].config.plugins)
  assert.deepEqual(DISABLED_IDS.filter(id => before.includes(id)), [], 'the standard preset has none of the four disabled')
  assert.deepEqual(STOCK_DISABLED_IDS.filter(id => !before.includes(id)), [], 'the standard preset ships the other delegation rows disabled')
  assert.deepEqual(disabledIds(row.config.plugins).sort(), [...before, ...DISABLED_IDS].sort(), 'exactly those four are newly disabled')
  /** Every row of a delegation package, nested groups too, as `[id, disabled]`. */
  const delegationRows = (entries: any[]): [string, unknown][] => entries.flatMap(entry => [
    ...(DELEGATION_PACKAGES.includes(entry.name) ? [[entry.id, entry.disabled] as [string, unknown]] : []),
    ...(Array.isArray(entry.config) ? delegationRows(entry.config) : []),
  ])
  const delegation = delegationRows(row.config.plugins)
  assert.deepEqual(delegation.map(([id]) => id).sort(), [...DISABLED_IDS, ...STOCK_DISABLED_IDS].sort(), 'the delegation packages have exactly these rows')
  assert.deepEqual(delegation.filter(([, disabled]) => disabled !== true).map(([id]) => id), [], 'every row of a delegation package is disabled: true')
  const ids = (entries: any[]): string[] => entries.flatMap(entry => [entry.id, ...(Array.isArray(entry.config) ? ids(entry.config) : [])])
  assert.ok(ids(row.config.plugins).includes('dish-crew-control'))
  assert.ok(!ids(row.config.plugins).includes('tool-subagent-control'))
  assert.ok(ids(row.config.plugins).includes('tool-subagent-list-agents'))
  assert.ok(!disabledIds(row.config.plugins).some(id => id === 'dish-crew-control' || id === 'tool-subagent-list-agents'))
  assert.ok(row.config.plugins.some((entry: { disabled?: unknown }) => typeof entry.disabled === 'object'), 'the !!js tags came through')
})

// --- the bundles mount it ------------------------------------------------------------------------

test('the crew bundle mounts the preset, and the prompts bundle no longer ships one', () => {
  const crew = JSON.parse(readFileSync(join(PLUGIN, 'package.json'), 'utf8'))
  assert.deepEqual(crew.dsh.bundle.patch, ['./cordis.patch.yml', './presets/dish.patch.yml'])
  assert.ok(crew.files.includes('presets'), 'the preset file is published with the package')
  assert.equal(crew.scripts['sync-preset'], 'node scripts/sync-preset.mjs')
  const prompts = JSON.parse(readFileSync(join(PLUGIN, '..', 'prompts', 'package.json'), 'utf8'))
  assert.equal(prompts.dsh.bundle.patch, './cordis.patch.yml', 'two bundles inserting preset-dish would collide')
  assert.ok(!prompts.files.includes('presets'))
  assert.equal(prompts.scripts?.['sync-preset'], undefined)
})

// --- synthetic standard files -------------------------------------------------------------------

const WRAPPER = [
  '- insert:',
  '    - id: preset-dish',
  "      name: '@deepseek-ai/dsh-agent-preset'",
  '      config:',
  '        id: dish',
  '        name: dish',
  `        description: '${DESCRIPTION.replaceAll("'", "''")}'`,
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
const DELEGATE = [
  '          - id: dish-crew-delegate',
  '            name: dish-crew/delegate',
]

/** The four rows of dsh's own delegation, in the standard preset's shape (nested in a group, with their own config), and as the dish preset has them. */
/** The rows of the same machinery that dsh ships disabled, in the standard preset's shape. */
const STOCK_OFF = [
  '              - id: tool-subagent-codex',
  "                name: '@deepseek-ai/dsh-tool-subagent'",
  '                disabled: true',
  '                config:',
  '                  provider: codex',
  '              - id: tool-subagent-claude-code',
  "                name: '@deepseek-ai/dsh-tool-subagent'",
  '                disabled: true',
  '                config:',
  '                  provider: claude-code',
  '              - id: tool-ralph',
  "                name: '@deepseek-ai/dsh-tool-ralph'",
  '                disabled: true',
]
const DELEGATION = [
  '          - id: delegation',
  '            name: cordis:group',
  '            group: true',
  '            config:',
  '              - id: tool-subagent-control',
  "                name: '@deepseek-ai/dsh-tool-subagent-control'",
  '              - id: tool-subagent',
  "                name: '@deepseek-ai/dsh-tool-subagent'",
  '                config:',
  '                  provider: spawn',
  '                  modelSelectionSettings: true',
  '              - id: tool-subagent-fork',
  "                name: '@deepseek-ai/dsh-tool-subagent'",
  '                config:',
  '                  provider: fork',
  '              - id: workflow-ptc',
  "                name: '@deepseek-ai/dsh-workflow-ptc'",
  '              - id: tool-workflow',
  "                name: '@deepseek-ai/dsh-tool-workflow'",
  ...STOCK_OFF,
]
const DELEGATION_OFF = [
  '          - id: delegation',
  '            name: cordis:group',
  '            group: true',
  '            config:',
  '              - id: dish-crew-control',
  '                name: dish-crew/control',
  '              - id: tool-subagent',
  "                name: '@deepseek-ai/dsh-tool-subagent'",
  '                disabled: true',
  '                config:',
  '                  provider: spawn',
  '                  modelSelectionSettings: true',
  '              - id: tool-subagent-fork',
  "                name: '@deepseek-ai/dsh-tool-subagent'",
  '                disabled: true',
  '                config:',
  '                  provider: fork',
  '              - id: workflow-ptc',
  "                name: '@deepseek-ai/dsh-workflow-ptc'",
  '                disabled: true',
  '              - id: tool-workflow',
  "                name: '@deepseek-ai/dsh-tool-workflow'",
  '                disabled: true',
  ...STOCK_OFF,
]

/** What the generator makes, as `[header, body]`. */
function split(output: string): [string, string] {
  const at = output.indexOf('- insert:')
  assert.notEqual(at, -1)
  return [output.slice(0, at), output.slice(at)]
}

/** The list the generator makes from `list`, as the lines under the wrapper. */
function bodyOf(list: string[], listIndent = 10): string {
  return split(generate(standardOf(list, listIndent), '1.0.0'))[1]
}

test('the header says the file is generated, from which dsh-web-app version, and how to regenerate it', () => {
  const [header] = split(generate(standardOf([...BASH, ...PERSONA, ...DELEGATION]), '9.8.7-test'))
  assert.ok(header.split('\n').filter(line => line !== '').every(line => line.startsWith('#')), header)
  assert.match(header, /generated/i)
  assert.match(header, /@deepseek-ai\/dsh-web-app 9\.8\.7-test/)
  assert.ok(header.includes(SYNC), header)
})

test('a persona row first, in the middle, or last is replaced, the delegate row goes after it, and nothing else changes', () => {
  const swapped = [...DISH_PERSONA, ...DELEGATE]
  const cases: [string, string[], string[]][] = [
    ['first', [...PERSONA, ...BASH, ...GROUP, ...DELEGATION], [...swapped, ...BASH, ...GROUP, ...DELEGATION_OFF]],
    ['middle', [...BASH, ...PERSONA, ...GROUP, ...DELEGATION], [...BASH, ...swapped, ...GROUP, ...DELEGATION_OFF]],
    ['last', [...BASH, ...GROUP, ...DELEGATION, ...PERSONA], [...BASH, ...GROUP, ...DELEGATION_OFF, ...swapped]],
    ['alone', [...PERSONA, ...DELEGATION], [...swapped, ...DELEGATION_OFF]],
  ]
  for (const [where, list, expected] of cases) {
    assert.equal(bodyOf(list), [...WRAPPER, ...expected, ''].join('\n'), where)
  }
})

test('comments and blank lines inside the list stay; a comment above the next row stays with that row', () => {
  const list = [
    '          # the persona',
    ...PERSONA,
    '          # the shell',
    '',
    ...BASH,
    '          # delegation',
    ...DELEGATION,
    '          # trailing, in the list',
  ]
  assert.equal(bodyOf(list), [
    ...WRAPPER,
    '          # the persona',
    ...DISH_PERSONA,
    ...DELEGATE,
    '          # the shell',
    '',
    ...BASH,
    '          # delegation',
    ...DELEGATION_OFF,
    '          # trailing, in the list',
    '',
  ].join('\n'))
})

test('a persona row with a comment of its own inside it goes entirely', () => {
  const persona = [...PERSONA.slice(0, 3), '              # why', ...PERSONA.slice(3)]
  assert.equal(bodyOf([...BASH, ...persona, ...GROUP, ...DELEGATION]), [...WRAPPER, ...BASH, ...DISH_PERSONA, ...DELEGATE, ...GROUP, ...DELEGATION_OFF, ''].join('\n'))
})

test('a persona-looking row inside a nested group is not the persona row', () => {
  const nested = [...GROUP, '              - id: persona', "                name: '@deepseek-ai/dsh-persona'"]
  assert.equal(bodyOf([...nested, ...PERSONA, ...DELEGATION]), [...WRAPPER, ...nested, ...DISH_PERSONA, ...DELEGATE, ...DELEGATION_OFF, ''].join('\n'))
})

test('a list at another indentation lands where the wrapper expects it, keeping its shape', () => {
  assert.equal(bodyOf([...BASH, ...PERSONA, ...GROUP, ...DELEGATION], 14), [...WRAPPER, ...BASH, ...DISH_PERSONA, ...DELEGATE, ...GROUP, ...DELEGATION_OFF, ''].join('\n'))
})

test('CRLF line endings in the standard file make the same output', () => {
  const text = standardOf([...BASH, ...PERSONA, ...GROUP, ...DELEGATION])
  assert.equal(generate(text.replaceAll('\n', '\r\n'), '1.0.0'), generate(text, '1.0.0'))
})

test('a row that is already disabled has its value replaced, not a second disabled key added', () => {
  const list = DELEGATION.flatMap(line => line === "                name: '@deepseek-ai/dsh-workflow-ptc'"
    ? [line, "                disabled: !!js process.platform === 'win32'"]
    : line === "                name: '@deepseek-ai/dsh-tool-workflow'" ? [line, '                disabled: false # was on']
    : line === '                  provider: fork' ? [line, '                  disabled: false'] // a config key, not the row's
    : [line])
  const body = bodyOf([...PERSONA, ...list])
  const lines = body.split('\n')
  assert.equal(lines.filter(line => line.trim().startsWith('disabled:')).length, 8, '7 rows and one config key')
  assert.deepEqual(
    lines.filter(line => /^ {16}disabled:/.test(line)),
    Array(7).fill('                disabled: true'),
  )
  assert.ok(lines.includes('                  disabled: false'), 'a nested config key of that name is left alone')
  assert.ok(!body.includes('process.platform'))
  assert.ok(!body.includes('was on'))
  // Once the config key is set aside, the rows are as when none was disabled.
  assert.equal(body, bodyOf([...PERSONA, ...DELEGATION].flatMap(line => line === '                  provider: fork' ? [line, '                  disabled: false'] : [line])))
})

test('a standard file with no persona row, two persona rows, or no plugin list is refused', () => {
  assert.throws(() => generate(standardOf([...BASH, ...GROUP, ...DELEGATION]), '1.0.0'), /persona/)
  assert.throws(() => generate(standardOf([...PERSONA, ...BASH, ...PERSONA, ...DELEGATION]), '1.0.0'), /persona/)
  assert.throws(() => generate('- insert:\n    - id: preset-standard\n', '1.0.0'), /plugins/)
})

test('a standard file missing any of the delegation rows is refused, naming it', () => {
  for (const id of [...DISABLED_IDS, ...STOCK_DISABLED_IDS]) {
    const at = DELEGATION.findIndex(line => line.endsWith(`- id: ${id}`))
    assert.notEqual(at, -1, id)
    // The row runs to the next row of the group, or the end.
    const next = DELEGATION.findIndex((line, i) => i > at && /^ {14}- id:/.test(line))
    const without = [...DELEGATION.slice(0, at), ...(next === -1 ? [] : DELEGATION.slice(next))]
    assert.throws(() => generate(standardOf([...PERSONA, ...without]), '1.0.0'), error => error instanceof Error && error.message.includes(id), id)
  }
})

test('a delegation row listed twice, or with no name, is refused too', () => {
  const twice = [...DELEGATION, ...DELEGATION.slice(6, 8)]
  assert.throws(() => generate(standardOf([...PERSONA, ...twice]), '1.0.0'), /`tool-subagent`/)
  const nameless = DELEGATION.filter(line => line !== "                name: '@deepseek-ai/dsh-tool-workflow'")
  assert.throws(() => generate(standardOf([...PERSONA, ...nameless]), '1.0.0'), /`tool-workflow`/)
})

test('a new row of a delegation package that is not disabled is refused, naming it', () => {
  const extra = (name: string, ...tail: string[]) => ['              - id: tool-extra', `                name: ${name}`, ...tail]
  for (const pkg of DELEGATION_PACKAGES) {
    for (const [what, tail] of [
      ['enabled', []],
      ['explicitly on', ['                disabled: false']],
      ['by an expression', ["                disabled: !!js process.platform === 'win32'"]],
    ] as [string, string[]][]) {
      const list = [...PERSONA, ...DELEGATION, ...extra(`'${pkg}'`, ...tail)]
      assert.throws(() => generate(standardOf(list), '1.0.0'), error => error instanceof Error && error.message.includes('`tool-extra`') && error.message.includes(pkg), `${pkg} ${what}`)
    }
    // Quoted the other way and at the top of the list rather than in the group: still found.
    const top = extra(`"${pkg}"`).map(line => line.slice(4))
    assert.throws(() => generate(standardOf([...top, ...PERSONA, ...DELEGATION]), '1.0.0'), /`tool-extra`/, `${pkg} at the top, double-quoted`)
  }
  const sibling = ['              - id: tool-extra', "                name: '@deepseek-ai/dsh-tool-subagent'", '                config:', '                  provider: spawn']
  assert.throws(() => generate(standardOf([...PERSONA, ...DELEGATION, ...sibling]), '1.0.0'), /`tool-extra`/, 'the standard shape: a row with config')
})

test('a standard file without dsh\'s control row, or with dsh\'s send_message loaded a second time, is refused', () => {
  const at = DELEGATION.findIndex(line => line.endsWith('- id: tool-subagent-control'))
  const without = [...DELEGATION.slice(0, at), ...DELEGATION.slice(at + 2)]
  assert.throws(() => generate(standardOf([...PERSONA, ...without]), '1.0.0'), /`tool-subagent-control`/)
  // Another row of dsh's package, under any id, would register a second send_message beside dish-crew/control's.
  const again = ['              - id: tool-other-control', `                name: ${CONTROL_NAME}`]
  assert.throws(() => generate(standardOf([...PERSONA, ...DELEGATION, ...again]), '1.0.0'), /dsh-tool-subagent-control/)
  // Its list-agents subpath is another package: that row stays.
  assert.doesNotThrow(() => generate(standardOf([...PERSONA, ...DELEGATION, '              - id: tool-subagent-list-agents', "                name: '@deepseek-ai/dsh-tool-subagent-control/list-agents'"]), '1.0.0'))
})

test('a new row of a delegation package that is already disabled: true is accepted, and the control rows are not delegation rows', () => {
  const quiet = ['              - id: tool-extra', "                name: '@deepseek-ai/dsh-tool-subagent'", '                disabled: true']
  const output = bodyOf([...PERSONA, ...DELEGATION, ...quiet])
  assert.ok(output.includes([...quiet, ''].join('\n')), 'the row is left as dsh has it')
  // `dsh-tool-subagent-control` is another package, not the exact name of a delegation one.
  assert.doesNotThrow(() => generate(standardOf([...PERSONA, ...DELEGATION]), '1.0.0'))
})

// --- running the script ------------------------------------------------------------------------

interface Ran { code: number, stdout: string, stderr: string }

async function sync(args: string[], cwd?: string): Promise<Ran> {
  try {
    const { stdout, stderr } = await run(process.execPath, [SCRIPT, ...args], { cwd, env: { PATH: process.env.PATH, HOME: await tempDir() } })
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
