/**
 * `runAt`: the project's gate in a worktree dish made, for open_pr (`check.ts`). A fake run and stub services, with the real
 * `WorktreeLocks` it shares with the listener; and once with dsh's real shell, in a real clone.
 *
 * @module dish-gates/test/check
 */

import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { CrewRecords } from 'dish-crew'
import type { Project } from 'dish-projects'
import type { Worktree } from 'dish-workspaces'
import { maskSecrets } from 'dish-kit'
import { gateCheck } from '../src/check.ts'
import type { CheckDeps, GateCheck } from '../src/check.ts'
import { gateListener } from '../src/listener.ts'
import { WorktreeLocks } from '../src/locks.ts'
import type { GateRun, GateRunResult, ShellLike } from '../src/run.ts'
import { runGate } from '../src/run.ts'
import { runOk, scratchGitEnv, tempDir } from './helpers.ts'
import { SKIP, withRealShell } from './shell-helpers.ts'

const SESSION = 'main-1'
const CLONE = '/w/acme/widget'
const FIX1 = `${CLONE}/.worktrees/fix-1`
const FIX2 = `${CLONE}/.worktrees/fix-2`
const HEAD = '3f1c9a7e5b2d4f6081a3c5e7f9b1d3e5a7c9e1f3'
const OTHER = 'b'.repeat(40)
const NOW = 1_700_000_000_000
const TOKEN = `ghs_${'A1b2C3d4E5'.repeat(4)}`

const PROJECT: Project = {
  name: 'acme/widget', owner: 'acme', repo: 'widget', family: 'anthropic', role: 'coder',
  gate: 'pnpm lint && pnpm test', gateTimeout: '5m', gateTimeoutMs: 300_000,
  setup: undefined, setupTimeout: '15m', setupTimeoutMs: 900_000, gateEnv: {},
}

function worktreeOf(path: string): Worktree {
  const slug = path.slice(path.lastIndexOf('/') + 1)
  return { project: 'acme/widget', slug, branch: `dish/${slug}`, path, clone: CLONE, base: 'abc123' }
}

/** What the fake run gives for one gate run. */
type Outcome = (run: GateRun) => GateRunResult | Promise<GateRunResult>

const ran = (fields: Partial<Extract<GateRunResult, { kind: 'ran' }>> = {}): Outcome => run => ({
  kind: 'ran', exitCode: 0, timedOut: false, timeoutMs: 300_000, durationMs: 42_000, output: 'all good\n',
  truncated: false, denied: false, log: run.log, ...fields,
})
const pass = ran()

function deferred<T = void>(): { promise: Promise<T>, resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

async function until(condition: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!condition()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise(settle => setTimeout(settle, 5))
  }
}

interface World {
  directory: string
  state: string
  deps: CheckDeps
  runAt: ReturnType<typeof gateCheck>
  locks: WorktreeLocks
  /** Every run, in order. */
  runs: GateRun[]
  /** What the next runs give, in order; with none left, a run passes. */
  script: Outcome[]
  services: { workspaces: boolean, projects: boolean, shell: boolean }
  unresolved: Map<string, string | undefined>
  /** What `headOf` gives for a path, when not HEAD: a value, or an Error it throws. */
  commits: Map<string, string | undefined | Error>
  project: Project | undefined
  plugin: AbortController
  warns: string[]
  infos: string[]
}

async function world(): Promise<World> {
  const directory = await tempDir()
  const shell: ShellLike = {
    sandboxMode: 'workspace-write',
    resolve: () => { throw new Error('the fake run never uses the shell') },
    execute: () => { throw new Error('the fake run never uses the shell') },
  }
  const w: Omit<World, 'deps' | 'runAt'> & Partial<Pick<World, 'deps' | 'runAt'>> = {
    directory,
    state: join(directory, 'state'),
    locks: new WorktreeLocks(),
    runs: [],
    script: [],
    services: { workspaces: true, projects: true, shell: true },
    unresolved: new Map(),
    commits: new Map(),
    project: PROJECT,
    plugin: new AbortController(),
    warns: [],
    infos: [],
  }
  w.deps = {
    workspaces: () => w.services.workspaces
      ? {
          resolve: async (ref: string) => w.unresolved.has(ref) ? undefined : worktreeOf(ref),
          resolveProblem: async (ref: string) => w.unresolved.get(ref),
          headOf: async (ref: string) => {
            const given = w.commits.has(ref) ? w.commits.get(ref) : HEAD
            if (given instanceof Error) throw given
            return given
          },
        }
      : undefined,
    projects: () => w.services.projects ? { get: async (name: string) => name === 'acme/widget' ? w.project : undefined } : undefined,
    shell: () => w.services.shell ? shell : undefined,
    state: w.state,
    signal: w.plugin.signal,
    locks: w.locks,
    environment: () => ({ PATH: '/usr/bin:/bin', HOME: join(directory, 'home') }),
    logger: {
      warn: (format, ...args) => { w.warns.push(format.replace(/%[sd]/g, () => String(args.shift()))) },
      info: (format, ...args) => { w.infos.push(format.replace(/%[sd]/g, () => String(args.shift()))) },
    },
    now: () => NOW,
    run: async (run) => {
      w.runs.push(run)
      return (w.script.shift() ?? pass)(run)
    },
  }
  w.runAt = gateCheck(w.deps)
  return w as World
}

