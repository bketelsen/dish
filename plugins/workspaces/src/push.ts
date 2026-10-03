/**
 * dish's one push (step 7): `dish/<slug>` of a worktree dish made, to the project's HTTPS URL, from an isolated bare
 * repository of dish's own, with a write token that reaches git only on an inherited fd 3.
 *
 * - **Why an isolated repository.** Agents can write the clone's `.git/config` between dish's check of it and the
 *   push, and its config could steer a push run there: `url.*.insteadOf`, `remote.*`, `http.*`, `credential.*`,
 *   `push.*`, the hooks. So the push runs from a bare repository dish makes under `<state>` (which agents can't write),
 *   whose objects come from the clone through `objects/info/alternates`, with no system or global config
 *   (`PUSH_ENV`): only that repository's own config, which dish wrote, and the `-c` flags.
 * - **Why fd 3.** A token in the environment (an env-reading helper, `GIT_ASKPASS`, `http.extraHeader` through
 *   `GIT_CONFIG_COUNT`) can be read by any process of the same user through `/proc/<pid>/environ`, for the whole push,
 *   and dsh's agents run as that user. fd 3 is a socket, which another process can't open through `/proc/<pid>/fd/3`;
 *   its one line is gone once `bin/git-credential-dish-push` has read it, so a thief that reads it first leaves the push
 *   without it, and that shows. The token is never on disk, in an argument, in the environment or in a log.
 * - **What it pushes.** One explicit refspec, `refs/heads/dish/<slug>:refs/heads/dish/<slug>`, to the URL given (never
 *   the clone's remote), never forced: no force flag, no forced refspec, no deletion, no mirror, no other refs, no tags.
 *   A branch that moved on GitHub is refused ("fetch first"), and the answer says to merge, never to force.
 * - **Clean-up.** The isolated repository is removed after success, failure or abort. A crash leaves it (a small bare
 *   repository with no token in it) for the user to remove.
 *
 * Nothing here takes a lock: `pushBranch` runs it under the project's.
 *
 * @module dish-workspaces/push
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SHA, git, gitOk, shown } from './git.ts'
import type { GitResult } from './git.ts'
import { pushHelperValue } from './paths.ts'

/** How long the push may take before its process group is killed. */
export const PUSH_TIMEOUT_MS = 600_000

/** Every git the push runs reads no system or global config: only the isolated repository's, and the -c flags. */
export const PUSH_ENV: Readonly<Record<string, string>> = Object.freeze({ GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' })

/** The only branches dish pushes: `dish/<slug>`. */
const PUSHED_BRANCH = /^dish\/[a-z0-9][a-z0-9-]{0,39}$/
/** The most characters of a push's failure. */
const MAX_FAILURE_CHARS = 600
/** The most `remote:` lines a failure carries. */
const MAX_REMOTE_LINES = 5

export interface PushRequest {
  /** The clone, canonical, from resolve. */
  clone: string
  /** `dish/<slug>` */
  branch: string
  /** The commit to push: `refs/heads/dish/<slug>` in the clone, as read under the lock. */
  tip: string
  /** `httpsUrl(web, owner, repo)` */
  url: string
  /** The web origin the helper answers for. */
  web: string
  /** `bin/git-credential-dish-push`, absolute. */
  helper: string
  /** `projectStateDir(state, owner, repo)`: where the isolated repository is made. */
  parent: string
  token: string
  signal?: AbortSignal
}

/** What pushIsolated did. pushBranch logs it, and gives its caller only `head`. */
export interface PushedBranch {
  branch: string
  head: string
  url: string
  result: 'created' | 'updated' | 'up-to-date'
}

/**
 * git's arguments for the push from `gitDir`:
 * ['--git-dir', gitDir, '-c', 'credential.helper=', '-c', `credential.helper=${helperValue}`, '-c', 'http.followRedirects=false',
 *  'push', '--porcelain', url, `refs/heads/${branch}:refs/heads/${branch}`]
 * The empty helper first drops any helper from any config (git's documented reset), so only dish's push helper is
 * asked; no redirect is followed, so a second host never asks for the credential. Throws unless `branch` is `dish/<slug>`.
 */
export function pushArgs(gitDir: string, url: string, branch: string, helperValue: string): string[] {
  if (typeof branch !== 'string' || !PUSHED_BRANCH.test(branch)) {
    throw new Error(`dish pushes only a dish/<slug> branch, not ${JSON.stringify(shown(String(branch), 80))}`)
  }
  return [
    '--git-dir', gitDir,
    '-c', 'credential.helper=', '-c', `credential.helper=${helperValue}`, '-c', 'http.followRedirects=false',
    'push', '--porcelain', url, `refs/heads/${branch}:refs/heads/${branch}`,
  ]
}

/** dish's answer to a push GitHub refused because its branch has commits this one lacks (correction 15). */
function mergeHint(branch: string): string {
  return `The branch on GitHub has commits this one doesn't: have a coder merge \`origin/${branch}\` into the run's worktree, then call \`open_pr\` again. dish never forces a push.`
}

/** The `!` line's summary in git push --porcelain's output (`[rejected] (fetch first)`), if there is one. */
function rejectedSummary(stdout: string): string | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith('!\t')) continue
    const fields = line.split('\t')
    return (fields[2] ?? '').trim()
  }
  return undefined
}

