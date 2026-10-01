import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { once } from 'node:events'
import { syncBuiltinESMExports } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Change, Git } from '../src/store/git.ts'
import type { Author, CommitInfo, ConfigStore, EditAuthor, ProposalEvent, ProposalInfo } from '../src/store/store.ts'
import { AGENTA, USERA, isStoreError, ns, openAt, openStore, recorder, tempDir } from './helpers.ts'

const MAIN = 'refs/heads/main'
const HEADS = 'refs/heads/proposal/'
const REJECTED = 'refs/dish/rejected/'
const TOKEN = `ghp_${'a'.repeat(36)}`
const AGENTB = { kind: 'agent', sessionId: 's2', role: 'reviewer' } as const satisfies Author

const file = (path: string, text: string): Change => ({ path, text })
const gone = (path: string): Change => ({ path, delete: true })

/** Collect what `onProposal` is told, in order. */
function events(): { seen: Array<[string, ProposalEvent]>, onProposal: (id: string, status: ProposalEvent) => void } {
  const seen: Array<[string, ProposalEvent]> = []
  return { seen, onProposal: (id, status) => { seen.push([id, status]) } }
}

/** A direct commit to `main`, which must make a commit. */
async function put(store: ConfigStore, changes: Change[], author: EditAuthor = USERA): Promise<CommitInfo> {
  const info = await store.write(changes, { author })
  assert.ok(info, 'the write made a commit')
  return info
}

async function make(
  store: ConfigStore, changes: Change[], author: EditAuthor = AGENTA, title = 'A title', rationale = 'A reason.',
): Promise<ProposalInfo> {
  return store.propose(changes, { author, title, rationale })
}

async function mainOf(git: Git): Promise<string> {
  const head = await git.resolve(MAIN)
  assert.ok(head)
  return head
}

async function refsUnder(git: Git, prefix: string): Promise<string[]> {
  return (await git.run(['for-each-ref', '--format=%(refname)', prefix])).stdout.split('\n').filter(name => name !== '')
}

async function treeOf(git: Git, rev: string): Promise<string> {
  return (await git.run(['rev-parse', `${rev}^{tree}`])).stdout.trim()
}

async function parentsOf(git: Git, rev: string): Promise<string[]> {
  return (await git.run(['rev-list', '--parents', '-n', '1', rev])).stdout.trim().split(' ').slice(1)
}

/** The raw commit object's message, exactly as stored. */
async function storedMessage(git: Git, id: string): Promise<string> {
  const raw = (await git.run(['cat-file', 'commit', id])).stdout
  return raw.slice(raw.indexOf('\n\n') + 2)
}

async function gitAuthor(git: Git, rev: string): Promise<string> {
  return (await git.run(['log', '-1', '--format=%an', rev])).stdout.trim()
}

/** The loose-object summary: it changes when anything at all is written to the object database. */
async function objects(git: Git): Promise<string> {
  return (await git.run(['count-objects', '-v'])).stdout
}

/** Run `body` with `text` as the user's global git config (`GIT_CONFIG_GLOBAL`, which the store's git children inherit). */
async function withGlobalConfig<T>(text: string, body: () => Promise<T>): Promise<T> {
  const config = join(await tempDir(), 'gitconfig')
  await writeFile(config, text)
  const previous = process.env.GIT_CONFIG_GLOBAL
  process.env.GIT_CONFIG_GLOBAL = config
  try {
    return await body()
  } finally {
    if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL
    else process.env.GIT_CONFIG_GLOBAL = previous
  }
}

/** A refusal that left the repository exactly as it was: no object, no ref. */
async function refusesCleanly(git: Git, attempt: () => Promise<unknown>, matches: (error: unknown) => boolean): Promise<void> {
  const before = [await objects(git), await refsUnder(git, 'refs/')]
  await assert.rejects(attempt(), matches)
  assert.deepEqual([await objects(git), await refsUnder(git, 'refs/')], before, 'nothing was written')
}

/** Run `body` with the next 4-byte random draws (what a proposal id is made of) taken from `ids`; everything else stays real. */
async function withIds<T>(ids: string[], body: () => Promise<T>): Promise<T> {
  const target = crypto as unknown as { randomBytes: (size: number, ...rest: unknown[]) => Buffer }
  const real = target.randomBytes
  const queue = [...ids]
  target.randomBytes = (size, ...rest) => size === 4 && queue.length > 0 ? Buffer.from(queue.shift()!, 'hex') : real(size, ...rest)
  syncBuiltinESMExports()
  try {
    return await body()
  } finally {
    target.randomBytes = real
    syncBuiltinESMExports()
  }
}

interface Forged {
  /** The id that names the ref and goes into `Dish-Proposal`. */
  id: string
  base?: string
  message?: string
  changes?: Change[]
  /** A tree to use as it is, instead of `base`'s with `changes`. */
  tree?: string
  /** Where to point; default `refs/heads/proposal/<id>`. */
  ref?: string
  parents?: string[]
  /** Commit time in seconds. */
  time?: number
}

/** A commit shaped like a proposal, made with git directly and put on a ref, as an outside writer could. */
async function forge(git: Git, options: Forged): Promise<string> {
  const base = options.base ?? await mainOf(git)
  const tree = options.tree ?? await git.buildTree(base, options.changes ?? [])
  const message = options.message ?? `Forged\n\nDish-Author-Kind: user\nDish-Proposal: ${options.id}\nDish-Base: ${base}\n`
  const date = `${options.time ?? 1_700_000_000} +0000`
  const env = {
    GIT_AUTHOR_NAME: 'Forger', GIT_AUTHOR_EMAIL: 'forger@test', GIT_COMMITTER_NAME: 'Forger', GIT_COMMITTER_EMAIL: 'forger@test',
    GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date,
  }
  const parents = (options.parents ?? [base]).flatMap(parent => ['-p', parent])
  const tip = (await git.run(['commit-tree', '--no-gpg-sign', ...parents, tree], { input: message, env })).stdout.trim()
  assert.equal(await git.casRef(options.ref ?? `${HEADS}${options.id}`, tip, null), true)
  return tip
}

// --- propose ------------------------------------------------------------------------------------

test('propose makes one commit on refs/heads/proposal/<id> on top of main, and main stays where it was', async () => {
  const { seen, onProposal } = events()
  const { store, git } = await openAt({ claims: [ns('prompts/')], onProposal })
  const base = (await put(store, [file('prompts/a.md', 'A'), file('prompts/keep.md', 'K')])).id
  const before = await store.history()

  const proposal = await store.propose(
    [file('prompts/a.md', 'A2'), file('prompts/new.md', 'N'), gone('prompts/keep.md')],
    { author: AGENTA, title: 'Rework prompts', rationale: 'Because it reads better.' })

  assert.match(proposal.id, /^[0-9a-f]{8}$/)
  assert.equal(await mainOf(git), base)
  assert.deepEqual(await refsUnder(git, 'refs/heads/'), [MAIN, `${HEADS}${proposal.id}`])
  assert.equal(await git.resolve(`${HEADS}${proposal.id}`), proposal.tip)
  // One commit, its parent the base, its tree the base's plus the changes.
  assert.deepEqual(await parentsOf(git, proposal.tip), [base])
  assert.equal(await treeOf(git, proposal.tip), await git.buildTree(base, [gone('prompts/keep.md'), file('prompts/a.md', 'A2'), file('prompts/new.md', 'N')]))
  assert.equal(await storedMessage(git, proposal.tip), [
    'Rework prompts', '', 'Because it reads better.', '',
    'Dish-Author-Kind: agent', 'Dish-Session: s1', 'Dish-Role: coder', `Dish-Proposal: ${proposal.id}`, `Dish-Base: ${base}`, '',
  ].join('\n'))
  assert.equal(await gitAuthor(git, proposal.tip), 'Test Agent')

  assert.deepEqual(proposal, {
    id: proposal.id,
    title: 'Rework prompts',
    rationale: 'Because it reads better.',
    author: AGENTA,
    created: Number((await git.run(['log', '-1', '--format=%at', proposal.tip])).stdout.trim()) * 1000,
    base,
    tip: proposal.tip,
    paths: ['prompts/a.md', 'prompts/keep.md', 'prompts/new.md'],
    status: 'open',
  })
  assert.deepEqual(await store.proposals('open'), [proposal], 'what propose returned, field for field')
  assert.deepEqual(await store.proposals('stale'), [])
  assert.deepEqual(seen, [[proposal.id, 'open']])

  // Main is untouched, and the proposal's commit is not in its history.
  assert.equal(await store.read('prompts/a.md'), 'A')
  assert.deepEqual(await store.history(), before)
  assert.equal(await store.read('prompts/a.md', proposal.tip), 'A2', 'a full commit id reads the proposed version')
  const shown = await store.commit(proposal.tip)
  assert.deepEqual(shown.info.author, AGENTA)
  assert.deepEqual(shown.info.paths, proposal.paths)
})

