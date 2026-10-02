/**
 * The projects registry: what `projects.yaml` is, and what makes one valid.
 *
 * The document is a YAML mapping with one key, `projects`, that maps `owner/repo` to a project's settings.
 * `parseProjects` turns the text into `Project`s, or says what is wrong in one sentence that names the project
 * and the field. The store applies the same check through `namespaceSpec`, so neither a person nor an agent can
 * save a registry that doesn't pass. Everything here is plain data and no dsh is needed, so the rules can be
 * tested alone, and `dish-workspaces` imports the `Project` type from here.
 *
 * A message never quotes a value from the document (a gate or an environment value could hold a secret): it
 * names the field. Names (a project's, a variable's) are shown, cut to a sensible length.
 *
 * @module dish-projects/registry
 */
import type { NamespaceSpec } from 'dish-config'
import { JSON_SCHEMA, YAMLException, dump, load } from 'js-yaml'

/** Where the registry lives in the config store. */
export const PROJECTS_PATH = 'projects.yaml'
/** The registry at first: no projects. */
export const SEED_TEXT = 'projects: {}\n'

/** Owners no project may have. `scratch` is where the scratch workspace lives, so its clones would land in it. */
export const RESERVED_OWNERS: readonly string[] = ['scratch']

/** GitHub's account names: 1 to 39 of letters, digits and hyphens, with no hyphen at either end or twice in a row. */
export const OWNER = /^(?=.{1,39}$)[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/
/** GitHub's repository names: 1 to 100 of letters, digits, `.`, `_` and `-`. `.`, `..` and names ending in `.git` are refused separately. */
export const REPO = /^[A-Za-z0-9._-]{1,100}$/

/** The names dsh's environment scrub drops (`KEY`, `PASSWORD`, `SECRET`, `TOKEN`). Pinned to dsh's pattern by dish-workspaces' env test. */
export const SECRET_NAME = /KEY|PASSWORD|SECRET|TOKEN/i

/** What a gate may take, in milliseconds. dsh's shell service caps a run at 10 minutes. */
export const GATE_TIMEOUT = { min: 10_000, max: 600_000 } as const
/** What setup may take, in milliseconds, and the text used when a project says nothing. */
export const SETUP_TIMEOUT = { min: 10_000, max: 3_600_000, fallback: '15m' } as const

/** The longest a name from the document is shown in a message. */
const SHOWN = 64

/** What a variable in `gateEnv` may be called. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
/** The prefix of dsh's own variables, which its scrub removes from every agent shell. Pinned to dsh's `DSH_ENV_PREFIX` by dish-workspaces' env test. */
const DSH_PREFIX = 'DSH_'

const DURATION = /^([0-9]+)([smh])$/
const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000 } as const

/** The fields of a project, in the order they are written. */
const FIELD_NAMES = ['family', 'role', 'gate', 'gateTimeout', 'setup', 'setupTimeout', 'gateEnv'] as const

/**
 * `<n>s`, `<n>m` or `<n>h` (n a positive integer, no spaces) in milliseconds. Anything else, and anything too
 * big to be exact, is `undefined`.
 */
export function parseDuration(text: string): number | undefined {
  if (typeof text !== 'string') return undefined
  const match = DURATION.exec(text)
  if (match === null) return undefined
  const count = Number(match[1])
  if (!Number.isSafeInteger(count) || count <= 0) return undefined
  const ms = count * UNIT_MS[match[2] as keyof typeof UNIT_MS]
  return Number.isSafeInteger(ms) ? ms : undefined
}

/** `ms` as the shortest `<n>s`, `<n>m` or `<n>h` that says it exactly. */
function formatDuration(ms: number): string {
  if (ms % UNIT_MS.h === 0) return `${ms / UNIT_MS.h}h`
  if (ms % UNIT_MS.m === 0) return `${ms / UNIT_MS.m}m`
  return `${ms / UNIT_MS.s}s`
}

/** A project's settings as `projects.yaml` writes them. */
export interface ProjectFields {
  family: string
  role: string
  gate: string
  gateTimeout: string
  setup?: string
  setupTimeout?: string
  gateEnv?: Record<string, string>
}

/** A project as the rest of dish reads it. */
export interface Project {
  /** The key, as written: `owner/repo`. */
  name: string
  owner: string
  repo: string
  family: string
  role: string
  gate: string
  gateTimeout: string
  gateTimeoutMs: number
  setup: string | undefined
  /** What the file says, or `15m`. */
  setupTimeout: string
  setupTimeoutMs: number
  /** `{}` when there is none. */
  gateEnv: Record<string, string>
}

