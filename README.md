# dish

A personal plugin workspace for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`).

`dsh` is pinned as a dev dependency, so `pnpm dsh …` always runs the version the plugins were written against. Each directory under `plugins/` is a separate dsh **bundle**, meaning an npm package whose `cordis.patch.yml` adds plugin rows to a profile.

## Setup

```sh
pnpm install
pnpm build          # bundles each plugin's browser half (plugins/*/lib/client.js)
pnpm dsh plugin --profile web add ./plugins/copilot
pnpm dsh plugin --profile web add ./plugins/config
pnpm web            # = dsh web; prints the UI URL (with its access token)
```

`dsh plugin … add` links the checkout into `~/.dsh/profiles/web` and appends the bundle to that profile's layer stack. Because it is a link, nothing needs reinstalling after an edit:
- Server code (`src/*.ts`) takes effect on the next `dsh web` restart.
- Browser code (`src/client/`) hot-swaps into a running `dsh web` once rebuilt: run `pnpm --filter <plugin> dev` to watch.

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

## Writing another plugin

1. `mkdir -p plugins/<name>/src`, then copy `plugins/copilot/package.json` and `cordis.patch.yml` as a starting point. Rename the package and the row `id`.
2. Export `name`, `inject` (the services you need), an optional `Config` schema, and `apply(ctx, config)`.
3. Import dsh packages as **types only**, or declare them under both `peerDependencies` and `devDependencies`, so that at runtime the plugin shares the host's instances.
4. `pnpm install && pnpm typecheck`, then `pnpm dsh plugin --profile web add ./plugins/<name>`.

Plugins run as plain `.ts` through Node's type stripping, so stick to erasable syntax: no `enum`, `namespace`, or constructor parameter properties. `tsconfig.json` enforces this with `erasableSyntaxOnly`.

### Things that aren't obvious

- **Browser code must be pre-bundled.** A plugin's `./client` export is loaded by dsh's own module loader, not by Node, so it can't be raw `.ts`. `packages/dish-kit/scripts/build-client.mjs` is a reusable esbuild script for that, run from the plugin's directory; `plugins/copilot/README.md` explains the wiring.
- **`dsh web` prints no plugin logs.** The web profile mounts no console log exporter. A plugin that needs to reach the terminal has to register its own `ctx.logger.exporter(...)` (`printOwnLogs()` in `packages/dish-kit/src/terminal.ts` does this).
- **Upstream reference.** The dsh docs worth reading are `docs/user/develop/` (tutorials), `docs/cookbook/` (tools, remote APIs, settings cards), and each package's `README.md`. `.agents/notes/` records the reasoning behind upstream design decisions.
- **State lives in `~/.dsh`**: `profiles/<name>/` holds profile manifests and user patches, and `.credentials.yaml` holds stored keys and sign-ins.
