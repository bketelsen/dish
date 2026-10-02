/**
 * Browser half of dish-copilot: a GitHub Copilot card inside the Models page's
 * provider rows, through the `settings.models.provider-card` seat. A fresh
 * profile has no Copilot route, so no such row; there the same panel shows in
 * the page's footer (`settings.models.footer`) until the route exists.
 *
 * The sign-in stream lives here, not in the component, so leaving the page
 * does not abandon an attempt the human is finishing in another tab.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-models/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { CopilotCard, CopilotFirstSignIn, type CardActions, type CardState } from './CopilotCard.tsx'
import { copilotRemote } from './remote.ts'
import './styles.ts'

export const inject = ['remote', 'slots']

const KEY = 'llm-pi-ai/github-copilot'

export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(copilotRemote)
  const ui = ctx.inject(['remote.dishCopilot', 'slots'], registerCard)
  try { await ui } catch (error) { await ui.dispose(); await disposeRemote(); throw error }
  return async () => { await ui.dispose(); await disposeRemote() }
}

function registerCard(ctx: Context): void {
  const remote = ctx.remote.dishCopilot
  const card = createSnapshotStore<CardState>({ signingIn: false })
  const patch = (next: Partial<CardState>): void => { card.set({ ...card.getSnapshot(), ...next }) }
  let attempt: AbortController | undefined

  const reload = async (): Promise<void> => {
    const result = await remote.status()
    if (result.ok) patch({ status: result.value })
    else patch({ error: result.error.message })
  }
  const run = async (busy: CardState['busy'], call: () => Promise<{ ok: true, value: CardState['status'] } | { ok: false, error: { message: string } }>) => {
    patch({ busy, error: undefined })
    const result = await call()
    patch(result.ok ? { busy: undefined, status: result.value } : { busy: undefined, error: result.error.message })
  }

  const signIn = async (): Promise<void> => {
    if (attempt !== undefined) return
    const controller = attempt = new AbortController()
    patch({ signingIn: true, notice: undefined, error: undefined })
    try {
      for await (const event of remote.signIn(controller.signal)) {
        if (event.type === 'notice') {
          // The code's own notice repeats the instructions the card already
          // shows; later notices ("Enabling models…") carry no code, so keep it.
          patch({ notice: event.code !== undefined
            ? { ...event, message: 'Waiting for you to approve on GitHub…' }
            : { ...card.getSnapshot().notice, message: event.message } })
        } else if (event.type === 'failed') {
          patch({ error: event.message })
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) patch({ error: error instanceof Error ? error.message : String(error) })
    } finally {
      attempt = undefined
      patch({ signingIn: false, notice: undefined })
      await reload()
    }
  }

  const actions: CardActions = {
    hooks: { card },
    signIn: () => { void signIn() },
    cancel: () => { attempt?.abort(); void remote.cancel() },
    signOut: () => { void run('sign-out', () => remote.signOut()) },
    refreshModels: () => { void run('refresh', () => remote.refreshModels()) },
  }

  ctx.effect(() => () => attempt?.abort())
  // Sign-in from anywhere (the terminal, another tab) and the post-sign-in
  // model refresh both land as record or settings updates.
  ctx.remote.$on('credentials/record-updated', (key) => { if (key === KEY) void reload() })
  ctx.remote.$on('settings/document-updated', () => { void reload() })
  void reload()

  ctx.slots.inject('settings.models.provider-card', () => ctx.slots.register({
    name: 'settings.models.provider-card',
    key: 'llm-pi-ai',
    inject: () => actions,
  }, CopilotCard))
  ctx.slots.inject('settings.models.footer', () => ctx.slots.register({
    name: 'settings.models.footer',
    id: 'dish-copilot',
    order: 100,
    label: 'GitHub Copilot',
    inject: () => actions,
  }, CopilotFirstSignIn))
}
