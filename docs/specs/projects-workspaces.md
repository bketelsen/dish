# Spec: projects and workspaces (`dish-projects`, `dish-workspaces`)

Status: merged as [bketelsen/dish#7](https://github.com/bketelsen/dish/pull/7) and deployed to the VM on 2026-10-03 (the rollout is [below](#rollout-2026-10-03)). Approved 2026-10-02; revised before the plan by its checks (what changed, and the evidence, is under [Checks](#checks-2026-10-02)). Two findings were then decided by you, both as recommended ([Decided after the checks](#decided-after-the-checks)), and the build's reviews narrowed the first further. What the build changed is under [Notes from the build](#notes-from-the-build), and the [known limits](#known-limits) are gathered at the end. This is roadmap step 6b. It builds on [ops](ops.md) (step 6a: prod and dev, and the `~/work` root), the [config store](config-store.md), [crew](crew.md) and the [design](../design.md) ("Project families", "Plugins and contracts"). The plan is [docs/plans/2026-10-02-projects.md](../plans/2026-10-02-projects.md).

## Rollout (2026-10-03)

- **One App, for now.** The VM uses the dev App, `bketelsen-dish-dev`, read-only. The separate prod App of decision 7, `bketelsen-dish` in the plan's rollout, hasn't been made.
- **Your chat test passed,** on the project `bketelsen/clippy`: `git fetch`, `worktree` create and list, a bound coder committing as `bketelsen-dish-dev[bot]`, `remove` with `force`, and `git push` refused with 403.
- **Not reported yet:** the squash-merge sweep check, step 8 of the plan's [rollout](../plans/2026-10-02-projects.md#the-rollout-for-you).
- **Since the merge,** a worktree's setup runs in the sandbox ([bketelsen/dish#10](https://github.com/bketelsen/dish/pull/10)), as [Notes from the build](#notes-from-the-build) say.

## Summary

You register repos as **projects**, and dish gets them ready to work on.
- **Onboarding.** For each project, dish clones the repo under `~/work/<owner>/<repo>`, or adopts a clone already there. Then it runs the project's `setup` (in its own fresh clone only) and registers the clone as a **dsh workspace**, so it appears in the sidebar for chats.
- **A scratch workspace.** dish also registers `~/work/scratch` once, for general chats: dsh's web UI starts every chat in a workspace, and `~/work` itself shouldn't be one.
- **Worktrees.** Task worktrees live inside each clone, one branch each. The main agent makes them with a tool, and `delegate` binds a coder to one. They're removed automatically once their branch is merged.
- **GitHub access.** A GitHub App. Agents' git gets read-only tokens, and only the harness will push (step 7).
- **Configuration.** The registry lives in the config store, edited on **Settings → Projects**, and agents may propose changes to it.

## Decisions (from the 2026-10-02 discussion)

| # | Topic | Decision |
|---|---|---|
| 1 | Who creates workspaces | dish's onboarding, never fleet. You can still add other workspaces by hand. |
| 2 | Clone layout | `<work root>/<owner>/<repo>`. Prod's work root is `~/work`. When `DSH_DISH_HOME` is set (6a's dev), it's `$DSH_DISH_HOME/work`, which is `<checkout>/.dev/work`. dish-kit gains `workRoot()` for both. An existing clone at that path is adopted, not cloned again. |
| 3 | Worktrees | `<clone>/.worktrees/<slug>` on branch `dish/<slug>`. The `.worktrees/` folder is git-ignored through the clone's `.git/info/exclude`, so no repo change is needed. |
| 4 | Registry | `projects.yaml` in the config store. Edited on Settings → Projects, or by agent proposals you accept. |
| 5 | Project fields | `owner/name`, `family`, `role`, `gate`, `gateTimeout`, and optional `setup`, `setupTimeout` and `gateEnv` (see the [gates spec](gates.md)). |
| 6 | Who makes worktrees | The main agent, with the `worktree` tool. `delegate` takes a worktree and binds the coder to it (crew records the binding, for gates in 6c). |
| 7 | GitHub | A GitHub App, read-only in 6b (Contents, Pull requests and Metadata read; write comes in step 7, [below](#decided-after-the-checks)), installed on `bketelsen` (selected repos) and `frostyard`. Dev uses a separate dish-dev App, installed only on test repos. |
| 8 | Where the App key lives | dsh's credential store, entered on a settings card (like the TypeSafe key). Dev has its own card and its own App. |
| 9 | Who can push | Only the harness (step 7). Agents' git gets read-only tokens. |
| 10 | `setup` | Runs as `dish` outside dsh's sandbox, like a CI job (the command is yours, from the registry), with a timeout and saved output, but only on code a human merged, in dish's own fresh clone ([below](#decided-after-the-checks)). |
| 11 | Cleanup | Automatic: a sweep on every fetch and hourly removes worktrees whose branch is merged, along with their local branches. GitHub's "automatically delete head branches" setting handles the remote branch. |
| 12 | Plugins | Two: `dish-projects` (registry, page, onboarding) and `dish-workspaces` (clones, worktrees, credentials, the tool, the sweep). |
| 13 | Projects page | List with clone status; add, edit and remove; retry a failed clone. A per-project worktree view may come with step 7. |
| 14 | Scratch workspace | `dish-workspaces` registers `<work root>/scratch` once, titled "scratch", for general chats ([below](#the-scratch-workspace)). If you remove it, dish doesn't bring it back. |

## Non-goals

- Pushing branches and opening PRs (step 7, `orchestrator`).
- Gates (step 6c).
- Families as their own documents with direction and initiatives (step 8). `family` is free text here.
- Webhooks (step 9).
- Fencing a coder's writes to its worktree. Crew allows one writer at a time, and the brief names the worktree.

## The registry: `projects.yaml`

```yaml
projects:
  bketelsen/dish:
    family: bketelsen
    role: dish itself, dsh plugins for a personal agent harness
    gate: pnpm typecheck && pnpm test
    gateTimeout: 10m
    setup: pnpm install --frozen-lockfile
    setupTimeout: 15m
  frostyard/snosi:
    family: frostyard
    role: the image build
    gate: just lint
    gateTimeout: 10m
```

- **Namespace:** `projects.yaml` is claimed by `dish-projects` with agent policy `propose`, and seeded empty.
- **Validation** refuses (`INVALID`):
  - keys that aren't `owner/name` (GitHub's grammar), or whose owner is `scratch` (reserved for the [scratch workspace](#the-scratch-workspace)) or `tokens` (dish-workspaces' token directory, `<state>/workspaces/tokens/`, would collide with that owner's state), or two keys that differ only in case (GitHub's names don't);
  - a missing or blank `family`, `role`, `gate` or `gateTimeout`;
  - timeouts that aren't `<n>s`, `<n>m` or `<n>h` between 10s and 10m for the gate, or between 10s and 1h for setup. `setupTimeout` defaults to 15m;
  - a `gateEnv` that isn't a map of variable names to strings, or that names a variable starting with `DSH_` or looking like a secret (`KEY`, `TOKEN`, `SECRET` or `PASSWORD` in the name, as dsh's own scrub reads them). The values may use `<clone>` and `<worktree>`, which 6c expands;
  - unknown fields, and anything at the top level but `projects`.
- **Saving from the page** rewrites the file from its parsed form, so comments in `projects.yaml` don't survive a save there.
- **The gate's 10-minute cap:** dsh's shell service caps a run at 10 minutes. dish could wait longer with a deadline of its own, and 6c chose not to ([gates spec](gates.md), open item 1): a turn stays running for as long as its gate does. So a long build like snosi's image isn't a gate; use its lint or validate step.
- **Removing a project** stops dish managing it: no fetches, no sweeps, no gates. The clone and its dsh workspace stay; nothing on disk is ever deleted by removing a project.

## Onboarding (`dish-workspaces`, driven by `dish-projects`)

A project is onboarded when it appears in `projects.yaml`, at startup for each project not yet ready, and when you press Retry. The steps, each with a status the page shows:

1. **Find the installation:** `GET /repos/{owner}/{repo}/installation` with the App's JWT. A 404 means the App isn't installed there. The project fails with "install the dish App on {owner} and give it {repo}", or, with no App ID or key in the credential store, "set the GitHub App on Settings → GitHub App"; each ends ", then press Retry on Settings → Projects".
2. **Clone or adopt:**
   - If `<work root>/<owner>/<repo>` exists, is a clone of its own (`.git` a directory), its `origin` is that repo (`https://github.com/…`, `git@github.com:…` or `ssh://git@github.com/…`, case-insensitive, `.git` optional) and its `.git/config` passes the [safety check](#dishs-own-git-commands): adopt it, and switch `origin` to the HTTPS URL if it's SSH.
   - If the path exists but is something else (another origin, an SSH host alias, a worktree, a config key dish won't run git with): fail without touching it, and say what was found.
   - Otherwise: clone into a temporary directory beside it (`<work root>/<owner>/.<repo>.cloning-<random>`), with the token reaching git only through the credential helper, then rename it into place. A failed clone removes only that temporary directory.
3. **Configure the clone** (its own `.git/config`, nothing global):
   - the credential helper (below), and `credential.interactive=false`;
   - `user.name` and `user.email` set to the App's bot identity (`<app-slug>[bot]` and `<bot-id>+<app-slug>[bot]@users.noreply.github.com`);
   - `.worktrees/` added to `.git/info/exclude`.

   This step runs again at every start for each ready project (with a fetch, and the workspace if it has none), so the helper's path follows the checkout and a changed key is put back.
4. **Setup:** run `setup` in the clone, if there is one. It runs as `dish` with `setupTimeout`, outside dsh's sandbox, in the environment described under [Setup](#setup). The last 64 KB of its output is saved to `$XDG_STATE_HOME/dish/workspaces/<owner>/<repo>/setup.log`. A failed setup fails the project, and the page shows up to its last 20 lines (the message is at most 900 characters), ending "Retry won't run setup again in this clone: remove the clone and press Retry, or run it yourself in <clone>". It runs only in a clone dish has just made: an adopted clone (adopting, or Retry) skips it, and the page gives the command to run ([Decided after the checks](#decided-after-the-checks)). That includes dish's own clone after a failed setup: Retry, the next start and an edit of the project adopt it, so the setup isn't run again ([Known limits](#known-limits)).
5. **Register the workspace:** create it with `ctx.workspaceRegistry.create(<clone path>, "<owner>/<repo>")`. dsh reuses an existing record for the path and keeps its title. dish records that it registered the project's workspace, so one you remove stays removed until you press Retry. In a profile without a workspace registry (anything but `web`), the project is ready with no workspace, and is registered when a registry appears.

A project is **ready** once all five succeed, and dish records that in its state directory: a ready project isn't onboarded again at the next start, only configured (step 3) and fetched. Onboarding runs one project at a time and never blocks dsh's start.

## The scratch workspace

dsh's web UI has no chat without a workspace: every chat it creates names one, and with none selected the composer stays disabled (6a's [Notes from the build](ops.md#notes-from-the-build)). General chats need a workspace that isn't `~/work` itself, because a workspace's folder is where agents write without asking: dsh reads `~/work/.env` when the service starts, and every clone lives under `~/work`.

- **At startup,** once, `dish-workspaces` makes `<work root>/scratch` (`mkdir -p`) and registers it with `ctx.workspaceRegistry.create(<path>, "scratch")`. That's idempotent, so the workspace you added by hand after 6a is adopted. In dev, it's `<checkout>/.dev/work/scratch`.
- **Once only.** It records that it did so in `$XDG_STATE_HOME/dish/workspaces/scratch` and never registers it again, so a scratch workspace you remove stays removed, like dsh's own first-use default workspace. Deleting the record file brings it back at the next start.
- **The name is reserved.** `scratch` can't be a project owner: validation refuses it, since its clones would land in `<work root>/scratch/<repo>`.
- **Never fails the start.** An error is logged once, and the projects still onboard.
- **When.** Once dsh's workspace registry has started: it is a service with an asynchronous start, so dish waits for it with `ctx.inject(['workspaceRegistry'], …)` rather than reading it at load.

## Setup

`setup` is your command from the registry, run by dish (not by an agent) like a CI job:
- **Where:** dish's own fresh clone, at onboarding, as its working directory. `bash -c <setup>`, with stdin closed.
- **When:** only there ([Decided after the checks](#decided-after-the-checks), 1): a fresh clone is GitHub's default branch, merged by a human, with no ignored files yet. An adopted clone (adopting, or Retry) and a new worktree skip it, and the page or the tool's answer gives the command to run instead. So does a fresh clone that a dsh workspace dish didn't record for the project points at (in the `web` profile). That is a judgment, not a guard: dish takes the workspace it recorded in `clone.json`, which outlives the clone, to be your own project's, and only another one as a reason to stop. So a Retry after the clone was deleted by hand, or a project removed and added again, runs setup, and so does a case dish can't tell (no `clone.json` from before, or a registry that can't be asked), although that workspace's chats can write in the clone too ([Known limits](#known-limits)). A worktree's setup runs in the sandbox, in the worktree, before the work starts (the main agent, or a coder as its first step); only if that fails with "Read-only file system" does the main agent run it again escalated, which goes to the judge: it may allow it or ask you ([Decided after the checks](#decided-after-the-checks), 1).
- **The environment:** dsh's own, with the scrub dsh gives every agent shell (no name containing `KEY`, `PASSWORD`, `SECRET` or `TOKEN`, and no `DSH_*` name), every `GIT_*` name and `SSH_ASKPASS` removed, and `GIT_TERMINAL_PROMPT=0` added. dish's git settings ([below](#dishs-own-git-commands)) are added as `GIT_CONFIG_COUNT` pairs, which git ranks with `-c`, and `GIT_GRAFT_FILE=/dev/null`, so the git that setup runs has hooks off too. Under the service that is the unit's `PATH` and the account's `HOME`, so setup gets dish's own Node and pnpm: a repo whose tools come from mise needs a `setup` that goes through it, such as `mise trust && mise exec -- pnpm install --frozen-lockfile` (stdin is closed, so mise can't ask to trust the repo's config, and the clone only exists once onboarding has started). In dev it is `pnpm dev`'s environment, whose `DSH_*` names the scrub removes.
- **Its own process group,** killed (TERM, then KILL after 5 seconds) when `setupTimeout` passes, when the project is removed, or when dish stops.
- **The log:** its last 64 KB, with anything that looks like a credential masked (dish-kit's `maskSecrets`), in `setup.log`.

## dish's own git commands

Agents in a project's workspace can write anything inside the clone, `.git` included, so dish never lets a clone's own files choose what dish's git runs:
- every git command dish runs passes `-c core.hooksPath=/dev/null -c core.fsmonitor=false -c fetch.recurseSubmodules=false -c submodule.recurse=false -c core.useReplaceRefs=false -c safe.bareRepository=explicit -c advice.graftFileDeprecated=false -c credential.interactive=false -c core.commitGraph=false` (`SAFE_FLAGS`), with `GIT_GRAFT_FILE=/dev/null`, `GIT_CEILING_DIRECTORIES` set to the real parent of the directory git starts in (its working directory, then each `-C`), after any caller's environment, so git never works in a repository above it (a clone whose `.git/HEAD` was removed would otherwise send dish's git to the enclosing repository: in dev, the dish checkout), no other `GIT_*` name inherited, and `GIT_TERMINAL_PROMPT=0`: no hooks, no fsmonitor, no submodule recursion, and no replace refs, grafts or commit-graph file, which an agent could plant to change what a commit or an ancestry check says. Its `status` and `diff` also pass `--ignore-submodules=dirty`, and dish's `git()` refuses one that doesn't: a nested repository an agent makes inside the clone has its own config, which the clone check never sees, and git would otherwise run its filters (`status`, `diff`) or its `uploadpack` (`fetch`, through an agent's `.gitmodules`);
- before working in a clone, dish checks it: `.git` is a directory, its local config has only keys git never runs a program from (an allowlist: core basics and `core.hooksPath`, which dish's flags override, `remote.*` URLs and refspecs, `submodule.<name>.url` and `.active`, `branch.*` tracking keys, `user.name` and `user.email`, and the credential keys dish writes, with the values dish wrote), no `extensions.worktreeConfig`, each worktree's administrative files point where git put them, and git itself, with no system or global config, finds the repository at `<clone>/.git` (`git -C <clone> rev-parse --absolute-git-dir`). A clone that fails is refused with the key or file named, and the page shows it; dish changes nothing in it;
- dish writes a clone's `.git/config` without following a link: a private copy edited under dish's state directory, git's own `config.lock`, and a rename, after checking that `.git` and the file are still the ones it read;
- a token is never in an argument, a URL, an environment variable or a config value: git gets it from the credential helper, which reads the token file.

**A known limit** (with the others under [Known limits](#known-limits)): the clone check and dish's next git command are two steps, and an agent can rewrite `.git/config` between them. The flags above can't be raced, but the allowlist can, so a determined agent racing dish could get a filter or driver run once by dish's git, outside the sandbox. It holds against mistakes and planted files, not against a race: the same footing as the App key (Decided after the checks, 2) and forged objects (Decided after the checks, 1). Closing it means running dish's working-tree commands (`status`, `diff`, `worktree add`) inside dsh's sandbox. 6c doesn't: its gate runs the project's command in the sandbox, and dish-gates runs no git of its own ([gates spec](gates.md)), so dish's own git still runs outside the sandbox.

## Credentials

- **App key:** the App ID and private key are entered on a **GitHub App** card in Settings (`dish-workspaces`' client) and kept in dsh's credential store, never in the config store.
  - They are two references, `DISH_GITHUB_APP_ID` and `DISH_GITHUB_APP_PRIVATE_KEY` (names configurable on the `dish-workspaces` row). The card sets them through dsh's own `credentials` remote, as the Judge's key card does, so dish's server never receives them from the page. The PEM's line breaks survive (checked).
  - Dev and prod are apart because their dsh homes are: dev's go in `<checkout>/.dev/dsh/.credentials.yaml`.
  - The card shows the bot identity, the installations it can see, and a Test button.
  - The key is never shown again or logged, and dish-kit's secret guard masks it everywhere.
- **Read tokens:** an installation token with `permissions: { contents: read, metadata: read }`, for the repos of that installation's projects (one token for all of them; GitHub takes up to 500 names). It's refreshed 10 minutes before its hour runs out, and written to `$XDG_STATE_HOME/dish/workspaces/tokens/<owner>` (mode 0600; an installation belongs to one owner, and the helper sees only the owner in the URL). The files are removed when dish stops, and rewritten at the next start.
- **dish's own API reads** (pull request state for the sweep) use a second installation token with `{ metadata: read, pull_requests: read }`, kept in memory only. The file token stays as narrow as above. The bot user (`GET /users/<slug>[bot]`) is public, and is read without a credential, so an installation that hasn't accepted Pull requests read still onboards.
- **The credential helper:** each clone's helper is a small `sh` script shipped with `dish-workspaces`, configured in the clone as `credential.https://github.com.helper` (after an empty entry that drops any helper from your global config for that URL), with `useHttpPath=true` and two arguments: the token directory and `https://github.com`. The script's path and the token directory are absolute, and rewritten at every start. It answers git's `get` for `https://github.com` with `username=x-access-token` and the current read token for the URL's owner, says `quit=true` when it has none, and ignores `store` and `erase`. Agents' `fetch` and `pull` therefore work, and `push` fails (403).
- **Write tokens:** made in memory by the harness for its own pushes, in step 7. They never touch disk.
- **Exposure:** agents can read any file the `dish` account can, including the read-token file. That's accepted: it's read-only, lasts an hour, and covers only the projects' repos. They can also read dsh's credential file, which holds the App's private key, so the Apps are read-only in 6b ([Decided after the checks](#decided-after-the-checks)).

## Worktrees

### The `worktree` tool (main agent only, like the config tools)

It's a global tool, like the config tools: it refuses any caller that isn't a top-level agent, and crew never gives it to a child (it joins crew's never-list). No dsh 0.2.0-rc.2 tool is called `worktree`.

| Action | Input | What it does |
|---|---|---|
| `create` | `project`, `slug`, optional `base` | Refused unless the project is ready and the calling chat's workspace is that project's clone: crew's children work in the chat's sandbox, which is its workspace, so a coder of another chat couldn't write there. Fetches the clone. Makes `<clone>/.worktrees/<slug>` on a new branch `dish/<slug>` from `base`, which defaults to `origin/<default branch>`, and records it (its base commit included) in dish's state directory. Doesn't run `setup` outside the sandbox: the answer gives the command, and tells the main agent to run it in the worktree, in the sandbox, before the work starts (itself, or by telling the coder to run it first), and again escalated only if it fails with "Read-only file system" (a coder can't escalate, and reports it), so the judge allows it or asks you ([Decided after the checks](#decided-after-the-checks)). Returns the absolute path, the branch, the base commit, and the setup command. Refuses a slug that's in use or isn't `[a-z0-9][a-z0-9-]*` (at most 40 characters). |
| `list` | optional `project` | Each worktree: path, branch, ahead and behind the default branch, dirty or clean, merged or not, whether dish made it, and the crew child bound to it, if any. |
| `remove` | `project`, `slug`, optional `force` | Removes a worktree dish made, and its local branch. Refuses one that's unmerged or dirty unless `force`. `force` is refused while a running coder is bound to it. Never touches a worktree dish didn't make. |

### `delegate` binding (crew)

- **The input:** `delegate` gains an optional `worktree` (`<project>/<slug>`, or the absolute path that `create` returned). Crew asks `dish-workspaces` to resolve it (`dishWorkspaces.resolve`, read with `ctx.get`). Refused before anything starts:
  - an unknown or removed worktree, one dish didn't make, or one of a project that's no longer registered. A worktree dish made whose clone or own check fails, or whose branch is gone, is refused with the finding (`dishWorkspaces.resolveProblem`), such as "worktree `<ref>` can't be bound: <project>'s clone (<clone>) failed dish's safety check: <finding>. Nothing was started or sent; tell the user.";
  - one outside the calling chat's workspace (the sandbox reason above);
  - a role that doesn't write (`writes: false` in `crew.yaml`): binding is for coders, and 6c gates whoever is bound. A reviewer is given the path in its task;
  - one already bound to a running crew child;
  - no `dish-workspaces` running.
- **The record:** crew records it on the child (`ChildRecord.worktree`: the absolute path). 6c's gates read it from there. Crew can also list the children bound to a worktree, with whether each is running (`dishCrew.worktreeBindings(path)`), for `list`, `remove` and the sweep.
- **The brief:** crew adds a block to the coder's prompt, after the task and before the closing-message note: "Your worktree is `<path>` on branch `dish/<slug>`. Work only there: use absolute paths, and `git -C <path>` or `cd <path> &&` in commands. The main agent's own checkout is not yours to change." 6c adds its gate sentence to the same block.
- **Follow-ups** (`to`) keep the child's binding. A follow-up that names a different worktree is refused, and so is one to a child whose worktree has been removed.

### The sweep

- **When:** hourly, and after the fetches of `create` and of `prepare` (at each start). The hourly round fetches each ready project's clone first, one project at a time. `remove` without `force` fetches too, but doesn't sweep.
- **Which worktrees:** only those dish made (it has their record), on `dish/<slug>`. Anything else under `.worktrees/` (a cache a project's `gateEnv` puts there, a plan's ledger, a worktree you made by hand) is never touched.
- **Merged means:** a worktree still at its base (its tip is the base commit `create` recorded) is never merged, whatever GitHub says about that commit: a new worktree, whose tip is its base on `origin/<default>`, would otherwise count as merged and be swept (checked). Otherwise, either
  - the pull request that holds the branch's tip is merged: `GET /repos/{o}/{r}/commits/{tip}/pulls` lists a pull request with `merged_at` set whose `head.sha` is the tip. This covers squash merges, which leave no ancestry, and a branch that gained commits after its pull request merged is not merged (those commits would be lost). A tip GitHub doesn't have isn't merged;
  - or its tip is an ancestor of the default branch as GitHub reports it (`git ls-remote`, right after the fetch; the clone's own `origin/*` refs, which agents can write, are never read for it).
- **What it removes:** the worktrees whose branch is merged (`git worktree remove` on the worktree's own path, never `--force` and never `git worktree prune`), their local branches and their records. A branch is removed with a compare-and-delete, `git update-ref -d refs/heads/<branch> <tip>` (a squash-merged branch isn't merged in git's terms, so not `git branch -d`), only while it is still the tip found merged and checked out nowhere else. When another worktree has the branch checked out, the worktree, its branch and its record are all kept, as an `error`.
- **What it never removes:**
  - a dirty worktree: modified or untracked files, a gitlink, a nested repository or another worktree inside it, ignored files (such as `node_modules`) aside. It's listed as "merged but dirty", and left for you or the main agent;
  - one bound to a running coder;
  - one resolved for a `delegate` in the last 5 minutes, so a coder about to start doesn't lose its worktree.

### The shipped skills (added by the checks)

`using-git-worktrees`, `subagent-driven-development` and `finishing-a-development-branch` tell agents to run `git worktree add` and `git worktree remove` themselves. A worktree made that way isn't dish's: `delegate` can't bind it, the sweep never removes it, and 6c won't gate it. So their shipped texts change to use the `worktree` tool and `delegate`'s `worktree` in a registered project, and keep the git commands for a repo that isn't one. Stored copies you haven't edited move to the new texts (`previous.json`, as in the skills step).

## Settings → Projects (`dish-projects`' client)

A settings section, built like Prompts and Skills: a framework-free controller, a Typert remote, and live updates from `dishConfig.watch`.
- **List:** each project with its family, role, onboarding status (pending, cloning, setup, ready, failed with message), last fetch, and its workspace.
- **Add and edit:** a form for the fields above, which writes `projects.yaml` as you, with the usual conflict check.
- **Remove:** asks to confirm, and says the clone and workspace stay.
- **Retry:** for a ready or failed project (never one queued or onboarding). On a ready one it onboards again: it adopts the clone, configures it, and registers the workspace, which brings back one you removed. Setup is skipped there, with the command to run (an existing checkout). On a failed one whose clone dish made, it adopts that clone too, so a failed setup isn't run again: remove the clone first for a fresh one.
- **Proposals** for `projects.yaml` show a count, and are accepted on History, as with prompts.

## Services

```ts
// dish-projects
interface DishProjects {
  list(): Promise<Project[]>                 // projects.yaml now, parsed
  get(name: string): Promise<Project | undefined>
  status(name: string): ProjectStatus        // onboarding state
  retry(name: string): Promise<void>
}
// dish-workspaces
interface DishWorkspaces {
  onboard(project: Project, options?: { signal?: AbortSignal, progress?: (step: OnboardStep) => void }): Promise<OnboardResult>
  prepare(project: Project): Promise<void>                    // step 3 again, and the safety check, for a ready project at start
  describe(name: string): CloneInfo | undefined               // clone path, workspace, last fetch, for the page
  createWorktree(project: string, slug: string, base?: string, options?: { cwd?: string, signal?: AbortSignal }): Promise<CreatedWorktree>
  listWorktrees(project?: string): Promise<WorktreeInfo[]>   // Worktree plus ahead, behind, dirty, merged, managed, bound
  removeWorktree(project: string, slug: string, force?: boolean): Promise<void>
  resolve(pathOrRef: string): Promise<Worktree | undefined>   // for delegate and gates: a worktree dish made, of a registered project
  resolveProblem(pathOrRef: string): Promise<string | undefined>   // why resolve gave undefined, for delegate's refusal (added by the final review)
  sweep(project?: string): Promise<SweepResult>               // a project that isn't ready (once it has its lock) is neither fetched nor swept
  appStatus(test: boolean): Promise<AppStatus>                // for Settings → GitHub App (added by the plan's Task 13)
}
interface Worktree {
  project: string            // owner/name, as in projects.yaml
  slug: string
  branch: string             // dish/<slug>
  path: string               // <clone>/.worktrees/<slug>, absolute and canonical
  clone: string              // absolute and canonical
  base: string               // the commit it was cut from
}
```

`dish-projects` needs `dishConfig`, which is optional, and reads `dishWorkspaces` with `ctx.get`. `dish-workspaces` needs nothing at load: it reads `dishProjects`, `dishCrew` and `credentials` with `ctx.get` when it uses them, and waits for `workspaceRegistry` and `tools` with `ctx.inject`, since both start later and may never come (a profile other than `web` has no workspace registry). It never reads `dishConfig` itself.

**What 6c reads:** `dishCrew.records.lookup(child)` gives `record.worktree`; `dishWorkspaces.resolve(worktree)` gives the `Worktree` (with `project` and `clone`) or `undefined` for anything not gated; `dishProjects.get(project)` gives `gate`, `gateTimeout` and `gateEnv` as they are now.

## Testing

`node --test`, with real git and no network.
- **Remotes:** local bare repos stand in for GitHub (`file://` URLs, mapped through a test hook in place of `https://github.com/...`). git asks no credential helper for a `file://` URL, so the helper's tests use a fake smart-HTTP server instead: a local HTTP server running `git http-backend`, which takes a token as Basic auth and refuses `git-receive-pack` for a read token with 403, as GitHub does (checked: clone and fetch work through the helper, and push is refused).
- **GitHub's API:** a fake server, like the judge's fake Jev, for:
  - the App (`GET /app`) and its installations, with the JWT's RS256 signature checked against the test key;
  - the installation lookup (found, and 404);
  - token creation, checking the requested permissions are read-only;
  - the bot user;
  - pull request state by commit.
- **Onboarding:**
  - clone, adopt, and an unrelated directory refused;
  - setup succeeding, failing, and timing out;
  - workspace registration with dsh's real workspace registry against a temp store;
  - the scratch workspace: made and registered once, an existing one adopted, not brought back after you remove it, and `scratch` refused as an owner;
  - each status, and Retry;
  - an App that isn't installed.
- **The credential helper:** it answers only for `github.com` with that owner's token; a clone's `fetch` works, and `push` is refused.
- **Worktree tool:**
  - the slug grammar;
  - create from the default branch and from a given base;
  - setup skipped in a worktree, with the command;
  - list fields;
  - remove refusals (unmerged, dirty, bound to a running coder).
- **The sweep:** a squash-merged PR, an ancestry merge, a new worktree with no commits kept, a branch with commits after its PR merged kept, dirty kept, bound kept, a worktree dish didn't make kept, and local branch removal.
- **dish's own git:** a hook, an `fsmonitor` command and a filter planted in a clone never run when dish works in it, and a clone with a key outside the allowlist is refused with that key named.
- **Crew:** `delegate` with a worktree (resolves, records, adds the brief block), an unknown worktree refused, and follow-ups keep the binding.
- **Registry validation and namespace policy**, plus the Settings → Projects controller and remote, as for Skills.
- **Dev isolation:** with `DSH_DISH_HOME` set, the work root is `$DSH_DISH_HOME/work`, and nothing is cloned under `~/work`.

**Live, by you:**
1. Create the dish-dev App on a test repo, onboard it in dev, and make and remove a worktree.
2. Create the dish App, onboard `bketelsen/dish` and one frostyard repo in prod, and open a chat in each workspace.

## Setting up the Apps (by you, on GitHub)

I'll give exact steps in the plan: create each App (no webhook yet), set the permissions above, install it on the owners and repos, and paste the App ID and the private key file's contents into the card.

## Decided after the checks

Two findings of the checks changed what decisions 7, 9 and 10 promise. You decided both as recommended (2026-10-02): setup runs unsandboxed only on merged code (1), and both Apps are read-only in 6b (2).

1. **Setup can run code an agent wrote, outside the sandbox.** Decision 10 runs `setup` unsandboxed because the command is yours. What it runs is the repo's own code (`pnpm install` runs `package.json`'s lifecycle scripts), and that isn't always yours:
   - a worktree cut from a local branch (`base: dish/plan-x`, the pipeline's usual case) holds coders' unmerged commits;
   - Retry, or adopting a clone, runs it in a main checkout that agents in that workspace can change without asking.

   An agent that wanted out of the sandbox would only need to commit a `preinstall` script and ask for a worktree from its branch.
   - **Decided:** run setup outside the sandbox only on code a human merged, in a checkout dish has just made. This first named dish's own fresh clone and a new worktree whose base is on `origin/<default>`; the two bullets after Hardened narrowed it to the fresh clone alone. Anywhere else the step is skipped, and the page or the tool's answer says so and gives the command, for the agent to run in its own sandbox. 6c builds a sandboxed runner (dsh's shell service, caches inside the clone) for the gate, and can take over this case.
   - **Hardened (2026-10-02, your option A, after Task 3a's review).** "On `origin/<default>`" means on the sha GitHub reports (`git ls-remote`, right after a fetch), never a local ref, which an agent can write; dish's git also ignores replace refs and grafts and fetches with a fixed refspec. What's left is a forged object: an agent can overwrite a stored git object under its real hash, and git doesn't re-check it when checking out, so a determined agent could get its content into an unsandboxed setup. That's a known limit, on the same footing as the App key (2) and the config race ([dish's own git commands](#dishs-own-git-commands)). 6c's sandboxed runner removes it, by letting setup run inside the sandbox.
   - **Fresh checkouts only (Task 6's review).** An existing checkout can't be trusted even when it's clean and merged: an agent can hide files from `status` (`.git/info/exclude`, a `.gitignore` that ignores itself) or change ignored ones (`node_modules/.bin/*`, a `.pnpmfile.cjs`), and `pnpm install` would run them. So setup runs outside the sandbox only in a checkout dish has just made, which has no ignored files yet; adopting a clone and Retry skip it and give the command. dish's git also ignores commit-graph files, which an agent can forge to fake ancestry.
   - **Worktrees skip setup (Task 6's review; you chose A, 2026-10-02).** A worktree lives inside the clone, and tools read config from parent directories (`pnpm-workspace.yaml` with a `.pnpmfile.cjs`, npm workspaces, `node_modules` resolution, `.cargo/config.toml`, `go.work`), which agents can write: a planted pnpmfile ran under `pnpm install` in a new worktree. So only onboarding's fresh clone runs setup outside the sandbox. `worktree create` skips it and gives the command, and the main agent runs it in the worktree, escalated, before it delegates. The escalation goes to the judge, which may allow it (as it allows any main agent's escalation it judged with the escalation in view) or ask you: you decided on 2026-10-02 that the judge may allow it. So the judge or you are the gate for each worktree's install, and the branch's own install scripts run outside the sandbox when either allows it ([Known limits](#known-limits)). 6c's sandboxed runner (caches inside the clone) lets setup run sandboxed and removes both the approval and the exposure.
   - **Not chosen:** run every worktree's setup in dsh's sandbox now, confined to the clone, with its caches inside the clone like 6c's gate (a pnpm store per clone, and dsh's 10-minute cap).
2. **The App's private key is readable by agents.** dsh's credential file (`~/.dsh/.credentials.yaml`) belongs to the `dish` account, and dsh's sandbox mounts the whole filesystem read-only, so an agent's shell can read it, as it can the Copilot token and the TypeSafe key there today. With the key, an agent could mint a token with Contents write and push. Agents' git is read-only, and the key is never shown, logged or put in the config store, but "only the harness pushes" (decision 9) holds against mistakes, not against an agent set on it.
   - **Decided:** create both Apps with read permissions only for now (Contents read, Pull requests read, Metadata read). Nothing in 6b writes, so a key read by an agent can't push anything. Step 7, which brings the pushes, adds write (GitHub asks each installation to accept it, one click) together with a way to keep the key from agents, such as a token broker under another account. The code is the same either way: dish only ever asks for read tokens in 6b.
   - **Not chosen:** give the Apps write now, as decision 7 says, accept the exposure as it is accepted for the Copilot token, and protect each onboarded repo's default branch with a ruleset that requires a pull request, so a misused key can't change `main`.

## Checks (2026-10-02)

These replace the open items. Each was read from dsh 0.2.0-rc.2's code under `node_modules/.pnpm`, or run against scratch `HOME`, `DSH_HOME` and XDG directories, before the plan.

- **The workspace registry (`@deepseek-ai/dsh-workspace`).**
  - **Who has it:** only `dsh-web-app`'s composition mounts it (row `workspace`). Other profiles have no `ctx.workspaceRegistry`.
  - **When:** it's a cordis `Service` with `static inject = ['storageDomain', 'sessionPersistence']` and an asynchronous `[Service.init]` (it opens its domain and indexes session headers). Cordis's `ctx.get` returns a service only once its plugin is active, so a plugin waits with `ctx.inject(['workspaceRegistry'], …)`. dish-workspaces does that for the scratch workspace and for registering ready projects.
  - **The API:** `create(path, title?)` canonicalises with `realpath` and rejects a relative, missing or non-directory path; for a path it already has, it returns that record and leaves the title alone. `get(id)`, `list()`, `delete(id)` (the directory and sessions stay), `resolveByPath(path)`, and `Workspace.setTitle(title)` exist. A deleted registration leaves nothing behind: re-adding the path makes a new record. So "once only" has to be dish's own record, as the spec has it. dsh's README notes `create`'s `title` may be dropped one day; dish sets the title with `setTitle` on a record it just made if `create` didn't.
  - **Live:** the registry mounted in a test `Context` with `dsh-storage`, `dsh-storage-json`, `dsh-storage-domain`, `dsh-session` and `dsh-session-persistence-jsonl` over a temp directory: `create` twice gave one id and kept the first title; `delete` then `create` gave a new id; a missing path rejected with `ENOENT`; a relative one with "not fully qualified". The tests use the same composition.
  - **The sidebar** follows `domain/changed` (`dsh-api-workspace-controller`'s feed), so a workspace dish creates appears without a reload. With a workspace there, the web UI doesn't make dsh's own first-use default workspace (`initializeDefault` needs an empty registry).
- **The sandbox and worktrees.**
  - A session's sandbox root is its header's `cwd` (`dsh-sandbox-policy`: `resolveWorkspaceRoot(session?.header.cwd ?? …)`), and a crew child's session takes its parent's `cwd` (`dsh-subagent`). So a coder of a chat in `<clone>` may write anywhere in `<clone>`, `.git` included, and nowhere else but `/tmp`.
  - On Linux the profile is bubblewrap: `/` read-only, a fresh `/tmp`, the root bound read-write, the network open, nothing hidden from reading.
  - **Live,** with that exact profile rooted at a scratch clone: a commit in `<clone>/.worktrees/one` worked (the worktree's `.git` file points at `<clone>/.git/worktrees/one`, inside the root), a token file outside was readable, and writes outside were refused.
  - **Hence the `create` and `delegate` checks:** a worktree is useful only to a chat whose workspace is its clone.
- **dish's own git in a clone agents can write.** Live, in a scratch clone: a `post-checkout` hook in `.git/hooks` ran on `git worktree add`, and a `core.fsmonitor` command in `.git/config` ran on `git status`; `-c core.hooksPath=/dev/null` and `-c core.fsmonitor=false` stopped each. Filters, diff and merge drivers, `include.path` and similar keys run programs too and can't be turned off one by one, so dish checks the local config against an allowlist ([dish's own git commands](#dishs-own-git-commands)).
- **Tools.** dish's config tools are global tools that check `isTopLevelAgent` on every call and register through `ctx.inject(['tools'], …)`; `worktree` does the same. crew's `delegate` row defines its parameters in its `defineTool` call, so `worktree` is one more parameter there; the brief block goes between the task and `CLOSING_NOTE`, which must stay last (it refers to dsh's note after it). `ChildRecord` is parsed field by field (`parseChild` drops unknown fields), so `worktree` is added to its parser, its `NewChild` check and `addChild`. No dsh package defines a tool called `worktree`.
- **Setup's environment.** `dsh-subprocess`'s `scrubbedParentEnv` is the base of every agent shell: the process environment minus `/KEY|PASSWORD|SECRET|TOKEN/i` names and `DSH_*` names. dish-workspaces applies the same rule to its own children (with a test that pins it to dsh's exported `SENSITIVE_ENV_PATTERN` and `DSH_ENV_PREFIX`), and removes `GIT_*` names, which could point git at another repository or config.
- **Credentials.** dsh's local provider layers the inherited environment (read-only, wins), then `$DSH_HOME/.credentials.yaml`, then `.env` in dsh's working directory and in `$DSH_HOME`. The `credentials` remote's `set` takes any non-empty string. **Live:** a 2048-bit PKCS#1 PEM set through the provider was written as a YAML block scalar and read back byte for byte by a fresh provider, and `node:crypto` signed with it. Dev's `DSH_HOME` is `<checkout>/.dev/dsh`, so dev's key is in its own file; the dish-dev App is installed only on test repos, so a dev profile can't onboard a real repo even by mistake. An agent could put an App ID and key in `~/work/.env`, but that layer is read only when the store has none.
- **GitHub (REST docs, 2026-10-02).**
  - **The JWT:** RS256, `iat` 60 seconds in the past, `exp` at most 10 minutes ahead, `iss` the App ID (or client ID), sent as `Authorization: Bearer`. `node:crypto`'s `sign('sha256', …)` with the PEM is enough: no new dependency.
  - **The installation:** `GET /repos/{owner}/{repo}/installation` (JWT) gives `id` and `account`, or 404.
  - **Tokens:** `POST /app/installations/{id}/access_tokens` with `repositories` (names, up to 500) and `permissions` gives `token`, `expires_at` (an hour), `permissions` and `repositories`. One token covers several repos of one installation, which answers the open item; a name the installation lacks fails the whole request (422), so dish names only repos whose installation it found.
  - **The bot:** `GET /app` (JWT) gives the `slug`; `GET /users/<slug>%5Bbot%5D` gives the bot's `id`, for `<id>+<slug>[bot]@users.noreply.github.com`. Looked up once per start.
  - **Pull requests by commit:** `GET /repos/{owner}/{repo}/commits/{sha}/pulls` lists the merged pull request that brought a commit in, or, for a commit not on the default branch (a squash merge's head), the merged and open ones that hold it. It needs Pull requests read, so dish's API reads use their own in-memory token.
  - **git over HTTPS:** `x-access-token` as the user name and the token as the password.
- **The credential helper.** **Live,** with git 2.47: the helper configured as above answered `git credential fill` for an owner with a token file, said `quit=true` for one without, and was not asked for another host; with `credential.helper=store` in a scratch global config, `git credential approve` wrote no `~/.git-credentials` (the empty entry dropped it); against the fake smart-HTTP server, a clone with `git -c credential….helper=… clone` worked and left no helper or token in the new `.git/config`, a fetch worked, and a push with the read token got 403. `credential.interactive=false` (git 2.46 and later) keeps an agent's git from prompting, since dish can't set `GIT_TERMINAL_PROMPT` in agents' shells. The helper's path (`<checkout>/plugins/workspaces/bin/git-credential-dish`) stays put across `dish-update`, which moves commits and not paths, and is rewritten at every start anyway; dev's clones point at the dev checkout's helper and dev's token directory.
- **The config store.** As skills and prompts: `ctx.inject(['dishConfig'], …)`, the claim as an effect (`prefix: 'projects.yaml'`, `agent: 'propose'`), then `seed({ 'projects.yaml': 'projects: {}\n' }, 'dish-projects')`; `validate` returns a message, which the store turns into `INVALID`; `dish-config/changed` tells the plugin when the file changed; the page follows `dishConfig.watch`.
- **The work root.** dish-kit gains `workRoot()`: `$DSH_DISH_HOME/work` when that is set and absolute, else `<home>/work`. The unit's `WorkingDirectory` is `%h/work` and `update.sh` makes it (6a). `pnpm dev` sets `DSH_DISH_HOME=<checkout>/.dev`, so dev's clones are under `<checkout>/.dev/work`, which `.gitignore` covers.
- **Timers and load.** Nothing in either plugin's `apply` is awaited: the onboarding queue (one project at a time), the start-up preparation of ready projects, and the hourly round (fetch, then sweep, project by project) run in the background. Timers are `unref`'d and cleared by an effect when the plugin goes; a running setup is killed then too. Token refreshes are timers per owner, 10 minutes before expiry. A per-project lock keeps onboarding, fetches, `create`, `remove` and the sweep of one clone from overlapping.
- **What 6c needs.** `dishWorkspaces.resolve`, `ChildRecord.worktree`, `gateEnv` in the registry's validation, and the brief block as one function 6c extends. The interfaces under [Services](#services) match [gates.md](gates.md)'s reads.
- **The design doc** put clones under `$XDG_DATA_HOME/dish/workspaces/`; decision 2 moved them to the work root, and the plan's last task updated `docs/design.md`.

## Notes from the build

Built on branch `projects` on 2026-10-02, in the plan's waves (Tasks 0 to 15), each task reviewed, most with a fix round. The plan records each task's interfaces as built. What differs from the spec above, or what the build added, by area:

**dish's own git** (Tasks 3a and 3b, and their reviews)
- **`SAFE_FLAGS`** grew from the four settings the spec first named to nine, as [dish's own git commands](#dishs-own-git-commands) now lists: `core.useReplaceRefs=false` (a planted `refs/replace/<sha>` made `rev-parse` and `worktree add <sha>` resolve to an agent's tree), `safe.bareRepository=explicit`, `credential.interactive=false`, `core.commitGraph=false` (a forged commit-graph fakes ancestry), and `advice.graftFileDeprecated=false`, which keeps git's hint from pushing the real `fatal:` line out of an error. `GIT_GRAFT_FILE=/dev/null` goes in git's environment, since no `-c` key turns grafts off (a planted `.git/info/grafts` turned an ancestry check from false to true). `childEnvironment` drops `SSH_ASKPASS` too.
- **The submodule guard.** Task 3a's review found that a repository an agent makes inside the clone runs its own config's filters under `status` and `diff`, and its `uploadpack` under `fetch`. Besides the two submodule flags, `git()` refuses `status`, `diff`, `diff-index` and `diff-files` without `--ignore-submodules=dirty` (or `=all`).
- **The allowlist** gained `core.hooksPath` (any value: a husky-style `prepare` writes it into the clone, and dish's git and setup's override it) and `submodule.<name>.url` and `.active` (`git submodule update --init` writes them). With the expected URL, `remote.origin.fetch` must be exactly `+refs/heads/*:refs/remotes/origin/*`. A refusal masks a password in a URL, even in a key's name. A worktree's directory is checked with `lstat`, after `path.resolve`, so a link swapped in or a trailing slash can't pass.
- **Fetch** passes its refspec on the command line, so a refspec written into the config can't keep a hand-written `origin` ref alive, fetches `origin` by name only (never `--all`), and runs `git remote set-head origin --auto` every time, since an agent can repoint `origin/HEAD`.
- **The credential keys are written again before the check** at each configure, so a helper path from an older checkout passes after an update.
- **`GIT_CEILING_DIRECTORIES`** (the final review). git looks for a repository in the parent directories when the one it's given has none. With a clone's `.git/HEAD` removed, the clone check still passed and dish's git ran in the enclosing repository: in dev, the dish checkout, whose `.dev/work` holds the clones. `git()` now sets `GIT_CEILING_DIRECTORIES` to the real parent of the directory git starts in (its working directory, then each `-C`), after the caller's environment, so no caller can lift it. And `checkClone`, once the config passes, asks git where the repository is (`rev-parse --absolute-git-dir`, with no system or global config): it must be `<clone>/.git`, else the clone is refused ("git doesn't take .git as a repository", or "git finds the repository at …"), and the message reads "dish won't work in …".

**Setup** (Task 6's review, and two decisions of yours)
- **Option A (yours, 2026-10-02):** "on `origin/<default>`" means on the sha GitHub reports, from `git ls-remote --symref origin HEAD` right after a fetch, never a local ref. What's left, a forged object, is a known limit until 6c.
- **Fresh checkouts only.** The plan's `{ checkout }` mode (a clean main checkout on `origin/<default>`) was dropped: an existing checkout's ignored files can't be trusted. Adopting a clone and Retry skip setup and give the command.
- **Worktrees skip setup (yours, A, 2026-10-02).** A planted `.pnpmfile.cjs` in the clone ran under `pnpm install` in a new worktree, in the review's test. So only onboarding's fresh clone runs setup outside the sandbox. A worktree's setup was first to be run by the main agent escalated; since `sandbox-home` (2026-10-03, [the notes](#notes-from-the-build)) it runs in the sandbox, and is escalated only if that fails. The final review found that the judge's allow covers a main agent's escalation (the approval answerer's `escalationCovered`: the command gate allowed the call with the escalation in view), so an escalated run can go ahead without you; you decided on 2026-10-02 to keep it so ([Known limits](#known-limits)). The tool's answer now reads "Setup didn't run outside the sandbox: a worktree picks up config from the clone, which agents can change. Run it in <path> in the sandbox before the work starts (yourself, or tell the coder to run it first): <command>. If it fails with "Read-only file system", run it again escalated (`sandbox_permissions: "danger-full-access"`), so the judge allows it or asks the user; a coder can't escalate, and reports it instead.", and its description says the same in short.
- **`onMergedCode` is gone** (the final review). It had no caller in 6b: a fresh clone is GitHub's default branch by construction, and nothing else runs setup. It went with its helpers, setup.ts's test-only `internals`, and `githubDefault`'s `branch` option, which only it used; `githubDefault`, which the sweep uses, stays, and the forged commit-graph test moved to the sweep's tests. A sandboxed worktree setup, or 6c's runner, would need its own check.
- **A fresh clone under another workspace skips setup** (the final review). When dsh's workspace registry (`resolveByPath`, so the `web` profile only) has a workspace at the clone's path that isn't the one dish recorded for the project in `clone.json` before this onboarding (the record names another, or none), setup is skipped: "setup didn't run outside the sandbox: a dsh workspace already points at this path. Run it yourself in <clone>: <command>", and onboarding goes on to reuse that workspace. Which workspaces stop setup is a judgment, not a guard: the project's own workspace's chats can write at the path just as another's can, but dish takes the one it recorded to be your own project's. The record outlives the clone, so a Retry after the clone was deleted by hand, and a project removed and added again (its record kept), run setup. When dish can't tell (no `clone.json` from before, or a registry that can't be asked), setup runs too: the clone is fresh, and dish made it. That exposure was accepted so that setup isn't skipped ([Known limits](#known-limits)). A first version caught the project's own workspace as well; the docs' check found it, and the code round fixed it.
- **Setup's own git** gets `SAFE_FLAGS` as `GIT_CONFIG_COUNT` pairs and `GIT_GRAFT_FILE`: a hook planted in the clone's shared `.git/hooks` otherwise ran on a `git checkout` that setup made.
- **`sandbox-home` made the sandboxed run work on the VM (2026-10-03).** A worktree's setup was to be escalated because `pnpm install` and its kin write pnpm's store, mise, `~/go` and caches, which the sandbox couldn't, and a coder's escalation is refused. Since [sandbox-home](sandbox-home.md) the VM's sandbox writes the home directory, so `pnpm install --frozen-lockfile` and the like run in the worktree with no escalation and no prompt, by the main agent before it delegates or by the coder as its first step. The answer to `create`, the tool's description, the two worktree skills and these docs now say: run the command in the sandbox before the work starts, and escalate only if it still fails with "Read-only file system" (a system install, or a dev machine where `DISH_SANDBOX_HOME` is off); a coder can't escalate, so it reports the command and the main agent runs it escalated. The code is unchanged: a worktree still skips setup outside the sandbox (decision A).

**Clones and tokens** (Tasks 4 and 7a)
- **`.git/config` is written by lock and rename.** git's own `git config --file` writes through a link, which an agent can put in place of the file or of `.git`. So dish edits a private copy under its state directory (`git config --file <copy>`, from `/`), takes git's `config.lock` (an agent's `git config` then fails, and dish tries once more while an agent's holds it), writes the new file beside the old, never through a link and checked through `/proc/self/fd`, then checks that `.git` and the old file are the ones it read and unchanged, renames, and syncs the directory. A crash leaves the old file whole. A second change meanwhile, a link, or another hard link (only when dish has something to write) is refused. The exclude file and adopt's switch of `origin` are written the same way.
- **The owner directory** must be the work root's own: one that leads elsewhere through a link is refused before anything else.
- **The bot identity** is `GET /app`'s slug and the bot's id from the public `GET /users/<slug>[bot]`, asked without a credential (`botUser(slug, token?)`), so an installation that hasn't accepted Pull requests read still onboards. The bot's record is kept per slug for the service's life (GitHub allows 60 an hour per address without a credential; a bot's id never changes), and survives a credential change: then only `GET /app` is asked again, for the slug.
- **Tokens:** redirects are never followed; a 403 with `retry-after` counts as rate-limited; a token GitHub granted more than read is refused and not used; a token is minted again when an owner's repos change; the token directory is made 0700 by the token manager itself; `prune` at start skips owners it already holds; `close` removes the files.
- **The fake smart-HTTP server** answers 401 to any user but `x-access-token`, and the helper reads only the token file's first line.

**The registry and the scratch workspace** (Tasks 2 and 7b)
- **`tokens` is a reserved owner** besides `scratch`: `<state>/workspaces/tokens/<repo>` would collide with the token files.
- The text fields (`family`, `role`, `gate` and `setup`) are trimmed; `gateEnv`'s values aren't. NUL is refused in `gate`, `setup` and `gateEnv`'s values, which reach a process, and not in `family` or `role`. An empty `gateEnv` is left out when written.
- `registerWorkspace` returns dsh's canonical path, which dish records. The scratch workspace's log-once set belongs to the service, and goes with the plugin.

**Worktrees and the sweep** (Task 8)
- **Ancestry asks GitHub too:** the default branch's sha from `ls-remote`, once per sweep and once per `remove` without `force` (which fetches under the project's lock first). The clone's `origin/*` refs are never read for it. `isMerged` takes it as an `AncestryTarget`.
- **Removal** is `git worktree remove` on the worktree's own path, never `git worktree prune`, which would also drop the entries of worktrees you made by hand. A worktree holding another worktree is never removed, even with `force`. A branch is deleted only while it is still the tip found merged and no other worktree has it checked out (`update-ref -d` with the tip). A `create` that fails after `git worktree add` undoes it where git actually put it.
- **Dirty** includes a gitlink, a nested repository, or another worktree inside it.
- **Two guards from the final review.** `remove` and the sweep check again, right before `git worktree remove`, that `.worktrees` is still a real directory and the worktree's path is still its own real path, besides `checkWorktree`; otherwise "worktree <slug> can't be removed: …; dish keeps it, its branch and its record" (still check, then act: [Known limits](#known-limits)). A `create` whose `git worktree add -b` fails or is aborted removes the branch `dish/<slug>` git made for it (`update-ref -d` at the commit asked for) when no worktree has it, and its record, so the slug isn't refused for good. The add runs `--quiet`, so the error carries git's `fatal:` line.
- **The rollout's squash-merge check** couldn't pass as the plan first wrote it (the final review): a worktree cut from the pull request's own branch is at its base, so it is never merged. The check now makes the worktree with no `base` and fast-forwards it to the branch.

**The services** (Tasks 9 and 10)
- **`prepare` stays ready without a bot identity.** When GitHub can't give it at start, the clone keeps the identity it has, and the rest of step 3 is done.
- **`registerIfMissing`:** a workspace registry that appears between onboarding's last step and dish-projects recording the project ready is caught on `dish-projects/status`. That late registration, and `prepare`'s, check inside the project's lock that the project is still ready. Onboarding's own step 5 checks only its signal, which removing the project aborts. Either way a removed project never gets a workspace.
- `prepare` also fetches, then sweeps in the background. `close()` rejects work in flight with an `AbortError`, which dish-projects records as pending, never failed.
- **A removed project is no longer fetched or swept** (the final review). The sweep `prepare` queues, and the hourly round, which lists the projects once at its start, each ran for a project removed meanwhile. Now fetch-and-sweep does nothing for a project that isn't ready once it holds the project's lock (the hourly round, the sweep after `create` or `prepare`, and `sweep()`, which then returns an empty result), and `prepare` doesn't fetch one that is no longer ready after configuring it.
- **The messages say what to do next** (the final review). Setting the App, installing it on the owner, the App that can't read the repo, and a path dish can't adopt and leaves as it is each end ", then press Retry on Settings → Projects". A ready project whose clone was deleted by hand fails at the next start, at configure: "the clone at <path> is gone; press Retry on Settings → Projects to clone it again". Retry then makes a fresh clone, and setup runs. A failed setup's message keeps up to its last 20 lines, is at most 900 characters, and ends "Retry won't run setup again in this clone: remove the clone and press Retry, or run it yourself in <clone>".
- **Onboarding's queue:** a job aborted by a removal that hasn't settled after 30 seconds is logged and left behind; dish-workspaces going away leaves an onboarding pending and a prepare ready; Retry on a ready project onboards it again.
- **A race the last task found.** A flaky test hid it: a job that found no dish-workspaces was still the running job while it saved "pending", and if dish-workspaces appeared then, the onboarding asked for was dropped as a duplicate, leaving the project pending until the next start. A job whose end is decided no longer counts as one.

**The pages** (Tasks 11 to 13)
- **`removeProject`, not `remove`.** `remove` is one of dish-kit's reserved remote method names: the browser's namespace service owns it, and the gateway can't mount a method with it.
- **`hide`, not `close`.** The Projects controller's face calls it `hide`: the settings shell gives every section a `close` prop of its own (it closes Settings), and the shell's props win.
- Settings → Projects polls only while it is shown, asks about a removal inline, and edits `setup` in a text area. The GitHub App's status leaves out the App's numeric ID, so no answer holds either credential, and its texts have the ID and the key's lines taken out as well as masked.

**Crew** (Task 5): crew records the worktree's canonical (`realpath`'d) path, `worktreeBindings` canonicalises its argument, and a follow-up to a bound child is refused while another running child is bound to its worktree. crew's never-list has `worktree` ([crew spec](crew.md)). After the final review, a refusal for a worktree dish made that fails a check names it (`resolveProblem`): "worktree `<ref>` can't be bound: <project>'s clone (<clone>) failed dish's safety check: <finding>. Nothing was started or sent; tell the user." A follow-up to a child whose worktree fails one says so the same way.

## Known limits

Gathered from the sections above and the modules' own notes.
- **Check, then act.** The clone check and dish's next git command are two steps, as are the last checks and the rename of `.git/config`: an agent racing dish could get a filter or driver run once by dish's git, outside the sandbox, or swap `.git` for a link in between. It holds against mistakes and planted files, not a race. Closing it means running dish's working-tree git inside the sandbox, which 6c didn't take on: dish-gates runs no git of its own.
- **Forged objects.** An agent can overwrite a stored git object under its real hash, and git doesn't re-check it on checkout. Only dish's fresh clone runs setup unsandboxed, and that has no objects an agent wrote.
- **The App's key is readable by agents,** in dsh's credential file. Hence read-only Apps in 6b ([Decided after the checks](#decided-after-the-checks), 2); step 7 adds write with a way to keep the key from agents.
- **The read-token file is readable by agents.** It's read-only, lasts an hour, and covers only the projects' repos.
- **The judge can allow a worktree's install without you, when the sandboxed run fails.** Setup is skipped outside the sandbox in a worktree and runs inside it, which on the VM can write the home directory. Only if that fails with "Read-only file system" (a system install, or a dev machine where `DISH_SANDBOX_HOME` is off) does the main agent run it again escalated. The judge, a model, may allow that escalation without asking a human, and the setup then runs install scripts the coders wrote, outside the sandbox. You decided this on 2026-10-02 ([Decided after the checks](#decided-after-the-checks), 1). Since [bketelsen/dish#10](https://github.com/bketelsen/dish/pull/10) the install runs in the sandbox first, and the escalated run is only the fallback.
- **A fresh clone under a workspace runs setup while the workspace's chats can write there.** dish makes a fresh clone at a path a dsh workspace points at, and runs setup outside the sandbox, when the workspace is the project's own (a Retry after the clone was deleted by hand; or remove the project, delete the clone, and add it again) and whenever there is no `clone.json` from before (a workspace you registered by hand at the path of an old clone you moved aside, say). A chat in that workspace could write in the clone while setup runs. Accepted in the final review (2026-10-02), a usability call, so that setup isn't skipped; only a workspace dish didn't record for the project skips it.
- **A failed setup isn't run again** by Retry, a restart or an edit of the project (a corrected `setup` included): each onboards the project again and adopts the clone dish made, so setup is skipped and the project goes ready with the command to run. Remove the clone (dish never does) and press Retry for a fresh clone and setup, or run the command in the clone yourself.
- **Setup's git protections reach the git binary only,** and only through its environment: a tool that builds its own environment or passes its own `-c` or `GIT_CONFIG_COUNT`, a tool that uses libgit2, and config outside `SAFE_FLAGS` in the shared `.git/config` (read for the whole run, vouched for only when the check ran) aren't covered. `safe.bareRepository=explicit` breaks a tool that runs git in a bare repository by its working directory.
- **Setup's group kill** misses a process that calls `setsid` or daemonizes. An onboarding that still hasn't stopped 30 seconds after a removal is left behind; the project's lock keeps anything else out of its clone.
- **A nested repository inside an ignored folder** (a clone under `node_modules/`) is an ignored file to git, so removing its worktree, by the sweep or `remove`, deletes it with its history and edits.
- **The sweep's checks and its removal are two steps.** An agent writing in the worktree between them can lose what it writes, except what `git worktree remove`'s own clean check catches.
- **`remove` and the sweep check `.worktrees` and the worktree's path** right before `git worktree remove`, but that too is check, then act: a link swapped in after the check still reaches git.
- **`.worktrees` swapped for a link** between `create`'s check and `git worktree add` makes git put the worktree where the link points. `create` sees it afterwards, removes what git made there, and refuses.
- **A coder is kept to its worktree by its brief,** not by the sandbox: it can write anywhere in the chat's workspace (crew's non-goal).
- **After a crash:** a `.git/config.lock` stays for you to remove (the project's message names it, and says to remove it if no git is running in the clone). A temporary clone directory (`.<repo>.cloning-<hex>`) stays too, and no message names it: the next clone uses a new name, so look for one beside the clone and remove it. The token files stay until the next start prunes and rewrites them.
- **Dev's work root is inside the dish checkout** (`<checkout>/.dev/work`), so a dev project's tools see the checkout's files above the clone: `pnpm install` in a repo without its own `pnpm-workspace.yaml` installs the dish checkout instead ([deploy/README.md](../../deploy/README.md#prod-and-dev)). dish's own git stops at the clone.
- **Linux only** for writing a clone's config: the location checks read `/proc/self/fd`, and elsewhere dish configures no clone.
- **GitHub's commit-to-pull-request listing** is relied on for squash merges. It is documented, and the rollout's checks include a squash merge.
- **The gate's 10-minute cap** is dsh's cap on a shell run. 6c keeps it ([gates spec](gates.md), open item 1).
- **Comments in `projects.yaml`** don't survive a save from the page.
- **A clone with an SSH alias origin** (`git@github-dish:…`, from 6a's deploy keys) isn't adopted: onboarding names it, and you move it aside.
- **`registerWorkspace`'s `created`** may be said by both of two calls made at once for one new path (one record, one id). dish makes its registrations one at a time.