export type ParseResult =
  | { ok: true, projects: Project[], fields: Record<string, ProjectFields> }
  | { ok: false, problem: string }

/** A refusal: carries the sentence the check returns. Thrown to leave the checks at the first problem. */
class Problem extends Error {}

function refuse(message: string): never {
  throw new Problem(message)
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The value of `key` if the mapping has it itself, so a key like `constructor` is never inherited. */
function own(from: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(from, key) ? from[key] : undefined
}

/** Set `key` on `target` as an own property, even when it is `__proto__`, which plain assignment would turn into a prototype change. */
function put<T>(target: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true })
}

/** `text` as a message shows a name: quoted, with anything odd escaped, and cut short. */
function quote(text: string): string {
  return JSON.stringify(text.length > SHOWN ? `${text.slice(0, SHOWN)}…` : text)
}

/** Names compare without regard to case, as GitHub's do; the plain order breaks a tie so the result never depends on input order. */
function compareNames(a: string, b: string): number {
  const first = a.toLowerCase()
  const second = b.toLowerCase()
  if (first !== second) return first < second ? -1 : 1
  return a < b ? -1 : a > b ? 1 : 0
}

// --- names ------------------------------------------------------------------------------------

/**
 * Why `name` can't be a project's key, or `undefined` if it can: `owner/repo` in GitHub's grammar, with an owner
 * that isn't reserved. Two names that differ only in case are one repository to GitHub; that is checked across
 * a whole document, by `parseProjects`.
 */
export function nameProblem(name: string): string | undefined {
  if (typeof name !== 'string') return 'a project name must be a string'
  const bad = `${quote(name)} isn't a valid project name`
  const parts = name.split('/')
  const [owner, repo] = parts
  if (parts.length !== 2 || owner === '' || repo === '' || owner === undefined || repo === undefined) {
    return `${bad}: use owner/repo`
  }
  if (!OWNER.test(owner)) {
    return `${bad}: the owner must be 1 to 39 letters, digits and single hyphens, not starting or ending with a hyphen`
  }
  const reserved = RESERVED_OWNERS.find(candidate => candidate === owner.toLowerCase())
  if (reserved !== undefined) {
    return `${bad}: ${reserved} is reserved for the scratch workspace and can't be an owner, in any case`
  }
  if (!REPO.test(repo)) {
    return `${bad}: the repository must be 1 to 100 letters, digits, ".", "_" and "-"`
  }
  if (repo === '.' || repo === '..') return `${bad}: the repository can't be "." or ".."`
  if (repo.toLowerCase().endsWith('.git')) return `${bad}: a repository name can't end in .git`
  return undefined
}

// --- fields -----------------------------------------------------------------------------------

/**
 * A required or optional string field. It is trimmed, since a block scalar ends in a newline and a form leaves
 * stray spaces, and nothing downstream wants them. `oneLine` refuses a line break. `spawned` is for a field that
 * becomes an argument of a process (the gate, setup), which can't be handed a NUL.
 */
function readText(data: Record<string, unknown>, field: string, options: { required: boolean, oneLine: boolean, spawned: boolean }): string | undefined {
  const value = own(data, field)
  if (value === undefined) {
    if (options.required) refuse(`${field} is missing`)
    return undefined
  }
  if (typeof value !== 'string') refuse(`${field} must be a string`)
  const trimmed = value.trim()
  if (trimmed === '') refuse(`${field} is blank`)
  if (options.oneLine && /[\r\n]/.test(trimmed)) refuse(`${field} must be one line`)
  if (options.spawned) noNul(field, trimmed)
  return trimmed
}

function noNul(what: string, value: string): void {
  if (value.includes('\0')) refuse(`${what} must not contain a NUL character`)
}

/** A duration field. It is kept as written: parsing is strict, so what is written is what is meant. */
function readDuration(data: Record<string, unknown>, field: string, bounds: { min: number, max: number }, required: boolean): string | undefined {
  const value = own(data, field)
  if (value === undefined) {
    if (required) refuse(`${field} is missing`)
    return undefined
  }
  const ms = typeof value === 'string' ? parseDuration(value) : undefined
  if (typeof value !== 'string' || ms === undefined || ms < bounds.min || ms > bounds.max) {
    refuse(`${field} must be <n>s, <n>m or <n>h between ${formatDuration(bounds.min)} and ${formatDuration(bounds.max)}`)
  }
  return value
}

