/**
 * The Settings → GitHub App card's state and what it does: it calls the remotes, and keeps what it learns in one snapshot
 * store. No React here, and nothing that only a browser or only dsh can load, so `node --test` runs it against fake remotes
 * (`test/controller.test.ts`). The component reads the store through the `usePage` hook the slot gives it and acts through
 * `AppCardActions`.
 *
 * The card has two parts:
 *
 * - **The credentials.** The browser sets, removes and describes the App's ID and private key through dsh's own `credentials`
 *   remote (`CredentialsCalls`), and dish-workspaces' remote is never part of it: no call of this page's own takes or returns
 *   either value. The input of a field holds what the person typed; it is **emptied the moment a save is sent** (not when it
 *   is answered), so it is in no snapshot that outlives the click, and whatever a failure says has the value taken out of it
 *   before it is shown. What the card knows of each is "set" or "not set", where the value comes from, and whether dsh can
 *   change it. Their names (the references) come from the status. What a person types is checked first (`input.ts`), and a
 *   refusal is fixed text that quotes nothing.
 * - **What GitHub says.** `status` is dish-workspaces' last test (or a fresh one), and `runTest` makes one now. Both give an
 *   `AppStatus`; a test that could not go through is its `error`, and the rest of it is what did. dish-workspaces forgets its
 *   test when either credential changes, so the status is read again after every save and removal, and when dsh says one
 *   changed.
 *
 * Answers that arrive after the person has moved on are dropped, by a counter per kind of answer, and the controller can be
 * thrown away (`dispose`): the scope that made it ends when the remote goes, and a call still out then changes nothing.
 */

import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { AppStatus } from '../protocol.ts'
import { sourceLabel } from './format.ts'
import { appIdValue, hiding, privateKeyValue } from './input.ts'
import type { Prepared } from './input.ts'
import { unexpectedNotice } from './outcome.ts'
import type { Notice } from './outcome.ts'
import type { CredentialView, CredentialsCalls, WorkspacesApi } from './remote.ts'

/** What the page calls its remotes when a call fails before the server is reached. */
const DISH = 'dish-workspaces'
const DSH = 'dsh'

export type Load = 'idle' | 'loading' | 'ready' | 'error'

/** The two credentials: the App's ID and its private key. */
export type CredentialKind = 'appId' | 'privateKey'

/** What each is called to the person. */
const LABEL: Record<CredentialKind, string> = { appId: 'The App ID', privateKey: 'The private key' }
const KINDS: readonly CredentialKind[] = ['appId', 'privateKey']

/** The outcome of the last thing the person did, shown until they move on. */
export interface PageNotice extends Notice {
  tone: 'info' | 'success' | 'error'
}

// --- the state -----------------------------------------------------------------------------------------

export interface StatusState {
  load: Load
  /** The last status that arrived: kept while the next loads. */
  value?: AppStatus
  error?: Notice
}

export interface CredentialsState {
  /** `unavailable` when dsh's credentials remote isn't there; `idle` until the names are known. */
  load: 'idle' | 'loading' | 'ready' | 'error' | 'unavailable'
  /** Why dsh could not be asked. */
  error?: Notice
}

export interface CredentialState {
  /** dsh says a value is supplied for it. Never the value. */
  configured: boolean
  /** Where it comes from, in dsh's words (`env`, `file`); not there while there is none. */
  source?: string
  /** dsh can write it. `false` for a value the launch environment supplies. */
  writable: boolean
  /** What the person has typed. Emptied when a save is sent. */
  input: string
  busy?: 'save' | 'remove'
  notice?: PageNotice
}

export interface PageState {
  status: StatusState
  /** A test is out. */
  testing: boolean
  /** Why the last test could not be asked at all (the carrier, not GitHub: GitHub's trouble is in the status's `error`). */
  testNotice?: Notice
  credentials: CredentialsState
  appId: CredentialState
  privateKey: CredentialState
}

