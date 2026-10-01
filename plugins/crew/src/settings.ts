/**
 * `crew.yaml`: the roles, tiers, models and limits of the crew, as one document in the config store.
 *
 * `parseSettings` turns the text into `CrewSettings`, or says what is wrong with it, naming the YAML path. The
 * store applies the same check through `CREW_SPEC`, so neither a person nor an agent can save a file that doesn't
 * pass. Everything is plain data and no dsh is needed, so the rules can be tested alone.
 *
 * What comes back is frozen, and `families` and `roles` have no prototype: a role the model names `constructor`
 * is not found, and a settings object can be shared between calls.
 *
 * @module dish-crew/settings
 */
import { readFileSync } from 'node:fs'
import type { NamespaceSpec } from 'dish-config'
import { JSON_SCHEMA, load, YAMLException } from 'js-yaml'

/** The two sizes of model a family has. */
export type Tier = 'strong' | 'mid'

/** The model a family uses at each tier. */
export interface FamilySettings {
  strong: string
  mid: string
}

export interface Limits {
  /** Crew children running at once, per session. */
  running: number
  /** Of those, children of roles with `writes: true`. */
  writers: number
  /** Delegations a session may start, ever. */
  perSession: number
}

export interface RoleSettings {
  tier: Tier
  /** The family the role's model comes from. Absent for the reviewer, which takes the first of `reviewerFamilies` that isn't the reviewed work's. */
  family?: string
  writes: boolean
  /** The reviewer: exactly one role has it. */
  reviews: boolean
  /** Tool names. A name a child can't see when it starts is left out then, so these are only a ceiling. */
  tools: string[]
}

export interface CrewSettings {
  provider: string
  /** Model ids per family and tier; a family's models identify it. */
  families: Record<string, FamilySettings>
  reviewerFamilies: string[]
  limits: Limits
  roles: Record<string, RoleSettings>
}

export type ParseResult = { ok: true, settings: CrewSettings } | { ok: false, problem: string }

const TIERS: readonly Tier[] = ['strong', 'mid']
const TOP_KEYS = ['provider', 'families', 'reviewerFamilies', 'limits', 'roles'] as const
const LIMIT_KEYS = ['running', 'writers', 'perSession'] as const
const ROLE_KEYS = ['tier', 'family', 'writes', 'reviews', 'tools'] as const

/** What a role may be called: the prompts grammar, since each role has a prompt document by its name. */
const ROLE_NAME = /^[a-z][a-z0-9-]*$/
/** `common` and `main` have documents of their own, so no crew role can have those names. */
const RESERVED = ['common', 'main']

/** The longest a value or a name is shown in a message, so one bad key can't make a message the size of the file. */
const SHOWN = 40
/** The most names listed in a message. */
const LISTED = 12
/** The longest a YAML parser's own reason is shown. */
const REASON = 160

/** A mapping with no prototype, so a name like `constructor` or `__proto__` is an ordinary key. */
function dictionary<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>
}

function truncate(text: string, length = SHOWN): string {
  return text.length > length ? `${text.slice(0, length)}…` : text
}

/** `value` as a message shows it: a string quoted and cut short, a collection by its kind, anything else as it is. */
function shown(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(truncate(value))
  if (Array.isArray(value)) return 'a list'
  if (value !== null && typeof value === 'object') return 'a mapping'
  return String(value)
}

/** The first few of `names`, for a message. */
function listed(names: readonly string[]): string {
  if (names.length === 0) return 'none'
  const head = names.slice(0, LISTED).map(name => truncate(name)).join(', ')
  return names.length > LISTED ? `${head}, …` : head
}