/** An `error` result: nothing ran. */
function notRun(reason: string, head: string | null = null): GateCheck {
  return { outcome: 'error', command: '', exitCode: null, timedOut: false, durationMs: 0, log: null, excerpt: '', reason, at: NOW, head }
}

test('runAt runs the project\'s gate in the worktree for the given session, and gives passed with the head and the log path <state>/gates/acme/widget/fix-1/open_pr.log', async () => {
  const w = await world()
  const result = await w.runAt('acme/widget', FIX1, { sessionId: SESSION })
  const log = join(w.state, 'gates', 'acme', 'widget', 'fix-1', 'open_pr.log')
  assert.deepEqual(result, {
    outcome: 'passed', command: 'pnpm lint && pnpm test', exitCode: 0, timedOut: false, durationMs: 42_000, log, excerpt: 'all good', at: NOW, head: HEAD,
  })
  assert.equal(w.runs.length, 1)
  const run = w.runs[0]!
  assert.equal(run.command, 'pnpm lint && pnpm test')
  assert.deepEqual(run.worktree, { path: FIX1, clone: CLONE })
  assert.equal(run.timeoutMs, 300_000)
  assert.equal(run.log, log)
  assert.equal(run.sessionId, SESSION)
  assert.equal(run.shell, w.deps.shell())
  assert.equal(run.signal.aborted, false)
  assert.deepEqual(w.infos, [`open_pr's gate for acme/widget/fix-1 at ${HEAD.slice(0, 12)}: passed in 42 s`])
  assert.deepEqual(w.warns, [])
  // The project is compared without case.
  assert.equal((await w.runAt('Acme/Widget', FIX1, { sessionId: SESSION })).outcome, 'passed')
})

test('runAt: a failure gives failed with the excerpt and the log; nothing is recorded, steered or published', async () => {
  const w = await world()
  const records = new CrewRecords(join(w.directory, 'crew'))
  await records.addChild(SESSION, { id: 'c1', role: 'coder', title: 'task', model: 'claude-fake', family: 'anthropic', worktree: FIX1 })
  w.project = { ...PROJECT, gate: `GH_TOKEN=${TOKEN} pnpm test` }
  w.script.push(ran({ exitCode: 1, output: `not ok 1 - adds ${maskSecrets(TOKEN)}\n# fail 1\n` }))
  const result = await w.runAt('acme/widget', FIX1, { sessionId: SESSION })
  assert.deepEqual(result, {
    outcome: 'failed', command: `GH_TOKEN=${maskSecrets(TOKEN)} pnpm test`, exitCode: 1, timedOut: false, durationMs: 42_000,
    log: join(w.state, 'gates', 'acme', 'widget', 'fix-1', 'open_pr.log'), excerpt: `not ok 1 - adds ${maskSecrets(TOKEN)}\n# fail 1`, at: NOW, head: HEAD,
  })
  assert.equal(w.runs[0]!.command, `GH_TOKEN=${TOKEN} pnpm test`, 'the run gets the gate as it is')
  assert.deepEqual(w.infos, [`open_pr's gate for acme/widget/fix-1 at ${HEAD.slice(0, 12)}: failed in 42 s (exit 1)`])
  assert.ok(![...w.infos, ...w.warns].some(line => line.includes(TOKEN)))
  assert.equal((await records.lookup('c1'))?.record.gates, undefined, 'crew\'s record holds nothing of it')
  // A timeout is a failure too.
  w.script.push(ran({ exitCode: null, timedOut: true, timeoutMs: 600_000, durationMs: 600_000 }))
  const late = await w.runAt('acme/widget', FIX1, { sessionId: SESSION })
  assert.deepEqual([late.outcome, late.timedOut, late.exitCode], ['failed', true, null])
})

