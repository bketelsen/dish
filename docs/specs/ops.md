# Spec: dish ops (prod and dev, updates)

Status: draft 2026-10-02, for review. This is roadmap step 6a, the first part of step 6. It builds on the [deploy spec](deploy.md), whose rollout notes describe today's setup.

## Summary

dish runs like any web app: a **prod** configuration, which only the VM's service uses, and a **dev** configuration, which is the default for everything else.
- **Dev data.** It lives in a git-ignored `.dev/` folder inside the checkout. Nothing run by hand, by `pnpm dev`, by a test or by an agent can reach prod's data unless it says `DISH_ENV=prod`.
- **Updates.** You run them yourself with a script on the VM, `deploy/update.sh`, through `incus exec`. A second script, `deploy/url.sh`, prints the sign-in link when your cookie expires.
- **Fleet.** It goes back to provisioning only.
- **Default chat folder.** The service starts in `~/work`, so a chat opened without a workspace no longer lands in the live checkout.

## Decisions (from the 2026-10-02 discussion)

| # | Topic | Decision |
|---|---|---|
| 1 | Protecting dish from itself | No guards in dish. Separate prod and dev data, keep the live checkout out of every chat, and deploy only by hand. |
| 2 | Who deploys | Only you, with `deploy/update.sh` through `incus exec`. Agents don't deploy dish. |
| 3 | Prod and dev | `DISH_ENV` is `prod` or `dev`, and dev is the default. Only the service sets `prod`. |
| 4 | Where dev data lives | `<checkout>/.dev/` (git-ignored) holds dev's dsh home, config, state, data, cache and pnpm store. A dev run is then sandbox-safe: an agent working in that checkout can run it, because everything it writes is inside the checkout. |
| 5 | Fleet | Provisioning only: the VM, packages, Node and pnpm, the account, Tailscale and `tailscale serve`, the keys, the first clone, and `deploy.env`. Fleet stops updating the checkout, running the install, and installing or restarting the unit. dish owns its unit. |
| 6 | Workspaces | dish never sets one up here. The service's working directory moves to `~/work`. You've removed the `/home/dish/dish` workspace record by hand. Step 6b's onboarding creates project workspaces. |
| 7 | Installs with approval | `apt` through a narrow sudo rule (fleet). User-level tools through mise. Both are agent commands that write outside the workspace, so they go through dsh's escalation: the main agent asks you, and a child is refused unless the judge approves. |
| 8 | `update.sh` default | A dry run that shows what would change. `--apply` acts. A ref argument checks out that commit, as a rollback. |
| 9 | Sign-in link | `deploy/url.sh` prints `https://<tailnet name>/?token=…` from the service's journal. |

## Non-goals

- Guards that refuse agent commands against dish's own process or files.
- Reaching dev on the VM from your browser. Use an SSH tunnel to `127.0.0.1:3090` for now. A second `tailscale serve` port can come later.
- Projects, clones, worktrees and the GitHub App (step 6b), and gates (step 6c).

## Prod and dev

### The contract

| | prod | dev (default) |
|---|---|---|
| Who | the `dish-web` service only (`Environment=DISH_ENV=prod` in the unit) | everything else: `pnpm dev`, `pnpm dsh …` and agents |
| dsh home | `~/.dsh` | `<checkout>/.dev/dsh` |
| XDG config, state, data, cache | the account's defaults | `<checkout>/.dev/{config,state,data,cache}` |
| pnpm store | the account's | inside `.dev/` |
| dsh profile | `web` | `web`, in dev's dsh home |
| port | 3080, behind `tailscale serve` | 3090, loopback only |
| config store remote | `bketelsen/dish-config` | none, ever |

- **The launcher.** Root package scripts that run dsh go through a small launcher, `scripts/env.mjs`. It sets dev's variables unless `DISH_ENV=prod`. Any other value of `DISH_ENV` is refused with a message.
- **Plugins.** They keep reading the standard variables (`xdgPaths`, `DSH_HOME`). They don't branch on `DISH_ENV`; the variables are the switch.
- **pnpm outside the launcher.** An agent's own `pnpm install` in a checkout must also keep its store inside `.dev/`, for example through the repo's `.npmrc`. Otherwise it writes the account's store, which is outside the sandbox, and needs approval. The plan picks the mechanism and checks that prod's `install.sh` is unaffected.
- **Tests.** They already use temp directories. Nothing changes.

