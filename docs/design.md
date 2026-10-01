# dish design

Status: draft, from the brainstorm on 2026-09-30. It records what we decided and the shape of the system, not implementation detail. Each plugin gets its own spec when we build it.

## Goal

**One main agent** runs on a VM and works across whole GitHub orgs:
- It talks with you, plans, and delegates about 90% of the work to a fixed crew of specialists.
- It verifies what comes back and keeps the chat open the whole time.
- It works toward a direction you set for each **project family**: a named set of repos you register explicitly. It works unattended, but only on initiatives you've approved.
- Code reaches a repo only through a pipeline: plan → implement → **structural gate** → **cross-family review** → PR. Humans merge.

## Principles

1. **Composable.**
   - Each plugin owns one capability. Plugins talk to each other only through named Cordis services with typed contracts, so one piece can be changed, swapped or removed without touching the rest.
   - There's one bundle per plugin. Shared code lives in `dish-kit`, a library with no state.
2. **Configuration and runtime data are kept apart.**
   - Configuration is what *you* author: prompts, crew, families, direction. It's versioned and editable in the web UI.
   - Runtime data is what the system produces: ledgers, status, workspaces, memory.
3. **XDG locations by default**, overridable per plugin.
4. **Structure where it matters, prompting elsewhere.**
   - Enforced by the harness: gates and the cross-family reviewer.
   - Strongly prompted, not enforced: delegation.
5. **Humans merge.** Automerge may become a per-repo option later.

## Storage

| Kind | Default | Holds | Versioned |
|---|---|---|---|
| Config | `$XDG_CONFIG_HOME/dish/` | `crew.yaml` (roles, model tiers, tools), `prompts/<role>.md`, `families/<family>/` (direction, repos and gates, approved initiatives) | git repo; every UI save is a commit; history, diff and revert in the UI |
| Data | `$XDG_DATA_HOME/dish/` | `vault/` (memory, its own git repo pushed to a private GitHub repo), `ledgers/`, initiative status, `workspaces/<org>/<repo>` clones and their worktrees | the vault via git; ledgers append-only |
| State | `$XDG_STATE_HOME/dish/` | inbox items, trigger and run state, logs | no |
| Cache | `$XDG_CACHE_HOME/dish/` | Copilot model catalog cache (currently in `~/.dsh`; it will move), fetched pages | no |

dsh keeps its own home, `~/.dsh`, for sessions, profiles and credentials. dish doesn't write there except through dsh services.

## The crew

| Role | Default tier | Does |
|---|---|---|
| **main** | strong | Talks with you, plans, delegates, verifies, keeps the ledger, makes rulings. Delegates about 90% of the work. |
| **architect** | strong | Brainstorm → spec → plan, as small tasks that each state exact files, interfaces and tests (the superpowers `writing-plans` shape). |
| **coder** | mid | Implements one task in its own worktree. A fresh coder for each task, with no inherited chat history. |
| **reviewer** | mid | Reviews each task for spec compliance and quality, plus a final whole-branch review. Always a **different model family from the coder** (Claude ↔ GPT by default; Gemini and Grok are allowed), enforced by the harness. |
| **researcher** | mid | Web and code research, with cited findings. |
| **ops** | mid | Homelab and infra work (later, with tiered approvals). |
| **writer** | mid | Docs, release notes, issue and PR prose. |

The main agent may choose a different model for any delegation, except that it can't override the reviewer's cross-family rule. Every role's system prompt can be edited in the web UI and is stored as versioned config.

## The pipeline

