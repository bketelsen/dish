import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { ConfigStoreError } from '../src/store/errors.ts'
import { Git } from '../src/store/git.ts'
import type { Change } from '../src/store/git.ts'
import { USER, tempDir } from './helpers.ts'

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const MAIN = 'refs/heads/main'

async function newGit(): Promise<{ git: Git, dir: string }> {
  const dir = join(await tempDir(), 'config.git')
  const git = new Git(dir)
  await git.initBare('main')
  return { git, dir }
}

/** Build a tree from `base` + `changes`, commit it, and move `main` forward. */
async function commit(git: Git, changes: Change[], message = 'm'): Promise<string> {
  const head = await git.resolve(MAIN)
  const tree = await git.buildTree(head, changes)
  const id = await git.commitTree(tree, head ? [head] : [], message, USER)
  assert.equal(await git.casRef(MAIN, id, head ?? null), true)
  return id
}

async function indexLeftovers(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter(name => name.startsWith('dish-index-'))
}

test('initBare creates a bare repo on main; the empty tree is canonical; main is unborn', async () => {
  const { git } = await newGit()
  assert.equal((await git.run(['rev-parse', '--is-bare-repository'])).stdout.trim(), 'true')
  assert.equal((await git.run(['symbolic-ref', 'HEAD'])).stdout.trim(), MAIN)
  assert.equal(await git.emptyTree(), EMPTY_TREE)
  assert.equal(await git.resolve(MAIN), undefined)
})

test('build, commit and compare-and-swap a first commit; read it back', async () => {
  const { git } = await newGit()
  const tree = await git.buildTree(undefined, [{ path: 'a/b.md', text: 'x' }])
  const c = await git.commitTree(tree, [], 'first', USER)
  assert.match(c, /^[0-9a-f]{40}$/)
  assert.equal(await git.casRef(MAIN, c, null), true)
  assert.equal(await git.resolve(MAIN), c)
  assert.equal(await git.readBlob(c, 'a/b.md'), 'x')
  const info = (await git.run(['log', '-1', '--format=%an <%ae>|%cn <%ce>|%s|%P', c])).stdout.trim()
  assert.equal(info, 'Test User <user@test>|Test User <user@test>|first|')
})

test('casRef refuses a wrong expected value, and null when the ref exists; main is unchanged', async () => {
  const { git } = await newGit()
  const c1 = await commit(git, [{ path: 'a.md', text: '1' }])
  const c2tree = await git.buildTree(c1, [{ path: 'a.md', text: '2' }])
  const c2 = await git.commitTree(c2tree, [c1], 'second', USER)
  assert.equal(await git.casRef(MAIN, c2, c2), false)       // wrong old
  assert.equal(await git.casRef(MAIN, c2, null), false)     // must not exist, but does
  assert.equal(await git.resolve(MAIN), c1)
  assert.equal(await git.casRef(MAIN, c2, c1), true)
  assert.equal(await git.resolve(MAIN), c2)
})

test('casRef throws when the update fails for a reason other than a lost race', async () => {
  const { git } = await newGit()
  const c = await commit(git, [{ path: 'a.md', text: '1' }])
  await assert.rejects(git.casRef('refs/heads/bad..name', c, null), /update-ref/)
})

test('buildTree with a delete removes the file', async () => {
  const { git } = await newGit()
  const c1 = await commit(git, [{ path: 'a/b.md', text: 'x' }, { path: 'a/c.md', text: 'y' }])
  const tree = await git.buildTree(c1, [{ path: 'a/b.md', delete: true }])
  const c2 = await git.commitTree(tree, [c1], 'rm', USER)
  assert.equal(await git.readBlob(c2, 'a/b.md'), undefined)
  assert.deepEqual(await git.listPaths(c2, ''), ['a/c.md'])
  assert.deepEqual(await git.listPaths(c1, ''), ['a/b.md', 'a/c.md'])
})

test('deleting a path that is not there is a no-op', async () => {
  const { git } = await newGit()
  const c1 = await commit(git, [{ path: 'a.md', text: 'x' }])
  const tree = await git.buildTree(c1, [{ path: 'nope.md', delete: true }])
  assert.equal(tree, (await git.run(['rev-parse', `${c1}^{tree}`])).stdout.trim())
})

