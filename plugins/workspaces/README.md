# dish-workspaces

The mechanics behind dish's [projects](../projects/): the clones, the GitHub App that gives them access, setup, the dsh workspaces, the scratch workspace, task worktrees and the sweep that removes merged ones.
- **Onboarding.** For each project [`dish-projects`](../projects/) hands it, this plugin finds the App's installation, clones the repo under the work root (or adopts a clone already there), configures it, runs `setup` on dish's own fresh clone, and registers the clone as a dsh workspace.
- **GitHub access.** A GitHub App: read tokens for agents' git; `open_pr`'s pushes, pull requests and comments use a write token minted in memory per call (step 7). Agents' git gets its read token through a credential helper, so `fetch` works and `push` is refused. Only the main agent's `open_pr` ([dish-orchestrator](../orchestrator/)) pushes a run's branch and opens, updates or comments on its pull request, through this plugin's `pushBranch`, `openPull`, `updatePull` and `commentPull`; `pr_feedback` reads it with `readPull`.
- **Worktrees.** The `worktree` tool, for the main agent: one worktree per task, inside the clone, on `dish/<slug>`. Crew's `delegate` binds a coder to one. Merged ones are swept away.
- **Settings → GitHub App** takes the App's ID and private key, and tests them.

The design is in the [spec](../../docs/specs/projects-workspaces.md) and the [plan](../../docs/plans/2026-10-02-projects.md). Its "Notes from the build" say what changed on the way. The Apps themselves are made by hand: the plan's [rollout](../../docs/plans/2026-10-02-projects.md#the-rollout-for-you) has the steps. Today there is one, the dev App `bketelsen-dish-dev`, and the VM uses it (since 2026-10-03); the prod App the rollout names, `bketelsen-dish`, hasn't been made.

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
| `<clone>/.worktrees/<slug>` | A task worktree, on branch `dish/<slug>`. `.worktrees/` is in the clone's `.git/info/exclude`. Anything else in `.worktrees/`, such as a cache a project's `gateEnv` puts there, is never touched here. |
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