Modeled on [obra/superpowers](https://github.com/obra/superpowers) (`writing-plans`, `subagent-driven-development`):

1. **Architect** writes the spec and plan.
2. **Main agent**, as the controller, runs the tasks without pausing to check in. It records every judgment call as a ruling (`Ruling: what — why — cost if wrong`) and stops only for irreversible or security-sensitive actions, pushes and merges, or a plan too broken to continue.
3. **Per task:** worktree → fresh **coder** → **gate** → cross-family **reviewer**.
4. **Escalation ladder**, the same for gate failures and review findings: rounds 1–3 resume the same coder; round 4 starts a fresh coder on a stronger model; at round 5 the main agent adjudicates what's left and either rules or stops.
5. **Final whole-branch review**, then a PR. A human merges.

### Gates (structural)

- Every registered repo declares a gate command explicitly, e.g. `./gate.sh`.
- When a coder agent working in a registered repo is about to finish its turn, the gates plugin runs the gate itself in that worktree. dsh's `agent/turn-stopping` hook is the interception point.
- If the gate fails, its output is sent back to the coder (`agent.steer`) and the turn continues. "Done" means the gate actually passed, not that the coder says it ran.
- The gates plugin counts rounds and hands off to the ladder. dsh's own hook bridges have no loop cap, so this one must have its own.

## Project families

A family is a named set of repos with its own direction.
- **You can have as many families as you like.**
- **Repos are registered explicitly.** A family is never "every repo in the org". For example, `bketelsen` has about 500 repos, of which about 5 matter.
- A family usually draws from one GitHub owner (org or user), but nothing requires that.
- A repo belongs to at most one family, so there's never a question of whose direction applies.

The first family is **frostyard**, with these repos: `snosi`, `nsl`, `updex`, `chairlift`, `intuneme`, `core`, `firn`, `lab`, `testsuite`. Frostyard's earlier agent tooling (snowcat, bobsled, rime and others) is ignored and being replaced. A **bketelsen** family with a handful of repos is likely next.

| Part | Owner | Stored as |
|---|---|---|
| **Direction**: north star, ranked priorities, non-goals and constraints | you; the main agent can *propose* changes to your inbox | config |
| **Repos**: each with a one-line role, its gate, and later an automerge flag | you | config |
| **Initiatives**: workstreams under the direction | the main agent proposes; you approve. Approved definitions are config; their status is data. | config + data |
| **Standing initiatives**, e.g. "keep CI green on the 9 repos", "triage new issues" | approved once; events feed work into them | config + data |
| **Ledger**: decisions, rulings, actions, PRs | the main agent | data, append-only |

Everything here is edited and watched on a **Families** page in the web UI.

### Unattended work

- **Wake-ups** come from schedules (e.g. a morning planning pass) and GitHub events (issues, CI failures in a family's registered repos, arriving through a Tailscale Funnel webhook path).
  - An org can send everything through one org webhook, and events from unregistered repos are dropped.
  - A user namespace has no org-level webhook, so its registered repos each get their own hook. `triggers` installs and removes those as repos are registered.
- On each wake-up the main agent reads the direction and the state of the repos, then works **only on approved or standing initiatives**.
- A new issue gets filed under an existing initiative if it fits. Otherwise it becomes a *proposed* initiative in your inbox.
- Results, proposals and anything waiting for you go to the **inbox** page. There are no push notifications.
- No budget cap for now.

## Plugins and contracts

Each is its own bundle. "Provides" names its Cordis service; plugins depend only on the services listed.

| Plugin | Provides | Depends on | Owns |
|---|---|---|---|
| `dish-kit` (library) | — | — | XDG paths, terminal logs, client build script, remote helpers, git-backed versioned store |
| `config-store` | `dishConfig` | — | the config git repo: namespaced documents, history, diff, revert, change events |
| `prompts` | `prompts` | `dishConfig` | role prompts plus the editor page (edit, history, diff, revert) |
| `crew` | `crew` | `prompts`, `dishConfig` | roles, model tiers, the model-family rule, giving each delegated child its role's identity and tools, the `delegate` tool |
| `projects` | `projects` | `dishConfig` | the repo registry: family, role, clone path, gate command |
| `workspaces` | `workspaces` | `projects` | clones on the VM, one worktree per task, cleanup |
| `gates` | — | `projects` | gate execution at turn-stop, retry rounds |
| `orchestrator` | — | `crew`, `workspaces`, `families` | the main-agent preset and the pipeline as prompts, skills and ledger tools |
| `families` | `families` | `dishConfig`, `projects` | direction, initiatives, ledger, the Families page |
| `inbox` | `inbox` | — | items (proposal, approval, result) and the mobile-friendly page |
| `triggers` | — | `families`, `inbox` | schedules and GitHub events → main-agent wake-ups |
| `memory` | `memory` | — | the vault: notes, search and agent tools |
| `copilot` (done) | `copilotCatalog` | — | Copilot sign-in and the live model catalog |
| later: `copilot-usage`, `infra` (with a tiered approval answerer), `web-research` | | | |

Swapping a piece means keeping its service contract. For example:
- `gates` knows nothing about families.
- `families` could be replaced without touching the pipeline, as long as `families` still answers the same questions.

## Decisions

| Topic | Decision |
|---|---|
| Delegation | Strong prompting, not enforcement. |
| Crew | Fixed: architect, coder, researcher, ops, writer, reviewer. |
| Families | Any number. Each is an explicitly registered set of repos, never a whole org implicitly. A repo is in at most one family. |
| Models | Main and architect strong; others mid-tier; the main agent may override. The reviewer is always cross-family from the coder. |
| Gates | Declared explicitly per repo, run by the harness, with an escalation ladder (N = 5 rounds). Family-wide gate conventions come later. |
| Merging | Humans merge. Automerge is left open as a later per-repo option. |
| Unattended scope | Approved initiatives only, plus standing initiatives fed by events. |
| Triggers | Schedules and GitHub events. |
| Budget | None for now. |
| Workspaces | One clone per repo on the VM, one worktree per task. |
| Hosting | VM on Tailscale, Funnel for the webhook path only, inbox page only. |
| Memory | A fresh vault in git, backed up to a private GitHub repo. |
| Prompts | Every role's prompt is editable in the web UI and versioned. |
| Storage | Config and runtime data kept apart; XDG defaults. |

## Open questions and spikes

1. **Specialist identity for children (spike first).** dsh's in-process children join their *parent's* preset, so "spawn a coder" doesn't by itself give the child the coder prompt and tools. Options: a `crew` subagent provider that composes the child with its role, or scoping prompt sections and tools to the child agent when it starts. Everything else rests on this.
2. **Keeping the chat open.** Confirm that background delegation (continuable children, jobs) keeps the main agent responsive in the web UI, and that completions arrive as notices.
3. **Enforcing the reviewer's model.** Where `crew` intercepts a reviewer delegation to pin the cross-family model, and how a model id maps to a family.
4. **Config backup.** Push the config repo to a private remote like the vault, or keep it local?
5. **dsh's own home.** `~/.dsh` mixes dsh's config and data. Leave it, or point `DSH_HOME` somewhere XDG-shaped?
6. **The VM.** OS, provisioning, and the service unit. Deferred from the brainstorm.
7. **Gate environment.** Sandbox, timeouts, and whether gates need network or secrets.
