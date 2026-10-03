import assert from 'node:assert/strict'
import { lstat, mkdir, readFile, readlink, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { checkLogFile, gateLogFile, LOG_KEEP_MS, pruneLogs, writeLog } from '../src/logs.ts'
import { tempDir } from './helpers.ts'

const CHILD = '0b6e9a52-3f0c-4c8e-9d1e-7a4f2b1c9e00'

test('the log path: <state>/gates/<owner>/<repo>/<slug>/<child>-<turn>-<round>.log', () => {
  assert.equal(gateLogFile('/s/dish', 'acme/widget', 'fix-1', CHILD, 2, 3), `/s/dish/gates/acme/widget/fix-1/${CHILD}-2-3.log`)
  assert.equal(gateLogFile('/s', 'Acme.Corp/my_repo-2', 'a', 'c', 0, 1), '/s/gates/Acme.Corp/my_repo-2/a/c-0-1.log')
})

test('the child id is cut to [A-Za-z0-9_-], 64 characters at most', () => {
  assert.equal(gateLogFile('/s', 'acme/widget', 'fix-1', 'a.b/c:d e_f-g', 1, 1), '/s/gates/acme/widget/fix-1/abcde_f-g-1-1.log')
  assert.equal(gateLogFile('/s', 'acme/widget', 'fix-1', 'x'.repeat(100), 1, 1), `/s/gates/acme/widget/fix-1/${'x'.repeat(64)}-1-1.log`)
  assert.throws(() => gateLogFile('/s', 'acme/widget', 'fix-1', '../..', 1, 1), TypeError)
})

test('a part that isn\'t one segment of [A-Za-z0-9._-], or is . or .., is refused', () => {
  const refused: Array<[string, string]> = [
    ['../widget', 'fix-1'],
    ['acme/..', 'fix-1'],
    ['acme/.', 'fix-1'],
    ['acme/wid/get', 'fix-1'],
    ['acme', 'fix-1'],
    ['/widget', 'fix-1'],
    ['acme/', 'fix-1'],
    ['ac me/widget', 'fix-1'],
    ['acme/widget', 'a/b'],
    ['acme/widget', '..'],
    ['acme/widget', '.'],
    ['acme/widget', 'fix 1'],
    ['acme/widget', ''],
    ['acme/widget', 'fix-1\n'],
  ]
  for (const [project, slug] of refused) {
    assert.throws(() => gateLogFile('/s', project, slug, CHILD, 1, 1), TypeError, `${project} ${slug}`)
  }
})

test('checkLogFile: <state>/gates/acme/widget/fix-1/open_pr.log, and gateLogFile\'s refusals (.., a slash in the owner, a slug outside the segment rule)', async () => {
  assert.equal(checkLogFile('/s/dish', 'acme/widget', 'fix-1'), '/s/dish/gates/acme/widget/fix-1/open_pr.log')
  assert.equal(checkLogFile('/s', 'Acme.Corp/my_repo-2', 'a'), '/s/gates/Acme.Corp/my_repo-2/a/open_pr.log')
  const refused: Array<[string, string]> = [
    ['../widget', 'fix-1'],
    ['acme/..', 'fix-1'],
    ['ac/me/widget', 'fix-1'],
    ['acme', 'fix-1'],
    ['acme/widget', '..'],
    ['acme/widget', 'a/b'],
    ['acme/widget', 'fix 1'],
    ['acme/widget', ''],
  ]
  for (const [project, slug] of refused) {
    assert.throws(() => checkLogFile('/s', project, slug), TypeError, `${project} ${slug}`)
  }
  // writeLog gives a second check of the same worktree the next name.
  const state = await tempDir()
  const file = checkLogFile(state, 'acme/widget', 'fix-1')
  assert.equal(await writeLog(file, 'one\n'), file)
  assert.equal(await writeLog(file, 'two\n'), join(state, 'gates', 'acme', 'widget', 'fix-1', 'open_pr.2.log'))
})

test('the turn and the round are whole numbers: a turn from 0, a round from 1', () => {
  for (const [turn, round] of [[-1, 1], [1.5, 1], [Number.NaN, 1], [1, 0], [1, 2.5], [1, Number.POSITIVE_INFINITY]] as const) {
    assert.throws(() => gateLogFile('/s', 'acme/widget', 'fix-1', CHILD, turn, round), TypeError, `${turn} ${round}`)
  }
})

test('writeLog makes the directories 0700 and the file 0600, and writes the text', async () => {
  const state = await tempDir()
  const file = gateLogFile(state, 'acme/widget', 'fix-1', CHILD, 1, 1)
  assert.equal(await writeLog(file, '# gate: make test\nok\n'), file)
  assert.equal(await readFile(file, 'utf8'), '# gate: make test\nok\n')
  assert.equal((await stat(file)).mode & 0o777, 0o600)
  for (const dir of ['gates', 'gates/acme', 'gates/acme/widget', 'gates/acme/widget/fix-1']) {
    assert.equal((await stat(join(state, dir))).mode & 0o777, 0o700, dir)
  }
})

test('a name already taken gets .2, then .3, before .log', async () => {
  const state = await tempDir()
  const file = gateLogFile(state, 'acme/widget', 'fix-1', CHILD, 1, 1)
  assert.equal(await writeLog(file, 'one'), file)
  const second = file.replace(/\.log$/, '.2.log')
  const third = file.replace(/\.log$/, '.3.log')
  assert.equal(await writeLog(file, 'two'), second)
  assert.equal(await writeLog(file, 'three'), third)
  assert.equal(await readFile(file, 'utf8'), 'one')
  assert.equal(await readFile(second, 'utf8'), 'two')
  assert.equal(await readFile(third, 'utf8'), 'three')
})

test('a link in the place of the file isn\'t followed: the link and its target stay as they were', async () => {
  const state = await tempDir()
  const outside = await tempDir()
  const target = join(outside, 'target.txt')
  await writeFile(target, 'not yours\n')
  const file = gateLogFile(state, 'acme/widget', 'fix-1', CHILD, 1, 1)
  await mkdir(join(state, 'gates', 'acme', 'widget', 'fix-1'), { recursive: true })
  await symlink(target, file)
  const dangling = file.replace(/\.log$/, '.2.log')
  await symlink(join(outside, 'missing.txt'), dangling)
  const written = await writeLog(file, 'the gate\'s output')
  assert.equal(written, file.replace(/\.log$/, '.3.log'))
  assert.equal(await readFile(written, 'utf8'), 'the gate\'s output')
  assert.equal(await readlink(file), target)
  assert.equal(await readlink(dangling), join(outside, 'missing.txt'))
  assert.equal(await readFile(target, 'utf8'), 'not yours\n')
  await assert.rejects(stat(join(outside, 'missing.txt')), { code: 'ENOENT' })
})

/** Make `file` with `text` and an mtime `ageMs` ago. */
async function aged(file: string, text: string, ageMs: number, now: number): Promise<void> {
  await mkdir(join(file, '..'), { recursive: true })
  await writeFile(file, text)
  const when = new Date(now - ageMs)
  await utimes(file, when, when)
}

test('pruneLogs removes .log files older than 30 days and directories left empty, and keeps the rest', async () => {
  const state = await tempDir()
  const outside = await tempDir()
  const now = Date.now()
  const old = LOG_KEEP_MS + 60_000
  const gates = join(state, 'gates')
  await aged(join(gates, 'acme/widget/fix-1/a-1-1.log'), 'old', old, now)
  await aged(join(gates, 'acme/widget/fix-1/a-1-2.log'), 'new', 60_000, now)
  await aged(join(gates, 'acme/widget/fix-1/notes.txt'), 'not a log', old, now)
  await aged(join(gates, 'acme/gone/fix-2/b-1-1.log'), 'old', old, now)
  await aged(join(gates, 'acme/gone/fix-2/b-1-2.2.log'), 'old', old, now)
  // A link named like a log, to an old log outside: neither is touched.
  await aged(join(outside, 'elsewhere.log'), 'outside', old, now)
  await symlink(join(outside, 'elsewhere.log'), join(gates, 'acme/widget/fix-1/linked-1-1.log'))
  // A link to a directory isn't followed either.
  await aged(join(outside, 'dir/deep-1-1.log'), 'outside', old, now)
  await symlink(join(outside, 'dir'), join(gates, 'acme/widget/linked-dir'))

  assert.equal(await pruneLogs(state, now), 3)
  await assert.rejects(lstat(join(gates, 'acme/widget/fix-1/a-1-1.log')), { code: 'ENOENT' })
  assert.equal(await readFile(join(gates, 'acme/widget/fix-1/a-1-2.log'), 'utf8'), 'new')
  assert.equal(await readFile(join(gates, 'acme/widget/fix-1/notes.txt'), 'utf8'), 'not a log')
  assert.equal((await lstat(join(gates, 'acme/widget/fix-1/linked-1-1.log'))).isSymbolicLink(), true)
  assert.equal(await readFile(join(outside, 'elsewhere.log'), 'utf8'), 'outside')
  assert.equal((await lstat(join(gates, 'acme/widget/linked-dir'))).isSymbolicLink(), true)
  assert.equal(await readFile(join(outside, 'dir/deep-1-1.log'), 'utf8'), 'outside')
  // acme/gone held only old logs: it and its fix-2 went. acme and gates stay.
  await assert.rejects(lstat(join(gates, 'acme/gone')), { code: 'ENOENT' })
  assert.equal((await stat(join(gates, 'acme'))).isDirectory(), true)
  assert.equal((await stat(gates)).isDirectory(), true)
})

test('pruneLogs with nothing there gives 0, and leaves an empty gates directory', async () => {
  const state = await tempDir()
  assert.equal(await pruneLogs(state), 0)
  await mkdir(join(state, 'gates'))
  assert.equal(await pruneLogs(state), 0)
  assert.equal((await stat(join(state, 'gates'))).isDirectory(), true)
})

test('pruneLogs doesn\'t follow a link in the place of the gates directory', async () => {
  const state = await tempDir()
  const outside = await tempDir()
  const now = Date.now()
  await aged(join(outside, 'x-1-1.log'), 'outside', LOG_KEEP_MS + 60_000, now)
  await symlink(outside, join(state, 'gates'))
  assert.equal(await pruneLogs(state, now), 0)
  assert.equal(await readFile(join(outside, 'x-1-1.log'), 'utf8'), 'outside')
})
