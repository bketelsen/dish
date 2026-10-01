import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JUDGE_SPEC, DEFAULT_SETTINGS, DEFAULT_TEXT, parseSettings } from '../src/settings.ts'
import type { JudgeSettings } from '../src/settings.ts'
import { render, shippedDocument, shippedWith } from './helpers.ts'

/** The problem `parseSettings` gives for `text`; fails the test if the text is accepted. */
function problemOf(text: string): string {
  const parsed = parseSettings(text)
  assert.equal(parsed.ok, false, 'expected the text to be refused')
  return parsed.ok ? '' : parsed.problem
}

/** The problem for the shipped file after `change`. */
function problemWith(change: (document: Record<string, any>) => void): string {
  return problemOf(shippedWith(change))
}

function settingsOf(text: string): JudgeSettings {
  const parsed = parseSettings(text)
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.problem)
  return parsed.settings
}

/** The settings for the shipped file after `change`. */
function settingsWith(change: (document: Record<string, any>) => void): JudgeSettings {
  return settingsOf(shippedWith(change))
}

// --- the shipped default --------------------------------------------------------------------------

test('the shipped judge.yaml is the one in the spec, byte for byte, and DEFAULT_TEXT is that file', () => {
  assert.equal(DEFAULT_TEXT, readFileSync(new URL('../defaults/judge.yaml', import.meta.url), 'utf8'))
  const spec = readFileSync(new URL('../../../docs/specs/judge.md', import.meta.url), 'utf8')
  const block = /^## `judge\.yaml`[\s\S]*?```yaml\n([\s\S]*?)```/m.exec(spec)?.[1]
  assert.ok(block !== undefined, 'the spec has a judge.yaml section with a yaml block')
  assert.equal(DEFAULT_TEXT, block)
})

test('parseSettings accepts the shipped default, and DEFAULT_SETTINGS is what it makes of it', () => {
  const parsed = parseSettings(DEFAULT_TEXT)
  assert.ok(parsed.ok)
  assert.deepEqual(parsed.settings, DEFAULT_SETTINGS)
})

test('the default has the model, time limit, thresholds and tool lists of the spec', () => {
  assert.deepEqual(DEFAULT_SETTINGS, {
    model: 'jev-1.13.0',
    timeoutMs: 2000,
    commands: { readOnly: 0.9, reversible: 0.9, servesTask: 0.5 },
    screening: { withhold: 0.9, warn: 0.5, chunkChars: 24000 },
    tools: { gated: ['bash', 'pwsh'], screened: ['web_search', 'web_fetch', 'read_mcp_resource', 'mcp__*'] },
  })
})

test('settings are frozen all the way down, so one object can be shared between calls', () => {
  assert.ok(Object.isFrozen(DEFAULT_SETTINGS))
  assert.ok(Object.isFrozen(DEFAULT_SETTINGS.commands))
  assert.ok(Object.isFrozen(DEFAULT_SETTINGS.screening))
  assert.ok(Object.isFrozen(DEFAULT_SETTINGS.tools))
  assert.ok(Object.isFrozen(DEFAULT_SETTINGS.tools.gated))
  assert.ok(Object.isFrozen(DEFAULT_SETTINGS.tools.screened))
  const edited = settingsWith((d) => { d.timeoutMs = 3000 })
  assert.ok(Object.isFrozen(edited))
  assert.ok(Object.isFrozen(edited.commands))
  assert.ok(Object.isFrozen(edited.tools.screened))
  // A frozen object ignores a write in sloppy mode and refuses it in strict mode, which a module is.
  assert.throws(() => { (DEFAULT_SETTINGS as { timeoutMs: number }).timeoutMs = 1 }, TypeError)
  assert.throws(() => { (DEFAULT_SETTINGS.commands as { readOnly: number }).readOnly = 0 }, TypeError)
  assert.throws(() => { (DEFAULT_SETTINGS.tools.gated as string[]).push('x') }, TypeError)
  assert.equal(DEFAULT_SETTINGS.timeoutMs, 2000)
})

test('what is parsed is a copy: two parses of one text are equal and share nothing', () => {
  const a = settingsOf(DEFAULT_TEXT)
  const b = settingsOf(DEFAULT_TEXT)
  assert.deepEqual(a, b)
  assert.notEqual(a, b)
  assert.notEqual(a.tools.gated, b.tools.gated)
})

