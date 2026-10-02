import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import type { DishConfigService } from 'dish-config'
import { DEFAULTS } from '../src/defaults.ts'
import type { DishSkills } from '../src/index.ts'
import { NAMESPACE, NEW_SKILL_TEMPLATE, RESET_NOTE } from '../src/protocol.ts'
import type { ErrorCode, Outcome, SkillInfo } from '../src/protocol.ts'
import { SkillsRemote } from '../src/remote.ts'
import { SHIPPED_ROLES, checkSkill, pathFor, parseSkill } from '../src/skill.ts'
import { COMMIT, dirs, mountConfig, mountSkills, outsideCommit, provideStub, seeded, skillText, userWrite, waitFor, watchLogs } from './helpers.ts'

const AGENT = { kind: 'agent', sessionId: 's1', role: 'main' } as const
const MINE = skillText('mine', ['main'], 'Do my thing.')
const MINE_TWO = skillText('mine', ['main', 'coder'], 'Do my thing, better.')
const BRAIN_ONE = skillText('brainstorming', ['main'], 'Talk first.')
const BRAIN_TWO = skillText('brainstorming', ['main', 'coder'], 'Talk first, and then talk.')
const SHIPPED_ONLY = 'a shipped skill comes back at the next start; turn it off with `roles: []` instead'

// --- helpers ------------------------------------------------------------------------------------

/** Run `body` with dish-config and dish-skills mounted (and the defaults seeded) in a fresh `Context`. */
async function withRemote<T>(body: (remote: SkillsRemote, store: DishConfigService, ctx: Context, repository: string) => Promise<T>): Promise<T> {
  const where = await dirs()
  const ctx = new Context()
  const config = mountConfig(ctx, where.repository)
  await config
  const skills = mountSkills(ctx)
  await skills
  try {
    await seeded(ctx.dishConfig)
    const remote = await waitFor('the remote', () => ctx.get('dishSkillsRemote') as SkillsRemote | undefined)
    return await body(remote, ctx.dishConfig, ctx, where.repository)
  } finally {
    await skills.dispose()
    await config.dispose()
  }
}

/** Run `body` with dish-skills alone: no store. */
async function withoutStore<T>(body: (remote: SkillsRemote, ctx: Context) => Promise<T>): Promise<T> {
  const ctx = new Context()
  const skills = mountSkills(ctx)
  await skills
  try {
    const remote = await waitFor('the remote', () => ctx.get('dishSkillsRemote') as SkillsRemote | undefined)
    return await body(remote, ctx)
  } finally {
    await skills.dispose()
  }
}

/** The value of a call that succeeded. */
function ok<T>(outcome: Outcome<T>): T {
  assert.ok(outcome.ok, JSON.stringify(outcome))
  return outcome.value
}

/** Assert that a call failed with `code`, as a result and not a throw; the message is returned. */
function failed(outcome: Outcome<unknown>, code: ErrorCode): string {
  assert.ok(!outcome.ok, `expected ${code}, got ${JSON.stringify(outcome)}`)
  assert.equal(outcome.code, code, outcome.message)
  assert.equal(typeof outcome.message, 'string')
  return outcome.message
}

/** What the wire sees of `value`: JSON, with nothing `undefined` in it. */
function plain(value: unknown): void {
  assert.deepStrictEqual(value, JSON.parse(JSON.stringify(value)))
}

function info(skills: SkillInfo[], name: string): SkillInfo {
  const found = skills.find(candidate => candidate.name === name)
  assert.ok(found, `skill ${name}`)
  return found
}

/** What the page is told of a skill that is as shipped and valid. */
function shippedInfo(name: string): SkillInfo {
  const parsed = parseSkill(pathFor(name), DEFAULTS[name]!)
  assert.ok(parsed.ok, name)
  return {
    name,
    path: pathFor(name),
    description: parsed.skill.description,
    roles: parsed.skill.roles,
    modelInvocable: parsed.skill.modelInvocable,
    userInvocable: parsed.skill.userInvocable,
    shipped: true,
    differsFromDefault: false,
    missing: false,
    problem: '',
    pendingProposals: 0,
  }
}

// --- the wire contract ---------------------------------------------------------------------------

const METHODS = ['skills', 'read', 'check', 'save', 'reset', 'remove']

test('SkillsRemote is bound as dishSkillsRemote under the dishSkills namespace, and marks every method', async () => {
  await withRemote(async (remote, _store, ctx) => {
    assert.ok(ctx.get('dishSkillsRemote') !== undefined)
    assert.equal(remote.typertRemote.serviceKey, 'dishSkillsRemote')
    assert.equal(remote.typertRemote.namespace, 'dishSkills')
    assert.equal(NAMESPACE, 'dishSkills')
    assert.ok(remote.typertRemote.service instanceof SkillsRemote)

    const marks = remoteMethods(remote)
    assert.deepEqual(marks.map(mark => mark.method).sort(), [...METHODS].sort())
    for (const mark of marks) {
      assert.deepEqual(mark.invocation, { kind: 'direct' }, mark.method)
      assert.equal(mark.mode, undefined, mark.method)
      assert.equal(mark.exportName, undefined, mark.method)
    }
    // Nothing public is left unmarked: what the page can't call it must not look like it can.
    const own = Object.getOwnPropertyNames(SkillsRemote.prototype)
      .filter(key => key !== 'constructor' && typeof (SkillsRemote.prototype as unknown as Record<string, unknown>)[key] === 'function')
    assert.deepEqual(own.sort(), [...METHODS].sort())
  })
})

