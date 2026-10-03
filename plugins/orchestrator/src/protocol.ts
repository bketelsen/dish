/**
 * The wire shapes shared by the server remote (`remote.ts`) and the Settings → Runs page (`client/`). A stub for now: the
 * shapes arrive with the page.
 * @module dish-orchestrator/protocol
 */

/** The remote's wire namespace: the page calls `ctx.remote.dishRuns`. */
export const NAMESPACE = 'dishRuns'
