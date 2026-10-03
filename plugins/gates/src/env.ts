/**
 * The environment a gate runs with, on top of dsh's own.
 *
 * A gate runs through dsh's shell, so it starts from the environment the coder's own sandboxed commands get: dsh's
 * process environment with dsh's scrub (no `DSH_*` names, nothing that looks like a credential). dish adds only the
 * project's `gateEnv` from `projects.yaml`, with `<clone>` and `<worktree>` expanded in its values. It sets no cache
 * variables of its own: no `HOME`, `XDG_*`, `GOPATH`, `npm_config_cache` or `CARGO_HOME`, and nothing pointed into the
 * clone (the user's decision, 2026-10-03). Pointing caches into the clone would hide mise's installs and trust records,
 * move pnpm's store, download Go's modules again for each clone, and make a gate run a command differently from the
 * coder's own run of it. On dish's VM the sandbox writes the home directory, so the caches are where the coder's
 * commands put them. Where it can't (dev without `DISH_SANDBOX_HOME=on`), a project points its caches into the clone
 * itself, with `gateEnv`.
 *
 * `gateEnv`'s names and values are validated by dish-projects' registry (6b): no `DSH_*`, nothing secret-looking, one
 * line, no NUL. Its values are never logged.
 *
 * **mise's shims.** One more thing is added (the controller's decision, 2026-10-03): when `gateEnv` doesn't set `PATH`,
 * the gate's `PATH` is dsh's own followed by mise's shims directory (`${XDG_DATA_HOME:-$HOME/.local/share}/mise/shims`),
 * when that directory exists (`withMiseShims`). The VM's unit has a `PATH` with no `go` or `cargo` on it
 * (`/opt/dish/node/bin:/usr/local/bin:/usr/bin:/bin`), so a gate such as `go test ./...` would exit 127, while the coder's
 * tools are installed with mise. The shims come after the system's directories, so dish's own node still comes first. A
 * shim runs `mise`, which runs the tool: inside the gate's sandbox, as everything the gate starts does. Since 2026-10-03
 * `deploy/dish-sandbox` puts the same directory at the end of every sandboxed command's `PATH` on the VM, so this matters
 * where it doesn't run (dev without `DISH_SANDBOX_HOME=on`); a directory on `PATH` already is not added twice.
 *
 * @module dish-gates/env
 */

import { stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

/** `<clone>` or `<worktree>`, as written in a `gateEnv` value. */
const TOKEN = /<(clone|worktree)>/g

/**
 * `gateEnv` with every `<clone>` and `<worktree>` in its values replaced, and nothing else added: no cache variables
 * (the user's decision, 2026-10-03). A new object. Each value is expanded in one pass, so a path that holds `<clone>` or
 * `<worktree>` itself isn't expanded again.
 */
export function gateEnvironment(gateEnv: Readonly<Record<string, string>>, where: { clone: string, worktree: string }): Record<string, string> {
  // Object.fromEntries defines each name as an own property, so even a variable called __proto__ stays a variable.
  return Object.fromEntries(Object.entries(gateEnv).map(([name, value]) => [
    name,
    value.replace(TOKEN, (_match, token: string) => token === 'clone' ? where.clone : where.worktree),
  ]))
}

/** What `withMiseShims` reads of dsh's own environment. */
export interface BaseEnvironment {
  PATH?: string | undefined
  HOME?: string | undefined
  XDG_DATA_HOME?: string | undefined
}

/**
 * Where mise keeps its shims for dsh's environment `base`: `$XDG_DATA_HOME/mise/shims` when that is absolute (as for
 * dish-kit's xdgPaths), else `$HOME/.local/share/mise/shims`; `undefined` without an absolute `HOME` for the second.
 */
export function miseShims(base: Readonly<BaseEnvironment>): string | undefined {
  const data = base.XDG_DATA_HOME
  if (data !== undefined && isAbsolute(data)) return join(data, 'mise', 'shims')
  const home = base.HOME
  return home !== undefined && isAbsolute(home) ? join(home, '.local', 'share', 'mise', 'shims') : undefined
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/**
 * `env` (a gate's, from `gateEnvironment`) with `PATH` set to dsh's own `PATH` (`base.PATH`) and then mise's shims
 * directory (`miseShims(base)`), when that directory exists. Left as it is (a copy) when `env` sets `PATH` (a project's
 * `gateEnv` wins as given), when dsh has no `PATH` (the shell's default stays), when there is no shims directory, or when
 * it is on dsh's `PATH` already. A new object; never throws.
 */
export async function withMiseShims(env: Readonly<Record<string, string>>, base: Readonly<BaseEnvironment>): Promise<Record<string, string>> {
  const copy = { ...env }
  if (Object.hasOwn(env, 'PATH')) return copy
  const path = base.PATH
  const shims = miseShims(base)
  if (path === undefined || path === '' || shims === undefined) return copy
  if (path.split(':').includes(shims) || !await isDirectory(shims)) return copy
  return { ...copy, PATH: `${path}:${shims}` }
}
