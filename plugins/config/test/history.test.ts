import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Change, Git } from '../src/store/git.ts'
import type { Author, CommitInfo, ConfigStore, EditAuthor } from '../src/store/store.ts'
import { AGENT, AGENTA, USER, USERA, isPlainError, isStoreError, ns, openAt, recorder, tempDir } from './helpers.ts'

const MAIN = 'refs/heads/main'
const ZEROS = '0'.repeat(40)
const SYSTEM = { kind: 'system' } as const

/** `store.write` for a write that must make a commit. */
async function put(store: ConfigStore, changes: Change[], author: EditAuthor = USERA, note?: string): Promise<CommitInfo> {
  const info = await store.write(changes, note === undefined ? { author } : { author, note })
  assert.ok(info, 'the write made a commit')
  return info
}

const file = (path: string, text: string): Change => ({ path, text })

async function mainOf(git: Git): Promise<string> {
  const head = await git.resolve(MAIN)
  assert.ok(head)
  return head
}

/** Commit straight to `main` with git, as an outside writer would: the tree is `main`'s plus `changes`, the message is exactly `message`. */
async function forge(git: Git, message: string, changes: Change[] = []): Promise<string> {
  const head = await mainOf(git)
  const id = await git.commitTree(await git.buildTree(head, changes), [head], message, USER)
  assert.equal(await git.casRef(MAIN, id, head), true)
  return id
}

/** A commit with no parent, not on any ref, holding `changes`. */
async function orphan(git: Git, message: string, changes: Change[]): Promise<string> {
  return git.commitTree(await git.buildTree(undefined, changes), [], message, USER)
}

const ids = (log: CommitInfo[]): string[] => log.map(info => info.id)

// --- history ------------------------------------------------------------------------------------

test('history lists commits newest first with authors, notes and paths, and filters by path or prefix', async () => {
  const { store, git } = await openAt({ claims: [ns('prompts/'), ns('crew.yaml', 'write', 'crew')] })
  const a = await put(store, [file('prompts/a.md', 'A')])
  const b = await put(store, [file('prompts/b.md', 'B'), file('crew.yaml', 'c: 1')], AGENTA, 'tidy up')
  const c = await put(store, [file('prompts/a.md', 'A2')])

  const log = await store.history()
  assert.equal(log.length, 4)
  assert.deepEqual(log.slice(0, 3), [c, b, a], 'what write returned, field for field')
  const root = log[3]!
  assert.equal(root.id, (await git.run(['rev-list', '--max-parents=0', MAIN])).stdout.trim())
  assert.deepEqual(root.author, SYSTEM)
  assert.deepEqual(root.paths, [])
  assert.equal(root.message, 'Initialize dish config\n\nDish-Author-Kind: system\n')
  assert.ok(!('note' in root))

  assert.deepEqual(ids(await store.history({ path: 'prompts/a.md' })), [c.id, a.id])
  assert.deepEqual(ids(await store.history({ path: 'crew.yaml' })), [b.id])
  assert.deepEqual(ids(await store.history({ prefix: 'prompts/' })), [c.id, b.id, a.id])
  assert.deepEqual(ids(await store.history({ prefix: 'prompts' })), [c.id, b.id, a.id])
  assert.deepEqual(ids(await store.history({ prefix: 'prompt' })), [], 'a prefix is whole path components')
  assert.deepEqual(ids(await store.history({ path: 'nothing.md' })), [])
})

test('history shows a deleted path, a seed commit as the system author, and every commit exactly as write returned it', async () => {
  const { store } = await openAt({ claims: [ns('prompts/', 'write', 'prompts')] })
  const seeded = await store.seed({ 'prompts/a.md': 'A' }, 'prompts')
  assert.ok(seeded)
  const deleted = await store.write([{ path: 'prompts/a.md', delete: true }], { author: USERA })
  assert.ok(deleted)
  const log = await store.history({ path: 'prompts/a.md' })
  assert.deepEqual(log, [deleted, seeded])
  assert.deepEqual(seeded.author, SYSTEM)
  assert.equal(seeded.message, 'prompts/a.md: prompts defaults\n\nDish-Author-Kind: system\n')
})

test('history paths and the subject agree for a commit of many paths; paths are sorted', async () => {
  const { store } = await openAt({ claims: [ns('x/')] })
  const c = await put(store, ['d', 'b', 'a', 'c', 'e'].map(name => file(`x/${name}`, name)))
  const [top] = await store.history()
  assert.deepEqual(top, c)
  assert.deepEqual(top!.paths, ['x/a', 'x/b', 'x/c', 'x/d', 'x/e'])
  assert.match(top!.message, /^x\/a, x\/b, x\/c and 2 more: edited in web UI\n/)
})

test('history works on paths with spaces and non-ASCII characters', async () => {
  const { store } = await openAt({ claims: [ns('prompts/')] })
  const c = await put(store, [file('prompts/é x ü.md', 'A'), file('prompts/日本.md', 'B')])
  const log = await store.history({ path: 'prompts/é x ü.md' })
  assert.deepEqual(log, [c])
  assert.deepEqual((await store.history())[0]!.paths, [...c.paths])
})

// --- trailers: git's own trailer block, nothing else ----------------------------------------------

