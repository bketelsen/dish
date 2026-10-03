/**
 * `open_pr` (Task 10): its checks in order, each refusal pushing nothing, the overrides and their lines, the push and the
 * pull request, a run reopened for review feedback, and secrets; over Task 8's world, whose stubs record every call.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { GateCheck } from 'dish-gates'
import type { LedgerEntry } from '../src/entries.ts'
import { BODY_MAX, GATE_LINE, MAIN_ONLY, NO_RUN, REVIEW_LINE, TITLE_MAX, openPrTool, overrideLines, prBody, refusalText } from '../src/open-pr.ts'
import type { Run } from '../src/store.ts'
import {
  HEAD, MASKED_TOKEN, OTHER_SESSION, PROJECT, SESSION, SHA_A, SHA_C, TOKEN, childExec, deferred, mainExec, waitFor, world,
} from './service-helpers.ts'
import type { World } from './service-helpers.ts'

const TITLE = 'Fix the login redirect'
const BODY = 'The login page sent everyone to `/`.\n\nNow it sends them back where they were.'
const RULING = 'Ruling: the flaky e2e suite — it fails on main too — a real failure could hide in it'

interface Setup {
  w: World
  run: Run
  tool: ToolDefinition
}

/** A world with a run this chat drives (its worktree at HEAD, clean), and the tool over it. */
async function setup(): Promise<Setup> {
  const w = await world()
  const run = await w.open()
  return { w, run, tool: openPrTool(w.deps)! }
}

/** A `review.verdict`, as the settled listener writes one for a reviewer's report. */
async function verdict(w: World, run: Run, given: { child?: string, verdict?: 'approved' | 'changes_requested', head?: string, final?: boolean } = {}): Promise<void> {
  await w.runs.harness(run, {
    kind: 'review.verdict', session: SESSION, child: given.child ?? 'rev-1', task: run.slug, verdict: given.verdict ?? 'approved',
    head: given.head ?? HEAD, final: given.final ?? true, findings: { blocking: 0, should_fix: 0, nit: 0 },
  })
}

/** `open_pr` called by the main agent of SESSION, with a title and a body unless `args` says otherwise. */
async function call(tool: ToolDefinition, args: Record<string, unknown> = {}, exec = mainExec(SESSION)): Promise<{ url: string, number: number, existing: boolean, head: string, text: string }> {
  return await tool.execute({ title: TITLE, body: BODY, ...args }, exec) as { url: string, number: number, existing: boolean, head: string, text: string }
}

/** Whether `promise` rejects with a message holding every one of `parts`; gives the message. */
async function refused(promise: Promise<unknown>, ...parts: string[]): Promise<string> {
  let message: string | undefined
  await assert.rejects(promise, (error: Error) => {
    message = error.message
    return true
  })
  for (const part of parts) assert.ok(message!.includes(part), `expected ${JSON.stringify(part)} in: ${message}`)
  return message!
}

/** Nothing pushed, opened, edited or commented on. */
function nothingWritten(w: World): void {
  assert.equal(w.workspaces.calls.pushBranch.length, 0, 'pushBranch')
  assert.equal(w.workspaces.calls.openPull.length, 0, 'openPull')
  assert.equal(w.workspaces.calls.updatePull.length, 0, 'updatePull')
  assert.equal(w.workspaces.calls.commentPull.length, 0, 'commentPull')
}

/** The kinds written after run.opened. */
async function written(w: World, run: Run): Promise<string[]> {
  return (await w.kinds(run)).filter(kind => kind !== 'run.opened' && kind !== 'review.verdict')
}

async function entriesOf(w: World, run: Run, kind: string): Promise<Array<Record<string, unknown>>> {
  return (await w.entries(run)).filter(entry => entry.kind === kind) as unknown as Array<Record<string, unknown>>
}

/** A run with PR #7 that was closed by an open_pr and reopened by this chat for review feedback: its head moved to SHA_C, which the final reviewer approved; GitHub reports #7 as open. */
async function reopened(): Promise<Setup & { pr: { url: string, number: number } }> {
  const { w, run, tool } = await setup()
  const pr = { url: `https://github.com/${PROJECT}/pull/7`, number: 7 }
  const closed = await w.runs.withRun(run, () => w.runs.close(run, SESSION, { state: 'pr', pr }))
  const { how } = await w.runs.withSession(SESSION, () => w.runs.drive(SESSION, closed, { takeover: false }))
  assert.equal(how, 'reopened')
  w.workspaces.impl.openPull = async () => ({ ...pr, existing: true })
  w.heads.set(run.worktree, SHA_C)
  await verdict(w, run, { head: SHA_C })
  return { w, run, tool, pr }
}

/** A gate result as runAt gives one. */
function gate(fields: Partial<GateCheck>): GateCheck {
  return {
    outcome: 'failed', command: 'pnpm test', exitCode: 1, timedOut: false, durationMs: 83_400, log: '/state/gates/Acme/widget/fix-login/open_pr.log',
    excerpt: 'not ok 3', at: 0, head: HEAD, ...fields,
  }
}

// --- the tool ---------------------------------------------------------------------------------------------------------

test('open_pr: its name, and schemas dsh supports', async () => {
  const { tool } = await setup()
  assert.equal(tool.name, 'open_pr')
  assertSupportedJsonSchema(tool.parameters as never)
  assertSupportedJsonSchema(tool.output.schema as never)
  assert.match(tool.description, /never `git push` or `gh pr create`/)
})

// --- the caller and the arguments -------------------------------------------------------------------------------------

test('open_pr: a crew child is refused, and no service is called', async () => {
  const { w, run, tool } = await setup()
  await verdict(w, run)
  await assert.rejects(call(tool, {}, childExec()), (error: Error) => error.message === MAIN_ONLY)
  for (const calls of [w.workspaces.calls, w.gates.calls, w.crew.calls]) {
    for (const [name, list] of Object.entries(calls)) assert.equal((list as unknown[]).length, 0, name)
  }
})

