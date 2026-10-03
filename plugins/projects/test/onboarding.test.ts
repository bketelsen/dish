import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { format } from 'node:util'
import { Onboarding } from '../src/onboarding.ts'
import type { WorkspacesDriver } from '../src/onboarding.ts'
import { StatusStore } from '../src/status.ts'
import type { ProjectStatus } from '../src/status.ts'
import { fakeDriver, project, tempDir } from './helpers.ts'

const TOKEN = `ghs_${'a1B2'.repeat(9)}`
const READY: ProjectStatus = { state: 'ready', at: 1, readyAt: 1 }

/** Let every promise that is ready to settle do so, and a timer turn or two pass. */
const settle = () => new Promise(resolve => setTimeout(resolve, 20))

/** An onboarding queue over a fresh status store, the fake driver, a clock the test sets, and what it emitted and logged. */
async function harness(options: { file?: string, abortGraceMs?: number } = {}) {
  const status = new StatusStore(options.file ?? join(await tempDir(), 'projects', 'status.json'))
  await status.load().catch(() => {})
  const fake = fakeDriver()
  const state: { driver: WorkspacesDriver | undefined, clock: number, onEmit?: (name: string, value: ProjectStatus) => void } = { driver: fake.driver, clock: 100 }
  const events: Array<[string, ProjectStatus]> = []
  const logs: string[] = []
  const onboarding = new Onboarding({
    status,
    workspaces: () => state.driver,
    emit: (name, value) => {
      events.push([name, value])
      state.onEmit?.(name, value)
    },
    logger: {
      info: (...args: [string, ...unknown[]]) => { logs.push(`info: ${format(...args)}`) },
      warn: (...args: [string, ...unknown[]]) => { logs.push(`warn: ${format(...args)}`) },
    },
    now: () => state.clock,
    ...options.abortGraceMs === undefined ? {} : { abortGraceMs: options.abortGraceMs },
  })
  return { status, fake, state, events, logs, onboarding }
}

test('jobs run one at a time, in the order they were queued', async () => {
  const { fake, onboarding, status } = await harness()
  await status.set('acme/c', READY)
  onboarding.enqueue(project('acme/a'), 'onboard')
  onboarding.enqueue(project('acme/b'), 'onboard')
  onboarding.enqueue(project('acme/c'), 'prepare')
  const a = await fake.next('onboard', 'acme/a')
  await settle()
  assert.equal(fake.calls.length, 1)
  a.resolve()
  const b = await fake.next('onboard', 'acme/b')
  await settle()
  assert.equal(fake.calls.length, 2)
  b.resolve()
  const c = await fake.next('prepare', 'acme/c')
  c.resolve()
  await onboarding.idle()
  assert.deepEqual(fake.calls.map(call => `${call.kind} ${call.project.name}`), ['onboard acme/a', 'onboard acme/b', 'prepare acme/c'])
})

test('a project already queued or running is not queued twice, and a queued one runs with the newest fields', async () => {
  const { fake, onboarding } = await harness()
  onboarding.enqueue(project('acme/a'), 'onboard')
  const a = await fake.next('onboard', 'acme/a')
  onboarding.enqueue(project('acme/b'), 'onboard')
  onboarding.enqueue(project('Acme/B', { gate: 'make check' }), 'onboard')
  // Running: not queued again.
  onboarding.enqueue(project('acme/a', { gate: 'other' }), 'onboard')
  a.resolve()
  const b = await fake.next('onboard', 'Acme/B')
  assert.equal(b.project.gate, 'make check')
  b.resolve()
  await onboarding.idle()
  assert.deepEqual(fake.calls.map(call => `${call.kind} ${call.project.name}`), ['onboard acme/a', 'onboard Acme/B'])
})

test('a queued prepare becomes an onboarding when one is asked for, and one asked for while a prepare runs waits for it', async () => {
  const { fake, onboarding, status } = await harness()
  await status.set('acme/a', READY)
  await status.set('acme/b', READY)
  onboarding.enqueue(project('acme/a'), 'prepare')
  onboarding.enqueue(project('acme/b'), 'prepare')
  onboarding.enqueue(project('acme/b'), 'onboard')
  const prepareA = await fake.next('prepare', 'acme/a')
  onboarding.enqueue(project('acme/a'), 'onboard')
  // A second prepare of the one running is nothing new.
  onboarding.enqueue(project('acme/a'), 'prepare')
  prepareA.resolve()
  ;(await fake.next('onboard', 'acme/b')).resolve()
  ;(await fake.next('onboard', 'acme/a')).resolve()
  await onboarding.idle()
  assert.deepEqual(fake.calls.map(call => `${call.kind} ${call.project.name}`), ['prepare acme/a', 'onboard acme/b', 'onboard acme/a'])
})

