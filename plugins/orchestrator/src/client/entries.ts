/**
 * What a ledger line says, in words: a label, and lines of text, for each kind of the spec's two tables (the harness's and the
 * main agent's). Plain TypeScript with no DOM or React in it, so `node --test` can load it.
 *
 * **Every field is read with a type check.** The ledger checks only a line's base fields when it reads it back, so what else a
 * line holds is whatever was written there. A kind whose fields this page needs aren't what it expects is shown as its fields'
 * JSON, as an unknown kind is, and an optional field of the wrong type is left out. Nothing here throws on what a line holds.
 *
 * What it gives is text: the page puts it in as text children, never as markup.
 * @module dish-orchestrator/client/entries
 */

import type { JsonValue, LedgerLine } from '../protocol.ts'
import { duration, shortSession, shortSha, verdictLabel } from './format.ts'

/** The most characters an unknown kind's fields take, as JSON. */
const JSON_MAX = 2000
const CUT_MARK = '…'

type Fields = { [key: string]: JsonValue }
type Said = { label: string, text: string[] }

function isObject(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function objects(value: unknown): Fields[] {
  return Array.isArray(value) ? value.filter(isObject) : []
}

/** At most `max` UTF-16 units, never ending in half a surrogate pair, with '…' when cut (the '…' counts in `max`). */
function cut(text: string, max: number): string {
  if (text.length <= max) return text
  const head = text.slice(0, max - CUT_MARK.length)
  return (/[\ud800-\udbff]$/.test(head) ? head.slice(0, -1) : head) + CUT_MARK
}

/** `fields` as JSON, cut to `JSON_MAX`. */
function json(fields: Fields): string {
  let text: string
  try {
    text = JSON.stringify(fields) ?? '{}'
  } catch {
    text = '{}'
  }
  return cut(text, JSON_MAX)
}

/** A commit, short, or `unknown`. */
function sha(value: unknown): string {
  const text = str(value)
  return text === undefined || text === '' ? 'unknown' : shortSha(text)
}

/** "n thing" or "n things". */
function count(value: number, one: string, many = `${one}s`): string {
  return `${value} ${value === 1 ? one : many}`
}

/** The lines of a structured report, as `child.ended` holds it. */
function reportLines(report: unknown): string[] {
  if (!isObject(report)) return []
  const lines: string[] = []
  const summary = str(report.summary)
  if (report.role === 'coder') {
    const status = str(report.status)
    if (status !== undefined || summary !== undefined) lines.push([status, summary].filter(part => part !== undefined).join(': '))
    const commits = strings(report.commits)
    if (commits.length > 0) lines.push(`commits: ${commits.map(shortSha).join(', ')}`)
    const blockedOn = str(report.blockedOn)
    if (blockedOn !== undefined) lines.push(`blocked on: ${blockedOn}`)
    for (const ruling of objects(report.rulings)) {
      const [what, why, cost] = [str(ruling.what), str(ruling.why), str(ruling.costIfWrong)]
      if (what !== undefined) lines.push(`ruling: ${[what, why, cost].filter(part => part !== undefined).join(' — ')}`)
    }
    for (const concern of strings(report.concerns)) lines.push(`concern: ${concern}`)
    for (const item of objects(report.notFixed)) {
      const finding = str(item.finding)
      if (finding !== undefined) lines.push(`not fixed: ${finding}${str(item.why) === undefined ? '' : ` — ${str(item.why)}`}`)
    }
  } else if (report.role === 'reviewer') {
    const verdict = str(report.verdict)
    const head = [verdict === undefined ? undefined : verdictLabel(verdict), report.head === undefined ? undefined : `at ${sha(report.head)}`].filter(part => part !== undefined).join(' ')
    if (head !== '' || summary !== undefined) lines.push([head === '' ? undefined : head, summary].filter(part => part !== undefined).join(': '))
    for (const finding of objects(report.findings)) {
      const file = str(finding.file)
      const line = num(finding.line)
      const where = file === undefined ? '' : `${file}${line === undefined ? '' : `:${line}`}`
      const what = str(finding.summary) ?? ''
      const fix = str(finding.fix)
      lines.push(`${str(finding.severity) ?? 'finding'}: ${where}${where === '' ? '' : ' — '}${what}${fix === undefined ? '' : ` (fix: ${fix})`}`)
    }
    for (const check of objects(report.checks)) {
      const command = str(check.command)
      if (command === undefined) continue
      const exit = num(check.exitCode)
      lines.push(`check: ${command}${exit === undefined ? '' : `, exit ${exit}`}${str(check.summary) === undefined ? '' : ` — ${str(check.summary)}`}`)
    }
    for (const item of objects(report.addressed)) {
      const finding = str(item.finding)
      if (finding === undefined) continue
      const state = item.addressed === true ? 'addressed' : item.addressed === false ? 'not addressed' : 'addressed?'
      lines.push(`${state}: ${finding}${str(item.evidence) === undefined ? '' : ` — ${str(item.evidence)}`}`)
    }
  }
  return lines
}

/** A gate's result in a line: its outcome, exit code, how long, and whether it timed out. */
function gateLine(gate: Fields): string | undefined {
  const outcome = str(gate.outcome)
  if (outcome === undefined) return undefined
  const exit = num(gate.exitCode)
  const ms = num(gate.durationMs)
  return [outcome, exit === undefined ? undefined : `exit ${exit}`, ms === undefined ? undefined : duration(ms), gate.timedOut === true ? 'timed out' : undefined]
    .filter(part => part !== undefined).join(', ')
}

/** Each kind's words, or undefined when the fields it needs aren't there. */
const DESCRIBE: { [kind: string]: (fields: Fields, line: LedgerLine) => Said | undefined } = {
  'run.opened'(f) {
    const [goal, branch, base, baseCommit] = [str(f.goal), str(f.branch), str(f.base), str(f.baseCommit)]
    if (goal === undefined || branch === undefined || base === undefined || baseCommit === undefined) return undefined
    const text = [goal, `branch ${branch} from ${base} at ${shortSha(baseCommit)}`]
    const worktree = str(f.worktree)
    if (worktree !== undefined) text.push(`worktree ${worktree}`)
    if (isObject(f.plan) && str(f.plan.path) !== undefined) text.push(`plan ${str(f.plan.path)} at ${sha(f.plan.commit)}`)
    if (f.how === 'run') text.push('opened with run open')
    if (f.how === 'auto') text.push('opened when the main agent made a worktree')
    return { label: 'Run opened', text }
  },
  'run.resumed'(f) {
    const driver = str(f.driver)
    if (driver === undefined) return undefined
    const text = [`driven by session ${shortSession(driver)}`]
    const previous = str(f.previous)
    if (previous !== undefined) text.push(`before, by session ${shortSession(previous)}`)
    if (f.reopened === true) {
      text.push('it had a pull request: reopened for review feedback on it')
      return { label: 'Run reopened', text }
    }
    return { label: 'Run resumed', text }
  },
  'run.takenOver'(f) {
    const [driver, previous] = [str(f.driver), str(f.previous)]
    if (driver === undefined || previous === undefined) return undefined
    return { label: 'Run taken over', text: [`driven by session ${shortSession(driver)}`, `taken from session ${shortSession(previous)}`] }
  },
  'run.plan'(f) {
    const [path, commit] = [str(f.path), str(f.commit)]
    if (path === undefined || commit === undefined) return undefined
    return { label: 'Plan attached', text: [`${path} at ${shortSha(commit)}`] }
  },
  'run.goal'(f) {
    const goal = str(f.goal)
    return goal === undefined ? undefined : { label: 'Goal set', text: [goal] }
  },
  'task.opened'(f) {
    const [path, branch, base, baseCommit] = [str(f.path), str(f.branch), str(f.base), str(f.baseCommit)]
    if (path === undefined || branch === undefined || base === undefined || baseCommit === undefined) return undefined
    return { label: 'Task opened', text: [`branch ${branch} from ${base} at ${shortSha(baseCommit)}`, `worktree ${path}`] }
  },
  'task.removed'() {
    return { label: 'Task removed', text: ['its worktree was removed'] }
  },
  'child.started'(f) {
    const [role, title] = [str(f.role), str(f.title)]
    if (role === undefined || title === undefined) return undefined
    const text = [`${role}: ${title}`]
    const [model, family] = [str(f.model), str(f.family)]
    if (model !== undefined) text.push(family === undefined ? model : `${model} (${family})`)
    const round = num(f.round)
    if (round !== undefined) text.push(`round ${round} of the task`)
    const reviews = str(f.reviews)
    if (reviews !== undefined) text.push(`reviews ${reviews}`)
    if (f.final === true) text.push('the final review')
    return { label: f.followUp === true ? 'Follow-up sent' : 'Child started', text }
  },
  'child.ended'(f) {
    const [role, stopReason] = [str(f.role), str(f.stopReason)]
    if (role === undefined || stopReason === undefined) return undefined
    const text = [`${role}: ${stopReason}`]
    const error = str(f.error)
    if (error !== undefined) text.push(`error: ${error}`)
    text.push(...reportLines(f.report))
    text.push(f.head === null ? 'head not known' : `head ${sha(f.head)}`)
    const reportFile = str(f.reportFile)
    if (reportFile !== undefined) text.push(`report ${reportFile}`)
    return { label: 'Child ended', text }
  },
  'gate.result'(f) {
    const gate = gateLine(f)
    if (gate === undefined) return undefined
    const text = [gate]
    const reason = str(f.reason)
    if (reason !== undefined) text.push(reason)
    text.push(f.head === null || f.head === undefined ? 'head not known' : `at ${sha(f.head)}`)
    const log = str(f.log)
    if (log !== undefined) text.push(`log ${log}`)
    const [round, turn] = [num(f.gateRound), num(f.gateTurn)]
    if (round !== undefined) text.push(`gate round ${round}${turn === undefined ? '' : `, turn ${turn}`}`)
    return { label: 'Gate', text }
  },
  'review.verdict'(f) {
    const [verdict, head] = [str(f.verdict), str(f.head)]
    if (verdict === undefined || head === undefined) return undefined
    const text = [`${verdictLabel(verdict)} at ${shortSha(head)}`]
    const findings = f.findings
    if (isObject(findings)) {
      const [blocking, shouldFix, nits] = [num(findings.blocking), num(findings.should_fix), num(findings.nit)]
      if (blocking !== undefined && shouldFix !== undefined && nits !== undefined) {
        text.push(`findings: ${blocking} blocking, ${shouldFix} should fix, ${count(nits, 'nit')}`)
      }
    }
    return { label: f.final === true ? 'Final review' : 'Review', text }
  },
  'ladder.refused'(f) {
    const round = num(f.round)
    return round === undefined ? undefined : { label: 'Round refused', text: [`round ${round} of the task: refused, with no ruling`] }
  },
  'ladder.ruled'(f) {
    const [round, ruling] = [num(f.round), str(f.ruling)]
    if (round === undefined || ruling === undefined) return undefined
    return { label: 'Round allowed on a ruling', text: [`round ${round} of the task`, `ruling: ${ruling}`] }
  },
  'pr.checked'(f) {
    const [head, result] = [str(f.head), str(f.result)]
    if (head === undefined || result === undefined) return undefined
    const text = [`head ${shortSha(head)}`]
    if (f.gate === null) text.push('no gate result at this head')
    else if (isObject(f.gate)) {
      const gate = gateLine(f.gate)
      if (gate !== undefined) text.push(`gate: ${gate}`)
    }
    if (f.final === null) text.push('no final review of this head')
    else if (isObject(f.final)) {
      const verdict = str(f.final.verdict)
      if (verdict !== undefined) text.push(`final review: ${verdictLabel(verdict)} at ${sha(f.final.head)}${str(f.final.child) === undefined ? '' : ` by ${str(f.final.child)}`}`)
    }
    if (isObject(f.overrides)) {
      const [gate, review] = [str(f.overrides.gate), str(f.overrides.review)]
      if (gate !== undefined) text.push(`gate overridden: ${gate}`)
      if (review !== undefined) text.push(`review overridden: ${review}`)
    }
    for (const why of strings(f.refused)) text.push(`refused: ${why}`)
    return { label: result === 'pass' ? 'PR checks passed' : result === 'refused' ? 'PR checks refused' : `PR checks: ${result}`, text }
  },
  'pr.opened'(f) {
    const [url, number] = [str(f.url), num(f.number)]
    if (url === undefined || number === undefined) return undefined
    const branch = str(f.branch)
    return { label: 'PR opened', text: [`#${number}: ${url}`, `head ${sha(f.head)}${branch === undefined ? '' : ` on ${branch}`}`] }
  },
  'pr.updated'(f) {
    const [url, number] = [str(f.url), num(f.number)]
    if (url === undefined || number === undefined) return undefined
    const branch = str(f.branch)
    const text = [`#${number}: ${url}`, `head ${sha(f.head)}${branch === undefined ? '' : ` on ${branch}`}`]
    const [title, body] = [f.titleChanged === true, f.bodyChanged === true]
    text.push(title && body ? 'title and body changed' : title ? 'title changed' : body ? 'body changed' : 'title and body left as they were')
    const updateError = str(f.updateError)
    if (updateError !== undefined) text.push(`the title and body weren't updated: ${updateError}`)
    if (f.comment === 'posted') text.push('the override lines were posted as a comment')
    if (f.comment === 'failed') text.push(`the override lines couldn't be posted: ${str(f.commentError) ?? 'no reason given'}`)
    return { label: 'PR updated', text }
  },
  'pr.feedback'(f) {
    const number = num(f.number)
    if (number === undefined) return undefined
    const state = str(f.state) ?? 'unknown state'
    const mergeable = f.mergeable === true ? 'yes' : f.mergeable === false ? 'no' : 'not known'
    const text = [`#${number}: ${state}${f.merged === true ? ', merged' : ''}; mergeable: ${mergeable}`]
    if (isObject(f.reviews)) {
      const [approved, changes, commented, other] = [num(f.reviews.approved), num(f.reviews.changesRequested), num(f.reviews.commented), num(f.reviews.other)]
      text.push(`reviews: ${approved ?? '?'} approved, ${changes ?? '?'} changes requested, ${commented ?? '?'} commented, ${other ?? '?'} other`)
    }
    const [reviewComments, outdated, issueComments] = [num(f.reviewComments), num(f.outdated), num(f.issueComments)]
    if (reviewComments !== undefined) text.push(`${count(reviewComments, 'review comment')}${outdated === undefined ? '' : ` (${outdated} outdated)`}`)
    if (issueComments !== undefined) text.push(count(issueComments, 'comment'))
    if (f.checks === null) text.push('the checks couldn\'t be read')
    else if (isObject(f.checks)) {
      const [passed, failed, pending, other] = [num(f.checks.passed), num(f.checks.failed), num(f.checks.pending), num(f.checks.other)]
      text.push(`checks: ${passed ?? '?'} passed, ${failed ?? '?'} failed, ${pending ?? '?'} pending, ${other ?? '?'} other`)
    }
    return { label: 'PR feedback read', text }
  },
  'run.closed'(f) {
    const state = str(f.state)
    if (state === 'pr') {
      const pr = isObject(f.pr) ? f.pr : {}
      const [url, number] = [str(pr.url), num(pr.number)]
      return { label: 'Run closed with a PR', text: [number === undefined ? 'its pull request' : `#${number}${url === undefined ? '' : `: ${url}`}`] }
    }
    if (state === 'abandoned') return { label: 'Run abandoned', text: [str(f.reason) ?? 'no reason given'] }
    return undefined
  },
  ruling(f) {
    const [what, why, cost] = [str(f.what), str(f.why), str(f.costIfWrong)]
    if (what === undefined || why === undefined || cost === undefined) return undefined
    return { label: 'Ruling', text: [`${what} — ${why} — ${cost}`] }
  },
  deferred(f) {
    const what = str(f.what)
    if (what === undefined) return undefined
    const text = [what]
    const where = str(f.where)
    if (where !== undefined) text.push(`where: ${where}`)
    const why = str(f.why)
    if (why !== undefined) text.push(`why: ${why}`)
    return { label: 'Deferred', text }
  },
  note(f) {
    const text = str(f.text)
    return text === undefined ? undefined : { label: 'Note', text: [text] }
  },
}

/**
 * One ledger line in words: a label, and lines of text. Every field is read with a type check; an unknown kind, and a known
 * one whose fields don't fit, shows its fields as JSON (at most 2000 characters).
 */
export function describeEntry(line: LedgerLine): { label: string, text: string[] } {
  const kind = typeof line?.kind === 'string' ? line.kind : String(line?.kind)
  const fields: Fields = isObject(line?.fields) ? line.fields : {}
  const describe = Object.hasOwn(DESCRIBE, kind) ? DESCRIBE[kind] : undefined
  let said: Said | undefined
  try {
    said = describe?.(fields, line)
  } catch {
    said = undefined
  }
  return said ?? { label: kind, text: [json(fields)] }
}
