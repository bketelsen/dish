/**
 * Roles and the documents that hold them.
 *
 * - `common` is the rules every role shares, `prompts/common.md`.
 * - `main` is the main agent, `prompts/main.md`.
 * - Any other role is a crew role, `prompts/crew/<role>.md`.
 *
 * The three namespaces the plugin claims in the config store are made here too.
 */
import type { NamespaceSpec } from 'dish-config'

/** `common`, `main`, or the name of a crew role. */
export type Role = string

/** The crew roles dish ships a default prompt for. A document under `prompts/crew/` may add more. */
export const CREW_ROLES: readonly Role[] = ['architect', 'coder', 'researcher', 'ops', 'writer', 'reviewer']

/** What a crew role may be called, and so what `<role>` in `prompts/crew/<role>.md` may be. */
const CREW_ROLE = /^[a-z][a-z0-9-]*$/

/** `common` and `main` have documents of their own, so a crew document can't take those names: no role would reach it. */
const RESERVED = ['common', 'main']

const COMMON_PATH = 'prompts/common.md'
const MAIN_PATH = 'prompts/main.md'
const CREW_PREFIX = 'prompts/crew/'
const CREW_SUFFIX = '.md'

/** The crew role a document name stands for, or `undefined` if it names none. */
function crewRole(name: string): Role | undefined {
  return CREW_ROLE.test(name) && !RESERVED.includes(name) ? name : undefined
}

/**
 * The store path of `role`'s document.
 * @throws a plain `Error` for a name that can't be a role.
 */
export function pathFor(role: Role): string {
  if (role === 'common') return COMMON_PATH
  if (role === 'main') return MAIN_PATH
  if (crewRole(role) === undefined) {
    throw new Error(`invalid role ${JSON.stringify(role)}: a role is "common", "main" or a crew role (lowercase letters, digits and hyphens, starting with a letter)`)
  }
  return `${CREW_PREFIX}${role}${CREW_SUFFIX}`
}

/** The role whose document is at `path`: the inverse of `pathFor`. `undefined` for any other path. */
export function roleFor(path: string): Role | undefined {
  if (path === COMMON_PATH) return 'common'
  if (path === MAIN_PATH) return 'main'
  if (!path.startsWith(CREW_PREFIX) || !path.endsWith(CREW_SUFFIX)) return undefined
  return crewRole(path.slice(CREW_PREFIX.length, -CREW_SUFFIX.length))
}

/**
 * Why `text` can't be the prompt at `path`, or `undefined` if it can. The path is judged first.
 * The store's own limits (size, secrets) are its business, not this function's.
 */
export function validate(path: string, text: string): string | undefined {
  if (roleFor(path) === undefined) {
    if (path.startsWith(CREW_PREFIX)) {
      return `${JSON.stringify(path)} isn't a crew prompt: prompts/crew/ holds one prompt per role, as prompts/crew/<role>.md, `
        + 'where <role> is lowercase letters, digits and hyphens starting with a letter (and not "common" or "main")'
    }
    return `${JSON.stringify(path)} is not a prompt document: use ${COMMON_PATH}, ${MAIN_PATH} or prompts/crew/<role>.md`
  }
  if (text.trim() === '') return 'a prompt can\'t be empty; use Reset to go back to the default'
  return undefined
}

/**
 * The claims on the config store, for `owner`. One claim can't give an agent two policies, and claims can't
 * overlap, so `common` and `main` (which an agent may only propose to) are claimed file by file, and the
 * crew roles (which it may write) as a subtree.
 */
export function namespaceSpecs(owner: string): NamespaceSpec[] {
  return [
    { prefix: COMMON_PATH, owner, agent: 'propose', validate },
    { prefix: MAIN_PATH, owner, agent: 'propose', validate },
    { prefix: CREW_PREFIX, owner, agent: 'write', validate },
  ]
}
