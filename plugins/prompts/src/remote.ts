/**
 * The server half of Settings → Prompts: a Typert remote service the browser calls through
 * `ctx.remote.dishPrompts`.
 *
 * It is built like `dish-config`'s remote, and for the same reasons:
 *
 * - the gateway serves any root service that carries a `typertRemote` binding and `@Remote` markers, reading wire
 *   parameter names from the method source (so every parameter is a plain identifier). This package runs as
 *   type-stripped `.ts`, which has no decorator syntax, so the markers are applied by `markRemote`;
 * - every parameter is plain JSON, and `''` means absent: no base, no note;
 * - every write is made as the user, a person at the keyboard;
 * - a refusal the person can act on comes back as `{ ok: false, code, message }`, not as a throw: Typert has a
 *   closed set of failure codes, and its gateway folds anything thrown into `gateway/internal`. That covers the
 *   store's own codes, matched on `.code` (an error class from another package is not recognised by `instanceof`),
 *   and two of this remote's own: `INVALID` for a role that can't be one (it comes off the wire), and `UNAVAILABLE`
 *   for a write with no store running. Anything else is a bug, and is thrown.
 *
 * The store is optional (`dishConfig`) and looked up on every call. Without it `roles` and `read` answer with the
 * shipped defaults, and `save` and `reset` are `UNAVAILABLE`.
 *
 * @module dish-prompts/remote
 */

import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { CommitInfo as StoreCommitInfo, DishConfigService, ErrorCode as StoreErrorCode, WriteMeta } from 'dish-config'
import { markRemote } from 'dish-kit'
import { buildPreview, buildVariables } from './preview.ts'
import { NAMESPACE } from './protocol.ts'
import type { CommitInfo, ErrorCode, Outcome, PreviewResult, ReadResult, RoleInfo, VariablesResult } from './protocol.ts'
import { namespaceSpecs, pathFor } from './roles.ts'
import type { DishPrompts } from './service.ts'

/** The Cordis service key. (The wire namespace is `NAMESPACE`.) */
export const SERVICE = 'dishPromptsRemote'

/** The logger the plugin's other parts use: the host prints its own lines to the terminal. */
const LOGGER = 'dish-prompts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    dishPromptsRemote: PromptsRemote
  }
}

// What the page is told must be what the store says: these fail to compile if either side drifts.
type Same<A, B> = [A] extends [B] ? [B] extends [A] ? true : false : false
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