/** The gateway's source-mode reading of a method's parameter names: the text between its first parentheses, split on commas. */
function parameterNames(method: (...args: never[]) => unknown): string[] {
  const source = Function.prototype.toString.call(method)
  const open = source.indexOf('(')
  const body = source.slice(open + 1, source.indexOf(')', open + 1)).trim()
  return body === '' ? [] : body.split(',').map(part => part.trim())
}

test('the gateway can read every method\'s parameter names from source, and they are the ones the page sends', () => {
  const expected: Record<string, string[]> = {
    skills: [],
    read: ['name'],
    check: ['name', 'text'],
    save: ['name', 'text', 'base', 'note'],
    reset: ['name', 'base', 'note'],
    remove: ['name', 'base', 'note'],
  }
  for (const method of METHODS) {
    const names = parameterNames((SkillsRemote.prototype as unknown as Record<string, (...args: never[]) => unknown>)[method]!)
    assert.deepEqual(names, expected[method], method)
    for (const name of names) assert.match(name, /^[$A-Z_a-z][$\w]*$/u, `${method}: ${name}`)
  }
})

test('this package, typert-protocol and the agent-preset registry are on one copy of cordis', () => {
  const packageDirectory = (specifier: string): string => {
    let directory = dirname(fileURLToPath(import.meta.resolve(specifier)))
    while (!existsSync(join(directory, 'package.json'))) directory = dirname(directory)
    return realpathSync(directory)
  }
  const own = packageDirectory('@deepseek-ai/cordis')
  for (const specifier of ['@deepseek-ai/dsh-typert-protocol', '@deepseek-ai/dsh-agent-preset-registry']) {
    assert.equal(realpathSync(join(packageDirectory(specifier), '..', 'cordis')), own, specifier)
  }
})

