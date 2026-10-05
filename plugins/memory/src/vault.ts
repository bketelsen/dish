/**
 * The vault: dish-kit's `VersionedStore`, opened under its own words, with the two namespaces memories live in.
 *
 * It works as the config store does: a bare repository changed only through git plumbing, one queue and a process lock,
 * a restore from the remote's `main` on a first start, and a push after every commit that never fails a save. `user/`
 * and `families/` are both `dish-memory`'s, open to agents (`write`): no agent reaches the vault but through the
 * service, which is where the agent's rules are. Their `validate` is `validateVault`, so a malformed memory is refused
 * even from code that goes past the service.
 *
 * @module dish-memory/vault
 */

import { NamespaceRegistry, VersionedStore } from 'dish-kit/store'
import type { CommitInfo, GitIdentity, NamespaceSpec, RemoteStatus, StoreNaming } from 'dish-kit/store'
import { validateVault } from './format.ts'

/** The vault's words: "Initialize dish vault", "the vault is locked by …", and warnings as `dish-memory`, `DISH_MEMORY_*`. */
export const VAULT_NAMING: StoreNaming = { label: 'vault', kind: 'vault', logName: 'dish-memory', warningCode: 'DISH_MEMORY' }

/** The vault's namespaces, both `owner`'s: `user/` and `families/`, open to agents, and validated as memories and indexes. */
export function vaultNamespaces(owner: string): NamespaceSpec[] {
  return ['user/', 'families/'].map(prefix => ({ prefix, owner, agent: 'write', validate: validateVault }))
}

export interface VaultOptions {
  /** The bare repository's directory; created if missing. */
  repository: string
  /** Where `main` is pushed, and restored from on a first start; none keeps the vault local. */
  remote?: string
  /** Who a person's commits are by. */
  user: GitIdentity
  /** Who an agent's commits, and the vault's own, are by. */
  agent: GitIdentity
  /** After each commit to `main`. The service tells of its own commits itself (`dish-memory/changed`): this is for anyone else. */
  onCommit?: (info: CommitInfo) => void
  /** After every change to where the remote copy stands. */
  onRemoteStatus?: (status: RemoteStatus) => void
}

/**
 * Open the vault at `options.repository`, with `user/` and `families/` claimed for `dish-memory`.
 * @throws what `VersionedStore.open` throws: `LOCKED`, or a plain `Error` for a directory that isn't a dish vault, an
 *   unusable remote, or a first start that can't reach it.
 */
export function openVault(options: VaultOptions): Promise<VersionedStore> {
  const namespaces = new NamespaceRegistry()
  for (const spec of vaultNamespaces('dish-memory')) namespaces.claim(spec)
  return VersionedStore.open({
    repository: options.repository,
    namespaces,
    user: options.user,
    agent: options.agent,
    naming: VAULT_NAMING,
    ...(options.remote === undefined ? {} : { remote: options.remote }),
    ...(options.onCommit === undefined ? {} : { onCommit: options.onCommit }),
    ...(options.onRemoteStatus === undefined ? {} : { onRemoteStatus: options.onRemoteStatus }),
  })
}
