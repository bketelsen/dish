/**
 * `main.md` speaks to what the nsl session showed (docs/specs/nsl-session.md, decisions 2 and 5): when the chat is
 * read-only and the user asks for a change, the main agent says so before it starts and names the switch; and dish
 * updates only the pull requests it opened, so for one opened elsewhere it says so and offers a new pull request or the
 * user's own push.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULTS } from '../src/defaults.ts'

/** The section of `text` under the heading line `heading`, up to the next `## ` heading. */
function section(text: string, heading: string): string {
  const lines = text.split('\n')
  const start = lines.indexOf(heading)
  assert.ok(start >= 0, `no "${heading}" section`)
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '))
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n')
}

/** The one bullet of `main.md`'s section `heading` that includes `marker`. */
function onlyBullet(heading: string, marker: string): string {
  const found = section(DEFAULTS.main!, heading).split('\n').filter(line => line.startsWith('- ') && line.includes(marker))
  assert.equal(found.length, 1, `"${heading}" should have one bullet with "${marker}", has ${found.length}`)
  return found[0]!
}

test('main.md\'s In the chat says a read-only chat out loud before a change, and how to switch', () => {
  const bullet = onlyBullet('## In the chat', 'read-only')
  for (const part of ['read-only', 'runtime context', 'before you start', 'crew', '`/permission workspace-write`']) {
    assert.ok(bullet.includes(part), `${part}: ${bullet}`)
  }
})

test('main.md\'s Runs says dish updates only the pull requests it opened, and what to offer for one opened elsewhere', () => {
  const bullet = onlyBullet('## Runs', 'only the pull requests it opened')
  for (const part of ['only the pull requests it opened', '`dish/<slug>`', 'before you start', 'new run', 'new pull request', 'leave the push']) {
    assert.ok(bullet.includes(part), `${part}: ${bullet}`)
  }
})

test('the pull-request bullet sits with open_pr and review feedback, before the never-push bullet', () => {
  const bullets = section(DEFAULTS.main!, '## Runs').split('\n').filter(line => line.startsWith('- '))
  const at = (start: string): number => bullets.findIndex(line => line.startsWith(start))
  const feedback = at('- Review feedback on its pull request')
  const ours = at('- dish updates only the pull requests it opened')
  const never = at('- Never push yourself')
  assert.ok(feedback >= 0 && ours >= 0 && never >= 0, 'Runs has the three bullets')
  assert.ok(feedback < ours && ours < never, 'it comes after review feedback and before never push')
})
