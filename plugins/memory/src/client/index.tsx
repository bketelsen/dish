/**
 * Browser half of dish-memory: **Settings → Memory**, through a `settings.section` entry.
 *
 * The page's state lives here (`controller.ts`), not in the component, and `watch` is followed from the moment the plugin
 * loads, so the remote line is current when the page opens and an open page refreshes as the vault and the directions change.
 */

import type { Context } from '@deepseek-ai/cordis'
import { RemoteStreamCarrierError } from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { MemoryEvent } from '../protocol.ts'
import { createMemoryPage, type MemoryPage } from './controller.ts'
import { Memory } from './Memory.tsx'
import { memoryRemote } from './remote.ts'
import './styles.ts'

export const inject = ['remote', 'slots']

/** The seat in Settings' nav: after History (50) and Runs (51). */
const ORDER = 52

/** How long `follow` waits before it opens `watch` again after the stream failed for good, and the longest it waits. */
const RETRY_FIRST_MS = 1_000
const RETRY_LONGEST_MS = 30_000

export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(memoryRemote)
  const ui = ctx.inject(['remote.dishMemory', 'slots'], registerMemory)
  try { await ui } catch (error) { await ui.dispose(); await disposeRemote(); throw error }
  return async () => { await ui.dispose(); await disposeRemote() }
}

function registerMemory(ctx: Context): void {
  const page = createMemoryPage(ctx.remote.dishMemory)
  const closing = new AbortController()
  ctx.effect(() => () => { closing.abort() }, 'dish-memory: live updates')
  void follow(ctx, page, closing.signal)

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'dish-memory',
    order: ORDER,
    label: () => 'Memory',
    inject: () => page.face,
  }, Memory))
}

/**
 * Keep reading `watch` until `closing` aborts. `ctx.remote.$stream` reopens it itself when the carrier drops or the server
 * ends it (a dish-memory reload ends it `done`, which `ended` turns into a retry). If the stream fails for good anyway (the
 * first reopening after a restart can come before the server has the service back), this opens a new one after a wait.
 */
async function follow(ctx: Context, page: MemoryPage, closing: AbortSignal): Promise<void> {
  let wait = RETRY_FIRST_MS
  let streams = 0
  while (!closing.aborted) {
    const number = ++streams
    const stream = ctx.remote.$stream<MemoryEvent>({
      name: 'dish-memory live updates',
      open: signal => ctx.remote.dishMemory.watch(signal),
      ended: () => new RemoteStreamCarrierError('dish-memory stream ended'),
      carrierFailed: () => { page.streamDown() },
    })
    const stop = (): void => { void stream.dispose() }
    closing.addEventListener('abort', stop, { once: true })
    let lastGeneration: number | undefined
    let failure: unknown
    try {
      for await (const item of stream) {
        // The first item of a stream, or of a new generation of one (after the carrier was lost and found again): events may have been missed.
        void page.onEvent(item.value, item.generation !== lastGeneration)
        lastGeneration = item.generation
        item.accept()
        wait = RETRY_FIRST_MS
      }
    } catch (error) {
      // Not a carrier loss (those are retried inside the stream): the page says updates stopped and tries again below.
      failure = error
    } finally {
      closing.removeEventListener('abort', stop)
      await stream.dispose()
    }
    if (closing.aborted) return
    page.streamDown()
    console.warn(`dish-memory: live updates failed (stream ${number}), retrying in ${Math.round(wait / 1000)}s`, failure)
    await sleep(wait, closing)
    wait = Math.min(wait * 2, RETRY_LONGEST_MS)
  }
}

/** Wait `ms`, or until `signal` aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })
}
