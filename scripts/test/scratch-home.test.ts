/**
 * The preload (`scripts/scratch-home.ts`) that gives every `pnpm test` process a scratch HOME: `pnpm test` passes it,
 * the test runner hands it on to each test file, and the directory it makes is gone when the run ends. The run checked
 * here starts from a HOME in a temp directory too, never the runner's.
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const PRELOAD = fileURLToPath(new URL('../scratch-home.ts', import.meta.url))
const ROOT = fileURLToPath(new URL('../..', import.meta.url))

const dir = await mkdtemp(join(tmpdir(), 'dish-scratch-home-test-'))
after(() => rm(dir, { recursive: true, force: true }))

test('pnpm test preloads it', () => {
  const { scripts } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
  assert.match(scripts.test!, /^node --test --import \.\/scripts\/scratch-home\.ts /)
})

test('a test file run with it has a HOME of its own, which is removed when the run ends', async () => {
  const started = join(dir, 'started-home')
  await mkdir(started)
  const out = join(dir, 'seen.json')
  const probe = join(dir, 'probe.test.mjs')
  await writeFile(probe, `
    import { test } from 'node:test'
    import { existsSync, writeFileSync } from 'node:fs'
    import { homedir } from 'node:os'
    test('probe', () => {
      const { HOME, HISTFILE } = process.env
      writeFileSync(${JSON.stringify(out)}, JSON.stringify({ HOME, HISTFILE, homedir: homedir(), exists: existsSync(HOME) }))
    })
  `)
  // This run's temp directory, from TMPDIR, TMP or TEMP (else /tmp), so the child's is the one compared with below.
  const env = { PATH: process.env.PATH, HOME: started, TMPDIR: tmpdir() }
  await execFileAsync(process.execPath, ['--test', '--import', PRELOAD, probe], { cwd: dir, env })

  const seen = JSON.parse(await readFile(out, 'utf8')) as { HOME: string, HISTFILE: string, homedir: string, exists: boolean }
  assert.notEqual(seen.HOME, started, 'the test file did not keep the HOME it was started with')
  assert.ok(seen.HOME.startsWith(join(tmpdir(), 'dish-test-home-')), seen.HOME)
  assert.equal(seen.exists, true, 'the HOME existed while the test ran')
  assert.equal(seen.homedir, seen.HOME, 'os.homedir() agrees')
  assert.equal(seen.HISTFILE, join(seen.HOME, '.bash_history'))
  assert.equal(existsSync(seen.HOME), false, 'removed when the run ended')
  assert.deepEqual(await readdir(started), [], 'nothing was written to the HOME it was started with')
})
