/**
 * The main agent's `run` tool: open, resume and change the run this chat drives, read where it stands, and add its own
 * entries (rulings, deferred findings, notes) to its ledger.
 *
 * - **The main agent only.** Every call starts with `mainSession(exec)`; nothing is read before it. crew keeps the tool
 *   from every role (its `NEVER` list).
 * - **Who writes what.** The tool's own entries are `ruling`, `deferred` and `note`, through `Runs.main` (`by: 'main'`),
 *   built field by field from their parameters: no argument chooses a kind, a writer, a time or a run. Everything else the
 *   ledger gets from a call here (`run.opened`, `run.resumed`, `run.goal`, `run.plan`, `run.closed`) is the core's, written
 *   as the harness.
 * - **Locks.** A session's lock before a run's. The writes check what they can first, then take the session's lock and
 *   the run's for the write alone, read the record again there, and write only if it is still open and this chat's.
 *   `open` makes its worktree before taking the session's lock (`createWorktree` can wait for the project's lock), and
 *   records the run under it. `resume` calls `drive` under the session's lock only (`drive` takes the run's). `status`
 *   and `list` read, and take none: `status` can take as long as a fetch.
 * - **Masked.** Every text the tool gives, and every error's message, goes through `maskSecrets` once more; the core and
 *   the store mask what they keep.
 *
 * @module dish-orchestrator/run-tool
 */

import type {} from '@deepseek-ai/dsh-agent'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, posix, relative, sep } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { maskSecrets } from 'dish-kit'
import { closingRulingsBlock, gateAt, summarize } from './derive.ts'
import { SLUG, splitProject } from './paths.ts'
import { describe, mainSession } from './runs.ts'
import type { Runs, ToolDeps } from './runs.ts'
import { listText, statusText } from './status.ts'
import type { StatusContext } from './status.ts'
import type { Services, WorkspacesReader } from './services.ts'
import { GOAL_MAX, REASON_MAX } from './store.ts'
import type { Run } from './store.ts'
import { cut, errorCode, given, line, sentence, shortSession, shortSha } from './text.ts'

export const MAIN_ONLY = 'the run tool is for the main agent only'
export const NO_RUN = 'This chat drives no run: `run` `open` one (making a worktree opens one too), or `resume` one; `run` `list` shows the open runs.'
export const ACTIONS = ['open', 'resume', 'goal', 'plan', 'abandon', 'status', 'list', 'ruling', 'defer', 'note'] as const

/** The longest plan path `plan` takes. */
const PLAN_MAX = 300
/** The most characters each field of a ruling or a deferred finding keeps. */
const FIELD_MAX = 500
/** The most characters a note keeps. */
const NOTE_MAX = 2000
/** The most characters of an argument a refusal shows. */
const SHOWN_MAX = 200

const STRING = { type: 'string', required: true } as const

const DESCRIPTION = 'Runs: every change that ends in a pull request is a run, with its own branch `dish/<slug>` and a ledger the harness keeps. '
  + 'The project owns it, and one chat drives it at a time (main agent only).\n'
  + '- `open` (`project`, `slug`, `goal`, optional `plan` and `base`) makes the run\'s worktree and drives it. While you drive a run, every worktree '
  + 'you make in its project with `worktree` is one of its tasks. The first worktree a chat makes without a run opens one around it.\n'
  + '- `resume` (`id`, optional `takeover`) drives an open run again: after a compaction, a restart, or from another chat. A run whose pull request '
  + 'is open reopens: fix what its review asks, and `open_pr` pushes to that same pull request.\n'
  + '- `goal`, `plan` (a path in the repo, recorded with its commit) and `abandon` (`reason`) change the run you drive.\n'
  + '- `status` reads where it stands from its ledger: tasks and rounds, the last gate and verdict of each, the final review, the rulings and '
  + 'deferred findings, what `open_pr` would find now, and how the branch stands against GitHub (it fetches): commits behind the default branch, '
  + 'and on GitHub\'s `dish/<slug>`. Read it after a compaction, and before bringing a branch up to date.\n'
  + '- `list` (optional `project`) shows the open runs and who drives them.\n'
  + '- `ruling` (`what`, `why`, `costIfWrong`, optional `task`), `defer` (`what`, `where`, `why`) and `note` (`text`) add your own entries to the '
  + 'ledger. Delegations, endings, gates, verdicts and the PR are recorded by the harness itself.\n'
  + '- `open_pr` ends a run with a pull request.'