/** The path of `key` under `path`: `roles.coder`, or `roles["odd name"]` for a name that isn't plain. */
function at(path: string, key: string): string {
  const cut = truncate(key)
  if (/^[A-Za-z0-9_-]+$/.test(key) && cut === key) return path === '' ? key : `${path}.${key}`
  return `${path}[${JSON.stringify(cut)}]`
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

function nonEmptyString(value: unknown, path: string, what: string): string {
  if (typeof value !== 'string' || value.trim() === '') refuse(path, `must be ${what} (got ${shown(value)})`)
  return value
}

function parseFamilies(value: unknown): Record<string, FamilySettings> {
  if (!isMapping(value)) refuse('families', `must be a mapping of family name to its strong and mid models (got ${shown(value)})`)
  const families = dictionary<FamilySettings>()
  // The family each model is listed under: a model is how a family is told, so it can't be in two.
  const owner = new Map<string, string>()
  for (const [name, models] of Object.entries(value)) {
    const path = at('families', name)
    if (name === '') refuse(path, 'a family needs a name')
    if (!isMapping(models)) refuse(path, `must be a mapping with strong and mid models (got ${shown(models)})`)
    noOtherKeys(models, path, TIERS)
    const family = {} as FamilySettings
    for (const tier of TIERS) {
      const model = nonEmptyString(required(models, tier, path, 'a model id'), at(path, tier), 'a model id')
      const other = owner.get(model)
      if (other !== undefined && other !== name) {
        refuse(at(path, tier), `${shown(model)} is also in family ${truncate(other)}; a model belongs to one family`)
      }
      owner.set(model, name)
      family[tier] = model
    }
    families[name] = family
  }
  return families
}

function parseReviewerFamilies(value: unknown, families: Record<string, FamilySettings>): string[] {
  if (!Array.isArray(value)) refuse('reviewerFamilies', `must be a list of family names (got ${shown(value)})`)
  return value.map((item, index) => {
    const path = `reviewerFamilies[${index}]`
    if (typeof item !== 'string') refuse(path, `must be a family name (got ${shown(item)})`)
    if (families[item] === undefined) refuse(path, `${shown(item)} is not a family (families: ${listed(Object.keys(families))})`)
    return item
  })
}

function parseLimits(value: unknown): Limits {
  if (!isMapping(value)) refuse('limits', `must be a mapping with ${LIMIT_KEYS.join(', ')} (got ${shown(value)})`)
  noOtherKeys(value, 'limits', LIMIT_KEYS)
  const limits = {} as Limits
  for (const key of LIMIT_KEYS) {
    const limit = required(value, key, 'limits', 'a positive integer')
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1) refuse(at('limits', key), `${shown(limit)} is not a positive integer`)
    limits[key] = limit
  }
  if (limits.writers > limits.running) refuse('limits.writers', `${limits.writers} is more than limits.running (${limits.running})`)
  return limits
}

function parseRole(name: string, value: unknown, families: Record<string, FamilySettings>): RoleSettings {
  const path = at('roles', name)
  if (!ROLE_NAME.test(name)) {
    refuse(path, `${shown(name)} is not a valid role name (lowercase letters, digits and hyphens, starting with a letter)`)
  }
  if (RESERVED.includes(name)) refuse(path, `${shown(name)} is reserved: ${RESERVED.join(' and ')} have prompts of their own`)
  if (!isMapping(value)) refuse(path, `must be a mapping with ${ROLE_KEYS.join(', ')} (got ${shown(value)})`)
  noOtherKeys(value, path, ROLE_KEYS)

  const tier = required(value, 'tier', path, TIERS.join(' or '))
  if (typeof tier !== 'string') refuse(at(path, 'tier'), `must be ${TIERS.join(' or ')} (got ${shown(tier)})`)
  if (!(TIERS as readonly string[]).includes(tier)) refuse(at(path, 'tier'), `${shown(tier)} is not a tier (tiers: ${TIERS.join(', ')})`)

  const flag = (key: 'writes' | 'reviews'): boolean => {
    const flagged = value[key]
    if (flagged === undefined) return false
    if (typeof flagged !== 'boolean') refuse(at(path, key), `must be true or false (got ${shown(flagged)})`)
    return flagged
  }
  const writes = flag('writes')
  const reviews = flag('reviews')

  let family: string | undefined
  if (reviews) {
    if (value.family !== undefined) refuse(at(path, 'family'), 'the reviewer takes its family from reviewerFamilies; remove this')
  } else {
    const named = required(value, 'family', path, `families: ${listed(Object.keys(families))}`)
    if (typeof named !== 'string') refuse(at(path, 'family'), `must be a family name (got ${shown(named)})`)
    if (families[named] === undefined) refuse(at(path, 'family'), `${shown(named)} is not a family (families: ${listed(Object.keys(families))})`)
    family = named
  }

  const listing = required(value, 'tools', path, 'a list of tool names')
  if (!Array.isArray(listing)) refuse(at(path, 'tools'), `must be a list of tool names (got ${shown(listing)})`)
  const tools = listing.map((tool, index) => nonEmptyString(tool, `${at(path, 'tools')}[${index}]`, 'a non-empty tool name'))

  return { tier: tier as Tier, ...family === undefined ? {} : { family }, writes, reviews, tools }
}