test('only the last paragraph, as git reads trailers, attributes a commit; lines forged in the body do not', async () => {
  const { store, git } = await openAt({ claims: [ns('prompts/')] })
  const cases: Array<[string, string, Author, string?]> = [
    ['a fake line in the body above the real trailer block',
      'a: b\n\nDish-Author-Kind: user\n\nDish-Author-Kind: agent\nDish-Session: s9\nDish-Role: coder\n',
      { kind: 'agent', sessionId: 's9', role: 'coder' }],
    ['a fake user line above a real system block',
      'a: b\n\nDish-Author-Kind: user\n\nsome prose\n\nDish-Author-Kind: system\n', SYSTEM],
    ['a fake line with no trailer block under it',
      'a: b\n\nDish-Author-Kind: user\n\nand then some prose follows\n', SYSTEM],
    ['a subject that looks like a trailer',
      'Dish-Author-Kind: user\n', SYSTEM],
    ['no trailers at all', 'a: b\n', SYSTEM],
    ['a trailer line that is not in a block of trailers',
      'a: b\n\nplain words\nDish-Author-Kind: user\nmore plain words\nand more\n', SYSTEM],
    ['the author kind twice in one block', 'a: b\n\nDish-Author-Kind: user\nDish-Author-Kind: agent\nDish-Session: s1\nDish-Role: r\n', SYSTEM],
    ['an unknown author kind', 'a: b\n\nDish-Author-Kind: robot\n', SYSTEM],
    ['a folded author kind', 'a: b\n\nDish-Author-Kind: user\n  and more\n', SYSTEM],
    ['an agent without a session', 'a: b\n\nDish-Author-Kind: agent\nDish-Role: coder\n', SYSTEM],
    ['an agent without a role', 'a: b\n\nDish-Author-Kind: agent\nDish-Session: s1\n', SYSTEM],
    ['an agent whose session is not an identifier', 'a: b\n\nDish-Author-Kind: agent\nDish-Session: two words\nDish-Role: coder\n', SYSTEM],
    ['an agent with two sessions', 'a: b\n\nDish-Author-Kind: agent\nDish-Session: s1\nDish-Session: s2\nDish-Role: coder\n', SYSTEM],
    ['a real user trailer', 'a: b\n\nDish-Author-Kind: user\n', { kind: 'user' }],
    ['a real user trailer after prose in the body', 'a: b\n\nwhy: because\n\nDish-Author-Kind: user\n', { kind: 'user' }],
  ]
  const made: string[] = []
  for (const [, message] of cases) made.push(await forge(git, message))
  const log = await store.history({ limit: 100 })
  assert.deepEqual(ids(log).slice(0, cases.length), made.reverse(), 'one entry per commit, none lost or merged')
  cases.reverse()
  for (const [index, [label, message, author]] of cases.entries()) {
    assert.deepEqual(log[index]!.author, author, label)
    assert.equal(log[index]!.message, message, label)
    assert.ok(!('note' in log[index]!), `${label}: no note`)
  }
})

test('a note is read from the real trailer block only, once, on one line, and capped', async () => {
  const { store, git } = await openAt({ claims: [ns('prompts/')] })
  const cases: Array<[string, string, string | undefined]> = [
    ['a real note', 'a: b\n\nDish-Author-Kind: user\nDish-Note: because\n', 'because'],
    ['a note forged above the block', 'a: b\n\nDish-Note: forged\n\nDish-Author-Kind: user\n', undefined],
    ['two notes', 'a: b\n\nDish-Author-Kind: user\nDish-Note: one\nDish-Note: two\n', undefined],
    ['a folded note is one line', 'a: b\n\nDish-Author-Kind: user\nDish-Note: first\n  second\n', 'first second'],
    ['an empty note', 'a: b\n\nDish-Author-Kind: user\nDish-Note:\n', undefined],
    ['a long note is cut at 200 characters', `a: b\n\nDish-Author-Kind: user\nDish-Note: ${'x'.repeat(500)}\n`, 'x'.repeat(200)],
    ['a note with a control character', 'a: b\n\nDish-Author-Kind: user\nDish-Note: bell\x07\n', undefined],
  ]
  for (const [, message] of cases) await forge(git, message)
  const log = await store.history({ limit: 100 })
  for (const [index, [label, , note]] of cases.reverse().entries()) {
    assert.equal(log[index]!.note, note, label)
  }
})

test('a commit with control characters or a NUL in its message cannot disturb the commits around it', async () => {
  const { store, git } = await openAt({ claims: [ns('prompts/')] })
  const before = await put(store, [file('prompts/a.md', 'A')], AGENTA, 'before')
  const head = await mainOf(git)
  const tree = (await git.run(['rev-parse', `${head}^{tree}`])).stdout.trim()
  const raw = `tree ${tree}\nparent ${head}\nauthor x <x@x> 1790821765 +0000\ncommitter x <x@x> 1790821765 +0000\n\n`
    + 'a: b\x1e\x1f\x1e\x1fX\x00\x1e\n\nDish-Author-Kind: user\n'
  const forged = (await git.run(['hash-object', '-t', 'commit', '-w', '--literally', '--stdin'], { input: raw })).stdout.trim()
  assert.equal(await git.casRef(MAIN, forged, head), true)
  const control = await forge(git, 'a: b\x1e\x1f\x1e\x1f\x1b[2J\n\nDish-Author-Kind: user\n')
  const after = await put(store, [file('prompts/b.md', 'B')], USERA, 'after')

  const log = await store.history()
  assert.deepEqual(ids(log).slice(0, 4), [after.id, control, forged, before.id])
  assert.deepEqual(log[0], after)
  assert.deepEqual(log[3], before)
  assert.deepEqual(log[1]!.author, { kind: 'user' }, 'control characters in the subject do not matter to the real block')
  assert.deepEqual(log[2]!.author, SYSTEM, 'git sees the message end at the NUL, so the trailer under it is not there')
})

