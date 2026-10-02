import { test } from 'node:test'
import assert from 'node:assert/strict'
import { access, chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { childEnvironment } from '../src/env.ts'
import { SAFE_FLAGS } from '../src/git.ts'
import { KILL_GRACE_MS, LOG_TAIL_BYTES, internals, onMergedCode, runSetup, skipReason } from '../src/setup.ts'
import type { MergedCheck, SetupOptions, SetupResult } from '../src/setup.ts'
import { NOSYSTEM, dishHome, makeBare, makeClone, run, runOk, scratchGitEnv, tempDir, withEnv } from './helpers.ts'
import type { Clone } from './helpers.ts'

/** Shaped like a GitHub installation token (`ghs_` and 40 letters and digits); not one. */
const TOKEN = `ghs_${'Ab1Cd2Ef3G'.repeat(4)}`

// The code's own git drops every GIT_* name of process.env; this gives it no system config, as every test git has.
// (Setup's environment never gets it: a setup command that runs git exports GIT_CONFIG_NOSYSTEM itself, `NOSYSTEM_SH`.)
internals.gitEnv = NOSYSTEM

/** Put first in a setup command that runs git: setup's scrub drops every GIT_* name it is given. */
const NOSYSTEM_SH = 'export GIT_CONFIG_NOSYSTEM=1; '

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
  let text: string
  try {
    text = await readFile(`/proc/${pid}/stat`, 'utf8')
  } catch {
    return true
  }
  const state = text.slice(text.lastIndexOf(')') + 2).split(' ')[0]
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

/** Whether any process is left in process group `pgid` (zombies not counted). */
async function groupLeft(pgid: number): Promise<number[]> {
  const { readdir } = await import('node:fs/promises')
  const left: number[] = []
  for (const name of await readdir('/proc')) {
    if (!/^\d+$/.test(name)) continue
    let text: string
    try {
      text = await readFile(`/proc/${name}/stat`, 'utf8')
    } catch {
      continue
    }
    const fields = text.slice(text.lastIndexOf(')') + 2).split(' ')
    if (Number(fields[2]) === pgid && fields[0] !== 'Z' && fields[0] !== 'X') left.push(Number(name))
  }
  return left
}

/** The pids a command wrote to `file`, one per line. */
async function pidsIn(file: string): Promise<number[]> {
  const pids = (await readFile(file, 'utf8')).split('\n').filter(line => line !== '').map(Number)
  assert.ok(pids.length > 0 && pids.every(pid => Number.isInteger(pid) && pid > 1), `pids in ${file}`)
  return pids
}

/**
 * The environment a test gives setup's bash: a scratch HOME and HISTFILE, the runner's PATH and nothing else of it.
 * (`GIT_CONFIG_NOSYSTEM` is given too, as to every test process; setup's scrub drops it, so a command that runs git
 * starts with `NOSYSTEM_SH`.)
 */
async function bashEnv(dir: string, extra: Record<string, string> = {}): Promise<NodeJS.ProcessEnv> {
  const home = join(dir, 'home')
  await mkdir(home, { recursive: true })
  return { PATH: process.env.PATH, HOME: home, HISTFILE: join(home, '.bash_history'), LANG: 'C', GIT_CONFIG_NOSYSTEM: '1', ...extra }
}

/** runSetup in `dir`, with a scratch environment and a log under `<dir>/state/…` (directories not made yet). */
async function setupIn(dir: string, command: string, options: Partial<SetupOptions> = {}): Promise<SetupResult> {
  return runSetup({
    command,
    cwd: dir,
    timeoutMs: 30_000,
    log: join(dir, 'state', 'workspaces', 'acme', 'widget', 'setup.log'),
    env: await bashEnv(dir),
    ...options,
  })
}

function reasonOf(check: MergedCheck): string {
  assert.equal(check.ok, false, 'expected the check to refuse')
  return (check as { ok: false, reason: string }).reason
}

// --- runSetup ---------------------------------------------------------------------------------------------------------

test('the constants are the contract', () => {
  assert.equal(LOG_TAIL_BYTES, 65_536)
  assert.equal(KILL_GRACE_MS, 5_000)
})

test('exit 0 and exit 3 are results; the log holds both streams, is 0600, in a directory it made 0700', async () => {
  const dir = await tempDir()
  const ok = await setupIn(dir, 'echo to-out; echo to-err >&2; echo again')
  assert.equal(ok.exitCode, 0)
  assert.equal(ok.signal, null)
  assert.equal(ok.timedOut, false)
  assert.equal(ok.aborted, false)
  assert.ok(ok.durationMs >= 0 && ok.durationMs < 10_000)
  assert.equal(ok.log, join(dir, 'state', 'workspaces', 'acme', 'widget', 'setup.log'))
  const text = await readFile(ok.log, 'utf8')
  for (const line of ['to-out', 'to-err', 'again']) assert.ok(text.includes(`${line}\n`), `${line} in the log`)
  assert.equal(ok.tail, text.replace(/\n$/, ''))
  assert.equal((await stat(ok.log)).mode & 0o777, 0o600)
  assert.equal((await stat(dirname(ok.log))).mode & 0o777, 0o700)

  const failed = await setupIn(dir, 'echo before; exit 3')
  assert.equal(failed.exitCode, 3)
  assert.equal(failed.signal, null)
  assert.equal(failed.timedOut, false)
  assert.equal(await readFile(failed.log, 'utf8'), 'before\n', 'the log is the last run only')
})

test("the command runs in cwd, with childEnvironment's scrub of the env it is given", async () => {
  const dir = await tempDir()
  const env = await bashEnv(dir, { FOO_TOKEN: 'x', DSH_HOME: '/x', GIT_DIR: '/x', GIT_WS_T: 'x', BAR: 'bar', GIT_TERMINAL_PROMPT: '1' })
  const result = await setupIn(dir, 'echo "${FOO_TOKEN-unset} ${DSH_HOME-unset} ${GIT_DIR-unset} ${GIT_WS_T-unset} ${BAR-unset} ${GIT_TERMINAL_PROMPT-unset}"; pwd; echo "$HOME"', { env })
  assert.equal(result.exitCode, 0)
  assert.equal(result.tail, `unset unset unset unset bar 0\n${dir}\n${join(dir, 'home')}`)
})

test('stdin is closed: a read gets nothing at once', async () => {
  const dir = await tempDir()
  const started = Date.now()
  const result = await setupIn(dir, 'read x; echo "<$x>"', { timeoutMs: 20_000 })
  assert.equal(result.tail, '<>')
  assert.ok(Date.now() - started < 3_000, `read returned at once, not after ${Date.now() - started} ms`)
})

test('tail is the last 40 lines of the log', async () => {
  const dir = await tempDir()
  const result = await setupIn(dir, 'for i in $(seq 1 100); do echo "line $i"; done')
  const lines = result.tail.split('\n')
  assert.equal(lines.length, 40)
  assert.equal(lines[0], 'line 61')
  assert.equal(lines[39], 'line 100')
})

test('more than 64 KB of output keeps the tail only, from a whole line; a token is masked in the log and in tail', async () => {
  const dir = await tempDir()
  // 3000 lines of 60 bytes (180 KB), then a token, then a last line.
  const command = `for i in $(seq -w 1 3000); do printf 'line %s %s\\n' "$i" "${'x'.repeat(48)}"; done; echo "token ${TOKEN} here"; echo last`
  const result = await setupIn(dir, command)
  assert.equal(result.exitCode, 0)
  const log = await readFile(result.log)
  assert.ok(log.length <= LOG_TAIL_BYTES, `the log is ${log.length} bytes`)
  assert.ok(log.length > LOG_TAIL_BYTES - 200, 'it keeps nearly all of the 64 KB')
  const text = log.toString('utf8')
  assert.equal(text.includes('line 0001 '), false, 'the head is gone')
  assert.match(text, /^line \d{4} x{48}\n/, 'the log starts at a whole line')
  assert.ok(text.endsWith('here\nlast\n'))
  for (const [what, shown] of [['log', text], ['tail', result.tail]] as const) {
    assert.equal(shown.includes('ghs_'), false, `no token in the ${what}`)
    assert.ok(shown.includes('token ‹secret: '), `the token is masked in the ${what}`)
  }
})

test('once output is dropped, a PEM block cut at the drop leaves no fragment in the log, even when masking shrinks the rest', async () => {
  const dir = await tempDir()
  // A private key whose header falls in the dropped output and whose body runs past the 80 KB kept before masking, then
  // lines with long tokens: masked, they shrink the kept output well under 64 KB, which used to keep its start, key
  // body and all.
  const body = Array.from({ length: 60 }, (_, index) => `Zm9v${String(index).padStart(4, '0')}${'Qk'.repeat(28)}`)
  const pem = ['-----BEGIN RSA PRIVATE KEY-----', ...body, '-----END RSA PRIVATE KEY-----', ''].join('\n')
  const tokenLine = (index: number): string => `token ghs_${`${String(index).padStart(4, '0')}${'Ab1Cd2Ef3G'.repeat(20)}`.slice(0, 200)} done\n`
  const kept = LOG_TAIL_BYTES + 16 * 1024
  const tokens = Array.from({ length: Math.floor((kept - 2_000) / tokenLine(0).length) }, (_, index) => tokenLine(index)).join('')
  const output = `${'filler line\n'.repeat(1_000)}${pem}${tokens}`
  // The fixture: the drop falls inside the key's body.
  const keptPart = output.slice(-kept)
  assert.ok(output.length > kept)
  assert.ok(keptPart.includes('Zm9v') && !keptPart.includes('BEGIN'), 'the kept output starts inside the key body')
  const file = join(dir, 'output.txt')
  await writeFile(file, output)
  const result = await setupIn(dir, `cat '${file}'`)
  assert.equal(result.exitCode, 0)
  const log = await readFile(result.log, 'utf8')
  for (const [what, shown] of [['log', log], ['tail', result.tail]] as const) {
    assert.equal(shown.includes('Zm9v'), false, `no line of the key in the ${what}`)
    assert.equal(shown.includes('ghs_'), false, `no token in the ${what}`)
    assert.equal(shown.includes('PRIVATE KEY'), false, `no part of the key's lines in the ${what}`)
  }
  assert.match(log, /^token ‹secret: [^›]+› done\n/, 'the log starts at a whole line')
  assert.ok(log.endsWith('done\n'))
})

test('a key that runs across the start of the last 64 KB is masked whole, not left as its last lines', async () => {
  const dir = await tempDir()
  const body = Array.from({ length: 60 }, (_, index) => `Zm9v${String(index).padStart(4, '0')}${'Qk'.repeat(28)}`)
  const pem = ['-----BEGIN RSA PRIVATE KEY-----', ...body, '-----END RSA PRIVATE KEY-----', ''].join('\n')
  const after = 'after the key\n'.repeat(Math.ceil((LOG_TAIL_BYTES - 2_000) / 'after the key\n'.length))
  const output = `${'filler line\n'.repeat(600)}${pem}${after}`
  // The fixture: nothing is dropped, and the last 64 KB start inside the key's body.
  assert.ok(output.length < LOG_TAIL_BYTES + 16 * 1024)
  const window = output.slice(-LOG_TAIL_BYTES)
  assert.ok(window.includes('Zm9v') && !window.includes('BEGIN'))
  const file = join(dir, 'output.txt')
  await writeFile(file, output)
  const result = await setupIn(dir, `cat '${file}'`)
  const log = await readFile(result.log, 'utf8')
  assert.equal(log.includes('Zm9v'), false, 'no line of the key')
  assert.equal(log.includes('PRIVATE KEY'), false)
  assert.ok(log.endsWith('after the key\n'))
  assert.ok(Buffer.byteLength(log) <= LOG_TAIL_BYTES)
})

test("one line over 64 KB is cut to the last 64 KB, masked; once output was dropped, a line with no start isn't kept", async () => {
  const dir = await tempDir()
  // 70 KB: nothing dropped, so the line's start was read and masking saw all of it.
  const kept = await setupIn(dir, `head -c 70000 /dev/zero | tr '\\0' y; printf ' ${TOKEN}'`)
  const log = await readFile(kept.log, 'utf8')
  assert.ok(Buffer.byteLength(log) <= LOG_TAIL_BYTES)
  assert.equal(log.includes('ghs_'), false)
  assert.match(log, /^y+ ‹secret: [^›]+›$/)
  // 100 KB: the line began in what was dropped, so none of it is safe to show.
  const dropped = await setupIn(dir, `head -c 100000 /dev/zero | tr '\\0' y; printf ' ${TOKEN}'`)
  assert.equal(await readFile(dropped.log, 'utf8'), "[setup's last 80 KB of output were part of one line; not kept]\n")
})

test('a timeout ends the whole process group: bash and the grandchild it started are gone, and nothing is left', async () => {
  const dir = await tempDir()
  const pidFile = join(dir, 'pids')
  const started = Date.now()
  const result = await setupIn(dir, `echo $$ > '${pidFile}'; sleep 30 & echo $! >> '${pidFile}'; wait`, { timeoutMs: 300 })
  assert.equal(result.timedOut, true)
  assert.equal(result.aborted, false)
  assert.equal(result.exitCode, null)
  assert.equal(result.signal, 'SIGTERM')
  const [leader, ...rest] = await pidsIn(pidFile)
  assert.equal(rest.length, 1, 'the sleep')
  for (const pid of [leader!, ...rest]) assert.equal(await goneSoon(pid), true, `pid ${pid} is gone`)
  assert.ok(Date.now() - started < 300 + KILL_GRACE_MS + 1_000, `over in ${Date.now() - started} ms`)
  assert.deepEqual(await groupLeft(leader!), [], 'no process is left in its group')
})

test('a command that traps TERM gets KILL after the grace', async () => {
  const dir = await tempDir()
  const pidFile = join(dir, 'pids')
  const started = Date.now()
  const result = await setupIn(dir, `trap 'echo caught TERM' TERM; echo $$ > '${pidFile}'; while :; do sleep 0.2; done`, { timeoutMs: 300 })
  const took = Date.now() - started
  assert.equal(result.timedOut, true)
  assert.equal(result.signal, 'SIGKILL')
  assert.ok(result.tail.includes('caught TERM'), 'the TERM came first')
  assert.ok(took >= KILL_GRACE_MS, `KILL came after the grace, not after ${took} ms`)
  assert.ok(took < 300 + KILL_GRACE_MS + 1_000, `over in ${took} ms`)
  const [leader] = await pidsIn(pidFile)
  assert.equal(await goneSoon(leader!), true)
  assert.deepEqual(await groupLeft(leader!), [], 'no process is left in its group')
})

test('a grandchild that ignores TERM is killed after the grace too, once bash has gone', async () => {
  const dir = await tempDir()
  const pidFile = join(dir, 'pids')
  // bash dies on the TERM; the sleep it started ignores TERM and holds no pipe of ours.
  const command = `echo $$ > '${pidFile}'; sh -c "trap '' TERM; echo \\$\\$ >> '${pidFile}'; exec sleep 30" >/dev/null 2>&1 & wait`
  const result = await setupIn(dir, command, { timeoutMs: 300 })
  assert.equal(result.timedOut, true)
  const pids = await pidsIn(pidFile)
  assert.equal(pids.length, 2)
  for (const pid of pids) assert.equal(await goneSoon(pid), true, `pid ${pid} is gone`)
  assert.deepEqual(await groupLeft(pids[0]!), [])
})

test('an abort ends the whole group the same way, with aborted', async () => {
  const dir = await tempDir()
  const pidFile = join(dir, 'pids')
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 300)
  const result = await setupIn(dir, `echo $$ > '${pidFile}'; sleep 30 & echo $! >> '${pidFile}'; wait`, { signal: controller.signal, timeoutMs: 60_000 })
  assert.equal(result.aborted, true)
  assert.equal(result.timedOut, false)
  assert.equal(result.exitCode, null)
  const pids = await pidsIn(pidFile)
  for (const pid of pids) assert.equal(await goneSoon(pid), true, `pid ${pid} is gone`)
  assert.deepEqual(await groupLeft(pids[0]!), [])
})

