/**
 * dish-prompts/persona — the preset row that gives an agent its role's prompt.
 *
 * It is the counterpart of dsh's own `persona` row, for a preset that wants its persona from the config store. It
 * registers no sections. It registers one `system-prompt/assemble` listener, which sets the text of the two persona
 * sections dsh always assembles (`PERSONA_PREFIX_SECTION` and `PERSONA_SUFFIX_SECTION`) from the agent's snapshot in
 * the `dishPrompts` service, and one `agent/created` listener, which forgets a snapshot on `/clear`.
 *
 * Two rules decide what the row may do:
 *
 * - **A prompt's text never fails a step.** dsh's own interpolation throws on a malformed, unknown or valueless
 *   `{{variable}}`, so the row interpolates the text itself, leniently (see `interpolate.ts`), and tells dsh not to
 *   again. And the row never throws for the service or the store either: it logs, once, and leaves the persona
 *   sections as the preset had them.
 * - **This module is the row, and little else.** It loads `roles.ts` and `interpolate.ts`, and takes the service
 *   by `import type` alone, so that nothing in the plugin's other files (the defaults, the snapshot files) can stop a
 *   preset from loading it. The service is read, by name, when an agent's prompt is assembled: `dishPrompts` is
 *   optional, and may come and go.
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
import { pathFor } from './roles.ts'
import type { DishPrompts, Persona } from './service.ts'

export const name = 'dish-prompts-persona'

/** The prompt registry the row's listener hears from. `dishPrompts` is read when needed, not injected: it is optional. */
export const inject = ['systemPrompt']

export interface Config {
  /** `main`, or a crew role, for a preset built around one. */
  role: string
}

/**
 * @returns `role`, if it is one an agent can have: `main` or a crew role.
 * @throws a plain `Error` for `common` (the suffix of every role, not a persona) and for a name that can't be a role.
 */
function checkRole(role: string): string {
  if (role === 'common') {
    throw new Error('invalid role "common": it is the suffix of every role\'s prompt, not a role. Use "main", or the name of a crew role')
  }
  try {
    // The one place that knows what a role looks like.
    pathFor(role)
  } catch {
    throw new Error(`invalid role ${JSON.stringify(role)}: use "main", or the name of a crew role (lowercase letters, digits and hyphens, starting with a letter)`)
  }
  return role
}

export const Config: Schema<Config> = Schema.object({
  // Checked here, once, when the row loads: a typo would otherwise fail on every step of every agent.
  role: Schema.transform(Schema.string().required(), checkRole).required()
    .description('The role this preset\'s agents have: "main", or a crew role such as "coder".'),
})

/**
 * Set the persona sections of `assembly` from `persona`, in place.
 *
 * Sections are found by name and patched with `Object.assign`: dsh's last `next()` returns the assembly it started
 * with, so a listener that builds new objects loses its work. Each patched section gets its text interpolated here,
 * leniently, and `interpolate: false`, so dsh renders it as it is.
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

type Listener = (assembly: PromptAssembly, context: AssembleContext, next: () => Promise<PromptAssembly>) => Promise<PromptAssembly>

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The `system-prompt/assemble` listener of one row.
 *
 * For an assembly with an agent, it patches the persona sections from the agent's snapshot and calls `next()`. With no
 * agent (a diagnostic assembly), with no service, or when the snapshot can't be had, it leaves the assembly as it is
 * and calls `next()`: a step doesn't fail because of this row. It says so when it matters, once:
 * - for the whole row, when the service is missing;
 * - for each agent, when its snapshot can't be had or the row can't patch its sections, and when its prompt names
 *   variables that have no value.
 */
export function personaListener(options: ListenerOptions): Listener {
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
  return async (assembly, context, next) => {
    const agent: Agent | undefined = context.agent
    if (agent === undefined) return next()
    const prompts = service()
    if (prompts === undefined) {
      tell('service', 'dishPrompts is not available, so agents keep the persona their preset gives them. Is the dish-prompts plugin loaded?')
      return next()
    }
    try {
      const persona = await prompts.snapshot(agent, role)
      const unknown = applyPersona(assembly, persona, !isTopLevelAgent(agent))
      if (unknown.length > 0) {
        tell(`unknown:${agent.id}`, 'the prompt of agent %s (role %s) uses variables with no value, left as written: %s',
          agent.id, role, unknown.map(variable => `{{${variable}}}`).join(', '))
      }
    } catch (error) {
      tell(`failed:${agent.id}`, 'could not set the prompt of agent %s (role %s); its persona is left as its preset has it: %s',
        agent.id, role, describe(error))
    }
    return next()
  }
}

/**
 * Register the row's listeners on `ctx`, which is the preset's scope.
 * @param ctx - the context the preset mounts the row in.
 * @param config - the row's role.
 */
export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger(name)
  // Read on every call: the service is optional, and may come, go and come back.
  ctx.on('system-prompt/assemble', personaListener({ role: config.role, service: () => ctx.get('dishPrompts'), logger }))
  // `/clear` starts the agent on the prompts as they are now. Awaited, so that its first step finds nothing of the old one.
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