test('a user may propose to any owned namespace; an agent only where agent is write or propose', async () => {
  const { store, git } = await openAt({
    claims: [ns('open/', 'write', 'a'), ns('ask/', 'propose', 'b'), ns('locked/', 'none', 'c')],
  })
  assert.ok(await make(store, [file('open/x', '1')], AGENTA))
  assert.ok(await make(store, [file('ask/x', '1')], AGENTA))
  assert.ok(await make(store, [file('locked/x', '1')], USERA))
  assert.equal((await store.proposals()).length, 3)

  await refusesCleanly(git, () => make(store, [file('locked/y', '1')], AGENTA), isStoreError('FORBIDDEN', 'locked/y', 'propose'))
  // One forbidden path among allowed ones refuses the whole proposal.
  await refusesCleanly(git, () => make(store, [file('open/y', '1'), file('locked/y', '1')], AGENTA), isStoreError('FORBIDDEN'))
  assert.equal((await store.proposals()).length, 3)
})

test('propose runs the write checks: shape, paths, ownership, guard, size and validation', async () => {
  const { store, git } = await openAt({
    claims: [ns('prompts/', 'write', 'prompts', (path, text) => text.includes('BAD') ? `${path} is BAD` : undefined)],
    maxBytes: 100,
  })
  const cases: Array<[string, Change[], string, string[]]> = [
    ['no changes', [], 'INVALID', []],
    ['a path twice', [file('prompts/a', '1'), file('prompts/a', '2')], 'INVALID', ['more than once']],
    ['a change that is neither', [{ path: 'prompts/a' } as unknown as Change], 'INVALID', []],
    ['a bad path', [file('prompts/../x', '1')], 'INVALID', ['invalid path']],
    ['no namespace', [file('other/a', '1')], 'UNOWNED', []],
    ['the validator', [file('prompts/a', 'BAD')], 'INVALID', ['prompts/a is BAD']],
    ['the size cap', [file('prompts/a', 'x'.repeat(101))], 'TOO_LARGE', []],
    ['a secret in the text', [file('prompts/a', `key ${TOKEN}`)], 'SECRET', []],
    ['a secret in the path', [file(`prompts/${TOKEN}`, '1')], 'SECRET', []],
    ['a delete of a missing document', [gone('prompts/missing')], 'NOT_FOUND', ['prompts/missing']],
  ]
  for (const [name, changes, code, mentions] of cases) {
    await refusesCleanly(git, () => make(store, changes, USERA), isStoreError(code, ...mentions))
    assert.deepEqual(await store.proposals(), [], name)
  }
  // The path that holds a secret is not echoed.
  await assert.rejects(make(store, [file(`prompts/${TOKEN}`, '1')]), (error: unknown) => !String((error as Error).message).includes(TOKEN))
})

test('propose refuses a bad author, and checks run in the write order', async () => {
  const { store, git } = await openAt({ claims: [ns('prompts/', 'none')] })
  const meta = { title: 't', rationale: 'r' }
  for (const author of [{ kind: 'system' }, { kind: 'root' }, undefined, null]) {
    await refusesCleanly(git, () => store.propose([file('prompts/a', '1')], { ...meta, author } as never), isStoreError('INVALID'))
  }
  await refusesCleanly(git, () => store.propose([file('prompts/a', '1')], null as never), isStoreError('INVALID'))
  await refusesCleanly(git, () => store.propose([file('prompts/a', '1')], { ...meta, author: { kind: 'agent', sessionId: 'has space' } }), isStoreError('FORBIDDEN'))
  // Ownership comes before the agent policy; the policy before the guard and the title.
  await refusesCleanly(git, () => make(store, [file('nowhere/a', TOKEN)], AGENTA, ''), isStoreError('UNOWNED'))
  await refusesCleanly(git, () => make(store, [file('prompts/a', TOKEN)], AGENTA, ''), isStoreError('FORBIDDEN'))
  await refusesCleanly(git, () => make(store, [file('prompts/a', TOKEN)], USERA, ''), isStoreError('SECRET'))
  await refusesCleanly(git, () => make(store, [file('prompts/a', 'ok')], USERA, ''), isStoreError('INVALID', 'title'))
})

test('an agent author with an unusable session id or role is refused', async () => {
  const { store, git } = await openAt({ claims: [ns('prompts/')] })
  await refusesCleanly(git, () => make(store, [file('prompts/a', '1')], { kind: 'agent', sessionId: 'has space' }), isStoreError('INVALID', 'sessionId'))
  await refusesCleanly(git, () => make(store, [file('prompts/a', '1')], { kind: 'agent', sessionId: 's1', role: 'a\nb' }), isStoreError('INVALID', 'role'))
  const proposal = await make(store, [file('prompts/a', '1')], { kind: 'agent', sessionId: 's1' })
  assert.deepEqual(proposal.author, { kind: 'agent', sessionId: 's1', role: 'main' }, 'the default role is filled in, as write does')
})

test('a proposal that changes nothing is INVALID, and writes nothing', async () => {
  const { store, git } = await openAt({ claims: [ns('prompts/')] })
  await put(store, [file('prompts/a', 'A')])
  await refusesCleanly(git, () => make(store, [file('prompts/a', 'A')]), isStoreError('INVALID', 'changes nothing'))
  await refusesCleanly(git, () => make(store, [file('prompts/a', 'A')], USERA), isStoreError('INVALID', 'changes nothing'))
  // One real change among the unchanged ones is a proposal; its paths are only the real one.
  const real = await make(store, [file('prompts/a', 'A'), file('prompts/b', 'B')])
  assert.deepEqual(real.paths, ['prompts/b'])
})

test('title: whitespace collapsed, at most 120 characters, not empty, no secret, no control characters', async () => {
  const { store, git } = await openAt({ claims: [ns('prompts/')] })
  const one = await make(store, [file('prompts/a', '1')], AGENTA, '  Fix \n the \t\t thing  ')
  assert.equal(one.title, 'Fix the thing')
  assert.equal((await store.proposals())[0]!.title, 'Fix the thing')
  assert.match((await store.commit(one.tip)).info.message, /^Fix the thing\n\n/)

  const long = await make(store, [file('prompts/b', '1')], AGENTA, 'é'.repeat(130))
  assert.equal(long.title, 'é'.repeat(120), 'cut by characters, not bytes')
  const edge = await make(store, [file('prompts/b2', '1')], AGENTA, `${'é'.repeat(119)} 日本語`)
  assert.equal(edge.title, 'é'.repeat(119), 'cut by characters, then trimmed')

  for (const title of ['', '   \n\t ', 5, undefined, null, 'a\u0000b', 'a\u001bb', 'a\u0085b']) {
    await refusesCleanly(git, () => store.propose([file('prompts/c', '1')], { author: AGENTA, title: title as string, rationale: '' }), isStoreError('INVALID', 'title'))
  }
  await refusesCleanly(git, () => make(store, [file('prompts/c', '1')], AGENTA, `see ${TOKEN}`), isStoreError('SECRET', 'title'))
  // 17 characters after AKIA match nothing; cut at the 120-character cap, they are an access key.
  const cutIntoAKey = `${'x'.repeat(99)} AKIA${'A'.repeat(17)}`
  await refusesCleanly(git, () => make(store, [file('prompts/c', '1')], AGENTA, cutIntoAKey), isStoreError('SECRET', 'title'))
  assert.ok(await make(store, [file('prompts/c', '1')], AGENTA, `${'x'.repeat(99)} AKIA${'A'.repeat(15)}`))
})

test('rationale: multi-line kept as written, optional, at most 8 KiB, no secret, no control characters', async () => {
  const { store, git } = await openAt({ claims: [ns('prompts/')] })
  const text = 'First line.\n\n\tIndented with a tab.\n\nSigned-off-by: someone\nLast line.'
  const kept = await make(store, [file('prompts/a', '1')], AGENTA, 'T', `\n  ${text}\n\n`)
  assert.equal(kept.rationale, text, 'surrounding whitespace is trimmed, the inside is not')
  assert.deepEqual((await store.proposals())[0], kept)
  // The trailers still read as the proposal's, even though the rationale has paragraphs that look like them.
  assert.equal(kept.base, await mainOf(git))
  assert.deepEqual(kept.author, AGENTA)

  const bare = await make(store, [file('prompts/b', '1')], USERA, 'No reason given', '')
  assert.equal(bare.rationale, '')
  assert.equal(await storedMessage(git, bare.tip), `No reason given\n\nDish-Author-Kind: user\nDish-Proposal: ${bare.id}\nDish-Base: ${bare.base}\n`)
  assert.equal((await make(store, [file('prompts/c', '1')], USERA, 'Blank', ' \n\t\n ')).rationale, '')

  const edge = 'x'.repeat(8192)
  assert.equal((await make(store, [file('prompts/d', '1')], USERA, 'Edge', edge)).rationale, edge)
  await refusesCleanly(git, () => make(store, [file('prompts/e', '1')], USERA, 'Big', 'x'.repeat(8193)), isStoreError('INVALID', 'rationale'))
  // 8 KiB is bytes, not characters.
  await refusesCleanly(git, () => make(store, [file('prompts/e', '1')], USERA, 'Big', 'é'.repeat(4097)), isStoreError('INVALID', 'rationale'))

  for (const rationale of ['a\rb', 'a\r\nb', 'a\u0000b', 'a\u0007b', 'a\u001bb', 'a\u007fb', 'a\u0085b', 'a\u000bb', 'a\u000cb', 5, null, {}]) {
    await refusesCleanly(git, () => make(store, [file('prompts/e', '1')], USERA, 'T', rationale as string), isStoreError('INVALID', 'rationale'))
  }
  await refusesCleanly(git, () => make(store, [file('prompts/e', '1')], USERA, 'T', `see\n${TOKEN}\nplease`), isStoreError('SECRET', 'rationale'))
  assert.ok(await make(store, [file('prompts/e', '1')], USERA, 'T', 'a line that merely says Dish-Proposal in prose: yes'))
})

