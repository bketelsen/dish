# Config store and dish-kit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `dish-kit`, the shared library, and `dish-config`, the git-backed versioned config store with proposals, agent tools and a History page. Then move `copilot` onto `dish-kit`.

**Architecture:**
- `dish-config` keeps a bare git repo under `$XDG_CONFIG_HOME/dish/config.git` and drives it only through git plumbing, run with `execFile`.
- A pure `ConfigStore` class does all repository work behind one queue and a process lock.
- A Cordis plugin wraps it as the `dishConfig` service, adds agent tools and a Typert remote, and pushes `main` to GitHub after each commit.
- `dish-kit` holds the helpers `copilot` proved out.

**Tech Stack:** TypeScript (Node 24 type stripping, erasable syntax only), git ≥ 2.40 via `node:child_process`, `node --test`, Cordis, dsh 0.2.0-rc.2, React 18 (client), esbuild (client bundle).

**Spec:** [docs/specs/config-store.md](../specs/config-store.md). Read it before starting; this plan argues from it.

## Global Constraints

- **Node 24, no build step for server code.** `.ts` runs as-is. No `enum`, `namespace` or constructor parameter properties (`tsconfig.json` sets `erasableSyntaxOnly`).
- **Imports from `@deepseek-ai/*`** are type-only, unless the package is declared under both `peerDependencies` and `devDependencies` (version `0.2.0-rc.2`, peer range `^0.2.0-rc.2`; `@deepseek-ai/cordis` `~4.0.4`).
- **No new runtime dependencies.** In particular no git library: shell out to `git`.
- **How every git call runs:**
  - `execFile('git', args, { env })`, never a shell
  - `--git-dir=<repository>` as the first argument
  - `LC_ALL=C` and `GIT_TERMINAL_PROMPT=0` in env
- **Branch and ref names:** `main`; proposals `refs/heads/proposal/<id>`; rejected `refs/dish/rejected/<id>`.
- **Ids:**
  - proposal ids are 8 lowercase hex characters from `crypto.randomBytes(4)`
  - the remote push target is `refs/heads/main` only, never forced
- **Error codes** are exactly: `CONFLICT`, `INVALID`, `UNOWNED`, `FORBIDDEN`, `SECRET`, `TOO_LARGE`, `LOCKED`, `STALE`, `NOT_FOUND`. They are thrown as `ConfigStoreError` with a `.code`.
  - `FORBIDDEN` is new versus the spec's list. It covers an agent writing to a namespace whose `agent` policy disallows it. Add it to the spec's Errors section in Task 7.
- **Size cap** default 262144 bytes per document.
- **Tests and commits:**
  - Tests live in `<package>/test/*.test.ts` and run with the root `pnpm test`.
  - Every task ends with `pnpm typecheck && pnpm test` passing, and one commit.
- **Browser code** goes through the dish-kit build script, and only these modules stay external: `react`, `react/jsx-runtime`, `react-dom`, `react-dom/client`, `@deepseek-ai/cordis`, `@deepseek-ai/dsh-client-store`, `@deepseek-ai/dsh-client-ui-slots`, `@deepseek-ai/dsh-client-ui-primitives`, `@deepseek-ai/dsh-client-ui-dockkit`.

## Review Focus

1. **A UI save and an agent write race on the same path.** Exactly one commit lands. The other gets `CONFLICT`, and nothing is overwritten silently.
2. **The remote is unreachable** (offline, bad key). Saves still succeed. `remoteStatus()` shows the error and pending count, retries back off, and nothing grows without bound.
3. **The process dies mid-write.** `main` never points at a partial commit, and leftover temporary index files are removed on the next start.
4. **Content that contains a token.** It's refused before any git object is written. It can never reach GitHub.
5. **A second dsh process on the same store** gets `LOCKED`, never corruption. A lock left behind by a dead process is taken over.

---

## File Structure

```
pnpm-workspace.yaml              # add packages/*
package.json                     # add "test" script
packages/dish-kit/
  package.json                   # name dish-kit; exports ".", "./client", "./build-client"
  src/index.ts                   # re-exports server helpers
  src/xdg.ts                     # xdgPaths()
  src/terminal.ts                # printOwnLogs()           (moved from copilot)
  src/remote.ts                  # markRemote()             (moved from copilot)
  src/client.ts                  # remoteDescriptor(), jsonCodec, remoteContribution()
  scripts/build-client.mjs       # moved from copilot, parameterized by cwd
  test/xdg.test.ts
  test/remote.test.ts
plugins/copilot/                 # migrated onto dish-kit; cache moves to XDG
plugins/config/
  package.json                   # name dish-config; dsh.bundle + dsh.client
  cordis.patch.yml               # inserts the dish-config row
  tsconfig.client.json
  src/store/errors.ts            # ConfigStoreError, codes
  src/store/git.ts               # Git runner + plumbing helpers
  src/store/lock.ts              # process lock
  src/store/namespaces.ts        # NamespaceRegistry
  src/store/guard.ts             # secret + size checks
  src/store/store.ts             # ConfigStore: open, read, write, seed, history, diff, revert
  src/store/proposals.ts         # propose, list, accept, reject (uses store internals)
  src/store/push.ts              # PushQueue with backoff
  src/protocol.ts                # wire types shared with the client
  src/index.ts                   # Cordis plugin: dishConfig service, events
  src/tools.ts                   # config_read/list/write/propose
  src/remote.ts                  # ConfigRemote (Typert) for the History page
  src/client/index.tsx           # registers settings.section "History"
  src/client/History.tsx         # log, diff, revert, proposals, remote status
  src/client/remote.ts           # hand-written descriptors
  src/client/styles.ts
  test/git.test.ts
  test/lock.test.ts
  test/namespaces-guard.test.ts
  test/store.test.ts
  test/history.test.ts
  test/proposals.test.ts
  test/push.test.ts
  test/tools.test.ts
  test/plugin.test.ts
  test/helpers.ts                # tempRepo(), fixed authors
```