/** The `gateEnv` mapping, or `undefined` when there is none or it is empty. */
function readEnv(data: Record<string, unknown>): Record<string, string> | undefined {
  const value = own(data, 'gateEnv')
  if (value === undefined) return undefined
  if (!isMapping(value)) refuse('gateEnv must be a mapping of variable names to strings')
  const env: Record<string, string> = {}
  for (const [name, text] of Object.entries(value)) {
    if (!ENV_NAME.test(name)) {
      refuse(`gateEnv names a variable ${quote(name)} that isn't a name (letters, digits and underscores, not starting with a digit)`)
    }
    if (name.toUpperCase().startsWith(DSH_PREFIX)) refuse(`gateEnv can't set ${quote(name)}: dsh reserves names starting with DSH_`)
    if (SECRET_NAME.test(name)) refuse(`gateEnv can't set ${quote(name)}: a name with KEY, PASSWORD, SECRET or TOKEN in it looks like a secret`)
    if (typeof text !== 'string') refuse(`gateEnv.${name} must be a string`)
    if (/[\r\n]/.test(text)) refuse(`gateEnv.${name} must be one line`)
    noNul(`gateEnv.${name}`, text)
    put(env, name, text)
  }
  return Object.keys(env).length === 0 ? undefined : env
}

/** How a project is named in a message about its fields: as it is when it can be a name, quoted when it can't. */
function shownName(name: string): string {
  return nameProblem(name) === undefined ? name : quote(String(name))
}

/** `input` as the fields it says, or a `Problem` that starts with the project's name. */
function readFields(name: string, input: unknown): ProjectFields {
  try {
    if (!isMapping(input)) refuse('the settings must be a mapping of fields to values')
    for (const key of Object.keys(input)) {
      if (!(FIELD_NAMES as readonly string[]).includes(key)) {
        const known = `${FIELD_NAMES.slice(0, -1).join(', ')} and ${FIELD_NAMES[FIELD_NAMES.length - 1]}`
        refuse(`unknown field ${quote(key)}; the fields are ${known}`)
      }
    }
    const fields: ProjectFields = {
      family: readText(input, 'family', { required: true, oneLine: true, spawned: false })!,
      role: readText(input, 'role', { required: true, oneLine: true, spawned: false })!,
      gate: readText(input, 'gate', { required: true, oneLine: true, spawned: true })!,
      gateTimeout: readDuration(input, 'gateTimeout', GATE_TIMEOUT, true)!,
    }
    const setup = readText(input, 'setup', { required: false, oneLine: false, spawned: true })
    if (setup !== undefined) fields.setup = setup
    const setupTimeout = readDuration(input, 'setupTimeout', SETUP_TIMEOUT, false)
    if (setupTimeout !== undefined) fields.setupTimeout = setupTimeout
    const gateEnv = readEnv(input)
    if (gateEnv !== undefined) fields.gateEnv = gateEnv
    return fields
  } catch (error) {
    if (error instanceof Problem) throw new Problem(`${shownName(name)}: ${error.message}`)
    throw error
  }
}

/**
 * Why `fields` can't be the settings of the project `name`, or `undefined` if they can: one sentence that starts
 * with the project and names the field. The name itself is `nameProblem`'s to judge.
 */
export function fieldsProblem(name: string, fields: unknown): string | undefined {
  try {
    readFields(name, fields)
    return undefined
  } catch (error) {
    if (error instanceof Problem) return error.message
    throw error
  }
}

// --- the document -----------------------------------------------------------------------------

/**
 * The YAML in `text`: the core schema, so nothing in it is code (no timestamps, binary or custom tags). A parse
 * error is reported by its line only: the parser's own reason can quote the document (an alias, a tag, a tag
 * handle), and a value in this document could be a secret.
 */
function loadDocument(text: string): unknown {
  try {
    return load(text, { schema: JSON_SCHEMA })
  } catch (error) {
    if (error instanceof YAMLException) {
      const line = error.mark === undefined ? '' : ` (line ${error.mark.line + 1})`
      refuse(`isn't valid YAML${line}`)
    }
    throw error
  }
}

