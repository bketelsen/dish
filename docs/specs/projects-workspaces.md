# Spec: projects and workspaces (`dish-projects`, `dish-workspaces`)

Status: approved 2026-10-02; revised before the plan by its checks (what changed, and the evidence, is under [Checks](#checks-2026-10-02)). Two findings were then decided by you, both as recommended ([Decided after the checks](#decided-after-the-checks)). This is roadmap step 6b. It builds on [ops](ops.md) (step 6a: prod and dev, and the `~/work` root), the [config store](config-store.md), [crew](crew.md) and the [design](../design.md) ("Project families", "Plugins and contracts"). The plan is [docs/plans/2026-10-02-projects.md](../plans/2026-10-02-projects.md).

## Summary

You register repos as **projects**, and dish gets them ready to work on.
- **Onboarding.** For each project, dish clones the repo under `~/work/<owner>/<repo>`, or adopts a clone already there. Then it runs the project's `setup` and registers the clone as a **dsh workspace**, so it appears in the sidebar for chats.
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
| 10 | `setup` | Runs as `dish` outside dsh's sandbox, like a CI job (the command is yours, from the registry), with a timeout and saved output, but only on code a human merged ([below](#decided-after-the-checks)). |
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
  - keys that aren't `owner/name` (GitHub's grammar), or whose owner is `scratch` (reserved for the [scratch workspace](#the-scratch-workspace)), or two keys that differ only in case (GitHub's names don't);
  - a missing or blank `family`, `role`, `gate` or `gateTimeout`;
  - timeouts that aren't `<n>s`, `<n>m` or `<n>h` between 10s and 10m for the gate, or between 10s and 1h for setup. `setupTimeout` defaults to 15m;
  - a `gateEnv` that isn't a map of variable names to strings, or that names a variable starting with `DSH_` or looking like a secret (`KEY`, `TOKEN`, `SECRET` or `PASSWORD` in the name, as dsh's own scrub reads them). The values may use `<clone>` and `<worktree>`, which 6c expands;
  - unknown fields, and anything at the top level but `projects`.
- **Saving from the page** rewrites the file from its parsed form, so comments in `projects.yaml` don't survive a save there.
- **The gate's 10-minute cap:** dsh's shell service caps a run at 10 minutes. 6c checks whether dish can wait longer with its own deadline. Until then, a long build like snosi's image isn't a gate; use its lint or validate step.
- **Removing a project** stops dish managing it: no fetches, no sweeps, no gates. The clone and its dsh workspace stay; nothing on disk is ever deleted by removing a project.

## Onboarding (`dish-workspaces`, driven by `dish-projects`)

A project is onboarded when it appears in `projects.yaml`, at startup for each project not yet ready, and when you press Retry. The steps, each with a status the page shows:

1. **Find the installation:** `GET /repos/{owner}/{repo}/installation` with the App's JWT. A 404 means the App isn't installed there. The project fails with "install the dish App on {owner} and give it {repo}", or, with no App ID or key in the credential store, "set the GitHub App on Settings → GitHub App".
2. **Clone or adopt:**
   - If `<work root>/<owner>/<repo>` exists, is a clone of its own (`.git` a directory), its `origin` is that repo (`https://github.com/…`, `git@github.com:…` or `ssh://git@github.com/…`, case-insensitive, `.git` optional) and its `.git/config` passes the [safety check](#dishs-own-git-commands): adopt it, and switch `origin` to the HTTPS URL if it's SSH.
   - If the path exists but is something else (another origin, an SSH host alias, a worktree, a config key dish won't run git with): fail without touching it, and say what was found.
   - Otherwise: clone into a temporary directory beside it (`<work root>/<owner>/.<repo>.cloning-<random>`), with the token reaching git only through the credential helper, then rename it into place. A failed clone removes only that temporary directory.
3. **Configure the clone** (its own `.git/config`, nothing global):
   - the credential helper (below), and `credential.interactive=false`;
   - `user.name` and `user.email` set to the App's bot identity (`<app-slug>[bot]` and `<bot-id>+<app-slug>[bot]@users.noreply.github.com`);
   - `.worktrees/` added to `.git/info/exclude`.

   This step runs again at every start for each ready project, so the helper's path follows the checkout and a changed key is put back.
4. **Setup:** run `setup` in the clone, if there is one. It runs as `dish` with `setupTimeout`, outside dsh's sandbox, in the environment described under [Setup](#setup). The last 64 KB of its output is saved to `$XDG_STATE_HOME/dish/workspaces/<owner>/<repo>/setup.log`. A failed setup fails the project, and the page shows the tail. It runs only on code a human merged ([Decided after the checks](#decided-after-the-checks)).
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
- **Where:** the clone, or a new worktree, as its working directory. `bash -c <setup>`, with stdin closed.
- **When:** only on merged code ([Decided after the checks](#decided-after-the-checks), 1), and never in a tree with a nested repository or a submodule: edits inside one are invisible to dish's `status`, so its contents count as unmerged. Setup is then skipped with the command to run instead.
- **The environment:** dsh's own, with the scrub dsh gives every agent shell (no name containing `KEY`, `PASSWORD`, `SECRET` or `TOKEN`, and no `DSH_*` name), every `GIT_*` name removed, and `GIT_TERMINAL_PROMPT=0` added. Under the service that is the unit's `PATH` and the account's `HOME`; in dev it is `pnpm dev`'s environment, whose `DSH_*` names the scrub removes.
- **Its own process group,** killed (TERM, then KILL after 5 seconds) when `setupTimeout` passes, when the project is removed, or when dish stops.
- **The log:** its last 64 KB, with anything that looks like a credential masked (dish-kit's `maskSecrets`), in `setup.log` (onboarding) or `worktrees/<slug>.setup.log` (a worktree).

## dish's own git commands

Agents in a project's workspace can write anything inside the clone, `.git` included, so dish never lets a clone's own files choose what dish's git runs:
- every git command dish runs passes `-c core.hooksPath=/dev/null -c core.fsmonitor=false -c fetch.recurseSubmodules=false -c submodule.recurse=false`, with no `GIT_*` name inherited and `GIT_TERMINAL_PROMPT=0`. Its `status` and `diff` also pass `--ignore-submodules=dirty`: a nested repository an agent makes inside the clone has its own config, which the clone check never sees, and git would otherwise run its filters (`status`, `diff`) or its `uploadpack` (`fetch`, through an agent's `.gitmodules`). Setup treats a tree with a nested repository as unmerged ([Setup](#setup));
- before working in a clone, dish checks it: `.git` is a directory, its local config has only keys git never runs a program from (an allowlist: core basics, `remote.*` URLs and refspecs, `branch.*`, `user.*`, and the credential keys dish writes, with the values dish wrote), no `extensions.worktreeConfig`, and each worktree's administrative files point where git put them. A clone that fails is refused with the key or file named, and the page shows it; dish changes nothing in it;
- a token is never in an argument, a URL, an environment variable or a config value: git gets it from the credential helper, which reads the token file.

**A known limit:** the clone check and dish's next git command are two steps, and an agent can rewrite `.git/config` between them. The flags above can't be raced, but the allowlist can, so a determined agent racing dish could get a filter or driver run once by dish's git, outside the sandbox. It holds against mistakes and planted files, not against a race: the same footing as the App key (Decided after the checks, 2). Closing it means running dish's working-tree commands (`status`, `diff`, `worktree add`) inside dsh's sandbox, which 6c's sandboxed runner makes possible.

## Credentials

- **App key:** the App ID and private key are entered on a **GitHub App** card in Settings (`dish-workspaces`' client) and kept in dsh's credential store, never in the config store.
  - They are two references, `DISH_GITHUB_APP_ID` and `DISH_GITHUB_APP_PRIVATE_KEY` (names configurable on the `dish-workspaces` row). The card sets them through dsh's own `credentials` remote, as the Judge's key card does, so dish's server never receives them from the page. The PEM's line breaks survive (checked).
  - Dev and prod are apart because their dsh homes are: dev's go in `<checkout>/.dev/dsh/.credentials.yaml`.
  - The card shows the bot identity, the installations it can see, and a Test button.
  - The key is never shown again or logged, and dish-kit's secret guard masks it everywhere.
- **Read tokens:** an installation token with `permissions: { contents: read, metadata: read }`, for the repos of that installation's projects (one token for all of them; GitHub takes up to 500 names). It's refreshed 10 minutes before its hour runs out, and written to `$XDG_STATE_HOME/dish/workspaces/tokens/<owner>` (mode 0600; an installation belongs to one owner, and the helper sees only the owner in the URL). The files are removed when dish stops, and rewritten at the next start.
- **dish's own API reads** (pull request state for the sweep, the bot user) use a second installation token with `{ metadata: read, pull_requests: read }`, kept in memory only. The file token stays as narrow as above.
- **The credential helper:** each clone's helper is a small `sh` script shipped with `dish-workspaces`, configured in the clone as `credential.https://github.com.helper` (after an empty entry that drops any helper from your global config for that URL), with `useHttpPath=true` and two arguments: the token directory and `https://github.com`. The script's path and the token directory are absolute, and rewritten at every start. It answers git's `get` for `https://github.com` with `username=x-access-token` and the current read token for the URL's owner, says `quit=true` when it has none, and ignores `store` and `erase`. Agents' `fetch` and `pull` therefore work, and `push` fails (403).
- **Write tokens:** made in memory by the harness for its own pushes, in step 7. They never touch disk.
- **Exposure:** agents can read any file the `dish` account can, including the read-token file. That's accepted: it's read-only, lasts an hour, and covers only the projects' repos. They can also read dsh's credential file, which holds the App's private key, so the Apps are read-only in 6b ([Decided after the checks](#decided-after-the-checks)).

## Worktrees

### The `worktree` tool (main agent only, like the config tools)

It's a global tool, like the config tools: it refuses any caller that isn't a top-level agent, and crew never gives it to a child (it joins crew's never-list). No dsh 0.2.0-rc.2 tool is called `worktree`.

| Action | Input | What it does |
|---|---|---|
| `create` | `project`, `slug`, optional `base` | Refused unless the project is ready and the calling chat's workspace is that project's clone: crew's children work in the chat's sandbox, which is its workspace, so a coder of another chat couldn't write there. Fetches the clone. Makes `<clone>/.worktrees/<slug>` on a new branch `dish/<slug>` from `base`, which defaults to `origin/<default branch>`, and records it (its base commit included) in dish's state directory. Runs `setup` in it if its base is on `origin/<default>` ([Decided after the checks](#decided-after-the-checks)). Returns the absolute path, the branch, the base commit, and what setup did. Refuses a slug that's in use or isn't `[a-z0-9][a-z0-9-]*` (at most 40 characters). |
| `list` | optional `project` | Each worktree: path, branch, ahead and behind the default branch, dirty or clean, merged or not, whether dish made it, and the crew child bound to it, if any. |
| `remove` | `project`, `slug`, optional `force` | Removes a worktree dish made, and its local branch. Refuses one that's unmerged or dirty unless `force`. `force` is refused while a running coder is bound to it. Never touches a worktree dish didn't make. |

### `delegate` binding (crew)

- **The input:** `delegate` gains an optional `worktree` (`<project>/<slug>`, or the absolute path that `create` returned). Crew asks `dish-workspaces` to resolve it (`dishWorkspaces.resolve`, read with `ctx.get`). Refused before anything starts:
  - an unknown or removed worktree, one dish didn't make, or one of a project that's no longer registered;
  - one outside the calling chat's workspace (the sandbox reason above);
  - a role that doesn't write (`writes: false` in `crew.yaml`): binding is for coders, and 6c gates whoever is bound. A reviewer is given the path in its task;
  - one already bound to a running crew child;
  - no `dish-workspaces` running.
- **The record:** crew records it on the child (`ChildRecord.worktree`: the absolute path). 6c's gates read it from there. Crew can also list the children bound to a worktree, with whether each is running (`dishCrew.worktreeBindings(path)`), for `list`, `remove` and the sweep.
- **The brief:** crew adds a block to the coder's prompt, after the task and before the closing-message note: "Your worktree is `<path>` on branch `dish/<slug>`. Work only there: use absolute paths, and `git -C <path>` or `cd <path> &&` in commands. The main agent's own checkout is not yours to change." 6c adds its gate sentence to the same block.
- **Follow-ups** (`to`) keep the child's binding. A follow-up that names a different worktree is refused, and so is one to a child whose worktree has been removed.

### The sweep

- **When:** hourly, and after every fetch dish makes (`create`'s included). The hourly round fetches each ready project's clone first, one project at a time.
- **Which worktrees:** only those dish made (it has their record), on `dish/<slug>`. Anything else under `.worktrees/` (6c's `.worktrees/.cache`, a plan's ledger, a worktree you made by hand) is never touched.
- **Merged means:**
  - the pull request that holds the branch's tip is merged: `GET /repos/{o}/{r}/commits/{tip}/pulls` lists a pull request with `merged_at` set whose `head.sha` is the tip. This covers squash merges, which leave no ancestry, and a branch that gained commits after its pull request merged is not merged (those commits would be lost). A tip GitHub doesn't have isn't merged;
  - or the branch has commits of its own (its tip isn't the base commit `create` recorded) and its tip is an ancestor of `origin/<default>`. Without the first condition, a new worktree, whose tip is its base on `origin/<default>`, would count as merged and be swept (checked).
- **What it removes:** the worktrees whose branch is merged (`git worktree remove`, never `--force`), their local branches (`git branch -D`, since a squash-merged branch isn't merged in git's terms) and their records.
- **What it never removes:**
  - a dirty worktree: modified or untracked files, ignored ones (such as `node_modules`) aside. It's listed as "merged but dirty", and left for you or the main agent;
  - one bound to a running coder;
  - one resolved for a `delegate` in the last 5 minutes, so a coder about to start doesn't lose its worktree.

### The shipped skills (added by the checks)

`using-git-worktrees`, `subagent-driven-development` and `finishing-a-development-branch` tell agents to run `git worktree add` and `git worktree remove` themselves. A worktree made that way isn't dish's: `delegate` can't bind it, the sweep never removes it, and 6c won't gate it. So their shipped texts change to use the `worktree` tool and `delegate`'s `worktree` in a registered project, and keep the git commands for a repo that isn't one. Stored copies you haven't edited move to the new texts (`previous.json`, as in the skills step).

## Settings → Projects (`dish-projects`' client)

A settings section, built like Prompts and Skills: a framework-free controller, a Typert remote, and live updates from `dishConfig.watch`.
- **List:** each project with its family, role, onboarding status (pending, cloning, setup, ready, failed with message), last fetch, and its workspace.
- **Add and edit:** a form for the fields above, which writes `projects.yaml` as you, with the usual conflict check.
- **Remove:** asks to confirm, and says the clone and workspace stay.
- **Retry:** for any project that isn't queued or onboarding. On a ready one it onboards again: it adopts the clone, runs setup (on merged code), and registers the workspace, which brings back one you removed.
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
  listWorktrees(project?: string): Promise<Worktree[]>
  removeWorktree(project: string, slug: string, force?: boolean): Promise<void>
  resolve(pathOrRef: string): Promise<Worktree | undefined>   // for delegate and gates: a worktree dish made, of a registered project
  sweep(project?: string): Promise<SweepResult>
}
interface Worktree {
  project: string            // owner/name, as in projects.yaml
  slug: string
  branch: string             // dish/<slug>
  path: string               // <clone>/.worktrees/<slug>, absolute and canonical
  clone: string              // absolute and canonical
  base: string               // the commit it was cut from
  // list() adds: ahead, behind, dirty, merged, managed, bound
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
  - setup in the worktree;
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
   - **Decided:** run setup outside the sandbox only on code a human merged: a fresh clone; an adopted or retried clone whose checkout is clean and whose `HEAD` is on `origin/<default>`; a worktree whose base is on `origin/<default>`. Anywhere else the step is skipped, and the page or the tool's answer says so and gives the command, for the agent to run in its own sandbox. 6c builds a sandboxed runner (dsh's shell service, caches inside the clone) for the gate, and can take over this case.
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
- **The design doc** puts clones under `$XDG_DATA_HOME/dish/workspaces/`; decision 2 moved them to the work root. The plan updates `docs/design.md`.
