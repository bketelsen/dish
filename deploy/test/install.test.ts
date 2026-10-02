/**
 * `deploy/install.sh`, run for real against scratch directories: HOME, DSH_HOME and the XDG directories all point into
 * a temp directory, so nothing here touches a real dsh home, config store or desktop profile.
 *
 * - Refusing to start without its inputs is checked on every `pnpm test`: it stops before it does anything.
 * - The installs are slow (pnpm install, pnpm build, dsh and pnpm for each bundle) and need a checkout with its
 *   dependencies, so they run only with `DISH_INSTALL_TEST=1 node --test deploy/test/install.test.ts`.
 *
 * The property that matters most is that the install never opens the real config store, and the checks on it are:
 * every dsh process the install starts has its four XDG directories pointed at a throwaway directory (a spy loaded
 * through NODE_OPTIONS records each one), the throwaway directory is gone afterwards, and the scratch "real"
 * XDG directories hold no `dish` directory, so no `config.git`. The throwaway directories must not take pnpm's store
 * with them, which is the other check: the profile records the account's own store, so a later install can add to it.
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { parse } from 'yaml'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const INSTALL = join(ROOT, 'deploy', 'install.sh')
const INTEGRATION = process.env.DISH_INSTALL_TEST === '1'
const SKIP = INTEGRATION ? false : 'set DISH_INSTALL_TEST=1 to run the install against scratch directories'

const REMOTE = 'git@github-dish-config.invalid:example/store.git'
const USER_NAME = 'Dish Test'
const USER_EMAIL = 'dish-test@example.invalid'
const BUNDLES = ['dish-copilot', 'dish-config', 'dish-prompts', 'dish-crew', 'dish-judge']

const execFileAsync = promisify(execFile)

/**
 * Loaded into every node process the install starts: it records each dsh process's argument list and XDG directories,
 * and, for a `plugin ... add`, whether the profile's patch file already has the dish-config row.
 */
const SPY = `
const { appendFileSync, readFileSync } = require('node:fs')
const { join } = require('node:path')
if (/@deepseek-ai[\\\\/]dsh[\\\\/]lib[\\\\/]bin\\.js$/.test(process.argv[1] ?? '')) {
  const env = process.env
  const args = process.argv.slice(2)
  const xdg = [env.XDG_CONFIG_HOME, env.XDG_STATE_HOME, env.XDG_DATA_HOME, env.XDG_CACHE_HOME]
  let patchHasRow
  if (args[0] === 'plugin' && args.includes('add')) {
    try {
      const patch = join(env.DSH_HOME, 'profiles', args[args.indexOf('--profile') + 1], 'cordis.patch.yml')
      patchHasRow = readFileSync(patch, 'utf8').includes('id: dish-config')
    } catch {
      patchHasRow = false
    }
  }
  appendFileSync(env.DISH_TEST_SPY, JSON.stringify({ args, xdg, patchHasRow }) + '\\n')
}
`

interface Scratch {
  dir: string
  home: string
  dshHome: string
  /** The "real" XDG directories of the scratch account: what dsh would use without the install's throwaway ones. */
  xdg: { config: string; state: string; data: string; cache: string }
  /** TMPDIR for the install, so the throwaway directory it makes can be checked for afterwards. */
  tmp: string
  spyLog: string
  env: NodeJS.ProcessEnv
}

const scratches: string[] = []
after(async () => {
  await Promise.all(scratches.map((dir) => rm(dir, { recursive: true, force: true })))
})

