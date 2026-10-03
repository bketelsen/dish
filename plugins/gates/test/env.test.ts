import assert from 'node:assert/strict'
import { test } from 'node:test'
import { gateEnvironment } from '../src/env.ts'

const WHERE = { clone: '/w/acme/widget', worktree: '/w/acme/widget/.worktrees/fix-1' }

test('<clone> and <worktree> are expanded in the values, every one of them, and the names are left as they are', () => {
  const env = gateEnvironment({
    GOCACHE: '<clone>/.worktrees/.cache/go-build',
    WORK: '<worktree>',
    BOTH: '<clone>:<worktree>:<clone>/x:<worktree>/y',
    PLAIN: 'just text',
    clone_and_worktree: 'a <clone>b',
  }, WHERE)
  assert.deepEqual(env, {
    GOCACHE: '/w/acme/widget/.worktrees/.cache/go-build',
    WORK: '/w/acme/widget/.worktrees/fix-1',
    BOTH: '/w/acme/widget:/w/acme/widget/.worktrees/fix-1:/w/acme/widget/x:/w/acme/widget/.worktrees/fix-1/y',
    PLAIN: 'just text',
    clone_and_worktree: 'a /w/acme/widgetb',
  })
})

test('an expanded path is not expanded again, and other angle-bracket words are left alone', () => {
  const env = gateEnvironment({ A: '<clone>', B: '<CLONE> <home> <worktree' }, { clone: '/odd/<worktree>', worktree: '/wt' })
  assert.deepEqual(env, { A: '/odd/<worktree>', B: '<CLONE> <home> <worktree' })
})

test('nothing else is added: an empty gateEnv gives {}, with no cache variables (the user\'s decision, 2026-10-03)', () => {
  const env = gateEnvironment({}, WHERE)
  assert.deepEqual(env, {})
  for (const name of ['XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CONFIG_HOME', 'GOPATH', 'GOCACHE', 'npm_config_cache', 'CARGO_HOME', 'HOME']) {
    assert.equal(Object.hasOwn(env, name), false, name)
  }
  assert.deepEqual(Object.keys(gateEnvironment({ ONLY: 'x' }, WHERE)), ['ONLY'])
})

test('a new object every time: the project\'s map is never changed', () => {
  const given = Object.freeze({ A: '<clone>' })
  const one = gateEnvironment(given, WHERE)
  const two = gateEnvironment(given, WHERE)
  assert.notEqual(one, given)
  assert.notEqual(one, two)
  one.A = 'changed'
  assert.deepEqual(given, { A: '<clone>' })
  assert.deepEqual(two, { A: WHERE.clone })
})

test('a variable called __proto__ is kept as a variable', () => {
  const given: Record<string, string> = Object.fromEntries([['__proto__', '<worktree>']])
  const env = gateEnvironment(given, WHERE)
  assert.equal(Object.hasOwn(env, '__proto__'), true)
  assert.equal(Object.getOwnPropertyDescriptor(env, '__proto__')?.value, WHERE.worktree)
})
