/**
 * Browser half of dish-skills: **Settings → Skills**, through a `settings.section` entry.
 *
 * The page's state lives here (`controller.ts`), not in the component. The page needs dish-skills' own remote, and works
 * with that alone: list, edit, check and default. dish-config's remote is optional. When its client is loaded, the controller
 * gets its calls, which turns on the History tab, and `watch` is followed, so the page refreshes as the store changes. When it
 * isn't, or when it goes, the tab is hidden and nothing arrives live. It is looked for as a service of its own
 * (`remote.dishConfig`), so it can arrive after this plugin has loaded, and leave again.
 */

import type { Context } from '@deepseek-ai/cordis'
import { RemoteStreamCarrierError } from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { createSkills, type SkillsController } from './controller.ts'
import { Skills } from './Skills.tsx'
import { skillsRemote, type ConfigEvent, type ConfigHistoryApi } from './remote.ts'
import './styles.ts'

export const inject = ['remote', 'slots']

/** The seat in Settings' nav: after Prompts (45) and Judge (46), and before History (50), whose tab this page repeats for one skill. */
const ORDER = 47

/** How long `follow` waits before it opens `watch` again after the stream failed for good, and the longest it waits. */
const RETRY_FIRST_MS = 1_000
const RETRY_LONGEST_MS = 30_000

export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(skillsRemote)
  const ui = ctx.inject(['remote.dishSkills', 'slots'], registerSkills)
  try { await ui } catch (error) { await ui.dispose(); await disposeRemote(); throw error }
  return async () => { await ui.dispose(); await disposeRemote() }
}

function registerSkills(ctx: Context): void {
  const skills = createSkills(ctx.remote.dishSkills)
  // Optional: this runs when dish-config's client has mounted its remote, again if that is mounted anew, and ends when it goes.
  ctx.inject(['remote.dishConfig'], (inner) => { attachConfig(inner, skills) })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'dish-skills',
    order: ORDER,
    label: () => 'Skills',
    inject: () => skills.face,
  }, Skills))
}

/** Give the page dish-config's remote for as long as `ctx` lives, and follow its `watch`. */
function attachConfig(ctx: Context, skills: SkillsController): void {
  // The namespace is a service of its own, not part of this package's types: dish-config's client declares it.
  const config = ctx.get('remote.dishConfig') as ConfigHistoryApi
  const closing = new AbortController()
  skills.setConfig(config)
  ctx.effect(() => () => { closing.abort(); skills.setConfig(undefined) }, 'dish-skills: dish-config remote')
  void follow(ctx, config, skills, closing.signal)
}

/**
 * Keep reading `watch` until `closing` aborts. `ctx.remote.$stream` reopens it itself when the carrier drops or the
 * server ends it (a dish-config reload ends it `done`, which `ended` turns into a retry). If the stream fails for
 * good anyway (the first reopening after a restart can come before the server has the service back), this opens a
 * new one after a wait.
 */
async function follow(ctx: Context, config: ConfigHistoryApi, skills: SkillsController, closing: AbortSignal): Promise<void> {
  let wait = RETRY_FIRST_MS
  let streams = 0
  while (!closing.aborted) {
    const number = ++streams
    const stream = ctx.remote.$stream<ConfigEvent>({
      name: 'dish-skills live updates',
      open: signal => config.watch(signal),
      ended: () => new RemoteStreamCarrierError('dish-config stream ended'),
      carrierFailed: () => { skills.streamDown() },
    })
    const stop = (): void => { void stream.dispose() }
    closing.addEventListener('abort', stop, { once: true })
    let lastGeneration: number | undefined
    let failure: unknown
    try {
      for await (const item of stream) {
        // The first item of a stream, or of a new generation of one (after the carrier was lost and found again): events may have been missed.
        void skills.onConfigEvent(item.value, item.generation !== lastGeneration)
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
    skills.streamDown()
    console.warn(`dish-skills: live updates failed (stream ${number}), retrying in ${Math.round(wait / 1000)}s`, failure)
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
