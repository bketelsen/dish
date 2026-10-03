/**
 * The main agent's `open_pr` tool: push the run this chat drives and open its pull request, after the checks; or, on a run
 * reopened for review feedback, push its new head to the same pull request.
 *
 * - **The order is the contract.** No step pushes, opens, edits or comments before every step above it passed: the caller,
 *   the arguments, the run, its lock, dish-workspaces, no coder at work, the run's own worktree (not removed, cut from the
 *   run's commit) and one dish can push, clean, its head (and, on a
 *   reopened run, GitHub's branch not ahead), the gate on that head, the worktree unchanged since, the final review of that
 *   head, the overrides, `pr.checked`. Then the push, the pull request, and the record.
 * - **The head that was checked is the head pushed.** `headOf` is read once; `runAt` gates that head (an `error` when the
 *   worktree's HEAD moved first), it is read again after the gate, and `pushBranch` refuses unless the branch is at it.
 * - **Only the run's pull request is touched.** The push is of `dish/<slug>` only. `updatePull` edits only the pull request
 *   this run recorded (`run.pr.number`, when `openPull` reports it still open), and only with the title or body given; a
 *   pull request opened outside dish is never edited. An override's line goes into a new pull request's body, or as a
 *   comment on the pull request `openPull` found open for the run's own branch (`dish/<slug>`), never into a body that
 *   exists. No number comes from an argument.
 * - **Masked where it is sent.** The title, the body, the rulings and the comment go through `maskSecrets` before
 *   dish-workspaces gets them, and every error text before the main agent does.
 * - **Locks.** Only the run's (`withRun`), never the session's: a session's lock is taken before a run's, never after, and
 *   holding it through a push would stall the chat's `worktree` hook. `close` is called holding it.
 * - **The ledger.** `pr.checked` is written whether the checks passed or not (but not for a refusal before the gate, nor when
 *   cancelled); then `pr.opened` or `pr.updated`, and `run.closed` (through `close`). A ledger line that can't be written is
 *   logged and named in the answer: the record and GitHub are the truth, so it fails nothing.
 * - **Untracked files never block it.** Both cleanliness checks ask `isClean` with `{ untracked: 'ignore' }`: a gate's
 *   output git doesn't ignore (a `go build` binary, a coverage file) would otherwise refuse every call after the first. Only
 *   commits are pushed, so they aren't in the pull request; the answer, or the refusal, after the first check names them.
 *
 * @module dish-orchestrator/open-pr
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { maskSecrets } from 'dish-kit'
import type { GateCheck } from 'dish-gates'
import { latestFinal, openTasks, sameHead } from './derive.ts'
import type { VerdictView } from './derive.ts'
import type { PrFinal, PrGate } from './entries.ts'
import { describe, mainSession, otherBase } from './runs.ts'
import type { HarnessInput, Runs, ToolDeps } from './runs.ts'
import type { Run } from './store.ts'
import { RULING_FORM, cut, given, hasRuling, line, oneLine, rulingBody, sentence, shortSha } from './text.ts'

export const MAIN_ONLY = 'open_pr is for the main agent only'
export const NO_RUN = 'open_pr needs a run this chat drives: `run` `open` or `resume` one first (`run` `list` shows the open runs).'
export const GATE_LINE = '⚠ dish: opened past a failing gate. Ruling: '
export const REVIEW_LINE = '⚠ dish: opened without an approved final review of this head. Ruling: '
export const TITLE_MAX = 256
export const BODY_MAX = 60_000

/** The most characters a ruling keeps, in the ledger and in the line. */
const RULING_MAX = 1000
/** The most characters an `updateError` or a `commentError` keeps. */
const ERROR_MAX = 300
/** The most characters a coder's title keeps in a refusal. */
const CHILD_TITLE_MAX = 120
/** How a refusal before anything was pushed ends. */
const NOTHING = 'Nothing was pushed.'

const STRING = { type: 'string', required: true } as const

