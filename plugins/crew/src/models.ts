/**
 * Which model a child runs on: model families, the route a role gets, and the reviewer rule.
 *
 * A reviewer is never in the model family of the work it reviews, whichever way it's asked for. `chooseRoute` is where
 * that is decided, and `familyOf` is how the reviewed work's family is told. Both are plain functions over
 * `CrewSettings`, so the rules can be tested without dsh.
 *
 * `settings.families` and `settings.roles` have no prototype, and every name that reaches a lookup here can come from
 * the model, so each lookup is for an own property (`Object.hasOwn` is safe on those objects as well as on ordinary
 * ones): a role called `constructor` is not found unless the file has it.
 *
 * @module dish-crew/models
 */
import type { CrewSettings, RoleSettings, Tier } from './settings.ts'

/** Where and on what a child runs. */
export interface Route {
  provider: string
  model: string
  /** The family the model is in: a key of `settings.families`. */
  family: string
}

export type RouteResult = { ok: true, route: Route } | { ok: false, problem: string }

export interface ChooseRouteArgs {
  settings: CrewSettings
  role: string
  /** A model id to use instead of the default, which must be one the families list. Empty means none. */
  override?: string
  /** The family of the work the reviewer reviews: required for the reviewer, ignored for any other role. */
  reviewedFamily?: string
}

/** The families a model id's prefix tells, for a model no family lists. */
const PREFIXES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^claude/i, 'anthropic'],
  [/^(?:gpt|o\d|codex)/i, 'openai'],
  [/^gemini/i, 'google'],
  [/^grok/i, 'xai'],
]

/** The most names listed in a problem, so a long file can't make a long message. */
const LISTED = 12
/** The longest a name from the caller is shown. */
const SHOWN = 40

function truncate(text: string, length = SHOWN): string {
  return text.length > length ? `${text.slice(0, length)}…` : text
}

/** `value` as a message shows what a caller gave: quoted and cut short. */
function quoted(value: string): string {
  return JSON.stringify(truncate(value))
}

function listed(names: readonly string[]): string {
  const head = names.slice(0, LISTED).join(', ')
  return names.length > LISTED ? `${head}, …` : head
}

/** `text` if it's a string with something in it, trimmed; else `undefined`. Models fill every optional field, often with ''. */
function given(text: unknown): string | undefined {
  if (typeof text !== 'string') return undefined
  const trimmed = text.trim()
  return trimmed === '' ? undefined : trimmed
}

