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
  /**
   * What has been logged, so a failure that repeats (a start after start, a reloaded registry) is one line. The caller
   * owns it, and drops it when its plugin goes, so a reload starts clean. Without one, each call remembers nothing.
   */
  logged?: Set<string>
}

const MAX_LOGGED_CHARS = 200

/** The random part of writeFileAtomic's temporary file name (`.<name>.<12 hex>.tmp`): it differs on every attempt. */
const TEMP_SUFFIX = /\.[0-9a-f]{12}\.tmp\b/g

function logOnce(options: ScratchOptions, error: unknown): void {
  const text = error instanceof Error ? error.message : String(error)
  const masked = maskSecrets(text.replace(/[\x00-\x1f\x7f]+/g, ' '))
  const message = Array.from(masked).slice(0, MAX_LOGGED_CHARS).join('')
  // The same failure is the same line, whatever the temporary file was called this time: its name is taken out before
  // the cut, which may fall inside it (a long TMPDIR moves the cut).
  const key = `${options.record}\n${Array.from(masked.replace(TEMP_SUFFIX, '')).slice(0, MAX_LOGGED_CHARS).join('')}`
  if (options.logged?.has(key)) return
  options.logged?.add(key)
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
 * (`{ path, workspace, at }`: the workspace's canonical path, its id, and the time in ms). With a record, nothing, not even the directory.
 *
 * - `registered`: dish made the registration.
 * - `adopted`: the registry already had a record for the path; it keeps its title and is now recorded.
 * - `recorded-before`: a record was there.
 * - `failed`: an error, logged (masked, once per distinct error for a caller that passes `logged`); no record is written unless the registration was made,
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
    // The path dsh holds (canonical), not the one dish built: they differ when the work root has a link on the way.
    const record = { path: workspace.path, workspace: workspace.id, at: Date.now() }
    await writeFileAtomic(options.record, `${JSON.stringify(record)}\n`)
    return workspace.created ? 'registered' : 'adopted'
  } catch (error) {
    logOnce(options, error)
    return 'failed'
  }
}
