/**
 * The plugin, in a cordis `Context` with its siblings' services provided by stub plugins (`pluginWorld`), dsh's
 * `ToolRuntime` where tools are concerned, and crew's real host plugin where crew's own publish is pinned.
 */

import assert from 'node:assert/strict'
import { readdir, readFile, stat, utimes } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import type { DishCrew } from 'dish-crew'
import * as plugin from '../src/index.ts'
import type { DishRuns } from '../src/index.ts'
import { openPrTool } from '../src/open-pr.ts'
import { prFeedbackTool } from '../src/pr-feedback.ts'
import { runTool } from '../src/run-tool.ts'
import { RunStore } from '../src/store.ts'
import { Ledger } from '../src/ledger.ts'
import {
  BASE, NOW, PROJECT, SESSION, delegated, gateDone, pluginWorld, provideStub, settled, tempDir, waitFor, withEnv,
} from './service-helpers.ts'
import type { Handle } from './service-helpers.ts'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')
const YEAR = 365 * 24 * 60 * 60 * 1000

/** What stderr was written while it was captured. */
function captureStderr(): { text: () => string, restore: () => void } {
  const original = process.stderr.write
  const chunks: string[] = []
  process.stderr.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk))
    return true
  }) as typeof process.stderr.write
  return { text: () => chunks.join(''), restore: () => { process.stderr.write = original } }
}

/** Every file under `dir`, recursively. */
async function filesUnder(dir: string): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...await filesUnder(path))
    else found.push(path)
  }
  return found
}

test('the config: terminal, on by default', () => {
  const parse = plugin.Config as unknown as (value: unknown) => unknown
  assert.deepEqual(parse({}), { terminal: true })
  assert.deepEqual(parse({ terminal: false }), { terminal: false })
  assert.equal(plugin.name, 'dish-orchestrator')
})

test('dishRuns is provided with exactly the five methods, and goes with the plugin', async () => {
  const w = await pluginWorld()
  try {
    const service = w.ctx.get('dishRuns') as DishRuns
    assert.deepEqual(Object.keys(service).sort(), ['driving', 'ladder', 'place', 'worktreeCreated', 'worktreeRemoved'])
    assert.ok(Object.values(service).every(method => typeof method === 'function'))
    // Through the service: a worktree opens a run around it, and place finds it.
    const created = await w.created('fix-login')
    assert.deepEqual(await service.worktreeCreated(SESSION, created), { id: '20261003-fix-login', opened: true })
    assert.deepEqual(await service.place(SESSION, { worktree: created.path }), { run: `${PROJECT}/20261003-fix-login`, task: 'fix-login', round: 0 })
    assert.equal((await service.driving(SESSION))?.id, '20261003-fix-login')
    await w.handles.plugin!.dispose()
    assert.equal(w.ctx.get('dishRuns'), undefined)
  } finally {
    await w.dispose()
  }
})

test('the events: dish-crew/delegated, dish-crew/settled and dish-gates/result, each published with ctx.parallel, land in the ledger', async () => {
  const w = await pluginWorld()
  try {
    const run = await w.open()
    const tags = { id: 'c1', run: w.runs.refOf(run), task: 'fix-login', worktree: run.worktree }
    await w.ctx.parallel('dish-crew/delegated', delegated(tags))
    await w.ctx.parallel('dish-gates/result', gateDone('c1'))
    await w.ctx.parallel('dish-crew/settled', settled(tags))
    await w.ledger.flush()
    assert.deepEqual(await w.kinds(run), ['run.opened', 'child.started', 'gate.result', 'child.ended'])
  } finally {
    await w.dispose()
  }
})

test('with dish-crew\'s real host plugin: a child tagged with a run and a task, then subagent/end, gives child.ended (crew\'s publish)', async () => {
  const w = await pluginWorld({ realCrew: true })
  try {
    const run = await w.open()
    const crew = w.ctx.get('dishCrew') as DishCrew
    await crew.records.addChild(SESSION, {
      id: 'c1', role: 'coder', title: 'Fix it', model: 'deepseek-chat', family: 'deepseek', worktree: run.worktree, run: w.runs.refOf(run), task: 'fix-login',
    })
    w.ctx.emit('subagent/end', { runId: 'run-1', provider: 'spawn', id: 'c1', local: true, stopReason: 'completed' } as never)
    await crew.whenRecorded('c1')
    await waitFor('child.ended', async () => (await w.kinds(run)).includes('child.ended'))
    const ended = (await w.entries(run)).at(-1)!
    assert.equal(ended.kind, 'child.ended')
    assert.equal(ended.by, 'harness')
    assert.equal(ended.child, 'c1')
    assert.equal(ended.task, 'fix-login')
    assert.ok(ended.kind === 'child.ended' && ended.reportFile.startsWith(w.crewData), JSON.stringify(ended))
  } finally {
    await w.dispose()
  }
})

