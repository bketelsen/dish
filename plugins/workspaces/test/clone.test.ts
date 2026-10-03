import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFile, link, mkdir, readdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  CLONE_TIMEOUT_MS, OnboardError, cloneOrAdopt, configureClone, defaultBranch, fetchClone, httpsUrl, internals, originMatches,
} from '../src/clone.ts'
import type { CloneDeps } from '../src/clone.ts'
import { GITHUB_WEB, botIdentity } from '../src/github.ts'
import { cloneStateFile, helperValue, tokensDir } from '../src/paths.ts'
import { checkClone } from '../src/safety.ts'
import { parseCloneState, readCloneState, writeCloneState } from '../src/state.ts'
import type { CloneState } from '../src/state.ts'
import { HELPER, exists, filesHolding, gitShim, listing, project, startWorld } from './onboard-helpers.ts'
import type { World } from './onboard-helpers.ts'
import { NOSYSTEM, dishHome, run, runOk, scratchGitEnv, tempDir, withEnv } from './helpers.ts'

// The code's own git drops every GIT_* name of process.env; this gives its network gits no system config, as every
// test git has. (Its `git config --file` calls never read one.)
internals.gitEnv = NOSYSTEM

const IDENTITY = botIdentity('dish-test', 9_000_001)
/** Shaped like an installation token; not one. */
const FAKE_TOKEN = `ghs_${'Qw3Er4Ty5U'.repeat(4)}`

/** `body` rejects with an OnboardError at `step`; returns it. */
async function refusedAt(body: Promise<unknown>, step: OnboardError['step']): Promise<OnboardError> {
  try {
    await body
  } catch (error) {
    assert.ok(error instanceof OnboardError, `expected an OnboardError, got ${String(error)}`)
    assert.equal(error.step, step, error.message)
    return error
  }
  assert.fail(`expected an OnboardError at ${step}`)
}

/** Deps for a world: the fake git server is "GitHub", the real helper, the world's token manager holding acme/widget. */
async function depsOf(world: World): Promise<CloneDeps> {
  await world.tokens.setRepositories(new Map([['acme', { installation: 77, repos: ['widget'] }]]))
  return { workRoot: world.workRoot, state: world.state, web: world.git.origin, helper: HELPER, tokens: world.tokens, logger: world.logger }
}

/** Deps with `web` = github.com, for adopting (nothing reaches a network): asking for a token is a failure. */
async function adoptDeps(): Promise<CloneDeps & { dir: string, lines: string[] }> {
  const dir = await tempDir()
  const lines: string[] = []
  return {
    dir,
    lines,
    workRoot: join(dir, 'work'),
    state: join(dir, 'state'),
    web: GITHUB_WEB,
    helper: HELPER,
    tokens: { ensureFileToken: async () => { throw new Error('adopting asked for a token') } },
    logger: { warn: (...args: unknown[]) => { lines.push(args.join(' ')) }, info: (...args: unknown[]) => { lines.push(args.join(' ')) } },
  }
}

/** An existing clone at `<workRoot>/acme/widget`, made by a scratch git, with `origin` at `url`. */
async function existingClone(deps: CloneDeps & { dir: string }, url: string, extra: (git: (...args: string[]) => Promise<string>) => Promise<unknown> = async () => {}): Promise<string> {
  const path = join(deps.workRoot, 'acme', 'widget')
  const env = await scratchGitEnv(deps.dir)
  await runOk('git', ['init', '-q', path], { env })
  const git = (...args: string[]) => runOk('git', ['-C', path, ...args], { env })
  await git('remote', 'add', 'origin', url)
  await writeFile(join(path, 'README.md'), '# widget\n')
  await git('add', '-A')
  await git('commit', '-q', '-m', 'first')
  await extra(git)
  return path
}

/** `git config --file <clone>/.git/config --list`, in file order, by a scratch git. */
async function configList(clone: string, env: Record<string, string>): Promise<string[]> {
  const out = await runOk('git', ['config', '--file', join(clone, '.git', 'config'), '--list'], { env })
  return out.split('\n').filter(line => line !== '')
}

async function helperEntries(clone: string, web: string, env: Record<string, string>): Promise<string[]> {
  const result = await run('git', ['config', '--file', join(clone, '.git', 'config'), '--get-all', `credential.${web}.helper`], { env })
  return result.stdout.split('\n').slice(0, -1)
}

// --- names and the state file ---------------------------------------------------------------------------------------

