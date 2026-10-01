/**
 * One or more files' patches, each in a box of its own that scrolls sideways instead of the page.
 *
 * Its styles (`styles.ts`) are added to the page when the plugin's bundle loads, so a plugin that shows a `DiffView`
 * needs nothing else.
 */

import { useMemo } from 'react'
import { Tag, type TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import { classifyPatch, patchTotals, type FileDiff } from './diff.ts'
import './styles.ts'

const STATUS_TONE: Record<FileDiff['status'], TagTone> = { added: 'success', modified: 'neutral', deleted: 'danger' }

export function DiffView({ diffs }: { diffs: readonly FileDiff[] }) {
  if (diffs.length === 0) return <p className="dish-diff-muted">No changes.</p>
  return (
    <div className="dish-diff-files">
      {diffs.map((diff, index) => <FileDiffView key={`${index}:${diff.path}`} diff={diff} />)}
    </div>
  )
}

function FileDiffView({ diff }: { diff: FileDiff }) {
  const lines = useMemo(() => classifyPatch(diff.patch), [diff.patch])
  const { added, removed } = useMemo(() => patchTotals(lines), [lines])
  return (
    <section className="dish-diff-file" aria-label={`Changes to ${diff.path}`}>
      <header className="dish-diff-file-head">
        <code className="dish-diff-path">{diff.path}</code>
        <Tag tone={STATUS_TONE[diff.status]}>{diff.status}</Tag>
        <span className="dish-diff-muted">+{added} −{removed}</span>
      </header>
      {/* Focusable, so a keyboard can scroll a long line. */}
      <pre className="dish-diff-code" tabIndex={0}>
        <code className="dish-diff-lines">
          {lines.map((line, index) => (
            <span key={index} className={`dish-diff-line dish-diff-line-${line.kind}`}>{line.text}</span>
          ))}
        </code>
      </pre>
    </section>
  )
}
