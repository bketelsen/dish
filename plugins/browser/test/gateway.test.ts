/**
 * The gateway check: the browser spec's Checks, item 4.
 *
 * The Browser tab's input goes up the uplink of the `watch` stream: a source-mode (`markRemote`) stream method reads it
 * with `this.ctx.invocation?.uplink()`. dish's other streams (dish-config's `watch`) never read an uplink, so nothing had
 * shown that one gets through dsh's gateway. This file shows it, in process, through dsh's real `TypertGatewayService`
 * over the real Typert registry, with a probe service defined here:
 * - source mode reads the `sessionId` parameter from the call's `args`, and takes the last parameter, `signal`, as the
 *   cancellation parameter;
 * - `this.ctx.invocation` is there inside a source-mode method: the gateway calls the method on a receiver got from
 *   `receiverContext.extend({ invocation })` (dsh-api-gateway `lib/index.js`, `prepareInvocation`);
 * - uplink items arrive as the JSON values sent, through the default `SRC_JSON_CODEC` (the descriptor declares no
 *   uplink codec), one by one and in order;
 * - aborting the call's `signal` ends the stream, and the method sees its own `signal` aborted.
 *
 * The context carries a `session` lookup like the one dsh-session registers (its wire field is `sessionId`), as dsh's
 * real host has: source mode matches lookups by parameter name, so a parameter named `sessionId` stays a JSON value.
 *
 * If this file fails, Task 5 of the plan takes its fallback (a unary `input` method for the tab's input).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { TypertGatewayService } from '@deepseek-ai/dsh-api-gateway'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteInvocation } from '@deepseek-ai/dsh-typert-protocol'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { markRemote } from 'dish-kit'
import type { Up } from '../src/protocol.ts'

const NAMESPACE = 'dishBrowserProbe'

type ProbeItem =
  | { kind: 'hello', sessionId: unknown }
  | { kind: 'no-invocation' }
  | { kind: 'echo', item: unknown }

/** What the probe saw of its own call, for the tests to check. */
interface Seen {
  sessionId: unknown
  signal: unknown
  request?: RemoteInvocation['request']
  service?: string
  /** Set when the method's body has finished, however it ended. */
  finished: boolean
  /** Whether the method's own `signal` was aborted when it finished. */
  abortedAtEnd?: boolean
}

let seen: Seen[] = []

/** The probe: a source-mode stream method that says hello, then echoes its uplink. */
class Probe extends TypertRemoteService {
  constructor(ctx: Context) {
    super(ctx, NAMESPACE, { namespace: NAMESPACE })
  }

  async *echo(sessionId: string, signal: AbortSignal): AsyncGenerator<ProbeItem> {
    const record: Seen = { sessionId, signal, finished: false }
    seen.push(record)
    try {
      yield { kind: 'hello', sessionId }
      const invocation = this.ctx.invocation
      if (invocation === undefined) {
        yield { kind: 'no-invocation' }
        return
      }
      record.request = invocation.request
      record.service = invocation.service
      try {
        for await (const item of invocation.uplink()) {
          if (signal.aborted) return
          yield { kind: 'echo', item }
        }
      } catch (error) {
        // An abort fails a read the method is blocked on: that is the stream ending, not a fault.
        if (!signal.aborted) throw error
      }
    } finally {
      record.finished = true
      record.abortedAtEnd = signal.aborted
    }
  }
}
markRemote(Probe, 'echo', { mode: 'stream' })

/** An uplink the test feeds while the stream runs, as the tab does: items pushed one by one, then ended. */
class Channel<T> implements AsyncIterable<T> {
  private readonly items: T[] = []
  private ended = false
  /** Whether the reader gave up (the gateway returns the iterator when the call's downlink finishes). */
  returned = false
  private wake: (() => void) | undefined

  push(...items: T[]): void {
    this.items.push(...items)
    this.signal()
  }

  end(): void {
    this.ended = true
    this.signal()
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        for (;;) {
          if (this.returned) return { value: undefined, done: true }
          const item = this.items.shift()
          if (item !== undefined) return { value: item, done: false }
          if (this.ended) return { value: undefined, done: true }
          await new Promise<void>((resolve) => { this.wake = resolve })
        }
      },
      return: async () => {
        this.returned = true
        this.signal()
        return { value: undefined, done: true }
      },
    }
  }

  private signal(): void {
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }
}

/** `promise`, or a failure naming `what` when it takes longer than `ms`. */
async function within<T>(promise: Promise<T>, what: string, ms = 5000): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { reject(new Error(`timed out waiting for ${what}`)) }, ms)
  })
  try {
    return await Promise.race([promise, late])
  } finally {
    clearTimeout(timer)
  }
}

/** Run `body` with the registry, the gateway and the probe loaded into a fresh context, and unload them however it ends. */
async function withGateway(body: (ctx: Context) => Promise<void>): Promise<void> {
  seen = []
  const ctx = new Context()
  const registry = ctx.plugin(TypertRegistry)
  await registry
  // Like dsh-session's: a lookup whose wire field is `sessionId`, for a parameter named `session`.
  const lookup = ctx.typert.lookups.register('session', {
    parameter: 'session',
    wire: 'sessionId',
    hostTypeSymbol: '@deepseek-ai/dsh-session#Session',
    wireTypeSymbol: '@deepseek-ai/dsh-session/types#SessionId',
    resolve: () => undefined,
  })
  const gateway = ctx.plugin(TypertGatewayService, {})
  await gateway
  const probe = ctx.plugin(Probe)
  await probe
  try {
    await body(ctx)
  } finally {
    await probe.dispose()
    await gateway.dispose()
    lookup()
    await registry.dispose()
  }
}

