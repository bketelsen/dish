/**
 * The Settings → Runs page's controller, driven through a fake remote: what it loads, how a run is opened (its detail and the
 * first page of its timeline together), how older pages join the timeline up to its cap, what a refusal and a carrier that
 * fails become, and that an answer for something the person has moved on from (another run, the list, a disposed page) never
 * lands. The controller has no React in it, so this runs under `node --test`; the JSX around it is checked in
 * `client-rendering.test.ts` and, by hand, in a browser.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { TIMELINE_MAX, TIMELINE_PAGE, createRunsPage } from '../src/client/controller.ts'
import type { PageState, RunsController } from '../src/client/controller.ts'
import type { RunsApi } from '../src/client/remote.ts'
import type { ErrorCode, LedgerLine, LedgerPage, Outcome, RunDetail, RunRow, RunSummary } from '../src/protocol.ts'

// --- fakes ---------------------------------------------------------------------------------------

const carrierDown = (): RemoteResult<never> => ({ ok: false, error: { message: 'gateway offline' } }) as unknown as RemoteResult<never>

interface Gate { release: () => void, opened: Promise<void> }

function gate(): Gate {
  let release!: () => void
  const opened = new Promise<void>((resolve) => { release = resolve })
  return { release, opened }
}

const PROJECT = 'Acme/widget'

function row(id: string, overrides: Partial<RunRow> = {}): RunRow {
  return { project: PROJECT, id, slug: id.slice(9), goal: `Goal of ${id}`, state: 'open', driver: { session: 'session-1', since: 1_000, live: true }, openedAt: 1_000, ...overrides }
}

const SUMMARY: RunSummary = { tasks: [], rulings: [], deferred: [], notes: [] }

function detailOf(base: RunRow): RunDetail {
  return { ...base, branch: `dish/${base.slug}`, worktree: `/work/${base.slug}`, base: 'origin/main', baseCommit: 'a'.repeat(40), summary: SUMMARY }
}

/** `count` lines of run `id`, newest first: the newest is `${id} ${count - 1}`. */
function lines(id: string, count: number): LedgerLine[] {
  return Array.from({ length: count }, (_, index) => {
    const n = count - 1 - index
    return { at: 1_000 + n, run: id, kind: 'note', by: 'main' as const, fields: { text: `${id} ${n}` } }
  })
}

/** dish-orchestrator's remote over a list, details and ledgers (newest first), with gates, a carrier that can fail, and refusals. */
class FakeRuns implements RunsApi {
  calls: string[] = []
  rows: RunRow[] = [row('20261003-alpha'), row('20261003-beta', { state: 'pr', driver: null, closedAt: 2_000, pr: { url: 'https://github.com/Acme/widget/pull/1', number: 1 } })]
  ledgers = new Map<string, LedgerLine[]>([['20261003-alpha', lines('20261003-alpha', 3)], ['20261003-beta', lines('20261003-beta', 250)]])
  gates = new Map<string, Gate>()
  /** Calls (by the key they wait on) whose carrier fails. */
  down = new Set<string>()
  /** Calls (by key) the server refuses. */
  refusals = new Map<string, { code: ErrorCode, message: string }>()
  skipped = 0

  hold(key: string): Gate {
    const held = gate()
    this.gates.set(key, held)
    return held
  }

  private async wait(key: string): Promise<void> {
    const held = this.gates.get(key)
    if (held === undefined) return
    this.gates.delete(key)
    await held.opened
  }

  async runs(): Promise<RemoteResult<RunRow[]>> {
    this.calls.push('runs')
    const answer = structuredClone(this.rows)
    await this.wait('runs')
    return this.down.has('runs') ? carrierDown() : { ok: true, value: answer }
  }

  async run(project: string, id: string): Promise<RemoteResult<Outcome<RunDetail>>> {
    const key = `run ${id}`
    this.calls.push(`${key} ${project}`)
    await this.wait(key)
    if (this.down.has(key)) return carrierDown()
    const refusal = this.refusals.get(key)
    if (refusal !== undefined) return { ok: true, value: { ok: false, ...refusal } }
    const found = this.rows.find(candidate => candidate.project === project && candidate.id === id)
    if (found === undefined) return { ok: true, value: { ok: false, code: 'NOT_FOUND', message: `no run ${project}/${id}` } }
    return { ok: true, value: { ok: true, value: detailOf(found) } }
  }