test('progress moves the status through cloning and setup to ready, and each change is set and emitted', async () => {
  const { fake, onboarding, status, state, events } = await harness()
  onboarding.enqueue(project('acme/a'), 'onboard')
  const call = await fake.next('onboard', 'acme/a')
  assert.ok(call.signal instanceof AbortSignal)
  assert.equal(call.signal.aborted, false)

  call.progress('installation')
  assert.deepEqual(status.get('acme/a'), { state: 'cloning', step: 'installation', at: 100 })
  state.clock = 101
  call.progress('clone')
  call.progress('configure')
  assert.deepEqual(status.get('acme/a'), { state: 'cloning', step: 'configure', at: 101 })
  state.clock = 102
  call.progress('setup')
  assert.deepEqual(status.get('acme/a'), { state: 'setup', step: 'setup', at: 102 })
  call.progress('workspace')
  assert.deepEqual(status.get('acme/a'), { state: 'setup', step: 'workspace', at: 102 })
  state.clock = 200
  call.resolve({ setup: { ran: true } })
  await onboarding.idle()
  assert.deepEqual(status.get('acme/a'), { state: 'ready', at: 200, readyAt: 200 })
  assert.deepEqual(events.map(([name, value]) => `${name} ${value.state} ${value.step ?? '-'}`), [
    'acme/a cloning installation', 'acme/a cloning clone', 'acme/a cloning configure',
    'acme/a setup setup', 'acme/a setup workspace', 'acme/a ready -',
  ])
})

test('a setup that was skipped is recorded with its reason; a project with no setup has nothing skipped', async () => {
  const { fake, onboarding, status } = await harness()
  const reason = 'setup didn\'t run outside the sandbox: the checkout isn\'t clean. Run it yourself in /w/acme/a: make'
  onboarding.enqueue(project('acme/a', { setup: 'make' }), 'onboard')
  ;(await fake.next('onboard', 'acme/a')).resolve({ setup: { ran: false, reason } })
  onboarding.enqueue(project('acme/b'), 'onboard')
  ;(await fake.next('onboard', 'acme/b')).resolve({ setup: { ran: false, reason: 'no setup' } })
  await onboarding.idle()
  assert.deepEqual(status.get('acme/a'), { state: 'ready', at: 100, readyAt: 100, setupSkipped: reason })
  assert.deepEqual(status.get('acme/b'), { state: 'ready', at: 100, readyAt: 100 })
})

test('a failure records the step it failed at and the error\'s message, with anything like a credential masked', async () => {
  const { fake, onboarding, status, events, logs } = await harness()
  onboarding.enqueue(project('acme/a'), 'onboard')
  const call = await fake.next('onboard', 'acme/a')
  call.progress('installation')
  call.progress('clone')
  call.reject(new Error(`git clone failed (exit 128): remote said ${TOKEN}`))
  await onboarding.idle()
  const failed = status.get('acme/a')
  assert.equal(failed.state, 'failed')
  assert.equal(failed.step, 'clone')
  assert.match(failed.message!, /^git clone failed \(exit 128\): remote said /)
  assert.doesNotMatch(failed.message!, /ghs_/)
  assert.equal(events.at(-1)![1].state, 'failed')
  assert.ok(logs.some(line => line.startsWith('warn: ') && line.includes('acme/a')), logs.join('\n'))
  assert.ok(logs.every(line => !line.includes(TOKEN)))

  // Before any progress, and with a driver that throws rather than rejects.
  const thrower = await harness()
  thrower.state.driver = { onboard: () => { throw new Error('install the dish App on acme and give it b') }, prepare: async () => {} }
  thrower.onboarding.enqueue(project('acme/b'), 'onboard')
  await thrower.onboarding.idle()
  assert.deepEqual(thrower.status.get('acme/b'), { state: 'failed', message: 'install the dish App on acme and give it b', at: 100 })
})

test('a long message is cut short', async () => {
  const { fake, onboarding, status } = await harness()
  onboarding.enqueue(project('acme/a'), 'onboard')
  ;(await fake.next('onboard', 'acme/a')).reject(new Error('x'.repeat(10_000)))
  await onboarding.idle()
  const message = status.get('acme/a').message!
  assert.ok(message.length <= 1001, String(message.length))
  assert.ok(message.endsWith('…'))
})

