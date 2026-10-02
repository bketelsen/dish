import { test } from 'node:test'
import assert from 'node:assert/strict'
import { access, chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_GIT_TIMEOUT_MS, GitError, SAFE_FLAGS, git, gitOk, submoduleProblem } from '../src/git.ts'
import { NOSYSTEM, dishHome, makeClone, runOk, scratchGitEnv, tempDir, withEnv } from './helpers.ts'
import type { Clone } from './helpers.ts'

/** Shaped like a GitHub installation token (`ghs_` and 40 letters and digits); not one. */
const TOKEN = `ghs_${'Ab1Cd2Ef3G'.repeat(4)}`
const MB = 1024 * 1024

async function exists(file: string): Promise<boolean> {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

/** Whether `pid` runs no more: no such process, or a zombie its reaper hasn't collected yet. */
async function isGone(pid: number): Promise<boolean> {
  let stat: string
  try {
    stat = await readFile(`/proc/${pid}/stat`, 'utf8')
  } catch {
    return true
  }
  const state = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]
  return state === 'Z' || state === 'X'
}

/** `isGone`, given a moment: a signal is delivered, and a process ends, asynchronously. */
async function goneSoon(pid: number, ms = 1_000): Promise<boolean> {
  const deadline = Date.now() + ms
  for (;;) {
    if (await isGone(pid)) return true
    if (Date.now() > deadline) return false
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

/** The pids an alias wrote to `file`, one per line. */
async function pidsIn(file: string): Promise<number[]> {
  const pids = (await readFile(file, 'utf8')).split('\n').filter(line => line !== '').map(Number)
  assert.ok(pids.length > 0 && pids.every(pid => Number.isInteger(pid) && pid > 1), `pids in ${file}`)
  return pids
}

/** Run `body` with the code's git given a scratch home under `dir`. */
async function asDish<T>(dir: string, body: () => Promise<T>): Promise<T> {
  return withEnv(await dishHome(dir), body)
}

test('SAFE_FLAGS turn hooks, fsmonitor and submodule recursion off, and every call passes them', async () => {
  assert.deepEqual(SAFE_FLAGS, [
    '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
    '-c', 'fetch.recurseSubmodules=false', '-c', 'submodule.recurse=false',
  ])
  assert.equal(Object.isFrozen(SAFE_FLAGS), true)
  assert.equal(DEFAULT_GIT_TIMEOUT_MS, 120_000)
  const dir = await tempDir()
  await asDish(dir, async () => {
    // `-c` values are what `git config --get` reads first: the flags reached git.
    assert.equal(await gitOk(['config', '--get', 'core.hooksPath'], { cwd: dir, env: NOSYSTEM }), '/dev/null\n')
    assert.equal(await gitOk(['config', '--get', 'core.fsmonitor'], { cwd: dir, env: NOSYSTEM }), 'false\n')
    assert.equal(await gitOk(['config', '--get', 'fetch.recurseSubmodules'], { cwd: dir, env: NOSYSTEM }), 'false\n')
    assert.equal(await gitOk(['config', '--get', 'submodule.recurse'], { cwd: dir, env: NOSYSTEM }), 'false\n')
  })
})

test('a version call works', async () => {
  const dir = await tempDir()
  const result = await asDish(dir, () => git(['--version'], { cwd: dir, env: NOSYSTEM }))
  assert.equal(result.code, 0)
  assert.match(result.stdout, /^git version \d/)
  assert.equal(result.timedOut, false)
  assert.equal(result.aborted, false)
})

test('a non-zero exit is a result, not a throw', async () => {
  const dir = await tempDir()
  const result = await asDish(dir, () => git(['-C', join(dir, 'missing'), 'status', '--ignore-submodules=dirty'], { cwd: dir, env: NOSYSTEM }))
  assert.equal(result.code, 128)
  assert.notEqual(result.stderr, '')
  assert.equal(result.timedOut, false)
})

test("git that can't be started is the only throw", async () => {
  const dir = await tempDir()
  await asDish(dir, async () => {
    await assert.rejects(git(['--version'], { cwd: join(dir, 'missing') }), /ENOENT/)
    await assert.rejects(git(['--version'], { cwd: dir, timeoutMs: 0 }), RangeError)
  })
})

test('input reaches stdin', async () => {
  const dir = await tempDir()
  const out = await asDish(dir, () => gitOk(['hash-object', '--stdin'], { cwd: dir, env: NOSYSTEM, input: 'hello\n' }))
  assert.equal(out, 'ce013625030ba8dba906f756967f9e9ca394464a\n')
})

test('output is capped at 4 MB', async () => {
  const dir = await tempDir()
  const { clone } = await makeClone(dir)
  await asDish(dir, async () => {
    const sha = (await gitOk(['hash-object', '-w', '--stdin'], { cwd: clone, env: NOSYSTEM, input: 'x'.repeat(5 * MB) })).trim()
    const result = await git(['cat-file', 'blob', sha], { cwd: clone, env: NOSYSTEM })
    assert.equal(result.code, 0)
    assert.equal(result.stdout.length, 4 * MB)
  })
})

test('gitOk returns stdout, and throws a GitError naming the subcommand and the first stderr line', async () => {
  const dir = await tempDir()
  const { clone } = await makeClone(dir)
  await asDish(dir, async () => {
    assert.equal(await gitOk(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: clone, env: NOSYSTEM }), 'main\n')
    const error = await gitOk(['-c', 'x.y=z', 'ls-files', '--error-unmatch', 'nope.txt'], { cwd: clone, env: NOSYSTEM }).catch((e: unknown) => e)
    assert.ok(error instanceof GitError)
    assert.equal(error.code, 1)
    assert.equal(error.timedOut, false)
    assert.match(error.message, /^git ls-files failed \(exit 1\): error: pathspec 'nope\.txt' did not match/)
    assert.equal(error.message.includes('\n'), false)
  })
})

test("gitOk's message masks a token in git's stderr, a password in a URL, and is cut to 200 characters", async () => {
  const dir = await tempDir()
  const { clone } = await makeClone(dir)
  await asDish(dir, async () => {
    const leaked = await gitOk(['ls-files', '--error-unmatch', `x-access-token:${TOKEN}`], { cwd: clone, env: NOSYSTEM }).catch((e: unknown) => e)
    assert.ok(leaked instanceof GitError)
    assert.equal(leaked.message.includes(TOKEN), false)
    assert.equal(leaked.message.includes('ghs_'), false)
    assert.match(leaked.message, /‹secret: a GitHub token›/)

    const asCommand = await gitOk([TOKEN], { cwd: clone, env: NOSYSTEM }).catch((e: unknown) => e)
    assert.ok(asCommand instanceof GitError)
    assert.equal(asCommand.message.includes('ghs_'), false, 'the subcommand is masked too')

    const url = await gitOk(['ls-files', '--error-unmatch', 'https://someone:hunter2-pw@example.invalid/x.git'], { cwd: clone, env: NOSYSTEM })
      .catch((e: unknown) => e)
    assert.ok(url instanceof GitError)
    assert.equal(url.message.includes('hunter2-pw'), false)
    assert.match(url.message, /someone:\*\*\*@example\.invalid/)

    const long = await gitOk(['ls-files', '--error-unmatch', 'y'.repeat(500)], { cwd: clone, env: NOSYSTEM }).catch((e: unknown) => e)
    assert.ok(long instanceof GitError)
    const line = long.message.slice('git ls-files failed (exit 1): '.length)
    assert.equal(Array.from(line).length, 200)
  })
})

test('a timeout kills the whole process group: git, the shell an alias runs, and what that shell started', async () => {
  const dir = await tempDir()
  const pidFile = join(dir, 'pids')
  const alias = `alias.slow=!echo $$ > '${pidFile}'; sleep 30 & echo $! >> '${pidFile}'; wait`
  const started = Date.now()
  const result = await asDish(dir, () => git(['-c', alias, 'slow'], { cwd: dir, env: NOSYSTEM, timeoutMs: 200 }))
  assert.equal(result.timedOut, true)
  assert.equal(result.aborted, false)
  assert.equal(result.code, -1)
  assert.ok(Date.now() - started < 5_000, 'the TERM was enough: no wait for the KILL')
  const pids = await pidsIn(pidFile)
  assert.equal(pids.length, 2, 'the shell and its sleep')
  for (const pid of pids) assert.equal(await goneSoon(pid), true, `pid ${pid} is gone`)
})

test('a group that ignores TERM is killed after the grace', async () => {
  const dir = await tempDir()
  const pidFile = join(dir, 'pids')
  // SIGTERM ignored by the shell, and by the sleep it starts (an ignored signal stays ignored across fork and exec).
  const alias = `alias.stubborn=!trap '' TERM; echo $$ > '${pidFile}'; sleep 30 & echo $! >> '${pidFile}'; wait`
  const started = Date.now()
  const result = await asDish(dir, () => git(['-c', alias, 'stubborn'], { cwd: dir, env: NOSYSTEM, timeoutMs: 200 }))
  assert.equal(result.timedOut, true)
  assert.ok(Date.now() - started < 15_000, `over in ${Date.now() - started} ms, not after the sleep's 30 s`)
  for (const pid of await pidsIn(pidFile)) assert.equal(await goneSoon(pid), true, `pid ${pid} is gone`)
})

test('what git leaves behind when it goes, ignoring TERM and holding no pipe, is killed at once', async () => {
  const dir = await tempDir()
  const pidFile = join(dir, 'pids')
  // The alias's shell dies on the TERM, and git with it; the sleep it started in the background ignores TERM and has
  // its output on /dev/null, so git's pipes close while it still runs: only a KILL to the group once git has gone ends it.
  const alias = `alias.leave=!sh -c "trap '' TERM; echo \\$\\$ > '${pidFile}'; exec sleep 30" >/dev/null 2>&1 & wait`
  const result = await asDish(dir, () => git(['-c', alias, 'leave'], { cwd: dir, env: NOSYSTEM, timeoutMs: 300 }))
  assert.equal(result.timedOut, true)
  for (const pid of await pidsIn(pidFile)) assert.equal(await goneSoon(pid), true, `pid ${pid} is gone`)
})

test('an abort kills the whole process group too', async () => {
  const dir = await tempDir()
  const pidFile = join(dir, 'pids')
  const alias = `alias.slow=!echo $$ > '${pidFile}'; sleep 30 & echo $! >> '${pidFile}'; wait`
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 200)
  const result = await asDish(dir, () => git(['-c', alias, 'slow'], { cwd: dir, env: NOSYSTEM, signal: controller.signal }))
  assert.equal(result.aborted, true)
  assert.equal(result.timedOut, false)
  for (const pid of await pidsIn(pidFile)) assert.equal(await goneSoon(pid), true, `pid ${pid} is gone`)
})

