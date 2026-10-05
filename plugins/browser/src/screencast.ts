/**
 * The picture's pace for one watcher: frames go out one at a time, each after the tab acks the one before, at most
 * `FRAME_RATE` a second. A slow connection gets fewer frames, never a backlog.
 *
 * The core runs one screencast per browser, shared by every frames-on watcher; each watcher's stream has a `FramePacer` of
 * its own, so each is paced on its own.
 *
 * @module dish-browser/screencast
 */

import type { Clock } from './clock.ts'
import { FRAME_RATE } from './protocol.ts'
import type { FrameDown } from './protocol.ts'
import type { Frame } from './types.ts'

export class FramePacer {
  private readonly clock: Clock
  private readonly send: (frame: FrameDown) => void
  private readonly minIntervalMs: number
  private on = false
  private disposed = false
  /** The frame sent and not yet acked. */
  private inFlight: number | undefined
  /** The newest frame offered and not yet sent. */
  private pending: Frame | undefined
  /** The highest frame number sent or kept since frames turned on: an older frame offered late is dropped. */
  private newest = Number.NEGATIVE_INFINITY
  private sentAt = Number.NEGATIVE_INFINITY
  private cancelTimer: (() => void) | undefined

  /**
   * @param clock - the time, and the timer for a frame that must wait out the interval.
   * @param send - one frame to the watcher.
   * @param minIntervalMs - the least time between two frames: `1000 / FRAME_RATE` by default.
   */
  constructor(clock: Clock, send: (frame: FrameDown) => void, minIntervalMs: number = 1000 / FRAME_RATE) {
    this.clock = clock
    this.send = send
    this.minIntervalMs = minIntervalMs
  }

  /** Frames on or off. Either way it starts afresh: nothing pending, nothing in flight. */
  setOn(on: boolean): void {
    if (this.disposed || on === this.on) return
    this.on = on
    this.reset()
  }

  /** A new frame of the page: sent now, or kept (only the newest) until the ack and the interval allow. Ignored while off. */
  offer(frame: Frame): void {
    if (!this.on || this.disposed || !(frame.seq > this.newest)) return
    this.newest = frame.seq
    this.pending = frame
    this.pump()
  }

  /** The tab drew frame `seq`. Only the frame in flight counts; any other ack is stray and changes nothing. */
  ack(seq: number): void {
    if (this.disposed || this.inFlight === undefined || seq !== this.inFlight) return
    this.inFlight = undefined
    this.pump()
  }

  dispose(): void {
    this.disposed = true
    this.on = false
    this.reset()
  }

  private reset(): void {
    this.pending = undefined
    this.inFlight = undefined
    this.newest = Number.NEGATIVE_INFINITY
    this.cancelTimer?.()
    this.cancelTimer = undefined
  }

  private pump(): void {
    if (!this.on || this.pending === undefined || this.inFlight !== undefined || this.cancelTimer !== undefined) return
    const wait = this.sentAt + this.minIntervalMs - this.clock.now()
    if (wait > 0) {
      this.cancelTimer = this.clock.after(wait, () => {
        this.cancelTimer = undefined
        this.pump()
      })
      return
    }
    const frame = this.pending
    this.pending = undefined
    this.inFlight = frame.seq
    this.sentAt = this.clock.now()
    this.send({ kind: 'frame', seq: frame.seq, data: frame.data, width: frame.width, height: frame.height })
  }
}
