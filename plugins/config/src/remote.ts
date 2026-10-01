/**
 * The server half of the History page: a Typert remote service the browser
 * calls through `ctx.remote.dishConfig`.
 *
 * The gateway serves any root service that carries a `typertRemote` binding and
 * `@Remote` markers, reading wire parameter names from the method source (so
 * every parameter here is a plain identifier, and `signal` is last on the
 * stream). This package runs as type-stripped `.ts`, which has no decorator
 * syntax, so the markers are applied by `markRemote` instead.
 *
 * Every call is made as the user: the page is a person at the keyboard.
 *
 * The store's refusals (a conflict, a stale proposal, an unknown id) come back
 * as `{ ok: false, code, message }`, not as throws. Typert has a closed set of
 * failure codes, and its gateway folds anything a method throws into
 * `gateway/internal` with the message and nothing else, so a thrown
 * `ConfigStoreError` would reach the page with its `code` gone. A failure that
 * isn't the store's (it is closed, a bug) is still thrown.
 *
 * @module dish-config/remote
 */

import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { markRemote } from 'dish-kit'
import { ConfigStoreError } from './store/errors.ts'
import type { ErrorCode as StoreErrorCode } from './store/errors.ts'
import type { NamespaceSpec } from './store/namespaces.ts'
import type {
  CommitInfo as StoreCommitInfo, FileDiff as StoreFileDiff, HistoryQuery, ProposalEvent as StoreProposalEvent,
  ProposalInfo as StoreProposalInfo, ProposalStatus as StoreProposalStatus, RemoteStatus as StoreRemoteStatus,
} from './store/store.ts'
import { NAMESPACE } from './protocol.ts'
import type { CommitInfo, ConfigEvent, ErrorCode, FileDiff, NamespaceInfo, Outcome, ProposalEvent, ProposalInfo, ProposalStatus, RemoteStatus } from './protocol.ts'

/** The Cordis service key. (The wire namespace is `NAMESPACE`.) */
export const SERVICE = 'dishConfigRemote'

/** The most `changed` and `proposal` events a stream holds for a reader that has fallen behind. */
const MAX_PENDING = 100

declare module '@deepseek-ai/cordis' {
  interface Context {
    dishConfigRemote: ConfigRemote
  }
}

// What the page is told must be what the store says: these fail to compile if either side drifts.
type Same<A, B> = [A] extends [B] ? [B] extends [A] ? true : false : false
type Check<T extends true> = T
export type WireMatchesStore = [
  Check<Same<StoreErrorCode, ErrorCode>>,
  Check<Same<StoreCommitInfo, CommitInfo>>,
  Check<Same<StoreFileDiff, FileDiff>>,
  Check<Same<StoreProposalInfo, ProposalInfo>>,
  Check<Same<StoreRemoteStatus, RemoteStatus>>,
  // The unions the page switches on, each checked on its own (a drift here would not show in the objects above).
  Check<Same<StoreProposalEvent, ProposalEvent>>,
  Check<Same<StoreProposalStatus, ProposalStatus>>,
  Check<Same<NamespaceSpec['agent'], NamespaceInfo['agent']>>,
]

export interface RemoteOptions {
  /** The live claims, for the log's filter. Only `prefix`, `owner` and `agent` go to the page. */
  namespaces: () => readonly NamespaceInfo[]
}

/** `value` as the wire will carry it: JSON, with no key (or array item) left `undefined`. */
function wire<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function invalid(message: string): ConfigStoreError {
  return new ConfigStoreError('INVALID', message)
}

/**
 * A string parameter. They arrive off the wire untyped: a missing one is `undefined` (the client leaves out an `undefined`
 * positional, and the gateway hands the method `undefined` for an argument that is not there), which is as good as `''`,
 * the page's own way to say "absent". Anything else that is not a string gets `INVALID`, not a `TypeError`.
 */
