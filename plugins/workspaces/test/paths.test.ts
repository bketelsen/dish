import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lstat, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  clonePath, cloneStateFile, helperValue, projectStateDir, scratchRecordFile, setupLogFile, tokensDir, worktreePath,
  worktreeRecordFile, worktreeSetupLogFile, writeFileAtomic,
} from '../src/paths.ts'
import { tempDir } from './helpers.ts'

const STATE = '/s/dish'

test('the state files of a project', () => {
  assert.equal(projectStateDir(STATE, 'Acme', 'widget'), '/s/dish/workspaces/Acme/widget')
  assert.equal(cloneStateFile(STATE, 'Acme', 'widget'), '/s/dish/workspaces/Acme/widget/clone.json')
  assert.equal(setupLogFile(STATE, 'Acme', 'widget'), '/s/dish/workspaces/Acme/widget/setup.log')
  assert.equal(worktreeRecordFile(STATE, 'Acme', 'widget', 'fix-1'), '/s/dish/workspaces/Acme/widget/worktrees/fix-1.json')
  assert.equal(worktreeSetupLogFile(STATE, 'Acme', 'widget', 'fix-1'), '/s/dish/workspaces/Acme/widget/worktrees/fix-1.setup.log')
})

test('the tokens directory and the scratch record', () => {
  assert.equal(tokensDir(STATE), '/s/dish/workspaces/tokens')
  assert.equal(scratchRecordFile(STATE), '/s/dish/workspaces/scratch')
})

test('a clone and a worktree', () => {
  assert.equal(clonePath('/home/dish/work', 'Acme', 'widget.js'), '/home/dish/work/Acme/widget.js')
  assert.equal(worktreePath('/home/dish/work/Acme/widget', 'fix-1'), '/home/dish/work/Acme/widget/.worktrees/fix-1')
})

test('a name that is not one path segment is refused, never joined', () => {
  for (const bad of ['', '.', '..', 'a/b', '../x', 'a\\b', 'a\0b', 'a\nb']) {
    assert.throws(() => clonePath('/w', bad, 'r'), /owner/, JSON.stringify(bad))
    assert.throws(() => clonePath('/w', 'o', bad), /repo/, JSON.stringify(bad))
    assert.throws(() => projectStateDir(STATE, bad, 'r'), /owner/, JSON.stringify(bad))
    assert.throws(() => worktreeRecordFile(STATE, 'o', 'r', bad), /slug/, JSON.stringify(bad))
    assert.throws(() => worktreePath('/w/o/r', bad), /slug/, JSON.stringify(bad))
  }
})

test("helperValue quotes each part for git's shell", () => {
  assert.equal(
    helperValue('/opt/dish/plugins/workspaces/bin/git-credential-dish', '/s/dish/workspaces/tokens', 'https://github.com'),
    "!/bin/sh '/opt/dish/plugins/workspaces/bin/git-credential-dish' '/s/dish/workspaces/tokens' 'https://github.com'",
  )
  assert.equal(helperValue('/a b/$HOME/`x`', '/t;rm', 'http://127.0.0.1:4242'), "!/bin/sh '/a b/$HOME/`x`' '/t;rm' 'http://127.0.0.1:4242'")
})

test("helperValue refuses a ', a newline or another control character in any part, and a relative path", () => {
  assert.throws(() => helperValue("/it's/helper", '/t', 'https://github.com'), /'/)
  assert.throws(() => helperValue('/h', "/t'", 'https://github.com'), /'/)
  assert.throws(() => helperValue('/h', '/t', "https://github.com'"), /'/)
  assert.throws(() => helperValue('/h\n', '/t', 'https://github.com'), /control/)
  assert.throws(() => helperValue('/h', '/t\r', 'https://github.com'), /control/)
  assert.throws(() => helperValue('/h', '/t', 'https://github.com\0'), /control/)
  assert.throws(() => helperValue('bin/helper', '/t', 'https://github.com'), /absolute/)
  assert.throws(() => helperValue('/h', 'tokens', 'https://github.com'), /absolute/)
})

test('writeFileAtomic writes the whole text, 0600 by default, in a directory it makes 0700', async () => {
  const root = await tempDir()
  const file = join(root, 'a', 'b', 'token')
  await writeFileAtomic(file, 'ghs-like-but-not\n')
  assert.equal(await readFile(file, 'utf8'), 'ghs-like-but-not\n')
  assert.equal((await stat(file)).mode & 0o777, 0o600)
  assert.equal((await stat(join(root, 'a', 'b'))).mode & 0o777, 0o700)
  assert.equal((await stat(join(root, 'a'))).mode & 0o777, 0o700)
  assert.deepEqual(await readdir(join(root, 'a', 'b')), ['token'], 'no temporary file left')
})

test('writeFileAtomic replaces a file whole, with the mode asked for, and leaves no temporary file', async () => {
  const root = await tempDir()
  const file = join(root, 'clone.json')
  await writeFile(file, 'old', { mode: 0o666 })
  await writeFileAtomic(file, '{"new":true}\n', 0o644)
  assert.equal(await readFile(file, 'utf8'), '{"new":true}\n')
  assert.equal((await stat(file)).mode & 0o777, 0o644)
  assert.deepEqual(await readdir(root), ['clone.json'])
})

test('writeFileAtomic replaces a symbolic link at the path, and writes nothing through it', async () => {
  const root = await tempDir()
  const target = join(root, 'elsewhere')
  await writeFile(target, 'untouched')
  const file = join(root, 'record')
  await symlink(target, file)
  await writeFileAtomic(file, 'mine')
  assert.equal(await readFile(target, 'utf8'), 'untouched')
  assert.equal((await lstat(file)).isFile(), true)
  assert.equal(await readFile(file, 'utf8'), 'mine')
})
