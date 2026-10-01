import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime, assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import * as plugin from '../src/index.ts'
import { ConfigStoreError } from '../src/store/errors.ts'
import { NamespaceRegistry } from '../src/store/namespaces.ts'
import type { NamespaceSpec } from '../src/store/namespaces.ts'
import { ConfigStore } from '../src/store/store.ts'
import { toolDefinitions } from '../src/tools.ts'
import { AGENT, USER, USERA, ns, repoPath } from './helpers.ts'

const MAIN_ONLY = 'config tools are for the main agent only; ask the main agent to make this change'
const COMMIT = /^[0-9a-f]{40}$/
const TOKEN = `ghp_${'a'.repeat(36)}`

const opened: ConfigStore[] = []
after(async () => {
  await Promise.all(opened.splice(0).map(store => store.close().catch(() => {})))
})

/** The calling agent as the tools see it: `exec.agent.session.header`, as dsh builds it (a top-level session has no `delegationDepth`). */
function agent(sessionId: string, delegationDepth?: number, more: { origin?: string, options?: Record<string, unknown> } = {}): ToolRunContext {
  const { options, ...extra } = more
  const header = { id: sessionId, ...(delegationDepth === undefined ? {} : { delegationDepth }), ...extra }
  return { agent: { id: sessionId, session: { header }, ...(options === undefined ? {} : { options }) } } as unknown as ToolRunContext
}

/** A top-level agent in session `sessionId`, with an explicit depth of zero. */
const main = (sessionId = 'sess-main'): ToolRunContext => agent(sessionId, 0)
/** A subagent: one delegation below the main agent. */
const child = (sessionId = 'sess-child'): ToolRunContext => agent(sessionId, 1)
/** A call with no agent at all. */
const anonymous = (): ToolRunContext => ({}) as unknown as ToolRunContext

const SPECS: NamespaceSpec[] = [
  ns('t/', 'write'),
  ns('p/', 'propose'),
  ns('secret/', 'none'),
  ns('crew.yaml', 'write'),
]

type Call = (name: string, args: Record<string, unknown>, exec?: ToolRunContext) => Promise<any>

interface Setup {
  store: ConfigStore
  registry: NamespaceRegistry
  tools: ToolDefinition[]
  call: Call
}

/** A real store in a temp repository, the four tools over it, and a `call` that runs one the way dsh would (arguments validated). */
async function setup(claims: NamespaceSpec[] = SPECS): Promise<Setup> {
  const registry = new NamespaceRegistry()
  for (const spec of claims) registry.claim(spec)
  const store = await ConfigStore.open({ repository: await repoPath(), namespaces: registry, user: USER, agent: AGENT })
  opened.push(store)
  const tools = toolDefinitions(store, registry)
  const call: Call = (name, args, exec = main()) => {
    const tool = tools.find(candidate => candidate.name === name)
    assert.ok(tool, `no tool named ${name}`)
    return tool.execute(args, exec)
  }
  return { store, registry, tools, call }
}

/** For `assert.rejects`: the tool's own error, a plain `Error` whose message starts with the store's code. */
function failsWith(code: string, ...absent: string[]): (error: unknown) => boolean {
  return error => {
    assert.ok(error instanceof Error, `expected an Error, got ${String(error)}`)
    assert.ok(!(error instanceof ConfigStoreError), 'the model gets a plain Error, with the code in its message')
    assert.ok(error.message.startsWith(`${code}: `), `expected ${code}: ..., got ${error.message}`)
    for (const text of absent) assert.ok(!error.message.includes(text), `the message must not carry ${JSON.stringify(text)}: ${error.message}`)
    return true
  }
}

function refused(message = MAIN_ONLY): (error: unknown) => boolean {
  return error => {
    assert.ok(error instanceof Error)
    assert.equal(error.message, message)
    return true
  }
}

// --- the definitions ----------------------------------------------------------------------------

