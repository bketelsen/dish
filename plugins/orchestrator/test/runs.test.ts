/**
 * The core (`Runs`): the dishRuns five, the resume rules, and what the tools build on, over temp directories and stub
 * services (`service-helpers.ts`).
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, symlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { nextRound } from '../src/derive.ts'
import { createListeners } from '../src/listeners.ts'
import { Runs, mainSession } from '../src/runs.ts'
import { RunStore } from '../src/store.ts'
import type { Run } from '../src/store.ts'
import {
  BASE, HEAD, MASKED_TOKEN, OTHER_PROJECT, OTHER_SESSION, PROJECT, SESSION, TOKEN, childExec, deferred, delegated, mainExec, tempDir, world,
} from './service-helpers.ts'
import type { World } from './service-helpers.ts'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

/** A coder or reviewer delegated in `run` on `task`, heard by the listeners as crew publishes it. */
async function start(w: World, run: Run, child: { id: string, role?: string, task?: string, reviews?: string, final?: true, worktree?: string }, options: { followUp?: boolean, sessionId?: string } = {}): Promise<void> {
  const listeners = createListeners(w.runs)
  listeners.delegated(delegated({ role: 'coder', ...child, run: w.runs.refOf(run) }, options))
  await w.ledger.flush()
}

// --- driving ----------------------------------------------------------------------------------------------------------

test('driving: none; the run a chat opened; the newer when it opens another (the older released); none once it is closed; the same after a restart', async () => {
  const w = await world()
  assert.equal(await w.runs.driving(SESSION), undefined)
  const first = await w.open()
  assert.deepEqual(await w.runs.driving(SESSION), {
    ref: `${PROJECT}/${first.id}`, id: first.id, project: PROJECT, slug: 'fix-login', goal: 'Fix the login redirect', branch: 'dish/fix-login',
    worktree: first.worktree, state: 'open',
  })
  const second = await w.open({ slug: 'add-sso', goal: 'Add SSO' })
  assert.equal((await w.runs.driving(SESSION))?.id, second.id)
  assert.equal(w.record(first)?.driver.session, '')
  assert.equal(await w.runs.driving(OTHER_SESSION), undefined)
  await w.restart()
  assert.equal((await w.runs.driving(SESSION))?.id, second.id)
  await w.runs.withRun(second, () => w.runs.close(second, SESSION, { state: 'abandoned', reason: 'not needed' }))
  assert.equal(await w.runs.driving(SESSION), undefined)
})

// --- place ----------------------------------------------------------------------------------------------------------

test('place: no run gives undefined', async () => {
  const w = await world()
  assert.equal(await w.runs.place(SESSION, {}), undefined)
  assert.equal(await w.runs.place(SESSION, { worktree: '/nowhere' }), undefined)
})

test('place: the run\'s own worktree, by its path, by owner/repo/slug and through a link, is its task, round 0', async () => {
  const w = await world()
  const run = await w.open()
  const ref = `${PROJECT}/${run.id}`
  assert.deepEqual(await w.runs.place(SESSION, { worktree: run.worktree }), { run: ref, task: 'fix-login', round: 0 })
  assert.deepEqual(await w.runs.place(SESSION, { worktree: `${PROJECT}/fix-login` }), { run: ref, task: 'fix-login', round: 0 })
  const link = join(w.dir, 'link-to-worktree')
  await symlink(run.worktree, link)
  w.absent.add('workspaces')
  assert.deepEqual(await w.runs.place(SESSION, { worktree: link }), { run: ref, task: 'fix-login', round: 0 })
})

test('place: coder starts and follow-ups on a task count its rounds; a reviewer\'s start doesn\'t', async () => {
  const w = await world()
  const run = await w.open()
  await start(w, run, { id: 'c1', task: 'fix-login', worktree: run.worktree })
  await start(w, run, { id: 'c1', task: 'fix-login', worktree: run.worktree }, { followUp: true })
  await start(w, run, { id: 'r1', role: 'reviewer', task: 'fix-login', reviews: 'c1' })
  assert.deepEqual(await w.runs.place(SESSION, { worktree: run.worktree }), { run: w.runs.refOf(run), task: 'fix-login', round: 2 })
})

test('place: a task.opened worktree is that task; once removed, the session\'s run with no task; one no run owns, the session\'s run', async () => {
  const w = await world()
  const run = await w.open()
  const created = await w.created('api')
  assert.deepEqual(await w.runs.worktreeCreated(SESSION, created), { id: run.id, opened: false })
  assert.deepEqual(await w.runs.place(SESSION, { worktree: created.path }), { run: w.runs.refOf(run), task: 'api', round: 0 })
  await w.runs.worktreeRemoved(PROJECT, 'api')
  assert.deepEqual(await w.runs.place(SESSION, { worktree: created.path }), { run: w.runs.refOf(run) })
  const stray = await w.worktree('stray')
  assert.deepEqual(await w.runs.place(SESSION, { worktree: stray }), { run: w.runs.refOf(run) })
})

test('place: a worktree is placed in the run that owns it, whichever chat drives it (a takeover), with its task and round', async () => {
  const w = await world()
  const run = await w.open({ session: SESSION })
  await start(w, run, { id: 'c1', task: 'fix-login', worktree: run.worktree })
  // Another chat takes the run over: the chat that lost it still follows up its own coder, bound to the run's worktree.
  w.live.add(SESSION)
  await w.runs.withSession(OTHER_SESSION, () => w.runs.drive(OTHER_SESSION, run, { takeover: true }))
  assert.equal(await w.runs.driving(SESSION), undefined)
  const expected = { run: w.runs.refOf(run), task: 'fix-login', round: 1 }
  assert.deepEqual(await w.runs.place(SESSION, { worktree: run.worktree }), expected)
  assert.deepEqual(await w.runs.place('session-3', { worktree: run.worktree }), expected)
})

