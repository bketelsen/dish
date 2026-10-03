import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { recordFile } from '../src/paths.ts'
import { RUN_STATES, RunStore, runProblem } from '../src/store.ts'
import type { Run } from '../src/store.ts'
import { HOUR, MASKED_TOKEN, newRun, NOW, run, SHA_A, tempDir, TOKEN } from './helpers.ts'

async function freshStore(options: { now?: () => number, onCorrupt?: (file: string, aside: string) => void } = {}): Promise<{ state: string, store: RunStore }> {
  const state = join(await tempDir(), 'state')
  const store = new RunStore(state, { now: () => NOW, ...options })
  await store.load()
  return { state, store }
}

test('create, then get, list, byId and drivenBy', async () => {
  const { state, store } = await freshStore()
  const created = await store.create(newRun({ plan: { path: 'docs/plans/x.md', commit: SHA_A } }))
  assert.deepEqual(created, {
    id: '20261003-fix-login',
    project: 'Acme/widget',
    slug: 'fix-login',
    goal: 'Fix the login redirect',
    plan: { path: 'docs/plans/x.md', commit: SHA_A },
    branch: 'dish/fix-login',
    worktree: '/work/Acme/widget/.worktrees/fix-login',
    base: 'origin/main',
    baseCommit: SHA_A,
    state: 'open',
    driver: { session: 'session-1', since: NOW },
    openedAt: NOW,
  })
  assert.deepEqual(store.get('Acme/widget', created.id), created)
  assert.deepEqual(store.get('acme/WIDGET', created.id), created, 'the project compared without case')
  assert.equal(store.get('Acme/other', created.id), undefined)
  assert.equal(store.get('Acme/widget', '20261003-nope'), undefined)
  assert.deepEqual(store.list(), [created])
  assert.deepEqual(store.list('ACME/widget'), [created])
  assert.deepEqual(store.list('Acme/other'), [])
  assert.deepEqual(store.byId(created.id), [created])
  assert.deepEqual(store.drivenBy('session-1'), created)
  assert.equal(store.drivenBy('session-2'), undefined)
  const onDisk = JSON.parse(await readFile(recordFile(state, 'Acme/widget', created.id), 'utf8')) as Run
  assert.deepEqual(onDisk, created)
})

test('each read gives a copy', async () => {
  const { store } = await freshStore()
  const created = await store.create(newRun())
  created.goal = 'changed by the caller'
  const got = store.get('Acme/widget', created.id)!
  assert.equal(got.goal, 'Fix the login redirect')
  got.driver.session = 'someone else'
  assert.equal(store.list()[0]!.driver.session, 'session-1')
  assert.equal(store.byId(created.id)[0]!.driver.session, 'session-1')
  assert.equal(store.drivenBy('session-1')!.driver.session, 'session-1')
})

test('list is newest openedAt first, across projects', async () => {
  const { store } = await freshStore()
  const a = await store.create(newRun({ slug: 'a', openedAt: NOW - 2 * HOUR }))
  const b = await store.create(newRun({ project: 'Acme/gadget', slug: 'b', openedAt: NOW }))
  const c = await store.create(newRun({ slug: 'c', openedAt: NOW - HOUR, driver: 'session-2' }))
  assert.deepEqual(store.list().map(one => one.id), [b.id, c.id, a.id])
  assert.deepEqual(store.list('acme/widget').map(one => one.id), [c.id, a.id])
})

test('byId gives the runs of that id in every project', async () => {
  const { store } = await freshStore()
  await store.create(newRun())
  await store.create(newRun({ project: 'Other/widget', driver: 'session-2' }))
  assert.deepEqual(store.byId('20261003-fix-login').map(one => one.project).sort(), ['Acme/widget', 'Other/widget'])
})

test('a reload on the same directory gives the same', async () => {
  const { state, store } = await freshStore()
  await store.create(newRun())
  await store.create(newRun({ slug: 'other', project: 'Acme/gadget', driver: 'session-2', openedAt: NOW + 1 }))
  await store.update('Acme/widget', '20261003-fix-login', current => ({ ...current, state: 'abandoned', reason: 'dropped', closedAt: NOW + 2, driver: { session: '', since: NOW + 2 } }))
  const again = new RunStore(state)
  await again.load()
  assert.deepEqual(again.list(), store.list())
  assert.deepEqual(again.drivenBy('session-2'), store.drivenBy('session-2'))
})