/** A role, as it comes off the wire: `common`, `main` or something that can be a crew role (`pathFor` is the judge). */
function roleName(value: unknown): string {
  if (typeof value !== 'string') throw new Refusal('INVALID', 'role must be a string')
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

const SPECS = namespaceSpecs('dish-prompts')

/** The most an agent may do with `path`, from the claims the plugin makes. */
function policyFor(path: string): 'write' | 'propose' {
  const spec = SPECS.find(candidate => candidate.prefix.endsWith('/') ? path.startsWith(candidate.prefix) : path === candidate.prefix)
  if (spec === undefined || spec.agent === 'none') throw new Error(`no claim covers ${path}`)
  return spec.agent
}

/** The store, or the refusal a write has without one. */
function storeToWrite(ctx: Context): DishConfigService {
  const store = ctx.get('dishConfig')
  if (store === undefined) throw new Refusal('UNAVAILABLE', 'the config store isn\'t running, so prompts can\'t be saved')
  return store
}

/** Write `content` as `role`'s document, as the user. `null` when it is what the document has already. */
async function put(ctx: Context, role: string, content: string, base: string, note: string): Promise<CommitInfo | null> {
  const meta: WriteMeta = { author: { kind: 'user' } }
  if (note !== '') meta.note = note
  if (base !== '') meta.base = base
  return await storeToWrite(ctx).write([{ path: pathFor(role), text: content }], meta) ?? null
}

export class PromptsRemote extends TypertRemoteService {
  static inject = ['dishPrompts']

  /** Whether the fallback of the preview has been told: once per process is enough, and a page can ask again and again. */
  private told = false

  /** What the preview calls when dsh's assembly can't be used. */
  private readonly onFallback = (error: unknown): void => {
    if (this.told) return
    this.told = true
    try {
      this.ctx.logger(LOGGER).warn('the prompt preview can\'t use dsh\'s own system prompt, so it shows the persona texts between markers instead: %s', describe(error))
    } catch {
      // A log line is not worth the preview.
    }
  }

  constructor(ctx: Context) {
    super(ctx, SERVICE, { namespace: NAMESPACE })
  }

  /**
   * The roles, `common` and `main` first, then the crew roles sorted. Each says whether its document differs from the
   * shipped default, is missing from the store, and how many open or stale proposals would change it.
   */
  async roles(): Promise<Outcome<RoleInfo[]>> {
    return outcome(async () => {
      const prompts: DishPrompts = this.ctx.dishPrompts
      const roles = await prompts.roles()
      const store = this.ctx.get('dishConfig')
      if (store === undefined) {
        return roles.map(role => ({
          role, path: pathFor(role), agent: policyFor(pathFor(role)), differsFromDefault: false, missing: false, pendingProposals: 0,
        }))
      }
      // The documents at one commit, so the list is one moment of the store.
      const head = await store.head()
      const [stored, proposals] = await Promise.all([
        Promise.all(roles.map(role => store.read(pathFor(role), head))),
        store.proposals(),
      ])
      const pending = new Map<string, number>()
      for (const proposal of proposals) {
        if (proposal.status === 'rejected') continue
        for (const path of proposal.paths) pending.set(path, (pending.get(path) ?? 0) + 1)
      }
      return roles.map((role, index): RoleInfo => {
        const path = pathFor(role)
        const document = stored[index]
        const shipped = prompts.defaultText(role)
        return {
          role,
          path,
          agent: policyFor(path),
          differsFromDefault: document !== undefined && shipped !== undefined && document !== shipped,
          missing: document === undefined,
          pendingProposals: pending.get(path) ?? 0,
        }
      })
    })
  }

  /**
   * One role's document: its text and the commit it was read at (what to pass as `base` when saving), and the
   * shipped default. A document missing from the store reads as the default, with `missing`. A role with neither
   * a document nor a default is `NOT_FOUND`.
   */
  async read(role: string): Promise<Outcome<ReadResult>> {
    return outcome(async () => {
      const name = roleName(role)
      const shipped = this.ctx.dishPrompts.defaultText(name)
      const none = (): Refusal => new Refusal('NOT_FOUND', `there is no role ${JSON.stringify(name)}`)
      const store = this.ctx.get('dishConfig')
      if (store === undefined) {
        if (shipped === undefined) throw none()
        return { text: shipped, commit: null, defaultText: shipped, missing: false }
      }
      // Read at the commit that is reported, so the two agree whatever is written meanwhile.
      const commit = await store.head()
      const stored = await store.read(pathFor(name), commit)
      if (stored === undefined) {
        if (shipped === undefined) throw none()
        return { text: shipped, commit, defaultText: shipped, missing: true }
      }
      return { text: stored, commit, defaultText: shipped ?? null, missing: false }
    })
  }

  /**
   * Save `text` as `role`'s document, as the user.
   * @param role - `common`, `main` or a crew role.
   * @param text - the whole document. The store refuses an empty one.
   * @param base - `''` for none; else the full commit id the editor loaded (`read`'s `commit`), and a document that has changed since is `CONFLICT`.
   * @param note - `''` for none; else why, in a line, which becomes the commit's `Dish-Note`.
   * @returns the commit, or `null` when the document already says this.
   */
  async save(role: string, text: string, base: string, note: string): Promise<Outcome<CommitInfo | null>> {
    return outcome(async () => {
      const name = roleName(role)
      const content = stringOf('text', text)
      return put(this.ctx, name, content, stringOf('base', base), stringOf('note', note))
    })
  }

  /**
   * Save the shipped default as `role`'s document, as the user (`save` with the default text): an ordinary commit, so it can be reverted.
   * A role dish ships no default for is `INVALID`.
   * @returns the commit, or `null` when the document already is the default.
   */
  async reset(role: string, base: string, note: string): Promise<Outcome<CommitInfo | null>> {
    return outcome(async () => {
      const name = roleName(role)
      const shipped = this.ctx.dishPrompts.defaultText(name)
      if (shipped === undefined) throw new Refusal('INVALID', `${JSON.stringify(name)} has no shipped default to go back to`)
      return put(this.ctx, name, shipped, stringOf('base', base), stringOf('note', note))
    })
  }

  /**
   * The system prompt a new agent in `role` would get now, as far as dish can tell: `approximate` always, and
   * `fallback` when dsh's own assembly couldn't be used and the text has markers in place of dsh's sections.
   * `common` is previewed as `main`.
   */
  async preview(role: string): Promise<Outcome<PreviewResult>> {
    return outcome(async () => {
      const name = roleName(role)
      const prompts: DishPrompts = this.ctx.dishPrompts
      const asked = name === 'common' ? 'main' : name
      const none = (): Refusal => new Refusal('NOT_FOUND', `there is no role ${JSON.stringify(name)}`)
      if (!(await prompts.roles()).includes(asked)) throw none()
      try {
        return await buildPreview(this.ctx, prompts, name, this.onFallback)
      } catch (error) {
        // A crew role that exists only in the store can be deleted after the check above: the service then has no
        // text for it, and says so with a plain `Error` (it has no code to match on), which the gateway would fold
        // into `gateway/internal`. That one case, by its exact message, is the same answer as the check's.
        if (error instanceof Error && error.message === `unknown role "${asked}"`) throw none()
        throw error
      }
    })
  }

  /**
   * The prompt variables the dish preset knows, by name, with the value each has without an agent (empty for the
   * per-agent ones such as `model` and `cwd`). `fallback`, with none listed, when dsh's assembly couldn't be read.
   */
  async variables(): Promise<Outcome<VariablesResult>> {
    return outcome(async () => buildVariables(this.ctx, this.onFallback))
  }
}

markRemote(PromptsRemote, 'roles')
markRemote(PromptsRemote, 'read')
markRemote(PromptsRemote, 'save')
markRemote(PromptsRemote, 'reset')
markRemote(PromptsRemote, 'preview')
markRemote(PromptsRemote, 'variables')
