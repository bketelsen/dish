import assert from 'node:assert/strict'
import { chmod, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { ShellExecRequest, ShellExecSpec, ShellExecution, ShellRunResult } from '@deepseek-ai/dsh-shell'
import { maskSecrets } from 'dish-kit'
import { gateEnvironment } from '../src/env.ts'
import { gateLogFile } from '../src/logs.ts'
import { gateCommand, GATE_MAX_TIMEOUT_MS, OUTPUT_MAX_BYTES, runGate } from '../src/run.ts'
import type { GateRun, GateRunResult, ShellLike } from '../src/run.ts'
import { tempDir } from './helpers.ts'
import { goneWithin, processesWith, SKIP, withRealShell } from './shell-helpers.ts'

const TOKEN = `ghs_${'A1b2C3d4E5'.repeat(4)}`
const MASKED = maskSecrets(TOKEN)
const WORKTREE = { path: '/w/acme/widget/.worktrees/fix-1', clone: '/w/acme/widget' }

// --- a fake shell -------------------------------------------------------------------------------------------------

type Outcome = Partial<Omit<ShellRunResult, 'stdout' | 'stderr'>> & { stdout?: string, stderr?: string, truncated?: boolean, spillPath?: string }

interface FakeShell extends ShellLike {
  requests: ShellExecRequest[]
  specs: ShellExecSpec[]
}

/** A shell that records what it's asked and settles with `outcome` (or what it computes from the spec). */
function fakeShell(options: {
  sandboxMode?: SandboxMode | undefined
  outcome?: Outcome | ((spec: ShellExecSpec) => Promise<Outcome> | Outcome)
  execute?: (spec: ShellExecSpec) => Promise<never>
  resolve?: (request: ShellExecRequest) => never
  tick?: () => void
} = {}): FakeShell {
  const requests: ShellExecRequest[] = []
  const specs: ShellExecSpec[] = []
  return {
    requests,
    specs,
    sandboxMode: 'sandboxMode' in options ? options.sandboxMode : 'workspace-write',
    resolve(request: ShellExecRequest): ShellExecSpec {
      options.tick?.()
      requests.push(request)
      if (options.resolve !== undefined) options.resolve(request)
      return {
        command: request.command,
        workdir: request.workdir ?? '/nowhere',
        timeoutMs: Math.min(request.timeoutMs ?? 120_000, 600_000),
        onExpiry: request.onExpiry ?? 'kill',
        stdoutMaxBytes: request.stdoutMaxBytes ?? 64_000,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        ...(request.env === undefined ? {} : { env: request.env }),
        sandboxPolicy: request.sandboxPolicy,
      }
    },
    async execute(spec: ShellExecSpec): Promise<ShellExecution> {
      options.tick?.()
      specs.push(spec)
      if (options.execute !== undefined) return options.execute(spec)
      const result = async (): Promise<ShellRunResult> => {
        options.tick?.()
        const given = typeof options.outcome === 'function' ? await options.outcome(spec) : options.outcome ?? {}
        return {
          exitCode: 'exitCode' in given ? given.exitCode! : 0,
          signal: given.signal ?? null,
          timedOut: given.timedOut ?? false,
          aborted: given.aborted ?? false,
          timeoutMs: given.timeoutMs ?? spec.timeoutMs,
          stdout: { text: given.stdout ?? '', truncated: given.truncated ?? false, ...given.spillPath === undefined ? {} : { spillPath: given.spillPath } },
          stderr: { text: given.stderr ?? '', truncated: false },
          sandbox: { mode: 'workspace-write', denied: false, enforcement: 'full' },
        }
      }
      return { result } as unknown as ShellExecution
    },
  }
}

async function gate(shell: ShellLike, overrides: Partial<GateRun> = {}): Promise<{ result: GateRunResult, log: string }> {
  const state = await tempDir()
  const log = gateLogFile(state, 'acme/widget', 'fix-1', 'child-1', 1, 1)
  const result = await runGate({
    shell,
    command: 'make test',
    worktree: WORKTREE,
    timeoutMs: 300_000,
    env: {},
    log,
    signal: new AbortController().signal,
    sessionId: 'child-1',
    ...overrides,
  })
  return { result, log }
}

function ran(result: GateRunResult): Extract<GateRunResult, { kind: 'ran' }> {
  assert.equal(result.kind, 'ran', JSON.stringify(result))
  return result as Extract<GateRunResult, { kind: 'ran' }>
}

// --- with a fake shell --------------------------------------------------------------------------------------------

test('gateCommand joins stderr to stdout, then the gate', () => {
  assert.equal(gateCommand('make test'), 'exec 2>&1\nmake test')
  assert.equal(OUTPUT_MAX_BYTES, 4 * 1024 * 1024)
  assert.equal(GATE_MAX_TIMEOUT_MS, 600_000)
})

test('a shell that doesn\'t sandbox runs nothing: error, before resolve or execute', async () => {
  const shell = fakeShell({ sandboxMode: undefined })
  const { result } = await gate(shell)
  assert.deepEqual(result, { kind: 'error', reason: 'dsh\'s shell here doesn\'t sandbox commands, so dish won\'t run the gate', durationMs: 0 })
  assert.equal(shell.requests.length, 0)
  assert.equal(shell.specs.length, 0)
})

test('the request: the joined command in the worktree, the clone as the workspace root, the timeout, 4 MiB and gateEnv only', async () => {
  const shell = fakeShell()
  const signal = new AbortController().signal
  const env = gateEnvironment({ GOCACHE: '<clone>/.worktrees/.cache/go-build' }, { clone: WORKTREE.clone, worktree: WORKTREE.path })
  await gate(shell, { env, signal, timeoutMs: 90_000 })
  assert.equal(shell.requests.length, 1)
  const request = shell.requests[0]!
  assert.deepEqual(Object.keys(request).sort(), ['command', 'env', 'onExpiry', 'sandboxPolicy', 'signal', 'stdoutMaxBytes', 'timeoutMs', 'workdir'])
  assert.equal(request.command, 'exec 2>&1\nmake test')
  assert.equal(request.workdir, WORKTREE.path)
  assert.deepEqual(request.sandboxPolicy, { mode: 'workspace-write', workspaceRoot: WORKTREE.clone, sessionId: 'child-1' })
  assert.equal(request.timeoutMs, 90_000)
  assert.equal(request.onExpiry, 'kill')
  assert.equal(request.stdoutMaxBytes, 4_194_304)
  assert.deepEqual(request.env, { GOCACHE: '/w/acme/widget/.worktrees/.cache/go-build' })
  assert.notEqual(request.env, env, 'a copy')
  assert.equal(request.signal, signal)
  assert.equal(request.stdin, undefined)
  assert.equal(request.dshEnv, undefined)
  assert.equal(shell.specs.length, 1)
})

test('without a session id the policy has none; with an empty gateEnv the env is {}', async () => {
  const shell = fakeShell()
  await gate(shell, { sessionId: undefined })
  assert.deepEqual(shell.requests[0]!.sandboxPolicy, { mode: 'workspace-write', workspaceRoot: WORKTREE.clone })
  assert.deepEqual(shell.requests[0]!.env, {})
})

test('a timeout over 10 minutes is asked for as 600000 ms, and the limit that applied is reported', async () => {
  const shell = fakeShell({ outcome: spec => ({ timedOut: true, exitCode: null, signal: 'SIGTERM', timeoutMs: spec.timeoutMs }) })
  const { result } = await gate(shell, { timeoutMs: 900_000 })
  assert.equal(shell.requests[0]!.timeoutMs, 600_000)
  const r = ran(result)
  assert.equal(r.timeoutMs, 600_000)
  assert.equal(r.timedOut, true)
  assert.equal(r.exitCode, null)
})

test('exit 0, and exit 3: the code, the output, and the log with its header', async () => {
  const pass = await gate(fakeShell({ outcome: { exitCode: 0, stdout: 'ok  acme/widget\n' } }))
  const passed = ran(pass.result)
  assert.equal(passed.exitCode, 0)
  assert.equal(passed.timedOut, false)
  assert.equal(passed.output, 'ok  acme/widget\n')
  assert.equal(passed.truncated, false)
  assert.equal(passed.denied, false)
  assert.equal(passed.log, pass.log)
  assert.equal(passed.logProblem, undefined)
  const log = await readFile(pass.log, 'utf8')
  assert.match(log, /^# gate: make test\n# in: \/w\/acme\/widget\/\.worktrees\/fix-1\n# ended: exit 0, after \d+ ms\nok {2}acme\/widget\n$/)
  assert.equal((await stat(pass.log)).mode & 0o777, 0o600)

  const fail = await gate(fakeShell({ outcome: { exitCode: 3, stdout: 'FAIL thing\n' } }))
  const failed = ran(fail.result)
  assert.equal(failed.exitCode, 3)
  assert.match(await readFile(fail.log, 'utf8'), /^# gate: make test\n# in: .*\n# ended: exit 3, after \d+ ms\nFAIL thing\n$/)
})

test('a timeout is reported, and the log says so', async () => {
  const { result, log } = await gate(fakeShell({ outcome: { timedOut: true, exitCode: null, signal: 'SIGTERM', stdout: 'slow\n' } }), { timeoutMs: 120_000 })
  const r = ran(result)
  assert.equal(r.timedOut, true)
  assert.equal(r.timeoutMs, 120_000)
  assert.match(await readFile(log, 'utf8'), /^# gate: make test\n# in: .*\n# ended: timed out at 120000 ms, after \d+ ms\nslow\n$/)
})

test('killed with no exit code, and not by its timeout: the log says killed', async () => {
  const { result, log } = await gate(fakeShell({ outcome: { exitCode: null, signal: 'SIGKILL', stdout: '' } }))
  assert.equal(ran(result).exitCode, null)
  assert.match(await readFile(log, 'utf8'), /^# gate: make test\n# in: .*\n# ended: killed, after \d+ ms\n$/)
})

test('an abort is cancelled: aborted, a signal that aborts while it runs, or one aborted before it starts', async () => {
  const aborted = await gate(fakeShell({ outcome: { aborted: true, exitCode: null, signal: 'SIGTERM' } }))
  assert.deepEqual(aborted.result, { kind: 'cancelled' })
  await assert.rejects(stat(aborted.log), { code: 'ENOENT' })

  const controller = new AbortController()
  const during = await gate(fakeShell({ outcome: () => { controller.abort(); return { exitCode: 0 } } }), { signal: controller.signal })
  assert.deepEqual(during.result, { kind: 'cancelled' })

  const before = new AbortController()
  before.abort()
  const shell = fakeShell()
  assert.deepEqual((await gate(shell, { signal: before.signal })).result, { kind: 'cancelled' })
  assert.equal(shell.specs.length, 0)
})

test('a rejection is an error, masked, on one line, at most 300 characters; with the signal aborted it is cancelled', async () => {
  const fails = (error: unknown) => fakeShell({ outcome: () => { throw error } })
  const plain = await gate(fails(new Error(`runner broke\nwith ${TOKEN} in it`)))
  assert.equal(plain.result.kind, 'error')
  const reason = (plain.result as { reason: string }).reason
  assert.equal(reason, `the sandbox couldn't run the gate: runner broke with ${MASKED} in it`)
  await assert.rejects(stat(plain.log), { code: 'ENOENT' })

  const long = await gate(fails(new Error('x'.repeat(1000))))
  const longReason = (long.result as { reason: string }).reason
  assert.ok(longReason.length <= 300, String(longReason.length))
  assert.ok(longReason.startsWith('the sandbox couldn\'t run the gate: xxx'))

  const execute = await gate(fakeShell({ execute: async () => { throw new Error('spawn failed') } }))
  assert.deepEqual(execute.result.kind, 'error')
  assert.match((execute.result as { reason: string }).reason, /spawn failed$/)

  const resolve = await gate(fakeShell({ resolve: () => { throw new Error('bash-local: request.timeoutMs must be a positive finite number') } }), { timeoutMs: 0 })
  assert.equal(resolve.result.kind, 'error')

  const controller = new AbortController()
  const cancelled = await gate(fakeShell({ outcome: () => { controller.abort(); throw new Error('aborted') } }), { signal: controller.signal })
  assert.deepEqual(cancelled.result, { kind: 'cancelled' })
})

test('SANDBOX_UNAVAILABLE is an error that names it and the runner\'s failure, never a retry', async () => {
  const error = Object.assign(new Error('sandbox mode "workspace-write" is requested but no sandbox backend is usable on this host; refusing to run the command unconfined. Install bubblewrap or run a Landlock-enforcing kernel (Linux), ensure sandbox-exec is usable (macOS), or ensure the ACL restricted-token runner can start (Windows) — otherwise switch the consumer to danger-full-access. Runner failure: bwrap: setting up uid map: Permission denied'), { code: 'SANDBOX_UNAVAILABLE' })
  const shell = fakeShell({ outcome: () => { throw error } })
  const { result } = await gate(shell)
  assert.deepEqual(result.kind, 'error')
  assert.equal((result as { reason: string }).reason, 'the sandbox couldn\'t run the gate: no sandbox runner works here (SANDBOX_UNAVAILABLE): bwrap: setting up uid map: Permission denied')
  assert.equal(shell.specs.length, 1, 'run once, not again')
})

test('the output is masked, in the result and in the log', async () => {
  const { result, log } = await gate(fakeShell({ outcome: { exitCode: 1, stdout: `token=${TOKEN}\nFAIL\n` } }))
  const r = ran(result)
  assert.equal(r.output, `token=${MASKED}\nFAIL\n`)
  const text = await readFile(log, 'utf8')
  assert.equal(text.includes(TOKEN), false)
  assert.ok(text.endsWith(`token=${MASKED}\nFAIL\n`))
})

test('the runner\'s own stderr comes after the output under a [stderr] line, masked too', async () => {
  const { result } = await gate(fakeShell({ outcome: { exitCode: 1, stdout: 'out', stderr: `dish-sandbox: no ${TOKEN}\n` } }))
  assert.equal(ran(result).output, `out\n[stderr]\ndish-sandbox: no ${MASKED}\n`)
  const none = await gate(fakeShell({ outcome: { exitCode: 0, stdout: 'out\n', stderr: '' } }))
  assert.equal(ran(none.result).output, 'out\n')
})

test('"Read-only file system" in the output is a denial', async () => {
  const { result } = await gate(fakeShell({ outcome: { exitCode: 1, stdout: 'touch: cannot touch \'/usr/x\': Read-only file system\n' } }))
  assert.equal(ran(result).denied, true)
  const other = await gate(fakeShell({ outcome: { exitCode: 1, stdout: 'Permission denied\n' } }))
  assert.equal(ran(other.result).denied, false)
})

test('output cut to its last 4 MiB: truncated, the log says so, and the cut first line goes before masking', async () => {
  // The kept tail starts partway through a line: the rest of a token there would not be known to the mask.
  const { result, log } = await gate(fakeShell({ outcome: { exitCode: 1, stdout: 'Rb0dyOfATokenWithoutItsPrefix123456\ntail\n', truncated: true } }))
  assert.equal(ran(result).truncated, true)
  const text = await readFile(log, 'utf8')
  assert.match(text, /^# gate: make test\n# in: .*\n# ended: exit 1, after \d+ ms\n# output cut: only its last 4 MiB are kept\ntail\n$/)
  assert.doesNotMatch(text, /b0dyOfAToken/)
  assert.doesNotMatch(ran(result).output, /b0dyOfAToken/)
})

test('dsh\'s spill file of a cut run is removed: it is unmasked, and the gate keeps its own log', async () => {
  const dir = await tempDir()
  const spill = join(dir, 'stdout.spill')
  await writeFile(spill, 'the whole stream, unmasked')
  await gate(fakeShell({ outcome: { exitCode: 1, stdout: 'x\ntail\n', truncated: true, spillPath: spill } }))
  await assert.rejects(readFile(spill, 'utf8'), { code: 'ENOENT' })
})

test('a log that can\'t be written: no log and why, and the result stands', async () => {
  const state = await tempDir()
  await writeFile(join(state, 'gates'), 'a file where the directory goes')
  const log = gateLogFile(state, 'acme/widget', 'fix-1', 'child-1', 1, 1)
  const result = ran((await gate(fakeShell({ outcome: { exitCode: 3, stdout: 'x\n' } }), { log })).result)
  assert.equal(result.exitCode, 3)
  assert.equal(result.log, null)
  assert.match(result.logProblem ?? '', /ENOTDIR|EEXIST/)
})

test('durationMs runs from before resolve to the result', async () => {
  let clock = 1000
  const shell = fakeShell({ tick: () => { clock += 10 }, outcome: { exitCode: 0 } })
  const { result } = await gate(shell, { now: () => clock })
  // resolve, execute and result each move the clock by 10.
  assert.equal(ran(result).durationMs, 30)
})

// --- with dsh's real shell ----------------------------------------------------------------------------------------

let rounds = 0

/** runGate in the world's worktree, with a log of its own under the world's directory. */
async function realGate(world: { shell: ShellLike, dir: string, clone: string, worktree: string }, command: string, overrides: Partial<GateRun> = {}): Promise<GateRunResult> {
  return runGate({
    shell: world.shell,
    command,
    worktree: { path: world.worktree, clone: world.clone },
    timeoutMs: 30_000,
    env: {},
    log: gateLogFile(join(world.dir, 'state'), 'acme/widget', 'fix-1', 'child-1', 1, ++rounds),
    signal: new AbortController().signal,
    sessionId: 'child-1',
    ...overrides,
  })
}

/** A number no other process on the machine has in its command line. */
function marker(): string {
  return `31.${process.pid}${Date.now() % 1_000_000}${Math.floor(Math.random() * 1000)}`
}

test('real: a passing gate and a failing one, with both streams in order', { skip: SKIP }, async () => {
  await withRealShell({}, async world => {
    const pass = ran(await realGate(world, 'echo one; echo two >&2; echo three'))
    assert.equal(pass.exitCode, 0)
    assert.equal(pass.output, 'one\ntwo\nthree\n')
    assert.ok(pass.log !== null && (await readFile(pass.log, 'utf8')).endsWith('one\ntwo\nthree\n'))
    const fail = ran(await realGate(world, 'echo a; echo b >&2; exit 3'))
    assert.equal(fail.exitCode, 3)
    assert.equal(fail.timedOut, false)
    assert.equal(fail.output, 'a\nb\n')
  })
})

test('real: the gate writes the worktree, and git status there works (the clone\'s .git is writable)', { skip: SKIP }, async () => {
  await withRealShell({}, async world => {
    const r = ran(await realGate(world, `echo hi > made-by-gate.txt && git -C '${world.worktree}' status --porcelain --ignore-submodules=dirty`))
    assert.equal(r.exitCode, 0, r.output)
    assert.match(r.output, /\?\? made-by-gate\.txt/)
    assert.equal(await readFile(join(world.worktree, 'made-by-gate.txt'), 'utf8'), 'hi\n')
  })
})

test('real, without the runner: writes outside the clone are refused, /usr with "Read-only file system"', { skip: SKIP }, async () => {
  await withRealShell({}, async world => {
    const name = `dish-gates-${marker()}`
    const usr = ran(await realGate(world, `touch /usr/${name}`))
    assert.notEqual(usr.exitCode, 0)
    assert.match(usr.output, /Read-only file system/)
    assert.equal(usr.denied, true)
    await assert.rejects(stat(`/usr/${name}`), { code: 'ENOENT' })

    const home = ran(await realGate(world, 'touch "$HOME/x"'))
    assert.notEqual(home.exitCode, 0)
    await assert.rejects(stat(join(world.home, 'x')), { code: 'ENOENT' })

    // /tmp is the call's own: a write there succeeds and is gone afterwards.
    const tmp = ran(await realGate(world, `touch /tmp/${name} && ls /tmp/${name}`))
    assert.equal(tmp.exitCode, 0, tmp.output)
    await assert.rejects(stat(`/tmp/${name}`), { code: 'ENOENT' })
  })
})

test('real, with dish-sandbox as the runner: the home directory is written, ~/.ssh is refused', { skip: SKIP }, async () => {
  await withRealShell({ runner: true }, async world => {
    const r = ran(await realGate(world, 'touch "$HOME/x" && mkdir -p "$HOME/.cache" && touch "$HOME/.cache/x" && echo home-ok; touch "$HOME/.ssh/x"; echo "ssh=$?"'))
    assert.match(r.output, /home-ok\n/)
    assert.match(r.output, /Read-only file system/)
    assert.match(r.output, /ssh=1\n/)
    assert.equal(r.denied, true)
    assert.equal((await stat(join(world.home, 'x'))).isFile(), true)
    assert.equal((await stat(join(world.home, '.cache', 'x'))).isFile(), true)
    await assert.rejects(stat(join(world.home, '.ssh', 'x')), { code: 'ENOENT' })
  })
})

test('real: a runner that fails is SANDBOX_UNAVAILABLE, an error, and the gate never ran', async () => {
  const dir = await tempDir()
  const runner = join(dir, 'broken-runner')
  await writeFile(runner, '#!/bin/sh\necho "dish-sandbox: this runner is broken" >&2\nexit 1\n')
  await chmod(runner, 0o755)
  await withRealShell({ runner: [runner] }, async world => {
    const result = await realGate(world, 'touch ran-anyway')
    assert.equal(result.kind, 'error', JSON.stringify(result))
    assert.match((result as { reason: string }).reason, /^the sandbox couldn't run the gate: no sandbox runner works here \(SANDBOX_UNAVAILABLE\): .*this runner is broken/)
    await assert.rejects(stat(join(world.worktree, 'ran-anyway')), { code: 'ENOENT' })
  })
})

/**
 * How dsh's subprocess service holds a gate's processes: in a transient user-systemd scope where this machine has a user
 * manager (as dish's VM does), else in a process group. The kill tests run under both.
 */
const CONTAINMENT: ReadonlyArray<[string, Record<string, undefined>]> = [
  ['as this machine runs dsh (a user-systemd scope, when there is a user manager)', {}],
  ['without a user systemd manager (dsh\'s process-group fallback)', { XDG_RUNTIME_DIR: undefined, DBUS_SESSION_BUS_ADDRESS: undefined }],
]

/** Wait up to 5 s for a process holding `mark` to appear: the gate's grandchild has started. */
async function started(mark: string): Promise<void> {
  const until = Date.now() + 5000
  while ((await processesWith(mark)).length === 0) {
    assert.ok(Date.now() < until, `no process with ${mark} started`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

for (const [how, env] of CONTAINMENT) {
  test(`real: a timeout kills the gate and its grandchildren, ${how}`, { skip: SKIP }, async () => {
    await withRealShell({ env }, async world => {
      const mark = marker()
      // 2 s, so that the grandchild is up before the deadline even on a busy machine: the start of the scope, bwrap and
      // bash all count against it.
      const running = realGate(world, `sleep ${mark} & wait`, { timeoutMs: 2000 })
      await started(mark)
      const r = ran(await running)
      assert.equal(r.timedOut, true)
      assert.equal(r.timeoutMs, 2000)
      assert.deepEqual(await goneWithin(mark, 2000), [])
    })
  })

  test(`real: an abort kills the gate and its grandchildren, and is cancelled, ${how}`, { skip: SKIP }, async () => {
    await withRealShell({ env }, async world => {
      const mark = marker()
      const controller = new AbortController()
      const running = realGate(world, `sleep ${mark} & wait`, { signal: controller.signal })
      await started(mark)
      controller.abort()
      assert.deepEqual(await running, { kind: 'cancelled' })
      assert.deepEqual(await goneWithin(mark, 2000), [])
    })
  })
}

test('real: gateEnv reaches the gate expanded, and HOME and the cache variables are dsh\'s own, not the clone\'s', { skip: SKIP }, async () => {
  await withRealShell({}, async world => {
    const env = gateEnvironment({ IN_CLONE: '<clone>/.worktrees/.cache/go-build', IN_WORKTREE: '<worktree>/bin' }, { clone: world.clone, worktree: world.worktree })
    const names = ['IN_CLONE', 'IN_WORKTREE', 'HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CONFIG_HOME', 'GOPATH', 'npm_config_cache', 'CARGO_HOME']
    const r = ran(await realGate(world, names.map(name => `echo "${name}=\${${name}-unset}"`).join('; '), { env }))
    assert.equal(r.exitCode, 0, r.output)
    const seen = Object.fromEntries(r.output.trim().split('\n').map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]))
    assert.equal(seen.IN_CLONE, `${world.clone}/.worktrees/.cache/go-build`)
    assert.equal(seen.IN_WORKTREE, `${world.worktree}/bin`)
    for (const name of names.slice(2)) {
      assert.equal(seen[name], world.vars[name], name)
      assert.ok(!seen[name]!.startsWith(world.clone), `${name} is in the clone`)
    }
  })
})

test('real: asked for 900000 ms, the run reports 600000', { skip: SKIP }, async () => {
  await withRealShell({}, async world => {
    const r = ran(await realGate(world, 'true', { timeoutMs: 900_000 }))
    assert.equal(r.timeoutMs, 600_000)
    assert.equal(r.exitCode, 0)
  })
})

test('real: the log is written with its header, 0600 in 0700 directories', { skip: SKIP }, async () => {
  await withRealShell({}, async world => {
    const log = gateLogFile(join(world.dir, 'state'), 'acme/widget', 'fix-1', 'child-1', 2, 1)
    const r = ran(await realGate(world, `echo ${TOKEN}; exit 2`, { log }))
    assert.equal(r.log, log)
    const text = await readFile(log, 'utf8')
    const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // The gate's command is masked in the header too.
    assert.match(text, new RegExp(`^# gate: echo ${escape(MASKED)}; exit 2\\n# in: ${escape(world.worktree)}\\n# ended: exit 2, after \\d+ ms\\n${escape(MASKED)}\\n$`))
    assert.equal(text.includes(TOKEN), false)
    assert.equal((await stat(log)).mode & 0o777, 0o600)
    assert.equal((await stat(join(world.dir, 'state', 'gates', 'acme', 'widget', 'fix-1'))).mode & 0o777, 0o700)
  })
})
