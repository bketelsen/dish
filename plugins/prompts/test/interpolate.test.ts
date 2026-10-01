import { test } from 'node:test'
import assert from 'node:assert/strict'
import { interpolate } from '../src/interpolate.ts'

const VARS = { model: 'deepseek-v4', cwd: '/work', empty: '', pending: undefined }

test('a known name is replaced, and nothing is listed', () => {
  assert.deepEqual(interpolate('You are {{model}} in {{cwd}}.', VARS), { text: 'You are deepseek-v4 in /work.', unknown: [] })
})

test('an unknown name stays as written and is listed', () => {
  assert.deepEqual(interpolate('Today is {{date}}; you are {{model}}.', VARS), { text: 'Today is {{date}}; you are deepseek-v4.', unknown: ['date'] })
})

test('a name with no value stays as written and is listed', () => {
  assert.deepEqual(interpolate('{{pending}} and {{model}}', VARS), { text: '{{pending}} and deepseek-v4', unknown: ['pending'] })
})

test('an empty value is a value', () => {
  assert.deepEqual(interpolate('[{{empty}}]', VARS), { text: '[]', unknown: [] })
})

test('a name the variables only inherit is unknown, not a value', () => {
  assert.deepEqual(interpolate('{{constructor}}', VARS), { text: '{{constructor}}', unknown: ['constructor'] })
  assert.deepEqual(interpolate('{{constructor}}', Object.create({ model: 'inherited' }) as Record<string, string>), { text: '{{constructor}}', unknown: ['constructor'] })
  assert.deepEqual(interpolate('{{model}}', Object.create({ model: 'inherited' }) as Record<string, string>), { text: '{{model}}', unknown: ['model'] })
})

test('the same unknown name twice is listed once, in order of first appearance', () => {
  const result = interpolate('{{b}} {{a}} {{b}} {{model}} {{pending}} {{a}} {{pending}}', VARS)
  assert.equal(result.text, '{{b}} {{a}} {{b}} deepseek-v4 {{pending}} {{a}} {{pending}}')
  assert.deepEqual(result.unknown, ['b', 'a', 'pending'])
})

test('adjacent groups are each replaced', () => {
  assert.deepEqual(interpolate('{{model}}{{cwd}}', VARS), { text: 'deepseek-v4/work', unknown: [] })
  assert.deepEqual(interpolate('{{a}}{{b}}', VARS), { text: '{{a}}{{b}}', unknown: ['a', 'b'] })
  assert.deepEqual(interpolate('{{model}}{{a}}{{cwd}}', VARS), { text: 'deepseek-v4{{a}}/work', unknown: ['a'] })
})

test('a malformed group is left as written and is not listed: spaces, capitals, digits first, empty, newlines', () => {
  for (const group of ['{{ model }}', '{{model }}', '{{ model}}', '{{Model}}', '{{1a}}', '{{_a}}', '{{a-b}}', '{{a.b}}', '{{}}', '{{ }}', '{{\nmodel\n}}', '{{"a": 1}}']) {
    assert.deepEqual(interpolate(`x ${group} y`, VARS), { text: `x ${group} y`, unknown: [] }, JSON.stringify(group))
  }
})

test('names may hold lowercase letters, digits and underscores after the first letter', () => {
  assert.deepEqual(interpolate('{{a_1}} {{a1b2}}', { a_1: 'x', a1b2: 'y' }), { text: 'x y', unknown: [] })
})

test('an unclosed {{ is literal text, and the groups around it are still replaced', () => {
  assert.deepEqual(interpolate('{{', VARS), { text: '{{', unknown: [] })
  assert.deepEqual(interpolate('a {{ b', VARS), { text: 'a {{ b', unknown: [] })
  assert.deepEqual(interpolate('{{model}} then {{ never closed', VARS), { text: 'deepseek-v4 then {{ never closed', unknown: [] })
  assert.deepEqual(interpolate('{{ never closed {{model}}', VARS), { text: '{{ never closed deepseek-v4', unknown: [] })
  assert.deepEqual(interpolate('{{model', VARS), { text: '{{model', unknown: [] })
  assert.deepEqual(interpolate('{{model}', VARS), { text: '{{model}', unknown: [] })
})

test('{{x} and {x}} are not groups', () => {
  assert.deepEqual(interpolate('{{model} and {model}}', VARS), { text: '{{model} and {model}}', unknown: [] })
  assert.deepEqual(interpolate('{{model}', VARS), { text: '{{model}', unknown: [] })
  assert.deepEqual(interpolate('{model}}', VARS), { text: '{model}}', unknown: [] })
  assert.deepEqual(interpolate('{model}', VARS), { text: '{model}', unknown: [] })
})

test('a {{ without a group, then a later }}, is malformed: left as written, and a group after it is still replaced', () => {
  // dsh throws here; this version leaves the text and goes on.
  assert.deepEqual(interpolate('{{{model}}', VARS), { text: '{{{model}}', unknown: [] })
  assert.deepEqual(interpolate('{{ {{model}} }}', VARS), { text: '{{ deepseek-v4 }}', unknown: [] })
  assert.deepEqual(interpolate('{{a {{model}}', VARS), { text: '{{a deepseek-v4', unknown: [] })
})

test('JSON and code with braces come through untouched', () => {
  const text = 'Reply as {"a": {"b": 1}} or `{{"k": "v"}}`; a map {{x: y}} too; a lone }} and {{.'
  assert.deepEqual(interpolate(text, VARS), { text, unknown: [] })
})

test('text with no groups is returned identical', () => {
  for (const text of ['', 'plain prose', 'one { brace', 'one } brace', 'a\nb\n\nc', '{ {model} }']) {
    assert.deepEqual(interpolate(text, VARS), { text, unknown: [] })
  }
})

test('substituted values are not scanned again', () => {
  assert.deepEqual(interpolate('{{a}}', { a: '{{b}}', b: 'no' }), { text: '{{b}}', unknown: [] })
  assert.deepEqual(interpolate('{{a}}}}', { a: '{{' }), { text: '{{}}', unknown: [] })
  assert.deepEqual(interpolate('{{a}}b}}', { a: '{{' }), { text: '{{b}}', unknown: [] })
})

test('a value is inserted as it is, including characters that mean something to String.replace', () => {
  assert.deepEqual(interpolate('{{a}}', { a: '$& $1 $$ $`' }), { text: '$& $1 $$ $`', unknown: [] })
})

test('a repeated known name is replaced every time; interpolating the same text twice gives the same answer', () => {
  const text = '{{model}}/{{model}}/{{x}}'
  const first = interpolate(text, VARS)
  assert.deepEqual(first, { text: 'deepseek-v4/deepseek-v4/{{x}}', unknown: ['x'] })
  assert.deepEqual(interpolate(text, VARS), first)
})

test('no variables at all: every well-formed group stays and is listed', () => {
  assert.deepEqual(interpolate('{{model}} {{cwd}}', {}), { text: '{{model}} {{cwd}}', unknown: ['model', 'cwd'] })
})