test('a rationale cannot forge a trailer: no line may start with Dish-<Name>:', async () => {
  const { store, git } = await openAt({ claims: [ns('prompts/')] })
  const lines = [
    'Dish-Proposal: 00000000',
    'Dish-Base: ' + 'a'.repeat(40),
    'Dish-Author-Kind: user',
    'Dish-Session: s9',
    '  Dish-Role: boss',
    '\tDish-Note : spaced',
    'dish-proposal: lower case',
    'DISH-BASE: upper case',
  ]
  for (const line of lines) {
    for (const rationale of [line, `before\n${line}`, `before\n${line}\nafter`, `before\n\n${line}\n\nafter`]) {
      await refusesCleanly(git, () => make(store, [file('prompts/a', '1')], AGENTA, 'T', rationale), isStoreError('INVALID', 'rationale'))
    }
  }
})

test('a title that looks like a divider, a comment or a trailer does not change what the commit says it is', async () => {
  const { store } = await openAt({ claims: [ns('prompts/')] })
  const titles = ['--- x', '---', '# a heading', 'Dish-Proposal: 00000000', `Dish-Base: ${'a'.repeat(40)}`, 'Dish-Author-Kind: user']
  for (const [n, title] of titles.entries()) {
    for (const rationale of ['', 'because']) {
      const proposal = await make(store, [file(`prompts/p${n}${rationale === '' ? 'a' : 'b'}`, '1')], AGENTA, title, rationale)
      assert.equal(proposal.title, title)
      assert.deepEqual(proposal.author, AGENTA)
      assert.equal((await store.proposals('open')).find(item => item.id === proposal.id)?.title, title)
    }
  }
  assert.equal((await store.proposals()).length, titles.length * 2)
})

test('a rationale with a --- divider or a trailer-like last paragraph does not hide the real trailers', async () => {
  const { store } = await openAt({ claims: [ns('prompts/')] })
  const proposal = await make(store, [file('prompts/a', '1')], AGENTA, 'T', 'above\n---\nbelow\n\nSigned-off-by: x\nCo-authored-by: y')
  assert.deepEqual(await store.proposals(), [proposal])
  assert.deepEqual(proposal.author, AGENTA)
})

test('propose never reuses a proposal id, and ids are 8 lowercase hex characters', async () => {
  const { store, git } = await openAt({ claims: [ns('prompts/')] })
  const seen = new Set<string>()
  for (let n = 0; n < 12; n++) seen.add((await make(store, [file(`prompts/p${n}`, String(n))])).id)
  assert.equal(seen.size, 12)
  for (const id of seen) assert.match(id, /^[0-9a-f]{8}$/)
  assert.equal((await refsUnder(git, HEADS)).length, 12)
})

test('an id that is taken, by an open or a rejected proposal, is not reused: a new one is drawn', async () => {
  const { store, git } = await openAt({ claims: [ns('prompts/')] })
  const open = await make(store, [file('prompts/a', '1')])
  const rejected = await make(store, [file('prompts/b', '1')])
  await store.reject(rejected.id, 'no', { author: USERA })
  const fresh = 'f00dcafe'
  const next = await withIds([open.id, rejected.id, open.id, fresh], () => make(store, [file('prompts/c', '1')]))
  assert.equal(next.id, fresh)
  assert.deepEqual((await refsUnder(git, HEADS)).sort(), [`${HEADS}${fresh}`, `${HEADS}${open.id}`].sort())
  assert.equal((await store.proposals('rejected'))[0]!.id, rejected.id, 'the rejected record is as it was')
  assert.equal((await store.proposals('open')).find(item => item.id === open.id)!.tip, open.tip, 'so is the open proposal')

  // Five draws that are all taken: give up, and leave nothing behind.
  const taken = [open.id, rejected.id, fresh, open.id, rejected.id]
  const before = await refsUnder(git, 'refs/')
  await assert.rejects(withIds(taken, () => make(store, [file('prompts/d', '1')])), /free proposal id/)
  assert.deepEqual(await refsUnder(git, 'refs/'), before)
})

// --- accept -------------------------------------------------------------------------------------

test('accept on an unchanged base puts the proposal on main as one commit, deletes the branch, and says so', async () => {
  const { seen, onProposal } = events()
  const committed: CommitInfo[] = []
  const { store, git } = await openAt({ claims: [ns('prompts/')], onProposal, onCommit: info => { committed.push(info) } })
  const base = (await put(store, [file('prompts/a.md', 'A'), file('prompts/keep.md', 'K')])).id
  const proposal = await store.propose(
    [file('prompts/a.md', 'A2'), file('prompts/new.md', 'N'), gone('prompts/keep.md')],
    { author: AGENTA, title: 'Rework prompts', rationale: 'Because.' })
  committed.length = 0

  const accepted = await store.accept(proposal.id, { author: USERA })
  assert.ok(accepted)
  assert.equal(await store.read('prompts/a.md'), 'A2')
  assert.equal(await store.read('prompts/new.md'), 'N')
  assert.equal(await store.read('prompts/keep.md'), undefined)
  assert.equal(await mainOf(git), accepted.id)
  assert.deepEqual(await parentsOf(git, accepted.id), [base], 'one commit on main, not a merge')
  assert.deepEqual(await refsUnder(git, HEADS), [], 'the proposal branch is gone')
  assert.deepEqual(await store.proposals(), [])

  assert.deepEqual(accepted.author, USERA)
  assert.deepEqual(accepted.paths, ['prompts/a.md', 'prompts/keep.md', 'prompts/new.md'])
  assert.equal(accepted.message, [
    `Accept proposal ${proposal.id}: Rework prompts`, '',
    'Dish-Author-Kind: user', `Dish-Proposal: ${proposal.id}`, 'Dish-Proposer-Session: s1', 'Dish-Proposer-Role: coder', '',
  ].join('\n'))
  assert.equal(await storedMessage(git, accepted.id), accepted.message)
  assert.equal(await gitAuthor(git, accepted.id), 'Test User')
  assert.deepEqual((await store.history())[0], accepted)

  assert.deepEqual(committed, [accepted], 'onCommit fired once, for the accept commit')
  assert.deepEqual(seen, [[proposal.id, 'open'], [proposal.id, 'accepted']])
})

test('accepting a user proposal carries no proposer trailers', async () => {
  const { store } = await openAt({ claims: [ns('prompts/')] })
  const proposal = await make(store, [file('prompts/a', '1')], USERA, 'Mine', 'because')
  const accepted = await store.accept(proposal.id, { author: USERA })
  assert.ok(accepted)
  assert.equal(accepted.message, `Accept proposal ${proposal.id}: Mine\n\nDish-Author-Kind: user\nDish-Proposal: ${proposal.id}\n`)
})

test('after the user edits a proposed path the proposal is stale; accept refuses with STALE, tells onProposal, merges nothing and keeps the branch', async () => {
  const { seen, onProposal } = events()
  const { store, git } = await openAt({ claims: [ns('prompts/')], onProposal })
  await put(store, [file('prompts/a.md', 'A')])
  const proposal = await make(store, [file('prompts/a.md', 'AGENT')])
  const edit = await put(store, [file('prompts/a.md', 'USER')])
  const before = [await objects(git), await refsUnder(git, 'refs/')]

  const [listed] = await store.proposals()
  assert.equal(listed!.status, 'stale')
  assert.deepEqual({ ...listed!, status: 'open' }, proposal, 'only the status differs')
  assert.deepEqual(await store.proposals('stale'), [listed])
  assert.deepEqual(await store.proposals('open'), [])

  await assert.rejects(store.accept(proposal.id, { author: USERA }), isStoreError('STALE', 'prompts/a.md'))
  assert.deepEqual(seen, [[proposal.id, 'open'], [proposal.id, 'stale']])
  assert.equal(await mainOf(git), edit.id)
  assert.equal(await store.read('prompts/a.md'), 'USER')
  assert.equal(await git.resolve(`${HEADS}${proposal.id}`), proposal.tip, 'the branch is kept')
  assert.deepEqual([await objects(git), await refsUnder(git, 'refs/')], before, 'a refused accept writes nothing')
  // Still stale, and still refused.
  await assert.rejects(store.accept(proposal.id, { author: USERA }), isStoreError('STALE'))
})