test('there are exactly four tools, whose output schemas the tool registry accepts, and whose descriptions state the policy', async () => {
  const { tools } = await setup()
  assert.deepEqual(tools.map(tool => tool.name), ['config_read', 'config_list', 'config_write', 'config_propose'])
  for (const tool of tools) {
    // What `ctx.tools.register` checks: a JSON-Schema `required` array in the output would fail the plugin's load.
    assert.doesNotThrow(() => assertSupportedJsonSchema(tool.output.schema as never), tool.name)
    assert.ok(tool.description.length > 40, tool.name)
  }
  const description = (name: string): string => tools.find(tool => tool.name === name)!.description
  const write = description('config_write')
  assert.match(write, /asked/)
  assert.match(write, /this conversation/)
  assert.match(write, /config_propose/)
  assert.match(write, /config_read/)
  assert.match(write, /`base`/)
  assert.match(write, /CONFLICT/)
  const propose = description('config_propose')
  assert.match(propose, /initiate/)
  assert.match(propose, /STALE/)
  assert.match(description('config_read'), /`commit`/)
  assert.match(description('config_read'), /oldest/)
  // The `base` parameter: the oldest commit when several documents were read, and the commit a write returned for the next one.
  const base = JSON.stringify((tools.find(tool => tool.name === 'config_write')!.parameters as { properties: Record<string, unknown> }).properties.base)
  assert.match(base, /oldest/)
  assert.match(base, /returned/)
  assert.match(description('config_list'), /closed to agents/)
})

// --- config_write -------------------------------------------------------------------------------

test('config_write commits as the main agent of its session, with the note, and says what it committed', async () => {
  const { store, call } = await setup()
  const result = await call('config_write', { changes: [{ path: 't/a.md', text: 'hello' }], note: 'the user asked' }, main('sess-1'))
  assert.match(result.commit, COMMIT)
  assert.deepEqual(result.paths, ['t/a.md'])
  const [commit] = await store.history({ limit: 1 })
  assert.equal(commit!.id, result.commit)
  assert.deepEqual(commit!.author, { kind: 'agent', sessionId: 'sess-1', role: 'main' })
  assert.equal(commit!.note, 'the user asked')
  assert.equal(await store.read('t/a.md'), 'hello')
})

test('config_write takes several changes, deletions included, as one commit', async () => {
  const { store, call } = await setup()
  await store.write([{ path: 't/old.md', text: 'old' }], { author: USERA })
  const before = await store.head()
  const result = await call('config_write', { changes: [{ path: 't/old.md', delete: true }, { path: 't/new.md', text: 'new' }, { path: 'crew.yaml', text: '' }] })
  assert.deepEqual(result.paths, ['crew.yaml', 't/new.md', 't/old.md'])
  assert.notEqual(await store.head(), before)
  assert.equal(await store.read('t/old.md'), undefined)
  assert.equal(await store.read('t/new.md'), 'new')
  // An empty text is an empty document, not a missing one.
  assert.equal(await store.read('crew.yaml'), '')
})

test('config_write with a no-op change makes no commit and says so', async () => {
  const { store, call } = await setup()
  await store.write([{ path: 't/a.md', text: 'same' }], { author: USERA })
  const head = await store.head()
  assert.deepEqual(await call('config_write', { changes: [{ path: 't/a.md', text: 'same' }] }), { commit: null, paths: [] })
  assert.equal(await store.head(), head)
})

test('config_write needs no base, and overwrites what is there', async () => {
  const { store, call } = await setup()
  await store.write([{ path: 't/a.md', text: 'user' }], { author: USERA })
  const result = await call('config_write', { changes: [{ path: 't/a.md', text: 'agent' }] })
  assert.match(result.commit, COMMIT)
  assert.equal(await store.read('t/a.md'), 'agent')
})

// --- config_read / base -------------------------------------------------------------------------

test('config_read returns the text and the commit it read, and null for a document that is not there', async () => {
  const { store, call } = await setup()
  const info = await store.write([{ path: 't/a.md', text: 'hello\nworld\n' }], { author: USERA })
  assert.deepEqual(await call('config_read', { path: 't/a.md' }), { path: 't/a.md', text: 'hello\nworld\n', commit: info!.id })
  assert.deepEqual(await call('config_read', { path: 't/missing.md' }), { path: 't/missing.md', text: null, commit: info!.id })
  // An empty document is not a missing one.
  await store.write([{ path: 't/empty.md', text: '' }], { author: USERA })
  const empty = await call('config_read', { path: 't/empty.md' })
  assert.equal(empty.text, '')
  assert.equal(empty.commit, await store.head())
})

