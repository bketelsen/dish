# Spec: projects and workspaces (`dish-projects`, `dish-workspaces`)

Status: draft 2026-10-02, for review. This is roadmap step 6b. It builds on [ops](ops.md) (step 6a: prod and dev, and the `~/work` root), the [config store](config-store.md), [crew](crew.md) and the [design](../design.md) ("Project families", "Plugins and contracts").

## Summary

You register repos as **projects**, and dish gets them ready to work on.
- **Onboarding.** For each project, dish clones the repo under `~/work/<owner>/<repo>`, or adopts a clone already there. Then it runs the project's `setup` and registers the clone as a **dsh workspace**, so it appears in the sidebar for chats.
- **Worktrees.** Task worktrees live inside each clone, one branch each. The main agent makes them with a tool, and `delegate` binds a coder to one. They're removed automatically once their branch is merged.
- **GitHub access.** A GitHub App. Agents' git gets read-only tokens, and only the harness will push (step 7).
- **Configuration.** The registry lives in the config store, edited on **Settings → Projects**, and agents may propose changes to it.

## Decisions (from the 2026-10-02 discussion)

| # | Topic | Decision |
|---|---|---|
| 1 | Who creates workspaces | dish's onboarding, never fleet. You can still add other workspaces by hand. |
| 2 | Clone layout | `<work root>/<owner>/<repo>`. Prod's work root is `~/work`, dev's is `<checkout>/.dev/work` (6a's launcher sets `DISH_WORK_ROOT`). An existing clone at that path is adopted, not cloned again. |
| 3 | Worktrees | `<clone>/.worktrees/<slug>` on branch `dish/<slug>`. The `.worktrees/` folder is git-ignored through the clone's `.git/info/exclude`, so no repo change is needed. |
| 4 | Registry | `projects.yaml` in the config store. Edited on Settings → Projects, or by agent proposals you accept. |
| 5 | Project fields | `owner/name`, `family`, `role`, `gate`, `gateTimeout`, and optional `setup`, `setupTimeout` and `gateEnv` (see the [gates spec](gates.md)). |
| 6 | Who makes worktrees | The main agent, with the `worktree` tool. `delegate` takes a worktree and binds the coder to it (crew records the binding, for gates in 6c). |
| 7 | GitHub | A GitHub App with Contents read/write, Pull requests read/write and Metadata read, installed on `bketelsen` (selected repos) and `frostyard`. Dev uses a separate dish-dev App, installed only on test repos. |
| 8 | Where the App key lives | dsh's credential store, entered on a settings card (like the TypeSafe key). Dev has its own card and its own App. |
| 9 | Who can push | Only the harness (step 7). Agents' git gets read-only tokens. |
| 10 | `setup` | Runs as `dish` outside dsh's sandbox, like a CI job (the command is yours, from the registry), with a timeout and saved output. |
| 11 | Cleanup | Automatic: a sweep on every fetch and hourly removes worktrees whose branch is merged, along with their local branches. GitHub's "automatically delete head branches" setting handles the remote branch. |
| 12 | Plugins | Two: `dish-projects` (registry, page, onboarding) and `dish-workspaces` (clones, worktrees, credentials, the tool, the sweep). |
| 13 | Projects page | List with clone status; add, edit and remove; retry a failed clone. A per-project worktree view may come with step 7. |

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
  - keys that aren't `owner/name` (GitHub's grammar);
  - a missing or blank `family`, `role` or `gate`;
  - timeouts that aren't `<n>s`, `<n>m` or `<n>h` between 10s and 10m for the gate, or up to 1h for setup;
  - unknown fields.
- **The gate's 10-minute cap:** dsh's shell service caps a run at 10 minutes. 6c checks whether dish can wait longer with its own deadline. Until then, a long build like snosi's image isn't a gate; use its lint or validate step.
- **Removing a project** stops dish managing it: no fetches, no sweeps, no gates. The clone and its dsh workspace stay; nothing on disk is ever deleted by removing a project.

## Onboarding (`dish-workspaces`, driven by `dish-projects`)

