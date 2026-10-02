/**
 * Writes dish's rows into a dsh profile's own patch file (`$DSH_HOME/profiles/<profile>/cordis.patch.yml`):
 *
 * - the `dish-config` row: `remote`, `userName` and `userEmail` on its config, and nothing else;
 * - the `agent-preset-registry` row: `{ default, selectedDefault: <preset> }`, the same write the UI's "Set as new task
 *   default" makes. A patch replaces a row's whole `config`, and `default` is required, so it is always restated: the
 *   row's own `default` when it has one, else `standard`.
 *
 * Everything else in the file stays as it is: other rows, comments, key order and `!!js` tags. That is the reason for
 * the `yaml` Document API, and for parsing the `!!js` tag the way dsh's config editor does. A row that is already right
 * is not touched, so an unchanged result is the input itself, byte for byte, and the CLI does not write.
 *
 * The file is written the way dsh's config editor writes it: a sibling temp file with mode 0600, renamed over the target.
 * Rows are matched the way that editor matches them too: the last row with the id, no `insert` key, and no `name` or
 * the same `name`.
 *
 *   node deploy/profile.ts --patch <path> --remote <url> --user-name <name> --user-email <email> [--preset dish]
 *
 * Prints `unchanged` or `updated` and exits 0. A file that cannot be read, or is not a YAML sequence of rows, exits
 * non-zero and is not written.
 */

import { randomBytes } from 'node:crypto'
import { chmod, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { isMap, isScalar, isSeq, parseDocument } from 'yaml'
import type { Document, ParsedNode, YAMLMap, YAMLSeq } from 'yaml'

/** The `dish-config` row: plugins/config/cordis.patch.yml inserts it with this id and name. */
export const CONFIG_ROW_ID = 'dish-config'
export const CONFIG_ROW_NAME = 'dish-config'
/** The row the UI's "Set as new task default" writes. */
export const PRESET_ROW_ID = 'agent-preset-registry'
export const PRESET_ROW_NAME = '@deepseek-ai/dsh-agent-preset-registry'
/** The registry's `default`, when the row has none to keep. */
export const FALLBACK_DEFAULT = 'standard'
/** The dish preset's id. */
export const DEFAULT_PRESET = 'dish'

export interface DishRowsOptions {
  /** The store's git remote, set on the `dish-config` row. */
  remote: string
  userName: string
  userEmail: string
  /** The preset id made the default for new tasks. Defaults to `dish`. */
  preset?: string
}

export type Outcome = 'unchanged' | 'updated'

/** dsh reads `!!js` as a scalar expression. Parsing it the way dsh's config editor does keeps the tag when we print. */
const JS_TAG = { tag: 'tag:yaml.org,2002:js', resolve: (value: string): string => value }

type Doc = Document.Parsed<ParsedNode, true>

function parse(text: string): Doc {
  const doc = parseDocument(text, { customTags: [JS_TAG] })
  if (doc.errors[0] !== undefined) throw doc.errors[0]
  return doc
}

/** `value` when it is a usable single-line string. */
function requireLine(name: string, value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} must be a non-empty string`)
  if (/[\p{Cc}\u2028\u2029]/u.test(value)) throw new Error(`${name} must be a single line`)
  return value
}

/** The options, checked, with the preset's default filled in. */
function normalize(options: DishRowsOptions): Required<DishRowsOptions> {
  return {
    remote: requireLine('remote', options.remote),
    userName: requireLine('userName', options.userName),
    userEmail: requireLine('userEmail', options.userEmail),
    preset: requireLine('preset', options.preset ?? DEFAULT_PRESET),
  }
}

/** The last row with this id, as dsh's config editor finds it. */
function findRow(seq: YAMLSeq, id: string, name: string): YAMLMap | undefined {
  for (let index = seq.items.length - 1; index >= 0; index--) {
    const item = seq.items[index]
    if (!isMap(item) || item.get('id') !== id || item.has('insert')) continue
    if (item.has('name') && item.get('name') !== name) continue
    return item
  }
  return undefined
}

/** Whether a value is a scalar holding a non-empty string. */
function hasText(node: unknown): boolean {
  return isScalar(node) && typeof node.value === 'string' && node.value !== ''
}

/** Edits one document and remembers whether anything changed. */
class Editor {
  changed = false
  readonly doc: Doc

  constructor(doc: Doc) {
    this.doc = doc
  }

  /** The row's `config` mapping, made when there is none. */
  config(row: YAMLMap, id: string): YAMLMap {
    const config = row.get('config', true)
    if (isMap(config)) return config
    if (config !== undefined && !(isScalar(config) && config.value === null)) {
      throw new Error(`the ${id} row's config is not a mapping`)
    }
    const made = this.doc.createNode({})
    row.set('config', made)
    this.changed = true
    return made
  }

  /** Set `key` to the string `value`. A plain string value keeps its quoting and comments. */
  set(map: YAMLMap, key: string, value: string): void {
    const previous = map.get(key, true)
    if (isScalar(previous) && previous.tag === undefined && typeof previous.value === 'string') {
      if (previous.value === value) return
      previous.value = value
    } else {
      if (map.items.length === 0) map.flow = false
      map.set(key, this.doc.createNode(value))
    }
    this.changed = true
  }

  /** Add a whole row at the end of the sequence. */
  append(seq: YAMLSeq, row: Record<string, unknown>): void {
    seq.flow = false
    seq.add(this.doc.createNode(row))
    this.changed = true
  }
}