// --- history: limit, before, validation ----------------------------------------------------------

async function manyCommits(store: ConfigStore, count: number): Promise<CommitInfo[]> {
  const made: CommitInfo[] = []
  for (let n = 0; n < count; n++) made.push(await put(store, [file(`prompts/${n % 2 === 0 ? 'even' : 'odd'}.md`, String(n))]))
  return made
}

test('limit caps the result: default 50, at least 1, at most 500', async () => {
  const { store, git } = await openAt({ claims: [ns('prompts/')] })
  const made = await manyCommits(store, 3)
  assert.deepEqual(ids(await store.history({ limit: 2 })), [made[2]!.id, made[1]!.id])
  assert.equal((await store.history({ limit: 1 })).length, 1)
  for (const limit of [0, -5, -Infinity, 0.5]) assert.equal((await store.history({ limit })).length, 1, `limit ${limit}`)
  assert.equal((await store.history({ limit: 2.9 })).length, 2, 'fractions are cut')
  assert.equal((await store.history({ limit: 1000 })).length, 4)
  assert.equal((await store.history({ limit: Infinity })).length, 4)

  // 505 more commits, made in one go: the default is 50 and 500 is the most.
  const head = await mainOf(git)
  let script = ''
  for (let n = 0; n < 505; n++) {
    const message = `prompts/n.md: ${n}\n\nDish-Author-Kind: user\n`
    script += `commit ${MAIN}\ncommitter t <t@t> ${1790000000 + n} +0000\ndata ${Buffer.byteLength(message)}\n${message}\n`
    if (n === 0) script += `from ${head}\n`
    script += `M 100644 inline prompts/n.md\ndata ${String(n).length}\n${n}\n\n`
  }
  await git.run(['fast-import', '--quiet', '--force'], { input: script })
  assert.equal((await store.history()).length, 50)
  assert.equal((await store.history({ limit: 7 })).length, 7)
  const most = await store.history({ limit: 600 })
  assert.equal(most.length, 500)
  assert.match(most[0]!.message, /^prompts\/n\.md: 504\n/, 'the newest 500, not the oldest')
})

test('before: commits strictly older than it, newest first; paging with it visits every commit once', async () => {
  const { store } = await openAt({ claims: [ns('prompts/')] })
  const [c1, c2, c3, c4] = (await manyCommits(store, 4)) as [CommitInfo, CommitInfo, CommitInfo, CommitInfo]
  const all = await store.history()
  const root = all[4]!
  assert.deepEqual(ids(await store.history({ before: c4.id })), [c3.id, c2.id, c1.id, root.id])
  assert.deepEqual(ids(await store.history({ before: c4.id, limit: 2 })), [c3.id, c2.id])
  assert.deepEqual(ids(await store.history({ before: c2.id, limit: 2 })), [c1.id, root.id])
  assert.deepEqual(await store.history({ before: root.id }), [], 'nothing is older than the first commit')
  assert.deepEqual(ids(await store.history({ before: c1.id })), [root.id])

  const paged: string[] = []
  let before: string | undefined
  for (;;) {
    const page = await store.history(before === undefined ? { limit: 2 } : { limit: 2, before })
    if (page.length === 0) break
    paged.push(...ids(page))
    before = page[page.length - 1]!.id
  }
  assert.deepEqual(paged, ids(all))

  // With a path: older commits that touched it, starting below `before` whether or not `before` touched it.
  assert.deepEqual(ids(await store.history({ path: 'prompts/even.md', before: c3.id })), [c1.id])
  assert.deepEqual(ids(await store.history({ path: 'prompts/even.md', before: c4.id })), [c3.id, c1.id])
  assert.deepEqual(ids(await store.history({ prefix: 'prompts/', before: c2.id })), [c1.id])
})

test('before must be a full commit id on main: anything else is NOT_FOUND', async () => {
  const { store, git } = await openAt({ claims: [ns('prompts/')] })
  const [c1] = await manyCommits(store, 1)
  const stray = await orphan(git, 'stray\n', [file('prompts/s.md', 's')])
  const tree = (await git.run(['rev-parse', `${c1!.id}^{tree}`])).stdout.trim()
  const bad: unknown[] = ['main', 'refs/heads/main', 'HEAD', c1!.id.slice(0, 12), c1!.id.toUpperCase(), ZEROS, tree, stray, '', 'zz', `${c1!.id}^`, 5, null, ['x']]
  for (const before of bad) {
    await assert.rejects(store.history({ before: before as string }), isStoreError('NOT_FOUND'), `before ${String(before)}`)
  }
})

