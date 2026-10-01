/**
 * Browser half of dish-config: **Settings → History**, through a `settings.section` entry.
 *
 * The page's state lives here (`controller.ts`), not in the component, and `watch` is followed from the moment the
 * plugin loads, so the remote line is current when the page opens and an open view refreshes as the store changes.
 */

import type { Context } from '@deepseek-ai/cordis'
import { RemoteStreamCarrierError } from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ConfigEvent } from '../protocol.ts'
import { createHistory, type HistoryController } from './controller.ts'
import { History } from './History.tsx'
import { configRemote } from './remote.ts'
import './styles.ts'

export const inject = ['remote', 'slots']

/** The seat in Settings' nav: after Models (10), Plugins (15) and Agents (20). */
const ORDER = 50

/** How long `follow` waits before it opens `watch` again after the stream failed for good, and the longest it waits. */
const RETRY_FIRST_MS = 1_000
const RETRY_LONGEST_MS = 30_000

export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(configRemote)
  const ui = ctx.inject(['remote.dishConfig', 'slots'], registerHistory)
  try { await ui } catch (error) { await ui.dispose(); await disposeRemote(); throw error }
  return async () => { await ui.dispose(); await disposeRemote() }
}

function registerHistory(ctx: Context): void {
  const history = createHistory(ctx.remote.dishConfig)
  const closing = new AbortController()
  ctx.effect(() => () => { closing.abort() }, 'dish-config: history stream')
  void follow(ctx, history, closing.signal)

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'dish-history',
    order: ORDER,
    label: () => 'History',
    inject: () => history.face,
  }, History))
}

/**
 * Keep reading `watch` until `closing` aborts. `ctx.remote.$stream` reopens it itself when the carrier drops or the
 * server ends it (a dish-config reload ends it `done`, which `ended` turns into a retry). If the stream fails for
 * good anyway (the first reopening after a restart can come before the server has the service back), this opens a
 * new one after a wait.
 */
async function follow(ctx: Context, history: HistoryController, closing: AbortSignal): Promise<void> {
  let wait = RETRY_FIRST_MS
  let streams = 0
  while (!closing.aborted) {
    const number = ++streams
    const stream = ctx.remote.$stream<ConfigEvent>({
      name: 'dish-config history',
      open: signal => ctx.remote.dishConfig.watch(signal),
      ended: () => new RemoteStreamCarrierError('History stream ended'),
      carrierFailed: () => { history.streamDown() },
    })
    const stop = (): void => { void stream.dispose() }
    closing.addEventListener('abort', stop, { once: true })
    let lastGeneration: number | undefined
    let failure: unknown
    try {
      for await (const item of stream) {
        history.receive(item.value, item.generation !== lastGeneration)
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
    history.streamDown()
    console.warn(`dish-config History: live updates failed, retrying in ${Math.round(wait / 1000)}s`, failure)
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
