/**
 * Writes dish's rows into a dsh profile's own patch file (`$DSH_HOME/profiles/<profile>/cordis.patch.yml`):
 *
 * - the `dish-config` row: `remote`, `userName` and `userEmail` on its config, and nothing else;
 * - the `agent-preset-registry` row, on the first install only: `{ default, selectedDefault: <preset> }`, the same write
 *   the UI's "Set as new task default" makes. A patch replaces a row's whole `config`, and `default` is required, so it
 *   is restated: the row's own `default` when it has one, else `standard`. A row that already has a `selectedDefault`,
 *   whatever its value, is a choice (made in the UI, or by hand) and is left exactly as it is, `default` included. So
 *   `--preset` is the default to set when none is chosen yet, and a later run never resets it.
 *
 * Everything else in the file stays as it is: other rows, comments, key order and `!!js` tags. That is the reason for
 * the `yaml` Document API, and for parsing the `!!js` tag the way dsh's config editor does. A row that is already right
 * is not touched, so an unchanged result is the input itself, byte for byte, and the CLI does not write.
 *
 * The file is written the way dsh's config editor writes it: a sibling temp file with mode 0600, renamed over the target.
 * Rows are matched the way that editor matches them too: the last row with the id, no `insert` key, and no `name` or
 * the same `name`.
 *
 *   node deploy/profile.ts --patch <path> (--remote <url> | --no-remote) --user-name <name> --user-email <email> [--preset dish]
 *
 * `--preset` is the default preset to set when none is chosen yet (default `dish`); a default already chosen is kept.
 *
 * Prints `unchanged` or `updated` and exits 0. A file that cannot be read, or is not a YAML sequence of rows, exits
 * non-zero and is not written.
 */

import { randomBytes } from 'node:crypto'
import { chmod, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { isCollection, isMap, isScalar, isSeq, parseDocument } from 'yaml'
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
  /** The store's git remote, set on the `dish-config` row. `''` keeps the store local (the schema's default). */
  remote: string
  userName: string
  userEmail: string
  /** The preset id made the default for new tasks when none is chosen yet. Defaults to `dish`. A chosen one is kept. */
  preset?: string
}

export type Outcome = 'unchanged' | 'updated'

/** dsh reads `!!js` as a scalar expression. Parsing it the way dsh's config editor does keeps the tag when we print. */
const JS_TAG = { tag: 'tag:yaml.org,2002:js', resolve: (value: string): string => value }

type Doc = Document.Parsed<ParsedNode, true>

function parse(text: string): Doc {
  const doc = parseDocument(text, { customTags: [JS_TAG] })
  // Only the message and position: yaml's pretty error quotes the file's lines, and this output reaches Ansible's log.
  if (doc.errors[0] !== undefined) throw new Error(doc.errors[0].message.split('\n')[0]!.replace(/:$/, ''))
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
    remote: options.remote === '' ? '' : requireLine('remote', options.remote),
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

/** Refuse to change a node that carries an anchor: an alias elsewhere in the file would change with it. */
function unshared(...nodes: unknown[]): void {
  for (const node of nodes) {
    if ((isScalar(node) || isCollection(node)) && node.anchor !== undefined) throw new Error(`&${node.anchor} covers a value dish writes; another row may alias it, so edit it by hand`)
  }
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
    unshared(row, config)
    const made = this.doc.createNode({})
    row.set('config', made)
    this.changed = true
    return made
  }

  /** Set `key` to the string `value`. A plain string value keeps its quoting and comments. */
  set(row: YAMLMap, map: YAMLMap, key: string, value: string): void {
    const previous = map.get(key, true)
    if (isScalar(previous) && previous.tag === undefined && typeof previous.value === 'string' && previous.value === value) return
    unshared(row, map, previous)
    if (isScalar(previous) && previous.tag === undefined && typeof previous.value === 'string') {
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
    editor.set(configRow, config, 'remote', remote)
    editor.set(configRow, config, 'userName', userName)
    editor.set(configRow, config, 'userEmail', userEmail)
  }

  const presetRow = findRow(seq, PRESET_ROW_ID, PRESET_ROW_NAME)
  if (presetRow === undefined) {
    editor.append(seq, {
      id: PRESET_ROW_ID, name: PRESET_ROW_NAME, config: { default: FALLBACK_DEFAULT, selectedDefault: preset },
    })
  } else {
    const config = editor.config(presetRow, PRESET_ROW_ID)
    // A `selectedDefault` is a choice, whoever made it, and what it holds is not ours to judge. Nor is the `default`
    // that goes with it. dish only fills in a row that has none yet.
    if (!config.has('selectedDefault')) {
      if (!hasText(config.get('default', true))) editor.set(presetRow, config, 'default', FALLBACK_DEFAULT)
      editor.set(presetRow, config, 'selectedDefault', preset)
    }
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

const USAGE = [
  'usage: node deploy/profile.ts --patch <path> (--remote <url> | --no-remote) --user-name <name> --user-email <email> [--preset dish]',
  '  --preset  the default preset to set when none is chosen yet (default dish); a default already chosen is kept',
].join('\n')

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
        'no-remote': { type: 'boolean' },
        'user-name': { type: 'string' },
        'user-email': { type: 'string' },
        preset: { type: 'string' },
      },
    }))
    for (const name of ['patch', 'user-name', 'user-email'] as const) {
      if (values[name] === undefined) throw new Error(`--${name} is required`)
    }
    // `--no-remote` says on purpose what an empty `--remote "$UNSET"` would say by accident.
    if ((values.remote === undefined) === (values['no-remote'] !== true)) throw new Error('give one of --remote or --no-remote')
    if (values.remote === '') throw new Error('--remote must not be empty; use --no-remote to keep the store local')
  } catch (error) {
    console.error(`profile.ts: ${(error as Error).message}\n${USAGE}`)
    return 2
  }
  const options: DishRowsOptions = {
    remote: values['no-remote'] === true ? '' : values.remote as string,
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
