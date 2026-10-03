/**
 * `deploy/dish-web.service`, read as data. The unit is the one place that decides what the VM's service is, so these
 * checks pin the properties that make it prod and keep dev's and the install's settings out of agent shells:
 *
 * - It runs dsh's own script in the checkout with the `PATH` line's Node, in `~/work`, never `pnpm`, the root scripts'
 *   launcher (which defaults to dev) or a `node_modules/.bin` shim (pnpm's for dsh sets a `NODE_PATH` into the
 *   checkout, which dsh would pass on to every agent shell).
 * - It sets exactly one environment variable (`PATH`) and loads exactly one file (`deploy.env`, which holds only
 *   `DISH_TRUSTED_HOST`). dsh passes its environment on to every agent shell, so anything the unit sets reaches agents.
 * - It has no sandboxing options, which would be inherited by the shells dsh starts under bubblewrap or Landlock.
 *
 * Nothing here runs the unit or touches systemd.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { relative } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { dshEntry } from '../../scripts/env.ts'

const UNIT = fileURLToPath(new URL('../dish-web.service', import.meta.url))
const REPO = fileURLToPath(new URL('../..', import.meta.url))

type Sections = Record<string, Record<string, string[]>>

/** The unit's sections and keys, comment lines and blank lines ignored, a repeated key collecting every value. */
function parseUnit(text: string): { sections: Sections; lines: string[] } {
  const sections: Sections = {}
  const lines: string[] = []
  let section = ''
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue
    lines.push(line)
    const header = /^\[([^\]]+)\]$/.exec(line)
    if (header) {
      section = header[1]!
      sections[section] ??= {}
      continue
    }
    const eq = line.indexOf('=')
    assert.ok(eq > 0 && section !== '', `a key line outside any section, or without "=": ${line}`)
    // systemd ignores white space around the "=", so a key written "Name = value" is the key "Name".
    const key = line.slice(0, eq).trim()
    const value = line.slice(eq + 1).trim()
    ;((sections[section] ??= {})[key] ??= []).push(value)
  }
  return { sections, lines }
}

/** Options that restrict the whole service. Every agent command is a child of it, so none may be set. */
const SANDBOXING = [
  'PrivateUsers',
  'SystemCallFilter',
  'MemoryDenyWriteExecute',
  'ProtectSystem',
  'ProtectHome',
  'RestrictNamespaces',
  // It would also stop sudo in escalated agent commands.
  'NoNewPrivileges',
]

/** The sandboxing options a unit sets, in any section. Compared by parsed key, so spacing around "=" cannot hide one. */
function sandboxingSet(sections: Sections): string[] {
  return SANDBOXING.filter((name) => Object.values(sections).some((keys) => name in keys))
}

const text = readFileSync(UNIT, 'utf8')
const { sections, lines } = parseUnit(text)
const service = sections.Service ?? {}

test('the service runs in ~/work, which update.sh creates', () => {
  assert.deepEqual(service.WorkingDirectory, ['%h/work'])
})

test('ExecStart is the checkout\'s dsh script run by the unit\'s Node, with --trusted-host as the last option', () => {
  const exec = '/opt/dish/node/bin/node %h/dish/node_modules/@deepseek-ai/dsh/lib/bin.js web --host 127.0.0.1 --port 3080 --no-open --trusted-host ${DISH_TRUSTED_HOST}'
  assert.deepEqual(service.ExecStart, [exec])
  // --trusted-host takes any number of values, so nothing may follow it but its one value.
  const words = exec.split(' ')
  const options = words.filter((word) => word.startsWith('--'))
  assert.equal(options.at(-1), '--trusted-host')
  assert.equal(words.at(-2), '--trusted-host')
  assert.equal(words.at(-1), '${DISH_TRUSTED_HOST}')
})

test('the Node is the PATH line\'s, and the script is the bin of the checkout\'s @deepseek-ai/dsh, as pnpm\'s shim would run it', async () => {
  const [node, script] = (service.ExecStart?.[0] ?? '').split(' ')
  const [first] = (service.Environment?.[0] ?? '').replace(/^PATH=/, '').split(':')
  assert.equal(node, `${first}/node`, 'the Node of the PATH line\'s first directory, which fleet links')
  // A dsh that moved its bin would leave the service with nothing to start: this fails first.
  const entry = await dshEntry(REPO)
  assert.ok(entry !== undefined, 'the checkout has dsh (pnpm install)')
  assert.equal(script, `%h/dish/${relative(REPO, entry)}`)
})