test('an already aborted signal starts nothing', async () => {
  const dir = await tempDir()
  const marker = join(dir, 'ran')
  const controller = new AbortController()
  controller.abort()
  const result = await asDish(dir, () => git(['-c', `alias.mark=!touch '${marker}'`, 'mark'], { cwd: dir, env: NOSYSTEM, signal: controller.signal }))
  assert.equal(result.aborted, true)
  assert.equal(await exists(marker), false)
})

test('gitOk throws a GitError for a timeout and for an abort', async () => {
  const dir = await tempDir()
  await asDish(dir, async () => {
    const timedOut = await gitOk(['-c', 'alias.slow=!sleep 30', 'slow'], { cwd: dir, env: NOSYSTEM, timeoutMs: 100 }).catch((e: unknown) => e)
    assert.ok(timedOut instanceof GitError)
    assert.equal(timedOut.timedOut, true)
    assert.equal(timedOut.message, 'git slow timed out after 100 ms')
    const controller = new AbortController()
    controller.abort()
    const aborted = await gitOk(['status', '--ignore-submodules=dirty'], { cwd: dir, signal: controller.signal }).catch((e: unknown) => e)
    assert.ok(aborted instanceof GitError)
    assert.equal(aborted.message, 'git status was aborted')
  })
})

test("git's environment is childEnvironment's: no inherited GIT_*, DSH_* or credential-shaped name; the call's own env goes on top", async () => {
  const dir = await tempDir()
  const { clone } = await makeClone(join(dir, 'a'))
  const other = await makeClone(join(dir, 'b'))
  const show = 'alias.dishenv=!echo "${DISH_WS_T_TOKEN-unset} ${DSH_WS_T-unset} ${GIT_WS_T-unset} $GIT_TERMINAL_PROMPT ${DISH_WS_T_PLAIN-unset}"'
  await withEnv({
    ...(await dishHome(dir)),
    GIT_DIR: join(other.clone, '.git'), GIT_WS_T: 'x', DISH_WS_T_TOKEN: 'x', DSH_WS_T: 'x', DISH_WS_T_PLAIN: 'kept', GIT_TERMINAL_PROMPT: '1',
  }, async () => {
    assert.equal(await gitOk(['rev-parse', '--absolute-git-dir'], { cwd: clone, env: NOSYSTEM }), `${join(clone, '.git')}\n`)
    assert.equal(await gitOk(['-c', show, 'dishenv'], { cwd: clone, env: NOSYSTEM }), 'unset unset unset 0 kept\n')
    const explicit = { ...NOSYSTEM, GIT_DIR: join(other.clone, '.git') }
    assert.equal(await gitOk(['rev-parse', '--absolute-git-dir'], { cwd: clone, env: explicit }), `${join(other.clone, '.git')}\n`)
  })
})

