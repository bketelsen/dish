/**
 * Writes dish's rows into a dsh profile's own patch file (`$DSH_HOME/profiles/<profile>/cordis.patch.yml`):
 *
 * - the `dish-config` row: `remote`, `userName` and `userEmail` on its config, and nothing else;
 * - the `agent-preset-registry` row, on the first install only: `{ default, selectedDefault: <preset> }`, the same write
 *   the UI's "Set as new task default" makes. A patch replaces a row's whole `config`, and `default` is required, so it
 *   is restated: the row's own `default` when it has one, else `standard`. A row that already has a `selectedDefault`,
 *   whatever its value, is a choice (made in the UI, or by hand) and is left exactly as it is, `default` included. So
 *   `--preset` is the default to set when none is chosen yet, and a later run never resets it;
 * - the `sandbox` row (`@deepseek-ai/dsh-sandbox-local`), with `--sandbox-runner <path>`: `runnerCommand: [<path>]` and
 *   `runnerFailureSignatures: ['bwrap: ', 'dish-sandbox: ']` on its config, so that dsh runs every sandboxed command
 *   through `deploy/dish-sandbox` (docs/specs/sandbox-home.md). `--protect <path>` pairs added after the path by hand
 *   are kept. `--no-sandbox-runner` takes those two keys away again, and the row with them when nothing else is left in
 *   it. With neither, the row is left as it is. Its other keys are kept either way.
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
 *     [--sandbox-runner <absolute path> | --no-sandbox-runner]
 *   node deploy/profile.ts --patch <path> (--sandbox-runner <absolute path> | --no-sandbox-runner)
 *
 * `--preset` is the default preset to set when none is chosen yet (default `dish`); a default already chosen is kept.
 * The second form writes the sandbox row alone: `--no-sandbox-runner` so is the step before a rollback past the
 * runner, whose row would otherwise name a script the older checkout doesn't have.
 *
 * Prints `unchanged` or `updated` and exits 0. A file that cannot be read, or is not a YAML sequence of rows, exits
 * non-zero and is not written.
 */