test('files are 0600 and directories 0700', async () => {
  const { state, store } = await freshStore()
  const created = await store.create(newRun())
  const file = recordFile(state, 'Acme/widget', created.id)
  assert.equal((await stat(file)).mode & 0o777, 0o600)
  for (const directory of [
    join(state, 'orchestrator'), join(state, 'orchestrator', 'Acme'), join(state, 'orchestrator', 'Acme', 'widget'),
    join(state, 'orchestrator', 'Acme', 'widget', 'runs'),
  ]) {
    assert.equal((await stat(directory)).mode & 0o777, 0o700, directory)
  }
  // Nothing but the record: the temp file was renamed into place.
  assert.deepEqual(await readdir(join(state, 'orchestrator', 'Acme', 'widget', 'runs')), [`${created.id}.json`])
})

test('two creates of one slug on one day, at once, get the id and the id with -2', async () => {
  const { store } = await freshStore()
  const [first, second] = await Promise.all([
    store.create(newRun()),
    store.create(newRun({ driver: 'session-2' })),
  ])
  assert.equal(first.id, '20261003-fix-login')
  assert.equal(second.id, '20261003-fix-login-2')
  const third = await store.create(newRun({ driver: 'session-3' }))
  assert.equal(third.id, '20261003-fix-login-3')
  // Another project has its own ids.
  const elsewhere = await store.create(newRun({ project: 'Acme/gadget', driver: 'session-4' }))
  assert.equal(elsewhere.id, '20261003-fix-login')
})

test('create takes the ids already in the directory, even ones another process wrote and ones set aside', async () => {
  const { state, store } = await freshStore()
  const runs = join(state, 'orchestrator', 'Acme', 'widget', 'runs')
  await mkdir(runs, { recursive: true })
  await writeFile(join(runs, '20261003-fix-login.json'), JSON.stringify(run()))
  await writeFile(join(runs, '20261003-fix-login-2.json.corrupt-1'), '{')
  const created = await store.create(newRun())
  assert.equal(created.id, '20261003-fix-login-3')
})

test('create uses the store clock when openedAt is not given', async () => {
  const { store } = await freshStore({ now: () => Date.UTC(2026, 11, 31, 23, 59) })
  const created = await store.create(newRun({ openedAt: undefined }))
  assert.equal(created.id, '20261231-fix-login')
  assert.equal(created.openedAt, Date.UTC(2026, 11, 31, 23, 59))
  assert.equal(created.driver.since, created.openedAt)
})

test('create refuses fields runProblem refuses, and writes nothing', async () => {
  const { state, store } = await freshStore()
  for (const bad of [
    newRun({ slug: 'Bad Slug' }),
    newRun({ project: 'a/b/c' }),
    newRun({ project: '../x' }),
    newRun({ worktree: 'relative/path' }),
    newRun({ baseCommit: '' }),
    newRun({ branch: '' }),
    { ...newRun(), driver: 7 as unknown as string },
  ]) {
    await assert.rejects(store.create(bad), TypeError, JSON.stringify(bad))
  }
  await assert.rejects(readdir(join(state, 'orchestrator')), { code: 'ENOENT' })
  assert.deepEqual(store.list(), [])
})

test('a goal and a plan path holding a token are stored masked; the goal is folded and cut to 300', async () => {
  const { state, store } = await freshStore()
  const created = await store.create(newRun({ goal: `deploy with\n${TOKEN} ${'x'.repeat(400)}`, plan: { path: `docs/${TOKEN}.md`, commit: SHA_A } }))
  assert.ok(created.goal.startsWith(`deploy with ${MASKED_TOKEN} xxx`))
  assert.equal(created.goal.length, 300)
  assert.ok(created.goal.endsWith('…'))
  assert.equal(created.plan!.path, `docs/${MASKED_TOKEN}.md`)
  const text = await readFile(recordFile(state, 'Acme/widget', created.id), 'utf8')
  assert.ok(!text.includes(TOKEN))
})

