/**
 * dish-config — the git-backed, versioned config store, as a Cordis plugin.
 *
 * `ConfigStore` (in `store/`: dish-kit's `VersionedStore`, opened under the
 * config store's words) does all the repository work. This plugin opens
 * it, owns its lifetime, and offers it to the other plugins as the `dishConfig`
 * service:
 *
 * - plugins claim a path prefix (a namespace) and read and write documents
 *   through the service, never touching files or git themselves;
 * - the plugin emits `dish-config/changed`, `dish-config/proposal` and
 *   `dish-config/remote` as the store reports them, so consumers re-read
 *   instead of caching;
 * - `main` is pushed to a remote after each commit, when one is configured;
 * - when a `tools` service is there, the main agent gets `config_read`, `config_list`, `config_write` and
 *   `config_propose` (see `tools.ts`); the store itself needs no `tools` service;
 * - the History page's server half is the `dishConfigRemote` Typert remote (see `remote.ts`), served by the
 *   gateway when there is one and idle otherwise.
 *
 * The plugin claims `README.md` itself, for people only, and seeds it once.
 *
 * @module dish-config
 */

import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import type { Context, Events } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { printOwnLogs, xdgPaths } from 'dish-kit'
import { AGENT_IDENTITY, personIdentity } from 'dish-kit/store'
import type { GitIdentity } from './store/git.ts'
import { NamespaceRegistry } from './store/namespaces.ts'
import type { NamespaceSpec } from './store/namespaces.ts'
import { ConfigStore } from './store/store.ts'
import type { Author, CommitInfo, ProposalEvent, RemoteStatus } from './store/store.ts'
import { ConfigRemote } from './remote.ts'
import { toolDefinitions } from './tools.ts'

export { ConfigStoreError } from './store/errors.ts'
export type { ErrorCode } from './store/errors.ts'
export type { NamespaceSpec } from './store/namespaces.ts'
export type {
  AcceptMeta, Author, Change, CommitInfo, EditAuthor, FileDiff, GitIdentity, HistoryQuery, ProposalEvent, ProposalInfo,
  ProposalStatus, ProposeMeta, RejectMeta, RemoteStatus, RevertMeta, SeedOptions, WriteMeta,
} from './store/store.ts'

export const name = 'dish-config'

/**
 * The `dishConfig` service: the store's own methods (see `ConfigStore`) and `claim`.
 *
 * There is no `close`: the plugin owns the store, and unloading the plugin closes it. A reference
 * kept past that point rejects every call.
 *
 * Callers own their claims. Claim a namespace as an effect of the plugin that owns it, so it is
 * released when that plugin unloads (releasing leaves the files as they are):
 *
 * ```ts
 * ctx.effect(() => ctx.dishConfig.claim(spec))
 * ```
 */
export interface DishConfigService extends Pick<ConfigStore,
  | 'head' | 'read' | 'list' | 'write' | 'seed' | 'history' | 'diff' | 'commit' | 'revert'
  | 'propose' | 'proposals' | 'accept' | 'reject' | 'remoteStatus'
> {
  /**
   * Claim `spec.prefix` for `spec.owner`: a document may be written only inside a claimed namespace, and the
   * namespace's `validate` and `agent` policy apply to it. Claims are disjoint.
   * @returns a disposer that releases the claim; safe to call more than once.
   * @throws a plain `Error` if `spec` is malformed or overlaps a live claim.
   */
  claim(spec: NamespaceSpec): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    dishConfig: DishConfigService
  }

  interface Events {
    /** After every commit to `main` (a write, a seed, a revert or an accepted proposal): the paths it changed, its id and who made it. */
    'dish-config/changed'(paths: string[], commit: string, author: Author): void
    /** A proposal was opened, turned out stale (an `accept` refused it), or was accepted or rejected. */
    'dish-config/proposal'(id: string, status: ProposalEvent): void
    /** The remote copy's status changed: a push started, failed or succeeded, or a commit is waiting. */
    'dish-config/remote'(status: RemoteStatus): void
  }
}

export interface Config {
  repository: string
  remote: string
  userName: string
  userEmail: string
  agentName: string
  agentEmail: string
  maxBytes: number
  pushTimeoutMs: number
  terminal: boolean
}