  async ledger(project: string, id: string, limit: number, before: string): Promise<RemoteResult<Outcome<LedgerPage>>> {
    const key = `ledger ${id} ${before}`
    this.calls.push(`${key} ${limit} ${project}`)
    await this.wait(key)
    if (this.down.has(key)) return carrierDown()
    const refusal = this.refusals.get(key)
    if (refusal !== undefined) return { ok: true, value: { ok: false, ...refusal } }
    const all = this.ledgers.get(id) ?? []
    const start = before === '' ? 0 : Number(before)
    const page = all.slice(start, start + limit)
    const end = start + page.length
    return { ok: true, value: { ok: true, value: { lines: structuredClone(page), skipped: this.skipped, ...end < all.length ? { next: String(end) } : {} } } }
  }
}

function make(api = new FakeRuns()): { api: FakeRuns, page: RunsController, state: () => PageState } {
  const page = createRunsPage(api)
  return { api, page, state: () => page.getState() }
}

/** Let what is resolved run on. */
const settle = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

// --- the tests -----------------------------------------------------------------------------------

test('the face is the actions and the observable, and nothing that feeds the controller', () => {
  const { page } = make()
  assert.deepEqual(Object.keys(page.face).sort(), ['back', 'hooks', 'loadOlder', 'open', 'refresh', 'select'])
  assert.equal(page.face.hooks.page.getSnapshot(), page.getState())
  assert.equal(TIMELINE_PAGE, 200)
  assert.equal(TIMELINE_MAX, 2000)
})

test('it starts idle, and open reads the list: no run is selected, so nothing else is read', async () => {
  const { api, page, state } = make()
  assert.deepEqual(state(), {
    list: { load: 'idle', rows: [] },
    detail: { load: 'idle' },
    timeline: { load: 'idle', lines: [], skipped: 0, more: 'idle', capped: false },
  })
  const heard: PageState[] = []
  const stop = page.face.hooks.page.subscribe(() => { heard.push(page.face.hooks.page.getSnapshot()) })
  const opening = page.face.open()
  assert.equal(state().list.load, 'loading')
  await opening
  stop()
  assert.deepEqual(api.calls, ['runs'])
  assert.equal(state().list.load, 'ready')
  assert.deepEqual(state().list.rows, api.rows)
  assert.equal(state().selected, undefined)
  assert.ok(heard.length >= 2)
})

test('select reads the run and the first page of its timeline together, and the timeline is oldest first', async () => {
  const { api, page, state } = make()
  await page.face.open()
  const detail = api.hold('run 20261003-beta')
  const timeline = api.hold('ledger 20261003-beta ')
  const selecting = page.face.select(PROJECT, '20261003-beta')
  // Both asked before either answered.
  assert.deepEqual(api.calls.slice(1), [`run 20261003-beta ${PROJECT}`, `ledger 20261003-beta  ${TIMELINE_PAGE} ${PROJECT}`])
  assert.deepEqual(state().selected, { project: PROJECT, id: '20261003-beta' })
  assert.equal(state().detail.load, 'loading')
  assert.equal(state().timeline.load, 'loading')
  detail.release()
  timeline.release()
  await selecting
  assert.equal(state().detail.load, 'ready')
  assert.equal(state().detail.value?.id, '20261003-beta')
  const shown = state().timeline
  assert.equal(shown.load, 'ready')
  assert.equal(shown.lines.length, TIMELINE_PAGE)
  // The newest 200 of 250, oldest first: 50 … 249.
  assert.equal(shown.lines[0]!.fields.text, '20261003-beta 50')
  assert.equal(shown.lines.at(-1)!.fields.text, '20261003-beta 249')
  assert.equal(shown.next, String(TIMELINE_PAGE))
  assert.equal(shown.capped, false)
})

test('loadOlder puts the older page before, keeping the order oldest first, and stops at the start of the ledger', async () => {
  const { api, page, state } = make()
  await page.face.select(PROJECT, '20261003-beta')
  await page.face.loadOlder()
  const shown = state().timeline
  assert.equal(shown.lines.length, 250)
  assert.deepEqual(shown.lines.map(line => line.fields.text), Array.from({ length: 250 }, (_, n) => `20261003-beta ${n}`))
  assert.equal(shown.next, undefined)
  assert.equal(shown.capped, false)
  assert.equal(shown.more, 'idle')
  // Nothing more to read: loadOlder asks for nothing.
  const asked = api.calls.length
  await page.face.loadOlder()
  assert.equal(api.calls.length, asked)
})

