/**
 * dish-memory: memory and direction for dish's agents. The vault (a bare git repository of user and family memories in
 * Claude Code's format), each family's direction in the config store, the `dishMemory` service, and Settings → Memory.
 *
 * A stub for now: the vault and the service come with the next step of the plan. The package, its wire
 * (`protocol.ts`) and the memory format (`format.ts`) are in place.
 *
 * @module dish-memory
 */

import type { Context } from '@deepseek-ai/cordis'

export const name = 'dish-memory'

/** Does nothing yet. */
export function apply(_ctx: Context): void {}
