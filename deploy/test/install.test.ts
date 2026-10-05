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
 * XDG directories hold no `dish` directory, so no `config.git` and no memory vault. Under `pnpm dev` the launcher sets DSH_DISH_HOME, which
 * moves dish's directories ahead of XDG_*: the scratch sets it too, and the spy checks that no dsh process sees it.
 * The throwaway directories must not take pnpm's store with them, which is the other check: the profile records the
 * account's own store, so a later install can add to it.
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
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
const BUNDLES = ['dish-copilot', 'dish-config', 'dish-prompts', 'dish-skills', 'dish-crew', 'dish-judge', 'dish-web', 'dish-projects', 'dish-workspaces', 'dish-gates', 'dish-orchestrator', 'dish-browser', 'dish-memory']
const VAULT_REMOTE = 'git@github-dish-vault.invalid:example/vault.git'

const execFileAsync = promisify(execFile)

/**
 * Loaded into every node process the install starts: it records each dsh process's argument list, XDG directories and
 * DSH_DISH_HOME, and, for a `plugin ... add`, whether the profile's patch file already has the dish-config row.
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
  appendFileSync(env.DISH_TEST_SPY, JSON.stringify({ args, xdg, instanceHome: env.DSH_DISH_HOME, patchHasRow }) + '\\n')
}
`

interface Scratch {
  dir: string
  home: string
  dshHome: string
  /** The "real" XDG directories of the scratch account: what dsh would use without the install's throwaway ones. */
  xdg: { config: string; state: string; data: string; cache: string }
  /** What DSH_DISH_HOME is set to for the install: dsh must never see it, so this directory must never be made. */
  instance: string
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
    // As `pnpm dev` has it. It moves dish's directories ahead of XDG_*, so the install has to take it away from dsh.
    DSH_DISH_HOME: join(dir, 'instance'),
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
  return { dir, home, dshHome: join(dir, 'dsh'), xdg, instance: join(dir, 'instance'), tmp, spyLog, env }
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
  /** DSH_DISH_HOME as that dsh process saw it. */
  instanceHome?: string
  /** For a `plugin ... add`: whether the patch file had the dish-config row at that moment. */
  patchHasRow?: boolean
}

/** Every dsh process started so far under this scratch's spy. */
function dshCalls(scratch: Scratch): DshCall[] {
  if (!existsSync(scratch.spyLog)) return []
  return readFileSync(scratch.spyLog, 'utf8').split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as DshCall)
}

