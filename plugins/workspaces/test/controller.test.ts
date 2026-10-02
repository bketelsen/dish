/**
 * The GitHub App card's controller, driven through fake remotes: what it loads, how it sets and removes the App's ID and its
 * private key through dsh's credentials remote, what it refuses before anything is sent, what the Test button does with each
 * answer, and, above all, that the key is in no state the page ever holds once Save is pressed. The controller has no React in
 * it, so this runs under `node --test`; the JSX around it is checked in a browser.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { createAppCard, canTest } from '../src/client/controller.ts'
import type { AppCardController, PageState } from '../src/client/controller.ts'
import { APP_ID_MAX, KEY_MAX, appIdValue, privateKeyValue } from '../src/client/input.ts'
import { relativeTime, selectionText, sourceLabel } from '../src/client/format.ts'
import { unexpectedNotice } from '../src/client/outcome.ts'
import type { CredentialView, CredentialsCalls, WorkspacesApi } from '../src/client/remote.ts'
import type { AppStatus } from '../src/protocol.ts'

// --- fakes ---------------------------------------------------------------------------------------

const ok = <T>(value: T): RemoteResult<T> => ({ ok: true, value })
const carrierDown = (): RemoteResult<never> => ({ ok: false, error: { message: 'gateway offline' } }) as unknown as RemoteResult<never>

const NAMES = { appId: 'DISH_GITHUB_APP_ID', privateKey: 'DISH_GITHUB_APP_PRIVATE_KEY' }

/** The lines of a PEM body, each distinct and long enough for any filter to know it. */
const BODY = [
  'MIIEowIBAAKCAQEAnotARealKeyJustTestBodyLineNumberOne0123456789',
  'secondBodyLineOfTheTestKeyAbcdefghijklmnopqrstuvwxyz0123456789',
  'thirdBodyLineOfTheTestKeyZYXWVUTSRQPONMLKJIHGFEDCBA9876543210',
]
const PEM = `-----BEGIN RSA PRIVATE KEY-----\n${BODY.join('\n')}\n-----END RSA PRIVATE KEY-----\n`
const APP_ID = '1234567'

interface Gate { release: () => void, opened: Promise<void> }

function gate(): Gate {
  let release!: () => void
  const opened = new Promise<void>((resolve) => { release = resolve })
  return { release, opened }
}

function appStatus(overrides: Partial<AppStatus> = {}): AppStatus {
  return {
    names: { ...NAMES },
    app: { slug: 'dish', name: 'dish' },
    bot: { login: 'dish[bot]', email: '99+dish[bot]@users.noreply.github.com' },
    installations: [{ id: 7, account: 'acme', type: 'Organization', selection: 'selected' }],
    error: null,
    checkedAt: 1_000,
    ...overrides,
  }
}

/** dish-workspaces' remote: what `status` and `test` say, and what they were asked. */
class FakeWorkspaces implements WorkspacesApi {
  calls: string[] = []
  remembered: AppStatus = appStatus()
  tested: AppStatus = appStatus({ checkedAt: 2_000 })
  down = false
  gates = new Map<string, Gate>()

  private async wait(key: string): Promise<void> {
    const held = this.gates.get(key)
    if (held === undefined) return
    this.gates.delete(key)
    await held.opened
  }

  async status(): Promise<RemoteResult<AppStatus>> {
    this.calls.push('status')
    const answer = structuredClone(this.remembered)
    await this.wait('status')
    return this.down ? carrierDown() : ok(answer)
  }

  async test(): Promise<RemoteResult<AppStatus>> {
    this.calls.push('test')
    await this.wait('test')
    if (this.down) return carrierDown()
    this.remembered = structuredClone(this.tested)
    return ok(structuredClone(this.tested))
  }
}

/** dsh's credentials remote over a map: what is set, where it comes from, and what was sent. */
class FakeCredentials implements CredentialsCalls {
  values = new Map<string, string>()
  source = 'file'
  writable = true
  calls: string[] = []
  /** What `set` was given, in order: name and value. */
  sets: Array<{ ref: string, value: string }> = []
  unsets: string[] = []
  /** From now on `set` fails, saying `reason(value)`. */
  failSet: ((value: string) => string) | undefined
  gates = new Map<string, Gate>()
  down = false

