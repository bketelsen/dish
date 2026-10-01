/**
 * Settings → Judge: the TypeSafe key, the judge's status (with a test), the thresholds in `judge.yaml`, and the log of what the
 * judge decided.
 */

import { useEffect } from 'react'
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { JudgeActions } from './controller.ts'
import { DecisionsCard } from './DecisionsCard.tsx'
import { KeyCard } from './KeyCard.tsx'
import { StatusCard } from './StatusCard.tsx'
import { ThresholdsCard } from './ThresholdsCard.tsx'

type Props = SettingsSectionOwnerProps & InjectFace<JudgeActions>

export function Judge(props: Props) {
  const { usePage, open } = props
  const state = usePage(page => page)
  useEffect(() => { void open() }, [open])
  return (
    <div className="dish-judge">
      <h2 className="dish-judge-title">Judge</h2>
      <p className="dish-judge-intro">
        A fast judge in front of the risky edges of every agent: it checks each shell command before it runs, answers the approvals
        that children can't wait for, and screens web and MCP results for instructions aimed at an agent.
      </p>
      {state.stream === 'down' && <p className="dish-judge-muted">Live updates paused. Reconnecting…</p>}
      <KeyCard state={state} actions={props} />
      <StatusCard state={state} actions={props} />
      <ThresholdsCard state={state} actions={props} />
      <DecisionsCard state={state} actions={props} />
    </div>
  )
}