const DESCRIPTION = [
  'Push the run this chat drives and open its pull request (main agent only). This is the only way anything is pushed: never `git push` or `gh pr create`.',
  '- **What it needs:** the run\'s worktree clean (untracked files aside: they aren\'t pushed, and the answer names them). It runs the project\'s gate on the worktree\'s head, and needs the latest final review (a reviewer started with `delegate`\'s `final: true`) to have approved that same head.',
  '- **What you write:** `title` and `body` (Markdown), for a reviewer.',
  '- **Only when you rule past a check:** `gateRuling` (the gate didn\'t pass) or `reviewRuling` (no approved final review of this head), each `Ruling: what — why — cost if wrong`. dish then adds one line saying so at the end of the body.',
  '- **Review feedback:** on a run you reopened with `run` `resume`, it runs the same checks and pushes the new head to the same pull request. Its title and body stay unless you give `title` or `body`; an override\'s line is posted as a comment. If GitHub\'s branch has commits the run\'s lacks (an "Update branch", a committed suggestion), have a coder merge `origin/dish/<slug>` into the run\'s worktree first: dish never force-pushes, and never rebases.',
  '- A refused check pushes nothing. It takes as long as the gate. It ends the run.',
].join('\n')

/**
 * The line naming the untracked files the checks saw (masked, as dish-workspaces gives them), which the push leaves out.
 * After a pull request opened the run is closed, so the way back to it is `run` `resume` first.
 */
export function untrackedLine(names: readonly string[], opened = false): string {
  const again = opened ? 'then `run` `resume` and call `open_pr` again' : 'and call `open_pr` again'
  return maskSecrets(`Untracked, not in the pull request: ${names.map(name => line(String(name), 200)).join(', ')}. `
    + `If the project's gate writes them, have a coder add them to \`.gitignore\`; if one should be in the pull request, have a coder commit it, ${again}.`)
}

/** `error` with the untracked line after its message, when the checks saw untracked files. */
function namingUntracked(error: unknown, untracked: readonly string[] | undefined): unknown {
  if (untracked === undefined || untracked.length === 0 || !(error instanceof Error)) return error
  error.message = `${error.message}\n${untrackedLine(untracked)}`
  return error
}

/** The two overrides, each a ruling's body (masked, one line, at most 1000 characters), only for a check that didn't pass. */
export interface Overrides {
  gate?: string
  review?: string
}

/** What the checks saw along the way, for the answer or the refusal: the untracked files `isClean` named. */
interface Seen {
  untracked?: string[]
}

/** The untracked paths of a clean `isClean` answer, or undefined for none. */
function untrackedOf(clean: { clean: true, untracked?: string[] }): string[] | undefined {
  return Array.isArray(clean.untracked) && clean.untracked.length > 0 ? clean.untracked : undefined
}

/** What the checks found, as `refusalText` reads it. */
export interface Found {
  gate: PrGate | null
  gateOk: boolean
  final: VerdictView | undefined
  reviewOk: boolean
  gatesMissing: boolean
}

/** The answer's value. */
export interface OpenedValue {
  url: string
  number: number
  existing: boolean
  head: string
  text: string
}

/** The override lines, masked: the gate's first, then the review's, each `GATE_LINE`/`REVIEW_LINE` + the ruling, joined by a blank line. '' for none. */
export function overrideLines(overrides: Overrides): string {
  const lines: string[] = []
  if (overrides.gate !== undefined) lines.push(GATE_LINE + overrides.gate)
  if (overrides.review !== undefined) lines.push(REVIEW_LINE + overrides.review)
  return maskSecrets(lines.join('\n\n'))
}

/** The body as sent to a new pull request: the main agent's, masked, then, only for an override, a blank line and `overrideLines`. */
export function prBody(body: string, overrides: Overrides): string {
  const own = maskSecrets(body.trimEnd())
  const lines = overrideLines(overrides)
  if (lines === '') return own
  return own === '' ? lines : `${own}\n\n${lines}`
}

