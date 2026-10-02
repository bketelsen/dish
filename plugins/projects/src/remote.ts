/**
 * The server half of Settings → Projects: a Typert remote service the browser calls through
 * `ctx.remote.dishProjects`.
 *
 * It is built like `dish-skills`' remote (which is built like `dish-config`'s), and for the same reasons:
 *
 * - the gateway serves any root service that carries a `typertRemote` binding and `@Remote` markers, reading wire
 *   parameter names from the method source (so every parameter is a plain identifier). This package runs as
 *   type-stripped `.ts`, which has no decorator syntax, so the markers are applied by `markRemote`;
 * - every parameter is plain JSON, and `''` means absent: no base, no note, and in a project's `Fields` a field
 *   `projects.yaml` leaves out;
 * - every write is made as the user, a person at the keyboard;
 * - a refusal the person can act on comes back as `{ ok: false, code, message }`, not as a throw: Typert has a
 *   closed set of failure codes, and its gateway folds anything thrown into `gateway/internal`. That covers the
 *   store's own codes, matched on `.code` (an error class from another package is not recognised by `instanceof`),
 *   and two of this remote's own: `INVALID` for what the registry or the wire refuses, and `UNAVAILABLE` for a call
 *   that needs the store when there is none. Anything else is a bug, and is thrown.
 *
 * The store is optional (`dishConfig`) and looked up on every call, and so is `dishWorkspaces` (read with `ctx.get`:
 * a sibling, never an ancestor). Without a store `projects` answers with no projects and `check` judges the fields
 * alone; `save`, `remove` and `retry` are `UNAVAILABLE`.
 *
 * **How a change is made.** `save` and `remove` read `projects.yaml` at the commit the page loaded (`base`, or the
 * head for `''`), change the one entry, and write the whole document back through `serializeProjects` with that
 * `base`. The store refuses the write as `CONFLICT` when the file changed after `base` (the check is per document:
 * a commit elsewhere in the store is no conflict), so what is edited is the very file the page showed. A save is
 * read back through the registry's own parser before it is written, so a field it refuses is `INVALID` with its
 * sentence, what is written is trimmed as the parser would have it, and `check` says exactly what `save` would; the
 * store's validator runs again on the write and has the last word. Comments in an earlier document don't survive a
 * change (`serializeProjects` says so).
 *
 * @module dish-projects/remote
 */

import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { CommitInfo as StoreCommitInfo, DishConfigService, ErrorCode as StoreErrorCode, WriteMeta } from 'dish-config'
import { markRemote } from 'dish-kit'
import { statusMessage } from './onboarding.ts'
import { NAMESPACE } from './protocol.ts'
import type { CheckResult, CommitInfo, ErrorCode, Fields, Outcome, ProjectInfo, ProjectsResult } from './protocol.ts'
import { PROJECTS_PATH, nameProblem, parseProjects, serializeProjects } from './registry.ts'
import type { ParseResult, ProjectFields } from './registry.ts'

/** The Cordis service key. (The wire namespace is `NAMESPACE`.) */
export const SERVICE = 'dishProjectsRemote'

declare module '@deepseek-ai/cordis' {
  interface Context {
    dishProjectsRemote: ProjectsRemote
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

// --- what comes off the wire ---------------------------------------------------------------------

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Set `key` on `target` as an own property, even when it is `__proto__`, which plain assignment would turn into a prototype change. */
function put<T>(target: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true })
}

