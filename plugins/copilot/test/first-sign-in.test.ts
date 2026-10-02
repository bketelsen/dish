import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CopilotStatus } from '../src/protocol.ts'
import { showFirstSignIn } from '../src/client/first-sign-in.ts'

const status = (over: Partial<CopilotStatus>): CopilotStatus => ({ signedIn: false, inFlight: false, route: false, ...over })

test('nothing shows until the status has loaded', () => {
  assert.equal(showFirstSignIn(undefined), false)
})

test('the card shows while there is no Copilot route, signed in or not', () => {
  assert.equal(showFirstSignIn(status({ route: false })), true)
  assert.equal(showFirstSignIn(status({ route: false, signedIn: true })), true)
  assert.equal(showFirstSignIn(status({ route: false, inFlight: true })), true)
})

test('the card goes away once the route exists', () => {
  assert.equal(showFirstSignIn(status({ route: true })), false)
  assert.equal(showFirstSignIn(status({ route: true, signedIn: true })), false)
  assert.equal(showFirstSignIn(status({ route: true, inFlight: true })), false)
})
