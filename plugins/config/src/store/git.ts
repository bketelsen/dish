import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { ConfigStoreError } from './errors.ts'

/** One file to write (`text`) or remove (`delete`), by repository-relative path. */
export type Change = { path: string, text: string } | { path: string, delete: true }

export interface GitIdentity {
  name: string
  email: string
}

export interface RunOptions {
  /** Written to the process's stdin. */
  input?: string
  /** Merged over the base environment. */
  env?: Record<string, string>
  /** Resolve with the exit code instead of throwing when git exits non-zero. */
  allowFail?: boolean
}

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

/**
 * Variables that make git look somewhere other than `--git-dir`, change what a
 * path or object id means, or stamp commits with someone else's time. A git
 * hook or a developer's shell can leave any of them set, and git would then
 * quietly write this store's objects, refs or index elsewhere. They are removed
 * from every child's environment.
 *
 * Auth and diagnostics (`GIT_SSH*`, `GIT_ASKPASS`, `GIT_TRACE*`, `GIT_EXEC_PATH`,
 * `GIT_CONFIG_GLOBAL`/`SYSTEM`/`NOSYSTEM`, `GIT_SSL_*`, `GIT_HTTP_*`,
 * `GIT_PROXY_COMMAND`) are deliberately not listed: pushing needs them.
 */
export const GIT_ENV_DENYLIST: readonly string[] = [
  'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_WORK_TREE', 'GIT_LITERAL_PATHSPECS',
  'GIT_ICASE_PATHSPECS', 'GIT_COMMON_DIR', 'GIT_QUARANTINE_PATH', 'GIT_AUTHOR_DATE', 'GIT_COMMITTER_DATE',
  'GIT_DEFAULT_HASH', 'GIT_DIR', 'GIT_INDEX_FILE', 'GIT_IMPLICIT_WORK_TREE', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT', 'GIT_GRAFT_FILE', 'GIT_NO_REPLACE_OBJECTS', 'GIT_REPLACE_REF_BASE', 'GIT_PREFIX',
  'GIT_SHALLOW_FILE', 'GIT_NAMESPACE', 'GIT_GLOB_PATHSPECS', 'GIT_NOGLOB_PATHSPECS', 'GIT_CEILING_DIRECTORIES',
]

/**
 * The environment for a git child process: `base` without `GIT_ENV_DENYLIST`,
 * then English messages and no credential prompts, then `extra` (so a caller
 * can still set a denied name on purpose, as `buildTree` does with
 * `GIT_INDEX_FILE`).
 * @param extra - per-call variables, applied last.
 * @param base - the inherited environment; defaults to this process's.
 */
export function gitEnv(extra: Record<string, string> = {}, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base }
  for (const name of GIT_ENV_DENYLIST) delete env[name]
  return { ...env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', ...extra }
}

const ZERO_OID = '0'.repeat(40)
// Large enough that a long `git log` never trips execFile's default 1 MiB cap.
const MAX_BUFFER = 256 * 1024 * 1024

/**
 * Run `git` with `args`: no shell, a scrubbed environment (see `gitEnv`),
 * English messages, and never a credential prompt. Resolves with the exit code
 * for any non-zero exit; rejects only when git can't be run at all (missing
 * binary, killed by a signal).
 */
function exec(args: string[], options: RunOptions): Promise<RunResult> {
  const env = gitEnv(options.env)
  return new Promise((resolvePromise, reject) => {
    const child = execFile('git', args, { env, encoding: 'utf8', maxBuffer: MAX_BUFFER }, (error, stdout, stderr) => {
      if (error === null) return resolvePromise({ code: 0, stdout, stderr })
      const code: unknown = (error as { code?: unknown }).code
      if (typeof code === 'number') return resolvePromise({ code, stdout, stderr })
      reject(error)
    })
    // git may exit without reading stdin; that is reported by its exit code.
    child.stdin?.on('error', () => {})
    child.stdin?.end(options.input)
  })
}

/** Why `path` can't be a config document path, or `undefined` if it can. */
export function pathProblem(path: string): string | undefined {
  if (path === '') return 'empty'
  // Control characters (newline, tab, NUL, DEL, ...) would let a path forge lines in commit messages and logs.
  if (/[\x00-\x1f\x7f]/.test(path)) return 'contains a control character'
  if (path.includes('\\')) return 'contains a backslash'
  if (path.startsWith('/')) return 'absolute'
  if (path.endsWith('/')) return 'ends with a slash'
  for (const segment of path.split('/')) {
    if (segment === '') return 'has an empty segment'
    if (segment === '.' || segment === '..') return `has a "${segment}" segment`
    if (segment.toLowerCase() === '.git') return 'has a ".git" segment'
  }
  return undefined
}