/** `text` for a message: quoted, cut short. */
function shown(text: string): string {
  return JSON.stringify(text.length > 64 ? `${text.slice(0, 64)}…` : text)
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

/** A project's name, as it comes off the wire: a string. The registry judges the grammar (`nameProblem`), where that matters. */
function nameOf(value: unknown): string {
  if (typeof value !== 'string') throw new Refusal('INVALID', 'name must be a string')
  return value
}

/** `adding` decides what a call means, so it must be said: a boolean, and nothing else. */
function addingOf(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Refusal('INVALID', 'adding must be true or false')
  return value
}

const TEXT_FIELDS = ['family', 'role', 'gate', 'gateTimeout', 'setup', 'setupTimeout'] as const
const FIELD_NAMES: readonly string[] = [...TEXT_FIELDS, 'gateEnv']

/**
 * The `Fields` off the wire as the settings `projects.yaml` writes: `''` is a field left out, and so is an
 * environment with nothing in it. A missing member counts as empty. Nothing is trimmed or judged here: that is the
 * registry's (a required field that is `''` is "blank", a duration that is `''` is "must be <n>s…"). A value that is
 * not a string, a member that isn't a field, and an environment that isn't a mapping of strings are `INVALID`.
 */
function fieldsOf(value: unknown): ProjectFields {
  if (!isMapping(value)) throw new Refusal('INVALID', 'fields must be an object')
  for (const key of Object.keys(value)) {
    if (!FIELD_NAMES.includes(key)) throw new Refusal('INVALID', `fields has no member ${shown(key)}`)
  }
  const text = (key: typeof TEXT_FIELDS[number]): string => {
    const member = Object.hasOwn(value, key) ? value[key] : undefined
    if (member === undefined) return ''
    if (typeof member !== 'string') throw new Refusal('INVALID', `fields.${key} must be a string`)
    return member
  }
  const fields: ProjectFields = { family: text('family'), role: text('role'), gate: text('gate'), gateTimeout: text('gateTimeout') }
  const setup = text('setup')
  if (setup !== '') fields.setup = setup
  const setupTimeout = text('setupTimeout')
  if (setupTimeout !== '') fields.setupTimeout = setupTimeout
  const env = Object.hasOwn(value, 'gateEnv') ? value.gateEnv : undefined
  if (env !== undefined) {
    if (!isMapping(env)) throw new Refusal('INVALID', 'fields.gateEnv must be a mapping of variable names to strings')
    const copy: Record<string, string> = {}
    for (const [variable, content] of Object.entries(env)) {
      if (typeof content !== 'string') throw new Refusal('INVALID', 'fields.gateEnv must be a mapping of variable names to strings')
      put(copy, variable, content)
    }
    if (Object.keys(copy).length > 0) fields.gateEnv = copy
  }
  return fields
}

/** The settings as the form has them: `''` for what the file leaves out. */
function formFields(fields: ProjectFields): Fields {
  const env: Record<string, string> = {}
  for (const [variable, content] of Object.entries(fields.gateEnv ?? {})) put(env, variable, content)
  return {
    family: fields.family,
    role: fields.role,
    gate: fields.gate,
    gateTimeout: fields.gateTimeout,
    setup: fields.setup ?? '',
    setupTimeout: fields.setupTimeout ?? '',
    gateEnv: env,
  }
}

// --- the registry ---------------------------------------------------------------------------------

/** A problem as the store would say it: the path in front. */
function inRegistry(problem: string): string {
  return `${PROJECTS_PATH}: ${problem}`
}

/** The registry in `text`; a missing file (before the seed) is no projects. */
function parseStored(text: string | undefined): ParseResult {
  return text === undefined ? { ok: true, projects: [], fields: {} } : parseProjects(text)
}

/**
 * The projects in the file at `base` (the head for `''`), as the file says them. A file that doesn't parse is
 * `INVALID`, with its problem: the page can't change what it can't read, and says where it can be fixed.
 * @throws the store's `NOT_FOUND` when `base` isn't a commit.
 */
async function registryAt(store: DishConfigService, base: string): Promise<Record<string, ProjectFields>> {
  const commit = base === '' ? await store.head() : base
  const parsed = parseStored(await store.read(PROJECTS_PATH, commit))
  if (!parsed.ok) throw new Refusal('INVALID', `${parsed.problem}; the page can't change a registry that doesn't parse: fix or revert it on History`)
  return parsed.fields
}

/**
 * The document `current` becomes with the project `name` set to `entry`, or the refusal `save` would answer with.
 * Adding a name that is there (in any case: GitHub's names don't tell cases apart) and editing one that isn't are
 * `INVALID`; so is anything the registry refuses, with its own sentence, since the document is read back through
 * its parser before it is written. What is returned is that reading, written out again: trimmed.
 * `current` is `undefined` when there is no store: the fields are judged, and the name isn't looked up.
 */
function withProject(current: Record<string, ProjectFields> | undefined, name: string, entry: ProjectFields, adding: boolean): string {
  const problem = nameProblem(name)
  if (problem !== undefined) throw new Refusal('INVALID', inRegistry(problem))
  const next: Record<string, ProjectFields> = {}
  if (current !== undefined) {
    const spelled = Object.keys(current).find(key => key.toLowerCase() === name.toLowerCase())
    if (adding && spelled !== undefined) {
      throw new Refusal('INVALID', spelled === name ? `${name} is already in ${PROJECTS_PATH}` : `${name} is already in ${PROJECTS_PATH} as ${spelled}`)
    }
    if (!adding && spelled !== name) {
      throw new Refusal('INVALID', `${name} isn't in ${PROJECTS_PATH}${spelled === undefined ? '; add it instead' : `; it is listed as ${spelled}`}`)
    }
    for (const [key, value] of Object.entries(current)) put(next, key, value)
  }
  put(next, name, entry)
  const parsed = parseProjects(serializeProjects(next))
  if (!parsed.ok) throw new Refusal('INVALID', parsed.problem)
  return serializeProjects(parsed.fields)
}

// --- the store ------------------------------------------------------------------------------------

/** The store, or the refusal a call that changes it has without one. */
function storeToWrite(ctx: Context): DishConfigService {
  const store = ctx.get('dishConfig')
  if (store === undefined) throw new Refusal('UNAVAILABLE', 'the config store isn\'t running, so projects can\'t be changed')
  return store
}

/** What a write by the user carries: the note and the base when there are any. */
function metaOf(base: string, note: string): WriteMeta {
  const meta: WriteMeta = { author: { kind: 'user' } }
  if (note !== '') meta.note = note
  if (base !== '') meta.base = base
  return meta
}

// --- dish-workspaces ------------------------------------------------------------------------------

/** What the list reads of `dishWorkspaces.describe`, structurally: this package doesn't depend on dish-workspaces. */
export interface WorkspacesReader {
  describe(name: string): {
    clone: string
    workspace: { title: string } | null
    lastFetch: { at: number, ok: boolean, message?: string } | null
  } | undefined
}

type CloneFields = Pick<ProjectInfo, 'clone' | 'workspace' | 'lastFetch'>

const NO_CLONE: CloneFields = { clone: null, workspace: null, lastFetch: null }

/** What dish-workspaces says of `name`'s clone. A `describe` that throws is no clone, and `trouble` is told why. */
function cloneOf(reader: WorkspacesReader | undefined, name: string, trouble: (message: string) => void): CloneFields {
  if (reader === undefined) return NO_CLONE
  try {
    const described = reader.describe(name)
    if (described === undefined) return NO_CLONE
    const fetched = described.lastFetch
    return {
      clone: described.clone,
      workspace: described.workspace?.title ?? null,
      lastFetch: fetched === null || fetched === undefined ? null : { at: fetched.at, ok: fetched.ok, message: fetched.message ?? null },
    }
  } catch (error) {
    trouble(statusMessage(describe(error)))
    return NO_CLONE
  }
}

export class ProjectsRemote extends TypertRemoteService {
  static inject = ['dishProjects']

  /**
   * The last trouble with `describe` that was logged, so a dish-workspaces that keeps failing is told once. (Not a `#`
   * field: Cordis hands out services behind a proxy, which a private field can't be read through.)
   */
  describeTrouble: string | undefined

  constructor(ctx: Context) {
    super(ctx, SERVICE, { namespace: NAMESPACE })
  }

  /**
   * The registry at the store's head: every project in `projects.yaml`, sorted by name, with its settings, its
   * onboarding status, and what dish-workspaces knows of its clone (its path, its workspace's title, the last
   * fetch); `commit` is what a save passes as `base`. A file that doesn't parse (a hand edit in the repository) is
   * a `problem` and no projects. `pendingProposals` counts the open and stale proposals that change the file.
   * Without a store: `commit: ''` and nothing else.
   */
  async projects(): Promise<Outcome<ProjectsResult>> {
    return outcome(async () => {
      const store = this.ctx.get('dishConfig')
      if (store === undefined) return { commit: '', projects: [], problem: null, pendingProposals: 0 }
      // The file at one commit, so the list is one moment of the store.
      const commit = await store.head()
      const [text, proposals] = await Promise.all([store.read(PROJECTS_PATH, commit), store.proposals()])
      const pendingProposals = proposals.filter(proposal => proposal.status !== 'rejected' && proposal.paths.includes(PROJECTS_PATH)).length
      const parsed = parseStored(text)
      if (!parsed.ok) return { commit, projects: [], problem: parsed.problem, pendingProposals }

      const reader = (this.ctx as unknown as { get(name: string): unknown }).get('dishWorkspaces') as WorkspacesReader | undefined
      const trouble = (message: string): void => {
        if (this.describeTrouble === message) return
        this.describeTrouble = message
        this.ctx.logger('dish-projects').warn('could not describe a project\'s clone: %s', message)
      }
      const projects = parsed.projects.map((project): ProjectInfo => {
        const status = this.ctx.dishProjects.status(project.name)
        return {
          name: project.name,
          fields: formFields(parsed.fields[project.name]!),
          status: { state: status.state, message: status.message ?? null, at: status.at, setupSkipped: status.setupSkipped ?? null },
          ...cloneOf(reader, project.name, trouble),
        }
      })
      return { commit, projects, problem: null, pendingProposals }
    })
  }

  /**
   * What saving these settings would run into, without saving: the one problem the save would be refused with (the
   * registry's own sentence, with the path in front, as the store words it), or `null`. When `adding`, a name that
   * is there already (in any case) is a problem; when not, so is one that isn't there. A registry that doesn't parse
   * is the problem. Without a store the fields are judged and no name is looked up.
   * @param name - `owner/repo`.
   * @param fields - the form's settings; `''` for what is left out.
   * @param adding - `true` for a new project, `false` for an edit of one that is there.
   */
  async check(name: string, fields: Fields, adding: boolean): Promise<Outcome<CheckResult>> {
    return outcome(async () => {
      const project = nameOf(name)
      const entry = fieldsOf(fields)
      const add = addingOf(adding)
      const store = this.ctx.get('dishConfig')
      try {
        withProject(store === undefined ? undefined : await registryAt(store, ''), project, entry, add)
        return { problem: null }
      } catch (error) {
        if (error instanceof Refusal && error.code === 'INVALID') return { problem: error.message }
        throw error
      }
    })
  }

  /**
   * Save one project's settings, as the user: a new project when `adding`, else an edit of one that is there (a
   * name that isn't there is `INVALID`: a rename is a remove and an add). The new document is built on `projects.yaml`
   * as it was at `base` and refused as `INVALID` (with the registry's sentence), `SECRET` or `TOO_LARGE` if the
   * registry or the store won't take it. The project is onboarded when it is new, and again when it is failed; a ready
   * one reads its new settings from its next fetch, worktree and gate.
   * @param name - `owner/repo`.
   * @param fields - the form's settings; `''` for what is left out.
   * @param base - `''` for none; else the full commit id the page loaded (`projects`' `commit`), and a registry that has changed since is `CONFLICT`.
   * @param note - `''` for none; else why, in a line, which becomes the commit's `Dish-Note`.
   * @param adding - `true` for a new project, `false` for an edit.
   * @returns the commit, or `null` when the file already says this.
   */
  async save(name: string, fields: Fields, base: string, note: string, adding: boolean): Promise<Outcome<CommitInfo | null>> {
    return outcome(async () => {
      const project = nameOf(name)
      const entry = fieldsOf(fields)
      const add = addingOf(adding)
      const after = stringOf('base', base)
      const why = stringOf('note', note)
      const store = storeToWrite(this.ctx)
      const text = withProject(await registryAt(store, after), project, entry, add)
      return await store.write([{ path: PROJECTS_PATH, text }], metaOf(after, why)) ?? null
    })
  }

  /**
   * Remove a project from `projects.yaml`, as the user: a commit, so it can be reverted. Nothing on disk goes: the
   * clone and the workspace stay, and dish stops fetching, sweeping and gating it; its onboarding is stopped. A
   * name the file doesn't have (only the spelling it has is there) is `NOT_FOUND`.
   * @param base - `''` for none; else the commit the page loaded, and a registry that has changed since is `CONFLICT`.
   * @param note - `''` for "Removed <name>; its clone and workspace stay"; else why, in a line.
   * @returns the commit.
   */
  async remove(name: string, base: string, note: string): Promise<Outcome<CommitInfo | null>> {
    return outcome(async () => {
      const project = nameOf(name)
      const after = stringOf('base', base)
      const why = stringOf('note', note)
      const store = storeToWrite(this.ctx)
      const current = await registryAt(store, after)
      if (!Object.hasOwn(current, project)) throw new Refusal('NOT_FOUND', `there is no project ${shown(project)} in ${PROJECTS_PATH}`)
      const rest: Record<string, ProjectFields> = {}
      for (const [key, value] of Object.entries(current)) if (key !== project) put(rest, key, value)
      const text = serializeProjects(rest)
      return await store.write([{ path: PROJECTS_PATH, text }], metaOf(after, why === '' ? `Removed ${project}; its clone and workspace stay` : why)) ?? null
    })
  }

  /**
   * Onboard a project again (`DishProjects.retry`): a failed one is cloned again, and a ready one adopts its clone,
   * skips setup (with the command to run instead) and registers its workspace again. It is refused as `INVALID`,
   * with the service's words, while the project is queued or being onboarded, and when the file doesn't have it.
   * `UNAVAILABLE` without a store: there are no projects.
   */
  async retry(name: string): Promise<Outcome<null>> {
    return outcome(async () => {
      const project = nameOf(name)
      if (this.ctx.get('dishConfig') === undefined) throw new Refusal('UNAVAILABLE', 'the config store isn\'t running, so there are no projects')
      try {
        await this.ctx.dishProjects.retry(project)
      } catch (error) {
        // The store failing on the way is the store's to report; the service's own refusals are plain errors.
        if (isStoreCode((error as { code?: unknown } | null)?.code)) throw error
        throw new Refusal('INVALID', statusMessage(describe(error)))
      }
      return null
    })
  }
}

markRemote(ProjectsRemote, 'projects')
markRemote(ProjectsRemote, 'check')
markRemote(ProjectsRemote, 'save')
markRemote(ProjectsRemote, 'remove')
markRemote(ProjectsRemote, 'retry')
