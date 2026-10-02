# dish-copilot

Use your GitHub Copilot subscription as a model provider in DeepSeek Harness. The package holds three pieces:
- a sign-in card on **Settings → Models** (in the footer until Copilot has a route)
- a server remote the card talks to
- a catalog plugin that keeps the model picker in step with what your account actually offers

## Build

The browser half is bundled; the server half runs as plain `.ts`.

```sh
pnpm --filter dish-copilot build   # src/client → lib/client.js
pnpm --filter dish-copilot dev     # rebuild on change; a running dsh web hot-swaps the card
```

Server changes (`src/*.ts`) need a `dsh web` restart.

## How sign-in works

The bundled `llm-pi-ai` adapter already has everything needed to talk to Copilot:
- the model catalog
- token refresh
- a device-code sign-in flow, registered with the authorization seam under `llm-pi-ai/github-copilot`

Upstream moved the *button* that starts that flow out of the product, for provider terms-of-service reasons. This package supplies it:

| Piece | File | Role |
|---|---|---|
| Card | `src/client/` | Registered into the Models page's `settings.models.provider-card` seat under the `llm-pi-ai` key. It renders only on the `github-copilot` card and shows sign-in, the device code (with Copy and Open GitHub), sign-out, and **Refresh models**. On a fresh profile it also registers in the `settings.models.footer` seat; see below. |
| Remote | `src/remote.ts` | `CopilotRemote`, a Typert remote service. `signIn` is a stream: it calls `ctx.authorization.begin()` and pushes each notice (the device code arrives as one) until the attempt settles. Closing the stream cancels the attempt. |
| Plugin | `src/index.ts` | Mounts the remote. On `authorization/settled` for the Copilot key, it adds the `github-copilot` route if it's missing and refreshes the catalog. This works however the sign-in was started, whether from the card, the terminal, or another tab. |

**The first sign-in.** The provider card sits on the `github-copilot` route's card, and a fresh profile has no such route: the plugin adds it only after a sign-in. So on a fresh profile the same panel, titled **GitHub Copilot**, sits in the Models page's footer until the route exists.
- `CopilotRemote.status()` reports `route`, whether `llm-pi-ai` has a `github-copilot` provider (`src/route.ts`). The footer shows while the status has loaded and `route` is false (`src/client/first-sign-in.ts`).
- The footer and the provider card share one store, so a sign-in started in either shows in both.
- After a sign-in the plugin adds the route. The client reloads the status when the settings change, so the footer goes away and the provider card takes over.
- With `addRoute: false` the route never appears, so the footer stays.

The token is written, refreshed, and read only by `llm-pi-ai`. The card and remote only ever see "signed in: yes/no".

### Wiring an external plugin into the web UI

dsh generates these pieces for in-tree packages. The generators aren't published, so this package does each one by hand:

- **Browser bundle.**
  - `package.json` declares `dsh.client: { platform: "web" }` and an `exports["./client"]` pointing at `lib/client.js`.
  - `dish-kit`'s `scripts/build-client.mjs` builds that file in the shape dsh's module loader expects: one CommonJS factory passed to `window.__ModuleLoader__.load`, with React, Cordis and the shared UI packages left as `require()` calls that the shell satisfies. The `build` and `dev` scripts call it.
- **Remote descriptors.** `src/client/remote.ts` hand-writes the `TypertRemoteContribution` that `ctx.remote.$mount()` takes, with `dish-kit`'s `remoteDescriptor()` and `remoteContribution()`. The gateway serves the methods through its source-mode fallback, reading parameter names from the method source.
- **`@Remote` without decorators.** Node's type stripping has no decorator syntax, so `markRemote()` from `dish-kit` runs the decorator's initializer by hand.

## Keeping the model list current (`dish-copilot-catalog`)

pi-ai ships Copilot's model catalog as data frozen at its release. `llm-pi-ai` can only serve models that catalog describes, because a Copilot route mixes three wire protocols:
- Anthropic Messages for Claude
- Responses for GPT and Grok
- Chat Completions for Gemini

A model the catalog doesn't know has no protocol to use. So the stock picker goes stale in both directions: it misses new models, and it lists ones your plan doesn't include.

