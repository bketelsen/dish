import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isTopLevelAgent } from '../src/agent.ts'

/** An agent as dsh builds it: `session.header` (a top-level session has no `delegationDepth`) and runtime `options`. */
function agent(header: { delegationDepth?: unknown, origin?: unknown } | undefined, options?: { subagentDepth?: unknown, model?: string }) {
  return {
    id: 'a',
    ...(header === undefined ? {} : { session: { header: { id: 's', ...header } } }),
    ...(options === undefined ? {} : { options }),
  }
}

test('no agent at all is not top-level', () => {
  assert.equal(isTopLevelAgent(undefined), false)
})

test('an agent with no session, or a session with no header, is not top-level', () => {
  assert.equal(isTopLevelAgent({}), false)
  assert.equal(isTopLevelAgent({ options: { subagentDepth: 0 } }), false)
  assert.equal(isTopLevelAgent({ session: {} }), false)
  assert.equal(isTopLevelAgent(agent(undefined)), false)
})

test('a header without a delegationDepth, or with depth 0, is top-level', () => {
  assert.equal(isTopLevelAgent(agent({})), true)
  assert.equal(isTopLevelAgent(agent({ delegationDepth: undefined })), true)
  assert.equal(isTopLevelAgent(agent({ delegationDepth: 0 })), true)
})

test('any other delegationDepth is not top-level, including a value that is not a number', () => {
  for (const depth of [1, 2, 10, -1, 0.5, NaN, '0', '1', 'one', null, false, [], {}]) {
    assert.equal(isTopLevelAgent(agent({ delegationDepth: depth })), false, `delegationDepth ${JSON.stringify(depth)}`)
  }
})

test('a runtime subagentDepth of 0 or none is top-level; any other value is not', () => {
  assert.equal(isTopLevelAgent(agent({}, {})), true)
  assert.equal(isTopLevelAgent(agent({}, { subagentDepth: undefined })), true)
  assert.equal(isTopLevelAgent(agent({}, { subagentDepth: 0 })), true)
  assert.equal(isTopLevelAgent(agent({}, { subagentDepth: 0, model: 'm' })), true)
  assert.equal(isTopLevelAgent(agent({ delegationDepth: 0 }, { subagentDepth: 0 })), true)
  for (const depth of [1, 2, '0', 'one', null]) {
    assert.equal(isTopLevelAgent(agent({}, { subagentDepth: depth })), false, `subagentDepth ${JSON.stringify(depth)}`)
    assert.equal(isTopLevelAgent(agent({ delegationDepth: 0 }, { subagentDepth: depth })), false, `subagentDepth ${JSON.stringify(depth)}, header depth 0`)
  }
})

test('a resumed child can have a header that says top-level where its runtime depth does not', () => {
  assert.equal(isTopLevelAgent(agent({ delegationDepth: 0 }, { subagentDepth: 1 })), false)
  assert.equal(isTopLevelAgent(agent({}, { subagentDepth: 1 })), false)
})

test('origin "subagent" is not top-level, whatever the depths say', () => {
  assert.equal(isTopLevelAgent(agent({ origin: 'subagent' })), false)
  assert.equal(isTopLevelAgent(agent({ origin: 'subagent', delegationDepth: 0 })), false)
  assert.equal(isTopLevelAgent(agent({ origin: 'subagent' }, { subagentDepth: 0 })), false)
})

test('any other origin is top-level', () => {
  for (const origin of [undefined, 'user', 'cli', 'web', 'Subagent', 'subagent ', null, 1]) {
    assert.equal(isTopLevelAgent(agent({ origin })), true, `origin ${JSON.stringify(origin)}`)
  }
})