test('update: no change writes nothing; a change is written; a result runProblem refuses is a TypeError, and the file is untouched', async () => {
  const { state, store } = await freshStore()
  const created = await store.create(newRun())
  const file = recordFile(state, 'Acme/widget', created.id)
  const before = await readFile(file)
  const mtime = (await stat(file)).mtimeMs

  assert.equal(await store.update('Acme/widget', created.id, () => undefined), undefined)
  assert.deepEqual(await readFile(file), before)
  assert.equal((await stat(file)).mtimeMs, mtime)

  const changed = await store.update('acme/widget', created.id, current => ({ ...current, goal: `ship\nit ${TOKEN}` }))
  assert.equal(changed!.goal, `ship it ${MASKED_TOKEN}`)
  assert.equal(store.get('Acme/widget', created.id)!.goal, `ship it ${MASKED_TOKEN}`)
  const written = await readFile(file)
  assert.equal((JSON.parse(written.toString('utf8')) as Run).goal, `ship it ${MASKED_TOKEN}`)

  for (const bad of [
    (current: Run): Run => ({ ...current, state: 'pr' }),                          // pr without pr
    (current: Run): Run => ({ ...current, closedAt: NOW }),                         // open with closedAt
    (current: Run): Run => ({ ...current, id: '20261003-other' }),                 // another id
    (current: Run): Run => ({ ...current, project: 'Acme/gadget' }),               // another project
    (current: Run): Run => ({ ...current, state: 'done' as Run['state'] }),
    (current: Run): Run => ({ ...current, driver: { session: 'x', since: 'now' as unknown as number } }),
  ]) {
    await assert.rejects(store.update('Acme/widget', created.id, bad), TypeError)
    assert.deepEqual(await readFile(file), written, 'byte for byte')
    assert.equal(store.get('Acme/widget', created.id)!.goal, `ship it ${MASKED_TOKEN}`)
  }
})

test('update masks, folds and cuts a reason to 1000', async () => {
  const { store } = await freshStore()
  const created = await store.create(newRun())
  const closed = await store.update('Acme/widget', created.id, current => ({
    ...current, state: 'abandoned', reason: `no\nlonger ${TOKEN} ${'y'.repeat(2000)}`, closedAt: NOW + 1, driver: { session: '', since: NOW + 1 },
  }))
  assert.ok(closed!.reason!.startsWith(`no longer ${MASKED_TOKEN} yyy`))
  assert.equal(closed!.reason!.length, 1000)
})

test('update: a field set to undefined is gone, in memory as on disk (a reopen that clears closedAt)', async () => {
  const { state, store } = await freshStore()
  const created = await store.create(newRun())
  const pr = { url: 'https://github.com/Acme/widget/pull/7', number: 7 }
  await store.update('Acme/widget', created.id, current => ({ ...current, state: 'pr', pr, closedAt: NOW + 1, driver: { session: '', since: NOW + 1 } }))
  const reopened = await store.update('Acme/widget', created.id, current => ({
    ...current, state: 'open', closedAt: undefined, reason: undefined, driver: { session: 'session-2', since: NOW + 2 },
  }))
  assert.equal('closedAt' in reopened!, false)
  assert.equal('reason' in reopened!, false)
  const cached = store.get('Acme/widget', created.id)!
  assert.equal('closedAt' in cached, false)
  assert.equal('reason' in cached, false)
  assert.deepEqual(cached.pr, pr)
  const again = new RunStore(state)
  await again.load()
  assert.deepEqual(again.get('Acme/widget', created.id), cached)
  assert.deepEqual(Object.keys(again.get('Acme/widget', created.id)!).sort(), Object.keys(cached).sort())
})

test('update of a run the store has not got is undefined', async () => {
  const { store } = await freshStore()
  assert.equal(await store.update('Acme/widget', '20261003-nope', current => current), undefined)
})

test('a change gets a copy: changing it in place and returning undefined changes nothing', async () => {
  const { store } = await freshStore()
  const created = await store.create(newRun())
  await store.update('Acme/widget', created.id, current => {
    current.goal = 'mutated'
    return undefined
  })
  assert.equal(store.get('Acme/widget', created.id)!.goal, 'Fix the login redirect')
})

