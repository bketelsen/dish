import { test } from 'node:test'
import assert from 'node:assert/strict'
import { format } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import type { DishConfigService } from 'dish-config'
import { DEFAULTS } from '../src/defaults.ts'
import { buildCatalog, createDishSkills } from '../src/service.ts'
import type { DishSkills, ServiceOptions } from '../src/service.ts'
import { SHIPPED_ROLES, namespaceSpec, parseSkill, pathFor } from '../src/skill.ts'
import { COMMIT, dirs, mountConfig, outsideCommit, skillText, userWrite } from './helpers.ts'

type StoreReader = NonNullable<ReturnType<ServiceOptions['store']>>

interface Harness {
  ctx: Context
  /** dish-config's real store, with dish-skills' namespace claimed (and nothing seeded). */
  store: DishConfigService
  repository: string
  /** What the services built here logged as warnings. */
  warnings: string[]
  infos: string[]
}

/** Run `body` with dish-config's real plugin mounted in a fresh `Context` on a temp repository. */
async function withStore(body: (harness: Harness) => Promise<void>): Promise<void> {
  const ctx = new Context()
  const where = await dirs()
  const handle = mountConfig(ctx, where.repository)
  try {
    await handle
    const store = ctx.dishConfig
    ctx.effect(() => store.claim(namespaceSpec('dish-skills')))
    await body({ ctx, store, repository: where.repository, warnings: [], infos: [] })
  } finally {
    await handle.dispose()
  }
}

type CrewLike = ReturnType<ServiceOptions['crew']>

interface Overrides {
  store?: () => StoreReader | undefined
  crew?: () => CrewLike
}

/** A `dishSkills` service over the harness' store, which logs into `harness.warnings`. */
function serviceFor(harness: Harness, overrides: Overrides = {}): DishSkills {
  return createDishSkills({
    store: overrides.store ?? (() => harness.ctx.get('dishConfig')),
    crew: overrides.crew ?? (() => undefined),
    logger: {
      warn: (...args: [string, ...unknown[]]) => { harness.warnings.push(format(...args)) },
      info: (...args: [string, ...unknown[]]) => { harness.infos.push(format(...args)) },
    },
  })
}

interface Calls { head: number, list: number, read: number }

/** A store reader over `store`, with some methods replaced, and a count of every call. */
function readerWith(store: DishConfigService, replace: Partial<StoreReader> = {}): StoreReader & { calls: Calls } {
  const calls: Calls = { head: 0, list: 0, read: 0 }
  return {
    calls,
    head: () => { calls.head++; return (replace.head ?? (() => store.head()))() },
    list: (prefix, ref) => { calls.list++; return (replace.list ?? ((p, r) => store.list(p, r)))(prefix, ref) },
    read: (path, ref) => { calls.read++; return (replace.read ?? ((p, r) => store.read(p, r)))(path, ref) },
  }
}

const names = (docs: readonly { name: string }[]): string[] => docs.map(doc => doc.name)

// --- the catalog from the store --------------------------------------------------------------------

test('catalog reads the skills at main: sorted by name, each with its path, its text and what it says', async () => {
  await withStore(async (harness) => {
    const { store } = harness
    const alpha = skillText('alpha', ['coder'], 'Alpha steps.')
    await userWrite(store, 'zulu', skillText('zulu'))
    await userWrite(store, 'alpha', alpha)
    await userWrite(store, 'mike', skillText('mike', []))
    const head = await store.head()

    const catalog = await serviceFor(harness).catalog()
    assert.equal(catalog.commit, head)
    assert.match(catalog.commit!, COMMIT)
    assert.deepEqual(names(catalog.skills), ['alpha', 'mike', 'zulu'])
    assert.deepEqual(catalog.problems, [])
    const [doc] = catalog.skills
    assert.equal(doc!.path, 'skills/alpha/SKILL.md')
    assert.equal(doc!.text, alpha)
    assert.equal(doc!.description, 'Use when you need alpha.')
    assert.deepEqual(doc!.roles, ['coder'])
    assert.deepEqual(doc!.metadata, { roles: ['coder'] })
    assert.equal(doc!.body, 'Alpha steps.')
    assert.equal(doc!.modelInvocable, true)
    assert.equal(doc!.userInvocable, true)
    assert.equal(catalog.skills[1]!.roles?.length, 0)
    assert.equal(catalog.skills[2]!.roles, null)
  })
})