1. **Installation.** `GET /repos/{owner}/{repo}/installation` with the App's JWT. Without the App's credentials the project fails with "set the GitHub App on Settings → GitHub App, then press Retry on Settings → Projects"; without an installation, "install the dish App on {owner} and give it {repo}, then press Retry on Settings → Projects". The repo joins its owner's read token.
2. **Clone or adopt.** A clone already at the path is adopted if `.git` is a directory, its one `origin` is the repo on GitHub (HTTPS, `git@github.com:` or `ssh://git@github.com/`) and its config passes the [check](#dishs-own-git). An SSH origin is switched to HTTPS. Anything else at the path (another origin, an SSH host alias, a worktree, a key dish won't run git with) fails the project, naming what it found, and is left as it was: "move it away or fix it, then press Retry on Settings → Projects". With nothing there, dish clones into the temporary directory, with the helper given only on the command line, and renames it into place.
3. **Configure.** In the clone's own `.git/config`: the credential helper (after an empty entry that drops any helper from your global config for `https://github.com`), `useHttpPath=true`, `credential.interactive=false`, the App's bot as `user.name` and `user.email`, and the HTTPS `origin`; `.worktrees/` in `.git/info/exclude`. Then the check. This runs again at every start, so the helper's path follows the checkout.
4. **Setup,** see [below](#setup).
5. **Workspace.** `workspaceRegistry.create(<clone>, "<owner>/<repo>")`, recorded in `clone.json`. A workspace you remove stays removed until you press Retry.

**At every start,** each ready project is *prepared*: step 3 again, a fetch, its workspace if it has none, then a sweep. If GitHub can't give the bot identity then (the network not up yet), the clone keeps the identity it has, and the project stays ready. A clone deleted by hand fails the project at configure: "the clone at <path> is gone; press Retry on Settings → Projects to clone it again". Retry clones it afresh, and setup runs. A project removed meanwhile isn't fetched.

## Setup

`setup` runs outside dsh's sandbox, as the account, like a CI job. So it runs only in a checkout dish has just made of code a human merged: **dish's own fresh clone**, at onboarding, which is GitHub's default branch and has no ignored files yet.
- **An adopted clone** (adopting, or Retry) is skipped: an agent could have hidden files from `status` or changed ignored ones (`node_modules/.bin/*`, a `.pnpmfile.cjs`). dish's own clone after a failed setup is adopted too, so Retry, a restart or an edit doesn't run setup again: remove the clone and press Retry, or run the command yourself.
- **A fresh clone that another dsh workspace points at** is skipped ("a dsh workspace already points at this path"), with the command, and the workspace is reused. Another means not the workspace `clone.json` recorded for the project, which outlives the clone: dish takes that one to be your own project's. So a Retry after the clone was deleted by hand, or a project removed and added again, runs setup, and so does a case dish can't tell (no `clone.json` from before, a registry that can't be asked), although that workspace's chats can write in the clone too (a known limit, below). It is asked of dsh's workspace registry, so only in the `web` profile.
- **A new worktree** is skipped too: tools read config from parent directories (`pnpm-workspace.yaml`, `.pnpmfile.cjs`, `.npmrc`, `node_modules`, `.cargo/config.toml`, `go.work`), which agents in the clone can write. You chose this on 2026-10-02 (option A). The tool's answer gives the command, to run in the worktree in the sandbox before the work starts: the main agent runs it, or tells the coder to run it first. On dish's VM the sandbox can write the home directory (pnpm's store, mise, `~/go`, caches), so it needs no escalation. Only if it fails with "Read-only file system" (a system install, or a dev machine where `DISH_SANDBOX_HOME` is off) does the main agent run it again escalated, and the judge allows that or asks you. A coder can't escalate: it reports the command.

A skip says why, and gives the command to run and where. In a fresh clone, setup is `bash -c <setup>` with stdin closed:
- **Its environment** is dsh's, scrubbed as dsh scrubs every agent shell (no name with `KEY`, `PASSWORD`, `SECRET` or `TOKEN`, no `DSH_*`), with every `GIT_*` name and `SSH_ASKPASS` removed and `GIT_TERMINAL_PROMPT=0` added. dish's git settings (`SAFE_FLAGS`) are added as `GIT_CONFIG_COUNT` pairs, with `-c` precedence, and `GIT_GRAFT_FILE=/dev/null`, so the git that setup runs has hooks off too.
- **Its tools** are the ones on its `PATH`: under the service, the unit's, so dish's own Node and pnpm (`/opt/dish/node/bin`), with `/usr/local/bin/mise` but not mise's tools. A repo whose tools come from mise needs a setup that goes through it, such as `mise trust && mise exec -- pnpm install --frozen-lockfile`: stdin is closed, so mise can't ask to trust the repo's config, and the clone only exists once onboarding has started, so it can't be trusted beforehand. On the VM, fleet's mise config for the account trusts configs under `~/work` ([bketelsen/fleet#40](https://github.com/bketelsen/fleet/pull/40) and [bketelsen/fleet#41](https://github.com/bketelsen/fleet/pull/41), 2026-10-03), so the `mise trust` isn't needed there. Keep it for dev's clones, which that rule doesn't cover.
- **Its own process group,** sent TERM and then KILL after 5 seconds when `setupTimeout` passes, when the project is removed, or when dish stops.
- **A failure** fails the project, with up to the last 20 lines of its masked log in the message (at most 900 characters in all), which ends "Retry won't run setup again in this clone: remove the clone and press Retry, or run it yourself in <clone>".

## Credentials

- **The App's ID and private key** are two references in dsh's credential store, read with `ctx.get('credentials')?.resolve(ref)` for each request that needs the JWT, and never kept. The card sets them through dsh's own `credentials` remote, in the browser, so dish's server never receives them from the page.
- **The file token** has `contents: read` and `metadata: read`, for the repos of that owner's projects (one installation per owner). It is minted again 10 minutes before its hour runs out. A failed refresh is logged once per distinct error and tried again after a minute, and the old file stays until it expires.
- **dish's own API reads** (pull requests for the sweep, and `readPull`) use a second token, `metadata: read` and `pull_requests: read`, kept in memory only. Since step 7 it also asks for `checks: read` and `statuses: read`, for `readPull` (`API_PERMISSIONS`). An installation that hasn't accepted those two yet gets the narrower token instead (`API_BASE_PERMISSIONS`: today's two), logged once, so the sweep's reads keep working; each new mint asks for the wide set again. The bot's profile (`GET /users/<slug>[bot]`) is public and is read without a credential, once per App slug in the service's life (a changed credential asks only `GET /app` again), so an installation that hasn't accepted Pull requests read still onboards.
- **Write tokens** (step 7). `pushBranch` mints `contents: write`, and `openPull`, `updatePull` and `commentPull` mint `pull_requests: write`, each with `metadata: read`, for the one repository and the one call, in memory: never cached, and never in a file, an argument, the environment or a log. `createWriteToken` takes only those two sets (`PUSH_PERMISSIONS`, `PULL_PERMISSIONS`), and refuses a token GitHub granted more than asked, or for another repository. A 422 says what the App needs: "The dish App needs Contents (or Pull requests) read and write, and each installation must accept it (Settings → GitHub App)".
- **Agents' tokens are read-only, enforced.** `createToken` (the file token and the API token) still refuses anything but `read` before it sends a request, and refuses a token GitHub granted more than read.
- **No token on disk but its file.** Never in an argument, a URL, an environment variable, a config value or a log. Errors are masked with dish-kit's `maskSecrets`, and the card's texts also have the App ID and the key's lines taken out.

### The helper

`bin/git-credential-dish` is a POSIX `sh` script. Each clone's config runs it by its absolute path, through `/bin/sh`, so it needs no exec bit:

```
credential.https://github.com.helper = !/bin/sh '<checkout>/plugins/workspaces/bin/git-credential-dish' '<state>/workspaces/tokens' 'https://github.com'
```

It answers git's `get` for `https://github.com` only, with `username=x-access-token` and the first line of `<tokens dir>/<owner>` (the URL's first path segment, lower-cased), then `quit=true`. An owner that isn't a GitHub login, or one with no token file, gets `quit=true` alone, so git never prompts. Another origin gets nothing. `store` and `erase` are ignored, so git's own credential is never kept. It writes no file and reaches no network.

### The push helper

`bin/git-credential-dish-push` is the one-shot helper of dish's own push. No clone's config names it: only `pushBranch`'s git does, on its command line, after an empty `credential.helper=` that drops every other helper:

```
credential.helper = !/bin/sh '<checkout>/plugins/workspaces/bin/git-credential-dish-push' 'https://github.com'
```

POSIX `sh`, `set -u`, `LC_ALL=C`, shellcheck clean, run through `/bin/sh` by its absolute path. Its arguments are the web origin and git's action. On `get` for exactly that origin (`<protocol>://<host>`) it reads one line from fd 3, where dish wrote the write token, and answers `username=x-access-token`, `password=<the line>` and `quit=true`. Another origin, or nothing to read on fd 3 (closed, empty, or read already by an earlier `get`), gets `quit=true` alone. `store`, `erase` and anything else, or no origin, print nothing. It never echoes its input, writes no file, and runs no external command on the token (`printf` is the shell's builtin).

## dish's own git

Agents in a project's workspace can write anything in the clone, `.git` included. So every git command this plugin runs goes through `git()` (`src/git.ts`), and no other module starts git:
- **`SAFE_FLAGS`** on every call: `core.hooksPath=/dev/null`, `core.fsmonitor=false`, `fetch.recurseSubmodules=false`, `submodule.recurse=false`, `core.useReplaceRefs=false`, `safe.bareRepository=explicit`, `advice.graftFileDeprecated=false`, `credential.interactive=false` and `core.commitGraph=false`; and `GIT_GRAFT_FILE=/dev/null` in its environment. Hooks, fsmonitor, submodule recursion, replace refs, grafts and a forged commit-graph never change what dish's git does.
- **`GIT_CEILING_DIRECTORIES`** is the real parent of the directory git starts in (its working directory, then each `-C`), set after any caller's environment, so git never looks above it for a repository: a clone whose `.git/HEAD` was removed would otherwise send dish's git to the enclosing one (in dev, the dish checkout).
- **No nested repository is looked into.** `status`, `diff`, `diff-index` and `diff-files` are refused unless they pass `--ignore-submodules=dirty` (or `=all`): a repository an agent makes inside the clone has its own config, which the check never sees.
- **A scrubbed environment,** as setup's, its own process group, a time limit that kills the group, stdin closed, and output capped at 4 MB.
- **The check** (`checkClone`), before dish works in a clone: `.git` a directory, no `commondir` or `config.worktree`, each worktree's administrative files where git put them, and the local config only these keys: core basics and `core.hooksPath` (any value: dish overrides it), `remote.<name>.url`, `.fetch`, `.pushurl`, `.prune` and `.tagopt` (no `ext::` or `fd::` URL; `origin` exactly the project's, with dish's refspec), `submodule.<name>.url` and `.active`, `branch.<name>.remote`, `.merge`, `.rebase`, `.pushremote` and `.description`, `user.name` and `user.email`, the credential keys with dish's values, `extensions.objectformat` and `.refstorage`, `pull.rebase`, `pull.ff`, `push.default`, `push.autosetupremote`, `fetch.prune` and `init.defaultbranch`. Anything else (a filter, a driver, `include.path`, `core.sshCommand`, `extensions.worktreeConfig`) refuses the clone, naming the key, and the project shows it. Remove the key and press Retry. Once the config passes, git itself, with no system or global config, must find the repository at `<clone>/.git` (`git -C <clone> rev-parse --absolute-git-dir`), else the clone is refused.
- **Writing `.git/config`** never follows a link: dish edits a private copy under its state directory, takes git's own `config.lock`, writes beside the file and renames over it, after checking that `.git` and the file are still the ones it read. A crash leaves the old file whole.
- **Fetch** is `git fetch --prune origin +refs/heads/*:refs/remotes/origin/*`, the refspec on the command line, then `git remote set-head origin --auto`.

## Worktrees

### The `worktree` tool

For the main agent only: it refuses any other caller, and it is on crew's never-list. In a registered, ready project, from a chat whose workspace is that project's clone (a coder works in its chat's sandbox, which is that workspace):

| Action | Input | What it does |
|---|---|---|
| `create` | `project`, `slug`, optional `base` | Fetches, then makes `<clone>/.worktrees/<slug>` on a new branch `dish/<slug>` (`--quiet --no-track`), cut from `base` or `origin/<default branch>`, and records it. Answers the path, the branch, the base commit and setup: "Setup didn't run outside the sandbox: … Run it in <path> in the sandbox before the work starts (yourself, or tell the coder to run it first): <command>. If it fails with "Read-only file system", run it again escalated (`sandbox_permissions: "danger-full-access"`), so the judge allows it or asks the user; a coder can't escalate, and reports it instead." A slug is `[a-z0-9][a-z0-9-]*`, at most 40 characters, and not in use. A `worktree add` that fails or is stopped removes the branch it made (when no worktree has it) and the record, so the slug stays free; the error carries git's `fatal:` line. When dish keeps runs (dish-orchestrator), the worktree joins the run this chat drives, or opens one, and the answer ends with one of: "Opened run `<id>` for this worktree; `run` with `action: goal` names it, and `open_pr` ends it.", "It is task `<slug>` of run `<id>`, which this chat drives.", or "dish couldn't add it to a run: <why>." (the worktree stays either way). A new run that releases the run the chat drove in another project adds "Released run `<id>`; `run` `resume` takes it back." |
| `list` | optional `project` | Each worktree: ahead and behind the default branch, dirty or clean, merged or not, whether dish made it, and the crew children bound to it. |
| `remove` | `project`, `slug`, optional `force` | Removes a worktree dish made, its branch and its record. Without `force`, only a merged and clean one (it fetches first, and doesn't sweep). Never one a running coder is bound to, even with `force`. |

Crew's `delegate` takes the worktree as `worktree` (`<project>/<slug>` or the path), through `dishWorkspaces.resolve`. When that gives nothing for a worktree dish made, `resolveProblem` says why (its clone or its own check fails, or its branch is gone), and delegate's refusal names it: "worktree `<ref>` can't be bound: <project>'s clone (<clone>) failed dish's safety check: <finding>. Nothing was started or sent; tell the user." See [crew's README](../crew/README.md#binding-a-coder-to-a-worktree).

### The sweep

After the fetches of `create` and of `prepare` (at each start), and in the hourly round, each ready project's managed worktrees are looked at. `remove` without `force` fetches too, but doesn't sweep, and a removed project is neither fetched nor swept.
- **Merged** means GitHub lists a merged pull request whose head is the branch's tip (`GET /repos/{o}/{r}/commits/{tip}/pulls`), which covers squash merges, or the branch has commits of its own and its tip is an ancestor of the default branch as GitHub reports it (`git ls-remote --symref origin HEAD`, right after the fetch; the clone's own `origin/*` refs are never trusted). A worktree still at its base, such as a new one, is never merged, whatever GitHub says about that commit. A branch that gained commits after its pull request merged isn't either.
- **Removed:** a merged worktree that is clean, bound to no running coder, and not handed to a coder (resolved) in the last 5 minutes. `.worktrees` (a real directory) and the worktree's path (its own real path) are checked once more, else "worktree <slug> can't be removed: …; dish keeps it, its branch and its record"; then `git worktree remove` on its own path, never `--force` and never `git worktree prune`, then its branch, with a compare-and-delete (`git update-ref -d refs/heads/dish/<slug> <tip>`: only while it is still the tip that was found merged), and its record.
- **Kept,** with the reason: not merged; dirty (modified or untracked files, a gitlink, a nested repository, a worktree inside it; ignored files such as `node_modules` don't count); bound; resolved recently; a `.git` that isn't what git made; an error, such as its branch checked out in another worktree (the worktree, the branch and the record all stay).
- **Never looked at:** anything under `.worktrees/` without a record, such as a worktree you made by hand or a gate's cache.

A worktree whose directory and branch you removed by hand has its record dropped. A failure on one worktree is logged and the sweep goes on.

### The hourly round

First 5 minutes after start, then every hour: for each ready project, one at a time, under its lock, the read token, a fetch and the sweep. A round never overlaps the one before. A failure is logged once per project and error.

## Pushes and pull requests

Step 7's methods, for dish-orchestrator's `open_pr`, `run` and `pr_feedback`. Only `open_pr` calls `pushBranch`, `openPull`, `updatePull` and `commentPull`.

- **`pushBranch(project, slug, { head, signal? })`**, under the project's lock. The project must be registered and ready, the slug one dish made (`resolve` must answer for `<project>/<slug>`, else `resolveProblem`'s reason), and `head` a full commit id: the commit `open_pr` checked. It refuses, with nothing pushed and no token minted, unless `refs/heads/dish/<slug>` is at `head` ("dish/<slug> is at <tip>, not <head> (the commit the checks ran on); nothing was pushed"). Then it mints the write token and pushes, and logs "pushed dish/<slug> of <project> at <tip> (created | updated | up-to-date)". It gives `{ head }`.
  - **From an isolated repository.** A bare repository dish makes under `<state>/workspaces/<owner>/<repo>/push-<random>/` (0700, `git init --bare --template=`), whose objects come from the clone through `objects/info/alternates`, with `refs/heads/dish/<slug>` set to the tip. Every git of the push runs with no system or global config (`GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`), so nothing in the clone's config (which agents can write between the check and the push), or in yours, can steer it: `url.*.insteadOf`, `remote.*`, `http.*`, `credential.*`, `push.*`, the hooks.
  - **What it runs:** `git --git-dir <it> -c credential.helper= -c credential.helper=<the push helper> -c http.followRedirects=false push --porcelain <https URL> refs/heads/dish/<slug>:refs/heads/dish/<slug>`. To the project's HTTPS URL, never `origin`; one explicit refspec; never forced, never a delete. A redirect is a failure, not a second host asking for the credential. It may take 10 minutes.
  - **A refusal** reads "GitHub refused the push of dish/<slug>: " and GitHub's reason: the porcelain summary, the first five `remote:` lines, or git's last `fatal:` line, masked and cut to 600 characters. A branch that moved on GitHub (`fetch first`, `non-fast-forward`) adds: "The branch on GitHub has commits this one doesn't: have a coder merge `origin/dish/<slug>` into the run's worktree, then call `open_pr` again. dish never forces a push."
  - **The repository is removed** after success, failure or abort.
- **Why fd 3.** The token reaches git on its fd 3, a socket git and its children inherit (`git()`'s `secret`): dish writes the one line and closes its end, and the push helper reads it. Not the environment: an env-reading helper, `GIT_ASKPASS` or `http.extraHeader` through `GIT_CONFIG_COUNT` could be read by any process of the same account through `/proc/<pid>/environ`, for the whole push, and dsh's agents run as that account. A socket can't be opened again through `/proc/<pid>/fd/3`, and its line is gone once read, so a thief that reads it first leaves the push without it, which shows. Only `ptrace` reaches it, and that reads dsh's credential store anyway. The token is never on disk, in an argument, in the environment or in a log.
- **`openPull(project, { head, title, body })`**, no lock. `head` must be `dish/<slug>` of a worktree dish made. The base is the clone's default branch (`origin/HEAD`). The title is masked, folded to one line, and at most 256 characters; the body masked, without NUL, at most 65 536. All of that is checked before the token is minted. It gives `{ url, number, existing }`: when a pull request for the branch is open already (GitHub's 422), it reports that one with `existing: true`, and changes nothing of it.
- **`updatePull(project, number, { title?, body? })`**, no lock: only the fields given (at least one), checked and masked as `openPull`'s, with `PATCH /repos/{o}/{r}/pulls/{n}`.
- **`commentPull(project, number, body)`**, no lock: a comment on the pull request's issue (`POST /repos/{o}/{r}/issues/{n}/comments`), masked, not blank, at most 65 536 characters. `open_pr` posts its override lines there when the pull request was open already.
- **`readPull(project, number)`**, no lock, with the in-memory API token: the pull request's state, mergeability, head and base; its reviews (a `PENDING` one, its author's unsent draft, skipped), review comments (`outdated` when GitHub cleared their line; a comment on a whole file has none, and isn't), issue comments, and the checks on its head (check runs, and the combined status's statuses). The first page (100) of each, and `more` says which was full. **What it reads is untrusted:** anyone can write a review or a comment. Each item is read field by field with a type check (one that doesn't fit is skipped), and every string is masked (`maskSecrets`, URL passwords), its control characters made spaces (bodies keep `\n` and `\t`), and cut: bodies to 4000 characters, the rest to 200. Nothing of it is logged. The checks are the part it can do without: when the check runs or the combined status can't be read, `checksUnavailable` says why (an installation that hasn't accepted Checks and Commit statuses read, whose token gets a 403 or 404 there; or GitHub's failure, masked), `checks` holds what the other source gave, and the reviews and comments still come. A failure to read those rejects.
- **`headOf(pathOrRef)`** is the worktree's `HEAD` commit, or `undefined` for one dish didn't make; **`isClean(pathOrRef)`** is `{ clean: true }`, or `{ clean: false, why }` when anything is uncommitted or untracked, another branch (or a detached `HEAD`) is checked out, or it holds a nested worktree or repository. Neither locks.
- **`compareBranch(project, slug)`**, under the project's lock: a fetch (as the sweep's, recorded in `lastFetch`), then `{ behindDefault, aheadOfDefault, remoteAhead }`: the branch against `origin/<default>`, and the commits on GitHub's `dish/<slug>` the branch lacks (`null` when GitHub has no such branch). Read-only on the worktree. dish brings a branch up to date only by a coder's merge in its worktree (`origin/<default>`, and `origin/dish/<slug>` when GitHub's moved), never a rebase, an amend or a squash: it never force-pushes.

## The service

```ts
interface DishWorkspaces {
  onboard(project, options?): Promise<OnboardResult>        // steps 1 to 5; dish-projects drives it
  prepare(project): Promise<void>                           // for a ready project at start
  describe(name): CloneInfo | undefined                     // synchronous: clone, adopted, workspace, last fetch, worktrees
  createWorktree(project, slug, base?, options?): Promise<CreatedWorktree>   // its result's baseRef: origin/<default>, or the base given
  listWorktrees(project?): Promise<WorktreeInfo[]>
  removeWorktree(project, slug, force?): Promise<void>
  resolve(pathOrRef): Promise<Worktree | undefined>         // for delegate and dish-gates
  resolveProblem(pathOrRef): Promise<string | undefined>    // why resolve gave undefined: a worktree dish made whose clone or own check fails, or whose branch is gone
  sweep(project?): Promise<SweepResult>                     // empty for a project that isn't ready once locked
  appStatus(test): Promise<AppStatus>                       // for Settings → GitHub App
  headOf(pathOrRef): Promise<string | undefined>            // step 7: a worktree's HEAD
  isClean(pathOrRef): Promise<{ clean: true } | { clean: false, why: string }>
  compareBranch(project, slug): Promise<BranchComparison>   // fetches, then behindDefault, aheadOfDefault, remoteAhead
  pushBranch(project, slug, { head, signal? }): Promise<{ head }>
  openPull(project, { head, title, body }): Promise<{ url, number, existing }>
  updatePull(project, number, { title?, body? }): Promise<void>
  commentPull(project, number, body): Promise<void>
  readPull(project, number): Promise<PullFeedback>          // untrusted: masked and capped
}
```

Every operation on one project (onboarding, prepare, create, remove, a fetch, a sweep, a late workspace registration, `pushBranch` and `compareBranch`) runs under that project's lock; `resolve`, `listWorktrees`, `describe`, `headOf`, `isClean`, `openPull`, `updatePull`, `commentPull` and `readPull` don't lock. When the plugin goes, every timer is cleared, the work in flight is aborted and waited for (its processes killed), and the token files are removed.

**dish-orchestrator's hooks.** dish-workspaces reads `dishRuns` with `ctx.get` on each use, and works as before without it. The `worktree` tool calls `worktreeCreated(sessionId, { project, slug, branch, path, clone, base, baseRef })` after `createWorktree` returned, and `worktreeRemoved(project, slug)` after its remove; the sweep calls `worktreeRemoved` for each worktree it removed, one after the other, once its lock is released (in the background; `close` waits for it). None is called, or awaited, while a project's lock is held: `open_pr` holds a run's lock while `pushBranch` waits for the project's, so a hook awaited inside that lock would deadlock. dish-orchestrator's hooks call no locking method of dish-workspaces (`createWorktree`, `removeWorktree`, `pushBranch`, `compareBranch`, `sweep`, `prepare`, `onboard`). `createWorktree` itself calls no hook: `run open` makes its run's worktree through it and records it itself. A hook that throws is logged once, and the worktree, or its removal, stands.

## Settings → GitHub App

Between Projects and History in Settings' nav. Its intro says what the App needs since step 7: read and write access to Contents and Pull requests, and read access to Metadata, Checks and Commit statuses (no webhook); that each installation's owner accepts the new permissions on GitHub when the App was read-only before; and that each repository's default branch wants a ruleset (require a pull request with an approval, block force pushes and deletions, never the App on its bypass list).
- **The App ID** (digits, as GitHub shows it) and **the private key** (the whole `.pem`, line breaks and all), each with its own Save button (**Save App ID**, **Save private key**) and a Remove that asks first. Neither is ever shown again: the card says only whether each is set and where it comes from. A field is cleared the moment it is sent.
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
2. **The App can push since step 7** (Contents and Pull requests read and write; Metadata, Checks and Commit statuses read). Agents' git keeps read-only tokens. Only `pushBranch`, `openPull`, `updatePull` and `commentPull`, which `open_pr` calls, mint a write token, in memory, for one call. An agent can read dsh's credential file, so it could mint one itself: GitHub rulesets on each default branch (require a pull request with an approval, block force pushes and deletions, the App never on the bypass list) keep anything from reaching it without your merge (the orchestrator spec's question 1, A).

Known limits (the spec's [list](../../docs/specs/projects-workspaces.md#known-limits) has them all):
- **Check, then act.** The clone check and dish's next git command are two steps, as are the last checks and the rename of `.git/config`, and the last look at `.worktrees` and `git worktree remove`. An agent racing dish could slip a key past the check once, or swap `.git` or `.worktrees` for a link in between. Closing it means running dish's working-tree git inside the sandbox, which 6c didn't take on: [dish-gates](../gates/) runs the project's gate in the sandbox, and no git of its own.
- **Forged objects.** An agent can overwrite a stored object under its real hash. A fresh clone is free of that; it is why nothing else runs setup unsandboxed.
- **The judge can allow a worktree's install without you, when the sandboxed run fails.** Setup doesn't run outside the sandbox in a new worktree: it runs in the sandbox, which on the VM can write the home directory. Only if that fails with "Read-only file system" (a system install, or a dev machine where `DISH_SANDBOX_HOME` is off) does the main agent run it again escalated, and the judge, a model, may allow that without asking a human. The install scripts the coders wrote then run outside the sandbox. You decided this on 2026-10-02. Since [bketelsen/dish#10](https://github.com/bketelsen/dish/pull/10) the install runs in the sandbox first, and the escalated run is only the fallback.
- **A fresh clone under a workspace runs setup while the workspace's chats can write there:** the project's own kept workspace (a Retry after the clone was deleted by hand; remove, delete the clone, add again), or any workspace when there's no `clone.json` from before (one you registered by hand at the path of an old clone you moved aside). Accepted, so that setup isn't skipped.
- **A nested repository inside an ignored folder** (a clone under `node_modules/`) is an ignored file to git, so removing its worktree deletes it, history and edits included.
- **Linux only** for writing a clone's config: the location checks read `/proc/self/fd`. Elsewhere dish configures no clone.
- **After a crash:** a `.git/config.lock` stays for you to remove (the project's message names it). A temporary clone directory (`.<repo>.cloning-<hex>`) stays too, and no message names it: look for one beside the clone. Token files stay until the next start prunes and rewrites them.
- **Agents can read the token file.** It's read-only, lasts an hour and covers only the projects' repos.
- **A clone with an SSH alias origin** (`git@github-dish:…`, 6a's deploy-key days) isn't adopted. Move it aside.
- **A crash mid-push** leaves `<state>/workspaces/<owner>/<repo>/push-<random>/`, a small bare repository with no token in it, for you to remove.
- **A shallow clone** (an adopted one) may fail to push from the isolated repository, with git's message. dish's own clones are full.
- **A push doesn't follow redirects,** so pushing to a GitHub repository that was renamed or transferred fails ("The requested URL returned error: 301") while fetches still work: fix the project's repo name on Settings → Projects.
