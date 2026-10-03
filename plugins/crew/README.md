# dish-crew

A fixed crew of specialists the main agent hands work to, with the conversation staying open while they run.
- **One tool, `delegate`.** It starts a child in a role, or sends a fix round to a child it already started. Each child gets its role's prompt from `dish-prompts`, its role's tools, and a model from its role's tier.
- **Reviewers run on another family.** The reviewer runs on a different model family, and vendor, from the work it reviews, and the harness enforces this. A model `crew.yaml` doesn't list whose id names no known vendor counts as its own family, so an alias that hides its vendor can get a reviewer of the same vendor; list it in a family to close that.
- **`crew.yaml`** in the config store holds the roles, tiers, models and limits.
- **Crew keeps its own record.** It saves every child's final report, and finish notices name the child's role and model.
- **Children report once, in their closing message.** A new child is told so after its task. A child's `send_message` longer than `messageLimit` characters (1200 by default) is refused, and `send_message` stays closed to it until it finishes, so the main agent gets one delivery and not two.
- **Its blocks are kept apart.** dsh's adapters join a message's text blocks with nothing between them, so crew ends each block it writes into a message (a child's task, its worktree block, a ruling's block, the closing note, and the first block of a finish notice when dsh's blocks follow it) with a blank line. The blocks themselves are as described here.
- **This bundle ships the dish preset:** the main agent's preset, with `delegate`, and with dsh's own delegation tools turned off.

The design and its reasoning are in the [spec](../../docs/specs/crew.md). Why this builds on dsh's subagents directly rather than its experimental agent teams is in the [research note](../../docs/research/2026-10-01-dsh-agent-team.md).

## Install

```sh
pnpm dsh plugin --profile web add ./plugins/crew
```

It needs `dish-config` and `dish-prompts` in the same profile. On its first start with the store, it seeds `crew.yaml`.

**Choose the preset:** on **Settings → Agent presets**, use **Set as new task default** on **dish**. The mode picker on a new chat switches per chat.

## Using it

Talk to the main agent as usual. It delegates by itself, as its prompt (`prompts/main.md`) tells it to:

> delegate a researcher to find …
> delegate a coder to …, then have a reviewer check it

- **The main agent ends its turn after delegating.** You can keep talking. When a child finishes, its notice wakes the main agent.
- **The session header's subagent list** shows each child as `role · model · title`, with its status. Click a child to open its session.
- **Fix rounds:** `delegate` again with `to` set to the same child. It continues with its history.
- **Reviews:** the `reviewer` role with `reviews` set to the child whose work it checks, or `main` for the main agent's own work.

### Binding a coder to a worktree

In a chat whose workspace is a project's clone ([`dish-workspaces`](../workspaces/)), the main agent makes a worktree with the `worktree` tool and passes it to `delegate` as `worktree`: `<project>/<slug>`, or the path the tool returned.
- **Crew checks it before anything starts:** the role writes (a reviewer is given the path in its task instead), `dish-workspaces` is running and knows the worktree, the worktree is inside the chat's workspace (a child works in its parent's sandbox, and couldn't write anywhere else), and no running crew child, of any chat, is bound to it.
- **The child is bound:** its record keeps the worktree's path (`worktree` in `children.json`), and its brief gets a block after the task naming the worktree and its branch, and telling it to work only there. While [`dish-gates`](../gates/) runs, the block goes on to name the project's gate and the opt-out ([Gates](#gates)).
- **Follow-ups keep the binding** and add nothing to the text. One that names another worktree is refused, and so is one to a child whose worktree has been merged or removed: start a new coder.
- **A worktree dish made that fails a check is refused with the reason.** When `resolve` gives nothing, crew asks `dishWorkspaces.resolveProblem(ref)` why: the project's clone, or the worktree itself, failed dish's safety check (with the finding), or its branch is gone. A start says "worktree `<ref>` can't be bound: <reason>. Nothing was started or sent; tell the user."; a follow-up to a bound child says its worktree "can't be used: <reason>" instead of calling it gone. Without a reason (a worktree dish doesn't know), the refusals are as above.
- **`dishCrew.worktreeBindings(path)`** lists the children bound to a worktree, with whether each is running, for `dish-workspaces`' `list`, `remove` and sweep.

### Gates

While [`dish-gates`](../gates/) runs, a bound coder's work is gated each time it is about to finish: dish runs the project's gate in its worktree, and a failure goes back to the coder, up to 3 gate runs a turn. Crew's part:
- **The brief.** A bound coder's block ends with: "When you finish, dish runs this project's gate (`<gate>`) in your worktree, and a failure comes back to you. If you're blocked, start your closing message with `BLOCKED: <question>` or `NEEDS CONTEXT: <what you need>`, and the gate is skipped." The gate comes from `dishGates.gateFor(project)`. Without dish-gates, or a gate, the block is as above.
- **The record.** Each gate result is a `GateResult` (the turn, the round of `maxRounds`, `passed`, `failed`, `skipped` or `error`, the command, the exit code, whether it timed out, how long it took, the log, the output's last lines, and why for a skip or an error). dish-gates adds it with `records.addGate(child, result)`. A run in progress keeps its results on the child (`gates`), and they move onto the run when it ends (`runs[].gates`).
- **The finish notice** of a bound coder says how its gate ended, after the report, from the run's last result:
  - "Gate passed (round 2)." In a run that ended another way than `completed` (aborted, failed) after its gate passed: "Gate passed earlier in this run (round 2), but the run ended (aborted) after it, so any work after the gate wasn't gated."
  - "Gate FAILED after 3 rounds (`<gate>`, exit 1); last lines:", the output's last lines in a code fence, then "Full log: `<path>`. Start a fix round with `to` or a fresh coder (escalation ladder)." A gate that hit its time limit says "stopped at its time limit" in place of the exit code.
  - "Gate failed in round 1 of 3 (`<gate>`, exit 1), and the run ended before the coder finished again. Full log: `<path>`." The run ended some other way, such as an error.
  - "Gate skipped: the coder reported BLOCKED / NEEDS CONTEXT." or another skip's reason, such as "its worktree is gone, or its project is no longer registered".
  - "Gate not run: <reason>." for an error, such as a clone that failed dish's safety check.
  - "Gate not run." for a run with no result. That line is left out while dish-gates isn't running: no gate was going to run.
- **The review check.** A review of a bound coder's work, a reviewer started with `reviews: <child>` or a follow-up to a reviewer (a re-review), is refused while that coder's gate hasn't passed:
  - it is still running: wait for its finish notice;
  - its latest run's last result isn't a pass;
  - or that run has none (an error or an abort ended it before its turn could, dsh restarted mid-gate, or it ran before dish-gates was on: "the coder ran before gates were on");
  - or it is a pass, but the run didn't end `completed` after it: a follow-up steered into the same turn had the coder go on, and the turn was then aborted or failed, or dsh restarted. The work after the pass was never gated.

  The refusal says where the gate stands and what to do: "coder «add login» (child <id>)'s gate hasn't passed (skipped: the coder reported BLOCKED / NEEDS CONTEXT). Send it a fix round with `to: "<id>"`, or start the review anyway with `gateOverride: "Ruling: what — why — cost if wrong"`."
- **`gateOverride`,** a `delegate` parameter, is the main agent's ruling to review work whose gate hasn't passed, on one line (line breaks are folded). It is recorded on the reviewer (`gateOverride` in `children.json`), and the reviewer gets a block after its task: "The harness's gate for the work you review (<role> «<title>», child <id>) hasn't passed: <where it stands>. The main agent started this review anyway, with this ruling: <ruling>", without the ruling's leading `Ruling:`. A follow-up with a ruling replaces the recorded one, and its text gets the same block.
  - An empty `gateOverride` is none. `Ruling:` alone, or the placeholder `Ruling: what — why — cost if wrong` copied back, is refused: "gateOverride needs the ruling itself: what — why — cost if wrong".
  - A re-review without one keeps the reviewer's ruling while the reviewed coder hasn't run since the ruling was given: the ruling was given on the standing it still has. Its time is `gateOverrideAt` in `children.json`: the reviewer's start, or the follow-up that gave it. A ruling recorded before that field existed counts from the reviewer's start.
  - When nothing is refused (the gate passed, the coder isn't bound, `reviews: "main"`, or dish-gates isn't running), `gateOverride` is ignored and not recorded.

## crew.yaml

Edit it by asking the main agent, which writes it with `config_write`, and review the change on Settings → History. The shipped file:

```yaml
provider: github-copilot
families:
  anthropic: { strong: claude-opus-5.5, mid: claude-sonnet-5.5 }
  openai:    { strong: gpt-6.1-sol,     mid: gpt-5.6-sol }
reviewerFamilies: [openai, anthropic]
limits: { running: 4, writers: 1, perSession: 30 }
roles:
  architect:  { tier: strong, family: anthropic, writes: true,  tools: [...] }
  coder:      { tier: mid,    family: anthropic, writes: true,  tools: [...] }
  reviewer:   { tier: mid,    reviews: true,                    tools: [...] }
  researcher: { tier: mid,    family: anthropic,                tools: [...] }
  ops:        { tier: mid,    family: anthropic, writes: true,  tools: [...] }
  writer:     { tier: mid,    family: anthropic, writes: true,  tools: [...] }
```

For direct API keys, with Claude through an `anthropic` provider and GPT through an `openai` one, give each family its provider and keep the rest of the file (`limits` and `roles` as above). Use the model ids the provider's API names:

```yaml
provider: anthropic       # required: the provider of any family that doesn't have its own
families:
  anthropic: { provider: anthropic, strong: claude-opus-5.5, mid: claude-sonnet-5.5 }
  openai:    { provider: openai,    strong: gpt-6.1-sol,     mid: gpt-5.6-sol }
reviewerFamilies: [openai, anthropic]
```

- **A broken file can't be saved.** It is checked when written: unknown keys, model ids padded with spaces, a model listed in two families, a role with no tools, and more are refused, each with the path at fault.
- **Families and tiers.** Each role uses its family's model at its tier. The main agent may pass `model` to pick another model listed in `families`.
- **A provider per family.** `provider` at the top is where every family runs, and it is required. A family may add its own `provider` next to its tiers, for direct API keys, where Claude and GPT come through different providers (the example above). A model override runs on the provider of the family its model is in. When a refusal lists the models, a family with its own provider shows them as `provider/model`, and either form is accepted back as `model`. A model id that equals another model's `provider/model` name is refused when the file is saved.
- **The reviewer** has no `family`. It takes the first `reviewerFamilies` entry that isn't the reviewed work's family, and that lists no model of the same vendor. That is told by model ids, never by provider names, and it runs on the provider of the family it lands in.
- **Limits.**
  - At most `running` children run at once, and at most `writers` of the roles marked `writes: true`. Children share the chat's workspace, so one writer at a time; a coder bound to its own worktree is kept to it by its brief, not by the sandbox.
  - A session can start `perSession` children in all. Follow-ups don't count toward it.
- **Tools.**
  - A role's `tools` are an allow list. Tools the main agent can't pass on are dropped when the child starts; those are the ones on its own scope, not the preset's.
  - Every shipped role lists `ask_judge`, which comes from [`dish-judge`](../judge/). Without that plugin there is no such tool, and the name is dropped like any other missing one: children start with the rest of their tools.
  - Whatever the file says, a child never gets `delegate`, dsh's delegation and workflow tools, the goal or plan tools, `ask_user_question`, `present` or `worktree`.

A role also needs a prompt: `prompts/crew/<role>.md`, or a shipped default.

## What crew records

In `$XDG_DATA_HOME/dish/crew/`:
- `sessions/<hash of the session>/children.json` holds each child's role, model, family, what it reviews, the worktree it is bound to, its follow-ups and its runs, and, with [`dish-gates`](../gates/), each run's gate results and a reviewer's `gateOverride` with its `gateOverrideAt` ([Gates](#gates)).
- `<n>-<role>-<run>.md` in the same folder holds each run's closing message, the child's report.
- `by-child/` holds pointers, so a child resumed after a restart is filed under the right session.

Records not touched for 180 days are pruned at startup. A finish notice gives its run's report path. Copy reports worth keeping into a repo's docs.

## The dish preset

`presets/dish.patch.yml` is **generated** from the `standard` preset of the dsh you have installed. It differs in three ways:
- the stock persona row is replaced by `dish-prompts/persona`;
- the `dish-crew/delegate` row is added;
- dsh's own delegation rows (`subagent`, `subagent_fork` and the workflow engine) are disabled.

Any row from dsh's delegation packages left enabled fails the generator. The `subagent` row would otherwise install its tool into every agent on the preset, children included, where no filter reaches.

After a dsh upgrade, a test fails if `standard` changed. Run:

```sh
pnpm --filter dish-crew sync-preset
```

## Configuration

| Row | Field | Default | |
|---|---|---|---|
| `dish-crew` | `dataDirectory` | `$XDG_DATA_HOME/dish/crew` | Where records and reports go. Absolute, or starting with `~/`. |
| `dish-crew` | `subagentProvider` | `spawn` | The `ctx.subagents` provider for children. |
| `dish-crew` | `messageLimit` | `1200` | The most characters a crew child's `send_message` may have. A longer one is refused as a report, and `send_message` is closed to that child until it finishes. `0` turns the guard off. |
| `dish-crew` | `terminal` | `true` | Print this plugin's messages, and the preset row's, to the terminal. |

## Caveats

- **A start that fails still counts** toward `perSession`, a cancelled one included.
- **`send_message` isn't checked against the limits.** It can still wake a finished child, and the woken child counts as running from then on. Fix rounds should go through `delegate` with `to`.
- **The report guard reads length, then holds.** A crew child's first `send_message` over `messageLimit` characters is refused, whatever it says, and from then on every `send_message` of that child is refused until its run ends: it can't tell a report in pieces from a question, so a question a child is blocked on goes in its closing message, and you or the main agent follow up with `delegate` and `to`. A follow-up run starts with `send_message` open. Messages from the main agent and from other plugins' children, and any message sent while crew's record can't be read, are never refused. dsh adds a note to a child's task that tells it to send its result with `send_message` before it finishes; crew puts a note of its own in front of it saying not to, and the guard keeps a child that does anyway from sending a long one.
- **Children share the main agent's working directory.** dsh 0.2.0-rc.2 has no per-child `cwd`. A bound coder starts in the chat's workspace too, and may write anywhere in it: its brief, not the sandbox, keeps it to its worktree.
- **Children can't ask you anything.** dsh runs them with approval policy `never`.
- **A crew child's approval requests are refused when `dish-judge` isn't loaded.** With `dish-judge`, a child is switched to approval policy `ask` and the judge answers it. If the judge is then disabled, uninstalled or unloaded, a child that had settled still has `ask` in its log, and a follow-up would resume it at `ask`. Without a guard, dsh would show its prompt in the child's own session, where nobody sees it, and nothing times it out. So crew refuses a crew child's request whenever `dish-judge` is absent. Other children, and the main agent, are untouched.
- **Without `dish-prompts`,** the persona row logs once and `delegate` refuses every call, naming the missing plugin. Nothing refuses at load.
- **Claude Sonnet 5.5 comes from `dish-copilot`'s catalog,** which copies settings from the nearest catalog model of the same generation. An older copy rejected every request from crew children (Task 9's live check found it).
