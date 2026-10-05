/**
 * dish-memory/context: the dish preset's row, which delivers the `dish-memory` message and registers `remember`, `forget`
 * and `recall`.
 *
 * A stub for now: it has the row's name, injection and empty config, and registers nothing.
 *
 * @module dish-memory/context
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'dish-memory-context'

/** The tool registry the row's tools go into. */
export const inject = ['tools']

export interface Config {}

export const Config: Schema<Config> = Schema.object({})

/** Does nothing yet. */
export function apply(_ctx: Context, _config: Config): void {}