test('a stale proposal can still be rejected, and a rebuilt one on the new main accepts', async () => {
  const { store } = await openAt({ claims: [ns('prompts/')] })
  await put(store, [file('prompts/a.md', 'A')])
  const old = await make(store, [file('prompts/a.md', 'AGENT')])
  await put(store, [file('prompts/a.md', 'USER')])
  await store.reject(old.id, 'superseded', { author: USERA })
  const rebuilt = await make(store, [file('prompts/a.md', 'USER+AGENT')])
  assert.equal((await store.proposals('open'))[0]!.id, rebuilt.id)
  assert.ok(await store.accept(rebuilt.id, { author: USERA }))
  assert.equal(await store.read('prompts/a.md'), 'USER+AGENT')
})

test('when the user edits a different path the proposal stays open and accepts cleanly, on top of the new main', async () => {
  const { store, git } = await openAt({ claims: [ns('prompts/')] })
  await put(store, [file('prompts/a.md', 'A'), file('prompts/b.md', 'B')])
  const proposal = await make(store, [file('prompts/a.md', 'A2')])
  const edit = await put(store, [file('prompts/b.md', 'B2')])
  assert.deepEqual((await store.proposals()).map(({ id, status }) => [id, status]), [[proposal.id, 'open']])

  const accepted = await store.accept(proposal.id, { author: USERA })
  assert.ok(accepted)
  assert.deepEqual(await parentsOf(git, accepted.id), [edit.id])
  assert.equal(await store.read('prompts/a.md'), 'A2')
  assert.equal(await store.read('prompts/b.md'), 'B2', 'the user\'s edit is not lost')
  assert.deepEqual(accepted.paths, ['prompts/a.md'])
})

test('accept applies deletions, and a file can give way to a directory (and back) in one proposal', async () => {
  const { store } = await openAt({ claims: [ns('x/')] })
  await put(store, [file('x/a', 'file a'), file('x/dir/one', '1'), file('x/dir/two', '2'), file('x/gone', 'bye')])
  const proposal = await make(store, [file('x/a/b', 'now a directory'), gone('x/a'), file('x/dir', 'now a file'), gone('x/dir/one'), gone('x/dir/two'), gone('x/gone')])
  assert.deepEqual(proposal.paths, ['x/a', 'x/a/b', 'x/dir', 'x/dir/one', 'x/dir/two', 'x/gone'])
  const accepted = await store.accept(proposal.id, { author: USERA })
  assert.ok(accepted)
  assert.deepEqual(await store.list(''), ['x/a/b', 'x/dir'])
  assert.equal(await store.read('x/a/b'), 'now a directory')
  assert.equal(await store.read('x/dir'), 'now a file')
})

test('only a user may accept: an agent is FORBIDDEN, whether or not the proposal exists, and nothing changes', async () => {
  const { seen, onProposal } = events()
  const { store, git } = await openAt({ claims: [ns('prompts/')], onProposal })
  const proposal = await make(store, [file('prompts/a', '1')], AGENTA)
  const before = [await objects(git), await refsUnder(git, 'refs/'), await mainOf(git)]
  for (const id of [proposal.id, 'deadbeef', 'nonsense']) {
    // Even the proposer itself.
    await assert.rejects(store.accept(id, { author: AGENTA }), isStoreError('FORBIDDEN'))
  }
  await assert.rejects(store.accept(proposal.id, { author: AGENTB }), isStoreError('FORBIDDEN'))
  assert.deepEqual([await objects(git), await refsUnder(git, 'refs/'), await mainOf(git)], before)
  assert.deepEqual(seen, [[proposal.id, 'open']])
  assert.deepEqual((await store.proposals()).map(item => item.status), ['open'])
})

test('accept: an unknown, malformed or already-handled id is NOT_FOUND; a bad author is INVALID', async () => {
  const { store } = await openAt({ claims: [ns('prompts/')] })
  const proposal = await make(store, [file('prompts/a', '1')])
  for (const id of ['deadbeef', 'DEADBEEF', '', 'main', '../main', 'x/y', `${proposal.id}0`, 5, undefined]) {
    await assert.rejects(store.accept(id as string, { author: USERA }), isStoreError('NOT_FOUND'), String(id))
  }
  for (const author of [{ kind: 'system' }, undefined, null, 'user']) {
    await assert.rejects(store.accept(proposal.id, { author } as never), isStoreError('INVALID'))
  }
  await assert.rejects(store.accept(proposal.id, undefined as never), isStoreError('INVALID'))
  assert.ok(await store.accept(proposal.id, { author: USERA }))
  await assert.rejects(store.accept(proposal.id, { author: USERA }), isStoreError('NOT_FOUND'), 'accepted proposals are gone')
})

test('accept checks again with the namespace as it is now: a validator that has tightened refuses, and the proposal stays', async () => {
  let strict = false
  const { store, git } = await openAt({
    claims: [ns('prompts/', 'write', 'prompts', (path, text) => strict && text.includes('draft') ? `${path}: no drafts any more` : undefined)],
  })
  const proposal = await make(store, [file('prompts/a', 'a draft')])
  strict = true
  const before = await mainOf(git)
  await assert.rejects(store.accept(proposal.id, { author: USERA }), isStoreError('INVALID', 'no drafts any more'))
  assert.equal(await mainOf(git), before)
  assert.equal(await git.resolve(`${HEADS}${proposal.id}`), proposal.tip, 'still there')
  strict = false
  assert.ok(await store.accept(proposal.id, { author: USERA }))
})

test('accept checks ownership and the guard on the tip, whatever the branch holds', async () => {
  const { store, git } = await openAt({ claims: [ns('prompts/')], maxBytes: 50 })
  const head = await mainOf(git)
  // Branches an outside writer made: a path nobody owns, and one with a secret.
  const unowned = 'aaaaaaaa'
  await forge(git, { id: unowned, changes: [file('elsewhere/a', '1')] })
  const secret = 'bbbbbbbb'
  await forge(git, { id: secret, changes: [file('prompts/a', `key ${TOKEN}`)] })
  const big = 'cccccccc'
  await forge(git, { id: big, changes: [file('prompts/a', 'x'.repeat(51))] })
  await assert.rejects(store.accept(unowned, { author: USERA }), isStoreError('UNOWNED'))
  await assert.rejects(store.accept(secret, { author: USERA }), isStoreError('SECRET'))
  await assert.rejects(store.accept(big, { author: USERA }), isStoreError('TOO_LARGE'))
  assert.equal(await mainOf(git), head)
  assert.equal((await refsUnder(git, HEADS)).length, 3)
})

test('accepting a proposal whose content already equals main makes no commit, but still deletes the branch', async () => {
  const { seen, onProposal } = events()
  const committed: CommitInfo[] = []
  const { store, git } = await openAt({ claims: [ns('prompts/')], onProposal, onCommit: info => { committed.push(info) } })
  const head = (await put(store, [file('prompts/a', 'A')])).id
  committed.length = 0
  // A branch with the same tree as its base: nothing to apply. `propose` refuses to make one, so it comes from outside.
  await forge(git, { id: 'abcd1234' })
  assert.deepEqual((await store.proposals()).map(item => [item.id, item.paths, item.status]), [['abcd1234', [], 'open']])

  assert.equal(await store.accept('abcd1234', { author: USERA }), undefined)
  assert.deepEqual(await refsUnder(git, HEADS), [])
  assert.equal(await mainOf(git), head)
  assert.deepEqual(committed, [])
  assert.deepEqual(seen, [['abcd1234', 'accepted']])
})

// --- reject -------------------------------------------------------------------------------------

test('reject moves the proposal to refs/dish/rejected/<id> with its reason, and proposals(rejected) lists it', async () => {
  const { seen, onProposal } = events()
  const { store, git } = await openAt({ claims: [ns('prompts/')], onProposal })
  const head = (await put(store, [file('prompts/a', 'A')])).id
  const proposal = await make(store, [file('prompts/a', 'A2')], AGENTA, 'Change a', 'Because.')

  assert.equal(await store.reject(proposal.id, 'not now', { author: USERA }), undefined)
  assert.deepEqual(await refsUnder(git, HEADS), [])
  const [rejectedRef] = await refsUnder(git, REJECTED)
  assert.equal(rejectedRef, `${REJECTED}${proposal.id}`)
  // On top of the proposal's tip, with the same tree.
  const record = (await git.resolve(rejectedRef))!
  assert.deepEqual(await parentsOf(git, record), [proposal.tip])
  assert.equal(await treeOf(git, record), await treeOf(git, proposal.tip))
  assert.equal(await storedMessage(git, record), `Rejected: not now\n\nDish-Author-Kind: user\nDish-Rejected: not now\nDish-Proposal: ${proposal.id}\n`)
  assert.equal(await gitAuthor(git, record), 'Test User')
  assert.equal(await mainOf(git), head)
  assert.equal(await store.read('prompts/a'), 'A')

  assert.deepEqual(await store.proposals('rejected'), [{ ...proposal, status: 'rejected', reason: 'not now' }])
  assert.deepEqual(await store.proposals('open'), [])
  assert.deepEqual(await store.proposals('stale'), [])
  assert.deepEqual(await store.proposals(), [{ ...proposal, status: 'rejected', reason: 'not now' }])
  assert.deepEqual(seen, [[proposal.id, 'open'], [proposal.id, 'rejected']])
  // A rejected proposal is gone as far as accept and reject go.
  await assert.rejects(store.accept(proposal.id, { author: USERA }), isStoreError('NOT_FOUND'))
  await assert.rejects(store.reject(proposal.id, 'again', { author: USERA }), isStoreError('NOT_FOUND'))
})