// --- accepted edits -------------------------------------------------------------------------------

test('a valid edit is what comes back, in every field', () => {
  const settings = settingsWith((d) => {
    d.model = 'jev-1.14.0'
    d.timeoutMs = 5000
    d.commands = { readOnly: 0.8, reversible: 0.99, servesTask: 0.6 }
    d.screening = { withhold: 0.7, warn: 0.2, chunkChars: 10000 }
    d.tools = { gated: ['bash'], screened: ['web_fetch', 'mcp__github__*'] }
  })
  assert.deepEqual(settings, {
    model: 'jev-1.14.0',
    timeoutMs: 5000,
    commands: { readOnly: 0.8, reversible: 0.99, servesTask: 0.6 },
    screening: { withhold: 0.7, warn: 0.2, chunkChars: 10000 },
    tools: { gated: ['bash'], screened: ['web_fetch', 'mcp__github__*'] },
  })
})

test('the edges of every range are accepted', () => {
  assert.equal(settingsWith((d) => { d.timeoutMs = 200 }).timeoutMs, 200)
  assert.equal(settingsWith((d) => { d.timeoutMs = 10000 }).timeoutMs, 10000)
  assert.equal(settingsWith((d) => { d.screening.chunkChars = 2000 }).screening.chunkChars, 2000)
  assert.equal(settingsWith((d) => { d.screening.chunkChars = 60000 }).screening.chunkChars, 60000)
  for (const key of ['readOnly', 'reversible', 'servesTask'] as const) {
    assert.equal(settingsWith((d) => { d.commands[key] = 0 }).commands[key], 0)
    assert.equal(settingsWith((d) => { d.commands[key] = 1 }).commands[key], 1)
  }
  assert.equal(settingsWith((d) => { d.screening.withhold = 0; d.screening.warn = 0 }).screening.warn, 0)
  assert.equal(settingsWith((d) => { d.screening.withhold = 1; d.screening.warn = 1 }).screening.withhold, 1)
})

test('a threshold written as an integer is a number: 0 and 1', () => {
  const settings = settingsOf(DEFAULT_TEXT.replace('readOnly: 0.90', 'readOnly: 1').replace('servesTask: 0.50', 'servesTask: 0'))
  assert.equal(settings.commands.readOnly, 1)
  assert.equal(settings.commands.servesTask, 0)
})

test('warn may equal withhold', () => {
  const settings = settingsWith((d) => { d.screening.warn = 0.9 })
  assert.equal(settings.screening.warn, settings.screening.withhold)
})

test('a tool name is plain, or a prefix ending in *', () => {
  const names = ['bash', 'web_fetch', 'mcp__*', 'mcp__server-1__*', 'a.b:c', 'tool*', 'a', 'a*', '~!@#$%^&()_+-=[]{}|;:,.<>/?`\'"\\']
  assert.deepEqual([...settingsWith((d) => { d.tools.gated = names }).tools.gated], names)
  assert.deepEqual([...settingsWith((d) => { d.tools.screened = names }).tools.screened], names)
})

test('a lone * is refused, and the refusal says what to list instead', () => {
  for (const list of ['gated', 'screened'] as const) {
    assert.equal(problemWith((d) => { d.tools[list] = ['bash', '*'] }), `tools.${list}[1]: a lone * is not allowed: list tools by name, or by a prefix such as mcp__*`)
  }
})

test('comments and key order do not matter', () => {
  const text = [
    '# the judge',
    'tools:',
    '  screened: [web_fetch]',
    '  gated: [bash]',
    'screening: { chunkChars: 4000, warn: 0.4, withhold: 0.8 }',
    'commands: { servesTask: 0.5, reversible: 0.95, readOnly: 0.9 }',
    'timeoutMs: 1500',
    'model: "jev-1.13.0"',
    '',
  ].join('\n')
  assert.deepEqual(settingsOf(text), {
    model: 'jev-1.13.0',
    timeoutMs: 1500,
    commands: { readOnly: 0.9, reversible: 0.95, servesTask: 0.5 },
    screening: { withhold: 0.8, warn: 0.4, chunkChars: 4000 },
    tools: { gated: ['bash'], screened: ['web_fetch'] },
  })
})

