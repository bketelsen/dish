import { homedir } from 'node:os'
import path from 'node:path'

export interface XdgPaths {
  config: string
  data: string
  state: string
  cache: string
}

/**
 * Resolve the XDG base directories for an app. A variable counts only when it
 * is set and absolute; the spec says relative values must be ignored.
 */
export function xdgPaths(
  app: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): XdgPaths {
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
