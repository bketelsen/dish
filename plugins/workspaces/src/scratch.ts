/**
 * The scratch workspace: `<work root>/scratch`, registered with dsh's workspace registry once, for general chats.
 *
 * dsh's web UI has no chat without a workspace, and a general chat must not run in `~/work` itself (a workspace's folder
 * is where agents write without asking: dsh reads `~/work/.env` at start, and every clone lives under `~/work`).
 *
 * "Once only" is dish's own record, `<state>/workspaces/scratch`, because the registry forgets a deleted registration
 * (re-adding the path makes a new record): with the record there, nothing is done, so a scratch workspace the user
 * removed stays removed, like dsh's own first-use default. Deleting the record brings it back at the next start. A
 * workspace already registered for the path (one added by hand) is adopted and keeps its title.
 *
 * It never fails the start: an error is logged (once per distinct error) and the result is `failed`, so the next start
 * tries again.
 *
 * @module dish-workspaces/scratch
 */

import { lstat, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { maskSecrets } from 'dish-kit'
import { writeFileAtomic } from './paths.ts'
import { registerWorkspace } from './registry.ts'
import type { WorkspaceRegistryLike } from './registry.ts'

/** The workspace's title. */
export const SCRATCH_TITLE = 'scratch'

export interface ScratchOptions {
  registry: WorkspaceRegistryLike
  /** dish-kit's `workRoot()`. */
  workRoot: string
  /** `scratchRecordFile(state)`. */
  record: string
  logger: { warn(format: string, ...args: unknown[]): void }
}

const MAX_LOGGED_CHARS = 200

/** What has been logged, so a failure that repeats (a reloaded registry, a start after start) is one line. */
const logged = new Set<string>()

function logOnce(options: ScratchOptions, error: unknown): void {
  const text = error instanceof Error ? error.message : String(error)
  const message = Array.from(maskSecrets(text.replace(/[\x00-\x1f\x7f]+/g, ' '))).slice(0, MAX_LOGGED_CHARS).join('')
  const key = `${options.record}\n${message}`
  if (logged.has(key)) return
  logged.add(key)
  options.logger.warn('could not set up the scratch workspace: %s', message)
}

/** Whether anything is at `file` (a link counts, followed or not). A record that doesn't parse is still a record. */
async function recorded(file: string): Promise<boolean> {
  try {
    await lstat(file)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/**
 * Once only: with no record, `mkdir -p <workRoot>/scratch` (0700), register it as "scratch", write the record
 * (`{ path, workspace, at }`, `at` in ms). With a record, nothing, not even the directory.
 *
 * - `registered`: dish made the registration.
 * - `adopted`: the registry already had a record for the path; it keeps its title and is now recorded.
 * - `recorded-before`: a record was there.
 * - `failed`: an error, logged (masked, once per distinct error); no record is written unless the registration was made,
 *   and a registration without its record is adopted at the next start. Never throws.
 */
export async function ensureScratch(options: ScratchOptions): Promise<'registered' | 'adopted' | 'recorded-before' | 'failed'> {
  try {
    if (await recorded(options.record)) return 'recorded-before'
    const path = join(options.workRoot, 'scratch')
    await mkdir(path, { recursive: true, mode: 0o700 })
    // Register first, record after: a failure between them registers the directory again at the next start (adopting
    // it), where the other order would never register it at all.
    const workspace = await registerWorkspace(options.registry, path, SCRATCH_TITLE)
    await writeFileAtomic(options.record, `${JSON.stringify({ path, workspace: workspace.id, at: Date.now() })}\n`)
    return workspace.created ? 'registered' : 'adopted'
  } catch (error) {
    logOnce(options, error)
    return 'failed'
  }
}
