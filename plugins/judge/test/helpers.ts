import { createServer } from 'node:http'
import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after } from 'node:test'
import { format } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import * as configPlugin from 'dish-config'
import type { DishConfigService } from 'dish-config'
import { dump, load } from 'js-yaml'
import * as judgePlugin from '../src/index.ts'
import { DEFAULT_TEXT } from '../src/settings.ts'

const made: string[] = []

after(async () => {
  await Promise.all(made.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/** A fresh empty directory under the OS temp dir, removed when the test file finishes. */
export async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dish-judge-'))
  made.push(dir)
  return dir
}

/** Where a store and the judge's state go in one fresh temp directory: neither exists yet. */
export interface Dirs {
  root: string
  repository: string
  state: string
}

export async function dirs(): Promise<Dirs> {
  const root = await tempDir()
  return { root, repository: join(root, 'config.git'), state: join(root, 'state') }
}

/** Poll `check` until it returns something other than `undefined` or `false`. */
export async function waitFor<T>(what: string, check: () => Promise<T | undefined | false> | T | undefined | false, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = await check()
    if (found !== undefined && found !== false) return found
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 15))
  }
}

/** Mount dish-config on `repository`, with terminal output off. */
export function mountConfig(ctx: Context, repository: string, config: Partial<configPlugin.Config> = {}) {
  return ctx.plugin(configPlugin, { terminal: false, repository, ...config } as configPlugin.Config)
}

/** Mount dish-judge with its state in `stateDirectory`, with terminal output off unless `config` says otherwise. */
export function mountJudge(ctx: Context, stateDirectory: string, config: Partial<judgePlugin.Config> = {}) {
  return ctx.plugin(judgePlugin, { terminal: false, stateDirectory, ...config } as judgePlugin.Config)
}

/** Wait until the plugin has claimed `judge.yaml` and seeded it. */
export async function seeded(store: DishConfigService): Promise<void> {
  await waitFor('judge.yaml to be seeded', async () => await store.read('judge.yaml') !== undefined)
}

/** Every warning or error logged in `ctx` by anyone, as `[name] type: text`. */
export function watchLogs(ctx: Context): string[] {
  const seen: string[] = []
  ctx.logger.exporter({
    levels: { default: 3 },
    export: message => {
      if (message.type === 'error' || message.type === 'warn') seen.push(`[${message.name}] ${message.type}: ${format(...message.args)}`)
    },
  })
  return seen
}

/** What stderr was written while it was captured, a line at a time. */
export function captureStderr(): { lines: () => string[], restore: () => void } {
  const original = process.stderr.write
  const chunks: string[] = []
  process.stderr.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk))
    return true
  }) as typeof process.stderr.write
  return {
    lines: () => chunks.join('').split('\n').filter(line => line !== ''),
    restore: () => { process.stderr.write = original },
  }
}

/** Run `body` with `env` set in this process, and put the variables back as they were. */
export async function withEnv<T>(env: Record<string, string>, body: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]))
  Object.assign(process.env, env)
  try {
    return await body()
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

/** The shipped `judge.yaml` as a plain object, for a test to change and `render`. */
export function shippedDocument(): Record<string, any> {
  return load(DEFAULT_TEXT) as Record<string, any>
}

/** A `judge.yaml` text for `document`. */
export function render(document: unknown): string {
  return dump(document, { lineWidth: -1 })
}

/** The shipped `judge.yaml`, changed by `change`, as text. */
export function shippedWith(change: (document: Record<string, any>) => void): string {
  const document = shippedDocument()
  change(document)
  return render(document)
}

/**
 * Provide the stub of a service from a plugin of its own, a sibling of whatever is mounted next: how dsh's services reach a
 * plugin that doesn't inject them. Such a service can't be read as a property of the plugin's context (cordis refuses an
 * un-injected service that no ancestor provides), only through `ctx.get` or `inject`; a stub provided at the root would
 * hide code that does it wrong. Dispose the handle to take the service away.
 */
export async function provideStub(ctx: Context, name: string, value: unknown): Promise<{ dispose(): Promise<void> | void }> {
  return ctx.plugin({
    name: `stub-${name}`,
    apply(own: Context) { (own as unknown as { provide(name: string, value: unknown): void }).provide(name, value) },
  } as never, undefined as never)
}

// --- a fake Jev --------------------------------------------------------------------------------------

/** One request the fake Jev received, with its body read in full. */
export interface RecordedRequest {
  method: string
  /** The path and query, as sent. */
  path: string
  headers: IncomingHttpHeaders
  /** The body as text. */
  text: string
  /** The body parsed as JSON, or `undefined` if it isn't. */
  json: any
}

/**
 * How the fake Jev answers one request. `delayMs` holds the answer back first, so a test can run the client into its
 * time limit; a `drop` after a delay is a connection that dies late.
 */
export type Behaviour = { delayMs?: number } & (
  /** 200 with `body` as JSON. A function gets the request, so an answer can follow the questions that were asked. */
  | { kind: 'answer', body: unknown }
  /** Any status, with optional headers and a plain-text body. */
  | { kind: 'status', status: number, headers?: Record<string, string>, body?: string }
  /** 200 with a body that is not JSON (or is the given text, which the test makes sure isn't). */
  | { kind: 'malformed', body?: string }
  /** No answer at all: the connection is closed. */
  | { kind: 'drop' }
)

export interface FakeJev {
  /** `http://127.0.0.1:<port>`, no trailing slash. */
  readonly url: string
  /** Every request so far, in order. */
  readonly requests: RecordedRequest[]
  /** Answer the next requests as given, one behaviour for each, in order. */
  queue(...behaviours: Behaviour[]): void
  /** Answer every request the queue doesn't cover. Until set, that is a 500 saying nothing was scripted. */
  always(behaviour: Behaviour): void
  close(): Promise<void>
}

const servers: FakeJev[] = []

after(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()))
})

