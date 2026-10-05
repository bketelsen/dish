/**
 * The shipped prompts speak of dish-browser (docs/specs/browser.md, "Prompts and skills"): `common.md` says how to look at
 * a page with the `browser_*` tools and how a dev server runs in the background, `main.md` says which crew roles can
 * look at pages, and the coder, the reviewer and the writer are told when to. The researcher, the architect and ops
 * have no browser tool in `crew.yaml`, and their prompts don't mention one.
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

/** `common.md`'s last two bullets, which come right before its working-directory line. */
function lastTwoBullets(): [string, string] {
  const lines = DEFAULTS.common!.split('\n')
  const cwd = lines.findIndex(line => line.startsWith('Your working directory is'))
  assert.ok(cwd >= 0, 'common.md has a working-directory line')
  const bullets = lines.map((line, index) => ({ line, index })).filter(({ line }) => line.startsWith('- '))
  const [browser, devServer] = bullets.slice(-2)
  assert.ok(browser && devServer, 'common.md has two bullets')
  assert.ok(devServer.index < cwd, 'the bullets come before the working-directory line')
  assert.equal(devServer.index, browser.index + 1, 'the two bullets are next to each other')
  assert.deepEqual(lines.slice(devServer.index + 1, cwd), [''], 'nothing but a blank line between them and the working-directory line')
  return [browser.line, devServer.line]
}

test('common.md no longer says a background process ends with its call', () => {
  assert.ok(!DEFAULTS.common!.includes('since a call\'s processes end with it'))
})

test('common.md\'s last two bullets, before the working-directory line: the browser tools, then dev servers and the fallback', () => {
  const [browser, devServer] = lastTwoBullets()
  assert.ok(browser.startsWith('- Where you have the `browser_*` tools, look at pages with them.'), browser)
  for (const part of ['`browser_navigate`', 'Never type a password or a token into a page', 'ask the user to sign in in the Browser tab', 'ask first', 'CAPTCHA']) {
    assert.ok(browser.includes(part), part)
  }
  assert.ok(devServer.startsWith('- Run a dev server in the background:'), devServer)
  for (const part of ['`run_in_background: true`', '`job_kill`', '`job_output`', 'http://127.0.0.1:<port>', 'Without the browser tools', '`xmllint --noout <file>`', 'say what you couldn\'t check']) {
    assert.ok(devServer.includes(part), part)
  }
  // Both bullets are under This machine, its last ones.
  const machine = section(DEFAULTS.common!, '## This machine')
  assert.ok(machine.includes(browser) && machine.includes(devServer))
})

test('main.md\'s Delegate section says the coder, the reviewer and the writer can look at pages, and leaves screenshots to them', () => {
  const delegate = section(DEFAULTS.main!, '## Delegate')
  assert.ok(delegate.includes('the browser tools'))
  assert.ok(delegate.includes('`browser_read`'))
  assert.ok(delegate.includes('leave screenshots to them'))
})

const CREW_SENTENCES: Record<string, string> = {
  coder: '- For a change someone will see in a browser, look at it before you report: run the dev server in the background, open it with the browser tools, and check the change, with a screenshot when the look matters. Say what you saw in your `summary`.',
  reviewer: '- For a change to a UI, look at it yourself in the browser. Don\'t take a report\'s word for how it looks.',
  writer: '- When you write about a page, or docs that render, check the page in the browser.',
}

for (const [role, sentence] of Object.entries(CREW_SENTENCES)) {
  test(`the ${role}'s prompt tells it to look in the browser, in a bullet before its Skills line`, () => {
    const lines = DEFAULTS[role]!.split('\n')
    const at = lines.indexOf(sentence)
    assert.ok(at >= 0, `${role}.md lacks: ${sentence}`)
    assert.ok(at < lines.findIndex(line => line.startsWith('- Skills:')), 'before the Skills line')
    assert.ok(!sentence.includes('`send_message`'))
  })
}

test('the researcher\'s, the architect\'s and ops\'s prompts mention no browser tool', () => {
  for (const role of ['researcher', 'architect', 'ops']) assert.ok(!DEFAULTS[role]!.includes('browser_'), role)
})