test('history: path and prefix together, or either unusable as a path, are INVALID', async () => {
  const { store } = await openAt({ claims: [ns('prompts/')] })
  type Query = Parameters<ConfigStore['history']>[0]
  const invalid = async (query: unknown, why: string): Promise<void> =>
    assert.rejects(store.history(query as Query), isStoreError('INVALID'), why)
  await invalid({ path: 'prompts/a.md', prefix: 'prompts/' }, 'path and prefix together')
  await invalid({ path: '', prefix: '' }, 'both, even when empty')
  for (const path of ['', '/abs', '../x', 'a/../b', 'a//b', '.git/config', 'a\\b', 'a\nb', 'a/', '.', 5, null]) {
    await invalid({ path }, `path ${JSON.stringify(path)}`)
  }
  for (const prefix of ['', '/', '//', 'a//', '../x', '.git', 'a/./b', 'a\0b', 5, null]) {
    await invalid({ prefix }, `prefix ${JSON.stringify(prefix)}`)
  }
  for (const limit of [Number.NaN, '5', null, {}]) await invalid({ limit }, `limit ${String(limit)}`)
  await invalid(null, 'a null query')
  await invalid('prompts/', 'a string query')
  // Anything that could be a path is one, and it is not a pattern.
  assert.deepEqual(await store.history({ prefix: 'prompts/' }), [])
  assert.deepEqual(await store.history({ path: 'prompts/*' }), [])
  assert.deepEqual(await store.history({ prefix: '*' }), [])
  assert.deepEqual(await store.history({ path: ':(top)prompts' }), [])
})

test('a pattern in path or prefix matches only a file or directory of that exact name', async () => {
  const { store } = await openAt({ claims: [ns('p/')] })
  const a = await put(store, [file('p/a.md', 'A'), file('p/*', 'star')])
  assert.deepEqual(ids(await store.history({ path: 'p/*' })), [a.id])
  const b = await put(store, [file('p/b.md', 'B')])
  assert.deepEqual(ids(await store.history({ path: 'p/*' })), [a.id], 'p/* is not a glob')
  assert.deepEqual(ids(await store.history({ prefix: 'p/' })), [b.id, a.id])
})

test('history is a store operation: it throws a plain Error once the store is closed', async () => {
  const { store } = await openAt()
  await store.close()
  await assert.rejects(store.history(), isPlainError(/closed/))
  await assert.rejects(store.diff('main', 'main'), isPlainError(/closed/))
  await assert.rejects(store.commit('main'), isPlainError(/closed/))
  await assert.rejects(store.revert(ZEROS, { author: USERA }), isPlainError(/closed/))
})

// --- diff ------------------------------------------------------------------------------------------

test('diff reports added, modified and deleted files, and each patch holds the changed lines', async () => {
  const { store } = await openAt({ claims: [ns('prompts/')] })
  const c1 = await put(store, [file('prompts/a.md', 'one\n'), file('prompts/b.md', 'keep me\n')])
  const c2 = await put(store, [file('prompts/a.md', 'one\ntwo\n'), file('prompts/c.md', 'brand new\n'), { path: 'prompts/b.md', delete: true }])

  const diffs = await store.diff(c1.id, c2.id)
  assert.deepEqual(diffs.map(({ path, status }) => ({ path, status })), [
    { path: 'prompts/a.md', status: 'modified' },
    { path: 'prompts/b.md', status: 'deleted' },
    { path: 'prompts/c.md', status: 'added' },
  ])
  const [a, b, c] = diffs as [typeof diffs[0], typeof diffs[0], typeof diffs[0]]
  assert.match(a.patch, /^diff --git a\/prompts\/a\.md b\/prompts\/a\.md\n/)
  assert.match(a.patch, /^\+two$/m)
  assert.doesNotMatch(a.patch, /keep me|brand new/, 'only this file')
  assert.match(b.patch, /^-keep me$/m)
  assert.match(b.patch, /^deleted file mode/m)
  assert.match(c.patch, /^\+brand new$/m)
  assert.match(c.patch, /^new file mode/m)

  const reverse = await store.diff(c2.id, c1.id)
  assert.deepEqual(reverse.map(d => d.status), ['modified', 'added', 'deleted'])
  assert.match(reverse[0]!.patch, /^-two$/m)
})

test('diff takes main, a full commit id or the empty tree; a path narrows it', async () => {
  const { store, git } = await openAt({ claims: [ns('prompts/')] })
  const c1 = await put(store, [file('prompts/a.md', 'A\n'), file('prompts/é x.md', 'E\n')])
  const c2 = await put(store, [file('prompts/a.md', 'A2\n')])
  const empty = await git.emptyTree()

  assert.deepEqual(await store.diff('main', 'main'), [])
  assert.deepEqual(await store.diff(c2.id, c2.id), [])
  assert.deepEqual((await store.diff(c1.id, 'main')).map(d => d.path), ['prompts/a.md'])
  assert.deepEqual(await store.diff(c1.id, 'main'), await store.diff(c1.id, c2.id))
  const fromEmpty = await store.diff(empty, 'main')
  assert.deepEqual(fromEmpty.map(({ path, status }) => `${status} ${path}`), ['added prompts/a.md', 'added prompts/é x.md'])
  assert.match(fromEmpty[1]!.patch, /^\+E$/m)
  assert.deepEqual((await store.diff('main', empty)).map(d => d.status), ['deleted', 'deleted'])
  assert.deepEqual(await store.diff(empty, empty), [])

  assert.deepEqual((await store.diff(empty, 'main', 'prompts/é x.md')).map(d => d.path), ['prompts/é x.md'])
  assert.deepEqual((await store.diff(empty, 'main', 'prompts')).map(d => d.path), ['prompts/a.md', 'prompts/é x.md'], 'a directory path')
  assert.deepEqual(await store.diff(c1.id, c2.id, 'prompts/é x.md'), [], 'a path the range did not touch')
  assert.deepEqual(await store.diff(empty, 'main', 'prompts/*'), [], 'a path is not a pattern')
})

