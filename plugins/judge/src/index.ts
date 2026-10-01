/**
 * dish-judge: a fast typed judge in front of the risky edges of every agent.
 *
 * This is the host plugin. It is the one place the judge's pieces are wired together; for now it:
 *
 * - provides the `dishJudge` service: `settings()` is the `judge.yaml` in the config store as it is now (see
 *   `settings.ts`). Later steps add the decision log and the listeners to this plugin;
 * - provides the `judge` service, the Jev client (see `client.ts`): the key is looked up in dsh's credential store on
 *   every call, the model and time limit are the settings of the moment;
 * - claims `judge.yaml` in the store, closed to agents, and seeds it when `dishConfig` is there. `dishConfig` is
 *   optional, so there is no order to keep: with no store, every answer is the shipped default;
 * - checks its configuration when it loads, so a bad setting fails the plugin to load rather than the first call;
 * - logs as `dish-judge`.
 *
 * @module dish-judge
 */

import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import Schema from '@deepseek-ai/schemastery'
import { printOwnLogs, xdgPaths } from 'dish-kit'
import { createJudge } from './client.ts'
import type { LogLine } from './client.ts'
import { DEFAULT_SETTINGS, DEFAULT_TEXT, JUDGE_SPEC, parseSettings } from './settings.ts'
import type { JudgeSettings } from './settings.ts'

export { createJudge } from './client.ts'
export type { Answer, Asked, Decision, Judge, JudgeAgent, JudgeDeps, JudgeRequest, JudgeResult, JudgeStatus, JsonValue, LogLine, Purpose, Question } from './client.ts'
export type { CommandSettings, JudgeSettings, ParseResult, ScreeningSettings, ToolSettings } from './settings.ts'

export const name = 'dish-judge'

/** The `dishJudge` service. */
export interface DishJudge {
  /**
   * The judge's settings: `judge.yaml` on `main` of the config store as it is now, so an edit shows at once. A missing
   * file, a file that doesn't pass `parseSettings`, a store that can't be read and no store at all each give the
   * shipped default, with one logged warning for each distinct problem. Never rejects.
   */
  settings(): Promise<JudgeSettings>
}

// Here, with the type, so that whoever imports it also gets `ctx.get('dishJudge')` typed.
declare module '@deepseek-ai/cordis' {
  interface Context {
    dishJudge: DishJudge
  }
}

export interface Config {
  baseUrl: string
  keyName: string
  stateDirectory: string
  terminal: boolean
}

/** Where TypeSafe's API is. */
const DEFAULT_BASE_URL = 'https://api.typesafe.ai'
/** The environment-variable name the key goes by in dsh's credential store. */
const DEFAULT_KEY_NAME = 'TYPESAFE_API_KEY'

export const Config: Schema<Config> = Schema.object({
  baseUrl: Schema.string().default(DEFAULT_BASE_URL)
    .description('The TypeSafe API: an http or https address with no path of a call in it.'),
  keyName: Schema.string().default(DEFAULT_KEY_NAME)
    .description('The name the TypeSafe key goes by in dsh\'s credential store: an environment variable name.'),
  stateDirectory: Schema.string().default('')
    .description('Where the judge\'s decision log goes: an absolute path, where a leading ~/ is your home directory. Leave blank for the XDG state directory for dish.'),
  terminal: Schema.boolean().default(true)
    .description('Print this plugin\'s messages to the terminal.'),
})

/** A string setting as it will be used: trimmed, and `undefined` when nothing is left (use the default). */
function text(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === '' ? undefined : trimmed
}

/**
 * The address of the TypeSafe API: the setting without its trailing slashes, or the default if there is none.
 * @throws a plain `Error` for anything but an http or https address with no username, password, query or fragment. The
 *   message never repeats the setting, which might hold a secret.
 */
export function baseUrlOf(setting: string | undefined): string {
  if (setting === undefined) return DEFAULT_BASE_URL
  const wrong = 'baseUrl must be an http or https address with nothing after the path, like https://api.typesafe.ai'
  let url: URL
  try {
    url = new URL(setting)
  } catch {
    throw new Error(wrong)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(wrong)
  if (url.username !== '' || url.password !== '') throw new Error('baseUrl must not have a username or password in it: the key is set on Settings → Judge')
  if (url.search !== '' || url.hash !== '' || setting.includes('?') || setting.includes('#')) throw new Error(wrong)
  return setting.replace(/\/+$/, '')
}

/**
 * The name the key goes by in the credential store: the setting, or the default if there is none.
 * @throws a plain `Error` for anything that isn't an environment variable name.
 */
export function keyNameOf(setting: string | undefined): string {
  if (setting === undefined) return DEFAULT_KEY_NAME
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(setting)) throw new Error('keyName must be an environment variable name: letters, digits and underscores, not starting with a digit')
  return setting
}

/**
 * Where the judge's state lives: the setting with a leading `~/` (or a bare `~`) taken as the home directory, else the XDG default.
 * @throws a plain `Error` for any other relative path: what it would be relative to is not something to guess.
 */
