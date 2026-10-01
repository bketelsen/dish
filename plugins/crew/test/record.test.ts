import { createHash } from 'node:crypto'
import { chmod, mkdir, open, readdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { CrewRecords, STOP_REASON_STATUS, TEMP_GRACE_MS, statusFor } from '../src/record.ts'
import type { ChildRecord, NewChild } from '../src/record.ts'
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

// --- runs and reports -----------------------------------------------------------------------------

test('endRun writes the closing message as a report named for the child\'s order, role and run, and records the run', async () => {
  const { records, directory } = await fixture()
  await records.addChild('s1', newChild('c0', { role: 'researcher' }))
  await records.addChild('s1', newChild('c1'))
  const before = Date.now()
  const ended = await records.endRun('c1', { stopReason: 'completed', closing: 'I added the login.\n\nTests pass.' })
  const file = join(sessionDir(directory, 's1'), '2-coder-1.md')
  assert.deepEqual(ended, { report: file })
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
  assert.deepEqual(first, { report: join(dir, '1-coder-1.md') })
  assert.deepEqual(second, { report: join(dir, '1-coder-2.md') })
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
  assert.deepEqual(ended, { report: join(sessionDir(directory, 's1'), '2-researcher-1.md') })
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
  assert.equal(child!.last, 'finished')
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
  ['a followUps that is not a number', (good) => { good.children[0].followUps = '0'; return good }],
  ['a last that is not a status', (good) => { good.children[0].last = 'paused'; return good }],
  ['runs that is not a list', (good) => { good.children[0].runs = 'none'; return good }],
  ['a run that is not an object', (good) => { good.children[0].runs = [1]; return good }],
  ['a run with an endedAt that is not finite', (good) => { good.children[0].runs[0].endedAt = 'x'; return good }],
  ['a run with a stopReason that is not a string', (good) => { good.children[0].runs[0].stopReason = 2; return good }],
  ['a run with an error that is not a string', (good) => { good.children[0].runs[0].error = {}; return good }],
  ['a run with a report that is not a string', (good) => { good.children[0].runs[0].report = null; return good }],
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

test('a stop reason nobody mapped is finished, and the names on the object\'s prototype are not reasons', () => {
  for (const reason of ['', 'timeout', 'COMPLETED', 'cancelled', 'toString', 'constructor', '__proto__', 'hasOwnProperty']) {
    assert.equal(statusFor(reason), 'finished', reason)
  }
})

test('each stop reason, as a run ends with it, sets last and keeps the raw reason', async () => {
  const { records } = await fixture()
  const reasons = [...Object.keys(STOP_REASON_STATUS), 'something-new']
  for (const reason of reasons) await records.addChild('s1', newChild(`c-${reason}`))
  for (const reason of reasons) await records.endRun(`c-${reason}`, { stopReason: reason, closing: reason })
  const listed = await records.children('s1')
  assert.deepEqual(listed.map(child => [child.runs[0]!.stopReason, child.last]), [
    ['completed', 'finished'], ['aborted', 'stopped'], ['error', 'failed'], ['max-tokens', 'stopped'], ['refusal', 'failed'], ['something-new', 'finished'],
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
