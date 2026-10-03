/**
 * What `run` `status` and `run` `list` say: plain functions of a run, its summary (`derive.ts`) and what the tool read
 * just now (the worktree's head, whether it is clean, the branch against GitHub). No I/O here, and nothing masked: the
 * tool masks the whole answer.
 *
 * @module dish-orchestrator/status
 */

import type { BranchComparison } from 'dish-workspaces'
import { sameHead } from './derive.ts'
import type { GateView, RunSummary, TaskView, VerdictView } from './derive.ts'
import type { Run } from './store.ts'
import { age, shortSession, shortSha } from './text.ts'

/** What `run` `status` read besides the ledger. */
export interface StatusContext {
  /** The calling chat's session. */
  caller: string
  now: number
  /** The run's worktree now: `headOf`. */
  head?: string
  /** The run's worktree now: `isClean`. */
  clean?: { clean: true } | { clean: false, why: string }
  /** Why `head` or `clean` couldn't be read. */
  headProblem?: string
  /** derive's `gateAt(entries, head)`. */
  gateAtHead?: GateView
  /** `dishWorkspaces.compareBranch(run.project, run.slug)`, or why it couldn't tell. */
  branch?: BranchComparison | { problem: string }
}

/** How many rulings and deferred findings `status` shows, newest first. */
const RULINGS_SHOWN = 20
/** How many notes. */
const NOTES_SHOWN = 5
/** How many open runs `list` shows. */
const OPEN_SHOWN = 50
/** How many runs with a pull request. */
const PR_SHOWN = 10

/** `1 commit`, `2 commits`. */
function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}

/** The newest `max` of `items` (oldest first, as the ledger has them), newest first, each through `line`; then how many older. */
function newestFirst<T>(items: readonly T[], max: number, line: (item: T) => string): string[] {
  const shown = items.slice(-max).reverse().map(line)
  const older = items.length - Math.min(items.length, max)
  return older > 0 ? [...shown, `(and ${older} older)`] : shown
}

/** Who drives `run`, as the caller sees it. */
function driverPhrase(run: Run, caller: string): string {
  if (run.driver.session === caller) return 'this chat drives it'
  if (run.driver.session === '') return 'nobody drives it'
  return `session ${shortSession(run.driver.session)} drives it`
}

/** The run's pull request, and what `pr_feedback` last read of it, as a sentence; '' without one. */
function pullSentence(run: Run, summary: RunSummary, now: number): string {
  if (run.pr === undefined) return ''
  const feedback = summary.pr?.feedback
  let read = ''
  if (feedback !== undefined && feedback.number === run.pr.number) {
    const checks = feedback.failedChecks === null ? 'the checks couldn\'t be read' : count(feedback.failedChecks, 'failed check')
    read = `; \`pr_feedback\` last read it ${age(feedback.at, now)}: ${count(feedback.reviews, 'review')}, ${count(feedback.comments, 'comment')}, ${checks}`
  }
  return ` Its pull request: #${run.pr.number} ${run.pr.url}${read}.`
}

/**
 * The default branch as the merge hint names it: always `origin/HEAD`, which dish's fetch points at the default branch each
 * time (`remote set-head --auto`). Never the run's own base: `behindDefault` counts against the default branch, the pull
 * request targets it, and the record can't tell a base that was asked for (`origin/develop`) from the default.
 */
const DEFAULT_BRANCH = 'the default branch (`origin/HEAD`)'

/** The branch against GitHub: one line, and a second with the merge hint when it is behind either. */
function branchLines(run: Run, branch: StatusContext['branch']): string[] {
  if (branch === undefined) return []
  if ('problem' in branch) return [`Against GitHub: can't tell (${branch.problem}).`]
  const remote = branch.remoteAhead === null
    ? `${run.branch} isn't on GitHub yet.`
    : branch.remoteAhead > 0
      ? `GitHub's ${run.branch} has ${count(branch.remoteAhead, 'commit')} this one lacks.`
      : `GitHub's ${run.branch} has nothing this one lacks.`
  const lines = [`Against GitHub (just fetched): ${count(branch.aheadOfDefault, 'commit')} ahead of the default branch, ${branch.behindDefault} behind; ${remote}`]
  const remoteAhead = branch.remoteAhead !== null && branch.remoteAhead > 0
  if (branch.behindDefault > 0 || remoteAhead) {
    lines.push(`To bring it up to date, have a coder fetch and merge ${DEFAULT_BRANCH}${remoteAhead ? ` and \`origin/${run.branch}\`` : ''} into the run's worktree. `
      + 'Never rebase, amend or squash: dish never forces a push.')
  }
  return lines
}