// --- the spec's check: a clone agents can write can't choose what dish's git runs ------------------------------------

test("a post-checkout hook planted in .git/hooks doesn't run on dish's worktree add (and does without the flags)", async () => {
  const dir = await tempDir()
  const { clone, env } = await makeClone(dir)
  const marker = join(dir, 'hook-ran')
  const hook = join(clone, '.git', 'hooks', 'post-checkout')
  await writeFile(hook, `#!/bin/sh\necho ran >> '${marker}'\n`)
  await chmod(hook, 0o755)

  await asDish(dir, () => gitOk(['worktree', 'add', '-q', '-b', 'dish/one', '.worktrees/one'], { cwd: clone, env: NOSYSTEM }))
  assert.equal(await exists(join(clone, '.worktrees', 'one', 'README.md')), true, 'the worktree was made')
  assert.equal(await exists(marker), false, "dish's git ran the planted hook")

  // The fixture is real: git without the flags runs it.
  await runOk('git', ['worktree', 'add', '-q', '-b', 'dish/two', '.worktrees/two'], { cwd: clone, env })
  assert.equal(await readFile(marker, 'utf8'), 'ran\n')
})

test("a core.fsmonitor command planted in .git/config doesn't run on dish's status (and does without the flags)", async () => {
  const dir = await tempDir()
  const { clone, env } = await makeClone(dir)
  const marker = join(dir, 'fsmonitor-ran')
  const script = join(dir, 'fsmonitor.sh')
  await writeFile(script, `#!/bin/sh\necho ran >> '${marker}'\nexit 1\n`)
  await chmod(script, 0o755)
  await runOk('git', ['config', 'core.fsmonitor', script], { cwd: clone, env })

  await asDish(dir, () => gitOk(['status', '--porcelain', '--ignore-submodules=dirty'], { cwd: clone, env: NOSYSTEM }))
  assert.equal(await exists(marker), false, "dish's git ran the planted fsmonitor")

  await runOk('git', ['status', '--porcelain'], { cwd: clone, env })
  assert.match(await readFile(marker, 'utf8'), /^ran\n/)
})