test('a change made in the UI after config_read turns the agent\'s write with that base into CONFLICT, and overwrites nothing', async () => {
  const { store, call } = await setup()
  await store.write([{ path: 't/a.md', text: 'v1' }, { path: 't/b.md', text: 'b1' }], { author: USERA })
  const read = await call('config_read', { path: 't/a.md' })
  // The user edits the same document in the UI.
  const edit = await store.write([{ path: 't/a.md', text: 'user edit' }], { author: USERA })

  await assert.rejects(call('config_write', { changes: [{ path: 't/a.md', text: 'agent edit' }], base: read.commit }), failsWith('CONFLICT', 'user edit', 'agent edit'))
  assert.equal(await store.read('t/a.md'), 'user edit')
  assert.equal(await store.head(), edit!.id)

  // A change to a different path since the read is no conflict.
  const ok = await call('config_write', { changes: [{ path: 't/b.md', text: 'b2' }], base: read.commit })
  assert.match(ok.commit, COMMIT)
  assert.equal(await store.read('t/b.md'), 'b2')
  assert.equal(await store.read('t/a.md'), 'user edit')

  // After a re-read, the redo goes through.
  const again = await call('config_read', { path: 't/a.md' })
  assert.equal(again.text, 'user edit')
  assert.ok((await call('config_write', { changes: [{ path: 't/a.md', text: 'agent edit' }], base: again.commit })).commit)
  assert.equal(await store.read('t/a.md'), 'agent edit')
})

test('a base that is not a commit is refused with its code', async () => {
  const { store, call } = await setup()
  await store.write([{ path: 't/a.md', text: 'v1' }], { author: USERA })
  await store.write([{ path: 't/a.md', text: 'v2' }], { author: USERA })
  await assert.rejects(call('config_write', { changes: [{ path: 't/a.md', text: 'x' }], base: 'abc1234' }), failsWith('NOT_FOUND'))
  assert.equal(await store.read('t/a.md'), 'v2')
})

// --- the main agent only ------------------------------------------------------------------------

const CALLS: Array<[string, Record<string, unknown>]> = [
  ['config_read', { path: 't/a.md' }],
  ['config_list', { prefix: 't/' }],
  ['config_write', { changes: [{ path: 't/a.md', text: 'x' }] }],
  ['config_propose', { title: 'a title', rationale: 'because', changes: [{ path: 't/a.md', text: 'x' }] }],
]

test('a child agent is refused by every tool, and nothing is read or written', async () => {
  const { store, call } = await setup()
  await store.write([{ path: 't/a.md', text: 'v1' }], { author: USERA })
  const head = await store.head()
  for (const [name, args] of CALLS) {
    await assert.rejects(call(name, args, child()), refused(), name)
    await assert.rejects(call(name, args, agent('deep', 2)), refused(), name)
  }
  assert.equal(await store.head(), head)
  assert.deepEqual(await store.proposals(), [])
})

test('a call with no agent at all is refused the same way', async () => {
  const { call } = await setup()
  for (const [name, args] of CALLS) {
    await assert.rejects(call(name, args, anonymous()), refused(), name)
  }
})

test('an agent that dsh marks as a subagent in any other way is refused too: runtime subagentDepth, or origin "subagent"', async () => {
  const { store, call } = await setup()
  const head = await store.head()
  const marked: Array<[string, ToolRunContext]> = [
    ['options.subagentDepth 1', agent('s', undefined, { options: { subagentDepth: 1 } })],
    ['options.subagentDepth 1, header depth 0', agent('s', 0, { options: { subagentDepth: 1 } })],
    ['options.subagentDepth 2', agent('s', 0, { options: { subagentDepth: 2 } })],
    ['options.subagentDepth garbage', agent('s', 0, { options: { subagentDepth: 'one' } })],
    ['header origin subagent', agent('s', undefined, { origin: 'subagent' })],
    ['header origin subagent, depth 0', agent('s', 0, { origin: 'subagent' })],
  ]
  for (const [what, exec] of marked) {
    for (const [name, args] of CALLS) await assert.rejects(call(name, args, exec), refused(), `${name}: ${what}`)
  }
  assert.equal(await store.head(), head)
  assert.deepEqual(await store.proposals(), [])
  // Zero runtime depth, or other options, are the main agent.
  const ok = await call('config_write', { changes: [{ path: 't/a.md', text: 'x' }] }, agent('s', undefined, { options: { subagentDepth: 0, model: 'm' } }))
  assert.match(ok.commit, COMMIT)
})

test('a top-level agent whose header has no delegationDepth is the main agent', async () => {
  const { call } = await setup()
  const result = await call('config_write', { changes: [{ path: 't/a.md', text: 'x' }] }, agent('sess-top', undefined))
  assert.match(result.commit, COMMIT)
})

test('the main-agent check comes before the arguments are looked at', async () => {
  const { call } = await setup()
  // A malformed change from a child is still just "main agent only".
  await assert.rejects(call('config_write', { changes: [{ path: 't/a.md', text: 'x', delete: true }] }, child()), refused())
})

// --- config_propose and the agent policy --------------------------------------------------------

