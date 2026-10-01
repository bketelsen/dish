# Spec: config store (`dish-config`) and `dish-kit`

Status: implemented 2026-10-01 (branch `config-store`); drafted 2026-09-30. Implements roadmap step 2. Builds on the [design](../design.md) (configuration and runtime data kept apart; XDG locations; everything you author is versioned).

## Summary

`dish-config` is the one place dish keeps configuration you author: role prompts, crew roles, families and direction. It's a **git repository** that the store operates on directly.
- Every save is a commit, and every commit is pushed to a private GitHub repo.
- Agents change config either by committing directly (when you asked for the change) or by opening a **proposal branch** that you accept or reject.
- Plugins never touch files or git. Each claims a **namespace**, a path prefix with its own validation, and goes through the `dishConfig` service.

`dish-kit` is the library every dish plugin shares: XDG paths, terminal logging, the client build script, and remote helpers.

## Decisions (from the 2026-09-30 discussion)

| Topic | Decision |
|---|---|
| Who edits | The web UI and the main agent. No hand edits to files. |
| Agent edits | **Direct commit** when you asked for the change in the conversation. **Proposal branch** when the agent initiates the change itself. |
| Proposals | Git branches `proposal/<id>`, accepted (merged) or rejected from the inbox or the History page. |
| Stale proposals | Marked stale, never conflict-resolved by you. The agent rebuilds the proposal on current `main`. |
| When changes apply | Readers read at use, so an agent started after a commit sees it. Running agents keep what they started with. |
| Backup | Push to a private GitHub repo after every commit. |
| Repos | Config in `bketelsen/dish-config` (private). The memory vault gets its own repo later (`dish-vault`). |
| Review UI | One generic **History** page in the store. Plugins ship their own editors. |
| Boundary | dsh's `cordis.patch.yml` holds plumbing: which plugins load, ports, model routes. `dish-config` holds what you author. |

## Non-goals

- **Secrets.** Never stored. Credentials stay in dsh's credential store. Writes that look like they contain a credential are refused (see Safety).
- **Merge-conflict resolution UI.** Conflicts become "stale"; see Proposals.
- **Runtime data.** Ledgers, initiative status and inboxes live under the XDG data and state directories, owned by their plugins.
- **Multi-writer hosts.** One dsh process owns the store. A second process gets a clear lock error.

## Storage

| What | Default | Override |
|---|---|---|
| Repository (bare) | `$XDG_CONFIG_HOME/dish/config.git` (normally `~/.config/dish/config.git`) | `dish-config` row config `repository` |
| Lock | `<repository>/dish.lock` | — |
| Remote | none until configured | `remote`, e.g. `git@github.com:bketelsen/dish-config.git` |

**Why bare.** With no hand edits, a working tree only creates hazards: a half-written checkout, branch switches racing UI saves. Every operation instead uses git plumbing:
- **Read:** `cat-file`, `ls-tree`.
- **Write:** a temporary index, `write-tree`, `commit-tree`, then `update-ref` with the expected old value.

Each write is atomic, and a commit lands only if `main` is still where the writer saw it. To browse files, view the GitHub repo or clone it.

**First start.**
- If the repository is missing and a remote is configured, the store asks the remote for its `main` (`ls-remote`). If there is one, it is fetched into a temporary bare repository in a `dish-restore-<hex>` directory inside the repository directory (so the same filesystem and under the store's lock), SHA-1 with loose refs whatever the user's git config says, `main` only, no remote recorded in it. It is checked, and its entries are then moved up into place and the directory removed. A crashed restore's leftover directory is removed on the next start. That's how a rebuilt VM gets its config back.
- A remote that can't be reached is an error (plain, with git's first line), and nothing is created: starting a new history would diverge from the real one later.
- If the remote is reachable but has no `main`, or none is configured, the store runs `git init --bare -b main` and makes an empty root commit. With a remote, the root commit is pushed as soon as the store opens.
- A repository that already exists never contacts the remote while opening. A directory that holds objects or refs but isn't a repository is refused, never replaced.

## Model