test('buildTree from undefined starts empty; later changes to one path win', async () => {
  const { git } = await newGit()
  const tree = await git.buildTree(undefined, [{ path: 'a.md', text: '1' }, { path: 'a.md', text: '2' }])
  const c = await git.commitTree(tree, [], 'm', USER)
  assert.equal(await git.readBlob(c, 'a.md'), '2')
  assert.equal(await git.buildTree(undefined, []), EMPTY_TREE)
})

test('text round-trips byte for byte: empty, CRLF, non-ASCII, no trailing newline', async () => {
  const { git } = await newGit()
  const files = { 'e.md': '', 'crlf.md': 'a\r\nb\r\n', 'u.md': 'héllo → 世界 😀', 'n.md': 'no newline' }
  const c = await commit(git, Object.entries(files).map(([path, text]) => ({ path, text })))
  for (const [path, text] of Object.entries(files)) assert.equal(await git.readBlob(c, path), text, path)
})

test('readBlob returns undefined for a missing path or a directory', async () => {
  const { git } = await newGit()
  const c = await commit(git, [{ path: 'a/b.md', text: 'x' }])
  assert.equal(await git.readBlob(c, 'a/missing.md'), undefined)
  assert.equal(await git.readBlob(c, 'a'), undefined)
  assert.equal(await git.readBlob(c, 'a/'), undefined)
})

test('listPaths filters by prefix: a trailing slash is a subtree, otherwise an exact path', async () => {
  const { git } = await newGit()
  const c = await commit(git, [
    { path: 'prompts/a.md', text: '1' }, { path: 'prompts/sub/b.md', text: '2' },
    { path: 'promptsX.md', text: '3' }, { path: 'crew.yaml', text: '4' },
  ])
  assert.deepEqual(await git.listPaths(c, 'prompts/'), ['prompts/a.md', 'prompts/sub/b.md'])
  assert.deepEqual(await git.listPaths(c, 'crew.yaml'), ['crew.yaml'])
  assert.deepEqual(await git.listPaths(c, 'crew.yam'), [])
  assert.deepEqual(await git.listPaths(c, ''), ['crew.yaml', 'prompts/a.md', 'prompts/sub/b.md', 'promptsX.md'])
  assert.deepEqual(await git.listPaths(await git.emptyTree(), ''), [])
})

test('paths are literal: glob and pathspec magic match nothing', async () => {
  const { git } = await newGit()
  const c1 = await commit(git, [{ path: 'prompts/a.md', text: '1' }])
  const c2 = await commit(git, [{ path: 'prompts/a.md', text: '2' }])
  assert.deepEqual(await git.listPaths(c2, 'prompts/*'), [])
  assert.deepEqual(await git.changedPaths(c1, c2, ['prompts/*']), [])
  assert.deepEqual(await git.changedPaths(c1, c2, [':(exclude)prompts/a.md']), [])
  assert.deepEqual(await git.changedPaths(c1, c2, ['prompts/a.md']), ['prompts/a.md'])
})

test('changedPaths lists exactly what changed, optionally limited to paths', async () => {
  const { git } = await newGit()
  const c1 = await commit(git, [
    { path: 'a.md', text: '1' }, { path: 'dir/b.md', text: '1' }, { path: 'same.md', text: '1' },
  ])
  const c2 = await commit(git, [
    { path: 'a.md', text: '2' }, { path: 'dir/b.md', delete: true }, { path: 'dir/new.md', text: '1' },
  ])
  assert.deepEqual(await git.changedPaths(c1, c2), ['a.md', 'dir/b.md', 'dir/new.md'])
  assert.deepEqual(await git.changedPaths(c1, c2, ['other']), [])
  assert.deepEqual(await git.changedPaths(c1, c2, ['a.md', 'same.md']), ['a.md'])
  assert.deepEqual(await git.changedPaths(c1, c2, ['dir/']), ['dir/b.md', 'dir/new.md'])
  assert.deepEqual(await git.changedPaths(c1, c1), [])
  // A root commit diffs against the empty tree.
  assert.deepEqual(await git.changedPaths(await git.emptyTree(), c1), ['a.md', 'dir/b.md', 'same.md'])
})