/** A scratch account and the environment for running the install as it. `extra` adds to, or with `undefined` removes from, the install's inputs. */
async function makeScratch(extra: Record<string, string | undefined> = {}): Promise<Scratch> {
  const dir = await mkdtemp(join(tmpdir(), 'dish-install-test-'))
  scratches.push(dir)
  const xdg = { config: join(dir, 'xdg', 'config'), state: join(dir, 'xdg', 'state'), data: join(dir, 'xdg', 'data'), cache: join(dir, 'xdg', 'cache') }
  const home = join(dir, 'home')
  const tmp = join(dir, 'tmp')
  for (const path of [home, tmp, ...Object.values(xdg)]) await mkdir(path, { recursive: true })
  const spy = join(dir, 'spy.cjs')
  await writeFile(spy, SPY)
  const spyLog = join(dir, 'spy.log')

  // The caller's environment, less what would steer dsh, dish or pnpm, and what `pnpm test` adds for its own scripts.
  // PNPM_HOME is the one that matters most: pnpm 11 looks for its store under it before XDG_DATA_HOME, and a user's
  // shell usually sets it, which would pin the scratch profile to their real store. CI makes pnpm purge and rebuild the
  // checkout's node_modules against a store the test then deletes.
  const env: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (!/^(DISH_|DSH_|XDG_|npm_|pnpm_|PNPM_HOME$|CI$|NODE_OPTIONS$)/.test(name)) env[name] = value
  }
  Object.assign(env, {
    HOME: home,
    DSH_HOME: join(dir, 'dsh'),
    XDG_CONFIG_HOME: xdg.config,
    XDG_STATE_HOME: xdg.state,
    XDG_DATA_HOME: xdg.data,
    XDG_CACHE_HOME: xdg.cache,
    TMPDIR: tmp,
    NODE_OPTIONS: `--require ${spy}`,
    DISH_TEST_SPY: spyLog,
    DISH_REMOTE: REMOTE,
    DISH_USER_NAME: USER_NAME,
    DISH_USER_EMAIL: USER_EMAIL,
  })
  for (const [name, value] of Object.entries(extra)) {
    if (value === undefined) delete env[name]
    else env[name] = value
  }
  return { dir, home, dshHome: join(dir, 'dsh'), xdg, tmp, spyLog, env }
}

interface Result {
  code: number
  stdout: string
  stderr: string
}

/** Run a command from the checkout's root, and never throw on a non-zero exit. */
async function run(command: string, args: string[], scratch: Scratch, env: NodeJS.ProcessEnv = scratch.env): Promise<Result> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { cwd: ROOT, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 240_000 })
    return { code: 0, stdout, stderr }
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: string; stderr?: string }
    return { code: typeof failure.code === 'number' ? failure.code : -1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
  }
}

interface DshCall {
  args: string[]
  xdg: string[]
  /** For a `plugin ... add`: whether the patch file had the dish-config row at that moment. */
  patchHasRow?: boolean
}

/** Every dsh process started so far under this scratch's spy. */
function dshCalls(scratch: Scratch): DshCall[] {
  if (!existsSync(scratch.spyLog)) return []
  return readFileSync(scratch.spyLog, 'utf8').split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as DshCall)
}

/** Fail unless every dsh process ran with all four XDG directories somewhere other than the scratch account's own. */
function assertIsolated(scratch: Scratch, calls: DshCall[]): void {
  const real = [scratch.xdg.config, scratch.xdg.state, scratch.xdg.data, scratch.xdg.cache]
  for (const call of calls) {
    assert.equal(call.xdg.length, 4)
    call.xdg.forEach((path, index) => {
      assert.ok(path !== undefined && path !== '', `dsh ${call.args.join(' ')}: XDG directory ${index} is unset`)
      assert.notEqual(path, real[index], `dsh ${call.args.join(' ')}: XDG directory ${index} is the account's own`)
      assert.ok(path.startsWith(`${scratch.tmp}/`), `dsh ${call.args.join(' ')}: ${path} is not under the install's TMPDIR`)
    })
  }
}

/** Fail unless every `plugin ... add` found the dish-config row already in the patch file: the rows go in before the bundles. */
function assertRowsFirst(calls: DshCall[]): void {
  const adds = calls.filter((call) => call.args[0] === 'plugin' && call.args.includes('add'))
  assert.ok(adds.length > 0, 'the install linked a bundle')
  for (const call of adds) assert.equal(call.patchHasRow, true, `dsh ${call.args.join(' ')}: the patch file had no dish-config row yet`)
}

/** The account's own XDG directories hold nothing of dish's: no `dish` directory, so no config store. */
async function assertNoStore(scratch: Scratch): Promise<void> {
  for (const [name, path] of Object.entries(scratch.xdg)) {
    assert.ok(!(await readdir(path)).includes('dish'), `${name} directory has a dish directory`)
  }
  assert.ok(!existsSync(join(scratch.xdg.config, 'dish', 'config.git')))
}

