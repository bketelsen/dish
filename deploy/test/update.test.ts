/**
 * `deploy/update.sh`, run against a fake host (./host.ts): a bare repo for GitHub, a clone of it as the checkout, and
 * stubs for `id`, `getent`, `runuser`, `systemctl`, `journalctl`, `curl` and `pnpm`. install.sh is a stub that records
 * what it was given. Nothing here touches the real system's services, a real home, or the VM.
 *
 * update.sh runs only as the account (root's entry point is fleet's dish-update wrapper), so runs are the account's
 * unless a test says otherwise.
 *
 * What matters most:
 * - it never half-updates: every refusal comes before the first change, and the stamp is written only after dsh answers;
 * - it restarts exactly when the service is stale, stopped, or install.sh changed the profile, and reloads the user
 *   manager whenever it may hold another definition of the unit;
 * - install.sh gets the unit's environment and install.env's three inputs, and nothing of the caller's;
 * - it never runs as root;
 * - it prints no line that mentions a token.
 */

import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createHost, DEPLOY_ENV, git, INPUTS, INSTALL_ENV, LEAKED, PNPM_VERSION, removeHosts } from './host.ts'
import type { Host, HostOptions, Result } from './host.ts'

const execFileAsync = promisify(execFile)
const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const UPDATE = join(ROOT, 'deploy', 'update.sh')

after(removeHosts)

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

/** The names install.sh may see: the clean environment, its three inputs, and what bash adds to any environment. */
const INSTALL_NAMES = ['DISH_REMOTE', 'DISH_USER_EMAIL', 'DISH_USER_NAME', 'HOME', 'LANG', 'LOGNAME', 'PATH', 'TMPDIR', 'USER', 'XDG_RUNTIME_DIR']
const BASH_NAMES = ['OLDPWD', 'PWD', 'SHLVL', '_']

const CHANGING_VERBS = ['restart', 'enable', 'daemon-reload']

/** The journal read as the account, for the tail. */
const JOURNAL_ARGS = ['--user', '-u', 'dish-web.service', '-n', '15', '-q', '--no-pager', '-o', 'short-iso']
const JOURNAL_HEADER = 'update: journal (last 15 lines, credential lines removed):'
const URL_HINT = 'update: run dish-url for a fresh sign-in link (incus exec dish --project dish -- dish-url)'

/** systemctl's changing verbs in the order they were called. */
function systemdSequence(host: Host): string[] {
  return host.calls('systemctl').flatMap((argv) => argv.filter((arg) => CHANGING_VERBS.includes(arg)))
}

/** systemctl calls with one of the verbs that change something, per verb. */
function systemdChanges(host: Host): Record<string, number> {
  const counts: Record<string, number> = { restart: 0, enable: 0, 'daemon-reload': 0 }
  for (const argv of host.calls('systemctl')) {
    const verb = argv.find((arg) => CHANGING_VERBS.includes(arg))
    if (verb !== undefined) counts[verb] += 1
  }
  return counts
}

interface Snapshot {
  head: string
  branch: string
  installs: number
  systemd: Record<string, number>
  unit: string | undefined
  stamp: string | undefined
  work: boolean
}

async function snapshot(host: Host): Promise<Snapshot> {
  return {
    head: await host.head(),
    branch: (await git(host.checkout, 'rev-parse', '--abbrev-ref', 'HEAD')).trim(),
    installs: host.installs().length,
    systemd: systemdChanges(host),
    unit: host.installedUnit(),
    stamp: host.stamp(),
    work: existsSync(join(host.home, 'work')),
  }
}

/** Nothing changed: HEAD, no install.sh run, no restart, enable or daemon-reload, the same unit and stamp, no new ~/work. */
async function assertUnchanged(host: Host, before: Snapshot): Promise<void> {
  assert.deepEqual(await snapshot(host), before)
}

/** A host with one upstream commit beyond the seed, so an --apply has something to do. */
async function hostWithUpdate(): Promise<{ host: Host, sha: string }> {
  const host = await createHost()
  const sha = await host.commit({ 'README.md': 'the second commit\n' }, 'the second commit')
  return { host, sha }
}

/** A host that has been through one successful --apply. */
async function appliedHost(): Promise<Host> {
  const { host } = await hostWithUpdate()
  const result = await host.run('update.sh', ['--apply'])
  assert.equal(result.code, 0, result.stderr)
  return host
}

async function short(host: Host, sha: string): Promise<string> {
  return (await git(host.checkout, 'rev-parse', '--short', sha)).trim()
}

function stdoutLines(result: Result): string[] {
  return result.stdout.split('\n').filter((line) => line !== '')
}

