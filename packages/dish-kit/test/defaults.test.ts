import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { computePrevious, defaultFiles, parsePrevious, readPrevious } from '../src/defaults.ts'
import * as kit from '../src/index.ts'

const run = promisify(execFile)
const SCRIPT = new URL('../scripts/previous-defaults.mjs', import.meta.url).pathname

const roots: string[] = []
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }) })

// A developer's own git config (core.autocrlf, signing, hooks, attributes) must not change what these tests see, so the
// test process, and every git it starts, runs with neither the global nor the system config. Settings passed in the
// environment as GIT_CONFIG_COUNT/KEY/VALUE survive that, which is why the helper below also pins the ones that matter.
const ISOLATE = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
const saved = new Map<string, string | undefined>()
before(() => {
  for (const [name, value] of Object.entries(ISOLATE)) {
    saved.set(name, process.env[name])
    process.env[name] = value
  }
})
after(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

/** A fresh scratch directory. It is resolved, so paths compared against git's own agree. */
function scratch(): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'dish-kit-defaults-')))
  roots.push(root)
  return root
}

/**
 * Run git in `cwd` with a throwaway identity, no signing or hooks, and no line-ending or attribute conversion.
 * Nothing here writes git config.
 */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', [
    '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', '-c', 'core.attributesFile=/dev/null',
    '-C', cwd, ...args,
  ], { encoding: 'utf8' })
}

function repo(): string {
  const root = scratch()
  git(root, 'init', '-q')
  return root
}

function put(root: string, file: string, text: string): void {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
  writeFileSync(path.join(root, file), text)
}

