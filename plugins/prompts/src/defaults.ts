/**
 * The prompts dish ships, read once from `defaults/` next to `src/`. That directory is laid out like the
 * store (`common.md`, `main.md`, `crew/<role>.md`), so a role's file there is at `pathFor(role)` minus
 * the `prompts/` prefix.
 */
import { readFileSync } from 'node:fs'
import { CREW_ROLES, pathFor } from './roles.ts'
import type { Role } from './roles.ts'

const DIRECTORY = new URL('../defaults/', import.meta.url)

/** `role`'s shipped text. A missing file is a broken install, so it throws when this module loads. */
function load(role: Role): string {
  return readFileSync(new URL(pathFor(role).slice('prompts/'.length), DIRECTORY), 'utf8')
}

/** Every shipped prompt by role: `common`, `main` and the six crew roles. */
export const DEFAULTS: Readonly<Record<Role, string>> = Object.freeze(
  Object.fromEntries(['common', 'main', ...CREW_ROLES].map(role => [role, load(role)])))

/** The shipped prompt for `role`, or `undefined` if dish ships none (a crew role the user added). */
export function defaultText(role: Role): string | undefined {
  return Object.hasOwn(DEFAULTS, role) ? DEFAULTS[role] : undefined
}
