import { existsSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { PERSONA_PREFIX_SECTION, PERSONA_SUFFIX_SECTION } from '@deepseek-ai/dsh-system-prompt'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import type { DishConfigService } from 'dish-config'
import { DEFAULTS } from '../src/defaults.ts'
import type { DishPrompts, Persona } from '../src/index.ts'
import { buildPreview, buildVariables } from '../src/preview.ts'
import type { ErrorCode, Outcome } from '../src/protocol.ts'
import type { PromptsRemote } from '../src/remote.ts'
import { dirs, mountConfig, mountPrompts, seeded, userWrite, waitFor, watchLogs } from './helpers.ts'

const IDENTITY = 'You are an AI agent.'

/** An assembly as dsh builds it for a scope: the persona sections between other guidance. Each call builds a new one. */
function assembly(variables: Record<string, string | undefined> = { model: undefined, cwd: undefined, provider: 'acme' }): PromptAssembly {
  return {
    sections: [
      { name: 'harness:identity', text: IDENTITY },
      { name: PERSONA_PREFIX_SECTION, text: 'global prefix {{model}}' },
      { name: 'tool:bash', text: 'Use bash in {{cwd}} for {{model}}.' },
      { name: PERSONA_SUFFIX_SECTION, text: 'global suffix' },
    ],
    contexts: [],
    tools: [],
    variables,
  }
}

const TEXTS: Record<string, Persona> = {
  main: { prefix: 'MAIN for {{model}}.', suffix: 'COMMON in {{cwd}}, {{nobody}}.', commit: 'c'.repeat(40) },
  coder: { prefix: 'CODER for {{model}}.', suffix: 'COMMON in {{cwd}}, {{nobody}}.', commit: 'c'.repeat(40) },
}

/** A service that answers `persona` from `TEXTS`, and with `commit` as the store's, and nothing else. */
function prompts(overrides: Partial<DishPrompts> = {}): DishPrompts {
  return {
    roles: async () => ['common', 'main', 'coder'],
    persona: async (role) => {
      const found = TEXTS[role]
      if (found === undefined) throw new Error(`unknown role "${role}"`)
      return found
    },
    snapshot: async () => { throw new Error('a preview takes no snapshot') },
    drop: async () => { throw new Error('a preview drops no snapshot') },
    defaultText: () => undefined,
    ...overrides,
  }
}

interface Stubs {
  ctx: Context
  /** What `acquireScope` was asked for, and the contexts `assemble` was given. */
  leases: (string | undefined)[]
  assembled: unknown[]
  disposed: () => number
  key: object
}

interface StubOptions {
  acquireScope?: () => Promise<never>
  assemble?: () => Promise<PromptAssembly>
  disposeFails?: boolean
  variables?: Record<string, string | undefined>
  /** Leave a service out. */
  without?: 'agentPresets' | 'systemPrompt'
}

/** A `Context` with stand-ins for `agentPresets` and `systemPrompt`: what the preview asks of dsh, and nothing more. */
function stubs(options: StubOptions = {}): Stubs {
  const ctx = new Context()
  const key = {}
  const leases: (string | undefined)[] = []
  const assembled: unknown[] = []
  let disposed = 0
  if (options.without !== 'agentPresets') {
    ctx.provide('agentPresets', {
      acquireScope: options.acquireScope ?? (async (id?: string) => {
        leases.push(id)
        return {
          key,
          [Symbol.asyncDispose]: async () => {
            disposed++
            if (options.disposeFails === true) throw new Error('the lease would not go')
          },
        }
      }),
    } as never)
  }
  if (options.without !== 'systemPrompt') {
    ctx.provide('systemPrompt', {
      assemble: options.assemble ?? (async (context: unknown) => {
        assembled.push(context)
        return assembly(options.variables)
      }),
    } as never)
  }
  return { ctx, leases, assembled, disposed: () => disposed, key }
}

/** The text a preview of `main` has when dsh's own assembly can't be had. */
const FALLBACK_MAIN = [
  '[dsh: identity line]',
  'MAIN for {{model}}.',
  '[dsh: tool and skill guidance]',
  '[dsh: environment]',
  'COMMON in {{cwd}}, {{nobody}}.',
].join('\n\n')

// --- the assembly ---------------------------------------------------------------------------------

test('a preview is dsh\'s own assembly with the role\'s texts in the persona sections, rendered', async () => {
  const stub = stubs()
  const preview = await buildPreview(stub.ctx, prompts(), 'main')
  assert.deepEqual(preview, {
    text: [
      IDENTITY,
      'MAIN for ‹model›.',
      'Use bash in ‹cwd› for ‹model›.',
      'COMMON in ‹cwd›, {{nobody}}.',
    ].join('\n\n'),
    approximate: true,
    fallback: false,
    unknownVariables: ['nobody'],
  })
  // The dish preset's scope, leased for the assembly and let go of after it.
  assert.deepEqual(stub.leases, ['dish'])
  assert.deepEqual(stub.assembled, [{ scope: stub.key }])
  assert.equal(stub.disposed(), 1)
  assert.deepEqual(JSON.parse(JSON.stringify(preview)), preview)
})

test('a variable that has a value is replaced by it, and one without by its name in ‹›', async () => {
  const stub = stubs({ variables: { model: 'deepseek-x', cwd: undefined } })
  const { text, unknownVariables } = await buildPreview(stub.ctx, prompts(), 'main')
  assert.ok(text.includes('MAIN for deepseek-x.'), text)
  assert.ok(text.includes('Use bash in ‹cwd› for deepseek-x.'), text)
  assert.deepEqual(unknownVariables, ['nobody'])
})

test('a role off the page is previewed in the prefix position; common is previewed as main', async () => {
  const stub = stubs()
  const crew = await buildPreview(stub.ctx, prompts(), 'coder')
  assert.deepEqual(crew.text.split('\n\n'), [IDENTITY, 'CODER for ‹model›.', 'Use bash in ‹cwd› for ‹model›.', 'COMMON in ‹cwd›, {{nobody}}.'])
  assert.equal(crew.fallback, false)
  assert.ok(!crew.text.includes('MAIN'))
  const common = await buildPreview(stub.ctx, prompts(), 'common')
  const main = await buildPreview(stub.ctx, prompts(), 'main')
  assert.deepEqual(common, main)
  assert.equal(stub.disposed(), 3)
})

test('the texts are the ones the service has now: persona(role), never a snapshot', async () => {
  const stub = stubs()
  const asked: string[] = []
  const service = prompts({ persona: async (role) => { asked.push(role); return TEXTS.main! } })
  await buildPreview(stub.ctx, service, 'coder')
  await buildPreview(stub.ctx, service, 'common')
  assert.deepEqual(asked, ['coder', 'main'])
})

test('a text that can\'t be had is not a fallback: the service\'s own failure is the caller\'s', async () => {
  const stub = stubs()
  await assert.rejects(buildPreview(stub.ctx, prompts({ persona: async () => { throw new Error('the store is gone') } }), 'main'), /the store is gone/)
  assert.deepEqual(stub.leases, [])
})

// --- the fallback ---------------------------------------------------------------------------------

test('without agentPresets or without systemPrompt the preview is the fallback, and says why to `report`', async () => {
  for (const without of ['agentPresets', 'systemPrompt'] as const) {
    const stub = stubs({ without })
    const reported: unknown[] = []
    const preview = await buildPreview(stub.ctx, prompts(), 'main', (error) => { reported.push(error) })
    assert.deepEqual(preview, { text: FALLBACK_MAIN, approximate: true, fallback: true, unknownVariables: [] }, without)
    assert.equal(reported.length, 1, without)
    assert.match(String(reported[0]), new RegExp(without), without)
  }
})

test('any step that throws gives the fallback, and the lease is let go of whatever happens', async () => {
  const reported: unknown[] = []
  const report = (error: unknown): void => { reported.push(error) }

  const scope = stubs({ acquireScope: async () => { throw new Error('unknown agent preset: dish') } })
  assert.deepEqual(await buildPreview(scope.ctx, prompts(), 'main', report), { text: FALLBACK_MAIN, approximate: true, fallback: true, unknownVariables: [] })
  assert.match(String(reported.at(-1)), /unknown agent preset/)

  const assembling = stubs({ assemble: async () => { throw new Error('no agent') } })
  assert.equal((await buildPreview(assembling.ctx, prompts(), 'main', report)).fallback, true)
  assert.match(String(reported.at(-1)), /no agent/)
  assert.equal(assembling.disposed(), 1)

  // A section of dsh's own that names a variable nobody registered: dsh's renderer throws, as it does for an agent.
  const rendering = stubs({
    assemble: async () => {
      const broken = assembly()
      broken.sections.push({ name: 'tool:other', text: 'Uses {{bogus}}.' })
      return broken
    },
  })
  assert.equal((await buildPreview(rendering.ctx, prompts(), 'main', report)).fallback, true)
  assert.match(String(reported.at(-1)), /bogus/)
  assert.equal(rendering.disposed(), 1)

  const leaving = stubs({ disposeFails: true })
  assert.equal((await buildPreview(leaving.ctx, prompts(), 'main', report)).fallback, true)
  assert.match(String(reported.at(-1)), /lease would not go/)
  assert.equal(reported.length, 4)
})

test('the fallback of a crew role has its own text in the prefix position', async () => {
  const stub = stubs({ without: 'systemPrompt' })
  const preview = await buildPreview(stub.ctx, prompts(), 'coder')
  assert.equal(preview.text, FALLBACK_MAIN.replace('MAIN', 'CODER'))
})

// --- variables ------------------------------------------------------------------------------------

test('variables are the names of the assembly with their values, empty where they have none, in name order', async () => {
  const stub = stubs({ variables: { provider: 'acme', model: undefined, cwd: undefined, extra: 'x' } })
  const result = await buildVariables(stub.ctx)
  assert.deepEqual(result, {
    variables: [
      { name: 'cwd', value: '' },
      { name: 'extra', value: 'x' },
      { name: 'model', value: '' },
      { name: 'provider', value: 'acme' },
    ],
    fallback: false,
  })
  assert.equal(stub.disposed(), 1)
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result)
})

