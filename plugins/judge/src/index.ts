/**
 * dish-judge: a fast typed judge in front of the risky edges of every agent.
 *
 * This is the host plugin. It is the one place the judge's pieces are wired together; for now it:
 *
 * - provides the `dishJudge` service: `settings()` is the `judge.yaml` in the config store as it is now (see
 *   `settings.ts`), and `log` is the decision log (see below). Later steps add the listeners to this plugin;
 * - provides the `judge` service, the Jev client (see `client.ts`): the key is looked up in dsh's credential store on
 *   every call, the model and time limit are the settings of the moment, and every call is written to the decision log;
 * - claims `judge.yaml` in the store, closed to agents, and seeds it when `dishConfig` is there. `dishConfig` is
 *   optional, so there is no order to keep: with no store, every answer is the shipped default;
 * - checks its configuration when it loads, so a bad setting fails the plugin to load rather than the first call;
 * - prunes the decision log when it loads (day files and withheld files older than 30 days), before it provides
 *   anything, as crew prunes its records. A prune that fails is one warning, and the plugin loads all the same;
 * - logs as `dish-judge`.
 *
 * **The decision log, `ctx.get('dishJudge').log`**, is the one surface the gate, the approval answerer, the result screen,
 * `ask_judge` and the page use. It is the `JudgeLog` of `log.ts` in the state directory, with these differences:
 *
 * - `write(line)` returns at once, with nothing to wait for: a gate must never wait on a disk write, and a log that can't
 *   be written is no reason to fail a gate. It never throws, and a write the disk refuses is one warning for each distinct
 *   cause, not a flood. The Jev client's own lines are written through it (every call is logged, whatever its outcome); the
 *   approval answerer writes its `approval` lines with it, and anything else that decides something does the same. It is a
 *   plain function: it keeps working when taken off the service (`const { write } = log`).
 * - `withhold({ tool, content })` gives the id of what it kept. Before it keeps it, it hides the TypeSafe key in the
 *   content and the tool name (as it is, JSON-escaped and URL-encoded), which no secret pattern would find; the key is looked
 *   up for it, for at most `WITHHOLD_KEY_BUDGET_MS`, and with no key, or one that can't be had in time, it keeps the content
 *   all the same, masked by the patterns alone. It rejects when the disk does (and says so once), so the screen that
 *   withholds a result knows it did not keep it. `decide` hooks have the call's time limit, so a caller awaits it there.
 * - `read(query)` and `withheld(id)` are the log's own, for the page: a page of lines newest first, and what `withhold` kept.
 *   They reject for a query that isn't one, and for what the disk says. A `read` sees the lines written so far to a file
 *   that is there, but not one whose file the write has still to make: `flush()` first, in a test, to have them all.
 * - `flush()` resolves once every line written so far is on the disk or has failed. It never rejects. The plugin awaits it,
 *   for at most two seconds, when it unloads, so that the last decisions are not lost with the process.
 *
 * `prune` is not on it: pruning is the plugin's, at load.
 *
 * @module dish-judge
 */

import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import Schema from '@deepseek-ai/schemastery'
import { maskSecrets, printOwnLogs, xdgPaths } from 'dish-kit'
import { createJudge, currentKeyMask } from './client.ts'
import { JudgeLog } from './log.ts'
import type { JudgeLogLine, ReadQuery, ReadResult } from './log.ts'
import { DEFAULT_SETTINGS, DEFAULT_TEXT, JUDGE_SPEC, parseSettings } from './settings.ts'
import type { JudgeSettings } from './settings.ts'

export { createJudge } from './client.ts'
export type { Answer, Asked, Decision, Judge, JudgeAgent, JudgeDeps, JudgeRequest, JudgeResult, JudgeStatus, JsonValue, LogLine, Purpose, Question } from './client.ts'
export type { JudgeLogLine, JudgePurpose, ReadQuery, ReadResult } from './log.ts'
export type { CommandSettings, JudgeSettings, ParseResult, ScreeningSettings, ToolSettings } from './settings.ts'

export const name = 'dish-judge'

/** The decision log as the rest of the plugin, and the page, use it. See the header of this file. */
export interface JudgeLogService {
  /**
   * Record `line`. Returns at once: the line is on its way to the disk, and nothing waits for it. Never throws, and a write
   * that fails is one warning for each distinct cause.
   */
  write(line: JudgeLogLine): void
  /**
   * Keep `content`, which a screen withheld from the result of `tool`, for the user to read: masked (the key in it, whatever
   * form it is in, and anything that looks like a credential) and capped. Gives the id to put on the log line. Waits at most
   * `WITHHOLD_KEY_BUDGET_MS` for the key, and with none keeps the content with the patterns' mask alone.
   * @throws TypeError if `tool` or `content` isn't a string; whatever the disk says, which it also warns of, once.
   */
  withhold(input: { tool: string, content: string }): Promise<string>
  /** A page of lines, newest first: see `JudgeLog.read`. */
  read(query?: ReadQuery): Promise<ReadResult>
  /** What `withhold` kept under `id`, or `undefined`: see `JudgeLog.withheld`. */
  withheld(id: string): Promise<{ tool: string, content: string } | undefined>
  /** Resolve once every line written so far is on the disk, or has failed to be. Never rejects. */
  flush(): Promise<void>
}