  private async wait(key: string): Promise<void> {
    const held = this.gates.get(key)
    if (held === undefined) return
    this.gates.delete(key)
    await held.opened
  }

  async describe(refs: string[]): Promise<RemoteResult<Record<string, CredentialView>>> {
    this.calls.push(`describe ${refs.join(',')}`)
    await this.wait('describe')
    if (this.down) return carrierDown()
    return ok(Object.fromEntries(refs.map(ref => [ref, this.values.has(ref)
      ? { configured: true, source: this.source, writable: this.writable }
      : { configured: false, writable: this.writable }])))
  }

  async set(ref: string, value: string): Promise<RemoteResult<void>> {
    this.calls.push(`set ${ref}`)
    this.sets.push({ ref, value })
    await this.wait('set')
    if (this.failSet !== undefined) return { ok: false, error: { message: this.failSet(value) } } as unknown as RemoteResult<void>
    this.values.set(ref, value)
    return ok(undefined)
  }

  async unset(ref: string): Promise<RemoteResult<void>> {
    this.calls.push(`unset ${ref}`)
    this.unsets.push(ref)
    await this.wait('unset')
    this.values.delete(ref)
    return ok(undefined)
  }
}

interface Rig {
  app: FakeWorkspaces
  credentials: FakeCredentials
  card: AppCardController
  /** Every state the page held, as JSON, from the moment `watch` was called. */
  seen: string[]
  state(): PageState
}

function rig(options: { credentials?: boolean } = {}): Rig {
  const app = new FakeWorkspaces()
  const credentials = new FakeCredentials()
  const card = createAppCard(app, options.credentials === false ? undefined : credentials)
  const seen: string[] = []
  card.face.hooks.page.subscribe(() => { seen.push(JSON.stringify(card.getState())) })
  return { app, credentials, card, seen, state: () => card.getState() }
}

/** Type into a field and press Save. `r.seen` is what the page held from the click on: what was typed is in the states before it. */
async function set(r: Rig, kind: 'appId' | 'privateKey', text: string): Promise<void> {
  r.card.face.setInput(kind, text)
  r.seen.length = 0
  await r.card.face.save(kind)
}

const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

// --- loading -------------------------------------------------------------------------------------

test('open reads the status, then asks dsh about the two names it gave', async () => {
  const r = rig()
  r.credentials.values.set(NAMES.appId, APP_ID)
  assert.equal(r.state().credentials.load, 'idle')
  await r.card.face.open()
  assert.deepEqual(r.app.calls, ['status'])
  assert.deepEqual(r.credentials.calls, [`describe ${NAMES.appId},${NAMES.privateKey}`])
  const state = r.state()
  assert.equal(state.status.load, 'ready')
  assert.deepEqual(state.status.value, appStatus())
  assert.equal(state.credentials.load, 'ready')
  assert.equal(state.appId.configured, true)
  assert.equal(state.appId.source, 'file')
  assert.equal(state.appId.writable, true)
  assert.equal(state.privateKey.configured, false)
  assert.equal(state.appId.input, '')
  assert.equal(state.privateKey.input, '')
})

test('opened again, it reads both at once, and a read already out is not repeated', async () => {
  const r = rig()
  await r.card.face.open()
  r.app.calls.length = 0
  r.credentials.calls.length = 0
  await r.card.face.open()
  assert.deepEqual(r.app.calls, ['status'])
  assert.equal(r.credentials.calls.length, 1)
})

test('opened again, a draft that was never saved is gone: the store outlives the mount, and a key left in the field must not come back', async () => {
  const r = rig()
  await r.card.face.open()
  r.card.face.setInput('appId', '4321')
  r.card.face.setInput('privateKey', PEM)
  await r.card.face.open()
  assert.equal(r.state().appId.input, '')
  assert.equal(r.state().privateKey.input, '')
  assert.ok(!JSON.stringify(r.state()).includes(BODY[0]!))
})

