/**
 * Offering the skills to agents: two providers for dsh's skill registry (`ctx.skills`, `@deepseek-ai/dsh-skill`).
 *
 * The registry merges the global layer, then the agent's preset's layer, then the agent's own layer, and a nearer
 * layer's entry replaces a farther one of the same name. A provider reads only `cwd` and `signal` of a lookup, never
 * the scope, so who is offered what is decided by where a provider is registered:
 *
 * - **`dish`, global** (the host plugin registers it while `skills` is there): every valid skill, for the `/` menu
 *   everywhere, and never for a model (`modelInvocable: false`).
 * - **`dish-role`, in an agent's own layer** (`watchAgents` registers one on each agent of a configured preset): the
 *   skills of the agent's role, with each skill's own invocation flags. Its entries replace the global ones for that
 *   agent alone, and a skill outside the role stays the global, menu-only entry, which the `skill` tool refuses.
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

function tellOnce(logger: ProviderLogger | undefined, key: string, format: string, ...args: unknown[]): void {
  if (logger === undefined) return
  let told = toldBy.get(logger)
  if (told === undefined) toldBy.set(logger, told = new Set())
  if (told.has(key)) return
  if (told.size >= MAX_TOLD) told.clear()
  told.add(key)
  try {
    logger.warn(format, ...args)
  } catch {
    // Logging is not worth a failed catalog.
  }
}

/** Forget what was told of `prefix`, so that the next trouble of that kind is told again: it is over. */
function forgetTold(logger: ProviderLogger | undefined, prefix: string): void {
  const told = logger === undefined ? undefined : toldBy.get(logger)
  if (told === undefined) return
  for (const key of told) if (key.startsWith(prefix)) told.delete(key)
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
      let offer: Offer
      try {
        offer = await spec.offer()
      } catch (error) {
        tellOnce(logger, `list:${spec.name}:${describe(error)}`, 'the %s skill provider offers nothing for now, and is asked again at the next step: %s', spec.name, describe(error))
        return { candidates: [], complete: false }
      }
      forgetTold(logger, `list:${spec.name}:`)
      const candidates: SkillCandidate[] = fit(offer).map(doc => ({
        ...summaryOf(spec, doc, offer.commit),
        rank: spec.rank,
        locator: { commit: offer.commit, name: doc.name } satisfies SkillLocator,
      }))
      return { candidates, complete: true }
    },
    // Whatever the locator's commit, the document of that name now: the registry discards a definition whose name is
    // not the candidate's, and a name that went has none.
    async get(candidate): Promise<SkillDefinition | undefined> {
      const locator = candidate.locator as Partial<SkillLocator> | null | undefined
      const name = typeof locator?.name === 'string' ? locator.name : candidate.name
      const offer = await spec.offer()
      const doc = fit(offer).find(each => each.name === name)
      if (doc === undefined) return undefined
      return { ...summaryOf(spec, doc, offer.commit), content: doc.body }
    },
  }
}