const DEFAULT_MAX_BYTES = 262_144
const DEFAULT_PUSH_TIMEOUT_MS = 60_000

export const Config: Schema<Config> = Schema.object({
  repository: Schema.string().default('')
    .description('The bare git repository holding the config: an absolute path, where a leading ~/ is your home directory. Leave blank for config.git in the XDG config directory for dish.'),
  remote: Schema.string().default('')
    .description('Where to push main after every commit: a URL or path git can push to. Leave blank to keep the config local. Set it per machine: two machines pushing to one remote diverge.'),
  userName: Schema.string().default('')
    .description('The name commits made by a person carry. Leave blank to use git\'s global user.name, or "dish".'),
  userEmail: Schema.string().default('')
    .description('The email commits made by a person carry. Leave blank to use git\'s global user.email, or "dish@localhost".'),
  agentName: Schema.string().default(AGENT_IDENTITY.name)
    .description('The name commits made by an agent, and by the store itself, carry.'),
  agentEmail: Schema.string().default(AGENT_IDENTITY.email)
    .description('The email commits made by an agent, and by the store itself, carry.'),
  maxBytes: Schema.natural().default(DEFAULT_MAX_BYTES)
    .description('The most one document may take, in bytes.'),
  pushTimeoutMs: Schema.natural().min(1).default(DEFAULT_PUSH_TIMEOUT_MS)
    .description('A push, or the lookup of the remote at a first start, still running after this many milliseconds is killed.'),
  terminal: Schema.boolean().default(true)
    .description('Print this plugin\'s messages to the terminal.'),
})

const README = `# dish config

This repository holds the configuration that dish plugins keep as documents: prompts, crew definitions and the like.

It is managed by the dish-config plugin. Every change is a commit that records who made it, a person in the dsh web UI or an agent, and why, so nothing is lost.

Edit documents through the dsh web UI, or ask the main agent to. Editing the repository by hand is not supported: the plugin owns it, and anything changed behind its back can be refused or overwritten.
`

/** The README is for people to read and edit; an agent has no business with it. */
const README_SPEC: NamespaceSpec = {
  prefix: 'README.md',
  owner: name,
  agent: 'none',
  validate: (_path, text) => text.trim() === '' ? 'README.md must not be empty' : undefined,
}

/** A string setting as it will be used: trimmed, and `undefined` when nothing is left (use the default). */
function text(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === '' ? undefined : trimmed
}

/**
 * Where the repository lives: the setting with a leading `~/` (or a bare `~`) taken as the home directory, else the XDG default.
 * @throws a plain `Error` for any other relative path: what it would be relative to is not something to guess.
 */
function repositoryPath(setting: string | undefined): string {
  if (setting === undefined) return join(xdgPaths('dish').config, 'config.git')
  if (setting === '~') return homedir()
  if (setting.startsWith('~/')) return join(homedir(), setting.slice(2))
  if (!isAbsolute(setting)) throw new Error(`repository must be an absolute path (or start with ~/), got ${JSON.stringify(setting)}`)
  return setting
}

