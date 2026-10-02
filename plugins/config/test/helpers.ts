import { mkdtempSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { after } from 'node:test'
import { ConfigStoreError } from '../src/store/errors.ts'
import { Git } from '../src/store/git.ts'
import type { GitIdentity } from '../src/store/git.ts'
import { NamespaceRegistry } from '../src/store/namespaces.ts'
import type { NamespaceSpec } from '../src/store/namespaces.ts'
import { ConfigStore } from '../src/store/store.ts'
import type { Author, CommitInfo, StoreOptions } from '../src/store/store.ts'

export const USER: GitIdentity = { name: 'Test User', email: 'user@test' }
export const AGENT: GitIdentity = { name: 'Test Agent', email: 'agent@test' }

/** A user author, and an agent author (a "coder" in session `s1`), for `write` calls. */
export const USERA = { kind: 'user' } as const satisfies Author
export const AGENTA = { kind: 'agent', sessionId: 's1', role: 'coder' } as const satisfies Author

const made: string[] = []
const opened: ConfigStore[] = []

after(async () => {
  await Promise.all(opened.splice(0).map(store => store.close().catch(() => {})))
  await Promise.all(made.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/** A fresh empty directory under the OS temp dir, removed when the test file finishes. */
export async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dish-config-'))
  made.push(dir)
  return dir
}

let home: string | undefined

/**
 * The environment for a process a test starts itself (git, node, sh, rm): PATH, a scratch HOME (never the runner's; one
 * per test file, removed with the temp dirs) and no global git config, then `extra`.
 */
export function ownEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  if (home === undefined) {
    home = mkdtempSync(join(tmpdir(), 'dish-config-home-'))
    made.push(home)
  }
  return { PATH: process.env.PATH, HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', ...extra }
}

/** A repository path (`<temp>/config.git`) that doesn't exist yet. */
export async function repoPath(): Promise<string> {
  return join(await tempDir(), 'config.git')
}

/** A namespace spec for tests: valid for anything unless `validate` says otherwise, writable by agents unless told. */
export function ns(
  prefix: string,
  agent: NamespaceSpec['agent'] = 'write',
  owner = 'test',
  validate: NamespaceSpec['validate'] = () => undefined,
): NamespaceSpec {
  return { prefix, owner, agent, validate }
}

export interface OpenStoreOptions extends Partial<Omit<StoreOptions, 'namespaces'>> {
  /** Namespaces to claim before opening. */
  claims?: NamespaceSpec[]
}

/** Open a store on a fresh (or the given) repository path; it is closed when the test file finishes. */
export async function openStore(options: OpenStoreOptions = {}): Promise<ConfigStore> {
  const namespaces = new NamespaceRegistry()
  for (const spec of options.claims ?? []) namespaces.claim(spec)
  const { claims: _claims, ...rest } = options
  const store = await ConfigStore.open({
    repository: await repoPath(),
    user: USER,
    agent: AGENT,
    ...rest,
    namespaces,
  })
  opened.push(store)
  return store
}

/** `openStore` on a fresh repository, with a `Git` on the same directory. */
export async function openAt(options: OpenStoreOptions = {}): Promise<{ store: ConfigStore, repository: string, git: Git }> {
  const repository = await repoPath()
  const store = await openStore({ ...options, repository })
  return { store, repository, git: new Git(repository) }
}

/** For `assert.rejects`: a `ConfigStoreError` with this `code`, whose message mentions each of `mentions`. */
export function isStoreError(code: string, ...mentions: string[]): (error: unknown) => boolean {
  return error => {
    assert.ok(error instanceof ConfigStoreError, `expected a ConfigStoreError, got ${String(error)}`)
    assert.equal(error.code, code, error.message)
    for (const text of mentions) assert.ok(error.message.includes(text), `message mentions ${text}: ${error.message}`)
    return true
  }
}

/** For `assert.rejects`: a plain `Error` (a programmer or environment problem), not one of the store's coded refusals. */
export function isPlainError(pattern: RegExp): (error: unknown) => boolean {
  return error => {
    assert.ok(error instanceof Error)
    assert.ok(!(error instanceof ConfigStoreError), `expected a plain Error, got ${String(error)}`)
    assert.match(error.message, pattern)
    return true
  }
}

/** Collect what `onCommit` is told, in order. */
export function recorder(): { seen: CommitInfo[], onCommit: (info: CommitInfo) => void } {
  const seen: CommitInfo[] = []
  return { seen, onCommit: info => { seen.push(info) } }
}
