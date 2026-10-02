# Spec: dish on its own VM (`deploy`)

Status: draft, 2026-10-01. Implements roadmap step 5. Builds on:
- the [design](../design.md), "Hosting" and open question 6;
- the [config store](config-store.md) spec, for the store's remote and its single pusher;
- the [judge](judge.md) spec, which is the guardrail that makes an always-on agent host acceptable.

## Summary

dish moves from your desktop to a dedicated VM on Minideb, reachable only on your tailnet:
- **The VM.** It is a Debian 13 VM in its own `dish` Incus project, owned by OpenTofu and configured by Ansible from `~/projects/fleet`, the same way as the nsl builder.
- **The service.** `dsh web` runs as a user service of an unprivileged `dish` account, on `127.0.0.1:3080`.
- **The address.** `tailscale serve` puts it at `https://dish.<tailnet>.ts.net`, with a tailnet certificate.
- **The code.** It comes from a checkout of `bketelsen/dish`. A small `deploy/` directory in this repo says what to install.
- **Updates.** A fleet run pulls `main`, builds, and restarts the service. Nothing updates on its own.
- **The config store.** It moves to the VM: the VM restores it from `bketelsen/dish-config` and becomes its only pusher, and your desktop becomes a dev profile with no remote.

## Decisions (from the 2026-10-01 discussion)

| | Decision |
|---|---|
| 1. Who can reach it | Tailscale only. Public access with GitHub sign-in (design open question 6) is a later step of its own, because it reopens identity, Copilot sign-in, commit authors and approval routing per user. |
| 2. HTTPS | `tailscale serve`, with no Caddy change. Caddy comes in only if dish goes public. |
| 3. Where each piece lives | **fleet:** the instance (OpenTofu), plus an Ansible role for the guest (packages, Node, pnpm, Tailscale, the account, the checkout, the unit). **dish:** a `deploy/` directory with the profile's plugin list, the unit and an install script. Fleet runs it. |
| 4. Updating | Manual. A fleet run deploys whatever `main` is. |
| 5. Secrets | The repos are reached with SSH deploy keys: read-only for `bketelsen/dish`, read-write for `bketelsen/dish-config`, since the store pushes. Copilot and the TypeSafe key are entered on the VM's own Settings pages, so they never pass through fleet or Git. |
| 6. The config store | The desktop's remote is removed, and the VM starts with no store, restores from GitHub, and is the only pusher from then on. The desktop becomes a dev profile with no remote. |
| 7. VM or container | A VM, because agents run shell commands and a VM keeps them off Minideb's kernel. It gets 4 vCPU, 8 GiB, a 40 GiB root disk, Debian 13, and its own `dish` Incus project. |
| 8. Backups | The VM joins fleet's nightly backup, with the quiet-window rules of the others. What only the VM holds: dsh's sessions, crew's records, the judge log, and the Copilot and TypeSafe sign-ins. |
| 9. Tailscale sign-in | A one-off auth key, pasted at a hidden prompt when the guest play runs from the workstation, and used once. Fleet keeps no secret in Semaphore. The tailnet hostname is `dish`. |
| 10. Who runs it | Claude writes the fleet changes on a branch and opens a PR. You, or Semaphore, apply them after reviewing the plan and the diff. Nothing is applied to live infrastructure without your go-ahead. The dish side is built here, on a branch, as usual. |

## Non-goals

- **Public access, multi-user, and a GitHub sign-in front.** They come in a later step.
- **Webhooks and Funnel.** Those belong to step 9, triggers.
- **Workspaces, project clones and gates.** Those belong to step 6. The disk is sized with room for them, but this step creates none.
- **Automatic updates,** or any CI deploy.
- **Running the desktop and the VM against one store.** The desktop's dev profile keeps a local store with no remote.

## The VM (fleet)

Ownership follows the nsl builder's split ([fleet's nsl builder doc](../../../fleet/docs/nsl-builder.md)):

| Owner | What it configures |
|---|---|
| Ansible `minideb_dish` role (`minideb-dish.yml`, bootstrap) | The restricted `dish` Incus project, which allows one VM, no containers, the `default` pool and `incusbr0`, with nesting off and raw QEMU blocked; the `fleet-semaphore` identity, restricted to that project too. |
| OpenTofu `tofu/minideb` | The `dish` VM and its profile: 4 CPUs, 8 GiB, a 40 GiB root on `default`, NAT on `incusbr0`, autostart, and a pinned Debian 13 cloud image. |
| Ansible `dish` role (`minideb-dish-guest.yml`, gated by `fleet_dish_approved`) | Everything in the guest, below. |
| Ansible backup role (`minideb-dish-backup.yml`) | The VM's nightly capture to the NAS, following the Coder backup's pattern. |