test('unknown commits are NOT_FOUND', async () => {
  const { git } = await newGit()
  const c = await commit(git, [{ path: 'a.md', text: '1' }])
  const unknown = '0123456789abcdef0123456789abcdef01234567'
  await assert.rejects(git.readBlob(unknown, 'a.md'), { code: 'NOT_FOUND' })
  await assert.rejects(git.listPaths(unknown, ''), { code: 'NOT_FOUND' })
  await assert.rejects(git.changedPaths(unknown, c), { code: 'NOT_FOUND' })
  await assert.rejects(git.changedPaths(c, unknown), { code: 'NOT_FOUND' })
  await assert.rejects(git.buildTree(unknown, []), { code: 'NOT_FOUND' })
  await assert.rejects(git.commitTree(EMPTY_TREE, [unknown], 'm', USER))
  await assert.rejects(git.readBlob('--help', 'a.md'), { code: 'NOT_FOUND' })
  assert.equal(await git.resolve(unknown), undefined)
  assert.equal(await git.resolve('--help'), undefined)
  assert.equal(await git.resolve('refs/heads/nope'), undefined)
})

test('buildTree rejects unsafe paths with INVALID before touching the repo', async () => {
  const { git, dir } = await newGit()
  const before = (await readdir(dir, { recursive: true })).sort()
  const bad = [
    '', '/abs.md', 'a/../b.md', '..', '../x', './a.md', 'a/./b.md', '.', 'a\\b.md', 'a\0b.md',
    'dir/', 'a//b.md', '.git', '.git/config', '.git/hooks/pre-commit', 'a/.git/x', '.GIT/x',
  ]
  for (const path of bad) {
    await assert.rejects(git.buildTree(undefined, [{ path, text: 'x' }]), { code: 'INVALID' }, JSON.stringify(path))
    await assert.rejects(git.buildTree(undefined, [{ path, delete: true }]), { code: 'INVALID' }, JSON.stringify(path))
  }
  // One bad path anywhere in the batch rejects the whole batch.
  await assert.rejects(
    git.buildTree(undefined, [{ path: 'ok.md', text: '1' }, { path: '../no', text: '2' }]), { code: 'INVALID' })
  assert.deepEqual((await readdir(dir, { recursive: true })).sort(), before)
  // Ordinary dotfiles and odd-but-legal names are fine.
  const ok = ['.gitignore', '.github/x.yml', 'a b.md', '..a', 'a..b', 'a.git', 'x/.gitkeep', 'ü.md', 'a,b.md']
  const tree = await git.buildTree(undefined, ok.map(path => ({ path, text: 'x' })))
  const c = await git.commitTree(tree, [], 'm', USER)
  assert.deepEqual(await git.listPaths(c, ''), [...ok].sort((x, y) => Buffer.compare(Buffer.from(x), Buffer.from(y))))
})

test('a file/directory clash is INVALID, not a silent overwrite', async () => {
  const { git } = await newGit()
  const c = await commit(git, [{ path: 'a', text: 'file' }])
  await assert.rejects(git.buildTree(c, [{ path: 'a/b', text: 'x' }]), { code: 'INVALID' })
  await assert.rejects(git.buildTree(undefined, [{ path: 'a', text: '1' }, { path: 'a/b', text: '2' }]), { code: 'INVALID' })
  assert.equal(await git.readBlob(c, 'a'), 'file')
})

test('no dish-index-* files remain: after success, after INVALID and after NOT_FOUND', async () => {
  const { git, dir } = await newGit()
  const c = await commit(git, [{ path: 'a/b.md', text: 'x' }])
  await git.buildTree(c, [{ path: 'a/b.md', delete: true }])
  await assert.rejects(git.buildTree(c, [{ path: '../x', text: '1' }]), { code: 'INVALID' })
  await assert.rejects(git.buildTree(c, [{ path: 'a/b.md/c', text: '1' }]), { code: 'INVALID' })
  await assert.rejects(git.buildTree('0123456789abcdef0123456789abcdef01234567', []), { code: 'NOT_FOUND' })
  await Promise.all(Array.from({ length: 5 }, (_, n) => git.buildTree(c, [{ path: `n${n}.md`, text: String(n) }])))
  assert.deepEqual(await indexLeftovers(dir), [])
})

test('concurrent buildTree calls get separate indexes', async () => {
  const { git } = await newGit()
  const trees = await Promise.all(['1', '2', '3', '4'].map(n => git.buildTree(undefined, [{ path: `f${n}`, text: n }])))
  assert.equal(new Set(trees).size, 4)
  for (const [i, tree] of trees.entries()) {
    assert.deepEqual(await git.listPaths(tree, ''), [`f${i + 1}`])
  }
})