test('cancelling a queued job means it never runs, and nothing is recorded for it', async () => {
  const { fake, onboarding, status, events } = await harness()
  onboarding.enqueue(project('acme/a'), 'onboard')
  onboarding.enqueue(project('acme/b'), 'onboard')
  onboarding.enqueue(project('acme/c'), 'onboard')
  const a = await fake.next('onboard', 'acme/a')
  onboarding.cancel('ACME/B')
  a.resolve()
  ;(await fake.next('onboard', 'acme/c')).resolve()
  await onboarding.idle()
  assert.deepEqual(fake.calls.map(call => call.project.name), ['acme/a', 'acme/c'])
  assert.deepEqual(status.get('acme/b'), { state: 'pending', at: 0 })
  assert.ok(events.every(([name]) => name !== 'acme/b'))
  // Cancelling what isn't there is fine.
  onboarding.cancel('acme/nothing')
})

test('cancelling the running job aborts its signal and records nothing more; the next job waits until it has settled', async () => {
  const { fake, onboarding, status, events } = await harness()
  onboarding.enqueue(project('acme/a'), 'onboard')
  onboarding.enqueue(project('acme/b'), 'onboard')
  const a = await fake.next('onboard', 'acme/a')
  a.progress('clone')
  const before = events.length
  onboarding.cancel('Acme/A')
  assert.equal(a.signal!.aborted, true)
  // Progress after the abort is not recorded.
  a.progress('setup')
  assert.deepEqual(status.get('acme/a'), { state: 'cloning', step: 'clone', at: 100 })
  // One at a time: the aborted job is still running (its setup being killed, say).
  await settle()
  assert.equal(fake.calls.length, 1)
  a.reject(new DOMException('The operation was aborted.', 'AbortError'))
  const b = await fake.next('onboard', 'acme/b')
  b.resolve()
  await onboarding.idle()
  assert.equal(events.slice(before).filter(([name]) => name === 'acme/a').length, 0)
  assert.equal(status.get('acme/a').state, 'cloning')

  // A cancelled job that succeeds anyway records nothing either.
  onboarding.enqueue(project('acme/c'), 'onboard')
  const c = await fake.next('onboard', 'acme/c')
  onboarding.cancel('acme/c')
  c.resolve()
  await onboarding.idle()
  assert.deepEqual(status.get('acme/c'), { state: 'pending', at: 0 })
})

test('without dish-workspaces an onboarding leaves the project pending and says why, and a prepare does nothing', async () => {
  const { onboarding, status, state, events } = await harness()
  state.driver = undefined
  await status.set('acme/ready', READY)
  onboarding.enqueue(project('acme/a'), 'onboard')
  onboarding.enqueue(project('acme/ready'), 'prepare')
  await onboarding.idle()
  assert.deepEqual(status.get('acme/a'), { state: 'pending', message: 'dish-workspaces isn\'t running', at: 100 })
  assert.deepEqual(status.get('acme/ready'), READY)
  assert.deepEqual(events.map(([name, value]) => `${name} ${value.state}`), ['acme/a pending'])
})

test('dish-workspaces appearing while a job is still recording that it waits for it: the project is queued again, not dropped', async () => {
  const { fake, onboarding, status, state } = await harness()
  // The plugin's restart pass (dish-workspaces appeared) queues the project while the job that found no driver, or saw
  // the driver go, is still saving its pending status: the job is still the running one then. (The flake of
  // plugin.test.ts's "without dish-workspaces …" under load: the status file's write outlasted the pass.)
  const comesBack = (): void => {
    state.onEmit = (name, value) => {
      if (name !== 'acme/a' || value.message !== 'dish-workspaces isn\'t running') return
      state.onEmit = undefined
      state.driver = fake.driver
      onboarding.enqueue(project('acme/a'), 'onboard')
    }
  }

  // No driver when the job starts.
  state.driver = undefined
  comesBack()
  onboarding.enqueue(project('acme/a'), 'onboard')
  ;(await fake.next('onboard', 'acme/a')).resolve()
  await onboarding.idle()
  assert.equal(status.get('acme/a').state, 'ready')

  // The driver gone under a running onboarding (its close rejected it, with no interrupt first).
  onboarding.enqueue(project('acme/a'), 'onboard')
  const call = await fake.next('onboard', 'acme/a')
  state.driver = undefined
  comesBack()
  call.reject(new DOMException('The operation was aborted.', 'AbortError'))
  ;(await fake.next('onboard', 'acme/a')).resolve()
  await onboarding.idle()
  assert.equal(status.get('acme/a').state, 'ready')
  assert.deepEqual(fake.calls.map(entry => `${entry.kind} ${entry.project.name}`), ['onboard acme/a', 'onboard acme/a', 'onboard acme/a'])
})