test('a user may reject any proposal; an agent may withdraw only its own session\'s', async () => {
  const { store, git } = await openAt({ claims: [ns('prompts/')] })
  const mine = await make(store, [file('prompts/a', '1')], AGENTA)
  const theirs = await make(store, [file('prompts/b', '1')], AGENTB)
  const users = await make(store, [file('prompts/c', '1')], USERA)
  const before = [await objects(git), await refsUnder(git, 'refs/')]

  // Another agent session, a user's proposal, and the same session id under another role: only the session decides.
  await assert.rejects(store.reject(theirs.id, 'no', { author: AGENTA }), isStoreError('FORBIDDEN'))
  await assert.rejects(store.reject(users.id, 'no', { author: AGENTA }), isStoreError('FORBIDDEN'))
  await assert.rejects(store.reject(mine.id, 'no', { author: AGENTB }), isStoreError('FORBIDDEN'))
  assert.deepEqual([await objects(git), await refsUnder(git, 'refs/')], before)

  await store.reject(mine.id, 'I changed my mind', { author: { kind: 'agent', sessionId: 's1', role: 'other-role' } })
  await store.reject(theirs.id, 'user says no', { author: USERA })
  await store.reject(users.id, 'changed my mind', { author: USERA })
  assert.deepEqual(await store.proposals('open'), [])
  assert.deepEqual((await store.proposals('rejected')).map(item => [item.id, item.reason]).sort(), [
    [mine.id, 'I changed my mind'], [theirs.id, 'user says no'], [users.id, 'changed my mind'],
  ].sort())
  const record = (await git.resolve(`${REJECTED}${mine.id}`))!
  assert.equal(await gitAuthor(git, record), 'Test Agent')
  assert.equal(await storedMessage(git, record), [
    'Rejected: I changed my mind', '', 'Dish-Author-Kind: agent', 'Dish-Session: s1', 'Dish-Role: other-role',
    'Dish-Rejected: I changed my mind', `Dish-Proposal: ${mine.id}`, '',
  ].join('\n'))
})

test('reject: reason is normalized like a note, not empty, at most 200 characters, and free of secrets', async () => {
  const { store, git } = await openAt({ claims: [ns('prompts/')] })
  const proposals: ProposalInfo[] = []
  for (let n = 0; n < 4; n++) proposals.push(await make(store, [file(`prompts/p${n}`, '1')]))
  const [a, b, c, d] = proposals as [ProposalInfo, ProposalInfo, ProposalInfo, ProposalInfo]

  for (const reason of ['', '  \n\t ', 5, undefined, null, 'a\u0000b', 'a\u001bb']) {
    await refusesCleanly(git, () => store.reject(a.id, reason as string, { author: USERA }), isStoreError('INVALID', 'reason'))
  }
  await refusesCleanly(git, () => store.reject(a.id, `because ${TOKEN}`, { author: USERA }), isStoreError('SECRET', 'reason'))
  await refusesCleanly(git, () => store.reject(a.id, `${'x'.repeat(179)} AKIA${'A'.repeat(17)}`, { author: USERA }), isStoreError('SECRET', 'reason'))
  assert.deepEqual((await store.proposals('open')).length, 4, 'a refused reject leaves the proposal open')

  await store.reject(a.id, '  too \n  much\t\tspace  ', { author: USERA })
  await store.reject(b.id, 'y'.repeat(300), { author: USERA })
  await store.reject(c.id, `${'é'.repeat(199)}日本`, { author: USERA })
  await store.reject(d.id, `${'x'.repeat(179)} AKIA${'A'.repeat(15)}`, { author: USERA })
  const reasons = new Map((await store.proposals('rejected')).map(item => [item.id, item.reason!]))
  assert.equal(reasons.get(a.id), 'too much space')
  assert.equal(reasons.get(b.id), 'y'.repeat(200))
  assert.equal(reasons.get(c.id), `${'é'.repeat(199)}日`)
  assert.equal(reasons.get(d.id), `${'x'.repeat(179)} AKIA${'A'.repeat(15)}`)
  assert.equal(await storedMessage(git, (await git.resolve(`${REJECTED}${b.id}`))!), `Rejected: ${'y'.repeat(200)}\n\nDish-Author-Kind: user\nDish-Rejected: ${'y'.repeat(200)}\nDish-Proposal: ${b.id}\n`)
})

test('reject: an unknown or malformed id is NOT_FOUND, a bad author is INVALID', async () => {
  const { store } = await openAt({ claims: [ns('prompts/')] })
  const proposal = await make(store, [file('prompts/a', '1')])
  for (const id of ['deadbeef', '', 'main', '../main', 'x/y', 5, undefined]) {
    await assert.rejects(store.reject(id as string, 'why', { author: USERA }), isStoreError('NOT_FOUND'), String(id))
  }
  for (const author of [{ kind: 'system' }, undefined, null]) {
    await assert.rejects(store.reject(proposal.id, 'why', { author } as never), isStoreError('INVALID'))
  }
  await assert.rejects(store.reject(proposal.id, 'why', undefined as never), isStoreError('INVALID'))
  await assert.rejects(store.reject(proposal.id, 'why', { author: { kind: 'agent', sessionId: 'has space' } }), isStoreError('INVALID'))
  assert.equal((await store.proposals('open')).length, 1)
})

// --- listing ------------------------------------------------------------------------------------

test('proposals lists open, stale and rejected, newest first, and filters by status', async () => {
  const { store, git } = await openAt({ claims: [ns('prompts/')] })
  await put(store, [file('prompts/a', 'A'), file('prompts/b', 'B')])
  const base = await mainOf(git)
  const oldest = await forge(git, { id: '00000001', time: 1_600_000_000, changes: [file('prompts/a', 'old')] })
  const middle = await forge(git, { id: '00000002', time: 1_650_000_000, changes: [file('prompts/b', 'mid')] })
  const newer = await forge(git, { id: '00000003', time: 1_700_000_000, changes: [file('prompts/c', 'new')] })
  const live = await make(store, [file('prompts/d', 'live')])
  // Same second, so the id decides.
  const twin = await forge(git, { id: '00000004', time: 1_700_000_000, changes: [file('prompts/e', 'twin')] })
  await put(store, [file('prompts/a', 'A2')])  // makes 00000001 stale
  await store.reject('00000002', 'no thanks', { author: USERA })

  const all = await store.proposals()
  assert.deepEqual(all.map(item => [item.id, item.status]), [
    [live.id, 'open'], ['00000003', 'open'], ['00000004', 'open'], ['00000002', 'rejected'], ['00000001', 'stale'],
  ])
  assert.deepEqual(all.map(item => item.created), [...all.map(item => item.created)].sort((x, y) => y - x))
  assert.deepEqual((await store.proposals('open')).map(item => item.id), [live.id, '00000003', '00000004'])
  assert.deepEqual((await store.proposals('stale')).map(item => item.id), ['00000001'])
  assert.deepEqual((await store.proposals('rejected')).map(item => item.id), ['00000002'])

  const [, three, four, rejected, stale] = all
  assert.deepEqual(three, { id: '00000003', title: 'Forged', rationale: '', author: USERA, created: 1_700_000_000_000, base, tip: newer, paths: ['prompts/c'], status: 'open' })
  assert.equal(four!.tip, twin)
  assert.deepEqual(rejected, {
    id: '00000002', title: 'Forged', rationale: '', author: USERA, created: 1_650_000_000_000, base, tip: middle, paths: ['prompts/b'],
    status: 'rejected', reason: 'no thanks',
  })
  assert.equal(stale!.tip, oldest)
  assert.ok(!('reason' in three!))

  for (const status of ['done', 5, null]) {
    await assert.rejects(store.proposals(status as never), isStoreError('INVALID', 'status'))
  }
})

