/**
 * The row's `agent/pre-step` listener, over scopes built as dsh builds them: the row mounted in a preset's scope, agents on
 * scopes of their own under it (`createScope`), and each step dispatched with `agentEvents(...).waterfall`. `dishMemory` is
 * a fake, but where the scopes are the point, a real service over a temporary vault. The session is a fake too: its
 * surface is the system prompt and the messages the steps entered, and what a compaction leaves is a surface without the
 * old message.
 */

import { mkdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import * as row from '../src/context.ts'
import { budgeted, identityOf, messageText } from '../src/format.ts'
import type { MemoryFile } from '../src/format.ts'
import type { Scopes } from '../src/service.ts'
import { ACME, AS_USER, BUDGET, MODIFIED, USER, input, memoryWorld, provideStub, tempDir, watchLogs } from './helpers.ts'

const disposables: Array<{ dispose(): unknown }> = []
after(async () => {
  for (const handle of disposables.splice(0).reverse()) await handle.dispose()
})

/** `value` as the service `name`, from a plugin of its own: a sibling of the row's, as dsh's and dish's services reach a preset row. */
async function provided(ctx: Context, name: string, value: unknown): Promise<void> {
  const stub = provideStub(ctx, name, value)
  await stub
  disposables.push(stub)
}

// --- messages and sessions ------------------------------------------------------------------------

function typed(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/** A `dish-memory` message as the row makes one. */
function memoryMessage(identity: string, text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'dish-memory', form: 'instructions', identity } })
}

function textOf(message: UserMessage): string {
  return message.content.map(block => block.type === 'text' ? block.text : '').join('')
}

/** The step's messages, for a decision that enters. */
function entered(decision: PreStepDecision): UserMessage[] {
  assert.equal(decision.kind, 'enter')
  return (decision as { messages: UserMessage[] }).messages
}

/** The `dish-memory` messages among `messages`. */
function delivered(messages: readonly UserMessage[]): UserMessage[] {
  return messages.filter(message => message.source.kind === 'dish-memory')
}

interface LogEvent { type: string, seq: number, data: unknown }

/** A session as the listener reads it: a header, the events of its log, and its surface, the seqs the model sees. */
class FakeSession {
  header: Record<string, unknown>
  events: LogEvent[] = []
  nodes: number[] = []

  constructor(header: Record<string, unknown>) {
    this.header = header
    // The rendered system prompt is surface node 0, before any user message.
    this.append('system/message', { role: 'system', content: [], source: { kind: 'system-prompt' } })
  }

  get surface(): { nodes: readonly number[] } {
    return { nodes: this.nodes }
  }

  eventAt(seq: number): LogEvent | undefined {
    return this.events[seq]
  }

  append(type: string, data: unknown): void {
    const seq = this.events.length
    this.events.push({ type, seq, data })
    this.nodes.push(seq)
  }

  /** What the loop does with a step that enters: each message is a `user/message` on the surface, and the model answers. */
  enter(messages: readonly UserMessage[]): void {
    for (const message of messages) this.append('user/message', message)
    this.append('assistant/message', { role: 'assistant', content: [{ type: 'text', text: 'Done.' }], source: { kind: 'model' } })
  }

  /** What a compaction leaves: the system prompt, then one summary in place of everything after it. The log keeps the rest. */
  compact(): void {
    this.nodes = [this.nodes[0]!]
    this.append('user/message', typed('A summary of the conversation so far.'))
  }
}

interface TestAgent { id: string, session: FakeSession, options: object }

// --- a fake dishMemory ----------------------------------------------------------------------------

function memoryFile(name: string): MemoryFile {
  return { name, description: `About ${name}`, type: 'feedback', modified: MODIFIED, body: `What ${name} says.` }
}

interface FakeMemory {
  /** Each agent's scopes, by id. An agent not listed is the main agent of a scratch chat. */
  scopes: Map<string, Scopes>
  /** The user's memories, by name. */
  user: string[]
  /** Each family's memories, by name. */
  families: Map<string, string[]>
  /** What makes a call fail. */
  failing: { scopesFor?: Error, compose?: Error }
  /** Who `scopesFor` was asked about, and the identities `compose` was asked for, in order. */
  calls: { scopesFor: string[], compose: string[] }
  /** The options each `compose` was given, in order. */
  options: Array<{ complete?: boolean } | undefined>
  scopesFor(agent: { id: unknown }): Promise<Scopes>
  compose(scopes: Scopes, options?: { complete?: boolean }): Promise<string | undefined>
}