---

### Task 1: Workspace test runner and `dish-kit` skeleton with `xdgPaths`

**Files:**
- Modify: `pnpm-workspace.yaml`, `package.json`, `tsconfig.json`
- Create: `packages/dish-kit/package.json`, `packages/dish-kit/src/index.ts`, `packages/dish-kit/src/xdg.ts`, `packages/dish-kit/test/xdg.test.ts`

**Interfaces:**
- Produces: `xdgPaths(app: string, env?: NodeJS.ProcessEnv, home?: string): { config: string, data: string, state: string, cache: string }`

- [ ] **Step 1: Wire the workspace.**
  - Add `  - packages/*` to `pnpm-workspace.yaml`.
  - Root `package.json` scripts:
    - `"test": "node --test 'packages/*/test/*.test.ts' 'plugins/*/test/*.test.ts'"`
    - `"typecheck"`: keep it, and widen `tsconfig.json` `include` to `["plugins/*/src", "packages/*/src", "packages/*/test", "plugins/*/test"]`
  - `packages/dish-kit/package.json`: `"name": "dish-kit"`, `"private": true`, `"type": "module"`, `"exports": { ".": "./src/index.ts" }`.
- [ ] **Step 2: Write the failing test.** `packages/dish-kit/test/xdg.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { xdgPaths } from '../src/xdg.ts'

test('defaults follow the XDG base directory spec', () => {
  assert.deepEqual(xdgPaths('dish', {}, '/home/u'), {
    config: '/home/u/.config/dish', data: '/home/u/.local/share/dish',
    state: '/home/u/.local/state/dish', cache: '/home/u/.cache/dish',
  })
})

test('absolute XDG variables win; relative ones are ignored per spec', () => {
  const env = { XDG_CONFIG_HOME: '/cfg', XDG_DATA_HOME: 'relative', XDG_STATE_HOME: '/st', XDG_CACHE_HOME: '/c' }
  assert.deepEqual(xdgPaths('dish', env, '/home/u'), {
    config: '/cfg/dish', data: '/home/u/.local/share/dish', state: '/st/dish', cache: '/c/dish',
  })
})
```

- [ ] **Step 3: Run it.** `pnpm test`. Expected: FAIL, cannot find `../src/xdg.ts`.
- [ ] **Step 4: Implement `src/xdg.ts`.**
  - `env` defaults to `process.env`; `home` defaults to `os.homedir()`.
  - A variable counts only if it's set and `path.isAbsolute`.
  - `src/index.ts` re-exports it.
- [ ] **Step 5: Verify.** `pnpm typecheck && pnpm test`. Expected: PASS.
- [ ] **Step 6: Commit.** "Add dish-kit with XDG paths and workspace test runner"

### Task 2: Move shared helpers into `dish-kit`

**Files:**
- Create: `packages/dish-kit/src/terminal.ts`, `src/remote.ts`, `src/client.ts`, `scripts/build-client.mjs`, `test/remote.test.ts`
- Modify: `packages/dish-kit/package.json`, `src/index.ts`

**Interfaces:**
- Produces:
  - `printOwnLogs(ctx: Context, name: string): void`
  - `markRemote(target: { prototype: object }, method: string, options?: { mode: 'stream' }): void`
  - `jsonCodec`, a strict pass-through `TypertCodec`
  - `remoteDescriptor(pkg: string, namespace: string, method: string, extra?: Partial<InvocationDescriptor>): InvocationDescriptor`
  - `remoteContribution(pkg: string, descriptors: InvocationDescriptor[]): TypertRemoteContribution`
  - the build script: `node <dish-kit>/scripts/build-client.mjs [--watch]`, run from a plugin directory. It reads that plugin's `package.json` name, builds `src/client/index.tsx` into `lib/client.js`, and uses the externals listed in Global Constraints.

- [ ] **Step 1: Write the failing test.** `test/remote.test.ts` checks that `markRemote` produces the markers the gateway reads:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { markRemote } from '../src/remote.ts'
import { remoteDescriptor, jsonCodec } from '../src/client.ts'

class Sample { ping() { return 1 } async *watch(signal: AbortSignal) { yield signal.aborted } }
markRemote(Sample, 'ping')
markRemote(Sample, 'watch', { mode: 'stream' })

