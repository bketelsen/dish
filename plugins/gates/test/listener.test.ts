import assert from 'node:assert/strict'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { ShellExecRequest, ShellExecSpec, ShellExecution, ShellRunResult } from '@deepseek-ai/dsh-shell'
import { CrewRecords } from 'dish-crew'
import type { GateResult } from 'dish-crew'
import type { Project } from 'dish-projects'
import type { Worktree } from 'dish-workspaces'
import { maskSecrets } from 'dish-kit'
import { gateListener } from '../src/listener.ts'
import type { GateDeps, GateRecords, StoppingAgent } from '../src/listener.ts'
import type { GateRun, GateRunResult, ShellLike } from '../src/run.ts'
import { BLOCKED_REASON, EXCERPT_LINES, SUMMARY_MAX_CHARS, TAIL_MAX_BYTES } from '../src/text.ts'
import { tempDir } from './helpers.ts'

const SESSION = 'main-session'
const CLONE = '/w/acme/widget'
const FIX1 = `${CLONE}/.worktrees/fix-1`
const FIX2 = `${CLONE}/.worktrees/fix-2`
const TOKEN = `ghs_${'A1b2C3d4E5'.repeat(4)}`
const MASKED = maskSecrets(TOKEN)

const PROJECT: Project = {
  name: 'acme/widget', owner: 'acme', repo: 'widget', family: 'anthropic', role: 'coder',
  gate: 'pnpm lint && pnpm test', gateTimeout: '5m', gateTimeoutMs: 300_000,
  setup: undefined, setupTimeout: '15m', setupTimeoutMs: 900_000,
  gateEnv: { GOCACHE: '<clone>/.worktrees/.cache/go-build', WHERE: '<worktree>' },
}

function worktreeOf(path: string): Worktree {
  const slug = path.slice(path.lastIndexOf('/') + 1)
  return { project: 'acme/widget', slug, branch: `dish/${slug}`, path, clone: CLONE, base: 'abc123' }
}

// --- a world: crew's real record, stubs of the rest, and a fake run ------------------------------------------------

/** What the fake run gives for one gate run. */
type Outcome = (run: GateRun) => GateRunResult | Promise<GateRunResult>

const ran = (fields: Partial<Extract<GateRunResult, { kind: 'ran' }>> = {}): Outcome => run => ({
  kind: 'ran', exitCode: 0, timedOut: false, timeoutMs: 300_000, durationMs: 42_000, output: 'all good\n',
  truncated: false, denied: false, log: run.log, ...fields,
})
const pass = ran()
const fail = (output = 'not ok 1 - adds\n# fail 1\n', exitCode: number | null = 1): Outcome => ran({ exitCode, output })

interface FakeAgent extends StoppingAgent {
  steers: UserMessage[]
}

interface World {
  directory: string
  records: CrewRecords
  deps: GateDeps
  listener: ReturnType<typeof gateListener>
  /** Every run the listener asked for, in order. */
  runs: GateRun[]
  /** Every path `resolve` was asked for. */
  resolves: string[]
  /** What each child's next runs give, in order; a child with none left passes. */
  script: Map<string, Outcome[]>
  settings: { maxRounds: number, tailLines: number }
  heads: Map<StoppingAgent, string>
  warns: string[]
  infos: string[]
  /** The plugin's own signal. */
  plugin: AbortController
  /** What the stubs answer; change them to change the world. */
  services: {
    crew: boolean
    workspaces: boolean
    projects: boolean
    shell: boolean
  }
  /** `resolve`'s answer for a path: the worktree, or undefined; and `resolveProblem`'s. */
  unresolved: Map<string, string | undefined>
  project: Project | undefined
  agent(id: string, options?: { topLevel?: boolean }): FakeAgent
  /** Record a child, bound to `worktree` unless it is `null`. */
  coder(id: string, worktree?: string | null): Promise<void>
  stop(agent: StoppingAgent, turn?: number, signal?: AbortSignal): Promise<void>
  gates(id: string): Promise<GateResult[]>
}

interface WorldOptions {
  /** Wrap the record the listener sees (the test's own stays the real one). */
  records?: (real: CrewRecords) => GateRecords
  steer?: (agent: FakeAgent, message: UserMessage) => void
}