/** What a component can ask of the card, beside the `usePage` hook the `hooks` entry becomes. */
export interface AppCardActions {
  hooks: { page: ObservableSnapshot<PageState> }
  /**
   * The card was shown: read the status and the credentials. (There is no `hide` to match: nothing here runs while the card
   * is hidden. And no member may be called `close`: the settings shell hands every section a `close` prop of its own, which
   * wins over a face's.)
   */
  open(): Promise<void>
  /** Read both again. */
  refresh(): Promise<void>
  /** Test now: `GET /app`, the installations and the bot. */
  runTest(): Promise<void>
  /** What the person typed in a field. */
  setInput(kind: CredentialKind, text: string): void
  /** Send what was typed to dsh. */
  save(kind: CredentialKind): Promise<void>
  /** Remove the credential from dsh's store. (The component asks first.) */
  unset(kind: CredentialKind): Promise<void>
  /** Put away the notice of a field, or of the test. */
  dismiss(which: CredentialKind | 'test'): void
}

export interface AppCardController {
  /** What the component gets: the observable and the actions, and nothing that feeds the controller. */
  face: AppCardActions
  getState(): PageState
  /** dsh's credentials remote arrived, or went; `undefined` for gone. */
  setCredentials(calls: CredentialsCalls | undefined): void
  /** dsh says the credential named `ref` changed (set from another page, say): read again if it is one of ours. */
  credentialChanged(ref: string): void
  /**
   * The controller is being thrown away (the card's scope ended, and a new one will make another): a call still out when this
   * is called changes nothing and starts nothing when it lands.
   */
  dispose(): void
}

/**
 * Whether the Test button works now: no test is out and the status isn't being read, and dsh hasn't said that a credential is
 * missing. (When the card can't ask dsh, it doesn't know, and dish-workspaces answers for itself.)
 */
export function canTest(state: Pick<PageState, 'status' | 'testing' | 'credentials' | 'appId' | 'privateKey'>): boolean {
  if (state.testing || state.status.load === 'loading' || state.status.value === undefined) return false
  if (state.credentials.load === 'ready') return state.appId.configured && state.privateKey.configured
  return true
}

// --- calls ---------------------------------------------------------------------------------------

type Settled<T> = { ok: true, value: T } | { ok: false, notice: Notice }

/**
 * Wait for a call and fold a failure (the carrier's, or a throw) into a `Notice`, with `scrub` applied to its words. Never
 * throws.
 * @param remote - which remote the call is to, for the failures that name it.
 */
async function settle<T>(task: () => Promise<RemoteResult<T>>, remote: string, scrub: (text: string) => string = text => text): Promise<Settled<T>> {
  const hide = (notice: Notice): Notice => notice.detail === undefined ? { text: scrub(notice.text) } : { text: scrub(notice.text), detail: scrub(notice.detail) }
  try {
    const result = await task()
    return result.ok ? { ok: true, value: result.value } : { ok: false, notice: hide(unexpectedNotice(result.error, remote)) }
  } catch (error) {
    return { ok: false, notice: hide(unexpectedNotice(error, remote)) }
  }
}

/** A minimal snapshot store: what `createSnapshotStore` is, without the engine behind it that Node can't load. */
function createStore<T>(initial: T): ObservableSnapshot<T> & { set(next: T): void } {
  let current = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => current,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set(next) {
      current = next
      for (const listener of [...listeners]) listener()
    },
  }
}

const EMPTY: CredentialState = { configured: false, writable: true, input: '' }

/** A field as dsh describes it. What was typed is kept. */
function described(view: CredentialView | undefined): Pick<CredentialState, 'configured' | 'source' | 'writable'> {
  return { configured: view?.configured ?? false, writable: view?.writable ?? true, ...(view?.source === undefined ? {} : { source: view.source }) }
}

/**
 * @param api - the `dishWorkspaces` remote.
 * @param credentials - dsh's credentials remote, when it is there. Give it later with `setCredentials`.
 */
