/** Settings → History: the log, a commit's diff, the proposals, and where the remote copy stands. */

import { useEffect, useState } from 'react'
import { SegmentedTabs, StateDot, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteStatus } from '../protocol.ts'
import { CommitView } from './CommitView.tsx'
import type { HistoryActions, PageState } from './controller.ts'
import { remoteLine } from './format.ts'
import { LogView } from './LogView.tsx'
import { NoticeBar } from './parts.tsx'
import { ProposalsView } from './ProposalsView.tsx'

type Props = SettingsSectionOwnerProps & InjectFace<HistoryActions>

/** How often the page re-words "5 min ago". */
const TICK_MS = 30_000

function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => { setNow(Date.now()) }, TICK_MS)
    return () => { clearInterval(timer) }
  }, [])
  return now
}

export function History(props: Props) {
  const { usePage, open } = props
  const now = useNow()
  const view = usePage(state => state.view)
  const remote = usePage(state => state.remote)
  const stream = usePage(state => state.stream)
  const notice = usePage(state => state.notice)
  const busy = usePage(state => state.busy)
  const log = usePage(state => state.log)
  const prefix = usePage(state => state.prefix)
  const namespaces = usePage(state => state.namespaces)
  const detail = usePage(state => state.detail)
  const proposals = usePage(state => state.proposals)
  const proposalDiffs = usePage(state => state.proposalDiffs)
  useEffect(() => { open() }, [open])

  const waiting = proposals.items.filter(proposal => proposal.status !== 'rejected').length
  const tab = view.kind === 'proposals' ? 'proposals' : 'log'
  return (
    <div className="dish-history">
      <h2 className="dish-history-title">History</h2>
      <p className="dish-history-intro">
        Every change to your config, newest first. Revert one with a new commit, or decide on what an agent proposes.
      </p>
      <RemoteLine remote={remote} stream={stream} />
      <SegmentedTabs
        label="History views"
        value={tab}
        onChange={(next) => { props.show({ kind: next }) }}
        items={[
          { value: 'log', label: 'Log', id: 'dish-history-tab-log', panelId: 'dish-history-panel' },
          {
            value: 'proposals',
            label: waiting > 0 ? `Proposals (${waiting})` : 'Proposals',
            id: 'dish-history-tab-proposals',
            panelId: 'dish-history-panel',
          },
        ]}
      />
      {notice !== undefined && <NoticeBar notice={notice} dismiss={props.dismiss} />}
      <div role="tabpanel" id="dish-history-panel" aria-labelledby={`dish-history-tab-${tab}`}>
        {view.kind === 'log' && <LogView log={log} prefix={prefix} namespaces={namespaces} now={now} actions={props} />}
        {view.kind === 'commit' && (detail === undefined || detail.id !== view.id
          ? <p className="dish-history-muted">Loading…</p>
          : <CommitView detail={detail} busy={busy} now={now} actions={props} />)}
        {view.kind === 'proposals' && (
          <ProposalsView proposals={proposals} diffs={proposalDiffs} busy={busy} now={now} actions={props} />
        )}
      </div>
    </div>
  )
}

/** `Pushed <short id> · <n> pending · <error>`, with a dot for how it is going, and a word when updates have stopped arriving. */
function RemoteLine({ remote, stream }: { remote: RemoteStatus | undefined, stream: PageState['stream'] }) {
  const state: StateDotState = remote === undefined ? 'ongoing'
    : remote.remote === undefined ? 'idle'
      : remote.lastError !== undefined && remote.lastError !== '' ? 'error'
        : remote.pending > 0 ? 'warning' : 'done'
  return (
    <p className="dish-history-remote" title={remote?.remote}>
      <StateDot state={state} />
      <span>{remote === undefined ? 'Checking the remote…' : remoteLine(remote)}</span>
      {stream === 'down' && <span className="dish-history-muted">Live updates paused. Reconnecting…</span>}
    </p>
  )
}