// --- a nested repository agents could plant can't choose what dish's git runs --------------------------------------

/**
 * A repository `nested` inside `clone`, with a filter whose program writes `marker`, committed as a gitlink. git runs
 * the filter when it looks inside `nested` to see whether it is dirty. Returns the clone's scratch git env and `marker`.
 */
async function withPlantedNested(clone: Clone, dir: string): Promise<{ marker: string, script: string }> {
  const marker = join(dir, 'nested-filter-ran')
  const script = join(dir, 'filter.sh')
  await writeFile(script, `#!/bin/sh\necho ran >> '${marker}'\ncat\n`)
  await chmod(script, 0o755)
  const nested = join(clone.clone, 'nested')
  await runOk('git', ['init', '-q', '-b', 'main', nested], { env: clone.env })
  await writeFile(join(nested, '.gitattributes'), '* filter=evil\n')
  await writeFile(join(nested, 'f'), 'x\n')
  await runOk('git', ['-C', nested, 'add', '-A'], { env: clone.env })
  await runOk('git', ['-C', nested, 'commit', '-q', '-m', 'nested'], { env: clone.env })
  await runOk('git', ['-C', clone.clone, 'add', 'nested'], { env: clone.env })
  await runOk('git', ['-C', clone.clone, 'commit', '-q', '-m', 'add nested'], { env: clone.env })
  // The filter is configured only now, after the gitlink is committed, so nothing in this fixture runs it. A recursing
  // status runs `git status` inside `nested`, which runs the clean filter on the dirty `f`: that is the planted program.
  await runOk('git', ['-C', nested, 'config', 'filter.evil.clean', script], { env: clone.env })
  await runOk('git', ['-C', nested, 'config', 'filter.evil.smudge', script], { env: clone.env })
  await writeFile(join(nested, 'f'), 'changed\n')
  if (await exists(marker)) throw new Error('the fixture ran the filter itself')
  return { marker, script }
}