test('diff refuses what is not main, a full commit id or the empty tree: NOT_FOUND; a bad path is INVALID', async () => {
  const { store, git } = await openAt({ claims: [ns('prompts/')] })
  const c1 = await put(store, [file('prompts/a.md', 'A')])
  const tree = (await git.run(['rev-parse', `${c1.id}^{tree}`])).stdout.trim()
  const bad = ['HEAD', 'refs/heads/main', 'main~1', `${c1.id}^`, c1.id.slice(0, 12), c1.id.toUpperCase(), ZEROS, tree,
    '--output=/tmp/dish-should-not-exist', '-p', '', ' main', 'Main']
  for (const ref of bad) {
    await assert.rejects(store.diff(ref, 'main'), isStoreError('NOT_FOUND'), `from ${ref}`)
    await assert.rejects(store.diff('main', ref), isStoreError('NOT_FOUND'), `to ${ref}`)
  }
  for (const path of ['', '/abs', '../x', 'a//b', '.git/x', 'a/']) {
    await assert.rejects(store.diff('main', 'main', path), isStoreError('INVALID'), `path ${JSON.stringify(path)}`)
  }
  await assert.rejects(store.diff('main', 'main', 5 as unknown as string), isStoreError('INVALID'))
  await assert.rejects(stat('/tmp/dish-should-not-exist'), { code: 'ENOENT' })
})

test('diff and commit never run an external diff program or a textconv, whatever the user\'s git config says', async () => {
  const dir = await tempDir()
  const marker = join(dir, 'ran')
  const script = join(dir, 'evil.sh')
  await writeFile(script, `#!/bin/sh\necho ran >> '${marker}'\nexit 0\n`)
  await chmod(script, 0o755)
  const config = join(dir, 'gitconfig')
  await writeFile(config, `[diff]\n\texternal = ${script}\n[diff "evil"]\n\ttextconv = ${script}\n`)

  const { store, git, repository } = await openAt({ claims: [ns('prompts/')] })
  await mkdir(join(repository, 'info'), { recursive: true })
  await writeFile(join(repository, 'info', 'attributes'), '*.md diff=evil\n')
  const c1 = await put(store, [file('prompts/a.md', 'one\n')])
  const c2 = await put(store, [file('prompts/a.md', 'one\ntwo\n')])

  const ran = async (): Promise<boolean> => stat(marker).then(() => true, () => false)
  const previous = process.env.GIT_CONFIG_GLOBAL
  process.env.GIT_CONFIG_GLOBAL = config
  try {
    // The controls: plain git does run both, so the test would notice if they stopped being set up.
    await git.run(['diff', c1.id, c2.id])
    assert.equal(await ran(), true, 'git runs the external diff when allowed')
    await rm(marker)
    await git.run(['diff', '--no-ext-diff', c1.id, c2.id])
    assert.equal(await ran(), true, 'git runs the textconv when allowed')
    await rm(marker)

    const diffs = await store.diff(c1.id, c2.id)
    assert.equal(await ran(), false, 'diff ran nothing')
    assert.deepEqual(diffs.map(d => d.status), ['modified'])
    assert.match(diffs[0]!.patch, /^\+two$/m, 'the patch is git\'s own')
    const { diffs: shown } = await store.commit(c2.id)
    assert.match(shown[0]!.patch, /^\+two$/m)
    await store.history({ path: 'prompts/a.md' })
    await store.revert(c2.id, { author: USERA })
    assert.equal(await ran(), false, 'commit, history and revert ran nothing')
  } finally {
    if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL
    else process.env.GIT_CONFIG_GLOBAL = previous
  }
})

// --- commit ------------------------------------------------------------------------------------------

test('commit(id) gives a commit and its diff against its parent', async () => {
  const { store } = await openAt({ claims: [ns('prompts/')] })
  const c1 = await put(store, [file('prompts/a.md', 'one\n')])
  const c2 = await put(store, [file('prompts/a.md', 'one\ntwo\n'), file('prompts/b.md', 'B\n')], AGENTA, 'two things')

  const shown = await store.commit(c2.id)
  assert.deepEqual(shown.info, c2)
  assert.deepEqual(shown.diffs, await store.diff(c1.id, c2.id))
  assert.deepEqual(shown.diffs.map(d => d.status), ['modified', 'added'])
  assert.deepEqual((await store.commit('main')).info, c2, '"main" is accepted too')
  assert.deepEqual((await store.commit(c1.id)).diffs.map(d => `${d.status} ${d.path}`), ['added prompts/a.md'])
})

