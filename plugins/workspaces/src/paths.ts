/**
 * Where dish-workspaces keeps things: pure functions of the roots they are given (`<state>` is dish-kit's
 * `xdgPaths('dish').state`, the work root dish-kit's `workRoot()`), plus `writeFileAtomic` for its state and token files.
 *
 * A name joined into a path (an owner, a repository, a slug) must be one path segment: anything else throws, so no
 * name can lead a path out of its root.
 *
 * @module dish-workspaces/paths
 */

import { randomBytes } from 'node:crypto'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'

const CONTROL = /[\x00-\x1f\x7f]/

/** `value`, if it is one path segment that names something in its directory. */
function segment(what: string, value: string): string {
  if (value === '' || value === '.' || value === '..' || /[/\\]/.test(value) || CONTROL.test(value)) {
    throw new Error(`${what} must be one path segment, not ${JSON.stringify(value)}`)
  }
  return value
}

/** `<state>/workspaces/<owner>/<repo>` */
export function projectStateDir(state: string, owner: string, repo: string): string {
  return join(state, 'workspaces', segment('owner', owner), segment('repo', repo))
}

/** `<state>/workspaces/<owner>/<repo>/clone.json` */
export function cloneStateFile(state: string, owner: string, repo: string): string {
  return join(projectStateDir(state, owner, repo), 'clone.json')
}

/** `<state>/workspaces/<owner>/<repo>/setup.log` */
export function setupLogFile(state: string, owner: string, repo: string): string {
  return join(projectStateDir(state, owner, repo), 'setup.log')
}

/** `<state>/workspaces/<owner>/<repo>/worktrees/<slug>.json` */
export function worktreeRecordFile(state: string, owner: string, repo: string, slug: string): string {
  return join(projectStateDir(state, owner, repo), 'worktrees', `${segment('slug', slug)}.json`)
}

/** `<state>/workspaces/<owner>/<repo>/worktrees/<slug>.setup.log` */
export function worktreeSetupLogFile(state: string, owner: string, repo: string, slug: string): string {
  return join(projectStateDir(state, owner, repo), 'worktrees', `${segment('slug', slug)}.setup.log`)
}

/** `<state>/workspaces/tokens` */
export function tokensDir(state: string): string {
  return join(state, 'workspaces', 'tokens')
}

/** `<state>/workspaces/scratch` */
export function scratchRecordFile(state: string): string {
  return join(state, 'workspaces', 'scratch')
}

/** `<work root>/<owner>/<repo>` */
export function clonePath(workRoot: string, owner: string, repo: string): string {
  return join(workRoot, segment('owner', owner), segment('repo', repo))
}

/** `<clone>/.worktrees/<slug>` */
export function worktreePath(clone: string, slug: string): string {
  return join(clone, '.worktrees', segment('slug', slug))
}

/**
 * The value of a clone's `credential.<web>.helper`: `!/bin/sh '<helper>' '<tokens>' '<web>'`. git runs it through the
 * shell, so each part is single-quoted; a part with a `'` or a control character (a newline among them) throws, and so
 * does a relative helper or tokens path (git runs the helper from wherever it is).
 */
export function helperValue(helper: string, tokens: string, web: string): string {
  for (const [what, part] of [['the helper path', helper], ['the tokens directory', tokens], ['the web origin', web]] as const) {
    if (part.includes("'")) throw new Error(`${what} must not contain a ' (it is single-quoted for git's shell)`)
    if (CONTROL.test(part)) throw new Error(`${what} must not contain a control character`)
  }
  if (!isAbsolute(helper)) throw new Error('the helper path must be absolute')
  if (!isAbsolute(tokens)) throw new Error('the tokens directory must be absolute')
  return `!/bin/sh '${helper}' '${tokens}' '${web}'`
}

/**
 * Write `text` to `file` whole or not at all: a temporary file beside it (created new, never through a link), its mode
 * set to `mode` (default 0600, whatever the umask), synced, then renamed over `file`. A link at `file` is replaced, not
 * followed. Directories it has to make are made 0700; existing ones are left as they are. On failure the temporary file
 * is removed and `file` is untouched.
 */
export async function writeFileAtomic(file: string, text: string, mode = 0o600): Promise<void> {
  const dir = dirname(file)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const temp = join(dir, `.${basename(file)}.${randomBytes(6).toString('hex')}.tmp`)
  let handle: FileHandle | undefined
  try {
    handle = await open(temp, 'wx', mode)
    await handle.chmod(mode)
    await handle.writeFile(text, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temp, file)
  } catch (error) {
    await handle?.close().catch(() => {})
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
  // The rename, on disk. Best effort: not every file system lets a directory be opened and synced.
  try {
    const directory = await open(dir, 'r')
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  } catch {
    // The file is in place either way.
  }
}
