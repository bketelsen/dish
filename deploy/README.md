# Deploying dish

dish runs on its own VM, reachable only on your tailnet. The VM and its guest setup belong to the fleet repo (`~/projects/fleet`). This directory is the dish side: what to install, the unit that runs it, and the two scripts you run on the VM, `update.sh` and `url.sh`.

The design is in the [deploy spec](../docs/specs/deploy.md) and the [ops spec](../docs/specs/ops.md), and what a dsh host needs on Linux is in the [research note](../docs/research/2026-10-01-dsh-linux-host.md).

## What the VM runs

- **The service.** `dsh web`, as `dish-web.service`: a systemd user unit of the unprivileged `dish` account, which has linger on. Its one sudo right is fleet's apt wrapper (see [Security notes](#security-notes)).
- **The binary.** The unit runs the checkout's own dsh, `~/dish/node_modules/.bin/dsh`, not `pnpm dsh`. Only `pnpm dsh` goes through the launcher, which defaults to dev (see [Prod and dev](#prod-and-dev)). `pnpm dev` runs `scripts/dev.ts`, which is dev only, and `pnpm test`, `build` and `typecheck` use neither. The service is prod because it never goes through the launcher.
- **The working directory** is `~/work`, not the live checkout: dsh's fallback root for the sandbox, and where it reads a `.env`. It is also the work root of [`dish-workspaces`](../plugins/workspaces/): each project's clone is `~/work/<owner>/<repo>`, with its task worktrees in `.worktrees/`, and `~/work/scratch` is the scratch workspace for general chats. dsh's web UI starts every chat in a workspace, so chats stay out of the checkout as long as no workspace points at it.
- **The port.** It listens on `127.0.0.1:3080` only. Nothing listens on the VM's own address.
- **The address.** `tailscale serve` puts it at `https://dish.<tailnet>.ts.net`, with a tailnet certificate. The tailnet needs HTTPS certificates enabled in the admin console first.
- **The code.** A checkout of `bketelsen/dish` at `~dish/dish`, with the profile at `~dish/.dsh/profiles/web`.
- **The state.** It lives in `dish`'s home:
  - `~/.dsh`: dsh's sessions and its credential file;
  - `~/.config/dish/config.git`: the config store, pushed to `bketelsen/dish-config`. The VM is its only pusher;
  - `~/.local/state/dish`: the judge's decision log; `deploy/`, `update.sh`'s lock and record of the last start; `projects/status.json`, each project's onboarding status; and `workspaces/`, each clone's and worktree's record, setup logs, and the GitHub App's read tokens (`workspaces/tokens/<owner>`, 0600, removed when dsh stops);
  - `~/.local/share/dish`: crew's records.

## What the files here do

| File | What it is |
|---|---|
| `install.sh` | Builds dish and installs it into a dsh profile. Idempotent. |
| `profile.ts` | Writes dish's rows into the profile's `cordis.patch.yml`. `install.sh` runs it. |
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
| `DSH_HOME` | Where profiles live. Default `~/.dsh`. |

Its steps, in order:
1. **Build.** `pnpm install --frozen-lockfile`, then `pnpm build`.
2. **The profile.** If `$DSH_HOME/profiles/$DISH_PROFILE` is missing, dsh creates it. For `web` that is its shipped profile; any other name is copied from `web`.
3. **The rows.** `profile.ts` writes dish's rows into the profile's `cordis.patch.yml`:
   - **The `dish-config` row** gets `remote`, `userName` and `userEmail`, and nothing else.
   - **The `agent-preset-registry` row** makes the `dish` preset the default for new tasks, when no default is chosen yet.
   - Other rows, comments and key order stay as they are. A file that is already right is not rewritten.
4. **The bundles.** For copilot, config, prompts, skills, crew, judge, web, projects and workspaces, in that order (projects after config, whose store it uses, and workspaces after projects, whose types it imports), `pnpm exec dsh plugin --profile <profile> add ./plugins/<name>`, only when the profile doesn't link it yet. That is dsh's own binary, not the launcher, so the profile is the one `DSH_HOME` names.

It prints what it did, and its last line is `install: no changes to the profile` or `install: profile changed`. On a failure it stops and names the step on stderr, as `install: FAILED at step: …`. It prints nothing secret.

