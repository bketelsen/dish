/**
 * The earlier shipped defaults (`defaults/previous.json`) and what the plugin does with them: `replaceMap`, the
 * drift check that the file is what git history says, and a store that holds an earlier default being brought up to
 * the current one at start while an edited one stays.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { computePrevious, readPrevious } from 'dish-kit'
import { DEFAULTS, PREVIOUS, replaceMap } from '../src/defaults.ts'
import { pathFor } from '../src/roles.ts'
import { DEFAULTS_BY_PATH, dirs, mountConfig, mountPrompts, userWrite, waitFor } from './helpers.ts'
import type { Dirs } from './helpers.ts'


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
  // The seven earlier texts the prompts build left behind: main and the six crew roles, and none for common.
  assert.deepEqual(Object.keys(map).sort(), Object.keys(DEFAULTS_BY_PATH).filter(path => path !== 'prompts/common.md').sort())
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

// --- the plugin, against a store that holds earlier defaults -----------------------------------------

/** The text of `file` (under `defaults/`) in git history whose sha256 is `hash`. */
function earlierText(file: string, hash: string): string {
  const git = (...args: string[]): string => execFileSync('git', ['-C', DEFAULTS_DIRECTORY, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  for (const commit of git('log', '--format=%H', '--', file).split('\n').filter(Boolean)) {
    let text: string
    try {
      text = git('show', `${commit}:./${file}`)
    } catch {
      continue
    }
    if (sha256(text) === hash) return text
  }
  throw new Error(`no earlier version of ${file} has the hash ${hash}`)
}

/** Whether git history can be read here, so a test that needs the earlier texts can skip when it can't. */
async function historyOrSkip(t: TestContext): Promise<boolean> {
  try {
    await computePrevious(DEFAULTS_DIRECTORY, 'prompts/')
    return true
  } catch (error) {
    if ((error as { code?: unknown }).code !== 'NO_HISTORY') throw error
    t.skip((error as Error).message)
    return false
  }
}

async function withBoth(where: Dirs, body: (ctx: Context) => Promise<void>): Promise<void> {
  const ctx = new Context()
  const config = mountConfig(ctx, where.repository)
  await config
  const prompts = mountPrompts(ctx, where.state)
  await prompts
  try {
    await waitFor('the defaults to be seeded', async () => (await Promise.all(Object.keys(DEFAULTS_BY_PATH).map(path => ctx.dishConfig.read(path)))).every(text => text !== undefined))
    await body(ctx)
  } finally {
    await prompts.dispose()
    await config.dispose()
  }
}

test('at start, a document that is an earlier default becomes the current one, with the note; an edited one stays', async (t) => {
  if (!await historyOrSkip(t)) return
  const where = await dirs()
  const MAIN = 'prompts/main.md'
  const ARCHITECT = 'prompts/crew/architect.md'
  const CODER = 'prompts/crew/coder.md'
  const earlierMain = earlierText('main.md', PREVIOUS[MAIN]![0]!)
  const earlierArchitect = earlierText('crew/architect.md', PREVIOUS[ARCHITECT]![0]!)
  const editedCoder = `${earlierText('crew/coder.md', PREVIOUS[CODER]![0]!)}\nAnd be kind.\n`
  assert.notEqual(earlierMain, DEFAULTS.main)

  // First life: the person's store holds two earlier defaults (as an older dish seeded them) and an edit of a third.
  await withBoth(where, async (ctx) => {
    await userWrite(ctx.dishConfig, 'main', earlierMain)
    await userWrite(ctx.dishConfig, 'architect', earlierArchitect)
    await userWrite(ctx.dishConfig, 'coder', editedCoder)
  })

  let upgraded: string
  await withBoth(where, async (ctx) => {
    const store = ctx.dishConfig
    // The seed isn't awaited by start-up, so the upgrade lands a moment after the plugin is up.
    await waitFor('the earlier defaults to be replaced', async () => await store.read(MAIN) === DEFAULTS.main)
    assert.equal(await store.read(pathFor('architect')), DEFAULTS.architect)
    assert.equal(await store.read(CODER), editedCoder)
    // Every other document is as it was seeded.
    assert.equal(await store.read(pathFor('reviewer')), DEFAULTS.reviewer)
    assert.equal(await store.read(pathFor('common')), DEFAULTS.common)

    const [latest] = await store.history({ prefix: 'prompts/', limit: 1 })
    assert.deepEqual(latest!.author, { kind: 'system' })
    assert.equal(latest!.note, 'updated to the new defaults')
    assert.deepEqual(latest!.paths, [ARCHITECT, MAIN])
    upgraded = latest!.id
  })

  // Once replaced, a document is the current default: the next start finds nothing to do.
  await withBoth(where, async (ctx) => {
    assert.equal((await ctx.dishConfig.history({ prefix: 'prompts/', limit: 1 }))[0]!.id, upgraded)
    assert.equal(await ctx.dishConfig.read(CODER), editedCoder)
  })
})
