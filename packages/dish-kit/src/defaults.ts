/**
 * Earlier shipped defaults. A plugin that seeds the config store from a `defaults/` directory keeps
 * `defaults/previous.json` beside it: for each store path, the sha256 of every text that file has had in git
 * history. `dishConfig.seed` replaces a stored document whose hash is listed, so an unedited default moves to
 * the new text and an edited one stays. `previous-defaults.mjs` writes that file with `computePrevious`.
 *
 * This module is imported by everything that imports `dish-kit`, so it takes `node:` builtins only.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdir, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'

const PREVIOUS_FILE = 'previous.json'
const HASH = /^[0-9a-f]{64}$/

/** `a` before `b` by code unit, so the order is the same on every machine. */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

/** The error `computePrevious` throws when git has no usable history here. A drift test can skip on its `code`. */
function noHistory(message: string): Error {
  return Object.assign(new Error(message), { code: 'NO_HISTORY' })
}

type GitResult = { ok: true, stdout: Buffer } | { ok: false, code: unknown, stderr: string }

/** Run `git -C cwd <args>` and report how it ended. Pathspecs are literal: a file name is never a glob. */
function git(cwd: string, args: readonly string[]): Promise<GitResult> {
  return new Promise(resolve => {
    execFile('git', ['--literal-pathspecs', '-C', cwd, ...args], { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) resolve({ ok: false, code: (error as { code?: unknown }).code, stderr: stderr.toString('utf8').trim() || error.message })
      else resolve({ ok: true, stdout })
    })
  })
}

function failure(what: string, result: Extract<GitResult, { ok: false }>): Error {
  return new Error(`git ${what} failed: ${result.stderr}`)
}

/**
 * Map a defaults directory's files to store paths: `<prefix><relative path>`, with `/` separators. Sorted by
 * path. `previous.json` at the top of the directory is skipped, and so is anything in `exclude`, which
 * matches a file's base name or its path relative to `directory`. `file` is the absolute path.
 */
export async function defaultFiles(
  directory: string,
  prefix: string,
  exclude: readonly string[] = [],
): Promise<{ file: string, path: string }[]> {
  const root = path.resolve(directory)
  const found: { file: string, path: string }[] = []
  async function walk(dir: string, relative: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), name)
      else if (name !== PREVIOUS_FILE && !exclude.includes(entry.name) && !exclude.includes(name)) {
        found.push({ file: path.join(dir, entry.name), path: `${prefix}${name}` })
      }
    }
  }
  await walk(root, '')
  return found.sort((a, b) => byCodeUnit(a.path, b.path))
}

/** The top of the git work tree holding `directory`, or `NO_HISTORY` when there is none or it is a shallow clone. */
async function repositoryTop(directory: string): Promise<string> {
  const top = await git(directory, ['rev-parse', '--show-toplevel'])
  if (!top.ok) throw noHistory(`no git history for ${directory}: ${top.stderr}`)
  const shallow = await git(directory, ['rev-parse', '--is-shallow-repository'])
  if (shallow.ok && shallow.stdout.toString('utf8').trim() === 'true') {
    throw noHistory(`${directory} is in a shallow clone, which has no history to read`)
  }
  return top.stdout.toString('utf8').replace(/\n$/, '')
}

/** The hashes of every committed version of `relative` (a path in the repository at `top`), each once. */
async function committedHashes(top: string, relative: string): Promise<Set<string>> {
  const log = await git(top, ['log', '--full-history', '--format=%H', '--', relative])
  if (!log.ok) throw failure(`log ${relative}`, log)
  const hashes = new Set<string>()
  const seen = new Set<string>()
  for (const commit of log.stdout.toString('utf8').split('\n').filter(Boolean)) {
    // `ls-tree` prints nothing for a path the commit lacks (it deleted the file), and a tree or submodule for a
    // path that is not a file.
    const entry = await git(top, ['ls-tree', '-z', commit, '--', relative])
    if (!entry.ok) throw failure(`ls-tree ${commit} ${relative}`, entry)
    // The record is `<mode> <type> <id>\t<name>`; a name may hold a tab itself.
    const record = entry.stdout.toString('utf8').split('\0')[0] ?? ''
    const tab = record.indexOf('\t')
    const [, type, id] = record.slice(0, tab).split(' ')
    if (tab < 0 || type !== 'blob' || id === undefined || record.slice(tab + 1) !== relative) continue
    if (seen.has(id)) continue
    seen.add(id)
    const content = await git(top, ['cat-file', 'blob', id])
    if (!content.ok) throw failure(`cat-file ${id}`, content)
    hashes.add(sha256(content.stdout))
  }
  return hashes
}

/**
 * For each store path: the sha256 (lowercase hex) of every committed version of its file in the git
 * repository holding `directory`, except the text in the working tree now. Hashes are sorted and
 * deduplicated, keys are sorted, and a path with no earlier version is left out.
 *
 * Throws an error with `code` `NO_HISTORY` when `directory` is not in a git repository or is in a shallow
 * clone, so a test that compares against `previous.json` can skip. A repository without a commit has no
 * earlier versions, so it gives `{}`.
 */
export async function computePrevious(
  directory: string,
  prefix: string,
  exclude: readonly string[] = [],
): Promise<Record<string, string[]>> {
  const files = await defaultFiles(directory, prefix, exclude)
  // git reports real paths, so the file paths handed to it come from the real directory too.
  const base = path.resolve(directory)
  const real = await realpath(base)
  const top = await repositoryTop(real)
  const head = await git(top, ['rev-parse', '--verify', '--quiet', 'HEAD'])
  if (!head.ok) {
    if (head.code === 1) return {}
    throw failure('rev-parse HEAD', head)
  }
  const previous: [string, string[]][] = []
  for (const { file, path: storePath } of files) {
    const relative = path.relative(top, path.join(real, path.relative(base, file))).split(path.sep).join('/')
    const hashes = await committedHashes(top, relative)
    hashes.delete(sha256(await readFile(file)))
    if (hashes.size > 0) previous.push([storePath, [...hashes].sort(byCodeUnit)])
  }
  // `files` is sorted by path, so `previous` is too.
  return Object.fromEntries(previous)
}

/**
 * Parse the text of a `previous.json`. It must be an object whose values are arrays of lowercase hex sha256
 * strings (64 characters each); anything else throws, with `file` named in the message. Synchronous, for a
 * plugin that loads its `previous.json` when its module loads.
 */
export function parsePrevious(text: string, file: string): Record<string, string[]> {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${(error as Error).message}`)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${file} must be an object mapping each store path to an array of hashes`)
  }
  const entries: [string, string[]][] = []
  for (const [storePath, hashes] of Object.entries(value)) {
    if (!Array.isArray(hashes) || !hashes.every(hash => typeof hash === 'string' && HASH.test(hash))) {
      throw new Error(`${file}: ${JSON.stringify(storePath)} must be an array of 64-character lowercase hex sha256 strings`)
    }
    entries.push([storePath, [...hashes]])
  }
  // `fromEntries` defines own properties, so a key of `__proto__` stays an entry.
  return Object.fromEntries(entries)
}

/** Read `<directory>/previous.json` with `parsePrevious`, or `{}` when there is none. */
export async function readPrevious(directory: string): Promise<Record<string, string[]>> {
  const file = path.join(directory, PREVIOUS_FILE)
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') return {}
    throw error
  }
  return parsePrevious(text, file)
}