test('a corrupt record is set aside, onCorrupt is told, and the other runs load', async () => {
  const state = join(await tempDir(), 'state')
  const writer = new RunStore(state, { now: () => NOW })
  await writer.load()
  const good = await writer.create(newRun())
  const runs = join(state, 'orchestrator', 'Acme', 'widget', 'runs')
  await writeFile(join(runs, '20261003-torn.json'), '{"id": "20261003-to')
  await writeFile(join(runs, '20261003-bad.json'), JSON.stringify(run({ id: '20261003-bad', slug: 'bad', state: 'pr' })))
  await writeFile(join(runs, '20261003-moved.json'), JSON.stringify(run({ id: '20261003-elsewhere', slug: 'moved' })))
  await mkdir(join(state, 'orchestrator', 'Other', 'repo', 'runs'), { recursive: true })
  await writeFile(join(state, 'orchestrator', 'Other', 'repo', 'runs', '20261003-fix-login.json'), JSON.stringify(run()))
  // Not records: a temp file a crash left, and a name that isn't a run's.
  await writeFile(join(runs, '.20261003-x.json.0123456789abcdef.tmp'), '{')
  await writeFile(join(runs, 'notes.txt'), 'hello')

  const told: Array<[string, string]> = []
  const store = new RunStore(state, { now: () => NOW + 5, onCorrupt: (file, aside) => { told.push([file, aside]) } })
  await store.load()
  assert.deepEqual(store.list(), [good])
  const expected = [
    join(runs, '20261003-bad.json'), join(runs, '20261003-moved.json'), join(runs, '20261003-torn.json'),
    join(state, 'orchestrator', 'Other', 'repo', 'runs', '20261003-fix-login.json'),
  ].sort()
  assert.deepEqual(told.map(([file]) => file).sort(), expected)
  for (const [file, aside] of told) assert.equal(aside, `${file}.corrupt-${NOW + 5}`)
  const names = (await readdir(runs)).sort()
  assert.deepEqual(names, [
    '.20261003-x.json.0123456789abcdef.tmp',
    `20261003-bad.json.corrupt-${NOW + 5}`,
    '20261003-fix-login.json',
    `20261003-moved.json.corrupt-${NOW + 5}`,
    `20261003-torn.json.corrupt-${NOW + 5}`,
    'notes.txt',
  ])
  // Set aside, so read once: a second store finds nothing to tell.
  const again: string[] = []
  const third = new RunStore(state, { onCorrupt: file => { again.push(file) } })
  await third.load()
  assert.deepEqual(again, [])
  assert.deepEqual(third.list(), [good])
})

test('an onCorrupt that throws does not stop the load', async () => {
  const state = join(await tempDir(), 'state')
  const runs = join(state, 'orchestrator', 'Acme', 'widget', 'runs')
  await mkdir(runs, { recursive: true })
  await writeFile(join(runs, '20261003-torn.json'), '{')
  await writeFile(join(runs, '20261003-fix-login.json'), JSON.stringify(run()))
  const store = new RunStore(state, { onCorrupt: () => { throw new Error('logger broke') } })
  await store.load()
  assert.deepEqual(store.list().map(one => one.id), ['20261003-fix-login'])
})

test('a link in place of a record, of a runs directory or of an owner is not followed', async () => {
  const root = await tempDir()
  const state = join(root, 'state')
  const outside = join(root, 'outside')
  await mkdir(join(outside, 'runs'), { recursive: true })
  await writeFile(join(outside, 'record.json'), JSON.stringify(run()))
  await writeFile(join(outside, 'runs', '20261003-fix-login.json'), JSON.stringify(run()))
  const runs = join(state, 'orchestrator', 'Acme', 'widget', 'runs')
  await mkdir(runs, { recursive: true })
  await symlink(join(outside, 'record.json'), join(runs, '20261003-fix-login.json'))
  await mkdir(join(state, 'orchestrator', 'Acme', 'linked'), { recursive: true })
  await symlink(join(outside, 'runs'), join(state, 'orchestrator', 'Acme', 'linked', 'runs'))
  await symlink(join(outside), join(state, 'orchestrator', 'Linked'))
  const told: string[] = []
  const store = new RunStore(state, { onCorrupt: file => { told.push(file) } })
  await store.load()
  assert.deepEqual(store.list(), [])
  assert.deepEqual(told, [])
  // The link is left as it was, and its target too.
  assert.deepEqual((await readdir(runs)).sort(), ['20261003-fix-login.json'])
  assert.equal(JSON.parse(await readFile(join(outside, 'record.json'), 'utf8')).id, '20261003-fix-login')
})

