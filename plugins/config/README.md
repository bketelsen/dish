# dish-config

The place dish keeps configuration you author: role prompts, crew roles, families and direction.
- It's a bare git repository, and every save is a commit that records who made it (you, an agent, or the store itself) and why.
- After each commit, `main` is pushed to a private GitHub repo.
- Agents change config by committing directly when you asked for the change, or by opening a **proposal** branch that you accept or reject.
- **Settings → History** shows the log, diffs, revert, proposals and push status.

The full contract (concurrency, staleness, push behavior, error codes) is in the [spec](../../docs/specs/config-store.md). This page covers using it.

## Install

```sh
pnpm --filter dish-config build    # src/client → lib/client.js (the History page)
pnpm dsh plugin --profile web add ./plugins/config
```

The bundle loads the plugin with no remote, on purpose: a remote is per machine, and only the VM has one, so that one machine pushes. `deploy/install.sh` writes `remote` on the `dish-config` row of the profile's `cordis.patch.yml`, from `DISH_REMOTE`:
- **On the VM,** `~/.dsh/profiles/web/cordis.patch.yml`, with the remote from fleet's `install.env`.
- **In dev,** `.dev/dsh/profiles/web/cordis.patch.yml`. `pnpm dev` gives `install.sh` an empty `DISH_REMOTE`, so it resets dev's remote to none on every run.

A remote set by hand in either profile is replaced at the next install. The repo was created once, and the VM's row points at it:

```sh
gh repo create bketelsen/dish-config --private
```

```yaml
- id: dish-config
  name: dish-config
  config:
    remote: git@github-dish-config:bketelsen/dish-config.git
```

The push uses the machine's own git auth (SSH key or credential helper) and never prompts. A push that would need an answer (host key, passphrase) fails and shows on the History page instead of hanging.

## Using it from a plugin

Plugins never touch files or git. A plugin claims a **namespace**, a path prefix with its own validation and agent policy, and reads and writes through the `dishConfig` service:

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from 'dish-config'

export const inject = ['dishConfig']

export function apply(ctx: Context) {
  // Released when this plugin unloads; the files stay.
  ctx.effect(() => ctx.dishConfig.claim({
    prefix: 'prompts/',
    owner: 'dish-prompts',
    agent: 'write',                       // 'write' | 'propose' | 'none'
    validate: (path, text) => path.endsWith('.md') ? undefined : 'prompts are .md files',
  }))
  // Writes only what doesn't exist yet, so your edits survive.
  void ctx.dishConfig.seed({ 'prompts/coder.md': DEFAULT_CODER }, 'dish-prompts')
}
```

- **`seed` can move unedited defaults along.** By default it writes only what is missing. Pass `{ replace: { [path]: [hashes] } }` as the third argument and a stored document whose text still hashes (sha256, lowercase hex, of the UTF-8 text) to one of an earlier default's hashes is overwritten with the new default. A document that doesn't match is an edit, and stays. The commit carries the note "updated to the new defaults", so History shows it. If the document changed in the meantime the seed fails with `CONFLICT` and overwrites nothing.
- **Read at use**, not at load. Agents started after a commit see it, and running ones keep what they started with. Re-read on `dish-config/changed(paths, commit, author)` instead of caching.
- **Editors write with `base`**, the `head()` they loaded, as `{ kind: 'user' }`. A path someone else changed since then is `CONFLICT` (reload), and changes to other paths go through.
- Namespaces may not overlap, and a path no namespace claims can't be written.
- Every write is checked by the owner's `validate`, a size cap (256 KiB), and a **secret guard** that refuses anything that looks like a GitHub token, `sk-` key, private key or AWS key. Everything here ends up on GitHub, so credentials belong in dsh's credential store.

## Agent tools

With a `tools` service present, the **main agent** gets four tools. A subagent calling one is refused before anything happens.

| Tool | Does | Needs the namespace's `agent` to be |
|---|---|---|
| `config_read({ path })` | read one document, with the commit it was read at | `write` or `propose` |
| `config_list({ prefix })` | list documents (`''` for all); paths it can't see are left out | `write` or `propose` |
| `config_write({ changes, note?, base? })` | commit directly, as the agent | `write` |
| `config_propose({ title, rationale, changes })` | open a proposal branch | `write` or `propose` |

The tool descriptions carry the policy: write only what you asked for in the conversation, and propose anything the agent comes up with itself. Only a person can accept a proposal. A proposal whose paths changed underneath it goes **stale**, and the agent rebuilds it on current `main` rather than asking you to resolve conflicts.

The store's own `README.md` is `agent: 'none'`, so agents can neither see nor write it.

## Moving to another machine

Only one machine may push to a remote. Two would diverge, and the second one's pushes are rejected, never forced.

1. On the old machine, remove `remote` from its `dish-config` row (or stop dsh there for good).
2. On the new machine, set `remote` and start dsh with **no** local repository. The store finds `main` on the remote and restores it, history included.

A machine that already has a repository never contacts the remote while opening; it only pushes. If the remote can't be reached on a first start, the store refuses to start rather than begin a second history.

## Configuration

`dish-config` row:

| Field | Default | |
|---|---|---|
| `repository` | `$XDG_CONFIG_HOME/dish/config.git` | Absolute path, or one starting with `~/`. |
| `remote` | `''` | Where `main` is pushed after every commit. Blank keeps the config local. |
| `userName`, `userEmail` | git's global `user.name` / `user.email` | Identity on commits a person made in the UI. |
| `agentName`, `agentEmail` | `dish agent`, `agent@dish.local` | Identity on commits by an agent and by the store itself. The History page tells them apart by trailer. |
| `maxBytes` | `262144` | Largest document. |
| `pushTimeoutMs` | `60000` | A push (or a first-start lookup of the remote) running longer is killed and retried with backoff. |
| `terminal` | `true` | Print this plugin's messages to the terminal. |

## Caveats

- **`dsh plugin add` and `dsh --dump-config` start plugins.** On a profile with `dish-config`, they open the store, so the first one creates it, seeds `README.md`, and pushes if a remote is set.
- **One process per store.** A second dsh process on the same store gets `LOCKED`: it logs the error and runs without `dishConfig`.
- **The History page at phone width** is squeezed by dsh's Settings dialog, which keeps its side menu visible.
- Proposal branches stay local. Only `main` is pushed.
