#!/usr/bin/env node
// Generates presets/dish.patch.yml, the dish preset, from the standard preset of
// the @deepseek-ai/dsh-web-app that the workspace's dsh resolves.
//
//   node scripts/sync-preset.mjs          write presets/dish.patch.yml
//   node scripts/sync-preset.mjs --check  exit 1 if the committed file differs from a fresh one
//   --out <file>                          write or check <file> instead
//
// The standard file's plugin list is copied line for line, so its indentation,
// comments, `!!js` tags and nested groups survive untouched. Four things change:
//   - the `persona` row becomes dish-prompts/persona;
//   - the row dish-crew/delegate follows it, so the main agent has `delegate`;
//   - the rows of dsh's own delegation (`subagent`, `subagent_fork` and the
//     workflow engine) get `disabled: true`, so the main agent delegates through
//     crew only. `send_message`, `interrupt_agent` and `list_agents` stay;
//   - the `tool-subagent-control` row becomes dish-crew/control, the same
//     `send_message` and `interrupt_agent` without dsh's mark, so dsh adds no
//     "send your result with send_message" note to a crew child's task. A row of
//     dsh's package left in stops the generator: two `send_message` tools in one
//     scope is a registration error.
// A row of any other id whose package is one of dsh's delegation packages, and
// that the preset leaves enabled, stops the generator, so a dsh upgrade can't
// slip `subagent` back in.
// The list is then wrapped in a preset row of its own.

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WORKSPACE_DIR = resolve(PLUGIN_DIR, '..', '..')
const OUTPUT = join(PLUGIN_DIR, 'presets', 'dish.patch.yml')
const WEB_APP = '@deepseek-ai/dsh-web-app'
const SYNC = 'pnpm --filter dish-crew sync-preset'

const DESCRIPTION = "The dish main agent: your prompts from Settings → Prompts, and a crew to delegate to, on the standard tool set without dsh's own delegation tools."

/**
 * The standard rows that are dsh's own delegation, which the dish preset turns off.
 *
 * `tool-subagent` is the one that matters most: its `modelSelectionSettings: true` installs `subagent` into every agent
 * on the preset, children included, where no tool filter reaches, so leaving it on would hand crew's children a way to
 * delegate around crew. `workflow-ptc` is the workflow engine's own row, and `tool-workflow` the tool on top of it.
 * The codex, claude-code and ralph rows ship disabled already; naming them keeps them off whatever dsh does with them.
 */
const DISABLED = [
  'tool-subagent',
  'tool-subagent-fork',
  'workflow-ptc',
  'tool-workflow',
  'tool-subagent-codex',
  'tool-subagent-claude-code',
  'tool-ralph',
]

/**
 * The packages whose rows give an agent a way to delegate or to run workflows around crew. In the dish preset every row
 * of one of them must be `disabled: true`, whatever its id, so a dsh upgrade that adds one, or turns one on, fails the
 * generator instead of quietly handing the main agent's children `subagent`.
 */
const DELEGATION_PACKAGES = [
  '@deepseek-ai/dsh-tool-subagent',
  '@deepseek-ai/dsh-tool-workflow',
  '@deepseek-ai/dsh-tool-ralph',
  '@deepseek-ai/dsh-workflow-ptc',
]

/** dsh's row for `send_message` and `interrupt_agent`, and the package it loads, which dish-crew/control stands in for. */
const CONTROL_ID = 'tool-subagent-control'
const CONTROL_PACKAGE = '@deepseek-ai/dsh-tool-subagent-control'

/** The `insert` row around the list, in the standard file's own shape. The list goes under `plugins:`. */
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

/** Where the list's rows start, one level under `plugins:`. */
const LIST_INDENT = 10

const indentOf = line => line.length - line.trimStart().length
const isBlank = line => line.trim() === ''
const isComment = line => line.trimStart().startsWith('#')

/**
 * Turn the row `id` off: `disabled: true` right after its `name:` line, at its key indentation. A `disabled:` the row
 * already has, at that indentation, is replaced instead, so the key is never there twice. The row may sit anywhere in
 * the list, inside a group too, but there must be exactly one.
 *
 * @param {string[]} rows the list's lines, changed in place
 * @param {string} id the row's `id`
 */