test('commit(id) of the first commit diffs against the empty tree', async () => {
  const { store, git } = await openAt()
  const root = (await git.run(['rev-list', '--max-parents=0', MAIN])).stdout.trim()
  const shown = await store.commit(root)
  assert.equal(shown.info.id, root)
  assert.deepEqual(shown.info.author, SYSTEM)
  assert.deepEqual(shown.info.paths, [])
  assert.deepEqual(shown.diffs, [])

  // A parentless commit with content, which the store itself never makes: all of it is added.
  const first = await orphan(git, 'first\n\nDish-Author-Kind: user\n', [file('prompts/a.md', 'A\n'), file('prompts/b.md', 'B\n')])
  const other = await store.commit(first)
  assert.deepEqual(other.info.author, { kind: 'user' })
  assert.deepEqual(other.info.paths, ['prompts/a.md', 'prompts/b.md'])
  assert.deepEqual(other.diffs.map(d => `${d.status} ${d.path}`), ['added prompts/a.md', 'added prompts/b.md'])
  assert.match(other.diffs[1]!.patch, /^\+B$/m)
  assert.deepEqual(await store.diff(await git.emptyTree(), first), other.diffs)
})

test('commit(id) needs "main" or a full id of a commit that exists: NOT_FOUND otherwise', async () => {
  const { store, git } = await openAt()
  const head = await store.head()
  const tree = (await git.run(['rev-parse', `${head}^{tree}`])).stdout.trim()
  for (const id of ['', 'HEAD', 'refs/heads/main', head.slice(0, 12), head.toUpperCase(), ZEROS, tree, '--help', `${head}^`]) {
    await assert.rejects(store.commit(id), isStoreError('NOT_FOUND'), `commit ${id}`)
  }
})

// --- revert ------------------------------------------------------------------------------------------

test('reverting a modification restores the previous text; reverting an addition deletes the file; reverting a deletion brings it back', async () => {
  const { store } = await openAt({ claims: [ns('prompts/')] })
  await put(store, [file('prompts/a.md', 'v1'), file('prompts/keep.md', 'K')])
  const modified = await put(store, [file('prompts/a.md', 'v2')])
  const added = await put(store, [file('prompts/new.md', 'N')])
  const deleted = await put(store, [{ path: 'prompts/keep.md', delete: true }])

  assert.ok(await store.revert(modified.id, { author: USERA }))
  assert.equal(await store.read('prompts/a.md'), 'v1')
  assert.ok(await store.revert(added.id, { author: USERA }))
  assert.equal(await store.read('prompts/new.md'), undefined)
  assert.deepEqual(await store.list('prompts/'), ['prompts/a.md'])
  assert.ok(await store.revert(deleted.id, { author: USERA }))
  assert.equal(await store.read('prompts/keep.md'), 'K')
})

test('a revert is one commit that undoes every path of the reverted commit, and its message says so', async () => {
  const { store, git } = await openAt({ claims: [ns('prompts/')] })
  await put(store, [file('prompts/a.md', 'a1'), file('prompts/d.md', 'd1')])
  const target = await put(store, [file('prompts/a.md', 'a2'), file('prompts/b.md', 'b'), { path: 'prompts/d.md', delete: true }])
  const result = await store.revert(target.id, { author: USERA, note: 'that was a mistake' })
  assert.ok(result)
  assert.deepEqual(result.paths, ['prompts/a.md', 'prompts/b.md', 'prompts/d.md'])
  assert.equal(result.message, `Revert ${target.id.slice(0, 7)}: prompts/a.md, prompts/b.md, prompts/d.md\n\n`
    + `Dish-Author-Kind: user\nDish-Note: that was a mistake\nDish-Revert: ${target.id}\n`)
  assert.equal(result.note, 'that was a mistake')
  assert.deepEqual(result.author, { kind: 'user' })
  assert.equal(await store.head(), result.id)
  assert.equal(await store.read('prompts/a.md'), 'a1')
  assert.equal(await store.read('prompts/b.md'), undefined)
  assert.equal(await store.read('prompts/d.md'), 'd1')
  assert.equal((await git.run(['rev-parse', `${result.id}^`])).stdout.trim(), target.id)
  assert.deepEqual((await store.history())[0], result)
  assert.equal((await git.run(['log', '-1', '--format=%an|%ae', result.id])).stdout.trim(), 'Test User|user@test')
  assert.equal((await store.history()).length, 4)
})

test('the revert subject starts with "Revert", gives the short id, and shortens a long list of paths', async () => {
  const { store } = await openAt({ claims: [ns('x/')] })
  const target = await put(store, ['a', 'b', 'c', 'd', 'e'].map(name => file(`x/${name}`, name)))
  const result = await store.revert(target.id, { author: USERA })
  assert.ok(result)
  assert.equal(result.message.split('\n')[0], `Revert ${target.id.slice(0, 7)}: x/a, x/b, x/c and 2 more`)
  assert.equal(result.note, undefined)
  assert.ok(!result.message.includes('Dish-Note'), 'no note, no note trailer')
  assert.match(result.message, /\nDish-Revert: [0-9a-f]{40}\n$/)
})

