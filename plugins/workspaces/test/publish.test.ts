/**
 * Step 7's dish-workspaces against the fakes: the head, cleanliness, the push, the pull request (opened, updated,
 * commented on, read) and the branch's standing. Every push goes to the fake git server (`git http-backend` on
 * 127.0.0.1), every API call to the fake GitHub; nothing reaches the network.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { projectStateDir, tokensDir } from '../src/paths.ts'
import { createDishWorkspaces } from '../src/service.ts'
import type { WorkspacesService } from '../src/service.ts'
import type { CreatedWorktree } from '../src/worktrees.ts'
import { TOKEN_USER } from './fake-git-http.ts'
import { exists, filesHolding } from './onboard-helpers.ts'
import { run as runCommand, runOk, tempDir } from './helpers.ts'
import {
  APP_ID_NAME, PRIVATE_KEY_NAME, credentialsStub, crewStub, fakeTimers, projectOf, projectsStub, provideStub, startServiceWorld,
  useScratchProcess, watchLogs,
} from './service-helpers.ts'
import type { ServiceWorld } from './service-helpers.ts'

const scratch = useScratchProcess()

const widget = projectOf('acme/widget')
const gadget = projectOf('acme/gadget')
/** Shaped like an installation token (`ghs_` and 36 letters and digits); not one any fake minted. */
const LEAK = `ghs_${'Lk7Mn8Pq9R'.repeat(3)}St1Uv2`

interface Run {
  world: ServiceWorld
  ctx: Context
  logs: string[]
  projects: ReturnType<typeof projectsStub>
  service: WorkspacesService
  /** widget's clone, and its worktree fix-1 (made by the service). */
  clone: string
  worktree: CreatedWorktree
  /** The fake's repository for widget. */
  bare: string
  /** A scratch git in `cwd` (default the clone). Returns stdout, trimmed. */
  git(args: readonly string[], cwd?: string): Promise<string>
  /** Write `<name>.txt` in the worktree at `path`, add and commit it. Returns the new commit. */
  commit(path: string, name: string): Promise<string>
}

async function setup(options: { write?: boolean, gadget?: boolean, installation?: Readonly<Record<string, string>> } = {}): Promise<Run> {
  const world = await startServiceWorld({ write: options.write ?? true })
  if (options.installation !== undefined) world.github.installations.get('acme')!.permissions = options.installation
  const ctx = new Context()
  const logs = watchLogs(ctx, true)
  const projects = projectsStub()
  projects.add(widget)
  projects.add(gadget)
  await provideStub(ctx, 'dishProjects', projects.service)
  await provideStub(ctx, 'credentials', credentialsStub(world.credentials))
  await provideStub(ctx, 'dishCrew', crewStub().service)
  const service = createDishWorkspaces(ctx, { appIdName: APP_ID_NAME, privateKeyName: PRIVATE_KEY_NAME }, world.internals({ timers: fakeTimers() }))
  service.start()
  await service.onboard(widget)
  projects.set('acme/widget', 'ready')
  if (options.gadget === true) {
    await service.onboard(gadget)
    projects.set('acme/gadget', 'ready')
  }
  const clone = join(world.workRoot, 'acme', 'widget')
  const worktree = await service.createWorktree('acme/widget', 'fix-1', undefined, { cwd: clone })
  await service.idle()
  const git = async (args: readonly string[], cwd = clone): Promise<string> => (await runOk('git', args, { cwd, env: world.env })).trim()
  return {
    world, ctx, logs, projects, service, clone, worktree, bare: join(world.root, 'acme', 'widget.git'), git,
    async commit(path, name) {
      await writeFile(join(path, `${name}.txt`), `${name}\n`)
      await git(['add', `${name}.txt`], path)
      await git(['commit', '-q', '-m', name], path)
      return git(['rev-parse', 'HEAD'], path)
    },
  }
}

async function teardown(run: Run): Promise<void> {
  await run.service.close()
}

/** `refs/heads/<branch>` in the fake's repository `bare`, or undefined. */
async function bareTip(run: Run, branch = 'dish/fix-1', bare = run.bare): Promise<string | undefined> {
  const result = await runCommand('git', ['--git-dir', bare, 'rev-parse', '--verify', '-q', `refs/heads/${branch}`], { env: run.world.env })
  return result.code === 0 ? result.stdout.trim() : undefined
}

/** A commit made straight on GitHub's `branch` (as its "Update branch" button, or someone's own push, would): a scratch clone over file://. */
async function commitOnGitHub(run: Run, branch: string, name: string): Promise<string> {
  const work = join(await tempDir(), 'upstream')
  const env = run.world.env
  await runOk('git', ['clone', '-q', '--branch', branch, `file://${run.bare}`, work], { env })
  await writeFile(join(work, `${name}.txt`), `${name}\n`)
  await runOk('git', ['add', '-A'], { cwd: work, env })
  await runOk('git', ['commit', '-q', '-m', name], { cwd: work, env })
  await runOk('git', ['push', '-q', 'origin', `HEAD:refs/heads/${branch}`], { cwd: work, env })
  return (await runOk('git', ['rev-parse', 'HEAD'], { cwd: work, env })).trim()
}

/** The `push-*` directories under widget's state directory. */
async function pushDirs(run: Run): Promise<string[]> {
  return (await readdir(projectStateDir(run.world.state, 'acme', 'widget'))).filter(name => name.startsWith('push-'))
}

/** Every process's cmdline and environ that holds `needle`, and whether a git push was among the processes seen. */
async function processesHolding(needle: string): Promise<{ found: string[], pushing: boolean }> {
  const found: string[] = []
  let pushing = false
  for (const pid of await readdir('/proc')) {
    if (!/^\d+$/.test(pid)) continue
    for (const file of ['cmdline', 'environ']) {
      let data: Buffer
      try {
        data = await readFile(`/proc/${pid}/${file}`)
      } catch {
        continue
      }
      if (data.includes(needle)) found.push(`/proc/${pid}/${file}`)
      if (file === 'cmdline' && data.includes('--porcelain') && data.includes('push')) pushing = true
    }
  }
  return { found, pushing }
}

const settled = async (promise: Promise<unknown>, ms = 300): Promise<boolean> => {
  let done = false
  void promise.then(() => { done = true }, () => { done = true })
  await new Promise(resolve => setTimeout(resolve, ms))
  return done
}

/** The write tokens the fake minted, by what they may write. */
function written(run: Run, permission: 'contents' | 'pull_requests'): string[] {
  return run.world.github.minted.filter(mint => mint.permissions[permission] === 'write').map(mint => mint.token)
}

