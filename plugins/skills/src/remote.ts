/**
 * The server half of Settings → Skills: a Typert remote service the browser calls through
 * `ctx.remote.dishSkills`.
 *
 * It is built like `dish-prompts`' remote (which is built like `dish-config`'s), and for the same reasons:
 *
 * - the gateway serves any root service that carries a `typertRemote` binding and `@Remote` markers, reading wire
 *   parameter names from the method source (so every parameter is a plain identifier). This package runs as
 *   type-stripped `.ts`, which has no decorator syntax, so the markers are applied by `markRemote`;
 * - every parameter is plain JSON, and `''` means absent: no base, no note (`reset`'s note then defaults to `RESET_NOTE`);
 * - every write is made as the user, a person at the keyboard;
 * - a refusal the person can act on comes back as `{ ok: false, code, message }`, not as a throw: Typert has a
 *   closed set of failure codes, and its gateway folds anything thrown into `gateway/internal`. That covers the
 *   store's own codes, matched on `.code` (an error class from another package is not recognised by `instanceof`),
 *   and two of this remote's own: `INVALID` for a name that can't be a skill's (it comes off the wire), and
 *   `UNAVAILABLE` for a write with no store running. Anything else is a bug, and is thrown.
 *
 * The store is optional (`dishConfig`) and looked up on every call. Without it `skills`, `read` and `check` answer
 * with the shipped defaults, and `save`, `reset` and `remove` are `UNAVAILABLE`.
 *
 * The list is read straight from the store at one commit, not through the service's catalog, so that the commit it
 * reports, the documents it shows and the shipped skills it finds missing are one moment of the store. The catalog
 * is the agents' view (and serves the defaults while a store holds no skill at all); this is the person's, and a
 * shipped skill that is gone from the store is shown as such.
 *
 * @module dish-skills/remote
 */

import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { CommitInfo as StoreCommitInfo, DishConfigService, ErrorCode as StoreErrorCode, WriteMeta } from 'dish-config'
import { markRemote } from 'dish-kit'
import { NAMESPACE, RESET_NOTE } from './protocol.ts'
import type { CheckResult, CommitInfo, ErrorCode, Outcome, ReadResult, SkillInfo, SkillsResult } from './protocol.ts'
import type { DishSkills } from './service.ts'
import { SKILLS_PREFIX, checkSkill, nameFor, parseSkill, pathFor } from './skill.ts'
import type { ParseResult, SkillCheck } from './skill.ts'

/** The Cordis service key. (The wire namespace is `NAMESPACE`.) */
export const SERVICE = 'dishSkillsRemote'

declare module '@deepseek-ai/cordis' {
  interface Context {
    dishSkillsRemote: SkillsRemote
  }
}

// What the page is told must be what the store says: these fail to compile if either side drifts.
type Same<A, B> = [A] extends [B] ? [B] extends [A] ? SameKeys<A, B> : false : false
/** Mutual assignability lets a field that is optional on one side only through: the keys of two objects must be the same too. */
type SameKeys<A, B> = [A] extends [object] ? [B] extends [object] ? ([keyof A] extends [keyof B] ? [keyof B] extends [keyof A] ? true : false : false) : true : true
type Check<T extends true> = T
export type WireMatchesStore = [
  Check<Same<StoreErrorCode, Exclude<ErrorCode, 'UNAVAILABLE'>>>,
  Check<Same<StoreCommitInfo, CommitInfo>>,
]

/** Every code the store throws on purpose, as an object so that a code the store adds is a compile error here. */
const STORE_CODES: Record<StoreErrorCode, true> = {
  CONFLICT: true, INVALID: true, UNOWNED: true, FORBIDDEN: true, SECRET: true, TOO_LARGE: true, LOCKED: true, STALE: true, NOT_FOUND: true,
}

function isStoreCode(code: unknown): code is StoreErrorCode {
  return typeof code === 'string' && Object.hasOwn(STORE_CODES, code)
}

/** A refusal made here, with the code the page sees. */
class Refusal extends Error {
  code: ErrorCode

