/**
 * dish-crew: a fixed crew of specialists the main agent delegates to.
 *
 * This is the host plugin. The `delegate` tool and the finish notices are a preset row, `dish-crew/delegate`, which
 * reads what is provided here. The plugin:
 *
 * - provides the `dishCrew` service: `settings()` is the `crew.yaml` in the config store as it is now (see
 *   `settings.ts`), or the shipped default;
 * - claims `crew.yaml` in the store and seeds it when `dishConfig` is there. `dishConfig` is optional, so there is no
 *   order to keep: with no store, every answer is the shipped default;
 * - logs as `dish-crew`.
 *
 * @module dish-crew
 */

import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { printOwnLogs, xdgPaths } from 'dish-kit'
import { CREW_SPEC, DEFAULT_SETTINGS, DEFAULT_TEXT, parseSettings } from './settings.ts'
import type { CrewSettings } from './settings.ts'

export type { CrewSettings, FamilySettings, Limits, ParseResult, RoleSettings, Tier } from './settings.ts'

export const name = 'dish-crew'

/** The `dishCrew` service. */
export interface DishCrew {
  /**
   * The crew's settings: `crew.yaml` on `main` of the config store as it is now, so an edit shows at once. A missing
   * file, a file that doesn't pass `parseSettings`, a store that can't be read and no store at all each give the
   * shipped default, with one logged warning for each distinct problem. Never rejects.
   */
  settings(): Promise<CrewSettings>
}

// Here, with the type, so that whoever imports it also gets `ctx.get('dishCrew')` typed.
declare module '@deepseek-ai/cordis' {
  interface Context {
    dishCrew: DishCrew
  }
}

export interface Config {
  dataDirectory: string
  subagentProvider: string
  terminal: boolean
}

export const Config: Schema<Config> = Schema.object({
  dataDirectory: Schema.string().default('')
    .description('Where the crew\'s records and saved reports go: an absolute path, where a leading ~/ is your home directory. Leave blank for crew in the XDG data directory for dish.'),
  subagentProvider: Schema.string().default('spawn')
    .description('The ctx.subagents provider that creates the crew\'s children in-process.'),
  terminal: Schema.boolean().default(true)
    .description('Print this plugin\'s messages to the terminal.'),
})

/** A string setting as it will be used: trimmed, and `undefined` when nothing is left (use the default). */
function text(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === '' ? undefined : trimmed
}

/**
 * Where the crew's data lives: the setting with a leading `~/` (or a bare `~`) taken as the home directory, else the XDG default.
 * @throws a plain `Error` for any other relative path: what it would be relative to is not something to guess.
 */
export function dataDirectoryPath(setting: string | undefined): string {
  if (setting === undefined) return join(xdgPaths('dish').data, 'crew')
  if (setting === '~') return homedir()
  if (setting.startsWith('~/')) return join(homedir(), setting.slice(2))
  if (!isAbsolute(setting)) throw new Error(`dataDirectory must be an absolute path (or start with ~/), got ${JSON.stringify(setting)}`)
  return setting
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** What the settings need of the store: its reads. */
type Reader = { read(path: string): Promise<string | undefined> }

interface Logger {
  warn(format: string, ...args: unknown[]): void
}

/**
 * `settings()` over a store that may or may not be there, looked up on every call. Each distinct problem is logged
 * once, and none of it is thrown: a delegation reads this on every call, and the shipped default always works.
 */
function createSettingsReader(store: () => Reader | undefined, logger: Logger): () => Promise<CrewSettings> {
  const told = new Set<string>()
  /** Say `message` once. A logger that throws is not worth a failed call. */
  const tell = (message: string): void => {
    if (told.has(message)) return
    told.add(message)
    try {
      logger.warn('%s', message)
    } catch {
      // Nothing to do about it.
    }
  }
  return async () => {
    try {
      const reader = store()
      if (reader === undefined) {
        tell('dish-config is not running; using the shipped crew.yaml')
        return DEFAULT_SETTINGS
      }
      let stored: string | undefined
      try {
        stored = await reader.read('crew.yaml')
      } catch (error) {
        tell(`could not read crew.yaml from the config store (${describe(error)}); using the shipped default`)
        return DEFAULT_SETTINGS
      }
      if (stored === undefined) {
        tell('crew.yaml is not in the config store; using the shipped default')
        return DEFAULT_SETTINGS
      }
      const parsed = parseSettings(stored)
      if (!parsed.ok) {
        tell(`crew.yaml in the config store is not valid, so the shipped default is used: ${parsed.problem}`)
        return DEFAULT_SETTINGS
      }
      return parsed.settings
    } catch (error) {
      tell(`could not get the crew settings (${describe(error)}); using the shipped default`)
      return DEFAULT_SETTINGS
    }
  }
}

/**
 * Provide `dishCrew`, and claim and seed `crew.yaml` whenever the store is there.
 * @throws a plain `Error` for a `dataDirectory` that is a relative path.
 */
export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger(name)
  if (config.terminal) printOwnLogs(ctx, name)

  // Checked now, so a bad setting fails the plugin to load rather than the first delegation.
  resolve(dataDirectoryPath(text(config.dataDirectory)))

  // `ctx.get` is read on every call: the store is optional, and may come, go and come back.
  ctx.provide('dishCrew', { settings: createSettingsReader(() => ctx.get('dishConfig'), logger) })

  // With the store there: claim crew.yaml, as an effect so it goes when the store, or this plugin, does, and seed it.
  // A claim that is refused (someone else owns the path) or a seed that fails leaves the store as it is.
  ctx.inject(['dishConfig'], async (child) => {
    const store = child.dishConfig
    let present = true
    child.effect(() => () => { present = false })
    try {
      child.effect(() => child.dishConfig.claim(CREW_SPEC))
    } catch (error) {
      if (present) logger.warn('could not claim crew.yaml: %s', describe(error))
      return
    }
    try {
      await store.seed({ 'crew.yaml': DEFAULT_TEXT }, name)
    } catch (error) {
      // Unless the store is going away, which closed it under the seed.
      if (present) logger.warn('could not seed crew.yaml: %s', describe(error))
    }
  })
}
