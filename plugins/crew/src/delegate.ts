/**
 * dish-crew/delegate: the preset row that gives the main agent the `delegate` tool.
 *
 * `delegate` starts a crew child in a role, or sends a fix round to one the session already started. It is a row of the
 * dish preset (the generated `presets/dish.patch.yml` mounts it), so only agents on that preset have it, and it reads
 * everything else by name when it is called: the settings and the record from `dishCrew`, the role prompts from
 * `dishPrompts`. Either one missing is an error that names the plugin that isn't running. `dishConfig` is optional (both
 * services fall back to the shipped defaults without it), so it is only looked at to say so when a role's prompt is missing.
 *
 * The checks run in the spec's order, and each refusal is an `Error` that says what to do next:
 *
 * 1. **The caller** is the main agent (`isTopLevelAgent`), nobody's child.
 * 2. **The role** is one of `crew.yaml`'s (an own property: the settings have no prototype, and the name comes from the
 *    model) and, for a start, has a prompt. A follow-up doesn't read the prompt: its child keeps the one it started with.
 * 3. **The follow-up target** (`to`) is a crew child of this session, in the same role.
 * 4. **The limits:** children running, writers running, and delegations in the session.
 * 5. **The model:** the role's own, or an override `crew.yaml` lists; the reviewer's by the reviewer rule (`chooseRoute`),
 *    whose reviewed work is a crew child of this session or `"main"`. Then, for a review, **the gate check** (below).
 * 6. **The route** resolves (the model on its family's provider, else the file's, which is what the child starts on), and
 *    7. **the tools** the child may have (`allowList`) are not none.
 * 8. **The start or the send.** A new child's prompt is the task, and, if it has `send_message`, a note that its closing message
 *    is its report (`closingNote`), or, for a coder or a reviewer, that it finishes with `report` (`reportNote`). Each of
 *    crew's blocks ends with a blank line (`BLOCK_END`): dsh's adapters join a message's text blocks with nothing between them.
 *
 * From 4 to the end, a call holds its session's lock, so two calls in one step can't both pass the same check. A start
 * writes the child's record before `startContinuable`, which is given the id the record has: a child that is quick finds
 * its record when it ends. A child that dsh then refuses is ended in the record as failed, and counts as a delegation.
 *
 * **Events (step 7; see `events.ts`).** A start publishes `dish-crew/delegated` right after its child is recorded, before
 * the prompt is built and dsh starts it; a follow-up publishes it after the follow-up is sent and counted, with the child as
 * the record has it then. A start dsh refused publishes `dish-crew/settled` for the run `markFailed` filed. Each is awaited
 * inside the locks the call holds, so a listener that queues its work before it returns (dish-orchestrator's ledger) has it
 * queued before the next delegation of the session, or on the worktree, is checked. A refusal publishes nothing.
 *
 * **Binding a worktree** (`worktree`, a worktree dish-workspaces made, as `<project>/<slug>` or its path). After step 2 (and
 * 3, for a follow-up), before the lock, a start checks that the role writes, that dish-workspaces is running
 * (`dishWorkspaces`, read with `ctx.get`: crew doesn't depend on it, and reads it through `WorkspacesReader`), that it
 * resolves the worktree (when it doesn't, the refusal gives its `resolveProblem`, such as a clone that failed dish's
 * safety check, and why), and that the worktree is inside the calling session's `cwd`, both canonical: a crew child works in
 * its parent's sandbox, which is that workspace, and couldn't write anywhere else. After step 4, inside the session's lock,
 * it takes a second lock keyed by the worktree (always after the session's, so two calls can't deadlock) and refuses a
 * worktree a running crew child is bound to (`dishCrew.worktreeBindings`), of any session; it holds that lock until the
 * child has started, as the session's lock is held, so two chats can't bind one worktree at once. The child is recorded with
 * the worktree (`ChildRecord.worktree`), and its prompt is the task, `worktreeBrief`, and the closing note last. A follow-up
 * keeps its child's binding: a `worktree` that resolves elsewhere is refused, a bound child's worktree must still resolve,
 * the same worktree lock and check apply (less the child itself), and nothing is added to its text.
 *
 * **Gates (6c).** While dish-gates runs (`dishGates`, read with `ctx.get` and through `GatesReader`: crew doesn't depend
 * on it), it gates a bound coder's work when the coder finishes and records the result in crew's record. Two things here
 * read that:
 *
 * - **The brief.** A bound child's `worktreeBrief` gains the gate sentence, with the gate `dishGates.gateFor(project)`
 *   gives: a coder's speaks of `report` (it is gated when it reports done), any other role's is 6c's. No service, no gate for
 *   the project, or a `gateFor` that throws (logged) is no sentence: 6b's block.
 * - **The review check.** A review of a bound child's work (a start with `reviews: <child>`, or a follow-up to a reviewer,
 *   which is how the skills re-review) is refused while that child's gate hasn't passed (`gateStanding`): it is still
 *   running, or the latest result of its latest run isn't a pass, or that run has none. It reads the child's record through
 *   `lookup`, inside the session's lock, as the reviewer rule does. The refusal says where the gate stands and how to go
 *   on: wait for the notice, send a fix round, or give `ruling` (step 7; `gateOverride`, 6c's name, is still accepted) with a
 *   ruling. A ruling (folded onto one line and masked; one with nothing past a leading `Ruling:`, or the placeholder itself,
 *   is refused) is recorded on the reviewer (`ChildRecord.gateOverride`, with its time) and told to it in a block after its
 *   task (`gateOverrideBrief`). A re-review keeps the reviewer's ruling while the reviewed child hasn't run since the ruling
 *   was given. When nothing is refused (the gate passed, the child is unbound, `reviews: "main"`, or dish-gates isn't
 *   running), the ruling is ignored and not recorded.
 *
 * **Runs (step 7).** While dish-orchestrator runs (`dishRuns`, read with `ctx.get` and through `RunsReader`: crew doesn't
 * depend on it), a call is placed in a run (`placeCall`), inside the locks, after every check that refuses without writing
 * anything (the limits, a busy worktree, the reviewer rule, the gate check, the route and the tools) and before anything is
 * recorded or sent:
 *
 * - **The tags.** A start is recorded with the run and the task `dishRuns.place` gives (`ChildRecord.run`, `.task`); a
 *   follow-up keeps its child's, whatever `place` says now. A `place` that throws, or gives a malformed answer, is logged;
 *   either is no run, and a delegation is never refused for it.
 * - **`final`** (the reviewer role only; refused for any other, before anything is read) asks `place` for the run's final
 *   review, and is recorded on the reviewer (`ChildRecord.final`, sticky) only when `place` gives it, and, for a follow-up,
 *   only in the run the reviewer is tagged with: one started outside that run can't give its final review. Otherwise the
 *   answer's note says it had no effect, and why: the chat drives no run, the reviewer is another run's, or dish couldn't
 *   place it (`place` failed, or gave no run while `dishRuns.driving` says the chat drives one); nothing is refused.
 * - **The escalation ladder.** A coder start or follow-up on a run's task is a round, which `place` counts from the run's
 *   ledger. Rounds 1 to 4 get a note in the answer (`ladderNote`). From `LADDER_RULING_ROUND` the call is refused, unless
 *   `ruling` holds a ruling; either way `dishRuns.ladder` records it, and a refusal there is the only one that writes (to the
 *   ledger). Reviewers, other roles, children outside a run, and a follow-up whose child the run no longer places where its
 *   tags say aren't counted.
 *
 * `dish-crew/delegated` is published and awaited inside the same locks, so the next `place` on the task counts this round.
 * Without dish-orchestrator nothing is asked or tagged, and there is no ladder.
 *
 * What counts as running: the child's agent is stepping, or the record says running and the agent exists (accepted, not
 * stepping yet). A record that says running with no agent is a crash's, and isn't running. A follow-up's own target is left
 * out of the count: a message to a child that is running adds no running child, and one to a child that isn't adds one.
 * Who is running comes from dsh's agent registry, read with `ctx.get` like every service the row doesn't `inject`
 * (`dishCrew`, `dishPrompts`, `dishConfig` and `agents` come from plugins that are siblings of the row's, and cordis lets a
 * row read those only that way); a registry that isn't there refuses the call, as nobody counted is not nobody running.
 *
 * The row also rewrites the finish notices of this agent's crew children, so that each names its role, title and model and
 * where its report is (`notice.ts`): one `agent/pre-step` listener, registered here so that it is the preset's and hears
 * only the agents under it.
 *
 * This module is the row and little else: everything it loads of the plugin is plain code (`models`, `allow`, `text`,
 * `record`'s running rule, `events`' publisher, and `notice`, which reads the crew's report files and nothing else outside
 * the process), and the services come in by `import type`.
 *
 * @module dish-crew/delegate
 */