/** The message the fake composes for `scopes`: the real format, over its memories, with no direction and no repos. */
function composed(fake: FakeMemory, scopes: Scopes): string | undefined {
  const family = scopes.family
  return messageText({
    repos: [],
    ...scopes.user ? { user: budgeted(fake.user.map(memoryFile), 'user', BUDGET) } : {},
    ...family === undefined ? {} : { family, familyMemory: budgeted((fake.families.get(family) ?? []).map(memoryFile), 'family', BUDGET) },
  })
}

function fakeMemory(options: { user?: string[], families?: Record<string, string[]>, scopes?: Record<string, Scopes> } = {}): FakeMemory {
  const fake: FakeMemory = {
    scopes: new Map(Object.entries(options.scopes ?? {})),
    user: options.user ?? [],
    families: new Map(Object.entries(options.families ?? {})),
    failing: {},
    calls: { scopesFor: [], compose: [] },
    options: [],
    async scopesFor(agent) {
      fake.calls.scopesFor.push(String(agent.id))
      if (fake.failing.scopesFor !== undefined) throw fake.failing.scopesFor
      return { ...fake.scopes.get(String(agent.id)) ?? { user: true } }
    },
    async compose(scopes, options) {
      fake.calls.compose.push(identityOf(scopes))
      fake.options.push(options)
      if (fake.failing.compose !== undefined) throw fake.failing.compose
      return composed(fake, scopes)
    },
  }
  return fake
}

// --- the world --------------------------------------------------------------------------------------

interface World {
  ctx: Context
  /** Every line logged in the context, as `[name] type: text`. */
  logs: string[]
  /** The preset's scope key, which the row is mounted under. */
  preset: object
  /** A plugin with the tools service injected, which agents' scopes are minted on, as dsh's agent loop does. */
  owner: Context
  /** An agent on a scope of its own under `parent` (the preset, unless given; `null` for none), working in `/w` unless the header says. */
  agent(id: string, header?: Record<string, unknown>, parent?: object | null): TestAgent
  /** One step's pre-step: the rest of the waterfall answers `decision`, which enters `messages` unless given. */
  step(agent: TestAgent, messages: UserMessage[], options?: { step?: number, decision?: PreStepDecision }): Promise<PreStepDecision>
  /** A step, then what the loop does with it: the messages it entered go on the surface. */
  turn(agent: TestAgent, messages: UserMessage[], step?: number): Promise<PreStepDecision>
}

/** The row in a preset's scope, with `memory` as `dishMemory` (none when it's `undefined`), and a stub of the tool registry. */
async function world(memory: unknown): Promise<World> {
  const ctx = new Context()
  const logs = watchLogs(ctx)
  await provided(ctx, 'tools', { register: () => () => {} })
  if (memory !== undefined) await provided(ctx, 'dishMemory', memory)
  let owner!: Context
  disposables.push(await ctx.plugin({ name: 'scope-owner', inject: ['tools'], apply(own: Context) { owner = own } } as never, undefined as never) as unknown as { dispose(): unknown })
  // Mounted as dsh mounts a preset's rows: in the preset's scope, so that only the agents under it are heard.
  const preset = {}
  const scope = createScope(owner, preset)
  disposables.push(scope)
  disposables.push(await scope.ctx.plugin(row, {} as never) as unknown as { dispose(): unknown })
  const quiet = new AbortController().signal
  const step: World['step'] = (agent, messages, options = {}) => agentEvents(ctx, agent as unknown as Agent).waterfall(
    'agent/pre-step',
    { messages, turn: 1, step: options.step ?? 1, signal: quiet },
    () => Promise.resolve(options.decision ?? { kind: 'enter', messages }),
  )
  return {
    ctx, logs, preset, owner, step,
    agent(id, header = {}, parent = preset) {
      const made: TestAgent = { id, session: new FakeSession({ id, cwd: '/w', ...header }), options: {} }
      disposables.push(createScope(owner, made, parent === null ? {} : { parent }))
      return made
    },
    async turn(agent, messages, number = 1) {
      const decision = await step(agent, messages, { step: number })
      if (decision.kind === 'enter') agent.session.enter(decision.messages)
      return decision
    },
  }
}

