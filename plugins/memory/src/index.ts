/**
 * dish-memory: memory and direction for dish's agents, as a Cordis plugin.
 *
 * - **The vault** (`vault.ts`) is a bare git repository of user and family memories in Claude Code's format, run by
 *   dish-kit's `VersionedStore` as the config store is: a lock, one queue, a restore from the remote on a first start,
 *   and a push after every commit that never fails a save. Its remote is optional: without one the vault stays local.
 * - **The `dishMemory` service** (`service.ts`) reads and writes it, screens agents' memories with the judge, holds
 *   the flagged ones, keeps each family's direction in the config store, and composes the `dish-memory` message that
 *   the dish preset's row (`dish-memory/context`) delivers. `dish-memory/changed` follows every vault commit, and
 *   `dish-memory/remote` every change of the push's status.
 * - **Nothing of dish's is needed at load.** `dishProjects`, `dishWorkspaces` and `dishJudge` are read with `ctx.get` on
 *   each use, and whenever `dishConfig` is there the plugin claims `families/` in it (agents may only propose there),
 *   so there is no order to keep. A vault that won't open is logged, and nothing is provided: the row then does nothing,
 *   and the dish preset goes on without memory.
 *
 * @module dish-memory
 */

import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import type { Context, Events } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { printOwnLogs, xdgPaths } from 'dish-kit'
import { AGENT_IDENTITY, personIdentity } from 'dish-kit/store'
import type { RemoteStatus, VersionedStore } from 'dish-kit/store'
import { validateDirection } from './format.ts'
import { INDEX_BYTES, INDEX_LINES } from './protocol.ts'
import { MemoryRemote } from './remote.ts'
import { createMemory } from './service.ts'
import type { DishMemory } from './service.ts'
import { contextServices } from './services.ts'
import { openVault } from './vault.ts'

export { MemoryError } from './service.ts'
export type { AgentLike, DishMemory, Scopes, WriteResult } from './service.ts'
export type { MemoryInput, Scope } from './format.ts'

export const name = 'dish-memory'

export interface Config {
  vault: string
  remote: string
  userName: string
  userEmail: string
  indexLines: number
  indexBytes: number
  terminal: boolean
}

export const Config: Schema<Config> = Schema.object({
  vault: Schema.string().default('')
    .description('The vault\'s bare git repository: an absolute path, where a leading ~/ is your home directory. Leave blank for vault.git in the XDG data directory for dish.'),
  remote: Schema.string().default('')
    .description('Where to push the vault\'s main after every commit: a URL or path git can push to. Leave blank to keep the vault local.'),
  userName: Schema.string().default('')
    .description('The name your commits in the vault carry, as dish-config\'s. Leave blank to use git\'s global user.name, or "dish".'),
  userEmail: Schema.string().default('')
    .description('The email your commits in the vault carry, as dish-config\'s. Leave blank to use git\'s global user.email, or "dish@localhost".'),
  indexLines: Schema.natural().min(10).max(1000).default(INDEX_LINES)
    .description('The most lines of each scope\'s memory list in the dish-memory message.'),
  indexBytes: Schema.natural().min(1024).max(65_536).default(INDEX_BYTES)
    .description('The most bytes of each scope\'s memory list in the dish-memory message.'),
  terminal: Schema.boolean().default(true)
    .description('Print this plugin\'s messages to the terminal.'),
})

/** A string setting as it will be used: trimmed, and `undefined` when nothing is left (use the default). */
function text(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === '' ? undefined : trimmed
}

/**
 * Where the vault lives: the setting with a leading `~/` (or a bare `~`) taken as the home directory, else the XDG default.
 * @throws a plain `Error` for any other relative path: what it would be relative to is not something to guess.
 */
function vaultPath(setting: string | undefined): string {
  if (setting === undefined) return join(xdgPaths('dish').data, 'vault.git')
  if (setting === '~') return homedir()
  if (setting.startsWith('~/')) return join(homedir(), setting.slice(2))
  if (!isAbsolute(setting)) throw new Error(`vault must be an absolute path (or start with ~/), got ${JSON.stringify(setting)}`)
  return setting
}

