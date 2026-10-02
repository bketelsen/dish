/**
 * A project's clone for the worktree and sweep tests: a bare repository standing in for GitHub (`file://`, worktrees
 * need no credentials), cloned by a scratch git to `<work root>/<owner>/<repo>`, with stub `fetch`, `bindings` and
 * `pulls` for `WorktreeDeps`.
 *
 * Every git a test starts gets `scratchGitEnv` (helpers.ts); the code under test runs inside `call`, which gives it
 * the same scratch home through `process.env`, and the test files set the modules' `internals.gitEnv` to `NOSYSTEM`.
 *
 * @module dish-workspaces/test/worktree-helpers
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Project } from 'dish-projects/registry'
import type { PullSummary } from '../src/github.ts'
import { Worktrees } from '../src/worktrees.ts'
import type { Binding, WorktreeDeps } from '../src/worktrees.ts'
import { dishHome, makeBare, runOk, scratchGitEnv, tempDir, withEnv } from './helpers.ts'

/** A project as dish-projects' parser gives it. */
export function projectOf(owner = 'acme', repo = 'widget', setup?: string): Project {
  return {
    name: `${owner}/${repo}`, owner, repo, family: 'test', role: 'a test project',
    gate: 'true', gateTimeout: '1m', gateTimeoutMs: 60_000,
    setup, setupTimeout: '15m', setupTimeoutMs: 900_000, gateEnv: {},
  }
}

export interface WorktreeFixture {
  dir: string
  workRoot: string
  state: string
  /** GitHub: the bare repository. */
  bare: string
  /** Its `file://` URL: the clone's origin. */
  url: string
  /** The clone, as `clonePath` gives it (`workRoot` is canonical, so this is too). */
  clone: string
  /** `scratchGitEnv` for gits the test starts. */
  env: Record<string, string>
  project: Project
  /** What the `bindings` stub answers, by path. */
  bindings: Map<string, Binding[]>
  /** Every path the `bindings` stub was asked about. */
  bindingCalls: string[]
  /** What the `pulls` stub answers, by sha. */
  pulls: Map<string, PullSummary[]>
  /** Every sha the `pulls` stub was asked about. */
  pullCalls: string[]
  /** How many times the `fetch` stub ran. */
  fetches: number
  /** The injected clock. */
  clock: { now: number }
  deps(overrides?: Partial<WorktreeDeps>): WorktreeDeps
  worktrees(overrides?: Partial<WorktreeDeps>): Worktrees
  /** Run the code under test with the scratch home in `process.env`. */
  call<T>(body: () => Promise<T>): Promise<T>
  /** A scratch git, in `cwd` (default the clone). Returns stdout, trimmed. */
  git(args: readonly string[], cwd?: string): Promise<string>
  /** Write `file` in `path` (a worktree), add and commit it. Returns the new commit. */
  commit(path: string, file: string, text: string): Promise<string>
  /** A commit on GitHub's main that isn't in the clone yet (from a scratch clone of the bare). Returns its sha. */
  pushMain(file: string, text: string): Promise<string>
}

export async function worktreeFixture(options: { owner?: string, repo?: string, setup?: string, files?: Record<string, string> } = {}): Promise<WorktreeFixture> {
  const owner = options.owner ?? 'acme'
  const repo = options.repo ?? 'widget'
  const dir = await tempDir()
  const bare = await makeBare(join(dir, 'remote', owner, `${repo}.git`), options.files ?? { 'README.md': '# widget\n', 'src/a.ts': 'export {}\n' })
  const env = await scratchGitEnv(dir)
  const workRoot = join(dir, 'work')
  const clone = join(workRoot, owner, repo)
  await mkdir(dirname(clone), { recursive: true })
  const url = `file://${bare}`
  await runOk('git', ['clone', '-q', url, clone], { env })
  const fixture: WorktreeFixture = {
    dir, workRoot, state: join(dir, 'state'), bare, url, clone, env,
    project: projectOf(owner, repo, options.setup),
    bindings: new Map(),
    bindingCalls: [],
    pulls: new Map(),
    pullCalls: [],
    fetches: 0,
    clock: { now: 1_790_000_000_000 },
    deps(overrides = {}) {
      return {
        workRoot: fixture.workRoot,
        state: fixture.state,
        cloneExpectations: () => ({ url: fixture.url }),
        fetch: async () => {
          fixture.fetches++
          await runOk('git', ['-C', fixture.clone, 'fetch', '-q', '--prune', 'origin', '+refs/heads/*:refs/remotes/origin/*'], { env })
        },
        defaultBranch: async () => 'main',
        bindings: async path => {
          fixture.bindingCalls.push(path)
          return fixture.bindings.get(path) ?? []
        },
        pulls: async (_project, sha) => {
          fixture.pullCalls.push(sha)
          return fixture.pulls.get(sha) ?? []
        },
        now: () => fixture.clock.now,
        ...overrides,
      }
    },
    worktrees(overrides) {
      return new Worktrees(fixture.deps(overrides))
    },
    async call(body) {
      return withEnv(await dishHome(dir), body)
    },
    async git(args, cwd = clone) {
      return (await runOk('git', ['-C', cwd, ...args], { env })).trim()
    },
    async commit(path, file, text) {
      await mkdir(dirname(join(path, file)), { recursive: true })
      await writeFile(join(path, file), text)
      await fixture.git(['add', '--', file], path)
      await fixture.git(['commit', '-q', '-m', `change ${file}`], path)
      return fixture.git(['rev-parse', 'HEAD'], path)
    },
    async pushMain(file, text) {
      const work = join(await tempDir(), 'work')
      await runOk('git', ['clone', '-q', url, work], { env })
      const sha = await fixture.commit(work, file, text)
      await fixture.git(['push', '-q', 'origin', 'main'], work)
      return sha
    },
  }
  return fixture
}

/** A merged pull request whose head is `sha`. */
export function mergedPull(number: number, sha: string, headRef = 'dish/x'): PullSummary {
  return { number, state: 'closed', mergedAt: '2026-10-02T12:00:00Z', headSha: sha, headRef }
}

/** An open pull request whose head is `sha`. */
export function openPull(number: number, sha: string, headRef = 'dish/x'): PullSummary {
  return { number, state: 'open', mergedAt: null, headSha: sha, headRef }
}
