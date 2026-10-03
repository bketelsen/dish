# Handoff

Where dish stands, how to run it, and what's next. Updated 2026-10-03. The plan of record is [ROADMAP.md](ROADMAP.md). The design is [docs/design.md](docs/design.md), and each step has its spec under [docs/specs/](docs/specs/).

## What dish is

dish is a set of plugins for dsh (DeepSeek Harness, `@deepseek-ai/dsh` 0.2.0-rc.2) that make it a personal agent harness:
- **The setup:** Copilot models, prompts and skills in a git-backed config store, a crew of role agents with a cross-family reviewer, and a command judge (Jev on TypeSafe).
- **The work:** GitHub projects with task worktrees, and a sandbox that lets agents work.

It runs as `dsh web` on a Debian VM.

- **This repo:** `bketelsen/dish`, checked out on the desktop at `~/projects/dish` and on the VM at `~dish/dish`.
- **Fleet:** `bketelsen/fleet` (`~/projects/fleet`) is live infrastructure. It defines the Incus instance `dish` (project `dish` on the `minideb` remote), the account, and its tools: Node, pnpm, mise and the pinned toolchains.
- **The VM:**
  - `dsh web` runs as `dish-web.service`, a user unit of the `dish` account.
  - It's served at `https://dish.<tailnet>.ts.net`.
  - The prod profile is `~dish/.dsh/profiles/web`. Work lives in `~dish/work` (clones, worktrees, and the `scratch` workspace).
- **The config store:** `~/.config/dish/config.git`. The VM pushes it to `bketelsen/dish-config`, and the desktop's store has no remote. Never give the desktop one while the VM runs, and never put a secret in it.

## State on 2026-10-03

Everything below is merged and running on the VM.

| Piece | Where | Notes |
|---|---|---|
| Copilot, config store, prompts, skills, crew, judge, web settings | steps up to 6a | |
| `ops` (6a): prod and dev, `dish-update`, `dish-url` | `df9c4b1`; fleet #38 and #39 | |
| friction fixes and one-approval | `8545e8d`, `8a1ff3d` | |
| `projects` + `workspaces` (6b) | #7, with follow-up #10 | The chat test passed on `bketelsen/clippy`. The squash-merge sweep check (plan step 8) hasn't been run yet. |
| `sandbox-home` | #9 | The writable home is live, less a protected list (spec: [sandbox-home](docs/specs/sandbox-home.md)). |
| The judge's read-only rule | #11 | A read-only command runs without the task check. |
| The account's mise config and toolchains | fleet #40 and #41 | Node 24.21.0, pnpm 11.25.0, Go 1.27.1, Python 3.14.8. Configs under `~/work` are trusted. |

**Shelved:** mise approvals (the `dish-mise` wrapper, the judge's trusted rule and its checkbox). The work sits on the local branches `mise-approvals`, `mise-t1`, `mise-t2` and `mise-t3` in `~/projects/dish`, and was never pushed. sandbox-home replaced it: plain `mise install` works in the sandbox. Delete those branches when you're sure.

**The GitHub App:** the VM uses `bketelsen-dish-dev` (read-only: Contents and Pull requests). The plan assumed a second App, `bketelsen-dish`, for prod. Either make it and switch keys on Settings → GitHub App, or decide the one App is enough and say so in the 6b spec.

## Running it

**Deploying dish.** The user deploys; an agent deploys only when asked. These run from the desktop:
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
Sessions are `session.v4.jsonl.zstd` under the workspace's directory, and a crew child's session sits beside its parent's. dish's judge log is under `~dish/.local/state/dish/judge`, and, once 6c is deployed, the gate logs under `~dish/.local/state/dish/gates/<owner>/<repo>/<slug>/`.

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

1. **6c `gates`** ([spec](docs/specs/gates.md), [plan](docs/plans/2026-10-03-gates.md)): merged and deployed to the VM on 2026-10-03, and checked end to end in a scratch dsh (the spec's "Notes from the build"). When a crew coder bound to a worktree is about to finish, `dish-gates` runs the project's gate there in the sandbox, sends a failure back (at most 3 gate runs a turn; the third failure ends the turn), and records the result in crew's record. The finish notice says how the gate ended, and a review of work whose gate didn't pass needs the main agent's `gateOverride` ruling. The rollout is the plan's [last section](docs/plans/2026-10-03-gates.md#the-rollout-for-you):
   - done: the deploy (`dish-update --apply` added the `dish-gates` bundle and restarted);
   - `bketelsen/clippy`'s gate is `go build` (10m). It works as is: a gate's `PATH` ends with mise's shims, so bare `go` resolves through mise. Consider `go vet ./... && go test ./...` with `5m`;
   - the live check: a failing gate fixed in round 2, a review, and a blocked coder whose review needs a ruling.

   Then tell the next session how long each gate took, and whether the coder also ran the gate itself: until step 7 drops the coder's own run, a gate runs twice.
2. **6b's last check:** the squash-merge sweep check in the [plan's rollout](docs/plans/2026-10-02-projects.md#the-rollout-for-you), step 8.
3. **The prod App decision** (above).
4. **`README.md:19`** says Settings → GitHub App takes dev's own App, which waits on the prod App decision.
5. **Going public.** An audit on 2026-10-03 found no real secret anywhere in the history. Before flipping the repo to public, run, with direnv loaded, `git log --all --format=%h -S"${TYPESAFE_API_KEY:8:16}"`: no output means the key was never committed. The two `apikey_…` values in `packages/dish-kit/test/secrets.test.ts` should be the fakes their comment says they are. Also: delete the merged branches, turn off the wiki if unused, and skim the PR descriptions. Links to `bketelsen/fleet` go to a private repository.
6. **[ROADMAP.md](ROADMAP.md)'s backlog.** The items that matter most in daily use:
   - crew's own `send_message`, so children stop sending a "done" message before their report;
   - Chromium and `libxml2-utils` on the VM;
   - dev-server previews.
7. **dsh issues worth filing upstream**, seen in sessions:
   - `{{model}}` shows the preset's model, not the session's;
   - the child "send your result" note can't be turned off;
   - a provider without a key fails the first turn and the title;
   - there's no setting for extra writable roots (dish uses `runnerCommand` instead);
   - a message typed mid-turn waits for the whole turn;
   - `bash` without `description` is refused;
   - `edit` refuses a file seen only through `cat`.

## Known limits to keep in mind

- **The sandbox guards against accidents, not a determined agent.** The D-Bus session bus and the systemd user manager are reachable from inside it, which is left open on purpose. Reads were never confined: an agent's shell can read `~/.dsh/.credentials.yaml` and `~/.ssh`.
- **The GitHub App is read-only, so agents never push.** A `git push` from an agent is refused with 403, by design (decision 2A).
- **The writable home's residual risks:** sandboxed code can leave things in the home directory (caches, `~/go/bin`, mise installs) that an approved escalation later runs. The protected list covers what runs without anyone acting.
- **The judge's read-only rule:** a command that reads and sends in one step depends on the judge reading it as `irreversible`.
- **The judge's ask counts:** read-only commands no longer ask. The judge still asks about writes that it scores as not serving the task, such as tests an agent runs on its own initiative.