test('invocation flags come from the document', async () => {
  await withStore(async (harness) => {
    const text = '---\nname: menu\ndescription: Use when the user asks.\ndisable-model-invocation: true\nuser-invocable: false\n---\nBody.\n'
    await userWrite(harness.store, 'menu', text)
    const { skills } = await serviceFor(harness).catalog()
    assert.equal(skills[0]!.modelInvocable, false)
    assert.equal(skills[0]!.userInvocable, false)
  })
})

test('a store with no skill documents at all gives the shipped defaults at commit null, and the stored skills once there are some', async () => {
  await withStore(async (harness) => {
    const reader = readerWith(harness.store)
    const service = serviceFor(harness, { store: () => reader })
    const catalog = await service.catalog()
    assert.equal(catalog.commit, null)
    assert.deepEqual(names(catalog.skills), Object.keys(DEFAULTS).sort())
    assert.deepEqual(catalog.problems, [])
    assert.deepEqual(harness.warnings, [])
    // The empty answer is read once per commit like any other.
    assert.deepEqual(await service.catalog(), catalog)
    assert.deepEqual(reader.calls, { head: 2, list: 1, read: 0 })

    await userWrite(harness.store, 'mine', skillText('mine'))
    const stored = await service.catalog()
    assert.equal(stored.commit, await harness.store.head())
    assert.deepEqual(names(stored.skills), ['mine'])
  })
})

test('a store whose only skill documents are broken answers with those problems, not the defaults', async () => {
  await withStore(async (harness) => {
    await outsideCommit(harness.repository, [{ path: 'skills/broken/SKILL.md', text: 'no frontmatter at all\n' }])
    const catalog = await serviceFor(harness).catalog()
    assert.equal(catalog.commit, await harness.store.head())
    assert.deepEqual(catalog.skills, [])
    assert.deepEqual(catalog.problems.map(problem => problem.path), ['skills/broken/SKILL.md'])
  })
})

test('paths under skills/ that are not a skill\'s document are left out, and are not problems', async () => {
  await withStore(async (harness) => {
    await userWrite(harness.store, 'real', skillText('real'))
    const strays = ['skills/real/notes.md', 'skills/Upper/SKILL.md', 'skills/deep/er/SKILL.md', 'skills/SKILL.md', 'skills/lonely.md']
    await outsideCommit(harness.repository, strays.map(path => ({ path, text: 'not a skill' })))
    const listed = await harness.store.list('skills/')
    for (const path of strays) assert.ok(listed.includes(path), `${path} is in the store`)

    const catalog = await serviceFor(harness).catalog()
    assert.deepEqual(names(catalog.skills), ['real'])
    assert.deepEqual(catalog.problems, [])
    assert.deepEqual(harness.warnings, [])
  })
})

