/**
 * The `dishSkills` service: which skills there are, and which a role is offered.
 *
 * The documents live in the config store (`dishConfig`, `skills/<name>/SKILL.md`), and the store is optional. A
 * call looks the store up when it is made, so a store that appears or goes away is handled call by call, and with
 * none (or one that fails to answer, or one that has no skill documents at all, as before its first seed) the
 * answer is the shipped defaults, at `commit: null`: agents are never left with no skills for want of a seed.
 * Only the one that fails to answer is a stopgap, and its catalog says so (`degraded`): the others are the answer.
 *
 * - `catalog()` is every skill at `main`: the valid documents, sorted by name, and the ones that don't parse in
 *   `problems`. A document nobody could have saved through the store (a hand edit in git) is a problem and
 *   nothing else, even if parsing it throws: the rest of the catalog serves, so one bad file never costs an agent
 *   its skills. Only documents at `skills/<name>/SKILL.md` count; anything else under `skills/` is not a skill
 *   and not a problem. Documents that are all problems are still the store's answer, with the problems listed.
 * - The catalog is read once per commit. The head is asked on every call, which is what tells a new commit from
 *   the one remembered, and concurrent calls share one read. `changed()` forgets it at once (the store announces
 *   a change after the fact, and the provider caches built on this want a fresh read) and tells every listener.
 * - What `catalog()` returns is the caller's: the arrays are new each time, and the documents are frozen because
 *   they are shared.
 *
 * Nothing here rejects because of the store or crew: trouble is logged once for as long as it lasts.
 *
 * @module dish-skills/service
 */
import type { DishConfigService } from 'dish-config'
import { DEFAULTS, defaultText } from './defaults.ts'
import { SHIPPED_ROLES, SKILLS_PREFIX, nameFor, offeredTo, parseSkill, pathFor } from './skill.ts'
import type { ParseResult, ParsedSkill } from './skill.ts'

/** A valid skill document: what it says, where it is and its whole text. */
export interface SkillDoc extends ParsedSkill {
  /** `skills/<name>/SKILL.md`. */
  readonly path: string
  /** The whole document, frontmatter included. */
  readonly text: string
}

export interface Catalog {
  /** The store commit the skills were read at, or `null` when they are the shipped defaults. */
  commit: string | null
  /**
   * `true` when a store is there but could not be read just now, so the skills are the shipped ones as a stopgap, not
   * the user's. Absent otherwise: no store, a store with no skill documents and a store that answered are all answers.
   * dsh's registry caches a catalog it is told is complete until the next change, so whoever offers this one to the
   * registry must say it is incomplete, and the next step reads the store again.
   */
  degraded?: true
  /** The valid skills, sorted by name. */
  skills: SkillDoc[]
  /** The documents that didn't parse, sorted by path; `message` is one sentence that doesn't repeat the path. */
  problems: { path: string, message: string }[]
}

export interface DishSkills {
  /** The skills at `main` now, or the shipped defaults at `commit: null` (no store, a store that fails, or one with no skill documents); a store that fails is `degraded`. Never rejects because of the store. */
  catalog(): Promise<Catalog>
  /** `catalog()`'s skills that `role` is offered, sorted by name: those that name it and those that name no role. */
  forRole(role: string): Promise<SkillDoc[]>
  /** `main`, then the crew's roles sorted (or the shipped roles when there is no crew). Never rejects. */
  knownRoles(): Promise<string[]>
  /** The shipped text of the skill `name`, or `undefined` if dish ships none. */
  defaultText(name: string): string | undefined
  /** The names of the shipped skills, sorted. */
  shipped(): string[]
  /** Call `listener` after every `changed()`. Returns the function that stops that. */
  onChange(listener: () => void): () => void
  /** The skills may have changed: forget what was read, and call every listener (each is guarded). */
  changed(): void
}

// Here, not in the plugin's own file, so that whoever imports these types also gets `ctx.get('dishSkills')` typed.
declare module '@deepseek-ai/cordis' {
  interface Context {
    dishSkills: DishSkills
  }
}

