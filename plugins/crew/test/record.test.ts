import { createHash } from 'node:crypto'
import { chmod, mkdir, open, readdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { maskSecrets } from 'dish-kit'
import {
  CODER_STATUSES, CrewRecords, GATE_OUTCOMES, SEVERITIES, STOP_REASON_STATUS, TEMP_GRACE_MS, VERDICTS, closingOf, gateProblem, isRunning, latestGate,
  maskReport, reportContent, reportProblem, reportRole, statusFor,
} from '../src/record.ts'
import type { ChildRecord, CoderReport, GateResult, NewChild, ReviewerReport, StructuredReport } from '../src/record.ts'
import * as crewIndex from '../src/index.ts'
import type {
  CoderReport as IndexCoderReport, GateOutcome as IndexGateOutcome, GateResult as IndexGateResult, ReviewerReport as IndexReviewerReport,
  StructuredReport as IndexStructuredReport,
} from '../src/index.ts'
import { tempDir } from './helpers.ts'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const STARTED = 1_700_000_000_000

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function newChild(id: string, overrides: Partial<NewChild> = {}): NewChild {
  return { id, role: 'coder', title: 'add login', model: 'claude-sonnet-5.5', family: 'anthropic', startedAt: STARTED, ...overrides }
}

/** A gate result as dish-gates records one: a failure in round 1 of turn 1, unless `overrides` says otherwise. */
function gate(overrides: Partial<GateResult> = {}): GateResult {
  return {
    turn: 1, round: 1, maxRounds: 3, outcome: 'failed', command: 'pnpm test', exitCode: 1, timedOut: false, durationMs: 4200,
    log: '/state/dish/gates/acme/widget/fix-1/c1-1-1.log', excerpt: 'not ok 1 - adds\n# fail 1', at: STARTED + 1000, ...overrides,
  }
}

interface Fixture {
  directory: string
  records: CrewRecords
  /** What `onCorrupt` was told, as `[session, path]`. */
  corrupt: Array<[string, string]>
}

/** A `CrewRecords` on a new empty temp directory. */
async function fixture(): Promise<Fixture> {
  const directory = await tempDir()
  return { directory, ...reopen(directory) }
}

/** A `CrewRecords` on `directory`, as a restarted dsh would make one. */
function reopen(directory: string): Pick<Fixture, 'records' | 'corrupt'> {
  const corrupt: Array<[string, string]> = []
  return { records: new CrewRecords(directory, (session, path) => { corrupt.push([session, path]) }), corrupt }
}

function sessionDir(directory: string, sessionId: string): string {
  return join(directory, 'sessions', sha(sessionId))
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false)
}

/** Set the mtime and atime of `path` to `ageMs` ago. */
async function age(path: string, ageMs: number): Promise<void> {
  const when = new Date(Date.now() - ageMs)
  await utimes(path, when, when)
}

/** Whether this process can ignore file modes: a test that needs them to refuse a write can't run as root. */
const root = process.getuid?.() === 0

// --- adding and listing ---------------------------------------------------------------------------

test('a new child is recorded running, with its order and nothing else yet; reviews is kept only if given', async () => {
  const { records } = await fixture()
  const added = await records.addChild('s1', newChild('c1'))
  assert.deepEqual(added, {
    id: 'c1', n: 1, role: 'coder', title: 'add login', model: 'claude-sonnet-5.5', family: 'anthropic',
    startedAt: STARTED, followUps: 0, runs: [], last: 'running',
  })
  assert.ok(!('reviews' in added))
  const reviewer = await records.addChild('s1', newChild('c2', { role: 'reviewer', model: 'gpt-5.6-sol', family: 'openai', reviews: 'c1' }))
  assert.equal(reviewer.reviews, 'c1')
  assert.equal(reviewer.n, 2)
  const main = await records.addChild('s1', newChild('c3', { role: 'reviewer', reviews: 'main' }))
  assert.equal(main.reviews, 'main')
  assert.deepEqual(await records.children('s1'), [added, reviewer, main])
})

test('startedAt is now when it is not given', async () => {
  const { records } = await fixture()
  const before = Date.now()
  const { startedAt } = await records.addChild('s1', { id: 'c1', role: 'coder', title: 't', model: 'm', family: 'f' })
  assert.ok(startedAt >= before && startedAt <= Date.now(), String(startedAt))
})

test('children of a session nobody started is an empty list, and sessions are separate', async () => {
  const { records } = await fixture()
  assert.deepEqual(await records.children('nobody'), [])
  await records.addChild('s1', newChild('c1'))
  assert.deepEqual(await records.children('s2'), [])
  assert.deepEqual((await records.children('s1')).map(child => child.id), ['c1'])
})

test('n is one more than the number of children the session has, in order, and a session\'s count is its own', async () => {
  const { records } = await fixture()
  const ns = []
  for (const id of ['a', 'b', 'c']) ns.push((await records.addChild('s1', newChild(id))).n)
  assert.deepEqual(ns, [1, 2, 3])
  assert.equal((await records.addChild('s2', newChild('d'))).n, 1)
  assert.deepEqual((await records.children('s1')).map(child => [child.id, child.n]), [['a', 1], ['b', 2], ['c', 3]])
})

test('recording the same child twice is the same child, not a second entry', async () => {
  const { records } = await fixture()
  const first = await records.addChild('s1', newChild('c1'))
  const second = await records.addChild('s1', newChild('c1', { title: 'something else' }))
  assert.deepEqual(second, first)
  assert.equal((await records.children('s1')).length, 1)
  assert.equal((await records.addChild('s1', newChild('c2'))).n, 2)
})

test('what addChild is given must be a child: the wrong shape is a TypeError and writes nothing', async () => {
  const { records, directory } = await fixture()
  const bad: unknown[] = [
    newChild(''), newChild('c1', { role: '' }), newChild('c1', { model: '' }), newChild('c1', { family: '' }),
    { ...newChild('c1'), title: 5 }, { ...newChild('c1'), reviews: 5 }, { ...newChild('c1'), startedAt: Number.NaN },
    null, 'c1',
  ]
  for (const record of bad) {
    await assert.rejects(records.addChild('s1', record as NewChild), TypeError, JSON.stringify(record))
  }
  await assert.rejects(records.addChild('', newChild('c1')), TypeError)
  assert.equal(await exists(join(directory, 'sessions')), false)
  assert.equal(await exists(join(directory, 'by-child')), false)
})

test('what a caller gets back is a copy: changing it does not change the record', async () => {
  const { records } = await fixture()
  const added = await records.addChild('s1', newChild('c1'))
  added.title = 'changed'
  added.runs.push({ endedAt: 1, stopReason: 'completed', report: 'x' })
  const listed = await records.children('s1')
  listed[0]!.followUps = 9
  const looked = await records.lookup('c1')
  looked!.record.last = 'failed'
  assert.deepEqual(await records.children('s1'), [{
    id: 'c1', n: 1, role: 'coder', title: 'add login', model: 'claude-sonnet-5.5', family: 'anthropic',
    startedAt: STARTED, followUps: 0, runs: [], last: 'running',
  }])
})

// --- worktrees ------------------------------------------------------------------------------------

const TREE = '/work/frostyard/snosi/.worktrees/fix-1'
const OTHER_TREE = '/work/frostyard/snosi/.worktrees/fix-2'

test('a child bound to a worktree keeps its path in the record; an unbound child has no worktree field', async () => {
  const { records } = await fixture()
  const bound = await records.addChild('s1', newChild('c1', { worktree: TREE }))
  assert.deepEqual(bound, {
    id: 'c1', n: 1, role: 'coder', title: 'add login', model: 'claude-sonnet-5.5', family: 'anthropic', worktree: TREE,
    startedAt: STARTED, followUps: 0, runs: [], last: 'running',
  })
  const unbound = await records.addChild('s1', newChild('c2', { role: 'researcher' }))
  assert.ok(!('worktree' in unbound))
  assert.equal((await records.lookup('c1'))?.record.worktree, TREE)
  assert.deepEqual(await records.children('s1'), [bound, unbound])
})

test('the binding survives a restart, and a run ending or a follow-up does not change it', async () => {
  const { records, directory } = await fixture()
  await records.addChild('s1', newChild('c1', { worktree: TREE }))
  await records.endRun('c1', { stopReason: 'completed', closing: 'done' })
  await records.addFollowUp('c1')
  const { records: restarted } = reopen(directory)
  const found = await restarted.lookup('c1')
  assert.equal(found?.record.worktree, TREE)
  assert.equal(found?.record.followUps, 1)
  const file = JSON.parse(await readFile(join(sessionDir(directory, 's1'), 'children.json'), 'utf8'))
  assert.equal(file.children[0].worktree, TREE)
})

test('a children.json written before worktrees existed still parses, and its children are unbound', async () => {
  const { records, directory, corrupt } = await fixture()
  const dir = sessionDir(directory, 's1')
  await mkdir(dir, { recursive: true })
  const old = {
    sessionId: 's1',
    children: [{ id: 'c1', n: 1, role: 'coder', title: 'add login', model: 'claude-sonnet-5.5', family: 'anthropic', startedAt: STARTED, followUps: 0, runs: [], last: 'finished' }],
  }
  await writeFile(join(dir, 'children.json'), JSON.stringify(old))
  const [child] = await records.children('s1')
  assert.equal(child?.id, 'c1')
  assert.ok(!('worktree' in child!))
  assert.deepEqual(corrupt, [])
})

test('addChild refuses a worktree that is not an absolute path, and writes nothing', async () => {
  const { records, directory } = await fixture()
  for (const worktree of [5, '', 'relative/path', null]) {
    await assert.rejects(records.addChild('s1', { ...newChild('c1'), worktree } as unknown as NewChild), /worktree must be an absolute path/, String(worktree))
  }
  assert.equal(await exists(join(directory, 'sessions')), false)
})

test('boundTo finds every child bound to a worktree, across sessions, with its session, oldest first', async () => {
  const { records } = await fixture()
  await records.addChild('s1', newChild('c1', { worktree: TREE, startedAt: STARTED + 2 }))
  await records.addChild('s1', newChild('c2', { worktree: OTHER_TREE }))
  await records.addChild('s1', newChild('c3', { role: 'researcher' }))
  await records.addChild('s2', newChild('c4', { worktree: TREE, startedAt: STARTED + 1 }))
  await records.endRun('c4', { stopReason: 'completed', closing: 'done' })
  const found = await records.boundTo(TREE)
  assert.deepEqual(found.map(({ sessionId, record }) => [sessionId, record.id, record.last]), [['s2', 'c4', 'finished'], ['s1', 'c1', 'running']])
  assert.deepEqual((await records.boundTo(OTHER_TREE)).map(({ record }) => record.id), ['c2'])
  // Compared exactly: no prefix, no trailing slash, no case folding.
  assert.deepEqual(await records.boundTo('/work/frostyard/snosi/.worktrees'), [])
  assert.deepEqual(await records.boundTo(`${TREE}/`), [])
  assert.deepEqual(await records.boundTo(TREE.toUpperCase()), [])
  // What a caller gets is a copy.
  found[0]!.record.title = 'changed'
  assert.equal((await records.lookup('c4'))?.record.title, 'add login')
})

test('boundTo is empty with no record at all, and with records but none bound there', async () => {
  const empty = await fixture()
  assert.deepEqual(await empty.records.boundTo(TREE), [])
  const { records } = await fixture()
  await records.addChild('s1', newChild('c1'))
  assert.deepEqual(await records.boundTo(TREE), [])
  assert.deepEqual(await records.boundTo(''), [])
})

test('boundTo skips what is not a session, and sets aside a corrupt session as every read does', async () => {
  const { records, directory, corrupt } = await fixture()
  await records.addChild('s1', newChild('c1', { worktree: TREE }))
  await records.addChild('s2', newChild('c2', { worktree: TREE }))
  await writeFile(join(sessionDir(directory, 's2'), 'children.json'), '{ broken')
  await mkdir(join(directory, 'sessions', 'not-a-hash'), { recursive: true })
  await writeFile(join(directory, 'sessions', 'not-a-hash', 'children.json'), JSON.stringify({ sessionId: 'x', children: [] }))
  assert.deepEqual((await records.boundTo(TREE)).map(({ record }) => record.id), ['c1'])
  assert.deepEqual(corrupt.map(([session]) => session), [sha('s2')])
})

