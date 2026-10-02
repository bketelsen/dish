/**
 * The environment of every process dish-workspaces starts itself (its git, and `setup`).
 *
 * dsh gives every agent shell `scrubbedParentEnv()` (`@deepseek-ai/dsh-subprocess`): the process environment minus
 * credential-shaped names and `DSH_*` names. dish's own children get the same scrub, and lose every `GIT_*` name too:
 * `GIT_DIR`, `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_PARAMETERS` and the like would point git at another repository or config.
 * A test pins the pattern and the prefix to dsh's own, so a change there is noticed here.
 *
 * @module dish-workspaces/env
 */

/** Credential-shaped names, as dsh's `SENSITIVE_ENV_PATTERN`. */
export const SENSITIVE_NAME = /KEY|PASSWORD|SECRET|TOKEN/i
/** dsh's own names, as dsh's `DSH_ENV_PREFIX`; compared without case, as dsh does. */
export const DSH_PREFIX = 'DSH_'
/** git's own names; compared without case too. */
const GIT_PREFIX = 'GIT_'
/** ssh's GUI password prompt: `GIT_TERMINAL_PROMPT=0` doesn't stop git from running it (Task 3b's review). */
const ASKPASS = new Set(['SSH_ASKPASS', 'SSH_ASKPASS_REQUIRE'])

/**
 * `env` (default `process.env`) minus credential-shaped names, DSH_* names (case-insensitive, as dsh's
 * scrubbedParentEnv), every GIT_* name and SSH_ASKPASS(_REQUIRE), plus GIT_TERMINAL_PROMPT=0. Undefined values dropped. A new object.
 */
export function childEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const child: Record<string, string> = {}
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || SENSITIVE_NAME.test(name)) continue
    const upper = name.toUpperCase()
    if (upper.startsWith(DSH_PREFIX) || upper.startsWith(GIT_PREFIX) || ASKPASS.has(upper)) continue
    child[name] = value
  }
  child.GIT_TERMINAL_PROMPT = '0'
  return child
}
