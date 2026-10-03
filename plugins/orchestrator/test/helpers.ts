/**
 * Shared by orchestrator's tests: temp directories, a fixed clock, a fake token, and builders for runs and ledger entries.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after } from 'node:test'
import type { LedgerEntry } from '../src/entries.ts'
import type { NewRun, Run } from '../src/store.ts'

const made: string[] = []

after(async () => {
  await Promise.all(made.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/** A fresh empty directory under the OS temp dir, removed when the test file finishes. */
export async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dish-orchestrator-'))
  made.push(dir)
  return dir
}

/** 2026-10-03T12:00:00Z. */
export const NOW = Date.UTC(2026, 9, 3, 12)
export const MINUTE = 60_000
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR

/** A fake installation token, built from parts so that this file holds no literal that looks like one. */
export const TOKEN = `ghs_${'Ab3dE6'.repeat(6)}`
export const MASKED_TOKEN = '‹secret: a GitHub token›'

export const SHA_A = 'a'.repeat(40)
export const SHA_B = 'b'.repeat(40)
export const SHA_C = 'c0ffee'.padEnd(40, '1')

export function newRun(overrides: Partial<NewRun> = {}): NewRun {
  const slug = overrides.slug ?? 'fix-login'
  return {
    project: 'Acme/widget',
    slug,
    goal: 'Fix the login redirect',
    branch: `dish/${slug}`,
    worktree: `/work/Acme/widget/.worktrees/${slug}`,
    base: 'origin/main',
    baseCommit: SHA_A,
    driver: 'session-1',
    openedAt: NOW,
    ...overrides,
  }
}

/** A run record as the store keeps it, for the pure derivations. */
export function run(overrides: Partial<Run> = {}): Run {
  return {
    id: '20261003-fix-login',
    project: 'Acme/widget',
    slug: 'fix-login',
    goal: 'Fix the login redirect',
    branch: 'dish/fix-login',
    worktree: '/work/Acme/widget/.worktrees/fix-login',
    base: 'origin/main',
    baseCommit: SHA_A,
    state: 'open',
    driver: { session: 'session-1', since: NOW },
    openedAt: NOW,
    ...overrides,
  }
}

const RUN_ID = '20261003-fix-login'

/**
 * One entry of each kind, in the order a run might write them, `at` one minute apart from `NOW`. Every field each kind
 * has, so that the ledger's and derive's tests start from the same shapes Task 8 writes.
 */
