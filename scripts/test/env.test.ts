/**
 * The launcher (`scripts/env.ts`): which mode it picks, exactly which variables dev adds, and what `main` does with a
 * command. Every run uses a temp `root` and an explicit environment, so nothing here reads or creates a real `.dev`,
 * dsh home or XDG directory. The one CLI subprocess runs in prod mode, which makes no directories.
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { devEnvironment, ensureDevDirectories, environmentFor, main, resolveMode, ROOT, UsageError } from '../env.ts'

const CLI = fileURLToPath(new URL('../env.ts', import.meta.url))
const REPO = dirname(dirname(CLI))
const DIRECTORIES = ['dsh', 'config', 'state', 'data', 'cache']

let dir: string
let counter = 0

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dish-env-test-'))
})
after(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** A fresh checkout stand-in: an empty directory, no `.dev`. */
async function makeRoot(): Promise<string> {
  const root = join(dir, `root-${++counter}`)
  await mkdir(root)
  return root
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false)
}

async function mode(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777
}

/** The names the launcher answers for, as a child sees them. */
interface Seen { DSH_HOME?: string, DSH_DISH_HOME?: string, DISH_ENV?: string, XDG_DATA_HOME?: string, PATH?: string }

/** Runs `main` on a child that writes what it sees to a file, and returns the exit code and that. */
async function run(root: string, env: NodeJS.ProcessEnv): Promise<{ code: number, seen: Seen | undefined }> {
  const out = join(dir, `seen-${++counter}.json`)
  const script = 'const e = process.env; require("node:fs").writeFileSync(process.argv[1], JSON.stringify({ '
    + 'DSH_HOME: e.DSH_HOME, DSH_DISH_HOME: e.DSH_DISH_HOME, DISH_ENV: e.DISH_ENV, XDG_DATA_HOME: e.XDG_DATA_HOME, PATH: e.PATH }))'
  const code = await main([process.execPath, '-e', script, out], { root, env })
  const seen = await readFile(out, 'utf8').then(text => JSON.parse(text) as Seen, () => undefined)
  return { code, seen }
}

const BASE_PATH = '/usr/bin:/bin'

test('ROOT is the checkout this file belongs to, not the working directory', () => {
  assert.equal(ROOT, REPO)
})

test('resolveMode: unset, empty and dev are dev; prod is prod', () => {
  assert.equal(resolveMode({}), 'dev')
  assert.equal(resolveMode({ DISH_ENV: '' }), 'dev')
  assert.equal(resolveMode({ DISH_ENV: 'dev' }), 'dev')
  assert.equal(resolveMode({ DISH_ENV: 'prod' }), 'prod')
})

test('resolveMode: anything else throws a UsageError, matched exactly', () => {
  for (const value of ['Prod', ' prod', 'prod ', 'production', 'staging', 'DEV']) {
    assert.throws(() => resolveMode({ DISH_ENV: value }), error => {
      assert.ok(error instanceof UsageError, `${JSON.stringify(value)}: a UsageError`)
      assert.match(error.message, /DISH_ENV must be dev or prod \(unset means dev\)/)
      assert.ok(error.message.includes(JSON.stringify(value)), 'the message quotes the value')
      return true
    })
  }
})

test('devEnvironment replaces the three dish names, prefixes PATH, and changes nothing else', () => {
  const input: NodeJS.ProcessEnv = {
    PATH: BASE_PATH,
    HOME: '/home/someone',
    XDG_CONFIG_HOME: '/xdg/config',
    PNPM_HOME: '/pnpm',
    pnpm_config_store_dir: '/store',
    DSH_HOME: '/elsewhere',
    DSH_DISH_HOME: '/x',
    DISH_ENV: 'dev',
    OTHER: 'value with = and spaces',
  }
  const before = { ...input }
  const result = devEnvironment('/r', input)
  assert.deepEqual(input, before, 'the input is not modified')

  assert.equal(result.DSH_HOME, '/r/.dev/dsh')
  assert.equal(result.DSH_DISH_HOME, '/r/.dev')
  assert.equal(result.DISH_ENV, 'dev')
  assert.equal(result.PATH, `/r/node_modules/.bin:${BASE_PATH}`)
  for (const key of Object.keys(input)) {
    if (['DSH_HOME', 'DSH_DISH_HOME', 'DISH_ENV', 'PATH'].includes(key)) continue
    assert.equal(result[key], input[key], `${key} is untouched`)
  }
  assert.deepEqual(Object.keys(result).sort(), Object.keys(input).sort(), 'the key set is the input\'s')
})

