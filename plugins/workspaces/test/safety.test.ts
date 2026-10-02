import { test } from 'node:test'
import assert from 'node:assert/strict'
import { access, appendFile, chmod, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { helperValue } from '../src/paths.ts'
import { ALLOWED, ORIGIN_FETCH, checkClone, checkWorktree, configProblem } from '../src/safety.ts'
import type { CloneExpectations, SafetyResult } from '../src/safety.ts'
import { makeClone, run, runOk, tempDir } from './helpers.ts'
import type { Clone } from './helpers.ts'

const WEB = 'https://github.com'
const HELPER = helperValue('/opt/dish/plugins/workspaces/bin/git-credential-dish', '/s/dish/workspaces/tokens', WEB)
const EXPECT: CloneExpectations = { url: 'https://github.com/acme/widget.git', helper: HELPER, web: WEB }
const TOKEN = `ghs_${'Ab1Cd2Ef3G'.repeat(4)}`

async function exists(file: string): Promise<boolean> {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

function problemOf(result: SafetyResult): string {
  assert.equal(result.ok, false, 'expected a refusal')
  return (result as { ok: false, problem: string }).problem
}

/** A marker script under `dir`: when run, it appends a line to the returned `marker` (and passes stdin through, as a filter would). */
async function markerScript(dir: string, name: string): Promise<{ script: string, marker: string }> {
  const script = join(dir, `${name}.sh`)
  const marker = join(dir, `${name}-ran`)
  await writeFile(script, `#!/bin/sh\necho ran >> '${marker}'\ncat\n`)
  await chmod(script, 0o755)
  return { script, marker }
}

/** A fresh clone, with `.git/config` as `git clone` wrote it plus the keys dish writes (by `git config`, as dish will). */
async function dishClone(): Promise<Clone & { dir: string }> {
  const dir = await tempDir()
  const made = await makeClone(dir)
  const set = (...args: string[]) => runOk('git', ['config', ...args], { cwd: made.clone, env: made.env })
  await set('remote.origin.url', EXPECT.url!)
  await set(`credential.${WEB}.helper`, '')
  await set('--add', `credential.${WEB}.helper`, HELPER)
  await set(`credential.${WEB}.useHttpPath`, 'true')
  await set('credential.interactive', 'false')
  await set('user.name', 'dish[bot]')
  await set('user.email', '1+dish[bot]@users.noreply.github.com')
  return { ...made, dir }
}

test('a fresh git clone passes, with and without expectations', async () => {
  const dir = await tempDir()
  const { clone, url } = await makeClone(dir)
  assert.deepEqual(await checkClone(clone), { ok: true })
  assert.deepEqual(await checkClone(clone, { url }), { ok: true })
})

test('a clone with the keys dish writes passes its expectations', async () => {
  const { clone } = await dishClone()
  assert.deepEqual(await checkClone(clone, EXPECT), { ok: true })
})

test('every allowed key passes, as git writes it', async () => {
  const { clone, env } = await dishClone()
  const set = (key: string, value: string) => runOk('git', ['config', '--add', key, value], { cwd: clone, env })
  await runOk('git', ['config', 'core.repositoryformatversion', '1'], { cwd: clone, env })
  for (const [key, value] of [
    ['core.ignoreCase', 'false'], ['core.precomposeUnicode', 'false'], ['core.symlinks', 'true'],
    ['remote.origin.pushurl', 'https://github.com/acme/widget.git'], ['remote.origin.prune', 'true'], ['remote.origin.tagOpt', '--no-tags'],
    ['remote.up.stream.url', 'https://example.invalid/u.git'], ['remote.up.stream.fetch', '+refs/heads/*:refs/remotes/up/*'],
    ['branch.main.rebase', 'merges'], ['branch.main.pushRemote', 'origin'], ['branch.main.description', 'the main line'],
    ['branch.feature/x.remote', 'origin'], ['branch.feature/x.merge', 'refs/heads/feature/x'], ['branch.feature/x.rebase', 'false'],
    ['extensions.objectFormat', 'sha1'], ['extensions.refStorage', 'files'],
    ['pull.rebase', 'true'], ['pull.ff', 'only'], ['push.default', 'simple'], ['push.autoSetupRemote', 'true'],
    ['fetch.prune', 'true'], ['init.defaultBranch', 'main'],
  ] as const) await set(key, value)
  assert.deepEqual(await checkClone(clone, EXPECT), { ok: true })
})

test('ALLOWED lists exactly the plan\'s keys', () => {
  const strings = ALLOWED.filter((entry): entry is string => typeof entry === 'string').sort()
  assert.deepEqual(strings, [
    'core.bare', 'core.filemode', 'core.ignorecase', 'core.logallrefupdates', 'core.precomposeunicode', 'core.repositoryformatversion',
    'core.symlinks', 'credential.interactive', 'extensions.objectformat', 'extensions.refstorage', 'fetch.prune', 'init.defaultbranch',
    'pull.ff', 'pull.rebase', 'push.autosetupremote', 'push.default', 'user.email', 'user.name',
  ])
  const patterns = ALLOWED.filter((entry): entry is RegExp => entry instanceof RegExp)
  const matches = (key: string) => patterns.some(pattern => pattern.test(key))
  for (const key of [
    'remote.origin.url', 'remote.origin.fetch', 'remote.origin.pushurl', 'remote.origin.prune', 'remote.origin.tagopt',
    'branch.main.remote', 'branch.main.merge', 'branch.main.rebase', 'branch.main.pushremote', 'branch.main.description',
    'credential.https://github.com.helper', 'credential.https://github.com.usehttppath',
  ]) assert.equal(matches(key), true, key)
  for (const key of [
    'remote.origin.uploadpack', 'remote.origin.receivepack', 'remote.origin.vcs', 'remote.origin.proxy', 'branch.main.vscode',
    'credential.helper', 'credential.https://github.com.username', 'filter.lfs.smudge', 'url.x.insteadof', 'remote..url',
  ]) assert.equal(matches(key), false, key)
})

test('configProblem: section and variable names are compared as git does, without case; subsections keep theirs', () => {
  assert.equal(configProblem([['Core.Bare', 'false'], ['REMOTE.origin.URL', 'https://x.invalid/r.git']]), undefined)
  assert.match(configProblem([['Core.HooksPath', '/x']]) ?? '', /core\.hookspath/)
  assert.match(configProblem([[`credential.HTTPS://GITHUB.COM.helper`, HELPER]], EXPECT) ?? '', /another origin/)
})

test('configProblem: a key with no value counts as true, as in git', () => {
  // `git config --list --null` prints a bare `bare` (no `=`) as the key alone; checkClone reads it as `true`.
  assert.match(configProblem([['core.bare', 'true']]) ?? '', /core\.bare must be false/)
  assert.equal(configProblem([['credential.https://github.com.usehttppath', 'true']]), undefined)
})

/** What an agent might write into `.git/config` of a clone dish set up, the key the refusal must name, and the expectations (EXPECT if none). */
const PLANTS: ReadonlyArray<readonly [string, string, CloneExpectations | undefined]> = [
  ['[core]\n\thooksPath = /x\n', 'core.hookspath', undefined],
  ['[Core]\n\tHooksPath = /x\n', 'core.hookspath', undefined],
  ['[core]\n\tfsmonitor = /x\n', 'core.fsmonitor', undefined],
  ['[core]\n\tsshCommand = /x\n', 'core.sshcommand', undefined],
  ['[core]\n\tpager = /x\n', 'core.pager', undefined],
  ['[core]\n\teditor = /x\n', 'core.editor', undefined],
  ['[core]\n\tworktree = /elsewhere\n', 'core.worktree', undefined],
  ['[core]\n\tbare = true\n', 'core.bare', undefined],
  ['[filter "lfs"]\n\tsmudge = /x\n', 'filter.lfs.smudge', undefined],
  ['[diff "x"]\n\tcommand = /x\n', 'diff.x.command', undefined],
  ['[diff "x"]\n\ttextconv = /x\n', 'diff.x.textconv', undefined],
  ['[merge "x"]\n\tdriver = /x\n', 'merge.x.driver', undefined],
  ['[include]\n\tpath = /x\n', 'include.path', undefined],
  ['[includeIf "gitdir:/x"]\n\tpath = /y\n', 'includeif.gitdir:/x.path', undefined],
  ['[extensions]\n\tworktreeConfig = true\n', 'extensions.worktreeconfig', undefined],
  ['[credential]\n\thelper = store\n', 'credential.helper', undefined],
  ['[credential]\n\tinteractive = true\n', 'credential.interactive', undefined],
  ['[remote "origin"]\n\tuploadpack = /x\n', 'remote.origin.uploadpack', undefined],
  ['[remote "origin"]\n\treceivepack = /x\n', 'remote.origin.receivepack', undefined],
  ['[remote "origin"]\n\tvcs = evil\n', 'remote.origin.vcs', undefined],
  ['[remote "x"]\n\turl = ext::sh -c x\n', 'remote.x.url', undefined],
  ['[remote "x"]\n\turl = fd::3\n', 'remote.x.url', undefined],
  ['[remote "x"]\n\turl = evil::https://x.invalid/r\n', 'remote.x.url', undefined],
  ['[remote "x"]\n\tpushurl = ext::sh -c x\n', 'remote.x.pushurl', undefined],
  ['[remote "x"]\n\turl = -uevil\n', 'remote.x.url', undefined],
  ['[branch "main"]\n\trebase = interactive\n', 'branch.main.rebase', undefined],
  ['[branch "main"]\n\tremote = ext::sh -c x\n', 'branch.main.remote', undefined],
  ['[branch "main"]\n\tpushRemote = ext::sh -c x\n', 'branch.main.pushremote', undefined],
  ['[pull]\n\trebase = interactive\n', 'pull.rebase', undefined],
  ['[url "ext::sh -c x"]\n\tinsteadOf = https://github.com/\n', 'url.ext::sh -c x.insteadof', undefined],
  ['[gpg]\n\tprogram = /x\n', 'gpg.program', undefined],
  ['[sequence]\n\teditor = /x\n', 'sequence.editor', undefined],
  ['[submodule]\n\trecurse = true\n', 'submodule.recurse', undefined],
  ['[credential "https://github.com"]\n\thelper = !evil\n', 'credential.https://github.com.helper', EXPECT],
  ['[credential "https://github.com"]\n\tuseHttpPath = false\n', 'credential.https://github.com.usehttppath', EXPECT],
  ['[credential "https://evil.example"]\n\thelper =\n', 'credential.https://evil.example.helper', EXPECT],
  ['[credential "https://github.com"]\n\tusername = x\n', 'credential.https://github.com.username', EXPECT],
]

test('a key outside the allowlist, or a value dish did not write, is refused with the key named', async () => {
  const { clone } = await dishClone()
  const config = join(clone, '.git', 'config')
  const original = await readFile(config, 'utf8')
  for (const [text, key, expect] of PLANTS) {
    await writeFile(config, original + text)
    const result = await checkClone(clone, expect ?? EXPECT)
    assert.equal(result.ok, false, `${key} passed`)
    assert.ok(problemOf(result).includes(key), `${key}: ${problemOf(result)}`)
  }
  await writeFile(config, original)
  assert.deepEqual(await checkClone(clone, EXPECT), { ok: true })
})

test("a credential helper is dish's only when the expectations name it; an empty entry is always allowed", async () => {
  const dir = await tempDir()
  const { clone, env } = await makeClone(dir)
  const set = (...args: string[]) => runOk('git', ['config', ...args], { cwd: clone, env })
  await set(`credential.${WEB}.helper`, '')
  assert.deepEqual(await checkClone(clone), { ok: true })
  await set('--add', `credential.${WEB}.helper`, HELPER)
  assert.match(problemOf(await checkClone(clone)), /credential\.https:\/\/github\.com\.helper is not dish's credential helper/)
  assert.match(problemOf(await checkClone(clone, { web: WEB })), /credential\.https:\/\/github\.com\.helper/)
  assert.deepEqual(await checkClone(clone, { helper: HELPER }), { ok: true })
  assert.deepEqual(await checkClone(clone, { helper: HELPER, web: WEB }), { ok: true })
  assert.match(problemOf(await checkClone(clone, { helper: HELPER, web: 'http://127.0.0.1:4242' })), /another origin/)
  await set('--add', `credential.${WEB}.helper`, '!evil')
  assert.match(problemOf(await checkClone(clone, { helper: HELPER, web: WEB })), /credential\.https:\/\/github\.com\.helper is not dish's/)
})

test('remote.origin.url other than the expected URL is refused, and so is none at all', async () => {
  const { clone, env } = await dishClone()
  await runOk('git', ['config', 'remote.origin.url', 'https://github.com/acme/other.git'], { cwd: clone, env })
  assert.match(problemOf(await checkClone(clone, EXPECT)), /remote\.origin\.url is not https:\/\/github\.com\/acme\/widget\.git/)
  assert.deepEqual(await checkClone(clone, { web: WEB, helper: HELPER }), { ok: true }, 'no URL expected')
  await runOk('git', ['remote', 'remove', 'origin'], { cwd: clone, env })
  assert.match(problemOf(await checkClone(clone, EXPECT)), /no remote\.origin\.url/)
})

test('remote.origin.fetch must be exactly the standard refspec when the URL is expected', async () => {
  const { clone, env } = await dishClone()
  assert.equal(ORIGIN_FETCH, '+refs/heads/*:refs/remotes/origin/*')
  assert.deepEqual(await checkClone(clone, EXPECT), { ok: true }, 'the refspec git clone wrote passes')
  // A planted refspec that would fetch into refs/remotes/origin/* from another remote's heads.
  await runOk('git', ['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/upstream/*'], { cwd: clone, env })
  assert.match(problemOf(await checkClone(clone, EXPECT)), /remote\.origin\.fetch is not \+refs\/heads\/\*:refs\/remotes\/origin\/\*/)
  // Without an expected URL, the refspec isn't pinned (the clone's identity isn't established).
  assert.deepEqual(await checkClone(clone, { web: WEB, helper: HELPER }), { ok: true })
  await runOk('git', ['config', 'remote.origin.fetch', ORIGIN_FETCH], { cwd: clone, env })
  assert.deepEqual(await checkClone(clone, EXPECT), { ok: true })
})

test('a URL password inside a key name is masked in the problem text', async () => {
  const { clone } = await dishClone()
  await appendFile(join(clone, '.git', 'config'), '[url "https://user:hunter2-pw@host/"]\n\tinsteadOf = x\n')
  const problem = problemOf(await checkClone(clone, EXPECT))
  assert.match(problem, /url\.https:\/\/user:\*\*\*@host/)
  assert.equal(problem.includes('hunter2-pw'), false)
})

test("a problem never quotes a value, and shows a key's control characters and secrets masked", async () => {
  const { clone } = await dishClone()
  const config = join(clone, '.git', 'config')
  await appendFile(config, `[remote "origin"]\n\tpushurl = ext::sh -c ${TOKEN}\n`)
  const value = problemOf(await checkClone(clone, EXPECT))
  assert.match(value, /remote\.origin\.pushurl/)
  assert.equal(value.includes('sh -c'), false)
  assert.equal(value.includes('ghs_'), false)

  const fresh = await dishClone()
  await appendFile(join(fresh.clone, '.git', 'config'), `[remote "\x1b[31m ${TOKEN}"]\n\turl = x\n\tvcs = x\n`)
  const key = problemOf(await checkClone(fresh.clone, EXPECT))
  assert.equal(key.includes('\x1b'), false)
  assert.equal(key.includes('ghs_'), false)
})

test('checkClone itself runs nothing a planted key names', async () => {
  const { clone, dir } = await dishClone()
  const { script, marker } = await markerScript(dir, 'planted')
  await appendFile(join(clone, '.git', 'config'), [
    '[core]', `\tfsmonitor = ${script}`, `\tpager = ${script}`, `\tsshCommand = ${script}`,
    '[filter "evil"]', `\tclean = ${script}`, `\tsmudge = ${script}`,
    '[diff "evil"]', `\ttextconv = ${script}`, '',
  ].join('\n'))
  await writeFile(join(clone, '.gitattributes'), '* filter=evil diff=evil\n')
  await writeFile(join(clone, '.git', 'hooks', 'post-checkout'), `#!/bin/sh\n'${script}'\n`)
  await chmod(join(clone, '.git', 'hooks', 'post-checkout'), 0o755)
  assert.equal((await checkClone(clone, EXPECT)).ok, false)
  assert.equal(await exists(marker), false)
})

test('a planted filter is refused before dish works in the clone (and runs on checkout without the check)', async () => {
  const { clone, dir, env } = await dishClone()
  const { script, marker } = await markerScript(dir, 'filter')
  await appendFile(join(clone, '.git', 'config'), `[filter "evil"]\n\tsmudge = ${script}\n\tclean = ${script}\n`)
  await writeFile(join(clone, '.gitattributes'), '* filter=evil\n')
  assert.match(problemOf(await checkClone(clone, EXPECT)), /filter\.evil\.smudge/)
  assert.equal(await exists(marker), false)
  // The fixture is real: git checks the files out of a new worktree through the filter.
  await runOk('git', ['add', '.gitattributes'], { cwd: clone, env })
  await runOk('git', ['commit', '-q', '-m', 'attributes'], { cwd: clone, env })
  await runOk('git', ['worktree', 'add', '-q', '-b', 'dish/x', '.worktrees/x'], { cwd: clone, env })
  assert.equal(await exists(marker), true)
})

test("include.path is refused by name, and the included file isn't read (--no-includes)", async () => {
  const { clone, dir } = await dishClone()
  const { script, marker } = await markerScript(dir, 'included')
  // Unparsable after its first section: a check that followed includes would fail on it instead of naming include.path.
  const included = join(dir, 'included.cfg')
  await writeFile(included, `[core]\n\tfsmonitor = ${script}\nthis is not config\n`)
  await appendFile(join(clone, '.git', 'config'), `[include]\n\tpath = ${included}\n`)
  assert.match(problemOf(await checkClone(clone, EXPECT)), /include\.path/)
  assert.equal(await exists(marker), false)

  const conditional = await dishClone()
  await appendFile(join(conditional.clone, '.git', 'config'), `[includeIf "gitdir:${conditional.clone}/"]\n\tpath = ${included}\n`)
  assert.match(problemOf(await checkClone(conditional.clone, EXPECT)), /includeif\.gitdir:.*\.path/)
})

test(".git must be a directory: a worktree's or a submodule's .git file, a symbolic link, or none, is refused", async () => {
  const { clone, env, dir } = await dishClone()
  await runOk('git', ['worktree', 'add', '-q', '-b', 'dish/one', '.worktrees/one'], { cwd: clone, env })
  assert.match(problemOf(await checkClone(join(clone, '.worktrees', 'one'))), /\.git is not a directory/)

  const linked = join(dir, 'linked')
  await mkdir(linked)
  await symlink(join(clone, '.git'), join(linked, '.git'))
  assert.match(problemOf(await checkClone(linked)), /\.git is not a directory/)

  assert.match(problemOf(await checkClone(join(dir, 'nothing-here'))), /\.git is missing/)
})

test('.git/commondir, .git/config.worktree, and a .git/config that is missing or not a file, are refused', async () => {
  for (const [plant, expected] of [
    [async (git: string) => writeFile(join(git, 'commondir'), '../elsewhere\n'), /\.git\/commondir/],
    [async (git: string) => writeFile(join(git, 'config.worktree'), '[core]\n\thooksPath = /x\n'), /\.git\/config\.worktree/],
    [async (git: string) => rm(join(git, 'config')), /\.git\/config is missing/],
    [async (git: string) => {
      await rename(join(git, 'config'), join(git, 'real-config'))
      await symlink(join(git, 'real-config'), join(git, 'config'))
    }, /\.git\/config is not a regular file/],
  ] as const) {
    const { clone } = await dishClone()
    await plant(join(clone, '.git'))
    assert.match(problemOf(await checkClone(clone, EXPECT)), expected)
  }
})

test("a worktree's administrative directory must point back at the clone, and hold no config.worktree", async () => {
  const cases: ReadonlyArray<readonly [(admin: string, dir: string) => Promise<unknown>, RegExp]> = [
    [admin => writeFile(join(admin, 'commondir'), '../../../elsewhere/.git\n'), /\.git\/worktrees\/one: commondir/],
    [admin => rm(join(admin, 'commondir')), /\.git\/worktrees\/one: commondir/],
    [admin => writeFile(join(admin, 'config.worktree'), '[core]\n\tfsmonitor = /x\n'), /\.git\/worktrees\/one: config\.worktree/],
    [async (admin, dir) => {
      await rename(admin, join(dir, 'moved-admin'))
      await symlink(join(dir, 'moved-admin'), admin)
    }, /\.git\/worktrees\/one is not a directory/],
    [async admin => {
      await rm(join(admin, 'commondir'))
      await run('mkfifo', [join(admin, 'commondir')], { env: { HOME: admin, PATH: process.env.PATH ?? '/usr/bin:/bin' } })
    }, /\.git\/worktrees\/one: commondir/],
  ]
  for (const [plant, expected] of cases) {
    const { clone, env, dir } = await dishClone()
    await runOk('git', ['worktree', 'add', '-q', '-b', 'dish/one', '.worktrees/one'], { cwd: clone, env })
    assert.deepEqual(await checkClone(clone, EXPECT), { ok: true }, 'a worktree as git made it passes')
    await plant(join(clone, '.git', 'worktrees', 'one'), dir)
    assert.match(problemOf(await checkClone(clone, EXPECT)), expected)
  }
})

test('checkWorktree passes a worktree as git made it, also when reached through a symbolic link', async () => {
  const { clone, env, dir } = await dishClone()
  await runOk('git', ['worktree', 'add', '-q', '-b', 'dish/one', '.worktrees/one'], { cwd: clone, env })
  assert.deepEqual(await checkWorktree(clone, join(clone, '.worktrees', 'one')), { ok: true })
  await symlink(clone, join(dir, 'via-link'))
  assert.deepEqual(await checkWorktree(join(dir, 'via-link'), join(dir, 'via-link', '.worktrees', 'one')), { ok: true })
})

test('checkWorktree refuses a worktree path that is itself a symbolic link, so worktree remove never deletes its target', async () => {
  const { clone, env, dir } = await dishClone()
  await runOk('git', ['worktree', 'add', '-q', '-b', 'dish/one', '.worktrees/one'], { cwd: clone, env })
  const path = join(clone, '.worktrees', 'one')
  // The reviewer's swap: replace the worktree directory with a link at another tracked directory (`<clone>/src`).
  await mkdir(join(clone, 'src'))
  await rm(path, { recursive: true })
  await symlink(join(clone, 'src'), path)
  const result = await checkWorktree(clone, path)
  assert.equal(result.ok, false)
  assert.match(problemOf(result), /is a symbolic link/)
})

test('checkWorktree refuses a rewritten .git file, commondir or gitdir, a config.worktree, and a .git directory', async () => {
  const cases: ReadonlyArray<readonly [(paths: { clone: string, path: string, admin: string, dir: string }) => Promise<unknown>, RegExp]> = [
    [({ path, dir }) => writeFile(join(path, '.git'), `gitdir: ${join(dir, 'elsewhere', '.git')}\n`), /\.git does not point at/],
    [({ path, clone }) => writeFile(join(path, '.git'), `gitdir: ${join(clone, '.git', 'worktrees', 'two')}\n`), /\.git does not point at|not a directory/],
    [({ path, clone }) => writeFile(join(path, '.git'), `gitdir: ${clone}/.git/worktrees/one/../one\n`), /\.git does not point at/],
    [({ path }) => writeFile(join(path, '.git'), 'gitdir: relative/path\n'), /\.git does not point at/],
    [({ path }) => writeFile(join(path, '.git'), 'not a gitdir line\n'), /\.git does not point at/],
    [({ admin }) => writeFile(join(admin, 'commondir'), '../../..\n'), /commondir/],
    [({ admin, dir }) => writeFile(join(admin, 'gitdir'), `${join(dir, 'elsewhere', '.git')}\n`), /gitdir/],
    [({ admin }) => writeFile(join(admin, 'config.worktree'), '[core]\n\tfsmonitor = /x\n'), /config\.worktree/],
    [async ({ path }) => {
      await rm(join(path, '.git'))
      await mkdir(join(path, '.git'))
    }, /\.git is not a regular file/],
  ]
  for (const [plant, expected] of cases) {
    const { clone, env, dir } = await dishClone()
    await runOk('git', ['worktree', 'add', '-q', '-b', 'dish/one', '.worktrees/one'], { cwd: clone, env })
    const path = join(clone, '.worktrees', 'one')
    await plant({ clone, path, admin: join(clone, '.git', 'worktrees', 'one'), dir })
    assert.match(problemOf(await checkWorktree(clone, path)), expected)
  }
})
