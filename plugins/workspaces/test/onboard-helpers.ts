/**
 * A small GitHub for onboarding's tests: the fake API (the App, its installations and tokens) and the fake smart-HTTP
 * git server, wired so every token the API mints is one git takes, with dish's real credential helper and a real
 * `TokenManager` in between. Plus what the tests look at: a byte-for-byte listing of a directory, the files that hold a
 * string, and a `git` shim that records every git dish's code starts.
 *
 * Nothing here reaches the network or the real home: the servers listen on 127.0.0.1, every directory is a temp one,
 * and the code under test gets a scratch HOME from the test (`withEnv(dishHome(dir), …)`).
 *
 * @module dish-workspaces/test/onboard-helpers
 */

import { createHash } from 'node:crypto'
import { access, chmod, lstat, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { format } from 'node:util'
import { after } from 'node:test'
import type { Project } from 'dish-projects/registry'
import { GitHubApp } from '../src/github.ts'
import type { AppCredentials } from '../src/github.ts'
import { tokensDir } from '../src/paths.ts'
import { TokenManager } from '../src/tokens.ts'
import { startFakeGit } from './fake-git-http.ts'
import type { FakeGitServer } from './fake-git-http.ts'
import { startFakeGitHub, testKeys } from './fake-github-api.ts'
import type { FakeGitHub } from './fake-github-api.ts'
import { makeBare, tempDir } from './helpers.ts'

/** dish's credential helper, by its real path (as the service computes it). */
export const HELPER = await realpath(fileURLToPath(new URL('../bin/git-credential-dish', import.meta.url)))

const keys = testKeys()

const managers: TokenManager[] = []

after(async () => {
  await Promise.all(managers.splice(0).map(manager => manager.close()))
})

/** A project as dish-projects parses one, for `acme/widget` unless told otherwise. */
export function project(overrides: Partial<Project> = {}): Project {
  const owner = overrides.owner ?? 'acme'
  const repo = overrides.repo ?? 'widget'
  return {
    name: `${owner}/${repo}`,
    owner,
    repo,
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

export interface World {
  dir: string
  /** The fake git server's repositories: `<root>/<owner>/<repo>.git`. */
  root: string
  /** `acme/widget.git`, with one commit on `main`. */
  bare: string
  git: FakeGitServer
  github: FakeGitHub
  /** The App client, with the test's key (or none, `credentials: false`). */
  app: GitHubApp
  /** `<dir>/state` and `<dir>/work`. */
  state: string
  workRoot: string
  tokens: TokenManager
  /** Every line logged through `logger`, formatted. */
  lines: string[]
  logger: { warn(format: string, ...args: unknown[]): void, info(format: string, ...args: unknown[]): void }
}

export interface WorldOptions {
  /** Files of `acme/widget`'s first commit. */
  files?: Record<string, string>
  /** Whether the App's credentials are set. Default true. */
  credentials?: boolean
  /** Whether `acme` has the App installed (id 77, with widget and gadget). Default true. */
  installed?: boolean
  /** Whether tokens the API mints are taken by the git server. Default true. */
  tokensWork?: boolean
}

/** A fresh fake GitHub (API and git) holding `acme/widget` (and `acme/gadget`), and a token manager over it. */
export async function startWorld(options: WorldOptions = {}): Promise<World> {
  const dir = await tempDir()
  const root = join(dir, 'srv')
  const bare = await makeBare(join(root, 'acme', 'widget.git'), options.files ?? { 'README.md': '# widget\n' })
  await makeBare(join(root, 'acme', 'gadget.git'), { 'README.md': '# gadget\n' })
  const git = await startFakeGit(root)
  after(() => git.close())
  const github = await startFakeGitHub({ publicKey: keys.publicKey })
  if (options.installed !== false) github.installations.set('acme', { id: 77, account: 'Acme', repos: new Set(['widget', 'gadget']) })
  if (options.tokensWork !== false) github.onToken(token => { git.tokens.set(token, 'read') })
  const credentials: AppCredentials | undefined = options.credentials === false
    ? undefined
    : { appId: String(github.app.id), privateKey: keys.privateKeyPem }
  const app = new GitHubApp(async () => credentials, { api: github.api })
  const state = join(dir, 'state')
  const workRoot = join(dir, 'work')
  const lines: string[] = []
  const logger = {
    warn: (fmt: string, ...args: unknown[]) => { lines.push(`warn ${format(fmt, ...args)}`) },
    info: (fmt: string, ...args: unknown[]) => { lines.push(`info ${format(fmt, ...args)}`) },
  }
  const tokens = new TokenManager({ directory: tokensDir(state), app, logger })
  managers.push(tokens)
  return { dir, root, bare, git, github, app, state, workRoot, tokens, lines, logger }
}

/**
 * A recursive listing of `path` (itself included, links not followed): each entry's relative name, type, mode, size,
 * mtime and ctime in nanoseconds, and a file's content hash. Two equal listings mean nothing under `path` was added,
 * removed, written, renamed or chmod'ed in between.
 */
export async function listing(path: string): Promise<string[]> {
  const out: string[] = []
  const visit = async (at: string, name: string): Promise<void> => {
    const stats = await lstat(at, { bigint: true })
    const type = stats.isDirectory() ? 'dir' : stats.isFile() ? 'file' : stats.isSymbolicLink() ? 'link' : 'other'
    const hash = stats.isFile() ? createHash('sha256').update(await readFile(at)).digest('hex') : ''
    out.push(`${name} ${type} ${stats.mode.toString(8)} ${stats.size} ${stats.mtimeNs} ${stats.ctimeNs} ${hash}`)
    if (stats.isDirectory()) {
      for (const child of (await readdir(at)).sort()) await visit(join(at, child), `${name}/${child}`)
    }
  }
  await visit(path, '.')
  return out
}

/** Every regular file under `dir` (recursively, links not followed) whose bytes hold `needle`. */
export async function filesHolding(dir: string, needle: string): Promise<string[]> {
  const found: string[] = []
  let names: string[]
  try {
    names = await readdir(dir, { recursive: true })
  } catch {
    return found
  }
  for (const name of names) {
    const path = join(dir, name)
    if (!(await lstat(path)).isFile()) continue
    if ((await readFile(path)).includes(needle)) found.push(path)
  }
  return found
}

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** The real `git` on PATH (the first that isn't a shim of ours). */
async function realGit(): Promise<string> {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir === '' || dir.includes('dish-git-shim')) continue
    const candidate = join(dir, 'git')
    try {
      await access(candidate)
      return candidate
    } catch {
      // Not here.
    }
  }
  throw new Error('no git on PATH')
}

export interface GitShim {
  /** Put first on PATH (`PATH: shim.path`). */
  path: string
  /** One line per git started: its arguments, space-joined. `ENV-LEAK` after one whose environment held `ghs_`. */
  log: string
  lines(): Promise<string[]>
}

/**
 * A `git` that records its arguments (and whether its environment holds anything `ghs_`, without writing the
 * environment anywhere), then runs the real one. With `holdClone`, a `git … clone …` waits 30 s first, in the process
 * group dish's git started, so a test can abort it.
 */
export async function gitShim(dir: string, options: { holdClone?: boolean } = {}): Promise<GitShim> {
  const bin = join(dir, 'dish-git-shim')
  await mkdir(bin, { recursive: true })
  const log = join(dir, 'git-shim.log')
  await writeFile(log, '')
  const hold = options.holdClone ? `case " $* " in *" clone "*) sleep 30 ;; esac\n` : ''
  const script = [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> '${log}'`,
    `if export -p | grep -q 'ghs_'; then printf 'ENV-LEAK\\n' >> '${log}'; fi`,
    hold,
    `exec '${await realGit()}' "$@"`,
    '',
  ].join('\n')
  await writeFile(join(bin, 'git'), script)
  await chmod(join(bin, 'git'), 0o755)
  return {
    path: `${bin}${delimiter}${process.env.PATH ?? ''}`,
    log,
    lines: async () => (await readFile(log, 'utf8')).split('\n').filter(line => line !== ''),
  }
}
