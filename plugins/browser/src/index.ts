/**
 * dish-browser: one headless Chromium, a browser per agent session, the ten `browser_*` tools, and the stream the Browser
 * tab watches.
 *
 * A host plugin with a client half, like dish-orchestrator. This file wires the host half:
 * - **the core** (`browsers.ts`): Chromium, every session's browser, the limits and the watchers, over the real driver
 *   (`playwright.ts`), the URL rules (`urls.ts`) and the keys (`keys.ts`);
 * - **the listeners,** registered at once: `agent/created` and `agent/disposed` (a watch's `canStart`, and a disposed
 *   agent's browser), and `workspace/session-stop` (a chat stopped and archived). It never answers
 *   `workspace/session-activity`: an open browser isn't work to wait for;
 * - **the sweep,** every minute: an archived chat's browser (archiving an idle chat sends no event), and an idle one;
 * - **the tools,** through `ctx.inject(['tools'])`, only when there is Chromium at `executablePath`;
 * - **the remote** (`remote.ts`), mounted either way: without Chromium, the tab says so.
 *
 * dsh's and crew's services are read with `ctx.get` on each use (`services.ts`): nothing of theirs is needed at load, and
 * there is no order to keep. Everything the plugin starts ends with it: the core closes every browser and Chromium, the
 * sweep stops, the listeners go, and the open watches end. Logs are `dish-browser`'s, printed when `terminal` is on; a
 * log line names a session and a reason, never a URL.
 *
 * @module dish-browser
 */