function text(name: string, value: unknown): string {
  if (value === undefined) return ''
  if (typeof value !== 'string') throw invalid(`${name} must be a string`)
  return value
}

/** A number parameter, with a missing one read as `0`, like `text`. */
function count(name: string, value: unknown): number {
  if (value === undefined) return 0
  if (typeof value !== 'number') throw invalid(`${name} must be a number`)
  return value
}

/** Run `task` and put what it returns, or the store's refusal, in an `Outcome`; any other failure is thrown. */
async function outcome<T>(task: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: wire(await task()) }
  } catch (error) {
    if (error instanceof ConfigStoreError) return { ok: false, code: error.code, message: error.message }
    throw error
  }
}

/**
 * Put `event` in `queue` for a reader that is behind. Only the latest `remote` status matters, so it replaces an earlier one.
 * Of the others, the oldest beyond `MAX_PENDING` is dropped: every one of them means "read again", so the reader loses nothing.
 */
function enqueue(queue: ConfigEvent[], event: ConfigEvent): void {
  if (event.kind === 'remote') {
    const earlier = queue.findIndex(item => item.kind === 'remote')
    if (earlier !== -1) queue.splice(earlier, 1)
  }
  queue.push(event)
  if (event.kind === 'remote') return
  let others = queue.reduce((count, item) => item.kind === 'remote' ? count : count + 1, 0)
  for (let index = 0; others > MAX_PENDING; index++) {
    if (queue[index]!.kind === 'remote') continue
    queue.splice(index--, 1)
    others--
  }
}

export class ConfigRemote extends TypertRemoteService {
  static inject = ['dishConfig']

  private readonly options: RemoteOptions
  /** Aborted when the service is unloaded, which ends the streams still open. */
  private readonly closing = new AbortController()

  constructor(ctx: Context, options: RemoteOptions) {
    super(ctx, SERVICE, { namespace: NAMESPACE })
    this.options = options
    ctx.effect(() => () => { this.closing.abort() })
  }

  /** Every claimed namespace, for the log's filter. */
  namespaces(): NamespaceInfo[] {
    return this.options.namespaces().map(({ prefix, owner, agent }) => ({ prefix, owner, agent }))
  }

  /**
   * The commits on `main`, newest first.
   * @param prefix - `''` for all; `prompts/` for what changed under it; without the slash (`crew.yaml`), one document.
   * @param limit - at most this many; `0` (or less) for the default, 50.
   * @param before - `''` for the newest; else a full commit id, and the list starts just below it (the last id of a page gives the next page).
   */
  async history(prefix: string, limit: number, before: string): Promise<Outcome<CommitInfo[]>> {
    return outcome(async () => {
      const where = text('prefix', prefix)
      const below = text('before', before)
      const most = count('limit', limit)
      const query: HistoryQuery = {}
      if (where !== '') query[where.endsWith('/') ? 'prefix' : 'path'] = where
      if (most > 0) query.limit = most
      if (below !== '') query.before = below
      return this.ctx.dishConfig.history(query)
    })
  }

  /** One commit and what it changed. */
  async commit(id: string): Promise<Outcome<{ info: CommitInfo, diffs: FileDiff[] }>> {
    return outcome(async () => this.ctx.dishConfig.commit(text('id', id)))
  }

  /** Undo a commit with a new one. `null` when it was undone already: nothing to do. */
  async revert(id: string): Promise<Outcome<CommitInfo | null>> {
    return outcome(async () => {
      const commit = text('id', id)
      return await this.ctx.dishConfig.revert(commit, { author: { kind: 'user' } }) ?? null
    })
  }

  /** The proposals, newest first: `''` for all, else `open`, `stale` or `rejected`. */
  async proposals(status: string): Promise<Outcome<ProposalInfo[]>> {
    return outcome(async () => {
      const wanted = text('status', status)
      // The store refuses a status that is none of the three.
      return this.ctx.dishConfig.proposals(wanted === '' ? undefined : wanted as ProposalInfo['status'])
    })
  }

