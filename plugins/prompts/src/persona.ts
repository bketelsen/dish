/**
 * dish-prompts/persona — the preset row that gives an agent its role's prompt.
 *
 * It is the counterpart of dsh's own `persona` row, for a preset that wants its persona from the config store. It
 * registers no sections. It registers one `system-prompt/assemble` listener, which sets the text of the two persona
 * sections dsh always assembles (`PERSONA_PREFIX_SECTION` and `PERSONA_SUFFIX_SECTION`) from the agent's snapshot in
 * the `dishPrompts` service, an `agent/created` listener, which forgets a snapshot on `/clear`, and an `agent/disposed`
 * listener, which forgets what the row has told about the agent.
 *
 * Three rules decide what the row may do:
 *
 * - **The persona is applied after `next()`, and the row is prepended.** A prompt's `{{model}}` and `{{provider}}` are
 *   the model the session has selected, and dsh sets those on the assembly late: dsh-agent's model-selection listener
 *   (`installModelSelection`) returns `{ ...assembled, variables: { ...assembled.variables, provider, model } }` after
 *   its own `next()`, while the variables the waterfall starts with hold only the global default the agent was created
 *   with. A listener that interpolates before `next()` would say the default. So this one asks for the snapshot
 *   first, calls `next()` once, and patches what `next()` returned. Registered with `prepend: true`, it runs ahead
 *   of every listener registered without `prepend`, dsh-agent's model selection among them, so its `next()` returns
 *   after the selection has set `model`, whatever order the preset and the agent registered theirs in. (`dsh-session-reference` reads the selected model the same way.)
 *   The cost: a listener inside the waterfall that reads the persona sections' text sees the preset's text.
 *
 * - **A prompt's text never fails a step.** dsh's own interpolation throws on a malformed, unknown or valueless
 *   `{{variable}}`, so the row interpolates the text itself, leniently (see `interpolate.ts`), and tells dsh not to
 *   again. And the row never throws for the service or the store either: it logs, once, and leaves the persona
 *   sections as the preset had them (a child's own prefix, which dsh would interpolate strictly, is still rendered
 *   leniently).
 * - **This module is the row, and little else.** It loads `interpolate.ts` of the plugin's files, and takes the
 *   service by `import type` alone, so that nothing else in the plugin (the defaults, the snapshot files, the role
 *   grammar) can stop a preset from loading it. The service is read, by name, when an agent's prompt is assembled:
 *   `dishPrompts` is optional, and may come and go.
 *
 * @module dish-prompts/persona
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { PERSONA_PREFIX_SECTION, PERSONA_SUFFIX_SECTION } from '@deepseek-ai/dsh-system-prompt'
import type { AssembledSection, AssembleContext, PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import Schema from '@deepseek-ai/schemastery'
import { isTopLevelAgent } from 'dish-kit'
import { interpolate } from './interpolate.ts'
import type { DishPrompts, Persona } from './service.ts'

export const name = 'dish-prompts-persona'

/** The prompt registry the row's listener hears from. `dishPrompts` is read when needed, not injected: it is optional. */
export const inject = ['systemPrompt']

export interface Config {
  /** `main`, or a crew role, for a preset built around one. */
  role: string
}

/**
 * What a role the row can have looks like: `main` or a crew role name, and not `common` (the suffix of every role's
 * prompt, not a persona). It repeats `roles.ts`'s grammar on purpose: a pattern is metadata, so it survives the
 * serialization dsh puts a plugin's config schema through, which a function that calls `pathFor` would not. A test
 * keeps the two in step.
 */
const ROLE = /^(?!common$)[a-z][a-z0-9-]*$/

export const Config: Schema<Config> = Schema.object({
  // Checked here, once, when the row loads: a typo would otherwise fail on every step of every agent.
  role: Schema.string().pattern(ROLE).required()
    .description('The role this preset\'s agents have: "main", or a crew role such as "coder". Not "common".'),
})

