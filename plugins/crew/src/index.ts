/**
 * dish-crew (spike) — delegate to a fixed crew of specialists.
 *
 * One `delegate` tool, taking a `role`. Each role gives its child:
 * - a persona, which replaces the deployment persona for that child alone;
 * - a tool filter, always including `delegate` itself, so only the main agent delegates;
 * - a default model by tier, which the caller may override.
 *
 * Children are continuable and run in the background. dsh delivers a notice
 * to the parent when each one settles, so the main agent's chat stays open.
 *
 * The reviewer's model is structural, not the caller's choice: it always
 * comes from a different model family than the coder it reviews.
 *
 * This is the spike for docs/design.md open question 1. Prompts and roles
 * will move to the versioned config store; here they are plain config.
 *
 * @module dish-crew
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-subagent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'

export const name = 'dish-crew'
export const inject = ['tools', 'subagents', 'llm']

const TOOL = 'delegate'

interface Route {
  provider: string
  model: string
  reasoningEffort?: string
}

interface Role {
  persona: string
  tier: 'strong' | 'mid'
  /** Tools this role may not use, beyond `delegate` which no child gets. */
  deny: string[]
}

export interface Config {
  subagentProvider: string
  maxDelegationsPerParent: number
  tiers: Record<'strong' | 'mid', Route>
  /** Mid-tier route per model family, for picking a reviewer outside the coder's family. */
  reviewers: Record<string, Route>
  roles: Record<string, Role>
}

const route: Schema<Route> = Schema.object({
  provider: Schema.string().required(),
  model: Schema.string().required(),
  reasoningEffort: Schema.string(),
})

const role: Schema<Role> = Schema.object({
  persona: Schema.string().required(),
  tier: Schema.union(['strong', 'mid'] as const).default('mid'),
  deny: Schema.array(Schema.string()).default([]),
})

export const Config: Schema<Config> = Schema.object({
  subagentProvider: Schema.string().default('spawn')
    .description('The ctx.subagents provider that creates in-process children.'),
  maxDelegationsPerParent: Schema.natural().default(20)
    .description('Safety cap on children one agent may start in this process, against a runaway delegation loop.'),
  tiers: Schema.object({
    strong: route.default({ provider: 'github-copilot', model: 'claude-opus-5.5' }),
    mid: route.default({ provider: 'github-copilot', model: 'gpt-5-mini' }),
  }),
  reviewers: Schema.dict(route).default({
    openai: { provider: 'github-copilot', model: 'gpt-5-mini' },
    anthropic: { provider: 'github-copilot', model: 'claude-haiku-4.5' },
  }),
  roles: Schema.dict(role).default({
    architect: {
      tier: 'strong',
      deny: [],
      persona: 'You are the crew\'s architect, running on {{model}}. You turn a goal into a spec and then a plan of small tasks, each naming exact files, interfaces and tests, sized for a mid-tier model to implement alone.',
    },
    coder: {
      tier: 'mid',
      deny: [],
      persona: 'You are the crew\'s coder, running on {{model}}. You implement exactly one task, test it, and commit. You do not widen scope.',
    },
    reviewer: {
      tier: 'mid',
      deny: ['write', 'edit'],
      persona: 'You are the crew\'s reviewer, running on {{model}}. You review one change for spec compliance and code quality and report findings; you never edit code.',
    },
    researcher: {
      tier: 'mid',
      deny: ['write', 'edit', 'bash'],
      persona: 'You are the crew\'s researcher, running on {{model}}. You investigate and report cited findings; you never change files.',
    },
  }),
})

/** The model family a model id belongs to, for the reviewer rule. */
export function familyOf(model: string): string {
  if (/^claude/i.test(model)) return 'anthropic'
  if (/^(gpt|o\d|codex)/i.test(model)) return 'openai'
  if (/^gemini/i.test(model)) return 'google'
  if (/^grok/i.test(model)) return 'xai'
  return 'other'
}