test('place: with two open runs in two projects, resolve narrows the search; without dish-workspaces the path still finds its run', async () => {
  const w = await world()
  const widget = await w.open({ session: SESSION, slug: 'fix-login' })
  const gadget = await w.open({ session: OTHER_SESSION, slug: 'fix-login', project: OTHER_PROJECT })
  assert.notEqual(widget.worktree, gadget.worktree)
  assert.deepEqual(await w.runs.place(SESSION, { worktree: gadget.worktree }), { run: w.runs.refOf(gadget), task: 'fix-login', round: 0 })
  assert.deepEqual(w.workspaces.calls.resolve.at(-1), [gadget.worktree])
  assert.deepEqual(await w.runs.place(OTHER_SESSION, { worktree: `${PROJECT}/fix-login` }), { run: w.runs.refOf(widget), task: 'fix-login', round: 0 })
  w.absent.add('workspaces')
  assert.deepEqual(await w.runs.place(SESSION, { worktree: gadget.worktree }), { run: w.runs.refOf(gadget), task: 'fix-login', round: 0 })
  assert.deepEqual(await w.runs.place(OTHER_SESSION, { worktree: widget.worktree }), { run: w.runs.refOf(widget), task: 'fix-login', round: 0 })
})

test('place: reviews main goes to the session\'s run with no task; reviews of a run\'s child goes where that child is, with its task\'s round', async () => {
  const w = await world()
  const run = await w.open()
  const ref = w.runs.refOf(run)
  assert.deepEqual(await w.runs.place(SESSION, { reviews: 'main' }), { run: ref })
  await start(w, run, { id: 'c1', task: 'fix-login', worktree: run.worktree })
  assert.deepEqual(await w.runs.place(OTHER_SESSION, { reviews: 'c1' }), { run: ref, task: 'fix-login', round: 1 })
  // After a restart the index is empty: crew's record says where the child is.
  await w.restart()
  w.children.set('c1', { sessionId: SESSION, record: { ...delegated({ id: 'c1', run: ref, task: 'fix-login' }).child } })
  assert.deepEqual(await w.runs.place(OTHER_SESSION, { reviews: 'c1' }), { run: ref, task: 'fix-login', round: 1 })
  assert.deepEqual(w.crew.calls.lookup.at(-1), ['c1'])
  // An unknown child: the session's own run, no task.
  assert.deepEqual(await w.runs.place(SESSION, { reviews: 'nobody' }), { run: ref })
  assert.equal(await w.runs.place(OTHER_SESSION, { reviews: 'nobody' }), undefined)
})

test('place: a reviewed child whose task is gone gives its run without a task; one in a closed run gives the session\'s', async () => {
  const w = await world()
  const run = await w.open()
  const created = await w.created('api')
  await w.runs.worktreeCreated(SESSION, created)
  await start(w, run, { id: 'c1', task: 'api', worktree: created.path })
  await w.runs.worktreeRemoved(PROJECT, 'api')
  assert.deepEqual(await w.runs.place(OTHER_SESSION, { reviews: 'c1' }), { run: w.runs.refOf(run) })
  await w.runs.withRun(run, () => w.runs.close(run, SESSION, { state: 'abandoned', reason: 'gone' }))
  assert.equal(await w.runs.place(OTHER_SESSION, { reviews: 'c1' }), undefined)
})

test('place: final is given back only with reviews and a run', async () => {
  const w = await world()
  assert.equal(await w.runs.place(SESSION, { reviews: 'main', final: true }), undefined)
  const run = await w.open()
  const ref = w.runs.refOf(run)
  assert.deepEqual(await w.runs.place(SESSION, { reviews: 'main', final: true }), { run: ref, final: true })
  assert.deepEqual(await w.runs.place(SESSION, { worktree: run.worktree, final: true }), { run: ref, task: 'fix-login', round: 0 })
  assert.deepEqual(await w.runs.place(SESSION, { final: true }), { run: ref })
  await start(w, run, { id: 'c1', task: 'fix-login', worktree: run.worktree })
  assert.deepEqual(await w.runs.place(SESSION, { reviews: 'c1', final: true }), { run: ref, task: 'fix-login', round: 1, final: true })
})

test('place: a reviewer bound to a worktree no run owns is placed where the child it reviews is', async () => {
  const w = await world()
  const run = await w.open({ session: OTHER_SESSION })
  await start(w, run, { id: 'c1', task: 'fix-login', worktree: run.worktree }, { sessionId: OTHER_SESSION })
  const stray = await w.worktree('stray')
  assert.deepEqual(await w.runs.place(SESSION, { worktree: stray, reviews: 'c1', final: true }), { run: w.runs.refOf(run), task: 'fix-login', round: 1, final: true })
})

test('place: an unbound child goes to the session\'s run, with no task and no round', async () => {
  const w = await world()
  const run = await w.open()
  assert.deepEqual(await w.runs.place(SESSION, {}), { run: w.runs.refOf(run) })
})

