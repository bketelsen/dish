# Handoff

Where dish stands, how to run it, and what's next. Updated 2026-10-05. The plan of record is [ROADMAP.md](ROADMAP.md). The design is [docs/design.md](docs/design.md), and each step has its spec under [docs/specs/](docs/specs/).

## What dish is

dish is a set of plugins for dsh (DeepSeek Harness, `@deepseek-ai/dsh` 0.2.0-rc.2) that make it a personal agent harness:
- **The setup:** Copilot models, prompts and skills in a git-backed config store, a crew of role agents with a cross-family reviewer, and a command judge (Jev on TypeSafe).
- **The work:** GitHub projects with task worktrees, and a sandbox that lets agents work.
- **The pipeline:** runs with a harness-written ledger, structured reports, and `open_pr`.

It runs as `dsh web` on a Debian VM.

- **This repo:** `bketelsen/dish`, checked out on the desktop at `~/projects/dish` and on the VM at `~dish/dish`.
- **Fleet:** `bketelsen/fleet` (`~/projects/fleet`) is live infrastructure. It defines the Incus instance `dish` (project `dish` on the `minideb` remote), the account, and its tools: Node, pnpm, mise and the pinned toolchains.
- **The VM:**
  - `dsh web` runs as `dish-web.service`, a user unit of the `dish` account.
  - It's served at `https://dish.<tailnet>.ts.net`.
  - The prod profile is `~dish/.dsh/profiles/web`. Work lives in `~dish/work` (clones, worktrees, and the `scratch` workspace).
- **The config store:** `~/.config/dish/config.git`. The VM pushes it to `bketelsen/dish-config`, and the desktop's store has no remote. Never give the desktop one while the VM runs, and never put a secret in it.

## State on 2026-10-05

Everything below is merged and running on the VM.