function projectOf(name: string, fields: ProjectFields): Project {
  const slash = name.indexOf('/')
  const setupTimeout = fields.setupTimeout ?? SETUP_TIMEOUT.fallback
  return {
    name,
    owner: name.slice(0, slash),
    repo: name.slice(slash + 1),
    family: fields.family,
    role: fields.role,
    gate: fields.gate,
    gateTimeout: fields.gateTimeout,
    gateTimeoutMs: parseDuration(fields.gateTimeout)!,
    setup: fields.setup,
    setupTimeout,
    setupTimeoutMs: parseDuration(setupTimeout)!,
    gateEnv: { ...fields.gateEnv },
  }
}

function parse(text: string): { projects: Project[], fields: Record<string, ProjectFields> } {
  const document = loadDocument(text)
  if (!isMapping(document)) refuse('the document must be a mapping with one key, projects')
  for (const key of Object.keys(document)) {
    if (key !== 'projects') refuse(`unknown top-level key ${quote(key)}; the only key is projects`)
  }
  if (!Object.hasOwn(document, 'projects')) refuse('projects is missing; write "projects: {}" for none')
  // `projects:` with nothing after it is a null: no projects.
  const table = document.projects ?? {}
  if (!isMapping(table)) refuse('projects must be a mapping of owner/repo to settings')

  const seen = new Map<string, string>()
  const read: Array<[string, ProjectFields]> = []
  for (const [name, input] of Object.entries(table)) {
    const problem = nameProblem(name)
    if (problem !== undefined) refuse(problem)
    const earlier = seen.get(name.toLowerCase())
    if (earlier !== undefined) refuse(`${quote(earlier)} and ${quote(name)} differ only in case, and GitHub's names don't; keep one`)
    seen.set(name.toLowerCase(), name)
    read.push([name, readFields(name, input)])
  }

  read.sort(([a], [b]) => compareNames(a, b))
  const fields: Record<string, ProjectFields> = {}
  for (const [name, entry] of read) put(fields, name, entry)
  return { projects: read.map(([name, entry]) => projectOf(name, entry)), fields }
}

/**
 * Read the registry in `text`, or say why it can't be one: the first problem found, in the order the file has
 * its projects, as a sentence that starts with the path. `projects` is sorted by name, case-insensitively;
 * `fields` has the same projects and order, as the file says them (trimmed, with no default filled in).
 */
export function parseProjects(text: string): ParseResult {
  try {
    return { ok: true, ...parse(text) }
  } catch (error) {
    if (error instanceof Problem) return { ok: false, problem: `${PROJECTS_PATH}: ${error.message}` }
    throw error
  }
}

/** Whether an optional text field says anything. */
function isSet(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== ''
}

/**
 * The text of a registry with these projects. Keys are sorted as `parseProjects` sorts them, each project's
 * fields are in the order of `ProjectFields`, and an optional one is left out unless it is set, so the result
 * parses back to the same fields. Comments in an earlier document don't survive. The fields aren't checked
 * here: that is `fieldsProblem`'s job.
 */
export function serializeProjects(fields: Readonly<Record<string, ProjectFields>>): string {
  const projects: Record<string, Record<string, unknown>> = {}
  for (const name of Object.keys(fields).sort(compareNames)) {
    const entry = fields[name]!
    const written: Record<string, unknown> = {
      family: entry.family,
      role: entry.role,
      gate: entry.gate,
      gateTimeout: entry.gateTimeout,
    }
    if (isSet(entry.setup)) written.setup = entry.setup
    if (isSet(entry.setupTimeout)) written.setupTimeout = entry.setupTimeout
    if (entry.gateEnv !== undefined && Object.keys(entry.gateEnv).length > 0) written.gateEnv = { ...entry.gateEnv }
    put(projects, name, written)
  }
  // Long lines stay whole, and no anchors: a value two projects share is written out for each.
  return dump({ projects }, { lineWidth: -1, noRefs: true })
}

/**
 * Why `text` can't be the registry, or `undefined` if it can: the namespace's validator. The store puts the path
 * in front of every message it shows, so the path is left off the sentence `parseProjects` gives. The store's own
 * limits (size, secrets) are its business, not this function's.
 */
export function validate(_path: string, text: string): string | undefined {
  const result = parseProjects(text)
  if (result.ok) return undefined
  const prefix = `${PROJECTS_PATH}: `
  return result.problem.startsWith(prefix) ? result.problem.slice(prefix.length) : result.problem
}

/** The claim on the config store, for `owner`: the one document, where an agent may only propose. */
export function namespaceSpec(owner: string): NamespaceSpec {
  return { prefix: PROJECTS_PATH, owner, agent: 'propose', validate }
}