for (const name of ['DISH_REMOTE', 'DISH_USER_NAME', 'DISH_USER_EMAIL']) {
  test(`install.sh stops before doing anything without ${name}`, async () => {
    const scratch = await makeScratch({ [name]: undefined })
    const result = await run(INSTALL, [], scratch)
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, new RegExp(`${name} must be set`))
    assert.match(result.stderr, /install: FAILED at step: checking the inputs/)
    assert.equal(existsSync(scratch.dshHome), false, 'no dsh home was made')
    assert.equal(dshCalls(scratch).length, 0)
  })
}

test('install.sh takes an empty DISH_USER_NAME as missing', async () => {
  const scratch = await makeScratch({ DISH_USER_NAME: '' })
  const result = await run(INSTALL, [], scratch)
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /DISH_USER_NAME must be set/)
})

test('install.sh twice changes nothing the second time, and then repairs a missing bundle', { skip: SKIP, timeout: 600_000 }, async () => {
  const scratch = await makeScratch()
  const patch = join(scratch.dshHome, 'profiles', 'web', 'cordis.patch.yml')
  const manifest = join(scratch.dshHome, 'profiles', 'web', 'package.json')

  const first = await run(INSTALL, [], scratch)
  assert.equal(first.code, 0, first.stderr)
  assert.match(first.stdout, /install: profile web at .*: created/)
  assert.match(first.stdout, /install: dish rows \(.*\): updated/)
  assert.match(first.stdout, /bundles added: copilot config prompts crew judge; already linked: none/)
  assert.match(first.stdout, /install: profile changed/)
  const firstCalls = dshCalls(scratch)
  assert.equal(firstCalls.length, 6, 'one dsh command makes the profile, one links each bundle')
  assertIsolated(scratch, firstCalls)
  assertRowsFirst(firstCalls)
  assert.deepEqual(await readdir(scratch.tmp), [], "the install's throwaway directory is removed")

  const patchBefore = statSync(patch).mtimeMs
  const manifestBefore = statSync(manifest).mtimeMs
  const patchText = await readFile(patch, 'utf8')

  const second = await run(INSTALL, [], scratch)
  assert.equal(second.code, 0, second.stderr)
  assert.match(second.stdout, /install: profile web at .*: existing/)
  assert.match(second.stdout, /install: dish rows \(.*\): unchanged/)
  assert.match(second.stdout, /bundles added: none; already linked: copilot config prompts crew judge/)
  assert.match(second.stdout, /install: no changes to the profile/)
  assert.equal(dshCalls(scratch).length, 6, 'the second run starts no dsh command')
  assert.equal(statSync(patch).mtimeMs, patchBefore, 'the patch file was not rewritten')
  assert.equal(statSync(manifest).mtimeMs, manifestBefore, "the profile's package.json was not rewritten")
  assert.equal(await readFile(patch, 'utf8'), patchText)
  assert.deepEqual(await readdir(scratch.tmp), [])

  // pnpm's store is the account's own, not the throwaway one: a profile that records another store cannot be worked on
  // later (ERR_PNPM_UNEXPECTED_STORE), by `plugin add` or by the plugin manager inside dsh web.
  const store = (await run('pnpm', ['store', 'path'], scratch)).stdout.trim()
  assert.ok(store.startsWith(`${scratch.xdg.data}/`), `the account's pnpm store is ${store}`)
  const modules = await readFile(join(scratch.dshHome, 'profiles', 'web', 'node_modules', '.modules.yaml'), 'utf8')
  assert.equal((JSON.parse(modules) as { storeDir: string }).storeDir, store, "the profile records the account's store")

  // A bundle that goes missing (a failed first run, or a removal) is linked again, and only that one.
  const removal = await run('pnpm', ['exec', 'dsh', 'plugin', '--profile', 'web', 'remove', 'dish-judge'], scratch)
  assert.equal(removal.code, 0, removal.stderr)
  const repair = await run(INSTALL, [], scratch)
  assert.equal(repair.code, 0, repair.stderr)
  assert.match(repair.stdout, /bundles added: judge; already linked: copilot config prompts crew\n/)
  assert.match(repair.stdout, /install: dish rows \(.*\): unchanged/)
  const repairCalls = dshCalls(scratch).slice(6)
  assert.equal(repairCalls.length, 2, 'the removal, and one `plugin add`')
  assertIsolated(scratch, repairCalls.slice(1))
  assertRowsFirst(repairCalls)

  // What dsh makes of the profile, composed without booting it, and run with throwaway XDG directories as well.
  const throwaway = join(scratch.dir, 'throwaway')
  const dump = await run('pnpm', ['exec', 'dsh', '--profile', 'web', '--dump-config'], scratch, {
    ...scratch.env,
    XDG_CONFIG_HOME: join(throwaway, 'config'),
    XDG_STATE_HOME: join(throwaway, 'state'),
    XDG_DATA_HOME: join(throwaway, 'data'),
    XDG_CACHE_HOME: join(throwaway, 'cache'),
  })
  assert.equal(dump.code, 0, dump.stderr)
  assert.doesNotMatch(dump.stderr, /not found/, 'no row is left without its bundle')
  for (const bundle of BUNDLES) assert.match(dump.stdout, new RegExp(`^# == ${bundle}\\b`, 'm'), `${bundle} is in the profile`)
  assert.match(dump.stdout, new RegExp(`^# == dish-config, patched by .*cordis\\.patch\\.yml\\n- id: dish-config\\n  name: dish-config\\n  config:\\n    remote: ${REMOTE.replaceAll('.', '\\.')}\\n    userName: ${USER_NAME}\\n    userEmail: ${USER_EMAIL.replaceAll('.', '\\.')}\\n`, 'm'))
  assert.match(dump.stdout, /^- id: agent-preset-registry\n {2}name: '@deepseek-ai\/dsh-agent-preset-registry'\n {2}config:\n {4}default: standard\n {4}selectedDefault: dish\n/m)

  await assertNoStore(scratch)
})