test('runAt with head: a worktree whose HEAD moved is an error and nothing runs; the same head runs', async () => {
  const w = await world()
  const moved = await w.runAt('acme/widget', FIX1, { sessionId: SESSION, head: OTHER })
  assert.deepEqual(moved, notRun(`the worktree's HEAD is ${HEAD}, not ${OTHER}: it moved after the caller read it`, HEAD))
  assert.deepEqual(w.runs, [])
  assert.equal(w.warns.length, 1)
  const same = await w.runAt('acme/widget', FIX1, { sessionId: SESSION, head: HEAD })
  assert.deepEqual([same.outcome, same.head], ['passed', HEAD])
  assert.equal(w.runs.length, 1)
})

test('runAt: a worktree of another project, no dish-workspaces, an unresolved worktree (with and without a problem), no dish-projects, an unregistered project and no shell are each an error, and nothing runs', async () => {
  const w = await world()
  const at = (project = 'acme/widget', path = FIX1): Promise<GateCheck> => w.runAt(project, path, { sessionId: SESSION })
  assert.deepEqual(await at('acme/other'), notRun(`the worktree ${FIX1} is acme/widget's, not acme/other's`))
  w.services.workspaces = false
  assert.deepEqual(await at(), notRun('dish-workspaces isn\'t running'))
  w.services.workspaces = true
  w.unresolved.set(FIX1, `acme/widget's clone failed dish's safety check: http.extraHeader is set to ${TOKEN}`)
  assert.deepEqual(await at(), notRun(`acme/widget's clone failed dish's safety check: http.extraHeader is set to ${maskSecrets(TOKEN)}`))
  w.unresolved.set(FIX1, undefined)
  assert.deepEqual(await at(), notRun(`no worktree dish made at ${FIX1} in a registered project`))
  w.unresolved.delete(FIX1)
  w.services.projects = false
  assert.deepEqual(await at(), notRun('dish-projects isn\'t running'))
  w.services.projects = true
  w.project = undefined
  assert.deepEqual(await at(), notRun('acme/widget isn\'t in projects.yaml'))
  w.project = PROJECT
  w.commits.set(FIX1, new Error('EIO'))
  assert.deepEqual(await at(), notRun('dish couldn\'t read the worktree\'s HEAD: EIO'))
  w.commits.set(FIX1, undefined)
  assert.deepEqual(await at(), notRun('the worktree is gone, or its project is no longer registered'))
  w.commits.set(FIX1, 'abc123')
  assert.deepEqual(await at(), notRun('dish couldn\'t read the worktree\'s HEAD: dish-workspaces gave "abc123", not a commit id'))
  w.commits.delete(FIX1)
  w.services.shell = false
  assert.deepEqual(await at(), notRun('dsh\'s shell service isn\'t running, so dish won\'t run the gate', HEAD))
  assert.deepEqual(w.runs, [])
  assert.equal(w.infos.length, 0)
  assert.equal(w.warns.length, 10, 'each is logged at warn')
  assert.ok(!w.warns.some(line => line.includes(TOKEN)))
})