import { accessSync, constants, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-workspace'
import Schema from '@deepseek-ai/schemastery'
import { printOwnLogs } from 'dish-kit'
import { Browsers } from './browsers.ts'
import { systemClock } from './clock.ts'
import type { Clock } from './clock.ts'
import type { Driver } from './driver.ts'
import { replayAs } from './keys.ts'
import { playwrightDriver } from './playwright.ts'
import type { Viewport } from './protocol.ts'
import { browserRemote } from './remote.ts'
import { contextServices, ownAddress } from './services.ts'
import { browserTools } from './tools.ts'
import { SWEEP_MS } from './types.ts'
import type { Limits } from './types.ts'
import { rules, sharedTmpOf } from './urls.ts'

export const name = 'dish-browser'

/** The Chromium Playwright drives when the config names none (`''`): Debian's. */
const DEFAULT_EXECUTABLE = '/usr/bin/chromium'

export interface Config {
  executablePath: string
  viewport: Viewport
  maxBrowsers: number
  idleMinutes: number
  snapshotChars: number
  terminal: boolean
}

export const Config: Schema<Config> = Schema.object({
  executablePath: Schema.string().default(DEFAULT_EXECUTABLE)
    .description('The Chromium Playwright drives. Without an executable file there, the browser tools aren\'t registered.'),
  viewport: Schema.object({
    width: Schema.natural().min(320).max(3840).default(1280).description('The page\'s width, in CSS pixels.'),
    height: Schema.natural().min(240).max(2160).default(800).description('The page\'s height, in CSS pixels.'),
  }).description('Every browser\'s page size. The tab scales its picture; the page is never resized.'),
  maxBrowsers: Schema.natural().min(1).max(20).default(6)
    .description('Browsers open at once, over all sessions. Opening one more closes the least recently used.'),
  idleMinutes: Schema.natural().min(1).default(15)
    .description('A browser with no agent call, no input and no watcher for this long closes.'),
  snapshotChars: Schema.natural().min(2000).max(34_000).default(30_000)
    .description('The most snapshot text in one result. Keep it under dsh\'s spill cap.'),
  terminal: Schema.boolean().default(true).description('Print this plugin\'s messages to the terminal.'),
})

/** For tests only; never config. */
export interface BrowserInternals {
  /** Default: `playwrightDriver`. */
  driver?: Driver
  /** Default: `systemClock`. */
  clock?: Clock
  /** Whether Chromium is at `path`. Default: a regular file with X_OK, symbolic links followed. */
  executable?: (path: string) => boolean
  /** Whether `/tmp` counts for `file://`. Default: `sharedTmpOf(os.tmpdir())`. */
  sharedTmp?: boolean
  /** Where `DISH_TRUSTED_HOST` is read. Default: `process.env`. */
  env?: NodeJS.ProcessEnv
}

export function apply(ctx: Context, config: Config): void {
  start(ctx, config, {})
}

/** A regular file (symbolic links followed) that this process may execute. */
function isExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function describe(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split('\n', 1)[0] ?? ''
}

/** The session id of an `agent/created` or `agent/disposed` payload: dsh's agent id is its session's id. */
function sessionOf(payload: unknown): string | undefined {
  const id = (payload as { agent?: { id?: unknown } } | null | undefined)?.agent?.id
  return (typeof id === 'string' || typeof id === 'number') && String(id) !== '' ? String(id) : undefined
}

/** `apply`, with `internals`. Gives the core, which tests drive. */
export function start(ctx: Context, config: Config, internals: BrowserInternals): Browsers {
  const logger = ctx.logger(name)
  if (config.terminal) printOwnLogs(ctx, name)
  const say = (level: 'info' | 'warn', message: string): void => {
    try {
      logger[level]('%s', message)
    } catch {
      // A logger that throws is not worth a failed browser call.
    }
  }
  const log = { info: (message: string) => { say('info', message) }, warn: (message: string) => { say('warn', message) } }

  const driver = internals.driver ?? playwrightDriver
  const clock = internals.clock ?? systemClock
  const env = internals.env ?? process.env
  const sharedTmp = internals.sharedTmp ?? sharedTmpOf(tmpdir())
  const executablePath = config.executablePath === '' ? DEFAULT_EXECUTABLE : config.executablePath
  const viewport: Viewport = { width: config.viewport.width, height: config.viewport.height }
  const limits: Limits = { maxBrowsers: config.maxBrowsers, idleMinutes: config.idleMinutes }
  const services = contextServices(ctx)
  const own = () => ownAddress(services, env)

  let chromium: boolean
  try {
    chromium = (internals.executable ?? isExecutable)(executablePath)
  } catch {
    chromium = false
  }
  if (!chromium) say('warn', `no Chromium at ${executablePath}: the browser tools aren't registered, and the Browser tab says so`)

  const core = new Browsers({
    driver, clock, executablePath, viewport, limits, rules, sharedTmp, own, log, keys: { replayAs },
    ...chromium ? {} : { unavailable: executablePath },
  })

  // The listeners, before anything is awaited. Each catches its own errors: `agent/created` is awaited by dsh before the
  // agent runs, and a throw there would fail its creation.
  ctx.on('agent/created', (payload) => {
    try {
      const sessionId = sessionOf(payload)
      if (sessionId !== undefined) core.touch(sessionId)
    } catch {
      // Nothing of the agent's depends on its browser's view.
    }
    return undefined
  })
  ctx.on('agent/disposed', (payload) => {
    try {
      const sessionId = sessionOf(payload)
      if (sessionId !== undefined) core.agentDisposed(sessionId)
    } catch {
      // The sweep closes it when it idles.
    }
  })
  ctx.on('workspace/session-stop', (request) => {
    try {
      const sessionId = (request as { sessionId?: unknown } | null | undefined)?.sessionId
      if (typeof sessionId === 'string' && sessionId !== '') void core.close(sessionId, 'archived').catch(() => {})
    } catch {
      // The sweep closes it: the session is in the registry's archived list.
    }
  })

  // The sweep: every minute, the archived chats' browsers and the idle ones. Its timer goes with the plugin.
  const archived = (): ReadonlySet<string> => {
    try {
      return new Set(services.workspaceRegistry()?.archivedSessionIds ?? [])
    } catch {
      return new Set()
    }
  }
  ctx.effect(() => {
    let live = true
    let cancel: () => void = () => {}
    const round = (): void => {
      if (!live) return
      cancel = clock.after(SWEEP_MS, round)
      void core.sweep(archived()).catch(() => {})
    }
    cancel = clock.after(SWEEP_MS, round)
    return () => {
      live = false
      cancel()
    }
  })

  // The tools, global, registered through the child context, so they go when `tools` does, or this plugin.
  if (chromium) {
    const tools = browserTools({ core, services, rules, sharedTmp, config: { snapshotChars: config.snapshotChars, viewport, limits }, clock, own })
    ctx.inject(['tools'], (inner) => {
      for (const tool of tools) {
        try {
          inner.tools.register(tool)
        } catch (error) {
          say('warn', `could not register ${tool.name}: ${describe(error)}`)
        }
      }
    })
  }

  browserRemote(ctx, { core, services, clock, limits, viewport, log: { warn: log.warn } })

  // Every browser and Chromium close with the plugin; the remote's open watches end with its own scope.
  ctx.effect(() => async () => { await core.stop() })
  return core
}
