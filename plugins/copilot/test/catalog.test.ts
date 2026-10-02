import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { constants } from 'node:fs'
import { mkdtemp, open, rm, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { format } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import * as catalog from '../src/catalog.ts'

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'dish-copilot-catalog-'))
  try { await run(dir) } finally { await rm(dir, { recursive: true, force: true }) }
}

/** Every warning or error logged in `ctx`, by anyone (cordis logs a plugin that failed to load), as text. */
function watchLogs(ctx: Context): string[] {
  const seen: string[] = []
  ctx.logger.exporter({
    levels: { default: 3 },
    export: message => {
      if (message.type === 'error' || message.type === 'warn') seen.push(`[${message.name}] ${message.type}: ${format(...message.args)}`)
    },
  })
  return seen
}

/**
 * Open the writing end of the named pipe `fifo` once someone is reading it. A
 * non-blocking open fails with ENXIO until a reader has it open, so polling it
 * tells when the reader is waiting on it, and never hangs.
 */
async function writerOnceRead(fifo: string, timeoutMs = 20_000): Promise<FileHandle> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      return await open(fifo, constants.O_WRONLY | constants.O_NONBLOCK)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENXIO') throw error
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for a reader on ${fifo}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

test('unloading the plugin while apply is still awaiting is no failure: no error, nothing provided', () => withTempDir(async (dir) => {
  // The cache is a named pipe, so apply's read of it waits until the test closes the writing end.
  const cacheFile = join(dir, 'copilot-models.json')
  execFileSync('mkfifo', [cacheFile], { env: { PATH: process.env.PATH, HOME: dir } })
  const ctx = new Context()
  const logs = watchLogs(ctx)
  const handle = ctx.plugin(catalog, { cacheFile, refreshOnStart: false, updateRoute: false, terminal: false })

  const writer = await writerOnceRead(cacheFile)
  // apply is inside `await readCache(...)` now. Unload it, then let the read finish (empty: no cache).
  const disposing = handle.dispose()
  await writer.close()
  await disposing

  // The load settled without an error (a rejected load would throw here, and show in the log).
  await handle
  assert.deepEqual(logs, [])
  assert.equal(ctx.get('copilotCatalog'), undefined)
}))