### `pnpm dev`

1. Install the checkout's dependencies into dev's store. Build the client bundles.
2. On the first run, create dev's profile and install dish into it. This is `install.sh` with `DISH_REMOTE=''`, run under the launcher's variables.
3. Start `dsh web` on `127.0.0.1:3090` with the client bundles in watch mode. Print the sign-in link.

Dev starts empty: no sessions, a fresh config store, and no Copilot sign-in. The first Copilot sign-in on a fresh profile is the backlog item "the sign-in card on a fresh install". 6a fixes it, because every new dev checkout would hit it otherwise.

### The desktop

- The desktop switches from `pnpm web` to `pnpm dev`.
- The old `~/.dsh/profiles/web` and `~/.config/dish` are no longer used by anything. Remove them by hand when you like.
- The desktop has no prod.

## The service unit (`deploy/dish-web.service`)

| Line | Now | 6a |
|---|---|---|
| `WorkingDirectory` | `%h/dish` | `%h/work` |
| `Environment` | `PATH=…` | `PATH=…` and `DISH_ENV=prod` |
| `ExecStart` | `pnpm dsh web …` (from the checkout) | dsh's own binary in the checkout, `%h/dish/node_modules/.bin/dsh web --host 127.0.0.1 --port 3080 --no-open --trusted-host ${DISH_TRUSTED_HOST}`, so dsh's working directory, which is the default for new chats, is `~/work` |

