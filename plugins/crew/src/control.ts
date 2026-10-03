/**
 * dish-crew/control: the preset row that gives every agent on the dish preset `send_message` and `interrupt_agent`, in
 * place of dsh's `tool-subagent-control` row.
 *
 * The two tools are dsh's own (`@deepseek-ai/dsh-tool-subagent-control`), argument for argument and call for call: thin
 * adapters over `ctx.subagents.sendMessage()` and `ctx.subagents.interrupt()`. What differs is one thing dsh keeps out of
 * sight. dsh marks its `send_message` (`markAdjacentAgentSendMessageTool`), and when a continuable child's `send_message`
 * carries that mark, `startContinuable` appends a note to the child's task: "Before you finish, send your result to that
 * agent with send_message …" (`withContinuableReturnGuidance` in `dsh-subagent`). That is the opposite of how the crew
 * reports (once, in the closing message), and some models follow it anyway, so a child sent the main agent a "done"
 * summary and then its report, and the main agent answered twice. These tools carry no mark, so dsh adds no note, and
 * `delegate`'s own closing note gives the child its parent's id instead (`closingNote`).
 *
 * `scripts/sync-preset.mjs` puts this row where the standard preset has `tool-subagent-control`, and refuses a preset that
 * would load both: two `send_message` tools in one scope is a registration error. The report guard (`report-guard.ts`)
 * goes by the tool's name, so it guards this `send_message` as it did dsh's.
 *
 * @module dish-crew/control
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContinuableStartSpec } from '@deepseek-ai/dsh-subagent'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dish-crew-control'

export const inject = ['tools', 'subagents']

/** The id of a session or a child, as dsh brands it. dsh's own tool brands the model's string the same way. */
type AgentId = NonNullable<ContinuableStartSpec['childId']>

const text = (value: string): [{ type: 'text', text: string }] => [{ type: 'text', text: value }]

export function apply(ctx: Context): void {
  // dsh's wording, so the model reads what it would read on the standard preset.
  ctx.tools.register(defineTool({
    name: 'send_message',
    description: 'Send a message to an agent. A working agent receives it at its next step; an idle agent starts a new turn with it. Returns delivery confirmation, not the agent\'s answer.',
    parameters: {
      agent_id: {
        type: 'string',
        required: true,
        description: 'The agent id of your direct continuable child, or your direct parent when you are a resident continuable child.',
      },
      message: { type: 'string', required: true, description: 'The message to deliver to the agent.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { messageId: { type: 'string', required: true } },
      },
      render: args => text(`message delivered to agent ${args.agent_id}`),
    },
    async execute(args, exec) {
      const sender = exec.agent
      if (!sender) throw new Error('send_message requires a calling agent (exec.agent was undefined)')
      return { messageId: await ctx.subagents.sendMessage(sender, args.agent_id as AgentId, text(args.message), { signal: exec.signal }) }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'interrupt_agent',
    description: 'Ask a subagent to stop its current work. This call returns without waiting for it to stop. You can continue a direct child\'s conversation later with send_message. Subagents it started will keep running.',
    parameters: {
      agent_id: { type: 'string', required: true, description: 'The id of an agent created under you: your direct child or a deeper descendant.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { accepted: { type: 'boolean', required: true } },
      },
      render: args => text(`interrupt requested for agent ${args.agent_id}`),
    },
    execute(args, exec) {
      const caller = exec.agent
      if (!caller) throw new Error('interrupt_agent requires a calling agent (exec.agent was undefined)')
      ctx.subagents.interrupt(args.agent_id as AgentId, { kind: 'ancestor', agent: caller })
      return Promise.resolve({ accepted: true })
    },
  }))
}