test('isRunning: a stepping agent, or a record that says running with its agent there; without a registry, the record\'s word', async () => {
  const { records } = await fixture()
  const running = await records.addChild('s1', newChild('c1'))
  await records.addChild('s1', newChild('c2'))
  await records.endRun('c2', { stopReason: 'completed', closing: 'done' })
  const [, finished] = await records.children('s1')
  const agents = (live: Record<string, string>) => ({ get: (id: string) => Object.hasOwn(live, id) ? { status: live[id] } : undefined })
  assert.equal(isRunning(running, agents({ c1: 'running' })), true)
  assert.equal(isRunning(running, agents({ c1: 'idle' })), true, 'accepted, not stepping yet')
  assert.equal(isRunning(running, agents({})), false, 'a crash\'s record')
  assert.equal(isRunning(finished!, agents({ c2: 'running' })), true, 'woken')
  assert.equal(isRunning(finished!, agents({ c2: 'idle' })), false)
  assert.equal(isRunning(running, undefined), true)
  assert.equal(isRunning(finished!, undefined), false)
})

test('boundTo waits for the writes queued before it', async () => {
  const { records } = await fixture()
  const adding = records.addChild('s1', newChild('c1', { worktree: TREE }))
  const found = records.boundTo(TREE)
  await adding
  assert.deepEqual((await found).map(({ record }) => record.id), ['c1'])
})

// --- follow-ups -----------------------------------------------------------------------------------

test('a follow-up is counted, and puts a child that had finished back to running', async () => {
  const { records } = await fixture()
  await records.addChild('s1', newChild('c1'))
  await records.addFollowUp('c1')
  assert.equal((await records.children('s1'))[0]!.followUps, 1)
  await records.endRun('c1', { stopReason: 'completed', closing: 'done' })
  assert.equal((await records.children('s1'))[0]!.last, 'finished')
  await records.addFollowUp('c1')
  await records.addFollowUp('c1')
  const [child] = await records.children('s1')
  assert.equal(child!.followUps, 3)
  assert.equal(child!.last, 'running')
  assert.equal(child!.runs.length, 1)
})

test('a follow-up to a child that is not recorded does nothing, and does not throw', async () => {
  const { records, directory } = await fixture()
  await records.addFollowUp('nobody')
  await records.addFollowUp('')
  await records.addFollowUp(undefined as never)
  assert.equal(await exists(join(directory, 'sessions')), false)
})

// --- starts ---------------------------------------------------------------------------------------

test('a run that starts again puts a child that had ended back to running, whatever it ended as', async () => {
  const { records } = await fixture()
  for (const reason of ['completed', 'error', 'aborted']) {
    await records.addChild('s1', newChild(`c-${reason}`))
    await records.endRun(`c-${reason}`, { stopReason: reason, closing: 'x' })
  }
  assert.deepEqual((await records.children('s1')).map(child => child.last), ['finished', 'failed', 'stopped'])
  for (const reason of ['completed', 'error', 'aborted']) await records.startRun(`c-${reason}`)
  const listed = await records.children('s1')
  assert.deepEqual(listed.map(child => child.last), ['running', 'running', 'running'])
  // A start is not a follow-up and not a run: it changes nothing else.
  assert.ok(listed.every(child => child.followUps === 0 && child.runs.length === 1))
})

test('a start for a child that is running already writes nothing', { skip: process.platform === 'win32' }, async () => {
  const { records, directory } = await fixture()
  await records.addChild('s1', newChild('c1'))
  const file = join(sessionDir(directory, 's1'), 'children.json')
  // Every write is a new file renamed into place, so a new inode is a write.
  const before = await stat(file)
  await records.startRun('c1')
  await records.startRun('c1')
  const after = await stat(file)
  assert.equal(after.ino, before.ino)
  assert.equal(after.mtimeMs, before.mtimeMs)
  // And one that is not running is written, once.
  await records.endRun('c1', { stopReason: 'completed', closing: 'x' })
  const ended = await stat(file)
  await records.startRun('c1')
  const started = await stat(file)
  assert.notEqual(started.ino, ended.ino)
  await records.startRun('c1')
  assert.equal((await stat(file)).ino, started.ino)
})

test('a start for a child nobody recorded does nothing, writes nothing, and never throws, whatever it is given', async () => {
  const { records, directory } = await fixture()
  await records.startRun('ghost')
  const odd: unknown[] = ['', undefined, null, 5, {}, '../../../etc/passwd', 'a/b', '\0']
  for (const id of odd) await records.startRun(id as string)
  assert.equal(await exists(join(directory, 'sessions')), false)
  assert.equal(await exists(join(directory, 'by-child')), false)
})

test('the runs of a child that was started again are numbered on, and a start between them changes no report', async () => {
  const { records, directory } = await fixture()
  await records.addChild('s1', newChild('c1'))
  await records.endRun('c1', { stopReason: 'completed', closing: 'first' })
  await records.startRun('c1')
  await records.endRun('c1', { stopReason: 'completed', closing: 'second' })
  const dir = sessionDir(directory, 's1')
  assert.equal(await readFile(join(dir, '1-coder-1.md'), 'utf8'), 'first\n')
  assert.equal(await readFile(join(dir, '1-coder-2.md'), 'utf8'), 'second\n')
  assert.equal((await records.children('s1'))[0]!.last, 'finished')
})

// --- runs and reports -----------------------------------------------------------------------------

test('endRun writes the closing message as a report named for the child\'s order, role and run, and records the run', async () => {
  const { records, directory } = await fixture()
  await records.addChild('s1', newChild('c0', { role: 'researcher' }))
  await records.addChild('s1', newChild('c1'))
  const before = Date.now()
  const ended = await records.endRun('c1', { stopReason: 'completed', closing: 'I added the login.\n\nTests pass.' })
  const file = join(sessionDir(directory, 's1'), '2-coder-1.md')
  assert.equal(ended?.report, file)
  assert.equal(await readFile(file, 'utf8'), 'I added the login.\n\nTests pass.\n')
  const [, child] = await records.children('s1')
  assert.equal(child!.last, 'finished')
  assert.equal(child!.runs.length, 1)
  const [run] = child!.runs
  assert.ok(run!.endedAt >= before && run!.endedAt <= Date.now())
  assert.deepEqual({ ...run, endedAt: 0 }, { endedAt: 0, stopReason: 'completed', report: file })
  assert.ok(!('error' in run!))
})

test('a second run is another report and another run, and the last status is the latest run\'s', async () => {
  const { records, directory } = await fixture()
  await records.addChild('s1', newChild('c1'))
  const first = await records.endRun('c1', { stopReason: 'error', error: 'rate limited', closing: 'half done' })
  await records.addFollowUp('c1')
  const second = await records.endRun('c1', { stopReason: 'completed', closing: 'all done' })
  const dir = sessionDir(directory, 's1')
  assert.equal(first?.report, join(dir, '1-coder-1.md'))
  assert.equal(second?.report, join(dir, '1-coder-2.md'))
  assert.equal(await readFile(join(dir, '1-coder-1.md'), 'utf8'), 'half done\n')
  assert.equal(await readFile(join(dir, '1-coder-2.md'), 'utf8'), 'all done\n')
  const [child] = await records.children('s1')
  assert.deepEqual(child!.runs.map(run => [run.stopReason, run.error, run.report]),
    [['error', 'rate limited', join(dir, '1-coder-1.md')], ['completed', undefined, join(dir, '1-coder-2.md')]])
  assert.equal(child!.last, 'finished')
  assert.equal(child!.followUps, 1)
})

test('a run with no closing message is a report that says so, and an empty error is no error', async () => {
  const { records, directory } = await fixture()
  await records.addChild('s1', newChild('c1'))
  await records.endRun('c1', { stopReason: 'aborted', error: '', closing: '' })
  await records.endRun('c1', { stopReason: 'aborted', closing: '  \n ' })
  const dir = sessionDir(directory, 's1')
  assert.equal(await readFile(join(dir, '1-coder-1.md'), 'utf8'), '(no closing message)\n')
  assert.equal(await readFile(join(dir, '1-coder-2.md'), 'utf8'), '(no closing message)\n')
  const [child] = await records.children('s1')
  assert.ok(child!.runs.every(run => !('error' in run)))
  assert.equal(child!.last, 'stopped')
})

test('a role in a report\'s name can not name another path', async () => {
  const { records, directory } = await fixture()
  await records.addChild('s1', newChild('c1', { role: '../../escape' }))
  const ended = await records.endRun('c1', { stopReason: 'completed', closing: 'x' })
  assert.equal(join(ended!.report, '..'), sessionDir(directory, 's1'))
  assert.deepEqual((await readdir(directory)).sort(), ['by-child', 'sessions'])
})

test('lookup finds a child by its id alone, with the session it belongs to', async () => {
  const { records } = await fixture()
  const a = await records.addChild('s1', newChild('c1'))
  const b = await records.addChild('s2', newChild('c2', { role: 'reviewer', reviews: 'main' }))
  assert.deepEqual(await records.lookup('c1'), { sessionId: 's1', record: a })
  assert.deepEqual(await records.lookup('c2'), { sessionId: 's2', record: b })
  assert.equal(await records.lookup('c3'), undefined)
})

// --- restart --------------------------------------------------------------------------------------

test('a new CrewRecords on the same directory still has the children, and can file a run for a child it never started', async () => {
  const { records, directory } = await fixture()
  await records.addChild('s1', newChild('c1'))
  await records.addChild('s1', newChild('c2', { role: 'researcher' }))
  await records.endRun('c1', { stopReason: 'completed', closing: 'first' })
  const { records: restarted } = reopen(directory)
  assert.deepEqual(await restarted.children('s1'), await records.children('s1'))
  assert.deepEqual((await restarted.lookup('c2'))?.sessionId, 's1')
  // The pointer is what finds c2's session: this instance has never seen c2.
  const ended = await restarted.endRun('c2', { stopReason: 'completed', closing: 'second' })
  assert.equal(ended?.report, join(sessionDir(directory, 's1'), '2-researcher-1.md'))
  await restarted.addFollowUp('c1')
  await restarted.endRun('c1', { stopReason: 'completed', closing: 'again' })
  const [c1, c2] = await restarted.children('s1')
  assert.deepEqual(c1!.runs.map(run => run.report.split('/').pop()), ['1-coder-1.md', '1-coder-2.md'])
  assert.equal(c1!.followUps, 1)
  assert.deepEqual(c2!.runs.map(run => run.report.split('/').pop()), ['2-researcher-1.md'])
  // And the count goes on from what is there.
  assert.equal((await restarted.addChild('s1', newChild('c3'))).n, 3)
})

// --- what a bad event can do ----------------------------------------------------------------------

test('endRun for a child nobody recorded is undefined, writes nothing, and never throws, whatever it is given', async () => {
  const { records, directory } = await fixture()
  assert.equal(await records.endRun('ghost', { stopReason: 'completed', closing: 'x' }), undefined)
  const odd: unknown[] = ['', undefined, null, 5, {}, '../../../etc/passwd', 'a/b', '\0']
  for (const id of odd) {
    assert.equal(await records.endRun(id as string, { stopReason: 'completed', closing: 'x' }), undefined, JSON.stringify(id))
    assert.equal(await records.lookup(id as string), undefined)
  }
  assert.equal(await records.endRun('ghost', undefined as never), undefined)
  assert.equal(await exists(join(directory, 'sessions')), false)
})

test('endRun for a child it knows takes a reason, an error and a closing message of any type without throwing', async () => {
  const { records } = await fixture()
  await records.addChild('s1', newChild('c1'))
  await records.endRun('c1', { stopReason: undefined, error: 5, closing: { not: 'text' } } as never)
  await records.endRun('c1', { stopReason: 'completed', error: { message: 'x' }, closing: null } as never)
  await records.endRun('c1', {} as never)
  const [child] = await records.children('s1')
  assert.equal(child!.runs.length, 3)
  assert.deepEqual(child!.runs.map(run => run.stopReason), ['unknown', 'completed', 'unknown'])
  assert.ok(child!.runs.every(run => !('error' in run)))
  // The last run had no reason: a malformed event is not a success.
  assert.equal(child!.last, 'stopped')
})

test('a pointer that is not a session hash finds nothing, and a pointer to a session that is gone finds nothing', async () => {
  const { records, directory } = await fixture()
  await records.addChild('s1', newChild('c1'))
  const pointer = join(directory, 'by-child', sha('c1'))
  assert.equal((await readFile(pointer, 'utf8')).trim(), sha('s1'))
  await writeFile(pointer, '../../escape\n')
  assert.equal(await records.endRun('c1', { stopReason: 'completed', closing: 'x' }), undefined)
  assert.equal(await records.lookup('c1'), undefined)
  await writeFile(pointer, `${sha('s1')}\n`)
  await rm(sessionDir(directory, 's1'), { recursive: true })
  assert.equal(await records.endRun('c1', { stopReason: 'completed', closing: 'x' }), undefined)
  assert.equal(await records.lookup('c1'), undefined)
})

