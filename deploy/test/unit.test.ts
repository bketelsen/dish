/**
 * `deploy/dish-web.service`, read as data. The unit is the one place that decides what the VM's service is, so these
 * checks pin the properties that make it prod and keep dev's and the install's settings out of agent shells:
 *
 * - It runs the checkout's dsh binary, in `~/work`, never `pnpm` or the root scripts' launcher (which defaults to dev).
 * - It sets exactly one environment variable (`PATH`) and loads exactly one file (`deploy.env`, which holds only
 *   `DISH_TRUSTED_HOST`). dsh passes its environment on to every agent shell, so anything the unit sets reaches agents.
 * - It has no sandboxing options, which would be inherited by the shells dsh starts under bubblewrap or Landlock.
 *
 * Nothing here runs the unit or touches systemd.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const UNIT = fileURLToPath(new URL('../dish-web.service', import.meta.url))

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
    const key = line.slice(0, eq)
    const value = line.slice(eq + 1)
    ;((sections[section] ??= {})[key] ??= []).push(value)
  }
  return { sections, lines }
}

const text = readFileSync(UNIT, 'utf8')
const { sections, lines } = parseUnit(text)
const service = sections.Service ?? {}

test('the service runs in ~/work, which update.sh creates', () => {
  assert.deepEqual(service.WorkingDirectory, ['%h/work'])
})

test('ExecStart is the checkout\'s dsh binary, with --trusted-host as the last option', () => {
  const exec = '%h/dish/node_modules/.bin/dsh web --host 127.0.0.1 --port 3080 --no-open --trusted-host ${DISH_TRUSTED_HOST}'
  assert.deepEqual(service.ExecStart, [exec])
  // --trusted-host takes any number of values, so nothing may follow it but its one value.
  const words = exec.split(' ')
  const options = words.filter((word) => word.startsWith('--'))
  assert.equal(options.at(-1), '--trusted-host')
  assert.equal(words.at(-2), '--trusted-host')
  assert.equal(words.at(-1), '${DISH_TRUSTED_HOST}')
})

test('the unit never goes through pnpm, env or the launcher', () => {
  const [exec] = service.ExecStart ?? []
  assert.ok(exec !== undefined && exec.startsWith('%h/dish/node_modules/.bin/dsh '), 'ExecStart starts with the binary')
  for (const line of lines) {
    assert.doesNotMatch(line, /\bpnpm\b/, `a unit line mentions pnpm: ${line}`)
    assert.doesNotMatch(line, /\/usr\/bin\/env\b/, `a unit line goes through env: ${line}`)
    assert.doesNotMatch(line, /scripts\/env\.ts/, `a unit line names the launcher: ${line}`)
  }
})

test('Environment is exactly one entry, PATH', () => {
  assert.deepEqual(service.Environment, ['PATH=/opt/dish/node/bin:/usr/local/bin:/usr/bin:/bin'])
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
  const forbidden = [
    'PrivateUsers',
    'SystemCallFilter',
    'MemoryDenyWriteExecute',
    'ProtectSystem',
    'ProtectHome',
    'RestrictNamespaces',
    // It would also stop sudo in escalated agent commands.
    'NoNewPrivileges',
  ]
  for (const line of lines) {
    for (const name of forbidden) {
      assert.ok(!line.startsWith(`${name}=`), `a unit line sets ${name}: ${line}`)
    }
  }
})

test('the sections are exactly Unit, Service and Install', () => {
  assert.deepEqual(Object.keys(sections), ['Unit', 'Service', 'Install'])
})
