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
  - The protected list covers the files that run later without anyone acting: shell startup, systemd user units, git's and pnpm's config, node's module lookups above the checkout, and dish itself. It does not stop a command that asks the user manager to run something (see the session bus, below).
- **The session bus is open.** A sandboxed command can reach the account's D-Bus session bus and systemd user manager (`$XDG_RUNTIME_DIR/bus`, `$XDG_RUNTIME_DIR/systemd/private`), and through them have something run outside the sandbox, past the protected list. This is older than this hook and left open on purpose: the sandbox guards against accidents, not a determined agent, and the VM is the boundary.
- **A protected path is frozen.** Whatever it holds stays as it is, read-only, so a path joins the list only when its content can stay as it is.
- **A workspace at or under a protected path is read-only,** since the protections come last: the checkout, for one, as dev's default workspace is with `DISH_SANDBOX_HOME=on pnpm dev`. Use a workspace outside the checkout.
- **A protected path that is a symbolic link,** or that sits under one, stops every sandboxed command with a `dish-sandbox:` message naming it: bwrap can't mount on a link, and a link in a writable directory could be replaced. Replace the link with what it points to. On the VM there is none.
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
2. On the VM, run `dish-update --apply` twice (corrected in the build).
   - The first runs the `update.sh` it started with, which doesn't set `DISH_SANDBOX_HOME`, so the new `install.sh` leaves the row out. It already makes dish's installs copies of pnpm's store (see the notes), and the new prompts already say the home is writable. That is harmless until the second run: an agent that meets "Read-only file system" runs the command again escalated, as before.
   - The second runs the new `update.sh`, which writes the row, says `install: profile changed`, and restarts.
3. Check that dish's installs are copies: `incus exec minideb:dish --project dish -- su - dish -c 'find ~/dish/node_modules ~/.dsh/profiles/web/node_modules -type f -links +1 | head -3'` prints nothing, and `stat -c %h` on any file under `~/dish/node_modules/.pnpm/` prints `1`.
4. In a chat, check that:
   - `go mod download` or `pnpm install` in a project runs with no prompt;
   - `touch ~/.ssh/x` fails with "Read-only file system".