function parseRoles(value: unknown, families: Record<string, FamilySettings>): Record<string, RoleSettings> {
  if (!isMapping(value)) refuse('roles', `must be a mapping of role name to its settings (got ${shown(value)})`)
  const roles = dictionary<RoleSettings>()
  for (const [name, role] of Object.entries(value)) roles[name] = parseRole(name, role, families)
  const reviewers = Object.keys(roles).filter(name => roles[name]!.reviews)
  if (reviewers.length === 0) refuse('roles', 'no role sets reviews: true; exactly one must')
  if (reviewers.length > 1) refuse('roles', `more than one role sets reviews: true (${listed(reviewers)}); exactly one may`)
  return roles
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
    return `crew.yaml is not valid YAML${where}: ${truncate(error.reason, REASON)}`
  }
  return `crew.yaml is not valid YAML: ${truncate(error instanceof Error ? error.message : String(error), REASON)}`
}

/**
 * Parse and check a `crew.yaml`. YAML tags aren't accepted (the document is read with the JSON schema), unknown keys are
 * refused at every level, and every rule of the spec's Validation section holds. The first problem found is the one
 * returned, named by its path in the file.
 */
export function parseSettings(text: string): ParseResult {
  let document: unknown
  try {
    document = load(text, { schema: JSON_SCHEMA })
  } catch (error) {
    return { ok: false, problem: yamlProblem(error) }
  }
  try {
    if (document === undefined || (document === null && blank(text))) refuse('', 'crew.yaml is empty')
    if (!isMapping(document)) refuse('', `crew.yaml must be a mapping of settings (got ${shown(document)})`)
    noOtherKeys(document, '', TOP_KEYS)
    const provider = nonEmptyString(required(document, 'provider', '', 'a provider id'), 'provider', 'a provider id')
    const families = parseFamilies(required(document, 'families', '', 'family names, each with strong and mid models'))
    const reviewerFamilies = parseReviewerFamilies(required(document, 'reviewerFamilies', '', 'a list of family names'), families)
    const limits = parseLimits(required(document, 'limits', '', 'running, writers and perSession'))
    const roles = parseRoles(required(document, 'roles', '', 'role names, each with its settings'), families)
    return { ok: true, settings: deepFreeze({ provider, families, reviewerFamilies, limits, roles }) }
  } catch (error) {
    if (error instanceof Problem) return { ok: false, problem: error.message }
    throw error
  }
}

/** The shipped `crew.yaml`, as a file in the store. A missing file is a broken install, so it throws when this module loads. */
export const DEFAULT_TEXT: string = readFileSync(new URL('../defaults/crew.yaml', import.meta.url), 'utf8')

/** The shipped file as settings. A shipped file that doesn't pass its own check is a broken install too. */
export const DEFAULT_SETTINGS: CrewSettings = (() => {
  const parsed = parseSettings(DEFAULT_TEXT)
  if (!parsed.ok) throw new Error(`the shipped defaults/crew.yaml is not valid: ${parsed.problem}`)
  return parsed.settings
})()

/** The namespace `dish-crew` claims in the config store: `crew.yaml`, which an agent may write when asked and a person reviews in History. */
export const CREW_SPEC: NamespaceSpec = {
  prefix: 'crew.yaml',
  owner: 'dish-crew',
  agent: 'write',
  validate: (_path, text) => {
    const parsed = parseSettings(text)
    return parsed.ok ? undefined : parsed.problem
  },
}
