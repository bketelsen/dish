/**
 * `statusText` and `listText` over hand-made runs and summaries: no ledger, no services.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { GateView, RulingView, RunSummary, TaskView, VerdictView } from '../src/derive.ts'
import { listText, statusText } from '../src/status.ts'
import type { StatusContext } from '../src/status.ts'
import type { Run } from '../src/store.ts'
import { shortSession } from '../src/text.ts'
import { HOUR, MINUTE, NOW, SHA_A, SHA_B, SHA_C, run } from './helpers.ts'

const ID = '20261003-fix-login'
const CALLER = 'session-1'
const OTHER = 'session-2-long-id'
const B7 = SHA_B.slice(0, 7)
const C7 = SHA_C.slice(0, 7)

function task(overrides: Partial<TaskView> = {}): TaskView {
  return { task: 'fix-login', own: true, path: '/work/Acme/widget/.worktrees/fix-login', removed: false, rounds: 0, ...overrides }
}

function summary(overrides: Partial<RunSummary> = {}): RunSummary {
  return { tasks: [task()], rulings: [], deferred: [], notes: [], ...overrides }
}

function gate(overrides: Partial<GateView> = {}): GateView {
  return { child: 'c1', outcome: 'passed', exitCode: 0, head: SHA_B, at: NOW - 5 * MINUTE, log: '/logs/gate.log', ...overrides }
}

function verdict(overrides: Partial<VerdictView> = {}): VerdictView {
  return { child: 'r1', verdict: 'approved', head: SHA_B, final: true, at: NOW - 3 * MINUTE, findings: { blocking: 0, should_fix: 0, nit: 0 }, ...overrides }
}

function context(overrides: Partial<StatusContext> = {}): StatusContext {
  return { caller: CALLER, now: NOW, head: SHA_B, clean: { clean: true }, branch: { behindDefault: 0, aheadOfDefault: 2, remoteAhead: 0 }, ...overrides }
}

function lines(text: string): string[] {
  return text.split('\n')
}

/** The line that starts with `prefix`. */
function lineOf(text: string, prefix: string): string {
  const found = lines(text).find(line => line.startsWith(prefix))
  assert.ok(found !== undefined, `no line starts with ${JSON.stringify(prefix)} in:\n${text}`)
  return found
}

test('statusText: the run, its branch and plan, in order, each section once', () => {
  const opened = run({ openedAt: NOW - 2 * HOUR, plan: { path: 'docs/plans/x.md', commit: SHA_A } })
  const text = statusText(opened, summary(), context())
  const all = lines(text)
  assert.equal(all[0], `Run \`${ID}\` (Acme/widget): Fix the login redirect`)
  assert.equal(all[1], `Branch dish/fix-login in /work/Acme/widget/.worktrees/fix-login, cut from origin/main (${SHA_A.slice(0, 7)}); opened 2 h ago; this chat drives it.`)
  assert.equal(all[2], 'Against GitHub (just fetched): 2 commits ahead of the default branch, 0 behind; GitHub\'s dish/fix-login has nothing this one lacks.')
  assert.equal(all[3], `Plan: docs/plans/x.md at ${SHA_A.slice(0, 7)}.`)
  assert.equal(all[4], 'Tasks:')
  const order = ['Run ', 'Branch ', 'Against GitHub', 'Plan: ', 'Tasks:', 'Final review:', '`open_pr` now:']
  const positions = order.map(prefix => all.findIndex(line => line.startsWith(prefix)))
  assert.deepEqual([...positions].sort((a, b) => a - b), positions)
  // No rulings, deferred findings or notes: their sections are left out.
  assert.equal(text.includes('Rulings:'), false)
  assert.equal(text.includes('Deferred:'), false)
  assert.equal(text.includes('Notes:'), false)
  // Without a plan.
  assert.equal(lineOf(statusText(run(), summary(), context()), 'No plan'), 'No plan: the run is one task, in its own worktree.')
})