/**
 * Set the persona sections of `assembly` from `persona`, in place.
 *
 * Sections are found by name and patched with `Object.assign`: dsh's last `next()` returns the assembly it started
 * with, and a listener that wraps the assembly (the model selection does) keeps its section objects, so a listener
 * that builds new ones loses its work. Each patched section gets its text interpolated here, leniently, and
 * `interpolate: false`, so dsh renders it as it is.
 * - the **suffix** becomes `persona.suffix`, for every agent;
 * - the **prefix** becomes `persona.prefix` for a top-level agent, and for a `child` stays what it is (the persona
 *   `crew` gave it): only interpolated. A prefix that already says `interpolate: false` is left exactly as it is.
 *
 * A section that isn't in the assembly is skipped, and nothing is added. Both texts are worked out before either
 * section is written, so all that can fail is a write to a section that can't be written to, and the listener
 * answers for that.
 * @param assembly - the assembly to patch.
 * @param persona - the texts to use, as `dishPrompts` gives them.
 * @param child - whether the assembly is a delegated child's.
 * @returns the names that had no value in `assembly.variables` and were left as written, in order of first appearance.
 */
export function applyPersona(assembly: PromptAssembly, persona: Persona, child: boolean): string[] {
  const unknown = new Set<string>()
  const patches: { section: AssembledSection, text: string }[] = []
  const prefix = assembly.sections.find(section => section.name === PERSONA_PREFIX_SECTION)
  const suffix = assembly.sections.find(section => section.name === PERSONA_SUFFIX_SECTION)
  const plan = (section: AssembledSection | undefined, source: string | undefined): void => {
    if (section === undefined || source === undefined) return
    const rendered = interpolate(source, assembly.variables)
    for (const variable of rendered.unknown) unknown.add(variable)
    patches.push({ section, text: rendered.text })
  }
  // A child's prefix is its own persona: kept, and rendered the way dsh would have, unless it says it is literal.
  const own = prefix?.interpolate === false ? undefined : prefix?.text
  plan(prefix, child ? own : persona.prefix)
  plan(suffix, persona.suffix)
  for (const { section, text } of patches) Object.assign(section, { text, interpolate: false })
  return [...unknown]
}

/** What the row's listener logs with: the plugin's logger. */
export interface PersonaLogger {
  warn(format: string, ...args: unknown[]): void
}

export interface ListenerOptions {
  /** The role every agent under the row has. */
  role: string
  /** The service as it is right now, or `undefined`. Called on every assembly. */
  service: () => Pick<DishPrompts, 'snapshot'> | undefined
  logger: PersonaLogger
}

type Assemble = (assembly: PromptAssembly, context: AssembleContext, next: () => Promise<PromptAssembly>) => Promise<PromptAssembly>

