# dish-projects

The repos dish works on. You register each one as a **project** in `projects.yaml`, in the config store, and dish gets it ready to work on.
- **The registry.** `projects.yaml`, edited on **Settings → Projects**. Agents may only propose changes to it.
- **Onboarding.** Each project is cloned, configured, set up and registered as a dsh workspace, one project at a time, in the background. [`dish-workspaces`](../workspaces/) does the work; this plugin decides when, and keeps each project's status.
- **The service.** `dishProjects` gives the rest of dish the projects and their status. [dish-gates](../gates/) reads `gate`, `gateTimeout` and `gateEnv` from it, for a coder's gate and for `open_pr`'s check of a run's head.

The design is in the [spec](../../docs/specs/projects-workspaces.md) and the [plan](../../docs/plans/2026-10-02-projects.md). Its "Notes from the build" say what changed on the way.

## Install

```sh
pnpm --filter dish-projects build      # src/client → lib/client.js (the Projects page)
pnpm dsh plugin --profile web add ./plugins/projects
pnpm dsh plugin --profile web add ./plugins/workspaces
```

`deploy/install.sh` links both, after `config`.
- **`dish-config` is optional.** With the store, the plugin claims `projects.yaml` (agent policy `propose`) and seeds it empty, as `projects: {}`. Without it there are no projects.
- **`dish-workspaces` is needed to onboard.** Without it a project waits as pending, saying "dish-workspaces isn't running", and is onboarded when it appears. Neither plugin waits for the other at load.

## projects.yaml

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