function commit(root: string, message: string): void {
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', message)
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

describe('defaultFiles', () => {
  test('maps every file under the directory to <prefix><relative path>, sorted', async () => {
    const root = scratch()
    put(root, 'b.md', 'b')
    put(root, 'a.md', 'a')
    put(root, 'sub/c.md', 'c')
    put(root, 'sub/deeper/d.md', 'd')
    assert.deepEqual(await defaultFiles(root, 'skills/'), [
      { file: path.join(root, 'a.md'), path: 'skills/a.md' },
      { file: path.join(root, 'b.md'), path: 'skills/b.md' },
      { file: path.join(root, 'sub/c.md'), path: 'skills/sub/c.md' },
      { file: path.join(root, 'sub/deeper/d.md'), path: 'skills/sub/deeper/d.md' },
    ])
  })

  test('skips previous.json and anything in exclude, by name or by relative path', async () => {
    const root = scratch()
    put(root, 'a.md', 'a')
    put(root, 'previous.json', '{}')
    put(root, 'NOTICE.md', 'notice')
    put(root, 'sub/NOTICE.md', 'nested notice')
    put(root, 'sub/keep.md', 'keep')
    put(root, 'sub/other.md', 'other')
    const paths = async (exclude?: readonly string[]) => (await defaultFiles(root, 'p/', exclude)).map(entry => entry.path)
    assert.deepEqual(await paths(), ['p/NOTICE.md', 'p/a.md', 'p/sub/NOTICE.md', 'p/sub/keep.md', 'p/sub/other.md'])
    assert.deepEqual(await paths(['NOTICE.md']), ['p/a.md', 'p/sub/keep.md', 'p/sub/other.md'])
    assert.deepEqual(await paths(['sub/other.md']), ['p/NOTICE.md', 'p/a.md', 'p/sub/NOTICE.md', 'p/sub/keep.md'])
  })

  test('an empty prefix gives bare relative paths, and a missing directory throws', async () => {
    const root = scratch()
    put(root, 'sub/a.md', 'a')
    assert.deepEqual((await defaultFiles(root, '')).map(entry => entry.path), ['sub/a.md'])
    await assert.rejects(defaultFiles(path.join(root, 'missing'), 'p/'), { code: 'ENOENT' })
  })
})

describe('computePrevious', () => {
  test('hashes the earlier versions of each file, in a defaults directory inside the repo', async () => {
    const root = repo()
    put(root, 'plugin/defaults/a.md', 'a, first\n')
    put(root, 'plugin/defaults/sub/b.md', 'b\n')
    commit(root, 'first')
    put(root, 'plugin/defaults/a.md', 'a, second\n')
    commit(root, 'second')
    assert.deepEqual(await computePrevious(path.join(root, 'plugin/defaults'), 'prompts/'), {
      'prompts/a.md': [sha256('a, first\n')],
    })
  })

  test('a file with a single committed version, or none, is left out', async () => {
    const root = repo()
    put(root, 'd/once.md', 'once')
    commit(root, 'first')
    put(root, 'd/untracked.md', 'never committed')
    assert.deepEqual(await computePrevious(path.join(root, 'd'), 'p/'), {})
  })

  test('a file reverted to an older text excludes that text, which is current', async () => {
    const root = repo()
    put(root, 'd/a.md', 'v1')
    commit(root, 'v1')
    put(root, 'd/a.md', 'v2')
    commit(root, 'v2')
    put(root, 'd/a.md', 'v1')
    commit(root, 'back to v1')
    assert.deepEqual(await computePrevious(path.join(root, 'd'), 'p/'), { 'p/a.md': [sha256('v2')] })
  })

  test('hashes are sorted and deduplicated, and keys are sorted', async () => {
    const root = repo()
    const versions = ['v1', 'v2', 'v1', 'v3', 'v4']
    for (const text of versions) {
      put(root, 'd/z.md', text)
      put(root, 'd/a.md', text)
      commit(root, text)
    }
    const expected = ['v1', 'v2', 'v3'].map(sha256).sort()
    const previous = await computePrevious(path.join(root, 'd'), 'p/')
    assert.deepEqual(Object.keys(previous), ['p/a.md', 'p/z.md'])
    assert.deepEqual(previous['p/a.md'], expected)
    assert.deepEqual(previous['p/z.md'], expected)
  })

  test('a commit where the file is absent is skipped', async () => {
    const root = repo()
    put(root, 'd/a.md', 'v1')
    commit(root, 'v1')
    git(root, 'rm', '-q', 'd/a.md')
    git(root, 'commit', '-q', '-m', 'delete')
    put(root, 'd/a.md', 'v2')
    commit(root, 'again')
    assert.deepEqual(await computePrevious(path.join(root, 'd'), 'p/'), { 'p/a.md': [sha256('v1')] })
  })

  test('an uncommitted edit makes the committed text previous', async () => {
    const root = repo()
    put(root, 'd/a.md', 'committed')
    commit(root, 'v1')
    put(root, 'd/a.md', 'edited, not committed')
    assert.deepEqual(await computePrevious(path.join(root, 'd'), 'p/'), { 'p/a.md': [sha256('committed')] })
  })

  test('previous.json and excluded names are skipped even with a history of their own', async () => {
    const root = repo()
    for (const text of ['one', 'two']) {
      put(root, 'd/a.md', text)
      put(root, 'd/previous.json', `{ "x": "${text}" }`)
      put(root, 'd/NOTICE.md', text)
      commit(root, text)
    }
    assert.deepEqual(await computePrevious(path.join(root, 'd'), 'p/', ['NOTICE.md']), { 'p/a.md': [sha256('one')] })
    assert.deepEqual(Object.keys(await computePrevious(path.join(root, 'd'), 'p/')), ['p/NOTICE.md', 'p/a.md'])
  })

  test('hashes the exact bytes, whatever the encoding or line endings', async () => {
    const root = repo()
    put(root, 'd/a.md', 'café — line\r\nnext\r\n')
    commit(root, 'v1')
    put(root, 'd/a.md', 'plain')
    commit(root, 'v2')
    assert.deepEqual(await computePrevious(path.join(root, 'd'), 'p/'), { 'p/a.md': [sha256('café — line\r\nnext\r\n')] })
  })

  test('a name with glob characters is matched literally', async () => {
    const root = repo()
    put(root, 'd/a*.md', 'star v1')
    put(root, 'd/ab.md', 'ab v1')
    commit(root, 'v1')
    put(root, 'd/a*.md', 'star v2')
    put(root, 'd/ab.md', 'ab v2')
    commit(root, 'v2')
    assert.deepEqual(await computePrevious(path.join(root, 'd'), 'p/'), {
      'p/a*.md': [sha256('star v1')],
      'p/ab.md': [sha256('ab v1')],
    })
  })

  test('a repository with no commits yet has no earlier versions', async () => {
    const root = repo()
    put(root, 'd/a.md', 'a')
    assert.deepEqual(await computePrevious(path.join(root, 'd'), 'p/'), {})
  })

  test('outside a git repository the history is unavailable', async () => {
    const outside = scratch()
    put(outside, 'd/a.md', 'a')
    const before = process.env.GIT_CEILING_DIRECTORIES
    // Whatever repository the temp directory might sit inside, git must not look for it above here.
    process.env.GIT_CEILING_DIRECTORIES = outside
    try {
      await assert.rejects(computePrevious(path.join(outside, 'd'), 'p/'), (error: Error & { code?: string }) =>
        error.code === 'NO_HISTORY' && /not a git repository/i.test(error.message))
    } finally {
      if (before === undefined) delete process.env.GIT_CEILING_DIRECTORIES
      else process.env.GIT_CEILING_DIRECTORIES = before
    }
  })

  test('when git cannot be run the history is unavailable, and the message says why', async () => {
    const root = repo()
    put(root, 'd/a.md', 'a')
    commit(root, 'v1')
    const before = process.env.PATH
    process.env.PATH = path.join(root, 'no-such-bin')
    try {
      await assert.rejects(computePrevious(path.join(root, 'd'), 'p/'), (error: Error & { code?: string }) =>
        error.code === 'NO_HISTORY' && /ENOENT/.test(error.message))
    } finally {
      process.env.PATH = before
    }
  })

  test('a shallow clone has no usable history', async () => {
    const origin = repo()
    put(origin, 'd/a.md', 'v1')
    commit(origin, 'v1')
    put(origin, 'd/a.md', 'v2')
    commit(origin, 'v2')
    const clone = path.join(scratch(), 'clone')
    git(path.dirname(clone), 'clone', '-q', '--depth', '1', `file://${origin}`, clone)
    await assert.rejects(computePrevious(path.join(clone, 'd'), 'p/'), { code: 'NO_HISTORY' })
  })

  test('it is exported from the package index', () => {
    assert.equal(kit.computePrevious, computePrevious)
    assert.equal(kit.defaultFiles, defaultFiles)
    assert.equal(kit.readPrevious, readPrevious)
  })
})

describe('readPrevious', () => {
  const HASH = 'a'.repeat(64)
  const OTHER = '0123456789abcdef'.repeat(4)

  test('a directory without previous.json reads as empty', async () => {
    assert.deepEqual(await readPrevious(scratch()), {})
  })

  test('a valid file reads back as written', async () => {
    const root = scratch()
    const value = { 'p/a.md': [HASH, OTHER], 'p/b.md': [] }
    await writeFile(path.join(root, 'previous.json'), JSON.stringify(value))
    assert.deepEqual(await readPrevious(root), value)
  })

  const bad: [string, string][] = [
    ['not JSON', '{'],
    ['an array', '[]'],
    ['null', 'null'],
    ['a string', '"text"'],
    ['a value that is not an array', JSON.stringify({ 'p/a.md': HASH })],
    ['an array holding a non-string', JSON.stringify({ 'p/a.md': [1] })],
    ['a hash that is too short', JSON.stringify({ 'p/a.md': ['abc123'] })],
    ['a hash that is too long', JSON.stringify({ 'p/a.md': [HASH + '0'] })],
    ['an upper-case hash', JSON.stringify({ 'p/a.md': [HASH.toUpperCase()] })],
    ['a hash with a non-hex character', JSON.stringify({ 'p/a.md': ['g'.repeat(64)] })],
  ]
  for (const [name, text] of bad) {
    test(`a bad shape throws: ${name}`, async () => {
      const root = scratch()
      await writeFile(path.join(root, 'previous.json'), text)
      await assert.rejects(readPrevious(root), (error: Error) => error.message.includes('previous.json'))
    })
  }

  test('a key called __proto__ stays a plain entry', async () => {
    const root = scratch()
    await writeFile(path.join(root, 'previous.json'), `{ "__proto__": ["${HASH}"] }`)
    const read = await readPrevious(root)
    assert.equal(Object.getPrototypeOf(read), Object.prototype)
    assert.deepEqual(Object.keys(read), ['__proto__'])
  })
})

describe('parsePrevious', () => {
  const HASH = 'b'.repeat(64)

  test('parses a valid document synchronously', () => {
    assert.deepEqual(parsePrevious(JSON.stringify({ 'p/a.md': [HASH], 'p/b.md': [] }), '/x/previous.json'), { 'p/a.md': [HASH], 'p/b.md': [] })
    assert.deepEqual(parsePrevious('{}\n', '/x/previous.json'), {})
  })

  test('a bad document throws an error that names the file', () => {
    for (const text of ['', '{', '[]', 'null', '{"p/a.md":"x"}', '{"p/a.md":["ABC"]}', `{"p/a.md":["${HASH.toUpperCase()}"]}`]) {
      assert.throws(() => parsePrevious(text, '/x/previous.json'), (error: Error) => error.message.includes('/x/previous.json'), text)
    }
  })

  test('the result is a plain object, even for a __proto__ key', () => {
    const parsed = parsePrevious(`{ "__proto__": ["${HASH}"] }`, 'previous.json')
    assert.equal(Object.getPrototypeOf(parsed), Object.prototype)
    assert.deepEqual(Object.keys(parsed), ['__proto__'])
  })

  test('readPrevious gives what parsePrevious gives for the same text', async () => {
    const root = scratch()
    const text = JSON.stringify({ 'p/a.md': [HASH] })
    await writeFile(path.join(root, 'previous.json'), text)
    assert.deepEqual(await readPrevious(root), parsePrevious(text, path.join(root, 'previous.json')))
  })

  test('it is exported from the package index', () => {
    assert.equal(kit.parsePrevious, parsePrevious)
  })
})

describe('scripts/previous-defaults.mjs', () => {
  test('writes previous.json: sorted keys, two-space JSON, trailing newline', async () => {
    const root = repo()
    for (const text of ['one', 'two', 'three']) {
      put(root, 'plugin/defaults/z.md', text)
      put(root, 'plugin/defaults/sub/a.md', text)
      put(root, 'plugin/defaults/NOTICE.md', text)
      put(root, 'plugin/defaults/steady.md', 'steady')
      commit(root, text)
    }
    const directory = path.join(root, 'plugin/defaults')
    await run(process.execPath, [SCRIPT, directory, 'skills/', '--exclude', 'NOTICE.md'])
    const expected = ['one', 'two'].map(sha256).sort()
    assert.equal(
      await readFile(path.join(directory, 'previous.json'), 'utf8'),
      `${JSON.stringify({ 'skills/sub/a.md': expected, 'skills/z.md': expected }, null, 2)}\n`)
    // The file it wrote is the one `readPrevious` reads, and it matches a fresh computation.
    assert.deepEqual(await readPrevious(directory), await computePrevious(directory, 'skills/', ['NOTICE.md']))
  })

  test('writes {} when nothing has an earlier version', async () => {
    const root = repo()
    put(root, 'd/a.md', 'a')
    commit(root, 'only')
    await run(process.execPath, [SCRIPT, path.join(root, 'd'), 'p/'])
    assert.equal(await readFile(path.join(root, 'd/previous.json'), 'utf8'), '{}\n')
  })

  test('is also reachable as dish-kit/previous-defaults', () => {
    assert.equal(import.meta.resolve('dish-kit/previous-defaults'), new URL('../scripts/previous-defaults.mjs', import.meta.url).href)
  })

  test('fails with a message and writes nothing on bad usage or no history', async () => {
    const outside = scratch()
    put(outside, 'd/a.md', 'a')
    const env = { ...process.env, GIT_CEILING_DIRECTORIES: outside }
    await assert.rejects(run(process.execPath, [SCRIPT], { env }), (error: { code?: number, stderr?: string }) =>
      error.code === 2 && /usage/i.test(error.stderr ?? ''))
    await assert.rejects(run(process.execPath, [SCRIPT, path.join(outside, 'd'), 'p/', '--exclude'], { env }), { code: 2 })
    await assert.rejects(run(process.execPath, [SCRIPT, path.join(outside, 'd'), 'p/'], { env }), (error: { code?: number, stderr?: string }) =>
      error.code === 1 && /NO_HISTORY|history/i.test(error.stderr ?? ''))
    await assert.rejects(readFile(path.join(outside, 'd/previous.json')), { code: 'ENOENT' })
  })
})