test('opened while a save is out, open leaves that field alone and still empties the other', async () => {
  const r = rig()
  await r.card.face.open()
  const held = gate()
  r.credentials.gates.set('set', held)
  r.card.face.setInput('appId', APP_ID)
  const saving = r.card.face.save('appId')
  await tick()
  r.card.face.setInput('privateKey', PEM)
  await r.card.face.open()
  assert.equal(r.state().appId.busy, 'save', 'the save is still out')
  assert.equal(r.state().privateKey.input, '')
  held.release()
  await saving
  assert.equal(r.state().appId.configured, true)
  assert.equal(r.state().appId.notice?.tone, 'success')
})

test('a status that can\'t be read is an error with a way to try again, and the credentials wait for the names', async () => {
  const r = rig()
  r.app.down = true
  await r.card.face.open()
  assert.equal(r.state().status.load, 'error')
  assert.match(r.state().status.error!.text, /Something went wrong talking to dish-workspaces/)
  assert.match(r.state().status.error!.detail!, /gateway offline/)
  assert.deepEqual(r.credentials.calls, [])
  r.app.down = false
  await r.card.face.refresh()
  assert.equal(r.state().status.load, 'ready')
  assert.equal(r.state().credentials.load, 'ready')
  assert.equal(r.credentials.calls.length, 1)
})

test('dsh\'s credentials can\'t be read: an error for the credentials, and the status stands', async () => {
  const r = rig()
  r.credentials.down = true
  await r.card.face.open()
  assert.equal(r.state().status.load, 'ready')
  assert.equal(r.state().credentials.load, 'error')
  assert.match(r.state().credentials.error!.text, /Something went wrong talking to dsh/)
  r.credentials.down = false
  await r.card.face.refresh()
  assert.equal(r.state().credentials.load, 'ready')
  assert.equal(r.state().credentials.error, undefined)
})

test('without dsh\'s credentials remote the card says so; one that arrives later is read, and one that goes takes the page back', async () => {
  const r = rig({ credentials: false })
  assert.equal(r.state().credentials.load, 'unavailable')
  await r.card.face.open()
  assert.equal(r.state().credentials.load, 'unavailable')
  r.card.face.setInput('privateKey', PEM)
  await r.card.face.save('privateKey')
  assert.equal(r.state().privateKey.notice, undefined, 'nothing to send it to')

  r.credentials.values.set(NAMES.privateKey, PEM)
  r.card.setCredentials(r.credentials)
  await tick()
  await tick()
  assert.equal(r.state().credentials.load, 'ready')
  assert.equal(r.state().privateKey.configured, true)

  r.card.face.setInput('appId', APP_ID)
  r.card.setCredentials(undefined)
  assert.equal(r.state().credentials.load, 'unavailable')
  assert.equal(r.state().privateKey.configured, false)
  assert.equal(r.state().appId.input, '', 'what was typed is dropped with the remote')
})

// --- the App ID ----------------------------------------------------------------------------------

test('the App ID: typed, sent to dsh under its name, the field emptied before the call lands, and the status read again', async () => {
  const r = rig()
  await r.card.face.open()
  r.app.calls.length = 0
  const held = gate()
  r.credentials.gates.set('set', held)
  r.card.face.setInput('appId', ' 1234567 ')
  assert.equal(r.state().appId.input, ' 1234567 ')
  const saving = r.card.face.save('appId')
  await tick()
  assert.deepEqual(r.credentials.sets, [{ ref: NAMES.appId, value: APP_ID }])
  assert.equal(r.state().appId.input, '', 'emptied when the save is sent, not when it is answered')
  assert.equal(r.state().appId.busy, 'save')
  held.release()
  await saving
  const state = r.state()
  assert.equal(state.appId.busy, undefined)
  assert.equal(state.appId.configured, true)
  assert.equal(state.appId.notice?.tone, 'success')
  assert.deepEqual(r.app.calls, ['status'], 'the status is read again: dish-workspaces forgets its test when a credential changes')
})