| Field | | |
|---|---|---|
| the key | required | `owner/repo`, as GitHub spells it. The clone goes to `<work root>/<owner>/<repo>`. |
| `family` | required | Free text for now (step 8 gives families their own documents). |
| `role` | required | One line on what the repo is. |
| `gate` | required | The command [dish-gates](../gates/) runs in a bound coder's worktree when the coder finishes, and that `open_pr` runs on a run's head before it opens a pull request. |
| `gateTimeout` | required | `<n>s`, `<n>m` or `<n>h`, from 10s to 10m (dsh's shell caps a run at 10 minutes). |
| `setup` | optional | A command run once, in dish's own fresh clone, outside the sandbox (see [dish-workspaces](../workspaces/README.md#setup)). It gets dish's own Node and pnpm (the unit's `PATH`), so a repo whose tools come from mise needs it to go through mise, such as `mise trust && mise exec -- pnpm install --frozen-lockfile`. |
| `setupTimeout` | optional | From 10s to 1h; 15m when absent. |
| `gateEnv` | optional | Variables for the gate: names like `FOO_BAR`, never `DSH_*`, `HOME`, `LD_*` (they reach dish's sandbox runner, outside the sandbox) or a name with `KEY`, `TOKEN`, `SECRET` or `PASSWORD` in it. Values are one line, and may use `<clone>` and `<worktree>`, which dish-gates expands. A gate otherwise has the coder's own environment; where the sandbox can't write the home directory (dev without `DISH_SANDBOX_HOME=on`), point a cache into the clone here, such as `GOCACHE: <clone>/.worktrees/.cache/go-build`. |

The store refuses a document with any other field or top-level key, two keys that differ only in case, a blank required field, a multi-line one, or an owner of `scratch` or `tokens`. `scratch` is the scratch workspace's folder in the work root, and `tokens` would share its state directory with dish-workspaces' token files. A refusal names the project and the field, never the value.

Saving from the page writes the file again from its parsed form, so comments in `projects.yaml` don't survive a save there.

## Onboarding

A project's status is one of `pending`, `cloning`, `setup`, `ready` and `failed`. dish-workspaces' steps move it: installation, clone and configure are `cloning`; setup and workspace are `setup`.

- **When.** A project is onboarded when it appears in `projects.yaml`, at start if it isn't ready, when its fields change while it is failed or waiting, and when you press Retry. A ready project is only *prepared* at start: its clone configured and checked again, fetched, and its workspace registered if it has none.
- **One at a time,** in the order they were asked for, never blocking dsh's start. A project already queued isn't queued twice. A job aborted by a removal that hasn't stopped after 30 seconds is logged and left behind, and the queue goes on; dish-workspaces' per-project lock still guards its clone.
- **Removing a project** aborts its onboarding (its setup is killed) and forgets its status. Its clone and workspace stay: nothing on disk is ever deleted by removing a project.
- **A ready project whose fields change** is left ready. Its next fetch, worktree and gate read the new fields; setup doesn't run again.
- **dish-workspaces going away** is never a project's failure. An onboarding it abandons leaves the project pending, waiting for it, and a prepare leaves it ready. Both run again when it comes back.
- **Ready means ready across restarts.** Each status is kept in `<state>/projects/status.json`. A project that was cloning or in setup when dish stopped loads as pending and is onboarded again, which adopts its clone. A status file that doesn't parse is set aside as `status.json.corrupt-<ms>`, and every project is onboarded again.
- **Setup skipped** is recorded with the reason and the command to run. That's the case for any clone dish adopted, including on Retry, and for a fresh clone that a dsh workspace other than the project's own points at.
- **A failed setup isn't run again.** Retry, a restart and an edit of the project each onboard it again, which adopts the clone dish made, so setup is skipped and the project goes ready with the command to run. The failure's message says so: "Retry won't run setup again in this clone: remove the clone and press Retry, or run it yourself in <clone>". Remove the clone (dish never does) and press Retry for a fresh clone and setup, or run the command in the clone yourself.
- **A failure's message says what to do next.** Setting the GitHub App, installing it on the owner, giving it the repo, and a path dish won't adopt each end ", then press Retry on Settings → Projects". A ready project whose clone was deleted by hand fails at the next start, at configure: "the clone at <path> is gone; press Retry on Settings → Projects to clone it again". Retry clones it afresh, and setup runs.

Status messages are masked (dish-kit's `maskSecrets`) and cut to 1000 characters.

## Settings → Projects

Between Skills and the GitHub App card, in Settings' nav.
- **The list:** each project with its family, role and a status chip, "setup skipped" with its reason, the last fetch (and its error), and its workspace. A broken `projects.yaml` (a hand edit in the store's repository) shows its problem above the list, pointing at History. In a narrow window the list becomes a dropdown.
- **Add and edit:** the six text fields (`setup` is a text area, whose hint says it runs with dish's own Node and pnpm, and to go through mise for a mise repo: `mise trust && mise exec -- pnpm install --frozen-lockfile`, since setup's stdin is closed and the clone only exists once onboarding has started), rows for `gateEnv`, and a note for the commit. The form is checked 300 ms after you stop typing, with the same sentence the store would refuse it with. **Save** (Ctrl/Cmd+S) writes as you. If the file changed after you opened it, your edits stay, with **Reload** and **Keep mine**. The name is fixed once a project exists.
- **Remove** asks inline: "Remove <name> from projects.yaml? Its clone at <path> and its workspace stay; dish stops fetching, sweeping and gating it."
- **Retry** is offered on a ready or failed project, never one queued or onboarding. On a ready one it onboards again: it adopts the clone, skips setup with the command to run, and registers the workspace again, which brings back one you removed. On a failed one it adopts dish's clone too, so a failed setup isn't run again (above).
- **Proposals:** "N proposals for projects.yaml: review them on History". You accept them there.
- **Live:** while the page is shown and a project is pending, cloning or in setup, the list is read every 5 seconds. With dish-config's client loaded, it also follows the store's changes.

## The service

```ts
interface DishProjects {
  list(): Promise<Project[]>                      // projects.yaml at main, parsed and sorted; [] without a store or when it doesn't parse
  get(name: string): Promise<Project | undefined> // any case; what dish-gates reads: gate, gateTimeout, gateTimeoutMs, gateEnv
  status(name: string): ProjectStatus             // synchronous; pending at 0 when unknown
  retry(name: string): Promise<void>              // throws only while its onboarding is queued or running
  problem(): Promise<string | undefined>          // why the stored projects.yaml doesn't parse
}
```

It emits `dish-projects/changed(names)` (every name in the list before or after) and `dish-projects/status(name, status)`. dish-workspaces listens to both. The `Project` type, the format and its validation are exported from `dish-projects/registry`.

## The remote

The page's server half is `dishProjectsRemote` (wire namespace `dishProjects`), built like dish-skills' remote:
- `projects()`, `check(name, fields, adding)`, `save(name, fields, base, note, adding)`, `removeProject(name, base, note)` and `retry(name)`.
- **`removeProject`, not `remove`.** `remove` is one of dish-kit's `RESERVED_REMOTE_METHODS`: the browser's namespace service owns it, and a remote method with that name can't be mounted.
- Writes are made as you. A refusal is an `Outcome` with a code (`CONFLICT`, `INVALID`, `UNAVAILABLE` without a store, and the store's own codes), never a throw. `save` and `removeProject` read `projects.yaml` at the commit the page loaded, so a change made after it is a `CONFLICT`.

## Files

| Where | What |
|---|---|
| `projects.yaml` in the config store | The registry. |
| `<state>/projects/status.json` | Each project's onboarding status. `<state>` is dish's XDG state directory: `~/.local/state/dish` in prod, `<checkout>/.dev/state/dish` in dev. |

The clones, their state and the token files are dish-workspaces'.

## Configuration

| Row | Field | Default | |
|---|---|---|---|
| `dish-projects` | `terminal` | `true` | Print this plugin's messages to the terminal. |

## Known limits

- **Comments in `projects.yaml`** are lost when the page saves it.
- **A changed `setup`** doesn't run on a ready project: setup runs only in dish's own fresh clone. Run it yourself in the clone, or remove the clone (dish never does) and press Retry.
- **A failed setup isn't run again** by Retry, a restart or an edit, since each adopts dish's own clone and the project goes ready with setup skipped. Remove the clone and press Retry, or run the command yourself.
- **`gateTimeout` stops at 10 minutes,** dsh's cap on a shell run. dish could wait longer with a deadline of its own, and 6c chose not to: a turn stays running for as long as its gate does ([gates spec](../../docs/specs/gates.md), open item 1). A long build isn't a gate; use its lint or validate step.
- **An aborted onboarding that never stops** (a setup that ignores its signals and escapes its process group) is left behind after 30 seconds. The project's lock in dish-workspaces still keeps anything else out of its clone.
