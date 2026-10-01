/**
 * `judge.yaml`: the model, time limit, thresholds and tool lists of the judge, as one document in the config store.
 *
 * `parseSettings` turns the text into `JudgeSettings`, or says what is wrong with it, naming the YAML path. The store
 * applies the same check through `JUDGE_SPEC`, so a person can't save a file that doesn't pass, and no agent can save
 * one at all (the namespace is closed to agents). Everything is plain data and no dsh is needed, so the rules can be
 * tested alone.
 *
 * What comes back is frozen, all the way down, and the types say so, so one object can be shared between calls.
 *
 * @module dish-judge/settings
 */
import { readFileSync } from 'node:fs'
import type { NamespaceSpec } from 'dish-config'
import { maskSecrets, secretKind } from 'dish-kit'
import { JSON_SCHEMA, load, YAMLException } from 'js-yaml'

/** The thresholds a shell command is let through on. */
export interface CommandSettings {
  /** P(read_only) at or above this, and the command serves the task: it runs. */
  readonly readOnly: number
  /** P(read_only) + P(reversible) at or above this, and the command serves the task: it runs. */
  readonly reversible: number
  /** P(serves the task) below this: the command never runs on the judge's say-so. */
  readonly servesTask: number
}

/** The thresholds a tool result is screened with. */
export interface ScreeningSettings {
  /** P(injected instructions) at or above this: the content is withheld. */
  readonly withhold: number
  /** At or above this, and below `withhold`: the content is kept, with a warning in front. Never above `withhold`. */
  readonly warn: number
  /** Content longer than this is screened in chunks, in one call. */
  readonly chunkChars: number
}

/** Which tools are gated and which are screened: plain names, or prefixes ending in `*`. */
export interface ToolSettings {
  readonly gated: readonly string[]
  readonly screened: readonly string[]
}

/** Everything in it is frozen, and the types say so: copy before changing anything. */
export interface JudgeSettings {
  /** The Jev model id. Pinned: the thresholds were set against one version. */
  readonly model: string
  /** How long a call to Jev may take, in milliseconds, whole. */
  readonly timeoutMs: number
  readonly commands: CommandSettings
  readonly screening: ScreeningSettings
  readonly tools: ToolSettings
}

export type ParseResult = { ok: true, settings: JudgeSettings } | { ok: false, problem: string }

const TOP_KEYS = ['model', 'timeoutMs', 'commands', 'screening', 'tools'] as const
const COMMAND_KEYS = ['readOnly', 'reversible', 'servesTask'] as const
const SCREENING_KEYS = ['withhold', 'warn', 'chunkChars'] as const
const TOOL_KEYS = ['gated', 'screened'] as const

const TIMEOUT_MS = { min: 200, max: 10000 } as const
const CHUNK_CHARS = { min: 2000, max: 60000 } as const

/** The longest a name or value from outside is shown in a message, so one bad key can't make a message the size of the file. */
const SHOWN = 40
/** The longest a YAML parser's own reason is shown. */
const REASON = 160

/**
 * `text` as a message may show it: any credential in it hidden (`maskSecrets`, before the cut, so that a cut can't leave
 * the start of one that no pattern would match), then cut to `length` characters with `…` where it was cut.
 */
function truncate(text: string, length = SHOWN): string {
  const safe = maskSecrets(text)
  return safe.length > length ? `${safe.slice(0, length)}…` : safe
}

