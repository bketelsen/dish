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
 * @module dish-gates/env
 */

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