test('an id or a role of any bytes is never a path: session and child directories are hashes', async () => {
  const { records, directory } = await fixture()
  const session = '../../../etc/\0weird/..'
  await records.addChild(session, newChild('../child/..', { role: 'coder' }))
  await records.endRun('../child/..', { stopReason: 'completed', closing: 'x' })
  assert.deepEqual(await readdir(join(directory, 'sessions')), [sha(session)])
  assert.deepEqual(await readdir(join(directory, 'by-child')), [sha('../child/..')])
  assert.equal((await records.children(session)).length, 1)
})

// --- files ----------------------------------------------------------------------------------------

test('the layout: a session directory of hashes, children.json, reports, and a pointer for each child', async () => {
  const { records, directory } = await fixture()
  await records.addChild('s1', newChild('c1'))
  await records.endRun('c1', { stopReason: 'completed', closing: 'x' })
  assert.deepEqual((await readdir(directory)).sort(), ['by-child', 'sessions'])
  assert.deepEqual((await readdir(join(directory, 'sessions', sha('s1')))).sort(), ['1-coder-1.md', 'children.json'])
  assert.deepEqual(await readdir(join(directory, 'by-child')), [sha('c1')])
  assert.equal(await readFile(join(directory, 'by-child', sha('c1')), 'utf8'), sha('s1'))
  const file = JSON.parse(await readFile(join(sessionDir(directory, 's1'), 'children.json'), 'utf8'))
  assert.equal(file.sessionId, 's1')
  assert.equal(file.children[0].id, 'c1')
})

test('directories are 0o700 and files 0o600, and nothing is left behind by a write', { skip: process.platform === 'win32' }, async () => {
  const { records, directory } = await fixture()
  await records.addChild('s1', newChild('c1'))
  await records.endRun('c1', { stopReason: 'completed', closing: 'x' })
  const modes = async (path: string) => (await stat(path)).mode & 0o777
  for (const dir of [directory, join(directory, 'sessions'), join(directory, 'by-child'), sessionDir(directory, 's1')]) {
    assert.equal(await modes(dir), 0o700, dir)
  }
  for (const file of [join(sessionDir(directory, 's1'), 'children.json'), join(sessionDir(directory, 's1'), '1-coder-1.md'), join(directory, 'by-child', sha('c1'))]) {
    assert.equal(await modes(file), 0o600, file)
  }
  for (const dir of [sessionDir(directory, 's1'), join(directory, 'by-child')]) {
    assert.ok((await readdir(dir)).every(name => !name.endsWith('.tmp')), dir)
  }
})

/**
 * Spy on `FileHandle.prototype.sync` (calling through), recording the directory's listing at each call. `fail` is the
 * 1-based call to reject. Returns the listings.
 */
async function spyOnSync(t: TestContext, directory: string, fail?: number): Promise<string[][]> {
  const probe = await open(join(directory, 'probe'), 'w')
  const prototype = Object.getPrototypeOf(probe) as { sync(): Promise<void> }
  await probe.close()
  await rm(join(directory, 'probe'))
  const original = prototype.sync
  const listings: string[][] = []
  t.mock.method(prototype, 'sync', async function (this: unknown) {
    listings.push((await readdir(directory)).sort())
    if (fail === listings.length) throw new Error('sync failed')
    return original.call(this)
  })
  return listings
}

test('a write syncs the file before the rename, and then the directory', async (t) => {
  const { records, directory } = await fixture()
  await records.addChild('s1', newChild('c1'))
  const dir = sessionDir(directory, 's1')
  const listings = await spyOnSync(t, dir)
  await records.addFollowUp('c1')
  assert.equal(listings.length, 2)
  // The first sync sees the temp file beside the old record: the new text is on disk before it becomes the record.
  assert.equal(listings[0]!.length, 2)
  assert.match(listings[0]![0]!, /^\.children\.json\.[0-9a-f]{16}\.tmp$/)
  assert.equal(listings[0]![1], 'children.json')
  // The second sees only the record: the directory entry is synced after the rename.
  assert.deepEqual(listings[1], ['children.json'])
  assert.equal((await records.children('s1'))[0]!.followUps, 1)
})

test('a failed file sync fails the write and leaves the record as it was; a failed directory sync does not', async (t) => {
  const { records, directory } = await fixture()
  await records.addChild('s1', newChild('c1'))
  const dir = sessionDir(directory, 's1')
  const fileSync = await spyOnSync(t, dir, 1)
  await assert.rejects(records.addFollowUp('c1'), /sync failed/)
  assert.equal(fileSync.length, 1)
  assert.deepEqual(await readdir(dir), ['children.json'])
  assert.equal((await records.children('s1'))[0]!.followUps, 0)
  t.mock.restoreAll()
  const dirSync = await spyOnSync(t, dir, 2)
  await records.addFollowUp('c1')
  assert.equal(dirSync.length, 2)
  assert.equal((await records.children('s1'))[0]!.followUps, 1)
})

test('a write that fails leaves the record as it was, and no temp file', { skip: process.platform === 'win32' || root }, async () => {
  const { records, directory } = await fixture()
  await records.addChild('s1', newChild('c1'))
  const dir = sessionDir(directory, 's1')
  const before = await readFile(join(dir, 'children.json'), 'utf8')
  await chmod(dir, 0o500)
  try {
    await assert.rejects(records.endRun('c1', { stopReason: 'completed', closing: 'x' }))
    await assert.rejects(records.addFollowUp('c1'))
  } finally {
    await chmod(dir, 0o700)
  }
  assert.equal(await readFile(join(dir, 'children.json'), 'utf8'), before)
  assert.deepEqual((await readdir(dir)).sort(), ['children.json'])
  // The record still takes writes, and the queue wasn't stuck by the failure.
  await records.endRun('c1', { stopReason: 'completed', closing: 'x' })
  assert.equal((await records.children('s1'))[0]!.runs.length, 1)
})

test('an I/O error other than a missing file is thrown, not taken for an empty record', async () => {
  const { records, directory } = await fixture()
  await records.addChild('s1', newChild('c1'))
  const file = join(sessionDir(directory, 's1'), 'children.json')
  await rm(file)
  await mkdir(file)
  await assert.rejects(records.children('s1'))
  await assert.rejects(records.addChild('s1', newChild('c2')))
  await rm(file, { recursive: true })
  assert.deepEqual(await records.children('s1'), [])
})

// --- corruption -----------------------------------------------------------------------------------

const BAD_FILES: Array<[string, string | ((good: any) => unknown)]> = [
  ['not JSON', '{ this is not json'],
  ['an empty file', ''],
  ['null', 'null'],
  ['a list', '[]'],
  ['no children list', JSON.stringify({ sessionId: 's1' })],
  ['a children that is not a list', (good) => ({ ...good, children: {} })],
  ['a session that is not this one', (good) => ({ ...good, sessionId: 'another' })],
  ['a session id that is not a string', (good) => ({ ...good, sessionId: 5 })],
  ['an entry that is not an object', (good) => ({ ...good, children: [...good.children, 'c3'] })],
  ['an id that is not a string', (good) => { good.children[0].id = 5; return good }],
  ['an empty id', (good) => { good.children[0].id = ''; return good }],
  ['an n that is not a number', (good) => { good.children[0].n = '1'; return good }],
  ['an n that is not finite', (good) => { good.children[0].n = null; return good }],
  ['a startedAt that is not finite', (good) => { good.children[0].startedAt = 'yesterday'; return good }],
  ['a role that is not a string', (good) => { good.children[0].role = 1; return good }],
  ['a title that is not a string', (good) => { good.children[0].title = null; return good }],
  ['a model that is not a string', (good) => { good.children[0].model = []; return good }],
  ['a family that is not a string', (good) => { delete good.children[0].family; return good }],
  ['a reviews that is not a string', (good) => { good.children[0].reviews = 3; return good }],
  ['a worktree that is not a string', (good) => { good.children[0].worktree = ['/work/a/b/.worktrees/x']; return good }],
  ['a worktree that is null', (good) => { good.children[0].worktree = null; return good }],
  ['a followUps that is not a number', (good) => { good.children[0].followUps = '0'; return good }],
  ['a last that is not a status', (good) => { good.children[0].last = 'paused'; return good }],
  ['runs that is not a list', (good) => { good.children[0].runs = 'none'; return good }],
  ['a run that is not an object', (good) => { good.children[0].runs = [1]; return good }],
  ['a run with an endedAt that is not finite', (good) => { good.children[0].runs[0].endedAt = 'x'; return good }],
  ['a run with a stopReason that is not a string', (good) => { good.children[0].runs[0].stopReason = 2; return good }],
  ['a run with an error that is not a string', (good) => { good.children[0].runs[0].error = {}; return good }],
  ['a run with a report that is not a string', (good) => { good.children[0].runs[0].report = null; return good }],
  ['a gates on the child that is not a list', (good) => { good.children[0].gates = 'none'; return good }],
  ['a gate on the child that is malformed', (good) => { good.children[0].gates = [{ ...gate(), outcome: 'maybe' }]; return good }],
  ['a gate on the child that is not an object', (good) => { good.children[0].gates = [gate(), 7]; return good }],
  ['a gates on a run that is not a list', (good) => { good.children[0].runs[0].gates = {}; return good }],
  ['a gate on a run that is malformed', (good) => { good.children[0].runs[0].gates = [{ ...gate(), round: 0 }]; return good }],
  ['a gateOverride that is not a string', (good) => { good.children[0].gateOverride = 5; return good }],
  ['a gateOverride that is null', (good) => { good.children[0].gateOverride = null; return good }],
  ['a gateOverrideAt that is not finite', (good) => { good.children[0].gateOverrideAt = 'today'; return good }],
  ['a gate head that is not a commit id', (good) => { good.children[0].gates = [{ ...gate(), head: 'xyz' }]; return good }],
  ['a run ref that is not a string', (good) => { good.children[0].run = 7; return good }],
  ['a task that is not a string', (good) => { good.children[0].task = ['fix-1']; return good }],
  ['a final that is false', (good) => { good.children[0].final = false; return good }],
  ['a final that is the string true', (good) => { good.children[0].final = 'true'; return good }],
  ['a report on the child that is malformed', (good) => { good.children[0].report = { ...coderReport(), status: 'maybe' }; return good }],
  ['a report on the child that is not an object', (good) => { good.children[0].report = 'done'; return good }],
  ['a structured report on a run that is malformed', (good) => { good.children[0].runs[0].structured = reviewerReport({ verdict: 'lgtm' as never }); return good }],
  ['a structuredFile that is not a string', (good) => { good.children[0].runs[0].structuredFile = 5; return good }],
  ['a notice that is not a string', (good) => { good.children[0].runs[0].notice = 5; return good }],
]

for (const [what, make] of BAD_FILES) {
  test(`children.json with ${what} is set aside, reported once, and the session starts fresh`, async () => {
    const { records, directory, corrupt } = await fixture()
    await records.addChild('s1', newChild('c1'))
    await records.addChild('s1', newChild('c2'))
    await records.endRun('c1', { stopReason: 'completed', closing: 'x' })
    const dir = sessionDir(directory, 's1')
    const file = join(dir, 'children.json')
    const good = JSON.parse(await readFile(file, 'utf8'))
    const text = typeof make === 'string' ? make : JSON.stringify(make(good))
    await writeFile(file, text)

    assert.deepEqual(await records.children('s1'), [])
    assert.equal(corrupt.length, 1, JSON.stringify(corrupt))
    const [[session, path]] = corrupt as [[string, string]]
    assert.equal(session, 's1')
    assert.match(path, /\/children\.json\.corrupt-\d+$/)
    assert.equal(path.startsWith(`${dir}/`), true)
    assert.equal(await readFile(path, 'utf8'), text)
    assert.equal(await exists(file), false)

    // Reported once: the file is gone, so reading again finds nothing to report.
    assert.deepEqual(await records.children('s1'), [])
    assert.equal(corrupt.length, 1)
    // The count starts again from what is recorded, and a write makes a good file.
    const fresh = await records.addChild('s1', newChild('c3'))
    assert.equal(fresh.n, 1)
    assert.deepEqual((await records.children('s1')).map(child => child.id), ['c3'])
    assert.equal(corrupt.length, 1)
    assert.deepEqual((await readdir(dir)).filter(name => name.startsWith('children.json')).length, 2)
  })
}

