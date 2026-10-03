/**
 * dish-crew/control against dsh's own `tool-subagent-control`, which it stands in for on the dish preset: the same two tools,
 * argument for argument, making the same calls on `ctx.subagents`, but without dsh's mark, so `startContinuable` appends no
 * "send your result with send_message" note to a crew child's task. dsh's package is resolved through the root
 * `@deepseek-ai/dsh`, so a dsh upgrade that changes its tools fails here.
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import * as control from '../src/control.ts'

const ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const dshPackage = createRequire(join(ROOT, 'package.json')).resolve('@deepseek-ai/dsh/package.json')
const dshControlEntry = createRequire(dshPackage).resolve('@deepseek-ai/dsh-tool-subagent-control')
const dshControl = await import(pathToFileURL(dshControlEntry).href) as { apply(ctx: unknown): void }
// The check `startContinuable` makes, from the dsh-subagent that dsh's own control row uses.
const { isAdjacentAgentSendMessageTool } = await import(pathToFileURL(createRequire(dshControlEntry).resolve('@deepseek-ai/dsh-subagent/internal')).href) as {
  isAdjacentAgentSendMessageTool?: (definition: unknown) => boolean
}

interface Tool {
  name: string
  description: string
  parameters: unknown
  output: { schema: unknown, render(args: unknown, value: unknown): unknown }
  execute(args: unknown, exec: unknown): Promise<unknown>
}

/** A context with a tool registry and a recording `subagents`, as both rows inject them. */
function mounted(apply: (ctx: Context) => void): { tools: Map<string, Tool>, sends: unknown[][], interrupts: unknown[][] } {
  const tools = new Map<string, Tool>()
  const sends: unknown[][] = []
  const interrupts: unknown[][] = []
  const ctx = {
    tools: { register(definition: Tool) { tools.set(definition.name, definition); return () => tools.delete(definition.name) } },
    subagents: {
      async sendMessage(...args: unknown[]) { sends.push(args); return 'message-1' },
      interrupt(...args: unknown[]) { interrupts.push(args) },
    },
  }
  apply(ctx as unknown as Context)
  return { tools, sends, interrupts }
}

const ours = mounted(ctx => control.apply(ctx))
const dsh = mounted(ctx => dshControl.apply(ctx))
const MARK = Symbol.for('dsh.subagent.adjacentAgentSendMessageTool')

test('the row registers send_message and interrupt_agent, as dsh\'s does, and nothing else', () => {
  assert.deepEqual([...ours.tools.keys()].sort(), ['interrupt_agent', 'send_message'])
  assert.deepEqual([...ours.tools.keys()].sort(), [...dsh.tools.keys()].sort())
  assert.equal(control.name, 'dish-crew-control')
  assert.deepEqual(control.inject, ['tools', 'subagents'])
})

test('each tool is dsh\'s, argument for argument: name, description, parameters, output schema and what it renders', () => {
  for (const name of ['send_message', 'interrupt_agent']) {
    const mine = ours.tools.get(name)!
    const theirs = dsh.tools.get(name)!
    assert.equal(mine.description, theirs.description, name)
    assert.deepEqual(mine.parameters, theirs.parameters, name)
    assert.deepEqual(mine.output.schema, theirs.output.schema, name)
    const args = { agent_id: 'child-7', message: 'which branch?' }
    assert.deepEqual(mine.output.render(args, { messageId: 'm', accepted: true }), theirs.output.render(args, { messageId: 'm', accepted: true }), name)
  }
})

test('dsh\'s send_message carries the mark that brings dsh\'s return note; this one doesn\'t', () => {
  assert.equal((dsh.tools.get('send_message') as unknown as Record<symbol, unknown>)[MARK], true, 'dsh still marks its own')
  assert.notEqual((ours.tools.get('send_message') as unknown as Record<symbol, unknown>)[MARK], true)
  assert.equal(typeof isAdjacentAgentSendMessageTool, 'function', 'dsh-subagent/internal still exports the check')
  assert.equal(isAdjacentAgentSendMessageTool!(dsh.tools.get('send_message')), true)
  assert.equal(isAdjacentAgentSendMessageTool!(ours.tools.get('send_message')), false)
})

test('send_message and interrupt_agent make the calls dsh\'s make, with the same arguments, and answer the same', async () => {
  const signal = new AbortController().signal
  const exec = { agent: { id: 'session-main' }, signal }
  const sent = { agent_id: 'child-7', message: 'which branch?' }
  assert.deepEqual(await ours.tools.get('send_message')!.execute(sent, exec), await dsh.tools.get('send_message')!.execute(sent, exec))
  assert.deepEqual(ours.sends, dsh.sends)
  assert.deepEqual(ours.sends[0], [exec.agent, 'child-7', [{ type: 'text', text: 'which branch?' }], { signal }])
  const stopped = { agent_id: 'child-7' }
  assert.deepEqual(await ours.tools.get('interrupt_agent')!.execute(stopped, exec), await dsh.tools.get('interrupt_agent')!.execute(stopped, exec))
  assert.deepEqual(ours.interrupts, dsh.interrupts)
  assert.deepEqual(ours.interrupts[0], ['child-7', { kind: 'ancestor', agent: exec.agent }])
})

test('without a calling agent, each refuses as dsh\'s does', async () => {
  const exec = { agent: undefined, signal: new AbortController().signal }
  for (const [name, args] of [['send_message', { agent_id: 'c', message: 'm' }], ['interrupt_agent', { agent_id: 'c' }]] as const) {
    const message = async (tools: Map<string, Tool>): Promise<string> => {
      try {
        await tools.get(name)!.execute(args, exec)
      } catch (error) {
        return (error as Error).message
      }
      return 'no error'
    }
    assert.equal(await message(ours.tools), await message(dsh.tools), name)
  }
})