test('install.sh makes a custom profile from the web one, takes an empty remote, and values that start with a dash', { skip: SKIP, timeout: 600_000 }, async () => {
  const scratch = await makeScratch({ DISH_PROFILE: 'dish-scratch', DISH_REMOTE: '', DISH_USER_NAME: '-Dash Test', DISH_USER_EMAIL: '--dash@example.invalid' })
  const profile = join(scratch.dshHome, 'profiles', 'dish-scratch')

  const first = await run(INSTALL, [], scratch)
  assert.equal(first.code, 0, first.stderr)
  assert.match(first.stdout, /install: profile dish-scratch at .*: created/)
  assert.match(first.stdout, /install: dish rows \(none, the store stays local\): updated/)
  const manifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8')) as { dsh: { profile: { bundles: string[] } } }
  assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...BUNDLES])
  const rows = parse(await readFile(join(profile, 'cordis.patch.yml'), 'utf8')) as Array<{ id: string; config: Record<string, string> }>
  assert.deepEqual(rows.find((row) => row.id === 'dish-config')?.config, { remote: '', userName: '-Dash Test', userEmail: '--dash@example.invalid' })
  assertIsolated(scratch, dshCalls(scratch))
  assertRowsFirst(dshCalls(scratch))

  const second = await run(INSTALL, [], scratch)
  assert.equal(second.code, 0, second.stderr)
  assert.match(second.stdout, /install: no changes to the profile/)
  await assertNoStore(scratch)
})

test('install.sh names the step that failed, and cleans up', { skip: SKIP, timeout: 600_000 }, async () => {
  const scratch = await makeScratch({ DISH_PROFILE: 'web', DISH_USER_EMAIL: 'two\nlines' })
  const result = await run(INSTALL, [], scratch)
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /install: FAILED at step: writing dish's rows into .*cordis\.patch\.yml/)
  assert.match(result.stderr, /userEmail must be a single line/)
  assert.deepEqual(await readdir(scratch.tmp), [], "the throwaway directory is removed after a failure too")
  await assertNoStore(scratch)
})