// --- refusals -------------------------------------------------------------------------------------

test('text that is not YAML is refused with where, and none of the document', () => {
  assert.match(problemOf('timeoutMs: [2000'), /^not valid YAML \(line \d+, column \d+\): /)
  assert.doesNotMatch(problemOf('model: "secret-model\ntimeoutMs: 1'), /secret-model/)
})

test('an empty file, or one with only comments, is refused and says what it needs', () => {
  const need = /^the file is empty; it needs model, timeoutMs, commands, screening and tools$/
  assert.match(problemOf(''), need)
  assert.match(problemOf('\n  \n'), need)
  assert.match(problemOf('# nothing here\n'), need)
})

test('a document that is not a mapping is refused', () => {
  assert.equal(problemOf('- a\n- b\n'), 'must be a mapping of settings (got a list)')
  assert.equal(problemOf('just text\n'), 'must be a mapping of settings (got "just text")')
  assert.equal(problemOf('42\n'), 'must be a mapping of settings (got 42)')
  assert.equal(problemOf('null\n'), 'must be a mapping of settings (got null)')
})

test('YAML tags are refused: the document is read with the JSON schema', () => {
  assert.match(problemOf('model: !!js/function "function () {}"\n'), /^not valid YAML/)
  assert.match(problemOf(`${DEFAULT_TEXT}extra: !!binary aGk=\n`), /^not valid YAML/)
})

test('an unknown key is refused with its path, at every level', () => {
  assert.equal(problemWith((d) => { d.speed = 1 }), 'speed: unknown key (allowed: model, timeoutMs, commands, screening, tools)')
  assert.equal(problemWith((d) => { d.commands.irreversible = 0.5 }), 'commands.irreversible: unknown key (allowed: readOnly, reversible, servesTask)')
  assert.equal(problemWith((d) => { d.screening.warning = 0.5 }), 'screening.warning: unknown key (allowed: withhold, warn, chunkChars)')
  assert.equal(problemWith((d) => { d.tools.checked = ['bash'] }), 'tools.checked: unknown key (allowed: gated, screened)')
  // A misspelling of a key that is there is both an unknown key and a missing one; the unknown one is named first.
  assert.match(problemWith((d) => { d.timeoutms = d.timeoutMs; delete d.timeoutMs }), /^timeoutms: unknown key/)
})

test('an unknown key that is not a plain name is quoted in the path and cut short, and __proto__ is just an unknown key', () => {
  assert.match(problemWith((d) => { d['odd name'] = 1 }), /^\["odd name"\]: unknown key/)
  const long = 'k'.repeat(500)
  const problem = problemWith((d) => { d[long] = 1 })
  assert.match(problem, /^\["k{40}…"\]: unknown key/)
  assert.ok(problem.length < 200, problem)
  assert.match(problemOf(`${DEFAULT_TEXT}__proto__: 1\n`), /^__proto__: unknown key/)
  assert.match(problemOf(`${DEFAULT_TEXT.replace('commands:\n', 'commands:\n  __proto__: 1\n')}`), /^commands\.__proto__: unknown key/)
})

test('every top-level key and every key of a section is required, and the message says what it is', () => {
  assert.equal(problemWith((d) => { delete d.model }), 'model: required (a model id)')
  assert.equal(problemWith((d) => { delete d.timeoutMs }), 'timeoutMs: required (milliseconds, 200 to 10000)')
  assert.equal(problemWith((d) => { delete d.commands }), 'commands: required (readOnly, reversible and servesTask)')
  assert.equal(problemWith((d) => { delete d.screening }), 'screening: required (withhold, warn and chunkChars)')
  assert.equal(problemWith((d) => { delete d.tools }), 'tools: required (gated and screened)')
  assert.equal(problemWith((d) => { delete d.commands.readOnly }), 'commands.readOnly: required (a number from 0 to 1)')
  assert.equal(problemWith((d) => { delete d.commands.reversible }), 'commands.reversible: required (a number from 0 to 1)')
  assert.equal(problemWith((d) => { delete d.commands.servesTask }), 'commands.servesTask: required (a number from 0 to 1)')
  assert.equal(problemWith((d) => { delete d.screening.withhold }), 'screening.withhold: required (a number from 0 to 1)')
  assert.equal(problemWith((d) => { delete d.screening.warn }), 'screening.warn: required (a number from 0 to 1)')
  assert.equal(problemWith((d) => { delete d.screening.chunkChars }), 'screening.chunkChars: required (characters, 2000 to 60000)')
  assert.equal(problemWith((d) => { delete d.tools.gated }), 'tools.gated: required (a list of tool names)')
  assert.equal(problemWith((d) => { delete d.tools.screened }), 'tools.screened: required (a list of tool names)')
})

