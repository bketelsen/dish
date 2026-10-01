/**
 * A live check of the decision log's wiring with the real key: a real call to Jev through the host plugin, with the key from
 * the environment given to it as dsh's credential store would, and then withheld content that holds the key. Neither the
 * log's lines nor the withheld file may have the key in them, in any of the forms the client hides it in.
 *
 * Not part of `pnpm test`: run it with `pnpm --filter dish-judge test:live`, with `TYPESAFE_API_KEY` in the environment.
 * Without it the test skips, with a message saying so. The key is never printed: nothing here writes it.
 */
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { secretKind } from 'dish-kit'
import * as plugin from '../src/index.ts'
import { dirs, provideStub } from '../test/helpers.ts'

const KEY = process.env.TYPESAFE_API_KEY?.trim()
const SKIP = KEY === undefined || KEY === ''
  ? 'TYPESAFE_API_KEY is not set: put it in the environment to run the live tests (pnpm --filter dish-judge test:live)'
  : false

/** Every file under `directory`, as its text. */
async function filesIn(directory: string): Promise<string[]> {
  const texts: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) texts.push(...await filesIn(path))
    else texts.push(await readFile(path, 'utf8'))
  }
  return texts
}

test('live: a real call is logged, and the real key is in neither the log nor withheld content', { skip: SKIP, timeout: 30_000 }, async () => {
  const key = KEY!
  const where = await dirs()
  const ctx = new Context()
  await provideStub(ctx, 'credentials', { resolve: async () => ({ value: key }) })
  const handle = ctx.plugin(plugin, { terminal: false, stateDirectory: where.state } as plugin.Config)
  await handle
  try {
    const asked = await ctx.get('judge')!.ask({
      state: 'The sky is blue.',
      questions: { weather: { type: 'noul', instructions: 'Is `state` a statement about the weather or the sky?' } },
      purpose: 'ask',
      subject: `ask_judge ${key}`,
      decide: () => ({ decision: 'pass' }),
    })
    assert.equal(asked.ok, true, asked.ok ? '' : asked.message.split(key).join('‹key›'))

    // What the screen would keep: content that holds the key, raw, JSON-escaped and URL-encoded.
    const id = await ctx.dishJudge.log.withhold({
      tool: 'web_fetch',
      content: `key ${key} json ${JSON.stringify(key).slice(1, -1)} url ${encodeURIComponent(key)} end`,
    })
    await ctx.dishJudge.log.flush()
    const kept = await ctx.dishJudge.log.withheld(id)
    assert.equal(kept?.content, 'key ‹key› json ‹key› url ‹key› end')

    const lines = (await ctx.dishJudge.log.read()).lines
    assert.equal(lines.length, 1)
    assert.equal(lines[0]!.decision, 'pass')
    assert.equal(lines[0]!.error, null)
    assert.equal(lines[0]!.subject, 'ask_judge ‹key›')

    const forms = new Set([key, JSON.stringify(key).slice(1, -1), encodeURIComponent(key)])
    for (const text of await filesIn(where.state)) {
      for (const form of forms) assert.ok(!text.includes(form), 'the key is in a file of the log')
    }
    // Which is the key's mask at work, not the secret patterns': the real key is not one they know.
    console.log('live: the real key matches a secret pattern:', secretKind(key) !== undefined)
  } finally {
    await handle.dispose()
  }
})