test('open_pr: a title over 256 characters, a body over 60,000, and `Ruling:` alone in a ruling are refused before the run is read', async () => {
  const { w, run, tool } = await setup()
  await verdict(w, run)
  await refused(call(tool, { title: 'x'.repeat(TITLE_MAX + 44) }), '`title` is one line, at most 256 characters')
  await refused(call(tool, { body: 'x'.repeat(BODY_MAX + 1) }), '`body` is at most 60,000 characters')
  await refused(call(tool, { gateRuling: 'Ruling:' }), 'gateRuling needs the ruling itself: `Ruling: what — why — cost if wrong`')
  await refused(call(tool, { reviewRuling: '  Ruling:  ' }), 'reviewRuling needs the ruling itself: `Ruling: what — why — cost if wrong`')
  await refused(call(tool, { reviewRuling: 'Ruling: what — why — cost if wrong' }), 'reviewRuling needs the ruling itself')
  assert.equal(w.workspaces.calls.resolve.length, 0)
  nothingWritten(w)
  // A title of exactly 256, on lines of its own, is folded and taken.
  const value = await call(tool, { title: `${'x'.repeat(200)}\n${'y'.repeat(55)}` })
  assert.equal(value.number, 1)
  assert.equal(w.workspaces.calls.openPull[0]![1].title, `${'x'.repeat(200)} ${'y'.repeat(55)}`)
})

test('open_pr: with no pull request on the run, no title and an empty body are each refused', async () => {
  const { w, run, tool } = await setup()
  await verdict(w, run)
  await refused(call(tool, { title: '' }), '`title` is required: one line, at most 256 characters')
  await refused(tool.execute({ body: BODY }, mainExec(SESSION)), '`title` is required')
  await refused(call(tool, { body: '  \n ' }), '`body` is required: the pull request\'s description in Markdown, at most 60,000 characters')
  nothingWritten(w)
  assert.deepEqual(await written(w, run), [])
})

test('open_pr: a chat that drives no run gets NO_RUN', async () => {
  const { w, tool } = await setup()
  await assert.rejects(call(tool, {}, mainExec(OTHER_SESSION)), (error: Error) => error.message === NO_RUN)
  nothingWritten(w)
})

// --- each check, failing, and nothing pushed ------------------------------------------------------------------------

test('open_pr: without dish-workspaces it refuses, and records nothing', async () => {
  const { w, run, tool } = await setup()
  await verdict(w, run)
  w.absent.add('workspaces')
  await refused(call(tool), 'dish-workspaces isn\'t running, so nothing can be pushed')
  w.absent.delete('workspaces')
  nothingWritten(w)
  assert.deepEqual(await written(w, run), [])
})

test('open_pr: a coder still running in the run\'s worktree refuses it; a finished one doesn\'t', async () => {
  const { w, run, tool } = await setup()
  await verdict(w, run)
  w.bindings.set(run.worktree, [
    { child: 'c-old', sessionId: SESSION, role: 'coder', title: 'An older round', running: false },
    { child: 'c-7', sessionId: SESSION, role: 'coder', title: 'Fix the redirect', running: true },
  ])
  await refused(call(tool), 'coder «Fix the redirect» (child c-7) is still working in the run\'s worktree: wait for its finish notice, then call open_pr again. Nothing was pushed.')
  assert.deepEqual(w.crew.calls.worktreeBindings, [[run.worktree]])
  assert.equal(w.gates.calls.runAt.length, 0)
  nothingWritten(w)
  assert.deepEqual(await written(w, run), [])
  w.bindings.set(run.worktree, [{ child: 'c-7', sessionId: SESSION, role: 'coder', title: 'Fix the redirect', running: false }])
  assert.equal((await call(tool)).number, 1)
})

test('open_pr: without dish-crew the bindings aren\'t asked, and it goes on', async () => {
  const { w, run, tool } = await setup()
  await verdict(w, run)
  w.absent.add('crew')
  assert.equal((await call(tool)).number, 1)
  assert.equal(w.crew.calls.worktreeBindings.length, 0)
})

test('open_pr: a worktree that doesn\'t resolve, with and without resolveProblem\'s reason, and one on another branch', async () => {
  const { w, run, tool } = await setup()
  await verdict(w, run)
  w.worktrees.clear()
  await refused(call(tool), `the run's worktree ${run.worktree} can't be pushed: it is gone, or its project is no longer registered. Nothing was pushed.`)
  w.workspaces.impl.resolveProblem = async () => 'its branch dish/fix-login is gone'
  await refused(call(tool), `the run's worktree ${run.worktree} can't be pushed: its branch dish/fix-login is gone. Nothing was pushed.`)
  w.workspaces.impl.resolve = async () => ({ project: PROJECT, slug: 'fix-login', branch: 'dish/other', path: run.worktree, clone: '/clone', base: SHA_A })
  await refused(call(tool), 'the run\'s worktree is on dish/other, not dish/fix-login. Nothing was pushed.')
  assert.equal(w.gates.calls.runAt.length, 0)
  nothingWritten(w)
  assert.deepEqual(await written(w, run), [])
})

test('open_pr: a worktree that isn\'t clean (with why), and isClean rejecting', async () => {
  const { w, run, tool } = await setup()
  await verdict(w, run)
  w.workspaces.impl.isClean = async () => ({ clean: false, why: '2 files changed, 1 untracked' })
  await refused(call(tool), 'the run\'s worktree isn\'t clean (2 files changed, 1 untracked): commit or remove the changes in a coder\'s round, then call open_pr again. Nothing was pushed.')
  w.workspaces.impl.isClean = async () => { throw new Error('git status failed') }
  await refused(call(tool), 'can\'t tell whether the run\'s worktree is clean: git status failed. Nothing was pushed.')
  assert.equal(w.gates.calls.runAt.length, 0)
  nothingWritten(w)
  assert.deepEqual(await written(w, run), [])
})