test('variables, when the assembly can\'t be had, are none, and say so', async () => {
  const reported: unknown[] = []
  for (const options of [{ without: 'agentPresets' }, { without: 'systemPrompt' }, { assemble: async () => { throw new Error('no') } }] as StubOptions[]) {
    const stub = stubs(options)
    assert.deepEqual(await buildVariables(stub.ctx, (error) => { reported.push(error) }), { variables: [], fallback: true })
  }
  assert.equal(reported.length, 3)
})

// --- through the remote, over a real store --------------------------------------------------------

type Mounted = { remote: PromptsRemote, store: DishConfigService, ctx: Context, state: string }

async function withStore<T>(stub: StubOptions, body: (mounted: Mounted & { stubs: Stubs }) => Promise<T>): Promise<T> {
  const where = await dirs()
  const made = stubs(stub)
  const { ctx } = made
  const config = mountConfig(ctx, where.repository)
  await config
  const plugin = mountPrompts(ctx, where.state)
  await plugin
  try {
    await seeded(ctx.dishConfig)
    const remote = await waitFor('the remote', () => ctx.get('dishPromptsRemote') as PromptsRemote | undefined)
    return await body({ remote, store: ctx.dishConfig, ctx, state: where.state, stubs: made })
  } finally {
    await plugin.dispose()
    await config.dispose()
  }
}