function assertOk(result: Result): void {
  assert.equal(result.code, 0, `exit ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
}

/** Every line update.sh printed, on either stream, is free of the word, in any letter case. */
function assertNoTokenLine(result: Result): void {
  for (const line of `${result.stdout}\n${result.stderr}`.split('\n')) assert.doesNotMatch(line, /token/i)
}

// --- The dry run -------------------------------------------------------------------------------------------------

test('the dry run reports what --apply would do, and changes nothing', async () => {
  const { host, sha } = await hostWithUpdate()
  const before = await snapshot(host)
  const result = await host.run('update.sh', [])
  assertOk(result)
  assert.deepEqual(stdoutLines(result), [
    `update: HEAD ${host.seed} (main)`,
    `update: target ${sha} (origin/main)`,
    'update: 1 commit to apply',
    `  ${await short(host, sha)} the second commit`,
    'update: unit: not installed',
    'update: deploy.env: no record of a start',
    'update: install.env: no record of a start',
    'update: restart: needed (no record of a start)',
    'update: dry run; run with --apply to update',
  ])
  assert.equal(result.stderr, '')
  await assertUnchanged(host, before)
  assert.equal(host.installs().length, 0)
})

test('the dry run of an applied host says nothing is needed', async () => {
  const host = await appliedHost()
  const result = await host.run('update.sh', [])
  assertOk(result)
  assert.deepEqual(stdoutLines(result).slice(2), [
    'update: already at the target',
    'update: unit: same',
    'update: deploy.env: same as the last start',
    'update: install.env: same as the last start',
    'update: restart: not needed',
    'update: dry run; run with --apply to update',
  ])
})

test('the dry run refuses what --apply would refuse, after its report', async () => {
  const { host } = await hostWithUpdate()
  await writeFile(join(host.checkout, 'README.md'), 'a local edit\n')
  const before = await snapshot(host)
  const result = await host.run('update.sh', [])
  assert.equal(result.code, 1)
  assert.match(result.stdout, /^update: restart: needed \(no record of a start\)$/m)
  assert.doesNotMatch(result.stdout, /dry run; run with --apply/)
  assert.match(result.stderr, /^update: the checkout has local changes/m)
  assert.match(result.stderr, /^update: FAILED at step: checking the checkout \(exit 1\)$/m)
  await assertUnchanged(host, before)
})

// --- --apply -----------------------------------------------------------------------------------------------------

test('--apply to a new upstream commit installs, starts, waits and stamps', async () => {
  const { host, sha } = await hostWithUpdate()
  const result = await host.run('update.sh', ['--apply'])
  assertOk(result)

  assert.equal(await host.head(), sha)
  assert.equal((await git(host.checkout, 'rev-parse', '--abbrev-ref', 'HEAD')).trim(), 'main')

  const installs = host.installs()
  assert.equal(installs.length, 1)
  assert.deepEqual(installs[0].env, INPUTS)

  const unit = await readFile(join(host.checkout, 'deploy', 'dish-web.service'), 'utf8')
  assert.equal(host.installedUnit(), unit)
  assert.equal(statSync(join(host.home, '.config', 'systemd', 'user', 'dish-web.service')).mode & 0o777, 0o644)
  assert.deepEqual(systemdChanges(host), { restart: 1, enable: 1, 'daemon-reload': 1 })
  assert.deepEqual(systemdSequence(host), ['daemon-reload', 'enable', 'restart'])
  assert.equal(host.service().startedWith, unit, 'the restart used the installed unit')

  const { stdout: nodeVersion } = await execFileAsync(process.execPath, ['--version'], { encoding: 'utf8' })
  assert.equal(host.stamp(), [
    `revision ${sha}`,
    `unit ${sha256(unit)}`,
    `deploy.env ${sha256(DEPLOY_ENV)}`,
    `install.env ${sha256(INSTALL_ENV)}`,
    `node ${nodeVersion.trim()}`,
    `pnpm ${PNPM_VERSION}`,
  ].join('\n') + '\n')

  const work = statSync(join(host.home, 'work'))
  assert.ok(work.isDirectory())
  assert.equal(work.mode & 0o777, 0o700)

  const lines = stdoutLines(result)
  assert.ok(lines.includes(`update: HEAD ${sha}`), result.stdout)
  assert.ok(lines.includes('update: dish-web.service: active (restarted)'), result.stdout)
  assert.ok(lines.includes(URL_HINT), result.stdout)
  assert.ok(lines.includes('install: no changes to the profile'), "install.sh's output passes through")
  // The journal tail comes last, read as the account.
  assert.ok(lines.includes(JOURNAL_HEADER), result.stdout)
  assert.equal(lines.at(-1), '  2026-10-02T10:00:01+00:00 dish dsh[4242]: listening on 127.0.0.1:3080')
  assert.deepEqual(host.calls('journalctl'), [JOURNAL_ARGS])
  assert.deepEqual(host.calls('runuser'), [], 'it never uses runuser')
  assert.deepEqual(host.calls('curl').at(-1), ['-q', '-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '2', 'http://127.0.0.1:3080/'])
  assert.equal(result.stderr, '')
})

test('a second --apply with nothing new restarts nothing and leaves the stamp', async () => {
  const host = await appliedHost()
  const before = { systemd: systemdChanges(host), stamp: host.stamp() }
  const result = await host.run('update.sh', ['--apply'])
  assertOk(result)
  assert.deepEqual(systemdChanges(host), before.systemd)
  assert.equal(host.stamp(), before.stamp)
  assert.equal(host.installs().length, 2, 'install.sh runs on every --apply')
  const lines = stdoutLines(result)
  assert.ok(lines.includes('update: already at the target'))
  assert.ok(lines.includes('update: restart: not needed'))
  assert.ok(lines.includes('update: dish-web.service: active (unchanged)'))
  assert.ok(!lines.includes(URL_HINT), 'no sign-in hint without a restart')
})

interface StaleCase {
  name: string
  /** What the restart line names. */
  reason: string
  /** Make the change, and return the options for the --apply run. */
  change(host: Host): Promise<HostOptions>
  daemonReload: number
  /** Whether the new stamp differs: a stale stamp does, a restart for another reason writes the same one again. */
  stampChanges: boolean
}

const STALE: StaleCase[] = [
  {
    name: 'a unit change',
    stampChanges: true,
    // A unit change comes in a commit, so the revision changes with it.
    reason: 'revision changed, unit changed',
    daemonReload: 1,
    async change(host) {
      const unit = await readFile(join(host.checkout, 'deploy', 'dish-web.service'), 'utf8')
      await host.commit({ 'deploy/dish-web.service': `${unit}# a new comment\n` }, 'the unit changes')
      return {}
    },
  },
  {
    name: 'a deploy.env change',
    stampChanges: true,
    reason: 'deploy.env changed',
    daemonReload: 0,
    async change() {
      return { deployEnv: 'DISH_TRUSTED_HOST=dish.other.ts.net\n' }
    },
  },
  {
    name: 'an install.env change',
    stampChanges: true,
    reason: 'install.env changed',
    daemonReload: 0,
    async change() {
      return { installEnv: INSTALL_ENV.replace('DISH_USER_NAME=Dish Test', 'DISH_USER_NAME=Dish Renamed') }
    },
  },
  {
    name: 'a pnpm version change',
    stampChanges: true,
    reason: 'pnpm changed',
    daemonReload: 0,
    async change() {
      return { pnpmVersion: '11.26.0' }
    },
  },
  {
    name: 'install.sh changing the profile',
    stampChanges: false,
    reason: 'install.sh changed the profile',
    daemonReload: 0,
    async change() {
      return { installLastLine: 'install: profile changed' }
    },
  },
  {
    name: 'an inactive service',
    stampChanges: false,
    reason: 'not active (inactive)',
    daemonReload: 0,
    async change() {
      return { active: false }
    },
  },
]

