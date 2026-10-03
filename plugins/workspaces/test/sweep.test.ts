import { test } from 'node:test'
import assert from 'node:assert/strict'
import { access, chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { GitHubApp } from '../src/github.ts'
import { checkedBranch, githubWord, internals as sweepInternals, isMerged, sweepProject } from '../src/sweep.ts'
import type { SweepResult } from '../src/sweep.ts'
import { internals } from '../src/worktrees.ts'
import type { CreatedWorktree, WorktreeRecord } from '../src/worktrees.ts'
import { startFakeGitHub, testKeys } from './fake-github-api.ts'
import { NOSYSTEM, run } from './helpers.ts'
import { mergedPull, openPull, worktreeFixture } from './worktree-helpers.ts'
import type { WorktreeFixture } from './worktree-helpers.ts'

internals.gitEnv = NOSYSTEM
sweepInternals.gitEnv = NOSYSTEM

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function hasBranch(f: WorktreeFixture, branch: string): Promise<boolean> {
  const result = await run('git', ['-C', f.clone, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { env: f.env })
  return result.code === 0
}

async function create(f: WorktreeFixture, slug: string, base?: string): Promise<CreatedWorktree> {
  return f.call(() => f.worktrees().create(f.project, slug, base, { cwd: f.clone }))
}

function recordOf(made: CreatedWorktree): WorktreeRecord {
  return { project: made.project, slug: made.slug, branch: made.branch, base: made.base, baseRef: 'origin/main', createdAt: 1 }
}

// --- isMerged -------------------------------------------------------------------------------------------------------

test('isMerged: a squash-merged pull request whose head is the tip is merged by pull request, though the tip is no ancestor', async () => {
  const f = await worktreeFixture()
  const made = await create(f, 'x')
  const tip = await f.commit(made.path, 'x.txt', 'x\n')
  // The squash: a new commit on main (its own message, so not the same object as the tip, whatever the clock says).
  await f.pushMain('x.txt', 'x, squashed\n')
  await f.git(['fetch', '-q', 'origin'])
  const ancestor = await run('git', ['-C', f.clone, 'merge-base', '--is-ancestor', tip, 'origin/main'], { env: f.env })
  assert.equal(ancestor.code, 1, 'the fixture: no ancestry')
  assert.deepEqual(await f.call(() => isMerged(f.clone, recordOf(made), tip, githubWord(f.clone), [openPull(3, 'f'.repeat(40)), mergedPull(4, tip)])),
    { merged: true, by: 'pull-request', pull: 4 })
})

test('isMerged: a pull request merged at another head (commits after the merge) is not', async () => {
  const f = await worktreeFixture()
  const made = await create(f, 'x')
  const merged = await f.commit(made.path, 'x.txt', 'x\n')
  const tip = await f.commit(made.path, 'y.txt', 'after the merge\n')
  const check = await f.call(() => isMerged(f.clone, recordOf(made), tip, githubWord(f.clone), [mergedPull(4, merged)]))
  assert.equal(check.merged, false)
})

test('isMerged: an ancestry merge with commits of its own is merged', async () => {
  const f = await worktreeFixture()
  const made = await create(f, 'x')
  const tip = await f.commit(made.path, 'x.txt', 'x\n')
  await f.git(['push', '-q', 'origin', `${tip}:refs/heads/main`])
  await f.git(['fetch', '-q', 'origin'])
  assert.deepEqual(await f.call(() => isMerged(f.clone, recordOf(made), tip, githubWord(f.clone), [])), { merged: true, by: 'ancestry' })
})

test("isMerged: a new worktree (its tip is its base, on origin/main) is not merged, even with a merged pull request at that commit", async () => {
  const f = await worktreeFixture()
  const made = await create(f, 'x')
  const check = await f.call(() => isMerged(f.clone, recordOf(made), made.base, githubWord(f.clone), [mergedPull(1, made.base)]))
  assert.equal(check.merged, false)
  const ancestor = await run('git', ['-C', f.clone, 'merge-base', '--is-ancestor', made.base, 'origin/main'], { env: f.env })
  assert.equal(ancestor.code, 0, 'the fixture: it is an ancestor')
})

test('isMerged: an open pull request at the tip is not merged', async () => {
  const f = await worktreeFixture()
  const made = await create(f, 'x')
  const tip = await f.commit(made.path, 'x.txt', 'x\n')
  assert.equal((await f.call(() => isMerged(f.clone, recordOf(made), tip, githubWord(f.clone), [openPull(5, tip)]))).merged, false)
})

test("isMerged: a planted replace ref doesn't make a tip an ancestor (and does fool plain git)", async () => {
  const f = await worktreeFixture()
  const made = await create(f, 'x')
  const tip = await f.commit(made.path, 'x.txt', 'x\n')
  const main = await f.git(['rev-parse', 'origin/main'])
  // A replacement for GitHub's main whose parent is the tip: plain git would call the tip an ancestor.
  await f.git(['replace', '--graft', main, tip])
  const plain = await run('git', ['-C', f.clone, 'merge-base', '--is-ancestor', tip, 'origin/main'], { env: f.env })
  assert.equal(plain.code, 0, 'the fixture fools plain git')
  assert.equal((await f.call(() => isMerged(f.clone, recordOf(made), tip, githubWord(f.clone), []))).merged, false)
})

/**
 * Rewrite `.git/objects/info/commit-graph` so that `commit`'s first parent is `parent`: what an agent can write by hand.
 * (Format: a header, a chunk table, then the OID fanout, the sorted OIDs, and per commit its tree, two parent positions
 * and its generation; `GDA2` holds each commit's corrected-date offset.) `commit`'s generation is raised above
 * `parent`'s, so git's walk doesn't stop before it.
 */
async function forgeCommitGraph(file: string, commit: string, parent: string): Promise<void> {
  const graph = await readFile(file)
  assert.equal(graph.toString('latin1', 0, 4), 'CGPH')
  const hash = graph[5] === 1 ? 20 : 32
  const chunks: Record<string, number> = {}
  for (let index = 0; index <= graph[6]!; index++) {
    const at = 8 + index * 12
    chunks[graph.toString('latin1', at, at + 4)] = Number(graph.readBigUInt64BE(at + 4))
  }
  const count = graph.readUInt32BE(chunks.OIDF! + 255 * 4)
  const oids: string[] = []
  for (let index = 0; index < count; index++) oids.push(graph.toString('hex', chunks.OIDL! + index * hash, chunks.OIDL! + (index + 1) * hash))
  const child = oids.indexOf(commit)
  const forged = oids.indexOf(parent)
  assert.ok(child >= 0 && forged >= 0, 'both commits are in the graph')
  const data = chunks.CDAT! + child * (hash + 16)
  graph.writeUInt32BE(forged, data + hash)
  // Topological level 3 (the top 30 bits), the commit time's top bits kept.
  graph.writeUInt32BE(((3 << 2) | (graph.readUInt32BE(data + hash + 8) & 3)) >>> 0, data + hash + 8)
  if (chunks.GDA2 !== undefined) graph.writeUInt32BE(1_000_000, chunks.GDA2 + child * 4)
  await chmod(file, 0o644)
  await writeFile(file, graph)
}

test("isMerged: a forged commit-graph doesn't make a tip an ancestor (and does fool plain git)", async () => {
  const f = await worktreeFixture()
  const made = await create(f, 'x')
  const next = await f.pushMain('b.txt', 'b\n')
  await f.git(['fetch', '-q', 'origin'])
  // An agent's commit of its own tree, on the worktree's branch.
  const tree = (await run('git', ['-C', f.clone, 'mktree'], { env: f.env, input: '' })).stdout.trim()
  const evil = await f.git(['commit-tree', tree, '-m', 'orphan'])
  await f.git(['update-ref', 'refs/heads/dish/x', evil])
  await f.git(['commit-graph', 'write', '--reachable'])
  // GitHub's main's parent (the worktree's base) now has the agent's commit as its parent, in the graph only.
  await forgeCommitGraph(join(f.clone, '.git', 'objects', 'info', 'commit-graph'), made.base, evil)
  const plain = await run('git', ['-C', f.clone, 'merge-base', '--is-ancestor', evil, next], { env: f.env })
  assert.equal(plain.code, 0, 'the fixture is real: the graph makes it an ancestor')
  const check = await f.call(() => isMerged(f.clone, recordOf(made), evil, githubWord(f.clone), []))
  assert.equal(check.merged, false)
  assert.match(check.reason ?? '', /isn't on GitHub's main/)
})

test("isMerged: a tip or a target that isn't a commit id is refused; checkedBranch refuses what isn't a plain branch name", async () => {
  const f = await worktreeFixture()
  const made = await create(f, 'x')
  await assert.rejects(f.call(() => isMerged(f.clone, recordOf(made), '--all', githubWord(f.clone), [])))
  await assert.rejects(f.call(() => isMerged(f.clone, recordOf(made), 'a'.repeat(40), { branch: 'main', sha: '--all' }, [])))
  assert.equal(checkedBranch('main'), 'main')
  assert.equal(checkedBranch('release/2.x'), 'release/2.x')
  for (const name of ['-x', 'a..b', '', 'a b', 'x/', '/x', 'a//b']) assert.throws(() => checkedBranch(name), /plain branch name/, name)
})

test("isMerged: ancestry is GitHub's word: a planted origin/main does not make a tip merged (and does fool plain git)", async () => {
  const f = await worktreeFixture()
  const made = await create(f, 'x')
  const tip = await f.commit(made.path, 'x.txt', 'x\n')
  await f.git(['update-ref', 'refs/remotes/origin/main', tip])
  const plain = await run('git', ['-C', f.clone, 'merge-base', '--is-ancestor', tip, 'origin/main'], { env: f.env })
  assert.equal(plain.code, 0, 'the fixture fools a local check')
  const check = await f.call(() => isMerged(f.clone, recordOf(made), tip, githubWord(f.clone), []))
  assert.equal(check.merged, false)
  assert.match(check.reason ?? '', /isn't on GitHub's main/)
})

test("isMerged: when GitHub can't be asked, ancestry isn't confirmed; a merged pull request still counts", async () => {
  const f = await worktreeFixture()
  const made = await create(f, 'x')
  const tip = await f.commit(made.path, 'x.txt', 'x\n')
  await f.git(['push', '-q', 'origin', `${tip}:refs/heads/main`])
  await f.git(['fetch', '-q', 'origin'])
  await rename(f.bare, `${f.bare}.away`)
  const check = await f.call(() => isMerged(f.clone, recordOf(made), tip, githubWord(f.clone), []))
  assert.equal(check.merged, false)
  assert.match(check.reason ?? '', /couldn't confirm/)
  assert.deepEqual(await f.call(() => isMerged(f.clone, recordOf(made), tip, githubWord(f.clone), [mergedPull(8, tip)])),
    { merged: true, by: 'pull-request', pull: 8 })
})

// --- sweepProject ---------------------------------------------------------------------------------------------------

/** One sweep with the fixture's deps (one Worktrees for both, as the service has). */
async function sweep(f: WorktreeFixture, worktrees = f.worktrees()): Promise<SweepResult> {
  return f.call(() => sweepProject(f.project, worktrees, f.deps()))
}

function sorted(result: SweepResult): SweepResult {
  return {
    removed: [...result.removed].sort((a, b) => a.slug.localeCompare(b.slug)),
    kept: [...result.kept].sort((a, b) => a.slug.localeCompare(b.slug)).map(({ detail: _detail, ...rest }) => rest),
  }
}

test('sweepProject: removes the merged, clean one; keeps dirty, bound, recent and not merged ones', async () => {
  const f = await worktreeFixture()
  const merge = async (made: CreatedWorktree): Promise<string> => {
    const tip = await f.commit(made.path, `${made.slug}.txt`, `${made.slug}\n`)
    f.pulls.set(tip, [mergedPull(10, tip, made.branch)])
    return tip
  }
  const done = await create(f, 'done')
  await merge(done)
  const dirty = await create(f, 'dirty')
  await merge(dirty)
  await writeFile(join(dirty.path, 'notes.txt'), 'not committed\n')
  const bound = await create(f, 'bound')
  await merge(bound)
  f.bindings.set(bound.path, [{ child: 'c1', role: 'coder', title: 'busy', running: true }])
  const finished = await create(f, 'finished')
  await merge(finished)
  f.bindings.set(finished.path, [{ child: 'c2', role: 'coder', title: 'done', running: false }])
  const recent = await create(f, 'recent')
  await merge(recent)
  const fresh = await create(f, 'fresh')
  const unmerged = await create(f, 'unmerged')
  await f.commit(unmerged.path, 'u.txt', 'u\n')
  const after = await create(f, 'after')
  const head = await merge(after)
  await f.commit(after.path, 'more.txt', 'after the merge\n')
  f.pulls.set(head, [mergedPull(11, head, 'dish/after')])

  const worktrees = f.worktrees()
  assert.ok(await f.call(() => worktrees.resolve(recent.path, [f.project])))
  const result = await sweep(f, worktrees)
  assert.deepEqual(sorted(result), {
    removed: [
      { project: 'acme/widget', slug: 'done', by: 'pull-request' },
      { project: 'acme/widget', slug: 'finished', by: 'pull-request' },
    ],
    kept: [
      { project: 'acme/widget', slug: 'after', reason: 'not-merged' },
      { project: 'acme/widget', slug: 'bound', reason: 'bound' },
      { project: 'acme/widget', slug: 'dirty', reason: 'dirty' },
      { project: 'acme/widget', slug: 'fresh', reason: 'not-merged' },
      { project: 'acme/widget', slug: 'recent', reason: 'recent' },
      { project: 'acme/widget', slug: 'unmerged', reason: 'not-merged' },
    ],
  })
  for (const made of [done, finished]) {
    assert.ok(!await exists(made.path), made.slug)
    assert.ok(!await hasBranch(f, made.branch), made.slug)
  }
  for (const made of [dirty, bound, recent, fresh, unmerged, after]) {
    assert.ok(await exists(made.path), made.slug)
    assert.ok(await hasBranch(f, made.branch), made.slug)
  }
  assert.equal(await readFile(join(dirty.path, 'notes.txt'), 'utf8'), 'not committed\n')
  assert.ok(!f.pullCalls.includes(fresh.base), "a new worktree's base is never looked up")
  assert.ok(f.bindingCalls.includes(bound.path), 'bindings asked with the canonical path')

  // Five minutes on, the recent one goes too.
  f.clock.now += 300_001
  const later = await sweep(f, worktrees)
  assert.deepEqual(later.removed, [{ project: 'acme/widget', slug: 'recent', by: 'pull-request' }])
})

test('sweepProject: an ancestry merge is swept, with its local branch', async () => {
  const f = await worktreeFixture()
  const made = await create(f, 'x')
  const tip = await f.commit(made.path, 'x.txt', 'x\n')
  await f.git(['push', '-q', 'origin', `${tip}:refs/heads/main`])
  await f.git(['fetch', '-q', 'origin'])
  const result = await sweep(f)
  assert.deepEqual(result, { removed: [{ project: 'acme/widget', slug: 'x', by: 'ancestry' }], kept: [] })
  assert.ok(!await hasBranch(f, 'dish/x'))
  assert.ok(!await exists(made.path))
})

test("sweepProject: a record whose worktree and branch were removed by hand is dropped as missing", async () => {
  const f = await worktreeFixture()
  const made = await create(f, 'gone')
  await f.git(['worktree', 'remove', made.path])
  await f.git(['branch', '-D', 'dish/gone'])
  const result = await sweep(f)
  assert.deepEqual(sorted(result), { removed: [], kept: [{ project: 'acme/widget', slug: 'gone', reason: 'missing' }] })
  assert.deepEqual(await f.call(() => f.worktrees().records(f.project)), [])
})

test("sweepProject: a worktree directory removed by hand, its branch unmerged, keeps its branch and record", async () => {
  const f = await worktreeFixture()
  const made = await create(f, 'half')
  await f.commit(made.path, 'h.txt', 'h\n')
  await f.git(['worktree', 'remove', made.path])
  const result = await sweep(f)
  assert.deepEqual(sorted(result), { removed: [], kept: [{ project: 'acme/widget', slug: 'half', reason: 'not-merged' }] })
  assert.ok(await hasBranch(f, 'dish/half'))
})

test("sweepProject: never touches .worktrees/.cache or a worktree dish didn't make, merged or not", async () => {
  const f = await worktreeFixture()
  const cache = join(f.clone, '.worktrees', '.cache')
  await mkdir(join(cache, 'pnpm'), { recursive: true })
  await writeFile(join(cache, 'pnpm', 'blob'), 'cache\n')
  const manual = join(f.clone, '.worktrees', 'manual')
  await f.git(['worktree', 'add', '-q', '-b', 'dish/manual', manual])
  const tip = await f.commit(manual, 'm.txt', 'm\n')
  f.pulls.set(tip, [mergedPull(2, tip, 'dish/manual')])
  await f.git(['push', '-q', 'origin', `${tip}:refs/heads/main`])
  await f.git(['fetch', '-q', 'origin'])
  const made = await create(f, 'mine')
  const mine = await f.commit(made.path, 'mine.txt', 'mine\n')
  f.pulls.set(mine, [mergedPull(3, mine, 'dish/mine')])

  const result = await sweep(f)
  assert.deepEqual(result.removed, [{ project: 'acme/widget', slug: 'mine', by: 'pull-request' }])
  assert.equal(await readFile(join(cache, 'pnpm', 'blob'), 'utf8'), 'cache\n')
  assert.ok(await exists(join(manual, 'm.txt')))
  assert.ok(await hasBranch(f, 'dish/manual'))
  assert.ok(!f.pullCalls.includes(tip), 'the hand-made one is never looked at')
})

test('sweepProject: one failing removal is an error, and the next is still swept', async () => {
  const f = await worktreeFixture()
  const locked = await create(f, 'a-locked')
  const ok = await create(f, 'b-ok')
  for (const made of [locked, ok]) {
    const tip = await f.commit(made.path, `${made.slug}.txt`, 'x\n')
    f.pulls.set(tip, [mergedPull(1, tip, made.branch)])
  }
  await f.git(['worktree', 'lock', locked.path])
  const result = await sweep(f)
  assert.deepEqual(result.removed, [{ project: 'acme/widget', slug: 'b-ok', by: 'pull-request' }])
  assert.equal(result.kept.length, 1)
  assert.equal(result.kept[0]!.slug, 'a-locked')
  assert.equal(result.kept[0]!.reason, 'error')
  assert.match(result.kept[0]!.detail ?? '', /lock/)
  assert.ok(await exists(locked.path))
  assert.ok(await hasBranch(f, 'dish/a-locked'))
  assert.ok(!await exists(ok.path))
})

test("sweepProject: a worktree whose .git was rewritten is an error and stays", async () => {
  const f = await worktreeFixture()
  const made = await create(f, 'odd')
  const tip = await f.commit(made.path, 'odd.txt', 'x\n')
  f.pulls.set(tip, [mergedPull(1, tip, made.branch)])
  await writeFile(join(made.path, '.git'), 'gitdir: /tmp\n')
  const result = await sweep(f)
  assert.deepEqual(sorted(result), { removed: [], kept: [{ project: 'acme/widget', slug: 'odd', reason: 'error' }] })
  assert.ok(await exists(join(made.path, 'odd.txt')))
})

test("sweepProject: a worktree switched off its branch is kept, though its branch is merged", async () => {
  const f = await worktreeFixture()
  const made = await create(f, 'moved')
  const tip = await f.commit(made.path, 'moved.txt', 'x\n')
  f.pulls.set(tip, [mergedPull(1, tip, made.branch)])
  await f.git(['checkout', '-q', '--detach'], made.path)
  await f.commit(made.path, 'detached.txt', 'only here\n')
  const result = await sweep(f)
  assert.deepEqual(sorted(result), { removed: [], kept: [{ project: 'acme/widget', slug: 'moved', reason: 'dirty' }] })
  assert.ok(await exists(join(made.path, 'detached.txt')))
})

test("sweepProject: pulls through dish's GitHub client against the fake API (head.sha is the tip)", async () => {
  const keys = testKeys()
  const fake = await startFakeGitHub({ publicKey: keys.publicKey })
  try {
    const app = new GitHubApp(async () => ({ appId: String(fake.app.id), privateKey: keys.privateKeyPem }), { api: fake.api })
    fake.installations.set('acme', { id: 77, account: 'acme', repos: new Set(['widget']) })
    const { token } = await app.createToken(77, ['widget'], { metadata: 'read', pull_requests: 'read' })
    const f = await worktreeFixture()
    const squashed = await create(f, 'squashed')
    const tip = await f.commit(squashed.path, 's.txt', 's\n')
    fake.pulls.set(tip, [mergedPull(21, tip, 'dish/squashed')])
    const later = await create(f, 'later')
    const merged = await f.commit(later.path, 'l.txt', 'l\n')
    await f.commit(later.path, 'm.txt', 'after the merge\n')
    fake.pulls.set(merged, [mergedPull(22, merged, 'dish/later')])
    const result = await f.call(() => sweepProject(f.project, f.worktrees(), f.deps({
      pulls: (project, sha) => app.pullsForCommit(project.owner, project.repo, sha, token),
    })))
    assert.deepEqual(sorted(result), {
      removed: [{ project: 'acme/widget', slug: 'squashed', by: 'pull-request' }],
      kept: [{ project: 'acme/widget', slug: 'later', reason: 'not-merged' }],
    })
    assert.ok(fake.requests.some(request => request.path.startsWith(`/repos/acme/widget/commits/${tip}/pulls`)))
  } finally {
    await fake.close()
  }
})

test("sweepProject: ancestry is GitHub's word: a planted origin/main or origin/HEAD keeps the worktree, as not merged", async () => {
  const f = await worktreeFixture()
  const main = await create(f, 'by-main')
  const mainTip = await f.commit(main.path, 'a.txt', 'a\n')
  const head = await create(f, 'by-head')
  const headTip = await f.commit(head.path, 'b.txt', 'b\n')
  // An agent's refs: origin/main moved to one tip, and origin/HEAD pointed at a ref holding the other.
  await f.git(['update-ref', 'refs/remotes/origin/main', mainTip])
  await f.git(['update-ref', 'refs/remotes/origin/evil', headTip])
  await f.git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/evil'])
  // The default branch as dish reads it locally (Task 7a's defaultBranch): origin/HEAD's.
  const local = async (): Promise<string> => (await f.git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).replace(/^origin\//, '')
  assert.equal(await local(), 'evil', 'the fixture: origin/HEAD is planted')
  const result = await f.call(() => sweepProject(f.project, f.worktrees(), f.deps({ defaultBranch: local })))
  assert.deepEqual(sorted(result), {
    removed: [],
    kept: [
      { project: 'acme/widget', slug: 'by-head', reason: 'not-merged' },
      { project: 'acme/widget', slug: 'by-main', reason: 'not-merged' },
    ],
  })
  for (const made of [main, head]) assert.ok(await hasBranch(f, made.branch))
})

test("sweepProject: when GitHub can't be asked, an ancestry merge is kept (couldn't confirm), and a merged pull request is still swept", async () => {
  const f = await worktreeFixture()
  const ancestry = await create(f, 'ancestry')
  const tip = await f.commit(ancestry.path, 'a.txt', 'a\n')
  await f.git(['push', '-q', 'origin', `${tip}:refs/heads/main`])
  await f.git(['fetch', '-q', 'origin'])
  const pulled = await create(f, 'pulled')
  const pulledTip = await f.commit(pulled.path, 'p.txt', 'p\n')
  f.pulls.set(pulledTip, [mergedPull(5, pulledTip, 'dish/pulled')])
  await rename(f.bare, `${f.bare}.away`)
  const result = await sweep(f)
  assert.deepEqual(result.removed, [{ project: 'acme/widget', slug: 'pulled', by: 'pull-request' }])
  assert.equal(result.kept.length, 1)
  assert.equal(result.kept[0]!.reason, 'not-merged')
  assert.match(result.kept[0]!.detail ?? '', /couldn't confirm/)
  assert.ok(await exists(ancestry.path))
})

test('sweepProject: a worktree holding another worktree (in .worktrees/, which the shared exclude ignores) is kept, with the other one', async () => {
  const f = await worktreeFixture()
  const outer = await create(f, 'outer')
  const tip = await f.commit(outer.path, 'o.txt', 'o\n')
  f.pulls.set(tip, [mergedPull(6, tip, 'dish/outer')])
  const inner = join(outer.path, '.worktrees', 'inner')
  await f.git(['worktree', 'add', '-q', '-b', 'mine', inner])
  await writeFile(join(inner, 'work.txt'), 'uncommitted\n')
  assert.equal(await f.git(['status', '--porcelain', '--untracked-files=normal', '--ignore-submodules=dirty'], outer.path), '', 'git calls the outer one clean')
  const result = await sweep(f)
  assert.deepEqual(sorted(result), { removed: [], kept: [{ project: 'acme/widget', slug: 'outer', reason: 'dirty' }] })
  assert.match(result.kept[0]!.detail ?? '', /another worktree/)
  assert.equal(await readFile(join(inner, 'work.txt'), 'utf8'), 'uncommitted\n')
})

test("sweepProject: a hand-made worktree whose directory is gone keeps git's entry (no prune); dish's own missing ones go", async () => {
  const f = await worktreeFixture()
  const manual = join(f.clone, '.worktrees', 'manual')
  await f.git(['worktree', 'add', '-q', '--detach', manual])
  const only = await f.commit(manual, 'only.txt', 'only in this worktree\n')
  await rm(manual, { recursive: true, force: true })
  const gone = await create(f, 'gone')
  await rm(gone.path, { recursive: true, force: true })
  await f.git(['update-ref', '-d', 'refs/heads/dish/gone'])
  const half = await create(f, 'half')
  const halfTip = await f.commit(half.path, 'h.txt', 'h\n')
  f.pulls.set(halfTip, [mergedPull(4, halfTip, 'dish/half')])
  await rm(half.path, { recursive: true, force: true })

  const result = await sweep(f)
  assert.deepEqual(sorted(result), {
    removed: [{ project: 'acme/widget', slug: 'half', by: 'pull-request' }],
    kept: [{ project: 'acme/widget', slug: 'gone', reason: 'missing' }],
  })
  const listed = await f.git(['worktree', 'list', '--porcelain'])
  assert.ok(listed.includes(`worktree ${manual}`), "the hand-made worktree's entry is still there")
  assert.ok(listed.includes(`HEAD ${only}`), 'and still holds its commit')
  assert.ok(!listed.includes(`worktree ${gone.path}`))
  assert.ok(!listed.includes(`worktree ${half.path}`))
  assert.ok(!await hasBranch(f, 'dish/half'))
})

test('sweepProject: a branch checked out in another worktree (the clone itself) keeps the branch and the record', async () => {
  const f = await worktreeFixture()
  const made = await create(f, 'x')
  const tip = await f.commit(made.path, 'x.txt', 'x\n')
  f.pulls.set(tip, [mergedPull(3, tip, 'dish/x')])
  await f.git(['worktree', 'remove', made.path])
  await f.git(['checkout', '-q', 'dish/x'])
  const result = await sweep(f)
  assert.equal(result.removed.length, 0)
  assert.equal(result.kept[0]!.reason, 'error')
  assert.match(result.kept[0]!.detail ?? '', /checked out/)
  assert.ok(await hasBranch(f, 'dish/x'))
  assert.equal(await f.git(['symbolic-ref', 'HEAD']), 'refs/heads/dish/x')
  assert.deepEqual((await f.call(() => f.worktrees().records(f.project))).map(record => record.slug), ['x'])
})
