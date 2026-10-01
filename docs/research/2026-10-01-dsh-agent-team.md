# Research: dsh's experimental agent teams

Date: 2026-10-01. dsh version: 0.2.0-rc.2. Packages:
- `@deepseek-ai/dsh-experimental-agent-team-profile`
- `@deepseek-ai/dsh-experimental-agent-team`
- `@deepseek-ai/dsh-experimental-tool-agent-team`
- `@deepseek-ai/dsh-experimental-client-ui-agent-team`

Paths below are relative to the deepseek-harness repo at that version. The installed build matches the source.

**Why we looked:** it's dsh's own take on multi-agent work, which overlaps with our `crew` (roadmap step 4) and `orchestrator` (step 7).

**Conclusion:** don't build `crew` on agent-team, and don't mount it alongside `crew`. Keep `crew` on `dsh-subagent` (`ctx.subagents.startContinuable`) directly, as the spike did, and borrow the patterns listed under [Worth copying](#worth-copying).

## What it is

- **The profile is only a bundle patch** (`packages/experimental/agent-team-profile/cordis.patch.yml`). It has no code and no presets, and adds no prompt text of its own.
  - **Disables** dsh-subagent's own tools: `tool-subagent-control`, `tool-subagent-list-agents`, `tool-subagent` and `tool-subagent-fork`.
  - **Inserts `agent-team`** with these limits: `maxMembers: 8`, `maxTasks: 256`, `maxPendingMessagesPerMember: 64`, `maxMessageBytes: 65536`.
  - **Inserts** `tool-agent-team` and `ui-agent-team`.
- **Off by default.** It's in `OPTIONAL_BUNDLES` (`packages/boot/app-boot/src/profile.ts`), and no shipped profile enables it. You add it with `dsh plugin --profile <p> add @deepseek-ai/dsh-experimental-agent-team-profile`, or from the Plugins page.
- **UI:** a session-header action showing a roster (phase, status, model) and a read-only task board. Clicking a member opens its child session. There's no mailbox view and no spawn or interrupt controls.

## How a team works

- **No predefined roles.** The lead's model creates members at runtime with `spawn_teammate({ name, description, prompt, context: fresh | fork })`.
- **Identity isn't a system prompt.** It's a "You are teammate …" reminder block prepended to the member's first message, so forks keep the parent's system-prompt prefix. Design note: `.agents/notes/implemented/feature/2026-08-05-agent-teams.md`.
- **Spawned through dsh-subagent** (`packages/experimental/agent-team/src/roster.ts`, around line 282). It calls `startContinuable({ childId, provider, label, request: { prompt, parent } })`, **with no `persona`, `toolFilter` or `agentOptions`**, although dsh-subagent supports all three.
- **Members inherit the lead's preset, model and tools.** Children compose from their parent's preset. The roster's model column is the live model or the lead's. The only per-member choice is fresh versus fork, which picks one of two configured providers. Every member gets the same nine team tools.
- **Persistent, named and flat.**
  - Members are cold-resumable continuable children.
  - Names are never reused, failed members included.
  - Only the lead spawns or interrupts, and there are no nested teams.
  - `maxMembers` counts every member ever created, not the ones currently alive.

## Communication

- **Tools:** `spawn_teammate`, `send_message`, `list_agents`, `wait_agent` and `interrupt_agent`, plus a shared task board: `team_task_create`, `team_task_list`, `team_task_get` and `team_task_update`.
  - Updates are compare-and-set on a revision. The actions are claim, release, edit, set dependencies, complete, reopen, reassign and delete.
  - Tasks have dependencies and advisory write scopes.
- **Mailbox** (`agent-team/src/mailbox.ts`): a message is journaled in the lead's session log before delivery, then steered into the target (a running agent gets it at its next step; an idle one starts a turn or cold-resumes). It's marked delivered once the target has stored it.
- **Results** come back by convention, through `send_message` to `lead`.
- **The lead stays responsive.** `spawn_teammate` returns once the prompt is accepted, and the policy tells the lead to call `wait_agent`, which returns `noProgress` at once if no peer is running. dsh-subagent's settlement notices still reach the lead, but they name children by session ID, while the team tools use names.

## Team policy prompt section

- Registered as `team:policy` at order 600 (`TEAM_POLICY`) on each member's own agent scope. It doesn't touch the persona sections at orders 0 and 10200.
- The lead and every teammate get the same text. Lead-only rules are enforced when a tool runs.
- It says, in substance:
  - create teammates only when the user explicitly asks;
  - the working directory is shared, so use disjoint write scopes and task dependencies;
  - on `FS_STALE_VERSION`, re-read and retry (bash, formatters and codegen aren't protected);
  - the claim → complete task workflow;
  - the lead waits for required teammates before answering.

## Persistence

- No separate store. Four log-only event types (`team/member`, `team/task`, `team/message/queued`, `team/message/delivered`) are appended to the lead's session log.
- State is rebuilt by replaying them through an `agentTeam` session projection, with an invariant check before each append.
- On `agent/created` it recovers half-provisioned members and re-sends undelivered mail.
- Requires durable session persistence.

## What it doesn't have

- **Pipeline pieces:** cross-model review, gates before "done", escalation, budgets beyond the five limits.
- **Per-member approvals:** delegated children run with `approvalPolicy: 'never'`, which is the same for our children.
- **Isolation and nesting:** no worktree isolation, no nesting, one process.
- **Review is same-model only.** `auto-review` is a separate experimental package.
- **The only overlap with our pipeline is the task board,** and the model drives it, not a script.

## Maturity

- Experimental, with no stability promise.
- **Known limits:**
  - One-shot workflow children can be mistaken for leads and get team tools.
  - The web presets mount the subagent controls in their own preset scope, which the profile's disables don't reach (`packages/bundle/web-app/presets/standard.patch.yml`).
  - Write scopes are advisory only.
  - Every roster change broadcasts the whole view to every browser.
- **Well tested:** about 1,800 lines of team specs, persistence and projection specs, a headless CLI e2e (`apps/cli/tests/agent-team-headless.e2e.ts`) and a web e2e.

## Why it doesn't fit `crew`

| Our need | Agent-team today |
|---|---|
| Each role has its own prompt | No per-member persona; members inherit the lead's preset, so every crew member would get the main agent's persona |
| Mid-tier models for the crew, and a reviewer on a different family from the coder | The model always comes from the lead |
| Tools restricted per role | Every member gets the same tools |
| Main agent delegates about 90% of work | Its policy says to create teammates only when the user explicitly asks |
| A fresh coder per task across a long plan | `maxMembers` (8) counts every member ever created, so a 20-task plan runs out |
| The main agent can message the children it starts | Its agent-scoped `send_message`, `list_agents` and `interrupt_agent` have the same names as dsh-subagent's controls and replace them; children `crew` starts aren't team members, so the lead gets `TEAM_MEMBER_NOT_FOUND` |
| A clone per repo and a worktree per task | One shared working directory |

**Mounting both:** agent-team and `crew` can't share a profile, because of the tool-name shadowing in the table.

## Worth copying

1. **Pipeline state in the session log.** Append our own events to the main agent's session log, replay them through a session projection, and check an invariant before each append. That gives resume and a web panel almost for free, and is the right home for `orchestrator`'s task ledger. Their journal, projection and invariant files are the template.
2. **Install tools and policy only on the right agents.** Their `maybeInstall` on `agent/created` registers a scoped `systemPrompt.section` and the tools. We'd key it on the dish preset instead of team membership. Use our own section name and a free order near 600, not `TEAM_POLICY`.
3. **Role names, not session IDs.** Show role names in delegation results, and map the session ID in dsh-subagent's settlement notices back to the role.
4. **Compact results:** declared result schemas rendered as compact JSON (`jsonOutput`).
5. **A wait tool that returns at once.** If we ever add one, copy `wait_agent`'s immediate `noProgress` answer when nothing is running. Otherwise settlement wake-ups are enough.
6. **Disabling dsh's own tools.** If `crew` replaces `subagent` and `subagent_fork`, copy the profile's four disabled rows, and also patch the rows the web presets mount in their own scope.
7. **A crew panel:** a session-header roster with click-through to each child session (`client-ui-agent-team/src/client/mount.ts`).

## A possible upstream contribution

Giving members their own persona, model and tool filter would take about five lines in `roster.ts`, where it calls `startContinuable`. dsh-subagent already accepts all three and stores them for cold resume, so they'd survive a restart. That would make agent-team usable for role-based crews like ours, and could be a first PR to deepseek-ai.
