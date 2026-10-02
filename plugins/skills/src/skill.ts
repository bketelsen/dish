/**
 * The skill format: what a document at `skills/<name>/SKILL.md` is, and what makes one valid.
 *
 * A skill is YAML frontmatter and then the instructions, the shape dsh's own loader reads. `parseSkill` turns
 * the text into a `ParsedSkill`, or says what is wrong in one sentence that names the path. `checkSkill` adds
 * the warnings, which never refuse a save. The store applies the same check through `namespaceSpec`, so neither
 * a person nor an agent can save a skill that doesn't pass. Everything here is plain data and no dsh is needed,
 * so the rules can be tested alone.
 *
 * `metadata.roles` is dish's own addition: the roles a skill is offered to. Absent means every role, and an
 * empty list means none.
 *
 * @module dish-skills/skill
 */
import type { NamespaceSpec } from 'dish-config'
import { JSON_SCHEMA, load, YAMLException } from 'js-yaml'

/** The store directory every skill is under. */
export const SKILLS_PREFIX = 'skills/'
/** The one file a skill is, in the directory named after it. */
export const SKILL_FILE = 'SKILL.md'

/** dsh's skill-name grammar. */
export const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
/** What a role may be called: crew's grammar, since each role has a prompt document by its name. */
export const ROLE_NAME = /^[a-z][a-z0-9-]*$/

/** The roles dish ships when crew isn't there to say which exist. */
export const SHIPPED_ROLES: readonly string[] = ['main', 'architect', 'coder', 'reviewer', 'researcher', 'ops', 'writer']

/** The longest a skill's name may be. dsh has no limit; the page and the catalog do better with one. */
export const MAX_NAME = 64
/** The longest a description may be: the catalog shows every skill's. */
export const MAX_DESCRIPTION = 1024
/** Above this many characters a document gets a warning: dsh's tool-result pruner may trim it. */
export const WARN_CHARS = 8000

/** The longest a value from the document is shown in a message. */
const SHOWN = 64
/** The longest a YAML parser's own reason is shown. */
const REASON = 160

/** Whether `name` can be a skill's name. */
export function isSkillName(name: string): boolean {
  return typeof name === 'string' && name.length <= MAX_NAME && SKILL_NAME.test(name)
}

/**
 * The store path of the skill called `name`.
 * @throws a plain `Error` for a name that can't be a skill's.
 */
export function pathFor(name: string): string {
  if (!isSkillName(name)) {
    throw new Error(`invalid skill name ${JSON.stringify(name)}: use lowercase letters, digits and hyphens, at most ${MAX_NAME} characters`)
  }
  return `${SKILLS_PREFIX}${name}/${SKILL_FILE}`
}

/** The skill whose document is at `path`: the inverse of `pathFor`. `undefined` for any other path. */
export function nameFor(path: string): string | undefined {
  const suffix = `/${SKILL_FILE}`
  if (!path.startsWith(SKILLS_PREFIX) || !path.endsWith(suffix)) return undefined
  if (path.length <= SKILLS_PREFIX.length + suffix.length) return undefined
  const name = path.slice(SKILLS_PREFIX.length, -suffix.length)
  return isSkillName(name) ? name : undefined
}

export interface ParsedSkill {
  readonly name: string
  readonly description: string
  /** The roles offered the skill. `null`: every role. */
  readonly roles: string[] | null
  /** Whether a model may load it (`disable-model-invocation` is not `true`). */
  readonly modelInvocable: boolean
  /** Whether it is in the `/` menu (`user-invocable` is not `false`). */
  readonly userInvocable: boolean
  /** The frontmatter's `metadata` mapping as it was written, `roles` included. `{}` when there is none. */
  readonly metadata: Record<string, unknown>
  /** The instructions: everything after the frontmatter, trimmed. */
  readonly body: string
}

export type ParseResult = { ok: true, skill: ParsedSkill } | { ok: false, problem: string }

/** `value` cut to `length` characters with `…` where it was cut. */
function truncate(value: string, length = SHOWN): string {
  return value.length > length ? `${value.slice(0, length)}…` : value
}