import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-llm'
import type { ContinuableStartSpec } from '@deepseek-ai/dsh-subagent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'
import { isTopLevelAgent, maskSecrets, RETURN_NOTE_LEAD } from 'dish-kit'
import type { DishPrompts, Persona } from 'dish-prompts'
import { allowList, visibleTools } from './allow.ts'
import { publisher } from './events.ts'
import { within } from './guard.ts'
import type { DishCrew, WorktreeBinding } from './index.ts'
import { chooseRoute, offeredModels } from './models.ts'
import type { ReviewedWork, Route } from './models.ts'
import { noticeListener } from './notice.ts'
import { isRunning, latestGate, reportRole } from './record.ts'
import type { ChildRecord } from './record.ts'
import type { CrewSettings, RoleSettings } from './settings.ts'
import { BLOCK_END, gateOverrideBrief, listed, truncate, worktreeBrief } from './text.ts'

export const name = 'dish-crew-delegate'

/** The services the row needs of dsh. `dishCrew`, `dishPrompts`, `dishConfig` and `agents` are read by name (`ctx.get`) on every call. */
export const inject = ['tools', 'subagents', 'llm']

/** The row has nothing to configure: roles, models and limits are in `crew.yaml`. */
export interface Config {}

export const Config: Schema<Config> = Schema.object({})

/** The name the row logs under: the host plugin's, which prints its own lines to the terminal. */
const LOGGER_NAME = 'dish-crew'

const TOOL = 'delegate'
/** The longest title kept, in characters: it is in the label, the notice and the record. */
const TITLE_LENGTH = 80
/** The most children a refusal lists. */
const LISTED_CHILDREN = 6

/**
 * Said to a new child after its task, when it has `send_message`: its parent's id, and that its closing message is its report.
 * dsh appends a note of its own to a continuable child whose `send_message` is dsh's marked one (`withContinuableReturnGuidance`
 * in `dsh-subagent`: "send your result to that agent with send_message"), the opposite of how the crew reports. On the dish
 * preset the child's `send_message` is dish-crew/control's, which carries no mark, so dsh adds nothing and this note gives the
 * parent's id in its place. A preset edited in Settings → Agent presets can still load dsh's row; then dsh's note follows this
 * one, and `marked` has this one say so. It begins as dsh's does (`RETURN_NOTE_LEAD`), which is where dish-judge ends a child's
 * brief. A follow-up (`to`) gets nothing added: dsh appends nothing to it either. Both are recorded under "What dsh gives us"
 * in the spec, so that a dsh upgrade re-checks them. Coders and reviewers get `reportNote` instead (step 7), which differs
 * only in its first sentence after the id: they finish with crew's `report` tool.
 */
export function closingNote(parentId: string, marked: boolean): string {
  const id = JSON.stringify(parentId)
  return `${RETURN_NOTE_LEAD}${id}. Your closing message is your report: when you finish, the main agent receives it in full, automatically. `
    + `So don't send your result with send_message, not even a summary or part of it${marked ? ', even though the note after this one says to' : ''}. `
    + `Use send_message({ agent_id: ${id}, message: "…" }) only for a short question you're blocked on while you work.`
}

/**
 * The closing note for a coder or a reviewer (`reportRole` names one), in place of `closingNote`: it begins with
 * `RETURN_NOTE_LEAD` and the parent's id, as `closingNote` does (dish-judge ends a child's brief there), says to finish with
 * `report`, and keeps `send_message` for a short question the child is blocked on. `marked` as for `closingNote`.
 */
export function reportNote(parentId: string, marked: boolean): string {
  const id = JSON.stringify(parentId)
  return `${RETURN_NOTE_LEAD}${id}. Finish by calling \`report\`: it is your report, and the main agent receives it in full, automatically. `
    + `So don't send your result with send_message, not even a summary or part of it${marked ? ', even though the note after this one says to' : ''}. `
    + `Use send_message({ agent_id: ${id}, message: "…" }) only for a short question you're blocked on while you work.`
}

/**
 * From this round on, a coder start or follow-up on a run's task needs a ruling. The texts (`ladderNote`, the refusal) name
 * the rungs: rounds 1–3 to the same coder, round 4 a fresh coder on the strong tier, round 5 a ruling.
 */
export const LADDER_RULING_ROUND = 5

/**
 * The note in `delegate`'s answer for a coder's round on a run's task: what the escalation ladder suggests. `undefined` for
 * round 0 (the first start), and from `LADDER_RULING_ROUND`, whose words are the caller's (a refusal, or a ruling's note).
 */
export function ladderNote(task: string, round: number): string | undefined {
  if (round >= 1 && round <= 3) {
    return `Round ${round} of task \`${task}\`. The ladder: rounds 1–3 go to the same coder with \`to\`; round 4 is a fresh coder on the strong tier (\`model\`), `
      + 'with the open findings and the previous coder\'s report; from round 5, delegate needs your ruling.'
  }
  if (round === 4) {
    return `Round 4 of task \`${task}\`: the ladder starts a fresh coder on the strong tier (\`model\`), with the open findings and the previous coder's report. `
      + 'From round 5, delegate needs your ruling.'
  }
  return undefined
}

/** dsh's mark on its own `send_message` (`markAdjacentAgentSendMessageTool` in `dsh-subagent/internal`): a process-wide symbol. */
const DSH_SEND_MESSAGE = Symbol.for('dsh.subagent.adjacentAgentSendMessageTool')

/**
 * Whether the `send_message` that `agent` sees is dsh's marked one, as `startContinuable` asks of the child (the child is on
 * its parent's preset): a preset that still loads dsh's `tool-subagent-control`, as one saved in Settings can. `false` when
 * it can't be read.
 */
function dshSendMessage(agent: Agent): boolean {
  try {
    const tool = agent.ctx.tools.get('send_message', agent) as unknown as Record<symbol, unknown> | undefined
    return tool?.[DSH_SEND_MESSAGE] === true
  } catch {
    return false
  }
}

/** The id of a session or a child, as dsh brands it. */
type SessionId = NonNullable<ContinuableStartSpec['childId']>

/**
 * What the row reads of dish-workspaces with `ctx.get('dishWorkspaces')`, structurally: crew doesn't depend on
 * dish-workspaces. `resolve` gives a worktree dish made, of a registered project, or `undefined`; when it gives
 * `undefined`, `resolveProblem` says why for a worktree dish made that fails dish's safety check (its clone's or its
 * own) or whose branch is gone, and `undefined` for anything else. A dish-workspaces without it gives no reason.
 */
interface WorkspacesReader {
  resolve(ref: string): Promise<{ project: string, slug: string, branch: string, path: string, clone: string } | undefined>
  resolveProblem?(ref: string): Promise<string | undefined>
}

/** A worktree `resolve` gave, with its path canonical. */
type Worktree = NonNullable<Awaited<ReturnType<WorkspacesReader['resolve']>>>

/** The longest a worktree a caller gave is shown in a refusal: a path is longer than a name. */
const WORKTREE_SHOWN = 200

/**
 * What the row reads of dish-gates with `ctx.get('dishGates')`, structurally: crew doesn't depend on dish-gates. The
 * service being there says gates run; `gateFor` gives the gate dish-gates runs for a project's bound coders (projects.yaml's
 * `gate` as it is now), or `undefined` for a project it has none for.
 */
interface GatesReader {
  gateFor(project: string): Promise<string | undefined>
}

/** Where `dishRuns.place` puts a delegation: a run's ref (`<owner>/<repo>/<id>`), and for a task its round. */
interface Placement {
  run: string
  task?: string
  /** Given with `task`: the index of this coder start or follow-up among the task's (the first start is 0). */
  round?: number
  /** A reviewer placed in a run, asked for with `final`. */
  final?: true
}

/** What `dishRuns.place` is asked: a bound child's worktree (its canonical path), a reviewer's `reviews`, and `final`. */
interface PlaceTarget {
  worktree?: string
  reviews?: string
  final?: boolean
}

/** What `dishRuns.ladder` records: a round the ladder refused, or let through on a ruling. */
interface LadderEntry {
  sessionId: string
  run: string
  task: string
  round: number
  outcome: 'refused' | 'ruled'
  ruling?: string
  /** A follow-up's target. */
  child?: string
}

/**
 * What the row reads of dish-orchestrator with `ctx.get('dishRuns')`, structurally: crew doesn't depend on it. No method
 * rejects there; a throw here is a broken service, logged and gone past. `driving` (the open run a chat drives) is asked
 * only to word `final`'s note when `place` placed nothing.
 */
interface RunsReader {
  place(sessionId: string, where: PlaceTarget): Promise<Placement | undefined>
  ladder(entry: LadderEntry): Promise<void>
  driving?(sessionId: string): Promise<unknown>
}

