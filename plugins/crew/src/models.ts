/**
 * Which model a child runs on: model families, the route a role gets, and the reviewer rule.
 *
 * A reviewer is never in the model family of the work it reviews, whichever way it's asked for. `chooseRoute` is where
 * that is decided. Both it and `familyOf` are plain functions over `CrewSettings`, so the rules can be tested without
 * dsh.
 *
 * What counts as the same family is wider than a name. `crew.yaml` calls its families whatever it likes, and the work
 * under review can be on a model it doesn't list at all, so the family *name* of the work may be nothing the file has.
 * A reviewer is therefore kept away from the work's vendor too (`vendorsOf`: Claude, GPT, Gemini, Grok, Qwen, DeepSeek,
 * Kimi, GLM, Llama and Mistral, told by model id), so Claude reviewing Claude is refused whatever the file calls its
 * families. A model that names no vendor at all (`sonnet-x`) and that no family lists is its own family: it excludes
 * nothing, so the first of `reviewerFamilies` reviews it. The risk is an alias that hides its vendor, which can then get
 * a reviewer of the same vendor; listing it in a family of `crew.yaml` closes that.
 *
 * Where a model runs is a separate matter from which family it is in. A family may have a provider of its own
 * (`families.<name>.provider`), and a route takes it; nothing about the reviewer rule reads a provider, only model ids.
 *
 * `settings.families` and `settings.roles` have no prototype, and every name that reaches a lookup here can come from
 * the model, so each lookup is for an own property (`Object.hasOwn` is safe on those objects as well as on ordinary
 * ones): a role called `constructor` is not found unless the file has it.
 *
 * @module dish-crew/models
 */
import type { CrewSettings, RoleSettings, Tier } from './settings.ts'
import { LISTED, listed, truncate } from './text.ts'

/** Where and on what a child runs. */
export interface Route {
  /** The provider of the model's family (`families.<name>.provider`), or else the file's own. */
  provider: string
  model: string
  /** The family the model is in: a key of `settings.families`. */
  family: string
}

export type RouteResult = { ok: true, route: Route } | { ok: false, problem: string }

/** The work a reviewer reviews, by the model it ran on and/or the name of its family. */
export interface ReviewedWork {
  /** The model id the work ran on, listed in `crew.yaml` or not. */
  model?: string
  /** A family name: one of the file's, or a vendor's (`anthropic`), as `familyOf` says of a model the file doesn't list. */
  family?: string
}

export interface ChooseRouteArgs {
  settings: CrewSettings
  role: string
  /** A model id to use instead of the default, which must be one the families list. Empty means none. */
  override?: string
  /**
   * The work the reviewer reviews: required for the reviewer (a model or a family, empty strings being none), and the
   * reviewer is kept away from every family and vendor either points at. Ignored for any other role.
   */
  reviewed?: ReviewedWork
}

/** The vendors, by the words a token of a model id has: the vendor's own name, or what its models are called. */
const VENDORS: ReadonlyArray<readonly [vendor: string, token: RegExp]> = [
  ['anthropic', /^(?:anthropic$|claude)/],
  ['openai', /^(?:openai$|codex|o\d)|gpt/],
  ['google', /^(?:google$|gemini)/],
  ['xai', /^(?:xai$|grok)/],
  ['alibaba', /^(?:alibaba$|qwen|qwq)/],
  ['deepseek', /^deepseek/],
  ['moonshot', /^(?:moonshot|kimi)/],
  ['zhipu', /^(?:zhipu$|glm|chatglm)/],
  ['meta', /^(?:meta$|llama)/],
  ['mistral', /^(?:mistral|mixtral|codestral|devstral|magistral|ministral|pixtral)/],
]

/** What separates the tokens of a model id: provider and host prefixes, versions, regions and fine-tune markers all come between them. */
const TOKEN_BREAK = /[\s/.:@_-]+/

/** `value` as a message shows what a caller gave: quoted and cut short. */
function quoted(value: string): string {
  return JSON.stringify(truncate(value))
}

/** `text` if it's a string with something in it, trimmed; else `undefined`. Models fill every optional field, often with ''. */
function given(text: unknown): string | undefined {
  if (typeof text !== 'string') return undefined
  const trimmed = text.trim()
  return trimmed === '' ? undefined : trimmed
}

/** A family name as it's compared: case and padding don't make a different family, so they can't get a reviewer past the rule. */
function folded(name: string): string {
  return name.trim().toLowerCase()
}

/**
 * The vendors a model id belongs to. The id is cut into tokens at `/ . : @ _ -` and whitespace, and a token names a
 * vendor if it is the vendor's name (`anthropic`), starts with what its models are called (`claude`; `codex`, `o<digit>`;
 * `gemini`; `grok`; `qwen`; `deepseek`; `kimi`; `glm`; `llama`; `mistral` and its kin: the `VENDORS` table) or, for
 * OpenAI's, contains `gpt` (`chatgpt`). Every token counts, wherever it sits, so a provider
 * (`github-copilot/claude-opus-4.7`), a host (`azure-gpt-4o`, `us.anthropic.claude-3-5-sonnet…`), an alias
 * (`my-claude`) or a fine-tune (`ft:gpt-4o:…`) all name their vendor. An id can name more than one vendor, which only
 * widens what a reviewer is kept away from, and one that names none (`sonnet-x`) names none.
 */
