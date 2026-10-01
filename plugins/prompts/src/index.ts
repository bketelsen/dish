/**
 * dish-prompts — role prompts for dish agents, as a Cordis plugin.
 *
 * The prompts are documents in the config store (`prompts/common.md`, `prompts/main.md` and
 * `prompts/crew/<role>.md`), and this plugin offers them to the rest of dish as the `dishPrompts` service (see
 * `service.ts`):
 *
 * - `dishConfig` is optional. When the store is there, the plugin claims its three namespaces (an agent may only
 *   propose changes to `common` and `main`, and write crew roles) and seeds the shipped defaults, which never
 *   overwrites an edit. While it isn't, every answer is the shipped default;
 * - each agent's prompt is pinned to the store commit it was first asked for, in a file under `stateDirectory`, so
 *   it doesn't change for the agent's life, across a restart. Files not read for 180 days are pruned at start.
 *
 * @module dish-prompts
 */

import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { printOwnLogs, xdgPaths } from 'dish-kit'
import { DEFAULTS } from './defaults.ts'
import { namespaceSpecs, pathFor } from './roles.ts'
import { createDishPrompts } from './service.ts'
import type { DishPrompts } from './service.ts'
import { SnapshotFiles } from './snapshots.ts'

export type { DishPrompts, Persona } from './service.ts'

export const name = 'dish-prompts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    dishPrompts: DishPrompts
  }
}

export interface Config {
  stateDirectory: string
  terminal: boolean
}

export const Config: Schema<Config> = Schema.object({
  stateDirectory: Schema.string().default('')
    .description('Where per-agent prompt snapshots are kept: an absolute path, where a leading ~/ is your home directory. Leave blank for prompts in the XDG state directory for dish.'),
  terminal: Schema.boolean().default(true)
    .description('Print this plugin\'s messages to the terminal.'),
})

/** Snapshot files not read for this long are removed at start-up. */
const SNAPSHOT_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000

/** A string setting as it will be used: trimmed, and `undefined` when nothing is left (use the default). */
function text(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === '' ? undefined : trimmed
}

/**
 * Where the snapshots live: the setting with a leading `~/` (or a bare `~`) taken as the home directory, else the XDG default.
 * @throws a plain `Error` for any other relative path: what it would be relative to is not something to guess.
 */
function stateDirectoryPath(setting: string | undefined): string {
  if (setting === undefined) return join(xdgPaths('dish').state, 'prompts')
  if (setting === '~') return homedir()
  if (setting.startsWith('~/')) return join(homedir(), setting.slice(2))
  if (!isAbsolute(setting)) throw new Error(`stateDirectory must be an absolute path (or start with ~/), got ${JSON.stringify(setting)}`)
  return setting
}

/** The shipped prompts by their path in the store, which is what `seed` takes. */
function defaultsByPath(): Record<string, string> {
  return Object.fromEntries(Object.entries(DEFAULTS).map(([role, prompt]) => [pathFor(role), prompt]))
}

/** Whether `error` is cordis refusing an effect because the plugin has been unloaded: a plugin that is going away didn't fail. */
function unloaded(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'INACTIVE_EFFECT'
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Prune old snapshot files, then provide `dishPrompts`. A failing prune is logged and doesn't stop the plugin, and the
 * plugin never waits for the store: with `dishConfig` there or not, the service is provided at once.
 * @throws a plain `Error` for a `stateDirectory` that is a relative path.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const logger = ctx.logger(name)
  if (config.terminal) printOwnLogs(ctx, name)

  const directory = resolve(stateDirectoryPath(text(config.stateDirectory)))
  // Told on every look at a bad file. The next successful snapshot replaces the file, so one report per agent says it;
  // the looks that repeat are those of an agent that can't be snapshotted yet, one for each of its steps.
  const invalid = new Set<string>()
  const files = new SnapshotFiles(join(directory, 'agents'), (agentId) => {
    if (invalid.has(agentId)) return
    invalid.add(agentId)
    // Told while a snapshot is being taken, which must not fail for a log line.
    try {
      logger.warn('the snapshot file of agent %s is not valid; taking a new snapshot', agentId)
    } catch {
      // Nothing to do about it.
    }
  })

  try {
    const removed = await files.prune(SNAPSHOT_MAX_AGE_MS)
    if (removed > 0) logger.info('removed %d snapshot files not read for 180 days', removed)
  } catch (error) {
    logger.warn('could not prune the old snapshot files in %s: %s', join(directory, 'agents'), describe(error))
  }

  try {
    // `ctx.get` is read on every call: the store is optional, and may come, go and come back.
    ctx.provide('dishPrompts', createDishPrompts({ store: () => ctx.get('dishConfig'), files, logger }))
    // With the store there: claim the namespaces, as effects so they go when the store, or this plugin, does, and
    // seed what is missing. A seed that fails (a size cap too small for a prompt, say) leaves the store as it is.
    ctx.inject(['dishConfig'], async (child) => {
      const store = child.dishConfig
      let present = true
      child.effect(() => () => { present = false })
      for (const spec of namespaceSpecs(name)) child.effect(() => child.dishConfig.claim(spec))
      try {
        await store.seed(defaultsByPath(), name)
      } catch (error) {
        // Unless the store is going away, which closed it under the seed.
        if (present) logger.warn('could not seed the default prompts: %s', describe(error))
      }
    })
  } catch (error) {
    // Unloaded during the prune: nothing to provide. Not a failure.
    if (unloaded(error)) return
    throw error
  }
}
