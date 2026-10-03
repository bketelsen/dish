# Deploying dish

dish runs on its own VM, reachable only on your tailnet. The VM and its guest setup belong to the fleet repo (`~/projects/fleet`). This directory is the dish side: what to install, the unit that runs it, and the two scripts you run on the VM, `update.sh` and `url.sh`.

The design is in the [deploy spec](../docs/specs/deploy.md) and the [ops spec](../docs/specs/ops.md), and what a dsh host needs on Linux is in the [research note](../docs/research/2026-10-01-dsh-linux-host.md).

## What the VM runs

- **The service.** `dsh web`, as `dish-web.service`: a systemd user unit of the unprivileged `dish` account, which has linger on. Its one sudo right is fleet's apt wrapper (see [Security notes](#security-notes)).
- **The binary.** The unit runs the checkout's own dsh, its script `~/dish/node_modules/@deepseek-ai/dsh/lib/bin.js` under `/opt/dish/node/bin/node`. That is neither `pnpm dsh` nor the `node_modules/.bin/dsh` shim, which sets a `NODE_PATH` into the checkout (see [Prod and dev](#prod-and-dev)). Only `pnpm dsh` goes through the launcher, which defaults to dev. `pnpm dev` runs `scripts/dev.ts`, which is dev only, and `pnpm test`, `build` and `typecheck` use neither. The service is prod because it never goes through the launcher.
- **The working directory** is `~/work`, not the live checkout: dsh's fallback root for the sandbox, and where it reads a `.env`. It is also the work root of [`dish-workspaces`](../plugins/workspaces/): each project's clone is `~/work/<owner>/<repo>`, with its task worktrees in `.worktrees/`, and `~/work/scratch` is the scratch workspace for general chats. dsh's web UI starts every chat in a workspace, so chats stay out of the checkout as long as no workspace points at it.
- **The port.** It listens on `127.0.0.1:3080` only. Nothing listens on the VM's own address.
- **The address.** `tailscale serve` puts it at `https://dish.<tailnet>.ts.net`, with a tailnet certificate. The tailnet needs HTTPS certificates enabled in the admin console first.
- **The code.** A checkout of `bketelsen/dish` at `~dish/dish`, with the profile at `~dish/.dsh/profiles/web`.
- **The state.** It lives in `dish`'s home:
  - `~/.dsh`: dsh's sessions and its credential file;
  - `~/.config/dish/config.git`: the config store, pushed to `bketelsen/dish-config`. The VM is its only pusher;
  - `~/.local/state/dish`: the judge's decision log; `deploy/`, `update.sh`'s lock and record of the last start; `projects/status.json`, each project's onboarding status; `workspaces/`, each clone's and worktree's record, setup logs, and the GitHub App's read tokens (`workspaces/tokens/<owner>`, 0600, removed when dsh stops); `gates/<owner>/<repo>/<slug>/`, the gate logs of [`dish-gates`](../plugins/gates/) (one per gate run, `<child>-<turn>-<round>.log`, 0600 in 0700 directories, pruned after 30 days); and `orchestrator/<owner>/<repo>/runs/<id>.json`, the run records of [`dish-orchestrator`](../plugins/orchestrator/) (0600 in 0700 directories);
  - `~/.local/share/dish`: crew's records, and `ledgers/<owner>/<repo>/<id>.jsonl`, each run's ledger (append-only, 0600 in 0700 directories, never pruned).

## What the files here do