export function vendorsOf(model: string): Set<string> {
  const found = new Set<string>()
  for (const token of model.toLowerCase().split(TOKEN_BREAK)) {
    for (const [vendor, pattern] of VENDORS) {
      if (pattern.test(token)) found.add(vendor)
    }
  }
  return found
}

/** The settings' families as `[name, models]`, in the file's order. */
function familyEntries(settings: CrewSettings): Array<[string, readonly string[]]> {
  return Object.entries(settings.families).map(([name, family]) => [name, [...new Set([family.strong, family.mid])]])
}

/** The models a family of the file lists, whose name is `name` by the reviewer rule's reckoning (case and padding aside). */
function modelsOf(settings: CrewSettings, name: string): string[] {
  return familyEntries(settings).filter(([candidate]) => folded(candidate) === folded(name)).flatMap(([, models]) => models)
}

/** The provider `family` has of its own, if it is a family of the file that has one. Looked up as an own property, like every family name here. */
function ownProvider(settings: CrewSettings, family: string): string | undefined {
  return Object.hasOwn(settings.families, family) ? settings.families[family]!.provider : undefined
}

/** The provider `family` runs on: its own, else the file's. */
function providerOf(settings: CrewSettings, family: string): string {
  return ownProvider(settings, family) ?? settings.provider
}

/**
 * `model` as a message offers it for a caller to give back. A family with a provider of its own says where its models
 * run, as `provider/model`; one on the file's provider is the bare id, which is how it has always been shown.
 */
function offeredName(settings: CrewSettings, family: string, model: string): string {
  const own = ownProvider(settings, family)
  return own === undefined ? model : `${own}/${model}`
}

/** Every model the families list, once, family by family, each as a message offers it (`provider/model` for a family with a provider of its own). */
export function offeredModels(settings: CrewSettings): string[] {
  return familyEntries(settings).flatMap(([name, models]) => models.map(model => offeredName(settings, name, model)))
}