test('a prepare that fails marks the project failed; one that succeeds leaves it ready; one for a project no longer ready is skipped', async () => {
  const { fake, onboarding, status } = await harness()
  await status.set('acme/a', READY)
  await status.set('acme/b', READY)
  onboarding.enqueue(project('acme/a'), 'prepare')
  onboarding.enqueue(project('acme/b'), 'prepare')
  onboarding.enqueue(project('acme/c'), 'prepare')
  ;(await fake.next('prepare', 'acme/a')).reject(new Error('acme/a\'s clone has core.hooksPath set, which dish won\'t run git with'))
  ;(await fake.next('prepare', 'acme/b')).resolve()
  await onboarding.idle()
  assert.deepEqual(status.get('acme/a'), { state: 'failed', step: 'configure', message: 'acme/a\'s clone has core.hooksPath set, which dish won\'t run git with', at: 100 })
  assert.deepEqual(status.get('acme/b'), READY)
  // acme/c was pending, not ready: no prepare.
  assert.deepEqual(fake.calls.map(call => `${call.kind} ${call.project.name}`), ['prepare acme/a', 'prepare acme/b'])
})

test('interrupt (dish-workspaces went away) aborts the running onboarding and leaves it pending, waiting; the queue goes on', async () => {
  const { fake, onboarding, status, state, events } = await harness()
  onboarding.enqueue(project('acme/a'), 'onboard')
  onboarding.enqueue(project('acme/b'), 'onboard')
  const a = await fake.next('onboard', 'acme/a')
  a.progress('clone')
  state.driver = undefined
  state.clock = 150
  onboarding.interrupt()
  assert.equal(a.signal!.aborted, true)
  assert.deepEqual(status.get('acme/a'), { state: 'pending', message: 'dish-workspaces isn\'t running', at: 150 })
  // Twice is nothing more.
  onboarding.interrupt()
  // The driver's own close rejects it; that isn't a failure.
  a.reject(new DOMException('The operation was aborted.', 'AbortError'))
  await onboarding.idle()
  assert.deepEqual(status.get('acme/a'), { state: 'pending', message: 'dish-workspaces isn\'t running', at: 150 })
  assert.deepEqual(status.get('acme/b'), { state: 'pending', message: 'dish-workspaces isn\'t running', at: 150 })
  assert.ok(events.every(([, value]) => value.state !== 'failed'))
  // Queued again once it is back, it runs.
  state.driver = fake.driver
  onboarding.enqueue(project('acme/a'), 'onboard')
  ;(await fake.next('onboard', 'acme/a')).resolve()
  await onboarding.idle()
  assert.equal(status.get('acme/a').state, 'ready')

  // dish-workspaces gone before the interrupt: its close rejected the onboarding first. Not a failure either.
  onboarding.enqueue(project('acme/c'), 'onboard')
  const c = await fake.next('onboard', 'acme/c')
  state.driver = undefined
  c.reject(new Error('dish-workspaces is closing'))
  await onboarding.idle()
  assert.deepEqual(status.get('acme/c'), { state: 'pending', message: 'dish-workspaces isn\'t running', at: 150 })
  state.driver = fake.driver

  // A running prepare is aborted and its project stays ready; with nothing running, interrupt does nothing.
  onboarding.enqueue(project('acme/a'), 'prepare')
  const prepare = await fake.next('prepare', 'acme/a')
  onboarding.interrupt()
  prepare.reject(new Error('aborted'))
  await onboarding.idle()
  assert.equal(status.get('acme/a').state, 'ready')
  onboarding.interrupt()
})

test('close cancels the running job and the queue, and nothing is queued after it', async () => {
  const { fake, onboarding, status } = await harness()
  onboarding.enqueue(project('acme/a'), 'onboard')
  onboarding.enqueue(project('acme/b'), 'onboard')
  const a = await fake.next('onboard', 'acme/a')
  a.progress('clone')
  onboarding.close()
  assert.equal(a.signal!.aborted, true)
  a.reject(new DOMException('The operation was aborted.', 'AbortError'))
  onboarding.enqueue(project('acme/c'), 'onboard')
  await onboarding.idle()
  await settle()
  assert.deepEqual(fake.calls.map(call => call.project.name), ['acme/a'])
  assert.equal(status.get('acme/a').state, 'cloning')
  assert.deepEqual(status.get('acme/b'), { state: 'pending', at: 0 })
  // Twice is fine.
  onboarding.close()
})