test('an agent revert is attributed to the agent, and needs agent write on every path of the commit', async () => {
  const { store, git } = await openAt({ claims: [ns('prompts/'), ns('policy/', 'propose', 'policy')] })
  const open = await put(store, [file('prompts/a.md', 'A')])
  const gated = await put(store, [file('policy/p.md', 'P')])
  const both = await put(store, [file('prompts/b.md', 'B'), file('policy/q.md', 'Q')])
  const head = await store.head()

  const done = await store.revert(open.id, { author: AGENTA, note: 'undo' })
  assert.ok(done)
  assert.deepEqual(done.author, { kind: 'agent', sessionId: 's1', role: 'coder' })
  assert.match(done.message, /Dish-Author-Kind: agent\nDish-Session: s1\nDish-Role: coder\nDish-Note: undo\nDish-Revert: [0-9a-f]{40}\n$/)
  assert.equal((await git.run(['log', '-1', '--format=%an', done.id])).stdout.trim(), 'Test Agent')

  const after = await store.head()
  await assert.rejects(store.revert(gated.id, { author: AGENTA }), isStoreError('FORBIDDEN', 'policy/p.md'))
  await assert.rejects(store.revert(both.id, { author: AGENTA }), isStoreError('FORBIDDEN', 'policy/'))
  assert.equal(await store.head(), after, 'nothing was written')
  assert.notEqual(head, after)
  assert.equal(await store.read('policy/p.md'), 'P')
  assert.ok(await store.revert(both.id, { author: USERA }), 'a user may')
  assert.equal(await store.read('policy/q.md'), undefined)
})

test('reverting a commit whose path has changed since is CONFLICT, and writes nothing', async () => {
  const { store, git } = await openAt({ claims: [ns('prompts/')] })
  await put(store, [file('prompts/a.md', 'v1')])
  const target = await put(store, [file('prompts/a.md', 'v2'), file('prompts/b.md', 'b2')])
  await put(store, [file('prompts/a.md', 'v3')])
  const head = await store.head()
  await assert.rejects(store.revert(target.id, { author: USERA }), isStoreError('CONFLICT', 'prompts/a.md'))
  assert.equal(await store.head(), head)
  assert.equal(await store.read('prompts/b.md'), 'b2', 'not even the path that could have been reverted')
  assert.equal((await git.run(['rev-list', '--count', MAIN])).stdout.trim(), '4')
})

test('a path changed since another commit does not block reverting this one', async () => {
  const { store } = await openAt({ claims: [ns('prompts/')] })
  await put(store, [file('prompts/a.md', 'v1')])
  const target = await put(store, [file('prompts/a.md', 'v2')])
  await put(store, [file('prompts/other.md', 'x')])
  assert.ok(await store.revert(target.id, { author: USERA }))
  assert.equal(await store.read('prompts/a.md'), 'v1')
  assert.equal(await store.read('prompts/other.md'), 'x')
})

test('reverting twice is a no-op the second time: undefined, no commit, no onCommit', async () => {
  const seen = recorder()
  const { store } = await openAt({ claims: [ns('prompts/')], onCommit: seen.onCommit })
  await put(store, [file('prompts/a.md', 'v1')])
  const target = await put(store, [file('prompts/a.md', 'v2'), file('prompts/b.md', 'b')])
  const first = await store.revert(target.id, { author: USERA })
  assert.ok(first)
  const head = await store.head()
  const count = seen.seen.length
  assert.equal(await store.revert(target.id, { author: USERA }), undefined)
  assert.equal(await store.revert(target.id, { author: AGENTA, note: 'again' }), undefined)
  assert.equal(await store.head(), head, 'main did not move')
  assert.equal(seen.seen.length, count, 'nobody was told')
  assert.equal(seen.seen.filter(info => info.message.startsWith('Revert ')).length, 1)
})

test('a revert that finds some paths already restored reverts the rest, and reverts only what is left', async () => {
  const { store } = await openAt({ claims: [ns('prompts/')] })
  await put(store, [file('prompts/a.md', 'a1'), file('prompts/b.md', 'b1')])
  const target = await put(store, [file('prompts/a.md', 'a2'), file('prompts/b.md', 'b2')])
  await put(store, [file('prompts/a.md', 'a1')]) // somebody put a.md back by hand
  const result = await store.revert(target.id, { author: USERA })
  assert.ok(result)
  assert.deepEqual(result.paths, ['prompts/b.md'])
  assert.equal(result.message.split('\n')[0], `Revert ${target.id.slice(0, 7)}: prompts/b.md`)
  assert.equal(await store.read('prompts/b.md'), 'b1')

  // And one that cannot: b.md changed since, a.md did too but is back where the revert wants it.
  const next = await put(store, [file('prompts/a.md', 'a3'), file('prompts/b.md', 'b3')])
  await put(store, [file('prompts/a.md', 'a1'), file('prompts/b.md', 'b4')])
  await assert.rejects(store.revert(next.id, { author: USERA }), isStoreError('CONFLICT', 'prompts/b.md'))
})