function ok<T>(outcome: Outcome<T>): T {
  assert.ok(outcome.ok, JSON.stringify(outcome))
  return outcome.value
}

function failed(outcome: Outcome<unknown>, code: ErrorCode): void {
  assert.ok(!outcome.ok, `expected ${code}, got ${JSON.stringify(outcome)}`)
  assert.equal(outcome.code, code, outcome.message)
}

test('preview(role) shows what is in the store now, in the position the role has, and takes no snapshot', async () => {
  await withStore({}, async ({ remote, store, state, stubs: made }) => {
    const common = DEFAULTS.common!.replaceAll('{{cwd}}', '‹cwd›')
    const first = ok(await remote.preview('main'))
    assert.equal(first.fallback, false)
    assert.equal(first.approximate, true)
    assert.equal(first.text, [IDENTITY, DEFAULTS.main!.replaceAll('{{model}}', '‹model›'), 'Use bash in ‹cwd› for ‹model›.', common].join('\n\n'))

    await userWrite(store, 'main', 'Edited main for {{model}} and {{who}}.')
    await userWrite(store, 'coder', 'Edited coder.')
    const edited = ok(await remote.preview('main'))
    assert.equal(edited.text, [IDENTITY, 'Edited main for ‹model› and {{who}}.', 'Use bash in ‹cwd› for ‹model›.', common].join('\n\n'))
    assert.deepEqual(edited.unknownVariables, ['who'])

    const crew = ok(await remote.preview('coder'))
    assert.equal(crew.text, [IDENTITY, 'Edited coder.', 'Use bash in ‹cwd› for ‹model›.', common].join('\n\n'))
    assert.deepEqual(ok(await remote.preview('common')), edited)

    assert.equal(made.disposed(), 4)
    assert.equal(existsSync(`${state}/agents`), false, 'no snapshot was taken')
  })
})

