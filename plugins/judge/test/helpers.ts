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