test('config_propose opens a proposal authored as the main agent, and says which', async () => {
  const { store, call } = await setup()
  const result = await call('config_propose', {
    title: 'Tighten the intro',
    rationale: 'It rambles.',
    changes: [{ path: 't/a.md', text: 'short' }, { path: 'crew.yaml', text: 'x: 1\n' }],
  }, main('sess-9'))
  assert.match(result.proposal, /^[0-9a-f]{8}$/)
  assert.deepEqual(result.paths, ['crew.yaml', 't/a.md'])
  const [proposal] = await store.proposals()
  assert.equal(proposal!.id, result.proposal)
  assert.equal(proposal!.title, 'Tighten the intro')
  assert.equal(proposal!.rationale, 'It rambles.')
  assert.deepEqual(proposal!.author, { kind: 'agent', sessionId: 'sess-9', role: 'main' })
  assert.equal(proposal!.status, 'open')
  // Nothing reached main.
  assert.equal(await store.read('t/a.md'), undefined)
})

test('in a propose-only namespace config_write is FORBIDDEN and config_propose works; reading is allowed', async () => {
  const { store, call } = await setup()
  await store.write([{ path: 'p/direction.md', text: 'old' }], { author: USERA })
  const head = await store.head()
  const forbidden = await call('config_write', { changes: [{ path: 'p/direction.md', text: 'new' }] }).then(() => undefined, (error: unknown) => error)
  assert.match((forbidden as Error).message, /^FORBIDDEN: .*allows agents to "propose" only/)
  assert.equal(await store.head(), head)

  const proposed = await call('config_propose', { title: 'New direction', rationale: 'Because.', changes: [{ path: 'p/direction.md', text: 'new' }] })
  assert.match(proposed.proposal, /^[0-9a-f]{8}$/)
  assert.equal(await store.read('p/direction.md'), 'old')

  assert.equal((await call('config_read', { path: 'p/direction.md' })).text, 'old')
  assert.deepEqual((await call('config_list', { prefix: 'p/' })).paths, ['p/direction.md'])
})

test('an agent can neither write nor propose in a namespace it has none of, nor outside every namespace', async () => {
  const { store, call } = await setup()
  const head = await store.head()
  await assert.rejects(call('config_write', { changes: [{ path: 'secret/k.md', text: 'x' }] }), failsWith('FORBIDDEN'))
  await assert.rejects(call('config_propose', { title: 'a title', rationale: '', changes: [{ path: 'secret/k.md', text: 'x' }] }), failsWith('FORBIDDEN'))
  // The message says what is so: "none" is not something an agent is allowed to do.
  const none = await call('config_write', { changes: [{ path: 'secret/k.md', text: 'x' }] }).then(() => undefined, (error: unknown) => error)
  assert.match((none as Error).message, /closed to agents/)
  assert.doesNotMatch((none as Error).message, /allows agents to/)
  await assert.rejects(call('config_write', { changes: [{ path: 'nowhere/x.md', text: 'x' }] }), failsWith('UNOWNED'))
  assert.equal(await store.head(), head)
  assert.deepEqual(await store.proposals(), [])
})

test('config_propose takes an empty rationale as the store does, and refuses a title the store refuses', async () => {
  const { call } = await setup()
  assert.match((await call('config_propose', { title: 'No reasons', rationale: '', changes: [{ path: 't/a.md', text: 'x' }] })).proposal, /^[0-9a-f]{8}$/)
  await assert.rejects(call('config_propose', { title: '  ', rationale: '', changes: [{ path: 't/b.md', text: 'x' }] }), failsWith('INVALID'))
})

// --- reading under the policy -------------------------------------------------------------------

test('config_read on a namespace that is none for agents is FORBIDDEN, whether or not the document exists, and on an unowned path UNOWNED', async () => {
  const { store, call } = await setup()
  await store.write([{ path: 'secret/k.md', text: 'the launch codes' }], { author: USERA })
  await assert.rejects(call('config_read', { path: 'secret/k.md' }), failsWith('FORBIDDEN', 'the launch codes'))
  // No telling a document that is there from one that is not.
  await assert.rejects(call('config_read', { path: 'secret/none.md' }), failsWith('FORBIDDEN'))
  await assert.rejects(call('config_read', { path: 'nowhere/x.md' }), failsWith('UNOWNED'))
})

