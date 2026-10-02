# Deploying dish

dish runs on its own VM, reachable only on your tailnet. The VM and its guest setup belong to the fleet repo (`~/projects/fleet`). This directory is the dish side: what to install, and the unit that runs it.

The design is in the [deploy spec](../docs/specs/deploy.md), and what a dsh host needs on Linux is in the [research note](../docs/research/2026-10-01-dsh-linux-host.md).

## What the VM runs

- **The service.** `dsh web`, as `dish-web.service`: a systemd user unit of the unprivileged `dish` account, which has linger on and no sudo.
- **The port.** It listens on `127.0.0.1:3080` only. Nothing listens on the VM's own address.
- **The address.** `tailscale serve` puts it at `https://dish.<tailnet>.ts.net`, with a tailnet certificate. The tailnet needs HTTPS certificates enabled in the admin console first.
- **The code.** A checkout of `bketelsen/dish` at `~dish/dish`, with the profile at `~dish/.dsh/profiles/web`.
- **The state.** It lives in `dish`'s home:
  - `~/.dsh`: dsh's sessions and its credential file;
  - `~/.config/dish/config.git`: the config store, pushed to `bketelsen/dish-config`. The VM is its only pusher;
  - `~/.local/state/dish`: the judge's decision log;
  - `~/.local/share/dish`: crew's records.

## What the files here do

| File | What it is |
|---|---|
| `install.sh` | Builds dish and installs it into a dsh profile. Idempotent. |
| `profile.ts` | Writes dish's rows into the profile's `cordis.patch.yml`. `install.sh` runs it. |
| `dish-web.service` | The systemd user unit. Fleet links it from the checkout into `~/.config/systemd/user`. |

### install.sh