test('a hand-broken document is a problem, logged once for the commit, and the other skills still serve', async () => {
  await withStore(async (harness) => {
    await userWrite(harness.store, 'good', skillText('good'))
    await outsideCommit(harness.repository, [
      { path: 'skills/broken/SKILL.md', text: 'no frontmatter at all\n' },
      { path: 'skills/liar/SKILL.md', text: skillText('someone-else') },
      { path: 'skills/yaml/SKILL.md', text: '---\nname: [unclosed\n---\nBody.\n' },
    ])
    const service = serviceFor(harness)
    const catalog = await service.catalog()
    assert.deepEqual(names(catalog.skills), ['good'])
    assert.deepEqual(catalog.problems.map(problem => problem.path), ['skills/broken/SKILL.md', 'skills/liar/SKILL.md', 'skills/yaml/SKILL.md'])
    assert.match(catalog.problems[0]!.message, /frontmatter is missing/)
    assert.doesNotMatch(catalog.problems[0]!.message, /^skills\//, 'the message does not repeat the path')
    assert.match(catalog.problems[1]!.message, /name is "someone-else" but the folder is "liar"/)
    assert.match(catalog.problems[2]!.message, /isn't valid YAML/)
    assert.equal(harness.warnings.length, 3)
    assert.match(harness.warnings[0]!, /skills\/broken\/SKILL\.md/)
    assert.match(harness.warnings[0]!, /frontmatter is missing/)

    // The same commit read again says nothing more...
    service.changed()
    assert.deepEqual((await service.catalog()).problems.length, 3)
    assert.equal(harness.warnings.length, 3)
    // ...and a new commit that leaves it broken says it again.
    await userWrite(harness.store, 'another', skillText('another'))
    service.changed()
    assert.deepEqual(names((await service.catalog()).skills), ['another', 'good'])
    assert.equal(harness.warnings.length, 6)
  })
})

test('a broken document that is then fixed leaves the problems', async () => {
  await withStore(async (harness) => {
    await outsideCommit(harness.repository, [{ path: 'skills/mend/SKILL.md', text: 'broken\n' }])
    const service = serviceFor(harness)
    assert.equal((await service.catalog()).problems.length, 1)
    await userWrite(harness.store, 'mend', skillText('mend'))
    const catalog = await service.catalog()
    assert.deepEqual(catalog.problems, [])
    assert.deepEqual(names(catalog.skills), ['mend'])
  })
})

test('a hand-edited document with a very long list is served like any other, at the store\'s commit', async () => {
  await withStore(async (harness) => {
    await userWrite(harness.store, 'good', skillText('good'))
    // 130000 entries: it fits the store's size limit, and used to overflow the stack in the alias check.
    const big = `---\nname: big\ndescription: Use when testing.\nmetadata:\n  other: [${'a,'.repeat(130_000)}a]\n---\nBody.\n`
    await outsideCommit(harness.repository, [{ path: 'skills/big/SKILL.md', text: big }])
    const head = await harness.store.head()
    const reader = readerWith(harness.store)
    const service = serviceFor(harness, { store: () => reader })

    const catalog = await service.catalog()
    assert.equal(catalog.commit, head)
    assert.deepEqual(names(catalog.skills), ['big', 'good'])
    assert.deepEqual(catalog.problems, [])
    assert.deepEqual(harness.warnings, [])
    // And it is memoized: the user's skills do not cost a re-parse on every call.
    await service.catalog()
    assert.equal(reader.calls.list, 1)
  })
})

test('buildCatalog: a document whose parsing throws is a problem of its own, and the others are served', () => {
  const commit = 'c'.repeat(40)
  const parse = (path: string, text: string) => {
    if (text === 'overflow') throw new RangeError('Maximum call stack size exceeded')
    if (text === 'string') throw 'a thrown string'
    return parseSkill(path, text)
  }
  const catalog = buildCatalog(commit, [
    [pathFor('zed'), skillText('zed')],
    [pathFor('boom'), 'overflow'],
    [pathFor('good'), skillText('good')],
    [pathFor('odd'), 'string'],
    [pathFor('plain'), 'no frontmatter'],
  ], parse)
  assert.equal(catalog.commit, commit)
  assert.deepEqual(names(catalog.skills), ['good', 'zed'])
  assert.deepEqual(catalog.problems, [
    { path: 'skills/boom/SKILL.md', message: 'Maximum call stack size exceeded' },
    { path: 'skills/odd/SKILL.md', message: 'a thrown string' },
    { path: 'skills/plain/SKILL.md', message: 'the frontmatter is missing; the document must start with a --- line' },
  ])
  // The real parser throws for none of these, and the message of a refusal does not repeat the path.
  assert.deepEqual(buildCatalog(null, [[pathFor('plain'), 'no frontmatter']]).problems.map(problem => problem.message),
    ['the frontmatter is missing; the document must start with a --- line'])
})

// --- memoizing -------------------------------------------------------------------------------------

test('the catalog is read once per commit: reused until changed() or a new commit', async () => {
  await withStore(async (harness) => {
    await userWrite(harness.store, 'one', skillText('one'))
    await userWrite(harness.store, 'two', skillText('two'))
    const reader = readerWith(harness.store)
    const service = serviceFor(harness, { store: () => reader })

    const first = await service.catalog()
    assert.deepEqual(reader.calls, { head: 1, list: 1, read: 2 })
    const second = await service.catalog()
    // The head is asked every time, which is what tells a new commit from the same one.
    assert.deepEqual(reader.calls, { head: 2, list: 1, read: 2 })
    assert.deepEqual(second, first)

    service.changed()
    await service.catalog()
    assert.deepEqual(reader.calls, { head: 3, list: 2, read: 4 })

    // A commit nobody announced is still a new catalog: the memo is by commit.
    await userWrite(harness.store, 'three', skillText('three'))
    const third = await service.catalog()
    assert.deepEqual(names(third.skills), ['one', 'three', 'two'])
    assert.equal(reader.calls.list, 3)
    assert.equal(third.commit, await harness.store.head())
  })
})

test('concurrent calls share one read', async () => {
  await withStore(async (harness) => {
    await userWrite(harness.store, 'one', skillText('one'))
    const reader = readerWith(harness.store)
    const service = serviceFor(harness, { store: () => reader })
    const [a, b, c] = await Promise.all([service.catalog(), service.catalog(), service.catalog()])
    assert.equal(reader.calls.list, 1)
    assert.equal(reader.calls.head, 1)
    assert.deepEqual(b, a)
    assert.deepEqual(c, a)
  })
})

test('a caller that changes what it was given does not change what the next caller gets', async () => {
  await withStore(async (harness) => {
    await userWrite(harness.store, 'one', skillText('one'))
    await userWrite(harness.store, 'two', skillText('two'))
    const service = serviceFor(harness)
    const first = await service.catalog()
    first.skills.reverse()
    first.skills.pop()
    first.problems.push({ path: 'x', message: 'y' })
    const again = await service.catalog()
    assert.deepEqual(names(again.skills), ['one', 'two'])
    assert.deepEqual(again.problems, [])
    // The documents themselves are shared, so they are frozen.
    assert.throws(() => { (again.skills[0] as { description: string }).description = 'changed' }, TypeError)
    assert.throws(() => { again.skills[0]!.metadata.extra = 1 }, TypeError)
  })
})

test('changed() while a read is under way: the next call reads again, and the old read does not take the memo', async () => {
  await withStore(async (harness) => {
    await userWrite(harness.store, 'old', skillText('old'))
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let gated = true
    const reader = readerWith(harness.store, {
      list: async (prefix, ref) => {
        const paths = await harness.store.list(prefix, ref)
        if (gated) {
          gated = false
          await gate
        }
        return paths
      },
    })
    const service = serviceFor(harness, { store: () => reader })

    const slow = service.catalog()
    // The slow read has its head and is held at the list.
    while (reader.calls.list === 0) await new Promise(resolve => setTimeout(resolve, 5))
    await userWrite(harness.store, 'new', skillText('new'))
    service.changed()
    const fresh = await service.catalog()
    assert.deepEqual(names(fresh.skills), ['new', 'old'])

    release()
    const stale = await slow
    assert.deepEqual(names(stale.skills), ['old'])
    assert.notEqual(stale.commit, fresh.commit)

    // The memo is the fresh one: the stale read finished later and did not replace it.
    const listsBefore = reader.calls.list
    assert.deepEqual(names((await service.catalog()).skills), ['new', 'old'])
    assert.equal(reader.calls.list, listsBefore)
  })
})

test('a read that changed() outdated does not tell problems again, or reset what was told', async () => {
  await withStore(async (harness) => {
    await outsideCommit(harness.repository, [{ path: 'skills/broken/SKILL.md', text: 'no frontmatter at all\n' }])
    await userWrite(harness.store, 'old', skillText('old'))
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let gated = true
    const reader = readerWith(harness.store, {
      list: async (prefix, ref) => {
        const paths = await harness.store.list(prefix, ref)
        if (gated) {
          gated = false
          await gate
        }
        return paths
      },
    })
    const service = serviceFor(harness, { store: () => reader })

    const slow = service.catalog()
    while (reader.calls.list === 0) await new Promise(resolve => setTimeout(resolve, 5))
    await userWrite(harness.store, 'new', skillText('new'))
    service.changed()
    await service.catalog()
    // The fresh read told the broken document, once.
    assert.equal(harness.warnings.length, 1)

    release()
    await slow
    service.changed()
    await service.catalog()
    assert.equal(harness.warnings.length, 1, harness.warnings.join('\n'))
  })
})

// --- the shipped defaults --------------------------------------------------------------------------

test('without a store the catalog is the shipped defaults at commit null', async () => {
  await withStore(async (harness) => {
    const service = serviceFor(harness, { store: () => undefined })
    const catalog = await service.catalog()
    assert.equal(catalog.commit, null)
    assert.deepEqual(catalog.problems, [])
    assert.deepEqual(names(catalog.skills), Object.keys(DEFAULTS).sort())
    assert.equal(catalog.skills.length, 18)
    for (const doc of catalog.skills) {
      assert.equal(doc.path, pathFor(doc.name))
      assert.equal(doc.text, DEFAULTS[doc.name])
    }
    assert.deepEqual(await service.catalog(), catalog)
    assert.deepEqual(harness.warnings, [])
  })
})

test('the store coming and going: each call looks the store up, and the stored skills replace the defaults and back', async () => {
  await withStore(async (harness) => {
    await userWrite(harness.store, 'mine', skillText('mine'))
    let present = false
    const service = serviceFor(harness, { store: () => present ? harness.store : undefined })
    assert.equal((await service.catalog()).commit, null)
    present = true
    const stored = await service.catalog()
    assert.equal(stored.commit, await harness.store.head())
    assert.deepEqual(names(stored.skills), ['mine'])
    present = false
    const defaults = await service.catalog()
    assert.equal(defaults.commit, null)
    assert.equal(defaults.skills.length, 18)
  })
})

test('a store that fails to answer gives the defaults, and the failure is logged once for as long as it lasts', async () => {
  await withStore(async (harness) => {
    await userWrite(harness.store, 'mine', skillText('mine'))
    let failing: 'head' | 'list' | 'read' | undefined = 'head'
    const reader = readerWith(harness.store, {
      head: () => failing === 'head' ? Promise.reject(new Error('the store is on fire')) : harness.store.head(),
      list: (prefix, ref) => failing === 'list' ? Promise.reject(new Error('listing is on fire')) : harness.store.list(prefix, ref),
      read: (path, ref) => failing === 'read' ? Promise.reject(new Error('reading is on fire')) : harness.store.read(path, ref),
    })
    const service = serviceFor(harness, { store: () => reader })

    for (let round = 0; round < 3; round++) {
      const catalog = await service.catalog()
      assert.equal(catalog.commit, null)
      assert.equal(catalog.skills.length, 18)
    }
    assert.equal(harness.warnings.length, 1)
    assert.match(harness.warnings[0]!, /the store is on fire/)

    // A different trouble is another kind of trouble.
    failing = 'list'
    await service.catalog()
    failing = 'read'
    await service.catalog()
    assert.equal(harness.warnings.length, 3)
    assert.match(harness.warnings[1]!, /listing is on fire/)
    assert.match(harness.warnings[2]!, /reading is on fire/)

    // Once the store answers, the stored catalog is back; and a new failure is told again.
    failing = undefined
    assert.deepEqual(names((await service.catalog()).skills), ['mine'])
    failing = 'head'
    assert.equal((await service.catalog()).commit, null)
    assert.equal(harness.warnings.length, 4)
  })
})

test('a failure that comes back after the store answered from its memo is logged again', async () => {
  await withStore(async (harness) => {
    await userWrite(harness.store, 'mine', skillText('mine'))
    let failing = false
    const reader = readerWith(harness.store, { head: () => failing ? Promise.reject(new Error('the store is on fire')) : harness.store.head() })
    const service = serviceFor(harness, { store: () => reader })

    assert.equal((await service.catalog()).commit, await harness.store.head())
    failing = true
    assert.equal((await service.catalog()).commit, null)
    assert.equal(harness.warnings.length, 1)
    // The store answers again at the same commit, so from the memo...
    failing = false
    assert.deepEqual(names((await service.catalog()).skills), ['mine'])
    assert.equal(reader.calls.list, 1)
    // ...and the same trouble is news.
    failing = true
    assert.equal((await service.catalog()).commit, null)
    assert.equal(harness.warnings.length, 2)
  })
})

test('a store that throws instead of returning a promise is the same failure', async () => {
  await withStore(async (harness) => {
    const reader: StoreReader = {
      head: () => { throw new Error('synchronous trouble') },
      list: () => Promise.resolve([]),
      read: () => Promise.resolve(undefined),
    }
    const catalog = await serviceFor(harness, { store: () => reader }).catalog()
    assert.equal(catalog.commit, null)
    assert.equal(harness.warnings.length, 1)
  })
})

test('a store function that throws is the same failure too', async () => {
  await withStore(async (harness) => {
    const service = serviceFor(harness, { store: () => { throw new Error('no such service') } })
    assert.equal((await service.catalog()).commit, null)
    assert.equal(harness.warnings.length, 1)
  })
})

test('a store that is there but fails gives a degraded catalog; no store, an empty store and a store that answers do not', async () => {
  await withStore(async (harness) => {
    let failing = true
    const reader = readerWith(harness.store, { head: () => failing ? Promise.reject(new Error('the store is on fire')) : harness.store.head() })
    let present = true
    const service = serviceFor(harness, { store: () => present ? reader : undefined })

    // There, and failing: the shipped skills, marked, so that whoever caches the answer knows it is a stopgap.
    const degraded = await service.catalog()
    assert.equal(degraded.commit, null)
    assert.equal(degraded.degraded, true)
    assert.equal(degraded.skills.length, 18)
    // Each call asks the store again: a stopgap is never remembered.
    const headsBefore = reader.calls.head
    await service.catalog()
    assert.equal(reader.calls.head, headsBefore + 1)
    // What it returns is the caller's: changing it changes no other answer.
    delete degraded.degraded
    assert.equal((await service.catalog()).degraded, true)

    // The store answers, with no skill documents yet: the shipped skills, as an answer.
    failing = false
    const empty = await service.catalog()
    assert.equal(empty.skills.length, 18)
    assert.equal('degraded' in empty, false)

    // No store at all is an answer too.
    present = false
    const none = await service.catalog()
    assert.equal(none.commit, null)
    assert.equal('degraded' in none, false)

    // A store with skills, once it answers, and a failure after it.
    await userWrite(harness.store, 'mine', skillText('mine'))
    present = true
    const stored = await service.catalog()
    assert.deepEqual(names(stored.skills), ['mine'])
    assert.equal('degraded' in stored, false)
    failing = true
    assert.equal((await service.catalog()).degraded, true)
  })
})

test('a store function that throws gives a degraded catalog', async () => {
  await withStore(async (harness) => {
    const service = serviceFor(harness, { store: () => { throw new Error('no such service') } })
    assert.equal((await service.catalog()).degraded, true)
  })
})

test('defaultText and shipped describe the shipped skills', async () => {
  await withStore(async (harness) => {
    const service = serviceFor(harness)
    assert.deepEqual(service.shipped(), Object.keys(DEFAULTS).sort())
    assert.equal(service.shipped().length, 18)
    assert.equal(service.defaultText('brainstorming'), DEFAULTS.brainstorming)
    assert.equal(service.defaultText('not-shipped'), undefined)
    assert.equal(service.defaultText('constructor'), undefined)
    // A new array each time.
    service.shipped().pop()
    assert.equal(service.shipped().length, 18)
  })
})

// --- roles -----------------------------------------------------------------------------------------

test('forRole gives the skills offered to a role, sorted: those that name it and those that name none', async () => {
  await withStore(async (harness) => {
    const { store } = harness
    await userWrite(store, 'for-all', skillText('for-all'))
    await userWrite(store, 'only-coder', skillText('only-coder', ['coder']))
    await userWrite(store, 'coder-and-main', skillText('coder-and-main', ['main', 'coder']))
    await userWrite(store, 'nobody', skillText('nobody', []))
    const service = serviceFor(harness)
    assert.deepEqual(names(await service.forRole('coder')), ['coder-and-main', 'for-all', 'only-coder'])
    assert.deepEqual(names(await service.forRole('main')), ['coder-and-main', 'for-all'])
    assert.deepEqual(names(await service.forRole('writer')), ['for-all'])
    assert.deepEqual(names(await service.forRole('not-a-role')), ['for-all'])
  })
})

test('forRole over the defaults is the spec\'s table', async () => {
  await withStore(async (harness) => {
    const service = serviceFor(harness, { store: () => undefined })
    assert.deepEqual(names(await service.forRole('reviewer')), ['reviewing-work', 'verification-before-completion'])
    assert.deepEqual(names(await service.forRole('researcher')), ['researching', 'verification-before-completion'])
    assert.ok((await service.forRole('main')).length > 10)
  })
})

test('knownRoles is main first, then the crew\'s roles sorted; without crew, the shipped roles', async () => {
  await withStore(async (harness) => {
    const withCrew = (settings: () => Promise<unknown>): DishSkills =>
      serviceFor(harness, { crew: () => ({ settings }) as CrewLike })

    const crew = withCrew(async () => ({ roles: { zeta: {}, coder: {}, architect: {} } }))
    assert.deepEqual(await crew.knownRoles(), ['main', 'architect', 'coder', 'zeta'])

    // A role named main is not a second one.
    const odd = withCrew(async () => ({ roles: { main: {}, ops: {} } }))
    assert.deepEqual(await odd.knownRoles(), ['main', 'ops'])

    const none = serviceFor(harness)
    const shipped = ['main', ...SHIPPED_ROLES.filter(role => role !== 'main').sort()]
    assert.deepEqual(await none.knownRoles(), shipped)
    assert.deepEqual(await none.knownRoles(), ['main', 'architect', 'coder', 'ops', 'researcher', 'reviewer', 'writer'])
    assert.deepEqual(harness.warnings, [])

    // Crew is looked up on each call: it can come and go.
    let present: CrewLike
    const moving = serviceFor(harness, { crew: () => present })
    assert.deepEqual(await moving.knownRoles(), shipped)
    present = { settings: async () => ({ roles: { only: {} } }) }
    assert.deepEqual(await moving.knownRoles(), ['main', 'only'])
    present = undefined
    assert.deepEqual(await moving.knownRoles(), shipped)
  })
})

test('knownRoles never rejects: trouble with crew gives the shipped roles, and is logged once', async () => {
  await withStore(async (harness) => {
    const shipped = ['main', 'architect', 'coder', 'ops', 'researcher', 'reviewer', 'writer']
    const rejecting = serviceFor(harness, { crew: () => ({ settings: () => Promise.reject(new Error('crew.yaml is broken')) }) })
    assert.deepEqual(await rejecting.knownRoles(), shipped)
    assert.deepEqual(await rejecting.knownRoles(), shipped)
    assert.equal(harness.warnings.length, 1)
    assert.match(harness.warnings[0]!, /crew\.yaml is broken/)

    const throwing = serviceFor(harness, { crew: () => ({ settings: () => { throw new Error('thrown at once') } }) })
    assert.deepEqual(await throwing.knownRoles(), shipped)

    const lookup = serviceFor(harness, { crew: () => { throw new Error('no crew lookup') } })
    assert.deepEqual(await lookup.knownRoles(), shipped)

    for (const settings of [undefined, null, 'text', {}, { roles: null }, { roles: ['coder'] }, { roles: 'coder' }]) {
      const strange = serviceFor(harness, { crew: () => ({ settings: async () => settings }) as unknown as CrewLike })
      assert.deepEqual(await strange.knownRoles(), shipped, JSON.stringify(settings))
    }
    // Nothing is rejected, whatever the crew said.
    assert.ok(harness.warnings.length >= 3)
  })
})

// --- changes ---------------------------------------------------------------------------------------

test('onChange listeners hear changed(), until they are removed', async () => {
  await withStore(async (harness) => {
    const service = serviceFor(harness)
    const heard: string[] = []
    const stopA = service.onChange(() => { heard.push('a') })
    service.onChange(() => { heard.push('b') })
    service.changed()
    assert.deepEqual(heard, ['a', 'b'])
    stopA()
    stopA()
    service.changed()
    assert.deepEqual(heard, ['a', 'b', 'b'])
  })
})

test('a listener that throws does not stop the others, and is logged', async () => {
  await withStore(async (harness) => {
    const service = serviceFor(harness)
    const heard: string[] = []
    service.onChange(() => { throw new Error('listener one') })
    service.onChange(async () => { throw new Error('listener two') })
    service.onChange(() => { heard.push('three') })
    assert.doesNotThrow(() => service.changed())
    assert.deepEqual(heard, ['three'])
    // The async one settles after changed() returned.
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(harness.warnings.length, 2)
    assert.match(harness.warnings[0]!, /listener one/)
    assert.match(harness.warnings[1]!, /listener two/)
  })
})

test('a listener removed while the others are being heard is not heard, and one added is heard from the next call', async () => {
  await withStore(async (harness) => {
    const service = serviceFor(harness)
    const heard: string[] = []
    let stopLater = (): void => {}
    service.onChange(() => {
      heard.push('first')
      stopLater()
      service.onChange(() => { heard.push('added') })
    })
    stopLater = service.onChange(() => { heard.push('later') })
    service.changed()
    // `later` was removed before its turn, and `added` is not heard by the call that added it.
    assert.deepEqual(heard, ['first'])
    heard.length = 0
    service.changed()
    assert.deepEqual(heard, ['first', 'added'])
  })
})

test('changed() with nobody listening is nothing', async () => {
  await withStore(async (harness) => {
    assert.doesNotThrow(() => serviceFor(harness).changed())
  })
})