/**
 * The push's failure as a message: "GitHub refused the push of <branch>: " and its parts joined by " — ": the `!`
 * line's summary, when there is one; the first 5 `remote:` lines of stderr (prefix stripped, trimmed, non-empty), joined
 * by a space; and, only without a `!` line, stderr's last `fatal:` or `error:` line. A summary with `fetch first` or
 * `non-fast-forward` adds dish's merge hint. Masked (`maskSecrets`, URL passwords), no control characters, cut to 600
 * characters with the hint kept whole.
 */
export function pushFailure(result: GitResult, branch: string): string {
  const summary = rejectedSummary(result.stdout)
  const lines = result.stderr.split(/\r?\n/)
  const remote = lines
    .filter(line => line.startsWith('remote:'))
    .map(line => line.slice('remote:'.length).trim())
    .filter(line => line !== '')
    .slice(0, MAX_REMOTE_LINES)
  const parts: string[] = []
  if (summary !== undefined && summary !== '') parts.push(summary)
  if (remote.length > 0) parts.push(remote.join(' '))
  if (summary === undefined) {
    const last = [...lines].reverse().map(line => line.trim()).find(line => /^(?:fatal|error):/.test(line))
    if (last !== undefined) parts.push(last)
  }
  if (parts.length === 0) parts.push(`git push exited ${result.code}`)
  const message = `GitHub refused the push of ${branch}: ${parts.join(' — ')}`
  if (summary === undefined || !/fetch first|non-fast-forward/.test(summary)) return shown(message, MAX_FAILURE_CHARS)
  const hint = mergeHint(branch)
  const head = shown(message, MAX_FAILURE_CHARS - hint.length - 2)
  return `${head.endsWith('.') ? head : `${head}.`} ${hint}`
}

/** An Error named `AbortError`, as the service's callers read one. */
function aborted(branch: string): Error {
  const error = new Error(`the push of ${branch} was aborted`)
  error.name = 'AbortError'
  return error
}

/** What the porcelain line for `branch` says was done, or undefined when there is no such line, or its flag is another. */
function outcome(stdout: string, branch: string): PushedBranch['result'] | undefined {
  const ref = `refs/heads/${branch}`
  for (const line of stdout.split(/\r?\n/)) {
    const fields = line.split('\t')
    if (fields.length < 3 || fields[1] !== `${ref}:${ref}`) continue
    if (fields[0] === '*') return 'created'
    if (fields[0] === ' ') return 'updated'
    if (fields[0] === '=') return 'up-to-date'
    return undefined
  }
  return undefined
}

/**
 * Push `request.branch` at `request.tip` from an isolated bare repository under `request.parent`, whose objects come
 * from the clone's through alternates, to `request.url`, with the token on git's fd 3 for the push helper. The
 * repository is removed afterwards, whatever happened. Rejects with GitHub's reason (`pushFailure`), an `AbortError`, or
 * a timeout.
 */
export async function pushIsolated(request: PushRequest): Promise<PushedBranch> {
  const { clone, branch, tip, url, web, helper, parent, token, signal } = request
  // Everything checked before anything is made.
  const args = (gitDir: string): string[] => pushArgs(gitDir, url, branch, pushHelperValue(helper, web))
  args('/')
  if (typeof tip !== 'string' || !SHA.test(tip)) throw new Error(`the push of ${branch} needs the full commit id of its tip`)
  if (signal?.aborted) throw aborted(branch)

  await mkdir(parent, { recursive: true, mode: 0o700 })
  const dir = await mkdtemp(join(parent, 'push-'))
  try {
    const options = { cwd: '/', env: { ...PUSH_ENV }, signal }
    const setup = async (setupArgs: readonly string[]): Promise<void> => {
      try {
        await gitOk(setupArgs, options)
      } catch (error) {
        if (signal?.aborted) throw aborted(branch)
        throw error
      }
    }
    await setup(['init', '--bare', '--quiet', '--template=', `--object-format=${tip.length === 64 ? 'sha256' : 'sha1'}`, dir])
    await writeFile(join(dir, 'objects', 'info', 'alternates'), `${clone}/.git/objects\n`, { flag: 'wx', mode: 0o600 })
    // This needs the object, which it finds through the alternates.
    await setup(['--git-dir', dir, 'update-ref', `refs/heads/${branch}`, tip])

    const result = await git(args(dir), { ...options, secret: token, timeoutMs: PUSH_TIMEOUT_MS })
    if (result.aborted) throw aborted(branch)
    if (result.timedOut) throw new Error(`the push of ${branch} timed out after ${PUSH_TIMEOUT_MS / 60_000} min`)
    if (result.code !== 0) throw new Error(pushFailure(result, branch))
    const done = outcome(result.stdout, branch)
    if (done === undefined) throw new Error(pushFailure(result, branch))
    return { branch, head: tip, url, result: done }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