test('protocol.ts imports nothing, so the browser build cannot reach the store through it', () => {
  const source = readFileSync(new URL('../src/protocol.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /^\s*import\s/m)
  assert.doesNotMatch(source, /\brequire\s*\(/)
  assert.equal(RESET_NOTE, 'Reset to the default')
})

// --- the new-skill template ------------------------------------------------------------------------

test('the new-skill template passes parseSkill and checkSkill with nothing to say, and is offered to main only', () => {
  for (const name of ['mine', 'a', 'x-y-z', 'skill-9', 'a'.repeat(64)]) {
    const text = NEW_SKILL_TEMPLATE(name)
    const parsed = parseSkill(pathFor(name), text)
    assert.ok(parsed.ok, `${name}: ${JSON.stringify(parsed)}`)
    assert.equal(parsed.skill.name, name)
    assert.deepEqual(parsed.skill.roles, ['main'])
    assert.match(parsed.skill.description, /^Use when/)
    assert.equal(parsed.skill.modelInvocable, true)
    assert.equal(parsed.skill.userInvocable, true)
    assert.match(parsed.skill.body, /^## Overview/)
    assert.deepEqual(checkSkill(pathFor(name), text, SHIPPED_ROLES), { problems: [], warnings: [], skill: parsed.skill })
  }
})

// --- skills ----------------------------------------------------------------------------------------

test('skills lists the eighteen shipped skills by name at the head, all as shipped, with the roles dish knows', async () => {
  await withRemote(async (remote, store) => {
    const result = await remote.skills()
    plain(result)
    const { commit, skills, roles } = ok(result)
    assert.equal(commit, await store.head())
    assert.match(commit, COMMIT)
    assert.deepEqual(roles, ['main', ...SHIPPED_ROLES.filter(role => role !== 'main').sort()])
    assert.deepEqual(skills.map(skill => skill.name), Object.keys(DEFAULTS).sort())
    assert.equal(skills.length, 18)
    for (const skill of skills) assert.deepEqual(skill, shippedInfo(skill.name), skill.name)
    assert.deepEqual(info(skills, 'brainstorming').roles, ['main'])
    assert.equal(info(skills, 'brainstorming').path, 'skills/brainstorming/SKILL.md')
  })
})

test('a skill the user added is listed as not shipped, and does not differ from a default it has none of', async () => {
  await withRemote(async (remote, store) => {
    await userWrite(store, 'mine', MINE)
    const { skills } = ok(await remote.skills())
    assert.equal(skills.length, 19)
    assert.deepEqual(info(skills, 'mine'), {
      name: 'mine', path: 'skills/mine/SKILL.md', description: 'Use when you need mine.', roles: ['main'],
      modelInvocable: true, userInvocable: true, shipped: false, differsFromDefault: false, missing: false, problem: '', pendingProposals: 0,
    })
    // The list stays sorted by name.
    assert.deepEqual(skills.map(skill => skill.name), [...skills.map(skill => skill.name)].sort())
  })
})

test('an edited shipped skill differs from its default; a skill with invocation switched off says so', async () => {
  await withRemote(async (remote, store) => {
    await userWrite(store, 'brainstorming', BRAIN_ONE)
    const off = ['---', 'name: writing-plans', 'description: Use when planning.', 'disable-model-invocation: true', 'user-invocable: false', 'metadata:', '  roles: []', '---', 'Plan.', ''].join('\n')
    await userWrite(store, 'writing-plans', off)
    const { skills } = ok(await remote.skills())
    assert.equal(info(skills, 'brainstorming').differsFromDefault, true)
    assert.equal(info(skills, 'brainstorming').shipped, true)
    assert.equal(info(skills, 'writing-specs').differsFromDefault, false)
    assert.deepEqual({ ...info(skills, 'writing-plans'), path: undefined }, {
      name: 'writing-plans', path: undefined, description: 'Use when planning.', roles: [], modelInvocable: false, userInvocable: false,
      shipped: true, differsFromDefault: true, missing: false, problem: '', pendingProposals: 0,
    })
  })
})

test('a shipped skill that is missing from the store is listed as missing, as its default, and reads as its default', async () => {
  await withRemote(async (remote, store) => {
    await store.write([{ path: pathFor('writing-skills'), delete: true }], { author: { kind: 'user' } })
    const { skills, commit } = ok(await remote.skills())
    assert.equal(commit, await store.head())
    assert.equal(skills.length, 18)
    assert.deepEqual(info(skills, 'writing-skills'), { ...shippedInfo('writing-skills'), missing: true })
    assert.deepEqual(ok(await remote.read('writing-skills')), {
      text: DEFAULTS['writing-skills'], commit: await store.head(), defaultText: DEFAULTS['writing-skills'], missing: true,
    })
    // The other skills are not missing.
    assert.equal(skills.filter(skill => skill.missing).length, 1)
  })
})

test('an empty store lists every shipped skill as missing, at the store\'s head', async () => {
  const where = await dirs()
  const ctx = new Context()
  const config = mountConfig(ctx, where.repository)
  await config
  const skills = mountSkills(ctx)
  await skills
  try {
    await seeded(ctx.dishConfig)
    const store = ctx.dishConfig
    await store.write(Object.keys(DEFAULTS).map(name => ({ path: pathFor(name), delete: true })), { author: { kind: 'user' } })
    const remote = await waitFor('the remote', () => ctx.get('dishSkillsRemote') as SkillsRemote | undefined)
    const result = ok(await remote.skills())
    assert.equal(result.commit, await store.head())
    assert.equal(result.skills.length, 18)
    for (const skill of result.skills) assert.deepEqual(skill, { ...shippedInfo(skill.name), missing: true }, skill.name)
  } finally {
    await skills.dispose()
    await config.dispose()
  }
})

test('a document that does not parse is listed with its problem and the rest still serve; what is not a skill document is not listed', async () => {
  await withRemote(async (remote, store, _ctx, repository) => {
    await outsideCommit(repository, [
      { path: 'skills/mine/SKILL.md', text: '---\nname: other\ndescription: Use when.\n---\nBody.\n' },
      { path: 'skills/coding/SKILL.md', text: 'no frontmatter at all\n' },
      { path: 'skills/notes.md', text: 'not a skill\n' },
      { path: 'skills/mine/extra.md', text: 'not a skill either\n' },
      { path: 'skills/Bad_Name/SKILL.md', text: '---\nname: x\n---\n' },
    ])
    const result = await remote.skills()
    plain(result)
    const { skills } = ok(result)
    assert.deepEqual(skills.map(skill => skill.name).filter(name => !(name in DEFAULTS)), ['coding', 'mine'])
    const mine = info(skills, 'mine')
    assert.match(mine.problem, /name is "other" but the folder is "mine"/)
    assert.doesNotMatch(mine.problem, /^skills\//)
    assert.deepEqual({ ...mine, problem: undefined }, {
      name: 'mine', path: 'skills/mine/SKILL.md', description: '', roles: null, modelInvocable: false, userInvocable: false,
      shipped: false, differsFromDefault: false, missing: false, problem: undefined, pendingProposals: 0,
    })
    assert.match(info(skills, 'coding').problem, /frontmatter is missing/)
    // The shipped skills are unaffected.
    for (const name of Object.keys(DEFAULTS)) assert.deepEqual(info(skills, name), shippedInfo(name), name)
  })
})

test('a shipped skill that was broken by hand shows its problem, differs from its default and is not missing', async () => {
  await withRemote(async (remote, _store, _ctx, repository) => {
    await outsideCommit(repository, [{ path: 'skills/brainstorming/SKILL.md', text: '---\nname: brainstorming\n---\nBody.\n' }])
    const { skills } = ok(await remote.skills())
    const broken = info(skills, 'brainstorming')
    assert.match(broken.problem, /description is missing/)
    assert.equal(broken.shipped, true)
    assert.equal(broken.differsFromDefault, true)
    assert.equal(broken.missing, false)
    assert.equal(broken.description, '')
    assert.equal(broken.roles, null)
    // It can still be read, to be fixed, and reset to the default.
    assert.match(ok(await remote.read('brainstorming')).text, /Body\./)
    assert.ok(ok(await remote.reset('brainstorming', '', '')))
    assert.deepEqual(info(ok(await remote.skills()).skills, 'brainstorming'), shippedInfo('brainstorming'))
  })
})

test('skills takes the roles from crew when it is there, and from the shipped list when it is not or fails', async () => {
  await withRemote(async (remote, _store, ctx) => {
    assert.deepEqual(ok(await remote.skills()).roles, ['main', 'architect', 'coder', 'ops', 'researcher', 'reviewer', 'writer'])
    const crew = await provideStub(ctx, 'dishCrew', { settings: async () => ({ roles: { coder: {}, analyst: {} } }) })
    assert.deepEqual(ok(await remote.skills()).roles, ['main', 'analyst', 'coder'])
    await crew.dispose()
    const failing = await provideStub(ctx, 'dishCrew', { settings: async () => { throw new Error('crew is down') } })
    assert.equal(ok(await remote.skills()).roles.length, 7)
    await failing.dispose()
  })
})

// --- pending proposals -----------------------------------------------------------------------------

test('pendingProposals counts the open and stale proposals that change the skill\'s document, and not rejected ones', async () => {
  await withRemote(async (remote, store) => {
    const open = await store.propose([{ path: pathFor('brainstorming'), text: BRAIN_ONE }], { author: AGENT, title: 'Talk first', rationale: '' })
    let { skills } = ok(await remote.skills())
    assert.equal(info(skills, 'brainstorming').pendingProposals, 1)
    assert.equal(info(skills, 'writing-specs').pendingProposals, 0)
    assert.equal(info(skills, 'executing-plans').pendingProposals, 0)

    // One that spans two skills counts for each.
    await store.propose([
      { path: pathFor('brainstorming'), text: BRAIN_TWO },
      { path: pathFor('executing-plans'), text: skillText('executing-plans', ['main'], 'Execute.') },
    ], { author: AGENT, title: 'Both', rationale: 'because' })
    skills = ok(await remote.skills()).skills
    assert.equal(info(skills, 'brainstorming').pendingProposals, 2)
    assert.equal(info(skills, 'executing-plans').pendingProposals, 1)

    // A user edit that conflicts makes them stale, and a stale proposal is still pending.
    await userWrite(store, 'brainstorming', skillText('brainstorming', ['main'], 'The user\'s words.'))
    assert.equal((await store.proposals('stale')).length, 2)
    skills = ok(await remote.skills()).skills
    assert.equal(info(skills, 'brainstorming').pendingProposals, 2)

    await store.reject(open.id, 'no', { author: { kind: 'user' } })
    skills = ok(await remote.skills()).skills
    assert.equal(info(skills, 'brainstorming').pendingProposals, 1)
    assert.equal(info(skills, 'executing-plans').pendingProposals, 1)
  })
})

test('a proposal for a new skill, or for one that is missing, is counted where there is a row for it', async () => {
  await withRemote(async (remote, store) => {
    await store.write([{ path: pathFor('writing-skills'), delete: true }], { author: { kind: 'user' } })
    await store.propose([{ path: pathFor('writing-skills'), text: skillText('writing-skills', ['main']) }], { author: AGENT, title: 'Bring it back', rationale: '' })
    await store.propose([{ path: pathFor('fresh'), text: skillText('fresh', ['main']) }], { author: AGENT, title: 'A new one', rationale: '' })
    const { skills } = ok(await remote.skills())
    assert.equal(info(skills, 'writing-skills').missing, true)
    assert.equal(info(skills, 'writing-skills').pendingProposals, 1)
    // `fresh` isn't in the store: the page has no row for it, and the proposal is in the proposals' own list.
    assert.equal(skills.find(skill => skill.name === 'fresh'), undefined)
    assert.equal(skills.length, 18)
  })
})

// --- read ----------------------------------------------------------------------------------------

test('read returns the stored text, the commit it was read at and the shipped default', async () => {
  await withRemote(async (remote, store) => {
    const before = ok(await remote.read('brainstorming'))
    plain(before)
    assert.deepEqual(before, { text: DEFAULTS.brainstorming, commit: await store.head(), defaultText: DEFAULTS.brainstorming, missing: false })
    assert.match(before.commit, COMMIT)

    await userWrite(store, 'brainstorming', BRAIN_ONE)
    const after = ok(await remote.read('brainstorming'))
    assert.deepEqual(after, { text: BRAIN_ONE, commit: await store.head(), defaultText: DEFAULTS.brainstorming, missing: false })
    assert.notEqual(after.commit, before.commit)
  })
})

test('read of a skill the user added has no default (an empty string); one that is neither stored nor shipped is NOT_FOUND', async () => {
  await withRemote(async (remote, store) => {
    await userWrite(store, 'mine', MINE)
    assert.deepEqual(ok(await remote.read('mine')), { text: MINE, commit: await store.head(), defaultText: '', missing: false })
    assert.match(failed(await remote.read('nobody'), 'NOT_FOUND'), /nobody/)
    // Once deleted, a skill the user added is gone for good.
    ok(await remote.remove('mine', '', ''))
    failed(await remote.read('mine'), 'NOT_FOUND')
  })
})

// --- check ---------------------------------------------------------------------------------------

test('check says what is wrong, as the store would: the first problem, and no summary', async () => {
  await withRemote(async (remote) => {
    const result = await remote.check('mine', skillText('other'))
    plain(result)
    const value = ok(result)
    assert.equal(value.problems.length, 1)
    assert.match(value.problems[0]!, /^skills\/mine\/SKILL\.md: name is "other" but the folder is "mine"/)
    assert.deepEqual(value.warnings, [])
    assert.equal(value.summary, null)
    assert.match(ok(await remote.check('mine', '')).problems[0]!, /frontmatter is missing/)
  })
})

test('check of a good document gives its summary, and warnings that do not refuse', async () => {
  await withRemote(async (remote) => {
    const good = ok(await remote.check('mine', MINE))
    plain(good)
    assert.deepEqual(good, {
      problems: [],
      warnings: [],
      summary: { description: 'Use when you need mine.', roles: ['main'], modelInvocable: true, userInvocable: true, chars: MINE.length },
    })

    const everyone = ok(await remote.check('mine', skillText('mine')))
    assert.equal(everyone.summary?.roles, null)

    const unknown = ok(await remote.check('mine', skillText('mine', ['main', 'wizard'])))
    assert.deepEqual(unknown.problems, [])
    assert.equal(unknown.warnings.length, 1)
    assert.match(unknown.warnings[0]!, /role "wizard" isn't a role dish knows \(main, architect, coder, ops, researcher, reviewer, writer\)/)
    assert.deepEqual(unknown.summary?.roles, ['main', 'wizard'])

    const long = ok(await remote.check('mine', skillText('mine', ['main'], 'x'.repeat(9000))))
    assert.deepEqual(long.problems, [])
    assert.match(long.warnings[0]!, /8000/)
    assert.equal(long.summary?.chars, skillText('mine', ['main'], 'x'.repeat(9000)).length)

    const off = ['---', 'name: mine', 'description: Use when.', 'disable-model-invocation: true', 'user-invocable: false', '---', 'Body.'].join('\n')
    const switched = ok(await remote.check('mine', off))
    assert.deepEqual(switched.summary, { description: 'Use when.', roles: null, modelInvocable: false, userInvocable: false, chars: off.length })
  })
})

test('check knows the crew\'s roles when crew is there, and works without a store', async () => {
  await withoutStore(async (remote, ctx) => {
    assert.equal(ctx.get('dishConfig'), undefined)
    assert.equal(ok(await remote.check('mine', skillText('mine', ['analyst']))).warnings.length, 1)
    const crew = await provideStub(ctx, 'dishCrew', { settings: async () => ({ roles: { analyst: {} } }) })
    assert.deepEqual(ok(await remote.check('mine', skillText('mine', ['analyst']))).warnings, [])
    await crew.dispose()
    assert.deepEqual(ok(await remote.check('mine', MINE)).problems, [])
  })
})

// --- save ----------------------------------------------------------------------------------------

test('save creates a skill when the path does not exist, as the user, and the list then has it', async () => {
  await withRemote(async (remote, store, ctx) => {
    const heard: string[][] = []
    ctx.on('dish-config/changed', (paths) => { heard.push(paths) })
    const result = await remote.save('mine', NEW_SKILL_TEMPLATE('mine'), '', '')
    plain(result)
    const commit = ok(result)
    assert.ok(commit)
    assert.deepEqual(commit.author, { kind: 'user' })
    assert.deepEqual(commit.paths, ['skills/mine/SKILL.md'])
    assert.equal(commit.note, undefined)
    assert.equal(await store.read('skills/mine/SKILL.md'), NEW_SKILL_TEMPLATE('mine'))
    assert.equal(await store.head(), commit.id)
    await waitFor('the changed event', () => heard.length > 0)
    assert.deepEqual(heard, [['skills/mine/SKILL.md']])

    const { skills } = ok(await remote.skills())
    assert.equal(info(skills, 'mine').shipped, false)
    assert.equal(info(skills, 'mine').problem, '')
  })
})

test('save carries the note, and a base that is still current is fine', async () => {
  await withRemote(async (remote, store) => {
    const { commit } = ok(await remote.read('brainstorming'))
    const saved = ok(await remote.save('brainstorming', BRAIN_ONE, commit, 'be shorter'))
    assert.ok(saved)
    assert.equal(saved.note, 'be shorter')
    assert.match(saved.message, /be shorter/)
    assert.equal(await store.read('skills/brainstorming/SKILL.md'), BRAIN_ONE)
    assert.equal(info(ok(await remote.skills()).skills, 'brainstorming').differsFromDefault, true)
  })
})

test('save with a base the document has changed since is CONFLICT, and nothing is written; another document does not conflict', async () => {
  await withRemote(async (remote, store) => {
    const { commit } = ok(await remote.read('brainstorming'))
    await userWrite(store, 'brainstorming', BRAIN_ONE)
    const head = await store.head()
    const message = failed(await remote.save('brainstorming', BRAIN_TWO, commit, ''), 'CONFLICT')
    assert.match(message, /skills\/brainstorming\/SKILL\.md/)
    assert.equal(await store.read('skills/brainstorming/SKILL.md'), BRAIN_ONE)
    assert.equal(await store.head(), head)

    // The base is per document: `writing-specs` did not change since `commit`.
    const specs = skillText('writing-specs', ['main'], 'Write specs.')
    assert.ok(ok(await remote.save('writing-specs', specs, commit, '')))
    assert.equal(await store.read('skills/writing-specs/SKILL.md'), specs)
    // A base that is not a commit is NOT_FOUND, as the store has it.
    failed(await remote.save('brainstorming', BRAIN_TWO, '0'.repeat(40), ''), 'NOT_FOUND')
  })
})

test('save of text the store refuses is an INVALID, SECRET or TOO_LARGE result, with the store\'s message', async () => {
  await withRemote(async (remote, store) => {
    // An empty document isn't a skill: the skill format's check says so before the store's own can.
    assert.match(failed(await remote.save('mine', '', '', ''), 'INVALID'), /frontmatter is missing/)
    assert.match(failed(await remote.save('mine', '  \n\t', '', ''), 'INVALID'), /frontmatter is missing/)
    assert.match(failed(await remote.save('mine', skillText('other'), '', ''), 'INVALID'), /name is "other" but the folder is "mine"/)
    assert.match(failed(await remote.save('mine', 'no frontmatter\n', '', ''), 'INVALID'), /frontmatter is missing/)
    assert.match(failed(await remote.save('mine', ['---', 'name: mine', 'description: Use when.', 'modelInvocable: false', '---', 'Body.'].join('\n'), '', ''), 'INVALID'), /unsupported/)
    failed(await remote.save('mine', skillText('mine', null, `token: ghp_${'a'.repeat(40)}`), '', ''), 'SECRET')
    failed(await remote.save('mine', skillText('mine', null, 'x'.repeat(300_000)), '', ''), 'TOO_LARGE')
    // Nothing of that reached the store.
    assert.equal(await store.read('skills/mine/SKILL.md'), undefined)
  })
})

test('save leaves nothing changed (null) when the text is the stored text', async () => {
  await withRemote(async (remote, store) => {
    const head = await store.head()
    assert.equal(ok(await remote.save('brainstorming', DEFAULTS.brainstorming!, '', '')), null)
    assert.equal(await store.head(), head)
  })
})

// --- reset ---------------------------------------------------------------------------------------

test('reset writes the shipped default as the user, and the skill stops differing from it', async () => {
  await withRemote(async (remote, store) => {
    await userWrite(store, 'brainstorming', BRAIN_ONE)
    assert.equal(info(ok(await remote.skills()).skills, 'brainstorming').differsFromDefault, true)
    const { commit } = ok(await remote.read('brainstorming'))

    const reset = ok(await remote.reset('brainstorming', commit, 'back to normal'))
    plain(reset)
    assert.ok(reset)
    assert.deepEqual(reset.author, { kind: 'user' })
    assert.equal(reset.note, 'back to normal')
    assert.deepEqual(reset.paths, ['skills/brainstorming/SKILL.md'])
    assert.equal(await store.read('skills/brainstorming/SKILL.md'), DEFAULTS.brainstorming)
    assert.equal(info(ok(await remote.skills()).skills, 'brainstorming').differsFromDefault, false)
  })
})

test('reset with no note commits with the note "Reset to the default"; a note given stays', async () => {
  await withRemote(async (remote, store) => {
    await userWrite(store, 'brainstorming', BRAIN_ONE)
    const bare = ok(await remote.reset('brainstorming', '', ''))
    plain(bare)
    assert.ok(bare)
    assert.equal(bare.note, RESET_NOTE)
    assert.equal(bare.note, 'Reset to the default')
    assert.equal(await store.read('skills/brainstorming/SKILL.md'), DEFAULTS.brainstorming)
    // The note is in History too, not only in what the call returned.
    const [latest] = await store.history({ path: 'skills/brainstorming/SKILL.md', limit: 1 })
    assert.equal(latest!.id, bare.id)
    assert.equal(latest!.note, 'Reset to the default')

    // A missing note (the client leaves out an `undefined` positional) is an empty one.
    await userWrite(store, 'writing-specs', skillText('writing-specs', ['main']))
    const missing = ok(await remote.reset('writing-specs', '', undefined as unknown as string))
    assert.equal(missing?.note, 'Reset to the default')

    await userWrite(store, 'brainstorming', BRAIN_TWO)
    assert.equal(ok(await remote.reset('brainstorming', '', 'back to normal'))?.note, 'back to normal')
  })
})

test('reset when the skill already is the default changes nothing (null); a missing one is written back', async () => {
  await withRemote(async (remote, store) => {
    const head = await store.head()
    assert.equal(ok(await remote.reset('brainstorming', '', '')), null)
    assert.equal(ok(await remote.reset('writing-specs', head, '')), null)
    assert.equal(await store.head(), head)

    await store.write([{ path: pathFor('writing-skills'), delete: true }], { author: { kind: 'user' } })
    assert.equal(info(ok(await remote.skills()).skills, 'writing-skills').missing, true)
    const back = ok(await remote.reset('writing-skills', '', ''))
    assert.ok(back)
    assert.equal(await store.read('skills/writing-skills/SKILL.md'), DEFAULTS['writing-skills'])
    assert.equal(info(ok(await remote.skills()).skills, 'writing-skills').missing, false)
  })
})

test('reset with a stale base is CONFLICT; a skill with no shipped default can\'t be reset (INVALID)', async () => {
  await withRemote(async (remote, store) => {
    const { commit } = ok(await remote.read('brainstorming'))
    await userWrite(store, 'brainstorming', BRAIN_ONE)
    failed(await remote.reset('brainstorming', commit, ''), 'CONFLICT')
    assert.equal(await store.read('skills/brainstorming/SKILL.md'), BRAIN_ONE)

    await userWrite(store, 'mine', MINE)
    assert.match(failed(await remote.reset('mine', '', ''), 'INVALID'), /no shipped default/)
    assert.match(failed(await remote.reset('nobody', '', ''), 'INVALID'), /no shipped default/)
    assert.equal(await store.read('skills/mine/SKILL.md'), MINE)
  })
})

// --- remove --------------------------------------------------------------------------------------

test('remove deletes a skill the user added, as the user, with the note, and it is gone from the list', async () => {
  await withRemote(async (remote, store) => {
    await userWrite(store, 'mine', MINE)
    const { commit } = ok(await remote.read('mine'))
    const removed = ok(await remote.remove('mine', commit, 'not needed'))
    plain(removed)
    assert.ok(removed)
    assert.deepEqual(removed.author, { kind: 'user' })
    assert.equal(removed.note, 'not needed')
    assert.deepEqual(removed.paths, ['skills/mine/SKILL.md'])
    assert.equal(await store.read('skills/mine/SKILL.md'), undefined)
    const { skills } = ok(await remote.skills())
    assert.equal(skills.length, 18)
    assert.equal(skills.find(skill => skill.name === 'mine'), undefined)
    // The deletion is in History, and so can be reverted.
    const [latest] = await store.history({ path: 'skills/mine/SKILL.md', limit: 1 })
    assert.equal(latest!.id, removed.id)
  })
})

test('remove of a shipped skill is INVALID and says what to do instead; nothing is written', async () => {
  await withRemote(async (remote, store) => {
    const head = await store.head()
    for (const name of Object.keys(DEFAULTS)) {
      assert.equal(failed(await remote.remove(name, '', ''), 'INVALID'), SHIPPED_ONLY, name)
    }
    assert.equal(await store.head(), head)
    assert.equal(await store.read('skills/brainstorming/SKILL.md'), DEFAULTS.brainstorming)
  })
})

test('remove of a skill that is not in the store is NOT_FOUND', async () => {
  await withRemote(async (remote, store) => {
    assert.match(failed(await remote.remove('nobody', '', ''), 'NOT_FOUND'), /nobody/)
    // A shipped skill that was deleted is still shipped: it comes back, and so it can't be removed either.
    await store.write([{ path: pathFor('writing-skills'), delete: true }], { author: { kind: 'user' } })
    assert.equal(failed(await remote.remove('writing-skills', '', ''), 'INVALID'), SHIPPED_ONLY)
  })
})

test('remove with a base the document has changed since is CONFLICT, and the document stays', async () => {
  await withRemote(async (remote, store) => {
    await userWrite(store, 'mine', MINE)
    const { commit } = ok(await remote.read('mine'))
    await userWrite(store, 'mine', MINE_TWO)
    failed(await remote.remove('mine', commit, ''), 'CONFLICT')
    assert.equal(await store.read('skills/mine/SKILL.md'), MINE_TWO)
    assert.ok(ok(await remote.remove('mine', '', '')))
    assert.equal(await store.read('skills/mine/SKILL.md'), undefined)
  })
})

test('remove deletes a skill that is a problem, so a hand-broken document of the user\'s can be cleared away', async () => {
  await withRemote(async (remote, store, _ctx, repository) => {
    await outsideCommit(repository, [{ path: 'skills/coding/SKILL.md', text: 'broken\n' }])
    assert.match(info(ok(await remote.skills()).skills, 'coding').problem, /frontmatter is missing/)
    assert.ok(ok(await remote.remove('coding', '', '')))
    assert.equal(await store.read('skills/coding/SKILL.md'), undefined)
  })
})

// --- no store ------------------------------------------------------------------------------------

test('without dishConfig, read and skills give the shipped defaults, and save, reset and remove are UNAVAILABLE', async () => {
  await withoutStore(async (remote, ctx) => {
    assert.equal(ctx.get('dishConfig'), undefined)
    const result = ok(await remote.skills())
    plain(result)
    assert.equal(result.commit, '')
    assert.equal(result.skills.length, 18)
    assert.deepEqual(result.skills.map(skill => skill.name), Object.keys(DEFAULTS).sort())
    for (const skill of result.skills) assert.deepEqual(skill, shippedInfo(skill.name), skill.name)
    assert.deepEqual(result.roles, ['main', 'architect', 'coder', 'ops', 'researcher', 'reviewer', 'writer'])

    for (const name of Object.keys(DEFAULTS)) {
      assert.deepEqual(ok(await remote.read(name)), { text: DEFAULTS[name], commit: '', defaultText: DEFAULTS[name], missing: false }, name)
    }
    failed(await remote.read('nobody'), 'NOT_FOUND')

    assert.match(failed(await remote.save('mine', MINE, '', ''), 'UNAVAILABLE'), /config store/)
    failed(await remote.reset('brainstorming', '', ''), 'UNAVAILABLE')
    failed(await remote.remove('mine', '', ''), 'UNAVAILABLE')
    // A shipped skill is refused for its own reason, store or not.
    assert.equal(failed(await remote.remove('brainstorming', '', ''), 'INVALID'), SHIPPED_ONLY)
    // A reset of a name that has no default is still INVALID, not UNAVAILABLE.
    failed(await remote.reset('mine', '', ''), 'INVALID')
  })
})

test('a store that comes and goes is looked up on every call', async () => {
  const where = await dirs()
  const ctx = new Context()
  const skills = mountSkills(ctx)
  await skills
  try {
    const remote = await waitFor('the remote', () => ctx.get('dishSkillsRemote') as SkillsRemote | undefined)
    failed(await remote.save('brainstorming', BRAIN_ONE, '', ''), 'UNAVAILABLE')
    assert.equal(ok(await remote.skills()).commit, '')
    const config = mountConfig(ctx, where.repository)
    await config
    await seeded(ctx.dishConfig)
    assert.ok(ok(await remote.save('brainstorming', BRAIN_ONE, '', '')))
    assert.equal(ok(await remote.read('brainstorming')).text, BRAIN_ONE)
    assert.equal(ok(await remote.skills()).commit, await ctx.dishConfig.head())
    await config.dispose()
    failed(await remote.save('brainstorming', BRAIN_TWO, '', ''), 'UNAVAILABLE')
    assert.equal(ok(await remote.read('brainstorming')).text, DEFAULTS.brainstorming)
    assert.equal(ok(await remote.skills()).commit, '')
  } finally {
    await skills.dispose()
  }
})

// --- what comes off the wire ---------------------------------------------------------------------

test('a name that is no skill name is INVALID in every method that takes one', async () => {
  await withRemote(async (remote) => {
    const bad = ['A', '../x', '', 'a/b', 'a b', 'x_y', '-x', 'x-', 'x--y', 'SKILL.md', 'skills/mine/SKILL.md', 'Mine', 'a'.repeat(65)]
    for (const name of bad) {
      failed(await remote.read(name), 'INVALID')
      failed(await remote.check(name, MINE), 'INVALID')
      failed(await remote.save(name, MINE, '', ''), 'INVALID')
      failed(await remote.reset(name, '', ''), 'INVALID')
      failed(await remote.remove(name, '', ''), 'INVALID')
    }
    for (const name of [undefined, null, 7, {}, ['mine']] as unknown as string[]) {
      failed(await remote.read(name), 'INVALID')
      failed(await remote.check(name, MINE), 'INVALID')
      failed(await remote.save(name, MINE, '', ''), 'INVALID')
      failed(await remote.reset(name, '', ''), 'INVALID')
      failed(await remote.remove(name, '', ''), 'INVALID')
    }
  })
})

test('the other parameters: a missing one is an empty one, and one that is not a string is INVALID', async () => {
  await withRemote(async (remote, store) => {
    const missing = undefined as unknown as string
    // `base` and `note` missing: no base, no note. `text` missing: empty, which a skill can't be.
    assert.ok(ok(await remote.save('brainstorming', BRAIN_ONE, missing, missing)))
    failed(await remote.save('brainstorming', missing, '', ''), 'INVALID')
    assert.ok(ok(await remote.reset('brainstorming', missing, missing)))
    assert.equal(await store.read('skills/brainstorming/SKILL.md'), DEFAULTS.brainstorming)
    assert.match(ok(await remote.check('mine', missing)).problems[0]!, /frontmatter is missing/)
    await userWrite(store, 'mine', MINE)
    assert.ok(ok(await remote.remove('mine', missing, missing)))

    failed(await remote.save('mine', 5 as unknown as string, '', ''), 'INVALID')
    failed(await remote.save('mine', MINE, 5 as unknown as string, ''), 'INVALID')
    failed(await remote.save('mine', MINE, '', 5 as unknown as string), 'INVALID')
    failed(await remote.check('mine', 5 as unknown as string), 'INVALID')
    failed(await remote.reset('brainstorming', null as unknown as string, ''), 'INVALID')
    failed(await remote.reset('brainstorming', '', {} as unknown as string), 'INVALID')
    failed(await remote.remove('mine', 5 as unknown as string, ''), 'INVALID')
    failed(await remote.remove('mine', '', ['x'] as unknown as string), 'INVALID')
  })
})

// --- failures that aren't the store's ------------------------------------------------------------

/** A remote over stub services, for failures the real store never produces. */
async function withStubs<T>(store: Partial<DishConfigService>, body: (remote: SkillsRemote) => Promise<T>): Promise<T> {
  const ctx = new Context()
  const skills: DishSkills = {
    catalog: async () => ({ commit: null, skills: [], problems: [] }),
    forRole: async () => [],
    knownRoles: async () => ['main'],
    defaultText: name => name === 'brainstorming' ? DEFAULTS.brainstorming : undefined,
    shipped: () => ['brainstorming'],
    onChange: () => () => {},
    changed: () => {},
  }
  ctx.provide('dishSkills', skills)
  ctx.provide('dishConfig', store as DishConfigService)
  const handle = ctx.plugin(SkillsRemote)
  try {
    await handle
    return await body(ctx.get('dishSkillsRemote') as SkillsRemote)
  } finally {
    await handle.dispose()
  }
}

test('a refusal is recognised by its code, whichever package\'s error it is; anything else is thrown', async () => {
  const coded = (code: string) => Object.assign(new Error(`refused: ${code}`), { code })
  for (const code of ['CONFLICT', 'INVALID', 'UNOWNED', 'FORBIDDEN', 'SECRET', 'TOO_LARGE', 'LOCKED', 'STALE', 'NOT_FOUND'] as const) {
    await withStubs({ write: async () => { throw coded(code) }, head: async () => 'c'.repeat(40) }, async (remote) => {
      assert.equal(failed(await remote.save('mine', MINE, '', ''), code), `refused: ${code}`)
    })
  }
  // A bug, or a failure that isn't a refusal (an errno has a `code` too), is the caller's: thrown, like dish-config's remote does.
  await withStubs({ write: async () => { throw new Error('boom') } }, async (remote) => {
    await assert.rejects(remote.save('mine', MINE, '', ''), /boom/)
  })
  await withStubs({ write: async () => { throw coded('ENOENT') } }, async (remote) => {
    await assert.rejects(remote.save('mine', MINE, '', ''), /ENOENT/)
  })
  await withStubs({ head: async () => { throw new TypeError('not a function') } }, async (remote) => {
    await assert.rejects(remote.read('brainstorming'), TypeError)
    await assert.rejects(remote.skills(), TypeError)
  })
  // A store that is locked answers with its own code, from the first read.
  await withStubs({ head: async () => { throw coded('LOCKED') } }, async (remote) => {
    assert.equal(failed(await remote.skills(), 'LOCKED'), 'refused: LOCKED')
    failed(await remote.read('brainstorming'), 'LOCKED')
  })
})

test('the wire carries JSON: a commit with nothing undefined in it', async () => {
  const commit = { id: 'a'.repeat(40), time: 1, author: { kind: 'user' }, message: 'm', note: undefined, paths: ['skills/mine/SKILL.md'] }
  await withStubs({ write: async () => commit as never }, async (remote) => {
    const saved = ok(await remote.save('mine', MINE, '', ''))
    plain(saved)
    assert.ok(saved && !('note' in saved))
  })
})

test('watchLogs sees nothing from a remote doing its work', async () => {
  await withRemote(async (remote, _store, ctx) => {
    const logs = watchLogs(ctx)
    ok(await remote.skills())
    ok(await remote.read('brainstorming'))
    ok(await remote.check('mine', MINE))
    ok(await remote.save('mine', MINE, '', ''))
    ok(await remote.remove('mine', '', ''))
    assert.deepEqual(logs, [])
  })
})