- **Document**: a UTF-8 text file at a repo path, e.g. `prompts/coder.md` or `crew.yaml`. The store doesn't parse documents; their owners do.
- **Namespace**: a path prefix a plugin claims, with its rules:
  ```ts
  interface NamespaceSpec {
    prefix: string                       // 'prompts/', 'crew.yaml', 'families/'
    owner: string                        // plugin name, for errors and the History page
    validate(path: string, text: string): string | undefined   // error message, or undefined if valid
    agent: 'write' | 'propose' | 'none'  // the most an agent may do here (see Agent tools)
  }
  ```
  - Two namespaces may not overlap.
  - Writing a path that no claimed namespace owns is refused.
  - Releasing a claim (the plugin unloads) leaves its files untouched.
- **Commit**: one atomic change to one or more documents, carrying:
  - an author: `{ kind: 'user' }`, `{ kind: 'agent', sessionId, role }`, or `{ kind: 'system' }` for the store's own commits (the root commit and `seed`); git records `user` as the user identity, and `agent` and `system` as the agent identity
  - a message, generated as `<paths>: <summary>` plus an optional note; the subject names the first 3 paths, then "and N more"
  - trailers: `Dish-Author-Kind`, `Dish-Session` and `Dish-Role` (agent only), `Dish-Note` (when there's a note), and `Dish-Revert` (a revert: the full id of the commit it undoes; its subject is `Revert <short id>: <paths>`)
  - `history` reads the author and note back from git's own trailer block only; a commit with anything else there (or no `Dish-Author-Kind`) is the `system`'s
- **Proposal**: a branch `refs/heads/proposal/<id>` (8 hex characters) holding one commit, whose parent is the `main` commit it was based on and whose tree is that commit's plus the changes. The commit message carries everything: the title, the rationale, and the trailers `Dish-Proposal` (the id), `Dish-Base` and the author's. Status (open, stale) is computed, never stored.

## Service: `dishConfig`

Provided by the `dish-config` plugin. The shape below is the contract; names may be refined in the implementation plan.

```ts
interface DishConfig {
  claim(spec: NamespaceSpec): () => void               // effect-scoped; returns a disposer

  read(path: string, ref?: string): Promise<string | undefined>        // ref: "main" (default) or a full commit id; anything else is NOT_FOUND
  list(prefix: string, ref?: string): Promise<string[]>
  head(): Promise<string>                               // current main commit id

  /** Atomic multi-document commit to main. Resolves `undefined`, with no commit, when the changes leave main as it is. */
  write(changes: Change[], meta: WriteMeta): Promise<CommitInfo | undefined>
  /** One-time defaults: writes only documents that don't exist yet. */
  seed(defaults: Record<string, string>, owner: string): Promise<CommitInfo | undefined>
  /** New commit restoring what `commit` (a full id on main) changed, via `write` with `base: commit`. `undefined`, with no commit, when nothing is left to restore. The first commit is INVALID. */
  revert(commit: string, meta: Omit<WriteMeta, 'base'>): Promise<CommitInfo | undefined>

  /** Newest first. `limit` is 1 to 500 (default 50). `before`: a full id on main; the list starts just below it. `path` and `prefix` are exclusive. */
  history(options?: { path?: string, prefix?: string, limit?: number, before?: string }): Promise<CommitInfo[]>
  /** `from` and `to`: "main", a full commit id, or the empty tree. Runs no external diff program. */
  diff(from: string, to: string, path?: string): Promise<FileDiff[]>
  /** One commit with its diff against its parent (the empty tree for the first commit). */
  commit(id: string): Promise<{ info: CommitInfo, diffs: FileDiff[] }>

  propose(changes: Change[], meta: { author: Author, title: string, rationale: string }): Promise<ProposalInfo>
  proposals(status?: ProposalStatus): Promise<ProposalInfo[]>      // newest first; all statuses when omitted
  accept(id: string, meta: { author: Author }): Promise<CommitInfo | undefined>   // apply to main; `undefined` when main already holds the content
  reject(id: string, reason: string, meta: { author: Author }): Promise<void>

  remoteStatus(): Promise<RemoteStatus>                 // last pushed commit, pending, last error; `{ pending: 0 }` with no remote
}

type Change = { path: string, text: string } | { path: string, delete: true }
interface WriteMeta {
  author: Author                 // a user or agent author; system is store-internal and refused here
  note?: string
  /** Optimistic concurrency: the full 40-hex id of the main commit the editor loaded. Not a commit: NOT_FOUND. */
  base?: string
}
```

**Events** (Cordis):
- `dish-config/changed(paths, commit, author)`: after every commit to `main`.
- `dish-config/proposal(id, status)`: on open, stale, accepted or rejected.

Consumers re-read on these events rather than caching.

### Concurrency

- All repository operations go through one in-process queue, and the `dish.lock` file keeps a second process out.
- **`write` with `base`:**
  - `base` must be the full 40-hex id of a commit; anything else, or an id that isn't in the repository, is `NOT_FOUND`.
  - If a path being written changed on `main` since `base`, the write is refused with `CONFLICT`, and the editor reloads.
  - If only *other* paths changed since `base`, the write goes through, built on current `main`.

  So two editors working on different files never block each other.
- `update-ref` compare-and-swap makes each step atomic even inside the queue.

### Proposals and staleness

- A proposal records its **base** (the `main` commit it started from) and the paths it changes.
- **`propose`** runs the checks of `write`, in the same order, with one difference: an agent needs the namespace's `agent` policy to be `write` or `propose` (a user may propose to any namespace). Then:
  - the **title** is one line (whitespace collapsed, cut to 120 characters) and not empty;
  - the **rationale** may run to many lines, at most 8 KiB, with no control characters but tab and newline, and **no line that starts like a `Dish-` trailer** (it would let a rationale forge the trailers);
  - neither may contain git's "scissors" line (`# ------------------------ >8 ------------------------`), which hides the trailers from git's own reader;
  - neither may look like a secret, and a proposal that leaves the tree as it is is `INVALID`.
  Nothing reaches git before all of that passes.
- **Staleness** is computed from the repository each time, never stored. For each path the proposal changes, compare its document on current `main` with its version at the base and with the proposal's:
  - the same as at the base: still **pending**;
  - the same as the proposal's (the user made the same edit, or deleted what the proposal deletes): already **applied**, no obstacle;
  - anything else is a **conflict**, and one conflict makes the proposal **stale**.
  A path the proposal adds is also a conflict when `main` has a file where it needs a directory, or documents under a path it needs for a file (the proposal's own deletions don't count).
- **`accept`**:
  - **Only a user may accept.** An agent gets `FORBIDDEN`: the proposal is how an agent asks.
  - If the proposal is stale, `dish-config/proposal` fires, `accept` fails with `STALE`, nothing is merged, and the branch is kept.
  - Otherwise the tip's version of each **pending** path is applied to current `main` as one commit (`Accept proposal <id>: <title>`, with `Dish-Proposal` and, for an agent's proposal, `Dish-Proposer-Session` and `Dish-Proposer-Role` trailers), and the branch is then deleted. Ownership, the content guard and the namespace's validator run again, as they are now. The title and the proposer's session and role are scanned for secrets too (`SECRET`, branch kept); the rationale is never copied.
  - If nothing is pending (`main` already holds the content), no commit is made: the branch is deleted and accept returns `undefined`.