/** The lines the row logged. */
function rowLogs(w: World): string[] {
  return w.logs.filter(line => line.startsWith('[dish-memory]'))
}

// --- delivery ---------------------------------------------------------------------------------------

test('the first step gets the message after the claimed messages', async () => {
  const memory = fakeMemory({ user: ['talk-first'] })
  const w = await world(memory)
  const main = w.agent('main-1')
  const prompt = typed('Hello.')
  const added = typed('Added by another listener.')
  const messages = entered(await w.step(main, [prompt], { decision: { kind: 'enter', messages: [prompt, added] } }))
  assert.equal(messages.length, 3)
  assert.equal(messages[0], prompt)
  assert.equal(messages[2], added)
  const message = messages[1]!
  assert.equal(message.role, 'user')
  assert.deepEqual(message.source, { kind: 'dish-memory', form: 'instructions', identity: 'user' })
  const text = composed(memory, { user: true })!
  assert.match(text, /^<dish-memory>\nThis message supersedes earlier dish-memory messages\.\n[\s\S]*- user\/talk-first — About talk-first \(feedback\)\n<\/dish-memory>$/)
  assert.deepEqual(message.content, [{ type: 'text', text }])
  assert.deepEqual(memory.calls, { scopesFor: ['main-1'], compose: ['user'] })
  // Only a whole message is delivered: one that misses a part waits for a step that can read it all.
  assert.deepEqual(memory.options, [{ complete: true }])

  // A step that claimed none of its messages gets it first.
  const lone = typed('Not claimed.')
  const first = entered(await w.step(w.agent('main-2'), [], { step: 2, decision: { kind: 'enter', messages: [lone] } }))
  assert.equal(first.length, 2)
  assert.deepEqual(first[0]!.source, { kind: 'dish-memory', form: 'instructions', identity: 'user' })
  assert.equal(first[1], lone)
  assert.deepEqual(rowLogs(w), [])
})

test('the next step doesn\'t get it again', async () => {
  const memory = fakeMemory({ user: ['talk-first'] })
  const w = await world(memory)
  const main = w.agent('main-1')
  assert.equal(delivered(entered(await w.turn(main, [typed('Hello.')]))).length, 1)
  // On the surface now: the next steps go as they are.
  const next: PreStepDecision = { kind: 'enter', messages: [] }
  assert.equal(await w.step(main, [], { step: 2, decision: next }), next)
  const prompt = typed('And another thing.')
  const later: PreStepDecision = { kind: 'enter', messages: [prompt] }
  assert.equal(await w.step(main, [prompt], { decision: later }), later)
  assert.deepEqual(memory.calls.compose, ['user'])

  // One among the step's own messages counts too, before the surface is looked at.
  const fresh = w.agent('main-2')
  const already: PreStepDecision = { kind: 'enter', messages: [prompt, memoryMessage('user', 'Composed by an earlier listener.')] }
  assert.equal(await w.step(fresh, [prompt], { decision: already }), already)
  assert.deepEqual(memory.calls.compose, ['user'])
})

test('a resumed session with the message on its surface doesn\'t get it again', async () => {
  const memory = fakeMemory({ user: ['talk-first', 'scratch-home'] })
  const w = await world(memory)
  const main = w.agent('main-1')
  // What a resume restores: the log of an earlier process, the message on its surface, composed from an older vault.
  main.session.enter([typed('Earlier.'), memoryMessage('user', '<dish-memory>\nAn older message.\n</dish-memory>')])
  const prompt = typed('Back again.')
  const decision: PreStepDecision = { kind: 'enter', messages: [prompt] }
  assert.equal(await w.step(main, [prompt], { decision }), decision)
  assert.deepEqual(memory.calls, { scopesFor: ['main-1'], compose: [] })
})