function disable(rows, id) {
  const pattern = new RegExp(`^\\s*- id:\\s*['"]?${id}['"]?\\s*(#.*)?$`)
  const found = rows.flatMap((line, i) => pattern.test(line) ? [i] : [])
  if (found.length !== 1) throw new Error(`expected one \`${id}\` row in the standard preset, found ${found.length}`)
  const start = found[0]
  const dash = indentOf(rows[start])

  // The row runs to the next line at or above its dash that isn't a comment. Its own keys sit two further in.
  let end = start + 1
  while (end < rows.length && (isBlank(rows[end]) || isComment(rows[end]) || indentOf(rows[end]) > dash)) end++
  const keys = []
  for (let i = start + 1; i < end; i++) if (!isBlank(rows[i]) && !isComment(rows[i]) && indentOf(rows[i]) === dash + 2) keys.push(i)

  const pad = ' '.repeat(dash + 2)
  const existing = keys.find(i => /^\s*disabled:/.test(rows[i]))
  if (existing !== undefined) {
    rows[existing] = `${pad}disabled: true`
    return
  }
  const name = keys.find(i => /^\s*name:/.test(rows[i]))
  if (name === undefined) throw new Error(`the \`${id}\` row in the standard preset has no \`name:\` line`)
  rows.splice(name + 1, 0, `${pad}disabled: true`)
}

/**
 * Put `replacement` (rows' lines, indented from the dash) where the row `id` was, at its dash's indentation. The row may
 * sit anywhere in the list, inside a group too, but there must be exactly one. Comments and blank lines after it, before
 * the next row, stay.
 *
 * @param {string[]} rows the list's lines, changed in place
 * @param {string} id the row's `id`
 * @param {string[]} replacement the new row's lines, the first starting `- `, with no indentation of their own
 */
function replace(rows, id, replacement) {
  const pattern = new RegExp(`^\\s*- id:\\s*['"]?${id}['"]?\\s*(#.*)?$`)
  const found = rows.flatMap((line, i) => pattern.test(line) ? [i] : [])
  if (found.length !== 1) throw new Error(`expected one \`${id}\` row in the standard preset, found ${found.length}`)
  const start = found[0]
  const dash = indentOf(rows[start])
  let end = start + 1
  while (end < rows.length && (isBlank(rows[end]) || isComment(rows[end]) || indentOf(rows[end]) > dash)) end++
  // Trailing comments and blank lines belong to what follows.
  while (end > start + 1 && (isBlank(rows[end - 1]) || isComment(rows[end - 1]))) end--
  const pad = ' '.repeat(dash)
  rows.splice(start, end - start, ...replacement.map(line => pad + line))
}

/**
 * Refuse a row that loads dsh's own `send_message` (`tool-subagent-control`, whatever its id). dish-crew/control registers
 * a `send_message` of its own in the same scope, and two of one name there is a registration error. Its `list-agents`
 * subpath is another package name, so the `list_agents` row stays.
 *
 * @param {string[]} rows the list's lines
 * @throws {Error} naming the first such line
 */
