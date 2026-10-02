/**
 * `deploy/url.sh`, run against a throwaway "host" in a temp directory: a copy of the script in `<dir>/dish/deploy`, a
 * `HOME` under `<dir>`, and stub `id`, `getent`, `systemctl`, `journalctl` and `stat` first on PATH. The stubs answer from
 * files the test writes and log their arguments, so nothing here reads a real journal, asks a real systemd, or touches
 * a real account. It does not use Task 5's fake host (`host.ts`): the two tasks are written in parallel.
 *
 * Every run goes through `run`, which holds the two properties that matter most, whatever the case: stdout is empty or
 * exactly one line, and the token is on no stream but stdout. The journal the stubs serve always holds the token.
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const URL_SH = join(ROOT, 'deploy', 'url.sh')
const execFileAsync = promisify(execFile)

const UID = '4242'
const HOST = 'dish.example-tailnet.ts.net'
const STARTED = 'Fri 2026-10-02 10:15:30 UTC'
/** What the journal holds. It's looked for on stderr, so it must never be a substring of a word the script says. */
const TOKEN = 'Zq9-SECRETsecret_0123456789'
const OLD_TOKEN = 'Aa1-OLDold_9876543210'
/** The checkout's owner as the stat stub reports it; the account the script must ask getent and systemctl about. */
const OWNER = 'dish'

/** `systemctl show` for a service that's running. */
const SHOW_RUNNING = `MainPID=4321\nExecMainStartTimestamp=${STARTED}\n`

const scratches: string[] = []
after(async () => {
  await Promise.all(scratches.map((dir) => rm(dir, { recursive: true, force: true })))
})

/** Stubs: each logs its arguments, one per line, calls ended by an ASCII record separator line. */
const STUBS: Record<string, string> = {
  // `id -u` is what the script asks; the test says what it answers.
  id: `
if [ "$1" = -u ]; then cat "$DISH_TEST_DIR/state/uid"; exit 0; fi
echo "unexpected id call" >&2; exit 99
`,
  getent: `
if [ "$1" = passwd ] && [ "$#" -eq 2 ]; then
  if [ -f "$DISH_TEST_DIR/state/getent-fails" ]; then exit 2; fi
  printf '%s:x:${UID}:${UID}::%s:/bin/bash\\n' "$2" "$DISH_TEST_DIR/home"
  exit 0
fi
echo "unexpected getent call" >&2; exit 99
`,
  systemctl: `
if [ -f "$DISH_TEST_DIR/state/systemctl-fails" ]; then echo "Failed to connect to bus" >&2; exit 1; fi
cat "$DISH_TEST_DIR/state/show"
`,
  journalctl: `
if [ -f "$DISH_TEST_DIR/state/journalctl-fails" ]; then echo "journalctl: no access" >&2; exit 1; fi
cat "$DISH_TEST_DIR/state/journal"
`,
  // The owner of the checkout is a fixed name, whoever runs the tests (so the suite passes as root too), and the name
  // the test file says if it changes it. Any other path has another owner, so a script that looks at the wrong
  // directory, such as a symlink's, gets the wrong account.
  stat: `
if [ "$1" = -c ] && [ "$2" = %U ] && [ "$3" = -- ] && [ "$#" -eq 4 ]; then
  if [ "$4" = "$(cat "$DISH_TEST_DIR/state/checkout")" ]; then cat "$DISH_TEST_DIR/state/owner"; else echo not-the-checkout-owner; fi
  exit 0
fi
echo "unexpected stat call" >&2; exit 99
`,
}

interface Host {
  dir: string
  home: string
  script: string
  /** Each stub's calls, as lists of arguments. */
  calls(name: string): string[][]
  /** Replace what a stub answers. */
  state(name: string, content: string | null): Promise<void>
  /** deploy.env, or no file at all. */
  deployEnv(content: string | null): Promise<void>
}

