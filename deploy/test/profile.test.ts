/**
 * The profile writer (`deploy/profile.ts`): the rows it writes into a dsh profile's patch file, what it leaves alone,
 * that a second run is a no-op, and how it refuses a file it cannot trust. The CLI runs as a subprocess against files in
 * a temp directory; nothing here touches a real dsh home or XDG directory.
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { writeDishRows } from '../profile.ts'
import type { DishRowsOptions } from '../profile.ts'

const CLI = fileURLToPath(new URL('../profile.ts', import.meta.url))

const OPTIONS: DishRowsOptions = {
  remote: 'git@github-dish-config:example/store.git',
  userName: 'Test User',
  userEmail: 'test@example.invalid',
}

/** What a profile with nothing of dish's gets. */
const DISH_ROWS = `- id: dish-config
  name: dish-config
  config:
    remote: git@github-dish-config:example/store.git
    userName: Test User
    userEmail: test@example.invalid
- id: agent-preset-registry
  name: "@deepseek-ai/dsh-agent-preset-registry"
  config:
    default: standard
    selectedDefault: dish
`

/** The comment dsh puts at the top of a profile's patch file. */
const HEADER = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
`

/** The shape of a real profile's file after use: dsh's own rows, with fake values, comments and \`!!js\` tags. */
const DSH_ROWS = `- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      fake-provider:
        models:
          - id: fake-model-a
          - id: fake-model-b
- id: ui-settings-general
  name: "@deepseek-ai/dsh-client-ui-settings-general"
  config:
    welcomeNoticeVersion: 2000-01-01.1
# the default model, chosen in Settings
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: fake-provider
    model: !!js "process.env.FAKE_MODEL ?? 'fake-model-a'" # from the environment
    reasoningEffort: high
    notes: !!js |
      first line
      second line
`

const FIXTURE = HEADER + DSH_ROWS

let dir: string
let counter = 0

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dish-profile-test-'))
})
after(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** A fresh path in the temp directory, holding `content` when given. */
async function patchFile(content?: string, mode?: number): Promise<string> {
  const path = join(dir, `case-${counter++}`, 'cordis.patch.yml')
  await mkdir(join(path, '..'))
  if (content !== undefined) await writeFile(path, content, { mode })
  return path
}

interface Run { code: number, stdout: string, stderr: string }

function run(args: string[]): Promise<Run> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1
      resolve({ code, stdout, stderr })
    })
  })
}

function cli(path: string, extra: string[] = []): Promise<Run> {
  return run([
    '--patch', path, '--remote', OPTIONS.remote, '--user-name', OPTIONS.userName, '--user-email', OPTIONS.userEmail,
    ...extra,
  ])
}

/** The rows of a patch file, with `!!js` read as the string it holds. */
function rows(text: string): Array<Record<string, any>> {
  return parse(text, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] })
}

test('an empty file gets the two rows', () => {
  assert.equal(writeDishRows('', OPTIONS), DISH_ROWS)
  assert.equal(writeDishRows('\n', OPTIONS), DISH_ROWS)
  assert.equal(writeDishRows('---\n', OPTIONS), '---\n' + DISH_ROWS)
})

test('a file with only comments, or only an empty list, keeps its comments', () => {
  assert.equal(writeDishRows(HEADER, OPTIONS), HEADER + '\n' + DISH_ROWS)
  assert.equal(writeDishRows(HEADER + '[]\n', OPTIONS), HEADER + DISH_ROWS)
})

test('a missing file is created with mode 0600', async () => {
  const path = await patchFile()
  const result = await cli(path)
  assert.deepEqual({ code: result.code, stdout: result.stdout.trim() }, { code: 0, stdout: 'updated' })
  assert.equal(await readFile(path, 'utf8'), DISH_ROWS)
  assert.equal((await stat(path)).mode & 0o777, 0o600)
  assert.deepEqual(await readdir(join(path, '..')), ['cordis.patch.yml'], 'no temp file is left behind')
})

test('dsh\'s own rows, comments and !!js tags are kept byte for byte; the dish rows go at the end', () => {
  const out = writeDishRows(FIXTURE, OPTIONS)
  assert.equal(out, FIXTURE + DISH_ROWS)
  const parsed = rows(out)
  assert.deepEqual(parsed.map((row) => row.id), [
    'llm-pi-ai', 'ui-settings-general', 'agent-default-model', 'dish-config', 'agent-preset-registry',
  ])
  assert.ok(out.includes(`model: !!js "process.env.FAKE_MODEL ?? 'fake-model-a'" # from the environment\n`))
  assert.ok(out.includes('notes: !!js |\n      first line\n      second line\n'))
})

