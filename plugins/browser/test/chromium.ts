/**
 * Helpers for the two real-Chromium test files (`chromium-driver.test.ts`, `chromium-plugin.test.ts`), and only them.
 *
 * - **Which Chromium:** `DISH_TEST_CHROMIUM` when it is set and an executable file, else `/usr/bin/chromium` when it is
 *   one (the VM's). With neither, `chromiumPath()` is `undefined` and the file's tests skip. Nothing here downloads a
 *   browser.
 * - **A scratch `TMPDIR`:** `scratchTmp()` points `process.env.TMPDIR` at a fresh directory before anything launches, so
 *   Playwright's profiles (`playwright_chromiumdev_profile-*`, `playwright-artifacts-*`) and Chromium's own files go
 *   there, and every Chromium process carries it on its command line (`--user-data-dir=<it>/…`). It is made in
 *   `os.tmpdir()`, which must be a short path: Chromium's singleton socket goes in an `org.chromium.Chromium.<random>`
 *   directory in it, and a socket's path holds at most 107 bytes ("Socket path too long" otherwise). On the VM it is
 *   `/tmp`.
 * - **Cleanup, in `after`, even on failure:** `scratchTmp()` is called at the top of the file, so its `after` hook is the
 *   file's own (an `after` called while a test runs belongs to that test) and runs first among the file's (node:test
 *   runs them in the order they were registered). It closes everything the helpers started, newest first: each browser
 *   `launchForTests` gave, each page server, and each closer given to `closeLater` (a plugin that launched Chromium
 *   through the real driver). Then it waits for no process to hold the directory, kills and fails on any that still
 *   do, and removes the directory. The helpers may so be called from inside a test, as a lazy setup does.
 * - **Pages** come from `pageServer`, on `127.0.0.1:0`. No test opens an internet address.
 *
 * @module dish-browser/test/chromium
 */

import { after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { accessSync, constants, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Driver, DriverBrowser } from '../src/driver.ts'

/** The most a cleanup step waits: for a browser to close, or for Chromium's processes to exit after it. */
const CLEANUP_MS = 15_000

/** Whether `path` is a regular file (symbolic links followed) that this process may execute. */
function executableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** DISH_TEST_CHROMIUM when set, else /usr/bin/chromium, when it is an executable file; else undefined (the test skips). */
export function chromiumPath(): string | undefined {
  const candidates = [process.env.DISH_TEST_CHROMIUM, '/usr/bin/chromium']
  return candidates.find((path): path is string => path !== undefined && path !== '' && executableFile(path))
}

/** What `scratchTmp`'s `after` closes, newest first, before it checks the processes. */
const closers: Array<() => Promise<unknown>> = []

/**
 * Have `scratchTmp`'s `after` hook call `close` before it checks for Chromium processes: for Chromium launched other than
 * through `launchForTests` (a plugin on the real driver). Errors are ignored; it is called at most once.
 */
export function closeLater(close: () => Promise<unknown>): void {
  let called = false
  closers.push(async () => {
    if (called) return
    called = true
    await close()
  })
}

/** A promise that settles with `work`, or resolves after `ms` (a cleanup step never holds the test file up for good). */
async function within(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([work.catch(() => {}), new Promise<void>(resolve => { timer = setTimeout(resolve, ms) })])
  } finally {
    clearTimeout(timer)
  }
}

/** PIDs whose /proc/<pid>/cmdline holds `dir`. */
export function processesHolding(dir: string): number[] {
  const pids: number[] = []
  let entries: string[]
  try {
    entries = readdirSync('/proc')
  } catch {
    return pids
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    const pid = Number(entry)
    if (pid === process.pid) continue
    try {
      // The arguments are NUL-separated; a path never holds a NUL, so a plain search is exact enough.
      if (readFileSync(`/proc/${entry}/cmdline`).toString('utf8').includes(dir)) pids.push(pid)
    } catch {
      // The process exited while we looked, or isn't ours to read.
    }
  }
  return pids
}