/** `JSON.stringify` of a string, with the characters it leaves as they are but a terminal or an editor would act on (DEL, C1, the line separators) escaped too. */
function quoted(text: string): string {
  return JSON.stringify(text).replace(/[\u007f-\u009f\u2028\u2029]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

/** `value` as a message shows it: a string quoted, masked and cut short, a collection by its kind, anything else as it is. */
function shown(value: unknown): string {
  if (typeof value === 'string') return quoted(truncate(value))
  if (Array.isArray(value)) return 'a list'
  if (value !== null && typeof value === 'object') return 'a mapping'
  return String(value)
}

/** The path of `key` under `path`: `commands.readOnly`, or `["odd name"]` for a name that isn't plain (or has a credential in it). */
function at(path: string, key: string): string {
  const cut = truncate(key)
  if (/^[A-Za-z0-9_-]+$/.test(key) && cut === key) return path === '' ? key : `${path}.${key}`
  return `${path}[${quoted(cut)}]`
}

/** A refusal: carries the message `parseSettings` returns. Thrown to leave the checks at the first problem. */
class Problem extends Error {}

function refuse(path: string, message: string): never {
  throw new Problem(path === '' ? message : `${path}: ${message}`)
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The value of `key` in `from`, which must be there. */
function required(from: Record<string, unknown>, key: string, path: string, wanted: string): unknown {
  const value = from[key]
  if (value === undefined) refuse(at(path, key), `required (${wanted})`)
  return value
}

/** Refuse a key in `from` that isn't in `allowed`. */
function noOtherKeys(from: Record<string, unknown>, path: string, allowed: readonly string[]): void {
  for (const key of Object.keys(from)) {
    if (!allowed.includes(key)) refuse(at(path, key), `unknown key (allowed: ${allowed.join(', ')})`)
  }
}

/** A section of the file: a mapping with exactly `keys` allowed. */
function section(value: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  if (!isMapping(value)) refuse(path, `must be a mapping with ${keys.join(', ')} (got ${shown(value)})`)
  noOtherKeys(value, path, keys)
  return value
}

/** Refuse `value` if it starts or ends with whitespace: it would be a different name from the one it looks like. */
function unpadded(value: string, path: string): string {
  if (value !== value.trim()) refuse(path, `must not start or end with whitespace (got ${shown(value)})`)
  return value
}

/** What a model id can be: Jev's ids and the likes of them (`jev-1.13.0`, `org/model:tag`), and nothing a header or a log would have to escape. */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,127}$/

/**
 * A model id: letters, digits and `. _ : / -`, starting with a letter or a digit, at most 128 characters. It is sent to the
 * API in every request, so a value that is a credential is refused without being shown.
 */
function modelId(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') refuse(path, `must be a model id (got ${shown(value)})`)
  unpadded(value, path)
  const kind = secretKind(value)
  if (kind !== undefined) refuse(path, `must be a model id, and this looks like ${kind}: it is not shown`)
  if (!MODEL_ID.test(value)) refuse(path, `must be a model id: letters, digits and . _ : / - only, starting with a letter or digit, at most 128 characters (got ${shown(value)})`)
  return value
}

/** A whole number from `min` to `max`. */
function wholeNumber(value: unknown, path: string, range: { readonly min: number, readonly max: number }): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < range.min || value > range.max) {
    refuse(path, `${shown(value)} is not a whole number from ${range.min} to ${range.max}`)
  }
  return value
}

/** A probability: a number from 0 to 1. YAML's `.nan` and `.inf` are numbers, and not these. */
function threshold(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    refuse(path, `${shown(value)} is not a number from 0 to 1`)
  }
  return value
}

/**
 * A tool name as `tools.gated` and `tools.screened` list them: a plain name, or a prefix ending in `*` that matches every
 * name starting with it. A name is printable ASCII with no space in it, and has at least one character before the `*`: a
 * lone `*` would be every tool, which is a decision for a list of names, not a wildcard.
 */
const TOOL_NAME = /^[\x21-\x29\x2b-\x7e]+\*?$/
/** The longest a tool name or prefix can be, `*` included. Providers' own limits are 64. */
const MAX_TOOL_NAME = 128

function parseToolList(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) refuse(path, `must be a list of tool names (got ${shown(value)})`)
  if (value.length === 0) refuse(path, 'needs at least one tool name')
  return value.map((item, index) => {
    const own = `${path}[${index}]`
    const wanted = 'a tool name or a prefix ending in *'
    if (typeof item !== 'string' || item.trim() === '') refuse(own, `must be ${wanted} (got ${shown(item)})`)
    unpadded(item, own)
    if (item === '*') refuse(own, 'a lone * is not allowed: list tools by name, or by a prefix such as mcp__*')
    if (!TOOL_NAME.test(item)) refuse(own, `must be ${wanted}: printable ASCII with no spaces, and a * only at the end (got ${shown(item)})`)
    if (item.length > MAX_TOOL_NAME) refuse(own, `must be at most ${MAX_TOOL_NAME} characters (got ${shown(item)})`)
    return item
  })
}

function parseCommands(value: unknown): CommandSettings {
  const from = section(value, 'commands', COMMAND_KEYS)
  const chosen = {} as Record<(typeof COMMAND_KEYS)[number], number>
  for (const key of COMMAND_KEYS) chosen[key] = threshold(required(from, key, 'commands', 'a number from 0 to 1'), at('commands', key))
  return { readOnly: chosen.readOnly, reversible: chosen.reversible, servesTask: chosen.servesTask }
}