- **Rebuilding.** The agent that owns a stale proposal is told why. It rebuilds the proposal from current `main`, as a fresh proposal superseding the old one. You never resolve conflicts.
- **`reject`** takes a reason (one line, at most 200 characters, not empty, no secret). The proposal moves to `refs/dish/rejected/<id>`, on a commit `Rejected: <reason>` that carries the reason as `Dish-Rejected`; the branch is deleted. The record stays in the repository, so the History page and the agent can see why, and `proposals('rejected')` lists it. A user may reject any proposal, stale ones included. **An agent may only withdraw its own session's proposals** (`FORBIDDEN` otherwise).

### Remote

- After each commit to `main`, a push (`main` only) is queued, and one more when the store opens, so the root commit and anything an earlier run left unpushed go out.
- **A push never waits for a person.** It runs with no terminal (a new session, so ssh can't prompt on `/dev/tty`; a host-key or passphrase question fails instead of hanging), no stdin and `GIT_TERMINAL_PROMPT=0`, under a hard time limit (`pushTimeoutMs`, 60 s) that kills git and everything it started. The user's `GIT_SSH*`, `GIT_ASKPASS` and git config are left as they are, so their auth works as it does in a shell, except that the user's `pre-push` hooks are skipped (`--no-verify`): a hook could ask or hang, and the store guards its own content.
- **It never delays a write.** The queue takes no store lock and runs on none of the store's queues. Pushes go one at a time; commits that land while one runs are covered by one more push, not one each.
- **The push is `git push --porcelain <remote> refs/heads/main:refs/heads/main`**, to the URL itself: never forced, no remote or tracking refs in the repository, no local ref locked. The `remote` is checked when the store opens: not empty, no control characters, not starting with `-`, not using `ext::`; and `ext` is switched off for every call.
- Failures retry with backoff (1s, 5s, 30s, 120s, 600s, then every 600s; a success starts over) and show up in `remoteStatus()` and on the History page. A new commit shortens a retry that is waiting longer than the first delay to the first delay, so a save after a long outage is tried within a moment instead of minutes, and never lengthens one; the count of failures is left alone, so if the remote is still dead the wait goes straight back to the long delay. The same goes for a commit that lands while a retry is itself failing. **A failed push never fails the save**, because the local commit is the source of truth.
- **A rejected push** means the remote has commits this store doesn't (another machine pushed). It is never forced: `lastError` says "remote main has commits this store doesn't have; resolve manually", and retries go on.
- `remoteStatus()` is `{ remote, pushed, pending, lastError, lastAttempt }`. `pushed` is the commit last pushed by this process; `pending` is the number of commits after it (all of them until the first success after a start, so after a restart it is an upper bound). `lastError` is git's first line with credentials masked: a password in a URL, or anything that looks like a secret (see Safety), is hidden. A listener (`onRemoteStatus`) hears every change.
- Authentication is the host's git setup (SSH key or credential helper); the store holds none.
- Proposal branches stay local, since they're transient and visible in the UI.
- **Setup is a one-time manual step:**
  ```bash
  gh repo create bketelsen/dish-config --private
  ```
  Then set `remote` on the `dish-config` row.

### Safety

- **Validation.** `write`, `seed` and `propose` run the owning namespace's `validate` on every changed document, and refuse with the owner's message.
- **Secret guard.** Writes are refused when content matches common credential patterns: GitHub tokens (`ghp_`, `gho_`, `ghu_`, `ghs_`), `sk-` keys, private-key PEM headers, AWS access keys. Everything here is pushed to GitHub.
- **Size cap.** 256 KiB per document, configurable.

## Agent tools

Provided by `dish-config` for the **main agent only**. They are registered when a `tools` service is present (the store itself needs none), and each one refuses a caller that isn't the main agent before it does anything else, with `config tools are for the main agent only; ask the main agent to make this change`. That is: no calling agent, a session header whose `delegationDepth` is above zero or whose `origin` is `subagent`, or a runtime `options.subagentDepth` above zero (dsh's own depth rule takes the larger of the header and the runtime value; anything that isn't absent or `0` counts). `crew`'s tool filter is not what this rests on.

| Tool | Does | Returns | Allowed where the namespace's `agent` is |
|---|---|---|---|
| `config_read({ path })` | reads one document from `main` | `{ path, text, commit }`: `text` is `null` for a missing document, and `commit` is the head it was read at | `write` or `propose` |
| `config_list({ prefix })` | lists documents on `main` (`''` for all) | `{ paths, commit }`: only paths an agent may see | `write` or `propose` |
| `config_write({ changes, note?, base? })` | direct commit, authored as the agent | `{ commit, paths }`; `commit` is `null` and `paths` empty when nothing changed | `write` |
| `config_propose({ title, rationale, changes })` | opens a proposal branch | `{ proposal, paths }` | `write` or `propose` |

- `changes` is a list of `{ path, text?, delete? }`, read like this (a malformed one is `INVALID`, refused before the store is called):
  - `delete: true` with no `text`, or with `text: ''`, is a **delete**. Models fill in every field, so a delete often arrives with an empty `text`; reading that as "empty the document" would turn a deletion into a document emptied but kept.
  - `delete: true` with a non-empty `text` is both a write and a delete: `INVALID`, and the message says to send only `delete: true` to delete or only `text` to replace.
  - `text` alone, even `''`, writes that document (an empty one).
  - `delete: false` counts as not deleting, so `{ path }` or `{ path, delete: false }` is neither, and `INVALID`.
- **Author.** Every write and proposal is `{ kind: 'agent', sessionId: <the calling session>, role: 'main' }`.
- **`config_read` returns the head it read from.** The tool takes `head()` and then reads at that exact commit, so `commit` is true of `text` even if something else commits in between.
- **`base`** is optional. When given, it is passed to the store, so a change made since the agent's read (in the UI, say) to a path being written is `CONFLICT`, not an overwrite; a change to other paths is not. The tool descriptions tell the model to pass the `commit` from `config_read`; after reading several documents at different commits, the **oldest** of them; and after a `config_write` of its own, the `commit` that returned. Without `base` a write is unconditional, as for any caller.
- **Read policy lives in the tools.** A `config_read` path that can't be a document path (`/t/a.md`, `t/`, `..` segments, ...) is `INVALID` with the reason, as `write` says it, before anything about owners: the shape of a path says nothing about what exists. Then a path in a namespace whose `agent` is `none` is `FORBIDDEN`, whether or not the document exists, and one no namespace owns is `UNOWNED`. `config_list` leaves out every path whose namespace is `none` or unowned, so `README.md` (people only) never shows. Write and propose policy is the store's (`FORBIDDEN`), not repeated here; for a `none` namespace its message says the namespace "is closed to agents".
- **`config_list` prefixes.** One leading `/` is the root (`/` lists everything, `/t/` is `t/`); a trailing `/` only marks a directory. A prefix that is not `''` and can't be a path (`.`, `..`, `t//`, ...) is `INVALID` rather than an empty list. There are no wildcards: `*` is an ordinary, unmatched name.
- **Empty strings are absent** for `note` and `base`: models fill every optional parameter. A `rationale` is required, but may be empty, as the store allows.
- **Errors.** A refusal by the store reaches the model as an `Error` whose message is `<CODE>: <message>` (`CONFLICT`, `FORBIDDEN`, `SECRET`, ...), so it can act on the code. The store's own messages and the tools' never carry document text (a secret in `text` is `SECRET` without an echo); a namespace's `validate` message is its owner's to keep free of it.
- **Prompting** is in the tool descriptions: use `config_write` only for a change the user asked for in this conversation, and `config_propose` for anything the agent initiates; pass `base` from `config_read`; on `CONFLICT`, read again and redo the change; on a proposal that went `STALE`, read again and open a fresh one.
- **Structural backstop.** Sessions started by `triggers` (unattended) don't get `config_write` at all. This is enforced when `triggers` exists; until then, every session is interactive.
- **Per-namespace defaults** (each set by its owner):
  - `prompts/`: crew prompts `write`, `main` and `common` `propose` (see the [prompts spec](prompts.md))
  - `crew.yaml`: `write`
  - family `direction.md`: `propose`, so even on request the agent proposes and you accept in one click. That's tighter than decision (b), so revisit if it gets in the way.

## Web UI: History page

The `dish-config` plugin's browser half adds **Settings → History**. It's mobile-friendly and also linked from the inbox.

- **Log**: commits on `main`, filterable by namespace or path, each showing author (you or agent role + session link), time, paths and note.
- **Commit view**: per-file diff, plus **Revert this commit**, which creates a new commit.
- **Proposals tab**: open and stale proposals, each showing title, rationale, author session, its diff (what it proposes: from the `main` commit it was made on to its tip), and **Accept** / **Reject** (with a reason).
- **Remote status**: last pushed commit, how many commits are waiting to push, and the last error.

Editors (Prompts, Families, Crew) belong to their own plugins. They read through `dishConfig`, write with `base`, and link to History filtered to their namespace.

The UI talks to the server through a Typert remote: Cordis service `dishConfigRemote`, wire namespace `dishConfig` (`src/remote.ts`; the wire types are in `src/protocol.ts`). Every call is made as the user. Parameters are plain JSON, and `''` means absent.

| Method | Returns |
|---|---|
| `namespaces()` | `NamespaceInfo[]`: `{ prefix, owner, agent }` per claim, for the log's filter. A plain array, not an `Outcome`. |
| `history(prefix, limit, before)` | `Outcome<CommitInfo[]>`. `prefix` ending in `/` filters by prefix, otherwise by path. `limit` of 0 or less is the default 50. `before` is the last id of the previous page. |
| `commit(id)` | `Outcome<{ info, diffs }>` |
| `revert(id)` | `Outcome<CommitInfo \| null>`: `null` when it was already reverted |
| `proposals(status)` | `Outcome<ProposalInfo[]>`: `''` for all, else `open`, `stale` or `rejected` |
| `proposal(id)` | `Outcome<{ info, diffs }>`: the diffs are what was proposed (its base to its tip), not against the current `main`, so a stale proposal doesn't look as if it undoes later edits |
| `accept(id)` | `Outcome<CommitInfo \| null>`: `null` when `main` already had all of it |
| `reject(id, reason)` | `Outcome<null>` |
| `remoteStatus()` | `Outcome<RemoteStatus>` |
| `watch(signal)` (stream) | `ConfigEvent`s: `{ kind: 'changed', commit, paths }`, `{ kind: 'proposal', id, status }`, `{ kind: 'remote', status }`. The first item is always the current remote status, so a page that opens in the middle of an outage shows it. A reader that falls behind keeps the newest 100 `changed`/`proposal` events and the latest `remote` status. |

The store's refusals are results: `Outcome<T>` is `{ ok: true, value } | { ok: false, code, message }`, with the store's error `code` (`CONFLICT`, `STALE`, `NOT_FOUND`, ...) so the page can say what to do. The gateway folds anything a method throws into its own `gateway/internal` code and keeps only the message, which would lose the store's code. A failure that isn't the store's (it is closed, a bug) is still thrown.

## `dish-kit`

A workspace package (`packages/dish-kit`), imported by plugins. It's not a bundle, and it holds no state.

| Export | From | Notes |
|---|---|---|
| `xdgPaths(app)` → `{ config, data, state, cache }` | new | Honors `XDG_*` variables, with the XDG spec defaults otherwise. |
| `printOwnLogs(ctx, name)` | `copilot/src/terminal.ts` | |
| `markRemote(cls, method, options?)` | `copilot/src/remote.ts` | |
| `remoteDescriptor(...)` / `contribution(...)` | `copilot/src/client/remote.ts` | client-side |
| `build-client` script | `copilot/scripts/build-client.mjs` | each plugin's `build` calls it |

Migration in the same step: `copilot` uses `dish-kit`, and its model cache moves from `~/.dsh/dish-copilot-models.json` to `$XDG_CACHE_HOME/dish/copilot-models.json`. It reads the old file once if the new one is missing.

## Errors

The store's stable error codes:
- `CONFLICT`: the path changed since `base`
- `INVALID`: the namespace rejected the document; carries the owner's message
- `UNOWNED`: no namespace claims the path
- `FORBIDDEN`: an agent writing to a namespace whose `agent` policy doesn't allow it (or proposing to one whose policy is `none`); an agent accepting a proposal, or rejecting one from another session
- `SECRET`: a likely credential was found
- `TOO_LARGE`
- `LOCKED`: another process holds the store
- `STALE`: proposal accept refused
- `NOT_FOUND`

Tools return them to the agent verbatim, and the UI shows them inline.

## Testing

`node --test` against real git in temporary directories, with no mocks. Covers:
- init and clone-on-start
- namespace claims and overlap refusal
- validation
- the secret guard
- write with and without `base`, including concurrent writes to different and to same paths
- `seed` idempotence
- revert
- proposal accept (clean) and stale detection
- reject
- push queueing against a local bare "remote", including failure and retry

The UI is checked by hand in the browser, as with the copilot card.

## Open items for the implementation plan

- Proposal ids: short random ids, or slugs from the title.
- The remote's protocol for the VM: SSH deploy key (write access to this repo only) vs a `gh` credential helper. Leaning toward a deploy key.
