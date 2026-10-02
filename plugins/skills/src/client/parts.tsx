/** Small pieces the page's views share. */

import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SkillInfo } from '../protocol.ts'
import type { PageNotice } from './controller.ts'
import { offerOf, roleLabel } from './format.ts'
import type { Notice } from './outcome.ts'

/** The result of the last thing the person did, with what the store itself said beneath it. */
export function NoticeBar({ notice, dismiss }: { notice: PageNotice, dismiss: () => void }) {
  return (
    <div className={`dish-skills-notice dish-skills-notice-bar dish-skills-notice-${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>
      <div className="dish-skills-notice-body">
        <span>{notice.text}</span>
        {notice.detail !== undefined && notice.detail !== '' && <span className="dish-skills-muted">{notice.detail}</span>}
      </div>
      <Button variant="ghost" size="sm" onClick={dismiss}>Dismiss</Button>
    </div>
  )
}

/** A failure to load a view, with a way to try again. */
export function LoadError({ notice, retry }: { notice: Notice, retry: () => void }) {
  return (
    <div className="dish-skills-notice dish-skills-notice-error" role="alert">
      <div className="dish-skills-notice-body">
        <span>{notice.text}</span>
        {notice.detail !== undefined && notice.detail !== '' && <span className="dish-skills-muted">{notice.detail}</span>}
      </div>
      <Button variant="outline" size="sm" onClick={retry}>Try again</Button>
    </div>
  )
}

/** A line of explanation the person should notice but need not act on. */
export function Note({ tone = 'info', children }: { tone?: 'info' | 'warn', children: ReactNode }) {
  return <p className={`dish-skills-note dish-skills-note-${tone}`} role="note">{children}</p>
}

/**
 * What a skill is offered to: a chip for each role, "all roles", "off", or, for a document that doesn't parse, a problem
 * marker with the problem as its tooltip and for assistive technology.
 */
export function OfferChips({ skill }: { skill: Pick<SkillInfo, 'problem' | 'roles' | 'modelInvocable' | 'userInvocable'> }) {
  const offer = offerOf(skill)
  switch (offer.kind) {
    case 'problem':
      return (
        <span className="dish-skills-chips">
          <span className="dish-skills-chip dish-skills-chip-problem" title={offer.problem}>
            problem<span className="dish-skills-sr">: {offer.problem}</span>
          </span>
        </span>
      )
    case 'all':
      return <span className="dish-skills-chips"><span className="dish-skills-chip dish-skills-chip-quiet">all roles</span></span>
    case 'off':
      return (
        <span className="dish-skills-chips">
          <span className="dish-skills-chip dish-skills-chip-quiet" title="Not offered to any agent">off</span>
        </span>
      )
    case 'roles':
      return (
        <span className="dish-skills-chips">
          {offer.roles.map(role => <span key={role} className="dish-skills-chip">{roleLabel(role)}</span>)}
        </span>
      )
  }
}