Everything else stays: `EnvironmentFile`, `Restart=on-failure`, no sandboxing options (the deploy spec's reasons), and the store-pin contract.

**Check first.** dsh must not depend on starting in the checkout. The profile lives in `DSH_HOME`, but a linked bundle could be recorded with a relative path. The plan verifies this before anything else.

## `deploy/update.sh`

Run it from your workstation:

```bash
incus exec dish --project dish -- /home/dish/dish/deploy/update.sh            # dry run: what would change
incus exec dish --project dish -- /home/dish/dish/deploy/update.sh --apply    # update to origin/main
incus exec dish --project dish -- /home/dish/dish/deploy/update.sh --apply 4b23ff0   # roll back to a commit
```

Through Minideb, prefix it with `ssh bjk@10.0.1.175`.

### Who it runs as and how

- **As root,** which is what `incus exec` gives. The work runs as `dish`, through `runuser -u dish --`, with `HOME`, `XDG_RUNTIME_DIR=/run/user/<uid>` and the unit's `PATH`. HOME, XDG_DATA_HOME and PNPM_HOME stay unset, which keeps the store-pin contract.
- **Run as `dish` itself,** it does the same without `runuser`.
- **Any other account:** it refuses.
- **It updates the file it's running from,** so the body is one function called on the last line. bash then reads the whole file before anything changes it.

### Steps

1. **Fetch** `origin` in `~/dish`.
2. **The target** is `origin/main`, or the ref given (a commit or a tag).
3. **The dry run** prints:
   - HEAD and the target;
   - `git log --oneline HEAD..target`, or `target..HEAD` for a rollback;
   - whether the unit file or `deploy.env` differ from what the service last started with;
   - then it stops.
4. **`--apply` checks out the target:**
   - With no ref: the checkout must be on `main`, or detached after a rollback, in which case it switches back to `main`. Then `git merge --ff-only origin/main`. A checkout with local changes, or one that can't fast-forward, is refused and left alone.
   - With a ref: `git switch --detach <ref>`.
5. **Run `install.sh`** with `DISH_REMOTE`, `DISH_USER_NAME` and `DISH_USER_EMAIL` from `deploy.env`. Fleet writes those lines (see Fleet).
6. **Install the unit:**
   - copy `deploy/dish-web.service` to `~/.config/systemd/user/`, and `systemctl --user daemon-reload` when it changed;
   - create `~/work` if missing;
   - enable the unit if it isn't enabled.
7. **Restart** when anything is stale. The service is stale when its last start doesn't match:
   - the checkout's revision;
   - the unit file;
   - `deploy.env`;
   - the Node and pnpm versions.

   The record of that start, the stamp, lives in `~/.local/state/dish/deploy/started`. A missing stamp counts as stale.
8. **Wait** until `127.0.0.1:3080` answers, for up to 120 seconds. Then write the stamp. A failed wait exits non-zero, leaves the stamp alone and prints the journal tail.
9. **Print:**
   - the new HEAD;
   - the unit's state;
   - the last 15 journal lines with every token-bearing line removed;
   - the hint to run `url.sh` for a fresh link.

**Exit codes:** 0 for done or nothing to do, 1 for a failed step (named on stderr, as `install.sh` does), and 2 for usage.

## `deploy/url.sh`

Run it as `incus exec dish --project dish -- /home/dish/dish/deploy/url.sh`.
- **What it prints:** `https://<DISH_TRUSTED_HOST>/?token=<token>`. The token comes from the last `dsh web:` line in the service's journal since its current start, and the host from `deploy.env`.
- **When there's no token:** the service isn't running or hasn't printed one, so it says which and exits 1.
- **Read access:** it runs as root, so the journal can be read.
- **It prints a secret, on purpose.** It's for your terminal. Don't paste the output anywhere.

## Fleet (a reviewed PR in `~/projects/fleet`)

**Remove** from `dish_guest`:
- the fast-forward and the "on main" check;
- the `install.sh` run;
- installing, linking and checking the unit, and the PATH contract check;
- the restart;
- the `started` stamp;
- the wait.

**Keep:** first-time provisioning, including cloning `~/dish` when it's missing and enabling linger.

**Change:**
- `deploy.env.j2` gains `DISH_REMOTE`, `DISH_USER_NAME` and `DISH_USER_EMAIL`.
- Add a sudoers drop-in letting `dish` run `apt-get update` and `apt-get install` without a password, and nothing else.
- Install mise for `dish`.
- `docs/dish.md`: "Updating" points to dish's `deploy/update.sh`.

**Deploy key:** the read-only key for `bketelsen/dish` stays. `~/work` clones of dish use it too, until step 6b's GitHub App.

## Rollout

The order matters. A dish whose default is dev, started by a unit without `DISH_ENV=prod`, would come up on an empty dev store.
1. Merge 6a in dish. The new unit, with `DISH_ENV=prod`, ships in the same commit that makes dev the default.
2. Merge the fleet PR, and run the guest play one last time. It writes the new `deploy.env` and touches nothing else of dish's.
3. Run `update.sh --apply`. It fast-forwards, installs the new unit, restarts once, and writes its stamp.
4. Check:
   - a new chat opened with no workspace starts in `~/work`;
   - `url.sh` prints a link that signs you in;
   - Settings shows prod's data.
5. Move to `pnpm dev` on the desktop.

## Testing

`node --test`, in `deploy/test/`.
- **`update.sh`** runs against a temporary bare repo and checkout, with stub `systemctl`, `journalctl` and `runuser` on `PATH`, and `install.sh` stubbed. Cases:
  - the dry run changes nothing;
  - `--apply` fast-forwards, rolls back with a ref, and switches back from a rollback;
  - local changes are refused;
  - the unit is copied and reloaded only when it changed;
  - restart only when stale;
  - the stamp is written only after the wait succeeds;
  - token lines are filtered from the journal tail;
  - root versus `dish` versus another account.
- **`url.sh`**, with a stub journal: the latest token since the last start; no token; the host taken from `deploy.env`.
- **The launcher:** dev's variables by default; `prod` passes through; any other value is refused.
- **The unit file:** `WorkingDirectory`, `DISH_ENV=prod` and the `ExecStart` path.
- **By hand, in a scratch `DSH_HOME`:** `pnpm dev` starts on 3090 with nothing outside `.dev/` written. Compare a listing of `~/.dsh`, `~/.config/dish` and `~/.local/share/dish` before and after.

## Open items

- **Can dsh run from `~/work`?** Check that linked bundles and the profile resolve when the working directory isn't the checkout. This is the first thing the plan checks.
- **The `.npmrc` store setting:** it's per-repo, so check that prod's `install.sh` (the store-pin contract) and dsh's plugin manager still agree.
- **mise vs brew:** this spec says mise. brew is the alternative, if you'd rather match your desktop.
- **Disk:** each dev checkout gets its own pnpm store, a few hundred MB. That's fine at today's 37 GiB free.
