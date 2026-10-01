/** One or more files' patches, each in a box of its own that scrolls sideways instead of the page. */

import { useMemo } from 'react'
import { Tag, type TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import type { FileDiff } from '../protocol.ts'
import { classifyPatch, patchTotals } from './diff.ts'

const STATUS_TONE: Record<FileDiff['status'], TagTone> = { added: 'success', modified: 'neutral', deleted: 'danger' }

export function DiffView({ diffs }: { diffs: readonly FileDiff[] }) {
  if (diffs.length === 0) return <p className="dish-history-muted">No changes.</p>
  return (
    <div className="dish-history-diffs">
      {diffs.map((diff, index) => <FileDiffView key={`${index}:${diff.path}`} diff={diff} />)}
    </div>
  )
}

function FileDiffView({ diff }: { diff: FileDiff }) {
  const lines = useMemo(() => classifyPatch(diff.patch), [diff.patch])
  const { added, removed } = useMemo(() => patchTotals(lines), [lines])
  return (
    <section className="dish-history-file" aria-label={`Changes to ${diff.path}`}>
      <header className="dish-history-file-head">
        <code className="dish-history-path">{diff.path}</code>
        <Tag tone={STATUS_TONE[diff.status]}>{diff.status}</Tag>
        <span className="dish-history-muted">+{added} −{removed}</span>
      </header>
      {/* Focusable, so a keyboard can scroll a long line. */}
      <pre className="dish-history-diff" tabIndex={0}>
        <code className="dish-history-diff-lines">
          {lines.map((line, index) => (
            <span key={index} className={`dish-history-line dish-history-line-${line.kind}`}>{line.text}</span>
          ))}
        </code>
      </pre>
    </section>
  )
}