test('a corrupt children.json found through a child id is reported under the session directory\'s name, and the run is not filed', async () => {
  const { records, directory, corrupt } = await fixture()
  await records.addChild('s1', newChild('c1'))
  const file = join(sessionDir(directory, 's1'), 'children.json')
  await writeFile(file, 'garbage')
  assert.equal(await records.endRun('c1', { stopReason: 'completed', closing: 'x' }), undefined)
  assert.equal(corrupt.length, 1)
  assert.equal(corrupt[0]![0], sha('s1'))
  assert.equal(await exists(file), false)
  // Nothing was written for it: the old file is aside, and there is no new empty one.
  assert.deepEqual((await readdir(sessionDir(directory, 's1'))).filter(name => !name.startsWith('children.json.corrupt-')), [])
})

test('after a corrupt file the reports from before are not overwritten by the new numbering', async () => {
  const { records, directory } = await fixture()
  await records.addChild('s1', newChild('c1'))
  await records.endRun('c1', { stopReason: 'completed', closing: 'the old report' })
  await writeFile(join(sessionDir(directory, 's1'), 'children.json'), 'garbage')
  await records.addChild('s1', newChild('c9'))
  const ended = await records.endRun('c9', { stopReason: 'completed', closing: 'the new report' })
  const dir = sessionDir(directory, 's1')
  assert.notEqual(ended!.report, join(dir, '1-coder-1.md'))
  assert.equal(await readFile(join(dir, '1-coder-1.md'), 'utf8'), 'the old report\n')
  assert.equal(await readFile(ended!.report, 'utf8'), 'the new report\n')
  assert.equal((await records.children('s1'))[0]!.runs[0]!.report, ended!.report)
})

test('a callback that throws does not stop the record from starting fresh', async () => {
  const directory = await tempDir()
  const records = new CrewRecords(directory, () => { throw new Error('the logger broke') })
  await records.addChild('s1', newChild('c1'))
  await writeFile(join(sessionDir(directory, 's1'), 'children.json'), 'garbage')
  assert.deepEqual(await records.children('s1'), [])
  assert.equal((await records.addChild('s1', newChild('c2'))).n, 1)
})

test('with no callback, corruption is still set aside', async () => {
  const directory = await tempDir()
  const records = new CrewRecords(directory)
  await records.addChild('s1', newChild('c1'))
  await writeFile(join(sessionDir(directory, 's1'), 'children.json'), 'garbage')
  assert.deepEqual(await records.children('s1'), [])
})

// --- concurrency ----------------------------------------------------------------------------------

test('concurrent additions to one session lose no entry, and n is never used twice', async () => {
  const { records, directory } = await fixture()
  const ids = Array.from({ length: 25 }, (_, index) => `c${index}`)
  const added = await Promise.all(ids.map(id => records.addChild('s1', newChild(id))))
  assert.deepEqual(added.map(child => child.n).sort((a, b) => a - b), ids.map((_, index) => index + 1))
  const listed = await records.children('s1')
  assert.deepEqual(listed.map(child => child.id).sort(), [...ids].sort())
  assert.deepEqual(listed.map(child => child.n), ids.map((_, index) => index + 1))
  for (const id of ids) assert.equal((await records.lookup(id))?.sessionId, 's1')
  assert.ok((await readdir(join(directory, 'by-child'))).length === ids.length)
})

test('concurrent runs, follow-ups and additions in one session lose nothing', async () => {
  const { records, directory } = await fixture()
  await Promise.all(['a', 'b', 'c'].map(id => records.addChild('s1', newChild(id))))
  const jobs: Array<Promise<unknown>> = []
  for (let round = 0; round < 5; round++) {
    for (const id of ['a', 'b', 'c']) {
      jobs.push(records.addFollowUp(id))
      jobs.push(records.endRun(id, { stopReason: 'completed', closing: `${id} ${round}` }))
    }
    jobs.push(records.addChild('s1', newChild(`late${round}`)))
  }
  await Promise.all(jobs)
  const listed = await records.children('s1')
  assert.equal(listed.length, 3 + 5)
  for (const child of listed.slice(0, 3)) {
    assert.equal(child.followUps, 5, child.id)
    assert.equal(child.runs.length, 5, child.id)
    assert.deepEqual(child.runs.map(run => run.report.split('/').pop()).sort(),
      [1, 2, 3, 4, 5].map(run => `${child.n}-coder-${run}.md`))
    for (const run of child.runs) assert.match(await readFile(run.report, 'utf8'), new RegExp(`^${child.id} \\d\\n$`))
  }
  assert.equal(new Set(listed.map(child => child.n)).size, 8)
  assert.ok((await readdir(sessionDir(directory, 's1'))).every(name => !name.endsWith('.tmp')))
})

test('different sessions are written at the same time, each as it should be', async () => {
  const { records } = await fixture()
  const sessions = ['s1', 's2', 's3', 's4']
  await Promise.all(sessions.flatMap(session => ['a', 'b', 'c'].map(id => records.addChild(session, newChild(`${session}-${id}`)))))
  await Promise.all(sessions.map(async (session) => {
    const listed = await records.children(session)
    assert.deepEqual(listed.map(child => child.id).sort(), ['a', 'b', 'c'].map(id => `${session}-${id}`))
    assert.deepEqual(listed.map(child => child.n), [1, 2, 3])
  }))
})

test('a read waits for the writes before it, so it sees them', async () => {
  const { records } = await fixture()
  const pending = records.addChild('s1', newChild('c1'))
  const listed = records.children('s1')
  await pending
  assert.equal((await listed).length, 1)
})

test('flush waits for the writes in flight, and is quick when there are none', async () => {
  const { records, directory } = await fixture()
  await records.flush()
  void records.addChild('s1', newChild('c1'))
  void records.addChild('s2', newChild('c2'))
  await records.flush()
  assert.ok(await exists(join(sessionDir(directory, 's1'), 'children.json')))
  assert.ok(await exists(join(sessionDir(directory, 's2'), 'children.json')))
})

// --- status ---------------------------------------------------------------------------------------

test('every stop reason dsh has maps to a status: completed finishes, error fails, aborted stops, and the rest is told apart', () => {
  assert.deepEqual({ ...STOP_REASON_STATUS }, {
    completed: 'finished',
    aborted: 'stopped',
    error: 'failed',
    'max-tokens': 'stopped',
    refusal: 'failed',
  })
  for (const [reason, status] of Object.entries(STOP_REASON_STATUS)) assert.equal(statusFor(reason), status, reason)
})

test('a stop reason nobody mapped is stopped, never finished, and the names on the object\'s prototype are not reasons', () => {
  for (const reason of ['', 'timeout', 'COMPLETED', 'cancelled', 'toString', 'constructor', '__proto__', 'hasOwnProperty']) {
    assert.equal(statusFor(reason), 'stopped', reason)
  }
})

test('each stop reason, as a run ends with it, sets last and keeps the raw reason', async () => {
  const { records } = await fixture()
  const reasons = [...Object.keys(STOP_REASON_STATUS), 'something-new']
  for (const reason of reasons) await records.addChild('s1', newChild(`c-${reason}`))
  for (const reason of reasons) await records.endRun(`c-${reason}`, { stopReason: reason, closing: reason })
  const listed = await records.children('s1')
  assert.deepEqual(listed.map(child => [child.runs[0]!.stopReason, child.last]), [
    ['completed', 'finished'], ['aborted', 'stopped'], ['error', 'failed'], ['max-tokens', 'stopped'], ['refusal', 'failed'], ['something-new', 'stopped'],
  ])
})

// --- pruning --------------------------------------------------------------------------------------

/** A session with a child, a run and so a report, its files all `ageMs` old. */
async function oldSession(records: CrewRecords, directory: string, session: string, ageMs: number): Promise<string> {
  await records.addChild(session, newChild(`${session}-child`))
  await records.endRun(`${session}-child`, { stopReason: 'completed', closing: 'x' })
  const dir = sessionDir(directory, session)
  for (const name of await readdir(dir)) await age(join(dir, name), ageMs)
  return dir
}

test('prune removes the sessions whose newest file is older than the cutoff, with their pointers, and keeps the rest', async () => {
  const { records, directory } = await fixture()
  const old = await oldSession(records, directory, 'old', 200 * DAY)
  const recent = await oldSession(records, directory, 'recent', 10 * DAY)
  const touched = await oldSession(records, directory, 'touched', 200 * DAY)
  // One new file keeps a session, whatever the rest.
  await writeFile(join(touched, 'extra.md'), 'new')
  assert.equal(await records.prune(180 * DAY), 1)
  assert.equal(await exists(old), false)
  assert.equal(await exists(recent), true)
  assert.equal(await exists(touched), true)
  assert.deepEqual((await readdir(join(directory, 'sessions'))).sort(), [sha('recent'), sha('touched')].sort())
  assert.deepEqual((await readdir(join(directory, 'by-child'))).sort(), [sha('recent-child'), sha('touched-child')].sort())
  assert.equal(await records.lookup('old-child'), undefined)
  assert.equal(await records.endRun('old-child', { stopReason: 'completed', closing: 'x' }), undefined)
  assert.deepEqual((await records.lookup('recent-child'))?.sessionId, 'recent')
  assert.equal(await records.prune(180 * DAY), 0)
})

test('a pruned session can start again, and a child of it is one more child 1', async () => {
  const { records, directory } = await fixture()
  await oldSession(records, directory, 's1', 300 * DAY)
  await records.prune(180 * DAY)
  assert.deepEqual(await records.children('s1'), [])
  assert.equal((await records.addChild('s1', newChild('again'))).n, 1)
})

test('prune keeps a session with a temp file under the grace hour, however old the rest is, and takes a stale one', async () => {
  const { records, directory } = await fixture()
  const writing = await oldSession(records, directory, 'writing', 200 * DAY)
  const stray = await oldSession(records, directory, 'stray', 200 * DAY)
  const tempName = (seed: string) => `.children.json.${seed.repeat(16)}.tmp`
  await writeFile(join(writing, tempName('a')), 'half')
  await age(join(writing, tempName('a')), HOUR / 2)
  await writeFile(join(stray, tempName('b')), 'half')
  await age(join(stray, tempName('b')), 2 * HOUR)
  assert.equal(await records.prune(180 * DAY), 1)
  // `writing` is a write in progress; `stray` is a crash's leftover, and its session is old.
  assert.equal(await exists(writing), true)
  assert.equal(await exists(stray), false)
  // Under any cutoff, a fresh temp file protects its session, and nothing else does.
  assert.equal(await records.prune(0), 0)
  assert.equal(await exists(writing), true)
  assert.equal(await exists(join(writing, tempName('a'))), true)
})

test('prune takes a stale temp file out of a session it keeps, and leaves what is not a temp file', async () => {
  const { records, directory } = await fixture()
  const dir = await oldSession(records, directory, 'live', DAY)
  const stale = `.1-coder-1.md.${'c'.repeat(16)}.tmp`
  const fresh = `.1-coder-2.md.${'d'.repeat(16)}.tmp`
  const lookalike = '.hidden.tmp'
  for (const name of [stale, fresh, lookalike]) await writeFile(join(dir, name), 'x')
  await age(join(dir, stale), TEMP_GRACE_MS + 1000)
  await age(join(dir, fresh), 60 * 1000)
  await age(join(dir, lookalike), 5 * HOUR)
  assert.equal(await records.prune(180 * DAY), 0)
  assert.equal(await exists(join(dir, stale)), false)
  assert.equal(await exists(join(dir, fresh)), true)
  assert.equal(await exists(join(dir, lookalike)), true)
})

test('prune takes a pointer whose session is gone once it is old enough to be a crash\'s, and not before', async () => {
  const { records, directory } = await fixture()
  const pointers = join(directory, 'by-child')
  await mkdir(pointers, { recursive: true })
  const gone = sha('gone-session')
  await writeFile(join(pointers, sha('dangling-old')), gone)
  await writeFile(join(pointers, sha('dangling-new')), gone)
  await writeFile(join(pointers, sha('not-a-pointer')), 'not a hash at all')
  await age(join(pointers, sha('dangling-old')), 2 * HOUR)
  await age(join(pointers, sha('not-a-pointer')), 2 * HOUR)
  const stray = `.${sha('x')}.${'e'.repeat(16)}.tmp`
  await writeFile(join(pointers, stray), 'x')
  await age(join(pointers, stray), 2 * HOUR)
  await records.prune(180 * DAY)
  assert.deepEqual((await readdir(pointers)).sort(), [sha('dangling-new'), sha('not-a-pointer')].sort())
})

