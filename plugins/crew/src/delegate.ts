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
 *    whose reviewed work is a crew child of this session or `"main"`.
 * 6. **The route** resolves, and 7. **the tools** the child may have (`allowList`) are not none.
 * 8. **The start or the send.**
 *
 * From 4 to the end, a call holds its session's lock, so two calls in one step can't both pass the same check. A start
 * writes the child's record before `startContinuable`, which is given the id the record has: a child that is quick finds
 * its record when it ends. A child that dsh then refuses is ended in the record as failed, and counts as a delegation.
 *
 * What counts as running: the child's agent is stepping, or the record says running and the agent exists (accepted, not
 * stepping yet). A record that says running with no agent is a crash's, and isn't running.
 *
 * The row also rewrites the finish notices of this agent's crew children, so that each names its role, title and model and
 * where its report is (`notice.ts`): one `agent/pre-step` listener, registered here so that it is the preset's and hears
 * only the agents under it.
 *
 * This module is the row and little else: everything it loads of the plugin is plain code over plain data (`models`,
 * `allow`, `notice`, `text`), and the services come in by `import type`.
 *
 * @module dish-crew/delegate
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-llm'
import type { ContinuableStartSpec } from '@deepseek-ai/dsh-subagent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'
import { isTopLevelAgent } from 'dish-kit'
import type { DishPrompts, Persona } from 'dish-prompts'
import { allowList, visibleTools } from './allow.ts'
import type { DishCrew } from './index.ts'
import { chooseRoute, offeredModels } from './models.ts'
import type { ReviewedWork, Route } from './models.ts'
import { noticeListener } from './notice.ts'
import type { ChildRecord } from './record.ts'
import type { CrewSettings, RoleSettings } from './settings.ts'
import { listed, truncate } from './text.ts'

export const name = 'dish-crew-delegate'

/** The services the row needs of dsh. `dishCrew` and `dishPrompts` are read by name on every call. */
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

/** The id of a session or a child, as dsh brands it. */
type SessionId = NonNullable<ContinuableStartSpec['childId']>

/** What the tool returns: the child, and how it shows. */
interface Delegated {
  child: string
  role: string
  model: string
  label: string
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
  settings: CrewSettings
  role: string
  roleSettings: RoleSettings
  task: string
  title: string | undefined
  to: string | undefined
  reviews: string | undefined
  model: string | undefined
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

  /** The child `id` if this session started it. @throws a refusal that names the session's children, if not. */
  async function ownChild(call: Call, id: string, what: string, hint: string): Promise<ChildRecord> {
    const found = await readRecord(() => call.crew.records.lookup(id))
    if (found !== undefined && found.sessionId === call.sessionId) return found.record
    const children = await readRecord(() => call.crew.records.children(call.sessionId))
    throw new Error(`${what} ${quoted(id)} is not a crew child of this session. `
      + (children.length === 0 ? 'This session has started no crew children. ' : `This session's crew children: ${whoList(children)}. `)
      + hint)
  }

  const isRunning = (child: ChildRecord): boolean => {
    const live = ctx.agents.get(child.id as SessionId)
    return live?.status === 'running' || (child.last === 'running' && live !== undefined)
  }