async function world(options: WorldOptions = {}): Promise<World> {
  const directory = await tempDir()
  const records = new CrewRecords(join(directory, 'crew'))
  const seen = options.records?.(records) ?? records
  const w: Omit<World, 'deps' | 'listener'> & Partial<Pick<World, 'deps' | 'listener'>> = {
    directory,
    records,
    runs: [],
    resolves: [],
    script: new Map(),
    settings: { maxRounds: 3, tailLines: 200 },
    heads: new Map(),
    warns: [],
    infos: [],
    plugin: new AbortController(),
    services: { crew: true, workspaces: true, projects: true, shell: true },
    unresolved: new Map(),
    project: PROJECT,
    agent(id, { topLevel = false } = {}) {
      const steers: UserMessage[] = []
      const agent: FakeAgent = {
        id,
        session: topLevel ? { header: { delegationDepth: 0 } } : {},
        steers,
        steer(message) {
          if (options.steer !== undefined) options.steer(agent, message)
          steers.push(message)
        },
      }
      return agent
    },
    async coder(id, worktree = FIX1) {
      await records.addChild(SESSION, {
        id, role: 'coder', title: `task of ${id}`, model: 'claude-fake', family: 'anthropic',
        ...worktree === null ? {} : { worktree },
      })
    },
    async stop(agent, turn = 1, signal = new AbortController().signal) {
      await w.listener!({ agent, turn, signal })
    },
    async gates(id) {
      return (await records.lookup(id))?.record.gates ?? []
    },
  }
  const shell: ShellLike = {
    sandboxMode: 'workspace-write',
    resolve: () => { throw new Error('the fake run never uses the shell') },
    execute: () => { throw new Error('the fake run never uses the shell') },
  }
  w.deps = {
    crew: () => w.services.crew ? { records: seen } : undefined,
    workspaces: () => w.services.workspaces
      ? {
          async resolve(ref: string) {
            w.resolves.push(ref)
            return w.unresolved.has(ref) ? undefined : worktreeOf(ref)
          },
          async resolveProblem(ref: string) {
            return w.unresolved.get(ref)
          },
        }
      : undefined,
    projects: () => w.services.projects ? { get: async (name: string) => name === 'acme/widget' ? w.project : undefined } : undefined,
    shell: () => w.services.shell ? shell : undefined,
    headOf: agent => w.heads.get(agent) ?? '',
    settings: () => ({ ...w.settings }),
    state: join(directory, 'state'),
    signal: w.plugin.signal,
    logger: {
      warn: (format, ...args) => { w.warns.push(format.replace(/%[sd]/g, () => String(args.shift()))) },
      info: (format, ...args) => { w.infos.push(format.replace(/%[sd]/g, () => String(args.shift()))) },
    },
    now: () => 1_700_000_000_000,
    run: async (run) => {
      w.runs.push(run)
      const next = w.script.get(run.sessionId ?? '')?.shift() ?? pass
      return next(run)
    },
  }
  w.listener = gateListener(w.deps)
  return w as World
}

function textOf(message: UserMessage): string {
  return message.content.map(block => block.type === 'text' ? block.text : '').join('')
}

function deferred<T = void>(): { promise: Promise<T>, resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

/** Wait until `condition` holds, for at most `ms`. */
async function until(condition: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!condition()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise(settle => setTimeout(settle, 5))
  }
}

const NOT_RUN = { command: '', exitCode: null, timedOut: false, durationMs: 0, log: null, excerpt: '' }

// --- not gated ----------------------------------------------------------------------------------------------------

test('not gated: a top-level agent, an agent crew doesn\'t know, an unbound child, an aborted signal, no crew', async () => {
  const w = await world()
  await w.coder('top')
  await w.coder('unbound', null)
  await w.coder('c1')

  const top = w.agent('top', { topLevel: true })
  await w.stop(top)
  const stranger = w.agent('stranger')
  await w.stop(stranger)
  const unbound = w.agent('unbound')
  await w.stop(unbound)
  const c1 = w.agent('c1')
  const aborted = new AbortController()
  aborted.abort()
  await w.stop(c1, 1, aborted.signal)
  w.services.crew = false
  await w.stop(c1)

  assert.deepEqual(w.runs, [])
  assert.deepEqual(w.resolves, [])
  for (const id of ['top', 'unbound', 'c1']) assert.deepEqual(await w.gates(id), [], id)
  for (const agent of [top, stranger, unbound, c1]) assert.deepEqual(agent.steers, [])
  assert.deepEqual(w.warns, [])
})

test('not gated: the plugin\'s signal already aborted', async () => {
  const w = await world()
  await w.coder('c1')
  w.plugin.abort()
  await w.stop(w.agent('c1'))
  assert.deepEqual(w.runs, [])
  assert.deepEqual(w.resolves, [])
  assert.deepEqual(await w.gates('c1'), [])
})

// --- the worktree -------------------------------------------------------------------------------------------------

test('a worktree that fails dish\'s check is recorded as an error with the reason, masked, and not steered', async () => {
  const w = await world()
  await w.coder('c1')
  w.unresolved.set(FIX1, `acme/widget's clone (${CLONE}) failed dish's safety check: http.extraHeader is set to ${TOKEN}`)
  const c1 = w.agent('c1')
  await w.stop(c1)
  const gates = await w.gates('c1')
  assert.equal(gates.length, 1)
  assert.deepEqual(gates[0], {
    turn: 1, round: 1, maxRounds: 3, outcome: 'error', ...NOT_RUN,
    reason: `acme/widget's clone (${CLONE}) failed dish's safety check: http.extraHeader is set to ${MASKED}`, at: 1_700_000_000_000,
  })
  assert.ok(!JSON.stringify(gates).includes(TOKEN))
  assert.deepEqual(c1.steers, [])
  assert.deepEqual(w.runs, [])
})