test('devEnvironment adds exactly its four names to an environment that has none of them', () => {
  const result = devEnvironment('/r', { HOME: '/home/someone', PATH: BASE_PATH })
  assert.deepEqual(Object.keys(result).sort(), ['DISH_ENV', 'DSH_DISH_HOME', 'DSH_HOME', 'HOME', 'PATH'])
  assert.ok(!Object.keys(result).some(key => /^xdg_|pnpm|store/i.test(key)), 'no XDG or pnpm name')
})

test('devEnvironment gives PATH no empty entry when there is none to keep', () => {
  assert.equal(devEnvironment('/r', {}).PATH, '/r/node_modules/.bin')
  assert.equal(devEnvironment('/r', { PATH: '' }).PATH, '/r/node_modules/.bin')
})

test('environmentFor: dev is devEnvironment; prod adds only the PATH prefix', () => {
  const input: NodeJS.ProcessEnv = { PATH: BASE_PATH, HOME: '/h', DSH_HOME: '/real', XDG_DATA_HOME: '/data', DISH_ENV: 'prod' }
  assert.deepEqual(environmentFor('dev', '/r', input), devEnvironment('/r', input))
  assert.deepEqual(environmentFor('prod', '/r', input), { ...input, PATH: `/r/node_modules/.bin:${BASE_PATH}` })
})

test('ensureDevDirectories makes .dev and its five directories with mode 0700, even under a permissive umask', async () => {
  const root = await makeRoot()
  const previous = process.umask(0)
  try {
    await ensureDevDirectories(root)
  } finally {
    process.umask(previous)
  }
  assert.equal(await mode(join(root, '.dev')), 0o700)
  for (const name of DIRECTORIES) assert.equal(await mode(join(root, '.dev', name)), 0o700, name)
})

test('ensureDevDirectories narrows existing directories and keeps what is in them', async () => {
  const root = await makeRoot()
  await mkdir(join(root, '.dev', 'dsh'), { recursive: true, mode: 0o755 })
  await chmod(join(root, '.dev'), 0o755)
  await chmod(join(root, '.dev', 'dsh'), 0o755)
  await writeFile(join(root, '.dev', 'dsh', 'keep'), 'x')
  await ensureDevDirectories(root)
  await ensureDevDirectories(root)
  assert.equal(await mode(join(root, '.dev')), 0o700)
  assert.equal(await mode(join(root, '.dev', 'dsh')), 0o700)
  assert.equal(await readFile(join(root, '.dev', 'dsh', 'keep'), 'utf8'), 'x')
})

test('main: dev by default, with the dev values and the directories made', async () => {
  const root = await makeRoot()
  const { code, seen } = await run(root, { PATH: BASE_PATH, XDG_DATA_HOME: '/xdg/data' })
  assert.equal(code, 0)
  assert.equal(seen?.DSH_HOME, join(root, '.dev', 'dsh'))
  assert.equal(seen?.DSH_DISH_HOME, join(root, '.dev'))
  assert.equal(seen?.DISH_ENV, 'dev')
  assert.equal(seen?.XDG_DATA_HOME, '/xdg/data', 'XDG_* is passed as it was, not set')
  assert.equal(seen?.PATH, `${join(root, 'node_modules', '.bin')}:${BASE_PATH}`)
  for (const name of DIRECTORIES) assert.equal(await mode(join(root, '.dev', name)), 0o700, name)
  assert.equal(await mode(join(root, '.dev')), 0o700)
})

test('main: DISH_ENV=dev and DISH_ENV= (empty) are dev too', async () => {
  for (const value of ['dev', '']) {
    const root = await makeRoot()
    const { code, seen } = await run(root, { PATH: BASE_PATH, DISH_ENV: value })
    assert.equal(code, 0)
    assert.equal(seen?.DISH_ENV, 'dev')
    assert.equal(seen?.DSH_HOME, join(root, '.dev', 'dsh'))
  }
})

test('main: an inherited DSH_HOME and DSH_DISH_HOME are replaced', async () => {
  const root = await makeRoot()
  const { code, seen } = await run(root, { PATH: BASE_PATH, DSH_HOME: '/home/real/.dsh', DSH_DISH_HOME: '/elsewhere' })
  assert.equal(code, 0)
  assert.equal(seen?.DSH_HOME, join(root, '.dev', 'dsh'))
  assert.equal(seen?.DSH_DISH_HOME, join(root, '.dev'))
})

test('main: DISH_ENV=prod passes the inherited environment through and makes no .dev', async () => {
  const root = await makeRoot()
  const { code, seen } = await run(root, { PATH: BASE_PATH, DISH_ENV: 'prod', DSH_HOME: '/home/real/.dsh', XDG_DATA_HOME: '/xdg/data' })
  assert.equal(code, 0)
  assert.equal(seen?.DSH_HOME, '/home/real/.dsh')
  assert.equal(seen?.DSH_DISH_HOME, undefined)
  assert.equal(seen?.DISH_ENV, 'prod')
  assert.equal(seen?.XDG_DATA_HOME, '/xdg/data')
  assert.equal(seen?.PATH, `${join(root, 'node_modules', '.bin')}:${BASE_PATH}`)
  assert.equal(await exists(join(root, '.dev')), false)
})

