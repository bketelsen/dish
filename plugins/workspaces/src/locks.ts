/**
 * One lock per key (a project's name): onboarding, fetches, `create`, `remove` and the sweep of one clone never overlap,
 * and different projects never wait for each other.
 *
 * @module dish-workspaces/locks
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