/** Whether two family names are the same family. Case and padding don't make a different family, so they can't get a reviewer past the rule. */
function sameFamily(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

/** The settings' families as `[name, models]`, in the file's order. */
function familyEntries(settings: CrewSettings): Array<[string, readonly string[]]> {
  return Object.entries(settings.families).map(([name, family]) => [name, [...new Set([family.strong, family.mid])]])
}

/** Every model the families list, once, family by family. */
export function offeredModels(settings: CrewSettings): string[] {
  return familyEntries(settings).flatMap(([, models]) => models)
}

/** The models offered as a message lists them, family by family, leaving out `except`'s family. */
function offered(settings: CrewSettings, except?: string): string {
  const entries = familyEntries(settings)
    .filter(([name]) => except === undefined || !sameFamily(name, except))
    .map(([name, models]) => `${name}: ${models.join(', ')}`)
  const head = entries.slice(0, LISTED).join('; ')
  return entries.length > LISTED ? `${head}; …` : head
}

/** The family whose tiers list `model`, if one does. */
function listedFamily(settings: CrewSettings, model: string): string | undefined {
  for (const [name, models] of familyEntries(settings)) {
    if (models.includes(model)) return name
  }
  return undefined
}

/** The model `family` uses at `tier`, if `family` is one the file has. */
function modelAt(settings: CrewSettings, family: string, tier: Tier): string | undefined {
  if (!Object.hasOwn(settings.families, family)) return undefined
  return settings.families[family]![tier]
}

/**
 * The family a model is in. The families in `crew.yaml` come first: a model one of them lists is in that family. Only
 * a model no family lists is told by its prefix (`claude` is anthropic; `gpt`, `o<digit>` and `codex` are openai;
 * `gemini` is google; `grok` is xai). Otherwise it's `undefined`.
 */
export function familyOf(model: string, settings: CrewSettings): string | undefined {
  const listedIn = listedFamily(settings, model)
  if (listedIn !== undefined) return listedIn
  for (const [prefix, family] of PREFIXES) {
    if (prefix.test(model)) return family
  }
  return undefined
}

function ok(settings: CrewSettings, model: string, family: string): RouteResult {
  return { ok: true, route: { provider: settings.provider, model, family } }
}

function refuse(problem: string): RouteResult {
  return { ok: false, problem }
}

function ordinaryRoute(settings: CrewSettings, name: string, role: RoleSettings, override: string | undefined): RouteResult {
  if (override !== undefined) {
    const family = listedFamily(settings, override)
    if (family === undefined) {
      return refuse(`model ${quoted(override)} is not one crew.yaml offers. Models offered, by family: ${offered(settings)}. Or leave model out for the ${name} role's default.`)
    }
    return ok(settings, override, family)
  }
  const family = role.family
  const model = family === undefined ? undefined : modelAt(settings, family, role.tier)
  if (family === undefined || model === undefined) {
    return refuse(`role ${name} has no model to run on: ${family === undefined ? 'it has no family' : `family ${quoted(family)} is not one of ${listed(Object.keys(settings.families))}`}. Fix roles.${name} in crew.yaml, or give model one of these, by family: ${offered(settings)}.`)
  }
  return ok(settings, model, family)
}

function reviewerRoute(settings: CrewSettings, name: string, role: RoleSettings, override: string | undefined, reviewedFamily: string | undefined): RouteResult {
  if (reviewedFamily === undefined) {
    return refuse(`the ${name} role runs on a different model family from the work it reviews, so it needs the family of the work and none was given. Set reviews to a crew child's id, or "main" for your own work.`)
  }
  const shown = truncate(reviewedFamily)
  if (override !== undefined) {
    const family = listedFamily(settings, override)
    if (family === undefined) {
      return refuse(`model ${quoted(override)} is not one crew.yaml offers for reviewing ${shown} work. Models offered outside that family: ${offered(settings, reviewedFamily)}. Or leave model out and one is chosen for you.`)
    }
    if (sameFamily(family, reviewedFamily)) {
      const others = offered(settings, reviewedFamily)
      return refuse(`model ${quoted(override)} is in family ${family}, the family of the work under review; the ${name} must run on a different family. `
        + (others === '' ? 'crew.yaml offers no model in another family; add a family to it.' : `Models offered outside it: ${others}. Or leave model out and one is chosen for you.`))
    }
    return ok(settings, override, family)
  }
  const family = settings.reviewerFamilies.find(candidate => !sameFamily(candidate, reviewedFamily) && modelAt(settings, candidate, role.tier) !== undefined)
  if (family === undefined) return refuse(`no reviewer family differs from ${shown}; add one to reviewerFamilies in crew.yaml`)
  return ok(settings, modelAt(settings, family, role.tier)!, family)
}

/**
 * The route for a delegation: the provider and model a child of `role` runs on.
 *
 * - **An ordinary role** runs on its own family at its own tier. `override` replaces the model with one the families
 *   list; the route's family is that model's.
 * - **The reviewer** (the role with `reviews: true`, whatever it's called) needs `reviewedFamily`. It runs on the first
 *   of `reviewerFamilies` that isn't that family, at its tier. An `override` is accepted only if the families list it
 *   and its family is a different one.
 *
 * It never throws. A refusal is a `problem` the model can act on, and it names what to use instead.
 */
export function chooseRoute(args: ChooseRouteArgs): RouteResult {
  const { settings, role: name } = args
  if (!Object.hasOwn(settings.roles, name)) {
    return refuse(`unknown role ${quoted(name)}; the roles in crew.yaml are: ${listed(Object.keys(settings.roles))}. Use one of those.`)
  }
  const role = settings.roles[name]!
  const override = given(args.override)
  return role.reviews
    ? reviewerRoute(settings, name, role, override, given(args.reviewedFamily))
    : ordinaryRoute(settings, name, role, override)
}