A project is onboarded when it appears in `projects.yaml`, at startup for each project not yet ready, and when you press Retry. The steps, each with a status the page shows:

1. **Find the installation:** `GET /repos/{owner}/{repo}/installation` with the App's JWT. A 404 means the App isn't installed there. The project fails with "install the dish App on {owner} and give it {repo}".
2. **Clone or adopt:**
   - If `<work root>/<owner>/<repo>` exists and its `origin` is that repo: adopt it, and switch `origin` to the HTTPS URL if it's SSH.
   - If the path exists but is something else: fail without touching it.
   - Otherwise: `git clone https://github.com/<owner>/<repo>.git` with a read-only token.
3. **Configure the clone** (its own `.git/config`, nothing global):
   - the credential helper (below);
   - `user.name` and `user.email` set to the App's bot identity (`<app-slug>[bot]` and `<bot-id>+<app-slug>[bot]@users.noreply.github.com`);
   - `.worktrees/` added to `.git/info/exclude`.
4. **Setup:** run `setup` in the clone, if there is one. It runs as `dish` with `setupTimeout`, outside dsh's sandbox. The last 64 KB of its output is saved to `$XDG_STATE_HOME/dish/workspaces/<owner>/<repo>/setup.log`. A failed setup fails the project, and the page shows the tail.
5. **Register the workspace:** `ctx.workspaceRegistry.create(<clone path>, "<owner>/<repo>")`. This is idempotent: an existing record for the path is reused.

A project is **ready** once all five succeed. Onboarding runs one project at a time and never blocks dsh's start.

## Credentials

- **App key:** the App ID and private key are entered on a **GitHub App** card in Settings (`dish-workspaces`' client) and kept in dsh's credential store, never in the config store.
  - The card shows the bot identity, the installations it can see, and a Test button.
  - The key is never shown again or logged, and dish-kit's secret guard masks it everywhere.
- **Read tokens:** an installation token with `permissions: { contents: read, metadata: read }`, for the repos of that installation's projects. It's refreshed before its hour runs out, and written to `$XDG_STATE_HOME/dish/workspaces/tokens/<installation>` (mode 0600).
- **The credential helper:** each clone's helper is a small script shipped with `dish-workspaces`. It answers git's `get` for `github.com` with `username=x-access-token` and the current read token for that clone's owner, and nothing for other hosts. Agents' `fetch` and `pull` therefore work, and `push` fails.
- **Write tokens:** made in memory by the harness for its own pushes, in step 7. They never touch disk.
- **Exposure:** agents can read any file the `dish` account can, including the read-token file. That's accepted: it's read-only, lasts an hour, and covers only the projects' repos.

## Worktrees

### The `worktree` tool (main agent only, like the config tools)

| Action | Input | What it does |
|---|---|---|
| `create` | `project`, `slug`, optional `base` | Fetches the clone. Makes `<clone>/.worktrees/<slug>` on a new branch `dish/<slug>` from `base`, which defaults to `origin/<default branch>`. Runs `setup` in it. Returns the absolute path and the branch. Refuses a slug that's in use or isn't `[a-z0-9][a-z0-9-]*`. |
| `list` | optional `project` | Each worktree: path, branch, ahead and behind the default branch, dirty or clean, merged or not, and the crew child bound to it, if any. |
| `remove` | `project`, `slug`, optional `force` | Removes the worktree and its local branch. Refuses one that's unmerged or dirty unless `force`. `force` is refused while a running coder is bound to it. |

### `delegate` binding (crew)

- **The input:** `delegate` gains an optional `worktree` (`<project>/<slug>`, or the absolute path that `create` returned). Crew asks `dish-workspaces` to resolve it; an unknown or removed worktree is refused before anything starts.
- **The record:** crew records it on the child (`ChildRecord.worktree`: the absolute path). 6c's gates read it from there.
- **The brief:** crew appends a block to the coder's brief: "Your worktree is `<path>` on branch `dish/<slug>`. Work only there: use absolute paths, and `git -C <path>` or `cd <path> &&` in commands. The main agent's own checkout is not yours to change."
- **Follow-ups** (`to`) keep the child's binding.

### The sweep

- **When:** after every fetch of a clone, and hourly.
- **Merged means:**
  - the branch's PR is merged (`GET /repos/{o}/{r}/pulls?head={o}:dish/<slug>&state=closed`, `merged_at` set). This covers squash merges, which leave no ancestry;
  - or the branch is an ancestor of `origin/<default>`.
- **What it removes:** the worktrees whose branch is merged, along with their local branches.
- **What it never removes:**
  - a dirty worktree. It's listed as "merged but dirty", and left for you or the main agent;
  - one bound to a running coder.

## Settings → Projects (`dish-projects`' client)

A settings section, built like Prompts and Skills: a framework-free controller, a Typert remote, and live updates from `dishConfig.watch`.
- **List:** each project with its family, role, onboarding status (pending, cloning, setup, ready, failed with message), last fetch, and its workspace.
- **Add and edit:** a form for the fields above, which writes `projects.yaml` as you, with the usual conflict check.
- **Remove:** asks to confirm, and says the clone and workspace stay.
- **Retry:** for a failed project.
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
  onboard(project: Project, signal?: AbortSignal): Promise<OnboardResult>
  createWorktree(project: string, slug: string, base?: string): Promise<Worktree>
  listWorktrees(project?: string): Promise<Worktree[]>
  removeWorktree(project: string, slug: string, force?: boolean): Promise<void>
  resolve(pathOrRef: string): Promise<Worktree | undefined>   // for delegate and gates
  sweep(project?: string): Promise<SweepResult>
}
```

`dish-projects` needs `dishConfig`, which is optional. `dish-workspaces` needs nothing at load: it reads `workspaceRegistry`, `dishConfig` and `dishCrew` with `ctx.get`, when it uses them.

## Testing

`node --test`, with real git and no network.
- **Remotes:** local bare repos stand in for GitHub (`file://` URLs, mapped through a test hook in place of `https://github.com/...`).
- **GitHub's API:** a fake server, like the judge's fake Jev, for:
  - the installation lookup (found, and 404);
  - token creation, checking the requested permissions are read-only;
  - the bot user;
  - PR state.