const PARAMETERS = {
  action: { type: 'string', enum: ACTIONS, required: true, description: 'What to do; see the tool\'s description.' },
  project: { type: 'string', description: 'open: the project, `owner/repo` as in projects.yaml. list: leave empty for every project.' },
  slug: { type: 'string', description: 'open: the run\'s name, 1 to 40 of a-z, 0-9 and "-". Its branch is `dish/<slug>`, and it names the run\'s own worktree.' },
  goal: { type: 'string', description: 'open, goal: what the change is for, in one line.' },
  plan: { type: 'string', description: 'open (optional), plan: the plan\'s path in the repo, such as `docs/plans/2026-10-03-x.md`.' },
  base: { type: 'string', description: 'open (optional): what to cut the run\'s branch from (a branch, tag or commit). Leave empty for the default branch.' },
  id: { type: 'string', description: 'resume: the run\'s id as `list` shows it, or `owner/repo/<id>`. A run with a pull request reopens, for review feedback on it.' },
  takeover: { type: 'boolean', description: 'resume only: drive the run even though another chat that is still open drives it. That chat then drives nothing.' },
  reason: { type: 'string', description: 'abandon: why, in one line.' },
  what: { type: 'string', description: 'ruling: the call you made. defer: the finding you leave for later.' },
  why: { type: 'string', description: 'ruling, defer: why.' },
  costIfWrong: { type: 'string', description: 'ruling: what it costs if the call is wrong.' },
  where: { type: 'string', description: 'defer: the file, function or area.' },
  task: { type: 'string', description: 'ruling (optional): the slug of the task it is about.' },
  text: { type: 'string', description: 'note: one line to a few.' },
} as const

const OUTPUT = { type: 'object', additionalProperties: false, properties: { action: STRING, run: STRING, text: STRING } } as const

type Action = typeof ACTIONS[number]

/** The arguments as `execute` gets them. */
interface Args {
  action: Action
  project?: string, slug?: string, goal?: string, plan?: string, base?: string, id?: string, takeover?: boolean, reason?: string
  what?: string, why?: string, costIfWrong?: string, where?: string, task?: string, text?: string
}

/** What an action answers: the run it is about (`''` for none), and its text. */
interface Answer {
  run: string
  text: string
}

/** A note: line breaks kept, trailing blanks off each line, runs of blank lines folded to one; masked, and cut to `max`. */
function noteText(text: string, max: number): string {
  const folded = text.replace(/\r\n?/g, '\n').split('\n').map(part => part.trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n').trim()
  return cut(maskSecrets(folded), max)
}

/** An argument as a refusal shows it: one line, masked, short. */
function shown(text: string): string {
  return line(text, SHOWN_MAX)
}

/** Whether `path` (relative, from `relative()`) leads out of the directory it is relative to. */
function leadsOut(path: string): boolean {
  return path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)
}

/**
 * A path in the repo for `plan`: relative, no `..` segment, no NUL or backslash, at most 300 characters, and a regular file
 * inside the worktree once real paths are taken. Gives the normalized path, or why not.
 */
export async function planProblem(worktree: string, path: string): Promise<{ ok: true, path: string } | { ok: false, why: string }> {
  const no = (why: string): { ok: false, why: string } => ({ ok: false, why })
  if (typeof path !== 'string' || path === '') return no('it names no file')
  if (path.length > PLAN_MAX) return no(`it is longer than ${PLAN_MAX} characters`)
  if (path.includes('\0')) return no('it has a NUL character')
  if (path.includes('\\')) return no('it has a backslash: use "/"')
  if (isAbsolute(path)) return no('it is absolute: give a path in the repo, such as docs/plans/x.md')
  if (path.split('/').includes('..')) return no('it has a ".." segment')
  const normalized = posix.normalize(path).replace(/\/+$/, '')
  if (normalized === '' || normalized === '.') return no('it names no file')
  let root: string
  try {
    root = await realpath(worktree)
  } catch {
    return no(`the run's worktree ${worktree} can't be read`)
  }
  let real: string
  try {
    real = await realpath(join(root, normalized))
  } catch (error) {
    const code = errorCode(error)
    if (code === 'ENOENT' || code === 'ENOTDIR') return no('there is no such file in the run\'s worktree')
    return no(`it can't be read: ${describe(error)}`)
  }
  if (leadsOut(relative(root, real))) return no('it leads outside the run\'s worktree')
  try {
    if (!(await stat(real)).isFile()) return no('it isn\'t a regular file')
  } catch (error) {
    return no(`it can't be read: ${describe(error)}`)
  }
  return { ok: true, path: normalized }
}