test('httpsUrl and originMatches: GitHub\'s HTTPS and SSH spellings of the repo, without case, .git optional; nothing else', () => {
  assert.equal(httpsUrl(GITHUB_WEB, 'Acme', 'widget'), 'https://github.com/Acme/widget.git')
  assert.equal(httpsUrl('http://127.0.0.1:9/', 'acme', 'widget'), 'http://127.0.0.1:9/acme/widget.git')
  const yes = [
    'https://github.com/acme/widget.git', 'https://github.com/acme/widget', 'HTTPS://GitHub.com/Acme/Widget.GIT',
    'git@github.com:acme/widget.git', 'git@github.com:Acme/widget', 'ssh://git@github.com/acme/widget.git', 'ssh://git@GITHUB.com/acme/widget',
  ]
  for (const url of yes) assert.equal(originMatches(url, GITHUB_WEB, 'acme', 'widget'), true, url)
  const no = [
    'https://github.com/acme/other.git', 'https://github.com/other/widget.git', 'git@github-dish:acme/widget.git',
    'github-dish:acme/widget.git', 'https://gitlab.com/acme/widget.git', 'http://github.com/acme/widget.git',
    `https://x-access-token:${FAKE_TOKEN}@github.com/acme/widget.git`, 'https://github.com/acme/widget.git/', 'https://github.com/acme/widget.git.git',
    'ssh://git@github.com:2222/acme/widget.git', 'git@github.com:/acme/widget.git', 'file:///srv/acme/widget.git', '/srv/acme/widget.git',
    'https://github.com/acme/widget/x', 'ext::sh -c x', '',
  ]
  for (const url of no) assert.equal(originMatches(url, GITHUB_WEB, 'acme', 'widget'), false, url)
})

test('the clone state round-trips, keeps its messages masked, and a corrupt file reads as none', async () => {
  const dir = await tempDir()
  const file = cloneStateFile(join(dir, 'state'), 'acme', 'widget')
  assert.equal(await readCloneState(file), undefined)
  const state: CloneState = {
    clone: '/w/acme/widget', adopted: false, installation: 77, workspace: { id: 'ws-1', registeredAt: 5 },
    lastFetch: { at: 6, ok: false, message: `fatal: ${FAKE_TOKEN}` },
    setup: { at: 7, ran: false, exitCode: null, timedOut: false, reason: `skipped ${FAKE_TOKEN}` },
  }
  await writeCloneState(file, state)
  assert.equal((await stat(file)).mode & 0o777, 0o600)
  const text = await readFile(file, 'utf8')
  assert.ok(!text.includes('ghs_'), text)
  const back = await readCloneState(file)
  assert.deepEqual({ ...back, lastFetch: { ...back!.lastFetch, message: 'x' }, setup: { ...back!.setup, reason: 'x' } },
    { ...state, lastFetch: { ...state.lastFetch, message: 'x' }, setup: { ...state.setup, reason: 'x' } })
  await writeFile(file, '{"clone": 3}')
  assert.equal(await readCloneState(file), undefined)
  assert.equal(parseCloneState('not json'), undefined)
  assert.equal(parseCloneState(JSON.stringify({ ...state, installation: 'x' })), undefined)
  assert.equal(parseCloneState(JSON.stringify({ ...state, clone: 'relative' })), undefined)
  // An older file without the nullable parts reads with them null.
  assert.deepEqual(parseCloneState(JSON.stringify({ clone: '/w', adopted: true })),
    { clone: '/w', adopted: true, installation: null, workspace: null, lastFetch: null, setup: null })
})

// --- cloning --------------------------------------------------------------------------------------------------------