test('a ref that is not a well-formed proposal is skipped, never thrown on', async () => {
  const { store, git } = await openAt({ claims: [ns('prompts/')] })
  const head = (await put(store, [file('prompts/a', 'A')])).id
  const good = await make(store, [file('prompts/b', 'B')])
  const other = (await put(store, [file('prompts/z', 'Z')])).id
  const msg = (lines: string[]): string => `Forged\n\n${lines.join('\n')}\n`

  // Not a proposal: a plain commit (main's own), no trailers at all.
  assert.equal(await git.casRef(`${HEADS}cafebabe`, head, null), true)
  // The id in the trailer is not the ref's.
  await forge(git, { id: '11111111', message: msg(['Dish-Author-Kind: user', 'Dish-Proposal: 22222222', `Dish-Base: ${head}`]), base: head })
  // A ref name that is not 8 hex characters, though its trailer agrees.
  await forge(git, { id: 'feature', base: head })
  await forge(git, { id: '1234567', base: head })
  await forge(git, { id: '123456789', base: head })
  await forge(git, { id: 'ABCDEF12', base: head })
  await forge(git, { id: 'aa/bbbbbb', base: head, message: msg(['Dish-Author-Kind: user', 'Dish-Proposal: aa/bbbbbb', `Dish-Base: ${head}`]) })
  // Base missing, malformed, or not the commit's parent.
  await forge(git, { id: '33333333', message: msg(['Dish-Author-Kind: user', 'Dish-Proposal: 33333333']), base: head })
  await forge(git, { id: '44444444', message: msg(['Dish-Author-Kind: user', 'Dish-Proposal: 44444444', 'Dish-Base: main']), base: head })
  await forge(git, { id: '55555555', message: msg(['Dish-Author-Kind: user', 'Dish-Proposal: 55555555', `Dish-Base: ${other}`]), base: head })
  await forge(git, { id: '66666666', message: msg(['Dish-Author-Kind: user', 'Dish-Proposal: 66666666', `Dish-Base: ${'0'.repeat(40)}`]), base: head })
  // Two ids, two bases, a merge, a root commit.
  await forge(git, { id: '77777777', message: msg(['Dish-Author-Kind: user', 'Dish-Proposal: 77777777', 'Dish-Proposal: 77777777', `Dish-Base: ${head}`]), base: head })
  await forge(git, { id: '88888888', message: msg(['Dish-Author-Kind: user', 'Dish-Proposal: 88888888', `Dish-Base: ${head}`, `Dish-Base: ${head}`]), base: head })
  await forge(git, { id: '99999999', parents: [head, other], message: msg(['Dish-Author-Kind: user', 'Dish-Proposal: 99999999', `Dish-Base: ${head}`]), base: head })
  await forge(git, { id: 'aaaaaaaa', parents: [], message: msg(['Dish-Author-Kind: user', 'Dish-Proposal: aaaaaaaa', `Dish-Base: ${head}`]), base: head })
  // A trailer that git does not see as one: not in the last paragraph.
  await forge(git, { id: 'bbbbbbbb', message: `Forged\n\nDish-Proposal: bbbbbbbb\nDish-Base: ${head}\n\nand then some prose\n`, base: head })
  // A title or rationale that could not have come from propose.
  await forge(git, { id: 'cccccccc', message: `\u0007 bell\n\nDish-Author-Kind: user\nDish-Proposal: cccccccc\nDish-Base: ${head}\n`, base: head })
  await forge(git, { id: 'dddddddd', message: `Fine\n\nbell \u0007 here\n\nDish-Author-Kind: user\nDish-Proposal: dddddddd\nDish-Base: ${head}\n`, base: head })
  await forge(git, { id: 'eeeeeeee', message: `Fine\n\nDish-Base: ${'f'.repeat(40)}\n\nDish-Author-Kind: user\nDish-Proposal: eeeeeeee\nDish-Base: ${head}\n`, base: head })
  // Rejected records: no trailers, the wrong id, a parent that is not a proposal.
  await forge(git, { id: '12121212', ref: `${REJECTED}12121212`, base: head, message: 'Rejected: x\n\nDish-Author-Kind: user\n' })
  const proposed = await forge(git, { id: '34343434', ref: `${HEADS}34343434`, base: head })
  await forge(git, {
    id: '34343434', ref: `${REJECTED}56565656`, base: proposed, parents: [proposed],
    message: msg(['Dish-Author-Kind: user', 'Dish-Rejected: x', 'Dish-Proposal: 56565656']),
  })
  await forge(git, { id: '78787878', ref: `${REJECTED}78787878`, base: head, message: msg(['Dish-Author-Kind: user', 'Dish-Rejected: x', 'Dish-Proposal: 78787878']) })
  // A rejection commit that names another proposal than the ref and its own parent do.
  const named = await forge(git, { id: 'ee00ee00', base: head })
  await forge(git, { id: 'x', ref: `${REJECTED}ee00ee00`, base: named, parents: [named], message: msg(['Dish-Author-Kind: user', 'Dish-Rejected: x', 'Dish-Proposal: 99999999']) })
  // Records whose proposal is the right one, but whose rejection commit has no reason, or none that reads as a line.
  for (const [id, lines] of [['ee11ee11', []], ['ee22ee22', ['Dish-Rejected: ']], ['ee33ee33', ['Dish-Rejected: a', 'Dish-Rejected: b']], ['ee44ee44', ['Dish-Rejected: bell \u0007']]] as const) {
    const proposal = await forge(git, { id, base: head })
    await forge(git, { id: 'x', ref: `${REJECTED}${id}`, base: proposal, parents: [proposal], message: msg(['Dish-Author-Kind: user', ...lines, `Dish-Proposal: ${id}`]) })
  }
  // A rejection commit that is a merge.
  const merged = await forge(git, { id: 'ee55ee55', base: head })
  await forge(git, { id: 'x', ref: `${REJECTED}ee55ee55`, base: merged, parents: [merged, other], message: msg(['Dish-Author-Kind: user', 'Dish-Rejected: x', 'Dish-Proposal: ee55ee55']) })
  // A rejected ref that is not a commit (a blob, a tree).
  await git.casRef(`${REJECTED}12345678`, (await git.run(['hash-object', '-w', '--stdin'], { input: 'a blob' })).stdout.trim(), null)
  await git.casRef(`${REJECTED}87654321`, await treeOf(git, head), null)

  // What is valid: the real proposal, and 34343434 (a well-formed one, though based on an old main).
  assert.deepEqual((await store.proposals()).map(item => item.id).sort(), [good.id, '34343434', 'ee00ee00', 'ee11ee11', 'ee22ee22', 'ee33ee33', 'ee44ee44', 'ee55ee55'].sort())
  assert.deepEqual((await store.proposals('rejected')), [])
  for (const id of ['cafebabe', '11111111', '22222222', '33333333', '44444444', '55555555', '66666666', '77777777', '88888888', '99999999', 'aaaaaaaa', 'bbbbbbbb']) {
    await assert.rejects(store.accept(id, { author: USERA }), isStoreError('NOT_FOUND'), id)
    await assert.rejects(store.reject(id, 'why', { author: USERA }), isStoreError('NOT_FOUND'), id)
  }
  assert.equal(await mainOf(git), other)
  assert.ok(await store.accept(good.id, { author: USERA }))
})

test('a rejected record made outside the store is read the same way', async () => {
  const { store, git } = await openAt({ claims: [ns('prompts/')] })
  const head = await mainOf(git)
  const proposed = await forge(git, { id: '34343434', base: head, changes: [file('prompts/a', 'A')] })
  const msg = (lines: string[]): string => `Rejected: x\n\n${lines.join('\n')}\n`
  await forge(git, { id: 'x', ref: `${REJECTED}34343434`, base: proposed, parents: [proposed], message: msg(['Dish-Author-Kind: user', 'Dish-Rejected: not wanted', 'Dish-Proposal: 34343434']) })
  const [item] = await store.proposals('rejected')
  assert.equal(item!.id, '34343434')
  assert.equal(item!.reason, 'not wanted')
  assert.equal(item!.tip, proposed)
  assert.equal(item!.base, head)
})

// --- what accept copies onto main ----------------------------------------------------------------

test('accept scans what it copies onto main: a title, session or role that looks like a secret is SECRET, and the branch stays', async () => {
  const { store, git } = await openAt({ claims: [ns('prompts/')] })
  const head = await mainOf(git)
  const aws = `AKIA${'A'.repeat(16)}`
  const message = (id: string, title: string, session: string, role: string): string =>
    `${title}\n\nDish-Author-Kind: agent\nDish-Session: ${session}\nDish-Role: ${role}\nDish-Proposal: ${id}\nDish-Base: ${head}\n`
  const cases: Array<[string, string, string, string, string]> = [
    ['aaaaaaaa', `Use ${TOKEN}`, 's1', 'coder', 'title'],
    ['bbbbbbbb', 'Fine', aws, 'coder', 'sessionId'],
    ['cccccccc', 'Fine', 's1', aws, 'role'],
  ]
  for (const [id, title, session, role] of cases) {
    await forge(git, { id, changes: [file(`prompts/${id}`, '1')], message: message(id, title, session, role) })
  }
  // They are listed as they are; it is accept that refuses.
  assert.equal((await store.proposals()).length, 3)
  const before = [await objects(git), await refsUnder(git, 'refs/'), head]
  for (const [id, , , , field] of cases) {
    await assert.rejects(store.accept(id, { author: USERA }), (error: unknown) => {
      isStoreError('SECRET', field)(error)
      return !String((error as Error).message).includes(TOKEN) && !String((error as Error).message).includes(aws)
    })
  }
  assert.deepEqual([await objects(git), await refsUnder(git, 'refs/'), await mainOf(git)], before, 'nothing written, every branch kept')
  assert.equal((await store.proposals('open')).length, 3)
  // The user can reject them.
  await store.reject('aaaaaaaa', 'a token in the title', { author: USERA })
  assert.equal((await store.proposals('rejected')).length, 1)

  // The same shape with clean fields is accepted, and lands the proposer's session.
  await forge(git, { id: 'dddddddd', changes: [file('prompts/d', '1')], message: message('dddddddd', 'Fine', 's1', 'coder') })
  const accepted = await store.accept('dddddddd', { author: USERA })
  assert.match(accepted!.message, /^Accept proposal dddddddd: Fine\n\n.*Dish-Proposer-Session: s1\nDish-Proposer-Role: coder\n$/s)
})