for (const stale of STALE) {
  test(`${stale.name} alone restarts, and is named`, async () => {
    const host = await appliedHost()
    const before = systemdChanges(host)
    const stampBefore = host.stamp()
    const options = await stale.change(host)
    const result = await host.run('update.sh', ['--apply'], options)
    assertOk(result)
    assert.deepEqual(systemdChanges(host), { restart: before.restart + 1, enable: before.enable, 'daemon-reload': before['daemon-reload'] + stale.daemonReload })
    assert.ok(stdoutLines(result).includes(`update: restart: needed (${stale.reason})`), result.stdout)
    assert.ok(stdoutLines(result).includes('update: dish-web.service: active (restarted)'), result.stdout)
    if (stale.stampChanges) assert.notEqual(host.stamp(), stampBefore)
    else assert.equal(host.stamp(), stampBefore)
  })
}

test('a unit change shows in the dry run, and an install.env change reaches install.sh', async () => {
  const host = await appliedHost()
  const unit = await readFile(join(host.checkout, 'deploy', 'dish-web.service'), 'utf8')
  await host.commit({ 'deploy/dish-web.service': `${unit}# a new comment\n` }, 'the unit changes')
  const installEnv = INSTALL_ENV.replace('DISH_USER_NAME=Dish Test', 'DISH_USER_NAME=Dish Renamed')
  const dry = await host.run('update.sh', [], { installEnv })
  assertOk(dry)
  assert.ok(stdoutLines(dry).includes('update: unit: changes'), dry.stdout)
  assert.ok(stdoutLines(dry).includes('update: install.env: changed since the last start'), dry.stdout)
  assert.ok(stdoutLines(dry).includes('update: restart: needed (revision changed, unit changed, install.env changed)'), dry.stdout)
  const apply = await host.run('update.sh', ['--apply'])
  assertOk(apply)
  assert.equal(host.installs().at(-1)?.env.DISH_USER_NAME, 'Dish Renamed')
  assert.equal(host.installedUnit(), `${unit}# a new comment\n`)
})

test('a rollback checks out the ref detached, and a later --apply goes back to main', async () => {
  const host = await appliedHost()
  const latest = await host.head()
  const dry = await host.run('update.sh', [host.seed])
  assertOk(dry)
  assert.deepEqual(stdoutLines(dry).slice(0, 4), [
    `update: HEAD ${latest} (main)`,
    `update: target ${host.seed} (${host.seed})`,
    'update: 1 commit to roll back',
    `  ${await short(host, latest)} the second commit`,
  ])

  const back = await host.run('update.sh', ['--apply', host.seed])
  assertOk(back)
  assert.equal(await host.head(), host.seed)
  assert.equal((await git(host.checkout, 'rev-parse', '--abbrev-ref', 'HEAD')).trim(), 'HEAD', 'detached')
  assert.match(host.stamp() ?? '', new RegExp(`^revision ${host.seed}$`, 'm'))

  const newer = await host.commit({ 'NEWS.md': 'news\n' }, 'a third commit')
  const dryForward = await host.run('update.sh', [])
  assertOk(dryForward)
  assert.equal(stdoutLines(dryForward)[0], `update: HEAD ${host.seed} (detached)`)
  assert.equal(stdoutLines(dryForward)[2], 'update: 2 commits to apply')

  const forward = await host.run('update.sh', ['--apply'])
  assertOk(forward)
  assert.equal(await host.head(), newer)
  assert.equal((await git(host.checkout, 'rev-parse', '--abbrev-ref', 'HEAD')).trim(), 'main')
  assert.match(host.stamp() ?? '', new RegExp(`^revision ${newer}$`, 'm'))
})