// --- headOf and isClean ----------------------------------------------------------------------------------------------

test("headOf gives the worktree's HEAD and follows a commit; undefined for a worktree dish didn't make", async () => {
  const run = await setup()
  try {
    assert.equal(await run.service.headOf('acme/widget/fix-1'), run.worktree.base)
    assert.equal(await run.service.headOf(run.worktree.path), run.worktree.base)
    assert.equal(run.worktree.baseRef, 'origin/main')
    const tip = await run.commit(run.worktree.path, 'one')
    assert.equal(await run.service.headOf('ACME/widget/fix-1'), tip)
    assert.equal(await run.service.headOf('acme/widget/nothing'), undefined)
    const hand = join(run.clone, '.worktrees', 'by-hand')
    await run.git(['worktree', 'add', '-q', '-b', 'by-hand', hand])
    assert.equal(await run.service.headOf(hand), undefined)
    assert.equal(await run.service.headOf('acme/widget/by-hand'), undefined)
  } finally {
    await teardown(run)
  }
})

test('isClean: clean; a modified or untracked file is not, with why; another branch checked out is not; an unknown worktree rejects', async () => {
  const run = await setup()
  const path = run.worktree.path
  try {
    assert.deepEqual(await run.service.isClean('acme/widget/fix-1'), { clean: true })
    await writeFile(join(path, 'README.md'), 'changed\n')
    const modified = await run.service.isClean(path)
    assert.equal(modified.clean, false)
    assert.match((modified as { why: string }).why, /README\.md/)
    await run.git(['checkout', '--', 'README.md'], path)
    await writeFile(join(path, 'new.txt'), 'new\n')
    const untracked = await run.service.isClean('acme/widget/fix-1')
    assert.equal(untracked.clean, false)
    assert.match((untracked as { why: string }).why, /new\.txt/)
    await rm(join(path, 'new.txt'))
    await run.git(['switch', '-q', '-c', 'other'], path)
    assert.deepEqual(await run.service.isClean('acme/widget/fix-1'), { clean: false, why: 'other, not dish/fix-1, is checked out' })
    await run.git(['switch', '-q', 'dish/fix-1'], path)
    assert.deepEqual(await run.service.isClean('acme/widget/fix-1'), { clean: true })
    await assert.rejects(run.service.isClean('acme/widget/nothing'), /^Error: no worktree acme\/widget\/nothing that dish made$/)
  } finally {
    await teardown(run)
  }
})

// --- pushBranch: the push itself -------------------------------------------------------------------------------------

test("pushBranch pushes dish/fix-1 at its tip to the project's URL with a write token: the bare repository's branch is the tip, it gives { head: tip } and logs created; the git server saw level write for git-receive-pack, user x-access-token", async () => {
  const run = await setup()
  try {
    const tip = await run.commit(run.worktree.path, 'one')
    const from = run.world.git.requests.length
    const minted = run.world.github.minted.length
    assert.deepEqual(await run.service.pushBranch('acme/widget', 'fix-1', { head: tip }), { head: tip })
    assert.equal(await bareTip(run), tip)
    assert.ok(run.logs.includes(`[dish-workspaces] info: pushed dish/fix-1 of acme/widget at ${tip.slice(0, 12)} (created)`), run.logs.join('\n'))
    const asked = run.world.git.requests.slice(from)
    const pushes = asked.filter(request => request.service === 'git-receive-pack' && request.level !== null)
    assert.ok(pushes.length >= 2, JSON.stringify(asked))
    assert.ok(pushes.every(request => request.level === 'write' && request.user === TOKEN_USER && request.status === 200), JSON.stringify(asked))
    assert.ok(asked.every(request => request.path.startsWith('/acme/widget.git/')), 'only the project\'s URL')
    // One write token, minted for this push: Contents write, for widget only.
    assert.deepEqual(run.world.github.minted.slice(minted).map(({ permissions, repositories }) => ({ permissions, repositories })), [
      { permissions: { contents: 'write', metadata: 'read' }, repositories: ['widget'] },
    ])
  } finally {
    await teardown(run)
  }
})

test('pushBranch again with nothing new logs up-to-date; after a commit, with the new head, it logs updated', async () => {
  const run = await setup()
  try {
    const one = await run.commit(run.worktree.path, 'one')
    await run.service.pushBranch('acme/widget', 'fix-1', { head: one })
    assert.deepEqual(await run.service.pushBranch('acme/widget', 'fix-1', { head: one }), { head: one })
    assert.ok(run.logs.includes(`[dish-workspaces] info: pushed dish/fix-1 of acme/widget at ${one.slice(0, 12)} (up-to-date)`), run.logs.join('\n'))
    const two = await run.commit(run.worktree.path, 'two')
    assert.deepEqual(await run.service.pushBranch('ACME/Widget', 'fix-1', { head: two }), { head: two })
    assert.ok(run.logs.includes(`[dish-workspaces] info: pushed dish/fix-1 of acme/widget at ${two.slice(0, 12)} (updated)`), run.logs.join('\n'))
    assert.equal(await bareTip(run), two)
  } finally {
    await teardown(run)
  }
})

test("pushBranch with a head the branch isn't at refuses, and pushes nothing (the bare repository is unchanged)", async () => {
  const run = await setup()
  try {
    const one = await run.commit(run.worktree.path, 'one')
    await run.service.pushBranch('acme/widget', 'fix-1', { head: one })
    const two = await run.commit(run.worktree.path, 'two')
    const minted = run.world.github.minted.length
    await assert.rejects(run.service.pushBranch('acme/widget', 'fix-1', { head: one }),
      new RegExp(`^Error: dish/fix-1 is at ${two}, not ${one} \\(the commit the checks ran on\\); nothing was pushed$`))
    assert.equal(await bareTip(run), one)
    assert.equal(run.world.github.minted.length, minted, 'no token was minted')
  } finally {
    await teardown(run)
  }
})

test('pushBranch without a head, or with a 12-digit one, refuses before a token is minted', async () => {
  const run = await setup()
  try {
    const tip = await run.commit(run.worktree.path, 'one')
    const minted = run.world.github.minted.length
    for (const head of [undefined, '', tip.slice(0, 12), tip.toUpperCase(), `${tip}\n`, 42]) {
      await assert.rejects(run.service.pushBranch('acme/widget', 'fix-1', { head } as unknown as { head: string }),
        /^Error: head must be a full commit id: the commit open_pr checked$/, JSON.stringify(head))
    }
    await assert.rejects(run.service.pushBranch('acme/widget', 'fix-1', undefined as unknown as { head: string }), /head must be a full commit id/)
    assert.equal(run.world.github.minted.length, minted)
    assert.equal(await bareTip(run), undefined)
  } finally {
    await teardown(run)
  }
})