test('config_read on something that cannot be a path is INVALID with the reason, as a write says, not UNOWNED', async () => {
  const { call } = await setup()
  const cases: Array<[string, RegExp]> = [
    ['/t/a.md', /absolute/],
    ['t/', /ends with a slash/],
    ['t//a.md', /empty segment/],
    ['t/../a.md', /"\.\." segment/],
    ['../etc/passwd', /"\.\." segment/],
    ['', /empty/],
    ['t\\a.md', /backslash/],
    ['t/a\n.md', /control character/],
  ]
  for (const [path, reason] of cases) {
    await assert.rejects(call('config_read', { path }), error => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /^INVALID: invalid path /, JSON.stringify(path))
      assert.match(error.message, reason, JSON.stringify(path))
      assert.doesNotMatch(error.message, /UNOWNED|owns/, JSON.stringify(path))
      return true
    })
  }
  // Even where it is in a closed namespace: the shape of a path tells nothing about what exists.
  await assert.rejects(call('config_read', { path: 'secret/' }), failsWith('INVALID'))
})

test('config_list hides what agents may not touch, filters by prefix, and says which commit it listed', async () => {
  const { store, call } = await setup()
  const info = await store.write([
    { path: 't/a.md', text: '1' },
    { path: 't/sub/b.md', text: '2' },
    { path: 'p/c.md', text: '3' },
    { path: 'secret/d.md', text: '4' },
    { path: 'crew.yaml', text: '5' },
  ], { author: USERA })
  const all = await call('config_list', { prefix: '' })
  assert.deepEqual(all, { paths: ['crew.yaml', 'p/c.md', 't/a.md', 't/sub/b.md'], commit: info!.id })
  assert.deepEqual((await call('config_list', { prefix: 't/' })).paths, ['t/a.md', 't/sub/b.md'])
  assert.deepEqual((await call('config_list', { prefix: 't' })).paths, ['t/a.md', 't/sub/b.md'])
  assert.deepEqual((await call('config_list', { prefix: 'crew.yaml' })).paths, ['crew.yaml'])
  // A prefix inside a hidden namespace lists nothing, and does not say there is something.
  assert.deepEqual((await call('config_list', { prefix: 'secret/' })).paths, [])
  assert.deepEqual((await call('config_list', { prefix: 'nothing/' })).paths, [])
})

test('config_list takes a leading slash as the root, and refuses a prefix that cannot be a path', async () => {
  const { store, call } = await setup()
  const info = await store.write([{ path: 't/a.md', text: '1' }, { path: 'p/c.md', text: '2' }, { path: 'crew.yaml', text: '3' }], { author: USERA })
  assert.deepEqual(await call('config_list', { prefix: '/' }), { paths: ['crew.yaml', 'p/c.md', 't/a.md'], commit: info!.id })
  assert.deepEqual((await call('config_list', { prefix: '/t/' })).paths, ['t/a.md'])
  assert.deepEqual((await call('config_list', { prefix: '/t' })).paths, ['t/a.md'])
  assert.deepEqual((await call('config_list', { prefix: '/crew.yaml' })).paths, ['crew.yaml'])
  for (const prefix of ['.', './', '..', '../t/', '//t/', 't//', 't/./', '\\', 't\\', 't/a\n']) {
    await assert.rejects(call('config_list', { prefix }), error => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /^INVALID: invalid prefix /, JSON.stringify(prefix))
      return true
    })
  }
  // A path-shaped prefix that matches nothing lists nothing: there are no wildcards.
  assert.deepEqual((await call('config_list', { prefix: '*' })).paths, [])
  assert.deepEqual((await call('config_list', { prefix: 't/*' })).paths, [])
})

test('config_list hides documents that no namespace owns any more', async () => {
  const { store, registry, call } = await setup()
  const release = registry.claim(ns('gone/', 'write'))
  await store.write([{ path: 'gone/x.md', text: '1' }, { path: 't/a.md', text: '2' }], { author: USERA })
  assert.deepEqual((await call('config_list', { prefix: '' })).paths, ['gone/x.md', 't/a.md'])
  release()
  assert.deepEqual((await call('config_list', { prefix: '' })).paths, ['t/a.md'])
  await assert.rejects(call('config_read', { path: 'gone/x.md' }), failsWith('UNOWNED'))
})

// --- empty strings and malformed changes --------------------------------------------------------

test('empty or blank optional strings count as absent: no note, no base', async () => {
  const { store, call } = await setup()
  const first = await call('config_write', { changes: [{ path: 't/a.md', text: 'one' }], note: '', base: '' })
  assert.match(first.commit, COMMIT)
  const second = await call('config_write', { changes: [{ path: 't/a.md', text: 'two' }], note: '  ', base: ' ' })
  assert.match(second.commit, COMMIT)
  const [latest, earlier] = await store.history({ limit: 2 })
  assert.equal(latest!.note, undefined)
  assert.equal(earlier!.note, undefined)
  assert.ok(!latest!.message.includes('Dish-Note'))
  assert.equal(await store.read('t/a.md'), 'two')
})

