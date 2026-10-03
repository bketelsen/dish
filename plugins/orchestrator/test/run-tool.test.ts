/**
 * The `run` tool over Task 8's `world`: `runTool(deps).execute(args, exec)` for each action, and one call through dsh's
 * `ToolRuntime` for the parameter schema.
 */

import assert from 'node:assert/strict'
import { mkdir, readdir, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { CreatedWorktree } from 'dish-workspaces'
import { summarize } from '../src/derive.ts'
import { ACTIONS, MAIN_ONLY, NO_RUN, planProblem, runTool } from '../src/run-tool.ts'
import { listText, statusText } from '../src/status.ts'
import type { Run } from '../src/store.ts'
import { shortSession, shortSha } from '../src/text.ts'
import {
  BASE, HEAD, MASKED_TOKEN, NOW, OTHER_PROJECT, OTHER_SESSION, PROJECT, SESSION, SHA_C, TOKEN, childExec, deferred, mainExec, pluginWorld,
  waitFor, world,
} from './service-helpers.ts'
import { HOUR } from './helpers.ts'
import type { World } from './service-helpers.ts'

interface Answer {
  action: string
  run: string
  text: string
}

const ID = '20261003-fix-login'
const GOAL = 'Fix the login redirect'
const PR_URL = `https://github.com/${PROJECT}/pull/3`
const READ_STATUS = 'Read `run` `status` for where it stands; open tasks continue with fresh children, and their rounds carry over.'

function toolOf(w: World): ToolDefinition {
  const tool = runTool(w.deps)
  assert.ok(tool !== undefined, 'runTool gives a tool')
  return tool
}

/** The tool's value for `args`, called by the main agent of SESSION (or `exec`). */
async function call(w: World, args: Record<string, unknown>, exec: ToolRunContext = mainExec(SESSION, w.dir)): Promise<Answer> {
  return await toolOf(w).execute(args, exec) as Answer
}

/** `call`, as the tool's text, split into lines. */
async function lines(w: World, args: Record<string, unknown>, exec?: ToolRunContext): Promise<string[]> {
  return (await call(w, args, exec)).text.split('\n')
}

/** How many calls every stub has had, by `<stub>.<method>`, without the empty ones. */
function stubCalls(w: World): Record<string, number> {
  const counted: Record<string, number> = {}
  for (const [name, stub] of Object.entries({ workspaces: w.workspaces, crew: w.crew, gates: w.gates, projects: w.projects })) {
    for (const [method, calls] of Object.entries(stub.calls as Record<string, unknown[]>)) {
      if (calls.length > 0) counted[`${name}.${method}`] = calls.length
    }
  }
  return counted
}

/** `open` through the tool, by SESSION unless `exec` says otherwise. */
async function openRun(w: World, args: Record<string, unknown> = {}, exec?: ToolRunContext): Promise<Run> {
  const answer = await call(w, { action: 'open', project: PROJECT, slug: 'fix-login', goal: GOAL, ...args }, exec)
  const run = w.store.list().find(candidate => candidate.id === answer.run && candidate.state === 'open')
  assert.ok(run !== undefined, `run ${answer.run} is open`)
  return run
}

/** A run of `session` that has a pull request: opened, then closed with it, as `open_pr` leaves it. */
async function prRun(w: World, options: { session?: string, slug?: string } = {}): Promise<Run> {
  const run = await w.open({ session: options.session ?? SESSION, ...options.slug === undefined ? {} : { slug: options.slug } })
  return w.runs.withRun(run, () => w.runs.close(run, options.session ?? SESSION, { state: 'pr', pr: { url: PR_URL, number: 3 } }))
}

/** Every argument any action takes, filled. */
const EVERY_ARGUMENT = {
  project: PROJECT, slug: 'fix-login', goal: GOAL, plan: 'docs/plans/x.md', base: 'origin/main', id: ID, takeover: true, reason: 'done',
  what: 'a call', why: 'a reason', costIfWrong: 'a cost', where: 'src/a.ts', task: 'fix-login', text: 'a note',
}

// --- the tool --------------------------------------------------------------------------------------------------------

test('the tool: run, its parameters and output as the plan has them, schemas dsh accepts, and a description of every action', async () => {
  const w = await world()
  const tool = toolOf(w)
  assert.equal(tool.name, 'run')
  assertSupportedJsonSchema(tool.parameters as never)
  assertSupportedJsonSchema(tool.output.schema as never)
  const parameters = tool.parameters as unknown as { properties: Record<string, { type: string, enum?: string[], description?: string }>, required?: string[] }
  assert.deepEqual(Object.keys(parameters.properties).sort(),
    ['action', 'base', 'costIfWrong', 'goal', 'id', 'plan', 'project', 'reason', 'slug', 'takeover', 'task', 'text', 'what', 'where', 'why'])
  assert.deepEqual(parameters.required, ['action'])
  assert.deepEqual(parameters.properties.action!.enum, [...ACTIONS])
  assert.deepEqual([...ACTIONS], ['open', 'resume', 'goal', 'plan', 'abandon', 'status', 'list', 'ruling', 'defer', 'note'])
  assert.equal(parameters.properties.takeover!.type, 'boolean')
  for (const [name, parameter] of Object.entries(parameters.properties)) {
    if (name !== 'takeover') assert.equal(parameter.type, 'string', name)
    assert.ok((parameter.description ?? '') !== '', `${name} has a description`)
  }
  assert.deepEqual(tool.output.schema, {
    type: 'object', additionalProperties: false,
    properties: { action: { type: 'string' }, run: { type: 'string' }, text: { type: 'string' } },
    required: ['action', 'run', 'text'],
  })
  assert.deepEqual(tool.output.render({}, { action: 'list', run: '', text: 'No open runs.' }), [{ type: 'text', text: 'No open runs.' }])
  assert.match(tool.description, /^Runs: every change that ends in a pull request is a run/)
  assert.match(tool.description, /\(main agent only\)/)
  for (const action of ACTIONS) assert.match(tool.description, new RegExp(`\`${action}\``), action)
  assert.match(tool.description, /`open_pr` ends a run with a pull request\.$/)
})

test('the caller: a crew child, and an agent with no id, are refused for every action; nothing is read or written', async () => {
  const w = await world()
  const run = await w.open()
  const before = { record: w.record(run), entries: await w.entries(run), runs: w.store.list() }
  const noId = { ...mainExec(SESSION, w.dir), agent: { session: { header: { id: SESSION } }, options: {} } } as unknown as ToolRunContext
  for (const exec of [childExec({ cwd: w.dir }), noId]) {
    for (const action of ACTIONS) {
      await assert.rejects(call(w, { ...EVERY_ARGUMENT, action }, exec), { message: MAIN_ONLY }, action)
    }
  }
  assert.deepEqual(stubCalls(w), {})
  assert.deepEqual(w.store.list(), before.runs)
  assert.deepEqual(w.record(run), before.record)
  assert.deepEqual(await w.entries(run), before.entries)
})

// --- open ------------------------------------------------------------------------------------------------------------

test('open: the worktree made with the chat\'s cwd and the call\'s signal; the record; one run.opened (how: run) and no task.opened; the answer', async () => {
  const w = await world()
  const cwd = join(w.dir, 'work', 'Acme', 'widget')
  const controller = new AbortController()
  const answer = await call(w, { action: 'open', project: PROJECT, slug: 'fix-login', goal: `  ${GOAL}\n  for SSO  `, plan: ' ', base: '' },
    mainExec(SESSION, cwd, { signal: controller.signal }))
  assert.equal(w.workspaces.calls.createWorktree.length, 1)
  const [project, slug, base, options] = w.workspaces.calls.createWorktree[0]!
  assert.deepEqual([project, slug, base], [PROJECT, 'fix-login', undefined])
  assert.equal(options?.cwd, cwd)
  assert.equal(options?.signal, controller.signal)
  const path = join(w.dir, 'work', 'Acme', 'widget', '.worktrees', 'fix-login')
  const [run, ...others] = w.store.list()
  assert.deepEqual(others, [])
  assert.deepEqual(run, {
    id: ID, project: PROJECT, slug: 'fix-login', goal: `${GOAL} for SSO`, branch: 'dish/fix-login', worktree: path, base: 'origin/main',
    baseCommit: BASE, state: 'open', driver: { session: SESSION, since: NOW }, openedAt: NOW,
  })
  assert.deepEqual(answer.action, 'open')
  assert.deepEqual(answer.run, ID)
  const entries = await w.entries(run!)
  assert.deepEqual(entries.map(entry => entry.kind), ['run.opened'])
  assert.deepEqual(entries[0], {
    at: NOW, run: ID, kind: 'run.opened', by: 'harness', session: SESSION, goal: `${GOAL} for SSO`, branch: 'dish/fix-login', worktree: path,
    base: 'origin/main', baseCommit: BASE, how: 'run',
  })
  assert.deepEqual(answer.text.split('\n'), [
    `Opened run \`${ID}\` (${PROJECT}): ${GOAL} for SSO`,
    `Its worktree is ${path}, on branch dish/fix-login, cut from origin/main (${shortSha(BASE)}).`,
    `This chat drives it. Worktrees you make in ${PROJECT} while you drive it are its tasks; bind a coder to the run's own worktree with delegate's \`worktree\`: ${PROJECT}/fix-login. \`open_pr\` ends the run.`,
    'The project has no setup.',
  ])
  assert.equal((await w.runs.driving(SESSION))?.id, ID)
})

test('open: base is passed on and recorded; setup\'s sentence is the worktree tool\'s', async () => {
  const w = await world()
  const original = w.workspaces.impl.createWorktree
  let setup: CreatedWorktree['setup'] = {
    ran: true, exitCode: 0, signal: null, timedOut: false, aborted: false, durationMs: 1000, log: '/state/setup/fix-login.log', tail: '',
  }
  w.workspaces.impl.createWorktree = async (...args) => ({ ...await original(...args), setup })
  const ran = await call(w, { action: 'open', project: PROJECT, slug: 'fix-login', goal: GOAL, base: 'origin/dish/plan-x' })
  assert.equal(w.workspaces.calls.createWorktree[0]![2], 'origin/dish/plan-x')
  assert.equal(w.record({ project: PROJECT, id: ran.run } as Run)?.base, 'origin/dish/plan-x')
  assert.match(ran.text, /cut from origin\/dish\/plan-x \(aaaaaaa\)\./)
  assert.equal(ran.text.split('\n')[3], 'Setup ran: exit 0 (log: /state/setup/fix-login.log).')
  setup = { ...setup, exitCode: null, timedOut: true }
  assert.equal((await lines(w, { action: 'open', project: PROJECT, slug: 'second', goal: GOAL }))[3], 'Setup ran: it timed out (log: /state/setup/fix-login.log).')
  setup = { ran: false, reason: 'setup didn\'t run outside the sandbox: run `pnpm install` in the worktree yourself, sandboxed.' }
  assert.equal((await lines(w, { action: 'open', project: PROJECT, slug: 'third', goal: GOAL }))[3], setup.reason)
})

test('open with a plan that is in the worktree: attached at the base commit, in the record and run.opened', async () => {
  const w = await world()
  const path = await w.worktree('fix-login')
  await mkdir(join(path, 'docs', 'plans'), { recursive: true })
  await writeFile(join(path, 'docs', 'plans', 'x.md'), '# The plan\n')
  const answer = await call(w, { action: 'open', project: PROJECT, slug: 'fix-login', goal: GOAL, plan: './docs//plans/x.md' })
  const run = w.store.list()[0]!
  assert.deepEqual(run.plan, { path: 'docs/plans/x.md', commit: BASE })
  const [opened] = await w.entries(run)
  assert.deepEqual((opened as { plan?: unknown }).plan, { path: 'docs/plans/x.md', commit: BASE })
  assert.equal(answer.text.split('\n')[2], `Plan: docs/plans/x.md at ${shortSha(BASE)}.`)
})

test('open with a plan that is missing, outside the worktree, absolute, or a link out of it: the run opens without it, and says why', async () => {
  const w = await world()
  const linked = await w.worktree('linked')
  await mkdir(join(linked, 'docs'), { recursive: true })
  await symlink('/etc/passwd', join(linked, 'docs', 'plan.md'))
  const cases: Array<[string, string, RegExp]> = [
    ['missing', 'docs/plans/none.md', /there is no such file in the run's worktree/],
    ['outside', '../x', /it has a "\.\." segment/],
    ['absolute', '/etc/passwd', /it is absolute/],
    ['linked', 'docs/plan.md', /it leads outside the run's worktree/],
  ]
  for (const [slug, plan, why] of cases) {
    const answer = await call(w, { action: 'open', project: PROJECT, slug, goal: GOAL, plan })
    const run = w.store.list().find(candidate => candidate.id === answer.run)!
    assert.equal(run.plan, undefined, slug)
    assert.equal((await w.entries(run))[0]!.kind, 'run.opened')
    assert.equal(((await w.entries(run))[0] as { plan?: unknown }).plan, undefined, slug)
    const line = answer.text.split('\n')[2]!
    assert.match(line, /^Plan not attached: /, slug)
    assert.match(line, why, slug)
    assert.match(line, /\. Attach it with `run` `plan` once it is in the run's branch\.$/, slug)
  }
})

test('open: createWorktree\'s refusal passes through, masked, and nothing is recorded', async () => {
  const w = await world()
  w.workspaces.impl.createWorktree = async () => { throw new Error(`Acme/widget isn't ready (cloning) ${TOKEN}`) }
  await assert.rejects(call(w, { action: 'open', project: PROJECT, slug: 'fix-login', goal: GOAL }), (error: Error) => {
    assert.equal(error.message, `Acme/widget isn't ready (cloning) ${MASKED_TOKEN}`)
    return true
  })
  assert.deepEqual(w.store.list(), [])
  await assert.rejects(readdir(w.data), { code: 'ENOENT' })
})

test('open: each refusal of its arguments, of a project not in projects.yaml, and without dish-workspaces; none makes a worktree', async () => {
  const w = await world()
  // A key given as undefined is left out: the model sends JSON.
  const open = (args: Record<string, unknown>) => call(w, Object.fromEntries(Object.entries({ action: 'open', project: PROJECT, slug: 'fix-login', goal: GOAL, ...args })
    .filter(([, value]) => value !== undefined)))
  const project = '`project` is required for open: `owner/repo` as in projects.yaml'
  const slug = '`slug` is required for open: 1 to 40 of a-z, 0-9 and "-"'
  await assert.rejects(open({ project: undefined }), { message: project })
  await assert.rejects(open({ project: '  ' }), { message: project })
  await assert.rejects(open({ slug: undefined }), { message: slug })
  await assert.rejects(open({ slug: 'Fix_Login' }), { message: slug })
  await assert.rejects(open({ slug: 'x'.repeat(41) }), { message: slug })
  await assert.rejects(open({ goal: '' }), { message: '`goal` is required for open: what the change is for, in one line' })
  await assert.rejects(open({ project: 'widget' }), { message: '"widget" isn\'t a project name: `owner/repo`' })
  await assert.rejects(open({ project: 'Acme/nope' }), { message: 'Acme/nope isn\'t in projects.yaml' })
  w.absent.add('workspaces')
  await assert.rejects(open({}), { message: 'dish-workspaces isn\'t running, so the run\'s worktree can\'t be made' })
  assert.deepEqual(w.workspaces.calls.createWorktree, [])
  assert.deepEqual(w.store.list(), [])
})

test('open: the session\'s lock isn\'t held while createWorktree waits (for the project\'s lock); the run is recorded under it after', async () => {
  const w = await world()
  const original = w.workspaces.impl.createWorktree
  const gate = deferred()
  w.workspaces.impl.createWorktree = async (...args) => {
    await gate.promise
    return original(...args)
  }
  const pending = call(w, { action: 'open', project: PROJECT, slug: 'fix-login', goal: GOAL })
  await new Promise(settle => setTimeout(settle, 20))
  assert.equal(w.workspaces.calls.createWorktree.length, 1)
  // The chat's own worktree hook would take this lock: it is free.
  const held = new Promise<string>((settle) => { setTimeout(() => { settle('held') }, 1000).unref() })
  assert.equal(await Promise.race([w.runs.withSession(SESSION, async () => 'free'), held]), 'free')
  gate.resolve()
  assert.equal((await pending).run, ID)
})

test('open: a second run releases the first, which stays open and nobody drives', async () => {
  const w = await world()
  const first = await openRun(w)
  const answer = await call(w, { action: 'open', project: PROJECT, slug: 'second', goal: 'Another change' })
  assert.equal(answer.text.split('\n').at(-1), `Released run \`${first.id}\`: it stays open, and \`run\` \`resume\` takes it back.`)
  assert.deepEqual(w.record(first)?.driver, { session: '', since: NOW })
  assert.equal(w.record(first)?.state, 'open')
  assert.equal((await w.runs.driving(SESSION))?.id, answer.run)
})

// --- resume ----------------------------------------------------------------------------------------------------------

test('resume: the caller already drives it; its driver wasn\'t live; nobody drove it; taken over from a live chat', async () => {
  const w = await world()
  const mine = await openRun(w)
  assert.deepEqual(await lines(w, { action: 'resume', id: mine.id }), [`Resumed run \`${ID}\` (${PROJECT}): ${GOAL}.`, 'You already drive it.', READ_STATUS])
  assert.deepEqual(await w.kinds(mine), ['run.opened'])

  // Another chat's run, its chat gone.
  const theirs = await w.open({ session: OTHER_SESSION, slug: 'theirs', goal: 'Their change.' })
  w.clock.now = NOW + 1000
  assert.deepEqual(await lines(w, { action: 'resume', id: theirs.id }), [
    `Resumed run \`${theirs.id}\` (${PROJECT}): Their change.`,
    `Its driver (session ${shortSession(OTHER_SESSION)}) wasn't live. Released run \`${mine.id}\`.`,
    READ_STATUS,
  ])
  assert.deepEqual(w.record(theirs)?.driver, { session: SESSION, since: NOW + 1000 })
  assert.deepEqual(w.record(mine)?.driver, { session: '', since: NOW + 1000 })
  const resumed = (await w.entries(theirs)).at(-1) as unknown as Record<string, unknown>
  assert.deepEqual([resumed.kind, resumed.by, resumed.session, resumed.driver, resumed.previous], ['run.resumed', 'harness', SESSION, SESSION, OTHER_SESSION])

  // A released run: nobody drove it.
  assert.deepEqual(await lines(w, { action: 'resume', id: mine.id }), [
    `Resumed run \`${mine.id}\` (${PROJECT}): ${GOAL}.`, `Nobody drove it. Released run \`${theirs.id}\`.`, READ_STATUS,
  ])

  // A live chat's run: refused without takeover, and taken over with it.
  const live = await w.open({ session: OTHER_SESSION, slug: 'live' })
  w.live.add(OTHER_SESSION)
  const before = w.record(live)
  await assert.rejects(call(w, { action: 'resume', id: live.id, takeover: false }), {
    message: `run \`${live.id}\` is driven by another chat that is still open (session ${shortSession(OTHER_SESSION)}). Give \`takeover: true\` to drive it from here; that chat then drives nothing.`,
  })
  assert.deepEqual(w.record(live), before)
  assert.deepEqual(await lines(w, { action: 'resume', id: live.id, takeover: true }), [
    `Resumed run \`${live.id}\` (${PROJECT}): ${GOAL}.`,
    `Took it over from session ${shortSession(OTHER_SESSION)}, which now drives nothing. Released run \`${mine.id}\`.`,
    READ_STATUS,
  ])
  assert.equal((await w.entries(live)).at(-1)?.kind, 'run.takenOver')
  assert.equal(w.store.drivenBy(OTHER_SESSION), undefined)
})

test('resume: a run with a pull request reopens for review feedback; refused once its worktree is gone; an abandoned run is refused', async () => {
  const w = await world()
  const pr = await prRun(w)
  assert.deepEqual(await lines(w, { action: 'resume', id: pr.id }), [
    `Reopened run \`${pr.id}\` (${PROJECT}) for review feedback: its pull request #3 (${PR_URL}) stays open. `
      + 'Fix what the review asks in rounds, as before; then `open_pr` runs the same checks and pushes the new head to that pull request.',
    READ_STATUS,
  ])
  const record = w.record(pr)!
  assert.deepEqual([record.state, record.pr, record.closedAt, record.driver.session], ['open', { url: PR_URL, number: 3 }, undefined, SESSION])
  const reopened = (await w.entries(pr)).at(-1) as unknown as Record<string, unknown>
  assert.deepEqual([reopened.kind, reopened.reopened], ['run.resumed', true])

  // Its worktree gone (the sweep removed it after the merge).
  const gone = await prRun(w, { slug: 'gone' })
  w.worktrees.delete(gone.worktree)
  const before = w.record(gone)
  await assert.rejects(call(w, { action: 'resume', id: gone.id }), (error: Error) => error.message.includes(`\`${gone.id}\``) && /worktree/.test(error.message))
  assert.deepEqual(w.record(gone), before)

  // Abandoned.
  const dropped = await openRun(w, { slug: 'dropped' })
  await call(w, { action: 'abandon', reason: 'Not needed after all' })
  await assert.rejects(call(w, { action: 'resume', id: dropped.id }), {
    message: `run \`${dropped.id}\` was abandoned (Not needed after all). Open a new run with \`run\` \`open\`.`,
  })
})

test('resume: a bare id, owner/repo/id, an unknown id, an id in two projects, and no id', async () => {
  const w = await world()
  const here = await w.open({ session: OTHER_SESSION })
  const there = await w.open({ session: 'session-3', project: OTHER_PROJECT })
  await assert.rejects(call(w, { action: 'resume', id: ID }), {
    message: `\`${ID}\` names runs in several projects (${OTHER_PROJECT}, ${PROJECT}): give \`owner/repo/${ID}\``,
  })
  assert.match((await call(w, { action: 'resume', id: `${OTHER_PROJECT}/${ID}` })).text, new RegExp(`^Resumed run \`${ID}\` \\(${OTHER_PROJECT}\\)`))
  assert.equal(w.record(there)?.driver.session, SESSION)
  assert.equal(w.record(here)?.driver.session, OTHER_SESSION)
  await assert.rejects(call(w, { action: 'resume', id: '20260101-nothing' }), { message: 'no run `20260101-nothing`: `run` `list` shows the runs' })
  await assert.rejects(call(w, { action: 'resume', id: `x-${TOKEN}` }), (error: Error) => !error.message.includes(TOKEN) && error.message.includes(MASKED_TOKEN))
  await assert.rejects(call(w, { action: 'resume', id: ' ' }), { message: '`id` is required for resume: the run\'s id, as `run` `list` shows it' })
  // A bare id that names one run.
  const only = await w.open({ session: OTHER_SESSION, slug: 'only' })
  const answer = await call(w, { action: 'resume', id: only.id })
  assert.equal(answer.run, only.id)
  assert.equal(answer.action, 'resume')
})

test('resume: one run per chat: resuming B releases A', async () => {
  const w = await world()
  const a = await openRun(w)
  const b = await w.open({ session: OTHER_SESSION, slug: 'b' })
  const text = (await call(w, { action: 'resume', id: b.id })).text
  assert.match(text, new RegExp(` Released run \`${a.id}\`\\.\n`))
  assert.equal(w.record(a)?.driver.session, '')
  assert.equal(w.store.drivenBy(SESSION)?.id, b.id)
})

// --- goal, plan, abandon -------------------------------------------------------------------------------------------

test('goal: the record and run.goal; refused without a goal', async () => {
  const w = await world()
  const run = await openRun(w)
  const answer = await call(w, { action: 'goal', goal: 'Fix the login redirect\nfor SSO users' })
  assert.deepEqual(answer, { action: 'goal', run: run.id, text: `Run \`${run.id}\`'s goal is now: Fix the login redirect for SSO users.` })
  assert.equal(w.record(run)?.goal, 'Fix the login redirect for SSO users')
  const entry = (await w.entries(run)).at(-1) as unknown as Record<string, unknown>
  assert.deepEqual([entry.kind, entry.by, entry.session, entry.goal], ['run.goal', 'harness', SESSION, 'Fix the login redirect for SSO users'])
  await assert.rejects(call(w, { action: 'goal', goal: '' }), { message: '`goal` is required for goal: what the change is for, in one line' })
  const long = await call(w, { action: 'goal', goal: 'g'.repeat(400) })
  assert.equal(w.record(run)?.goal.length, 300)
  assert.match(long.text, /…\.$/)
})

test('plan: attached at the worktree\'s head, with a warning when it isn\'t clean; refused for a bad path or an unreadable head', async () => {
  const w = await world()
  const run = await openRun(w)
  await mkdir(join(run.worktree, 'docs', 'plans'), { recursive: true })
  await writeFile(join(run.worktree, 'docs', 'plans', 'p.md'), '# Plan\n')
  w.heads.set(run.worktree, SHA_C)
  const answer = await call(w, { action: 'plan', plan: 'docs/plans/p.md' })
  assert.deepEqual(answer, { action: 'plan', run: run.id, text: `Attached plan docs/plans/p.md at ${shortSha(SHA_C)} to run \`${run.id}\`.` })
  assert.deepEqual(w.record(run)?.plan, { path: 'docs/plans/p.md', commit: SHA_C })
  const entry = (await w.entries(run)).at(-1) as unknown as Record<string, unknown>
  assert.deepEqual([entry.kind, entry.by, entry.session, entry.path, entry.commit], ['run.plan', 'harness', SESSION, 'docs/plans/p.md', SHA_C])

  // Not clean: attached, with the warning.
  w.workspaces.impl.isClean = async () => ({ clean: false, why: 'docs/plans/p.md is untracked' })
  assert.equal((await call(w, { action: 'plan', plan: 'docs/plans/p.md' })).text,
    `Attached plan docs/plans/p.md at ${shortSha(SHA_C)} to run \`${run.id}\`. The worktree isn't clean (docs/plans/p.md is untracked), so ${shortSha(SHA_C)} `
    + 'may not hold the plan as it is now: commit it, then attach it again.')
  // isClean rejecting adds nothing.
  w.workspaces.impl.isClean = async () => { throw new Error('git status failed') }
  assert.equal((await call(w, { action: 'plan', plan: 'docs/plans/p.md' })).text, `Attached plan docs/plans/p.md at ${shortSha(SHA_C)} to run \`${run.id}\`.`)

  const count = (await w.entries(run)).length
  const attached = w.record(run)?.plan
  await assert.rejects(call(w, { action: 'plan', plan: '../outside.md' }), /^Error: plan \.\.\/outside\.md: it has a "\.\." segment/)
  await assert.rejects(call(w, { action: 'plan', plan: 'docs/plans/none.md' }), { message: 'plan docs/plans/none.md: there is no such file in the run\'s worktree' })
  await assert.rejects(call(w, { action: 'plan' }), { message: '`plan` is required for plan: the plan\'s path in the repo, such as `docs/plans/2026-10-03-x.md`' })
  w.workspaces.impl.headOf = async () => { throw new Error('git rev-parse failed') }
  await assert.rejects(call(w, { action: 'plan', plan: 'docs/plans/p.md' }), { message: 'can\'t read the run\'s head: git rev-parse failed' })
  w.workspaces.impl.headOf = async () => undefined
  await assert.rejects(call(w, { action: 'plan', plan: 'docs/plans/p.md' }), /^Error: can't read the run's head: /)
  assert.equal((await w.entries(run)).length, count)
  assert.deepEqual(w.record(run)?.plan, attached)
})

test('abandon: the record and run.closed; the chat drives nothing after it, and goal then gives NO_RUN; refused without a reason', async () => {
  const w = await world()
  const run = await openRun(w)
  await assert.rejects(call(w, { action: 'abandon' }), { message: '`reason` is required for abandon: why, in one line' })
  w.clock.now = NOW + 5000
  const answer = await call(w, { action: 'abandon', reason: 'The bug was\nin the proxy.' })
  assert.deepEqual(answer, {
    action: 'abandon', run: run.id,
    text: `Abandoned run \`${run.id}\`: The bug was in the proxy. Its worktrees are left as they are: remove them with \`worktree\` \`remove\` `
      + '(with `force` if unmerged). This chat drives no run now.',
  })
  const record = w.record(run)!
  assert.deepEqual([record.state, record.reason, record.closedAt, record.driver], ['abandoned', 'The bug was in the proxy.', NOW + 5000, { session: '', since: NOW + 5000 }])
  const closed = (await w.entries(run)).at(-1) as unknown as Record<string, unknown>
  assert.deepEqual([closed.kind, closed.by, closed.session, closed.state, closed.reason], ['run.closed', 'harness', SESSION, 'abandoned', 'The bug was in the proxy.'])
  assert.equal(await w.runs.driving(SESSION), undefined)
  await assert.rejects(call(w, { action: 'goal', goal: 'Another' }), { message: NO_RUN })
})

test('the writes read the run again under its lock: a run closed while the call waited gives NO_RUN, and nothing is written', async () => {
  const w = await world()
  const run = await openRun(w)
  const gate = deferred()
  const held = w.runs.withRun(run, async () => {
    await gate.promise
    await w.runs.close(run, SESSION, { state: 'abandoned', reason: 'closed meanwhile' })
  })
  const pending = call(w, { action: 'note', text: 'too late' })
  await new Promise(settle => setTimeout(settle, 30))
  gate.resolve()
  await held
  await assert.rejects(pending, { message: NO_RUN })
  assert.deepEqual(await w.kinds(run), ['run.opened', 'run.closed'])
})

// --- ruling, defer, note -----------------------------------------------------------------------------------------------

test('ruling, defer and note: by main, with the session; the answers', async () => {
  const w = await world()
  const run = await openRun(w)
  w.clock.now = NOW + 60_000
  assert.deepEqual(await call(w, { action: 'ruling', what: 'Kept the old cookie', why: 'Compatibility', costIfWrong: 'One more round', task: '' }),
    { action: 'ruling', run: run.id, text: `Recorded your ruling in run \`${run.id}\`.` })
  assert.equal((await call(w, { action: 'ruling', what: 'Skip e2e', why: 'Flaky', costIfWrong: 'A regression', task: 'fix-login' })).text,
    `Recorded your ruling in run \`${run.id}\` on task \`fix-login\`.`)
  assert.equal((await call(w, { action: 'defer', what: 'Rename the helper', where: 'src/a.ts', why: 'Out of scope' })).text,
    `Recorded the deferred finding in run \`${run.id}\`.`)
  assert.equal((await call(w, { action: 'note', text: 'Waiting on the user.\n\n\n\nThen merge.   \n' })).text, `Noted in run \`${run.id}\`.`)
  const entries = (await w.entries(run)).slice(1)
  assert.deepEqual(entries, [
    { at: NOW + 60_000, run: run.id, kind: 'ruling', by: 'main', session: SESSION, what: 'Kept the old cookie', why: 'Compatibility', costIfWrong: 'One more round' },
    { at: NOW + 60_000, run: run.id, kind: 'ruling', by: 'main', session: SESSION, what: 'Skip e2e', why: 'Flaky', costIfWrong: 'A regression', task: 'fix-login' },
    { at: NOW + 60_000, run: run.id, kind: 'deferred', by: 'main', session: SESSION, what: 'Rename the helper', where: 'src/a.ts', why: 'Out of scope' },
    { at: NOW + 60_000, run: run.id, kind: 'note', by: 'main', session: SESSION, text: 'Waiting on the user.\n\nThen merge.' },
  ])
})

test('ruling, defer and note: a missing field, an unknown task, a token, a long note, and arguments that try to choose a kind or a writer', async () => {
  const w = await world()
  const run = await openRun(w)
  const ruling = { action: 'ruling', what: 'a', why: 'b', costIfWrong: 'c' }
  for (const missing of ['what', 'why', 'costIfWrong']) {
    await assert.rejects(call(w, { ...ruling, [missing]: '' }), { message: '`what`, `why` and `costIfWrong` are required for ruling' })
  }
  const defer = { action: 'defer', what: 'a', where: 'b', why: 'c' }
  for (const missing of ['what', 'where', 'why']) {
    await assert.rejects(call(w, { ...defer, [missing]: ' ' }), { message: '`what`, `where` and `why` are required for defer' })
  }
  await assert.rejects(call(w, { action: 'note', text: '\n' }), { message: '`text` is required for note: one line to a few' })
  // A task of the run's, removed or not, is one; anything else is refused with the list.
  await w.runs.harness(run, { kind: 'task.opened', session: SESSION, task: 'api', path: await w.worktree('api'), branch: 'dish/api', base: 'dish/fix-login', baseCommit: BASE })
  await w.runs.harness(run, { kind: 'task.removed', task: 'api' })
  await call(w, { ...ruling, task: 'api' })
  await assert.rejects(call(w, { ...ruling, task: 'nope' }), { message: `task \`nope\` isn't one of run \`${run.id}\`'s tasks (fix-login, api)` })
  const written = (await w.entries(run)).length

  // A token, masked in the ledger; a long note, cut; folded lines in a ruling.
  await call(w, { action: 'ruling', what: 'Used the\nadmin token', why: `It was ${TOKEN}`, costIfWrong: 'c'.repeat(600) })
  await call(w, { action: 'note', text: 'n'.repeat(5000) })
  // Arguments that name a kind, a writer, a time or a run are ignored.
  await call(w, { action: 'note', text: 'mine', kind: 'gate.result', by: 'harness', at: 1, run: 'other', session: OTHER_SESSION, cut: true, outcome: 'passed' })
  const [tokenRuling, longNote, forged] = (await w.entries(run)).slice(written) as unknown as Array<Record<string, unknown>>
  assert.equal(tokenRuling!.what, 'Used the admin token')
  assert.equal(tokenRuling!.why, `It was ${MASKED_TOKEN}`)
  assert.equal((tokenRuling!.costIfWrong as string).length, 500)
  assert.equal((longNote!.text as string).length, 2000)
  assert.match(longNote!.text as string, /…$/)
  assert.deepEqual(forged, { at: NOW, run: run.id, kind: 'note', by: 'main', session: SESSION, text: 'mine' })
})

test('goal, plan, abandon, ruling, defer and note: NO_RUN without a run this chat drives', async () => {
  const w = await world()
  await w.open({ session: OTHER_SESSION })
  for (const action of ['goal', 'plan', 'abandon', 'ruling', 'defer', 'note']) {
    await assert.rejects(call(w, { ...EVERY_ARGUMENT, action }), { message: NO_RUN }, action)
  }
  assert.deepEqual(stubCalls(w), {})
})

// --- status ----------------------------------------------------------------------------------------------------------

test('status: with no run, NO_RUN and then the list of every run', async () => {
  const w = await world()
  await w.open({ session: OTHER_SESSION })
  await prRun(w, { session: OTHER_SESSION, slug: 'shipped' })
  const answer = await call(w, { action: 'status' })
  const all = w.store.list()
  const list = listText(all.filter(run => run.state === 'open'), all.filter(run => run.state === 'pr'), { caller: SESSION, now: NOW, live: run => w.runs.live(run) })
  assert.deepEqual(answer, { action: 'status', run: '', text: `${NO_RUN}\n\n${list}` })
  assert.match(answer.text, /With a pull request/)
  assert.deepEqual(w.workspaces.calls.compareBranch, [])
})

test('status: statusText over the ledger, the head and cleanliness from dish-workspaces, the gate at that head, and the branch against GitHub', async () => {
  const w = await world()
  const run = await openRun(w)
  await w.runs.harness(run, {
    kind: 'gate.result', session: SESSION, child: 'c1', task: 'fix-login', outcome: 'passed', exitCode: 0, timedOut: false, durationMs: 900,
    log: '/logs/gate.log', head: HEAD, gateTurn: 1, gateRound: 1,
  })
  w.clock.now = NOW + 10 * 60_000
  const answer = await call(w, { action: 'status' })
  const entries = await w.entries(run)
  assert.deepEqual(answer, {
    action: 'status', run: run.id,
    text: statusText(w.record(run)!, summarize(run, entries), {
      caller: SESSION, now: NOW + 10 * 60_000, head: HEAD, clean: { clean: true }, branch: { behindDefault: 0, aheadOfDefault: 1, remoteAhead: null },
      gateAtHead: { child: 'c1', outcome: 'passed', exitCode: 0, head: HEAD, at: NOW, log: '/logs/gate.log' },
    }),
  })
  assert.deepEqual(w.workspaces.calls.compareBranch, [[PROJECT, 'fix-login']])
  assert.deepEqual(w.workspaces.calls.headOf.at(-1), [run.worktree])
  assert.deepEqual(w.workspaces.calls.isClean.at(-1), [run.worktree])
  assert.match(answer.text, /^Against GitHub \(just fetched\): 1 commit ahead of the default branch, 0 behind; dish\/fix-login isn't on GitHub yet\.$/m)
  assert.match(answer.text, new RegExp(`^\`open_pr\` now: head ${shortSha(HEAD)}, clean; the gate runs on that head when you call it \\(the last result at this head: passed, 10 min ago\\);`, 'm'))

  // The counts as compareBranch gives them.
  w.workspaces.impl.compareBranch = async () => ({ behindDefault: 2, aheadOfDefault: 3, remoteAhead: 1 })
  const behind = (await call(w, { action: 'status' })).text
  assert.match(behind, /^Against GitHub \(just fetched\): 3 commits ahead of the default branch, 2 behind; GitHub's dish\/fix-login has 1 commit this one lacks\.$/m)
  assert.match(behind, /^To bring it up to date, have a coder fetch and merge `origin\/main` and `origin\/dish\/fix-login` into the run's worktree\./m)
  // No lock is held: status answers while the run's lock is busy.
  const gate = deferred()
  const held = w.runs.withRun(run, () => gate.promise)
  assert.match((await call(w, { action: 'status' })).text, /^Run `/)
  gate.resolve()
  await held
})

test('status: headOf rejecting is the head problem; compareBranch rejecting is "can\'t tell", masked, and the rest still comes', async () => {
  const w = await world()
  await openRun(w)
  w.workspaces.impl.headOf = async () => { throw new Error('git rev-parse HEAD failed') }
  const unread = (await call(w, { action: 'status' })).text
  assert.match(unread, /^`open_pr` now: the head can't be read: git rev-parse HEAD failed;/m)
  assert.match(unread, /^Final review: none yet/m)

  w.workspaces.impl.headOf = async () => HEAD
  w.workspaces.impl.compareBranch = async () => { throw new Error(`could not fetch\nwith ${TOKEN}`) }
  const text = (await call(w, { action: 'status' })).text
  assert.match(text, new RegExp(`^Against GitHub: can't tell \\(could not fetch with ${MASKED_TOKEN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)\\.$`, 'm'))
  assert.equal(text.includes(TOKEN), false)
  for (const prefix of ['Run `', 'Branch ', 'No plan', 'Tasks:', '- fix-login (the run\'s own worktree)', 'Final review:', '`open_pr` now: head']) {
    assert.ok(text.split('\n').some(line => line.startsWith(prefix)), prefix)
  }
  // Without dish-workspaces, both say so.
  w.absent.add('workspaces')
  const without = (await call(w, { action: 'status' })).text
  assert.match(without, /^Against GitHub: can't tell \(dish-workspaces isn't running\)\.$/m)
  assert.match(without, /^`open_pr` now: the head can't be read: dish-workspaces isn't running;/m)
})

// --- list ------------------------------------------------------------------------------------------------------------

test('list: for a project and for all, the four driver wordings, and the runs with a pull request after the open ones', async () => {
  const w = await world()
  w.live.add(OTHER_SESSION)
  const mine = await openRun(w)
  w.clock.now = NOW + 60_000
  await w.open({ session: OTHER_SESSION, slug: 'theirs' })
  w.clock.now = NOW + 120_000
  await w.open({ session: 'session-gone', slug: 'stale' })
  w.clock.now = NOW + 180_000
  const freed = await w.open({ session: 'session-3', slug: 'freed' })
  const next = await w.created('next', { project: OTHER_PROJECT })
  await w.runs.withSession('session-3', () => w.runs.openAround('session-3', next, { goal: 'Elsewhere', how: 'run' }))
  w.clock.now = NOW + 240_000
  await prRun(w, { session: 'session-4', slug: 'shipped' })
  w.clock.now = NOW + HOUR

  const all = await call(w, { action: 'list', project: '' })
  assert.equal(all.run, '')
  assert.equal(all.action, 'list')
  const text = all.text.split('\n')
  assert.equal(text[0], 'Open runs:')
  assert.ok(text.includes(`- ${PROJECT} \`${mine.id}\`: ${GOAL}, opened 1 h ago; this chat drives it`))
  assert.ok(text.some(line => line.includes('`20261003-theirs`') && line.endsWith(`driven by another chat (session ${shortSession(OTHER_SESSION)}, still open)`)))
  assert.ok(text.some(line => line.includes('`20261003-stale`') && line.endsWith(`driven by session ${shortSession('session-gone')}, which isn't live (\`run\` \`resume\` takes it)`)))
  assert.ok(text.some(line => line.includes(`\`${freed.id}\``) && line.endsWith('nobody drives it (`run` `resume` takes it)')))
  assert.ok(text.some(line => line.startsWith(`- ${OTHER_PROJECT} \`20261003-next\``)))
  const prAt = text.indexOf('With a pull request (`run` `resume` reopens one for review feedback):')
  assert.ok(prAt > text.findIndex(line => line.includes('`20261003-next`')))
  assert.equal(text[prAt + 1], `- ${PROJECT} \`20261003-shipped\`: ${GOAL}, PR #3 ${PR_URL}, 56 min ago`)

  const one = (await call(w, { action: 'list', project: OTHER_PROJECT.toLowerCase() })).text.split('\n')
  assert.deepEqual(one, [`Open runs in ${OTHER_PROJECT.toLowerCase()}:`, `- ${OTHER_PROJECT} \`20261003-next\`: Elsewhere, opened 57 min ago; driven by session ${shortSession('session-3')}, which isn't live (\`run\` \`resume\` takes it)`])
  assert.equal((await call(w, { action: 'list', project: 'Acme/none' })).text, 'No open runs in Acme/none.')
})

// --- masking, and the tool through dsh -------------------------------------------------------------------------------

test('every text the tool gives is masked once more, and so is every error', async () => {
  const w = await world()
  const answer = await call(w, { action: 'open', project: PROJECT, slug: 'fix-login', goal: `Rotate ${TOKEN}` })
  assert.equal(answer.text.includes(TOKEN), false)
  assert.ok(answer.text.includes(MASKED_TOKEN))
  const noted = await call(w, { action: 'note', text: `the key was ${TOKEN}` })
  assert.equal(JSON.stringify(noted).includes(TOKEN), false)
  w.projects.impl.get = async () => { throw new Error(`projects.yaml can't be read: ${TOKEN}`) }
  await assert.rejects(call(w, { action: 'open', project: PROJECT, slug: 'other', goal: GOAL }), (error: Error) => !error.message.includes(TOKEN))
})

test('planProblem: a relative path inside the worktree, normalized; each refusal', async () => {
  const w = await world()
  const path = await w.worktree('fix-login')
  await mkdir(join(path, 'docs', 'plans'), { recursive: true })
  await writeFile(join(path, 'docs', 'plans', 'x.md'), 'x')
  await symlink(join(path, 'docs', 'plans', 'x.md'), join(path, 'inside.md'))
  const outside = join(dirname(path), 'outside.md')
  await writeFile(outside, 'x')
  await symlink(outside, join(path, 'escape.md'))
  assert.deepEqual(await planProblem(path, 'docs/plans/x.md'), { ok: true, path: 'docs/plans/x.md' })
  assert.deepEqual(await planProblem(path, './docs/./plans//x.md'), { ok: true, path: 'docs/plans/x.md' })
  assert.deepEqual(await planProblem(path, 'inside.md'), { ok: true, path: 'inside.md' })
  const why = async (plan: string): Promise<string> => {
    const found = await planProblem(path, plan)
    assert.equal(found.ok, false, plan)
    return (found as { why: string }).why
  }
  assert.match(await why('escape.md'), /leads outside the run's worktree/)
  assert.match(await why('../fix-login/docs/plans/x.md'), /"\.\." segment/)
  assert.match(await why('docs/../docs/plans/x.md'), /"\.\." segment/)
  assert.match(await why(join(path, 'docs/plans/x.md')), /absolute/)
  assert.match(await why('docs\\plans\\x.md'), /backslash/)
  assert.match(await why('docs/plans/x.md\0'), /NUL/)
  assert.match(await why(`${'d/'.repeat(150)}x.md`), /longer than 300 characters/)
  assert.match(await why('docs/plans'), /isn't a regular file/)
  assert.match(await why('.'), /names no file/)
  assert.match(await why('docs/none.md'), /no such file/)
  assert.match((await planProblem(join(path, 'gone'), 'x.md') as { why: string }).why, /run's worktree/)
})

test('through dsh\'s ToolRuntime: the parameter schema is enforced, a child is refused, and list answers', async () => {
  const w = await pluginWorld({ tools: true })
  try {
    const tools = w.ctx.get('tools') as unknown as {
      execute(call: { callId: string, name: string, arguments: unknown, agent: unknown, signal: AbortSignal }): Promise<{ isError: boolean, content: Array<{ type: string, text?: string }> }>
    }
    const main = { id: SESSION, session: { header: { id: SESSION, cwd: w.dir } }, options: {} }
    await waitFor('the run tool', () => (w.ctx.get('tools') as unknown as { get(name: string): unknown }).get('run') !== undefined)
    const execute = (args: unknown, agent: unknown = main) => tools.execute({ callId: `c-${Math.random()}`, name: 'run', arguments: args, agent, signal: new AbortController().signal })
    const text = (result: { content: Array<{ text?: string }> }) => result.content.map(block => block.text ?? '').join('')
    const listed = await execute({ action: 'list' })
    assert.equal(listed.isError, false, text(listed))
    assert.equal(text(listed), 'No open runs.')
    const bad = await execute({ action: 'merge' })
    assert.equal(bad.isError, true)
    assert.match(text(bad), /action/)
    const notBoolean = await execute({ action: 'resume', id: ID, takeover: 'yes' })
    assert.equal(notBoolean.isError, true)
    assert.match(text(notBoolean), /takeover/)
    const child = await execute({ action: 'list' }, { id: 'child-1', session: { header: { id: 'child-1', delegationDepth: 1, origin: 'subagent' } }, options: {} })
    assert.equal(child.isError, true)
    assert.match(text(child), new RegExp(MAIN_ONLY))
  } finally {
    await w.dispose()
  }
})
