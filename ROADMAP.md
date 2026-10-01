# Roadmap

The proposed build order for the system in [docs/design.md](docs/design.md). Each step gets its own spec when we start it.

| # | Step | Why here | Status |
|---|---|---|---|
| — | `copilot`: Copilot sign-in card, live model catalog | models | done |
| 1 | **Spike: specialist identity and keeping the chat open.** Can a delegated child get its role's prompt, tools and model? Does the main agent stay responsive while children work? | Everything else assumes yes. | done: yes to both, see the design doc's spike results |
| 2 | `dish-kit` + `config-store` ([spec](docs/specs/config-store.md)): XDG paths and the git-backed versioned config store. Move the Copilot cache to the XDG cache directory. | The foundation every plugin uses. | done: [plan](docs/plans/2026-09-30-config-store.md), pushing to `bketelsen/dish-config` |
| 3 | `prompts` ([spec](docs/specs/prompts.md)): role prompts in the config store, a persona row and a "dish" preset for the main agent, and Settings → Prompts (edit, preview, default diff and reset, history) | The first plugin on `config-store`, and small. | next: spec written |
| 3a | `skills` (placeholder): dish's own skills, stored and versioned in the config store, edited in the web UI, offered to agents through dsh's skill mechanism. The pipeline's procedures (brainstorm, plan, test-first, review) live here. | `orchestrator` (7) runs on them; storage and editor can follow the `prompts` pattern. | to discuss |
| 4 | `crew`: roles, model tiers, the cross-family reviewer rule, the `delegate` tool | Lets you talk to a delegating main agent. | |
| 4a | `judge`: Jev client and key card, the approval-seam answerer (read-only / reversible / irreversible with confidence gating), tool-result injection screening, and `ask_judge` | Guardrails before anything runs unattended or in public. | |
| 5 | **VM deployment**: service unit, Tailscale HTTPS, dish checkout and profile install. Access is under reconsideration: public with GitHub sign-in limited to you and `frostyard` (design open question 6). | Workspaces and triggers need to live where they'll run. | |
| 6 | `projects` + `workspaces` + `gates`: the repo registry, clones and worktrees, structural gates | Makes coding work safe. | |
| 7 | `orchestrator`: the main-agent preset and the superpowers-style pipeline | Plan → implement → gate → review → PR, end to end. | |
| 8 | `families` + `inbox`: direction, initiatives, ledger, and the Families and inbox pages | Direction you can see and steer. | |
| 9 | `triggers`: schedules and GitHub events through Funnel | Unattended work on approved initiatives. | |
| 10 | `memory`: the vault | Durable personal and project context. | |
| later | `copilot-usage`, `infra` (tiered approvals), `web-research` | | |
