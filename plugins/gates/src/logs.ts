/**
 * Gate logs: where they go, how they're written, and their pruning.
 *
 * A gate's log is `<state>/gates/<owner>/<repo>/<slug>/<child>-<turn>-<round>.log`, with `<state>` dish's state
 * directory (dish-kit's `xdgPaths('dish').state`). It holds a short header and the gate's kept output (at most 4 MiB),
 * masked before it gets here. open_pr's gate (`runAt`) logs to `open_pr.log` in the same directory, and each run after the
 * first gets the next free name (`open_pr.2.log`, …), as any taken name does.
 *
 * - **Paths.** The parts are checked here, by dish-gates' own rule, since it imports no runtime code from dish-projects
 *   or dish-workspaces: the owner, the repo and the slug are each one path segment of `[A-Za-z0-9._-]`, not `.` or
 *   `..`, and the child id is cut to `[A-Za-z0-9_-]`, 64 characters at most.
 * - **Writing.** Directories 0700, files 0600, each log a new file (`O_EXCL`) opened without following a link
 *   (`O_NOFOLLOW`). A name that is taken, by an earlier log or by anything else, isn't touched: the log gets the next
 *   free name, `.2`, `.3` and on, before `.log`.
 * - **Pruning.** `.log` files older than 30 days (by mtime) go, and so do the directories that leaves empty. Links are
 *   neither followed nor removed.
 *
 * @module dish-gates/logs
 */

import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, rmdir, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

/** How long a gate log is kept: 30 days. */
export const LOG_KEEP_MS = 2_592_000_000

/** One path segment of a log's path: an owner, a repo or a slug. `.` and `..` are refused besides. */
const SEGMENT = /^[A-Za-z0-9._-]+$/
/** What a child id keeps in a log's name. */
const NOT_CHILD = /[^A-Za-z0-9_-]/g
const CHILD_MAX = 64
/** How far `writeLog` looks for a free name. */
const MAX_NAMES = 1000

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
}