test('an App ID that is not digits is refused before anything is sent, and kept to correct', async () => {
  const r = rig()
  await r.card.face.open()
  for (const text of ['', '   ', 'abc', '12 34', 'Iv1.abcdef0123456789', '12.5', '-1', '1'.repeat(APP_ID_MAX + 1)]) {
    r.card.face.setInput('appId', text)
    await r.card.face.save('appId')
    assert.equal(r.state().appId.notice?.tone, 'error', JSON.stringify(text))
    assert.equal(r.state().appId.input, text, 'kept')
    assert.ok(!(r.state().appId.notice?.text ?? '').includes(text.trim()) || text.trim() === '', 'the refusal does not quote it')
  }
  assert.deepEqual(r.credentials.sets, [])
  assert.deepEqual(appIdValue('0042'), { ok: true, value: '0042' })
})

test('an App ID dsh can\'t change is refused with where it comes from', async () => {
  const r = rig()
  r.credentials.values.set(NAMES.appId, APP_ID)
  r.credentials.source = 'env'
  r.credentials.writable = false
  await r.card.face.open()
  assert.equal(r.state().appId.writable, false)
  await set(r, 'appId', '7654321')
  assert.deepEqual(r.credentials.sets, [])
  assert.match(r.state().appId.notice!.text, /environment dsh was started in/)
  await r.card.face.unset('appId')
  assert.deepEqual(r.credentials.unsets, [])
  assert.match(r.state().appId.notice!.text, /environment dsh was started in/)
})

// --- the private key -----------------------------------------------------------------------------

test('the key goes to dsh with its line breaks, once, under its name', async () => {
  const r = rig()
  await r.card.face.open()
  await set(r, 'privateKey', PEM)
  assert.deepEqual(r.credentials.sets, [{ ref: NAMES.privateKey, value: PEM }])
  assert.equal(r.credentials.sets[0]!.value.split('\n').length, 6, 'five lines and the break after the last')
  assert.equal(r.state().privateKey.configured, true)
  assert.equal(r.state().privateKey.notice?.tone, 'success')
})

test('the key as a browser or a file gives it: CRLF endings, blank lines around it, no final line break, all come out as the PEM', async () => {
  const r = rig()
  await r.card.face.open()
  await set(r, 'privateKey', `\n\n  ${PEM.trimEnd().replace(/\n/g, '\r\n')}\r\n\r\n`)
  assert.equal(r.credentials.sets[0]!.value, PEM)
  r.credentials.sets.length = 0
  await set(r, 'privateKey', PEM.trimEnd())
  assert.equal(r.credentials.sets[0]!.value, PEM)
})

test('a PKCS#8 key is a key too', () => {
  const pkcs8 = `-----BEGIN PRIVATE KEY-----\n${BODY.join('\n')}\n-----END PRIVATE KEY-----`
  assert.deepEqual(privateKeyValue(pkcs8), { ok: true, value: `${pkcs8}\n` })
})

test('a value that is not a private key is refused before anything is sent, in words that don\'t quote it', async () => {
  const r = rig()
  await r.card.face.open()
  const cases: Array<[string, RegExp]> = [
    ['', /Paste the private key first/],
    ['ghp_notAKeyAtAll', /not a private key/],
    [`-----BEGIN PUBLIC KEY-----\n${BODY.join('\n')}\n-----END PUBLIC KEY-----\n`, /not a private key/],
    [`-----BEGIN CERTIFICATE-----\n${BODY.join('\n')}\n-----END CERTIFICATE-----\n`, /not a private key/],
    [`  ${BODY.join('\n')}\n-----END RSA PRIVATE KEY-----`, /not a private key/],
    // The line breaks lost on the way: one line.
    [`-----BEGIN RSA PRIVATE KEY----- ${BODY.join(' ')} -----END RSA PRIVATE KEY-----`, /lost its line breaks/],
    // Cut short.
    [`-----BEGIN RSA PRIVATE KEY-----\n${BODY.join('\n')}\n`, /cut short/],
    [`-----BEGIN RSA PRIVATE KEY-----\n${'A'.repeat(KEY_MAX)}\n-----END RSA PRIVATE KEY-----\n`, /too long/],
  ]
  for (const [text, problem] of cases) {
    r.card.face.setInput('privateKey', text)
    await r.card.face.save('privateKey')
    const notice = r.state().privateKey.notice
    assert.equal(notice?.tone, 'error', JSON.stringify(text.slice(0, 40)))
    assert.match(notice!.text, problem)
    for (const line of BODY) assert.ok(!notice!.text.includes(line) && !(notice!.detail ?? '').includes(line), 'the refusal quotes the key')
    assert.equal(r.state().privateKey.input, text, 'kept to correct')
  }
  assert.deepEqual(r.credentials.sets, [])
})