test('a section that is not a mapping is refused', () => {
  assert.equal(problemWith((d) => { d.commands = 0.9 }), 'commands: must be a mapping with readOnly, reversible, servesTask (got 0.9)')
  assert.equal(problemWith((d) => { d.screening = ['a'] }), 'screening: must be a mapping with withhold, warn, chunkChars (got a list)')
  assert.equal(problemWith((d) => { d.tools = 'bash' }), 'tools: must be a mapping with gated, screened (got "bash")')
  assert.equal(problemWith((d) => { d.commands = null }), 'commands: must be a mapping with readOnly, reversible, servesTask (got null)')
})

test('model is a non-empty string with no padding', () => {
  assert.equal(problemWith((d) => { d.model = '' }), 'model: must be a model id (got "")')
  assert.equal(problemWith((d) => { d.model = '   ' }), 'model: must be a model id (got "   ")')
  assert.equal(problemWith((d) => { d.model = 12 }), 'model: must be a model id (got 12)')
  assert.equal(problemWith((d) => { d.model = null }), 'model: must be a model id (got null)')
  assert.equal(problemWith((d) => { d.model = ['jev'] }), 'model: must be a model id (got a list)')
  assert.equal(problemWith((d) => { d.model = ' jev-1.13.0' }), 'model: must not start or end with whitespace (got " jev-1.13.0")')
  assert.equal(problemWith((d) => { d.model = 'jev-1.13.0\n' }), 'model: must not start or end with whitespace (got "jev-1.13.0\\n")')
})

const MODEL_RULE = 'must be a model id: letters, digits and . _ : / - only, starting with a letter or digit, at most 128 characters'

test('a model id is letters, digits and . _ : / - only, starting with a letter or digit, at most 128 characters', () => {
  for (const good of ['jev-1.13.0', 'a', '1', 'jev_1', 'jev:1.13', 'org/jev-1.13.0', 'A.b_c:d/e-f', 'x'.repeat(128)]) {
    assert.equal(settingsWith((d) => { d.model = good }).model, good)
  }
  for (const bad of ['-jev', '.jev', '_jev', ':jev', '/jev', 'jev 1.13', 'je\tv', 'jev\n1', 'jev\r\n1', 'jev\u001b[31m', '\u001b[31m', 'jev\u0000', 'bash\u0000', 'jev\u007f', 'jev\u009b1', 'j\u00e9v', 'jev\u2028', 'jev\u200b1', 'jev\ud83d\ude00', 'jev"1', "jev'1", 'jev;1', 'jev,1', 'jev*', 'jev=1', 'jev+1', 'x'.repeat(129)]) {
    const problem = problemWith((d) => { d.model = bad })
    assert.ok(problem.startsWith(`model: ${MODEL_RULE} (got `) || problem.startsWith('model: must not start or end with whitespace (got '), `${JSON.stringify(bad)}: ${problem}`)
  }
})

test('a model id with whitespace or a newline inside is refused, and says what a model id is', () => {
  assert.equal(problemWith((d) => { d.model = 'jev 1.13.0' }), `model: ${MODEL_RULE} (got "jev 1.13.0")`)
  assert.equal(problemWith((d) => { d.model = 'jev\n1.13.0' }), `model: ${MODEL_RULE} (got "jev\\n1.13.0")`)
})