**The guest role:**
- **Packages:** git, curl, ca-certificates and build essentials, plus whatever dsh's Linux sandbox needs. Find that out in the plan, from `dsh-sandbox`.
- **Node and pnpm:**
  - Node 24, from the official release tarball pinned by SHA-256 (the desktop runs v24.19.0).
  - pnpm at the version the repo's lockfile was written with, also pinned.
- **Tailscale:** from Tailscale's own Debian repository. `tailscale up --auth-key=file:/dev/stdin --hostname=dish` runs once; the key is read from a hidden prompt on the workstation, passed on stdin, and never written to disk or printed.
- **The account:**
  - It is a normal account, `dish`, with no sudo and linger on. dsh, and every agent's shell command, runs as `dish`.
  - Its home holds the checkout (`~/dish`), dsh's home (`~/.dsh`) and the XDG directories: config (with the store), state (with the judge log) and data (with crew's records).
- **Deploy keys:**
  - The two private keys stay on the workstation; the guest play reads them from its environment for that run only, and writes them to `~dish/.ssh` with mode 0600.
  - SSH host aliases (`github-dish`, `github-dish-config`) pick the right key for each repository. GitHub's host key is pinned in `known_hosts`.
- **The checkout:** `git clone git@github-dish:bketelsen/dish.git ~/dish`. On later runs it does a `git fetch` and a fast-forward of `main`; a checkout that can't fast-forward fails the run instead of being reset.
- **The install:** it runs dish's `deploy/install.sh`, then installs the user unit from `deploy/` and restarts it only when the checkout or the unit changed.
- **HTTPS:** `tailscale serve --bg --https=443 http://127.0.0.1:3080`, which is idempotent.

## The dish side (`deploy/` in this repo)

- **`deploy/install.sh`** is idempotent, and is run as `dish` from the checkout. It:
  1. runs `pnpm install --frozen-lockfile` and `pnpm build`;
  2. creates the `web` profile from dsh's default one if it isn't there, and adds each dish bundle with `pnpm dsh plugin --profile web add ./plugins/<name>` for copilot, config, prompts, crew and judge, in that order;
  3. writes the dish rows of the profile's patch layer.
     - **The `dish-config` row** gets:
       - `remote: git@github-dish-config:bketelsen/dish-config.git`;
       - `userName` and `userEmail` (yours, passed in by fleet);
       - and nothing else.
     - **Other rows** that dsh or the copilot catalog maintain are left as they are.
  4. sets the dish preset as the default for new tasks, on the first install only. This is the same write the UI's "Set as new task default" makes: an `agent-preset-registry` row in the profile's own patch file (`$DSH_HOME/profiles/web/cordis.patch.yml`), with `config: { default: standard, selectedDefault: dish }`.
     - A patch replaces a row's whole `config`, so `default` is restated.
     - It goes in the profile's file, not the home patch, so that a later choice made in the UI still works.
     - It is written only when the row is missing or has no `selectedDefault`. A `selectedDefault` that is already there, whatever its value, is a choice: it is left as it is, with the row's `default`, and a later run never resets it.
- **`deploy/dish-web.service`** is a systemd user unit:
  - It runs `pnpm dsh web --host 127.0.0.1 --port 3080 --no-open --trusted-host dish.<tailnet>.ts.net` from `~/dish`, with `Restart=on-failure`.
  - The tailnet name is a unit setting that fleet fills in.
- **`deploy/README.md`** covers what the VM runs, how to update it, how to reach the UI, and the one-time manual steps.

## Reaching it

- **The address** is `https://dish.<tailnet>.ts.net`, from any device on your tailnet.
- **Signing in.** dsh makes a new random access token each time it starts, and it can't be pinned; it prints the URL with the token on stdout. On the VM that line goes to the unit's journal, which you read as root through the guest's admin user `fleet` (the `dish` account has no SSH login): `sudo journalctl _UID="$(id -u dish)" _SYSTEMD_USER_UNIT=dish-web.service | grep 'dsh web:'`.
  - Open it once on the tailnet name, `https://dish.<tailnet>.ts.net/?token=…`. dsh then sets a browser cookie for that name, which lasts 30 days.
  - The cookie survives restarts: it is signed with a secret dsh keeps in its credential file, not with the token. A restart therefore doesn't sign you out, and the token is needed only for a new browser, or every 30 days.
  - The lifetime is `cookieMaxAgeDays` on the `connection` row, if 30 days proves short.
