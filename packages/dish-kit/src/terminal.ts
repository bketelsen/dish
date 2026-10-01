import { format } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'

/**
 * `dsh web` mounts no console exporter, so nothing logged reaches the terminal.
 * Print one named logger's records to stderr; the exporter is an effect of the
 * calling plugin and goes away with it.
 * @param ctx - the plugin context.
 * @param name - the logger name to print.
 */
export function printOwnLogs(ctx: Context, name: string): void {
  ctx.logger.exporter({
    levels: { default: 2 },
    export: ({ name: source, type, args }) => {
      if (source !== name) return
      process.stderr.write(`[${name}] ${type === 'info' ? '' : `${type}: `}${format(...args)}\n`)
    },
  })
}