  /** Step 4. @throws a refusal that says who is running and what to do. */
  function enforceLimits(call: Call, children: readonly ChildRecord[], isStart: boolean): void {
    const { limits } = call.settings
    const running = children.filter(isRunning)
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

  /** The work the reviewer reviews, for `reviews`: the main agent's own, or a crew child of this session. */
  async function reviewedWork(call: Call, reviews: string): Promise<ReviewedWork> {
    if (reviews === 'main') {
      const model = mainModel(call.agent)
      if (model === undefined) {
        throw new Error('can\'t tell which model you (the main agent) run on, so no reviewer family can be chosen to differ from it; '
          + 'review a crew child\'s work instead (set reviews to its id).')
      }
      return { model }
    }
    const child = await ownChild(call, reviews, '`reviews`', 'Use one of those ids, or "main" to review your own work.')
    return { model: child.model, family: child.family }
  }

  /** Step 5 for a start: the route of the new child, and `reviews` as it is recorded. */
  async function chooseModel(call: Call): Promise<{ route: Route, reviews: string | undefined }> {
    let reviewed: ReviewedWork | undefined
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
      ...reviewed === undefined ? {} : { reviewed },
    })
    if (!chosen.ok) throw new Error(chosen.problem)
    return { route: chosen.route, reviews: call.roleSettings.reviews ? call.reviews : undefined }
  }

  /** Step 6. @throws a refusal that lists the models crew.yaml offers. */
  async function checkRoute(call: Call, route: Route): Promise<void> {
    try {
      await ctx.llm.resolveCallConfig({ provider: route.provider, model: route.model }, call.signal)
    } catch (error) {
      if (call.signal.aborted) throw error
      throw new Error(`model ${route.provider}/${route.model} is not available (${describe(error)}). `
        + `Models crew.yaml offers: ${listed(offeredModels(call.settings))}. Pick one of those with model, or fix crew.yaml.`, { cause: error })
    }
  }

  /** Record `childId` as failed, for a start dsh refused. A record that can't be written is logged: the refusal still comes. */
  async function markFailed(call: Call, childId: string, message: string): Promise<void> {
    try {
      await call.crew.records.endRun(childId, { stopReason: 'error', error: message, closing: '' })
    } catch (error) {
      warn('could not record the failed start of child %s as failed: %s', childId, describe(error))
    }
  }

  /** Steps 5 to 8 for a new child. Inside the session's lock. */
  async function start(call: Call, persona: Persona, title: string): Promise<Delegated> {
    const { route, reviews } = await chooseModel(call)
    await checkRoute(call, route)
    const allowed = allowList(call.roleSettings.tools, visibleTools(call.agent), call.role)
    if (!allowed.ok) throw new Error(allowed.problem)
    const label = `${call.role} · ${route.model} · ${title}`
    // The id is ours, and the record is written first: a child that is quick ends before `startContinuable` returns, and
    // its `subagent/end` has to find a record.
    const childId = randomUUID()
    try {
      await call.crew.records.addChild(call.sessionId, {
        id: childId, role: call.role, title, model: route.model, family: route.family, ...reviews === undefined ? {} : { reviews },
      })
    } catch (error) {
      throw new Error(`could not record the delegation, so nothing was started: ${describe(error)}`, { cause: error })
    }
    try {
      await ctx.subagents.startContinuable({
        provider: call.crew.subagentProvider,
        label,
        childId: childId as SessionId,
        request: {
          prompt: [{ type: 'text', text: call.task }],
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
        ? `could not start the ${call.role}: ${message}. The start failed and counts as a delegation.`
        : `role ${call.role}'s tools include ${tools.join(', ')}, which a child can't be given here; `
          + `remove ${tools.length === 1 ? 'it' : 'them'} from roles.${call.role}.tools in crew.yaml. Nothing was started; the start failed and counts as a delegation.`,
      { cause: error })
    }
    return { child: childId, role: call.role, model: route.model, label }
  }

  /**
   * Step 5 for a follow-up to a reviewer: the child keeps its model, so what is checked is that the work it reviews is
   * not in its family now. The main agent's model can have changed since it started.
   * @throws a refusal that says to start a new reviewer.
   */
  async function checkReviewer(call: Call, target: ChildRecord): Promise<void> {
    const again = `Start a new ${call.role} instead (leave to out).`
    if (call.reviews !== undefined && target.reviews !== undefined && call.reviews !== target.reviews) {
      throw new Error(`child ${target.id} reviews ${target.reviews}, and a follow-up can't point it at other work (${call.reviews}). ${again}`)
    }
    const reviews = target.reviews ?? call.reviews
    if (reviews === undefined) throw new Error(`the ${call.role} role needs reviews, and child ${target.id} has none recorded. ${again}`)
    const checked = chooseRoute({ settings: call.settings, role: call.role, override: target.model, reviewed: await reviewedWork(call, reviews) })
    if (!checked.ok) throw new Error(`can't send a follow-up to ${call.role} child ${target.id}: ${checked.problem} ${again}`)
  }

  /** Steps 5 and 8 for a follow-up. Inside the session's lock. */
  async function followUp(call: Call, target: ChildRecord): Promise<Delegated> {
    if (call.model !== undefined) {
      throw new Error(`a follow-up can't change the model: child ${target.id} keeps ${target.model}. Leave model out.`)
    }
    if (call.roleSettings.reviews) {
      await checkReviewer(call, target)
    } else if (call.reviews !== undefined) {
      const reviewer = reviewerName(call.settings)
      throw new Error(`reviews is for the reviewer role (${reviewer}), and ${call.role} doesn't review. Leave reviews out, or delegate to ${reviewer}.`)
    }
    try {
      await ctx.subagents.sendMessage(call.agent, target.id as SessionId, [{ type: 'text', text: call.task }], { signal: call.signal })
    } catch (error) {
      throw new Error(`could not send the follow-up to child ${target.id}: ${describe(error)}`, { cause: error })
    }
    // Sent. A record that can't be updated is logged, not thrown: an error would have the model send it again.
    try {
      await call.crew.records.addFollowUp(target.id)
    } catch (error) {
      warn('could not record the follow-up to child %s: %s', target.id, describe(error))
    }
    return { child: target.id, role: target.role, model: target.model, label: `${target.role} · ${target.model} · ${target.title}` }
  }

  /** The `call` for the arguments, after the checks that need no one's state: who is calling, the services, the role, the task. */
  async function prepare(args: { role: string, title: string, task: string, to?: string, reviews?: string, model?: string }, agent: Agent | undefined, signal: AbortSignal): Promise<Call> {
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
    const settings = await crew.settings()
    const role = given(args.role)
    if (role === undefined) throw new Error(`role is empty; the roles in crew.yaml are: ${listed(Object.keys(settings.roles))}. Use one of those.`)
    if (!Object.hasOwn(settings.roles, role)) {
      throw new Error(`unknown role ${quoted(role)}; the roles in crew.yaml are: ${listed(Object.keys(settings.roles))}. Use one of those.`)
    }
    const task = given(args.task)
    if (task === undefined) throw new Error('task is empty: give the child the complete, self-contained brief.')
    return {
      agent, signal, crew, prompts, settings, role, roleSettings: settings.roles[role]!, task: args.task,
      sessionId: String(agent.id), title: titleOf(args.title), to: given(args.to), reviews: given(args.reviews), model: given(args.model),
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
        + 'crew.yaml limits how many children run at once, how many write files at once (one by default; read-only roles run in parallel) and how many delegations a session makes; '
        + 'a refusal says who is running and what to do. Returns the child\'s id, role, model and label.',
      parameters: {
        role: { type: 'string', required: true, description: `A role in crew.yaml: ${roleList(settings)}.` },
        title: { type: 'string', required: true, description: '3 to 6 words naming the work. It is in the child\'s label and in its finish notice. Not used for a follow-up.' },
        task: { type: 'string', required: true, description: 'The complete, self-contained brief. For a follow-up, the new instructions: the findings to fix, say.' },
        to: { type: 'string', description: 'The id of a crew child this session started, in the same role, to send `task` to as a follow-up (a fix round) instead of starting a new child. Leave empty to start a new one.' },
        reviews: { type: 'string', description: 'Reviewer role only, and required for it: the id of the crew child whose work is reviewed, or "main" for your own work. Leave empty for any other role.' },
        model: { type: 'string', description: 'An override of the role\'s default model: a model id from the families in crew.yaml. A reviewer\'s must be in a different family from the work reviewed. Not for a follow-up. Leave empty for the default.' },
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
          },
        },
        render: (args, value) => {
          const prefix = `${value.role} · ${value.model} · `
          const title = value.label.startsWith(prefix) ? value.label.slice(prefix.length) : value.label
          return text(given(args.to) === undefined
            ? `started ${value.role} «${title}» on ${value.model} (child ${value.child})`
            : `sent a follow-up to ${value.role} «${title}» (child ${value.child})`)
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
            throw new Error(`role ${call.role} has no prompt (${describe(error)}): add prompts/crew/${call.role}.md to the config store, then delegate again.`
              + `${ctx.get('dishConfig') === undefined ? ' dish-config is not running, so only the shipped prompts exist.' : ''}`, { cause: error })
          }
        } else {
          target = await ownChild(call, call.to, '`to`', 'Use one of those ids, or leave `to` out to start a new child.')
          if (target.role !== call.role) {
            throw new Error(`child ${target.id} is ${article(target.role)} «${target.title}», not ${article(call.role)}: a follow-up goes to a child of its own role. `
              + `Set role to ${target.role}, or leave to out to start a new ${call.role}.`)
          }
        }
        const { title } = call
        return exclusive(call.sessionId, async () => {
          call.signal.throwIfAborted()
          const children = await readRecord(() => call.crew.records.children(call.sessionId))
          enforceLimits(call, children, target === undefined)
          return target === undefined ? start(call, persona!, title!) : followUp(call, target)
        })
      },
    }))
  })()
}
