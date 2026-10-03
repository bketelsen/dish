# dish-workspaces

The mechanics behind dish's [projects](../projects/): the clones, the GitHub App that gives them read access, setup, the dsh workspaces, the scratch workspace, task worktrees and the sweep that removes merged ones.
- **Onboarding.** For each project [`dish-projects`](../projects/) hands it, this plugin finds the App's installation, clones the repo under the work root (or adopts a clone already there), configures it, runs `setup` on dish's own fresh clone, and registers the clone as a dsh workspace.
- **GitHub access.** A GitHub App, read-only in 6b. Agents' git gets a read token through a credential helper, so `fetch` works and `push` is refused.
- **Worktrees.** The `worktree` tool, for the main agent: one worktree per task, inside the clone, on `dish/<slug>`. Crew's `delegate` binds a coder to one. Merged ones are swept away.
- **Settings → GitHub App** takes the App's ID and private key, and tests them.

The design is in the [spec](../../docs/specs/projects-workspaces.md) and the [plan](../../docs/plans/2026-10-02-projects.md). Its "Notes from the build" say what changed on the way. The Apps themselves are made by hand: the plan's [rollout](../../docs/plans/2026-10-02-projects.md#the-rollout-for-you) has the steps.

## Install

```sh
pnpm --filter dish-workspaces build    # src/client → lib/client.js (the GitHub App card)
pnpm dsh plugin --profile web add ./plugins/projects
pnpm dsh plugin --profile web add ./plugins/workspaces
```

`deploy/install.sh` links both. The plugin needs nothing at load:
- it reads `dishProjects`, `dishCrew` and `credentials` with `ctx.get` when it uses them;
- it waits for `tools` (the `worktree` tool) and `workspaceRegistry` with `ctx.inject`. Only the `web` profile has a workspace registry. Elsewhere a project is ready without a workspace, and is registered once a registry appears;
- it never reads `dishConfig`.

Then, on **Settings → GitHub App**, set the App ID and the private key, and press **Test**.

## Where things live

| Where | What |
|---|---|
| `<work root>/<owner>/<repo>` | A project's clone. The work root is `~/work` in prod and `<checkout>/.dev/work` in dev (dish-kit's `workRoot()`: `$DSH_DISH_HOME/work` when that is set). |
| `<work root>/<owner>/.<repo>.cloning-<8 hex>` | A clone being made. It is renamed into place when it's done, and removed if the clone fails. |
| `<clone>/.worktrees/<slug>` | A task worktree, on branch `dish/<slug>`. `.worktrees/` is in the clone's `.git/info/exclude`. `.worktrees/.cache` is 6c's, never touched here. |
| `<work root>/scratch` | The scratch workspace, for general chats. |
| `<state>/workspaces/<owner>/<repo>/clone.json` | What dish knows of the clone: adopted or not, the installation, its workspace, the last fetch, the last setup. |
| `<state>/workspaces/<owner>/<repo>/setup.log` | The last 64 KB of onboarding's setup, masked, mode 0600. |
| `<state>/workspaces/<owner>/<repo>/worktrees/<slug>.json` | The record of a worktree dish made, with the commit it was cut from. Only a worktree with a record is dish's. |
| `<state>/workspaces/tokens/<owner>` | The owner's read token, lower-case name, as the token and a newline. Directory 0700, file 0600. Removed when dish stops. |
| `<state>/workspaces/scratch` | The record that the scratch workspace was registered. Delete it to have the workspace registered again at the next start. |
| dsh's credential store | The App ID and private key, as `DISH_GITHUB_APP_ID` and `DISH_GITHUB_APP_PRIVATE_KEY`: `~/.dsh/.credentials.yaml` in prod, `<checkout>/.dev/dsh/.credentials.yaml` in dev. Never in the config store. |

`<state>` is dish's XDG state directory: `~/.local/state/dish` in prod, `<checkout>/.dev/state/dish` in dev. Agents can't write it, which is why dish's records live there and not in the clone.

## Onboarding

dish-projects runs it one project at a time, and reports each step on Settings → Projects.

