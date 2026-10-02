import { test } from 'node:test'
import assert from 'node:assert/strict'
import { INSTANCE_HOME, xdgPaths } from '../src/xdg.ts'

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

test('DSH_DISH_HOME moves all four directories under one root', () => {
  assert.deepEqual(xdgPaths('dish', { DSH_DISH_HOME: '/inst' }, '/home/u'), {
    config: '/inst/config/dish', data: '/inst/data/dish', state: '/inst/state/dish', cache: '/inst/cache/dish',
  })
})

test('DSH_DISH_HOME beats the XDG variables', () => {
  const env = { DSH_DISH_HOME: '/inst', XDG_CONFIG_HOME: '/cfg', XDG_DATA_HOME: '/d', XDG_STATE_HOME: '/st', XDG_CACHE_HOME: '/c' }
  assert.deepEqual(xdgPaths('dish', env, '/home/u'), {
    config: '/inst/config/dish', data: '/inst/data/dish', state: '/inst/state/dish', cache: '/inst/cache/dish',
  })
})

test('DSH_DISH_HOME keeps the app name as the last segment', () => {
  assert.equal(xdgPaths('other', { DSH_DISH_HOME: '/inst' }, '/home/u').state, '/inst/state/other')
})

test('an empty or relative DSH_DISH_HOME is ignored, like a relative XDG variable', () => {
  const env = { XDG_CONFIG_HOME: '/cfg', XDG_STATE_HOME: '/st' }
  const expected = { config: '/cfg/dish', data: '/home/u/.local/share/dish', state: '/st/dish', cache: '/home/u/.cache/dish' }
  assert.deepEqual(xdgPaths('dish', { ...env, DSH_DISH_HOME: '' }, '/home/u'), expected)
  assert.deepEqual(xdgPaths('dish', { ...env, DSH_DISH_HOME: 'relative/inst' }, '/home/u'), expected)
  assert.deepEqual(xdgPaths('dish', { ...env, DSH_DISH_HOME: './inst' }, '/home/u'), expected)
})

test('INSTANCE_HOME names the variable', () => {
  assert.equal(INSTANCE_HOME, 'DSH_DISH_HOME')
})