test('preview of a name that is no role is NOT_FOUND, and of a role that is no role at all INVALID', async () => {
  await withStore({}, async ({ remote }) => {
    failed(await remote.preview('nobody'), 'NOT_FOUND')
    failed(await remote.preview('../x'), 'INVALID')
    failed(await remote.preview(''), 'INVALID')
  })
})

test('with no store the preview is made from the shipped defaults', async () => {
  const where = await dirs()
  const made = stubs()
  await mountPrompts(made.ctx, where.state)
  const remote = await waitFor('the remote', () => made.ctx.get('dishPromptsRemote') as PromptsRemote | undefined)
  const preview = ok(await remote.preview('main'))
  assert.equal(preview.fallback, false)
  assert.ok(preview.text.includes('You are dish\'s main agent, powered by the ‹model› model.'), preview.text)
  assert.ok(preview.text.endsWith('Your working directory is ‹cwd›.\n'), preview.text)
  assert.deepEqual(preview.unknownVariables, [])
})

test('the fallback is logged once per process, however many previews and variable reads fall back', async () => {
  await withStore({ acquireScope: async () => { throw new Error('unknown agent preset: dish') } }, async ({ remote, ctx }) => {
    const logs = watchLogs(ctx)
    const first = ok(await remote.preview('main'))
    assert.equal(first.fallback, true)
    assert.ok(first.text.startsWith('[dsh: identity line]\n\n'), first.text)
    assert.ok(first.text.includes('\n\n[dsh: tool and skill guidance]\n\n[dsh: environment]\n\n'), first.text)
    ok(await remote.preview('coder'))
    assert.deepEqual(ok(await remote.variables()), { variables: [], fallback: true })
    assert.equal(logs.length, 1, logs.join('\n'))
    assert.match(logs[0]!, /^\[dish-prompts\] warn: .*unknown agent preset: dish/)
  })
})

test('variables(), through the remote, are the assembly\'s', async () => {
  await withStore({ variables: { model: undefined, cwd: undefined, provider: 'acme' } }, async ({ remote, ctx }) => {
    const logs = watchLogs(ctx)
    assert.deepEqual(ok(await remote.variables()), {
      variables: [{ name: 'cwd', value: '' }, { name: 'model', value: '' }, { name: 'provider', value: 'acme' }],
      fallback: false,
    })
    assert.deepEqual(logs, [])
  })
})

// --- with dsh's own SystemPrompt ------------------------------------------------------------------

test('on dsh\'s own SystemPrompt the preview is the identity line, main.md, the guidance and common.md, and no fallback', async () => {
  const where = await dirs()
  const ctx = new Context()
  const logs = watchLogs(ctx)
  await ctx.plugin(SystemPrompt, { personaPrefix: 'global prefix', personaSuffix: 'global suffix' })
  ctx.systemPrompt.variable('model', () => undefined)
  ctx.systemPrompt.variable('cwd', () => undefined)
  ctx.systemPrompt.variable('provider', () => 'acme')
  ctx.systemPrompt.section({ name: 'tool:bash', order: 1000, text: 'Use bash in {{cwd}}.' })
  // The registry's stand-in: any scope key does, there are no scoped registrations in this context.
  ctx.provide('agentPresets', { acquireScope: async () => ({ key: {}, [Symbol.asyncDispose]: async () => {} }) } as never)
  await mountPrompts(ctx, where.state)
  const remote = await waitFor('the remote', () => ctx.get('dishPromptsRemote') as PromptsRemote | undefined)

  const preview = ok(await remote.preview('main'))
  assert.equal(preview.fallback, false)
  assert.equal(preview.text, [
    'You are an AI agent powered by DeepSeek Harness.',
    DEFAULTS.main!.replaceAll('{{model}}', '‹model›'),
    'Use bash in ‹cwd›.',
    DEFAULTS.common!.replaceAll('{{cwd}}', '‹cwd›'),
  ].join('\n\n'))
  assert.deepEqual(preview.unknownVariables, [])
  assert.ok(!preview.text.includes('global prefix') && !preview.text.includes('global suffix'))

  const crew = ok(await remote.preview('reviewer'))
  assert.ok(crew.text.startsWith(`You are an AI agent powered by DeepSeek Harness.\n\n${DEFAULTS.reviewer!.replaceAll('{{model}}', '‹model›')}\n\n`), crew.text)
  assert.deepEqual(ok(await remote.variables()), {
    variables: [{ name: 'cwd', value: '' }, { name: 'model', value: '' }, { name: 'provider', value: 'acme' }],
    fallback: false,
  })
  assert.deepEqual(logs, [])
})
