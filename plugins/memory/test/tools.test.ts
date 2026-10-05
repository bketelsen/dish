/**
 * `remember`, `forget` and `recall`, called through dsh's `ToolRuntime`: the row registers them in a preset's scope, and
 * agents on scopes under it call them, as dsh's agent loop does. Behind them is a real `dishMemory` over a vault in a
 * temporary directory (`memoryWorld`), with a project whose clone is a temporary directory too.
 */

import { mkdir, readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import * as row from '../src/context.ts'
import { MAIN_ONLY, UNAVAILABLE } from '../src/context.ts'
import type { Budget } from '../src/format.ts'
import type { AgentLike, DishMemory } from '../src/service.ts'
import { ACME, AS_AGENT, AS_USER, USER, agentAt, fakeJudge, input, memoryWorld, provideStub, tempDir } from './helpers.ts'
import type { FakeJudge, MemoryWorld } from './helpers.ts'

const NO_FAMILY = 'this chat isn\'t working in a family\'s repos (scratch, or no registered project): use scope user, or open the chat in the project'
/** What `forget` and `recall` answer a `family/` id outside a family. */
const NO_FAMILY_MEMORY = 'this chat isn\'t working in a family\'s repos (scratch, or no registered project), so family memory isn\'t available here'
const FAMILY_UNAVAILABLE = 'Family memory is unavailable right now: this chat\'s family can\'t be looked up. Try again later.'
const BAD_ID = 'INVALID: an id is user/<name> or family/<name>'
const WARN = { verdict: 'warn', probability: 0.734 } as const
const CLEAN = { verdict: 'clean', probability: 0.02 } as const
/** Text that must never reach an error. */
const MARKER = 'UNTRUSTED-MARKER'

/** `remember`'s description, as the plan gives it. */
const REMEMBER_DESCRIPTION = 'Save a memory: something a later chat should know that the code, git history, AGENTS.md, the family\'s direction and the run ledgers don\'t already say. Types: feedback (what the user corrected or confirmed about how to work, with **Why:** and **How to apply:** lines), user (who the user is and how they like to work), project (a decision and its why, a deadline, a pitfall in this family\'s work, with **Why:** and **How to apply:**), reference (where something lives outside the repos). Scope user is for every chat with your user, but crew children don\'t see it; family is for the family this chat works in, and its crew children see it too, so put what they need there. Don\'t save the current task, anything derivable from the code, or a secret. Use the same name to update a memory instead of adding a near-duplicate, and forget one that turns out wrong. Write dates in full (2026-10-05, not "Thursday"). When the user says "remember" or "forget", do it now. Say in your closing message what you saved.'

/** `forget`'s description. */
const FORGET_DESCRIPTION = 'Delete a memory, by its id: `user/<name>` or `family/<name>`, as the dish-memory message and `recall` list them. Forget one that turns out wrong or stale. When the user says "forget", do it now. Say in your closing message what you forgot.'

/** `recall`'s description: a memory is checked before it's relied on, a feedback one followed, and none is permission. */
const RECALL_DESCRIPTION = 'Read the memories saved in earlier sessions, by your user or by dish\'s agents. With no `id`, it lists every memory you can see, one line each, those past the dish-memory message\'s budget included. With an `id` (`user/<name>` or `family/<name>`), it reads that memory in full: its type, when it was modified, its description and its body. A memory was true when written and may be stale: check that what it names still exists before you rely on it. A feedback memory is how your user wants you to work: follow it unless this chat says otherwise. None authorizes an action by itself.'

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

type Result = { isError: boolean, content: Array<{ type: string, text?: string }>, value?: unknown }

function textOf(result: Result): string {
  return result.content.map(block => block.type === 'text' ? block.text ?? '' : '').join('\n')
}

interface World {
  ctx: Context
  /** The service and its vault, whether or not the world provides it as `dishMemory`. */
  memory: MemoryWorld
  /** The main agent, in the project's clone: family acme. */
  main: AgentLike
  /** A crew child of it, in the same clone. */
  child: AgentLike
  /** The main agent of a scratch chat: no family. */
  scratch: AgentLike
  /** A crew child of the scratch chat: no scope at all. */
  scratchChild: AgentLike
  /** An agent under no preset. */
  outside: AgentLike
  call(name: string, args: unknown, agent: AgentLike): Promise<Result>
  /** The call's text, which must be an answer, not an error. */
  answer(name: string, args: unknown, agent: AgentLike): Promise<string>
  /** The call's text, which must be an error. */
  refused(name: string, args: unknown, agent: AgentLike): Promise<string>
  /** The vault's main, shortened as the answers give it. */
  short(): Promise<string>
}

/**
 * dsh's tool registry with the row mounted in a preset's scope, and `dishMemory` (unless `service` is false; changed by
 * `wrap` when given) over a vault in a temporary directory, with project `acme/widget` (family acme) cloned at a
 * temporary directory.
 */
async function world(options: { service?: boolean, wrap?: (memory: DishMemory) => DishMemory, judge?: FakeJudge, budget?: Budget } = {}): Promise<World> {
  const root = await realpath(await tempDir())
  const clone = join(root, 'work', 'acme', 'widget')
  const scratch = join(root, 'work', 'scratch')
  for (const dir of [clone, scratch]) await mkdir(dir, { recursive: true })
  const memory = await memoryWorld({
    projects: [{ name: 'acme/widget', family: 'acme' }],
    clones: { 'acme/widget': clone },
    config: true,
    ...options.judge === undefined ? {} : { judge: options.judge },
    ...options.budget === undefined ? {} : { budget: options.budget },
  })

  const ctx = new Context()
  await provided(ctx, 'systemPrompt', { tools() {}, section() {}, context() {}, getSectionOrder: () => 1, getContextOrder: () => 1 })
  disposables.push(await ctx.plugin(ToolRuntime, {}) as unknown as { dispose(): unknown })
  if (options.service !== false) await provided(ctx, 'dishMemory', options.wrap?.(memory.memory) ?? memory.memory)
  let owner!: Context
  disposables.push(await ctx.plugin({ name: 'scope-owner', inject: ['tools'], apply(own: Context) { owner = own } } as never, undefined as never) as unknown as { dispose(): unknown })
  // The row, in a preset's scope: its tools are that preset's agents', and their children's.
  const preset = {}
  const presetScope = createScope(owner, preset)
  disposables.push(presetScope)
  disposables.push(await presetScope.ctx.plugin(row, {} as never) as unknown as { dispose(): unknown })
  const scoped = (agent: AgentLike, parent: object | undefined): AgentLike => {
    disposables.push(createScope(owner, agent as object, parent === undefined ? {} : { parent }))
    return agent
  }
  const main = scoped(agentAt(clone), preset)
  const child = scoped(agentAt(clone, { depth: 1 }), main as object)
  const chat = scoped(agentAt(scratch), preset)
  const scratchChild = scoped(agentAt(scratch, { depth: 1 }), chat as object)
  const outside = scoped(agentAt(clone), undefined)

  let calls = 0
  const call: World['call'] = (name, args, agent) => ctx.tools.execute({
    callId: `call-${++calls}` as never, name, arguments: args, agent: agent as never, signal: new AbortController().signal,
  }) as unknown as Promise<Result>
  return {
    ctx, memory, main, child, scratch: chat, scratchChild, outside, call,
    async answer(name, args, agent) {
      const result = await call(name, args, agent)
      assert.equal(result.isError, false, textOf(result))
      assert.deepEqual(result.value, { text: textOf(result) })
      return textOf(result)
    },
    async refused(name, args, agent) {
      const result = await call(name, args, agent)
      assert.equal(result.isError, true, textOf(result))
      return textOf(result)
    },
    async short() {
      return (await memory.store.head()).slice(0, 7)
    },
  }
}

function remembered(name: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { scope: 'user', name, type: 'feedback', description: `About ${name}`, body: `What ${name} says.`, ...fields }
}

test('remember saves, and the answer has the id and commit', async () => {
  const w = await world()
  const names = (agent: AgentLike) => w.ctx.tools.schemas(agent as object).map(schema => schema.name)
  for (const name of ['remember', 'forget', 'recall']) {
    assert.ok(names(w.main).includes(name), name)
    assert.ok(names(w.child).includes(name), name)
    assert.ok(!names(w.outside).includes(name), name)
  }
  const rememberSchema = w.ctx.tools.schemas(w.main as object).find(schema => schema.name === 'remember')
  assert.equal(rememberSchema?.description, REMEMBER_DESCRIPTION)
  // The scope parameter says the same: children don't see user memory, and do see the family's.
  assert.match(JSON.stringify(rememberSchema?.parameters), /crew children don't see it.*its crew children see it too/)
  const description = (name: string) => w.ctx.tools.schemas(w.main as object).find(schema => schema.name === name)?.description
  assert.equal(description('forget'), FORGET_DESCRIPTION)
  assert.equal(description('recall'), RECALL_DESCRIPTION)
  // A child is told the same.
  assert.equal(w.ctx.tools.schemas(w.child as object).find(schema => schema.name === 'recall')?.description, RECALL_DESCRIPTION)

  const body = 'Brainstorm before writing a spec.\n\n**Why:** the user said so on 2026-10-05.\n\n**How to apply:** ask first.'
  assert.equal(await w.answer('remember', remembered('talk-first', { body }), w.main), `Saved \`user/talk-first\` (new), commit ${await w.short()}.`)
  const saved = await w.memory.memory.read(USER, 'talk-first')
  assert.deepEqual({ ...saved, commit: undefined }, {
    scope: 'user', name: 'talk-first', type: 'feedback', description: 'About talk-first', modified: '2026-10-05T12:00:00Z', body, commit: undefined,
  })
  const [commit] = await w.memory.memory.history(USER, { limit: 1 })
  assert.deepEqual(commit!.author, { kind: 'agent', sessionId: String(w.main.id), role: 'main' })

  // The family is the chat's own.
  assert.equal(await w.answer('remember', remembered('release-friday', { scope: 'family', type: 'project' }), w.main),
    `Saved \`family/release-friday\` (new), commit ${await w.short()}.`)
  assert.match(await w.memory.store.read('families/acme/release-friday.md') ?? '', /^---\nname: release-friday\n/)
  // The same name replaces it.
  assert.equal(await w.answer('remember', remembered('release-friday', { scope: 'family', type: 'project', description: 'Moved to Friday 2026-10-09' }), w.main),
    `Saved \`family/release-friday\` (updated), commit ${await w.short()}.`)
  assert.equal((await w.memory.memory.read(ACME, 'release-friday'))?.description, 'Moved to Friday 2026-10-09')
})

test('remember from a child is MAIN_ONLY', async () => {
  const w = await world()
  const head = await w.memory.store.head()
  assert.equal(await w.refused('remember', remembered('from-child', { scope: 'family' }), w.child), `Error: ${MAIN_ONLY}`)
  assert.equal(await w.refused('forget', { id: 'family/from-child' }, w.child), `Error: ${MAIN_ONLY}`)
  assert.equal(await w.memory.store.head(), head)
})

test('remember with scope family in scratch says to use user', async () => {
  const w = await world()
  const head = await w.memory.store.head()
  assert.equal(await w.refused('remember', remembered('pitfall', { scope: 'family' }), w.scratch), `Error: ${NO_FAMILY}`)
  assert.equal(await w.memory.store.head(), head)
  assert.equal(await w.answer('remember', remembered('pitfall'), w.scratch), `Saved \`user/pitfall\` (new), commit ${await w.short()}.`)
})

test('remember\'s held answer says it won\'t reach any agent', async () => {
  const judge = fakeJudge([WARN])
  const w = await world({ judge })
  assert.equal(await w.answer('remember', remembered('odd'), w.main),
    `Saved \`user/odd\` (new), commit ${await w.short()}. Held for your user's review on Settings → Memory: `
    + 'Jev scored it 0.73 as instructions aimed at an agent. It won\'t reach any agent until they release it.')
  assert.equal(judge.requests.length, 1)
  assert.equal(judge.requests[0]!.agent, w.main)
  assert.equal((await w.memory.memory.read(USER, 'odd'))?.held, 'Jev scored it 0.73 as instructions aimed at an agent')
})

test('remember\'s nearly-full note', async () => {
  const w = await world({ budget: { lines: 10, bytes: 16_384 } })
  for (let n = 1; n <= 6; n++) await w.memory.memory.write(USER, input(`old-${n}`), AS_USER)
  assert.equal(await w.answer('remember', remembered('seventh'), w.main), `Saved \`user/seventh\` (new), commit ${await w.short()}.`)
  // The eighth of ten lines is 80%.
  assert.equal(await w.answer('remember', remembered('eighth'), w.main),
    `Saved \`user/eighth\` (new), commit ${await w.short()}. This scope's index is nearly full (8 memories): merge or forget stale ones.`)
})

test('INVALID and SECRET reach the agent as code: message, never echoing the text', async () => {
  const w = await world()
  const head = await w.memory.store.head()
  assert.equal(await w.refused('remember', remembered(`${MARKER}-name`), w.main),
    'Error: INVALID: name must be lowercase letters, digits and hyphens, starting with a letter or digit, at most 64 characters')
  assert.equal(await w.refused('remember', remembered('two-lines', { description: `First\n${MARKER}` }), w.main),
    'Error: INVALID: description must be one line of at most 150 characters')
  assert.equal(await w.refused('remember', remembered('empty', { body: '  \n' }), w.main), 'Error: INVALID: body must not be empty')
  // Built here, so that no credential-shaped text sits in the source.
  const token = `ghp_${'a1B2'.repeat(9)}`
  const secret = await w.refused('remember', remembered('push', { body: `${MARKER}: use ${token} to push.` }), w.main)
  assert.equal(secret, 'Error: SECRET: the memory looks like it holds a credential (a GitHub token); never save secrets')
  // A type that isn't one of the four is dsh's to refuse, before the tool runs.
  assert.ok(!(await w.refused('remember', remembered('typed', { type: 'note', body: MARKER }), w.main)).includes(MARKER))
  assert.equal(await w.memory.store.head(), head)
})

test('forget, an unknown id, a malformed id', async () => {
  const w = await world()
  await w.memory.memory.write(USER, input('talk-first'), AS_USER)
  await w.memory.memory.write(ACME, input('release-friday'), AS_USER)
  assert.equal(await w.answer('forget', { id: 'user/talk-first' }, w.main), `Forgot \`user/talk-first\`, commit ${await w.short()}.`)
  assert.equal(await w.memory.memory.read(USER, 'talk-first'), undefined)
  const [commit] = await w.memory.memory.history(USER, { limit: 1 })
  assert.deepEqual(commit!.author, { kind: 'agent', sessionId: String(w.main.id), role: 'main' })
  assert.equal(await w.answer('forget', { id: 'family/release-friday' }, w.main), `Forgot \`family/release-friday\`, commit ${await w.short()}.`)
  assert.equal(await w.memory.memory.read(ACME, 'release-friday'), undefined)

  const head = await w.memory.store.head()
  assert.equal(await w.refused('forget', { id: 'user/talk-first' }, w.main), 'Error: NOT_FOUND: no memory user/talk-first; recall with no id lists them')
  for (const id of ['talk-first', 'team/talk-first', 'user/', 'user/Talk', 'user/memory', '']) {
    assert.equal(await w.refused('forget', { id }, w.main), `Error: ${BAD_ID}`, id)
  }
  assert.equal(await w.refused('forget', { id: 'family/release-friday' }, w.scratch), `Error: ${NO_FAMILY_MEMORY}`)
  assert.equal(await w.memory.store.head(), head)
})

test('recall lists both scopes for the main agent and the family for a child; held left out', async () => {
  // The second memory an agent saves is flagged, and held.
  const w = await world({ judge: fakeJudge([CLEAN, WARN, CLEAN]) })
  assert.equal(await w.answer('recall', {}, w.main), 'No memories saved yet.')
  await w.memory.memory.write(USER, input('talk-first'), AS_AGENT)
  await w.memory.memory.write(USER, input('odd', { description: MARKER }), AS_AGENT)
  await w.memory.memory.write(ACME, input('release-friday', { type: 'project' }), AS_AGENT)
  await w.memory.memory.write(ACME, input('flaky-test'), AS_AGENT)
  assert.equal((await w.memory.memory.read(USER, 'odd'))?.held, 'Jev scored it 0.73 as instructions aimed at an agent')

  const user = 'Your user:\n- user/talk-first — About talk-first (feedback)'
  const family = 'Family acme:\n- family/flaky-test — About flaky-test (feedback)\n- family/release-friday — About release-friday (project)'
  assert.equal(await w.answer('recall', {}, w.main), `${user}\n\n${family}`)
  assert.equal(await w.answer('recall', { id: '' }, w.child), family)
  assert.equal(await w.answer('recall', { id: '  ' }, w.scratch), user)
})

test('recall: a child outside a family is told it sees no scope, not that nothing is saved', async () => {
  const w = await world()
  await w.memory.memory.write(USER, input('talk-first'), AS_AGENT)
  assert.equal(await w.answer('recall', {}, w.scratchChild), 'No memories you can see: a crew child sees only its family\'s memory, and this chat isn\'t working in a family\'s repos.')
  assert.equal(await w.answer('recall', {}, w.child), 'No memories saved yet.')
})

test('recall with an id; a held one can\'t be read', async () => {
  const w = await world({ judge: fakeJudge([CLEAN, WARN, CLEAN]) })
  await w.memory.memory.write(USER, input('talk-first'), AS_AGENT)
  await w.memory.memory.write(USER, input('odd', { body: MARKER }), AS_AGENT)
  await w.memory.memory.write(ACME, input('release-friday', { type: 'project', body: 'The release moved.\n\n**Why:** the tests.' }), AS_AGENT)

  assert.equal(await w.answer('recall', { id: 'family/release-friday' }, w.main),
    '`family/release-friday` (project, modified 2026-10-05T12:00:00Z)\n\nAbout release-friday\n\nThe release moved.\n\n**Why:** the tests.')
  assert.equal(await w.answer('recall', { id: 'user/talk-first' }, w.scratch),
    '`user/talk-first` (feedback, modified 2026-10-05T12:00:00Z)\n\nAbout talk-first\n\nWhat talk-first says.')
  // A child reads its family's.
  assert.match(await w.answer('recall', { id: 'family/release-friday' }, w.child), /^`family\/release-friday` \(project/)
  const held = await w.answer('recall', { id: 'user/odd' }, w.main)
  assert.equal(held, '`user/odd` is held for the user\'s review and can\'t be read.')

  assert.equal(await w.refused('recall', { id: 'user/none' }, w.main), 'Error: NOT_FOUND: no memory user/none; recall with no id lists them')
  // User memory isn't in a child's scopes: for it, there's no such memory.
  assert.equal(await w.refused('recall', { id: 'user/talk-first' }, w.child), 'Error: NOT_FOUND: no memory user/talk-first; recall with no id lists them')
  assert.equal(await w.refused('recall', { id: 'family/release-friday' }, w.scratch), `Error: ${NO_FAMILY_MEMORY}`)
  assert.equal(await w.refused('recall', { id: 'release-friday' }, w.main), `Error: ${BAD_ID}`)
})

test('while the family can\'t be looked up, user memory still works; recall lists it and says family memory is unavailable', async () => {
  const w = await world()
  await w.memory.memory.write(USER, input('talk-first'), AS_USER)
  await w.memory.memory.write(ACME, input('release-friday'), AS_USER)
  w.memory.services.set({ projectsError: new Error('the config store is busy') })
  const lookup = 'Error: UNAVAILABLE: could not list the projects, so the chat\'s family isn\'t known: the config store is busy'

  // recall with no id: the user half, and a line, not an error. A child sees only the line.
  assert.equal(await w.answer('recall', {}, w.main), `Your user:\n- user/talk-first — About talk-first (feedback)\n\n${FAMILY_UNAVAILABLE}`)
  assert.equal(await w.answer('recall', {}, w.child), FAMILY_UNAVAILABLE)
  // A user id reads; a family id is UNAVAILABLE.
  assert.match(await w.answer('recall', { id: 'user/talk-first' }, w.main), /^`user\/talk-first` \(feedback/)
  assert.equal(await w.refused('recall', { id: 'user/talk-first' }, w.child), 'Error: NOT_FOUND: no memory user/talk-first; recall with no id lists them')
  assert.equal(await w.refused('recall', { id: 'family/release-friday' }, w.main), lookup)
  // remember and forget in scope user go on; in scope family they're UNAVAILABLE.
  assert.equal(await w.answer('remember', remembered('pitfall'), w.main), `Saved \`user/pitfall\` (new), commit ${await w.short()}.`)
  assert.equal(await w.answer('forget', { id: 'user/pitfall' }, w.main), `Forgot \`user/pitfall\`, commit ${await w.short()}.`)
  assert.equal(await w.refused('forget', { id: 'family/release-friday' }, w.main), lookup)

  // With no user memory, the line alone.
  await w.memory.memory.delete(USER, 'talk-first', AS_USER)
  assert.equal(await w.answer('recall', {}, w.main), FAMILY_UNAVAILABLE)
  // Well again: both halves.
  w.memory.services.set({ projectsError: undefined })
  assert.equal(await w.answer('recall', {}, w.main), 'Family acme:\n- family/release-friday — About release-friday (feedback)')
})

test('no service: UNAVAILABLE from all three', async () => {
  const w = await world({ service: false })
  assert.equal(UNAVAILABLE, 'memory is unavailable right now')
  assert.equal(await w.refused('remember', remembered('talk-first'), w.main), `Error: ${UNAVAILABLE}`)
  assert.equal(await w.refused('forget', { id: 'user/talk-first' }, w.main), `Error: ${UNAVAILABLE}`)
  assert.equal(await w.refused('recall', {}, w.main), `Error: ${UNAVAILABLE}`)
  assert.equal(await w.refused('recall', { id: 'family/release-friday' }, w.child), `Error: ${UNAVAILABLE}`)
  // Who may call comes first.
  assert.equal(await w.refused('remember', remembered('talk-first'), w.child), `Error: ${MAIN_ONLY}`)
})

test('a refusal whose message starts with its code isn\'t given it twice; an error with no code passes through', async () => {
  // Node's own errors carry a string code, and their messages start with it.
  let failure: Error = Object.assign(new Error('ENOENT: no such file or directory, open \'/vault/HEAD\''), { code: 'ENOENT' })
  const w = await world({ wrap: memory => ({ ...memory, write: async () => { throw failure } }) })
  assert.equal(await w.refused('remember', remembered('a'), w.main), 'Error: ENOENT: no such file or directory, open \'/vault/HEAD\'')
  failure = Object.assign(new Error('the vault is locked'), { code: 'LOCKED' })
  assert.equal(await w.refused('remember', remembered('a'), w.main), 'Error: LOCKED: the vault is locked')
  // Only the code and a colon count as the code: a message that merely begins with the same letters gets it.
  failure = Object.assign(new Error('CONFLICTED files'), { code: 'CONFLICT' })
  assert.equal(await w.refused('remember', remembered('a'), w.main), 'Error: CONFLICT: CONFLICTED files')
  failure = new Error('something broke')
  assert.equal(await w.refused('remember', remembered('a'), w.main), 'Error: something broke')

  // A family that can't be looked up for a moment is UNAVAILABLE, not "use scope user".
  w.memory.services.set({ projectsError: new Error('the config store is busy') })
  assert.equal(await w.refused('remember', remembered('a', { scope: 'family' }), w.main),
    'Error: UNAVAILABLE: could not list the projects, so the chat\'s family isn\'t known: the config store is busy')
})

test('the module imports only what the row may', async () => {
  /** Every module a file loads when it runs: its imports and re-exports that aren't `import type`, and any dynamic import or require. */
  const runtimeImports = async (file: string): Promise<string[]> => {
    const source = await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8')
    assert.doesNotMatch(source, /\bimport\s*\(|\brequire\s*\(/, file)
    // An import's clause holds no quote, parenthesis or `=`, so a match never runs on into a declaration.
    const statements = [...source.matchAll(/^(?:import|export)\s+(type\s+)?(?:[^'"()=]*?\s+from\s+)?['"]([^'"]+)['"]/gm)]
    assert.ok(statements.length > 0 || file === 'protocol.ts', file)
    return [...new Set(statements.filter(match => match[1] === undefined).map(match => match[2]!))].sort()
  }
  // The Architecture's list: a row whose import fails breaks the whole dish preset.
  const allowed = ['@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-tools', '@deepseek-ai/schemastery', 'dish-kit', './format.ts', './protocol.ts']
  const loaded = await runtimeImports('context.ts')
  for (const name of loaded) assert.ok(allowed.includes(name), `context.ts loads ${name}`)
  assert.deepEqual(loaded, ['./format.ts', './protocol.ts', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-tools', '@deepseek-ai/schemastery', 'dish-kit'])
  // And what it loads of the plugin loads nothing else.
  assert.deepEqual(await runtimeImports('format.ts'), ['./protocol.ts'])
  assert.deepEqual(await runtimeImports('protocol.ts'), [])
  assert.equal(row.name, 'dish-memory-context')
  assert.deepEqual(row.inject, ['tools'])
})
