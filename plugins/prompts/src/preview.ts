/**
 * "What the model sees": the system prompt a new agent in a role would get, built the way dsh builds it, for the
 * Prompts page.
 *
 * The preview leases the dish preset's scope (`agentPresets.acquireScope('dish')`), has `systemPrompt` assemble for
 * that scope, puts the role's current texts in the persona sections (`applyPersona`, the preset row's own function,
 * with the store's texts instead of a snapshot), and renders with dsh's `renderPrompt`. That is the only path dsh
 * offers for an assembly without an agent, and nothing shipped in dsh assembles that way, so it can fail in ways
 * that only a running dsh shows. When it does, for any reason, the preview is a **fallback**: the persona texts
 * between markers that stand for dsh's sections. The page labels that, and the reason is logged by whoever owns the
 * `onFallback` callback (the remote logs it once per process).
 *
 * Per-agent variables (`model`, `cwd`, ...) have no value without an agent, and dsh renders a valueless one as an
 * error, so they are shown as `‹name›`.
 *
 * @module dish-prompts/preview
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { applyPersona } from './persona.ts'
import type { PreviewResult, VariableInfo, VariablesResult } from './protocol.ts'
import type { DishPrompts, Persona } from './service.ts'

/** The preset whose scope the preview assembles in: the one the plugin ships. */
const PRESET = 'dish'

/** Told why the preview fell back. Never allowed to fail the preview. */
export type OnFallback = (error: unknown) => void

/** `onFallback(error)`, unless it throws. */
function report(onFallback: OnFallback | undefined, error: unknown): void {
  try {
    onFallback?.(error)
  } catch {
    // A log line is not worth the preview.
  }
}

/**
 * dsh's assembly for the dish preset's scope, as it is now: every variable as dsh resolved it, `undefined` for one
 * with no value without an agent.
 * @throws when a service is missing, the preset can't be leased, the assembly fails, or the lease won't go.
 */
async function assembleDish(ctx: Context): Promise<PromptAssembly> {
  const presets = ctx.get('agentPresets')
  if (presets === undefined) throw new Error('the agentPresets service is not available')
  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt === undefined) throw new Error('the systemPrompt service is not available')
  const lease = await presets.acquireScope(PRESET)
  let assembly: PromptAssembly
  try {
    assembly = await systemPrompt.assemble({ scope: lease.key })
  } catch (error) {
    // The assembly's failure is the one to tell: letting go of the lease is only tidying up after it.
    try {
      await lease[Symbol.asyncDispose]()
    } catch {
      // Nothing more to say about it.
    }
    throw error
  }
  await lease[Symbol.asyncDispose]()
  return assembly
}

/** What the page shows when dsh's assembly can't be had: the persona texts, between markers for dsh's own sections, in dsh's order. */
function fallbackPreview(persona: Persona): PreviewResult {
  const text = [
    '[dsh: identity line]',
    persona.prefix,
    '[dsh: tool and skill guidance]',
    '[dsh: environment]',
    persona.suffix,
  ].join('\n\n')
  return { text, approximate: true, fallback: true, unknownVariables: [] }
}

/**
 * The system prompt a new agent in `role` would get now.
 *
 * `common` is previewed as `main`, its prefix being the persona and `common` the suffix of every role. A crew role
 * has its own text in the prefix position, where `main`'s would be.
 * @param ctx - a context to find `agentPresets` and `systemPrompt` in, when they are there.
 * @param prompts - the service the texts come from. They are read from it now, not from a snapshot.
 * @param role - `common`, `main` or a crew role, which the caller has checked is one.
 * @param onFallback - told the error when the preview falls back.
 * @throws what `prompts.persona` throws: without the texts there is nothing to show, not even a fallback.
 */
export async function buildPreview(ctx: Context, prompts: Pick<DishPrompts, 'persona'>, role: string, onFallback?: OnFallback): Promise<PreviewResult> {
  const persona = await prompts.persona(role === 'common' ? 'main' : role)
  try {
    const assembly = await assembleDish(ctx)
    assembly.variables = Object.fromEntries(Object.entries(assembly.variables).map(([name, value]) => [name, value ?? `‹${name}›`]))
    const unknownVariables = applyPersona(assembly, persona, false)
    return { text: renderPrompt(assembly), approximate: true, fallback: false, unknownVariables }
  } catch (error) {
    report(onFallback, error)
    return fallbackPreview(persona)
  }
}

/**
 * The prompt variables the dish preset's assembly has, by name, with the value each has without an agent (empty
 * for the per-agent ones). Without the assembly, none, and `fallback` says that this is not an answer.
 * @param ctx - a context to find `agentPresets` and `systemPrompt` in, when they are there.
 * @param onFallback - told the error when the assembly can't be had.
 */
export async function buildVariables(ctx: Context, onFallback?: OnFallback): Promise<VariablesResult> {
  try {
    const { variables } = await assembleDish(ctx)
    const listed: VariableInfo[] = Object.entries(variables).map(([name, value]) => ({ name, value: value ?? '' }))
    listed.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    return { variables: listed, fallback: false }
  } catch (error) {
    report(onFallback, error)
    return { variables: [], fallback: true }
  }
}