test('prune leaves what is not a session or a pointer, and does not follow a link', { skip: process.platform === 'win32' }, async () => {
  const { records, directory } = await fixture()
  const outside = await tempDir()
  await writeFile(join(outside, 'precious.txt'), 'x')
  await age(join(outside, 'precious.txt'), 400 * DAY)
  await mkdir(join(directory, 'sessions'), { recursive: true })
  await mkdir(join(directory, 'by-child'), { recursive: true })
  await symlink(outside, join(directory, 'sessions', sha('linked')))
  await mkdir(join(directory, 'sessions', 'notes'))
  await writeFile(join(directory, 'sessions', 'README.txt'), 'hi')
  await writeFile(join(directory, 'by-child', 'README.txt'), 'hi')
  await writeFile(join(directory, 'top.txt'), 'hi')
  for (const path of [join(directory, 'sessions', 'notes'), join(directory, 'sessions', 'README.txt'), join(directory, 'by-child', 'README.txt')]) await age(path, 400 * DAY)
  assert.equal(await records.prune(DAY), 0)
  assert.equal(await exists(join(outside, 'precious.txt')), true)
  assert.deepEqual((await readdir(join(directory, 'sessions'))).sort(), ['README.txt', 'notes', sha('linked')].sort())
  assert.deepEqual(await readdir(join(directory, 'by-child')), ['README.txt'])
  assert.ok(await exists(join(directory, 'top.txt')))
})

test('prune of a directory that is not there is nothing to do', async () => {
  const directory = join(await tempDir(), 'not', 'made', 'yet')
  assert.equal(await new CrewRecords(directory).prune(DAY), 0)
  await mkdir(directory, { recursive: true })
  assert.equal(await new CrewRecords(directory).prune(DAY), 0)
})

test('prune refuses an age that is not 0 or more, because NaN or a negative one would take every session', async () => {
  const { records, directory } = await fixture()
  const dir = await oldSession(records, directory, 's1', 400 * DAY)
  for (const bad of [Number.NaN, -1, -Infinity, undefined as never, '1' as never, null as never]) {
    await assert.rejects(records.prune(bad), RangeError, String(bad))
  }
  assert.equal(await exists(dir), true)
  // Infinity is a cutoff nothing is older than; 0 takes whatever has no fresh temp file.
  assert.equal(await records.prune(Infinity), 0)
  assert.equal(await records.prune(0), 1)
  assert.equal(await exists(dir), false)
})

test('an empty session directory goes when its own mtime is old, and not before', async () => {
  const { records, directory } = await fixture()
  await records.addChild('keep', newChild('k'))
  const empty = sessionDir(directory, 'empty')
  await mkdir(empty, { recursive: true })
  assert.equal(await records.prune(DAY), 0)
  await age(empty, 3 * DAY)
  assert.equal(await records.prune(DAY), 1)
  assert.equal(await exists(empty), false)
})

test('closingOf keeps the text blocks that have something in them, whole, and joins them with a blank line', () => {
  assert.equal(closingOf([
    { type: 'reasoning', text: 'thinking' },
    { type: 'text', text: '  first\n' },
    { type: 'tool_use', id: 't', name: 'read', input: {} },
    { type: 'text', text: ' \n ' },
    { type: 'text', text: '' },
    { type: 'text', text: 'second' },
    { type: 'text', text: 7 },
    null,
  ]), '  first\n\n\nsecond')
  assert.equal(closingOf([]), '')
  assert.equal(closingOf(undefined), '')
  assert.equal(closingOf('not blocks'), '')
})

test('reportContent is what a report holds: the closing text with one newline at the end, or a line that says there is none', () => {
  assert.equal(reportContent('Done.'), 'Done.\n')
  assert.equal(reportContent('Done.\n'), 'Done.\n')
  assert.equal(reportContent('Done.\n\n'), 'Done.\n\n')
  assert.equal(reportContent(''), '(no closing message)\n')
  assert.equal(reportContent('  \n '), '(no closing message)\n')
})

test('endRun writes reportContent of the closing message', async () => {
  const { records } = await fixture()
  await records.addChild('s1', newChild('c1'))
  await records.addChild('s1', newChild('c2'))
  const a = await records.endRun('c1', { stopReason: 'completed', closing: 'Text\nmore' })
  const b = await records.endRun('c2', { stopReason: 'completed', closing: ' \n' })
  assert.equal(await readFile(a!.report, 'utf8'), reportContent('Text\nmore'))
  assert.equal(await readFile(b!.report, 'utf8'), reportContent(''))
})

// --- gates ----------------------------------------------------------------------------------------

const TREE_GATED = '/work/acme/widget/.worktrees/fix-1'

/** A whole child record, for `latestGate`: running, with no runs, unless `overrides` says otherwise. */
function childRecord(overrides: Partial<ChildRecord> = {}): ChildRecord {
  return {
    id: 'c1', n: 1, role: 'coder', title: 'add login', model: 'claude-sonnet-5.5', family: 'anthropic', worktree: TREE_GATED,
    startedAt: STARTED, followUps: 0, runs: [], last: 'running', ...overrides,
  }
}

test('addGate keeps a running child\'s results on the child, in order, and they are still there after a restart', async () => {
  const { records, directory } = await fixture()
  await records.addChild('s1', newChild('c1', { worktree: TREE_GATED }))
  const failed = gate()
  const passed = gate({ round: 2, outcome: 'passed', exitCode: 0, excerpt: '# pass 12', log: '/state/dish/gates/acme/widget/fix-1/c1-1-2.log', at: STARTED + 2000 })
  assert.equal(await records.addGate('c1', failed), true)
  assert.equal(await records.addGate('c1', passed), true)
  const found = await records.lookup('c1')
  assert.deepEqual(found?.record.gates, [failed, passed])
  // The run is still in progress: nothing is filed, and the child is running as it was.
  assert.deepEqual(found?.record.runs, [])
  assert.equal(found?.record.last, 'running')
  assert.equal(found?.record.worktree, TREE_GATED)
  const { records: restarted, corrupt } = reopen(directory)
  assert.deepEqual((await restarted.lookup('c1'))?.record.gates, [failed, passed])
  assert.deepEqual(corrupt, [])
})

test('addGate stores a copy, with only a gate\'s own fields, and a reason only when there is one', async () => {
  const { records } = await fixture()
  await records.addChild('s1', newChild('c1', { worktree: TREE_GATED }))
  const given = { ...gate({ outcome: 'error', command: '', exitCode: null, log: null, excerpt: '', reason: 'dish-workspaces isn\'t running' }), extra: 'dropped' }
  const adding = records.addGate('c1', given)
  given.reason = 'changed afterwards'
  assert.equal(await adding, true)
  const [stored] = (await records.lookup('c1'))!.record.gates!
  assert.ok(!('extra' in stored!))
  assert.equal(stored!.reason, 'dish-workspaces isn\'t running')
  assert.equal(stored!.log, null)
  assert.equal(stored!.exitCode, null)
  await records.addGate('c1', gate({ round: 2 }))
  const second = (await records.lookup('c1'))!.record.gates![1]!
  assert.ok(!('reason' in second))
  // What a lookup gives is a copy too.
  const looked = await records.lookup('c1')
  looked!.record.gates![0]!.outcome = 'passed'
  assert.equal((await records.lookup('c1'))!.record.gates![0]!.outcome, 'error')
})

test('endRun moves the run\'s gate results onto the run it files, and the next run starts with none', async () => {
  const { records, directory } = await fixture()
  await records.addChild('s1', newChild('c1', { worktree: TREE_GATED }))
  const first = gate()
  const second = gate({ round: 2, outcome: 'passed', exitCode: 0 })
  await records.addGate('c1', first)
  await records.addGate('c1', second)
  await records.endRun('c1', { stopReason: 'completed', closing: 'done' })
  let record = (await records.lookup('c1'))!.record
  assert.ok(!('gates' in record), JSON.stringify(record))
  assert.deepEqual(record.runs[0]!.gates, [first, second])
  assert.deepEqual(latestGate(record), second)

  // A follow-up's run, gated once in its own turn: its run holds that result and no other, and the first run keeps its own.
  await records.addFollowUp('c1')
  record = (await records.lookup('c1'))!.record
  assert.ok(!('gates' in record))
  const third = gate({ turn: 2, at: STARTED + 9000 })
  await records.addGate('c1', third)
  await records.endRun('c1', { stopReason: 'completed', closing: 'fixed' })
  record = (await records.lookup('c1'))!.record
  assert.deepEqual(record.runs.map(run => run.gates), [[first, second], [third]])

  // A run with no gate result is filed without the field.
  await records.addFollowUp('c1')
  await records.endRun('c1', { stopReason: 'aborted', closing: '' })
  record = (await records.lookup('c1'))!.record
  assert.ok(!('gates' in record.runs[2]!), JSON.stringify(record.runs[2]))
  assert.equal(latestGate(record), undefined)

  // And on disk, after a restart.
  const file = JSON.parse(await readFile(join(sessionDir(directory, 's1'), 'children.json'), 'utf8'))
  assert.ok(!('gates' in file.children[0]))
  const { records: restarted } = reopen(directory)
  assert.deepEqual((await restarted.lookup('c1'))!.record.runs.map(run => run.gates), [[first, second], [third], undefined])
})

test('a run that ends between two gates: the gate after it goes on the next run, not the one that ended', async () => {
  const { records } = await fixture()
  await records.addChild('s1', newChild('c1', { worktree: TREE_GATED }))
  await records.addGate('c1', gate())
  await records.endRun('c1', { stopReason: 'error', error: 'the model went away', closing: '' })
  await records.startRun('c1')
  const next = gate({ turn: 2, outcome: 'passed', exitCode: 0 })
  await records.addGate('c1', next)
  const record = (await records.lookup('c1'))!.record
  assert.deepEqual(record.runs[0]!.gates, [gate()])
  assert.deepEqual(record.gates, [next])
})

test('addGate for a child that is not recorded is false and writes nothing, whatever the id', async () => {
  const { records, directory } = await fixture()
  assert.equal(await records.addGate('nobody', gate()), false)
  assert.equal(await records.addGate('', gate()), false)
  assert.equal(await records.addGate(undefined as never, gate()), false)
  assert.equal(await exists(join(directory, 'sessions')), false)
  assert.equal(await exists(join(directory, 'by-child')), false)
})

/** Gate results that are not one, each with the field its problem names. */
const BAD_GATES: Array<[string, unknown]> = [
  ['outcome', { ...gate(), outcome: 'maybe' }],
  ['round', gate({ round: 0 })],
  ['round', gate({ round: 1.5 })],
  ['turn', (({ turn: _turn, ...rest }) => rest)(gate())],
  ['turn', gate({ turn: -1 })],
  ['maxRounds', gate({ maxRounds: 0 })],
  ['excerpt', { ...gate(), excerpt: 5 }],
  ['command', { ...gate(), command: undefined }],
  ['exitCode', { ...gate(), exitCode: '1' }],
  ['exitCode', gate({ exitCode: Number.NaN })],
  ['timedOut', { ...gate(), timedOut: 'no' }],
  ['durationMs', gate({ durationMs: Number.POSITIVE_INFINITY })],
  ['log', { ...gate(), log: 5 }],
  ['log', (({ log: _log, ...rest }) => rest)(gate())],
  ['reason', { ...gate(), reason: null }],
  ['at', { ...gate(), at: 'now' }],
  ['an object', null],
  ['an object', 'failed'],
  ['an object', [gate()]],
]

test('gateProblem says what is wrong with a gate result, and nothing for one that is right', () => {
  assert.equal(gateProblem(gate()), undefined)
  for (const outcome of GATE_OUTCOMES) assert.equal(gateProblem(gate({ outcome })), undefined, outcome)
  assert.deepEqual([...GATE_OUTCOMES], ['passed', 'failed', 'skipped', 'error'])
  assert.equal(gateProblem(gate({ exitCode: null, log: null, command: '', excerpt: '', reason: 'not gated: x' })), undefined)
  // A round past maxRounds is a result dish-gates can record (a worktree that stopped resolving after the last round).
  assert.equal(gateProblem(gate({ round: 4, maxRounds: 3, outcome: 'error' })), undefined)
  for (const [field, value] of BAD_GATES) {
    const problem = gateProblem(value)
    assert.equal(typeof problem, 'string', JSON.stringify(value))
    assert.ok(problem!.includes(field), `${problem} should name ${field}`)
  }
})

test('a malformed gate result is a TypeError, and the record is left byte for byte', async () => {
  const { records, directory } = await fixture()
  await records.addChild('s1', newChild('c1', { worktree: TREE_GATED }))
  await records.addGate('c1', gate())
  const file = join(sessionDir(directory, 's1'), 'children.json')
  const before = await readFile(file)
  const { mtimeMs } = await stat(file)
  for (const [field, value] of BAD_GATES) {
    await assert.rejects(records.addGate('c1', value as GateResult), (error: unknown) => {
      assert.ok(error instanceof TypeError, String(error))
      assert.match(error.message, /^addGate needs a gate result: /)
      assert.ok(error.message.includes(field), error.message)
      return true
    })
  }
  // Refused before anything was looked up: a child nobody recorded is refused the same way.
  await assert.rejects(records.addGate('nobody', { ...gate(), outcome: 'maybe' } as unknown as GateResult), TypeError)
  assert.deepEqual(await readFile(file), before)
  assert.equal((await stat(file)).mtimeMs, mtimeMs)
  assert.deepEqual((await readdir(sessionDir(directory, 's1'))).filter(name => name.endsWith('.tmp')), [])
})