/**
 * A `node:http` server on a free localhost port that plays Jev: it records every request and answers as scripted. It is
 * closed (its connections too, and any answer still being held back) when the test file finishes, or by `close()`.
 */
export async function startFakeJev(): Promise<FakeJev> {
  const requests: RecordedRequest[] = []
  const scripted: Behaviour[] = []
  let fallback: Behaviour = { kind: 'status', status: 500, body: 'fake Jev: nothing scripted' }
  const timers = new Set<NodeJS.Timeout>()

  const respond = (behaviour: Behaviour, request: RecordedRequest, req: IncomingMessage, res: ServerResponse): void => {
    switch (behaviour.kind) {
      case 'answer': {
        const body = typeof behaviour.body === 'function' ? (behaviour.body as (request: RecordedRequest) => unknown)(request) : behaviour.body
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
        return
      }
      case 'status':
        res.writeHead(behaviour.status, { 'content-type': 'text/plain', ...behaviour.headers })
        res.end(behaviour.body ?? '')
        return
      case 'malformed':
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(behaviour.body ?? '{"answers": {"truncated": ')
        return
      case 'drop':
        req.socket.destroy()
    }
  }

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      let json: unknown
      try { json = JSON.parse(text) } catch { /* not JSON: left undefined */ }
      const request: RecordedRequest = { method: req.method ?? '', path: req.url ?? '', headers: req.headers, text, json }
      requests.push(request)
      const behaviour = scripted.shift() ?? fallback
      if (behaviour.delayMs === undefined || behaviour.delayMs <= 0) {
        respond(behaviour, request, req, res)
        return
      }
      const timer = setTimeout(() => {
        timers.delete(timer)
        if (!res.destroyed) respond(behaviour, request, req, res)
      }, behaviour.delayMs)
      timers.add(timer)
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address() as AddressInfo

  const jev: FakeJev = {
    url: `http://127.0.0.1:${port}`,
    requests,
    queue: (...behaviours) => { scripted.push(...behaviours) },
    always: (behaviour) => { fallback = behaviour },
    close: async () => {
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
  servers.push(jev)
  return jev
}

/** What Jev answers with: its envelope around `answers`. */
export function jevBody(answers: Record<string, unknown>): Record<string, unknown> {
  return { model: 'jev-1.13.0', answers, usage: { input_tokens: 304, output_tokens: 18 } }
}

/** A noul answer, as Jev writes it. */
export function noulAnswer(p: number): unknown {
  return { type: 'noul', noul: p }
}

/** A choice answer, as Jev writes it. */
export function choiceAnswer(choice: string, probabilities: Record<string, number>, confidence = 0.8): unknown {
  return { type: 'choice', choice, probabilities, confidence }
}

/** A score answer, as Jev writes it. `legend` is left out: the client doesn't need it. */
export function scoreAnswer(score: number, probabilities: Record<string, number>, confidence = 0.9): unknown {
  return { type: 'score', score, probabilities, confidence }
}