test('a worktree that is gone, with no problem given, is skipped, and the reason reads after "Gate skipped: "', async () => {
  const w = await world()
  await w.coder('c1')
  w.unresolved.set(FIX1, undefined)
  const c1 = w.agent('c1')
  await w.stop(c1)
  assert.deepEqual(await w.gates('c1'), [{
    turn: 1, round: 1, maxRounds: 3, outcome: 'skipped', ...NOT_RUN,
    reason: 'its worktree is gone, or its project is no longer registered', at: 1_700_000_000_000,
  }])
  assert.deepEqual(c1.steers, [])
  assert.deepEqual(w.runs, [])
})

test('without dish-workspaces the gate is an error', async () => {
  const w = await world()
  await w.coder('c1')
  w.services.workspaces = false
  await w.stop(w.agent('c1'))
  assert.deepEqual((await w.gates('c1')).map(g => [g.outcome, g.reason]), [['error', 'dish-workspaces isn\'t running']])
  assert.deepEqual(w.runs, [])
})

test('a project that isn\'t in projects.yaml is skipped; without dish-projects it is an error', async () => {
  const w = await world()
  await w.coder('c1')
  w.project = undefined
  await w.stop(w.agent('c1'))
  w.services.projects = false
  await w.stop(w.agent('c1'), 2)
  assert.deepEqual((await w.gates('c1')).map(g => [g.outcome, g.reason]), [
    ['skipped', 'acme/widget isn\'t in projects.yaml'],
    ['error', 'dish-projects isn\'t running'],
  ])
  assert.deepEqual(w.runs, [])
})

test('without dsh\'s shell the gate is an error, and nothing runs', async () => {
  const w = await world()
  await w.coder('c1')
  w.services.shell = false
  const c1 = w.agent('c1')
  await w.stop(c1)
  const gates = await w.gates('c1')
  assert.deepEqual(gates.map(g => [g.outcome, g.round]), [['error', 1]])
  assert.match(gates[0]!.reason!, /shell/)
  assert.deepEqual(w.runs, [])
  assert.deepEqual(c1.steers, [])
})

// --- the opt-out ----------------------------------------------------------------------------------------------------

test('an opt-out is skipped with the reason, and nothing runs; a marker that isn\'t at the start doesn\'t opt out', async () => {
  const w = await world()
  await w.coder('c1')
  const c1 = w.agent('c1')
  const heads = ['BLOCKED: which file?', '**NEEDS CONTEXT:** the API\'s name', 'needs_context: q', '# Blocked: no access']
  for (const [index, head] of heads.entries()) {
    w.heads.set(c1, head)
    await w.stop(c1, index + 1)
  }
  assert.deepEqual(w.runs, [])
  const gates = await w.gates('c1')
  assert.deepEqual(gates.map(g => [g.turn, g.round, g.outcome, g.reason, g.command]), heads.map((_, index) => [index + 1, 1, 'skipped', BLOCKED_REASON, '']))
  assert.deepEqual(c1.steers, [])

  w.heads.set(c1, 'Done. BLOCKED: no')
  await w.stop(c1, 9)
  assert.equal(w.runs.length, 1)
  assert.equal((await w.gates('c1')).at(-1)!.outcome, 'passed')
})

// --- a pass and a failure -------------------------------------------------------------------------------------------

test('a pass is recorded with the project\'s gate as it is, round 1, and isn\'t steered; the run gets the contract\'s request', async () => {
  const w = await world()
  await w.coder('c1')
  const c1 = w.agent('c1')
  const turnSignal = new AbortController()
  await w.stop(c1, 4, turnSignal.signal)

  assert.equal(w.runs.length, 1)
  const run = w.runs[0]!
  assert.equal(run.command, 'pnpm lint && pnpm test')
  assert.deepEqual(run.worktree, { path: FIX1, clone: CLONE })
  assert.equal(run.timeoutMs, 300_000)
  assert.deepEqual(run.env, { GOCACHE: `${CLONE}/.worktrees/.cache/go-build`, WHERE: FIX1 })
  assert.equal(run.log, join(w.directory, 'state', 'gates', 'acme', 'widget', 'fix-1', 'c1-4-1.log'))
  assert.equal(run.sessionId, 'c1')
  assert.equal(run.shell, w.deps.shell())
  assert.equal(run.signal.aborted, false)

  assert.deepEqual(await w.gates('c1'), [{
    turn: 4, round: 1, maxRounds: 3, outcome: 'passed', command: 'pnpm lint && pnpm test', exitCode: 0, timedOut: false,
    durationMs: 42_000, log: run.log, excerpt: 'all good', at: 1_700_000_000_000,
  }])
  assert.deepEqual(c1.steers, [])
  assert.deepEqual(w.infos, [`child c1, round 1, ${FIX1}: passed in 42 s`])
})

