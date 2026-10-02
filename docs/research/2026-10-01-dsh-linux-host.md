# Research: what a dsh host needs on Linux

Date: 2026-10-01. dsh version: 0.2.0-rc.2.

**Sources:**
- **The installed packages**, under `node_modules/.pnpm/node_modules/@deepseek-ai/`. Paths below are relative to that, for example `dsh-sandbox-local/lib/index.js:173`. Line numbers are those of the compiled `lib/*.js`.
- **The deepseek-harness checkout at the same version**, for the READMEs, docs and root `package.json`. Its paths are marked `harness:`.
- **Tailscale's source at v1.102.4** (the stable channel on `pkgs.tailscale.com/stable/?mode=json`) and `main`, and Tailscale's docs.
- **Debian's sources** (`sources.debian.org`) for trixie: linux 6.12.107-1, bubblewrap 0.12.0-1~deb13u1 and systemd 257.13-1~deb13u1.
- **nodejs.org** and the npm registry, for the pins.
- **A few spot checks on the desktop** (see [below](#spot-checks)). They ran in scratch directories and never loaded a plugin.

**Why we looked:** the [deploy spec](../specs/deploy.md) leaves the guest's package list open ("whatever dsh's Linux sandbox needs") and relies on `tailscale serve` passing the tailnet name as the Host. Task D1 of the [deploy plan](../plans/2026-10-01-deploy.md) settles both before the guest role is written.

**Conclusion:**
- **The sandbox needs one package, `bubblewrap`, and no sysctl, on Debian 13.** Landlock, which dsh falls back to, is already in Debian's kernel. Without both, every default session fails closed: the bash tool refuses to run.
- **dsh and dish need `git` and `openssh-client`, and nothing to compile.** `rg`, the PTY helper, the FFI library and esbuild all arrive as npm prebuilds.
- **Node 24 and pnpm 11.25.0.** dsh's floor is `^22.19.0 || >=24.0.0`.
- **`tailscale serve` keeps the incoming Host header,** so the spec's `--trusted-host dish.<tailnet>.ts.net` is exactly right, and nothing else is needed on dsh's side.
- **No inotify change.** dsh uses a handful of watches.
- **Reads are not sandboxed.** An agent's shell command can read the deploy keys and the credential file. This isn't new in the spec, but the sandbox doesn't help with it.

## 1. The Linux sandbox

**What it uses:** bubblewrap, then Landlock. Nothing else: no seccomp, no namespaces of its own.
- **The chain** is `linux: ["bwrap", "landlock"]` (`dsh-sandbox-local/lib/index.js:173-177`). Each rung is functionally probed, in order, once per provider lifetime, and the first usable verdict is cached (`:490-512`).
- **The bwrap probe** runs `bwrap --ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent -- true`; exit 0 means usable (`:101-113`). A missing `bwrap` just fails the probe.
- **The Landlock rung** is the static `landlock-run` executable from the npm package `@deepseek-ai/node-addon-system-linux-x64`. There's nothing to compile at install.
  - Its probe, `landlock-run --probe`, asks the kernel to enforce a ruleset (`node-addon-system/lib/index.js:89-98`).
  - Kernel version alone isn't a guarantee (`harness:native/system/docs/support-matrix.md:12`).
  - It understands Landlock up to ABI 5; an older kernel ABI runs as `partial`, with one stderr line (`harness:native/system/docs/cli-contract.md:29,34`).
- **The profiles** (`dsh-sandbox-local/lib/index.js:22-52`):

  | | bwrap | Landlock |
  |---|---|---|
  | Everything | `--ro-bind / /`, fresh `--dev /dev`, private PID namespace with its own `/proc`, `--die-with-parent` | read-only `/`, read-write `/dev/null` |
  | `workspace-write` adds | `--tmpfs /tmp` (ephemeral) and `--bind <workspace> <workspace>` | the host `/tmp` and the workspace |

- **What it confines:** file writes only. Reads are unconfined, and network and process visibility are outside the sandbox (`dsh-bash-sandbox/README.md`, "Modes and file effects").

**When it's missing: it refuses.**
- If neither rung is usable, `confine()` throws `SandboxUnavailableError` (`dsh-sandbox-local/lib/index.js:490-494`).
- The message is: `refusing to run the command unconfined. Install bubblewrap or run a Landlock-enforcing kernel (Linux)...` (`dsh-sandbox/lib/index.js:270-275`).
- A runner that passes its probe and then fails at run time is reported the same way (`dsh-bash-sandbox/lib/index.js:104-105`).
- **There is no warning-and-run.** The only unconfined path is the mode `danger-full-access`, which never calls the sandbox (`dsh-bash-sandbox/lib/index.js:68`; `harness:docs/subsystems/sandbox.md:23`).

**Which modes depend on it:**
- **The web profile starts new sessions in `workspace-write` with approval `ask`.** The base patch sets `mode: DSH_PERMISSION_MODE ?? 'workspace-write'` (`dsh-base/cordis.patch.yml:229-233`), and the presets are `read-only`, `workspace-write` and `danger-full-access` (`:250-262`).
- **Both confined modes send every bash call through `ctx.sandbox.confine`** (`dsh-bash-sandbox/lib/index.js:76-83`, `:161-167`). Only Full access skips it.
- **The file tools don't depend on it.** `dsh-fs-sandbox` is an in-process path fence (`dsh-base/cordis.patch.yml:516-519`). `write` and `edit` work with no OS support at all, and reads are unconfined.
- **So a guest without a working rung** has a UI that loads, file tools that work, and a shell that fails on the first command.

**What Debian 13 provides.** Nothing to configure.
- **User namespaces** (bwrap's rung): `CONFIG_USER_NS=y` (`linux 6.12.107-1`, `debian/config/config:6404`).
  - `kernel.unprivileged_userns_clone` is Debian's own sysctl, and its patch says "change the default to enabled".
  - bubblewrap's `README.Debian` says the default is 1 on all modern Debian kernels, and that bwrap is no longer setuid.
  - The package description says it "relies on a kernel with user namespaces enabled. Official Debian and Ubuntu kernels are suitable."
- **Landlock** (the fallback rung): `CONFIG_SECURITY_LANDLOCK=y` and a `CONFIG_LSM` that starts with `landlock` (`debian/config/config:7805,7738`).
- **The cloud kernel** adds `debian/config/config.cloud`, which touches neither.
- **The package** is `bubblewrap` 0.12.0-1~deb13u1. It recommends `procps`.
- **The guest is a VM,** so it has its own kernel and none of the nesting questions a container would raise.

**The verdict is cached for the provider's lifetime** (`dsh-sandbox-local/README.md`, "Known Limitations"). Install `bubblewrap` before the unit's first start, and restart the unit if a rung is added or repaired later.

### Process containment (not the sandbox, but Linux-specific)

- **`dsh-subprocess-local` puts each agent command in a transient user-systemd scope:** `systemd-run --user --scope --collect --expand-environment=no` (`dsh-subprocess-local/lib/index.js:73-95`, `:1384-1398`).
- **It needs the `dish` user manager to be reachable** (`systemctl --user show` must succeed, `:101-113`). That is what `loginctl enable-linger` and a systemd user unit give it.
- **Without it,** dsh falls back to process-group cleanup and logs a warning that descendants that escape aren't guaranteed to be killed (`:1399-1404`). It doesn't fail.
- **Debian:** `libpam-systemd` recommends `dbus-user-session` (systemd 257.13-1~deb13u1, `debian/control`). Listing it explicitly costs nothing.
- **Not verified for the guest:** that `systemd-run --user --scope true` works from the `dish` account. The role should assert it.

## 2. The tools agents call

| Feature | Needs | Evidence |
|---|---|---|
| `bash` tool, and every confined command | `bash` on `PATH`. bwrap's argv is `["bash", "-c", <command>]`, and `bwrap` itself is found on `PATH`. | `dsh-bash-local/lib/index.js:140-146`, `dsh-bash-sandbox/lib/index.js:161-167` |
| Persistent shells and the web terminal | `/bin/bash` for the persistent bash tool. The terminal panel uses `$SHELL`, else the account's passwd shell, else `/bin/sh`. | `dsh-terminal-bash/lib/index.js:9`, `dsh-api-terminal-controller/lib/index.js:15-26`, `dsh-subprocess-local/lib/index.js:1406-1414` |
| `glob` and `grep` | Nothing. A packaged `rg` (`@vscode/ripgrep-linux-x64@1.18.0`, a static-pie ELF) runs with `--no-config`. | `dsh-tool-fs-search/lib/index.js:9-20,107-128` |
| Changed-files card | `git`, optional. Without it, only file-tool edits are listed. | `dsh-workspace-changes/lib/index.js:996-1015,1049-1053` |
| dish's config store | `git`, required, run with no shell. A remote like `git@github-dish-config:...` makes git run `ssh`, so `openssh-client`. | `plugins/config/src/store/git.ts:77`, `plugins/config/src/index.ts:159` |
| Copilot sign-in | No binary. See below. | `plugins/copilot/src/index.ts`, `@earendil-works/pi-ai/dist/auth/oauth/github-copilot.js:30-32` |
| `web_fetch` | No binary: Node's `fetch`, public HTTP(S) destinations only. | `dsh-web-fetch-http/README.md`, "Summary" |
| Skills | No binary. They are Markdown in `~/.dsh/skills`, `~/.agents/skills` and project directories. The bundled Office skills want Python 3.9+, only when used. | `dsh-skill-filesystem/lib/index.js:172,177`, `dsh-skill-office/README.md` |
| PTC tools mode, opt-in | `process.execPath`, so nothing extra. | `dsh-ptc-runtime-node/lib/index.js:794` |
| Directory picker | The native picker needs `DISPLAY` or `WAYLAND_DISPLAY` and `zenity` or `kdialog`. A headless guest gets the in-browser `browse` picker. | `dsh-host-directory-picker-auto/lib/index.js:33-39,64-71` |
| Not on Linux | `pwsh` (disabled off Windows); `tmux` context (opt-in, not in the web profile). | `dsh-base/cordis.patch.yml:237,243,269,273`, `dsh-tmux-context/README.md` |

**The config store's git runs without a terminal.** `runNetworkGit` starts git detached (a new session, so no controlling terminal), with no stdin and `GIT_TERMINAL_PROMPT=0` (`plugins/config/src/store/push.ts:122-127`).
- A passphrase prompt can't be answered, so the deploy keys have no passphrase.
- An unknown host key can't be confirmed, so GitHub's key must already be in `known_hosts`, as the spec has it.

**Copilot sign-in needs only outbound HTTPS.** The device-code flow is shown in the Models card, and "Open GitHub" opens in your own browser, not the VM's.
- `github.com` for the device code and the access token.
- `api.github.com/copilot_internal/v2/token` for the Copilot token.
- `*.githubcopilot.com` for the models and chat: `api.individual.githubcopilot.com`, or the host the token names in `proxy-ep` (`plugins/copilot/src/copilot-api.ts:80-82`).

**No compiler, Python or `make` is needed on linux-x64.**
- **`node-pty` 1.2.0-beta.15:** its `install` script is `node scripts/prebuild.js || node-gyp rebuild`, and `prebuilds/linux-x64/pty.node` ships, so the first half succeeds.
- **`koffi` 3.1.1:** `cnoke --prebuild` loads `@koromix/koffi-linux-x64` and builds with cmake only if that load fails (`koffi/cnoke.cjs:486-495,518-520`).
- **Also prebuilt:** `@vscode/ripgrep-linux-x64`, `@deepseek-ai/node-addon-system-linux-x64` and `@esbuild/linux-x64`.
- **`pnpm install` must keep optional dependencies** (the default), because the platform packages are optional dependencies.

**What an agent's command inherits.** The scrubbed parent environment: `PATH`, `HOME` and the locale survive, while names matching `KEY|PASSWORD|SECRET|TOKEN` and every `DSH_*` are dropped (`dsh-subprocess/lib/index.js:32,50-56`).
- **Secrets in `deploy.env` don't reach agents,** unless a name dodges the pattern.
- **`PATH` comes from the unit,** so it must include Node's and pnpm's directories.

## 3. Node and pnpm

**Node's floor is `^22.19.0 || >=24.0.0`.**
- **Where it's stated:** the harness root `package.json:8-10` and `harness:docs/development.md:11`. The installed `@deepseek-ai/dsh` declares no `engines`.
- **Why 22.19:** `@earendil-works/pi-ai` and others require it (`harness:.agents/notes/implemented/process/2026-07-06-node-engine-floor.md`).
  - In the installed tree, the highest `engines.node` is `>=22.19.0` (`@deepseek-ai/libreoffice-kit`, `@earendil-works/pi-telemetry`, `undici@8.11.2`).
  - The next is `>=22.12.0` (`commander@15`).
- **dish's own plugins run as `.ts`,** which needs type stripping, default from Node 22.18. Node 24 is comfortably above both.
- **Node 24.** The desktop runs v24.19.0.

**Pin Node 24.21.0,** the latest 24 LTS ("Krypton", 2026-09-07). v24.19.0 is still published if the VM must match the desktop; either clears the floor.
- **Tarball:** <https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz>. A `.tar.gz` sits beside it; `.tar.xz` needs `xz-utils` to unpack.
- **Checksums:** <https://nodejs.org/dist/v24.21.0/SHASUMS256.txt>, signed as `SHASUMS256.txt.asc` and `SHASUMS256.txt.sig` in the same directory.
- **The fleet task records the hash.**

**pnpm: pin 11.25.0.**
- **The lockfile doesn't record a pnpm version.** It has `lockfileVersion: '9.0'`, which pnpm 9, 10 and 11 all write, and `package.json` has no `packageManager` field.
- **What did write it:** `node_modules/.modules.yaml` records `packageManager: pnpm@11.25.0` (line 1614), and the desktop runs `pnpm --version` 11.25.0.
- **Pin that.** The harness itself pins 11.7.0 (`harness:package.json:7`), which is older, so don't copy it.
- **The package:** <https://registry.npmjs.org/pnpm/-/pnpm-11.25.0.tgz>. It has no dependencies, `engines.node >=22.13`, and `bin/pnpm.mjs`. Its integrity is in the registry metadata, <https://registry.npmjs.org/pnpm/11.25.0>, under `dist`.
- **Not `latest`:** the registry's `latest` is 12.8.1.
- **Worth a follow-up in dish:** a `packageManager` field and `engines` in the root `package.json`, so the pin lives in the repo. That isn't part of this task.

## 4. Tailscale and the Host header

**`tailscale serve` keeps the incoming Host header** when it proxies to `http://127.0.0.1:3080`.

**Evidence:** `ipn/ipnlocal/serve.go`, in `(*reverseProxy).ServeHTTP`, which builds an `httputil.ReverseProxy{Rewrite: ...}`.
- **v1.102.4, lines 959-979:** <https://github.com/tailscale/tailscale/blob/v1.102.4/ipn/ipnlocal/serve.go#L959-L979>. On `main` the assignment is at line 995, and it is already at line 622 in v1.60.0.

  ```go
  r.SetURL(rp.url)
  ...
  // For Unix sockets, use the URL's host (localhost) instead of the incoming host
  if rp.socketPath != "" {
      r.Out.Host = rp.url.Host
  } else {
      r.Out.Host = r.In.Host
  }
  addProxyForwardedHeaders(r)
  ```

- **Why that line matters:** Go's `SetURL` clears the outbound Host, "rewrites the outbound Host header to match the target's host", and says to set `r.Out.Host = r.In.Host` to preserve the inbound one (`net/http/httputil/reverseproxy.go:44-61`, <https://github.com/golang/go/blob/master/src/net/http/httputil/reverseproxy.go#L44-L61>). Tailscale sets it back. Only a `unix:` target gets the target's host.
- **What else is added:** `X-Forwarded-Host` (the inbound host), `X-Forwarded-Proto: https` and `X-Forwarded-For` (`addProxyForwardedHeaders`, `serve.go:1068-1076` at v1.102.4), plus the `Tailscale-User-*` identity headers. `serve.go` doesn't touch `Origin`.
- **The docs are silent.** The `tailscale serve` page (<https://tailscale.com/kb/1242/tailscale-serve>, last validated 2026-01-26) says nothing about Host, so the source is the evidence. The spec's "L1 live check" (a 403 without the flag, success with it) will confirm it on the version we install.

**What dsh then sees.** The browser's own name, `dish.<tailnet>.ts.net`, with no port (443 is the default).

**What that means for the `/api` fence** (`dsh-client-connection/lib/index.js:205-219`):
1. The Host must be loopback or a trusted authority (`:210`). `dish.<tailnet>.ts.net` isn't loopback, so it must be trusted.
2. `Sec-Fetch-Site: cross-site` is refused (`:211`). A same-origin page sends `same-origin`.
3. If there's an `Origin`, its host must equal the Host's (`:212-217`). The browser sends `https://dish.<tailnet>.ts.net`, whose `.host` is the same name, so it passes.

So one entry is enough: `--trusted-host dish.<tailnet>.ts.net`.
- **A port-less entry matches that hostname on any port** (`:186-198`).
- **The flag is parsed as `--trusted-host <authority...>`** (`dsh-web-app/lib/startup.js:22`). It's variadic, so put it last in `ExecStart`, or write `--trusted-host=<name>`.
- **The entry must be a bare `host[:port]`** and canonical: no scheme, no path, lower case (`:155-173`). A bad one fails the load.
- **The browser cookie is keyed to the Host** (`:256-265,284-286`), so the 30-day sign-in belongs to the tailnet name.
- **The chat stream is a WebSocket** at `/api/remote.mux`, and the upgrade goes through the same fence (`dsh-api-gateway/lib/index.js:632-643`). The live chat check covers it.
- **Any other name is refused:** the node's tailnet IP or its short name arrives with another Host and gets a 403. That's the point of the fence.

**If Tailscale had rewritten Host to `127.0.0.1:3080`** (it doesn't):
- The Host check would pass with no flag, because it's loopback.
- But every request with an `Origin` would 403, since the Origin host `dish.<tailnet>.ts.net` is compared with the *Host header*, not with the trusted list. That's every POST, and the WebSocket upgrade.
- dsh has no setting that reads `X-Forwarded-Host` (it appears nowhere in the installed packages), and `--trusted-host` can't help.
- The only working fix would be in front of dsh, a proxy that passes the Host through.

**Two preconditions for the fleet run:**
- **HTTPS certificates must be enabled on the tailnet** (admin console → DNS → HTTPS Certificates → Enable HTTPS, <https://tailscale.com/kb/1153/enabling-https>). Otherwise `tailscale serve --https` runs an interactive enable flow (`cmd/tailscale/cli/serve_v2.go:462-471` at v1.102.4), which a play can't answer. Enabling it publishes the machine name and tailnet name on the public certificate ledger.
- **The flags exist:** `--bg` and `--https` (`serve_v2.go:239,241`).

## 5. inotify

**No change needed.** dsh's watches are few and shallow:

| Watcher | Scope | Evidence |
|---|---|---|
| Profile configuration reload | The profile's `package.json` and two patch files, each with a bounded depth. Source-module watching is off: the base `hmr` row has `root: []`. | `dsh-hmr/lib/index.js:45-56,353-376`, `dsh-base/cordis.patch.yml:27-33` |
| Credentials file | One file | `dsh-credentials-local/lib/index.js:448` |
| Files sidebar | `depth: 0`, the one directory or file being followed | `dsh-fs-local/lib/index.js:726-736` |
| Skill roots | `depth: 1`, at most 128 projects | `dsh-skill-filesystem/lib/index.js:28,372-376` |

- **The kernel's default** is `max_user_watches` between 8192 and 1,048,576, set at 1% of memory (`fs/notify/inotify/inotify_user.c:839-843` in Linux v6.12), and `max_user_instances` 128 (`:868`).
- **Leave it,** and look again at step 6. Workspaces are where agents will start dev servers and test watchers, which are far hungrier than dsh.

## Spot checks

On the desktop (Linux 7.1.13, Debian), in scratch directories and with no plugin loaded:
- **`bwrap --version`** gives 0.12.0. dsh's exact probe command exits 0.
- **`landlock-run --probe`** from the installed package prints `landlock: fully enforced`.
- **`/sys/kernel/security/lsm`** lists `landlock`.
- **The scope probe** (`systemd-run --user --scope ... systemctl --user show`) exits 0.
- **dsh's `workspace-write` profile, run by hand** around a scratch workspace:
  - a file outside the workspace, mode 0600, was **readable**;
  - writing next to it failed with "Read-only file system";
  - writing in the workspace and in `/tmp` worked;
  - writing in `$HOME` failed.

These show that the desktop works and that reads are open. They say nothing about the guest, which the role must check for itself.

## Other things the unit and the role must get right

- **Reads aren't confined.** Under bwrap, `--ro-bind / /` makes the whole filesystem readable, and Landlock's `--ro /` does the same.
  - An agent's shell command can read `~/.ssh` (both deploy keys, including the read-write one for the store) and `~/.dsh/.credentials.yaml` (the Copilot sign-in, the TypeSafe key and the browser-session secret).
  - File modes don't help, since the agent runs as the same user. The spec accepts this for the deploy keys. The credential file has the same exposure, so it belongs in that risk.
- **Don't harden the unit against namespaces or syscalls.** `RestrictNamespaces=`, `PrivateUsers=`, `SystemCallFilter=` and `MemoryDenyWriteExecute=` apply to every child, and would break bwrap (user, PID and mount namespaces) or V8's JIT. This is inferred, not tested. If D3 adds hardening, run the real sandbox under it.
- **Keep `DISPLAY` and `WAYLAND_DISPLAY` out of the unit,** and don't install `zenity` or `kdialog`, so the directory picker stays on `browse`. Keep `--no-open` so dsh never tries to launch a browser.
- **dsh reloads profile patch files while it runs** (`dsh-hmr/lib/index.js:353-376`), so `install.sh` editing `cordis.patch.yml` under a running unit is picked up live. Plugin source changes still need a restart. Worth confirming at L1 before relying on it for "restart only when something changed".

## What the guest role needs

**Packages (apt, Debian 13):**
- `bubblewrap`: required. It is the sandbox.
- `git` and `openssh-client`: required by the config store.
- `ca-certificates` and `curl`.
- `xz-utils`, if the Node tarball is the `.tar.xz`.
- `tailscale`, from Tailscale's own repository.
- `systemd` (in the image) and `dbus-user-session`, so the `dish` user manager and `systemd-run --user --scope` work. `libpam-systemd` recommends it, so a stock image already has it.
- `procps`, optional: `bubblewrap` recommends it, and agents may want `ps`.
- **Not needed by dsh or dish:** `build-essential`, `make`, `python3` (cloud-init already puts one on the image), `ripgrep`, `tmux`, `zenity`, `kdialog`, `xdg-utils`, LibreOffice.
  - **Decision for you:** the spec lists build essentials. Keep them only if you want agents to compile things. `dish` has no sudo, so adding them later is a fleet change.

**Sysctls:** none. Assert these read-only before starting the unit:
- `/proc/sys/kernel/unprivileged_userns_clone` is `1`;
- `/proc/sys/user/max_user_namespaces` is above 0;
- `/sys/kernel/security/lsm` contains `landlock`;
- inotify stays at the kernel defaults.

**Pins:**
- **Node:** 24.21.0, <https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz>. Checksums at <https://nodejs.org/dist/v24.21.0/SHASUMS256.txt>.
- **pnpm:** 11.25.0, <https://registry.npmjs.org/pnpm/-/pnpm-11.25.0.tgz>.

**The account:**
- `dish`, no sudo, linger on, **login shell `/bin/bash`** (the terminal panel falls back to `/bin/sh` otherwise).
- A user unit whose `PATH` includes Node's and pnpm's directories, and whose `XDG_RUNTIME_DIR` is the usual one.
- The deploy keys unencrypted, with `known_hosts` filled in before the first start, since the store's git can't prompt.

**Checks the role should run as `dish`, before it starts the unit:**
- `bwrap --ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent -- true` exits 0 (dsh's own probe).
- `systemd-run --user --scope true` exits 0.
- `git --version`, `ssh -V`, `node --version` and `pnpm --version` match the pins.

**The unit:**
- `pnpm dsh web --host 127.0.0.1 --port 3080 --no-open --trusted-host dish.<tailnet>.ts.net`, with the flag last.
- No namespace or syscall restrictions, no `DISPLAY`.
- `pnpm install --frozen-lockfile` as the README has it: no `--no-optional`.

**Tailscale:**
- HTTPS certificates enabled on the tailnet once, by you, before the first `tailscale serve`.
- `tailscale serve --bg --https=443 http://127.0.0.1:3080`.
- Host is passed through, so `--trusted-host` is exactly the tailnet name. L1 confirms it: a 403 without the flag, success with it, and a chat message (the WebSocket) after the login.

**Outbound from the VM:**
- `registry.npmjs.org` for `pnpm install`.
- `github.com`, by SSH, for the two repositories.
- `github.com`, `api.github.com` and `*.githubcopilot.com` for Copilot.
- `api.typesafe.ai` for the judge.
- `nodejs.org`, `pkgs.tailscale.com` and Tailscale's control plane, for the install.
- **Not needed to reach the UI:** nothing listens on the VM's own address, since `tailscale serve` dials `127.0.0.1`.
