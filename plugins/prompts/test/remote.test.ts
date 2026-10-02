import { existsSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import type { DishConfigService } from 'dish-config'
import { DEFAULTS } from '../src/defaults.ts'
import type { DishPrompts } from '../src/index.ts'
import type { ErrorCode, Outcome, RoleInfo } from '../src/protocol.ts'
import { PromptsRemote } from '../src/remote.ts'
import { CREW_ROLES, pathFor } from '../src/roles.ts'
import { ALL_ROLES, COMMIT, dirs, mountConfig, mountPrompts, seeded, userWrite, waitFor, watchLogs } from './helpers.ts'

const AGENT = { kind: 'agent', sessionId: 's1', role: 'main' } as const
const MAIN_ONE = 'You are dish, one.\n'
const MAIN_TWO = 'You are dish, two.\n'

// --- helpers ------------------------------------------------------------------------------------

/** Run `body` with dish-config and dish-prompts mounted (and the defaults seeded) in a fresh `Context`. */
async function withRemote<T>(body: (remote: PromptsRemote, store: DishConfigService, ctx: Context) => Promise<T>): Promise<T> {
  const where = await dirs()
  const ctx = new Context()
  const config = mountConfig(ctx, where.repository)
  await config
  const prompts = mountPrompts(ctx, where.state)
  await prompts
  try {
    await seeded(ctx.dishConfig)
    const remote = await waitFor('the remote', () => ctx.get('dishPromptsRemote') as PromptsRemote | undefined)
    return await body(remote, ctx.dishConfig, ctx)
  } finally {
    await prompts.dispose()
    await config.dispose()
  }
}

/** Run `body` with dish-prompts alone: no store. */
async function withoutStore<T>(body: (remote: PromptsRemote, ctx: Context) => Promise<T>): Promise<T> {
  const where = await dirs()
  const ctx = new Context()
  const prompts = mountPrompts(ctx, where.state)
  await prompts
  try {
    const remote = await waitFor('the remote', () => ctx.get('dishPromptsRemote') as PromptsRemote | undefined)
    return await body(remote, ctx)
  } finally {
    await prompts.dispose()
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

function info(roles: RoleInfo[], role: string): RoleInfo {
  const found = roles.find(candidate => candidate.role === role)
  assert.ok(found, `role ${role}`)
  return found
}

// --- the wire contract ---------------------------------------------------------------------------

const METHODS = ['roles', 'read', 'save', 'reset', 'preview', 'variables']

test('PromptsRemote is bound as dishPromptsRemote under the dishPrompts namespace, and marks every method', async () => {
  await withRemote(async (remote, _store, ctx) => {
    assert.ok(ctx.get('dishPromptsRemote') !== undefined)
    assert.equal(remote.typertRemote.serviceKey, 'dishPromptsRemote')
    assert.equal(remote.typertRemote.namespace, 'dishPrompts')
    assert.ok(remote.typertRemote.service instanceof PromptsRemote)

    const marks = remoteMethods(remote)
    assert.deepEqual(marks.map(mark => mark.method).sort(), [...METHODS].sort())
    for (const mark of marks) {
      assert.deepEqual(mark.invocation, { kind: 'direct' }, mark.method)
      assert.equal(mark.mode, undefined, mark.method)
      assert.equal(mark.exportName, undefined, mark.method)
    }
    // Nothing public is left unmarked: what the page can't call it must not look like it can.
    const own = Object.getOwnPropertyNames(PromptsRemote.prototype)
      .filter(key => key !== 'constructor' && typeof (PromptsRemote.prototype as unknown as Record<string, unknown>)[key] === 'function')
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
    roles: [],
    read: ['role'],
    save: ['role', 'text', 'base', 'note'],
    reset: ['role', 'base', 'note'],
    preview: ['role'],
    variables: [],
  }
  for (const method of METHODS) {
    const names = parameterNames((PromptsRemote.prototype as unknown as Record<string, (...args: never[]) => unknown>)[method]!)
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

// --- roles ---------------------------------------------------------------------------------------

test('roles lists the eight roles with the agent policy of their namespace, all as shipped', async () => {
  await withRemote(async (remote) => {
    const result = await remote.roles()
    plain(result)
    const roles = ok(result)
    assert.deepEqual(roles.map(role => role.role), ['common', 'main', ...[...CREW_ROLES].sort()])
    assert.equal(roles.length, 8)
    for (const role of roles) {
      assert.equal(role.path, pathFor(role.role))
      assert.equal(role.agent, role.role === 'common' || role.role === 'main' ? 'propose' : 'write', role.role)
      assert.equal(role.differsFromDefault, false, role.role)
      assert.equal(role.missing, false, role.role)
      assert.equal(role.pendingProposals, 0, role.role)
    }
  })
})

test('a role found only in the store is listed, with the write policy and no shipped default', async () => {
  await withRemote(async (remote, store) => {
    await userWrite(store, 'analyst', 'You are the analyst.\n')
    const roles = ok(await remote.roles())
    assert.equal(roles.length, 9)
    assert.deepEqual(info(roles, 'analyst'), {
      role: 'analyst', path: 'prompts/crew/analyst.md', agent: 'write', differsFromDefault: false, missing: false, pendingProposals: 0,
    })
    const read = ok(await remote.read('analyst'))
    assert.deepEqual(read, { text: 'You are the analyst.\n', commit: await store.head(), defaultText: null, missing: false })
  })
})

test('a document that is missing from the store is listed as missing, and reads as its default', async () => {
  await withRemote(async (remote, store) => {
    await store.write([{ path: pathFor('coder'), delete: true }], { author: { kind: 'user' } })
    const roles = ok(await remote.roles())
    assert.deepEqual(info(roles, 'coder'), {
      role: 'coder', path: 'prompts/crew/coder.md', agent: 'write', differsFromDefault: false, missing: true, pendingProposals: 0,
    })
    assert.deepEqual(ok(await remote.read('coder')), { text: DEFAULTS.coder, commit: await store.head(), defaultText: DEFAULTS.coder, missing: true })
  })
})

// --- read ----------------------------------------------------------------------------------------

test('read returns the stored text, the commit it was read at and the shipped default', async () => {
  await withRemote(async (remote, store) => {
    const before = ok(await remote.read('main'))
    plain(before)
    assert.deepEqual(before, { text: DEFAULTS.main, commit: await store.head(), defaultText: DEFAULTS.main, missing: false })
    assert.match(before.commit!, COMMIT)

    await userWrite(store, 'main', MAIN_ONE)
    const after = ok(await remote.read('main'))
    assert.deepEqual(after, { text: MAIN_ONE, commit: await store.head(), defaultText: DEFAULTS.main, missing: false })
    assert.notEqual(after.commit, before.commit)
    assert.equal(ok(await remote.read('common')).defaultText, DEFAULTS.common)
  })
})

test('read of a name that is no role is NOT_FOUND', async () => {
  await withRemote(async (remote) => {
    failed(await remote.read('nobody'), 'NOT_FOUND')
  })
})

// --- save ----------------------------------------------------------------------------------------

test('save without a base writes as the user and returns the commit; the role then differs from its default', async () => {
  await withRemote(async (remote, store, ctx) => {
    const heard: string[][] = []
    ctx.on('dish-config/changed', (paths) => { heard.push(paths) })
    const result = await remote.save('main', MAIN_ONE, '', '')
    plain(result)
    const commit = ok(result)
    assert.ok(commit)
    assert.deepEqual(commit.author, { kind: 'user' })
    assert.deepEqual(commit.paths, ['prompts/main.md'])
    assert.equal(commit.note, undefined)
    assert.equal(await store.read('prompts/main.md'), MAIN_ONE)
    assert.equal(await store.head(), commit.id)
    await waitFor('the changed event', () => heard.length > 0)
    assert.deepEqual(heard, [['prompts/main.md']])

    const roles = ok(await remote.roles())
    assert.equal(info(roles, 'main').differsFromDefault, true)
    assert.equal(info(roles, 'common').differsFromDefault, false)
  })
})

test('save carries the note, and a base that is still current is fine', async () => {
  await withRemote(async (remote, store) => {
    const { commit } = ok(await remote.read('main'))
    const saved = ok(await remote.save('main', MAIN_ONE, commit!, 'be shorter'))
    assert.ok(saved)
    assert.equal(saved.note, 'be shorter')
    assert.match(saved.message, /be shorter/)
    assert.equal(await store.read('prompts/main.md'), MAIN_ONE)
  })
})

test('save with a base the document has changed since is CONFLICT, and nothing is written; another document does not conflict', async () => {
  await withRemote(async (remote, store) => {
    const { commit } = ok(await remote.read('main'))
    await userWrite(store, 'main', MAIN_ONE)
    const head = await store.head()
    const message = failed(await remote.save('main', MAIN_TWO, commit!, ''), 'CONFLICT')
    assert.match(message, /prompts\/main\.md/)
    assert.equal(await store.read('prompts/main.md'), MAIN_ONE)
    assert.equal(await store.head(), head)

    // The base is per document: `common` did not change since `commit`.
    assert.ok(ok(await remote.save('common', 'Shared rules.\n', commit!, '')))
    assert.equal(await store.read('prompts/common.md'), 'Shared rules.\n')
    // A base that is not a commit is NOT_FOUND, as the store has it.
    failed(await remote.save('main', MAIN_TWO, '0'.repeat(40), ''), 'NOT_FOUND')
  })
})

test('save of text the store refuses is an INVALID, SECRET or TOO_LARGE result, with the store\'s message', async () => {
  await withRemote(async (remote, store) => {
    assert.match(failed(await remote.save('main', '', '', ''), 'INVALID'), /can't be empty/)
    assert.match(failed(await remote.save('main', '  \n\t', '', ''), 'INVALID'), /can't be empty/)
    failed(await remote.save('main', `token: ghp_${'a'.repeat(40)}\n`, '', ''), 'SECRET')
    failed(await remote.save('main', 'x'.repeat(300_000), '', ''), 'TOO_LARGE')
    // Nothing of that reached the document.
    assert.equal(await store.read('prompts/main.md'), DEFAULTS.main)
  })
})

test('save leaves nothing changed (null) when the text is the stored text', async () => {
  await withRemote(async (remote, store) => {
    const head = await store.head()
    assert.equal(ok(await remote.save('main', DEFAULTS.main!, '', '')), null)
    assert.equal(await store.head(), head)
  })
})

// --- reset ---------------------------------------------------------------------------------------

test('reset writes the shipped default as the user, and the role stops differing from it', async () => {
  await withRemote(async (remote, store) => {
    await userWrite(store, 'coder', 'Something else.\n')
    assert.equal(info(ok(await remote.roles()), 'coder').differsFromDefault, true)
    const { commit } = ok(await remote.read('coder'))

    const reset = ok(await remote.reset('coder', commit!, 'back to normal'))
    plain(reset)
    assert.ok(reset)
    assert.deepEqual(reset.author, { kind: 'user' })
    assert.equal(reset.note, 'back to normal')
    assert.deepEqual(reset.paths, ['prompts/crew/coder.md'])
    assert.equal(await store.read('prompts/crew/coder.md'), DEFAULTS.coder)
    assert.equal(info(ok(await remote.roles()), 'coder').differsFromDefault, false)
  })
})

test('reset with no note commits with the note "Reset to the default"; a note given stays', async () => {
  await withRemote(async (remote, store) => {
    await userWrite(store, 'coder', 'Something else.\n')
    const bare = ok(await remote.reset('coder', '', ''))
    plain(bare)
    assert.ok(bare)
    assert.equal(bare.note, 'Reset to the default')
    assert.equal(await store.read('prompts/crew/coder.md'), DEFAULTS.coder)
    // The note is in History too, not only in what the call returned.
    const [latest] = await store.history({ path: 'prompts/crew/coder.md', limit: 1 })
    assert.equal(latest!.id, bare.id)
    assert.equal(latest!.note, 'Reset to the default')

    // A missing note (the client leaves out an `undefined` positional) is an empty one.
    await userWrite(store, 'main', MAIN_ONE)
    const missing = ok(await remote.reset('main', '', undefined as unknown as string))
    assert.equal(missing?.note, 'Reset to the default')

    await userWrite(store, 'coder', 'Something else again.\n')
    assert.equal(ok(await remote.reset('coder', '', 'back to normal'))?.note, 'back to normal')
  })
})

test('reset when the document already is the default changes nothing (null)', async () => {
  await withRemote(async (remote, store) => {
    const head = await store.head()
    assert.equal(ok(await remote.reset('main', '', '')), null)
    assert.equal(ok(await remote.reset('common', head, '')), null)
    assert.equal(await store.head(), head)
  })
})

test('reset with a stale base is CONFLICT; a role with no shipped default can\'t be reset (INVALID)', async () => {
  await withRemote(async (remote, store) => {
    const { commit } = ok(await remote.read('main'))
    await userWrite(store, 'main', MAIN_ONE)
    failed(await remote.reset('main', commit!, ''), 'CONFLICT')
    assert.equal(await store.read('prompts/main.md'), MAIN_ONE)

    await userWrite(store, 'analyst', 'You are the analyst.\n')
    assert.match(failed(await remote.reset('analyst', '', ''), 'INVALID'), /no shipped default/)
  })
})

// --- pending proposals ---------------------------------------------------------------------------

test('pendingProposals counts the open and stale proposals that change the role\'s document, and not rejected ones', async () => {
  await withRemote(async (remote, store) => {
    const open = await store.propose([{ path: 'prompts/main.md', text: 'Be concise.\n' }], { author: AGENT, title: 'Be concise', rationale: '' })
    assert.equal(info(ok(await remote.roles()), 'main').pendingProposals, 1)
    assert.equal(info(ok(await remote.roles()), 'common').pendingProposals, 0)
    assert.equal(info(ok(await remote.roles()), 'coder').pendingProposals, 0)

    // One that spans two documents counts for each.
    await store.propose([
      { path: 'prompts/main.md', text: 'Be terse.\n' },
      { path: 'prompts/common.md', text: 'Rules.\n' },
    ], { author: AGENT, title: 'Both', rationale: 'because' })
    let roles = ok(await remote.roles())
    assert.equal(info(roles, 'main').pendingProposals, 2)
    assert.equal(info(roles, 'common').pendingProposals, 1)

    // A user edit that conflicts makes them stale, and a stale proposal is still pending.
    await userWrite(store, 'main', MAIN_ONE)
    assert.equal((await store.proposals('stale')).length, 2)
    roles = ok(await remote.roles())
    assert.equal(info(roles, 'main').pendingProposals, 2)

    await store.reject(open.id, 'no', { author: { kind: 'user' } })
    roles = ok(await remote.roles())
    assert.equal(info(roles, 'main').pendingProposals, 1)
    assert.equal(info(roles, 'common').pendingProposals, 1)
  })
})

// --- no store ------------------------------------------------------------------------------------

test('without dishConfig, read and roles give the shipped defaults, and save and reset are UNAVAILABLE', async () => {
  await withoutStore(async (remote, ctx) => {
    assert.equal(ctx.get('dishConfig'), undefined)
    const roles = ok(await remote.roles())
    plain(roles)
    assert.deepEqual(roles.map(role => role.role), ['common', 'main', ...[...CREW_ROLES].sort()])
    for (const role of roles) {
      assert.deepEqual({ ...role, role: undefined, path: undefined, agent: undefined }, {
        role: undefined, path: undefined, agent: undefined, differsFromDefault: false, missing: false, pendingProposals: 0,
      })
    }
    for (const role of ALL_ROLES) {
      assert.deepEqual(ok(await remote.read(role)), { text: DEFAULTS[role], commit: null, defaultText: DEFAULTS[role], missing: false }, role)
    }
    failed(await remote.read('nobody'), 'NOT_FOUND')

    assert.match(failed(await remote.save('main', MAIN_ONE, '', ''), 'UNAVAILABLE'), /config store/)
    failed(await remote.reset('main', '', ''), 'UNAVAILABLE')
  })
})

test('a store that comes and goes is looked up on every call', async () => {
  const where = await dirs()
  const ctx = new Context()
  const prompts = mountPrompts(ctx, where.state)
  await prompts
  try {
    const remote = await waitFor('the remote', () => ctx.get('dishPromptsRemote') as PromptsRemote | undefined)
    failed(await remote.save('main', MAIN_ONE, '', ''), 'UNAVAILABLE')
    const config = mountConfig(ctx, where.repository)
    await config
    await seeded(ctx.dishConfig)
    assert.ok(ok(await remote.save('main', MAIN_ONE, '', '')))
    assert.equal(ok(await remote.read('main')).text, MAIN_ONE)
    await config.dispose()
    failed(await remote.save('main', MAIN_TWO, '', ''), 'UNAVAILABLE')
    assert.equal(ok(await remote.read('main')).text, DEFAULTS.main)
  } finally {
    await prompts.dispose()
  }
})

// --- what comes off the wire ---------------------------------------------------------------------

test('a role that is no role (as pathFor sees it) is INVALID in every method that takes one', async () => {
  await withRemote(async (remote) => {
    const bad = ['A', '../x', '', 'a/b', 'a b', 'x_y', '1x', 'main.md', 'common/', 'prompts/main.md', 'Main']
    for (const role of bad) {
      failed(await remote.read(role), 'INVALID')
      failed(await remote.save(role, MAIN_ONE, '', ''), 'INVALID')
      failed(await remote.reset(role, '', ''), 'INVALID')
      failed(await remote.preview(role), 'INVALID')
    }
    for (const role of [undefined, null, 7, {}, ['main']] as unknown as string[]) {
      failed(await remote.read(role), 'INVALID')
      failed(await remote.save(role, MAIN_ONE, '', ''), 'INVALID')
      failed(await remote.reset(role, '', ''), 'INVALID')
      failed(await remote.preview(role), 'INVALID')
    }
  })
})

test('the other parameters: a missing one is an empty one, and one that is not a string is INVALID', async () => {
  await withRemote(async (remote, store) => {
    const missing = undefined as unknown as string
    // `base` and `note` missing: no base, no note. `text` missing: empty, which a prompt can't be.
    assert.ok(ok(await remote.save('main', MAIN_ONE, missing, missing)))
    failed(await remote.save('main', missing, '', ''), 'INVALID')
    assert.ok(ok(await remote.reset('main', missing, missing)))
    assert.equal(await store.read('prompts/main.md'), DEFAULTS.main)

    failed(await remote.save('main', 5 as unknown as string, '', ''), 'INVALID')
    failed(await remote.save('main', MAIN_ONE, 5 as unknown as string, ''), 'INVALID')
    failed(await remote.save('main', MAIN_ONE, '', 5 as unknown as string), 'INVALID')
    failed(await remote.reset('main', null as unknown as string, ''), 'INVALID')
    failed(await remote.reset('main', '', {} as unknown as string), 'INVALID')
  })
})

// --- failures that aren't the store's ------------------------------------------------------------

/** A remote over stub services, for failures the real store never produces. */
async function withStubs<T>(store: Partial<DishConfigService>, body: (remote: PromptsRemote) => Promise<T>): Promise<T> {
  const ctx = new Context()
  const prompts: DishPrompts = {
    roles: async () => ['common', 'main'],
    persona: async () => ({ prefix: 'p', suffix: 's', commit: null }),
    snapshot: async () => ({ prefix: 'p', suffix: 's', commit: null }),
    drop: async () => {},
    defaultText: role => role === 'main' || role === 'common' ? DEFAULTS[role] : undefined,
  }
  ctx.provide('dishPrompts', prompts)
  ctx.provide('dishConfig', store as DishConfigService)
  const handle = ctx.plugin(PromptsRemote)
  try {
    await handle
    return await body(ctx.get('dishPromptsRemote') as PromptsRemote)
  } finally {
    await handle.dispose()
  }
}

test('a refusal is recognised by its code, whichever package\'s error it is; anything else is thrown', async () => {
  const coded = (code: string) => Object.assign(new Error(`refused: ${code}`), { code })
  for (const code of ['CONFLICT', 'INVALID', 'UNOWNED', 'FORBIDDEN', 'SECRET', 'TOO_LARGE', 'LOCKED', 'STALE', 'NOT_FOUND'] as const) {
    await withStubs({ write: async () => { throw coded(code) }, head: async () => 'c'.repeat(40) }, async (remote) => {
      assert.equal(failed(await remote.save('main', MAIN_ONE, '', ''), code), `refused: ${code}`)
    })
  }
  // A bug, or a failure that isn't a refusal (an errno has a `code` too), is the caller's: thrown, like dish-config's remote does.
  await withStubs({ write: async () => { throw new Error('boom') } }, async (remote) => {
    await assert.rejects(remote.save('main', MAIN_ONE, '', ''), /boom/)
  })
  await withStubs({ write: async () => { throw coded('ENOENT') } }, async (remote) => {
    await assert.rejects(remote.save('main', MAIN_ONE, '', ''), /ENOENT/)
  })
  await withStubs({ head: async () => { throw new TypeError('not a function') } }, async (remote) => {
    await assert.rejects(remote.read('main'), TypeError)
  })
})

test('the wire carries JSON: a commit with nothing undefined in it', async () => {
  const commit = { id: 'a'.repeat(40), time: 1, author: { kind: 'user' }, message: 'm', note: undefined, paths: ['prompts/main.md'] }
  await withStubs({ write: async () => commit as never }, async (remote) => {
    const saved = ok(await remote.save('main', MAIN_ONE, '', ''))
    plain(saved)
    assert.ok(saved && !('note' in saved))
  })
})

test('watchLogs sees nothing from a remote doing its work', async () => {
  await withRemote(async (remote, _store, ctx) => {
    const logs = watchLogs(ctx)
    ok(await remote.roles())
    ok(await remote.read('main'))
    ok(await remote.save('main', MAIN_ONE, '', ''))
    assert.deepEqual(logs, [])
  })
})