function checkPath(path: string): void {
  const problem = pathProblem(path)
  if (problem !== undefined) throw new ConfigStoreError('INVALID', `invalid path ${JSON.stringify(path)}: ${problem}`)
}

/** A path as git pathspec, with wildcards and `:(magic)` switched off. */
function literal(path: string): string {
  return `:(literal)${path}`
}

/**
 * A bare repository driven only through git plumbing. Every call is
 * `git --git-dir=<dir> ...` run without a shell.
 */
export class Git {
  readonly gitDir: string

  constructor(gitDir: string) {
    this.gitDir = resolve(gitDir)
  }

  /**
   * Run one git command in this repository.
   * @throws a plain `Error` carrying git's stderr when it exits non-zero and `allowFail` isn't set.
   */
  async run(args: string[], options: RunOptions = {}): Promise<RunResult> {
    const result = await exec([`--git-dir=${this.gitDir}`, ...args], options)
    if (result.code !== 0 && options.allowFail !== true) {
      throw new Error(`git ${args.join(' ')} failed (exit ${result.code}): ${result.stderr.trim()}`)
    }
    return result
  }

  /** Create the repository (bare, `HEAD` on `branch`). Safe to call on an existing one. */
  async initBare(branch: 'main'): Promise<void> {
    // SHA-1 explicitly: a user's init.defaultObjectFormat=sha256 would break the 40-zero compare-and-swap, and GitHub is SHA-1.
    const result = await exec(['init', '--bare', '--object-format=sha1', '-b', branch, this.gitDir], {})
    if (result.code !== 0) throw new Error(`git init failed (exit ${result.code}): ${result.stderr.trim()}`)
  }

  /** The empty tree's id, written to the object database. */
  async emptyTree(): Promise<string> {
    return (await this.run(['mktree'], { input: '' })).stdout.trim()
  }