test('after a compaction drops it from the surface, the next step composes it again, with what\'s new', async () => {
  const memory = fakeMemory({ user: ['talk-first'] })
  const w = await world(memory)
  const main = w.agent('main-1')
  const first = delivered(entered(await w.turn(main, [typed('Hello.')])))
  assert.equal(first.length, 1)
  assert.doesNotMatch(textOf(first[0]!), /scratch-home/)
  // A memory saved in another session reaches this one at its next compaction, not before.
  memory.user.push('scratch-home')
  const before: PreStepDecision = { kind: 'enter', messages: [] }
  assert.equal(await w.step(main, [], { step: 2, decision: before }), before)

  main.session.compact()
  const messages = entered(await w.turn(main, [], 3))
  assert.equal(messages.length, 1)
  assert.deepEqual(messages[0]!.source, { kind: 'dish-memory', form: 'instructions', identity: 'user' })
  assert.equal(textOf(messages[0]!), composed(memory, { user: true }))
  assert.match(textOf(messages[0]!), /- user\/scratch-home — About scratch-home \(feedback\)/)
  // And the step after that has it on the surface again.
  const after: PreStepDecision = { kind: 'enter', messages: [] }
  assert.equal(await w.step(main, [], { step: 4, decision: after }), after)
  assert.deepEqual(memory.calls.compose, ['user', 'user'])
})

test('a changed identity gets a new message', async () => {
  const memory = fakeMemory({ user: ['talk-first'], families: { acme: ['release-friday'] } })
  const w = await world(memory)
  const main = w.agent('main-1')
  assert.deepEqual(delivered(entered(await w.turn(main, [typed('Hello.')]))).map(message => message.source), [
    { kind: 'dish-memory', form: 'instructions', identity: 'user' },
  ])
  // The session's project now has a family: the old message is the wrong one, and a new one supersedes it.
  memory.scopes.set('main-1', { user: true, family: 'acme' })
  const messages = delivered(entered(await w.turn(main, [], 2)))
  assert.deepEqual(messages.map(message => message.source), [{ kind: 'dish-memory', form: 'instructions', identity: 'user+family:acme' }])
  const text = textOf(messages[0]!)
  assert.equal(text, composed(memory, { user: true, family: 'acme' }))
  assert.match(text, /This message supersedes earlier dish-memory messages\./)
  assert.match(text, /- family\/release-friday — About release-friday \(feedback\)/)
  // The newest one on the surface is the right one now.
  const next: PreStepDecision = { kind: 'enter', messages: [] }
  assert.equal(await w.step(main, [], { step: 3, decision: next }), next)
  assert.deepEqual(memory.calls.compose, ['user', 'user+family:acme'])
})

test('a new identity with nothing to say supersedes the old message with an empty one; with no old one, nothing', async () => {
  // The empty message is messageText's opening and closing, with nothing between.
  const opening = '<dish-memory>\nThis message supersedes earlier dish-memory messages.\n'
  assert.ok(composed(fakeMemory({ user: ['x'] }), { user: true })!.startsWith(`${opening}\n`))
  const empty = `${opening}</dish-memory>`

  const memory = fakeMemory({ user: ['talk-first'], families: { acme: ['release-friday'] } })
  const w = await world(memory)
  const main = w.agent('main-1')
  memory.scopes.set('main-1', { user: true, family: 'acme' })
  assert.equal(delivered(entered(await w.turn(main, [typed('Hello.')]))).length, 1)
  // The session moved to a family with nothing to say, and the user's memory is gone: compose gives nothing, and the
  // acme message must not stand.
  memory.scopes.set('main-1', { user: true, family: 'beta' })
  memory.user = []
  const moved = delivered(entered(await w.turn(main, [], 2)))
  assert.deepEqual(moved.map(message => message.source), [{ kind: 'dish-memory', form: 'instructions', identity: 'user+family:beta' }])
  assert.equal(textOf(moved[0]!), empty)
  const next: PreStepDecision = { kind: 'enter', messages: [] }
  assert.equal(await w.step(main, [], { step: 3, decision: next }), next)

  // No identity at all (a child outside any family, say): the same, under the identity ''.
  const child = w.agent('child-1', { delegationDepth: 1, origin: 'subagent' }, main)
  memory.scopes.set('child-1', { user: false, family: 'acme' })
  assert.equal(delivered(entered(await w.turn(child, [typed('Your task.')]))).length, 1)
  memory.scopes.set('child-1', { user: false })
  const gone = delivered(entered(await w.turn(child, [], 2)))
  assert.deepEqual(gone.map(message => message.source), [{ kind: 'dish-memory', form: 'instructions', identity: '' }])
  assert.equal(textOf(gone[0]!), empty)
  assert.equal(await w.step(child, [], { step: 3, decision: next }), next)
  // compose isn't asked for no identity.
  assert.deepEqual(memory.calls.compose, ['user+family:acme', 'user+family:beta', 'family:acme'])

  // An agent that was never given a message is given nothing, for either.
  const fresh: PreStepDecision = { kind: 'enter', messages: [typed('Hello.')] }
  assert.equal(await w.step(w.agent('main-2'), (fresh as { messages: UserMessage[] }).messages, { decision: fresh }), fresh)
  memory.scopes.set('child-2', { user: false })
  assert.equal(await w.step(w.agent('child-2', { delegationDepth: 1, origin: 'subagent' }), (fresh as { messages: UserMessage[] }).messages, { decision: fresh }), fresh)
  assert.deepEqual(rowLogs(w), [])
})