test('loadOlder stops at TIMELINE_MAX lines, the newest, and says the older ones aren\'t shown', async () => {
  const api = new FakeRuns()
  api.ledgers.set('20261003-beta', lines('20261003-beta', 2_500))
  const { page, state } = make(api)
  await page.face.select(PROJECT, '20261003-beta')
  while (state().timeline.next !== undefined) await page.face.loadOlder()
  const shown = state().timeline
  assert.equal(shown.lines.length, TIMELINE_MAX)
  assert.equal(shown.capped, true)
  assert.equal(shown.lines[0]!.fields.text, '20261003-beta 500')
  assert.equal(shown.lines.at(-1)!.fields.text, '20261003-beta 2499')
  for (let index = 1; index < shown.lines.length; index++) assert.ok(shown.lines[index - 1]!.at < shown.lines[index]!.at)

  // Exactly as many as the cap: all of it is shown, and nothing is said to be missing.
  api.ledgers.set('20261003-beta', lines('20261003-beta', 2_000))
  await page.face.select(PROJECT, '20261003-beta')
  while (state().timeline.next !== undefined) await page.face.loadOlder()
  assert.equal(state().timeline.lines.length, 2_000)
  assert.equal(state().timeline.capped, false)
})

test('a page\'s skipped lines add up, page after page', async () => {
  const api = new FakeRuns()
  api.skipped = 2
  const { page, state } = make(api)
  await page.face.select(PROJECT, '20261003-beta')
  assert.equal(state().timeline.skipped, 2)
  await page.face.loadOlder()
  assert.equal(state().timeline.skipped, 4)
})

test('an answer for a run no longer selected is dropped: after another select', async () => {
  const { api, page, state } = make()
  const detail = api.hold('run 20261003-alpha')
  const timeline = api.hold('ledger 20261003-alpha ')
  const first = page.face.select(PROJECT, '20261003-alpha')
  await page.face.select(PROJECT, '20261003-beta')
  detail.release()
  timeline.release()
  await first
  assert.deepEqual(state().selected, { project: PROJECT, id: '20261003-beta' })
  assert.equal(state().detail.value?.id, '20261003-beta')
  assert.ok(state().timeline.lines.every(line => line.run === '20261003-beta'))
})

test('an answer for a run no longer selected is dropped: after back, which clears the run and its timeline', async () => {
  const { api, page, state } = make()
  await page.face.open()
  await page.face.select(PROJECT, '20261003-alpha')
  const detail = api.hold('run 20261003-beta')
  const timeline = api.hold('ledger 20261003-beta ')
  const selecting = page.face.select(PROJECT, '20261003-beta')
  page.face.back()
  assert.equal(state().selected, undefined)
  assert.deepEqual(state().detail, { load: 'idle' })
  assert.deepEqual(state().timeline, { load: 'idle', lines: [], skipped: 0, more: 'idle', capped: false })
  detail.release()
  timeline.release()
  await selecting
  assert.equal(state().selected, undefined)
  assert.deepEqual(state().detail, { load: 'idle' })
  assert.deepEqual(state().timeline.lines, [])
  assert.equal(state().list.load, 'ready')
})

test('an older page asked for before the timeline was read again is dropped', async () => {
  const { api, page, state } = make()
  await page.face.select(PROJECT, '20261003-beta')
  const older = api.hold(`ledger 20261003-beta ${TIMELINE_PAGE}`)
  const loading = page.face.loadOlder()
  assert.equal(state().timeline.more, 'loading')
  await page.face.refresh()
  older.release()
  await loading
  assert.equal(state().timeline.lines.length, TIMELINE_PAGE)
  assert.equal(state().timeline.lines[0]!.fields.text, '20261003-beta 50')
  assert.equal(state().timeline.more, 'idle')
})

test('refresh and open read the list again, and the selected run and the first page of its timeline', async () => {
  const { api, page, state } = make()
  await page.face.select(PROJECT, '20261003-alpha')
  api.calls.length = 0
  api.ledgers.set('20261003-alpha', lines('20261003-alpha', 4))
  await page.face.refresh()
  assert.deepEqual([...api.calls].sort(), ['ledger 20261003-alpha  200 Acme/widget', 'run 20261003-alpha Acme/widget', 'runs'])
  assert.equal(state().timeline.lines.length, 4)
  api.calls.length = 0
  await page.face.open()
  assert.equal(api.calls.length, 3)
})