test('drivenBy: blank, released, closed, and the newest driver.since when two claim one session', async () => {
  const { store } = await freshStore()
  assert.equal(store.drivenBy(''), undefined)
  const a = await store.create(newRun({ slug: 'a' }))
  await store.update('Acme/widget', a.id, current => ({ ...current, driver: { session: '', since: NOW + 1 } }))
  assert.equal(store.drivenBy('session-1'), undefined, 'released')
  assert.equal(store.drivenBy(''), undefined, 'released is nobody')
  const b = await store.create(newRun({ slug: 'b' }))
  await store.update('Acme/widget', b.id, current => ({ ...current, state: 'pr', pr: { url: 'https://github.com/Acme/widget/pull/1', number: 1 }, closedAt: NOW + 2 }))
  assert.equal(store.drivenBy('session-1'), undefined, 'closed with its driver still set')
  const c = await store.create(newRun({ slug: 'c', openedAt: NOW + 3 }))
  const d = await store.create(newRun({ slug: 'd', project: 'Acme/gadget', openedAt: NOW + 2 }))
  await store.update('Acme/gadget', d.id, current => ({ ...current, driver: { session: 'session-1', since: NOW + 10 } }))
  assert.equal(store.drivenBy('session-1')!.id, d.id, 'the newest driver.since')
  assert.notEqual(c.id, d.id)
})

test('the state rules', () => {
  assert.deepEqual(RUN_STATES, ['open', 'pr', 'abandoned'])
  const pr = { url: 'https://github.com/Acme/widget/pull/7', number: 7 }
  assert.equal(runProblem(run()), undefined)
  assert.equal(runProblem(run({ state: 'open', pr })), undefined, 'a reopened run keeps its PR, with no closedAt')
  assert.equal(runProblem(run({ state: 'pr', pr, closedAt: NOW })), undefined)
  assert.equal(runProblem(run({ state: 'abandoned', reason: 'dropped', closedAt: NOW })), undefined)
  assert.equal(runProblem(run({ state: 'abandoned', reason: 'dropped', pr, closedAt: NOW })), undefined, 'abandoned after a reopen')
  assert.equal(runProblem(run({ driver: { session: '', since: NOW } })), undefined, 'released')
  assert.equal(runProblem(run({ plan: { path: 'docs/p.md', commit: SHA_A } })), undefined)

  assert.match(runProblem(run({ state: 'pr', closedAt: NOW }))!, /pr/)
  assert.match(runProblem(run({ closedAt: NOW }))!, /closedAt/)
  assert.match(runProblem(run({ state: 'pr', pr, closedAt: NOW, reason: 'why' }))!, /reason/)
  assert.match(runProblem(run({ state: 'abandoned', reason: 'x' }))!, /closedAt/)
  assert.match(runProblem(run({ state: 'closed' as Run['state'] }))!, /state/)
  assert.match(runProblem(run({ pr: { url: 'x', number: 0 } }))!, /pr/)
  assert.match(runProblem(run({ driver: { session: 1 as unknown as string, since: NOW } }))!, /driver/)
  assert.match(runProblem(run({ driver: undefined as unknown as Run['driver'] }))!, /driver/)
  assert.match(runProblem(run({ id: 'nope' }))!, /id/)
  assert.match(runProblem(run({ project: 'a/b/c' }))!, /project/)
  assert.match(runProblem(run({ slug: 'Bad' }))!, /slug/)
  assert.match(runProblem(run({ worktree: 'rel' }))!, /worktree/)
  assert.match(runProblem(run({ plan: { path: 'p' } as Run['plan'] }))!, /plan/)
  assert.match(runProblem(run({ openedAt: Number.NaN }))!, /openedAt/)
  assert.match(runProblem(null)!, /object/)
  assert.match(runProblem([])!, /object/)
})

test('a call before load throws', async () => {
  const store = new RunStore(join(await tempDir(), 'state'))
  const words = /the run store isn't loaded/
  assert.throws(() => store.list(), words)
  assert.throws(() => store.get('Acme/widget', '20261003-x'), words)
  assert.throws(() => store.byId('20261003-x'), words)
  assert.throws(() => store.drivenBy('session-1'), words)
  await assert.rejects(store.create(newRun()), words)
  await assert.rejects(store.update('Acme/widget', '20261003-x', current => current), words)
})

