import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { GitResult } from '../src/git.ts'
import { PUSH_ENV, PUSH_TIMEOUT_MS, pushArgs, pushFailure } from '../src/push.ts'

const VALUE = "!/bin/sh '/opt/dish/plugins/workspaces/bin/git-credential-dish-push' 'https://github.com'"
const URL = 'https://github.com/acme/widget.git'
/** Shaped like a GitHub installation token (`ghs_` and 36 letters and digits); not one. */
const TOKEN = `ghs_${'Ab1Cd2Ef3G'.repeat(3)}Hi4Jk5`
const HINT = "The branch on GitHub has commits this one doesn't: have a coder merge `origin/dish/fix-1` into the run's worktree, then call `open_pr` again. dish never forces a push."

function result(stdout: string, stderr: string, code = 1): GitResult {
  return { code, stdout, stderr, timedOut: false, aborted: false }
}

/** git push --porcelain's stdout for one ref. */
function porcelain(flag: string, summary: string, branch = 'dish/fix-1'): string {
  return `To ${URL}\n${flag}\trefs/heads/${branch}:refs/heads/${branch}\t${summary}\nDone\n`
}

test('pushArgs: the helper reset then dish\'s push helper, no redirects, --porcelain, the URL, and refs/heads/dish/<slug>:refs/heads/dish/<slug>; never --force, + or a delete', () => {
  const args = pushArgs('/s/dish/workspaces/acme/widget/push-x1', URL, 'dish/fix-1', VALUE)
  assert.deepEqual(args, [
    '--git-dir', '/s/dish/workspaces/acme/widget/push-x1',
    '-c', 'credential.helper=', '-c', `credential.helper=${VALUE}`, '-c', 'http.followRedirects=false',
    'push', '--porcelain', URL, 'refs/heads/dish/fix-1:refs/heads/dish/fix-1',
  ])
  for (const arg of args) {
    assert.ok(!/^--(?:force|delete|mirror|all|tags|follow-tags|prune|set-upstream|no-verify)/.test(arg), arg)
    assert.ok(!/^-[a-zA-Z]*[fdu]/.test(arg) || arg === '-c', arg)
    assert.ok(!arg.startsWith('+') && !arg.startsWith(':'), arg)
  }
  // The push itself names exactly one refspec, after the URL.
  assert.equal(args.slice(args.indexOf('push')).length, 4)
  assert.equal(PUSH_TIMEOUT_MS, 600_000)
  assert.deepEqual(PUSH_ENV, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' })
  assert.ok(Object.isFrozen(PUSH_ENV))
})

test('pushArgs refuses a branch that isn\'t dish/<slug> (main, dish/../x, +dish/x, dish/X)', () => {
  for (const branch of [
    'main', 'dish/../x', '+dish/x', 'dish/X', 'dish/', 'dish/-x', 'dish/x/y', 'refs/heads/dish/x', 'dish/x:refs/heads/main',
    ':dish/x', 'dish/x y', 'dish/x\n', `dish/${'a'.repeat(41)}`, '',
  ]) {
    assert.throws(() => pushArgs('/s/push-x', URL, branch, VALUE), /dish pushes only a dish\/<slug> branch/, JSON.stringify(branch))
  }
  assert.doesNotThrow(() => pushArgs('/s/push-x', URL, `dish/${'a'.repeat(40)}`, VALUE))
})

test('pushFailure: a porcelain rejection with remote: lines; a fetch first with dish\'s merge hint, naming origin/dish/<slug> and open_pr; a 403\'s remote: and fatal: lines; masked and cut to 600', () => {
  // A pre-receive hook's refusal: the summary, then the first five non-empty remote: lines, trimmed.
  const hook = pushFailure(result(
    porcelain('!', '[remote rejected] (pre-receive hook declined)'),
    ['remote: no pushes on Fridays', 'remote: ', 'remote:    ask again on Monday   ', 'remote: 3', 'remote: 4', 'remote: 5', 'remote: 6',
      `error: failed to push some refs to '${URL}'`, ''].join('\n'),
  ), 'dish/fix-1')
  assert.equal(hook, 'GitHub refused the push of dish/fix-1: [remote rejected] (pre-receive hook declined) — no pushes on Fridays ask again on Monday 3 4 5')

  // Behind GitHub's branch: fetch first, or non-fast-forward, and dish's hint: merge, never force.
  const behind = pushFailure(result(
    porcelain('!', '[rejected] (fetch first)'),
    `error: failed to push some refs to '${URL}'\nhint: Updates were rejected because the remote contains work that you do not\n`,
  ), 'dish/fix-1')
  assert.equal(behind, `GitHub refused the push of dish/fix-1: [rejected] (fetch first). ${HINT}`)
  const diverged = pushFailure(result(porcelain('!', '[rejected] (non-fast-forward)'), ''), 'dish/fix-1')
  assert.equal(diverged, `GitHub refused the push of dish/fix-1: [rejected] (non-fast-forward). ${HINT}`)
  assert.equal(pushFailure(result(porcelain('!', '[rejected] (non-fast-forward)', 'dish/other'), ''), 'dish/other').includes('`origin/dish/other`'), true)
  // No hint for anything else.
  assert.ok(!hook.includes('merge'))

  // A 403 (a token without Contents write): no ! line, so the remote: lines and the last fatal: line.
  const denied = pushFailure(result('', [
    'remote: Write access to repository not granted.',
    `fatal: unable to access '${URL}/': The requested URL returned error: 403`, '',
  ].join('\n'), 128), 'dish/fix-1')
  assert.equal(denied, `GitHub refused the push of dish/fix-1: Write access to repository not granted. — fatal: unable to access '${URL}/': The requested URL returned error: 403`)
  // Only the last fatal: or error: line.
  assert.equal(pushFailure(result('', 'error: one\nfatal: two\nsomething else\n', 128), 'dish/fix-1'), 'GitHub refused the push of dish/fix-1: fatal: two')
  // Nothing to say: the exit code.
  assert.equal(pushFailure(result('', '', 1), 'dish/fix-1'), 'GitHub refused the push of dish/fix-1: git push exited 1')

  // Masked: a token and a URL password, wherever they are; control characters made plain.
  const leaky = pushFailure(result(
    porcelain('!', `[remote rejected] (${TOKEN})`),
    `remote: token ${TOKEN} refused\nremote: see https://x-access-token:${TOKEN.slice(4)}@github.com/acme/widget.git\x07\n`,
  ), 'dish/fix-1')
  assert.ok(!leaky.includes(TOKEN) && !leaky.includes(TOKEN.slice(4)), leaky)
  assert.ok(!/[\x00-\x1f\x7f]/.test(leaky))
  assert.match(leaky, /x-access-token:\*\*\*@github\.com/)

  // Cut to 600 characters, the hint kept whole.
  const long = pushFailure(result(porcelain('!', '[rejected] (fetch first)'), `remote: ${'x'.repeat(5_000)}\n`), 'dish/fix-1')
  assert.ok(Array.from(long).length <= 600, String(long.length))
  assert.ok(long.endsWith(HINT), long)
  const longer = pushFailure(result('', `remote: ${'y'.repeat(5_000)}\n`), 'dish/fix-1')
  assert.equal(Array.from(longer).length, 600)
  assert.ok(longer.endsWith('…'))
})