function refuseDshControl(rows) {
  for (let i = 0; i < rows.length; i++) {
    const named = /^\s*(- )?name:\s*(['"]?)([^'"\s#]+)\2\s*(#.*)?$/.exec(rows[i])
    if (named !== null && named[3] === CONTROL_PACKAGE) {
      throw new Error(`line ${i + 1} of the dish preset's list loads ${CONTROL_PACKAGE}, whose \`send_message\` dish-crew/control replaces: two in one scope is a registration error. Find the row that brings it in.`)
    }
  }
}

/**
 * Refuse a row of a delegation package that is not literally `disabled: true`.
 *
 * Rows named in DISABLED have just been turned off, so this catches the others: a row dsh added under a new id, or one
 * it ships enabled that nobody listed.
 *
 * @param {string[]} rows the list's lines
 * @throws {Error} naming the first such row
 */
function refuseEnabledDelegation(rows) {
  for (let i = 0; i < rows.length; i++) {
    const named = /^(\s*)(- )?name:\s*(['"]?)([^'"\s#]+)\3\s*(#.*)?$/.exec(rows[i])
    if (named === null || !DELEGATION_PACKAGES.includes(named[4])) continue

    // The row this name belongs to: its `- ` line is the name line itself, or the nearest line above it one level out.
    const keyIndent = named[2] === undefined ? indentOf(rows[i]) : indentOf(rows[i]) + 2
    let start = i
    if (named[2] === undefined) {
      start = -1
      for (let j = i - 1; j >= 0; j--) {
        if (isBlank(rows[j]) || isComment(rows[j]) || indentOf(rows[j]) >= keyIndent) continue
        if (indentOf(rows[j]) === keyIndent - 2 && rows[j].trimStart().startsWith('- ')) start = j
        break
      }
    }
    if (start === -1) throw new Error(`could not find the row that \`${named[4]}\` belongs to, line ${i + 1} of the standard preset's list`)
    const dash = indentOf(rows[start])
    let end = start + 1
    while (end < rows.length && (isBlank(rows[end]) || isComment(rows[end]) || indentOf(rows[end]) > dash)) end++

    const own = []
    for (let j = start; j < end; j++) if (!isBlank(rows[j]) && !isComment(rows[j])) own.push(j)
    const at = key => own.find(j => new RegExp(`^\\s*(- )?${key}:`).test(rows[j]) && indentOf(rows[j]) + (rows[j].trimStart().startsWith('- ') ? 2 : 0) === keyIndent)
    const id = at('id') === undefined ? undefined : rows[at('id')].replace(/^\s*(- )?id:\s*/, '').replace(/\s*#.*$/, '').replace(/^(['"])(.*)\1$/, '$2')
    const off = at('disabled')
    if (off !== undefined && /^\s*(- )?disabled:\s*true\s*(#.*)?$/.test(rows[off])) continue
    throw new Error(`the \`${id ?? named[4]}\` row (${named[4]}) of the standard preset is not disabled in the dish preset, so the main agent's children would get dsh's own delegation. Add its id to DISABLED in scripts/sync-preset.mjs, or leave it out of the preset on purpose.`)
  }
}

/**
 * The dish preset's patch file, made from the text of dsh-web-app's standard
 * preset.
 *
 * @param {string} standardText the contents of `presets/standard.patch.yml`
 * @param {string} version the dsh-web-app version it came from, for the header
 * @returns {string}
 */
export function generate(standardText, version) {
  const lines = standardText.replace(/\r\n?/g, '\n').split('\n')

  // The list: everything under `plugins:` that is indented deeper than it. A
  // comment or blank line belongs to the list only when more list follows it.
  const key = lines.findIndex(line => /^\s*plugins:\s*$/.test(line))
  if (key === -1) throw new Error('no `plugins:` list in the standard preset')
  let end = key + 1
  for (let i = key + 1; i < lines.length; i++) {
    if (isBlank(lines[i])) continue
    if (indentOf(lines[i]) > indentOf(lines[key])) end = i + 1
    else if (!isComment(lines[i])) break
  }
  const list = lines.slice(key + 1, end)

  const first = list.find(line => !isBlank(line) && !isComment(line))
  if (first === undefined || !/^\s*- /.test(first)) throw new Error('the standard preset\'s `plugins:` list has no rows')
  const entry = indentOf(first)

  // The persona row runs from its `- id: persona` line to the next row at the
  // same indentation. Comments and blank lines just above that next row belong
  // to it, not to the persona row.
  const starts = list.flatMap((line, i) => indentOf(line) === entry && line.trimStart().startsWith('- ') ? [i] : [])
  const personas = starts.filter(i => /^\s*- id:\s*['"]?persona['"]?\s*(#.*)?$/.test(list[i]))
  if (personas.length !== 1) throw new Error(`expected one \`persona\` row in the standard preset, found ${personas.length}`)
  const start = personas[0]
  let last = (starts.find(i => i > start) ?? list.length) - 1
  while (last > start && (isBlank(list[last]) || isComment(list[last]) && indentOf(list[last]) <= entry)) last--

  const pad = ' '.repeat(entry)
  const persona = [
    `${pad}- id: dish-persona`,
    `${pad}  name: dish-prompts/persona`,
    `${pad}  config:`,
    `${pad}    role: main`,
  ]
  const delegate = [
    `${pad}- id: dish-crew-delegate`,
    `${pad}  name: dish-crew/delegate`,
  ]
  const rows = [...list.slice(0, start), ...persona, ...delegate, ...list.slice(last + 1)]
  for (const id of DISABLED) disable(rows, id)
  refuseEnabledDelegation(rows)
  replace(rows, CONTROL_ID, ['- id: dish-crew-control', '  name: dish-crew/control'])
  refuseDshControl(rows)

  // Under the wrapper the rows sit at LIST_INDENT. They already do, unless dsh
  // reshaped its file; then every line moves by the same amount.
  const shift = LIST_INDENT - entry
  const placed = shift === 0 ? rows : rows.map(line => {
    if (isBlank(line)) return line
    return shift > 0 ? ' '.repeat(shift) + line : line.slice(Math.min(-shift, indentOf(line)))
  })

  const header = [
    `# GENERATED by scripts/sync-preset.mjs from ${WEB_APP} ${version}`,
    '# (presets/standard.patch.yml). Do not edit it by hand: the next run replaces',
    '# it, and the drift test fails until the committed file matches.',
    '#',
    "# The dish preset: the standard preset's plugin list, with four changes:",
    '#   - its `persona` row is replaced by dish-prompts/persona, so the main',
    "#     agent's prompts come from Settings → Prompts;",
    '#   - dish-crew/delegate follows it, which gives the main agent `delegate`;',
    "#   - dsh's own delegation (`subagent`, `subagent_fork` and the workflow",
    '#     engine) is disabled, so the main agent delegates through crew only.',
    '#     `send_message`, `interrupt_agent` and `list_agents` stay;',
    "#   - dsh's `tool-subagent-control` row is replaced by dish-crew/control:",
    "#     the same `send_message` and `interrupt_agent`, without dsh's mark, so",
    '#     dsh adds no "send your result with send_message" note to a crew',
    "#     child's task.",
    '# Edits saved from Settings → Agent presets live in your profile and override',
    "# this row's `config.plugins` there.",
    '#',
    '# After a dsh upgrade, regenerate it:',
    `#   ${SYNC}`,
  ]
  return [...header, ...WRAPPER, ...placed, ''].join('\n')
}

/**
 * The standard preset as the dsh-web-app that dsh itself resolves ships it.
 *
 * At runtime dsh finds its web-app bundle from its own installation, so that is
 * the copy to follow: found through the workspace's `@deepseek-ai/dsh`, not
 * through anything this package pins. A dsh upgrade then moves the standard
 * preset, and the drift check sees it.
 *
 * @returns {{ text: string, version: string, path: string, packagePath: string }}
 */
export function readStandard() {
  const dsh = createRequire(join(WORKSPACE_DIR, 'package.json')).resolve('@deepseek-ai/dsh/package.json')
  const packagePath = createRequire(dsh).resolve(`${WEB_APP}/package.json`)
  const path = join(dirname(packagePath), 'presets', 'standard.patch.yml')
  const { version } = JSON.parse(readFileSync(packagePath, 'utf8'))
  return { text: readFileSync(path, 'utf8'), version, path, packagePath }
}

/** The command line. Returns the exit code. */
function main(args) {
  let check = false
  let out = OUTPUT
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--check') check = true
    else if (args[i] === '--out' && args[i + 1] !== undefined) out = resolve(args[++i])
    else {
      console.error(`sync-preset: unexpected argument ${args[i]}\nusage: sync-preset [--check] [--out <file>]`)
      return 2
    }
  }

  const { text, version } = readStandard()
  const fresh = generate(text, version)

  if (check) {
    let committed
    try {
      committed = readFileSync(out, 'utf8')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    if (committed === fresh) return 0
    console.error(`${out} ${committed === undefined ? 'is missing' : `differs from the standard preset of ${WEB_APP} ${version}`}.\nRun \`${SYNC}\` and commit the result.`)
    return 1
  }

  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, fresh)
  console.log(`wrote ${out} from ${WEB_APP} ${version}`)
  return 0
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2))
}