/** A host where the service is running and has printed its sign-in line, and fleet wrote deploy.env. */
async function makeHost(): Promise<Host> {
  const dir = await mkdtemp(join(tmpdir(), 'dish-url-test-'))
  scratches.push(dir)
  const home = join(dir, 'home')
  const stubs = join(dir, 'stubs')
  const calls = join(dir, 'calls')
  const checkoutDeploy = join(dir, 'dish', 'deploy')
  await Promise.all([home, join(home, '.config', 'dish'), stubs, calls, checkoutDeploy, join(dir, 'state')].map((path) => mkdir(path, { recursive: true })))
  const script = join(checkoutDeploy, 'url.sh')
  await copyFile(URL_SH, script)
  await chmod(script, 0o755)
  for (const [name, body] of Object.entries(STUBS)) {
    const path = join(stubs, name)
    const log = `{ printf '%s\\n' "$@"; printf '\\036\\n'; } >> "$DISH_TEST_DIR/calls/${name}.log"\n`
    await writeFile(path, `#!/usr/bin/env bash\n${log}${body}`)
    await chmod(path, 0o755)
  }
  const host: Host = {
    dir,
    home,
    script,
    calls(name) {
      const path = join(calls, `${name}.log`)
      if (!existsSync(path)) return []
      return readFileSync(path, 'utf8')
        .split('\x1e\n')
        .filter((record, index, all) => index < all.length - 1 || record !== '')
        .map((record) => record.replace(/\n$/, '').split('\n'))
    },
    async state(name, content) {
      const path = join(dir, 'state', name)
      if (content === null) await rm(path, { force: true })
      else await writeFile(path, content)
    },
    async deployEnv(content) {
      const path = join(home, '.config', 'dish', 'deploy.env')
      if (content === null) await rm(path, { force: true })
      else await writeFile(path, content)
    },
  }
  await host.state('uid', '0\n')
  await host.state('owner', `${OWNER}\n`)
  await host.state('checkout', await realpath(join(dir, 'dish')))
  await host.state('show', SHOW_RUNNING)
  await host.state('journal', `systemd: starting\ndsh web: http://127.0.0.1:3080/?token=${TOKEN}\nsome later line\n`)
  await host.deployEnv(`DISH_TRUSTED_HOST=${HOST}\n`)
  return host
}

interface Result {
  code: number
  stdout: string
  stderr: string
}

/**
 * Run the script on the host, with only the stubs' directory and the real PATH in its environment. Whatever the case,
 * stdout is empty or exactly one line, and neither token is on stderr.
 */
async function run(host: Host, args: string[] = [], extraEnv: Record<string, string> = {}, script: string = host.script): Promise<Result> {
  const env = {
    PATH: `${join(host.dir, 'stubs')}:${process.env.PATH ?? '/usr/bin:/bin'}`,
    HOME: join(host.dir, 'rhome'),
    LANG: 'C.UTF-8',
    DISH_TEST_DIR: host.dir,
    ...extraEnv,
  }
  let result: Result
  try {
    const { stdout, stderr } = await execFileAsync(script, args, { env, encoding: 'utf8', timeout: 30_000 })
    result = { code: 0, stdout, stderr }
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: string; stderr?: string }
    result = { code: typeof failure.code === 'number' ? failure.code : -1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
  }
  for (const token of [TOKEN, OLD_TOKEN]) {
    assert.ok(!result.stderr.includes(token), `stderr has a token:\n${result.stderr}`)
  }
  if (result.stdout !== '') {
    assert.equal(result.stdout.split('\n').length, 2, `stdout is not exactly one line: ${JSON.stringify(result.stdout)}`)
    assert.ok(result.stdout.endsWith('\n'))
    assert.equal(result.code, 0, 'stdout has output but the exit is not 0')
  }
  return result
}

/** Nothing was asked of systemd or the journal. */
function assertNoQueries(host: Host): void {
  assert.deepEqual(host.calls('systemctl'), [])
  assert.deepEqual(host.calls('journalctl'), [])
}

test('prints the sign-in link: the host from deploy.env, the token from the journal since the current start', async () => {
  const host = await makeHost()
  const result = await run(host)
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.stdout, `https://${HOST}/?token=${TOKEN}\n`)
  assert.equal(result.stderr, '')

  // It asks the account's user manager, by the checkout owner's name, and the journal by the start it was told.
  assert.deepEqual(host.calls('getent'), [['passwd', OWNER]])
  assert.deepEqual(host.calls('systemctl'), [['--user', '-M', `${OWNER}@`, 'show', 'dish-web.service', '--property=MainPID', '--property=ExecMainStartTimestamp']])
  assert.deepEqual(host.calls('journalctl'), [[`_UID=${UID}`, '_SYSTEMD_USER_UNIT=dish-web.service', '--since', STARTED, '--no-pager', '-o', 'cat']])
})

test('the latest of two sign-in lines wins, and lines that are not dsh web sign-in lines never do', async () => {
  const host = await makeHost()
  await host.state(
    'journal',
    [
      'systemd: starting',
      `dsh web: http://127.0.0.1:3080/?token=${OLD_TOKEN}`,
      'dsh web: listening on 127.0.0.1:3080',
      `dsh web: http://127.0.0.1:3080/?token=${TOKEN}`,
      'dsh web: ready, no link on this line',
      `agent said: http://127.0.0.1:3080/?token=${OLD_TOKEN}`,
      ` dsh web: http://127.0.0.1:3080/?token=${OLD_TOKEN}`,
      'later line',
      '',
    ].join('\n'),
  )
  const result = await run(host)
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.stdout, `https://${HOST}/?token=${TOKEN}\n`)
})