/** What a ruling says, as the refusals and the parameter put it. */
const RULING_BODY = 'what — why — cost if wrong'
/** How a ruling is written, as the refusals and the parameter say it. */
const RULING_FORM = `Ruling: ${RULING_BODY}`
/** The placeholder, with or without `Ruling:`, compared without case: a model that copies it back has given no ruling. */
const PLACEHOLDERS: readonly string[] = [RULING_FORM.toLowerCase(), RULING_BODY.toLowerCase()]

/** What `placement` gives for a `place` that threw, or answered with no run in it. */
const UNPLACED: unique symbol = Symbol('not placed')

/** Where a reviewed coder's gate stands while the coder is still running. */
const STILL_RUNNING = 'it is still running'

/** The note for `final` that placed nothing because this chat drives no run. */
const FINAL_NO_RUN = '`final` had no effect: this chat drives no run, so there is no final review for `open_pr` to read.'
/**
 * The note for `final` that placed nothing although dish couldn't tell there is no run: `place` failed (thrown, a malformed
 * answer, or dish-orchestrator's own failure or time limit, which gives no run while the chat drives one). A reviewer bound
 * to a closed run's worktree (state `pr` or abandoned) gets it too, while the chat drives another run, and so would a retry.
 */
const FINAL_UNPLACED = '`final` had no effect: dish couldn\'t place this reviewer in a run, so `final` wasn\'t recorded; try again with a fresh reviewer and `final: true`; '
  + 'if it is bound to a closed run\'s worktree, `run` `resume` that run first.'
/** How long `final`'s note waits for `dishRuns.driving`: it reads the run records in memory. */
const DRIVING_BUDGET_MS = 2000
/** The note for `final` on a follow-up to a reviewer whose tags don't name the run `place` gives now (another run, or none). */
const FINAL_OTHER_RUN = '`final` had no effect: this reviewer was started outside the run this chat drives now, so start a fresh reviewer with `final: true` for that run\'s final review.'
/** The note for `final` without dish-orchestrator. */
const FINAL_NO_RUNS = '`final` had no effect: dish keeps no runs here (dish-orchestrator isn\'t loaded).'

/** The ladder's refusal of more coder work on `task` at `round` (from `LADDER_RULING_ROUND`). */
function ladderRefusal(task: string, round: number): string {
  return `round ${round} of task \`${task}\`: the escalation ladder ends at round 4, so delegate won't send more coder work on this task without your ruling. `
    + `Rule with \`ruling: "${RULING_FORM}"\` (it is recorded), or stop and tell the user (\`run\` action \`abandon\`, with a reason, only if they drop the change).`
}

/** `text` on one line: runs of whitespace, line breaks among them, folded into one space. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * Whether a `ruling` (on one line) holds a ruling: something past a leading `Ruling:`, with a letter or a digit in it, that
 * isn't the placeholder the refusals show.
 */