/** A duration as a refusal says it: `12.3 s`, `4 min 5 s`. */
function took(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'an unknown time'
  if (ms < 60_000) return `${Math.round(ms / 100) / 10} s`
  const seconds = Math.round(ms / 1000)
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`
}

/** What the gate found, as one phrase after "the gate". */
function gatePhrase(gate: PrGate | null, gatesMissing: boolean): string {
  if (gatesMissing) return 'didn\'t run: dish-gates isn\'t running'
  if (gate === null) return 'didn\'t run'
  const log = gate.log === null ? '' : ` (log ${gate.log})`
  switch (gate.outcome) {
    case 'failed':
      return gate.timedOut
        ? `was stopped at its time limit${log}`
        : `failed with exit ${gate.exitCode ?? 'none'} after ${took(gate.durationMs)}${log}`
    case 'error':
    case 'skipped':
      return `couldn't run: ${(gate.reason ?? 'no reason was given').replace(/\.+$/, '')}`
    case 'passed':
      return `passed at ${gate.head === null ? 'an unknown head' : shortSha(gate.head)}, not at this head`
    default:
      return `ended ${gate.outcome}`
  }
}

/** What the final review found, as one phrase after "no final review approved <head7>:". Changes requested first, head or not. */
function reviewPhrase(final: VerdictView | undefined): string {
  if (final === undefined) return 'there is none yet'
  if (final.verdict === 'changes_requested') {
    return `the latest final review (child ${final.child}) requested changes${final.head === undefined ? '' : ` at ${shortSha(final.head)}`}`
  }
  if (final.head === undefined) return `the latest final review (child ${final.child}) gave no head: the reviewer must report the full sha of the head it approved`
  return `the latest final review (child ${final.child}) approved ${shortSha(final.head)}, not this head`
}

/** The failed checks, a phrase each: `pr.checked`'s `refused`. */
function refusedPhrases(head: string, found: Found): string[] {
  const phrases: string[] = []
  if (!found.gateOk) phrases.push(`the gate ${gatePhrase(found.gate, found.gatesMissing)}`)
  if (!found.reviewOk) phrases.push(`no final review approved ${shortSha(head)}: ${reviewPhrase(found.final)}`)
  return phrases
}

/** The refusal's text, from what the checks found. Only the failed checks' lines. */
export function refusalText(run: Run, head: string, found: Found): string {
  const lines = [`open_pr refused for run \`${run.id}\` at ${shortSha(head)}; nothing was pushed:`]
  if (!found.gateOk) {
    lines.push(found.gatesMissing
      ? `- the gate ${gatePhrase(found.gate, true)}. Give \`gateRuling: "${RULING_FORM}"\` to open the PR without it.`
      : `- the gate ${gatePhrase(found.gate, false)}. Fix it in a coder's round, or give \`gateRuling: "${RULING_FORM}"\` to open the PR past it.`)
  }
  if (!found.reviewOk) {
    lines.push(`- no final review approved ${shortSha(head)}: ${reviewPhrase(found.final)}. Delegate a fresh reviewer with \`final: true\` `
      + `(or, from the chat that started it, send the final reviewer a re-review with \`to\`), or give \`reviewRuling: "${RULING_FORM}"\` to open past it.`)
  }
  return maskSecrets(lines.join('\n'))
}

/** A gate result as `pr.checked` keeps it. */
function prGate(result: GateCheck): PrGate {
  const gate: PrGate = {
    outcome: String(result.outcome), exitCode: typeof result.exitCode === 'number' ? result.exitCode : null, timedOut: result.timedOut === true,
    durationMs: typeof result.durationMs === 'number' ? result.durationMs : 0, log: typeof result.log === 'string' ? result.log : null,
    head: typeof result.head === 'string' ? result.head : null,
  }
  if (typeof result.reason === 'string' && result.reason !== '') gate.reason = line(result.reason)
  return gate
}

/** What a run's record says about why this chat no longer drives it. */
function noLongerDriven(run: Run, current: Run | undefined, session: string): string {
  let why: string
  if (current === undefined) why = 'its record is gone'
  else if (current.state === 'pr') why = `closed: its PR ${current.pr?.url ?? ''}`.trimEnd()
  else if (current.state === 'abandoned') why = 'abandoned'
  else if (current.driver.session === '') why = 'released: this chat opened or resumed another run'
  else if (current.driver.session !== session) why = 'taken over by another chat'
  else why = 'it changed'
  return `run \`${run.id}\` is no longer driven by this chat (${why}). ${NOTHING}`
}