/** Resolves once no process holds `dir`, or after `ms`; gives the PIDs still holding it. */
async function waitForNoneHolding(dir: string, ms: number): Promise<number[]> {
  const deadline = Date.now() + ms
  for (;;) {
    const pids = processesHolding(dir)
    if (pids.length === 0 || Date.now() >= deadline) return pids
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

/** Point process.env.TMPDIR at a fresh scratch directory for this file; `after` checks no process holds it, then removes it. */
export function scratchTmp(): string {
  const before = process.env.TMPDIR
  const dir = mkdtempSync(join(tmpdir(), 'dish-browser-chromium-'))
  process.env.TMPDIR = dir
  after(async () => {
    try {
      for (const close of closers.splice(0).reverse()) await within(close(), CLEANUP_MS)
      const left = await waitForNoneHolding(dir, CLEANUP_MS)
      if (left.length > 0) {
        for (const pid of left) {
          try { process.kill(pid, 'SIGKILL') } catch { /* gone already */ }
        }
        assert.fail(`Chromium processes were left holding the scratch TMPDIR (now killed): ${left.join(', ')}`)
      }
    } finally {
      if (before === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = before
      rmSync(dir, { recursive: true, force: true })
    }
  }, { timeout: 3 * CLEANUP_MS + 5_000 })
  return dir
}

/** Whether a launch failed for want of Chromium's own sandbox: its error mentions `sandbox` or `namespace`. */
function forWantOfSandbox(error: unknown): boolean {
  return /sandbox|namespace/i.test(error instanceof Error ? error.message : String(error))
}

/** Launch with Chromium's sandbox, or without it when that fails for want of one; says which. */
export async function launchForTests(driver: Driver, executablePath: string): Promise<{ browser: DriverBrowser, sandbox: boolean }> {
  const launch = async (sandbox: boolean) => {
    const browser = await driver.launch({ executablePath, sandbox })
    closeLater(() => browser.close())
    return { browser, sandbox }
  }
  try {
    return await launch(true)
  } catch (error) {
    if (!forWantOfSandbox(error)) throw error
    return await launch(false)
  }
}

/** One page `pageServer` serves: `type` defaults to HTML, `status` to 200; `delayMs` holds the response back that long. */
export interface TestPage { type?: string, body: string | Buffer, status?: number, headers?: Record<string, string>, delayMs?: number }

/** The page server: where it listens, and what reached it, in order (paths, with their query). */
export interface PageServer {
  origin: string
  port: number
  /** Each request's path. */
  requests: string[]
  /** Each WebSocket upgrade's path. Every upgrade is accepted, and the socket left open until `after`. */
  upgrades: string[]
}

/** The WebSocket handshake's constant (RFC 6455, 1.3). */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/**
 * A node:http server on 127.0.0.1:0 serving `pages` (path → { type?, body, status? }); closed in `scratchTmp`'s `after`.
 * It doesn't keep the process alive by itself.
 */
export async function pageServer(pages: Record<string, TestPage>): Promise<PageServer> {
  const requests: string[] = []
  const upgrades: string[] = []
  const sockets = new Set<Socket>()
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    requests.push(path)
    const page = pages[path]
    const send = () => {
      if (page === undefined) {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        response.end('not found')
        return
      }
      response.writeHead(page.status ?? 200, { 'content-type': page.type ?? 'text/html; charset=utf-8', ...page.headers })
      response.end(page.body)
    }
    if (page?.delayMs) setTimeout(send, page.delayMs)
    else send()
  })
  server.on('upgrade', (request, socket: Socket) => {
    upgrades.push(new URL(request.url ?? '/', 'http://127.0.0.1').pathname)
    sockets.add(socket)
    socket.on('error', () => {})
    socket.on('close', () => sockets.delete(socket))
    const key = String(request.headers['sec-websocket-key'] ?? '')
    const accept = createHash('sha1').update(key + WS_GUID).digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('the page server has no port')
  server.unref()
  closeLater(async () => {
    for (const socket of sockets) socket.destroy()
    const closed = new Promise<void>(resolve => server.close(() => resolve()))
    // Chromium's keep-alive connections would hold `close` up until they time out.
    server.closeAllConnections()
    await closed
  })
  return { origin: `http://127.0.0.1:${address.port}`, port: address.port, requests, upgrades }
}