test('the run\'s signal is the turn\'s joined with the plugin\'s', async () => {
  for (const which of ['turn', 'plugin'] as const) {
    const w = await world()
    await w.coder('c1')
    const turn = new AbortController()
    let seen: AbortSignal | undefined
    w.script.set('c1', [(run) => { seen = run.signal; return pass(run) }])
    await w.stop(w.agent('c1'), 1, turn.signal)
    assert.equal(seen?.aborted, false)
    if (which === 'turn') turn.abort()
    else w.plugin.abort()
    assert.equal(seen?.aborted, true, which)
  }
})

test('a failure is recorded and steered once, with the tail within its limits, the log, and a bounded summary', async () => {
  const w = await world()
  await w.coder('c1')
  const c1 = w.agent('c1')
  const output = `${Array.from({ length: 500 }, (_, index) => `line ${index + 1}`).join('\n')}\n`
  w.script.set('c1', [fail(output, 2)])
  await w.stop(c1)

  const [result] = await w.gates('c1')
  assert.equal(result!.outcome, 'failed')
  assert.equal(result!.round, 1)
  assert.equal(result!.exitCode, 2)
  assert.equal(result!.command, 'pnpm lint && pnpm test')
  assert.equal(result!.excerpt.split('\n').length, EXCERPT_LINES)
  assert.ok(result!.excerpt.endsWith('line 500'))

  assert.equal(c1.steers.length, 1)
  const message = c1.steers[0]!
  assert.equal(message.role, 'user')
  const source = message.source as { kind: string, form?: string, summary?: string }
  assert.equal(source.kind, 'dish-gates')
  assert.equal(source.form, 'notice')
  assert.equal(source.summary, 'Gate failed (round 1 of 3): exit 2')
  assert.ok(source.summary!.length <= SUMMARY_MAX_CHARS)
  const text = textOf(message)
  assert.match(text, /^The gate failed \(round 1 of 3\): `pnpm lint && pnpm test` exited 2 after 42 s\./)
  assert.ok(text.includes('line 500\n'))
  assert.ok(text.includes('\nline 301\n'))
  assert.ok(!text.includes('line 300\n'))
  assert.ok(Buffer.byteLength(text) < TAIL_MAX_BYTES + 2000)
  assert.ok(text.includes(`Full log: \`${result!.log}\`.`))
  assert.match(text, /BLOCKED: <question>/)
  assert.deepEqual(w.infos, [`child c1, round 1, ${FIX1}: failed in 42 s (exit 2)`])
})

test('the message keeps the settings\' tailLines', async () => {
  const w = await world()
  await w.coder('c1')
  w.settings.tailLines = 50
  const c1 = w.agent('c1')
  w.script.set('c1', [fail(`${Array.from({ length: 500 }, (_, index) => `line ${index + 1}`).join('\n')}\n`)])
  await w.stop(c1)
  const text = textOf(c1.steers[0]!)
  assert.ok(text.includes('\nline 451\n'))
  assert.ok(!text.includes('line 450\n'))
})

test('settings that aren\'t whole numbers from 1 fall back: 3 rounds and a 200-line tail', async () => {
  for (const settings of [{ maxRounds: 2.5, tailLines: Number.NaN }, { maxRounds: 0, tailLines: 0 }]) {
    const w = await world()
    await w.coder('c1')
    w.settings.maxRounds = settings.maxRounds
    w.settings.tailLines = settings.tailLines
    const c1 = w.agent('c1')
    const output = `${Array.from({ length: 500 }, (_, index) => `line ${index + 1}`).join('\n')}\n`
    w.script.set('c1', [fail(output), fail(output), fail(output), fail(output)])
    for (let stop = 0; stop < 4; stop++) await w.stop(c1, 7)
    assert.equal(w.runs.length, 3, `runs with ${JSON.stringify(settings)}`)
    assert.equal(c1.steers.length, 2, `steers with ${JSON.stringify(settings)}`)
    const text = textOf(c1.steers[0]!)
    assert.ok(text.includes('\nline 301\n'), 'a 200-line tail')
    assert.ok(!text.includes('line 300\n'))
  }
})

test('a timeout and a run with no exit code are failures', async () => {
  const w = await world()
  await w.coder('c1')
  const c1 = w.agent('c1')
  w.script.set('c1', [ran({ exitCode: null, timedOut: true, timeoutMs: 600_000, durationMs: 600_000 }), ran({ exitCode: null })])
  await w.stop(c1)
  await w.stop(c1)
  const gates = await w.gates('c1')
  assert.deepEqual(gates.map(g => [g.outcome, g.round, g.timedOut, g.exitCode]), [['failed', 1, true, null], ['failed', 2, false, null]])
  assert.match(textOf(c1.steers[0]!), /was stopped at its time limit \(10 min\)/)
  assert.match(textOf(c1.steers[1]!), /was killed after/)
  assert.deepEqual(w.infos, [
    `child c1, round 1, ${FIX1}: failed in 10 min (timed out at 10 min)`,
    `child c1, round 2, ${FIX1}: failed in 42 s (killed)`,
  ])
})