/** Whether `error` is cordis refusing an effect because the plugin has been unloaded: a plugin that is going away didn't fail. */
function unloaded(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'INACTIVE_EFFECT'
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Register the listener and the `families/` claim, open the vault, then provide `dishMemory`. A vault that can't be
 * opened (a bad path, another process holding it, a directory that isn't a dish vault, a remote that can't be reached
 * at a first start) is logged as an error, and nothing is provided. Unloading the plugin closes the vault.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const logger = ctx.logger(name)
  if (config.terminal) printOwnLogs(ctx, name)

  // `ctx.parallel` calls every listener and settles them all, so a failing listener is only logged. Nothing is told
  // once the plugin is going away.
  let live = true
  const publish = <K extends keyof Events>(event: K, ...args: Parameters<Events[K]>): void => {
    if (!live) return
    try {
      ctx.parallel(event, ...args).catch((error: unknown) => {
        for (const cause of error instanceof AggregateError ? error.errors : [error]) logger.warn('a %s listener failed: %s', event, describe(cause))
      })
    } catch (error) {
      if (!unloaded(error)) logger.warn('could not emit %s: %s', event, describe(error))
    }
  }

  // Before anything is awaited. A config change may move a project to another family or change a direction: the
  // scopes and the messages are worked out again.
  let memory: ReturnType<typeof createMemory> | undefined
  ctx.on('dish-config/changed', () => memory?.clearCaches())

  // Whenever the store is there, as an effect of its presence, so that a later store gets it again. A claim that is
  // refused (another plugin owns families/) is logged: memory works all the same, and no direction can be saved.
  ctx.inject(['dishConfig'], (child) => {
    try {
      child.effect(() => child.dishConfig.claim({ prefix: 'families/', owner: name, agent: 'propose', validate: validateDirection }))
    } catch (error) {
      if (!unloaded(error)) logger.warn('could not claim families/ in the config store: %s', describe(error))
    }
  })

  // Terminal output follows the remote's status, as dish-config's does: a line when an error appears or goes away, and
  // one for the first push. Nothing is said until the ready line is out.
  let failing = false
  let pushedOnce = false
  let announced = false
  let latest: RemoteStatus | undefined
  const report = (status: RemoteStatus): void => {
    const hasError = status.lastError !== undefined
    if (hasError && !failing) logger.warn('push failing: %s (%d unpushed)', status.lastError, status.pending)
    else if (!hasError && failing) logger.info('push working again')
    failing = hasError
    if (!pushedOnce && status.pushed !== undefined) {
      pushedOnce = true
      logger.info('pushed %s', status.pushed.slice(0, 7))
    }
  }

  const setting = text(config.vault)
  const remote = text(config.remote)
  let repository = setting ?? ''
  let store: VersionedStore
  try {
    repository = resolve(vaultPath(setting))
    store = await openVault({
      repository,
      ...(remote === undefined ? {} : { remote }),
      user: await personIdentity(config),
      agent: AGENT_IDENTITY,
      onRemoteStatus: (status) => {
        publish('dish-memory/remote', status)
        latest = status
        if (announced) report(status)
      },
    })
  } catch (error) {
    // Never a half-open service: nothing is provided, and the row adds no message.
    logger.error('cannot open the vault at %s: %s', repository, describe(error))
    return
  }
  // From here on, unloading the plugin closes the vault: it drains the queue, kills a push in flight and releases the lock.
  try {
    ctx.effect(() => async () => {
      live = false
      await store.close()
    })
  } catch (error) {
    // The plugin was unloaded while the vault was opening, so nothing will ever close it.
    await store.close().catch(() => {})
    if (unloaded(error)) return
    throw error
  }

  const service = createMemory({
    store,
    services: contextServices(ctx),
    budget: { lines: config.indexLines, bytes: config.indexBytes },
    warn: message => logger.warn('%s', message),
    emit: (scopes, commit, author) => publish('dish-memory/changed', scopes, commit, author),
  })
  memory = service
  // Only the documented methods: `clearCaches` is the plugin's own.
  const dishMemory: DishMemory = {
    scopesFor: agent => service.scopesFor(agent),
    scopes: () => service.scopes(),
    list: scope => service.list(scope),
    read: (scope, memoryName) => service.read(scope, memoryName),
    write: (scope, input, meta) => service.write(scope, input, meta),
    delete: (scope, memoryName, meta) => service.delete(scope, memoryName, meta),
    release: (scope, memoryName, meta) => service.release(scope, memoryName, meta),
    compose: (scopes, options) => service.compose(scopes, options),
    direction: family => service.direction(family),
    saveDirection: (family, direction, meta) => service.saveDirection(family, direction, meta),
    history: (scope, options) => service.history(scope, options),
    commit: id => service.commit(id),
    revert: (id, meta) => service.revert(id, meta),
    remoteStatus: () => service.remoteStatus(),
  }
  try {
    ctx.provide('dishMemory', dishMemory)
  } catch (error) {
    // Unloaded while the vault was opening: the close effect is registered, so it closes the vault. Not a failure.
    if (unloaded(error)) return
    throw error
  }
  // Settings → Memory's remote: a child plugin that needs `dishMemory`, so it goes when the service does.
  ctx.plugin(MemoryRemote)
  logger.info('vault ready at %s', repository)
  announced = true
  if (latest !== undefined) report(latest)
}
