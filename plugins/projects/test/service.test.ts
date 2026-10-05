import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { serializeProjects } from '../src/registry.ts'
import type { ProjectFields } from '../src/registry.ts'
import { createDishProjects } from '../src/service.ts'
import type { StoreReader } from '../src/service.ts'
import { StatusStore } from '../src/status.ts'
import { fakeDriver, tempDir, waitFor } from './helpers.ts'

const FIELDS: ProjectFields = { family: 'acme', role: 'a test project', gate: 'make check', gateTimeout: '2m' }

/** A store with a commit per registry text, whose `head` the test moves, and whose next `head` call it can hold. */
function fakeStore(texts: Record<string, string>, head: string) {
  const state = { head, held: undefined as undefined | { answer: string, release: () => void, released: Promise<void> } }
  const store: StoreReader = {
    async head() {
      const held = state.held
      if (held === undefined) return state.head
      state.held = undefined
      await held.released
      return held.answer
    },
    async read(_path: string, ref?: string) {
      return texts[ref ?? state.head]
    },
  }
  return {
    store,
    state,
    /** The next `head` call answers `answer`, once the test calls the returned release. */
    holdNextHead(answer: string): () => void {
      let release = (): void => {}
      const released = new Promise<void>((resolve) => { release = resolve })
      state.held = { answer, release, released }
      return release
    },
  }
}

test('a retry that read the registry before a pass removed the project is refused, and nothing is onboarded', async () => {
  const texts = {
    c1: serializeProjects({ 'acme/gone': FIELDS }),
    c2: serializeProjects({}),
  }
  const fake = fakeStore(texts, 'c1')
  const driver = fakeDriver()
  const status = new StatusStore(join(await tempDir(), 'projects', 'status.json'))
  const service = createDishProjects({
    store: () => fake.store,
    status,
    workspaces: () => driver.driver,
    changed: () => {},
    emitStatus: () => {},
    logger: { info: () => {}, warn: () => {} },
  })
  try {
    await service.drive()
    ;(await driver.next('onboard', 'acme/gone')).reject(new Error('install the dish App on acme and give it gone'))
    await waitFor('the project to fail', () => service.status('acme/gone').state === 'failed')

    // The retry reads the registry at c1, but its answer comes only after a pass has seen c2, without the project.
    const release = fake.holdNextHead('c1')
    const retrying = service.retry('acme/gone').then(() => undefined, (error: unknown) => error as Error)
    fake.state.head = 'c2'
    await service.drive()
    assert.deepEqual(service.status('acme/gone'), { state: 'pending', at: 0 })
    release()
    const refused = await retrying
    assert.match(String(refused), /no project acme\/gone in projects\.yaml/)
    await service.idle()
    assert.deepEqual(driver.calls.map(call => `${call.kind} ${call.project.name}`), ['onboard acme/gone'])
    assert.deepEqual(service.status('acme/gone'), { state: 'pending', at: 0 })
  } finally {
    service.close()
    // Writes are serialized: this one lands after every write the service queued.
    await status.forget('acme/none').catch(() => {})
  }
})

test('a project that reads failed can be retried at once, while its onboarding is still saving that it failed', async () => {
  const fake = fakeStore({ c1: serializeProjects({ 'acme/widget': FIELDS }) }, 'c1')
  const driver = fakeDriver()
  const status = new StatusStore(join(await tempDir(), 'projects', 'status.json'))
  // The job's save of `failed` is held: it is in memory (and emitted) at once, and the job waits on the file. Under
  // load that write is slow, and a retry in the meantime was refused as being onboarded (the flake of remote.test.ts's
  // "retry onboards a failed project again").
  let release = (): void => {}
  const held = new Promise<void>((resolve) => { release = resolve })
  const set = status.set.bind(status)
  status.set = (name, value) => {
    const saving = set(name, value)
    return value.state === 'failed' ? held.then(() => saving) : saving
  }
  const service = createDishProjects({
    store: () => fake.store,
    status,
    workspaces: () => driver.driver,
    changed: () => {},
    emitStatus: () => {},
    logger: { info: () => {}, warn: () => {} },
  })
  try {
    await service.drive()
    ;(await driver.next('onboard', 'acme/widget')).reject(new Error('could not clone it'))
    await waitFor('the project to fail', () => service.status('acme/widget').state === 'failed')
    await service.retry('acme/widget')
    assert.equal(service.status('acme/widget').state, 'pending')
    // The second onboarding runs once the first has settled.
    release()
    ;(await driver.next('onboard', 'acme/widget')).resolve()
    await service.idle()
    assert.equal(service.status('acme/widget').state, 'ready')
    assert.deepEqual(driver.calls.map(call => `${call.kind} ${call.project.name}`), ['onboard acme/widget', 'onboard acme/widget'])
  } finally {
    release()
    service.close()
    await status.forget('acme/none').catch(() => {})
  }
})