export function apply(ctx: Context, config: Config) {
  // The model each child this plugin started runs on, by child id, so a
  // reviewer can be pinned outside its coder's family.
  const childModels = new Map<string, string>()
  const startedBy = new Map<string, number>()
  const roles = Object.keys(config.roles)

  const pickReviewer = (coderModel: string): Route => {
    const coderFamily = familyOf(coderModel)
    const candidate = Object.entries(config.reviewers).find(([family]) => family !== coderFamily)
    if (candidate === undefined) throw new Error(`no reviewer route outside the ${coderFamily} family`)
    return candidate[1]
  }

  /**
   * Fail in the tool call, where the model can read why, rather than in the
   * child: a child that cannot reach its model settles with no message, and
   * the delegating agent learns nothing it can act on.
   */
  const preflight = async (target: Route, signal: AbortSignal): Promise<void> => {
    try {
      await ctx.llm.resolveCallConfig({ provider: target.provider, model: target.model }, signal)
    } catch (error) {
      const providers = ctx.llm.listProviders().map(info => info.id)
      const models = providers.includes(target.provider)
        ? (await ctx.llm.listModels(target.provider)).map(info => info.id)
        : []
      throw new Error(`model ${target.provider}/${target.model} is not available (${error instanceof Error ? error.message : String(error)}). `
        + (models.length > 0
          ? `Models on ${target.provider}: ${models.join(', ')}. `
          : `Providers: ${providers.join(', ')}. `)
        + 'Omit provider and model to use the role\'s default.', { cause: error })
    }
  }

  ctx.tools.register(defineTool({
    name: TOOL,
    description: `Delegate a task to one crew specialist (${roles.join(', ')}). `
      + 'The specialist starts fresh with only your prompt, so make it self-contained. '
      + 'It runs in the background and returns a subagent id; you are notified when it settles, '
      + 'and can follow up with `send_message`. Start independent delegations together and keep '
      + 'working (and talking with the user) while they run.',
    parameters: {
      role: { type: 'string', required: true, description: `One of: ${roles.join(', ')}.` },
      description: { type: 'string', required: true, description: 'A short (3-5 word) label for the task.' },
      prompt: { type: 'string', required: true, description: 'The complete, self-contained task.' },
      reviews: {
        type: 'string',
        description: 'Reviewer only, required: the subagent id of the coder whose work is under review. '
          + 'The reviewer\'s model is then chosen from a different model family.',
      },
      provider: { type: 'string', description: 'Optional LLM provider override; supply with `model`. Ignored for reviewer.' },
      model: { type: 'string', description: 'Optional model override; supply with `provider`. Ignored for reviewer.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          subagentId: { type: 'string', required: true },
          role: { type: 'string', required: true },
          model: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `started ${value.role} subagent ${value.subagentId} on ${value.model}`,
      }],
    },
    async execute(args, exec) {
      const parent = exec.agent
      if (parent === undefined) throw new Error(`${TOOL} requires a calling agent`)
      // Models tend to fill every optional field; an empty string means "not given".
      const given = (value: string | undefined) => value === undefined || value.trim() === '' ? undefined : value.trim()
      const reviews = given(args.reviews)
      const provider = given(args.provider)
      const model = given(args.model)
      const started = startedBy.get(parent.id) ?? 0
      if (started >= config.maxDelegationsPerParent) {
        throw new Error(`delegation cap reached: this agent has started ${started} subagents. `
          + 'Stop delegating, and report what has and has not completed.')
      }
      const spec = config.roles[args.role]
      if (spec === undefined) throw new Error(`unknown role "${args.role}"; roles are ${roles.join(', ')}`)

      let target: Route
      if (args.role === 'reviewer') {
        if (reviews === undefined) throw new Error('a reviewer delegation needs `reviews`: the coder subagent id')
        const coderModel = childModels.get(reviews)
        if (coderModel === undefined) throw new Error(`no model recorded for subagent ${reviews}`)
        target = pickReviewer(coderModel)
      } else if (provider !== undefined && model !== undefined) {
        target = { provider, model }
      } else {
        target = config.tiers[spec.tier]
      }

      await preflight(target, exec.signal)

      const agentOptions = {
        provider: target.provider,
        model: target.model,
        ...target.reasoningEffort === undefined ? {} : { reasoningEffort: target.reasoningEffort },
      } as AgentOptions
      startedBy.set(parent.id, started + 1)
      const child = await ctx.subagents.startContinuable({
        provider: config.subagentProvider,
        label: `${args.role}: ${args.description}`,
        request: {
          prompt: [{ type: 'text', text: args.prompt }],
          parent,
          agentOptions,
          persona: spec.persona,
          toolFilter: { deny: [TOOL, ...spec.deny] },
          maxDepth: 1,
        },
        signal: exec.signal,
      })
      childModels.set(child.childId, target.model)
      return { subagentId: child.childId, role: args.role, model: target.model }
    },
  }))
}
