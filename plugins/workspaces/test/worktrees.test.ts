import { test } from 'node:test'
import assert from 'node:assert/strict'
import { access, lstat, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { worktreeRecordFile, worktreeSetupLogFile } from '../src/paths.ts'
import { skipReason } from '../src/setup.ts'
import { internals as sweepInternals } from '../src/sweep.ts'
import { RECENT_RESOLVE_MS, SLUG, WORKTREE_SETUP_SKIPPED, internals } from '../src/worktrees.ts'
import type { CreatedWorktree, WorktreeRecord } from '../src/worktrees.ts'
import { NOSYSTEM, run, tempDir } from './helpers.ts'
import { mergedPull, projectOf, worktreeFixture } from './worktree-helpers.ts'
import type { WorktreeFixture } from './worktree-helpers.ts'

// The code's own git drops every GIT_* name of process.env; this gives it no system config, as every test git has.
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

/** Whether the clone has `refs/heads/<branch>`. */
async function hasBranch(f: WorktreeFixture, branch: string): Promise<boolean> {
  const result = await run('git', ['-C', f.clone, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { env: f.env })
  return result.code === 0
}

/** `create` from the clone's own workspace, with the fixture's deps. */
async function create(f: WorktreeFixture, slug: string, base?: string, cwd = f.clone): Promise<CreatedWorktree> {
  return f.call(() => f.worktrees().create(f.project, slug, base, { cwd }))
}

async function recordOf(f: WorktreeFixture, slug: string): Promise<WorktreeRecord> {
  return JSON.parse(await readFile(worktreeRecordFile(f.state, f.project.owner, f.project.repo, slug), 'utf8')) as WorktreeRecord
}

/** The worktree's record dir, listed (empty when there is none). */
async function recordNames(f: WorktreeFixture): Promise<string[]> {
  try {
    return (await readdir(join(f.state, 'workspaces', f.project.owner, f.project.repo, 'worktrees'))).sort()
  } catch {
    return []
  }
}

// --- create ---------------------------------------------------------------------------------------------------------

test('SLUG is the contract', () => {
  assert.equal(SLUG.source, '^[a-z0-9][a-z0-9-]{0,39}$')
  assert.equal(RECENT_RESOLVE_MS, 300_000)
})

test('create: the slug grammar', async () => {
  const f = await worktreeFixture()
  for (const slug of ['a', 'fix-1', 'x'.repeat(40)]) {
    const made = await create(f, slug)
    assert.equal(made.slug, slug)
    assert.equal(made.branch, `dish/${slug}`)
  }
  for (const slug of ['-a', 'A', 'a_b', '.cache', 'x'.repeat(41), '', 'a/b', '..']) {
    await assert.rejects(create(f, slug), /can't name a worktree/, `slug ${JSON.stringify(slug)}`)
  }
  assert.deepEqual(await recordNames(f), ['a.json', 'fix-1.json', `${'x'.repeat(40)}.json`])
  assert.ok(!await exists(join(f.clone, '.worktrees', '.cache')))
})

test('create: the default base is origin/main after the fetch, and the record holds its commit, no tracking', async () => {
  const f = await worktreeFixture()
  const next = await f.pushMain('b.txt', 'b\n')
  const made = await create(f, 'one')
  assert.equal(f.fetches, 1, 'create fetched')
  assert.equal(made.base, next, "cut from GitHub's main as the fetch left it")
  assert.equal(made.path, join(f.clone, '.worktrees', 'one'))
  assert.equal(made.clone, f.clone)
  assert.equal(made.project, 'acme/widget')
  assert.equal(await f.git(['rev-parse', 'HEAD'], made.path), next)
  assert.equal(await f.git(['symbolic-ref', 'HEAD'], made.path), 'refs/heads/dish/one')
  assert.deepEqual(await recordOf(f, 'one'), {
    project: 'acme/widget', slug: 'one', branch: 'dish/one', base: next, baseRef: 'origin/main', createdAt: f.clock.now,
  })
  const merge = await run('git', ['-C', f.clone, 'config', '--get', 'branch.dish/one.merge'], { env: f.env })
  assert.equal(merge.code, 1, '--no-track: no upstream')
})

test('create: a given base (a tag, a remote branch, a local branch) is resolved to its commit', async () => {
  const f = await worktreeFixture()
  const first = await f.git(['rev-parse', 'HEAD'])
  await f.git(['tag', 'v1'])
  const local = await f.commit(f.clone, 'local.txt', 'local\n')
  await f.git(['branch', 'topic', local])
  await f.git(['reset', '-q', '--hard', first])
  const work = join(await tempDir(), 'work')
  await run('git', ['clone', '-q', f.url, work], { env: f.env })
  await f.git(['checkout', '-q', '-b', 'feature'], work)
  const feature = await f.commit(work, 'feature.txt', 'feature\n')
  await f.git(['push', '-q', 'origin', 'feature'], work)

  const tag = await create(f, 'from-tag', 'v1')
  assert.equal(tag.base, first)
  assert.equal((await recordOf(f, 'from-tag')).baseRef, 'v1')
  const remote = await create(f, 'from-remote', 'origin/feature')
  assert.equal(remote.base, feature, 'the fetch brought origin/feature')
  const merge = await run('git', ['-C', f.clone, 'config', '--get', 'branch.dish/from-remote.merge'], { env: f.env })
  assert.equal(merge.code, 1, 'no upstream, even from a remote branch')
  const branch = await create(f, 'from-local', 'topic')
  assert.equal(branch.base, local)
  assert.equal((await recordOf(f, 'from-local')).base, local)
})

test("create: a bad base, or one that looks like an option, is refused and nothing is made", async () => {
  const f = await worktreeFixture()
  await assert.rejects(create(f, 'one', 'no-such-ref'), /isn't a commit/)
  await assert.rejects(create(f, 'two', '--orphan'), /base/)
  await assert.rejects(create(f, 'three', 'a\nb'), /base/)
  assert.deepEqual(await recordNames(f), [])
  for (const slug of ['one', 'two', 'three']) {
    assert.ok(!await hasBranch(f, `dish/${slug}`))
    assert.ok(!await exists(join(f.clone, '.worktrees', slug)))
  }
})

test('create: a slug in use (its record, its directory, or its branch) is refused', async () => {
  const f = await worktreeFixture()
  await create(f, 'taken')
  await assert.rejects(create(f, 'taken'), /in use/)

  await mkdir(join(f.clone, '.worktrees', 'dir'), { recursive: true })
  await assert.rejects(create(f, 'dir'), /in use/)

  await f.git(['branch', 'dish/branch'])
  await assert.rejects(create(f, 'branch'), /in use/)

  // A record alone (its worktree and branch gone by hand) still holds the name.
  const record = worktreeRecordFile(f.state, 'acme', 'widget', 'recorded')
  await mkdir(join(record, '..'), { recursive: true })
  await writeFile(record, JSON.stringify({ project: 'acme/widget', slug: 'recorded', branch: 'dish/recorded', base: 'a'.repeat(40), baseRef: 'origin/main', createdAt: 1 }))
  await assert.rejects(create(f, 'recorded'), /in use/)
  assert.deepEqual(await recordNames(f), ['recorded.json', 'taken.json'])
})

test("create: a cwd outside the clone is refused; the clone's own workspace, reached through a link, is fine", async () => {
  const f = await worktreeFixture()
  const elsewhere = await tempDir()
  await assert.rejects(create(f, 'one', undefined, elsewhere), /workspace/)
  await assert.rejects(create(f, 'two', undefined, join(f.clone, 'src')), /workspace/, "a folder of the clone that doesn't hold .worktrees")
  await assert.rejects(create(f, 'three', undefined, f.workRoot), /workspace/, 'the work root holds the clone, but is not its workspace')
  await assert.rejects(create(f, 'four', undefined, join(f.dir, 'missing')), /workspace/)
  assert.deepEqual(await recordNames(f), [])
  assert.equal(f.fetches, 0, 'refused before the fetch')

  const link = join(await tempDir(), 'link')
  await symlink(f.clone, link)
  const made = await create(f, 'five', undefined, link)
  assert.equal(made.path, join(f.clone, '.worktrees', 'five'))
})

test('create: paths are canonical when the work root is reached through a link', async () => {
  const f = await worktreeFixture()
  const link = join(await tempDir(), 'work-link')
  await symlink(f.workRoot, link)
  const made = await f.call(() => f.worktrees({ workRoot: link }).create(f.project, 'one', undefined, { cwd: join(link, 'acme', 'widget') }))
  assert.equal(made.clone, f.clone)
  assert.equal(made.path, join(f.clone, '.worktrees', 'one'))
})

test('create: setup is not run in a worktree (default A): the answer gives the reason and the command, and the worktree stays', async () => {
  const f = await worktreeFixture({ setup: 'touch setup-ran' })
  const made = await create(f, 'one')
  assert.deepEqual(made.setup, { ran: false, reason: skipReason(WORKTREE_SETUP_SKIPPED, made.path, 'touch setup-ran') })
  assert.match(made.setup.ran ? '' : made.setup.reason, /touch setup-ran/)
  assert.ok(!await exists(join(made.path, 'setup-ran')))
  assert.ok(!await exists(worktreeSetupLogFile(f.state, 'acme', 'widget', 'one')))
  assert.ok(await exists(join(made.path, 'README.md')))

  const plain = await worktreeFixture()
  assert.deepEqual((await create(plain, 'one')).setup, { ran: false, reason: 'no setup' })
})

test("create: a clone with a config key dish doesn't allow, or another origin, is refused with the finding", async () => {
  const f = await worktreeFixture()
  await f.git(['config', 'core.pager', 'touch pager-ran'])
  await assert.rejects(create(f, 'one'), /core\.pager/)
  await f.git(['config', '--unset', 'core.pager'])
  await assert.rejects(f.call(() => f.worktrees({ cloneExpectations: () => ({ url: 'https://example.invalid/acme/widget.git' }) })
    .create(f.project, 'two', undefined, { cwd: f.clone })), /remote\.origin\.url/)
  assert.deepEqual(await recordNames(f), [])
})

test('create: a .worktrees that is a link is refused', async () => {
  const f = await worktreeFixture()
  const elsewhere = await tempDir()
  await symlink(elsewhere, join(f.clone, '.worktrees'))
  await assert.rejects(create(f, 'one'), /\.worktrees/)
  assert.deepEqual(await readdir(elsewhere), [])
  assert.deepEqual(await recordNames(f), [])
})

/** `create` with `.worktrees` swapped for a link to a fresh directory just before `git worktree add`, and `after` run right after it. */
async function createThroughLink(f: WorktreeFixture, slug: string, after?: (elsewhere: string) => Promise<void>): Promise<{ elsewhere: string, error: Error }> {
  const elsewhere = await tempDir()
  internals.beforeAdd = async () => {
    await rm(join(f.clone, '.worktrees'), { recursive: true, force: true }) // empty: create just made it
    await symlink(elsewhere, join(f.clone, '.worktrees'))
  }
  internals.afterAdd = after === undefined ? undefined : () => after(elsewhere)
  try {
    await create(f, slug)
  } catch (error) {
    return { elsewhere, error: error as Error }
  } finally {
    internals.beforeAdd = undefined
    internals.afterAdd = undefined
  }
  assert.fail('create should have refused')
}

test('create: a .worktrees swapped for a link just before git makes the worktree: what git made is removed where it landed, and it is refused', async () => {
  const f = await worktreeFixture()
  const { elsewhere, error } = await createThroughLink(f, 'two')
  assert.match(error.message, /landed at .*dish removed it$/)
  assert.deepEqual(await readdir(elsewhere), [], 'the worktree git made through the link is gone')
  assert.ok(!await hasBranch(f, 'dish/two'))
  assert.deepEqual(await recordNames(f), [])
  assert.ok(!(await f.git(['worktree', 'list', '--porcelain'])).includes('/two\n'))
})

test('create: the undo goes by where git put it, so a link swapped back to a directory before it still works', async () => {
  const f = await worktreeFixture()
  const { elsewhere, error } = await createThroughLink(f, 'two', async () => {
    await rm(join(f.clone, '.worktrees'))
    await mkdir(join(f.clone, '.worktrees'))
  })
  assert.match(error.message, /landed at .*dish removed it$/)
  assert.deepEqual(await readdir(elsewhere), [])
  assert.ok(!await hasBranch(f, 'dish/two'))
  assert.deepEqual(await recordNames(f), [])
})

test("create: when the undo fails, it says so, and the branch and the record are kept", async () => {
  const f = await worktreeFixture()
  const { elsewhere, error } = await createThroughLink(f, 'two', async there => {
    await f.git(['worktree', 'lock', join(there, 'two')])
  })
  assert.match(error.message, /couldn't remove it there .*locked.*branch dish\/two and its record are kept; remove it yourself/)
  assert.ok(!/dish removed it/.test(error.message))
  assert.ok(await exists(join(elsewhere, 'two', 'README.md')))
  assert.ok(await hasBranch(f, 'dish/two'))
  assert.deepEqual(await recordNames(f), ['two.json'])
})

test("create: a project without a clone is refused", async () => {
  const f = await worktreeFixture()
  await assert.rejects(f.call(() => f.worktrees().create(projectOf('acme', 'other'), 'one', undefined, { cwd: f.clone })), /no clone/)
})

// --- list -----------------------------------------------------------------------------------------------------------

test('list: a managed clean worktree, a dirty one, one ahead, one behind, a hand-made one, and bindings', async () => {
  const f = await worktreeFixture({ files: { 'README.md': '# widget\n', '.gitignore': 'node_modules/\n' } })
  const clean = await create(f, 'clean')
  const dirty = await create(f, 'dirty')
  const ahead = await create(f, 'ahead')
  await writeFile(join(dirty.path, 'new.txt'), 'untracked\n')
  await mkdir(join(clean.path, 'node_modules'))
  await writeFile(join(clean.path, 'node_modules', 'ignored.js'), 'ignored\n')
  await f.commit(ahead.path, 'ahead.txt', 'ahead\n')
  await f.git(['worktree', 'add', '-q', '-b', 'mine', join(f.clone, '.worktrees', 'manual')])
  const behind = await create(f, 'behind')
  await f.pushMain('main.txt', 'main\n')
  await f.git(['fetch', '-q', 'origin'])
  f.bindings.set(clean.path, [{ child: 'c1', role: 'coder', title: 'clean work', running: true }])

  const infos = await f.call(() => f.worktrees().list(f.project))
  const by = new Map(infos.map(info => [info.slug, info]))
  assert.deepEqual([...by.keys()].sort(), ['ahead', 'behind', 'clean', 'dirty', 'manual'])
  assert.deepEqual(by.get('clean'), {
    project: 'acme/widget', slug: 'clean', branch: 'dish/clean', path: clean.path, clone: f.clone, base: clean.base,
    ahead: 0, behind: 1, dirty: false, merged: false, managed: true,
    bound: [{ child: 'c1', role: 'coder', title: 'clean work', running: true }],
  })
  assert.equal(by.get('dirty')!.dirty, true)
  assert.equal(by.get('ahead')!.ahead, 1)
  assert.equal(by.get('ahead')!.dirty, false)
  assert.equal(by.get('behind')!.behind, 1)
  const manual = by.get('manual')!
  assert.equal(manual.managed, false)
  assert.equal(manual.merged, false)
  assert.equal(manual.branch, 'mine')
  assert.equal(manual.path, join(f.clone, '.worktrees', 'manual'))
  assert.ok(f.bindingCalls.includes(clean.path), 'bindings asked with the canonical path')
})

test('list: merged is computed for managed worktrees (a squash-merged pull request)', async () => {
  const f = await worktreeFixture()
  const made = await create(f, 'done')
  const tip = await f.commit(made.path, 'done.txt', 'done\n')
  f.pulls.set(tip, [mergedPull(7, tip, 'dish/done')])
  const [info] = await f.call(() => f.worktrees().list(f.project))
  assert.equal(info!.merged, true)
})

test('list: a gitlink, or a nested repository in a tracked folder, counts as dirty', async () => {
  const f = await worktreeFixture()
  const gitlink = await create(f, 'gitlink')
  // A submodule as a fresh checkout leaves it: a gitlink, and an empty folder.
  await mkdir(join(gitlink.path, 'vendor', 'inner'), { recursive: true })
  await f.git(['update-index', '--add', '--cacheinfo', `160000,${gitlink.base},vendor/inner`], gitlink.path)
  await f.git(['commit', '-q', '-m', 'a gitlink'], gitlink.path)
  assert.equal(await f.git(['status', '--porcelain', '--ignore-submodules=dirty'], gitlink.path), '', 'git calls it clean')

  const nested = await create(f, 'nested')
  await f.git(['init', '-q', join(nested.path, 'src')])
  assert.equal(await f.git(['status', '--porcelain', '--untracked-files=normal', '--ignore-submodules=dirty'], nested.path), '', 'git calls it clean')

  const infos = await f.call(() => f.worktrees().list(f.project))
  const by = new Map(infos.map(info => [info.slug, info]))
  assert.equal(by.get('gitlink')!.dirty, true)
  assert.equal(by.get('nested')!.dirty, true)
})

// --- remove ---------------------------------------------------------------------------------------------------------

/** Remove with the fixture's deps. */
async function remove(f: WorktreeFixture, slug: string, force = false): Promise<void> {
  return f.call(() => f.worktrees().remove(f.project, slug, force))
}

test('remove: a hand-made worktree is refused and left as it was', async () => {
  const f = await worktreeFixture()
  const manual = join(f.clone, '.worktrees', 'manual')
  await f.git(['worktree', 'add', '-q', '-b', 'dish/manual', manual])
  await assert.rejects(remove(f, 'manual'), /didn't make/)
  await assert.rejects(remove(f, 'manual', true), /didn't make/)
  assert.ok(await exists(join(manual, 'README.md')))
  assert.ok(await hasBranch(f, 'dish/manual'))
})

test('remove: unmerged and dirty are refused without force', async () => {
  const f = await worktreeFixture()
  const fresh = await create(f, 'fresh')
  await assert.rejects(remove(f, 'fresh'), /isn't merged.*no commits of its own/)
  const work = await create(f, 'work')
  await f.commit(work.path, 'work.txt', 'work\n')
  await assert.rejects(remove(f, 'work'), /isn't merged/)
  const dirty = await create(f, 'dirty')
  const tip = await f.commit(dirty.path, 'dirty.txt', 'dirty\n')
  f.pulls.set(tip, [mergedPull(3, tip, 'dish/dirty')])
  await writeFile(join(dirty.path, 'scratch.txt'), 'not committed\n')
  await assert.rejects(remove(f, 'dirty'), /scratch\.txt/)
  for (const made of [fresh, work, dirty]) {
    assert.ok(await exists(made.path))
    assert.ok(await hasBranch(f, made.branch))
  }
})

test('remove: a merged, clean worktree goes with its branch, its record and its setup log', async () => {
  const f = await worktreeFixture()
  const made = await create(f, 'done')
  const tip = await f.commit(made.path, 'done.txt', 'done\n')
  f.pulls.set(tip, [mergedPull(9, tip, 'dish/done')])
  const log = worktreeSetupLogFile(f.state, 'acme', 'widget', 'done')
  await writeFile(log, 'an old log\n')
  await remove(f, 'done')
  assert.ok(!await exists(made.path))
  assert.ok(!await hasBranch(f, 'dish/done'))
  assert.ok(!await exists(log))
  assert.deepEqual(await recordNames(f), [])
  assert.equal(await f.git(['worktree', 'list', '--porcelain']).then(text => text.includes(made.path)), false)
  assert.ok(f.bindingCalls.includes(made.path))
})

test('remove: force removes an unmerged, dirty worktree', async () => {
  const f = await worktreeFixture()
  const made = await create(f, 'work')
  await f.commit(made.path, 'work.txt', 'work\n')
  await writeFile(join(made.path, 'scratch.txt'), 'not committed\n')
  await remove(f, 'work', true)
  assert.ok(!await exists(made.path))
  assert.ok(!await hasBranch(f, 'dish/work'))
  assert.deepEqual(await recordNames(f), [])
})

test('remove: a running binding refuses with and without force; a finished one does not', async () => {
  const f = await worktreeFixture()
  const made = await create(f, 'bound')
  f.bindings.set(made.path, [{ child: 'c1', role: 'coder', title: 'busy', running: true }])
  await assert.rejects(remove(f, 'bound'), /running coder.*c1/)
  await assert.rejects(remove(f, 'bound', true), /running coder.*c1/)
  assert.ok(await exists(made.path))
  f.bindings.set(made.path, [{ child: 'c1', role: 'coder', title: 'busy', running: false }])
  await remove(f, 'bound', true)
  assert.ok(!await exists(made.path))
})

test('remove: bindings are asked about the canonical path when the work root is reached through a link', async () => {
  const f = await worktreeFixture()
  const made = await create(f, 'bound')
  f.bindings.set(made.path, [{ child: 'c1', role: 'coder', title: 'busy', running: true }])
  const link = join(await tempDir(), 'work-link')
  await symlink(f.workRoot, link)
  await assert.rejects(f.call(() => f.worktrees({ workRoot: link }).remove(f.project, 'bound', true)), /running coder/)
  assert.ok(await exists(made.path))
})

test('remove: a worktree whose .git was rewritten is refused, even with force, and left alone', async () => {
  const f = await worktreeFixture()
  const made = await create(f, 'odd')
  const other = await tempDir()
  await writeFile(join(made.path, '.git'), `gitdir: ${other}\n`)
  await assert.rejects(remove(f, 'odd', true), /\.git/)
  assert.ok(await exists(join(made.path, 'README.md')))
})

test('remove: a worktree holding another worktree is refused, with and without force, and both stay', async () => {
  const f = await worktreeFixture()
  const outer = await create(f, 'outer')
  const tip = await f.commit(outer.path, 'o.txt', 'o\n')
  f.pulls.set(tip, [mergedPull(2, tip, 'dish/outer')])
  const inner = join(outer.path, '.worktrees', 'inner')
  await f.git(['worktree', 'add', '-q', '-b', 'mine', inner])
  await writeFile(join(inner, 'work.txt'), 'uncommitted\n')
  await assert.rejects(remove(f, 'outer'), /another worktree/)
  await assert.rejects(remove(f, 'outer', true), /another worktree .*remove it first \(`git worktree remove [^`]*\/\.worktrees\/inner`\), then try again/)
  assert.equal(await readFile(join(inner, 'work.txt'), 'utf8'), 'uncommitted\n')
  assert.ok(await hasBranch(f, 'dish/outer'))
  const [info] = (await f.call(() => f.worktrees().list(f.project))).filter(item => item.slug === 'outer')
  assert.equal(info!.dirty, true)
})

test("remove: ancestry is GitHub's word: a planted origin/main doesn't make it merged", async () => {
  const f = await worktreeFixture()
  const made = await create(f, 'x')
  const tip = await f.commit(made.path, 'x.txt', 'x\n')
  await f.git(['update-ref', 'refs/remotes/origin/main', tip])
  await assert.rejects(remove(f, 'x'), /isn't merged.*GitHub's main/)
  assert.ok(await exists(made.path))
  await f.git(['push', '-q', 'origin', `${tip}:refs/heads/main`])
  await remove(f, 'x')
  assert.ok(!await exists(made.path), 'once GitHub has it')
})

test('remove: a branch checked out in another worktree (the clone itself) is kept, with its record', async () => {
  const f = await worktreeFixture()
  const made = await create(f, 'x')
  const tip = await f.commit(made.path, 'x.txt', 'x\n')
  f.pulls.set(tip, [mergedPull(3, tip, 'dish/x')])
  await f.git(['worktree', 'remove', made.path])
  await f.git(['checkout', '-q', 'dish/x'])
  await assert.rejects(remove(f, 'x'), /checked out/)
  await assert.rejects(remove(f, 'x', true), /checked out/)
  assert.ok(await hasBranch(f, 'dish/x'))
  assert.deepEqual(await recordNames(f), ['x.json'])
})

test('remove: a worktree whose directory was swapped for a link is refused, and the target survives', async () => {
  const f = await worktreeFixture()
  const made = await create(f, 'swap')
  const victim = await tempDir()
  await writeFile(join(victim, 'keep.txt'), 'keep\n')
  await rm(made.path, { recursive: true, force: true })
  await symlink(victim, made.path)
  await assert.rejects(remove(f, 'swap', true), /symbolic link/)
  assert.equal(await readFile(join(victim, 'keep.txt'), 'utf8'), 'keep\n')
})

// --- resolve --------------------------------------------------------------------------------------------------------

test('resolve: by <project>/<slug> in any case of the project, and by path (canonical, through a link, with a trailing /)', async () => {
  const f = await worktreeFixture()
  const made = await create(f, 'one')
  const want = { project: 'acme/widget', slug: 'one', branch: 'dish/one', path: made.path, clone: f.clone, base: made.base }
  const worktrees = f.worktrees()
  const projects = [projectOf('other', 'thing'), f.project]
  assert.deepEqual(await f.call(() => worktrees.resolve('acme/widget/one', projects)), want)
  assert.deepEqual(await f.call(() => worktrees.resolve('ACME/Widget/one', projects)), want)
  assert.deepEqual(await f.call(() => worktrees.resolve(made.path, projects)), want)
  assert.deepEqual(await f.call(() => worktrees.resolve(`${made.path}/`, projects)), want)
  const link = join(await tempDir(), 'link')
  await symlink(f.workRoot, link)
  assert.deepEqual(await f.call(() => worktrees.resolve(join(link, 'acme', 'widget', '.worktrees', 'one'), projects)), want)
})

test('resolve: what is not a managed worktree of a registered project is undefined', async () => {
  const f = await worktreeFixture()
  const made = await create(f, 'one')
  const gone = await create(f, 'gone')
  const odd = await create(f, 'odd')
  const branchless = await create(f, 'branchless')
  await f.git(['worktree', 'add', '-q', '-b', 'dish/manual', join(f.clone, '.worktrees', 'manual')])
  const worktrees = f.worktrees()
  const projects = [f.project]
  await f.call(() => worktrees.remove(f.project, 'gone', true))
  await writeFile(join(odd.path, '.git'), `gitdir: ${await tempDir()}\n`)
  await f.git(['checkout', '-q', '--detach'], branchless.path)
  await f.git(['branch', '-D', 'dish/branchless'])
  const outside = await tempDir()
  const refs = [
    outside, join(f.clone, 'src'), f.clone, join(f.clone, '.worktrees'), join(made.path, 'src'),
    join(f.clone, '.worktrees', 'manual'), 'acme/widget/manual',
    gone.path, 'acme/widget/gone',
    odd.path, 'acme/widget/odd',
    branchless.path, 'acme/widget/branchless',
    'acme/other/one', 'acme/widget/One', 'acme/widget/.cache', 'acme/widget', 'one', 'relative/path', '',
  ]
  for (const ref of refs) assert.equal(await f.call(() => worktrees.resolve(ref, projects)), undefined, ref)
  assert.equal(await f.call(() => worktrees.resolve(made.path, [projectOf('acme', 'other')])), undefined, 'a project not in projects')
  assert.equal(await f.call(() => worktrees.resolve('acme/widget/one', [])), undefined)
  for (const ref of refs) assert.equal(worktrees.recentlyResolved(ref), false)
})

test('recentlyResolved: within 5 minutes of a resolve, by its canonical path', async () => {
  const f = await worktreeFixture()
  const made = await create(f, 'one')
  const worktrees = f.worktrees()
  assert.equal(worktrees.recentlyResolved(made.path), false)
  await f.call(() => worktrees.resolve('acme/widget/one', [f.project]))
  assert.equal(worktrees.recentlyResolved(made.path), true)
  f.clock.now += RECENT_RESOLVE_MS - 1
  assert.equal(worktrees.recentlyResolved(made.path), true)
  f.clock.now += 2
  assert.equal(worktrees.recentlyResolved(made.path), false)
})

// --- records --------------------------------------------------------------------------------------------------------

test('records: every record of the project, sorted; a corrupt or misnamed one is skipped', async () => {
  const f = await worktreeFixture()
  await create(f, 'b')
  await create(f, 'a')
  const dir = join(f.state, 'workspaces', 'acme', 'widget', 'worktrees')
  await writeFile(join(dir, 'corrupt.json'), '{')
  await writeFile(join(dir, 'wrong.json'), JSON.stringify({ ...await recordOf(f, 'a'), slug: 'a' }))
  await writeFile(join(dir, 'Upper.json'), JSON.stringify({ ...await recordOf(f, 'a'), slug: 'Upper', branch: 'dish/Upper' }))
  const records = await f.call(() => f.worktrees().records(f.project))
  assert.deepEqual(records.map(record => record.slug), ['a', 'b'])
  assert.ok((await lstat(dir)).isDirectory())
})
