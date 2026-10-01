/**
 * The server half of Settings → Judge: a Typert remote service the browser calls through `ctx.remote.dishJudge`.
 *
 * It is built like `dish-config`'s and dish-prompts' remotes, and for the same reasons:
 *
 * - the gateway serves any root service that carries a `typertRemote` binding and `@Remote` markers, reading wire
 *   parameter names from the method source (so every parameter is a plain identifier). This package runs as type-stripped
 *   `.ts`, which has no decorator syntax, so the markers are applied by `markRemote`;
 * - every parameter is plain JSON, and `''` means absent: no base, no note, no filter;
 * - every write is made as the user, a person at the keyboard;
 * - a refusal the person can act on comes back as `{ ok: false, code, message }`, not as a throw: Typert has a closed set
 *   of failure codes, and its gateway folds anything thrown into `gateway/internal`. That covers the store's own codes,
 *   matched on `.code`, and three of this remote's own: `INVALID` for a value or a query that isn't one, `UNAVAILABLE` for a
 *   write with no store, and `JUDGE_UNAVAILABLE` for a test Jev could not answer. Anything else is a bug, and is thrown.
 *
 * **The TypeSafe key never touches this remote.** No method takes it or gives it back: the page sets, removes and describes
 * it through dsh's own `credentials` remote, and this service doesn't read it (`status` asks the client, which looks it up
 * and tells only whether there is one). `status` says the credential's *name*, which the page needs for that. As a last
 * line, everything that leaves here and came from outside the code (a log line, a withheld result, a message) passes the
 * secret mask once more: the log masked it on the way in, and this is for a file that something else wrote, or one from
 * before a pattern was added.
 *
 * Everything the page shows from the log, and the withheld content above all, is written by agents or web pages. This
 * remote hands it over as it is, as strings; it is the page's part to show it as text and as nothing else.
 *
 * The store is optional (`dishConfig`) and looked up on every call. Without it `thresholds` answers with the shipped
 * default, and `saveThresholds` is `UNAVAILABLE`.
 *
 * @module dish-judge/remote
 */

import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { CommitInfo as StoreCommitInfo, DishConfigService, ErrorCode as StoreErrorCode, WriteMeta } from 'dish-config'
import { markRemote, maskSecrets } from 'dish-kit'
import type { Answer, JudgeStatus } from './client.ts'
import type { JudgeLogLine, JudgePurpose, ReadQuery, ReadResult } from './log.ts'
import { JUDGE_PURPOSES } from './log.ts'
import { NAMESPACE } from './protocol.ts'
import type {
  CommitInfo, ErrorCode, LogLine, LogPage, Outcome, SettingsValues, StatusInfo, TestResult, ThresholdsRead, WithheldContent,
} from './protocol.ts'
import { serializeSettings } from './serialize.ts'
import { DEFAULT_SETTINGS, DEFAULT_TEXT, parseSettings } from './settings.ts'
import type { JudgeSettings } from './settings.ts'

/** The Cordis service key. (The wire namespace is `NAMESPACE`.) */
export const SERVICE = 'dishJudgeRemote'

declare module '@deepseek-ai/cordis' {
  interface Context {
    dishJudgeRemote: JudgeRemote
  }
}

// What the page is told must be what the server says: these fail to compile if either side drifts.
type Same<A, B> = [A] extends [B] ? [B] extends [A] ? SameKeys<A, B> : false : false
/** Mutual assignability lets a field that is optional on one side only through: the keys of two objects must be the same too. */
type SameKeys<A, B> = [A] extends [object] ? [B] extends [object] ? ([keyof A] extends [keyof B] ? [keyof B] extends [keyof A] ? true : false : false) : true : true
type Check<T extends true> = T
/** `T` without `readonly`, all the way down. */
type Writable<T> = T extends readonly (infer U)[] ? Writable<U>[] : T extends object ? { -readonly [K in keyof T]: Writable<T[K]> } : T
export type WireMatchesServer = [
  Check<Same<StoreErrorCode, Exclude<ErrorCode, 'UNAVAILABLE' | 'JUDGE_UNAVAILABLE'>>>,
  Check<Same<StoreCommitInfo, CommitInfo>>,
  Check<Same<JudgeStatus & { keyName: string }, StatusInfo>>,
  Check<Same<Writable<JudgeSettings>, SettingsValues>>,
  Check<Same<JudgeLogLine, LogLine>>,
  Check<Same<JudgePurpose, LogLine['purpose']>>,
  Check<Same<Extract<Answer, { type: 'noul' }>, TestResult['answer']>>,
  Check<Same<ReadResult, LogPage>>,
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

/** `value` with every string in it, and every key, passed through the secret mask: for what came from outside the code. */
function masked<T>(value: T): T {
  if (typeof value === 'string') return maskSecrets(value) as T
  if (Array.isArray(value)) return value.map(masked) as T
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [maskSecrets(key), masked(inner)])) as T
  }
  return value
}