test('markRemote records direct and stream markers on the prototype', () => {
  const marks = remoteMethods(new Sample()).map(m => [m.method, m.mode ?? 'direct'])
  assert.deepEqual(marks, [['ping', 'direct'], ['watch', 'stream']])
})

test('remoteDescriptor fills the source-mode defaults', () => {
  const d = remoteDescriptor('pkg', 'ns', 'ping')
  assert.equal(d.id, 'pkg#ns/ping'); assert.equal(d.service, 'ns'); assert.deepEqual(d.result, { mode: 'src-json' })
  assert.equal(jsonCodec.mode, 'strict'); assert.equal(jsonCodec.create().parse(5), 5)
})
```

- [ ] **Step 2: Run it.** Expected: FAIL (modules missing).
- [ ] **Step 3: Move the code.**
  - **From copilot:**
    - `printOwnLogs` from `plugins/copilot/src/terminal.ts`
    - `markRemote` from `plugins/copilot/src/remote.ts`
    - the descriptor helper from `plugins/copilot/src/client/remote.ts`, generalized to take `pkg` and `namespace`
    - the build script from `plugins/copilot/scripts/build-client.mjs`, changed to read `process.cwd()` for the package
  - **`package.json`:**
    - exports `"./client": "./src/client.ts"` and `"./build-client": "./scripts/build-client.mjs"`
    - `peerDependencies` and `devDependencies` for `@deepseek-ai/cordis` and `@deepseek-ai/dsh-typert-protocol`
    - `devDependencies` `esbuild`
  - `src/client.ts` must import types only, because it's bundled into browsers.
- [ ] **Step 4: Verify.** `pnpm install && pnpm typecheck && pnpm test`. Expected: PASS.
- [ ] **Step 5: Commit.** "Move terminal logging, remote markers and client build into dish-kit"

### Task 3: Migrate `copilot` onto `dish-kit`; move its cache to XDG

**Files:**
- Modify:
  - `plugins/copilot/package.json` (add `"dish-kit": "workspace:*"`; `build` and `dev` call `node ../../packages/dish-kit/scripts/build-client.mjs`)
  - `plugins/copilot/src/index.ts`, `src/catalog.ts`, `src/remote.ts`, `src/client/remote.ts`, `cordis.patch.yml`
- Delete: `plugins/copilot/src/terminal.ts`, `plugins/copilot/scripts/build-client.mjs`
- Create: `plugins/copilot/test/cache.test.ts`

**Interfaces:**
- Consumes: Task 2's exports
- Produces: in `catalog.ts`, `export async function readCache(file: string, legacy?: string): Promise<Cache | undefined>`. It reads `file`, and falls back to `legacy` once when `file` is missing.

- [ ] **Step 1: Write the failing test.** `test/cache.test.ts`:
  - write a legacy cache JSON to a temp dir; `readCache(newPath, legacyPath)` returns it
  - with both present, the new file wins
  - with neither, it returns `undefined`
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Export `readCache` from `catalog.ts` and use it in `apply`.
  - Make `cacheFile` optional in the schema, defaulting in code to `join(xdgPaths('dish').cache, 'copilot-models.json')`. Remove it from `cordis.patch.yml`.
  - Add an optional `legacyCacheFile`. The patch sets it to `!!js dshHomePath('dish-copilot-models.json')` so the old cache is found once.
  - Replace the imports from the moved files.
- [ ] **Step 4: Verify.**
  - `pnpm typecheck && pnpm test && pnpm --filter dish-copilot build`.
  - Restart `pnpm web`. The terminal shows `[dish-copilot-catalog] 28 models available`, `~/.cache/dish/copilot-models.json` exists, and the Models card still renders.
- [ ] **Step 5: Commit.** "Move copilot onto dish-kit; cache moves to XDG cache"

### Task 4: Git runner and plumbing helpers

**Files:**
- Create:
  - `plugins/config/package.json`:
    - name `dish-config`
    - deps `@deepseek-ai/schemastery`, `dish-kit`
    - peers and devs for cordis, dsh-tools, dsh-agent, dsh-typert-protocol, dsh-settings
    - `dsh.bundle` and `dsh.client` (`{ "platform": "web", "inject": ["@deepseek-ai/dsh-api-remotes", "@deepseek-ai/dsh-client-ui-settings"] }`)
    - `exports` `.` and `./client`
  - `src/store/errors.ts`, `src/store/git.ts`, `test/helpers.ts`, `test/git.test.ts`

**Interfaces:**
- Produces:
  - `class ConfigStoreError extends Error { code: ErrorCode }`
  - `class Git`:
    - `constructor(gitDir: string)`
    - `run(args: string[], options?: { input?: string, env?: Record<string,string>, allowFail?: boolean }): Promise<{ code: number, stdout: string, stderr: string }>`
  - Helpers on `Git`:
    - `initBare(branch: 'main'): Promise<void>`
    - `emptyTree(): Promise<string>`
    - `resolve(ref: string): Promise<string | undefined>`
    - `readBlob(commit: string, path: string): Promise<string | undefined>`
    - `listPaths(commit: string, prefix: string): Promise<string[]>`
    - `buildTree(base: string | undefined, changes: Change[]): Promise<string>`: a temporary index under `<gitDir>/dish-index-<random>`, always deleted
    - `commitTree(tree: string, parents: string[], message: string, author: GitIdentity): Promise<string>`
    - `casRef(ref: string, next: string, expected: string | null): Promise<boolean>`: `null` means the ref must not exist
    - `changedPaths(from: string, to: string, paths?: string[]): Promise<string[]>`
  - `test/helpers.ts`: `tempDir(): Promise<string>`, `USER = { name: 'Test User', email: 'user@test' }`

- [ ] **Step 1: Write the failing test.** `test/git.test.ts` covers:
  1. `initBare` creates a repo, `emptyTree` returns `4b825dc642cb6eb9a060e54bf8d69288fbee4904`, and `resolve('refs/heads/main')` is `undefined` before the first commit.
  2. `buildTree(undefined, [{path:'a/b.md', text:'x'}])`, then `commitTree`, then `casRef(main, c, null)` returns true, and `readBlob(c,'a/b.md') === 'x'`.
  3. `casRef(main, c2, wrongOld)` returns false and leaves `main` unchanged.
  4. `buildTree(c, [{path:'a/b.md', delete:true}])` removes the file, and `listPaths` no longer returns it.
  5. `changedPaths(c1, c2)` returns exactly the changed paths, and `changedPaths(c1, c2, ['other'])` returns `[]`.
  6. No `dish-index-*` files remain in the git dir afterward.
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement `git.ts`.**

  The commands:

  | Operation | Command |
  |---|---|
  | init | `git init --bare -b main <dir>` |
  | empty tree | `git mktree` with empty stdin |
  | blob | `git hash-object -w --stdin` |
  | stage | `git update-index --add --cacheinfo 100644,<blob>,<path>` |
  | delete | `git update-index --force-remove -- <path>` |
  | seed index | `git read-tree <base>` (or `--empty`) |
  | tree | `git write-tree` |
  | commit | `git commit-tree <tree> [-p <parent>]...` with the message on stdin and `GIT_AUTHOR_*`/`GIT_COMMITTER_*` env |
  | compare-and-swap | `git update-ref <ref> <new> <old or 40 zeros>` (exit ≠ 0 → false) |
  | read | `git cat-file -e` then `git cat-file blob <commit>:<path>` |
  | list | `git ls-tree -r --name-only <commit> -- <prefix>` |
  | changed paths | `git diff-tree -r --name-only --no-commit-id <a> <b> [-- paths]` |

  Throw `ConfigStoreError('NOT_FOUND')` for unknown commits.
- [ ] **Step 4: Verify.** `pnpm install && pnpm typecheck && pnpm test`. Expected: PASS.
- [ ] **Step 5: Commit.** "dish-config: git runner and plumbing"

### Task 5: Process lock and serial queue

**Files:**
- Create: `src/store/lock.ts`, `test/lock.test.ts`

**Interfaces:**
- Produces:
  - `acquireLock(gitDir: string, pid?: number): Promise<() => Promise<void>>`
    - `<gitDir>/dish.lock` holds the pid, created with `open(..., 'wx')`.
    - An existing lock whose pid is alive (`process.kill(pid, 0)`) throws `LOCKED`. A dead pid is taken over.
    - The returned function releases the lock.
  - `class SerialQueue { run<T>(task: () => Promise<T>): Promise<T> }`: runs tasks strictly in order, and a failure doesn't block later tasks.

- [ ] **Step 1: Write the failing test.**
  - A second `acquireLock` with the live current pid throws code `LOCKED`.
  - A lock file containing pid `999999` (not running) is taken over.
  - After release, the lock can be acquired again.
  - `SerialQueue` runs `[slow(30ms), fast]` and the results finish in submission order.
  - A rejecting task doesn't prevent the next one.
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify.** PASS.
- [ ] **Step 5: Commit.** "dish-config: process lock and serial queue"

### Task 6: Namespace registry and content guard

**Files:**
- Create: `src/store/namespaces.ts`, `src/store/guard.ts`, `test/namespaces-guard.test.ts`

**Interfaces:**
- Produces:
  - `interface NamespaceSpec { prefix: string, owner: string, validate(path: string, text: string): string | undefined, agent: 'write' | 'propose' | 'none' }`
  - `class NamespaceRegistry`:
    - `claim(spec): () => void`
    - `ownerOf(path): NamespaceSpec | undefined`
    - `all(): NamespaceSpec[]`
  - `checkContent(path: string, text: string, maxBytes: number): void`, which throws `SECRET` or `TOO_LARGE`

- [ ] **Step 1: Write the failing test.**
  - **Overlap is refused:** with `prompts/` claimed, both `prompts/x/` and `prompts/` throw.
  - **Ownership:**
    - with `crew.yaml` claimed, `ownerOf('crew.yaml')` matches and `ownerOf('crew.yaml.bak')` doesn't
    - `ownerOf('prompts/coder.md')` matches `prompts/`
    - releasing a claim makes the path unowned
  - **The guard refuses:**
    - `ghp_` followed by 36 alphanumerics
    - `gho_…`
    - `sk-` followed by 32+ chars
    - `-----BEGIN OPENSSH PRIVATE KEY-----`
    - `AKIA` followed by 16 uppercase/digits
    - a 262145-byte string (`TOO_LARGE`)
  - **The guard allows** prose mentioning "a GitHub token" with no token.
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - A prefix ending in `/` matches the subtree; otherwise it's an exact path.
  - Two specs overlap if either matches the other's prefix.
  - Patterns: `/\bgh[pousr]_[A-Za-z0-9]{36,}\b/`, `/\bsk-[A-Za-z0-9_-]{32,}/`, `/-----BEGIN [A-Z ]*PRIVATE KEY-----/`, `/\bAKIA[0-9A-Z]{16}\b/`.
  - Size is measured with `Buffer.byteLength`.
- [ ] **Step 4: Verify.** PASS.
- [ ] **Step 5: Commit.** "dish-config: namespaces and content guard"

### Task 7: `ConfigStore` core: open, read, write, seed

**Files:**
- Create: `src/store/store.ts`, `test/store.test.ts`
- Modify: `docs/specs/config-store.md` (add `FORBIDDEN` to Errors)

**Interfaces:**
- Consumes: Tasks 4–6
- Produces:
  - `type Author = { kind: 'user' } | { kind: 'agent', sessionId: string, role?: string }`
  - `interface CommitInfo { id: string, time: number, author: Author, message: string, note?: string, paths: string[] }`
  - `class ConfigStore`:
    - `static open(options: { repository: string, namespaces: NamespaceRegistry, user: GitIdentity, agent: GitIdentity, maxBytes?: number, onCommit?: (info: CommitInfo) => void }): Promise<ConfigStore>`: acquires the lock, inits if missing (one root commit: "Initialize dish config"), and removes stale `dish-index-*` files
    - `close(): Promise<void>`
    - `head(): Promise<string>`
    - `read(path, ref = 'main')`, `list(prefix, ref = 'main')`
    - `write(changes: Change[], meta: { author: Author, note?: string, base?: string }): Promise<CommitInfo>`
    - `seed(defaults: Record<string,string>, owner: string): Promise<CommitInfo | undefined>`

  Commit messages use the subject `<paths joined by ", ">: <"edited in web UI" | "edited by <role> agent" | note>`, then a blank line, then trailers `Dish-Author-Kind: user|agent`, `Dish-Session: <id>` (agent only), `Dish-Role: <role>` (agent only) and `Dish-Note: <note>` (if any). The git author is `user` or `agent` according to the author kind.

- [ ] **Step 1: Write the failing test.** `test/store.test.ts`. Key cases:

```ts
test('write commits atomically and read sees it', async () => {
  const s = await openStore({ claims: [ns('prompts/')] })
  const c = await s.write([{ path: 'prompts/a.md', text: 'A' }, { path: 'prompts/b.md', text: 'B' }], { author: USERA })
  assert.deepEqual(c.paths.sort(), ['prompts/a.md', 'prompts/b.md'])
  assert.equal(await s.read('prompts/b.md'), 'B')
})