test('the run and the timeline keep what they showed while they are read again', async () => {
  const { api, page, state } = make()
  await page.face.select(PROJECT, '20261003-alpha')
  const detail = api.hold('run 20261003-alpha')
  const refreshing = page.face.refresh()
  assert.equal(state().detail.load, 'loading')
  assert.equal(state().detail.value?.id, '20261003-alpha')
  assert.equal(state().timeline.lines.length, 3)
  detail.release()
  await refreshing
  assert.equal(state().detail.load, 'ready')
})

test('a refusal becomes a notice with the server\'s message: the run, and its timeline, each by itself', async () => {
  const { api, page, state } = make()
  await page.face.select(PROJECT, '20261003-nothing')
  assert.equal(state().detail.load, 'error')
  assert.equal(state().detail.value, undefined)
  const notice = state().detail.error!
  assert.ok(`${notice.text} ${notice.detail ?? ''}`.includes(`no run ${PROJECT}/20261003-nothing`), JSON.stringify(notice))

  api.refusals.set('ledger 20261003-alpha ', { code: 'INVALID', message: 'before must be the next of a page that read gave' })
  await page.face.select(PROJECT, '20261003-alpha')
  assert.equal(state().detail.load, 'ready')
  assert.equal(state().timeline.load, 'error')
  assert.ok(`${state().timeline.error!.text} ${state().timeline.error!.detail ?? ''}`.includes('before must be the next of a page that read gave'))
})

test('a refresh whose carrier fails keeps the run and its timeline in view, with the error; the next read that works clears it', async () => {
  const { api, page, state } = make()
  await page.face.select(PROJECT, '20261003-alpha')
  api.down.add('run 20261003-alpha')
  api.down.add('ledger 20261003-alpha ')
  await page.face.refresh()
  const failed = state()
  assert.equal(failed.detail.load, 'error')
  assert.equal(failed.detail.value?.id, '20261003-alpha')
  assert.deepEqual(failed.detail.error, { text: 'Something went wrong talking to dish-orchestrator', detail: 'gateway offline' })
  assert.equal(failed.timeline.load, 'error')
  assert.deepEqual(failed.timeline.lines.map(line => line.fields.text), ['20261003-alpha 0', '20261003-alpha 1', '20261003-alpha 2'])
  assert.deepEqual(failed.timeline.error, { text: 'Something went wrong talking to dish-orchestrator', detail: 'gateway offline' })
  assert.deepEqual(failed.selected, { project: PROJECT, id: '20261003-alpha' })

  api.down.clear()
  await page.face.refresh()
  assert.equal(state().detail.load, 'ready')
  assert.equal(state().detail.error, undefined)
  assert.equal(state().timeline.load, 'ready')
  assert.equal(state().timeline.error, undefined)
  assert.equal(state().timeline.lines.length, 3)
})

test('a timeline kept after a refresh that failed on the way still loads older pages', async () => {
  const { api, page, state } = make()
  await page.face.select(PROJECT, '20261003-beta')
  api.down.add('ledger 20261003-beta ')
  await page.face.refresh()
  assert.equal(state().timeline.load, 'error')
  assert.equal(state().timeline.lines.length, TIMELINE_PAGE)
  assert.equal(state().timeline.next, String(TIMELINE_PAGE))
  await page.face.loadOlder()
  assert.equal(state().timeline.lines.length, 250)
  assert.equal(state().timeline.lines[0]!.fields.text, '20261003-beta 0')
  assert.equal(state().timeline.next, undefined)
})

test('a refresh whose remote throws keeps what was shown too: it is the page\'s own failure, not the server\'s', async () => {
  const { api, page, state } = make()
  await page.face.select(PROJECT, '20261003-beta')
  await page.face.loadOlder()
  const run = api.run.bind(api)
  const ledger = api.ledger.bind(api)
  api.run = async () => { throw new Error('boom') }
  api.ledger = async () => { throw new Error('bang') }
  await page.face.refresh()
  assert.equal(state().detail.value?.id, '20261003-beta')
  assert.equal(state().detail.error?.detail, 'boom')
  assert.equal(state().timeline.lines.length, 250)
  assert.equal(state().timeline.error?.detail, 'bang')
  api.run = run
  api.ledger = ledger
})

