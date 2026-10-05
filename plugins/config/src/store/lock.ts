// The store's code is dish-kit's (`dish-kit/store`). This file keeps, at its old path, the lock under the config
// store's name; the tests also import it in a child process.
import { acquireLock as acquireStoreLock } from 'dish-kit/store'
import { CONFIG_NAMING } from './store.ts'

export { SerialQueue } from 'dish-kit/store'

/** dish-kit's `acquireLock`, whose refusals say "the config store is locked by ...". */
export function acquireLock(gitDir: string, pid?: number): Promise<() => Promise<void>> {
  return acquireStoreLock(gitDir, pid, CONFIG_NAMING.label)
}