- **Onboarding:**
  - clone, adopt, and an unrelated directory refused;
  - setup succeeding, failing, and timing out;
  - workspace registration with dsh's real workspace registry against a temp store;
  - each status, and Retry;
  - an App that isn't installed.
- **The credential helper:** it answers only for `github.com` with that owner's token; a clone's `fetch` works, and `push` is refused.
- **Worktree tool:**
  - the slug grammar;
  - create from the default branch and from a given base;
  - setup in the worktree;
  - list fields;
  - remove refusals (unmerged, dirty, bound to a running coder).
- **The sweep:** a squash-merged PR, an ancestry merge, dirty kept, bound kept, and local branch removal.
- **Crew:** `delegate` with a worktree (resolves, records, adds the brief block), an unknown worktree refused, and follow-ups keep the binding.
- **Registry validation and namespace policy**, plus the Settings → Projects controller and remote, as for Skills.
- **Dev isolation:** under the launcher, the work root is `<checkout>/.dev/work`.

**Live, by you:**
1. Create the dish-dev App on a test repo, onboard it in dev, and make and remove a worktree.
2. Create the dish App, onboard `bketelsen/dish` and one frostyard repo in prod, and open a chat in each workspace.

## Setting up the Apps (by you, on GitHub)

I'll give exact steps in the plan: create each App (no webhook yet), set the permissions above, install it on the owners and repos, and paste the App ID and the private key file's contents into the card.

## Open items

- **Several projects in one installation:** whether an installation token can be scoped to several repos at once (`repositories` in the token request), or needs one token per repo.
- **The bot user's id:** look it up once (`GET /users/<slug>[bot]`) and cache it.
- **The private key card:** `dish-judge`'s key card is the model. Confirm dsh's credential store takes a multi-line PEM.
- **The tool's name:** `worktree` might clash with a dsh tool name. Check, and rename if needed.