test('a refresh the server refuses drops the run and its timeline: the record is gone (set aside), and the refusal says so', async () => {
  const { api, page, state } = make()
  await page.face.select(PROJECT, '20261003-alpha')
  api.refusals.set('run 20261003-alpha', { code: 'NOT_FOUND', message: `no run ${PROJECT}/20261003-alpha` })
  api.refusals.set('ledger 20261003-alpha ', { code: 'NOT_FOUND', message: `no run ${PROJECT}/20261003-alpha` })
  await page.face.refresh()
  assert.equal(state().detail.load, 'error')
  assert.equal(state().detail.value, undefined)
  assert.equal(state().detail.error?.detail, `no run ${PROJECT}/20261003-alpha`)
  assert.equal(state().timeline.load, 'error')
  assert.deepEqual(state().timeline.lines, [])
  assert.equal(state().timeline.next, undefined)
  assert.equal(state().timeline.error?.detail, `no run ${PROJECT}/20261003-alpha`)
})

test('a carrier that fails is said as the page\'s own failure, for the list, the run, the timeline and an older page', async () => {
  const { api, page, state } = make()
  api.down.add('runs')
  await page.face.open()
  assert.equal(state().list.load, 'error')
  assert.deepEqual(state().list.error, { text: 'Something went wrong talking to dish-orchestrator', detail: 'gateway offline' })
  api.down.delete('runs')
  await page.face.refresh()
  assert.equal(state().list.load, 'ready')
  assert.equal(state().list.error, undefined)

  api.down.add('run 20261003-beta')
  await page.face.select(PROJECT, '20261003-beta')
  assert.equal(state().detail.load, 'error')
  assert.equal(state().detail.error?.text, 'Something went wrong talking to dish-orchestrator')
  assert.equal(state().timeline.load, 'ready')

  api.down.add(`ledger 20261003-beta ${TIMELINE_PAGE}`)
  await page.face.loadOlder()
  const shown = state().timeline
  assert.equal(shown.more, 'idle')
  assert.equal(shown.moreError?.text, 'Something went wrong talking to dish-orchestrator')
  assert.equal(shown.lines.length, TIMELINE_PAGE)
  assert.equal(shown.next, String(TIMELINE_PAGE))
  api.down.delete(`ledger 20261003-beta ${TIMELINE_PAGE}`)
  await page.face.loadOlder()
  assert.equal(state().timeline.moreError, undefined)
  assert.equal(state().timeline.lines.length, 250)
})

test('a remote that throws is a failure too, never a throw out of the page', async () => {
  const api = new FakeRuns()
  api.runs = async () => { throw new Error('boom') }
  const { page, state } = make(api)
  await page.face.open()
  assert.deepEqual(state().list.error, { text: 'Something went wrong talking to dish-orchestrator', detail: 'boom' })
})

test('one older page at a time', async () => {
  const { api, page } = make()
  await page.face.select(PROJECT, '20261003-beta')
  const older = api.hold(`ledger 20261003-beta ${TIMELINE_PAGE}`)
  const first = page.face.loadOlder()
  const second = page.face.loadOlder()
  older.release()
  await Promise.all([first, second])
  assert.equal(api.calls.filter(call => call.startsWith(`ledger 20261003-beta ${TIMELINE_PAGE}`)).length, 1)
})

test('dispose: an answer still out changes nothing when it lands, and nothing new is asked', async () => {
  const { api, page, state } = make()
  await page.face.open()
  const list = api.hold('runs')
  const detail = api.hold('run 20261003-alpha')
  const timeline = api.hold('ledger 20261003-alpha ')
  const refreshing = page.face.refresh()
  const selecting = page.face.select(PROJECT, '20261003-alpha')
  const before = state()
  page.dispose()
  api.rows = [row('20261003-other')]
  list.release()
  detail.release()
  timeline.release()
  await Promise.all([refreshing, selecting])
  await settle()
  assert.equal(state(), before)
  const asked = api.calls.length
  await page.face.open()
  await page.face.select(PROJECT, '20261003-beta')
  await page.face.loadOlder()
  page.face.back()
  assert.equal(api.calls.length, asked)
  assert.equal(state(), before)
})