test('an already aborted signal starts nothing', async () => {
  const dir = await tempDir()
  const marker = join(dir, 'ran')
  const controller = new AbortController()
  controller.abort()
  const result = await setupIn(dir, `touch '${marker}'`, { signal: controller.signal })
  assert.equal(result.aborted, true)
  assert.equal(result.exitCode, null)
  assert.equal(await exists(marker), false)
  assert.equal(await readFile(result.log, 'utf8'), '')
})

test('what setup leaves running when bash exits is ended too', async () => {
  const dir = await tempDir()
  for (const redirect of ['>/dev/null 2>&1', '']) {
    const pidFile = join(dir, `pids${redirect === '' ? '-piped' : ''}`)
    const started = Date.now()
    const result = await setupIn(dir, `echo $$ > '${pidFile}'; sleep 30 ${redirect} & echo $! >> '${pidFile}'; echo done`)
    assert.equal(result.exitCode, 0)
    assert.equal(result.timedOut, false)
    assert.equal(result.tail, 'done')
    assert.ok(Date.now() - started < 3_000, `over in ${Date.now() - started} ms`)
    const pids = await pidsIn(pidFile)
    for (const pid of pids) assert.equal(await goneSoon(pid), true, `pid ${pid} is gone (${redirect || 'holding the pipes'})`)
  }
})

