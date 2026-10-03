import { test } from 'node:test'
import assert from 'node:assert/strict'
import { KeyedLock } from '../src/locks.ts'

interface Gate {
  promise: Promise<void>
  open(): void
}

function gate(): Gate {
  let open!: () => void
  const promise = new Promise<void>(resolve => { open = resolve })
  return { promise, open }
}

const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

test('jobs for one key run one at a time, in the order they came', async () => {
  const lock = new KeyedLock()
  const seen: string[] = []
  const first = gate()
  const second = gate()
  const a = lock.run('acme/widget', async () => { seen.push('a start'); await first.promise; seen.push('a end'); return 'a' })
  const b = lock.run('acme/widget', async () => { seen.push('b start'); await second.promise; seen.push('b end'); return 'b' })
  const c = lock.run('acme/widget', async () => { seen.push('c'); return 'c' })
  await tick()
  assert.deepEqual(seen, ['a start'])
  second.open()
  await tick()
  assert.deepEqual(seen, ['a start'], 'b waits for a even when it could finish')
  first.open()
  assert.deepEqual(await Promise.all([a, b, c]), ['a', 'b', 'c'])
  assert.deepEqual(seen, ['a start', 'a end', 'b start', 'b end', 'c'])
})

test("other keys don't wait", async () => {
  const lock = new KeyedLock()
  const held = gate()
  const slow = lock.run('acme/widget', async () => { await held.promise; return 'slow' })
  assert.equal(await lock.run('acme/gadget', async () => 'quick'), 'quick')
  held.open()
  assert.equal(await slow, 'slow')
})

test("a job that fails, or throws before its first await, doesn't stop the next", async () => {
  const lock = new KeyedLock()
  const failing = lock.run('k', async () => { throw new Error('boom') })
  const throwing = lock.run('k', () => { throw new Error('sync boom') })
  const next = lock.run('k', async () => 'next')
  await assert.rejects(failing, /boom/)
  await assert.rejects(throwing, /sync boom/)
  assert.equal(await next, 'next')
})

test('busy is true while a job for the key runs or waits, and false once all are done', async () => {
  const lock = new KeyedLock()
  assert.equal(lock.busy('k'), false)
  const held = gate()
  const first = lock.run('k', () => held.promise)
  const second = lock.run('k', async () => {})
  assert.equal(lock.busy('k'), true)
  assert.equal(lock.busy('other'), false)
  held.open()
  await first
  assert.equal(lock.busy('k'), true, 'the second is still to run')
  await second
  assert.equal(lock.busy('k'), false)
  await assert.rejects(lock.run('k', async () => { throw new Error('x') }))
  assert.equal(lock.busy('k'), false, 'a failure frees the key too')
})