test('a children.json written before gates existed still parses: no gates, no gateOverride, and runs without them', async () => {
  const { records, directory, corrupt } = await fixture()
  const dir = sessionDir(directory, 's1')
  await mkdir(dir, { recursive: true })
  const old = {
    sessionId: 's1',
    children: [
      {
        id: 'c1', n: 1, role: 'coder', title: 'add login', model: 'claude-sonnet-5.5', family: 'anthropic', worktree: TREE_GATED,
        startedAt: STARTED, followUps: 0, runs: [{ endedAt: STARTED + 1, stopReason: 'completed', report: '/r/1-coder-1.md' }], last: 'finished',
      },
      { id: 'c2', n: 2, role: 'reviewer', title: 'review', model: 'gpt-5.6-sol', family: 'openai', reviews: 'c1', startedAt: STARTED, followUps: 0, runs: [], last: 'running' },
    ],
  }
  await writeFile(join(dir, 'children.json'), JSON.stringify(old))
  const [coder, reviewer] = await records.children('s1')
  assert.deepEqual(corrupt, [])
  assert.ok(!('gates' in coder!))
  assert.ok(!('gates' in coder!.runs[0]!))
  assert.ok(!('gateOverride' in reviewer!))
  assert.equal(latestGate(coder!), undefined)
})

test('a ruling recorded before its time was kept still parses, with no gateOverrideAt; one with it keeps it', async () => {
  const { records, directory, corrupt } = await fixture()
  const dir = sessionDir(directory, 's1')
  await mkdir(dir, { recursive: true })
  const reviewer = { role: 'reviewer', title: 'review', model: 'gpt-5.6-sol', family: 'openai', reviews: 'c0', startedAt: STARTED, followUps: 1, runs: [], last: 'running' }
  await writeFile(join(dir, 'children.json'), JSON.stringify({
    sessionId: 's1',
    children: [
      { id: 'r1', n: 1, ...reviewer, gateOverride: 'Ruling: a — b — c' },
      { id: 'r2', n: 2, ...reviewer, gateOverride: 'Ruling: d — e — f', gateOverrideAt: STARTED + 5000 },
    ],
  }))
  const [old, stamped] = await records.children('s1')
  assert.deepEqual(corrupt, [])
  assert.equal(old!.gateOverride, 'Ruling: a — b — c')
  assert.ok(!('gateOverrideAt' in old!))
  assert.equal(stamped!.gateOverrideAt, STARTED + 5000)
})

test('a gate\'s unknown fields are dropped when the record is read, on the child and on a run', async () => {
  const { records, directory, corrupt } = await fixture()
  await records.addChild('s1', newChild('c1', { worktree: TREE_GATED }))
  await records.endRun('c1', { stopReason: 'completed', closing: 'x' })
  const file = join(sessionDir(directory, 's1'), 'children.json')
  const good = JSON.parse(await readFile(file, 'utf8'))
  good.children[0].runs[0].gates = [{ ...gate(), later: 1 }]
  good.children[0].gates = [{ ...gate({ turn: 2 }), later: 2 }]
  await writeFile(file, JSON.stringify(good))
  const record = (await records.lookup('c1'))!.record
  assert.deepEqual(corrupt, [])
  assert.deepEqual(record.runs[0]!.gates, [gate()])
  assert.deepEqual(record.gates, [gate({ turn: 2 })])
})

test('latestGate: the run in progress\'s last result, else the latest run\'s last, else none', () => {
  const a = gate({ turn: 1, round: 1 })
  const b = gate({ turn: 1, round: 2, outcome: 'passed', exitCode: 0 })
  const c = gate({ turn: 2, round: 1 })
  const run = (gates?: GateResult[]) => ({ endedAt: STARTED, stopReason: 'completed', report: '/r.md', ...gates === undefined ? {} : { gates } })
  // The run in progress is newer than any run that ended.
  assert.equal(latestGate(childRecord({ gates: [a, c], runs: [run([b])] })), c)
  // With none in progress (or an empty list), the latest run's last.
  assert.equal(latestGate(childRecord({ runs: [run([c]), run([a, b])], last: 'finished' })), b)
  assert.equal(latestGate(childRecord({ gates: [], runs: [run([a, b])], last: 'finished' })), b)
  // The latest run had none: an older run's result isn't this run's.
  assert.equal(latestGate(childRecord({ runs: [run([b]), run()], last: 'failed' })), undefined)
  // A run in progress with no result yet (a fix round, or one left running by a restart) has none, not the last run's pass.
  assert.equal(latestGate(childRecord({ last: 'running', runs: [run([b])] })), undefined)
  assert.equal(latestGate(childRecord({ last: 'running', gates: [c], runs: [run([b])] })), c)
  assert.equal(latestGate(childRecord()), undefined)
  assert.equal(latestGate(childRecord({ runs: [run([])] })), undefined)
})

test('addChild records a gateOverride when it is given, and none when it is not', async () => {
  const { records, directory } = await fixture()
  const ruling = 'Ruling: review it anyway — the failing test is a known flake — a real bug slips through'
  const reviewer = await records.addChild('s1', newChild('r1', { role: 'reviewer', reviews: 'c1', gateOverride: ruling }))
  assert.equal(reviewer.gateOverride, ruling)
  // The ruling's time is the child's: it was given when the reviewer was recorded.
  assert.equal(reviewer.gateOverrideAt, STARTED)
  const plain = await records.addChild('s1', newChild('r2', { role: 'reviewer', reviews: 'c1' }))
  assert.ok(!('gateOverride' in plain))
  assert.ok(!('gateOverrideAt' in plain))
  const { records: restarted } = reopen(directory)
  assert.equal((await restarted.lookup('r1'))!.record.gateOverride, ruling)
  assert.equal((await restarted.lookup('r1'))!.record.gateOverrideAt, STARTED)
  assert.ok(!('gateOverride' in (await restarted.lookup('r2'))!.record))
  for (const gateOverride of [5, null, ['Ruling: x']]) {
    await assert.rejects(records.addChild('s1', { ...newChild('r3'), gateOverride } as unknown as NewChild), /gateOverride must be a string/, String(gateOverride))
  }
  assert.equal(await records.lookup('r3'), undefined)
})

test('addFollowUp with a gateOverride records the ruling, a later one replaces it, and one without keeps it', async () => {
  const { records, directory } = await fixture()
  await records.addChild('s1', newChild('r1', { role: 'reviewer', reviews: 'c1' }))
  await records.endRun('r1', { stopReason: 'completed', closing: 'LGTM' })
  const before1 = Date.now()
  await records.addFollowUp('r1', { gateOverride: 'Ruling: first — why — cost' })
  let record = (await records.lookup('r1'))!.record
  assert.equal(record.gateOverride, 'Ruling: first — why — cost')
  // Stamped when the follow-up recorded it.
  assert.ok(record.gateOverrideAt! >= before1 && record.gateOverrideAt! <= Date.now(), String(record.gateOverrideAt))
  assert.equal(record.followUps, 1)
  assert.equal(record.last, 'running')
  await new Promise(resolve => setTimeout(resolve, 5))
  const before2 = Date.now()
  await records.addFollowUp('r1', { gateOverride: 'Ruling: second — why — cost' })
  const second = (await records.lookup('r1'))!.record.gateOverrideAt!
  assert.ok(second >= before2 && second > record.gateOverrideAt!, String(second))
  await records.addFollowUp('r1')
  await records.addFollowUp('r1', {})
  record = (await records.lookup('r1'))!.record
  assert.equal(record.gateOverride, 'Ruling: second — why — cost')
  assert.equal(record.gateOverrideAt, second, 'a follow-up without a ruling keeps the time of the one it keeps')
  assert.equal(record.followUps, 4)
  // Not a string: refused before anything is written.
  const file = join(sessionDir(directory, 's1'), 'children.json')
  const before = await readFile(file)
  await assert.rejects(records.addFollowUp('r1', { gateOverride: 5 as unknown as string }), /gateOverride must be a string/)
  assert.deepEqual(await readFile(file), before)
  // A child that is not recorded is still ignored.
  await records.addFollowUp('nobody', { gateOverride: 'Ruling: x — y — z' })
})

test('addGate and addFollowUp made at once both land, with each other and with another child\'s', async () => {
  const { records } = await fixture()
  await records.addChild('s1', newChild('c1', { worktree: TREE_GATED }))
  await records.addChild('s1', newChild('r1', { role: 'reviewer', reviews: 'c1' }))
  const results = [1, 2, 3, 4, 5].map(round => gate({ round, maxRounds: 5 }))
  await Promise.all([
    ...results.map(result => records.addGate('c1', result)),
    records.addFollowUp('c1'),
    records.addFollowUp('r1', { gateOverride: 'Ruling: go — flake — a bug' }),
    records.addFollowUp('c1'),
  ])
  const coder = (await records.lookup('c1'))!.record
  const reviewer = (await records.lookup('r1'))!.record
  assert.deepEqual([...coder.gates!].sort((x, y) => x.round - y.round), results)
  assert.equal(coder.followUps, 2)
  assert.equal(reviewer.gateOverride, 'Ruling: go — flake — a bug')
  assert.equal(reviewer.followUps, 1)
  assert.ok(!('gates' in reviewer))
})

test('the package exports the gate types and helpers', () => {
  assert.equal(crewIndex.gateProblem, gateProblem)
  assert.equal(crewIndex.latestGate, latestGate)
  const outcome: IndexGateOutcome = 'skipped'
  const result: IndexGateResult = gate({ outcome })
  assert.equal(crewIndex.gateProblem(result), undefined)
})

// --- structured reports (step 7) ------------------------------------------------------------------

const SHA = '3d412b9e0c85d50cce297dbd2bd3d3e44720aaaa'
const TOKEN = `ghp_${'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'}`

/** A coder's report with every field, unless `overrides` says otherwise. */
function coderReport(overrides: Partial<CoderReport> = {}): CoderReport {
  return {
    role: 'coder', turn: 2, at: STARTED + 5000, status: 'done', summary: 'Added the login form; the tests pass.', commits: [SHA],
    rulings: [{ what: 'kept the old route', why: 'callers use it', costIfWrong: 'one more redirect' }], concerns: ['the session store is in memory'],
    notFixed: [{ finding: 'rename x', why: 'out of scope' }], remember: ['the login test is flaky under load'], ...overrides,
  }
}

/** A reviewer's report with every field, unless `overrides` says otherwise. */
function reviewerReport(overrides: Partial<ReviewerReport> = {}): ReviewerReport {
  return {
    role: 'reviewer', turn: 1, at: STARTED + 6000, verdict: 'changes_requested', head: SHA, summary: 'One bug, one nit.',
    findings: [
      { severity: 'blocking', file: 'src/login.ts', line: 12, summary: 'off by one', fix: 'use <=' },
      { severity: 'nit', file: 'README.md', summary: 'a typo', fix: 'spell it out' },
    ],
    checks: [{ command: 'pnpm test', exitCode: 0, summary: 'all pass' }],
    addressed: [{ finding: 'the earlier race', addressed: true, evidence: 'login.ts:40 takes the lock' }],
    remember: ['the session store must stay in memory: the tests reset it'],
    ...overrides,
  }
}