test('place: an unreadable ledger gives undefined, logged once', { skip: process.getuid?.() === 0 ? 'root reads anything' : false }, async () => {
  const w = await world()
  const run = await w.open()
  const file = w.ledger.file(run.project, run.id)
  await chmod(file, 0o000)
  try {
    assert.equal(await w.runs.place(SESSION, { worktree: run.worktree }), undefined)
    assert.equal(await w.runs.place(SESSION, { worktree: run.worktree }), undefined)
    assert.equal(w.logs.filter(line => line.startsWith('warn:') && line.includes('EACCES')).length, 1, w.logs.join('\n'))
  } finally {
    await chmod(file, 0o600)
  }
})

test('a store that can\'t be read: each service method gives undefined, logged once, and the next call reads it again', { skip: process.getuid?.() === 0 ? 'root reads anything' : false }, async () => {
  const w = await world()
  await w.open()
  const records = join(w.state, 'orchestrator')
  await chmod(records, 0o000)
  const warned: string[] = []
  const runs = new Runs({ store: new RunStore(w.state), ledger: w.ledger, services: w.services, now: () => w.clock.now, logger: { info() {}, warn: (_format, ...args) => { warned.push(String(args[0])) } } })
  try {
    assert.equal(await runs.driving(SESSION), undefined)
    assert.equal(await runs.place(SESSION, {}), undefined)
    assert.equal(await runs.worktreeCreated(SESSION, await w.created('api')), undefined)
    await runs.worktreeRemoved(PROJECT, 'api')
    await runs.ladder({ sessionId: SESSION, run: `${PROJECT}/20261003-fix-login`, task: 'fix-login', round: 5, outcome: 'refused' })
    assert.equal(warned.filter(line => line.startsWith('could not read the run records')).length, 1, warned.join('\n'))
  } finally {
    await chmod(records, 0o700)
  }
  assert.equal((await runs.driving(SESSION))?.id, '20261003-fix-login')
})

test('place doesn\'t hang: a resolve that never answers is passed over, and a stuck call gives undefined within its budget', async () => {
  const w = await world({ limits: { lookupMs: 50, placeMs: 300 } })
  const run = await w.open()
  w.workspaces.impl.resolve = () => new Promise(() => {})
  assert.deepEqual(await w.runs.place(SESSION, { worktree: run.worktree }), { run: w.runs.refOf(run), task: 'fix-login', round: 0 })
  // A ledger queue held up (an append whose build never ends): place gives up, and says so.
  void w.ledger.appendWith(run.project, run.id, () => new Promise(() => {})).catch(() => {})
  const began = Date.now()
  assert.equal(await w.runs.place(SESSION, { worktree: run.worktree }), undefined)
  assert.ok(Date.now() - began < 5000)
  assert.match(w.logs.join('\n'), /place.*took longer than 0\.3 s.*a start goes on outside any run.*a follow-up keeps its child's run and task/)
})

test('a call past its time limit doesn\'t hold the process open at exit', async () => {
  const dir = await tempDir()
  const url = (file: string): string => pathToFileURL(join(SRC, file)).href
  // A store whose load never ends, so place waits out its 30 s limit; the script then ends without awaiting it.
  const script = [
    `import { Runs } from ${JSON.stringify(url('runs.ts'))}`,
    `import { RunStore } from ${JSON.stringify(url('store.ts'))}`,
    `import { Ledger } from ${JSON.stringify(url('ledger.ts'))}`,
    `const store = new RunStore(${JSON.stringify(join(dir, 'state'))})`,
    'store.load = () => new Promise(() => {})',
    'const none = () => undefined',
    `const runs = new Runs({ store, ledger: new Ledger(${JSON.stringify(join(dir, 'data'))}), services: { workspaces: none, crew: none, gates: none, projects: none, agents: none }, now: Date.now, logger: { info() {}, warn() {} } })`,
    'void runs.place("session-1", {})',
    'void runs.driving("session-1")',
  ].join('\n')
  const began = Date.now()
  const code = await new Promise<number | null>((settle, fail) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir, HISTFILE: join(dir, '.bash_history') }, stdio: 'ignore',
    })
    const killer = setTimeout(() => { child.kill() }, 20_000)
    child.on('error', fail)
    child.on('exit', (exit) => { clearTimeout(killer); settle(exit) })
  })
  assert.equal(code, 0)
  assert.ok(Date.now() - began < 10_000, `the process stayed open ${Date.now() - began} ms`)
})

test('the order: a coder\'s delegated published with ctx.parallel, then place with no await between, counts it', async () => {
  const w = await world()
  const run = await w.open()
  const ctx = new Context()
  const listeners = createListeners(w.runs)
  ctx.on('dish-crew/delegated', (e) => { listeners.delegated(e) })
  void ctx.parallel('dish-crew/delegated', delegated({ id: 'c1', run: w.runs.refOf(run), task: 'fix-login', worktree: run.worktree }))
  // No await between: the listener queued its append while the publish called it, so the ledger's queue already holds it.
  const entries = w.runs.entries(run)
  const placed = w.runs.place(SESSION, { worktree: run.worktree })
  assert.equal(nextRound(await entries, 'fix-login'), 1)
  assert.deepEqual(await placed, { run: w.runs.refOf(run), task: 'fix-login', round: 1 })
})

// --- worktreeCreated ------------------------------------------------------------------------------------------------