- **The trust fence.** dsh refuses `/api` calls (403) whose Host header isn't loopback or a trusted host. The page itself loads, but nothing on it works.
  - `tailscale serve` passes the tailnet name as the Host, so the unit passes `--trusted-host dish.<tailnet>.ts.net`.
  - The fence also requires an `Origin` host that matches, which it does.
  - The plan's first live check confirms this: a 403 without the flag, and success with it.
- **The bind address.** dsh only binds `127.0.0.1` from the command line, which is what `tailscale serve` needs. Nothing listens on the VM's own address.

## Moving the config store

Once the VM is up and its first fleet run has passed, in this order:
1. **Stop the desktop pushing.** Remove `remote` from the `dish-config` row of `~/.dsh/profiles/web/cordis.patch.yml` on the desktop, and restart the desktop's `dsh web`.

   Check that `bketelsen/dish-config`'s `main` equals the desktop store's `main`, so nothing unpushed is left behind.
2. **Start the VM with no store.** The first start restores `~/.config/dish/config.git` from GitHub (the store's documented first-start behaviour) and pushes from then on.
3. **Check it.**
   - `crew.yaml`, `judge.yaml` and the prompts on the VM match GitHub.
   - A change made on the VM appears on GitHub.
   - The desktop's store no longer pushes.
4. **Hand-entered sign-ins.** On the VM's Settings pages:
   - sign in to Copilot (Settings → Models);
   - paste the TypeSafe key (Settings → Judge);

**Afterwards,** your desktop profile is a dev profile. It keeps its local store, now with no remote, and new work goes through the VM.

## Testing and verification

- **dish side:** `deploy/install.sh` runs against a scratch `DSH_HOME` and scratch `XDG_*` (the live6 pattern), twice. The second run changes nothing.
  - After it, `--dump-config` shows the five dish bundles and the `dish-config` row's remote.
  - The unit file passes `systemd-analyze verify --user`.
- **fleet side:** `ansible-lint` and syntax checks, a check-and-diff run, `tofu plan`, then the apply under your authorization, and a rerun for idempotence, as fleet's `AGENTS.md` asks.
- **Live, once:**
  - **The page:** `https://dish.<tailnet>.ts.net` serves the UI after the token login, and Settings → Judge and Settings → Prompts load.
  - **A chat:** `git status` runs, a push asks you, and a coder child is refused a push.
  - **The store:** a config change on the VM is pushed to GitHub.
  - **A reboot:** the VM comes back, the unit starts on its own, and the tailnet name answers.
  - **Backups:** the nightly backup captures the VM.

## Risks and open items

- **dsh's token** is new on every start, but signing in once lasts 30 days across restarts. A new browser needs the token from the journal.
- **The credential file** (`~dish/.dsh/.credentials.yaml`) holds the Copilot sign-in, the TypeSafe key and the browser-session secret. It is in the nightly backup, so the NAS copy is as sensitive as the VM.
- **dsh's Linux sandbox needs `bubblewrap`** (Debian's package; no sysctl). It falls back to Landlock, and with neither, refuses every agent shell command ([host research](../research/2026-10-01-dsh-linux-host.md)). Install it before the unit's first start, since dsh caches the verdict.
- **The sandbox confines writes, not reads.** An agent's shell can read anything the `dish` account can, the deploy keys and `~/.dsh/.credentials.yaml` (the Copilot sign-in, the TypeSafe key, the browser-session secret) included. That is already so on the desktop. The judge's gate is the guard: reading a credential file doesn't serve a coding task, so it asks you or is refused for a child, and secrets are masked in the log and in what is sent to TypeSafe.
- **The tailnet must have HTTPS certificates enabled** before the guest play runs (admin console), or `tailscale serve --https` stops for an interactive prompt.
- **Disk.** 40 GiB is fine for dsh, sessions and logs. Step 6's workspaces will need more, which is an OpenTofu change then.
- **The desktop and the VM must not both push.** Step 1 of the move comes before the VM's first start.
- **Agent safety on an always-on host.** Agents run as `dish`, with no sudo, behind the judge's gate. The deploy keys are the most sensitive thing on the box:
  - **`dish` (read-only):** an agent could read the code, which is in its checkout anyway.
  - **`dish-config` (read-write):** an agent with shell access could push to the config repo. That is accepted for now, because:
    - the store's own commits go through its guard;
    - the judge gates `git push`;
    - nothing in the repo is a secret.