test("pushBranch refuses a project that isn't registered or ready, a slug dish didn't make, and a worktree whose clone fails dish's check (resolveProblem's reason)", async () => {
  const run = await setup()
  try {
    const tip = await run.commit(run.worktree.path, 'one')
    const minted = run.world.github.minted.length
    await assert.rejects(run.service.pushBranch('acme/nothing', 'fix-1', { head: tip }), /no project acme\/nothing in projects\.yaml/)
    await assert.rejects(run.service.pushBranch('acme/gadget', 'fix-1', { head: tip }), /^Error: acme\/gadget isn't ready \(pending\); see Settings → Projects$/)
    await assert.rejects(run.service.pushBranch('acme/widget', 'nothing', { head: tip }),
      /^Error: no worktree acme\/widget\/nothing that dish made; dish pushes only the dish\/<slug> branch of a worktree it made$/)
    await assert.rejects(run.service.pushBranch('acme/widget', 'Fix 1', { head: tip }), /can't name a worktree/)
    // A worktree made by hand, on a branch named like dish's: not dish's.
    await run.git(['worktree', 'add', '-q', '-b', 'dish/by-hand', join(run.clone, '.worktrees', 'by-hand')])
    await assert.rejects(run.service.pushBranch('acme/widget', 'by-hand', { head: tip }), /no worktree acme\/widget\/by-hand that dish made/)
    // A clone that fails dish's check.
    await run.git(['config', 'core.pager', 'less'])
    await assert.rejects(run.service.pushBranch('acme/widget', 'fix-1', { head: tip }),
      new RegExp(`^Error: acme/widget/fix-1 can't be pushed: acme/widget's clone \\(${run.clone}\\) failed dish's safety check: \\.git/config sets core\\.pager, which dish doesn't allow$`))
    await run.git(['config', '--unset', 'core.pager'])
    run.projects.set('acme/widget', 'failed')
    await assert.rejects(run.service.pushBranch('acme/widget', 'fix-1', { head: tip }), /acme\/widget isn't ready \(failed\)/)
    assert.equal(run.world.github.minted.length, minted)
    assert.equal(await bareTip(run), undefined)
    assert.equal(await bareTip(run, 'dish/by-hand'), undefined)
  } finally {
    await teardown(run)
  }
})

// --- pushBranch: what can't steer it ---------------------------------------------------------------------------------

test("pushBranch never pushes to origin: a remote.origin.pushurl in the clone's config, and an insteadOf for the fake's origin in the global .gitconfig, change nothing", async () => {
  const run = await setup()
  const global = join(scratch.home(), '.gitconfig')
  const saved = await readFile(global, 'utf8')
  try {
    const widgetUrl = `${run.world.git.origin}/acme/widget.git`
    const gadgetUrl = `${run.world.git.origin}/acme/gadget.git`
    const gadgetBare = join(run.world.root, 'acme', 'gadget.git')
    const tip = await run.commit(run.worktree.path, 'one')
    await run.git(['config', 'remote.origin.pushurl', gadgetUrl])
    await writeFile(global, `${saved}[url "${gadgetUrl}"]\n\tinsteadOf = ${widgetUrl}\n\tpushInsteadOf = ${widgetUrl}\n`)
    // The fixture: git with that global config does send widget's URL to gadget.
    const asDish = { ...run.world.env, HOME: scratch.home(), GIT_CONFIG_GLOBAL: global }
    assert.equal((await runOk('git', ['-C', run.clone, 'ls-remote', '--get-url', 'origin'], { env: asDish })).trim(), gadgetUrl)

    assert.deepEqual(await run.service.pushBranch('acme/widget', 'fix-1', { head: tip }), { head: tip })
    assert.equal(await bareTip(run), tip)
    assert.equal(await bareTip(run, 'dish/fix-1', gadgetBare), undefined)
    assert.ok(!run.world.git.requests.some(request => request.path.startsWith('/acme/gadget.git/') && request.service === 'git-receive-pack'))
  } finally {
    await writeFile(global, saved)
    await teardown(run)
  }
})

test("the clone's own helper isn't used: its read token file is there, and the push still went with the write token", async () => {
  const run = await setup()
  try {
    const tokenFile = join(tokensDir(run.world.state), 'acme')
    const read = (await readFile(tokenFile, 'utf8')).trim()
    assert.equal(run.world.git.tokens.get(read), 'read')
    const tip = await run.commit(run.worktree.path, 'one')
    const from = run.world.git.requests.length
    await run.service.pushBranch('acme/widget', 'fix-1', { head: tip })
    const levels = run.world.git.requests.slice(from).filter(request => request.level !== null).map(request => request.level)
    assert.ok(levels.length > 0 && levels.every(level => level === 'write'), JSON.stringify(levels))
    assert.equal(await bareTip(run), tip)
    assert.ok(await exists(tokenFile))
  } finally {
    await teardown(run)
  }
})

// --- pushBranch: refusals --------------------------------------------------------------------------------------------

test("a rejected push fails with GitHub's reason: the branch moved on the bare repository (fetch first, dish never forces), and a pre-receive hook's refusal with its remote: lines", async () => {
  const run = await setup()
  try {
    const one = await run.commit(run.worktree.path, 'one')
    await run.service.pushBranch('acme/widget', 'fix-1', { head: one })
    const moved = await commitOnGitHub(run, 'dish/fix-1', 'update-branch')
    const two = await run.commit(run.worktree.path, 'two')
    await assert.rejects(run.service.pushBranch('acme/widget', 'fix-1', { head: two }), (error: Error) => {
      assert.equal(error.message, 'GitHub refused the push of dish/fix-1: [rejected] (fetch first). The branch on GitHub has commits this one '
        + "doesn't: have a coder merge `origin/dish/fix-1` into the run's worktree, then call `open_pr` again. dish never forces a push.")
      return true
    })
    assert.equal(await bareTip(run), moved, 'nothing was forced')

    const hook = join(run.bare, 'hooks', 'pre-receive')
    await writeFile(hook, '#!/bin/sh\necho "no pushes on Fridays"\necho "ask again on Monday"\nexit 1\n')
    await chmod(hook, 0o755)
    const fix2 = await run.service.createWorktree('acme/widget', 'fix-2', undefined, { cwd: run.clone })
    const three = await run.commit(fix2.path, 'three')
    await assert.rejects(run.service.pushBranch('acme/widget', 'fix-2', { head: three }),
      /^Error: GitHub refused the push of dish\/fix-2: \[remote rejected\] \(pre-receive hook declined\) — no pushes on Fridays ask again on Monday$/)
    assert.equal(await bareTip(run, 'dish/fix-2'), undefined)
    for (const line of run.logs) assert.ok(!line.includes('ghs_'), line)
  } finally {
    await teardown(run)
  }
})

test('an App without Contents write: the token request is 422, and the error says the App needs Contents read and write', async () => {
  const run = await setup({ write: false })
  try {
    const tip = await run.commit(run.worktree.path, 'one')
    const error = await run.service.pushBranch('acme/widget', 'fix-1', { head: tip }).catch((e: unknown) => e)
    assert.ok(error instanceof Error)
    assert.match(error.message, /^dish couldn't get a write token for acme\/widget: .*HTTP 422.*\. The dish App needs Contents read and write, and each installation must accept it \(Settings → GitHub App\)$/)
    assert.ok(!error.message.includes('ghs_'))
    assert.equal(await bareTip(run), undefined)
    assert.deepEqual(await pushDirs(run), [])
  } finally {
    await teardown(run)
  }
})

// --- pushBranch: the token and the lock ------------------------------------------------------------------------------

test("while the push is held at the fake, no process's cmdline or environ holds the write token; after it, no file under the world's directory does, and no log line does", async () => {
  const run = await setup()
  try {
    const tip = await run.commit(run.worktree.path, 'one')
    const held = run.world.git.hold('git-receive-pack')
    const push = run.service.pushBranch('acme/widget', 'fix-1', { head: tip })
    // Handled now, so a failing assertion below reads as itself, not as the push that teardown aborts.
    push.catch(() => {})
    await held.reached
    const [token] = written(run, 'contents')
    assert.ok(token !== undefined && token.startsWith('ghs_'))
    const seen = await processesHolding(token)
    assert.ok(seen.pushing, 'the push was running while /proc was read')
    assert.deepEqual(seen.found, [])
    held.release()
    assert.deepEqual(await push, { head: tip })
    assert.deepEqual(await filesHolding(run.world.dir, token), [])
    for (const line of run.logs) assert.ok(!line.includes(token) && !line.includes('ghs_'), line)
    assert.ok(!JSON.stringify(run.world.git.requests).includes(token))
  } finally {
    await teardown(run)
  }
})

test("pushBranch runs under the project's lock: a createWorktree of the project waits for a held push; another project's doesn't", async () => {
  const run = await setup({ gadget: true })
  try {
    const tip = await run.commit(run.worktree.path, 'one')
    const held = run.world.git.hold('git-receive-pack')
    const push = run.service.pushBranch('acme/widget', 'fix-1', { head: tip })
    // Handled now, so a failing assertion below reads as itself, not as the push that teardown aborts.
    push.catch(() => {})
    await held.reached
    const waiting = run.service.createWorktree('acme/widget', 'fix-2', undefined, { cwd: run.clone })
    const gadgetClone = join(run.world.workRoot, 'acme', 'gadget')
    await run.service.createWorktree('acme/gadget', 'other', undefined, { cwd: gadgetClone })
    assert.equal(await settled(waiting), false, 'widget\'s create waits for the push')
    held.release()
    await push
    assert.equal((await waiting).slug, 'fix-2')
  } finally {
    await teardown(run)
  }
})

test('no push-* directory is left after a success, a failure and close() mid-push (an AbortError)', async () => {
  const run = await setup()
  try {
    const one = await run.commit(run.worktree.path, 'one')
    await run.service.pushBranch('acme/widget', 'fix-1', { head: one })
    assert.deepEqual(await pushDirs(run), [])
    await commitOnGitHub(run, 'dish/fix-1', 'moved')
    const two = await run.commit(run.worktree.path, 'two')
    await assert.rejects(run.service.pushBranch('acme/widget', 'fix-1', { head: two }), /fetch first/)
    assert.deepEqual(await pushDirs(run), [])

    const fix2 = await run.service.createWorktree('acme/widget', 'fix-2', undefined, { cwd: run.clone })
    const three = await run.commit(fix2.path, 'three')
    const held = run.world.git.hold('git-receive-pack')
    const push = run.service.pushBranch('acme/widget', 'fix-2', { head: three })
    const rejected = assert.rejects(push, (error: Error) => error.name === 'AbortError')
    await held.reached
    assert.equal((await pushDirs(run)).length, 1, 'the isolated repository, while the push runs')
    await run.service.close()
    await rejected
    assert.deepEqual(await pushDirs(run), [])
    held.release()
  } finally {
    await teardown(run)
  }
})

// --- openPull --------------------------------------------------------------------------------------------------------

test('openPull opens a pull request from dish/fix-1 to main with the title and body masked (a ghs_ token in each), and gives its URL and number', async () => {
  const run = await setup()
  try {
    const opened = await run.service.openPull('acme/widget', {
      head: 'dish/fix-1', title: `Fix it\n(${LEAK})`, body: `Why: ${LEAK}\nSee https://someone:p4ssw0rd@example.com/x\x00.\n`,
    })
    assert.deepEqual(opened, { url: 'https://github.com/acme/widget/pull/1', number: 1, existing: false })
    assert.equal(run.world.github.pullRequests.length, 1)
    const pull = run.world.github.pullRequests[0]!
    assert.deepEqual([pull.repo, pull.head, pull.base, pull.state], ['acme/widget', 'dish/fix-1', 'main', 'open'])
    assert.ok(pull.title.startsWith('Fix it ('), pull.title)
    assert.ok(!pull.title.includes('\n'))
    for (const text of [pull.title, pull.body]) {
      assert.ok(!text.includes(LEAK) && !text.includes('p4ssw0rd') && !text.includes('\x00'), text)
    }
    assert.match(pull.body, /^Why: ‹secret: a GitHub token›\nSee https:\/\/someone:\*\*\*@example\.com\/x\.\n$/)
    assert.deepEqual(run.world.github.minted.filter(mint => mint.permissions.pull_requests === 'write').map(({ permissions, repositories }) => ({ permissions, repositories })),
      [{ permissions: { metadata: 'read', pull_requests: 'write' }, repositories: ['widget'] }])
  } finally {
    await teardown(run)
  }
})

test('openPull for a branch with an open pull request reports it, existing, opens no second one, and leaves its title and body as they were', async () => {
  const run = await setup()
  try {
    await run.service.openPull('acme/widget', { head: 'dish/fix-1', title: 'First', body: 'First body' })
    const again = await run.service.openPull('acme/widget', { head: 'dish/fix-1', title: 'Second', body: 'Second body' })
    assert.deepEqual(again, { url: 'https://github.com/acme/widget/pull/1', number: 1, existing: true })
    assert.equal(run.world.github.pullRequests.length, 1)
    assert.equal(run.world.github.pullRequests[0]!.title, 'First')
    assert.equal(run.world.github.pullRequests[0]!.body, 'First body')
    assert.deepEqual(run.world.github.pullEdits, [])
    assert.deepEqual(run.world.github.comments, [])
    // Closed on GitHub: a new one is opened.
    run.world.github.pullRequests[0]!.state = 'closed'
    assert.deepEqual(await run.service.openPull('acme/widget', { head: 'dish/fix-1', title: 'Third', body: '' }), { url: 'https://github.com/acme/widget/pull/2', number: 2, existing: false })
  } finally {
    await teardown(run)
  }
})

test("openPull refuses a head that isn't a dish worktree's branch, an empty title, a 257-character title and a 65 537-character body, before minting a token", async () => {
  const run = await setup()
  try {
    await run.git(['worktree', 'add', '-q', '-b', 'dish/by-hand', join(run.clone, '.worktrees', 'by-hand')])
    const minted = run.world.github.minted.length
    for (const head of ['main', 'dish/nothing', 'dish/Fix-1', 'feature/fix-1', 'dish/by-hand', '', 'refs/heads/dish/fix-1', undefined]) {
      await assert.rejects(run.service.openPull('acme/widget', { head, title: 'x', body: '' } as { head: string, title: string, body: string }),
        /^Error: dish opens pull requests only from the dish\/<slug> branch of a worktree it made$/, String(head))
    }
    const head = 'dish/fix-1'
    for (const title of ['', '  \n\t ', undefined]) {
      await assert.rejects(run.service.openPull('acme/widget', { head, title, body: '' } as { head: string, title: string, body: string }), /^Error: a pull request needs a title$/)
    }
    await assert.rejects(run.service.openPull('acme/widget', { head, title: 'x'.repeat(257), body: '' }), /^Error: the title is 257 characters; GitHub takes at most 256$/)
    await assert.rejects(run.service.openPull('acme/widget', { head, title: 'x', body: 'y'.repeat(65_537) }), /^Error: the body is 65537 characters; GitHub takes at most 65 536$/)
    await assert.rejects(run.service.openPull('acme/nothing', { head, title: 'x', body: '' }), /no project acme\/nothing/)
    await assert.rejects(run.service.openPull('acme/gadget', { head, title: 'x', body: '' }), /acme\/gadget isn't ready/)
    assert.equal(run.world.github.minted.length, minted)
    assert.deepEqual(run.world.github.pullRequests, [])
  } finally {
    await teardown(run)
  }
})

test("openPull with an App without Pull requests write fails with GitHub's message, and no token in it", async () => {
  const run = await setup({ write: false })
  try {
    const error = await run.service.openPull('acme/widget', { head: 'dish/fix-1', title: 'x', body: '' }).catch((e: unknown) => e)
    assert.ok(error instanceof Error)
    assert.match(error.message, /The permissions requested are not granted to this installation.*The dish App needs Pull requests read and write/)
    for (const { token } of run.world.github.minted) assert.ok(!error.message.includes(token) && !String(error.stack).includes(token))
    // An App with the permission whose installation lacks the repository's pull requests: GitHub's 403, named.
    run.world.github.failNext('/repos/acme/widget/pulls', 403, { message: 'Resource not accessible by integration' })
    assert.deepEqual(run.world.github.pullRequests, [])
  } finally {
    await teardown(run)
  }
})

test("openPull's failure from GitHub after the token names the head and GitHub's reason, masked", async () => {
  const run = await setup()
  try {
    run.world.github.failNext('/repos/acme/widget/pulls', 422, { message: 'Validation Failed', errors: [{ message: `No commits between main and dish/fix-1 ${LEAK}` }] })
    const error = await run.service.openPull('acme/widget', { head: 'dish/fix-1', title: 'x', body: '' }).catch((e: unknown) => e)
    assert.ok(error instanceof Error)
    assert.match(error.message, /^could not open the pull request for dish\/fix-1: POST \/repos\/acme\/widget\/pulls answered HTTP 422: Validation Failed \(No commits between main and dish\/fix-1 ‹secret: a GitHub token›\)$/)
    run.world.github.failNext('/repos/acme/widget/pulls', 403, { message: 'Resource not accessible by integration' })
    await assert.rejects(run.service.openPull('acme/widget', { head: 'dish/fix-1', title: 'x', body: '' }),
      /^Error: could not open the pull request for dish\/fix-1: POST \/repos\/acme\/widget\/pulls answered HTTP 403: Resource not accessible by integration$/)
  } finally {
    await teardown(run)
  }
})

// --- commentPull -----------------------------------------------------------------------------------------------------

test("commentPull posts the body, masked (a ghs_ token in it), as a comment on the pull request's issue", async () => {
  const run = await setup()
  try {
    await run.service.openPull('acme/widget', { head: 'dish/fix-1', title: 'Fix', body: 'Body' })
    await run.service.commentPull('acme/widget', 1, `⚠ dish: opened past a failing gate. Ruling: ${LEAK} — fine\x00`)
    assert.deepEqual(run.world.github.comments, [{ repo: 'acme/widget', number: 1, body: '⚠ dish: opened past a failing gate. Ruling: ‹secret: a GitHub token› — fine' }])
    assert.equal(run.world.github.pullRequests[0]!.body, 'Body', 'the body is left alone')
  } finally {
    await teardown(run)
  }
})

test('commentPull refuses a blank body, a 65 537-character body and a number that isn\'t a positive whole number, before minting a token', async () => {
  const run = await setup()
  try {
    await run.service.openPull('acme/widget', { head: 'dish/fix-1', title: 'Fix', body: '' })
    const minted = run.world.github.minted.length
    for (const body of ['', '  \n ', undefined]) {
      await assert.rejects(run.service.commentPull('acme/widget', 1, body as unknown as string), /^Error: a comment needs a body$/)
    }
    await assert.rejects(run.service.commentPull('acme/widget', 1, 'z'.repeat(65_537)), /^Error: the comment is 65537 characters; GitHub takes at most 65 536$/)
    for (const number of [0, -1, 1.5, Number.NaN, 2 ** 31, '1' as unknown as number]) {
      await assert.rejects(run.service.commentPull('acme/widget', number, 'x'), /^Error: a pull request number is a positive whole number$/, String(number))
    }
    await assert.rejects(run.service.commentPull('acme/gadget', 1, 'x'), /acme\/gadget isn't ready/)
    assert.equal(run.world.github.minted.length, minted)
    assert.deepEqual(run.world.github.comments, [])
  } finally {
    await teardown(run)
  }
})

test("commentPull on a pull request GitHub doesn't have fails with GitHub's message", async () => {
  const run = await setup()
  try {
    await assert.rejects(run.service.commentPull('acme/widget', 9, 'x'),
      /^Error: could not comment on pull request #9: POST \/repos\/acme\/widget\/issues\/9\/comments answered HTTP 404: Not Found$/)
  } finally {
    await teardown(run)
  }
})

// --- updatePull ------------------------------------------------------------------------------------------------------

test("updatePull sends only the title, only the body, or both, masked (a ghs_ token in each); the fake's pullEdits show it", async () => {
  const run = await setup()
  try {
    await run.service.openPull('acme/widget', { head: 'dish/fix-1', title: 'Fix', body: 'Body' })
    await run.service.updatePull('acme/widget', 1, { title: `New\ntitle ${LEAK}` })
    await run.service.updatePull('acme/widget', 1, { body: `New body ${LEAK}` })
    await run.service.updatePull('acme/widget', 1, { title: 'Both', body: '' })
    assert.deepEqual(run.world.github.pullEdits, [
      { repo: 'acme/widget', number: 1, title: 'New title ‹secret: a GitHub token›' },
      { repo: 'acme/widget', number: 1, body: 'New body ‹secret: a GitHub token›' },
      { repo: 'acme/widget', number: 1, title: 'Both', body: '' },
    ])
    assert.deepEqual(run.world.github.comments, [])
  } finally {
    await teardown(run)
  }
})

test('updatePull refuses neither field, an empty title, a 257-character title and a 65 537-character body, before minting a token', async () => {
  const run = await setup()
  try {
    await run.service.openPull('acme/widget', { head: 'dish/fix-1', title: 'Fix', body: 'Body' })
    const minted = run.world.github.minted.length
    await assert.rejects(run.service.updatePull('acme/widget', 1, {}), /^Error: updatePull needs a title or a body$/)
    await assert.rejects(run.service.updatePull('acme/widget', 1, undefined as unknown as object), /updatePull needs a title or a body/)
    await assert.rejects(run.service.updatePull('acme/widget', 1, { title: ' ' }), /^Error: a pull request needs a title$/)
    await assert.rejects(run.service.updatePull('acme/widget', 1, { title: 'x'.repeat(257) }), /^Error: the title is 257 characters; GitHub takes at most 256$/)
    await assert.rejects(run.service.updatePull('acme/widget', 1, { body: 'y'.repeat(65_537) }), /^Error: the body is 65537 characters; GitHub takes at most 65 536$/)
    await assert.rejects(run.service.updatePull('acme/widget', 0, { title: 'x' }), /a pull request number is a positive whole number/)
    assert.equal(run.world.github.minted.length, minted)
    assert.deepEqual(run.world.github.pullEdits, [])
  } finally {
    await teardown(run)
  }
})

test("updatePull with an App without Pull requests write fails with GitHub's message, and no token in it", async () => {
  const run = await setup({ write: false })
  try {
    const error = await run.service.updatePull('acme/widget', 1, { title: 'x' }).catch((e: unknown) => e)
    assert.ok(error instanceof Error)
    assert.match(error.message, /HTTP 422: The permissions requested are not granted to this installation.*The dish App needs Pull requests read and write/)
    for (const { token } of run.world.github.minted) assert.ok(!error.message.includes(token))
    assert.deepEqual(run.world.github.pullEdits, [])
  } finally {
    await teardown(run)
  }
})

// --- compareBranch ---------------------------------------------------------------------------------------------------

test("compareBranch after a push: 0 behind, the branch's commits ahead, remoteAhead 0", async () => {
  const run = await setup()
  try {
    await run.commit(run.worktree.path, 'one')
    const two = await run.commit(run.worktree.path, 'two')
    await run.service.pushBranch('acme/widget', 'fix-1', { head: two })
    assert.deepEqual(await run.service.compareBranch('acme/widget', 'fix-1'), { behindDefault: 0, aheadOfDefault: 2, remoteAhead: 0 })
  } finally {
    await teardown(run)
  }
})

test('before any push of dish/fix-1, remoteAhead is null', async () => {
  const run = await setup()
  try {
    await run.commit(run.worktree.path, 'one')
    assert.deepEqual(await run.service.compareBranch('acme/widget', 'fix-1'), { behindDefault: 0, aheadOfDefault: 1, remoteAhead: null })
  } finally {
    await teardown(run)
  }
})

test("a commit to main on the bare repository makes it 1 behind; a commit pushed to the bare repository's dish/fix-1 (as GitHub's \"Update branch\" would) makes remoteAhead 1; a merge of both in the worktree, committed, brings them to 0", async () => {
  const run = await setup()
  try {
    const one = await run.commit(run.worktree.path, 'one')
    await run.service.pushBranch('acme/widget', 'fix-1', { head: one })
    await commitOnGitHub(run, 'main', 'on-main')
    assert.deepEqual(await run.service.compareBranch('acme/widget', 'fix-1'), { behindDefault: 1, aheadOfDefault: 1, remoteAhead: 0 })
    await commitOnGitHub(run, 'dish/fix-1', 'on-branch')
    assert.deepEqual(await run.service.compareBranch('acme/widget', 'fix-1'), { behindDefault: 1, aheadOfDefault: 1, remoteAhead: 1 })
    // The coder's way: merge origin/main, and GitHub's branch, never a rebase.
    await run.git(['merge', '-q', '--no-edit', 'origin/main'], run.worktree.path)
    await run.git(['merge', '-q', '--no-edit', 'origin/dish/fix-1'], run.worktree.path)
    const merged = await run.service.compareBranch('acme/widget', 'fix-1')
    assert.equal(merged.behindDefault, 0)
    assert.equal(merged.remoteAhead, 0)
    assert.ok(merged.aheadOfDefault >= 3, JSON.stringify(merged))
    // Read-only on the worktree: nothing is merged or checked out by compareBranch itself.
    assert.deepEqual(await run.service.isClean('acme/widget/fix-1'), { clean: true })
    // And it pushes, with no force.
    const head = (await run.service.headOf('acme/widget/fix-1'))!
    assert.deepEqual(await run.service.pushBranch('acme/widget', 'fix-1', { head }), { head })
    assert.deepEqual(await run.service.compareBranch('acme/widget', 'fix-1'), { ...merged, remoteAhead: 0 })
  } finally {
    await teardown(run)
  }
})

test("compareBranch fetches (lastFetch is recorded) under the project's lock: a held push of the project holds it, another project's doesn't", async () => {
  const run = await setup({ gadget: true })
  try {
    const gadgetClone = join(run.world.workRoot, 'acme', 'gadget')
    await run.service.createWorktree('acme/gadget', 'other', undefined, { cwd: gadgetClone })
    await run.service.idle()
    const before = run.service.describe('acme/widget')!.lastFetch!.at
    await new Promise(resolve => setTimeout(resolve, 5))
    await run.service.compareBranch('acme/widget', 'fix-1')
    assert.ok(run.service.describe('acme/widget')!.lastFetch!.at > before)
    assert.equal(run.service.describe('acme/widget')!.lastFetch!.ok, true)

    const tip = await run.commit(run.worktree.path, 'one')
    const held = run.world.git.hold('git-receive-pack')
    const push = run.service.pushBranch('acme/widget', 'fix-1', { head: tip })
    // Handled now, so a failing assertion below reads as itself, not as the push that teardown aborts.
    push.catch(() => {})
    await held.reached
    const waiting = run.service.compareBranch('acme/widget', 'fix-1')
    assert.deepEqual(await run.service.compareBranch('acme/gadget', 'other'), { behindDefault: 0, aheadOfDefault: 0, remoteAhead: null })
    assert.equal(await settled(waiting), false, 'widget\'s compare waits for the push')
    held.release()
    await push
    assert.deepEqual(await waiting, { behindDefault: 0, aheadOfDefault: 1, remoteAhead: 0 })
  } finally {
    await teardown(run)
  }
})

test("compareBranch: an unknown slug, a project that isn't ready, and a fetch that fails reject, masked", async () => {
  const run = await setup()
  try {
    await assert.rejects(run.service.compareBranch('acme/widget', 'nothing'), /^Error: no worktree acme\/widget\/nothing that dish made$/)
    await assert.rejects(run.service.compareBranch('acme/widget', '../x'), /can't name a worktree/)
    await assert.rejects(run.service.compareBranch('acme/gadget', 'fix-1'), /acme\/gadget isn't ready \(pending\)/)
    await rename(run.bare, `${run.bare}.gone`)
    const error = await run.service.compareBranch('acme/widget', 'fix-1').catch((e: unknown) => e)
    assert.ok(error instanceof Error)
    assert.match(error.message, /git fetch failed/)
    assert.ok(!error.message.includes('ghs_'))
    assert.equal(run.service.describe('acme/widget')!.lastFetch!.ok, false)
    await rename(`${run.bare}.gone`, run.bare)
  } finally {
    await teardown(run)
  }
})

// --- readPull --------------------------------------------------------------------------------------------------------

const HEAD_SHA = 'c'.repeat(40)

/** widget's pull request #1, opened, with its head at HEAD_SHA, mergeable, and feedback of each kind. */
async function withFeedback(run: Run): Promise<void> {
  await run.service.openPull('acme/widget', { head: 'dish/fix-1', title: 'Fix it', body: 'Body' })
  Object.assign(run.world.github.pullRequests[0]!, { headSha: HEAD_SHA, mergeable: false, mergeableState: 'dirty' })
  run.world.github.feedback('acme/widget', 1, {
    reviews: [
      { id: 1, user: { login: 'ann' }, state: 'CHANGES_REQUESTED', body: 'Please split this.', submitted_at: '2026-10-03T10:00:00Z', commit_id: HEAD_SHA },
      { id: 2, user: null, state: 'COMMENTED', body: null, submitted_at: null, commit_id: null },
    ],
    reviewComments: [
      { id: 10, path: 'src/a.ts', line: 12, user: { login: 'ann' }, body: 'Off by one.', created_at: '2026-10-03T10:01:00Z' },
      { id: 11, path: 'src/b.ts', line: null, user: { login: 'bob' }, body: 'Old remark.', created_at: '2026-10-02T09:00:00Z' },
    ],
    issueComments: [{ id: 20, user: { login: 'carol' }, body: 'LGTM once CI passes', created_at: '2026-10-03T11:00:00Z' }],
  })
  run.world.github.checks('acme/widget', HEAD_SHA, {
    checkRuns: [{ name: 'ci / test', status: 'completed', conclusion: 'failure' }, { name: 'ci / lint', status: 'in_progress', conclusion: null }],
    statuses: [{ context: 'deploy/preview', state: 'pending' }, { context: 'coverage', state: 'success' }],
  })
}

test("readPull gives the pull request's state, mergeability, reviews, review comments (one outdated), issue comments, check runs and statuses as the fake holds them", async () => {
  const run = await setup()
  try {
    await withFeedback(run)
    const comments = run.world.github.comments.length
    assert.deepEqual(await run.service.readPull('acme/widget', 1), {
      number: 1, url: 'https://github.com/acme/widget/pull/1', title: 'Fix it', state: 'open', merged: false, draft: false,
      mergeable: false, mergeableState: 'dirty', head: { ref: 'dish/fix-1', sha: HEAD_SHA }, base: { ref: 'main' },
      reviews: [
        { author: 'ann', state: 'CHANGES_REQUESTED', body: 'Please split this.', at: '2026-10-03T10:00:00Z', commit: HEAD_SHA },
        { author: 'unknown', state: 'COMMENTED', body: '', at: null, commit: null },
      ],
      reviewComments: [
        { path: 'src/a.ts', line: 12, author: 'ann', body: 'Off by one.', outdated: false, at: '2026-10-03T10:01:00Z' },
        { path: 'src/b.ts', line: null, author: 'bob', body: 'Old remark.', outdated: true, at: '2026-10-02T09:00:00Z' },
      ],
      issueComments: [{ author: 'carol', body: 'LGTM once CI passes', at: '2026-10-03T11:00:00Z' }],
      checks: [
        { name: 'ci / test', source: 'check-run', status: 'completed', conclusion: 'failure' },
        { name: 'ci / lint', source: 'check-run', status: 'in_progress', conclusion: null },
        { name: 'deploy/preview', source: 'status', status: 'pending', conclusion: null },
        { name: 'coverage', source: 'status', status: 'completed', conclusion: 'success' },
      ],
      more: { reviews: false, reviewComments: false, issueComments: false, checks: false },
    })
    // With the in-memory API token (read only), and nothing changed on GitHub.
    const reads = run.world.github.requests.filter(request => request.path.startsWith('/repos/acme/widget/pulls/1') || request.path.includes('/issues/1/') || request.path.includes(`/commits/${HEAD_SHA}/`))
    assert.ok(reads.length >= 6 && reads.every(request => request.method === 'GET' && request.auth === 'token'), JSON.stringify(reads))
    const api = run.world.github.minted.at(-1)!
    assert.deepEqual(api.permissions, { metadata: 'read', pull_requests: 'read', checks: 'read', statuses: 'read' })
    assert.equal(run.world.github.comments.length, comments)
    assert.deepEqual(run.world.github.pullEdits, [])
    // Nothing of the content is logged.
    for (const line of run.logs) assert.ok(!line.includes('Please split') && !line.includes('Off by one'), line)
  } finally {
    await teardown(run)
  }
})

test("readPull: a ghs_ token and a URL password in a review's body are masked; a 5000-character body is cut to 4000; control characters become spaces; a PENDING review and a malformed comment are skipped", async () => {
  const run = await setup()
  try {
    await run.service.openPull('acme/widget', { head: 'dish/fix-1', title: 'Fix', body: '' })
    Object.assign(run.world.github.pullRequests[0]!, { headSha: HEAD_SHA, title: `Fix ${LEAK}\x1b[31m` })
    run.world.github.feedback('acme/widget', 1, {
      reviews: [
        { user: { login: 'ann' }, state: 'COMMENTED', body: `token ${LEAK}\nurl https://u:s3cret@example.com/x\tend\r\x07bell` },
        { user: { login: 'mallory' }, state: 'PENDING', body: 'my unsent draft' },
        { user: { login: 'dan' }, state: 'COMMENTED', body: 'z'.repeat(5_000) },
        { user: { login: 'eve' }, body: 'no state' },
        'not an object',
      ],
      reviewComments: [{ path: 'a.ts', line: 1, user: { login: `x${'y'.repeat(300)}` }, body: 'ok' }, { path: 42, body: 'bad path' }, { path: 'b.ts', body: 7 }],
      issueComments: [{ user: { login: 'carol' } }, { user: { login: 'carol' }, body: 'kept' }],
    })
    run.world.github.checks('acme/widget', HEAD_SHA, { checkRuns: [{ name: 'ci', status: 'completed', conclusion: 5 }, { status: 'queued' }], statuses: [{ context: 'x' }] })
    const feedback = await run.service.readPull('acme/widget', 1)
    assert.ok(!feedback.title.includes(LEAK) && !feedback.title.includes('\x1b'), feedback.title)
    assert.deepEqual(feedback.reviews.map(review => review.author), ['ann', 'dan'])
    const body = feedback.reviews[0]!.body
    assert.ok(!body.includes(LEAK) && !body.includes('s3cret'), body)
    assert.equal(body, 'token ‹secret: a GitHub token›\nurl https://u:***@example.com/x\tend  bell')
    assert.equal(Array.from(feedback.reviews[1]!.body).length, 4000)
    assert.ok(feedback.reviews[1]!.body.endsWith('…'))
    assert.ok(!JSON.stringify(feedback).includes('my unsent draft'))
    assert.deepEqual(feedback.reviewComments.map(comment => comment.path), ['a.ts'])
    assert.equal(Array.from(feedback.reviewComments[0]!.author).length, 200)
    assert.deepEqual(feedback.issueComments, [{ author: 'carol', body: 'kept', at: null }])
    assert.deepEqual(feedback.checks, [])
  } finally {
    await teardown(run)
  }
})

test('readPull: with 100 review comments, more.reviewComments is true', async () => {
  const run = await setup()
  try {
    await run.service.openPull('acme/widget', { head: 'dish/fix-1', title: 'Fix', body: '' })
    Object.assign(run.world.github.pullRequests[0]!, { headSha: HEAD_SHA })
    run.world.github.feedback('acme/widget', 1, {
      reviewComments: Array.from({ length: 130 }, (_, index) => ({ path: 'a.ts', line: index + 1, user: { login: 'ann' }, body: `c${index}` })),
      reviews: Array.from({ length: 99 }, () => ({ user: { login: 'ann' }, state: 'COMMENTED', body: '' })),
    })
    const feedback = await run.service.readPull('acme/widget', 1)
    assert.equal(feedback.reviewComments.length, 100)
    assert.deepEqual(feedback.more, { reviews: false, reviewComments: true, issueComments: false, checks: false })
  } finally {
    await teardown(run)
  }
})

test('readPull: an App without Checks or Commit statuses read: checksUnavailable says so, and the reviews and comments still come', async () => {
  const run = await setup({ installation: { contents: 'write', metadata: 'read', pull_requests: 'write' } })
  try {
    await withFeedback(run)
    const feedback = await run.service.readPull('acme/widget', 1)
    assert.equal(feedback.checksUnavailable,
      "the dish App can't read checks of acme/widget: it needs Checks and Commit statuses read (accept them on GitHub; Settings → GitHub App)")
    assert.deepEqual(feedback.checks, [])
    assert.equal(feedback.reviews.length, 2)
    assert.equal(feedback.reviewComments.length, 2)
    assert.equal(feedback.issueComments.length, 1)
    assert.deepEqual(run.world.github.minted.filter(mint => mint.permissions.checks === undefined && mint.permissions.pull_requests === 'read').map(mint => mint.permissions),
      [{ metadata: 'read', pull_requests: 'read' }], 'the narrower API token')
    // Another failure of the checks is an error.
    run.world.github.failNext(`/repos/acme/widget/commits/${HEAD_SHA}/check-runs`, 500, { message: 'boom' })
    await assert.rejects(run.service.readPull('acme/widget', 1), /^Error: could not read the checks: GET .*check-runs answered HTTP 500: boom$/)
    run.world.github.failNext('/repos/acme/widget/pulls/1/reviews', 500, { message: 'down' })
    await assert.rejects(run.service.readPull('acme/widget', 1), /^Error: could not read pull request #1's reviews: GET .*answered HTTP 500: down$/)
    run.world.github.failNext('/repos/acme/widget/issues/1/comments', 502, { message: 'bad gateway' })
    await assert.rejects(run.service.readPull('acme/widget', 1), /^Error: could not read pull request #1's comments: /)
  } finally {
    await teardown(run)
  }
})

test('readPull: an unknown number rejects with "no pull request #<n> in <project>"', async () => {
  const run = await setup()
  try {
    await assert.rejects(run.service.readPull('acme/widget', 7), /^Error: no pull request #7 in acme\/widget$/)
    await assert.rejects(run.service.readPull('acme/widget', 0), /a pull request number is a positive whole number/)
    await assert.rejects(run.service.readPull('acme/gadget', 1), /acme\/gadget isn't ready/)
  } finally {
    await teardown(run)
  }
})