| File | What it is |
|---|---|
| `install.sh` | Builds dish and installs it into a dsh profile. Idempotent. |
| `profile.ts` | Writes dish's rows into the profile's `cordis.patch.yml`. `install.sh` runs it. |
| `pnpm-copies.ts` | Makes dish's own installs copies of pnpm's store, not hard links into it. `install.sh` runs it. |
| `dish-sandbox` | dsh's sandbox runner on the VM: bwrap with dsh's own profile, plus a writable home less a protected list. See [The sandbox](#the-sandbox). |
| `dish-web.service` | The systemd user unit. `update.sh` copies it into `~/.config/systemd/user`. |
| `update.sh` | Updates the VM: fetch, move the checkout, `install.sh`, the unit, and a restart when the service is stale. You run it through fleet's `dish-update`. |
| `url.sh` | Prints the sign-in link with the service's current token. You run it through fleet's `dish-url`. |

### install.sh

Run it as the account that runs `dsh web`, from anywhere (it moves to the checkout's root itself). `node` and `pnpm` must be on `PATH`. On the VM, `update.sh` runs it; on a desktop, `pnpm dev` does. Its inputs come from the environment:

| Variable | Meaning |
|---|---|
| `DISH_REMOTE` | Required. The config store's git remote, for example `git@github-dish-config:bketelsen/dish-config.git`. Set but empty, no remote is written and the store stays local; that also replaces a remote the row already has. Unset is an error. |
| `DISH_USER_NAME` | Required. The name on the store's commits. |
| `DISH_USER_EMAIL` | Required. The email on the store's commits. |
| `DISH_PROFILE` | The dsh profile to install into. Default `web`, which is the profile `dsh web` reads. |
| `DISH_SANDBOX_HOME` | `on` lets agents' sandboxed commands write the home directory, less a protected list: the profile's `sandbox` row runs them through `deploy/dish-sandbox` (see [The sandbox](#the-sandbox)). `off`, empty or unset removes that row. Any other value stops the install before it starts. `update.sh` sets it to `on`; `pnpm dev` passes on yours. |
| `DSH_HOME` | Where profiles live. Default `~/.dsh`. |

Its steps, in order:
1. **Build.** `pnpm install --frozen-lockfile`, then `pnpm build`.
2. **The profile.** If `$DSH_HOME/profiles/$DISH_PROFILE` is missing, dsh creates it. For `web` that is its shipped profile; any other name is copied from `web`.
3. **The rows.** `profile.ts` writes dish's rows into the profile's `cordis.patch.yml`:
   - **The `dish-config` row** gets `remote`, `userName` and `userEmail`, and nothing else.
   - **The `agent-preset-registry` row** makes the `dish` preset the default for new tasks, when no default is chosen yet.
   - **The `sandbox` row**, with `DISH_SANDBOX_HOME=on`: `runnerCommand: [<checkout>/deploy/dish-sandbox]` and `runnerFailureSignatures: ['bwrap: ', 'dish-sandbox: ']`. With it off, those two keys go, and the row with them unless it holds something else.
   - Other rows, comments and key order stay as they are. A file that is already right is not rewritten.
4. **The bundles.** For copilot, config, prompts, skills, crew, judge, web, projects, workspaces, gates and orchestrator, in that order (projects after config, whose store it uses, workspaces after projects, whose types it imports, gates after them, since it reads crew, projects and workspaces, and orchestrator last, since it reads crew, gates, workspaces and projects), `pnpm exec dsh plugin --profile <profile> add ./plugins/<name>`, only when the profile doesn't link it yet. That is dsh's own binary, not the launcher, so the profile is the one `DSH_HOME` names.
5. **Copies, not links.** pnpm hard-links its store's files into `node_modules` where it can (the VM's ext4), so dish's files would share their inodes with every agent's project and with the store, which a sandboxed command can write on the VM. Step 1 installs with `--package-import-method=clone-or-copy` (a reflink on btrfs, else a copy), `install.sh` writes `packageImportMethod: clone-or-copy` into the profile's `pnpm-workspace.yaml` before step 4, and here it replaces every file in the checkout's and the profile's `node_modules` that is still a link by a copy of its own (`pnpm-copies.ts`), since pnpm never imports a package again for a changed setting. When there is nothing to copy, it is a scan. Agents' own installs still link, in clones and worktrees of dish too, since the flag isn't in the checkout's `pnpm-workspace.yaml`.

It prints what it did, `install: sandbox home: on` or `off`, `install: the profile's pnpm installs copy: updated` (or `unchanged`) and `install: links into pnpm's store replaced by copies: <n>` among it, and its last line is `install: no changes to the profile` or `install: profile changed`. A changed `sandbox` row is a changed profile. On a failure it stops and names the step on stderr, as `install: FAILED at step: …`. It prints nothing secret.

**Isolation.** Every dsh command `install.sh` runs gets its four XDG directories pointed at a throwaway directory, which is removed on exit. A dsh command that loads a profile boots its plugins, and `dish-config` creates `~/.config/dish/config.git` when it boots. An install that did that on a fresh machine would leave an empty local store, and the first start with a remote would then push it over the one on GitHub instead of restoring it. In dsh 0.2.0-rc.2 the two commands the script uses boot nothing, so this guards against a later dsh. `HOME` and `DSH_HOME` stay real, so the profile lands where `dsh web` reads it. Those commands also run without `DSH_DISH_HOME`: under `pnpm dev` the launcher sets it, and it moves dish's directories ahead of `XDG_*`, so the throwaway directories would otherwise do nothing.

**The store-pin contract.** pnpm records the store a profile was first used with, and refuses to work on it with any other store. So `install.sh` looks up the store pnpm would use (`pnpm store path`) and hands it to each dsh command, instead of letting the throwaway directory pick a new one. dsh's plugin manager inside `dsh web` works the store out again, from the unit's environment. Both must give the same store, so `HOME`, `XDG_DATA_HOME` and `PNPM_HOME` have to be the same for `install.sh` and for the unit. Set none of them for just one of the two. `update.sh` keeps this by running `install.sh` in the unit's clean environment.

**The default preset.** The `dish` preset is set as the default on the first install only. A default chosen in Settings → Agent presets is kept by every later update.

### What the unit expects

- **`/opt/dish/node`.** A symlink to the pinned Node install (24.21.0), with pnpm (11.25.0) in its `bin`. The unit's `PATH` is `/opt/dish/node/bin:/usr/local/bin:/usr/bin:/bin`, and its `ExecStart` runs `/opt/dish/node/bin/node`. Agents' shell commands inherit it, so it is also what a command can run. `update.sh` reads it from the unit, and runs `install.sh` with it.
- **`~/.config/dish/deploy.env`.** Written by fleet, with one line: `DISH_TRUSTED_HOST=dish.<tailnet>.ts.net`. The unit passes it as `--trusted-host`, which `dsh web` needs to answer `/api` calls that `tailscale serve` forwards under that name. The file is required: without it the unit doesn't start, and without the variable dsh refuses to load and the unit restarts every 5 seconds. It holds nothing else, because dsh passes the unit's environment on to every agent shell.
- **`~/.config/dish/install.env`.** Written by fleet, mode 0600, and read by `update.sh` only. The unit never loads it. It holds `install.sh`'s inputs, `DISH_REMOTE`, `DISH_USER_NAME` and `DISH_USER_EMAIL`, one `NAME=value` line each, the value taken verbatim. Blank lines and `#` lines are ignored, each name appears once, and none may be empty. They live apart from `deploy.env` so that they never reach an agent's shell: an agent's own `install.sh` run that left out `DISH_REMOTE` would otherwise pick up the real remote and make a second pusher.
- **`~/work`, with no `.env`.** `update.sh` creates it (mode 0700). Without it the unit fails to start with `200/CHDIR`, which is wanted: it says the account was never set up. dsh loads a `.env` from its working directory, and the names in it reach the service and every agent shell (dsh refuses only `PATH`, `DSH_*`, `XDG_*` and its launch variables from it). So keep `~/work` free of one.
- **The checkout at `~/dish`.** Fleet clones it once. From then on `update.sh` moves it and runs `install.sh`.
- **`bubblewrap`,** installed before the first start. It is dsh's sandbox, and without it, or Landlock, dsh refuses every agent shell command. dsh caches that verdict, so restart the unit after fixing it ([Restarting by hand](#restarting-by-hand)).
- **No hardening options.** The unit has no `PrivateUsers=`, `SystemCallFilter=` or the like on purpose. Every agent command is a child of the unit, and those options would break the sandbox. `NoNewPrivileges=` would also stop sudo in escalated agent commands.

## Updating

Nothing updates on its own, and fleet's guest play no longer updates dish. After a change reaches `main`, run `update.sh` through fleet's `dish-update`, from the desktop:

```sh
incus exec minideb:dish --project dish -- dish-update                  # dry run: what would change
incus exec minideb:dish --project dish -- dish-update --apply          # update to origin/main
incus exec minideb:dish --project dish -- dish-update --apply <ref>    # roll back to a commit or tag
```

**Rolling back past the sandbox runner** (to a commit before `sandbox-home` merged): take its row off the profile first. The older checkout has no `deploy/dish-sandbox`, and its `install.sh` doesn't know the row, so every sandboxed command would fail until you did. Then roll back, which restarts:

```sh
incus exec minideb:dish --project dish -- su - dish -c '/opt/dish/node/bin/node ~/dish/deploy/profile.ts --patch ~/.dsh/profiles/web/cordis.patch.yml --no-sandbox-runner'
incus exec minideb:dish --project dish -- dish-update --apply <ref>
```

The first prints `updated` (or `unchanged` when there was no row) and touches no other row.

**Rolling back past 6b,** to a commit without `plugins/projects` and `plugins/workspaces`, takes one step first: remove their two bundles from the profile while the checkout still has them. An older `install.sh` doesn't know them, so the profile would keep linking two directories the rollback removes. Run it as `dish`, with only the unit's `HOME` and `PATH`, as `update.sh` does (see the store-pin contract under [install.sh](#installsh)):

```sh
incus exec minideb:dish --project dish -- su - dish -c 'cd ~/dish && env -i HOME="$HOME" PATH=/opt/dish/node/bin:/usr/local/bin:/usr/bin:/bin pnpm exec dsh plugin --profile web remove dish-workspaces dish-projects'
```

Then roll back with `dish-update --apply <ref>`. The clones under `~/work` and dish's records stay, and a later update to a commit with the two plugins links them again. Until then, the clones' credential helper (`~/dish/plugins/workspaces/bin/git-credential-dish`) is gone, so agents' git can't fetch a private repo in them.

**Rolling back past 6c,** to a commit without `plugins/gates`, is the same step for its one bundle, first:

```sh
incus exec minideb:dish --project dish -- su - dish -c 'cd ~/dish && env -i HOME="$HOME" PATH=/opt/dish/node/bin:/usr/local/bin:/usr/bin:/bin pnpm exec dsh plugin --profile web remove dish-gates'
```

Crew's record keeps the gate results it holds, and an older crew drops them when it next writes a child's record. The gate logs under `~/.local/state/dish/gates` stay until you remove them.

**Rolling back past step 7,** to a commit without `plugins/orchestrator`, is the same step for its bundle, first:

```sh
incus exec minideb:dish --project dish -- su - dish -c 'cd ~/dish && env -i HOME="$HOME" PATH=/opt/dish/node/bin:/usr/local/bin:/usr/bin:/bin pnpm exec dsh plugin --profile web remove dish-orchestrator'
```

An older crew drops the `report`, `run`, `task` and `final` fields when it next writes a child's record, and `structured`, `structuredFile` and `notice` from its runs (`runs[]`). The run records under `~/.local/state/dish/orchestrator` and the ledgers under `~/.local/share/dish/ledgers` stay where they are. The store's prompts and skills stay at step 7's texts, which name `run`, `report` and `open_pr`, because an older `previous.json` doesn't know them: reset main, common, coder and reviewer on Settings → Prompts, and the eleven changed skills on Settings → Skills.

`minideb` is your desktop's Incus remote for Minideb. Without it, go through Minideb: `ssh <you>@<minideb-host> incus exec dish --project dish -- dish-update`, and so on. On Minideb itself it's `incus exec dish --project dish -- dish-update`. The scripts' own hints, such as `run dish-url for a fresh sign-in link (incus exec dish --project dish -- dish-url)`, give that form for Minideb itself; from the desktop, add the `minideb:` remote.

### Who runs it

- **`update.sh` runs only as the account** that owns the checkout (`dish`). `dish`, and so any agent, can write the file, so root running it would run whatever was put there. Run as root, or as anyone else, it exits 2 with `update: run dish-update as root (incus exec dish --project dish -- dish-update [--apply] [<ref>]), or this script as dish`.
- **`dish-update` is root's way in.** It is a root-owned wrapper fleet installs at `/usr/local/sbin/dish-update`, and its one command is `runuser`: it drops to `dish` and runs `~dish/dish/deploy/update.sh` under `env -i`, with only `HOME`, `USER`, `LOGNAME`, `XDG_RUNTIME_DIR` and the unit's `PATH`. Root reads and runs nothing of `dish`'s. Arguments pass through, and so does the exit code.
- **With a terminal,** as when you run it from your desktop's terminal, `dish-update` passes `--pty` to `runuser`, so the script runs on a terminal of its own and can't reach root's. Then its stderr arrives on stdout, with CRLF line ends. Without one, as through `ssh` without `-t`, it passes `--no-pty`, and stdout and stderr stay apart.
- **As `dish` itself,** in a shell that is already the account's, `~/dish/deploy/update.sh [--apply] [<ref>]` does the same.
- **A clean environment.** The script runs itself again under `env -i`, with `HOME`, `USER`, `LOGNAME`, `XDG_RUNTIME_DIR=/run/user/<uid>`, the `PATH` of the checkout's unit, `TMPDIR=~/.cache/dish/tmp` (made 0700; not `/tmp`, which sandboxed commands can write, see [The sandbox](#the-sandbox)) and `LANG`. No `XDG_*` directories, `PNPM_HOME`, `DSH_*` or `NODE_ENV`, as for the unit, so the store-pin contract holds.
- **One at a time.** A lock, `~/.local/state/dish/deploy/lock`, refuses a second run while one is going.

### What it does

1. **Reads the inputs:** `install.env` (as above) and `deploy.env`, which must have exactly one `DISH_TRUSTED_HOST` line with a bare host name.
2. **Fetches** `origin`.
3. **Finds the target:** `origin/main`, or the ref you give. A target without `deploy/update.sh`, `deploy/install.sh` or the unit is refused, so a rollback to before `update.sh` existed can't happen.
4. **Reports** what it would do (below), and whether the service would restart.
5. **Checks the checkout.** It refuses local changes, listing up to 10 paths; ignored files such as `node_modules` and `.dev/` don't count. With no ref, it must be on `main` (or detached after a rollback), and `main` must fast-forward to `origin/main`. It refuses to leave commits behind on a detached HEAD, ones that no branch or tag has. It never resets anything.

   The dry run stops here. Every refusal comes before the first change, so a dry run that passes means `--apply` can start, and a dry run that finds a refusal exits 1.
6. **Moves the checkout:** `git merge --ff-only` on `main`, switching back to `main` first after a rollback, or `git switch --detach <ref>`.
7. **Runs `install.sh`** with `install.env`'s inputs and `DISH_SANDBOX_HOME=on`, in the clean environment, with the target unit's `PATH`. Its output, stderr included, appears on `update.sh`'s stdout.
8. **Installs the unit.** It copies `deploy/dish-web.service` when it differs. It runs `daemon-reload` when the file changed, when the service last started with another unit (or there is no record of a start), or when the user manager asks for one. Then it makes `~/work` and enables the unit.
9. **Restarts** the service when it isn't active, when `install.sh` changed the profile, or when the record of the last start is missing or differs.
10. **Waits** up to 120 seconds for `127.0.0.1:3080` to answer. A service that this run didn't restart, and that doesn't answer, gets one restart and a second wait. If dsh still doesn't answer, it prints the journal tail and fails.
11. **Writes the record** of the start, after a restart, once dsh has answered.

### The record of the last start

`~/.local/state/dish/deploy/started`, six lines: `revision <sha>`, `unit <sha256>`, `deploy.env <sha256>`, `install.env <sha256>`, `node <node --version>` and `pnpm <pnpm --version>`. The versions are read with the target unit's `PATH`. Any line that differs from what the target would start with makes the service stale, so a new commit, a new Node or pnpm from fleet, or an edited `deploy.env` each restart it. It is written only after dsh answers, so a run that fails after its restart restarts again the next time.

### What it prints

Every line `update.sh` writes itself starts with `update: `, and the lines listed under one, such as the commits or the journal's lines, are indented. `install.sh`'s output passes through as it is. Under `--pty` (see [Who runs it](#who-runs-it)), stderr arrives on stdout too. The report, which the dry run and `--apply` both print:

| Line | Values |
|---|---|
| `HEAD <sha> (<branch>)` | the branch, or `detached` |
| `target <sha> (<name>)` | `origin/main`, or the ref you gave |
| the commits | `N commits to apply`, `N commits to roll back`, `already at the target`, or `diverged: …`, then one line per commit, indented |
| `unit: …` | `same`, `changes` or `not installed` |
| `deploy.env: …`, `install.env: …` | `same as the last start`, `changed since the last start` or `no record of a start` |
| `restart: …` | `not needed`, or `needed (<reasons>)`: `not active (<state>)`, `no record of a start`, or `<line> changed` for a line of the record |

The dry run ends with `dry run; run with --apply to update`. `--apply` names each step as it starts, passes `install.sh`'s output through, says `restart: needed (…)` or `restart: not needed` again (now with `install.sh changed the profile` among the reasons when it did), and ends with:
- `HEAD <sha>`;
- `dish-web.service: <state> (restarted)`, or `(unchanged)`;
- after a restart, `run dish-url for a fresh sign-in link (incus exec dish --project dish -- dish-url)`;
- `journal (last 15 lines, credential lines removed):` and the lines. When the journal can't be read it says `journal: nothing readable as dish (journalctl --user -u dish-web.service)`.

**No token, ever.** dsh's sign-in line carries its access token. So every line `update.sh` would print that mentions a token, in any letter case, is left out: journal lines, commit subjects and `install.sh`'s output alike. It says how many, as `(N lines left out)` or `left out N lines of install.sh's output`. `dish-url` prints the link.

**Failures** go to stderr. A failed step is named as `update: FAILED at step: <step> (exit N)`. Once the checkout has moved, the next line says where things stand, for example `update: the checkout is at <sha> (was <old>); dish-web.service was not restarted; fix the problem and rerun dish-update --apply, or go back with dish-update --apply <old>`. A user manager that doesn't answer is refused before anything changes: `update: can't reach dish's user manager (XDG_RUNTIME_DIR=/run/user/<uid>; is linger on?)`.

**Exit codes:** 0 done, or nothing to do; 1 a failed step or a refusal; 2 usage, or not run as the account. `-h` prints the usage.

### After a restart

A restart makes a new access token, but your browser's sign-in carries over (see [Signing in](#signing-in)).

At the restart, `dish-prompts` and `dish-skills` look at their documents in the config store. One that is still an earlier shipped default moves to the new text, in one commit with the note "updated to the new defaults" (Settings → History shows it). One you edited stays as it is.

### Restarting by hand

`dish-update --apply` doesn't restart a service that is active and answers when nothing it tracks has changed. For a change it doesn't see, such as `bubblewrap` installed after the first start, restart the unit yourself, then get a fresh link:

```sh
incus exec minideb:dish --project dish -- systemctl --user -M dish@ restart dish-web.service
incus exec minideb:dish --project dish -- dish-url
```

`--user -M dish@` reaches `dish`'s own user manager, which linger keeps running, from root (systemd 248 or later; the VM's Debian 13 has 257). The record of the last start still matches, so the next `dish-update --apply` doesn't restart it again. If `dish-url` says dsh hasn't printed its sign-in line yet, try again in a few seconds.

### The first update (once, October 2026)

Done on 2026-10-02. Until 6a, fleet's guest play updated the checkout, ran `install.sh` and restarted the unit. The VM's checkout predated `update.sh`, so the hand-over ran once, in this order:

1. **`ops` reaches `main`, as one merge.** The unit that runs dsh directly must land with the launcher that `pnpm dsh` now goes through. With the old unit's `pnpm dsh web`, the VM would come up on an empty dev store.
2. **The fleet PR, [bketelsen/fleet#38](https://github.com/bketelsen/fleet/pull/38) (merged, fleet c5bb7f6).** Its docs follow-up is [bketelsen/fleet#39](https://github.com/bketelsen/fleet/pull/39). Run the guest play one last time: preview, apply and rerun, with the secrets left out. Expect `install.env`, `~dish/work`, `/usr/local/sbin/dish-apt-get` with its sudoers file, `/usr/local/sbin/dish-update` and `/usr/local/sbin/dish-url`, and `/usr/local/bin/mise`. Expect no change to `~dish/dish`, the profile or the unit. The rerun reports no changes.
3. **Fast-forward the checkout once by hand,** so that `update.sh` is there. This changes no running code. It must be a clean checkout first: before 6a, chats in the `/home/dish/dish` workspace ran in the live checkout, so agents may have left files there. Then `dish-update` would refuse with "local changes", and the old unit would keep running against the new launcher, the very window step 4 avoids. So the command pulls only when `git status` lists nothing:

   ```sh
   incus exec minideb:dish --project dish -- su - dish -c 'test -z "$(git -C ~/dish status --porcelain)" && git -C ~/dish pull --ff-only origin main'
   # or, through Minideb:
   ssh <you>@<minideb-host> "incus exec dish --project dish -- su - dish -c 'test -z \"\$(git -C ~/dish status --porcelain)\" && git -C ~/dish pull --ff-only origin main'"
   ```

   The single quotes keep `$(…)` and `~` for `dish`'s shell to expand. If it prints nothing and fails, run `git -C ~/dish status` as `dish` (`incus exec minideb:dish --project dish -- su - dish -c 'git -C ~/dish status'`), clear what it lists, and run it again. Missed, the failure is harmless: step 4 then stops at once with `env: '/home/dish/dish/deploy/update.sh': No such file or directory` (exit 127), and nothing changes.
4. **Right away, the dry run and the update.** Run steps 3 and 4 back to back: the old unit still runs `pnpm dsh web` from the checkout, so a restart between them (a crash, `Restart=on-failure`) would start it through the new launcher, on an empty dev store.

   ```sh
   incus exec minideb:dish --project dish -- dish-update
   incus exec minideb:dish --project dish -- dish-update --apply
   ```

   The dry run should say `unit: changes` and `restart: needed (no record of a start)`. `--apply` restarts once and exits 0. A second `--apply` says `restart: not needed`.
5. **Check:**
   - `dish-url` prints a link that signs you in.
   - Over `https://dish.<tailnet>.ts.net`: Settings → General → Work details survives a reload, Settings → Models loads, and while Copilot has no route the footer card shows.
   - A new chat in the scratch workspace (see [One-time steps on the VM](#one-time-steps-on-the-vm)) has `/home/dish/work/scratch` as its `pwd`, and no workspace points at `/home/dish/dish`.
   - Settings → Prompts, Skills and History show the VM's store.
   - An agent's `printenv DISH_REMOTE DISH_ENV DSH_DISH_HOME` prints nothing.
6. **Clean up** when it has proved itself: the play's old record of the last start, `~dish/.local/state/fleet-dish`. Nothing reads it any more. Remove it as `dish`, not as root, since the account can write that tree:

   ```sh
   incus exec minideb:dish --project dish -- su - dish -c 'rm -rf ~/.local/state/fleet-dish'
   ```

Run from your desktop's terminal, `dish-update` takes the `--pty` path, so the script's stderr arrives on stdout. That `incus exec` gives it a controlling terminal was checked on 2026-10-02: `incus exec minideb:dish --project dish -- sh -c '(: </dev/tty) && echo ctty'` printed `ctty`.

## Signing in

dsh makes a new random access token each time it starts, and prints the URL with it on stdout. On the VM that goes to the unit's journal. `url.sh` reads it from there and prints the link. Run it through fleet's `dish-url`, which runs it as `dish` the way `dish-update` runs `update.sh`:

```sh
incus exec minideb:dish --project dish -- dish-url
```

Through Minideb, it's `ssh <you>@<minideb-host> incus exec dish --project dish -- dish-url`.

- **What it prints.** Exactly one line on stdout, `https://<DISH_TRUSTED_HOST>/?token=<token>`, and nothing else. The host comes from `deploy.env`. The token comes from the last `dsh web:` line in the service's journal since its current start, which `systemctl --user show` gives.
- **When it can't,** it says why on stderr, never with the token, and exits 1: the service isn't running (`url: dish-web.service isn't running; start it with dish-update --apply`), dsh hasn't printed its sign-in line since it started (`url: dsh hasn't printed its sign-in line since it started at <time>; try again in a few seconds`), or `deploy.env` is missing or unusable.
- **Who runs it.** Only the account, like `update.sh`. Any user but the account, root included, exits 2 with `url: run dish-url as root (incus exec dish --project dish -- dish-url), or this script as dish`.
- **No arguments.** Any argument exits 2 with `url: takes no arguments`.
- **It prints a secret, on purpose.** It's for your terminal. Don't paste the output anywhere.

Open the link once, on the tailnet name. dsh then sets a cookie for that name, which lasts 30 days and survives restarts: it is signed with a secret kept in dsh's credential file, not with the token. You need the link only for a new browser, or every 30 days. If 30 days is too short, change `cookieMaxAgeDays` on the `connection` row.

Use the tailnet name, not the VM's tailnet IP or short name. dsh answers `/api` calls only for the loopback and the trusted host, so another name loads the page and nothing on it works.

## Settings over the tailnet

On its own, dsh lets a browser change the host's own settings, and keep UI preferences such as Work details, only on a page opened on a loopback name (`localhost`, `127.x` or `[::1]`). It decides from the address in your browser. dish's [`dish-web`](../plugins/web) plugin, which `install.sh` links with the other bundles, lifts that for the trusted host: on `https://dish.<tailnet>.ts.net` the page counts as the operator's own machine. So every Settings page, Settings → Models and provider sign-ins included, works on the tailnet name.

It allows no request that was refused before: anyone who passes the Host check with the sign-in cookie could already write settings and credentials. Every browser on that name writes the one shared settings document. Its README has the details and the risk.

### Fallback: a tunnel

If Settings → Models still says "settings are unavailable in this browser" on the tailnet name, or Work details doesn't survive a reload, `dish-web` isn't marking the page. It is turned off (`enabled: false` on its row of the profile), its `hosts` list leaves the tailnet name out, or a dsh upgrade changed what it relies on (its pin test is there to catch that first). Until that's fixed, open a tunnel from your desktop to the VM's `127.0.0.1:3080`, through Minideb, as fleet's `docs/dish.md` reaches the guest:

```sh
ssh -i ~/.ssh/<fleet-host-key> \
  -o ProxyCommand="ssh -i ~/.ssh/<fleet-host-key> -W %h:%p <you>@<minideb-host>" \
  -N -L 127.0.0.1:3081:127.0.0.1:3080 fleet@<the guest's address>
```

Then open `http://127.0.0.1:3081/?token=…`, with the token from `dish-url`'s link. dsh sets a separate cookie for that address. Close the tunnel when you're done.

## One-time steps on the VM

Each is entered on `https://dish.<tailnet>.ts.net`, or through the tunnel if `dish-web` isn't working, so nothing passes through fleet or Git. dsh keeps the sign-ins in `~dish/.dsh/.credentials.yaml`, and they survive restarts and updates.
- **Copilot, the first sign-in.** On a fresh install Settings → Models has no Copilot provider yet: dish-copilot adds the `github-copilot` route only after a first sign-in. Until then its sign-in card sits in the Models page's footer, titled "GitHub Copilot". Sign in there and approve the device code at <https://github.com/login/device>. The route and its models appear, and the footer card goes. Later sign-ins, after a sign-out, use the card on the Copilot provider.
- **TypeSafe.** Paste the key on **Settings → Judge**. Without it the judge fails closed: the main agent asks you for every shell command, and a crew child's is refused.
- **A workspace for general chats.** dsh's web UI starts every chat in a workspace. It has no chat without one, and no default setting: a new chat goes to the current chat's workspace, else the one used last. `dish-workspaces` registers `/home/dish/work/scratch` as "scratch" once, at its first start (one you added by hand after 6a is adopted, with its title). Not `~/work` itself: a workspace's folder is where agents write without asking, dsh reads `~/work/.env` when the service starts, and the projects' clones live under `~/work`. A scratch workspace you remove stays removed; delete `~/.local/state/dish/workspaces/scratch` to have it registered again at the next start.
- **The GitHub App.** See [The GitHub App](#the-github-app).
- **No workspace for the live checkout.** Remove any workspace for `/home/dish/dish` (its row's menu in the sidebar). That removes only the record: the checkout stays, and its chats move to "Ungrouped". Don't continue those chats; they still run in the checkout, where agents could write the deployed code without asking.
- **The model.** A new chat may start on DeepSeek's own model, which has no key here. Pick a Copilot model (e.g. GPT-6.1 Sol) from the model menu.

## The GitHub App

dish's projects ([`dish-projects`](../plugins/projects/) and [`dish-workspaces`](../plugins/workspaces/), step 6b) clone and fetch through a GitHub App: read for agents' git, write only for `open_pr` (step 7). The plan gives prod and dev an App each (its rollout names them `bketelsen-dish`, installed on `bketelsen` and `frostyard` for selected repos, and `bketelsen-dish-dev`, on a test repo only). Both exist: `bketelsen-dish`, made with write access on 2026-10-03, is the one the VM uses, and dev keeps `bketelsen-dish-dev`. You make an App on GitHub, paste its ID and private key on **Settings → GitHub App**, and add projects on **Settings → Projects**. The plan's [rollout](../docs/plans/2026-10-02-projects.md#the-rollout-for-you) has the steps and the checks.
- **The key** is kept in dsh's credential file (`~/.dsh/.credentials.yaml`), never in the config store, and never shown again.
- **Agents' git** gets a read token for the projects' repos through a credential helper each clone's config names, so `git fetch` works and `git push` is refused. Only `open_pr` pushes: a write token dish mints in memory for that one push, to the project's HTTPS URL, never forced.
- **Write permissions** (step 7): Contents and Pull requests read and write, and Checks and Commit statuses read (for `pr_feedback`), which each installation accepts once on GitHub. The prod App can write already, so each project's default branch needs a ruleset now (a pull request with one approval, no force pushes or deletions, never the App on the bypass list): [the orchestrator plan's rollout](../docs/plans/2026-10-03-orchestrator.md#the-rollout-for-you), step 2, has the steps.
- **The clones** are `~/work/<owner>/<repo>`. A clone already there is adopted if its origin is the repo on GitHub; one with a deploy-key alias origin (`git@github-dish:…`, from before 6b) isn't. Onboarding names it; move it aside.
- **Setup** (a project's `setup`, such as `pnpm install`) runs outside the sandbox only in dish's own fresh clone, at onboarding, with the unit's `PATH` (dish's Node and pnpm; a repo on mise needs a setup such as `mise trust && mise exec -- pnpm install --frozen-lockfile`). In a task worktree it doesn't run outside the sandbox: the `worktree` tool gives the command, which runs in the sandbox before the work starts (the home directory is writable on the VM, so it needs no escalation), and the main agent runs it escalated only if that fails with "Read-only file system", which the judge may allow or put to you.

## Prod and dev

dish has two configurations. Only the VM's service is prod; everything else is dev, by default. The [ops spec](../docs/specs/ops.md#prod-and-dev) has the reasons.

| | prod | dev (default) |
|---|---|---|
| Who | the `dish-web` service only | `pnpm dev` and `pnpm dsh …`, run by you or by an agent |
| dsh home | `~/.dsh` | `<checkout>/.dev/dsh` |
| dish's config, state, data, cache | the account's XDG directories | `<checkout>/.dev/{config,state,data,cache}/dish` |
| port | 3080, behind `tailscale serve` | 3090, loopback only |
| config store remote | `bketelsen/dish-config` | none, ever |

- **`DISH_ENV`** is `dev` or `prod`. Unset or empty means dev. Any other value is refused: `env: DISH_ENV must be dev or prod (unset means dev), not "<value>"`, exit 2.
- **The launcher,** `scripts/env.ts`, runs `pnpm dsh …`. In dev it sets `DSH_HOME=<checkout>/.dev/dsh`, `DSH_DISH_HOME=<checkout>/.dev` and `DISH_ENV=dev`, replacing inherited values. `DISH_ENV=prod` passes the environment through, except `PATH` and `NODE_PATH` (below). It sets no `XDG_*` variable and nothing of pnpm's: dsh passes its environment on to every agent shell, and those would move `gh`'s and git's configuration and pnpm's store.
- **Dev's `PATH` has nothing of the checkout's.** dsh passes its `PATH` on to every agent shell, and looks `bash` up on it for every command an agent runs, approved escalations outside the sandbox included. pnpm puts the checkout's `node_modules/.bin` first for `pnpm dsh` and `pnpm dev`, so an agent whose workspace holds the checkout could plant a `bash` there for every later command to run. So the launcher and `pnpm dev` give dsh (and install.sh and the watchers) your `PATH` without its relative entries, anything in the checkout, any `node_modules/.bin`, or pnpm's `node-gyp-bin`. The rest keeps its order. When nothing is left, it is `/usr/local/bin:/usr/bin:/bin`.
  - This covers a workspace at the checkout or a project folder above it. Your own directories on `PATH` (`~/.local/bin`, mise's installs) stay ahead of the system's, and a workspace that holds your home directory can write them.
  - The service never had this problem: it doesn't go through pnpm, and its unit's `PATH` is root-owned. Dev on the VM did, and is covered the same way.
- **No `NODE_PATH` into the checkout.** pnpm's shim for dsh, `node_modules/.bin/dsh`, exports a `NODE_PATH` that ends in the checkout's `node_modules/.pnpm/node_modules`, and dsh passes it on to every agent shell. Node's CommonJS `require` falls back to it for a bare name that no `node_modules` above the requiring file has (an optional dependency that isn't installed, say), so an agent whose workspace holds the checkout could plant a module there for a later command to load, approved escalations outside the sandbox included. So the launcher and `pnpm dev` start dsh's own script (the `bin` of `node_modules/@deepseek-ai/dsh`) with the node they run under, and remove `NODE_PATH` from what dsh, install.sh and the watchers get, an inherited one too. dsh needs none: it is ES modules, which never read `NODE_PATH`. Going around the shim also skips its other lookup: it runs a `node_modules/.bin/node` in place of node when there is one.
  - The service had this one too: its unit ran the shim. A chat whose workspace holds `~/dish`, the home directory say, could have planted a module for the service's later commands. The unit now runs `/opt/dish/node/bin/node` with dsh's script, and `deploy/test` checks that path against dsh's `package.json`. It took effect with the VM's update on 2026-10-03.
  - **Where it stops.** Anything an agent writes into the checkout runs at the next start: dsh's own files, `scripts/env.ts`, and for `pnpm dsh` and `pnpm dev` a `node_modules/.bin/node`, which pnpm finds first for the scripts' `node`. That waits for a restart, where a `bash` or a module planted for `PATH` or `NODE_PATH` took effect in the running dsh at once, for every later command.
- **`DSH_DISH_HOME`** moves all four of dish's directories at once (dish-kit's `xdgPaths`), ahead of `XDG_*`. dsh drops `DSH_*` names from agent shells, so it never reaches an agent's commands.
- **The service is prod** because its unit runs dsh's script directly, with the account's defaults. It sets no `DISH_ENV`: dsh would pass it on, and every agent's `pnpm dsh` would be prod.
- **Where the guarantee stops.** Dev is the default for `pnpm dsh` (the launcher) and `pnpm dev` only. dsh gives every agent shell the running dsh's own `DSH_HOME` (`dsh-shell-env`), and on the VM that is prod's `~/.dsh`. So `deploy/install.sh`, `pnpm exec dsh` or `node_modules/.bin/dsh`, run directly in an agent's shell on the VM, use prod's profile, and, with `DSH_DISH_HOME` dropped from agent shells, prod's `~/.config/dish` too. The environment doesn't stop that. What stops a write there is the sandbox: `~/.dsh` and `~/.config/dish` lie outside the workspace, and on the VM's writable home they are on the [protected list](#the-sandbox), so the command needs dsh's write escalation, which the judge may allow or put to you (for a crew child, the judge allows it or it is refused). A guard is a non-goal ([ops spec](../docs/specs/ops.md#the-boundary-of-the-guarantee), decision 1).
- **`pnpm dev`** installs dish into dev's profile with `install.sh`, with `DISH_REMOTE=''` whatever the environment says, then serves it on `127.0.0.1:3090` and prints `dev: open <url>`. Its dsh, and so every agent shell under it, gets none of `install.sh`'s inputs: `DISH_REMOTE`, `DISH_USER_*` and `DISH_PROFILE` are removed, and `DISH_ENV=dev` is set. It refuses `DISH_ENV=prod`. The [README](../README.md#setup) has how to use and stop it.
- **Dev's work root is inside the checkout.** Dev's clones are under `<checkout>/.dev/work`, inside the dish checkout's git repository and its pnpm workspace (the checkout's `pnpm-workspace.yaml`). A tool that looks in parent directories finds the checkout: `pnpm install` in a dev project with no `pnpm-workspace.yaml` of its own installs the dish checkout instead. For such a project, make its setup `pnpm install --ignore-workspace`, or use a test repo with its own workspace file. dish's own git stops looking at the clone (`GIT_CEILING_DIRECTORIES`).
- **Dev on the VM** listens on the VM's loopback, like the service. Reach it with a tunnel to `127.0.0.1:3090`, the same way as the [fallback tunnel](#fallback-a-tunnel), then open the link `pnpm dev` printed:

  ```sh
  ssh -i ~/.ssh/<fleet-host-key> \
    -o ProxyCommand="ssh -i ~/.ssh/<fleet-host-key> -W %h:%p <you>@<minideb-host>" \
    -N -L 127.0.0.1:3090:127.0.0.1:3090 fleet@<the guest's address>
  ```

## Before the first start

Only one machine may push to `bketelsen/dish-config`, and since October 2026 that is the VM's service. Dev's store never has a remote. How the store moved off the desktop, and the checks, are in the deploy spec's [Moving the config store](../docs/specs/deploy.md#moving-the-config-store). On a rebuilt VM, the first `dish-update --apply` starts the unit, whose first start restores the store from GitHub.

## Running install.sh by hand

For development, use `pnpm dev`, which runs `install.sh` into dev's profile. On the VM, `dish-update` runs it, with `install.env`'s inputs. By hand anywhere else, from a checkout with Node 24 and pnpm on `PATH`, give it `DISH_REMOTE=''`: only one machine may push to `bketelsen/dish-config`, the VM's service, and the real remote would make this machine's `dsh web` a second pusher.

To try it out with nothing real touched, use the empty remote and a scratch `DSH_HOME` (the default is `~/.dsh`). Read the profile with `pnpm exec dsh`, dsh's own binary: `pnpm dsh` goes through the launcher, which would replace `DSH_HOME` with dev's.

```sh
scratch=$(mktemp -d)
DSH_HOME="$scratch" DISH_REMOTE='' DISH_USER_NAME='Test' DISH_USER_EMAIL='test@example.invalid' ./deploy/install.sh
DSH_HOME="$scratch" pnpm exec dsh --profile web --dump-config | grep -A3 dish-
rm -rf "$scratch"
```

The first run builds the tree and creates the profile. A second run, with the same `DSH_HOME`, ends with `install: no changes to the profile`. It still runs `pnpm install` and `pnpm build` in the checkout.

## The sandbox

dsh runs each agent shell command in bwrap: `/` read-only, a fresh `/dev` and `/proc`, and in `workspace-write` mode a writable workspace and a `/tmp` that starts empty on every call. On the VM, dish adds the home directory, a `/tmp` that lasts and mise's shims, through dsh's own hook: the profile's `sandbox` row (`@deepseek-ai/dsh-sandbox-local`) has `runnerCommand: [~/dish/deploy/dish-sandbox]`, and dsh runs `dish-sandbox <its bwrap profile> -- bash -c <command>` instead of bwrap. The design is in the [sandbox-home spec](../docs/specs/sandbox-home.md).

- **What a command can write.** The workspace, `/tmp`, and the home directory less the protected list. So `pnpm install`, `go mod download`, `cargo build`, `pip install --user`, `mise install` and caches work without an escalation. The network is open, as before. `danger-full-access` (an escalated command) never goes through `dish-sandbox`.
- **`/tmp` is the VM's own** (since 2026-10-03). In place of dsh's empty per-call `/tmp`, `dish-sandbox` binds the machine's `/tmp` and sets `TMPDIR=/tmp` for the command. So a binary built to `/tmp/x` runs a call later, a main agent can hand a crew child a file there, and dsh's file tools (`read`, `write`, `read_image`) and a call's `workdir`, which run on the host, see the same `/tmp`. That is safe only because dsh keeps its own temp files (spill files, launch requests, an interactive shell's rc file) elsewhere: the unit sets `TMPDIR=~/.cache/dish/tmp`, under the protected `~/.cache/dish`, and `dish-sandbox` shares `/tmp` only when dsh's `TMPDIR` is at or under a protected path in the home. Without that (dev, or the old unit before the restart), a command gets dsh's empty `/tmp`, as before. The VM's `/tmp` is a 3.9 GB tmpfs that systemd-tmpfiles ages out after 10 days; a full one costs RAM but no longer stops dsh. **The rule that comes with it:** nothing that runs as `dish` outside the sandbox may keep files in `/tmp` that it later reads or runs, since a sandboxed command can write them. dsh's temp files are in the unit's `TMPDIR` (`~/.cache/dish/tmp`, aged out after 10 days before each start), and `update.sh` gives `install.sh` the same `TMPDIR`; run `install.sh` on the VM only through `dish-update`. Fleet's plays that become `dish` are worth checking against it.
- **mise's shims are at the end of a sandboxed command's `PATH`** (since 2026-10-03), when `~/.local/share/mise/shims` (or `$XDG_DATA_HOME/mise/shims`) exists, so a bare `go` or `cargo` is mise's. dish's own node and the system's tools come first. It is set inside the sandbox only, never on the unit's `PATH`: the shims directory is in the writable home, and dsh looks `bash` up on the unit's `PATH` for escalated commands, which so have no shims.
- **The protected list,** read-only whether it exists yet or not:
  - dish and dsh themselves: `$DSH_HOME` and `~/.dsh`, dish's four XDG directories (`~/.config/dish`, `~/.local/share/dish`, `~/.local/state/dish`, `~/.cache/dish` always, since a gate's `gateEnv` can move `XDG_*`, and also where `XDG_*` puts them), `$DSH_DISH_HOME`, and the checkout, `~/dish`, so no agent can change `dish-sandbox`;
  - credentials and git: `~/.ssh`, `~/.gnupg`, `~/.gitconfig`, `~/.config/git` and `~/.git-credentials`, since dish's own git reads the account's global config outside the sandbox;
  - files that run later outside the sandbox without anyone acting: `~/.config/systemd` and `~/.local/share/systemd`, `~/.config/environment.d`, `~/.config/autostart`, `~/.pam_environment`; the shell's startup files `~/.bashrc`, `~/.bash_profile`, `~/.bash_login`, `~/.bash_logout` and `~/.profile`, and `~/.bash_aliases`, `~/.bash_completion` and `~/.local/share/bash-completion`, which Debian's `.bashrc` and bash-completion read; `~/.config/mise`, fleet's global mise config; `~/.config/pnpm` and `~/.npmrc`, which pnpm reads when `install.sh` and dsh's plugin manager run it; and `~/node_modules`, `~/.node_modules` and `~/.node_libraries`, where node looks for a module dish's own `node_modules` doesn't have;
  - each `--protect <path>` (absolute, or `~/…`) added by hand after the path in the row's `runnerCommand`. A later install keeps them.
  - A path on the list is frozen: whatever it holds stays as it is, read-only. Add one only when its content can stay as it is.
- **Missing ones are made first,** outside the sandbox, as `dish`: a directory empty with mode 0700, a file empty with mode 0600, a `--protect` path as a directory. A made `~/.bash_profile` reads `~/.profile` (or `~/.bash_login`, when that exists), because a login bash reads only the first of the three, and an empty one would hide `~/.profile`.
- **Nothing protected can be moved out of the way.** Each directory between home and a protected path (`~/.config`, `~/.local/share`, and so on) is bound onto itself, so it is a mount point: it stays writable, but `mv` and `rm` on it, and on a protected path, fail with "Device or resource busy". A write to a protected path fails with "Read-only file system", and dsh offers the escalation, as before.
- **Its own failures** print `dish-sandbox: <reason>` and exit 1, and bwrap's print `bwrap: `. The row's `runnerFailureSignatures` make dsh report such a run as one that did not run, a sandbox problem, not the command's failure. The reasons: no `HOME`, a relative `HOME` (or `/`, or one that isn't a directory), no `--`, a `--protect` that isn't absolute or `~/…`, a protected path that is a symbolic link or sits under one (bwrap can't mount on a link: replace the link with what it points to), a protected path it can't make, or no bwrap at `/usr/bin/bwrap` or `/usr/local/bin/bwrap`. It runs outside the sandbox before every command, so it looks nothing up on `PATH`.
- **On for the VM, off by default elsewhere.** `update.sh` runs `install.sh` with `DISH_SANDBOX_HOME=on`. Dev keeps the read-only home, so a dev chat's agent can't write your real `~/.cache`, `~/.cargo` or mise's installs. To try it in dev, run `DISH_SANDBOX_HOME=on pnpm dev`; a later `pnpm dev` without it turns it off again. The checkout is protected, so a chat whose workspace is the checkout, or a folder in it, can't write there: use a workspace outside the checkout. Don't try it at all when your `PATH` has a directory in your home (`~/.local/bin`, `~/bin`, mise's shims): dsh looks `bash` up on `PATH` for every escalated command, so a sandboxed command could put one there that the next escalation runs.
- **Turning it on takes two updates** (done on the VM on 2026-10-03). The first `dish-update --apply` after this lands runs the `update.sh` it started with, which doesn't set `DISH_SANDBOX_HOME`, so the new `install.sh` leaves the row out (it does make dish's installs copies already). The new prompts already say the home is writable; until the second update, an agent that meets "Read-only file system" runs the command again escalated, as before. The second runs the new `update.sh`, which writes the row, says `install: profile changed`, and restarts.
- **Check the copies** after the update: this prints nothing, and `stat -c %h` on any file under `~/dish/node_modules/.pnpm/` prints `1`:

  ```sh
  incus exec minideb:dish --project dish -- su - dish -c 'find ~/dish/node_modules ~/.dsh/profiles/web/node_modules -type f -links +1 | head -3'
  incus exec minideb:dish --project dish -- su - dish -c 'stat -c %h ~/dish/node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/package.json'
  ```
- **Limits.**
  - Sandboxed code can leave things in the home directory that run later outside the sandbox: a binary in `~/.local/bin` or `~/go/bin`, a mise install, a poisoned cache. They run when an escalated command, or fleet's play, uses them. The protected list covers the files that run later without anyone acting; it does not stop a command that asks the user manager to run something (see the session bus in [Security notes](#security-notes)).
  - A workspace at or under a protected path is read-only, since the protections come last.
  - Caches are shared across workspaces.
  - dsh's `write` and `edit` tools keep their own fence (workspace and temp only). To write a file in the home directory, an agent uses `bash`.

## Security notes

- **Agents run as `dish`.** Its one sudo right is fleet's apt wrapper, `/usr/local/sbin/dish-apt-get`: `sudo /usr/local/sbin/dish-apt-get update`, or `install <package>…`. It takes plain Debian package names only, and runs `apt-get -o APT::Cmd::Pattern-Only=true install --yes --no-install-recommends --no-remove <names>`: each name is exactly that package, and nothing installed is removed to make room. Everything else, options, paths, `.deb` files and versions included, is refused. A package's maintainer scripts still run as root, so each install is a real grant.
- **sudo works only in an escalated command.** dsh's sandbox runs with `NoNewPrivs`, so sudo can't raise privileges inside it, writable home or not. A `dish-apt-get` install is an agent command that dsh runs outside the sandbox: for the main agent the judge allows it or asks you, and a crew child's is refused unless the judge approves. Installs into the home directory (`mise install`, `pnpm install`, `pip install --user`) need no escalation on the VM ([The sandbox](#the-sandbox)).
- **mise** is `/usr/local/bin/mise`, pinned and root-owned by fleet, so it can't update itself. The tools it installs live in `dish`'s home. Its shims aren't on the unit's `PATH`; `dish-sandbox` puts them at the end of each sandboxed command's (above), so a bare `go` works there, and `mise exec` is for the tools that something earlier on `PATH` shadows (`node`, `pnpm`, `python3`). Fleet also writes the account's mise config, `~/.config/mise` (on the protected list), which trusts configs under `~/work` and pins Node 24.21.0, pnpm 11.25.0, Go 1.27.1 and Python 3.14.8, and preinstalls them ([bketelsen/fleet#40](https://github.com/bketelsen/fleet/pull/40) and [bketelsen/fleet#41](https://github.com/bketelsen/fleet/pull/41), applied 2026-10-03).
- **Clones under `~/work`** fetch with the GitHub App's read token, through the credential helper. The token files in `~/.local/state/dish/workspaces/tokens/` are readable by agents: read-only, an hour each, and only for the projects' repos.
- **Never run `deploy/*.sh` as root by their paths.** `dish` can write them. Root's way in is `dish-update` and `dish-url`.
- **The sandbox confines writes, not reads.** On the VM it lets a command write the home directory except the protected list ([The sandbox](#the-sandbox)), and reads were never confined: an agent's shell can read anything `dish` can, including the deploy keys in `~/.ssh` (one of them read-write for `dish-config`) and `~/.dsh/.credentials.yaml` (the Copilot sign-in, the TypeSafe key, the browser-session secret and the GitHub App's private key. Since step 7 the App can write, for `open_pr`, so an agent set on it could mint a write token and push a branch; GitHub rulesets on each project's default branch keep anything from reaching it without a person's merge ([the orchestrator spec, question 1](../docs/specs/orchestrator.md#questions-for-you))). File modes don't help, since the agent is the same user. The desktop has the same exposure.
- **The session bus is open.** A sandboxed command can reach the account's D-Bus session bus and systemd user manager (`$XDG_RUNTIME_DIR/bus`, `$XDG_RUNTIME_DIR/systemd/private`), and through them have something run outside the sandbox, past the protected list. This is older than this hook and left open on purpose: the sandbox guards against accidents, not a determined agent, and the VM is the boundary.
- **The judge's gate doesn't guard reads.** Since [bketelsen/dish#11](https://github.com/bketelsen/dish/pull/11) (2026-10-03), a command the judge reads as read-only runs whether or not it serves the task, so `cat` on a credential file may run without asking. A command that would send what it read is judged on its own, and should read as irreversible, which asks you or is refused for a crew child. Secrets are masked in the judge's log and in what is sent to TypeSafe.
- **The backup holds the credential file.** The VM's nightly backup captures it, so the NAS copy is as sensitive as the VM.
