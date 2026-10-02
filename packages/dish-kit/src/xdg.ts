import { homedir } from 'node:os'
import path from 'node:path'

export interface XdgPaths {
  config: string
  data: string
  state: string
  cache: string
}

/**
 * Moves every dish directory of one instance at once: `<value>/{config,state,data,cache}/<app>`. dsh drops DSH_* names
 * from agent shells, so it never reaches an agent's commands, and no .env file can set it.
 */
export const INSTANCE_HOME = 'DSH_DISH_HOME'

/**
 * Resolve the XDG base directories for an app. A variable counts only when it
 * is set and absolute; the spec says relative values must be ignored.
 *
 * When DSH_DISH_HOME (INSTANCE_HOME) is set and absolute, it wins over the XDG variables and the home directory:
 * the four paths are `<it>/{config,data,state,cache}/<app>`. An empty or relative value is ignored.
 */
export function xdgPaths(
  app: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): XdgPaths {
  const instance = env[INSTANCE_HOME]
  if (instance && path.isAbsolute(instance)) {
    return {
      config: path.join(instance, 'config', app),
      data: path.join(instance, 'data', app),
      state: path.join(instance, 'state', app),
      cache: path.join(instance, 'cache', app),
    }
  }
  const base = (variable: string, fallback: string): string => {
    const value = env[variable]
    const root = value && path.isAbsolute(value) ? value : path.join(home, fallback)
    return path.join(root, app)
  }
  return {
    config: base('XDG_CONFIG_HOME', '.config'),
    data: base('XDG_DATA_HOME', '.local/share'),
    state: base('XDG_STATE_HOME', '.local/state'),
    cache: base('XDG_CACHE_HOME', '.cache'),
  }
}