/** `settings` as the page's to change: a copy, with nothing frozen and nothing `readonly`. */
function values(settings: JudgeSettings): SettingsValues {
  return structuredClone(settings) as Writable<JudgeSettings>
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

/** A count parameter: a missing one is `0`, which the log reads as its default. */
function countOf(name: string, value: unknown): number {
  if (value === undefined) return 0
  if (typeof value !== 'number') throw new Refusal('INVALID', `${name} must be a number`)
  return value
}

/**
 * Run `task` and put what it returns, or a refusal, in an `Outcome`; any other failure is thrown. What the store or the log
 * refuses is matched by its code, or by being a `RangeError` (the log's words for a query that isn't one): a class from
 * another package is not recognised by `instanceof`.
 */
async function outcome<T>(task: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: wire(await task()) }
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code
    if (error instanceof Refusal || (error instanceof Error && isStoreCode(code))) {
      return { ok: false, code: (error as Refusal).code, message: maskSecrets(error.message) }
    }
    throw error
  }
}

/** The one fixed question of the test button, and what it is asked about. */
const TEST_STATE = 'The sky is blue.'
const TEST_QUESTION = 'Is `state` a statement about the weather or sky?'
const TEST_ID = 'weather'

/** The store, or the refusal a write has without one. */
function storeToWrite(ctx: Context): DishConfigService {
  const store = ctx.get('dishConfig')
  if (store === undefined) throw new Refusal('UNAVAILABLE', 'the config store isn\'t running, so the thresholds can\'t be saved')
  return store
}

/**
 * `settings`, as the page sent them, checked by `parseSettings`: the same check the store applies to the file, so there is one
 * source of truth for what a valid file is, and its messages name the same paths. The page's values are plain JSON, which is
 * YAML too, so they go through the parser as text.
 */
function validated(settings: unknown): JudgeSettings {
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) throw new Refusal('INVALID', 'settings must be an object')
  const parsed = parseSettings(JSON.stringify(settings))
  if (!parsed.ok) throw new Refusal('INVALID', parsed.problem)
  return parsed.settings
}

/** What a failure of `log.read` or `log.withheld` is to the page: the log's `RangeError` is a query that isn't one. */
function asRefusal(error: unknown): unknown {
  return error instanceof RangeError ? new Refusal('INVALID', error.message) : error
}

/** The purposes a `log` call may filter by: the log's own. */
const PURPOSES: readonly string[] = JUDGE_PURPOSES

export interface RemoteOptions {
  /** The credential's name in dsh's store: what the page sets and removes. Not the key. */
  keyName: string
  /** What writes settings as the text of `judge.yaml`: `serializeSettings`. A seam for a test to make it fail. */
  serialize?: (settings: JudgeSettings) => string
}

export class JudgeRemote extends TypertRemoteService {
  static inject = ['dishJudge', 'judge']

  private readonly keyName: string
  private readonly serialize: (settings: JudgeSettings) => string

  constructor(ctx: Context, options: RemoteOptions) {
    super(ctx, SERVICE, { namespace: NAMESPACE })
    this.keyName = options.keyName
    this.serialize = options.serialize ?? (settings => serializeSettings(settings))
  }

  /**
   * Where the judge stands: the client's own status (reachable or not, the last error, the latencies and counts of the last
   * 100 calls, whether there is a key) and the credential's name. Not an `Outcome`: it has nothing to refuse.
   */
  async status(): Promise<StatusInfo> {
    const status = await this.ctx.judge.status()
    return masked(wire({ ...status, keyName: this.keyName }))
  }

  /**
   * Ask Jev one fixed question, "The sky is blue." and whether that is about the weather or the sky, and give the answer and how
   * long it took. A call like any other: it is logged (as an `ask` with the subject "Settings → Judge test" and the decision
   * `test`) and counts in the status. Jev failing to answer, for whatever reason, is `JUDGE_UNAVAILABLE` with the client's words.
   */
  async test(): Promise<Outcome<TestResult>> {
    return outcome(async () => {
      const asked = await this.ctx.judge.ask({
        state: TEST_STATE,
        questions: { [TEST_ID]: { type: 'noul', instructions: TEST_QUESTION } },
        purpose: 'ask',
        subject: 'Settings → Judge test',
        decide: () => ({ decision: 'test' }),
      })
      if (!asked.ok) throw new Refusal('JUDGE_UNAVAILABLE', asked.message)
      const answer = asked.answers[TEST_ID]
      if (answer?.type !== 'noul') throw new Refusal('JUDGE_UNAVAILABLE', 'the judge answered something else than was asked')
      return { answer, latencyMs: asked.latencyMs }
    })
  }

