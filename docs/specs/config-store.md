# Spec: config store (`dish-config`) and `dish-kit`

Status: draft, 2026-09-30. Implements roadmap step 2. Builds on the [design](../design.md) (configuration and runtime data kept apart; XDG locations; everything you author is versioned).

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
- If the repository is missing and a remote is configured with history, the store does a bare clone of it. That's how a rebuilt VM gets its config back.
- Otherwise it runs `git init --bare -b main` and makes an empty root commit.

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
  - trailers: `Dish-Author-Kind`, `Dish-Session` and `Dish-Role` (agent only), `Dish-Note` (when there's a note)
- **Proposal**: a branch `proposal/<id>` whose commits sit on top of the `main` commit it was based on. Metadata (title, rationale, author session, created, status) is stored in the tip commit's message trailers, so the branch alone carries everything.

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
  revert(commit: string, meta: WriteMeta): Promise<CommitInfo>   // new commit restoring what `commit` changed

  history(options?: { path?: string, prefix?: string, limit?: number, before?: string }): Promise<CommitInfo[]>
  diff(from: string, to: string, path?: string): Promise<FileDiff[]>

  propose(changes: Change[], meta: ProposalMeta): Promise<ProposalInfo>
  proposals(status?: ProposalStatus): Promise<ProposalInfo[]>
  accept(id: string, meta: WriteMeta): Promise<CommitInfo>   // merge into main
  reject(id: string, reason: string): Promise<void>

  remoteStatus(): RemoteStatus                          // last pushed commit, pending, last error
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
- **`accept`**:
  - If each changed path is still identical on `main` to its version at base, the proposal's changes are applied to current `main` as one commit. Its message references the proposal, and the branch is then deleted.
  - Otherwise the proposal is marked **stale** (`dish-config/proposal` fires) and nothing is merged.
- **Rebuilding.** The agent that owns a stale proposal is told why. It rebuilds the proposal from current `main`, as a fresh proposal superseding the old one. You never resolve conflicts.
- **`reject`** records the reason in the branch's metadata and deletes the branch. The record stays in the store's proposal log, so the History page and the agent can see why.

### Remote

- After each commit to `main`, a push (`main` only) is queued.
- Failures retry with backoff and show up in `remoteStatus()` and on the History page. **A failed push never fails the save**, because the local commit is the source of truth.
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

Provided by `dish-config` for the main agent; `crew` filters them out for children.

| Tool | Does | Allowed where the namespace's `agent` is |
|---|---|---|
| `config_read(path)` / `config_list(prefix)` | read `main` | `write` or `propose` |
| `config_write(changes, note)` | direct commit, authored as the agent | `write` |
| `config_propose(title, rationale, changes)` | opens a proposal branch | `write` or `propose` |

- **Prompting** tells the agent: use `config_write` only for a change the user asked for in this conversation, and `config_propose` for anything it initiates.
- **Structural backstop.** Sessions started by `triggers` (unattended) don't get `config_write` at all. This is enforced when `triggers` exists; until then, every session is interactive.
- **Per-namespace defaults** (each set by its owner):
  - `prompts/` and `crew.yaml`: `write`
  - family `direction.md`: `propose`, so even on request the agent proposes and you accept in one click. That's tighter than decision (b), so revisit if it gets in the way.

## Web UI: History page

The `dish-config` plugin's browser half adds **Settings → History**. It's mobile-friendly and also linked from the inbox.

- **Log**: commits on `main`, filterable by namespace or path, each showing author (you or agent role + session link), time, paths and note.
- **Commit view**: per-file diff, plus **Revert this commit**, which creates a new commit.
- **Proposals tab**: open and stale proposals, each showing title, rationale, author session, its diff against current `main`, and **Accept** / **Reject** (with a reason).
- **Remote status**: last pushed commit, how many commits are waiting to push, and the last error.

Editors (Prompts, Families, Crew) belong to their own plugins. They read through `dishConfig`, write with `base`, and link to History filtered to their namespace.

The UI talks to the server through a `dishConfig` Typert remote. A `watch()` stream pushes `changed` and `proposal` events, following the copilot card's pattern.

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
- `FORBIDDEN`: an agent writing to a namespace whose `agent` policy doesn't allow it
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
- Whether `history` pages by commit count or time.
- The remote's protocol for the VM: SSH deploy key (write access to this repo only) vs a `gh` credential helper. Leaning toward a deploy key.
