import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nearest } from '../src/catalog.ts'

const catalog = (...ids: string[]) => ids.map(id => ({ id, api: 'x' })) as Parameters<typeof nearest>[1]

test('a new model copies the closest version of its vendor, not an older one of the same tier', () => {
  // claude-sonnet-5 sends thinking {type: disabled}, which the 5.5 generation rejects; claude-opus-5.5 knows better.
  const pick = nearest('claude-sonnet-5.5', catalog('claude-sonnet-5', 'claude-opus-5.5', 'claude-opus-5', 'claude-haiku-4.5'))
  assert.equal(pick?.id, 'claude-opus-5.5')
})

test('among the same version, the closest name wins', () => {
  assert.equal(nearest('gpt-5.6-sol-fast', catalog('gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-6-sol'))?.id, 'gpt-5.6-sol')
  assert.equal(nearest('gpt-6.1-sol', catalog('gpt-6-luna', 'gpt-6-sol', 'gpt-6-astra', 'gpt-5.6-sol'))?.id, 'gpt-6-sol')
})

test('a model never copies another vendor while its own vendor has a candidate', () => {
  assert.equal(nearest('claude-sonnet-5.5', catalog('gpt-5.5', 'claude-sonnet-4.6'))?.id, 'claude-sonnet-4.6')
})

test('ids without a version fall back to the closest name', () => {
  assert.equal(nearest('mai-code-flash', catalog('mai-code-1-flash', 'gpt-5-mini'))?.id, 'mai-code-1-flash')
  assert.equal(nearest('x', catalog()), undefined)
})