function verdictWords(verdict: VerdictView['verdict']): string {
  return verdict === 'changes_requested' ? 'changes requested' : 'approved'
}

/** One task's line. */
function taskLine(view: TaskView, now: number): string {
  let line = `- ${view.task}${view.own ? ' (the run\'s own worktree)' : ''}${view.removed ? ' (removed)' : ''}: `
  const coder = view.coder
  if (coder === undefined) {
    line += 'no coder yet'
  } else {
    const state = coder.ended
      ? `ended ${coder.stopReason ?? 'for no recorded reason'}${coder.status === undefined ? '' : `, reported ${coder.status}`}`
      : 'running'
    line += `coder round ${Math.max(0, view.rounds - 1)} (child ${coder.child}, ${state})`
  }
  const gate = view.gate
  line += gate === undefined ? '; no gate result' : `; gate ${gate.outcome}${gate.head === null ? '' : ` at ${shortSha(gate.head)}`} (${age(gate.at, now)})`
  const verdict = view.verdict
  if (verdict !== undefined) line += `; review ${verdictWords(verdict.verdict)}${verdict.final ? ' (final)' : ''}${verdict.head === undefined ? '' : ` at ${shortSha(verdict.head)}`}`
  return line
}

/** The final review's line. */
function finalLine(final: VerdictView | undefined, head: string | undefined, now: number): string {
  if (final === undefined) return 'Final review: none yet: `delegate` a reviewer with `final: true`.'
  if (final.verdict !== 'approved') return `Final review: changes requested${final.head === undefined ? '' : ` at ${shortSha(final.head)}`} (child ${final.child}).`
  if (final.head === undefined) {
    return `Final review: approved (child ${final.child}, ${age(final.at, now)}), but it gave no head: `
      + '`open_pr` needs a final review that reports the full sha of the head it approved, or `reviewRuling`.'
  }
  const approvedHead = final.head
  const then = head === undefined
    ? '; the head can\'t be read now.'
    : sameHead(approvedHead, head)
      ? '; that is the head now.'
      : `; the head is now ${shortSha(head)}, so \`open_pr\` needs a new final review or \`reviewRuling\`.`
  return `Final review: approved ${shortSha(approvedHead)} (child ${final.child}, ${age(final.at, now)})${then}`
}

/** What `open_pr` would find now, on one line. */
function openPrLine(summary: RunSummary, context: StatusContext): string {
  const { head, clean } = context
  const problem = context.headProblem ?? 'dish-workspaces gave no answer'
  let found: string
  if (head === undefined) found = `the head can't be read: ${problem}`
  else if (clean === undefined) found = `head ${shortSha(head)}, but whether it is clean can't be read: ${problem}`
  else if (clean.clean) found = `head ${shortSha(head)}, clean`
  else found = `head ${shortSha(head)}, not clean: ${clean.why} (it refuses until that's fixed)`
  const last = context.gateAtHead === undefined ? '' : ` (the last result at this head: ${context.gateAtHead.outcome}, ${age(context.gateAtHead.at, context.now)})`
  const final = summary.finalReview
  const approved = head !== undefined && final !== undefined && final.verdict === 'approved' && sameHead(final.head, head)
  const review = approved ? 'the final review approved this head' : 'no final review approved this head (give `reviewRuling` to open past it)'
  return `\`open_pr\` now: ${found}; the gate runs on that head when you call it${last}; ${review}.`
}

