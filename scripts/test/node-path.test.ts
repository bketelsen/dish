/**
 * No `NODE_PATH` into the checkout for dsh, and so for every agent shell. pnpm's `node_modules/.bin/dsh` shim exports a
 * `NODE_PATH` that ends in the checkout's `node_modules/.pnpm/node_modules`, and dsh hands its environment to every
 * agent command (dsh-subprocess's `scrubbedParentEnv` drops only `DSH_*` and names that look like secrets). Node's
 * CommonJS `require` falls back to `NODE_PATH` for a bare name that no `node_modules` above the requiring file has, so an
 * agent whose workspace holds the checkout could plant a module there for a CommonJS program to load later, approved
 * escalations outside the sandbox included. The shim also runs a `node_modules/.bin/node`, when there is one, in place
 * of node. So the launcher starts dsh's own script with the node that runs it, and passes no `NODE_PATH` on.
 *
 * The end-to-end cases give a temp checkout a stand-in dsh package, a shim beside it like pnpm's, a planted `node` and a
 * planted module, and check that the stand-in dsh, and a CommonJS program it runs the way an agent's command runs, see
 * none of them. One runs the launcher through real `pnpm run`. Every checkout here is a temp directory, and every child
 * gets a scratch HOME.
 */

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { devEnvironment, dshEntry, environmentFor, invocation, main, ROOT } from '../env.ts'

const LAUNCHER = fileURLToPath(new URL('../env.ts', import.meta.url))
const BASE_PATH = process.env.PATH ?? '/usr/bin:/bin'

let dir: string
/** The HOME every child here gets. */
let home: string
let counter = 0

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dish-node-path-test-'))
  home = join(dir, 'home')
  await mkdir(home)
})
after(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false)
}

/** A temp checkout with dsh's package.json saying `bin`, and `lib/bin.js` in it. */
async function makePackage(bin: unknown): Promise<{ root: string, pkg: string }> {
  const root = join(dir, `root-${++counter}`)
  const pkg = join(root, 'node_modules', '@deepseek-ai', 'dsh')
  await mkdir(join(pkg, 'lib'), { recursive: true })
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', bin }))
  await writeFile(join(pkg, 'lib', 'bin.js'), '')
  return { root, pkg }
}

// ---- the environment ----------------------------------------------------------------------------------------------

test('devEnvironment and environmentFor drop NODE_PATH, in dev and in prod, and change nothing else for it', () => {
  const input: NodeJS.ProcessEnv = { HOME: '/h', PATH: BASE_PATH, NODE_PATH: '/r/node_modules/.pnpm/node_modules', OTHER: 'x' }
  const before = { ...input }
  const { NODE_PATH: _, ...rest } = input
  assert.equal('NODE_PATH' in devEnvironment('/r', input), false, 'devEnvironment')
  assert.deepEqual(devEnvironment('/r', input), devEnvironment('/r', rest), 'dev: the same as without it')
  for (const mode of ['dev', 'prod'] as const) {
    assert.equal('NODE_PATH' in environmentFor(mode, '/r', input), false, mode)
    assert.deepEqual(environmentFor(mode, '/r', input), environmentFor(mode, '/r', rest), `${mode}: the same as without it`)
  }
  assert.deepEqual(input, before, 'the input is not modified')
})

test('NODE_PATH goes whatever it names, an inherited one outside the checkout or an empty one included', () => {
  for (const NODE_PATH of ['', '/usr/lib/node_modules', `/elsewhere/node_modules${delimiter}/r/node_modules/.pnpm/node_modules`]) {
    for (const mode of ['dev', 'prod'] as const) {
      assert.equal('NODE_PATH' in environmentFor(mode, '/r', { PATH: BASE_PATH, NODE_PATH }), false, `${mode}: ${JSON.stringify(NODE_PATH)}`)
    }
  }
})

// ---- dsh's script ---------------------------------------------------------------------------------------------------

test('dshEntry: the file dsh\'s package.json names as its bin, as an object or a string', async () => {
  for (const bin of [{ dsh: 'lib/bin.js' }, 'lib/bin.js', { dsh: './lib/bin.js', other: 'x.js' }]) {
    const { root, pkg } = await makePackage(bin)
    assert.equal(await dshEntry(root), join(pkg, 'lib', 'bin.js'), JSON.stringify(bin))
  }
})

test('dshEntry: undefined when there is no package, no bin for dsh, no such file, or a package.json that is not JSON', async () => {
  assert.equal(await dshEntry(join(dir, `root-${++counter}`)), undefined, 'no package')
  for (const bin of [undefined, null, {}, { other: 'lib/bin.js' }, { dsh: '' }, { dsh: 7 }, { dsh: 'lib/missing.js' }, { dsh: 'lib' }]) {
    const { root } = await makePackage(bin)
    assert.equal(await dshEntry(root), undefined, JSON.stringify(bin))
  }
  const { root, pkg } = await makePackage({ dsh: 'lib/bin.js' })
  await writeFile(join(pkg, 'package.json'), '{ not json')
  assert.equal(await dshEntry(root), undefined, 'not JSON')
})