/** The worktree tool's sentence for `setup` (dish-workspaces tool.ts, the same words). */
function setupSentence(setup: { ran: false, reason: string } | { ran: true, exitCode: number | null, timedOut: boolean, log: string }): string {
  if (setup.ran) return `Setup ran: ${setup.timedOut ? 'it timed out' : `exit ${setup.exitCode ?? 'none'}`} (log: ${setup.log}).`
  return setup.reason === 'no setup' ? 'The project has no setup.' : setup.reason
}

/** The run's tool over `deps`: see the module's header. */
class RunTool {
  readonly #runs: Runs
  readonly #services: Services

  constructor(deps: ToolDeps) {
    this.#runs = deps.runs
    this.#services = deps.services
  }

  async perform(args: Args, exec: ToolRunContext): Promise<Answer> {
    const session = mainSession(exec)
    if (session === undefined) throw new Error(MAIN_ONLY)
    await this.#runs.ready()
    switch (args.action) {
      case 'open': return this.#open(session, args, exec)
      case 'resume': return this.#resume(session, args)
      case 'list': return this.#list(session, args)
      case 'status': return this.#status(session)
      case 'goal': return this.#goal(session, args)
      case 'plan': return this.#plan(session, args)
      case 'abandon': return this.#abandon(session, args)
      case 'ruling': return this.#ruling(session, args)
      case 'defer': return this.#defer(session, args)
      case 'note': return this.#note(session, args)
      default: throw new Error(`${shown(String(args.action))} isn't an action of run: ${ACTIONS.join(', ')}`)
    }
  }

  // --- open and resume ---------------------------------------------------------------------------------------------

  async #open(session: string, args: Args, exec: ToolRunContext): Promise<Answer> {
    const project = given(args.project)
    if (project === undefined) throw new Error('`project` is required for open: `owner/repo` as in projects.yaml')
    const slug = given(args.slug)
    if (slug === undefined || !SLUG.test(slug)) throw new Error('`slug` is required for open: 1 to 40 of a-z, 0-9 and "-"')
    const asked = given(args.goal)
    if (asked === undefined) throw new Error('`goal` is required for open: what the change is for, in one line')
    const goal = line(asked, GOAL_MAX)
    try {
      splitProject(project)
    } catch {
      throw new Error(`${JSON.stringify(shown(project))} isn't a project name: \`owner/repo\``)
    }
    const workspaces = this.#services.workspaces()
    if (workspaces === undefined) throw new Error('dish-workspaces isn\'t running, so the run\'s worktree can\'t be made')
    // dish-workspaces' own words when dish-projects is stopped: projects.yaml itself may be fine.
    const projects = this.#services.projects()
    if (projects === undefined) throw new Error('dish-projects isn\'t running, so no project is registered')
    if (await projects.get(project) === undefined) throw new Error(`${shown(project)} isn't in projects.yaml`)