test('a base left empty cannot hide a conflict it never asked about, and a real base still can', async () => {
  const { store, call } = await setup()
  const info = await store.write([{ path: 't/a.md', text: 'v1' }], { author: USERA })
  await store.write([{ path: 't/a.md', text: 'v2' }], { author: USERA })
  // An empty base is no base: this overwrites, as a write without one does.
  assert.ok((await call('config_write', { changes: [{ path: 't/a.md', text: 'v3' }], base: '' })).commit)
  // A real, stale one conflicts.
  await assert.rejects(call('config_write', { changes: [{ path: 't/a.md', text: 'v4' }], base: info!.id }), failsWith('CONFLICT'))
})

/** A service that fails the test if a tool so much as touches it. */
function untouchable(): never {
  throw new Error('the store was called')
}
const forbiddenService = {
  head: untouchable,
  read: untouchable,
  list: untouchable,
  write: untouchable,
  propose: untouchable,
}

test('a change with a text and delete: true, or with neither, is refused before the store is called', async () => {
  const registry = new NamespaceRegistry()
  registry.claim(ns('t/', 'write'))
  const tools = toolDefinitions(forbiddenService, registry)
  const run = (name: string, args: Record<string, unknown>) => tools.find(tool => tool.name === name)!.execute(args, main())
  const bad: Array<Record<string, unknown>> = [
    { path: 't/a.md', text: 'x', delete: true },
    { path: 't/a.md', text: ' ', delete: true },
    { path: 't/a.md' },
    { path: 't/a.md', delete: false },
  ]
  for (const change of bad) {
    await assert.rejects(run('config_write', { changes: [{ path: 't/ok.md', text: 'fine' }, change] }), failsWith('INVALID', 'fine'), JSON.stringify(change))
    await assert.rejects(run('config_propose', { title: 'a title', rationale: 'why', changes: [change] }), failsWith('INVALID'), JSON.stringify(change))
  }
})

test('the malformed-change message names the change, never its text', async () => {
  const { call } = await setup()
  await assert.rejects(
    call('config_write', { changes: [{ path: 't/a.md', text: 'private words', delete: true }] }),
    error => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /^INVALID: /)
      assert.match(error.message, /t\/a\.md/)
      assert.match(error.message, /both `text` and `delete: true`/)
      assert.match(error.message, /to delete, send only `delete: true`/)
      assert.match(error.message, /to replace, send only `text`/)
      // Nothing that makes an empty text sound like a way to delete, or a way out.
      assert.doesNotMatch(error.message, /empty/)
      assert.ok(!error.message.includes('private words'))
      return true
    })
  await assert.rejects(
    call('config_write', { changes: [{ path: 't/a.md', delete: false }] }),
    error => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /^INVALID: /)
      assert.match(error.message, /neither `text` nor `delete: true`/)
      assert.doesNotMatch(error.message, /empty/)
      return true
    })
})

test('delete: true with an empty text is a delete, in a write and in a proposal; the document is not emptied', async () => {
  const { store, call } = await setup()
  await store.write([{ path: 't/a.md', text: 'one' }, { path: 't/b.md', text: 'two' }, { path: 't/c.md', text: 'three' }], { author: USERA })
  // A model that fills in every field: text '' and delete true.
  const removed = await call('config_write', { changes: [{ path: 't/a.md', text: '', delete: true }, { path: 't/b.md', delete: true }] })
  assert.deepEqual(removed.paths, ['t/a.md', 't/b.md'])
  assert.equal(await store.read('t/a.md'), undefined)
  assert.equal(await store.read('t/b.md'), undefined)
  // The same for a proposal: its tip lacks the document, rather than holding an empty one.
  const proposed = await call('config_propose', { title: 'Drop c', rationale: 'unused', changes: [{ path: 't/c.md', text: '', delete: true }] })
  const [proposal] = await store.proposals()
  assert.equal(proposal!.id, proposed.proposal)
  assert.equal(await store.read('t/c.md', proposal!.base), 'three')
  assert.equal(await store.read('t/c.md', proposal!.tip), undefined)
  // Deleting what is not there is still the store's NOT_FOUND.
  await assert.rejects(call('config_write', { changes: [{ path: 't/a.md', text: '', delete: true }] }), failsWith('NOT_FOUND'))
  // And an empty text alone still writes an empty document.
  await call('config_write', { changes: [{ path: 't/c.md', text: '' }] })
  assert.equal(await store.read('t/c.md'), '')
})