test('dshEntry: in this checkout, the script pnpm\'s own dsh shim runs, a shim that sets a NODE_PATH into the checkout', async t => {
  const shim = await readFile(join(ROOT, 'node_modules', '.bin', 'dsh'), 'utf8').catch(() => undefined)
  if (shim === undefined) {
    t.skip('no node_modules/.bin/dsh: pnpm install has not run')
    return
  }
  const target = /^# cmd-shim-target=(.+)$/m.exec(shim)?.[1]
  const entry = await dshEntry(ROOT)
  assert.ok(target !== undefined && entry !== undefined, 'the shim names its target, and dshEntry finds one')
  assert.equal(await realpath(entry), await realpath(target))
  // The two reasons the launcher goes around it.
  assert.match(shim, /export NODE_PATH="[^"]*\/node_modules\/\.pnpm\/node_modules[:"]/)
  assert.match(shim, /\[ -x "\$basedir\/node" \]/)
})

test('invocation: dsh is this node and dsh\'s script; any other name, and dsh with no package, is resolveCommand\'s', async () => {
  const { root, pkg } = await makePackage({ dsh: 'lib/bin.js' })
  const bin = join(root, 'node_modules', '.bin')
  await mkdir(bin)
  for (const name of ['dsh', 'tool']) {
    await writeFile(join(bin, name), '#!/bin/sh\n')
    await chmod(join(bin, name), 0o755)
  }
  assert.deepEqual(await invocation(root, 'dsh'), [process.execPath, join(pkg, 'lib', 'bin.js')], 'never the shim beside it')
  assert.deepEqual(await invocation(root, 'tool'), [join(bin, 'tool')])
  assert.deepEqual(await invocation(root, 'missing'), ['missing'])
  assert.deepEqual(await invocation(root, './dsh'), ['./dsh'], 'a path is a path')
  const empty = join(dir, `root-${++counter}`)
  await mkdir(empty)
  assert.deepEqual(await invocation(empty, 'dsh'), ['dsh'], 'no dsh in the checkout: the PATH lookup decides')
})

// ---- end to end: a planted node and a planted module ----------------------------------------------------------------

/** What the stand-in dsh saw, and whether a CommonJS program it ran found the planted module. */
interface Seen { argv: string[], NODE_PATH?: string, execPath: string, probe: string }

/**
 * dsh's stand-in script. It runs a CommonJS program that requires `dish-planted-probe` with its own environment and in
 * its own working directory, as dsh runs an agent's command, and writes what it saw to the file named by its first line.
 */
const DSH_SOURCE = (out: string): string => `
const { spawnSync } = require('node:child_process')
const { writeFileSync } = require('node:fs')
const probe = spawnSync(process.execPath, ['-e', 'require("dish-planted-probe"); process.stdout.write("loaded")'], { encoding: 'utf8' })
writeFileSync(${JSON.stringify(out)}, JSON.stringify({
  argv: process.argv.slice(2),
  NODE_PATH: process.env.NODE_PATH,
  execPath: process.execPath,
  probe: probe.stdout === 'loaded' ? 'loaded' : 'not found',
}))
`

interface Checkout {
  root: string
  out: string
  /** Where the planted module, the planted node and the shim each leave a file when they run. */
  markers: { module: string, node: string, shim: string }
  /** The NODE_PATH pnpm's shim would give dsh here, and the one an agent shell under such a dsh inherits. */
  shimNodePath: string
}

/**
 * A temp checkout laid out as pnpm lays out this one: dsh's package, whose bin is the stand-in, and a shim for it in
 * `node_modules/.bin` that sets a NODE_PATH into the checkout and prefers a `node` beside it, as pnpm's does. Then what a
 * sandboxed agent whose workspace holds the checkout could plant: a module in `node_modules/.pnpm/node_modules`, where
 * only that NODE_PATH finds it, and a `node_modules/.bin/node`.
 */
async function makeCheckout(options: { plantNode: boolean }): Promise<Checkout> {
  const root = join(dir, `checkout-${++counter}`)
  const bin = join(root, 'node_modules', '.bin')
  const pkg = join(root, 'node_modules', '@deepseek-ai', 'dsh')
  const store = join(root, 'node_modules', '.pnpm', 'node_modules')
  await mkdir(bin, { recursive: true })
  await mkdir(join(pkg, 'lib'), { recursive: true })
  await mkdir(join(store, 'dish-planted-probe'), { recursive: true })
  const out = join(dir, `seen-${counter}.json`)
  const markers = { module: join(dir, `module-ran-${counter}`), node: join(dir, `node-ran-${counter}`), shim: join(dir, `shim-ran-${counter}`) }
  const shimNodePath = [join(pkg, 'node_modules'), join(root, 'node_modules', '.pnpm'), store].join(delimiter)
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', bin: { dsh: 'lib/bin.js' } }))
  await writeFile(join(pkg, 'lib', 'bin.js'), DSH_SOURCE(out))
  await writeFile(join(bin, 'dsh'), [
    '#!/bin/sh',
    `: > ${JSON.stringify(markers.shim)}`,
    'basedir=$(dirname "$0")',
    `export NODE_PATH=${JSON.stringify(shimNodePath)}`,
    'if [ -x "$basedir/node" ]; then exec "$basedir/node" "$basedir/../@deepseek-ai/dsh/lib/bin.js" "$@"; fi',
    'exec node "$basedir/../@deepseek-ai/dsh/lib/bin.js" "$@"',
    '',
  ].join('\n'))
  await chmod(join(bin, 'dsh'), 0o755)
  await writeFile(join(store, 'dish-planted-probe', 'index.js'), `require('node:fs').writeFileSync(${JSON.stringify(markers.module)}, '')\n`)
  if (options.plantNode) {
    await writeFile(join(bin, 'node'), `#!/bin/sh\n: > ${JSON.stringify(markers.node)}\nexec ${JSON.stringify(process.execPath)} "$@"\n`)
    await chmod(join(bin, 'node'), 0o755)
  }
  return { root, out, markers, shimNodePath }
}

/** The stand-in ran under this node with no NODE_PATH, and nothing planted ran: not the module, the node or the shim. */
async function assertSafe(checkout: Checkout, label: string): Promise<Seen> {
  const seen = JSON.parse(await readFile(checkout.out, 'utf8')) as Seen
  assert.equal(seen.NODE_PATH, undefined, `${label}: dsh has no NODE_PATH`)
  assert.equal(seen.probe, 'not found', `${label}: a CommonJS program dsh runs does not find the planted module`)
  assert.equal(await exists(checkout.markers.module), false, `${label}: the planted module never loaded`)
  assert.equal(await exists(checkout.markers.node), false, `${label}: the planted node never ran`)
  assert.equal(await exists(checkout.markers.shim), false, `${label}: the shim never ran`)
  return seen
}

test('the stand-ins are sound: through its shim, dsh gets the NODE_PATH and a CommonJS program it runs loads the planted module', async () => {
  // What the launcher prevents, shown on the same checkout: the shim's NODE_PATH reaches dsh's children, and finds it.
  const checkout = await makeCheckout({ plantNode: true })
  const ran = spawnSync(join(checkout.root, 'node_modules', '.bin', 'dsh'), ['web'], { env: { HOME: home, PATH: BASE_PATH }, encoding: 'utf8' })
  assert.equal(ran.status, 0, ran.stderr)
  const seen = JSON.parse(await readFile(checkout.out, 'utf8')) as Seen
  assert.equal(seen.NODE_PATH, checkout.shimNodePath)
  assert.equal(seen.probe, 'loaded')
  assert.equal(await exists(checkout.markers.module), true, 'the planted module loaded')
  assert.equal(await exists(checkout.markers.node), true, 'the planted node ran as dsh\'s interpreter')
})

test('main: dsh is this node running dsh\'s script, with no NODE_PATH, though the shim, a planted node and an inherited NODE_PATH are there, in dev and in prod', async () => {
  for (const DISH_ENV of ['dev', 'prod']) {
    const checkout = await makeCheckout({ plantNode: true })
    // The PATH `pnpm dsh` hands the launcher (node_modules/.bin first), and the NODE_PATH an agent's `pnpm dsh` inherits
    // from a dsh that was started through the shim.
    const env = { HOME: home, PATH: [join(checkout.root, 'node_modules', '.bin'), BASE_PATH].join(delimiter), NODE_PATH: checkout.shimNodePath, DISH_ENV }
    const code = await main(['dsh', 'web', '--no-open'], { root: checkout.root, env })
    assert.equal(code, 0, DISH_ENV)
    const seen = await assertSafe(checkout, DISH_ENV)
    assert.deepEqual(seen.argv, ['web', '--no-open'], DISH_ENV)
    assert.equal(seen.execPath, process.execPath, `${DISH_ENV}: dsh runs under the launcher's node`)
  }
})

test('pnpm dsh, through real pnpm run: dsh gets no NODE_PATH, and a CommonJS program it runs never loads the planted module', async t => {
  const env = { HOME: home, PATH: BASE_PATH }
  if (spawnSync('pnpm', ['--version'], { env, stdio: 'ignore' }).status !== 0) {
    t.skip('pnpm is not on PATH')
    return
  }
  // No planted node here: `pnpm run` looks `node` up on a PATH with node_modules/.bin first, so a node planted there
  // would run the launcher itself. That is not the launcher's to prevent (see the commit and deploy/README.md).
  const checkout = await makeCheckout({ plantNode: false })
  await mkdir(join(checkout.root, 'scripts'))
  await copyFile(LAUNCHER, join(checkout.root, 'scripts', 'env.ts'))
  await writeFile(join(checkout.root, 'package.json'), JSON.stringify({
    name: 'dish-node-path-fixture',
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