/** Reports that are not one, each with the field path its problem names. */
const BAD_REPORTS: Array<[string, unknown]> = [
  ['an object', null],
  ['an object', 'done'],
  ['an object', [coderReport()]],
  ['role', { ...coderReport(), role: 'architect' }],
  ['role', (({ role: _role, ...rest }) => rest)(coderReport())],
  ['turn', coderReport({ turn: -1 })],
  ['turn', coderReport({ turn: 1.5 })],
  ['at', { ...coderReport(), at: 'now' }],
  ['at', coderReport({ at: Number.NaN })],
  ['status', { ...coderReport(), status: 'maybe' }],
  ['summary', (({ summary: _summary, ...rest }) => rest)(coderReport())],
  ['commits', { ...coderReport(), commits: SHA }],
  ['commits[1]', { ...coderReport(), commits: [SHA, 5] }],
  ['blockedOn', { ...coderReport(), blockedOn: 5 }],
  ['rulings', { ...coderReport(), rulings: {} }],
  ['rulings[0]', { ...coderReport(), rulings: ['a ruling'] }],
  ['rulings[0].costIfWrong', { ...coderReport(), rulings: [{ what: 'a', why: 'b' }] }],
  ['concerns[0]', { ...coderReport(), concerns: [null] }],
  ['notFixed[0].why', { ...coderReport(), notFixed: [{ finding: 'x', why: 3 }] }],
  ['remember', { ...coderReport(), remember: 'a pitfall' }],
  ['remember[1]', { ...coderReport(), remember: ['a pitfall', 5] }],
  ['verdict', { ...reviewerReport(), verdict: 'lgtm' }],
  ['head', { ...reviewerReport(), head: 5 }],
  ['summary', { ...reviewerReport(), summary: null }],
  ['findings', (({ findings: _findings, ...rest }) => rest)(reviewerReport())],
  ['findings[0].severity', reviewerReport({ findings: [{ severity: 'major' as never, file: 'a', summary: 'b', fix: 'c' }] })],
  ['findings[1].line', reviewerReport({ findings: [reviewerReport().findings[0]!, { severity: 'nit', file: 'a', line: 1.5, summary: 'b', fix: 'c' }] })],
  ['findings[0].file', reviewerReport({ findings: [{ severity: 'nit', summary: 'b', fix: 'c' } as never] })],
  ['findings[0].fix', reviewerReport({ findings: [{ severity: 'nit', file: 'a', summary: 'b' } as never] })],
  ['checks', { ...reviewerReport(), checks: 'pnpm test' }],
  ['checks[0].exitCode', reviewerReport({ checks: [{ command: 'pnpm test', exitCode: 'x' as never, summary: 's' }] })],
  ['addressed', { ...reviewerReport(), addressed: 'yes' }],
  ['addressed[0].addressed', reviewerReport({ addressed: [{ finding: 'f', addressed: 'yes' as never, evidence: 'e' }] })],
  ['remember', { ...reviewerReport(), remember: { pitfall: 'x' } }],
  ['remember[0]', { ...reviewerReport(), remember: [null] }],
]

test('the report enums are frozen, in their order', () => {
  assert.deepEqual([...CODER_STATUSES], ['done', 'blocked', 'needs_context'])
  assert.deepEqual([...VERDICTS], ['approved', 'changes_requested'])
  assert.deepEqual([...SEVERITIES], ['blocking', 'should_fix', 'nit'])
  for (const list of [CODER_STATUSES, VERDICTS, SEVERITIES]) assert.ok(Object.isFrozen(list))
})

test('reportProblem names each wrong field, and nothing for full and minimal reports', () => {
  assert.equal(reportProblem(coderReport()), undefined)
  assert.equal(reportProblem(reviewerReport()), undefined)
  assert.equal(reportProblem({ role: 'coder', turn: 0, at: 1, status: 'blocked', summary: '' }), undefined)
  assert.equal(reportProblem({ role: 'reviewer', turn: 0, at: 1, verdict: 'approved', head: 'HEAD', summary: ' ', findings: [] }), undefined)
  // A reviewer of work outside git gives no head.
  assert.equal(reportProblem({ role: 'reviewer', turn: 0, at: 1, verdict: 'approved', summary: 'Fine.', findings: [] }), undefined)
  // What the tool checks, the record doesn't: a blank blockedOn, the form of head, blank strings.
  assert.equal(reportProblem(coderReport({ status: 'needs_context', summary: '   ' })), undefined)
  for (const [path, value] of BAD_REPORTS) {
    const problem = reportProblem(value)
    assert.equal(typeof problem, 'string', JSON.stringify(value))
    assert.ok(problem!.startsWith(path) || path === 'an object', `${problem} should start with ${path}`)
    if (path === 'an object') assert.match(problem!, /object/)
  }
  assert.equal(reportProblem(BAD_REPORTS.find(([path]) => path === 'findings[0].severity')![1]), 'findings[0].severity must be one of blocking, should_fix, nit')
})

test('reportProblem names a remember that isn\'t a list of strings', () => {
  for (const report of [coderReport(), reviewerReport()]) {
    assert.equal(reportProblem({ ...report, remember: ['a pitfall', 'a flaky test'] }), undefined)
    assert.equal(reportProblem({ ...report, remember: [] }), undefined)
    assert.equal(reportProblem({ ...report, remember: undefined }), undefined)
    assert.equal(reportProblem({ ...report, remember: 'a pitfall' }), 'remember must be a list')
    assert.equal(reportProblem({ ...report, remember: { 0: 'a pitfall' } }), 'remember must be a list')
    assert.equal(reportProblem({ ...report, remember: ['a pitfall', 5] }), 'remember[1] must be a string')
    assert.equal(reportProblem({ ...report, remember: [{ text: 'a pitfall' }] }), 'remember[0] must be a string')
  }
  // How many there are and how long each is are the tool's checks, as blank strings are: the record takes any list of strings.
  assert.equal(reportProblem(coderReport({ remember: ['x'.repeat(1000), 'two\nlines', '', 'd', 'e', 'f'] })), undefined)
})

test('maskReport masks every string, nested ones included, and keeps the rest', () => {
  const masked = maskReport(reviewerReport({
    summary: `uses ${TOKEN}`,
    findings: [{ severity: 'blocking', file: 'src/a.ts', line: 3, summary: 'a token', fix: `remove ${TOKEN}` }],
    checks: [{ command: `curl -H "Authorization: token ${TOKEN}"`, exitCode: 0, summary: 'ok' }],
  }))
  const text = JSON.stringify(masked)
  assert.ok(!text.includes(TOKEN), text)
  assert.match((masked as ReviewerReport).summary, /^uses ‹secret/)
  assert.equal((masked as ReviewerReport).findings[0]!.line, 3)
  assert.equal((masked as ReviewerReport).checks![0]!.exitCode, 0)
  assert.equal(masked.role, 'reviewer')
  const coder = maskReport({ ...coderReport({ concerns: [TOKEN] }), extra: TOKEN } as CoderReport)
  assert.ok(!JSON.stringify(coder).includes(TOKEN))
  assert.ok(!('extra' in coder))
})

test('reportRole: a coder by its role, a reviewer by reviews, and nothing for the other roles', () => {
  assert.equal(reportRole({ role: 'coder' }), 'coder')
  assert.equal(reportRole({ role: 'reviewer', reviews: 'c1' }), 'reviewer')
  assert.equal(reportRole({ role: 'reviewer', reviews: 'main' }), 'reviewer')
  assert.equal(reportRole({ role: 'ops' }), undefined)
  assert.equal(reportRole({ role: 'writer' }), undefined)
  assert.equal(reportRole({ role: 'researcher' }), undefined)
})

test('setReport keeps a masked copy on the run in progress and gives it back; a second replaces the first; it survives a restart', async () => {
  const { records, directory } = await fixture()
  await records.addChild('s1', newChild('r1', { role: 'reviewer', reviews: 'c1' }))
  const given = reviewerReport({ summary: `found ${TOKEN}`, findings: [{ severity: 'should_fix', file: 'a.ts', summary: 'leak', fix: `revoke ${TOKEN}` }] })
  const stored = await records.setReport('r1', given)
  assert.ok(stored !== undefined)
  assert.ok(!JSON.stringify(stored).includes(TOKEN))
  assert.deepEqual(stored, maskReport(given))
  assert.deepEqual((await records.lookup('r1'))!.record.report, stored)
  assert.ok(!(await readFile(join(sessionDir(directory, 's1'), 'children.json'), 'utf8')).includes(TOKEN))
  // What it gives back is a copy.
  ;(stored as ReviewerReport).summary = 'changed'
  assert.notEqual((await records.lookup('r1'))!.record.report!.summary, 'changed')

  const second = reviewerReport({ verdict: 'approved', findings: [], summary: 'fixed' })
  await records.setReport('r1', second)
  assert.deepEqual((await records.lookup('r1'))!.record.report, second)
  const { records: restarted, corrupt } = reopen(directory)
  assert.deepEqual((await restarted.lookup('r1'))!.record.report, second)
  assert.deepEqual(corrupt, [])
})

test('setReport drops unknown fields, and the caller\'s object can\'t change what is stored', async () => {
  const { records } = await fixture()
  await records.addChild('s1', newChild('c1'))
  const given = { ...coderReport(), extra: 'dropped', rulings: [{ what: 'a', why: 'b', costIfWrong: 'c', more: 1 }] } as unknown as CoderReport
  const setting = records.setReport('c1', given)
  given.summary = 'changed afterwards'
  given.rulings![0]!.what = 'changed afterwards'
  const stored = await setting
  assert.ok(!('extra' in stored!))
  assert.deepEqual((stored as CoderReport).rulings, [{ what: 'a', why: 'b', costIfWrong: 'c' }])
  assert.equal(stored!.summary, coderReport().summary)
  // A minimal report has none of the optional fields.
  const minimal = await records.setReport('c1', { role: 'coder', turn: 0, at: 1, status: 'done', summary: 'done' })
  assert.deepEqual(minimal, { role: 'coder', turn: 0, at: 1, status: 'done', summary: 'done' })
})

test('setReport keeps remember for both roles', async () => {
  const { records, directory, corrupt } = await fixture()
  await records.addChild('s1', newChild('c1'))
  await records.addChild('s1', newChild('r1', { role: 'reviewer', reviews: 'c1' }))
  const remember = ['the e2e suite is flaky on CI', `the staging key is ${TOKEN}`]
  const expected = ['the e2e suite is flaky on CI', `the staging key is ${maskSecrets(TOKEN)}`]
  const coder = await records.setReport('c1', coderReport({ remember }))
  const reviewer = await records.setReport('r1', reviewerReport({ remember }))
  assert.deepEqual(coder!.remember, expected)
  assert.deepEqual(reviewer!.remember, expected)
  assert.ok(!JSON.stringify([coder, reviewer]).includes(TOKEN))
  // Kept in children.json, and read back after a restart.
  const again = reopen(directory)
  assert.deepEqual((await again.records.lookup('c1'))!.record.report!.remember, expected)
  assert.deepEqual((await again.records.lookup('r1'))!.record.report!.remember, expected)
  // And on the run, when it ends.
  const ended = await again.records.endRun('r1', { stopReason: 'completed', closing: 'x' })
  assert.deepEqual(ended!.run.structured!.remember, expected)
  assert.deepEqual([...corrupt, ...again.corrupt], [])
})

test('setReport for a child that is not recorded is undefined, and writes nothing', async () => {
  const { records, directory } = await fixture()
  assert.equal(await records.setReport('nobody', coderReport()), undefined)
  assert.equal(await records.setReport('', coderReport()), undefined)
  assert.equal(await exists(join(directory, 'sessions')), false)
})

test('a malformed report is a TypeError, and the record is left byte for byte', async () => {
  const { records, directory } = await fixture()
  await records.addChild('s1', newChild('c1'))
  await records.setReport('c1', coderReport())
  const file = join(sessionDir(directory, 's1'), 'children.json')
  const before = await readFile(file)
  const { mtimeMs } = await stat(file)
  const named: Array<[string, unknown]> = [
    ['role', { ...coderReport(), role: 'architect' }],
    ['status', { ...coderReport(), status: 'maybe' }],
    ['summary', (({ summary: _summary, ...rest }) => rest)(coderReport())],
    ['severity', reviewerReport({ findings: [{ severity: 'major' as never, file: 'a', summary: 'b', fix: 'c' }] })],
    ['line', reviewerReport({ findings: [{ severity: 'nit', file: 'a', line: 1.5, summary: 'b', fix: 'c' }] })],
    ['exitCode', reviewerReport({ checks: [{ command: 'x', exitCode: 'x' as never, summary: 's' }] })],
    ['addressed', reviewerReport({ addressed: [{ finding: 'f', addressed: 'yes' as never, evidence: 'e' }] })],
    ['remember', coderReport({ remember: [5 as never] })],
    ['turn', coderReport({ turn: -1 })],
  ]
  for (const [field, value] of named) {
    await assert.rejects(records.setReport('c1', value as StructuredReport), (error: unknown) => {
      assert.ok(error instanceof TypeError, String(error))
      assert.match(error.message, /^setReport needs a report: /)
      assert.ok(error.message.includes(field), error.message)
      return true
    })
  }
  await assert.rejects(records.setReport('nobody', { role: 'architect' } as never), TypeError)
  assert.deepEqual(await readFile(file), before)
  assert.equal((await stat(file)).mtimeMs, mtimeMs)
})

