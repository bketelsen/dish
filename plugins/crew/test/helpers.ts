import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after } from 'node:test'
import { format } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import * as configPlugin from 'dish-config'
import type { DishConfigService } from 'dish-config'
import { dump, load } from 'js-yaml'
import * as crewPlugin from '../src/index.ts'
import { DEFAULT_TEXT } from '../src/settings.ts'

const made: string[] = []

after(async () => {
  await Promise.all(made.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/** A fresh empty directory under the OS temp dir, removed when the test file finishes. */
export async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dish-crew-'))
  made.push(dir)
  return dir
}

/** Where a store and the crew's data go in one fresh temp directory: neither exists yet. */
export interface Dirs {
  root: string
  repository: string
  data: string
}

export async function dirs(): Promise<Dirs> {
  const root = await tempDir()
  return { root, repository: join(root, 'config.git'), data: join(root, 'data') }
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

/** Mount dish-crew with its data in `dataDirectory`, with terminal output off unless `config` says otherwise. */
export function mountCrew(ctx: Context, dataDirectory: string, config: Partial<crewPlugin.Config> = {}) {
  return ctx.plugin(crewPlugin, { terminal: false, dataDirectory, ...config } as crewPlugin.Config)
}

/** Wait until the plugin has claimed `crew.yaml` and seeded it. */
export async function seeded(store: DishConfigService): Promise<void> {
  await waitFor('crew.yaml to be seeded', async () => await store.read('crew.yaml') !== undefined)
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

/**
 * Run `body` with `env` set in this process, and put the variables back as they were. DSH_DISH_HOME is unset for the
 * body too: it moves every dish directory ahead of XDG_* and HOME, so one inherited from a `pnpm dev` shell would send
 * the tests that steer dish's directories with those variables to the real instance.
 */
export async function withEnv<T>(env: Record<string, string>, body: () => Promise<T>): Promise<T> {
  const names = [...new Set([...Object.keys(env), 'DSH_DISH_HOME'])]
  const saved = Object.fromEntries(names.map(key => [key, process.env[key]]))
  delete process.env.DSH_DISH_HOME
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

/** The shipped `crew.yaml` as a plain object, for a test to change and `render`. */
export function shippedDocument(): Record<string, any> {
  return load(DEFAULT_TEXT) as Record<string, any>
}

/** A `crew.yaml` text for `document`. */
export function render(document: unknown): string {
  return dump(document, { lineWidth: -1 })
}

/** The shipped `crew.yaml`, changed by `change`, as text. */
export function shippedWith(change: (document: Record<string, any>) => void): string {
  const document = shippedDocument()
  change(document)
  return render(document)
}

/**
 * Provide the stub of a service from a plugin of its own, a sibling of whatever is mounted next: how dsh's services reach a
 * preset row. A row can't read such a service as a property of its context (cordis refuses an un-injected service that no
 * ancestor provides), only through `ctx.get` or `inject`; a stub provided at the root would hide a row that does it wrong.
 * Dispose the handle to take the service away.
 */
export async function provideStub(ctx: Context, name: string, value: unknown): Promise<{ dispose(): Promise<void> | void }> {
  return ctx.plugin({
    name: `stub-${name}`,
    apply(own: Context) { (own as unknown as { provide(name: string, value: unknown): void }).provide(name, value) },
  } as never, undefined as never)
}