test('commitTree never signs, even when the user config says commit.gpgsign=true', async () => {
  const { git, dir } = await newGit()
  await git.run(['config', 'commit.gpgsign', 'true'])
  // Any attempt to sign would run this and fail.
  await git.run(['config', 'gpg.program', '/nonexistent/gpg'])
  // git 2.47's commit-tree ignores commit.gpgsign, so also watch the command line it was given:
  // newer gits may honor the config, and only the flag protects us then.
  const trace = join(await tempDir(), 'trace')
  process.env.GIT_TRACE = trace
  let c: string
  try {
    c = await commit(git, [{ path: 'a.md', text: '1' }])
  } finally {
    delete process.env.GIT_TRACE
  }
  assert.match(await readFile(trace, 'utf8'), /commit-tree --no-gpg-sign /)
  assert.equal(await git.resolve(MAIN), c)
  assert.doesNotMatch((await git.run(['cat-file', 'commit', c])).stdout, /gpgsig/)
  assert.deepEqual(await indexLeftovers(dir), [])
})

test('commitTree takes parents, a multi-line message verbatim, and per-call identity', async () => {
  const { git } = await newGit()
  const c1 = await commit(git, [{ path: 'a.md', text: '1' }])
  const tree = await git.buildTree(c1, [{ path: 'a.md', text: '2' }])
  const message = 'Subject line\n\nBody with "quotes" and $(subshell) and ; semicolons\n\nDish-Author: agent\n'
  const c2 = await git.commitTree(tree, [c1], message, { name: 'Agent Smith', email: 'agent@test' })
  assert.equal((await git.run(['log', '-1', '--format=%P', c2])).stdout.trim(), c1)
  assert.equal((await git.run(['log', '-1', '--format=%an <%ae>', c2])).stdout.trim(), 'Agent Smith <agent@test>')
  assert.equal((await git.run(['log', '-1', '--format=%B', c2])).stdout, message + '\n')
  // The test process's own environment must not leak identity in.
  assert.equal((await git.run(['log', '-1', '--format=%cn', c2])).stdout.trim(), 'Agent Smith')
})

test('run: LC_ALL=C and GIT_TERMINAL_PROMPT=0 are always set; per-call env is merged and wins', async () => {
  const { git } = await newGit()
  const env = (await git.run(['-c', 'alias.dump=!env', 'dump'], { env: { DISH_PROBE: 'yes' } })).stdout
  assert.match(env, /^LC_ALL=C$/m)
  assert.match(env, /^GIT_TERMINAL_PROMPT=0$/m)
  assert.match(env, /^DISH_PROBE=yes$/m)
  assert.match(env, /^PATH=/m)
  const over = (await git.run(['-c', 'alias.dump=!env', 'dump'], { env: { LC_ALL: 'POSIX' } })).stdout
  assert.match(over, /^LC_ALL=POSIX$/m)
})

test('run: always passes --git-dir first, and never goes through a shell', async () => {
  const { git, dir } = await newGit()
  const { stdout } = await git.run(['rev-parse', '--git-dir'])
  assert.equal(stdout.trim(), dir)
  // Shell metacharacters in an argument are just an argument.
  const r = await git.run(['rev-parse', '--verify', '--quiet', '$(touch pwned); echo hi'], { allowFail: true })
  assert.notEqual(r.code, 0)
})

test('run: input goes to stdin; a failure throws unless allowFail', async () => {
  const { git } = await newGit()
  const sha = (await git.run(['hash-object', '--stdin'], { input: 'hello\n' })).stdout.trim()
  assert.equal(sha, 'ce013625030ba8dba906f756967f9e9ca394464a')
  await assert.rejects(git.run(['cat-file', '-e', '0123456789abcdef0123456789abcdef01234567']), /cat-file/)
  const r = await git.run(['cat-file', '-e', '0123456789abcdef0123456789abcdef01234567'], { allowFail: true })
  assert.notEqual(r.code, 0)
  assert.equal(typeof r.stderr, 'string')
})

test('ConfigStoreError carries a code and is an Error', () => {
  const e = new ConfigStoreError('CONFLICT', 'a.md changed')
  assert.ok(e instanceof Error)
  assert.equal(e.code, 'CONFLICT')
  assert.equal(e.name, 'ConfigStoreError')
  assert.equal(e.message, 'a.md changed')
  assert.equal(new ConfigStoreError('STALE').message, 'STALE')
})
