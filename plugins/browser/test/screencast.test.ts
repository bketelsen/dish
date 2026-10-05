/**
 * `FramePacer`, over a manual clock: one frame in flight per watcher, the newest kept, at most 15 a second; an ack of the
 * frame in flight releases the next; frames off drops everything; two pacers on one feed pace on their own.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FRAME_RATE } from '../src/protocol.ts'
import type { FrameDown } from '../src/protocol.ts'
import { FramePacer } from '../src/screencast.ts'
import type { Frame } from '../src/types.ts'
import { ManualClock } from './fake-driver.ts'

const INTERVAL = 1000 / FRAME_RATE

function frame(seq: number): Frame {
  return { seq, data: `jpeg-${seq}`, width: 1280, height: 800 }
}

function paced(clock: ManualClock, minIntervalMs?: number): { pacer: FramePacer, sent: FrameDown[], seqs(): number[] } {
  const sent: FrameDown[] = []
  const pacer = new FramePacer(clock, down => { sent.push(down) }, minIntervalMs)
  return { pacer, sent, seqs: () => sent.map(down => down.seq) }
}

test('off: nothing is sent and nothing kept; turning on sends nothing old', () => {
  const clock = new ManualClock()
  const { pacer, sent } = paced(clock)
  pacer.offer(frame(1))
  pacer.ack(1)
  pacer.setOn(true)
  clock.advance(1000)
  assert.deepEqual(sent, [])
  assert.equal(clock.pending, 0)
})

test('on: a frame goes out at once, as a frame item', () => {
  const clock = new ManualClock()
  const { pacer, sent } = paced(clock)
  pacer.setOn(true)
  pacer.offer(frame(1))
  assert.deepEqual(sent, [{ kind: 'frame', seq: 1, data: 'jpeg-1', width: 1280, height: 800 }])
})

test('one in flight: later frames wait for the ack, however long; then only the newest goes', () => {
  const clock = new ManualClock()
  const { pacer, seqs } = paced(clock)
  pacer.setOn(true)
  pacer.offer(frame(1))
  pacer.offer(frame(2))
  pacer.offer(frame(3))
  clock.advance(10_000)
  assert.deepEqual(seqs(), [1])
  pacer.ack(1)
  assert.deepEqual(seqs(), [1, 3])
  pacer.ack(3)
  clock.advance(10_000)
  assert.deepEqual(seqs(), [1, 3], 'nothing pending: nothing more')
})

test('the newest is kept by its number: an older frame offered late is dropped', () => {
  const clock = new ManualClock()
  const { pacer, seqs } = paced(clock)
  pacer.setOn(true)
  pacer.offer(frame(5))
  pacer.offer(frame(7))
  pacer.offer(frame(6))
  pacer.offer(frame(5))
  pacer.ack(5)
  clock.advance(INTERVAL)
  assert.deepEqual(seqs(), [5, 7])
  pacer.ack(7)
  pacer.offer(frame(7))
  clock.advance(1000)
  assert.deepEqual(seqs(), [5, 7], 'the frame in flight is not sent again')
})

test('at most 15 a second: an ack that comes at once still waits out the interval, on a timer', () => {
  const clock = new ManualClock()
  const { pacer, seqs } = paced(clock)
  pacer.setOn(true)
  pacer.offer(frame(1))
  pacer.ack(1)
  pacer.offer(frame(2))
  assert.deepEqual(seqs(), [1])
  clock.advance(Math.floor(INTERVAL))
  assert.deepEqual(seqs(), [1])
  clock.advance(1)
  assert.deepEqual(seqs(), [1, 2])
})

test('at most 15 a second, with every frame acked at once and a new one every millisecond', () => {
  const clock = new ManualClock()
  const sent: number[] = []
  let next = 1
  // The watcher acks each frame as soon as it has it.
  const pacer: FramePacer = new FramePacer(clock, down => { sent.push(clock.now()); queueMicrotask(() => { pacer.ack(down.seq) }) })
  pacer.setOn(true)
  const start = clock.now()
  return (async () => {
    for (let ms = 0; ms < 1000; ms++) {
      pacer.offer(frame(next++))
      await Promise.resolve()
      clock.advance(1)
      await Promise.resolve()
    }
    // Sent at 0, 66.7, …, 933.3: fifteen before the second is out (the next is due at 1000).
    const inFirstSecond = sent.filter(at => at < start + 990)
    assert.equal(inFirstSecond.length, FRAME_RATE)
    assert.ok(sent.length <= FRAME_RATE + 1, `${sent.length} frames in 1 s`)
    pacer.dispose()
  })()
})

test('an ack releases the pending frame once the interval allows; a stray ack is ignored', () => {
  const clock = new ManualClock()
  const { pacer, seqs } = paced(clock)
  pacer.setOn(true)
  pacer.offer(frame(1))
  pacer.offer(frame(2))
  pacer.ack(7)
  pacer.ack(2)
  pacer.ack(0)
  clock.advance(1000)
  assert.deepEqual(seqs(), [1], 'only the frame in flight is acked')
  pacer.ack(1)
  assert.deepEqual(seqs(), [1, 2])
  pacer.ack(1)
  pacer.offer(frame(3))
  clock.advance(1000)
  assert.deepEqual(seqs(), [1, 2], 'a second ack of 1 releases nothing: 2 is in flight')
  pacer.ack(2)
  assert.deepEqual(seqs(), [1, 2, 3])
})

test('a custom interval', () => {
  const clock = new ManualClock()
  const { pacer, seqs } = paced(clock, 500)
  pacer.setOn(true)
  pacer.offer(frame(1))
  pacer.ack(1)
  pacer.offer(frame(2))
  clock.advance(499)
  assert.deepEqual(seqs(), [1])
  clock.advance(1)
  assert.deepEqual(seqs(), [1, 2])
})

test('off drops the pending frame and the in-flight mark; on again starts afresh, and the same frame may go again', () => {
  const clock = new ManualClock()
  const { pacer, seqs } = paced(clock)
  pacer.setOn(true)
  pacer.offer(frame(1))
  pacer.offer(frame(2))
  pacer.setOn(false)
  pacer.ack(1)
  clock.advance(1000)
  assert.deepEqual(seqs(), [1])
  assert.equal(clock.pending, 0)
  pacer.setOn(true)
  clock.advance(1000)
  assert.deepEqual(seqs(), [1], 'nothing was kept')
  // A watcher that turns frames on again gets the newest frame again, number and all.
  pacer.offer(frame(1))
  assert.deepEqual(seqs(), [1, 1], 'nothing is in flight now')
})

test('off with a timer set: the timer is cancelled', () => {
  const clock = new ManualClock()
  const { pacer, seqs } = paced(clock)
  pacer.setOn(true)
  pacer.offer(frame(1))
  pacer.ack(1)
  pacer.offer(frame(2))
  assert.equal(clock.pending, 1)
  pacer.setOn(false)
  assert.equal(clock.pending, 0)
  clock.advance(1000)
  assert.deepEqual(seqs(), [1])
})

test('setOn(true) twice changes nothing', () => {
  const clock = new ManualClock()
  const { pacer, seqs } = paced(clock)
  pacer.setOn(true)
  pacer.offer(frame(1))
  pacer.setOn(true)
  pacer.offer(frame(2))
  assert.deepEqual(seqs(), [1], '1 is still in flight')
})

test('two pacers on one feed each pace on their own', () => {
  const clock = new ManualClock()
  const fast = paced(clock)
  const slow = paced(clock)
  fast.pacer.setOn(true)
  slow.pacer.setOn(true)
  for (let seq = 1; seq <= 5; seq++) {
    fast.pacer.offer(frame(seq))
    slow.pacer.offer(frame(seq))
    clock.advance(100)
    fast.pacer.ack(fast.sent.at(-1)!.seq)
  }
  assert.deepEqual(fast.seqs(), [1, 2, 3, 4, 5])
  assert.deepEqual(slow.seqs(), [1], 'it never acked')
  slow.pacer.ack(1)
  assert.deepEqual(slow.seqs(), [1, 5])
})

test('dispose: its timer is cancelled and nothing goes after', () => {
  const clock = new ManualClock()
  const { pacer, seqs } = paced(clock)
  pacer.setOn(true)
  pacer.offer(frame(1))
  pacer.ack(1)
  pacer.offer(frame(2))
  pacer.dispose()
  assert.equal(clock.pending, 0)
  clock.advance(1000)
  pacer.setOn(true)
  pacer.offer(frame(3))
  pacer.ack(1)
  assert.deepEqual(seqs(), [1])
})