test('a run that couldn\'t start is recorded as an error with its reason and duration, and not steered', async () => {
  const w = await world()
  await w.coder('c1')
  const c1 = w.agent('c1')
  w.script.set('c1', [() => ({ kind: 'error', reason: 'the sandbox couldn\'t run the gate: no sandbox runner works here (SANDBOX_UNAVAILABLE)', durationMs: 12 })])
  await w.stop(c1)
  assert.deepEqual(await w.gates('c1'), [{
    turn: 1, round: 1, maxRounds: 3, outcome: 'error', ...NOT_RUN, durationMs: 12,
    reason: 'the sandbox couldn\'t run the gate: no sandbox runner works here (SANDBOX_UNAVAILABLE)', at: 1_700_000_000_000,
  }])
  assert.deepEqual(c1.steers, [])
})

test('a log that couldn\'t be written: the failure stands, and the message says why there is no log', async () => {
  const w = await world()
  await w.coder('c1')
  const c1 = w.agent('c1')
  w.script.set('c1', [ran({ exitCode: 1, log: null, logProblem: 'EACCES: permission denied' })])
  await w.stop(c1)
  const [result] = await w.gates('c1')
  assert.equal(result!.outcome, 'failed')
  assert.equal(result!.log, null)
  assert.match(textOf(c1.steers[0]!), /\(No log: EACCES: permission denied\.\)/)
})

// --- rounds ---------------------------------------------------------------------------------------------------------

test('rounds: two failures are steered, the third is recorded and not steered, and a fourth stop runs nothing', async () => {
  const w = await world()
  await w.coder('c1')
  const c1 = w.agent('c1')
  w.script.set('c1', [fail(), fail(), fail(), fail()])
  for (let stop = 0; stop < 4; stop++) await w.stop(c1, 7)

  assert.equal(w.runs.length, 3)
  assert.deepEqual(w.runs.map(run => run.log.slice(run.log.lastIndexOf('/') + 1)), ['c1-7-1.log', 'c1-7-2.log', 'c1-7-3.log'])
  const gates = await w.gates('c1')
  assert.deepEqual(gates.map(g => [g.turn, g.round, g.maxRounds, g.outcome]), [[7, 1, 3, 'failed'], [7, 2, 3, 'failed'], [7, 3, 3, 'failed']])
  assert.equal(c1.steers.length, 2)
  assert.doesNotMatch(textOf(c1.steers[0]!), /fails once more/)
  assert.match(textOf(c1.steers[1]!), /round 2 of 3[\s\S]*If it fails once more, your turn ends with the failure/)
})

test('rounds: maxRounds from the settings, read on each stop; 2 makes round 2 the last, and 1 steers nothing', async () => {
  const w = await world()
  await w.coder('c1')
  const c1 = w.agent('c1')
  w.settings.maxRounds = 2
  w.script.set('c1', [fail(), fail(), fail()])
  for (let stop = 0; stop < 3; stop++) await w.stop(c1)
  assert.equal(w.runs.length, 2)
  assert.equal(c1.steers.length, 1)
  assert.deepEqual((await w.gates('c1')).map(g => [g.round, g.maxRounds]), [[1, 2], [2, 2]])

  await w.coder('c2')
  const c2 = w.agent('c2')
  w.settings.maxRounds = 1
  w.script.set('c2', [fail(), fail()])
  await w.stop(c2)
  await w.stop(c2)
  assert.deepEqual(c2.steers, [])
  assert.deepEqual((await w.gates('c2')).map(g => [g.round, g.maxRounds, g.outcome]), [[1, 1, 'failed']])
})

test('rounds: a pass after a failure ends the turn at round 2, and errors and skips don\'t use a round', async () => {
  const w = await world()
  await w.coder('c1')
  const c1 = w.agent('c1')
  w.script.set('c1', [fail(), () => ({ kind: 'error', reason: 'the sandbox couldn\'t run the gate: x', durationMs: 1 }), pass])
  await w.stop(c1)
  await w.stop(c1)
  w.heads.set(c1, 'BLOCKED: hm')
  await w.stop(c1)
  w.heads.set(c1, 'fixed')
  await w.stop(c1)
  assert.deepEqual((await w.gates('c1')).map(g => [g.round, g.outcome]), [[1, 'failed'], [2, 'error'], [2, 'skipped'], [2, 'passed']])
  assert.equal(c1.steers.length, 1)
})

test('a follow-up\'s new turn starts at round 1, with the old turn\'s failures still on the child', async () => {
  const w = await world()
  await w.coder('c1')
  const c1 = w.agent('c1')
  w.script.set('c1', [fail(), fail(), fail(), fail()])
  for (let stop = 0; stop < 3; stop++) await w.stop(c1, 1)
  await w.stop(c1, 2)
  const gates = await w.gates('c1')
  assert.deepEqual(gates.map(g => [g.turn, g.round]), [[1, 1], [1, 2], [1, 3], [2, 1]])
  assert.equal(c1.steers.length, 3)
  assert.match(textOf(c1.steers[2]!), /round 1 of 3/)
  assert.equal(w.runs.at(-1)!.log.endsWith('c1-2-1.log'), true)
})

