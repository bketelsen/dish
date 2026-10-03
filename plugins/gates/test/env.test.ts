import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { gateEnvironment, miseShims, withMiseShims } from '../src/env.ts'
import { tempDir } from './helpers.ts'

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

// --- mise's shims on PATH ---------------------------------------------------------------------------------------

const SYSTEM = '/opt/dish/node/bin:/usr/local/bin:/usr/bin:/bin'

/** A scratch home, with mise's shims directory under its default data home when `shims` is true. */
async function home(shims: boolean): Promise<string> {
  const dir = join(await tempDir(), 'home')
  await mkdir(shims ? join(dir, '.local', 'share', 'mise', 'shims') : dir, { recursive: true })
  return dir
}

test('miseShims: $XDG_DATA_HOME/mise/shims when it is absolute, else ~/.local/share/mise/shims; none without an absolute HOME', () => {
  assert.equal(miseShims({ HOME: '/home/dish' }), '/home/dish/.local/share/mise/shims')
  assert.equal(miseShims({ HOME: '/home/dish', XDG_DATA_HOME: '/data' }), '/data/mise/shims')
  assert.equal(miseShims({ HOME: '/home/dish', XDG_DATA_HOME: 'relative' }), '/home/dish/.local/share/mise/shims')
  assert.equal(miseShims({ HOME: '/home/dish', XDG_DATA_HOME: '' }), '/home/dish/.local/share/mise/shims')
  assert.equal(miseShims({ XDG_DATA_HOME: '/data' }), '/data/mise/shims')
  assert.equal(miseShims({}), undefined)
  assert.equal(miseShims({ HOME: 'relative' }), undefined)
})

test('withMiseShims: dsh\'s PATH, then mise\'s shims, when the directory exists; the system\'s directories stay first', async () => {
  const at = await home(true)
  const env = await withMiseShims({ GOFLAGS: '-mod=mod' }, { PATH: SYSTEM, HOME: at })
  assert.deepEqual(env, { GOFLAGS: '-mod=mod', PATH: `${SYSTEM}:${at}/.local/share/mise/shims` })
  // Where XDG_DATA_HOME points, when it is absolute.
  const data = join(await tempDir(), 'data')
  await mkdir(join(data, 'mise', 'shims'), { recursive: true })
  assert.equal((await withMiseShims({}, { PATH: SYSTEM, HOME: at, XDG_DATA_HOME: data })).PATH, `${SYSTEM}:${data}/mise/shims`)
})

test('withMiseShims leaves the environment as it is: no shims directory, a gateEnv PATH, shims on PATH already, no PATH or HOME', async () => {
  const without = await home(false)
  assert.deepEqual(await withMiseShims({ A: '1' }, { PATH: SYSTEM, HOME: without }), { A: '1' })
  // A file where the directory would be isn't one.
  await mkdir(join(without, '.local', 'share', 'mise'), { recursive: true })
  await writeFile(join(without, '.local', 'share', 'mise', 'shims'), '')
  assert.deepEqual(await withMiseShims({}, { PATH: SYSTEM, HOME: without }), {})

  const at = await home(true)
  const shims = `${at}/.local/share/mise/shims`
  // A project's gateEnv PATH wins, as given.
  assert.deepEqual(await withMiseShims({ PATH: '/opt/tools/bin' }, { PATH: SYSTEM, HOME: at }), { PATH: '/opt/tools/bin' })
  assert.deepEqual(await withMiseShims({}, { PATH: `${shims}:${SYSTEM}`, HOME: at }), {}, 'on PATH already')
  assert.deepEqual(await withMiseShims({}, { HOME: at }), {}, 'dsh has no PATH: the shell\'s default stays')
  assert.deepEqual(await withMiseShims({}, { PATH: '', HOME: at }), {})
  assert.deepEqual(await withMiseShims({}, { PATH: SYSTEM }), {}, 'no HOME')
})

test('withMiseShims gives a new object, and never changes the one it is given', async () => {
  const at = await home(true)
  const given = Object.freeze({ A: '1' })
  const env = await withMiseShims(given, { PATH: SYSTEM, HOME: at })
  assert.notEqual(env, given)
  assert.deepEqual(given, { A: '1' })
  const untouched = await withMiseShims(given, { PATH: SYSTEM, HOME: '/nowhere' })
  assert.notEqual(untouched, given)
  assert.deepEqual(untouched, { A: '1' })
})
