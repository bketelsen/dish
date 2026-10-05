// The store's code is dish-kit's (`dish-kit/store`). This file keeps, at its old path, the push queue under the config
// store's words (`dish-config push loop failed: ...`, `DISH_CONFIG_PUSH`), and re-exports the rest.
import { PushQueue as StorePushQueue } from 'dish-kit/store'
import type { Git, PushQueueOptions as StorePushQueueOptions } from 'dish-kit/store'
import { CONFIG_NAMING } from './store.ts'

export {
  DEFAULT_PUSH_DELAYS, DEFAULT_PUSH_TIMEOUT_MS, checkPushOptions, checkRemote, fetchRemoteMain, firstLine, redact, runNetworkGit,
} from 'dish-kit/store'
export type { NetworkResult, NetworkRun, RemoteStatus } from 'dish-kit/store'

/** What the queue takes: dish-kit's options without `naming`, which is always the config store's. */
export type PushQueueOptions = Omit<StorePushQueueOptions, 'naming'>

/** dish-kit's `PushQueue`, warning in the config store's words. */
export class PushQueue extends StorePushQueue {
  constructor(git: Git, remote: string, options: PushQueueOptions = {}) {
    super(git, remote, { ...options, naming: CONFIG_NAMING })
  }
}