test('rows in the middle of the file: only their own lines change', () => {
  const input = HEADER + `- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers: {}
- id: dish-config
  name: dish-config
  config:
    # the store
    remote: git@old.example.invalid:someone/old.git
    terminal: false # kept
# between rows
- id: agent-preset-registry
  name: "@deepseek-ai/dsh-agent-preset-registry"
  config:
    default: custom-preset
    selectedDefault: standard
- id: ui-settings-general
  name: "@deepseek-ai/dsh-client-ui-settings-general"
  config:
    welcomeNoticeVersion: 2000-01-01.1
`
  const expected = HEADER + `- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers: {}
- id: dish-config
  name: dish-config
  config:
    # the store
    remote: git@github-dish-config:example/store.git
    terminal: false # kept
    userName: Test User
    userEmail: test@example.invalid
# between rows
- id: agent-preset-registry
  name: "@deepseek-ai/dsh-agent-preset-registry"
  config:
    default: custom-preset
    selectedDefault: dish
- id: ui-settings-general
  name: "@deepseek-ai/dsh-client-ui-settings-general"
  config:
    welcomeNoticeVersion: 2000-01-01.1
`
  assert.equal(writeDishRows(input, OPTIONS), expected)
})

test('an existing dish-config row keeps its other keys; only remote, userName and userEmail are written', () => {
  const input = `- id: dish-config
  name: dish-config
  config:
    terminal: false
    agentName: Fake Agent
    userName: Someone Else
`
  const out = rows(writeDishRows(input, OPTIONS))
  assert.deepEqual(out[0], {
    id: 'dish-config',
    name: 'dish-config',
    config: {
      terminal: false,
      agentName: 'Fake Agent',
      userName: 'Test User',
      remote: OPTIONS.remote,
      userEmail: OPTIONS.userEmail,
    },
  })
  assert.equal(out.length, 2, 'the preset row is added after it')
})

test('a dish-config row without a config, or with an empty one, gets the three keys', () => {
  for (const config of ['', '  config:\n', '  config: {}\n']) {
    const out = rows(writeDishRows(`- id: dish-config\n  name: dish-config\n${config}`, OPTIONS))
    assert.deepEqual(out[0].config, { remote: OPTIONS.remote, userName: OPTIONS.userName, userEmail: OPTIONS.userEmail })
  }
})

test('a quoted value stays quoted; one that needs quoting is quoted', () => {
  const input = `- id: dish-config\n  name: dish-config\n  config:\n    remote: "git@old.example.invalid:a/b.git"\n`
  const out = writeDishRows(input, { ...OPTIONS, userName: 'Test: User #1', userEmail: 'a@b.invalid' })
  assert.ok(out.includes('    remote: "git@github-dish-config:example/store.git"\n'), out)
  assert.ok(out.includes('    userName: "Test: User #1"\n'), out)
  assert.equal(rows(out)[0].config.userName, 'Test: User #1')
})

test('a !!js expression where a value is written is replaced by the plain value, not kept with its tag', () => {
  const input = `- id: dish-config\n  name: dish-config\n  config:\n    remote: !!js "process.env.FAKE_REMOTE"\n    userName: Test User\n`
  const out = writeDishRows(input, OPTIONS)
  assert.ok(out.includes('    remote: git@github-dish-config:example/store.git\n'), out)
  assert.ok(!out.includes('FAKE_REMOTE') && !out.includes('!!js'), out)
})

test('an existing preset row keeps its default, and only selectedDefault changes', () => {
  const input = `- id: agent-preset-registry
  name: "@deepseek-ai/dsh-agent-preset-registry"
  config:
    default: custom-preset
    selectedDefault: standard
`
  const out = writeDishRows(input, OPTIONS)
  assert.deepEqual(rows(out)[0], {
    id: 'agent-preset-registry',
    name: '@deepseek-ai/dsh-agent-preset-registry',
    config: { default: 'custom-preset', selectedDefault: 'dish' },
  })
  const dishConfigRow = DISH_ROWS.slice(0, DISH_ROWS.indexOf('- id: agent-preset-registry'))
  assert.equal(out, input.replace('selectedDefault: standard', 'selectedDefault: dish') + dishConfigRow)
})