/** The `dishJudge` service. */
export interface DishJudge {
  /**
   * The judge's settings: `judge.yaml` on `main` of the config store as it is now, so an edit shows at once. A missing
   * file, a file that doesn't pass `parseSettings`, a store that can't be read and no store at all each give the
   * shipped default, with one logged warning for each distinct problem. Never rejects.
   */
  settings(): Promise<JudgeSettings>
  /** The decision log. */
  log: JudgeLogService
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
    .description('The TypeSafe API: an https address, or an http one for localhost only, since the key is sent to it. Without the path of a call.'),
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

/** The hosts the key may be sent to in the clear: this machine. `URL` gives IPv6 addresses in brackets, and a short IPv4 address whole. */
const LOOPBACK_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '[::1]']
/** The path of the call, which the client adds itself. */
const CALL_PATH = '/v1/systemone'

/**
 * The address of the TypeSafe API: the setting without its trailing slashes, or the default if there is none.
 * @throws a plain `Error` for anything but an https address, or an http one for this machine (`localhost`, `127.0.0.1` or
 *   `[::1]`: the key is sent to it, so it is not sent in the clear anywhere else), with no username, password, query or
 *   fragment, and not ending in the path of the call. The message never repeats the setting, which might hold a secret.
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
  if (url.protocol === 'http:' && !LOOPBACK_HOSTS.includes(url.hostname)) {
    throw new Error('baseUrl must use https, because the key is sent to it: http is allowed only for localhost, 127.0.0.1 and [::1]')
  }
  if (url.pathname.replace(/\/+$/, '').endsWith(CALL_PATH)) {
    throw new Error(`baseUrl must not end with ${CALL_PATH}: it is the address of the API, and the judge adds that path itself`)
  }
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
  // What is wrong is shown, which is a mistake that can be a key pasted in the wrong field: with credentials masked, and cut short.
  if (!isAbsolute(setting)) throw new Error(`stateDirectory must be an absolute path (or start with ~/), got ${JSON.stringify(shortened(maskSecrets(setting), 100))}`)
  return setting
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** `text`, cut to `length` characters, with `…` where it was cut. */
function shortened(text: string, length: number): string {
  return text.length > length ? `${text.slice(0, length)}…` : text
}

/** Whether `error` is cordis refusing an effect because the plugin has been unloaded: a plugin that is going away didn't fail. */
function unloaded(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'INACTIVE_EFFECT'
}

/** What the settings need of the store: its reads. */
export type Reader = { read(path: string): Promise<string | undefined> }

export interface Logger {
  warn(format: string, ...args: unknown[]): void
}

/** The most distinct messages `warnOnce` remembers. */
export const MAX_TOLD = 100
/** The most of a message that `warnOnce` says and keeps: a message is a line, not the size of what it is about. */
const MAX_TOLD_CHARS = 2000

/**
 * A function that says each message to `logger` once, for the problems that repeat on every call (a store that is
 * down, a disk that is full): the first time is a warning, the rest are nothing. It remembers at most `MAX_TOLD` messages, and
 * past that forgets the oldest to make room, so a problem whose message differs every time can't grow it, and can't mute
 * a message that is said again and again either. Never throws: a logger that throws is not worth a failed call.
 */