export function stateDirectoryPath(setting: string | undefined): string {
  if (setting === undefined) return join(xdgPaths('dish').state, 'judge')
  if (setting === '~') return homedir()
  if (setting.startsWith('~/')) return join(homedir(), setting.slice(2))
  if (!isAbsolute(setting)) throw new Error(`stateDirectory must be an absolute path (or start with ~/), got ${JSON.stringify(setting)}`)
  return setting
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** What the settings need of the store: its reads. */
export type Reader = { read(path: string): Promise<string | undefined> }

export interface Logger {
  warn(format: string, ...args: unknown[]): void
}

/**
 * How long a call to `settings()` waits for the store before it answers without it: 200 ms. A read of one small file from a
 * local git repository takes a few milliseconds, so this is a store that is stuck, not one that is slow, and it is a tenth
 * of the shipped `timeoutMs`, which is what a gate has to spare: dish-config's reads queue behind its git commands, and
 * those have no time limit of their own.
 */
export const SETTINGS_READ_BUDGET_MS = 200

/**
 * `settings()` over a store that may or may not be there, looked up on every call. Each distinct problem is logged
 * once, and none of it is thrown: every gate reads this on every call, and the shipped default always works.
 *
 * It also never waits for the store longer than `budgetMs`. Past that it answers with the last settings it read from the
 * store (the shipped default if it has read none) and says so once. The read goes on, and its result is kept for the next
 * call; calls that come while one is going join it rather than start another, so a store that never answers is not asked
 * again and again.
 */
export function createSettingsReader(store: () => Reader | undefined, logger: Logger, budgetMs = SETTINGS_READ_BUDGET_MS): () => Promise<JudgeSettings> {
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
  /** The last settings that were read from the store and passed `parseSettings`. */
  let lastGood: JudgeSettings | undefined
  const read = async (): Promise<JudgeSettings> => {
    try {
      const reader = store()
      if (reader === undefined) {
        tell('dish-config is not running; using the shipped judge.yaml')
        return DEFAULT_SETTINGS
      }
      let stored: string | undefined
      try {
        stored = await reader.read('judge.yaml')
      } catch (error) {
        tell(`could not read judge.yaml from the config store (${describe(error)}); using the shipped default`)
        return DEFAULT_SETTINGS
      }
      if (stored === undefined) {
        tell('judge.yaml is not in the config store; using the shipped default')
        return DEFAULT_SETTINGS
      }
      const parsed = parseSettings(stored)
      if (!parsed.ok) {
        tell(`judge.yaml in the config store is not valid, so the shipped default is used: ${parsed.problem}`)
        return DEFAULT_SETTINGS
      }
      lastGood = parsed.settings
      return parsed.settings
    } catch (error) {
      tell(`could not get the judge settings (${describe(error)}); using the shipped default`)
      return DEFAULT_SETTINGS
    }
  }
  let reading: Promise<JudgeSettings> | undefined
  return () => {
    reading ??= read().finally(() => { reading = undefined })
    const mine = reading
    return new Promise<JudgeSettings>((resolve) => {
      const timer = setTimeout(() => {
        tell(`reading judge.yaml from the config store took more than ${budgetMs} ms; using ${lastGood === undefined ? 'the shipped default' : 'the settings last read'} until it answers`)
        resolve(lastGood ?? DEFAULT_SETTINGS)
      }, budgetMs)
      mine.then((settings) => { clearTimeout(timer); resolve(settings) }, () => { clearTimeout(timer); resolve(lastGood ?? DEFAULT_SETTINGS) })
    })
  }
}

/**
 * Provide `dishJudge`, and claim and seed `judge.yaml` whenever the store is there.
 * @throws a plain `Error` for a `baseUrl`, `keyName` or `stateDirectory` that can't be used.
 */
export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger(name)
  if (config.terminal) printOwnLogs(ctx, name)
  /** A logger that throws is not worth a failed lookup or a failed start. */
  const warn = (format: string, ...args: unknown[]): void => {
    try {
      logger.warn(format, ...args)
    } catch {
      // Nothing to do about it.
    }
  }

  // Checked now, so a bad setting fails the plugin to load rather than the first call. The log, which uses the state
  // directory, comes in a later step.
  const baseUrl = baseUrlOf(text(config.baseUrl))
  const keyName = keyNameOf(text(config.keyName))
  resolve(stateDirectoryPath(text(config.stateDirectory)))

  // `ctx.get` is read on every call: the store is optional, and may come, go and come back.
  const settings = createSettingsReader(() => ctx.get('dishConfig'), logger)

  // With the store there: claim judge.yaml, as an effect so it goes when the store, or this plugin, does, and seed it.
  // A claim that is refused (someone else owns the path) or a seed that fails leaves the store as it is.
  ctx.inject(['dishConfig'], async (child) => {
    const store = child.dishConfig
    let present = true
    child.effect(() => () => { present = false })
    try {
      child.effect(() => child.dishConfig.claim(JUDGE_SPEC))
    } catch (error) {
      warn('could not claim judge.yaml: %s', describe(error))
      return
    }
    try {
      await store.seed({ 'judge.yaml': DEFAULT_TEXT }, name)
    } catch (error) {
      // Unless the store is going away, which closed it under the seed.
      if (present) warn('could not seed judge.yaml: %s', describe(error))
    }
  })

  ctx.provide('dishJudge', { settings })

  // The key is read from dsh's credential store on every call, by the name in the settings, and never kept: the client
  // holds it for one request. `credentials` is a sibling's service, so it is looked up with `ctx.get` and may be absent;
  // there is then no key, which is an unavailable judge, not an error. The name is an environment-variable name, which
  // `keyNameOf` has checked, so it is a reference as dsh means it.
  const key = async (): Promise<string | undefined> => {
    const resolved = await ctx.get('credentials')?.resolve(keyName as CredentialRef)
    return resolved?.value
  }
  // TODO(Task 3/4): write each line to the decision log (`JudgeLog`, in the state directory) once there is one.
  const log = (_line: LogLine): void => {}
  ctx.provide('judge', createJudge({ baseUrl, key, settings, log }))
}
