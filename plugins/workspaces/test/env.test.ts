import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DSH_ENV_PREFIX, SENSITIVE_ENV_PATTERN, scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { DSH_PREFIX, SENSITIVE_NAME, childEnvironment } from '../src/env.ts'
import { DSH_PREFIX as REGISTRY_DSH_PREFIX, SECRET_NAME } from 'dish-projects/registry'
import { withEnv } from './helpers.ts'

const PINNED = "dsh changed its environment scrub; re-check dish-workspaces' env.ts"

test('childEnvironment drops credential-shaped, DSH_* and GIT_* names, keeps the rest, and adds GIT_TERMINAL_PROMPT=0', () => {
  const parent: NodeJS.ProcessEnv = {
    FOO_TOKEN: 'a', my_key: 'b', Secret_X: 'c', DSH_HOME: 'd', dsh_dish_home: 'e', GIT_DIR: 'f', GIT_CONFIG_PARAMETERS: 'g',
    git_lower: 'h', GIT_TERMINAL_PROMPT: '1', PATH: '/usr/bin', HOME: '/home/someone', LANG: 'C.UTF-8', UNSET: undefined,
  }
  assert.deepEqual(childEnvironment(parent), { PATH: '/usr/bin', HOME: '/home/someone', LANG: 'C.UTF-8', GIT_TERMINAL_PROMPT: '0' })
})

test('childEnvironment returns a new object, and reads process.env by default', async () => {
  const parent: NodeJS.ProcessEnv = { PATH: '/bin' }
  const child = childEnvironment(parent)
  child.PATH = '/elsewhere'
  assert.equal(parent.PATH, '/bin')
  assert.notEqual(childEnvironment(parent), childEnvironment(parent))
  await withEnv({ DISH_WS_TEST_PLAIN: 'kept', DISH_WS_TEST_TOKEN: 'dropped', DSH_WS_TEST: 'dropped', GIT_WS_TEST: 'dropped' }, async () => {
    const env = childEnvironment()
    assert.equal(env.DISH_WS_TEST_PLAIN, 'kept')
    for (const name of ['DISH_WS_TEST_TOKEN', 'DSH_WS_TEST', 'GIT_WS_TEST']) assert.equal(name in env, false, name)
  })
})

test("the scrub is pinned to dsh's own: same pattern, same prefix", () => {
  assert.equal(SENSITIVE_NAME.source, SENSITIVE_ENV_PATTERN.source, PINNED)
  assert.equal(SENSITIVE_NAME.flags, SENSITIVE_ENV_PATTERN.flags, PINNED)
  assert.equal(DSH_PREFIX, DSH_ENV_PREFIX, PINNED)
})

test("dish-projects' gateEnv rules are pinned to dsh's scrub too", () => {
  const pinned = "dsh changed its environment scrub; re-check dish-projects' src/registry.ts (SECRET_NAME, DSH_PREFIX)"
  assert.equal(SECRET_NAME.source, SENSITIVE_ENV_PATTERN.source, pinned)
  assert.equal(SECRET_NAME.flags, SENSITIVE_ENV_PATTERN.flags, pinned)
  assert.equal(REGISTRY_DSH_PREFIX, DSH_ENV_PREFIX, pinned)
})

test("childEnvironment drops every name dsh's scrubbedParentEnv drops, and GIT_* names besides", async () => {
  const vars = {
    DISH_WS_A_API_KEY: '1', dish_ws_a_password: '1', DISH_WS_A_SECRET_THING: '1', Dish_Ws_A_Token: '1', DISH_WS_A_KEYRING: '1',
    DSH_WS_A: '1', dsh_ws_a: '1', Dsh_Ws_A: '1', GIT_WS_A: '1', DISH_WS_A_PLAIN: '1', DISHDSH_WS_A: '1',
  }
  await withEnv(vars, async () => {
    const dsh = scrubbedParentEnv()
    const ours = childEnvironment()
    for (const name of Object.keys(vars)) {
      if (!(name in dsh)) assert.equal(name in ours, false, `${name}: dsh drops it, and so must dish (${PINNED})`)
    }
    assert.equal('GIT_WS_A' in ours, false)
    assert.equal(ours.DISH_WS_A_PLAIN, '1')
    assert.equal(ours.DISHDSH_WS_A, '1')
  })
})