  constructor(code: ErrorCode, message: string) {
    super(message)
    this.name = 'Refusal'
    this.code = code
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** `value` as the wire will carry it: JSON, with no key (or array item) left `undefined`. */
function wire<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/**
 * A string parameter. They arrive off the wire untyped: a missing one is `undefined` (the client leaves out an `undefined`
 * positional), which is as good as `''`, the page's own way to say "absent". Anything else that is not a string gets
 * `INVALID`, not a `TypeError`.
 */
function stringOf(name: string, value: unknown): string {
  if (value === undefined) return ''
  if (typeof value !== 'string') throw new Refusal('INVALID', `${name} must be a string`)
  return value
}

/** A skill name, as it comes off the wire: a string `pathFor` accepts (it is the judge of the grammar). */
function skillName(value: unknown): string {
  if (typeof value !== 'string') throw new Refusal('INVALID', 'name must be a string')
  try {
    pathFor(value)
  } catch (error) {
    throw new Refusal('INVALID', describe(error))
  }
  return value
}

/** Run `task` and put what it returns, or a refusal, in an `Outcome`; any other failure is thrown. */
async function outcome<T>(task: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: wire(await task()) }
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code
    if (error instanceof Refusal || (error instanceof Error && isStoreCode(code))) {
      return { ok: false, code: (error as Refusal).code, message: error.message }
    }
    throw error
  }
}

/** The store, or the refusal a write has without one. */
function storeToWrite(ctx: Context): DishConfigService {
  const store = ctx.get('dishConfig')
  if (store === undefined) throw new Refusal('UNAVAILABLE', 'the config store isn\'t running, so skills can\'t be saved')
  return store
}

/** What a write by the user carries: the note and the base when there are any. */
function metaOf(base: string, note: string): WriteMeta {
  const meta: WriteMeta = { author: { kind: 'user' } }
  if (note !== '') meta.note = note
  if (base !== '') meta.base = base
  return meta
}

/** Write `content` as the skill `name`'s document, as the user. `null` when it is what the document has already. */
async function put(ctx: Context, name: string, content: string, base: string, note: string): Promise<CommitInfo | null> {
  return await storeToWrite(ctx).write([{ path: pathFor(name), text: content }], metaOf(base, note)) ?? null
}

/** Why a shipped skill can't be removed, and what to do instead. */
const SHIPPED_NOT_REMOVABLE = 'a shipped skill comes back at the next start; turn it off with `roles: []` instead'

/** A skill document, and whether the store has it. */
export interface Entry {
  name: string
  path: string
  text: string
  /** The text is the store's. `false` for a shipped default that stands in for a skill the store lacks (or for there being no store). */
  stored: boolean
}

/** What the list says of `entry`, given the shipped text of its name (if any) and the proposals that touch its path. */
export function infoFor(
  entry: Entry,
  shipped: string | undefined,
  store: boolean,
  pending: number,
  parse: (path: string, text: string) => ParseResult = parseSkill,
): SkillInfo {
  const base = {
    name: entry.name,
    path: entry.path,
    shipped: shipped !== undefined,
    differsFromDefault: entry.stored && shipped !== undefined && entry.text !== shipped,
    missing: store && !entry.stored,
    pendingProposals: pending,
  }
  // Nothing is offered from a document that doesn't parse, and the page has no description or roles to show for it.
  const broken = (problem: string): SkillInfo => ({
    ...base, description: '', roles: null, modelInvocable: false, userInvocable: false, problem,
  })
  // One parse, guarded: a hand-committed document that makes the parser throw is a row with a problem, and costs the list nothing.
  try {
    const result = parse(entry.path, entry.text)
    if (!result.ok) {
      // The page shows the path beside the problem, so the sentence does not repeat it.
      const prefix = `${entry.path}: `
      return broken(result.problem.startsWith(prefix) ? result.problem.slice(prefix.length) : result.problem)
    }
    const { skill } = result
    return {
      ...base,
      description: skill.description,
      roles: skill.roles,
      modelInvocable: skill.modelInvocable,
      userInvocable: skill.userInvocable,
      problem: '',
    }
  } catch (error) {
    return broken(`the document can't be read: ${describe(error)}`)
  }
}

