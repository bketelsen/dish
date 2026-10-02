# Roadmap

The proposed build order for the system in [docs/design.md](docs/design.md). Each step gets its own spec when we start it.

| # | Step | Why here | Status |
|---|---|---|---|
| — | `copilot`: Copilot sign-in card, live model catalog | models | done |
| 1 | **Spike: specialist identity and keeping the chat open.** Can a delegated child get its role's prompt, tools and model? Does the main agent stay responsive while children work? | Everything else assumes yes. | done: yes to both, see the design doc's spike results |
| 2 | `dish-kit` + `config-store` ([spec](docs/specs/config-store.md)): XDG paths and the git-backed versioned config store. Move the Copilot cache to the XDG cache directory. | The foundation every plugin uses. | done: [plan](docs/plans/2026-09-30-config-store.md), pushing to `bketelsen/dish-config` |
| 3 | `prompts` ([spec](docs/specs/prompts.md)): role prompts in the config store, a persona row and a "dish" preset for the main agent, and Settings → Prompts (edit, preview, default diff and reset, history) | The first plugin on `config-store`, and small. | done: [plan](docs/plans/2026-10-01-prompts.md); the dish preset is the default for new chats |
| 3a | `skills` ([spec](docs/specs/skills.md)): dish's own skills, stored and versioned in the config store, edited in the web UI, offered to agents through dsh's skill mechanism. The pipeline's procedures (brainstorm, plan, test-first, review) live here. | `orchestrator` (7) runs on them; storage and editor can follow the `prompts` pattern. | done: [plan](docs/plans/2026-10-02-skills.md); checked end to end in a scratch dsh, deployed to the VM 2026-10-02 |
| 4 | `crew` ([spec](docs/specs/crew.md)): roles, model tiers, the cross-family reviewer rule, the `delegate` tool, the dish preset. Built on dsh-subagent directly, not dsh's experimental agent teams ([research](docs/research/2026-10-01-dsh-agent-team.md)). | Lets you talk to a delegating main agent. | done: [plan](docs/plans/2026-10-01-crew.md); live-checked delegation, the writer limit, the GPT reviewer, fix rounds and a restart |
| 4a | `judge` ([spec](docs/specs/judge.md)): Jev client and key card, a command gate on every shell call, the approval answerer (children included), screening web and MCP results for injected instructions, `ask_judge` for every agent, and Settings → Judge | Guardrails before anything runs unattended or in public. | done: [plan](docs/plans/2026-10-01-judge.md), installed and verified live 2026-10-01 |
| 5 | **VM deployment** ([spec](docs/specs/deploy.md)): a Debian VM on Minideb from fleet (OpenTofu and Ansible), `dsh web` as a user service behind `tailscale serve`, dish's `deploy/` install script, the config store moved to the VM. Tailscale only; public access with GitHub sign-in is a later step. | Workspaces and triggers need to live where they'll run. | done: [plan](docs/plans/2026-10-01-deploy.md); running at `https://dish.goat-snake.ts.net` since 2026-10-01 |
| 6a | `ops` ([spec](docs/specs/ops.md)): prod and dev, `update.sh` and `url.sh`, fleet back to provisioning. Also settings over the tailnet (`dish-web`) and the Copilot first sign-in card on a fresh profile. | dish working on itself needs dev data apart from prod's, the live checkout out of every chat, and deploys only by hand. | built on branch `ops`, [plan](docs/plans/2026-10-02-ops.md); awaiting review and the rollout. Fleet's side is PR [bketelsen/fleet#38](https://github.com/bketelsen/fleet/pull/38) |
| 6 | 6b `projects` + `workspaces`: the repo registry, clones and worktrees, and a GitHub App for clones. 6c `gates`: structural gates | Makes coding work safe. | |
| 7 | `orchestrator`: the main-agent preset and the superpowers-style pipeline | Plan → implement → gate → review → PR, end to end. | |
| 8 | `families` + `inbox`: direction, initiatives, ledger, and the Families and inbox pages | Direction you can see and steer. | |
| 9 | `triggers`: schedules and GitHub events through Funnel | Unattended work on approved initiatives. | |
| 10 | `memory`: the vault | Durable personal and project context. | |
| later | `copilot-usage`, `infra` (tiered approvals), `web-research` | | |

## Backlog

Small follow-ups that don't need a step of their own.

| Item | Why | Noted |
|---|---|---|
| `judge`: read the agent's task from a projection kept up to date by `session/event`, not from `session.snapshotEvents()`. | dsh marks `snapshotEvents` deprecated. If it goes away, the gate judges commands against an empty task and asks more. | 2026-10-01, judge build |
| `judge`: weight dense text (hex, base64, minified code) more in the screen's rate budget. | The budget counts characters, which under-counts tokens for dense text. | 2026-10-01, judge build |