test('the key is in no state the page holds once Save is pressed, and the field is empty when the call is sent', async () => {
  const r = rig()
  await r.card.face.open()
  const held = gate()
  r.credentials.gates.set('set', held)
  r.card.face.setInput('privateKey', PEM)
  r.seen.length = 0
  const saving = r.card.face.save('privateKey')
  await tick()
  assert.equal(r.state().privateKey.input, '')
  held.release()
  await saving
  assert.ok(r.seen.length > 0)
  for (const state of r.seen) {
    for (const line of BODY) assert.ok(!state.includes(line), 'the key is in a state after Save')
    assert.ok(!state.includes('PRIVATE KEY-----') || !state.includes('BEGIN RSA'), 'a PEM is in a state after Save')
  }
  assert.equal(JSON.stringify(r.state()).includes(BODY[0]!), false)
})

test('a failure that repeats the key is shown with the key taken out', async () => {
  const r = rig()
  await r.card.face.open()
  r.credentials.failSet = value => `dsh refused ${JSON.stringify(value)}: ${value} and ${encodeURIComponent(value)}`
  await set(r, 'privateKey', PEM)
  const notice = r.state().privateKey.notice!
  assert.equal(notice.tone, 'error')
  assert.match(notice.text, /private key was not saved/)
  const shown = `${notice.text} ${notice.detail ?? ''}`
  for (const line of BODY) assert.ok(!shown.includes(line), 'the key is on the screen')
  assert.ok(!shown.includes(encodeURIComponent(BODY[0]!)), 'its URL-encoded form is on the screen')
  assert.match(shown, /dsh refused/)
  for (const state of r.seen) for (const line of BODY) assert.ok(!state.includes(line))
  assert.equal(r.state().privateKey.configured, false)
  assert.equal(r.state().privateKey.busy, undefined)
})

test('a failure that repeats the App ID is shown with it taken out', async () => {
  const r = rig()
  await r.card.face.open()
  r.credentials.failSet = value => `no good: ${value}`
  await set(r, 'appId', APP_ID)
  const shown = `${r.state().appId.notice!.text} ${r.state().appId.notice!.detail ?? ''}`
  assert.ok(!shown.includes(APP_ID))
  assert.match(shown, /no good/)
})

test('a second Save while the first is out changes nothing; so does typing', async () => {
  const r = rig()
  await r.card.face.open()
  const held = gate()
  r.credentials.gates.set('set', held)
  r.card.face.setInput('appId', APP_ID)
  const first = r.card.face.save('appId')
  await tick()
  r.card.face.setInput('appId', '999999')
  assert.equal(r.state().appId.input, '', 'the field is read-only while the save is out')
  await r.card.face.save('appId')
  held.release()
  await first
  assert.equal(r.credentials.sets.length, 1)
})

test('dsh taking the value and reporting none set for the name is said', async () => {
  const r = rig()
  await r.card.face.open()
  r.credentials.set = async function (this: FakeCredentials) { this.calls.push('set'); return ok(undefined) } as never
  await set(r, 'appId', APP_ID)
  assert.equal(r.state().appId.notice?.tone, 'error')
  assert.match(r.state().appId.notice!.text, /reports none set/)
})