/** `value` as a message shows what it was given instead of a string: a collection by its kind, anything else as it is. */
function shown(value: unknown): string {
  if (Array.isArray(value)) return 'a list'
  if (value !== null && typeof value === 'object') return 'a mapping'
  return String(value)
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The value of `key` if the mapping has it itself, so a key like `constructor` is never inherited. */
function own(from: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(from, key) ? from[key] : undefined
}

/** A refusal: carries the message `parseSkill` returns. Thrown to leave the checks at the first problem. */
class Problem extends Error {}

function refuse(message: string): never {
  throw new Problem(message)
}

/** dsh's camelCase keys from before the kebab-case ones, with the key that took the place of each. dsh refuses the skill that has one. */
const LEGACY_KEYS: ReadonlyArray<readonly [legacy: string, canonical: string]> = [
  ['disableModelInvocation', 'disable-model-invocation'],
  ['modelInvocable', 'disable-model-invocation'],
  ['userInvocable', 'user-invocable'],
]

/** Split `text` into its frontmatter and what follows. */
function split(text: string): { frontmatter: string, rest: string } {
  const normal = (text.startsWith('﻿') ? text.slice(1) : text).replaceAll('\r\n', '\n')
  if (!normal.startsWith('---\n')) refuse('the frontmatter is missing; the document must start with a --- line')
  const lines = normal.split('\n')
  const end = lines.indexOf('---', 1)
  if (end < 0) refuse('the frontmatter is not closed; end it with a --- line')
  return { frontmatter: lines.slice(1, end).join('\n'), rest: lines.slice(end + 1).join('\n') }
}

/**
 * Refuse a value that is reachable twice. YAML aliases let a few hundred bytes say a cyclic value, or one that
 * is a billion entries when written out, and everything downstream (the store, the page, JSON) would walk it.
 * Each list and mapping is visited once, so this takes time in proportion to the document.
 */
function noAliases(root: unknown): void {
  const seen = new Set<object>()
  const pending: unknown[] = [root]
  while (pending.length > 0) {
    const value = pending.pop()
    if (typeof value !== 'object' || value === null) continue
    if (seen.has(value)) refuse('the frontmatter reuses a value through a YAML alias; write it out')
    seen.add(value)
    pending.push(...Object.values(value))
  }
}

/** The mapping the frontmatter says. */
function frontmatterOf(frontmatter: string): Record<string, unknown> {
  let data: unknown
  try {
    // JSON_SCHEMA is the core schema: no timestamps, no binary, no custom types, so nothing in a skill is code.
    data = load(frontmatter, { schema: JSON_SCHEMA })
  } catch (error) {
    if (!(error instanceof YAMLException)) throw error
    // The mark's line counts from the first line of the frontmatter, which is the document's second.
    const line = error.mark === undefined ? '' : ` (line ${error.mark.line + 2})`
    refuse(`the frontmatter isn't valid YAML: ${truncate(error.reason.replace(/\s+/g, ' '), REASON)}${line}`)
  }
  if (!isMapping(data)) refuse('the frontmatter must be a mapping of keys to values')
  noAliases(data)
  return data
}

function booleanKey(data: Record<string, unknown>, key: string): boolean | undefined {
  const value = own(data, key)
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') refuse(`${key} must be true or false`)
  return value
}

function parseRoles(metadata: Record<string, unknown>): string[] | null {
  const value = own(metadata, 'roles')
  if (value === undefined) return null
  if (!Array.isArray(value) || !value.every(role => typeof role === 'string' && ROLE_NAME.test(role))) {
    refuse('metadata.roles must be a list of role names (lowercase letters, digits and hyphens, starting with a letter)')
  }
  return [...value as string[]]
}

function parse(path: string, text: string): ParsedSkill {
  const folder = nameFor(path)
  if (folder === undefined) {
    refuse(`not a skill document; use ${SKILLS_PREFIX}<name>/${SKILL_FILE}, where <name> is lowercase letters, digits and hyphens, at most ${MAX_NAME} characters`)
  }
  const { frontmatter, rest } = split(text)
  const data = frontmatterOf(frontmatter)

  const name = own(data, 'name')
  if (name === undefined) refuse('name is missing')
  if (typeof name !== 'string') refuse(`name must be a string (got ${shown(name)})`)
  if (name !== folder) refuse(`name is ${JSON.stringify(truncate(name))} but the folder is ${JSON.stringify(folder)}; they must match`)

  const description = own(data, 'description')
  if (description === undefined) refuse('description is missing')
  if (typeof description !== 'string') refuse(`description must be a string (got ${shown(description)})`)
  // Trimmed once, so the blank check, the length check and what is stored all see the same text: a folded block
  // scalar keeps a trailing newline that is not part of the description.
  const trimmed = description.trim()
  if (trimmed === '') refuse('description is blank')
  if (trimmed.length > MAX_DESCRIPTION) refuse(`description is ${trimmed.length} characters; the most is ${MAX_DESCRIPTION}`)

  const body = rest.trim()
  if (body === '') refuse('the instructions are empty; write them after the frontmatter')

  for (const [legacy, canonical] of LEGACY_KEYS) {
    if (Object.hasOwn(data, legacy)) refuse(`"${legacy}" is unsupported; use "${canonical}"`)
  }
  const disabled = booleanKey(data, 'disable-model-invocation')
  const userInvocable = booleanKey(data, 'user-invocable')

  const metadata = own(data, 'metadata')
  if (metadata !== undefined && !isMapping(metadata)) refuse('metadata must be a mapping')

  return {
    name,
    description: trimmed,
    roles: parseRoles(metadata ?? {}),
    modelInvocable: disabled !== true,
    userInvocable: userInvocable !== false,
    metadata: metadata ?? {},
    body,
  }
}

/**
 * Read the skill `text` at `path`, or say why it can't be one: the first problem found, as a sentence that starts
 * with the path.
 */
export function parseSkill(path: string, text: string): ParseResult {
  try {
    return { ok: true, skill: parse(path, text) }
  } catch (error) {
    if (error instanceof Problem) return { ok: false, problem: `${path}: ${error.message}` }
    throw error
  }
}

export interface SkillCheck {
  /** Why the document can't be saved: empty, or the one problem found. */
  problems: string[]
  /** What is worth a look but doesn't refuse a save. */
  warnings: string[]
  /** The skill, or `null` when there is a problem. */
  skill: ParsedSkill | null
}

/** `parseSkill`, with the warnings: a document that is long, and a role in it that `knownRoles` doesn't have. */
export function checkSkill(path: string, text: string, knownRoles: readonly string[]): SkillCheck {
  const result = parseSkill(path, text)
  if (!result.ok) return { problems: [result.problem], warnings: [], skill: null }
  const warnings: string[] = []
  if (text.length > WARN_CHARS) {
    warnings.push(`dsh may trim a skill this long when the context is full; keep it under ${WARN_CHARS} characters`)
  }
  for (const role of new Set(result.skill.roles ?? [])) {
    if (!knownRoles.includes(role)) warnings.push(`role "${role}" isn't a role dish knows (${knownRoles.join(', ')})`)
  }
  return { problems: [], warnings, skill: result.skill }
}

/** Whether `role` is offered the skill: every role if it names none, otherwise those it names. */
export function offeredTo(skill: Pick<ParsedSkill, 'roles'>, role: string): boolean {
  return skill.roles === null || skill.roles.includes(role)
}

/**
 * Why `text` can't be the skill at `path`, or `undefined` if it can: the namespace's validator. The store puts
 * the path in front of every message it shows, so the path is left off the sentence `parseSkill` gives. The
 * store's own limits (size, secrets) are its business, not this function's.
 */
export function validate(path: string, text: string): string | undefined {
  const result = parseSkill(path, text)
  if (result.ok) return undefined
  const prefix = `${path}: `
  return result.problem.startsWith(prefix) ? result.problem.slice(prefix.length) : result.problem
}

/** The claim on the config store, for `owner`: the whole `skills/` subtree, where an agent may only propose. */
export function namespaceSpec(owner: string): NamespaceSpec {
  return { prefix: SKILLS_PREFIX, owner, agent: 'propose', validate }
}
