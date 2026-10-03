/**
 * One gate at a time per worktree. The listener (a coder's gate) and `runAt` (open_pr's) share one `WorktreeLocks`, so a
 * coder's gate and an open_pr gate never run at once in a worktree.
 *
 * @module dish-gates/locks
 */

/**
 * One job at a time per key (a worktree's canonical path), in the order they came; other keys don't wait. A job whose
 * signal aborts while it waits doesn't run, and its caller gets `undefined` at once, while the jobs after it still wait
 * for the ones before it.
 */
export class WorktreeLocks {
  /** Per key, a promise that settles (never rejects) once the last job queued for it is done or gave up. */
  readonly #tails = new Map<string, Promise<void>>()

  async run<T>(key: string, signal: AbortSignal, job: () => Promise<T>): Promise<T | undefined> {
    const previous = this.#tails.get(key) ?? Promise.resolve()
    let release!: () => void
    const mine = new Promise<void>((settle) => { release = settle })
    const tail = previous.then(() => mine)
    this.#tails.set(key, tail)
    void tail.then(() => {
      if (this.#tails.get(key) === tail) this.#tails.delete(key)
    })
    try {
      if (!await settledFirst(previous, signal)) return undefined
      return await job()
    } finally {
      release()
    }
  }
}

/** Whether `promise` (which never rejects) settles before `signal` aborts. */
function settledFirst(promise: Promise<void>, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise((settle) => {
    const onAbort = (): void => { settle(false) }
    signal.addEventListener('abort', onAbort, { once: true })
    void promise.then(() => {
      signal.removeEventListener('abort', onAbort)
      settle(!signal.aborted)
    })
  })
}