test('a status that can\'t be written is logged, and onboarding goes on', async () => {
  const dir = await tempDir()
  // The status directory's parent is a file: nothing can be written there.
  await writeFile(join(dir, 'blocker'), 'x')
  const { fake, onboarding, status, logs } = await harness({ file: join(dir, 'blocker', 'projects', 'status.json') })
  onboarding.enqueue(project('acme/a'), 'onboard')
  const a = await fake.next('onboard', 'acme/a')
  a.progress('clone')
  a.resolve()
  await onboarding.idle()
  await settle()
  assert.equal(status.get('acme/a').state, 'ready')
  assert.ok(logs.some(line => /^warn: could not save the onboarding status/.test(line)), logs.join('\n'))
})

test('an interrupt that comes while a job records its end undoes nothing: ready stays ready, failed stays failed', async () => {
  const { fake, onboarding, status, state } = await harness()
  // dish-workspaces goes away just as the end is being written: the job is still the running one then.
  state.onEmit = (_name, value) => {
    if (value.state === 'ready' || value.state === 'failed') onboarding.interrupt()
  }
  onboarding.enqueue(project('acme/a'), 'onboard')
  const a = await fake.next('onboard', 'acme/a')
  a.progress('setup')
  a.resolve()
  await onboarding.idle()
  assert.deepEqual(status.get('acme/a'), { state: 'ready', at: 100, readyAt: 100 })

  onboarding.enqueue(project('acme/b'), 'onboard')
  ;(await fake.next('onboard', 'acme/b')).reject(new Error('install the dish App on acme and give it b'))
  await onboarding.idle()
  assert.equal(status.get('acme/b').state, 'failed')
})

test('an AbortError that dish-projects didn\'t cause is dish-workspaces closing: an onboarding is pending, a prepare stays ready, never failed', async () => {
  const abort = () => new DOMException('The operation was aborted.', 'AbortError')
  const { fake, onboarding, status, events } = await harness()
  // dish-workspaces' close rejects the work while the service is still there.
  onboarding.enqueue(project('acme/a'), 'onboard')
  const a = await fake.next('onboard', 'acme/a')
  a.progress('clone')
  a.reject(abort())
  await onboarding.idle()
  assert.deepEqual(status.get('acme/a'), { state: 'pending', message: 'dish-workspaces isn\'t running', at: 100 })

  await status.set('acme/b', READY)
  onboarding.enqueue(project('acme/b'), 'prepare')
  ;(await fake.next('prepare', 'acme/b')).reject(abort())
  await onboarding.idle()
  assert.deepEqual(status.get('acme/b'), READY)
  assert.ok(events.every(([, value]) => value.state !== 'failed'))
})

test('a prepare abandoned by dish-workspaces leaves the project ready, whichever comes first: the service gone, or the rejection', async () => {
  const { fake, onboarding, status, state, events } = await harness()
  await status.set('acme/a', READY)
  // The service is gone first, then the work fails with whatever it says.
  onboarding.enqueue(project('acme/a'), 'prepare')
  const first = await fake.next('prepare', 'acme/a')
  state.driver = undefined
  first.reject(new Error('dish-workspaces is closing'))
  await onboarding.idle()
  assert.deepEqual(status.get('acme/a'), READY)

  // The interrupt first (the service went), then the rejection.
  state.driver = fake.driver
  onboarding.enqueue(project('acme/a'), 'prepare')
  const second = await fake.next('prepare', 'acme/a')
  onboarding.interrupt()
  state.driver = undefined
  second.reject(new Error('dish-workspaces is closing'))
  await onboarding.idle()
  assert.deepEqual(status.get('acme/a'), READY)
  assert.deepEqual(events, [])
})

test('only the steps dish knows are recorded; anything else the driver reports is ignored', async () => {
  const { fake, onboarding, status, events } = await harness()
  onboarding.enqueue(project('acme/a'), 'onboard')
  const a = await fake.next('onboard', 'acme/a')
  a.progress('clone')
  for (const odd of ['constructor', '__proto__', '../../x', `token ${TOKEN}`, 'Clone', '']) a.progress(odd)
  a.progress(42 as unknown as string)
  assert.deepEqual(status.get('acme/a'), { state: 'cloning', step: 'clone', at: 100 })
  a.reject(new Error('git clone failed (exit 128)'))
  await onboarding.idle()
  assert.equal(status.get('acme/a').step, 'clone')
  assert.deepEqual(events.map(([, value]) => value.step ?? '-'), ['clone', 'clone'])
})