test('a run that ends between two gates: the first result goes with that run, and the next run\'s turn starts at round 1', async () => {
  const w = await world()
  await w.coder('c1')
  const c1 = w.agent('c1')
  w.script.set('c1', [fail(), pass])
  await w.stop(c1, 1)
  // The turn was cancelled after the steer, say: crew files the run.
  await w.records.endRun('c1', { stopReason: 'aborted', closing: '' })
  await w.stop(c1, 2)
  const { record } = (await w.records.lookup('c1'))!
  assert.deepEqual(record.runs[0]!.gates!.map(g => [g.turn, g.round, g.outcome]), [[1, 1, 'failed']])
  assert.deepEqual(record.gates!.map(g => [g.turn, g.round, g.outcome]), [[2, 1, 'passed']])
})

// --- one gate per worktree, and the right child ---------------------------------------------------------------------

test('one gate per worktree: a second stop for it waits for the first; another worktree doesn\'t wait', async () => {
  const w = await world()
  await w.coder('c1', FIX1)
  await w.coder('c2', FIX1)
  await w.coder('c3', FIX2)
  const events: string[] = []
  const held = new Map<string, ReturnType<typeof deferred<void>>>()
  const holding = (id: string): Outcome => async (run) => {
    events.push(`start ${id}`)
    const gate = deferred()
    held.set(id, gate)
    await gate.promise
    events.push(`end ${id}`)
    return pass(run)
  }
  for (const id of ['c1', 'c2', 'c3']) w.script.set(id, [holding(id)])

  const first = w.stop(w.agent('c1'))
  await until(() => held.has('c1'))
  const second = w.stop(w.agent('c2'))
  const third = w.stop(w.agent('c3'))
  await until(() => held.has('c3'))
  // c2 has had time to read its record and reach the lock.
  await new Promise(settle => setTimeout(settle, 100))
  assert.equal(held.has('c2'), false)
  assert.deepEqual(w.resolves, [FIX1, FIX2])

  held.get('c1')!.resolve()
  await first
  await until(() => held.has('c2'))
  held.get('c2')!.resolve()
  held.get('c3')!.resolve()
  await Promise.all([second, third])
  assert.deepEqual(events.filter(event => !event.endsWith('c3')), ['start c1', 'end c1', 'start c2', 'end c2'])
  for (const id of ['c1', 'c2', 'c3']) assert.deepEqual((await w.gates(id)).map(g => g.outcome), ['passed'], id)
})

test('one gate per worktree: a stop whose turn is cancelled while it waits returns at once, and the lock still works', async () => {
  const w = await world()
  await w.coder('c1', FIX1)
  await w.coder('c2', FIX1)
  await w.coder('c3', FIX1)
  const gate = deferred()
  w.script.set('c1', [async (run) => { await gate.promise; return pass(run) }])
  const first = w.stop(w.agent('c1'))
  await until(() => w.runs.length === 1)
  const cancelled = new AbortController()
  const second = w.stop(w.agent('c2'), 1, cancelled.signal)
  const third = w.stop(w.agent('c3'))
  await new Promise(settle => setTimeout(settle, 50))
  cancelled.abort()
  await second
  assert.equal(w.runs.length, 1)
  gate.resolve()
  await Promise.all([first, third])
  assert.deepEqual(w.runs.map(run => run.sessionId), ['c1', 'c3'])
  assert.deepEqual(await w.gates('c2'), [])
  assert.deepEqual((await w.gates('c3')).map(g => g.outcome), ['passed'])
})

test('one gate per worktree: crew gone while a stop waited means nothing runs for it', async () => {
  const w = await world()
  await w.coder('c1', FIX1)
  await w.coder('c2', FIX1)
  const gate = deferred()
  w.script.set('c1', [async (run) => { await gate.promise; return pass(run) }])
  const first = w.stop(w.agent('c1'))
  await until(() => w.runs.length === 1)
  const second = w.stop(w.agent('c2'))
  await new Promise(settle => setTimeout(settle, 50))
  w.services.crew = false
  gate.resolve()
  await Promise.all([first, second])
  assert.deepEqual(w.runs.map(run => run.sessionId), ['c1'])
  assert.deepEqual(await w.gates('c2'), [])
})

test('the right child: two coders on two worktrees gated at once each get their own result and steer', async () => {
  const w = await world()
  await w.coder('c1', FIX1)
  await w.coder('c3', FIX2)
  const c1 = w.agent('c1')
  const c3 = w.agent('c3')
  const gate1 = deferred()
  const gate3 = deferred()
  w.script.set('c1', [async (run) => { await gate1.promise; return fail('c1 broke\n')(run) }])
  w.script.set('c3', [async (run) => { await gate3.promise; return pass(run) }])
  const stops = [w.stop(c1, 3), w.stop(c3, 5)]
  await until(() => w.runs.length === 2)
  gate3.resolve()
  gate1.resolve()
  await Promise.all(stops)
  assert.deepEqual((await w.gates('c1')).map(g => [g.turn, g.outcome, g.excerpt]), [[3, 'failed', 'c1 broke']])
  assert.deepEqual((await w.gates('c3')).map(g => [g.turn, g.outcome]), [[5, 'passed']])
  assert.equal(c1.steers.length, 1)
  assert.match(textOf(c1.steers[0]!), /c1 broke/)
  assert.deepEqual(c3.steers, [])
  assert.ok(w.runs.find(run => run.sessionId === 'c1')!.log.endsWith('/fix-1/c1-3-1.log'))
  assert.ok(w.runs.find(run => run.sessionId === 'c3')!.log.endsWith('/fix-2/c3-5-1.log'))
})