    // Made before the session's lock: createWorktree waits for the project's lock, and calls no hook (Task 6).
    const created = await workspaces.createWorktree(project, slug, given(args.base), { cwd: exec.agent?.session?.header?.cwd, signal: exec.signal })
    const planned = given(args.plan)
    const checked = planned === undefined ? undefined : await planProblem(created.path, planned)
    const plan = checked?.ok === true ? { path: checked.path, commit: created.base } : undefined
    const { run, released } = await this.#runs.withSession(session, () => this.#runs.openAround(session, {
      project: created.project, slug: created.slug, branch: created.branch, path: created.path, clone: created.clone, base: created.base,
      baseRef: created.baseRef,
    }, { goal, ...plan === undefined ? {} : { plan }, how: 'run' }))

    const lines = [
      `Opened run \`${run.id}\` (${run.project}): ${run.goal}`,
      `Its worktree is ${run.worktree}, on branch ${run.branch}, cut from ${run.base} (${shortSha(run.baseCommit)}).`,
    ]
    if (run.plan !== undefined) lines.push(`Plan: ${run.plan.path} at ${shortSha(run.plan.commit)}.`)
    else if (checked !== undefined && !checked.ok) lines.push(`Plan not attached: ${checked.why}. Attach it with \`run\` \`plan\` once it is in the run's branch.`)
    lines.push(
      `This chat drives it. Worktrees you make in ${run.project} while you drive it are its tasks. Bind coders to it (delegate's \`worktree\`: `
        + `${run.project}/${run.slug}), or to task worktrees made with \`worktree\` (base \`${run.branch}\`). \`open_pr\` ends the run.`,
      setupSentence(created.setup),
    )
    if (released !== undefined) lines.push(`Released run \`${released.id}\`: it stays open, and \`run\` \`resume\` takes it back.`)
    return { run: run.id, text: lines.join('\n') }
  }

  async #resume(session: string, args: Args): Promise<Answer> {
    const id = given(args.id)
    if (id === undefined) throw new Error('`id` is required for resume: the run\'s id, as `run` `list` shows it')
    const found = this.#runs.find(id)
    // drive takes the run's lock itself: under the session's only.
    const result = await this.#runs.withSession(session, () => this.#runs.drive(session, found, { takeover: args.takeover === true }))
    const { run } = result
    const releasedPart = result.released === undefined ? '' : ` Released run \`${result.released.id}\`.`
    const lines: string[] = []
    if (result.how === 'reopened') {
      const pr = run.pr === undefined ? 'Its pull request' : `Its pull request #${run.pr.number} (${run.pr.url})`
      lines.push(`Reopened run \`${run.id}\` (${run.project}) for review feedback: ${sentence(run.goal)}`,
        `${pr} stays open. Fix what the review asks in rounds, as before; then \`open_pr\` runs the same checks and pushes the new head to that `
          + `pull request.${releasedPart}`)
    } else {
      const how = result.how === 'already'
        ? 'You already drive it.'
        : result.how === 'takenOver'
          ? `Took it over from session ${shortSession(result.previous ?? '')}, which now drives nothing.`
          : result.previous === undefined ? 'Nobody drove it.' : `Its driver (session ${shortSession(result.previous)}) wasn't live.`
      lines.push(`Resumed run \`${run.id}\` (${run.project}): ${sentence(run.goal)}`, `${how}${releasedPart}`)
    }
    lines.push('Read `run` `status` for where it stands; open tasks continue with fresh children, and their rounds carry over.')
    return { run: run.id, text: lines.join('\n') }
  }

  // --- reading -----------------------------------------------------------------------------------------------------

  #listOf(session: string, project?: string): string {
    const runs = this.#runs.store.list(project)
    return listText(runs.filter(run => run.state === 'open'), runs.filter(run => run.state === 'pr'), {
      caller: session, now: this.#runs.now(), live: run => this.#runs.live(run), ...project === undefined ? {} : { project },
    })
  }

  async #list(session: string, args: Args): Promise<Answer> {
    return { run: '', text: this.#listOf(session, given(args.project)) }
  }

  async #status(session: string): Promise<Answer> {
    const run = this.#runs.store.drivenBy(session)
    if (run === undefined) return { run: '', text: `${NO_RUN}\n\n${this.#listOf(session)}` }
    const entries = await this.#runs.entries(run)
    const workspaces = this.#services.workspaces()
    const [worktree, branch] = await Promise.all([readWorktree(workspaces, run), compare(workspaces, run)])
    const context: StatusContext = { caller: session, now: this.#runs.now(), ...worktree, branch }
    if (worktree.head !== undefined) {
      const gate = gateAt(entries, worktree.head)
      if (gate !== undefined) context.gateAtHead = gate
    }
    return { run: run.id, text: statusText(run, summarize(run, entries), context) }
  }

  // --- the writes --------------------------------------------------------------------------------------------------

  /** The open run this chat drives, or NO_RUN. */
  #driven(session: string): Run {
    const run = this.#runs.store.drivenBy(session)
    if (run === undefined) throw new Error(NO_RUN)
    return run
  }

  /**
   * `write` with the session's lock and then the run's, given the record as it is there: still open and this chat's, or
   * NO_RUN and nothing written.
   */
  #locked<T>(session: string, run: Run, write: (fresh: Run) => Promise<T>): Promise<T> {
    return this.#runs.withSession(session, () => this.#runs.withRun(run, async () => {
      const fresh = this.#runs.store.get(run.project, run.id)
      if (fresh === undefined || fresh.state !== 'open' || fresh.driver.session !== session) throw new Error(NO_RUN)
      return write(fresh)
    }))
  }

  async #goal(session: string, args: Args): Promise<Answer> {
    const run = this.#driven(session)
    const asked = given(args.goal)
    if (asked === undefined) throw new Error('`goal` is required for goal: what the change is for, in one line')
    const goal = line(asked, GOAL_MAX)
    const written = await this.#locked(session, run, fresh => this.#runs.setGoal(fresh, session, goal))
    return { run: written.id, text: `Run \`${written.id}\`'s goal is now: ${sentence(written.goal)}` }
  }

  async #plan(session: string, args: Args): Promise<Answer> {
    const run = this.#driven(session)
    const asked = given(args.plan)
    if (asked === undefined) throw new Error('`plan` is required for plan: the plan\'s path in the repo, such as `docs/plans/2026-10-03-x.md`')
    const checked = await planProblem(run.worktree, asked)
    if (!checked.ok) throw new Error(`plan ${shown(asked)}: ${checked.why}`)
    const workspaces = this.#services.workspaces()
    if (workspaces === undefined) throw new Error('can\'t read the run\'s head: dish-workspaces isn\'t running')
    let commit: string | undefined
    try {
      commit = await workspaces.headOf(run.worktree)
    } catch (error) {
      throw new Error(`can't read the run's head: ${describe(error)}`)
    }
    if (commit === undefined || commit === '') throw new Error(`can't read the run's head: dish-workspaces doesn't know the worktree ${run.worktree}`)
    const head = commit
    const written = await this.#locked(session, run, fresh => this.#runs.attachPlan(fresh, session, { path: checked.path, commit: head }))
    const plan = written.plan ?? { path: checked.path, commit: head }
    let text = `Attached plan ${plan.path} at ${shortSha(plan.commit)} to run \`${written.id}\`.`
    try {
      const clean = await workspaces.isClean(run.worktree)
      if (!clean.clean) {
        text += ` The worktree isn't clean (${clean.why}), so ${shortSha(plan.commit)} may not hold the plan as it is now: commit it, then attach it again.`
      }
    } catch {
      // Whether it is clean is a warning only: without it, the answer is the attachment.
    }
    return { run: written.id, text }
  }

  async #abandon(session: string, args: Args): Promise<Answer> {
    const run = this.#driven(session)
    const asked = given(args.reason)
    if (asked === undefined) throw new Error('`reason` is required for abandon: why, in one line')
    const reason = line(asked, REASON_MAX)
    const written = await this.#locked(session, run, fresh => this.#runs.close(fresh, session, { state: 'abandoned', reason }))
    const text = `Abandoned run \`${written.id}\`: ${sentence(written.reason ?? reason)} Its worktrees are left as they are: remove them with \`worktree\` \`remove\` `
      + '(with `force` if unmerged). This chat drives no run now.'
    // The run's rulings, read after the close. The run is closed either way: a ledger that can't be read is logged, and the
    // answer goes without them.
    let rulings = ''
    try {
      rulings = closingRulingsBlock(await this.#runs.entries(written))
    } catch (error) {
      this.#runs.logOnce(`run ${written.id} of ${written.project} was abandoned, but its ledger couldn't be read for its rulings: ${describe(error)}`)
    }
    return { run: written.id, text: rulings === '' ? text : `${text}\n\n${rulings}` }
  }

  async #ruling(session: string, args: Args): Promise<Answer> {
    const run = this.#driven(session)
    const what = given(args.what)
    const why = given(args.why)
    const costIfWrong = given(args.costIfWrong)
    if (what === undefined || why === undefined || costIfWrong === undefined) throw new Error('`what`, `why` and `costIfWrong` are required for ruling')
    const task = given(args.task)
    if (task !== undefined) {
      const tasks = summarize(run, await this.#runs.entries(run)).tasks.map(view => view.task)
      if (!tasks.includes(task)) throw new Error(`task \`${shown(task)}\` isn't one of run \`${run.id}\`'s tasks (${tasks.join(', ')})`)
    }
    await this.#locked(session, run, fresh => this.#runs.main(fresh, session, {
      kind: 'ruling', what: line(what, FIELD_MAX), why: line(why, FIELD_MAX), costIfWrong: line(costIfWrong, FIELD_MAX), ...task === undefined ? {} : { task },
    }))
    return { run: run.id, text: `Recorded your ruling in run \`${run.id}\`${task === undefined ? '' : ` on task \`${task}\``}.` }
  }

  async #defer(session: string, args: Args): Promise<Answer> {
    const run = this.#driven(session)
    const what = given(args.what)
    const where = given(args.where)
    const why = given(args.why)
    if (what === undefined || where === undefined || why === undefined) throw new Error('`what`, `where` and `why` are required for defer')
    await this.#locked(session, run, fresh => this.#runs.main(fresh, session, {
      kind: 'deferred', what: line(what, FIELD_MAX), where: line(where, FIELD_MAX), why: line(why, FIELD_MAX),
    }))
    return { run: run.id, text: `Recorded the deferred finding in run \`${run.id}\`.` }
  }

  async #note(session: string, args: Args): Promise<Answer> {
    const run = this.#driven(session)
    const asked = given(args.text)
    if (asked === undefined) throw new Error('`text` is required for note: one line to a few')
    const text = noteText(asked, NOTE_MAX)
    await this.#locked(session, run, fresh => this.#runs.main(fresh, session, { kind: 'note', text }))
    return { run: run.id, text: `Noted in run \`${run.id}\`.` }
  }
}

