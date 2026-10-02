import { test } from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { GitHubApp } from '../src/github.ts'
import { internals as sweepInternals, isMerged, sweepProject } from '../src/sweep.ts'
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
  assert.deepEqual(await f.call(() => isMerged(f.clone, recordOf(made), tip, 'main', [openPull(3, 'f'.repeat(40)), mergedPull(4, tip)])),
    { merged: true, by: 'pull-request', pull: 4 })
})

test('isMerged: a pull request merged at another head (commits after the merge) is not', async () => {
  const f = await worktreeFixture()
  const made = await create(f, 'x')
  const merged = await f.commit(made.path, 'x.txt', 'x\n')
  const tip = await f.commit(made.path, 'y.txt', 'after the merge\n')
  const check = await f.call(() => isMerged(f.clone, recordOf(made), tip, 'main', [mergedPull(4, merged)]))
  assert.equal(check.merged, false)
})

test('isMerged: an ancestry merge with commits of its own is merged', async () => {
  const f = await worktreeFixture()
  const made = await create(f, 'x')
  const tip = await f.commit(made.path, 'x.txt', 'x\n')
  await f.git(['push', '-q', 'origin', `${tip}:refs/heads/main`])
  await f.git(['fetch', '-q', 'origin'])
  assert.deepEqual(await f.call(() => isMerged(f.clone, recordOf(made), tip, 'main', [])), { merged: true, by: 'ancestry' })
})

test("isMerged: a new worktree (its tip is its base, on origin/main) is not merged, even with a merged pull request at that commit", async () => {
  const f = await worktreeFixture()
  const made = await create(f, 'x')
  const check = await f.call(() => isMerged(f.clone, recordOf(made), made.base, 'main', [mergedPull(1, made.base)]))
  assert.equal(check.merged, false)
  const ancestor = await run('git', ['-C', f.clone, 'merge-base', '--is-ancestor', made.base, 'origin/main'], { env: f.env })
  assert.equal(ancestor.code, 0, 'the fixture: it is an ancestor')
})

test('isMerged: an open pull request at the tip is not merged', async () => {
  const f = await worktreeFixture()
  const made = await create(f, 'x')
  const tip = await f.commit(made.path, 'x.txt', 'x\n')
  assert.equal((await f.call(() => isMerged(f.clone, recordOf(made), tip, 'main', [openPull(5, tip)]))).merged, false)
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
  assert.equal((await f.call(() => isMerged(f.clone, recordOf(made), tip, 'main', []))).merged, false)
})

test("isMerged: a tip that isn't a commit id, or a default branch that isn't a branch name, is refused", async () => {
  const f = await worktreeFixture()
  const made = await create(f, 'x')
  await assert.rejects(f.call(() => isMerged(f.clone, recordOf(made), '--all', 'main', [])))
  await assert.rejects(f.call(() => isMerged(f.clone, recordOf(made), 'a'.repeat(40), '-x', [])))
  await assert.rejects(f.call(() => isMerged(f.clone, recordOf(made), 'a'.repeat(40), 'a..b', [])))
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
