# Roadmap

The proposed build order for the system in [docs/design.md](docs/design.md). Each step gets its own spec when we start it.

| # | Step | Why here | Status |
|---|---|---|---|
| — | `copilot`: Copilot sign-in card, live model catalog | models | done |
| 1 | **Spike: specialist identity and keeping the chat open.** Can a delegated child get its role's prompt, tools and model? Does the main agent stay responsive while children work? | Everything else assumes yes. | done: yes to both, see the design doc's spike results |
| 2 | `dish-kit` + `config-store` ([spec](docs/specs/config-store.md)): XDG paths and the git-backed versioned config store. Move the Copilot cache to the XDG cache directory. | The foundation every plugin uses. | next: [plan](docs/plans/2026-09-30-config-store.md) written |
| 3 | `prompts`: role prompts with a web UI editor, history, diff and revert | The first plugin on `config-store`, and small. | |
| 4 | `crew`: roles, model tiers, the cross-family reviewer rule, the `delegate` tool | Lets you talk to a delegating main agent. | |
| 5 | **VM deployment**: service unit, Tailscale HTTPS, dish checkout and profile install. Access is under reconsideration: public with GitHub sign-in limited to you and `frostyard` (design open question 6). | Workspaces and triggers need to live where they'll run. | |
| 6 | `projects` + `workspaces` + `gates`: the repo registry, clones and worktrees, structural gates | Makes coding work safe. | |
| 7 | `orchestrator`: the main-agent preset and the superpowers-style pipeline | Plan → implement → gate → review → PR, end to end. | |
| 8 | `families` + `inbox`: direction, initiatives, ledger, and the Families and inbox pages | Direction you can see and steer. | |
| 9 | `triggers`: schedules and GitHub events through Funnel | Unattended work on approved initiatives. | |
| 10 | `memory`: the vault | Durable personal and project context. | |
| later | `copilot-usage`, `infra` (tiered approvals), `web-research` | | |