/** Open the probe's `echo` for session `s1` through the gateway, as the tab's carrier would. */
async function openEcho(ctx: Context, uplink: AsyncIterable<unknown>, signal: AbortSignal): Promise<AsyncIterator<unknown>> {
  const stream = await ctx.typertGateway.stream({ namespace: NAMESPACE, method: 'echo', args: { sessionId: 's1' }, uplink, signal })
  return stream[Symbol.asyncIterator]()
}

async function* items(...values: Up[]): AsyncGenerator<Up> {
  for (const value of values) yield value
}

const MOUSE: Up = { kind: 'mouse', action: 'down', x: 10, y: 20, button: 'left', clickCount: 1 }

test('a source-mode stream method gets its uplink through ctx.invocation', async () => {
  await withGateway(async (ctx) => {
    const sent: Up[] = [{ kind: 'frames', on: true }, MOUSE, { kind: 'text', text: 'é' }]
    const controller = new AbortController()
    const it = await openEcho(ctx, items(...sent), controller.signal)
    const got: unknown[] = []
    for (;;) {
      const next = await within(it.next(), 'the next item')
      if (next.done === true) break
      got.push(next.value)
    }
    assert.deepEqual(got, [
      { kind: 'hello', sessionId: 's1' },
      ...sent.map(item => ({ kind: 'echo', item })),
    ])
    assert.equal(seen.length, 1)
    const [call] = seen
    assert.equal(call!.sessionId, 's1', 'source mode passes the sessionId argument, not a lookup')
    assert.ok(call!.signal instanceof AbortSignal, 'the last parameter, signal, is the cancellation parameter')
    assert.deepEqual(call!.request, { namespace: NAMESPACE, method: 'echo', args: { sessionId: 's1' } })
    assert.equal(call!.service, NAMESPACE)
    assert.equal(call!.finished, true)
    assert.equal(call!.abortedAtEnd, false, 'the uplink ended, so the stream did: nothing aborted it')
  })
})

test('aborting the signal ends the stream', async () => {
  await withGateway(async (ctx) => {
    const uplink = new Channel<Up>()
    const controller = new AbortController()
    const it = await openEcho(ctx, uplink, controller.signal)
    assert.deepEqual((await within(it.next(), 'hello')).value, { kind: 'hello', sessionId: 's1' })
    uplink.push(MOUSE)
    assert.deepEqual((await within(it.next(), 'the echo')).value, { kind: 'echo', item: MOUSE })
    // The method is now blocked on its uplink, which never ends by itself: only the abort can end the stream.
    const pending = it.next()
    controller.abort()
    await assert.rejects(within(pending, 'the end after the abort'), (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, 'gateway/cancelled')
      return true
    })
    const [call] = seen
    assert.equal(call!.finished, true, 'the method finished')
    assert.equal(call!.abortedAtEnd, true, 'the method saw its own signal aborted')
    assert.equal(uplink.returned, true, 'the gateway let go of the uplink')
    const after = await within(it.next(), 'a read after the end')
    assert.equal(after.done, true)
  })
})

test('items come in order, as JSON values', async () => {
  await withGateway(async (ctx) => {
    const uplink = new Channel<Up>()
    const controller = new AbortController()
    const it = await openEcho(ctx, uplink, controller.signal)
    assert.deepEqual((await within(it.next(), 'hello')).value, { kind: 'hello', sessionId: 's1' })

    // Every kind the tab sends, one at a time, each read before the next is sent.
    const each: Up[] = [
      { kind: 'frames', on: true },
      { kind: 'ack', seq: 7 },
      { kind: 'navigate', url: 'http://127.0.0.1:5173/?q=a b' },
      { kind: 'back' }, { kind: 'forward' }, { kind: 'reload' }, { kind: 'close' },
      MOUSE,
      { kind: 'wheel', x: 1.5, y: 2.25, dx: 0, dy: -120 },
      { kind: 'key', action: 'down', key: 'é', code: 'Digit2', modifiers: 0 },
      { kind: 'key', action: 'up', key: 'Enter', code: 'Enter', modifiers: 9 },
      { kind: 'text', text: 'naïve 東京 "quoted" \\ \n' },
    ]
    for (const item of each) {
      uplink.push(item)
      const next = await within(it.next(), `the echo of ${item.kind}`)
      assert.deepEqual(next.value, { kind: 'echo', item })
      assert.deepEqual((next.value as { item: unknown }).item, JSON.parse(JSON.stringify(item)), 'a JSON value')
    }

    // A burst sent faster than it is read keeps its order.
    const burst: Up[] = Array.from({ length: 200 }, (_value, index) =>
      ({ kind: 'mouse', action: 'move', x: index, y: index * 2, button: 'left', clickCount: 1 }))
    uplink.push(...burst)
    uplink.end()
    const echoed: unknown[] = []
    for (;;) {
      const next = await within(it.next(), 'the burst')
      if (next.done === true) break
      echoed.push((next.value as { item: unknown }).item)
    }
    assert.deepEqual(echoed, burst)
    assert.equal(seen[0]!.abortedAtEnd, false)
  })
})
