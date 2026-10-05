/**
 * Following one `watch` stream for as long as the tab (or the header button) wants it: dish-config's `follow`, with an uplink.
 *
 * `ctx.remote.$stream` reopens the stream itself when the carrier drops or the host ends it; each reopening is a new
 * generation, a new handle, and the host starts over (hello, the state, the newest frame). So:
 * - each generation is told again what it must know (`opened`): the tab says whether it wants frames;
 * - `send` goes to the current generation's handle, and is dropped between generations: input for a page the tab can't see
 *   yet means nothing, and the next generation starts from `opened`;
 * - the `hello` that opens a generation is accepted, which tells `$stream` the generation got going;
 * - if the stream fails for good anyway, a new one opens after a wait: 1 s, doubling to 30 s.
 *
 * The two shapes of `ctx.remote.$stream` it uses are declared here structurally (dsh-api-gateway
 * `lib/types/client/remote-stream.d.ts`), so this module and its tests need nothing that only a browser can load. The one
 * thing it can't make is the gateway's `RemoteStreamCarrierError`, which `ended` must answer for `$stream` to reopen the
 * stream: `index.tsx` wraps `$stream` and turns `ended`'s error into one.
 */

import type { RemoteStreamHandle } from '@deepseek-ai/dsh-typert-protocol'
import type { Down, Up } from '../protocol.ts'

/** What `$stream` is asked to do (`RemoteStreamOptions`). */
export interface StreamOptions<T> {
  name: string
  open(signal: AbortSignal): AsyncIterable<T>
  ended(accepted: boolean): Error
  carrierFailed?(error: Error): void
}

/** What `$stream` answers (`RemoteStream`): the items, each with its generation, and a way to stop. */
export interface Stream<T> extends AsyncIterable<{ generation: number, value: T, accept(): void }> {
  dispose(): Promise<void>
}

export interface Follower {
  /** Send one item up the current generation's uplink; dropped when there is none. */
  send(up: Up): void
  /** Stop following, and wait until the stream has let go. */
  dispose(): Promise<void>
}

/** The stream's name, for `$stream`'s diagnostics. */
export const STREAM_NAME = 'dish-browser watch'
/** What `ended` says: the host ended a generation (a reload of dish-browser, say). */
export const ENDED_MESSAGE = 'Browser stream ended'
/** How long `follow` waits before it opens the stream again after it failed for good, and the longest it waits. */
export const RETRY_FIRST_MS = 1_000
export const RETRY_LONGEST_MS = 30_000

/**
 * Follow a stream until the answer's `dispose`.
 * @param options.open - open one generation (`ctx.remote.dishBrowser.watch(id, signal)`).
 * @param options.stream - `ctx.remote.$stream`.
 * @param options.opened - a new generation opened: send what it must know again.
 * @param options.receive - one item; `fresh` when it is the first of its generation.
 * @param options.down - the carrier dropped, or the stream failed: what is shown may be stale until the next `hello`.
 */
export function follow(options: {
  open(signal: AbortSignal): RemoteStreamHandle<Down, Up>
  stream(options: StreamOptions<Down>): Stream<Down>
  opened(send: (up: Up) => void): void
  receive(down: Down, fresh: boolean): void
  down(): void
}): Follower {
  const closing = new AbortController()
  let current: RemoteStreamHandle<Down, Up> | undefined
  let stream: Stream<Down> | undefined

  const send = (up: Up): void => {
    if (closing.signal.aborted || current === undefined) return
    try {
      current.send(up)
    } catch {
      // That generation has ended; the next one starts again from `opened`.
    }
  }

  const run = async (): Promise<void> => {
    let wait = RETRY_FIRST_MS
    while (!closing.signal.aborted) {
      try {
        const opened = options.stream({
          name: STREAM_NAME,
          open: (signal) => {
            const handle = options.open(signal)
            current = handle
            options.opened(send)
            return handle
          },
          ended: () => new Error(ENDED_MESSAGE),
          carrierFailed: () => {
            current = undefined
            if (!closing.signal.aborted) options.down()
          },
        })
        stream = opened
        let last: number | undefined
        try {
          for await (const item of opened) {
            if (closing.signal.aborted) break
            if (item.value.kind === 'hello') {
              item.accept()
              wait = RETRY_FIRST_MS
            }
            const fresh = item.generation !== last
            last = item.generation
            options.receive(item.value, fresh)
          }
        } finally {
          current = undefined
          await opened.dispose()
        }
      } catch {
        // Not a carrier loss (those are retried inside the stream): the stream failed for good. Below, it opens again.
      }
      if (closing.signal.aborted) return
      options.down()
      await sleep(wait, closing.signal)
      wait = Math.min(wait * 2, RETRY_LONGEST_MS)
    }
  }

  const done = run()
  return {
    send,
    async dispose() {
      if (!closing.signal.aborted) closing.abort()
      await stream?.dispose()
      await done
    },
  }
}

/** Wait `ms`, or until `signal` aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const done = (): void => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })
}