export function everyKind(id = RUN_ID): LedgerEntry[] {
  let minute = 0
  const at = (): number => NOW + (minute++) * MINUTE
  const coderReport = {
    role: 'coder' as const, turn: 3, at: NOW, status: 'done' as const, summary: 'Fixed the redirect', commits: [SHA_B],
    rulings: [{ what: 'kept the old cookie', why: 'compat', costIfWrong: 'one more round' }], concerns: ['flaky test'],
  }
  const reviewerReport = {
    role: 'reviewer' as const, turn: 2, at: NOW, verdict: 'approved' as const, head: SHA_B, summary: 'Looks right',
    findings: [{ severity: 'nit' as const, file: 'src/a.ts', line: 3, summary: 'name', fix: 'rename it' }],
    checks: [{ command: 'pnpm test', exitCode: 0, summary: 'passed' }],
  }
  return [
    { at: at(), run: id, kind: 'run.opened', by: 'harness', session: 'session-1', goal: 'Fix the login redirect', branch: 'dish/fix-login',
      worktree: '/work/Acme/widget/.worktrees/fix-login', base: 'origin/main', baseCommit: SHA_A, how: 'run' },
    { at: at(), run: id, kind: 'run.goal', by: 'harness', session: 'session-1', goal: 'Fix the login redirect for SSO' },
    { at: at(), run: id, kind: 'run.plan', by: 'harness', session: 'session-1', path: 'docs/plans/x.md', commit: SHA_A },
    { at: at(), run: id, kind: 'task.opened', by: 'harness', session: 'session-1', task: 'api', path: '/work/Acme/widget/.worktrees/api',
      branch: 'dish/api', base: 'dish/fix-login', baseCommit: SHA_A },
    { at: at(), run: id, kind: 'child.started', by: 'harness', session: 'session-1', child: 'c1', task: 'api', role: 'coder', title: 'API',
      model: 'deepseek-chat', family: 'deepseek', followUp: false, round: 0 },
    { at: at(), run: id, kind: 'gate.result', by: 'harness', session: 'session-1', child: 'c1', task: 'api', outcome: 'passed', exitCode: 0,
      timedOut: false, durationMs: 1200, log: '/logs/gate-1.log', head: SHA_B, gateTurn: 3, gateRound: 1 },
    { at: at(), run: id, kind: 'child.ended', by: 'harness', session: 'session-1', child: 'c1', task: 'api', role: 'coder', stopReason: 'completed',
      reportFile: '/r/1-coder-1.md', structuredFile: '/r/1-coder-1.json', report: coderReport, head: SHA_B },
    { at: at(), run: id, kind: 'child.started', by: 'harness', session: 'session-1', child: 'r1', task: 'api', role: 'reviewer', title: 'Review API',
      model: 'deepseek-reasoner', family: 'deepseek', followUp: false, reviews: 'c1', final: true },
    { at: at(), run: id, kind: 'child.ended', by: 'harness', session: 'session-1', child: 'r1', task: 'api', role: 'reviewer', stopReason: 'completed',
      reportFile: '/r/2-reviewer-1.md', report: reviewerReport, head: SHA_B },
    { at: at(), run: id, kind: 'review.verdict', by: 'harness', session: 'session-1', child: 'r1', task: 'api', verdict: 'approved', head: SHA_B,
      final: true, findings: { blocking: 0, should_fix: 0, nit: 1 } },
    { at: at(), run: id, kind: 'ladder.refused', by: 'harness', session: 'session-1', task: 'api', round: 5 },
    { at: at(), run: id, kind: 'ladder.ruled', by: 'harness', session: 'session-1', task: 'api', round: 5, ruling: 'one more round — close — an hour' },
    { at: at(), run: id, kind: 'ruling', by: 'main', session: 'session-1', task: 'api', what: 'skip the e2e', why: 'flaky', costIfWrong: 'a regression' },
    { at: at(), run: id, kind: 'deferred', by: 'main', session: 'session-1', what: 'rename helper', where: 'src/a.ts', why: 'out of scope' },
    { at: at(), run: id, kind: 'note', by: 'main', session: 'session-1', text: 'waiting on the user' },
    { at: at(), run: id, kind: 'pr.checked', by: 'harness', session: 'session-1', head: SHA_B,
      gate: { outcome: 'passed', exitCode: 0, timedOut: false, durationMs: 900, log: '/logs/gate-2.log', head: SHA_B },
      final: { child: 'r1', verdict: 'approved', head: SHA_B, at: NOW }, gateOk: true, reviewOk: true, overrides: {}, result: 'pass' },
    { at: at(), run: id, kind: 'pr.opened', by: 'harness', session: 'session-1', url: 'https://github.com/Acme/widget/pull/7', number: 7,
      head: SHA_B, branch: 'dish/fix-login' },
    { at: at(), run: id, kind: 'run.closed', by: 'harness', session: 'session-1', state: 'pr', pr: { url: 'https://github.com/Acme/widget/pull/7', number: 7 } },
    { at: at(), run: id, kind: 'run.resumed', by: 'harness', session: 'session-2', driver: 'session-2', reopened: true },
    { at: at(), run: id, kind: 'run.takenOver', by: 'harness', session: 'session-3', driver: 'session-3', previous: 'session-2' },
    { at: at(), run: id, kind: 'pr.feedback', by: 'harness', session: 'session-3', number: 7, state: 'open', merged: false, mergeable: true,
      reviews: { approved: 0, changesRequested: 1, commented: 2, other: 0 }, reviewComments: 4, outdated: 1, issueComments: 2,
      checks: { passed: 3, failed: 1, pending: 0, other: 0 } },
    { at: at(), run: id, kind: 'task.removed', by: 'harness', task: 'api' },
    { at: at(), run: id, kind: 'pr.updated', by: 'harness', session: 'session-3', url: 'https://github.com/Acme/widget/pull/7', number: 7,
      head: SHA_C, branch: 'dish/fix-login', titleChanged: true, bodyChanged: false, comment: 'posted' },
  ]
}