test('a private repo is cloned through the helper, its token in no argument, URL or environment; then configured as the contract says', async () => {
  const world = await startWorld()
  const deps = await depsOf(world)
  const home = await dishHome(world.dir)
  // A global store helper: the clone's empty entry must keep it from saving the token.
  await appendFile(join(home.HOME!, '.gitconfig'), '[credential]\n\thelper = store\n')
  const shim = await gitShim(world.dir)
  const env = await scratchGitEnv(world.dir)
  await withEnv({ ...home, PATH: shim.path }, async () => {
    const { clone, adopted } = await cloneOrAdopt(project(), deps)
    assert.equal(adopted, false)
    assert.equal(clone, await realpath(join(world.workRoot, 'acme', 'widget')))
    assert.equal(await readFile(join(clone, 'README.md'), 'utf8'), '# widget\n')
    // The owner directory is 0700, and holds the clone and nothing else (the temporary directory was renamed away).
    assert.equal((await stat(join(world.workRoot, 'acme'))).mode & 0o777, 0o700)
    assert.deepEqual(await readdir(join(world.workRoot, 'acme')), ['widget'])
    // The clone went through the helper: unauthenticated first, then with the read token.
    assert.ok(world.git.requests.some(request => request.level === 'read' && request.service === 'git-upload-pack' && request.status === 200))

    await configureClone(clone, project(), IDENTITY, deps)
    await configureClone(clone, project(), IDENTITY, deps)
    const web = world.git.origin
    const value = helperValue(HELPER, tokensDir(world.state), web)
    const url = `${web}/acme/widget.git`
    assert.deepEqual(await configList(clone, env), [
      'core.repositoryformatversion=0', 'core.filemode=true', 'core.bare=false', 'core.logallrefupdates=true',
      `remote.origin.url=${url}`, 'remote.origin.fetch=+refs/heads/*:refs/remotes/origin/*',
      'branch.main.remote=origin', 'branch.main.merge=refs/heads/main',
      'credential.interactive=false',
      'user.name=dish-test[bot]', 'user.email=9000001+dish-test[bot]@users.noreply.github.com',
      `credential.${web}.helper=`, `credential.${web}.helper=${value}`, `credential.${web}.usehttppath=true`,
    ])
    // Idempotent to the byte: a third call changes nothing.
    const text = await readFile(join(clone, '.git', 'config'), 'utf8')
    await configureClone(clone, project(), IDENTITY, deps)
    assert.equal(await readFile(join(clone, '.git', 'config'), 'utf8'), text)
    assert.deepEqual(await helperEntries(clone, web, env), ['', value])
    const exclude = await readFile(join(clone, '.git', 'info', 'exclude'), 'utf8')
    assert.equal(exclude.split('\n').filter(line => line === '.worktrees/').length, 1)
    assert.deepEqual(await withEnv(home, () => checkClone(clone, { url, helper: value, web })), { ok: true })

    // No token under .git, in the home (no ~/.git-credentials), in a git's arguments or environment, or in a logged line.
    assert.deepEqual(await filesHolding(join(clone, '.git'), 'ghs_'), [])
    assert.equal(await exists(join(home.HOME!, '.git-credentials')), false)
    assert.deepEqual(await filesHolding(home.HOME!, 'ghs_'), [])
    const started = await shim.lines()
    const cloneLine = started.find(line => / clone /.test(line))
    assert.ok(cloneLine !== undefined, started.join('\n'))
    assert.ok(cloneLine.includes(` ${url} `), cloneLine)
    assert.ok(cloneLine.includes(`credential.${web}.helper=${value}`), 'the helper is given with -c only')
    for (const line of started) {
      assert.ok(!line.includes('ghs_'), `a git's arguments hold a token: ${line}`)
      assert.notEqual(line, 'ENV-LEAK', 'a git\'s environment held a token')
    }
    for (const line of world.lines) assert.ok(!line.includes('ghs_'), line)
    assert.ok(!JSON.stringify(world.git.requests).includes('ghs_'))
  })
})

test('a failed clone removes its temporary directory and only it; the owner directory and what is in it stay', async () => {
  const world = await startWorld({ tokensWork: false })
  const deps = await depsOf(world)
  const owner = join(world.workRoot, 'acme')
  await mkdir(join(owner, 'other'), { recursive: true })
  await writeFile(join(owner, 'other', 'keep.txt'), 'mine\n')
  const before = await listing(join(owner, 'other'))
  await withEnv(await dishHome(world.dir), async () => {
    const error = await refusedAt(cloneOrAdopt(project(), deps), 'clone')
    assert.ok(!error.message.includes('ghs_'), error.message)
    assert.match(error.message, /acme\/widget/)
  })
  assert.deepEqual(await readdir(owner), ['other'])
  assert.deepEqual(await listing(join(owner, 'other')), before)
  // The server refused it (no token it knows), and it gave up rather than prompting.
  assert.ok(world.git.requests.length > 0 && world.git.requests.every(request => request.status === 401))
})