test('statusText: a reopened run names its pull request, and what pr_feedback last read of it', () => {
  const reopened = run({ pr: { url: 'https://github.com/Acme/widget/pull/7', number: 7 } })
  const plain = lineOf(statusText(reopened, summary(), context()), 'Branch ')
  assert.match(plain, /; this chat drives it\. Its pull request: #7 https:\/\/github\.com\/Acme\/widget\/pull\/7\.$/)
  const read = summary({ pr: { feedback: { at: NOW - 10 * MINUTE, number: 7, reviews: 2, comments: 5, failedChecks: 1 } } })
  assert.match(lineOf(statusText(reopened, read, context()), 'Branch '),
    / Its pull request: #7 https:\/\/github\.com\/Acme\/widget\/pull\/7; `pr_feedback` last read it 10 min ago: 2 reviews, 5 comments, 1 failed check\.$/)
  const unreadable = summary({ pr: { feedback: { at: NOW - 10 * MINUTE, number: 7, reviews: 1, comments: 1, failedChecks: null } } })
  assert.match(lineOf(statusText(reopened, unreadable, context()), 'Branch '), /1 review, 1 comment, the checks couldn't be read\.$/)
  // Another chat's run, or one nobody drives, says so.
  assert.match(lineOf(statusText(run({ driver: { session: OTHER, since: NOW } }), summary(), context()), 'Branch '), new RegExp(`session ${shortSession(OTHER)} drives it\\.$`))
  assert.match(lineOf(statusText(run({ driver: { session: '', since: NOW } }), summary(), context()), 'Branch '), /nobody drives it\.$/)
})

test('statusText: the branch against GitHub: level, behind, GitHub\'s branch ahead (the hint naming both), not on GitHub yet, and can\'t tell', () => {
  const merge = 'Never rebase, amend or squash: dish never forces a push.'
  const level = statusText(run(), summary(), context({ branch: { behindDefault: 0, aheadOfDefault: 1, remoteAhead: 0 } }))
  assert.equal(lineOf(level, 'Against GitHub'), 'Against GitHub (just fetched): 1 commit ahead of the default branch, 0 behind; GitHub\'s dish/fix-login has nothing this one lacks.')
  assert.equal(level.includes('To bring it up to date'), false)

  const behind = statusText(run(), summary(), context({ branch: { behindDefault: 4, aheadOfDefault: 2, remoteAhead: null } }))
  assert.equal(lineOf(behind, 'Against GitHub'), 'Against GitHub (just fetched): 2 commits ahead of the default branch, 4 behind; dish/fix-login isn\'t on GitHub yet.')
  assert.equal(lineOf(behind, 'To bring it up to date'), `To bring it up to date, have a coder fetch and merge the default branch (\`origin/HEAD\`) into the run's worktree. ${merge}`)

  const moved = statusText(run(), summary(), context({ branch: { behindDefault: 0, aheadOfDefault: 2, remoteAhead: 3 } }))
  assert.equal(lineOf(moved, 'Against GitHub'), 'Against GitHub (just fetched): 2 commits ahead of the default branch, 0 behind; GitHub\'s dish/fix-login has 3 commits this one lacks.')
  assert.equal(lineOf(moved, 'To bring it up to date'),
    `To bring it up to date, have a coder fetch and merge the default branch (\`origin/HEAD\`) and \`origin/dish/fix-login\` into the run's worktree. ${merge}`)
  assert.match(lineOf(statusText(run(), summary(), context({ branch: { behindDefault: 0, aheadOfDefault: 2, remoteAhead: 1 } })), 'Against GitHub'), /has 1 commit this one lacks\.$/)

  // Whatever the run was cut from, the hint names the default branch by origin/HEAD: behind counts against it, and the PR
  // targets it. The record can't tell a base asked for (origin/develop) from the default (origin/main).
  for (const base of ['origin/develop', 'origin/dish/plan-x', 'main', 'v1.2.0']) {
    const cut = statusText(run({ base }), summary(), context({ branch: { behindDefault: 1, aheadOfDefault: 0, remoteAhead: null } }))
    assert.equal(lineOf(cut, 'To bring it up to date'), `To bring it up to date, have a coder fetch and merge the default branch (\`origin/HEAD\`) into the run's worktree. ${merge}`, base)
  }

  const unknown = statusText(run(), summary(), context({ branch: { problem: 'pnpm isn\'t ready (cloning); see Settings → Projects' } }))
  assert.equal(lineOf(unknown, 'Against GitHub'), 'Against GitHub: can\'t tell (pnpm isn\'t ready (cloning); see Settings → Projects).')
  // The lines after it keep their order, and still come.
  assert.ok(lineOf(unknown, 'Tasks:') !== undefined)
  assert.ok(lineOf(unknown, '`open_pr` now:') !== undefined)
})

test('statusText: each form of a task\'s line', () => {
  const tasks = [
    task({ task: 'fix-login', own: true }),
    task({ task: 'api', own: false, rounds: 1, coder: { child: 'c1', at: NOW - HOUR, ended: false }, gate: gate({ at: NOW - 5 * MINUTE }) }),
    task({
      task: 'ui', own: false, rounds: 3, coder: { child: 'c3', at: NOW - HOUR, ended: true, stopReason: 'completed', status: 'done', summary: 'did it' },
      gate: gate({ outcome: 'failed', exitCode: 1, head: SHA_C, at: NOW - 2 * HOUR }), verdict: verdict({ final: true, head: SHA_C }),
    }),
    task({ task: 'docs', own: false, removed: true, rounds: 1, coder: { child: 'c4', at: NOW - HOUR, ended: true, stopReason: 'error' }, verdict: verdict({ final: false, verdict: 'changes_requested' }) }),
    task({ task: 'odd', own: false, rounds: 0, gate: gate({ outcome: 'error', exitCode: null, head: null, at: NOW - MINUTE }) }),
  ]
  const text = statusText(run(), summary({ tasks }), context())
  const at = lines(text).indexOf('Tasks:')
  assert.deepEqual(lines(text).slice(at + 1, at + 6), [
    '- fix-login (the run\'s own worktree): no coder yet; no gate result',
    `- api: coder round 0 (child c1, running); gate passed at ${B7} (5 min ago)`,
    `- ui: coder round 2 (child c3, ended completed, reported done); gate failed at ${C7} (2 h ago); review approved (final) at ${C7}`,
    `- docs (removed): coder round 0 (child c4, ended error); no gate result; review changes requested at ${B7}`,
    '- odd: no coder yet; gate error (1 min ago)',
  ])
})

test('statusText: the final review, approved at the head now, approved at a stale head, changes requested, and none', () => {
  const now = statusText(run(), summary({ finalReview: verdict() }), context())
  assert.equal(lineOf(now, 'Final review:'), `Final review: approved ${B7} (child r1, 3 min ago); that is the head now.`)
  const stale = statusText(run(), summary({ finalReview: verdict() }), context({ head: SHA_C }))
  assert.equal(lineOf(stale, 'Final review:'), `Final review: approved ${B7} (child r1, 3 min ago); the head is now ${C7}, so \`open_pr\` needs a new final review or \`reviewRuling\`.`)
  const unread = statusText(run(), summary({ finalReview: verdict() }), context({ head: undefined, clean: undefined, headProblem: 'git can\'t say' }))
  assert.equal(lineOf(unread, 'Final review:'), `Final review: approved ${B7} (child r1, 3 min ago); the head can't be read now.`)
  const changes = statusText(run(), summary({ finalReview: verdict({ verdict: 'changes_requested', child: 'r2' }) }), context())
  assert.equal(lineOf(changes, 'Final review:'), `Final review: changes requested at ${B7} (child r2).`)
  const none = statusText(run(), summary(), context())
  assert.equal(lineOf(none, 'Final review:'), 'Final review: none yet: `delegate` a reviewer with `final: true`.')
})

test('statusText: a final review without a head (work outside git), approved or not, and a task\'s line without one', () => {
  const { head: _head, ...headless } = verdict()
  const approved = statusText(run(), summary({ finalReview: headless, tasks: [task({ verdict: headless })] }), context())
  assert.equal(lineOf(approved, 'Final review:'), 'Final review: approved (child r1, 3 min ago), but it gave no head: '
    + '`open_pr` needs a final review that reports the full sha of the head it approved, or `reviewRuling`.')
  assert.equal(lineOf(approved, '- fix-login'), '- fix-login (the run\'s own worktree): no coder yet; no gate result; review approved (final)')
  assert.match(lineOf(approved, '`open_pr` now:'), /no final review approved this head/)
  const changes = statusText(run(), summary({ finalReview: { ...headless, verdict: 'changes_requested' } }), context())
  assert.equal(lineOf(changes, 'Final review:'), 'Final review: changes requested (child r1).')
})

test('statusText: rulings, newest 20 first, then how many older; deferred findings and notes', () => {
  const rulings: RulingView[] = Array.from({ length: 23 }, (_, index) => ({
    at: NOW - (23 - index) * MINUTE, by: index % 2 === 0 ? 'main' as const : 'harness' as const, source: 'ruling' as const, text: `ruling ${index}`,
    ...index === 22 ? { task: 'api' } : {},
  }))
  const deferred = Array.from({ length: 2 }, (_, index) => ({ at: NOW - (2 - index) * MINUTE, what: `finding ${index}`, where: 'src/a.ts', why: 'later' }))
  const notes = Array.from({ length: 7 }, (_, index) => ({ at: NOW - (7 - index) * MINUTE, text: index === 6 ? 'line one\nline two' : `note ${index}` }))
  const text = statusText(run(), summary({ rulings, deferred, notes }), context())
  const all = lines(text)
  const start = all.indexOf('Rulings:')
  assert.equal(all[start + 1], '- api: ruling 22 (you, 1 min ago)')
  assert.equal(all[start + 2], '- ruling 21 (harness, 2 min ago)')
  assert.equal(all[start + 20], '- ruling 3 (harness, 20 min ago)')
  assert.equal(all[start + 21], '(and 3 older)')
  const deferredAt = all.indexOf('Deferred:')
  assert.deepEqual(all.slice(deferredAt + 1, deferredAt + 3), ['- finding 1 (src/a.ts): later', '- finding 0 (src/a.ts): later'])
  const notesAt = all.indexOf('Notes:')
  assert.deepEqual(all.slice(notesAt + 1, notesAt + 8), [
    '- line one', '  line two (1 min ago)', '- note 5 (2 min ago)', '- note 4 (3 min ago)', '- note 3 (4 min ago)', '- note 2 (5 min ago)', '(and 2 older)',
  ])
  // The sections come in order, before `open_pr` now.
  assert.ok(start < deferredAt && deferredAt < notesAt && notesAt < all.findIndex(line => line.startsWith('`open_pr` now:')))
})

test('statusText: `open_pr` now, clean, clean with untracked files, not clean, and the head unreadable; the gate\'s last result at this head; the final review', () => {
  const clean = statusText(run(), summary({ finalReview: verdict() }), context({ gateAtHead: gate() }))
  assert.equal(lineOf(clean, '`open_pr` now:'),
    `\`open_pr\` now: head ${B7}, clean; the gate runs on that head when you call it (the last result at this head: passed, 5 min ago); the final review approved this head.`)
  // Clean with untracked files, as `open_pr` asks (`{ untracked: 'ignore' }`): clean, and they're named.
  const untracked = statusText(run(), summary(), context({ clean: { clean: true, untracked: ['clippy', 'coverage.out', 'and 3 more'] } }))
  assert.equal(lineOf(untracked, '`open_pr` now:'),
    `\`open_pr\` now: head ${B7}, clean (untracked, not pushed: clippy, coverage.out, and 3 more); the gate runs on that head when you call it; no final review approved this head (give \`reviewRuling\` to open past it).`)
  const noneNamed = statusText(run(), summary(), context({ clean: { clean: true, untracked: [] } }))
  assert.match(lineOf(noneNamed, '`open_pr` now:'), new RegExp(`^\`open_pr\` now: head ${B7}, clean; `))
  const dirty = statusText(run(), summary(), context({ clean: { clean: false, why: '2 files uncommitted' } }))
  assert.equal(lineOf(dirty, '`open_pr` now:'),
    `\`open_pr\` now: head ${B7}, not clean: 2 files uncommitted (it refuses until that's fixed); the gate runs on that head when you call it; no final review approved this head (give \`reviewRuling\` to open past it).`)
  const unread = statusText(run(), summary(), context({ head: undefined, clean: undefined, headProblem: 'no worktree Acme/widget/fix-login that dish made' }))
  assert.equal(lineOf(unread, '`open_pr` now:'),
    '`open_pr` now: the head can\'t be read: no worktree Acme/widget/fix-login that dish made; the gate runs on that head when you call it; no final review approved this head (give `reviewRuling` to open past it).')
  // A head, and no answer on whether it is clean.
  const half = statusText(run(), summary(), context({ clean: undefined, headProblem: 'git status failed' }))
  assert.match(lineOf(half, '`open_pr` now:'), new RegExp(`^\`open_pr\` now: head ${B7}, but whether it is clean can't be read: git status failed;`))
  // An approval of another head isn't this head's.
  const stale = statusText(run(), summary({ finalReview: verdict({ head: SHA_C }) }), context())
  assert.match(lineOf(stale, '`open_pr` now:'), /no final review approved this head/)
})

/** A run in `project` (default Acme/widget) named `slug`, opened `minutes` before NOW. */
function listed(slug: string, minutes: number, overrides: Partial<Run> = {}): Run {
  return run({
    id: `20261003-${slug}`, slug, branch: `dish/${slug}`, worktree: `/work/Acme/widget/.worktrees/${slug}`, goal: `Goal of ${slug}`,
    openedAt: NOW - minutes * MINUTE, driver: { session: CALLER, since: NOW - minutes * MINUTE }, ...overrides,
  })
}

test('listText: the four driver wordings, for a project and for all', () => {
  const live = new Set([OTHER])
  const open = [
    listed('mine', 5),
    listed('theirs', 10, { driver: { session: OTHER, since: NOW } }),
    listed('stale', 20, { driver: { session: 'session-gone', since: NOW } }),
    listed('free', 30, { driver: { session: '', since: NOW } }),
  ]
  const text = listText(open, [], { caller: CALLER, now: NOW, live: candidate => live.has(candidate.driver.session) })
  assert.deepEqual(lines(text), [
    'Open runs:',
    '- Acme/widget `20261003-mine`: Goal of mine, opened 5 min ago; this chat drives it',
    `- Acme/widget \`20261003-theirs\`: Goal of theirs, opened 10 min ago; driven by another chat (session ${shortSession(OTHER)}, still open)`,
    `- Acme/widget \`20261003-stale\`: Goal of stale, opened 20 min ago; driven by session ${shortSession('session-gone')}, which isn't live (\`run\` \`resume\` takes it)`,
    '- Acme/widget `20261003-free`: Goal of free, opened 30 min ago; nobody drives it (`run` `resume` takes it)',
  ])
  assert.equal(lines(listText(open.slice(0, 1), [], { caller: CALLER, now: NOW, live: () => false, project: 'Acme/widget' }))[0], 'Open runs in Acme/widget:')
  assert.equal(listText([], [], { caller: CALLER, now: NOW, live: () => false }), 'No open runs.')
  assert.equal(listText([], [], { caller: CALLER, now: NOW, live: () => false, project: 'Acme/gadget' }), 'No open runs in Acme/gadget.')
})

test('listText: 51 open runs give 50 lines and how many more; 11 runs with a pull request give the newest 10 and "(and 1 older)"', () => {
  const open = Array.from({ length: 51 }, (_, index) => listed(`open-${index}`, index + 1))
  const withPr = Array.from({ length: 11 }, (_, index) => listed(`pr-${index}`, 100 + index, {
    state: 'pr', pr: { url: `https://github.com/Acme/widget/pull/${index + 1}`, number: index + 1 }, closedAt: NOW - (index + 1) * HOUR,
    driver: { session: '', since: NOW },
  }))
  // Given out of order: listText puts the newest closedAt first.
  const text = listText(open, [...withPr].reverse(), { caller: CALLER, now: NOW, live: () => false })
  const all = lines(text)
  assert.equal(all[0], 'Open runs:')
  assert.equal(all.filter(line => line.startsWith('- Acme/widget `20261003-open-')).length, 50)
  assert.equal(all[51], '(and 1 more)')
  assert.equal(all[52], '')
  assert.equal(all[53], 'With a pull request (`run` `resume` reopens one for review feedback):')
  assert.equal(all[54], '- Acme/widget `20261003-pr-0`: Goal of pr-0, PR #1 https://github.com/Acme/widget/pull/1, 1 h ago')
  assert.equal(all[63], '- Acme/widget `20261003-pr-9`: Goal of pr-9, PR #10 https://github.com/Acme/widget/pull/10, 10 h ago')
  assert.equal(all[64], '(and 1 older)')
  assert.equal(all.length, 65)
  // No open runs, and runs with a pull request: both parts.
  const onlyPr = lines(listText([], withPr.slice(0, 1), { caller: CALLER, now: NOW, live: () => false, project: 'Acme/widget' }))
  assert.deepEqual(onlyPr, [
    'No open runs in Acme/widget.', '', 'With a pull request (`run` `resume` reopens one for review feedback):',
    '- Acme/widget `20261003-pr-0`: Goal of pr-0, PR #1 https://github.com/Acme/widget/pull/1, 1 h ago',
  ])
})
