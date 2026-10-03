/**
 * dsh's real workspace registry, mounted over a temp directory, for dish-workspaces' tests.
 *
 * The composition is the one dsh-web-app mounts for its `workspace` row, with the storage under a temp directory:
 * `dsh-storage`, `dsh-storage-json`, `dsh-storage-domain` (`backend: json`), `dsh-session`,
 * `dsh-session-persistence-jsonl` and `dsh-workspace`. Nothing here reads or writes a real `~/.dsh`.
 *
 * @module dish-workspaces/test/registry-helpers
 */

import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import session from '@deepseek-ai/dsh-session'
import persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import storage from '@deepseek-ai/dsh-storage'
import * as storageDomain from '@deepseek-ai/dsh-storage-domain'
import * as storageJson from '@deepseek-ai/dsh-storage-json'
import workspace from '@deepseek-ai/dsh-workspace'
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'

export interface MountedRegistry {
  ctx: Context
  /** dsh's registry, started (its asynchronous init has finished). */
  registry: WorkspaceRegistry
  /** Stop everything. Safe to call twice. */
  stop(): Promise<void>
}

/** Resolve when `ctx.workspaceRegistry` is active (cordis' `ctx.get` returns a service only once its plugin is). */
function registryReady(ctx: Context): Promise<WorkspaceRegistry> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('dsh-workspace did not start within 20 s')), 20_000)
    ctx.inject(['workspaceRegistry'], inner => {
      clearTimeout(timer)
      resolve(inner.workspaceRegistry)
    })
  })
}

/** Mount dsh's workspace registry with its storage under `<dir>/storages` and `<dir>/sessions`. */
export async function mountRegistry(dir: string): Promise<MountedRegistry> {
  const ctx = new Context()
  const mounted = [
    ctx.plugin(storage),
    ctx.plugin(storageJson, { root: join(dir, 'storages') }),
    ctx.plugin(storageDomain, { backend: 'json' }),
    ctx.plugin(session),
    ctx.plugin(persistence, { root: join(dir, 'sessions') }),
    ctx.plugin(workspace),
  ]
  const registry = await registryReady(ctx)
  let stopped = false
  return {
    ctx,
    registry,
    async stop() {
      if (stopped) return
      stopped = true
      for (const fiber of mounted.reverse()) await fiber.dispose()
    },
  }
}