/** The rows of the list, sorted by name: `infoFor` for each entry, with the proposals pending per path. */
export function rowsFor(
  entries: readonly Entry[],
  defaultText: (name: string) => string | undefined,
  store: boolean,
  pending: ReadonlyMap<string, number>,
  parse?: (path: string, text: string) => ParseResult,
): SkillInfo[] {
  return [...entries]
    .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    .map(entry => infoFor(entry, defaultText(entry.name), store, pending.get(entry.path) ?? 0, parse))
}

/**
 * `checkSkill`, guarded: what `check` answers for `text`. A check that throws (a parser bug, on a text nobody
 * thought of) is a problem with the document, as it is in the list, and not an error the page can't read.
 */
export function checkDocument(path: string, text: string, knownRoles: readonly string[], check: (path: string, text: string, knownRoles: readonly string[]) => SkillCheck = checkSkill): CheckResult {
  let checked: SkillCheck
  try {
    checked = check(path, text, knownRoles)
  } catch (error) {
    return { problems: [`${path}: the document can't be read: ${describe(error)}`], warnings: [], summary: null }
  }
  const parsed = checked.problems.length === 0 ? checked.skill : null
  return {
    problems: checked.problems,
    warnings: checked.warnings,
    summary: parsed === null
      ? null
      : { description: parsed.description, roles: parsed.roles, modelInvocable: parsed.modelInvocable, userInvocable: parsed.userInvocable, chars: text.length },
  }
}

export class SkillsRemote extends TypertRemoteService {
  static inject = ['dishSkills']

  constructor(ctx: Context) {
    super(ctx, SERVICE, { namespace: NAMESPACE })
  }

  /**
   * The skills, sorted by name: every document under `skills/<name>/SKILL.md` at the store's head (a document that
   * doesn't parse shows its `problem`), and every shipped skill that has none, as `missing`. Each says whether it
   * differs from the shipped default and how many open or stale proposals would change it.
   * Without a store it is the shipped skills, `commit: ''`, and nothing is missing or pending.
   */
  async skills(): Promise<Outcome<SkillsResult>> {
    return outcome(async () => {
      const service: DishSkills = this.ctx.dishSkills
      const roles = await service.knownRoles()
      const store = this.ctx.get('dishConfig')
      const entries = new Map<string, Entry>()
      const addShipped = (): void => {
        for (const name of service.shipped()) {
          const text = service.defaultText(name)
          if (text !== undefined && !entries.has(name)) entries.set(name, { name, path: pathFor(name), text, stored: false })
        }
      }
      const pending = new Map<string, number>()
      let commit = ''
      if (store === undefined) {
        addShipped()
      } else {
        // The documents at one commit, so the list is one moment of the store.
        commit = await store.head()
        const [paths, proposals] = await Promise.all([store.list(SKILLS_PREFIX, commit), store.proposals()])
        const stored = await Promise.all(paths.flatMap((path) => {
          const name = nameFor(path)
          return name === undefined ? [] : [store.read(path, commit).then((text): Entry | undefined => text === undefined ? undefined : { name, path, text, stored: true })]
        }))
        for (const entry of stored) if (entry !== undefined) entries.set(entry.name, entry)
        addShipped()
        for (const proposal of proposals) {
          if (proposal.status === 'rejected') continue
          for (const path of proposal.paths) pending.set(path, (pending.get(path) ?? 0) + 1)
        }
      }
      const skills = rowsFor([...entries.values()], name => service.defaultText(name), store !== undefined, pending)
      return { commit, skills, roles }
    })
  }

  /**
   * One skill's document: its text and the commit it was read at (what to pass as `base` when saving), and the
   * shipped default (`''` for a skill you added). A shipped skill missing from the store reads as its default, with
   * `missing`. A name that is neither stored nor shipped is `NOT_FOUND`. A document that doesn't parse is read as it
   * is, so that it can be fixed. Without a store the commit is `''`.
   */
  async read(name: string): Promise<Outcome<ReadResult>> {
    return outcome(async () => {
      const skill = skillName(name)
      const shipped = this.ctx.dishSkills.defaultText(skill)
      const none = (): Refusal => new Refusal('NOT_FOUND', `there is no skill ${JSON.stringify(skill)}`)
      const store = this.ctx.get('dishConfig')
      if (store === undefined) {
        if (shipped === undefined) throw none()
        return { text: shipped, commit: '', defaultText: shipped, missing: false }
      }
      // Read at the commit that is reported, so the two agree whatever is written meanwhile.
      const commit = await store.head()
      const stored = await store.read(pathFor(skill), commit)
      if (stored === undefined) {
        if (shipped === undefined) throw none()
        return { text: shipped, commit, defaultText: shipped, missing: true }
      }
      return { text: stored, commit, defaultText: shipped ?? '', missing: false }
    })
  }