test("status and diff with --ignore-submodules=dirty never run a nested repository's filter (and do run it without the flag)", async () => {
  const dir = await tempDir()
  const made = await makeClone(dir)
  const { marker } = await withPlantedNested(made, dir)
  const { clone } = made
  await asDish(dir, async () => {
    for (const args of [
      ['status', '--porcelain', '--ignore-submodules=dirty'],
      ['status', '--porcelain', '--ignore-submodules=all'],
      ['diff', '--quiet', '--ignore-submodules=dirty'],
      ['diff-index', '--quiet', '--ignore-submodules=dirty', 'HEAD'],
      ['diff-files', '--quiet', '--ignore-submodules=dirty'],
    ]) {
      await git(['-C', clone, ...args], { env: NOSYSTEM })
      assert.equal(await exists(marker), false, `${args.join(' ')} ran the nested filter`)
    }
  })
  // The fixture is real: a plain status (what git runs directly) recurses into the nested repository and runs it.
  await runOk('git', ['-C', clone, 'status', '--porcelain'], { env: made.env })
  assert.match(await readFile(marker, 'utf8'), /^ran\n/)
})

test('a status or diff* call without --ignore-submodules=dirty/all is refused before git starts', async () => {
  const dir = await tempDir()
  const made = await makeClone(dir)
  const { marker } = await withPlantedNested(made, dir)
  const { clone } = made
  await asDish(dir, async () => {
    for (const args of [
      ['status', '--porcelain'],
      ['status', '--porcelain', '--ignore-submodules=none'],
      ['status', '--porcelain', '--ignore-submodules'],
      ['status', '--porcelain', '--no-ignore-submodules'],
      ['status', '--ignore-submodules=all', '--ignore-submodules=none'],
      ['diff'],
      ['diff-index', 'HEAD'],
      ['diff-files'],
    ]) {
      await assert.rejects(git(['-C', clone, ...args], { env: NOSYSTEM }), /--ignore-submodules/, args.join(' '))
    }
    assert.equal(await exists(marker), false, 'a refused call started git anyway')
  })
})

test("fetch doesn't recurse into a nested repository (and does without SAFE_FLAGS' submodule settings)", async () => {
  const dir = await tempDir()
  const made = await makeClone(dir)
  const { clone } = made
  const marker = join(dir, 'uploadpack-ran')
  const uploadpack = join(dir, 'uploadpack.sh')
  await writeFile(uploadpack, `#!/bin/sh\necho ran >> '${marker}'\nexit 1\n`)
  await chmod(uploadpack, 0o755)
  const nested = join(clone, 'nested')
  await runOk('git', ['init', '-q', '-b', 'main', nested], { env: made.env })
  await writeFile(join(nested, 'f'), 'x\n')
  await runOk('git', ['-C', nested, 'add', '-A'], { env: made.env })
  await runOk('git', ['-C', nested, 'commit', '-q', '-m', 'n'], { env: made.env })
  await runOk('git', ['-C', nested, 'remote', 'add', 'origin', made.bare], { env: made.env })
  await runOk('git', ['-C', nested, 'config', 'remote.origin.uploadpack', uploadpack], { env: made.env })
  // An agent's .gitmodules, committed with the gitlink so recursion treats `nested` as a submodule to fetch.
  await writeFile(join(clone, '.gitmodules'), '[submodule "nested"]\n\tpath = nested\n\turl = ./nested\n\tfetchRecurseSubmodules = true\n')
  await runOk('git', ['-C', clone, 'add', '.gitmodules', 'nested'], { env: made.env })
  await runOk('git', ['-C', clone, 'commit', '-q', '-m', 'add submodule'], { env: made.env })

  await asDish(dir, () => git(['-C', clone, 'fetch', 'origin'], { env: NOSYSTEM }))
  assert.equal(await exists(marker), false, "dish's fetch recursed into the nested repository")

  // Without the two settings (but with the hook and fsmonitor ones), the same fetch runs the nested uploadpack.
  await runOk('git', [
    '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', clone, 'fetch', 'origin',
  ], { env: made.env }).catch(() => {})
  assert.equal(await exists(marker), true, 'the fixture proved itself: the nested uploadpack runs without the flags')
})

