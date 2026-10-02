/**
 * Settings → GitHub App: the App's ID and its private key, and what GitHub says of the App (Test).
 *
 * The two credentials go from this page to dsh's own credential store through dsh's `credentials` remote; dish's server never
 * receives them, and this page can't read them back. What the page can say of each is "set" or "not set", and where dsh says it
 * comes from. A field is emptied the moment Save is pressed. The key is a text area, because a PEM is lines and a one-line
 * input would drop its breaks; its characters are drawn as dots while it is typed (where the browser can), and it is never
 * filled back.
 */

import { useEffect, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent, ReactNode } from 'react'
import { Button, Input, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { AppStatus } from '../protocol.ts'
import { canTest } from './controller.ts'
import type { AppCardActions, CredentialKind, CredentialState, PageNotice, PageState } from './controller.ts'
import { relativeTime, selectionText, sourceLabel } from './format.ts'
import type { Notice } from './outcome.ts'

type Props = SettingsSectionOwnerProps & InjectFace<AppCardActions>

type Actions = Omit<AppCardActions, 'hooks'>

export function AppCard(props: Props) {
  const { usePage, open } = props
  const state = usePage(page => page)
  useEffect(() => { void open() }, [open])
  return (
    <div className="dish-workspaces">
      <h2 className="dish-workspaces-title">GitHub App</h2>
      <p className="dish-workspaces-intro">
        dish reaches your repositories as a GitHub App: it clones and fetches with a read-only token, and reads pull requests to
        see which branches were merged. Create the App on GitHub with read access to Contents, Pull requests and Metadata (no
        webhook), install it on the owners and repositories dish should work in, then give dish its ID and private key here.
      </p>
      <CredentialsCard state={state} actions={props} />
      <StatusCard state={state} actions={props} />
    </div>
  )
}

// --- the credentials -----------------------------------------------------------------------------

function CredentialsCard({ state, actions }: { state: PageState, actions: Actions }) {
  const { credentials } = state
  const names = state.status.value?.names
  return (
    <section className="dish-workspaces-card" aria-labelledby="dish-workspaces-credentials-title">
      <div className="dish-workspaces-card-head">
        <h3 className="dish-workspaces-card-title" id="dish-workspaces-credentials-title">Credentials</h3>
      </div>
      <p className="dish-workspaces-muted">
        They are stored by dsh, in its credential store: never in the config store, and this page can't read them back. Pasting a
        new one replaces the old. Dev and prod have separate stores, so a dev dish keeps its own pair, for its own App (dish-dev),
        installed only on test repositories.
      </p>
      {credentials.load === 'unavailable' && (
        <Note tone="warn">
          dsh's credential store can't be reached from this page, so they can't be set here. Set them in the environment dsh starts
          in, or reload the page.
        </Note>
      )}
      {credentials.load === 'error' && credentials.error !== undefined && <LoadError notice={credentials.error} retry={() => { void actions.refresh() }} />}
      {state.status.load === 'error' && state.status.error !== undefined && names === undefined && (
        <LoadError notice={state.status.error} retry={() => { void actions.refresh() }} />
      )}
      {names === undefined && state.status.load === 'loading' && <p className="dish-workspaces-muted">Checking with dish and dsh…</p>}
      {names !== undefined && credentials.load === 'loading' && <p className="dish-workspaces-muted">Checking with dsh…</p>}
      {names !== undefined && (
        <>
          <CredentialField
            kind="appId"
            label="App ID"
            name={names.appId}
            placeholder="1234567"
            hint="The number at the top of the App's settings page on GitHub."
            state={state}
            actions={actions}
          />
          <CredentialField
            kind="privateKey"
            label="Private key"
            name={names.privateKey}
            placeholder="-----BEGIN RSA PRIVATE KEY-----"
            hint="The whole .pem file GitHub gave you when you generated the key, line breaks and all."
            multiline
            state={state}
            actions={actions}
          />
        </>
      )}
    </section>
  )
}

/** What losing a credential costs, said when it is asked for. */
const REMOVE_COSTS = 'Until it is set again dish can\'t get new read tokens: onboarding stops, and fetches and the sweep stop once the tokens it holds (good for an hour) run out.'

/** One credential: its state, a field to paste a new value, and Remove (which asks first). */
function CredentialField(props: {
  kind: CredentialKind
  label: string
  name: string
  placeholder: string
  hint: string
  multiline?: boolean
  state: PageState
  actions: Actions
}) {
  const { kind, label, name, placeholder, hint, multiline = false, state, actions } = props
  const field: CredentialState = state[kind]
  const loaded = state.credentials.load === 'ready'
  const busy = field.busy !== undefined
  const usable = loaded && field.writable
  const noun = kind === 'appId' ? 'App ID' : 'private key'
  const fieldId = `dish-workspaces-${kind === 'appId' ? 'app-id' : 'private-key'}`
  const [confirming, setConfirming] = useState(false)
  const removeButton = useRef<HTMLButtonElement>(null)
  const wasConfirming = useRef(false)
  // The question takes focus (on Cancel, the safe answer), because the button that opened it goes away. When it closes, focus goes
  // back to Remove, or to the field when the credential is gone and Remove with it.
  useEffect(() => {
    if (wasConfirming.current && !confirming) {
      if (removeButton.current !== null) removeButton.current.focus()
      else document.getElementById(fieldId)?.focus()
    }
    wasConfirming.current = confirming
  }, [confirming, fieldId])
  const send = (): void => {
    if (usable && !busy && field.input.trim() !== '') void actions.save(kind)
  }
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    // Save is disabled the moment the field is emptied, and a focused button that is disabled drops focus to the page: the field
    // takes it first.
    document.getElementById(fieldId)?.focus()
    send()
  }
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // Enter is a line break in a text area; the shortcut for Save is Ctrl/Cmd+Enter.
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      send()
    }
  }
  return (
    <div className="dish-workspaces-credential" role="group" aria-label={label}>
      <div className="dish-workspaces-card-head">
        <h4 className="dish-workspaces-label-title">
          {label}
          <code className="dish-workspaces-code">{name}</code>
        </h4>
        {loaded && <Tag tone={field.configured ? 'success' : 'warning'}>{field.configured ? 'Set' : 'Not set'}</Tag>}
      </div>
      {field.notice !== undefined && <NoticeBar notice={field.notice} dismiss={() => { actions.dismiss(kind) }} />}
      {loaded && field.configured && field.source !== undefined && <p className="dish-workspaces-muted">Set, from {sourceLabel(field.source)}.</p>}
      {loaded && !field.writable && (
        <Note>dsh can't change this one from here. Change it where it comes from, and this page will follow.</Note>
      )}
      {usable && (
        <form className="dish-workspaces-stack" onSubmit={submit} noValidate autoComplete="off">
          <div className="dish-workspaces-field">
            <label className="dish-workspaces-label" htmlFor={fieldId}>
              {field.configured ? `Replace the ${noun}` : `Paste the ${noun}`}
            </label>
            {multiline
              ? (
                <textarea
                  id={fieldId}
                  className="dish-workspaces-native dish-workspaces-textarea dish-workspaces-secret"
                  name="dish-workspaces-private-key"
                  rows={4}
                  autoComplete="off"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  data-1p-ignore="true"
                  data-lpignore="true"
                  data-bwignore="true"
                  data-gramm="false"
                  data-gramm_editor="false"
                  data-enable-grammarly="false"
                  value={field.input}
                  readOnly={busy}
                  placeholder={placeholder}
                  aria-describedby={`${fieldId}-hint`}
                  onKeyDown={onKeyDown}
                  onChange={(event) => { actions.setInput(kind, event.target.value) }}
                />
              )
              : (
                <Input
                  id={fieldId}
                  className="dish-workspaces-input"
                  name="dish-workspaces-app-id"
                  inputMode="numeric"
                  autoComplete="off"
                  spellCheck={false}
                  data-1p-ignore="true"
                  data-lpignore="true"
                  data-bwignore="true"
                  data-gramm="false"
                  data-gramm_editor="false"
                  data-enable-grammarly="false"
                  value={field.input}
                  readOnly={busy}
                  placeholder={placeholder}
                  aria-describedby={`${fieldId}-hint`}
                  onChange={(event) => { actions.setInput(kind, event.target.value) }}
                />
              )}
            <span className="dish-workspaces-muted" id={`${fieldId}-hint`}>{hint}</span>
          </div>
          <div className="dish-workspaces-actions">
            <Button variant="primary" size="sm" type="submit" disabled={busy || field.input.trim() === ''}>
              {field.busy === 'save' ? 'Saving…' : `Save ${noun}`}
            </Button>
            {field.configured && !confirming && (
              <Button ref={removeButton} variant="outline" size="sm" type="button" disabled={busy} onClick={() => { setConfirming(true) }}>
                Remove {noun}
              </Button>
            )}
          </div>
        </form>
      )}
      {usable && field.configured && confirming && (
        <div className="dish-workspaces-confirm" role="group" aria-label={`Confirm removing the ${noun}`}>
          <p className="dish-workspaces-text">Remove the {noun}? {REMOVE_COSTS}</p>
          <div className="dish-workspaces-actions">
            <Button
              variant="primary"
              size="sm"
              disabled={busy}
              onClick={() => { void actions.unset(kind).then(() => { setConfirming(false) }) }}
            >
              {field.busy === 'remove' ? 'Removing…' : 'Remove'}
            </Button>
            <Button variant="ghost" size="sm" autoFocus disabled={busy} onClick={() => { setConfirming(false) }}>Cancel</Button>
          </div>
        </div>
      )}
    </div>
  )
}