/** What the service needs of the store: dish-config's reads. */
export type StoreReader = Pick<DishConfigService, 'head' | 'read' | 'list'>

/**
 * What the service needs of the `dishCrew` service: the settings' roles. A `Pick` of dish-crew's `CrewSettings` would
 * do, but dish-crew is not a dependency of this package, so the shape is written out.
 */
export interface CrewReader {
  settings(): Promise<{ readonly roles: Readonly<Record<string, unknown>> }>
}

export interface ServiceLogger {
  warn(format: string, ...args: unknown[]): void
  info(format: string, ...args: unknown[]): void
}

export interface ServiceOptions {
  /** The store as it is right now, or `undefined` if there is none. Called on every operation. */
  store: () => StoreReader | undefined
  /** The crew service as it is right now, or `undefined`. Called on every `knownRoles()`. */
  crew: () => CrewReader | undefined
  logger: ServiceLogger
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function byName(a: { name: string }, b: { name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

function byPath(a: { path: string }, b: { path: string }): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0
}

/** `value` and everything in it, frozen. The values here are YAML's: acyclic (`parseSkill` refuses aliases). */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const inner of Object.values(value)) deepFreeze(inner)
  }
  return value
}

/**
 * The catalog of `entries`, the documents `[path, text]` at `commit`'s `skills/`. Each document is on its own: one
 * that does not parse, or whose parsing throws, is a problem with its own message, and never costs the others.
 * `parse` is `parseSkill`; a test can pass one that throws.
 */
export function buildCatalog(
  commit: string | null,
  entries: readonly (readonly [path: string, text: string])[],
  parse: (path: string, text: string) => ParseResult = parseSkill,
): Catalog {
  const skills: SkillDoc[] = []
  const problems: { path: string, message: string }[] = []
  for (const [path, text] of entries) {
    try {
      const result = parse(path, text)
      if (result.ok) {
        skills.push(deepFreeze({ ...result.skill, path, text }))
      } else {
        // The page shows the path beside the message, so the message does not repeat it.
        const prefix = `${path}: `
        problems.push({ path, message: result.problem.startsWith(prefix) ? result.problem.slice(prefix.length) : result.problem })
      }
    } catch (error) {
      problems.push({ path, message: describe(error) })
    }
  }
  return { commit, skills: skills.sort(byName), problems: problems.sort(byPath) }
}

/** The most kinds of trouble remembered as told: a trouble that keeps changing its words is not worth a list that grows. */
const MAX_TOLD = 50

