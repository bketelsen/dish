# dish

A personal plugin workspace for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`).

`dsh` is pinned as a dev dependency, so `pnpm dsh …` always runs the version the plugins were written against. Each directory under `plugins/` is a separate dsh **bundle**, meaning an npm package whose `cordis.patch.yml` adds plugin rows to a profile.

## Setup

```sh
pnpm install
pnpm dev            # installs dish into dev's profile and serves it on 127.0.0.1:3090
```

`pnpm dev` is dish in dev, from this checkout:
- **The install.** It runs `deploy/install.sh` every time, which is idempotent: the dependencies and the build, then on the first run dev's profile, and any new bundle later. Dev's config store never has a remote, so it can never push over prod's.
- **The server.** It starts the plugins' client watchers and `dsh web` on `127.0.0.1:3090` (`pnpm dev --port <n>` changes it; 0 lets dsh pick), and prints `dev: open <url>` after dsh's sign-in line. Open that link.
- **Stopping it.** Ctrl-C. A second Ctrl-C forces dsh out, as dsh does itself. Ctrl-\ stops it too, but pnpm gives the prompt back before dsh has stopped, so prefer Ctrl-C. Ctrl-Z pauses only `pnpm dev`: dsh and the watchers keep running until you `fg` and stop it. From another shell, SIGTERM the `node scripts/dev.ts` process, not the outer `pnpm`, which doesn't pass signals on. A SIGKILL leaves dsh and the watchers running. After a signal n, `scripts/dev.ts` exits 128+n (130 for Ctrl-C). Its header has the details, and why.

**Where dev's data lives.** In the checkout's git-ignored `.dev/`. dsh's home is `.dev/dsh` (profiles, sessions and the credential file), and dish's config, state, data and cache are `.dev/{config,state,data,cache}/dish`. Dev's work root is `.dev/work`: the projects' clones and the `scratch` workspace, which dish registers on the first start. pnpm's store stays the account's. Dev starts empty: no sessions, a fresh config store, no projects, no Copilot sign-in (the footer card on Settings → Models does the first one), no TypeSafe key (paste it on Settings → Judge), unless `TYPESAFE_API_KEY` is in the environment you start `pnpm dev` from, and no GitHub App (Settings → GitHub App takes dev's own App, never prod's). They all go into dev's credential file, `.dev/dsh/.credentials.yaml`. Without the TypeSafe key the judge fails closed, and the main agent asks you before every shell command. Remove `.dev/` to start over.

**`DISH_ENV`.** `pnpm dsh …` goes through a launcher, `scripts/env.ts`, which is dev unless `DISH_ENV=prod`. Dev sets `DSH_HOME=<checkout>/.dev/dsh` and `DSH_DISH_HOME=<checkout>/.dev`, replacing inherited values. `DISH_ENV=prod` passes the environment through, so dsh and dish use `~/.dsh` and the account's XDG directories: prod's data. Only the VM's service is prod, and it gets there by running dsh's binary directly, not through the launcher. `pnpm dev` refuses prod, and any other value is refused. [`deploy/README.md`](deploy/README.md#prod-and-dev) has the table.

By hand, the bundles go in one at a time, into dev's profile (`.dev/dsh/profiles/web`):

```sh
pnpm build          # bundles each plugin's browser half (plugins/*/lib/client.js)
pnpm dsh plugin --profile web add ./plugins/copilot
pnpm dsh plugin --profile web add ./plugins/config
pnpm dsh plugin --profile web add ./plugins/prompts
pnpm dsh plugin --profile web add ./plugins/skills
pnpm dsh plugin --profile web add ./plugins/crew
pnpm dsh plugin --profile web add ./plugins/judge
pnpm dsh plugin --profile web add ./plugins/web
pnpm dsh plugin --profile web add ./plugins/projects
pnpm dsh plugin --profile web add ./plugins/workspaces
pnpm dsh web        # prints the UI URL (with its access token)
```

`dsh plugin … add` links the checkout into the profile and appends the bundle to its layer stack. Because it is a link, nothing needs reinstalling after an edit:
- Server code (`src/*.ts`) takes effect on the next restart of `pnpm dev`.
- Browser code (`src/client/`) hot-swaps into a running `dsh web` once rebuilt. `pnpm dev` runs the watchers; by hand, `pnpm --filter <plugin> dev`.

Remove a plugin with `pnpm dsh plugin --profile web remove dish-copilot`.

Check what a profile will load without booting it:

```sh
pnpm dsh --profile web --dump-config | grep -A3 dish-
```

## Plugins

Shared code lives in [`packages/dish-kit`](packages/dish-kit): XDG paths, terminal logging, remote helpers and the client build script.


| Plugin | What it does |
|---|---|
| [`copilot`](plugins/copilot) | GitHub Copilot as a model provider: a sign-in card on Settings → Models, plus a model list kept in step with your account (including models newer than dsh's bundled catalog). |
| [`config`](plugins/config) | The versioned config store other plugins keep what you author in: a bare git repo pushed to GitHub, namespaces per plugin, main-agent tools with proposal branches, and a Settings → History page. |
| [`prompts`](plugins/prompts) | Every agent's persona text in the config store: role prompts plus shared house rules, edited on Settings → Prompts with preview, default diff and history. Each agent keeps the prompt it started with. |
| [`skills`](plugins/skills) | dish's own skills in the config store, one `SKILL.md` each: the pipeline's procedures (brainstorm, plan, test-first, review) and one for each crew role that has no counterpart. Each agent on the dish preset is offered its role's skills through dsh's skill registry, and every skill is in the `/` menu. Edited on Settings → Skills with check, default diff and history. |
| [`crew`](plugins/crew) | The crew the main agent delegates to: a `delegate` tool with roles, model tiers and a reviewer that never shares the reviewed work's model family, `crew.yaml` in the config store, saved reports and role-named finish notices. Ships the **dish** preset for the main agent. |
| [`judge`](plugins/judge) | TypeSafe's Jev in front of every agent's risky edges: a gate on each shell command (read-only, reversible or irreversible, and does it serve the task), an answerer for crew children's approvals, a screen on web and MCP results for injected instructions, `ask_judge` for every agent, and Settings → Judge with the key, thresholds and a decision log. |
| [`projects`](plugins/projects) | The repos dish works on: `projects.yaml` in the config store (family, role, gate, setup), onboarding each one in the background, one at a time, and Settings → Projects with its status, Retry, and add, edit and remove. |
| [`workspaces`](plugins/workspaces) | The mechanics behind projects: a clone of each under the work root through a read-only GitHub App (agents can fetch, not push), setup on dish's own fresh clone, a dsh workspace per clone plus a `scratch` one, task worktrees through the main agent's `worktree` tool (crew's `delegate` binds a coder to one), a sweep that removes merged ones, and Settings → GitHub App. |
| [`web`](plugins/web) | Settings over the tailnet. On your trusted host (`--trusted-host`), pages count as the operator's own machine, so Settings → Models, provider sign-ins and durable UI preferences work there as they do on `127.0.0.1`. Host-only, with no browser half. |

## Deploying

dish also runs on its own VM, reachable on your tailnet only. That service is prod, and nothing updates it on its own: you run `incus exec minideb:dish --project dish -- dish-update`, a dry run, then the same with `--apply`. [`deploy/`](deploy) holds the install script, the systemd unit and the two scripts you run there, `update.sh` and `url.sh`. [`deploy/README.md`](deploy/README.md) says what the VM runs, how to update it, how to sign in and the one-time steps. The design is in the [deploy spec](docs/specs/deploy.md) and the [ops spec](docs/specs/ops.md).

## License

MIT, in [LICENSE](LICENSE). The skills adapted from [obra/superpowers](https://github.com/obra/superpowers) keep their MIT notice in [plugins/skills/defaults/NOTICE.md](plugins/skills/defaults/NOTICE.md). Links to `bketelsen/fleet`, the infrastructure repo, go to a private repository.

## Writing another plugin

1. `mkdir -p plugins/<name>/src`, then copy `plugins/copilot/package.json` and `cordis.patch.yml` as a starting point. Rename the package and the row `id`.
2. Export `name`, `inject` (the services you need), an optional `Config` schema, and `apply(ctx, config)`.
3. Import dsh packages as **types only**, or declare them under both `peerDependencies` and `devDependencies`, so that at runtime the plugin shares the host's instances.
4. `pnpm install && pnpm typecheck`, then `pnpm dsh plugin --profile web add ./plugins/<name>`. Add it to `bundles` in `deploy/install.sh` too, so that `pnpm dev` and the VM install it.

Plugins run as plain `.ts` through Node's type stripping, so stick to erasable syntax: no `enum`, `namespace`, or constructor parameter properties. `tsconfig.json` enforces this with `erasableSyntaxOnly`.

### Things that aren't obvious

- **Browser code must be pre-bundled.** A plugin's `./client` export is loaded by dsh's own module loader, not by Node, so it can't be raw `.ts`. `packages/dish-kit/scripts/build-client.mjs` is a reusable esbuild script for that, run from the plugin's directory; `plugins/copilot/README.md` explains the wiring.
- **`dsh web` prints no plugin logs.** The web profile mounts no console log exporter. A plugin that needs to reach the terminal has to register its own `ctx.logger.exporter(...)` (`printOwnLogs()` in `packages/dish-kit/src/terminal.ts` does this).
- **Upstream reference.** The dsh docs worth reading are `docs/user/develop/` (tutorials), `docs/cookbook/` (tools, remote APIs, settings cards), and each package's `README.md`. `.agents/notes/` records the reasoning behind upstream design decisions.
- **dsh's state lives in its home**, `.dev/dsh` in dev and `~/.dsh` in prod: `profiles/<name>/` holds profile manifests and user patches, and `.credentials.yaml` holds stored keys and sign-ins.