/** An Error with `text`, masked. */
function fail(text: string, cause?: unknown): Error {
  return new Error(maskSecrets(text), cause === undefined ? undefined : { cause })
}

/** Whether the call was cancelled: read afresh each time (it changes while the call waits). */
function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

/** The arguments, as far as they don't need the run. @throws Error with the refusal's words. */
function readArguments(args: { title?: string, body?: string, gateRuling?: string, reviewRuling?: string }): { title?: string, body?: string, gateRuling?: string, reviewRuling?: string } {
  const read: { title?: string, body?: string, gateRuling?: string, reviewRuling?: string } = {}
  const title = given(args.title)
  if (title !== undefined) {
    const folded = oneLine(title)
    if (folded.length > TITLE_MAX) throw new Error(`\`title\` is one line, at most 256 characters; this one has ${folded.length}`)
    read.title = folded
  }
  if (typeof args.body === 'string' && given(args.body) !== undefined) {
    if (args.body.length > BODY_MAX) throw new Error(`\`body\` is at most 60,000 characters; this one has ${args.body.length}`)
    read.body = args.body
  }
  for (const name of ['gateRuling', 'reviewRuling'] as const) {
    const ruling = given(args[name])
    if (ruling === undefined) continue
    if (!hasRuling(ruling)) throw new Error(`${name} needs the ruling itself: \`${RULING_FORM}\``)
    read[name] = ruling
  }
  return read
}

/** A ruling as the ledger and the line keep it: masked, without `Ruling:`, one line, at most 1000 characters. */
function override(ruling: string | undefined): string | undefined {
  return ruling === undefined ? undefined : cut(rulingBody(maskSecrets(ruling)), RULING_MAX)
}

/** `harness`, a failure logged and named for the answer. Gives the failure's line, or undefined when it was written. */
async function record(runs: Runs, run: Run, entry: HarnessInput): Promise<string | undefined> {
  try {
    await runs.harness(run, entry)
    return undefined
  } catch (error) {
    const why = describe(error)
    runs.logOnce(`open_pr in run ${run.id} of ${run.project}: the ledger couldn't record ${entry.kind}: ${why}`)
    return `dish couldn't write ${entry.kind} to the run's ledger (${why}); the record and GitHub are as said.`
  }
}

