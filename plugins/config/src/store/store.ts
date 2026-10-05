// The store's code is dish-kit's (`dish-kit/store`). This file keeps, at its old path, what dish-config and its tests
// import from here: `ConfigStore` is dish-kit's `VersionedStore` under dish-config's words.
import { VersionedStore } from 'dish-kit/store'
import type { StoreNaming, StoreOptions as KitStoreOptions } from 'dish-kit/store'

export type {
  AcceptMeta, Author, Change, CommitInfo, EditAuthor, FileDiff, GitIdentity, HistoryQuery, LogRecord, Prepared,
  ProposalEvent, ProposalInfo, ProposalStatus, ProposeMeta, RejectMeta, RemoteStatus, RevertMeta, SeedOptions, WriteMeta,
} from 'dish-kit/store'

/** The config store's words: "Initialize dish config", "the config store is locked by ...", `DISH_CONFIG_PUSH`, ... */
export const CONFIG_NAMING: Readonly<StoreNaming> = Object.freeze({
  label: 'config store', kind: 'config', logName: 'dish-config', warningCode: 'DISH_CONFIG',
})

/** What `ConfigStore.open` takes: the store's options without `naming`, which is always `CONFIG_NAMING`. */
export type StoreOptions = Omit<KitStoreOptions, 'naming'>

/** The config repository (see `VersionedStore`), opened under `CONFIG_NAMING`. */
export class ConfigStore extends VersionedStore {
  static override open(options: StoreOptions): Promise<ConfigStore> {
    return super.open({ ...options, naming: CONFIG_NAMING }) as Promise<ConfigStore>
  }
}