// --- cancelled ------------------------------------------------------------------------------------------------------

test('cancelled by the turn\'s signal or the plugin\'s: nothing recorded, no steer, and the listener settles', async () => {
  for (const which of ['turn', 'plugin'] as const) {
    const w = await world()
    await w.coder('c1')
    const c1 = w.agent('c1')
    const turn = new AbortController()
    w.script.set('c1', [async (run) => {
      await new Promise(settle => run.signal.addEventListener('abort', settle, { once: true }))
      return { kind: 'cancelled' }
    }])
    const stopping = w.stop(c1, 1, turn.signal)
    await until(() => w.runs.length === 1)
    if (which === 'turn') turn.abort()
    else w.plugin.abort()
    await stopping
    assert.deepEqual(await w.gates('c1'), [], which)
    assert.deepEqual(c1.steers, [], which)
  }
})

test('a turn cancelled while the gate ran: a result that came back anyway is neither recorded nor steered', async () => {
  const w = await world()
  await w.coder('c1')
  const c1 = w.agent('c1')
  const turn = new AbortController()
  w.script.set('c1', [(run) => { turn.abort(); return fail()(run) }])
  await w.stop(c1, 1, turn.signal)
  assert.deepEqual(await w.gates('c1'), [])
  assert.deepEqual(c1.steers, [])
})

// --- errors ---------------------------------------------------------------------------------------------------------

test('errors: lookup throws; nothing can be recorded, it is logged once, and the listener resolves', async () => {
  const w = await world({
    records: real => ({
      lookup: async () => { throw new Error(`children.json: EIO ${TOKEN}`) },
      addGate: (id, result) => real.addGate(id, result),
    }),
  })
  await w.coder('c1')
  const c1 = w.agent('c1')
  await w.stop(c1)
  await w.stop(c1)
  assert.deepEqual(w.warns, [`dish-gates failed: children.json: EIO ${MASKED}`])
  assert.deepEqual(await w.gates('c1'), [])
  assert.deepEqual(w.runs, [])
})

test('errors: lookup throws once the stop has the lock; it is recorded as an error', async () => {
  let calls = 0
  const w = await world({
    records: real => ({
      lookup: async (id) => {
        calls++
        if (calls === 2) throw new Error('children.json: EIO')
        return real.lookup(id)
      },
      addGate: (id, result) => real.addGate(id, result),
    }),
  })
  await w.coder('c1')
  await w.stop(w.agent('c1'))
  assert.deepEqual(await w.gates('c1'), [{
    turn: 1, round: 1, maxRounds: 3, outcome: 'error', ...NOT_RUN, reason: 'dish-gates failed: children.json: EIO', at: 1_700_000_000_000,
  }])
  assert.deepEqual(w.warns, ['dish-gates failed: children.json: EIO'])
  assert.deepEqual(w.runs, [])
})

test('errors: addGate throws; nothing is steered, each message is logged once, and the listener resolves', async () => {
  const w = await world({
    records: real => ({
      lookup: id => real.lookup(id),
      addGate: async () => { throw new Error('ENOSPC: no space left on device') },
    }),
  })
  await w.coder('c1')
  const c1 = w.agent('c1')
  w.script.set('c1', [fail(), fail(), fail()])
  for (let stop = 0; stop < 3; stop++) await w.stop(c1)
  assert.deepEqual(c1.steers, [])
  assert.deepEqual(w.warns, ['dish-gates failed: ENOSPC: no space left on device'])
  assert.deepEqual(await w.gates('c1'), [])
})

test('errors: addGate throws for the failure; an error is recorded in its place, and nothing is steered', async () => {
  let calls = 0
  const w = await world({
    records: real => ({
      lookup: id => real.lookup(id),
      addGate: async (id, result) => {
        calls++
        if (calls === 1) throw new Error('EIO')
        return real.addGate(id, result)
      },
    }),
  })
  await w.coder('c1')
  const c1 = w.agent('c1')
  w.script.set('c1', [fail()])
  await w.stop(c1)
  assert.deepEqual(c1.steers, [])
  assert.deepEqual((await w.gates('c1')).map(g => [g.round, g.outcome, g.reason]), [[1, 'error', 'dish-gates failed: EIO']])
})

test('errors: a child crew no longer has when its result is recorded is not steered', async () => {
  const w = await world({
    records: real => ({ lookup: id => real.lookup(id), addGate: async () => false }),
  })
  await w.coder('c1')
  const c1 = w.agent('c1')
  w.script.set('c1', [fail()])
  await w.stop(c1)
  assert.deepEqual(c1.steers, [])
})