Run it as the account that runs `dsh web`, from anywhere (it moves to the checkout's root itself). `node` and `pnpm` must be on `PATH`. Its inputs come from the environment:

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
4. **The bundles.** For copilot, config, prompts, crew and judge, in that order, `pnpm dsh plugin --profile <profile> add ./plugins/<name>`, only when the profile doesn't link it yet.

It prints what it did, and its last line is `install: no changes to the profile` or `install: profile changed`. On a failure it stops and names the step on stderr, as `install: FAILED at step: …`. It prints nothing secret.

**Isolation.** Every dsh command `install.sh` runs gets its four XDG directories pointed at a throwaway directory, which is removed on exit. A dsh command that loads a profile boots its plugins, and `dish-config` creates `~/.config/dish/config.git` when it boots. An install that did that on a fresh machine would leave an empty local store, and the first start with a remote would then push it over the one on GitHub instead of restoring it. In dsh 0.2.0-rc.2 the two commands the script uses boot nothing, so this guards against a later dsh. `HOME` and `DSH_HOME` stay real, so the profile lands where `dsh web` reads it.

**The store-pin contract.** pnpm records the store a profile was first used with, and refuses to work on it with any other store. So `install.sh` looks up the store pnpm would use (`pnpm store path`) and hands it to each dsh command, instead of letting the throwaway directory pick a new one. dsh's plugin manager inside `dsh web` works the store out again, from the unit's environment. Both must give the same store, so `HOME`, `XDG_DATA_HOME` and `PNPM_HOME` have to be the same for `install.sh` and for the unit. Set none of them for just one of the two.

**The default preset.** The `dish` preset is set as the default on the first install only. A default chosen in Settings → Agent presets is kept by every later update.

### What the unit expects

- **`/opt/dish/node`.** A symlink to the pinned Node install (24.21.0), with pnpm (11.25.0) in its `bin`. The unit's `PATH` is `/opt/dish/node/bin:/usr/local/bin:/usr/bin:/bin`. Agents' shell commands inherit it, so it is also what a command can run.
- **`~/.config/dish/deploy.env`.** Written by fleet, with one line: `DISH_TRUSTED_HOST=dish.<tailnet>.ts.net`. The unit passes it as `--trusted-host`, which `dsh web` needs to answer `/api` calls that `tailscale serve` forwards under that name. The file is required: without it the unit doesn't start, and without the variable dsh refuses to load and the unit restarts every 5 seconds.
- **The checkout at `~/dish`,** with `install.sh` already run.
- **`bubblewrap`,** installed before the first start. It is dsh's sandbox, and without it, or Landlock, dsh refuses every agent shell command. dsh caches that verdict, so restart the unit after fixing it.
- **No hardening options.** The unit has no `PrivateUsers=`, `SystemCallFilter=` or the like on purpose. Every agent command is a child of the unit, and those options would break the sandbox.

## Updating

Nothing updates on its own. After a change reaches `main`, rerun fleet's guest play, `minideb-dish-guest.yml`. Fleet's `docs/dish.md` has its prerequisites and the order of runs.

The play:
1. fetches in `~dish/dish` and fast-forwards `main`. A checkout that can't fast-forward fails the run, and is not reset;
2. runs `deploy/install.sh` as `dish`;
3. restarts `dish-web` only when the checkout's HEAD, `deploy.env` or the unit changed.

A restart makes a new access token, but your browser's sign-in carries over (see below).

## Signing in

dsh makes a new random access token each time it starts, and prints the URL with it on stdout. On the VM that goes to the unit's journal. As `dish`:

```sh
journalctl --user -u dish-web | grep 'dsh web:'
```

The last match is the current token. Open it once, on the tailnet name:

```
https://dish.<tailnet>.ts.net/?token=…
```

dsh then sets a cookie for that name, which lasts 30 days and survives restarts: it is signed with a secret kept in dsh's credential file, not with the token. You need the token only for a new browser, or every 30 days. If 30 days is too short, change `cookieMaxAgeDays` on the `connection` row.

Use the tailnet name, not the VM's tailnet IP or short name. dsh answers `/api` calls only for the loopback and the trusted host, so another name loads the page and nothing on it works.

## One-time steps on the VM

Both are entered on the VM's own Settings pages, so neither passes through fleet or Git. dsh keeps them in `~dish/.dsh/.credentials.yaml`, and they survive restarts and updates.
- **Copilot.** Sign in on **Settings → Models**. The card shows a device code, and "Open GitHub" opens in your own browser, not the VM's.
- **TypeSafe.** Paste the key on **Settings → Judge**. Without it the judge fails closed: the main agent asks you for every shell command, and a crew child's is refused.

## Before the first start

Only one machine may push to `bketelsen/dish-config`. Until the move your desktop is the pusher, and the VM must not start while it still is. A second pusher's pushes are rejected, never forced, so the two stores would diverge. The order, from the spec:

1. **Stop the desktop pushing.** On the desktop, remove `remote` from the `dish-config` row of `~/.dsh/profiles/web/cordis.patch.yml`, and restart its `dsh web`. Check that `main` of `bketelsen/dish-config` equals the desktop store's `main`, so nothing unpushed is left behind.
2. **Start the VM.** Fleet holds the unit back until `fleet_dish_service_enabled` is set. Set it and rerun the guest play. The first start finds no store, restores `~/.config/dish/config.git` from GitHub, and pushes from then on.
3. **Check it.** `crew.yaml`, `judge.yaml` and the prompts on the VM match GitHub, and a change made on the VM appears there.
4. **Sign in.** Copilot and the TypeSafe key, as above.

Afterwards your desktop profile is a dev profile: it keeps its local store, with no remote. See the [spec](../docs/specs/deploy.md#moving-the-config-store) for the checks.

## Running install.sh by hand

On a fresh machine, or for development, from a checkout with Node 24 and pnpm on `PATH`:

```sh
DISH_REMOTE='git@github-dish-config:bketelsen/dish-config.git' \
DISH_USER_NAME='Your Name' \
DISH_USER_EMAIL='you@example.com' \
./deploy/install.sh
```

Don't give it the real remote on any machine but the VM: that remote makes the machine's `dsh web` a second pusher.

To try it out with nothing real touched, use an empty remote and a scratch `DSH_HOME`:

```sh
scratch=$(mktemp -d)
DSH_HOME="$scratch" DISH_REMOTE='' DISH_USER_NAME='Test' DISH_USER_EMAIL='test@example.invalid' ./deploy/install.sh
DSH_HOME="$scratch" pnpm dsh --profile web --dump-config | grep -A3 dish-
rm -rf "$scratch"
```

The first run builds the tree and creates the profile. A second run, with the same `DSH_HOME`, ends with `install: no changes to the profile`. It still runs `pnpm install` and `pnpm build` in the checkout.

## Security notes

- **Agents run as `dish`,** with no sudo.
- **The sandbox confines writes, not reads.** An agent's shell can read anything `dish` can, including the deploy keys in `~/.ssh` (one of them read-write for `dish-config`) and `~/.dsh/.credentials.yaml` (the Copilot sign-in, the TypeSafe key and the browser-session secret). File modes don't help, since the agent is the same user. The desktop has the same exposure.
- **The judge's gate is the guard.** Reading a credential file doesn't serve a coding task, so the gate asks you, or refuses for a crew child. Secrets are masked in the judge's log and in what is sent to TypeSafe.
- **The backup holds the credential file.** The VM's nightly backup captures it, so the NAS copy is as sensitive as the VM.