/** Whether `error` is cordis refusing an effect because the plugin has been unloaded: a plugin that is going away didn't fail. */
function unloaded(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'INACTIVE_EFFECT'
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Open the store, then provide `dishConfig`. If the store can't be opened (another process holds it, the remote can't
 * be reached at a first start, the directory isn't a dish config repository) the failure is logged and rethrown, and
 * nothing is provided. Unloading the plugin closes the store.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const logger = ctx.logger(name)
  if (config.terminal) printOwnLogs(ctx, name)

  const repository = resolve(repositoryPath(text(config.repository)))
  const remote = text(config.remote)
  const user = await personIdentity(config)
  const agent: GitIdentity = { name: text(config.agentName) ?? AGENT_IDENTITY.name, email: text(config.agentEmail) ?? AGENT_IDENTITY.email }
  const namespaces = new NamespaceRegistry()

  // `ctx.emit` neither isolates its listeners (the first to throw ends the dispatch, so those after it never hear the
  // event) nor catches the promise an async one returns. `ctx.parallel` calls every listener at once, in order,
  // synchronously, and settles all of them, so a failing listener is only logged and the store never hears of it.
  let live = true
  const publish = <K extends keyof Events>(event: K, ...args: Parameters<Events[K]>): void => {
    if (!live) return
    ctx.parallel(event, ...args).catch((error: unknown) => {
      for (const cause of error instanceof AggregateError ? error.errors : [error]) {
        logger.warn('a %s listener failed: %s', event, cause)
      }
    })
  }

  // Terminal output follows the remote's status: a line when an error appears or goes away, and one for the first
  // push. The first push can finish before the store is ready, so nothing is said until the ready line is out.
  let failing = false
  let pushedOnce = false
  let announced = false
  let latest: RemoteStatus | undefined
  const report = (status: RemoteStatus): void => {
    const hasError = status.lastError !== undefined
    if (hasError && !failing) logger.warn('push failing: %s (%d unpushed)', status.lastError, status.pending)
    else if (!hasError && failing) logger.info('push working again')
    failing = hasError
    if (!pushedOnce && status.pushed !== undefined) {
      pushedOnce = true
      logger.info('pushed %s', status.pushed.slice(0, 7))
    }
  }
  const onRemoteStatus = (status: RemoteStatus): void => {
    publish('dish-config/remote', status)
    latest = status
    if (announced) report(status)
  }

  let store: ConfigStore
  try {
    store = await ConfigStore.open({
      repository,
      namespaces,
      user,
      agent,
      maxBytes: config.maxBytes,
      remote,
      pushTimeoutMs: config.pushTimeoutMs,
      onCommit: (info: CommitInfo) => publish('dish-config/changed', info.paths, info.id, info.author),
      onProposal: (id, status) => publish('dish-config/proposal', id, status),
      onRemoteStatus,
    })
  } catch (error) {
    // Never a half-open service: nothing is provided, and dsh reports the plugin as failed.
    logger.error('cannot open the config store at %s: %s', repository, describe(error))
    throw error
  }
  // From here on, a failure unloads the plugin, which closes the store: it drains the queue, kills a push in flight
  // and releases the lock.
  try {
    ctx.effect(() => async () => {
      live = false
      await store.close()
    })
  } catch (error) {
    // The plugin was unloaded while the store was opening, so nothing will ever close it.
    await store.close().catch(() => {})
    if (unloaded(error)) return
    throw error
  }

  ctx.effect(() => namespaces.claim(README_SPEC))
  try {
    await store.seed({ 'README.md': README }, name)
  } catch (error) {
    // A convenience: the store itself is open and usable (a size cap smaller than the README is the usual cause).
    // Unless the plugin is being unloaded, which closed the store under the seed.
    if (live) logger.warn('could not seed README.md: %s', describe(error))
  }

  const service: DishConfigService = {
    claim: spec => namespaces.claim(spec),
    head: () => store.head(),
    read: (path, ref) => store.read(path, ref),
    list: (prefix, ref) => store.list(prefix, ref),
    write: (changes, meta) => store.write(changes, meta),
    seed: (defaults, owner, options) => store.seed(defaults, owner, options),
    history: query => store.history(query),
    diff: (from, to, path) => store.diff(from, to, path),
    commit: id => store.commit(id),
    revert: (commit, meta) => store.revert(commit, meta),
    propose: (changes, meta) => store.propose(changes, meta),
    proposals: status => store.proposals(status),
    accept: (id, meta) => store.accept(id, meta),
    reject: (id, reason, meta) => store.reject(id, reason, meta),
    remoteStatus: () => store.remoteStatus(),
  }
  try {
    ctx.provide('dishConfig', service)
    // The History page's remote: a child plugin that needs `dishConfig`, so it goes when the service does.
    ctx.plugin(ConfigRemote, { namespaces: () => namespaces.all() })
    // The tools are optional: with no `tools` service the store works all the same, and they register when one appears.
    // Registered through the child context, they go when the `tools` service does, or the plugin.
    ctx.inject(['tools'], (child) => {
      for (const definition of toolDefinitions(service, namespaces)) child.tools.register(definition)
    })
  } catch (error) {
    // Unloaded during the seed: the close effect is registered, so it closes the store. Not a failure.
    if (unloaded(error)) return
    throw error
  }
  logger.info('store ready at %s', repository)
  announced = true
  if (latest !== undefined) report(latest)
}