/** The `open_pr` tool over `deps`. */
export function openPrTool(deps: ToolDeps): ToolDefinition {
  const { runs, services } = deps
  return defineTool({
    name: 'open_pr',
    description: DESCRIPTION,
    parameters: {
      title: { type: 'string', description: 'The pull request\'s title: one line, at most 256 characters. Required for a new pull request. On a run reopened for review feedback, optional: give it only to change the title.' },
      body: { type: 'string', description: 'The pull request\'s description, in Markdown: what changed and why, for a reviewer. Yours; dish adds a line only for an override. Required for a new pull request. On a run reopened for review feedback, optional: give it only to replace the description.' },
      gateRuling: { type: 'string', description: 'Only to open the PR although the gate didn\'t pass on the head: your ruling, `Ruling: what — why — cost if wrong`, on one line. Leave empty otherwise.' },
      reviewRuling: { type: 'string', description: 'Only to open the PR without an approved final review of the head: your ruling, `Ruling: what — why — cost if wrong`, on one line. Leave empty otherwise.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { url: STRING, number: { type: 'integer', required: true }, existing: { type: 'boolean', required: true }, head: STRING, text: STRING },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec): Promise<OpenedValue> {
      // 1. The caller: nothing is read before this.
      const session = mainSession(exec)
      if (session === undefined) throw new Error(MAIN_ONLY)
      // 2. The arguments.
      const asked = readArguments(args)
      // 3. The run.
      try {
        await runs.ready()
      } catch (error) {
        throw fail(`can't read the run records: ${describe(error).replace(/\.+$/, '')}. ${NOTHING}`, error)
      }
      const driven = runs.store.drivenBy(session)
      if (driven === undefined) throw new Error(NO_RUN)
      if (driven.pr === undefined) {
        if (asked.title === undefined) throw new Error('`title` is required: one line, at most 256 characters')
        if (asked.body === undefined) throw new Error('`body` is required: the pull request\'s description in Markdown, at most 60,000 characters')
      }
      // 4. The lock: everything after this holds the run's.
      const seen: Seen = {}
      try {
        return await runs.withRun(driven, () => openUnderLock(session, driven, asked, exec.signal, seen))
      } catch (error) {
        throw namingUntracked(error, seen.untracked)
      }
    },
  })

  /** Steps 4 to 19, holding the run's lock. `seen` gets the untracked files the checks saw, for a refusal's last line. */
  async function openUnderLock(session: string, driven: Run, asked: ReturnType<typeof readArguments>, signal: AbortSignal | undefined, seen: Seen): Promise<OpenedValue> {
    const run = runs.store.get(driven.project, driven.id)
    if (run === undefined || run.state !== 'open' || run.driver.session !== session) throw fail(noLongerDriven(driven, run, session))

    // 5. dish-workspaces.
    const workspaces = services.workspaces()
    if (workspaces === undefined) throw new Error('dish-workspaces isn\'t running, so nothing can be pushed')

    // 6. No coder still at work in the run's worktree (only with dish-crew).
    const crew = services.crew()
    if (crew !== undefined) {
      let bindings: Awaited<ReturnType<typeof crew.worktreeBindings>> = []
      try {
        bindings = await crew.worktreeBindings(run.worktree)
      } catch (error) {
        // The head is checked again after the gate, and the push is of that head only: going on loses nothing.
        runs.logOnce(`open_pr in run ${run.id}: could not ask dish-crew who works in ${run.worktree}: ${describe(error)}`)
      }
      const working = Array.isArray(bindings) ? bindings.find(binding => binding?.running === true) : undefined
      if (working !== undefined) {
        throw fail(`${line(String(working.role), 40)} «${line(String(working.title), CHILD_TITLE_MAX)}» (child ${line(String(working.child), 100)}) is still working in the run's worktree: `
          + `wait for its finish notice, then call open_pr again. ${NOTHING}`)
      }
    }

    // 7. A worktree dish can push, and the run's own: not removed (its ledger), and cut from the run's commit. A later run of
    // the same slug makes its worktree at the same path, on a fresh dish/<slug>, which this run must never push.
    let ledger: Awaited<ReturnType<typeof runs.entries>>
    try {
      ledger = await runs.entries(run)
    } catch (error) {
      throw fail(`can't read the run's ledger: ${describe(error).replace(/\.+$/, '')}. ${NOTHING}`, error)
    }
    if (!openTasks(run, ledger).has(run.slug)) throw fail(`the run's worktree ${run.worktree} can't be pushed: it is gone (dish removed it). ${NOTHING}`)
    let resolved: Awaited<ReturnType<typeof workspaces.resolve>>
    try {
      resolved = await workspaces.resolve(run.worktree)
    } catch (error) {
      throw fail(`the run's worktree ${run.worktree} can't be checked: ${describe(error)}. ${NOTHING}`, error)
    }
    if (resolved === undefined || resolved === null) {
      let problem: string | undefined
      try {
        problem = await workspaces.resolveProblem(run.worktree)
      } catch {
        problem = undefined
      }
      const why = problem !== undefined && problem.trim() !== '' ? line(problem).replace(/\.+$/, '') : 'it is gone, or its project is no longer registered'
      throw fail(`the run's worktree ${run.worktree} can't be pushed: ${why}. ${NOTHING}`)
    }
    if (resolved.branch !== run.branch) throw fail(`the run's worktree is on ${line(String(resolved.branch), 200)}, not ${run.branch}. ${NOTHING}`)
    const other = otherBase(resolved, run)
    if (other !== undefined) {
      throw fail(`the run's worktree ${run.worktree} can't be pushed: it is gone (the worktree there now was cut from ${other}, not the run's ${shortSha(run.baseCommit)}). ${NOTHING}`)
    }

    // 8. Clean, but for untracked files: they aren't pushed, and the answer names them.
    let clean: Awaited<ReturnType<typeof workspaces.isClean>>
    try {
      clean = await workspaces.isClean(run.worktree, { untracked: 'ignore' })
    } catch (error) {
      throw fail(`can't tell whether the run's worktree is clean: ${describe(error).replace(/\.+$/, '')}. ${NOTHING}`, error)
    }
    if (!clean.clean) {
      throw fail(`the run's worktree isn't clean (${line(clean.why)}): commit or remove the changes in a coder's round, then call open_pr again. ${NOTHING}`)
    }
    seen.untracked = untrackedOf(clean)

    // 9. The head, read once: the gate runs on it, and only it is pushed.
    let head: string | undefined
    try {
      head = await workspaces.headOf(run.worktree)
    } catch (error) {
      throw fail(`can't read the run's head: ${describe(error).replace(/\.+$/, '')}. ${NOTHING}`, error)
    }
    if (typeof head !== 'string' || head === '') throw fail(`can't read the run's head: dish-workspaces gave none for ${run.worktree}. ${NOTHING}`)

    // GitHub's branch, on a reopened run: a push from behind it would be refused, so refuse before the gate.
    if (run.pr !== undefined) {
      let remoteAhead: number | null = null
      try {
        const compared = await workspaces.compareBranch(run.project, run.slug)
        remoteAhead = typeof compared?.remoteAhead === 'number' ? compared.remoteAhead : null
      } catch (error) {
        // The push tells, if it must.
        runs.logOnce(`open_pr in run ${run.id}: could not compare ${run.branch} with GitHub's: ${describe(error)}`)
      }
      if (remoteAhead !== null && remoteAhead > 0) {
        const commits = remoteAhead === 1 ? '1 commit' : `${remoteAhead} commits`
        throw fail(`GitHub's ${run.branch} has ${commits} the run's worktree lacks (an 'Update branch', a committed suggestion, or a push of someone's own). `
          + `Have a coder merge \`origin/${run.branch}\` into the run's worktree, then call open_pr again. dish never forces a push. ${NOTHING}`)
      }
    }
    if (aborted(signal)) throw new Error(`open_pr was cancelled before the gate ran. ${NOTHING}`)

    // 10. The gate on the head.
    const gates = services.gates()
    let gate: PrGate | null = null
    let gateOk = false
    const gatesMissing = gates === undefined
    if (gates !== undefined) {
      try {
        const result = await gates.runAt(run.project, run.worktree, { sessionId: session, head, ...signal === undefined ? {} : { signal } })
        gate = prGate(result)
        gateOk = result.outcome === 'passed' && sameHead(result.head, head)
      } catch (error) {
        if (aborted(signal)) throw new Error(`open_pr was cancelled while the gate ran. ${NOTHING}`, { cause: error })
        gate = { outcome: 'error', exitCode: null, timedOut: false, durationMs: 0, log: null, head: null, reason: describe(error) }
      }
    }
    if (aborted(signal)) throw new Error(`open_pr was cancelled while the gate ran. ${NOTHING}`)

    // 11. Did the worktree move while the gate ran?
    let moved: string | undefined
    try {
      const again = await workspaces.headOf(run.worktree)
      if (again !== head) moved = `${shortSha(head)} → ${typeof again === 'string' && again !== '' ? shortSha(again) : 'none'}`
      else {
        // Untracked files the gate wrote (its build's output) don't count: only a tracked change does.
        const still = await workspaces.isClean(run.worktree, { untracked: 'ignore' })
        if (!still.clean) moved = `new uncommitted changes: ${line(still.why)}`
        else seen.untracked = untrackedOf(still)
      }
    } catch (error) {
      moved = `it can't be read again: ${describe(error)}`
    }

    // 12. The final review on the head: read now, after the gate, so a verdict that came meanwhile counts.
    let entries: Awaited<ReturnType<typeof runs.entries>>
    try {
      entries = await runs.entries(run)
    } catch (error) {
      throw fail(`can't read the run's ledger: ${describe(error).replace(/\.+$/, '')}. ${NOTHING}`, error)
    }
    const final = latestFinal(entries)
    const reviewOk = final?.verdict === 'approved' && sameHead(final.head, head)
    const finalSeen: PrFinal | null = final === undefined ? null : { child: final.child, verdict: final.verdict, ...final.head === undefined ? {} : { head: final.head }, at: final.at }
    // A cancel during the reads since the gate: nothing is recorded, as for one during it.
    if (aborted(signal)) throw new Error(`open_pr was cancelled while the gate ran. ${NOTHING}`)

    if (moved !== undefined) {
      await record(runs, run, {
        kind: 'pr.checked', session, head, gate, final: finalSeen, gateOk, reviewOk, overrides: {}, result: 'refused',
        refused: ['the worktree changed while the gate ran'],
      })
      throw fail(`the run's worktree changed while the gate ran (${moved}): call open_pr again. ${NOTHING}`)
    }

    // 13. The overrides: a ruling for a check that passed is ignored.
    const overrides: Overrides = {}
    const gateOverride = gateOk ? undefined : override(asked.gateRuling)
    const reviewOverride = reviewOk ? undefined : override(asked.reviewRuling)
    if (gateOverride !== undefined) overrides.gate = gateOverride
    if (reviewOverride !== undefined) overrides.review = reviewOverride
    const pass = (gateOk || overrides.gate !== undefined) && (reviewOk || overrides.review !== undefined)

    // 14. pr.checked, either way.
    const found: Found = { gate, gateOk, final, reviewOk, gatesMissing }
    const refused = refusedPhrases(head, found).map(phrase => line(phrase))
    const unrecorded: string[] = []
    const checkedProblem = await record(runs, run, {
      kind: 'pr.checked', session, head, gate, final: finalSeen, gateOk, reviewOk, overrides, result: pass ? 'pass' : 'refused',
      ...pass ? {} : { refused },
    })
    if (!pass) throw new Error(refusalText(run, head, found))
    if (checkedProblem !== undefined) unrecorded.push(checkedProblem)

    // 15. The push: dish/<slug>, at the head checked, never forced.
    try {
      await workspaces.pushBranch(run.project, run.slug, { head, ...signal === undefined ? {} : { signal } })
    } catch (error) {
      throw fail(`${sentence(describe(error))} Nothing else was done; the run stays open.`, error)
    }

    // 16. The pull request; a reopened run's falls back to its goal and an empty body if GitHub's was closed. The goal is one
    // line and masked already, but up to 300 characters: cut to the 256 openPull takes (it checks before it looks for the
    // open pull request, so a longer one would fail the call after the push).
    const title = asked.title !== undefined ? maskSecrets(asked.title) : cut(run.goal, TITLE_MAX)
    let pull: { url: string, number: number, existing: boolean }
    try {
      pull = await workspaces.openPull(run.project, { head: run.branch, title, body: prBody(asked.body ?? '', overrides) })
    } catch (error) {
      throw fail(`${run.branch} was pushed at ${shortSha(head)}, but GitHub refused the pull request: ${describe(error).replace(/\.+$/, '')}. `
        + 'The run stays open: call open_pr again once that\'s fixed.', error)
    }
    const url = String(pull.url)
    const number = pull.number

    // 17. A pull request that was already open: openPull changed nothing on it.
    let changes: { titleChanged: boolean, bodyChanged: boolean, updateError?: string } = { titleChanged: false, bodyChanged: false }
    let comment: { comment: 'posted' | 'failed', commentError?: string } | undefined
    const recorded = pull.existing && run.pr !== undefined && run.pr.number === number
    if (pull.existing) {
      if (recorded && (asked.title !== undefined || asked.body !== undefined)) {
        const fields: { title?: string, body?: string } = {}
        if (asked.title !== undefined) fields.title = title
        if (asked.body !== undefined) fields.body = maskSecrets(asked.body.trimEnd())
        try {
          await workspaces.updatePull(run.project, number, fields)
          changes = { titleChanged: fields.title !== undefined, bodyChanged: fields.body !== undefined }
        } catch (error) {
          changes = { titleChanged: false, bodyChanged: false, updateError: cut(describe(error), ERROR_MAX) }
          runs.logOnce(`open_pr in run ${run.id}: could not update pull request #${number}: ${describe(error)}`)
        }
      }
      if (overrides.gate !== undefined || overrides.review !== undefined) {
        try {
          await workspaces.commentPull(run.project, number, overrideLines(overrides))
          comment = { comment: 'posted' }
        } catch (error) {
          comment = { comment: 'failed', commentError: cut(describe(error), ERROR_MAX) }
          runs.logOnce(`open_pr in run ${run.id}: could not post the override line on pull request #${number}: ${describe(error)}`)
        }
      }
    }

    // 18. The record: pr.opened or pr.updated, then the run closed with its pull request.
    const pullProblem = await record(runs, run, pull.existing
      ? { kind: 'pr.updated', session, url, number, head, branch: run.branch, ...changes, ...comment ?? {} }
      : { kind: 'pr.opened', session, url, number, head, branch: run.branch })
    if (pullProblem !== undefined) unrecorded.push(pullProblem)
    try {
      await runs.close(run, session, { state: 'pr', pr: { url, number } })
    } catch (error) {
      throw fail(`${pull.existing ? `Pushed ${shortSha(head)} to pull request #${number}` : `Opened pull request #${number}`} (${url}), `
        + `but run \`${run.id}\`'s record couldn't be closed: ${describe(error).replace(/\.+$/, '')}. Its pull request stands; call open_pr again to close the run.`, error)
    }

    // 19. The answer.
    const lines: string[] = []
    if (pull.existing) {
      let edited: string
      if (changes.updateError !== undefined) {
        edited = ` dish couldn't update its title or body (${changes.updateError}): resume the run and call open_pr again with them, or edit them on GitHub.`
      } else if (changes.titleChanged && changes.bodyChanged) edited = ' Its title and body were updated to yours.'
      else if (changes.titleChanged) edited = ' Its title was updated to yours.'
      else if (changes.bodyChanged) edited = ' Its body was updated to yours.'
      else if (!recorded && (asked.title !== undefined || asked.body !== undefined)) {
        edited = ' Its title and body are as they were: dish changes them only on a pull request this run opened.'
      } else edited = ' Its title and body are as they were.'
      lines.push(`Pushed ${shortSha(head)} to the pull request already open for ${run.branch}: #${number} ${url}. dish opened no other.${edited}`)
    } else {
      lines.push(`Opened PR #${number} for run \`${run.id}\`: ${url}`)
    }
    const gateSaid = gateOk ? 'the gate passed on it' : gatesMissing ? 'without the gate (dish-gates isn\'t running), on your ruling' : 'past a gate that didn\'t pass, on your ruling'
    const reviewSaid = reviewOk ? 'the final review approved it' : 'without an approved final review of it, on your ruling'
    lines.push(`Pushed ${run.branch} at ${shortSha(head)}: ${gateSaid}; ${reviewSaid}.`)
    if (overrides.gate !== undefined || overrides.review !== undefined) {
      if (!pull.existing) lines.push('The body ends with dish\'s line for each override.')
      else if (comment?.comment === 'posted') lines.push('dish posted the override line as a comment on it.')
      else lines.push(`dish couldn't post the override line as a comment (${comment?.commentError ?? 'unknown'}): add it to the pull request by hand.`)
    }
    lines.push(`Run \`${run.id}\` is closed. Humans merge; dish removes the run's own worktree once the PR is merged, and task worktrees are removed with \`worktree\` \`remove\`. `
      + 'Review feedback: `run` `resume` reopens it.')
    lines.push(...unrecorded)
    if (seen.untracked !== undefined && seen.untracked.length > 0) lines.push(untrackedLine(seen.untracked, true))
    return { url, number, existing: pull.existing, head, text: maskSecrets(lines.join('\n')) }
  }
}