test('open_pr: a head that can\'t be read, undefined or a rejection', async () => {
  const { w, run, tool } = await setup()
  await verdict(w, run)
  w.workspaces.impl.headOf = async () => undefined
  await refused(call(tool), 'can\'t read the run\'s head: ', '. Nothing was pushed.')
  w.workspaces.impl.headOf = async () => { throw new Error('fatal: bad object HEAD') }
  await refused(call(tool), 'can\'t read the run\'s head: fatal: bad object HEAD. Nothing was pushed.')
  assert.equal(w.gates.calls.runAt.length, 0)
  nothingWritten(w)
  assert.deepEqual(await written(w, run), [])
})

test('open_pr: a failing gate refuses with its exit, duration and log, and records pr.checked refused', async () => {
  const { w, run, tool } = await setup()
  await verdict(w, run)
  w.gates.impl.runAt = async () => gate({})
  const message = await refused(call(tool),
    `open_pr refused for run \`${run.id}\` at bbbbbbb; nothing was pushed:`,
    '- the gate failed with exit 1 after 1 min 23 s (log /state/gates/Acme/widget/fix-login/open_pr.log). Fix it in a coder\'s round, or give `gateRuling: "Ruling: what — why — cost if wrong"` to open the PR past it.')
  assert.ok(!message.includes('final review'), 'only the failed checks are given')
  nothingWritten(w)
  const [checked] = await entriesOf(w, run, 'pr.checked')
  assert.equal(checked!.by, 'harness')
  assert.equal(checked!.session, SESSION)
  assert.equal(checked!.result, 'refused')
  assert.equal(checked!.gateOk, false)
  assert.equal(checked!.reviewOk, true)
  assert.equal(checked!.head, HEAD)
  assert.deepEqual(checked!.overrides, {})
  assert.deepEqual(checked!.gate, { outcome: 'failed', exitCode: 1, timedOut: false, durationMs: 83_400, log: '/state/gates/Acme/widget/fix-login/open_pr.log', head: HEAD })
  assert.deepEqual(checked!.final, { child: 'rev-1', verdict: 'approved', head: HEAD, at: (await entriesOf(w, run, 'review.verdict'))[0]!.at })
  assert.equal((checked!.refused as string[]).length, 1)
  assert.equal(w.record(run)?.state, 'open')
})

test('open_pr: a gate stopped at its time limit, a gate error, and runAt\'s error for a moved head', async () => {
  const { w, run, tool } = await setup()
  await verdict(w, run)
  w.gates.impl.runAt = async () => gate({ timedOut: true, exitCode: null })
  await refused(call(tool), '- the gate was stopped at its time limit (log /state/gates/Acme/widget/fix-login/open_pr.log).')
  w.gates.impl.runAt = async () => gate({ outcome: 'error', exitCode: null, log: null, durationMs: 0, reason: 'dish-gates can\'t run a gate: no shell' })
  await refused(call(tool), '- the gate couldn\'t run: dish-gates can\'t run a gate: no shell.')
  w.gates.impl.runAt = async () => gate({ outcome: 'error', exitCode: null, log: null, durationMs: 0, head: SHA_C, reason: `the worktree's HEAD is ${SHA_C}, not ${HEAD}: it moved after the caller read it` })
  await refused(call(tool), `- the gate couldn't run: the worktree's HEAD is ${SHA_C}, not ${HEAD}: it moved after the caller read it.`)
  w.gates.impl.runAt = async () => { throw new Error('dish-gates broke') }
  await refused(call(tool), '- the gate couldn\'t run: dish-gates broke.')
  nothingWritten(w)
  const checked = await entriesOf(w, run, 'pr.checked')
  assert.deepEqual(checked.map(entry => entry.result), ['refused', 'refused', 'refused', 'refused'])
  assert.equal((checked[3]!.gate as { outcome: string, reason: string }).outcome, 'error')
  assert.equal((checked[3]!.gate as { outcome: string, reason: string }).reason, 'dish-gates broke')
})

test('open_pr: a passed gate at another head doesn\'t count', async () => {
  const { w, run, tool } = await setup()
  await verdict(w, run)
  w.gates.impl.runAt = async () => gate({ outcome: 'passed', exitCode: 0, head: SHA_C })
  await refused(call(tool), '- the gate passed at c0ffee1, not at this head.')
  nothingWritten(w)
})

test('open_pr: without dish-gates the gate didn\'t run, which refuses it', async () => {
  const { w, run, tool } = await setup()
  await verdict(w, run)
  w.absent.add('gates')
  await refused(call(tool), '- the gate didn\'t run: dish-gates isn\'t running.', 'gateRuling')
  nothingWritten(w)
  const [checked] = await entriesOf(w, run, 'pr.checked')
  assert.equal(checked!.gate, null)
  assert.equal(checked!.gateOk, false)
})

