# Spec: dish ops (prod and dev, updates)

Status: built on branch `ops`, 2026-10-02; awaiting review and the rollout. Revised before the plan by its checks (what changed, and the evidence, is under [Checks](#checks-2026-10-02)), and during the build (see [Notes from the build](#notes-from-the-build)). This is roadmap step 6a, the first part of step 6. It builds on the [deploy spec](deploy.md), whose rollout notes describe today's setup. The plan is [docs/plans/2026-10-02-ops.md](../plans/2026-10-02-ops.md).

## Summary

dish runs like any web app: a **prod** configuration, which only the VM's service uses, and a **dev** configuration, which is the default for everything else.
- **Dev data.** It lives in a git-ignored `.dev/` folder inside the checkout. Nothing run by hand, by `pnpm dev`, by a test or by an agent can reach prod's data unless it says `DISH_ENV=prod`.
- **Updates.** You run them yourself with a script on the VM, `deploy/update.sh`, through `incus exec` and fleet's root entry point, `dish-update`. A second script, `deploy/url.sh`, run through `dish-url`, prints the sign-in link when your cookie expires.
- **Fleet.** It goes back to provisioning only.
- **Default chat folder.** The service starts in `~/work`, so a chat opened without a workspace no longer lands in the live checkout.

## Decisions (from the 2026-10-02 discussion)

| # | Topic | Decision |
|---|---|---|
| 1 | Protecting dish from itself | No guards in dish. Separate prod and dev data, keep the live checkout out of every chat, and deploy only by hand. |
| 2 | Who deploys | Only you, with `deploy/update.sh` through `incus exec` (fleet's `dish-update`). Agents don't deploy dish. |
| 3 | Prod and dev | `DISH_ENV` is `prod` or `dev`, and dev is the default. Only the service is prod. It gets there by running dsh directly, with the account's defaults, and not by setting `DISH_ENV`: dsh passes its environment on to every agent shell, so a `DISH_ENV=prod` on the service would make every agent's `pnpm dsh` prod. |
| 4 | Where dev data lives | `<checkout>/.dev/` (git-ignored) holds dev's dsh home and dish's config, state, data and cache. pnpm's store stays the account's, for prod and dev alike ([Checks](#checks-2026-10-02)). A dev run then writes only inside the checkout, apart from pnpm's shared store and caches. |
| 5 | Fleet | Provisioning only: the VM, packages, Node and pnpm, the account, Tailscale and `tailscale serve`, the keys, the first clone, `deploy.env`, and the install inputs (`install.env`). Fleet stops updating the checkout, running the install, and installing or restarting the unit. dish owns its unit. |
| 6 | Workspaces | dish never sets one up here. The service's working directory moves to `~/work`. You've removed the `/home/dish/dish` workspace record by hand. Step 6b's onboarding creates project workspaces. |
| 7 | Installs with approval | `apt` through a narrow sudo rule (fleet), which allows one root-owned wrapper and nothing else. User-level tools through mise. Both are agent commands that write outside the workspace, so they go through dsh's escalation: the main agent asks you, and a child is refused unless the judge approves. |
| 8 | `update.sh` default | A dry run that shows what would change. `--apply` acts. A ref argument checks out that commit, as a rollback. |
| 9 | Sign-in link | `deploy/url.sh` prints `https://<tailnet name>/?token=…` from the service's journal. |
| 10 | Settings over the tailnet | A small host plugin, `dish-web`, marks pages on your trusted host (`--trusted-host`) as the operator's own machine, so Settings, durable UI preferences and the Models page work over `https://<tailnet name>` as on loopback. (Added 2026-10-02 at your request; see below.) |

## Non-goals

- Guards that refuse agent commands against dish's own process or files.
- Reaching dev on the VM from your browser. Use an SSH tunnel to `127.0.0.1:3090` for now. A second `tailscale serve` port can come later.
- Projects, clones, worktrees and the GitHub App (step 6b), and gates (step 6c).
- A per-checkout pnpm store. See [Checks](#checks-2026-10-02) for why, and step 6b for clones.

## Prod and dev

### The contract

| | prod | dev (default) |
|---|---|---|
| Who | the `dish-web` service only: it runs the checkout's dsh binary directly, never the launcher | everything else: `pnpm dev`, `pnpm dsh …` and agents |
| dsh home | `~/.dsh` | `<checkout>/.dev/dsh` |
| dish's config, state, data, cache | the account's XDG directories (`~/.config/dish`, `~/.local/state/dish`, `~/.local/share/dish`, `~/.cache/dish`) | `<checkout>/.dev/{config,state,data,cache}/dish` |
| pnpm store | the account's | the account's |
| dsh profile | `web` | `web`, in dev's dsh home |
| port | 3080, behind `tailscale serve` | 3090, loopback only |
| config store remote | `bketelsen/dish-config` | none, ever |

- **The launcher.** Root package scripts that run dsh go through a small launcher, `scripts/env.ts`, which Node runs with type stripping, as it runs `deploy/profile.ts`.
  - Unless `DISH_ENV=prod`, it sets `DSH_HOME=<checkout>/.dev/dsh` and `DSH_DISH_HOME=<checkout>/.dev`, and `DISH_ENV=dev`. It replaces inherited values, because dsh gives every agent shell its own `DSH_HOME`.
  - It sets no `XDG_*` variable and nothing of pnpm's.
  - `DISH_ENV=prod` passes the environment through. Any other value of `DISH_ENV` is refused with a message.
- **Why `DSH_DISH_HOME` and not `XDG_*`.** dsh hands its environment to every agent shell. It drops only `DSH_*` names and names that look like secrets.
  - `XDG_*` set on dev's dsh would reach every command an agent runs under it. `gh` would lose its sign-in, git and mise their config, and pnpm would work out another store, then refuse to work in any existing checkout without a terminal.
  - `DSH_DISH_HOME` starts with `DSH_`, so dsh drops it from agent shells. No `.env` file can set it either, since dsh takes `DSH_*` only from the launching environment.
- **Plugins.** They keep calling `xdgPaths` from dish-kit. It honors `DSH_DISH_HOME` (as `<it>/{config,state,data,cache}/<app>`) before `XDG_*`. Plugins don't branch on `DISH_ENV`; the variables are the switch.
- **pnpm.** Prod and dev use the account's store, so the store-pin contract is unchanged. An agent's own `pnpm install` that brings in new packages writes that store, outside the sandbox, and needs approval, as it does today. A per-checkout store is left for step 6b, with clones.
- **Tests.** They already use temp directories. dsh drops `DSH_DISH_HOME` from agent shells, so a test an agent runs never sees dev's directories.

### `pnpm dev`

1. Run `deploy/install.sh` under the launcher's variables, with `DISH_REMOTE=''` whatever the environment says, and the checkout's git identity.
   - It is idempotent, so every run does it.
   - It installs the dependencies (the account's store) and builds the client bundles.
   - On the first run it creates dev's profile and installs dish into it. Later runs link any new bundle.
2. Start `dsh web` on `127.0.0.1:3090` (`--port` changes it), from the checkout, with the client bundles in watch mode. Print the sign-in link.
3. Refuse `DISH_ENV=prod`.

Dev starts empty: no sessions, a fresh config store, and no Copilot sign-in. The first Copilot sign-in on a fresh profile is the backlog item "the sign-in card on a fresh install". 6a fixes it, because every new dev checkout would hit it otherwise.
- **What exists today.** The card already appears in dsh's add-provider draft (Settings → Models → Add model provider → `github-copilot`), but nothing points there.
- **The fix.** dish-copilot adds the same card to the Models page's footer while no `github-copilot` route exists. A successful sign-in adds the route, as now, and the footer card goes away.

### The desktop

- The desktop switches from `pnpm web` to `pnpm dev`. `pnpm web` goes away.
- The old `~/.dsh/profiles/web` and `~/.config/dish` are no longer used by anything. Remove them by hand when you like.
- The desktop has no prod.

## The service unit (`deploy/dish-web.service`)

| Line | Now | 6a |
|---|---|---|
| `WorkingDirectory` | `%h/dish` | `%h/work` |
| `Environment` | `PATH=…` | `PATH=…`, unchanged. No `DISH_ENV` (see the contract) |
| `ExecStart` | `pnpm dsh web …` (from the checkout) | dsh's own binary in the checkout, `%h/dish/node_modules/.bin/dsh web --host 127.0.0.1 --port 3080 --no-open --trusted-host ${DISH_TRUSTED_HOST}`, so dsh's working directory, which is the default for new chats, is `~/work` |

Everything else stays: `EnvironmentFile` (`deploy.env`, which still holds only `DISH_TRUSTED_HOST`), `Restart=on-failure`, no sandboxing options (the deploy spec's reasons), and the store-pin contract.

**Checked.** dsh does not depend on starting in the checkout:
- The profile records each bundle as `link:<absolute path>`. Its lockfile and symlinks are relative from the profile to the checkout.
- `node_modules/.bin/dsh` finds its own files from its own path.
- A scratch install, started from another directory, served the page and loaded all six dish plugins.

dsh uses its working directory for three things:
- new chats with no workspace;
- the sandbox's fallback root;
- a `.env` file there, which it loads. dsh refuses `PATH`, `DSH_*`, `XDG_*` and the other launch variables from it, but other names reach the service. So keep `~/work` free of a `.env`.

## Settings over the tailnet (`dish-web`)

dsh treats only loopback pages as "the operator's own machine". On any other page:
- **Host settings** are unavailable, so the Models page fails with "settings are unavailable in this browser".
- **UI preferences**, such as Work details, are kept in memory only.

**Where the check lives.** It's made only in the browser, from `location.hostname`, or from a transport global, `__DSH_TRANSPORT__.ownsHost`, that dsh's desktop shell sets. The server never checks it. Any request that passes the Host check (`--trusted-host`) and carries the sign-in cookie can already write settings and credentials.

**What the plugin does.** `dish-web` adds one classic script row to the served page through dsh's documented `webserver/index-inject` hook. The script sets `globalThis.__DSH_TRANSPORT__ = { ownsHost: true }` only when:
- the page's hostname is one of the trusted hosts, which are the non-IP entries of `webRuntime.trustedHosts`, lower-cased and without port;
- and no transport global is already set.

**What it changes.** Only `isLoopback` changes, to true. The connection, the stream URL and module loading all stay on their defaults.

**What it gains you,** over the tailnet:
- durable Work details and other preferences;
- a working Models page, so Task 7's Copilot card is reachable;
- every settings page saving;
- "Open configuration file" appears. On the headless VM it does nothing useful, but it's harmless.

**The risk is a dependency on a shell-only field.** dsh documents the transport global as set by its desktop shell, saying "served pages never carry the global". A later dsh could give `ownsHost` other meanings. A pin test reads the installed `dsh-client-connection` and fails when its `isLoopback` computation no longer reads `transport?.ownsHost === true`, so a dsh upgrade has to re-check this.

**Security.** It adds no server capability: anyone holding the cookie for the trusted host can already call these methods. One thing does change: every browser on that host now writes the one shared settings document. With one user that's the intent.

**Config:** `dish-web` takes `hosts`, which overrides the derived list, and `enabled`, default true.

## `deploy/update.sh`

Run it from your workstation, through its Incus remote for Minideb:

```bash
incus exec minideb:dish --project dish -- dish-update                    # dry run: what would change
incus exec minideb:dish --project dish -- dish-update --apply            # update to origin/main
incus exec minideb:dish --project dish -- dish-update --apply 4b23ff0    # roll back to a commit
```

Without the remote, go through Minideb: `ssh bjk@10.0.1.175 incus exec dish --project dish -- dish-update`.

### Who it runs as and how

- **The account** is the owner of the checkout the script sits in (`dish` on the VM). `update.sh` runs **only as that account**, never as root. Run as root, it refuses and points to `dish-update`.
- **Root's entry point is `dish-update`,** a root-owned wrapper fleet installs at `/usr/local/sbin/dish-update`. It does one thing: `exec runuser --pty|--no-pty -u dish -- env -i HOME=… USER=dish LOGNAME=dish XDG_RUNTIME_DIR=/run/user/<uid> PATH=<the unit's PATH> ~dish/dish/deploy/update.sh "$@"`, with `--pty` only when the caller has a controlling terminal (see [Notes from the build](#notes-from-the-build)).
  - It never reads, sources or runs anything of dish's as root. `runuser` drops privileges first.
  - **Why (added 2026-10-02 after review):** root running `~dish/dish/deploy/update.sh` directly would execute a file the `dish` account can write. Anything acting as `dish`, such as an approved agent command or a package's install script, could then plant code that root runs at your next update.
- **The clean environment:** `XDG_*`, `PNPM_HOME`, `DSH_*` and `NODE_ENV` stay unset, as they are for the unit. That keeps the store-pin contract.
- **The journal:** `systemctl --user` and `journalctl --user -u dish-web.service` work as the account, because `dish` can read its own user journal (checked on the VM).
- **Any other account:** it refuses.
- **It updates the file it's running from,** so the body is one function called on the last line, `main "$@"; exit`. bash then reads the whole file before anything changes it.
- **One at a time.** A second run while one is going is refused (a lock under `~/.local/state/dish/deploy/`).

### Steps

1. **Fetch** `origin` in `~/dish`.
2. **The target** is `origin/main`, or the ref given (a commit or a tag).
3. **The dry run** prints:
   - HEAD and the target;
   - `git log --oneline HEAD..target`, or `target..HEAD` for a rollback;
   - whether the target's unit file, `deploy.env` or `install.env` differ from what the service last started with, and whether it would restart;
   - then it stops. It changes nothing but the fetched refs.
4. **`--apply` checks out the target:**
   - With no ref: the checkout must be on `main`, or detached after a rollback, in which case it switches back to `main`. Then `git merge --ff-only origin/main`.
   - With a ref: `git switch --detach <ref>`.
   - A checkout with local changes, or one that can't fast-forward, is refused and left alone. Ignored files, such as `node_modules` and `.dev/`, don't count.
5. **Run `install.sh`** with `DISH_REMOTE`, `DISH_USER_NAME` and `DISH_USER_EMAIL` from `~/.config/dish/install.env`, which fleet writes (see Fleet). The unit doesn't load that file, so these never reach dsh or an agent's shell. An empty `DISH_REMOTE` is refused: prod always pushes its store, and `install.sh` would remove the remote.
6. **Install the unit:**
   - copy `deploy/dish-web.service` to `~/.config/systemd/user/`, and `systemctl --user daemon-reload` when it changed;
   - create `~/work` if missing;
   - enable the unit if it isn't enabled.
7. **Restart** when the service isn't running, or `install.sh` changed the profile, or the service is stale. The service is stale when its last start doesn't match:
   - the checkout's revision;
   - the unit file;
   - `deploy.env` and `install.env`;
   - the Node and pnpm versions.

   The record of that start, the stamp, lives in `~/.local/state/dish/deploy/started`. A missing stamp counts as stale.
8. **Wait** until `127.0.0.1:3080` answers, for up to 120 seconds. Then write the stamp. A failed wait exits non-zero, leaves the stamp alone and prints the journal tail.
9. **Print:**
   - the new HEAD;
   - the unit's state;
   - the last 15 journal lines with every token-bearing line removed;
   - the hint to run `dish-url` for a fresh link.

**Exit codes:** 0 for done or nothing to do, 1 for a failed step (named on stderr, as `install.sh` does), and 2 for usage or the wrong account.

## `deploy/url.sh`

Run it as `incus exec minideb:dish --project dish -- dish-url`, fleet's root-owned wrapper, which runs `~dish/dish/deploy/url.sh` as `dish` the same way `dish-update` does.
- **What it prints:** `https://<DISH_TRUSTED_HOST>/?token=<token>`.
  - The token comes from the last `dsh web:` line in the service's journal since its current start.
  - The start comes from `systemctl --user show`. The host comes from `deploy.env`.
- **When there's no token:** the service isn't running or hasn't printed one, so it says which and exits 1.
- **Read access:** it runs only as the checkout's owner, which can read its own user journal. Run as root or anyone else, it refuses.
- **It prints a secret, on purpose.** It's for your terminal. Don't paste the output anywhere.

## Fleet (a reviewed PR in `~/projects/fleet`)

**Remove** from `dish_guest`:
- the fast-forward and the "on main" check;
- the `install.sh` run;
- installing, linking and checking the unit, and the PATH contract check;
- the restart;
- the `started` stamp;
- the wait;
- `fleet_dish_service_enabled`, which held back the first start. `update.sh --apply` starts the unit now.

**Keep:** first-time provisioning, including cloning `~/dish` when it's missing, enabling linger, and `deploy.env` as it is (one line, `DISH_TRUSTED_HOST`).

**Change:**
- **Root entry points.** Root-owned wrappers `/usr/local/sbin/dish-update` and `/usr/local/sbin/dish-url` (root:root, 0755). Each only `exec`s `runuser -u dish -- env -i <clean environment> ~dish/dish/deploy/{update,url}.sh "$@"`. See "Who it runs as and how".
- **`install.env`.** A new template writes `~/.config/dish/install.env` (mode 0600) with `DISH_REMOTE`, `DISH_USER_NAME` and `DISH_USER_EMAIL`, one `NAME=value` line each. `update.sh` reads it; the unit doesn't.
- **`~/work`.** It's created with the account's other directories.
- **apt.**
  - A root-owned wrapper, `/usr/local/sbin/dish-apt-get`, runs `apt-get update`, or `apt-get install` with Debian package names only.
  - A sudoers drop-in lets `dish` run exactly that wrapper without a password.
  - The play's "no sudo" check becomes "sudo for the wrapper only".
- **mise.** Install it for `dish`: a pinned release binary at `/usr/local/bin/mise`, checked against its SHA-256. Tools it installs live in `dish`'s home.
- **Docs.**
  - `docs/dish.md`: "Updating" points to dish's `deploy/update.sh`, and "Reaching it" to `url.sh`.
  - `docs/backups.md`'s restore runs `update.sh --apply` after the guest play.

**Deploy key:** the read-only key for `bketelsen/dish` stays. `~/work` clones of dish use it too, until step 6b's GitHub App.

## Rollout

The order matters. A dish whose `pnpm dsh` goes through the launcher, started by the old unit's `pnpm dsh web`, would come up on an empty dev store.
1. Merge 6a in dish, as one merge. The new unit, which runs dsh directly, ships in the same merge that routes `pnpm dsh` through the launcher.
2. Merge the fleet PR ([bketelsen/fleet#38](https://github.com/bketelsen/fleet/pull/38)). Run the guest play one last time: preview, apply, rerun.
   - It writes `install.env`, `~/work`, the apt rule, mise, and root's entry points, `/usr/local/sbin/dish-update` and `/usr/local/sbin/dish-url`.
   - It touches nothing of dish's checkout, profile or unit.
3. Fast-forward the VM's checkout once by hand. It predates `update.sh`: `incus exec minideb:dish --project dish -- su - dish -c 'git -C ~/dish pull --ff-only origin main'`. This changes no running code.
4. Right after it, run `dish-update`, then `dish-update --apply`. It installs, copies the new unit, restarts once (there is no stamp yet), and writes its stamp. Steps 3 and 4 run back to back: the old unit still runs `pnpm dsh web` from the checkout, so a restart between them (a crash, then `Restart=on-failure`) would start it through the new launcher, on an empty dev store.
5. Check:
   - over `https://<tailnet name>`, Settings → General → Work details survives a reload, and Settings → Models loads (`dish-web`);
   - a new chat opened with no workspace starts in `~/work`;
   - `dish-url` prints a link that signs you in;
   - Settings shows prod's data;
   - an agent's shell sees no `DISH_REMOTE`.
6. Move to `pnpm dev` on the desktop.

Checked already (2026-10-02): from the workstation, `incus exec minideb:dish --project dish -- sh -c '(: </dev/tty) && echo ctty'` prints `ctty`, so an interactive `dish-update` takes the `--pty` path.

## Testing

`node --test`, in `deploy/test/` and `scripts/test/`.
- **`update.sh`** runs against a temporary bare repo and checkout, with stub `id`, `getent`, `runuser`, `systemctl`, `journalctl`, `curl` and `pnpm` on `PATH`, and `install.sh` stubbed. Cases:
  - the dry run changes nothing;
  - `--apply` fast-forwards, rolls back with a ref, and switches back from a rollback;
  - local changes and a diverged `main` are refused;
  - the unit is copied and reloaded only when it changed;
  - restart only when stale, stopped, or the profile changed;
  - the stamp is written only after the wait succeeds;
  - `install.sh` gets exactly `install.env`'s inputs, and an empty remote is refused;
  - token lines are filtered from the journal tail;
  - root versus the account versus another account.
- **`url.sh`**, with a stub journal: the latest token since the last start; not running; no token; the host taken from `deploy.env`; not root.
- **The launcher:** dev's variables by default, replacing inherited ones; `prod` passes through; any other value is refused.
- **dish-kit:** `DSH_DISH_HOME` moves all four directories and wins over `XDG_*`. `install.sh` keeps it away from its dsh commands.
- **The unit file:** `WorkingDirectory`, the `ExecStart` path, the `PATH` line, and no `DISH_ENV` and no install inputs.
- **dish-copilot:** the status reports the route; the footer card shows only while there's none.
- **By hand, with scratch `HOME` and `XDG_*`:** `pnpm dev` starts on 3090 with nothing written outside `.dev/`. Compare a listing of the scratch home before and after.
- **No test finds the real home.** Every process a test or a live check spawns gets a scratch `HOME`, and an interactive shell a scratch `HISTFILE` too. Without them, bash and other tools fall back to the passwd home (see [Notes from the build](#notes-from-the-build)).

## Checks (2026-10-02)

These replace the open items. Each was run against a scratch `DSH_HOME` and scratch XDG directories, or read from code, before the plan.

- **Can dsh run from `~/work`? Yes.**
  - `install.sh` into a scratch `DSH_HOME` wrote `link:/<absolute checkout>/plugins/<name>` into the profile's `package.json`. The profile's lockfile and `node_modules` links are relative from the profile to the checkout. None of them involve dsh's working directory.
  - `<checkout>/node_modules/.bin/dsh web --host 127.0.0.1 --port 3191 --no-open`, started from an unrelated directory:
    - it served the page (its working directory confirmed through `/proc`);
    - dish-copilot and dish-config logged;
    - the new store got the seed commits of prompts, judge, crew and skills;
    - the five dish client bundles were served.
  - In dsh's code, the working directory is the default for a new chat (`dsh-api-session-controller`), the sandbox's fallback root (`dsh-base`'s `workspaceRoot: !!js process.cwd()`), and where the project `.env` is read (`dsh-app-boot`).
- **dsh's environment reaches agent shells.** `dsh-subprocess`'s `scrubbedParentEnv` copies the whole environment except names matching `KEY|PASSWORD|SECRET|TOKEN` and names starting with `DSH_`. `dsh-shell-env` then adds `DSH_HOME` (dsh's own), `DSH_SHELL`, `DSH_SESSION_ID`, `DSH_PROFILE` and `DSH_PROFILE_DIR`. Three things follow:
  - **`DISH_ENV=prod` on the unit** would reach every agent shell, so it's dropped (decision 3).
  - **`XDG_*` set for dev** would reach every agent shell, so dev moves dish's directories with `DSH_DISH_HOME` instead.
  - **Install inputs in `deploy.env`** would reach every agent shell, since the unit loads that file. Then an agent's `install.sh` that left out `DISH_REMOTE`, which the script exists to require, would pick up the real remote and make a second pusher. So they go in `install.env`, which the unit doesn't load.
- **The pnpm store.**
  - **pnpm 11.25 ignores `store-dir` in `.npmrc`.** A toy workspace's `pnpm store path` didn't move.
  - **`storeDir` in `pnpm-workspace.yaml` works,** relative to the workspace root. It would apply to every checkout and worktree of the repo, prod's included, and to every `pnpm` command in them.
  - **`pnpm_config_store_dir` in the environment beats it.** `npm_config_store_dir` is ignored.
  - **Moving the store aborts installs.** Moving it under an existing `node_modules`, by any of the three means (the workspace setting, the environment variable, or `XDG_DATA_HOME`), makes the next install that has work to do fail without a terminal: `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`. In a terminal, it offers to delete `node_modules`.
  - **The profile is its own workspace.** dsh's profile directory has its own `pnpm-workspace.yaml` (`packages: [.]`), so a repo setting never reaches the plugin manager. But `install.sh` asks `pnpm store path` from the checkout, so it would pin the repo's store into prod's profile. The unit's plugin manager would then refuse that profile (`ERR_PNPM_UNEXPECTED_STORE`).
  - **The cost of a store per checkout.** Every worktree would download every package, with no offline install.
  - **So:** the account's store everywhere, no repo setting, and no launcher setting. The store-pin contract stays as it is.
- **The Copilot card on a fresh profile.**
  - The card registers in the Models page's `settings.models.provider-card` seat and renders only on a card whose provider is `github-copilot`. A fresh profile has no such route, so there's no card on the list.
  - dsh renders the same seat in the add-provider draft, and `llm-pi-ai` registers the Copilot sign-in flow whether or not a route exists. So Add model provider → `github-copilot` already shows a working card, but nothing leads there.
  - The smallest fix is the `settings.models.footer` seat: one more registration of the existing panel, shown while the status says there's no route. That needs a `route` field in the status.
- **sudo for apt.** A sudoers rule for `apt-get install *` is root for whoever can run it: `apt-get` takes `-o` options that run commands (`APT::Update::Pre-Invoke`, `DPkg::Pre-Invoke`), and installs local `.deb` files. Hence the wrapper.
  - sudo works only in an escalated agent command. Inside `bubblewrap`, run with dsh's probe arguments, `/proc/self/status` shows `NoNewPrivs: 1`, so sudo can't raise privileges inside dsh's sandbox.
  - That is decision 7's path: the main agent asks you, and a child needs the judge.
- **mise vs brew: mise.**
  - mise isn't packaged in Debian trixie: `apt-cache show mise` on the VM finds no package.
  - Fleet installs a pinned release binary the way it installs Node: a checksum from the release's `SHASUMS256.txt`, a root-owned file, so it can't update itself.
  - brew on Linux wants `/home/linuxbrew`, set up with sudo, and keeps itself current, which fleet's "nothing updates on its own" rules out.
  - mise's shims aren't on the unit's `PATH` in 6a, so agents run tools with `mise exec`. Adding the shims is step 6b's call.
- **Disk.** No per-checkout store, so this open item is gone.

## Notes from the build

- **Root never runs dish's scripts.** The plan had `update.sh` and `url.sh` run as root and drop to the account themselves. Review found that root would then run a file the `dish` account, and so any agent, can write. Both now run only as the account, and exit 2 for root or anyone else, naming the entry point. Fleet's root-owned `dish-update` and `dish-url` are root's way in ("Who it runs as and how", above). Both scripts read the account's own user manager and user journal, which `dish` can read (checked on the VM).
- **The entry points pass `--pty` only with a controlling terminal.** `runuser -u` never calls `setsid()`, so without `--pty` the account's process would share root's session and terminal. There it could push input into root's shell (`TIOCSTI`), or, left running, read what root types next. With a terminal the entry points pass `--pty`, and the script's stderr then arrives on stdout, with CRLF line ends. Without one, as through `ssh` without `-t`, they pass `--no-pty`, and the two streams stay apart.
- **The apt wrapper names packages exactly and removes nothing.** It runs `apt-get -o APT::Cmd::Pattern-Only=true install --yes --no-install-recommends --no-remove <names>`. Without `Pattern-Only`, apt-get reads a name that is not a package as a regex, so `ripgre.` would also install `ripgrep-all`. Without `--no-remove`, `--yes` could remove an installed package (`sudo`, `tailscale`, `bubblewrap`) to make room. It also refuses a name ending in `-`, which `apt-get install` reads as "remove".
- **`update.sh`, beyond the steps above:**
  - `install.sh` and the Node and pnpm version checks get the `PATH` of the target's unit, read from git before the checkout moves, so an update installs with the tools of the service it starts. The script's own commands use the unit as it was checked out when it started.
  - A target without `deploy/update.sh`, `deploy/install.sh` or the unit is refused, so a rollback can't leave a checkout that `dish-update` can't run in.
  - A user manager that doesn't answer is refused before any change, and `deploy.env` must pass `url.sh`'s rule: exactly one `DISH_TRUSTED_HOST` line, with a bare host. A dry run that finds a refusal exits 1.
  - `daemon-reload` runs whenever the user manager may hold another definition: the file changed, the stamp's unit differs or there is no stamp, or the manager reports `NeedDaemonReload`. A reload that failed is so done again before the next restart.
  - A service that the run didn't restart, and that doesn't answer, gets one restart and a second wait before the run fails.
  - Every line it prints that mentions a token is left out, not only the journal's: commit subjects and `install.sh`'s output too. `install.sh`'s stderr appears on `update.sh`'s stdout. The journal tail's header is "credential lines removed".
  - Both scripts turn off `xtrace` first: a shell trace from the environment (`SHELLOPTS`, `BASH_ENV`) would print the journal's lines, token included.
  - Once the checkout has moved, a failure says where it is, whether the service was restarted, and the command to go on or to go back.
  - `DISH_UPDATE_CLEAN`, its own marker for the clean re-run, is refused when the environment holds any name besides the clean ones.
- **`url.sh`** reads the journal as the account (`journalctl --user`), resolves its own symlinks to find the checkout, and refuses a `deploy.env` with more than one `DISH_TRUSTED_HOST` line.
- **`dish-web` was added during the build,** at your request (decision 10, Task 10 of the plan). It is `install.sh`'s seventh bundle, after judge. A live check in a scratch profile, with a trusted-host name, showed Settings → Models loading with it and failing without it. Its pin test reads the `dsh-client-connection` that dsh itself serves, so bumping dsh alone can't leave it reading an old copy.
- **`pnpm dev` owns dsh's signals.** dsh handles SIGINT and SIGTERM only. A SIGHUP kills it without its shutdown, which can leave agent commands running, and a second signal during its shutdown makes it force-exit.
  - So `pnpm dev` starts dsh detached, in a session of its own, and only `pnpm dev` signals it: every Ctrl-C as SIGINT (a second one forces dsh out, as dsh does itself), and SIGTERM, SIGHUP and SIGQUIT (Ctrl-\) as one SIGTERM. A closed terminal hangs up twice, so once dsh has been signalled, those are dropped.
  - The client watchers get a process group of their own, because pnpm passes no signal on to the scripts it starts.
  - Ctrl-Z stops only `pnpm dev`. A SIGKILL leaves dsh and the watchers running.
  - The exit code is 128+n after signal n. `scripts/dev.ts`'s header has the rest.
- **The launcher leaves SIGINT to the terminal, and turns SIGHUP into SIGTERM.** A terminal's Ctrl-C already reaches the command in the launcher's foreground group, so a forwarded copy would be dsh's second. It forwards SIGTERM, and SIGHUP as SIGTERM. A real terminal hangup, or a SIGTERM to the launcher's whole group, still reaches the command twice, and its header says so: SIGTERM the node process, not the group. It exits 1 when `.dev/` can't be made, and 127 when the command can't start.
- **Copilot's first sign-in card** was seen live in a scratch profile. With Add model provider → `github-copilot` open on a fresh profile, the page shows two Sign in buttons, the draft's card and the footer's. That's cosmetic.
- **Tests clear `DSH_DISH_HOME`.** It beats `XDG_*`, so a parent environment that had it sent five plugin tests, which steer dish's directories with `XDG_*`, to that instance's directories. Their `withEnv` helpers now clear it for the test's body.
- **Tests never find the real home.** On 2026-10-02 a `pnpm dev` test ran an interactive bash on a pseudo-terminal with no `HOME` or `HISTFILE`. bash fell back to the passwd home and, at the hangup, saved its history over your real `~/.bash_history`. Those tests now give every process they spawn a scratch `HOME`, and the shell a scratch `HISTFILE`. That is the rule for every test now ("Testing", above).
- **Fleet pins mise 2026.10.0,** the latest stable release on 2026-10-02. Check for a newer 2026.10.x build for linux-x64 before the rollout.