test('a token after another query parameter is found, and only its own characters are taken', async () => {
  const host = await makeHost()
  await host.state('journal', `dsh web: http://127.0.0.1:3080/?next=%2F&token=${TOKEN} (open it)\n`)
  const result = await run(host)
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.stdout, `https://${HOST}/?token=${TOKEN}\n`)
})

test('a host with a port is kept; comments and other names in deploy.env are ignored', async () => {
  const host = await makeHost()
  await host.deployEnv(`# written by fleet\n\nOTHER=1\nDISH_TRUSTED_HOST=dish.example.ts.net:8443\n`)
  const result = await run(host)
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.stdout, `https://dish.example.ts.net:8443/?token=${TOKEN}\n`)
})

test('the service is not running: exit 1, saying so, and the journal is not read', async () => {
  const host = await makeHost()
  await host.state('show', `MainPID=0\nExecMainStartTimestamp=\n`)
  const result = await run(host)
  assert.equal(result.code, 1)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /dish-web\.service isn't running/)
  assert.deepEqual(host.calls('journalctl'), [])
})

test('a start with no timestamp, or a show with no MainPID, is exit 1 and the journal is not read', async () => {
  for (const show of [`MainPID=4321\nExecMainStartTimestamp=\n`, `MainPID=4321\n`, `ExecMainStartTimestamp=${STARTED}\n`, '']) {
    const host = await makeHost()
    await host.state('show', show)
    const result = await run(host)
    assert.equal(result.code, 1, JSON.stringify(show))
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /^url: /m)
    assert.deepEqual(host.calls('journalctl'), [], JSON.stringify(show))
  }
})

test("systemctl failing, or the journal not being readable, is exit 1 and says what it couldn't do", async () => {
  const host = await makeHost()
  await host.state('systemctl-fails', '')
  const first = await run(host)
  assert.equal(first.code, 1)
  assert.equal(first.stdout, '')
  assert.match(first.stderr, /user manager/)
  assert.deepEqual(host.calls('journalctl'), [])

  const other = await makeHost()
  await other.state('journalctl-fails', '')
  const second = await run(other)
  assert.equal(second.code, 1)
  assert.equal(second.stdout, '')
  assert.ok(second.stderr.includes(`can't read the journal of dish-web.service since ${STARTED}`), second.stderr)
})

test("a journal with no sign-in line since the start is exit 1, naming the start and saying to try again", async () => {
  for (const journal of ['', 'systemd: starting\nsome other line\n', 'dsh web: listening on 127.0.0.1:3080\n', 'dsh web: http://127.0.0.1:3080/?token=\n', 'dsh web: http://127.0.0.1:3080/?token=%%%\n']) {
    const host = await makeHost()
    await host.state('journal', journal)
    const result = await run(host)
    assert.equal(result.code, 1, JSON.stringify(journal))
    assert.equal(result.stdout, '')
    assert.ok(result.stderr.includes(`dsh hasn't printed its sign-in line since it started at ${STARTED}; try again in a few seconds`), result.stderr)
  }
})

test('the host: a missing file, a missing line, or a value that is not a bare host[:port] is exit 1, naming the file and fleet', async () => {
  const bad: Array<[string, string | null]> = [
    ['no file', null],
    ['empty file', ''],
    ['no such line', 'OTHER=1\n'],
    ['empty value', 'DISH_TRUSTED_HOST=\n'],
    ['a scheme', 'DISH_TRUSTED_HOST=https://dish.example.ts.net\n'],
    ['a path', 'DISH_TRUSTED_HOST=dish.example.ts.net/path\n'],
    ['a query', 'DISH_TRUSTED_HOST=dish.example.ts.net?x=1\n'],
    ['userinfo', 'DISH_TRUSTED_HOST=me@dish.example.ts.net\n'],
    ['a space', 'DISH_TRUSTED_HOST=dish.example.ts.net \n'],
    ['quotes', 'DISH_TRUSTED_HOST="dish.example.ts.net"\n'],
    ['a carriage return', 'DISH_TRUSTED_HOST=dish.example.ts.net\r\n'],
    ['a leading dot', 'DISH_TRUSTED_HOST=.dish.example.ts.net\n'],
    ['a trailing dash', 'DISH_TRUSTED_HOST=dish-\n'],
    ['upper case', 'DISH_TRUSTED_HOST=Dish.Example.ts.net\n'],
    ['a port that is not a number', 'DISH_TRUSTED_HOST=dish.example.ts.net:http\n'],
    ['an empty port', 'DISH_TRUSTED_HOST=dish.example.ts.net:\n'],
    ['two ports', 'DISH_TRUSTED_HOST=dish.example.ts.net:1:2\n'],
    ['the name twice', 'DISH_TRUSTED_HOST=a.example\nDISH_TRUSTED_HOST=b.example\n'],
    ['an indented line', '  DISH_TRUSTED_HOST=dish.example.ts.net\n'],
  ]
  for (const [label, content] of bad) {
    const host = await makeHost()
    await host.deployEnv(content)
    const result = await run(host)
    assert.equal(result.code, 1, label)
    assert.equal(result.stdout, '', label)
    assert.ok(result.stderr.includes(join(host.home, '.config', 'dish', 'deploy.env')), `${label}: ${result.stderr}`)
    assert.match(result.stderr, /fleet/i, label)
    // A bad host stops it before it asks about the service or reads the journal.
    assertNoQueries(host)
  }
})