5. Fleet's reworked mise PR (toolchains and the trust path) can merge before or after this.
6. Rolling back past this branch: take the row off first, or every sandboxed command fails, because the older checkout has no `deploy/dish-sandbox`. The command is in `deploy/README.md` ([Updating](../../deploy/README.md#updating)).

## Notes from the build

Built on branch `sandbox-home`, 2026-10-02, against dsh 0.2.0-rc.2.

### dsh, as checked in its sources

- **The argv.** `confine()` in `@deepseek-ai/dsh-sandbox-local` returns `[...runnerCommand, ...bwrapProfileArgs(policy), '--', ...argv]`, with `enforcement: 'full'` and no probe. `argv` is `['bash', '-c', <command>]` (`dsh-bash-sandbox`). The profile is `--ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent`, plus `--tmpfs /tmp --bind <workspace> <workspace>` in `workspace-write` only. The workspace is canonical (realpath). `deploy/test/dish-sandbox.test.ts` builds every argv it runs with dsh's own `confine()`, so a dsh that changes the shape fails there.
- **The schema.** `runnerCommand: string[]`, `runnerFailureSignatures: string[]` and `probeTimeoutMs` (default 5000). A runner needs at least one signature, each non-empty and on one line. dsh's schema accepts the row `profile.ts` writes (a test).
- **The runner's environment** is dsh's own, scrubbed: no name matching `KEY`, `PASSWORD`, `SECRET` or `TOKEN`, and no `DSH_*` name but those dsh sets for each call (`DSH_HOME`, `DSH_SHELL`, `DSH_SESSION_ID`, `DSH_PROFILE`, `DSH_PROFILE_DIR`), plus `NO_COLOR`, `TERM=dumb`, `PAGER` and `GIT_PAGER`. So `HOME`, `XDG_*` and `PATH` reach it, `DSH_HOME` is dsh's resolved home, and `DSH_DISH_HOME` never does. The script still honors `DSH_DISH_HOME` when it is set and absolute; dev's lies inside the checkout, which is protected anyway.
- **Classification.** A runner failure is a non-zero exit with any stderr line that contains a fatal signature (case-insensitive, no exit-code gate), and it is checked before denials. In the foreground, dsh reports it as `SANDBOX_UNAVAILABLE`: "…refusing to run the command unconfined… Runner failure: dish-sandbox: <reason>". The words "the command did not run" are what a background job gets. A denial is a non-zero exit with "read-only file system" or "permission denied" on stderr: `[sandbox: file access denied under workspace-write mode]` and the escalation hint.
- **`danger-full-access`** never calls `confine()`: `SandboxBashExecutor.execute` runs it as the local executor does.

### Rulings

1. **The directories in between are mount points.** A directory that holds a mount point can still be renamed, so `mv ~/.config ~/.old && mkdir -p ~/.config/git` replaced a protected directory (checked with bwrap before the fix). The script binds each directory between `$HOME` and a protected path onto itself, writable, so `mv` and `rm` on it fail with "Device or resource busy". Writes into it work as before.
2. **A missing `~/.bash_profile` is not empty.** Decision 3 says an empty file behaves like a missing one. That holds for `.bashrc` and `.profile`, but a login bash reads only the first of `~/.bash_profile`, `~/.bash_login` and `~/.profile`, so an empty `~/.bash_profile` would hide the account's `~/.profile` (Debian's adds `~/.local/bin` to `PATH` and reads `~/.bashrc`). A missing `~/.bash_profile` is made 0600 with one line that reads `~/.bash_login` when that exists, else `~/.profile`. A missing `~/.bash_login` is made empty, which is harmless once `~/.bash_profile` exists.
3. **`~/.dsh` stays protected when `$DSH_HOME` points elsewhere**, as dish's default XDG directories stay protected beside `$DSH_DISH_HOME`. In dev that is your own dsh home, whose profiles run code when you start dsh.
4. **`HOME` must be an absolute directory other than `/`.** `/` would make the whole file system writable; a missing one would fail in bwrap anyway, after the script had made things. Both fail before anything is made.
5. **read-only mode needs only bwrap and the `--`.** It reads neither `HOME` nor the `--protect` values, so it doesn't fail on them.
6. **`--protect`.** A missing path is made as a directory. A value that is neither absolute nor `~/…` is a failure, not ignored. `profile.ts` keeps `--protect` pairs that follow the runner in `runnerCommand`, so a later install doesn't drop them.
7. **Nothing from `PATH`.** The script runs outside the sandbox, so besides bwrap it uses only `/usr/bin/mkdir` (or `/bin/mkdir`) and bash builtins. It turns its own `set -euo pipefail` and `-p` off before `exec`, since bash passes them on when `SHELLOPTS` is exported.
8. **Links** (changed in the fix round). bwrap 0.12 can't mount on a link ("Can't mount on symlink destination"), so a protected path that is a symbolic link, or a directory between home and one that is, made bwrap fail every call. The script now stops first, with `dish-sandbox: <path> is a symbolic link, …: replace it with what it points to`. It never makes anything through a link. The home itself is bound by its real path (`pwd -P`), so a home reached through a link still works.
9. **`--no-sandbox-runner`** removes dish's two keys, and the row only when nothing else is left in it (a `probeTimeoutMs` set by hand stays).
10. **`DISH_SANDBOX_HOME`** other than `on`, `off`, empty or unset stops `install.sh` before it starts.

#### The fix round (after the review)

11. **dish's own installs copy pnpm's store.** On the VM's ext4, pnpm hard-links the store's files into `node_modules`, so the checkout and the profile shared inodes with the store, which sandboxed commands can now write, and with every agent's project. `install.sh` runs the checkout's install with `--package-import-method=clone-or-copy` (a reflink on the desktop's btrfs, so dev costs nothing), and writes `packageImportMethod: clone-or-copy` into the profile's `pnpm-workspace.yaml`, which dsh's plugin manager uses too. Agents' own installs still link, in clones and worktrees of dish too: the setting is not in the checkout's `pnpm-workspace.yaml`, which every clone carries, because on ext4 each clone's install would copy about 545 MB (final review).
    - pnpm never re-imports what it linked before: checked with a scratch store on one file system. After the setting, `pnpm install --frozen-lockfile` said "Already up to date", and `pnpm install --force` left the link count at 2. Only a fresh `node_modules` gave 1. Deleting `node_modules` under the running service is a window of missing files, so `install.sh` instead replaces each file with more than one link by a copy of its own, renamed over it (`deploy/pnpm-copies.ts --unlink`), in the checkout's and the profile's `node_modules`, on every run. It is a scan when there is nothing to copy. It runs from the first `dish-update --apply`, since that already runs the new `install.sh`.
    - Changing the setting doesn't make pnpm purge `node_modules` (no `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`), and the store and which store is used are unchanged, so the store-pin contract holds.
    - Other profiles under `~/.dsh` are not touched; the VM has only `web`.
12. **Node's module lookups above the checkout:** `~/node_modules`, `~/.node_modules` and `~/.node_libraries` are protected, made as empty directories (the reviewer showed dsh web loading a planted `bufferutil` from a parent `node_modules`).
13. **Bash's other startup files:** `~/.bash_aliases`, `~/.bash_completion` and `~/.local/share/bash-completion`.
14. **pnpm's own config** (added beyond the review): `~/.config/pnpm` and `~/.npmrc`. `install.sh` and dsh's plugin manager run pnpm outside the sandbox, and pnpm 11 reads `~/.config/pnpm/config.yaml`, where a `scriptShell` would run for every script (checked: `pnpm config get script-shell` read it from there; it ignored the same setting in `~/.npmrc`, which still holds the registry and its credentials). An agent's `pnpm config set --global` now fails; per-project settings work.
15. **`profile.ts --patch <path> --no-sandbox-runner`** (or `--sandbox-runner <path>`) with no dish-config inputs writes the sandbox row alone: the step before a rollback past this branch.

### Where the spec was wrong, or I disagree

- **The rollout takes two `dish-update --apply` runs.** The first after the merge runs the `update.sh` already in memory, which doesn't set `DISH_SANDBOX_HOME`, so the new `install.sh` leaves the row out. The second runs the new `update.sh`, which writes the row and restarts.
- **The session bus is reachable from the sandbox.** dsh's bwrap profile doesn't hide `$XDG_RUNTIME_DIR`. On the desktop, inside that profile, `busctl --user get-property org.freedesktop.systemd1 … Version` answered (nothing was started). You decided to leave it open and say so: see Known limits.
- **mise's trust state is writable.** `mise trust` writes `~/.local/state/mise`, so a sandboxed command can trust a config it wrote. Whether that matters depends on where fleet's play runs mise; `~/.config/mise` itself is protected.
- **Dev with home directories on `PATH`.** dsh looks `bash` up on `PATH` for every escalated command. With `DISH_SANDBOX_HOME=on` on a desktop whose `PATH` has `~/.local/bin` (or mise's shims), a sandboxed command can put a `bash` there that the next escalation runs unsandboxed. The VM's `PATH` is root-owned. `deploy/README.md` says so.
- **"permission denied"** is in dsh's denial dialect for a `runnerCommand`, so an `ssh … Permission denied (publickey)` failure also gets the escalation hint. That is dsh's, not ours.

### The live run

In scratch (`HOME`, `DSH_HOME`, `XDG_*`, `DSH_DISH_HOME`, `TMPDIR` and `HISTFILE` under the scratchpad):
- `DISH_SANDBOX_HOME=on deploy/install.sh` made the `web` profile, wrote the row (`install: sandbox home: on`, `install: profile changed`), and `dsh --dump-config` composed it on dsh-base's `sandbox` entry.
- `dsh web` started from that profile and answered (401 without the sign-in), and was stopped.
- `dsh --profile headless --patch <the same row, a scripted local model>` ran six `bash` calls through dsh's own path (tool, sandbox executor, provider, `dish-sandbox`, bwrap): `touch ~/x` and writes under `~/.cache` and `~/go` worked; `touch ~/.ssh/x`, `echo >> ~/.bashrc` and `touch ~/.config/systemd/evil.service` failed with "Read-only file system", each with `[sandbox: file access denied under workspace-write mode]` and the escalation hint; `mv ~/.config …` failed with "Device or resource busy"; `/tmp` and the workspace were writable.
- With a bad `--protect` in the row, every call came back as dsh's runner failure, "Runner failure: dish-sandbox: --protect takes an absolute path or ~/..., not: relative/path".
