/**
 * What the page knows of a skill's name, so that a name the store would refuse is refused before the editor opens on it.
 * The grammar is `skill.ts`'s (`SKILL_NAME` and `MAX_NAME`), copied: that file reads YAML and the store, and the browser
 * can't load it. `test/client-remote.test.ts` checks the copies against the originals. Plain TypeScript with no DOM or React
 * in it, so `node --test` can load it.
 * @module dish-skills/client/names
 */

/** dsh's skill-name grammar: lowercase letters and digits, in groups joined by single hyphens. */
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** The longest a skill's name may be. */
export const MAX_SKILL_NAME = 64

/** The longest a refused name is repeated back in a message. */
const SHOWN = 40

/**
 * What is wrong with `name` as the name of a new skill, in a sentence; `undefined` when nothing is.
 * @param name - already trimmed.
 * @param taken - the names the list already has, a shipped skill and one the store lost included.
 */
export function nameProblem(name: string, taken: readonly string[]): string | undefined {
  if (name === '') return 'Give the skill a name.'
  if (name.length > MAX_SKILL_NAME || !SKILL_NAME_PATTERN.test(name)) {
    const shown = name.length > SHOWN ? `${name.slice(0, SHOWN)}…` : name
    return `"${shown}" isn't a valid skill name: use lowercase letters, digits and single hyphens, at most ${MAX_SKILL_NAME} characters.`
  }
  if (taken.includes(name)) return `There is already a skill called "${name}".`
  return undefined
}