**Isolation.** Every dsh command `install.sh` runs gets its four XDG directories pointed at a throwaway directory, which is removed on exit. A dsh command that loads a profile boots its plugins, and `dish-config` creates `~/.config/dish/config.git` when it boots. An install that did that on a fresh machine would leave an empty local store, and the first start with a remote would then push it over the one on GitHub instead of restoring it. In dsh 0.2.0-rc.2 the two commands the script uses boot nothing, so this guards against a later dsh. `HOME` and `DSH_HOME` stay real, so the profile lands where `dsh web` reads it. Those commands also run without `DSH_DISH_HOME`: under `pnpm dev` the launcher sets it, and it moves dish's directories ahead of `XDG_*`, so the throwaway directories would otherwise do nothing.

**The store-pin contract.** pnpm records the store a profile was first used with, and refuses to work on it with any other store. So `install.sh` looks up the store pnpm would use (`pnpm store path`) and hands it to each dsh command, instead of letting the throwaway directory pick a new one. dsh's plugin manager inside `dsh web` works the store out again, from the unit's environment. Both must give the same store, so `HOME`, `XDG_DATA_HOME` and `PNPM_HOME` have to be the same for `install.sh` and for the unit. Set none of them for just one of the two. `update.sh` keeps this by running `install.sh` in the unit's clean environment.

**The default preset.** The `dish` preset is set as the default on the first install only. A default chosen in Settings → Agent presets is kept by every later update.

### What the unit expects

- **`/opt/dish/node`.** A symlink to the pinned Node install (24.21.0), with pnpm (11.25.0) in its `bin`. The unit's `PATH` is `/opt/dish/node/bin:/usr/local/bin:/usr/bin:/bin`. Agents' shell commands inherit it, so it is also what a command can run. `update.sh` reads it from the unit, and runs `install.sh` with it.
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

`minideb` is your desktop's Incus remote for Minideb. Without it, go through Minideb: `ssh bjk@10.0.1.175 incus exec dish --project dish -- dish-update`, and so on. On Minideb itself it's `incus exec dish --project dish -- dish-update`. The scripts' own hints, such as `run dish-url for a fresh sign-in link (incus exec dish --project dish -- dish-url)`, give that form for Minideb itself; from the desktop, add the `minideb:` remote.

### Who runs it

- **`update.sh` runs only as the account** that owns the checkout (`dish`). `dish`, and so any agent, can write the file, so root running it would run whatever was put there. Run as root, or as anyone else, it exits 2 with `update: run dish-update as root (incus exec dish --project dish -- dish-update [--apply] [<ref>]), or this script as dish`.
- **`dish-update` is root's way in.** It is a root-owned wrapper fleet installs at `/usr/local/sbin/dish-update`, and its one command is `runuser`: it drops to `dish` and runs `~dish/dish/deploy/update.sh` under `env -i`, with only `HOME`, `USER`, `LOGNAME`, `XDG_RUNTIME_DIR` and the unit's `PATH`. Root reads and runs nothing of `dish`'s. Arguments pass through, and so does the exit code.
- **With a terminal,** as when you run it from your desktop's terminal, `dish-update` passes `--pty` to `runuser`, so the script runs on a terminal of its own and can't reach root's. Then its stderr arrives on stdout, with CRLF line ends. Without one, as through `ssh` without `-t`, it passes `--no-pty`, and stdout and stderr stay apart.
- **As `dish` itself,** in a shell that is already the account's, `~/dish/deploy/update.sh [--apply] [<ref>]` does the same.
- **A clean environment.** The script runs itself again under `env -i`, with `HOME`, `USER`, `LOGNAME`, `XDG_RUNTIME_DIR=/run/user/<uid>`, the `PATH` of the checkout's unit, `TMPDIR` and `LANG`. No `XDG_*` directories, `PNPM_HOME`, `DSH_*` or `NODE_ENV`, as for the unit, so the store-pin contract holds.
- **One at a time.** A lock, `~/.local/state/dish/deploy/lock`, refuses a second run while one is going.

### What it does

1. **Reads the inputs:** `install.env` (as above) and `deploy.env`, which must have exactly one `DISH_TRUSTED_HOST` line with a bare host name.
2. **Fetches** `origin`.
3. **Finds the target:** `origin/main`, or the ref you give. A target without `deploy/update.sh`, `deploy/install.sh` or the unit is refused, so a rollback to before `update.sh` existed can't happen.
4. **Reports** what it would do (below), and whether the service would restart.
5. **Checks the checkout.** It refuses local changes, listing up to 10 paths; ignored files such as `node_modules` and `.dev/` don't count. With no ref, it must be on `main` (or detached after a rollback), and `main` must fast-forward to `origin/main`. It refuses to leave commits behind on a detached HEAD, ones that no branch or tag has. It never resets anything.

   The dry run stops here. Every refusal comes before the first change, so a dry run that passes means `--apply` can start, and a dry run that finds a refusal exits 1.