test('submoduleProblem: only status and diff* are guarded, and only before the end of options', () => {
  assert.equal(submoduleProblem(['log', '--oneline']), undefined)
  assert.equal(submoduleProblem(['worktree', 'add', 'x']), undefined)
  assert.equal(submoduleProblem(['fetch', 'origin']), undefined)
  assert.equal(submoduleProblem([]), undefined)
  for (const sub of ['status', 'diff', 'diff-index', 'diff-files']) {
    assert.match(submoduleProblem([sub]) ?? '', /--ignore-submodules/, sub)
    assert.equal(submoduleProblem(['-C', '/x', sub, '--ignore-submodules=dirty']), undefined, sub)
    assert.equal(submoduleProblem([sub, '--ignore-submodules=all']), undefined, sub)
    assert.match(submoduleProblem([sub, '--ignore-submodules=none']) ?? '', /--ignore-submodules/, sub)
    assert.match(submoduleProblem([sub, '--ignore-sub=untracked']) ?? '', /--ignore-sub/, sub)
    assert.match(submoduleProblem([sub, '--no-ignore-submodules']) ?? '', /--no-ignore-submodules/, sub)
    // The last one wins, as it does for git: a good one then a bad one is still refused.
    assert.match(submoduleProblem([sub, '--ignore-submodules=all', '--ignore-submodules=none']) ?? '', /--ignore-submodules/, sub)
    // A pathspec after `--` that looks like the option is not an option.
    assert.match(submoduleProblem([sub, '--', '--ignore-submodules=all']) ?? '', /--ignore-submodules/, sub)
  }
})

// --- git() is the one way -------------------------------------------------------------------------------------------

test("git.ts is the only module of dish-workspaces that runs git", async () => {
  const src = fileURLToPath(new URL('../src/', import.meta.url))
  const files = (await readdir(src, { recursive: true })).filter(name => name.endsWith('.ts') || name.endsWith('.tsx'))
  assert.ok(files.includes('git.ts'))
  const spawns = /\bfrom\s+['"](?:node:)?child_process['"]|\bimport\(\s*['"](?:node:)?child_process['"]\s*\)|\brequire\(\s*['"](?:node:)?child_process['"]\s*\)/
  const gitBinary = /['"`](?:[^'"`\n]*\/)?git(?:\.exe)?['"`]/
  for (const file of files) {
    if (file === 'git.ts') continue
    const text = await readFile(join(src, file), 'utf8')
    assert.ok(!(spawns.test(text) && gitBinary.test(text)), `${relative(src, join(src, file))} starts git itself: use git() from git.ts`)
  }
})

test('scratch gits in these tests never see the real home', async () => {
  const dir = await tempDir()
  const env = await scratchGitEnv(dir)
  assert.equal(env.HOME, join(dir, 'home'))
  assert.equal(env.GIT_CONFIG_NOSYSTEM, '1')
  assert.equal(env.GIT_CONFIG_GLOBAL, join(dir, 'home', '.gitconfig'))
  const where = await runOk('git', ['config', '--show-origin', '--get', 'user.email'], { cwd: dir, env })
  assert.equal(where, `file:${join(dir, 'home', '.gitconfig')}\tdish-test@example.invalid\n`)
  const ours = await asDish(dir, () => gitOk(['config', '--show-origin', '--get', 'user.email'], { cwd: dir, env: NOSYSTEM }))
  assert.equal(ours, `file:${join(dir, 'home', '.gitconfig')}\tdish-test@example.invalid\n`)
})
