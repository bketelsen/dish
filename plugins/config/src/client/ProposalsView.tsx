/**
 * The proposals: those an agent made that wait for a decision (open, and stale), then the rejected ones. Each shows its title,
 * rationale, author and diff (what it proposes: from the commit it was made on to its tip), with **Accept** and **Reject**.
 */

import { useEffect, useState, type FormEvent } from 'react'
import { Button, Input, Tag, type TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import { DiffView } from 'dish-kit/ui'
import type { ProposalInfo } from '../protocol.ts'
import type { DiffState, HistoryActions, ProposalsState } from './controller.ts'
import { authorLabel, relativeTime } from './format.ts'
import { STALE_TEXT } from './outcome.ts'
import { Group, LoadError, Paths } from './parts.tsx'

type Actions = Omit<HistoryActions, 'hooks'>

const STATUS_TONE: Record<ProposalInfo['status'], TagTone> = { open: 'info', stale: 'warning', rejected: 'quiet' }
const STATUS_LABEL: Record<ProposalInfo['status'], string> = { open: 'Open', stale: 'Stale', rejected: 'Rejected' }

export function ProposalsView({ proposals, diffs, busy, now, actions }: {
  proposals: ProposalsState
  diffs: Record<string, DiffState>
  busy: string | undefined
  now: number
  actions: Actions
}) {
  const waiting = proposals.items.filter(proposal => proposal.status !== 'rejected')
  const rejected = proposals.items.filter(proposal => proposal.status === 'rejected')
  const card = (proposal: ProposalInfo) => (
    <ProposalCard key={proposal.id} proposal={proposal} diff={diffs[proposal.id]} busy={busy} now={now} actions={actions} />
  )
  return (
    <div className="dish-history-stack">
      {proposals.error !== undefined && <LoadError notice={proposals.error} retry={actions.reload} />}
      {!proposals.loaded && proposals.error === undefined && <p className="dish-history-muted">Loading…</p>}
      {proposals.loaded && proposals.items.length === 0 && (
        <p className="dish-history-muted">No proposals. When an agent suggests a change that needs your say, it appears here.</p>
      )}
      {waiting.length > 0 && <Group title={`Waiting for you (${waiting.length})`}><ul className="dish-history-list">{waiting.map(card)}</ul></Group>}
      {rejected.length > 0 && <Group title={`Rejected (${rejected.length})`}><ul className="dish-history-list">{rejected.map(card)}</ul></Group>}
    </div>
  )
}

function ProposalCard({ proposal, diff, busy, now, actions }: {
  proposal: ProposalInfo
  diff: DiffState | undefined
  busy: string | undefined
  now: number
  actions: Actions
}) {
  const { id, status } = proposal
  // What waits for a decision opens on its diff; a rejected one stays closed until asked.
  const [expanded, setExpanded] = useState(status !== 'rejected')
  const missing = diff === undefined
  const { loadProposal } = actions
  useEffect(() => {
    if (expanded && missing) loadProposal(id)
  }, [expanded, missing, id, loadProposal])
  const panel = `dish-history-proposal-${id}`
  return (
    <li className="dish-history-card">
      <div className="dish-history-card-head">
        <Tag tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Tag>
        <h3 className="dish-history-card-title">{proposal.title}</h3>
      </div>
      <p className="dish-history-meta-line">
        <span className="dish-history-author" title={proposal.author.kind === 'agent' ? `Session ${proposal.author.sessionId}` : undefined}>
          {authorLabel(proposal.author)}
        </span>
        <span className="dish-history-muted" title={new Date(proposal.created).toLocaleString()}>{relativeTime(proposal.created, now)}</span>
        <code className="dish-history-sha">{id}</code>
      </p>
      {proposal.rationale !== '' && <p className="dish-history-text">{proposal.rationale}</p>}
      {status === 'rejected' && (
        <p className="dish-history-text">Rejected{proposal.reason !== undefined && proposal.reason !== '' ? `: ${proposal.reason}` : ''}</p>
      )}
      <Paths paths={proposal.paths} />
      <div>
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={expanded}
          aria-controls={panel}
          onClick={() => { setExpanded(!expanded) }}
        >
          {expanded ? 'Hide changes' : 'Show changes'}
        </Button>
      </div>
      {expanded && (
        <div id={panel}>
          {(diff === undefined || diff.status === 'loading') && <p className="dish-history-muted">Loading…</p>}
          {diff?.status === 'error' && <LoadError notice={diff.error} retry={() => { loadProposal(id) }} />}
          {diff?.status === 'ready' && <DiffView diffs={diff.diffs} />}
        </div>
      )}
      {status !== 'rejected' && <Decision proposal={proposal} busy={busy} actions={actions} />}
    </li>
  )
}

/** **Accept** (off while stale, with the reason) and **Reject**, which asks for its reason first. */
function Decision({ proposal, busy, actions }: { proposal: ProposalInfo, busy: string | undefined, actions: Actions }) {
  const { id, status } = proposal
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState('')
  const stale = status === 'stale'
  const working = busy === `reject:${id}`
  // The form stays while the store is asked: it goes only once the proposal is rejected, and a refusal leaves the reason in it.
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const why = reason.trim()
    if (why === '' || busy !== undefined) return
    void actions.reject(id, why).then((rejected) => {
      if (!rejected) return
      setRejecting(false)
      setReason('')
    })
  }
  return (
    <div className="dish-history-stack">
      {stale && <p className="dish-history-stale" role="note">{STALE_TEXT}</p>}
      {rejecting
        ? (
          <form className="dish-history-confirm" onSubmit={submit} aria-label="Reject this proposal">
            <Input
              className="dish-history-reason"
              value={reason}
              maxLength={200}
              placeholder="Why are you rejecting it?"
              aria-label="Reason for rejecting"
              readOnly={working}
              autoFocus
              onChange={(event) => { setReason(event.target.value) }}
            />
            <div className="dish-history-actions">
              <Button type="submit" variant="primary" size="sm" disabled={busy !== undefined || reason.trim() === ''}>
                {working ? 'Rejecting…' : 'Reject'}
              </Button>
              <Button type="button" variant="ghost" size="sm" disabled={working} onClick={() => { setRejecting(false) }}>Cancel</Button>
            </div>
          </form>
        )
        : (
          <div className="dish-history-actions">
            <Button
              variant="primary"
              size="sm"
              disabled={stale || busy !== undefined}
              onClick={() => { actions.accept(id) }}
            >
              {busy === `accept:${id}` ? 'Accepting…' : 'Accept'}
            </Button>
            <Button variant="outline" size="sm" disabled={busy !== undefined} onClick={() => { setRejecting(true) }}>Reject</Button>
          </div>
        )}
    </div>
  )
}
