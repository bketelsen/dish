/**
 * Offering the skills to agents: two providers for dsh's skill registry (`ctx.skills`, `@deepseek-ai/dsh-skill`).
 *
 * The registry merges the global layer, then the agent's preset's layer, then the agent's own layer, and a nearer
 * layer's entry replaces a farther one of the same name. A provider reads only `cwd` and `signal` of a lookup, never
 * the scope, so who is offered what is decided by where a provider is registered:
 *
 * - **`dish`, global** (the host plugin registers it while `skills` is there): every valid skill, for the `/` menu
 *   everywhere, and never for a model (`modelInvocable: false`).
 * - **`dish-role`, in an agent's own layer** (`watchAgents` registers one on every agent): while the agent is on a
 *   configured preset, the skills of its role, with each skill's own invocation flags; otherwise nothing. Its entries
 *   replace the global ones for that agent alone, and a skill outside the role stays the global, menu-only entry,
 *   which the `skill` tool refuses. The preset is read at every `list()`, not once: dsh can move a blank agent to
 *   another preset (`agentPresets.select`) without announcing it again, and the registry lists afresh when it does,
 *   because the agent's scope chain is part of its cache key.
 *
 * Both read the `dishSkills` service on every `list()` and `get()`, and both subscribe their `invalidate` to the
 * service's changes, so an edit in the store reaches every catalog at the agent's next step. A candidate is built
 * only from a document that dsh would accept: the registry checks every candidate outside its guard around a
 * provider, so one it refuses would fail the whole catalog, every provider's skills with it. A document that
 * wouldn't pass is left out and logged.
 *
 * Nothing here throws into dsh: `agent/created` is serial and awaited before the agent runs, and a provider's
 * trouble is an incomplete catalog, which the registry asks for again at the next step.
 *
 * A store that is there but fails (`Catalog.degraded`) is the same trouble with a stopgap: the shipped skills are
 * listed, so an agent still has skills to load, but the observation is incomplete. dsh's registry never caches an
 * incomplete one, so the next step reads the store again and the user's skills are back as soon as it answers; and
 * the `skill` tool's catalog message (dsh-tool-skill) skips an incomplete snapshot, so an agent keeps the catalog it
 * was last shown (the user's, if the store answered before) and one that has none yet is shown none until the store
 * answers. Its prompt names its role's skills, and the `skill` tool loads them from the stopgap meanwhile.
 *
 * @module dish-skills/providers
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {
  SkillCandidate, SkillDefinition, SkillInvocationPolicy, SkillProvider, SkillProviderControl, SkillProviderObservation,
} from '@deepseek-ai/dsh-skill'
import { isTopLevelAgent } from 'dish-kit'
import type { Catalog, DishSkills, SkillDoc } from './service.ts'
import { isSkillName, offeredTo } from './skill.ts'

/** The global provider's name: every skill, menu-only. */
export const GLOBAL_PROVIDER = 'dish'
/** The agent-layer provider's name: the agent's role's skills. */
export const ROLE_PROVIDER = 'dish-role'
/** Within one layer a lower rank wins a name. Both are below dsh's bundled skills (600). */
export const GLOBAL_RANK = 350
export const ROLE_RANK = 250
/** A candidate's `source` when its document came from the config store. */
export const STORE_SOURCE = 'dish-config'
/** A candidate's `source` when the store isn't there and the shipped skills are served. */
export const DEFAULT_SOURCE = 'dish-default'

/** A candidate's `locator`: the skill's name, and the commit of the catalog it was listed from (`null`: the shipped skills). */
export interface SkillLocator {
  readonly commit: string | null
  readonly name: string
}

