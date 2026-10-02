/**
 * The earlier shipped defaults (`defaults/previous.json`) and what the plugin does with them: `replaceMap`, the
 * drift check that the file is what git history says. (The plugin bringing an earlier default up to date at start is
 * tested in `plugin.test.ts`.)
 */
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computePrevious, readPrevious } from 'dish-kit'
import { PREVIOUS, replaceMap } from '../src/defaults.ts'
import { DEFAULTS_BY_PATH } from './helpers.ts'

const DEFAULTS_DIRECTORY = fileURLToPath(new URL('../defaults/', import.meta.url))
const HEX = /^[0-9a-f]{64}$/

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

// --- replaceMap ------------------------------------------------------------------------------------

test('previous.json lists only shipped paths, as sha256 hashes, and never the text shipped now', () => {
  for (const [path, hashes] of Object.entries(PREVIOUS)) {
    assert.ok(Object.hasOwn(DEFAULTS_BY_PATH, path), `${path} is not a shipped prompt`)
    assert.ok(hashes.length > 0, path)
    for (const hash of hashes) {
      assert.match(hash, HEX, path)
      assert.notEqual(hash, sha256(DEFAULTS_BY_PATH[path]!), `${path} lists its current text`)
    }
  }
})

test('replaceMap is previous.json, for the paths dish seeds', () => {
  const map = replaceMap()
  assert.deepEqual(map, PREVIOUS)
  // Which files have earlier texts depends on what has changed, so only a path that has always changed is named.
  assert.ok(Object.hasOwn(map, 'prompts/main.md'))
})

test('replaceMap leaves out a path dish doesn\'t seed, since the store refuses a key that is not a default', () => {
  const hash = sha256('an earlier main')
  const map = replaceMap({ 'prompts/main.md': [hash], 'prompts/crew/gone.md': [hash], 'prompts/other.md': [hash] })
  assert.deepEqual(map, { 'prompts/main.md': [hash] })
  assert.deepEqual(replaceMap({}), {})
})

test('replaceMap gives back copies: changing one changes neither previous.json\'s data nor the next map', () => {
  const first = replaceMap()
  for (const hashes of Object.values(first)) hashes.push(sha256('x'))
  first['prompts/other.md'] = []
  assert.deepEqual(replaceMap(), PREVIOUS)
  assert.ok(!Object.hasOwn(replaceMap(), 'prompts/other.md'))
})

// --- drift ------------------------------------------------------------------------------------------

test('previous.json is what git history says: regenerate it with previous-defaults.mjs after changing a default', async (t) => {
  let computed: Record<string, string[]>
  try {
    computed = await computePrevious(DEFAULTS_DIRECTORY, 'prompts/')
  } catch (error) {
    if ((error as { code?: unknown }).code === 'NO_HISTORY') return t.skip((error as Error).message)
    throw error
  }
  assert.deepEqual(await readPrevious(DEFAULTS_DIRECTORY), computed,
    'run: node packages/dish-kit/scripts/previous-defaults.mjs plugins/prompts/defaults prompts/')
})