test('open_pr: no final review, one that requested changes, a stale approval, and a non-final approval each refuse it', async () => {
  const { w, run, tool } = await setup()
  const tail = 'Delegate a fresh reviewer with `final: true` (or send the final reviewer a re-review with `to`), or give `reviewRuling: "Ruling: what — why — cost if wrong"` to open past it.'
  let message = await refused(call(tool), '- no final review approved bbbbbbb: there is none yet. ', tail)
  assert.ok(!message.includes('the gate'), 'only the failed checks are given')
  await verdict(w, run, { child: 'rev-2', verdict: 'changes_requested' })
  await refused(call(tool), '- no final review approved bbbbbbb: the latest final review (child rev-2) requested changes at bbbbbbb.')
  await verdict(w, run, { child: 'rev-3', head: SHA_A })
  await refused(call(tool), '- no final review approved bbbbbbb: the latest final review (child rev-3) approved aaaaaaa, not this head.')
  await verdict(w, run, { child: 'rev-4', final: false })
  message = await refused(call(tool), 'the latest final review (child rev-3) approved aaaaaaa, not this head')
  assert.ok(!message.includes('rev-4'))
  nothingWritten(w)
  const checked = await entriesOf(w, run, 'pr.checked')
  assert.deepEqual(checked.map(entry => [entry.result, entry.gateOk, entry.reviewOk]), [
    ['refused', true, false], ['refused', true, false], ['refused', true, false], ['refused', true, false],
  ])
  assert.equal(checked[0]!.final, null)
  assert.deepEqual((checked[3]!.final as { child: string }).child, 'rev-3')
})

test('open_pr: both checks failing give both lines, the gate\'s first', async () => {
  const { w, run, tool } = await setup()
  w.gates.impl.runAt = async () => gate({})
  const message = await refused(call(tool))
  const lines = message.split('\n')
  assert.equal(lines.length, 3)
  assert.match(lines[1]!, /^- the gate failed/)
  assert.match(lines[2]!, /^- no final review approved/)
  const [checked] = await entriesOf(w, run, 'pr.checked')
  assert.equal((checked!.refused as string[]).length, 2)
})

test('open_pr: the head moving while the gate ran is refused, and recorded', async () => {
  const { w, run, tool } = await setup()
  await verdict(w, run)
  let reads = 0
  w.workspaces.impl.headOf = async () => (reads++ === 0 ? HEAD : SHA_C)
  await refused(call(tool), 'the run\'s worktree changed while the gate ran (bbbbbbb → c0ffee1): call open_pr again. Nothing was pushed.')
  nothingWritten(w)
  const [checked] = await entriesOf(w, run, 'pr.checked')
  assert.equal(checked!.result, 'refused')
  assert.deepEqual(checked!.refused, ['the worktree changed while the gate ran'])
  // New uncommitted changes during the gate: refused the same way.
  w.workspaces.impl.headOf = async () => HEAD
  let cleans = 0
  w.workspaces.impl.isClean = async () => (cleans++ === 0 ? { clean: true } : { clean: false, why: 'src/a.ts changed' })
  await refused(call(tool), 'the run\'s worktree changed while the gate ran (new uncommitted changes: src/a.ts changed): call open_pr again. Nothing was pushed.')
  nothingWritten(w)
})

// --- all passing ----------------------------------------------------------------------------------------------------

test('open_pr: all passing pushes the head, opens the pull request, and closes the run', async () => {
  const { w, run, tool } = await setup()
  await verdict(w, run)
  const controller = new AbortController()
  const exec = mainExec(SESSION, undefined, { signal: controller.signal })
  const value = await call(tool, { title: `  ${TITLE}  `, body: `${BODY}\n\n` }, exec)

  assert.equal(w.gates.calls.runAt.length, 1)
  const [project, path, options] = w.gates.calls.runAt[0]!
  assert.equal(project, PROJECT)
  assert.equal(path, run.worktree)
  assert.equal(options.sessionId, SESSION)
  assert.equal(options.head, HEAD)
  assert.equal(options.signal, controller.signal)

  assert.deepEqual(w.workspaces.calls.pushBranch, [[PROJECT, 'fix-login', { head: HEAD, signal: controller.signal }]])
  assert.deepEqual(w.workspaces.calls.openPull, [[PROJECT, { head: 'dish/fix-login', title: TITLE, body: BODY }]])
  assert.equal(w.workspaces.calls.updatePull.length, 0)
  assert.equal(w.workspaces.calls.commentPull.length, 0)

  const url = `https://github.com/${PROJECT}/pull/1`
  assert.deepEqual({ ...value, text: undefined }, { url, number: 1, existing: false, head: HEAD, text: undefined })
  assert.equal(tool.output.render({}, value as never).map(block => (block as { text?: string }).text ?? '').join('\n'), value.text)
  assert.equal(value.text, [
    `Opened PR #1 for run \`${run.id}\`: ${url}`,
    'Pushed dish/fix-login at bbbbbbb: the gate passed on it; the final review approved it.',
    `Run \`${run.id}\` is closed. Humans merge; dish removes the run's worktrees once the PR is merged. Review feedback: \`run\` \`resume\` reopens it.`,
  ].join('\n'))

  assert.deepEqual(await written(w, run), ['pr.checked', 'pr.opened', 'run.closed'])
  const [checked] = await entriesOf(w, run, 'pr.checked')
  assert.equal(checked!.result, 'pass')
  assert.equal(checked!.refused, undefined)
  const [opened] = await entriesOf(w, run, 'pr.opened')
  assert.deepEqual({ ...opened, at: 0 }, { at: 0, run: run.id, kind: 'pr.opened', by: 'harness', session: SESSION, url, number: 1, head: HEAD, branch: 'dish/fix-login' })
  const [closed] = await entriesOf(w, run, 'run.closed')
  assert.deepEqual(closed!.pr, { url, number: 1 })

  const record = w.record(run)!
  assert.equal(record.state, 'pr')
  assert.deepEqual(record.pr, { url, number: 1 })
  assert.equal(record.closedAt, w.clock.now)
  assert.equal(record.driver.session, '')
  assert.equal(await w.runs.driving(SESSION), undefined)
  await assert.rejects(call(tool), (error: Error) => error.message === NO_RUN)
})