import { randomBytes } from 'node:crypto'
import { chmod, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
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
/** The row dsh-base mounts its sandbox provider with. Its `runnerCommand` hook is how dish gives the sandbox a home. */
export const SANDBOX_ROW_ID = 'sandbox'
export const SANDBOX_ROW_NAME = '@deepseek-ai/dsh-sandbox-local'
/** What bwrap and deploy/dish-sandbox print when they fail themselves: dsh then reports a command that did not run. */
export const RUNNER_FAILURE_SIGNATURES: readonly string[] = ['bwrap: ', 'dish-sandbox: ']
/** The keys of the `sandbox` row's config that are dish's. */
const RUNNER_KEYS = ['runnerCommand', 'runnerFailureSignatures'] as const

export interface DishRowsOptions {
  /** The store's git remote, set on the `dish-config` row. `''` keeps the store local (the schema's default). */
  remote: string
  userName: string
  userEmail: string
  /** The preset id made the default for new tasks when none is chosen yet. Defaults to `dish`. A chosen one is kept. */
  preset?: string
  /**
   * The sandbox runner: an absolute path sets the `sandbox` row's `runnerCommand` to it, `null` takes dish's keys off
   * that row, and `undefined` (the default) leaves the row alone.
   */
  sandboxRunner?: string | null
}

type Normalized = Required<Omit<DishRowsOptions, 'sandboxRunner'>> & Pick<DishRowsOptions, 'sandboxRunner'>

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

/** A runner path, checked: one line, absolute. */
function checkRunner(runner: string): void {
  if (!isAbsolute(requireLine('sandboxRunner', runner))) throw new Error('sandboxRunner must be an absolute path')
}

/** The options, checked, with the preset's default filled in. */
function normalize(options: DishRowsOptions): Normalized {
  const runner = options.sandboxRunner
  if (typeof runner === 'string') checkRunner(runner)
  return {
    remote: options.remote === '' ? '' : requireLine('remote', options.remote),
    userName: requireLine('userName', options.userName),
    userEmail: requireLine('userEmail', options.userEmail),
    preset: requireLine('preset', options.preset ?? DEFAULT_PRESET),
    ...runner === undefined ? {} : { sandboxRunner: runner },
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

  /** Set `key` to a list of plain strings. A list that already holds exactly these is left as it is. */
  setList(row: YAMLMap, map: YAMLMap, key: string, values: readonly string[]): void {
    const previous = map.get(key, true)
    const same = isSeq(previous) && previous.items.length === values.length &&
      previous.items.every((item, index) => isScalar(item) && item.tag === undefined && item.value === values[index])
    if (same) return
    unshared(row, map, previous)
    if (map.items.length === 0) map.flow = false
    map.set(key, this.doc.createNode([...values]))
    this.changed = true
  }

  /** Take `keys` off `map`, when it has them. */
  remove(row: YAMLMap, map: YAMLMap, keys: readonly string[]): void {
    for (const key of keys) {
      if (!map.has(key)) continue
      unshared(row, map, map.get(key, true))
      map.delete(key)
      this.changed = true
    }
  }

  /** Take a whole row out of the sequence. */
  drop(seq: YAMLSeq, row: YAMLMap): void {
    unshared(row)
    seq.items.splice(seq.items.indexOf(row), 1)
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
 * The `--protect <path>` pairs after the runner in a `runnerCommand` list: added to the row by hand, they add to
 * dish-sandbox's protected list, and a later install keeps them. Anything else after the runner is dropped with it.
 */
function protectPairs(node: unknown): string[] {
  if (!isSeq(node)) return []
  const rest = node.items.slice(1).map((item) => isScalar(item) && item.tag === undefined && typeof item.value === 'string' ? item.value : undefined)
  const pairs = rest.length % 2 === 0 && rest.every((value, index) => value !== undefined && (index % 2 === 1 || value === '--protect'))
  return pairs ? rest as string[] : []
}

/** Whether a row holds nothing but its id, its name and an empty (or no) config. */
function emptyRow(row: YAMLMap): boolean {
  const config = row.get('config', true)
  const emptyConfig = config === undefined || (isScalar(config) && config.value === null) || (isMap(config) && config.items.length === 0)
  return emptyConfig && row.items.every((pair) => isScalar(pair.key) && ['id', 'name', 'config'].includes(String(pair.key.value)))
}

/** Parse `text`, hand its sequence of rows to `edit`, and return the new text, or `text` itself when nothing changed. */
function editRows(text: string, edit: (editor: Editor, seq: YAMLSeq) => void): string {
  const doc = parse(text)
  const editor = new Editor(doc)

  // An empty file, or one with only comments (what dsh creates), is an empty list. Its comments stay.
  let seq = doc.contents as unknown
  if (seq === null || (isScalar(seq) && seq.value === null)) {
    seq = doc.createNode([])
    doc.contents = seq as ParsedNode
  }
  if (!isSeq(seq)) throw new Error('profile patch must be a YAML sequence')
  edit(editor, seq)
  return editor.changed ? String(doc) : text
}

/** The sandbox row: dish's runner set (a path), or taken off again (`null`). */
function editSandboxRow(editor: Editor, seq: YAMLSeq, sandboxRunner: string | null): void {
  const sandboxRow = findRow(seq, SANDBOX_ROW_ID, SANDBOX_ROW_NAME)
  if (sandboxRunner === null) {
    // Only dish's keys go. A row that held nothing else goes with them; one with more (a probeTimeoutMs set by hand)
    // keeps the rest.
    const config = sandboxRow?.get('config', true)
    if (sandboxRow !== undefined && isMap(config)) {
      editor.remove(sandboxRow, config, RUNNER_KEYS)
      if (emptyRow(sandboxRow)) editor.drop(seq, sandboxRow)
    }
  } else if (sandboxRow === undefined) {
    editor.append(seq, {
      id: SANDBOX_ROW_ID,
      name: SANDBOX_ROW_NAME,
      config: { runnerCommand: [sandboxRunner], runnerFailureSignatures: [...RUNNER_FAILURE_SIGNATURES] },
    })
  } else {
    const config = editor.config(sandboxRow, SANDBOX_ROW_ID)
    editor.setList(sandboxRow, config, 'runnerCommand', [sandboxRunner, ...protectPairs(config.get('runnerCommand', true))])
    editor.setList(sandboxRow, config, 'runnerFailureSignatures', RUNNER_FAILURE_SIGNATURES)
  }
}

/**
 * Return `text` with dish's rows in place.
 * @param text The patch file's current content: empty when there is no file, or a YAML sequence of loader patch rows.
 * @returns The new content, which is `text` itself when nothing needed to change.
 * @throws When `text` is not valid YAML, or is not a sequence, or a dish row has a config that is not a mapping.
 */
export function writeDishRows(text: string, options: DishRowsOptions): string {
  const { remote, userName, userEmail, preset, sandboxRunner } = normalize(options)
  return editRows(text, (editor, seq) => {
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

    if (sandboxRunner !== undefined) editSandboxRow(editor, seq, sandboxRunner)
  })
}

/**
 * Return `text` with the sandbox row alone written: dish's runner set, or (`null`) taken off. The other rows stay.
 * @throws As {@link writeDishRows}, and when the runner is not an absolute single-line path.
 */
export function writeSandboxRow(text: string, sandboxRunner: string | null): string {
  if (sandboxRunner !== null) checkRunner(sandboxRunner)
  return editRows(text, (editor, seq) => editSandboxRow(editor, seq, sandboxRunner))
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

/**
 * Write dish's rows into the patch file at `path`: created when missing, left alone when nothing changes. Options with
 * no dish-config inputs (only `sandboxRunner`) write the sandbox row alone.
 */
export async function updatePatchFile(path: string, options: DishRowsOptions | { sandboxRunner: string | null }): Promise<Outcome> {
  let before = ''
  try {
    before = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const after = 'userName' in options ? writeDishRows(before, options) : writeSandboxRow(before, options.sandboxRunner)
  if (after === before) return 'unchanged'
  await writeFileAtomic(path, after)
  return 'updated'
}

const USAGE = [
  'usage: node deploy/profile.ts --patch <path> (--remote <url> | --no-remote) --user-name <name> --user-email <email> [--preset dish]',
  '         [--sandbox-runner <absolute path> | --no-sandbox-runner]',
  '       node deploy/profile.ts --patch <path> (--sandbox-runner <absolute path> | --no-sandbox-runner)',
  '  --preset             the default preset to set when none is chosen yet (default dish); a default already chosen is kept',
  '  --sandbox-runner     run sandboxed commands through this runner (deploy/dish-sandbox): the sandbox row\'s runnerCommand',
  '  --no-sandbox-runner  take dish\'s runner off the sandbox row; with neither, the row is left as it is',
].join('\n')

/** The CLI. Returns the exit code: 0 done, 1 the file could not be read or written, 2 the arguments are wrong. */
export async function main(argv: string[]): Promise<number> {
  const usage = (message: string): number => {
    console.error(`profile.ts: ${message}\n${USAGE}`)
    return 2
  }
  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: false,
      options: {
        patch: { type: 'string' },
        remote: { type: 'string' },
        'no-remote': { type: 'boolean' },
        'user-name': { type: 'string' },
        'user-email': { type: 'string' },
        preset: { type: 'string' },
        'sandbox-runner': { type: 'string' },
        'no-sandbox-runner': { type: 'boolean' },
      },
    })
  } catch (error) {
    return usage((error as Error).message)
  }
  const { values } = parsed
  if (values.patch === undefined) return usage('--patch is required')
  if (values['sandbox-runner'] !== undefined && values['no-sandbox-runner'] === true) {
    return usage('give one of --sandbox-runner or --no-sandbox-runner, not both')
  }
  const runner = values['no-sandbox-runner'] === true ? null : values['sandbox-runner']

  // The second form: the sandbox row alone, when no dish-config input is given.
  const dishInputs = [values.remote, values['no-remote'], values['user-name'], values['user-email'], values.preset]
  if (runner !== undefined && dishInputs.every((value) => value === undefined)) {
    try {
      if (runner !== null) checkRunner(runner)
    } catch (error) {
      return usage((error as Error).message)
    }
    return await write(values.patch, { sandboxRunner: runner })
  }

  for (const name of ['user-name', 'user-email'] as const) {
    if (values[name] === undefined) return usage(`--${name} is required`)
  }
  // `--no-remote` says on purpose what an empty `--remote "$UNSET"` would say by accident.
  if ((values.remote === undefined) === (values['no-remote'] !== true)) return usage('give one of --remote or --no-remote')
  if (values.remote === '') return usage('--remote must not be empty; use --no-remote to keep the store local')
  const options: DishRowsOptions = {
    remote: values['no-remote'] === true ? '' : values.remote as string,
    userName: values['user-name'] as string,
    userEmail: values['user-email'] as string,
    ...values.preset === undefined ? {} : { preset: values.preset },
    ...runner === undefined ? {} : { sandboxRunner: runner },
  }
  try {
    normalize(options)
  } catch (error) {
    return usage((error as Error).message)
  }
  return await write(values.patch, options)
}

/** Write the patch file and print the outcome. Returns the exit code, as `main` does. */
async function write(patch: string, options: DishRowsOptions | { sandboxRunner: string | null }): Promise<number> {
  try {
    console.log(await updatePatchFile(patch, options))
    return 0
  } catch (error) {
    console.error(`profile.ts: ${patch}: ${(error as Error).message}`)
    return 1
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2))