test('a revert can itself be reverted', async () => {
  const { store } = await openAt({ claims: [ns('prompts/')] })
  await put(store, [file('prompts/a.md', 'v1')])
  const target = await put(store, [file('prompts/a.md', 'v2')])
  const undo = await store.revert(target.id, { author: USERA })
  assert.ok(undo)
  assert.equal(await store.read('prompts/a.md'), 'v1')
  const redo = await store.revert(undo.id, { author: USERA })
  assert.ok(redo)
  assert.equal(await store.read('prompts/a.md'), 'v2')
  assert.equal(redo.message.split('\n')[0], `Revert ${undo.id.slice(0, 7)}: prompts/a.md`)
})

test('revert refuses the first commit with INVALID, and anything that is not a full id of a commit on main with NOT_FOUND', async () => {
  const { store, git } = await openAt({ claims: [ns('prompts/')] })
  const c1 = await put(store, [file('prompts/a.md', 'v1')])
  const root = (await git.run(['rev-list', '--max-parents=0', MAIN])).stdout.trim()
  const head = await store.head()
  await assert.rejects(store.revert(root, { author: USERA }), isStoreError('INVALID', 'nothing to revert'))

  const stray = await orphan(git, 'stray\n', [file('prompts/s.md', 's')])
  const tree = (await git.run(['rev-parse', `${c1.id}^{tree}`])).stdout.trim()
  const bad: unknown[] = ['main', 'refs/heads/main', 'HEAD', c1.id.slice(0, 12), c1.id.toUpperCase(), ZEROS, tree, stray, '', `${c1.id}^`, '--help', 5, undefined, null]
  for (const commit of bad) {
    await assert.rejects(store.revert(commit as string, { author: USERA }), isStoreError('NOT_FOUND'), `commit ${String(commit)}`)
  }
  assert.equal(await store.head(), head)
})

test('revert checks the author and the note first: INVALID, SECRET', async () => {
  const { store } = await openAt({ claims: [ns('prompts/')] })
  await put(store, [file('prompts/a.md', 'v1')])
  const target = await put(store, [file('prompts/a.md', 'v2')])
  const head = await store.head()
  for (const author of [{ kind: 'system' }, { kind: 'robot' }, undefined, null]) {
    await assert.rejects(store.revert(target.id, { author } as never), isStoreError('INVALID'), `author ${JSON.stringify(author)}`)
  }
  await assert.rejects(store.revert(target.id, undefined as never), isStoreError('INVALID'))
  await assert.rejects(store.revert(target.id, { author: USERA, note: `token ghp_${'a'.repeat(36)}` }), isStoreError('SECRET', 'note'))
  await assert.rejects(store.revert(target.id, { author: USERA, note: 'a\u0007b' }), isStoreError('INVALID', 'note'))
  assert.equal(await store.head(), head)
  // Checked before the commit is looked up, as write checks before it reads anything.
  await assert.rejects(store.revert(ZEROS, { author: { kind: 'robot' } as never }), isStoreError('INVALID'))
})

test('revert goes through the whole write pipeline: the namespace validator sees the restored text', async () => {
  const validate = (_path: string, text: string): string | undefined => text.includes('BAD') ? 'contains BAD' : undefined
  const { store, git } = await openAt({ claims: [ns('prompts/', 'write', 'test', validate)] })
  // The old text was written behind the store's back, so it never met the validator.
  await forge(git, 'a: b\n\nDish-Author-Kind: user\n', [file('prompts/a.md', 'BAD')])
  const target = await put(store, [file('prompts/a.md', 'fine')])
  const head = await store.head()
  await assert.rejects(store.revert(target.id, { author: USERA }), isStoreError('INVALID', 'contains BAD'))
  assert.equal(await store.head(), head)
})

test('a revert and a write to the same path queue up: whichever comes second sees the other', async () => {
  const { store } = await openAt({ claims: [ns('prompts/')] })
  await put(store, [file('prompts/a.md', 'v1')])
  const target = await put(store, [file('prompts/a.md', 'v2')])
  const results = await Promise.allSettled([
    store.write([file('prompts/a.md', 'v3')], { author: USERA }),
    store.revert(target.id, { author: USERA }),
  ])
  assert.equal(results[0].status, 'fulfilled')
  assert.equal(results[1].status, 'rejected')
  assert.equal((results[1] as PromiseRejectedResult).reason.code, 'CONFLICT')
  assert.equal(await store.read('prompts/a.md'), 'v3')
})

test('revert calls onCommit once for the commit it makes', async () => {
  const seen = recorder()
  const { store } = await openAt({ claims: [ns('prompts/')], onCommit: seen.onCommit })
  await put(store, [file('prompts/a.md', 'v1')])
  const target = await put(store, [file('prompts/a.md', 'v2')])
  seen.seen.length = 0
  const result = await store.revert(target.id, { author: AGENTA })
  assert.deepEqual(seen.seen, [result])
})

test('the git identity of a revert is the author kind\'s, as for write', async () => {
  const { store, git } = await openAt({ claims: [ns('prompts/')], user: USER, agent: AGENT })
  await put(store, [file('prompts/a.md', 'v1')])
  const target = await put(store, [file('prompts/a.md', 'v2')])
  const byUser = await store.revert(target.id, { author: USERA })
  assert.ok(byUser)
  assert.equal((await git.run(['log', '-1', '--format=%an|%cn', byUser.id])).stdout.trim(), 'Test User|Test User')
})
