import { randomBytes } from 'node:crypto'
import { ConfigStoreError } from './errors.ts'
import type { Change, Git, GitIdentity } from './git.ts'
import type { Author, CommitInfo, EditAuthor, LogRecord, Prepared, WriteMeta } from './store.ts'

/** Computed from the repository every time, never stored: see `statusOf`. */
export type ProposalStatus = 'open' | 'stale' | 'rejected'

/** What `onProposal` is told: a proposal's new state, or that it was accepted (and so is gone). */
export type ProposalEvent = 'open' | 'stale' | 'accepted' | 'rejected'

export interface ProposeMeta {
  author: EditAuthor
  /** One line: whitespace is collapsed and it's cut to 120 characters. Not empty. */
  title: string
  /** Why, in as many lines as it takes: at most 8 KiB, no control characters but newline and tab, no line that starts like a `Dish-` trailer. May be empty. */
  rationale: string
}

/** Who accepts. Only a user may. */
export interface AcceptMeta {
  author: EditAuthor
}

/** Who rejects: a user, or the agent session that proposed. */
export interface RejectMeta {
  author: EditAuthor
}

export interface ProposalInfo {
  /** 8 lowercase hex characters. */
  id: string
  title: string
  /** Empty when there was none. */
  rationale: string
  /** Who proposed. */
  author: Author
  /** When it was proposed, in milliseconds since the epoch. */
  created: number
  /** The `main` commit the proposal was made on. */
  base: string
  /** The proposal's own commit: `base` plus the changes. */
  tip: string
  /** The paths the proposal changes, sorted. */
  paths: string[]
  status: ProposalStatus
  /** Why it was rejected; only on a rejected proposal. */
  reason?: string
}

/**
 * What the proposals need of the store, and no more: the store hands this to
 * every call, so the checks, the commit pipeline and the log reader exist once.
 * Package-internal; every method is for use inside the store's queue.
 */
export interface ProposalHost {
  readonly git: Git
  mainCommit(): Promise<string>
  identity(author: Author): GitIdentity
  /**
   * The checks `write` makes before it touches git (the author's kind, the shape
   * and paths of `changes`, ownership, the agent policy, the content guard, the
   * validators, the author's fields). `mode` says what an agent may do: `write`
   * needs the namespace's policy to be `write`, `propose` also takes `propose`.
   * @throws as `write` does.
   */
  prepare(changes: Change[], meta: WriteMeta, mode: 'write' | 'propose'): Prepared
  /** `base`'s tree with `changes` applied, removals first (`NOT_FOUND` for a removal of a missing document). */
  tree(base: string, changes: Change[]): Promise<string>
  /** `write`'s commit step: the commit on `main` (or `undefined` for no change), `base` and subject as `prepared` says. */
  commit(prepared: Prepared): Promise<CommitInfo | undefined>
  /** The author of a call: kind and fields checked, as `write` checks them. */
  author(meta: unknown): EditAuthor
  /** A required one-line text as a note is read: type, control characters, secrets (whole and cut). `undefined` if it has no text. */
  line(field: string, raw: unknown, max: number): string | undefined
  /** @throws `SECRET` if `text` looks like a credential. */
  scan(field: string, text: string): void
  /** A one-line value read back from a commit, as a note is: `undefined` if it isn't one. */
  tidy(value: string, max: number): string | undefined
  /** The message `subject`, a blank line, then the author's trailers and `extra`. */
  message(subject: string, author: Author, extra: string[]): string
  /** `git log` records for `revisions`, newest first. */
  read(revisions: string[]): Promise<LogRecord[]>
  notify(id: string, status: ProposalEvent): void
  warn(message: string): void
  pathList(paths: string[]): string
}

