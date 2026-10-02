import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after } from 'node:test'
import { format } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import * as configPlugin from 'dish-config'
import type { DishConfigService } from 'dish-config'
import * as promptsPlugin from '../src/index.ts'
import { DEFAULTS } from '../src/defaults.ts'
import { CREW_ROLES, pathFor } from '../src/roles.ts'

export const COMMIT = /^[0-9a-f]{40}$/

/** The eight roles dish ships a prompt for. */
export const ALL_ROLES: readonly string[] = ['common', 'main', ...CREW_ROLES]

/** Every shipped prompt by its path in the store, as the plugin seeds them. */
export const DEFAULTS_BY_PATH: Record<string, string> = Object.fromEntries(ALL_ROLES.map(role => [pathFor(role), DEFAULTS[role]!]))

const made: string[] = []

after(async () => {
  await Promise.all(made.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/** A fresh empty directory under the OS temp dir, removed when the test file finishes. */
export async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dish-prompts-'))
  made.push(dir)
  return dir
}

/** Where a store and a snapshot directory go in one fresh temp directory: neither exists yet. */
export interface Dirs {
  root: string
  repository: string
  state: string
  /** Where the snapshot files are: `<state>/agents`. */
  agents: string
}

export async function dirs(): Promise<Dirs> {
  const root = await tempDir()
  const state = join(root, 'state')
  return { root, repository: join(root, 'config.git'), state, agents: join(state, 'agents') }
}

/** The name of `agentId`'s snapshot file. */
export function snapshotFile(agentId: string): string {
  return `${createHash('sha256').update(agentId).digest('hex')}.json`
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

/** Mount dish-prompts with its snapshots in `stateDirectory`, with terminal output off unless `config` says otherwise. */
export function mountPrompts(ctx: Context, stateDirectory: string, config: Partial<promptsPlugin.Config> = {}) {
  return ctx.plugin(promptsPlugin, { terminal: false, stateDirectory, ...config } as promptsPlugin.Config)
}

/** Wait until the plugin has claimed its namespaces and seeded all eight documents. */
export async function seeded(store: DishConfigService): Promise<void> {
  await waitFor('the defaults to be seeded', async () => (await Promise.all(Object.keys(DEFAULTS_BY_PATH).map(path => store.read(path)))).every(text => text !== undefined))
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

/** A person's write of `text` to `role`'s document. */
export function userWrite(store: DishConfigService, role: string, text: string) {
  return store.write([{ path: pathFor(role), text }], { author: { kind: 'user' } })
}