/** Fail unless every dsh process ran with all four XDG directories somewhere other than the scratch account's own, and without DSH_DISH_HOME. */
function assertIsolated(scratch: Scratch, calls: DshCall[]): void {
  const real = [scratch.xdg.config, scratch.xdg.state, scratch.xdg.data, scratch.xdg.cache]
  for (const call of calls) {
    assert.equal(call.instanceHome, undefined, `dsh ${call.args.join(' ')}: DSH_DISH_HOME reached dsh`)
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

/** The first regular file under `dir` with more than one link, if any: a link into pnpm's store, or anything else. */
function firstLinked(dir: string): string | undefined {
  const pending = [dir]
  while (pending.length > 0) {
    const current = pending.pop()!
    for (const name of readdirSync(current)) {
      const path = join(current, name)
      const entry = lstatSync(path)
      if (entry.isDirectory()) pending.push(path)
      else if (entry.isFile() && entry.nlink > 1) return path
    }
  }
  return undefined
}

/** The account's own XDG directories hold nothing of dish's: no `dish` directory, so no config store. */
async function assertNoStore(scratch: Scratch): Promise<void> {
  for (const [name, path] of Object.entries(scratch.xdg)) {
    assert.ok(!(await readdir(path)).includes('dish'), `${name} directory has a dish directory`)
  }
  assert.ok(!existsSync(join(scratch.xdg.config, 'dish', 'config.git')))
  assert.ok(!existsSync(scratch.instance), `${scratch.instance} was made: DSH_DISH_HOME reached dish`)
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

for (const value of ['1', 'true', 'ON']) {
  test(`install.sh stops before doing anything with DISH_SANDBOX_HOME=${value}: it is on or off`, async () => {
    const scratch = await makeScratch({ DISH_SANDBOX_HOME: value })
    const result = await run(INSTALL, [], scratch)
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, new RegExp(`install: DISH_SANDBOX_HOME must be on or off \\(unset means off\\), not "${value}"`))
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
  assert.match(first.stdout, /bundles added: copilot config prompts skills crew judge web projects workspaces gates orchestrator browser memory; already linked: none/)
  assert.match(first.stdout, /^install: memory vault: none, the vault stays local$/m, 'DISH_VAULT_REMOTE is optional')
  assert.match(first.stdout, /^install: sandbox home: off$/m)
  assert.match(first.stdout, /^install: the profile's pnpm installs copy: updated$/m)
  assert.match(first.stdout, /^install: links into pnpm's store replaced by copies: \d+$/m)
  assert.match(first.stdout, /install: profile changed/)
  // dish's own installs are copies, not links into the store an agent's command can write.
  const profileWorkspace = parse(await readFile(join(scratch.dshHome, 'profiles', 'web', 'pnpm-workspace.yaml'), 'utf8')) as Record<string, unknown>
  assert.equal(profileWorkspace.packageImportMethod, 'clone-or-copy')
  assert.equal(profileWorkspace.nodeLinker, 'hoisted', "dsh's own settings stay")
  assert.equal(firstLinked(join(scratch.dshHome, 'profiles', 'web', 'node_modules')), undefined)
  assert.equal(firstLinked(join(ROOT, 'node_modules')), undefined)
  const firstCalls = dshCalls(scratch)
  assert.equal(firstCalls.length, 1 + BUNDLES.length, 'one dsh command makes the profile, one links each bundle')
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
  assert.match(second.stdout, /bundles added: none; already linked: copilot config prompts skills crew judge web projects workspaces gates orchestrator browser memory/)
  assert.match(second.stdout, /install: no changes to the profile/)
  assert.match(second.stdout, /^install: the profile's pnpm installs copy: unchanged$/m)
  assert.match(second.stdout, /^install: links into pnpm's store replaced by copies: 0$/m)
  assert.equal(dshCalls(scratch).length, 1 + BUNDLES.length, 'the second run starts no dsh command')
  assert.equal(statSync(patch).mtimeMs, patchBefore, 'the patch file was not rewritten')
  assert.equal(statSync(manifest).mtimeMs, manifestBefore, "the profile's package.json was not rewritten")
  assert.equal(await readFile(patch, 'utf8'), patchText)
  assert.deepEqual(await readdir(scratch.tmp), [])

  // The first install made `dish` the default preset. A default chosen in the UI afterwards is kept by the next install.
  assert.match(patchText, /^ {4}default: standard\n {4}selectedDefault: dish\n/m)
  assert.doesNotMatch(patchText, /id: sandbox/, 'with DISH_SANDBOX_HOME unset, no sandbox row')
  const chosenText = patchText.replace('    selectedDefault: dish\n', '    selectedDefault: standard\n')
  assert.notEqual(chosenText, patchText)
  await writeFile(patch, chosenText)
  const third = await run(INSTALL, [], scratch)
  assert.equal(third.code, 0, third.stderr)
  assert.match(third.stdout, /install: dish rows \(.*\): unchanged/)
  assert.match(third.stdout, /install: no changes to the profile/)
  assert.equal(await readFile(patch, 'utf8'), chosenText, "the UI's choice is kept")

  // pnpm's store is the account's own, not the throwaway one: a profile that records another store cannot be worked on
  // later (ERR_PNPM_UNEXPECTED_STORE), by `plugin add` or by the plugin manager inside dsh web.
  const store = (await run('pnpm', ['store', 'path'], scratch)).stdout.trim()
  assert.ok(store.startsWith(`${scratch.xdg.data}/`), `the account's pnpm store is ${store}`)
  const modules = await readFile(join(scratch.dshHome, 'profiles', 'web', 'node_modules', '.modules.yaml'), 'utf8')
  assert.equal((JSON.parse(modules) as { storeDir: string }).storeDir, store, "the profile records the account's store")

  // A bundle that goes missing (a failed first run, or a removal) is linked again, and only that one.
  // Run directly, not through the install, so DSH_DISH_HOME (which the scratch has, like `pnpm dev`) is taken away here.
  const removal = await run('pnpm', ['exec', 'dsh', 'plugin', '--profile', 'web', 'remove', 'dish-judge'], scratch, { ...scratch.env, DSH_DISH_HOME: undefined })
  assert.equal(removal.code, 0, removal.stderr)
  const repair = await run(INSTALL, [], scratch)
  assert.equal(repair.code, 0, repair.stderr)
  assert.match(repair.stdout, /bundles added: judge; already linked: copilot config prompts skills crew web projects workspaces gates orchestrator browser memory\n/)
  assert.match(repair.stdout, /install: dish rows \(.*\): unchanged/)
  const repairCalls = dshCalls(scratch).slice(1 + BUNDLES.length)
  assert.equal(repairCalls.length, 2, 'the removal, and one `plugin add`')
  assert.equal(repairCalls[0].instanceHome, undefined, 'the removal ran without DSH_DISH_HOME')
  assertIsolated(scratch, repairCalls.slice(1))
  assertRowsFirst(repairCalls)

  // What dsh makes of the profile, composed without booting it, and run with throwaway XDG directories as well.
  const throwaway = join(scratch.dir, 'throwaway')
  const dump = await run('pnpm', ['exec', 'dsh', '--profile', 'web', '--dump-config'], scratch, {
    ...scratch.env,
    DSH_DISH_HOME: undefined,
    XDG_CONFIG_HOME: join(throwaway, 'config'),
    XDG_STATE_HOME: join(throwaway, 'state'),
    XDG_DATA_HOME: join(throwaway, 'data'),
    XDG_CACHE_HOME: join(throwaway, 'cache'),
  })
  assert.equal(dump.code, 0, dump.stderr)
  assert.doesNotMatch(dump.stderr, /not found/, 'no row is left without its bundle')
  for (const bundle of BUNDLES) assert.match(dump.stdout, new RegExp(`^# == ${bundle}\\b`, 'm'), `${bundle} is in the profile`)
  assert.match(dump.stdout, new RegExp(`^# == dish-config, patched by .*cordis\\.patch\\.yml\\n- id: dish-config\\n  name: dish-config\\n  config:\\n    remote: ${REMOTE.replaceAll('.', '\\.')}\\n    userName: ${USER_NAME}\\n    userEmail: ${USER_EMAIL.replaceAll('.', '\\.')}\\n`, 'm'))
  assert.match(dump.stdout, /^- id: agent-preset-registry\n {2}name: '@deepseek-ai\/dsh-agent-preset-registry'\n {2}config:\n {4}default: standard\n {4}selectedDefault: standard\n/m, "the UI's choice is what the profile composes")

  await assertNoStore(scratch)
})

test('install.sh makes a custom profile from the web one, takes an empty remote, values that start with a dash, and DISH_SANDBOX_HOME', { skip: SKIP, timeout: 600_000 }, async () => {
  const scratch = await makeScratch({ DISH_PROFILE: 'dish-scratch', DISH_REMOTE: '', DISH_USER_NAME: '-Dash Test', DISH_USER_EMAIL: '--dash@example.invalid', DISH_SANDBOX_HOME: 'on' })
  const profile = join(scratch.dshHome, 'profiles', 'dish-scratch')
  const patch = join(profile, 'cordis.patch.yml')
  type Row = { id: string; name?: string; config: Record<string, unknown> }
  const sandboxRow = async (): Promise<Row | undefined> => (parse(await readFile(patch, 'utf8')) as Row[]).find((row) => row.id === 'sandbox')

  const first = await run(INSTALL, [], scratch)
  assert.equal(first.code, 0, first.stderr)
  assert.match(first.stdout, /install: profile dish-scratch at .*: created/)
  assert.match(first.stdout, /install: dish rows \(none, the store stays local\): updated/)
  assert.match(first.stdout, /^install: sandbox home: on$/m)
  const manifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8')) as { dsh: { profile: { bundles: string[] } } }
  assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...BUNDLES])
  const rows = parse(await readFile(patch, 'utf8')) as Row[]
  assert.deepEqual(rows.find((row) => row.id === 'dish-config')?.config, { remote: '', userName: '-Dash Test', userEmail: '--dash@example.invalid' })
  // The runner is this checkout's own script, by the path pwd -P gives.
  assert.deepEqual(await sandboxRow(), {
    id: 'sandbox',
    name: '@deepseek-ai/dsh-sandbox-local',
    config: { runnerCommand: [join(realpathSync(ROOT), 'deploy', 'dish-sandbox')], runnerFailureSignatures: ['bwrap: ', 'dish-sandbox: '] },
  })
  assertIsolated(scratch, dshCalls(scratch))
  assertRowsFirst(dshCalls(scratch))

  // What dsh makes of it: the sandbox provider's row, patched with the runner.
  const throwaway = join(scratch.dir, 'throwaway')
  const dump = await run('pnpm', ['exec', 'dsh', '--profile', 'dish-scratch', '--dump-config'], scratch, {
    ...scratch.env,
    DSH_DISH_HOME: undefined,
    XDG_CONFIG_HOME: join(throwaway, 'config'),
    XDG_STATE_HOME: join(throwaway, 'state'),
    XDG_DATA_HOME: join(throwaway, 'data'),
    XDG_CACHE_HOME: join(throwaway, 'cache'),
  })
  assert.equal(dump.code, 0, dump.stderr)
  // A long path is folded (`- >-` and the path on the next line).
  assert.match(dump.stdout, /^# == @deepseek-ai\/dsh-base, patched by .*cordis\.patch\.yml\n- id: sandbox\n {2}name: '@deepseek-ai\/dsh-sandbox-local'\n {2}config:\n {4}runnerCommand:\n {6}- (?:>-\n {8})?\/\S*\/deploy\/dish-sandbox\n {4}runnerFailureSignatures:\n {6}- 'bwrap: '\n {6}- 'dish-sandbox: '\n/m)

  const second = await run(INSTALL, [], scratch)
  assert.equal(second.code, 0, second.stderr)
  assert.match(second.stdout, /install: no changes to the profile/)

  // Off takes the row away again, which changes the profile; unset is off too.
  const off = await run(INSTALL, [], scratch, { ...scratch.env, DISH_SANDBOX_HOME: 'off' })
  assert.equal(off.code, 0, off.stderr)
  assert.match(off.stdout, /^install: dish rows \(none, the store stays local\): updated$/m)
  assert.match(off.stdout, /^install: sandbox home: off$/m)
  assert.match(off.stdout, /install: profile changed/)
  assert.equal(await sandboxRow(), undefined)
  const unset = await run(INSTALL, [], scratch, { ...scratch.env, DISH_SANDBOX_HOME: undefined })
  assert.equal(unset.code, 0, unset.stderr)
  assert.match(unset.stdout, /install: no changes to the profile/)
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

// --- the memory vault's remote ---------------------------------------------------------------------------------------

type PatchRow = { id: string; name?: string; config?: Record<string, unknown> }

/** The rows of the profile's patch file. */
async function patchRows(scratch: Scratch, profile = 'web'): Promise<PatchRow[]> {
  return parse(await readFile(join(scratch.dshHome, 'profiles', profile, 'cordis.patch.yml'), 'utf8')) as PatchRow[]
}

/** dish's three rows, in the order the file has them. */
function dishRowIds(rows: PatchRow[]): string[] {
  return rows.map((row) => row.id).filter((id) => ['dish-config', 'agent-preset-registry', 'dish-memory'].includes(id))
}

/** A regular expression for `text`, as it stands. */
function literal(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * One install with DISH_VAULT_REMOTE set, which the two tests below share, since an install takes minutes: the first
 * checks it, the second runs install.sh again on it without the remote. Either one makes it when it runs first.
 */
let vaultInstall: Promise<{ scratch: Scratch; first: Result }> | undefined
function installWithVault(): Promise<{ scratch: Scratch; first: Result }> {
  vaultInstall ??= (async () => {
    const scratch = await makeScratch({ DISH_VAULT_REMOTE: VAULT_REMOTE })
    return { scratch, first: await run(INSTALL, [], scratch) }
  })()
  return vaultInstall
}

test('install.sh writes the vault\'s remote to the dish-memory row, and says so', { skip: SKIP, timeout: 900_000 }, async () => {
  const { scratch, first } = await installWithVault()
  assert.equal(first.code, 0, first.stderr)
  const lines = first.stdout.split('\n')
  const rowsLine = lines.findIndex((line) => /^install: dish rows \(.*\): updated$/.test(line))
  assert.ok(rowsLine >= 0, first.stdout)
  assert.equal(lines[rowsLine], `install: dish rows (${REMOTE}): updated`, 'the rows line is the config store\'s, as before')
  assert.equal(lines[rowsLine + 1], `install: memory vault: ${VAULT_REMOTE}`, 'the vault\'s line follows it')
  assert.match(first.stdout, /bundles added: .* browser memory; already linked: none/)

  const rows = await patchRows(scratch)
  assert.deepEqual(dishRowIds(rows), ['dish-config', 'agent-preset-registry', 'dish-memory'])
  assert.deepEqual(rows.find((row) => row.id === 'dish-memory'), {
    id: 'dish-memory', name: 'dish-memory', config: { remote: VAULT_REMOTE, userName: USER_NAME, userEmail: USER_EMAIL },
  })
  assertIsolated(scratch, dshCalls(scratch))

  // What dsh makes of it: the bundle's row, patched with the remote and the identity.
  const throwaway = join(scratch.dir, 'throwaway')
  const dump = await run('pnpm', ['exec', 'dsh', '--profile', 'web', '--dump-config'], scratch, {
    ...scratch.env,
    DSH_DISH_HOME: undefined,
    XDG_CONFIG_HOME: join(throwaway, 'config'),
    XDG_STATE_HOME: join(throwaway, 'state'),
    XDG_DATA_HOME: join(throwaway, 'data'),
    XDG_CACHE_HOME: join(throwaway, 'cache'),
  })
  assert.equal(dump.code, 0, dump.stderr)
  assert.doesNotMatch(dump.stderr, /not found/, 'no row is left without its bundle')
  assert.match(dump.stdout, new RegExp(`^# == dish-memory, patched by .*cordis\\.patch\\.yml\\n- id: dish-memory\\n  name: dish-memory\\n  config:\\n    remote: ${literal(VAULT_REMOTE)}\\n    userName: ${literal(USER_NAME)}\\n    userEmail: ${literal(USER_EMAIL)}\\n`, 'm'))

  // Nothing booted, so there is no vault, as there is no store.
  await assertNoStore(scratch)
})

test('without DISH_VAULT_REMOTE the vault row has an empty remote and the line says the vault stays local', { skip: SKIP, timeout: 900_000 }, async () => {
  const { scratch, first } = await installWithVault()
  assert.equal(first.code, 0, first.stderr)

  const unset = await run(INSTALL, [], scratch, { ...scratch.env, DISH_VAULT_REMOTE: undefined })
  assert.equal(unset.code, 0, unset.stderr)
  assert.match(unset.stdout, /^install: memory vault: none, the vault stays local$/m)
  assert.match(unset.stdout, new RegExp(`^install: dish rows \\(${literal(REMOTE)}\\): updated$`, 'm'))
  assert.match(unset.stdout, /^install: profile changed$/m)
  assert.deepEqual((await patchRows(scratch)).find((row) => row.id === 'dish-memory')?.config, { remote: '', userName: USER_NAME, userEmail: USER_EMAIL })

  // Empty is the same as unset: nothing more changes.
  const empty = await run(INSTALL, [], scratch, { ...scratch.env, DISH_VAULT_REMOTE: '' })
  assert.equal(empty.code, 0, empty.stderr)
  assert.match(empty.stdout, /^install: memory vault: none, the vault stays local$/m)
  assert.match(empty.stdout, /^install: no changes to the profile$/m)
  assert.deepEqual(dishRowIds(await patchRows(scratch)), ['dish-config', 'agent-preset-registry', 'dish-memory'], 'no second row')
  await assertNoStore(scratch)
})