function segment(what: string, value: string): string {
  if (typeof value !== 'string' || !SEGMENT.test(value) || value === '.' || value === '..') {
    throw new TypeError(`a gate log's ${what} must be one path segment of [A-Za-z0-9._-], not . or ..: ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * `<state>/gates/<owner>/<repo>/<slug>/<child>-<turn>-<round>.log`. Throws unless owner, repo and slug are each one
 * segment of [A-Za-z0-9._-], not `.` or `..`; `child` is cut to [A-Za-z0-9_-], 64 at most.
 * @throws TypeError for a refused part, a child id with nothing left of it, a turn that isn't a whole number from 0, or
 *   a round that isn't one from 1.
 */
export function gateLogFile(state: string, project: string, slug: string, child: string, turn: number, round: number): string {
  const parts = typeof project === 'string' ? project.split('/') : []
  if (parts.length !== 2) throw new TypeError(`a gate log's project must be owner/repo: ${JSON.stringify(project)}`)
  const owner = segment('owner', parts[0]!)
  const repo = segment('repo', parts[1]!)
  segment('slug', slug)
  const id = String(child).replace(NOT_CHILD, '').slice(0, CHILD_MAX)
  if (id === '') throw new TypeError(`a gate log's child id has nothing in [A-Za-z0-9_-]: ${JSON.stringify(child)}`)
  if (!Number.isSafeInteger(turn) || turn < 0) throw new TypeError(`a gate log's turn must be a whole number from 0: ${turn}`)
  if (!Number.isSafeInteger(round) || round < 1) throw new TypeError(`a gate log's round must be a whole number from 1: ${round}`)
  return join(state, 'gates', owner, repo, slug, `${id}-${turn}-${round}.log`)
}

/**
 * `<state>/gates/<owner>/<repo>/<slug>/open_pr.log`: the log of an open_pr gate (`runAt`), with `gateLogFile`'s checks of the
 * owner, the repo and the slug. `writeLog` gives a taken name `.2`, `.3`, ….
 * @throws TypeError for a refused part.
 */
export function checkLogFile(state: string, project: string, slug: string): string {
  const parts = typeof project === 'string' ? project.split('/') : []
  if (parts.length !== 2) throw new TypeError(`a gate log's project must be owner/repo: ${JSON.stringify(project)}`)
  const owner = segment('owner', parts[0]!)
  const repo = segment('repo', parts[1]!)
  segment('slug', slug)
  return join(state, 'gates', owner, repo, slug, 'open_pr.log')
}

/** `file`, or its `n`th name: `<stem>.<n>.log`. */
function nameFor(file: string, n: number): string {
  if (n === 1) return file
  const name = basename(file)
  const stem = name.endsWith('.log') ? name.slice(0, -'.log'.length) : name
  return join(dirname(file), `${stem}.${n}${name.endsWith('.log') ? '.log' : ''}`)
}

/**
 * Write `text` as a new file: directories 0700, the file 0600, O_EXCL and O_NOFOLLOW; a name already taken gets `.2`,
 * `.3` and on. Gives the path written.
 * @throws the file system's error when the directory can't be made or the file can't be written (a file that was
 *   started is removed again), or an Error when every name up to `.1000` is taken.
 */
export async function writeLog(file: string, text: string): Promise<string> {
  const directory = dirname(file)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  let remade = false
  for (let n = 1; n <= MAX_NAMES;) {
    const candidate = nameFor(file, n)
    let handle
    try {
      handle = await open(candidate, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    } catch (error) {
      // Taken, by a file or a link (O_EXCL never follows one): the next name.
      if (errorCode(error) === 'EEXIST') {
        n++
        continue
      }
      // The directory went between mkdir and open (pruning empties directories): make it again, once.
      if (errorCode(error) === 'ENOENT' && !remade) {
        remade = true
        await mkdir(directory, { recursive: true, mode: 0o700 })
        continue
      }
      throw error
    }
    try {
      await handle.writeFile(text)
    } catch (error) {
      await handle.close().catch(() => {})
      await unlink(candidate).catch(() => {})
      throw error
    }
    await handle.close()
    return candidate
  }
  throw new Error(`every name for the gate log ${file} up to .${MAX_NAMES} is taken`)
}

/** Remove the old logs under `directory`; gives how many went. Directories it empties go too. */
async function pruneUnder(directory: string, cutoff: number): Promise<number> {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return 0
    throw error
  }
  let removed = 0
  for (const entry of entries) {
    const path = join(directory, entry.name)
    // A Dirent is the entry itself: a link is neither a directory nor a file here, so it is never followed or removed.
    if (entry.isDirectory()) {
      const inner = await pruneUnder(path, cutoff)
      removed += inner
      // Only a directory this pruning took something from, and only if that left it empty.
      if (inner > 0) {
        await rmdir(path).catch((error: unknown) => {
          if (!['ENOTEMPTY', 'EEXIST', 'ENOENT'].includes(errorCode(error) as string)) throw error
        })
      }
    } else if (entry.isFile() && entry.name.endsWith('.log')) {
      const info = await lstat(path).catch(() => undefined)
      if (info === undefined || !info.isFile() || info.mtimeMs >= cutoff) continue
      try {
        await unlink(path)
        removed++
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error
      }
    }
  }
  return removed
}

/**
 * Remove `.log` files under <state>/gates older than LOG_KEEP_MS, and directories left empty. Links aren't followed.
 * Gives how many files went. `<state>/gates` itself stays.
 * @throws the file system's error for anything but a file or directory that went meanwhile.
 */
export async function pruneLogs(state: string, now: number = Date.now()): Promise<number> {
  const root = join(state, 'gates')
  let info
  try {
    info = await lstat(root)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return 0
    throw error
  }
  if (!info.isDirectory()) return 0
  return pruneUnder(root, now - LOG_KEEP_MS)
}