test('accept never copies the rationale onto main', async () => {
  const { store, git } = await openAt({ claims: [ns('prompts/')] })
  const head = await mainOf(git)
  const rationale = `the token is ${TOKEN}`
  await forge(git, {
    id: 'eeeeeeee', changes: [file('prompts/e', '1')],
    message: `Fine title\n\n${rationale}\n\nDish-Author-Kind: user\nDish-Proposal: eeeeeeee\nDish-Base: ${head}\n`,
  })
  assert.equal((await store.proposals())[0]!.rationale, rationale)
  const accepted = await store.accept('eeeeeeee', { author: USERA })
  assert.ok(accepted)
  assert.ok(!accepted.message.includes('token'))
  assert.ok(!(await git.run(['log', '--format=%B', MAIN])).stdout.includes(TOKEN))
})

// --- git's scissors line --------------------------------------------------------------------------

test('git\'s scissors line in a title or rationale is INVALID, before git is touched', async () => {
  const { store, git } = await openAt({ claims: [ns('prompts/')] })
  const scissors = '# ------------------------ >8 ------------------------'
  for (const rationale of [scissors, `above\n${scissors}\nbelow`, `${scissors}\nbelow`, `above\n\n${scissors}`, `above\n${scissors}`]) {
    await refusesCleanly(git, () => make(store, [file('prompts/a', '1')], AGENTA, 'T', rationale), isStoreError('INVALID', 'rationale'))
  }
  await refusesCleanly(git, () => make(store, [file('prompts/a', '1')], AGENTA, scissors, ''), isStoreError('INVALID', 'title'))
  await refusesCleanly(git, () => make(store, [file('prompts/a', '1')], AGENTA, scissors, 'because'), isStoreError('INVALID', 'title'))

  // Near misses are not git's line, and read back.
  const fine = await make(store, [file('prompts/b', '1')], AGENTA, `see ${scissors}`, `# ----------------------- >8 ------------------------\nsee ${scissors}\n#${scissors}`)
  assert.deepEqual(await store.proposals(), [fine])
})

test('a branch with the scissors line in it is not listed, and is NOT_FOUND for accept and reject', async () => {
  const { store, git } = await openAt({ claims: [ns('prompts/')] })
  const head = await mainOf(git)
  const scissors = '# ------------------------ >8 ------------------------'
  await forge(git, { id: 'aaaaaaaa', changes: [file('prompts/a', '1')], message: `T\n\nabove\n${scissors}\nbelow\n\nDish-Author-Kind: user\nDish-Proposal: aaaaaaaa\nDish-Base: ${head}\n` })
  await forge(git, { id: 'bbbbbbbb', changes: [file('prompts/b', '1')], message: `${scissors}\n\nDish-Author-Kind: user\nDish-Proposal: bbbbbbbb\nDish-Base: ${head}\n` })
  assert.deepEqual(await store.proposals(), [])
  await assert.rejects(store.accept('aaaaaaaa', { author: USERA }), isStoreError('NOT_FOUND'))
  await assert.rejects(store.reject('bbbbbbbb', 'x', { author: USERA }), isStoreError('NOT_FOUND'))
})

// --- staleness: what main has done to the proposal's paths --------------------------------------------

interface Case {
  name: string
  base: Change[]
  proposal: Change[]
  main: Change[]
  /** Open: what accept returns (the paths it committed, or none), and what `main` holds after. Stale: the paths named in the refusal. */
  open?: { committed: string[], after: Record<string, string | undefined> }
  stale?: string[]
}

const staleness: Case[] = [
  { name: 'main took the proposed text', base: [file('prompts/a', 'A')], proposal: [file('prompts/a', 'X')], main: [file('prompts/a', 'X')],
    open: { committed: [], after: { 'prompts/a': 'X' } } },
  { name: 'main changed the path another way', base: [file('prompts/a', 'A')], proposal: [file('prompts/a', 'X')], main: [file('prompts/a', 'Y')],
    stale: ['prompts/a'] },
  { name: 'main deleted a path the proposal modifies', base: [file('prompts/a', 'A')], proposal: [file('prompts/a', 'X')], main: [gone('prompts/a')],
    stale: ['prompts/a'] },
  { name: 'main modified a path the proposal deletes', base: [file('prompts/a', 'A')], proposal: [gone('prompts/a')], main: [file('prompts/a', 'Y')],
    stale: ['prompts/a'] },
  { name: 'main deleted a path the proposal deletes', base: [file('prompts/a', 'A'), file('prompts/b', 'B')], proposal: [gone('prompts/a')], main: [gone('prompts/a')],
    open: { committed: [], after: { 'prompts/a': undefined, 'prompts/b': 'B' } } },
  { name: 'main added the proposed file as proposed', base: [file('prompts/b', 'B')], proposal: [file('prompts/n', 'N')], main: [file('prompts/n', 'N')],
    open: { committed: [], after: { 'prompts/n': 'N' } } },
  { name: 'main added the proposed file differently', base: [file('prompts/b', 'B')], proposal: [file('prompts/n', 'N')], main: [file('prompts/n', 'M')],
    stale: ['prompts/n'] },
  { name: 'main applied one path of two', base: [file('prompts/a', 'A'), file('prompts/b', 'B')], proposal: [file('prompts/a', 'X'), file('prompts/b', 'Z')], main: [file('prompts/a', 'X')],
    open: { committed: ['prompts/b'], after: { 'prompts/a': 'X', 'prompts/b': 'Z' } } },
  { name: 'main applied one path of two and changed the other', base: [file('prompts/a', 'A'), file('prompts/b', 'B')], proposal: [file('prompts/a', 'X'), file('prompts/b', 'Z')], main: [file('prompts/a', 'X'), file('prompts/b', 'W')],
    stale: ['prompts/b'] },
  { name: 'main applied a deletion and a change, and left a third alone', base: [file('prompts/a', 'A'), file('prompts/b', 'B'), file('prompts/c', 'C')],
    proposal: [gone('prompts/a'), file('prompts/b', 'Z'), file('prompts/c', 'Y')], main: [gone('prompts/a'), file('prompts/b', 'Z')],
    open: { committed: ['prompts/c'], after: { 'prompts/a': undefined, 'prompts/b': 'Z', 'prompts/c': 'Y' } } },
  { name: 'main changed an unrelated path', base: [file('prompts/a', 'A'), file('prompts/b', 'B')], proposal: [file('prompts/a', 'X')], main: [file('prompts/b', 'W')],
    open: { committed: ['prompts/a'], after: { 'prompts/a': 'X', 'prompts/b': 'W' } } },
]

for (const item of staleness) {
  test(`staleness: ${item.name}`, async () => {
    const { seen, onProposal } = events()
    const committed = recorder()
    const { store, git } = await openAt({ claims: [ns('prompts/')], onProposal, onCommit: committed.onCommit })
    await put(store, item.base)
    const proposal = await make(store, item.proposal)
    await put(store, item.main)
    committed.seen.length = 0
    const mainBefore = await mainOf(git)

    const [listed] = await store.proposals()
    assert.equal(listed!.status, item.stale === undefined ? 'open' : 'stale')
    assert.deepEqual(listed!.paths, proposal.paths, 'the paths are the proposal\'s, whatever main did')

    if (item.stale !== undefined) {
      await assert.rejects(store.accept(proposal.id, { author: USERA }), (error: unknown) => {
        isStoreError('STALE', ...item.stale!)(error)
        // Only the conflicting paths are named.
        for (const path of item.proposal.map(change => change.path)) {
          if (!item.stale!.includes(path)) assert.ok(!(error as Error).message.includes(path), `${path} is not named`)
        }
        return true
      })
      assert.equal(await mainOf(git), mainBefore)
      assert.equal(await git.resolve(`${HEADS}${proposal.id}`), proposal.tip, 'the branch is kept')
      assert.deepEqual(seen, [[proposal.id, 'open'], [proposal.id, 'stale']])
      return
    }
    const result = await store.accept(proposal.id, { author: USERA })
    if (item.open!.committed.length === 0) {
      assert.equal(result, undefined, 'nothing left to apply: no commit')
      assert.equal(await mainOf(git), mainBefore)
      assert.deepEqual(committed.seen, [])
    } else {
      assert.ok(result)
      assert.deepEqual(result.paths, item.open!.committed)
      assert.deepEqual(committed.seen, [result])
      assert.match(result.message, new RegExp(`^Accept proposal ${proposal.id}: A title\\n`))
    }
    for (const [path, text] of Object.entries(item.open!.after)) assert.equal(await store.read(path), text, path)
    assert.deepEqual(await refsUnder(git, HEADS), [], 'the branch is gone')
    assert.deepEqual(seen, [[proposal.id, 'open'], [proposal.id, 'accepted']])
  })
}