test('main: a bad DISH_ENV returns 2 on one stderr line, never runs the command and makes no .dev', async () => {
  const root = await makeRoot()
  const marker = join(root, 'ran')
  const lines: string[] = []
  const write = process.stderr.write
  process.stderr.write = ((chunk: string | Uint8Array) => {
    lines.push(String(chunk))
    return true
  }) as typeof process.stderr.write
  let code: number
  try {
    code = await main([process.execPath, '-e', `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x")`], {
      root,
      env: { PATH: BASE_PATH, DISH_ENV: 'staging' },
    })
  } finally {
    process.stderr.write = write
  }
  assert.equal(code, 2)
  assert.equal(lines.join(''), 'env: DISH_ENV must be dev or prod (unset means dev), not "staging"\n')
  assert.equal(await exists(marker), false, 'the command did not run')
  assert.equal(await exists(join(root, '.dev')), false)
})

test('main: no command returns 2, and makes no .dev', async () => {
  const root = await makeRoot()
  assert.equal(await main([], { root, env: { PATH: BASE_PATH } }), 2)
  assert.equal(await exists(join(root, '.dev')), false)
})

test('main: returns the command\'s exit code', async () => {
  const root = await makeRoot()
  assert.equal(await main([process.execPath, '-e', 'process.exit(7)'], { root, env: { PATH: BASE_PATH } }), 7)
  assert.equal(await main([process.execPath, '-e', 'process.exit(0)'], { root, env: { PATH: BASE_PATH } }), 0)
})

test('main: a command killed by a signal gives 128 plus the signal number', async () => {
  const root = await makeRoot()
  const code = await main([process.execPath, '-e', 'process.kill(process.pid, "SIGTERM"); setTimeout(() => {}, 5000)'], {
    root,
    env: { PATH: BASE_PATH },
  })
  assert.equal(code, 128 + 15)
})

test('main: a command that cannot be started gives 127', async () => {
  const root = await makeRoot()
  const code = await main(['dish-no-such-command-anywhere'], { root, env: { PATH: BASE_PATH, DISH_ENV: 'prod' } })
  assert.equal(code, 127)
})

test('main: finds a bare command in the checkout\'s node_modules/.bin, in dev and in prod', async () => {
  for (const DISH_ENV of ['dev', 'prod']) {
    const root = await makeRoot()
    const bin = join(root, 'node_modules', '.bin')
    await mkdir(bin, { recursive: true })
    const tool = join(bin, 'dish-test-tool')
    await writeFile(tool, `#!/bin/sh\nprintf %s "$DISH_ENV" > "$1"\n`)
    await chmod(tool, 0o755)
    const out = join(root, 'tool-ran')
    const code = await main(['dish-test-tool', out], { root, env: { PATH: BASE_PATH, DISH_ENV } })
    assert.equal(code, 0, DISH_ENV)
    assert.equal(await readFile(out, 'utf8'), DISH_ENV)
  }
})

test('the CLI forwards SIGTERM to the command, and the exit code the command chose comes back', async () => {
  // Prod, so the launcher makes no .dev. The command answers the signal with its own exit code, to prove it got one.
  const child = spawn(process.execPath, [CLI, process.execPath, '-e',
    'process.on("SIGTERM", () => process.exit(5)); console.log("ready"); setInterval(() => {}, 1000)'], {
    env: { PATH: process.env.PATH ?? BASE_PATH, DISH_ENV: 'prod' },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  await new Promise<void>((resolve, reject) => {
    child.on('error', reject)
    child.stdout.on('data', chunk => {
      if (String(chunk).includes('ready')) resolve()
    })
  })
  child.kill('SIGTERM')
  const code = await new Promise<number | null>(resolve => child.on('close', resolve))
  assert.equal(code, 5, 'the command got the signal, and its own exit code came back')
})

test('package.json: pnpm dsh goes through the launcher, and no script runs dsh web', async () => {
  const pkg = JSON.parse(await readFile(join(REPO, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
  assert.equal(pkg.scripts.dsh, 'node scripts/env.ts dsh')
  assert.equal(pkg.scripts.web, undefined, 'no script named web')
  for (const [name, command] of Object.entries(pkg.scripts)) {
    assert.ok(!/\bdsh web\b/.test(command), `${name} must not run dsh web`)
  }
  assert.ok(pkg.scripts.test!.includes('scripts/test/*.test.ts'), 'pnpm test runs the launcher\'s tests')
})
