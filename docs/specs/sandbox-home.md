# Spec: a writable home in the sandbox

Status: approved, 2026-10-02. To be built on branch `sandbox-home` from `main`. You asked for this after mise approvals kept piling up: "if we can sandbox this a little bit, i'm all for relaxing all of these crazy restrictions. My agents need to get work done."

It replaces most of [mise approvals](https://github.com/bketelsen/dish/blob/mise-approvals/docs/specs/mise-approvals.md):
- **Shelved:** the `dish-mise` wrapper, the judge's trusted rule and its checkbox. They stay unmerged on their branches.
- **Kept:** fleet's part. It preinstalls the toolchains and trusts `~/work`, in a reworked fleet PR.

## The problem

Since 6a, the sandbox lets an agent's shell write only the workspace and a `/tmp` that starts empty on every call. Everyday work writes the home directory:
- `go mod download` writes `~/go/pkg/mod`;
- `pnpm install` writes pnpm's store;
- `pip install --user` writes `~/.local`;
- `cargo build` writes `~/.cargo`;
- `mise install` writes `~/.local/share/mise`;
- most tools also cache under `~/.cache`.

Each of these fails with "Read-only file system" and needs an escalation:
- **For the main agent,** that's a judge call or your approval.
- **For a crew child,** the judge refuses most escalations, so the work stops until the main agent runs the command.

This is most of the friction from the qwen session, and it would hit every Go project and every gate script that installs something.

## Decisions

1. **On the VM, an agent's sandboxed shell can write the account's home, except a protected list.**
   - System directories stay read-only. `sudo` (`dish-apt-get`) still needs an escalation, because the sandbox runs with `NoNewPrivs`.
   - The workspace and the per-call `/tmp` are as before. The network is unchanged (open).
   - The VM is the boundary. Inside it, the sandbox only keeps an agent from taking over dish itself, and from planting code that runs later outside the sandbox.
2. **The mechanism is dsh's own `runnerCommand` hook. No dsh change and no fleet change.**
   - `@deepseek-ai/dsh-sandbox-local` (id `sandbox` in dsh-base's `cordis.patch.yml`) takes `runnerCommand: string[]` and `runnerFailureSignatures: string[]`.
   - With a runner command set, it runs `[...runnerCommand, ...bwrapProfileArgs(policy), '--', ...argv]`, with enforcement `full` and no probe. Its denial signatures are "read-only file system" and "permission denied" (`lib/index.js`, `confine()` and `DENIAL_SIGNATURES.runnerCommand`).
   - dish sets the runner command to a script in its own checkout, `deploy/dish-sandbox`. The script adds dish's mounts before the `--` and runs `bwrap`.
   - The checkout (`~dish/dish`) is protected (decision 3), so no agent can change the script.
3. **The protected list.** These stay read-only, whether or not they exist yet:
   - **dish and dsh themselves:**
     - `$DSH_HOME` (default `~/.dsh`: the profile, sessions and credentials);
     - dish's four XDG directories, `${XDG_CONFIG_HOME:-~/.config}/dish`, `${XDG_DATA_HOME:-~/.local/share}/dish`, `${XDG_STATE_HOME:-~/.local/state}/dish` and `${XDG_CACHE_HOME:-~/.cache}/dish`;
     - `$DSH_DISH_HOME` when it's set;
     - dish's checkout, which is the script's own repository root.
   - **Credentials and git:** `~/.ssh`, `~/.gnupg`, `~/.gitconfig`, `~/.config/git` and `~/.git-credentials`.
     - dish's own git (6b) reads the account's global git config outside the sandbox. A `credential.helper` or `url.*.insteadOf` written there would run, or redirect, outside it.
   - **Anything that runs later outside the sandbox:**
     - `~/.config/systemd` and `~/.local/share/systemd` (user units: the account has linger);
     - `~/.config/environment.d`, `~/.config/autostart` and `~/.pam_environment`;
     - `~/.bashrc`, `~/.bash_profile`, `~/.bash_login`, `~/.bash_logout` and `~/.profile`;
     - `~/.config/mise`: fleet's global mise config. Fleet's play runs mise outside the sandbox.
   - **Missing paths are made first.** The script creates a missing protected path before it binds it, so an agent can't create it either: a directory as an empty `0700` directory, a file as an empty `0600` file. It does this outside the sandbox, as `dish`. That is harmless: an empty `.bashrc` or `.profile` behaves like a missing one.
   - **Only paths under `$HOME` are bound.** A protected path outside home is already read-only, because the sandbox's `/` is.
   - **The profile row can add to the list** with `--protect <path>`. The option takes an absolute path, or `~/…`.
4. **What the script does, exactly.** It's called as `dish-sandbox [--protect <path>]… <dsh's bwrap profile> -- <argv>`.
   - **Mode:**
     - In `workspace-write` mode, it inserts `--bind "$HOME" "$HOME"`, then `--ro-bind <p> <p>` for each protected path, all just before the first `--`. dsh's profile contains `--tmpfs /tmp` only in that mode.
     - In `read-only` mode, it adds nothing.
     - `danger-full-access` never reaches it.
   - **Order:** the home bind comes after dsh's `--ro-bind / /` and after its workspace bind, so it wins over both. The workspace stays writable, since it is the same path. The protections come last.
   - **bwrap:** it runs `/usr/bin/bwrap`, falling back to `/usr/local/bin/bwrap`, never from `PATH`.
   - **Its own failures** print `dish-sandbox: <reason>` on stderr and exit 1: no `HOME`, a relative `HOME`, no `--` in the arguments, or no bwrap. The row's `runnerFailureSignatures` are `['bwrap: ', 'dish-sandbox: ']`, so dsh reports such a run as "the command did not run", not as the command's own failure.
   - **The command's argv reaches bwrap unchanged**, including a `--` inside it. Only the first `--` is the separator.
5. **It's on for the VM, and off by default elsewhere.**
   - `deploy/install.sh` writes dish's `sandbox` row when `DISH_SANDBOX_HOME=on`, and removes it when the variable is `off` or unset. `deploy/profile.ts` does the row, like dish's other rows: `--sandbox-runner <path>` to set it, `--no-sandbox-runner` to remove it.
   - `deploy/update.sh` (the VM) runs `install.sh` with `DISH_SANDBOX_HOME=on`.
   - Dev on your desktop keeps the read-only home, so a dev chat's agent can't write your real `~/.cache`, `~/.cargo` or mise installs. To try it in dev, run `DISH_SANDBOX_HOME=on pnpm dev`, or whatever the launcher passes through.
   - A changed row means "profile changed", so `update.sh` restarts the unit.
6. **The prompts say so.** In the "This machine" section of `plugins/prompts/defaults/common.md`:
   - A command can write the workspace, its `/tmp` and the home directory, except dish's own files, `~/.ssh`, git's config and shell startup files.
   - So `pnpm install`, `go mod download`, `cargo build`, `pip install --user`, `mise install` and `mise trust` just work.
   - `sudo …dish-apt-get install` and anything else that fails with "Read-only file system" is run again escalated: the judge allows it or asks the user. A crew child reports it.
   - Keep the rule against pointing `HOME`, `XDG_*` or `MISE_*` into the workspace.
   - Keep `mise exec`/`mise run` (the shims aren't on `PATH`). Note that Node, pnpm, Go and Python are preinstalled.
   - `main.md` is unchanged.
   - `previous.json` is regenerated with the script.
7. **The judge is unchanged.** Fewer commands need an escalation, so fewer reach it as one.

## Known limits

- **Sandboxed code can leave things in the home directory that run later outside the sandbox:** a binary in `~/.local/bin` or `~/go/bin`, a mise install, a poisoned cache.
  - It runs when an escalated command (one you or the judge approved) or fleet's play uses it.
  - Accepted: such commands already run code the sandbox wrote (the repo's own install scripts), and the VM is the boundary.
  - The protected list covers the paths that run without anyone acting: shell startup, systemd user units, git's config and dish itself.
- **Reads were never confined.** An agent's shell can read `~/.dsh/.credentials.yaml` and `~/.ssh`. That is unchanged (`deploy/README.md`).
- **dsh's file tools are still fenced.** `write` and `edit` use dsh's in-process fence (workspace and temp only), which this hook doesn't reach. To write a file in the home directory, an agent uses `bash`.
- **Caches are shared across workspaces.** A command in one project can write a cache that a command in another project reads.
- **Dev is off by default** (decision 5).

## Build

There is one implementer, then one review.

1. **`deploy/dish-sandbox`** (bash, `#!/bin/bash -p`, `set -euo pipefail`):
   - follow decisions 3 and 4 exactly;
   - `shellcheck` clean;
   - a header comment on why it exists, and on what it protects and why.
2. **`deploy/profile.ts`:**
   - `--sandbox-runner <abs path>` / `--no-sandbox-runner`, which writes or removes the row patching id `sandbox` (name `@deepseek-ai/dsh-sandbox-local`) with `config: { runnerCommand: [<path>], runnerFailureSignatures: ['bwrap: ', 'dish-sandbox: '] }`;
   - match rows the way the file already does;
   - an unchanged file is byte for byte the same.
3. **`deploy/install.sh`** handles `DISH_SANDBOX_HOME`, and **`deploy/update.sh`** sets it to `on`.
4. **Tests:**
   - `deploy/test/dish-sandbox.test.ts`, with **real bwrap**, skipped when bwrap or user namespaces aren't available. Every run uses a scratch `HOME` under the test's temp directory, never the real home.
     - Writing `$HOME/x`, `$HOME/.cache/y` and `$HOME/go/z` succeeds.
     - Each protected path refuses a write with "Read-only file system", including one that didn't exist before.
     - Protected paths that are missing get created with the right type and mode.
     - `read-only` mode is unchanged.
     - The workspace is still writable.
     - A `--` inside the command's argv, odd argv and exit codes all pass through.
     - Each failure case prints the prefix and exits 1.
     - `--protect` works.
   - `profile.ts` tests: the row added, removed and idempotent.
   - The `install.sh` and `update.sh` tests cover the variable.
5. **`common.md`** text per decision 6, and `previous.json` regenerated.
6. **Docs:**
   - `deploy/README.md`: the sandbox section, the sudo line, and the reads line.
   - `docs/design.md`: the row.
   - `ROADMAP.md`: this step, plus mise approvals shelved, with what's kept.
   - This spec: "Notes from the build".
7. **A live run** in scratch (scratch `HOME`, `DSH_HOME`, `XDG_*`, `DSH_DISH_HOME` and `TMPDIR`, with `DISH_SANDBOX_HOME=on`). dsh starts, and an agent-shaped `bash` call works through dsh's own sandbox path, not only the script alone:
   - `touch ~/x` succeeds;
   - `touch ~/.ssh/x` fails with "Read-only file system";
   - the escalation hint still appears for a protected path.

## The rollout (for you)

1. Merge `sandbox-home`.
2. On the VM, run `dish-update --apply`. It turns this on and restarts.
3. In a chat, check that:
   - `go mod download` or `pnpm install` in a project runs with no prompt;
   - `touch ~/.ssh/x` fails with "Read-only file system".
4. Fleet's reworked mise PR (toolchains and the trust path) can merge before or after this.
