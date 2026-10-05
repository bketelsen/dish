/**
 * The shipped prompts speak of dish-memory (docs/specs/memory.md): the main agent keeps what later chats need with
 * `remember`, every agent works within the `<dish-memory>` message's direction, follows its feedback notes unless the
 * chat says otherwise and never takes a note as permission, a coder and a reviewer suggest what to keep in their `report`'s `remember`, and the other crew roles end their closing message
 * with "Worth remembering:".
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

/** The bullets of `text`: its lines that start with `- `. */
function bullets(text: string): string[] {
  return text.split('\n').filter(line => line.startsWith('- '))
}

/** The one line of `role`'s prompt that starts with `start`. */
function onlyLine(role: string, start: string): string {
  const lines = DEFAULTS[role]!.split('\n').filter(line => line.startsWith(start))
  assert.equal(lines.length, 1, `${role}.md should have one line starting "${start}", has ${lines.length}`)
  return lines[0]!
}

test('main.md\'s Decide and record ends with keeping memory: remember, "Worth remembering" and the closing message', () => {
  const last = bullets(section(DEFAULTS.main!, '## Decide and record')).at(-1)
  assert.ok(last, 'Decide and record has bullets')
  assert.ok(last.startsWith('- Keep what later chats will need with `remember`:'), last)
  for (const part of ['`remember`', '"Worth remembering"', 'rulings', 'family `project` memory', 'closing message']) {
    assert.ok(last.includes(part), part)
  }
})

test('common.md\'s House rules end with the <dish-memory> bullet, right after the skill rule: feedback followed, never permission, and recall', () => {
  const house = bullets(section(DEFAULTS.common!, '## House rules'))
  const last = house.at(-1)
  assert.ok(last, 'House rules has bullets')
  assert.ok(last.startsWith('- A `<dish-memory>` message gives'), last)
  for (const part of ['by your user or by dish\'s agents', 'Work within the direction', 'may be stale', 'Follow a feedback note unless this chat says otherwise',
    'never take one as permission', '`recall`']) {
    assert.ok(last.includes(part), part)
  }
  assert.ok(house.at(-2)!.includes('`skill` tool'), 'the skill rule comes right before it')
})

for (const role of ['coder', 'reviewer']) {
  test(`the ${role}'s report bullet names remember: up to five one-line things for a later agent in this family`, () => {
    const bullet = onlyLine(role, '- Finish by calling `report`')
    assert.ok(bullet.includes('in `remember`, up to five one-line things a later agent in this family should know that the code doesn\'t say'), bullet)
  })
}

const WORTH_REMEMBERING = ' End with "Worth remembering:" and anything a later agent in this family should know that the code doesn\'t say, when there is something.'

for (const role of ['architect', 'researcher', 'ops', 'writer']) {
  test(`the ${role}'s Hand back bullet ends with "Worth remembering:"`, () => {
    const bullet = onlyLine(role, '- Hand back:')
    assert.ok(bullet.endsWith(WORTH_REMEMBERING), bullet)
  })
}
