/**
 * dish-skills — skills for dish agents, as a Cordis plugin.
 *
 * The skills are documents in the config store (`skills/<name>/SKILL.md`), and this plugin offers them to the rest
 * of dish as the `dishSkills` service (see `service.ts`):
 *
 * - `dishConfig` is optional. When the store is there, the plugin claims the `skills/` subtree (an agent may only
 *   propose changes) and seeds the shipped defaults, which never overwrites an edit: a stored default is only
 *   replaced when its text is one of an earlier shipped version that nobody has edited since (`defaults/previous.json`).
 *   While the store isn't there, or has no skill documents yet, every answer is the shipped defaults;
 * - a change under `skills/` in the store, and the store coming or going, is told to the service's listeners.
 *
 * @module dish-skills
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { printOwnLogs } from 'dish-kit'
import { defaultsByPath, replaceMap } from './defaults.ts'
import { createDishSkills } from './service.ts'
import type { CrewReader } from './service.ts'
import { ROLE_NAME, SKILLS_PREFIX, namespaceSpec } from './skill.ts'

export type { Catalog, DishSkills, SkillDoc } from './service.ts'

export const name = 'dish-skills'

export interface Config {
  presets: Record<string, string>
  terminal: boolean
}

export const Config: Schema<Config> = Schema.object({
  presets: Schema.dict(Schema.string().pattern(ROLE_NAME).required()).default({ dish: 'main' })
    .description('Which agents get role skills: a preset id, and the role of the top-level agents on it. Only agents on these presets are offered their role\'s skills.'),
  terminal: Schema.boolean().default(true)
    .description('Print this plugin\'s messages to the terminal.'),
})

/** Whether `error` is cordis refusing an effect because the plugin has been unloaded: a plugin that is going away didn't fail. */
function unloaded(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'INACTIVE_EFFECT'
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export interface StoreLink {
  /** For `seed`: the sha256 of earlier shipped texts, by the path of a shipped skill. */
  replace: Record<string, readonly string[]>
  /** The store appeared (its skills are seeded now) or went away. */
  changed(): void
  logger: { warn(format: string, ...args: unknown[]): void }
}

/**
 * Whenever `dishConfig` is there: claim `skills/`, seed the defaults, and say so through `changed()`. Both go with the
 * store, or with `ctx`: the claim is an effect, so it is released and a later store gets it again. A claim that is
 * refused (someone else owns a path in `skills/`) or a seed that fails is logged and leaves the store as it is.
 * Exported so that a test can start the plugin's store half with `replace` lists of its own.
 */
export function linkStore(ctx: Context, link: StoreLink): void {
  ctx.inject(['dishConfig'], async (child) => {
    const store = child.dishConfig
    let present = true
    child.effect(() => () => {
      present = false
      link.changed()
    })
    let claimed = true
    try {
      child.effect(() => child.dishConfig.claim(namespaceSpec(name)))
    } catch (error) {
      claimed = false
      // Unless the store is going away, which took the effect with it.
      if (!unloaded(error)) link.logger.warn('could not claim %s: %s', SKILLS_PREFIX, describe(error))
    }
    if (claimed) {
      try {
        await store.seed(defaultsByPath(), name, { replace: link.replace })
      } catch (error) {
        // Unless the store is going away, which closed it under the seed.
        if (present) link.logger.warn('could not seed the default skills: %s', describe(error))
      }
    }
    // The skills now come from the store, whatever the seed did. (The seed announces its own commit as well.)
    if (present) link.changed()
  })
}

/**
 * Provide `dishSkills`, and claim and seed `skills/` whenever the store is there. The plugin never waits for the
 * store: with `dishConfig` there or not, the service is provided at once.
 */
export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger(name)
  if (config.terminal) printOwnLogs(ctx, name)

  // `ctx.get` is read on every call, by name: the store and crew are optional, and are siblings of this plugin (never
  // ancestors, so a property read would throw). They may come, go and come back.
  const lookup = ctx as unknown as { get(name: string): unknown }
  const service = createDishSkills({
    store: () => ctx.get('dishConfig'),
    crew: () => lookup.get('dishCrew') as CrewReader | undefined,
    logger,
  })
  ctx.provide('dishSkills', service)

  ctx.on('dish-config/changed', (paths) => {
    if (paths.some(path => path.startsWith(SKILLS_PREFIX))) service.changed()
  })
  linkStore(ctx, { replace: replaceMap(), changed: () => service.changed(), logger })
}