test('a change dsh reports while the save reads back does not turn a saved value into "none set"', async () => {
  const r = rig()
  await r.card.face.open()
  const own = gate()
  r.credentials.gates.set('describe', own)
  r.card.face.setInput('appId', APP_ID)
  const saving = r.card.face.save('appId')
  await tick()
  // dsh's event arrives while the save's own read is out; its read is the later one, and it is slow.
  const later = gate()
  r.credentials.gates.set('describe', later)
  r.card.credentialChanged(NAMES.appId)
  await tick()
  own.release()
  await saving
  assert.equal(r.state().appId.notice?.tone, 'success', JSON.stringify(r.state().appId.notice))
  later.release()
  await tick()
  await tick()
  assert.equal(r.state().appId.configured, true)
  assert.equal(r.state().appId.notice?.tone, 'success')
})

test('dsh that can\'t be asked after a save is said, and is not "none set": the value was sent', async () => {
  const r = rig()
  await r.card.face.open()
  r.credentials.down = true
  await set(r, 'appId', APP_ID)
  assert.deepEqual(r.credentials.sets, [{ ref: NAMES.appId, value: APP_ID }])
  const notice = r.state().appId.notice!
  assert.equal(notice.tone, 'info')
  assert.match(notice.text, /sent to dsh/)
  assert.doesNotMatch(notice.text, /none set/)
  assert.equal(r.state().credentials.load, 'error')
  assert.equal(r.state().appId.busy, undefined)
})

// --- removing ------------------------------------------------------------------------------------

test('removing unsets the name in dsh and reads again', async () => {
  const r = rig()
  r.credentials.values.set(NAMES.privateKey, PEM)
  r.credentials.values.set(NAMES.appId, APP_ID)
  await r.card.face.open()
  r.app.calls.length = 0
  await r.card.face.unset('privateKey')
  assert.deepEqual(r.credentials.unsets, [NAMES.privateKey])
  assert.equal(r.state().privateKey.configured, false)
  assert.equal(r.state().appId.configured, true)
  assert.equal(r.state().privateKey.notice?.tone, 'success')
  assert.deepEqual(r.app.calls, ['status'])
  await r.card.face.unset('appId')
  assert.deepEqual(r.credentials.unsets, [NAMES.privateKey, NAMES.appId])
})

// --- the test ------------------------------------------------------------------------------------

test('Test asks dish-workspaces, shows the answer, and keeps it when the next status read is older', async () => {
  const r = rig()
  await r.card.face.open()
  const stale = gate()
  r.app.gates.set('status', stale)
  const slow = r.card.face.refresh()
  await tick()
  const inTest = gate()
  r.app.gates.set('test', inTest)
  const testing = r.card.face.runTest()
  await tick()
  assert.equal(r.state().testing, true)
  inTest.release()
  await testing
  assert.equal(r.state().testing, false)
  assert.equal(r.state().status.value?.checkedAt, 2_000)
  stale.release()
  await slow
  assert.equal(r.state().status.value?.checkedAt, 2_000, 'an older read does not replace the test')
})

test('a test that went through with an error shows the error; a carrier that fails shows a notice and keeps the status', async () => {
  const r = rig()
  await r.card.face.open()
  r.app.tested = appStatus({ app: null, bot: null, installations: [], error: 'GET /app answered HTTP 401: Bad credentials', checkedAt: 3_000 })
  await r.card.face.runTest()
  assert.equal(r.state().status.value?.error, 'GET /app answered HTTP 401: Bad credentials')
  assert.equal(r.state().testNotice, undefined)
  r.app.down = true
  await r.card.face.runTest()
  assert.match(r.state().testNotice!.text, /Something went wrong talking to dish-workspaces/)
  assert.equal(r.state().status.value?.checkedAt, 3_000)
  assert.equal(r.state().testing, false)
  r.app.down = false
  r.card.face.dismiss('test')
  assert.equal(r.state().testNotice, undefined)
})

test('a second Test while one is out is not made', async () => {
  const r = rig()
  await r.card.face.open()
  const held = gate()
  r.app.gates.set('test', held)
  const first = r.card.face.runTest()
  await tick()
  await r.card.face.runTest()
  held.release()
  await first
  assert.equal(r.app.calls.filter(call => call === 'test').length, 1)
})