test('the newest message decides: one for other scopes after this one\'s brings this one back', async () => {
  const memory = fakeMemory({ user: ['talk-first'] })
  const w = await world(memory)
  const main = w.agent('main-1')
  // On the surface: a message for these scopes, then a newer one for others.
  main.session.enter([memoryMessage('user', '<dish-memory>\nA.\n</dish-memory>')])
  main.session.enter([memoryMessage('user+family:acme', '<dish-memory>\nB.\n</dish-memory>')])
  const messages = delivered(entered(await w.turn(main, [typed('Hello.')])))
  assert.deepEqual(messages.map(message => message.source), [{ kind: 'dish-memory', form: 'instructions', identity: 'user' }])
  assert.equal(textOf(messages[0]!), composed(memory, { user: true }))
  assert.deepEqual(memory.calls.compose, ['user'])
})

test('a stale message among the step\'s own messages outranks a matching one on the surface', async () => {
  const memory = fakeMemory({ user: ['talk-first'] })
  const w = await world(memory)
  const main = w.agent('main-1')
  main.session.enter([memoryMessage('user', '<dish-memory>\nOn the surface.\n</dish-memory>')])
  const prompt = typed('Hello.')
  const stale = memoryMessage('user+family:acme', '<dish-memory>\nIn the step.\n</dish-memory>')
  const messages = entered(await w.step(main, [prompt, stale]))
  // The step's own is the newest: the new message goes after it, and supersedes it.
  assert.equal(messages.length, 3)
  assert.equal(messages[0], prompt)
  assert.equal(messages[1], stale)
  assert.deepEqual(messages[2]!.source, { kind: 'dish-memory', form: 'instructions', identity: 'user' })
  assert.deepEqual(memory.calls.compose, ['user'])
})

