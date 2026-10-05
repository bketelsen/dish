/**
 * Time, as the core and the stream read it: the system's, or a manual one in tests.
 *
 * @module dish-browser/clock
 */

export interface Clock {
  now(): number
  /** Run `run` after `ms`. The returned function cancels it. Real timers are unref'd. */
  after(ms: number, run: () => void): () => void
}

/** `Date.now()` and `setTimeout`, unref'd so that no timer of dish-browser's keeps dsh's process alive. */
export const systemClock: Clock = {
  now: () => Date.now(),
  after(ms, run) {
    const timer = setTimeout(run, Math.max(0, ms))
    timer.unref()
    return () => { clearTimeout(timer) }
  },
}
