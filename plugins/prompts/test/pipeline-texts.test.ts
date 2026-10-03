/**
 * The shipped prompts speak of runs, `report` and `open_pr` (step 7, docs/specs/orchestrator.md, "Prompts and skills"):
 * the main agent opens and ends a run, nobody pushes with git, a coder and a reviewer finish with `report`, and a run's
 * branch is brought up to date by merging, never by rewriting it. The skills' side is `plugins/skills/test/defaults.test.ts`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULTS } from '../src/defaults.ts'
import { CREW_ROLES } from '../src/roles.ts'

/** The section of `text` under the heading line `heading`, up to the next `## ` heading. */
function section(text: string, heading: string): string {
  const lines = text.split('\n')
  const start = lines.indexOf(heading)
  assert.ok(start >= 0, `no "${heading}" section`)
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '))
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n')
}

/** The sentences of `text`: split at line breaks, and after a `.`, `!` or `?` that ends one. */
function sentences(text: string): string[] {
  return text.split(/\n+|(?<=[.!?])\s+/).filter(sentence => sentence.trim() !== '')
}

/** The sentences of `text` that name a rebase, an amend or a squash. */
function rewriting(text: string): string[] {
  return sentences(text).filter(sentence => /\b(rebase|amend|squash)/i.test(sentence))
}

test('main.md has a Runs section between Delegate and In the chat, naming run, open_pr and final review', () => {
  const text = DEFAULTS.main!
  const lines = text.split('\n')
  const delegate = lines.indexOf('## Delegate')
  const runs = lines.indexOf('## Runs')
  const chat = lines.indexOf('## In the chat')
  assert.ok(delegate >= 0 && runs >= 0 && chat >= 0, 'main.md has the three sections')
  assert.ok(delegate < runs && runs < chat, 'Runs comes after Delegate and before In the chat')
  const own = section(text, '## Runs')
  for (const pattern of [/action `open`/, /action `status`/, /`ruling`/, /`open_pr`/, /`final: true`/, /pushes to the same pull request/,
    /`pr_feedback`/, /never a rebase/, /no `git push`, no `gh pr create`/]) {
    assert.match(own, pattern)
  }
  // The main agent's own steps no longer include a push.
  assert.doesNotMatch(text, /, a push\)/)
})

test('main.md no longer stops for pushes, and open_pr isn\'t a stop', () => {
  const decide = section(DEFAULTS.main!, '## Decide and record')
  assert.doesNotMatch(decide, /pushes and merges/)
  assert.match(decide, /`open_pr` isn't one of them/)
})

test('common.md\'s first house rule opens pull requests with open_pr, and agents don\'t push', () => {
  const text = DEFAULTS.common!
  const first = section(text, '## House rules').split('\n').find(line => line.startsWith('- '))
  assert.ok(first, 'House rules has a first bullet')
  assert.ok(first.startsWith('- Humans merge.'), first)
  for (const part of ['`open_pr`', 'agents don\'t push', 'Never rebase, amend or squash']) assert.ok(first.includes(part), part)
  assert.doesNotMatch(text, /Open pull requests\./)
})

test('the coder finishes with report, and leaves the gate to dish when its brief says so', () => {
  const coder = DEFAULTS.coder!
  for (const pattern of [/Finish by calling `report`/, /`status`/, /`notFixed`/, /dish runs it when you `report` `done`/]) assert.match(coder, pattern)
  assert.doesNotMatch(coder, /Run the repo's gate before you say you're done/)
})

test('the reviewer finishes with report, with its verdict and the head it reviewed', () => {
  const reviewer = DEFAULTS.reviewer!
  for (const pattern of [/Finish by calling `report`/, /`verdict`/, /`head`/, /`should_fix`/]) assert.match(reviewer, pattern)
})

test('the other crew prompts have no report', () => {
  const others = CREW_ROLES.filter(role => role !== 'coder' && role !== 'reviewer')
  assert.deepEqual([...others].sort(), ['architect', 'ops', 'researcher', 'writer'])
  for (const role of others) assert.doesNotMatch(DEFAULTS[role]!, /`report`/, role)
})

test('no shipped prompt tells an agent to rebase: each rebase, amend or squash is in a sentence that says never', () => {
  const having: string[] = []
  for (const role of ['common', 'main', ...CREW_ROLES]) {
    const found = rewriting(DEFAULTS[role]!)
    for (const sentence of found) assert.match(sentence, /never/i, `${role}: ${sentence}`)
    if (found.length > 0) having.push(role)
  }
  assert.deepEqual(having.sort(), ['common', 'main'])
})