test('an aborted clone ends git\'s process group and removes the temporary directory', async () => {
  const world = await startWorld()
  const deps = await depsOf(world)
  const shim = await gitShim(world.dir, { holdClone: true })
  const controller = new AbortController()
  await withEnv({ ...await dishHome(world.dir), PATH: shim.path }, async () => {
    const cloning = cloneOrAdopt(project(), deps, controller.signal)
    const deadline = Date.now() + 10_000
    while (!(await shim.lines()).some(line => / clone /.test(line))) {
      assert.ok(Date.now() < deadline, 'the clone never started')
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    const temporary = (await readdir(join(world.workRoot, 'acme'))).filter(name => name.startsWith('.widget.cloning-'))
    assert.equal(temporary.length, 1)
    assert.match(temporary[0]!, /^\.widget\.cloning-[0-9a-f]{8}$/)
    const started = Date.now()
    controller.abort()
    await assert.rejects(cloning, (error: Error) => error.name === 'AbortError')
    assert.ok(Date.now() - started < 5_000)
  })
  assert.deepEqual(await readdir(join(world.workRoot, 'acme')), [])
  assert.ok(CLONE_TIMEOUT_MS >= 10 * 60_000)
})

// --- adopting -------------------------------------------------------------------------------------------------------

test('an HTTPS clone already there is adopted as it is, with nothing written', async () => {
  const deps = await adoptDeps()
  const path = await existingClone(deps, 'https://github.com/acme/widget.git')
  const before = await listing(path)
  await withEnv(await dishHome(deps.dir), async () => {
    assert.deepEqual(await cloneOrAdopt(project(), deps), { clone: await realpath(path), adopted: true })
  })
  assert.deepEqual(await listing(path), before)
})

test('an SSH origin (git@ or ssh://), or another spelling of the HTTPS one, is adopted and switched to the HTTPS URL', async () => {
  for (const url of ['git@github.com:acme/widget.git', 'ssh://git@github.com/Acme/Widget', 'https://GitHub.com/acme/widget']) {
    const deps = await adoptDeps()
    const path = await existingClone(deps, url)
    const env = await scratchGitEnv(deps.dir)
    await withEnv(await dishHome(deps.dir), async () => {
      assert.deepEqual(await cloneOrAdopt(project(), deps), { clone: await realpath(path), adopted: true })
    })
    assert.equal((await runOk('git', ['-C', path, 'config', '--get-all', 'remote.origin.url'], { env })).trim(), 'https://github.com/acme/widget.git', url)
  }
})

test('a husky clone (core.hooksPath set by its prepare) is adopted', async () => {
  const deps = await adoptDeps()
  const path = await existingClone(deps, 'https://github.com/acme/widget.git', git => git('config', 'core.hooksPath', '.husky/_'))
  await withEnv(await dishHome(deps.dir), async () => {
    assert.equal((await cloneOrAdopt(project(), deps)).adopted, true)
  })
})

test('a clone with dish\'s helper from an old checkout (before a dish-update) is adopted, and configuring it rewrites the pair', async () => {
  const deps = await adoptDeps()
  const old = helperValue('/old/checkout/plugins/workspaces/bin/git-credential-dish', '/old/state/workspaces/tokens', GITHUB_WEB)
  const path = await existingClone(deps, 'https://github.com/acme/widget.git', async git => {
    await git('config', '--add', 'credential.https://github.com.helper', '')
    await git('config', '--add', 'credential.https://github.com.helper', old)
    await git('config', 'credential.https://github.com.useHttpPath', 'true')
  })
  const env = await scratchGitEnv(deps.dir)
  const current = helperValue(HELPER, tokensDir(deps.state), GITHUB_WEB)
  await withEnv(await dishHome(deps.dir), async () => {
    const { clone } = await cloneOrAdopt(project(), deps)
    // The old value would fail the check with today's helper: configuring replaces the pair first, then checks.
    assert.equal((await checkClone(clone, { url: 'https://github.com/acme/widget.git', helper: current, web: GITHUB_WEB })).ok, false)
    await configureClone(clone, project(), IDENTITY, deps)
    assert.deepEqual(await helperEntries(clone, GITHUB_WEB, env), ['', current])
    assert.deepEqual(await checkClone(clone, { url: 'https://github.com/acme/widget.git', helper: current, web: GITHUB_WEB }), { ok: true })
    // A key changed by hand is put back.
    await runOk('git', ['-C', clone, 'config', 'user.name', 'someone'], { env })
    await configureClone(clone, project(), IDENTITY, deps)
    assert.equal((await runOk('git', ['-C', clone, 'config', 'user.name'], { env })).trim(), 'dish-test[bot]')
    assert.deepEqual(await helperEntries(clone, GITHUB_WEB, env), ['', current])
  })
})

test('anything else at the path is refused with what was found, and left byte for byte as it was', async () => {
  type Case = { name: string, make: (deps: CloneDeps & { dir: string }) => Promise<string>, finding: RegExp }
  const cases: Case[] = [
    { name: 'an SSH host alias', make: deps => existingClone(deps, 'git@github-dish:acme/widget.git'), finding: /github-dish/ },
    { name: 'another repository', make: deps => existingClone(deps, 'https://github.com/acme/other.git'), finding: /acme\/other/ },
    { name: 'no origin', make: deps => existingClone(deps, 'https://github.com/acme/widget.git', git => git('remote', 'remove', 'origin')), finding: /no origin/ },
    {
      name: 'two origin URLs',
      make: deps => existingClone(deps, 'https://github.com/acme/widget.git', git => git('config', '--add', 'remote.origin.url', 'https://github.com/acme/widget.git')),
      finding: /more than one/,
    },
    { name: 'a key dish refuses', make: deps => existingClone(deps, 'https://github.com/acme/widget.git', git => git('config', 'core.fsmonitor', 'touch /tmp/x')), finding: /core\.fsmonitor/ },
    {
      name: 'a planted helper for another origin',
      make: deps => existingClone(deps, 'https://github.com/acme/widget.git', git => git('config', 'credential.https://evil.example.helper', '!touch /tmp/x')),
      finding: /another origin/,
    },
    {
      name: 'a planted refspec',
      make: deps => existingClone(deps, 'https://github.com/acme/widget.git', git => git('config', 'remote.origin.fetch', '+refs/heads/*:refs/heads/*')),
      finding: /remote\.origin\.fetch/,
    },
    {
      name: 'a plain directory',
      make: async deps => {
        const path = join(deps.workRoot, 'acme', 'widget')
        await mkdir(path, { recursive: true })
        await writeFile(join(path, 'notes.txt'), 'mine\n')
        return path
      },
      finding: /isn't a clone|no \.git/,
    },
    {
      name: 'a file',
      make: async deps => {
        await mkdir(join(deps.workRoot, 'acme'), { recursive: true })
        const path = join(deps.workRoot, 'acme', 'widget')
        await writeFile(path, 'not a directory\n')
        return path
      },
      finding: /not a directory/,
    },
    {
      name: 'a symbolic link to a clone',
      make: async deps => {
        const target = await existingClone(deps, 'https://github.com/acme/widget.git')
        const moved = join(deps.workRoot, 'acme', 'real-widget')
        await rename(target, moved)
        await symlink(moved, target)
        return target
      },
      finding: /symbolic link/,
    },
    {
      name: 'a linked worktree (.git a file)',
      make: async deps => {
        const main = await existingClone(deps, 'https://github.com/acme/widget.git')
        const moved = join(deps.workRoot, 'acme', 'main')
        await rename(main, moved)
        const env = await scratchGitEnv(deps.dir)
        await runOk('git', ['-C', moved, 'worktree', 'add', '-q', '-b', 'side', main], { env })
        return main
      },
      finding: /\.git is not a directory/,
    },
  ]
  for (const item of cases) {
    const deps = await adoptDeps()
    const path = await item.make(deps)
    const owner = join(deps.workRoot, 'acme')
    const before = await listing(owner)
    await withEnv(await dishHome(deps.dir), async () => {
      const error = await refusedAt(cloneOrAdopt(project(), deps), 'clone')
      assert.match(error.message, item.finding, `${item.name}: ${error.message}`)
      assert.ok(error.message.includes(path), `${item.name}: ${error.message}`)
    })
    assert.deepEqual(await listing(owner), before, item.name)
  }
})

test('an owner directory that leads out of the work root is refused, with nothing written there or outside', async () => {
  for (const withClone of [true, false]) {
    const deps = await adoptDeps()
    const outside = join(deps.dir, 'outside')
    if (withClone) {
      // A clone dish would adopt, but outside the work root: <work root>/acme is a link to where it is.
      await existingClone(deps, 'https://github.com/acme/widget.git')
      await rename(join(deps.workRoot, 'acme'), outside)
    } else {
      await mkdir(outside, { recursive: true })
      await mkdir(deps.workRoot, { recursive: true })
    }
    await symlink(outside, join(deps.workRoot, 'acme'))
    const before = { root: await listing(deps.workRoot), outside: await listing(outside) }
    await withEnv(await dishHome(deps.dir), async () => {
      const error = await refusedAt(cloneOrAdopt(project(), deps), 'clone')
      assert.match(error.message, /outside the work root/, error.message)
    })
    assert.deepEqual({ root: await listing(deps.workRoot), outside: await listing(outside) }, before, `with a clone: ${withClone}`)
  }
})

// --- configuring ----------------------------------------------------------------------------------------------------

test('configureClone writes nothing through a .git/config that is a symbolic link', async () => {
  const deps = await adoptDeps()
  const path = await existingClone(deps, 'https://github.com/acme/widget.git')
  const outside = join(deps.dir, 'outside-config')
  await rename(join(path, '.git', 'config'), outside)
  await symlink(outside, join(path, '.git', 'config'))
  const before = await readFile(outside, 'utf8')
  await withEnv(await dishHome(deps.dir), async () => {
    const error = await refusedAt(configureClone(path, project(), IDENTITY, deps), 'configure')
    assert.match(error.message, /\.git\/config/)
  })
  assert.equal(await readFile(outside, 'utf8'), before)
})

test('configureClone refuses a clone whose config has a key dish refuses, naming it', async () => {
  const deps = await adoptDeps()
  const path = await existingClone(deps, 'https://github.com/acme/widget.git', git => git('config', 'filter.lfs.smudge', 'touch /tmp/x'))
  await withEnv(await dishHome(deps.dir), async () => {
    const error = await refusedAt(configureClone(path, project(), IDENTITY, deps), 'configure')
    assert.match(error.message, /filter\.lfs\.smudge/)
  })
})

/**
 * Run `body` with `internals.beforeWrite` set to `swap` for the first `times` writes to `target` (then cleared): the
 * moment after dish has written its new file and before its last checks and the rename, where an agent racing dish
 * would swap the file.
 */
async function racing<T>(target: string, swap: () => Promise<void>, body: () => Promise<T>, times = 1): Promise<T> {
  let swapped = 0
  internals.beforeWrite = async (file: string) => {
    if (swapped >= times || file !== target) return
    swapped++
    await swap()
  }
  try {
    const result = await body()
    assert.equal(swapped, times, `not as many writes to ${target} as swaps`)
    return result
  } finally {
    delete internals.beforeWrite
  }
}

test('a .git/config swapped for a link (or a hard link) between dish\'s read and its write is refused, and the other file is untouched', async () => {
  const swaps: Array<[string, (config: string, outside: string) => Promise<void>]> = [
    ['a symbolic link', async (config, outside) => { await rm(config); await symlink(outside, config) }],
    ['a hard link', async (config, outside) => { await rm(config); await link(outside, config) }],
  ]
  for (const [name, swap] of swaps) {
    const deps = await adoptDeps()
    const path = await existingClone(deps, 'https://github.com/acme/widget.git')
    // Another repository's config the account can write (the config store's, say).
    const outside = join(deps.dir, 'store-config')
    await writeFile(outside, '[core]\n\tbare = false\n[remote "origin"]\n\turl = git@example.invalid:store.git\n')
    const before = await listing(outside)
    const config = join(path, '.git', 'config')
    await withEnv(await dishHome(deps.dir), async () => {
      const error = await racing(config, () => swap(config, outside), () => refusedAt(configureClone(path, project(), IDENTITY, deps), 'configure'))
      assert.match(error.message, /\.git\/config/, `${name}: ${error.message}`)
    })
    // Its content and mode as they were (a hard link's ctime moves with the link count, so not that).
    const [after] = await listing(outside)
    assert.equal(after!.split(' ').filter((_, i) => i !== 5).join(' '), before[0]!.split(' ').filter((_, i) => i !== 5).join(' '), name)
  }
})

test('a .git/config another git replaced between dish\'s read and its write is read again once; replaced twice, it is refused and left as it is', async () => {
  const deps = await adoptDeps()
  const path = await existingClone(deps, 'https://github.com/acme/widget.git')
  const config = join(path, '.git', 'config')
  const env = await scratchGitEnv(deps.dir)
  /** What an agent's `git config pull.rebase <value>` does: a new file renamed over the old one. */
  const theirs = (value: string) => async () => {
    const fresh = join(deps.dir, 'fresh-config')
    await writeFile(fresh, `${await readFile(config, 'utf8')}[pull]\n\trebase = ${value}\n`)
    await rename(fresh, config)
  }
  await withEnv(await dishHome(deps.dir), async () => {
    await racing(config, theirs('true'), () => configureClone(path, project(), IDENTITY, deps))
    // Their change is kept, and dish's keys are there.
    assert.equal((await runOk('git', ['config', '--file', config, 'pull.rebase'], { env })).trim(), 'true')
    assert.equal((await runOk('git', ['config', '--file', config, 'user.name'], { env })).trim(), 'dish-test[bot]')

    await runOk('git', ['config', '--file', config, 'user.name', 'someone'], { env })
    const error = await racing(config, theirs('merges'), () => refusedAt(configureClone(path, project(), IDENTITY, deps), 'configure'), 2)
    assert.match(error.message, /\.git\/config was replaced/)
  })
  assert.equal((await runOk('git', ['config', '--file', config, 'user.name'], { env })).trim(), 'someone')
  assert.deepEqual((await readdir(join(path, '.git'))).filter(name => name.endsWith('.lock')), [])
})

test('a .git/config edited in place between dish\'s read and the rename is read again, and the edit kept', async () => {
  const deps = await adoptDeps()
  const path = await existingClone(deps, 'https://github.com/acme/widget.git')
  const config = join(path, '.git', 'config')
  const env = await scratchGitEnv(deps.dir)
  await withEnv(await dishHome(deps.dir), async () => {
    // `>>`: the same file (device and inode), longer.
    await racing(config, () => appendFile(config, '[pull]\n\trebase = true\n'), () => configureClone(path, project(), IDENTITY, deps))
  })
  assert.equal((await runOk('git', ['config', '--file', config, 'pull.rebase'], { env })).trim(), 'true')
  assert.equal((await runOk('git', ['config', '--file', config, 'user.name'], { env })).trim(), 'dish-test[bot]')
})

test('a crash after dish wrote its new config, before the rename, leaves .git/config byte for byte as it was and no lock', async () => {
  const deps = await adoptDeps()
  const path = await existingClone(deps, 'https://github.com/acme/widget.git')
  const config = join(path, '.git', 'config')
  const before = await listing(config)
  await withEnv(await dishHome(deps.dir), async () => {
    internals.beforeWrite = async (file: string) => {
      assert.equal(await readFile(join(path, '.git', 'config.lock'), 'utf8') !== '', true, 'the new config is in the lock')
      if (file === config) throw new Error('simulated crash')
    }
    try {
      await assert.rejects(configureClone(path, project(), IDENTITY, deps), /simulated crash/)
    } finally {
      delete internals.beforeWrite
    }
  })
  assert.deepEqual(await listing(config), before)
  assert.equal(await exists(join(path, '.git', 'config.lock')), false)
})

test('a config.lock an agent holds: dish tries once more, and refuses without touching the lock if it is still held', async () => {
  const deps = await adoptDeps()
  const path = await existingClone(deps, 'https://github.com/acme/widget.git')
  const config = join(path, '.git', 'config')
  const lock = join(path, '.git', 'config.lock')
  const before = await readFile(config, 'utf8')
  await writeFile(lock, 'an agent\'s git config at work\n')
  await withEnv(await dishHome(deps.dir), async () => {
    const error = await refusedAt(configureClone(path, project(), IDENTITY, deps), 'configure')
    assert.match(error.message, /\.git\/config\.lock is held; if no git is running in the clone, remove \S*\.git\/config\.lock/)
    assert.equal(await readFile(lock, 'utf8'), 'an agent\'s git config at work\n')
    assert.equal(await readFile(config, 'utf8'), before)

    // Released before the second try: dish goes on.
    let retried = 0
    internals.onRetry = async () => {
      retried++
      await rm(lock)
    }
    try {
      await configureClone(path, project(), IDENTITY, deps)
    } finally {
      delete internals.onRetry
    }
    assert.equal(retried, 1)
    assert.notEqual(await readFile(config, 'utf8'), before)
  })
})

test('files a dedup tool hard-linked across clones are fine while dish has nothing to write to them', async () => {
  const deps = await adoptDeps()
  const path = await existingClone(deps, 'https://github.com/acme/widget.git')
  const env = await scratchGitEnv(deps.dir)
  await withEnv(await dishHome(deps.dir), async () => {
    await configureClone(path, project(), IDENTITY, deps)
    const others = { config: join(deps.dir, 'dedup-config'), exclude: join(deps.dir, 'dedup-exclude') }
    await link(join(path, '.git', 'config'), others.config)
    await link(join(path, '.git', 'info', 'exclude'), others.exclude)
    const before = { config: await readFile(others.config, 'utf8'), exclude: await readFile(others.exclude, 'utf8') }
    await configureClone(path, project(), IDENTITY, deps)
    assert.deepEqual({ config: await readFile(others.config, 'utf8'), exclude: await readFile(others.exclude, 'utf8') }, before)
    // Once there is something to write, the link is refused.
    await runOk('git', ['config', '--file', join(path, '.git', 'config'), 'user.name', 'someone'], { env })
    await rm(others.config)
    await link(join(path, '.git', 'config'), others.config)
    const error = await refusedAt(configureClone(path, project(), IDENTITY, deps), 'configure')
    assert.match(error.message, /hard link/)
  })
})

test('a .git swapped for a link between dish\'s read and its write is refused, and the linked-to config is untouched', async () => {
  const deps = await adoptDeps()
  const path = await existingClone(deps, 'https://github.com/acme/widget.git')
  const outside = join(deps.dir, 'store-git')
  await mkdir(outside)
  await writeFile(join(outside, 'config'), '[core]\n\tbare = false\n')
  const before = await listing(outside)
  const config = join(path, '.git', 'config')
  await withEnv(await dishHome(deps.dir), async () => {
    const error = await racing(config, async () => {
      await rename(join(path, '.git'), join(path, '.git-real'))
      await symlink(outside, join(path, '.git'))
    }, () => refusedAt(configureClone(path, project(), IDENTITY, deps), 'configure'))
    assert.match(error.message, /\.git/)
  })
  assert.deepEqual(await listing(outside), before)
})

test('a .git/config with another hard link is refused before anything is written', async () => {
  const deps = await adoptDeps()
  const path = await existingClone(deps, 'https://github.com/acme/widget.git')
  const other = join(deps.dir, 'other-link')
  await link(join(path, '.git', 'config'), other)
  const before = await readFile(other, 'utf8')
  await withEnv(await dishHome(deps.dir), async () => {
    const error = await refusedAt(configureClone(path, project(), IDENTITY, deps), 'configure')
    assert.match(error.message, /hard link/)
  })
  assert.equal(await readFile(other, 'utf8'), before)
})

test('a .git/info/exclude swapped for a link before dish appends to it is refused, and the target is untouched', async () => {
  const deps = await adoptDeps()
  const path = await existingClone(deps, 'https://github.com/acme/widget.git')
  const outside = join(deps.dir, 'outside-file')
  await writeFile(outside, 'mine\n')
  const before = await listing(outside)
  const exclude = join(path, '.git', 'info', 'exclude')
  await withEnv(await dishHome(deps.dir), async () => {
    const error = await racing(exclude, async () => { await rm(exclude); await symlink(outside, exclude) },
      () => refusedAt(configureClone(path, project(), IDENTITY, deps), 'configure'))
    assert.match(error.message, /exclude/)
  })
  assert.deepEqual(await listing(outside), before)
})

// --- fetching -------------------------------------------------------------------------------------------------------

/** A world with acme/widget cloned and configured, and a scratch git env. */
async function cloned(): Promise<{ world: World, deps: CloneDeps, clone: string, env: Record<string, string>, home: Record<string, string> }> {
  const world = await startWorld()
  const deps = await depsOf(world)
  const home = await dishHome(world.dir)
  const clone = await withEnv(home, async () => {
    const { clone } = await cloneOrAdopt(project(), deps)
    await configureClone(clone, project(), IDENTITY, deps)
    return clone
  })
  return { world, deps, clone, env: await scratchGitEnv(world.dir), home }
}

/** A new commit on the bare repo's main, by a scratch git over file://. Its sha. */
async function commitUpstream(world: World, env: Record<string, string>, name: string): Promise<string> {
  const work = join(world.dir, `upstream-${name}`)
  await runOk('git', ['clone', '-q', `file://${world.bare}`, work], { env })
  await writeFile(join(work, `${name}.txt`), `${name}\n`)
  await runOk('git', ['-C', work, 'add', '-A'], { env })
  await runOk('git', ['-C', work, 'commit', '-q', '-m', name], { env })
  await runOk('git', ['-C', work, 'push', '-q', 'origin', 'HEAD:main'], { env })
  return (await runOk('git', ['-C', work, 'rev-parse', 'HEAD'], { env })).trim()
}

test('fetchClone fetches with the fixed refspec (pruning a hand-written origin ref), sets origin/HEAD when missing, and records lastFetch', async () => {
  const { world, deps, clone, env, home } = await cloned()
  const file = cloneStateFile(world.state, 'acme', 'widget')
  await writeCloneState(file, { clone, adopted: false, installation: 77, workspace: { id: 'ws', registeredAt: 1 }, lastFetch: null, setup: null })
  const upstream = await commitUpstream(world, env, 'second')
  const head = (await runOk('git', ['-C', clone, 'rev-parse', 'HEAD'], { env })).trim()
  await runOk('git', ['-C', clone, 'update-ref', 'refs/remotes/origin/planted', head], { env })
  await runOk('git', ['-C', clone, 'symbolic-ref', '--delete', 'refs/remotes/origin/HEAD'], { env })
  // An agent removed origin's refspec (the check allows a remote without one): a plain `fetch origin` would then update
  // no origin ref, and prune none. The refspec on the command line does both.
  await runOk('git', ['-C', clone, 'config', '--unset', 'remote.origin.fetch'], { env })
  await withEnv(home, async () => {
    assert.equal(await defaultBranch(clone), undefined)
    const before = Date.now()
    await fetchClone(clone, project(), deps)
    assert.equal((await runOk('git', ['-C', clone, 'rev-parse', 'origin/main'], { env })).trim(), upstream)
    const planted = await run('git', ['-C', clone, 'rev-parse', '--verify', '-q', 'refs/remotes/origin/planted'], { env })
    assert.notEqual(planted.code, 0, 'the hand-written origin ref survived the fetch')
    assert.equal(await defaultBranch(clone), 'main')
    const state = await readCloneState(file)
    assert.equal(state?.lastFetch?.ok, true)
    assert.ok(state!.lastFetch!.at >= before)
    assert.deepEqual(state?.workspace, { id: 'ws', registeredAt: 1 })
    assert.equal(state?.installation, 77)
  })
})

test('a failed fetch is recorded, masked, and thrown; a clone that fails the check is never fetched', async () => {
  const { world, deps, clone, env, home } = await cloned()
  const file = cloneStateFile(world.state, 'acme', 'widget')
  await withEnv(home, async () => {
    // No state file yet: one is made.
    world.git.tokens.clear()
    await assert.rejects(fetchClone(clone, project(), deps), (error: Error) => !error.message.includes('ghs_'))
    const failed = await readCloneState(file)
    assert.equal(failed?.lastFetch?.ok, false)
    assert.ok((failed?.lastFetch?.message ?? '') !== '')
    assert.ok(!JSON.stringify(failed).includes('ghs_'))

    await runOk('git', ['-C', clone, 'config', 'core.fsmonitor', 'touch /tmp/x'], { env })
    const requests = world.git.requests.length
    await assert.rejects(fetchClone(clone, project(), deps), /core\.fsmonitor/)
    assert.equal(world.git.requests.length, requests, 'a refused clone reached the server')
    assert.match((await readCloneState(file))?.lastFetch?.message ?? '', /core\.fsmonitor/)
  })
  for (const line of world.lines) assert.ok(!line.includes('ghs_'), line)
})

test('an origin/HEAD an agent repointed is put back by the next fetch', async () => {
  const { deps, clone, env, home } = await cloned()
  const head = (await runOk('git', ['-C', clone, 'rev-parse', 'HEAD'], { env })).trim()
  await runOk('git', ['-C', clone, 'update-ref', 'refs/remotes/origin/agent', head], { env })
  await runOk('git', ['-C', clone, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/agent'], { env })
  await withEnv(home, async () => {
    assert.equal(await defaultBranch(clone), 'agent')
    await fetchClone(clone, project(), deps)
    assert.equal(await defaultBranch(clone), 'main')
  })
})