test('a 100 KB model id is refused, and the message is not the size of it', () => {
  for (const value of ['x'.repeat(100 * 1024), `${'x'.repeat(100 * 1024)} y`, `${'a b '.repeat(25 * 1024)}`.trim()]) {
    const problem = problemWith((d) => { d.model = value })
    assert.ok(problem.startsWith(`model: ${MODEL_RULE} (got "`) && problem.endsWith('…")'), problem.slice(0, 200))
    assert.ok(problem.length < 250, `${problem.length}`)
  }
})

test('a model id with an escape sequence or a NUL in it is refused, and the message holds neither', () => {
  for (const value of ['\u001b[31m', 'bash\u0000', 'jev-1.13.0\u001b[0m', 'a\u009bb']) {
    const problem = problemWith((d) => { d.model = value })
    assert.match(problem, /^model: must be a model id: /)
    assert.doesNotMatch(problem, /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/, JSON.stringify(problem))
  }
  assert.equal(problemWith((d) => { d.model = '\u001b[31m' }), `model: ${MODEL_RULE} (got "\\u001b[31m")`)
})

const BODY = 'Zq9XvB2nLp0TaR7uWcE4yKd8MfH1sJgO5iN3'
const KEY_LIKE = `sk-ant-api03-${BODY}-AbCd`

test('a model id that is a credential is refused without showing it: it would be sent to the API and kept in the store', () => {
  const problem = problemWith((d) => { d.model = KEY_LIKE })
  assert.equal(problem, 'model: must be a model id, and this looks like an sk- API key: it is not shown')
  assert.doesNotMatch(problem, new RegExp(BODY.slice(0, 10)))
  assert.doesNotMatch(problem, /sk-ant|sk-[A-Za-z0-9_-]{8,}/)
  const token = `ghp_${'A1b2C3d4E5'.repeat(4)}`
  assert.match(problemWith((d) => { d.model = token }), /^model: must be a model id, and this looks like a GitHub token: it is not shown$/)
})

test('a value that is echoed in a problem has any secret in it masked: no sk- body, whatever the problem is', () => {
  const echoed: Record<string, string> = {
    modelWithTail: problemWith((d) => { d.model = `${KEY_LIKE} (my key)` }),
    modelAfterText: problemWith((d) => { d.model = `my key is ${KEY_LIKE}` }),
    modelPadded: problemWith((d) => { d.model = ` ${KEY_LIKE}` }),
    modelHuge: problemWith((d) => { d.model = `${KEY_LIKE} ${'y'.repeat(100 * 1024)}` }),
    timeoutMs: problemWith((d) => { d.timeoutMs = KEY_LIKE }),
    threshold: problemWith((d) => { d.commands.readOnly = `bearer ${KEY_LIKE}` }),
    toolRepeated: problemWith((d) => { d.tools.gated = [KEY_LIKE.repeat(10)] }),
    toolWithSpace: problemWith((d) => { d.tools.gated = [`${KEY_LIKE} x`] }),
    toolPadded: problemWith((d) => { d.tools.screened = [` ${KEY_LIKE}`] }),
    toolAfterSpace: problemWith((d) => { d.tools.gated = [`x ${KEY_LIKE}`] }),
    topKey: problemWith((d) => { d[KEY_LIKE] = 1 }),
    sectionKey: problemWith((d) => { d.commands[`x ${KEY_LIKE}`] = 1 }),
    chunkChars: problemWith((d) => { d.screening.chunkChars = KEY_LIKE }),
  }
  for (const [what, problem] of Object.entries(echoed)) {
    assert.doesNotMatch(problem, new RegExp(BODY.slice(0, 10)), `${what}: ${problem}`)
    assert.doesNotMatch(problem, /sk-ant-api03/, `${what}: ${problem}`)
    assert.doesNotMatch(problem, /sk-[A-Za-z0-9_-]{8,}/, `${what}: ${problem}`)
    assert.ok(problem.length < 300, `${what}: ${problem.length}: ${problem}`)
  }
  assert.equal(echoed.timeoutMs, 'timeoutMs: "‹secret: an sk- API key›" is not a whole number from 200 to 10000')
  assert.equal(echoed.chunkChars, 'screening.chunkChars: "‹secret: an sk- API key›" is not a whole number from 2000 to 60000')
  assert.equal(echoed.modelPadded, 'model: must not start or end with whitespace (got " ‹secret: an sk- API key›")')
  assert.equal(echoed.toolWithSpace, `tools.gated[0]: must be a tool name or a prefix ending in *: printable ASCII with no spaces, and a * only at the end (got "‹secret: an sk- API key› x")`)
  assert.equal(echoed.topKey, '["‹secret: an sk- API key›"]: unknown key (allowed: model, timeoutMs, commands, screening, tools)')
  assert.match(echoed.sectionKey!, /^commands\["x ‹secret: an sk- API key›"\]: unknown key/)
})

