/**
 * The key card: whether a TypeSafe key is set, and a field to paste one. The key goes to dsh's own credential store through
 * dsh's `credentials` remote, in the browser; this plugin's server never sees it and the page never has it back. What the card
 * can say is "set" or "not set", and where dsh says the value comes from. The field is emptied the moment Save is pressed.
 */

import { useState } from 'react'
import type { FormEvent } from 'react'
import { Button, Input, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { JudgeActions, PageState } from './controller.ts'
import { sourceLabel } from './format.ts'
import { LoadError, NoticeBar, Note } from './parts.tsx'

type Actions = Omit<JudgeActions, 'hooks'>

export function KeyCard({ state, actions }: { state: PageState, actions: Actions }) {
  const { key } = state
  const [confirming, setConfirming] = useState(false)
  const busy = key.busy !== undefined
  const usable = key.load === 'ready' && key.writable
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (usable && !busy && key.input.trim() !== '') void actions.saveKey()
  }
  return (
    <section className="dish-judge-card" aria-labelledby="dish-judge-key-title">
      <div className="dish-judge-card-head">
        <h3 className="dish-judge-card-title" id="dish-judge-key-title">
          TypeSafe key
          {key.keyName !== undefined && <code className="dish-judge-code">{key.keyName}</code>}
        </h3>
        {key.load === 'ready' && (
          <Tag tone={key.configured ? 'success' : 'warning'}>{key.configured ? 'Set' : 'Not set'}</Tag>
        )}
      </div>
      <p className="dish-judge-muted">
        The judge needs a TypeSafe API key. It is stored by dsh, not by dish: it never goes in the config store, and this page
        can't read it back. Pasting a new one replaces the old.
      </p>
      {key.notice !== undefined && <NoticeBar notice={key.notice} dismiss={actions.dismissKeyNotice} />}
      {key.load === 'loading' && <p className="dish-judge-muted">Checking with dsh…</p>}
      {key.load === 'idle' && (
        <p className="dish-judge-muted">
          {state.status.load === 'error' ? 'The key can\'t be checked until the status below loads.' : 'Waiting for the judge\'s status…'}
        </p>
      )}
      {key.load === 'unavailable' && (
        <Note tone="warn">
          dsh's credential store can't be reached from this page, so the key can't be set here. Set it in the environment dsh starts
          in, or reload the page.
        </Note>
      )}
      {key.load === 'error' && key.error !== undefined && <LoadError notice={key.error} retry={() => { void actions.refreshKey() }} />}
      {key.load === 'ready' && key.configured && (
        <p className="dish-judge-muted">Set, from {sourceLabel(key.source)}.</p>
      )}
      {key.load === 'ready' && !key.writable && (
        <Note>dsh can't change this key from here. Change it where it comes from, and this page will follow.</Note>
      )}
      {usable && (
        <form className="dish-judge-stack" onSubmit={submit} noValidate autoComplete="off">
          <div className="dish-judge-key-row">
            <label className="dish-judge-field">
              <span className="dish-judge-label">{key.configured ? 'Replace the key' : 'Paste the key'}</span>
              <Input
                className="dish-judge-input"
                type="password"
                name="dish-judge-typesafe-key"
                autoComplete="new-password"
                spellCheck={false}
                autoCapitalize="off"
                data-1p-ignore="true"
                data-lpignore="true"
                value={key.input}
                readOnly={busy}
                placeholder="apikey_…"
                aria-label="TypeSafe key"
                onChange={(event) => { actions.setKeyInput(event.target.value) }}
              />
            </label>
            <div className="dish-judge-actions">
              <Button variant="primary" size="sm" type="submit" disabled={busy || key.input.trim() === ''}>
                {key.busy === 'save' ? 'Saving…' : 'Save key'}
              </Button>
              {key.configured && !confirming && (
                <Button variant="outline" size="sm" type="button" disabled={busy} onClick={() => { setConfirming(true) }}>Remove key</Button>
              )}
            </div>
          </div>
        </form>
      )}
      {usable && key.configured && confirming && (
        <div className="dish-judge-confirm" role="group" aria-label="Confirm removing the key">
          <p className="dish-judge-text">
            Remove the key? Until one is set again, the judge is unavailable: the gate asks you about every command, children are
            refused, and web results are passed on marked "not screened".
          </p>
          <div className="dish-judge-actions">
            <Button
              variant="primary"
              size="sm"
              disabled={busy}
              onClick={() => { void actions.removeKey().then(() => { setConfirming(false) }) }}
            >
              {key.busy === 'remove' ? 'Removing…' : 'Remove'}
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => { setConfirming(false) }}>Cancel</Button>
          </div>
        </div>
      )}
    </section>
  )
}