  /** The commit `ref` points at, or `undefined` if it doesn't resolve (e.g. an unborn branch). */
  async resolve(ref: string): Promise<string | undefined> {
    if (ref.startsWith('-')) return undefined
    const result = await this.run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowFail: true })
    return result.code === 0 ? result.stdout.trim() : undefined
  }

  /**
   * The text of the file at `path` in `commit` (or any tree-ish), or
   * `undefined` if there's no file there.
   * @throws `NOT_FOUND` if `commit` doesn't exist.
   */
  async readBlob(commit: string, path: string): Promise<string | undefined> {
    await this.requireTree(commit)
    const result = await this.run(['cat-file', 'blob', `${commit}:${path}`], { allowFail: true })
    return result.code === 0 ? result.stdout : undefined
  }

  /**
   * Every file path under `prefix` in `commit`, in git's order. `prefix` is
   * matched by whole path components: `prompts/` or `prompts` is that
   * directory's subtree, `crew.yaml` that one file, `''` everything.
   * @throws `NOT_FOUND` if `commit` doesn't exist.
   */
  async listPaths(commit: string, prefix: string): Promise<string[]> {
    await this.requireTree(commit)
    const args = ['ls-tree', '-r', '--name-only', '-z', commit]
    if (prefix !== '') args.push('--', literal(prefix))
    return splitNul((await this.run(args)).stdout)
  }

  /**
   * Write a tree: `base` (a commit or tree, or nothing for an empty tree) with
   * `changes` applied in order. Uses a throwaway index at
   * `<gitDir>/dish-index-<random>`, which is deleted however this ends.
   * @throws `INVALID` for an unsafe path, or one that clashes with an existing
   *   file or directory; `NOT_FOUND` if `base` doesn't exist.
   */
  async buildTree(base: string | undefined, changes: Change[]): Promise<string> {
    for (const change of changes) checkPath(change.path)
    if (base !== undefined) await this.requireTree(base)
    const index = join(this.gitDir, `dish-index-${randomBytes(8).toString('hex')}`)
    const env = { GIT_INDEX_FILE: index }
    try {
      await this.run(base === undefined ? ['read-tree', '--empty'] : ['read-tree', base], { env })
      for (const change of changes) {
        if ('delete' in change) {
          // `--force-remove` insists on a work tree; mode 0 in --index-info drops the entry without one.
          await this.run(['update-index', '-z', '--index-info'], { env, input: `0 ${ZERO_OID}\t${change.path}\0` })
          continue
        }
        const blob = (await this.run(['hash-object', '-w', '--no-filters', '--stdin'], { input: change.text })).stdout.trim()
        // protectHFS/protectNTFS: refuse the spellings of ".git" that macOS and Windows treat as the same
        // directory. GitHub refuses a push containing one, which would wedge the push queue for good.
        const staged = await this.run(
          ['-c', 'core.protectHFS=true', '-c', 'core.protectNTFS=true',
            'update-index', '--add', '--cacheinfo', `100644,${blob},${change.path}`],
          { env, allowFail: true })
        if (staged.code !== 0) {
          throw new ConfigStoreError('INVALID', `cannot write ${JSON.stringify(change.path)}: ${staged.stderr.trim()}`)
        }
      }
      return (await this.run(['write-tree'], { env })).stdout.trim()
    } finally {
      await rm(index, { force: true })
    }
  }

  /**
   * Create a commit object (this moves no ref). Never signed, whatever
   * `commit.gpgsign` says, so a user's global config can't stall it on a prompt.
   * @throws `NOT_FOUND` if `tree` or a parent doesn't exist.
   */
  async commitTree(tree: string, parents: string[], message: string, author: GitIdentity): Promise<string> {
    await this.requireTree(tree)
    for (const parent of parents) await this.requireCommit(parent)
    const args = ['commit-tree', '--no-gpg-sign']
    for (const parent of parents) args.push('-p', parent)
    args.push(tree)
    const env = {
      GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email,
      GIT_COMMITTER_NAME: author.name, GIT_COMMITTER_EMAIL: author.email,
    }
    return (await this.run(args, { input: message, env })).stdout.trim()
  }

  /**
   * Move `ref` to `next` only if it currently holds `expected` (`null`: only
   * if it doesn't exist). `false` means the ref wasn't what was expected.
   * @param expected - a full object id, or `null`.
   * @throws if `ref` doesn't start with `refs/`, or the update fails for any other
   *   reason (bad ref name, missing object).
   */
  async casRef(ref: string, next: string, expected: string | null): Promise<boolean> {
    // A short name like `main` would be written as `<gitDir>/main` and shadow `refs/heads/main` in lookups.
    if (!ref.startsWith('refs/')) throw new Error(`casRef needs a full ref name starting with "refs/", got ${JSON.stringify(ref)}`)
    const result = await this.run(['update-ref', '--no-deref', '--', ref, next, expected ?? ZERO_OID], { allowFail: true })
    if (result.code === 0) return true
    // A lost race and a broken request both exit non-zero; only the first is `false`.
    if ((await this.currentValue(ref)) !== (expected ?? undefined)) return false
    throw new Error(`git update-ref ${ref} failed (exit ${result.code}): ${result.stderr.trim()}`)
  }

  /**
   * The paths whose content differs between two commits or trees (`from` may be
   * `emptyTree()`), in git's order. With `paths`, only those files or subtrees
   * count: `undefined` means everywhere, an empty list means nowhere.
   * @throws `NOT_FOUND` if either side doesn't exist.
   */
  async changedPaths(from: string, to: string, paths?: string[]): Promise<string[]> {
    await this.requireTree(from)
    await this.requireTree(to)
    if (paths?.length === 0) return []
    const args = ['diff-tree', '-r', '--name-only', '--no-renames', '--no-commit-id', '-z', from, to]
    if (paths !== undefined) args.push('--', ...paths.map(literal))
    return splitNul((await this.run(args)).stdout)
  }

  private async currentValue(ref: string): Promise<string | undefined> {
    if (ref.startsWith('-')) return undefined
    const result = await this.run(['rev-parse', '--verify', '--quiet', ref], { allowFail: true })
    return result.code === 0 ? result.stdout.trim() : undefined
  }

  private requireTree(object: string): Promise<void> {
    return this.require(object, 'tree')
  }

  private requireCommit(object: string): Promise<void> {
    return this.require(object, 'commit')
  }

  private async require(object: string, type: 'tree' | 'commit'): Promise<void> {
    // A leading dash would be read as an option by every command below.
    const found = !object.startsWith('-')
      && (await this.run(['cat-file', '-e', `${object}^{${type}}`], { allowFail: true })).code === 0
    if (!found) throw new ConfigStoreError('NOT_FOUND', `no such ${type}: ${object}`)
  }
}

function splitNul(output: string): string[] {
  return output.split('\0').filter(entry => entry !== '')
}