test('worktreeCreated: a run in the project gets task.opened (base is the ref, baseCommit the commit), and it joins', async () => {
  const w = await world()
  const run = await w.open()
  const created = await w.created('api', { baseRef: 'dish/fix-login' })
  assert.deepEqual(await w.runs.worktreeCreated(SESSION, created), { id: run.id, opened: false })
  const last = (await w.entries(run)).at(-1)
  assert.deepEqual(last, {
    at: w.clock.now, run: run.id, kind: 'task.opened', by: 'harness', session: SESSION, task: 'api', path: created.path,
    branch: 'dish/api', base: 'dish/fix-login', baseCommit: BASE,
  })
})

test('worktreeCreated: with no run, a run is opened around the worktree (how: auto), driven by the chat', async () => {
  const w = await world()
  const created = await w.created('fix-login')
  const joined = await w.runs.worktreeCreated(SESSION, created)
  assert.deepEqual(joined, { id: '20261003-fix-login', opened: true })
  const run = w.store.get(PROJECT, '20261003-fix-login')!
  assert.deepEqual(
    { slug: run.slug, branch: run.branch, worktree: run.worktree, base: run.base, baseCommit: run.baseCommit, goal: run.goal, driver: run.driver, state: run.state },
    { slug: 'fix-login', branch: 'dish/fix-login', worktree: created.path, base: 'origin/main', baseCommit: BASE, goal: 'fix-login', driver: { session: SESSION, since: w.clock.now }, state: 'open' },
  )
  assert.deepEqual(await w.entries(run), [{
    at: w.clock.now, run: run.id, kind: 'run.opened', by: 'harness', session: SESSION, goal: 'fix-login', branch: 'dish/fix-login',
    worktree: created.path, base: 'origin/main', baseCommit: BASE, how: 'auto',
  }])
})

test('worktreeCreated: a run in another project is released, logged, and a new one opened', async () => {
  const w = await world()
  const old = await w.open()
  const created = await w.created('gizmo', { project: OTHER_PROJECT })
  const joined = await w.runs.worktreeCreated(SESSION, created)
  assert.equal(joined?.opened, true)
  // The answer names the run it released, so the worktree tool can say so.
  assert.deepEqual(joined, { id: joined!.id, opened: true, released: old.id })
  assert.equal(w.record(old)?.driver.session, '')
  assert.equal(w.record(old)?.state, 'open')
  assert.equal((await w.runs.driving(SESSION))?.project, OTHER_PROJECT)
  assert.ok(w.logs.includes(`info: released run ${old.id} of ${PROJECT}: this chat opened run ${joined!.id} in ${OTHER_PROJECT}`), w.logs.join('\n'))
})

test('worktreeCreated: malformed input gives undefined, and writes nothing', async () => {
  const w = await world()
  const good = await w.created('api')
  for (const bad of [
    { ...good, slug: 'Bad_Slug' },
    { ...good, branch: 'feature/api' },
    { ...good, path: 'relative/api' },
    { ...good, baseRef: '' },
    { ...good, base: '' },
    { ...good, project: 'not-a-project' },
  ]) {
    assert.equal(await w.runs.worktreeCreated(SESSION, bad), undefined, JSON.stringify(bad))
  }
  assert.equal(await w.runs.worktreeCreated('', good), undefined)
  assert.deepEqual(w.store.list(), [])
})

test('worktreeCreated: two at once in one session make one run and one task.opened', async () => {
  const w = await world()
  const a = await w.created('fix-login')
  const b = await w.created('api')
  const [first, second] = await Promise.all([w.runs.worktreeCreated(SESSION, a), w.runs.worktreeCreated(SESSION, b)])
  assert.deepEqual(first, { id: '20261003-fix-login', opened: true })
  assert.deepEqual(second, { id: '20261003-fix-login', opened: false })
  assert.equal(w.store.list().length, 1)
  assert.deepEqual(await w.kinds(w.store.list()[0]!), ['run.opened', 'task.opened'])
})