/**
 * The run's worktree now: its head and whether it is clean, or why they can't be read. Never rejects. Clean as `open_pr`
 * checks it (`{ untracked: 'ignore' }`), so untracked files are named, not a refusal it wouldn't make.
 */
async function readWorktree(workspaces: WorkspacesReader | undefined, run: Run): Promise<Pick<StatusContext, 'head' | 'clean' | 'headProblem'>> {
  if (workspaces === undefined) return { headProblem: 'dish-workspaces isn\'t running' }
  const found: Pick<StatusContext, 'head' | 'clean' | 'headProblem'> = {}
  try {
    const head = await workspaces.headOf(run.worktree)
    if (typeof head === 'string' && head !== '') found.head = head
    else found.headProblem = `dish-workspaces doesn't know the worktree ${run.worktree}`
  } catch (error) {
    found.headProblem = describe(error)
  }
  try {
    found.clean = await workspaces.isClean(run.worktree, { untracked: 'ignore' })
  } catch (error) {
    found.headProblem ??= describe(error)
  }
  return found
}

/** The run's branch against GitHub (`compareBranch`, which fetches), or why it can't tell. Never rejects. */
async function compare(workspaces: WorkspacesReader | undefined, run: Run): Promise<NonNullable<StatusContext['branch']>> {
  if (workspaces === undefined) return { problem: 'dish-workspaces isn\'t running' }
  try {
    return await workspaces.compareBranch(run.project, run.slug)
  } catch (error) {
    return { problem: describe(error) }
  }
}

/** An error as the model gets it: its message masked once more. */
function maskedError(error: unknown): Error {
  let message: string
  try {
    message = error instanceof Error ? error.message : String(error)
  } catch {
    message = 'an error that can\'t be printed'
  }
  return new Error(maskSecrets(message))
}

/** The `run` tool over `deps`. */
export function runTool(deps: ToolDeps): ToolDefinition {
  const tool = new RunTool(deps)
  return defineTool({
    name: 'run',
    description: DESCRIPTION,
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT,
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      let answer: Answer
      try {
        answer = await tool.perform(args as Args, exec)
      } catch (error) {
        throw maskedError(error)
      }
      return { action: args.action, run: answer.run, text: maskSecrets(answer.text) }
    },
  })
}