export function createDishSkills(options: ServiceOptions): DishSkills {
  /** A log line that can't throw into the caller, whatever the logger does. */
  const warn = (format: string, ...args: unknown[]): void => {
    try {
      options.logger.warn(format, ...args)
    } catch {
      // Logging is not worth a failed call.
    }
  }

  /** Trouble told since the store (or crew) last answered. */
  const toldStore = new Set<string>()
  const toldCrew = new Set<string>()
  const tell = (told: Set<string>, error: unknown, format: string): void => {
    const message = describe(error)
    if (told.has(message)) return
    if (told.size >= MAX_TOLD) told.clear()
    told.add(message)
    warn(format, message)
  }

  const listeners = new Set<() => void>()
  /** Bumped by `changed()`: a read that began before it is out of date and takes neither the memo nor the in-flight slot. */
  let generation = 0
  /** The latest read of the store, and the commit it was of. (Its catalog is the shipped one for a store with no skills.) */
  let memo: { commit: string, catalog: Catalog } | undefined
  let inflight: Promise<Catalog> | undefined
  /** The documents of the commit last read that were told as problems, so each is told once per commit. */
  let toldProblems: { commit: string, paths: Set<string> } | undefined
  let shipped: Catalog | undefined

  /** The catalog of the shipped skills. They are constants, so it is built once. */
  function defaults(): Catalog {
    shipped ??= buildCatalog(null, Object.entries(DEFAULTS).map(([name, text]) => [pathFor(name), text] as const))
    return shipped
  }

  function tellProblems(commit: string, problems: readonly { path: string, message: string }[]): void {
    const told = toldProblems?.commit === commit ? toldProblems.paths : new Set<string>()
    toldProblems = { commit, paths: told }
    for (const { path, message } of problems) {
      if (told.has(path)) continue
      told.add(path)
      warn('the skill document %s is not valid and is left out: %s', path, message)
    }
  }

  async function read(store: StoreReader, started: number): Promise<Catalog> {
    const commit = await store.head()
    if (memo?.commit === commit) {
      // The store answered, as it did for this commit before: a trouble it has again is news.
      toldStore.clear()
      return memo.catalog
    }
    const paths = (await store.list(SKILLS_PREFIX, commit)).filter(path => nameFor(path) !== undefined)
    const entries = await Promise.all(paths.map(async (path) => [path, await store.read(path, commit)] as const))
    const stored = buildCatalog(commit, entries.filter((entry): entry is readonly [string, string] => entry[1] !== undefined))
    // A store with no skill documents (before its first seed, or one that cannot be seeded) leaves agents with the shipped
    // ones. Documents that are all problems are an answer, and the page shows the problems.
    const catalog = stored.skills.length === 0 && stored.problems.length === 0 ? defaults() : stored
    toldStore.clear()
    // A read that `changed()` outdated says nothing: the fresh read of that commit, or a later one, does.
    if (generation === started) {
      tellProblems(commit, stored.problems)
      memo = { commit, catalog }
    }
    return catalog
  }

  async function load(started: number): Promise<Catalog> {
    try {
      const store = options.store()
      if (store === undefined) return defaults()
      return await read(store, started)
    } catch (error) {
      tell(toldStore, error, 'could not read the skills from the config store, so the shipped skills are used: %s')
      // A new object, marked: the shipped catalog itself is shared, and is the answer for a store that isn't there.
      return { ...defaults(), degraded: true }
    }
  }

  /** `catalog` as a caller gets it: its own arrays. */
  const copy = (catalog: Catalog): Catalog => ({
    commit: catalog.commit,
    ...catalog.degraded === true ? { degraded: true as const } : {},
    skills: [...catalog.skills],
    problems: catalog.problems.map(problem => ({ ...problem })),
  })

  function catalog(): Promise<Catalog> {
    if (inflight === undefined) {
      const run: Promise<Catalog> = load(generation).finally(() => {
        if (inflight === run) inflight = undefined
      })
      inflight = run
    }
    return inflight.then(copy)
  }

  async function forRole(role: string): Promise<SkillDoc[]> {
    return (await catalog()).skills.filter(skill => offeredTo(skill, role))
  }

  /** `main` first, then the rest sorted, each once. */
  const ordered = (roles: Iterable<string>): string[] => ['main', ...[...new Set(roles)].filter(role => role !== 'main').sort()]

  async function knownRoles(): Promise<string[]> {
    try {
      const crew = options.crew()
      if (crew !== undefined) {
        const settings: unknown = await crew.settings()
        const roles = (settings as { roles?: unknown } | null | undefined)?.roles
        if (typeof roles !== 'object' || roles === null || Array.isArray(roles)) throw new Error('the crew settings have no roles')
        toldCrew.clear()
        return ordered(Object.keys(roles))
      }
    } catch (error) {
      tell(toldCrew, error, 'could not read the crew\'s roles, so the shipped roles are used: %s')
    }
    return ordered(SHIPPED_ROLES)
  }

  function changed(): void {
    generation++
    memo = undefined
    inflight = undefined
    // A copy, and a check before each call: a listener that stops another one is believed.
    for (const listener of [...listeners]) {
      if (!listeners.has(listener)) continue
      try {
        const result: unknown = listener()
        if (typeof (result as { then?: unknown } | null | undefined)?.then === 'function') {
          (result as Promise<unknown>).then(undefined, (error: unknown) => { warn('a skills change listener failed: %s', describe(error)) })
        }
      } catch (error) {
        warn('a skills change listener failed: %s', describe(error))
      }
    }
  }

  return {
    catalog,
    forRole,
    knownRoles,
    defaultText,
    shipped: () => Object.keys(DEFAULTS).sort(),
    onChange(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    changed,
  }
}
