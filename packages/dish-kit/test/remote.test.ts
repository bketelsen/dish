import { test } from 'node:test'
import assert from 'node:assert/strict'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { markRemote } from '../src/remote.ts'
import { remoteDescriptor, remoteContribution, jsonCodec } from '../src/client.ts'

class Sample { ping() { return 1 } async *watch(signal: AbortSignal) { yield signal.aborted } }
markRemote(Sample, 'ping')
markRemote(Sample, 'watch', { mode: 'stream' })

test('markRemote records direct and stream markers on the prototype', () => {
  const marks = remoteMethods(new Sample()).map(m => [m.method, m.mode ?? 'direct'])
  assert.deepEqual(marks, [['ping', 'direct'], ['watch', 'stream']])
})

test('remoteDescriptor fills the source-mode defaults', () => {
  const d = remoteDescriptor('pkg', 'ns', 'ping')
  assert.equal(d.id, 'pkg#ns/ping'); assert.equal(d.service, 'ns'); assert.deepEqual(d.result, { mode: 'src-json' })
  assert.equal(jsonCodec.mode, 'strict'); assert.equal(jsonCodec.create().parse(5), 5)
})

test('remoteDescriptor takes overrides, e.g. a stream with a cancellation signal', () => {
  const d = remoteDescriptor('pkg', 'ns', 'watch', { mode: 'stream', cancellation: { parameter: 'signal' } })
  assert.equal(d.method, 'watch'); assert.equal(d.namespace, 'ns')
  assert.deepEqual(d.invocation, { kind: 'direct' }); assert.deepEqual(d.parameters, [])
  assert.equal(d.mode, 'stream'); assert.deepEqual(d.cancellation, { parameter: 'signal' })
})

test('remoteContribution names the package and carries the descriptors', () => {
  const descriptors = [remoteDescriptor('pkg', 'ns', 'ping')]
  assert.deepEqual(remoteContribution('pkg', descriptors), { package: 'pkg', descriptors })
})