test('worktreeCreated doesn\'t wait long for a session lock held elsewhere: it answers undefined, and the worktree joins the chat\'s run once the lock is free', async () => {
  const w = await world({ limits: { hookMs: 100 } })
  const run = await w.open()
  const held = deferred()
  const holding = w.runs.withSession(SESSION, () => held.promise)
  const created = await w.created('api')
  assert.equal(await w.runs.worktreeCreated(SESSION, created), undefined)
  held.resolve()
  await holding
  await w.runs.withSession(SESSION, async () => {})
  assert.deepEqual(await w.kinds(run), ['run.opened', 'task.opened'])
  const lines = w.logs.filter(line => line.includes('Acme/widget/api'))
  assert.equal(lines.length, 1, w.logs.join('\n'))
  assert.match(lines[0]!, /^info: worktree Acme\/widget\/api waited 0\.1 s for its chat's lock, so the worktree tool answered without a run; it then joined run 20261003-fix-login as task api$/)
})

/** Hold `SESSION`'s lock while `meanwhile` runs, let a worktree's hook time out, then free the lock and let the late hook finish. */
async function lateHook(w: World, created: Awaited<ReturnType<World['created']>>, meanwhile: () => Promise<unknown>): Promise<void> {
  const held = deferred()
  const holding = w.runs.withSession(SESSION, async () => {
    await held.promise
    await meanwhile()
  })
  assert.equal(await w.runs.worktreeCreated(SESSION, created), undefined)
  held.resolve()
  await holding
  // The late hook queued for the lock before this did: once this runs, it has finished.
  await w.runs.withSession(SESSION, async () => {})
  await w.ledger.flush()
}

test('a late hook never opens or switches a run: the chat\'s run changed project while it waited → no run opened, nothing released, one line', async () => {
  const w = await world({ limits: { hookMs: 100 } })
  const first = await w.open()
  const created = await w.created('api')
  let second: Run | undefined
  await lateHook(w, created, async () => {
    // The chat drives a run in another project by the time the lock is free (a `run resume`, say).
    second = (await w.runs.openAround(SESSION, await w.created('gizmo', { project: OTHER_PROJECT }), { goal: 'Gizmo', how: 'run' })).run
  })
  assert.equal(w.store.list().length, 2)
  assert.equal((await w.runs.driving(SESSION))?.id, second!.id)
  assert.equal(w.record(second!)?.driver.session, SESSION)
  assert.deepEqual(await w.kinds(first), ['run.opened'])
  assert.deepEqual(await w.kinds(second!), ['run.opened'])
  const lines = w.logs.filter(line => line.includes('Acme/widget/api'))
  assert.equal(lines.length, 1, w.logs.join('\n'))
  assert.match(lines[0]!, /^warn: worktree Acme\/widget\/api waited 0\.1 s for its chat's lock, so the worktree tool answered without a run; it wasn't added to one: by then this chat drove run 20261003-gizmo in Acme\/gadget, and a late worktree never opens or switches a run$/)
})

test('worktreeCreated: once the hook holds the lock, its caller waits for it, past the limit, and gets the run', async () => {
  const w = await world({ limits: { hookMs: 100 } })
  const run = await w.open()
  // The run's ledger is held up (its queue busy): the hook takes the lock at once, then waits on the queue.
  const held = deferred()
  const holding = w.ledger.appendWith(run.project, run.id, async () => { await held.promise; return [] })
  const created = await w.created('api')
  const answer = w.runs.worktreeCreated(SESSION, created)
  await new Promise(settle => setTimeout(settle, 300))
  held.resolve()
  await holding
  assert.deepEqual(await answer, { id: run.id, opened: false })
  assert.deepEqual(await w.kinds(run), ['run.opened', 'task.opened'])
  assert.equal(w.logs.filter(line => line.includes('Acme/widget/api')).length, 0, w.logs.join('\n'))
})

test('a late hook never opens a run for a chat that drives none by then, and never adds a worktree removed while it waited', async () => {
  const w = await world({ limits: { hookMs: 100 } })
  const created = await w.created('api')
  await lateHook(w, created, async () => {})
  assert.deepEqual(w.store.list(), [])
  assert.match(w.logs.join('\n'), /api waited .* it wasn't added to one: by then this chat drove no run, and a late worktree never opens or switches a run/)

  const run = await w.open()
  const gone = await w.created('gone')
  await lateHook(w, gone, async () => { w.worktrees.delete(gone.path) })
  assert.deepEqual(await w.kinds(run), ['run.opened'])
  assert.match(w.logs.join('\n'), /gone waited .* it wasn't added to run 20261003-fix-login: it no longer resolves to a worktree dish made \(removed while it waited\)/)
})

// --- worktreeRemoved ------------------------------------------------------------------------------------------------

test('worktreeRemoved: a task, and the run\'s own worktree, get task.removed, in an open run and in a pr run', async () => {
  const w = await world()
  const run = await w.open()
  await w.runs.worktreeCreated(SESSION, await w.created('api'))
  await w.runs.worktreeRemoved('acme/WIDGET', 'api')
  assert.deepEqual((await w.entries(run)).at(-1), { at: w.clock.now, run: run.id, kind: 'task.removed', by: 'harness', task: 'api' })
  await w.runs.withRun(run, () => w.runs.close(run, SESSION, { state: 'pr', pr: { url: 'https://github.com/Acme/widget/pull/1', number: 1 } }))
  await w.runs.worktreeRemoved(PROJECT, 'fix-login')
  assert.deepEqual(await w.kinds(run), ['run.opened', 'task.opened', 'task.removed', 'run.closed', 'task.removed'])
  // A second removal of the same task finds it gone already.
  await w.runs.worktreeRemoved(PROJECT, 'fix-login')
  assert.equal((await w.kinds(run)).length, 5)
})

test('worktreeRemoved: an unknown slug, an abandoned run and another project write nothing', async () => {
  const w = await world()
  const run = await w.open()
  const abandoned = await w.open({ session: OTHER_SESSION, slug: 'old-idea' })
  await w.runs.withRun(abandoned, () => w.runs.close(abandoned, OTHER_SESSION, { state: 'abandoned', reason: 'no' }))
  await w.runs.worktreeRemoved(PROJECT, 'nothing-here')
  await w.runs.worktreeRemoved(PROJECT, 'old-idea')
  await w.runs.worktreeRemoved(OTHER_PROJECT, 'fix-login')
  assert.deepEqual(await w.kinds(run), ['run.opened'])
  assert.deepEqual(await w.kinds(abandoned), ['run.opened', 'run.closed'])
})

test('worktreeRemoved takes no lock: it completes while the run\'s lock and the session\'s are held', async () => {
  const w = await world()
  const run = await w.open()
  const held = deferred()
  const holding = w.runs.withSession(SESSION, () => w.runs.withRun(run, () => held.promise))
  await w.runs.worktreeRemoved(PROJECT, 'fix-login')
  assert.deepEqual(await w.kinds(run), ['run.opened', 'task.removed'])
  held.resolve()
  await holding
})

// --- find, live and mainSession ----------------------------------------------------------------------------------------

test('find: a bare id, owner/repo/id; an unknown id and an id in two projects are refused with the words the tools use', async () => {
  const w = await world()
  const widget = await w.open({ session: SESSION })
  assert.equal(w.runs.find(widget.id).project, PROJECT)
  assert.equal(w.runs.find(`${PROJECT}/${widget.id}`).id, widget.id)
  assert.throws(() => w.runs.find('20261003-nothing'), { message: 'no run `20261003-nothing`: `run` `list` shows the runs' })
  assert.throws(() => w.runs.find(`${OTHER_PROJECT}/${widget.id}`), { message: `no run \`${OTHER_PROJECT}/${widget.id}\`: \`run\` \`list\` shows the runs` })
  await w.open({ session: OTHER_SESSION, project: OTHER_PROJECT })
  assert.throws(() => w.runs.find(widget.id), {
    message: `\`${widget.id}\` names runs in several projects (${OTHER_PROJECT}, ${PROJECT}): give \`owner/repo/${widget.id}\``,
  })
})

test('live: the driver has a live agent; a released run and no registry are never live', async () => {
  const w = await world()
  const run = await w.open()
  assert.equal(w.runs.live(run), false)
  w.live.add(SESSION)
  assert.equal(w.runs.live(run), true)
  w.absent.add('agents')
  assert.equal(w.runs.live(run), false)
  w.absent.delete('agents')
  assert.equal(w.runs.live({ ...run, driver: { session: '', since: 0 } }), false)
})

test('mainSession: the main agent\'s id; a crew child, an agent with no id and no agent give undefined', () => {
  assert.equal(mainSession(mainExec(SESSION)), SESSION)
  assert.equal(mainSession(childExec()), undefined)
  assert.equal(mainSession({ agent: { session: { header: {} } } }), undefined)
  assert.equal(mainSession({ agent: { id: '', session: { header: {} } } }), undefined)
  assert.equal(mainSession({}), undefined)
})

// --- ladder ----------------------------------------------------------------------------------------------------------

test('ladder: refused and ruled are recorded (the ruling folded, its Ruling: taken off, a token masked); an unknown ref is logged and dropped', async () => {
  const w = await world()
  const run = await w.open()
  const ref = w.runs.refOf(run)
  await w.runs.ladder({ sessionId: SESSION, run: ref, task: 'fix-login', round: 5, outcome: 'refused' })
  await w.runs.ladder({ sessionId: SESSION, run: ref, task: 'fix-login', round: 5, outcome: 'ruled', child: 'c1', ruling: `**Ruling:** one more\n  round — close, ${TOKEN} — an hour` })
  const [, refused, ruled] = await w.entries(run)
  assert.deepEqual(refused, { at: w.clock.now, run: run.id, kind: 'ladder.refused', by: 'harness', session: SESSION, task: 'fix-login', round: 5 })
  assert.deepEqual(ruled, {
    at: w.clock.now, run: run.id, kind: 'ladder.ruled', by: 'harness', session: SESSION, child: 'c1', task: 'fix-login', round: 5,
    ruling: `one more round — close, ${MASKED_TOKEN} — an hour`,
  })
  await w.runs.ladder({ sessionId: SESSION, run: `${PROJECT}/20260101-nothing`, task: 'fix-login', round: 5, outcome: 'refused' })
  await w.runs.ladder({ sessionId: SESSION, run: ref, task: 'Not A Slug', round: 5, outcome: 'refused' })
  await w.runs.ladder({ sessionId: SESSION, run: ref, task: 'fix-login', round: 4.5, outcome: 'refused' })
  assert.equal((await w.entries(run)).length, 3)
  assert.equal(w.logs.filter(line => line.startsWith('warn:')).length, 3, w.logs.join('\n'))
})

// --- drive -------------------------------------------------------------------------------------------------------------

test('drive: by its driver, already, with no entry; a driver that isn\'t live, resumed with previous; a released run, resumed without', async () => {
  const w = await world()
  const run = await w.open()
  const already = await w.runs.withSession(SESSION, () => w.runs.drive(SESSION, run, { takeover: false }))
  assert.equal(already.how, 'already')
  assert.deepEqual(await w.kinds(run), ['run.opened'])
  w.clock.now += 1000
  const resumed = await w.runs.withSession(OTHER_SESSION, () => w.runs.drive(OTHER_SESSION, run, { takeover: false }))
  assert.equal(resumed.how, 'resumed')
  assert.equal(resumed.previous, SESSION)
  assert.deepEqual(resumed.run.driver, { session: OTHER_SESSION, since: w.clock.now })
  assert.deepEqual((await w.entries(run)).at(-1), { at: w.clock.now, run: run.id, kind: 'run.resumed', by: 'harness', session: OTHER_SESSION, driver: OTHER_SESSION, previous: SESSION })
  // Released by another run it opened: resumed without previous.
  await w.open({ session: OTHER_SESSION, slug: 'other' })
  assert.equal(w.record(run)?.driver.session, '')
  const back = await w.runs.withSession(SESSION, () => w.runs.drive(SESSION, run, { takeover: false }))
  assert.equal(back.how, 'resumed')
  assert.equal(back.previous, undefined)
  assert.deepEqual((await w.entries(run)).at(-1), { at: w.clock.now, run: run.id, kind: 'run.resumed', by: 'harness', session: SESSION, driver: SESSION })
})

test('drive: a live driver refuses without takeover, and is taken over with it; takeover when not live is a resume', async () => {
  const w = await world()
  const run = await w.open()
  w.live.add(SESSION)
  await assert.rejects(w.runs.withSession(OTHER_SESSION, () => w.runs.drive(OTHER_SESSION, run, { takeover: false })), {
    message: `run \`${run.id}\` is driven by another chat that is still open (session session-…). Give \`takeover: true\` to drive it from here; that chat then drives nothing.`,
  })
  assert.equal(w.record(run)?.driver.session, SESSION)
  const taken = await w.runs.withSession(OTHER_SESSION, () => w.runs.drive(OTHER_SESSION, run, { takeover: true }))
  assert.equal(taken.how, 'takenOver')
  assert.equal(taken.previous, SESSION)
  assert.deepEqual((await w.entries(run)).at(-1), { at: w.clock.now, run: run.id, kind: 'run.takenOver', by: 'harness', session: OTHER_SESSION, driver: OTHER_SESSION, previous: SESSION })
  assert.equal(await w.runs.driving(SESSION), undefined)
  w.live.clear()
  const resumed = await w.runs.withSession(SESSION, () => w.runs.drive(SESSION, run, { takeover: true }))
  assert.equal(resumed.how, 'resumed')
})

test('drive: an abandoned run is refused', async () => {
  const w = await world()
  const run = await w.open()
  await w.runs.withRun(run, () => w.runs.close(run, SESSION, { state: 'abandoned', reason: 'the user changed their mind' }))
  await assert.rejects(w.runs.withSession(SESSION, () => w.runs.drive(SESSION, run, { takeover: false })), {
    message: `run \`${run.id}\` was abandoned (the user changed their mind). Open a new run with \`run\` \`open\`.`,
  })
})

test('drive: a pr run whose worktree resolves is reopened: open, pr kept, no closedAt, the caller drives it, run.resumed with reopened', async () => {
  const w = await world()
  const run = await w.open()
  const pr = { url: 'https://github.com/Acme/widget/pull/7', number: 7 }
  await w.runs.withRun(run, () => w.runs.close(run, SESSION, { state: 'pr', pr }))
  w.clock.now += 60_000
  const reopened = await w.runs.withSession(OTHER_SESSION, () => w.runs.drive(OTHER_SESSION, run, { takeover: false }))
  assert.equal(reopened.how, 'reopened')
  const record = w.record(run)!
  assert.equal(record.state, 'open')
  assert.deepEqual(record.pr, pr)
  assert.equal(record.closedAt, undefined)
  assert.deepEqual(record.driver, { session: OTHER_SESSION, since: w.clock.now })
  assert.deepEqual((await w.entries(run)).at(-1), { at: w.clock.now, run: run.id, kind: 'run.resumed', by: 'harness', session: OTHER_SESSION, driver: OTHER_SESSION, reopened: true })
  assert.equal((await w.runs.driving(OTHER_SESSION))?.id, run.id)
})

test('drive: a pr run whose worktree is gone, or with no dish-workspaces, is refused with each text, and the record is unchanged', async () => {
  const w = await world()
  const run = await w.open()
  await w.runs.withRun(run, () => w.runs.close(run, SESSION, { state: 'pr', pr: { url: 'https://github.com/Acme/widget/pull/7', number: 7 } }))
  const before = w.record(run)
  w.absent.add('workspaces')
  await assert.rejects(w.runs.withSession(SESSION, () => w.runs.drive(SESSION, run, { takeover: false })), {
    message: `dish-workspaces isn't running, so run \`${run.id}\`'s worktree can't be checked`,
  })
  w.absent.delete('workspaces')
  w.worktrees.delete(run.worktree)
  await assert.rejects(w.runs.withSession(SESSION, () => w.runs.drive(SESSION, run, { takeover: false })), {
    message: `run \`${run.id}\` can't be reopened: its worktree is gone (the sweep removes it once its pull request https://github.com/Acme/widget/pull/7 is merged). Open a new run with \`run\` \`open\`.`,
  })
  assert.deepEqual(w.record(run), before)
})

test('drive: a pr run whose worktree fails dish\'s safety check is refused with resolveProblem\'s reason; one whose resolve rejects can\'t be checked', async () => {
  const w = await world()
  const run = await w.open()
  await w.runs.withRun(run, () => w.runs.close(run, SESSION, { state: 'pr', pr: { url: 'https://github.com/Acme/widget/pull/7', number: 7 } }))
  const before = w.record(run)
  w.worktrees.delete(run.worktree)
  w.workspaces.impl.resolveProblem = async () => 'Acme/widget\'s clone failed dish\'s safety check: core.hooksPath is set'
  await assert.rejects(w.runs.withSession(SESSION, () => w.runs.drive(SESSION, run, { takeover: false })), {
    message: `run \`${run.id}\` can't be reopened: its worktree ${run.worktree} can't be used: Acme/widget's clone failed dish's safety check: core.hooksPath is set. Fix that, or open a new run with \`run\` \`open\`.`,
  })
  assert.deepEqual(w.workspaces.calls.resolveProblem, [[run.worktree]])
  w.workspaces.impl.resolve = async () => { throw new Error(`git broke near ${TOKEN}`) }
  await assert.rejects(w.runs.withSession(SESSION, () => w.runs.drive(SESSION, run, { takeover: false })), {
    message: `run \`${run.id}\`'s worktree can't be checked: git broke near ${MASKED_TOKEN}`,
  })
  assert.deepEqual(w.record(run), before)
  assert.deepEqual(await w.kinds(run), ['run.opened', 'run.closed'])
})

test('drive: the caller\'s other run is released, and given back', async () => {
  const w = await world()
  const a = await w.open({ session: OTHER_SESSION, slug: 'first' })
  const mine = await w.open({ session: SESSION, slug: 'mine' })
  const driven = await w.runs.withSession(SESSION, () => w.runs.drive(SESSION, a, { takeover: false }))
  assert.equal(driven.released?.id, mine.id)
  assert.equal(w.record(mine)?.driver.session, '')
  assert.equal((await w.runs.driving(SESSION))?.id, a.id)
})

// --- harness, main, and the record's changes ----------------------------------------------------------------------------

test('harness takes only the harness\'s kinds, and main only the main agent\'s; an argument can\'t choose by', async () => {
  const w = await world()
  const run = await w.open()
  await assert.rejects(w.runs.harness(run, { kind: 'note', text: 'x' } as never), TypeError)
  await assert.rejects(w.runs.main(run, SESSION, { kind: 'gate.result' } as never), TypeError)
  await w.runs.main(run, SESSION, { kind: 'note', text: 'waiting', by: 'harness', at: 1, run: 'x' } as never)
  assert.deepEqual((await w.entries(run)).at(-1), { at: w.clock.now, run: run.id, kind: 'note', by: 'main', session: SESSION, text: 'waiting' })
  // Neither takes its time, a cut mark or (main) its session from what it is given.
  await w.runs.main(run, SESSION, { kind: 'note', text: 'forged', session: 'forged', cut: true, at: 1 } as never)
  assert.deepEqual((await w.entries(run)).at(-1), { at: w.clock.now, run: run.id, kind: 'note', by: 'main', session: SESSION, text: 'forged' })
  await w.runs.harness(run, { kind: 'task.removed', task: 'api', cut: true, at: 1 } as never)
  assert.deepEqual((await w.entries(run)).at(-1), { at: w.clock.now, run: run.id, kind: 'task.removed', by: 'harness', task: 'api' })
})

test('setGoal, attachPlan and close: the record and the entries; close releases the driver, and a second close with pr replaces the pr', async () => {
  const w = await world()
  const run = await w.open()
  const opened = w.clock.now
  const goaled = await w.runs.withRun(run, () => w.runs.setGoal(run, SESSION, `Fix it\nfor good ${TOKEN}`))
  assert.equal(goaled.goal, `Fix it for good ${MASKED_TOKEN}`)
  const planned = await w.runs.withRun(run, () => w.runs.attachPlan(run, SESSION, { path: 'docs/plans/x.md', commit: HEAD }))
  assert.deepEqual(planned.plan, { path: 'docs/plans/x.md', commit: HEAD })
  w.clock.now += 1000
  const closed = await w.runs.withRun(run, () => w.runs.close(run, SESSION, { state: 'pr', pr: { url: 'https://github.com/Acme/widget/pull/1', number: 1 } }))
  assert.deepEqual({ state: closed.state, pr: closed.pr, closedAt: closed.closedAt, driver: closed.driver },
    { state: 'pr', pr: { url: 'https://github.com/Acme/widget/pull/1', number: 1 }, closedAt: w.clock.now, driver: { session: '', since: w.clock.now } })
  assert.equal(await w.runs.driving(SESSION), undefined)
  const again = await w.runs.withRun(run, () => w.runs.close(run, SESSION, { state: 'pr', pr: { url: 'https://github.com/Acme/widget/pull/2', number: 2 } }))
  assert.deepEqual(again.pr, { url: 'https://github.com/Acme/widget/pull/2', number: 2 })
  const entries = await w.entries(run)
  assert.deepEqual(entries.map(entry => entry.kind), ['run.opened', 'run.goal', 'run.plan', 'run.closed', 'run.closed'])
  assert.deepEqual(entries[1], { at: opened, run: run.id, kind: 'run.goal', by: 'harness', session: SESSION, goal: `Fix it for good ${MASKED_TOKEN}` })
  assert.deepEqual(entries[2], { at: opened, run: run.id, kind: 'run.plan', by: 'harness', session: SESSION, path: 'docs/plans/x.md', commit: HEAD })
  assert.deepEqual(entries[3], { at: w.clock.now, run: run.id, kind: 'run.closed', by: 'harness', session: SESSION, state: 'pr', pr: { url: 'https://github.com/Acme/widget/pull/1', number: 1 } })
  const other = await w.open({ slug: 'dropped' })
  await w.runs.withRun(other, () => w.runs.close(other, SESSION, { state: 'abandoned', reason: 'not\nneeded' }))
  assert.deepEqual((await w.entries(other)).at(-1), { at: w.clock.now, run: other.id, kind: 'run.closed', by: 'harness', session: SESSION, state: 'abandoned', reason: 'not needed' })
  assert.equal(w.record(other)?.reason, 'not needed')
})

test('summary is summarize over the run\'s ledger', async () => {
  const w = await world()
  const run = await w.open()
  await w.runs.worktreeCreated(SESSION, await w.created('api'))
  const summary = await w.runs.summary(run)
  assert.deepEqual(summary.tasks.map(task => task.task), ['fix-login', 'api'])
})
