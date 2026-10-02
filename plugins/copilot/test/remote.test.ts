import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { KEY, CopilotRemote } from '../src/remote.ts'

/** What `ctx.settings.describe()` answers, as far as the remote reads it. */
interface Descriptor { ns: string, revision: string, value: unknown }

interface Stubs {
  /** The descriptors `settings.describe()` returns; change it between calls. */
  descriptors: Descriptor[]
  /** What `credentials.readRecord()` returns. */
  record: unknown
  /** What `authorization.describe()` returns. */
  flow: { inFlight: boolean } | undefined
}

/**
 * Provide `value` as the service `name` from a sibling plugin, the way dsh's plugins provide theirs: a plugin that doesn't
 * inject a service can't read it as a property, so a stub at the root would hide a plugin that does it wrong.
 */
function provideStub(ctx: Context, name: string, value: unknown) {
  return ctx.plugin({
    name: `stub-${name}`,
    apply(own: Context) { (own as unknown as { provide(name: string, value: unknown): void }).provide(name, value) },
  } as never, undefined as never)
}

/** Run `body` with `CopilotRemote` mounted on a `Context` whose authorization, credentials and settings are stubs. */
async function withRemote<T>(stubs: Partial<Stubs>, body: (remote: CopilotRemote, state: Stubs) => Promise<T>): Promise<T> {
  const state: Stubs = { descriptors: [], record: undefined, flow: undefined, ...stubs }
  const ctx = new Context()
  const handles = [
    provideStub(ctx, 'authorization', { describe: (key: string) => key === KEY ? state.flow : undefined }),
    provideStub(ctx, 'credentials', { readRecord: async (key: string) => key === KEY ? state.record : undefined }),
    provideStub(ctx, 'settings', { describe: () => state.descriptors }),
  ]
  const remote = ctx.plugin(CopilotRemote, { enterpriseDomain: '' })
  await Promise.all([...handles, remote])
  try {
    const service = ctx.get('dishCopilot') as CopilotRemote | undefined
    assert.ok(service, 'the remote is mounted')
    return await body(service, state)
  } finally {
    await remote.dispose()
    await Promise.all(handles.map(handle => handle.dispose()))
  }
}

const piAi = (value: unknown): Descriptor => ({ ns: 'llm-pi-ai', revision: 'r1', value })

test('route is false while llm-pi-ai has no settings descriptor', () => withRemote({}, async (remote) => {
  const status = await remote.status()
  assert.equal(status.route, false)
  assert.equal(status.signedIn, false)
  assert.equal(status.inFlight, false)
}))

test('route is false when llm-pi-ai has no providers, or no github-copilot one', async () => {
  await withRemote({ descriptors: [piAi({})] }, async (remote) => {
    assert.equal((await remote.status()).route, false)
  })
  await withRemote({ descriptors: [piAi({ providers: {} })] }, async (remote) => {
    assert.equal((await remote.status()).route, false)
  })
  await withRemote({ descriptors: [piAi({ providers: { other: {} } })] }, async (remote) => {
    assert.equal((await remote.status()).route, false)
  })
})

test('route is true once llm-pi-ai has a github-copilot provider, even an empty one', () => withRemote({ descriptors: [piAi({ providers: { 'github-copilot': {} } })] }, async (remote) => {
  assert.equal((await remote.status()).route, true)
}))

test('route follows the settings: it flips when the descriptor changes, and other namespaces do not count', () => withRemote({ descriptors: [{ ns: 'other', revision: 'r', value: { providers: { 'github-copilot': {} } } }] }, async (remote, state) => {
  assert.equal((await remote.status()).route, false)
  state.descriptors = [piAi({ providers: { 'github-copilot': {} } })]
  assert.equal((await remote.status()).route, true)
  state.descriptors = [piAi({ providers: {} })]
  assert.equal((await remote.status()).route, false)
}))

test('signedIn and inFlight do not depend on the route', async () => {
  await withRemote({ record: { any: 'record' }, flow: { inFlight: true } }, async (remote) => {
    const status = await remote.status()
    assert.deepEqual([status.signedIn, status.inFlight, status.route], [true, true, false])
  })
  await withRemote({ record: { any: 'record' }, flow: { inFlight: false }, descriptors: [piAi({ providers: { 'github-copilot': {} } })] }, async (remote) => {
    const status = await remote.status()
    assert.deepEqual([status.signedIn, status.inFlight, status.route], [true, false, true])
  })
  await withRemote({ flow: { inFlight: true }, descriptors: [piAi({ providers: { 'github-copilot': {} } })] }, async (remote) => {
    const status = await remote.status()
    assert.deepEqual([status.signedIn, status.inFlight, status.route], [false, true, true])
  })
})