test('the host: a single-label name and a hyphenated one are fine', async () => {
  for (const name of ['dish', 'a', 'dish-1.tail-net.ts.net', '127.0.0.1:3080']) {
    const host = await makeHost()
    await host.deployEnv(`DISH_TRUSTED_HOST=${name}\n`)
    const result = await run(host)
    assert.equal(result.code, 0, `${name}: ${result.stderr}`)
    assert.equal(result.stdout, `https://${name}/?token=${TOKEN}\n`)
  }
})

test('not root: exit 2, and nothing is asked of getent, systemctl or the journal', async () => {
  const host = await makeHost()
  await host.state('uid', '1000\n')
  const result = await run(host)
  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /run url\.sh as root \(incus exec gives root\)/)
  assert.deepEqual(host.calls('getent'), [])
  assertNoQueries(host)
})

test('any argument is exit 2, root or not, and nothing is asked', async () => {
  for (const args of [['--help'], ['-h'], ['x'], [''], ['a', 'b'], ['--', 'x']]) {
    const host = await makeHost()
    const result = await run(host, args)
    assert.equal(result.code, 2, JSON.stringify(args))
    assert.equal(result.stdout, '', JSON.stringify(args))
    assert.match(result.stderr, /^url: /m)
    assert.deepEqual(host.calls('getent'), [])
    assertNoQueries(host)
  }
  const host = await makeHost()
  await host.state('uid', '1000\n')
  const result = await run(host, ['x'])
  assert.equal(result.code, 2)
})

test("a checkout owned by root is refused, and an account that can't be looked up is exit 1", async () => {
  const rootOwned = await makeHost()
  await rootOwned.state('owner', 'root\n')
  const first = await run(rootOwned)
  assert.equal(first.code, 1)
  assert.equal(first.stdout, '')
  assert.match(first.stderr, /owned by root/)
  assertNoQueries(rootOwned)

  const unknown = await makeHost()
  await unknown.state('getent-fails', '')
  const second = await run(unknown)
  assert.equal(second.code, 1)
  assert.equal(second.stdout, '')
  assert.match(second.stderr, new RegExp(`account ${OWNER}`))
  assertNoQueries(unknown)
})

test('no leaks: a shell trace in the environment does not put the token on stderr', async () => {
  const host = await makeHost()
  const result = await run(host, [], { SHELLOPTS: 'xtrace' })
  // The stubs are bash scripts and trace too, but the token only ever travels in the script's own variables.
  assert.equal(result.code, 0)
  assert.equal(result.stdout, `https://${HOST}/?token=${TOKEN}\n`)
})

test('it never writes: the host holds the same files after a run as before', async () => {
  const host = await makeHost()
  const before = await readFile(join(host.home, '.config', 'dish', 'deploy.env'), 'utf8')
  const result = await run(host)
  assert.equal(result.code, 0, result.stderr)
  assert.equal(await readFile(join(host.home, '.config', 'dish', 'deploy.env'), 'utf8'), before)
  assert.ok(!existsSync(join(host.home, '.local')), 'it made a state directory')
  assert.ok(!existsSync(join(host.home, 'work')), 'it made ~/work')
})

test('run through a symlink, it still finds the checkout it sits in, and so its owner', async () => {
  const host = await makeHost()
  const link = join(host.dir, 'elsewhere', 'link-to-url.sh')
  await mkdir(join(host.dir, 'elsewhere'), { recursive: true })
  await symlink(host.script, link)
  const result = await run(host, [], {}, link)
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.stdout, `https://${HOST}/?token=${TOKEN}\n`)
  assert.deepEqual(host.calls('getent'), [['passwd', OWNER]])
  assert.equal(host.calls('systemctl')[0]?.[2], `${OWNER}@`)
})

test('url.sh is committed executable', async () => {
  const { stdout } = await execFileAsync('git', ['ls-files', '-s', 'deploy/url.sh'], { cwd: ROOT, encoding: 'utf8' })
  assert.match(stdout, /^100755 /)
})
