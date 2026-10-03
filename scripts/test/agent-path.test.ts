/**
 * The `PATH` dsh gets, and so every agent shell: nothing on it that a sandboxed agent could write from a workspace that
 * holds the checkout (`agentPath`). dsh-subprocess-local finds `bash` on that `PATH` for every command an agent runs,
 * approved escalations outside the sandbox included, so a `bash` planted in the checkout's `node_modules/.bin` would
 * run for all of them. The launcher's end-to-end cases plant one and check that the stand-in dsh, looking `bash` up the
 * way dsh does, gets the system's. One of them runs the launcher through real `pnpm run`, which is what puts
 * `node_modules/.bin` first. Every checkout here is a temp directory, and every child gets a scratch HOME.
 */

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { agentPath, main, SYSTEM_PATH } from '../env.ts'

const LAUNCHER = fileURLToPath(new URL('../env.ts', import.meta.url))
const BASE_PATH = process.env.PATH ?? '/usr/bin:/bin'

let dir: string
/** The HOME every child here gets. */
let home: string
let counter = 0

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dish-agent-path-test-'))
  home = join(dir, 'home')
  await mkdir(home)
})
after(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false)
}

// ---- agentPath --------------------------------------------------------------------------------------------------

test('agentPath drops relative entries, the checkout and what is in it, node_modules/.bin and node-gyp-bin, and keeps the rest in order', () => {
  const path = [
    '',
    '.',
    'bin',
    './node_modules/.bin',
    '/r/node_modules/.bin',
    '/r',
    '/r/',
    '/r/scripts',
    '/r/.dev/dsh/bin',
    '/r/plugins/web/node_modules/.bin',
    '/r/..dots/bin',
    '/usr/../r/bin',
    '/home/u/.local/bin',
    '/elsewhere/project/node_modules/.bin',
    '/elsewhere/other/node_modules/.bin/',
    '/elsewhere/third/node_modules/./.bin/.',
    '/home/u/.local/share/pnpm/store/v11/links/@pnpm/exe/x/node_modules/@pnpm/exe/dist/node-gyp-bin',
    '/usr/local/bin',
    '/r-sibling/bin',
    '/usr/bin',
    '/bin',
    '/usr/bin',
  ].join(delimiter)
  assert.equal(agentPath('/r', path), ['/home/u/.local/bin', '/usr/local/bin', '/r-sibling/bin', '/usr/bin', '/bin', '/usr/bin'].join(delimiter))
})

test('agentPath: no PATH, an empty one, or nothing left gives the system directories, never an empty PATH', () => {
  assert.equal(SYSTEM_PATH, '/usr/local/bin:/usr/bin:/bin')
  for (const path of [undefined, '', ':', '.', '/r/node_modules/.bin', `/r/node_modules/.bin${delimiter}`]) {
    assert.equal(agentPath('/r', path), SYSTEM_PATH, JSON.stringify(path))
  }
})

test('agentPath: an entry that reaches the checkout or a node_modules/.bin through a symbolic link goes, and so does one when the checkout is named through a link', async () => {
  const root = join(dir, `root-${++counter}`)
  await mkdir(join(root, 'tools'), { recursive: true })
  const linkToTools = join(dir, `tools-link-${counter}`)
  const linkToRoot = join(dir, `root-link-${counter}`)
  await symlink(join(root, 'tools'), linkToTools)
  await symlink(root, linkToRoot)
  assert.equal(agentPath(root, [linkToTools, '/usr/bin'].join(delimiter)), '/usr/bin', 'a link into the checkout')
  assert.equal(agentPath(linkToRoot, [join(root, 'tools'), '/usr/bin'].join(delimiter)), '/usr/bin', 'the checkout named through a link')
  assert.equal(agentPath(root, [join(linkToRoot, 'tools'), '/usr/bin'].join(delimiter)), '/usr/bin', 'the checkout reached through a link')
  const project = join(dir, `project-${counter}`, 'node_modules', '.bin')
  const linkToBin = join(dir, `bin-link-${counter}`)
  await mkdir(project, { recursive: true })
  await symlink(project, linkToBin)
  assert.equal(agentPath(root, [linkToBin, '/usr/bin'].join(delimiter)), '/usr/bin', 'a link to another project\'s node_modules/.bin')
})

// ---- end to end: a bash planted in the checkout ------------------------------------------------------------------

/** What the stand-in dsh saw: its arguments, its PATH, and what the `bash` it found on that PATH printed. */
interface Seen { argv: string[], PATH: string, bash: string }

/**
 * Looks `bash` up on its own PATH and runs it, as dsh-subprocess-local does for every agent command, and writes what it
 * saw to the file named by its first line. A real bash prints the path it runs from; the planted one prints `planted`.
 */
const DSH_SOURCE = (out: string): string => `
const { spawnSync } = require('node:child_process')
const { writeFileSync } = require('node:fs')
const bash = spawnSync('bash', ['-c', 'printf %s "$BASH"'], { encoding: 'utf8' })
writeFileSync(${JSON.stringify(out)}, JSON.stringify({
  argv: process.argv.slice(2),
  PATH: process.env.PATH,
  bash: bash.error === undefined ? bash.stdout : String(bash.error),
}))
`