test('a GitHub token as the name of an unknown key is masked, though it is a plain name', () => {
  const token = `ghp_${'A1b2C3d4E5'.repeat(4)}`
  const problem = problemWith((d) => { d[token] = 1 })
  assert.equal(problem, '["‹secret: a GitHub token›"]: unknown key (allowed: model, timeoutMs, commands, screening, tools)')
  assert.doesNotMatch(problemWith((d) => { d.tools[token] = ['bash'] }), /A1b2C3d4E5/)
})

test('a secret in what a YAML parser says is masked too', () => {
  const problem = problemOf(`model: *${KEY_LIKE}\n`)
  assert.match(problem, /^not valid YAML \(line \d+, column \d+\): /)
  assert.doesNotMatch(problem, new RegExp(BODY.slice(0, 10)))
})

test('timeoutMs is a whole number from 200 to 10000', () => {
  for (const bad of [199, 0, -1, 10001, 100000, 1500.5, '2000', null, true, [2000]]) {
    const problem = problemWith((d) => { d.timeoutMs = bad })
    assert.match(problem, /^timeoutMs: .* is not a whole number from 200 to 10000$/, `${JSON.stringify(bad)}: ${problem}`)
  }
  assert.equal(problemWith((d) => { d.timeoutMs = 199 }), 'timeoutMs: 199 is not a whole number from 200 to 10000')
  assert.equal(problemWith((d) => { d.timeoutMs = 2000.5 }), 'timeoutMs: 2000.5 is not a whole number from 200 to 10000')
  assert.equal(problemWith((d) => { d.timeoutMs = '2000' }), 'timeoutMs: "2000" is not a whole number from 200 to 10000')
})

test('a threshold is a number from 0 to 1', () => {
  for (const [section, key] of [['commands', 'readOnly'], ['commands', 'reversible'], ['commands', 'servesTask'], ['screening', 'withhold'], ['screening', 'warn']] as const) {
    for (const bad of [-0.01, 1.01, 90, -1, '0.9', null, true, false, [0.9], {}]) {
      const problem = problemWith((d) => {
        // `warn` can't be tested above `withhold` alone, so keep both in range of the check that is being made.
        d[section][key] = bad
      })
      assert.match(problem, new RegExp(`^${section}\\.${key}: .* is not a number from 0 to 1$`), `${section}.${key} = ${JSON.stringify(bad)}: ${problem}`)
    }
  }
  assert.equal(problemWith((d) => { d.commands.readOnly = 1.5 }), 'commands.readOnly: 1.5 is not a number from 0 to 1')
  assert.equal(problemWith((d) => { d.screening.withhold = '0.9' }), 'screening.withhold: "0.9" is not a number from 0 to 1')
  assert.equal(problemWith((d) => { d.commands.servesTask = true }), 'commands.servesTask: true is not a number from 0 to 1')
})

test('a threshold that is not a finite number is refused: .nan and .inf are YAML numbers, and not thresholds', () => {
  for (const bad of ['.nan', '.inf', '-.inf']) {
    const problem = problemOf(DEFAULT_TEXT.replace('readOnly: 0.90', `readOnly: ${bad}`))
    assert.match(problem, /^commands\.readOnly: .* is not a number from 0 to 1$/, `${bad}: ${problem}`)
  }
})

test('warn may not be above withhold', () => {
  assert.equal(problemWith((d) => { d.screening.warn = 0.95 }), 'screening.warn: 0.95 is more than screening.withhold (0.9)')
  assert.equal(problemWith((d) => { d.screening.withhold = 0.4 }), 'screening.warn: 0.5 is more than screening.withhold (0.4)')
})