const HEAD_PREFIX = 'refs/heads/proposal/'
const REJECTED_PREFIX = 'refs/dish/rejected/'
const PROPOSAL_ID = /^[0-9a-f]{8}$/
const ID_ATTEMPTS = 5
const TITLE_MAX_CHARS = 120
const REASON_MAX_CHARS = 200
const RATIONALE_MAX_BYTES = 8192
/** C0 but tab and newline, DEL and C1. */
const RATIONALE_CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/
/**
 * A line that reads as a trailer of ours. Git matches trailer keys without regard to case, and a line may be
 * indented in a log, so both are refused. The real trailers are the last paragraph, which no rationale can reach.
 */
const FORGED_TRAILER = /^\s*Dish-[A-Za-z-]+\s*:/mi

function invalid(message: string): ConfigStoreError {
  return new ConfigStoreError('INVALID', message)
}

function rationaleProblem(text: string): string | undefined {
  // Size first: nothing below should have to read a huge string.
  if (Buffer.byteLength(text, 'utf8') > RATIONALE_MAX_BYTES) return 'is over 8 KiB'
  if (RATIONALE_CONTROL.test(text)) return 'contains control characters'
  if (FORGED_TRAILER.test(text)) return 'has a line that starts like a Dish- trailer'
  return undefined
}

/** The rationale as it will be committed: trimmed, within limits, free of secrets. */
function checkRationale(host: ProposalHost, raw: unknown): string {
  if (typeof raw !== 'string') throw invalid('rationale must be a string')
  const text = raw.trim()
  const problem = rationaleProblem(text)
  if (problem !== undefined) throw invalid(`rationale ${problem}`)
  host.scan('rationale', text)
  return text
}

// --- reading proposals back ----------------------------------------------------------------------

/** A proposal's own commit, read and checked. */
interface Parsed {
  id: string
  tip: string
  base: string
  title: string
  rationale: string
  author: Author
  created: number
  paths: string[]
}

/** A proposal found under a ref: its id (the ref's name) and what the ref points at. */
interface Found {
  id: string
  tip: string
}

/**
 * The title and rationale of a message `propose` wrote: `title`, a blank line,
 * the rationale (if any) and a blank line, then the trailers. The trailers are
 * the last paragraph, which git has already read them from.
 */
function splitMessage(message: string): { title: string, rationale: string } | undefined {
  const body = message.replace(/\n+$/, '')
  const cut = body.lastIndexOf('\n\n')
  if (cut === -1) return undefined
  const head = body.slice(0, cut)
  const newline = head.indexOf('\n')
  if (newline === -1) return { title: head, rationale: '' }
  return { title: head.slice(0, newline), rationale: head.slice(newline).trim() }
}

/**
 * `record` as the proposal named `id`, or `undefined` if it isn't one: it must carry
 * exactly that `Dish-Proposal` and a `Dish-Base` that is its only parent, and a title
 * and rationale such as `propose` accepts. Whatever else is under `proposal/` is not ours.
 */
function parse(host: ProposalHost, id: string, record: LogRecord): Parsed | undefined {
  const { info, parents } = record
  if (record.proposal !== id || parents.length !== 1 || parents[0] !== record.base) return undefined
  const parts = splitMessage(info.message)
  if (parts === undefined) return undefined
  const title = host.tidy(parts.title, TITLE_MAX_CHARS)
  if (title === undefined || rationaleProblem(parts.rationale) !== undefined) return undefined
  return { id, tip: info.id, base: record.base, title, rationale: parts.rationale, author: info.author, created: info.time, paths: info.paths }
}

/** The ids and tips under `prefix`: commits whose ref name is 8 lowercase hex characters, and nothing else. */
async function listRefs(git: Git, prefix: string): Promise<Found[]> {
  // `%00` between the fields and a newline after each ref (which a ref name can't contain).
  const output = (await git.run(['for-each-ref', '--format=%(refname)%00%(objectname)%00%(objecttype)', prefix])).stdout
  const found: Found[] = []
  for (const line of output.split('\n')) {
    if (line === '') continue
    const [name, tip, type] = line.split('\0') as [string, string, string]
    const id = name.slice(prefix.length)
    if (type === 'commit' && PROPOSAL_ID.test(id)) found.push({ id, tip })
  }
  return found
}