test('endRun writes the run\'s report as <n>-<role>-<run>.json beside the .md, and moves it onto the run', { skip: process.platform === 'win32' }, async () => {
  const { records, directory } = await fixture()
  await records.addChild('s1', newChild('c1'))
  const given = coderReport({ summary: `done with ${TOKEN}` })
  const stored = await records.setReport('c1', given)
  const ended = await records.endRun('c1', { stopReason: 'completed', closing: '' })
  const dir = sessionDir(directory, 's1')
  const json = join(dir, '1-coder-1.json')
  assert.equal(ended!.report, join(dir, '1-coder-1.md'))
  assert.equal(await readFile(json, 'utf8'), `${JSON.stringify(stored, null, 2)}\n`)
  assert.ok(!(await readFile(json, 'utf8')).includes(TOKEN))
  assert.equal((await stat(json)).mode & 0o777, 0o600)
  assert.equal(await readFile(ended!.report, 'utf8'), '(no closing message)\n')
  let record = (await records.lookup('c1'))!.record
  assert.ok(!('report' in record), JSON.stringify(record))
  assert.deepEqual(record.runs[0]!.structured, stored)
  assert.equal(record.runs[0]!.structuredFile, json)
  assert.equal(record.runs[0]!.report, ended!.report)

  // The next run starts with none, and ends with none.
  await records.addFollowUp('c1')
  await records.endRun('c1', { stopReason: 'completed', closing: 'text only' })
  record = (await records.lookup('c1'))!.record
  assert.ok(!('structured' in record.runs[1]!))
  assert.ok(!('structuredFile' in record.runs[1]!))
  assert.equal(await exists(join(dir, '1-coder-2.json')), false)
  assert.equal(await exists(join(dir, '1-coder-2.md')), true)
  // And after a restart.
  const { records: restarted, corrupt } = reopen(directory)
  assert.deepEqual((await restarted.lookup('c1'))!.record.runs[0]!.structured, stored)
  assert.deepEqual(corrupt, [])
})

test('an orphan .json takes the name: both files of the run go to the next free base', async () => {
  const { records, directory } = await fixture()
  await records.addChild('s1', newChild('c1'))
  const dir = sessionDir(directory, 's1')
  await writeFile(join(dir, '1-coder-1.json'), '{}\n')
  const ended = await records.endRun('c1', { stopReason: 'completed', closing: 'x' })
  assert.equal(ended!.report, join(dir, '1-coder-1.2.md'))
  assert.equal(await exists(join(dir, '1-coder-1.md')), false)
  // With a report as well: the next run's base is free, and the one after an orphan .md moves both.
  await writeFile(join(dir, '1-coder-2.md'), 'an orphan\n')
  await records.setReport('c1', coderReport())
  const second = await records.endRun('c1', { stopReason: 'completed', closing: 'y' })
  assert.equal(second!.report, join(dir, '1-coder-2.2.md'))
  assert.equal(second!.run.structuredFile, join(dir, '1-coder-2.2.json'))
  assert.equal(await readFile(join(dir, '1-coder-2.md'), 'utf8'), 'an orphan\n')
  assert.equal(await readFile(join(dir, '1-coder-1.json'), 'utf8'), '{}\n')
})

test('endRun keeps the notice\'s id when it is a non-empty string, and leaves out anything else', async () => {
  const { records } = await fixture()
  await records.addChild('s1', newChild('c1'))
  await records.endRun('c1', { stopReason: 'completed', closing: 'x', notice: 'msg-1' })
  await records.endRun('c1', { stopReason: 'completed', closing: 'x', notice: '' })
  await records.endRun('c1', { stopReason: 'completed', closing: 'x', notice: 5 as never })
  await records.endRun('c1', { stopReason: 'completed', closing: 'x' })
  const { runs } = (await records.lookup('c1'))!.record
  assert.equal(runs[0]!.notice, 'msg-1')
  for (const run of runs.slice(1)) assert.ok(!('notice' in run), JSON.stringify(run))
})

test('EndedRun has the session, the filed child and the run, as copies', async () => {
  const { records } = await fixture()
  await records.addChild('s1', newChild('c0'))
  await records.addChild('s1', newChild('c1', { worktree: TREE_GATED }))
  await records.addGate('c1', gate())
  await records.setReport('c1', coderReport())
  const ended = await records.endRun('c1', { stopReason: 'completed', closing: 'done', notice: 'm1' })
  const record = (await records.lookup('c1'))!.record
  assert.equal(ended!.sessionId, 's1')
  assert.deepEqual(ended!.child, record)
  assert.deepEqual(ended!.run, record.runs.at(-1))
  assert.deepEqual(ended!.run, ended!.child.runs.at(-1))
  assert.notEqual(ended!.run, ended!.child.runs.at(-1))
  assert.deepEqual(ended!.run.gates, [gate()])
  assert.equal(ended!.run.notice, 'm1')
  assert.deepEqual(ended!.run.structured, coderReport())
  ended!.child.title = 'changed'
  ended!.run.stopReason = 'changed'
  const again = (await records.lookup('c1'))!.record
  assert.equal(again.title, 'add login')
  assert.equal(again.runs[0]!.stopReason, 'completed')
})

test('setReport and endRun called at once: the report is on the run that ends', async () => {
  const { records } = await fixture()
  for (let round = 0; round < 50; round++) {
    const id = `c${round}`
    await records.addChild('s1', newChild(id))
    const [, ended] = await Promise.all([records.setReport(id, coderReport({ turn: round })), records.endRun(id, { stopReason: 'completed', closing: 'x' })])
    assert.equal(ended!.run.structured?.turn, round, `round ${round}`)
    assert.ok(!('report' in (await records.lookup(id))!.record))
  }
})

test('addChild keeps run, task and final when they are given; refuses them malformed and writes nothing', async () => {
  const { records, directory } = await fixture()
  const tagged = await records.addChild('s1', newChild('r1', { role: 'reviewer', reviews: 'c1', run: 'frostyard/snosi/20261003-fix-1', task: 'fix-1', final: true }))
  assert.equal(tagged.run, 'frostyard/snosi/20261003-fix-1')
  assert.equal(tagged.task, 'fix-1')
  assert.equal(tagged.final, true)
  const plain = await records.addChild('s1', newChild('c2'))
  for (const field of ['run', 'task', 'final', 'report'] as const) assert.ok(!(field in plain), field)
  const { records: restarted } = reopen(directory)
  assert.deepEqual((await restarted.lookup('r1'))!.record, tagged)
  for (const [field, extra] of [['final', { final: false }], ['run', { run: 7 }], ['task', { task: null }], ['final', { final: 'true' }]] as const) {
    await assert.rejects(records.addChild('s1', { ...newChild('c3'), ...extra } as unknown as NewChild), (error: unknown) => {
      assert.ok(error instanceof TypeError)
      assert.ok(error.message.includes(field), error.message)
      return true
    })
  }
  assert.match(await records.addChild('s1', { ...newChild('c3'), final: false } as unknown as NewChild).then(() => '', (error: Error) => error.message), /final must be true when it is given/)
  assert.equal(await records.lookup('c3'), undefined)
})

test('addFollowUp with final: true marks the child final; without it, final stays; final: false is a TypeError', async () => {
  const { records, directory } = await fixture()
  await records.addChild('s1', newChild('r1', { role: 'reviewer', reviews: 'c1' }))
  await records.addFollowUp('r1')
  assert.ok(!('final' in (await records.lookup('r1'))!.record))
  await records.addFollowUp('r1', { final: true })
  assert.equal((await records.lookup('r1'))!.record.final, true)
  await records.addFollowUp('r1')
  await records.addFollowUp('r1', { gateOverride: 'Ruling: a — b — c' })
  const record = (await records.lookup('r1'))!.record
  assert.equal(record.final, true)
  assert.equal(record.followUps, 4)
  const file = join(sessionDir(directory, 's1'), 'children.json')
  const before = await readFile(file)
  await assert.rejects(records.addFollowUp('r1', { final: false as never }), TypeError)
  await assert.rejects(records.addFollowUp('r1', { final: 'yes' as never }), /final must be true/)
  assert.deepEqual(await readFile(file), before)
})

test('an old children.json, from before reports, run tags and gate heads, still parses', async () => {
  const { records, directory, corrupt } = await fixture()
  const dir = sessionDir(directory, 's1')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'children.json'), JSON.stringify({
    sessionId: 's1',
    children: [{
      id: 'c1', n: 1, role: 'coder', title: 'add login', model: 'claude-sonnet-5.5', family: 'anthropic', worktree: TREE_GATED, startedAt: STARTED,
      followUps: 0, runs: [{ endedAt: STARTED + 1, stopReason: 'completed', report: '/r/1-coder-1.md', gates: [gate()] }], gates: [gate({ turn: 2 })], last: 'running',
    }],
  }))
  const [child] = await records.children('s1')
  assert.deepEqual(corrupt, [])
  for (const field of ['run', 'task', 'final', 'report'] as const) assert.ok(!(field in child!), field)
  for (const field of ['structured', 'structuredFile', 'notice'] as const) assert.ok(!(field in child!.runs[0]!), field)
  assert.ok(!('head' in child!.runs[0]!.gates![0]!))
  assert.deepEqual(child!.gates, [gate({ turn: 2 })])
})

test('a reviewer\'s report without a head (work outside git) is kept, and read back, without one', async () => {
  const { records, directory, corrupt } = await fixture()
  await records.addChild('s1', newChild('c1'))
  const { head: _head, ...headless } = reviewerReport()
  assert.deepEqual(await records.setReport('c1', headless), headless)
  const again = reopen(directory)
  assert.deepEqual((await again.records.lookup('c1'))!.record.report, headless)
  assert.deepEqual([...corrupt, ...again.corrupt], [])
})

test('a report\'s unknown fields, and a run\'s, are dropped when the record is read', async () => {
  const { records, directory, corrupt } = await fixture()
  await records.addChild('s1', newChild('c1'))
  await records.setReport('c1', coderReport())
  await records.endRun('c1', { stopReason: 'completed', closing: 'x' })
  await records.setReport('c1', reviewerReport())
  const file = join(sessionDir(directory, 's1'), 'children.json')
  const good = JSON.parse(await readFile(file, 'utf8'))
  good.children[0].runs[0].structured.later = 1
  good.children[0].runs[0].structured.rulings[0].later = 2
  good.children[0].report.findings[0].later = 3
  good.children[0].runs[0].later = 4
  await writeFile(file, JSON.stringify(good))
  const record = (await records.lookup('c1'))!.record
  assert.deepEqual(corrupt, [])
  assert.deepEqual(record.runs[0]!.structured, coderReport())
  assert.deepEqual(record.report, reviewerReport())
  assert.ok(!('later' in record.runs[0]!))
})

test('addGate keeps head, a sha or null, through a restart; a head that is not a commit id is a TypeError', async () => {
  const { records, directory } = await fixture()
  await records.addChild('s1', newChild('c1', { worktree: TREE_GATED }))
  const withSha = gate({ head: SHA })
  const withNull = gate({ round: 2, head: null })
  const long = gate({ round: 3, head: 'f'.repeat(64) })
  assert.equal(await records.addGate('c1', withSha), true)
  assert.equal(await records.addGate('c1', withNull), true)
  assert.equal(await records.addGate('c1', long), true)
  const { records: restarted } = reopen(directory)
  assert.deepEqual((await restarted.lookup('c1'))!.record.gates, [withSha, withNull, long])
  assert.equal(gateProblem(gate()), undefined, 'a gate without a head is still one')
  const file = join(sessionDir(directory, 's1'), 'children.json')
  const before = await readFile(file)
  for (const head of ['xyz', SHA.slice(0, 12), SHA.toUpperCase(), 5, ` ${SHA}`]) {
    assert.equal(gateProblem(gate({ head: head as never })), 'head must be a commit id or null', String(head))
    await assert.rejects(records.addGate('c1', gate({ head: head as never })), /^TypeError: addGate needs a gate result: head must be a commit id or null/)
  }
  assert.deepEqual(await readFile(file), before)
})

test('the package exports the report types and helpers', () => {
  assert.equal(crewIndex.reportProblem, reportProblem)
  assert.equal(crewIndex.maskReport, maskReport)
  assert.equal(crewIndex.reportRole, reportRole)
  assert.equal(crewIndex.CODER_STATUSES, CODER_STATUSES)
  assert.equal(crewIndex.VERDICTS, VERDICTS)
  assert.equal(crewIndex.SEVERITIES, SEVERITIES)
  const coder: IndexCoderReport = coderReport()
  const reviewer: IndexReviewerReport = reviewerReport()
  const either: IndexStructuredReport[] = [coder, reviewer]
  assert.ok(either.every(report => crewIndex.reportProblem(report) === undefined))
})