// --- staleness: files and directories ---------------------------------------------------------------

test('a file on main where the proposal adds a directory, or a directory where it adds a file, makes it stale', async () => {
  const { store, git } = await openAt({ claims: [ns('x/')] })
  await put(store, [file('x/keep', 'K'), file('x/dir/one', '1')])
  const under = await make(store, [file('x/a/b', 'B')])
  const over = await make(store, [file('x/d', 'D')])
  const swap = await make(store, [gone('x/dir/one'), file('x/dir', 'now a file')])
  const status = async (): Promise<Record<string, string>> => Object.fromEntries((await store.proposals()).map(item => [item.id, item.status]))
  assert.deepEqual(await status(), { [under.id]: 'open', [over.id]: 'open', [swap.id]: 'open' })

  await put(store, [file('x/a', 'a file now'), file('x/d/e', 'a directory now'), file('x/dir/new', 'a new child')])
  assert.deepEqual(await status(), { [under.id]: 'stale', [over.id]: 'stale', [swap.id]: 'stale' })
  const before = [await objects(git), await refsUnder(git, 'refs/'), await mainOf(git)]
  for (const proposal of [under, over, swap]) await assert.rejects(store.accept(proposal.id, { author: USERA }), isStoreError('STALE', proposal.paths[0]!))
  assert.deepEqual([await objects(git), await refsUnder(git, 'refs/'), await mainOf(git)], before, 'a refused accept writes nothing')
})

test('a proposal that swaps a file and a directory still accepts after main edits something else', async () => {
  const { store } = await openAt({ claims: [ns('x/')] })
  await put(store, [file('x/s', 'S'), file('x/dir/one', '1'), file('x/dir/two', '2'), file('x/other', 'O')])
  const toDir = await make(store, [gone('x/s'), file('x/s/t', 'T')])
  const toFile = await make(store, [gone('x/dir/one'), gone('x/dir/two'), file('x/dir', 'now a file')])
  await put(store, [file('x/other', 'O2')])
  assert.deepEqual((await store.proposals()).map(item => item.status), ['open', 'open'])
  assert.ok(await store.accept(toDir.id, { author: USERA }))
  assert.ok(await store.accept(toFile.id, { author: USERA }))
  assert.deepEqual(await store.list(''), ['x/dir', 'x/other', 'x/s/t'])
})

test('a directory that main has emptied, or a file that main has removed, is no obstacle', async () => {
  const { store } = await openAt({ claims: [ns('x/')] })
  await put(store, [file('x/dir/one', '1'), file('x/f', 'F'), file('x/other', 'O')])
  const toFile = await make(store, [gone('x/dir/one'), file('x/dir', 'now a file')])
  const toDir = await make(store, [gone('x/f'), file('x/f/g', 'G')])
  // Main already did the deleting half of both; and changed something else.
  await put(store, [gone('x/dir/one'), gone('x/f'), file('x/other', 'O2')])
  assert.deepEqual((await store.proposals()).map(item => item.status), ['open', 'open'])
  assert.ok(await store.accept(toFile.id, { author: USERA }))
  assert.ok(await store.accept(toDir.id, { author: USERA }))
  assert.deepEqual(await store.list(''), ['x/dir', 'x/f/g', 'x/other'])
})

test('a branch the tree refuses at accept time is STALE, not a raw INVALID, and stays', async () => {
  const { seen, onProposal } = events()
  const { store, git } = await openAt({ claims: [ns('prompts/')], onProposal })
  // `git~1` is how Windows can spell `.git`: buildTree refuses it, though neither the guard nor the listing can tell.
  const blob = (await git.run(['hash-object', '-w', '--stdin'], { input: 'x' })).stdout.trim()
  const inner = (await git.run(['mktree'], { input: `100644 blob ${blob}\tx\n` })).stdout.trim()
  const middle = (await git.run(['mktree'], { input: `040000 tree ${inner}\tgit~1\n` })).stdout.trim()
  const tree = (await git.run(['mktree'], { input: `040000 tree ${middle}\tprompts\n` })).stdout.trim()
  await forge(git, { id: 'aaaaaaaa', tree })
  assert.deepEqual((await store.proposals()).map(item => [item.id, item.status, item.paths]), [['aaaaaaaa', 'open', ['prompts/git~1/x']]])
  const head = await mainOf(git)
  await assert.rejects(store.accept('aaaaaaaa', { author: USERA }), (error: unknown) => {
    isStoreError('STALE', 'aaaaaaaa')(error)
    // What git said about the path is cut to its first line: the whole of its stderr would be several.
    assert.ok(!(error as Error).message.includes('\n'), `one line: ${JSON.stringify((error as Error).message)}`)
    return true
  })
  assert.equal(await mainOf(git), head)
  assert.ok(await git.resolve(`${HEADS}aaaaaaaa`))
  assert.deepEqual(seen, [['aaaaaaaa', 'stale']])
})

// --- the user's git config ------------------------------------------------------------------------------

test('trailers are read whatever separators the user\'s git config sets', async () => {
  const { store } = await openAt({ claims: [ns('prompts/')] })
  await withGlobalConfig('[trailer]\n\tseparators = "="\n', async () => {
    const proposal = await make(store, [file('prompts/a', '1')], AGENTA, 'Title', 'because')
    assert.deepEqual(proposal.author, AGENTA)
    assert.deepEqual(await store.proposals('open'), [proposal])
    const accepted = await store.accept(proposal.id, { author: USERA })
    assert.ok(accepted)
    assert.deepEqual(accepted.author, USERA)
    const [newest] = await store.history()
    assert.deepEqual(newest, accepted)
    const other = await make(store, [file('prompts/b', '1')], AGENTA)
    await store.reject(other.id, 'no', { author: USERA })
    assert.deepEqual((await store.proposals('rejected')).map(item => [item.id, item.reason]), [[other.id, 'no']])
  })
})

// --- refs that are not branches -------------------------------------------------------------------------

test('an annotated tag under proposal/ is not a proposal: not listed, NOT_FOUND for accept and reject', async () => {
  const { store, git, repository } = await openAt({ claims: [ns('prompts/')] })
  const head = await mainOf(git)
  const tip = await forge(git, { id: 'bbbbbbbb', changes: [file('prompts/a', '1')] })
  const tag = (await git.run(['mktag'], { input: `object ${tip}\ntype commit\ntag t\ntagger x <x@x> 0 +0000\n\nmsg\n` })).stdout.trim()
  // `update-ref` refuses a tag on a branch ref, so write the loose ref as an outside tool could.
  const loose = join(repository, `${HEADS}cccccccc`)
  await mkdir(dirname(loose), { recursive: true })
  await writeFile(loose, `${tag}\n`)
  assert.deepEqual((await store.proposals()).map(item => item.id), ['bbbbbbbb'])
  await assert.rejects(store.accept('cccccccc', { author: USERA }), isStoreError('NOT_FOUND'))
  await assert.rejects(store.reject('cccccccc', 'x', { author: USERA }), isStoreError('NOT_FOUND'))
  assert.equal(await mainOf(git), head)
  assert.equal((await git.run(['rev-parse', `${HEADS}cccccccc`])).stdout.trim(), tag, 'the ref is untouched')
})

// --- events -------------------------------------------------------------------------------------

test('an onProposal callback that throws does not fail what already happened', async () => {
  const store = await openStore({ claims: [ns('prompts/')], onProposal: () => { throw new Error('listener bug') } })
  const warned = once(process, 'warning')
  const proposal = await make(store, [file('prompts/a', '1')])
  const [warning] = await warned
  assert.match(String((warning as Error).message), /onProposal.*listener bug/)
  assert.deepEqual(await store.proposals('open'), [proposal])
})

test('events follow the life of proposals: open, stale on a refused accept, accepted, rejected', async () => {
  const { seen, onProposal } = events()
  const { store } = await openAt({ claims: [ns('prompts/')], onProposal })
  await put(store, [file('prompts/a', 'A')])
  const one = await make(store, [file('prompts/a', '1')])
  const two = await make(store, [file('prompts/b', '2')])
  const three = await make(store, [file('prompts/c', '3')])
  await put(store, [file('prompts/a', 'edited')])
  await assert.rejects(store.accept(one.id, { author: USERA }))
  await store.accept(two.id, { author: USERA })
  await store.reject(three.id, 'no', { author: USERA })
  await store.proposals()
  assert.deepEqual(seen, [
    [one.id, 'open'], [two.id, 'open'], [three.id, 'open'], [one.id, 'stale'], [two.id, 'accepted'], [three.id, 'rejected'],
  ])
})

test('operations on a closed store are refused like the others', async () => {
  const { store } = await openAt({ claims: [ns('prompts/')] })
  await store.close()
  await assert.rejects(store.propose([file('prompts/a', '1')], { author: USERA, title: 't', rationale: '' }), /closed/)
  await assert.rejects(store.proposals(), /closed/)
  await assert.rejects(store.accept('deadbeef', { author: USERA }), /closed/)
  await assert.rejects(store.reject('deadbeef', 'x', { author: USERA }), /closed/)
})