test('a child gets family memory only; a scratch chat user memory only', async () => {
  const root = await realpath(await tempDir())
  const clone = join(root, 'work', 'acme', 'widget')
  const scratch = join(root, 'work', 'scratch')
  for (const dir of [clone, scratch]) await mkdir(dir, { recursive: true })
  const real = await memoryWorld({ projects: [{ name: 'acme/widget', family: 'acme', role: 'The widget service' }], clones: { 'acme/widget': clone }, config: true })
  await real.memory.write(USER, input('talk-first'), AS_USER)
  await real.memory.write(ACME, input('release-friday', { type: 'project' }), AS_USER)
  const w = await world(real.memory)
  const main = w.agent('main-1', { cwd: clone })
  const child = w.agent('child-1', { cwd: clone, delegationDepth: 1, origin: 'subagent' }, main)
  const chat = w.agent('main-2', { cwd: scratch })

  const only = async (agent: TestAgent): Promise<UserMessage> => {
    const messages = delivered(entered(await w.turn(agent, [typed('Go.')])))
    assert.equal(messages.length, 1)
    return messages[0]!
  }
  const forChild = await only(child)
  assert.deepEqual(forChild.source, { kind: 'dish-memory', form: 'instructions', identity: 'family:acme' })
  assert.match(textOf(forChild), /Repos in acme:\n- acme\/widget — The widget service/)
  assert.match(textOf(forChild), /Family acme:\n- family\/release-friday — About release-friday \(project\)/)
  assert.doesNotMatch(textOf(forChild), /Your user:|user\/talk-first/)

  const forChat = await only(chat)
  assert.deepEqual(forChat.source, { kind: 'dish-memory', form: 'instructions', identity: 'user' })
  assert.match(textOf(forChat), /Your user:\n- user\/talk-first — About talk-first \(feedback\)/)
  assert.doesNotMatch(textOf(forChat), /acme|family\//)

  const forMain = await only(main)
  assert.deepEqual(forMain.source, { kind: 'dish-memory', form: 'instructions', identity: 'user+family:acme' })
  assert.equal(textOf(forMain), await real.memory.compose({ user: true, family: 'acme' }))
  assert.match(textOf(forMain), /user\/talk-first[\s\S]*family\/release-friday/)
  assert.deepEqual(real.warnings, [])
})

test('the row hears a child of an agent under its preset', async () => {
  const memory = fakeMemory({ families: { acme: ['flaky-test'] }, scopes: { 'child-1': { user: false, family: 'acme' } } })
  const w = await world(memory)
  const main = w.agent('main-1')
  // The child's scope is under its parent's, which is under the preset's.
  const child = w.agent('child-1', { delegationDepth: 1, origin: 'subagent' }, main)
  const messages = delivered(entered(await w.turn(child, [typed('Your task.')])))
  assert.deepEqual(messages.map(message => message.source), [{ kind: 'dish-memory', form: 'instructions', identity: 'family:acme' }])
  assert.equal(textOf(messages[0]!), composed(memory, { user: false, family: 'acme' }))
  assert.deepEqual(memory.calls, { scopesFor: ['child-1'], compose: ['family:acme'] })
})

test('no service, an empty identity, or nothing to say: the decision unchanged', async () => {
  // No service: nothing is said about it either (the plugin logs a vault that won't open).
  const none = await world(undefined)
  const prompt = typed('Hello.')
  const decision: PreStepDecision = { kind: 'enter', messages: [prompt] }
  assert.equal(await none.step(none.agent('main-1'), [prompt], { decision }), decision)
  assert.deepEqual(rowLogs(none), [])

  // An agent with no scope at all, a child outside any family: no message, and nothing composed.
  const memory = fakeMemory({ user: ['talk-first'], scopes: { 'child-1': { user: false } } })
  const w = await world(memory)
  assert.equal(await w.step(w.agent('child-1', { delegationDepth: 1, origin: 'subagent' }), [prompt], { decision }), decision)
  assert.deepEqual(memory.calls, { scopesFor: ['child-1'], compose: [] })

  // A scratch chat with no user memory: nothing to say.
  memory.user = []
  assert.equal(await w.step(w.agent('main-1'), [prompt], { decision }), decision)
  assert.deepEqual(memory.calls, { scopesFor: ['child-1', 'main-1'], compose: ['user'] })
  assert.deepEqual(rowLogs(w), [])
})

test('an agent under another preset hears no listener, and gets no message', async () => {
  const memory = fakeMemory({ user: ['talk-first'] })
  const w = await world(memory)
  const other = {}
  disposables.push(createScope(w.owner, other))
  const prompt = typed('Hello.')
  const decision: PreStepDecision = { kind: 'enter', messages: [prompt] }
  assert.equal(await w.step(w.agent('elsewhere-1', {}, other), [prompt], { decision }), decision)
  // Nor does an agent on no preset.
  assert.equal(await w.step(w.agent('elsewhere-2', {}, null), [prompt], { decision }), decision)
  assert.deepEqual(memory.calls, { scopesFor: [], compose: [] })
})

test('compose throws: the decision unchanged and one warning per agent, without memory text', async () => {
  const memory = fakeMemory({ user: ['marked-memory'] })
  memory.failing.compose = new Error('the vault is locked')
  const w = await world(memory)
  const main = w.agent('main-1')
  const prompt = typed('Hello.')
  const decision: PreStepDecision = { kind: 'enter', messages: [prompt] }
  assert.equal(await w.step(main, [prompt], { decision }), decision)
  assert.equal(await w.step(main, [], { step: 2, decision }), decision)
  assert.deepEqual(rowLogs(w), ['[dish-memory] warn: no memory message for main-1: the vault is locked'])

  // Another agent gets its own warning, and so does a scopesFor that throws.
  memory.failing = { scopesFor: new Error('the projects can\'t be listed') }
  assert.equal(await w.step(w.agent('main-2'), [prompt], { decision }), decision)
  assert.equal(await w.step(w.agent('main-2'), [prompt], { decision }), decision)
  assert.deepEqual(rowLogs(w), [
    '[dish-memory] warn: no memory message for main-1: the vault is locked',
    '[dish-memory] warn: no memory message for main-2: the projects can\'t be listed',
  ])
  // An agent that is gone is forgotten: a new one of that id is told about again.
  agentEvents(w.ctx, main as unknown as Agent).emit('agent/disposed', {})
  assert.equal(await w.step(main, [prompt], { decision }), decision)
  assert.equal(rowLogs(w).length, 3)
  assert.ok(w.logs.every(line => !line.includes('About marked-memory') && !line.includes('What marked-memory says')), w.logs.join('\n'))

  // Once it can, it delivers.
  memory.failing = {}
  assert.equal(delivered(entered(await w.step(main, [prompt]))).length, 1)
})

test('a step whose family can\'t be looked up keeps the message the agent has', async () => {
  const root = await realpath(await tempDir())
  const clone = join(root, 'work', 'acme', 'widget')
  await mkdir(clone, { recursive: true })
  const real = await memoryWorld({ projects: [{ name: 'acme/widget', family: 'acme' }], clones: { 'acme/widget': clone }, config: true })
  await real.memory.write(USER, input('talk-first'), AS_USER)
  await real.memory.write(ACME, input('release-friday'), AS_USER)
  const w = await world(real.memory)
  const main = w.agent('main-1', { cwd: clone })
  assert.deepEqual(delivered(entered(await w.turn(main, [typed('Hello.')]))).map(message => message.source.kind === 'dish-memory' && message.source.identity), ['user+family:acme'])

  // A config change, then dishProjects fails for a while: "no family" would be a guess, and a user-only message would
  // supersede the family's. The step goes as it is, and the agent keeps its message.
  real.memory.clearCaches()
  real.services.set({ projectsError: new Error('the config store is busy') })
  const next: PreStepDecision = { kind: 'enter', messages: [] }
  assert.equal(await w.step(main, [], { step: 2, decision: next }), next)
  assert.equal(await w.step(main, [], { step: 3, decision: next }), next)
  assert.deepEqual(rowLogs(w), [
    '[dish-memory] warn: no memory message for main-1: could not list the projects, so the chat\'s family isn\'t known: the config store is busy',
  ])
  // Well again: the family is found, and the message it has is the right one.
  real.services.set({ projectsError: undefined })
  assert.equal(await w.step(main, [], { step: 4, decision: next }), next)
  assert.equal(rowLogs(w).length, 1)

  // dish-projects reloading (its service gone for a moment) is the same: the family isn't known, so nothing changes.
  real.memory.clearCaches()
  real.services.set({ projects: undefined })
  const other = w.agent('main-2', { cwd: clone })
  other.session.enter([memoryMessage('user+family:acme', '<dish-memory>\nThe family\'s.\n</dish-memory>')])
  assert.equal(await w.step(other, [], { step: 2, decision: next }), next)
  assert.deepEqual(rowLogs(w).slice(1), [
    '[dish-memory] warn: no memory message for main-2: dish-projects isn\'t running, so the chat\'s family isn\'t known',
  ])
  real.services.set({ projects: [{ name: 'acme/widget', family: 'acme' }] })
  assert.equal(await w.step(other, [], { step: 3, decision: next }), next)
  assert.equal(rowLogs(w).length, 2)
})

test('a message that couldn\'t be read whole isn\'t delivered: one warning, and a later step delivers it whole', async () => {
  const root = await realpath(await tempDir())
  const clone = join(root, 'work', 'acme', 'widget')
  await mkdir(clone, { recursive: true })
  const real = await memoryWorld({ projects: [{ name: 'acme/widget', family: 'acme' }], clones: { 'acme/widget': clone }, config: true })
  await real.memory.write(USER, input('talk-first'), AS_USER)
  await real.services.store!.write([{ path: 'families/acme/direction.md', text: 'Ship the widget.\n' }], AS_USER)
  const w = await world(real.memory)
  const main = w.agent('main-1', { cwd: clone })

  // The direction can't be read: a message without it would stand, under the full identity, until a compaction.
  real.services.set({ configReadError: new Error('the config store is busy') })
  assert.deepEqual(delivered(entered(await w.turn(main, [typed('Hello.')]))), [])
  const next: PreStepDecision = { kind: 'enter', messages: [] }
  assert.equal(await w.step(main, [], { step: 2, decision: next }), next)
  assert.deepEqual(rowLogs(w), [
    '[dish-memory] warn: no memory message for main-1: the message for user+family:acme isn\'t complete: could not read family acme\'s direction: the config store is busy',
  ])

  // Readable again: the next step delivers it whole, with the direction, without a compaction.
  real.services.set({ configReadError: undefined })
  const messages = delivered(entered(await w.turn(main, [], 3)))
  assert.deepEqual(messages.map(message => message.source), [{ kind: 'dish-memory', form: 'instructions', identity: 'user+family:acme' }])
  assert.match(textOf(messages[0]!), /Direction for family acme, written by your user\. Work within it\.\nShip the widget\./)
  assert.equal(textOf(messages[0]!), await real.memory.compose({ user: true, family: 'acme' }))
  assert.equal(rowLogs(w).length, 1)
  assert.deepEqual(real.warnings, [])
})

test('odd agents (no session, no surface, an eventAt that throws) leave the decision unchanged, with one warning each', async () => {
  const memory = fakeMemory({ user: ['talk-first'] })
  const w = await world(memory)
  const place = (made: object): TestAgent => {
    disposables.push(createScope(w.owner, made, { parent: w.preset }))
    return made as TestAgent
  }
  const agents = [
    place({ id: 'odd-1', options: {} }),
    place({ id: 'odd-2', session: { header: { id: 'odd-2' } }, options: {} }),
    place({ id: 'odd-3', session: { header: { id: 'odd-3' }, surface: { nodes: [0] }, eventAt() { throw new Error('the log is closed') } }, options: {} }),
  ]
  const prompt = typed('Hello.')
  const decision: PreStepDecision = { kind: 'enter', messages: [prompt] }
  for (const agent of agents) {
    assert.equal(await w.step(agent, [prompt], { decision }), decision)
    assert.equal(await w.step(agent, [prompt], { decision }), decision)
  }
  const lines = rowLogs(w)
  assert.equal(lines.length, 3, lines.join('\n'))
  assert.match(lines[0]!, /^\[dish-memory\] warn: no memory message for odd-1: \S/)
  assert.match(lines[1]!, /^\[dish-memory\] warn: no memory message for odd-2: \S/)
  assert.equal(lines[2], '[dish-memory] warn: no memory message for odd-3: the log is closed')
  assert.deepEqual(memory.calls.compose, [])
})

test('a reject or an empty first step is left alone', async () => {
  const memory = fakeMemory({ user: ['talk-first'] })
  const w = await world(memory)
  const main = w.agent('main-1')
  const reject: PreStepDecision = { kind: 'reject' }
  assert.equal(await w.step(main, [typed('Hello.')], { decision: reject }), reject)
  // The first step with nothing to enter, as dsh-agent-instructions leaves it.
  const empty: PreStepDecision = { kind: 'enter', messages: [] }
  assert.equal(await w.step(main, [], { step: 1, decision: empty }), empty)
  assert.deepEqual(memory.calls, { scopesFor: [], compose: [] })
})