/**
 * Return `text` with dish's rows in place.
 * @param text The patch file's current content: empty when there is no file, or a YAML sequence of loader patch rows.
 * @returns The new content, which is `text` itself when nothing needed to change.
 * @throws When `text` is not valid YAML, or is not a sequence, or a dish row has a config that is not a mapping.
 */
export function writeDishRows(text: string, options: DishRowsOptions): string {
  const { remote, userName, userEmail, preset } = normalize(options)
  const doc = parse(text)
  const editor = new Editor(doc)

  // An empty file, or one with only comments (what dsh creates), is an empty list. Its comments stay.
  let seq = doc.contents as unknown
  if (seq === null || (isScalar(seq) && seq.value === null)) {
    seq = doc.createNode([])
    doc.contents = seq as ParsedNode
  }
  if (!isSeq(seq)) throw new Error('profile patch must be a YAML sequence')

  const configRow = findRow(seq, CONFIG_ROW_ID, CONFIG_ROW_NAME)
  if (configRow === undefined) {
    editor.append(seq, { id: CONFIG_ROW_ID, name: CONFIG_ROW_NAME, config: { remote, userName, userEmail } })
  } else {
    const config = editor.config(configRow, CONFIG_ROW_ID)
    editor.set(config, 'remote', remote)
    editor.set(config, 'userName', userName)
    editor.set(config, 'userEmail', userEmail)
  }

  const presetRow = findRow(seq, PRESET_ROW_ID, PRESET_ROW_NAME)
  if (presetRow === undefined) {
    editor.append(seq, {
      id: PRESET_ROW_ID, name: PRESET_ROW_NAME, config: { default: FALLBACK_DEFAULT, selectedDefault: preset },
    })
  } else {
    const config = editor.config(presetRow, PRESET_ROW_ID)
    if (!hasText(config.get('default', true))) editor.set(config, 'default', FALLBACK_DEFAULT)
    editor.set(config, 'selectedDefault', preset)
  }

  return editor.changed ? String(doc) : text
}

/** Replace `path` with `content` in one step, as dsh's config editor does: a sibling temp file with mode 0600. */
async function writeFileAtomic(path: string, content: string): Promise<void> {
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(temp, content, { mode: 0o600, flag: 'wx' })
    await chmod(temp, 0o600) // the umask can only narrow `mode`, so set it outright
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

/** Write dish's rows into the patch file at `path`: created when missing, left alone when nothing changes. */
export async function updatePatchFile(path: string, options: DishRowsOptions): Promise<Outcome> {
  let before = ''
  try {
    before = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const after = writeDishRows(before, options)
  if (after === before) return 'unchanged'
  await writeFileAtomic(path, after)
  return 'updated'
}

const USAGE = 'usage: node deploy/profile.ts --patch <path> --remote <url> --user-name <name> --user-email <email> [--preset dish]'

/** The CLI. Returns the exit code: 0 done, 1 the file could not be read or written, 2 the arguments are wrong. */
export async function main(argv: string[]): Promise<number> {
  let values
  try {
    ({ values } = parseArgs({
      args: argv,
      allowPositionals: false,
      options: {
        patch: { type: 'string' },
        remote: { type: 'string' },
        'user-name': { type: 'string' },
        'user-email': { type: 'string' },
        preset: { type: 'string' },
      },
    }))
    for (const name of ['patch', 'remote', 'user-name', 'user-email'] as const) {
      if (values[name] === undefined) throw new Error(`--${name} is required`)
    }
  } catch (error) {
    console.error(`profile.ts: ${(error as Error).message}\n${USAGE}`)
    return 2
  }
  const options: DishRowsOptions = {
    remote: values.remote as string,
    userName: values['user-name'] as string,
    userEmail: values['user-email'] as string,
    ...values.preset === undefined ? {} : { preset: values.preset },
  }
  try {
    normalize(options)
  } catch (error) {
    console.error(`profile.ts: ${(error as Error).message}\n${USAGE}`)
    return 2
  }
  try {
    console.log(await updatePatchFile(values.patch as string, options))
    return 0
  } catch (error) {
    console.error(`profile.ts: ${values.patch}: ${(error as Error).message}`)
    return 1
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2))