export interface ProviderLogger {
  warn(format: string, ...args: unknown[]): void
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The most messages remembered as told for one logger: a trouble that keeps changing its words is not worth a list that grows. */
const MAX_TOLD = 100

/**
 * Says each message once for each logger, however many providers say it: every agent has a role provider, and the
 * same bad document or the same failing store would otherwise be told once per agent.
 */
const toldBy = new WeakMap<ProviderLogger, Set<string>>()

/** Tell `format` unless `key` was told to `logger` already. Returns whether this call told it. */
function tellOnce(logger: ProviderLogger | undefined, key: string, format: string, ...args: unknown[]): boolean {
  if (logger === undefined) return false
  let told = toldBy.get(logger)
  if (told === undefined) toldBy.set(logger, told = new Set())
  if (told.has(key)) return false
  if (told.size >= MAX_TOLD) told.clear()
  told.add(key)
  try {
    logger.warn(format, ...args)
  } catch {
    // Logging is not worth a failed catalog.
  }
  return true
}

/** Forget that `keys` were told, so that the next trouble of the same words is told again: this one is over. */
function forgetTold(logger: ProviderLogger | undefined, keys: Iterable<string>): void {
  const told = logger === undefined ? undefined : toldBy.get(logger)
  if (told === undefined) return
  for (const key of keys) told.delete(key)
}

function isMapping(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Why dsh would refuse `doc` as a candidate or a definition, or `undefined` if it wouldn't. `parseSkill` guarantees
 * all of it for a document from the service; this is the check that a mistake there can't break every agent's catalog.
 */
function unfit(doc: SkillDoc): string | undefined {
  if (typeof doc.name !== 'string' || !isSkillName(doc.name)) return 'its name is not a skill name'
  if (typeof doc.description !== 'string' || doc.description.trim() === '') return 'its description is empty'
  if (typeof doc.modelInvocable !== 'boolean' || typeof doc.userInvocable !== 'boolean') return 'its invocation flags are not true or false'
  if (typeof doc.body !== 'string' || doc.body.trim() === '') return 'its instructions are empty'
  return undefined
}

/** What one provider offers now: the documents, with the commit of the catalog they came from. */
interface Offer {
  commit: string | null
  docs: readonly SkillDoc[]
  /** The catalog was the shipped stopgap for a store that failed: offered, but not as the whole story. */
  degraded?: boolean
}

interface ProviderSpec {
  name: string
  rank: number
  /** The documents this provider offers now. Rejects for an incomplete answer. */
  offer(): Promise<Offer>
  invocation(doc: SkillDoc): SkillInvocationPolicy
}

/** The registry entry of `doc`, with the summary fields a definition repeats. */
function summaryOf(spec: ProviderSpec, doc: SkillDoc, commit: string | null) {
  return {
    name: doc.name,
    description: doc.description,
    invocation: spec.invocation(doc),
    source: commit === null ? DEFAULT_SOURCE : STORE_SOURCE,
    provider: spec.name,
    ...isMapping(doc.metadata) ? { metadata: doc.metadata } : {},
  }
}

/**
 * A provider that lists `spec.offer()`'s fit documents, and loads a candidate by its locator's name from what is
 * offered now. `control.invalidate` is called on every change of the service until the registration goes.
 */
function provider(service: DishSkills, control: SkillProviderControl, spec: ProviderSpec, logger: ProviderLogger | undefined): SkillProvider {
  const stop = service.onChange(control.invalidate)
  if (control.signal.aborted) stop()
  else control.signal.addEventListener('abort', () => { stop() }, { once: true })

  /**
   * The failures this provider told, which it forgets once it answers again. Only its own: another provider that
   * answers (another agent's) says nothing of this one, which may still be failing.
   */
  const told = new Set<string>()
  const failed = (error: unknown): void => {
    const key = `offer:${spec.name}:${describe(error)}`
    if (tellOnce(logger, key, 'the %s skill provider offers nothing for now, and is asked again at the next step: %s', spec.name, describe(error))) told.add(key)
  }
  /** What `spec.offer()` gives, or `undefined` (told) if it failed. */
  const offered = async (): Promise<Offer | undefined> => {
    try {
      const offer = await spec.offer()
      if (told.size > 0) {
        forgetTold(logger, told)
        told.clear()
      }
      return offer
    } catch (error) {
      failed(error)
      return undefined
    }
  }

  /** The fit documents of `offer`, each unfit one left out and told once. */
  const fit = (offer: Offer): SkillDoc[] => offer.docs.filter((doc) => {
    const problem = unfit(doc)
    if (problem === undefined) return true
    const name = typeof doc.name === 'string' ? doc.name : String(doc.path)
    tellOnce(logger, `unfit:${spec.name}:${name}:${problem}`, 'the skill %s is left out of the %s provider: %s', JSON.stringify(name), spec.name, problem)
    return false
  })

  return {
    name: spec.name,
    async list(): Promise<SkillProviderObservation> {
      const offer = await offered()
      if (offer === undefined) return { candidates: [], complete: false }
      const candidates: SkillCandidate[] = fit(offer).map(doc => ({
        ...summaryOf(spec, doc, offer.commit),
        rank: spec.rank,
        locator: { commit: offer.commit, name: doc.name } satisfies SkillLocator,
      }))
      // A degraded catalog is listed all the same, so that the `skill` tool and the menu still have the shipped skills,
      // but it is not complete: the registry doesn't cache it, and dsh's catalog message keeps what it last published.
      return { candidates, complete: offer.degraded !== true }
    },
    // Whatever the locator's commit, the document of that name now: the registry discards a definition whose name is
    // not the candidate's, and a name that went has none. A failure is no skill rather than a throw: dsh loads a skill
    // the user invoked from `/` before the step, and a throw there would fail the step.
    async get(candidate): Promise<SkillDefinition | undefined> {
      const locator = candidate.locator as Partial<SkillLocator> | null | undefined
      const name = typeof locator?.name === 'string' ? locator.name : candidate.name
      const offer = await offered()
      if (offer === undefined) return undefined
      const doc = fit(offer).find(each => each.name === name)
      if (doc === undefined) return undefined
      return { ...summaryOf(spec, doc, offer.commit), content: doc.body }
    },
  }
}

/** The catalog's documents, with its commit. */
async function catalogOffer(service: DishSkills): Promise<Offer> {
  const catalog: Catalog = await service.catalog()
  return { commit: catalog.commit, docs: catalog.skills, ...catalog.degraded === true ? { degraded: true } : {} }
}

/**
 * The global provider: every skill in the catalog, for the `/` menu (`userInvocable` is the skill's own) and never
 * for a model. Register it from an unscoped context, so that it is in the global layer.
 * @param logger - where a document left out or a catalog that failed is told, once.
 */
export function globalProvider(service: DishSkills, logger?: ProviderLogger): (control: SkillProviderControl) => SkillProvider {
  return control => provider(service, control, {
    name: GLOBAL_PROVIDER,
    rank: GLOBAL_RANK,
    offer: () => catalogOffer(service),
    invocation: doc => ({ modelInvocable: false, userInvocable: doc.userInvocable }),
  }, logger)
}

/**
 * The provider of one agent's role: the catalog's skills that `role()` is offered, with each skill's own invocation
 * flags. Register it through the agent's own context, so that it is in that agent's layer alone.
 *
 * `role()` is asked at every `list()` and `get()`, because an agent's role can change under it (its preset can): it
 * keeps what is worth keeping itself. A rejection makes that `list()` incomplete (and is told), so the registry asks
 * again at the next step. `undefined`, or anything that isn't a string with something in it, is no role, and the
 * provider lists nothing.
 * @param logger - where a role that couldn't be read, a document left out or a catalog that failed is told, once.
 */
export function roleProvider(service: DishSkills, role: () => Promise<string | undefined>, logger?: ProviderLogger): (control: SkillProviderControl) => SkillProvider {
  return control => provider(service, control, {
    name: ROLE_PROVIDER,
    rank: ROLE_RANK,
    async offer() {
      const answer: unknown = await role()
      if (typeof answer !== 'string' || answer === '') return { commit: null, docs: [] }
      const offer = await catalogOffer(service)
      return { ...offer, docs: offer.docs.filter(doc => offeredTo(doc, answer)) }
    },
    invocation: doc => ({ modelInvocable: doc.modelInvocable, userInvocable: doc.userInvocable }),
  }, logger)
}

/** What `watchAgents` reads of an agent. Everything is checked: the payload is dsh's, and the listener must not throw. */
interface AgentShape {
  id?: unknown
  ctx?: unknown
  session?: { header?: { delegationDepth?: unknown, origin?: unknown } }
  options?: object
}

/** What `watchAgents` reads of the `dishCrew` service: the record of a child. dish-crew is not a dependency, so the shape is written out. */
interface CrewRecords {
  readonly records: { lookup(childId: string): Promise<{ readonly record?: { readonly role?: unknown } } | undefined> }
}

/** The registry, as an agent's context gives it. */
type Registry = Pick<NonNullable<Context['skills']>, 'registerProvider'>

export interface WatchOptions {
  service: DishSkills
  /** Preset id → the role of its top-level agents. Only agents on these presets are offered their role's skills. */
  presets: Readonly<Record<string, string>>
  logger: ProviderLogger
}

/** The registrations made into one registry, by the agent's context: one each. */
type Registrations = Map<object, () => void>

/**
 * Register a role provider on every agent, in the agent's own layer: on each one announced (`agent/created`), and,
 * whenever a registry comes (at once if it is there), on every agent that is live already. So the agents of a session
 * that was running when this plugin (re)started, or when dsh's registry was reloaded, are offered their skills too.
 *
 * What a provider offers is decided at each of its `list()`s, from the agent's preset then (see `roleProvider`):
 * - an agent whose preset isn't in `presets` (or that has none) is offered nothing of its own;
 * - a top-level agent (`isTopLevelAgent`) has the role `presets` gives its preset;
 * - a child has the role in crew's record of it (`dishCrew.records.lookup(agent.id)`): crew records a child before it
 *   starts it. Crew's answer is kept for the agent's life; a lookup that fails is asked again at the next step;
 * - without crew, or for a child crew doesn't know, there is no role.
 *
 * The registrations live and die with each agent's ctx. Those still live go with the registry they were made in, and
 * with `ctx` (the plugin is unloaded), so an agent never keeps the skills of a plugin that is gone.
 *
 * Nothing here throws: dsh awaits `agent/created` before the agent runs, and a throw would fail its creation. Each
 * kind of trouble is logged once.
 */
export function watchAgents(ctx: Context, options: WatchOptions): void {
  const { service, presets, logger } = options
  // Read by name on each use: `agentPresets`, `agents` and `dishCrew` are siblings' services, and may come and go.
  const lookup = ctx as unknown as { get(name: string): unknown }
  /**
   * The registrations made into the registry that is there now, or `undefined` while there is none. A new registry
   * has none of the old one's layers, so each gets a map of its own, and every agent is registered with it afresh.
   */
  let live: Registrations | undefined

  /** The role of `agent` now: see the header. */
  function roleOf(agent: AgentShape, agentCtx: Context): () => Promise<string | undefined> {
    let crewAnswer: { role: string | undefined } | undefined
    let asking: Promise<string | undefined> | undefined
    const crewRole = (): Promise<string | undefined> => {
      if (crewAnswer !== undefined) return Promise.resolve(crewAnswer.role)
      const crew = lookup.get('dishCrew') as CrewRecords | undefined
      const id = agent.id
      // No crew yet is not an answer: crew may come.
      if (crew === undefined || (typeof id !== 'string' && typeof id !== 'number') || id === '') return Promise.resolve(undefined)
      asking ??= Promise.resolve().then(() => crew.records.lookup(String(id))).then(
        (found) => {
          const role = found?.record?.role
          crewAnswer = { role: typeof role === 'string' ? role : undefined }
          asking = undefined
          return crewAnswer.role
        },
        (error: unknown) => {
          asking = undefined
          throw new Error(`could not read the crew's record of a child agent (${describe(error)})`)
        })
      return asking
    }
    return async () => {
      let preset: unknown
      try {
        const presetsService = ctx.get('agentPresets')
        if (presetsService === undefined) {
          tellOnce(logger, 'agentPresets', 'the agentPresets service isn\'t there, so no agent gets role skills')
          return undefined
        }
        preset = presetsService.composedPreset(agentCtx)
      } catch (error) {
        throw new Error(`could not tell an agent's preset (${describe(error)})`)
      }
      if (typeof preset !== 'string' || !Object.hasOwn(presets, preset)) return undefined
      return isTopLevelAgent(agent) ? presets[preset] : crewRole()
    }
  }

  /** Register a role provider on `agent` with the registry `into` is for, unless it has one there. */
  function offer(agent: AgentShape, into: Registrations): void {
    const agentCtx = agent.ctx as Context | undefined
    if (typeof agentCtx !== 'object' || agentCtx === null || into.has(agentCtx)) return
    // By `get`, not as a property: dsh's agent loop doesn't inject `skills`, so the property read throws. `get` gives
    // the registry bound to the agent's context, which is what files the provider into the agent's own layer.
    const registry = (agentCtx as unknown as { get(name: string): unknown }).get('skills') as Registry | undefined
    if (registry === undefined) {
      tellOnce(logger, 'registry', 'the skill registry is not available to agents, so none is offered its role\'s skills')
      return
    }
    const create = roleProvider(service, roleOf(agent, agentCtx), logger)
    let dispose: (() => void) | undefined
    try {
      dispose = registry.registerProvider((control) => {
        control.signal.addEventListener('abort', () => {
          if (into.get(agentCtx) === dispose) into.delete(agentCtx)
        }, { once: true })
        return create(control)
      })
    } catch (error) {
      tellOnce(logger, `register:${describe(error)}`, 'could not offer an agent its role\'s skills: %s', describe(error))
      return
    }
    into.set(agentCtx, dispose)
  }

  /** `offer`, for whatever dsh says is an agent. Never throws. */
  function offerSafely(agent: unknown, into: Registrations): void {
    try {
      if (typeof agent === 'object' && agent !== null) offer(agent as AgentShape, into)
    } catch (error) {
      tellOnce(logger, `offer:${describe(error)}`, 'could not offer an agent its role\'s skills: %s', describe(error))
    }
  }

  ctx.on('agent/created', (payload) => {
    const agent: unknown = (payload as { agent?: unknown } | undefined)?.agent
    if (live !== undefined) offerSafely(agent, live)
    else if (typeof agent === 'object' && agent !== null) {
      tellOnce(logger, 'registry', 'the skill registry is not available to agents, so none is offered its role\'s skills')
    }
    return undefined
  })

  ctx.inject(['skills'], (inner) => {
    const mine: Registrations = new Map()
    live = mine
    inner.effect(() => () => {
      if (live === mine) live = undefined
      for (const dispose of [...mine.values()]) {
        try {
          dispose()
        } catch {
          // The agent is going too.
        }
      }
      mine.clear()
    })
    let agents: readonly unknown[] = []
    try {
      agents = ctx.get('agents')?.list() ?? []
    } catch (error) {
      tellOnce(logger, `agents:${describe(error)}`, 'could not list the live agents, so those already running are offered no skills of their own: %s', describe(error))
    }
    for (const agent of agents) offerSafely(agent, mine)
  })
}