/** Records for `tips`, by commit id. One `git log` for any number of them. */
async function recordsOf(host: ProposalHost, tips: string[]): Promise<Map<string, LogRecord>> {
  if (tips.length === 0) return new Map()
  return new Map((await host.read(['--no-walk=unsorted', ...tips])).map(record => [record.info.id, record]))
}

/** The proposals on `refs/heads/proposal/`, malformed ones left out. */
async function loadHeads(host: ProposalHost, found: Found[]): Promise<Parsed[]> {
  const records = await recordsOf(host, found.map(({ tip }) => tip))
  const proposals: Parsed[] = []
  for (const { id, tip } of found) {
    const parsed = records.has(tip) ? parse(host, id, records.get(tip)!) : undefined
    if (parsed !== undefined) proposals.push(parsed)
  }
  return proposals
}

/**
 * The rejected proposals on `refs/dish/rejected/`, malformed ones left out. A rejected
 * ref points at the rejection commit, whose only parent is the proposal as it was.
 */
async function loadRejected(host: ProposalHost, found: Found[]): Promise<Array<Parsed & { reason: string }>> {
  const rejections = await recordsOf(host, found.map(({ tip }) => tip))
  const parentIds = [...new Set([...rejections.values()].flatMap(record => record.parents.length === 1 ? record.parents : []))]
  const proposed = await recordsOf(host, parentIds)
  const result: Array<Parsed & { reason: string }> = []
  for (const { id, tip } of found) {
    const rejection = rejections.get(tip)
    if (rejection === undefined || rejection.proposal !== id || rejection.rejected === undefined || rejection.parents.length !== 1) continue
    const record = proposed.get(rejection.parents[0]!)
    const parsed = record === undefined ? undefined : parse(host, id, record)
    if (parsed !== undefined) result.push({ ...parsed, reason: rejection.rejected })
  }
  return result
}

/** The proposal at `refs/heads/proposal/<id>`, if there is a well-formed one. */
async function findHead(host: ProposalHost, id: unknown): Promise<Parsed | undefined> {
  if (typeof id !== 'string' || !PROPOSAL_ID.test(id)) return undefined
  const tip = await host.git.resolve(`${HEAD_PREFIX}${id}`)
  return tip === undefined ? undefined : (await loadHeads(host, [{ id, tip }]))[0]
}

/** The paths of `proposal` that have changed on `main` since its base: stale if there are any. */
function changedSince(host: ProposalHost, proposal: Parsed, head: string): Promise<string[]> {
  return host.git.changedPaths(proposal.base, head, proposal.paths)
}

function describe(proposal: Parsed, status: ProposalStatus, reason?: string): ProposalInfo {
  const { id, title, rationale, author, created, base, tip, paths } = proposal
  const info: ProposalInfo = { id, title, rationale, author, created, base, tip, paths, status }
  if (reason !== undefined) info.reason = reason
  return info
}

// --- the operations ------------------------------------------------------------------------------

/**
 * Open a proposal: a branch `proposal/<id>` holding one commit, whose parent is the
 * `main` it was made on and whose tree is that commit's plus `changes`. The checks are
 * `write`'s, in its order, except that an agent needs the namespace's `agent` policy to
 * be `write` or `propose`; then the title (`INVALID`, `SECRET`) and the rationale
 * (`INVALID`, `SECRET`). Nothing reaches git before they pass.
 * @throws `INVALID` if the changes leave the tree as it is.
 */
