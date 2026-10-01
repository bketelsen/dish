import { test } from 'node:test'
import assert from 'node:assert/strict'
import { xdgPaths } from '../src/xdg.ts'

test('defaults follow the XDG base directory spec', () => {
  assert.deepEqual(xdgPaths('dish', {}, '/home/u'), {
    config: '/home/u/.config/dish', data: '/home/u/.local/share/dish',
    state: '/home/u/.local/state/dish', cache: '/home/u/.cache/dish',
  })
})

test('absolute XDG variables win; relative ones are ignored per spec', () => {
  const env = { XDG_CONFIG_HOME: '/cfg', XDG_DATA_HOME: 'relative', XDG_STATE_HOME: '/st', XDG_CACHE_HOME: '/c' }
  assert.deepEqual(xdgPaths('dish', env, '/home/u'), {
    config: '/cfg/dish', data: '/home/u/.local/share/dish', state: '/st/dish', cache: '/c/dish',
  })
})

test('an empty XDG variable counts as unset', () => {
  assert.equal(xdgPaths('dish', { XDG_CACHE_HOME: '' }, '/home/u').cache, '/home/u/.cache/dish')
})