6. **Moves the checkout:** `git merge --ff-only` on `main`, switching back to `main` first after a rollback, or `git switch --detach <ref>`.
7. **Runs `install.sh`** with `install.env`'s inputs, in the clean environment, with the target unit's `PATH`. Its output, stderr included, appears on `update.sh`'s stdout.
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

Until 6a, fleet's guest play updated the checkout, ran `install.sh` and restarted the unit. The VM's checkout predates `update.sh`, so the hand-over runs once, in this order:

1. **`ops` reaches `main`, as one merge.** The unit that runs dsh directly must land with the launcher that `pnpm dsh` now goes through. With the old unit's `pnpm dsh web`, the VM would come up on an empty dev store.
2. **The fleet PR, [bketelsen/fleet#38](https://github.com/bketelsen/fleet/pull/38) (merged, fleet c5bb7f6).** Its docs follow-up is [bketelsen/fleet#39](https://github.com/bketelsen/fleet/pull/39). Run the guest play one last time: preview, apply and rerun, with the secrets left out. Expect `install.env`, `~dish/work`, `/usr/local/sbin/dish-apt-get` with its sudoers file, `/usr/local/sbin/dish-update` and `/usr/local/sbin/dish-url`, and `/usr/local/bin/mise`. Expect no change to `~dish/dish`, the profile or the unit. The rerun reports no changes.
3. **Fast-forward the checkout once by hand,** so that `update.sh` is there. This changes no running code. It must be a clean checkout first: before 6a, chats in the `/home/dish/dish` workspace ran in the live checkout, so agents may have left files there. Then `dish-update` would refuse with "local changes", and the old unit would keep running against the new launcher, the very window step 4 avoids. So the command pulls only when `git status` lists nothing:

   ```sh
   incus exec minideb:dish --project dish -- su - dish -c 'test -z "$(git -C ~/dish status --porcelain)" && git -C ~/dish pull --ff-only origin main'
   # or, through Minideb:
   ssh bjk@10.0.1.175 "incus exec dish --project dish -- su - dish -c 'test -z \"\$(git -C ~/dish status --porcelain)\" && git -C ~/dish pull --ff-only origin main'"
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

Through Minideb, it's `ssh bjk@10.0.1.175 incus exec dish --project dish -- dish-url`.

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
ssh -i ~/.ssh/semaphore-fleet-hosts \
  -o ProxyCommand="ssh -i ~/.ssh/semaphore-fleet-hosts -W %h:%p bjk@10.0.1.175" \
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

dish's projects ([`dish-projects`](../plugins/projects/) and [`dish-workspaces`](../plugins/workspaces/), step 6b) clone and fetch through a GitHub App, read-only for now. Prod and dev each have their own (the rollout names them `bketelsen-dish`, installed on `bketelsen` and `frostyard` for selected repos, and `bketelsen-dish-dev`, on a test repo only). You make them on GitHub, paste each App's ID and private key on **Settings → GitHub App**, and add projects on **Settings → Projects**. The plan's [rollout](../docs/plans/2026-10-02-projects.md#the-rollout-for-you) has the steps and the checks.
- **The key** is kept in dsh's credential file (`~/.dsh/.credentials.yaml`), never in the config store, and never shown again.
- **Agents' git** gets a read token for the projects' repos through a credential helper each clone's config names, so `git fetch` works and `git push` is refused. Only the harness will push (step 7).
- **The clones** are `~/work/<owner>/<repo>`. A clone already there is adopted if its origin is the repo on GitHub; one with a deploy-key alias origin (`git@github-dish:…`, from before 6b) isn't. Onboarding names it; move it aside.
- **Setup** (a project's `setup`, such as `pnpm install`) runs outside the sandbox only in dish's own fresh clone, at onboarding.

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
- **The launcher,** `scripts/env.ts`, runs `pnpm dsh …`. In dev it sets `DSH_HOME=<checkout>/.dev/dsh`, `DSH_DISH_HOME=<checkout>/.dev` and `DISH_ENV=dev`, replacing inherited values, and puts the checkout's `node_modules/.bin` first on `PATH`. `DISH_ENV=prod` passes the environment through. It sets no `XDG_*` variable and nothing of pnpm's: dsh passes its environment on to every agent shell, and those would move `gh`'s and git's configuration and pnpm's store.
- **`DSH_DISH_HOME`** moves all four of dish's directories at once (dish-kit's `xdgPaths`), ahead of `XDG_*`. dsh drops `DSH_*` names from agent shells, so it never reaches an agent's commands.
- **The service is prod** because its unit runs dsh's binary directly, with the account's defaults. It sets no `DISH_ENV`: dsh would pass it on, and every agent's `pnpm dsh` would be prod.
- **Where the guarantee stops.** Dev is the default for `pnpm dsh` (the launcher) and `pnpm dev` only. dsh gives every agent shell the running dsh's own `DSH_HOME` (`dsh-shell-env`), and on the VM that is prod's `~/.dsh`. So `deploy/install.sh`, `pnpm exec dsh` or `node_modules/.bin/dsh`, run directly in an agent's shell on the VM, use prod's profile, and, with `DSH_DISH_HOME` dropped from agent shells, prod's `~/.config/dish` too. The environment doesn't stop that. What stops a write there is the sandbox: `~/.dsh` and `~/.config/dish` lie outside the workspace, so the command needs dsh's write escalation, which asks you (or the judge, for a crew child). A guard is a non-goal ([ops spec](../docs/specs/ops.md#the-boundary-of-the-guarantee), decision 1).
- **`pnpm dev`** installs dish into dev's profile with `install.sh`, with `DISH_REMOTE=''` whatever the environment says, then serves it on `127.0.0.1:3090` and prints `dev: open <url>`. Its dsh, and so every agent shell under it, gets none of `install.sh`'s inputs: `DISH_REMOTE`, `DISH_USER_*` and `DISH_PROFILE` are removed, and `DISH_ENV=dev` is set. It refuses `DISH_ENV=prod`. The [README](../README.md#setup) has how to use and stop it.
- **Dev on the VM** listens on the VM's loopback, like the service. Reach it with a tunnel to `127.0.0.1:3090`, the same way as the [fallback tunnel](#fallback-a-tunnel), then open the link `pnpm dev` printed:

  ```sh
  ssh -i ~/.ssh/semaphore-fleet-hosts \
    -o ProxyCommand="ssh -i ~/.ssh/semaphore-fleet-hosts -W %h:%p bjk@10.0.1.175" \
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

## Security notes

- **Agents run as `dish`.** Its one sudo right is fleet's apt wrapper, `/usr/local/sbin/dish-apt-get`: `sudo /usr/local/sbin/dish-apt-get update`, or `install <package>…`. It takes plain Debian package names only, and runs `apt-get -o APT::Cmd::Pattern-Only=true install --yes --no-install-recommends --no-remove <names>`: each name is exactly that package, and nothing installed is removed to make room. Everything else, options, paths, `.deb` files and versions included, is refused. A package's maintainer scripts still run as root, so each install is a real grant.
- **sudo works only in an escalated command.** dsh's sandbox runs with `NoNewPrivs`, so sudo can't raise privileges inside it. An install is an agent command that dsh runs outside the sandbox: the main agent asks you, and a crew child's is refused unless the judge approves.
- **mise** is `/usr/local/bin/mise`, pinned and root-owned by fleet, so it can't update itself. The tools it installs live in `dish`'s home. Its shims aren't on the unit's `PATH`, so agents run tools with `mise exec`.
- **Clones under `~/work`** fetch with the GitHub App's read token, through the credential helper. The token files in `~/.local/state/dish/workspaces/tokens/` are readable by agents: read-only, an hour each, and only for the projects' repos.
- **Never run `deploy/*.sh` as root by their paths.** `dish` can write them. Root's way in is `dish-update` and `dish-url`.
- **The sandbox confines writes, not reads.** An agent's shell can read anything `dish` can, including the deploy keys in `~/.ssh` (one of them read-write for `dish-config`) and `~/.dsh/.credentials.yaml` (the Copilot sign-in, the TypeSafe key, the browser-session secret and the GitHub App's private key, which is why the App is read-only for now). File modes don't help, since the agent is the same user. The desktop has the same exposure.
- **The judge's gate is the guard.** Reading a credential file doesn't serve a coding task, so the gate asks you, or refuses for a crew child. Secrets are masked in the judge's log and in what is sent to TypeSafe.
- **The backup holds the credential file.** The VM's nightly backup captures it, so the NAS copy is as sensitive as the VM.
