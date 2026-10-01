import { execFile } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { format, promisify } from 'node:util'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import Schema from '@deepseek-ai/schemastery'
import SystemPrompt, { PERSONA_PREFIX_SECTION, PERSONA_SUFFIX_SECTION, renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import type { AssembleContext, PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { DEFAULTS } from '../src/defaults.ts'
import { interpolate } from '../src/interpolate.ts'
import * as row from '../src/persona.ts'
import { applyPersona, personaListener } from '../src/persona.ts'
import { pathFor } from '../src/roles.ts'
import type { DishPrompts, Persona } from '../src/service.ts'
import { captureStderr, dirs, mountPrompts, watchLogs } from './helpers.ts'

const run = promisify(execFile)

const PERSONA: Persona = { prefix: 'You are {{model}}, the main agent.', suffix: 'Rules, in {{cwd}}.', commit: 'c'.repeat(40) }

/** An assembly as dsh builds it: the persona sections between other guidance. Each call builds a new one. */
function build(variables: Record<string, string | undefined> = { model: 'deepseek-x', cwd: '/work' }): PromptAssembly {
  return {
    sections: [
      { name: 'harness:identity', text: 'You are an AI agent.' },
      { name: PERSONA_PREFIX_SECTION, text: 'global prefix {{model}}' },
      { name: 'tool:bash', text: 'Use bash.' },
      { name: PERSONA_SUFFIX_SECTION, text: 'global suffix' },
    ],
    contexts: [],
    tools: [],
    variables,
  }
}

function section(assembly: PromptAssembly, name: string) {
  const found = assembly.sections.find(candidate => candidate.name === name)
  assert.ok(found, `section ${name}`)
  return found
}

/** An agent as dsh builds it: a top-level session has no `delegationDepth`; a child has one above zero. */
function agent(id: string, child = false): Agent {
  return { id, session: { header: { id: `session-${id}`, ...child ? { delegationDepth: 1, origin: 'subagent' } : {} } } } as unknown as Agent
}

function assembling(who: Agent | undefined): AssembleContext {
  return who === undefined ? {} : { agent: who }
}

type Spy = DishPrompts & { snapshots: [string, string][], drops: string[] }

/** The service with every method answering, and `snapshot` and `drop` keeping what they are asked. */
function service(overrides: Partial<DishPrompts> = {}): Spy {
  const snapshots: [string, string][] = []
  const drops: string[] = []
  return {
    roles: async () => ['common', 'main'],
    persona: async () => PERSONA,
    snapshot: async (who, role) => {
      snapshots.push([who.id, role])
      return PERSONA
    },
    drop: async (who) => {
      drops.push(who.id)
    },
    defaultText: () => undefined,
    ...overrides,
    snapshots,
    drops,
  }
}

/** A logger that keeps what it is told, formatted. */
function recorder(): { warn(text: string, ...args: unknown[]): void, lines: string[] } {
  const lines: string[] = []
  return { lines, warn: (text, ...args) => { lines.push(format(text, ...args)) } }
}

// --- applyPersona -------------------------------------------------------------------------------

test('applyPersona gives a top-level agent the persona\'s prefix and suffix, interpolated, in place', () => {
  const assembly = build()
  const before = [...assembly.sections]
  assert.deepEqual(applyPersona(assembly, PERSONA, false), [])
  assert.deepEqual(assembly.sections.map(item => item.name), ['harness:identity', PERSONA_PREFIX_SECTION, 'tool:bash', PERSONA_SUFFIX_SECTION])
  assert.equal(assembly.sections[1]!.text, 'You are deepseek-x, the main agent.')
  assert.equal(assembly.sections[3]!.text, 'Rules, in /work.')
  // Interpolated here, so dsh must not do it again.
  assert.equal(assembly.sections[1]!.interpolate, false)
  assert.equal(assembly.sections[3]!.interpolate, false)
  // The same objects, patched: the waterfall's last `next()` returns the original assembly, not a copy.
  assembly.sections.forEach((item, index) => assert.equal(item, before[index], item.name))
  // The other sections are as they were.
  assert.deepEqual(assembly.sections[0], { name: 'harness:identity', text: 'You are an AI agent.' })
  assert.deepEqual(assembly.sections[2], { name: 'tool:bash', text: 'Use bash.' })
  assert.equal(renderPrompt(assembly), 'You are an AI agent.\n\nYou are deepseek-x, the main agent.\n\nUse bash.\n\nRules, in /work.')
})

test('applyPersona keeps a child\'s own prefix, interpolated, and gives it the persona\'s suffix', () => {
  const assembly = build()
  const prefix = section(assembly, PERSONA_PREFIX_SECTION)
  prefix.text = 'You are the coder, on {{model}}.'
  assert.deepEqual(applyPersona(assembly, PERSONA, true), [])
  assert.equal(section(assembly, PERSONA_PREFIX_SECTION), prefix)
  assert.equal(prefix.text, 'You are the coder, on deepseek-x.')
  assert.equal(prefix.interpolate, false)
  assert.equal(section(assembly, PERSONA_SUFFIX_SECTION).text, 'Rules, in /work.')
  assert.equal(section(assembly, PERSONA_SUFFIX_SECTION).interpolate, false)
  assert.ok(!renderPrompt(assembly).includes('main agent'), 'the main role\'s text is not a child\'s')
})

test('applyPersona leaves a child prefix that dsh would render literally exactly as it is', () => {
  const assembly = build()
  Object.assign(section(assembly, PERSONA_PREFIX_SECTION), { text: 'Say {{model}} as is.', interpolate: false })
  assert.deepEqual(applyPersona(assembly, PERSONA, true), [])
  assert.deepEqual(section(assembly, PERSONA_PREFIX_SECTION), { name: PERSONA_PREFIX_SECTION, text: 'Say {{model}} as is.', interpolate: false })
})

test('applyPersona skips a section that is not there, and adds none', () => {
  const withoutSuffix = build()
  withoutSuffix.sections = withoutSuffix.sections.filter(item => item.name !== PERSONA_SUFFIX_SECTION)
  assert.deepEqual(applyPersona(withoutSuffix, PERSONA, false), [])
  assert.deepEqual(withoutSuffix.sections.map(item => item.name), ['harness:identity', PERSONA_PREFIX_SECTION, 'tool:bash'])
  assert.equal(section(withoutSuffix, PERSONA_PREFIX_SECTION).text, 'You are deepseek-x, the main agent.')

  const withoutPrefix = build()
  withoutPrefix.sections = withoutPrefix.sections.filter(item => item.name !== PERSONA_PREFIX_SECTION)
  assert.deepEqual(applyPersona(withoutPrefix, PERSONA, false), [])
  assert.deepEqual(withoutPrefix.sections.map(item => item.name), ['harness:identity', 'tool:bash', PERSONA_SUFFIX_SECTION])
  assert.equal(section(withoutPrefix, PERSONA_SUFFIX_SECTION).text, 'Rules, in /work.')

  const neither = build()
  neither.sections = neither.sections.filter(item => item.name === 'tool:bash')
  const before = structuredClone(neither)
  // Text that nothing receives is not looked at: its names are not reported.
  assert.deepEqual(applyPersona(neither, { ...PERSONA, prefix: '{{nobody}}', suffix: '{{nobody}}' }, false), [])
  assert.deepEqual(neither, before)
})

test('applyPersona leaves a variable with no value as written, and names it once', () => {
  const assembly = build({ model: 'deepseek-x', cwd: undefined })
  const unknown = applyPersona(assembly, {
    prefix: 'A {{nobody}} B {{model}} C {{cwd}} D {{nobody}}',
    suffix: 'E {{cwd}} F {{other_1}}',
    commit: null,
  }, false)
  assert.deepEqual(unknown, ['nobody', 'cwd', 'other_1'])
  assert.equal(section(assembly, PERSONA_PREFIX_SECTION).text, 'A {{nobody}} B deepseek-x C {{cwd}} D {{nobody}}')
  assert.equal(section(assembly, PERSONA_SUFFIX_SECTION).text, 'E {{cwd}} F {{other_1}}')
  // dsh would throw on every one of these. Rendered, they are text.
  assert.equal(renderPrompt(assembly), 'You are an AI agent.\n\nA {{nobody}} B deepseek-x C {{cwd}} D {{nobody}}\n\nUse bash.\n\nE {{cwd}} F {{other_1}}')
})

test('applyPersona renders any text dsh\'s renderPrompt will accept afterwards, and never reads a value as a reference', () => {
  const assembly = build({ model: '{{cwd}}', cwd: '/work' })
  const hostile = '{{ model }} {{Model}} {{}} {{{model}}} {{model}} {{ and an unclosed {{'
  assert.deepEqual(applyPersona(assembly, { prefix: hostile, suffix: '}} {{ {{model}}}}', commit: null }, false), [])
  assert.equal(section(assembly, PERSONA_PREFIX_SECTION).text, '{{ model }} {{Model}} {{}} {{{model}}} {{cwd}} {{ and an unclosed {{')
  assert.equal(section(assembly, PERSONA_SUFFIX_SECTION).text, '}} {{ {{cwd}}}}')
  assert.doesNotThrow(() => renderPrompt(assembly))
})

// --- interpolate against dsh's own renderer ---------------------------------------------------------

test('whatever dsh\'s renderPrompt accepts, interpolate renders to the same text and reports nothing', () => {
  const alphabet = ['{', '}', 'a', 'A', ' ']
  const variableSets: Record<string, string | undefined>[] = [{}, { a: 'X' }, { a: '{{a}}' }, { a: undefined }]
  let texts: string[] = ['']
  let tried = 0
  let accepted = 0
  let replaced = 0
  for (let length = 0; length <= 6; length++) {
    if (length > 0) texts = texts.flatMap(prefix => alphabet.map(character => prefix + character))
    for (const text of texts) {
      for (const variables of variableSets) {
        tried++
        // Never throws, whatever the text.
        const lenient = interpolate(text, variables)
        let rendered: string
        try {
          rendered = renderPrompt({ sections: [{ name: 's', text }], contexts: [], tools: [], variables })
        } catch {
          continue
        }
        accepted++
        if (rendered !== text) replaced++
        assert.deepEqual(lenient, { text: rendered, unknown: [] }, `${JSON.stringify(text)} with ${JSON.stringify(variables)}`)
      }
    }
  }
  // All the strings, so the loop did look: every one tried, dsh accepted most, and it replaced a group in some.
  assert.equal(tried, (5 ** 7 - 1) / 4 * variableSets.length)
  assert.ok(accepted > 10_000, `dsh accepted ${accepted}`)
  // Eleven strings hold a {{a}} (alone, or with one more character before or after), and only {a: 'X'} changes it.
  // dsh refuses one of them, {{{a}}, as malformed: its `{{` at the start has no `}}` to close it.
  assert.equal(replaced, 10)
})

// --- the listener ---------------------------------------------------------------------------------

test('the listener patches the sections for an agent, asks for its snapshot by role, and passes on what next returns', async () => {
  const spy = service()
  const logger = recorder()
  const listener = personaListener({ role: 'main', service: () => spy, logger })
  const assembly = build()
  const sentinel = build()
  let patchedWhenNextRan: string | undefined
  const result = await listener(assembly, assembling(agent('a1')), async () => {
    patchedWhenNextRan = section(assembly, PERSONA_PREFIX_SECTION).text
    return sentinel
  })
  assert.equal(result, sentinel, 'what next returns is what the listener returns')
  assert.equal(patchedWhenNextRan, 'You are deepseek-x, the main agent.', 'later listeners see the persona')
  assert.deepEqual(spy.snapshots, [['a1', 'main']])
  assert.equal(section(assembly, PERSONA_SUFFIX_SECTION).text, 'Rules, in /work.')
  assert.deepEqual(logger.lines, [])
})

test('the listener treats a child differently from a top-level agent', async () => {
  const listener = personaListener({ role: 'main', service: () => service(), logger: recorder() })
  const top = build()
  await listener(top, assembling(agent('top')), async () => top)
  assert.equal(section(top, PERSONA_PREFIX_SECTION).text, 'You are deepseek-x, the main agent.')
  const child = build()
  section(child, PERSONA_PREFIX_SECTION).text = 'You are the coder.'
  await listener(child, assembling(agent('kid', true)), async () => child)
  assert.equal(section(child, PERSONA_PREFIX_SECTION).text, 'You are the coder.')
  assert.equal(section(child, PERSONA_SUFFIX_SECTION).text, 'Rules, in /work.')
  // An agent that can't be told apart from a child, which is how dsh builds one with no session header, is one.
  const unknown = build()
  await listener(unknown, assembling({ id: 'x' } as unknown as Agent), async () => unknown)
  assert.equal(section(unknown, PERSONA_PREFIX_SECTION).text, 'global prefix deepseek-x')
})

test('the listener leaves an assembly for no agent alone, without asking the service or saying anything', async () => {
  const spy = service()
  const logger = recorder()
  const listener = personaListener({ role: 'main', service: () => spy, logger })
  const assembly = build()
  const before = structuredClone(assembly)
  assert.equal(await listener(assembly, assembling(undefined), async () => assembly), assembly)
  assert.deepEqual(assembly, before)
  assert.deepEqual(spy.snapshots, [])
  const missing = personaListener({ role: 'main', service: () => undefined, logger })
  assert.equal(await missing(assembly, assembling(undefined), async () => assembly), assembly)
  assert.deepEqual(logger.lines, [])
})

test('with no dishPrompts the listener leaves the assembly alone and warns once, however many steps; the service is looked up every time', async () => {
  const logger = recorder()
  let current: DishPrompts | undefined
  const listener = personaListener({ role: 'main', service: () => current, logger })
  for (const who of ['a1', 'a1', 'a2']) {
    const assembly = build()
    const before = structuredClone(assembly)
    assert.equal(await listener(assembly, assembling(agent(who)), async () => assembly), assembly)
    assert.deepEqual(assembly, before)
  }
  assert.equal(logger.lines.length, 1)
  assert.match(logger.lines[0]!, /dishPrompts/)
  assert.match(logger.lines[0]!, /dish-prompts/)
  // It comes up later: the next step has the persona.
  current = service()
  const assembly = build()
  await listener(assembly, assembling(agent('a1')), async () => assembly)
  assert.equal(section(assembly, PERSONA_PREFIX_SECTION).text, 'You are deepseek-x, the main agent.')
  assert.equal(logger.lines.length, 1)
})

test('a snapshot that fails leaves the assembly alone and is logged once per agent, and the step goes on', async () => {
  const logger = recorder()
  const listener = personaListener({
    role: 'reviewer',
    service: () => service({ snapshot: async () => { throw new Error('the store is gone') } }),
    logger,
  })
  for (const who of ['a1', 'a1', 'a1', 'a2']) {
    const assembly = build()
    const before = structuredClone(assembly)
    let nexts = 0
    assert.equal(await listener(assembly, assembling(agent(who)), async () => { nexts++; return assembly }), assembly)
    assert.equal(nexts, 1)
    assert.deepEqual(assembly, before)
  }
  assert.equal(logger.lines.length, 2)
  assert.match(logger.lines[0]!, /a1/)
  assert.match(logger.lines[0]!, /reviewer/)
  assert.match(logger.lines[0]!, /the store is gone/)
  assert.match(logger.lines[1]!, /a2/)
})

test('a snapshot that throws without rejecting is the same as one that rejects', async () => {
  const logger = recorder()
  const listener = personaListener({
    role: 'main',
    service: () => service({ snapshot: () => { throw new TypeError('not a promise') } }),
    logger,
  })
  const assembly = build()
  assert.equal(await listener(assembly, assembling(agent('a1')), async () => assembly), assembly)
  assert.equal(logger.lines.length, 1)
  assert.match(logger.lines[0]!, /not a promise/)
})

test('unknown variables are logged once per agent, with their names, and left as written', async () => {
  const logger = recorder()
  const listener = personaListener({
    role: 'main',
    service: () => service({ snapshot: async () => ({ prefix: 'A {{nobody}} {{model}}', suffix: '{{other}} {{nobody}}', commit: null }) }),
    logger,
  })
  for (const who of ['a1', 'a1', 'a2', 'a1']) {
    const assembly = build()
    await listener(assembly, assembling(agent(who)), async () => assembly)
    assert.equal(section(assembly, PERSONA_PREFIX_SECTION).text, 'A {{nobody}} deepseek-x')
    assert.equal(section(assembly, PERSONA_SUFFIX_SECTION).text, '{{other}} {{nobody}}')
  }
  assert.equal(logger.lines.length, 2)
  assert.match(logger.lines[0]!, /a1/)
  assert.match(logger.lines[0]!, /\{\{nobody\}\}/)
  assert.match(logger.lines[0]!, /\{\{other\}\}/)
  assert.match(logger.lines[1]!, /a2/)
})

test('a section the listener can\'t patch is logged once per agent, and the step goes on', async () => {
  const logger = recorder()
  const listener = personaListener({ role: 'main', service: () => service(), logger })
  const assembly = build()
  Object.freeze(section(assembly, PERSONA_PREFIX_SECTION))
  Object.freeze(section(assembly, PERSONA_SUFFIX_SECTION))
  for (let step = 0; step < 3; step++) {
    assert.equal(await listener(assembly, assembling(agent('a1')), async () => assembly), assembly)
  }
  assert.equal(logger.lines.length, 1)
  assert.match(logger.lines[0]!, /a1/)
})

test('with no service, a child\'s own prefix is still rendered leniently, so its typo can\'t fail its step; a top-level agent is left alone', async () => {
  const logger = recorder()
  const listener = personaListener({ role: 'main', service: () => undefined, logger })
  const child = build()
  const prefix = section(child, PERSONA_PREFIX_SECTION)
  prefix.text = 'You are the coder, on {{model}}. {{typo}} {{ bad }}'
  const suffix = { ...section(child, PERSONA_SUFFIX_SECTION) }
  assert.throws(() => renderPrompt(child), /typo/, 'as it is, dsh would fail the child\'s step')
  assert.equal(await listener(child, assembling(agent('kid', true)), async () => child), child)
  assert.equal(section(child, PERSONA_PREFIX_SECTION), prefix)
  assert.equal(prefix.text, 'You are the coder, on deepseek-x. {{typo}} {{ bad }}')
  assert.equal(prefix.interpolate, false)
  assert.deepEqual(section(child, PERSONA_SUFFIX_SECTION), suffix, 'the suffix is not the child\'s to set without a service')
  assert.doesNotThrow(() => renderPrompt(child))
  assert.equal(logger.lines.length, 2, logger.lines.join('\n'))
  assert.match(logger.lines[0]!, /dishPrompts/)
  assert.match(logger.lines[1]!, /kid/)
  assert.match(logger.lines[1]!, /\{\{typo\}\}/)

  const top = build()
  section(top, PERSONA_PREFIX_SECTION).text = 'global prefix {{typo}}'
  const before = structuredClone(top)
  await listener(top, assembling(agent('top')), async () => top)
  assert.deepEqual(top, before)
})

test('when its snapshot fails, a child\'s own prefix is still rendered leniently; a top-level agent is left alone', async () => {
  const logger = recorder()
  const listener = personaListener({
    role: 'reviewer',
    service: () => service({ snapshot: async () => { throw new Error('the store is gone') } }),
    logger,
  })
  const child = build()
  const prefix = section(child, PERSONA_PREFIX_SECTION)
  prefix.text = 'You are the coder, on {{model}}. {{typo}}'
  await listener(child, assembling(agent('kid', true)), async () => child)
  assert.equal(prefix.text, 'You are the coder, on deepseek-x. {{typo}}')
  assert.equal(prefix.interpolate, false)
  assert.equal(section(child, PERSONA_SUFFIX_SECTION).text, 'global suffix')
  assert.doesNotThrow(() => renderPrompt(child))
  assert.equal(logger.lines.length, 2, logger.lines.join('\n'))
  assert.match(logger.lines[0]!, /the store is gone/)
  assert.match(logger.lines[1]!, /\{\{typo\}\}/)

  const top = build()
  section(top, PERSONA_PREFIX_SECTION).text = 'global prefix {{typo}}'
  const before = structuredClone(top)
  await listener(top, assembling(agent('top')), async () => top)
  assert.deepEqual(top, before)

  // A child prefix that dsh would render literally stays literal on this path too.
  const literal = build()
  Object.assign(section(literal, PERSONA_PREFIX_SECTION), { text: 'Say {{typo}} as is.', interpolate: false })
  const kept = structuredClone(literal)
  await listener(literal, assembling(agent('kid2', true)), async () => literal)
  assert.deepEqual(literal, kept)
})

test('a child whose sections can\'t be patched on a failure path is still not a failure', async () => {
  const logger = recorder()
  const listener = personaListener({ role: 'main', service: () => service(), logger })
  const child = build()
  Object.freeze(section(child, PERSONA_PREFIX_SECTION))
  Object.freeze(section(child, PERSONA_SUFFIX_SECTION))
  assert.equal(await listener(child, assembling(agent('kid', true)), async () => child), child)
  assert.equal(logger.lines.length, 1, logger.lines.join('\n'))
})

test('forget lets an agent be told about again, and leaves the row-wide warning and other agents as they were', async () => {
  const logger = recorder()
  let current: DishPrompts | undefined
  const listener = personaListener({ role: 'main', service: () => current, logger })
  const step = async (id: string) => {
    const assembly = build()
    await listener(assembly, assembling(agent(id)), async () => assembly)
  }
  // No service: once, for the row.
  await step('a1')
  await step('a2')
  assert.equal(logger.lines.length, 1)
  listener.forget('a1')
  await step('a1')
  assert.equal(logger.lines.length, 1, 'the row-wide warning is not an agent\'s')

  // A snapshot that fails, and a prompt with a variable with no value: an agent's own.
  current = service({ snapshot: async () => { throw new Error('the store is gone') } })
  await step('a1')
  await step('a2')
  assert.equal(logger.lines.length, 3)
  await step('a1')
  await step('a2')
  assert.equal(logger.lines.length, 3)
  listener.forget('a1')
  await step('a1')
  await step('a2')
  assert.equal(logger.lines.length, 4)
  assert.match(logger.lines[3]!, /a1/)

  current = service({ snapshot: async () => ({ prefix: '{{nobody}}', suffix: '', commit: null }) })
  await step('a1')
  await step('a1')
  assert.equal(logger.lines.length, 5)
  listener.forget('a1')
  await step('a1')
  assert.equal(logger.lines.length, 6)
  assert.match(logger.lines[5]!, /\{\{nobody\}\}/)
  // Forgetting an agent never told about is nothing.
  listener.forget('never-seen')
})

// --- the row --------------------------------------------------------------------------------------

/** A context with a `systemPrompt` that does nothing, which is all the row asks of it: its events are `ctx`'s. */
function contextWithStubs(): Context {
  const ctx = new Context()
  ctx.provide('systemPrompt', {} as never)
  return ctx
}

test('the row is the preset row of dish-prompts: a name, systemPrompt required, dishPrompts not injected', () => {
  assert.equal(row.name, 'dish-prompts-persona')
  assert.deepEqual(row.inject, ['systemPrompt'])
  assert.equal(typeof row.apply, 'function')
})

test('the row is configured with a role, and a role that isn\'t one fails the load, once', async () => {
  const ctx = contextWithStubs()
  ctx.provide('dishPrompts', service())
  for (const bad of [undefined, null, '', 'common', 'Main', 'a b', 'a/b', 'x_y', '1x', 'main.md', 7]) {
    const config = bad === undefined ? {} : { role: bad }
    await assert.rejects(async () => { await ctx.plugin(row, config as row.Config) }, (error: Error) => /role/.test(error.message), `role ${JSON.stringify(bad)}`)
  }
  // Nothing of the failed loads is left: an assembly goes through untouched.
  const assembly = build()
  const before = structuredClone(assembly)
  await ctx.waterfall('system-prompt/assemble', assembly, assembling(agent('a1')), () => Promise.resolve(assembly))
  assert.deepEqual(assembly, before)
  for (const good of ['main', 'coder', 'my-role2']) {
    await ctx.plugin(row, { role: good })
  }
})

test('the role pattern says what roles.ts says a role is, and says it again after the schema is serialized and revived', () => {
  const alphabet = ['a', 'Z', '1', '-', '_', '/', '.', ' ', '\n']
  const candidates = ['', 'main', 'common', 'commons', 'xcommon', 'uncommon', 'coder', 'my-role2', 'common\n', 'main\n']
  let level = ['']
  for (let length = 1; length <= 3; length++) {
    level = level.flatMap(prefix => alphabet.map(character => prefix + character))
    candidates.push(...level)
  }
  const revived = new Schema(JSON.parse(JSON.stringify(row.Config)))
  const accepts = (schema: Schema, role: string): boolean => {
    try {
      schema({ role })
      return true
    } catch {
      return false
    }
  }
  let valid = 0
  for (const role of candidates) {
    let expected = role !== 'common'
    if (expected) {
      try {
        pathFor(role)
      } catch {
        expected = false
      }
    }
    if (expected) valid++
    assert.equal(accepts(row.Config, role), expected, `Config: ${JSON.stringify(role)}`)
    assert.equal(accepts(revived, role), expected, `revived Config: ${JSON.stringify(role)}`)
  }
  assert.equal(valid, 19)  // main, commons, xcommon, uncommon, coder, my-role2, and 13 made of a, 1 and - after an a
  // And a role that is missing, or not a string, is no role either way.
  for (const schema of [row.Config, revived] as Schema[]) {
    assert.throws(() => schema({}), /role/)
    assert.throws(() => schema({ role: 7 }), /role/)
  }
})

test('the row logs as dish-prompts, so the host prints its lines once, and only when its terminal setting is on', async () => {
  const where = await dirs()
  const printed = async (terminal: boolean): Promise<string[]> => {
    const out = captureStderr()
    const ctx = contextWithStubs()
    const host = mountPrompts(ctx, where.state, { terminal })
    try {
      await host
      // A role with the grammar of one, and no default and no store: the host's service can't answer for it.
      await ctx.plugin(row, { role: 'nosuchrole' })
      for (let step = 0; step < 2; step++) {
        const assembly = build()
        await ctx.waterfall('system-prompt/assemble', assembly, assembling(agent('a1')), () => Promise.resolve(assembly))
      }
    } finally {
      await host.dispose()
      out.restore()
    }
    return out.lines()
  }
  const on = await printed(true)
  assert.equal(on.length, 1, on.join('\n'))
  assert.match(on[0]!, /^\[dish-prompts\] warn: could not set the prompt of agent a1 \(role nosuchrole\)/)
  assert.deepEqual(await printed(false), [])
})

test('agent/disposed lets the row tell about an agent\'s trouble again, if the same id comes back', async () => {
  const ctx = contextWithStubs()
  const logs = watchLogs(ctx)
  ctx.provide('dishPrompts', service({ snapshot: async () => { throw new Error('the store is gone') } }))
  await ctx.plugin(row, { role: 'main' })
  const step = async (id: string) => {
    const assembly = build()
    await ctx.waterfall('system-prompt/assemble', assembly, assembling(agent(id)), () => Promise.resolve(assembly))
  }
  await step('a1')
  await step('a2')
  await step('a1')
  assert.equal(logs.length, 2, logs.join('\n'))
  ctx.emit('agent/disposed', { agent: agent('a1') })
  await step('a1')
  await step('a2')
  assert.equal(logs.length, 3, logs.join('\n'))
  assert.match(logs[2]!, /agent a1 /)
})

test('the row patches an assembly dispatched through ctx.waterfall, and the original object is what comes out', async () => {
  const ctx = contextWithStubs()
  const spy = service()
  ctx.provide('dishPrompts', spy)
  await ctx.plugin(row, { role: 'main' })
  const assembly = build()
  const result = await ctx.waterfall('system-prompt/assemble', assembly, assembling(agent('a1')), () => Promise.resolve(assembly))
  assert.equal(result, assembly)
  assert.equal(section(result, PERSONA_PREFIX_SECTION).text, 'You are deepseek-x, the main agent.')
  assert.deepEqual(spy.snapshots, [['a1', 'main']])
  // With no agent it is the assembly dsh built.
  const diagnostic = build()
  const before = structuredClone(diagnostic)
  assert.equal(await ctx.waterfall('system-prompt/assemble', diagnostic, {}, () => Promise.resolve(diagnostic)), diagnostic)
  assert.deepEqual(diagnostic, before)
})

test('the row without dishPrompts leaves the assembly alone, and the service arriving later is used', async () => {
  const ctx = contextWithStubs()
  const logs = watchLogs(ctx)
  await ctx.plugin(row, { role: 'main' })
  for (let step = 0; step < 2; step++) {
    const assembly = build()
    const before = structuredClone(assembly)
    await ctx.waterfall('system-prompt/assemble', assembly, assembling(agent('a1')), () => Promise.resolve(assembly))
    assert.deepEqual(assembly, before)
  }
  assert.equal(logs.length, 1, logs.join('\n'))
  assert.match(logs[0]!, /^\[dish-prompts\] warn: /)
  ctx.provide('dishPrompts', service())
  const assembly = build()
  await ctx.waterfall('system-prompt/assemble', assembly, assembling(agent('a1')), () => Promise.resolve(assembly))
  assert.equal(section(assembly, PERSONA_PREFIX_SECTION).text, 'You are deepseek-x, the main agent.')
})

test('agent/created with source clear drops the agent\'s snapshot; the other sources do not', async () => {
  const ctx = contextWithStubs()
  const spy = service()
  ctx.provide('dishPrompts', spy)
  await ctx.plugin(row, { role: 'main' })
  for (const source of ['startup', 'resume', 'compact', 'clear'] as const) {
    await ctx.serial('agent/created', { agent: agent(`after-${source}`), source })
  }
  assert.deepEqual(spy.drops, ['after-clear'])
})

test('agent/created without dishPrompts, or with a drop that fails, is not a failure', async () => {
  const ctx = contextWithStubs()
  const logs = watchLogs(ctx)
  await ctx.plugin(row, { role: 'main' })
  await ctx.serial('agent/created', { agent: agent('a1'), source: 'clear' })
  assert.deepEqual(logs, [])
  ctx.provide('dishPrompts', service({ drop: async () => { throw new Error('disk on fire') } }))
  await ctx.serial('agent/created', { agent: agent('a1'), source: 'clear' })
  assert.equal(logs.length, 1)
  assert.match(logs[0]!, /disk on fire/)
})

test('with dsh\'s own SystemPrompt and the dishPrompts service on the shipped defaults, an agent\'s prompt is the role\'s', async () => {
  const where = await dirs()
  const ctx = new Context()
  const logs = watchLogs(ctx)
  await ctx.plugin(SystemPrompt, { personaPrefix: 'global prefix', personaSuffix: 'global suffix' })
  ctx.systemPrompt.variable('model', () => 'deepseek-x')
  ctx.systemPrompt.variable('cwd', () => '/work')
  ctx.systemPrompt.section({ name: 'tool:bash', order: 1000, text: 'Use bash in {{cwd}}.' })
  await mountPrompts(ctx, where.state)
  await ctx.plugin(row, { role: 'main' })

  const assembly = await ctx.systemPrompt.assemble({ agent: agent('a1') } as AssembleContext)
  const rendered = renderPrompt(assembly)
  assert.equal(rendered, [
    'You are an AI agent powered by DeepSeek Harness.',
    DEFAULTS.main!.replaceAll('{{model}}', 'deepseek-x'),
    'Use bash in /work.',
    DEFAULTS.common!.replaceAll('{{cwd}}', '/work'),
  ].join('\n\n'))
  assert.ok(!rendered.includes('global prefix') && !rendered.includes('global suffix'))
  // An assembly with no agent, a diagnostic, is dsh's own.
  const diagnostic = renderPrompt(await ctx.systemPrompt.assemble())
  assert.ok(diagnostic.includes('global prefix') && diagnostic.includes('global suffix'))
  assert.deepEqual(logs, [])
})

test('a preset with a complete section gets exactly that section, and nothing throws', async () => {
  const where = await dirs()
  const ctx = new Context()
  const logs = watchLogs(ctx)
  await ctx.plugin(SystemPrompt, { personaPrefix: 'global prefix', personaSuffix: 'global suffix' })
  ctx.systemPrompt.variable('model', () => 'deepseek-x')
  ctx.systemPrompt.variable('cwd', () => '/work')
  ctx.systemPrompt.section({ name: 'preset:everything', order: 50, text: 'All of it, on {{model}}.', complete: true })
  ctx.systemPrompt.section({ name: 'tool:bash', order: 1000, text: 'Use bash in {{cwd}}.' })
  await mountPrompts(ctx, where.state)
  await ctx.plugin(row, { role: 'main' })

  const assembly = await ctx.systemPrompt.assemble({ agent: agent('a1') } as AssembleContext)
  // dsh restores the complete section after the waterfall, so it is the whole prompt, however the row patched.
  assert.deepEqual(assembly.sections.map(item => item.name), ['preset:everything'])
  assert.equal(renderPrompt(assembly), 'All of it, on deepseek-x.')
  assert.deepEqual(logs, [])
})

// --- what the row loads ---------------------------------------------------------------------------------

test('loading the row loads neither defaults.ts nor the service, so the row can\'t be broken by them', async () => {
  const personaUrl = pathToFileURL(fileURLToPath(new URL('../src/persona.ts', import.meta.url))).href
  const script = `
    import { registerHooks } from 'node:module'
    const loaded = []
    registerHooks({ load(url, context, nextLoad) { loaded.push(url); return nextLoad(url, context) } })
    await import(${JSON.stringify(personaUrl)})
    console.log(JSON.stringify(loaded))
  `
  const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script])
  const loaded = (JSON.parse(stdout) as string[]).filter(url => url.startsWith('file:'))
  const ours = loaded.filter(url => url.includes('/plugins/prompts/src/')).map(url => url.slice(url.lastIndexOf('/') + 1)).sort()
  assert.deepEqual(ours, ['interpolate.ts', 'persona.ts'])
  assert.ok(loaded.some(url => url.includes('/dsh-system-prompt/')), 'it did load dsh-system-prompt: the hook sees the packages too')
  // One cordis, whichever of the packages loaded it.
  const cordis = new Set(loaded.filter(url => /\/@deepseek-ai\/cordis\//.test(url)).map(url => url.slice(0, url.indexOf('/@deepseek-ai/cordis/'))))
  assert.ok(cordis.size <= 1, [...cordis].join('\n'))
})

test('this package, dsh-system-prompt and dsh-agent are on one copy of cordis', () => {
  const packageDirectory = (specifier: string): string => {
    let directory = dirname(fileURLToPath(import.meta.resolve(specifier)))
    while (!existsSync(join(directory, 'package.json'))) directory = dirname(directory)
    return realpathSync(directory)
  }
  const own = packageDirectory('@deepseek-ai/cordis')
  for (const specifier of ['@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-agent']) {
    // A pnpm package's own dependencies are its siblings.
    assert.equal(realpathSync(join(packageDirectory(specifier), '..', 'cordis')), own, specifier)
  }
})