// --- what GitHub says ----------------------------------------------------------------------------

/** How often the card re-words "5 min ago". */
const TICK_MS = 30_000

/** The time now, as of the last tick: the card says "checked 5 min ago", so it stays right while the page is open. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => { setNow(Date.now()) }, TICK_MS)
    return () => { clearInterval(timer) }
  }, [])
  return now
}

function StatusCard({ state, actions }: { state: PageState, actions: Actions }) {
  const { status, testing, testNotice, credentials } = state
  const now = useNow()
  const value = status.value
  // With dsh saying a credential is missing, a test's "not set" is the card above's news already.
  const missing = credentials.load === 'ready' && !(state.appId.configured && state.privateKey.configured)
  return (
    <section className="dish-workspaces-card" aria-labelledby="dish-workspaces-status-title">
      <div className="dish-workspaces-card-head">
        <h3 className="dish-workspaces-card-title" id="dish-workspaces-status-title">
          What GitHub says
          {value !== undefined && !missing && <Verdict value={value} />}
        </h3>
        <div className="dish-workspaces-actions">
          <Button variant="outline" size="sm" disabled={!canTest(state)} onClick={() => { void actions.runTest() }}>
            {testing ? 'Testing…' : 'Test'}
          </Button>
        </div>
      </div>
      {status.load === 'loading' && value === undefined && <p className="dish-workspaces-muted">Loading…</p>}
      {status.error !== undefined && <LoadError notice={status.error} retry={() => { void actions.refresh() }} />}
      {testNotice !== undefined && (
        <div className="dish-workspaces-notice dish-workspaces-notice-error" role="alert">
          <div className="dish-workspaces-notice-body">
            <span>{testNotice.text}</span>
            {testNotice.detail !== undefined && <span className="dish-workspaces-muted">{testNotice.detail}</span>}
          </div>
          <Button variant="ghost" size="sm" onClick={() => { actions.dismiss('test') }}>Dismiss</Button>
        </div>
      )}
      {missing && <p className="dish-workspaces-muted">Set the App ID and the private key above, then test them here.</p>}
      {!missing && value !== undefined && <Facts value={value} now={now} />}
    </section>
  )
}

function Verdict({ value }: { value: AppStatus }) {
  if (value.checkedAt === null) return null
  return value.error === null ? <Tag tone="success">Reachable</Tag> : <Tag tone="danger">Failed</Tag>
}

/** The App, its bot and its installations, as far as the last test got. */
function Facts({ value, now }: { value: AppStatus, now: number }) {
  return (
    <>
      {value.error !== null && <Note tone="error">{value.error}</Note>}
      {value.app !== null && (
        <dl className="dish-workspaces-facts">
          <dt>App</dt>
          <dd>{value.app.name} <span className="dish-workspaces-muted">({value.app.slug})</span></dd>
          <dt>Bot</dt>
          <dd>
            {value.bot === null
              ? <span className="dish-workspaces-muted">not looked up</span>
              : <>{value.bot.login} <span className="dish-workspaces-muted">{value.bot.email}</span></>}
          </dd>
          <dt>Installations</dt>
          <dd>
            {value.installations.length === 0
              ? <span className="dish-workspaces-muted">none yet: install the App on the owners dish should work in (the App's page on GitHub, Install App)</span>
              : (
                <ul className="dish-workspaces-list">
                  {value.installations.map(installation => (
                    <li key={installation.id} className="dish-workspaces-installation">
                      <strong>{installation.account}</strong>
                      <Tag tone="neutral">{installation.type}</Tag>
                      <span className="dish-workspaces-muted">{selectionText(installation.selection)}</span>
                    </li>
                  ))}
                </ul>
              )}
          </dd>
        </dl>
      )}
      {value.checkedAt !== null && <p className="dish-workspaces-muted">Checked {relativeTime(value.checkedAt, now)}.</p>}
    </>
  )
}

// --- small pieces --------------------------------------------------------------------------------

/** The result of the last thing the person did, with what the server itself said beneath it. */
function NoticeBar({ notice, dismiss }: { notice: PageNotice, dismiss: () => void }) {
  return (
    <div className={`dish-workspaces-notice dish-workspaces-notice-${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>
      <div className="dish-workspaces-notice-body">
        <span>{notice.text}</span>
        {notice.detail !== undefined && notice.detail !== '' && <span className="dish-workspaces-muted">{notice.detail}</span>}
      </div>
      <Button variant="ghost" size="sm" onClick={dismiss}>Dismiss</Button>
    </div>
  )
}

/** A failure to load something, with a way to try again. */
function LoadError({ notice, retry }: { notice: Notice, retry: () => void }) {
  return (
    <div className="dish-workspaces-notice dish-workspaces-notice-error" role="alert">
      <div className="dish-workspaces-notice-body">
        <span>{notice.text}</span>
        {notice.detail !== undefined && notice.detail !== '' && <span className="dish-workspaces-muted">{notice.detail}</span>}
      </div>
      <Button variant="outline" size="sm" onClick={retry}>Try again</Button>
    </div>
  )
}

/** A line of explanation the person should notice but need not act on. */
function Note({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'error', children: ReactNode }) {
  return <p className={`dish-workspaces-note dish-workspaces-note-${tone}`} role={tone === 'error' ? 'alert' : 'note'}>{children}</p>
}