At startup, after each sign-in, and on **Refresh models**, the catalog plugin:

1. Fetches Copilot's live `GET /models` for your account.
2. For each model the picker would offer that pi-ai doesn't know, adds an entry to pi-ai's in-memory catalog.
   - The protocol comes from the model's `supported_endpoints`.
   - Name, context window, output limit and vision come from the live listing.
   - Headers, compat switches and reasoning levels are cloned from the nearest catalog sibling: the same vendor, then the closest version, then the closest name. So `gpt-6.1-sol` comes from `gpt-6-sol`, and `claude-sonnet-5.5` from `claude-opus-5.5` rather than the older `claude-sonnet-5`, whose way of turning thinking off the 5.5 models reject.
3. Sets the `github-copilot` route's `models` to exactly what your account can use. Per-model fields you've configured are kept.
4. Caches the result as `copilot-models.json` in dish's cache directory: `.dev/cache/dish/` in dev, `$XDG_CACHE_HOME/dish/` (`~/.cache/dish/` by default) on the VM. A cache at the old location, `$DSH_HOME/dish-copilot-models.json` (`.dev/dsh` in dev, `~/.dsh` on the VM), is read while the new file doesn't exist yet, i.e. until the first successful refresh writes it.

`llm-pi-ai` reads the catalog when its config changes, not per request. So this bundle patches the `llm-pi-ai` row with `inject: [copilotCatalog]`. The adapter mounts only after the cached additions are back in place, and they resolve from the first request after a restart.

**Dependency on a pi-ai internal.** The patch targets the `GITHUB_COPILOT_MODELS` object in `dist/providers/github-copilot.models.js`. It's resolved from `llm-pi-ai`'s own location, so it's the same module instance the adapter uses.
- If a dsh upgrade moves that object, the plugin logs a warning and only prunes the route.
- It always provides `copilotCatalog`, because `llm-pi-ai` waits for it. To remove the plugin, remove the whole bundle rather than disabling the catalog row, or `llm-pi-ai` never mounts.

## Configuration

Set in the profile's `cordis.patch.yml`: `.dev/dsh/profiles/web/` in dev, `~/.dsh/profiles/web/` on the VM.

`dish-copilot` row:

| Field | Default | |
|---|---|---|
| `enterpriseDomain` | `''` | GitHub Enterprise host (e.g. `company.ghe.com`); blank means github.com. Used by the card and the terminal. |
| `addRoute` | `true` | Add the `github-copilot` route after a successful sign-in. |
| `terminalSignIn` | `false` | At startup, when not signed in, start the sign-in and print the device code to the terminal. Not needed for a first sign-in; the Models page offers one. |
| `terminal` | `true` | Print this plugin's messages to the terminal. |
| `flowWaitMs` | `30000` | How long the terminal sign-in waits for `llm-pi-ai` to register its flow. |

`dish-copilot-catalog` row:

| Field | Default | |
|---|---|---|
| `cacheFile` | `$XDG_CACHE_HOME/dish/copilot-models.json` | Where the last refresh is cached. |
| `legacyCacheFile` | `$DSH_HOME/dish-copilot-models.json` (set by the bundle) | Read while `cacheFile` doesn't exist yet; never written or deleted. |
| `refreshOnStart` | `true` | Refresh at startup when signed in. |
| `updateRoute` | `true` | Rewrite the route's model list to match the account. |
| `terminal` | `true` | Print this plugin's messages to the terminal. |

## Caveats

- Sign-in impersonates the VS Code Copilot Chat client, as pi, opencode and similar tools do. That's the reason upstream moved it out of the product, so use it with your own subscription and at your own discretion.
- **Sign out** forgets the stored sign-in locally but doesn't revoke it on GitHub (do that under GitHub → Settings → Applications). The route stays, so its models remain in the picker and fail until you sign in again.
- A sign-in attempt lives only in the running process. Restarting `dsh web` mid-sign-in abandons it.
- The card answers pi-ai's one sign-in question (which GitHub host) from `enterpriseDomain`. If a future pi-ai asks anything else, the attempt fails with that question in the error.
