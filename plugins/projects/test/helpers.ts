import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before } from 'node:test'
import { format } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import * as configPlugin from 'dish-config'
import * as projectsPlugin from '../src/index.ts'
import type { WorkspacesDriver } from '../src/onboarding.ts'
import type { Project } from '../src/registry.ts'

const made: string[] = []

after(async () => {
  await Promise.all(made.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/** A fresh empty directory under the OS temp dir, removed when the test file finishes. */
export async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dish-projects-'))
  made.push(dir)
  return dir
}

/** The variables the scratch environment sets, put back as they were when the file ends. */
const SCRATCH_ENV = ['HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'DSH_DISH_HOME'] as const

/**
 * For a test file that starts dish-config or the plugin: a scratch HOME (with a test identity in its `.gitconfig`)
 * for every git the store starts, no system config, and `DSH_DISH_HOME` in a temp directory, so neither the store
 * nor the status file can reach real state. Put back when the file ends.
 */
export function useScratchEnv(): void {
  const saved = Object.fromEntries(SCRATCH_ENV.map(name => [name, process.env[name]]))
  before(async () => {
    const dir = await tempDir()
    const home = join(dir, 'home')
    await mkdir(home, { recursive: true })
    await writeFile(join(home, '.gitconfig'), '[user]\n\tname = Test User\n\temail = test@example.test\n')
    process.env.HOME = home
    process.env.XDG_CONFIG_HOME = join(home, '.config')
    process.env.XDG_STATE_HOME = join(home, '.local', 'state')
    process.env.GIT_CONFIG_NOSYSTEM = '1'
    // dish-config's git passes these two through, so a caller's own would win over the scratch HOME.
    process.env.GIT_CONFIG_GLOBAL = join(home, '.gitconfig')
    process.env.GIT_CONFIG_SYSTEM = '/dev/null'
    process.env.DSH_DISH_HOME = join(dir, 'inst')
  })
  after(() => {
    for (const name of SCRATCH_ENV) {
      const value = saved[name]
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })
}

/**
 * A fresh instance home for one test: `DSH_DISH_HOME` points at it from now on, so a plugin mounted after this keeps
 * its status file in `<it>/state/dish/projects/status.json`.
 */
export async function freshInstance(): Promise<{ instance: string, statusFile: string }> {
  const instance = join(await tempDir(), 'inst')
  process.env.DSH_DISH_HOME = instance
  return { instance, statusFile: join(instance, 'state', 'dish', 'projects', 'status.json') }
}

/** Poll `check` until it returns something other than `undefined` or `false`. */
export async function waitFor<T>(what: string, check: () => Promise<T | undefined | false> | T | undefined | false, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = await check()
    if (found !== undefined && found !== false) return found
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/**
 * Wait, without polling, for `find` to give something: it is asked now, and again each time a waker in `wakers` is
 * called (the code that changes what it looks at calls them all). Fails naming `what` if nothing comes within
 * `deadlineMs`: a diagnostic for a wait that will never end, under the runner's own 60 s, not a pace.
 */
export function whenFound<T>(what: string, find: () => T | undefined, wakers: Set<() => void>, deadlineMs = 50_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const now = find()
    if (now !== undefined) {
      resolve(now)
      return
    }
    const wake = (): void => {
      const found = find()
      if (found === undefined) return
      wakers.delete(wake)
      clearTimeout(deadline)
      resolve(found)
    }
    const deadline = setTimeout(() => {
      wakers.delete(wake)
      reject(new Error(`${what} never came (waited ${deadlineMs / 1000} s)`))
    }, deadlineMs)
    wakers.add(wake)
  })
}

/** Call every waker of `wakers` (see `whenFound`). */
export function wakeAll(wakers: Set<() => void>): void {
  for (const wake of [...wakers]) wake()
}

/** Mount dish-config on `repository`, with terminal output off and a person's identity of its own. */
export function mountConfig(ctx: Context, repository: string, config: Partial<configPlugin.Config> = {}) {
  return ctx.plugin(configPlugin, {
    terminal: false,
    repository,
    userName: 'Test User',
    userEmail: 'test@example.test',
    ...config,
  } as configPlugin.Config)
}

/** Mount dish-projects with terminal output off unless `config` says otherwise. */
export function mountProjects(ctx: Context, config: Partial<projectsPlugin.Config> = {}) {
  return ctx.plugin(projectsPlugin, { terminal: false, ...config } as projectsPlugin.Config)
}

/**
 * Provide `value` as the service `name` from a sibling plugin, the way dsh's plugins provide theirs: a service
 * provided at the root would be visible as a property to a plugin that read it wrongly, and would hide the mistake.
 * Dispose the handle to take the service away.
 */
export function provideStub(ctx: Context, name: string, value: unknown) {
  return ctx.plugin({
    name: `stub-${name}`,
    apply(own: Context) { (own as unknown as { provide(name: string, value: unknown): void }).provide(name, value) },
  } as never, undefined as never)
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

/** A project as `parseProjects` gives it, with `overrides`. */
export function project(name: string, overrides: Partial<Project> = {}): Project {
  const slash = name.indexOf('/')
  return {
    name,
    owner: name.slice(0, slash),
    repo: name.slice(slash + 1),
    family: 'acme',
    role: 'a test project',
    gate: 'true',
    gateTimeout: '1m',
    gateTimeoutMs: 60_000,
    setup: undefined,
    setupTimeout: '15m',
    setupTimeoutMs: 900_000,
    gateEnv: {},
    ...overrides,
  }
}

/** One call the fake driver received, and the handles that settle it. */
export interface DriverCall {
  kind: 'onboard' | 'prepare'
  project: Project
  signal: AbortSignal | undefined
  progress: (step: string) => void
  resolve(value?: { setup: { ran: boolean, reason?: string } }): void
  reject(error: unknown): void
  settled: boolean
}

/**
 * A `dishWorkspaces` stand-in whose every call waits until the test settles it. `calls` lists them in order.
 * `onboard` resolves with setup run unless the test says otherwise. `next` is told of each call as it is made (no polling).
 */
export function fakeDriver(): { driver: WorkspacesDriver, calls: DriverCall[], next(kind: 'onboard' | 'prepare', name: string): Promise<DriverCall> } {
  const calls: DriverCall[] = []
  const wakers = new Set<() => void>()
  const call = (kind: 'onboard' | 'prepare', target: Project, signal?: AbortSignal, progress: (step: string) => void = () => {}) =>
    new Promise<{ setup: { ran: boolean, reason?: string } }>((resolve, reject) => {
      const entry: DriverCall = {
        kind,
        project: target,
        signal,
        progress,
        settled: false,
        resolve: (value = { setup: { ran: true } }) => { entry.settled = true; resolve(value) },
        reject: (error) => { entry.settled = true; reject(error) },
      }
      calls.push(entry)
      wakeAll(wakers)
    })
  const driver: WorkspacesDriver = {
    onboard: (target, options) => call('onboard', target, options.signal, options.progress),
    prepare: async (target) => { await call('prepare', target) },
  }
  return {
    driver,
    calls,
    next: (kind, name) => whenFound(`a ${kind} call for ${name}`, () => calls.find(entry => !entry.settled && entry.kind === kind && entry.project.name === name), wakers),
  }
}

/** Run git in `gitDir` with an environment that nothing in the caller's shell can redirect. */
function git(gitDir: string, args: string[], options: { input?: string, env?: Record<string, string> } = {}): Promise<string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith('GIT_')) env[key] = value
  }
  env.GIT_CONFIG_NOSYSTEM = '1'
  return new Promise((resolve, reject) => {
    const child = execFile('git', ['--git-dir', gitDir, ...args], { env: { ...env, ...options.env }, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) reject(new Error(`git ${args.join(' ')} failed: ${stderr.trim() || error.message}`))
      else resolve(stdout.trim())
    })
    child.stdin?.on('error', () => {})
    child.stdin?.end(options.input ?? '')
  })
}

/**
 * Commit `changes` to `main` of the bare repository behind the store's back, as a person with git would: nothing
 * checks them, so a document can be one the validator would refuse. Returns the new commit. The caller's HOME is
 * the scratch one (`useScratchEnv`).
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