test('chunkChars is a whole number from 2000 to 60000', () => {
  for (const bad of [1999, 0, 60001, 1e6, 24000.5, '24000', null, false]) {
    const problem = problemWith((d) => { d.screening.chunkChars = bad })
    assert.match(problem, /^screening\.chunkChars: .* is not a whole number from 2000 to 60000$/, `${JSON.stringify(bad)}: ${problem}`)
  }
  assert.equal(problemWith((d) => { d.screening.chunkChars = 1999 }), 'screening.chunkChars: 1999 is not a whole number from 2000 to 60000')
})

test('gated and screened are non-empty lists of tool names', () => {
  for (const list of ['gated', 'screened'] as const) {
    assert.equal(problemWith((d) => { d.tools[list] = 'bash' }), `tools.${list}: must be a list of tool names (got "bash")`)
    assert.equal(problemWith((d) => { d.tools[list] = null }), `tools.${list}: must be a list of tool names (got null)`)
    assert.equal(problemWith((d) => { d.tools[list] = { bash: true } }), `tools.${list}: must be a list of tool names (got a mapping)`)
    assert.equal(problemWith((d) => { d.tools[list] = [] }), `tools.${list}: needs at least one tool name`)
  }
})

test('each tool name is a plain name or a prefix ending in *, with no padding', () => {
  for (const list of ['gated', 'screened'] as const) {
    const msg = (index: number, shown: string): string => `tools.${list}[${index}]: must be a tool name or a prefix ending in * (got ${shown})`
    const charset = (index: number, shown: string): string => `tools.${list}[${index}]: must be a tool name or a prefix ending in *: printable ASCII with no spaces, and a * only at the end (got ${shown})`
    assert.equal(problemWith((d) => { d.tools[list] = ['bash', ''] }), msg(1, '""'))
    assert.equal(problemWith((d) => { d.tools[list] = ['bash', '  '] }), msg(1, '"  "'))
    assert.equal(problemWith((d) => { d.tools[list] = [7] }), msg(0, '7'))
    assert.equal(problemWith((d) => { d.tools[list] = [null] }), msg(0, 'null'))
    assert.equal(problemWith((d) => { d.tools[list] = [['bash']] }), msg(0, 'a list'))
    assert.equal(problemWith((d) => { d.tools[list] = ['mcp*server'] }), charset(0, '"mcp*server"'))
    assert.equal(problemWith((d) => { d.tools[list] = ['mcp**'] }), charset(0, '"mcp**"'))
    assert.equal(problemWith((d) => { d.tools[list] = ['**'] }), charset(0, '"**"'))
    assert.equal(problemWith((d) => { d.tools[list] = ['*bash'] }), charset(0, '"*bash"'))
    assert.equal(problemWith((d) => { d.tools[list] = ['web fetch'] }), charset(0, '"web fetch"'))
    assert.equal(problemWith((d) => { d.tools[list] = ['bash', 'a\tb*'] }), charset(1, '"a\\tb*"'))
    assert.equal(problemWith((d) => { d.tools[list] = ['bash', ' bash'] }), `tools.${list}[1]: must not start or end with whitespace (got " bash")`)
    assert.equal(problemWith((d) => { d.tools[list] = ['bash ', 'x'] }), `tools.${list}[0]: must not start or end with whitespace (got "bash ")`)
    assert.equal(problemWith((d) => { d.tools[list] = ['mcp__* '] }), `tools.${list}[0]: must not start or end with whitespace (got "mcp__* ")`)
  }
})

test('a tool name has no characters but printable ASCII: no inner whitespace, newline, escape, NUL, DEL, or anything beyond ASCII', () => {
  const bad = ['a b', 'a\nb', 'a\r\nb', 'a\u001b[31mb', '\u001b[31m', 'bash\u0000', 'ba\u0000sh', 'ba\u007fsh', 'caf\u00e9', 'a\u009bb', 'a\u2028b', 'a\u00a0b', 'a\u200bb', '\ud83d\ude00', 'mcp__\u0000*']
  for (const list of ['gated', 'screened'] as const) {
    for (const name of bad) {
      const problem = problemWith((d) => { d.tools[list] = ['bash', name] })
      assert.match(problem, new RegExp(`^tools\\.${list}\\[1\\]: (must be a tool name or a prefix ending in \\*: printable ASCII with no spaces|must not start or end with whitespace)`), `${JSON.stringify(name)}: ${problem}`)
    }
  }
})

