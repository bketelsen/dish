/** The GitHub Copilot sign-in block rendered inside the Copilot provider card. */

import { useState } from 'react'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { ProviderCardExtrasOwnerProps } from '@deepseek-ai/dsh-client-ui-settings-models/client'
import type { CopilotStatus } from '../protocol.ts'

export interface CardState {
  status?: CopilotStatus
  signingIn: boolean
  busy?: 'refresh' | 'sign-out'
  notice?: { message: string, url?: string, code?: string }
  error?: string
}

export interface CardActions {
  hooks: { card: SnapshotStore<CardState> }
  signIn(): void
  cancel(): void
  signOut(): void
  refreshModels(): void
}

type Props = ProviderCardExtrasOwnerProps & InjectFace<CardActions>

/** One registration serves every llm-pi-ai card; only Copilot's gets content. */
export function CopilotCard(props: Props) {
  return props.provider.provider === 'github-copilot' ? <CopilotPanel {...props} /> : null
}

function CopilotPanel({ keyConfigured, useCard, signIn, cancel, signOut, refreshModels }: Props) {
  const { status, signingIn, busy, notice, error } = useCard(state => state)
  return (
    <div className="dish-copilot" role="group" aria-label="GitHub Copilot sign-in">
      {signingIn
        ? <SignInProgress notice={notice} cancel={cancel} />
        : status?.signedIn === true
          ? <SignedIn status={status} busy={busy} signOut={signOut} refreshModels={refreshModels} />
          : keyConfigured
            ? <p className="dish-copilot-meta">Using the configured token. Clear it to sign in with GitHub instead.</p>
            : (
              <div className="dish-copilot-split">
                <div className="dish-copilot-row">
                  <StateDot state="idle" />
                  <span>GitHub Copilot: not signed in</span>
                </div>
                <div className="dish-copilot-actions">
                  <Button variant="primary" size="sm" disabled={status === undefined} onClick={signIn}>
                    Sign in with GitHub
                  </Button>
                </div>
              </div>
            )}
      {error !== undefined && <p className="dish-copilot-error" role="alert">{error}</p>}
    </div>
  )
}

function SignInProgress({ notice, cancel }: { notice: CardState['notice'], cancel: () => void }) {
  const [copied, setCopied] = useState(false)
  if (notice?.code === undefined || notice.url === undefined) {
    return (
      <div className="dish-copilot-row">
        <StateDot state="ongoing" />
        <span>{notice?.message ?? 'Starting sign-in…'}</span>
        <span className="dish-copilot-spacer" />
        <Button variant="ghost" size="sm" onClick={cancel}>Cancel</Button>
      </div>
    )
  }
  const { code, url } = notice
  const copy = (): void => {
    void navigator.clipboard.writeText(code).then(() => { setCopied(true) })
  }
  return (
    <div className="dish-copilot-device">
      <span className="dish-copilot-meta">Enter this code at {new URL(url).host + new URL(url).pathname}</span>
      <div className="dish-copilot-row">
        <code className="dish-copilot-code">{code}</code>
        <Button variant="outline" size="sm" onClick={copy}>{copied ? 'Copied' : 'Copy'}</Button>
        <Button variant="primary" size="sm" onClick={() => { window.open(url, '_blank', 'noopener,noreferrer') }}>
          Open GitHub
        </Button>
        <span className="dish-copilot-spacer" />
        <Button variant="ghost" size="sm" onClick={cancel}>Cancel</Button>
      </div>
      <div className="dish-copilot-row dish-copilot-meta">
        <StateDot state="ongoing" />
        <span>{notice.message}</span>
      </div>
    </div>
  )
}

function SignedIn({ status, busy, signOut, refreshModels }: {
  status: CopilotStatus
  busy: CardState['busy']
  signOut: () => void
  refreshModels: () => void
}) {
  const models = status.models
  return (
    <>
      <div className="dish-copilot-split">
        <div className="dish-copilot-row">
          <StateDot state="done" />
          <span>Signed in to GitHub Copilot</span>
          {models !== undefined && (
            <span className="dish-copilot-meta">
              {models.available} models · refreshed {ago(models.refreshedAt)}
            </span>
          )}
        </div>
        <div className="dish-copilot-actions">
          <Button variant="outline" size="sm" disabled={busy !== undefined} onClick={refreshModels}>
            {busy === 'refresh' ? 'Refreshing…' : 'Refresh models'}
          </Button>
          <Button variant="ghost" size="sm" disabled={busy !== undefined} onClick={signOut}>
            {busy === 'sign-out' ? 'Signing out…' : 'Sign out'}
          </Button>
        </div>
      </div>
      {models !== undefined && models.added.length > 0 && (
        <p className="dish-copilot-meta">Newer than the bundled catalog: {models.added.join(', ')}</p>
      )}
    </>
  )
}

function ago(timestamp: number): string {
  const minutes = Math.round((Date.now() - timestamp) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`
}