1. **Installation.** `GET /repos/{owner}/{repo}/installation` with the App's JWT. Without the App's credentials the project fails with "set the GitHub App on Settings → GitHub App"; without an installation, "install the dish App on {owner} and give it {repo}". The repo joins its owner's read token.
2. **Clone or adopt.** A clone already at the path is adopted if `.git` is a directory, its one `origin` is the repo on GitHub (HTTPS, `git@github.com:` or `ssh://git@github.com/`) and its config passes the [check](#dishs-own-git). An SSH origin is switched to HTTPS. Anything else at the path (another origin, an SSH host alias, a worktree, a key dish won't run git with) fails the project, naming what it found, and is left as it was. With nothing there, dish clones into the temporary directory, with the helper given only on the command line, and renames it into place.
3. **Configure.** In the clone's own `.git/config`: the credential helper (after an empty entry that drops any helper from your global config for `https://github.com`), `useHttpPath=true`, `credential.interactive=false`, the App's bot as `user.name` and `user.email`, and the HTTPS `origin`; `.worktrees/` in `.git/info/exclude`. Then the check. This runs again at every start, so the helper's path follows the checkout.
4. **Setup,** see [below](#setup).
5. **Workspace.** `workspaceRegistry.create(<clone>, "<owner>/<repo>")`, recorded in `clone.json`. A workspace you remove stays removed until you press Retry.

**At every start,** each ready project is *prepared*: step 3 again, a fetch, its workspace if it has none, then a sweep. If GitHub can't give the bot identity then (the network not up yet), the clone keeps the identity it has, and the project stays ready.

## Setup

`setup` runs outside dsh's sandbox, as the account, like a CI job. So it runs only in a checkout dish has just made of code a human merged: **dish's own fresh clone**, at onboarding, which is GitHub's default branch and has no ignored files yet.
- **An adopted clone** (adopting, or Retry) is skipped: an agent could have hidden files from `status` or changed ignored ones (`node_modules/.bin/*`, a `.pnpmfile.cjs`).
- **A new worktree** is skipped too: tools read config from parent directories (`pnpm-workspace.yaml`, `.pnpmfile.cjs`, `.npmrc`, `node_modules`, `.cargo/config.toml`, `go.work`), which agents in the clone can write. You chose this on 2026-10-02 (option A): the main agent runs the command in the worktree with dsh's escalation, which asks you, before it delegates.

A skip says why, and gives the command to run and where. In a fresh clone, setup is `bash -c <setup>` with stdin closed:
- **Its environment** is dsh's, scrubbed as dsh scrubs every agent shell (no name with `KEY`, `PASSWORD`, `SECRET` or `TOKEN`, no `DSH_*`), with every `GIT_*` name and `SSH_ASKPASS` removed and `GIT_TERMINAL_PROMPT=0` added. dish's git settings (`SAFE_FLAGS`) are added as `GIT_CONFIG_COUNT` pairs, with `-c` precedence, and `GIT_GRAFT_FILE=/dev/null`, so the git that setup runs has hooks off too.
- **Its own process group,** sent TERM and then KILL after 5 seconds when `setupTimeout` passes, when the project is removed, or when dish stops.
- **A failure** fails the project, with the last 20 lines of its masked log in the message.

## Credentials

- **The App's ID and private key** are two references in dsh's credential store, read with `ctx.get('credentials')?.resolve(ref)` for each request that needs the JWT, and never kept. The card sets them through dsh's own `credentials` remote, in the browser, so dish's server never receives them from the page.
- **The file token** has `contents: read` and `metadata: read`, for the repos of that owner's projects (one installation per owner). It is minted again 10 minutes before its hour runs out. A failed refresh is logged once per distinct error and tried again after a minute, and the old file stays until it expires.
- **dish's own API reads** (pull requests for the sweep) use a second token, `metadata: read` and `pull_requests: read`, kept in memory only. The bot's profile (`GET /users/<slug>[bot]`) is public and is read without a credential, once per service life, so an installation that hasn't accepted Pull requests read still onboards.
- **Read-only, enforced.** `createToken` refuses anything but `read` before it sends a request, and refuses a token GitHub granted more than read.
- **No token on disk but its file.** Never in an argument, a URL, an environment variable, a config value or a log. Errors are masked with dish-kit's `maskSecrets`, and the card's texts also have the App ID and the key's lines taken out.

### The helper

`bin/git-credential-dish` is a POSIX `sh` script. Each clone's config runs it by its absolute path, through `/bin/sh`, so it needs no exec bit:

```
credential.https://github.com.helper = !/bin/sh '<checkout>/plugins/workspaces/bin/git-credential-dish' '<state>/workspaces/tokens' 'https://github.com'
```

It answers git's `get` for `https://github.com` only, with `username=x-access-token` and the first line of `<tokens dir>/<owner>` (the URL's first path segment, lower-cased), then `quit=true`. An owner that isn't a GitHub login, or one with no token file, gets `quit=true` alone, so git never prompts. Another origin gets nothing. `store` and `erase` are ignored, so git's own credential is never kept. It writes no file and reaches no network.

## dish's own git

Agents in a project's workspace can write anything in the clone, `.git` included. So every git command this plugin runs goes through `git()` (`src/git.ts`), and no other module starts git:
- **`SAFE_FLAGS`** on every call: `core.hooksPath=/dev/null`, `core.fsmonitor=false`, `fetch.recurseSubmodules=false`, `submodule.recurse=false`, `core.useReplaceRefs=false`, `safe.bareRepository=explicit`, `advice.graftFileDeprecated=false`, `credential.interactive=false` and `core.commitGraph=false`; and `GIT_GRAFT_FILE=/dev/null` in its environment. Hooks, fsmonitor, submodule recursion, replace refs, grafts and a forged commit-graph never change what dish's git does.
- **No nested repository is looked into.** `status`, `diff`, `diff-index` and `diff-files` are refused unless they pass `--ignore-submodules=dirty` (or `=all`): a repository an agent makes inside the clone has its own config, which the check never sees.
- **A scrubbed environment,** as setup's, its own process group, a time limit that kills the group, stdin closed, and output capped at 4 MB.
- **The check** (`checkClone`), before dish works in a clone: `.git` a directory, no `commondir` or `config.worktree`, each worktree's administrative files where git put them, and the local config only these keys: core basics and `core.hooksPath` (any value: dish overrides it), `remote.<name>.url`, `.fetch`, `.pushurl`, `.prune` and `.tagopt` (no `ext::` or `fd::` URL; `origin` exactly the project's, with dish's refspec), `submodule.<name>.url` and `.active`, `branch.<name>.remote`, `.merge`, `.rebase`, `.pushremote` and `.description`, `user.name` and `user.email`, the credential keys with dish's values, `extensions.objectformat` and `.refstorage`, `pull.rebase`, `pull.ff`, `push.default`, `push.autosetupremote`, `fetch.prune` and `init.defaultbranch`. Anything else (a filter, a driver, `include.path`, `core.sshCommand`, `extensions.worktreeConfig`) refuses the clone, naming the key, and the project shows it. Remove the key and press Retry.
- **Writing `.git/config`** never follows a link: dish edits a private copy under its state directory, takes git's own `config.lock`, writes beside the file and renames over it, after checking that `.git` and the file are still the ones it read. A crash leaves the old file whole.
- **Fetch** is `git fetch --prune origin +refs/heads/*:refs/remotes/origin/*`, the refspec on the command line, then `git remote set-head origin --auto`.

## Worktrees

### The `worktree` tool

For the main agent only: it refuses any other caller, and it is on crew's never-list. In a registered, ready project, from a chat whose workspace is that project's clone (a coder works in its chat's sandbox, which is that workspace):

| Action | Input | What it does |
|---|---|---|
| `create` | `project`, `slug`, optional `base` | Fetches, then makes `<clone>/.worktrees/<slug>` on a new branch `dish/<slug>` (`--no-track`), cut from `base` or `origin/<default branch>`, and records it. Answers the path, the branch, the base commit and the setup command to run. A slug is `[a-z0-9][a-z0-9-]*`, at most 40 characters, and not in use. |
| `list` | optional `project` | Each worktree: ahead and behind the default branch, dirty or clean, merged or not, whether dish made it, and the crew children bound to it. |
| `remove` | `project`, `slug`, optional `force` | Removes a worktree dish made, its branch and its record. Without `force`, only a merged and clean one. Never one a running coder is bound to, even with `force`. |

Crew's `delegate` takes the worktree as `worktree` (`<project>/<slug>` or the path), through `dishWorkspaces.resolve`. See [crew's README](../crew/README.md#binding-a-coder-to-a-worktree).

### The sweep

After every fetch dish makes (`create`'s and `prepare`'s included) and in the hourly round, each ready project's managed worktrees are looked at:
- **Merged** means GitHub lists a merged pull request whose head is the branch's tip (`GET /repos/{o}/{r}/commits/{tip}/pulls`), which covers squash merges, or the branch has commits of its own and its tip is an ancestor of the default branch as GitHub reports it (`git ls-remote --symref origin HEAD`, right after the fetch; the clone's own `origin/*` refs are never trusted). A new worktree, still at its base, is never merged. A branch that gained commits after its pull request merged isn't either.
- **Removed:** a merged worktree that is clean, bound to no running coder, and not handed to a coder (resolved) in the last 5 minutes. `git worktree remove` on its own path, never `--force` and never `git worktree prune`, then its branch (if it is still the tip that was found merged, and no other worktree has it checked out) and its record.
- **Kept,** with the reason: not merged; dirty (modified or untracked files, a gitlink, a nested repository, a worktree inside it; ignored files such as `node_modules` don't count); bound; resolved recently; a `.git` that isn't what git made.
- **Never looked at:** anything under `.worktrees/` without a record, such as a worktree you made by hand or 6c's `.cache`.

A worktree whose directory and branch you removed by hand has its record dropped. A failure on one worktree is logged and the sweep goes on.

### The hourly round

First 5 minutes after start, then every hour: for each ready project, one at a time, under its lock, the read token, a fetch and the sweep. A round never overlaps the one before. A failure is logged once per project and error.

## The service

```ts
interface DishWorkspaces {
  onboard(project, options?): Promise<OnboardResult>        // steps 1 to 5; dish-projects drives it
  prepare(project): Promise<void>                           // for a ready project at start
  describe(name): CloneInfo | undefined                     // synchronous: clone, adopted, workspace, last fetch, worktrees
  createWorktree(project, slug, base?, options?): Promise<CreatedWorktree>
  listWorktrees(project?): Promise<WorktreeInfo[]>
  removeWorktree(project, slug, force?): Promise<void>
  resolve(pathOrRef): Promise<Worktree | undefined>         // for delegate and 6c's gates
  sweep(project?): Promise<SweepResult>
  appStatus(test): Promise<AppStatus>                       // for Settings → GitHub App
}
```

Every operation on one project (onboarding, prepare, create, remove, a fetch, a sweep, a late workspace registration) runs under that project's lock; `resolve`, `listWorktrees` and `describe` don't lock. When the plugin goes, every timer is cleared, the work in flight is aborted and waited for (its processes killed), and the token files are removed.

## Settings → GitHub App

Between Projects and History in Settings' nav.
- **The App ID** (digits, as GitHub shows it) and **the private key** (the whole `.pem`, line breaks and all), each with Set and Remove. Neither is ever shown again: the card says only whether each is set and where it comes from. A field is cleared the moment it is sent.
- **Test** asks GitHub for the App's name and slug, its bot (`<slug>[bot]` and its noreply email) and every installation (the account, and whether it has all repositories or chosen ones).
- The card says the pair lives in dsh's credential store, and that dev's store, and dev's App, are separate. It reads everything again when dsh says either credential changed.

Its server half is `dishWorkspacesRemote` (wire namespace `dishWorkspaces`): `status()` (the last test's answer, or a fresh one) and `test()`. Neither takes nor gives the ID or the key, and the answer leaves out the App's numeric ID.

## Configuration

| Row | Field | Default | |
|---|---|---|---|
| `dish-workspaces` | `appIdName` | `DISH_GITHUB_APP_ID` | The App ID's name in dsh's credential store. |
| `dish-workspaces` | `privateKeyName` | `DISH_GITHUB_APP_PRIVATE_KEY` | The private key's name in dsh's credential store. |
| `dish-workspaces` | `terminal` | `true` | Print this plugin's messages to the terminal. |

Both names must be environment-variable names; the plugin refuses to load otherwise.

## Decisions and known limits

Two decisions, both yours on 2026-10-02 (the spec's "Decided after the checks"):
1. **Setup runs outside the sandbox only on code a human merged,** and, after the reviews, only in dish's own fresh clone. Adopted clones, Retry and worktrees give the command instead.
2. **Both Apps are read-only for now** (Contents, Pull requests and Metadata read). An agent can read dsh's credential file, so with a write App it could mint a token that pushes. Step 7 adds write, with a way to keep the key from agents.

Known limits (the spec's [list](../../docs/specs/projects-workspaces.md#known-limits) has them all):
- **Check, then act.** The clone check and dish's next git command are two steps, as are the last checks and the rename of `.git/config`. An agent racing dish could slip a key past the check once, or swap `.git` for a link in between. Closing it means running dish's working-tree git inside the sandbox, which 6c's runner makes possible.
- **Forged objects.** An agent can overwrite a stored object under its real hash. A fresh clone is free of that; it is why nothing else runs setup unsandboxed.
- **A worktree's install needs you.** Setup doesn't run in a new worktree; the main agent runs it escalated, and you approve it. 6c's sandboxed runner can take that over.
- **A nested repository inside an ignored folder** (a clone under `node_modules/`) is an ignored file to git, so removing its worktree deletes it, history and edits included.
- **Linux only** for writing a clone's config: the location checks read `/proc/self/fd`. Elsewhere dish configures no clone.
- **After a crash:** a temporary clone directory (`.<repo>.cloning-<hex>`) and a `.git/config.lock` stay for you to remove (the project's message says so), and token files stay until the next start prunes and rewrites them.
- **Agents can read the token file.** It's read-only, lasts an hour and covers only the projects' repos.
- **A clone with an SSH alias origin** (`git@github-dish:…`, 6a's deploy-key days) isn't adopted. Move it aside.