export function warnOnce(logger: Logger): (message: string) => void {
  const told = new Set<string>()
  return (message) => {
    const text = message.length > MAX_TOLD_CHARS ? `${message.slice(0, MAX_TOLD_CHARS)}…` : message
    if (told.has(text)) return
    if (told.size >= MAX_TOLD) {
      const oldest = told.values().next()
      if (oldest.done !== true) told.delete(oldest.value)
    }
    told.add(text)
    try {
      logger.warn('%s', text)
    } catch {
      // Nothing to do about it.
    }
  }
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
export function createSettingsReader(
  store: () => Reader | undefined,
  logger: Logger,
  budgetMs = SETTINGS_READ_BUDGET_MS,
  /** What says a message once: the plugin's own, which the log shares, or one made from `logger`. */
  tell: (message: string) => void = warnOnce(logger),
): () => Promise<JudgeSettings> {
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

/** How long the decision log is kept: day files and withheld files older than this are removed when the plugin loads. */
export const KEEP_LOG_MS = 30 * 24 * 60 * 60 * 1000

/**
 * How long `withhold` waits for the key, to hide it in what it keeps. A key lookup is a read of a small file, so this is a
 * credential store that is stuck, not one that is slow; and the screen is waiting.
 */
export const WITHHOLD_KEY_BUDGET_MS = 250

/** How long the plugin waits for the log's writes to finish when it unloads. */
export const FLUSH_BUDGET_MS = 2000

/** What went wrong with the disk, in a few words that are the same each time the cause is: its code and the call that failed, else what it says. */
function reasonOf(error: unknown): string {
  const { code, syscall } = (typeof error === 'object' && error !== null ? error : {}) as { code?: unknown, syscall?: unknown }
  if (typeof code === 'string' && code !== '') return typeof syscall === 'string' && syscall !== '' ? `${code} (${syscall})` : code
  return describe(error)
}

/** What the log service needs of the log: what it hands on. */
export type LogStore = Pick<JudgeLog, 'write' | 'withhold' | 'read' | 'withheld' | 'flush'>

export interface LogServiceOptions {
  /** The key, looked up as the client looks it up; what `withhold` hides. */
  key: () => Promise<string | undefined>
  /** Says a message once: the helper the settings reader uses too. */
  tell: (message: string) => void
  /** Where the log is, for what is said. */
  directory: string
  /** How long `withhold` waits for the key. */
  keyBudgetMs?: number
}

/**
 * The log as the plugin's service: the log, with `write` that returns at once and never fails, and `withhold` that hides the
 * key. See the header of this file.
 */
export function createLogService(log: LogStore, options: LogServiceOptions): JudgeLogService {
  const { key, tell, directory, keyBudgetMs = WITHHOLD_KEY_BUDGET_MS } = options
  return {
    write(line) {
      const failed = (error: unknown): void => tell(`could not write the decision log in ${directory}: ${reasonOf(error)}`)
      try {
        Promise.resolve(log.write(line)).catch(failed)
      } catch (error) {
        failed(error)
      }
    },
    async withhold(input) {
      if (typeof input !== 'object' || input === null || typeof input.tool !== 'string' || typeof input.content !== 'string') {
        throw new TypeError('withhold takes { tool, content }, both strings')
      }
      // The key first, whole, before the log applies its patterns, which could change the text around it.
      const mask = await currentKeyMask(key, keyBudgetMs)
      try {
        return await log.withhold({ tool: mask(input.tool), content: mask(input.content) })
      } catch (error) {
        tell(`could not keep a withheld result in ${directory}: ${reasonOf(error)}`)
        throw error
      }
    },
    read: query => log.read(query),
    withheld: id => log.withheld(id),
    flush: async () => {
      try {
        await log.flush()
      } catch {
        // A failed write has said so already.
      }
    },
  }
}

/**
 * Provide `dishJudge` and `judge`, and claim and seed `judge.yaml` whenever the store is there.
 * @throws a plain `Error` for a `baseUrl`, `keyName` or `stateDirectory` that can't be used.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
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
  /** The one helper that says a problem once: the settings reader and the log use it, so what they remember is bounded together. */
  const tell = warnOnce(logger)

  // Checked now, so a bad setting fails the plugin to load rather than the first call.
  const baseUrl = baseUrlOf(text(config.baseUrl))
  const keyName = keyNameOf(text(config.keyName))
  const directory = resolve(stateDirectoryPath(text(config.stateDirectory)))

  // `ctx.get` is read on every call: the store is optional, and may come, go and come back.
  const settings = createSettingsReader(() => ctx.get('dishConfig'), logger, SETTINGS_READ_BUDGET_MS, tell)

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

  // The key is read from dsh's credential store on every call, by the name in the settings, and never kept: the client
  // holds it for one request. `credentials` is a sibling's service, so it is looked up with `ctx.get` and may be absent;
  // there is then no key, which is an unavailable judge, not an error. The name is an environment-variable name, which
  // `keyNameOf` has checked, so it is a reference as dsh means it.
  const key = async (): Promise<string | undefined> => {
    const resolved = await ctx.get('credentials')?.resolve(keyName as CredentialRef)
    return resolved?.value
  }

  const judgeLog = new JudgeLog(directory)
  const log = createLogService(judgeLog, { key, tell, directory })

  // A shutdown waits for the lines that are on their way, so that the last decisions are not lost with the process: cordis
  // runs this when the plugin is disposed. Not for long, since a disk that is stuck is no reason to hold up a shutdown.
  ctx.effect(() => async () => {
    let timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([log.flush(), new Promise<void>((done) => { timer = setTimeout(done, FLUSH_BUDGET_MS) })])
    } finally {
      clearTimeout(timer)
    }
  })

  // Before the services are there, so that nothing asks the log while it is pruned. A failure is logged, and the plugin
  // works all the same: old files that stay are only disk.
  try {
    const removed = await judgeLog.prune(KEEP_LOG_MS)
    if (removed.days + removed.withheld > 0) logger.info('removed %d day file(s) and %d withheld file(s) of the decision log older than 30 days', removed.days, removed.withheld)
  } catch (error) {
    warn('could not prune the decision log in %s: %s', directory, describe(error))
  }

  try {
    ctx.provide('dishJudge', { settings, log })
    ctx.provide('judge', createJudge({ baseUrl, key, settings, log: line => log.write(line) }))
  } catch (error) {
    // Unloaded while it was pruning: the plugin is going away, and didn't fail.
    if (unloaded(error)) return
    throw error
  }
}
