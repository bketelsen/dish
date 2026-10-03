/**
 * The server half of Settings → Runs: a read-only remote over the run store and the ledgers. A stub for now: Task 11
 * replaces this file whole, keeping `RemoteOptions` and `runsRemote`'s signature.
 * @module dish-orchestrator/remote
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Ledger } from './ledger.ts'
import type { Run, RunStore } from './store.ts'

/** What the remote reads: the records, the ledgers, and whether a run's driver is live. */
export interface RemoteOptions {
  store: RunStore
  ledger: Ledger
  live(run: Run): boolean
}

/** Mount the remote on `ctx`. Does nothing yet. */
export function runsRemote(_ctx: Context, _options: RemoteOptions): void {}