test('the unit never goes through pnpm, env, the launcher or a node_modules/.bin shim', () => {
  const [exec] = service.ExecStart ?? []
  assert.ok(exec !== undefined && exec.startsWith('/opt/dish/node/bin/node %h/dish/node_modules/@deepseek-ai/dsh/'), 'ExecStart is Node and dsh\'s script')
  for (const line of lines) {
    // pnpm's shims export a NODE_PATH that names the checkout, and the one for dsh would reach every agent shell.
    assert.doesNotMatch(line, /node_modules\/\.bin\//, `a unit line runs a shim: ${line}`)
    assert.doesNotMatch(line, /NODE_PATH/, `a unit line sets NODE_PATH: ${line}`)
    assert.doesNotMatch(line, /\bpnpm\b/, `a unit line mentions pnpm: ${line}`)
    assert.doesNotMatch(line, /\/usr\/bin\/env\b/, `a unit line goes through env: ${line}`)
    assert.doesNotMatch(line, /scripts\/env\.ts/, `a unit line names the launcher: ${line}`)
  }
})

test('Environment is exactly two entries, PATH and TMPDIR, and TMPDIR is made before each start', () => {
  assert.deepEqual(service.Environment, ['PATH=/opt/dish/node/bin:/usr/local/bin:/usr/bin:/bin', 'TMPDIR=%h/.cache/dish/tmp'])
  // Under ~/.cache/dish, which dish-sandbox protects: only then does it give sandboxed commands the machine's /tmp.
  assert.deepEqual(service.ExecStartPre, [
    '/usr/bin/mkdir -p -m 0700 %h/.cache/dish %h/.cache/dish/tmp',
    // dsh is stopped then: what has been untouched for 10 days goes, as systemd-tmpfiles ages /tmp. A failure doesn't stop the start.
    '-/usr/bin/find %h/.cache/dish/tmp -mindepth 1 -maxdepth 1 -mtime +10 -exec rm -rf -- {} +',
  ])
})

test('no line sets or mentions what dev, the install or the plugin manager use', () => {
  const names = ['DISH_ENV', 'DISH_REMOTE', 'DISH_USER_NAME', 'DISH_USER_EMAIL', 'install.env', 'XDG_', 'PNPM_HOME', 'DSH_']
  for (const line of lines) {
    for (const name of names) {
      assert.ok(!line.includes(name), `a unit line mentions ${name}: ${line}`)
    }
  }
})

test('the unit loads deploy.env and nothing else', () => {
  assert.deepEqual(service.EnvironmentFile, ['%h/.config/dish/deploy.env'])
})

test('restart and install keys', () => {
  assert.deepEqual(service.Restart, ['on-failure'])
  assert.deepEqual(service.RestartSec, ['5'])
  assert.deepEqual(sections.Install, { WantedBy: ['default.target'] })
})

test('there are no sandboxing options: every agent command is a child of this service', () => {
  assert.deepEqual(sandboxingSet(sections), [])
})

test('the checks see settings written with spaces around "=", as systemd reads them', () => {
  const spaced = text.replace('[Service]\n', '[Service]\nProtectHome = read-only\nEnvironment = FOO=bar\n')
  assert.notEqual(spaced, text, 'the test unit was not modified')
  const { sections: spacedSections } = parseUnit(spaced)
  assert.deepEqual(sandboxingSet(spacedSections), ['ProtectHome'])
  assert.deepEqual(spacedSections.Service?.ProtectHome, ['read-only'])
  assert.deepEqual(spacedSections.Service?.Environment, [
    'FOO=bar',
    'PATH=/opt/dish/node/bin:/usr/local/bin:/usr/bin:/bin',
    'TMPDIR=%h/.cache/dish/tmp',
  ])
})

test('the sections are exactly Unit, Service and Install', () => {
  assert.deepEqual(Object.keys(sections), ['Unit', 'Service', 'Install'])
})