test('a preset row with no default is given standard, and a !!js default is kept', () => {
  const none = `- id: agent-preset-registry\n  name: "@deepseek-ai/dsh-agent-preset-registry"\n  config:\n    selectedDefault: standard\n`
  assert.deepEqual(rows(writeDishRows(none, OPTIONS)).find((row) => row.id === 'agent-preset-registry')?.config, {
    default: 'standard', selectedDefault: 'dish',
  })
  const bare = `- id: agent-preset-registry\n  name: "@deepseek-ai/dsh-agent-preset-registry"\n`
  assert.deepEqual(rows(writeDishRows(bare, OPTIONS)).find((row) => row.id === 'agent-preset-registry')?.config, {
    default: 'standard', selectedDefault: 'dish',
  })
  const js = `- id: agent-preset-registry
  name: "@deepseek-ai/dsh-agent-preset-registry"
  config:
    default: !!js "process.env.FAKE_PRESET ?? 'standard'"
    selectedDefault: dish
- id: dish-config
  name: dish-config
  config:
    remote: git@github-dish-config:example/store.git
    userName: Test User
    userEmail: test@example.invalid
`
  assert.equal(writeDishRows(js, OPTIONS), js, 'already right: untouched')
})

test('the preset is an option', () => {
  const out = rows(writeDishRows('', { ...OPTIONS, preset: 'other' }))
  assert.equal(out[1].config.selectedDefault, 'other')
})

test('rows are matched as dsh\'s config editor matches them: the last one, never an insert, only by name', () => {
  const input = `- id: dish-config
  name: dish-config
  config:
    remote: first
- insert:
    - id: dish-config
      name: dish-config
- id: dish-config
  name: some-other-plugin
  config:
    remote: other plugin
- id: dish-config
  name: dish-config
  config:
    remote: last
`
  const out = rows(writeDishRows(input, OPTIONS))
  assert.equal(out[0].config.remote, 'first', 'an earlier row is left')
  assert.equal(out[2].config.remote, 'other plugin', 'a row for a different name is left')
  assert.equal(out[3].config.remote, OPTIONS.remote)
  assert.equal(out.length, 5)
})

test('a flow-style list is accepted', () => {
  const out = rows(writeDishRows('[{id: a, config: {x: 1}}]\n', OPTIONS))
  assert.deepEqual(out.map((row) => row.id), ['a', 'dish-config', 'agent-preset-registry'])
  assert.deepEqual(out[0], { id: 'a', config: { x: 1 } })
})

test('a second run changes nothing: the same text back, and no write', async () => {
  for (const input of ['', HEADER, FIXTURE]) {
    const once = writeDishRows(input, OPTIONS)
    assert.equal(writeDishRows(once, OPTIONS), once)
  }
  const path = await patchFile(FIXTURE)
  assert.equal((await cli(path)).stdout.trim(), 'updated')
  const past = new Date(Date.now() - 3_600_000)
  await utimes(path, past, past)
  const before = await stat(path)
  const second = await cli(path)
  assert.deepEqual({ code: second.code, stdout: second.stdout.trim() }, { code: 0, stdout: 'unchanged' })
  const afterStat = await stat(path)
  assert.equal(afterStat.ino, before.ino, 'not replaced')
  assert.equal(afterStat.mtimeMs, before.mtimeMs, 'not written')
  assert.equal(await readFile(path, 'utf8'), FIXTURE + DISH_ROWS)
})

test('a file that already matches is left alone even when it is not in dsh\'s style', async () => {
  const text = `# hand written
-   id: dish-config
    name: dish-config
    config:
        remote:   "git@github-dish-config:example/store.git"
        userName: 'Test User'
        userEmail: test@example.invalid
-   {id: agent-preset-registry, name: "@deepseek-ai/dsh-agent-preset-registry", config: {default: standard, selectedDefault: dish}}
`
  assert.equal(writeDishRows(text, OPTIONS), text)
})