/**
 * A temp checkout with a stand-in `node_modules/.bin/dsh`, and a `bash` planted beside it, as a sandboxed agent whose
 * workspace holds the checkout could plant one. The planted bash leaves a marker when it runs.
 */
async function makeCheckout(): Promise<{ root: string, out: string, marker: string }> {
  const root = join(dir, `checkout-${++counter}`)
  const bin = join(root, 'node_modules', '.bin')
  await mkdir(bin, { recursive: true })
  const out = join(dir, `seen-${counter}.json`)
  const marker = join(dir, `planted-ran-${counter}`)
  await writeFile(join(root, 'dsh.cjs'), DSH_SOURCE(out))
  await writeFile(join(bin, 'dsh'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(root, 'dsh.cjs'))} "$@"\n`)
  await writeFile(join(bin, 'bash'), `#!/bin/sh\n: > ${JSON.stringify(marker)}\nprintf planted\n`)
  await chmod(join(bin, 'dsh'), 0o755)
  await chmod(join(bin, 'bash'), 0o755)
  return { root, out, marker }
}

/** Every entry absolute, and none in `root`, named `node_modules/.bin`, or `node-gyp-bin`. */
function assertNothingWritable(path: string, root: string): void {
  for (const entry of path.split(delimiter)) {
    assert.ok(isAbsolute(entry), `${JSON.stringify(entry)} is absolute (PATH: ${path})`)
    const rest = relative(root, entry)
    assert.ok(rest === '..' || rest.startsWith(`..${sep}`), `${entry} is outside the checkout`)
    assert.ok(!(basename(entry) === '.bin' && basename(dirname(entry)) === 'node_modules'), `${entry} is no node_modules/.bin`)
    assert.notEqual(basename(entry), 'node-gyp-bin', entry)
  }
}

/** The stand-in ran with nothing writable on PATH, and the `bash` it found was a real one. */
async function assertSafe(checkout: { root: string, out: string, marker: string }, label: string): Promise<Seen> {
  const seen = JSON.parse(await readFile(checkout.out, 'utf8')) as Seen
  assertNothingWritable(seen.PATH, checkout.root)
  assert.notEqual(seen.bash, 'planted', `${label}: the planted bash ran`)
  assert.ok(isAbsolute(seen.bash), `${label}: bash ran from ${JSON.stringify(seen.bash)}`)
  const rest = relative(checkout.root, seen.bash)
  assert.ok(rest === '..' || rest.startsWith(`..${sep}`), `${label}: bash is not the checkout's`)
  assert.equal(await exists(checkout.marker), false, `${label}: the planted bash never ran`)
  return seen
}

test('main: dsh is the checkout\'s, but bash, looked up as dsh does, is not one planted beside it, in dev and in prod', async () => {
  for (const DISH_ENV of ['dev', 'prod']) {
    const checkout = await makeCheckout()
    // The PATH `pnpm dsh` hands the launcher: pnpm puts the checkout's node_modules/.bin first.
    const PATH = [join(checkout.root, 'node_modules', '.bin'), BASE_PATH].join(delimiter)
    const code = await main(['dsh', 'web', '--no-open'], { root: checkout.root, env: { HOME: home, PATH, DISH_ENV } })
    assert.equal(code, 0, DISH_ENV)
    const seen = await assertSafe(checkout, DISH_ENV)
    assert.deepEqual(seen.argv, ['web', '--no-open'], `${DISH_ENV}: the stand-in dsh ran, found by its absolute path`)
  }
})

test('pnpm dsh, through real pnpm run: nothing of the checkout on dsh\'s PATH, and the planted bash never runs', async t => {
  const env = { HOME: home, PATH: BASE_PATH }
  if (spawnSync('pnpm', ['--version'], { env, stdio: 'ignore' }).status !== 0) {
    t.skip('pnpm is not on PATH')
    return
  }
  // A copy of the launcher, so that its ROOT, the directory above its own, is the temp checkout.
  const checkout = await makeCheckout()
  await mkdir(join(checkout.root, 'scripts'))
  await copyFile(LAUNCHER, join(checkout.root, 'scripts', 'env.ts'))
  await writeFile(join(checkout.root, 'package.json'), JSON.stringify({
    name: 'dish-agent-path-fixture',
    private: true,
    type: 'module',
    scripts: { dsh: 'node scripts/env.ts dsh' },
  }))
  const child = spawn('pnpm', ['run', '--silent', 'dsh', 'web', '--no-open'], { cwd: checkout.root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', chunk => { output += String(chunk) })
  child.stderr.on('data', chunk => { output += String(chunk) })
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', resolve)
  })
  assert.equal(code, 0, output)
  const seen = await assertSafe(checkout, 'pnpm dsh')
  assert.deepEqual(seen.argv, ['web', '--no-open'])
  assert.equal(await exists(join(checkout.root, '.dev', 'dsh')), true, 'it ran in dev, in the temp checkout')
})
