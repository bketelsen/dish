/**
 * Browser half of dish-judge: **Settings → Judge**, through a `settings.section` entry.
 *
 * The page's state lives here (`controller.ts`), not in the component. The page needs dish-judge's own remote, and works with
 * that alone: the status and the test, the thresholds, and the decisions. Two more are optional, and looked for as services of
 * their own (`remote.credentials`, `remote.dishConfig`), so they can arrive after this plugin has loaded, and leave again:
 *
 * - **dsh's `credentials` remote** is how the key is set, removed and described. The key goes from the browser to dsh and
 *   to nobody else; dish-judge's server doesn't see it. Without the remote the key card says so.
 * - **dish-config's remote** gives the History tab, and `watch` is followed, so the thresholds refresh as the store changes.
 *   Without it the tab is hidden and nothing arrives live.
 */

import type { Context } from '@deepseek-ai/cordis'
import { RemoteStreamCarrierError } from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { createJudgePage } from './controller.ts'
import type { JudgeController } from './controller.ts'
import { Judge } from './Judge.tsx'
import { judgeRemote } from './remote.ts'
import type { ConfigEvent, ConfigHistoryApi } from './remote.ts'
import './styles.ts'

export const inject = ['remote', 'slots']

/** The seat in Settings' nav: after Prompts (45), and before History (50), whose tab this page repeats for one file. */
const ORDER = 46

/** How long `follow` waits before it opens `watch` again after the stream failed for good, and the longest it waits. */
const RETRY_FIRST_MS = 1_000
const RETRY_LONGEST_MS = 30_000

export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(judgeRemote)
  const ui = ctx.inject(['remote.dishJudge', 'slots'], registerJudge)
  try { await ui } catch (error) { await ui.dispose(); await disposeRemote(); throw error }
  return async () => { await ui.dispose(); await disposeRemote() }
}

function registerJudge(ctx: Context): void {
  const judge = createJudgePage(ctx.remote.dishJudge)
  // Optional: these run when the namespace is there, again if it is mounted anew, and end when it goes.
  ctx.inject(['remote.credentials'], (inner) => { attachCredentials(inner, judge) })
  ctx.inject(['remote.dishConfig'], (inner) => { attachConfig(inner, judge) })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'dish-judge',
    order: ORDER,
    label: () => 'Judge',
    inject: () => judge.face,
  }, Judge))
}

/**
 * Give the page dsh's credentials remote for as long as `ctx` lives, and read the key again when dsh says it changed (it can be
 * set from another page). The remote is dsh's, typed by dsh: handing it to the controller is checked against `CredentialsCalls`.
 */
function attachCredentials(ctx: Context, judge: JudgeController): void {
  judge.setCredentials(ctx.remote.credentials)
  ctx.effect(() => () => { judge.setCredentials(undefined) }, 'dish-judge: credentials remote')
  ctx.effect(() => ctx.remote.$on('credentials/reference-updated', (ref) => { judge.keyChanged(ref) }), 'dish-judge: credential changes')
}

/** Give the page dish-config's remote for as long as `ctx` lives, and follow its `watch`. */
function attachConfig(ctx: Context, judge: JudgeController): void {
  // The namespace is a service of its own, not part of this package's types: dish-config's client declares it.
  const config = ctx.get('remote.dishConfig') as ConfigHistoryApi
  const closing = new AbortController()
  judge.setConfig(config)
  ctx.effect(() => () => { closing.abort(); judge.setConfig(undefined) }, 'dish-judge: dish-config remote')
  void follow(ctx, config, judge, closing.signal)
}

/**
 * Keep reading `watch` until `closing` aborts. `ctx.remote.$stream` reopens it itself when the carrier drops or the
 * server ends it (a dish-config reload ends it `done`, which `ended` turns into a retry). If the stream fails for
 * good anyway (the first reopening after a restart can come before the server has the service back), this opens a
 * new one after a wait.
 */
async function follow(ctx: Context, config: ConfigHistoryApi, judge: JudgeController, closing: AbortSignal): Promise<void> {
  let wait = RETRY_FIRST_MS
  let streams = 0
  while (!closing.aborted) {
    const number = ++streams
    const stream = ctx.remote.$stream<ConfigEvent>({
      name: 'dish-judge live updates',
      open: signal => config.watch(signal),
      ended: () => new RemoteStreamCarrierError('dish-config stream ended'),
      carrierFailed: () => { judge.streamDown() },
    })
    const stop = (): void => { void stream.dispose() }
    closing.addEventListener('abort', stop, { once: true })
    let lastGeneration: number | undefined
    let failure: unknown
    try {
      for await (const item of stream) {
        // The first item of a stream, or of a new generation of one (after the carrier was lost and found again): events may have been missed.
        void judge.onConfigEvent(item.value, item.generation !== lastGeneration)
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
    judge.streamDown()
    console.warn(`dish-judge: live updates failed (stream ${number}), retrying in ${Math.round(wait / 1000)}s`, failure)
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