export async function proposeChanges(host: ProposalHost, changes: Change[], meta: ProposeMeta): Promise<ProposalInfo> {
  const prepared = host.prepare(changes, { author: meta?.author }, 'propose')
  const title = host.line('title', meta.title, TITLE_MAX_CHARS)
  if (title === undefined) throw invalid('title must not be empty')
  const rationale = checkRationale(host, meta.rationale)

  const base = await host.mainCommit()
  const tree = await host.tree(base, prepared.changes)
  if ((await host.git.changedPaths(base, tree)).length === 0) throw invalid('proposal changes nothing: the documents are as they are on main')

  const subject = rationale === '' ? title : `${title}\n\n${rationale}`
  for (let attempt = 0; attempt < ID_ATTEMPTS; attempt++) {
    const id = randomBytes(4).toString('hex')
    // A rejected proposal keeps its id, so a new one can't take it.
    if (await host.git.resolve(`${REJECTED_PREFIX}${id}`) !== undefined) continue
    const message = host.message(subject, prepared.author, [`Dish-Proposal: ${id}`, `Dish-Base: ${base}`])
    const tip = await host.git.commitTree(tree, [base], message, host.identity(prepared.author))
    // Read before the ref exists, so a failure here leaves no branch behind.
    const record = (await host.read(['--no-walk=unsorted', tip]))[0]
    const parsed = record === undefined ? undefined : parse(host, id, record)
    if (parsed === undefined) throw new Error(`proposal ${id} was committed as ${tip} but cannot be read back`)
    if (!(await host.git.casRef(`${HEAD_PREFIX}${id}`, tip, null))) continue
    host.notify(id, 'open')
    return describe(parsed, 'open')
  }
  throw new Error(`could not find a free proposal id in ${ID_ATTEMPTS} tries`)
}

/**
 * The proposals, newest first (by when they were proposed). `open` and `stale` come from
 * `refs/heads/proposal/`, `rejected` from `refs/dish/rejected/`; without `status`, all three.
 * A proposal is stale when a path it changes has changed on `main` since its base.
 * A ref that holds no well-formed proposal is not listed.
 * @throws `INVALID` for a `status` that is none of the three.
 */