test('base: same path changed since base -> CONFLICT; other path -> ok', async () => {
  const s = await openStore({ claims: [ns('prompts/')] })
  const base = (await s.write([{ path: 'prompts/a.md', text: '1' }], { author: USERA })).id
  await s.write([{ path: 'prompts/a.md', text: '2' }], { author: USERA })
  await assert.rejects(s.write([{ path: 'prompts/a.md', text: '3' }], { author: USERA, base }), { code: 'CONFLICT' })
  await s.write([{ path: 'prompts/b.md', text: 'x' }], { author: USERA, base })   // different path: allowed
  assert.equal(await s.read('prompts/a.md'), '2')
})

test('concurrent writes to the same path with the same base: exactly one wins', async () => {
  const s = await openStore({ claims: [ns('prompts/')] }); const base = await s.head()
  const results = await Promise.allSettled([1, 2].map(n =>
    s.write([{ path: 'prompts/a.md', text: String(n) }], { author: USERA, base })))
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal(results.filter(r => r.status === 'rejected' && (r.reason as any).code === 'CONFLICT').length, 1)
})
```

  Also cover:
  - unowned path → `UNOWNED`
  - `validate` returning a message → `INVALID` carrying it
  - an agent writing a namespace with `agent: 'propose'` → `FORBIDDEN`
  - a secret → `SECRET`, with **no new objects** written (`git count-objects -v` unchanged)
  - `seed` writes only missing documents and is a no-op the second time (returns `undefined`)
  - `onCommit` fires once per commit
  - a second `ConfigStore.open` on the same repository → `LOCKED`
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement.** All work runs inside `SerialQueue`. Writes run in this order:
  1. ownership and agent policy
  2. validation
  3. content guard (before any `hash-object`)
  4. if `base` is given, refuse when `changedPaths(base, head, paths)` is non-empty
  5. build from head, commit, and `casRef(main, new, head)`. On a false compare-and-swap, re-read head and retry once. Head can only move through this queue in one process, so a second failure means outside interference: throw `CONFLICT`.
- [ ] **Step 4: Verify.** PASS. Update the spec's Errors section with `FORBIDDEN`.
- [ ] **Step 5: Commit.** "dish-config: store core with optimistic concurrency"

### Task 8: History, diff, revert

**Files:**
- Modify: `src/store/store.ts`
- Create: `test/history.test.ts`

**Interfaces:**
- Produces on `ConfigStore`:
  - `history({ path?, prefix?, limit = 50, before? }): Promise<CommitInfo[]>`, newest first
  - `diff(from: string, to: string, path?: string): Promise<FileDiff[]>`, where `FileDiff = { path: string, status: 'added' | 'modified' | 'deleted', patch: string }`
  - `revert(commit: string, meta: { author: Author, note?: string }): Promise<CommitInfo>`

- [ ] **Step 1: Write the failing test.**
  - Three commits to different paths: `history()` lists them newest first with their authors and paths parsed from the trailers, and `history({ path })` filters.
  - `diff` reports added, modified and deleted statuses, and each patch contains the changed line.
  - Reverting a modification restores the previous text. Reverting an addition deletes the file.
  - Reverting a commit whose path has changed since → `CONFLICT`.
  - The revert's subject starts with `Revert ` and names the reverted commit's short id.
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **History:** `git log --format=%H%x1f%at%x1f%B%x1e <ref> [-- <path or prefix>]`, plus `changedPaths(parent, c)` per commit (the root commit diffs against the empty tree). Trailers are parsed from lines matching `^Dish-[A-Za-z-]+: `.
  - **Diff:** `git diff <from> <to> [-- path]`, split on `^diff --git`.
  - **Revert:** read each changed path at the parent, then `write(changes, { ...meta, base: commit })`.
- [ ] **Step 4: Verify.** PASS.
- [ ] **Step 5: Commit.** "dish-config: history, diff and revert"

### Task 9: Proposals

**Files:**
- Create: `src/store/proposals.ts`, `test/proposals.test.ts`
- Modify: `src/store/store.ts` (expose the internals proposals need through a package-internal interface)

**Interfaces:**
- Produces on `ConfigStore`:
  - `propose(changes: Change[], meta: { author: Author, title: string, rationale: string }): Promise<ProposalInfo>`
  - `proposals(status?: 'open' | 'stale' | 'rejected'): Promise<ProposalInfo[]>`
  - `accept(id: string, meta: { author: Author }): Promise<CommitInfo>`
  - `reject(id: string, reason: string, meta: { author: Author }): Promise<void>`
- `ProposalInfo = { id, title, rationale, author: Author, created: number, base: string, tip: string, paths: string[], status: 'open' | 'stale' | 'rejected', reason?: string }`
- The constructor takes `onProposal?: (id: string, status: 'open' | 'stale' | 'accepted' | 'rejected') => void`.

- [ ] **Step 1: Write the failing test.**
  - `propose` creates `refs/heads/proposal/<8 hex>` and leaves `main` unchanged. `proposals('open')` returns the proposal with the right paths.
  - `accept` on an unchanged base: `main` gets the proposal's content, the proposal ref is gone, and the commit message contains `Accept proposal <id>`.
  - After the user edits a proposed path, `proposals()` reports the proposal `stale`. `accept` → `STALE` and `onProposal(id, 'stale')`.
  - When the user edits a *different* path, the proposal is still `open` and accepts cleanly.
  - `reject`: the ref moves to `refs/dish/rejected/<id>`, and `proposals('rejected')` includes it with its `reason`.
  - Proposing to a namespace with `agent: 'none'` as an agent → `FORBIDDEN`. The content guard applies.
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The proposal commit's parent is the base, and its tree is the base plus the changes.
  - Its message is the title, a blank line, the rationale, and trailers `Dish-Proposal: <id>`, `Dish-Base: <base>` plus the author trailers.
  - Status is computed from `changedPaths(base, head, paths)`: non-empty means stale. It isn't stored.
  - Accept writes the tip's versions of `paths` with `base` set to the proposal base, then deletes the ref with `update-ref -d <ref> <tip>`.
  - Reject commits on top of the tip with `Rejected: <reason>` and `Dish-Rejected: <reason>`, moves the ref to `refs/dish/rejected/<id>`, and deletes the head ref.
- [ ] **Step 4: Verify.** PASS.
- [ ] **Step 5: Commit.** "dish-config: proposal branches with stale detection"

### Task 10: Remote push and clone-on-start

**Files:**
- Create: `src/store/push.ts`, `test/push.test.ts`
- Modify: `src/store/store.ts` (the `remote` option, and `open` clones from the remote when the local repo is missing)

**Interfaces:**
- Produces:
  - `class PushQueue`:
    - `constructor(git: Git, remote: string, options?: { delays?: number[] })`. Default delays: 1s, 5s, 30s, 120s, 600s, repeating the last.
    - `schedule(): void`
    - `status(): RemoteStatus`
    - `close(): void`
  - `RemoteStatus = { remote?: string, pushed?: string, pending: number, lastError?: string, lastAttempt?: number }`
  - `ConfigStore.open` takes `remote?: string`.
  - `ConfigStore.remoteStatus(): RemoteStatus`

- [ ] **Step 1: Write the failing test.** Use a local bare repo as the remote.
  - After a write and `await pushed()` (a test helper that polls `status()` until `pending === 0`), the remote's `refs/heads/main` equals local head.
  - With the remote set to a nonexistent path, writes still succeed, `status().lastError` is set, and pending is ≥ 1. Pointing the queue at a valid remote again (a test-only setter) and calling `schedule()` drains it.
  - **Clone-on-start:** open store A with remote R, write, push. Delete A's directory. Opening at the same path clones from R, and the write is present.
  - **Empty remote:** opening with an empty bare R inits locally and pushes the root commit.
  - Tests pass `delays: [10, 10]` for speed.
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **Push:** `git push <remote> refs/heads/main:refs/heads/main`, never forced.
  - **Pending count:** `git rev-list --count <pushed>..main`, or the total commit count before the first push.
  - **Remote has history?** `git ls-remote <remote> refs/heads/main`.
  - **Clone:** `git clone --bare <remote> <repository>`.
  - The store's `onCommit` calls `schedule()`.
- [ ] **Step 4: Verify.** PASS.
- [ ] **Step 5: Commit.** "dish-config: push on commit and clone on start"

### Task 11: Cordis plugin and the `dishConfig` service

**Files:**
- Create: `src/index.ts`, `cordis.patch.yml`, `test/plugin.test.ts`

**Interfaces:**
- Consumes: Tasks 4–10
- Produces:
  - **Service `dishConfig`:**
    - `claim(spec)`
    - `read`, `list`, `head`, `write`, `seed`
    - `history`, `diff`, `revert`
    - `propose`, `proposals`, `accept`, `reject`
    - `remoteStatus`
  - **Cordis events:**
    - `'dish-config/changed'(paths: string[], commit: string, author: Author)`
    - `'dish-config/proposal'(id: string, status: string)`
  - Declared through `declare module '@deepseek-ai/cordis'`.
  - **Config:**
    - `repository`: default `join(xdgPaths('dish').config, 'config.git')`
    - `remote?`
    - `userName` / `userEmail`: default from `git config --global user.name/user.email`, falling back to `dish`
    - `agentName`: default `dish agent`
    - `agentEmail`: default `agent@dish.local`
    - `maxBytes`: default 262144
    - `terminal`: default true
  - The plugin claims and seeds `README.md` (`agent: 'none'`). It explains the repo and that it's managed by dish-config.

- [ ] **Step 1: Write the failing test.** `test/plugin.test.ts`:
  - `const ctx = new Context(); ctx.plugin(dishConfig, { repository: tmp })`, then await `ctx.dishConfig`.
  - Claiming `t/` and writing emits `dish-config/changed` with the path.
  - The README is seeded once.
  - Disposing the plugin releases the lock, so a second plugin instance on the same repository then succeeds.
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `apply` is async: open the store, then `ctx.provide('dishConfig', service)`.
  - Use `ctx.effect` for close, which flushes nothing and releases the lock.
  - `cordis.patch.yml` inserts the row `id: dish-config, name: dish-config`, plus `config.remote: git@github.com:bketelsen/dish-config.git`.
- [ ] **Step 4: Verify.** PASS.
- [ ] **Step 5: Commit.** "dish-config: Cordis plugin and dishConfig service"

### Task 12: Agent tools

**Files:**
- Create: `src/tools.ts`, `test/tools.test.ts`
- Modify: `src/index.ts` (register the tools; `inject` adds `tools`, as an optional child `ctx.inject(['tools'], …)` so the store works without it)

**Interfaces:**
- Produces:
  - `config_read({ path })` → `{ path, text | null, commit }`
  - `config_list({ prefix })` → `{ paths }`
  - `config_write({ changes: [{ path, text?, delete? }], note })` → `{ commit, paths }`
  - `config_propose({ title, rationale, changes })` → `{ proposal, paths }`
  - Export `toolDefinitions(service)` for tests.

- [ ] **Step 1: Write the failing test.** Call each definition's `execute(args, exec)` with fake `exec.agent` objects: `{ id, session: { header: { id, delegationDepth } } }`.
  - **Writes:**
    - `config_write` by a top-level agent commits, authored `{ kind: 'agent', sessionId, role: 'main' }`
    - a child (`delegationDepth: 1`) is refused for every tool, with a message saying config is main-agent only
    - in a `propose` namespace, `config_write` → `FORBIDDEN` and `config_propose` succeeds
  - **Reads:** `config_read` on a `none` namespace → `FORBIDDEN`
  - Empty-string optional fields count as absent.
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement** with `defineTool`. Output schemas use per-property `required: true`, never a `required` array (dsh's value-schema DSL).
  - The descriptions state the policy: `config_write` only for a change the user asked for in this conversation, `config_propose` for anything you initiate.
- [ ] **Step 4: Verify.** PASS.
- [ ] **Step 5: Commit.** "dish-config: agent tools with main-agent-only policy"

### Task 13: Remote service for the History page

**Files:**
- Create: `src/protocol.ts`, `src/remote.ts`
- Modify: `src/index.ts` (`ctx.plugin(ConfigRemote)`)
- Test: extend `test/plugin.test.ts`

**Interfaces:**
- Produces `ConfigRemote extends TypertRemoteService`, service key `dishConfigRemote`, namespace `dishConfig`. Methods are marked with `markRemote`, and the user author is used for UI actions.

  | Method | Returns |
  |---|---|
  | `history(path, limit)` | `CommitInfo[]` |
  | `commit(id)` | `{ info: CommitInfo, diffs: FileDiff[] }` |
  | `revert(id)` | `CommitInfo` |
  | `proposals(status)` | `ProposalInfo[]` |
  | `proposal(id)` | `{ info, diffs }`, with diffs against current `main` |
  | `accept(id)` | `CommitInfo` |
  | `reject(id, reason)` | `void` |
  | `remoteStatus()` | `RemoteStatus` |
  | `watch(signal)` (stream) | yields `{ kind: 'changed', commit } \| { kind: 'proposal', id, status } \| { kind: 'remote', status }` |

  All parameters are plain JSON and the result mode is `src-json`.

- [ ] **Step 1: Write the failing test.** On a `ConfigRemote` instance in a Cordis context:
  - `history` returns the README seed commit
  - `revert` creates a commit authored as the user
  - `watch` yields `changed` after a write, and stops when its signal aborts
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement.** `watch` follows `CopilotRemote.signIn`'s queue pattern, subscribed to the store's two events and to push-status changes.
- [ ] **Step 4: Verify.** PASS.
- [ ] **Step 5: Commit.** "dish-config: Typert remote for the History page"

### Task 14: History page

**Files:**
- Create: `src/client/index.tsx`, `src/client/History.tsx`, `src/client/remote.ts`, `src/client/styles.ts`, `tsconfig.client.json`
- Modify: `package.json` (`build`, `dev`, `typecheck` scripts; `exports["./client"] = "./lib/client.js"`)

**Interfaces:**
- Consumes:
  - Task 13's methods, through descriptors built with `dish-kit/client` (`jsonCodec` for every parameter)
  - `settings.section` registration: `ctx.slots.register({ name: 'settings.section', id: 'dish-history', order: 50, label: () => 'History', inject: () => face }, History)`. Check the exact option shape in the installed `@deepseek-ai/dsh-client-ui-settings` types before writing it.
- Produces: the client plugin, with `inject = ['remote', 'slots']`, which mounts the contribution as `copilot` does.

- [ ] **Step 1: Build the page.** Three views on one page (log, commit, proposals), plus a remote-status line.
  - **Log:** a namespace filter (`all` plus a prefix input), with rows showing author (`You` or `<role> agent`), relative time, paths, and the note or subject.
  - **Commit:** a per-file unified diff in a `<pre>` with +/- line classes, and **Revert this commit** with confirmation.
  - **Proposals:** open and stale ones first, with title, rationale and author, a diff against `main`, **Accept** (disabled when stale, with "stale — the agent will rebuild it"), and **Reject** with a reason input.
  - **Remote status:** `Pushed <short id> · <n> pending · <error>`.
  - **Live updates:** the plugin consumes `watch` through `ctx.remote.$stream`, which reconnects, and refreshes the open view.
  - Style with `--dsw-alias-*` tokens only. It must work at phone width.
- [ ] **Step 2: Verify the build.** `pnpm typecheck && pnpm --filter dish-config build`. Expected: `lib/client.js` exists, and its only `require()`s are platform externals.
- [ ] **Step 3: Commit.** "dish-config: History page"

### Task 15: Install, push to GitHub, verify end to end

**Files:**
- Modify: `README.md` (plugin table), `ROADMAP.md` (step 2 done)
- Create: `plugins/config/README.md`

- [ ] **Step 1: Install.** `pnpm dsh plugin --profile web add ./plugins/config`, then restart `pnpm web`.
  - Expected terminal output: `[dish-config] store ready at ~/.config/dish/config.git`, then `pushed <id>`.
- [ ] **Step 2: Check GitHub.** `gh api repos/bketelsen/dish-config/commits --jq '.[].commit.message' | head`. Expected: the root commit and the README seed.
- [ ] **Step 3: Check the History page.** Settings → History lists both commits, the README commit's diff renders, and the remote line shows `0 pending`.
- [ ] **Step 4: Test agent tools in a web session** (the main agent is at depth 0).
  1. Ask: "Use config_list on README.md". Expected: it lists it.
  2. Ask it to `config_write` to `README.md`. Expected: `FORBIDDEN`, since the README namespace is `none`.
  3. The proposal flow is exercised by unit tests here. It's exercised live when `prompts` lands, as `prompts/` will be the first agent-writable namespace.
- [ ] **Step 5: Docs.** The plugin README covers setup (the remote and an SSH key on the VM), namespaces, agent policy, the History page, and error codes. Mark roadmap step 2 done.
- [ ] **Step 6: Commit.** "dish-config: install, docs, roadmap"
