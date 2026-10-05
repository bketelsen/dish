/**
 * The services dish-browser reads: dsh's and crew's, each with `ctx.get` on each use (a service may come, go and come
 * back), typed structurally here so that nothing of theirs is imported at run time. `tools` is the one service the plugin
 * injects, and it isn't here.
 *
 * @module dish-browser/services
 */

import { realpath } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { OwnAddress } from './types.ts'

/** A live agent, as `ctx.agents.get(id)` gives it (dsh-agent): its id is its session's id. */
export interface AgentHandle { id: string | number, session: unknown, options?: unknown }

/** An image saved in dsh's attachment store (dsh-attachment's `ImageAttachmentRef`, as `read_image` returns it). */
export interface ImageRef {
  attachmentId: string
  mediaType: string
  bytes: number
  width: number
  height: number
  name?: string
  originalDimensions?: { width: number, height: number }
}

/** Each service as it is now, or `undefined` when its plugin isn't running. */
export interface Services {
  agents(): { get(id: string): AgentHandle | undefined } | undefined
  sandboxPolicy(): { resolve(request: { session: unknown }): { workspaceRoot?: unknown } } | undefined
  attachments(): {
    imageLimits: { mediaTypes: readonly string[] }
    saveImage(input: { data: Uint8Array, mediaType: string, name?: string }): Promise<ImageRef>
  } | undefined
  llm(): { resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<{ inputModalities?: readonly string[] }> } | undefined
  workspaceRegistry(): { archivedSessionIds: readonly string[] } | undefined
  crew(): { records: { children(sessionId: string): Promise<Array<{ id: string, role: string, title: string }>> } } | undefined
  webServer(): { port: number } | undefined
}

/** The services of `ctx`, each read with `ctx.get` on each call. */
export function contextServices(ctx: Context): Services {
  const lookup = ctx as unknown as { get(name: string): unknown }
  const read = <T>(name: string) => (): T | undefined => {
    try {
      return (lookup.get(name) ?? undefined) as T | undefined
    } catch {
      return undefined
    }
  }
  return {
    agents: read('agents'),
    sandboxPolicy: read('sandboxPolicy'),
    attachments: read('attachments'),
    llm: read('llm'),
    workspaceRegistry: read('workspaceRegistry'),
    crew: read('dishCrew'),
    webServer: read('webServer'),
  }
}

function given(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** The session's own working directory: `session.header.cwd` (dsh-session `lib/types/types.d.ts:69`). */
function cwdOf(session: unknown): string | undefined {
  try {
    const header = (session as { header?: { cwd?: unknown } } | undefined)?.header
    return given(header?.cwd)
  } catch {
    return undefined
  }
}

/** The sandbox policy's workspace root for the session (dsh-sandbox-policy `resolve`), as dish-judge reads it. */
function policyRootOf(services: Services, session: unknown): string | undefined {
  try {
    const resolved = services.sandboxPolicy()?.resolve({ session })
    return given(resolved?.workspaceRoot)
  } catch {
    return undefined
  }
}

/**
 * The session's workspace root, canonical: the sandbox policy's `resolve({ session }).workspaceRoot`, else the session's
 * `header.cwd`; then `realpath`'d. `undefined` when there is neither, or anything throws.
 */
export async function workspaceOf(services: Services, session: unknown): Promise<string | undefined> {
  const root = policyRootOf(services, session) ?? cwdOf(session)
  if (root === undefined) return undefined
  try {
    return await realpath(root)
  } catch {
    return undefined
  }
}

/** dsh's own address: the web server's port (on every loopback name), and `DISH_TRUSTED_HOST` (on any port). */
export function ownAddress(services: Services, env: NodeJS.ProcessEnv = process.env): OwnAddress {
  let port: number | undefined
  try {
    const value = services.webServer()?.port
    port = typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
  } catch {
    port = undefined
  }
  return { port, trustedHost: given(env.DISH_TRUSTED_HOST) }
}

/** Whether the session's agent is live: dsh has it loaded (`ctx.agents.get`, keyed by the session's id). */
export function isLive(services: Services, sessionId: string): boolean {
  try {
    return services.agents()?.get(sessionId) !== undefined
  } catch {
    return false
  }
}