test('runAt: a run that couldn\'t start is an error with its reason and duration; a throw of dish\'s own is "dish-gates failed"', async () => {
  const w = await world()
  w.script.push(() => ({ kind: 'error', reason: 'the sandbox couldn\'t run the gate: no sandbox runner works here (SANDBOX_UNAVAILABLE)', durationMs: 12 }))
  assert.deepEqual(await w.runAt('acme/widget', FIX1, { sessionId: SESSION }), {
    ...notRun('the sandbox couldn\'t run the gate: no sandbox runner works here (SANDBOX_UNAVAILABLE)', HEAD), durationMs: 12,
  })
  w.script.push(() => { throw new Error(`boom ${TOKEN}\nsecond line`) })
  assert.deepEqual(await w.runAt('acme/widget', FIX1, { sessionId: SESSION }), notRun(`dish-gates failed: boom ${maskSecrets(TOKEN)} second line`, HEAD))
  // A slug the log path refuses (resolve would never give one): an error, never a throw.
  const odd = await w.runAt('acme/widget', `${CLONE}/.worktrees/fix 1`, { sessionId: SESSION })
  assert.equal(odd.outcome, 'error')
  assert.match(odd.reason!, /^dish-gates failed: a gate log's slug must be one path segment/)
})

test('runAt: a gateEnv with <clone> and <worktree> reaches the run expanded, with mise\'s shims after dsh\'s PATH', async () => {
  const w = await world()
  w.project = { ...PROJECT, gateEnv: { GOCACHE: '<clone>/.worktrees/.cache/go-build', WHERE: '<worktree>' } }
  const shims = join(w.directory, 'home', '.local', 'share', 'mise', 'shims')
  await mkdir(shims, { recursive: true })
  await w.runAt('acme/widget', FIX1, { sessionId: SESSION })
  assert.deepEqual(w.runs[0]!.env, { GOCACHE: `${CLONE}/.worktrees/.cache/go-build`, WHERE: FIX1, PATH: `/usr/bin:/bin:${shims}` })
})

test('runAt and the listener share the lock: runAt waits for a coder\'s gate on the same worktree, and a coder\'s stop waits for runAt; another worktree doesn\'t wait', async () => {
  const w = await world()
  const records = new CrewRecords(join(w.directory, 'crew'))
  await records.addChild(SESSION, { id: 'c1', role: 'coder', title: 'task', model: 'claude-fake', family: 'anthropic', worktree: FIX1 })
  const events: string[] = []
  const holding = (name: string, gate: { promise: Promise<void> }): Outcome => async (run) => {
    events.push(`start ${name}`)
    await gate.promise
    events.push(`end ${name}`)
    return pass(run)
  }
  const listener = gateListener({
    crew: () => ({ records }),
    workspaces: w.deps.workspaces,
    projects: w.deps.projects,
    shell: w.deps.shell,
    closing: () => ({ head: 'Done.', toolCalls: false }),
    settings: () => ({ maxRounds: 3, tailLines: 200 }),
    state: w.state,
    signal: w.plugin.signal,
    logger: w.deps.logger,
    now: () => NOW,
    run: w.deps.run!,
    publish: async () => {},
    locks: w.locks,
  })
  const agent = { id: 'c1', session: {}, steer() {} }

  // A coder's gate holds FIX1: runAt on FIX1 waits, runAt on FIX2 doesn't.
  const coderGate = deferred()
  const fix2Gate = deferred()
  w.script.push(holding('coder', coderGate))
  const stopping = listener({ agent, turn: 1, signal: new AbortController().signal })
  await until(() => events.includes('start coder'))
  const waiting = w.runAt('acme/widget', FIX1, { sessionId: SESSION })
  w.script.push(holding('fix-2', fix2Gate), holding('open_pr', { promise: Promise.resolve() }))
  const other = w.runAt('acme/widget', FIX2, { sessionId: SESSION })
  await until(() => events.includes('start fix-2'))
  await new Promise(settle => setTimeout(settle, 50))
  assert.deepEqual(events, ['start coder', 'start fix-2'])
  coderGate.resolve()
  fix2Gate.resolve()
  const [, checked, fix2] = await Promise.all([stopping, waiting, other])
  assert.deepEqual([checked.outcome, fix2.outcome], ['passed', 'passed'])
  assert.deepEqual([...events].sort(), ['end coder', 'end fix-2', 'end open_pr', 'start coder', 'start fix-2', 'start open_pr'])
  assert.ok(events.indexOf('end coder') < events.indexOf('start open_pr'), events.join(', '))
  assert.equal((await records.lookup('c1'))?.record.gates?.length, 1, 'the coder\'s gate was recorded')

  // runAt holds FIX1: a coder's stop waits for it.
  events.length = 0
  const checkGate = deferred()
  w.script.push(holding('open_pr', checkGate), holding('coder', { promise: Promise.resolve() }))
  const checking = w.runAt('acme/widget', FIX1, { sessionId: SESSION })
  await until(() => events.includes('start open_pr'))
  const stopped = listener({ agent, turn: 2, signal: new AbortController().signal })
  await new Promise(settle => setTimeout(settle, 50))
  assert.deepEqual(events, ['start open_pr'])
  checkGate.resolve()
  await Promise.all([checking, stopped])
  assert.deepEqual(events, ['start open_pr', 'end open_pr', 'start coder', 'end coder'])
})

test('runAt rejects with the caller\'s reason when its signal aborts while it waits or while the gate runs; the plugin stopping is an error', async () => {
  // While the gate runs.
  {
    const w = await world()
    w.script.push(async (run) => {
      await new Promise(settle => run.signal.addEventListener('abort', settle, { once: true }))
      return { kind: 'cancelled' }
    })
    const caller = new AbortController()
    const checking = w.runAt('acme/widget', FIX1, { sessionId: SESSION, signal: caller.signal })
    await until(() => w.runs.length === 1)
    const reason = new Error('open_pr was cancelled')
    caller.abort(reason)
    await assert.rejects(checking, error => error === reason)
  }
  // While it waits for the lock, with a reason that isn't an Error.
  {
    const w = await world()
    const held = deferred()
    const holder = w.locks.run(FIX1, new AbortController().signal, () => held.promise)
    const caller = new AbortController()
    const checking = w.runAt('acme/widget', FIX1, { sessionId: SESSION, signal: caller.signal })
    await new Promise(settle => setTimeout(settle, 20))
    caller.abort('just because')
    await assert.rejects(checking, (error: Error) => error instanceof Error && error.name === 'AbortError')
    assert.deepEqual(w.runs, [])
    held.resolve()
    await holder
  }
  // Aborted before the call.
  {
    const w = await world()
    const reason = new Error('gone already')
    await assert.rejects(w.runAt('acme/widget', FIX1, { sessionId: SESSION, signal: AbortSignal.abort(reason) }), error => error === reason)
    assert.deepEqual(w.runs, [])
  }
  // The plugin stops while the gate runs, or while runAt waits.
  {
    const w = await world()
    let seen: AbortSignal | undefined
    w.script.push(async (run) => {
      seen = run.signal
      await new Promise(settle => run.signal.addEventListener('abort', settle, { once: true }))
      return { kind: 'cancelled' }
    })
    const checking = w.runAt('acme/widget', FIX1, { sessionId: SESSION })
    await until(() => w.runs.length === 1)
    w.plugin.abort(new Error('dish-gates stopped'))
    assert.equal(seen?.aborted, true)
    assert.deepEqual(await checking, notRun('dish-gates stopped before the gate finished', HEAD))
  }
  {
    const w = await world()
    const held = deferred()
    const holder = w.locks.run(FIX1, new AbortController().signal, () => held.promise)
    const checking = w.runAt('acme/widget', FIX1, { sessionId: SESSION })
    await new Promise(settle => setTimeout(settle, 20))
    w.plugin.abort()
    assert.deepEqual(await checking, notRun('dish-gates stopped before the gate finished'))
    held.resolve()
    await holder
  }
})

test('runAt without a sessionId rejects with a TypeError, and nothing runs', async () => {
  const w = await world()
  for (const options of [undefined, {}, { sessionId: '' }, { sessionId: 7 }, null]) {
    await assert.rejects(w.runAt('acme/widget', FIX1, options as never), TypeError, JSON.stringify(options))
  }
  assert.deepEqual(w.runs, [])
  assert.deepEqual([...w.infos, ...w.warns], [])
})

test('runAt with dsh\'s real shell', { skip: SKIP }, async () => {
  await withRealShell({}, async (world) => {
    const state = join(world.dir, 'state')
    const gitEnv = await scratchGitEnv(world.dir)
    const head = (await runOk('git', ['rev-parse', 'HEAD'], { cwd: world.worktree, env: gitEnv })).trim()
    let project: Project = { ...PROJECT, gate: 'test -f README.md && echo fine' }
    const runAt = gateCheck({
      workspaces: () => ({
        resolve: async (ref: string) => ref === world.worktree
          ? { project: 'acme/widget', slug: 'fix-1', branch: 'dish/fix-1', path: world.worktree, clone: world.clone, base: 'main' }
          : undefined,
        resolveProblem: async () => undefined,
        headOf: async (ref: string) => (await runOk('git', ['rev-parse', 'HEAD'], { cwd: ref, env: gitEnv })).trim(),
      }),
      projects: () => ({ get: async () => project }),
      shell: () => world.shell,
      state,
      signal: new AbortController().signal,
      locks: new WorktreeLocks(),
      environment: () => ({ PATH: process.env.PATH, HOME: world.home }),
      logger: { warn() {}, info() {} },
      run: runGate,
    })
    const passed = await runAt('acme/widget', world.worktree, { sessionId: SESSION, head })
    assert.equal(passed.outcome, 'passed', passed.reason ?? passed.excerpt)
    assert.equal(passed.head, head)
    assert.equal(passed.excerpt, 'fine')
    assert.equal(passed.log, join(state, 'gates', 'acme', 'widget', 'fix-1', 'open_pr.log'))
    project = { ...PROJECT, gate: 'echo broken; exit 3' }
    const failed = await runAt('acme/widget', world.worktree, { sessionId: SESSION })
    assert.deepEqual([failed.outcome, failed.exitCode, failed.excerpt, failed.head], ['failed', 3, 'broken', head])
    assert.equal(failed.log, join(state, 'gates', 'acme', 'widget', 'fix-1', 'open_pr.2.log'))
    assert.match(await readFile(failed.log!, 'utf8'), /^# gate: echo broken; exit 3\n/)
  })
})
