/**
 * `deploy/pnpm-copies.ts`: dish's own installs copy pnpm's store instead of hard-linking it. The setting it writes into
 * a profile's pnpm-workspace.yaml, the checkout's own setting, and the replacing of files that are links already, on
 * real hard links in a temp directory. Nothing here touches a real store or home.
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { chmod, link, mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { unlinkFiles, updateWorkspace, withCopies } from '../pnpm-copies.ts'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const CLI = join(ROOT, 'deploy', 'pnpm-copies.ts')

/** What dsh writes into a profile it makes (dsh-app-boot's PROFILE_PNPM_WORKSPACE). */
const PROFILE_WORKSPACE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`

let dir: string
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dish-pnpm-copies-test-'))
  await mkdir(join(dir, 'home'))
})
after(() => rm(dir, { recursive: true, force: true }))

function run(args: string[]): Promise<{ code: number, stdout: string, stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH, HOME: join(dir, 'home') }, encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : -1, stdout, stderr })
    })
  })
}

test("the checkout's own pnpm installs copy", () => {
  const settings = parse(readFileSync(join(ROOT, 'pnpm-workspace.yaml'), 'utf8')) as Record<string, unknown>
  assert.equal(settings.packageImportMethod, 'clone-or-copy')
})

test("a profile's pnpm-workspace.yaml gets packageImportMethod: clone-or-copy, and keeps the rest", () => {
  const out = withCopies(PROFILE_WORKSPACE)
  assert.equal(out, PROFILE_WORKSPACE + 'packageImportMethod: clone-or-copy\n')
  assert.equal(withCopies(out), out, 'a second run changes nothing')
  assert.equal(withCopies('# mine\npackageImportMethod: hardlink # set by hand\n'), '# mine\npackageImportMethod: clone-or-copy # set by hand\n')
  assert.throws(() => withCopies('- a\n'), /mapping/)
  assert.throws(() => withCopies('a: [b\n'), Error)
})

test('the file is written in place of the old one, with its mode; a missing one is not made', async () => {
  const path = join(dir, 'pnpm-workspace.yaml')
  await writeFile(path, PROFILE_WORKSPACE)
  await chmod(path, 0o640)
  assert.equal(await updateWorkspace(path), 'updated')
  assert.equal(await readFile(path, 'utf8'), PROFILE_WORKSPACE + 'packageImportMethod: clone-or-copy\n')
  assert.equal((await stat(path)).mode & 0o777, 0o640)
  assert.equal(await updateWorkspace(path), 'unchanged')
  assert.equal(await updateWorkspace(join(dir, 'none', 'pnpm-workspace.yaml')), 'missing')
  assert.ok(!existsSync(join(dir, 'none')))
})

test('files with more than one link become copies of their own: same content, mode and times; links are not followed', async () => {
  const root = join(dir, 'unlink')
  const store = join(dir, 'store')
  const outside = join(dir, 'outside')
  for (const path of [join(root, 'node_modules', 'a', 'lib'), store, outside]) await mkdir(path, { recursive: true })
  const stored = join(store, 'f1')
  await writeFile(stored, 'console.log(1)\n')
  await chmod(stored, 0o755)
  const past = new Date('2020-01-02T03:04:05Z')
  await utimes(stored, past, past)
  const linked = join(root, 'node_modules', 'a', 'lib', 'index.js')
  await link(stored, linked)
  const own = join(root, 'node_modules', 'a', 'package.json')
  await writeFile(own, '{}\n')
  // A directory reached through a symbolic link is someone else's: its linked file stays linked.
  await writeFile(join(store, 'f2'), 'x')
  await link(join(store, 'f2'), join(outside, 'shared.js'))
  await symlink(outside, join(root, 'node_modules', 'b'))

  const first = unlinkFiles(join(root, 'node_modules'))
  assert.deepEqual(first, { copied: 1, failed: [] })
  const copy = await stat(linked)
  assert.equal(copy.nlink, 1)
  assert.notEqual(copy.ino, (await stat(stored)).ino)
  assert.equal(await readFile(linked, 'utf8'), 'console.log(1)\n')
  assert.equal(copy.mode & 0o7777, 0o755)
  assert.equal(copy.mtimeMs, past.getTime())
  assert.equal((await stat(stored)).nlink, 1, "the store's file is left as it was, now alone")
  assert.equal((await stat(join(outside, 'shared.js'))).nlink, 2, 'a linked directory is not followed')
  assert.equal((await stat(own)).nlink, 1)

  assert.deepEqual(unlinkFiles(join(root, 'node_modules')), { copied: 0, failed: [] }, 'a second run copies nothing')
  assert.deepEqual(unlinkFiles(join(root, 'missing')), { copied: 0, failed: [] })
})

test('the CLI: --workspace and --unlink, a file it cannot copy is a warning, and wrong arguments exit 2', async () => {
  const path = join(dir, 'cli', 'pnpm-workspace.yaml')
  const modules = join(dir, 'cli', 'node_modules')
  await mkdir(join(modules, 'locked'), { recursive: true })
  await writeFile(path, PROFILE_WORKSPACE)
  await writeFile(join(dir, 'cli', 'source'), 'x')
  await link(join(dir, 'cli', 'source'), join(modules, 'one.js'))
  await link(join(dir, 'cli', 'source'), join(modules, 'locked', 'two.js'))
  await chmod(join(modules, 'locked'), 0o555)
  try {
    const result = await run(['--workspace', path, '--unlink', modules, '--unlink', join(dir, 'cli', 'missing')])
    assert.equal(result.code, 0, result.stderr)
    const root = process.getuid?.() === 0
    assert.equal(result.stdout, `workspace: updated\nunlinked: ${root ? 2 : 1} ${modules}\nunlinked: 0 ${join(dir, 'cli', 'missing')}\n`)
    if (!root) assert.match(result.stderr, /1 files under .* are still links into pnpm's store, such as .*\/locked\/two\.js/)
  } finally {
    await chmod(join(modules, 'locked'), 0o755)
  }
  for (const args of [[], ['--other'], ['stray']]) {
    const result = await run(args)
    assert.equal(result.code, 2, args.join(' '))
    assert.match(result.stderr, /usage: node deploy\/pnpm-copies\.ts/)
  }
  await writeFile(join(dir, 'cli', 'bad.yaml'), '- a list\n')
  assert.equal((await run(['--workspace', join(dir, 'cli', 'bad.yaml')])).code, 1)
})