export async function listProposals(host: ProposalHost, status?: ProposalStatus): Promise<ProposalInfo[]> {
  if (status !== undefined && status !== 'open' && status !== 'stale' && status !== 'rejected') {
    throw invalid('status must be "open", "stale" or "rejected"')
  }
  const listed: ProposalInfo[] = []
  if (status !== 'rejected') {
    const head = await host.mainCommit()
    for (const proposal of await loadHeads(host, await listRefs(host.git, HEAD_PREFIX))) {
      const state = (await changedSince(host, proposal, head)).length > 0 ? 'stale' : 'open'
      if (status === undefined || status === state) listed.push(describe(proposal, state))
    }
  }
  if (status === undefined || status === 'rejected') {
    for (const { reason, ...proposal } of await loadRejected(host, await listRefs(host.git, REJECTED_PREFIX))) {
      listed.push(describe(proposal, 'rejected', reason))
    }
  }
  return listed.sort((a, b) => b.created - a.created || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** Delete `ref` if it still holds `tip`. `false` when it doesn't, or git refused. */
async function dropBranch(host: ProposalHost, ref: string, tip: string): Promise<boolean> {
  const result = await host.git.run(['update-ref', '-d', '--no-deref', ref, tip], { allowFail: true })
  return result.code === 0
}

/**
 * Apply a proposal to `main` and delete its branch. Only a user may accept (`FORBIDDEN`).
 * If a path it changes has changed on `main` since its base, nothing is merged: `STALE`,
 * `onProposal(id, 'stale')`, and the branch is kept. Otherwise the tip's version of each
 * path goes through `write`'s checks (ownership, guard and validators as they are now) as one
 * commit whose base is the proposal's, `Accept proposal <id>: <title>`.
 * @returns the commit, or `undefined` when `main` already holds the content (the branch is deleted all the same).
 * @throws `NOT_FOUND` if there is no such proposal (a rejected one is gone as far as this goes).
 */
export async function acceptProposal(host: ProposalHost, id: string, meta: AcceptMeta): Promise<CommitInfo | undefined> {
  const author = host.author(meta)
  if (author.kind !== 'user') throw new ConfigStoreError('FORBIDDEN', 'only a user may accept a proposal')
  const proposal = await findHead(host, id)
  if (proposal === undefined) throw new ConfigStoreError('NOT_FOUND', `no open proposal ${JSON.stringify(id)}`)

  const stale = await changedSince(host, proposal, await host.mainCommit())
  if (stale.length > 0) {
    host.notify(id, 'stale')
    throw new ConfigStoreError('STALE', `proposal ${id} is stale: ${host.pathList(stale)} changed on main since ${proposal.base.slice(0, 7)}; nothing was merged`)
  }

  let commit: CommitInfo | undefined
  // A proposal that changes nothing (only an outside writer can make one) has nothing to apply.
  if (proposal.paths.length > 0) {
    const changes: Change[] = []
    for (const path of proposal.paths) {
      const text = await host.git.readBlob(proposal.tip, path)
      changes.push(text === undefined ? { path, delete: true } : { path, text })
    }
    const prepared = host.prepare(changes, { author, base: proposal.base }, 'write')
    prepared.subject = () => `Accept proposal ${id}: ${proposal.title}`
    prepared.trailers = [`Dish-Proposal: ${id}`]
    if (proposal.author.kind === 'agent') {
      prepared.trailers.push(`Dish-Proposer-Session: ${proposal.author.sessionId}`, `Dish-Proposer-Role: ${proposal.author.role ?? 'main'}`)
    }
    commit = await host.commit(prepared)
  }
  // `main` has the content now, and that is what accept is for: failing to delete the branch only leaves one to reject.
  if (!(await dropBranch(host, `${HEAD_PREFIX}${id}`, proposal.tip))) {
    host.warn(`proposal ${id} was accepted, but its branch could not be deleted (it has moved or git failed); reject it to clear it`)
  }
  host.notify(id, 'accepted')
  return commit
}

/**
 * Reject a proposal: a commit on top of its tip, with the same tree, `Rejected: <reason>`,
 * becomes `refs/dish/rejected/<id>` and the proposal's branch is deleted. A user may reject
 * any proposal, stale ones included; an agent only withdraws one proposed from its own
 * session (`FORBIDDEN`).
 * @throws `INVALID` and `SECRET` for the reason, `NOT_FOUND` if there is no such open or stale proposal.
 */
export async function rejectProposal(host: ProposalHost, id: string, reason: string, meta: RejectMeta): Promise<void> {
  const author = host.author(meta)
  const why = host.line('reason', reason, REASON_MAX_CHARS)
  if (why === undefined) throw invalid('reason must not be empty')
  const proposal = await findHead(host, id)
  if (proposal === undefined) throw new ConfigStoreError('NOT_FOUND', `no open proposal ${JSON.stringify(id)}`)
  if (author.kind === 'agent' && !(proposal.author.kind === 'agent' && proposal.author.sessionId === author.sessionId)) {
    throw new ConfigStoreError('FORBIDDEN', `proposal ${id} is not from this session: an agent may only withdraw its own proposals`)
  }

  const tree = (await host.git.run(['rev-parse', '--verify', `${proposal.tip}^{tree}`])).stdout.trim()
  const message = host.message(`Rejected: ${why}`, author, [`Dish-Rejected: ${why}`, `Dish-Proposal: ${id}`])
  const record = await host.git.commitTree(tree, [proposal.tip], message, host.identity(author))
  const rejected = `${REJECTED_PREFIX}${id}`
  if (!(await host.git.casRef(rejected, record, null))) {
    throw new ConfigStoreError('CONFLICT', `proposal ${id} already has a rejection record; nothing was changed`)
  }
  if (!(await dropBranch(host, `${HEAD_PREFIX}${id}`, proposal.tip))) {
    // The branch moved under us (outside interference). Undo, so the proposal isn't both open and rejected.
    await dropBranch(host, rejected, record)
    throw new ConfigStoreError('CONFLICT', `proposal ${id} changed while it was being rejected; nothing was changed`)
  }
  host.notify(id, 'rejected')
}