test('load gives the same promise; after a failure, the next call tries again', async t => {
  const state = join(await tempDir(), 'state')
  const store = new RunStore(state)
  assert.equal(store.load(), store.load())
  await store.load()

  if (process.getuid?.() === 0) {
    t.skip('root reads a directory whatever its mode')
    return
  }
  const runs = join(state, 'orchestrator', 'Acme', 'widget', 'runs')
  await mkdir(runs, { recursive: true })
  await writeFile(join(runs, '20261003-fix-login.json'), JSON.stringify(run()))
  // A runs directory that can't be listed: the load fails as a whole, and is tried again.
  await chmod(runs, 0o000)
  const failing = new RunStore(state)
  try {
    await assert.rejects(failing.load(), { code: 'EACCES' })
    assert.throws(() => failing.list(), /isn't loaded/)
  } finally {
    await chmod(runs, 0o700)
  }
  await failing.load()
  assert.deepEqual(failing.list().map(one => one.id), ['20261003-fix-login'])
})

test('one record that can\'t be read is skipped and told, the others load, and its id stays taken', async t => {
  if (process.getuid?.() === 0) {
    t.skip('root reads a file whatever its mode')
    return
  }
  const state = join(await tempDir(), 'state')
  const runs = join(state, 'orchestrator', 'Acme', 'widget', 'runs')
  await mkdir(runs, { recursive: true })
  await writeFile(join(runs, '20261003-fix-login.json'), JSON.stringify(run()))
  const unreadable = join(runs, '20261003-locked.json')
  await writeFile(unreadable, JSON.stringify(run({ id: '20261003-locked', slug: 'locked' })))
  await chmod(unreadable, 0o000)
  try {
    const told: Array<[string, string, string | undefined]> = []
    const store = new RunStore(state, { now: () => NOW, onCorrupt: (file, aside, problem) => { told.push([file, aside, problem]) } })
    await store.load()
    assert.deepEqual(store.list().map(one => one.id), ['20261003-fix-login'])
    assert.equal(told.length, 1)
    assert.equal(told[0]![0], unreadable)
    assert.equal(told[0]![1], '', 'left where it is')
    assert.match(told[0]![2]!, /EACCES|permission/i)
    // The file is still there, and create doesn't take its id.
    assert.ok((await readdir(runs)).includes('20261003-locked.json'))
    const created = await store.create(newRun({ slug: 'locked' }))
    assert.equal(created.id, '20261003-locked-2')
  } finally {
    await chmod(unreadable, 0o600)
  }
})

test('a corrupt record that can\'t be set aside is skipped where it is and told, and the others load', async t => {
  if (process.getuid?.() === 0) {
    t.skip('root renames in a directory whatever its mode')
    return
  }
  const state = join(await tempDir(), 'state')
  const runs = join(state, 'orchestrator', 'Acme', 'widget', 'runs')
  await mkdir(runs, { recursive: true })
  await writeFile(join(runs, '20261003-fix-login.json'), JSON.stringify(run()))
  await writeFile(join(runs, '20261003-torn.json'), '{')
  // Readable, but nothing in it can be renamed.
  await chmod(runs, 0o500)
  try {
    const told: Array<[string, string, string | undefined]> = []
    const store = new RunStore(state, { now: () => NOW, onCorrupt: (file, aside, problem) => { told.push([file, aside, problem]) } })
    await store.load()
    assert.deepEqual(store.list().map(one => one.id), ['20261003-fix-login'])
    assert.deepEqual(told.map(([file, aside]) => [file, aside]), [[join(runs, '20261003-torn.json'), '']])
    assert.match(told[0]![2]!, /EACCES|permission/i)
    assert.deepEqual((await readdir(runs)).sort(), ['20261003-fix-login.json', '20261003-torn.json'])
  } finally {
    await chmod(runs, 0o700)
  }
})

test('flush waits for what is queued', async () => {
  const { state, store } = await freshStore()
  const pending = store.create(newRun())
  await store.flush()
  await stat(recordFile(state, 'Acme/widget', '20261003-fix-login'))
  await pending
})