test('open_pr: a final reviewer\'s re-review with `to` counts; so does an approval of a 7-character prefix', async () => {
  const { w, run, tool } = await setup()
  await verdict(w, run, { child: 'rev-1', head: SHA_A })
  await verdict(w, run, { child: 'rev-1', head: HEAD })
  assert.equal((await call(tool)).number, 1)

  const other = await setup()
  await verdict(other.w, other.run, { head: HEAD.slice(0, 7) })
  assert.equal((await call(other.tool)).number, 1)
})

// --- overrides --------------------------------------------------------------------------------------------------------

test('overrideLines and prBody: the gate\'s line first, then the review\'s, each after a blank line; nothing for none', () => {
  assert.equal(overrideLines({}), '')
  assert.equal(overrideLines({ gate: 'g — w — c' }), `${GATE_LINE}g — w — c`)
  assert.equal(overrideLines({ review: 'r — w — c', gate: 'g — w — c' }), `${GATE_LINE}g — w — c\n\n${REVIEW_LINE}r — w — c`)
  assert.equal(prBody('Body.\n\n', {}), 'Body.')
  assert.equal(prBody('Body.', { gate: 'g' }), `Body.\n\n${GATE_LINE}g`)
  assert.equal(prBody('', { review: 'r' }), `${REVIEW_LINE}r`)
  assert.equal(prBody(`key ${TOKEN}`, { gate: `g ${TOKEN}` }), `key ${MASKED_TOKEN}\n\n${GATE_LINE}g ${MASKED_TOKEN}`)
  assert.equal(GATE_LINE, '⚠ dish: opened past a failing gate. Ruling: ')
  assert.equal(REVIEW_LINE, '⚠ dish: opened without an approved final review of this head. Ruling: ')
})