test('text alone may be empty, and delete: false beside a text is just a write', async () => {
  const { store, call } = await setup()
  await call('config_write', { changes: [{ path: 't/a.md', text: '' }] })
  assert.equal(await store.read('t/a.md'), '')
  await call('config_write', { changes: [{ path: 't/b.md', text: 'b', delete: false }] })
  assert.equal(await store.read('t/b.md'), 'b')
  await call('config_write', { changes: [{ path: 't/b.md', delete: true }] })
  assert.equal(await store.read('t/b.md'), undefined)
  // Deleting what is not there is the store's NOT_FOUND.
  await assert.rejects(call('config_write', { changes: [{ path: 't/b.md', delete: true }] }), failsWith('NOT_FOUND'))
})

test('arguments that break the schema are refused by the tool, with no commit', async () => {
  const { store, call } = await setup()
  const head = await store.head()
  await assert.rejects(call('config_write', { changes: 'not a list' }))
  await assert.rejects(call('config_write', { changes: [{ text: 'no path' }] }))
  await assert.rejects(call('config_write', { changes: [{ path: 't/a.md', text: 'x', extra: 1 }] }))
  await assert.rejects(call('config_read', {}))
  assert.equal(await store.head(), head)
})

// --- errors -------------------------------------------------------------------------------------

test('a secret in text is SECRET, and the message does not echo it', async () => {
  const { store, call } = await setup()
  const head = await store.head()
  const text = `password: hunter2\ntoken: ${TOKEN}\n`
  await assert.rejects(call('config_write', { changes: [{ path: 't/a.md', text }] }), failsWith('SECRET', TOKEN, 'hunter2'))
  await assert.rejects(call('config_propose', { title: 'a title', rationale: 'why', changes: [{ path: 't/a.md', text }] }), failsWith('SECRET', TOKEN, 'hunter2'))
  // Nor in a note, a title or a rationale.
  await assert.rejects(call('config_write', { changes: [{ path: 't/a.md', text: 'x' }], note: `see ${TOKEN}` }), failsWith('SECRET', TOKEN))
  await assert.rejects(call('config_propose', { title: 'a title', rationale: `see ${TOKEN}`, changes: [{ path: 't/a.md', text: 'x' }] }), failsWith('SECRET', TOKEN))
  assert.equal(await store.head(), head)
  assert.deepEqual(await store.proposals(), [])
})

test('a store error reaches the model as a plain Error that starts with its code and keeps the store\'s message', async () => {
  const { call } = await setup()
  const caught = await call('config_write', { changes: [{ path: 'secret/k.md', text: 'x' }] }).then(() => undefined, (error: unknown) => error)
  assert.ok(caught instanceof Error)
  assert.ok(!(caught instanceof ConfigStoreError))
  assert.match(caught.message, /^FORBIDDEN: .*secret\/k\.md/)
  assert.ok((caught.cause as ConfigStoreError | undefined) instanceof ConfigStoreError)
})

test('a failure that is not one of the store\'s refusals passes through as it is', async () => {
  const { store, call } = await setup()
  await store.close()
  await assert.rejects(call('config_read', { path: 't/a.md' }), error => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /closed/)
    assert.doesNotMatch(error.message, /^[A-Z_]+: /)
    return true
  })
})

test('an agent whose session id the store cannot use as an author is INVALID', async () => {
  const { call } = await setup()
  await assert.rejects(call('config_write', { changes: [{ path: 't/a.md', text: 'x' }] }, main('has space')), failsWith('INVALID'))
})

// --- the plugin registers them --------------------------------------------------------------------

function load(ctx: Context, repository: string) {
  return ctx.plugin(plugin, { terminal: false, repository } as plugin.Config)
}

/** A context with a real tool registry (and a stub system prompt, which is all the registry needs of it). */
function withTools(): Context {
  const ctx = new Context()
  ctx.provide('systemPrompt', { tools() {}, section() {}, getSectionOrder: () => 1 } as never)
  return ctx
}