  /**
   * One proposal and what it proposes: the diff from the commit it was made on to its tip. Not against `main` as it is
   * now, which would show a stale proposal undoing everything the user changed since.
   */
  async proposal(id: string): Promise<Outcome<{ info: ProposalInfo, diffs: FileDiff[] }>> {
    return outcome(async () => {
      const wanted = text('id', id)
      const store = this.ctx.dishConfig
      const info = (await store.proposals()).find(proposal => proposal.id === wanted)
      if (info === undefined) throw new ConfigStoreError('NOT_FOUND', `there is no proposal ${JSON.stringify(wanted)}`)
      return { info, diffs: await store.diff(info.base, info.tip) }
    })
  }

  /** Put a proposal on `main`. `null` when `main` already had all of it. A stale one is `STALE`. */
  async accept(id: string): Promise<Outcome<CommitInfo | null>> {
    return outcome(async () => {
      const proposal = text('id', id)
      return await this.ctx.dishConfig.accept(proposal, { author: { kind: 'user' } }) ?? null
    })
  }

  /** Turn a proposal down, with a reason. */
  async reject(id: string, reason: string): Promise<Outcome<null>> {
    return outcome(async () => {
      const proposal = text('id', id)
      const why = text('reason', reason)
      await this.ctx.dishConfig.reject(proposal, why, { author: { kind: 'user' } })
      return null
    })
  }

  /** Where the remote copy stands. */
  async remoteStatus(): Promise<Outcome<RemoteStatus>> {
    return outcome(async () => this.ctx.dishConfig.remoteStatus())
  }

  /**
   * Tell the page when to read again. The first item is the current remote status (so a page that opens in the
   * middle of an outage shows it at once); after that `changed`, `proposal` and `remote` as the store reports them.
   * Ends when `signal` aborts, when the consumer stops reading, or when the plugin is unloaded.
   *
   * A reader that falls behind gets the newest 100 of the `changed` and `proposal` events and the latest `remote`
   * status (see `enqueue`).
   */
  async *watch(signal: AbortSignal): AsyncIterable<ConfigEvent> {
    const stop = AbortSignal.any([signal, this.closing.signal])
    if (stop.aborted) return
    const queue: ConfigEvent[] = []
    let wake: (() => void) | undefined
    const push = (event: ConfigEvent): void => { enqueue(queue, event); wake?.() }
    const abort = (): void => { wake?.() }
    stop.addEventListener('abort', abort, { once: true })

    // Listening starts before the snapshot is read, so nothing that happens in between is missed.
    const unsubscribe = [
      this.ctx.on('dish-config/changed', (paths, commit) => { push({ kind: 'changed', commit, paths: [...paths] }) }),
      this.ctx.on('dish-config/proposal', (id, status) => { push({ kind: 'proposal', id, status }) }),
      this.ctx.on('dish-config/remote', (status) => { push({ kind: 'remote', status: wire(status) }) }),
    ]
    try {
      const snapshot = await this.ctx.dishConfig.remoteStatus()
      if (stop.aborted) return
      yield { kind: 'remote', status: wire(snapshot) }
      while (!stop.aborted) {
        const event = queue.shift()
        if (event === undefined) {
          await new Promise<void>((resolve) => { wake = resolve })
          continue
        }
        yield event
      }
    } finally {
      stop.removeEventListener('abort', abort)
      for (const dispose of unsubscribe) dispose()
    }
  }
}

markRemote(ConfigRemote, 'namespaces')
markRemote(ConfigRemote, 'history')
markRemote(ConfigRemote, 'commit')
markRemote(ConfigRemote, 'revert')
markRemote(ConfigRemote, 'proposals')
markRemote(ConfigRemote, 'proposal')
markRemote(ConfigRemote, 'accept')
markRemote(ConfigRemote, 'reject')
markRemote(ConfigRemote, 'remoteStatus')
markRemote(ConfigRemote, 'watch', { mode: 'stream' })