test('a process that left the group but holds the pipes does not hold the result', async () => {
  const dir = await tempDir()
  const pidFile = join(dir, 'pids')
  const result = await setupIn(dir, `setsid sleep 30 & echo $! > '${pidFile}'; echo started`, { timeoutMs: 20_000 })
  const [escaped] = await pidsIn(pidFile)
  try {
    assert.equal(result.exitCode, 0)
    assert.equal(result.timedOut, false)
    assert.ok(result.durationMs < 5_000, `resolved after ${result.durationMs} ms`)
  } finally {
    try {
      process.kill(escaped!, 'SIGKILL')
    } catch {
      // gone already
    }
  }
})

test("a command that can't start is a result, not a throw", async () => {
  const dir = await tempDir()
  const result = await setupIn(dir, 'echo hi', { cwd: join(dir, 'missing') })
  assert.equal(result.exitCode, null)
  assert.equal(result.signal, null)
  assert.equal(result.timedOut, false)
  assert.match(result.tail, /^setup couldn't start: /)
  assert.equal(await readFile(result.log, 'utf8'), `${result.tail}\n`)
})

test('a time limit that is not a positive number of milliseconds is refused', async () => {
  const dir = await tempDir()
  for (const timeoutMs of [0, -1, Number.NaN, 2 ** 31]) {
    await assert.rejects(setupIn(dir, 'true', { timeoutMs }), RangeError)
  }
})

test('skipReason says why and gives the command to run', () => {
  assert.equal(
    skipReason('base dish/plan-x isn\'t on origin/main', '/w/acme/widget/.worktrees/x', 'pnpm install'),
    "setup didn't run outside the sandbox: base dish/plan-x isn't on origin/main. Run it yourself in /w/acme/widget/.worktrees/x: pnpm install",
  )
  assert.equal(
    skipReason('it has a nested repository.', '/w', 'make'),
    "setup didn't run outside the sandbox: it has a nested repository. Run it yourself in /w: make",
  )
})

// --- setup's own git gets dish's git's protection --------------------------------------------------------------------

/** What SAFE_FLAGS sets (as `key`, `value`), plus the two settings `projects`' SAFE_FLAGS adds, unless it has them. */
function protectedSettings(): Array<[string, string]> {
  const pairs: Array<[string, string]> = []
  for (let index = 0; index < SAFE_FLAGS.length; index += 2) {
    const setting = SAFE_FLAGS[index + 1]!
    pairs.push([setting.slice(0, setting.indexOf('=')), setting.slice(setting.indexOf('=') + 1)])
  }
  for (const [key, value] of [['credential.interactive', 'false'], ['core.commitGraph', 'false']] as const) {
    if (!pairs.some(([known]) => known.toLowerCase() === key.toLowerCase())) pairs.push([key, value])
  }
  return pairs
}

/** A clone with a worktree `.worktrees/x` on `dish/x`, made by a scratch git before anything is planted. */
async function cloneWithWorktree(): Promise<Clone & { dir: string, worktree: string }> {
  const dir = await tempDir()
  const made = await makeClone(dir)
  const worktree = join(made.clone, '.worktrees', 'x')
  await runOk('git', ['-C', made.clone, 'worktree', 'add', '-q', '-b', 'dish/x', worktree, 'origin/main'], { env: made.env })
  return { ...made, dir, worktree }
}

/** `command` run by plain bash, with only childEnvironment's scrub (no system config): what setup's git did before. */
async function unprotected(dir: string, cwd: string, command: string): Promise<void> {
  const env = { ...childEnvironment(await bashEnv(dir)), GIT_CONFIG_NOSYSTEM: '1' }
  await runOk('bash', ['-c', command], { cwd, env })
}

/** A script that appends a line to the returned marker when run. */
async function markerScript(dir: string, name: string): Promise<{ script: string, marker: string }> {
  const script = join(dir, `${name}.sh`)
  const marker = join(dir, `${name}-ran`)
  await writeFile(script, `#!/bin/sh\necho ran >> '${marker}'\n`)
  await chmod(script, 0o755)
  return { script, marker }
}

test("every setting SAFE_FLAGS carries reaches setup's git, over the clone's own config, and grafts are off", async () => {
  const f = await cloneWithWorktree()
  for (const [key, value] of [['core.hooksPath', '.hooks'], ['submodule.recurse', 'true'], ['core.commitGraph', 'true'], ['credential.interactive', 'true']]) {
    await runOk('git', ['-C', f.clone, 'config', key!, value!], { env: f.env })
  }
  const settings = protectedSettings()
  assert.ok(settings.length >= 9)
  const command = `${NOSYSTEM_SH}${settings.map(([key]) => `git config --get ${key}`).join('; ')}; echo "$GIT_GRAFT_FILE"`
  const result = await setupIn(f.dir, command, { cwd: f.worktree, env: await bashEnv(f.dir) })
  assert.equal(result.exitCode, 0, result.tail)
  assert.equal(result.tail, [...settings.map(([, value]) => value), '/dev/null'].join('\n'))
})

test("a post-checkout hook planted in the clone's shared .git/hooks doesn't run on setup's git checkout in a worktree (and does without the protection)", async () => {
  const f = await cloneWithWorktree()
  const { script, marker } = await markerScript(f.dir, 'hook')
  const hook = join(f.clone, '.git', 'hooks', 'post-checkout')
  await writeFile(hook, await readFile(script))
  await chmod(hook, 0o755)
  const result = await setupIn(f.dir, `${NOSYSTEM_SH}git checkout -q -b other`, { cwd: f.worktree, env: await bashEnv(f.dir) })
  assert.equal(result.exitCode, 0, result.tail)
  assert.equal(await exists(marker), false, "the planted hook ran under setup's git")
  await unprotected(f.dir, f.worktree, 'git checkout -q -b other-plain')
  assert.equal(await exists(marker), true, 'the fixture is real: the hook runs without the protection')
})

test("a core.fsmonitor planted in the clone's config doesn't run on setup's git status (and does without the protection)", async () => {
  const f = await cloneWithWorktree()
  const { script, marker } = await markerScript(f.dir, 'fsmonitor')
  await runOk('git', ['-C', f.clone, 'config', 'core.fsmonitor', script], { env: f.env })
  const result = await setupIn(f.dir, `${NOSYSTEM_SH}git status --porcelain >/dev/null`, { cwd: f.worktree, env: await bashEnv(f.dir) })
  assert.equal(result.exitCode, 0, result.tail)
  assert.equal(await exists(marker), false, "the planted fsmonitor ran under setup's git")
  await unprotected(f.dir, f.worktree, 'git status --porcelain >/dev/null')
  assert.equal(await exists(marker), true, 'the fixture is real: the fsmonitor runs without the protection')
})

test('an explicit git submodule update inside setup still works', async () => {
  const dir = await tempDir()
  const env = await scratchGitEnv(dir)
  // git refuses file:// submodules unless allowed; GitHub's https needs no such setting.
  await runOk('git', ['config', '--global', 'protocol.file.allow', 'always'], { env })
  const sub = await makeBare(join(dir, 'sub.git'), { 's.txt': 'from the submodule\n' })
  const work = join(dir, 'work')
  await runOk('git', ['init', '-q', '-b', 'main', work], { env })
  await writeFile(join(work, 'README.md'), '# super\n')
  await runOk('git', ['-C', work, 'submodule', 'add', '-q', `file://${sub}`, 'vendor/sub'], { env })
  await runOk('git', ['-C', work, 'commit', '-q', '-am', 'with a submodule'], { env })
  await runOk('git', ['clone', '-q', '--bare', work, join(dir, 'super.git')], { env })
  const clone = join(dir, 'clone')
  await runOk('git', ['clone', '-q', `file://${join(dir, 'super.git')}`, clone], { env })
  const worktree = join(clone, '.worktrees', 'x')
  await runOk('git', ['-C', clone, 'worktree', 'add', '-q', '-b', 'dish/x', worktree, 'origin/main'], { env })
  assert.deepEqual(await readdirOf(join(worktree, 'vendor', 'sub')), [], 'the new worktree leaves the gitlink empty')
  const before = await sharedSubmoduleKeys(clone, env)
  assert.deepEqual(before, [], 'nothing about the submodule in the shared config yet')
  const result = await setupIn(dir, `${NOSYSTEM_SH}git submodule update --init -q && cat vendor/sub/s.txt`, { cwd: worktree, env: await bashEnv(dir) })
  assert.equal(result.exitCode, 0, result.tail)
  assert.equal(result.tail, 'from the submodule')
  // What it writes, and where: `submodule.<name>.url` and `.active`, in the clone's shared .git/config (a worktree has no
  // config of its own). checkClone's allowlist has no submodule.* key, so the clone is refused afterwards until that
  // changes (being handled on `projects`).
  assert.deepEqual(await sharedSubmoduleKeys(clone, env), [
    `submodule.vendor/sub.active true`,
    `submodule.vendor/sub.url file://${sub}`,
  ])
})

/** The `submodule.*` entries of `clone`'s shared `.git/config`, sorted, as `key value`. */
async function sharedSubmoduleKeys(clone: string, env: Record<string, string>): Promise<string[]> {
  const result = await run('git', ['config', '--file', join(clone, '.git', 'config'), '--get-regexp', '^submodule\\.'], { env })
  return result.stdout.split('\n').filter(line => line !== '').sort()
}

async function readdirOf(path: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises')
  return readdir(path)
}

// --- onMergedCode ------------------------------------------------------------------------------------------------------

interface Fixture extends Clone {
  dir: string
  /** GitHub's main: the bare repository's `main`. */
  main: string
}

/** A bare repository (GitHub, `file://`) with `files` on main, and a clone of it; the code's git gets a scratch home. */
async function fixture(files: Record<string, string> = { 'README.md': '# widget\n' }): Promise<Fixture> {
  const dir = await tempDir()
  const made = await makeClone(dir, files)
  const main = (await runOk('git', ['-C', made.clone, 'rev-parse', 'origin/main'], { env: made.env })).trim()
  return { ...made, dir, main }
}

/** A commit pushed to GitHub's main (from a scratch clone), so the clone is behind until it fetches. Returns its sha. */
async function pushToMain(f: Fixture, file: string, text: string, prepare?: (work: string) => Promise<void>): Promise<string> {
  const work = join(await tempDir(), 'work')
  const env = await scratchGitEnv(dirname(work))
  await runOk('git', ['clone', '-q', f.url, work], { env })
  await mkdir(dirname(join(work, file)), { recursive: true })
  await writeFile(join(work, file), text)
  await runOk('git', ['-C', work, 'add', '-A'], { env })
  await prepare?.(work)
  await runOk('git', ['-C', work, 'commit', '-q', '-m', `add ${file}`], { env })
  await runOk('git', ['-C', work, 'push', '-q', 'origin', 'main'], { env })
  return (await runOk('git', ['-C', work, 'rev-parse', 'HEAD'], { env })).trim()
}

/** The clone's `git fetch` (a scratch git, as the caller's fetch would have run). */
async function fetch(f: Fixture): Promise<void> {
  await runOk('git', ['-C', f.clone, 'fetch', '-q', 'origin'], { env: f.env })
}

/** A commit an agent made: on `dish/x` from origin/main, changing `a`. The checkout goes back to main. */
async function agentCommit(f: Fixture, branch = 'dish/x'): Promise<string> {
  await runOk('git', ['-C', f.clone, 'checkout', '-q', '-b', branch], { env: f.env })
  await writeFile(join(f.clone, 'a'), 'evil\n')
  await runOk('git', ['-C', f.clone, 'add', 'a'], { env: f.env })
  await runOk('git', ['-C', f.clone, 'commit', '-q', '-m', 'evil'], { env: f.env })
  const sha = (await runOk('git', ['-C', f.clone, 'rev-parse', 'HEAD'], { env: f.env })).trim()
  await runOk('git', ['-C', f.clone, 'checkout', '-q', 'main'], { env: f.env })
  return sha
}

/** An unrelated commit (an orphan), as an agent would make to carry its own tree. */
async function orphanCommit(f: Fixture): Promise<string> {
  const tree = (await runOk('git', ['-C', f.clone, 'mktree'], { env: f.env, input: '' })).trim()
  return (await runOk('git', ['-C', f.clone, 'commit-tree', tree, '-m', 'orphan'], { env: f.env })).trim()
}

/** Whether plain git (with the clone's refs, replace refs, grafts and commit-graph honoured) calls `a` an ancestor of `b`. */
async function plainIsAncestor(f: Fixture, a: string, b: string, env: Record<string, string> = f.env): Promise<boolean> {
  const result = await run('git', ['-C', f.clone, 'merge-base', '--is-ancestor', a, b], { env })
  assert.ok(result.code === 0 || result.code === 1, result.stderr)
  return result.code === 0
}

/** onMergedCode with the code's git given a scratch home. */
async function check(f: Fixture, at: { commit: string }, branch = 'main', signal?: AbortSignal): Promise<MergedCheck> {
  return withEnv(await dishHome(f.dir), () => onMergedCode(f.clone, at, branch, signal))
}

test("onMergedCode { commit }: GitHub's main, and a commit before it, are merged", async () => {
  const f = await fixture()
  assert.deepEqual(await check(f, { commit: f.main }), { ok: true })
  const next = await pushToMain(f, 'b', 'b\n')
  await fetch(f)
  assert.deepEqual(await check(f, { commit: next }), { ok: true })
  assert.deepEqual(await check(f, { commit: f.main }), { ok: true }, 'an ancestor of the tip')
})

test('onMergedCode { commit }: a local commit on dish/x is not, and the reason names the branch and origin/main', async () => {
  const f = await fixture()
  const evil = await agentCommit(f)
  const reason = reasonOf(await check(f, { commit: evil }))
  assert.match(reason, /dish\/x/)
  assert.match(reason, /isn't on origin\/main/)
  assert.ok(reason.includes(evil.slice(0, 7)))
})

test('onMergedCode { commit }: a planted refs/remotes/origin/main is not trusted (and would have fooled a local check)', async () => {
  const f = await fixture()
  const evil = await agentCommit(f)
  await runOk('git', ['-C', f.clone, 'update-ref', 'refs/remotes/origin/main', evil], { env: f.env })
  assert.equal(await plainIsAncestor(f, evil, 'origin/main'), true, 'the fixture is real: the local ref says merged')
  assert.match(reasonOf(await check(f, { commit: evil })), /isn't on origin\/main/)
})

test('onMergedCode { commit }: a planted replace ref does not make a commit merged (and does fool plain git)', async () => {
  const f = await fixture()
  const evil = await orphanCommit(f)
  // GitHub's main, replaced by a copy whose parent is the agent's commit.
  await runOk('git', ['-C', f.clone, 'replace', '--graft', f.main, evil], { env: f.env })
  assert.equal(await plainIsAncestor(f, evil, f.main), true, 'the fixture is real')
  assert.match(reasonOf(await check(f, { commit: evil })), /isn't on origin\/main/)
})

test('onMergedCode { commit }: a planted .git/info/grafts does not make a commit merged (and does fool plain git)', async () => {
  const f = await fixture()
  const evil = await orphanCommit(f)
  const grafts = join(f.clone, '.git', 'info', 'grafts')
  await writeFile(grafts, `${f.main} ${evil}\n`)
  assert.equal(await plainIsAncestor(f, evil, f.main, { ...f.env, GIT_GRAFT_FILE: grafts }), true, 'the fixture is real')
  assert.match(reasonOf(await check(f, { commit: evil })), /isn't on origin\/main/)
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

test('onMergedCode { commit }: a forged commit-graph does not make a commit merged (and does fool plain git)', async () => {
  const f = await fixture()
  const tip = await pushToMain(f, 'b', 'b\n')
  await fetch(f)
  const evil = await orphanCommit(f)
  await runOk('git', ['-C', f.clone, 'branch', 'dish/x', evil], { env: f.env })
  await runOk('git', ['-C', f.clone, 'commit-graph', 'write', '--reachable'], { env: f.env })
  // The tip's parent (the first main) now has the agent's commit as its parent, in the graph only.
  await forgeCommitGraph(join(f.clone, '.git', 'objects', 'info', 'commit-graph'), f.main, evil)
  assert.equal(await plainIsAncestor(f, evil, tip), true, 'the fixture is real: the graph makes it an ancestor')
  assert.match(reasonOf(await check(f, { commit: evil })), /isn't on origin\/main/)
})

test("onMergedCode { commit }: a gitlink on GitHub's main doesn't stop it (a fresh checkout leaves it empty)", async () => {
  const f = await fixture()
  const tip = await pushToMain(f, 'b', 'b\n', async work => {
    const env = await scratchGitEnv(dirname(work))
    await runOk('git', ['-C', work, 'update-index', '--add', '--cacheinfo', `160000,${f.main},vendor/sub`], { env })
  })
  await fetch(f)
  assert.deepEqual(await check(f, { commit: tip }), { ok: true })
})

test("onMergedCode { commit }: an unknown commit, or one that looks like an option, isn't merged", async () => {
  const f = await fixture()
  assert.match(reasonOf(await check(f, { commit: 'f'.repeat(40) })), /isn't in the clone/)
  assert.match(reasonOf(await check(f, { commit: '--all' })), /isn't a commit/)
  assert.match(reasonOf(await check(f, { commit: '' })), /isn't a commit/)
})

test("onMergedCode: when GitHub can't be asked, or its main isn't in the clone, it couldn't confirm", async () => {
  const f = await fixture()
  // GitHub has moved on since the last fetch.
  await pushToMain(f, 'b', 'b\n')
  const behind = reasonOf(await check(f, { commit: f.main }))
  assert.match(behind, /^couldn't confirm the default branch with GitHub/)
  assert.match(behind, /isn't in the clone/)
  await fetch(f)
  assert.deepEqual(await check(f, { commit: f.main }), { ok: true })
  // GitHub can't be reached.
  await runOk('git', ['-C', f.clone, 'remote', 'set-url', 'origin', `file://${join(f.dir, 'nowhere.git')}`], { env: f.env })
  assert.match(reasonOf(await check(f, { commit: f.main })), /^couldn't confirm the default branch with GitHub/)
})

test("onMergedCode: a default branch that isn't GitHub's is refused", async () => {
  const f = await fixture()
  const evil = await agentCommit(f)
  // An agent can point origin/HEAD at its own branch; GitHub's HEAD still says main.
  const reason = reasonOf(await check(f, { commit: evil }, 'dish/x'))
  assert.match(reason, /^couldn't confirm the default branch with GitHub/)
  assert.match(reason, /GitHub's default branch is main, not dish\/x/)
})

test('onMergedCode: an aborted signal is not merged', async () => {
  const f = await fixture()
  const controller = new AbortController()
  controller.abort()
  assert.match(reasonOf(await check(f, { commit: f.main }, 'main', controller.signal)), /aborted/)
})