test('the plugin registers the tools when a tools service is there, and a call through the registry works end to end', async () => {
  const ctx = withTools()
  await ctx.plugin(ToolRuntime, {})
  const handle = load(ctx, await repoPath())
  await handle
  try {
    const service = ctx.dishConfig
    service.claim(ns('t/', 'write'))
    const signal = new AbortController().signal
    const valueOf = (result: unknown): unknown => (result as { value: unknown }).value
    const textOf = (result: { content: Array<{ type: string, text?: string }> }): string =>
      result.content.map(block => block.type === 'text' ? block.text ?? '' : '').join('\n')
    const run = (name: string, args: unknown, who: ToolRunContext) =>
      ctx.tools.execute({ callId: `c-${name}` as never, name, arguments: args, agent: who.agent, signal })

    const written = await run('config_write', { changes: [{ path: 't/a.md', text: 'hello' }], note: 'asked' }, main('sess-e2e'))
    assert.equal(written.isError, false)
    const value = written.isError ? undefined : (written as unknown as { value: { commit: string, paths: string[] } }).value
    assert.match(value!.commit, COMMIT)
    assert.deepEqual(value!.paths, ['t/a.md'])
    const [commit] = await service.history({ limit: 1 })
    assert.deepEqual(commit!.author, { kind: 'agent', sessionId: 'sess-e2e', role: 'main' })

    const read = await run('config_read', { path: 't/a.md' }, main('sess-e2e'))
    assert.equal(read.isError, false)
    const text = read.content.map(block => block.type === 'text' ? block.text : '').join('\n')
    assert.ok(text.includes('hello'))
    assert.ok(text.includes(value!.commit), 'the model is shown the full commit id to pass as base')

    // A missing document reads as null (the schema allows it), at the head it was read from.
    const missing = await run('config_read', { path: 't/none.md' }, main('sess-e2e'))
    assert.equal(missing.isError, false)
    assert.deepEqual(valueOf(missing), { path: 't/none.md', text: null, commit: value!.commit })
    assert.ok(textOf(missing).includes('does not exist'))

    // Listing: the paths an agent may see, and the commit.
    const listed = await run('config_list', { prefix: 't/' }, main('sess-e2e'))
    assert.equal(listed.isError, false)
    assert.deepEqual(valueOf(listed), { paths: ['t/a.md'], commit: value!.commit })
    assert.ok(textOf(listed).includes('t/a.md'))
    const none = await run('config_list', { prefix: 'nothing/' }, main('sess-e2e'))
    assert.equal(none.isError, false)
    assert.deepEqual(valueOf(none), { paths: [], commit: value!.commit })
    assert.match(textOf(none), /no documents/)

    // A proposal.
    const proposed = await run('config_propose', { title: 'Add c', rationale: 'It is missing.', changes: [{ path: 't/c.md', text: 'c' }] }, main('sess-e2e'))
    assert.equal(proposed.isError, false)
    const proposal = valueOf(proposed) as { proposal: string, paths: string[] }
    assert.match(proposal.proposal, /^[0-9a-f]{8}$/)
    assert.deepEqual(proposal.paths, ['t/c.md'])
    assert.ok(textOf(proposed).includes(proposal.proposal))
    assert.equal((await service.proposals('open'))[0]?.id, proposal.proposal)
    assert.equal(await service.read('t/c.md'), undefined)

    // A delete through the registry, the way a model fills the fields in.
    const deleted = await run('config_write', { changes: [{ path: 't/a.md', text: '', delete: true }], note: '', base: '' }, main('sess-e2e'))
    assert.equal(deleted.isError, false)
    assert.deepEqual((valueOf(deleted) as { paths: string[] }).paths, ['t/a.md'])
    assert.equal(await service.read('t/a.md'), undefined)
    // Put it back for what follows.
    await service.write([{ path: 't/a.md', text: 'hello' }], { author: USERA })

    // A child is refused through the registry too, with the message the model reads.
    const refusedCall = await run('config_write', { changes: [{ path: 't/b.md', text: 'x' }] }, child())
    assert.equal(refusedCall.isError, true)
    assert.ok(refusedCall.content.some(block => block.type === 'text' && block.text.includes(MAIN_ONLY)))
    assert.equal(await service.read('t/b.md'), undefined)

    // A no-op write renders as no change, not as a commit.
    const noop = await run('config_write', { changes: [{ path: 't/a.md', text: 'hello' }] }, main('sess-e2e'))
    assert.equal(noop.isError, false)
    assert.ok(noop.content.some(block => block.type === 'text' && /no change/i.test(block.text)))
  } finally {
    await handle.dispose()
  }
})

test('the store works without a tools service, and the tools are registered once one appears', async () => {
  const ctx = new Context()
  const handle = load(ctx, await repoPath())
  await handle
  try {
    assert.equal(ctx.get('tools'), undefined)
    assert.match(await ctx.dishConfig.head(), COMMIT)

    // Providing a tools service later registers the tools in it.
    const registered: string[] = []
    ctx.provide('tools', {
      register(definition: ToolDefinition) {
        registered.push(definition.name)
        return () => { registered.splice(registered.indexOf(definition.name), 1) }
      },
    } as never)
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual([...registered].sort(), ['config_list', 'config_propose', 'config_read', 'config_write'])
  } finally {
    await handle.dispose()
  }
})
