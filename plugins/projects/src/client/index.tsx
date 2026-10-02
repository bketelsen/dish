/**
 * Browser half of dish-projects: **Settings → Projects**, through a `settings.section` entry.
 *
 * The page's state lives here (`controller.ts`), not in the component. The page needs dish-projects' own remote, and works
 * with that alone: list, add, edit, remove and retry. dish-config's remote is optional. When its client is loaded, `watch` is
 * followed, so the page refreshes as the store changes (a hand edit, an accepted proposal). When it isn't, or when it goes,
 * nothing arrives that way; the status of onboarding is read by polling either way, while the page is shown. It is looked for
 * as a service of its own (`remote.dishConfig`), so it can arrive after this plugin has loaded, and leave again.
 */

import type { Context } from '@deepseek-ai/cordis'
import { RemoteStreamCarrierError } from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { createProjects, type ProjectsController } from './controller.ts'
import { Projects } from './Projects.tsx'
import { projectsRemote, type ConfigEvent, type ConfigHistoryApi } from './remote.ts'
import './styles.ts'

export const inject = ['remote', 'slots']

/** The seat in Settings' nav: after Skills (47), and before the GitHub App (49) and History (50). */
const ORDER = 48

/** How long `follow` waits before it opens `watch` again after the stream failed for good, and the longest it waits. */
const RETRY_FIRST_MS = 1_000
const RETRY_LONGEST_MS = 30_000

export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(projectsRemote)
  const ui = ctx.inject(['remote.dishProjects', 'slots'], registerProjects)
  try { await ui } catch (error) { await ui.dispose(); await disposeRemote(); throw error }
  return async () => { await ui.dispose(); await disposeRemote() }
}

function registerProjects(ctx: Context): void {
  const projects = createProjects(ctx.remote.dishProjects)
  // This scope ends when the remote goes (or the plugin does) and is made again with the next one: the controller of the one that
  // ended must not go on polling beside the new one.
  ctx.effect(() => () => { projects.dispose() }, 'dish-projects: controller')
  // Optional: this runs when dish-config's client has mounted its remote, again if that is mounted anew, and ends when it goes.
  ctx.inject(['remote.dishConfig'], (inner) => { attachConfig(inner, projects) })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'dish-projects',
    order: ORDER,
    label: () => 'Projects',
    inject: () => projects.face,
  }, Projects))
}

/** Give the page dish-config's remote for as long as `ctx` lives, and follow its `watch`. */
function attachConfig(ctx: Context, projects: ProjectsController): void {
  // The namespace is a service of its own, not part of this package's types: dish-config's client declares it.
  const config = ctx.get('remote.dishConfig') as ConfigHistoryApi
  const closing = new AbortController()
  projects.setConfig(config)
  ctx.effect(() => () => { closing.abort(); projects.setConfig(undefined) }, 'dish-projects: dish-config remote')
  void follow(ctx, config, projects, closing.signal)
}

/**
 * Keep reading `watch` until `closing` aborts. `ctx.remote.$stream` reopens it itself when the carrier drops or the
 * server ends it (a dish-config reload ends it `done`, which `ended` turns into a retry). If the stream fails for
 * good anyway (the first reopening after a restart can come before the server has the service back), this opens a
 * new one after a wait.
 */
async function follow(ctx: Context, config: ConfigHistoryApi, projects: ProjectsController, closing: AbortSignal): Promise<void> {
  let wait = RETRY_FIRST_MS
  let streams = 0
  while (!closing.aborted) {
    const number = ++streams
    const stream = ctx.remote.$stream<ConfigEvent>({
      name: 'dish-projects live updates',
      open: signal => config.watch(signal),
      ended: () => new RemoteStreamCarrierError('dish-config stream ended'),
      carrierFailed: () => { projects.streamDown() },
    })
    const stop = (): void => { void stream.dispose() }
    closing.addEventListener('abort', stop, { once: true })
    let lastGeneration: number | undefined
    let failure: unknown
    try {
      for await (const item of stream) {
        // The first item of a stream, or of a new generation of one (after the carrier was lost and found again): events may have been missed.
        void projects.onConfigEvent(item.value, item.generation !== lastGeneration)
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
    projects.streamDown()
    console.warn(`dish-projects: live updates failed (stream ${number}), retrying in ${Math.round(wait / 1000)}s`, failure)
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