test('the defaults: with DSH_DISH_HOME, records go under <it>/state/dish/orchestrator and ledgers under <it>/data/dish/ledgers', async () => {
  const dir = await tempDir()
  const instance = join(dir, 'inst')
  await withEnv({ DSH_DISH_HOME: instance }, async () => {
    const ctx = new Context()
    const mounted = ctx.plugin(plugin, { terminal: false } as never) as unknown as Handle
    await mounted
    try {
      const service = ctx.get('dishRuns') as DishRuns
      const path = join(dir, 'work', 'Acme', 'widget', '.worktrees', 'fix-login')
      const joined = await service.worktreeCreated(SESSION, {
        project: PROJECT, slug: 'fix-login', branch: 'dish/fix-login', path, clone: join(dir, 'work', 'Acme', 'widget'), base: BASE, baseRef: 'origin/main',
      })
      assert.equal(joined?.opened, true)
      const id = joined!.id
      assert.ok((await stat(join(instance, 'state', 'dish', 'orchestrator', 'Acme', 'widget', 'runs', `${id}.json`))).isFile())
      await waitFor('the ledger', async () => (await stat(join(instance, 'data', 'dish', 'ledgers', 'Acme', 'widget', `${id}.jsonl`)).catch(() => undefined)) !== undefined)
    } finally {
      await mounted.dispose()
    }
  })
})

test('retention: a record and a ledger two years old are untouched by start, and still listed', async () => {
  const w = await pluginWorld()
  const old = await w.open({ slug: 'old-work' })
  await w.ledger.flush()
  await w.dispose()
  const record = join(w.state, 'orchestrator', 'Acme', 'widget', 'runs', `${old.id}.json`)
  const ledger = join(w.data, 'ledgers', 'Acme', 'widget', `${old.id}.jsonl`)
  const then = new Date(NOW - 2 * YEAR)
  await utimes(record, then, then)
  await utimes(ledger, then, then)
  const before = { record: await readFile(record, 'utf8'), ledger: await readFile(ledger, 'utf8') }
  // The same directories, mounted again.
  const ctx = new Context()
  let runs: ReturnType<typeof plugin.start> | undefined
  const mounted = ctx.plugin({
    name: plugin.name, Config: plugin.Config,
    apply: (own: Context, config: plugin.Config) => { runs = plugin.start(own, config, { state: w.state, data: w.data, now: () => NOW }) },
  } as never, { terminal: false } as never) as unknown as Handle
  await mounted
  try {
    await runs!.ready()
    await new Promise(settle => setTimeout(settle, 50))
    assert.equal((await stat(record)).mtimeMs, then.getTime())
    assert.equal((await stat(ledger)).mtimeMs, then.getTime())
    assert.deepEqual({ record: await readFile(record, 'utf8'), ledger: await readFile(ledger, 'utf8') }, before)
    assert.deepEqual(runs!.store.list().map(run => run.id), [old.id])
    const store = new RunStore(w.state)
    await store.load()
    assert.equal(store.list().length, 1)
    assert.equal((await new Ledger(w.data).entries(PROJECT, old.id)).entries.length, 1)
  } finally {
    await mounted.dispose()
  }
})

test('the tools register once tools is there: exactly those whose factories give one (the stubs give none)', async () => {
  const w = await pluginWorld()
  const handles: Handle[] = []
  try {
    handles.push(provideStub(w.ctx, 'systemPrompt', { tools() {}, section() {}, getSectionOrder: () => 1 }))
    await handles[0]
    handles.push(w.ctx.plugin(ToolRuntime, {}) as unknown as Handle)
    await handles[1]
    const tools = w.ctx.get('tools') as unknown as { get(name: string): { name: string } | undefined }
    const expected = [runTool(w.deps), openPrTool(w.deps), prFeedbackTool(w.deps)].flatMap(tool => tool === undefined ? [] : [tool.name])
    await waitFor('the tools', () => expected.every(name => tools.get(name) !== undefined))
    assert.deepEqual(['run', 'open_pr', 'pr_feedback'].filter(name => tools.get(name) !== undefined), expected)
  } finally {
    for (const handle of handles.reverse()) await handle.dispose()
    await w.dispose()
  }
})

test('terminal: false prints nothing; terminal: true prints the plugin\'s own lines', async () => {
  for (const terminal of [false, true]) {
    const captured = captureStderr()
    let printed: string
    try {
      const w = await pluginWorld({ config: { terminal } })
      try {
        await (w.ctx.get('dishRuns') as DishRuns).ladder({ sessionId: SESSION, run: `${PROJECT}/20260101-gone`, task: 'fix-login', round: 5, outcome: 'refused' })
      } finally {
        await w.dispose()
      }
    } finally {
      captured.restore()
      printed = captured.text()
    }
    const lines = printed.split('\n').filter(line => line.startsWith('[dish-orchestrator]'))
    if (terminal) assert.match(lines.join('\n'), /^\[dish-orchestrator\] warn: .*20260101-gone/m)
    else assert.deepEqual(lines, [])
  }
})

test('source scans: no child_process anywhere in src; the ledgers\' directory is named only in paths.ts', async () => {
  for (const file of await filesUnder(SRC)) {
    const text = await readFile(file, 'utf8')
    assert.equal(text.includes('child_process'), false, `${relative(SRC, file)} mentions child_process`)
    if (relative(SRC, file) !== 'paths.ts') assert.equal(/['"`]ledgers['"`/]/.test(text), false, `${relative(SRC, file)} names 'ledgers'`)
  }
})