  /**
   * What saving `text` as the skill `name` would run into, without saving: the problem the store would refuse it for
   * (the first one found), and the warnings, which never refuse. `summary` is what a valid document says, and `null`
   * when there is a problem. It needs no store.
   */
  async check(name: string, text: string): Promise<Outcome<CheckResult>> {
    return outcome(async () => {
      const skill = skillName(name)
      const content = stringOf('text', text)
      return checkDocument(pathFor(skill), content, await this.ctx.dishSkills.knownRoles())
    })
  }

  /**
   * Save `text` as the skill `name`'s document, as the user; a name with no document yet is created. The store
   * refuses text that isn't a valid skill (`INVALID`, with the reason).
   * @param name - the skill's name: lowercase letters, digits and hyphens, at most 64 characters.
   * @param text - the whole document. The store refuses an empty one.
   * @param base - `''` for none; else the full commit id the editor loaded (`read`'s `commit`), and a document that has changed since is `CONFLICT`.
   * @param note - `''` for none; else why, in a line, which becomes the commit's `Dish-Note`.
   * @returns the commit, or `null` when the document already says this.
   */
  async save(name: string, text: string, base: string, note: string): Promise<Outcome<CommitInfo | null>> {
    return outcome(async () => {
      const skill = skillName(name)
      const content = stringOf('text', text)
      return put(this.ctx, skill, content, stringOf('base', base), stringOf('note', note))
    })
  }

  /**
   * Save the shipped default as the skill `name`'s document, as the user (`save` with the default text): an ordinary
   * commit, so it can be reverted. It also writes back a shipped skill the store has lost. A skill dish ships no
   * default for is `INVALID`.
   * @param note - `''` for the default note, `RESET_NOTE`; else why, in a line.
   * @returns the commit, or `null` when the document already is the default.
   */
  async reset(name: string, base: string, note: string): Promise<Outcome<CommitInfo | null>> {
    return outcome(async () => {
      const skill = skillName(name)
      const shipped = this.ctx.dishSkills.defaultText(skill)
      if (shipped === undefined) throw new Refusal('INVALID', `${JSON.stringify(skill)} has no shipped default to go back to`)
      return put(this.ctx, skill, shipped, stringOf('base', base), stringOf('note', note) || RESET_NOTE)
    })
  }

  /**
   * Delete the skill `name`'s document, as the user: a commit, so it can be reverted. A shipped skill is `INVALID`
   * (it would be seeded back at the next start; `roles: []` turns it off), and one the store doesn't have is `NOT_FOUND`.
   * @param base - `''` for none; else the commit the editor loaded, and a document that has changed since is `CONFLICT`.
   * @param note - `''` for none; else why, in a line.
   * @returns the commit.
   */
  async remove(name: string, base: string, note: string): Promise<Outcome<CommitInfo | null>> {
    return outcome(async () => {
      const skill = skillName(name)
      const after = stringOf('base', base)
      const why = stringOf('note', note)
      if (this.ctx.dishSkills.defaultText(skill) !== undefined) throw new Refusal('INVALID', SHIPPED_NOT_REMOVABLE)
      const store = storeToWrite(this.ctx)
      const path = pathFor(skill)
      if (await store.read(path) === undefined) throw new Refusal('NOT_FOUND', `there is no skill ${JSON.stringify(skill)} in the store`)
      return await store.write([{ path, delete: true }], metaOf(after, why)) ?? null
    })
  }
}

markRemote(SkillsRemote, 'skills')
markRemote(SkillsRemote, 'read')
markRemote(SkillsRemote, 'check')
markRemote(SkillsRemote, 'save')
markRemote(SkillsRemote, 'reset')
markRemote(SkillsRemote, 'remove')