test('a tool name is at most 128 characters, and a long one in a message is cut short', () => {
  const longest = 'x'.repeat(127) + '*'
  assert.equal(longest.length, 128)
  assert.deepEqual([...settingsWith((d) => { d.tools.gated = [longest] }).tools.gated], [longest])
  for (const name of ['x'.repeat(129), 'x'.repeat(128) + '*', 'x'.repeat(100 * 1024)]) {
    const problem = problemWith((d) => { d.tools.gated = [name] })
    assert.match(problem, /^tools\.gated\[0\]: must be at most 128 characters \(got "x{40}…"\)$/)
  }
})

test('a tool name that is refused is shown without control characters in it, even the C1 ones a terminal obeys', () => {
  for (const name of ['\u001b[31m', 'bash\u0000', 'a\u009bb', 'a\u0085b', 'a\u2028b', 'a\u007fb']) {
    const problem = problemWith((d) => { d.tools.gated = [name] })
    assert.doesNotMatch(problem, /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/, JSON.stringify(problem))
  }
  assert.equal(problemWith((d) => { d.tools.gated = ['a\u009bb'] }), 'tools.gated[0]: must be a tool name or a prefix ending in *: printable ASCII with no spaces, and a * only at the end (got "a\\u009bb")')
})

test('a tool name in a message is cut short, so a long one can not make a message the size of the file', () => {
  const problem = problemWith((d) => { d.tools.gated = ['x'.repeat(500) + ' y'] })
  assert.match(problem, /^tools\.gated\[0\]: must be a tool name or a prefix ending in \*: printable ASCII with no spaces, and a \* only at the end \(got "x{40}…"\)$/)
})

test('no problem repeats the name of the file: the store puts it in front', () => {
  const edits: Array<(d: Record<string, any>) => void> = [
    (d) => { d.speed = 1 },
    (d) => { delete d.model },
    (d) => { d.model = '' },
    (d) => { d.timeoutMs = 1 },
    (d) => { d.commands.readOnly = 2 },
    (d) => { d.screening.warn = 1 },
    (d) => { d.screening.chunkChars = 1 },
    (d) => { d.tools.gated = [] },
    (d) => { d.tools.screened = [' x'] },
  ]
  for (const edit of edits) assert.doesNotMatch(problemWith(edit), /judge\.yaml/)
  for (const text of ['', 'a: [', '- x\n', '# c\n']) assert.doesNotMatch(problemOf(text), /judge\.yaml/)
})

test('the first problem found is the one returned, and a file that parses never throws', () => {
  // Two faults: the top-level key order is the order of the checks.
  const problem = problemWith((d) => { d.model = ''; d.timeoutMs = 1 })
  assert.match(problem, /^model: /)
  assert.deepEqual(parseSettings(render(shippedDocument())), { ok: true, settings: DEFAULT_SETTINGS })
})

// --- the namespace --------------------------------------------------------------------------------

test('JUDGE_SPEC claims judge.yaml for dish-judge, closed to agents', () => {
  assert.equal(JUDGE_SPEC.prefix, 'judge.yaml')
  assert.equal(JUDGE_SPEC.owner, 'dish-judge')
  assert.equal(JUDGE_SPEC.agent, 'none')
})

test('JUDGE_SPEC validates with parseSettings: nothing for a good file, the problem for a bad one', () => {
  assert.equal(JUDGE_SPEC.validate('judge.yaml', DEFAULT_TEXT), undefined)
  assert.equal(JUDGE_SPEC.validate('judge.yaml', shippedWith((d) => { d.timeoutMs = 4000 })), undefined)
  assert.equal(JUDGE_SPEC.validate('judge.yaml', shippedWith((d) => { d.screening.warn = 0.95 })), 'screening.warn: 0.95 is more than screening.withhold (0.9)')
  assert.match(String(JUDGE_SPEC.validate('judge.yaml', 'a: [')), /^not valid YAML/)
  assert.match(String(JUDGE_SPEC.validate('judge.yaml', '')), /^the file is empty/)
})