/** The row's listener, and a way to make it forget what it has told about an agent. */
export interface PersonaListener extends Assemble {
  /** Forget what has been told about this agent, so that trouble with it is told again. For when the agent is gone. */
  forget(agentId: string): void
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Render a child's own persona prefix the way `applyPersona` would, leniently, without a persona to put in its place.
 * It is for a child that the row can't give a persona to: `crew` gave it text that dsh would otherwise interpolate
 * strictly, and a typo in that must not fail the child's step. A prefix that already says `interpolate: false`, or
 * isn't there, is left as it is.
 * @returns the names that had no value in `assembly.variables` and were left as written.
 */
function renderOwnPrefix(assembly: PromptAssembly): string[] {
  const prefix = assembly.sections.find(section => section.name === PERSONA_PREFIX_SECTION)
  if (prefix === undefined || prefix.interpolate === false) return []
  const rendered = interpolate(prefix.text, assembly.variables)
  Object.assign(prefix, { text: rendered.text, interpolate: false })
  return rendered.unknown
}

/**
 * The `system-prompt/assemble` listener of one row.
 *
 * For an assembly with an agent, it asks for the agent's snapshot, calls `next()`, and patches the persona sections of
 * what `next()` returned, which is what it returns (see the module comment for why the patch comes after). With no
 * agent (a diagnostic assembly), it returns `next()`. With no service, or when the snapshot can't be had or the
 * sections can't be patched, it doesn't give the agent a persona: a step doesn't fail because of this row. Every path
 * calls `next()` exactly once, and an error from `next()` is the caller's. It says so when it matters, once:
 * - for the whole row, when the service is missing;
 * - for each agent, when its snapshot can't be had or the row can't patch its sections, and when its prompt names
 *   variables that have no value.
 *
 * Without a persona, a top-level agent keeps what its preset gave it. A child keeps its own prefix too, but rendered
 * leniently (see `renderOwnPrefix`), because that is text dsh would interpolate strictly: that part needs no service.
 */
export function personaListener(options: ListenerOptions): PersonaListener {
  const { role, service, logger } = options
  const told = new Set<string>()
  const tell = (once: string, format: string, ...args: unknown[]): void => {
    if (told.has(once)) return
    told.add(once)
    // A log line must not fail a step either.
    try {
      logger.warn(format, ...args)
    } catch {
      // Nothing to do about it.
    }
  }
  const tellUnknown = (agent: Agent, unknown: string[]): void => {
    tell(`unknown:${agent.id}`, 'the prompt of agent %s (role %s) uses variables with no value, left as written: %s',
      agent.id, role, unknown.map(variable => `{{${variable}}}`).join(', '))
  }
  const tellFailed = (agent: Agent, error: unknown): void => {
    tell(`failed:${agent.id}`, 'could not set the prompt of agent %s (role %s); its persona is left as its preset has it: %s',
      agent.id, role, describe(error))
  }
  /** What a child gets when the row can't give it a persona. The trouble that brought us here is already told. */
  const withoutPersona = (assembly: PromptAssembly, agent: Agent): void => {
    try {
      if (isTopLevelAgent(agent)) return
      const unknown = renderOwnPrefix(assembly)
      if (unknown.length > 0) tellUnknown(agent, unknown)
    } catch {
      // A section that can't be written to, or an agent that can't be told apart: nothing more to do.
    }
  }
  const listener: Assemble = async (_assembly, context, next) => {
    const agent: Agent | undefined = context.agent
    if (agent === undefined) return next()
    // Asked for before `next()`, so that a slow store doesn't run inside the other listeners' time.
    let snapshot: { persona: Persona } | undefined
    const prompts = service()
    if (prompts === undefined) {
      tell('service', 'dishPrompts is not available, so agents keep the persona their preset gives them. Is the dish-prompts plugin loaded?')
    } else {
      try {
        snapshot = { persona: await prompts.snapshot(agent, role) }
      } catch (error) {
        tellFailed(agent, error)
      }
    }
    // Not in a `try`: an error from the waterfall is not this row's trouble. And applied to what it returns: the
    // model selection has set the variables by now.
    const result = await next()
    if (snapshot !== undefined) {
      try {
        const unknown = applyPersona(result, snapshot.persona, !isTopLevelAgent(agent))
        if (unknown.length > 0) tellUnknown(agent, unknown)
        return result
      } catch (error) {
        tellFailed(agent, error)
      }
    }
    withoutPersona(result, agent)
    return result
  }
  return Object.assign(listener, {
    forget(agentId: string): void {
      told.delete(`unknown:${agentId}`)
      told.delete(`failed:${agentId}`)
    },
  })
}

/**
 * The name the row logs under: the host plugin's, not the row's own. The host prints its own logger's lines to the
 * terminal, once, when its `terminal` setting says so (`printOwnLogs`), and an exporter of the row's would be one more
 * for every preset revision that mounts the row.
 */
const LOGGER_NAME = 'dish-prompts'

/**
 * Register the row's listeners on `ctx`, which is the preset's scope.
 * @param ctx - the context the preset mounts the row in.
 * @param config - the row's role.
 */
export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger(LOGGER_NAME)
  // Read on every call: the service is optional, and may come, go and come back.
  const listener = personaListener({ role: config.role, service: () => ctx.get('dishPrompts'), logger })
  // Prepended: ahead of every listener registered without `prepend`, so that `next()` returns after dsh-agent's model
  // selection has set `model` (see the module comment).
  ctx.on('system-prompt/assemble', listener, { prepend: true })
  // What is told about an agent is told once, and not kept after the agent is gone.
  ctx.on('agent/disposed', ({ agent }) => {
    listener.forget(String(agent.id))
  })
  // `/clear` starts the agent on the prompts as they are now. Awaited, so that its first step finds nothing of the old one.
  // dsh 0.2.0-rc.2's agent loop only publishes `agent/created` with `startup` or `resume`, so `clear` doesn't arrive yet.
  ctx.on('agent/created', async ({ agent, source }): Promise<undefined> => {
    if (source !== 'clear') return undefined
    try {
      await ctx.get('dishPrompts')?.drop(agent)
    } catch (error) {
      logger.warn('could not drop the snapshot of agent %s: %s', agent.id, describe(error))
    }
    return undefined
  })
}
