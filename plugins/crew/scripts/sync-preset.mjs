#!/usr/bin/env node
// Generates presets/dish.patch.yml, the dish preset, from the standard preset of
// the @deepseek-ai/dsh-web-app that the workspace's dsh resolves.
//
//   node scripts/sync-preset.mjs          write presets/dish.patch.yml
//   node scripts/sync-preset.mjs --check  exit 1 if the committed file differs from a fresh one
//   --out <file>                          write or check <file> instead
//
// The standard file's plugin list is copied line for line, so its indentation,
// comments, `!!js` tags and nested groups survive untouched. Three things change:
//   - the `persona` row becomes dish-prompts/persona;
//   - the row dish-crew/delegate follows it, so the main agent has `delegate`;
//   - the rows of dsh's own delegation (`subagent`, `subagent_fork` and the
//     workflow engine) get `disabled: true`, so the main agent delegates through
//     crew only. `send_message`, `interrupt_agent` and `list_agents` stay.
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
 */
const DISABLED = ['tool-subagent', 'tool-subagent-fork', 'workflow-ptc', 'tool-workflow']

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
    "# The dish preset: the standard preset's plugin list, with three changes:",
    '#   - its `persona` row is replaced by dish-prompts/persona, so the main',
    "#     agent's prompts come from Settings → Prompts;",
    '#   - dish-crew/delegate follows it, which gives the main agent `delegate`;',
    "#   - dsh's own delegation (`subagent`, `subagent_fork` and the workflow",
    '#     engine) is disabled, so the main agent delegates through crew only.',
    '#     `send_message`, `interrupt_agent` and `list_agents` stay.',
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