test('an existing file is replaced with mode 0600', async () => {
  const path = await patchFile(HEADER, 0o644)
  await chmod(path, 0o644)
  assert.equal((await cli(path)).stdout.trim(), 'updated')
  assert.equal((await stat(path)).mode & 0o777, 0o600)
  assert.equal(await readFile(path, 'utf8'), HEADER + '\n' + DISH_ROWS)
  assert.deepEqual(await readdir(join(path, '..')), ['cordis.patch.yml'])
})

test('the CLI takes --preset', async () => {
  const path = await patchFile()
  assert.equal((await cli(path, ['--preset', 'other'])).code, 0)
  assert.equal(rows(await readFile(path, 'utf8'))[1].config.selectedDefault, 'other')
})

test('a file that is not valid YAML, or not a list of rows, is refused and left as it is', async () => {
  const bad = new Map([
    ['syntax', '- id: a\n  config: [unclosed\n'],
    ['duplicate key', '- id: a\n  id: b\n'],
    ['two documents', '- id: a\n---\n- id: b\n'],
    ['a mapping', 'id: a\nconfig: {}\n'],
    ['a scalar', 'just text\n'],
    ['dish-config config is not a mapping', '- id: dish-config\n  name: dish-config\n  config: just text\n'],
    ['preset config is not a mapping', '- id: agent-preset-registry\n  config: [a, b]\n'],
  ])
  for (const [why, content] of bad) {
    assert.throws(() => writeDishRows(content, OPTIONS), Error, why)
    const path = await patchFile(content)
    const past = new Date(Date.now() - 3_600_000)
    await utimes(path, past, past)
    const before = await stat(path)
    const result = await cli(path)
    assert.equal(result.code, 1, why)
    assert.equal(result.stdout, '', why)
    assert.match(result.stderr, /profile\.ts: /, why)
    assert.equal(await readFile(path, 'utf8'), content, why)
    assert.equal((await stat(path)).mtimeMs, before.mtimeMs, why)
    assert.deepEqual(await readdir(join(path, '..')), ['cordis.patch.yml'], why)
  }
})

test('a path that cannot be read as a file is refused', async () => {
  const asDirectory = await patchFile()
  await mkdir(asDirectory)
  const result = await cli(asDirectory)
  assert.equal(result.code, 1)
  assert.match(result.stderr, /profile\.ts: /)

  const missingParent = join(dir, 'no-such-directory', 'cordis.patch.yml')
  assert.equal((await cli(missingParent)).code, 1)
  await assert.rejects(stat(join(dir, 'no-such-directory')), { code: 'ENOENT' }, 'its parents are not created')
})

test('wrong arguments exit 2 and write nothing', async () => {
  const path = await patchFile()
  const full = ['--patch', path, '--remote', OPTIONS.remote, '--user-name', OPTIONS.userName, '--user-email', OPTIONS.userEmail]
  const without = (flag: string): string[] => {
    const at = full.indexOf(flag)
    return [...full.slice(0, at), ...full.slice(at + 2)]
  }
  const cases = new Map<string, string[]>([
    ['no arguments', []],
    ['no --patch', without('--patch')],
    ['no --remote', without('--remote')],
    ['no --user-name', without('--user-name')],
    ['no --user-email', without('--user-email')],
    ['an empty --remote', [...without('--remote'), '--remote', '']],
    ['a multi-line --user-name', [...without('--user-name'), '--user-name', 'two\nlines']],
    ['an empty --preset', [...full, '--preset', '']],
    ['an unknown option', [...full, '--force']],
    ['a stray argument', [...full, 'extra']],
  ])
  for (const [why, args] of cases) {
    const result = await run(args)
    assert.equal(result.code, 2, why)
    assert.match(result.stderr, /usage: node deploy\/profile\.ts/, why)
    assert.equal(result.stdout, '', why)
  }
  await assert.rejects(stat(path), { code: 'ENOENT' }, 'nothing was created')
})

test('options that cannot be written as one line are refused by the library too', () => {
  assert.throws(() => writeDishRows('', { ...OPTIONS, remote: '' }), /remote/)
  assert.throws(() => writeDishRows('', { ...OPTIONS, userName: 'a\nb' }), /userName/)
  assert.throws(() => writeDishRows('', { ...OPTIONS, userEmail: '  ' }), /userEmail/)
  assert.throws(() => writeDishRows('', { ...OPTIONS, preset: '' }), /preset/)
})