test('canTest: not while one is out or the status is being read, not when dsh says a credential is missing, yes when it can\'t say', async () => {
  const r = rig()
  assert.equal(canTest(r.state()), false, 'nothing known yet: the status is not read')
  await r.card.face.open()
  assert.equal(canTest(r.state()), false, 'neither is set')
  r.credentials.values.set(NAMES.appId, APP_ID)
  await r.card.face.refresh()
  assert.equal(canTest(r.state()), false, 'the key is missing')
  r.credentials.values.set(NAMES.privateKey, PEM)
  await r.card.face.refresh()
  assert.equal(canTest(r.state()), true)
  const held = gate()
  r.app.gates.set('test', held)
  const testing = r.card.face.runTest()
  await tick()
  assert.equal(canTest(r.state()), false, 'one is out')
  held.release()
  await testing
  assert.equal(canTest(r.state()), true)

  const bare = rig({ credentials: false })
  await bare.card.face.open()
  assert.equal(canTest(bare.state()), true, 'dish-workspaces knows whether the credentials are set')
})

// --- live ----------------------------------------------------------------------------------------

test('dsh saying one of the two names changed reads both again; another name does nothing', async () => {
  const r = rig()
  await r.card.face.open()
  r.app.calls.length = 0
  r.credentials.calls.length = 0
  r.card.credentialChanged('SOMETHING_ELSE')
  await tick()
  assert.deepEqual([r.app.calls, r.credentials.calls], [[], []])
  r.credentials.values.set(NAMES.privateKey, PEM)
  r.card.credentialChanged(NAMES.privateKey)
  await tick()
  await tick()
  assert.deepEqual(r.app.calls, ['status'])
  assert.equal(r.credentials.calls.length, 1)
  assert.equal(r.state().privateKey.configured, true)
  r.card.credentialChanged(NAMES.appId)
  await tick()
  await tick()
  assert.deepEqual(r.app.calls, ['status', 'status'])
})

test('an answer that lands after dispose changes nothing', async () => {
  const r = rig()
  const held = gate()
  r.app.gates.set('status', held)
  const opening = r.card.face.open()
  await tick()
  r.card.dispose()
  const before = r.seen.length
  held.release()
  await opening
  assert.equal(r.seen.length, before, 'no state after dispose')
  assert.deepEqual(r.credentials.calls, [], 'and nothing asked of dsh')
})

// --- the face ------------------------------------------------------------------------------------

test('the face has no member the settings shell\'s props could shadow, and nothing that feeds the controller', () => {
  const r = rig()
  const members = Object.keys(r.card.face).sort()
  assert.ok(!members.includes('close'), 'the shell spreads its own `close` over the face')
  assert.deepEqual(members, ['dismiss', 'hooks', 'open', 'refresh', 'runTest', 'save', 'setInput', 'unset'])
})

// --- the helpers ---------------------------------------------------------------------------------

test('the wording: time, installations, the source of a credential, a failure', () => {
  assert.equal(relativeTime(1_000, 1_000), 'just now')
  assert.equal(relativeTime(0, 59_999), 'just now')
  assert.equal(relativeTime(0, 60_000), '1 min ago')
  assert.equal(relativeTime(0, 3_599_999), '59 min ago')
  assert.equal(relativeTime(0, 3 * 3_600_000), '3 h ago')
  assert.equal(relativeTime(0, 5 * 86_400_000), '5 days ago')
  assert.equal(relativeTime(0, 40 * 86_400_000), '1970-01-01')
  assert.equal(relativeTime(10_000, 0), 'just now')
  assert.equal(selectionText('all'), 'all repositories')
  assert.equal(selectionText('selected'), 'selected repositories')
  assert.match(sourceLabel('env'), /environment/)
  assert.match(sourceLabel('file'), /credential file/)
  assert.match(sourceLabel(undefined), /can't change/)
  assert.deepEqual(unexpectedNotice({ message: 'down' }, 'dsh'), { text: 'Something went wrong talking to dsh', detail: 'down' })
  assert.deepEqual(unexpectedNotice(undefined), { text: 'Something went wrong talking to dish-workspaces' })
})