function hasRuling(ruling: string): boolean {
  if (PLACEHOLDERS.includes(oneLine(ruling).toLowerCase())) return false
  return /[\p{L}\p{N}]/u.test(ruling.replace(/^[\s#>*_`]*ruling[*_`]*\s*:[*_`]*/iu, ''))
}

/** What the tool returns: the child, how it shows, and for a coder on a run's task (or a `final` that did nothing) a note. */
interface Delegated {
  child: string
  role: string
  model: string
  label: string
  note?: string
}

/** What `placeCall` gives: the tags a start is recorded with, `final` when the placement gave it, and the answer's note. */
interface Placed {
  tags: { run?: string, task?: string }
  final?: true
  note?: string
}

/** `value` trimmed, if it is a string with something in it. Models fill every optional parameter, often with `''`. */
function given(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** A title as one line of at most `TITLE_LENGTH` characters. */
function titleOf(value: string | undefined): string | undefined {
  const line = given(value?.replace(/\s+/g, ' '))
  return line === undefined ? undefined : truncate(line, TITLE_LENGTH)
}

/** `value` as a message shows what a caller gave: quoted and cut short. */
function quoted(value: string): string {
  return JSON.stringify(truncate(value))
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** "a coder", "an architect". */
function article(role: string): string {
  return /^[aeiou]/i.test(role) ? `an ${role}` : `a ${role}`
}

/** "1 crew child", "2 crew children". */
function countOf(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

/** A child as a refusal names it. */
function who(child: ChildRecord): string {
  return `${child.role} «${child.title}» (child ${child.id})`
}

function whoList(children: readonly ChildRecord[]): string {
  return listed(children.map(who), LISTED_CHILDREN)
}

/** A bound child as a refusal names it. */
function bindingList(bindings: readonly WorktreeBinding[]): string {
  return listed(bindings.map(binding => `${binding.role} «${binding.title}» (child ${binding.child})`), LISTED_CHILDREN)
}

/** A worktree a caller gave, as a refusal shows it. */
function shownWorktree(value: string): string {
  return `\`${truncate(value, WORKTREE_SHOWN)}\``
}

/** Whether `role` writes files. A role crew.yaml no longer has is taken to, so that a child still running isn't ignored. */
function writes(settings: CrewSettings, role: string): boolean {
  return Object.hasOwn(settings.roles, role) ? settings.roles[role]!.writes : true
}

/** The name of the role that reviews, for a message. */
function reviewerName(settings: CrewSettings): string {
  return Object.entries(settings.roles).find(([, role]) => role.reviews)?.[0] ?? 'reviewer'
}

/** The roles as the tool's description lists them. */
function roleList(settings: CrewSettings | undefined): string {
  if (settings === undefined) return 'the roles crew.yaml defines'
  return Object.entries(settings.roles)
    .map(([role, details]) => `${role}${details.reviews ? ' (reviews other work)' : details.writes ? ' (writes files)' : ''}`)
    .join(', ')
}

/** `names` of unknown tools, if `error` or a cause of it is dsh refusing a filter that names tools the child can't be given. */
function unknownTools(error: unknown): string[] | undefined {
  let current: unknown = error
  for (let depth = 0; depth < 6 && current !== undefined && current !== null; depth++) {
    const message = current instanceof Error ? current.message : typeof current === 'string' ? current : undefined
    const found = message === undefined ? null : /tools\.restrict\(\) names unknown global tools? ((?:"[^"]*"(?:, )?)+)/.exec(message)
    if (found !== null) return [...found[1]!.matchAll(/"([^"]*)"/g)].map(match => match[1]!)
    current = (current as { cause?: unknown }).cause
  }
  return undefined
}

/**
 * The model the main agent runs on now: the one its latest request used (what a switch of model in the session shows
 * in), else the one its options name. `undefined` if neither says.
 */
function mainModel(agent: Agent): string | undefined {
  try {
    const logged = given(agent.session.requestHeader()?.config.model)
    if (logged !== undefined) return logged
  } catch {
    // An agent that can't say is asked the other way.
  }
  return given(agent.options?.model)
}

/**
 * The `code` of the error `dishPrompts.persona` throws for a role with no document in the store and no shipped default: the
 * value of dish-prompts' `UNKNOWN_ROLE`, which a test keeps the same. It is read off the error, never matched by `instanceof`
 * (the error may be of another copy of a module) or by its words, and it is spelled out here because the row loads nothing of
 * dish-prompts.
 */
const UNKNOWN_ROLE = 'UNKNOWN_ROLE'

/** Run a read of the crew's record, and refuse, closed, if it can't be read: the limits and the reviewer rule depend on it. */
async function readRecord<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read()
  } catch (error) {
    throw new Error(`could not read the crew's record (${describe(error)}), so nothing was started or sent. Try again, or tell the user.`, { cause: error })
  }
}

/** The tails of each session's queue, until each is done. Shared by every mount of the row: a session is one agent's. */
const queues = new Map<string, Promise<void>>()

/** Run `job` after what is queued for `key`, whether that worked or not, and give what it gives. */
function exclusive<T>(key: string, job: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve()
  const run = previous.then(job)
  const tail = run.then(() => {}, () => {})
  queues.set(key, tail)
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key)
  })
  return run
}

/** Everything a call needs of what is outside it, and what it has worked out so far. */
interface Call {
  agent: Agent
  signal: AbortSignal
  sessionId: string
  crew: DishCrew
  prompts: DishPrompts
  agents: Context['agents']
  settings: CrewSettings
  role: string
  roleSettings: RoleSettings
  task: string
  title: string | undefined
  to: string | undefined
  reviews: string | undefined
  model: string | undefined
  worktree: string | undefined
  /** dish-gates' service, if it is running: the review check and the brief's gate sentence apply only then. */
  gates: GatesReader | undefined
  /**
   * The main agent's ruling past a check (a review of work whose gate hasn't passed, or a coder past the ladder): `ruling`,
   * else `gateOverride`, folded onto one line and masked; `undefined` for none.
   */
  ruling: string | undefined
  /** `final === true`: a reviewer for the run's final review. */
  final: boolean
  /** dish-orchestrator's service, if it is running: runs, tags and the ladder apply only then. */
  runs: RunsReader | undefined
}

/** What the review check lets through with a ruling: the ruling, and the block the reviewer gets after its task. */
interface Override {
  ruling: string
  block: string
}

/**
 * Why `child`'s gate counts as not passed, for the review check, or `undefined` when it passed or isn't checked: dish-gates
 * isn't running, or the child isn't bound to a worktree. Not passed is: the child is still running; the latest result of its
 * latest run isn't a pass; that run has none (an error or an abort ended it before its turn could, dsh stopped mid-gate,
 * or it ran before dish-gates was on; the text says "gates", as agent-facing text names no plugin); or it is a pass, but
 * the run didn't end `completed` after it. A follow-up steered into the turn the gate passed in has the coder go on in that
 * turn; when the turn then ends normally the gate runs again, but when it is aborted or fails, or dsh stops it (the pass is
 * still on the run in progress), the work after the pass was never gated.
 */
function gateStanding(call: Call, child: ChildRecord): string | undefined {
  if (call.gates === undefined || child.worktree === undefined) return undefined
  if (isRunning(child, call.agents)) return STILL_RUNNING
  const latest = latestGate(child)
  if (latest === undefined) return `no gate result: it didn't run (for example, the ${child.role} ran before gates were on)`
  if (latest.outcome === 'passed') {
    // `latestGate` reads the run in progress first: a pass there is on a run that never ended.
    if (child.gates?.at(-1) !== undefined) return 'dsh stopped the run after its gate passed, so any work after the gate wasn\'t gated'
    const stopReason = child.runs.at(-1)?.stopReason
    if (stopReason === 'completed') return undefined
    return `the run ended (${oneLine(stopReason ?? '') || 'unknown'}) after its gate passed, so any work after the gate wasn't gated`
  }
  if (latest.outcome === 'failed') return oneLine(`failed, round ${latest.round} of ${latest.maxRounds}${latest.log === null ? '' : `; log ${latest.log}`}`)
  const reason = latest.reason === undefined ? '' : oneLine(latest.reason)
  return reason === '' ? latest.outcome : `${latest.outcome}: ${reason}`
}

export function apply(ctx: Context, _config: Config): Promise<void> {
  const logger = ctx.logger(LOGGER_NAME)
  /** A log line that can't throw into the call, whatever the logger does. */
  const warn = (format: string, ...args: unknown[]): void => {
    try {
      logger.warn(format, ...args)
    } catch {
      // Nothing to do about it.
    }
  }

  // The finish notices of this agent's crew children. A row's listener is the preset's: dsh-scope delivers it the steps of
  // the agents under the preset, and `noticeListener` leaves a message that isn't this agent's own child's alone.
  ctx.on('agent/pre-step', noticeListener(ctx, warn))

  // `dish-crew/delegated`, and `dish-crew/settled` for a start dsh refused. Never rejects.
  const publish = publisher(ctx, warn)

  // Services of plugins crew doesn't depend on, whose `Context` declarations it may not see, read by name as `index.ts` does.
  const lookup = ctx as unknown as { get(name: string): unknown }

  /** The child `id` if this session started it. @throws a refusal that names the session's children, if not. */
  async function ownChild(call: Call, id: string, what: string, hint: string): Promise<ChildRecord> {
    const found = await readRecord(() => call.crew.records.lookup(id))
    if (found !== undefined && found.sessionId === call.sessionId) return found.record
    const children = await readRecord(() => call.crew.records.children(call.sessionId))
    throw new Error(`${what} ${quoted(id)} is not a crew child of this session. `
      + (children.length === 0 ? 'This session has started no crew children. ' : `This session's crew children: ${whoList(children)}. `)
      + hint)
  }

  /** Step 4, over `children`: those of the session the call adds to, less a follow-up's own target. @throws a refusal that says who is running and what to do. */
  function enforceLimits(call: Call, children: readonly ChildRecord[], isStart: boolean): void {
    const { limits } = call.settings
    // Running: the child's agent is stepping, or is accepted (the record says running and the agent exists).
    const running = children.filter(child => isRunning(child, call.agents))
    if (running.length >= limits.running) {
      throw new Error(`${countOf(running.length, 'crew child is', 'crew children are')} running, which is the limit (limits.running in crew.yaml is ${limits.running}): ${whoList(running)}. `
        + 'Wait for a notice, then delegate again.')
    }
    if (call.roleSettings.writes) {
      const writers = running.filter(child => writes(call.settings, child.role))
      if (writers.length >= limits.writers) {
        const [only] = writers
        throw new Error(writers.length === 1 && only !== undefined
          ? `${article(only.role)} is running (child ${only.id}, «${only.title}»); wait for its notice, or delegate a read-only role.`
          : `${writers.length} writing children are running, which is the limit (limits.writers in crew.yaml is ${limits.writers}): ${whoList(writers)}; wait for a notice, or delegate a read-only role.`)
      }
    }
    if (isStart && children.length >= limits.perSession) {
      throw new Error(`this session has started ${countOf(children.length, 'crew child', 'crew children')}, which is the limit (limits.perSession in crew.yaml is ${limits.perSession}); starts that failed count too. `
        + 'Send a follow-up to one of them with `to`, or tell the user the limit is reached.')
    }
  }

  /**
   * The work the reviewer reviews, for `reviews`: the main agent's own, or a crew child of this session, with that child's
   * record (read through `lookup`, for the gate check).
   * @param followUp - the refusals' lead-in and advice when this is for a follow-up, whose work can't be changed, so that
   * the advice for a start (to set `reviews` differently) isn't given to it.
   */
  async function reviewedWork(call: Call, reviews: string, followUp?: { lead: string, again: string }): Promise<{ work: ReviewedWork, child?: ChildRecord }> {
    if (reviews === 'main') {
      const model = mainModel(call.agent)
      if (model === undefined) {
        throw new Error(followUp === undefined
          ? 'can\'t tell which model you (the main agent) run on, so no reviewer family can be chosen to differ from it; '
            + 'review a crew child\'s work instead (set reviews to its id).'
          : `${followUp.lead} can't tell which model you (the main agent) run on, so there's no checking that it differs from the reviewer's. ${followUp.again}`)
      }
      return { work: { model } }
    }
    const child = await ownChild(call, reviews, '`reviews`', 'Use one of those ids, or "main" to review your own work.')
    // A reviewer's report is a review: what a review of it would add is the work, which it already looked at.
    if (child.reviews !== undefined || (Object.hasOwn(call.settings.roles, child.role) && call.settings.roles[child.role]!.reviews)) {
      if (followUp !== undefined) throw new Error(`${followUp.lead} the work it reviewed (${quoted(reviews)}) is itself a review, not work. ${followUp.again}`)
      throw new Error(`\`reviews\` ${quoted(reviews)} is ${article(child.role)} «${child.title}», whose report is a review, not work; `
        + (child.reviews === undefined
          ? 'review the work itself instead (its id, or "main" for your own).'
          : `review the work it reviewed: ${child.reviews}.`))
    }
    return { work: { model: child.model, family: child.family }, child }
  }

  /**
   * The review check (6c), for a review of `child`'s work, on the record `reviewedWork` read inside the session's lock.
   * `undefined` when there is nothing to override (see `gateStanding`): a ruling given is then ignored. Otherwise the
   * ruling, and the block the reviewer gets.
   *
   * A re-review with no ruling keeps the reviewer's ruling when the reviewed child hasn't run since the ruling was
   * given (`gateOverrideAt`, at the reviewer's start or on a follow-up; `startedAt` for a ruling recorded before its time
   * was kept): its latest run ended before then, and none is in progress or running. The ruling was given on exactly the
   * standing it has now; any fix round, crash or resume of that child ends it.
   * @param followUp - a re-review's lead-in, and the reviewer it goes to.
   * @throws a refusal that says where the gate stands and how to go on, when there is no ruling or one with none in it.
   */
  function gateCheck(call: Call, child: ChildRecord, followUp?: { lead: string, reviewer: ChildRecord }): Override | undefined {
    const standing = gateStanding(call, child)
    if (standing === undefined) return undefined
    const block = (ruling: string): Override => ({ ruling, block: gateOverrideBrief(`${child.role} «${child.title}», child ${child.id}`, standing, ruling) })
    const next = standing === STILL_RUNNING
      ? `Wait for its finish notice, which says how its gate ended, and ${followUp === undefined ? 'delegate the review' : 'send the follow-up'} then`
      : `Send ${followUp === undefined ? 'it' : `that ${child.role}`} a fix round with \`to: "${child.id}"\``
    const anyway = followUp === undefined ? 'start the review anyway' : 'send this follow-up anyway'
    const refused = `${followUp === undefined ? '' : `${followUp.lead} `}${who(child)}'s gate hasn't passed (${standing}). ${next}, or ${anyway} with \`ruling: "${RULING_FORM}"\`.`
    if (call.ruling === undefined) {
      const reviewer = followUp?.reviewer
      const lastEnded = child.runs.at(-1)?.endedAt
      if (reviewer?.gateOverride !== undefined && standing !== STILL_RUNNING && child.last !== 'running'
        && lastEnded !== undefined && lastEnded < (reviewer.gateOverrideAt ?? reviewer.startedAt)) return block(reviewer.gateOverride)
      throw new Error(refused)
    }
    if (!hasRuling(call.ruling)) throw new Error(`ruling needs the ruling itself: ${RULING_BODY}. ${refused}`)
    return block(call.ruling)
  }

  /** Step 5 for a start: the route of the new child, `reviews` as it is recorded, and the record of a crew child it reviews. */
  async function chooseModel(call: Call): Promise<{ route: Route, reviews: string | undefined, reviewed: ChildRecord | undefined }> {
    let reviewed: { work: ReviewedWork, child?: ChildRecord } | undefined
    if (call.roleSettings.reviews) {
      if (call.reviews === undefined) {
        throw new Error(`the ${call.role} role needs reviews: the id of the crew child whose work it reviews, or "main" for your own work.`)
      }
      reviewed = await reviewedWork(call, call.reviews)
    } else if (call.reviews !== undefined) {
      const reviewer = reviewerName(call.settings)
      throw new Error(`reviews is for the reviewer role (${reviewer}), and ${call.role} doesn't review. Leave reviews out, or delegate to ${reviewer}.`)
    }
    const chosen = chooseRoute({
      settings: call.settings,
      role: call.role,
      ...call.model === undefined ? {} : { override: call.model },
      ...reviewed === undefined ? {} : { reviewed: reviewed.work },
    })
    if (!chosen.ok) throw new Error(chosen.problem)
    return { route: chosen.route, reviews: call.roleSettings.reviews ? call.reviews : undefined, reviewed: reviewed?.child }
  }

  /**
   * The gate dish-gates runs for `project`, for a bound coder's brief, masked (dish-gates masks it too). `undefined` without
   * dish-gates, without a gate, or when `gateFor` fails (logged). Never throws.
   */
  async function gateOf(call: Call, project: string): Promise<string | undefined> {
    if (call.gates === undefined) return undefined
    try {
      const gate: unknown = await call.gates.gateFor(project)
      return typeof gate === 'string' && gate.trim() !== '' ? maskSecrets(gate) : undefined
    } catch (error) {
      warn('could not read the gate of project %s, so the coder\'s brief doesn\'t name it: %s', project, describe(error))
      return undefined
    }
  }

  /** Step 6. @throws a refusal that names the route's provider and model and lists the models crew.yaml offers, as `provider/model` where a family has its own provider. */
  async function checkRoute(call: Call, route: Route): Promise<void> {
    try {
      await ctx.llm.resolveCallConfig({ provider: route.provider, model: route.model }, call.signal)
    } catch (error) {
      if (call.signal.aborted) throw error
      throw new Error(`model ${route.provider}/${route.model} is not available (${describe(error)}). `
        + `Models crew.yaml offers: ${listed(offeredModels(call.settings))}. Pick one of those with model, or fix crew.yaml.`, { cause: error })
    }
  }

  /** dish-workspaces' service. @throws a refusal that names the plugin, if it isn't running. */
  function workspaces(): WorkspacesReader {
    const service: WorkspacesReader | undefined = ctx.get('dishWorkspaces')
    if (service === undefined) {
      throw new Error('delegate can\'t bind a worktree: the dishWorkspaces service is not available, so the dish-workspaces plugin is not running. '
        + 'Enable the dish-workspaces plugin, or leave worktree out.')
    }
    return service
  }

  /** What `reader` resolves `ref` to, with its path canonical, or `undefined`. @throws a refusal if it can't be looked up. */
  async function resolveWorktree(reader: WorkspacesReader, ref: string): Promise<Worktree | undefined> {
    let found: Worktree | undefined
    try {
      found = await reader.resolve(ref)
    } catch (error) {
      throw new Error(`could not look up worktree ${shownWorktree(ref)} (${describe(error)}), so nothing was started or sent. Try again, or tell the user.`, { cause: error })
    }
    if (found === undefined) return undefined
    try {
      return { ...found, path: await realpath(found.path) }
    } catch {
      // Gone since dish-workspaces looked.
      return undefined
    }
  }

  /** Why `reader` gives no worktree for `ref`, when dish-workspaces can say (a worktree it made that fails a check). Never throws. */
  async function unresolvedProblem(reader: WorkspacesReader, ref: string): Promise<string | undefined> {
    try {
      const problem = await reader.resolveProblem?.(ref)
      return typeof problem === 'string' && problem !== '' ? problem : undefined
    } catch {
      // No reason to give: the refusal is the one for a worktree it doesn't know.
      return undefined
    }
  }

  /** `resolveWorktree`, refusing a worktree it doesn't give: with dish-workspaces' reason when it has one. */
  async function knownWorktree(reader: WorkspacesReader, ref: string): Promise<Worktree> {
    const found = await resolveWorktree(reader, ref)
    if (found !== undefined) return found
    const problem = await unresolvedProblem(reader, ref)
    if (problem !== undefined) throw new Error(`worktree ${shownWorktree(ref)} can't be bound: ${problem}. Nothing was started or sent; tell the user.`)
    throw new Error(`no worktree ${shownWorktree(ref)} in a registered project; make one with the worktree tool (action create)`)
  }

  /** The first check of a `worktree`: the role writes. */
  function enforceWrites(call: Call): void {
    if (!call.roleSettings.writes) throw new Error(`\`worktree\` is for roles that write; give ${article(call.role)} the path in its task instead`)
  }

  /**
   * The checks of a start's `worktree` that need no lock: the role writes, dish-workspaces is running, it resolves the
   * worktree, and the worktree is inside the calling session's `cwd`, both canonical. `undefined` if the call has none.
   */
  async function startBinding(call: Call): Promise<Worktree | undefined> {
    if (call.worktree === undefined) return undefined
    enforceWrites(call)
    const found = await knownWorktree(workspaces(), call.worktree)
    const where = `start a chat in the project's workspace (\`${found.clone}\`)`
    const cwd = call.agent.session.header.cwd
    if (cwd === undefined) throw new Error(`this chat has no workspace, so a coder couldn't write in worktree \`${found.path}\`; ${where}`)
    let root: string
    try {
      root = await realpath(cwd)
    } catch (error) {
      throw new Error(`this chat's workspace (\`${cwd}\`) can't be read (${describe(error)}), so a coder couldn't write in worktree \`${found.path}\`; ${where}`, { cause: error })
    }
    if (!found.path.startsWith(root === '/' ? '/' : `${root}/`)) {
      throw new Error(`worktree \`${found.path}\` is outside this chat's workspace (\`${root}\`), where a coder couldn't write; ${where}`)
    }
    return found
  }

  /**
   * The checks of a follow-up's binding that need no lock: a `worktree` given must resolve to the one the child is bound to,
   * and a bound child's worktree must still resolve. Gives the worktree the child is bound to, or `undefined` if none.
   */
  async function followUpBinding(call: Call, target: ChildRecord): Promise<string | undefined> {
    if (call.worktree === undefined && target.worktree === undefined) return undefined
    const again = `start a new ${call.role}`
    if (call.worktree !== undefined) {
      enforceWrites(call)
      // Before dish-workspaces is asked: this is the reason, whatever it would say.
      if (target.worktree === undefined) {
        throw new Error(`child ${target.id} isn't bound to a worktree, and a follow-up can't bind one. Leave worktree out, or ${again} with it.`)
      }
      const given = await knownWorktree(workspaces(), call.worktree)
      if (given.path !== target.worktree) {
        throw new Error(`child ${target.id} is bound to worktree \`${target.worktree}\`, and a follow-up can't move it to \`${given.path}\`. Leave worktree out, or ${again} with it.`)
      }
      return target.worktree
    }
    const bound = target.worktree!
    const reader = workspaces()
    const found = await resolveWorktree(reader, bound)
    if (found?.path !== bound) {
      const problem = found === undefined ? await unresolvedProblem(reader, bound) : undefined
      if (problem !== undefined) throw new Error(`child ${target.id}'s worktree \`${bound}\` can't be used: ${problem}. Nothing was sent; tell the user.`)
      throw new Error(`child ${target.id}'s worktree \`${bound}\` is gone (merged or removed); ${again}`)
    }
    return bound
  }

  /**
   * The check of a worktree inside its lock: no running crew child, of any session, is bound to it but `except` (a
   * follow-up's own child). @throws a refusal that names who is.
   */
  async function enforceFree(call: Call, worktree: string, except?: string): Promise<void> {
    const bindings = await readRecord(() => call.crew.worktreeBindings(worktree))
    const running = bindings.filter(binding => binding.running && binding.child !== except)
    if (running.length > 0) {
      throw new Error(`worktree \`${worktree}\` is bound to ${bindingList(running)}, which ${running.length === 1 ? 'is' : 'are'} running; `
        + 'wait for its notice, or make another worktree with the worktree tool.')
    }
  }

  /**
   * `dishRuns.place`'s answer, checked: `undefined` for no run, and `UNPLACED` for a throw or an answer with no run in it,
   * which is logged (either is no run for the tags). A `task` is kept when it is a non-empty string, a `round` only with a
   * task and when it is a whole number, and `final` only when it is `true`. Never throws: a delegation is never refused for
   * a run it couldn't be placed in.
   */
  async function placement(call: Call, runs: RunsReader, where: PlaceTarget): Promise<Placement | typeof UNPLACED | undefined> {
    let answer: unknown
    try {
      answer = await runs.place(call.sessionId, where)
    } catch (error) {
      warn('could not place a delegation in a run: %s', describe(error))
      return UNPLACED
    }
    if (answer === undefined) return undefined
    const found = (typeof answer === 'object' && answer !== null ? answer : {}) as Record<string, unknown>
    const { run, task, round } = found
    if (typeof run !== 'string' || run === '') {
      let shown: string
      try {
        shown = JSON.stringify(answer) ?? String(answer)
      } catch {
        shown = typeof answer
      }
      warn('could not place a delegation in a run: dishRuns.place gave no run (%s)', truncate(maskSecrets(shown), 200))
      return UNPLACED
    }
    const placed: Placement = { run }
    if (typeof task === 'string' && task !== '') {
      placed.task = task
      if (typeof round === 'number' && Number.isSafeInteger(round) && round >= 0) placed.round = round
    }
    if (found.final === true) placed.final = true
    return placed
  }

  /**
   * For `final`'s note, when `place` gave no run: whether that was dish's failure rather than no run, that is, the chat
   * drives an open run (dish-orchestrator's `place` gives no run past its time limit or on a failure, which it logs), or
   * `driving` can't say (thrown, or no answer within DRIVING_BUDGET_MS; logged). Without `driving`, no run.
   */
  async function placeFailed(call: Call, runs: RunsReader): Promise<boolean> {
    if (typeof runs.driving !== 'function') return false
    try {
      const driven = await within(Promise.resolve().then(() => runs.driving!(call.sessionId)), DRIVING_BUDGET_MS)
      return driven !== undefined && driven !== null
    } catch (error) {
      warn('could not ask dish-orchestrator which run this chat drives: %s', describe(error))
      return true
    }
  }

  /** `dishRuns.ladder`, whose failure is logged and gone past: the refusal, or the ruled call, stands either way. */
  async function recordLadder(runs: RunsReader, entry: LadderEntry): Promise<void> {
    try {
      await runs.ladder(entry)
    } catch (error) {
      warn('could not record the escalation ladder\'s %s at round %d of task %s in run %s: %s', entry.outcome, entry.round, entry.task, entry.run, describe(error))
    }
  }

  /**
   * Inside the locks, after every check that refuses without writing anything and before anything is recorded or sent: the
   * tags for a start, `final`, and the escalation ladder for a coder on a run's task. `target` is a follow-up's child, whose
   * tags are its own, whatever `place` says now.
   *
   * Without dish-orchestrator there are no tags and no ladder, and the only note is `final`'s. A follow-up is counted only
   * when `place` still puts it where its child's tags say (the same run and task), and made final only in its child's run.
   * @throws the ladder's refusal, from `LADDER_RULING_ROUND`, when `ruling` holds no ruling; it is recorded first.
   */
  async function placeCall(call: Call, where: { worktree?: string | undefined, reviews?: string | undefined }, target?: ChildRecord): Promise<Placed> {
    const { runs } = call
    if (runs === undefined) return { tags: {}, ...call.final ? { note: FINAL_NO_RUNS } : {} }
    const answer = await placement(call, runs, {
      ...where.worktree === undefined ? {} : { worktree: where.worktree },
      ...where.reviews === undefined ? {} : { reviews: where.reviews },
      ...call.final ? { final: true } : {},
    })
    const placed = answer === UNPLACED ? undefined : answer
    // `final` placed nothing: say why, never "no run" for a chat that drives one.
    const unplaced = call.final && placed === undefined && (answer === UNPLACED || await placeFailed(call, runs))
    // A follow-up's reviewer gives the final review of its own run only: tagged with another run, or none, the ledger would
    // put the verdict where `open_pr` doesn't read it.
    const elsewhere = target !== undefined && placed !== undefined && (target.run === undefined || placed.run !== target.run)
    const final = call.final && placed?.final === true && !elsewhere
    const own = target ?? placed
    const tags = { ...own?.run === undefined ? {} : { run: own.run }, ...own?.task === undefined ? {} : { task: own.task } }
    const finish = (note?: string): Placed => {
      const notes = [note, call.final && !final ? (elsewhere ? FINAL_OTHER_RUN : unplaced ? FINAL_UNPLACED : FINAL_NO_RUN) : undefined].filter(text => text !== undefined)
      return { tags, ...final ? { final: true } : {}, ...notes.length === 0 ? {} : { note: notes.join(' ') } }
    }
    const { task } = tags
    const round = placed?.round
    if (call.role !== 'coder' || task === undefined || placed === undefined || round === undefined) return finish()
    if (target !== undefined && (placed.run !== target.run || placed.task !== target.task)) return finish()
    if (round < LADDER_RULING_ROUND) return finish(ladderNote(task, round))
    const entry = { sessionId: call.sessionId, run: placed.run, task, round, ...target === undefined ? {} : { child: target.id } }
    if (call.ruling === undefined || !hasRuling(call.ruling)) {
      await recordLadder(runs, { ...entry, outcome: 'refused' })
      const refused = ladderRefusal(task, round)
      throw new Error(call.ruling === undefined ? refused : `ruling needs the ruling itself: ${RULING_BODY}. ${refused}`)
    }
    await recordLadder(runs, { ...entry, outcome: 'ruled', ruling: call.ruling })
    return finish(`Round ${round} of task \`${task}\`, past the ladder, on your ruling (recorded).`)
  }

  /**
   * Record `childId` as failed, for a start dsh refused, and publish `dish-crew/settled` for the run it filed, so a start that
   * was published as delegated also ends. A record that can't be written is logged: the refusal still comes.
   */
  async function markFailed(call: Call, childId: string, message: string): Promise<void> {
    let ended: Awaited<ReturnType<DishCrew['records']['endRun']>>
    try {
      ended = await call.crew.records.endRun(childId, { stopReason: 'error', error: message, closing: '' })
    } catch (error) {
      warn('could not record the failed start of child %s as failed: %s', childId, describe(error))
      return
    }
    if (ended !== undefined) await publish('dish-crew/settled', { sessionId: ended.sessionId, child: ended.child, run: ended.run })
  }

  /** Steps 5 to 8 for a new child, bound to `bound` if it is given. Inside the session's lock, and the worktree's. */
  async function start(call: Call, persona: Persona, title: string, bound: Worktree | undefined): Promise<Delegated> {
    const { route, reviews, reviewed } = await chooseModel(call)
    const override = reviewed === undefined ? undefined : gateCheck(call, reviewed)
    await checkRoute(call, route)
    const allowed = allowList(call.roleSettings.tools, visibleTools(call.agent), call.role)
    if (!allowed.ok) throw new Error(allowed.problem)
    // After every check that refuses without writing, before anything is recorded: the ladder's refusal writes to the ledger.
    const placed = await placeCall(call, { worktree: bound?.path, reviews })
    const label = `${call.role} · ${route.model} · ${title}`
    // The id is ours, and the record is written first: a child that is quick ends before `startContinuable` returns, and
    // its `subagent/end` has to find a record.
    const childId = randomUUID()
    const gate = bound === undefined ? undefined : await gateOf(call, bound.project)
    let child: ChildRecord
    try {
      child = await call.crew.records.addChild(call.sessionId, {
        id: childId, role: call.role, title, model: route.model, family: route.family, ...reviews === undefined ? {} : { reviews },
        ...bound === undefined ? {} : { worktree: bound.path }, ...override === undefined ? {} : { gateOverride: override.ruling },
        ...placed.tags, ...placed.final === true ? { final: true } : {},
      })
    } catch (error) {
      throw new Error(`could not record the delegation, so nothing was started: ${describe(error)}. Try again, or tell the user.`, { cause: error })
    }
    // Before dsh starts the child, so that its start comes before anything it ends with; inside the locks (see the header).
    await publish('dish-crew/delegated', { sessionId: call.sessionId, child, followUp: false })
    // The closing note stays last: dish-judge ends a child's brief at it, and on a preset that loads dsh's own `send_message` it
    // refers to the note dsh adds after it. Each block ends with a blank line (`BLOCK_END`): dsh's adapters join text blocks
    // with nothing between them. A coder or a reviewer finishes with `report`, and is told so (`reportNote`); every other
    // role's closing message is its report (`closingNote`).
    const prompt = [{ type: 'text' as const, text: `${call.task}${BLOCK_END}` }]
    if (bound !== undefined) prompt.push({ type: 'text', text: `${worktreeBrief(bound, gate, call.role === 'coder')}${BLOCK_END}` })
    if (override !== undefined) prompt.push({ type: 'text', text: `${override.block}${BLOCK_END}` })
    if (allowed.allow.includes('send_message')) {
      const note = reportRole({ role: call.role, reviews }) === undefined ? closingNote : reportNote
      prompt.push({ type: 'text', text: `${note(call.sessionId, dshSendMessage(call.agent))}${BLOCK_END}` })
    }
    try {
      await ctx.subagents.startContinuable({
        provider: call.crew.subagentProvider,
        label,
        childId: childId as SessionId,
        request: {
          prompt,
          parent: call.agent,
          agentOptions: { provider: route.provider, model: route.model },
          persona: persona.prefix,
          toolFilter: { allow: allowed.allow },
          maxDepth: 1,
        },
        signal: call.signal,
      })
    } catch (error) {
      const message = describe(error)
      await markFailed(call, childId, message)
      const tools = unknownTools(error)
      throw new Error(tools === undefined
        ? `could not start the ${call.role}: ${message}. The start failed and counts as a delegation. Try again, or tell the user.`
        : `role ${call.role}'s tools include ${tools.join(', ')}, which a child can't be given here; `
          + `remove ${tools.length === 1 ? 'it' : 'them'} from roles.${call.role}.tools in crew.yaml. Nothing was started; the start failed and counts as a delegation.`,
      { cause: error })
    }
    return { child: childId, role: call.role, model: route.model, label, ...placed.note === undefined ? {} : { note: placed.note } }
  }

  /**
   * Step 5 for a follow-up to a reviewer: the child keeps its model, so what is checked is that the work it reviews is
   * not in its family now. The main agent's model can have changed since it started. Gives the record of the crew child
   * whose work it reviews, for the gate check; `undefined` for the main agent's own work.
   * @throws a refusal that says to start a new reviewer.
   */
  async function checkReviewer(call: Call, target: ChildRecord): Promise<ChildRecord | undefined> {
    const again = `Start a new ${call.role} instead (leave to out).`
    if (call.reviews !== undefined && target.reviews !== undefined && call.reviews !== target.reviews) {
      throw new Error(`child ${target.id} reviews ${target.reviews}, and a follow-up can't point it at other work (${call.reviews}). ${again}`)
    }
    const reviews = target.reviews ?? call.reviews
    if (reviews === undefined) throw new Error(`the ${call.role} role needs reviews, and child ${target.id} has none recorded. ${again}`)
    if (reviews !== 'main') {
      const found = await readRecord(() => call.crew.records.lookup(reviews))
      if (found === undefined || found.sessionId !== call.sessionId) {
        throw new Error(`the work child ${target.id} reviewed (${quoted(reviews)}) is no longer in the record, so there is nothing to check its model against. ${again}`)
      }
    }
    const lead = `can't send a follow-up to ${call.role} child ${target.id}:`
    const { work, child } = await reviewedWork(call, reviews, { lead, again })
    const checked = chooseRoute({ settings: call.settings, role: call.role, override: target.model, reviewed: work })
    if (!checked.ok) throw new Error(`${lead} ${checked.problem} ${again}`)
    return child
  }

  /** Steps 5 and 8 for a follow-up. Inside the session's lock. */
  async function followUp(call: Call, target: ChildRecord): Promise<Delegated> {
    if (call.model !== undefined) {
      throw new Error(`a follow-up can't change the model: child ${target.id} keeps ${target.model}. Leave model out.`)
    }
    let override: Override | undefined
    if (call.roleSettings.reviews) {
      // A re-review is a review: the work it reviews is checked as for a start.
      const reviewed = await checkReviewer(call, target)
      override = reviewed === undefined ? undefined : gateCheck(call, reviewed, { lead: `can't send a follow-up to ${call.role} child ${target.id}:`, reviewer: target })
    } else if (call.reviews !== undefined) {
      const reviewer = reviewerName(call.settings)
      throw new Error(`reviews is for the reviewer role (${reviewer}), and ${call.role} doesn't review. Leave reviews out, or delegate to ${reviewer}.`)
    }
    // As for a start: after every check that refuses without writing, before anything is sent. The child keeps its tags.
    const placed = await placeCall(call, { worktree: target.worktree, reviews: target.reviews }, target)
    // A blank line between the task and the ruling's block, as for a start; nothing follows the last block.
    const content = [{ type: 'text' as const, text: override === undefined ? call.task : `${call.task}${BLOCK_END}` }]
    if (override !== undefined) content.push({ type: 'text', text: override.block })
    try {
      await ctx.subagents.sendMessage(call.agent, target.id as SessionId, content, { signal: call.signal })
    } catch (error) {
      throw new Error(`could not send the follow-up to child ${target.id}: ${describe(error)}. Try again, or start a new ${call.role} (leave to out): a child that never started can't be resumed.`, { cause: error })
    }
    // Sent. A record that can't be updated is logged, not thrown: an error would have the model send it again. `final` is set
    // when the placement gave it, and never cleared: a reviewer already final stays final.
    const extra = { ...override === undefined ? {} : { gateOverride: override.ruling }, ...placed.final === true ? { final: true as const } : {} }
    try {
      await (Object.keys(extra).length === 0 ? call.crew.records.addFollowUp(target.id) : call.crew.records.addFollowUp(target.id, extra))
    } catch (error) {
      warn('could not record the follow-up to child %s: %s', target.id, describe(error))
    }
    // Published whether or not it was counted: it was sent. The child as the record has it now, else as it would be.
    let found: { record: ChildRecord } | undefined
    try {
      found = await call.crew.records.lookup(target.id)
    } catch {
      found = undefined
    }
    await publish('dish-crew/delegated', {
      sessionId: call.sessionId, child: found?.record ?? { ...target, followUps: target.followUps + 1, last: 'running' }, followUp: true,
    })
    return {
      child: target.id, role: target.role, model: target.model, label: `${target.role} · ${target.model} · ${target.title}`,
      ...placed.note === undefined ? {} : { note: placed.note },
    }
  }

  /** The `call` for the arguments, after the checks that need no one's state: who is calling, the services, the role, the task. */
  async function prepare(args: { role: string, title?: string, task: string, to?: string, reviews?: string, model?: string, worktree?: string, ruling?: string, gateOverride?: string, final?: boolean }, agent: Agent | undefined, signal: AbortSignal): Promise<Call> {
    if (agent === undefined || !isTopLevelAgent(agent)) {
      throw new Error('delegate is for the main agent only: a crew child can\'t delegate. Do the work yourself, or send_message the main agent if you need something done.')
    }
    const crew = ctx.get('dishCrew')
    if (crew === undefined) {
      throw new Error('delegate can\'t run: the dishCrew service is not available, so the dish-crew plugin is not running. Enable the dish-crew plugin.')
    }
    const prompts = ctx.get('dishPrompts')
    if (prompts === undefined) {
      throw new Error('delegate can\'t run: the dishPrompts service is not available, so the dish-prompts plugin is not running. '
        + 'Every child\'s prompt comes from it. Enable the dish-prompts plugin.')
    }
    const agents = ctx.get('agents')
    if (agents === undefined) {
      throw new Error('delegate can\'t run: dsh\'s agent registry (the agents service) is not available, so nobody can be counted as running; nothing was started or sent. Try again, or tell the user.')
    }
    const settings = await crew.settings()
    const role = given(args.role)
    if (role === undefined) throw new Error(`role is empty; the roles in crew.yaml are: ${listed(Object.keys(settings.roles))}. Use one of those.`)
    if (!Object.hasOwn(settings.roles, role)) {
      throw new Error(`unknown role ${quoted(role)}; the roles in crew.yaml are: ${listed(Object.keys(settings.roles))}. Use one of those.`)
    }
    const task = given(args.task)
    if (task === undefined) throw new Error('task is empty: give the child the complete, self-contained brief.')
    // A cheap check, before the prompt or a follow-up's target is read.
    const final = args.final === true
    if (final && !settings.roles[role]!.reviews) {
      throw new Error(`final is for the reviewer role (${reviewerName(settings)}): it marks the run's final review. Leave final out for ${article(role)}.`)
    }
    const gates: GatesReader | undefined = ctx.get('dishGates')
    const runs = lookup.get('dishRuns') as RunsReader | undefined
    // `ruling`, else 6c's `gateOverride`: one line, masked, before anything records it or puts it in a message.
    const ruling = given(args.ruling) ?? given(args.gateOverride)
    return {
      agent, signal, crew, prompts, agents, settings, role, roleSettings: settings.roles[role]!, task: args.task,
      sessionId: String(agent.id), title: titleOf(args.title), to: given(args.to), reviews: given(args.reviews), model: given(args.model),
      worktree: given(args.worktree), gates, ruling: ruling === undefined ? undefined : maskSecrets(oneLine(ruling)), final, runs,
    }
  }

  const text = (value: string): [{ type: 'text', text: string }] => [{ type: 'text', text: value }]

  return (async () => {
    // The roles in the description are those of crew.yaml as it is now. A refusal for an unknown role lists them as they are then.
    let settings: CrewSettings | undefined
    try {
      settings = await ctx.get('dishCrew')?.settings()
    } catch {
      settings = undefined
    }

    ctx.tools.register(defineTool({
      name: TOOL,
      description: `Hand a task to one crew specialist: ${roleList(settings)}. `
        + 'Each runs in the background as its own agent, on the model and with the tools its role has in crew.yaml, and sees only what you write here, '
        + 'so `task` must be self-contained: the goal, the files and constraints, what done looks like and what to report. '
        + 'You are notified when each child finishes, with its report: after you delegate, end your turn and wait for that notice instead of polling, '
        + 'and keep answering the user meanwhile. '
        + 'For a fix round, call delegate again with `to` set to the same child\'s id and the same role: `task` goes to that child as a follow-up, '
        + 'and it carries on with what it already knows. Don\'t use send_message for fix rounds. '
        + 'To have work reviewed, delegate to the reviewer role with `reviews` set to the id of the child whose work it reviews, or "main" for your own work; '
        + 'the harness picks a model from a different family than the work was done on, and refuses one that is not. '
        + 'To have a coder (a role that writes) work in a worktree you made with the `worktree` tool, pass it as `worktree`: its brief names it, and its follow-ups stay bound to it. '
        + 'While gates are on, a bound coder\'s work is gated when it reports done, and its finish notice says how the gate ended; '
        + 'a review of that work is refused until the gate passes, unless `ruling` carries your ruling. '
        + 'In a run, each coder start or follow-up on a task is a round: from round 5, delegate refuses more coder work on that task unless `ruling` carries your ruling. '
        + 'Set `final: true` on the reviewer of a run\'s final review. '
        + 'crew.yaml limits how many children run at once, how many write files at once (one by default; read-only roles run in parallel) and how many delegations a session makes; '
        + 'a refusal says who is running and what to do. Returns the child\'s id, role, model and label, and for a coder on a run\'s task the ladder\'s note.',
      parameters: {
        role: { type: 'string', required: true, description: `A role in crew.yaml: ${roleList(settings)}.` },
        // Not required in the schema: a follow-up has no use for one, and dsh refused a follow-up without it before
        // `execute` ran (a wasted call in the clippy session of 2026-10-03). A start without one is refused below.
        title: { type: 'string', description: '3 to 6 words naming the work, needed to start a child. It is in the child\'s label and in its finish notice. Leave empty for a follow-up.' },
        task: { type: 'string', required: true, description: 'The complete, self-contained brief. For a follow-up, the new instructions: the findings to fix, say.' },
        to: { type: 'string', description: 'The id of a crew child this session started, in the same role, to send `task` to as a follow-up (a fix round) instead of starting a new child. Leave empty to start a new one.' },
        reviews: { type: 'string', description: 'Reviewer role only, and required for it: the id of the crew child whose work is reviewed, or "main" for your own work. Leave empty for any other role.' },
        model: { type: 'string', description: 'An override of the role\'s default model: a model id from the families in crew.yaml. A reviewer\'s must be in a different family from the work reviewed. Not for a follow-up. Leave empty for the default.' },
        worktree: { type: 'string', description: 'A worktree from the `worktree` tool, as `<project>/<slug>` or the path it returned, to bind a coder to: its brief names it, and the harness checks its work there. Only for roles that write. Leave empty otherwise.' },
        ruling: { type: 'string', description: 'Only after delegate refused for want of one (a review of work whose gate hasn\'t passed, or a coder past round 4 of its task): '
          + `your ruling, on one line, as \`${RULING_FORM}\`. It is recorded. Leave empty otherwise.` },
        gateOverride: { type: 'string', description: 'The old name of `ruling`, still accepted. Use `ruling`. Leave empty.' },
        final: { type: 'boolean', description: 'Reviewer role only: true makes this the run\'s final review, the one `open_pr` checks (its verdict must approve the head that is pushed). '
          + 'It stays final for its follow-ups, and a follow-up with true makes that reviewer final. Leave false otherwise.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            child: { type: 'string', required: true, description: 'The child\'s id: pass it as `to` or `reviews` later.' },
            role: { type: 'string', required: true },
            model: { type: 'string', required: true },
            label: { type: 'string', required: true, description: 'How the child shows in the session header: role, model and title.' },
            note: { type: 'string', description: 'For a coder working on a run\'s task: its round, and what the escalation ladder suggests.' },
          },
        },
        render: (args, value) => {
          const prefix = `${value.role} · ${value.model} · `
          const title = value.label.startsWith(prefix) ? value.label.slice(prefix.length) : value.label
          const line = given(args.to) === undefined
            ? `started ${value.role} «${title}» on ${value.model} (child ${value.child})`
            : `sent a follow-up to ${value.role} «${title}» (child ${value.child})`
          return text(value.note === undefined ? line : `${line}\n${value.note}`)
        },
      },
      async execute(args, exec) {
        const call = await prepare(args, exec.agent, exec.signal)
        // A start needs the role's prompt, and a title. A follow-up needs neither: its child keeps the prompt it began with.
        let persona: Persona | undefined
        let target: ChildRecord | undefined
        if (call.to === undefined) {
          if (call.title === undefined) throw new Error('title is empty: give 3 to 6 words that name the work.')
          try {
            persona = await call.prompts.persona(call.role)
          } catch (error) {
            // The service rejects with the code `UNKNOWN_ROLE` for a role that has neither a document nor a shipped default,
            // and otherwise only when it can't read the store: advice to write a document would be wrong for that.
            throw new Error((error as { code?: unknown } | null)?.code === UNKNOWN_ROLE
              ? `role ${call.role} has no prompt (${describe(error)}): add prompts/crew/${call.role}.md to the config store, then delegate again.`
                + `${ctx.get('dishConfig') === undefined ? ' dish-config is not running, so only the shipped prompts exist.' : ''}`
              : `could not read the prompt of role ${call.role} (${describe(error)}), so nothing was started. Try again, or tell the user.`, { cause: error })
          }
        } else {
          target = await ownChild(call, call.to, '`to`', 'Use one of those ids, or leave `to` out to start a new child.')
          if (target.role !== call.role) {
            throw new Error(`child ${target.id} is ${article(target.role)} «${target.title}», not ${article(call.role)}: a follow-up goes to a child of its own role. `
              + `Set role to ${target.role}, or leave to out to start a new ${call.role}.`)
          }
        }
        // The worktree's checks that need no lock. A start's is the worktree to bind; a follow-up's, the one its child is bound to.
        const bound = target === undefined ? await startBinding(call) : undefined
        const worktree = target === undefined ? bound?.path : await followUpBinding(call, target)
        const { title } = call
        return exclusive(call.sessionId, async () => {
          call.signal.throwIfAborted()
          const children = await readRecord(() => call.crew.records.children(call.sessionId))
          // A follow-up adds no running child if its target is running, and one if it isn't: either way, what it is checked
          // against is everyone else.
          enforceLimits(call, target === undefined ? children : children.filter(child => child.id !== target.id), target === undefined)
          const deliver = (): Promise<Delegated> => target === undefined ? start(call, persona!, title!, bound) : followUp(call, target)
          if (worktree === undefined) return deliver()
          // Always after the session's lock, so two calls can't each hold the lock the other waits for.
          return exclusive(`worktree:${worktree}`, async () => {
            call.signal.throwIfAborted()
            await enforceFree(call, worktree, target?.id)
            return deliver()
          })
        })
      },
    }))
  })()
}