/** The catalog's documents, with its commit. */
async function catalogOffer(service: DishSkills): Promise<Offer> {
  const catalog: Catalog = await service.catalog()
  return { commit: catalog.commit, docs: catalog.skills }
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
 * `role()` is asked at the first `list()` (or `get()`), and its answer is kept for the provider's life. A rejection
 * is not kept: that `list()` is incomplete (and told), so the registry asks again at the next step. `undefined`, or
 * anything that isn't a string with something in it, is no role, and the provider lists nothing.
 * @param logger - where a role that couldn't be read, a document left out or a catalog that failed is told, once.
 */
export function roleProvider(service: DishSkills, role: () => Promise<string | undefined>, logger?: ProviderLogger): (control: SkillProviderControl) => SkillProvider {
  return (control) => {
    let known: { role: string | undefined } | undefined
    let asking: Promise<string | undefined> | undefined
    const roleOnce = (): Promise<string | undefined> => {
      if (known !== undefined) return Promise.resolve(known.role)
      asking ??= Promise.resolve().then(role).then(
        (answer: unknown) => {
          known = { role: typeof answer === 'string' && answer !== '' ? answer : undefined }
          return known.role
        },
        (error: unknown) => {
          asking = undefined
          throw new Error(`could not tell the agent's role (${describe(error)})`)
        })
      return asking
    }
    return provider(service, control, {
      name: ROLE_PROVIDER,
      rank: ROLE_RANK,
      async offer() {
        const name = await roleOnce()
        if (name === undefined) return { commit: null, docs: [] }
        const offer = await catalogOffer(service)
        return { commit: offer.commit, docs: offer.docs.filter(doc => offeredTo(doc, name)) }
      },
      invocation: doc => ({ modelInvocable: doc.modelInvocable, userInvocable: doc.userInvocable }),
    }, logger)
  }
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

/**
 * Register a role provider on each new agent of a configured preset, in the agent's own layer. The registrations live
 * and die with each agent's ctx, and the ones still live go when `ctx` does (the plugin is unloaded), so an agent
 * never keeps the skills of a plugin that is gone.
 *
 * The agent's role:
 * - a top-level agent (`isTopLevelAgent`) has the role `presets` gives its preset;
 * - a child has the role in crew's record of it (`dishCrew.records.lookup(agent.id)`), read at the provider's first
 *   `list()`: crew records a child before it starts it. A lookup that fails is retried at the next step;
 * - without crew, or for a child crew doesn't know, there is no role, and the agent's layer lists nothing.
 *
 * The listener never throws: dsh awaits it before the agent runs, and a throw would fail the agent's creation. Each
 * kind of trouble is logged once.
 */
export function watchAgents(ctx: Context, options: WatchOptions): void {
  const { service, presets, logger } = options
  // Read by name on each use: `agentPresets` and `dishCrew` are siblings' services, and may come and go.
  const lookup = ctx as unknown as { get(name: string): unknown }
  /** The registrations this made that are still live, by the agent's context: one each, and undone when the plugin goes. */
  const live = new Map<object, () => void>()

  const crewRole = async (id: unknown): Promise<string | undefined> => {
    const crew = lookup.get('dishCrew') as CrewRecords | undefined
    if (crew === undefined || (typeof id !== 'string' && typeof id !== 'number') || id === '') return undefined
    const found = await crew.records.lookup(String(id))
    const role = found?.record?.role
    return typeof role === 'string' ? role : undefined
  }

  function offer(agent: AgentShape): void {
    const agentCtx = agent.ctx as Context | undefined
    if (typeof agentCtx !== 'object' || agentCtx === null || live.has(agentCtx)) return

    let preset: string | undefined
    try {
      preset = ctx.get('agentPresets')?.composedPreset(agentCtx)
    } catch (error) {
      tellOnce(logger, `preset:${describe(error)}`, 'could not tell the preset of a new agent, so it is offered no skills of its own: %s', describe(error))
      return
    }
    if (typeof preset !== 'string' || !Object.hasOwn(presets, preset)) return

    // By `get`, not as a property: dsh's agent loop doesn't inject `skills`, so the property read throws. `get` gives
    // the registry bound to the agent's context, which is what files the provider into the agent's own layer.
    const registry = (agentCtx as unknown as { get(name: string): unknown }).get('skills') as Registry | undefined
    if (registry === undefined) {
      tellOnce(logger, 'registry', 'the skill registry is not available to agents, so none is offered its role\'s skills')
      return
    }
    const topRole = presets[preset]
    const role = isTopLevelAgent(agent) ? async () => topRole : () => crewRole(agent.id)
    const create = roleProvider(service, role, logger)
    let dispose: (() => void) | undefined
    try {
      dispose = registry.registerProvider((control) => {
        control.signal.addEventListener('abort', () => {
          if (live.get(agentCtx) === dispose) live.delete(agentCtx)
        }, { once: true })
        return create(control)
      })
    } catch (error) {
      tellOnce(logger, `register:${describe(error)}`, 'could not offer an agent its role\'s skills: %s', describe(error))
      return
    }
    live.set(agentCtx, dispose)
  }

  ctx.on('agent/created', (payload) => {
    try {
      const agent: unknown = (payload as { agent?: unknown } | undefined)?.agent
      if (typeof agent === 'object' && agent !== null) offer(agent as AgentShape)
    } catch (error) {
      tellOnce(logger, `created:${describe(error)}`, 'could not offer an agent its role\'s skills: %s', describe(error))
    }
    return undefined
  })

  ctx.effect(() => () => {
    for (const dispose of [...live.values()]) {
      try {
        dispose()
      } catch {
        // The agent is going too.
      }
    }
    live.clear()
  })
}
