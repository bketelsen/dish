/**
 * One lock per key: dish-workspaces' `KeyedLock`, copied (orchestrator imports no runtime code
 * from another dish plugin). orchestrator keeps two: one keyed by a session's id, one by a run's ref. A session's lock is
 * always taken before a run's, never the other way round, and neither is ever taken by a `dishRuns` hook that another
 * plugin calls under a lock of its own.
 *
 * @module dish-orchestrator/locks
 */

export class KeyedLock {
  /** Per key, a promise that settles (never rejects) when the last job queued for it has finished. */
  private readonly tails = new Map<string, Promise<void>>()
  /** Per key, how many jobs are running or waiting. */
  private readonly counts = new Map<string, number>()

  /** Run `job` once every job queued for `key` before it has finished. Jobs for one key run one at a time, in order; other keys don't wait. */
  run<T>(key: string, job: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1)
    // `job` is called inside `then`, so a job that throws before it returns a promise is a rejection too.
    const result = previous.then(() => job())
    const tail = result.then(() => {}, () => {})
    this.tails.set(key, tail)
    return result.finally(() => {
      const left = (this.counts.get(key) ?? 1) - 1
      if (left > 0) {
        this.counts.set(key, left)
        return
      }
      this.counts.delete(key)
      this.tails.delete(key)
    })
  }

  /** Whether a job for `key` is running or waiting. */
  busy(key: string): boolean {
    return (this.counts.get(key) ?? 0) > 0
  }
}