export function createAppCard(api: WorkspacesApi, credentials?: CredentialsCalls): AppCardController {
  let credentialCalls = credentials
  const store = createStore<PageState>({
    status: { load: 'idle' },
    testing: false,
    credentials: { load: credentials === undefined ? 'unavailable' : 'idle' },
    appId: { ...EMPTY },
    privateKey: { ...EMPTY },
  })
  const get = (): PageState => store.getSnapshot()
  const patch = (next: Partial<PageState>): void => { store.set({ ...get(), ...next }) }
  const patchStatus = (next: Partial<StatusState>): void => { patch({ status: { ...get().status, ...next } }) }
  const patchCredentials = (next: Partial<CredentialsState>): void => { patch({ credentials: { ...get().credentials, ...next } }) }
  const patchField = (kind: CredentialKind, next: Partial<CredentialState>): void => { patch({ [kind]: { ...get()[kind], ...next } }) }

  /** Bumped when an answer in flight stops being wanted: a newer read of its kind, or a write that is newer than it. */
  let statusGeneration = 0
  let credentialsGeneration = 0
  /** The names the credentials were last asked about, so a status that brings the same ones doesn't ask again. */
  let askedNames = ''
  /** `dispose` was called: nothing is started, and nothing that lands is taken. */
  let disposed = false

  const namesOf = (): { appId: string, privateKey: string } | undefined => get().status.value?.names

  // --- the credentials ------------------------------------------------------------------------------

  async function loadCredentials(): Promise<void> {
    const calls = credentialCalls
    if (calls === undefined) {
      patchCredentials({ load: 'unavailable', error: undefined })
      return
    }
    const names = namesOf()
    if (names === undefined || disposed) return
    askedNames = `${names.appId} ${names.privateKey}`
    const generation = ++credentialsGeneration
    patchCredentials({ load: get().credentials.load === 'ready' ? 'ready' : 'loading', error: undefined })
    const result = await settle(() => calls.describe([...new Set([names.appId, names.privateKey])]), DSH)
    if (disposed || generation !== credentialsGeneration) return
    if (!result.ok) {
      patchCredentials({ load: 'error', error: result.notice })
      return
    }
    patchField('appId', described(result.value[names.appId]))
    patchField('privateKey', described(result.value[names.privateKey]))
    patchCredentials({ load: 'ready', error: undefined })
  }

  /** What a credential action needs and may do: the calls, the name, and no other action of this field under way. */
  const ready = (kind: CredentialKind): { calls: CredentialsCalls, name: string } | undefined => {
    const names = namesOf()
    if (disposed || credentialCalls === undefined || names === undefined || get()[kind].busy !== undefined) return undefined
    return { calls: credentialCalls, name: names[kind] }
  }

  /** After dsh took a change: read what it says now, and what dish-workspaces makes of it. */
  const afterChange = async (): Promise<void> => {
    await Promise.all([loadCredentials(), refreshStatus()])
  }

  const save = async (kind: CredentialKind): Promise<void> => {
    const target = ready(kind)
    if (target === undefined) return
    const field = get()[kind]
    const prepared: Prepared = kind === 'appId' ? appIdValue(field.input) : privateKeyValue(field.input)
    if (!prepared.ok) {
      patchField(kind, { notice: { tone: 'error', text: prepared.problem } })
      return
    }
    if (!field.writable) {
      patchField(kind, { input: '', notice: { tone: 'error', text: `dsh can't change this from here: it comes from ${sourceLabel(field.source)}. Change it there.` } })
      return
    }
    // The input is emptied now, before anything is sent or answered, so no snapshot after this click holds the value.
    patchField(kind, { input: '', busy: 'save', notice: undefined })
    const result = await settle(() => target.calls.set(target.name, prepared.value), DSH, hiding(prepared.value))
    if (disposed) return
    if (!result.ok) {
      patchField(kind, { busy: undefined, notice: { tone: 'error', text: `${LABEL[kind]} was not saved.`, detail: result.notice.detail ?? result.notice.text } })
      return
    }
    patchField(kind, { busy: undefined })
    await afterChange()
    if (disposed) return
    // dsh is the only authority on whether the value now exists.
    patchField(kind, get()[kind].configured
      ? { notice: { tone: 'success', text: `${LABEL[kind]} was saved.` } }
      : { notice: { tone: 'error', text: `dsh took the value but reports none set for ${target.name}. Check where the credential comes from.` } })
  }

  const unset = async (kind: CredentialKind): Promise<void> => {
    const target = ready(kind)
    if (target === undefined) return
    const field = get()[kind]
    if (!field.writable) {
      patchField(kind, { notice: { tone: 'error', text: `dsh can't remove this from here: it comes from ${sourceLabel(field.source)}. Change it there.` } })
      return
    }
    patchField(kind, { input: '', busy: 'remove', notice: undefined })
    const result = await settle(() => target.calls.unset(target.name), DSH)
    if (disposed) return
    patchField(kind, { busy: undefined })
    if (!result.ok) {
      patchField(kind, { notice: { tone: 'error', text: `${LABEL[kind]} was not removed.`, detail: result.notice.detail ?? result.notice.text } })
      return
    }
    await afterChange()
    if (disposed) return
    patchField(kind, { notice: { tone: 'success', text: `${LABEL[kind]} was removed.` } })
  }

  // --- the status and the test ------------------------------------------------------------------------

  async function refreshStatus(): Promise<void> {
    if (disposed) return
    const generation = ++statusGeneration
    patchStatus({ load: 'loading', error: undefined })
    const result = await settle(() => api.status(), DISH)
    if (disposed || generation !== statusGeneration) return
    if (!result.ok) {
      patchStatus({ load: 'error', error: result.notice })
      return
    }
    patchStatus({ load: 'ready', value: result.value, error: undefined })
    // The names are the status's; a card that had none, or other ones, asks dsh about these.
    if (`${result.value.names.appId} ${result.value.names.privateKey}` !== askedNames) await loadCredentials()
  }

  const runTest = async (): Promise<void> => {
    if (disposed || get().testing) return
    patch({ testing: true, testNotice: undefined })
    // A read that began before this test must not replace its answer.
    const generation = ++statusGeneration
    const result = await settle(() => api.test(), DISH)
    if (disposed) return
    if (!result.ok) {
      patch({ testing: false, testNotice: result.notice })
      return
    }
    if (generation === statusGeneration) patchStatus({ load: 'ready', value: result.value, error: undefined })
    patch({ testing: false })
  }

  const refresh = async (): Promise<void> => {
    await Promise.all([refreshStatus(), get().status.value === undefined ? Promise.resolve() : loadCredentials()])
  }

  // --- the face ---------------------------------------------------------------------------------------

  const face: AppCardActions = {
    // A store to read and subscribe to, not the one the controller writes.
    hooks: { page: { getSnapshot: store.getSnapshot, subscribe: store.subscribe } },
    open: refresh,
    refresh,
    runTest,
    setInput(kind, text) {
      if (disposed || get()[kind].busy !== undefined) return
      patchField(kind, { input: text })
    },
    save,
    unset,
    dismiss(which) {
      if (which === 'test') patch({ testNotice: undefined })
      else patchField(which, { notice: undefined })
    },
  }

  return {
    face,
    getState: get,
    setCredentials(calls) {
      credentialCalls = calls
      credentialsGeneration++
      askedNames = ''
      if (calls === undefined) {
        // What was typed is dropped with the remote it was to go to, and what dsh said is not known any more.
        patch({
          credentials: { load: 'unavailable' },
          ...Object.fromEntries(KINDS.map(kind => [kind, { ...EMPTY }])),
        })
        return
      }
      patchCredentials({ load: 'idle', error: undefined })
      void loadCredentials()
    },
    credentialChanged(ref) {
      const names = namesOf()
      if (disposed || names === undefined || (ref !== names.appId && ref !== names.privateKey)) return
      void afterChange()
    },
    dispose() {
      disposed = true
    },
  }
}