test('an aborted job that doesn\'t settle within the grace is logged once and left behind, and the queue goes on', async () => {
  const { fake, onboarding, status, logs } = await harness({ abortGraceMs: 60 })
  onboarding.enqueue(project('acme/a'), 'onboard')
  onboarding.enqueue(project('acme/b'), 'onboard')
  const a = await fake.next('onboard', 'acme/a')
  a.progress('setup')
  // The driver ignores the signal.
  onboarding.cancel('acme/a')
  await settle()
  assert.equal(fake.calls.length, 1)
  const b = await fake.next('onboard', 'acme/b')
  const told = logs.filter(line => line.startsWith('warn: onboarding acme/a didn\'t stop within'))
  assert.equal(told.length, 1, logs.join('\n'))
  // The one left behind ends at last: nothing is recorded, and b is still the running job.
  a.resolve()
  await settle()
  assert.equal(status.get('acme/a').state, 'setup')
  assert.equal(onboarding.onboarding('acme/b'), 'running')
  onboarding.cancel('acme/b')
  assert.equal(b.signal!.aborted, true)
  b.reject(new DOMException('The operation was aborted.', 'AbortError'))
  await onboarding.idle()

  // The same after an interrupt, and after close; a job that settles in time is not logged.
  onboarding.enqueue(project('acme/c'), 'onboard')
  const c = await fake.next('onboard', 'acme/c')
  onboarding.interrupt()
  await onboarding.idle()
  assert.equal(logs.filter(line => line.includes('acme/c didn\'t stop')).length, 1)
  c.resolve()
  onboarding.enqueue(project('acme/d'), 'onboard')
  const d = await fake.next('onboard', 'acme/d')
  onboarding.close()
  d.reject(new DOMException('The operation was aborted.', 'AbortError'))
  await onboarding.idle()
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(logs.filter(line => line.includes('acme/b didn\'t stop') || line.includes('acme/d didn\'t stop')).length, 0)
})

test('onboarding(name) says whether an onboarding is queued or running; a prepare or an aborted one doesn\'t count', async () => {
  const { fake, onboarding, status } = await harness()
  await status.set('acme/p', READY)
  onboarding.enqueue(project('acme/a'), 'onboard')
  onboarding.enqueue(project('acme/b'), 'onboard')
  onboarding.enqueue(project('acme/p'), 'prepare')
  const a = await fake.next('onboard', 'acme/a')
  assert.equal(onboarding.onboarding('ACME/A'), 'running')
  assert.equal(onboarding.onboarding('acme/b'), 'queued')
  assert.equal(onboarding.onboarding('acme/p'), undefined)
  assert.equal(onboarding.onboarding('acme/none'), undefined)
  onboarding.cancel('acme/a')
  assert.equal(onboarding.onboarding('acme/a'), undefined)
  a.reject(new DOMException('The operation was aborted.', 'AbortError'))
  ;(await fake.next('onboard', 'acme/b')).resolve()
  const p = await fake.next('prepare', 'acme/p')
  assert.equal(onboarding.onboarding('acme/p'), undefined)
  p.resolve()
  await onboarding.idle()
})

test('close starts no grace timer and clears one already running: nothing is logged after the plugin is gone', async () => {
  // A job that never settles, closed.
  const first = await harness({ abortGraceMs: 40 })
  first.onboarding.enqueue(project('acme/a'), 'onboard')
  const a = await first.fake.next('onboard', 'acme/a')
  first.onboarding.close()
  assert.equal(a.signal!.aborted, true)

  // A job cancelled (its grace running), then closed before the grace runs out.
  const second = await harness({ abortGraceMs: 40 })
  second.onboarding.enqueue(project('acme/b'), 'onboard')
  const b = await second.fake.next('onboard', 'acme/b')
  second.onboarding.cancel('acme/b')
  assert.equal(b.signal!.aborted, true)
  second.onboarding.close()

  await new Promise(resolve => setTimeout(resolve, 150))
  assert.deepEqual(first.logs.filter(line => line.startsWith('warn:')), [])
  assert.deepEqual(second.logs.filter(line => line.startsWith('warn:')), [])
})