/** The models offered as a message lists them, family by family, leaving out the families `skip` says to. */
function offered(settings: CrewSettings, skip: (family: string) => boolean = () => false): string {
  const entries = familyEntries(settings)
    .filter(([name]) => !skip(name))
    .map(([name, models]) => `${name}: ${models.map(model => offeredName(settings, name, model)).join(', ')}`)
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

/**
 * The model and family `text` names, if it names a listed one: the bare model id, which is how a model has always been
 * given, or what an offer shows for it, `provider/model`, when its family has a provider of its own. A bare id comes
 * first, so an id with a slash in it is itself. The provider is no part of the model: it is its family's, and a model is
 * in one family only. The settings refuse two models that would have one name (an id that is another model's
 * `provider/model`), so neither spelling can mean a model the listing didn't say.
 */
function offeredModel(settings: CrewSettings, text: string): { model: string, family: string } | undefined {
  const bare = listedFamily(settings, text)
  if (bare !== undefined) return { model: text, family: bare }
  for (const [family, models] of familyEntries(settings)) {
    for (const model of models) {
      if (offeredName(settings, family, model) === text) return { model, family }
    }
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
 * a model no family lists is told by its vendor (see `vendorsOf`): `anthropic`, `openai`, `google`, `xai`, `alibaba`,
 * `deepseek`, `moonshot`, `zhipu`, `meta` or `mistral`, whatever the file calls its own families. A model that names no
 * vendor, or two, has no family: `undefined`.
 */
export function familyOf(model: string, settings: CrewSettings): string | undefined {
  const listedIn = listedFamily(settings, model)
  if (listedIn !== undefined) return listedIn
  const vendors = vendorsOf(model)
  return vendors.size === 1 ? [...vendors][0] : undefined
}

function ok(settings: CrewSettings, model: string, family: string): RouteResult {
  return { ok: true, route: { provider: providerOf(settings, family), model, family } }
}

function refuse(problem: string): RouteResult {
  return { ok: false, problem }
}

function ordinaryRoute(settings: CrewSettings, name: string, role: RoleSettings, override: string | undefined): RouteResult {
  if (override !== undefined) {
    const found = offeredModel(settings, override)
    if (found === undefined) {
      return refuse(`model ${quoted(override)} is not one crew.yaml offers. Models offered, by family: ${offered(settings)}. Or leave model out for the ${name} role's default.`)
    }
    return ok(settings, found.model, found.family)
  }
  const family = role.family
  const model = family === undefined ? undefined : modelAt(settings, family, role.tier)
  if (family === undefined || model === undefined) {
    return refuse(`role ${name} has no model to run on: ${family === undefined ? 'it has no family' : `family ${quoted(family)} is not one of ${listed(Object.keys(settings.families))}`}. Fix roles.${name} in crew.yaml, or give model one of these, by family: ${offered(settings)}.`)
  }
  return ok(settings, model, family)
}

/** What a reviewer has to keep away from, for one piece of reviewed work. */
interface Avoided {
  /** The reviewed work as a message names it: its family, or the vendor of its model. */
  label: string
  /** Whether a family of the file is one the reviewer must not run in. */
  excludes: (family: string) => boolean
}

/**
 * What a reviewer must avoid for work on `model` and/or in `family`. A family of the file is out if any of these holds:
 * - its name is the work's family, or the family of the file that lists the work's model (case and padding aside);
 * - it lists a model of a vendor the work is on. That is the vendor of the work's model, of any model of the work's
 *   family (when that is a family of the file), or the work's family name itself when that is a vendor's (`anthropic`).
 *
 * A family that lists models of two vendors counts as both. A model the file doesn't list, whose id names no vendor,
 * with no family given to say, is its own family: it is labelled by its id and excludes nothing.
 */
function avoided(settings: CrewSettings, model: string | undefined, family: string | undefined): Avoided {
  const names = new Set<string>()
  const vendors = new Set<string>()
  const reviewedModels: string[] = []
  let label = family
  if (family !== undefined) {
    names.add(folded(family))
    reviewedModels.push(...modelsOf(settings, family))
    if (VENDORS.some(([vendor]) => vendor === folded(family))) vendors.add(folded(family))
  }
  if (model !== undefined) {
    reviewedModels.push(model)
    const home = listedFamily(settings, model)
    if (home !== undefined) {
      names.add(folded(home))
      reviewedModels.push(...modelsOf(settings, home))
    }
    const own = vendorsOf(model)
    label ??= home ?? [...own][0] ?? truncate(model)
  }
  for (const reviewed of reviewedModels) for (const vendor of vendorsOf(reviewed)) vendors.add(vendor)
  return {
    label: truncate(label ?? ''),
    excludes: (candidate) => {
      if (names.has(folded(candidate))) return true
      return modelsOf(settings, candidate).some(listedModel => [...vendorsOf(listedModel)].some(vendor => vendors.has(vendor)))
    },
  }
}

function reviewerRoute(settings: CrewSettings, name: string, role: RoleSettings, override: string | undefined, reviewed: ReviewedWork | undefined): RouteResult {
  const model = given(reviewed?.model)
  const family = given(reviewed?.family)
  if (model === undefined && family === undefined) {
    return refuse(`the ${name} role runs on a different model family from the work it reviews, so it needs the model or family of the work and none was given. Set reviews to a crew child's id, or "main" for your own work.`)
  }
  const avoid = avoided(settings, model, family)
  if (override !== undefined) {
    const found = offeredModel(settings, override)
    if (found === undefined) {
      return refuse(`model ${quoted(override)} is not one crew.yaml offers for reviewing ${avoid.label} work. Models offered outside that family: ${offered(settings, avoid.excludes)}. Or leave model out and one is chosen for you.`)
    }
    const home = found.family
    if (avoid.excludes(home)) {
      const others = offered(settings, avoid.excludes)
      return refuse(`model ${quoted(override)} is in family ${home}, which counts as the family of the work under review (${avoid.label}); the ${name} must run on a different family. `
        + (others === '' ? 'crew.yaml offers no model in another family; add a family to it.' : `Models offered outside it: ${others}. Or leave model out and one is chosen for you.`))
    }
    return ok(settings, found.model, home)
  }
  const chosen = settings.reviewerFamilies.find(candidate => !avoid.excludes(candidate) && modelAt(settings, candidate, role.tier) !== undefined)
  if (chosen === undefined) return refuse(`no reviewer family differs from ${avoid.label}; add one to reviewerFamilies in crew.yaml`)
  return ok(settings, modelAt(settings, chosen, role.tier)!, chosen)
}

/**
 * The route for a delegation: the provider and model a child of `role` runs on.
 *
 * - **An ordinary role** runs on its own family at its own tier. `override` replaces the model with one the families
 *   list (the bare id, or `provider/model` as the refusals show it); the route's family is that model's.
 * - **The reviewer** (the role with `reviews: true`, whatever it's called) needs `reviewed`: the model and/or family of
 *   the work. It runs on the first of `reviewerFamilies` that the work isn't in, at its tier. An `override` is accepted
 *   only if the families list it and its family is one the work isn't in. "In" is by name and by vendor (see `avoided`),
 *   so the file's names for its families can't hide a Claude reviewing Claude.
 * - **The provider** of a route is its family's own (`families.<name>.provider`), else the file's. An override's is the one
 *   of the family its model is in. It is where the model runs and nothing more: the reviewer rule is about models, so
 *   a provider's name never moves a family in or out of a vendor.
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
    ? reviewerRoute(settings, name, role, override, args.reviewed)
    : ordinaryRoute(settings, name, role, override)
}