function parseScreening(value: unknown): ScreeningSettings {
  const from = section(value, 'screening', SCREENING_KEYS)
  const withhold = threshold(required(from, 'withhold', 'screening', 'a number from 0 to 1'), 'screening.withhold')
  const warn = threshold(required(from, 'warn', 'screening', 'a number from 0 to 1'), 'screening.warn')
  if (warn > withhold) refuse('screening.warn', `${warn} is more than screening.withhold (${withhold})`)
  const chunkChars = wholeNumber(required(from, 'chunkChars', 'screening', `characters, ${CHUNK_CHARS.min} to ${CHUNK_CHARS.max}`), 'screening.chunkChars', CHUNK_CHARS)
  return { withhold, warn, chunkChars }
}

function parseTools(value: unknown): ToolSettings {
  const from = section(value, 'tools', TOOL_KEYS)
  const gated = parseToolList(required(from, 'gated', 'tools', 'a list of tool names'), 'tools.gated')
  const screened = parseToolList(required(from, 'screened', 'tools', 'a list of tool names'), 'tools.screened')
  return { gated, screened }
}

/** Freeze `value` and everything in it. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const inner of Object.values(value)) deepFreeze(inner)
  }
  return value
}

/** Whether `text` has nothing in it but whitespace and comments. */
function blank(text: string): boolean {
  return text.split('\n').every(line => line.trim() === '' || line.trim().startsWith('#'))
}

/** What a YAML parser's error says, with where, and none of the document. */
function yamlProblem(error: unknown): string {
  if (error instanceof YAMLException) {
    const where = error.mark === undefined || error.mark === null ? '' : ` (line ${error.mark.line + 1}, column ${error.mark.column + 1})`
    return `not valid YAML${where}: ${truncate(error.reason, REASON)}`
  }
  return `not valid YAML: ${truncate(error instanceof Error ? error.message : String(error), REASON)}`
}

/**
 * Parse and check a `judge.yaml`. YAML tags aren't accepted (the document is read with the JSON schema), unknown keys are
 * refused at every level, and every rule of the spec's Validation section holds. The first problem found is the one
 * returned, named by its path in the file, and it doesn't name the file itself: the store puts that in front.
 */
export function parseSettings(text: string): ParseResult {
  let document: unknown
  try {
    document = load(text, { schema: JSON_SCHEMA })
  } catch (error) {
    return { ok: false, problem: yamlProblem(error) }
  }
  try {
    if (document === undefined || (document === null && blank(text))) {
      refuse('', `the file is empty; it needs ${TOP_KEYS.slice(0, -1).join(', ')} and ${TOP_KEYS[TOP_KEYS.length - 1]}`)
    }
    if (!isMapping(document)) refuse('', `must be a mapping of settings (got ${shown(document)})`)
    noOtherKeys(document, '', TOP_KEYS)
    const model = modelId(required(document, 'model', '', 'a model id'), 'model')
    const timeoutMs = wholeNumber(required(document, 'timeoutMs', '', `milliseconds, ${TIMEOUT_MS.min} to ${TIMEOUT_MS.max}`), 'timeoutMs', TIMEOUT_MS)
    const commands = parseCommands(required(document, 'commands', '', 'readOnly, reversible and servesTask'))
    const screening = parseScreening(required(document, 'screening', '', 'withhold, warn and chunkChars'))
    const tools = parseTools(required(document, 'tools', '', 'gated and screened'))
    return { ok: true, settings: deepFreeze({ model, timeoutMs, commands, screening, tools }) }
  } catch (error) {
    if (error instanceof Problem) return { ok: false, problem: error.message }
    throw error
  }
}

/** The shipped `judge.yaml`, as a file in the store. A missing file is a broken install, so it throws when this module loads. */
export const DEFAULT_TEXT: string = readFileSync(new URL('../defaults/judge.yaml', import.meta.url), 'utf8')

/** The shipped file as settings. A shipped file that doesn't pass its own check is a broken install too. */
export const DEFAULT_SETTINGS: JudgeSettings = (() => {
  const parsed = parseSettings(DEFAULT_TEXT)
  if (!parsed.ok) throw new Error(`the shipped defaults/judge.yaml is not valid: ${parsed.problem}`)
  return parsed.settings
})()

/**
 * The namespace `dish-judge` claims in the config store: `judge.yaml`, which agents can neither read nor write. A
 * person edits it on Settings → Judge and reviews it in History.
 */
export const JUDGE_SPEC: NamespaceSpec = {
  prefix: 'judge.yaml',
  owner: 'dish-judge',
  agent: 'none',
  validate: (_path, text) => {
    const parsed = parseSettings(text)
    return parsed.ok ? undefined : parsed.problem
  },
}