  /**
   * The thresholds' document as the form loads it: the stored text, the settings in it, and the commit it was read at (what a
   * save passes as `base`). A document missing from the store, a stored text that doesn't pass the check (`problem`: the judge
   * is using the shipped default meanwhile) and no store at all give the shipped default.
   */
  async thresholds(): Promise<Outcome<ThresholdsRead>> {
    return outcome(async () => {
      const store = this.ctx.get('dishConfig')
      if (store === undefined) return { text: DEFAULT_TEXT, settings: values(DEFAULT_SETTINGS), commit: null, missing: false }
      // Read at the commit that is reported, so the two agree whatever is written meanwhile.
      const commit = await store.head()
      const stored = await store.read('judge.yaml', commit)
      if (stored === undefined) return { text: DEFAULT_TEXT, settings: values(DEFAULT_SETTINGS), commit, missing: true }
      const parsed = parseSettings(stored)
      return parsed.ok
        ? { text: stored, settings: values(parsed.settings), commit, missing: false }
        : { text: stored, settings: values(DEFAULT_SETTINGS), commit, missing: false, problem: parsed.problem }
    })
  }

  /**
   * Save `settings` as `judge.yaml`, as the user: checked by `parseSettings` (the store's own check, so its message is what a
   * refusal says, naming the path, as `INVALID`), written in the shipped file's key order with its comments, and committed.
   * @param settings - what `thresholds` gave, as the page changed it: plain JSON. A number the person typed as words is
   *   passed on as it is, and refused with the check's message.
   * @param base - `''` for none; else the full commit id the form loaded (`thresholds`' `commit`), and a document that has
   *   changed since is `CONFLICT`.
   * @param note - `''` for none; else why, in a line, which becomes the commit's `Dish-Note`.
   * @returns the commit, or `null` when the document already says this.
   */
  async saveThresholds(settings: SettingsValues, base: string, note: string): Promise<Outcome<CommitInfo | null>> {
    return outcome(async () => {
      const checked = validated(settings)
      const from = stringOf('base', base)
      const why = stringOf('note', note)
      const store = storeToWrite(this.ctx)
      const meta: WriteMeta = { author: { kind: 'user' } }
      if (why !== '') meta.note = why
      if (from !== '') meta.base = from
      return await store.write([{ path: 'judge.yaml', text: this.serialize(checked) }], meta) ?? null
    })
  }

  /**
   * A page of the decision log, newest first.
   * @param purpose - `''` for all; else `command`, `approval`, `screen` or `ask`.
   * @param decision - `''` for all; else any decision string: the set is open, and a filter that matches nothing gives no lines.
   * @param limit - at most this many (1 to 500); `0` for the log's default, 200.
   * @param before - `''` for the newest; else the `next` of the page before.
   */
  async log(purpose: string, decision: string, limit: number, before: string): Promise<Outcome<LogPage>> {
    return outcome(async () => {
      const wanted = stringOf('purpose', purpose)
      if (wanted !== '' && !PURPOSES.includes(wanted)) throw new Refusal('INVALID', `purpose must be one of ${PURPOSES.join(', ')} (or empty for all)`)
      const query: ReadQuery = {}
      if (wanted !== '') query.purpose = wanted as JudgePurpose
      const kind = stringOf('decision', decision)
      if (kind !== '') query.decision = kind
      const most = countOf('limit', limit)
      if (most !== 0) query.limit = most
      const after = stringOf('before', before)
      if (after !== '') query.before = after
      try {
        return masked(await this.ctx.dishJudge.log.read(query))
      } catch (error) {
        throw asRefusal(error)
      }
    })
  }

  /**
   * The content the result screen withheld from an agent, as the log kept it (masked and capped), for the person to read. It is
   * attacker-written text: the page shows it as text and as nothing else. An id that is no withheld file is `NOT_FOUND`; the
   * files go after 30 days with the lines that name them.
   */
  async withheld(id: string): Promise<Outcome<WithheldContent>> {
    return outcome(async () => {
      const which = stringOf('id', id)
      let kept
      try {
        kept = await this.ctx.dishJudge.log.withheld(which)
      } catch (error) {
        throw asRefusal(error)
      }
      if (kept === undefined) throw new Refusal('NOT_FOUND', 'there is no withheld content under that id: it may be older than 30 days, when the log is pruned')
      return masked(kept)
    })
  }
}

markRemote(JudgeRemote, 'status')
markRemote(JudgeRemote, 'test')
markRemote(JudgeRemote, 'thresholds')
markRemote(JudgeRemote, 'saveThresholds')
markRemote(JudgeRemote, 'log')
markRemote(JudgeRemote, 'withheld')