test('the dry run of a diverged main shows both sides', async () => {
  const { host, sha } = await hostWithUpdate()
  await writeFile(join(host.checkout, 'LOCAL.md'), 'local\n')
  await git(host.checkout, 'add', 'LOCAL.md')
  await git(host.checkout, 'commit', '--quiet', '--message', 'a local commit')
  const local = await host.head()
  const result = await host.run('update.sh', [])
  assert.equal(result.code, 1)
  const lines = stdoutLines(result)
  assert.equal(lines[2], 'update: diverged: 1 commit only at HEAD, 1 only at the target')
  // Both commits may have the same timestamp, so git's order between them is not fixed.
  assert.deepEqual(lines.slice(3, 5).sort(), [
    `  < ${await short(host, local)} a local commit`,
    `  > ${await short(host, sha)} the second commit`,
  ].sort())
  assert.match(result.stderr, /main has commits that origin\/main doesn't/)
})

/** Detach the checkout at the seed, as a rollback leaves it, and commit there. Returns the new commit, which no branch has. */
async function commitDetached(host: Host): Promise<string> {
  await git(host.checkout, 'switch', '--quiet', '--detach', host.seed)
  await writeFile(join(host.checkout, 'LOCAL.md'), 'local work\n')
  await git(host.checkout, 'add', 'LOCAL.md')
  await git(host.checkout, 'commit', '--quiet', '--message', 'local work on the detached HEAD')
  return host.head()
}

test('the dry run of a detached HEAD with a commit of its own refuses, after its report', async () => {
  const { host, sha } = await hostWithUpdate()
  const local = await commitDetached(host)
  const before = await snapshot(host)
  const result = await host.run('update.sh', [])
  assert.equal(result.code, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  const lines = stdoutLines(result)
  assert.equal(lines[0], `update: HEAD ${local} (detached)`)
  assert.equal(lines[1], `update: target ${sha} (origin/main)`)
  assert.equal(lines[2], 'update: diverged: 1 commit only at HEAD, 1 only at the target')
  assert.doesNotMatch(result.stdout, /dry run; run with --apply/)
  assert.deepEqual(result.stderr.split('\n').filter((line) => line !== ''), [
    'update: HEAD has commits no branch or tag has; update.sh would leave them behind',
    'update: FAILED at step: checking the checkout (exit 1)',
  ])
  await assertUnchanged(host, before)
})

test('a detached HEAD at a commit that only a tag has is no refusal: --apply goes back to main', async () => {
  // A rollback to a tag whose commit no branch has; the tag keeps it.
  const { host, sha } = await hostWithUpdate()
  const tagged = await commitDetached(host)
  await git(host.checkout, 'tag', 'kept', tagged)
  const result = await host.run('update.sh', ['--apply'])
  assertOk(result)
  assert.equal(await host.head(), sha)
  assert.equal((await git(host.checkout, 'rev-parse', '--abbrev-ref', 'HEAD')).trim(), 'main')
  assert.equal((await git(host.checkout, 'rev-parse', 'kept')).trim(), tagged)
})

test('a detached HEAD at a commit that only the local main has is no refusal for a ref: main keeps it', async () => {
  const host = await createHost()
  await writeFile(join(host.checkout, 'LOCAL.md'), 'local\n')
  await git(host.checkout, 'add', 'LOCAL.md')
  await git(host.checkout, 'commit', '--quiet', '--message', 'a local commit on main')
  const local = await host.head()
  await git(host.checkout, 'switch', '--quiet', '--detach', local)
  const result = await host.run('update.sh', ['--apply', host.seed])
  assertOk(result)
  assert.equal(await host.head(), host.seed)
  assert.equal((await git(host.checkout, 'rev-parse', 'main')).trim(), local)
})

test('a ref that names a tag works too', async () => {
  const host = await appliedHost()
  await git(host.checkout, 'tag', 'v0-seed', host.seed)
  const result = await host.run('update.sh', ['--apply', 'v0-seed'])
  assertOk(result)
  assert.equal(await host.head(), host.seed)
})

test('ignored files under node_modules/ and .dev/ are not local changes', async () => {
  const { host, sha } = await hostWithUpdate()
  await mkdir(join(host.checkout, 'node_modules', 'x'), { recursive: true })
  await writeFile(join(host.checkout, 'node_modules', 'x', 'index.js'), '')
  await mkdir(join(host.checkout, '.dev', 'dsh'), { recursive: true })
  await writeFile(join(host.checkout, '.dev', 'dsh', 'x'), '')
  const result = await host.run('update.sh', ['--apply'])
  assertOk(result)
  assert.equal(await host.head(), sha)
})

// --- Refusals ----------------------------------------------------------------------------------------------------

interface Refusal {
  name: string
  /** Prepare the host; return the --apply run's options and arguments. */
  setup(host: Host): Promise<{ options?: HostOptions, args?: string[] }>
  message: RegExp
  step: string
}

const withoutLine = (name: string): string => INSTALL_ENV.split('\n').filter((line) => !line.startsWith(`${name}=`)).join('\n')

const REFUSALS: Refusal[] = [
  {
    name: 'a modified tracked file',
    step: 'checking the checkout',
    message: /local changes[^]* M README\.md/,
    async setup(host) {
      await writeFile(join(host.checkout, 'README.md'), 'a local edit\n')
      return {}
    },
  },
  {
    name: 'an untracked file',
    step: 'checking the checkout',
    message: /local changes[^]*\?\? notes\.txt/,
    async setup(host) {
      await writeFile(join(host.checkout, 'notes.txt'), 'notes\n')
      return {}
    },
  },
  {
    name: 'a local commit on main (diverged)',
    step: 'checking the checkout',
    message: /main has commits that origin\/main doesn't/,
    async setup(host) {
      await writeFile(join(host.checkout, 'LOCAL.md'), 'local\n')
      await git(host.checkout, 'add', 'LOCAL.md')
      await git(host.checkout, 'commit', '--quiet', '--message', 'a local commit')
      return {}
    },
  },
  {
    name: 'a local commit on main while detached after a rollback',
    step: 'checking the checkout',
    message: /main has commits that origin\/main doesn't/,
    async setup(host) {
      await writeFile(join(host.checkout, 'LOCAL.md'), 'local\n')
      await git(host.checkout, 'add', 'LOCAL.md')
      await git(host.checkout, 'commit', '--quiet', '--message', 'a local commit')
      await git(host.checkout, 'switch', '--quiet', '--detach', host.seed)
      return {}
    },
  },
  // After a rollback the checkout is detached, and a commit made there is on no branch: moving the checkout, back to main
  // or to another ref, would leave it behind.
  ...([
    ['a commit made on the detached HEAD after a rollback', undefined],
    ['a commit made on the detached HEAD after a rollback, with a ref', 'seed'],
  ] as const).map(([name, ref]): Refusal => ({
    name,
    step: 'checking the checkout',
    message: /^update: HEAD has commits no branch or tag has; update\.sh would leave them behind$/m,
    async setup(host) {
      await commitDetached(host)
      return ref === undefined ? {} : { args: ['--apply', host.seed] }
    },
  })),
  {
    name: 'another branch',
    step: 'checking the checkout',
    message: /on branch feature/,
    async setup(host) {
      await git(host.checkout, 'switch', '--quiet', '--create', 'feature')
      return {}
    },
  },
  {
    name: 'an unknown ref',
    step: 'finding the target',
    message: /unknown ref: no-such-ref/,
    async setup() {
      return { args: ['--apply', 'no-such-ref'] }
    },
  },
  {
    name: 'an empty DISH_REMOTE',
    step: 'reading the inputs',
    message: /DISH_REMOTE is empty/,
    async setup() {
      return { options: { installEnv: INSTALL_ENV.replace(`DISH_REMOTE=${INPUTS.DISH_REMOTE}`, 'DISH_REMOTE=') } }
    },
  },
  {
    name: 'an empty DISH_USER_EMAIL',
    step: 'reading the inputs',
    message: /DISH_USER_EMAIL is empty/,
    async setup() {
      return { options: { installEnv: INSTALL_ENV.replace(`DISH_USER_EMAIL=${INPUTS.DISH_USER_EMAIL}`, 'DISH_USER_EMAIL=') } }
    },
  },
  {
    name: 'a missing install.env',
    step: 'reading the inputs',
    message: /install\.env is missing/,
    async setup() {
      return { options: { installEnv: null } }
    },
  },
  {
    name: 'install.env missing a line',
    step: 'reading the inputs',
    message: /install\.env has no DISH_USER_EMAIL line/,
    async setup() {
      return { options: { installEnv: withoutLine('DISH_USER_EMAIL') } }
    },
  },
  {
    name: 'install.env with a name twice',
    step: 'reading the inputs',
    message: /install\.env has DISH_USER_NAME more than once/,
    async setup() {
      return { options: { installEnv: `${INSTALL_ENV}DISH_USER_NAME=Someone Else\n` } }
    },
  },
  {
    name: 'install.env with another name',
    step: 'reading the inputs',
    message: /install\.env line 5: only DISH_REMOTE, DISH_USER_NAME and DISH_USER_EMAIL belong there/,
    async setup() {
      return { options: { installEnv: `${INSTALL_ENV}DISH_PROFILE=web\n` } }
    },
  },
  {
    name: 'install.env with a line that is not NAME=value',
    step: 'reading the inputs',
    message: /install\.env line 5 is not NAME=value/,
    async setup() {
      return { options: { installEnv: `${INSTALL_ENV}export\n` } }
    },
  },
  {
    name: 'a missing deploy.env',
    step: 'reading the inputs',
    message: /deploy\.env is missing/,
    async setup() {
      return { options: { deployEnv: null } }
    },
  },
  ...([
    ['an empty DISH_TRUSTED_HOST', 'DISH_TRUSTED_HOST=\n'],
    ['a deploy.env without DISH_TRUSTED_HOST', 'OTHER=1\n'],
    ['a DISH_TRUSTED_HOST with a scheme', 'DISH_TRUSTED_HOST=https://dish.example.ts.net\n'],
    ['DISH_TRUSTED_HOST twice', 'DISH_TRUSTED_HOST=a.example\nDISH_TRUSTED_HOST=b.example\n'],
  ] as const).map(([name, deployEnv]): Refusal => ({
    name,
    step: 'reading the inputs',
    message: /deploy\.env needs exactly one DISH_TRUSTED_HOST=<host> line with a bare host name/,
    async setup() {
      return { options: { deployEnv } }
    },
  })),
  {
    name: 'a target without deploy/update.sh, where dish-update could not run again',
    step: 'reading the target',
    message: /origin\/main has no deploy\/update\.sh/,
    async setup(host) {
      await host.commit({ 'deploy/update.sh': null }, 'no update.sh')
      return {}
    },
  },
  {
    name: "a user manager that doesn't answer",
    step: "asking the account's user manager about dish-web.service",
    message: /can't reach .*'s user manager \(XDG_RUNTIME_DIR=\/run\/user\/54321; is linger on\?\)/,
    async setup() {
      return { options: { manager: 'down' } }
    },
  },
  {
    name: 'a target without deploy/install.sh',
    step: 'reading the target',
    message: /origin\/main has no deploy\/install\.sh/,
    async setup(host) {
      await host.commit({ 'deploy/install.sh': null }, 'no install.sh')
      return {}
    },
  },
  {
    name: "a target whose unit has no PATH line",
    step: 'reading the target',
    message: /needs exactly one Environment=PATH= line/,
    async setup(host) {
      const unit = await readFile(join(host.checkout, 'deploy', 'dish-web.service'), 'utf8')
      await host.commit({ 'deploy/dish-web.service': unit.replace(/^Environment=PATH=.*\n/m, '') }, 'no PATH')
      return {}
    },
  },
  {
    name: 'an environment that only claims to be clean',
    step: 'checking the environment',
    message: /DISH_UPDATE_CLEAN is update\.sh's own/,
    async setup() {
      return { options: { env: { DISH_UPDATE_CLEAN: '1' } } }
    },
  },
]

for (const refusal of REFUSALS) {
  test(`--apply refuses ${refusal.name}, and changes nothing`, async () => {
    const { host } = await hostWithUpdate()
    const { options, args } = await refusal.setup(host)
    const before = await snapshot(host)
    const result = await host.run('update.sh', args ?? ['--apply'], options)
    assert.equal(result.code, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
    assert.match(result.stderr, refusal.message)
    const step = refusal.step.replace("the account's", `${host.owner}'s`)
    assert.ok(result.stderr.split('\n').includes(`update: FAILED at step: ${step} (exit 1)`), result.stderr)
    assert.doesNotMatch(result.stderr, /the checkout is (still )?at/, 'nothing moved, so there is no state to report')
    await assertUnchanged(host, before)
    assertNoTokenLine(result)
  })
}

test('--apply refuses while another update holds the lock, and changes nothing', async () => {
  const { host } = await hostWithUpdate()
  const lock = join(host.home, '.local', 'state', 'dish', 'deploy', 'lock')
  await mkdir(join(lock, '..'), { recursive: true })
  const holder = spawn('flock', [lock, 'sleep', '60'], { stdio: 'ignore', detached: true })
  try {
    // Wait until the lock is taken.
    for (let tries = 0; ; tries++) {
      const free = await execFileAsync('flock', ['-n', lock, 'true']).then(() => true, () => false)
      if (!free) break
      assert.ok(tries < 100, 'the flock subprocess took the lock')
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const before = await snapshot(host)
    const result = await host.run('update.sh', ['--apply'])
    assert.equal(result.code, 1)
    assert.match(result.stderr, /another update is running/)
    assert.ok(result.stderr.split('\n').includes('update: FAILED at step: taking the lock (exit 1)'), result.stderr)
    await assertUnchanged(host, before)
  } finally {
    if (holder.pid !== undefined) process.kill(-holder.pid, 'SIGKILL')
  }
})

for (const [name, options, message] of [
  // install.sh's stderr passes through on stdout, with its stdout.
  ['exits non-zero', { installExit: 1 }, /^install: FAILED at step: pnpm build \(exit 1\)$/m],
  ['exits 2, which is still a failed step', { installExit: 2 }, /^install: FAILED at step: pnpm build \(exit 2\)$/m],
  ['ends without its summary line', { installLastLine: 'install: something else' }, /^update: deploy\/install\.sh did not end with its summary line/m],
] as const) {
  test(`when install.sh ${name}, only the checkout has moved, and the step is named`, async () => {
    const { host, sha } = await hostWithUpdate()
    const before = await snapshot(host)
    const result = await host.run('update.sh', ['--apply'], options)
    assert.equal(result.code, 1, result.stderr)
    assert.match(`${result.stdout}${result.stderr}`, message)
    assert.ok(result.stderr.split('\n').some((line) => /^update: FAILED at step: running deploy\/install\.sh \(exit \d+\)$/.test(line)), result.stderr)
    assert.ok(result.stderr.split('\n').includes(`update: the checkout is at ${sha} (was ${host.seed}); dish-web.service was not restarted; fix the problem and rerun dish-update --apply, or go back with dish-update --apply ${host.seed}`), result.stderr)
    assert.equal(await host.head(), sha, 'the checkout moved')
    assert.equal(host.installs().length, 1)
    assert.deepEqual(systemdChanges(host), before.systemd)
    assert.equal(host.installedUnit(), undefined)
    assert.equal(host.stamp(), undefined)
    assert.equal(existsSync(join(host.home, 'work')), false)
  })
}

// --- The wait and the journal ------------------------------------------------------------------------------------

test('when dsh does not answer, it fails at the wait, writes no stamp, and shows the journal', async () => {
  const { host } = await hostWithUpdate()
  const started = Date.now()
  const result = await host.run('update.sh', ['--apply'], { curl: 'down', wait: 2 })
  assert.equal(result.code, 1)
  assert.ok(Date.now() - started >= 2000, 'it waited')
  assert.ok(result.stderr.split('\n').includes('update: dsh did not answer on 127.0.0.1:3080 within 2 seconds'), result.stderr)
  assert.ok(result.stderr.split('\n').includes('update: FAILED at step: waiting for dsh on 127.0.0.1:3080 (exit 1)'), result.stderr)
  assert.equal(host.stamp(), undefined)
  assert.equal(systemdChanges(host).restart, 1)
  assert.ok(stdoutLines(result).includes(JOURNAL_HEADER), result.stdout)
  assert.ok(host.calls('curl').length >= 2, 'it polled more than once')
  assert.ok(result.stderr.split('\n').includes(`update: the checkout is at ${await host.head()} (was ${host.seed}); dish-web.service was restarted; fix the problem and rerun dish-update --apply, or go back with dish-update --apply ${host.seed}`), result.stderr)

  // The next run restarts again, since there is still no stamp.
  const again = await host.run('update.sh', ['--apply'])
  assertOk(again)
  assert.ok(stdoutLines(again).includes('update: restart: needed (no record of a start)'))
  assert.equal(systemdChanges(host).restart, 2)
  assert.notEqual(host.stamp(), undefined)
})

test('the journal tail leaves out every line that mentions a token', async () => {
  const { host } = await hostWithUpdate()
  const journal = [
    '2026-10-02T10:00:00+00:00 dish dsh[4242]: starting',
    '2026-10-02T10:00:01+00:00 dish dsh[4242]: dsh web: http://127.0.0.1:3080/?token=SECRET123',
    '2026-10-02T10:00:02+00:00 dish dsh[4242]: dish-copilot: Token refreshed',
    '2026-10-02T10:00:03+00:00 dish dsh[4242]: dish-config: pushed',
  ]
  const result = await host.run('update.sh', ['--apply'], { journal })
  assertOk(result)
  assert.doesNotMatch(result.stdout + result.stderr, /SECRET123/)
  assertNoTokenLine(result)
  const lines = stdoutLines(result)
  const header = lines.indexOf(JOURNAL_HEADER)
  assert.ok(header >= 0, result.stdout)
  assert.deepEqual(lines.slice(header + 1), [
    '  2026-10-02T10:00:00+00:00 dish dsh[4242]: starting',
    '  2026-10-02T10:00:03+00:00 dish dsh[4242]: dish-config: pushed',
    '  (2 lines left out)',
  ])
})

test('a journal with nothing to read says so', async () => {
  const { host } = await hostWithUpdate()
  const result = await host.run('update.sh', ['--apply'], { journal: [] })
  assertOk(result)
  assert.equal(stdoutLines(result).at(-1), `update: journal: nothing readable as ${host.owner} (journalctl --user -u dish-web.service)`)
  assert.ok(!stdoutLines(result).includes(JOURNAL_HEADER))
})

test('commit subjects that mention a token are left out of the report too', async () => {
  const host = await createHost()
  await host.commit({ 'a.md': 'a\n' }, 'dish-kit: mask a token')
  const plain = await host.commit({ 'b.md': 'b\n' }, 'a plain commit')
  const result = await host.run('update.sh', [])
  assertOk(result)
  assertNoTokenLine(result)
  assert.deepEqual(stdoutLines(result).slice(2, 5), ['update: 2 commits to apply', `  ${await short(host, plain)} a plain commit`, '  (1 line left out)'])
})

// --- Who runs it -------------------------------------------------------------------------------------------------

const REFUSED = (owner: string): string =>
  `update: run dish-update as root (incus exec dish --project dish -- dish-update [--apply] [<ref>]), or this script as ${owner}\n`

test('as the account, it runs itself again with a clean environment, and install.sh gets the unit\'s', async () => {
  const { host } = await hostWithUpdate()
  const result = await host.run('update.sh', ['--apply'])
  assertOk(result)
  assert.deepEqual(host.calls('runuser'), [])
  const [install] = host.installs()
  for (const name of LEAKED) assert.ok(!install.names.includes(name), `install.sh does not see ${name}`)
  assert.deepEqual(install.names.filter((name) => !BASH_NAMES.includes(name)), INSTALL_NAMES)
  assert.deepEqual(install.env, INPUTS)
})

test('as the account with only what the dish-update wrapper passes, the same', async () => {
  const { host } = await hostWithUpdate()
  const result = await host.run('update.sh', ['--apply'], { wrapper: true })
  assertOk(result)
  const [install] = host.installs()
  assert.deepEqual(install.names.filter((name) => !BASH_NAMES.includes(name)), INSTALL_NAMES)
})

for (const env of [{}, { DISH_UPDATE_CLEAN: '1' }] as Record<string, string>[]) {
  test(`as root${'DISH_UPDATE_CLEAN' in env ? ', even claiming a clean environment,' : ''} it refuses before anything, pointing at dish-update`, async () => {
    const { host } = await hostWithUpdate()
    const before = await snapshot(host)
    const result = await host.run('update.sh', ['--apply'], { as: 'root', env })
    assert.equal(result.code, 2)
    assert.equal(result.stderr, REFUSED(host.owner))
    assert.equal(result.stdout, '')
    await assertUnchanged(host, before)
    assert.equal(existsSync(join(host.checkout, '.git', 'FETCH_HEAD')), false, 'no git fetch')
    assert.deepEqual(host.calls('getent'), [])
    assert.deepEqual(host.calls('runuser'), [])
    assert.deepEqual(host.calls('systemctl'), [])
  })
}

test('as another user, it refuses before fetching', async () => {
  const { host } = await hostWithUpdate()
  const before = await snapshot(host)
  const result = await host.run('update.sh', ['--apply'], { as: 'other' })
  assert.equal(result.code, 2)
  assert.equal(result.stderr, REFUSED(host.owner))
  await assertUnchanged(host, before)
  assert.equal(existsSync(join(host.checkout, '.git', 'FETCH_HEAD')), false, 'no git fetch')
  assert.deepEqual(host.calls('runuser'), [])
  assert.deepEqual(host.calls('systemctl'), [])
})

test('a shell trace in the environment stops at the guard, and never shows the journal', async () => {
  const { host } = await hostWithUpdate()
  const journal = ['2026-10-02T10:00:01+00:00 dish dsh[4242]: dsh web: http://127.0.0.1:3080/?token=SECRET123']
  const traceFile = join(host.dir, 'trace.sh')
  await writeFile(traceFile, 'set -x\n')
  for (const env of [{ SHELLOPTS: 'xtrace' }, { BASH_ENV: traceFile }] as Record<string, string>[]) {
    const result = await host.run('update.sh', ['--apply'], { journal, env })
    assertOk(result)
    assert.doesNotMatch(result.stdout + result.stderr, /SECRET123/)
    assertNoTokenLine(result)
    // Only the lines before the guard are traced.
    const traced = result.stderr.split('\n').filter((line) => line.startsWith('+'))
    assert.ok(traced.length > 0, 'the trace was on')
    assert.ok(traced.every((line) => /^\++ set (-euo pipefail|\+o xtrace)$/.test(line)), JSON.stringify(Object.keys(env)) + '\n' + result.stderr)
  }
})

// --- Reloading and restarting ------------------------------------------------------------------------------------

for (const reportsReload of [true, false]) {
  const how = reportsReload ? 'the user manager says it needs one' : "only the stamp says so: the manager doesn't report NeedDaemonReload"
  test(`a daemon-reload that failed is done again by the next run, before the restart (${how})`, async () => {
    const host = await appliedHost()
    const unit = await readFile(join(host.checkout, 'deploy', 'dish-web.service'), 'utf8')
    const changed = `${unit}# a new comment\n`
    await host.commit({ 'deploy/dish-web.service': changed }, 'the unit changes')
    const before = systemdChanges(host)

    const failed = await host.run('update.sh', ['--apply'], { reloadFails: true, reportsReload })
    assert.equal(failed.code, 1)
    assert.ok(failed.stderr.split('\n').includes('update: FAILED at step: reloading the user manager (exit 1)'), failed.stderr)
    assert.match(failed.stderr, /^update: the checkout is at [0-9a-f]+ \(was [0-9a-f]+\); dish-web\.service was not restarted;/m)
    assert.equal(host.installedUnit(), changed, 'the unit file was moved into place')
    assert.equal(systemdChanges(host).restart, before.restart)

    const sequenceBefore = systemdSequence(host).length
    const again = await host.run('update.sh', ['--apply'], { reportsReload })
    assertOk(again)
    assert.deepEqual(systemdSequence(host).slice(sequenceBefore), ['daemon-reload', 'restart'])
    assert.equal(host.service().startedWith, changed, 'the restart used the new unit')
    assert.match(host.stamp() ?? '', new RegExp(`^unit ${sha256(changed)}$`, 'm'))
  })
}

test('a user manager that needs a daemon-reload gets one, and no restart for it alone', async () => {
  const host = await appliedHost()
  const before = systemdChanges(host)
  const result = await host.run('update.sh', ['--apply'], { needDaemonReload: true })
  assertOk(result)
  assert.deepEqual(systemdChanges(host), { ...before, 'daemon-reload': before['daemon-reload'] + 1 })
  assert.ok(stdoutLines(result).includes('update: restart: not needed'), result.stdout)
})

test('a service that runs but does not answer gets one restart, then the stamp', async () => {
  const host = await appliedHost()
  const before = systemdChanges(host)
  const stamp = host.stamp()
  const result = await host.run('update.sh', ['--apply'], { curl: 'after-restart', wait: 2 })
  assertOk(result)
  const lines = stdoutLines(result)
  assert.ok(lines.includes('update: restart: not needed'), result.stdout)
  assert.ok(lines.includes('update: restart: needed (did not answer on 127.0.0.1:3080 within 2 seconds)'), result.stdout)
  assert.ok(lines.includes('update: dish-web.service: active (restarted)'), result.stdout)
  assert.equal(systemdChanges(host).restart, before.restart + 1)
  assert.equal(host.stamp(), stamp, 'the same start, stamped again')
})

test('a service that still does not answer after that restart fails, and is restarted only once', async () => {
  const host = await appliedHost()
  const before = systemdChanges(host)
  const result = await host.run('update.sh', ['--apply'], { curl: 'down', wait: 0 })
  assert.equal(result.code, 1)
  assert.equal(systemdChanges(host).restart, before.restart + 1)
  assert.ok(result.stderr.split('\n').includes('update: FAILED at step: waiting for dsh on 127.0.0.1:3080 (exit 1)'), result.stderr)
  assert.match(result.stderr, /^update: the checkout is still at [0-9a-f]+; dish-web\.service was restarted; fix the problem and rerun dish-update --apply$/m)
})

test("install.sh's output leaves out lines that mention a token, and says how many", async () => {
  const { host } = await hostWithUpdate()
  const result = await host.run('update.sh', ['--apply'], { installOutput: ['SyntaxError: Unexpected token } in JSON', 'install: building'] })
  assertOk(result)
  assertNoTokenLine(result)
  const lines = stdoutLines(result)
  assert.ok(lines.includes('install: building'), result.stdout)
  assert.ok(lines.includes("update: left out 1 line of install.sh's output"), result.stdout)
})

// --- Usage -------------------------------------------------------------------------------------------------------

for (const args of [['--bogus'], ['one', 'two'], ['-x'], ['--apply', '--', 'ref'], ['']]) {
  test(`usage: ${JSON.stringify(args)} exits 2 before anything`, async () => {
    const { host } = await hostWithUpdate()
    const result = await host.run('update.sh', args)
    assert.equal(result.code, 2)
    assert.match(result.stderr, /^usage: deploy\/update\.sh \[--apply\] \[<ref>\]$/m)
    assert.equal(result.stdout, '')
    assert.deepEqual(host.calls('getent'), [])
    assert.deepEqual(host.calls('id'), [])
  })
}

test('--help prints the usage on stdout and exits 0', async () => {
  const { host } = await hostWithUpdate()
  for (const flag of ['--help', '-h']) {
    const result = await host.run('update.sh', [flag])
    assertOk(result)
    assert.match(result.stdout, /^usage: deploy\/update\.sh \[--apply\] \[<ref>\]$/m)
    assert.equal(result.stderr, '')
    assertNoTokenLine(result)
  }
})

test('a DISH_UPDATE_WAIT that is not a number of seconds is a usage error', async () => {
  const { host } = await hostWithUpdate()
  const result = await host.run('update.sh', ['--apply'], { env: { DISH_UPDATE_WAIT: 'soon' } })
  assert.equal(result.code, 2)
  assert.match(result.stderr, /DISH_UPDATE_WAIT must be a whole number of seconds/)
})

// --- The script itself -------------------------------------------------------------------------------------------

test('it survives updating itself', async () => {
  const host = await appliedHost()
  const script = await readFile(join(host.checkout, 'deploy', 'update.sh'), 'utf8')
  const sha = await host.commit({ 'deploy/update.sh': `${script}# a comment from upstream\n` }, 'update.sh changes')
  const result = await host.run('update.sh', ['--apply'])
  assertOk(result)
  assert.equal(await host.head(), sha)
})

test('its body is functions, and the last line calls main', () => {
  const lines = readFileSync(UPDATE, 'utf8').trimEnd().split('\n')
  assert.equal(lines.at(-1), 'main "$@"; exit')
})

test('update.sh is executable in git', async () => {
  const { stdout } = await execFileAsync('git', ['ls-files', '-s', 'deploy/update.sh'], { cwd: ROOT, encoding: 'utf8' })
  assert.match(stdout, /^100755 /)
})

test('update.sh passes shellcheck', async (t) => {
  const found = await execFileAsync('bash', ['-c', 'command -v shellcheck']).then(() => true, () => false)
  if (!found) {
    t.skip('shellcheck is not on PATH')
    return
  }
  await execFileAsync('shellcheck', [UPDATE])
})