test('open_pr: gateRuling past a failing gate adds the gate\'s line, once, without a doubled Ruling:', async () => {
  const { w, run, tool } = await setup()
  await verdict(w, run)
  w.gates.impl.runAt = async () => gate({})
  const value = await call(tool, { gateRuling: RULING })
  const body = w.workspaces.calls.openPull[0]![1].body
  assert.equal(body, `${BODY}\n\n${GATE_LINE}the flaky e2e suite — it fails on main too — a real failure could hide in it`)
  assert.ok(!body.includes('Ruling: Ruling:'))
  const [checked] = await entriesOf(w, run, 'pr.checked')
  assert.equal(checked!.result, 'pass')
  assert.deepEqual(checked!.overrides, { gate: 'the flaky e2e suite — it fails on main too — a real failure could hide in it' })
  assert.match(value.text, /Pushed dish\/fix-login at bbbbbbb: past a gate that didn't pass, on your ruling; the final review approved it\./)
  assert.match(value.text, /The body ends with dish's line for each override\./)
})

test('open_pr: reviewRuling adds the review\'s line; both add both, the gate\'s first', async () => {
  const { w, tool } = await setup()
  await call(tool, { reviewRuling: 'Ruling: merge of origin/main only — no conflicts — a bad merge' })
  assert.equal(w.workspaces.calls.openPull[0]![1].body, `${BODY}\n\n${REVIEW_LINE}merge of origin/main only — no conflicts — a bad merge`)

  const both = await setup()
  both.w.gates.impl.runAt = async () => gate({})
  const value = await call(both.tool, { gateRuling: 'g — w — c', reviewRuling: 'r — w — c' })
  assert.equal(both.w.workspaces.calls.openPull[0]![1].body, `${BODY}\n\n${GATE_LINE}g — w — c\n\n${REVIEW_LINE}r — w — c`)
  assert.match(value.text, /past a gate that didn't pass, on your ruling; without an approved final review of it, on your ruling\./)
})

test('open_pr: a ruling for a check that passed is ignored: no line, no override in pr.checked', async () => {
  const { w, run, tool } = await setup()
  await verdict(w, run)
  const value = await call(tool, { gateRuling: RULING, reviewRuling: RULING })
  assert.equal(w.workspaces.calls.openPull[0]![1].body, BODY)
  const [checked] = await entriesOf(w, run, 'pr.checked')
  assert.deepEqual(checked!.overrides, {})
  assert.ok(!value.text.includes('override'))
})

test('open_pr: without dish-gates, gateRuling lets it through', async () => {
  const { w, run, tool } = await setup()
  await verdict(w, run)
  w.absent.add('gates')
  const value = await call(tool, { gateRuling: RULING })
  assert.equal(value.number, 1)
  assert.match(w.workspaces.calls.openPull[0]![1].body, new RegExp(`\\n\\n${GATE_LINE}the flaky e2e suite`))
  assert.match(value.text, /without the gate \(dish-gates isn't running\), on your ruling/)
  assert.equal(w.record(run)?.state, 'pr')
})

// --- the push and the pull request, failing -------------------------------------------------------------------------

test('open_pr: a rejected push gives GitHub\'s reason, masked; nothing is opened and the run stays open', async () => {
  const { w, run, tool } = await setup()
  await verdict(w, run)
  w.workspaces.impl.pushBranch = async () => { throw new Error(`GitHub refused the push of dish/fix-login: [remote rejected] (refusing to allow a GitHub App to create or update workflow without workflows permission) token ${TOKEN}`) }
  const message = await refused(call(tool), 'GitHub refused the push of dish/fix-login: [remote rejected]', MASKED_TOKEN, ' Nothing else was done; the run stays open.')
  assert.ok(!message.includes(TOKEN))
  assert.equal(w.workspaces.calls.openPull.length, 0)
  assert.deepEqual(await written(w, run), ['pr.checked'])
  assert.equal(w.record(run)?.state, 'open')
  assert.equal(w.record(run)?.driver.session, SESSION)
})

test('open_pr: a rejected pull request leaves the run open, and a second open_pr pushes again and opens it', async () => {
  const { w, run, tool } = await setup()
  await verdict(w, run)
  w.workspaces.impl.openPull = async () => { throw new Error('could not open the pull request for dish/fix-login: Validation Failed') }
  await refused(call(tool), 'dish/fix-login was pushed at bbbbbbb, but GitHub refused the pull request: could not open the pull request for dish/fix-login: Validation Failed. The run stays open: call open_pr again once that\'s fixed.')
  assert.equal(w.record(run)?.state, 'open')
  assert.deepEqual(await written(w, run), ['pr.checked'])
  w.workspaces.impl.openPull = async project => ({ url: `https://github.com/${project}/pull/3`, number: 3, existing: false })
  const value = await call(tool)
  assert.equal(value.number, 3)
  assert.equal(w.workspaces.calls.pushBranch.length, 2)
  assert.deepEqual(await written(w, run), ['pr.checked', 'pr.checked', 'pr.opened', 'run.closed'])
  assert.equal(w.record(run)?.state, 'pr')
})

// --- review feedback: a reopened run --------------------------------------------------------------------------------

test('open_pr on a reopened run, with no title or body: the same checks, the new head pushed, pr.updated, nothing edited', async () => {
  const { w, run, tool, pr } = await reopened()
  const value = await call(tool, { title: '', body: '' })
  assert.equal(w.gates.calls.runAt[0]![2].head, SHA_C)
  assert.equal(w.workspaces.calls.compareBranch.length, 1)
  assert.deepEqual(w.workspaces.calls.compareBranch[0], [PROJECT, 'fix-login'])
  assert.deepEqual(w.workspaces.calls.pushBranch[0]!.slice(0, 2), [PROJECT, 'fix-login'])
  assert.equal(w.workspaces.calls.pushBranch[0]![2].head, SHA_C)
  assert.equal(w.workspaces.calls.updatePull.length, 0)
  assert.equal(w.workspaces.calls.commentPull.length, 0)
  assert.deepEqual({ ...value, text: undefined }, { url: pr.url, number: 7, existing: true, head: SHA_C, text: undefined })
  assert.equal(value.text.split('\n')[0], `Pushed c0ffee1 to the pull request already open for dish/fix-login: #7 ${pr.url}. dish opened no other. Its title and body are as they were.`)
  assert.match(value.text, /Run `[^`]+` is closed\./)

  const kinds = await written(w, run)
  assert.deepEqual(kinds.slice(kinds.lastIndexOf('run.resumed') + 1), ['pr.checked', 'pr.updated', 'run.closed'])
  const [updated] = await entriesOf(w, run, 'pr.updated')
  assert.deepEqual({ ...updated, at: 0 }, {
    at: 0, run: run.id, kind: 'pr.updated', by: 'harness', session: SESSION, url: pr.url, number: 7, head: SHA_C, branch: 'dish/fix-login',
    titleChanged: false, bodyChanged: false,
  })
  const record = w.record(run)!
  assert.equal(record.state, 'pr')
  assert.deepEqual(record.pr, pr)
  assert.equal(record.driver.session, '')
})

test('open_pr on a reopened run: a title, a body, or both update the pull request; the body masked, with no override line in it', async () => {
  for (const [args, sent, sentence] of [
    [{ title: 'A better title', body: '' }, { title: 'A better title' }, ' Its title was updated to yours.'],
    [{ title: '', body: `New body ${TOKEN}` }, { body: `New body ${MASKED_TOKEN}` }, ' Its body was updated to yours.'],
    [{ title: 'Both', body: 'Both bodies' }, { title: 'Both', body: 'Both bodies' }, ' Its title and body were updated to yours.'],
  ] as const) {
    const { w, run, tool } = await reopened()
    const value = await call(tool, args)
    assert.deepEqual(w.workspaces.calls.updatePull, [[PROJECT, 7, sent]])
    assert.ok(value.text.split('\n')[0]!.endsWith(sentence), value.text)
    const [updated] = await entriesOf(w, run, 'pr.updated')
    assert.equal(updated!.titleChanged, 'title' in sent)
    assert.equal(updated!.bodyChanged, 'body' in sent)
  }

  const { w, run, tool } = await reopened()
  w.gates.impl.runAt = async () => gate({ head: SHA_C })
  const value = await call(tool, { title: '', body: 'Fixed the review', gateRuling: RULING })
  assert.deepEqual(w.workspaces.calls.updatePull, [[PROJECT, 7, { body: 'Fixed the review' }]])
  assert.deepEqual(w.workspaces.calls.commentPull, [[PROJECT, 7, `${GATE_LINE}the flaky e2e suite — it fails on main too — a real failure could hide in it`]])
  const [updated] = await entriesOf(w, run, 'pr.updated')
  assert.equal(updated!.comment, 'posted')
  assert.equal(value.text.split('\n')[2], 'dish posted the override line as a comment on it.')
})

test('open_pr on a reopened run: updatePull rejecting fails nothing; the entry and the answer say so', async () => {
  const { w, run, tool } = await reopened()
  w.workspaces.impl.updatePull = async () => { throw new Error(`could not update pull request #7: Bad credentials ${TOKEN}`) }
  const value = await call(tool, { title: 'A better title' })
  const [updated] = await entriesOf(w, run, 'pr.updated')
  assert.equal(updated!.titleChanged, false)
  assert.equal(updated!.bodyChanged, false)
  assert.equal(updated!.updateError, `could not update pull request #7: Bad credentials ${MASKED_TOKEN}`)
  assert.equal(w.record(run)?.state, 'pr')
  assert.ok(value.text.split('\n')[0]!.endsWith(` dish couldn't update its title or body (could not update pull request #7: Bad credentials ${MASKED_TOKEN}): resume the run and call open_pr again with them, or edit them on GitHub.`), value.text)
})

test('open_pr on a reopened run: GitHub\'s branch ahead refuses before the gate; compareBranch rejecting goes on', async () => {
  const { w, run, tool } = await reopened()
  w.workspaces.impl.compareBranch = async () => ({ behindDefault: 0, aheadOfDefault: 3, remoteAhead: 2 })
  await refused(call(tool), 'GitHub\'s dish/fix-login has 2 commits the run\'s worktree lacks (an \'Update branch\', a committed suggestion, or a push of someone\'s own). Have a coder merge `origin/dish/fix-login` into the run\'s worktree, then call open_pr again. dish never forces a push. Nothing was pushed.')
  assert.equal(w.gates.calls.runAt.length, 0)
  nothingWritten(w)
  assert.ok(!(await w.kinds(run)).includes('pr.checked'))

  w.workspaces.impl.compareBranch = async () => { throw new Error('no network') }
  assert.equal((await call(tool)).number, 7)
})

test('open_pr: a first open_pr doesn\'t ask compareBranch', async () => {
  const { w, run, tool } = await setup()
  await verdict(w, run)
  await call(tool)
  assert.equal(w.workspaces.calls.compareBranch.length, 0)
})

test('open_pr on a reopened run: a push refused as not a fast-forward gives pushBranch\'s message, its merge hint once, and the run stays open', async () => {
  const { w, run, tool } = await reopened()
  const hint = 'The branch on GitHub has commits this one doesn\'t: have a coder merge `origin/dish/fix-login` into the run\'s worktree, then call `open_pr` again. dish never forces a push.'
  w.workspaces.impl.pushBranch = async () => { throw new Error(`GitHub refused the push of dish/fix-login: [rejected] (fetch first). ${hint}`) }
  const message = await refused(call(tool), hint, 'the run stays open')
  assert.equal(message.split('dish never forces a push').length, 2, 'the hint once')
  assert.equal(message, `GitHub refused the push of dish/fix-login: [rejected] (fetch first). ${hint} Nothing else was done; the run stays open.`)
  assert.equal(w.record(run)?.state, 'open')
  assert.equal(w.workspaces.calls.openPull.length, 0)
})

test('open_pr on a reopened run: reviewRuling is posted as a comment; commentPull rejecting fails nothing', async () => {
  const { w, run, tool } = await reopened()
  w.heads.set(run.worktree, 'd'.repeat(40))
  await call(tool, { title: '', body: '', reviewRuling: 'Ruling: merge of origin/main only — no conflicts — a bad merge' })
  assert.deepEqual(w.workspaces.calls.commentPull, [[PROJECT, 7, `${REVIEW_LINE}merge of origin/main only — no conflicts — a bad merge`]])
  assert.equal(w.workspaces.calls.updatePull.length, 0)
  assert.equal((await entriesOf(w, run, 'pr.updated'))[0]!.comment, 'posted')

  const again = await reopened()
  again.w.heads.set(again.run.worktree, 'd'.repeat(40))
  again.w.workspaces.impl.commentPull = async () => { throw new Error('could not comment on pull request #7: Forbidden') }
  const value = await call(again.tool, { title: '', body: '', reviewRuling: 'Ruling: merge of origin/main only — no conflicts — a bad merge' })
  const [updated] = await entriesOf(again.w, again.run, 'pr.updated')
  assert.equal(updated!.comment, 'failed')
  assert.equal(updated!.commentError, 'could not comment on pull request #7: Forbidden')
  assert.equal(again.w.record(again.run)?.state, 'pr')
  assert.equal(value.text.split('\n')[2], 'dish couldn\'t post the override line as a comment (could not comment on pull request #7: Forbidden): add it to the pull request by hand.')
  assert.ok(again.w.logs.some(line => line.includes('could not comment on pull request #7: Forbidden')))
})

test('open_pr on a reopened run whose pull request was closed on GitHub: a new one, titled with the run\'s goal, replaces it', async () => {
  const { w, run, tool } = await reopened()
  w.workspaces.impl.openPull = async project => ({ url: `https://github.com/${project}/pull/12`, number: 12, existing: false })
  const value = await call(tool, { title: '', body: '' })
  assert.deepEqual(w.workspaces.calls.openPull, [[PROJECT, { head: 'dish/fix-login', title: 'Fix the login redirect', body: '' }]])
  const kinds = await written(w, run)
  assert.deepEqual(kinds.slice(kinds.lastIndexOf('run.resumed') + 1), ['pr.checked', 'pr.opened', 'run.closed'])
  assert.equal((await entriesOf(w, run, 'pr.opened')).at(-1)!.number, 12)
  assert.deepEqual(w.record(run)?.pr, { url: `https://github.com/${PROJECT}/pull/12`, number: 12 })
  assert.match(value.text, /^Opened PR #12 for run/)
})

test('open_pr: a pull request already open on a first open_pr (opened outside dish) is reported, never edited', async () => {
  const { w, run, tool } = await setup()
  await verdict(w, run)
  const url = `https://github.com/${PROJECT}/pull/40`
  w.workspaces.impl.openPull = async () => ({ url, number: 40, existing: true })
  const value = await call(tool, { title: 'Mine', body: 'My body' })
  assert.equal(w.workspaces.calls.updatePull.length, 0)
  assert.equal(value.existing, true)
  assert.match(value.text, /^Pushed bbbbbbb to the pull request already open for dish\/fix-login: #40 .* dish opened no other\. Its title and body are as they were/)
  const [updated] = await entriesOf(w, run, 'pr.updated')
  assert.equal(updated!.titleChanged, false)
  assert.equal(updated!.bodyChanged, false)
  assert.equal(w.record(run)?.state, 'pr')
  assert.deepEqual(w.record(run)?.pr, { url, number: 40 })
})

// --- secrets, cancelling, two at once -------------------------------------------------------------------------------

test('open_pr: a token in the body and the ruling is masked in what openPull and commentPull got, and in every ledger line', async () => {
  const { w, run, tool } = await setup()
  w.gates.impl.runAt = async () => gate({})
  await call(tool, { title: `Title ${TOKEN}`, body: `Body ${TOKEN}`, gateRuling: `Ruling: a token ${TOKEN} — why — cost`, reviewRuling: `Ruling: ${TOKEN} — w — c` })
  const sent = w.workspaces.calls.openPull[0]![1]
  assert.ok(!JSON.stringify(sent).includes(TOKEN))
  assert.ok(sent.title.includes(MASKED_TOKEN) && sent.body.includes(MASKED_TOKEN))

  const again = await reopened()
  again.w.gates.impl.runAt = async () => gate({ head: SHA_C })
  await call(again.tool, { body: `Body ${TOKEN}`, gateRuling: `Ruling: a token ${TOKEN} — why — cost` })
  assert.ok(!JSON.stringify(again.w.workspaces.calls.commentPull).includes(TOKEN))
  assert.ok(!JSON.stringify(again.w.workspaces.calls.updatePull).includes(TOKEN))
  for (const [inWorld, ofRun] of [[w, run], [again.w, again.run]] as const) {
    const file = await readFile(inWorld.ledger.file(ofRun.project, ofRun.id), 'utf8')
    assert.ok(!file.includes(TOKEN))
    assert.ok(file.includes(MASKED_TOKEN))
  }
})

test('open_pr: cancelled while the gate runs, nothing is recorded or pushed', async () => {
  const { w, run, tool } = await setup()
  await verdict(w, run)
  w.gates.impl.runAt = (_project, _path, options) => new Promise((_settle, reject) => {
    options.signal!.addEventListener('abort', () => {
      const error = new Error('runAt was cancelled')
      error.name = 'AbortError'
      reject(error)
    })
  })
  const controller = new AbortController()
  const running = call(tool, {}, mainExec(SESSION, undefined, { signal: controller.signal }))
  await waitFor('the gate', () => w.gates.calls.runAt.length === 1)
  controller.abort()
  await refused(running, 'open_pr was cancelled while the gate ran. Nothing was pushed.')
  nothingWritten(w)
  assert.deepEqual(await written(w, run), [])
  assert.equal(w.record(run)?.state, 'open')
})

test('open_pr: two calls at once open one pull request; the second is refused as no longer driven', async () => {
  const { w, run, tool } = await setup()
  await verdict(w, run)
  const gateHeld = deferred()
  const original = w.gates.impl.runAt
  w.gates.impl.runAt = async (...args) => {
    await gateHeld.promise
    return original(...args)
  }
  const first = call(tool)
  const second = call(tool)
  await waitFor('the first gate', () => w.gates.calls.runAt.length === 1)
  gateHeld.resolve()
  const [one, two] = await Promise.allSettled([first, second])
  assert.equal(one.status, 'fulfilled')
  assert.equal(two.status, 'rejected')
  assert.equal((two as PromiseRejectedResult).reason.message,
    `run \`${run.id}\` is no longer driven by this chat (closed: its PR https://github.com/${PROJECT}/pull/1). Nothing was pushed.`)
  assert.equal(w.workspaces.calls.pushBranch.length, 1)
  assert.equal(w.workspaces.calls.openPull.length, 1)
  assert.equal(w.gates.calls.runAt.length, 1)
})

test('refusalText: only the failed checks\' lines, under the run and the head', () => {
  const run = { id: '20261003-fix-login' } as Run
  const text = refusalText(run, HEAD, { gate: null, gateOk: false, final: undefined, reviewOk: true, gatesMissing: true })
  assert.equal(text, [
    'open_pr refused for run `20261003-fix-login` at bbbbbbb; nothing was pushed:',
    '- the gate didn\'t run: dish-gates isn\'t running. Give `gateRuling: "Ruling: what — why — cost if wrong"` to open the PR without it.',
  ].join('\n'))
})

test('open_pr: a ledger line that can\'t be written is logged and named in the answer; the push, the pull request and the record stand', async () => {
  const { w, run, tool } = await setup()
  await verdict(w, run)
  const original = w.runs.harness.bind(w.runs)
  w.runs.harness = async (target, entry) => {
    if (entry.kind === 'pr.checked' || entry.kind === 'pr.opened') throw new Error(`disk full ${TOKEN}`)
    return original(target, entry)
  }
  try {
    const value = await call(tool)
    assert.equal(value.number, 1)
    assert.equal(w.workspaces.calls.pushBranch.length, 1)
    assert.equal(w.record(run)?.state, 'pr')
    const lines = value.text.split('\n')
    assert.ok(lines.includes(`dish couldn't write pr.checked to the run's ledger (disk full ${MASKED_TOKEN}); the record and GitHub are as said.`), value.text)
    assert.ok(lines.includes(`dish couldn't write pr.opened to the run's ledger (disk full ${MASKED_TOKEN}); the record and GitHub are as said.`), value.text)
    assert.ok(w.logs.some(line => line.includes('couldn\'t record pr.opened')))
    assert.ok(!w.logs.some(line => line.includes(TOKEN)))
    assert.deepEqual(await written(w, run), ['run.closed'])
  } finally {
    w.runs.harness = original
  }
})

/** The ledger entries' `by`: open_pr writes only the harness's. */
test('open_pr: every entry it writes is the harness\'s', async () => {
  const { w, run, tool } = await setup()
  await verdict(w, run)
  await call(tool)
  const entries: LedgerEntry[] = await w.entries(run)
  assert.ok(entries.every(entry => entry.by === 'harness'))
})
