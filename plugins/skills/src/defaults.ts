/**
 * The skills dish ships, read once from `defaults/` next to `src/`. That directory is laid out like the store:
 * the skill `<name>` is the file `defaults/<name>/SKILL.md`, which is the store path `pathFor(name)` minus the
 * `skills/` prefix. Files at the top of `defaults/` (`NOTICE.md`, `previous.json`) are not skills.
 *
 * `previous.json` holds, for each store path, the sha256 of every earlier shipped text (see
 * `packages/dish-kit/src/defaults.ts`), so that `seed` can move a stored default that was never edited to the new text.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parsePrevious } from 'dish-kit'
import { SKILL_FILE, isSkillName, pathFor } from './skill.ts'

const DIRECTORY = new URL('../defaults/', import.meta.url)

/**
 * Every `<dir>/SKILL.md` of `defaults/`, by directory name. A directory that can't be a skill's, or has no `SKILL.md`,
 * is a broken install, so this throws when the module loads.
 */
function loadDefaults(): Record<string, string> {
  const loaded: [string, string][] = []
  for (const entry of readdirSync(DIRECTORY, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (!isSkillName(entry.name)) throw new Error(`${fileURLToPath(DIRECTORY)}${entry.name} is not a skill name; shipped skills are in defaults/<name>/${SKILL_FILE}`)
    loaded.push([entry.name, readFileSync(new URL(`${entry.name}/${SKILL_FILE}`, DIRECTORY), 'utf8')])
  }
  return Object.fromEntries(loaded.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
}

/**
 * Every shipped skill's text by name. It has no prototype, so a name that is also an `Object.prototype` member
 * (`constructor` is a legal skill name) reads as undefined. Frozen.
 */
export const DEFAULTS: Readonly<Record<string, string>> = Object.freeze(Object.assign(Object.create(null) as Record<string, string>, loadDefaults()))

/**
 * The sha256 of earlier shipped texts, by store path (`skills/<name>/SKILL.md`), from `defaults/previous.json`. A
 * missing or malformed file is a broken install, so this throws when the module loads.
 */
export const PREVIOUS: Readonly<Record<string, readonly string[]>> = (() => {
  const file = new URL('previous.json', DIRECTORY)
  const parsed = parsePrevious(readFileSync(file, 'utf8'), fileURLToPath(file))
  return Object.freeze(Object.fromEntries(Object.entries(parsed).map(([path, hashes]) => [path, Object.freeze(hashes)])))
})()

/** The shipped text of the skill called `name`, or `undefined` if dish ships none. */
export function defaultText(name: string): string | undefined {
  return DEFAULTS[name]
}

/** The shipped skills by their path in the store, which is what `seed` takes. A new object each time. */
export function defaultsByPath(): Record<string, string> {
  return Object.fromEntries(Object.entries(DEFAULTS).map(([name, text]) => [pathFor(name), text]))
}

/**
 * What to hand `seed` as `replace`: the earlier texts' hashes of each path that is shipped now. A path in `previous`
 * that isn't shipped any more (a skill dish dropped) is left out, because `seed` refuses a `replace` for a path
 * that is not in its defaults.
 */
export function replaceMap(previous: Readonly<Record<string, readonly string[]>> = PREVIOUS): Record<string, string[]> {
  const shipped = defaultsByPath()
  return Object.fromEntries(Object.entries(previous)
    .filter(([path]) => Object.hasOwn(shipped, path))
    .map(([path, hashes]) => [path, [...hashes]]))
}
