/**
 * The prompts dish ships, read once from `defaults/` next to `src/`. That directory is laid out like the
 * store (`common.md`, `main.md`, `crew/<role>.md`), so a role's file there is at `pathFor(role)` minus
 * the `prompts/` prefix.
 *
 * `defaults/previous.json` sits beside them: for each store path, the hashes of earlier shipped texts. A stored
 * document that still has one of those is an unedited default, and the seed moves it to the current text
 * (`replaceMap`). The file is written by `dish-kit/previous-defaults` from git history; see the README.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parsePrevious } from 'dish-kit'
import { CREW_ROLES, pathFor } from './roles.ts'
import type { Role } from './roles.ts'

const DIRECTORY = new URL('../defaults/', import.meta.url)

/** `role`'s shipped text. A missing file is a broken install, so it throws when this module loads. */
function load(role: Role): string {
  return readFileSync(new URL(pathFor(role).slice('prompts/'.length), DIRECTORY), 'utf8')
}

/**
 * Every shipped prompt by role: `common`, `main` and the six crew roles. It has no prototype, so a role
 * name that is also an `Object.prototype` member (`constructor` is a legal crew role) reads as undefined.
 */
export const DEFAULTS: Readonly<Record<Role, string>> = Object.freeze(Object.assign(
  Object.create(null) as Record<Role, string>,
  Object.fromEntries(['common', 'main', ...CREW_ROLES].map(role => [role, load(role)]))))

/** The shipped prompt for `role`, or `undefined` if dish ships none (a crew role the user added). */
export function defaultText(role: Role): string | undefined {
  return DEFAULTS[role]
}

/**
 * The earlier shipped texts, as hashes, by store path, read once when this module loads (`defaults/previous.json`).
 * Like a missing default, a missing or malformed file is a broken install, so it throws: it ships with the package,
 * and without it a stale default would quietly stay.
 */
export const PREVIOUS: Readonly<Record<string, readonly string[]>> = Object.freeze(parsePrevious(
  readFileSync(new URL('previous.json', DIRECTORY), 'utf8'),
  fileURLToPath(new URL('previous.json', DIRECTORY))))

/**
 * What `seed` takes as `replace`: `previous`'s hashes for the paths dish seeds. The store refuses a path that is not
 * in the defaults it is given, so a path of an older dish that ships no more is left out here. A fresh copy each call.
 */
export function replaceMap(previous: Readonly<Record<string, readonly string[]>> = PREVIOUS): Record<string, string[]> {
  const shipped = new Set(Object.keys(DEFAULTS).map(pathFor))
  return Object.fromEntries(Object.entries(previous).filter(([path]) => shipped.has(path)).map(([path, hashes]) => [path, [...hashes]]))
}