/** A note as list lines: its first line after "- ", the rest indented, and its age at the end. */
function noteLines(note: { at: number, text: string }, now: number): string {
  const [first = '', ...rest] = note.text.split('\n')
  return [`- ${first}`, ...rest.map(line => `  ${line}`)].join('\n') + ` (${age(note.at, now)})`
}

/** `run` `status`: where the run stands, from its ledger and what was read just now. */
export function statusText(run: Run, summary: RunSummary, context: StatusContext): string {
  const { now } = context
  const lines: string[] = [
    `Run \`${run.id}\` (${run.project}): ${run.goal}`,
    `Branch ${run.branch} in ${run.worktree}, cut from ${run.base} (${shortSha(run.baseCommit)}); opened ${age(run.openedAt, now)}; ${driverPhrase(run, context.caller)}.`
      + pullSentence(run, summary, now),
    ...branchLines(run, context.branch),
    run.plan === undefined ? 'No plan: the run is one task, in its own worktree.' : `Plan: ${run.plan.path} at ${shortSha(run.plan.commit)}.`,
    'Tasks:',
    ...summary.tasks.map(view => taskLine(view, now)),
    finalLine(summary.finalReview, context.head, now),
  ]
  if (summary.rulings.length > 0) {
    lines.push('Rulings:', ...newestFirst(summary.rulings, RULINGS_SHOWN, ruling =>
      `- ${ruling.task === undefined ? '' : `${ruling.task}: `}${ruling.text} (${ruling.by === 'main' ? 'you' : 'harness'}, ${age(ruling.at, now)})`))
  }
  if (summary.deferred.length > 0) {
    lines.push('Deferred:', ...newestFirst(summary.deferred, RULINGS_SHOWN, item => `- ${item.what} (${item.where}): ${item.why}`))
  }
  if (summary.notes.length > 0) lines.push('Notes:', ...newestFirst(summary.notes, NOTES_SHOWN, note => noteLines(note, now)))
  lines.push(openPrLine(summary, context))
  return lines.join('\n')
}

/** Who drives an open run, as `list` says it. */
function listDriver(run: Run, caller: string, live: (run: Run) => boolean): string {
  const session = run.driver.session
  if (session === '') return 'nobody drives it (`run` `resume` takes it)'
  if (session === caller) return 'this chat drives it'
  if (live(run)) return `driven by another chat (session ${shortSession(session)}, still open)`
  return `driven by session ${shortSession(session)}, which isn't live (\`run\` \`resume\` takes it)`
}

/** `open`: the open runs; `withPr`: the runs in state `pr`, newest closedAt first, which `resume` can reopen. */
export function listText(open: readonly Run[], withPr: readonly Run[], context: { caller: string, now: number, live(run: Run): boolean, project?: string }): string {
  const where = context.project === undefined ? '' : ` in ${context.project}`
  const lines: string[] = []
  if (open.length === 0) {
    lines.push(`No open runs${where}.`)
  } else {
    lines.push(`Open runs${where}:`)
    for (const run of open.slice(0, OPEN_SHOWN)) {
      lines.push(`- ${run.project} \`${run.id}\`: ${run.goal}, opened ${age(run.openedAt, context.now)}; ${listDriver(run, context.caller, run => context.live(run))}`)
    }
    if (open.length > OPEN_SHOWN) lines.push(`(and ${open.length - OPEN_SHOWN} more)`)
  }
  if (withPr.length > 0) {
    const newest = [...withPr].sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0))
    lines.push('', 'With a pull request (`run` `resume` reopens one for review feedback):')
    for (const run of newest.slice(0, PR_SHOWN)) {
      const pr = run.pr === undefined ? 'no PR recorded' : `PR #${run.pr.number} ${run.pr.url}`
      lines.push(`- ${run.project} \`${run.id}\`: ${run.goal}, ${pr}, ${age(run.closedAt ?? run.openedAt, context.now)}`)
    }
    if (newest.length > PR_SHOWN) lines.push(`(and ${newest.length - PR_SHOWN} older)`)
  }
  return lines.join('\n')
}