test('errors: resolve throws; it is recorded as an error and logged once', async () => {
  const w = await world()
  await w.coder('c1')
  const c1 = w.agent('c1')
  const workspaces = w.deps.workspaces
  w.deps.workspaces = () => ({ ...workspaces()!, resolve: async () => { throw new Error('EACCES: permission denied') } })
  await w.stop(c1, 1)
  await w.stop(c1, 2)
  assert.deepEqual((await w.gates('c1')).map(g => [g.turn, g.outcome, g.reason]), [
    [1, 'error', 'dish-gates failed: EACCES: permission denied'],
    [2, 'error', 'dish-gates failed: EACCES: permission denied'],
  ])
  assert.deepEqual(w.warns, ['dish-gates failed: EACCES: permission denied'])
  assert.deepEqual(w.runs, [])
})

test('errors: steer throws; the failure stays recorded, an error follows it, and it is logged once', async () => {
  const w = await world({ steer: () => { throw new Error('agent disposed') } })
  await w.coder('c1')
  const c1 = w.agent('c1')
  w.script.set('c1', [fail()])
  await w.stop(c1)
  assert.deepEqual((await w.gates('c1')).map(g => [g.round, g.outcome, g.reason]), [
    [1, 'failed', undefined],
    [2, 'error', 'dish-gates failed: agent disposed'],
  ])
  assert.deepEqual(w.warns, ['dish-gates failed: agent disposed'])
})

test('errors: a run that throws (it shouldn\'t) and a headOf that throws are recorded as errors, never thrown', async () => {
  const w = await world()
  await w.coder('c1')
  const c1 = w.agent('c1')
  w.script.set('c1', [() => { throw new Error('boom') }])
  await w.stop(c1, 1)
  w.deps.headOf = () => { throw new Error('bad head') }
  await w.stop(c1, 2)
  assert.deepEqual((await w.gates('c1')).map(g => [g.turn, g.outcome, g.reason]), [
    [1, 'error', 'dish-gates failed: boom'],
    [2, 'error', 'dish-gates failed: bad head'],
  ])
  assert.deepEqual(c1.steers, [])
})

test('errors: a malformed payload and a logger that throws never make the listener throw', async () => {
  const w = await world()
  await w.coder('c1')
  w.deps.logger = { warn: () => { throw new Error('no logger') }, info: () => { throw new Error('no logger') } }
  const listener = gateListener(w.deps)
  await listener(undefined as never)
  await listener({ agent: null, turn: 1, signal: new AbortController().signal } as never)
  await listener({ agent: w.agent('c1'), turn: 1, signal: new AbortController().signal })
  assert.deepEqual((await w.gates('c1')).map(g => g.outcome), ['passed'])
})

// --- with the real runner over a fake shell -------------------------------------------------------------------------

test('with the real runner: the log is written under the state directory, and its path is recorded', async () => {
  const w = await world()
  await w.coder('c1')
  const requests: ShellExecRequest[] = []
  const shell: ShellLike = {
    sandboxMode: 'workspace-write',
    resolve(request: ShellExecRequest): ShellExecSpec {
      requests.push(request)
      return { ...request, workdir: request.workdir!, timeoutMs: request.timeoutMs!, onExpiry: 'kill', stdoutMaxBytes: request.stdoutMaxBytes! } as ShellExecSpec
    },
    async execute(spec: ShellExecSpec): Promise<ShellExecution> {
      const result = async (): Promise<ShellRunResult> => ({
        exitCode: 3, signal: null, timedOut: false, aborted: false, timeoutMs: spec.timeoutMs,
        stdout: { text: `FAIL token ${TOKEN}\n`, truncated: false }, stderr: { text: '', truncated: false },
        sandbox: { mode: 'workspace-write', denied: false, enforcement: 'full' },
      })
      return { result } as unknown as ShellExecution
    },
  }
  w.deps.shell = () => shell
  delete w.deps.run
  const c1 = w.agent('c1')
  await gateListener(w.deps)({ agent: c1, turn: 2, signal: new AbortController().signal })

  assert.equal(requests.length, 1)
  assert.equal(requests[0]!.command, 'exec 2>&1\npnpm lint && pnpm test')
  assert.equal(requests[0]!.workdir, FIX1)
  assert.deepEqual(requests[0]!.sandboxPolicy, { mode: 'workspace-write', workspaceRoot: CLONE, sessionId: 'c1' })
  const [result] = await w.gates('c1')
  assert.equal(result!.outcome, 'failed')
  assert.equal(result!.command, 'pnpm lint && pnpm test')
  assert.equal(result!.log, join(w.directory, 'state', 'gates', 'acme', 'widget', 'fix-1', 'c1-2-1.log'))
  assert.equal((await stat(result!.log!)).mode & 0o777, 0o600)
  assert.equal(result!.excerpt, `FAIL token ${MASKED}`)
  assert.ok(!textOf(c1.steers[0]!).includes(TOKEN))
})
