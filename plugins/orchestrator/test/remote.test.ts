/**
 * The server half of Settings → Runs: `RunsRemote`, as the plugin mounts it over temp directories, with the stub services of
 * Task 8's world (`pluginWorld`). What matters most: what it gives is the store's and the ledger's, plain JSON, masked once
 * more on the way out; what it refuses is a result, not a throw; and it writes nothing, ever.
 */

import assert from 'node:assert/strict'
import { access, appendFile, lstat, mkdir, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { summarize } from '../src/derive.ts'
import type { LedgerEntry } from '../src/entries.ts'
import type { Config } from '../src/index.ts'
import type { ErrorCode, LedgerLine, Outcome, RunRow } from '../src/protocol.ts'
import { RunsRemote, SERVICE } from '../src/remote.ts'
import type { Run } from '../src/store.ts'
import { HOUR, MINUTE, everyKind } from './helpers.ts'
import { MASKED_TOKEN, NOW, OTHER_PROJECT, OTHER_SESSION, PROJECT, SESSION, SHA_A, TOKEN, pluginWorld, waitFor } from './service-helpers.ts'
import type { Handle, PluginWorld } from './service-helpers.ts'

/** Run `body` with the plugin mounted, and its remote. */
async function withRemote(body: (w: PluginWorld, remote: RunsRemote) => Promise<void>): Promise<void> {
  const w = await pluginWorld()
  try {
    await waitFor('the remote', () => w.ctx.get('dishRunsRemote') !== undefined)
    await body(w, w.ctx.get('dishRunsRemote') as RunsRemote)
  } finally {
    await w.dispose()
  }
}

/** The value of a call that succeeded. */
function ok<T>(outcome: Outcome<T>): T {
  assert.ok(outcome.ok, JSON.stringify(outcome))
  return outcome.value
}

/** Assert that a call failed with `code`, as a result and not a throw; the message is returned. */
function failed(outcome: Outcome<unknown>, code: ErrorCode): string {
  assert.ok(!outcome.ok, `expected ${code}, got ${JSON.stringify(outcome).slice(0, 300)}`)
  assert.equal(outcome.code, code, outcome.message)
  assert.equal(typeof outcome.message, 'string')
  return outcome.message
}

/** What the wire sees of `value`: JSON, with nothing `undefined` in it. */
function plain(value: unknown): void {
  assert.deepStrictEqual(value, JSON.parse(JSON.stringify(value)))
}

/** Close `run` as the `run` tool and `open_pr` do: under its lock. */
async function close(w: PluginWorld, run: Run, end: { state: 'abandoned', reason: string } | { state: 'pr', pr: { url: string, number: number } }): Promise<Run> {
  return w.runs.withRun(run, () => w.runs.close(run, SESSION, end))
}

/** `count` notes by the main agent, one minute apart from `from`. */
function notes(run: Run, count: number, from = NOW + MINUTE): LedgerEntry[] {
  return Array.from({ length: count }, (_, index) => ({ at: from + index * MINUTE, run: run.id, kind: 'note', by: 'main', session: SESSION, text: `note ${index}` }))
}

// --- the wire contract -------------------------------------------------------------------------------

test('RunsRemote is bound as dishRunsRemote under the dishRuns namespace, and marks exactly runs, run and ledger', async () => {
  await withRemote(async (w, remote) => {
    assert.equal(SERVICE, 'dishRunsRemote')
    assert.ok(remote instanceof RunsRemote)
    assert.equal(remote.typertRemote.serviceKey, 'dishRunsRemote')
    assert.equal(remote.typertRemote.namespace, 'dishRuns')
    assert.ok(remote.typertRemote.service instanceof RunsRemote)
    const marks = remoteMethods(remote)
    assert.deepEqual(marks.map(mark => mark.method).sort(), ['ledger', 'run', 'runs'])
    for (const mark of marks) {
      assert.deepEqual(mark.invocation, { kind: 'direct' }, mark.method)
      assert.equal(mark.mode, undefined, `${mark.method} is not a stream`)
    }
    // The class itself, as the client's test reads it.
    assert.deepEqual(remoteMethods(Object.create(RunsRemote.prototype) as RunsRemote).map(mark => mark.method).sort(), ['ledger', 'run', 'runs'])
    assert.ok(w.ctx.get('dishRuns') !== undefined)
  })
})

test('the remote goes with the plugin', async () => {
  const w = await pluginWorld()
  try {
    await waitFor('the remote', () => w.ctx.get('dishRunsRemote') !== undefined)
    await w.handles.plugin!.dispose()
    assert.equal(w.ctx.get('dishRunsRemote'), undefined)
  } finally {
    await w.dispose()
  }
})

// --- runs ---------------------------------------------------------------------------------------------

test('runs: by project without case, then open ones first, then newest opened first; and the driver live, not live, or released', async () => {
  await withRemote(async (w, remote) => {
    assert.deepEqual(await remote.runs(), [])
    w.live.add(SESSION)
    const alpha = await w.open({ slug: 'alpha', goal: 'First of all' })
    w.clock.now = NOW + HOUR
    const beta = await w.open({ slug: 'beta', session: OTHER_SESSION, goal: 'Second' })
    w.clock.now = NOW + 2 * HOUR
    // SESSION opens another: alpha is released, open and driven by nobody.
    const gamma = await w.open({ slug: 'gamma', goal: 'Third' })
    w.clock.now = NOW + 3 * HOUR
    const delta = await w.open({ slug: 'delta', session: 'session-3', goal: 'Given up' })
    await close(w, delta, { state: 'abandoned', reason: 'not needed after all' })
    w.clock.now = NOW + 30 * MINUTE
    const gadget = await w.open({ slug: 'epsilon', project: OTHER_PROJECT, session: 'session-4', goal: 'In the gadget' })
    w.clock.now = NOW + 4 * HOUR
    await close(w, gadget, { state: 'pr', pr: { url: `https://github.com/${OTHER_PROJECT}/pull/9`, number: 9 } })
    // Case matters to the order only as letters do: 'beta' comes before 'Zed' here, as 'acme' before 'beta'.
    w.clock.now = NOW + 5 * HOUR
    const zed = await w.open({ slug: 'zeta', project: 'Zed/app', session: 'session-5', goal: 'Zed' })
    const lower = await w.open({ slug: 'eta', project: 'beta/tools', session: 'session-6', goal: 'lower case' })

    const rows = await remote.runs()
    plain(rows)
    assert.deepEqual(rows.map(row => `${row.project}/${row.id}`), [
      `${OTHER_PROJECT}/${gadget.id}`,
      `${PROJECT}/${gamma.id}`,
      `${PROJECT}/${beta.id}`,
      `${PROJECT}/${alpha.id}`,
      `${PROJECT}/${delta.id}`,
      `beta/tools/${lower.id}`,
      `Zed/app/${zed.id}`,
    ])
    const byId = new Map(rows.map(row => [row.id, row]))
    assert.deepEqual(byId.get(gamma.id)!.driver, { session: SESSION, since: NOW + 2 * HOUR, live: true })
    assert.deepEqual(byId.get(beta.id)!.driver, { session: OTHER_SESSION, since: NOW + HOUR, live: false })
    assert.equal(byId.get(alpha.id)!.driver, null)
    assert.equal(byId.get(alpha.id)!.state, 'open')
    const expectedDelta: RunRow = {
      project: PROJECT, id: delta.id, slug: 'delta', goal: 'Given up', state: 'abandoned', driver: null,
      openedAt: NOW + 3 * HOUR, closedAt: NOW + 3 * HOUR, reason: 'not needed after all',
    }
    assert.deepEqual(byId.get(delta.id), expectedDelta)
    const expectedGadget: RunRow = {
      project: OTHER_PROJECT, id: gadget.id, slug: 'epsilon', goal: 'In the gadget', state: 'pr', driver: null,
      openedAt: NOW + 30 * MINUTE, closedAt: NOW + 4 * HOUR, pr: { url: `https://github.com/${OTHER_PROJECT}/pull/9`, number: 9 },
    }
    assert.deepEqual(byId.get(gadget.id), expectedGadget)
    // A row holds what the list shows, and not the rest of the record.
    for (const row of rows) for (const key of Object.keys(row)) assert.ok(['project', 'id', 'slug', 'goal', 'state', 'driver', 'openedAt', 'closedAt', 'pr', 'reason'].includes(key), key)

    // The driver's agent goes: the same run, not live.
    w.live.delete(SESSION)
    assert.equal((await remote.runs()).find(row => row.id === gamma.id)!.driver!.live, false)
  })
})

test('a run reopened for review feedback is listed open, with its PR', async () => {
  await withRemote(async (w, remote) => {
    const run = await w.open({ slug: 'reopen' })
    await close(w, run, { state: 'pr', pr: { url: `https://github.com/${PROJECT}/pull/3`, number: 3 } })
    await w.store.update(run.project, run.id, (current) => {
      const next: Run = { ...current, state: 'open', driver: { session: SESSION, since: NOW + HOUR } }
      delete next.closedAt
      return next
    })
    const [row] = await remote.runs()
    assert.equal(row!.state, 'open')
    assert.deepEqual(row!.pr, { url: `https://github.com/${PROJECT}/pull/3`, number: 3 })
    assert.equal(row!.closedAt, undefined)
  })
})

// --- run ----------------------------------------------------------------------------------------------

test('run: the row, the rest of the record, and the summary derive makes of its ledger', async () => {
  await withRemote(async (w, remote) => {
    w.live.add(SESSION)
    const run = await w.open({ slug: 'fix-login', plan: { path: 'docs/plans/x.md', commit: SHA_A } })
    await w.ledger.append(run.project, run.id, everyKind(run.id))
    const record = w.record(run)!
    const entries = await w.entries(run)

    const detail = ok(await remote.run(PROJECT, run.id))
    plain(detail)
    assert.deepEqual(detail, {
      project: PROJECT, id: run.id, slug: 'fix-login', goal: record.goal, state: 'open',
      driver: { session: SESSION, since: record.driver.since, live: true }, openedAt: record.openedAt,
      branch: record.branch, worktree: record.worktree, base: record.base, baseCommit: record.baseCommit,
      plan: { path: 'docs/plans/x.md', commit: SHA_A },
      summary: JSON.parse(JSON.stringify(summarize(record, entries))),
    })
    // What everyKind wrote is there: a task, the final review, the rulings, the PR and its last feedback read.
    assert.equal(detail.summary.tasks.length, 2)
    assert.equal(detail.summary.finalReview?.verdict, 'approved')
    assert.equal(detail.summary.pr?.feedback?.failedChecks, 1)
    assert.ok(detail.summary.rulings.length >= 2)
  })
})

test('run and ledger find a project without case, and read the ledger of the record\'s own project', async () => {
  await withRemote(async (w, remote) => {
    const run = await w.open({ slug: 'cased' })
    await w.ledger.append(run.project, run.id, notes(run, 3))
    const detail = ok(await remote.run('acme/WIDGET', run.id))
    assert.equal(detail.project, PROJECT)
    assert.equal(detail.summary.notes.length, 3)
    const page = ok(await remote.ledger('ACME/widget', run.id, 0, ''))
    assert.deepEqual(page.lines.map(line => line.kind), ['note', 'note', 'note', 'run.opened'])
  })
})

test('INVALID for a project or an id that isn\'t one, and for a page that isn\'t one: a result, never a throw', async () => {
  await withRemote(async (w, remote) => {
    const run = await w.open({ slug: 'fix-login' })
    for (const project of ['../x', 'x/..', 'Acme', 'Acme/widget/extra', '', 'a b/c']) {
      assert.match(failed(await remote.run(project, run.id), 'INVALID'), /project/, project)
      failed(await remote.ledger(project, run.id, 0, ''), 'INVALID')
    }
    for (const id of ['20261003-x/y', '../20261003-x', 'x', '', '20261003-X', `${run.id}/..`]) {
      assert.match(failed(await remote.run(PROJECT, id), 'INVALID'), /run id/, id)
      failed(await remote.ledger(PROJECT, id, 0, ''), 'INVALID')
    }
    // A cursor that isn't one a page gave, and limits out of range.
    for (const before of ['not a cursor', '!!', 'LTE']) failed(await remote.ledger(PROJECT, run.id, 0, before), 'INVALID')
    for (const limit of [-1, 501, 1.5, Number.NaN]) failed(await remote.ledger(PROJECT, run.id, limit, ''), 'INVALID')
    // What arrives off the wire untyped.
    failed(await remote.run(42 as never, run.id), 'INVALID')
    failed(await remote.run(PROJECT, null as never), 'INVALID')
    failed(await remote.ledger(PROJECT, run.id, '10' as never, ''), 'INVALID')
    failed(await remote.ledger(PROJECT, run.id, 0, 7 as never), 'INVALID')
    // A missing positional is as good as '' or 0: the defaults.
    assert.equal(ok(await remote.ledger(PROJECT, run.id, undefined as never, undefined as never)).lines.length, 1)
  })
})

test('NOT_FOUND for a run the store doesn\'t have', async () => {
  await withRemote(async (w, remote) => {
    const run = await w.open({ slug: 'fix-login' })
    assert.equal(failed(await remote.run(PROJECT, '20261003-nothing'), 'NOT_FOUND'), `no run ${PROJECT}/20261003-nothing`)
    assert.equal(failed(await remote.ledger(PROJECT, '20261003-nothing', 0, ''), 'NOT_FOUND'), `no run ${PROJECT}/20261003-nothing`)
    // The same id in another project is another run.
    failed(await remote.run(OTHER_PROJECT, run.id), 'NOT_FOUND')
  })
})

// --- ledger -------------------------------------------------------------------------------------------

test('ledger: pages newest first with next, 200 by default, and the base fields apart from the rest', async () => {
  await withRemote(async (w, remote) => {
    const run = await w.open({ slug: 'fix-login' })
    await w.ledger.append(run.project, run.id, notes(run, 250))

    const first = ok(await remote.ledger(PROJECT, run.id, 0, ''))
    plain(first)
    assert.equal(first.lines.length, 200)
    assert.equal(first.skipped, 0)
    assert.equal(typeof first.next, 'string')
    assert.deepEqual(first.lines[0], { at: NOW + 250 * MINUTE, run: run.id, kind: 'note', by: 'main', session: SESSION, fields: { text: 'note 249' } })
    assert.equal(first.lines[199]!.fields.text, 'note 50')
    const second = ok(await remote.ledger(PROJECT, run.id, 0, first.next!))
    assert.equal(second.lines.length, 51)
    assert.equal(second.next, undefined)
    assert.equal(second.lines[49]!.fields.text, 'note 0')
    const opened = second.lines[50]!
    assert.equal(opened.kind, 'run.opened')
    assert.equal(opened.by, 'harness')
    assert.equal(opened.session, SESSION)
    assert.deepEqual(Object.keys(opened.fields).sort(), ['base', 'baseCommit', 'branch', 'goal', 'how', 'worktree'])
    assert.equal(opened.fields.how, 'run')
    // Newest first, all the way down.
    const all = [...first.lines, ...second.lines]
    for (let index = 1; index < all.length; index++) assert.ok(all[index - 1]!.at >= all[index]!.at)

    // A limit of its own.
    const small = ok(await remote.ledger(PROJECT, run.id, 2, ''))
    assert.deepEqual(small.lines.map(line => line.fields.text), ['note 249', 'note 248'])
    const next = ok(await remote.ledger(PROJECT, run.id, 2, small.next!))
    assert.deepEqual(next.lines.map(line => line.fields.text), ['note 247', 'note 246'])
  })
})

test('ledger: a line the ledger cut says so, the child and task are base fields, and unreadable lines are counted', async () => {
  await withRemote(async (w, remote) => {
    const run = await w.open({ slug: 'fix-login' })
    await w.ledger.append(run.project, run.id, [
      { at: NOW + MINUTE, run: run.id, kind: 'note', by: 'main', session: SESSION, text: 'x'.repeat(40_000) },
      { at: NOW + 2 * MINUTE, run: run.id, kind: 'ladder.refused', by: 'harness', session: SESSION, task: 'api', child: 'c1', round: 5 } as LedgerEntry,
    ])
    await appendFile(w.ledger.file(run.project, run.id), 'not json\n{"half":\n')
    const page = ok(await remote.ledger(PROJECT, run.id, 0, ''))
    assert.equal(page.skipped, 2)
    const [ladder, note] = page.lines as [LedgerLine, LedgerLine]
    assert.deepEqual(ladder, { at: NOW + 2 * MINUTE, run: run.id, kind: 'ladder.refused', by: 'harness', session: SESSION, child: 'c1', task: 'api', fields: { round: 5 } })
    assert.equal(note.cut, true)
    assert.ok(typeof note.fields.text === 'string' && note.fields.text.length < 40_000)
  })
})

test('a token planted raw in a ledger file, past the ledger\'s own mask, reaches the page masked: in run, ledger and keys alike', async () => {
  await withRemote(async (w, remote) => {
    const run = await w.open({ slug: 'fix-login' })
    const planted = {
      at: NOW + MINUTE, run: run.id, kind: 'note', by: 'main', session: SESSION, text: `the token is ${TOKEN}`,
      [`key ${TOKEN}`]: { nested: [`and ${TOKEN}`] },
    }
    await appendFile(w.ledger.file(run.project, run.id), `${JSON.stringify(planted)}\n`)
    const page = ok(await remote.ledger(PROJECT, run.id, 0, ''))
    const detail = ok(await remote.run(PROJECT, run.id))
    for (const value of [page, detail]) {
      const text = JSON.stringify(value)
      assert.ok(!text.includes(TOKEN), text.slice(0, 400))
      assert.ok(!text.includes('ghs_'))
      assert.ok(text.includes(MASKED_TOKEN))
    }
    assert.equal(page.lines[0]!.fields.text, `the token is ${MASKED_TOKEN}`)
    assert.equal(detail.summary.notes[0]!.text, `the token is ${MASKED_TOKEN}`)
  })
})

/**
 * dish-orchestrator mounted again in `w.ctx`, over the world's own directories: a fresh store, which loads what is on disk now
 * (a record written by hand, say). The world's `dispose` takes the new one away.
 */
async function remount(w: PluginWorld): Promise<RunsRemote> {
  await w.handles.plugin!.dispose()
  const plugin = await import('../src/index.ts')
  const handle = w.ctx.plugin({
    name: plugin.name,
    Config: plugin.Config,
    apply: (own: Context, config: Config) => { plugin.start(own, config, { state: w.state, data: w.data, now: () => w.clock.now }) },
  } as never, { terminal: false } as never) as unknown as Handle
  await handle
  w.handles.plugin = handle
  await waitFor('the remote', () => w.ctx.get('dishRunsRemote') !== undefined)
  return w.ctx.get('dishRunsRemote') as RunsRemote
}

test('a token in a record written by hand, past the store\'s own mask, reaches the page masked: goal, reason and plan, in runs and run', async () => {
  await withRemote(async (w) => {
    const id = '20261003-planted'
    const file = join(w.state, 'orchestrator', 'Acme', 'widget', 'runs', `${id}.json`)
    const record: Run = {
      id, project: PROJECT, slug: 'planted', goal: `the goal holds ${TOKEN}`, plan: { path: `docs/${TOKEN}/plan.md`, commit: SHA_A },
      branch: 'dish/planted', worktree: join(w.dir, 'work', 'planted'), base: 'origin/main', baseCommit: SHA_A,
      state: 'abandoned', reason: `the reason holds ${TOKEN}`, driver: { session: '', since: NOW }, openedAt: NOW, closedAt: NOW + HOUR,
    }
    await mkdir(dirname(file), { recursive: true, mode: 0o700 })
    await writeFile(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
    const remote = await remount(w)

    const rows = await remote.runs()
    const detail = ok(await remote.run(PROJECT, id))
    // The store took the record as it is: it wasn't set aside as corrupt.
    await access(file)
    assert.deepEqual(rows.map(row => row.id), [id])
    for (const value of [rows, detail]) {
      const text = JSON.stringify(value)
      assert.ok(!text.includes('ghs_'), text.slice(0, 400))
      assert.ok(text.includes(MASKED_TOKEN))
    }
    assert.equal(rows[0]!.goal, `the goal holds ${MASKED_TOKEN}`)
    assert.equal(rows[0]!.reason, `the reason holds ${MASKED_TOKEN}`)
    assert.equal(detail.goal, `the goal holds ${MASKED_TOKEN}`)
    assert.equal(detail.reason, `the reason holds ${MASKED_TOKEN}`)
    assert.ok(detail.plan !== undefined && detail.plan.path.includes(MASKED_TOKEN) && !detail.plan.path.includes('ghs_'), JSON.stringify(detail.plan))
  })
})

// --- read only ------------------------------------------------------------------------------------------

/** Every path under `dir`, with its size and mtime. */
async function snapshot(dir: string): Promise<Map<string, string>> {
  const found = new Map<string, string>()
  const walk = async (at: string): Promise<void> => {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      const path = join(at, entry.name)
      const info = await lstat(path)
      found.set(relative(dir, path), `${info.isDirectory() ? 'dir' : 'file'} ${info.size} ${info.mtimeMs}`)
      if (entry.isDirectory()) await walk(path)
    }
  }
  await walk(dir)
  return found
}

test('no method writes: every file and directory is as it was, with its size and mtime, after every call', async () => {
  await withRemote(async (w, remote) => {
    w.live.add(SESSION)
    const run = await w.open({ slug: 'fix-login' })
    await w.ledger.append(run.project, run.id, everyKind(run.id))
    const other = await w.open({ slug: 'other', project: OTHER_PROJECT, session: OTHER_SESSION })
    await w.ledger.flush()
    await w.store.flush()
    const before = await snapshot(w.dir)
    assert.ok([...before.keys()].some(path => path.endsWith('.jsonl')))
    assert.ok([...before.keys()].some(path => path.endsWith(`${run.id}.json`)))

    await remote.runs()
    ok(await remote.run(PROJECT, run.id))
    ok(await remote.run(OTHER_PROJECT, other.id))
    ok(await remote.ledger(PROJECT, run.id, 0, ''))
    const page = ok(await remote.ledger(PROJECT, run.id, 5, ''))
    ok(await remote.ledger(PROJECT, run.id, 5, page.next!))
    // A run with no ledger yet, and one that isn't there: neither makes a file or a directory.
    failed(await remote.run(PROJECT, '20261003-nothing'), 'NOT_FOUND')
    failed(await remote.ledger('Nobody/here', '20261003-nothing', 0, ''), 'NOT_FOUND')
    failed(await remote.ledger('../x', run.id, 0, ''), 'INVALID')
    failed(await remote.ledger(PROJECT, run.id, 0, 'bad'), 'INVALID')
    await w.ledger.flush()
    await w.store.flush()

    assert.deepEqual(await snapshot(w.dir), before)
  })
})
