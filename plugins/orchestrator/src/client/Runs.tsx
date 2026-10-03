/**
 * Settings → Runs: every run, by project, and one run's record, what its ledger says and its timeline. Read only: nothing on
 * this page changes a run.
 *
 * This is the section's owner. Its state lives in the controller (`controller.ts`); the list, a run's view and its timeline
 * are plain functions of their props (`RunList.tsx`, `RunView.tsx`, `Timeline.tsx`), which a test renders under Node.
 */

import { useEffect } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { PageState, RunsActions } from './controller.ts'
import { LoadError, useNow } from './parts.tsx'
import { RunList } from './RunList.tsx'
import { RunView } from './RunView.tsx'

type Props = SettingsSectionOwnerProps & InjectFace<RunsActions>

type Actions = Omit<RunsActions, 'hooks'>

export function Runs(props: Props) {
  const { usePage, open } = props
  const state = usePage(page => page)
  const now = useNow()
  useEffect(() => { void open() }, [open])
  return (
    <div className="dish-runs">
      <div className="dish-runs-head">
        <h2 className="dish-runs-title">Runs</h2>
        <Button variant="outline" size="sm" onClick={() => { void props.refresh() }}>Refresh</Button>
      </div>
      <p className="dish-runs-intro">
        Every change on its way to a pull request is a run. This page shows them and their ledgers; it changes nothing.
      </p>
      {state.selected === undefined
        ? <ListSection state={state} now={now} actions={props} />
        : <RunSection state={state} selected={state.selected} now={now} actions={props} />}
    </div>
  )
}

function ListSection({ state, now, actions }: { state: PageState, now: number, actions: Actions }) {
  const { list } = state
  return (
    <section className="dish-runs-card" aria-label="Runs">
      {list.error !== undefined && <LoadError notice={list.error} retry={() => { void actions.refresh() }} />}
      {list.load === 'loading' && list.rows.length === 0 && <p className="dish-runs-muted">Loading…</p>}
      {(list.load === 'ready' || list.rows.length > 0) && (
        <RunList rows={list.rows} now={now} select={(project, id) => { void actions.select(project, id) }} />
      )}
    </section>
  )
}

function RunSection({ state, selected, now, actions }: { state: PageState, selected: NonNullable<PageState['selected']>, now: number, actions: Actions }) {
  const { detail, timeline } = state
  if (detail.value !== undefined) {
    return (
      <section className="dish-runs-card" aria-label={`Run ${selected.id}`}>
        {/* A read that failed on the way keeps the run in view: the error goes above it. */}
        {detail.error !== undefined && <LoadError notice={detail.error} retry={() => { void actions.refresh() }} />}
        <RunView detail={detail.value} timeline={timeline} now={now} back={() => { actions.back() }} loadOlder={() => { void actions.loadOlder() }} />
      </section>
    )
  }
  return (
    <section className="dish-runs-card" aria-label={`Run ${selected.id}`}>
      <div className="dish-runs-actions">
        <Button variant="outline" size="sm" onClick={() => { actions.back() }}>Back to the runs</Button>
      </div>
      {detail.error !== undefined && <LoadError notice={detail.error} retry={() => { void actions.select(selected.project, selected.id) }} />}
      {detail.error === undefined && <p className="dish-runs-muted">Loading {selected.id}…</p>}
    </section>
  )
}