| Piece | Where | Notes |
|---|---|---|
| Copilot, config store, prompts, skills, crew, judge, web settings | steps up to 6a | |
| `ops` (6a): prod and dev, `dish-update`, `dish-url` | `df9c4b1`; fleet #38 and #39 | |
| friction fixes and one-approval | `8545e8d`, `8a1ff3d` | |
| `projects` + `workspaces` (6b) | #7, with follow-up #10 | The chat test passed on `bketelsen/clippy`, and the squash-merge sweep check (plan step 8) was done on 2026-10-03. |
| `sandbox-home` | #9 | The writable home is live, less a protected list (spec: [sandbox-home](docs/specs/sandbox-home.md)). |
| The judge's read-only rule | #11 | A read-only command runs without the task check. |
| The account's mise config and toolchains | fleet #40 and #41 | Node 24.21.0, pnpm 11.25.0, Go 1.27.1, Python 3.14.8. Configs under `~/work` are trusted. |
| The private-key screen fix | #15 | A fake `BEGIN … PRIVATE KEY` header no longer hides a page from the injection screen. |
| 6c `gates` | #16 | Its last live checks are in step 7's (Next, item 1). |
| Friction fixes from the clippy session | #17 | One `/tmp` for every agent and tool, which lasts (dsh's own temp files moved to `~/.cache/dish/tmp`, the unit's `TMPDIR`); mise's shims at the end of a sandboxed command's `PATH`; the judge counts `/tmp` with the workspace; `read_image` for the coder, reviewer and writer. Checked on the VM after the deploy. |
| `file` on the VM | fleet #42 | Guest play applied 2026-10-03 (`changed=1`, rerun `changed=0`). |
| Chromium, `fonts-liberation` and `xmllint` on the VM | fleet #43 | Guest play applied 2026-10-04 (`changed=1`, rerun `changed=0`). Checked through `dish-sandbox` as `dish`: headless screenshots of a `file://` page and of a `127.0.0.1` dev server started in the same call, fonts rendering, no process left; `xmllint` in both modes. Chromium needs a writable sandbox: in read-only mode it can't make its profile directory. `common.md` tells agents. |
| `bketelsen/dish` as a dish project | registered 2026-10-04 | `projects.yaml`: family `bketelsen`, gate `pnpm typecheck && pnpm test` (10m), setup `pnpm install --frozen-lockfile`, and a role line saying the user deploys it. The `role` field is display-only today: Settings → Projects shows it, and no prompt reads it, until step 8 deploys: its `dish-memory` message gives agents each repo's role. The deploy rule (an agent runs `deploy/` scripts, `dish-update` or `dish-url`, or restarts `dish-web`, only when the user asks) lives in the repo's [AGENTS.md](AGENTS.md), which the dish preset's `agent-instructions` row loads for every agent from the chat's workspace, the clone. dish fetches the clone but never moves its checkout (`main` at `29f6cd4` on 2026-10-05), so the main agent and its children see AGENTS.md only once you fast-forward it; until then, a coder gets it from its worktree's copy after its first read or edit there. Its gate passes inside the VM's sandbox: 4,505 tests, 4,499 pass, 0 fail, 6 skipped, in about 146 s. Two of the skips are the shellcheck tests, until [bketelsen/fleet#44](https://github.com/bketelsen/fleet/pull/44) installs `shellcheck` on the guest. Each task worktree needs its own `pnpm install --frozen-lockfile` (the `worktree` tool's answer says so). |
| 7 `orchestrator` | #21 | Deployed 2026-10-03 at 23:23 UTC. The first live run, on `bketelsen/clippy` (`20261003-readme-output-example`), went clean from start to finish: a coder's `report`, the gate passed at its head, a `final: true` review approved that head, and `open_pr` opened [bketelsen/clippy#13](https://github.com/bketelsen/clippy/pull/13), which the user merged. Every ledger line was the harness's, and no token was on disk. |
| 7a `browser` | #30 | Merged and deployed 2026-10-05 ([spec](docs/specs/browser.md), [plan](docs/plans/2026-10-04-browser.md)): `dish-browser`, one headless Chromium with a browser per agent session, the ten `browser_*` tools, the Browser tab and screenshots in the chat. Its real-Chromium tests run in the VM's gate, and it was checked end to end in a scratch dsh on the VM before the merge. The rollout's new defaults (the prompts and `crew.yaml`) landed at 10:10 UTC, and `judge.yaml` screens `browser_*` (added in the web UI at 10:12). The first live use, at 10:12: the main agent's `browser_navigate`, screened and passed (0.04). Its browser closed idle at 10:42, and Chromium a minute later. Still to see ([the rollout](docs/plans/2026-10-04-browser.md#the-rollout-for-you)): a coder's dev server and screenshot (step 5), and the screen on a planted page (step 6). |
| 8 `memory` + direction | #36; fleet #45 | Merged and deployed 2026-10-05 ([spec](docs/specs/memory.md), [plan](docs/plans/2026-10-05-memory.md)): `dish-memory`, with the vault, each family's direction, the `<dish-memory>` message, `remember`, `forget` and `recall`, and Settings → Memory; the config store's code moved into `dish-kit/store`; `report`'s `remember`; a run's rulings in its close answers; `family` as a slug; the preset row and `recall` for every crew role; the shipped prompts; and the deploy (`install.sh` links `memory`, and `DISH_VAULT_REMOTE` is optional). Reviewed task by task and as a whole branch, with one fix round, and checked live in `pnpm dev` before the merge (the spec's Notes from the build). **The rollout, 2026-10-05:** `bketelsen/dish-vault` created (private); [bketelsen/fleet#45](https://github.com/bketelsen/fleet/pull/45) (the vault's read-write deploy key, the `github-dish-vault` alias and `install.env`'s `DISH_VAULT_REMOTE`) previewed, applied (`changed=3`) and rerun (`changed=0`); the VM's families (`bketelsen`, `frostyard`) were already lowercase names. The deploy at 19:00 UTC linked `memory`, and the vault pushed its root commit (`b41e49f`) to `bketelsen/dish-vault`. The eight changed prompts and `crew.yaml` moved to the new defaults (config store `80de330` and `8cd6559`, pushed). **A gap in the rollout:** the first `dish-update` failed before changing anything, because the VM's pre-memory `update.sh` reads `install.env` before it fetches and refuses its new `DISH_VAULT_REMOTE` line, so it couldn't update itself. The checkout was fast-forwarded to `origin/main` by hand, as `dish` (clean, on `main`), and the new `update.sh` then ran as usual. A rollback past step 8 meets the same refusal on the way back ([deploy/README.md](deploy/README.md#updating)). Still to do: the seed memories, the directions and the first looks (Next, item 5). |

**The VM's `judge.yaml`** has `reversible: 0.80` and `servesTask: 0.40` (set in the web UI on 2026-10-03; the shipped default is 0.90/0.50). The [judge spec](docs/specs/judge.md) has the replay behind them. Its `tools.screened` gained `pr_feedback` by hand on 2026-10-03, as step 7's rollout says.

**Shelved:** mise approvals (the `dish-mise` wrapper, the judge's trusted rule and its checkbox). The work sits on the local branches `mise-approvals`, `mise-t1`, `mise-t2` and `mise-t3` in `~/projects/dish`, and was never pushed. sandbox-home replaced it: plain `mise install` works in the sandbox. Delete those branches when you're sure.

**The GitHub App:**
- **One App:** dish has one GitHub App, `bketelsen-dish-dev` (the name is historical: no separate prod App was made; on 2026-10-03 the user gave it write access and Checks and Commit statuses read instead). The VM uses it. It is installed on `bketelsen` and on all frostyard repositories, with Contents, Issues and Pull requests write, and Metadata, Checks and Commit statuses read. The docs before 2026-10-03 plan a separate prod App, `bketelsen-dish`; it doesn't exist.
- **Pushes:** agents' own pushes get 403 by design: dish mints read tokens for their git. Only `open_pr` pushes, with a write token it mints in memory for that push.
- **Rulesets** (2026-10-03), because agents can read the App's key ([the orchestrator spec](docs/specs/orchestrator.md)'s question 1). Each is named "default branch: humans merge": no deletion or force push, and a pull request with 1 approval (stale approvals dismissed, the last push approved).
  - **`bketelsen/clippy` and `bketelsen/dish`,** one per repository. Repository admins (the user) bypass it. A new `bketelsen` project needs its own when it is registered (the rollout's step 2).
  - **frostyard,** one for the organization, on every repository's default branch. Organization and repository admins bypass it, and so does every App installed on 2026-10-03 except `bketelsen-dish-dev` (renovate, the hive Apps, cloudflare, …), so they work as before. An App installed later isn't on the list: it is held to the rule until it is added.
  - **Merging to `bketelsen/dish`'s `main`** takes a pull request and an approval, or the admin bypass. Claude Code's auto mode refuses an agent's `gh pr merge --admin`, so the user merges.

## Running it

**Deploying dish.** The user deploys, or asks an agent to. An agent deploys only when asked ([AGENTS.md](AGENTS.md)). These run from the desktop:
```bash
incus exec minideb:dish --project dish -- dish-update            # dry run
incus exec minideb:dish --project dish -- dish-update --apply    # update and restart if needed
incus exec minideb:dish --project dish -- dish-update --apply <ref>   # roll back (read deploy/README.md first)
incus exec minideb:dish --project dish -- dish-url               # the sign-in link
```
A change to `deploy/update.sh` itself takes two applies: the first one runs the old script from memory.

**Fleet's guest play** (the account, its tools and its mise config). Fleet is live infrastructure, so confirm before applying:
```bash
cd ~/projects/fleet && git pull --ff-only
python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt   # once; see fleet's README
.venv/bin/ansible-playbook ansible/playbooks/minideb-dish-guest.yml --private-key ~/.ssh/<fleet-host-key> -e fleet_dish_approved=true --check --diff   # preview
.venv/bin/ansible-playbook ansible/playbooks/minideb-dish-guest.yml --private-key ~/.ssh/<fleet-host-key> -e fleet_dish_approved=true             # apply
```
A rerun right after an apply should report `changed=0`.

**Dev on the desktop:** `pnpm dev`. Dev keeps its data in `<checkout>/.dev` and keeps the read-only home in its sandbox. See [deploy/README.md](deploy/README.md).

**Reading a session on the VM** (read-only), to see how a chat went:
```bash
incus exec minideb:dish --project dish -- su - dish -c 'ls -lt ~/.dsh/sessions'
```
Sessions are `session.v4.jsonl.zstd` under the workspace's directory, and a crew child's session sits beside its parent's. dish's judge log is under `~dish/.local/state/dish/judge`, the gate logs under `~dish/.local/state/dish/gates/<owner>/<repo>/<slug>/`, a run's ledger under `~dish/.local/share/dish/ledgers/<owner>/<repo>/<id>.jsonl` and its record under `~dish/.local/state/dish/orchestrator/<owner>/<repo>/runs/`. Settings → Runs shows both.

## How we work

- **Talk first, then a spec, then a plan, then the build.** A spec is written only when the user says the idea is ready. Plans live in `docs/plans/`.
- **Builds are subagent-driven:**
  - a fresh implementer for each task, in its own worktree;
  - an Opus review of each task, then fix rounds;
  - a ledger kept by the controller;
  - a whole-branch final review before the PR.
- **Humans merge.** An agent merges only when the user asks it to.
- **Usability first.** The VM is the boundary. Inside it, gates, dependency downloads, dev scripts and installs must just work. A security fix that adds a refusal, a hard failure or another approval to normal work is the wrong fix: document the risk instead, and push back on reviewers who ask for one.
- **Safety rules for anyone working on dish:**
  - Never run dsh or tests against real state: `~/.dsh`, `~/.config/dish`, `~/.local/{share,state}/dish`, `~/.cache/dish`, `~/work`.
  - Every spawned process gets a scratch `HOME`, `DSH_HOME`, `XDG_*`, `DSH_DISH_HOME` and `TMPDIR`, and an interactive shell a scratch `HISTFILE` too. A test once truncated `~/.bash_history`.
  - Never print or read `.envrc`, which holds the TypeSafe key. Never run `env` or `printenv`, and never paste a token.
  - The user enters credentials and signs in. Agents don't.

## Next

1. **Watch step 7's runs** ([spec](docs/specs/orchestrator.md), with its "Notes from the build"; [the rollout's step 8](docs/plans/2026-10-03-orchestrator.md#the-rollout-for-you)). The first run was clean. Over the next ones, note:
   - how long each step takes, and whether coders still run the gate themselves;
   - whether a report steer fires, and why;
   - whether the main agent uses `run` `status` after a compaction, and what the ledger shows that the chat doesn't;
   - for review feedback: whether the judge screens `pr_feedback`'s answers, and whether the main agent picks a re-review or a ruling after a merge.

   6c's last live checks are still to see: a failing gate fixed in round 2, and a review that needs a ruling.
2. **Watch the next sessions after #17.** Replayed against Jev, the clippy run's 24 stops and asks come to about 4 with the new `/tmp` wording and the VM's thresholds. Check that it holds in practice. Also check whether agents keep scratch files in `/tmp` (with `mktemp -d -p /tmp`) rather than `.worktrees/`, and whether the main agent hands image checks to a child.
3. **The App's reach** (optional). `bketelsen-dish-dev` is installed on all frostyard repositories, though dish uses only the registered ones (`frostyard/nsl` today). The org ruleset keeps its key from any default branch, but it can still push other branches and open pull requests anywhere in frostyard. Narrowing the installation to the registered repositories (and adding each as it is registered) would shrink that; Issues write is unused by dish and can go too.
4. **Going public.** An audit on 2026-10-03 found no real secret anywhere in the history. Before flipping the repo to public, run, with direnv loaded, `git log --all --format=%h -S"${TYPESAFE_API_KEY:8:16}"`: no output means the key was never committed. The two `apikey_…` values in `packages/dish-kit/test/secrets.test.ts` should be the fakes their comment says they are. Also: delete the merged branches, turn off the wiki if unused, and skim the PR descriptions. Links to `bketelsen/fleet` go to a private repository.
5. **Step 8, `memory` + direction** ([spec](docs/specs/memory.md), [plan](docs/plans/2026-10-05-memory.md)). Memory moved ahead of families (now step 9) and routines (step 10, formerly triggers) on 2026-10-05 ([ROADMAP.md](ROADMAP.md), [the design's families section](docs/design.md#project-families)). It's merged ([bketelsen/dish#36](https://github.com/bketelsen/dish/pull/36)) and deployed (2026-10-05), with its vault pushing to `bketelsen/dish-vault` (State, above). Next, from [the rollout](docs/plans/2026-10-05-memory.md#the-rollout-for-you):
   - **Seed and direct** (its step 6). On Settings → Memory, add the four seed memories from [plugins/memory/README.md](plugins/memory/README.md#seeding-a-new-install): `talk-before-specs` under You; `usability-over-hardening`, `scratch-home-in-tests` and `own-plugins` under bketelsen. Write a first direction for `bketelsen` and `frostyard`.
   - **First looks** (its step 7): a new chat in a project, asked what it knows about the family, cites the direction and the memories; after a long session's compaction it still knows them; Settings → Memory's remote line shows the vault's pushes. The family steps of the live check were skipped in dev, so this is their first run.
   - **Tell the next session** (its step 8): whether the main agent saves what it should, and only that; how many memories Jev holds, and whether it was right; whether children use `recall`; the message's size in practice.
6. **[ROADMAP.md](ROADMAP.md)'s backlog.** The items that matter most in daily use:
   - watching a run's pull request after `open_pr` (CI failures, conflicts, review comments) and waking the chat that drives it, as Claude Code desktop's "Auto-fix pull requests" does. Step 9 takes it in;
   - dev-server previews: the browser step (7a) covers them, live since 2026-10-05 ([spec](docs/specs/browser.md)). A coder's dev server in the Browser tab is still to be seen (its rollout's step 5).
7. **dsh issues worth filing upstream**, seen in sessions:
   - `{{model}}` shows the preset's model, not the session's;
   - the child "send your result" note can't be turned off;
   - a provider without a key fails the first turn and the title;
   - there's no setting for extra writable roots (dish uses `runnerCommand` instead);
   - a message typed mid-turn waits for the whole turn;
   - `bash` without `description` is refused;
   - `edit` refuses a file seen only through `cat`, and a file read in an earlier turn of a follow-up (a writer's 8 edits failed that way);
   - a `workdir` that doesn't exist is reported as `spawn <runner> ENOENT`, which reads as the sandbox runner missing;
   - `grep` refuses `include: ""` ("include must be a non-empty glob when given") instead of taking it as absent, which a model passes for "no filter".

## Known limits to keep in mind

- **The sandbox guards against accidents, not a determined agent.** The D-Bus session bus and the systemd user manager are reachable from inside it, which is left open on purpose. Reads were never confined: an agent's shell can read `~/.dsh/.credentials.yaml` and `~/.ssh`.
- **Agents never push:** their git gets read tokens. Only `open_pr` pushes, after its checks. The App's key is readable by agents, so the rulesets on default branches are what keep a key reader from reaching them.
- **`/tmp` on the VM is shared and RAM-backed** (since #17). Every agent and tool sees the machine's `/tmp`, a 3.9 GB tmpfs aged out after 10 days, so an agent that fills it costs memory. Nothing that runs as `dish` outside the sandbox may keep files there that it later reads or runs: dsh uses `~/.cache/dish/tmp`, `update.sh` gives `install.sh` the same, and `install.sh` should be run on the VM only through `dish-update` (`deploy/README.md`, The sandbox).
- **The writable home's residual risks:** sandboxed code can leave things in the home directory (caches, `~/go/bin`, mise installs) that an approved escalation later runs. The protected list covers what runs without anyone acting.
- **The judge's read-only rule:** a command that reads and sends in one step depends on the judge reading it as `irreversible`.
- **The judge's ask counts:** read-only commands no longer ask. The judge still asks about writes that it scores as not serving the task, such as tests an agent runs on its own initiative.
