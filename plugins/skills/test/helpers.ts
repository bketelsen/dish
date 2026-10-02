import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after } from 'node:test'
import { format } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import * as configPlugin from 'dish-config'
import type { DishConfigService } from 'dish-config'
import * as skillsPlugin from '../src/index.ts'
import { defaultsByPath } from '../src/defaults.ts'
import { pathFor } from '../src/skill.ts'

export const COMMIT = /^[0-9a-f]{40}$/

/** Every shipped skill by its path in the store, as the plugin seeds them. */
export const DEFAULTS_BY_PATH: Record<string, string> = defaultsByPath()

const made: string[] = []

after(async () => {
  await Promise.all(made.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/** A fresh empty directory under the OS temp dir, removed when the test file finishes. */
export async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dish-skills-'))
  made.push(dir)
  return dir
}

/** Where a store goes in one fresh temp directory: it doesn't exist yet. */
export interface Dirs {
  root: string
  repository: string
}

export async function dirs(): Promise<Dirs> {
  const root = await tempDir()
  return { root, repository: join(root, 'config.git') }
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

/** Mount dish-skills with terminal output off unless `config` says otherwise. */
export function mountSkills(ctx: Context, config: Partial<skillsPlugin.Config> = {}) {
  return ctx.plugin(skillsPlugin, { terminal: false, ...config } as skillsPlugin.Config)
}

/** Wait until the plugin has claimed its namespace and seeded every shipped skill. */
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
 * Provide `value` as the service `name` from a sibling plugin, the way dsh's plugins provide theirs: a service
 * provided at the root would be visible as a property to a plugin that read it wrongly, and would hide the mistake.
 * Dispose the handle to take the service away.
 */
export async function provideStub(ctx: Context, name: string, value: unknown): Promise<{ dispose(): Promise<void> | void }> {
  return ctx.plugin({
    name: `stub-${name}`,
    apply(own: Context) { (own as unknown as { provide(name: string, value: unknown): void }).provide(name, value) },
  } as never, undefined as never)
}

/** A person's write of `text` to the skill `name`'s document. */
export function userWrite(store: DishConfigService, name: string, text: string) {
  return store.write([{ path: pathFor(name), text }], { author: { kind: 'user' } })
}

/** A document that passes every rule, with `roles` under `metadata` when given (`null` leaves the key out). */
export function skillText(name: string, roles: string[] | null = null, body = `Do the ${name} thing.`): string {
  const metadata = roles === null ? [] : ['metadata:', `  roles: [${roles.join(', ')}]`]
  return ['---', `name: ${name}`, `description: Use when you need ${name}.`, ...metadata, '---', body, ''].join('\n')
}

/** Run git in `gitDir` with an environment that nothing in the caller's shell can redirect. */
function git(gitDir: string, args: string[], options: { input?: string, env?: Record<string, string> } = {}): Promise<string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith('GIT_')) env[key] = value
  }
  return new Promise((resolve, reject) => {
    const child = execFile('git', ['--git-dir', gitDir, ...args], { env: { ...env, ...options.env }, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) reject(new Error(`git ${args.join(' ')} failed: ${stderr.trim() || error.message}`))
      else resolve(stdout.trim())
    })
    // A git that needs no input can exit before this is written; the exit code and stderr say how it went, not the pipe.
    child.stdin?.on('error', () => {})
    child.stdin?.end(options.input ?? '')
  })
}

/**
 * Commit `changes` to `main` of the bare repository behind the store's back, as a person with git would: nothing
 * checks them, so a document can be one the validator would refuse. Returns the new commit.
 */
export async function outsideCommit(repository: string, changes: { path: string, text: string }[]): Promise<string> {
  const head = await git(repository, ['rev-parse', '--verify', 'refs/heads/main'])
  const index = join(repository, `test-index-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  const env = { GIT_INDEX_FILE: index }
  try {
    await git(repository, ['read-tree', head], { env })
    for (const { path, text } of changes) {
      const blob = await git(repository, ['hash-object', '-w', '--no-filters', '--stdin'], { input: text })
      await git(repository, ['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`], { env })
    }
    const tree = await git(repository, ['write-tree'], { env })
    const commit = await git(repository, ['-c', 'user.name=Outside', '-c', 'user.email=outside@test', 'commit-tree', '--no-gpg-sign', tree, '-p', head, '-m', 'by hand'])
    await git(repository, ['update-ref', 'refs/heads/main', commit, head])
    return commit
  } finally {
    await rm(index, { force: true })
  }
}
